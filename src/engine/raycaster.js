// raycaster.js - the NUKEHAUS software renderer.
//
// A grid raycaster in the Wolfenstein 3D lineage, extended with the things this
// game actually needs:
//   * pitch (a y-shear, which is an exact projection for an off-centre principal
//     point, so sprites, walls, floors and sky all stay consistent),
//   * half-height parapet walls with real sky above them, so a silo deck can see
//     the horizon without needing a full portal renderer,
//   * bilinear coloured dynamic lighting sampled from a per-cell-corner grid,
//   * proper sliding doors on the cell mid-plane, with jamb sides,
//   * z-buffered billboard sprites carrying a real world height.
//
// The output is a Uint32Array in canvas byte order which post.js takes to the GPU.

import { TEX } from '../core/pixels.js';
import { clamp } from '../core/math.js';

export const WALL_WORLD_HEIGHT = 1.0;
export const PARAPET_HEIGHT = 0.44;

export class Raycaster {
  constructor() {
    this.w = 0; this.h = 0;
    this.buf = null;          // Uint32Array framebuffer
    this.zbuf = null;         // Float32Array per-column wall distance
    this.wallTop = null;      // Int32Array per-column first floor-facing row
    this.wallBot = null;
    this.skyTop = null;       // per-column: rows above this are sky (parapet cutoff)
    this.colAng = null;       // per-column azimuth, for sky lookup
    this.colInvM = null;      // per-column 1/|rayDirXY|
    this.rayDirX = null; this.rayDirY = null;
    this.atanLut = null;
    this.projY = 0;
    this.fov = 72 * Math.PI / 180;
    // Aiming, ranging and fuse maths all divide by projY, so it must be sane
    // before the first frame is drawn rather than after it.
    this.resize(640, 400);
  }

  resize(w, h) {
    if (this.w === w && this.h === h) return;
    this.w = w; this.h = h;
    this.buf = new Uint32Array(w * h);
    this.zbuf = new Float32Array(w);
    this.wallTop = new Int32Array(w);
    this.wallBot = new Int32Array(w);
    this.skyTop = new Int32Array(w);
    this.needSky = new Uint8Array(w);
    this.colAng = new Float32Array(w);
    this.colInvM = new Float32Array(w);
    this.rayDirX = new Float32Array(w);
    this.rayDirY = new Float32Array(w);
    // Vertical field of view is tied to the horizontal one so the image stays
    // square-pixel correct at any aspect ratio.
    this.projY = (w * 0.5) / Math.tan(this.fov * 0.5);
    this._buildAtanLut();
  }

