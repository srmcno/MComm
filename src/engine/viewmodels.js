// viewmodels.js - NUKEHAUS first-person weapon art, HUD portrait, explosion FX,
// horizon cities and sky elements. Everything is generated with pure math into
// Uint32Arrays; no DOM, no canvas API, no node builtins, no binary assets.
//
// HOW THIS FILE WORKS
// -------------------
// Almost nothing here plots a final colour directly. Painters write into a
// deferred-shading canvas: an albedo buffer plus per-pixel surface normal,
// ambient occlusion, gloss and emissive channels. `bake()` then runs one
// lighting pass over the whole thing with a consistent light rig (key from
// above-front-left, cool bunker rim, and - in the _fire frames - a bright point
// light sitting at the muzzle). That is why the guns have volume: a barrel is
// literally shaded as a cylinder, a glove finger as a capsule, a face as a
// height field. Poses are parameters, not redrawn art.
//
// Alpha convention: 0 = transparent, 255 = solid. The additive FX layers
// (muzzle flashes, smoke, clouds, contrail, shock rings, haze) intentionally
// use partial alpha - the engine blends them, so a soft falloff is required.

import {
  rgba, mix, shade, clamp, lerp, makeRng, fbm, makeFrame, line, outline,
} from '../core/pixels.js';

// ---------------------------------------------------------------------------
// small math
// ---------------------------------------------------------------------------

const PI = Math.PI, TAU = PI * 2;
const sin = Math.sin, cos = Math.cos, abs = Math.abs, sqrt = Math.sqrt;
const floor = Math.floor, ceil = Math.ceil, min = Math.min, max = Math.max;
const pow = Math.pow, atan2 = Math.atan2, hypot = Math.hypot, exp = Math.exp;

/** Cheap deterministic 2D hash -> 0..1. Used for grain, dust, scratches. */
function hash2(x, y, s = 0) {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263 + (s | 0) * 1442695041;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smoothstep(a, b, t) {
  const x = clamp((t - a) / (b - a || 1e-6), 0, 1);
  return x * x * (3 - 2 * x);
}

/** 0 at |v|>=1, 1 at v=0, smooth. */
function falloff(v, p = 2) { return pow(max(0, 1 - abs(v)), p); }

function norm3(x, y, z) {
  const l = sqrt(x * x + y * y + z * z) || 1;
  return [x / l, y / l, z / l];
}

// ---------------------------------------------------------------------------
// model transform
// ---------------------------------------------------------------------------
// Painters are authored in a convenient "model space" and every leaf painter
// resolves through this transform, stepping its scan loops by ST = 1/scale so
// an enlarged model still lays down a gap-free canvas. That lets each weapon be
// composed once and then sized into the 200x150 viewmodel frame with one call.

let MX = 1, MOX = 0, MOY = 0, ST = 1;

/** canvas = (model - c) * s + t.  setModel() with no args resets to identity. */
function setModel(s = 1, cx = 0, cy = 0, tx = 0, ty = 0) {
  MX = s; MOX = tx - cx * s; MOY = ty - cy * s; ST = 1 / s;
}
function MPX(x) { return floor(MOX + x * MX + 0.5); }
function MPY(y) { return floor(MOY + y * MX + 0.5); }

// ---------------------------------------------------------------------------
// deferred-shading canvas
// ---------------------------------------------------------------------------

/**
 * A drawing surface that records surface properties instead of final colour.
 * data  - albedo, canvas-order u32; alpha 0 = nothing here.
 * nx/ny/nz - surface normal (image space: +x right, +y DOWN, +z toward viewer).
 * ao    - ambient occlusion multiplier, 1 = fully open.
 * gl    - gloss 0..1, drives specular strength and tightness.
 * em    - emissive 0..1, 1 = albedo passes through unshaded (and boosted).
 */
function makeCv(w, h) {
  const n = w * h;
  const cv = {
    w, h,
    data: new Uint32Array(n),
    nx: new Float32Array(n),
    ny: new Float32Array(n),
    nz: new Float32Array(n),
    ao: new Float32Array(n),
    gl: new Float32Array(n),
    em: new Float32Array(n),
  };
  cv.nz.fill(1);
  cv.ao.fill(1);
  cv.gl.fill(0.18);
  return cv;
}

/** Full surface write. Out-of-bounds and alpha-0 colours are dropped. */
function put(cv, x, y, c, nx = 0, ny = 0, nz = 1, ao = 1, gl = 0.18, em = 0) {
  x = MPX(x); y = MPY(y);
  if (x < 0 || y < 0 || x >= cv.w || y >= cv.h) return;
  if (!(c >>> 24)) return;
  const i = y * cv.w + x;
  cv.data[i] = c;
  const l = sqrt(nx * nx + ny * ny + nz * nz) || 1;
  cv.nx[i] = nx / l; cv.ny[i] = ny / l; cv.nz[i] = nz / l;
  cv.ao[i] = ao; cv.gl[i] = gl; cv.em[i] = em;
}

/** Albedo-only write that keeps the existing normal (for decals: dirt, blood). */
function tint(cv, x, y, c, amt = 1) {
  x = MPX(x); y = MPY(y);
  if (x < 0 || y < 0 || x >= cv.w || y >= cv.h) return;
  const i = y * cv.w + x;
  if (!(cv.data[i] >>> 24)) return;
  cv.data[i] = amt >= 1 ? c : mix(cv.data[i], c, amt);
}

function cvGet(cv, x, y) {
  x = MPX(x); y = MPY(y);
  if (x < 0 || y < 0 || x >= cv.w || y >= cv.h) return 0;
  return cv.data[y * cv.w + x];
}

function cvHas(cv, x, y) { return (cvGet(cv, x, y) >>> 24) !== 0; }

/** Multiply the AO channel of an already-painted pixel (contact shadows). */
function occlude(cv, x, y, amt) {
  x = MPX(x); y = MPY(y);
  if (x < 0 || y < 0 || x >= cv.w || y >= cv.h) return;
  const i = y * cv.w + x;
  if (!(cv.data[i] >>> 24)) return;
  cv.ao[i] *= amt;
}

/**
 * The one lighting pass. Produces a {w,h,data} frame with alpha 0 or 255.
 *
 * opts:
 *   key      [x,y,z] main light direction (points toward the light)
 *   keyCol   colour of the key light
 *   fill     ambient floor
 *   rim      cool back-rim amount
 *   flash    0..1 muzzle-flash point-light strength
 *   fx,fy,fz muzzle-flash position in canvas space (fz = height above surface)
 *   flashCol colour of the flash light
 *   flashR   flash falloff radius
 */
function bake(cv, opts = {}) {
  const {
    key = norm3(-0.42, -0.86, 0.45),
    keyCol = [1.0, 0.97, 0.90],
    fill = 0.24,
    fillCol = [0.46, 0.52, 0.70],
    rim = 0.30,
    rimCol = [0.42, 0.56, 0.92],
    flash = 0,
    fx = cv.w * 0.5, fy = 10, fz = 42,
    flashCol = [1.0, 0.80, 0.46],
    flashR = 118,
    exposure = 1,
    botDark = 0,          // viewmodels fall off toward the player's hands
    env = 1,              // strength of the sky/floor environment reflection
    bounce = 0,           // dim warm light coming back up off the floor
    bounceDir = norm3(0.30, 0.90, 0.34),
    bounceCol = [1.0, 0.76, 0.56],
  } = opts;

  const out = makeFrame(cv.w, cv.h);
  // halfway vector for the key specular (view is +z)
  const kh = norm3(key[0], key[1], key[2] + 1);

  for (let y = 0; y < cv.h; y++) {
    for (let x = 0; x < cv.w; x++) {
      const i = y * cv.w + x;
      const a = cv.data[i];
      if (!(a >>> 24)) continue;
      const ar = a & 255, ag = (a >>> 8) & 255, ab = (a >>> 16) & 255;
      const nx = cv.nx[i], ny = cv.ny[i], nz = cv.nz[i];
      const ao = cv.ao[i], gl = cv.gl[i], em = cv.em[i];

      // --- diffuse ---
      const nd = max(0, nx * key[0] + ny * key[1] + nz * key[2]);
      // wrapped terminator, curved to open up the shadow-to-light range
      const wrap = pow((nd + 0.24) / 1.24, 1.45) * 1.16;
      const vk = botDark ? 1 - botDark * smoothstep(cv.h * 0.34, cv.h * 1.02, y) : 1;
      const aov = ao * vk;
      let dr = fill * fillCol[0] * aov + wrap * keyCol[0] * aov;
      let dg = fill * fillCol[1] * aov + wrap * keyCol[1] * aov;
      let db = fill * fillCol[2] * aov + wrap * keyCol[2] * aov;

      // --- bounce light off the floor, lifting chins and undersides ---
      if (bounce > 0.001) {
        const bd = max(0, nx * bounceDir[0] + ny * bounceDir[1] + nz * bounceDir[2]);
        const k = bounce * pow(bd, 0.85) * aov;
        dr += k * bounceCol[0]; dg += k * bounceCol[1]; db += k * bounceCol[2];
      }

      // --- cool rim on grazing angles (bunker bounce) ---
      const fres = pow(1 - clamp(nz, 0, 1), 3);
      dr += fres * rim * rimCol[0]; dg += fres * rim * rimCol[1]; db += fres * rim * rimCol[2];

      let r = ar * dr, g = ag * dg, b = ab * db;

      // --- environment reflection: bright sky above, dark floor below ---
      if (gl > 0.02) {
        const up = clamp(-ny * 0.5 + 0.5, 0, 1);
        const envK = gl * (0.16 + 0.95 * pow(up, 1.7)) * aov * env;
        r += envK * 78; g += envK * 88; b += envK * 112;
      }

      // --- key specular ---
      if (gl > 0.01) {
        const sd = max(0, nx * kh[0] + ny * kh[1] + nz * kh[2]);
        const sp = pow(sd, 3.5 + gl * 44) * gl * 215 * aov;
        r += sp * keyCol[0]; g += sp * keyCol[1]; b += sp * keyCol[2];
      }

      // --- muzzle flash point light ---
      if (flash > 0.001) {
        const lx = fx - x, ly = fy - y, lz = fz;
        const d = sqrt(lx * lx + ly * ly + lz * lz) || 1;
        const Lx = lx / d, Ly = ly / d, Lz = lz / d;
        const att = 1 / (1 + (d / flashR) * (d / flashR) * 2.6);
        const ld = max(0, nx * Lx + ny * Ly + nz * Lz);
        const amt = flash * att * ((ld + 0.20) / 1.20) * 1.55;
        r += ar * amt * flashCol[0];
        g += ag * amt * flashCol[1];
        b += ab * amt * flashCol[2];
        if (gl > 0.01) {
          const hx = Lx, hy = Ly, hz = Lz + 1;
          const hl = sqrt(hx * hx + hy * hy + hz * hz) || 1;
          const sd = max(0, nx * hx / hl + ny * hy / hl + nz * hz / hl);
          const sp = pow(sd, 10 + gl * 80) * gl * 215 * flash * att;
          r += sp * flashCol[0]; g += sp * flashCol[1]; b += sp * flashCol[2];
        }
      }

      // --- emissive passthrough ---
      if (em > 0.001) {
        r = lerp(r, ar * (1 + em * 0.35), em);
        g = lerp(g, ag * (1 + em * 0.35), em);
        b = lerp(b, ab * (1 + em * 0.35), em);
      }

      out.data[i] = rgba(
        clamp(r * exposure, 0, 255),
        clamp(g * exposure, 0, 255),
        clamp(b * exposure, 0, 255),
        255,
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// partial-alpha compositing helpers (FX layers only)
// ---------------------------------------------------------------------------

/** Source-over blend of a straight-alpha colour into a frame. */
function blend(f, x, y, c, a) {
  x |= 0; y |= 0;
  if (x < 0 || y < 0 || x >= f.w || y >= f.h) return;
  if (a <= 0) return;
  if (a > 1) a = 1;
  const i = y * f.w + x;
  const d = f.data[i];
  const da = (d >>> 24) / 255;
  const oa = a + da * (1 - a);
  if (oa <= 0) { f.data[i] = 0; return; }
  const sr = c & 255, sg = (c >>> 8) & 255, sb = (c >>> 16) & 255;
  const dr = d & 255, dg = (d >>> 8) & 255, db = (d >>> 16) & 255;
  f.data[i] = rgba(
    (sr * a + dr * da * (1 - a)) / oa,
    (sg * a + dg * da * (1 - a)) / oa,
    (sb * a + db * da * (1 - a)) / oa,
    oa * 255,
  );
}

/** Additive accumulation with alpha = max coverage. Used by every flash/fire. */
function addPx(f, x, y, r, g, b, a) {
  x |= 0; y |= 0;
  if (x < 0 || y < 0 || x >= f.w || y >= f.h) return;
  if (a <= 0.0008) return;
  const i = y * f.w + x;
  const d = f.data[i];
  const nr = clamp((d & 255) + r, 0, 255);
  const ng = clamp(((d >>> 8) & 255) + g, 0, 255);
  const nb = clamp(((d >>> 16) & 255) + b, 0, 255);
  const na = clamp(max((d >>> 24) / 255, min(a, 1)) * 255, 0, 255);
  f.data[i] = rgba(nr, ng, nb, na);
}

// ---------------------------------------------------------------------------
// colour ramps
// ---------------------------------------------------------------------------

const HOT_STOPS = [
  [0.00, 255, 255, 250],
  [0.10, 255, 250, 214],
  [0.26, 255, 226, 128],
  [0.44, 255, 172, 52],
  [0.62, 240, 104, 22],
  [0.78, 176, 48, 16],
  [0.90, 92, 26, 18],
  [1.00, 34, 18, 18],
];

/** Blackbody-ish fire ramp. t=0 white hot, t=1 dead ember. Returns [r,g,b]. */
function hotGradient(t) {
  t = clamp(t, 0, 1);
  for (let i = 1; i < HOT_STOPS.length; i++) {
    const a = HOT_STOPS[i - 1], b = HOT_STOPS[i];
    if (t <= b[0]) {
      const u = (t - a[0]) / (b[0] - a[0] || 1);
      return [lerp(a[1], b[1], u), lerp(a[2], b[2], u), lerp(a[3], b[3], u)];
    }
  }
  return [34, 18, 18];
}

function hotColor(t, a = 255) {
  const c = hotGradient(t);
  return rgba(c[0], c[1], c[2], a);
}

/** Smoke ramp: t=0 hot-lit underside, t=1 cold grey. */
function smokeGradient(t) {
  t = clamp(t, 0, 1);
  if (t < 0.4) {
    const u = t / 0.4;
    return [lerp(122, 84, u), lerp(84, 76, u), lerp(64, 74, u)];
  }
  const u = (t - 0.4) / 0.6;
  return [lerp(84, 46, u), lerp(76, 44, u), lerp(74, 48, u)];
}

// ---------------------------------------------------------------------------
// generic surface painters
// ---------------------------------------------------------------------------

const METAL = { base: rgba(140, 143, 152, 255), gloss: 0.46, grain: 0.075 };

/** Slight per-pixel albedo grain so flat metal is never a dead colour. */
function grainy(c, x, y, seed, amt) {
  const n = (hash2(x, y, seed) - 0.5) * 2 + (fbm(seed, x / 9, y / 9, 2, 8) - 0.5) * 1.6;
  return shade(c, 1 + n * amt);
}

/**
 * Rectangular metal panel with a proper bevel: the edges tilt their normals so
 * the lighting pass produces the highlight/shadow instead of us faking it.
 */
function metalPanel(cv, x, y, w, h, o = {}) {
  const {
    col = METAL.base, gloss = METAL.gloss, bevel = 2, grain = METAL.grain,
    seed = 7, round = 0, ao = 1, dark = 0.0, em = 0, curve = 0,
  } = o;
  for (let j = 0; j < h; j += ST) {
    for (let i = 0; i < w; i += ST) {
      if (round > 0) {
        const cx = min(i, w - 1 - i), cy = min(j, h - 1 - j);
        if (cx < round && cy < round) {
          const dx = round - cx, dy = round - cy;
          if (dx * dx + dy * dy > round * round) continue;
        }
      }
      const eL = i / max(1, bevel), eR = (w - 1 - i) / max(1, bevel);
      const eT = j / max(1, bevel), eB = (h - 1 - j) / max(1, bevel);
      let nx = 0, ny = 0;
      if (eL < 1) nx -= (1 - eL) * 0.95;
      if (eR < 1) nx += (1 - eR) * 0.95;
      if (eT < 1) ny -= (1 - eT) * 0.95;
      if (eB < 1) ny += (1 - eB) * 0.95;
      if (curve) {
        const u = (i / (w - 1)) * 2 - 1;
        nx += u * curve;
      }
      const nz = sqrt(max(0.04, 1 - nx * nx - ny * ny));
      const c = grainy(shade(col, 1 - dark), x + i, y + j, seed, grain);
      put(cv, x + i, y + j, c, nx, ny, nz, ao, gloss, em);
    }
  }
}

/**
 * Vertical cylinder (barrels, grips, tubes). Analytic normals, so it lights
 * like a real tube. `taper` shrinks the radius toward y1, `cap` shades the
 * open muzzle end.
 */
function cylinderV(cv, cx, y0, y1, r, o = {}) {
  const {
    col = METAL.base, gloss = METAL.gloss, grain = METAL.grain, seed = 11,
    taper = 1, ao = 1, em = 0, aoEdge = 0.55, tilt = 0, dark = 0,
  } = o;
  const H = max(1, y1 - y0);
  for (let y = y0; y <= y1; y += ST) {
    const t = (y - y0) / H;
    const rr = r * lerp(1, taper, t);
    const off = tilt * (t - 0.5) * H;
    const c0 = cx + off;
    for (let i = -ceil(rr); i <= ceil(rr); i += ST) {
      const u = i / rr;
      if (abs(u) > 1) continue;
      const nz = sqrt(max(0.02, 1 - u * u));
      const shadeAO = ao * lerp(1, aoEdge, pow(clamp(-u, 0, 1), 1.4));
      const c = grainy(shade(col, 1 - dark), c0 + i, y, seed, grain);
      put(cv, c0 + i, y, c, u, 0, nz, shadeAO, gloss, em);
    }
  }
}

/** Horizontal cylinder (breech drums, cross bars, shells). */
function cylinderH(cv, x0, x1, cy, r, o = {}) {
  const {
    col = METAL.base, gloss = METAL.gloss, grain = METAL.grain, seed = 13,
    taper = 1, ao = 1, em = 0, aoEdge = 0.6, dark = 0,
  } = o;
  const W = max(1, x1 - x0);
  for (let x = x0; x <= x1; x += ST) {
    const t = (x - x0) / W;
    const rr = r * lerp(1, taper, t);
    for (let j = -ceil(rr); j <= ceil(rr); j += ST) {
      const u = j / rr;
      if (abs(u) > 1) continue;
      const nz = sqrt(max(0.02, 1 - u * u));
      const shadeAO = ao * lerp(1, aoEdge, pow(clamp(u, 0, 1), 1.4));
      const c = grainy(shade(col, 1 - dark), x, cy + j, seed, grain);
      put(cv, x, cy + j, c, 0, u, nz, shadeAO, gloss, em);
    }
  }
}

/**
 * Capsule with round caps and cylindrical shading - the workhorse for fingers,
 * wires, struts and shell casings. `shader(t,u,x,y)` may return an albedo.
 */
function capsule(cv, x0, y0, x1, y1, r0, r1, o = {}) {
  const {
    col = METAL.base, gloss = METAL.gloss, grain = 0.06, seed = 17,
    ao = 1, em = 0, shader = null, aoEdge = 0.62,
  } = o;
  const dx = x1 - x0, dy = y1 - y0;
  const len2 = dx * dx + dy * dy || 1e-6;
  const len = sqrt(len2);
  const ax = dx / len, ay = dy / len;
  const px_ = -ay, py_ = ax; // perpendicular
  const rmax = max(r0, r1) + 1;
  const bx0 = floor(min(x0, x1) - rmax), bx1 = ceil(max(x0, x1) + rmax);
  const by0 = floor(min(y0, y1) - rmax), by1 = ceil(max(y0, y1) + rmax);
  for (let y = by0; y <= by1; y += ST) {
    for (let x = bx0; x <= bx1; x += ST) {
      const vx = x - x0, vy = y - y0;
      let t = (vx * dx + vy * dy) / len2;
      const tc = clamp(t, 0, 1);
      const cxp = x0 + dx * tc, cyp = y0 + dy * tc;
      const ox = x - cxp, oy = y - cyp;
      const d = sqrt(ox * ox + oy * oy);
      const rr = lerp(r0, r1, tc);
      if (d > rr) continue;
      let nx, ny, nz;
      if (t < 0 || t > 1) {
        nx = ox / rr; ny = oy / rr;
        nz = sqrt(max(0.03, 1 - nx * nx - ny * ny));
      } else {
        const u = (ox * px_ + oy * py_) / rr;
        nz = sqrt(max(0.03, 1 - u * u));
        nx = px_ * u; ny = py_ * u;
      }
      const u = (ox * px_ + oy * py_) / rr;
      const c0 = shader ? shader(tc, u, x, y) : col;
      if (!c0) continue;
      const c = grain > 0 ? grainy(c0, x, y, seed, grain) : c0;
      const a = ao * lerp(1, aoEdge, pow(clamp(u * 0.5 + (ny > 0 ? ny : 0) * 0.7, 0, 1), 1.3));
      put(cv, x, y, c, nx, ny, nz, a, gloss, em);
    }
  }
}

/** Sphere / dome blob with correct normals. Knuckles, rivets, thumbs, domes. */
function blob(cv, cx, cy, r, o = {}) {
  const {
    col = METAL.base, gloss = METAL.gloss, grain = 0.06, seed = 19,
    ao = 1, em = 0, flat = 1, shader = null, squashY = 1,
  } = o;
  const R = ceil(r) + 1;
  for (let j = -R; j <= R; j += ST) {
    for (let i = -R; i <= R; i += ST) {
      const u = i / r, v = (j / r) / squashY;
      const d2 = u * u + v * v;
      if (d2 > 1) continue;
      const nz = sqrt(max(0.03, 1 - d2)) / flat;
      const c0 = shader ? shader(u, v, cx + i, cy + j) : col;
      if (!c0) continue;
      const c = grain > 0 ? grainy(c0, cx + i, cy + j, seed, grain) : c0;
      put(cv, cx + i, cy + j, c, u, v, nz, ao, gloss, em);
    }
  }
}

/**
 * Torus / ring band, shaded as a tube bent into a circle. Fuse dials, the Halo
 * aperture, muzzle crowns, shell rims.
 */
function ringTube(cv, cx, cy, R, tube, o = {}) {
  const {
    col = METAL.base, gloss = METAL.gloss, grain = 0.08, seed = 23,
    ao = 1, em = 0, a0 = 0, a1 = TAU, squashY = 1, shader = null,
  } = o;
  const outer = ceil(R + tube + 1);
  for (let j = -outer; j <= outer; j += ST) {
    for (let i = -outer; i <= outer; i += ST) {
      const yy = j / squashY;
      const d = sqrt(i * i + yy * yy);
      const off = d - R;
      if (abs(off) > tube) continue;
      let ang = atan2(yy, i);
      if (ang < 0) ang += TAU;
      if (a1 - a0 < TAU - 1e-6) {
        let rel = ang - a0; while (rel < 0) rel += TAU; while (rel >= TAU) rel -= TAU;
        if (rel > a1 - a0) continue;
      }
      const u = off / tube;
      const nz = sqrt(max(0.03, 1 - u * u));
      const dirx = d > 0.001 ? i / d : 1, diry = d > 0.001 ? yy / d : 0;
      const c0 = shader ? shader(ang, u, cx + i, cy + j) : col;
      if (!c0) continue;
      const c = grain > 0 ? grainy(c0, cx + i, cy + j, seed, grain) : c0;
      put(cv, cx + i, cy + j, c, dirx * u, diry * u, nz, ao, gloss, em);
    }
  }
}

/** Filled ellipse with flat-ish normals; for plates, cheeks, silhouettes. */
function ellipseFill(cv, cx, cy, rx, ry, o = {}) {
  const { col = METAL.base, gloss = 0.2, grain = 0.05, seed = 29, ao = 1, em = 0, bulge = 0.6, shader = null } = o;
  for (let j = -ceil(ry); j <= ceil(ry); j += ST) {
    for (let i = -ceil(rx); i <= ceil(rx); i += ST) {
      const u = i / rx, v = j / ry;
      const d2 = u * u + v * v;
      if (d2 > 1) continue;
      const nz = sqrt(max(0.05, 1 - d2 * bulge * bulge));
      const c0 = shader ? shader(u, v, cx + i, cy + j) : col;
      if (!c0) continue;
      put(cv, cx + i, cy + j, grain > 0 ? grainy(c0, cx + i, cy + j, seed, grain) : c0,
        u * bulge, v * bulge, nz, ao, gloss, em);
    }
  }
}

/** Rivet: a tiny dome plus a contact shadow ring. */
function rivet(cv, x, y, r = 1.6, col = rgba(150, 150, 158, 255)) {
  blob(cv, x, y, r, { col, gloss: 0.62, grain: 0.05, seed: 31 });
  for (let a = 0; a < TAU; a += 0.5) occlude(cv, x + cos(a) * (r + 1), y + sin(a) * (r + 1), 0.78);
}

/** Scratch / wear pass: brighten random short strokes on an existing surface. */
function scuff(cv, x, y, w, h, seed, n = 20, amt = 0.5, gl = 0.75) {
  const rng = makeRng(seed);
  for (let k = 0; k < n; k++) {
    const sx = x + rng() * w, sy = y + rng() * h;
    const a = rng() * PI - PI / 2;
    const len = 2 + rng() * 9;
    const bright = rng() < 0.72;
    for (let i = 0; i < len; i += ST) {
      const px_ = sx + cos(a) * i, py_ = sy + sin(a) * i;
      const ix = MPX(px_), iy = MPY(py_);
      if (ix < 0 || iy < 0 || ix >= cv.w || iy >= cv.h) continue;
      const idx = iy * cv.w + ix;
      if (!(cv.data[idx] >>> 24)) continue;
      cv.data[idx] = shade(cv.data[idx], bright ? 1 + amt : 1 - amt * 0.75);
      if (bright) cv.gl[idx] = min(1, cv.gl[idx] + gl * 0.35);
    }
  }
}

/** Soot / grime blotches driven by fbm. Keeps normals, darkens albedo. */
function soot(cv, x, y, w, h, seed, amt = 0.45, scale = 11) {
  for (let j = 0; j < h; j += ST) {
    for (let i = 0; i < w; i += ST) {
      const n = fbm(seed, (x + i) / scale, (y + j) / scale, 3, 8);
      const k = smoothstep(0.52, 0.86, n) * amt;
      if (k > 0.02) tint(cv, x + i, y + j, rgba(26, 22, 22, 255), k);
    }
  }
}

/** Occlude a list of points once each - repeated hits would crush to black. */
function occludePath(cv, pts, amt) {
  const seen = new Set();
  for (const [x, y] of pts) {
    const k = MPY(y) * cv.w + MPX(x);
    if (seen.has(k)) continue;
    seen.add(k);
    occlude(cv, x, y, amt);
  }
}

/** Dark contact line under a shape - cheap, very effective for depth. */
function underShadow(cv, x0, x1, y, depth = 3, strength = 0.55) {
  for (let x = x0; x <= x1; x += ST) {
    for (let d = 0; d < depth; d += ST) {
      occlude(cv, x, y + d, lerp(1 - strength, 1, d / depth));
    }
  }
}

/** Add a dark silhouette rim so the model separates from the world behind it. */
function rimOutline(frame, c = rgba(9, 7, 10, 255)) { return outline(frame, c); }


// ---------------------------------------------------------------------------
// pose transform: draw in model space, then translate + rotate exactly
// ---------------------------------------------------------------------------

/**
 * Inverse-mapped rigid transform of every surface channel. Rotating after the
 * fact (rather than rotating each painter) keeps the geometry gap-free and
 * rotates the normals too, so recoil never breaks the lighting.
 */
function poseCv(src, ang, pivotX, pivotY, dx, dy) {
  if (!ang && !dx && !dy) return src;
  const dst = makeCv(src.w, src.h);
  const ci = cos(-ang), si = sin(-ang);
  const cf = cos(ang), sf = sin(ang);
  for (let y = 0; y < dst.h; y++) {
    for (let x = 0; x < dst.w; x++) {
      const ux = x - dx - pivotX, uy = y - dy - pivotY;
      const rx = pivotX + ux * ci - uy * si;
      const ry = pivotY + ux * si + uy * ci;
      const sx = Math.round(rx), sy = Math.round(ry);
      if (sx < 0 || sy < 0 || sx >= src.w || sy >= src.h) continue;
      const si2 = sy * src.w + sx;
      const c = src.data[si2];
      if (!(c >>> 24)) continue;
      const di = y * dst.w + x;
      dst.data[di] = c;
      const nx = src.nx[si2], ny = src.ny[si2];
      dst.nx[di] = nx * cf - ny * sf;
      dst.ny[di] = nx * sf + ny * cf;
      dst.nz[di] = src.nz[si2];
      dst.ao[di] = src.ao[si2];
      dst.gl[di] = src.gl[si2];
      dst.em[di] = src.em[si2];
    }
  }
  return dst;
}

// ---------------------------------------------------------------------------
// 3x5 stencil font - painted unit markings make hardware look issued, not drawn
// ---------------------------------------------------------------------------

const FONT35 = {
  A: [2, 5, 7, 5, 5], B: [6, 5, 6, 5, 6], C: [3, 4, 4, 4, 3], D: [6, 5, 5, 5, 6],
  E: [7, 4, 6, 4, 7], F: [7, 4, 6, 4, 4], G: [3, 4, 5, 5, 3], H: [5, 5, 7, 5, 5],
  I: [7, 2, 2, 2, 7], J: [1, 1, 1, 5, 2], K: [5, 5, 6, 5, 5], L: [4, 4, 4, 4, 7],
  M: [5, 7, 7, 5, 5], N: [5, 7, 7, 7, 5], O: [2, 5, 5, 5, 2], P: [6, 5, 6, 4, 4],
  Q: [2, 5, 5, 7, 3], R: [6, 5, 6, 5, 5], S: [3, 4, 2, 1, 6], T: [7, 2, 2, 2, 2],
  U: [5, 5, 5, 5, 7], V: [5, 5, 5, 5, 2], W: [5, 5, 7, 7, 5], X: [5, 5, 2, 5, 5],
  Y: [5, 5, 2, 2, 2], Z: [7, 1, 2, 4, 7],
  0: [7, 5, 5, 5, 7], 1: [2, 6, 2, 2, 7], 2: [7, 1, 7, 4, 7], 3: [7, 1, 3, 1, 7],
  4: [5, 5, 7, 1, 1], 5: [7, 4, 7, 1, 7], 6: [7, 4, 7, 5, 7], 7: [7, 1, 1, 1, 1],
  8: [7, 5, 7, 5, 7], 9: [7, 5, 7, 1, 7],
  '-': [0, 0, 7, 0, 0], '.': [0, 0, 0, 0, 2], '/': [1, 1, 2, 4, 4], ' ': [0, 0, 0, 0, 0],
  '*': [5, 2, 7, 2, 5], '!': [2, 2, 2, 0, 2], '+': [0, 2, 7, 2, 0], ':': [0, 2, 0, 2, 0],
};

/** Stencil text painted onto an existing surface (albedo only, keeps normals). */
function stencil(cv, text, x, y, col, amt = 0.9, sx = 1, sy = 1) {
  let cx = x;
  for (const ch of text.toUpperCase()) {
    const g = FONT35[ch] || FONT35[' '];
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 3; c++) {
        if (!(g[r] & (4 >> c))) continue;
        for (let jj = 0; jj < sy; jj += ST) for (let ii = 0; ii < sx; ii += ST) {
          tint(cv, cx + c * sx + ii, y + r * sy + jj, col, amt);
        }
      }
    }
    cx += 4 * sx;
  }
  return cx;
}

function stencilWidth(text, sx = 1) { return text.length * 4 * sx - sx; }

// ---------------------------------------------------------------------------
// the glove - one painter, five weapons
// ---------------------------------------------------------------------------

const LEATHER = {
  deep: rgba(41, 28, 23, 255),
  base: rgba(84, 58, 43, 255),
  mid: rgba(108, 77, 55, 255),
  worn: rgba(158, 121, 85, 255),
  hi: rgba(196, 160, 116, 255),
  stitch: rgba(186, 162, 118, 255),
  cuff: rgba(62, 50, 42, 255),
  strap: rgba(50, 40, 34, 255),
};

/** Albedo shader for leather: fbm grain, worn crest along the tube's lit side. */
function leatherShader(seed, o = {}) {
  const { wear = 0.55, tone = 0, dark = 0 } = o;
  const base = shade(mix(LEATHER.base, LEATHER.mid, tone), 1 - dark);
  const deep = shade(LEATHER.deep, 1 - dark * 0.5);
  return (t, u, x, y) => {
    const n = fbm(seed, x / 4.6, y / 4.6, 2, 8);
    const n2 = fbm(seed + 51, x / 11.0, y / 11.0, 2, 8);
    let c = mix(deep, base, clamp(0.30 + n * 0.85, 0, 1));
    c = shade(c, 0.92 + n2 * 0.18);
    // worn crest along the lit side of each tube
    const crest = pow(max(0, 1 - abs(u + 0.30) * 1.5), 2.2);
    c = mix(c, LEATHER.worn, crest * wear * (0.34 + n * 0.42));
    const h = hash2(x, y, seed);
    if (h > 0.972) c = shade(c, 0.84);
    else if (h < 0.020) c = shade(c, 1.12);
    return c;
  };
}

/** Local->canvas transform for a hand pose (mirror, scale, rotate, translate). */
function handT(p) {
  const c = cos(p.ang), s = sin(p.ang), f = p.flip || 1, k = p.scale || 1;
  return (lx, ly) => {
    const X = lx * k * f, Y = ly * k;
    return [p.x + X * c - Y * s, p.y + X * s + Y * c];
  };
}

const GRIP_PRESETS = {
  // fingers wrapped around a vertical grip, back of hand to the viewer
  wrap: { curl: 0.92, spread: 0.0, thumb: 'over', palm: [20, 22], reach: 21 },
  // supporting hand under a forend
  fore: { curl: 0.86, spread: 0.05, thumb: 'side', palm: [19, 21], reach: 21.5 },
  // fingers curled away, thumb up on a button
  flat: { curl: 1.12, spread: 0.0, thumb: 'up', palm: [20, 21], reach: 19 },
  // index + thumb pinching a shell
  pinch: { curl: 1.02, spread: 0.0, thumb: 'pinch', palm: [18, 20], reach: 20 },
  // finger on a trigger, rest wrapped
  trigger: { curl: 0.90, spread: 0.02, thumb: 'over', palm: [20, 22], reach: 21 },
  // fingers thrown open - the instant a thrown thing leaves the hand
  open: { curl: 0.10, spread: 0.16, thumb: 'side', palm: [20, 22], reach: 23 },
};

/**
 * drawGlove - heavy scorched leather work glove. One painter, reused by every
 * weapon so the hands never disagree with each other.
 *
 * pose: { x, y, ang, scale, flip, grip, seed, wear, cuff, curlBias, sleeve }
 */
function drawGlove(cv, pose) {
  const p = Object.assign({
    x: 100, y: 120, ang: 0, scale: 1, flip: 1, grip: 'wrap',
    seed: 404, wear: 0.55, cuff: true, curlBias: 0, sleeve: 1, dark: 0,
    fingerTint: 0,
  }, pose);
  const G = GRIP_PRESETS[p.grip] || GRIP_PRESETS.wrap;
  const T = handT(p);
  const k = p.scale || 1;
  const S = leatherShader(p.seed, { wear: p.wear, tone: p.fingerTint, dark: p.dark });
  const Sd = leatherShader(p.seed + 7, { wear: p.wear * 0.5, tone: 0, dark: p.dark + 0.18 });
  const gloss = 0.20;
  const curl = clamp(G.curl + p.curlBias, 0, 1.15);

  const cap = (x0, y0, x1, y1, r0, r1, sh, o = {}) => {
    const A = T(x0, y0), B = T(x1, y1);
    capsule(cv, A[0], A[1], B[0], B[1], r0 * k, r1 * k,
      Object.assign({ shader: sh, gloss, grain: 0, seed: p.seed, aoEdge: 0.55 }, o));
  };
  const bl = (x, y, r, sh, o = {}) => {
    const A = T(x, y);
    blob(cv, A[0], A[1], r * k, Object.assign({ shader: sh, gloss, grain: 0, seed: p.seed }, o));
  };

  // --- forearm / sleeve, running off the bottom of the frame ---
  if (p.sleeve) {
    cap(-9, 2, -34, 12 * p.sleeve, 10.5, 12.5, Sd, { aoEdge: 0.45 });
  }

  // --- cuff: a wide banded gauntlet with a strap ---
  if (p.cuff) {
    cap(-6, 1, -18, 5, 11.2, 11.8, (t, u, x, y) => {
      const n = fbm(p.seed + 3, x / 4, y / 4, 3, 8);
      let c = mix(LEATHER.deep, LEATHER.cuff, clamp(0.2 + n * 1.4, 0, 1));
      c = mix(c, LEATHER.worn, pow(max(0, 1 - abs(u + 0.3) * 1.7), 3) * 0.35);
      return shade(c, 1 - p.dark);
    }, { gloss: 0.24 });
    // strap + buckle
    const s0 = T(-13, -10), s1 = T(-13, 10);
    capsule(cv, s0[0], s0[1], s1[0], s1[1], 2.3 * k, 2.3 * k,
      { col: shade(LEATHER.strap, 1 - p.dark), gloss: 0.3, grain: 0.08, seed: p.seed + 9 });
    const bk = T(-13, -2);
    metalPanelRot(cv, bk[0], bk[1], 5 * k, 4 * k, p.ang,
      { col: rgba(122, 116, 104, 255), gloss: 0.6, seed: p.seed + 11 });
  }

  // --- palm / back of hand ---
  const [pw, ph] = G.palm;
  cap(-6, -ph * 0.20, 3, 0.4, ph * 0.48, ph * 0.52, S, { aoEdge: 0.46 });
  // the knuckle block the fingers hang off
  cap(2.5, -ph * 0.34, 5.6, ph * 0.30, ph * 0.46, ph * 0.42, S, { aoEdge: 0.46 });

  // --- fingers ---
  // Each digit is three jointed capsules on an arc, so the silhouette curls
  // around whatever is being held instead of reading as a row of beads.
  const FING = [
    { y: -6.9, r: 3.30, len: 0.98, tone: 0.06, bend: 0.94 },
    { y: -2.3, r: 3.50, len: 1.08, tone: 0.00, bend: 1.00 },
    { y: 2.3, r: 3.30, len: 1.02, tone: 0.03, bend: 1.04 },
    { y: 6.6, r: 2.85, len: 0.86, tone: 0.09, bend: 1.10 },
  ];
  const reach = G.reach;
  const joints = [];
  for (let i = 0; i < 4; i++) {
    const f = FING[i];
    const fy = f.y * (1 + G.spread * 1.5);
    const L = reach * f.len;
    const sh = leatherShader(p.seed + i * 13,
      { wear: p.wear * (0.85 + i * 0.06), tone: f.tone, dark: p.dark + i * 0.03 });
    // walk the digit around an arc: each joint bends a little further
    let x = 5.4, y = fy, a = -0.10 + G.spread * 0.3;
    const segs = [[0.40, 1.00, 0.94], [0.34, 0.94, 0.84], [0.26, 0.84, 0.70]];
    const bends = [0.62, 0.72, 0.66];
    const pts = [[x, y]];
    for (let sgi = 0; sgi < 3; sgi++) {
      const [fl, r0k, r1k] = segs[sgi];
      const nx2 = x + cos(a) * L * fl, ny2 = y + sin(a) * L * fl;
      cap(x, y, nx2, ny2, f.r * r0k, f.r * r1k, sh, { aoEdge: 0.46 });
      x = nx2; y = ny2; a += curl * bends[sgi] * f.bend;
      pts.push([x, y]);
    }
    joints.push({ pts, r: f.r, sh, fy });
  }
  // knuckle ridge: worn leather highlight on the back of the hand, plus the
  // joint creases and the dark gaps that separate one finger from the next.
  for (let i = 0; i < 4; i++) {
    const J = joints[i];
    for (let k = 1; k <= 2; k++) {
      const [jx, jy] = J.pts[k];
      const crease = [];
      for (let t = -1; t <= 1; t += 0.10) {
        const A = T(jx, jy + t * J.r * 0.92);
        tint(cv, A[0], A[1], LEATHER.deep, 0.42);
        crease.push(A);
      }
      occludePath(cv, crease, 0.76);
    }
    // highlight along the top (light side) of the proximal segment
    const [ax, ay] = J.pts[0], [bx2, by2] = J.pts[1];
    for (let t = 0.05; t <= 1; t += 0.06) {
      const hx = lerp(ax, bx2, t), hy = lerp(ay, by2, t) - J.r * 0.62;
      const A = T(hx, hy);
      tint(cv, A[0], A[1], LEATHER.worn, 0.34 * p.wear + 0.18);
      const B = T(hx, hy - 0.9);
      tint(cv, B[0], B[1], LEATHER.hi, 0.22 * p.wear);
    }
    // shadow groove down to the next finger
    if (i < 3) {
      const gy = (FING[i].y + FING[i + 1].y) * 0.5 * (1 + G.spread * 1.5);
      const groove = [];
      for (let t = 0; t <= 1; t += 0.045) {
        const gx = lerp(3.5, J.pts[2][0], t);
        const yy = lerp(gy, (J.pts[2][1] + joints[i + 1].pts[2][1]) * 0.5, t);
        const A = T(gx, yy);
        tint(cv, A[0], A[1], LEATHER.deep, 0.5);
        groove.push(A);
      }
      occludePath(cv, groove, 0.62);
    }
  }

  // --- thumb ---
  // `thumbTo` is a bit of rigging: aim the thumb tip at a canvas position so a
  // hand can actually reach the thing it is meant to be pressing.
  const shT = leatherShader(p.seed + 77, { wear: p.wear, dark: p.dark });
  if (p.thumbTo) {
    const ci = cos(-p.ang), si2 = sin(-p.ang), f = p.flip || 1;
    const vx = (p.thumbTo[0] - p.x) / k, vy = (p.thumbTo[1] - p.y) / k;
    const tx = (vx * ci - vy * si2) / f, ty = vx * si2 + vy * ci;
    const bx = 0.5, by = -8.0;
    const mx2 = lerp(bx, tx, 0.52) + (ty < by ? 2.4 : -2.4);
    const my2 = lerp(by, ty, 0.52) - 2.0;
    cap(bx, by, mx2, my2, 4.4, 3.9, shT);
    cap(mx2, my2, tx, ty, 3.9, 3.3, shT);
    bl(mx2, my2, 4.0, shT, { gloss: 0.28 });
    bl(tx, ty, 3.3, shT, { gloss: 0.30 });
  } else if (G.thumb === 'over') {
    cap(0.5, -8.5, 8.5, -12.0, 3.7, 3.2, shT);
    cap(8.5, -12.0, 15.0, -11.0, 3.2, 2.7, shT);
    bl(8.6, -12.0, 3.5, shT, { gloss: 0.28 });
  } else if (G.thumb === 'up') {
    cap(0.5, -8.0, 9.0, -13.5, 3.7, 3.2, shT);
    cap(9.0, -13.5, 17.5, -16.5, 3.2, 2.8, shT);
    bl(9.1, -13.5, 3.5, shT, { gloss: 0.28 });
  } else if (G.thumb === 'pinch') {
    cap(1.0, -8.0, 9.5, -10.0, 3.6, 3.0, shT);
    cap(9.5, -10.0, 16.0, -5.5, 3.0, 2.6, shT);
    bl(9.6, -10.0, 3.3, shT, { gloss: 0.28 });
  } else {
    cap(0.5, -8.0, 7.5, -13.0, 3.7, 3.1, shT);
    cap(7.5, -13.0, 12.5, -16.0, 3.1, 2.6, shT);
    bl(7.6, -13.0, 3.4, shT, { gloss: 0.28 });
  }

  // --- stitching along the finger seams and the cuff edge ---
  const stitchLine = (x0, y0, x1, y1, step = 2.2) => {
    const n = max(2, hypot(x1 - x0, y1 - y0) / step);
    for (let i = 0; i <= n; i++) {
      if (i % 2) continue;
      const A = T(lerp(x0, x1, i / n), lerp(y0, y1, i / n));
      tint(cv, A[0], A[1], LEATHER.stitch, 0.72);
    }
  };
  stitchLine(-6.5, -9.5, 6.5, -9.0);
  stitchLine(-6.5, 9.5, 6.5, 9.2);
  stitchLine(-1, -9.0, -1, 9.0, 2.6);
  if (p.cuff) { stitchLine(-7.5, -10.5, -7.5, 10.5, 2.4); stitchLine(-17, -9.5, -17, 9.5, 2.4); }

  // --- scorch marks: these gloves have been near a lot of muzzle blast ---
  const B = T(2, 0);
  soot(cv, B[0] - 26 * k, B[1] - 24 * k, 52 * k, 48 * k, p.seed + 300, 0.40 * (0.4 + p.wear), 9);
}

/** Small axis-aligned-ish panel that respects a rotation (used by the buckle). */
function metalPanelRot(cv, cx, cy, w, h, ang, o = {}) {
  const c = cos(ang), s = sin(ang);
  const { col = METAL.base, gloss = 0.5, seed = 3 } = o;
  const st2 = min(0.5, ST * 0.5);
  for (let j = -h / 2; j <= h / 2; j += st2) {
    for (let i = -w / 2; i <= w / 2; i += st2) {
      const x = cx + i * c - j * s, y = cy + i * s + j * c;
      const eu = abs(i) / (w / 2), ev = abs(j) / (h / 2);
      const nx = (i < 0 ? -1 : 1) * pow(eu, 6) * 0.7, ny = (j < 0 ? -1 : 1) * pow(ev, 6) * 0.7;
      put(cv, x, y, grainy(col, x, y, seed, 0.09), nx * c - ny * s, nx * s + ny * c,
        sqrt(max(0.05, 1 - nx * nx - ny * ny)), 1, gloss, 0);
    }
  }
}

// ---------------------------------------------------------------------------
// shared hardware parts
// ---------------------------------------------------------------------------

/** Copy every surface channel of src over dst wherever src has coverage. */
function compositeCv(dst, src) {
  for (let i = 0; i < src.data.length; i++) {
    if (!(src.data[i] >>> 24)) continue;
    dst.data[i] = src.data[i];
    dst.nx[i] = src.nx[i]; dst.ny[i] = src.ny[i]; dst.nz[i] = src.nz[i];
    dst.ao[i] = src.ao[i]; dst.gl[i] = src.gl[i]; dst.em[i] = src.em[i];
  }
  return dst;
}

const STEEL = rgba(142, 146, 156, 255);
const STEEL_D = rgba(92, 95, 105, 255);
const STEEL_B = rgba(196, 200, 210, 255);
const GUNMETAL = rgba(96, 99, 112, 255);
const GUNMETAL_D = rgba(60, 62, 74, 255);
const BRASS = rgba(186, 146, 66, 255);
const BRASS_D = rgba(126, 94, 38, 255);
const BRASS_B = rgba(232, 198, 112, 255);
const COPPER = rgba(178, 106, 58, 255);
const WOOD = rgba(140, 88, 46, 255);
const WOOD_D = rgba(82, 48, 26, 255);
const RUST = rgba(122, 66, 36, 255);
const HAZ_Y = rgba(206, 168, 44, 255);
// Each weapon gets its own alloy so the player can tell them apart in a glance.
const BLUED = rgba(76, 82, 102, 255);       // Widow: cold blued steel
const BLUED_D = rgba(52, 57, 74, 255);
const OLIVE = rgba(94, 98, 70, 255);        // Splitter: chipped olive drab
const OLIVE_D = rgba(60, 64, 44, 255);
const INDY = rgba(150, 120, 46, 255);       // Naildriver: faded plant yellow
const INDY_D = rgba(98, 78, 30, 255);
const CHAR = rgba(66, 68, 80, 255);         // Halo: anodised charcoal
const CHAR_D = rgba(42, 44, 54, 255);
const ALUM = rgba(146, 148, 154, 255);      // Deadman: scuffed aluminium
const ALUM_D = rgba(104, 106, 114, 255);
const CYAN = rgba(120, 236, 255, 255);
const CYAN_D = rgba(30, 118, 152, 255);

/**
 * A muzzle opening seen foreshortened: dark bore, bright crown ring, a hint of
 * rifling. `sq` squashes the ellipse (1 = head-on, 0.3 = steeply away).
 */
function boreEllipse(cv, cx, cy, r, sq, o = {}) {
  const { crown = STEEL_B, bore = rgba(16, 14, 16, 255), rings = 3, glow = 0, glowCol = hotColor(0.25) } = o;
  ringTube(cv, cx, cy, r * 0.86, r * 0.30, {
    squashY: sq, gloss: 0.72, grain: 0.09, seed: 41,
    shader: (a, u) => mix(shade(crown, 0.72), crown, clamp(0.5 - cos(a) * 0.45 - u * 0.35, 0, 1)),
  });
  // recessed bore
  for (let j = -ceil(r * sq); j <= ceil(r * sq); j += ST) {
    for (let i = -ceil(r); i <= ceil(r); i += ST) {
      const u = i / (r * 0.72), v = (j / sq) / (r * 0.72);
      const d = hypot(u, v);
      if (d > 1) continue;
      let c = mix(shade(bore, 0.55), shade(bore, 2.2), pow(clamp(v * 0.5 + 0.5, 0, 1), 1.4));
      if (rings) {
        const a = atan2(v, u);
        const rk = 0.5 + 0.5 * cos(a * rings * 2);
        c = shade(c, 0.8 + rk * 0.5);
      }
      if (glow > 0) c = mix(c, glowCol, glow * pow(1 - d, 1.5));
      put(cv, cx + i, cy + j, c, u * 0.25, v * 0.25, 1, 0.42 + 0.4 * (1 - d), 0.2, glow * 0.9);
    }
  }
}

/** Cooling vents / cut slots. `glow` lights them from inside (hot barrel). */
function ventSlots(cv, cx, y0, y1, halfW, count, o = {}) {
  const { glow = 0, w = 3, col = rgba(20, 18, 20, 255), curve = 1 } = o;
  const H = y1 - y0;
  for (let k = 0; k < count; k++) {
    const t = (k + 0.5) / count;
    const y = y0 + t * H;
    const bulge = curve ? sqrt(max(0, 1 - pow((t - 0.5) * 2, 2))) : 1;
    const hw = halfW * (0.42 + 0.58 * bulge);
    for (let j = 0; j < w; j += ST) {
      for (let i = -hw; i <= hw; i += ST) {
        const u = i / hw;
        const nz = sqrt(max(0.05, 1 - u * u));
        const deep = 1 - abs(j - (w - 1) / 2) / max(0.5, w / 2);
        let c = shade(col, 0.6 + 0.7 * (1 - deep));
        let em = 0;
        if (glow > 0) {
          const heat = glow * (0.45 + 0.55 * deep) * (0.55 + 0.45 * sqrt(max(0, 1 - u * u)));
          c = mix(c, hotColor(clamp(0.30 - heat * 0.22, 0, 1)), clamp(heat, 0, 1));
          em = clamp(heat * 1.05, 0, 1);
        }
        put(cv, cx + i, y + j, c, u * 0.5, 0, nz, 0.30 + 0.4 * (1 - deep), 0.12, em);
      }
    }
    // lip highlight above each slot
    for (let i = -hw; i <= hw; i += ST) {
      const u = i / hw;
      occlude(cv, cx + i, y - 1, 0.72);
      put(cv, cx + i, y + w, mix(STEEL_B, STEEL, 0.35), u * 0.7, 0.55, 0.6, 1, 0.55, 0);
    }
  }
}

/** Diagonal hazard stripes stencilled on a panel (albedo only). */
function hazardStripe(cv, x, y, w, h, o = {}) {
  const { pitch = 7, col = HAZ_Y, dark = rgba(26, 22, 18, 255), amt = 0.85, wear = 0.5 } = o;
  for (let j = 0; j < h; j += ST) {
    for (let i = 0; i < w; i += ST) {
      const s = ((i + j) % pitch) / pitch;
      const c = s < 0.5 ? col : dark;
      const worn = fbm(919, (x + i) / 5, (y + j) / 5, 3, 8);
      const a = amt * clamp(1 - wear * smoothstep(0.48, 0.9, worn) * 1.5, 0, 1);
      tint(cv, x + i, y + j, c, a);
    }
  }
}

/** A stubby flak shell: brass case, coloured band, rounded nose. */
function shellRound(cv, x0, y0, x1, y1, r, o = {}) {
  const { band = rgba(150, 52, 40, 255), spent = 0, seed = 55 } = o;
  const ang = atan2(y1 - y0, x1 - x0);
  const nx = cos(ang), ny = sin(ang);
  capsule(cv, x0, y0, x1 - nx * r * 0.5, y1 - ny * r * 0.5, r, r * 0.92, {
    gloss: 0.66, grain: 0.07, seed,
    shader: (t, u) => {
      const base = spent ? mix(BRASS_D, rgba(96, 78, 46, 255), 0.5) : BRASS;
      let c = mix(shade(base, 0.62), mix(base, BRASS_B, 0.35), clamp(0.5 - u * 0.8, 0, 1));
      if (t > 0.34 && t < 0.66) c = mix(c, band, 0.86);
      if (t < 0.16) c = mix(c, shade(base, 0.75), 0.8);       // rim
      return c;
    },
  });
  // rim flange
  capsule(cv, x0 - nx * 0.5, y0 - ny * 0.5, x0 + nx * 1.6, y0 + ny * 1.6, r * 1.18, r * 1.12, {
    gloss: 0.75, grain: 0.06, seed: seed + 1,
    shader: (t, u) => mix(shade(BRASS_D, 0.8), BRASS_B, clamp(0.5 - u * 0.9, 0, 1)),
  });
  // primer dot
  blob(cv, x0 + nx * 0.4, y0 + ny * 0.4, r * 0.34, { col: shade(COPPER, 0.9), gloss: 0.5, grain: 0.05 });
}

/** Slot-head screw. */
function screwHead(cv, x, y, r, ang = 0.6, col = rgba(140, 142, 150, 255)) {
  blob(cv, x, y, r, { col, gloss: 0.68, grain: 0.06, seed: 63 });
  const dx = cos(ang) * r, dy = sin(ang) * r;
  for (let t = -1; t <= 1; t += 0.14) {
    tint(cv, x + dx * t, y + dy * t, shade(col, 0.42), 0.95);
    occlude(cv, x + dx * t, y + dy * t, 0.55);
  }
  for (let a = 0; a < TAU; a += 0.4) occlude(cv, x + cos(a) * (r + 1), y + sin(a) * (r + 1), 0.8);
}

/** Knurling / checkering on a grip surface. Albedo + micro normal jitter. */
function knurl(cv, x, y, w, h, pitch = 3, amt = 0.30) {
  for (let j = 0; j < h; j += ST) {
    for (let i = 0; i < w; i += ST) {
      const xx = x + i, yy = y + j;
      if (!cvHas(cv, xx, yy)) continue;
      const a = ((i + j) % pitch) / pitch, b = ((i - j + pitch * 8) % pitch) / pitch;
      const k = (a < 0.34 ? 1 : 0) + (b < 0.34 ? 1 : 0);
      const idx = MPY(yy) * cv.w + MPX(xx);
      if (k === 2) { cv.data[idx] = shade(cv.data[idx], 1 + amt); cv.ny[idx] -= 0.35; }
      else if (k === 0) { cv.data[idx] = shade(cv.data[idx], 1 - amt * 0.8); cv.ny[idx] += 0.30; }
      const l = hypot(cv.nx[idx], cv.ny[idx], cv.nz[idx]) || 1;
      cv.nx[idx] /= l; cv.ny[idx] /= l; cv.nz[idx] /= l;
    }
  }
}

/** Wood shader with long grain running along the capsule axis. */
function woodShader(seed, o = {}) {
  const { dark = 0 } = o;
  return (t, u, x, y) => {
    const g = fbm(seed, x / 2.2, y / 14, 3, 8);
    const rings = 0.5 + 0.5 * sin(g * 13 + x * 0.55);
    let c = mix(shade(WOOD_D, 1 - dark), shade(WOOD, 1 - dark), clamp(0.25 + rings * 0.9, 0, 1));
    c = shade(c, 0.86 + fbm(seed + 5, x / 7, y / 7, 2, 8) * 0.34);
    if (hash2(x, y, seed) > 0.965) c = shade(c, 0.66);     // dings
    return c;
  };
}

/** Segmented charge/ammo meter. `fill` 0..1, `n` cells. */
function meter(cv, x, y, w, h, n, fill, o = {}) {
  const { on = CYAN, off = rgba(28, 34, 40, 255), vert = false, gap = 1 } = o;
  metalPanel(cv, x - 2, y - 2, w + 4, h + 4, { col: GUNMETAL_D, gloss: 0.3, bevel: 2, seed: 71 });
  const cellW = vert ? w : (w - gap * (n - 1)) / n;
  const cellH = vert ? (h - gap * (n - 1)) / n : h;
  for (let k = 0; k < n; k++) {
    const lit = vert ? (n - 1 - k) < fill * n : k < fill * n;
    const cx = vert ? x : x + k * (cellW + gap);
    const cy = vert ? y + k * (cellH + gap) : y;
    const frac = clamp(fill * n - (vert ? (n - 1 - k) : k), 0, 1);
    const col = lit ? mix(shade(on, 0.55), on, frac) : off;
    for (let j = 0; j < cellH; j += ST) for (let i = 0; i < cellW; i += ST) {
      put(cv, cx + i, cy + j, col, 0, 0, 1, 1, 0.1, lit ? 0.55 + frac * 0.45 : 0.06);
    }
  }
}

/** Sling / bandolier strap: webbing with stitched edges along a bezier. */
function strapCurve(cv, pts, halfW, o = {}) {
  const { col = rgba(64, 58, 44, 255), seed = 83, steps = 90 } = o;
  const bez = (t) => {
    const n = pts.length - 1;
    let x = 0, y = 0;
    for (let i = 0; i <= n; i++) {
      const b = binom(n, i) * pow(1 - t, n - i) * pow(t, i);
      x += pts[i][0] * b; y += pts[i][1] * b;
    }
    return [x, y];
  };
  let prev = bez(0);
  for (let s = 1; s <= steps; s++) {
    const cur = bez(s / steps);
    capsule(cv, prev[0], prev[1], cur[0], cur[1], halfW, halfW, {
      gloss: 0.16, grain: 0.05, seed,
      shader: (t, u, x, y) => {
        const weave = ((x + y) % 3 === 0) ? 1.14 : 1;
        let c = shade(col, weave * (0.82 + fbm(seed, x / 4, y / 4, 3, 8) * 0.4));
        if (abs(u) > 0.72) c = shade(c, 0.7);
        return c;
      },
    });
    prev = cur;
  }
  return bez;
}

function binom(n, k) {
  let r = 1;
  for (let i = 0; i < k; i++) r = r * (n - i) / (i + 1);
  return r;
}

// ===========================================================================
// THE WEAPON KIT: a small perspective rasteriser for the viewmodels
// ===========================================================================
// The first generation of these guns was painted flat, and every one of them
// ended up staring down its own bore at the player. A first-person gun is a
// perspective problem: the grip is near and big, the muzzle is far and small,
// and the barrel runs away toward the crosshair. So the weapons are built as
// geometry (boxes, lofted tubes, spheres) in a camera space whose principal
// point IS the crosshair, rasterised into a small G-buffer, and then handed to
// the same deferred canvas and bake() light rig as everything else in this
// file. The painterly look comes from the material shaders, the ambient
// occlusion and the ink pass, not from the geometry being crude.
//
// Camera space: x right, y DOWN, z forward (away from the eye); centimetres.
// A frame is VW x VH and the crosshair sits at (CAM_CX, CAM_CY), near the
// top of it, so anything parallel to the view axis converges on the crosshair.

const VW = 384, VH = 192;
const CAM_F = 340, CAM_CX = 192, CAM_CY = 26;
const NEAR = 1.5;

let GB = null;
function gbuf() {
  if (!GB) {
    const n = VW * VH;
    GB = {
      iz: new Float32Array(n), pid: new Int32Array(n),
      u: new Float32Array(n), v: new Float32Array(n),
      nx: new Float32Array(n), ny: new Float32Array(n), nz: new Float32Array(n),
      ao: new Float32Array(n),
    };
  }
  return GB;
}

// --- 3x4 affine matrices, row-major. Rotations follow the y-down frame:
// mRX(+a) lifts the muzzle, mRY(+a) swings it right, mRZ(+a) rolls clockwise.
const M_ID = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
function mMul(A, B) {
  return [
    A[0] * B[0] + A[1] * B[4] + A[2] * B[8], A[0] * B[1] + A[1] * B[5] + A[2] * B[9],
    A[0] * B[2] + A[1] * B[6] + A[2] * B[10], A[0] * B[3] + A[1] * B[7] + A[2] * B[11] + A[3],
    A[4] * B[0] + A[5] * B[4] + A[6] * B[8], A[4] * B[1] + A[5] * B[5] + A[6] * B[9],
    A[4] * B[2] + A[5] * B[6] + A[6] * B[10], A[4] * B[3] + A[5] * B[7] + A[6] * B[11] + A[7],
    A[8] * B[0] + A[9] * B[4] + A[10] * B[8], A[8] * B[1] + A[9] * B[5] + A[10] * B[9],
    A[8] * B[2] + A[9] * B[6] + A[10] * B[10], A[8] * B[3] + A[9] * B[7] + A[10] * B[11] + A[11],
  ];
}
function mT(x, y, z) { return [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z]; }
function mRX(a) { const c = cos(a), s = sin(a); return [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0]; }
function mRY(a) { const c = cos(a), s = sin(a); return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0]; }
function mRZ(a) { const c = cos(a), s = sin(a); return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0]; }
/** Chain several matrices left to right. */
function mChain(...ms) { let M = M_ID; for (const m of ms) M = mMul(M, m); return M; }
/** Rotate about a pivot: T(p) R T(-p). */
function mAbout(px_, py_, pz, R) { return mChain(mT(px_, py_, pz), R, mT(-px_, -py_, -pz)); }
function mP(M, x, y, z) {
  return [M[0] * x + M[1] * y + M[2] * z + M[3], M[4] * x + M[5] * y + M[6] * z + M[7],
    M[8] * x + M[9] * y + M[10] * z + M[11]];
}
function mD(M, x, y, z) {
  return [M[0] * x + M[1] * y + M[2] * z, M[4] * x + M[5] * y + M[6] * z, M[8] * x + M[9] * y + M[10] * z];
}

// --- tiny vector helpers (build-time only, allocation is fine here) ---
const vAdd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const vSub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vMul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const vDot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vCross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const vLen = (a) => sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
const vNorm = (a) => { const l = vLen(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const vLerp = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
/** a + b*kb + c*kc + d*kd: point in a local basis. */
const vBasis = (o, a, ka, b, kb, c, kc) => [
  o[0] + a[0] * ka + b[0] * kb + c[0] * kc,
  o[1] + a[1] * ka + b[1] * kb + c[1] * kc,
  o[2] + a[2] * ka + b[2] * kb + c[2] * kc,
];

/** Camera space -> frame pixels. */
function proj(p) { return [CAM_CX + CAM_F * p[0] / p[2], CAM_CY + CAM_F * p[1] / p[2]]; }

function scene3() {
  const g = gbuf();
  g.iz.fill(0); g.pid.fill(-1);
  return { prims: [], M: M_ID, stack: [] };
}
function push3(sc, T) { sc.stack.push(sc.M); if (T) sc.M = mMul(sc.M, T); }
function pop3(sc) { sc.M = sc.stack.pop(); }
function prim3(sc, mat, extra) {
  const p = Object.assign({}, mat, extra);
  p.id = sc.prims.length;
  sc.prims.push(p);
  return p.id;
}

/**
 * Rasterise one camera-space triangle into the G-buffer. Vertices are
 * [x, y, z, nx, ny, nz, u, v]; attributes interpolate perspective-correct.
 * `bias` nudges depth so decal geometry can sit on a surface without fighting.
 */
function rtri(pid, A, B, C, cull, bias) {
  if (A[2] < NEAR || B[2] < NEAR || C[2] < NEAR) {
    // Clip against the near plane rather than dropping the triangle: a
    // forearm or a receiver can run right past the eye and off the frame.
    const inn = [A, B, C].filter((v) => v[2] >= NEAR);
    if (!inn.length) return;
    const poly = [];
    const V = [A, B, C];
    for (let i = 0; i < 3; i++) {
      const P = V[i], Q = V[(i + 1) % 3];
      const pin = P[2] >= NEAR, qin = Q[2] >= NEAR;
      if (pin) poly.push(P);
      if (pin !== qin) {
        const t = (NEAR - P[2]) / (Q[2] - P[2]);
        const R = new Array(8);
        for (let k = 0; k < 8; k++) R[k] = P[k] + (Q[k] - P[k]) * t;
        R[2] = NEAR;
        poly.push(R);
      }
    }
    for (let i = 1; i + 1 < poly.length; i++) rtri(pid, poly[0], poly[i], poly[i + 1], cull, bias);
    return;
  }
  if (cull && A[0] * A[3] + A[1] * A[4] + A[2] * A[5] > 0
    && B[0] * B[3] + B[1] * B[4] + B[2] * B[5] > 0
    && C[0] * C[3] + C[1] * C[4] + C[2] * C[5] > 0) return;
  const g = GB;
  const ia = 1 / A[2], ib = 1 / B[2], ic = 1 / C[2];
  const ax = CAM_CX + CAM_F * A[0] * ia, ay = CAM_CY + CAM_F * A[1] * ia;
  const bx = CAM_CX + CAM_F * B[0] * ib, by = CAM_CY + CAM_F * B[1] * ib;
  const cx = CAM_CX + CAM_F * C[0] * ic, cy = CAM_CY + CAM_F * C[1] * ic;
  const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  if (area > -1e-7 && area < 1e-7) return;
  const inv = 1 / area;
  const x0 = max(0, floor(min(ax, bx, cx))), x1 = min(VW - 1, ceil(max(ax, bx, cx)));
  const y0 = max(0, floor(min(ay, by, cy))), y1 = min(VH - 1, ceil(max(ay, by, cy)));
  const zb = 1 + (bias || 0);
  const E = -2e-4;
  for (let y = y0; y <= y1; y++) {
    const py = y + 0.5;
    for (let x = x0; x <= x1; x++) {
      const px_ = x + 0.5;
      const w0 = ((bx - px_) * (cy - py) - (by - py) * (cx - px_)) * inv;
      if (w0 < E) continue;
      const w1 = ((cx - px_) * (ay - py) - (cy - py) * (ax - px_)) * inv;
      if (w1 < E) continue;
      const w2 = 1 - w0 - w1;
      if (w2 < E) continue;
      const iz = w0 * ia + w1 * ib + w2 * ic;
      const i = y * VW + x;
      if (iz * zb <= g.iz[i]) continue;
      const k0 = w0 * ia / iz, k1 = w1 * ib / iz, k2 = w2 * ic / iz;
      g.iz[i] = iz * zb; g.pid[i] = pid;
      g.nx[i] = k0 * A[3] + k1 * B[3] + k2 * C[3];
      g.ny[i] = k0 * A[4] + k1 * B[4] + k2 * C[4];
      g.nz[i] = k0 * A[5] + k1 * B[5] + k2 * C[5];
      g.u[i] = k0 * A[6] + k1 * B[6] + k2 * C[6];
      g.v[i] = k0 * A[7] + k1 * B[7] + k2 * C[7];
    }
  }
}

// Hexahedron faces: corners 0-3 are the -z end (-x-y, +x-y, +x+y, -x+y), 4-7
// the +z end in the same order. Face ids: 0 rear(-z) 1 front(+z) 2 top(-y)
// 3 bottom(+y) 4 left(-x) 5 right(+x). On the side faces u runs forward.
const HEX_FACES = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [3, 2, 6, 7], [0, 4, 7, 3], [1, 5, 6, 2]];
const F_REAR = 0, F_FRONT = 1, F_TOP = 2, F_BOT = 3, F_LEFT = 4, F_RIGHT = 5;

/**
 * Eight-cornered solid with flat faces. Each face is its own primitive so the
 * shader knows which face it is on, where (u, v in centimetres from the face
 * corner) and how big the face is; `bevel` rounds the edges in the normals.
 */
function hexa(sc, C, mat, o = {}) {
  const M = sc.M;
  const P = C.map((p) => mP(M, p[0], p[1], p[2]));
  const cen = vMul(P.reduce((a, b) => vAdd(a, b), [0, 0, 0]), 1 / 8);
  const skip = o.skip || 0;
  for (let fi = 0; fi < 6; fi++) {
    if (skip & (1 << fi)) continue;
    const [a, b, c, d] = HEX_FACES[fi].map((k) => P[k]);
    const eu = vSub(b, a), ev = vSub(d, a);
    const su = (vLen(eu) + vLen(vSub(c, d))) / 2, sv = (vLen(ev) + vLen(vSub(c, b))) / 2;
    if (su < 1e-5 || sv < 1e-5) continue;
    let n = vNorm(vCross(vSub(c, a), vSub(d, b)));
    const fc = vMul(vAdd(vAdd(a, b), vAdd(c, d)), 0.25);
    if (vDot(n, vSub(fc, cen)) < 0) n = vMul(n, -1);
    const pid = prim3(sc, mat, { face: fi, tu: vNorm(eu), tv: vNorm(ev), su, sv });
    const V = (p, u, v) => [p[0], p[1], p[2], n[0], n[1], n[2], u, v];
    const A = V(a, 0, 0), B = V(b, su, 0), Cc = V(c, su, sv), D = V(d, 0, sv);
    rtri(pid, A, B, Cc, !mat.two, o.bias);
    rtri(pid, A, Cc, D, !mat.two, o.bias);
  }
}

/** Axis-aligned box in local space; `mod(corners)` may reshape it (tapers). */
function box3(sc, x0, y0, z0, x1, y1, z1, mat, o = {}) {
  const C = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  if (o.mod) o.mod(C);
  hexa(sc, C, mat, o);
}

/**
 * Loft: a tube swept along a local path, the workhorse for barrels, fingers,
 * forearms, hoses and wires. `rad(t, i)` returns a radius or [rx, ry] (rx
 * along the frame normal, which starts as `up` projected off the tangent).
 * Caps: 'round' (a hemisphere, for fingertips) or 'flat' (a disc).
 * The shader sees u = distance along the path (cm) and v = angle 0..1.
 */
function loft(sc, pts, rad, mat, o = {}) {
  const segs = o.segs || 12;
  const n = pts.length;
  if (n < 2) return;
  const L = [0];
  for (let i = 1; i < n; i++) L.push(L[i - 1] + vLen(vSub(pts[i], pts[i - 1])));
  const total = L[n - 1] || 1;
  const T = pts.map((p, i) => vNorm(vSub(pts[min(n - 1, i + 1)], pts[max(0, i - 1)])));
  let up = o.up || [0, -1, 0];
  let N = vSub(up, vMul(T[0], vDot(up, T[0])));
  if (vLen(N) < 1e-4) { up = [1, 0, 0]; N = vSub(up, vMul(T[0], vDot(up, T[0]))); }
  N = vNorm(N);
  const rings = [];
  for (let i = 0; i < n; i++) {
    if (i > 0) N = vNorm(vSub(N, vMul(T[i], vDot(N, T[i]))));
    const B = vCross(T[i], N);
    let r = rad(L[i] / total, i);
    if (typeof r === 'number') r = [r, r];
    rings.push({ c: pts[i], T: T[i], N, B, rx: r[0], ry: r[1], u: L[i] });
  }
  const capRings = (end) => {
    const R = end ? rings[rings.length - 1] : rings[0];
    const dir = end ? 1 : -1;
    const out = [];
    const len = o.capLen || 1;
    for (let k = 1; k <= 4; k++) {
      const ph = (k / 4) * PI / 2;
      const s = sin(ph), c = cos(ph);
      out.push({
        c: vAdd(R.c, vMul(R.T, dir * s * min(R.rx, R.ry) * len)), T: R.T, N: R.N, B: R.B,
        rx: R.rx * c, ry: R.ry * c, u: R.u + dir * s * min(R.rx, R.ry) * len, tip: k === 4 ? dir : 0,
      });
    }
    return out;
  };
  if (o.capStart === 'round') rings.unshift(...capRings(false).reverse());
  if (o.capEnd === 'round') rings.push(...capRings(true));
  const roll = o.roll || 0;
  const R = rings.length;
  const V = [];
  for (let i = 0; i < R; i++) {
    const g = rings[i];
    const row = [];
    for (let j = 0; j <= segs; j++) {
      const th = (j / segs) * TAU + roll;
      const cs = cos(th), sn = sin(th);
      row.push(vBasis(g.c, g.N, cs * g.rx, g.B, sn * g.ry, g.T, 0));
    }
    V.push(row);
  }
  const M = sc.M;
  const pid = prim3(sc, mat, { len: total });
  const CV = [];
  for (let i = 0; i < R; i++) {
    const g = rings[i];
    const row = [];
    for (let j = 0; j <= segs; j++) {
      let nn;
      if (g.tip) nn = vMul(g.T, g.tip);
      else {
        const du = vSub(V[min(R - 1, i + 1)][j], V[max(0, i - 1)][j]);
        const jm = j === 0 ? segs - 1 : j - 1, jp = j === segs ? 1 : j + 1;
        const dv = vSub(V[i][jp], V[i][jm]);
        nn = vNorm(vCross(du, dv));
        const out = vSub(V[i][j], g.c);
        if (vDot(nn, out) < 0) nn = vMul(nn, -1);
        if (vLen(out) < 1e-5) nn = vMul(g.T, i === 0 ? -1 : 1);
      }
      const p = mP(M, V[i][j][0], V[i][j][1], V[i][j][2]);
      const d = vNorm(mD(M, nn[0], nn[1], nn[2]));
      row.push([p[0], p[1], p[2], d[0], d[1], d[2], g.u, j / segs]);
    }
    CV.push(row);
  }
  const cull = !mat.two;
  for (let i = 0; i < R - 1; i++) {
    for (let j = 0; j < segs; j++) {
      const a = CV[i][j], b = CV[i + 1][j], c = CV[i + 1][j + 1], d = CV[i][j + 1];
      rtri(pid, a, b, c, cull, o.bias);
      rtri(pid, a, c, d, cull, o.bias);
    }
  }
  // flat discs close the ends; u stays at the end, v becomes the radius 0..1
  const disc = (i, dir, capMat) => {
    const g = rings[i];
    const nn = vNorm(mD(M, g.T[0] * dir, g.T[1] * dir, g.T[2] * dir));
    const cp = mP(M, g.c[0], g.c[1], g.c[2]);
    const dp = prim3(sc, capMat || mat, { len: total, disc: dir, rx: g.rx, ry: g.ry });
    const C0 = [cp[0], cp[1], cp[2], nn[0], nn[1], nn[2], 0, 0];
    for (let j = 0; j < segs; j++) {
      const a = CV[i][j], b = CV[i][j + 1];
      rtri(dp, C0, [a[0], a[1], a[2], nn[0], nn[1], nn[2], j / segs, 1],
        [b[0], b[1], b[2], nn[0], nn[1], nn[2], (j + 1) / segs, 1], cull, o.bias);
    }
  };
  if (o.capStart === 'flat') disc(0, -1, o.capMat);
  if (o.capEnd === 'flat') disc(R - 1, 1, o.capMat);
}

/** Straight tube between two local points. */
function tube3(sc, a, b, r0, r1, mat, o = {}) {
  const k = o.rings || 2;
  const pts = [];
  for (let i = 0; i <= k; i++) pts.push(vLerp(a, b, i / k));
  loft(sc, pts, (t) => lerp(r0, r1, t), mat, o);
}

/** Ellipsoid with radii (rx, ry, rz) about its local axes, poles on z. */
function ball3(sc, c, rx, ry, rz, mat, o = {}) {
  const K = o.rings || 8;
  const pts = [];
  for (let k = 0; k <= K; k++) pts.push([c[0], c[1], c[2] - rz * cos((k / K) * PI)]);
  loft(sc, pts, (t, i) => { const s = sin((i / K) * PI); return [ry * s, rx * s]; },
    mat, { segs: o.segs || 12, up: [0, -1, 0], bias: o.bias });
}

/** Smooth path through control points (Catmull-Rom), `k` samples per span. */
function spline(pts, k = 4) {
  const out = [];
  const n = pts.length;
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[min(n - 1, i + 2)];
    for (let s = 0; s < k; s++) {
      const t = s / k, t2 = t * t, t3 = t2 * t;
      out.push([0, 1, 2].map((d) => 0.5 * ((2 * p1[d]) + (-p0[d] + p2[d]) * t
        + (2 * p0[d] - 5 * p1[d] + 4 * p2[d] - p3[d]) * t2 + (-p0[d] + 3 * p1[d] - 3 * p2[d] + p3[d]) * t3)));
    }
  }
  out.push(pts[n - 1].slice());
  return out;
}

// --- the shading pass ------------------------------------------------------

/** One mutable record handed to every material shader (no per-pixel garbage). */
const SH = {
  u: 0, v: 0, nx: 0, ny: 0, nz: 1, x: 0, y: 0, z: 0,
  col: 0, gl: 0.3, em: 0, ao: 1, edge: 0, face: 0, prim: null,
};

// AO taps, visited in opposite pairs: three directions on an inner ring and
// three on an outer one, rotated against each other so the pattern breaks up.
const AO_TAPS = [];
for (let k = 0; k < 3; k++) {
  const a = (k / 3) * PI;
  AO_TAPS.push(round2(cos(a) * 2.2), round2(sin(a) * 2.2));
  AO_TAPS.push(round2(cos(a + 0.5) * 5.2), round2(sin(a + 0.5) * 5.2));
}
function round2(v) { return Math.round(v); }

/**
 * Resolve the G-buffer into a deferred canvas: depth-derived ambient occlusion
 * (the contact shadow where fingers meet a grip), a one-pixel ink line on the
 * far side of every depth break (what keeps a pixel-art gun legible at a
 * glance), then each primitive's material shader.
 */
function resolve3(sc) {
  const g = GB, W = VW, H = VH;
  const ao = g.ao;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (g.pid[i] < 0) continue;
      const z = 1 / g.iz[i];
      // Opposite taps in pairs: on a plane (however steeply it recedes) the two
      // depths average out to this one, so only real creases and overhangs
      // occlude. Plain screen-space AO darkens every grazing surface instead.
      let occ = 0;
      for (let k = 0; k < AO_TAPS.length; k += 2) {
        const xa = x + AO_TAPS[k], ya = y + AO_TAPS[k + 1];
        const xb = x - AO_TAPS[k], yb = y - AO_TAPS[k + 1];
        const ja = (xa < 0 || ya < 0 || xa >= W || ya >= H) ? -1 : ya * W + xa;
        const jb = (xb < 0 || yb < 0 || xb >= W || yb >= H) ? -1 : yb * W + xb;
        const za = ja >= 0 && g.pid[ja] >= 0 ? 1 / g.iz[ja] : z + 3;
        const zbb = jb >= 0 && g.pid[jb] >= 0 ? 1 / g.iz[jb] : z + 3;
        const dz = z - (za + zbb) * 0.5;
        if (dz > 0.05) occ += min(1, dz / 1.6) * (dz < 8 ? 1 : 0.3);
      }
      let a = 1 - min(0.6, occ / 6 * 1.1);
      const th = 0.30 + z * 0.028;
      const nb = [i - 1, i + 1, i - W, i + W];
      for (let k = 0; k < 4; k++) {
        const j = nb[k];
        if (j < 0 || j >= W * H || g.pid[j] < 0) continue;
        if ((k === 0 && x === 0) || (k === 1 && x === W - 1)) continue;
        if (z - 1 / g.iz[j] > th) { a *= 0.40; break; }
      }
      ao[i] = a;
    }
  }
  const cv = makeCv(W, H);
  const S = SH;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const pid = g.pid[i];
      if (pid < 0) continue;
      const pr = sc.prims[pid];
      let nx = g.nx[i], ny = g.ny[i], nz = g.nz[i];
      let l = sqrt(nx * nx + ny * ny + nz * nz) || 1;
      nx /= l; ny /= l; nz /= l;
      if (pr.two) {
        const vx = (x + 0.5 - CAM_CX) / CAM_F, vy = (y + 0.5 - CAM_CY) / CAM_F;
        if (nx * vx + ny * vy + nz > 0) { nx = -nx; ny = -ny; nz = -nz; }
      }
      S.u = g.u[i]; S.v = g.v[i]; S.x = x; S.y = y; S.z = 1 / g.iz[i];
      S.col = pr.col || METAL.base; S.gl = pr.gl === undefined ? 0.3 : pr.gl; S.em = pr.em || 0;
      S.ao = ao[i]; S.edge = 0; S.face = pr.face || 0; S.prim = pr;
      if (pr.bevel && pr.tu) {
        const b = pr.bevel;
        const e0 = 1 - S.u / b, e1 = 1 - (pr.su - S.u) / b, e2 = 1 - S.v / b, e3 = 1 - (pr.sv - S.v) / b;
        let ku = 0, kv = 0;
        if (e0 > 0) { ku -= e0 * e0; S.edge = max(S.edge, e0); }
        if (e1 > 0) { ku += e1 * e1; S.edge = max(S.edge, e1); }
        if (e2 > 0) { kv -= e2 * e2; S.edge = max(S.edge, e2); }
        if (e3 > 0) { kv += e3 * e3; S.edge = max(S.edge, e3); }
        if (ku || kv) {
          nx += (pr.tu[0] * ku + pr.tv[0] * kv) * 1.2;
          ny += (pr.tu[1] * ku + pr.tv[1] * kv) * 1.2;
          nz += (pr.tu[2] * ku + pr.tv[2] * kv) * 1.2;
          l = sqrt(nx * nx + ny * ny + nz * nz) || 1;
          nx /= l; ny /= l; nz /= l;
        }
      }
      S.nx = nx; S.ny = ny; S.nz = nz;
      if (pr.shade) pr.shade(S);
      l = sqrt(S.nx * S.nx + S.ny * S.ny + S.nz * S.nz) || 1;
      cv.data[i] = S.col;
      cv.nx[i] = S.nx / l; cv.ny[i] = S.ny / l; cv.nz[i] = -S.nz / l;
      cv.ao[i] = S.ao; cv.gl[i] = S.gl; cv.em[i] = S.em;
    }
  }
  return cv;
}

// --- surface detail helpers --------------------------------------------------

// One tiling fbm table sampled bilinearly: the per-pixel material noise costs
// a lookup instead of four octaves of lattice noise, which is what keeps 42
// frames of fully shaded guns inside the old build time.
let NTAB = null;
function ntab() {
  if (!NTAB) {
    NTAB = new Float32Array(256 * 256);
    for (let j = 0; j < 256; j++) {
      for (let i = 0; i < 256; i++) NTAB[j * 256 + i] = fbm(6101, i / 32, j / 32, 4, 8);
    }
  }
  return NTAB;
}
/** shade() that saturates instead of wrapping: highlights here go past 1. */
function shadeC(c, k) {
  return rgba(min(255, (c & 255) * k), min(255, ((c >>> 8) & 255) * k), min(255, ((c >>> 16) & 255) * k), 255);
}

/** Smooth noise 0..1, tiling every 8 units. */
function nz3(x, y) {
  const T = NTAB;
  x *= 32; y *= 32;
  const xi = floor(x), yi = floor(y);
  const fx = x - xi, fy = y - yi;
  const x0 = xi & 255, y0 = yi & 255, x1 = (x0 + 1) & 255, y1 = (y0 + 1) & 255;
  const a = T[y0 * 256 + x0], b = T[y0 * 256 + x1], c = T[y1 * 256 + x0], d = T[y1 * 256 + x1];
  const top = a + (b - a) * fx;
  return top + (c + (d - c) * fx - top) * fy;
}
/** Stepped hash on a cell grid: crisp per-cell variation (chips, hairs, pits). */
function cell3(x, y, s) { return hash2(floor(x), floor(y), s); }

/** Is (x, y) on a stroke of `text` set in the 3x5 font at (x0, y0), glyph height h? */
function glyph3(text, x, y, x0, y0, h) {
  const c = h / 5;
  const col = floor((x - x0) / c), row = floor((y - y0) / c);
  if (row < 0 || row > 4 || col < 0) return false;
  const ch = floor(col / 4), k = col - ch * 4;
  if (ch >= text.length || k === 3) return false;
  const g = FONT35[text[ch]] || FONT35[' '];
  return (g[row] & (4 >> k)) !== 0;
}

/**
 * The house metal: grain, brushing along u, scratches, bright edge wear on the
 * bevels and grime settling into whatever the AO pass found occluded.
 */
function metal3(col, o = {}) {
  const {
    gl = 0.55, grain = 0.10, brush = 0.08, scratch = 0.5, wear = 0.5, grime = 0.5,
    seed = 0, bare = STEEL_B, freq = 1, decal = null, em = 0, refl = 0.8,
  } = o;
  const so = (seed % 97) * 0.37;
  return {
    col, gl, em, bevel: o.bevel, two: o.two,
    shade(S) {
      const u = S.u * freq, v = S.v * freq;
      const n = nz3(u * 0.55 + so, v * 0.55 + so * 1.3);
      const f = nz3(u * 1.3 + so * 2.1, v * 1.3);
      let c = shadeC(S.col, 1 + (n - 0.5) * grain * 2.2 + (f - 0.5) * grain);
      if (brush) c = shadeC(c, 1 + (nz3(u * 0.25 + so, v * 9 + so) - 0.5) * brush * 2);
      let g2 = gl * (0.82 + n * 0.36);
      // scratches: thin bright strokes, long along u
      if (scratch) {
        // long thin scratches: the contour lines of a stretched noise field
        const sc2 = nz3(u * 0.08 + so, v * 0.7 + u * 0.03);
        if (abs(sc2 - 0.5) < 0.005 * scratch) { c = mix(c, bare, 0.45); g2 = min(1, g2 + 0.25); }
      }
      if (wear && S.edge > 0.25) {
        const k = smoothstep(0.25, 0.9, S.edge) * wear * (0.55 + f * 0.8);
        c = mix(c, bare, clamp(k, 0, 0.85));
        g2 = min(1, g2 + k * 0.3);
      }
      if (grime) {
        const k = clamp((1 - S.ao) * 1.6 * grime + (n > 0.62 ? (n - 0.62) * grime * 1.4 : 0), 0, 0.85);
        c = mix(c, rgba(24, 20, 18, 255), k);
        g2 *= 1 - k * 0.6;
      }
      // studio reflections: the part of a metal gun you actually notice
      const h = studio3(S) * refl * (0.6 + g2 * 0.6) * (1 - S.edge * 0.3);
      if (h > 0.02) {
        c = mix(c, rgba(255, 246, 228, 255), clamp(h, 0, 0.9));
        S.em = max(S.em, clamp(h * 0.75, 0, 0.8));
      }
      S.col = c; S.gl = g2;
      if (decal) decal(S);
    },
  };
}

// The studio the guns are photographed in: one big softbox up and to the
// left, a long strip light overhead. Looked up with the reflected eye ray.
const SOFTBOX = norm3(-0.42, -0.6, 0.68);
/** Reflection highlight 0..1 for the current pixel. */
function studio3(S) {
  let vx = (S.x + 0.5 - CAM_CX) / CAM_F, vy = (S.y + 0.5 - CAM_CY) / CAM_F;
  const vl = sqrt(vx * vx + vy * vy + 1);
  vx /= vl; vy /= vl;
  const vz = 1 / vl;
  const d = vx * S.nx + vy * S.ny + vz * S.nz;
  const rx = vx - 2 * d * S.nx, ry = vy - 2 * d * S.ny, rz = vz - 2 * d * S.nz;
  const sb = rx * SOFTBOX[0] + ry * SOFTBOX[1] + rz * SOFTBOX[2];
  let h = smoothstep(0.86, 0.95, sb);
  const strip = (ry + 0.3) / 0.05;
  h += exp(-strip * strip) * 0.65 * smoothstep(-0.2, 0.3, rz);
  return h;
}

/** Flat material with a custom shader and no metal treatment. */
function flat3(col, gl, shadeFn, o = {}) {
  return Object.assign({ col, gl, shade: shadeFn }, o);
}

// ---------------------------------------------------------------------------
// hands: one rig, every weapon
// ---------------------------------------------------------------------------
// Hardigan wears fingerless black leather driving gloves, because it is 1996
// and he is the kind of man who owns driving gloves. So the knuckles are
// leather, the last two joints of every finger are sunburnt skin with hair on
// them, and the forearms carry what he refers to as his "art".

const SKIN3 = rgba(214, 160, 124, 255);
const SKIN3_D = rgba(156, 100, 76, 255);
const SKIN3_R = rgba(200, 118, 96, 255);    // knuckles and fingertips flush redder
const HAIR3 = rgba(62, 42, 30, 255);
const NAIL3 = rgba(226, 196, 176, 255);
const GLOVE3 = rgba(44, 38, 38, 255);
const GLOVE3_HI = rgba(118, 108, 104, 255);
const STITCH3 = rgba(150, 136, 112, 255);
const INK3 = rgba(34, 44, 70, 255);
const INK3_R = rgba(176, 34, 38, 255);
const CLOTH3 = rgba(92, 96, 64, 255);        // olive shirt sleeve, rolled

/**
 * Skin. `circ` is the limb's circumference in cm so hair and pores can be
 * sized physically (v only runs 0..1 round the tube); `hair` 0..1.
 */
function skinShade(S, hair, so, circ) {
  const w = S.v * circ;
  const n = nz3(S.u * 0.22 + so, w * 0.22 + so);
  const f = nz3(S.u * 1.1 + so * 1.7, w * 1.1);
  let c = mix(SKIN3_D, SKIN3, clamp(0.62 + (n - 0.5) * 0.7 + (f - 0.5) * 0.22, 0, 1));
  // occlusion reads warm on skin: light bleeding back out through the flesh
  c = mix(c, SKIN3_R, clamp((1 - S.ao) * 1.1, 0, 0.5));
  let gl = 0.24 + f * 0.12;
  if (hair > 0) {
    // hair: short dark strokes lying along the limb, thinning out in patches
    const h = nz3(S.u * 0.9 + so * 3, w * 7.5 + so);
    const k = smoothstep(0.66, 0.72, h) * hair * smoothstep(0.35, 0.6, n + 0.1);
    if (k > 0.02) { c = mix(c, HAIR3, clamp(k * 0.8, 0, 0.75)); gl *= 1 - k * 0.5; }
  }
  // pores and freckles
  if (cell3(S.u * 3, w * 3, 17 + so) > 0.965) c = shadeC(c, 0.9);
  S.col = c; S.gl = gl;
}

function leatherShade(S, so, wearK = 0.6) {
  const n = nz3(S.u * 1.4 + so, S.v * 5.3 + so);
  const f = nz3(S.u * 6.1 + so, S.v * 23);
  let c = shadeC(GLOVE3, 0.86 + n * 0.3 + (f - 0.5) * 0.22);
  // worn crest where the leather is bent over a knuckle and catches the light
  const crest = clamp(-S.ny * 0.9 - S.nz * 0.3, 0, 1) * wearK;
  c = mix(c, GLOVE3_HI, crest * (0.3 + n * 0.5));
  c = mix(c, rgba(14, 12, 12, 255), clamp((1 - S.ao) * 0.9, 0, 0.6));
  S.col = c; S.gl = 0.34 + crest * 0.25 + f * 0.1;
  // pebbled grain
  S.nx += (f - 0.5) * 0.25; S.ny += (n - 0.5) * 0.25;
}

/**
 * Finger material: leather up to `cut` cm, a rolled stitched hem, then skin
 * with a crease at the next joint and a nail on the back (v = nailV) of the tip.
 */
function fingerMat(cut, so, nailV = 0.75, crease = 2.4) {
  return {
    col: SKIN3, gl: 0.3,
    shade(S) {
      if (S.u < cut) {
        leatherShade(S, so, 0.9);
        if (S.u > cut - 0.35) { S.col = shadeC(S.col, 1.35); S.ny -= 0.3; }
        if (S.u > cut - 0.65 && S.u < cut - 0.5 && (floor(S.v * 28) & 1)) S.col = STITCH3;
        return;
      }
      skinShade(S, 0, so, 6.5);
      const d = abs(S.u - cut - crease);
      if (d < 0.12) S.col = mix(S.col, SKIN3_D, 0.55);
      // the nail: a pale glossy plate with a dark rim, on the back of the tip
      let dv = S.v - nailV;
      if (dv > 0.5) dv -= 1; else if (dv < -0.5) dv += 1;
      const tip = S.u - (S.prim.len - 1.25);
      if (tip > 0 && abs(dv) < 0.13) {
        const rim = abs(dv) > 0.10 || tip < 0.15;
        S.col = rim ? mix(S.col, SKIN3_D, 0.6) : mix(NAIL3, rgba(250, 236, 226, 255), clamp(tip - 0.9, 0, 1));
        S.gl = rim ? S.gl : 0.62;
      }
    },
  };
}

const LEATHER3 = { col: GLOVE3, gl: 0.34, shade: (S) => leatherShade(S, 3.1) };

/**
 * A hand gripping a cylinder-ish handle.
 *   c        the handle's axis at the top of the hand (local space)
 *   a        axis direction, index finger toward little finger
 *   p        from the axis toward the palm
 *   q        wrap direction: the fingers go from p, through q, round to -p
 *   rp, rq   the handle's half-thickness along p and q (an ellipse)
 *   s        axial offsets of the four fingers (null to skip one)
 *   trigger  optional path (grip coords) for a straight-ish index finger
 *   thumb    thumb path in grip coords [ga, gp, gq]
 *   wrist    wrist centre, grip coords; arm: direction in LOCAL space
 */
function hand3(sc, H) {
  const { c, a, p, q } = H;
  const G = (ga, gp, gq) => vBasis(c, a, ga, p, gp, q, gq);
  const rp = H.rp, rq = H.rq;
  const so = H.seed || 0;
  const FING = [
    { r: 0.96, L: [4.2, 2.5, 2.0] },
    { r: 1.02, L: [4.6, 2.9, 2.1] },
    { r: 0.97, L: [4.3, 2.7, 2.0] },
    { r: 0.84, L: [3.5, 2.1, 1.8] },
  ];
  const wrap = H.wrap === undefined ? 1 : H.wrap;
  // --- the four fingers, walked round the handle joint by joint ---
  for (let k = 0; k < 4; k++) {
    const s = H.s[k];
    if (s === null || s === undefined) continue;
    const f = FING[k];
    if (k === 0 && (H.trigger || H.triggerL)) {
      const pts = spline(H.triggerL || H.trigger.map((g) => G(g[0], g[1], g[2])), 3);
      loft(sc, pts, (t) => f.r * (1 - t * 0.14) * (1 + 0.1 * exp(-pow((t - 0.45) / 0.08, 2))),
        fingerMat(3.4, so + k), { segs: 10, capEnd: 'round', up: a });
      continue;
    }
    // point on the offset ellipse at angle th (0 = palm side, +90deg = q side)
    const at = (th) => {
      const ex = rp * cos(th), ey = rq * sin(th);
      const nn = vNorm([cos(th) / rp, sin(th) / rq, 0]);
      const off = f.r * 1.04;
      return [ex + nn[0] * off, ey + nn[1] * off];
    };
    const mcp = [rp + 1.7 + f.r * 0.4, (H.mcpQ || 0.6)];
    const joints = [mcp];
    let th = atan2(mcp[1] / rq, mcp[0] / rp);
    for (let j = 0; j < 3; j++) {
      const L = f.L[j] * (H.fscale || 1);
      const prev = joints[joints.length - 1];
      let pt = at(th);
      let guard = 0;
      while (hypot(pt[0] - prev[0], pt[1] - prev[1]) < L && guard++ < 400) {
        th += 0.02 * wrap;
        pt = at(th);
      }
      joints.push(pt);
    }
    // straight bones, fat joints: sample each phalanx and swell the knuckles
    const pts = [], rs = [];
    const slope = H.slope || 0;
    for (let j = 0; j < 3; j++) {
      const A = joints[j], B = joints[j + 1];
      for (let m = 0; m < 3; m++) {
        const t = m / 3;
        pts.push(G(s + slope * (j + t), lerp(A[0], B[0], t), lerp(A[1], B[1], t)));
        const knuckle = m === 0 ? (j === 0 ? 1.12 : 1.1) : 1;
        rs.push(f.r * (1 - (j + t) * 0.06) * knuckle);
      }
    }
    pts.push(G(s + slope * 3, joints[3][0], joints[3][1]));
    rs.push(f.r * 0.8);
    loft(sc, pts, (t, i) => rs[min(rs.length - 1, i)], fingerMat(f.L[0] * 0.8, so + k),
      { segs: 10, capEnd: 'round', up: a, capLen: 0.9 });
  }
  // --- palm and back of the hand ---
  const sm = H.sMid;
  const hb = [G(sm + 0.5, rp + 2.0, H.wristQ), G(sm + 0.3, rp + 2.2, H.wristQ * 0.55),
    G(sm, rp + 2.15, H.wristQ * 0.18), G(sm - 0.2, rp + 1.95, (H.mcpQ || 0.6) - 0.6)];
  loft(sc, spline(hb, 3), (t) => [lerp(2.9, 4.1, smoothstep(0, 0.8, t)), lerp(2.0, 1.75, t)],
    LEATHER3, { segs: 14, up: a, capEnd: 'round', capLen: 0.5 });
  // knuckle pads across the back of the hand
  if (H.pads !== false) {
    for (let k = 0; k < 4; k++) {
      if (H.s[k] === null || H.s[k] === undefined) continue;
      const kp = G(H.s[k], rp + 3.4, (H.mcpQ || 0.6) - 0.4);
      const m = metal3(rgba(38, 36, 40, 255), { gl: 0.5, grain: 0.1, scratch: 0.8, wear: 0.4, seed: 40 + k });
      ball3(sc, kp, 0.9, 0.75, 0.9, m, { rings: 6, segs: 10 });
    }
  }
  // --- thumb ---
  if (H.thumb || H.thumbL) {
    const tl = H.thumbL || H.thumb.map((g) => G(g[0], g[1], g[2]));
    const tp = spline(tl, 4);
    const tr = H.thumbR || [1.55, 1.3, 1.15, 1.05];
    loft(sc, tp, (t) => {
      const i = t * (tr.length - 1), i0 = floor(i), i1 = min(tr.length - 1, i0 + 1);
      return lerp(tr[i0], tr[i1], i - i0);
    }, fingerMat(H.thumbCut || 5.0, so + 9, H.thumbNailV === undefined ? 0.5 : H.thumbNailV, 2.6),
    { segs: 12, capEnd: 'round', up: H.thumbUp || a, capLen: 0.9 });
    // the ball of the thumb, filling the web
    const b0 = tl[0], b1 = tl[1];
    loft(sc, [b0, vLerp(b0, b1, 0.5), b1], (t) => 1.9 - t * 0.35, LEATHER3,
      { segs: 12, up: a, capStart: 'round', capEnd: 'round' });
  }
  // --- wrist, cuff, forearm and sleeve ---
  if (H.arm) forearm3(sc, H.wristL || G(H.wrist[0], H.wrist[1], H.wrist[2]), H.arm, H);
}

/**
 * The forearm: glove cuff with a velcro strap, a lot of arm, and a rolled
 * sleeve where it leaves the frame. `tattoo` places the heart on the arm.
 */
function forearm3(sc, w, dir, H) {
  const d = vNorm(dir);
  const len = H.armLen || 34;
  const up = H.armUp || [0, -1, 0];
  const pts = [];
  const bend = H.armBend || [0, 0, 0];
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    pts.push(vAdd(vAdd(w, vMul(d, t * len)), vMul(bend, t * t * len)));
  }
  const so = (H.seed || 0) + 21;
  const sleeveAt = H.sleeveAt || 26;
  const tat = H.tattoo;
  const mat = {
    col: SKIN3, gl: 0.3,
    shade(S) {
      if (S.u < 3.2) {
        leatherShade(S, so, 0.5);
        // velcro strap with a stitched edge and a brass snap
        if (S.u > 1.0 && S.u < 2.4) {
          S.col = shadeC(S.col, 0.8);
          if (S.u < 1.15 || S.u > 2.25) S.col = STITCH3;
        }
        if (S.u > 3.0) { S.col = shadeC(S.col, 1.3); S.ny -= 0.25; }
        return;
      }
      skinShade(S, 1.0, so, 26);
      // veins over the tendons toward the wrist
      const vv = nz3(S.u * 0.35 + so, S.v * 2.2);
      if (S.u < 16 && abs(vv - 0.5) < 0.018) { S.col = mix(S.col, rgba(150, 110, 118, 255), 0.35); S.nz -= 0.2; }
      if (tat) tattoo3(S, tat);
    },
  };
  const rad = (t) => {
    const u = t * len;
    // wrist -> the swell of the forearm muscle -> elbow
    const sw = smoothstep(1.5, 12, u) * (1 - smoothstep(24, 40, u) * 0.25);
    const k = H.armScale || 1;
    return [(2.75 + sw * 2.2) * k, (2.15 + sw * 1.75) * k];
  };
  loft(sc, pts, rad, mat, { segs: 16, up, capStart: 'round', capLen: 0.6 });
  // rolled sleeve
  const sp = pts.filter((p, i) => i / 10 * len >= sleeveAt - 1.5);
  if (sp.length >= 2) {
    loft(sc, sp, (t) => { const r = rad(sleeveAt / len + t * 0.3); const k = t < 0.25 ? 1.32 : 1.2; return [r[0] * k, r[1] * k]; },
      {
        col: CLOTH3, gl: 0.12,
        shade(S) {
          const n = nz3(S.u * 0.9, S.v * 6);
          let c = shadeC(CLOTH3, 0.8 + n * 0.4);
          if ((floor(S.u * 6 + S.v * 40) & 3) === 0) c = shadeC(c, 0.9);   // twill
          // rolled cuff: a fat fold with its own shadow line
          const fold = S.u - (sleeveAt - 1.5);
          if (fold < 2.2 && fold > 0) c = shadeC(c, 1.12 - abs(fold - 1.1) * 0.2);
          if (abs(fold - 2.3) < 0.25) c = shadeC(c, 0.55);
          c = mix(c, rgba(20, 20, 14, 255), clamp((1 - S.ao) * 0.8, 0, 0.5));
          S.col = c; S.gl = 0.1;
        },
      }, { segs: 16, up });
  }
}

/**
 * The tattoo: a heart, a scroll and the word MOM, done in a dockside parlour in
 * 1984. `t` = { u, v, s }: centre along the arm (cm), angle round it (0..1)
 * and size (cm).
 */
function tattoo3(S, t) {
  const circ = 2 * PI * 4.2;
  let dv = S.v - t.v;
  if (dv > 0.5) dv -= 1; else if (dv < -0.5) dv += 1;
  const x = (S.u - t.u) / t.s;
  const y = (dv * circ) / t.s * (t.flip || 1);
  if (abs(x) > 1.6 || abs(y) > 1.6) return;
  const fade = 0.78;
  // heart: (x^2 + y^2 - 1)^3 - x^2 y^3 < 0, with y pointing up the picture
  const hx = y * 1.15, hy = -x * 1.15 + 0.1;
  const hv = pow(hx * hx + hy * hy - 1, 3) - hx * hx * hy * hy * hy;
  const hv2 = pow(hx * hx * 1.35 + hy * hy * 1.35 - 1, 3) - hx * hx * 1.35 * pow(hy * 1.16, 3);
  if (hv < 0) {
    S.col = mix(S.col, hv2 < 0 ? INK3_R : INK3, fade);
    if (hv2 < 0 && hy > 0.25 && hx < -0.1 && hx > -0.5) S.col = mix(S.col, rgba(236, 150, 140, 255), 0.5);
  }
  // scroll across the middle, with the word on it
  const by = hx, bx = -hy + 0.05;
  if (abs(bx) < 0.30 && abs(by) < 1.45) {
    const edge = abs(bx) > 0.22 || abs(by) > 1.36;
    S.col = mix(S.col, edge ? INK3 : rgba(226, 204, 150, 255), fade);
    const word = t.word || 'MOM';
    if (!edge && glyph3(word, by, bx, -(word.length * 4 - 1) * 0.04, -0.2, 0.4)) S.col = mix(S.col, INK3, 0.9);
  }
}

// ---------------------------------------------------------------------------
// shared gun materials
// ---------------------------------------------------------------------------

/**
 * Chrome is mostly reflection, and bake() only knows sky-above/floor-below,
 * so the shader adds the hard horizon line a polished surface actually shows:
 * bright where the normal faces up, a dark band at the horizon, a dim floor.
 */
function chrome3(o = {}) {
  const base = metal3(o.col || rgba(150, 154, 164, 255), {
    gl: 0.86, grain: 0.05, brush: 0.04, scratch: 0.3, wear: 0.15, grime: 0.55,
    bare: rgba(240, 242, 248, 255), seed: o.seed || 1, bevel: o.bevel, decal: o.decal,
  });
  const inner = base.shade;
  base.shade = (S) => {
    // reflect the eye ray and look it up in a studio: sky, a hard dark
    // horizon, a warm floor. That band is what makes chrome read as chrome.
    let vx = (S.x + 0.5 - CAM_CX) / CAM_F, vy = (S.y + 0.5 - CAM_CY) / CAM_F;
    const vl = sqrt(vx * vx + vy * vy + 1);
    vx /= vl; vy /= vl;
    const d = vx * S.nx + vy * S.ny + S.nz / vl;
    const ry = vy - 2 * d * S.ny, rx = vx - 2 * d * S.nx;
    let k;
    if (ry < -0.30) k = 1.5 + (-ry - 0.3) * 0.4;
    else if (ry < -0.04) k = lerp(0.2, 1.5, smoothstep(0.04, 0.30, -ry));
    else if (ry < 0.26) k = lerp(0.2, 0.62, (ry + 0.04) / 0.30);
    else k = 0.62 - (ry - 0.26) * 0.3;
    k *= 1 + 0.22 * sin(rx * 9.0 + ry * 4.0);
    // Flat faces reflect one colour edge to edge, which reads as grey paint.
    // A studio-style softbox band across each flat (bright rim, dark belly)
    // is the painter's cheat every chrome gun sprite has always used.
    const pr = S.prim;
    if (pr.sv) {
      const t = S.face === F_TOP || S.face === F_BOT ? S.u / pr.su : S.v / pr.sv;
      const band = t < 0.14 ? 1.6 - t : t < 0.42 ? lerp(1.46, 0.26, smoothstep(0.14, 0.42, t))
        : t < 0.82 ? lerp(0.26, 0.5, (t - 0.42) / 0.4) : lerp(0.5, 1.05, (t - 0.82) / 0.18);
      k = k * 0.45 + band * 0.62;
    }
    S.col = shadeC(S.col, k);
    inner(S);
  };
  return base;
}

/** Warm yellow metal: triggers, hammers, sight beads, casings. */
function brass3(o = {}) {
  return metal3(o.col || BRASS, {
    gl: 0.72, grain: 0.08, brush: 0.03, scratch: 0.4, wear: 0.6, grime: 0.6,
    bare: BRASS_B, seed: o.seed || 5, bevel: o.bevel,
  });
}

/** Mother of pearl: pale, glossy, with a slow pink/green shimmer in it. */
const PEARL3 = {
  col: rgba(226, 218, 204, 255), gl: 0.62,
  shade(S) {
    const n = nz3(S.u * 0.8 + 3, S.v * 4.4 + 1);
    const w = nz3(S.u * 2.2 + n * 3, S.v * 9.1);
    let c = mix(rgba(214, 206, 192, 255), rgba(246, 240, 230, 255), w);
    c = mix(c, n > 0.5 ? rgba(236, 200, 206, 255) : rgba(196, 226, 214, 255), abs(n - 0.5) * 0.9);
    c = mix(c, rgba(60, 50, 44, 255), clamp((1 - S.ao) * 1.2, 0, 0.6));
    S.col = c; S.gl = 0.55 + w * 0.2;
  },
};

// ---------------------------------------------------------------------------
// WEAPON 1 - THE WIDOW: a chrome hand cannon the size of a small dog
// ---------------------------------------------------------------------------
// Gun-local space: origin at the rear top of the slide, +z toward the muzzle,
// +y down, +x to Hardigan's right. Centimetres. The camera sits behind and
// above its left shoulder, so the top flat and the left flank carry the art.

const WIDOW3 = {
  pos: [7.2, 4.4, 20.0], yaw: -0.34, pitch: 0.0, roll: 0.1,
  len: 26.5, slideEnd: 19.2,
  muzzle: [0, 1.25, 26.6],
  port: [0.95, 0, 8.4],
  gripTop: [0, 4.6, 3.2], gripDir: vNorm([0, 12.6, -4.5]),
};

function widowScroll(S, u, v) {
  // hand-cut vine scroll: a sine vine with curls, cut dark into the chrome
  const vine = sin(u * 1.3 + sin(v * 1.9) * 1.2) * 0.9;
  const d = abs(v - 1.5 - vine * 0.55);
  const curl = abs(hypot((u % 2.6) - 1.3, v - 1.5 - vine * 0.6) - 0.55);
  if (d < 0.06 || curl < 0.05) { S.col = mix(S.col, rgba(40, 40, 46, 255), 0.7); S.gl *= 0.6; }
}

function drawWidow3(sc, P) {
  const W = WIDOW3;
  const slide = P.slide || 0;
  const heat = P.heat || 0;
  // ---- materials ----
  const chromeSlide = chrome3({
    seed: 11, bevel: 0.32,
    decal: (S) => {
      if (S.face === F_LEFT) {
        // serrations at the rear of the slide
        if (S.u > 0.7 && S.u < 5.0 && S.v > 0.5 && S.v < 3.0) {
          const k = (S.u * 2.4) % 1;
          S.nx += 0; S.nz += (k < 0.5 ? -0.9 : 0.9) * 0.5;
          S.col = shadeC(S.col, k < 0.5 ? 1.15 : 0.5);
        }
        // engraving on the flank
        if (S.u > 14.8 && S.u < 18.9 && S.v > 0.6 && S.v < 2.7) widowScroll(S, S.u, S.v);
        // the emblem: a red hourglass on a black enamel disc, like the spider
        const eu = S.u - 6.1, ev = S.v - 1.65;
        const ed = hypot(eu, ev);
        if (ed < 0.95) {
          const ring = ed > 0.82;
          const hg = abs(eu) < 0.55 * (abs(ev) / 0.72) + 0.06 && abs(ev) < 0.72;
          S.col = ring ? rgba(196, 150, 60, 255) : hg ? rgba(220, 30, 26, 255) : rgba(16, 14, 16, 255);
          S.gl = ring ? 0.7 : 0.8; S.em = hg && !ring ? 0.15 : 0;
        }
        if (glyph3('WIDOW', S.prim.su - S.u, S.v, S.prim.su - 14.0, 0.75, 1.8)) { S.col = mix(S.col, rgba(196, 150, 60, 255), 0.95); S.gl = 0.6; }
      }
      if (S.face === F_REAR) {
        // the back of the slide: fine horizontal serrations round a firing-pin plate
        const cx2 = S.prim.su / 2;
        if (abs(S.u - cx2) < 0.62 && S.v > 1.0 && S.v < 2.5) {
          S.col = mix(S.col, rgba(58, 58, 64, 255), 0.75); S.gl = 0.4;
          if (hypot(S.u - cx2, S.v - 1.75) < 0.2) S.col = rgba(18, 16, 18, 255);
        } else if (S.v > 0.5) {
          const k = (S.v * 3.2) % 1;
          S.ny += k < 0.5 ? -0.55 : 0.55;
          S.col = shadeC(S.col, k < 0.5 ? 1.1 : 0.62);
        }
      }
      if (S.face === F_TOP) {
        // ejection port on the right-hand edge of the top flat
        if (S.u > S.prim.su - 1.2 && S.v > 5.9 && S.v < 10.8) {
          S.col = mix(rgba(20, 18, 20, 255), BRASS_D, S.u > S.prim.su - 0.8 ? 0.6 : 0.0);
          S.gl = 0.3; S.ao *= 0.6;
        }
        // matte anti-glare stripe down the middle
        if (abs(S.u - S.prim.su / 2) < 0.4) { S.col = shadeC(S.col, 0.55); S.gl *= 0.5; }
      }
    },
  });
  const chromeBarrel = chrome3({
    seed: 13, bevel: 0.3,
    decal: (S) => {
      if (S.face === F_LEFT) {
        const ru = S.prim.su - S.u;
        if (glyph3('50 AE', ru, S.v, 1.0, 0.8, 0.75)) S.col = mix(S.col, rgba(30, 30, 34, 255), 0.85);
        if (glyph3('NUKEHAUS ARMS', ru, S.v, 0.3, 1.9, 0.42)) S.col = mix(S.col, rgba(40, 40, 44, 255), 0.7);
      }
      if (heat > 0 && S.face !== F_TOP) S.col = mix(S.col, rgba(140, 90, 150, 255), heat * 0.25);
    },
  });
  const blacked = metal3(rgba(56, 56, 64, 255), { gl: 0.42, grain: 0.12, scratch: 0.7, wear: 0.7, seed: 17, bevel: 0.25, bare: rgba(160, 162, 170, 255) });
  const brass = brass3({ bevel: 0.15 });

  // ---- the moving slide (and the hammer it cocks) ----
  push3(sc, mT(0, 0, -slide));
  // slide body: flat top, flanks flaring out slightly to the frame rails
  box3(sc, -1.55, 0, 0, 1.55, 3.3, W.slideEnd, chromeSlide, {
    mod: (C) => { for (const k of [0, 1, 4, 5]) C[k][0] *= 0.82; C[4][1] = C[5][1] = 0.15; },
  });
  // rear sight: two ears and the notch between them, white dots
  const dotMat = flat3(rgba(236, 232, 214, 255), 0.4, null, { em: 0.15 });
  box3(sc, -1.35, -0.85, 0.5, -0.32, 0.05, 1.9, blacked);
  box3(sc, 0.32, -0.85, 0.5, 1.35, 0.05, 1.9, blacked);
  ball3(sc, [-0.8, -0.45, 0.46], 0.2, 0.2, 0.05, dotMat, { rings: 4, segs: 8 });
  ball3(sc, [0.8, -0.45, 0.46], 0.2, 0.2, 0.05, dotMat, { rings: 4, segs: 8 });
  // ambidextrous safety lever on the left of the slide
  box3(sc, -1.95, 0.5, 1.2, -1.25, 1.3, 3.1, blacked, {
    mod: (C) => { C[0][1] -= 0.3; C[1][1] -= 0.3; },
  });
  pop3(sc);

  // ---- fixed barrel: the triangular Desert Eagle nose with a vented rib ----
  box3(sc, -1.5, 0.05, W.slideEnd, 1.5, 3.2, W.len, chromeBarrel, {
    mod: (C) => {
      for (const k of [0, 1, 4, 5]) C[k][0] *= 0.8;
      // the underside slopes up to the muzzle
      C[6][1] = C[7][1] = 2.3;
      C[6][0] *= 0.8; C[7][0] *= 0.8;
    },
  });
  // top rib with cross slots, running the full length
  const rib = metal3(rgba(64, 64, 72, 255), {
    gl: 0.5, grain: 0.1, scratch: 0.6, wear: 0.6, seed: 19, bevel: 0.12,
    decal: (S) => {
      // cross slots cut across the rib
      if (S.face === F_TOP && (S.v % 1.1) < 0.35) { S.col = shadeC(S.col, 0.4); S.ao *= 0.7; }
    },
  });
  box3(sc, -0.6, -0.42, 2.2, 0.6, 0.02, W.len + 3.2, rib);
  // compensator: three ports on top that spit fire sideways and up
  const comp = chrome3({
    seed: 15, bevel: 0.25,
    decal: (S) => {
      if (S.face === F_TOP || S.face === F_LEFT) {
        const k = S.face === F_TOP ? S.v : S.u;
        const w = S.face === F_TOP ? abs(S.u - S.prim.su / 2) < 0.7 : S.v < 1.6;
        if (w && k > 0.5 && ((k - 0.5) % 1.0) < 0.55 && k < 3.0) {
          const glowK = heat;
          S.col = mix(rgba(14, 12, 12, 255), hotColor(0.25), glowK * 0.8); S.em = glowK * 0.8; S.gl = 0.1;
        }
      }
    },
  });
  box3(sc, -1.3, 0.05, W.len, 1.3, 2.4, W.len + 3.4, comp, {
    mod: (C) => { for (const k of [0, 1, 4, 5]) C[k][0] *= 0.85; },
  });
  // front sight blade with a brass bead
  box3(sc, -0.2, -1.25, W.len + 1.6, 0.2, -0.3, W.len + 2.7, blacked);
  ball3(sc, [0, -1.2, W.len + 1.55], 0.24, 0.24, 0.12, flat3(rgba(250, 206, 96, 255), 0.7, null, { em: 0.35 }), { rings: 4, segs: 8 });
  // muzzle face: dark bore, crowned
  push3(sc, mT(0, 0, 0));
  tube3(sc, [0, W.muzzle[1], W.len + 3.2], [0, W.muzzle[1], W.len + 3.6], 0.72, 0.72,
    flat3(rgba(20, 18, 20, 255), 0.3, null), { segs: 12, capEnd: 'flat' });
  pop3(sc);

  // ---- frame / dust cover ----
  box3(sc, -1.45, 3.2, 0.6, 1.45, 5.0, 18.2, blacked, {
    mod: (C) => { C[7][2] -= 1.4; C[6][2] -= 1.4; },
  });
  // slide stop lever and a takedown pin on the left of the frame
  box3(sc, -1.75, 3.4, 8.5, -1.35, 4.1, 12.6, blacked);
  ball3(sc, [-1.55, 4.3, 15.3], 0.35, 0.35, 0.35, brass, { rings: 5, segs: 8 });

  // ---- hammer ----
  const hz = P.hammer === undefined ? 1 : P.hammer;
  const ha = lerp(-0.35, 0.6, hz);
  push3(sc, mAbout(0, 2.4, -0.3, mRX(ha)));
  // a ring hammer: a curved brass spur with a hole through it
  const hp = spline([[0, 2.6, -0.3], [0, 1.4, -0.45], [0, 0.4, -0.8], [0, 0.0, -1.2]], 3);
  loft(sc, hp, (t) => [0.3, 0.5 - t * 0.1], blacked, { segs: 8, up: [1, 0, 0], capEnd: 'round', capLen: 0.6 });
  box3(sc, -0.34, -0.3, -1.5, 0.34, 0.2, -0.9, Object.assign({}, blacked, {
    shade(S) {
      blacked.shade(S);
      // checkering on the thumb spur
      if (S.face === F_TOP || S.face === F_REAR) {
        const k = ((floor(S.u * 5) + floor(S.v * 5)) & 1);
        S.col = shadeC(S.col, k ? 1.2 : 0.62);
      }
    },
  }));
  pop3(sc);
  // beavertail
  box3(sc, -1.5, 3.6, -2.3, 1.5, 4.6, 1.0, blacked, {
    mod: (C) => { C[0][0] *= 0.6; C[1][0] *= 0.6; C[3][0] *= 0.6; C[2][0] *= 0.6; C[0][1] += 0.4; C[1][1] += 0.4; },
  });

  // ---- trigger guard and trigger ----
  const guard = spline([[0, 4.9, 14.0], [0, 8.0, 12.8], [0, 9.0, 10.0], [0, 8.7, 7.0], [0, 7.8, 5.2]], 4);
  loft(sc, guard, () => [0.36, 0.62], blacked, { segs: 8, up: [1, 0, 0] });
  const trig = spline([[0, 4.9, 8.4], [0, 6.1, 8.9], [0, 7.3, 8.5]], 3);
  loft(sc, trig, (t) => [0.3, 0.55 - t * 0.1], brass, { segs: 8, up: [1, 0, 0], capEnd: 'round' });

  // ---- grip: pearl panels on a black frame, a brass medallion ----
  const gt = W.gripTop, gd = W.gripDir;
  const gpts = [];
  for (let i = 0; i <= 6; i++) gpts.push(vAdd(gt, vMul(gd, i * 2.3)));
  loft(sc, gpts, (t) => [1.62, 2.75 - t * 0.2], PEARL3, { segs: 16, up: [1, 0, 0], capEnd: 'flat', capMat: brass });
  // front and back straps in black
  loft(sc, gpts.map((p) => vAdd(p, [0, 0.4, 2.4])), () => [0.9, 0.6], blacked, { segs: 8, up: [1, 0, 0] });
  loft(sc, gpts.map((p) => vAdd(p, [0, -0.4, -2.45])), () => [1.0, 0.55], blacked, { segs: 8, up: [1, 0, 0] });

  // ---- the casing, kicked out of the port on the way back ----
  if (P.casing) {
    const t = P.casing;
    const cp = vAdd(W.port, [2.2 + t * 5.5, -2 - t * 5 + t * t * 3, -t * 1.5]);
    push3(sc, mChain(mT(cp[0], cp[1], cp[2]), mRZ(0.8 + t * 3.4), mRX(0.5 + t * 2)));
    tube3(sc, [0, 0, -1.2], [0, 0, 1.2], 0.52, 0.5, brass3({ seed: 23 }), { segs: 10, capStart: 'flat', capEnd: 'flat' });
    pop3(sc);
  }

  // ---- the hand ----
  const a = gd, p = [1, 0, 0], q = vNorm(vCross(p, a));
  hand3(sc, {
    c: vAdd(gt, vMul(a, 0.2)), a, p: [1, 0, 0], q: vMul(q, 1), rp: 1.7, rq: 2.75,
    s: [null, 2.55, 4.6, 6.5], sMid: 3.8, mcpQ: 0.4, wrap: 1, slope: 0.05,
    trigger: [[0.9, 2.8, 0.2], [0.3, 2.5, 3.0], [-0.1, 1.4, 4.6], [-0.3, 0.2, 5.1]],
    thumbL: [[1.6, 6.4, -3.2], [-0.2, 5.0, -2.2], [-1.8, 4.5, 0.2], [-2.2, 4.3, 2.8], [-2.15, 4.2, 5.2]],
    thumbCut: 4.6, thumbNailV: 0.4, thumbR: [1.45, 1.2, 1.08, 0.98],
    wristL: [3.2, 7.0, -4.0], wristQ: -6.6,
    arm: [0.22, 0.3, -1], armLen: 36, armUp: [1, -0.3, 0], armBend: [0.05, 0.25, 0],
    tattoo: { u: 15, v: 0.62, s: 2.6 }, seed: 7,
  });

  return { muzzle: [0, W.muzzle[1], W.len + 3.8] };
}

// ---------------------------------------------------------------------------
// more gun materials
// ---------------------------------------------------------------------------

/** Walnut with the grain running along u. */
function wood3(o = {}) {
  const { seed = 3, dark = 0 } = o;
  const so = seed * 0.71;
  return {
    col: WOOD, gl: 0.34, bevel: o.bevel,
    shade(S) {
      const g = nz3(S.u * 0.12 + so, S.v * 2.6 + so);
      const rings = 0.5 + 0.5 * sin(g * 22 + S.v * 9);
      let c = mix(shadeC(WOOD_D, 1 - dark), shadeC(WOOD, 1 - dark), clamp(0.2 + rings * 0.85, 0, 1));
      c = shadeC(c, 0.86 + nz3(S.u * 0.6, S.v * 3 + so) * 0.3);
      if (cell3(S.u * 2, S.v * 14, seed) > 0.97) c = shadeC(c, 0.6);      // dings
      c = mix(c, rgba(20, 12, 8, 255), clamp((1 - S.ao) * 1.3, 0, 0.6));
      // oil polish rubbed bright on the high points
      S.col = mix(c, rgba(196, 140, 92, 255), clamp(S.edge * 0.4, 0, 0.4));
      S.gl = 0.28 + rings * 0.14;
      if (o.decal) o.decal(S);
    },
  };
}

/** Electrical tape wound round a handle: overlapping bands on a spiral. */
function tape3(col = TAPE, o = {}) {
  const pitch = o.pitch || 1.6;
  return {
    col, gl: 0.42,
    shade(S) {
      const t = (S.u + S.v * 0.9) / pitch;
      const k = t - floor(t);
      let c = shadeC(col, 0.88 + nz3(S.u * 0.7, S.v * 5) * 0.3);
      if (k < 0.1) { c = shadeC(c, 0.55); S.ny += 0.3; }        // the overlap step
      else if (k < 0.2) c = shadeC(c, 1.25);
      c = mix(c, rgba(8, 8, 10, 255), clamp((1 - S.ao) * 0.9, 0, 0.5));
      S.col = c; S.gl = 0.36 + (k > 0.3 && k < 0.6 ? 0.2 : 0);
    },
  };
}

/**
 * Temper colours on a hot barrel: straw, bronze, purple, blue, walking back
 * from the muzzle end. `from` is where along u the colour starts.
 */
function heatBlued3(o = {}) {
  const from = o.from || 10, to = o.to || 30;
  const base = metal3(o.col || rgba(40, 43, 54, 255), {
    gl: 0.6, grain: 0.1, brush: 0.1, scratch: 0.5, wear: 0.5, grime: 0.5, seed: o.seed || 31,
    bare: rgba(150, 152, 162, 255), refl: 0.6,
  });
  const inner = base.shade;
  base.shade = (S) => {
    inner(S);
    const t = clamp((S.u - from) / (to - from), 0, 1);
    if (t <= 0) return;
    const w = t + (nz3(S.u * 0.3, S.v * 2) - 0.5) * 0.25;
    const tc = w < 0.3 ? rgba(70, 90, 150, 255) : w < 0.55 ? rgba(118, 70, 132, 255)
      : w < 0.8 ? rgba(170, 110, 60, 255) : rgba(206, 178, 110, 255);
    S.col = mix(S.col, tc, clamp(t * 1.2, 0, 0.42));
  };
  return base;
}

/** A fat flak shell: red ribbed hull, brass head, primer. Local axis +z. */
function shell3(sc, M, o = {}) {
  push3(sc, M);
  const len = o.len || 6.2, r = o.r || 1.15;
  const hull = {
    col: o.hull || rgba(168, 34, 30, 255), gl: 0.5,
    shade(S) {
      let c = shadeC(S.col, 0.9 + nz3(S.u * 0.8, S.v * 3) * 0.25);
      if ((floor(S.v * 24) & 1) === 0) c = shadeC(c, 0.86);         // ribbed plastic
      if (S.u > len - 0.9) c = shadeC(c, 0.8);                          // crimp
      c = mix(c, rgba(24, 8, 8, 255), clamp((1 - S.ao) * 1.2, 0, 0.6));
      S.col = c;
    },
  };
  tube3(sc, [0, 0, 1.4], [0, 0, len], r, r * 0.97, hull, { segs: 12, capEnd: 'flat' });
  const head = brass3({ seed: o.seed || 41 });
  tube3(sc, [0, 0, 0], [0, 0, 1.5], r * 1.1, r * 1.03, head, {
    segs: 12, capStart: 'flat',
    capMat: flat3(BRASS, 0.7, (S) => {
      // head stamp: the primer and a ring
      const d = S.v;
      S.col = d < 0.3 ? rgba(170, 110, 70, 255) : d < 0.38 ? rgba(96, 70, 32, 255) : shadeC(BRASS, 0.9 + d * 0.3);
      S.gl = 0.7;
      if (o.spent && d < 0.3) S.col = rgba(60, 40, 30, 255);
    }),
  });
  pop3(sc);
}

// ---------------------------------------------------------------------------
// WEAPON 2 - THE SPLITTER: sawn-off triple flak shotgun, pump action
// ---------------------------------------------------------------------------

const SPLITTER3 = {
  pos: [6.5, 6.0, 6.0], yaw: -0.22, pitch: 0.0, roll: 0.2,
  // three barrels side by side by side, as (x, y) at the breech face
  bores: [[-3.15, 1.75], [0, 1.6], [3.15, 1.75]],
  br: 1.55, brlFrom: 10.5, brlTo: 40,
};

function drawSplitter3(sc, P) {
  const S3 = SPLITTER3;
  const pump = P.pump || 0;          // 0 forward, 1 racked back
  const recv = metal3(rgba(38, 38, 40, 255), {
    gl: 0.42, grain: 0.14, scratch: 0.9, wear: 0.9, grime: 0.7, seed: 51, bevel: 0.6, refl: 0.45,
    bare: rgba(150, 150, 146, 255),
    decal: (S) => {
      if (S.face === F_TOP) {
        // engraved top plate: a stencilled name between two rivet rows
        const mid = S.prim.su / 2;
        if (glyph3('SPLITTER', S.v, S.u - mid + 0.55, 1.2, 0, 1.1)) S.col = mix(S.col, rgba(226, 190, 96, 255), 0.85);
        if (abs(S.u - mid) > S.prim.su / 2 - 1.1 && ((S.v % 1.6) < 0.2)) S.col = shadeC(S.col, 0.4);
      }
      if (S.face === F_LEFT) {
        if (glyph3('3X FLAK', S.prim.su - S.u, S.v, 1.0, 1.0, 0.9)) S.col = mix(S.col, rgba(206, 196, 160, 255), 0.7);
      }
      if (S.face === F_REAR) {
        // hazard chevrons on the receiver's back plate
        const t = ((S.u + S.v) * 0.7) % 1;
        if (S.v > S.prim.sv - 2.0) S.col = mix(S.col, t < 0.5 ? HAZ_Y : rgba(26, 22, 18, 255), 0.8);
      }
    },
  });
  const steel = metal3(rgba(78, 80, 88, 255), { gl: 0.52, grain: 0.1, scratch: 0.7, wear: 0.7, seed: 53, bevel: 0.25 });

  // ---- receiver: a wide flat-topped block with sloped shoulders ----
  box3(sc, -4.9, 0, 0, 4.9, 5.6, 11.0, recv, {
    mod: (C) => {
      for (const k of [0, 1, 4, 5]) C[k][0] *= 0.84;
      C[0][2] = C[1][2] = 0.8;            // chamfered top rear edge
    },
  });
  // ---- the barrels ----
  const blued = heatBlued3({ from: 12, to: S3.brlTo - S3.brlFrom, seed: 55 });
  for (const [bx, by] of S3.bores) {
    tube3(sc, [bx, by, S3.brlFrom], [bx, by, S3.brlTo], S3.br, S3.br * 0.97, blued, {
      segs: 16, rings: 4, capEnd: 'flat',
      capMat: flat3(rgba(40, 40, 46, 255), 0.5, (S) => { S.col = S.v < 0.72 ? rgba(12, 10, 12, 255) : rgba(120, 120, 128, 255); }),
    });
  }
  // vented ribs in the two valleys, bead on the middle barrel
  for (const x of [-1.58, 1.58]) {
    box3(sc, x - 0.28, 0.2, S3.brlFrom + 0.5, x + 0.28, 1.2, S3.brlTo - 0.3, steel);
  }
  ball3(sc, [0, -0.2, S3.brlTo - 1.0], 0.34, 0.34, 0.34, flat3(rgba(236, 224, 190, 255), 0.6, null, { em: 0.3 }), { rings: 4, segs: 8 });
  // a slotted muzzle brake clamped over all three: the business end
  const brake = metal3(rgba(52, 52, 56, 255), {
    gl: 0.5, grain: 0.12, scratch: 0.6, wear: 0.9, seed: 61, bevel: 0.35, refl: 0.5,
    decal: (S) => {
      if ((S.face === F_TOP || S.face === F_LEFT || S.face === F_RIGHT) && ((S.face === F_TOP ? S.v : S.u) % 1.2) < 0.5
        && (S.face === F_TOP ? S.v : S.u) > 0.4) { S.col = rgba(12, 10, 10, 255); S.gl = 0.1; }
    },
  });
  box3(sc, -5.1, -0.3, S3.brlTo - 1.2, 5.1, 3.7, S3.brlTo + 2.4, brake, {
    mod: (C) => { for (const k of [0, 1, 4, 5]) C[k][0] *= 0.86; },
  });
  // barrel bands, one at the breech and one at the muzzle
  for (const z of [S3.brlFrom + 1.4, S3.brlTo - 2.6]) {
    box3(sc, -5.0, -0.2, z, 5.0, 3.6, z + 1.3, steel, {
      mod: (C) => { for (const k of [0, 1, 4, 5]) C[k][0] *= 0.9; },
    });
  }

  // ---- magazine tube and the pump ----
  tube3(sc, [0, 4.7, 11], [0, 4.7, S3.brlTo - 1.5], 1.05, 1.05, steel, { segs: 10, capEnd: 'flat' });
  const pz = -pump * 6.5;
  push3(sc, mT(0, 0, pz));
  const woodP = wood3({ seed: 59 });
  const grooves = Object.assign({}, woodP, {
    shade(S) {
      woodP.shade(S);
      // finger grooves cut along the fore-end
      if (S.u > 1.2 && S.u < 10.2 && (S.v * 18) % 1 < 0.28) { S.col = shadeC(S.col, 0.5); S.nx *= 0.6; }
    },
  });
  // the fore-end wraps the lower half of all three barrels, so there is wood
  // to see either side of them from behind
  loft(sc, [[0, 4.2, 17], [0, 4.2, 18], [0, 4.3, 23], [0, 4.2, 28], [0, 4.2, 29]],
    (t) => { const e = smoothstep(0, 0.1, t) * smoothstep(1, 0.9, t); return [2.5 + e * 0.3, 5.5 + e * 0.35]; },
    grooves, { segs: 20, up: [0, 1, 0] });
  pop3(sc);

  // ---- trigger guard, trigger, pistol grip ----
  const guard = spline([[0, 5.4, 9.0], [0, 8.4, 8.4], [0, 9.1, 5.8], [0, 8.3, 3.4], [0, 6.9, 2.4]], 4);
  loft(sc, guard, () => [0.42, 0.7], steel, { segs: 8, up: [1, 0, 0] });
  loft(sc, spline([[0, 5.4, 5.6], [0, 6.8, 6.0], [0, 7.9, 5.6]], 3), (t) => [0.32, 0.55 - t * 0.1],
    brass3({ bevel: 0.1 }), { segs: 8, up: [1, 0, 0], capEnd: 'round' });
  const gTop = [0, 5.2, 1.6], gDir = vNorm([0, 12, -5.4]);
  const gpts = [];
  for (let i = 0; i <= 6; i++) gpts.push(vAdd(gTop, vMul(gDir, i * 2.3)));
  loft(sc, gpts, (t) => [1.75, 2.7 - t * 0.2], tape3(), { segs: 16, up: [1, 0, 0], capEnd: 'flat', capMat: steel });

  // ---- a spent hull flipping out of the port ----
  if (P.hull) {
    const t = P.hull;
    shell3(sc, mChain(mT(6 + t * 7, 1 - t * 8 + t * t * 6, 6 - t * 4), mRZ(1.2 + t * 2.6), mRY(1.2 + t)),
      { seed: 71, len: 5.8, r: 1.0, spent: 1, hull: rgba(120, 30, 26, 255) });
  }

  // ---- hands: right on the grip, left on the pump ----
  const a = gDir, q = vNorm(vCross([1, 0, 0], a));
  hand3(sc, {
    c: vAdd(gTop, vMul(a, 0.3)), a, p: [1, 0, 0], q, rp: 1.75, rq: 2.7,
    s: [null, 2.55, 4.6, 6.5], sMid: 3.8, mcpQ: 0.4, slope: 0.05,
    triggerL: [[2.4, 6.9, 1.0], [2.0, 6.9, 3.8], [0.9, 6.9, 5.4], [0.3, 6.8, 5.9]],
    thumbL: [[1.8, 6.4, -2.6], [-0.2, 5.4, -1.8], [-2.2, 4.8, 0.2], [-3.0, 4.4, 2.6], [-3.0, 4.1, 5.0]],
    thumbCut: 4.2, thumbNailV: 0.4, thumbR: [1.45, 1.2, 1.08, 0.98],
    wristL: [3.4, 9.4, -3.6], wristQ: -6.6,
    arm: [0.32, 0.22, -1], armLen: 36, armUp: [1, -0.3, 0], armBend: [0.05, 0.2, 0],
    tattoo: { u: 16, v: 0.62, s: 2.6 }, seed: 7,
  });
  // left hand under the pump: palm below-left, fingers curling up the right side
  push3(sc, mT(0, 0, pz));
  const pa = [0, 0, -1], pp = vNorm([-0.35, 1, 0]);
  const pq = vNorm([1, 0.35, 0]);
  hand3(sc, {
    c: [0, 4.2, 27.6], a: pa, p: pp, q: pq, rp: 2.7, rq: 5.7,
    s: [0, 2.05, 4.05, 5.85], sMid: 2.9, mcpQ: -0.8, slope: 0.0, fscale: 1.0,
    thumbL: [[-6.2, 8.0, 21.6], [-7.2, 6.0, 23.6], [-6.9, 4.1, 25.6], [-6.5, 3.3, 27.5], [-6.2, 3.0, 29.2]],
    thumbCut: 4.2, thumbNailV: 0.6, thumbR: [1.45, 1.2, 1.08, 0.98], thumbUp: [0, -1, 0],
    wristL: [-7.4, 7.4, 22.6], wristQ: -6.4,
    arm: [-0.62, 0.3, -1], armLen: 38, armUp: [-1, -0.3, 0], armBend: [-0.1, 0.25, 0],
    tattoo: { u: 14, v: 0.35, s: 2.4, word: 'NUKE' }, seed: 13, pads: false,
  });
  pop3(sc);

  return { muzzle: [0, 1.6, S3.brlTo + 2.6] };
}

/**
 * The right hand on a pistol grip: gTop is the top of the grip's axis in
 * gun-local space, gDir runs down it, trig is the trigger's contact point.
 * The thumb rides the left of the frame at thumbY, pointing forward.
 */
function rightGrip3(sc, gTop, gDir, trig, o = {}) {
  const a = gDir, q = vNorm(vCross([1, 0, 0], a));
  const T = (dx, dy, dz) => [gTop[0] + dx, gTop[1] + dy, gTop[2] + dz];
  const ty = o.thumbY === undefined ? -0.6 : o.thumbY;
  const tx = o.thumbX === undefined ? -3.0 : o.thumbX;
  hand3(sc, Object.assign({
    c: vAdd(gTop, vMul(a, 0.3)), a, p: [1, 0, 0], q, rp: o.rp || 1.75, rq: o.rq || 2.7,
    s: [null, 2.55, 4.6, 6.5], sMid: 3.8, mcpQ: 0.4, slope: 0.05,
    triggerL: [T(2.4, 1.6, -0.8), T(2.1, 1.5, (trig[2] - gTop[2]) * 0.5), vAdd(trig, [0.9, 0.1, -0.4]), vAdd(trig, [0.3, 0.3, 0.1])],
    thumbL: [T(1.8, 1.2, -4.2), T(-0.2, 0.2, -3.4), T(tx + 0.8, ty + 0.2, -1.4), T(tx, ty, 1.0), T(tx, ty - 0.2, 3.4)],
    thumbCut: 4.2, thumbNailV: 0.4, thumbR: [1.45, 1.2, 1.08, 0.98],
    wristL: T(3.4, 4.2, -5.2), wristQ: -6.6,
    arm: [0.3, 0.24, -1], armLen: 36, armUp: [1, -0.3, 0], armBend: [0.05, 0.2, 0],
    tattoo: { u: 16, v: 0.62, s: 2.6 }, seed: 7,
  }, o.hand || {}));
}

/**
 * The left hand under a horizontal fore-end whose axis runs along z through
 * (cx, cy): palm below, fingers curling up the far side, thumb along the near
 * side, forearm coming in from the lower left. `hw`, `hh` are its half sizes.
 */
function leftForeGrip3(sc, cx, cy, z, hw, hh, o = {}) {
  hand3(sc, Object.assign({
    c: [cx, cy, z], a: [0, 0, -1], p: vNorm([-0.35, 1, 0]), q: vNorm([1, 0.35, 0]), rp: hh + 0.2, rq: hw,
    s: [0, 2.05, 4.05, 5.85], sMid: 2.9, mcpQ: -0.8, slope: 0.0,
    thumbL: [[cx - hw - 0.5, cy + hh + 1.8, z - 6], [cx - hw - 1.5, cy + hh * 0.6 + 0.4, z - 4],
      [cx - hw - 1.2, cy - hh * 0.05, z - 2], [cx - hw - 0.8, cy - hh * 0.35, z - 0.1], [cx - hw - 0.5, cy - hh * 0.45, z + 1.6]],
    thumbCut: 4.2, thumbNailV: 0.6, thumbR: [1.45, 1.2, 1.08, 0.98], thumbUp: [0, -1, 0],
    wristL: [cx - hw - 1.7, cy + hh + 1.2, z - 5.0], wristQ: -6.4,
    arm: [-0.62, 0.3, -1], armLen: 38, armUp: [-1, -0.3, 0], armBend: [-0.1, 0.25, 0],
    tattoo: { u: 14, v: 0.35, s: 2.4, word: 'NUKE' }, seed: 13, pads: false,
  }, o));
}

// ---------------------------------------------------------------------------
// WEAPON 3 - THE NAILDRIVER: a rotary rivet gun off the plant floor
// ---------------------------------------------------------------------------

const NAILER3 = {
  pos: [6.5, 5.6, 13], yaw: -0.3, pitch: 0.0, roll: 0.28,
  axis: [0, 3.2], barrelsFrom: 13.6, barrelsTo: 36,
};

/** Industrial yellow paint over steel, chipped at every edge. */
function paint3(col, o = {}) {
  return metal3(col, {
    gl: 0.36, grain: 0.12, brush: 0.02, scratch: 1.2, wear: 1.0, grime: 0.8, seed: o.seed || 81,
    bare: rgba(150, 150, 150, 255), bevel: o.bevel, decal: o.decal, refl: 0.35,
  });
}

function drawNailer3(sc, P) {
  const N3 = NAILER3;
  const spin = P.spin || 0;
  const heat = P.heat || 0;
  const [ax, ay] = N3.axis;
  const steel = metal3(rgba(74, 76, 84, 255), { gl: 0.55, grain: 0.1, scratch: 0.7, wear: 0.7, seed: 83, bevel: 0.25 });
  const dark = metal3(rgba(40, 40, 46, 255), { gl: 0.45, grain: 0.12, scratch: 0.6, wear: 0.5, seed: 85, bevel: 0.3 });
  const body = paint3(INDY, {
    bevel: 0.7,
    decal: (S) => {
      if (S.face === F_TOP || S.face === F_LEFT) {
        // hazard stripes at the front of the housing
        const f = S.face === F_TOP ? S.v : S.u;
        const g = S.face === F_TOP ? S.u : S.v;
        if (f > S.prim.su * 0 + (S.face === F_TOP ? S.prim.sv : S.prim.su) - 3.2) {
          const t = ((f + g) * 0.55) % 1;
          S.col = mix(S.col, t < 0.5 ? rgba(20, 18, 16, 255) : S.col, 0.85);
        }
      }
      if (S.face === F_LEFT) {
        if (glyph3('NAILDRIVER', S.prim.su - S.u, S.v, 1.4, 1.2, 1.0)) S.col = mix(S.col, rgba(24, 20, 16, 255), 0.85);
        if (glyph3('DANGER 900 PSI', S.prim.su - S.u, S.v, 1.4, 3.0, 0.55)) S.col = mix(S.col, rgba(150, 30, 24, 255), 0.85);
        // cooling slots
        if (S.u > 10 && S.u < 13.4 && S.v > 1.4 && S.v < 5.2 && ((S.v * 1.4) % 1) < 0.45) {
          S.col = rgba(16, 14, 12, 255); S.gl = 0.1; S.ao *= 0.6;
        }
      }
      if (S.face === F_REAR) {
        if (glyph3('NO', S.u, S.v, 1.6, 1.0, 1.2)) S.col = mix(S.col, rgba(24, 20, 16, 255), 0.8);
      }
    },
  });

  // ---- motor housing ----
  box3(sc, -3.4, 0, 0, 3.4, 6.8, 13.8, body, {
    mod: (C) => { for (const k of [0, 1, 4, 5]) C[k][0] *= 0.78; C[4][1] = C[5][1] = 0.6; },
  });
  // front bearing plate
  box3(sc, -3.9, -0.4, 13.0, 3.9, 7.1, 14.6, dark);
  // top rail with a peep sight
  box3(sc, -0.6, -0.8, 1.0, 0.6, 0.05, 12.6, steel);
  box3(sc, -1.0, -2.0, 1.5, 1.0, -0.7, 2.6, steel, { mod: (C) => { C[0][0] += 0.3; C[1][0] -= 0.3; } });

  // ---- the pressure gauge on the back, where he can watch it ----
  push3(sc, mChain(mT(-3.4, 1.6, 3.0), mRY(-1.1), mRX(0.35)));
  tube3(sc, [0, 0, 0], [0, 0, 1.4], 1.9, 1.9, steel, { segs: 16, capEnd: 'flat', capStart: 'flat',
    capMat: flat3(DIAL_FACE, 0.5, (S) => {
      const r = S.v, ang = S.u * TAU;
      let c = rgba(232, 226, 206, 255);
      if (r > 0.86) c = rgba(40, 40, 44, 255);
      else if (r > 0.62 && ang > 3.6 && ang < 5.2) c = rgba(200, 40, 30, 255);      // red zone
      else if (r > 0.62 && (floor(ang * 6) & 1)) c = rgba(40, 36, 32, 255);
      // needle, sitting high in the red when firing
      const na = lerp(1.2, 4.4, P.pressure === undefined ? 0.55 : P.pressure);
      let da = ang - na; if (da > PI) da -= TAU; if (da < -PI) da += TAU;
      if (abs(da) < 0.12 && r < 0.8) c = rgba(190, 20, 20, 255);
      if (r < 0.14) c = rgba(30, 30, 30, 255);
      S.col = c; S.gl = 0.7;
    }) });
  pop3(sc);

  // ---- the barrel cluster: six rivet barrels round an axle, spinning ----
  const blued = heatBlued3({ from: 6, to: N3.barrelsTo - N3.barrelsFrom, seed: 87, col: rgba(84, 86, 96, 255) });
  push3(sc, mAbout(ax, ay, 0, mRZ(spin)));
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * TAU;
    const bx = ax + cos(a) * 2.6, by = ay + sin(a) * 2.6;
    tube3(sc, [bx, by, N3.barrelsFrom], [bx, by, N3.barrelsTo], 0.95, 0.92, blued, {
      segs: 10, rings: 3, capEnd: 'flat',
      capMat: flat3(rgba(30, 30, 34, 255), 0.4, (S) => {
        S.col = S.v < 0.55 ? mix(rgba(12, 10, 12, 255), hotColor(0.3), heat * 0.8) : rgba(110, 110, 120, 255);
        S.em = S.v < 0.55 ? heat * 0.8 : 0;
      }),
    });
  }
  tube3(sc, [ax, ay, N3.barrelsFrom], [ax, ay, N3.barrelsTo + 0.6], 1.2, 1.2, steel, { segs: 10, capEnd: 'flat' });
  // clamp discs, with a flat so the spin reads
  for (const z of [N3.barrelsFrom + 1.4, (N3.barrelsFrom + N3.barrelsTo) / 2, N3.barrelsTo - 1.4]) {
    tube3(sc, [ax, ay, z - 0.6], [ax, ay, z + 0.6], 4.0, 4.0, Object.assign({}, dark, {
      shade(S) {
        dark.shade(S);
        const k = (S.v * 6) % 1;
        if (k < 0.18) S.col = HAZ_Y;
      },
    }), { segs: 18, capStart: 'flat', capEnd: 'flat' });
  }
  pop3(sc);

  // ---- nail drum on the left, with a window full of nails ----
  // a pan magazine lying flat on top, Lewis-gun style, so he can watch it empty
  push3(sc, mChain(mT(1.2, -0.4, 5.6), mRX(PI / 2)));
  const drumMat = paint3(rgba(58, 60, 62, 255), { seed: 89, bevel: 0.3 });
  tube3(sc, [0, 0, -0.2], [0, 0, 1.7], 3.7, 3.7, drumMat, {
    segs: 24, capEnd: 'flat', capStart: 'flat',
    capMat: flat3(rgba(64, 66, 70, 255), 0.5, (S) => {
      const r = S.v, ang = S.u * TAU;
      let c = shadeC(rgba(66, 68, 72, 255), 0.9 + nz3(r * 3, ang) * 0.2);
      // a spiral window showing the coil of nails
      const sp = (r * 5 - ang / TAU * 1.0) % 1;
      if (r > 0.25 && r < 0.9 && ang > 0.6 && ang < 2.9) {
        c = sp < 0.5 ? rgba(186, 186, 194, 255) : rgba(26, 24, 26, 255);
        S.gl = 0.8;
      }
      if (r > 0.94) c = HAZ_Y;
      if (r < 0.14) c = rgba(170, 170, 176, 255);
      S.col = c;
    }),
  });
  pop3(sc);

  // ---- air hose: out of the back, down and away ----
  const hose = spline([[2.4, 6.2, 1.0], [3.6, 7.6, -2.0], [4.4, 10.5, -3.6], [5.2, 16, -3.0], [6.0, 24, -2.0]], 4);
  loft(sc, hose, () => 1.05, {
    col: rgba(150, 40, 30, 255), gl: 0.35,
    shade(S) {
      let c = shadeC(S.col, 0.85 + nz3(S.u, S.v * 4) * 0.3);
      if ((S.u * 2.2) % 1 < 0.3) { c = shadeC(c, 0.62); S.nz -= 0.2; }          // ribbing
      c = mix(c, rgba(20, 10, 8, 255), clamp((1 - S.ao) * 1.2, 0, 0.6));
      S.col = c;
    },
  }, { segs: 12, up: [1, 0, 0] });
  tube3(sc, [2.2, 5.8, 1.6], [2.4, 6.3, -0.4], 1.4, 1.4, brass3({ seed: 91 }), { segs: 12 });

  // ---- grips: pistol grip at the back, a side handle up front ----
  const gTop = [0, 6.6, 2.2], gDir = vNorm([0, 12, -4.8]);
  const gpts = [];
  for (let i = 0; i <= 6; i++) gpts.push(vAdd(gTop, vMul(gDir, i * 2.3)));
  loft(sc, gpts, (t) => [1.75, 2.7 - t * 0.2], {
    col: rgba(34, 32, 30, 255), gl: 0.3,
    shade(S) {
      const k = (S.u * 1.6) % 1;
      S.col = shadeC(S.col, k < 0.25 ? 0.6 : 1.0 + nz3(S.u, S.v * 5) * 0.3);
      S.col = mix(S.col, rgba(8, 8, 8, 255), clamp((1 - S.ao) * 1.0, 0, 0.6));
    },
  }, { segs: 16, up: [1, 0, 0], capEnd: 'flat', capMat: dark });
  const guard = spline([[0, 6.6, 9.5], [0, 9.2, 8.8], [0, 9.8, 6.2], [0, 9.0, 4.0], [0, 7.6, 3.0]], 4);
  loft(sc, guard, () => [0.42, 0.7], dark, { segs: 8, up: [1, 0, 0] });
  loft(sc, spline([[0, 6.6, 6.2], [0, 7.8, 6.6], [0, 8.8, 6.2]], 3), (t) => [0.34, 0.6 - t * 0.1],
    paint3(rgba(190, 40, 30, 255), { seed: 93 }), { segs: 8, up: [1, 0, 0], capEnd: 'round' });
  // a vertical grip on an outrigger off the left flank, for the other hand
  box3(sc, -6.4, 3.0, 10.6, -3.2, 4.4, 13.0, dark);
  const vgTop = [-5.6, 4.4, 11.8], vgDir = vNorm([0, 1, -0.25]);
  const vg = [];
  for (let i = 0; i <= 5; i++) vg.push(vAdd(vgTop, vMul(vgDir, i * 2.0)));
  loft(sc, vg, (t) => [1.45, 1.8 - t * 0.15], {
    col: rgba(40, 38, 36, 255), gl: 0.3,
    shade(S) {
      const k = (S.u * 1.4) % 1;
      S.col = shadeC(S.col, k < 0.28 ? 0.62 : 1.0 + nz3(S.u, S.v * 5) * 0.25);
      S.col = mix(S.col, rgba(8, 8, 8, 255), clamp((1 - S.ao) * 1.0, 0, 0.6));
    },
  }, { segs: 14, capEnd: 'round', up: [1, 0, 0] });

  rightGrip3(sc, gTop, gDir, [0, 7.8, 6.6], { thumbY: -1.2, thumbX: -3.7 });
  // left hand on the vertical grip: palm on its left, fingers round the front
  const la = vgDir, lp = [-1, 0, 0], lq = vNorm(vMul(vCross(lp, la), -1));
  hand3(sc, {
    c: vAdd(vgTop, vMul(la, 0.4)), a: la, p: lp, q: lq, rp: 1.45, rq: 1.8,
    s: [0.4, 2.45, 4.45, 6.25], sMid: 3.3, mcpQ: 0.4, slope: 0.0,
    thumbL: [[-8.4, 6.6, 7.4], [-7.4, 5.0, 8.6], [-5.6, 4.6, 9.6], [-4.0, 5.0, 10.2], [-3.4, 5.4, 11.2]],
    thumbCut: 4.2, thumbNailV: 0.6, thumbR: [1.45, 1.2, 1.08, 0.98], thumbUp: [0, -1, 0],
    wristL: [-9.0, 8.2, 7.0], wristQ: -6.4,
    arm: [-0.55, 0.3, -1], armLen: 38, armUp: [-1, -0.3, 0], armBend: [-0.1, 0.25, 0],
    tattoo: { u: 14, v: 0.35, s: 2.4, word: 'NUKE' }, seed: 13,
  });

  return { muzzle: [ax, ay, N3.barrelsTo + 0.6] };
}

// ---------------------------------------------------------------------------
// WEAPON 4 - THE HALO: flak-ring projector
// ---------------------------------------------------------------------------

const HALO3 = {
  pos: [6.0, 6.0, 12], yaw: -0.25, pitch: 0.0, roll: 0.2,
  ringZ: 34, ringR: 4.8,
};

function drawHalo3(sc, P) {
  const H3 = HALO3;
  const charge = P.charge === undefined ? 1 : P.charge;
  const arc = P.arc || 0;
  const body = metal3(CHAR, {
    gl: 0.5, grain: 0.1, scratch: 0.8, wear: 0.6, grime: 0.6, seed: 101, bevel: 0.6,
    bare: rgba(160, 164, 176, 255),
    decal: (S) => {
      if (S.face === F_LEFT) {
        if (glyph3('HALO', S.prim.su - S.u, S.v, 2.0, 1.1, 1.3)) S.col = mix(S.col, CYAN, 0.7);
        if (glyph3('RING PROJECTOR MK2', S.prim.su - S.u, S.v, 2.0, 3.0, 0.45)) S.col = mix(S.col, rgba(170, 176, 190, 255), 0.6);
      }
      if (S.face === F_TOP && abs(S.u - S.prim.su / 2) < 0.35) { S.col = mix(S.col, CYAN_D, 0.6); S.em = 0.3 * charge; }
    },
  });
  const steel = metal3(rgba(90, 92, 100, 255), { gl: 0.6, grain: 0.1, scratch: 0.6, wear: 0.6, seed: 103, bevel: 0.25 });
  const copper = metal3(COPPER, {
    gl: 0.7, grain: 0.1, brush: 0.2, scratch: 0.3, wear: 0.3, seed: 105, bare: rgba(240, 180, 130, 255),
  });
  const glow = (k) => flat3(CYAN, 0.2, (S) => {
    const f = 0.7 + 0.3 * sin(S.u * 3 + S.v * 20);
    S.col = mix(CYAN_D, rgba(220, 250, 255, 255), clamp(k * f, 0, 1)); S.em = clamp(0.4 + k * 0.6, 0, 1);
  });

  // ---- the spine ----
  box3(sc, -3.0, 0, 0, 3.0, 6.4, 20, body, {
    mod: (C) => { for (const k of [0, 1, 4, 5]) C[k][0] *= 0.7; for (const k of [4, 5, 6, 7]) { C[k][0] *= 0.85; } C[7][1] = C[6][1] = 5.2; },
  });
  // barrel: a fat tube out to the emitter
  tube3(sc, [0, 3.0, 19], [0, 3.0, H3.ringZ], 1.9, 1.7, steel, { segs: 16, rings: 3 });
  // capacitor coils down both flanks: copper windings between steel end caps
  for (const sx of [-1, 1]) {
    const cx = sx * 3.7;
    tube3(sc, [cx, 1.4, 4], [cx, 1.4, 17], 1.35, 1.35, Object.assign({}, copper, {
      shade(S) {
        copper.shade(S);
        const k = (S.u * 1.7) % 1;
        S.col = shadeC(S.col, k < 0.3 ? 0.55 : 1.08);
        S.ny += k < 0.3 ? 0.25 : -0.1;
      },
    }), { segs: 14, rings: 6 });
    for (const z of [3.4, 17.6]) tube3(sc, [cx, 1.4, z - 0.6], [cx, 1.4, z + 0.6], 1.6, 1.6, steel, { segs: 14, capStart: 'flat', capEnd: 'flat' });
    // a glowing charge strip on each coil
    tube3(sc, [cx, -0.05, 5], [cx, -0.05, 16], 0.25, 0.25, glow(charge), { segs: 6 });
  }
  // ---- the readout, tilted up at him ----
  push3(sc, mChain(mT(0, -1.2, 2.6), mRX(-0.7)));
  box3(sc, -2.4, -1.6, -0.3, 2.4, 1.6, 0.6, steel);
  box3(sc, -2.0, -1.25, -0.45, 2.0, 1.25, 0.0, flat3(rgba(10, 20, 24, 255), 0.6, (S) => {
    // charge bars and a two-digit count
    const u = S.u, v = S.v;
    let c = rgba(8, 18, 22, 255), em = 0.2;
    if (v > 0.35 && v < 1.0) {
      const cell = floor(u / 0.62);
      if ((u % 0.62) < 0.46 && cell < 6) {
        const lit = cell < charge * 6;
        c = lit ? mix(CYAN_D, CYAN, 0.8) : rgba(20, 44, 52, 255); em = lit ? 0.95 : 0.2;
      }
    }
    if (glyph3(charge > 0.95 ? 'READY' : 'CHRG', u, v, 0.35, 1.3, 0.8)) { c = CYAN; em = 0.9; }
    // scanlines
    if ((floor(S.y) & 1) === 0) c = shadeC(c, 0.85);
    S.col = c; S.em = em; S.gl = 0.7;
  }), { bias: 0.002 });
  pop3(sc);

  // ---- the emitter ring, facing away: a torus round the barrel axis ----
  const ringMat = metal3(rgba(120, 124, 136, 255), { gl: 0.7, grain: 0.08, scratch: 0.5, wear: 0.4, seed: 107 });
  const RN = 28, rr = H3.ringR, tr = 1.0;
  const rpts = [];
  for (let k = 0; k <= RN; k++) { const a = (k / RN) * TAU; rpts.push([cos(a) * rr, 3.0 + sin(a) * rr, H3.ringZ]); }
  loft(sc, rpts, () => [tr, tr * 1.5], ringMat, { segs: 10, up: [0, 0, 1] });
  // an inner ring of emitter pips, lit by the charge
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * TAU + 0.2;
    ball3(sc, [cos(a) * (rr - 1.2), 3.0 + sin(a) * (rr - 1.2), H3.ringZ - 0.4], 0.5, 0.5, 0.5, glow(charge * 0.9 + 0.1), { rings: 5, segs: 8 });
  }
  // struts from the barrel out to the ring
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * TAU + PI / 4;
    tube3(sc, [cos(a) * 1.6, 3.0 + sin(a) * 1.6, H3.ringZ - 4], [cos(a) * (rr - 0.6), 3.0 + sin(a) * (rr - 0.6), H3.ringZ - 0.3],
      0.4, 0.35, steel, { segs: 8 });
  }
  // ---- crackle: arcs jumping round the ring (emissive, no lighting) ----
  if (arc > 0.02) {
    const rng = makeRng(1101 + floor((P.arcPhase || 0) * 97));
    const boltMat = flat3(rgba(200, 250, 255, 255), 0.1, (S) => { S.col = mix(CYAN, rgba(240, 255, 255, 255), 0.6); S.em = 1; });
    const nb = 2 + floor(arc * 5);
    for (let b = 0; b < nb; b++) {
      const a0 = rng() * TAU, span = 0.5 + rng() * 0.9;
      const pts = [];
      for (let k = 0; k <= 6; k++) {
        const a = a0 + span * (k / 6);
        const off = (rng() - 0.5) * 1.6 * arc;
        pts.push([cos(a) * (rr + off), 3.0 + sin(a) * (rr + off), H3.ringZ + (rng() - 0.5) * 1.5]);
      }
      loft(sc, pts, () => 0.16 + arc * 0.1, boltMat, { segs: 4, up: [0, 0, 1] });
    }
  }

  // ---- grips ----
  const gTop = [0, 6.2, 3.2], gDir = vNorm([0, 12, -4.2]);
  const gpts = [];
  for (let i = 0; i <= 6; i++) gpts.push(vAdd(gTop, vMul(gDir, i * 2.3)));
  loft(sc, gpts, (t) => [1.75, 2.7 - t * 0.2], {
    col: rgba(40, 42, 50, 255), gl: 0.35,
    shade(S) {
      const k = ((floor(S.u * 3) + floor(S.v * 20)) & 1);
      S.col = shadeC(S.col, k ? 1.1 : 0.82);
      S.col = mix(S.col, rgba(8, 8, 10, 255), clamp((1 - S.ao) * 1.0, 0, 0.6));
    },
  }, { segs: 16, up: [1, 0, 0], capEnd: 'flat', capMat: steel });
  const guard = spline([[0, 6.2, 10.4], [0, 8.8, 9.8], [0, 9.4, 7.2], [0, 8.6, 5.0], [0, 7.2, 4.0]], 4);
  loft(sc, guard, () => [0.42, 0.7], steel, { segs: 8, up: [1, 0, 0] });
  loft(sc, spline([[0, 6.2, 7.2], [0, 7.4, 7.6], [0, 8.4, 7.2]], 3), (t) => [0.34, 0.6 - t * 0.1],
    glow(0.5), { segs: 8, up: [1, 0, 0], capEnd: 'round' });
  // fore-grip: a chunky block under the front of the spine
  box3(sc, -2.6, 5.4, 12.5, 2.6, 8.2, 19.5, body);
  rightGrip3(sc, gTop, gDir, [0, 7.4, 7.6], { thumbY: -0.8, thumbX: -3.4 });
  leftForeGrip3(sc, 0, 6.8, 18.6, 2.7, 1.5);

  return { muzzle: [0, 3.0, H3.ringZ + 0.8] };
}

// ---------------------------------------------------------------------------
// WEAPON 6 - DEADMAN'S SWITCH: a detonator you hold, and a thumb on it
// ---------------------------------------------------------------------------

const DEADMAN3 = {
  pos: [6.4, 8.8, 19], yaw: -0.3, pitch: 0.6, roll: 0.22,
};

function drawDeadman3(sc, P) {
  const cover = clamp(P.cover || 0, 0, 1);
  const plunge = clamp(P.plunge || 0, 0, 1);
  const lamp = clamp(P.lamp || 0, 0, 1);
  const count = P.count === undefined ? '09' : String(P.count);
  const alum = metal3(ALUM, {
    gl: 0.5, grain: 0.14, brush: 0.12, scratch: 1.0, wear: 0.7, grime: 0.7, seed: 121, bevel: 0.6,
    bare: rgba(210, 212, 218, 255),
    decal: (S) => {
      if (S.face !== F_TOP) return;
      const u = S.u, v = S.v;
      // warning plate at the back of the top face
      if (v < 3.2 && v > 0.6 && u > 0.8 && u < S.prim.su - 0.8) {
        const t = ((u + v) * 0.8) % 1;
        S.col = v < 1.0 || v > 2.8 ? (t < 0.5 ? HAZ_Y : rgba(24, 20, 18, 255)) : rgba(214, 196, 60, 255);
        if (v >= 1.0 && v <= 2.8 && glyph3('DO NOT', u, S.prim.sv - v, 1.4, S.prim.sv - 2.8, 0.62)) S.col = rgba(20, 16, 14, 255);
        if (v >= 1.0 && v <= 2.8 && glyph3('PRESS', u, S.prim.sv - v, 1.6, S.prim.sv - 2.0, 0.62)) S.col = rgba(20, 16, 14, 255);
        S.gl = 0.3;
      }
      if (glyph3('S-9', u, S.prim.sv - v, 0.8, 0.8, 0.8)) S.col = mix(S.col, rgba(40, 40, 44, 255), 0.7);
    },
  });
  const steel = metal3(rgba(96, 98, 106, 255), { gl: 0.6, grain: 0.1, scratch: 0.6, wear: 0.6, seed: 123, bevel: 0.2 });

  // ---- the case: z forward, top face toward him ----
  box3(sc, -3.6, 0, 0, 3.6, 4.4, 14.5, alum);
  // countdown window near the back
  box3(sc, -2.4, -0.25, 3.8, 2.4, 0.05, 6.4, flat3(rgba(20, 16, 14, 255), 0.6, (S) => {
    let c = rgba(24, 8, 6, 255), em = 0.3;
    if (glyph3(count.slice(0, 2), S.u, S.prim.sv - S.v, 0.9, 0.45, 1.6)) { c = rgba(255, 70, 40, 255); em = 1; }
    S.col = c; S.em = em; S.gl = 0.7;
  }), { skip: (1 << F_BOT) });
  // arming lamp
  ball3(sc, [2.4, -0.1, 8.0], 0.7, 0.5, 0.7, flat3(rgba(80, 20, 16, 255), 0.6, (S) => {
    S.col = mix(rgba(90, 22, 18, 255), rgba(255, 150, 110, 255), lamp); S.em = 0.2 + lamp * 0.8;
  }), { rings: 5, segs: 10 });
  // the button: chrome collar, big red mushroom, pushed down by `plunge`
  const bz = 10.2;
  tube3(sc, [0, -0.6, bz], [0, 0.05, bz], 2.4, 2.4, steel, { segs: 18, capStart: 'flat' });
  push3(sc, mT(0, plunge * 0.9, 0));
  const red = {
    col: rgba(206, 34, 28, 255), gl: 0.7,
    shade(S) {
      const n = nz3(S.u * 2, S.v * 6);
      S.col = mix(shadeC(S.col, 0.85 + n * 0.3), rgba(250, 120, 100, 255), clamp(-S.ny - 0.6, 0, 1) * 0.5);
      if (plunge > 0.5) S.em = 0.2;
    },
  };
  push3(sc, mChain(mT(0, -1.2, bz), mRX(-PI / 2)));
  ball3(sc, [0, 0, 0], 2.0, 2.0, 1.1, red, { rings: 8, segs: 16 });
  pop3(sc);
  pop3(sc);
  // ---- the flip cover, hinged at the front edge of the button well ----
  const ca = -cover * 2.0;
  push3(sc, mAbout(0, -0.6, bz + 2.8, mRX(-ca)));
  const coverMat = metal3(rgba(160, 40, 34, 255), {
    gl: 0.5, grain: 0.12, scratch: 1.0, wear: 0.9, grime: 0.5, seed: 125, bevel: 0.3, refl: 0.5,
    bare: rgba(200, 200, 206, 255),
    decal: (S) => {
      if (S.face === F_TOP && glyph3('ARM', S.u, S.prim.sv - S.v, 1.2, 1.4, 1.2)) S.col = rgba(236, 226, 206, 255);
      if (S.face === F_TOP) {
        const t = ((S.u + S.v) * 0.9) % 1;
        if (S.v > S.prim.sv - 1.0) S.col = mix(S.col, t < 0.5 ? HAZ_Y : rgba(24, 20, 18, 255), 0.85);
      }
    },
  });
  box3(sc, -2.8, -3.2, bz - 2.8, 2.8, -2.7, bz + 2.8, coverMat);
  box3(sc, -2.8, -3.2, bz - 2.8, -2.4, -0.6, bz + 2.8, coverMat);
  box3(sc, 2.4, -3.2, bz - 2.8, 2.8, -0.6, bz + 2.8, coverMat);
  box3(sc, -2.8, -3.2, bz - 3.2, 2.8, -0.6, bz - 2.8, coverMat);
  pop3(sc);
  tube3(sc, [-3.0, -0.6, bz + 2.8], [3.0, -0.6, bz + 2.8], 0.45, 0.45, steel, { segs: 8, capStart: 'flat', capEnd: 'flat' });
  // ---- wires out of the back, taped, running off down the arm ----
  for (const [wx, col] of [[-1.6, rgba(170, 36, 30, 255)], [0, rgba(36, 34, 40, 255)], [1.6, rgba(200, 170, 40, 255)]]) {
    const w = spline([[wx, 2.2, 0.4], [wx * 1.3, 3.2, -2.5], [wx * 1.8 + 2, 7, -5], [wx * 2 + 5, 14, -6]], 4);
    loft(sc, w, () => 0.42, flat3(col, 0.5, (S) => {
      S.col = mix(shadeC(col, 0.9 + nz3(S.u, S.v * 3) * 0.2), rgba(10, 8, 8, 255), clamp((1 - S.ao) * 1.2, 0, 0.6));
    }), { segs: 8, up: [1, 0, 0] });
  }
  // ---- the hand: fingers round the case, thumb on the button ----
  const thumbDown = plunge * 0.9;
  hand3(sc, {
    c: [0, 2.2, 7.6], a: [0, 0, -1], p: [1, 0, 0], q: [0, 1, 0], rp: 3.6, rq: 2.2,
    s: [-2.2, -0.2, 1.8, 3.6], sMid: 0.6, mcpQ: -1.0, slope: 0, wrap: 1,
    thumbL: [[5.2, 2.0, 3.0], [4.8, -0.2, 5.4], [3.0, -1.6 + thumbDown * 0.5, 7.6], [1.2, -1.9 + thumbDown, 9.2],
      [0.2, -2.0 + thumbDown, 10.4]],
    thumbCut: 4.6, thumbNailV: 0.5, thumbR: [1.6, 1.35, 1.15, 1.05], thumbUp: [0, -1, 0],
    wristL: [5.8, 3.6, 0.8], wristQ: -6.0,
    arm: [0.5, 0.35, -1], armLen: 36, armUp: [1, -0.4, 0], armBend: [0.05, 0.2, 0],
    tattoo: { u: 15, v: 0.6, s: 2.6 }, seed: 7,
  });
  return { muzzle: [0, -2, bz] };
}

// ---------------------------------------------------------------------------
// THE BOOT: first person kick, seen from above and behind
// ---------------------------------------------------------------------------
// Boot-local space: the sole's centre line at y = 0, toe toward +z, the top of
// the foot toward -y. The camera sees the laces, the toe cap and the shin.

const BOOT3_LEATHER = rgba(30, 28, 28, 255);

/** Polished black leather: mostly highlight, a few scuffs gone grey. */
function bootLeather3(o = {}) {
  return {
    col: BOOT3_LEATHER, gl: 0.5,
    shade(S) {
      const n = nz3(S.u * 0.5 + 7, S.v * 3);
      const f = nz3(S.u * 2.2, S.v * 11);
      let c = shadeC(BOOT3_LEATHER, 0.86 + n * 0.3 + (f - 0.5) * 0.12);
      // scuffs where the polish has gone
      const sc2 = nz3(S.u * 0.3 + 3, S.v * 1.6);
      if (sc2 > 0.68) c = mix(c, rgba(96, 84, 76, 255), (sc2 - 0.68) * 2.2);
      if (o.mud) c = mix(c, MUD, clamp((nz3(S.u * 0.5, S.v * 2.4 + 5) - 0.55) * 2.5 * o.mud, 0, 0.8));
      c = mix(c, rgba(8, 6, 6, 255), clamp((1 - S.ao) * 1.0, 0, 0.6));
      const h = studio3(S) * 0.38;
      if (h > 0.02) { c = mix(c, rgba(150, 146, 142, 255), clamp(h, 0, 0.5)); S.em = max(S.em, h * 0.4); }
      S.col = c; S.gl = 0.5 + f * 0.2;
      if (o.decal) o.decal(S);
    },
  };
}

// the last the boot is built on, as a table: z, centre height, half height,
// half width. The sole sits flat at y = +1.3 all the way along.
const BOOT_LAST = [
  [-6, -3.0, 4.3, 3.7], [0, -3.2, 4.6, 3.9], [6, -2.8, 4.1, 4.1], [12, -2.2, 3.4, 4.4],
  [18, -1.5, 2.8, 4.6], [22, -1.1, 2.4, 4.3], [25, -0.8, 2.0, 3.4],
];
function bootAt(z) {
  const T = BOOT_LAST;
  if (z <= T[0][0]) return T[0];
  for (let i = 1; i < T.length; i++) {
    if (z <= T[i][0]) {
      const t = (z - T[i - 1][0]) / (T[i][0] - T[i - 1][0]);
      return [z, lerp(T[i - 1][1], T[i][1], t), lerp(T[i - 1][2], T[i][2], t), lerp(T[i - 1][3], T[i][3], t)];
    }
  }
  return T[T.length - 1];
}

function drawBoot3(sc, P) {
  const blood = P.blood || 0;
  // ---- the foot ----
  const lth = bootLeather3({
    mud: P.mud || 0,
    decal: (S) => {
      // the tongue under the laces, with its stitched edge
      const top = S.v < 0.09 || S.v > 0.91;
      if (top && S.u > 6 && S.u < 20) {
        S.col = shadeC(S.col, 1.25);
        const e = min(abs(S.v - 0.09), abs(S.v - 0.91));
        if (e < 0.012 && (floor(S.u * 3) & 1)) S.col = rgba(140, 120, 90, 255);
      }
    },
  });
  const fp = [], fr = [];
  for (let z = -6; z <= 25; z += 1.5) {
    const b = bootAt(z);
    fp.push([0, b[1], z]); fr.push([b[2], b[3]]);
  }
  loft(sc, fp, (t, i) => fr[min(fr.length - 1, i)], lth, { segs: 18, up: [0, -1, 0], capEnd: 'round', capLen: 0.7 });
  // ---- steel toe cap, the leather long since worn off it ----
  const toe = metal3(rgba(104, 106, 114, 255), { gl: 0.66, grain: 0.12, scratch: 1.4, wear: 0.4, seed: 131, refl: 0.55 });
  const tp = [], tr = [];
  for (let z = 18.5; z <= 25; z += 1.3) { const b = bootAt(z); tp.push([0, b[1], z]); tr.push([b[2] + 0.14, b[3] + 0.14]); }
  loft(sc, tp, (t, i) => tr[min(tr.length - 1, i)], Object.assign({}, toe, {
    shade(S) {
      toe.shade(S);
      // blood: a splash on the cap and a few spots, not a paint job
      if (blood > 0) {
        const bn = nz3(S.u * 1.1 + 4, S.v * 5.5);
        if (bn > 0.66 - blood * 0.12) { S.col = mix(S.col, rgba(150, 10, 14, 255), 0.9); S.gl = 0.85; }
      }
    },
  }), { segs: 18, up: [0, -1, 0], capEnd: 'round', capLen: 0.75, bias: 0.004 });
  // ---- sole: a thick lugged slab, mud in the tread ----
  const sole = {
    col: rgba(34, 30, 28, 255), gl: 0.2,
    shade(S) {
      let c = shadeC(S.col, 0.9 + nz3(S.u, S.v * 4) * 0.3);
      if ((S.u * 0.9) % 1 < 0.3) c = shadeC(c, 0.5);
      if (P.mud) c = mix(c, MUD, clamp((nz3(S.u * 0.8, S.v * 3) - 0.45) * 2 * P.mud, 0, 0.7));
      S.col = c;
    },
  };
  const sp = [], sr = [];
  for (let z = -6.4; z <= 25.6; z += 2) { const b = bootAt(z); sp.push([0, 1.9, z]); sr.push([0.8, b[3] + 0.35]); }
  loft(sc, sp, (t, i) => sr[min(sr.length - 1, i)], sole, { segs: 12, up: [0, -1, 0], capEnd: 'round', capStart: 'round', capLen: 0.5 });
  // ---- laces criss-crossing the tongue, brass eyelets ----
  const laceMat = flat3(rgba(160, 140, 104, 255), 0.25, (S) => { S.col = shadeC(S.col, 0.8 + nz3(S.u * 3, S.v * 4) * 0.4); });
  const eye = brass3({ seed: 135 });
  const topAt = (z, x) => { const b = bootAt(z); return b[1] - b[2] * sqrt(max(0, 1 - (x / b[3]) * (x / b[3]))) - 0.15; };
  for (let k = 0; k < 6; k++) {
    const z0 = 6.5 + k * 2.1, z1 = z0 + 1.7;
    tube3(sc, [-2.0, topAt(z0, 2.0), z0], [2.0, topAt(z1, 2.0) - 0.35, z1], 0.3, 0.3, laceMat, { segs: 6 });
    tube3(sc, [2.0, topAt(z0, 2.0), z0], [-2.0, topAt(z1, 2.0) - 0.35, z1], 0.3, 0.3, laceMat, { segs: 6 });
    for (const sx of [-1, 1]) ball3(sc, [sx * 2.3, topAt(z0, 2.3) + 0.1, z0], 0.42, 0.42, 0.28, eye, { rings: 4, segs: 8 });
  }
  // the bow, flopping over the top
  loft(sc, spline([[0, topAt(19, 0) - 0.4, 19.4], [-1.6, topAt(19, 0) - 1.2, 18.6], [-2.6, topAt(18, 0) - 0.6, 17.6]], 3),
    () => 0.32, laceMat, { segs: 6, up: [0, -1, 0] });
  loft(sc, spline([[0, topAt(19, 0) - 0.4, 19.4], [1.8, topAt(19, 0) - 1.1, 19.8], [2.8, topAt(19, 0) - 0.4, 20.6]], 3),
    () => 0.32, laceMat, { segs: 6, up: [0, -1, 0] });
  // ---- the shaft: the foot is pointed, so the leg carries straight on ----
  loft(sc, spline([[0, -3.3, -2], [0, -3.8, -7], [0, -4.2, -12]], 3),
    (t) => [lerp(4.5, 4.6, t), lerp(4.1, 4.5, t)], lth, { segs: 18, up: [0, -1, 0] });
  // padded collar
  loft(sc, [[0, -4.2, -11.6], [0, -4.3, -12.6], [0, -4.4, -13.4]], (t) => [4.9 + sin(t * PI) * 0.4, 4.8 + sin(t * PI) * 0.4],
    bootLeather3(), { segs: 18, up: [0, -1, 0] });
  // ---- the trouser leg, bloused over the top of the boot ----
  const trou = {
    col: TROUSER, gl: 0.12,
    shade(S) {
      const n = nz3(S.u * 0.4, S.v * 3);
      let c = shadeC(rgba(84, 88, 60, 255), 0.8 + n * 0.4);
      // woodland camo blotches
      const cm = nz3(S.u * 0.12 + 5, S.v * 1.4 + 2);
      if (cm > 0.58) c = shadeC(rgba(60, 54, 40, 255), 0.9 + n * 0.2);
      else if (cm < 0.38) c = shadeC(rgba(110, 112, 80, 255), 0.9 + n * 0.2);
      c = shadeC(c, 0.85 + 0.25 * sin(S.u * 1.3 + S.v * 12 + n * 4));
      c = mix(c, rgba(14, 14, 10, 255), clamp((1 - S.ao) * 1.0, 0, 0.6));
      S.col = c; S.gl = 0.1;
    },
  };
  const lp = [];
  for (let k = 0; k <= 8; k++) {
    const t = k / 8;
    lp.push([sin(t * 3) * 0.6, -4.5 - t * 3, -12.8 - t * 60]);
  }
  loft(sc, lp, (t) => { const b = t < 0.1 ? 1.2 - t : 1.1 + t * 0.3; return [5.2 * b, 5.2 * b]; }, trou, { segs: 18, up: [0, -1, 0] });
  return { muzzle: [0, -1.5, 26] };
}

function steel3() {
  return metal3(rgba(150, 150, 158, 255), { gl: 0.7, grain: 0.08, scratch: 0.3, wear: 0.2, seed: 133 });
}

// ---------------------------------------------------------------------------
// WEAPON 5 - THE PIPE BOMB
// ---------------------------------------------------------------------------

const PIPEBOMB3 = {
  pos: [3.6, 8.4, 20], yaw: -0.3, pitch: 0.45, roll: 0.12,
};

/** The bomb itself, axis along local z, timer box on top (-y). */
function pipeBomb3(sc, M, o = {}) {
  push3(sc, M);
  const L = 13, R = 2.0;
  const galv = metal3(PIPE, { gl: 0.55, grain: 0.18, brush: 0.1, scratch: 1.0, wear: 0.5, grime: 0.8, seed: 141, bare: rgba(210, 214, 220, 255) });
  tube3(sc, [0, 0, -L / 2], [0, 0, L / 2], R, R, galv, { segs: 16, rings: 4 });
  // end caps: hex-ish, a bit fatter
  for (const s of [-1, 1]) {
    tube3(sc, [0, 0, s * (L / 2 - 1.1)], [0, 0, s * (L / 2 + 0.6)], R * 1.22, R * 1.18,
      metal3(rgba(120, 124, 132, 255), { gl: 0.6, grain: 0.12, scratch: 0.8, wear: 0.7, seed: 143 }),
      { segs: 6, capStart: s < 0 ? 'flat' : undefined, capEnd: s > 0 ? 'flat' : undefined });
  }
  // tape wraps
  for (const z of [-3.2, 2.6]) tube3(sc, [0, 0, z - 1.3], [0, 0, z + 1.3], R * 1.05, R * 1.05, tape3(rgba(52, 50, 56, 255), { pitch: 0.9 }), { segs: 16, bias: 0.001 });
  // the timer: a little box of electronics strapped on top
  // (on the top face u runs toward him and v along the pipe, so text reads
  // along v)
  box3(sc, -1.5, -R - 1.3, -5.6, 1.5, -R + 0.4, -1.4, metal3(rgba(40, 44, 40, 255), {
    gl: 0.4, grain: 0.1, scratch: 0.6, wear: 0.6, seed: 145, bevel: 0.3,
    decal: (S) => {
      if (S.face !== F_TOP) return;
      if (S.u > 0.3 && S.u < 1.5 && S.v > 0.3 && S.v < 3.9) {
        S.col = rgba(20, 8, 6, 255); S.em = 0.3; S.gl = 0.7;
        if (glyph3(o.time || '0:06', S.v, S.u, 0.45, 0.45, 0.75)) { S.col = rgba(255, 60, 40, 255); S.em = 1; }
      }
      if (glyph3('TNT', S.v, S.u, 1.1, 1.85, 0.7)) S.col = rgba(220, 200, 80, 255);
    },
  }));
  // the blinking LED on a little stalk
  const led = o.led === undefined ? 1 : o.led;
  ball3(sc, [0.9, -R - 1.6, -0.8], 0.42, 0.42, 0.42, flat3(rgba(255, 60, 40, 255), 0.6, (S) => {
    S.col = mix(rgba(70, 14, 10, 255), rgba(255, 80, 50, 255), led); S.em = 0.2 + led * 0.8;
    if (led > 0.5 && S.nz < -0.8) S.col = rgba(255, 210, 190, 255);
  }), { rings: 5, segs: 8 });
  // wires into the cap
  for (const [wx, col] of [[-0.8, rgba(170, 36, 30, 255)], [0.6, rgba(210, 180, 50, 255)]]) {
    loft(sc, spline([[wx, -R - 1.0, -5.4], [wx, -R - 1.4, -6.6], [wx * 0.5, -R * 0.6, -7.4], [wx * 0.3, 0, -7.4]], 3), () => 0.28,
      flat3(col, 0.5, null), { segs: 6, up: [1, 0, 0] });
  }
  pop3(sc);
}

function drawPipebomb3(sc, P) {
  const stage = P.stage || 'hold';
  const led = P.led === undefined ? 1 : P.led;
  // Everything is authored in the bomb's frame: its axis on local z, which
  // this turns to run across the view, timer on top, his palm underneath.
  const B = mChain(mT(0, -(P.lift || 0), 0), mRY(PI / 2));
  const hold = (o) => Object.assign({
    c: [0, 0, 4.4], a: [0, 0, -1], p: [0, 1, 0], q: [-1, 0, 0], rp: 2.15, rq: 2.15,
    s: [0, 2.05, 4.05, 5.85], sMid: 2.9, mcpQ: -0.8, slope: 0,
    thumbL: [[2.8, 3.8, 6.4], [3.4, 1.0, 5.6], [2.8, -1.4, 4.6], [1.6, -2.6, 3.4], [0.4, -2.9, 2.2]],
    thumbCut: 4.2, thumbNailV: 0.6, thumbR: [1.5, 1.25, 1.1, 1.0], thumbUp: [0, -1, 0],
    wristL: [3.0, 5.2, 6.6], wristQ: -6.0,
    arm: [1, 0.62, 0.35], armLen: 36, armUp: [0, -1, 0], armBend: [0.1, 0.3, 0],
    tattoo: { u: 14, v: 0.55, s: 2.6 }, seed: 7,
  }, o);
  push3(sc, B);
  if (stage === 'hold' || stage === 'wind') {
    pipeBomb3(sc, M_ID, { led, time: P.time });
    hand3(sc, hold({}));
  } else if (stage === 'throw') {
    // release: the bomb tumbling away up the screen, fingers flung open
    const t = P.t || 0.5;
    pipeBomb3(sc, mChain(mT(-8 - t * 26, -5 - t * 6, -1 - t * 3), mRZ(0.8 + t * 2.4), mRX(0.6 + t * 2)), { led, time: P.time });
    hand3(sc, hold({
      wrap: 0.3, rp: 2.6, rq: 2.6,
      thumbL: [[2.8, 3.8, 6.4], [3.8, 1.4, 6.2], [4.2, -0.8, 5.8], [4.2, -2.4, 5.2], [4.0, -3.4, 4.6]],
    }));
  } else {
    // empty hand, curling shut on the way back down
    const close = P.close || 0;
    hand3(sc, hold({
      wrap: 0.45 + close * 0.6, rp: 2.4 - close, rq: 2.4 - close,
      thumbL: [[2.8, 3.8, 6.4], [3.6, 1.2, 5.8], [3.4, -0.9, 5.0], [2.6, -2.0, 4.0], [1.8, -2.4, 3.0]],
    }));
  }
  pop3(sc);
  return { muzzle: [0, -4, 0] };
}

// ---------------------------------------------------------------------------
// 3D weapon frame assembly
// ---------------------------------------------------------------------------

/**
 * Where each weapon sits in camera space, and the point it recoils about
 * (gun-local, usually the web of the hand). `draw` returns the gun-local
 * muzzle so the flash light, the smoke and the in-game flash sprite all find
 * the real bore end whatever the pose did to it.
 */
const WEAPON3 = {
  pistol: {
    draw: drawWidow3, pos: WIDOW3.pos, yaw: WIDOW3.yaw, pitch: WIDOW3.pitch, roll: WIDOW3.roll,
    pivot: [0, 6, 0],
  },
  splitter: {
    draw: drawSplitter3, pos: SPLITTER3.pos, yaw: SPLITTER3.yaw, pitch: SPLITTER3.pitch, roll: SPLITTER3.roll,
    pivot: [0, 8, 2],
  },
  nailer: {
    draw: drawNailer3, pos: NAILER3.pos, yaw: NAILER3.yaw, pitch: NAILER3.pitch, roll: NAILER3.roll,
    pivot: [0, 8, 4],
  },
  halo: {
    draw: drawHalo3, pos: HALO3.pos, yaw: HALO3.yaw, pitch: HALO3.pitch, roll: HALO3.roll,
    pivot: [0, 8, 4],
  },
  deadman: {
    draw: drawDeadman3, pos: DEADMAN3.pos, yaw: DEADMAN3.yaw, pitch: DEADMAN3.pitch, roll: DEADMAN3.roll,
    pivot: [4, 3, 2],
  },
  boot: {
    draw: drawBoot3, pos: [3.5, 21, 33], yaw: -0.12, pitch: 0.68, roll: 0.3,
    pivot: [0, -8, -40],
  },
  pipebomb: {
    draw: drawPipebomb3, pos: PIPEBOMB3.pos, yaw: PIPEBOMB3.yaw, pitch: PIPEBOMB3.pitch, roll: PIPEBOMB3.roll,
    pivot: [0, 4, -4],
  },
};

// The gun rig's key sits further round to the left than the portrait rig's,
// so the left flank (where all the engraving is) is lit rather than grazed.
const WEAPON_KEY = norm3(-0.62, -0.62, 0.48);

function buildWeapon3(out, name) {
  const def = WEAPON3[name];
  const poses = WEAPON_POSES3[name];
  ntab();
  let seed = 9000;
  for (const k of POSE_KEYS) {
    const pose = poses[k] || poses.idle;
    const R = pose.R || {};
    const sc = scene3();
    push3(sc, mChain(
      mT(def.pos[0] + (R.dx || 0), def.pos[1] + (R.dy || 0), def.pos[2] + (R.dz || 0)),
      mRY(def.yaw + (R.ry || 0)), mRX(def.pitch), mRZ(def.roll + (R.rz || 0)),
      mAbout(def.pivot[0], def.pivot[1], def.pivot[2], mRX(R.rx || 0)),
    ));
    const info = def.draw(sc, pose.P || {}) || {};
    const m = info.muzzle || [0, 0, 20];
    const mz = mP(sc.M, m[0], m[1], m[2]);
    pop3(sc);
    const cv = resolve3(sc);
    const [fx, fy] = proj(mz);
    const f = bake(cv, {
      flash: pose.flash || 0,
      fx, fy, fz: 36,
      flashCol: pose.flashCol || [1.0, 0.78, 0.46],
      flashR: pose.flashR || 150,
      key: WEAPON_KEY, keyCol: [1.0, 0.95, 0.86], fill: 0.2, fillCol: [0.56, 0.56, 0.62],
      rim: 0.36, rimCol: [0.5, 0.6, 0.9], env: 0.55, botDark: 0.22, bounce: 0.16, exposure: 1.08,
    });
    rimOutline(f, rgba(12, 10, 14, 255));
    if (pose.smoke) muzzleSmoke(f, fx, fy - 2, pose.smoke, (seed += 137), { spread: pose.smokeSpread || 1 });
    // where the bore ends in this frame, and how big a centimetre is there:
    // render.js hangs the flash sprite on it
    f.mz = [fx, fy, CAM_F / mz[2]];
    f.cx = CAM_CX; f.cy = CAM_CY;
    out[name + '_' + k] = f;
  }
}

const WEAPON_POSES3 = {
  pistol: {
    idle: { P: { hammer: 1 } },
    fire0: { flash: 1.0, R: { rx: 0.16, dz: -2.2, dy: -0.6 }, P: { hammer: 0, slide: 2.6, heat: 1 } },
    fire1: { flash: 0.3, smoke: 0.8, R: { rx: 0.09, dz: -1.2 }, P: { hammer: 0.6, slide: 1.6, casing: 0.35, heat: 0.6 } },
    fire2: { flash: 0.06, smoke: 0.35, R: { rx: 0.03, dz: -0.4 }, P: { hammer: 1, slide: 0.4, casing: 1, heat: 0.3 } },
    reload0: { R: { rx: 0.25, rz: -0.35, dy: 2 }, P: { hammer: 1 } },
    reload1: { R: { rx: 0.12, rz: -0.18, dy: 1 }, P: { hammer: 1 } },
  },
  // The Splitter's reload frames ARE the pump: the game shows them while the
  // refire timer runs down, right after the three fire frames.
  splitter: {
    idle: { P: {} },
    fire0: { flash: 1.0, flashR: 210, R: { rx: 0.14, dz: -3.2, dy: -0.4 }, P: { heat: 1 } },
    fire1: { flash: 0.3, smoke: 1.0, smokeSpread: 1.5, R: { rx: 0.08, dz: -1.8 }, P: { heat: 0.7 } },
    fire2: { flash: 0.06, smoke: 0.45, smokeSpread: 1.5, R: { rx: 0.03, dz: -0.6 }, P: { heat: 0.4 } },
    reload0: { smoke: 0.2, smokeSpread: 1.3, R: { rx: -0.03, rz: 0.06, dz: -1 }, P: { pump: 1, hull: 0.4, heat: 0.3 } },
    reload1: { R: { rx: 0.02, rz: 0.02 }, P: { pump: 0.25, hull: 1, heat: 0.2 } },
  },
  // six barrels, so a 20 degree step per fire frame reads as continuous spin
  // when the three frames cycle under sustained fire
  nailer: {
    idle: { P: { spin: 0, pressure: 0.5 } },
    fire0: { flash: 1.0, flashR: 190, R: { rx: 0.05, dz: -1.4, dx: -0.2 }, P: { spin: 0, heat: 1, pressure: 0.8 } },
    fire1: { flash: 0.6, smoke: 0.5, R: { rx: 0.03, dz: -0.9, dx: 0.25 }, P: { spin: PI / 9, heat: 0.9, pressure: 0.74 } },
    fire2: { flash: 0.2, smoke: 0.3, R: { rx: 0.02, dz: -0.5, dx: -0.1 }, P: { spin: 2 * PI / 9, heat: 0.7, pressure: 0.68 } },
    reload0: { R: { rx: -0.05, rz: 0.12, dy: 1.5 }, P: { spin: PI / 18, pressure: 0.2 } },
    reload1: { R: { rx: -0.02, rz: 0.05, dy: 0.6 }, P: { spin: PI / 12, pressure: 0.4 } },
  },
  // reload frames are the capacitors winding back up after the ring goes
  halo: {
    idle: { P: { charge: 1, arc: 0.3, arcPhase: 0 } },
    fire0: { flash: 1.0, flashR: 220, flashCol: [0.52, 0.95, 1.0], R: { rx: 0.1, dz: -3.4 }, P: { charge: 0.6, arc: 1, arcPhase: 1.2 } },
    fire1: { flash: 0.35, flashCol: [0.5, 0.9, 1.0], R: { rx: 0.06, dz: -2 }, P: { charge: 0.34, arc: 0.7, arcPhase: 2.4 } },
    fire2: { flash: 0.1, flashCol: [0.5, 0.9, 1.0], R: { rx: 0.02, dz: -0.7 }, P: { charge: 0.1, arc: 0.35, arcPhase: 3.6 } },
    reload0: { flash: 0.05, flashCol: [0.5, 0.9, 1.0], R: { rx: -0.04, rz: 0.08, dy: 1 }, P: { charge: 0.02, arc: 0.05, arcPhase: 4.8 } },
    reload1: { flash: 0.16, flashCol: [0.5, 0.9, 1.0], R: { rx: -0.02, rz: 0.03, dy: 0.4 }, P: { charge: 0.55, arc: 0.5, arcPhase: 5.9 } },
  },
  deadman: {
    idle: { P: { cover: 0, plunge: 0, count: '09', lamp: 0.15 } },
    fire0: { flash: 1.0, flashR: 260, flashCol: [1.0, 0.94, 0.86], R: { rx: -0.08, dy: 1.2 }, P: { cover: 1, plunge: 1, count: '00', lamp: 1 } },
    fire1: { flash: 0.42, flashCol: [1.0, 0.86, 0.62], R: { rx: -0.04, dy: 0.6 }, P: { cover: 1, plunge: 0.7, count: '00', lamp: 0.8 } },
    fire2: { flash: 0.12, flashCol: [1.0, 0.8, 0.6], R: { rx: -0.01 }, P: { cover: 0.9, plunge: 0.25, count: '01', lamp: 0.45 } },
    reload0: { R: { rz: 0.06, dy: 0.8 }, P: { cover: 0.55, plunge: 0, count: '05', lamp: 0.25 } },
    reload1: { R: { rz: 0.02, dy: 0.3 }, P: { cover: 0.12, plunge: 0, count: '09', lamp: 0.15 } },
  },
  // the kick: full extension, then the leg pulling back down out of frame
  boot: {
    idle: { R: { dy: 7.5, dz: -7, rx: -0.12 }, P: { ext: 0 } },
    fire0: { flash: 0.4, flashR: 170, flashCol: [1.0, 0.92, 0.8], smoke: 0.6, smokeSpread: 1.6, P: { ext: 1, mud: 0.6, blood: 0.75 } },
    fire1: { smoke: 0.4, smokeSpread: 1.8, R: { dy: 2.5, dz: -3, rx: -0.04 }, P: { ext: 0.9, mud: 0.6, blood: 0.75 } },
    fire2: { R: { dy: 5.5, dz: -5.5, rx: -0.09 }, P: { ext: 0.75, mud: 0.55, blood: 0.75 } },
    reload0: { R: { dy: 6.2, dz: -6, rx: -0.1 }, P: { ext: 0.6, mud: 0.55, blood: 0.6 } },
    reload1: { R: { dy: 7, dz: -6.6, rx: -0.11 }, P: { ext: 0.2, mud: 0.5 } },
  },
  // the pipe bomb: held, thrown, then the next one comes up out of the bag
  pipebomb: {
    idle: { P: { stage: 'hold', led: 1, time: '0:06' } },
    fire0: { R: { dy: -3, dz: 6, rx: 0.3 }, P: { stage: 'throw', t: 0.2, led: 1, time: '0:06' } },
    fire1: { R: { dy: -1, dz: 4, rx: 0.15 }, P: { stage: 'empty', t: 0.6, close: 0.1 } },
    fire2: { R: { dy: 1.5, dz: 1 }, P: { stage: 'empty', close: 0.5 } },
    reload0: { R: { dy: 2.8, dz: -1.5, rx: -0.12 }, P: { stage: 'hold', led: 0, time: '----' } },
    reload1: { R: { dy: 2, dz: -1, rx: -0.1 }, P: { stage: 'hold', led: 0, time: '0:06' } },
  },
};

// ---------------------------------------------------------------------------
// WEAPON 1 - THE WIDOW: break-action flak pistol
// ---------------------------------------------------------------------------

const WIDOW = {
  hingeX: 96, hingeY: 100,
  // The barrel is authored bolt-upright and then swung to BRL_ANG about the
  // hinge, so every band and the fuse dial stay perpendicular to the bore.
  brlCx: 93, brlTop: 40, brlBot: 102, brlR: 13.8, brlTilt: 0, brlTaper: 0.90,
  muzX: 93, muzY: 41,
  dialY: 66, dialX: 93,
  ang: -0.27,
};

/** The barrel assembly, drawn alone so the break-action can pivot it. */
function widowBarrel(cv, P) {
  const W = WIDOW;
  const heat = P.heat || 0;
  // main tube
  cylinderV(cv, W.brlCx, W.brlTop, W.brlBot, W.brlR, {
    col: BLUED, gloss: 0.55, grain: 0.09, seed: 101,
    taper: W.brlTaper, tilt: W.brlTilt, aoEdge: 0.46,
  });
  const axX = (t) => W.brlCx + W.brlTilt * (t - 0.5) * (W.brlBot - W.brlTop);
  const axR = (t) => W.brlR * lerp(1, W.brlTaper, t);
  // reinforcing bands
  for (const t of [0.10, 0.80]) {
    const x = axX(t), y = lerp(W.brlTop, W.brlBot, t), r = axR(t);
    ringTube(cv, x, y, r * 1.04, 2.8, {
      squashY: 0.34, col: STEEL, gloss: 0.6, grain: 0.08, seed: 103,
      shader: (a, u) => mix(shade(STEEL, 0.55), STEEL_B, clamp(0.55 - cos(a) * 0.5 - u * 0.4, 0, 1)),
    });
  }
  // --- the fuse-setting dial: concentric brass rings with tick marks ---
  const dx = W.dialX, dy = W.dialY;
  ringTube(cv, dx, dy, 17.5, 4.8, {
    squashY: 0.36, gloss: 0.58, grain: 0.10, seed: 107,
    shader: (a, u, x, y) => {
      // knurled outer edge
      const kn = 0.5 + 0.5 * sin(a * 46);
      let c = mix(shade(BRASS_D, 0.72), BRASS, clamp(0.55 - cos(a + 0.4) * 0.45 - u * 0.3, 0, 1));
      c = shade(c, 0.86 + kn * 0.30 * (abs(u) > 0.35 ? 1 : 0.25));
      if (hash2(x, y, 12) > 0.94) c = shade(c, 0.7);
      return c;
    },
  });
  ringTube(cv, dx, dy, 9.8, 3.2, {
    squashY: 0.36, gloss: 0.5, grain: 0.09, seed: 109,
    shader: (a, u) => mix(shade(BRASS_D, 0.55), mix(BRASS, BRASS_B, 0.3),
      clamp(0.5 - cos(a + 0.4) * 0.5 - u * 0.35, 0, 1)),
  });
  // engraved ticks around the dial
  const set = clamp(P.fuse === undefined ? 0.62 : P.fuse, 0, 1);
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * TAU;
    const longTick = k % 4 === 0;
    const r0 = longTick ? 12.4 : 14.4, r1 = 17.0;
    for (let r = r0; r <= r1; r += 0.5) {
      tint(cv, dx + cos(a) * r, dy + sin(a) * r * 0.36, rgba(46, 32, 12, 255), 0.85);
    }
  }
  // the index pointer, sitting at the armed range
  const ia = set * TAU;
  for (let r = 9.0; r <= 19.0; r += 0.5) {
    const x = dx + cos(ia) * r, y = dy + sin(ia) * r * 0.36;
    tint(cv, x, y, rgba(214, 66, 40, 255), 0.95);
    tint(cv, x, y + 1, rgba(150, 34, 24, 255), 0.7);
  }
  blob(cv, dx + cos(ia) * 19.0, dy + sin(ia) * 6.8, 2.3,
    { col: rgba(226, 90, 52, 255), gloss: 0.5, grain: 0.04, em: 0.25 });
  // dial numerals
  stencil(cv, '4', dx - 1, dy - 10, rgba(52, 36, 14, 255), 0.85);
  stencil(cv, '8', dx - 1, dy + 5, rgba(52, 36, 14, 255), 0.85);

  // --- muzzle ---
  boreEllipse(cv, W.muzX, W.muzY + 1, axR(0) * 1.04, 0.44, {
    crown: STEEL_B, rings: 4, glow: heat * 0.85, glowCol: hotColor(0.30),
  });
  // front sight blade
  metalPanel(cv, W.muzX - 2, W.muzY - 6, 4, 7, { col: STEEL_D, bevel: 1, gloss: 0.5, round: 1, seed: 113 });
  // barrel lug below the hinge
  metalPanel(cv, W.brlCx - 8, W.brlBot - 8, 17, 15, { col: BLUED, bevel: 2, round: 3, gloss: 0.45, seed: 115 });
  scuff(cv, W.muzX - 16, W.brlTop, 34, W.brlBot - W.brlTop, 3001, 26, 0.36);
  soot(cv, W.muzX - 17, W.brlTop - 2, 34, 30, 3003, 0.5, 8);
}

function drawWidow(cv, P) {
  const W = WIDOW;
  const open = P.open || 0;
  const heat = P.heat || 0;

  // ---- receiver / frame ----
  metalPanel(cv, 82, 86, 48, 34, {
    col: mix(BLUED, BLUED_D, 0.5), gloss: 0.52, bevel: 3, round: 5, seed: 223, grain: 0.10, curve: 0.55,
  });
  // standing breech behind the barrel
  metalPanel(cv, 88, 78, 22, 20, { col: shade(BLUED, 0.9), gloss: 0.5, bevel: 3, round: 4, seed: 224, curve: 0.4 });
  metalPanel(cv, 98, 80, 30, 14, { col: shade(BLUED, 1.14), gloss: 0.56, bevel: 2, round: 3, seed: 225 });
  // top strap / rear sight notch
  metalPanel(cv, 116, 74, 13, 9, { col: STEEL_D, gloss: 0.58, bevel: 2, round: 1, seed: 227 });
  for (let j = 0; j < 4; j += ST) for (let i = 0; i < 3; i += ST) tint(cv, 121 + i, 76 + j, rgba(14, 12, 14, 255), 0.9);

  // hinge boss
  blob(cv, W.hingeX, W.hingeY, 8.2, { col: STEEL, gloss: 0.6, grain: 0.09, seed: 229 });
  screwHead(cv, W.hingeX, W.hingeY, 3.0, 0.4, rgba(150, 150, 156, 255));

  // ---- breech face: visible when the gun is broken open ----
  if (open > 0.02) {
    const bx = 100, by = 96;
    ellipseFill(cv, bx, by, 13, 12 * (0.35 + 0.65 * open), {
      col: rgba(30, 28, 30, 255), gloss: 0.2, bulge: 0.3, seed: 231,
      shader: (u, v) => mix(rgba(22, 20, 22, 255), rgba(62, 58, 58, 255), clamp(v * 0.6 + 0.5, 0, 1)),
    });
    // spent case sitting proud of the chamber (extractor has lifted it)
    if (P.spent) {
      shellRound(cv, bx, by + 2, bx - 5, by - 16 * (0.4 + 0.6 * open), 6.4,
        { band: rgba(88, 80, 60, 255), spent: 1, seed: 233 });
    }
    if (P.freshShell) {
      shellRound(cv, bx + 3, by + 20, bx - 1, by - 2, 6.6, { band: rgba(168, 58, 42, 255), seed: 235 });
    }
  }

  // ---- exposed hammer ----
  const hz = P.hammer || 0;   // 0 = down, 1 = cocked
  const ha = lerp(-0.5, 0.42, hz);
  const hx = 126, hy = 88;
  capsule(cv, hx, hy, hx + sin(ha) * 13, hy - cos(ha) * 13, 4.4, 5.4, {
    col: STEEL_D, gloss: 0.55, grain: 0.1, seed: 237,
  });
  // checkered thumb spur
  const sx = hx + sin(ha) * 13, sy = hy - cos(ha) * 13;
  blob(cv, sx, sy, 5.0, { col: STEEL_D, gloss: 0.5, grain: 0.08, seed: 239 });
  knurl(cv, sx - 5, sy - 5, 10, 10, 2, 0.34);

  // ---- trigger guard + trigger ----
  ringTube(cv, 106, 126, 13.0, 3.2, {
    a0: 0.0, a1: PI * 1.02, col: STEEL_D, gloss: 0.62, grain: 0.08, seed: 241,
  });
  capsule(cv, 106, 117, 105, 126, 2.6, 3.1, { col: STEEL_B, gloss: 0.70, grain: 0.07, seed: 243 });

  // ---- grip: drawn over the frame, because from behind the right shoulder the
  // walnut sits in front of it ----
  capsule(cv, 114, 100, 136, 158, 11.2, 13.0, {
    shader: woodShader(211), gloss: 0.32, grain: 0, seed: 217, aoEdge: 0.48,
  });
  knurl(cv, 110, 116, 32, 40, 3, 0.20);
  capsule(cv, 130, 110, 145, 158, 3.6, 4.2, { col: shade(BLUED_D, 1.1), gloss: 0.6, grain: 0.09, seed: 219 });
  screwHead(cv, 122, 124, 2.8, 0.9, rgba(168, 160, 148, 255));

  // ---- markings + wear ----
  stencil(cv, 'W-7', 88, 96, rgba(206, 200, 186, 255), 0.6);
  stencil(cv, 'FLAK', 87, 104, rgba(162, 158, 148, 255), 0.45);
  scuff(cv, 84, 80, 52, 44, 3011, 34, 0.4);
  soot(cv, 84, 82, 50, 40, 3013, 0.3, 10);

  // ---- barrel group (pivots for the break-action) ----
  const bg = makeCv(cv.w, cv.h);
  widowBarrel(bg, Object.assign({ heat }, P));
  compositeCv(cv, poseCv(bg, W.ang - 0.62 * open, MPX(W.hingeX), MPY(W.hingeY), 0, 0));

  // contact shadow where the barrel meets the frame
  underShadow(cv, 86, 114, 102, 4, 0.4);

  // ---- the hand ----
  drawGlove(cv, {
    x: 140, y: 134, ang: 0.36, flip: -1, scale: 0.98, grip: 'trigger',
    seed: 4001, wear: 0.6, curlBias: -0.04,
  });
  // trigger finger reaching forward into the guard
  capsule(cv, 120, 116, 107, 121, 3.3, 2.7, {
    shader: leatherShader(4013, { wear: 0.5 }), gloss: 0.2, grain: 0, seed: 4013,
  });

  // ---- second hand, only during the reload ----
  if (P.loadHand) {
    drawGlove(cv, {
      x: 66, y: 142 - 14 * P.loadHand, ang: -0.42, flip: 1, scale: 0.94, grip: 'pinch',
      seed: 4021, wear: 0.5, sleeve: 1,
    });
    const shy = 128 - 26 * P.loadHand;
    shellRound(cv, 90, shy + 12, 96, shy - 6, 6.4, { band: rgba(176, 60, 44, 255), seed: 4023 });
  }
}

// ---------------------------------------------------------------------------
// WEAPON 2 - THE SPLITTER: triple-barrelled cluster launcher
// ---------------------------------------------------------------------------

const SPLIT_BARRELS = [
  { mx: 98, my: 38, bx: 98, by: 102, r: 12.4 },   // top
  { mx: 74, my: 58, bx: 84, by: 108, r: 12.8 },   // lower left
  { mx: 122, my: 58, bx: 112, by: 108, r: 12.8 }, // lower right
];

function splitterBarrel(cv, b, P, seed) {
  const H = b.by - b.my;
  const tilt = (b.bx - b.mx) / H;
  const cx = (b.bx + b.mx) / 2;
  cylinderV(cv, cx, b.my, b.by, b.r, {
    col: OLIVE_D, gloss: 0.34, grain: 0.12, seed,
    taper: 0.90, tilt, aoEdge: 0.42,
  });
  // two reinforcing rings
  for (const t of [0.10, 0.52]) {
    const x = cx + tilt * (t - 0.5) * H, y = lerp(b.my, b.by, t);
    ringTube(cv, x, y, b.r * lerp(1, 0.9, t) * 1.03, 2.8, {
      squashY: 0.34, gloss: 0.6, grain: 0.09, seed: seed + 1,
      shader: (a, u) => mix(shade(STEEL, 0.5), STEEL_B, clamp(0.55 - cos(a + 0.4) * 0.5 - u * 0.4, 0, 1)),
    });
  }
  boreEllipse(cv, b.mx, b.my + 2, b.r * 1.0, 0.36, {
    crown: STEEL_B, rings: 3, glow: (P.heat || 0) * 0.9, glowCol: hotColor(0.26),
  });
  soot(cv, b.mx - 16, b.my - 2, 32, 26, seed + 9, 0.55, 7);
}

function drawSplitter(cv, P) {
  const ba = P.breechAng || 0;
  const heat = P.heat || 0;

  // ---- lower receiver / body ----
  metalPanel(cv, 68, 118, 62, 34, { col: OLIVE_D, gloss: 0.36, bevel: 3, round: 5, seed: 301, grain: 0.12, curve: 0.55 });
  metalPanel(cv, 74, 138, 50, 14, { col: shade(OLIVE, 0.82), gloss: 0.4, bevel: 2, round: 3, seed: 303 });

  // ---- pistol grip (right) ----
  capsule(cv, 133, 122, 146, 152, 9.6, 11.0, { shader: woodShader(305), gloss: 0.26, grain: 0, seed: 307 });
  knurl(cv, 128, 130, 24, 24, 3, 0.2);

  // ---- vertical foregrip (left) ----
  capsule(cv, 57, 112, 55, 150, 8.4, 9.4, { shader: woodShader(309), gloss: 0.26, grain: 0, seed: 311 });
  knurl(cv, 47, 120, 20, 26, 3, 0.2);
  metalPanel(cv, 46, 106, 24, 10, { col: STEEL_D, gloss: 0.5, bevel: 2, round: 2, seed: 313 });

  // ---- barrels: top first (furthest), then the near pair over it ----
  splitterBarrel(cv, SPLIT_BARRELS[0], P, 321);
  splitterBarrel(cv, SPLIT_BARRELS[1], P, 331);
  splitterBarrel(cv, SPLIT_BARRELS[2], P, 341);
  // clamp yoke holding the three tubes together
  metalPanel(cv, 68, 76, 60, 11, { col: STEEL_D, gloss: 0.52, bevel: 2, round: 3, seed: 351, curve: 0.35 });
  for (const x of [72, 86, 110, 124]) rivet(cv, x, 81, 2.0);

  // ---- rotating breech drum ----
  const dcx = 98, dcy = 116;
  metalPanel(cv, 64, 96, 68, 40, { col: OLIVE, gloss: 0.42, bevel: 3, round: 8, seed: 361, grain: 0.11, curve: 0.7 });
  ellipseFill(cv, dcx, dcy, 27, 24, {
    col: shade(GUNMETAL, 1.12), gloss: 0.50, bulge: 0.75, grain: 0.1, seed: 363,
    shader: (u, v, x, y) => {
      const a = atan2(v, u);
      const flute = 0.5 + 0.5 * cos((a - ba) * 3 + PI);
      let c = mix(shade(GUNMETAL, 0.78), shade(GUNMETAL, 1.25), flute);
      c = shade(c, 0.9 + fbm(365, x / 6, y / 6, 3, 8) * 0.28);
      return c;
    },
  });
  // knurled rim
  ringTube(cv, dcx, dcy, 27, 3.2, {
    gloss: 0.58, grain: 0.09, seed: 367,
    shader: (a, u) => {
      const kn = 0.5 + 0.5 * sin((a - ba) * 40);
      return shade(mix(shade(STEEL, 0.5), STEEL_B, clamp(0.55 - cos(a + 0.5) * 0.5 - u * 0.4, 0, 1)), 0.86 + kn * 0.3);
    },
  });
  // three chambers with brass shell heads
  for (let k = 0; k < 3; k++) {
    const a = ba + k * TAU / 3 - PI / 2;
    const cx = dcx + cos(a) * 14.5, cy = dcy + sin(a) * 13;
    const loaded = !(P.emptyChamber && k === 0);
    ringTube(cv, cx, cy, 6.4, 2.1, {
      squashY: 0.92, gloss: 0.62, grain: 0.08, seed: 369 + k,
      shader: (aa, u) => mix(shade(BRASS_D, 0.6), BRASS_B, clamp(0.55 - cos(aa + 0.5) * 0.5 - u * 0.4, 0, 1)),
    });
    if (loaded) {
      blob(cv, cx, cy, 5.4, {
        gloss: 0.48, grain: 0.07, seed: 373 + k, squashY: 0.94,
        shader: (u, v) => {
          const d = hypot(u, v);
          let c = mix(BRASS, shade(BRASS_D, 0.9), clamp(d * 0.8, 0, 1));
          if (d < 0.42) c = shade(COPPER, 0.95);
          return c;
        },
      });
    } else {
      blob(cv, cx, cy, 5.4, {
        gloss: 0.2, grain: 0.05, seed: 377, squashY: 0.94,
        shader: (u, v) => mix(rgba(16, 14, 15, 255), rgba(54, 48, 46, 255), clamp(v * 0.7 + 0.4, 0, 1)),
      });
    }
  }
  screwHead(cv, dcx, dcy, 3.6, 0.3 + ba, rgba(150, 152, 158, 255));

  // ---- markings ----
  stencil(cv, 'III', 74, 126, rgba(198, 192, 178, 255), 0.5);
  stencil(cv, 'SPLITTER', 72, 142, rgba(160, 156, 146, 255), 0.42);
  hazardStripe(cv, 108, 140, 20, 8, { pitch: 6, amt: 0.55, wear: 0.7 });
  scuff(cv, 64, 90, 70, 56, 3031, 44, 0.4);
  soot(cv, 66, 76, 66, 40, 3033, 0.34, 11);

  // ---- bandolier of stubby shells ----
  const bez1 = strapCurve(cv, [[-10, 158], [2, 126], [26, 108], [58, 112]], 6.0, { seed: 381 });
  for (let i = 0; i <= 5; i++) {
    const t = 0.10 + i * 0.165;
    const a = bez1(max(0, t - 0.02)), b = bez1(min(1, t + 0.02));
    const ang = atan2(b[1] - a[1], b[0] - a[0]) + PI / 2;
    const p0 = bez1(t);
    shellRound(cv, p0[0] - cos(ang) * 4, p0[1] - sin(ang) * 4,
      p0[0] + cos(ang) * 11, p0[1] + sin(ang) * 11, 4.7,
      { band: i % 2 ? rgba(172, 60, 44, 255) : rgba(92, 104, 62, 255), seed: 383 + i });
  }
  const bez2 = strapCurve(cv, [[136, 118], [160, 128], [180, 148], [206, 160]], 6.0, { seed: 391 });
  for (let i = 0; i <= 3; i++) {
    const t = 0.14 + i * 0.24;
    const a = bez2(max(0, t - 0.02)), b = bez2(min(1, t + 0.02));
    const ang = atan2(b[1] - a[1], b[0] - a[0]) - PI / 2;
    const p0 = bez2(t);
    shellRound(cv, p0[0] - cos(ang) * 4, p0[1] - sin(ang) * 4,
      p0[0] + cos(ang) * 11, p0[1] + sin(ang) * 11, 4.7,
      { band: i % 2 ? rgba(92, 104, 62, 255) : rgba(172, 60, 44, 255), seed: 393 + i });
  }

  underShadow(cv, 68, 132, 118, 4, 0.35);

  // ---- hands ----
  drawGlove(cv, {
    x: 42, y: 128, ang: -0.22, flip: 1, scale: 1.0, grip: 'fore',
    seed: 4101, wear: 0.55,
  });
  drawGlove(cv, {
    x: 154, y: 132, ang: 0.26, flip: -1, scale: 1.0, grip: 'wrap',
    seed: 4111, wear: 0.6,
  });
}

/** Bezier evaluator for any number of control points. */
function makeBez(pts) {
  const n = pts.length - 1;
  return (t) => {
    let x = 0, y = 0;
    for (let i = 0; i <= n; i++) {
      const b = binom(n, i) * pow(1 - t, n - i) * pow(t, i);
      x += pts[i][0] * b; y += pts[i][1] * b;
    }
    return [x, y];
  };
}

/** Jagged electric arc between two points. Emissive, so it survives the bake. */
function boltPath(cv, x0, y0, x1, y1, jitter, seed, col, em = 1, wide = 1) {
  const rng = makeRng(seed);
  const segs = 9;
  let px_ = x0, py_ = y0;
  const dx = x1 - x0, dy = y1 - y0;
  const nx = -dy, ny = dx;
  const l = hypot(dx, dy) || 1;
  for (let i = 1; i <= segs; i++) {
    const t = i / segs;
    const env = sin(t * PI);
    const j = (rng() - 0.5) * jitter * env;
    const cx = x0 + dx * t + (nx / l) * j;
    const cy = y0 + dy * t + (ny / l) * j;
    capsule(cv, px_, py_, cx, cy, wide * 1.5, wide * 1.3, { col, gloss: 0, grain: 0, em });
    if (rng() < 0.30 && i > 1 && i < segs) {
      const bl = 5 + rng() * 9;
      const ba = atan2(cy - py_, cx - px_) + (rng() < 0.5 ? 1.1 : -1.1);
      capsule(cv, cx, cy, cx + cos(ba) * bl, cy + sin(ba) * bl, wide, wide * 0.5,
        { col: shade(col, 0.8), gloss: 0, grain: 0, em: em * 0.8 });
    }
    px_ = cx; py_ = cy;
  }
}

// ---------------------------------------------------------------------------
// WEAPON 3 - THE NAILDRIVER: industrial rivet gun turned chaingun
// ---------------------------------------------------------------------------

function drawNailer(cv, P) {
  const spin = P.spin || 0;
  const heat = clamp(P.heat || 0, 0, 1);
  const hubX = 100, hubY = 50, ringR = 16.5;

  // ---- receiver ----
  metalPanel(cv, 60, 100, 82, 52, { col: INDY_D, gloss: 0.34, bevel: 3, round: 6, seed: 501, grain: 0.13, curve: 0.55 });
  metalPanel(cv, 66, 96, 70, 16, { col: INDY, gloss: 0.44, bevel: 3, round: 4, seed: 503, curve: 0.4 });
  // feed cover with hazard paint
  metalPanel(cv, 70, 112, 44, 20, { col: shade(INDY, 1.05), gloss: 0.42, bevel: 2, round: 3, seed: 505 });
  hazardStripe(cv, 72, 114, 40, 7, { pitch: 6, amt: 0.62, wear: 0.65 });
  for (const x of [72, 110]) for (const y of [114, 128]) rivet(cv, x, y, 1.8);
  // motor can on the left
  cylinderH(cv, 44, 74, 118, 12, { col: STEEL_D, gloss: 0.46, grain: 0.11, seed: 507 });
  for (let x = 46; x < 72; x += 4) {
    for (let j = -10; j <= 10; j += ST) {
      const u = j / 11;
      tint(cv, x, 118 + j, shade(STEEL_D, 0.6), 0.55 * (1 - abs(u) * 0.5));
    }
  }
  blob(cv, 44, 118, 11, { col: STEEL, gloss: 0.55, grain: 0.09, seed: 509 });
  screwHead(cv, 44, 118, 3.2, 0.8);

  // ---- spinning barrel cluster ----
  for (let k = 0; k < 6; k++) {
    const a = spin + k * TAU / 6;
    const s = sin(a);
    // draw far barrels (upper half of the ring) first
    if (s > 0) continue;
    nailerBarrel(cv, hubX + cos(a) * ringR, hubY + s * ringR * 0.45, k, heat);
  }
  // hub
  blob(cv, hubX, hubY + 6, 13, { col: STEEL_D, gloss: 0.5, grain: 0.1, seed: 511, squashY: 0.5 });
  for (let k = 0; k < 6; k++) {
    const a = spin + k * TAU / 6;
    const s = sin(a);
    if (s <= 0) continue;
    nailerBarrel(cv, hubX + cos(a) * ringR, hubY + s * ringR * 0.45, k, heat);
  }

  // ---- vented heat shroud ----
  cylinderV(cv, hubX, 64, 108, 26, {
    col: STEEL_D, gloss: 0.52, grain: 0.09, seed: 513, taper: 1.08, aoEdge: 0.34,
  });
  // shroud mouth ring
  ringTube(cv, hubX, 65, 26, 3.6, {
    squashY: 0.36, gloss: 0.6, grain: 0.09, seed: 515,
    shader: (a, u) => mix(shade(STEEL, 0.45), STEEL_B, clamp(0.55 - cos(a + 0.4) * 0.5 - u * 0.4, 0, 1)),
  });
  ventSlots(cv, hubX, 74, 104, 15, 6, { glow: heat * 0.8, w: 3 });
  // longitudinal ribs
  for (const off of [-23, -17, 17, 23]) {
    const u = off / 27;
    const nz = sqrt(max(0.05, 1 - u * u));
    for (let y = 72; y <= 106; y += ST) {
      const x = hubX + off * (1 + (y - 68) * 0.0018);
      put(cv, x, y, grainy(shade(STEEL, 1.0), x, y, 517, 0.1), u * 0.9, 0, nz, 0.9, 0.62, 0);
      put(cv, x + 1, y, grainy(shade(STEEL_D, 0.8), x, y, 517, 0.1), u * 0.9 + 0.4, 0, nz, 0.7, 0.35, 0);
    }
  }
  if (heat > 0.02) soot(cv, 72, 66, 56, 44, 5019, 0.3, 9);

  // ---- side handle (left) ----
  metalPanel(cv, 48, 96, 22, 9, { col: STEEL_D, gloss: 0.5, bevel: 2, round: 2, seed: 519 });
  capsule(cv, 52, 100, 46, 132, 8.0, 8.8, { shader: woodShader(521), gloss: 0.26, grain: 0, seed: 523 });
  knurl(cv, 38, 106, 20, 22, 3, 0.2);

  // ---- rear grip + trigger (right) ----
  capsule(cv, 136, 116, 150, 152, 9.4, 10.6, { shader: woodShader(525), gloss: 0.26, grain: 0, seed: 527 });
  knurl(cv, 132, 124, 24, 24, 3, 0.2);
  ringTube(cv, 128, 128, 10.5, 2.6, { a0: 0.1, a1: PI * 1.0, col: STEEL_D, gloss: 0.5, grain: 0.08, seed: 529 });
  capsule(cv, 128, 121, 127, 128, 2.3, 2.8, { col: STEEL, gloss: 0.6, grain: 0.07, seed: 531 });

  // ---- nail belt entering from the lower left ----
  const beltT = P.beltAdv || 0;
  const pts = [[-16, 166], [18, 158], [48, 150], [76, 132]];
  const bez = strapCurve(cv, pts, 5.0, { seed: 533, col: rgba(92, 82, 62, 255) });
  for (let i = 0; i < 9; i++) {
    const t = ((i + beltT) * 0.111) % 1;
    if (t > 0.96) continue;
    const a = bez(max(0, t - 0.02)), b = bez(min(1, t + 0.02));
    const ang = atan2(b[1] - a[1], b[0] - a[0]);
    const p0 = bez(t);
    // link plate
    metalPanelRot(cv, p0[0], p0[1], 10, 8, ang, { col: rgba(168, 148, 104, 255), gloss: 0.55, seed: 535 + i });
    // the nail itself: bright shank, flat head
    const na = ang - PI / 2;
    const tipX = p0[0] + cos(na) * 12, tipY = p0[1] + sin(na) * 12;
    capsule(cv, p0[0], p0[1], tipX, tipY, 2.3, 1.1, {
      gloss: 0.85, grain: 0.05, seed: 537 + i,
      shader: (t2, u) => mix(shade(STEEL_D, 0.7), rgba(214, 218, 228, 255), clamp(0.55 - u * 0.9, 0, 1)),
    });
    blob(cv, p0[0] - cos(na) * 2, p0[1] - sin(na) * 2, 3.6,
      { col: STEEL_B, gloss: 0.82, grain: 0.06, seed: 539 + i, squashY: 0.7 });
  }

  // ---- markings + wear ----
  stencil(cv, 'NAILDRIVER', 66, 138, rgba(186, 182, 170, 255), 0.45);
  stencil(cv, 'MK II', 66, 146, rgba(150, 146, 138, 255), 0.36);
  scuff(cv, 60, 92, 82, 58, 5041, 50, 0.4);
  soot(cv, 62, 92, 78, 54, 5043, 0.36, 12);
  underShadow(cv, 62, 140, 100, 4, 0.35);

  // ---- hands ----
  drawGlove(cv, { x: 30, y: 112, ang: -0.32, flip: 1, scale: 1.0, grip: 'fore', seed: 4201, wear: 0.6 });
  drawGlove(cv, { x: 158, y: 132, ang: 0.28, flip: -1, scale: 1.0, grip: 'trigger', seed: 4211, wear: 0.62 });
  capsule(cv, 136, 124, 127, 127, 3.2, 2.6, {
    shader: leatherShader(4213, { wear: 0.5 }), gloss: 0.2, grain: 0, seed: 4213,
  });
}

function nailerBarrel(cv, x, y, k, heat) {
  cylinderV(cv, x, y - 20, y + 26, 6.6, {
    col: GUNMETAL_D, gloss: 0.50, grain: 0.10, seed: 551 + k, taper: 1.0, aoEdge: 0.38,
  });
  ringTube(cv, x, y - 13, 6.7, 1.7, {
    squashY: 0.40, gloss: 0.66, grain: 0.07, seed: 553 + k,
    shader: (a, u) => mix(shade(STEEL_D, 0.6), STEEL_B, clamp(0.55 - cos(a + 0.4) * 0.5 - u * 0.4, 0, 1)),
  });
  boreEllipse(cv, x, y - 19, 6.6, 0.42, {
    crown: STEEL, rings: 2, glow: heat, glowCol: hotColor(0.22),
  });
}

// ---------------------------------------------------------------------------
// WEAPON 4 - THE HALO: exotic ring launcher
// ---------------------------------------------------------------------------

function drawHalo(cv, P) {
  const charge = clamp(P.charge === undefined ? 1 : P.charge, 0, 1);
  const arc = clamp(P.arc === undefined ? 0.5 : P.arc, 0, 1);
  const cx = 100, cy = 60, R = 37, tube = 8.5;

  // ---- body / spine ----
  metalPanel(cv, 68, 106, 64, 46, { col: CHAR_D, gloss: 0.36, bevel: 3, round: 6, seed: 601, grain: 0.12, curve: 0.6 });
  metalPanel(cv, 78, 98, 44, 16, { col: CHAR, gloss: 0.42, bevel: 2, round: 3, seed: 603, curve: 0.4 });
  // struts up to the ring
  capsule(cv, 84, 100, 74, 82, 4.6, 4.0, { col: STEEL_D, gloss: 0.5, grain: 0.1, seed: 605 });
  capsule(cv, 116, 100, 126, 82, 4.6, 4.0, { col: STEEL_D, gloss: 0.5, grain: 0.1, seed: 607 });

  // ---- copper coils flanking the body ----
  for (const [ox, sgn] of [[78, -1], [122, 1]]) {
    ringTube(cv, ox, 100, 10.0, 5.0, {
      squashY: 0.86, gloss: 0.42, grain: 0.1, seed: 609,
      shader: (a, u, x, y) => {
        const wind = 0.5 + 0.5 * sin(a * 22 + (x + y) * 0.1);
        let c = mix(shade(COPPER, 0.42), mix(rgba(214, 128, 66, 255), rgba(248, 186, 118, 255), 0.5),
          clamp(0.55 - cos(a + 0.5) * 0.45 - u * 0.35, 0, 1));
        return shade(c, 0.80 + wind * 0.44);
      },
    });
    blob(cv, ox, 100, 5.4, { col: CHAR_D, gloss: 0.3, grain: 0.08, seed: 611, squashY: 0.9 });
    // lead wire into the body
    capsule(cv, ox, 108, ox - sgn * 8, 114, 2.2, 2.0, { col: rgba(148, 92, 52, 255), gloss: 0.45, grain: 0.08, seed: 613 });
  }

  // ---- the aperture: dark void with cyan plasma ----
  const glowAmt = 0.20 + charge * 0.55 + arc * 0.35;
  for (let j = -R; j <= R; j += ST) {
    for (let i = -R; i <= R; i += ST) {
      const d = hypot(i, j);
      if (d > R - tube * 0.55) continue;
      const u = d / (R - tube * 0.55);
      const n = fbm(615, (cx + i) / 9, (cy + j) / 9, 4, 8);
      let c = mix(rgba(10, 14, 20, 255), rgba(20, 34, 46, 255), n);
      // a plasma haze that pools toward the rim
      const halo = pow(u, 2.4) * glowAmt + (1 - u) * 0.10 * glowAmt;
      c = mix(c, mix(CYAN_D, CYAN, clamp(halo * 1.4, 0, 1)), clamp(halo * 1.15, 0, 1));
      put(cv, cx + i, cy + j, c, 0, 0, 1, 0.55 + 0.45 * (1 - u), 0.08, clamp(halo * 1.2, 0, 1));
    }
  }
  // energy arcs across the aperture
  const nArcs = 1 + Math.round(arc * 4);
  for (let k = 0; k < nArcs; k++) {
    const a0 = 0.3 + k * 1.37 + (P.arcPhase || 0);
    const a1 = a0 + PI * (0.62 + 0.4 * ((k * 7 % 5) / 5));
    const inner = R - tube - 1;
    boltPath(cv,
      cx + cos(a0) * inner, cy + sin(a0) * inner,
      cx + cos(a1) * inner, cy + sin(a1) * inner,
      16 + arc * 12, 617 + k * 31,
      mix(CYAN, rgba(240, 255, 255, 255), 0.35 + arc * 0.5), 1, 0.9 + arc * 0.7);
  }

  // ---- emitter ring ----
  ringTube(cv, cx, cy, R, tube, {
    gloss: 0.46, grain: 0.11, seed: 619,
    shader: (a, u, x, y) => {
      const ribs = 0.5 + 0.5 * sin(a * 30);
      let c = mix(shade(CHAR_D, 0.7), mix(CHAR, STEEL, 0.35),
        clamp(0.55 - cos(a + 0.6) * 0.5 - u * 0.4, 0, 1));
      c = shade(c, 0.90 + ribs * 0.18);
      if (fbm(621, x / 7, y / 7, 3, 8) > 0.72) c = mix(c, RUST, 0.28);
      return c;
    },
  });
  // inner lip that catches the plasma light
  ringTube(cv, cx, cy, R - tube * 0.82, tube * 0.32, {
    gloss: 0.7, grain: 0.06, seed: 623,
    shader: () => mix(CYAN_D, CYAN, 0.35 + charge * 0.4),
    em: 0.55 + charge * 0.45,
  });

  // ---- electrodes around the rim ----
  for (let k = 0; k < 8; k++) {
    const a = k * TAU / 8 + 0.19;
    const rOut = R - tube * 0.35, rIn = R - tube - 2.2;
    const x0 = cx + cos(a) * rOut, y0 = cy + sin(a) * rOut;
    const x1 = cx + cos(a) * rIn, y1 = cy + sin(a) * rIn;
    capsule(cv, x0, y0, x1, y1, 3.0, 1.8, { col: shade(CHAR, 1.15), gloss: 0.66, grain: 0.08, seed: 625 + k });
    const lit = clamp(charge * 1.2 - (k % 3) * 0.08, 0, 1);
    blob(cv, x1, y1, 2.1, {
      col: mix(CYAN_D, rgba(210, 252, 255, 255), lit), gloss: 0.4, grain: 0, seed: 627,
      em: 0.35 + lit * 0.65,
    });
  }
  // mounting collars where the struts meet the ring
  for (const [mx, my] of [[cx - 26, cy + 26], [cx + 26, cy + 26]]) {
    metalPanel(cv, mx - 6, my - 5, 12, 11, { col: STEEL_D, gloss: 0.5, bevel: 2, round: 3, seed: 629 });
    rivet(cv, mx, my, 2.0);
  }

  // ---- charge meter on the body ----
  meter(cv, 78, 120, 44, 9, 8, charge, { on: CYAN, off: rgba(24, 32, 38, 255) });
  stencil(cv, 'CHG', 78, 134, rgba(150, 180, 190, 255), 0.55);
  stencil(cv, 'HALO', 100, 134, rgba(150, 180, 190, 255), 0.55);

  // ---- side handles ----
  metalPanel(cv, 56, 116, 22, 9, { col: STEEL_D, gloss: 0.5, bevel: 2, round: 2, seed: 631 });
  capsule(cv, 60, 120, 54, 152, 8.2, 9.0, { shader: woodShader(633), gloss: 0.26, grain: 0, seed: 635 });
  metalPanel(cv, 122, 116, 22, 9, { col: STEEL_D, gloss: 0.5, bevel: 2, round: 2, seed: 637 });
  capsule(cv, 140, 120, 146, 152, 8.2, 9.0, { shader: woodShader(639), gloss: 0.26, grain: 0, seed: 641 });
  knurl(cv, 46, 126, 20, 22, 3, 0.2);
  knurl(cv, 134, 126, 20, 22, 3, 0.2);

  scuff(cv, 74, 96, 52, 50, 6051, 34, 0.38);
  soot(cv, 74, 96, 52, 50, 6053, 0.26, 11);
  underShadow(cv, 76, 124, 150, 4, 0.3);

  // ---- hands ----
  drawGlove(cv, { x: 42, y: 134, ang: -0.24, flip: 1, scale: 1.0, grip: 'fore', seed: 4301, wear: 0.5 });
  drawGlove(cv, { x: 158, y: 134, ang: 0.24, flip: -1, scale: 1.0, grip: 'fore', seed: 4311, wear: 0.5 });
}

// ---------------------------------------------------------------------------
// WEAPON 5 - THE DEADMAN'S SWITCH: a suitcase nuke's detonator
// ---------------------------------------------------------------------------

function drawDeadman(cv, P) {
  const cover = clamp(P.cover || 0, 0, 1);      // 0 closed, 1 flipped open
  const plunge = clamp(P.plunge || 0, 0, 1);
  const count = P.count === undefined ? '09' : P.count;
  const lamp = clamp(P.lamp || 0, 0, 1);
  const boxX = 62, boxY = 82, boxW = 84, boxH = 54;
  const plX = 124, plY = 114;

  // ---- wires trailing off the bottom of the frame ----
  const wireA = makeBez([[74, 132], [46, 138], [34, 158], [12, 168]]);
  const wireB = makeBez([[134, 132], [158, 140], [172, 156], [196, 170]]);
  for (const [bz, col] of [[wireA, rgba(158, 46, 38, 255)], [wireB, rgba(28, 26, 30, 255)]]) {
    let prev = bz(0);
    for (let s = 1; s <= 40; s++) {
      const cur = bz(s / 40);
      capsule(cv, prev[0], prev[1], cur[0], cur[1], 3.0, 3.0, {
        col, gloss: 0.45, grain: 0.07, seed: 701,
      });
      prev = cur;
    }
  }

  // ---- forearm, drawn before the case so the hand wraps around it ----
  {
    const shArm = leatherShader(4407, { wear: 0.5, dark: 0.12 });
    capsule(cv, 140, 150, 176, 176, 11.0, 13.0, { shader: shArm, gloss: 0.18, grain: 0, seed: 4409 });
  }

  // ---- the case ----
  metalPanel(cv, boxX, boxY, boxW, boxH, {
    col: ALUM, gloss: 0.46, bevel: 4, round: 6, seed: 703, grain: 0.13, curve: 0.35,
  });
  // recessed front face
  metalPanel(cv, boxX + 6, boxY + 8, boxW - 12, boxH - 16, {
    col: ALUM_D, gloss: 0.36, bevel: 3, round: 4, seed: 705, grain: 0.12, ao: 0.88,
  });
  for (const x of [boxX + 5, boxX + boxW - 6]) for (const y of [boxY + 5, boxY + boxH - 6]) screwHead(cv, x, y, 2.6, 0.7);
  // carry lip
  metalPanel(cv, boxX + 18, boxY - 5, 30, 8, { col: shade(ALUM_D, 0.8), gloss: 0.4, bevel: 2, round: 3, seed: 707 });

  // ---- countdown wheel in a window ----
  const wx = boxX + 10, wy = boxY + 12;
  metalPanel(cv, wx - 3, wy - 3, 28, 20, { col: rgba(52, 52, 58, 255), gloss: 0.5, bevel: 2, round: 2, seed: 709 });
  for (let j = 0; j < 14; j += ST) {
    for (let i = 0; i < 22; i += ST) {
      const v = 0.5 + 0.5 * sin((j / 14) * PI);
      put(cv, wx + i, wy + j, mix(rgba(26, 24, 26, 255), rgba(64, 60, 58, 255), v), 0, (j / 14 - 0.5) * 0.9, 0.6, 0.55, 0.24, 0);
    }
  }
  stencil(cv, String(count).slice(0, 2), wx + 4, wy + 4, rgba(238, 226, 200, 255), 0.95, 2, 2);
  // knurled wheel edges peeking out of the window
  for (let i = 0; i < 22; i += ST) {
    const k = 0.5 + 0.5 * sin(i * 1.7);
    tint(cv, wx + i, wy, shade(rgba(150, 148, 146, 255), 0.7 + k * 0.6), 0.7);
    tint(cv, wx + i, wy + 13, shade(rgba(120, 118, 116, 255), 0.6 + k * 0.5), 0.7);
  }

  // ---- arming lamp ----
  blob(cv, boxX + 13, boxY + 40, 4.2, {
    col: mix(rgba(78, 26, 22, 255), rgba(255, 130, 90, 255), lamp), gloss: 0.5, grain: 0.04,
    em: 0.15 + lamp * 0.85,
  });
  ringTube(cv, boxX + 13, boxY + 40, 5.0, 1.6, { col: STEEL_D, gloss: 0.6, grain: 0.07, seed: 711 });

  // ---- plunger: chrome collar + big red mushroom ----
  const pd = plunge * 7;
  ringTube(cv, plX, plY + 8, 17, 5.0, {
    squashY: 0.42, gloss: 0.62, grain: 0.09, seed: 713,
    shader: (a, u) => mix(shade(STEEL_D, 0.6), STEEL_B, clamp(0.55 - cos(a + 0.5) * 0.5 - u * 0.4, 0, 1)),
  });
  cylinderV(cv, plX, plY + 2 + pd, plY + 10, 12.5, { col: STEEL, gloss: 0.6, grain: 0.09, seed: 715, aoEdge: 0.45 });
  const red = mix(rgba(198, 40, 32, 255), rgba(150, 26, 22, 255), plunge);
  blob(cv, plX, plY - 4 + pd, 15.5, {
    gloss: 0.55, grain: 0.06, seed: 717, squashY: 0.66,
    shader: (u, v) => {
      const d = hypot(u, v);
      let c = mix(mix(red, rgba(238, 96, 78, 255), 0.35), shade(red, 0.55), clamp(d * 0.9, 0, 1));
      if (fbm(719, u * 9, v * 9, 3, 8) > 0.76) c = shade(c, 0.82);
      return c;
    },
  });
  // worn paint on the crown showing bare metal
  for (let k = 0; k < 26; k++) {
    const a = hash2(k, 3, 721) * TAU, r = hash2(k, 9, 723) * 12;
    tint(cv, plX + cos(a) * r, plY - 6 + pd + sin(a) * r * 0.62, rgba(148, 132, 120, 255),
      hash2(k, 17, 725) > 0.55 ? 0.5 : 0);
  }

  // ---- hinged safety cover, swinging in the picture plane ----
  const cg = makeCv(cv.w, cv.h);
  const hgX = boxX + 4, hgY = boxY + 22;
  metalPanel(cg, hgX, hgY - 15, 62, 30, {
    col: rgba(122, 124, 130, 255), gloss: 0.5, bevel: 3, round: 5, seed: 727, grain: 0.12, curve: 0.3,
  });
  metalPanel(cg, hgX + 6, hgY - 10, 50, 20, {
    col: rgba(98, 100, 106, 255), gloss: 0.34, bevel: 2, round: 3, seed: 729, ao: 0.85,
  });
  hazardStripe(cg, hgX + 8, hgY - 8, 46, 7, { pitch: 6, amt: 0.7, wear: 0.55 });
  stencil(cg, 'ARM', hgX + 22, hgY + 2, rgba(220, 214, 200, 255), 0.7);
  // thumb tab on the free edge
  metalPanel(cg, hgX + 58, hgY - 8, 8, 16, { col: rgba(140, 142, 148, 255), gloss: 0.6, bevel: 2, round: 2, seed: 731 });
  knurl(cg, hgX + 58, hgY - 8, 8, 16, 2, 0.34);
  scuff(cg, hgX, hgY - 15, 66, 30, 733, 26, 0.42);
  compositeCv(cv, poseCv(cg, -cover * 1.95, MPX(hgX), MPY(hgY), 0, 0));
  // hinge barrel
  cylinderH(cv, hgX - 5, hgX + 5, hgY, 4.0, { col: STEEL_D, gloss: 0.6, grain: 0.09, seed: 735 });
  for (let k = 0; k < 3; k++) {
    const a = -cover * 1.95 + k * 0.5 - 0.6;
    capsule(cv, hgX, hgY, hgX + cos(a) * 7, hgY + sin(a) * 7, 1.2, 1.0,
      { col: rgba(150, 150, 156, 255), gloss: 0.7, grain: 0.05, seed: 737 });
  }

  // ---- markings + abuse ----
  stencil(cv, 'DEADMAN', boxX + 24, boxY + 38, rgba(74, 70, 64, 255), 0.62);
  stencil(cv, 'S-9 KT', boxX + 24, boxY + 45, rgba(86, 82, 76, 255), 0.5);
  scuff(cv, boxX, boxY, boxW, boxH, 741, 46, 0.42);
  soot(cv, boxX, boxY, boxW, boxH, 743, 0.3, 12);
  underShadow(cv, boxX, boxX + boxW, boxY + boxH, 5, 0.4);

  // ---- the single gloved hand ----
  drawGlove(cv, {
    x: 136, y: 142, ang: 0.86, flip: -1, scale: 1.02, grip: 'flat',
    seed: 4401, wear: 0.62, thumbTo: [plX + 2, plY - 4 + pd],
  });
}

// ---------------------------------------------------------------------------
// weapon frame assembly
// ---------------------------------------------------------------------------

const BAYER4 = [
  0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5,
];

/**
 * Muzzle smoke drawn straight onto a finished weapon frame. Weapon frames stay
 * strictly alpha 0/255, so coverage is resolved with an ordered dither - which
 * is also exactly how a 1992 shooter would have done it.
 */
function muzzleSmoke(frame, cx, cy, amt, seed, o = {}) {
  if (amt <= 0.01) return frame;
  const { spread = 1, warm = 0.35, drift = -0.35 } = o;
  const rng = makeRng(seed);
  const puffs = 8 + ((amt * 12) | 0);
  for (let i = 0; i < puffs; i++) {
    const t = i / puffs;
    const rise = t * 22 * amt * spread;
    const x = cx + (rng() - 0.5) * 20 * spread + drift * rise * 0.5;
    const y = cy - rise - rng() * 5;
    const r = (4.2 + rng() * 6.5) * (0.55 + amt * 0.7) * (0.62 + t * 1.05);
    const heat = clamp(warm * (1 - t * 1.5), 0, 1);
    for (let j = -ceil(r); j <= ceil(r); j++) {
      for (let k = -ceil(r); k <= ceil(r); k++) {
        const d = hypot(k, j) / r;
        if (d > 1) continue;
        const n = fbm(seed + i * 13, (x + k) / 5, (y + j) / 5, 3, 8);
        const dens = pow(1 - d, 1.2) * (0.62 + n * 0.95) * amt * (1.10 - t * 0.40);
        const ix = (x + k) | 0, iy = (y + j) | 0;
        if (ix < 0 || iy < 0 || ix >= frame.w || iy >= frame.h) continue;
        const th = (BAYER4[(iy & 3) * 4 + (ix & 3)] + 0.5) / 16;
        const jit = hash2(ix, iy, seed) * 0.28;
        if (dens < th * 0.92 + jit) continue;
        const g = 60 + n * 74 - t * 22;
        let c = rgba(g * (1 + heat * 0.55), g * (1 + heat * 0.16), g * (1 - heat * 0.22), 255);
        frame.data[iy * frame.w + ix] = c;
      }
    }
  }
  return frame;
}

/** Per-weapon muzzle anchor (model space) - flash light origin and smoke source. */
const MUZZLE = {
  // the Widow's bore end after the barrel is swung to WIDOW.ang about the hinge
  pistol: [
    WIDOW.hingeX + (WIDOW.muzX - WIDOW.hingeX) * cos(WIDOW.ang)
      - (WIDOW.muzY - WIDOW.hingeY) * sin(WIDOW.ang),
    WIDOW.hingeY + (WIDOW.muzX - WIDOW.hingeX) * sin(WIDOW.ang)
      + (WIDOW.muzY - WIDOW.hingeY) * cos(WIDOW.ang),
  ],
  splitter: [98, 44], nailer: [100, 40], halo: [100, 60], deadman: [104, 30],
  // neither of these has a muzzle; the anchor is just where their light lives
  boot: [100, 58], pipebomb: [104, 44],
};

/**
 * How each weapon is sized into the 200x150 frame: scale about a model-space
 * centre, landing on a canvas-space target. This is the one knob for
 * composition - the models themselves never move.
 */
const WEAPON_FIT = {
  pistol: { s: 1.34, cx: 100, cy: 106, tx: 102, ty: 100 },
  splitter: { s: 1.26, cx: 99, cy: 100, tx: 100, ty: 94 },
  nailer: { s: 1.24, cx: 100, cy: 100, tx: 100, ty: 95 },
  halo: { s: 1.16, cx: 100, cy: 92, tx: 100, ty: 86 },
  deadman: { s: 1.24, cx: 104, cy: 118, tx: 100, ty: 108 },
  boot: { s: 0.96, cx: 100, cy: 100, tx: 100, ty: 104 },
  pipebomb: { s: 1.06, cx: 100, cy: 100, tx: 100, ty: 98 },
};

const WEAPON_POSES = {
  pistol: {
    idle: { dx: 0, dy: 0, rot: 0, flash: 0, P: { hammer: 1, fuse: 0.62 } },
    fire0: { dx: -3, dy: 11, rot: 0.15, flash: 1.0, P: { hammer: 0, fuse: 0.62, heat: 1 } },
    fire1: { dx: -1, dy: 5, rot: 0.07, flash: 0.24, smoke: 0.85, P: { hammer: 0, fuse: 0.62, heat: 0.55 } },
    fire2: { dx: 0, dy: 2, rot: 0.02, flash: 0.05, smoke: 0.32, P: { hammer: 0, fuse: 0.62, heat: 0.2 } },
    reload0: { dx: 5, dy: 8, rot: -0.10, flash: 0, smoke: 0.2, P: { hammer: 0, open: 1, spent: 1, fuse: 0.62, heat: 0.35, loadHand: 0 } },
    reload1: { dx: 3, dy: 6, rot: -0.06, flash: 0, P: { hammer: 0, open: 0.82, freshShell: 1, fuse: 0.4, loadHand: 1 } },
  },
  splitter: {
    idle: { dx: 0, dy: 0, rot: 0, flash: 0, P: { breechAng: 0 } },
    fire0: { dx: 0, dy: 13, rot: 0.10, flash: 1.0, flashR: 165, P: { breechAng: 0.15, heat: 1 } },
    fire1: { dx: 0, dy: 6, rot: 0.05, flash: 0.26, smoke: 1.0, P: { breechAng: 0.55, heat: 0.6 } },
    fire2: { dx: 0, dy: 2, rot: 0.01, flash: 0.06, smoke: 0.4, P: { breechAng: 1.0, heat: 0.25 } },
    reload0: { dx: 4, dy: 9, rot: -0.09, flash: 0, smoke: 0.25, P: { breechAng: 2.09, emptyChamber: 1, heat: 0.3 } },
    reload1: { dx: 2, dy: 6, rot: -0.05, flash: 0, P: { breechAng: 2.4 } },
  },
  nailer: {
    idle: { dx: 0, dy: 0, rot: 0, flash: 0, P: { spin: 0, beltAdv: 0 } },
    fire0: { dx: -2, dy: 8, rot: 0.07, flash: 1.0, flashR: 150, P: { spin: 0.9, beltAdv: 0.3, heat: 1 } },
    fire1: { dx: 2, dy: 6, rot: -0.04, flash: 0.55, smoke: 0.7, P: { spin: 2.1, beltAdv: 0.6, heat: 0.85 } },
    fire2: { dx: -1, dy: 3, rot: 0.03, flash: 0.14, smoke: 0.35, P: { spin: 3.4, beltAdv: 0.9, heat: 0.5 } },
    reload0: { dx: 5, dy: 10, rot: -0.11, flash: 0, smoke: 0.2, P: { spin: 0.4, beltAdv: 0.15, heat: 0.35 } },
    reload1: { dx: 3, dy: 6, rot: -0.06, flash: 0, P: { spin: 0.6, beltAdv: 0.5, heat: 0.15 } },
  },
  halo: {
    idle: { dx: 0, dy: 0, rot: 0, flash: 0, P: { charge: 1, arc: 0.35, arcPhase: 0 } },
    fire0: {
      dx: 0, dy: 10, rot: 0.04, flash: 1.0, flashR: 175,
      flashCol: [0.52, 0.95, 1.0], P: { charge: 0.62, arc: 1, arcPhase: 1.2 },
    },
    fire1: { dx: 0, dy: 5, rot: 0.02, flash: 0.30, flashCol: [0.5, 0.9, 1.0], P: { charge: 0.34, arc: 0.7, arcPhase: 2.4 } },
    fire2: { dx: 0, dy: 2, rot: 0, flash: 0.08, flashCol: [0.5, 0.9, 1.0], P: { charge: 0.10, arc: 0.35, arcPhase: 3.6 } },
    reload0: { dx: 3, dy: 8, rot: -0.07, flash: 0.05, flashCol: [0.5, 0.9, 1.0], P: { charge: 0.02, arc: 0.05, arcPhase: 4.8 } },
    reload1: { dx: 1, dy: 4, rot: -0.03, flash: 0.16, flashCol: [0.5, 0.9, 1.0], P: { charge: 0.55, arc: 0.5, arcPhase: 5.9 } },
  },
  deadman: {
    idle: { dx: 0, dy: 0, rot: 0, flash: 0, P: { cover: 0, plunge: 0, count: '09', lamp: 0.15 } },
    fire0: {
      dx: -1, dy: 4, rot: -0.03, flash: 1.0, flashR: 230, flashCol: [1.0, 0.94, 0.86],
      P: { cover: 1, plunge: 1, count: '00', lamp: 1 },
    },
    fire1: { dx: 1, dy: 2, rot: 0.02, flash: 0.42, flashCol: [1.0, 0.86, 0.62], P: { cover: 1, plunge: 0.7, count: '00', lamp: 0.8 } },
    fire2: { dx: 0, dy: 1, rot: 0, flash: 0.12, flashCol: [1.0, 0.8, 0.6], P: { cover: 0.9, plunge: 0.25, count: '01', lamp: 0.45 } },
    reload0: { dx: 3, dy: 6, rot: -0.06, flash: 0, P: { cover: 0.55, plunge: 0, count: '05', lamp: 0.25 } },
    reload1: { dx: 1, dy: 3, rot: -0.02, flash: 0, P: { cover: 0.12, plunge: 0, count: '09', lamp: 0.15 } },
  },
  // The kick: at rest it is almost entirely below the frame, then the leg
  // straightens into the middle distance and retracts. `ext` is the whole
  // animation - it scales the leg about a pivot off the bottom of the frame.
  boot: {
    idle: { dx: 0, dy: 0, rot: 0, flash: 0, P: { rest: 1, lift: 0 } },
    fire0: {
      dx: -2, dy: 0, rot: 0.03, flash: 0.42, flashR: 150, flashCol: [1.0, 0.92, 0.80],
      P: { ext: 1.0, mud: 0.6, blood: 0.75, dust: 0.5 },
    },
    fire1: { dx: 3, dy: 6, rot: -0.05, flash: 0.10, P: { ext: 0.90, mud: 0.6, blood: 0.6, dust: 0.9 } },
    fire2: { dx: 1, dy: 10, rot: 0.02, flash: 0, P: { ext: 0.80, mud: 0.55, blood: 0.4, dust: 0.45 } },
    reload0: { dx: -3, dy: 10, rot: -0.04, flash: 0, P: { ext: 0.74, mud: 0.55, blood: 0.25, dust: 0.2 } },
    reload1: { dx: 0, dy: 0, rot: 0, flash: 0, P: { rest: 1, lift: 20 } },
  },
  // The pipe bomb: held cocked back, thrown, then the off hand fetches another.
  pipebomb: {
    idle: { dx: 0, dy: 0, rot: 0, flash: 0, P: { stage: 'hold', dial: 0.35 } },
    fire0: { dx: -4, dy: 7, rot: -0.09, flash: 0, P: { stage: 'throw', dial: 0.06 } },
    fire1: { dx: 2, dy: 5, rot: 0.03, flash: 0, P: { stage: 'empty', spare: 0.0, close: 0.1 } },
    fire2: { dx: 1, dy: 2, rot: 0.01, flash: 0, P: { stage: 'empty', spare: 0.8, close: 0.4 } },
    reload0: { dx: 4, dy: 8, rot: -0.06, flash: 0, P: { stage: 'wind', dial: 0.10, windShift: 5 } },
    reload1: { dx: 2, dy: 4, rot: -0.02, flash: 0, P: { stage: 'wind', dial: 0.68, windShift: -4 } },
  },
};

const WEAPON_DRAW = {
  pistol: drawWidow, splitter: drawSplitter, nailer: drawNailer, halo: drawHalo, deadman: drawDeadman,
  boot: drawBoot, pipebomb: drawPipebomb,
};

const VM_W = 200, VM_H = 150;
const POSE_KEYS = ['idle', 'fire0', 'fire1', 'fire2', 'reload0', 'reload1'];

function buildWeapon(out, name) {
  const draw = WEAPON_DRAW[name];
  const fit = WEAPON_FIT[name];
  const m = MUZZLE[name];
  const mz = [fit.tx + (m[0] - fit.cx) * fit.s, fit.ty + (m[1] - fit.cy) * fit.s];
  const poses = WEAPON_POSES[name];
  let seed = 9000;
  for (const k of POSE_KEYS) {
    const pose = poses[k];
    const cv = makeCv(VM_W, VM_H);
    setModel(fit.s, fit.cx, fit.cy, fit.tx, fit.ty);
    draw(cv, pose.P || {});
    setModel();
    const posed = poseCv(cv, pose.rot || 0, 100, 152, pose.dx || 0, pose.dy || 0);
    // recoil moves the muzzle, so the flash light has to move with it
    const ca = cos(pose.rot || 0), sa = sin(pose.rot || 0);
    const ox = mz[0] - 100, oy = mz[1] - 152;
    const fx = 100 + ox * ca - oy * sa + (pose.dx || 0);
    const fy = 152 + ox * sa + oy * ca + (pose.dy || 0);
    const f = bake(posed, {
      flash: pose.flash || 0,
      fx, fy: fy - 6, fz: 30,
      flashCol: pose.flashCol || [1.0, 0.78, 0.46],
      flashR: pose.flashR || 130,
      fill: 0.20, rim: 0.32, botDark: 0.34, bounce: 0.13,
    });
    rimOutline(f, rgba(15, 12, 18, 255));
    if (pose.smoke) muzzleSmoke(f, fx, fy - 2, pose.smoke, (seed += 137), { spread: name === 'splitter' ? 1.5 : 1 });
    out[name + '_' + k] = f;
  }
}

// ---------------------------------------------------------------------------
// FX: muzzle flashes (additive), explosions, sparks, smoke, debris, shock rings
// ---------------------------------------------------------------------------

/**
 * Irregular petal envelope: a handful of angular lobes of random width and
 * amplitude. Sampling this instead of a symmetric cos() star is what stops the
 * muzzle flash reading as a sparkle.
 */
function makeEnvelope(seed, lobes, rough) {
  const rng = makeRng(seed);
  const L = [];
  for (let k = 0; k < lobes; k++) {
    L.push({
      a: (k / lobes) * TAU + (rng() - 0.5) * (TAU / lobes) * 0.8,
      amp: lerp(0.55, 1.0, rng()),
      w: lerp(0.30, 0.72, rng()),
    });
  }
  const ENV = 512, env = new Float32Array(ENV);
  let mx = 0;
  for (let i = 0; i < ENV; i++) {
    const a = (i / ENV) * TAU;
    let v = 0.30;
    for (const l of L) {
      let d = a - l.a;
      while (d > PI) d -= TAU; while (d < -PI) d += TAU;
      v += l.amp * exp(-(d / l.w) * (d / l.w));
    }
    v *= 0.78 + 0.44 * fbm(seed + 9, cos(a) * 2.4 + 4, sin(a) * 2.4 + 4, 3, 8) * rough * 2;
    env[i] = v;
    if (v > mx) mx = v;
  }
  for (let i = 0; i < ENV; i++) env[i] = 0.56 + 0.44 * (env[i] / mx);
  return (a) => env[((((a % TAU) + TAU) % TAU) / TAU * ENV) | 0];
}

/**
 * Muzzle flash: a gout of burning propellant. Additive, blown-out core, ragged
 * petals, a couple of long spikes, and sparks thrown clear. Alpha falls to 0
 * before the frame edge so it can be scaled anywhere over the viewmodel.
 */
function drawFlash(size, o = {}) {
  const {
    R = 44, lobes = 4, seed = 1201, spikes = 3, core = 0.32,
    tint: tintCol = [1, 1, 1], sparks = 26, rough = 0.5, oy = 0,
    ringMode = 0, ringR = 0.62, plume = 0, gain = 1,
  } = o;
  const f = makeFrame(size, size);
  const cx = size / 2, cy = size / 2 + oy;
  const rng = makeRng(seed);
  const env = makeEnvelope(seed, lobes, rough);
  // a few long spikes at fixed angles, each with its own reach
  const SP = [];
  for (let k = 0; k < spikes; k++) SP.push({ a: rng() * TAU, len: lerp(1.5, 2.5, rng()), w: lerp(0.06, 0.16, rng()) });
  const edge = size * 0.47;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx, dy = y - cy;
      const d = hypot(dx, dy);
      let ang = atan2(dy, dx); if (ang < 0) ang += TAU;
      let inten;
      if (plume) {
        // a torch: narrow at the muzzle, bellying out, tapering to licks
        const up = -dy / (R * plume);
        if (up < -0.30) continue;
        const u = clamp(up, 0, 1.15);
        const lick = 0.72 + 0.55 * fbm(seed + 5, x / 7, y / 9 - 1.5, 4, 8);
        const wid = R * 0.62 * pow(sin(clamp(u, 0, 1) * PI * 0.86 + 0.30), 0.72) * lick;
        const lat = abs(dx) / max(1, wid);
        inten = pow(max(0, 1 - lat), 1.05) * pow(max(0, 1 - abs(u - 0.30) / 1.05), 1.3) * 1.7;
        inten *= 0.55 + fbm(seed + 11, x / 4.5, y / 6 - 2, 3, 8) * 1.0;
        inten += pow(max(0, 1 - hypot(dx, dy * 0.7) / (R * core * 1.4)), 1.6) * 2.9;
      } else if (ringMode) {
        const rr = R * ringR * (0.94 + (env(ang) - 0.78) * 0.16);
        const band = R * 0.20;
        inten = pow(max(0, 1 - abs(d - rr) / band), 1.5) * 1.7;
        inten += pow(max(0, 1 - abs(d - rr) / (band * 3.4)), 2.6) * 0.5;
        inten += pow(max(0, 1 - d / (rr * 0.42)), 3) * 0.9;
        // radiating spokes inside the aperture
        inten += pow(max(0, cos(ang * 12) * 0.5 + 0.5), 18) * pow(max(0, 1 - d / rr), 2.4) * 0.6;
      } else {
        const e = env(ang) * R;
        inten = pow(max(0, 1 - d / e), 0.80) * 1.45;
      }
      if (!plume) for (const sp of SP) {
        let da = ang - sp.a;
        while (da > PI) da -= TAU; while (da < -PI) da += TAU;
        const k = exp(-(da / sp.w) * (da / sp.w));
        inten += k * pow(max(0, 1 - d / (R * sp.len)), 2.2) * 0.9;
      }
      if (!plume) inten += pow(max(0, 1 - d / (R * core)), 1.9) * 3.1;
      if (inten <= 0.006) continue;
      // hard fade before the frame edge so nothing clips
      const clip = smoothstep(edge, edge * 0.74, hypot(x - size / 2, y - size / 2));
      inten *= clip;
      if (inten <= 0.006) continue;
      const heat = clamp(0.98 - inten * 0.80, 0, 1);
      const c = hotGradient(heat);
      // white-hot only at the very centre
      const wh = clamp((inten - 2.3) * 0.55, 0, 1);
      const cr = lerp(c[0], 255, wh), cg = lerp(c[1], 252, wh), cb = lerp(c[2], 240, wh);
      const a = clamp(pow(inten, 0.74) * 1.02 * gain, 0, 1);
      addPx(f, x, y, cr * a * tintCol[0], cg * a * tintCol[1], cb * a * tintCol[2], a);
    }
  }
  // sparks and burning grains thrown clear of the flash
  for (let i = 0; i < sparks; i++) {
    const a = rng() * TAU;
    const r = R * (0.70 + rng() * 1.05);
    const len = 2 + rng() * 8;
    for (let s2 = 0; s2 < len; s2++) {
      const t = s2 / len;
      const rr = r - len + s2;
      const x = cx + cos(a) * rr, y = cy + sin(a) * rr * (plume ? 1.5 : 1);
      if (hypot(x - size / 2, y - size / 2) > edge * 0.98) continue;
      const al = (1 - t) * 0.95;
      const c = hotGradient(0.08 + t * 0.5);
      addPx(f, x, y, c[0] * al * tintCol[0], c[1] * al * tintCol[1], c[2] * al * tintCol[2], al);
    }
  }
  return f;
}

/** One frame of an airburst: turbulent fireball inside an expanding smoke shell. */
function drawBoom(size, t, seed = 1301) {
  const f = makeFrame(size, size);
  const cx = size / 2, cy = size / 2;
  const edge = size * 0.44;
  const R = lerp(9, 42, pow(t, 0.55));
  const fireR = R * lerp(1.05, 0.44, pow(t, 0.75));
  const smokeR = R * lerp(0.95, 1.20, t);
  const cool = pow(t, 0.85);

  // --- smoke shell first, so fire composites over it ---
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx, dy = y - cy;
      const d = hypot(dx, dy);
      if (d > edge) continue;
      const ang = atan2(dy, dx);
      const warp = fbm(seed + 3, cos(ang) * 3.2 + 4 + t * 2, sin(ang) * 3.2 + 4, 3, 8);
      const puff = fbm(seed + 7, x / (7 + t * 7), y / (7 + t * 7), 3, 8);
      const puff2 = fbm(seed + 13, x / 3.4, y / 3.4, 2, 8);
      const rr = smokeR * (0.66 + warp * 0.60);
      const shell = pow(max(0, 1 - abs(d - rr * 0.66) / (rr * 0.82)), 1.35);
      let dens = shell * (0.26 + puff * 1.35 + puff2 * 0.34) * smoothstep(0.02, 0.30, t) * (1.2 - cool * 0.35);
      dens *= smoothstep(edge, edge * 0.66, d);
      if (dens < 0.02) continue;
      const lit = clamp(1 - d / (fireR * 2.0), 0, 1) * (1 - cool * 0.7);
      const g = smokeGradient(clamp(0.22 + cool * 0.68 - lit * 0.5, 0, 1));
      const c = rgba(g[0] + lit * 110, g[1] + lit * 52, g[2] + lit * 10, 255);
      blend(f, x, y, c, clamp(dens, 0, 0.95));
    }
  }
  // --- fireball ---
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx, dy = y - cy;
      const d = hypot(dx, dy);
      if (d > fireR * 1.9 || d > edge) continue;
      const turb = fbm(seed, x / (5 + t * 8), y / (5 + t * 8), 3, 8);
      const turb2 = fbm(seed + 11, x / 2.8, y / 2.8, 2, 8);
      const rr = fireR * (0.72 + turb * 0.70);
      let inten = pow(max(0, 1 - d / rr), 1.30) * (1.30 - cool * 0.75);
      inten *= 0.58 + turb2 * 0.80;
      inten += pow(max(0, 1 - d / (fireR * 0.44)), 2.1) * (1.85 - cool * 1.82);
      if (inten < 0.03) continue;
      const heat = clamp(0.86 - inten * 0.84 + cool * 0.44, 0, 1);
      const c = hotGradient(heat);
      const wh = clamp((inten - 1.5) * 0.8, 0, 1);
      const a = clamp(pow(inten, 0.66) * 1.2, 0, 1);
      blend(f, x, y, rgba(lerp(c[0], 255, wh), lerp(c[1], 254, wh), lerp(c[2], 246, wh), 255), a);
    }
  }
  // --- embers thrown clear ---
  const rng = makeRng(seed + 100 + (t * 97 | 0));
  const n = (30 * (1 - t * 0.55)) | 0;
  for (let i = 0; i < n; i++) {
    const a = rng() * TAU, r = R * (0.85 + rng() * 1.25 * (0.3 + t));
    const x = cx + cos(a) * r, y = cy + sin(a) * r;
    if (hypot(x - cx, y - cy) > edge) continue;
    const c = hotGradient(0.10 + rng() * 0.45 + cool * 0.3);
    const al = (1 - t * 0.7) * (0.55 + rng() * 0.45);
    blend(f, x, y, rgba(c[0], c[1], c[2], 255), al);
    blend(f, x - cos(a), y - sin(a), rgba(c[0], c[1], c[2], 255), al * 0.55);
  }
  return f;
}

/** Smoke colour at cloud age `t`, lit from within by `glow`. */
function nukeCol(t, glow) {
  const g = smokeGradient(clamp(0.16 + t * 0.62, 0, 1));
  if (glow <= 0.02) return rgba(g[0], g[1], g[2], 255);
  const h = hotGradient(clamp(0.96 - glow * 0.86, 0, 1));
  const k = clamp(glow * 1.2, 0, 1);
  return rgba(lerp(g[0], h[0], k), lerp(g[1], h[1], k), lerp(g[2], h[2], k), 255);
}

/**
 * The city killer. Ten frames from a point of light to a cold anvil-topped
 * column. The cap and stem are built from overlapping billow lobes rather than
 * one smooth blob - that is what makes it read as cauliflower.
 */
function drawNuke(size, t, seed = 1401) {
  const f = makeFrame(size, size);
  const cx = size / 2;
  const ground = size - 12;
  const rise = smoothstep(0.02, 0.90, t);
  const capY = lerp(ground - 8, 54, rise);
  const capR = lerp(4, 60, pow(t, 0.50));
  const heat = clamp(1.28 - t * 1.50, 0, 1);
  const stemW = lerp(2.5, 20, pow(t, 0.66));
  const flash = pow(max(0, 1 - t * 4.6), 1.5);
  const age = pow(t, 0.85);
  const rng = makeRng(seed);

  // ---- ground-hugging dust wall ----
  if (t > 0.08) {
    const dw = lerp(12, 88, pow(t - 0.08, 0.58));
    for (let y = ground - 30; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = (x - cx) / dw, dy = (y - ground) / 24;
        const d = hypot(dx, dy * 1.4);
        if (d > 1.2) continue;
        const n = fbm(seed + 21, x / 11, y / 8 + t * 3, 3, 8);
        const dens = pow(max(0, 1 - d), 1.0) * (0.30 + n * 1.05) * clamp((t - 0.08) * 3.2, 0, 1);
        if (dens < 0.02) continue;
        const glow = clamp(heat * (1 - d) * 1.3, 0, 1);
        blend(f, x, y, nukeCol(age * 0.9, glow), clamp(dens, 0, 0.94));
      }
    }
  }

  // ---- stem: a stack of billow lobes with a flared base ----
  if (t > 0.05) {
    const rows = 34;
    for (let k = rows; k >= 0; k--) {
      const u = k / rows;                       // 0 at the cap, 1 at the ground
      const y = lerp(capY + capR * 0.30, ground, u);
      const flare = 1 + pow(u, 3.2) * 2.1;
      const w = stemW * flare;
      const wob = sin(u * 4.2 + t * 2.6) * stemW * 0.30;
      for (const sx of [-1.1, -0.45, 0.35, 1.0]) {
        const lx = cx + wob + sx * w * 0.52;
        const lr = w * (abs(sx) < 0.5 ? 0.74 : 0.56) * (0.72 + 0.55 * fbm(seed + 33, k * 1.7, sx + 2, 3, 8));
        for (let j = -lr; j <= lr; j++) {
          for (let i = -lr; i <= lr; i++) {
            const d = hypot(i, j * 1.5) / lr;
            if (d > 1) continue;
            const n = fbm(seed + 31, (lx + i) / 7, (y + j) / 7, 3, 8);
            const dens = pow(1 - d, 0.9) * (0.42 + n * 0.85);
            if (dens < 0.04) continue;
            const glow = clamp(heat * (1 - u * 0.30) * (1 - d * 0.55) * 1.15, 0, 1);
            blend(f, lx + i, y + j, nukeCol(age, glow), clamp(dens * 0.86, 0, 0.96));
          }
        }
      }
    }
  }

  // ---- cap: billow lobes packed onto a dome ----
  const NL = 54;
  for (let k = 0; k < NL; k++) {
    const jitter = fbm(seed + 39, k * 0.7, 1, 3, 8);
    const a = -PI * 0.03 - (k / (NL - 1)) * PI * 0.94 + (jitter - 0.5) * 0.22;
    const ring = ((k * 7) % 5) / 5;
    const rr = capR * (0.34 + ring * 0.66 + (jitter - 0.5) * 0.26);
    const lx = cx + cos(a) * rr * 1.06;
    const ly = capY + sin(a) * rr * 0.76;
    const lr = capR * (0.15 + 0.20 * fbm(seed + 41, k * 1.3, 1, 3, 8) + (1 - ring) * 0.16);
    for (let j = -lr; j <= lr; j++) {
      for (let i = -lr; i <= lr; i++) {
        const d = hypot(i, j * 1.18) / lr;
        if (d > 1) continue;
        const n = fbm(seed + 43, (lx + i) / 8, (ly + j) / 8, 3, 8);
        const n2 = fbm(seed + 47, (lx + i) / 3, (ly + j) / 3, 2, 8);
        const dens = pow(1 - d, 0.8) * (0.44 + n * 0.80 + n2 * 0.22);
        if (dens < 0.05) continue;
        // hot from inside and underneath, cool and top-lit above
        const rel = (ly + j - capY) / max(1, capR);
        const inner = clamp(1 - hypot((lx + i - cx) / capR, rel * 1.3), 0, 1);
        const glow = clamp(heat * (inner * 1.05 + max(0, rel) * 0.55), 0, 1.2);
        let c = nukeCol(age, glow);
        if (glow < 0.16) {
          const topLit = clamp(-rel * 0.8 + 0.30, 0, 1) * (1 - d * 0.4);
          c = rgba((c & 255) + topLit * 62, ((c >>> 8) & 255) + topLit * 58, ((c >>> 16) & 255) + topLit * 54, 255);
        }
        blend(f, lx + i, ly + j, c, clamp(dens * (0.95 - t * 0.10), 0, 0.98));
      }
    }
  }
  // the cap's shadowed underside
  for (let x = cx - capR * 1.2; x <= capR * 1.2 + cx; x++) {
    const u = (x - cx) / (capR * 1.2);
    if (abs(u) > 1) continue;
    const yy = capY + capR * 0.52 * sqrt(max(0, 1 - u * u)) + capR * 0.10;
    for (let d = 0; d < capR * 0.20; d++) {
      blend(f, x, yy - d, rgba(44, 36, 38, 255), 0.075 * (1 - d / (capR * 0.20)));
    }
  }

  // ---- condensation collar: soft, wide, and low contrast ----
  if (t > 0.30 && t < 0.94) {
    const cr = capR * 1.24, cy2 = capY + capR * 0.42, ch2 = capR * 0.30;
    const amt = smoothstep(0.30, 0.52, t) * (1 - smoothstep(0.74, 0.94, t));
    for (let y = cy2 - ch2 * 2; y <= cy2 + ch2 * 2; y++) {
      for (let x = cx - cr * 1.3; x <= cx + cr * 1.3; x++) {
        const dx = (x - cx) / cr, dy = (y - cy2) / ch2;
        const d = hypot(dx, dy);
        const n = fbm(seed + 51, x / 8, y / 5, 3, 8);
        const band = pow(max(0, 1 - abs(d - 0.88) / 0.52), 1.7);
        const dens = band * (0.22 + n * 0.85) * amt * 0.46;
        if (dens < 0.015) continue;
        blend(f, x, y, rgba(198, 194, 196, 255), clamp(dens, 0, 0.5));
      }
    }
  }

  // ---- burning debris falling out of the stem ----
  if (t > 0.15 && t < 0.8) {
    for (let k = 0; k < 22; k++) {
      const a = rng() * TAU;
      const r = capR * (0.9 + rng() * 0.7);
      const x = cx + cos(a) * r, y = capY + sin(a) * r * 0.7 + rng() * 30;
      const c = hotGradient(0.18 + rng() * 0.4 + t * 0.4);
      blend(f, x, y, rgba(c[0], c[1], c[2], 255), (1 - t) * 0.75);
    }
  }

  // ---- the initial flash, drawn last so it blows everything out ----
  if (flash > 0.01) {
    const fy = ground - 8 - rise * 30;
    const fr = lerp(14, 78, min(1, t * 4.6));
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const d = hypot(x - cx, y - fy);
        const inten = pow(max(0, 1 - d / fr), 1.5) * flash * 1.7
          + pow(max(0, 1 - d / (fr * 2.8)), 3) * flash * 0.55;
        if (inten < 0.02) continue;
        const c = hotGradient(clamp(0.50 - inten * 0.55, 0, 1));
        const wh = clamp((inten - 0.9) * 1.2, 0, 1);
        blend(f, x, y, rgba(lerp(c[0], 255, wh), lerp(c[1], 255, wh), lerp(c[2], 250, wh), 255), clamp(inten, 0, 1));
      }
    }
  }
  return f;
}

function drawSpark(size, k) {
  const f = makeFrame(size, size);
  const c = size / 2;
  const seed = 1501 + k * 37;
  const rng = makeRng(seed);
  const R = 6.4 + k * 1.2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - c + 0.5, dy = y - c + 0.5;
      const d = hypot(dx, dy);
      const a = atan2(dy, dx);
      // a 4-point flare plus a round core
      const flare = pow(max(abs(cos(a)), abs(sin(a))), 7);
      const inten = pow(max(0, 1 - d / (R * (0.62 + flare * 0.42))), 1.4) * 1.25
        + pow(max(0, 1 - d / (R * 0.46)), 1.6) * 2.1;
      if (inten < 0.02) continue;
      const col = hotGradient(clamp(0.78 - inten * 0.76, 0, 1));
      const wh = clamp((inten - 1.4) * 0.8, 0, 1);
      const al = clamp(inten, 0, 1);
      addPx(f, x, y, lerp(col[0], 255, wh) * al, lerp(col[1], 250, wh) * al, lerp(col[2], 236, wh) * al, al);
    }
  }
  const ta = rng() * TAU;
  for (let s2 = 1; s2 < 4 + k; s2++) {
    const al = (1 - s2 / (5 + k)) * 0.8;
    const col = hotGradient(0.18 + s2 * 0.09);
    addPx(f, c + cos(ta) * s2, c + sin(ta) * s2, col[0] * al, col[1] * al, col[2] * al, al);
  }
  return f;
}

function drawSmokePuff(size, k) {
  const f = makeFrame(size, size);
  const c = size / 2;
  const t = k / 5;
  const R = lerp(10, 20.5, t);
  const seed = 1601 + k * 53;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - c, dy = (y - c) + t * 3;
      const d = hypot(dx, dy * 1.06);
      if (d > R * 1.7) continue;
      const ang = atan2(dy, dx);
      const warp = fbm(seed, cos(ang) * 1.7 + 4, sin(ang) * 1.7 + 4, 2, 8);
      const puff = fbm(seed + 5, x / 6.5, y / 6.5, 4, 8);
      const puff2 = fbm(seed + 9, x / 3.0, y / 3.0, 3, 8);
      const rr = R * (0.88 + warp * 0.42);
      let dens = pow(max(0, 1 - d / rr), 0.70) * (0.78 + puff * 1.05 + puff2 * 0.30) * (1 - t * 0.30);
      dens *= smoothstep(size * 0.50, size * 0.40, hypot(dx, dy));
      if (dens < 0.02) continue;
      const lit = clamp((1 - t) * (0.62 - dy / (R * 2.2)), 0, 1);
      const g = smokeGradient(clamp(0.24 + t * 0.6 - lit * 0.3, 0, 1));
      blend(f, x, y, rgba(g[0] + lit * 56, g[1] + lit * 46, g[2] + lit * 34, 255), clamp(dens, 0, 0.92));
    }
  }
  return f;
}

function drawDebris(size, k) {
  const cv = makeCv(size, size);
  setModel();
  const seed = 1701 + k * 29;
  const rng = makeRng(seed);
  const c = size / 2;
  const kinds = [
    { col: rgba(158, 152, 142, 255), gl: 0.22 },   // concrete
    { col: rgba(140, 144, 156, 255), gl: 0.60 },   // steel
    { col: rgba(128, 84, 56, 255), gl: 0.24 },     // brick
    { col: rgba(84, 80, 84, 255), gl: 0.45 },      // burnt plate
  ][k % 4];
  const n = 5 + (k % 3);
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + rng() * 0.5;
    const r = (size * 0.30) * (0.6 + rng() * 0.7);
    pts.push([c + cos(a) * r, c + sin(a) * r]);
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let inside = false;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const [xi, yi] = pts[i], [xj, yj] = pts[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
      if (!inside) continue;
      const nx = (x - c) / (size * 0.5) * 0.55, ny = (y - c) / (size * 0.5) * 0.55 - 0.35;
      const col = grainy(kinds.col, x, y, seed, 0.22);
      put(cv, x, y, col, nx, ny, sqrt(max(0.1, 1 - nx * nx - ny * ny)), 1, kinds.gl, 0);
    }
  }
  const f = bake(cv, { fill: 0.34, rim: 0.40, env: 0.8, exposure: 1.08 });
  rimOutline(f, rgba(10, 8, 10, 255));
  return f;
}

/** Thin bright expanding blast ring with a soft glow either side of the core. */
function drawShockRing(size, k) {
  const f = makeFrame(size, size);
  const c = size / 2;
  const t = k / 3;
  const R = lerp(size * 0.12, size * 0.44, pow(t, 0.68));
  const thick = lerp(3.6, 1.8, t);
  const bright = lerp(1.1, 0.44, t);
  const seed = 1801 + k * 61;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - c, dy = y - c;
      const d = hypot(dx, dy);
      const ang = atan2(dy, dx);
      const wob = 1 + (fbm(seed, cos(ang) * 3 + 4, sin(ang) * 3 + 4, 3, 8) - 0.5) * 0.13;
      const off = abs(d - R * wob);
      const az = 0.30 + 0.80 * fbm(seed + 5, cos(ang) * 4.5 + 4, sin(ang) * 4.5 + 4, 3, 8) * 1.9;
      // wide soft halo, thin hot core, and a faint compression wash inside
      const halo = pow(max(0, 1 - off / (thick * 9)), 1.9) * 0.85;
      const core = pow(max(0, 1 - off / thick), 1.25) * 1.25;
      const wash = d < R ? pow(1 - d / R, 2.4) * 0.16 : 0;
      let inten = (halo + core) * bright * az + wash * bright;
      inten *= smoothstep(size * 0.5, size * 0.4, d);
      if (inten < 0.01) continue;
      const col = hotGradient(clamp(0.58 - inten * 0.52, 0, 1));
      const wh = clamp((inten - 0.95) * 1.1, 0, 1);
      const a = clamp(inten * 0.9, 0, 0.95);
      addPx(f, x, y, lerp(col[0], 255, wh) * a, lerp(col[1], 250, wh) * a * 0.97, lerp(col[2], 238, wh) * a * 0.92, a);
    }
  }
  return f;
}

// ---------------------------------------------------------------------------
// public entry point
// ---------------------------------------------------------------------------

export function buildViewmodels() {
  const frames = {};

  // --- weapon viewmodels (5 weapons x 6 poses, 256x192, see buildWeapon3) ---
  for (const name of ['pistol', 'splitter', 'nailer', 'halo', 'deadman']) buildWeapon3(frames, name);

  // --- muzzle flashes (128x128, additive) ---
  frames.flash_small = drawFlash(128, { R: 32, lobes: 4, seed: 2101, spikes: 2, core: 0.34, sparks: 18, rough: 0.5 });
  frames.flash_medium = drawFlash(128, { R: 44, lobes: 5, seed: 2103, spikes: 3, core: 0.26, sparks: 26, rough: 0.55 });
  frames.flash_large = drawFlash(128, { R: 55, lobes: 6, seed: 2105, spikes: 4, core: 0.22, sparks: 36, rough: 0.62 });
  frames.flash_ring = drawFlash(128, {
    R: 56, lobes: 3, seed: 2107, spikes: 0, core: 0.06, sparks: 24, rough: 0.30,
    ringMode: 1, ringR: 0.72, tint: [0.40, 1.02, 1.12], gain: 1.05,
  });
  frames.flash_plume = drawFlash(128, {
    R: 42, lobes: 3, seed: 2109, spikes: 0, core: 0.24, sparks: 34, rough: 0.60,
    plume: 1.35, oy: 22,
  });

  // --- airburst ---
  for (let i = 0; i < 8; i++) frames['boom' + i] = drawBoom(128, i / 7, 1301);

  // --- city killer ---
  for (let i = 0; i < 10; i++) frames['nuke' + i] = drawNuke(192, i / 9, 1401);

  // --- HUD warden portrait ---
  for (let n = 0; n <= 4; n++) {
    for (let m = 0; m <= 2; m++) frames[`face_h${n}_${m}`] = buildFace({ tier: n, look: m - 1 });
  }
  frames.face_hurt = buildFace({ tier: 2, look: 0, mode: 'hurt' });
  frames.face_dead = buildFace({ tier: 0, look: 0, mode: 'dead' });
  frames.face_grin = buildFace({ tier: 3, look: 0, mode: 'grin' });
  frames.face_key = buildFace({ tier: 4, look: 1, mode: 'key' });

  // --- horizon cities ---
  setModel();
  for (let i = 0; i < 6; i++) {
    frames['city' + i] = buildCity(i, 'alive');
    frames['city' + i + '_hit'] = buildCity(i, 'hit');
    frames['city' + i + '_dead'] = buildCity(i, 'dead');
  }

  // --- small FX ---
  for (let i = 0; i < 4; i++) frames['spark' + i] = drawSpark(16, i);
  for (let i = 0; i < 6; i++) frames['smoke' + i] = drawSmokePuff(48, i);
  for (let i = 0; i < 4; i++) frames['debris' + i] = drawDebris(12, i);
  for (let i = 0; i < 4; i++) frames['shockring' + i] = drawShockRing(160, i);

  // --- sky ---
  for (let i = 0; i < 4; i++) frames['cloud' + i] = drawCloud(i);
  frames.moon = drawMoon();
  frames.contrail = drawContrail();

  // --- expansion: the kick and the pipe bomb ---
  for (const name of ['boot', 'pipebomb']) buildWeapon3(frames, name);
  setModel();

  // --- expansion: radio portraits ---
  for (let i = 0; i < 4; i++) {
    frames[`portrait_brick_${i}`] = buildPortrait('brick', i);
    frames[`portrait_ilsa_${i}`] = buildPortrait('ilsa', i);
  }
  frames.portrait_frame = drawPortraitFrame();
  for (let i = 0; i < 3; i++) frames['portrait_static' + i] = drawPortraitStatic(i);

  // --- expansion FX ---
  for (let i = 0; i < 6; i++) frames['gib_burst' + i] = drawGibBurst(96, i);
  for (let i = 0; i < 4; i++) frames['acid_splash' + i] = drawAcidSplash(64, i);
  for (let i = 0; i < 3; i++) frames['kick_impact' + i] = drawKickImpact(96, i);
  frames.pipebomb_prop = drawPipebombProp(0);
  for (let i = 0; i < 3; i++) frames['pipebomb_lit' + i] = drawPipebombProp((i + 1) / 3);
  setModel();

  return { frames };
}

// ---------------------------------------------------------------------------
// HUD WARDEN PORTRAIT - 64x72
// ---------------------------------------------------------------------------
// The face is modelled as a height field (skull, brow ridge, nose, cheeks,
// helmet) and the normals are taken from its gradient, so it lights like a head
// instead of like a sticker. Expression is albedo + a handful of pose numbers.

const FW = 64, FH = 72;

const SKIN = {
  base: rgba(198, 152, 122, 255),
  lit: rgba(226, 186, 152, 255),
  shade: rgba(140, 98, 80, 255),
  deep: rgba(92, 58, 50, 255),
  stubble: rgba(96, 82, 84, 255),
  lip: rgba(158, 96, 84, 255),
  blood: rgba(148, 26, 24, 255),
  bloodD: rgba(88, 14, 16, 255),
  bruise: rgba(112, 66, 96, 255),
  sweat: rgba(206, 226, 238, 255),
  pale: rgba(176, 158, 148, 255),
};
const HELM = {
  base: rgba(96, 100, 78, 255),
  dark: rgba(58, 62, 46, 255),
  lit: rgba(140, 144, 116, 255),
  rim: rgba(74, 78, 60, 255),
  visor: rgba(38, 62, 60, 255),
  visorLit: rgba(96, 148, 140, 255),
  strap: rgba(58, 48, 38, 255),
};

function hf2() {
  return { h: new Float32Array(FW * FH), m: new Uint8Array(FW * FH) };
}

/** Add an ellipsoid cap to the height field and stamp a material id. */
function hEllipsoid(H, cx, cy, rx, ry, amp, mat, o = {}) {
  const { taper = 0, mode = 'max', bias = 0 } = o;
  for (let y = 0; y < FH; y++) {
    for (let x = 0; x < FW; x++) {
      const v = (y - cy) / ry;
      const rr = rx * (1 - taper * max(0, v) * max(0, v));
      const u = (x - cx) / rr;
      const d2 = u * u + v * v;
      if (d2 > 1) continue;
      const z = sqrt(1 - d2) * amp + bias;
      const i = y * FW + x;
      if (mode === 'max' ? z > H.h[i] : true) { H.h[i] = z; H.m[i] = mat; }
    }
  }
}

/** Soft additive bump (brow ridges, cheekbones, chin, nose bridge). */
function hBump(H, cx, cy, rx, ry, amp, o = {}) {
  const { p = 1.6, only = 0 } = o;
  for (let y = max(0, cy - ry - 1); y <= min(FH - 1, cy + ry + 1); y++) {
    for (let x = max(0, cx - rx - 1); x <= min(FW - 1, cx + rx + 1); x++) {
      const u = (x - cx) / rx, v = (y - cy) / ry;
      const d = hypot(u, v);
      if (d > 1) continue;
      const i = y * FW + x;
      if (!H.m[i]) continue;
      if (only && H.m[i] !== only) continue;
      H.h[i] += pow(1 - d, p) * amp;
    }
  }
}

/** Turn the height gradient into per-pixel normals on the canvas. */
function heightNormals(cv, H, strength = 1) {
  for (let y = 0; y < FH; y++) {
    for (let x = 0; x < FW; x++) {
      const i = y * FW + x;
      if (!H.m[i]) continue;
      const l = H.m[i - 1] ? H.h[i - 1] : H.h[i];
      const r = H.m[i + 1] ? H.h[i + 1] : H.h[i];
      const u = (y > 0 && H.m[i - FW]) ? H.h[i - FW] : H.h[i];
      const d = (y < FH - 1 && H.m[i + FW]) ? H.h[i + FW] : H.h[i];
      let nx = (l - r) * strength, ny = (u - d) * strength;
      const nl = sqrt(nx * nx + ny * ny + 1);
      cv.nx[i] = nx / nl; cv.ny[i] = ny / nl; cv.nz[i] = 1 / nl;
    }
  }
}

const FACE_MODES = {
  normal: {},
  hurt: { eyeOpen: 0.18, brow: 1.0, mouth: 'bare', shakeX: 1, shakeY: 1, flush: 0.5 },
  dead: { eyeOpen: 0.85, brow: -0.3, mouth: 'slack', dead: 1, tilt: 1, pupil: 0.35 },
  grin: { eyeOpen: 0.62, brow: -0.55, mouth: 'grin', browSplit: 1 },
  key: { eyeOpen: 0.7, brow: -0.35, mouth: 'smirk', look: 1, browSplit: 1 },
};

function drawWarden(cv, o = {}) {
  const tier = o.tier === undefined ? 4 : o.tier;      // 4 = healthy, 0 = nearly dead
  const mode = FACE_MODES[o.mode] || {};
  const look = mode.look !== undefined ? mode.look : (o.look || 0);
  const dead = mode.dead || 0;
  const wound = (4 - tier) / 4;
  const sweat = tier <= 3 ? clamp((4 - tier) / 3, 0, 1) : 0;
  const nosebleed = tier <= 2 ? 1 : 0;
  const swollen = tier <= 1 ? 1 : 0;
  const stare = tier === 0 ? 1 : 0;
  const eyeOpen = clamp((mode.eyeOpen !== undefined ? mode.eyeOpen : 1)
    * (stare ? 1.25 : 1) * (swollen ? 0.94 : 1), 0, 1.3);
  const brow = mode.brow !== undefined ? mode.brow : lerp(0.35, 0.9, wound) * (stare ? 0.05 : 1);
  const mouth = mode.mouth || (stare ? 'slack' : tier <= 2 ? 'open' : 'flat');
  const hx = (mode.shakeX || 0) * 1 + look * 2.6;      // head shifts with the glance
  const hy = (mode.shakeY || 0) * 1 + dead * 3;
  const tilt = (mode.tilt || 0) * 0.16;

  // ---------------- height field ----------------
  const H = hf2();
  const cx = 32 + hx, cy = 43 + hy;
  // collar / shoulders
  hEllipsoid(H, 32, 84, 34, 22, 8, 5);
  // neck
  hEllipsoid(H, cx - look * 1.6, 66 + hy, 10.5, 13, 9, 4);
  // skull, narrowing to the jaw
  hEllipsoid(H, cx, cy, 18.5, 21.0, 20, 1, { taper: 0.34 });
  // ears
  hEllipsoid(H, cx - 18, cy + 1, 3.4, 6.2, 8, 1);
  hEllipsoid(H, cx + 18, cy + 1, 3.4, 6.2, 8, 1);
  // brow ridge, cheekbones, chin, nose
  hBump(H, cx - 7.5, cy - 8, 8.5, 4.2, 3.6, { only: 1 });
  hBump(H, cx + 7.5, cy - 8, 8.5, 4.2, 3.6, { only: 1 });
  hBump(H, cx - 11, cy + 1, 7.5, 6, 2.2, { only: 1 });
  hBump(H, cx + 11, cy + 1, 7.5, 6, 2.2, { only: 1 });
  hBump(H, cx, cy + 16, 7.5, 6.5, 2.4, { only: 1 });
  hBump(H, cx - look * 1.5, cy - 1, 3.4, 10, 6.2, { only: 1, p: 1.2 });   // nose bridge
  hBump(H, cx - look * 1.8, cy + 6, 4.8, 3.8, 3.4, { only: 1, p: 1.4 });  // nose tip
  // eye sockets: scoop the height back out
  for (const sx of [-1, 1]) hBump(H, cx + sx * 7.3 - look * 1.2, cy - 3.4, 6.2, 4.2, -3.2, { only: 1, p: 1.3 });
  // helmet shell, sitting high so the brow and eyes stay readable
  hEllipsoid(H, cx, cy - 24 + tilt * 6, 22.0, 17.5, 24, 2, { taper: -0.12 });
  // helmet brim, a flat lip across the forehead
  hEllipsoid(H, cx, cy - 14 + tilt * 6, 23.0, 6.0, 13, 2);
  // the cracked visor, flipped up and resting on the crown
  hEllipsoid(H, cx, cy - 30 + tilt * 6, 17.0, 6.2, 31, 3);

  // ---------------- albedo ----------------
  const paleK = clamp(wound * 0.55 + dead * 0.7, 0, 1);
  const skinBase = mix(SKIN.base, SKIN.pale, paleK);
  const skinLit = mix(SKIN.lit, SKIN.pale, paleK * 0.8);
  for (let y = 0; y < FH; y++) {
    for (let x = 0; x < FW; x++) {
      const i = y * FW + x;
      const m = H.m[i];
      if (!m) continue;
      const n = fbm(2201, x / 5, y / 5, 3, 8);
      let c, gl = 0.10;
      if (m === 1) {
        c = mix(skinBase, skinLit, clamp(n * 1.2 - 0.15, 0, 1));
        // stubble over the jaw, chin and upper lip
        const jaw = smoothstep(cy + 6, cy + 15, y) * (1 - smoothstep(12, 19, abs(x - cx)));
        const tache = (abs(y - (cy + 11)) < 2.6 && abs(x - cx) < 6.5) ? 1 : 0;
        const st = clamp(jaw * 1.0 + tache * 0.8, 0, 1);
        if (st > 0.03) {
          const dot = hash2(x, y, 77) < 0.5 ? 1 : 0;
          c = mix(c, SKIN.stubble, st * (0.20 + dot * 0.34));
        }
        // warmth in the cheeks and nose
        const flush = pow(max(0, 1 - hypot((x - cx) / 12, (y - cy - 5) / 8)), 2) * (0.22 + (mode.flush || 0));
        c = mix(c, rgba(206, 106, 88, 255), flush * (1 - paleK * 0.7));
        gl = 0.16;
      } else if (m === 2) {
        c = mix(HELM.dark, HELM.base, clamp(0.25 + n * 1.3, 0, 1));
        if (fbm(2203, x / 3.2, y / 3.2, 3, 8) > 0.70) c = mix(c, RUST, 0.30);
        gl = 0.30;
      } else if (m === 3) {
        c = mix(HELM.visor, HELM.visorLit, clamp(0.12 + n * 0.8, 0, 1));
        gl = 0.72;
      } else if (m === 4) {
        c = mix(shade(skinBase, 0.72), skinBase, clamp(n * 1.1, 0, 1));
        gl = 0.08;
      } else {
        c = mix(rgba(48, 44, 40, 255), rgba(74, 68, 58, 255), clamp(n * 1.2, 0, 1));
        gl = 0.10;
      }
      put(cv, x, y, c, 0, 0, 1, 1, gl, 0);
    }
  }
  heightNormals(cv, H, 0.62);

  // ---------------- helmet detail ----------------
  // brim shadow across the forehead
  for (let x = 0; x < FW; x++) {
    for (let d = 0; d < 6; d++) {
      const yy = cy - 9 + d + tilt * 6;
      if (H.m[(yy | 0) * FW + x] === 1) occlude(cv, x, yy, 0.50 + d * 0.09);
    }
  }
  // dents and a long scrape
  for (let k = 0; k < 9; k++) {
    const a = -PI * 0.9 + (k / 8) * PI * 0.8;
    const rx2 = 20 + hash2(k, 1, 55) * 3;
    const ex = cx + cos(a) * rx2, ey = cy - 24 + tilt * 6 + sin(a) * 15;
    if (H.m[((ey | 0) * FW + (ex | 0))] !== 2) continue;
    for (let j = -1; j <= 1; j++) for (let i2 = -1; i2 <= 1; i2++) {
      tint(cv, ex + i2, ey + j, hash2(k, 2, 9) > 0.5 ? HELM.lit : HELM.dark, 0.4);
    }
  }
  for (let t = 0; t <= 1; t += 0.05) {
    tint(cv, cx - 15 + t * 22, cy - 32 + tilt * 6 + t * 3.2, HELM.lit, 0.35);
  }
  // the visor: cracked glass with a hard top highlight
  const vcy = cy - 30 + tilt * 6;
  for (const [x0, y0, x1, y1] of [[-11, -2, -4, 2], [-4, 2, 2, -3], [2, -3, 10, 1], [-2, 0, -1, 4], [4, -1, 6, 3]]) {
    line({ w: cv.w, h: cv.h, data: cv.data }, cx + x0, vcy + y0, cx + x1, vcy + y1, rgba(206, 232, 228, 255));
  }
  for (let x = cx - 16; x <= cx + 16; x++) {
    const u = (x - cx) / 16;
    tint(cv, x, vcy - 4.6 + u * u * 1.4, HELM.visorLit, 0.62 - abs(u) * 0.42);
    tint(cv, x, vcy + 4.4 - u * u * 1.2, rgba(18, 30, 30, 255), 0.55);
  }
  // chin straps, hugging the jaw line
  for (const sx of [-1, 1]) {
    const strapSh = (t, u) => shade(mix(HELM.strap, rgba(84, 70, 54, 255), clamp(0.5 - u * 0.8, 0, 1)), 0.9);
    capsule(cv, cx + sx * 20.0, cy - 11, cx + sx * 16.4, cy + 3, 1.5, 1.4,
      { shader: strapSh, gloss: 0.06, grain: 0.06, seed: 2207 });
    capsule(cv, cx + sx * 16.4, cy + 3, cx + sx * 12.6, cy + 15, 1.4, 1.3,
      { shader: strapSh, gloss: 0.06, grain: 0.06, seed: 2208 });
  }

  // ---------------- eyes ----------------
  const ey = cy - 3.4;
  const eyes = [-1, 1].map((sx) => ({ x: cx + sx * 7.3 - look * 1.4, y: ey, sx }));
  for (const e of eyes) {
    const puffy = swollen && e.sx < 0;
    const open = eyeOpen * (puffy ? 0.34 : 1) * (dead ? 1 : 1);
    // socket shadow
    ellipseFill(cv, e.x, e.y + 0.5, 6.4, 4.6, {
      bulge: 0, gloss: 0.06, grain: 0,
      shader: (u, v) => mix(mix(SKIN.shade, SKIN.deep, 0.55), mix(SKIN.shade, skinBase, 0.35),
        clamp(hypot(u, v * 0.8), 0, 1)),
    });
    occludePath(cv, Array.from({ length: 60 }, (_, i2) => {
      const a2 = (i2 / 60) * TAU;
      return [e.x + cos(a2) * 6.6, e.y + 0.5 + sin(a2) * 4.8];
    }), 0.80);
    if (puffy) {
      ellipseFill(cv, e.x, e.y + 1.2, 6.8, 4.8, {
        bulge: 0.5, gloss: 0.12, grain: 0.05,
        shader: (u, v) => mix(SKIN.bruise, mix(SKIN.shade, SKIN.bruise, 0.5), clamp(hypot(u, v), 0, 1)),
      });
    }
    // sclera
    const eh = 3.5 * open;
    if (eh > 0.6) {
      ellipseFill(cv, e.x, e.y, 4.9, eh, {
        bulge: 0.7, gloss: 0.5, grain: 0,
        shader: (u, v) => mix(rgba(224, 216, 206, 255), rgba(150, 138, 132, 255),
          clamp(abs(u) * 0.7 + (0.5 - v) * 0.9, 0, 1)),
      });
      // bloodshot
      if (wound > 0.3 || dead) {
        for (let k = 0; k < 4; k++) {
          const a = hash2(k, e.sx + 3, 91) * PI - PI / 2;
          for (let r = 1.6; r < 5; r += 0.7) tint(cv, e.x + cos(a) * r, e.y + sin(a) * r * 0.6, rgba(190, 80, 70, 255), 0.5);
        }
      }
      // iris + pupil, tracking the glance
      const ix = e.x + look * 2.3 + (dead ? -0.6 : 0);
      const iy = e.y + (dead ? -1.4 : 0.2);
      const ir = 2.3 * clamp(open * 1.4, 0, 1);
      ellipseFill(cv, ix, iy, ir, min(ir, eh * 0.94), {
        bulge: 0.8, gloss: 0.6, grain: 0,
        shader: (u, v) => mix(rgba(96, 74, 52, 255), rgba(52, 38, 26, 255), clamp(hypot(u, v) * 1.1, 0, 1)),
      });
      const pr = ir * (mode.pupil || (stare ? 0.34 : 0.52));
      fillEllipseFlat(cv, ix, iy, pr, min(pr, eh * 0.9), rgba(16, 12, 12, 255));
      tint(cv, ix - ir * 0.4, iy - ir * 0.4, rgba(240, 244, 250, 255), 0.9);
      // upper lid
      for (let x = e.x - 5.4; x <= e.x + 5.4; x++) {
        const u = (x - e.x) / 5.4;
        const ly = e.y - eh * (1 - u * u * 0.35) - 0.4 + (1 - open) * 3.0;
        for (let d = 0; d < 2.4; d++) tint(cv, x, ly - d, mix(SKIN.shade, skinBase, 0.4 + d * 0.2), 0.9);
      }
      // lower lid line
      for (let x = e.x - 4.9; x <= e.x + 4.9; x++) tint(cv, x, e.y + eh * 0.96 + 0.6, SKIN.shade, 0.6);
    } else {
      for (let x = e.x - 6; x <= e.x + 6; x++) {
        const u = (x - e.x) / 6;
        tint(cv, x, e.y + 0.6 - u * u * 1.2, SKIN.deep, 0.85);
        tint(cv, x, e.y - 0.4 - u * u * 1.2, SKIN.shade, 0.6);
      }
    }
    // eyebrow
    const bTilt = brow * 2.6 * -e.sx;
    const bSplit = (mode.browSplit || 0) * (e.sx > 0 ? -3.0 : 0.6);
    for (let x = e.x - 6.2; x <= e.x + 5.8; x++) {
      const u = (x - e.x) / 6.2;
      const by = e.y - 5.8 + u * bTilt * 0.5 + bSplit - abs(u) * 0.8;
      for (let d = 0; d < 2.6; d++) {
        tint(cv, x, by + d, mix(rgba(64, 48, 40, 255), rgba(38, 28, 24, 255), hash2(x, d, 13)), 0.92);
      }
    }
  }

  // ---------------- nose + mouth ----------------
  const nx2 = cx - look * 1.8, ny2 = cy + 6;
  // shadow side of the nose: a wedge widening toward the nostril
  for (let y = ny2 - 9; y <= ny2 + 3; y++) {
    const k = clamp((y - (ny2 - 9)) / 12, 0, 1);
    const w2 = 0.8 + k * 2.6;
    for (let i2 = 0; i2 < w2; i2 += 0.5) {
      tint(cv, nx2 + 2.6 + k * 1.6 + i2, y, SKIN.shade, 0.34 + k * 0.34);
      occlude(cv, nx2 + 2.6 + k * 1.6 + i2, y, 0.90);
    }
  }
  // lit bridge
  for (let y = ny2 - 9; y <= ny2 + 1; y++) {
    tint(cv, nx2 - 0.6, y, mix(skinBase, SKIN.lit, 0.5), 0.34);
  }
  // tip and nostrils
  ellipseFill(cv, nx2, ny2 + 1.6, 3.6, 2.4, {
    bulge: 0.9, gloss: 0.22, grain: 0,
    shader: (u, v) => mix(mix(skinBase, SKIN.lit, 0.45), SKIN.shade, clamp(hypot(u, v * 0.8) * 0.9, 0, 1)),
  });
  for (const sx of [-1, 1]) {
    ellipseFill(cv, nx2 + sx * 3.1, ny2 + 2.6, 1.5, 1.1,
      { bulge: 0, gloss: 0, grain: 0, shader: () => SKIN.deep });
  }
  for (let x = nx2 - 4.4; x <= nx2 + 4.4; x += 0.5) {
    tint(cv, x, ny2 + 4.0 + pow(abs(x - nx2) / 4.4, 2) * 1.2, SKIN.shade, 0.42);
  }

  const my = cy + 14;
  // shadow under the nose and along the jaw, plus the philtrum groove
  for (let x = nx2 - 5; x <= nx2 + 5; x += 0.5) {
    const u = (x - nx2) / 5;
    tint(cv, x, ny2 + 3.4 + u * u, SKIN.shade, 0.5 * (1 - abs(u) * 0.5));
  }
  for (let y = ny2 + 4; y < my - 2.6; y += 0.5) {
    tint(cv, nx2 - 1, y, SKIN.shade, 0.28); tint(cv, nx2 + 1, y, mix(SKIN.lit, skinBase, 0.5), 0.22);
  }
  {
    const jaw = [];
    for (let a = 0.35; a < PI - 0.35; a += 0.03) {
      for (let d = 0; d < 3; d += 0.5) jaw.push([cx + cos(a) * -17.5, cy + sin(a) * 20.5 - d]);
    }
    occludePath(cv, jaw, 0.84);
  }
  drawMouth(cv, nx2, my, mouth, skinBase, tier, dead);

  // ---------------- damage ----------------
  if (sweat > 0) {
    const drops = [[-13, -14], [11, -16], [-7, -18], [15, -9], [-16, -7]];
    for (let k = 0; k < 2 + (sweat * 3 | 0); k++) {
      const d = drops[k % drops.length];
      const x = cx + d[0], y = cy + d[1];
      if (H.m[(y | 0) * FW + (x | 0)] !== 1) continue;
      ellipseFill(cv, x, y, 1.5, 2.4, {
        bulge: 0.9, gloss: 0.85, grain: 0,
        shader: (u, v) => mix(SKIN.sweat, mix(skinBase, SKIN.sweat, 0.55), clamp(hypot(u, v), 0, 1)),
      });
      tint(cv, x - 0.5, y - 0.8, rgba(255, 255, 255, 255), 0.85);
      for (let t = 1; t < 4 + sweat * 4; t++) tint(cv, x, y + t, mix(skinBase, SKIN.sweat, 0.35), 0.5);
    }
  }
  if (nosebleed) {
    for (const sx of [-1, 1]) {
      const n2 = 11 + wound * 9;
      for (let t = 0; t < n2; t++) {
        const k = t / n2;
        const bx = nx2 + sx * (2.6 + k * k * 5.4);
        const yy = ny2 + 3 + t;
        const w2 = t < 3 ? 1.3 : 0.9;
        for (let i2 = -w2; i2 <= w2; i2 += 0.5) {
          tint(cv, bx + i2 + sin(t * 0.4) * 0.5, yy, t > 8 ? SKIN.bloodD : SKIN.blood, 0.9);
        }
      }
    }
  }
  if (swollen) {
    // split lip
    for (let t = 0; t < 5; t++) tint(cv, nx2 + 3.4, my - 2 + t, SKIN.blood, 0.9);
    tint(cv, nx2 + 3.4, my - 2, rgba(214, 82, 70, 255), 1);
    // cheek gash
    for (let t = 0; t < 7; t++) tint(cv, cx + 12 + t * 0.4, cy + 2 + t, SKIN.blood, 0.8);
  }
  if (stare || dead) {
    // blood sheeting down the whole face
    for (let k = 0; k < 15; k++) {
      const x = cx - 16 + hash2(k, 5, 31) * 32;
      const y0 = cy - 11 + hash2(k, 6, 37) * 7;
      const len = 6 + hash2(k, 7, 41) * 20;
      for (let t = 0; t < len; t++) {
        const yy = y0 + t;
        if (H.m[(yy | 0) * FW + (x | 0)] !== 1) continue;
        tint(cv, x, yy, t > len * 0.6 ? SKIN.bloodD : SKIN.blood, 0.34 + hash2(k, t, 43) * 0.28);
      }
    }
  }
  if (dead) {
    for (const e of eyes) {
      for (let t = -3; t <= 3; t++) {
        tint(cv, e.x + t, e.y + t * 0.9, rgba(70, 26, 26, 255), 0.7);
        tint(cv, e.x + t, e.y - t * 0.9, rgba(70, 26, 26, 255), 0.7);
      }
    }
  }
  scuff(cv, cx - 22, cy - 34, 44, 20, 2211, 10, 0.22);
}

/** Flat filled ellipse (no shading) - pupils, dark slots. */
function fillEllipseFlat(cv, cx, cy, rx, ry, col) {
  for (let j = -ceil(ry); j <= ceil(ry); j += 0.5) {
    for (let i = -ceil(rx); i <= ceil(rx); i += 0.5) {
      if ((i / rx) * (i / rx) + (j / ry) * (j / ry) > 1) continue;
      tint(cv, cx + i, cy + j, col, 1);
    }
  }
}

function drawMouth(cv, mx, my, kind, skinBase, tier, dead) {
  const dark = rgba(40, 17, 18, 255);
  const teeth = rgba(226, 218, 200, 255);
  const lipC = SKIN.lip;
  const put2 = (x, y, c, a = 1) => tint(cv, x, y, c, a);
  if (kind === 'flat') {
    for (let x = mx - 7.6; x <= mx + 7.6; x += 0.5) {
      const u = (x - mx) / 7.6;
      const y = my + u * u * 1.8 + (tier <= 2 ? 0.6 : 0);
      const end = pow(abs(u), 2.4);
      put2(x, y, mix(dark, mix(lipC, SKIN.shade, 0.5), end), 1);
      put2(x, y + 0.9, mix(mix(dark, lipC, 0.45), skinBase, end), 0.9);
      // lit lower lip and a shadow under it
      put2(x, y + 2.0, mix(lipC, SKIN.lit, 0.40 - abs(u) * 0.3), 0.85 * (1 - end * 0.6));
      put2(x, y + 3.2, SKIN.shade, 0.45 * (1 - end));
      // upper lip in shadow
      put2(x, y - 1.4, mix(lipC, SKIN.shade, 0.6), 0.6 * (1 - end * 0.5));
    }
  } else if (kind === 'open') {
    for (let j = -2.4; j <= 2.6; j += 0.5) {
      for (let i = -7.5; i <= 7.5; i += 0.5) {
        const u = i / 7.5, v = j / 2.6;
        if (u * u + v * v > 1) continue;
        put2(mx + i, my + j, j < -1.2 ? mix(dark, teeth, 0.55) : dark, 1);
      }
    }
    for (let x = mx - 9; x <= mx + 9; x += 0.5) {
      const u = (x - mx) / 9;
      put2(x, my - 3.2 + u * u * 1.2, mix(lipC, SKIN.shade, 0.4), 0.9);
      put2(x, my + 3.4 - u * u * 1.0, mix(lipC, SKIN.lit, 0.25), 0.9);
      put2(x, my + 4.6 - u * u * 1.0, SKIN.shade, 0.5);
    }
  } else if (kind === 'bare' || kind === 'grin') {
    const w = kind === 'grin' ? 11 : 9.5, h = kind === 'grin' ? 3.6 : 4.2;
    const skew = kind === 'grin' ? -1.6 : 0;
    for (let j = -h; j <= h; j += 0.5) {
      for (let i = -w; i <= w; i += 0.5) {
        const u = i / w, v = (j + u * skew) / h;
        if (u * u + v * v > 1) continue;
        put2(mx + i, my + j, dark, 1);
      }
    }
    // teeth: a top row and a bottom row with visible gaps
    for (let i = -w + 1; i <= w - 1; i += 0.5) {
      const u = i / w;
      const top = my - h * sqrt(max(0, 1 - u * u)) + 0.6 - u * skew;
      for (let d = 0; d < 2.6; d++) put2(mx + i, top + d, ((i + 20) % 3 < 0.6) ? mix(teeth, dark, 0.6) : teeth, 1);
      const bot = my + h * sqrt(max(0, 1 - u * u)) - 0.6 - u * skew;
      for (let d = 0; d < 1.8; d++) put2(mx + i, bot - d, ((i + 21) % 3 < 0.6) ? mix(teeth, dark, 0.5) : mix(teeth, dark, 0.18), 1);
    }
    for (let i = -w; i <= w; i += 0.5) {
      const u = i / w;
      put2(mx + i, my - h * sqrt(max(0, 1 - u * u)) - 0.8 - u * skew, mix(lipC, dark, 0.4), 0.85);
      put2(mx + i, my + h * sqrt(max(0, 1 - u * u)) + 0.8 - u * skew, mix(lipC, dark, 0.5), 0.85);
    }
  } else if (kind === 'smirk') {
    for (let x = mx - 8; x <= mx + 9; x++) {
      const u = (x - mx) / 8.5;
      const y = my + u * u * 0.8 - (u + 1) * 1.5;
      put2(x, y, dark, 0.92); put2(x, y + 1, mix(lipC, dark, 0.4), 0.8);
    }
    // dimple
    put2(mx + 9.5, my - 3.4, SKIN.shade, 0.7); put2(mx + 9.5, my - 2.4, SKIN.shade, 0.5);
  } else { // slack
    for (let j = -1.6; j <= 4.6; j += 0.5) {
      for (let i = -5.5; i <= 5.5; i += 0.5) {
        const u = i / 5.5, v = (j - 1.5) / 3.1;
        if (u * u + v * v > 1) continue;
        put2(mx + i, my + j, dark, 1);
      }
    }
    for (let i = -6; i <= 6; i += 0.5) put2(mx + i, my - 1.8 + (i / 6) ** 2 * 0.8, mix(lipC, SKIN.pale, 0.4), 0.8);
  }
}

function buildFace(opts) {
  const cv = makeCv(FW, FH);
  setModel();
  drawWarden(cv, opts);
  const f = bake(cv, {
    key: norm3(-0.40, -0.72, 0.60),
    keyCol: [1.0, 0.94, 0.86],
    fill: 0.44, fillCol: [0.58, 0.60, 0.72],
    rim: 0.24, env: 0.30, exposure: 1.02,
    bounce: 0.34, bounceCol: [1.0, 0.70, 0.50],
  });
  rimOutline(f, rgba(12, 9, 12, 255));
  return f;
}

// ---------------------------------------------------------------------------
// HORIZON CITIES - 240x96, six skylines seen from kilometres away at dusk
// ---------------------------------------------------------------------------
// Every city is described as a list of massings and landmarks, then rendered
// three ways from one painter: alive, hit and dead. The landmark silhouettes do
// the identification work - a spire, cooling towers, a bridge, a mast, cranes,
// a dome - so the player knows at a glance which city a warhead is diving at.

const CW = 240, CH = 96, GROUND = 90;

const CITY_TONE = {
  alive: {
    near: rgba(38, 34, 54, 255), far: rgba(66, 58, 80, 255),
    lit: 1, glow: 0.34, fire: 0, hazeC: rgba(118, 82, 104, 255), hazeA: 0.26, damage: 0,
  },
  hit: {
    near: rgba(46, 32, 34, 255), far: rgba(84, 56, 52, 255),
    lit: 0.22, glow: 1.0, fire: 1, hazeC: rgba(176, 90, 50, 255), hazeA: 0.44, damage: 0.55,
  },
  dead: {
    near: rgba(44, 44, 50, 255), far: rgba(74, 74, 82, 255),
    lit: 0, glow: 0.05, fire: 0, hazeC: rgba(96, 98, 106, 255), hazeA: 0.30, damage: 1.0,
  },
};

/** Body colour of a mass at height y: aerial perspective washes out the base. */
function cityBody(T, y, x, seed) {
  const k = clamp((y - 18) / (GROUND - 18), 0, 1);
  let c = mix(T.near, T.far, pow(k, 2.0));
  const n = fbm(seed, x / 7, y / 7, 3, 8);
  return shade(c, 0.9 + n * 0.22);
}

/** Lit windows. `lit` scales how many are on; damage knocks rows out. */
function windowGrid(f, T, x0, y0, x1, y1, seed, o = {}) {
  const { cw = 2, chh = 2, gx = 3, gy = 4, lit = 1, warm = 0.82 } = o;
  const L = T.lit * lit;
  if (L <= 0.001) return;
  let idx = 0;
  for (let y = y0; y < y1 - 1; y += chh + gy) {
    for (let x = x0 + 1; x < x1 - cw; x += cw + gx) {
      idx++;
      const h = hash2(x, y, seed);
      if (h > L * 0.72 + 0.06) continue;
      const warmth = hash2(x, y, seed + 7) < warm;
      const b = 0.55 + hash2(x, y, seed + 11) * 0.45;
      const c = warmth
        ? rgba(255 * b, (168 + hash2(x, y, seed + 3) * 60) * b, 92 * b, 255)
        : rgba(150 * b, 190 * b, 255 * b, 255);
      for (let j = 0; j < chh; j++) {
        for (let i = 0; i < cw; i++) blend(f, x + i, y + j, c, 0.92);
      }
      // a touch of bloom on the wall
      blend(f, x - 1, y, c, 0.14); blend(f, x + cw, y, c, 0.14);
    }
  }
}

/** Rectangular mass with an optional stepped or pitched cap. */
function cityBox(f, T, x, w, top, seed, o = {}) {
  const { cap = 'flat', win = true, winOpt = {}, base = GROUND, jag = 0 } = o;
  const chop = T.damage * jag;
  const t0 = top + chop * (10 + hash2(x, 3, seed) * 26);
  for (let y = t0; y < base; y++) {
    let ww = w;
    if (cap === 'taper') ww = w * lerp(0.62, 1, clamp((y - t0) / max(1, base - t0) * 1.6, 0, 1));
    if (cap === 'pitch' && y < t0 + w * 0.5) ww = w * ((y - t0) / (w * 0.5));
    for (let i = -ww / 2; i <= ww / 2; i++) {
      const xx = x + i;
      // ragged roofline where a mass has been sheared off
      if (chop > 0.02 && y < t0 + 3 && hash2(xx, y, seed + 5) < 0.45) continue;
      blend(f, xx, y, cityBody(T, y, xx, seed), 1);
    }
  }
  // a lit edge on the side the last of the sun is on
  for (let y = t0; y < base; y++) {
    let ww = w;
    if (cap === 'taper') ww = w * lerp(0.62, 1, clamp((y - t0) / max(1, base - t0) * 1.6, 0, 1));
    blend(f, x - ww / 2, y, shade(cityBody(T, y, x, seed), 1.35), 0.6);
    blend(f, x + ww / 2, y, shade(cityBody(T, y, x, seed), 0.72), 0.6);
  }
  if (win) windowGrid(f, T, x - w / 2 + 2, t0 + 3, x + w / 2 - 1, base - 2, seed + 17, winOpt);
  return t0;
}

/** Cathedral spire: tapering shaft, pinnacle, cross. */
function citySpire(f, T, x, top, w, seed) {
  const chop = T.damage > 0.8 ? 1 : 0;
  const t0 = top + chop * 26;
  for (let y = t0; y < GROUND; y++) {
    const k = clamp((y - t0) / (GROUND - t0), 0, 1);
    const ww = w * (0.10 + pow(k, 0.85) * 0.90);
    for (let i = -ww; i <= ww; i++) {
      if (chop && y < t0 + 4 && hash2(x + i, y, seed) < 0.5) continue;
      blend(f, x + i, y, cityBody(T, y, x + i, seed), 1);
    }
    blend(f, x - ww, y, shade(cityBody(T, y, x, seed), 1.4), 0.65);
  }
  if (!chop) {
    for (let y = t0 - 7; y < t0; y++) blend(f, x, y, cityBody(T, y, x, seed), 1);
    for (let i = -3; i <= 3; i++) blend(f, x + i, t0 - 5, cityBody(T, t0 - 5, x, seed), 1);
    if (T.lit > 0.2) { blend(f, x, t0 - 8, rgba(255, 168, 96, 255), 0.9); }
  }
  windowGrid(f, T, x - w * 0.55, t0 + 16, x + w * 0.55, GROUND - 4, seed + 3, { gy: 7, lit: 0.7 });
}

/** Hyperbolic cooling tower with a steam plume. */
function coolingTower(f, T, x, top, w, seed) {
  const H = GROUND - top;
  for (let y = top; y < GROUND; y++) {
    const k = (y - top) / H;
    const ww = w * (0.72 + 0.60 * pow(abs(k - 0.30) / 0.7, 1.7)) * (k < 0.30 ? 0.92 : 1);
    for (let i = -ww; i <= ww; i++) {
      if (T.damage > 0.5 && k < 0.16 && hash2(x + i, y, seed) < T.damage * 0.7) continue;
      let c = cityBody(T, y, x + i, seed);
      // vertical concrete ribs
      if (((x + i) | 0) % 5 === 0) c = shade(c, 1.16);
      blend(f, x + i, y, c, 1);
    }
    blend(f, x - ww, y, shade(cityBody(T, y, x, seed), 1.4), 0.7);
    blend(f, x + ww, y, shade(cityBody(T, y, x, seed), 0.7), 0.7);
  }
  // steam
  if (T.damage < 0.5) {
    for (let k = 0; k < 30; k++) {
      const t = k / 30;
      const px2 = x + (fbm(seed + 21, k / 3, 0, 3, 8) - 0.5) * 16 * t;
      const py2 = top - t * 24;
      const r = 3 + t * 8;
      for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) {
        if (hypot(i, j) > r) continue;
        const a = pow(1 - hypot(i, j) / r, 1.6) * 0.10 * (1 - t * 0.7);
        blend(f, px2 + i, py2 + j, rgba(190, 172, 178, 255), a);
      }
    }
  }
}

/** Suspension bridge: two towers, catenary main cables, hangers, deck. */
function cityBridge(f, T, x0, x1, deckY, towerTop, seed) {
  const bodyAt = (y, x) => cityBody(T, y, x, seed);
  const span = x1 - x0;
  const sag = (deckY - towerTop) * 0.80;
  const broken = T.damage > 0.45;
  // deck
  for (let x = x0 - 26; x <= x1 + 26; x++) {
    if (broken && x > x0 + span * 0.42 && x < x0 + span * 0.62) continue;
    for (let j = 0; j < 4; j++) blend(f, x, deckY + j, bodyAt(deckY + j, x), 1);
    blend(f, x, deckY - 1, shade(bodyAt(deckY, x), 1.5), 0.5);
  }
  // main cables
  for (const [a, b] of [[x0, x1]]) {
    for (let x = a; x <= b; x++) {
      const t = (x - a) / (b - a);
      const y = towerTop + sag * (1 - pow(2 * t - 1, 2));   // catenary from tower top to mid-span
      if (broken && x > x0 + span * 0.40 && x < x0 + span * 0.64) continue;
      blend(f, x, y, shade(bodyAt(y, x), 1.35), 1);
      blend(f, x, y + 1, shade(bodyAt(y, x), 1.1), 0.7);
      // hangers
      if ((x | 0) % 8 === 0) for (let yy = y; yy < deckY; yy++) blend(f, x, yy, bodyAt(yy, x), 0.85);
    }
  }
  // back stays
  for (let x = x0 - 26; x <= x0; x++) {
    const t = (x - (x0 - 26)) / 26;
    const y = deckY + 3 - t * (deckY + 3 - towerTop);
    blend(f, x, y, shade(bodyAt(y, x), 1.3), 0.9);
  }
  for (let x = x1; x <= x1 + 26; x++) {
    const t = (x - x1) / 26;
    const y = towerTop + t * (deckY + 3 - towerTop);
    blend(f, x, y, shade(bodyAt(y, x), 1.3), 0.9);
  }
  // towers
  for (const tx of [x0, x1]) {
    for (let y = towerTop; y < deckY + 8; y++) {
      for (const off of [-5, -4, -3, 3, 4, 5]) blend(f, tx + off, y, bodyAt(y, tx + off), 1);
      if ((y - towerTop) % 12 < 3) for (let i = -5; i <= 5; i++) blend(f, tx + i, y, bodyAt(y, tx + i), 1);
      blend(f, tx - 5, y, shade(bodyAt(y, tx), 1.5), 0.7);
    }
    if (T.lit > 0.2) blend(f, tx, towerTop - 1, rgba(255, 90, 70, 255), 0.95);
  }
}

/** Guyed lattice radio mast with aircraft warning lights. */
function cityMast(f, T, x, top, seed) {
  const broken = T.damage > 0.6;
  const t0 = broken ? top + 34 : top;
  for (let y = t0; y < GROUND; y++) {
    const k = (y - t0) / (GROUND - t0);
    const ww = 1.4 + k * 4.4;
    blend(f, x - ww, y, shade(cityBody(T, y, x, seed), 1.3), 0.95);
    blend(f, x + ww, y, cityBody(T, y, x, seed), 0.95);
    if ((y | 0) % 5 === 0) for (let i = -ww; i <= ww; i++) blend(f, x + i, y, cityBody(T, y, x + i, seed), 0.8);
    // cross bracing
    const zz = ((y | 0) % 10) / 10;
    blend(f, x - ww + zz * ww * 2, y, cityBody(T, y, x, seed), 0.55);
  }
  // guy wires
  for (const sx of [-1, 1]) {
    for (let t = 0; t <= 1; t += 0.012) {
      blend(f, x + sx * t * 30, t0 + 6 + t * (GROUND - t0 - 6), cityBody(T, GROUND - 10, x, seed), 0.35);
    }
  }
  if (T.lit > 0.05 || T.glow > 0.5) {
    for (const yy of [t0 + 2, t0 + 18, t0 + 34]) {
      blend(f, x, yy, rgba(255, 70, 60, 255), 0.95);
      blend(f, x - 1, yy, rgba(255, 70, 60, 255), 0.35);
      blend(f, x + 1, yy, rgba(255, 70, 60, 255), 0.35);
    }
  }
}

/** Domed civic building: drum, colonnade, ribbed dome, lantern. */
function cityDome(f, T, x, baseY, r, seed) {
  const broken = T.damage > 0.6;
  const cy = baseY - r * 0.55;
  for (let j = -r; j <= 0; j++) {
    for (let i = -r; i <= r; i++) {
      const u = i / r, v = j / (r * 1.02);
      if (u * u + v * v > 1) continue;
      if (broken && hash2(x + i, cy + j, seed) < 0.35 && j < -r * 0.3) continue;
      let c = cityBody(T, cy + j, x + i, seed);
      const rib = 0.5 + 0.5 * cos(atan2(v, u) * 9);
      c = shade(c, 0.94 + rib * 0.16 + (u < -0.2 ? 0.14 : 0));
      blend(f, x + i, cy + j, c, 1);
    }
  }
  // lantern
  if (!broken) {
    for (let y = cy - r - 7; y < cy - r + 1; y++) {
      for (let i = -3; i <= 3; i++) blend(f, x + i, y, cityBody(T, y, x + i, seed), 1);
    }
    if (T.lit > 0.2) { blend(f, x, cy - r - 8, rgba(255, 200, 130, 255), 0.95); blend(f, x, cy - r - 4, rgba(255, 190, 120, 255), 0.7); }
  }
  // drum with columns
  for (let y = cy; y < baseY; y++) {
    for (let i = -r * 1.06; i <= r * 1.06; i++) {
      let c = cityBody(T, y, x + i, seed);
      if (((x + i) | 0) % 4 === 0) c = shade(c, 1.28);
      blend(f, x + i, y, c, 1);
    }
  }
  windowGrid(f, T, x - r, cy + 4, x + r, baseY - 2, seed + 5, { gx: 2, gy: 5, lit: 0.8 });
}

/** Harbour gantry crane: legs, cross beam, jib, counterweight. */
function cityCrane(f, T, x, baseY, h, seed, flip = 1) {
  const topY = baseY - h;
  const broken = T.damage > 0.7;
  const body = (y, xx) => cityBody(T, y, xx, seed);
  for (const sx of [-1, 1]) {
    for (let y = topY + 4; y < baseY; y++) {
      const lean = sx * (7 + (y - topY) * 0.16);
      for (let d = 0; d < 2; d++) blend(f, x + lean + d, y, body(y, x + lean), 1);
      blend(f, x + lean + 2, y, shade(body(y, x), 0.8), 1);
    }
  }
  for (let i = -10; i <= 10; i++) for (let j = 0; j < 4; j++) blend(f, x + i, topY + 4 + j, body(topY, x + i), 1);
  if (!broken) {
    // jib out over the water, plus the short counter-jib
    for (let t = 0; t <= 1; t += 0.01) {
      const jx = x + flip * t * 34, jy = topY + 4 - t * 9;
      for (let j = 0; j < 4; j++) blend(f, jx, jy + j, body(jy, jx), 1);
      if ((t * 100 | 0) % 8 === 0) for (let yy = jy; yy < jy + 8; yy++) blend(f, jx, yy, body(yy, jx), 0.6);
    }
    for (let t = 0; t <= 1; t += 0.02) {
      const jx = x - flip * t * 15, jy = topY + 4 - t * 4;
      for (let j = 0; j < 3; j++) blend(f, jx, jy + j, body(jy, jx), 1);
    }
    if (T.lit > 0.1) blend(f, x + flip * 34, topY - 6, rgba(255, 96, 70, 255), 0.9);
  }
}

/** Chimney stack with warning bands, and its plume. */
function cityStack(f, T, x, top, w, seed, plume = 1) {
  const t0 = top + T.damage * 18;
  for (let y = t0; y < GROUND; y++) {
    const ww = w * (0.8 + 0.35 * (y - t0) / (GROUND - t0));
    for (let i = -ww; i <= ww; i++) {
      let c = cityBody(T, y, x + i, seed);
      if (((y - t0) | 0) % 11 < 3) c = mix(c, rgba(146, 74, 54, 255), 0.45);
      blend(f, x + i, y, c, 1);
    }
    blend(f, x - ww, y, shade(cityBody(T, y, x, seed), 1.4), 0.7);
  }
  if (T.lit > 0.1) blend(f, x, t0, rgba(255, 80, 60, 255), 0.9);
  if (plume && T.damage < 0.5) {
    for (let k = 0; k < 26; k++) {
      const t = k / 26;
      const px2 = x + t * 22 + (fbm(seed + 3, k / 4, 0, 3, 8) - 0.5) * 8;
      const py2 = t0 - 2 - t * 16;
      const r = 2 + t * 7;
      for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) {
        if (hypot(i, j) > r) continue;
        blend(f, px2 + i, py2 + j, rgba(96, 84, 92, 255), pow(1 - hypot(i, j) / r, 1.5) * 0.11 * (1 - t * 0.6));
      }
    }
  }
}

function cityLighthouse(f, T, x, top, seed) {
  for (let y = top; y < GROUND; y++) {
    const k = (y - top) / (GROUND - top);
    const ww = 2 + k * 3.4;
    for (let i = -ww; i <= ww; i++) {
      let c = cityBody(T, y, x + i, seed);
      if (((y - top) | 0) % 9 < 4) c = shade(c, 1.35);
      blend(f, x + i, y, c, 1);
    }
  }
  for (let i = -4; i <= 4; i++) for (let j = 0; j < 3; j++) blend(f, x + i, top - 4 + j, cityBody(T, top, x + i, seed), 1);
  if (T.lit > 0.05 || T.glow > 0.5) {
    for (let i = -2; i <= 2; i++) for (let j = 0; j < 4; j++) blend(f, x + i, top + j, rgba(255, 222, 150, 255), 0.9);
    for (let i = -12; i <= 12; i++) blend(f, x + i, top + 1.5, rgba(255, 210, 140, 255), 0.20 * (1 - abs(i) / 13));
  }
}

/** Sawtooth factory sheds and container stacks - low industrial filler. */
function citySheds(f, T, x0, x1, top, seed) {
  for (let x = x0; x < x1; x++) {
    const saw = ((x - x0) % 11) / 11;
    const y0 = top + saw * 7;
    for (let y = y0; y < GROUND; y++) blend(f, x, y, cityBody(T, y, x, seed), 1);
  }
  windowGrid(f, T, x0 + 2, top + 8, x1 - 2, GROUND - 3, seed + 9, { gx: 4, gy: 5, lit: 0.5, warm: 0.6 });
}

function cityContainers(f, T, x0, x1, seed) {
  const cols = [rgba(120, 62, 48, 255), rgba(58, 78, 96, 255), rgba(96, 92, 56, 255), rgba(76, 58, 78, 255)];
  for (let x = x0; x < x1; x += 7) {
    const stack = 1 + (hash2(x, 1, seed) * 3 | 0);
    for (let k = 0; k < stack; k++) {
      const y = GROUND - 4 - k * 4;
      const c = cols[(hash2(x, k, seed + 2) * 4) | 0];
      for (let j = 0; j < 3; j++) for (let i = 0; i < 6; i++) {
        const edge = (j === 0 || i === 0) ? 1.28 : (j === 2 ? 0.72 : 1);
        blend(f, x + i, y + j, shade(mix(shade(c, 0.7), c, T.lit * 0.5 + 0.55), edge), 1);
      }
    }
  }
}

/** Rippled water strip with reflected light. */
function cityWater(f, T, x0, x1, seed) {
  for (let y = GROUND - 4; y < CH; y++) {
    for (let x = x0; x < x1; x++) {
      const n = fbm(seed, x / 9, y / 2.2, 3, 8);
      const c = mix(rgba(40, 42, 64, 255), T.hazeC, 0.30 + n * 0.4);
      blend(f, x, y, c, 0.72);
      if (n > 0.70 && T.lit > 0.05) blend(f, x, y, rgba(226, 158, 92, 255), 0.30 * T.lit);
      if (n > 0.78 && T.glow > 0.6) blend(f, x, y, rgba(255, 140, 60, 255), 0.35 * T.glow);
    }
  }
}

/** The six skylines. Landmarks first in the read, filler massing around them. */
const CITY_DEFS = [
  { // 0 VERITY - cathedral city
    name: 'VERITY', seed: 3101,
    draw(f, T) {
      cityBox(f, T, 26, 26, 62, 3111, { jag: 0.8 });
      cityBox(f, T, 52, 20, 52, 3112, { jag: 0.7 });
      cityBox(f, T, 200, 30, 58, 3113, { jag: 0.8 });
      cityBox(f, T, 222, 22, 66, 3114, { jag: 0.6 });
      // the cathedral: nave, twin west towers, and the great spire
      cityBox(f, T, 120, 54, 66, 3115, { win: false, jag: 0.2 });
      for (let x = 94; x <= 146; x++) {                    // pitched nave roof
        const k = abs(x - 120) / 27;
        for (let y = 66 - (1 - k) * 9; y < 68; y++) blend(f, x, y, cityBody(T, y, x, 3115), 1);
      }
      cityBox(f, T, 98, 13, 44, 3116, { cap: 'pitch', winOpt: { gy: 6, lit: 0.7 }, jag: 0.5 });
      cityBox(f, T, 142, 13, 44, 3117, { cap: 'pitch', winOpt: { gy: 6, lit: 0.7 }, jag: 0.5 });
      citySpire(f, T, 120, 6, 11, 3118);
      // rose window
      if (T.lit > 0.15) {
        for (let j = -4; j <= 4; j++) for (let i = -4; i <= 4; i++) {
          if (hypot(i, j) > 4) continue;
          blend(f, 120 + i, 74 + j, rgba(255, 176, 96, 255), 0.85 * T.lit);
        }
      }
      cityBox(f, T, 74, 16, 72, 3119, { jag: 0.9 });
      cityBox(f, T, 168, 18, 70, 3120, { jag: 0.9 });
      citySheds(f, T, 0, 22, 78, 3121);
    },
  },
  { // 1 ASHGROVE - power station and works
    name: 'ASHGROVE', seed: 3201,
    draw(f, T) {
      citySheds(f, T, 0, 46, 70, 3211);
      cityBox(f, T, 62, 24, 64, 3212, { jag: 0.7 });
      coolingTower(f, T, 96, 22, 20, 3213);
      coolingTower(f, T, 144, 26, 19, 3214);
      cityStack(f, T, 178, 10, 4.5, 3215);
      cityStack(f, T, 190, 20, 3.6, 3216, 0);
      // gas holders
      for (const [gx, gr] of [[34, 12], [56, 9]]) {
        for (let y = GROUND - gr * 1.5; y < GROUND; y++) {
          for (let i = -gr; i <= gr; i++) {
            let c = cityBody(T, y, gx + i, 3217);
            if (((y | 0) % 4) === 0) c = shade(c, 1.15);
            blend(f, gx + i, y, c, 1);
          }
        }
        for (let i = -gr; i <= gr; i++) {
          const k = 1 - abs(i) / gr;
          blend(f, gx + i, GROUND - gr * 1.5 - k * 3, cityBody(T, 60, gx, 3217), 1);
        }
      }
      citySheds(f, T, 200, 240, 74, 3218);
      cityBox(f, T, 122, 14, 76, 3219, { jag: 0.8 });
      cityBox(f, T, 214, 18, 68, 3220, { jag: 0.8 });
    },
  },
  { // 2 LOW SABBATH - the river and the great bridge
    name: 'LOW SABBATH', seed: 3301,
    draw(f, T) {
      citySheds(f, T, 0, 34, 74, 3311);
      cityBox(f, T, 44, 20, 60, 3312, { jag: 0.8 });
      cityBox(f, T, 66, 15, 68, 3313, { jag: 0.8 });
      cityBridge(f, T, 92, 176, 62, 22, 3314);
      cityBox(f, T, 200, 24, 56, 3315, { jag: 0.8 });
      cityBox(f, T, 224, 18, 64, 3316, { jag: 0.7 });
      cityWater(f, T, 66, 200, 3317);
    },
  },
  { // 3 CANDLEMARK - tall thin slabs and the transmitter
    name: 'CANDLEMARK', seed: 3401,
    draw(f, T) {
      citySheds(f, T, 0, 30, 78, 3411);
      const slabs = [[46, 12, 28], [62, 10, 18], [78, 13, 34], [150, 11, 24], [166, 14, 14], [184, 10, 30]];
      for (let i = 0; i < slabs.length; i++) {
        const [x, w, top] = slabs[i];
        const t0 = cityBox(f, T, x, w, top, 3420 + i, { jag: 0.55, winOpt: { gy: 3, cw: 2, chh: 1, lit: 0.9 } });
        // the lit crown that gives the city its name
        if (T.lit > 0.1) {
          for (let k = 0; k < 3; k++) {
            for (let ix = -w / 2 + 1; ix <= w / 2 - 1; ix++) {
              blend(f, x + ix, t0 + k, rgba(255, 196, 120, 255), (0.85 - k * 0.25) * T.lit);
            }
          }
          blend(f, x, t0 - 2, rgba(255, 92, 70, 255), 0.9 * clamp(T.lit * 2, 0, 1));
        }
      }
      cityMast(f, T, 116, 4, 3412);
      cityBox(f, T, 104, 14, 70, 3413, { jag: 0.8 });
      cityBox(f, T, 130, 16, 68, 3414, { jag: 0.8 });
      cityBox(f, T, 210, 22, 62, 3415, { jag: 0.8 });
      citySheds(f, T, 224, 240, 76, 3416);
    },
  },
  { // 4 HOLLOW BAY - the container port
    name: 'HOLLOW BAY', seed: 3501,
    draw(f, T) {
      cityBox(f, T, 20, 26, 62, 3511, { jag: 0.8 });
      cityBox(f, T, 44, 18, 70, 3512, { jag: 0.8 });
      cityCrane(f, T, 86, GROUND - 2, 40, 3513, 1);
      cityCrane(f, T, 132, GROUND - 2, 46, 3514, 1);
      cityCrane(f, T, 178, GROUND - 2, 38, 3515, -1);
      cityContainers(f, T, 60, 200, 3516);
      cityLighthouse(f, T, 222, 46, 3517);
      citySheds(f, T, 0, 16, 80, 3518);
      cityWater(f, T, 0, 240, 3519);
    },
  },
  { // 5 SAINT ERROL - domes and terraces
    name: 'SAINT ERROL', seed: 3601,
    draw(f, T) {
      citySheds(f, T, 0, 26, 78, 3611);
      cityBox(f, T, 40, 24, 64, 3612, { jag: 0.8 });
      // stepped ziggurat
      for (let k = 0; k < 5; k++) {
        const w = 46 - k * 8, top = 74 - k * 8;
        cityBox(f, T, 76, w, top, 3613 + k, { base: top + 9, win: k < 3, winOpt: { gy: 4, lit: 0.8 }, jag: 0.3 });
      }
      cityDome(f, T, 152, 74, 22, 3620);
      cityDome(f, T, 196, 82, 11, 3621);
      cityBox(f, T, 120, 14, 72, 3622, { jag: 0.8 });
      cityBox(f, T, 176, 12, 76, 3623, { jag: 0.8 });
      cityBox(f, T, 222, 22, 66, 3624, { jag: 0.8 });
    },
  },
];

function buildCity(idx, mood) {
  const T = CITY_TONE[mood];
  const def = CITY_DEFS[idx];
  const f = makeFrame(CW, CH);
  const seed = def.seed;

  // --- glow dome behind the skyline: city light, or the fire that replaced it ---
  if (T.glow > 0.02) {
    const gc = mood === 'hit' ? rgba(232, 108, 40, 255) : rgba(190, 122, 96, 255);
    for (let y = 20; y < CH; y++) {
      for (let x = 0; x < CW; x++) {
        const d = hypot((x - CW / 2) / (CW * 0.46), (y - GROUND) / 58);
        const a = pow(max(0, 1 - d), 2.4) * T.glow * 0.36;
        if (a > 0.004) blend(f, x, y, gc, a);
      }
    }
  }

  def.draw(f, T);

  // --- fires and the smoke column ---
  if (T.fire > 0) {
    const rng = makeRng(seed + 77);
    for (let k = 0; k < 18; k++) {
      const x = 14 + rng() * (CW - 28);
      const y = GROUND - 3 - pow(rng(), 2.2) * 30;
      const r = 3 + rng() * 7;
      for (let j = -r * 2; j <= r; j++) {
        for (let i = -r; i <= r; i++) {
          const u = i / r, v = j / r;
          const flame = pow(max(0, 1 - hypot(u, v * (v < 0 ? 0.55 : 1.3))), 1.7)
            * (0.55 + fbm(seed + k, (x + i) / 3, (y + j) / 3, 3, 8) * 0.9);
          if (flame < 0.06) continue;
          const c = hotGradient(clamp(0.86 - flame * 0.8, 0, 1));
          blend(f, x + i, y + j, rgba(c[0], c[1], c[2], 255), clamp(flame * 0.95, 0, 0.95));
        }
      }
    }
    // three smoke columns leaning off the top of the frame
    for (let c2 = 0; c2 < 3; c2++) {
      const bx = 50 + c2 * 66 + (hash2(c2, 1, seed) - 0.5) * 20;
      for (let k = 0; k < 70; k++) {
        const t = k / 70;
        const px2 = bx + t * t * 34 + (fbm(seed + 91 + c2, k / 5, 0, 3, 8) - 0.5) * 22 * t;
        const py2 = GROUND - 6 - t * 86;
        const r = 3 + t * 15;
        for (let j = -r; j <= r; j += 1) {
          for (let i = -r; i <= r; i += 1) {
            const d = hypot(i, j) / r;
            if (d > 1) continue;
            const n = fbm(seed + 93 + c2, (px2 + i) / 7, (py2 + j) / 7, 2, 8);
            const a = pow(1 - d, 1.6) * (0.16 + n * 0.30) * (1 - t * 0.45);
            const lit = clamp((1 - t * 2.4), 0, 1);
            const g = smokeGradient(clamp(0.25 + t * 0.55, 0, 1));
            blend(f, px2 + i, py2 + j, rgba(g[0] + lit * 96, g[1] + lit * 40, g[2], 255), a);
          }
        }
      }
    }
  } else if (mood === 'dead') {
    // cold smoke still leaking out of the ruin
    for (let c2 = 0; c2 < 4; c2++) {
      const bx = 34 + c2 * 56 + (hash2(c2, 5, seed) - 0.5) * 18;
      for (let k = 0; k < 40; k++) {
        const t = k / 40;
        const px2 = bx + t * t * 26 + (fbm(seed + 41 + c2, k / 5, 0, 3, 8) - 0.5) * 16 * t;
        const py2 = GROUND - 8 - t * 66;
        const r = 2 + t * 9;
        for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) {
          const d = hypot(i, j) / r;
          if (d > 1) continue;
          const n = fbm(seed + 43 + c2, (px2 + i) / 6, (py2 + j) / 6, 2, 8);
          blend(f, px2 + i, py2 + j, rgba(92, 92, 98, 255), pow(1 - d, 1.7) * (0.08 + n * 0.16) * (1 - t * 0.5));
        }
      }
    }
  }

  // --- haze pooled at the base: the thing that makes it read as distance ---
  for (let y = GROUND - 17; y < CH; y++) {
    const k = smoothstep(GROUND - 17, GROUND + 5, y);
    for (let x = 0; x < CW; x++) {
      const n = fbm(seed + 5, x / 22, y / 8, 2, 8);
      const a = k * T.hazeA * (0.55 + n * 0.75);
      if (a > 0.01) blend(f, x, y, T.hazeC, min(a, 0.86));
    }
  }
  // a thin bright line right on the horizon
  for (let x = 0; x < CW; x++) {
    blend(f, x, CH - 1, mix(T.hazeC, rgba(255, 210, 170, 255), 0.35), 0.55);
  }
  return f;
}

// ---------------------------------------------------------------------------
// SKY ELEMENTS
// ---------------------------------------------------------------------------

/** Wispy dusk cloud bank, 256x64, partial alpha, lit warm from below-left. */
function drawCloud(k) {
  const W = 256, H = 64;
  const f = makeFrame(W, H);
  const seed = 3701 + k * 131;
  const cy = [34, 28, 38, 30][k];
  const thick = [0.86, 0.62, 1.0, 0.74][k];
  const stretch = [1.0, 1.35, 0.8, 1.15][k];
  const warm = [0.85, 0.55, 0.35, 0.7][k];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // a long fbm ridge, squashed vertically and feathered at both ends
      const n = fbm(seed, x / (36 * stretch), y / 13, 5, 8);
      const n2 = fbm(seed + 17, x / 11, y / 6, 4, 8);
      const band = pow(max(0, 1 - abs(y - cy - (n - 0.5) * 16) / 20), 1.7);
      const ends = smoothstep(0, 34, x) * smoothstep(0, 34, W - x);
      let d = band * ends * (n * 0.75 + n2 * 0.55) * 1.7 * thick;
      d = max(0, d - 0.18);
      if (d < 0.01) continue;
      // underside catches the last of the sun; tops go cool violet
      const up = clamp((cy + 6 - y) / 20, 0, 1);
      const cA = mix(rgba(74, 62, 96, 255), rgba(226, 142, 104, 255), warm * (1 - up) * 0.95);
      const cB = mix(cA, rgba(255, 206, 168, 255), pow(1 - up, 3) * warm * 0.7);
      blend(f, x, y, cB, min(d * 0.72, 0.80));
    }
  }
  return f;
}

/** The moon: 48x48, cratered, with a faint halo. */
function drawMoon() {
  const S = 48;
  const cv = makeCv(S, S);
  setModel();
  const c = S / 2, r = 16;
  blob(cv, c, c, r, {
    gloss: 0.02, grain: 0, seed: 3801,
    shader: (u, v, x, y) => {
      const n = fbm(3801, x / 6, y / 6, 4, 8);
      const n2 = fbm(3803, x / 2.4, y / 2.4, 3, 8);
      let col = mix(rgba(186, 184, 176, 255), rgba(238, 236, 226, 255), clamp(n * 1.3, 0, 1));
      // maria
      if (n < 0.42) col = mix(col, rgba(148, 146, 144, 255), smoothstep(0.42, 0.24, n));
      if (n2 > 0.80) col = shade(col, 0.90);
      return col;
    },
  });
  // craters, as little height dimples
  const rng = makeRng(3805);
  for (let k = 0; k < 14; k++) {
    const a = rng() * TAU, rr = sqrt(rng()) * r * 0.86;
    const cx2 = c + cos(a) * rr, cy2 = c + sin(a) * rr;
    const cr = 1 + rng() * 2.6;
    for (let j = -cr; j <= cr; j += 0.5) for (let i = -cr; i <= cr; i += 0.5) {
      const d = hypot(i, j) / cr;
      if (d > 1) continue;
      tint(cv, cx2 + i, cy2 + j, j < 0 ? rgba(150, 148, 146, 255) : rgba(226, 224, 216, 255), (1 - d) * 0.45);
    }
  }
  const f = bake(cv, {
    key: norm3(-0.55, -0.42, 0.72), keyCol: [1.0, 0.98, 0.94],
    fill: 0.30, fillCol: [0.42, 0.44, 0.60], rim: 0.12, env: 0.1, exposure: 1.06,
  });
  // soft halo in the dusk haze
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const d = hypot(x - c, y - c);
      if (d <= r || d > 23) continue;
      blend(f, x, y, rgba(224, 220, 232, 255), pow(1 - (d - r) / (23 - r), 2.6) * 0.26);
    }
  }
  return f;
}

/** Vapour trail, 64x8, partial alpha, fading to nothing at the tail. */
function drawContrail() {
  const W = 64, H = 8;
  const f = makeFrame(W, H);
  for (let x = 0; x < W; x++) {
    const t = x / (W - 1);
    const puff = fbm(3901, x / 5, 0, 4, 8);
    const core = lerp(0.55, 1.9, t) * (0.7 + puff * 0.7);
    for (let y = 0; y < H; y++) {
      const d = abs(y - (H - 1) / 2 - (puff - 0.5) * 1.4) / core;
      if (d > 1) continue;
      const a = pow(1 - d, 1.2) * (0.94 - t * 0.72) * (0.62 + puff * 0.7);
      if (a < 0.01) continue;
      blend(f, x, y, mix(rgba(255, 232, 208, 255), rgba(200, 192, 212, 255), t), min(a, 0.92));
    }
  }
  return f;
}

// ===========================================================================
// EXPANSION: the kick, the pipe bomb, the radio portraits, and their FX.
// Everything below is additive - it introduces no change to any painter,
// constant or light rig the original 114 frames depend on.
// ===========================================================================

// ---------------------------------------------------------------------------
// WEAPON 6 - THE BOOT: a kick, so a leg rather than a gun
// ---------------------------------------------------------------------------

const BOOT_SOLE = rgba(116, 109, 103, 255);   // worn rubber
const BOOT_SOLE_HI = rgba(182, 173, 162, 255);
const BOOT_LEATHER = rgba(134, 100, 70, 255);
const BOOT_TOECAP = rgba(178, 180, 188, 255); // bare steel through the toe
const TROUSER = rgba(142, 144, 112, 255);
const MUD = rgba(84, 66, 44, 255);

/** Rubber shader: matte, blotchy, with worn-pale high points. */
function rubberShader(seed, wear = 0.5) {
  return (t, u, x, y) => {
    const n = fbm(seed, x / 5.5, y / 5.5, 2, 8);
    let c = mix(shade(BOOT_SOLE, 0.72), BOOT_SOLE, clamp(0.25 + n * 1.2, 0, 1));
    const crest = pow(max(0, 1 - abs(u + 0.25) * 1.6), 2.0);
    c = mix(c, BOOT_SOLE_HI, crest * wear * 0.45);
    if (hash2(x, y, seed) > 0.965) c = shade(c, 0.8);
    return c;
  };
}

/**
 * The boot at full extension: sole toward the viewer, foreshortened, with the
 * upper, ankle, shin guard and trouser stacked behind it. `k` scales the whole
 * leg about the bottom of the frame so retraction is one number.
 */
function bootKick(cv, P) {
  const k = clamp(P.ext === undefined ? 1 : P.ext, 0.2, 1.2);
  const px_ = 100, py_ = 156;                       // the pivot everything shrinks toward
  const X = (x) => px_ + (x - px_) * k;
  const Y = (y) => py_ + (y - py_) * k;
  const R = (r) => r * k;
  const seed = P.seed || 8101;
  const mud = P.mud === undefined ? 0.55 : P.mud;

  // ---- trouser leg running off the bottom of the frame ----
  capsule(cv, X(140), Y(190), X(116), Y(128), R(32), R(27), {
    gloss: 0.12, grain: 0, seed: seed + 1, aoEdge: 0.60,
    shader: (t, u, x, y) => {
      const n = fbm(seed + 3, x / 6, y / 9, 3, 8);
      let c = mix(shade(TROUSER, 0.74), TROUSER, clamp(0.28 + n * 1.15, 0, 1));
      // canvas weave plus a couple of soft creases
      if (((x + y) | 0) % 3 === 0) c = shade(c, 1.06);
      const crease = pow(max(0, 1 - abs(sin(t * 9.5 + u * 1.4)) * 2.4), 3);
      c = shade(c, 1 - crease * 0.22);
      return c;
    },
  });
  // trouser hem, bloused over the boot
  capsule(cv, X(96), Y(132), X(136), Y(126), R(11), R(11), {
    gloss: 0.12, grain: 0.05, seed: seed + 5,
    shader: (t, u) => shade(mix(shade(TROUSER, 0.55), TROUSER, clamp(0.5 - u * 0.8, 0, 1)), 0.94),
  });

  // ---- shin guard: a scuffed plate on two straps ----
  metalPanelRot(cv, X(126), Y(140), R(46), R(34), 0.20, { col: rgba(134, 136, 142, 255), gloss: 0.46, seed: seed + 7 });
  for (const sy of [-12, 12]) {
    capsule(cv, X(100), Y(140 + sy), X(152), Y(140 + sy + 9), R(3.8), R(3.8), {
      col: rgba(64, 56, 48, 255), gloss: 0.18, grain: 0.08, seed: seed + 9,
    });
  }
  metalPanelRot(cv, X(148), Y(155), R(11), R(9), 0.20, { col: rgba(178, 172, 158, 255), gloss: 0.62, seed: seed + 11 });
  scuff(cv, X(104), Y(124), R(48), R(34), seed + 13, 20, 0.42);

  // ---- ankle / boot shaft behind the sole ----
  const lth = leatherShader(seed + 21, { wear: 0.75, dark: 0.10 });
  capsule(cv, X(104), Y(116), X(96), Y(92), R(23), R(26), { shader: lth, gloss: 0.24, grain: 0, seed: seed + 23 });
  // collar padding roll
  capsule(cv, X(80), Y(110), X(122), Y(114), R(8), R(8), {
    shader: leatherShader(seed + 25, { wear: 0.5, dark: 0.18 }), gloss: 0.2, grain: 0, seed: seed + 27,
  });

  // ---- the upper: leather welt showing all round the sole, widest at the toe
  const soleShapes = [
    ['blob', 94, 98, 21.0, 0.96],           // heel
    ['cap', 94, 94, 94, 56, 16.5, 21.5],    // waist -> ball
    ['blob', 94, 46, 23.5, 0.96],           // ball
    ['blob', 94, 28, 19.0, 0.94],           // toe
  ];
  const drawSoleMass = (grow, yOff, shader, gloss) => {
    for (const sh of soleShapes) {
      if (sh[0] === 'blob') {
        blob(cv, X(sh[1]), Y(sh[2] + yOff), R(sh[3] + grow),
          { shader, gloss, grain: 0, seed: seed + 31, squashY: sh[4] });
      } else {
        capsule(cv, X(sh[1]), Y(sh[2] + yOff), X(sh[3]), Y(sh[4] + yOff),
          R(sh[5] + grow), R(sh[6] + grow), { shader, gloss, grain: 0, seed: seed + 33, aoEdge: 0.5 });
      }
    }
  };
  drawSoleMass(4.5, -7, leatherShader(seed + 35, { wear: 0.8, dark: 0.0 }), 0.26);
  // steel toe cap, worn bare where the leather has gone
  blob(cv, X(94), Y(13), R(21), {
    gloss: 0.64, grain: 0.06, seed: seed + 37, squashY: 0.62,
    shader: (u, v, x, y) => {
      const n = fbm(seed + 39, x / 4, y / 4, 2, 8);
      // leather survives at the edges; the crown is bare, bright, scratched steel
      const bare = clamp(1 - hypot(u * 1.15, (v + 0.25) * 1.5), 0, 1);
      const worn = smoothstep(0.18, 0.62, bare + (n - 0.5) * 0.5);
      const lea = mix(shade(BOOT_LEATHER, 0.6), BOOT_LEATHER, clamp(0.3 + n, 0, 1));
      return mix(lea, shade(BOOT_TOECAP, 0.78 + n * 0.5), worn);
    },
  });

  // ---- the sole itself, sitting proud of the upper ----
  drawSoleMass(0, 0, rubberShader(seed + 41, 0.55), 0.16);

  // ---- tread: heel block, arch bar, and lugs across the ball and toe ----
  const LUG = rgba(152, 144, 135, 255);
  const lug = (lx, ly, lw, lh, rot) => {
    metalPanelRot(cv, X(lx), Y(ly), R(lw), R(lh), rot, { col: LUG, gloss: 0.22, seed: seed + 43 });
  };
  // heel block, separated from the forefoot by the arch gap
  for (let r2 = 0; r2 < 4; r2++) {
    for (let c2 = 0; c2 < 2; c2++) {
      const lx = 94 + (c2 - 0.5) * 17, ly = 84 + r2 * 8.5;
      if (hypot((lx - 94) / 20, (ly - 98) / 20) > 1.04) continue;
      lug(lx, ly, 13, 6, 0);
    }
  }
  // arch: a narrow waist with a maker's bar across it
  lug(94, 70, 22, 4.5, 0.02);
  lug(94, 64, 19, 3.5, 0.02);
  // forefoot chevrons
  for (let r2 = 0; r2 < 6; r2++) {
    const ly = 55 - r2 * 7.0;
    const half = 21 * sqrt(max(0.05, 1 - pow((ly - 44) / 26, 2)));
    for (const sgn of [-1, 1]) {
      lug(94 + sgn * half * 0.50, ly, half * 0.88, 4.6, sgn * 0.34);
    }
  }
  // worn-smooth patch on the outer ball: this boot lands the same way every time
  for (let j = -12; j <= 12; j++) {
    for (let i = -11; i <= 11; i++) {
      const d = hypot(i / 11, j / 12);
      if (d > 1) continue;
      tint(cv, X(102 + i), Y(46 + j), BOOT_SOLE_HI, pow(1 - d, 1.5) * 0.40);
    }
  }
  // stitched welt line all the way round
  for (let a = 0; a < TAU; a += 0.035) {
    const rr = 20.5 + 2.5 * cos(a * 2);
    const wx = 94 + cos(a) * rr, wy = 63 + sin(a) * 38;
    tint(cv, X(wx), Y(wy), rgba(178, 156, 116, 255), 0.55);
  }

  // ---- mud, and something darker, worked into the tread ----
  soot(cv, X(70), Y(0), R(50), R(120), seed + 51, 0.26 * mud, 9);
  for (let i = 0; i < 22; i++) {
    const a = hash2(i, 1, seed + 53) * TAU, rr = sqrt(hash2(i, 2, seed + 55)) * 20;
    const mx = 94 + cos(a) * rr, my = 62 + sin(a) * 36;
    const r2 = 2 + hash2(i, 3, seed + 57) * 5;
    for (let j = -r2; j <= r2; j++) for (let ii = -r2; ii <= r2; ii++) {
      const d = hypot(ii, j) / r2;
      if (d > 1) continue;
      tint(cv, X(mx + ii), Y(my + j), MUD, pow(1 - d, 1.4) * 0.6 * mud);
    }
  }
  if (P.blood) {
    for (let i = 0; i < 10; i++) {
      const a = hash2(i, 7, seed + 61) * TAU, rr = sqrt(hash2(i, 8, seed + 63)) * 17;
      const bx = 94 + cos(a) * rr, by = 52 + sin(a) * 30;
      const r2 = 1.4 + hash2(i, 9, seed + 65) * 3;
      for (let j = -r2; j <= r2; j++) for (let ii = -r2; ii <= r2; ii++) {
        if (hypot(ii, j) > r2) continue;
        tint(cv, X(bx + ii), Y(by + j), i % 3 ? rgba(112, 22, 20, 255) : rgba(64, 16, 18, 255),
          0.75 * P.blood);
      }
    }
  }
  scuff(cv, X(72), Y(10), R(46), R(106), seed + 71, 30, 0.32);
}

/** The boot at rest: barely in frame, seen down the shin from above. */
function bootRest(cv, P) {
  const seed = 8201;
  const lift = P.lift || 0;
  const yb = 150 - lift;
  // trouser filling the bottom corner
  capsule(cv, 118, yb + 42, 100, yb - 14, 36, 31, {
    gloss: 0.10, grain: 0, seed: seed + 1, aoEdge: 0.44,
    shader: (t, u, x, y) => {
      const n = fbm(seed + 3, x / 6, y / 9, 3, 8);
      let c = mix(shade(TROUSER, 0.6), TROUSER, clamp(0.28 + n * 1.15, 0, 1));
      if (((x + y) | 0) % 3 === 0) c = shade(c, 1.06);
      return c;
    },
  });
  // boot mouth and tongue, foreshortened almost to an edge
  const lth = leatherShader(seed + 11, { wear: 0.78, dark: 0.08 });
  blob(cv, 98, yb - 18, 35, { shader: lth, gloss: 0.24, grain: 0, seed: seed + 13, squashY: 0.46 });
  blob(cv, 98, yb - 25, 25, {
    gloss: 0.2, grain: 0, seed: seed + 15, squashY: 0.40,
    shader: leatherShader(seed + 17, { wear: 0.5, dark: 0.24 }),
  });
  // laces
  for (let i = 0; i < 4; i++) {
    const ly = yb - 21 - i * 5.5;
    const hw = 20 - i * 2.6;
    capsule(cv, 98 - hw, ly, 98 + hw, ly - 2.5, 1.8, 1.8,
      { col: rgba(176, 158, 118, 255), gloss: 0.2, grain: 0.1, seed: seed + 19 + i });
    capsule(cv, 98 - hw, ly - 2.5, 98 + hw, ly, 1.8, 1.8,
      { col: rgba(142, 126, 94, 255), gloss: 0.2, grain: 0.1, seed: seed + 29 + i });
  }
  // toe cap catching the light beyond the laces
  blob(cv, 97, yb - 41, 27, {
    gloss: 0.62, grain: 0.06, seed: seed + 41, squashY: 0.38,
    shader: (u, v, x, y) => {
      const n = fbm(seed + 43, x / 4, y / 4, 2, 8);
      const bare = clamp(1 - hypot(u * 1.1, (v + 0.2) * 1.5), 0, 1);
      const lea = mix(shade(BOOT_LEATHER, 0.62), BOOT_LEATHER, clamp(0.3 + n, 0, 1));
      return mix(lea, shade(BOOT_TOECAP, 0.86 + n * 0.4), smoothstep(0.14, 0.58, bare + (n - 0.5) * 0.5));
    },
  });
  // a sliver of the sole edge under the toe, so it reads as a boot on the floor
  capsule(cv, 80, yb - 30, 116, yb - 30, 6, 6, {
    shader: rubberShader(seed + 61, 0.6), gloss: 0.16, grain: 0, seed: seed + 63,
  });
  soot(cv, 62, yb - 50, 72, 66, seed + 51, 0.28, 9);
  scuff(cv, 66, yb - 46, 64, 60, seed + 53, 22, 0.34);
}

/** Kicked-up dust, dithered so the frame stays strictly alpha 0/255. */
function bootDust(cv, cx, cy, amt, seed) {
  if (amt <= 0.01) return;
  const rng = makeRng(seed);
  for (let i = 0; i < 5 + (amt * 5 | 0); i++) {
    const a = rng() * PI;                            // thrown outward and down
    const dist = 26 + rng() * 38 * amt;
    const x = cx + (rng() < 0.5 ? -1 : 1) * (24 + rng() * 44) * amt;
    const y = cy + 8 + sin(a) * dist * 0.55;
    const r = (10 + rng() * 12) * (0.55 + amt * 0.6);
    for (let j = -r; j <= r; j++) {
      for (let ii = -r; ii <= r; ii++) {
        const d = hypot(ii, j) / r;
        if (d > 1) continue;
        const n = fbm(seed + i * 7, (x + ii) / 5, (y + j) / 5, 2, 8);
        const dens = pow(1 - d, 0.95) * (0.85 + n * 0.9) * amt;
        const ix = (x + ii) | 0, iy = (y + j) | 0;
        if (dens < hash2(ix, iy, seed) * 0.92) continue;
        const g = 118 + n * 48;
        put(cv, x + ii, y + j, rgba(g, g * 0.96, g * 0.88, 255), 0, -0.15, 1, 0.9, 0.02, 0);
      }
    }
  }
}

function drawBoot(cv, P) {
  if (P.rest) { bootRest(cv, P); return; }
  bootKick(cv, P);
  if (P.dust) bootDust(cv, 96, 100, P.dust, 8301);
}

// ---------------------------------------------------------------------------
// WEAPON 7 - THE PIPE BOMB
// ---------------------------------------------------------------------------

const PIPE = rgba(160, 164, 174, 255);        // galvanised steel
const PIPE_D = rgba(104, 108, 118, 255);
const TAPE = rgba(46, 44, 50, 255);
const DIAL_FACE = rgba(228, 220, 198, 255);
const SATCHEL = rgba(122, 112, 80, 255);

/** Galvanised pipe: cool grey with zinc spangle and lengthwise scoring. */
function pipeShader(seed) {
  return (t, u, x, y) => {
    const n = fbm(seed, x / 7, y / 7, 2, 8);
    const spangle = fbm(seed + 5, x / 2.6, y / 2.6, 2, 8);
    let c = mix(PIPE_D, PIPE, clamp(0.42 - u * 0.75, 0, 1));
    c = shade(c, 0.88 + n * 0.26 + (spangle > 0.72 ? 0.16 : 0));
    if (hash2(x, y, seed) > 0.972) c = shade(c, 1.22);
    if (fbm(seed + 11, x / 9, y / 3, 2, 8) > 0.76) c = mix(c, RUST, 0.22);
    return c;
  };
}

/** A wrap of electrical tape: near-black, slightly glossy, frayed at one edge. */
function tapeWrap(cv, x0, y0, x1, y1, r, seed) {
  capsule(cv, x0, y0, x1, y1, r, r, {
    gloss: 0.34, grain: 0.05, seed,
    shader: (t, u, x, y) => {
      let c = mix(shade(TAPE, 0.7), mix(TAPE, rgba(72, 68, 78, 255), 0.6), clamp(0.5 - u * 0.9, 0, 1));
      if (fbm(seed + 3, x / 3, y / 6, 2, 8) > 0.70) c = shade(c, 1.18);   // wrinkles in the wrap
      return c;
    },
  });
}

/**
 * The bomb itself, drawn along an arbitrary axis so the same painter serves the
 * held pose, the one leaving frame, and the spare coming out of the satchel.
 */
function pipeBody(cv, ax, ay, bx, by, r, o = {}) {
  const { seed = 8401, dial = 0.35, showDial = true, fuse = 1, tapeSeed = 8411 } = o;
  const dx = bx - ax, dy = by - ay;
  const L = hypot(dx, dy) || 1;
  const ux = dx / L, uy = dy / L;
  const at = (t, off = 0) => [ax + dx * t - uy * off, ay + dy * t + ux * off];

  // pipe barrel
  capsule(cv, ax, ay, bx, by, r, r, { shader: pipeShader(seed), gloss: 0.5, grain: 0, seed, aoEdge: 0.46 });
  // threaded end caps
  for (const [t, s2] of [[0.0, -1], [1.0, 1]]) {
    const c0 = at(t), c1 = at(t + s2 * 0.11);
    capsule(cv, c0[0], c0[1], c1[0], c1[1], r * 1.09, r * 1.05, {
      gloss: 0.56, grain: 0.06, seed: seed + 7,
      shader: (tt, u) => {
        const flat = 0.5 + 0.5 * cos(u * 7);          // hex flats on the cap
        return shade(mix(shade(PIPE_D, 0.72), STEEL_B, clamp(0.48 - u * 0.8, 0, 1)), 0.9 + flat * 0.22);
      },
    });
    const rim = at(t + s2 * 0.035);
    capsule(cv, c0[0], c0[1], rim[0], rim[1], r * 1.16, r * 1.13, {
      col: shade(PIPE_D, 0.85), gloss: 0.4, grain: 0.08, seed: seed + 9,
    });
  }
  // tape wraps
  for (const t of [0.20, 0.78]) {
    const a2 = at(t - 0.065), b2 = at(t + 0.065);
    tapeWrap(cv, a2[0], a2[1], b2[0], b2[1], r * 1.03, tapeSeed + (t * 100 | 0));
  }
  // fuse stub out of the far cap
  if (fuse) {
    const f0 = at(-0.06), f1 = at(-0.20, r * 0.5), f2 = at(-0.30, r * 1.5);
    capsule(cv, f0[0], f0[1], f1[0], f1[1], 2.6, 2.2,
      { col: rgba(148, 132, 96, 255), gloss: 0.14, grain: 0.12, seed: seed + 13 });
    capsule(cv, f1[0], f1[1], f2[0], f2[1], 2.2, 1.4,
      { col: rgba(118, 104, 74, 255), gloss: 0.14, grain: 0.14, seed: seed + 15 });
  }

  // ---- the kitchen timer, taped on ----
  if (showDial) {
    const d0 = at(0.46, -r * 1.30);
    const dcx = d0[0], dcy = d0[1], dr = r * 1.34;
    // body of the timer behind the face
    blob(cv, dcx, dcy, dr * 1.12, { col: rgba(196, 190, 176, 255), gloss: 0.3, grain: 0.08, seed: seed + 21 });
    ringTube(cv, dcx, dcy, dr * 0.98, dr * 0.22, {
      gloss: 0.55, grain: 0.07, seed: seed + 23,
      shader: (a2, u) => mix(shade(STEEL_D, 0.6), STEEL_B, clamp(0.55 - cos(a2 + 0.5) * 0.5 - u * 0.4, 0, 1)),
    });
    blob(cv, dcx, dcy, dr * 0.80, {
      gloss: 0.24, grain: 0.05, seed: seed + 25,
      shader: (u, v, x, y) => {
        const n = fbm(seed + 27, x / 4, y / 4, 2, 8);
        return shade(mix(DIAL_FACE, shade(DIAL_FACE, 0.82), clamp(hypot(u, v) * 0.7, 0, 1)), 0.94 + n * 0.16);
      },
    });
    // minute ticks, longer every quarter
    for (let i = 0; i < 24; i++) {
      const a2 = (i / 24) * TAU - PI / 2;
      const long = i % 6 === 0;
      for (let rr = dr * (long ? 0.50 : 0.62); rr <= dr * 0.74; rr += 0.5) {
        tint(cv, dcx + cos(a2) * rr, dcy + sin(a2) * rr, rgba(46, 40, 34, 255), 0.85);
      }
    }
    stencil(cv, '60', dcx - 4, dcy - dr * 0.54, rgba(40, 34, 28, 255), 0.9);
    stencil(cv, '30', dcx - 4, dcy + dr * 0.22, rgba(40, 34, 28, 255), 0.9);
    stencil(cv, '45', dcx - dr * 0.62, dcy - dr * 0.16, rgba(40, 34, 28, 255), 0.9);
    stencil(cv, '15', dcx + dr * 0.34, dcy - dr * 0.16, rgba(40, 34, 28, 255), 0.9);
    // the hand, and the winding knob
    const ha = dial * TAU - PI / 2;
    for (let rr = -dr * 0.14; rr <= dr * 0.70; rr += 0.35) {
      const px3 = dcx + cos(ha) * rr, py3 = dcy + sin(ha) * rr;
      const wide = rr < dr * 0.5 ? 1 : 0;
      tint(cv, px3, py3, rgba(206, 48, 36, 255), 1);
      if (wide) tint(cv, px3 - sin(ha), py3 + cos(ha), rgba(206, 48, 36, 255), 1);
      tint(cv, px3 + sin(ha), py3 - cos(ha), rgba(126, 26, 22, 255), 0.7);
    }
    blob(cv, dcx, dcy, dr * 0.13, { col: rgba(70, 66, 62, 255), gloss: 0.5, grain: 0.05, seed: seed + 29 });
    const ka = at(0.62, -r * 2.35);
    blob(cv, ka[0], ka[1], dr * 0.34, {
      gloss: 0.4, grain: 0.08, seed: seed + 31,
      shader: (u, v) => {
        const knurl2 = 0.5 + 0.5 * sin(atan2(v, u) * 14);
        return shade(mix(rgba(96, 92, 86, 255), rgba(158, 152, 142, 255), clamp(0.5 - v * 0.8, 0, 1)),
          0.88 + knurl2 * 0.28);
      },
    });
    // two strips of tape holding the timer to the pipe
    for (const s2 of [-1, 1]) {
      const t0 = at(0.46 + s2 * 0.15, r * 0.3), t1 = at(0.46 + s2 * 0.07, -r * 2.1);
      tapeWrap(cv, t0[0], t0[1], t1[0], t1[1], 3.6, tapeSeed + 40 + s2);
    }
  }
  scuff(cv, min(ax, bx) - r * 2, min(ay, by) - r * 2, abs(dx) + r * 4, abs(dy) + r * 4, seed + 51, 22, 0.34);
}

/** The canvas satchel the spares come out of. */
function drawSatchel(cv, x, y, seed, spare = 0) {
  const bagSh = (t, u, x2, y2) => {
    const n = fbm(seed, x2 / 6, y2 / 6, 2, 8);
    let c = mix(shade(SATCHEL, 0.58), SATCHEL, clamp(0.28 + n * 1.2, 0, 1));
    if (((x2 + y2) | 0) % 3 === 0) c = shade(c, 1.05);
    return c;
  };
  capsule(cv, x - 20, y + 40, x + 20, y + 40, 22, 22, { shader: bagSh, gloss: 0.10, grain: 0, seed: seed + 1 });
  capsule(cv, x - 20, y + 18, x + 20, y + 18, 14, 14, { shader: bagSh, gloss: 0.10, grain: 0, seed: seed + 2 });
  // spare pipes standing in the bag
  if (spare > 0) {
    for (const [ox, oy] of [[-9, -12], [7, -9]]) {
      capsule(cv, x + ox, y + oy + 20, x + ox - 2, y + oy - 6, 6.5, 6.5,
        { shader: pipeShader(seed + 5), gloss: 0.45, grain: 0, seed: seed + 7 });
      blob(cv, x + ox - 2, y + oy - 6, 7.4, { col: shade(PIPE_D, 0.9), gloss: 0.5, grain: 0.08, seed: seed + 9 });
    }
  }
  // flap and buckle
  capsule(cv, x - 21, y + 20, x + 21, y + 20, 13, 13, {
    gloss: 0.12, grain: 0, seed: seed + 11,
    shader: (t, u, x2, y2) => shade(bagSh(t, u, x2, y2), 1.14),
  });
  for (let i = -22; i <= 22; i += 3.5) tint(cv, x + i, y + 31, rgba(196, 178, 128, 255), 0.5);
  capsule(cv, x - 3, y + 8, x - 3, y + 36, 4.4, 4.4,
    { col: rgba(66, 54, 42, 255), gloss: 0.22, grain: 0.1, seed: seed + 13 });
  metalPanelRot(cv, x - 3, y + 28, 10, 8, 0, { col: rgba(176, 164, 130, 255), gloss: 0.58, seed: seed + 15 });
  soot(cv, x - 30, y + 6, 60, 56, seed + 21, 0.26, 10);
}

function drawPipebomb(cv, P) {
  const stage = P.stage || 'hold';
  const dial = P.dial === undefined ? 0.35 : P.dial;

  if (stage === 'hold' || stage === 'wind') {
    // ---- bomb held across the view, timer toward the player ----
    pipeBody(cv, 44, 96, 148, 74, 16.0, { seed: 8401, dial, tapeSeed: 8411 });
    drawGlove(cv, {
      x: 156, y: 100, ang: 0.20, flip: -1, scale: 1.04, grip: 'wrap',
      seed: 8501, wear: 0.6,
    });
    if (stage === 'wind') {
      // second hand up on the winding knob
      drawGlove(cv, {
        x: 128 + (P.windShift || 0), y: 34, ang: 0.22, flip: -1, scale: 0.94, grip: 'pinch',
        seed: 8511, wear: 0.5, sleeve: 1,
      });
    }
  } else if (stage === 'throw') {
    // ---- release: hand thrown open, bomb already tumbling out of frame ----
    // speed lines first, so the bomb sits in front of its own trail
    for (let i = 0; i < 9; i++) {
      const t = i / 9;
      const sx = 62 + t * 58 + hash2(i, 1, 8601) * 12;
      const sy = 46 + t * 46 + hash2(i, 2, 8603) * 12;
      capsule(cv, sx, sy, sx + 15, sy + 11, 1.9, 0.7,
        { col: rgba(186, 188, 196, 255), gloss: 0.3, grain: 0.1, seed: 8605 + i });
    }
    pipeBody(cv, 4, 44, 78, 20, 15.0, { seed: 8401, dial, tapeSeed: 8411, fuse: 1 });
    drawGlove(cv, {
      x: 142, y: 104, ang: 0.26, flip: -1, scale: 1.14, grip: 'open',
      seed: 8501, wear: 0.6,
    });
  } else {
    // ---- empty hand, and the next one coming out of the satchel ----
    drawSatchel(cv, 42, 96, 8701, P.spare || 0);
    if (P.spare > 0.4) {
      pipeBody(cv, 16, 96 - 40 * P.spare, 74, 78 - 34 * P.spare, 13.5,
        { seed: 8421, dial: 0.05, tapeSeed: 8431, showDial: P.spare > 0.65, fuse: 0 });
    }
    drawGlove(cv, {
      x: 74, y: 128, ang: -0.34, flip: 1, scale: 1.0, grip: P.spare > 0.4 ? 'pinch' : 'open',
      seed: 8511, wear: 0.5,
    });
    drawGlove(cv, {
      x: 152, y: 116, ang: 0.34, flip: -1, scale: 1.06, grip: 'open',
      seed: 8501, wear: 0.6, curlBias: P.close || 0,
    });
  }
}

// ---------------------------------------------------------------------------
// RADIO PORTRAITS - 128x128, chest-up, transparent surround
// ---------------------------------------------------------------------------
// Same idea as the warden face but at four times the area: the big organic
// masses (skull, jaw, neck, chest, hair) go into a height field whose gradient
// becomes the normals, then the hard-surface parts - shades, headset, dog tags,
// a cigar - are laid over the top with the analytic painters. These are
// separate helpers from the 64x72 warden's on purpose: that art has shipped and
// must not move.

const PW = 128;

function makeHF(w, h) {
  return { w, h, z: new Float32Array(w * h), m: new Uint8Array(w * h) };
}

/** Ellipsoid cap into a height field. `taper` narrows it toward the bottom. */
function hfEllipsoid(H, cx, cy, rx, ry, amp, mat, o = {}) {
  const { taper = 0, bias = 0, over = false, squareness = 0 } = o;
  for (let y = 0; y < H.h; y++) {
    for (let x = 0; x < H.w; x++) {
      const v = (y - cy) / ry;
      const rr = rx * (1 - taper * max(0, v) * max(0, v));
      const u = (x - cx) / rr;
      // squareness bends the profile toward a rounded box - a heavy jaw
      const d = squareness > 0
        ? pow(pow(abs(u), 2 + squareness * 4) + pow(abs(v), 2 + squareness * 4), 1 / (2 + squareness * 4))
        : hypot(u, v);
      if (d > 1) continue;
      const z = sqrt(max(0, 1 - d * d)) * amp + bias;
      const i = y * H.w + x;
      if (over || z > H.z[i]) { H.z[i] = z; H.m[i] = mat; }
    }
  }
}

/** Rounded box into a height field: flat-tops, visors, collars. */
function hfBox(H, x0, y0, x1, y1, amp, mat, o = {}) {
  const { round = 4, dome = 0.25, over = false } = o;
  for (let y = floor(y0); y <= ceil(y1); y++) {
    for (let x = floor(x0); x <= ceil(x1); x++) {
      if (x < 0 || y < 0 || x >= H.w || y >= H.h) continue;
      const dx = min(x - x0, x1 - x), dy = min(y - y0, y1 - y);
      if (dx < 0 || dy < 0) continue;
      if (dx < round && dy < round) {
        const ox = round - dx, oy = round - dy;
        if (ox * ox + oy * oy > round * round) continue;
      }
      const u = ((x - x0) / max(1, x1 - x0)) * 2 - 1;
      const v = ((y - y0) / max(1, y1 - y0)) * 2 - 1;
      const z = amp * (1 - dome * (u * u * 0.5 + v * v * 0.5));
      const i = y * H.w + x;
      if (over || z > H.z[i]) { H.z[i] = z; H.m[i] = mat; }
    }
  }
}

/** Soft additive bump restricted to one material (brow ridge, cheek, chin). */
function hfBump(H, cx, cy, rx, ry, amp, o = {}) {
  const { p = 1.6, only = 0 } = o;
  for (let y = max(0, floor(cy - ry - 1)); y <= min(H.h - 1, ceil(cy + ry + 1)); y++) {
    for (let x = max(0, floor(cx - rx - 1)); x <= min(H.w - 1, ceil(cx + rx + 1)); x++) {
      const u = (x - cx) / rx, v = (y - cy) / ry;
      const d = hypot(u, v);
      if (d > 1) continue;
      const i = y * H.w + x;
      if (!H.m[i]) continue;
      if (only && H.m[i] !== only) continue;
      H.z[i] += pow(1 - d, p) * amp;
    }
  }
}

function hfNormals(cv, H, strength = 1) {
  for (let y = 0; y < H.h; y++) {
    for (let x = 0; x < H.w; x++) {
      const i = y * H.w + x;
      if (!H.m[i]) continue;
      const l = (x > 0 && H.m[i - 1]) ? H.z[i - 1] : H.z[i];
      const r = (x < H.w - 1 && H.m[i + 1]) ? H.z[i + 1] : H.z[i];
      const u = (y > 0 && H.m[i - H.w]) ? H.z[i - H.w] : H.z[i];
      const d = (y < H.h - 1 && H.m[i + H.w]) ? H.z[i + H.w] : H.z[i];
      const nx = (l - r) * strength, ny = (u - d) * strength;
      const nl = sqrt(nx * nx + ny * ny + 1);
      cv.nx[i] = nx / nl; cv.ny[i] = ny / nl; cv.nz[i] = 1 / nl;
    }
  }
}

/** Occlude a run of points once each (see occludePath) but in portrait space. */
function pOcclude(cv, pts, amt) { occludePath(cv, pts, amt); }

/**
 * Portrait eye. `open` 0..1.2, `look` shifts the iris, `squint` raises the
 * lower lid, `bagged` adds the pouch that says this person has not slept.
 */
function pEye(cv, x, y, o = {}) {
  const {
    open = 1, look = 0, lookY = 0, w = 8.0, iris = rgba(84, 66, 44, 255),
    squint = 0, sclera = rgba(226, 220, 210, 255), shade: shadeC = rgba(128, 88, 70, 255),
    deep = rgba(78, 48, 40, 255), skin = rgba(198, 152, 122, 255), lash = 0, socket = 1,
  } = o;
  const h = w * 0.58 * clamp(open, 0, 1.3);
  // socket
  ellipseFill(cv, x, y + 0.6, w * (0.98 + socket * 0.32), w * (0.70 + socket * 0.22), {
    bulge: 0, gloss: 0.06, grain: 0,
    shader: (u, v) => {
      const inner = mix(mix(shadeC, deep, 0.5), mix(shadeC, skin, 0.4), clamp(hypot(u, v * 0.85), 0, 1));
      return socket >= 1 ? inner : mix(skin, inner, socket);
    },
  });
  if (h < 1.1) {
    for (let i = -w; i <= w; i += 0.5) {
      const u = i / w;
      tint(cv, x + i, y + 0.4 - u * u * 1.6, deep, 0.9);
      tint(cv, x + i, y - 0.8 - u * u * 1.6, shadeC, 0.6);
    }
    return;
  }
  ellipseFill(cv, x, y, w * 0.86, h, {
    bulge: 0.7, gloss: 0.45, grain: 0,
    shader: (u, v) => mix(sclera, shade(sclera, 0.62), clamp(abs(u) * 0.6 + (0.4 - v) * 0.85, 0, 1)),
  });
  const ir = w * 0.42 * clamp(open * 1.2, 0, 1);
  const ix = x + look * w * 0.34, iy = y + lookY * h * 0.5 + 0.3;
  ellipseFill(cv, ix, iy, ir, min(ir, h * 0.95), {
    bulge: 0.85, gloss: 0.6, grain: 0,
    shader: (u, v) => {
      const d = hypot(u, v);
      let c = mix(iris, shade(iris, 0.5), clamp(d * 1.15, 0, 1));
      if (d > 0.78) c = shade(iris, 0.34);
      if (((atan2(v, u) * 9) | 0) % 2 === 0) c = shade(c, 1.12);   // iris fibres
      return c;
    },
  });
  const pr = ir * 0.46;
  fillEllipseFlat(cv, ix, iy, pr, min(pr, h * 0.9), rgba(14, 11, 12, 255));
  tint(cv, ix - ir * 0.36, iy - ir * 0.40, rgba(246, 250, 255, 255), 0.95);
  tint(cv, ix - ir * 0.36 + 1, iy - ir * 0.40, rgba(230, 236, 244, 255), 0.6);
  // upper lid, dropped by (1-open); lower lid raised by squint
  for (let i = -w * 1.05; i <= w * 1.05; i += 0.5) {
    const u = i / (w * 1.05);
    const ly = y - h * (1 - u * u * 0.34) - 0.5 + (1 - clamp(open, 0, 1)) * h * 1.9;
    for (let d2 = 0; d2 < 2.8; d2 += 0.5) tint(cv, x + i, ly - d2, mix(shadeC, skin, 0.35 + d2 * 0.16), 0.92);
    if (lash) for (let d2 = 0; d2 < 1.8; d2 += 0.5) tint(cv, x + i, ly + d2 - 0.5, deep, 0.80 * lash * (1 - abs(u) * 0.3));
    const by = y + h * (1 - u * u * 0.30) + 0.5 - squint * h * 1.5;
    tint(cv, x + i, by, mix(shadeC, deep, 0.35), 0.75);
    tint(cv, x + i, by + 1.2, mix(skin, shadeC, 0.45), 0.5);
  }
}

/** Portrait brow. `tilt` positive = inner end down (angry), `lift` raises it. */
function pBrow(cv, x, y, o = {}) {
  const { w = 11, tilt = 0, lift = 0, side = -1, col = rgba(70, 52, 34, 255), thick = 3.4, arch = 1.2 } = o;
  for (let i = -w; i <= w; i += 0.5) {
    const u = i / w;
    const by = y - lift + u * tilt * side * 3.4 - (1 - u * u) * arch;
    for (let d = 0; d < thick; d += 0.5) {
      const k = hash2((x + i) | 0, d | 0, 991);
      tint(cv, x + i, by + d, mix(col, shade(col, 0.6), k), 0.9 - abs(u) * 0.25);
    }
  }
}

/** Portrait mouth at 128px scale. */
function pMouth(cv, x, y, kind, o = {}) {
  const {
    w = 15, skin = rgba(198, 152, 122, 255), lip = rgba(158, 96, 84, 255),
    dark = rgba(44, 20, 20, 255), teeth = rgba(230, 224, 208, 255), skew = 0, shade: shadeC = rgba(128, 88, 70, 255),
  } = o;
  const T = (xx, yy, c, a = 1) => tint(cv, xx, yy, c, a);
  if (kind === 'flat' || kind === 'smirk') {
    const sk = kind === 'smirk' ? -2.6 : 0;
    for (let i = -w; i <= w; i += 0.5) {
      const u = i / w;
      const yy = y + u * u * 2.2 + u * sk + skew * u;
      const end = pow(abs(u), 2.4);
      T(x + i, yy, mix(dark, mix(lip, shadeC, 0.5), end), 1);
      T(x + i, yy + 1, mix(mix(dark, lip, 0.5), skin, end), 0.9);
      T(x + i, yy + 2.4, mix(lip, rgba(226, 186, 152, 255), 0.35 - abs(u) * 0.3), 0.85 * (1 - end * 0.6));
      T(x + i, yy + 4.0, shadeC, 0.45 * (1 - end));
      T(x + i, yy - 1.8, mix(lip, shadeC, 0.55), 0.6 * (1 - end * 0.5));
    }
    if (kind === 'smirk') {
      T(x + w + 1.5, y - sk - 3.5, shadeC, 0.8); T(x + w + 1.5, y - sk - 2.2, shadeC, 0.6);
    }
  } else if (kind === 'open' || kind === 'shout') {
    const oh = kind === 'shout' ? 13 : 6.5;
    const ow = kind === 'shout' ? w * 0.86 : w * 0.78;
    for (let j = -oh; j <= oh; j += 0.5) {
      for (let i = -ow; i <= ow; i += 0.5) {
        const u = i / ow, v = j / oh;
        if (u * u + v * v > 1) continue;
        T(x + i, y + j, j < -oh * 0.52 ? mix(dark, teeth, 0.5) : j > oh * 0.62 ? mix(dark, rgba(120, 52, 52, 255), 0.5) : dark, 1);
      }
    }
    // upper teeth
    for (let i = -ow + 1; i <= ow - 1; i += 0.5) {
      const u = i / ow;
      const top = y - oh * sqrt(max(0, 1 - u * u)) + 0.8;
      for (let d = 0; d < 3.4; d += 0.5) T(x + i, top + d, ((i + 40) % 4 < 0.6) ? mix(teeth, dark, 0.55) : teeth, 1);
    }
    if (kind === 'shout') {
      for (let i = -ow + 2; i <= ow - 2; i += 0.5) {
        const u = i / ow;
        const bot = y + oh * sqrt(max(0, 1 - u * u)) - 1.0;
        for (let d = 0; d < 2.4; d += 0.5) T(x + i, bot - d, mix(teeth, dark, 0.25), 1);
      }
    }
    for (let i = -ow - 1; i <= ow + 1; i += 0.5) {
      const u = clamp(i / ow, -1, 1);
      T(x + i, y - oh * sqrt(max(0, 1 - u * u)) - 1.4, mix(lip, shadeC, 0.4), 0.9);
      T(x + i, y + oh * sqrt(max(0, 1 - u * u)) + 1.4, mix(lip, rgba(216, 170, 140, 255), 0.25), 0.9);
    }
  } else if (kind === 'bare') {
    for (let j = -7; j <= 7; j += 0.5) {
      for (let i = -w; i <= w; i += 0.5) {
        const u = i / w, v = (j + u * skew) / 7;
        if (u * u + v * v > 1) continue;
        T(x + i, y + j, dark, 1);
      }
    }
    for (let i = -w + 1; i <= w - 1; i += 0.5) {
      const u = i / w;
      const top = y - 7 * sqrt(max(0, 1 - u * u)) + 0.8 - u * skew;
      for (let d = 0; d < 4.0; d += 0.5) T(x + i, top + d, ((i + 40) % 4 < 0.6) ? mix(teeth, dark, 0.6) : teeth, 1);
      const bot = y + 7 * sqrt(max(0, 1 - u * u)) - 0.8 - u * skew;
      for (let d = 0; d < 3.0; d += 0.5) T(x + i, bot - d, ((i + 41) % 4 < 0.6) ? mix(teeth, dark, 0.5) : mix(teeth, dark, 0.2), 1);
    }
  } else { // smile
    for (let i = -w; i <= w; i += 0.5) {
      const u = i / w;
      const yy = y - (1 - u * u) * 3.4 + skew * u;
      T(x + i, yy, mix(dark, lip, 0.25), 1);
      T(x + i, yy + 1.1, mix(dark, teeth, 0.75), 0.95);
      T(x + i, yy + 2.3, mix(teeth, dark, 0.35), 0.9);
      T(x + i, yy + 3.6, mix(lip, rgba(226, 186, 152, 255), 0.4), 0.85);
      T(x + i, yy - 1.6, mix(lip, shadeC, 0.5), 0.6);
    }
    // the crease at each corner that makes a smile read as one
    for (const sgn of [-1, 1]) {
      for (let d = 0; d < 5; d += 0.5) {
        T(x + sgn * (w + 1.2), y - 3.0 - d * 0.7, shadeC, 0.7 - d * 0.09);
      }
    }
  }
}

const BRICK = {
  skin: rgba(198, 156, 122, 255),
  lit: rgba(228, 190, 152, 255),
  shade: rgba(140, 94, 70, 255),
  deep: rgba(88, 52, 42, 255),
  stubble: rgba(104, 88, 82, 255),
  hair: rgba(178, 150, 84, 255),
  hairD: rgba(104, 84, 40, 255),
  lens: rgba(22, 25, 34, 255),
  vest: rgba(188, 182, 164, 255),
  vestD: rgba(112, 106, 92, 255),
  cigar: rgba(96, 66, 40, 255),
};

const BRICK_MODES = [
  // 0 smug: it is going well and he knows it
  { browL: { lift: 0.4, tilt: -0.15 }, browR: { lift: 4.6, tilt: -0.5 }, open: 0.70, look: 0.16, mouth: 'smirk', cig: 0.0 },
  // 1 shouting a line nobody asked for
  { browL: { lift: -2.2, tilt: 1.0 }, browR: { lift: -2.2, tilt: 1.0 }, open: 1.16, look: 0, mouth: 'shout', cig: -0.5, vein: 1 },
  // 2 hurt and furious
  { browL: { lift: -3.0, tilt: 1.25 }, browR: { lift: -1.6, tilt: 1.1 }, open: 0.92, openL: 0.10, look: -0.1, mouth: 'bare', cig: 0.35, blood: 1, vein: 1 },
  // 3 gone somewhere else entirely
  { browL: { lift: 2.6, tilt: -0.45 }, browR: { lift: 3.0, tilt: -0.5 }, open: 0.86, look: -0.55, lookY: -0.4, mouth: 'open', cig: 0.9, soft: 1 },
];

function drawBrick(cv, idx) {
  const M = BRICK_MODES[idx] || BRICK_MODES[0];
  const H = makeHF(PW, PW);
  const seed = 9101 + idx;

  // ---- masses ----
  hfEllipsoid(H, 64, 152, 56, 42, 18, 4);                       // chest
  hfEllipsoid(H, 28, 128, 26, 20, 15, 4);                       // traps
  hfEllipsoid(H, 100, 128, 26, 20, 15, 4);
  hfEllipsoid(H, 64, 100, 22, 24, 24, 1);                       // a frankly excessive neck
  hfEllipsoid(H, 37, 56, 5, 11, 12, 1);                         // ears
  hfEllipsoid(H, 91, 56, 5, 11, 12, 1);
  hfEllipsoid(H, 64, 46, 27, 31, 28, 1, { taper: 0.06 });       // skull
  hfEllipsoid(H, 64, 68, 27, 20, 26, 1, { squareness: 0.9 });   // and a frankly excessive jaw
  hfBump(H, 64, 84, 12, 9, 3.6, { only: 1 });                   // chin
  hfBump(H, 64, 86, 3.4, 4.0, -2.2, { only: 1, p: 1.2 });       // cleft
  hfBump(H, 45, 60, 13, 10, 3.0, { only: 1 });
  hfBump(H, 83, 60, 13, 10, 3.0, { only: 1 });
  hfBump(H, 50, 45, 14, 6, 4.4, { only: 1 });                   // brow ridge
  hfBump(H, 78, 45, 14, 6, 4.4, { only: 1 });
  hfBump(H, 64, 52, 5.4, 15, 7.4, { only: 1, p: 1.15 });        // nose bridge
  hfBump(H, 64, 64, 7.5, 5.5, 4.2, { only: 1, p: 1.3 });        // nose tip
  hfBump(H, 51, 51, 9.5, 6.5, -3.8, { only: 1, p: 1.3 });
  hfBump(H, 77, 51, 9.5, 6.5, -3.8, { only: 1, p: 1.3 });
  hfEllipsoid(H, 64, 108, 8, 15, 26, 1);                        // sternocleidomastoid, showing off
  hfBox(H, 36, 26, 45, 52, 27, 2, { round: 4 });                // high and tight sides
  hfBox(H, 83, 26, 92, 52, 27, 2, { round: 4 });
  hfBox(H, 38, 11, 90, 33, 33, 2, { round: 5, dome: 0.14 });    // the flat-top: absolutely flat
  hfBox(H, 32, 25, 96, 40, 37, 3, { round: 7, dome: 0.55 });    // shades pushed up on the brow

  // ---- albedo ----
  for (let y = 0; y < PW; y++) {
    for (let x = 0; x < PW; x++) {
      const i = y * PW + x;
      const m = H.m[i];
      if (!m) continue;
      const n = fbm(seed, x / 7, y / 7, 2, 8);
      let c, gl = 0.12;
      if (m === 1) {
        c = mix(BRICK.skin, BRICK.lit, clamp(n * 1.25 - 0.15, 0, 1));
        // five o'clock shadow across the jaw, chin and upper lip
        const jaw = smoothstep(60, 76, y) * (1 - smoothstep(19, 27, abs(x - 64)));
        const tache = (abs(y - 71) < 4 && abs(x - 64) < 11) ? 1 : 0;
        const st = clamp(jaw * 1.0 + tache * 0.85, 0, 1);
        if (st > 0.03) {
          const dot = hash2(x, y, 331) < 0.52 ? 1 : 0;
          c = mix(c, BRICK.stubble, st * (0.24 + dot * 0.32));
        }
        const flush = pow(max(0, 1 - hypot((x - 64) / 26, (y - 58) / 18)), 2) * 0.20;
        c = mix(c, rgba(214, 112, 88, 255), flush);
        gl = 0.20;
      } else if (m === 2) {
        // blond flat-top: bristle running straight up
        const bristle = 0.5 + 0.5 * sin(x * 1.4 + fbm(seed + 3, x / 4, y / 12, 2, 8) * 9);
        c = mix(BRICK.hairD, BRICK.hair, clamp(0.12 + n * 1.15, 0, 1));
        c = shade(c, 0.86 + bristle * 0.24);
        // roots go dark where the flat-top meets the skull
        c = shade(c, 0.72 + 0.34 * clamp((32 - y) / 16 + 0.6, 0, 1));
        gl = 0.16;
      } else if (m === 3) {
        c = mix(BRICK.lens, rgba(78, 96, 120, 255), clamp(0.1 + n * 0.7, 0, 1));
        gl = 0.86;
      } else {
        // bare chest under the vest, falling off toward the bottom of the frame
        const k = clamp((y - 96) / 34, 0, 1);
        c = mix(BRICK.skin, BRICK.lit, clamp(n * 1.05 - 0.1, 0, 1));
        c = mix(c, BRICK.shade, k * 0.42);
        gl = 0.14;
      }
      put(cv, x, y, c, 0, 0, 1, 1, gl, 0);
    }
  }
  hfNormals(cv, H, 0.60);

  // ---- shades: a hard highlight streak so they read as glass ----
  for (let x = 33; x <= 95; x++) {
    const u = (x - 64) / 31;
    // a hard sky reflection along the top of the lens, cut by the brow line
    tint(cv, x, 28.4 + u * u * 3.0, rgba(210, 232, 255, 255), 0.85 - abs(u) * 0.5);
    tint(cv, x, 29.8 + u * u * 3.0, rgba(132, 170, 212, 255), 0.5 - abs(u) * 0.32);
    tint(cv, x, 39.0 + u * u * 1.8, rgba(10, 12, 18, 255), 0.7);
    // the lens itself, darkest in the middle of each eye
    const lensK = pow(max(0, 1 - abs(abs(u) - 0.52) / 0.44), 1.6);
    for (let y = 31; y <= 38; y++) tint(cv, x, y + u * u * 2.4, BRICK.lens, 0.45 * lensK);
  }
  // bridge over the nose, and the temple arms going back over the ears
  metalPanelRot(cv, 64, 34.5, 9, 5, 0, { col: rgba(46, 50, 60, 255), gloss: 0.7, seed: 9111 });
  for (const sx of [-1, 1]) {
    capsule(cv, 64 + sx * 30, 33, 64 + sx * 40, 44, 2.4, 2.0,
      { col: rgba(38, 42, 52, 255), gloss: 0.62, grain: 0.06, seed: 9113 });
  }
  // brow shadow under the pushed-up shades
  pOcclude(cv, Array.from({ length: 190 }, (_, i) => [34 + (i % 62), 40 + ((i / 62) | 0)]), 0.72);

  // ---- eyes and brows ----
  const eyeY = 51;
  pEye(cv, 51, eyeY, {
    open: M.openL !== undefined ? M.openL : M.open, look: M.look || 0, lookY: M.lookY || 0,
    w: 8.6, iris: rgba(76, 118, 152, 255), skin: BRICK.skin, shade: BRICK.shade, deep: BRICK.deep,
  });
  pEye(cv, 77, eyeY, {
    open: M.open, look: M.look || 0, lookY: M.lookY || 0,
    w: 8.6, iris: rgba(76, 118, 152, 255), skin: BRICK.skin, shade: BRICK.shade, deep: BRICK.deep,
  });
  pBrow(cv, 50, eyeY - 8.6, { w: 12, tilt: M.browL.tilt, lift: M.browL.lift, side: -1, col: rgba(150, 118, 58, 255), thick: 4.2 });
  pBrow(cv, 78, eyeY - 8.6, { w: 12, tilt: M.browR.tilt, lift: M.browR.lift, side: 1, col: rgba(150, 118, 58, 255), thick: 4.2 });

  // ---- nose ----
  for (let y = 44; y <= 68; y++) {
    const k = clamp((y - 44) / 24, 0, 1);
    for (let i2 = 0; i2 < 1 + k * 3.4; i2 += 0.5) {
      tint(cv, 64 + 3.6 + k * 2.6 + i2, y, BRICK.shade, 0.30 + k * 0.34);
    }
    tint(cv, 64 - 1.4, y, mix(BRICK.skin, BRICK.lit, 0.55), 0.28);
  }
  for (const sx of [-1, 1]) ellipseFill(cv, 64 + sx * 4.4, 67, 2.2, 1.5, { bulge: 0, gloss: 0, grain: 0, shader: () => BRICK.deep });
  for (let x = 58; x <= 70; x += 0.5) tint(cv, x, 69 + pow(abs(x - 64) / 6, 2) * 1.4, BRICK.shade, 0.45);

  // ---- mouth ----
  const mouthY = 78;
  pMouth(cv, 64, mouthY, M.mouth, {
    w: 16, skin: BRICK.skin, lip: rgba(168, 104, 88, 255), shade: BRICK.shade,
    dark: rgba(42, 18, 18, 255), skew: M.mouth === 'bare' ? -1.6 : 0,
  });

  // ---- the cigar, and its consequences ----
  const ca = -0.34 + (M.cig || 0) * 0.9;
  const cx0 = 76, cy0 = mouthY - 1;
  const cx1 = cx0 + cos(ca) * 30, cy1 = cy0 + sin(ca) * 30;
  capsule(cv, cx0, cy0, cx1, cy1, 4.6, 4.2, {
    gloss: 0.22, grain: 0.07, seed: seed + 41,
    shader: (t, u, x, y) => {
      const wrap = 0.5 + 0.5 * sin(t * 26 + u * 2);
      let c = mix(shade(BRICK.cigar, 0.62), rgba(146, 104, 62, 255), clamp(0.5 - u * 0.9, 0, 1));
      return shade(c, 0.92 + wrap * 0.16);
    },
  });
  blob(cv, cx1, cy1, 4.0, { col: rgba(52, 40, 34, 255), gloss: 0.1, grain: 0.1, seed: seed + 43 });
  blob(cv, cx1, cy1, 2.6, {
    gloss: 0, grain: 0, seed: seed + 45, em: 0.95,
    shader: (u, v) => mix(rgba(255, 176, 70, 255), rgba(186, 48, 20, 255), clamp(hypot(u, v), 0, 1)),
  });

  // ---- vest, dog tags, and the fact that he is enjoying this ----
  // pec shading first, so the vest sits on top of a chest
  for (const sx of [-1, 1]) {
    for (let t = 0; t <= 1; t += 0.02) {
      const px2 = 64 + sx * (6 + t * 26), py2 = 112 + sin(t * PI) * 7;
      tint(cv, px2, py2, BRICK.shade, 0.42 * (1 - abs(t - 0.5)));
      tint(cv, px2, py2 - 2.2, mix(BRICK.lit, BRICK.skin, 0.4), 0.30);
    }
  }
  for (let y = 100; y < PW; y++) tint(cv, 64, y, BRICK.shade, 0.45);
  for (let x = 34; x <= 94; x += 0.5) {
    const u = (x - 64) / 30;
    for (let d = 0; d < 3; d += 0.5) tint(cv, x, 90 + u * u * 6 + d, BRICK.shade, 0.42 * (1 - abs(u) * 0.4));
  }
  for (const sx of [-1, 1]) {
    capsule(cv, 64 + sx * 21, 102, 64 + sx * 34, 130, 8.6, 10.5, {
      gloss: 0.10, grain: 0, seed: seed + 51,
      shader: (t, u, x, y) => {
        const n = fbm(seed + 53, x / 6, y / 6, 2, 8);
        let c = mix(BRICK.vestD, BRICK.vest, clamp(0.28 + n * 1.2, 0, 1));
        if (((x + y) | 0) % 3 === 0) c = shade(c, 1.05);
        if (fbm(seed + 55, x / 9, y / 9, 2, 8) > 0.66) c = mix(c, rgba(120, 104, 78, 255), 0.35);
        return c;
      },
    });
  }
  capsule(cv, 16, 134, 112, 134, 18, 18, {
    gloss: 0.10, grain: 0, seed: seed + 57,
    shader: (t, u, x, y) => {
      const n = fbm(seed + 53, x / 6, y / 6, 2, 8);
      let c = mix(BRICK.vestD, BRICK.vest, clamp(0.24 + n * 1.2, 0, 1));
      if (((x + y) | 0) % 3 === 0) c = shade(c, 1.05);
      if (fbm(seed + 55, x / 8, y / 8, 2, 8) > 0.62) c = mix(c, rgba(112, 96, 72, 255), 0.4);
      return c;
    },
  });
  for (const sx of [-1, 1]) {
    for (let t = 0; t <= 1; t += 0.04) {
      const bx = 64 + sx * lerp(15, 5, t * t), by = 100 + t * 20;
      blob(cv, bx, by, 1.4, { col: rgba(186, 186, 194, 255), gloss: 0.72, grain: 0.05, seed: seed + 61 });
    }
  }
  metalPanelRot(cv, 61, 124, 8, 13, 0.10, { col: rgba(176, 178, 186, 255), gloss: 0.68, seed: seed + 63 });
  metalPanelRot(cv, 68, 127, 8, 13, 0.10, { col: rgba(146, 148, 156, 255), gloss: 0.62, seed: seed + 65 });

  // ---- damage and effort ----
  if (M.vein) {
    for (const sx of [-1, 1]) {
      for (let t = 0; t <= 1; t += 0.04) {
        const vx = 64 + sx * (10 + t * 9), vy = 96 + t * 22 + sin(t * 8) * 2;
        tint(cv, vx, vy, BRICK.shade, 0.5);
        tint(cv, vx, vy - 1, mix(BRICK.lit, BRICK.skin, 0.4), 0.35);
      }
    }
  }
  if (M.blood) {
    for (let t = 0; t < 22; t++) {
      const bx = 44 + sin(t * 0.5) * 2.4, by = 40 + t;
      for (let i2 = -1.4; i2 <= 1.4; i2 += 0.5) tint(cv, bx + i2, by, t > 14 ? rgba(96, 18, 18, 255) : rgba(158, 30, 26, 255), 0.9);
    }
    for (let i2 = 0; i2 < 9; i2++) {
      const bx = 40 + hash2(i2, 1, seed) * 12, by = 36 + hash2(i2, 2, seed) * 6;
      fillEllipseFlat(cv, bx, by, 2.4, 1.8, rgba(150, 28, 24, 255));
    }
    for (let t = 0; t < 6; t++) tint(cv, 84 + t * 0.6, 74 + t, rgba(150, 28, 24, 255), 0.85);
  }
  if (M.soft) {
    // the eyes have gone somewhere warm; the rest of him has not caught up
    for (const ex of [51, 77]) for (let i2 = -9; i2 <= 9; i2 += 0.5) tint(cv, ex + i2, 44, mix(BRICK.skin, BRICK.lit, 0.6), 0.3);
  }
  scuff(cv, 34, 40, 60, 50, seed + 71, 12, 0.20);
}

const ILSA = {
  skin: rgba(186, 144, 116, 255),
  lit: rgba(216, 176, 142, 255),
  shade: rgba(124, 82, 66, 255),
  deep: rgba(78, 46, 40, 255),
  hair: rgba(124, 90, 68, 255),
  hairHi: rgba(190, 150, 110, 255),
  lens: rgba(198, 206, 190, 255),
  suit: rgba(122, 128, 134, 255),
  suitD: rgba(78, 84, 92, 255),
  grease: rgba(74, 66, 62, 255),
};

const ILSA_MODES = [
  // 0 level and businesslike
  { browL: { lift: 0.6, tilt: 0 }, browR: { lift: 0.6, tilt: 0 }, open: 1.0, mouth: 'flat', tilt: 0 },
  // 1 mid-explanation, slightly urgent
  { browL: { lift: 3.4, tilt: -0.3 }, browR: { lift: 3.8, tilt: -0.35 }, open: 1.12, mouth: 'open', tilt: -0.02 },
  // 2 deeply unimpressed - the one the game will use most
  { browL: { lift: 1.0, tilt: 0.25 }, browR: { lift: 6.5, tilt: -0.55 }, open: 0.66, squint: 0.22, mouth: 'flat', skew: 1.8, tilt: 0.055 },
  // 3 a real, tired smile
  { browL: { lift: 1.8, tilt: -0.2 }, browR: { lift: 1.6, tilt: -0.2 }, open: 0.70, squint: 0.38, mouth: 'smile', tilt: -0.02, warm: 1 },
];

function drawIlsa(cv, idx) {
  const M = ILSA_MODES[idx] || ILSA_MODES[0];
  const H = makeHF(PW, PW);
  const seed = 9301 + idx;

  // ---- masses ----
  hfEllipsoid(H, 64, 154, 56, 38, 16, 4);                       // chest
  hfEllipsoid(H, 26, 134, 25, 20, 14, 4);                       // shoulders
  hfEllipsoid(H, 102, 134, 25, 20, 14, 4);
  hfEllipsoid(H, 64, 108, 13, 20, 20, 1);                       // neck
  hfEllipsoid(H, 39, 60, 4.5, 10, 11, 1);                       // ears
  hfEllipsoid(H, 89, 60, 4.5, 10, 11, 1);
  // hair goes down FIRST as a full mass, then the face is stamped back over it,
  // which is what leaves a hairline instead of a helmet.
  hfEllipsoid(H, 64, 44, 32, 34, 30, 2);
  hfEllipsoid(H, 64, 24, 27, 16, 31, 2);                        // the sweep over the crown
  hfBox(H, 33, 42, 43, 80, 26, 2, { round: 7 });                // pulled back behind the ears
  hfBox(H, 85, 42, 95, 80, 26, 2, { round: 7 });
  hfEllipsoid(H, 64, 92, 16, 12, 18, 2);                        // the tail at the nape
  hfEllipsoid(H, 64, 60, 24, 27, 27, 1, { over: true, taper: 0.46 });   // the face itself
  hfBump(H, 64, 82, 14, 10, 3.2, { only: 1 });                  // chin
  hfBump(H, 47, 66, 12, 10, 2.8, { only: 1 });
  hfBump(H, 81, 66, 12, 10, 2.8, { only: 1 });
  hfBump(H, 53, 52, 12, 5.5, 2.8, { only: 1 });                 // brow ridge
  hfBump(H, 75, 52, 12, 5.5, 2.8, { only: 1 });
  hfBump(H, 64, 60, 4.4, 13, 5.6, { only: 1, p: 1.15 });        // nose bridge
  hfBump(H, 64, 69, 6.0, 5.0, 3.2, { only: 1, p: 1.3 });        // nose tip
  hfBump(H, 54, 59, 9, 6, -3.0, { only: 1, p: 1.3 });
  hfBump(H, 74, 59, 9, 6, -3.0, { only: 1, p: 1.3 });
  // safety glasses pushed up onto the hair
  hfBox(H, 43, 14, 62, 25, 35, 3, { round: 5, dome: 0.55 });
  hfBox(H, 66, 14, 85, 25, 35, 3, { round: 5, dome: 0.55 });
  hfBox(H, 60, 17, 68, 22, 33, 3, { round: 2, dome: 0.2 });

  // ---- albedo ----
  for (let y = 0; y < PW; y++) {
    for (let x = 0; x < PW; x++) {
      const i = y * PW + x;
      const m = H.m[i];
      if (!m) continue;
      const n = fbm(seed, x / 7, y / 7, 2, 8);
      let c, gl = 0.12;
      if (m === 1) {
        c = mix(ILSA.skin, ILSA.lit, clamp(n * 1.2 - 0.12, 0, 1));
        // warmth across the cheeks and the tip of the nose
        const cheeks = pow(max(0, 1 - hypot((abs(x - 64) - 15) / 12, (y - 66) / 10)), 1.6) * 0.34;
        const nose = pow(max(0, 1 - hypot((x - 64) / 7, (y - 68) / 6)), 2) * 0.22;
        c = mix(c, rgba(202, 116, 98, 255), clamp(cheeks + nose, 0, 1));
        gl = 0.18;
      } else if (m === 2) {
        // strands running back off the crown
        const strand = 0.5 + 0.5 * sin(atan2(y - 44, x - 64) * 9 + n * 4);
        c = mix(shade(ILSA.hair, 0.62), ILSA.hair, clamp(0.2 + n * 1.2, 0, 1));
        c = mix(c, ILSA.hairHi, pow(strand, 2.0) * 0.26);
        gl = 0.26;
      } else if (m === 3) {
        c = mix(rgba(158, 172, 152, 255), rgba(118, 136, 118, 255), clamp(0.2 + n * 0.8, 0, 1));
        gl = 0.62;
      } else {
        c = mix(ILSA.suitD, ILSA.suit, clamp(0.28 + n * 1.2, 0, 1));
        if (((x + y) | 0) % 3 === 0) c = shade(c, 1.05);
        gl = 0.14;
      }
      put(cv, x, y, c, 0, 0, 1, 1, gl, 0);
    }
  }
  hfNormals(cv, H, 0.58);

  // ---- safety glasses: a bright lower lip and a raked highlight ----
  for (const sx of [-1, 1]) {
    for (let x = 0; x <= 19; x++) {
      const lx = 64 + sx * (5 + x), u = (x - 9.5) / 9.5;
      tint(cv, lx, 16.4 + u * u * 1.4, rgba(216, 234, 216, 255), 0.66 - abs(u) * 0.34);
      tint(cv, lx, 23.6 - u * u * 1.0, rgba(70, 86, 74, 255), 0.62);
    }
  }
  // frame rim and the strap ends, so it reads as safety glasses not a visor
  for (const sx of [-1, 1]) {
    capsule(cv, 64 + sx * 21, 16, 64 + sx * 25, 28, 2.2, 1.8,
      { col: rgba(52, 56, 50, 255), gloss: 0.5, grain: 0.06, seed: 9351 });
  }
  metalPanelRot(cv, 64, 19, 9, 4, 0, { col: rgba(66, 72, 64, 255), gloss: 0.55, seed: 9353 });
  pOcclude(cv, Array.from({ length: 132 }, (_, i) => [43 + (i % 44), 25 + ((i / 44) | 0)]), 0.80);
  // loose strands that have escaped the tie
  for (let k = 0; k < 4; k++) {
    const sx = k < 2 ? -1 : 1;
    const x0 = 64 + sx * (27 + hash2(k, 1, seed) * 4);
    const y0 = 42 + hash2(k, 2, seed) * 8;
    const len = 16 + hash2(k, 3, seed) * 16;
    let px2 = x0, py2 = y0;
    for (let t = 1; t <= 6; t++) {
      const nx2 = x0 + sx * t * 0.9 + sin(t * 0.9 + k) * 1.6;
      const ny2 = y0 + (t / 6) * len;
      capsule(cv, px2, py2, nx2, ny2, 1.6, 1.1, {
        gloss: 0.16, grain: 0.06, seed: seed + 70 + k,
        shader: (tt, u) => mix(shade(ILSA.hair, 0.7), mix(ILSA.hair, ILSA.hairHi, 0.5), clamp(0.5 - u * 0.9, 0, 1)),
      });
      px2 = nx2; py2 = ny2;
    }
  }

  // ---- headset ----
  const bandCol = rgba(52, 54, 60, 255);
  capsule(cv, 34, 56, 46, 13, 2.6, 2.6, { col: bandCol, gloss: 0.28, grain: 0.08, seed: seed + 81 });
  capsule(cv, 46, 13, 82, 13, 2.6, 2.6, { col: bandCol, gloss: 0.28, grain: 0.08, seed: seed + 82 });
  capsule(cv, 82, 13, 94, 56, 2.6, 2.6, { col: bandCol, gloss: 0.28, grain: 0.08, seed: seed + 83 });
  for (const sx of [-1, 1]) {
    const ex = 64 + sx * 30;
    blob(cv, ex, 63, 6.4, {
      gloss: 0.16, grain: 0.10, seed: seed + 85, squashY: 1.15,
      shader: (u, v) => mix(rgba(60, 62, 68, 255), rgba(38, 40, 46, 255), clamp(hypot(u, v) * 0.9, 0, 1)),
    });
    ringTube(cv, ex, 63, 6.4, 1.5, { col: rgba(74, 76, 84, 255), gloss: 0.34, grain: 0.08, seed: seed + 87, squashY: 1.15 });
  }
  // boom mic swinging in toward her mouth
  let mx0 = 35, my0 = 70;
  for (let t = 1; t <= 5; t++) {
    const nx2 = 35 + t * 2.4, ny2 = 70 + t * 3.4;
    capsule(cv, mx0, my0, nx2, ny2, 2.0, 1.9, { col: bandCol, gloss: 0.4, grain: 0.08, seed: seed + 89 });
    mx0 = nx2; my0 = ny2;
  }
  blob(cv, mx0 + 1, my0 + 1, 4.6, {
    gloss: 0.06, grain: 0.14, seed: seed + 91,
    shader: (u, v, x, y) => shade(rgba(48, 48, 52, 255), 0.8 + fbm(seed + 93, x / 2, y / 2, 2, 8) * 0.5),
  });
  // status LED on the earpiece
  blob(cv, 93, 58, 1.8, { col: rgba(120, 255, 150, 255), gloss: 0.2, grain: 0, em: 0.9 });

  // ---- eyes, brows ----
  const eyeY = 60;
  pEye(cv, 54, eyeY, {
    open: M.open, squint: M.squint || 0, w: 7.6, iris: rgba(74, 96, 70, 255),
    skin: ILSA.skin, shade: ILSA.shade, deep: ILSA.deep, lash: 1, socket: 0.24,
    sclera: rgba(206, 200, 190, 255),
  });
  pEye(cv, 74, eyeY, {
    open: M.open, squint: M.squint || 0, w: 7.6, iris: rgba(74, 96, 70, 255),
    skin: ILSA.skin, shade: ILSA.shade, deep: ILSA.deep, lash: 1, socket: 0.24,
    sclera: rgba(206, 200, 190, 255),
  });
  for (const ex of [54, 74]) {
    for (let i2 = -9; i2 <= 9; i2 += 0.5) {
      const u = i2 / 9;
      for (let d = 0; d < 3; d += 0.5) {
        tint(cv, ex + i2, eyeY - 5.8 + u * u * 1.6 - d, ILSA.shade, (0.34 - d * 0.07) * (1 - abs(u) * 0.5));
      }
    }
  }
  pBrow(cv, 53, eyeY - 8.6, { w: 11, tilt: M.browL.tilt, lift: M.browL.lift, side: -1, col: rgba(62, 44, 36, 255), thick: 3.0 });
  pBrow(cv, 75, eyeY - 8.6, { w: 11, tilt: M.browR.tilt, lift: M.browR.lift, side: 1, col: rgba(62, 44, 36, 255), thick: 3.0 });
  // shadows of not enough sleep
  for (const ex of [54, 74]) {
    for (let i2 = -7; i2 <= 7; i2 += 0.5) {
      const u = i2 / 7;
      tint(cv, ex + i2, eyeY + 6.4 + u * u * 1.2, mix(ILSA.shade, rgba(126, 96, 108, 255), 0.5), 0.32);
      tint(cv, ex + i2, eyeY + 7.6 + u * u * 1.2, ILSA.shade, 0.18);
    }
  }
  // hairline: a soft shadow where the hair meets the forehead, and two short
  // wisps that have escaped forward over the temples
  for (let x = 42; x <= 86; x += 0.5) {
    const u = (x - 64) / 22;
    for (let d = 0; d < 4; d += 0.5) tint(cv, x, 36 + u * u * 4.5 + d, ILSA.deep, 0.42 - d * 0.07);
  }
  for (const sx of [-1, 1]) {
    let fx = 64 + sx * 21, fy = 38;
    for (let t = 1; t <= 4; t++) {
      const nx2 = fx + sx * 2.2, ny2 = fy + 3.4;
      capsule(cv, fx, fy, nx2, ny2, 1.7, 1.1, {
        gloss: 0.16, grain: 0.06, seed: seed + 130 + t,
        shader: (tt, u) => mix(shade(ILSA.hair, 0.72), mix(ILSA.hair, ILSA.hairHi, 0.55), clamp(0.5 - u * 0.9, 0, 1)),
      });
      fx = nx2; fy = ny2;
    }
  }

  // ---- nose, mouth ----
  for (let y = 54; y <= 73; y++) {
    const k = clamp((y - 54) / 19, 0, 1);
    for (let i2 = 0; i2 < 0.8 + k * 2.6; i2 += 0.5) tint(cv, 64 + 2.8 + k * 2.0 + i2, y, ILSA.shade, 0.28 + k * 0.30);
    tint(cv, 64 - 1.2, y, mix(ILSA.skin, ILSA.lit, 0.5), 0.26);
  }
  for (const sx of [-1, 1]) ellipseFill(cv, 64 + sx * 3.4, 72, 1.8, 1.2, { bulge: 0, gloss: 0, grain: 0, shader: () => ILSA.deep });
  for (let x = 59; x <= 69; x += 0.5) tint(cv, x, 74 + pow(abs(x - 64) / 5, 2) * 1.2, ILSA.shade, 0.4);
  // cheek hollows and a jaw line, so the lower face has structure
  for (const sx of [-1, 1]) {
    for (let t = 0; t <= 1; t += 0.03) {
      tint(cv, 64 + sx * lerp(20, 11, t), lerp(66, 84, t), ILSA.shade, 0.36 * (1 - abs(t - 0.4)));
    }
  }
  // jaw line, then the shadow it casts on the neck
  for (let a = 0.40; a < PI - 0.40; a += 0.025) {
    for (let d = 0; d < 2.5; d += 0.5) tint(cv, 64 + cos(a) * -22, 60 + sin(a) * 27 - d, ILSA.shade, 0.22);
  }
  for (let x = 48; x <= 80; x += 0.5) {
    const u = (x - 64) / 16;
    for (let d = 0; d < 4; d += 0.5) tint(cv, x, 90 + u * u * 4 + d, ILSA.deep, 0.30 - d * 0.05);
  }
  pMouth(cv, 64, 79, M.mouth, {
    w: 13, skin: ILSA.skin, lip: rgba(164, 106, 94, 255), shade: ILSA.shade,
    dark: rgba(44, 20, 20, 255), skew: M.skew || 0,
  });

  // ---- jumpsuit: collar, zip, tool loop, name patch ----
  for (const sx of [-1, 1]) {
    capsule(cv, 64 + sx * 5, 114, 64 + sx * 32, 130, 8.0, 10.0, {
      gloss: 0.12, grain: 0, seed: seed + 101,
      shader: (t, u, x, y) => {
        const n = fbm(seed + 103, x / 6, y / 6, 2, 8);
        let c = mix(ILSA.suitD, mix(ILSA.suit, rgba(126, 132, 138, 255), 0.4), clamp(0.3 + n * 1.2, 0, 1));
        if (((x + y) | 0) % 3 === 0) c = shade(c, 1.06);
        return c;
      },
    });
  }
  for (let y = 112; y < PW; y++) {
    tint(cv, 64, y, rgba(150, 154, 160, 255), 0.7);
    tint(cv, 65, y, rgba(70, 74, 80, 255), 0.6);
    if ((y | 0) % 3 === 0) tint(cv, 64, y, rgba(190, 194, 200, 255), 0.7);
  }
  // tool loop and a couple of things hanging in it
  capsule(cv, 34, 114, 34, 128, 3.0, 3.0, { col: rgba(58, 52, 44, 255), gloss: 0.18, grain: 0.08, seed: seed + 105 });
  capsule(cv, 30, 118, 28, 128, 2.6, 2.2, { col: rgba(158, 150, 132, 255), gloss: 0.6, grain: 0.08, seed: seed + 107 });
  capsule(cv, 39, 118, 41, 128, 2.4, 2.0, { col: rgba(126, 96, 60, 255), gloss: 0.4, grain: 0.08, seed: seed + 109 });
  metalPanelRot(cv, 92, 118, 22, 10, -0.06, { col: rgba(138, 128, 96, 255), gloss: 0.2, seed: seed + 111 });
  stencil(cv, 'VANCE', 83, 115, rgba(46, 42, 34, 255), 0.85);

  // ---- grease, worn across one cheek with the back of a wrist ----
  for (let k = 0; k < 4; k++) {
    const gy = 72 + k * 2.6;
    for (let x = 78; x < 92; x += 0.5) {
      const n = fbm(seed + 121, x / 4, gy / 3, 2, 8);
      if (n < 0.42) continue;
      tint(cv, x, gy + sin(x * 0.4) * 1.2, ILSA.grease, 0.30 + n * 0.42);
    }
  }
  if (M.warm) {
    for (const ex of [54, 74]) for (let i2 = -8; i2 <= 8; i2 += 0.5) {
      tint(cv, ex + i2, eyeY + 8.6, mix(ILSA.shade, ILSA.lit, 0.5), 0.34);   // crow's feet
    }
  }
}

/**
 * The CRT treatment. She is not in the room; she is a transmission. Scanlines,
 * a green-phosphor cast and a horizontal bloom, all confined inside the figure
 * so the surround stays fully transparent.
 */
function crtPass(f, seed) {
  const { w, h, data } = f;
  const src = data.slice();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!(src[i] >>> 24)) continue;
      let r = src[i] & 255, g = (src[i] >>> 8) & 255, b = (src[i] >>> 16) & 255;
      // horizontal phosphor bleed from the brighter neighbours
      let br = 0, bg = 0, bb = 0;
      for (let k = -3; k <= 3; k++) {
        const j = i + k;
        if (k === 0 || x + k < 0 || x + k >= w || !(src[j] >>> 24)) continue;
        const wgt = (4 - abs(k)) / 16;
        const lum = ((src[j] & 255) * 0.3 + ((src[j] >>> 8) & 255) * 0.6 + ((src[j] >>> 16) & 255) * 0.1) / 255;
        const boost = pow(max(0, lum - 0.50), 1.6) * wgt * 1.3;
        br += (src[j] & 255) * boost; bg += ((src[j] >>> 8) & 255) * boost; bb += ((src[j] >>> 16) & 255) * boost;
      }
      r += br; g += bg; b += bb;
      // phosphor: pull toward green, lift the blacks the way a CRT does
      const lum = (r * 0.3 + g * 0.6 + b * 0.1);
      r = lerp(r, lum * 0.86, 0.16) * 1.06;
      g = lerp(g, lum * 1.10, 0.16) * 1.10 + 4;
      b = lerp(b, lum * 0.90, 0.16) * 1.04;
      // scanlines, plus a slow horizontal band that is a touch brighter
      const scan = (y & 1) ? 0.94 : 1.02;
      const band = 1 + 0.07 * sin((y + (seed % 17)) * 0.10);
      const jitter = ((y % 5) === 0) ? 1.03 : 1;
      const k2 = scan * band * jitter;
      data[i] = rgba(clamp(r * k2, 0, 255), clamp(g * k2, 0, 255), clamp(b * k2, 0, 255), 255);
    }
  }
  return f;
}

function buildPortrait(who, idx) {
  const cv = makeCv(PW, PW);
  setModel();
  if (who === 'brick') drawBrick(cv, idx); else drawIlsa(cv, idx);
  const tilt = who === 'ilsa' ? (ILSA_MODES[idx].tilt || 0) : (idx === 1 ? -0.03 : 0);
  const posed = tilt ? poseCv(cv, tilt, 64, 96, 0, 0) : cv;
  const f = bake(posed, {
    key: who === 'brick' ? norm3(-0.42, -0.70, 0.58) : norm3(-0.52, -0.62, 0.58),
    keyCol: who === 'brick' ? [1.0, 0.93, 0.84] : [0.94, 0.98, 1.0],
    fill: who === 'brick' ? 0.30 : 0.26,
    fillCol: who === 'brick' ? [0.60, 0.58, 0.66] : [0.46, 0.56, 0.62],
    rim: 0.26, env: 0.30, exposure: who === 'brick' ? 1.0 : 1.14,
    bounce: who === 'brick' ? 0.20 : 0.14,
    bounceCol: who === 'brick' ? [1.0, 0.72, 0.52] : [0.72, 0.90, 0.80],
  });
  rimOutline(f, rgba(12, 10, 14, 255));
  if (who === 'ilsa') crtPass(f, 9301 + idx);
  return f;
}

/** The bezel the portrait sits inside: chunky, bolted, with a live lamp. */
function drawPortraitFrame() {
  const S = 144;
  const cv = makeCv(S, S);
  setModel();
  const t = 14;                                 // bezel thickness
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = min(x, S - 1 - x), dy = min(y, S - 1 - y);
      const d = min(dx, dy);
      if (d >= t) continue;                     // the middle is where the portrait goes
      const e = d / t;
      // outer lip rises, inner lip falls away into the screen
      const ny = (dy < dx ? (y < S / 2 ? -1 : 1) : 0) * (1 - e) * 0.9;
      const nx = (dx <= dy ? (x < S / 2 ? -1 : 1) : 0) * (1 - e) * 0.9;
      const bevel = e < 0.18 ? 1 : e > 0.82 ? -1 : 0;
      const n = fbm(9501, x / 7, y / 7, 2, 8);
      let c = mix(rgba(74, 76, 84, 255), rgba(128, 130, 140, 255), clamp(0.25 + n * 1.2, 0, 1));
      if (bevel > 0) c = shade(c, 1.22);
      if (bevel < 0) c = shade(c, 0.72);
      if (fbm(9503, x / 4, y / 4, 2, 8) > 0.74) c = mix(c, RUST, 0.18);
      put(cv, x, y, c, nx * (bevel || 1), ny * (bevel || 1),
        sqrt(max(0.1, 1 - nx * nx - ny * ny)), 1, 0.42, 0);
    }
  }
  for (const [bx, by] of [[10, 10], [S - 11, 10], [10, S - 11], [S - 11, S - 11]]) {
    blob(cv, bx, by, 4.6, { col: rgba(150, 152, 160, 255), gloss: 0.6, grain: 0.07, seed: 9505 });
    for (let a = 0; a < TAU; a += 0.5) {
      // hex head
      capsule(cv, bx + cos(a) * 3.2, by + sin(a) * 3.2,
        bx + cos(a + 0.6) * 3.2, by + sin(a + 0.6) * 3.2, 0.9, 0.9,
        { col: rgba(90, 92, 100, 255), gloss: 0.5, grain: 0.06, seed: 9507 });
    }
  }
  // status lamp, bottom right, lit
  blob(cv, S - 30, S - 8, 4.2, { col: rgba(255, 140, 70, 255), gloss: 0.3, grain: 0, em: 0.9 });
  ringTube(cv, S - 30, S - 8, 5.2, 1.8, { col: rgba(64, 66, 72, 255), gloss: 0.55, grain: 0.08, seed: 9509 });
  stencil(cv, 'COMMS', 14, S - 11, rgba(188, 184, 172, 255), 0.55);
  scuff(cv, 0, 0, S, S, 9511, 60, 0.30);
  soot(cv, 0, 0, S, S, 9513, 0.24, 12);
  const f = bake(cv, { fill: 0.26, rim: 0.34, env: 0.9, botDark: 0.10 });
  rimOutline(f, rgba(10, 9, 12, 255));
  return f;
}

/** Signal dropout: torn bands, snow, and a rolling bar. Partial alpha. */
function drawPortraitStatic(k) {
  const f = makeFrame(PW, PW);
  const seed = 9601 + k * 71;
  const roll = (k / 3) * PW;
  for (let y = 0; y < PW; y++) {
    // a few horizontal tears whose rows are displaced and blown out
    const tear = fbm(seed, 0.5, y / 3.5, 2, 8);
    const bandK = smoothstep(0.62, 0.86, tear);
    const rollK = pow(max(0, 1 - abs(((y - roll) % PW + PW) % PW - 6) / 22), 2.2);
    for (let x = 0; x < PW; x++) {
      const n = hash2(x + (bandK * 24 | 0), y, seed);
      let a = 0;
      let v = 0;
      if (bandK > 0.02) { a += bandK * (0.30 + n * 0.55); v = 90 + n * 165; }
      if (rollK > 0.02) { a += rollK * 0.30; v = max(v, 120 + n * 120); }
      if (n > 0.985) { a = max(a, 0.55); v = 230; }              // sparse snow everywhere
      if (a < 0.015) continue;
      blend(f, x, y, rgba(v * 0.72, v, v * 0.80, 255), min(a, 0.85));
    }
  }
  return f;
}

// ---------------------------------------------------------------------------
// EXPANSION FX
// ---------------------------------------------------------------------------

const GORE = [
  [0.00, 255, 236, 232],
  [0.14, 255, 150, 150],
  [0.34, 214, 58, 52],
  [0.58, 146, 24, 28],
  [0.80, 84, 16, 22],
  [1.00, 38, 12, 16],
];

/** Meat ramp: t=0 the hot wet centre, t=1 dried and dark. */
function goreGradient(t) {
  t = clamp(t, 0, 1);
  for (let i = 1; i < GORE.length; i++) {
    const a = GORE[i - 1], b = GORE[i];
    if (t <= b[0]) {
      const u = (t - a[0]) / (b[0] - a[0] || 1);
      return [lerp(a[1], b[1], u), lerp(a[2], b[2], u), lerp(a[3], b[3], u)];
    }
  }
  return [38, 12, 16];
}

/**
 * A body coming apart: dense and hot at frame 0, then chunks, strings and a
 * settling mist thrown outward. Not an explosion - no yellow, no soot.
 */
function drawGibBurst(size, k) {
  const f = makeFrame(size, size);
  const c = size / 2;
  const t = k / 5;
  const seed = 9701 + k * 47;
  const rng = makeRng(seed);
  const R = lerp(9, 40, pow(t, 0.62));
  const edge = size * 0.46;

  // --- the wet core, shrinking and cooling ---
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - c, dy = y - c;
      const d = hypot(dx, dy);
      if (d > edge) continue;
      const ang = atan2(dy, dx);
      const warp = fbm(seed, cos(ang) * 3 + 4, sin(ang) * 3 + 4, 3, 8);
      const blob2 = fbm(seed + 5, x / 5.5, y / 5.5, 3, 8);
      const rr = R * (0.52 + warp * 0.72);
      let dens = pow(max(0, 1 - d / rr), 0.95) * (0.62 + blob2 * 1.15) * (1.30 - t * 0.80);
      dens *= smoothstep(edge, edge * 0.62, d);
      if (dens < 0.03) continue;
      const heat = clamp(0.16 + (d / max(1, rr)) * 0.55 + t * 0.5, 0, 1);
      const g = goreGradient(heat);
      blend(f, x, y, rgba(g[0], g[1], g[2], 255), clamp(dens, 0, 0.96));
    }
  }
  // --- chunks: actual pieces with a lit top and a dark underside ---
  const n = 16 + k * 5;
  for (let i = 0; i < n; i++) {
    const a = rng() * TAU;
    const r = R * (0.5 + rng() * 1.15) * (0.35 + t * 1.1);
    const cx2 = c + cos(a) * r, cy2 = c + sin(a) * r * 0.92 + t * t * 12;
    if (hypot(cx2 - c, cy2 - c) > edge) continue;
    const rad = (1.8 + rng() * 4.6) * (1 - t * 0.30);
    // one angle, not two: cos(a) and sin(b) is not a rotation, and when both
    // land near zero the lump degenerates into a filled rectangle.
    const a3 = rng() * PI;
    const asp = 0.6 + rng() * 1.1, ca2 = cos(a3), sa2 = sin(a3);
    for (let j = -rad * 2; j <= rad * 2; j++) {
      for (let ii = -rad * 2; ii <= rad * 2; ii++) {
        // an oriented lump, roughened so it is not a bead
        const rx2 = (ii * ca2 + j * sa2) / rad, ry2 = (-ii * sa2 + j * ca2) / (rad * asp);
        const dd = hypot(rx2, ry2) * (0.86 + fbm(seed + i, (cx2 + ii) / 2.2, (cy2 + j) / 2.2, 2, 8) * 0.36);
        if (dd > 1) continue;
        const g = goreGradient(clamp(0.16 + dd * 0.55 + t * 0.26, 0, 1));
        const lit = clamp(1 - (j / rad) * 0.42, 0.45, 1.5);
        blend(f, cx2 + ii, cy2 + j, rgba(g[0] * lit, g[1] * lit, g[2] * lit, 255), clamp(1 - dd * 0.22, 0, 0.99));
      }
    }
    // a bone chip or two
    if (rng() < 0.16) {
      blend(f, cx2, cy2 - rad * 0.4, rgba(232, 224, 202, 255), 0.9);
      blend(f, cx2 + 1, cy2 - rad * 0.4, rgba(196, 186, 166, 255), 0.8);
    }
  }
  // --- strings and spatter trails ---
  for (let i = 0; i < 10 + k * 3; i++) {
    const a = rng() * TAU;
    const len = R * (0.6 + rng() * 1.2);
    let px2 = c + cos(a) * R * 0.3, py2 = c + sin(a) * R * 0.3;
    for (let sgi = 0; sgi < 7; sgi++) {
      const nx2 = px2 + cos(a + sin(sgi * 1.7 + i) * 0.5) * (len / 7);
      const ny2 = py2 + sin(a + sin(sgi * 1.7 + i) * 0.5) * (len / 7) + t * 2;
      if (hypot(nx2 - c, ny2 - c) < edge) {
        const g = goreGradient(0.30 + sgi * 0.07 + t * 0.3);
        blend(f, nx2, ny2, rgba(g[0], g[1], g[2], 255), (0.85 - sgi * 0.09) * (1 - t * 0.4));
      }
      px2 = nx2; py2 = ny2;
    }
  }
  // --- fine mist that lingers ---
  if (t > 0.25) {
    for (let i = 0; i < 90; i++) {
      const a = rng() * TAU, r = R * (0.7 + rng() * 1.25);
      const x = c + cos(a) * r, y = c + sin(a) * r + t * 10;
      if (hypot(x - c, y - c) > edge) continue;
      const g = goreGradient(0.5 + rng() * 0.4);
      blend(f, x, y, rgba(g[0], g[1], g[2], 255), (0.5 - t * 0.28) * rng());
    }
  }
  return f;
}

const ACID = rgba(120, 255, 140, 255);

/** Glowing green acid impact: hot core, running droplets, a fading pool. */
function drawAcidSplash(size, k) {
  const f = makeFrame(size, size);
  const c = size / 2;
  const t = k / 3;
  const seed = 9801 + k * 53;
  const rng = makeRng(seed);
  const R = lerp(8, 26, pow(t, 0.6));
  const edge = size * 0.46;
  const env = makeEnvelope(seed, 5, 0.55);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - c, dy = y - c;
      const d = hypot(dx, dy);
      if (d > edge) continue;
      let ang = atan2(dy, dx); if (ang < 0) ang += TAU;
      const rr = R * env(ang);
      let inten = pow(max(0, 1 - d / rr), 1.15) * (1.25 - t * 0.55);
      inten += pow(max(0, 1 - d / (R * 0.34)), 1.8) * (1.8 - t * 1.35);
      inten *= smoothstep(edge, edge * 0.66, d);
      if (inten < 0.02) continue;
      // white-hot centre falling off to a deep bottle green
      const wh = clamp((inten - 1.35) * 0.85, 0, 1);
      const cool = clamp(1 - inten * 0.95, 0, 1);
      const r2 = lerp(lerp(120, 34, cool), 250, wh);
      const g2 = lerp(lerp(255, 132, cool * 0.8), 255, wh);
      const b2 = lerp(lerp(140, 52, cool), 240, wh);
      blend(f, x, y, rgba(r2, g2, b2, 255), clamp(pow(inten, 0.8) * 0.95, 0, 0.95));
    }
  }
  // flung droplets, each with a short tail
  for (let i = 0; i < 14 + k * 4; i++) {
    const a = rng() * TAU;
    const r = R * (0.85 + rng() * (0.6 + t * 0.9));
    const x = c + cos(a) * r, y = c + sin(a) * r * 0.95 + t * t * 6;
    if (hypot(x - c, y - c) > edge) continue;
    const rad = 0.9 + rng() * 2.2 * (1 - t * 0.4);
    for (let j = -rad; j <= rad; j++) for (let ii = -rad; ii <= rad; ii++) {
      const dd = hypot(ii, j) / rad;
      if (dd > 1) continue;
      blend(f, x + ii, y + j, mix(ACID, rgba(46, 150, 70, 255), dd * 0.8), (1 - dd * 0.4) * (0.95 - t * 0.4));
    }
    for (let s2 = 1; s2 < 4; s2++) {
      blend(f, x - cos(a) * s2 * 1.4, y - sin(a) * s2 * 1.4, ACID, (0.5 - s2 * 0.12) * (1 - t * 0.5));
    }
  }
  return f;
}

/** A boot connecting: a stylised concussion ring, dust, and a few streaks. */
function drawKickImpact(size, k) {
  const f = makeFrame(size, size);
  const c = size / 2;
  const t = k / 2;
  const seed = 9901 + k * 59;
  const rng = makeRng(seed);
  const R = lerp(13, 38, pow(t, 0.62));
  const thick = lerp(4.4, 2.0, t);
  const bright = lerp(1.0, 0.42, t);
  const edge = size * 0.47;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - c, dy = y - c;
      const d = hypot(dx, dy * 1.22);          // squashed: the blow lands flat
      if (d > edge) continue;
      const ang = atan2(dy, dx);
      const wob = 1 + (fbm(seed, cos(ang) * 3 + 4, sin(ang) * 3 + 4, 2, 8) - 0.5) * 0.20;
      const off = abs(d - R * wob);
      const core = pow(max(0, 1 - off / thick), 1.3) * 1.15 * bright;
      const halo = pow(max(0, 1 - off / (thick * 6)), 2.0) * 0.46 * bright;
      let inten = core + halo;
      inten *= smoothstep(edge, edge * 0.7, d);
      if (inten < 0.015) continue;
      const wh = clamp((inten - 0.85) * 1.2, 0, 1);
      blend(f, x, y, rgba(lerp(214, 255, wh), lerp(202, 250, wh), lerp(178, 236, wh), 255),
        clamp(inten * 0.85, 0, 0.92));
    }
  }
  // dust kicked off the floor, heavier at the bottom of the ring
  for (let i = 0; i < 12 + k * 6; i++) {
    const a = rng() * TAU;
    const r = R * (0.75 + rng() * 0.7);
    const x = c + cos(a) * r, y = c + sin(a) * r * 0.72 + t * 6;
    const rad = (3 + rng() * 7) * (0.6 + t * 0.8);
    for (let j = -rad; j <= rad; j++) for (let ii = -rad; ii <= rad; ii++) {
      const dd = hypot(ii, j) / rad;
      if (dd > 1) continue;
      if (hypot(x + ii - c, y + j - c) > edge) continue;
      const nn = fbm(seed + i, (x + ii) / 5, (y + j) / 5, 2, 8);
      const g = 118 + nn * 54;
      blend(f, x + ii, y + j, rgba(g, g * 0.96, g * 0.86, 255),
        pow(1 - dd, 1.5) * (0.20 + nn * 0.28) * (1 - t * 0.35));
    }
  }
  // a couple of hard radial streaks, because it is a kick and not a puff
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + 0.4 + t * 0.3;
    for (let s2 = 0; s2 < 22; s2++) {
      const rr = R * 0.55 + s2 * 1.5;
      const x = c + cos(a) * rr, y = c + sin(a) * rr * 0.75;
      if (hypot(x - c, y - c) > edge) continue;
      blend(f, x, y, rgba(238, 230, 210, 255), (0.55 - s2 * 0.022) * bright);
    }
  }
  return f;
}

/** The bomb as a world object: lying on the floor, timer face up. */
function drawPipebombProp(lit) {
  const S = 28;
  const cv = makeCv(S, S);
  setModel();
  // pipe lying across the tile
  capsule(cv, 5, 17, 23, 15, 5.2, 5.2, { shader: pipeShader(9951), gloss: 0.5, grain: 0, seed: 9953 });
  for (const [x0, x1] of [[5, 7.5], [23, 20.5]]) {
    capsule(cv, x0, x0 < 10 ? 17 : 15, x1, x1 < 10 ? 17 : 15.4, 6.0, 5.7, {
      gloss: 0.55, grain: 0.07, seed: 9955,
      shader: (t, u) => mix(shade(PIPE_D, 0.72), STEEL_B, clamp(0.48 - u * 0.8, 0, 1)),
    });
  }
  tapeWrap(cv, 8.5, 16.6, 11, 16.4, 5.4, 9957);
  tapeWrap(cv, 18, 15.6, 20.5, 15.4, 5.4, 9959);
  // timer dial, face up toward the player
  blob(cv, 14, 10, 6.2, { col: rgba(200, 194, 178, 255), gloss: 0.3, grain: 0.08, seed: 9961 });
  ringTube(cv, 14, 10, 5.6, 1.4, {
    gloss: 0.55, grain: 0.07, seed: 9963,
    shader: (a, u) => mix(shade(STEEL_D, 0.6), STEEL_B, clamp(0.55 - cos(a + 0.5) * 0.5 - u * 0.4, 0, 1)),
  });
  blob(cv, 14, 10, 4.4, { col: DIAL_FACE, gloss: 0.22, grain: 0.05, seed: 9965 });
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU;
    for (let r = 2.6; r <= 4.0; r += 0.5) tint(cv, 14 + cos(a) * r, 10 + sin(a) * r, rgba(52, 44, 36, 255), 0.85);
  }
  const ha = -PI / 2 + lit * 2.0;
  for (let r = -0.6; r <= 3.6; r += 0.4) tint(cv, 14 + cos(ha) * r, 10 + sin(ha) * r, rgba(190, 46, 36, 255), 0.95);
  // arming lamp: dark on the prop, brightening once the fuse is running
  const lampC = lit > 0
    ? mix(rgba(90, 26, 22, 255), rgba(255, 170, 120, 255), lit)
    : rgba(76, 24, 22, 255);
  blob(cv, 22, 9, 2.2, { col: lampC, gloss: 0.4, grain: 0, em: 0.15 + lit * 0.85 });
  // fuse stub
  capsule(cv, 5, 17, 1.5, 21, 1.8, 1.2, { col: rgba(148, 132, 96, 255), gloss: 0.14, grain: 0.14, seed: 9967 });
  scuff(cv, 2, 4, 24, 20, 9969, 8, 0.3);
  const f = bake(cv, { fill: 0.28, rim: 0.34, env: 0.8, exposure: 1.04 });
  rimOutline(f, rgba(10, 9, 12, 255));
  return f;
}
