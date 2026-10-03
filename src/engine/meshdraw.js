// meshdraw.js - drawing the furniture as solid 3D models.
//
// The walls, floors and sky are a raycaster; the furniture is real geometry
// (propmesh.js) and is drawn here, after the room and before the billboards,
// with the same camera: the same projection, the same pitch shear, the same
// per-column wall depth, the same light grid and the same haze. Every pixel a
// model covers leaves its depth in rc.pz, so the staff and everything else
// drawn as a billboard afterwards is hidden behind a desk it is behind, and in
// front of one it is in front of, pixel by pixel.
//
// Triangles are culled when they face away, clipped against a near plane and
// filled with perspective-correct texturing. Light is sampled from the room's
// light grid at every vertex (so a desk half in a pool of light is lit half
// way) and haze is worked out per pixel.

const NEAR = 0.04;

// scratch, grown as needed
let CAP = 0;
let WX, WY, WZ, DEP, LAT, SX, SY, IZ, UZ, VZ, LR, LG, LB, U, V;
function ensure(n) {
  if (n <= CAP) return;
  CAP = Math.max(n, CAP * 2, 1024);
  WX = new Float64Array(CAP); WY = new Float64Array(CAP); WZ = new Float64Array(CAP);
  DEP = new Float64Array(CAP); LAT = new Float64Array(CAP);
  SX = new Float64Array(CAP); SY = new Float64Array(CAP); IZ = new Float64Array(CAP);
  UZ = new Float64Array(CAP); VZ = new Float64Array(CAP);
  LR = new Float64Array(CAP); LG = new Float64Array(CAP); LB = new Float64Array(CAP);
  U = new Float64Array(CAP); V = new Float64Array(CAP);
}

// per-frame state shared with the rasterizer
let buf, zbuf, pz, W, H, fogFar, fr, fg, fb, halfW, projY, horizon, eye, focal;
// Over a parapet the raycaster draws open sky (skyTop is the berm's top row);
// a model out in the open beyond it shows above the berm, one under a roof
// next door does not (openNow, per model).
let skyTop = null, openNow = false;
let dx0 = 1e9, dy0 = 1e9, dx1 = -1, dy1 = -1;   // what we touched this frame

/**
 * Draw `list` into rc.buf. Each entry:
 *   { mesh, x, y, z, yaw, tilt, front, roll, rollY, emissive, shadow }
 * tilt: falling forward about the front bottom edge (0 standing, PI/2 on its
 * face); roll: tumbling end over end about its own middle (in the air).
 */
export function drawMeshes(rc, cam, hz, light, list, opts) {
  if (!rc.pz || rc.pz.length !== rc.w * rc.h) {
    rc.pz = new Float32Array(rc.w * rc.h).fill(1e9);
    rc.pzBox = null;
  }
  // clear what the last frame wrote
  const box = rc.pzBox;
  if (box) {
    const w = rc.w;
    for (let y = box[1]; y <= box[3]; y++) rc.pz.fill(1e9, y * w + box[0], y * w + box[2] + 1);
    rc.pzBox = null;
  }
  if (!list || !list.length) return;
  buf = rc.buf; zbuf = rc.zbuf; pz = rc.pz; W = rc.w; H = rc.h;
  skyTop = rc.skyTop || null;
  const lv = rc.lv || null;
  fogFar = opts.fogFar;
  const fc = opts.fogColor;
  fr = fc & 255; fg = (fc >>> 8) & 255; fb = (fc >>> 16) & 255;
  halfW = W * 0.5; projY = rc.projY; horizon = hz; eye = cam.z;
  const L = Math.tan(rc.fov * 0.5);
  focal = halfW / L;
  const dirX = Math.cos(cam.ang), dirY = Math.sin(cam.ang);
  dx0 = 1e9; dy0 = 1e9; dx1 = -1; dy1 = -1;

  // shadows on the floor first, so every model stands on its own
  for (let n = 0; n < list.length; n++) {
    const it = list[n];
    const sh = it.mesh && it.mesh.shadow;
    if (!sh || it.shadow === false) continue;
    drawShadow(it, sh, cam, dirX, dirY, light);
  }
  for (let n = 0; n < list.length; n++) {
    const it = list[n];
    if (!it.mesh || !it.mesh.ready) continue;
    openNow = !!skyTop && (!lv || it.x < 0 || it.y < 0 || it.x >= lv.W || it.y >= lv.H || !!lv.sky[(it.y | 0) * lv.W + (it.x | 0)]);
    drawOne(it, it.mesh, cam, dirX, dirY, L, light);
  }
  openNow = false;
  if (dx1 >= dx0) rc.pzBox = [Math.max(0, dx0), Math.max(0, dy0), Math.min(W - 1, dx1), Math.min(H - 1, dy1)];
}