  _buildAtanLut() {
    // Maps a screen-space slope to an elevation angle. Sky sampling does one
    // multiply and one lookup per pixel instead of an atan.
    const N = 16384;
    this.atanLutN = N;
    this.atanLutRange = 6.0;
    this.atanLut = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const t = (i / (N - 1)) * 2 - 1;           // -1..1
      this.atanLut[i] = Math.atan(t * this.atanLutRange);
    }
  }

  _atan(slope) {
    let t = slope / this.atanLutRange;
    if (t < -1) t = -1; else if (t > 1) t = 1;
    const f = (t + 1) * 0.5 * (this.atanLutN - 1);
    const i = f | 0;
    const k = f - i;
    const a = this.atanLut[i];
    return i + 1 < this.atanLutN ? a + (this.atanLut[i + 1] - a) * k : a;
  }

  /**
   * @param {object} lv     parsed level (see game/level.js)
   * @param {object} cam    { x, y, z, ang, pitch }  pitch is in pixels of shear
   * @param {object} art    { texAtlas, texEmissive, sky }
   * @param {object} light  LightGrid
   * @param {Array}  sprites  billboards, unsorted
   * @param {object} opts   { fogFar, fogColor, ambient, time }
   */
  render(lv, cam, art, light, sprites, opts) {
    const { w, h, buf } = this;
    const horizon = (h * 0.5 + cam.pitch) | 0;
    const dirX = Math.cos(cam.ang), dirY = Math.sin(cam.ang);
    const planeLen = Math.tan(this.fov * 0.5);
    const planeX = -dirY * planeLen, planeY = dirX * planeLen;

    for (let c = 0; c < w; c++) {
      const camX = (2 * c) / w - 1;
      const rx = dirX + planeX * camX, ry = dirY + planeY * camX;
      this.rayDirX[c] = rx; this.rayDirY[c] = ry;
      const m = Math.hypot(rx, ry);
      this.colInvM[c] = 1 / (this.projY * m);
      this.colAng[c] = Math.atan2(ry, rx);
    }

    // Zero means "nothing has claimed this pixel". Every real write sets alpha
    // 255, so the sky pass can fill the gaps without tracking spans itself.
    buf.fill(0);

    this._castWalls(lv, cam, art, light, opts, horizon, dirX, dirY, planeX, planeY);
    this._castPlanes(lv, cam, art, light, opts, horizon);
    this._drawSky(art, cam, opts, horizon);
    this._drawSprites(lv, cam, art, light, sprites, opts, horizon, dirX, dirY, planeX, planeY);
    return buf;
  }

  // ---------------------------------------------------------------- walls

  _castWalls(lv, cam, art, light, opts, horizon, dirX, dirY, planeX, planeY) {
    const { w, h, buf, zbuf, wallTop, wallBot, skyTop } = this;
    const { wall, wallTex, doorOpen, doorVert, height, W, H } = lv;
    const atlas = art.texAtlas, emis = art.texEmissive;
    const projY = this.projY;
    const eye = cam.z;
    const fogFar = opts.fogFar, fogColor = opts.fogColor;
    const fr = fogColor & 255, fg = (fogColor >>> 8) & 255, fb = (fogColor >>> 16) & 255;

    this.needSky.fill(0);
    for (let c = 0; c < w; c++) {
      const rdx = this.rayDirX[c], rdy = this.rayDirY[c];
      let mapX = cam.x | 0, mapY = cam.y | 0;
      const ddx = rdx === 0 ? 1e30 : Math.abs(1 / rdx);
      const ddy = rdy === 0 ? 1e30 : Math.abs(1 / rdy);
      let stepX, stepY, sdx, sdy;
      if (rdx < 0) { stepX = -1; sdx = (cam.x - mapX) * ddx; }
      else { stepX = 1; sdx = (mapX + 1 - cam.x) * ddx; }
      if (rdy < 0) { stepY = -1; sdy = (cam.y - mapY) * ddy; }
      else { stepY = 1; sdy = (mapY + 1 - cam.y) * ddy; }

      let side = 0, dist = 0, tex = 0, u = 0, hit = false, wallH = 1.0;
      let guard = 0;

      while (guard++ < 220) {
        if (sdx < sdy) { sdx += ddx; mapX += stepX; side = 0; }
        else { sdy += ddy; mapY += stepY; side = 1; }
        if (mapX < 0 || mapY < 0 || mapX >= W || mapY >= H) break;
        const idx = mapY * W + mapX;
        const cell = wall[idx];
        if (!cell) continue;

        if (doorVert[idx] !== 0) {
          // A door slab standing on the cell's mid-plane, sliding sideways.
          const open = doorOpen[idx];
          if (doorVert[idx] === 1) {           // plane at x = mapX + 0.5
            const t = (mapX + 0.5 - cam.x) / rdx;
            if (t <= 0) continue;
            const hy = cam.y + t * rdy;
            if ((hy | 0) !== mapY) continue;
            let uu = hy - mapY;
            if (uu < open) continue;           // slid open here, ray passes
            dist = t; u = uu; side = 0; tex = wallTex[idx]; hit = true; wallH = 1; break;
          } else {                              // plane at y = mapY + 0.5
            const t = (mapY + 0.5 - cam.y) / rdy;
            if (t <= 0) continue;
            const hx = cam.x + t * rdx;
            if ((hx | 0) !== mapX) continue;
            let uu = hx - mapX;
            if (uu < open) continue;
            dist = t; u = uu; side = 1; tex = wallTex[idx]; hit = true; wallH = 1; break;
          }
        }

        dist = side === 0 ? sdx - ddx : sdy - ddy;
        if (dist < 1e-4) dist = 1e-4;
        u = side === 0 ? cam.y + dist * rdy : cam.x + dist * rdx;
        u -= Math.floor(u);
        if ((side === 0 && rdx > 0) || (side === 1 && rdy < 0)) u = 1 - u;
        tex = wallTex[idx];
        wallH = height[idx];
        hit = true;
        break;
      }

      if (!hit) {
        zbuf[c] = 1e9; wallTop[c] = h; wallBot[c] = -1; skyTop[c] = h;
        this.needSky[c] = 1;
        continue;
      }
      zbuf[c] = dist;

      // Screen span. The wall's foot sits on the floor plane and its head at
      // wallH, so a parapet leaves honest sky above it.
      const invD = 1 / dist;
      const yFoot = horizon + (eye * projY) * invD;
      const yHead = horizon - ((wallH - eye) * projY) * invD;
      let y0 = Math.ceil(yHead), y1 = Math.floor(yFoot);
      const spanH = yFoot - yHead;
      const drawStart = y0 < 0 ? 0 : y0;
      const drawEnd = y1 > h - 1 ? h - 1 : y1;
      wallTop[c] = drawStart;
      wallBot[c] = drawEnd;
      // Above a parapet you can see the horizon, so distant sprites and sky are
      // allowed there. A full-height wall admits neither.
      skyTop[c] = wallH < 0.999 ? drawStart : 0;
      if (wallH < 0.999) this.needSky[c] = 1;

      if (drawEnd < drawStart) continue;

      // Lighting at the impacted surface.
      const hx = cam.x + dist * rdx, hy = cam.y + dist * rdy;
      const em = emis[tex];
      let lr, lg, lb;
      if (em >= 0.999) { lr = lg = lb = 1.35; }
      else {
        const s = light.sample(hx, hy);
        lr = s[0]; lg = s[1]; lb = s[2];
        if (em > 0) { lr += em; lg += em; lb += em; }
        if (side === 1) { lr *= 0.74; lg *= 0.74; lb *= 0.78; }
      }
      // Distance haze: colour toward the fog rather than to black, which is what
      // stops a raycaster looking like a cave of tar.
      let fog = dist / fogFar;
      if (fog > 1) fog = 1;
      fog *= fog * (1 - em * 0.85);
      const keep = 1 - fog;

      const texBase = tex * TEX * TEX;
      let tx = (u * TEX) | 0;
      if (tx < 0) tx = 0; else if (tx >= TEX) tx = TEX - 1;
      const stepV = TEX / spanH;
      let vpos = (drawStart - yHead) * stepV;

      for (let y = drawStart; y <= drawEnd; y++) {
        let ty = vpos | 0;
        if (ty < 0) ty = 0; else if (ty >= TEX) ty = TEX - 1;
        vpos += stepV;
        const t = atlas[texBase + ty * TEX + tx];
        const r = (t & 255) * lr, g = ((t >>> 8) & 255) * lg, b = ((t >>> 16) & 255) * lb;
        buf[y * this.w + c] =
          (255 << 24 |
           (((b * keep + fb * fog) | 0) > 255 ? 255 << 16 : ((b * keep + fb * fog) | 0) << 16) |
           (((g * keep + fg * fog) | 0) > 255 ? 255 << 8 : ((g * keep + fg * fog) | 0) << 8) |
           (((r * keep + fr * fog) | 0) > 255 ? 255 : ((r * keep + fr * fog) | 0))) >>> 0;
      }
    }
  }

  // ------------------------------------------------------- floors & ceilings

  _castPlanes(lv, cam, art, light, opts, horizon) {
    const { w, h, buf, wallTop, wallBot } = this;
    const { floorTex, ceilTex, sky, decal, W, H } = lv;
    const atlas = art.texAtlas, emis = art.texEmissive;
    const decalAtlas = art.decalAtlas;
    const projY = this.projY;
    const eye = cam.z;
    const ceilH = 1.0;
    const fogFar = opts.fogFar, fogColor = opts.fogColor;
    const fr = fogColor & 255, fg = (fogColor >>> 8) & 255, fb = (fogColor >>> 16) & 255;

    const rdx0 = this.rayDirX[0], rdy0 = this.rayDirY[0];
    const rdx1 = this.rayDirX[w - 1], rdy1 = this.rayDirY[w - 1];
    const invW = 1 / w;
    // Lighting changes smoothly across a floor row, so sample it every LSTEP
    // pixels and ramp between. This is the difference between a comfortable
    // frame and a slideshow at high resolution.
    const LSTEP = 8, INV_LSTEP = 1 / 8;

    const skyTop = this.skyTop;
    for (let y = 0; y < h; y++) {
      const p = y - horizon;
      const isFloor = p > 0;
      if (p === 0) continue;

      const rowD = isFloor ? (eye * projY) / p : ((ceilH - eye) * projY) / -p;
      if (!(rowD > 0) || rowD > 900) continue;

      const stepX = (rdx1 - rdx0) * rowD * invW;
      const stepY = (rdy1 - rdy0) * rowD * invW;
      let fx = cam.x + rdx0 * rowD;
      let fy = cam.y + rdy0 * rowD;

      let fog = rowD / fogFar;
      if (fog > 1) fog = 1;
      fog *= fog;
      const keep = 1 - fog;
      const fogR = fr * fog, fogG = fg * fog, fogB = fb * fog;
      const rowOff = y * w;
      const shade = isFloor ? 0.94 : 0.9;

      let lr = 0, lg = 0, lb = 0, dr = 0, dg = 0, db = 0, next = 0;

      for (let c = 0; c < w; c++) {
        if (c >= next) {
          const s0 = light.sample(fx, fy);
          const a0 = s0[0], a1 = s0[1], a2 = s0[2];
          const s1 = light.sample(fx + stepX * LSTEP, fy + stepY * LSTEP);
          lr = a0; lg = a1; lb = a2;
          dr = (s1[0] - a0) * INV_LSTEP;
          dg = (s1[1] - a1) * INV_LSTEP;
          db = (s1[2] - a2) * INV_LSTEP;
          next = c + LSTEP;
        } else { lr += dr; lg += dg; lb += db; }

        if (y >= wallTop[c] && y <= wallBot[c]) { fx += stepX; fy += stepY; continue; }
        // Above a parapet (or where the ray left the map) there is no ceiling —
        // there is the horizon. Without this you stand on an open silo deck and
        // see the roof of the corridor two rooms away instead of the sky.
        if (!isFloor && skyTop[c] > 0 && y < skyTop[c]) { fx += stepX; fy += stepY; continue; }
        const cx = fx | 0, cy = fy | 0;
        if (cx < 0 || cy < 0 || cx >= W || cy >= H) { fx += stepX; fy += stepY; continue; }
        const ci = cy * W + cx;
        if (!isFloor && sky[ci]) { this.needSky[c] = 1; fx += stepX; fy += stepY; continue; }
        const tex = isFloor ? floorTex[ci] : ceilTex[ci];
        if (tex < 0) { fx += stepX; fy += stepY; continue; }

        let tx = ((fx - cx) * TEX) | 0, ty = ((fy - cy) * TEX) | 0;
        if (tx < 0) tx = 0; else if (tx >= TEX) tx = TEX - 1;
        if (ty < 0) ty = 0; else if (ty >= TEX) ty = TEX - 1;
        let t = atlas[tex * TEX * TEX + ty * TEX + tx];

        // Blood, gore and scorch marks live in the floor, not on billboards, so
        // they lie flat and take the same perspective as the ground they are on.
        if (isFloor && decalAtlas && decal[ci] >= 0) {
          const dpx = decalAtlas[decal[ci] * TEX * TEX + ty * TEX + tx];
          const da = dpx >>> 24;
          if (da) {
            const k = da / 255;
            const rr = (t & 255) + (((dpx & 255) - (t & 255)) * k);
            const gg = ((t >>> 8) & 255) + ((((dpx >>> 8) & 255) - ((t >>> 8) & 255)) * k);
            const bb = ((t >>> 16) & 255) + ((((dpx >>> 16) & 255) - ((t >>> 16) & 255)) * k);
            t = (255 << 24 | (bb | 0) << 16 | (gg | 0) << 8 | (rr | 0)) >>> 0;
          }
        }

        const em = emis[tex];
        let mr, mg, mb;
        if (em >= 0.999) { mr = mg = mb = 1.3; }
        else { mr = lr * shade + em; mg = lg * shade + em; mb = lb * shade + em; }
        let r = (t & 255) * mr * keep + fogR;
        let g = ((t >>> 8) & 255) * mg * keep + fogG;
        let b = ((t >>> 16) & 255) * mb * keep + fogB;
        buf[rowOff + c] = (255 << 24 |
          (b > 255 ? 255 : b) << 16 | (g > 255 ? 255 : g) << 8 | (r > 255 ? 255 : r)) >>> 0;
        fx += stepX; fy += stepY;
      }
    }
  }

  // ------------------------------------------------------------------ sky

  _drawSky(art, cam, opts, horizon) {
    const sky = art.sky;
    const { w, h, buf } = this;
    if (!sky) {
      for (let i = 0; i < buf.length; i++) if (!buf[i]) buf[i] = 0xff100c14;
      return;
    }
    // Anything still unclaimed in a sealed column is a seam, not sky.
    for (let c = 0; c < w; c++) {
      if (this.needSky[c]) continue;
      for (let y = 0; y < h; y++) { const o = y * w + c; if (!buf[o]) buf[o] = 0xff0c0a10; }
    }
    const SW = sky.w, SH = sky.h;
    const eMin = sky.elevMin, eSpan = sky.elevMax - sky.elevMin;
    // One flattened lookup table; see Sky.composite().
    const tex = sky.composite(((opts.time * 2.2) | 0) % SW, ((opts.time * 5.1) | 0) % SW);
    const vScale = (SH - 1) / eSpan;
    const vBias = -eMin * vScale;

    for (let c = 0; c < w; c++) {
      if (!this.needSky[c]) continue;             // sealed corridor column
      let un = this.colAng[c] / (Math.PI * 2);
      un -= Math.floor(un);
      const su = (un * SW) | 0;
      const k = this.colInvM[c];
      for (let y = 0; y < h; y++) {
        const o = y * w + c;
        if (buf[o]) continue;                     // walls and floors already own it
        const elev = this._atan((horizon - y) * k);
        let fv = elev * vScale + vBias;
        if (fv < 0) fv = 0; else if (fv > SH - 1.001) fv = SH - 1.001;
        const sv = fv | 0;
        const t = fv - sv;
        // Blend adjacent dome rows: one dome row can cover several screen rows
        // when you look up, and the seams read as rings without this.
        const a = tex[sv * SW + su], b = tex[(sv + 1) * SW + su];
        const r = (a & 255) + (((b & 255) - (a & 255)) * t);
        const g = ((a >>> 8) & 255) + ((((b >>> 8) & 255) - ((a >>> 8) & 255)) * t);
        const bl = ((a >>> 16) & 255) + ((((b >>> 16) & 255) - ((a >>> 16) & 255)) * t);
        buf[o] = (255 << 24 | (bl | 0) << 16 | (g | 0) << 8 | (r | 0)) >>> 0;
      }
    }
  }

  // -------------------------------------------------------------- sprites

  _drawSprites(lv, cam, art, light, sprites, opts, horizon, dirX, dirY, planeX, planeY) {
    const { w, h, buf, zbuf } = this;
    const projY = this.projY;
    const eye = cam.z;
    const invDet = 1.0 / (planeX * dirY - dirX * planeY);
    const fogFar = opts.fogFar, fogColor = opts.fogColor;
    const fr = fogColor & 255, fg = (fogColor >>> 8) & 255, fb = (fogColor >>> 16) & 255;

    // Project first, discard behind-camera, then sort far-to-near.
    const vis = [];
    for (let i = 0; i < sprites.length; i++) {
      const s = sprites[i];
      const dx = s.x - cam.x, dy = s.y - cam.y;
      const ty = invDet * (-planeY * dx + planeX * dy);   // depth along view axis
      if (ty <= 0.06) continue;
      const tx = invDet * (dirY * dx - dirX * dy);
      s._sx = (w * 0.5) * (1 + tx / ty);
      s._d = ty;
      const scale = projY / ty;
      s._scale = scale;
      s._yBase = horizon + (eye - (s.z || 0)) * scale;   // screen y of the sprite's foot
      vis.push(s);
    }
    vis.sort((a, b) => b._d - a._d);

    for (let n = 0; n < vis.length; n++) {
      const s = vis[n];
      const f = s.frame;
      if (!f) continue;
      const worldH = s.h || 0.8;
      const aspect = f.w / f.h;
      let sh = worldH * s._scale;
      // Optional screen-size ceiling, so a particle passing close to the lens
      // does not blow up into a wall of colour.
      if (s.maxFrac) {
        const cap = h * s.maxFrac;
        if (sh > cap) sh = cap;
      }
      const sw = sh * aspect * (s.wScale || 1);
      if (sh < 0.6 || sw < 0.6) continue;

      const yTop = s._yBase - sh;
      let x0 = Math.floor(s._sx - sw * 0.5), x1 = Math.ceil(s._sx + sw * 0.5);
      let y0 = Math.floor(yTop), y1 = Math.ceil(yTop + sh);
      if (x1 < 0 || x0 >= w || y1 < 0 || y0 >= h) continue;
      const cx0 = x0 < 0 ? 0 : x0, cx1 = x1 > w ? w : x1;
      const cy0 = y0 < 0 ? 0 : y0, cy1 = y1 > h ? h : y1;

      let lr = 1, lg = 1, lb = 1;
      if (s.emissive) { lr = lg = lb = 1.0; }
      else { const l = light.sample(s.x, s.y); lr = l[0]; lg = l[1]; lb = l[2]; }
      let fog = s.noFog ? 0 : s._d / fogFar;
      if (fog > 1) fog = 1;
      fog *= fog;
      const keep = 1 - fog;
      const tint = s.tint || 0;
      const tr = tint & 255, tg = (tint >>> 8) & 255, tb = (tint >>> 16) & 255;
      const ta = ((tint >>> 24) & 255) / 255;
      const alphaMul = s.alpha === undefined ? 1 : s.alpha;
      const additive = !!s.additive;
      const data = f.data, fw = f.w, fh = f.h;
      const invSW = fw / sw, invSH = fh / sh;

      const skyTop = this.skyTop;
      for (let x = cx0; x < cx1; x++) {
        // Depth test per column, with one concession: a column capped by a
        // parapet still shows the horizon above it, so a distant warhead is
        // visible over the berm instead of being culled wholesale.
        let rowLimit = cy1;
        const near = additive ? s._d - 0.15 : s._d;
        if (zbuf[x] < near) {
          if (skyTop[x] <= 0) continue;
          rowLimit = Math.min(cy1, skyTop[x]);
          if (rowLimit <= cy0) continue;
        }
        let sx = ((x - (s._sx - sw * 0.5)) * invSW) | 0;
        if (sx < 0) sx = 0; else if (sx >= fw) sx = fw - 1;
        for (let y = cy0; y < rowLimit; y++) {
          let sy = ((y - yTop) * invSH) | 0;
          if (sy < 0) sy = 0; else if (sy >= fh) sy = fh - 1;
          const t = data[sy * fw + sx];
          const a = (t >>> 24);
          if (!a) continue;
          let r = (t & 255), g = (t >>> 8) & 255, b = (t >>> 16) & 255;
          if (ta) { r += (tr - r) * ta; g += (tg - g) * ta; b += (tb - b) * ta; }
          r = r * lr * keep + fr * fog;
          g = g * lg * keep + fg * fog;
          b = b * lb * keep + fb * fog;
          const o = y * w + x;
          const op = (a / 255) * alphaMul;
          if (additive) {
            const d = buf[o];
            r = (d & 255) + r * op; g = ((d >>> 8) & 255) + g * op; b = ((d >>> 16) & 255) + b * op;
          } else if (op < 0.999) {
            const d = buf[o];
            r = (d & 255) + (r - (d & 255)) * op;
            g = ((d >>> 8) & 255) + (g - ((d >>> 8) & 255)) * op;
            b = ((d >>> 16) & 255) + (b - ((d >>> 16) & 255)) * op;
          }
          buf[o] = (255 << 24 |
            (b > 255 ? 255 : b) << 16 | (g > 255 ? 255 : g) << 8 | (r > 255 ? 255 : r)) >>> 0;
        }
      }
    }
  }

  /** Screen position of a world point, for HUD markers. Returns null if behind. */
  project(cam, wx, wy, wz, horizon) {
    const dirX = Math.cos(cam.ang), dirY = Math.sin(cam.ang);
    const planeLen = Math.tan(this.fov * 0.5);
    const planeX = -dirY * planeLen, planeY = dirX * planeLen;
    const invDet = 1.0 / (planeX * dirY - dirX * planeY);
    const dx = wx - cam.x, dy = wy - cam.y;
    const ty = invDet * (-planeY * dx + planeX * dy);
    if (ty <= 0.05) return null;
    const tx = invDet * (dirY * dx - dirX * dy);
    const scale = this.projY / ty;
    return {
      x: (this.w * 0.5) * (1 + tx / ty),
      y: horizon + (cam.z - wz) * scale,
      d: ty, scale,
    };
  }
}