function drawOne(it, m, cam, dirX, dirY, L, light) {
  const yaw = it.yaw || 0;
  const fX = Math.cos(yaw), fY = Math.sin(yaw);         // the model's front, on the map
  const rX = fY, rY = -fX;                              // its right
  const tilt = it.tilt || 0, roll = it.roll || 0;
  const ct = Math.cos(tilt), st = Math.sin(tilt), cr = Math.cos(roll), sr = Math.sin(roll);
  const front = it.front || 0, rollY = it.rollY !== undefined ? it.rollY : m.cy;
  const ox = it.x, oy = it.y, oz = it.z || 0;

  // cull the whole thing first, by its bounding sphere
  {
    const wx = ox + m.cx * rX + m.cz * fX, wy = oy + m.cx * rY + m.cz * fY;
    const ddx = wx - cam.x, ddy = wy - cam.y;
    const d = ddx * dirX + ddy * dirY;
    const r = m.r + (tilt || roll ? m.r : 0) + 0.05;
    if (d + r < NEAR) return;
    if (d - r > fogFar * 1.05) return;
    const lat = dirX * ddy - dirY * ddx;
    if (Math.abs(lat) - r > (d + r) * L * 1.02) return;
  }

  const nv = m.vx.length;
  ensure(nv + 64);
  const vx = m.vx, vy = m.vy, vz = m.vz, vu = m.vu, vv = m.vv;
  const emissive = !!it.emissive;
  let lastCell = -1, cr0 = 1, cg0 = 1, cb0 = 1;
  for (let i = 0; i < nv; i++) {
    let x = vx[i], y = vy[i], z = vz[i];
    if (tilt) { const zz = z - front; const y1 = y * ct - zz * st; z = y * st + zz * ct + front; y = y1; }
    if (roll) { const yy = y - rollY; const y1 = yy * cr - z * sr; z = yy * sr + z * cr; y = y1 + rollY; }
    const wx = ox + x * rX + z * fX, wy = oy + x * rY + z * fY, wz = oz + y;
    WX[i] = wx; WY[i] = wy; WZ[i] = wz;
    const ddx = wx - cam.x, ddy = wy - cam.y;
    const d = ddx * dirX + ddy * dirY;
    const lat = dirX * ddy - dirY * ddx;
    DEP[i] = d; LAT[i] = lat; U[i] = vu[i]; V[i] = vv[i];
    if (emissive) { LR[i] = LG[i] = LB[i] = 1; }
    else {
      // the light grid is smooth over a cell: sample a vertex's cell once per run of vertices in it
      const cell = ((wx * 4) | 0) * 65536 + ((wy * 4) | 0);
      if (cell !== lastCell) { const s = light.sample(wx, wy); cr0 = s[0]; cg0 = s[1]; cb0 = s[2]; lastCell = cell; }
      LR[i] = cr0; LG[i] = cg0; LB[i] = cb0;
    }
    if (d > NEAR) project(i, d, lat, wz);
  }

  const tri = m.tri, tn = m.tn, tp = m.tpatch, P = m.patches;
  const nt = tpatch_len(tp);
  for (let t = 0; t < nt; t++) {
    const a = tri[t * 3], b = tri[t * 3 + 1], c = tri[t * 3 + 2];
    // facing away?
    let nx = tn[t * 3], ny = tn[t * 3 + 1], nz = tn[t * 3 + 2];
    if (tilt) { const y1 = ny * ct - nz * st; nz = ny * st + nz * ct; ny = y1; }
    if (roll) { const y1 = ny * cr - nz * sr; nz = ny * sr + nz * cr; ny = y1; }
    const wnx = nx * rX + nz * fX, wny = nx * rY + nz * fY, wnz = ny;
    if (wnx * (WX[a] - cam.x) + wny * (WY[a] - cam.y) + wnz * (WZ[a] - cam.z) >= 0) continue;
    const pt = P[tp[t]];
    const da = DEP[a] > NEAR, db = DEP[b] > NEAR, dc = DEP[c] > NEAR;
    if (da && db && dc) { raster(a, b, c, pt.tex, pt.tw, pt.th); continue; }
    if (!da && !db && !dc) continue;
    clipAndRaster(a, b, c, pt);
  }
}

function tpatch_len(tp) { return tp.length; }

function project(i, d, lat, wz) {
  const iz = 1 / d;
  SX[i] = halfW + lat * focal * iz;
  SY[i] = horizon + (eye - wz) * projY * iz;
  IZ[i] = iz;
  UZ[i] = U[i] * iz;
  VZ[i] = V[i] * iz;
}

// near-plane clipping: a triangle with one or two corners behind the lens
const CL = [0, 0, 0, 0];
function clipAndRaster(a, b, c, pt) {
  const src = [a, b, c];
  let n = 0;
  let k = CAP - 8;                       // scratch slots at the end
  for (let e = 0; e < 3; e++) {
    const p = src[e], q = src[(e + 1) % 3];
    const pin = DEP[p] > NEAR, qin = DEP[q] > NEAR;
    if (pin) CL[n++] = p;
    if (pin !== qin) {
      const t = (NEAR - DEP[p]) / (DEP[q] - DEP[p]);
      const j = k++;
      DEP[j] = NEAR;
      LAT[j] = LAT[p] + (LAT[q] - LAT[p]) * t;
      WZ[j] = WZ[p] + (WZ[q] - WZ[p]) * t;
      U[j] = U[p] + (U[q] - U[p]) * t; V[j] = V[p] + (V[q] - V[p]) * t;
      LR[j] = LR[p] + (LR[q] - LR[p]) * t; LG[j] = LG[p] + (LG[q] - LG[p]) * t; LB[j] = LB[p] + (LB[q] - LB[p]) * t;
      project(j, NEAR, LAT[j], WZ[j]);
      CL[n++] = j;
    }
  }
  if (n >= 3) raster(CL[0], CL[1], CL[2], pt.tex, pt.tw, pt.th);
  if (n === 4) raster(CL[0], CL[2], CL[3], pt.tex, pt.tw, pt.th);
}

/**
 * Fill one triangle. Barycentric weights are linear across the screen, so
 * 1/z, u/z, v/z and the light are stepped along each row; the depth test is
 * against the wall in this column and whatever model already covers the pixel.
 */