/**
 * Coloured dynamic lighting sampled at cell corners and bilinearly interpolated.
 * One grid rebuild per frame over the cells near the camera keeps explosions,
 * muzzle flashes and lamps painting the geometry for very little cost.
 */
export class LightGrid {
  constructor() { this.W = 0; this.H = 0; this._out = new Float32Array(3); }

  resize(W, H) {
    if (this.W === W && this.H === H) return;
    this.W = W; this.H = H;
    const n = (W + 1) * (H + 1);
    this.r = new Float32Array(n);
    this.g = new Float32Array(n);
    this.b = new Float32Array(n);
  }

  /** @param {Array} lights  [{x,y,r,g,b,radius,intensity}] */
  build(cam, ambient, lights, radiusCells = 26) {
    const { W, H, r, g, b } = this;
    const ar = ambient[0], ag = ambient[1], ab = ambient[2];
    const x0 = Math.max(0, (cam.x - radiusCells) | 0), x1 = Math.min(W, ((cam.x + radiusCells) | 0) + 1);
    const y0 = Math.max(0, (cam.y - radiusCells) | 0), y1 = Math.min(H, ((cam.y + radiusCells) | 0) + 1);
    this.x0 = x0; this.x1 = x1; this.y0 = y0; this.y1 = y1;
    this.ambient = ambient;

    const stride = W + 1;
    for (let y = y0; y <= y1; y++) {
      const row = y * stride;
      for (let x = x0; x <= x1; x++) {
        r[row + x] = ar; g[row + x] = ag; b[row + x] = ab;
      }
    }
    for (let i = 0; i < lights.length; i++) {
      const L = lights[i];
      const rad = L.radius;
      const lx0 = Math.max(x0, (L.x - rad) | 0), lx1 = Math.min(x1, ((L.x + rad) | 0) + 1);
      const ly0 = Math.max(y0, (L.y - rad) | 0), ly1 = Math.min(y1, ((L.y + rad) | 0) + 1);
      const inv = 1 / (rad * rad);
      const ii = L.intensity;
      for (let y = ly0; y <= ly1; y++) {
        const dy = y - L.y, dy2 = dy * dy, row = y * stride;
        for (let x = lx0; x <= lx1; x++) {
          const dx = x - L.x;
          let f = 1 - (dx * dx + dy2) * inv;
          if (f <= 0) continue;
          f = f * f * ii;
          r[row + x] += L.r * f; g[row + x] += L.g * f; b[row + x] += L.b * f;
        }
      }
    }
  }

  sample(x, y) {
    const o = this._out;
    const { W, H } = this;
    if (x < this.x0 || y < this.y0 || x >= this.x1 || y >= this.y1) {
      o[0] = this.ambient[0]; o[1] = this.ambient[1]; o[2] = this.ambient[2];
      return o;
    }
    const xi = x | 0, yi = y | 0;
    const fx = x - xi, fy = y - yi;
    const stride = W + 1;
    const i00 = yi * stride + xi, i10 = i00 + 1, i01 = i00 + stride, i11 = i01 + 1;
    const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
    o[0] = this.r[i00] * w00 + this.r[i10] * w10 + this.r[i01] * w01 + this.r[i11] * w11;
    o[1] = this.g[i00] * w00 + this.g[i10] * w10 + this.g[i01] * w01 + this.g[i11] * w11;
    o[2] = this.b[i00] * w00 + this.b[i10] * w10 + this.b[i01] * w01 + this.b[i11] * w11;
    return o;
  }
}