function raster(a, b, c, tex, tw, th) {
  const ax = SX[a], ay = SY[a], bx = SX[b], by = SY[b], cx = SX[c], cy = SY[c];
  const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  if (area > -1e-9 && area < 1e-9) return;
  const inv = 1 / area;
  let y0 = Math.ceil(Math.min(ay, by, cy) - 0.5), y1 = Math.floor(Math.max(ay, by, cy) - 0.5);
  let x0 = Math.ceil(Math.min(ax, bx, cx) - 0.5), x1 = Math.floor(Math.max(ax, bx, cx) - 0.5);
  if (y0 < 0) y0 = 0; if (y1 > H - 1) y1 = H - 1;
  if (x0 < 0) x0 = 0; if (x1 > W - 1) x1 = W - 1;
  if (y1 < y0 || x1 < x0) return;
  if (x0 < dx0) dx0 = x0; if (x1 > dx1) dx1 = x1; if (y0 < dy0) dy0 = y0; if (y1 > dy1) dy1 = y1;

  // weight of a: edge b->c; of b: edge c->a; of c: edge a->b. w(px, py) = (A px + B py + C) * inv
  const Aa = -(cy - by) * inv, Ba = (cx - bx) * inv, Ca = ((cy - by) * bx - (cx - bx) * by) * inv;
  const Ab = -(ay - cy) * inv, Bb = (ax - cx) * inv, Cb = ((ay - cy) * cx - (ax - cx) * cy) * inv;
  const Ac = -(by - ay) * inv, Bc = (bx - ax) * inv, Cc = ((by - ay) * ax - (bx - ax) * ay) * inv;

  const iza = IZ[a], izb = IZ[b], izc = IZ[c];
  const ua = UZ[a], ub = UZ[b], uc = UZ[c], va = VZ[a], vb = VZ[b], vc = VZ[c];
  const ra = LR[a], rb = LR[b], rc = LR[c], ga = LG[a], gb = LG[b], gc = LG[c], ba = LB[a], bb = LB[b], bc = LB[c];
  // per-pixel steps along x
  const dIZ = Aa * iza + Ab * izb + Ac * izc;
  const dU = Aa * ua + Ab * ub + Ac * uc, dV = Aa * va + Ab * vb + Ac * vc;
  const dR = Aa * ra + Ab * rb + Ac * rc, dG = Aa * ga + Ab * gb + Ac * gc, dB = Aa * ba + Ab * bb + Ac * bc;
  const EPS = -1e-7;
  const twm = tw - 1, thm = th - 1;
  const invFog = 1 / fogFar;

  for (let y = y0; y <= y1; y++) {
    const py = y + 0.5;
    // the span of this row inside all three edges
    let lo = x0 + 0.5, hi = x1 + 0.5;
    const ea = Ba * py + Ca, eb = Bb * py + Cb, ec = Bc * py + Cc;
    if (Aa > 0) { const t = (EPS - ea) / Aa; if (t > lo) lo = t; } else if (Aa < 0) { const t = (EPS - ea) / Aa; if (t < hi) hi = t; } else if (ea < EPS) continue;
    if (Ab > 0) { const t = (EPS - eb) / Ab; if (t > lo) lo = t; } else if (Ab < 0) { const t = (EPS - eb) / Ab; if (t < hi) hi = t; } else if (eb < EPS) continue;
    if (Ac > 0) { const t = (EPS - ec) / Ac; if (t > lo) lo = t; } else if (Ac < 0) { const t = (EPS - ec) / Ac; if (t < hi) hi = t; } else if (ec < EPS) continue;
    let xs = Math.ceil(lo - 0.5), xe = Math.floor(hi - 0.5);
    if (xs < x0) xs = x0; if (xe > x1) xe = x1;
    if (xe < xs) continue;
    const px = xs + 0.5;
    const wa = Aa * px + ea, wb = Ab * px + eb, wc = Ac * px + ec;
    let iz = wa * iza + wb * izb + wc * izc;
    let uz = wa * ua + wb * ub + wc * uc, vz = wa * va + wb * vb + wc * vc;
    let lr = wa * ra + wb * rb + wc * rc, lg = wa * ga + wb * gb + wc * gc, lb = wa * ba + wb * bb + wc * bc;
    let o = y * W + xs;
    for (let x = xs; x <= xe; x++, o++, iz += dIZ, uz += dU, vz += dV, lr += dR, lg += dG, lb += dB) {
      if (iz <= 0) continue;
      const d = 1 / iz;
      if (d >= pz[o]) continue;
      if (d >= zbuf[x] && !(openNow && y < skyTop[x])) continue;
      let tu = (uz * d * tw) | 0, tv = (vz * d * th) | 0;
      if (tu < 0) tu = 0; else if (tu > twm) tu = twm;
      if (tv < 0) tv = 0; else if (tv > thm) tv = thm;
      const t = tex[tv * tw + tu];
      let fog = d * invFog;
      if (fog > 1) fog = 1;
      fog *= fog;
      const keep = 1 - fog;
      let r = (t & 255) * lr * keep + fr * fog;
      let g = ((t >>> 8) & 255) * lg * keep + fg * fog;
      let bl = ((t >>> 16) & 255) * lb * keep + fb * fog;
      if (r > 255) r = 255; if (g > 255) g = 255; if (bl > 255) bl = 255;
      buf[o] = (255 << 24 | bl << 16 | g << 8 | r) >>> 0;
      pz[o] = d;
    }
  }
}

// ------------------------------------------------------------------ the floor shadow

const SQ = [[0, 0], [1, 0], [1, 1], [0, 1]];
function drawShadow(it, sh, cam, dirX, dirY, light) {
  if (it.tilt > 0.25 || it.roll || (it.z || 0) > 0.05) return;
  const yaw = it.yaw || 0;
  const fX = Math.cos(yaw), fY = Math.sin(yaw), rX = fY, rY = -fX;
  ensure(16);
  const base = 0;
  for (let k = 0; k < 4; k++) {
    const mx = sh.x0 + (sh.x1 - sh.x0) * SQ[k][0], mz = sh.z0 + (sh.z1 - sh.z0) * SQ[k][1];
    const wx = it.x + mx * rX + mz * fX, wy = it.y + mx * rY + mz * fY;
    const ddx = wx - cam.x, ddy = wy - cam.y;
    DEP[base + k] = ddx * dirX + ddy * dirY;
    LAT[base + k] = dirX * ddy - dirY * ddx;
    WZ[base + k] = 0.004;
    U[base + k] = SQ[k][0]; V[base + k] = SQ[k][1];
    LR[base + k] = LG[base + k] = LB[base + k] = 1;
  }
  for (let k = 0; k < 4; k++) if (DEP[k] <= NEAR) return;       // at your feet: not worth clipping
  for (let k = 0; k < 4; k++) project(k, DEP[k], LAT[k], WZ[k]);
  shade(0, 1, 2, sh); shade(0, 2, 3, sh);
}

/** Darken the floor by a shadow texture's alpha, behind nothing nearer. */
function shade(a, b, c, sh) {
  const tex = sh.tex, tw = sh.tw, th = sh.th;
  const ax = SX[a], ay = SY[a], bx = SX[b], by = SY[b], cx = SX[c], cy = SY[c];
  const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  if (area > -1e-9 && area < 1e-9) return;
  const inv = 1 / area;
  let y0 = Math.ceil(Math.min(ay, by, cy) - 0.5), y1 = Math.floor(Math.max(ay, by, cy) - 0.5);
  let x0 = Math.ceil(Math.min(ax, bx, cx) - 0.5), x1 = Math.floor(Math.max(ax, bx, cx) - 0.5);
  if (y0 < 0) y0 = 0; if (y1 > H - 1) y1 = H - 1;
  if (x0 < 0) x0 = 0; if (x1 > W - 1) x1 = W - 1;
  if (y1 < y0 || x1 < x0) return;
  const Aa = -(cy - by) * inv, Ba = (cx - bx) * inv, Ca = ((cy - by) * bx - (cx - bx) * by) * inv;
  const Ab = -(ay - cy) * inv, Bb = (ax - cx) * inv, Cb = ((ay - cy) * cx - (ax - cx) * cy) * inv;
  const Ac = -(by - ay) * inv, Bc = (bx - ax) * inv, Cc = ((by - ay) * ax - (bx - ax) * ay) * inv;
  const iza = IZ[a], izb = IZ[b], izc = IZ[c];
  const ua = UZ[a], ub = UZ[b], uc = UZ[c], va = VZ[a], vb = VZ[b], vc = VZ[c];
  const twm = tw - 1, thm = th - 1;
  for (let y = y0; y <= y1; y++) {
    const py = y + 0.5;
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5;
      const wa = Aa * px + Ba * py + Ca, wb = Ab * px + Bb * py + Cb, wc = Ac * px + Bc * py + Cc;
      if (wa < -1e-7 || wb < -1e-7 || wc < -1e-7) continue;
      const iz = wa * iza + wb * izb + wc * izc;
      if (iz <= 0) continue;
      const d = 1 / iz;
      if (d >= zbuf[x]) continue;
      let tu = ((wa * ua + wb * ub + wc * uc) * d * tw) | 0, tv = ((wa * va + wb * vb + wc * vc) * d * th) | 0;
      if (tu < 0) tu = 0; else if (tu > twm) tu = twm;
      if (tv < 0) tv = 0; else if (tv > thm) tv = thm;
      const al = tex[tv * tw + tu] >>> 24;
      if (!al) continue;
      let f = d / fogFar; if (f > 1) f = 1;
      const k = 1 - (al / 255) * (1 - f * f);
      const o = y * W + x;
      const s = buf[o];
      buf[o] = (255 << 24 | (((s >>> 16) & 255) * k) << 16 | (((s >>> 8) & 255) * k) << 8 | ((s & 255) * k)) >>> 0;
    }
  }
}
