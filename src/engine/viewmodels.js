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
  const n = (hash2(x, y, seed) - 0.5) * 2 + (fbm(seed, x / 9, y / 9, 3, 8) - 0.5) * 1.6;
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
      const n = fbm(seed, (x + i) / scale, (y + j) / scale, 4, 8);
      const k = smoothstep(0.52, 0.86, n) * amt;
      if (k > 0.02) tint(cv, x + i, y + j, rgba(26, 22, 22, 255), k);
    }
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
  '*': [5, 2, 7, 2, 5], '!': [2, 2, 2, 0, 2], '+': [0, 2, 7, 2, 0],
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
    const n = fbm(seed, x / 4.6, y / 4.6, 3, 8);
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
      for (let t = -1; t <= 1; t += 0.10) {
        const A = T(jx, jy + t * J.r * 0.92);
        tint(cv, A[0], A[1], LEATHER.deep, 0.42);
        occlude(cv, A[0], A[1], 0.74);
      }
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
      for (let t = 0; t <= 1; t += 0.045) {
        const gx = lerp(3.5, J.pts[2][0], t);
        const yy = lerp(gy, (J.pts[2][1] + joints[i + 1].pts[2][1]) * 0.5, t);
        const A = T(gx, yy);
        tint(cv, A[0], A[1], LEATHER.deep, 0.5);
        occlude(cv, A[0], A[1], 0.6);
      }
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
  ang: -0.34,
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
  metalPanel(cv, 112, 99, 27, 8, { col: BLUED_D, gloss: 0.5, bevel: 2, round: 2, seed: 218 });
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
    96 + (93 - 96) * cos(-0.34) - (41 - 100) * sin(-0.34),
    100 + (93 - 96) * sin(-0.34) + (41 - 100) * cos(-0.34),
  ],
  splitter: [98, 44], nailer: [100, 40], halo: [100, 60], deadman: [104, 30],
};

/**
 * How each weapon is sized into the 200x150 frame: scale about a model-space
 * centre, landing on a canvas-space target. This is the one knob for
 * composition - the models themselves never move.
 */
const WEAPON_FIT = {
  pistol: { s: 1.36, cx: 100, cy: 106, tx: 97, ty: 100 },
  splitter: { s: 1.26, cx: 99, cy: 100, tx: 100, ty: 94 },
  nailer: { s: 1.24, cx: 100, cy: 100, tx: 100, ty: 95 },
  halo: { s: 1.16, cx: 100, cy: 92, tx: 100, ty: 86 },
  deadman: { s: 1.24, cx: 104, cy: 118, tx: 100, ty: 108 },
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
};

const WEAPON_DRAW = {
  pistol: drawWidow, splitter: drawSplitter, nailer: drawNailer, halo: drawHalo, deadman: drawDeadman,
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
      fill: 0.20, rim: 0.32, botDark: 0.34,
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
      const warp = fbm(seed + 3, cos(ang) * 3.2 + 4 + t * 2, sin(ang) * 3.2 + 4, 4, 8);
      const puff = fbm(seed + 7, x / (7 + t * 7), y / (7 + t * 7), 4, 8);
      const puff2 = fbm(seed + 13, x / 3.4, y / 3.4, 3, 8);
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
      const turb = fbm(seed, x / (5 + t * 8), y / (5 + t * 8), 4, 8);
      const turb2 = fbm(seed + 11, x / 2.8, y / 2.8, 3, 8);
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
        const n = fbm(seed + 21, x / 11, y / 8 + t * 3, 4, 8);
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
            const n = fbm(seed + 31, (lx + i) / 7, (y + j) / 7, 4, 8);
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
        const n = fbm(seed + 43, (lx + i) / 8, (ly + j) / 8, 4, 8);
        const n2 = fbm(seed + 47, (lx + i) / 3, (ly + j) / 3, 3, 8);
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
        const n = fbm(seed + 51, x / 8, y / 5, 4, 8);
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

  // --- weapon viewmodels (5 weapons x 6 poses, 200x150) ---
  for (const name of ['pistol', 'splitter', 'nailer', 'halo', 'deadman']) buildWeapon(frames, name);

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
        const jaw = smoothstep(cy + 4, cy + 16, y) * (1 - smoothstep(16, 22, abs(x - cx)));
        const tache = smoothstep(6, 9, abs(y - (cy + 11))) < 0.5 && abs(x - cx) < 7 ? 1 : 0;
        const st = clamp(jaw * 0.95 + tache * 0.5, 0, 1);
        if (st > 0.03) {
          const dot = hash2(x, y, 77) < 0.42 + st * 0.3 ? 1 : 0;
          c = mix(c, SKIN.stubble, st * (0.32 + dot * 0.30));
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
    for (let a2 = 0; a2 < TAU; a2 += 0.12) occlude(cv, e.x + cos(a2) * 6.6, e.y + 0.5 + sin(a2) * 4.8, 0.82);
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
  for (const sx of [-1, 1]) {
    ellipseFill(cv, nx2 + sx * 3.0, ny2 + 2.2, 1.5, 1.1,
      { bulge: 0, gloss: 0, grain: 0, shader: () => SKIN.deep });
  }
  for (let y = ny2 - 6; y <= ny2 + 2; y++) tint(cv, nx2 + 4.4 + (y - ny2) * 0.12, y, SKIN.shade, 0.45);

  const my = cy + 14;
  // shadow under the nose and along the jaw, plus the philtrum groove
  for (let x = nx2 - 5; x <= nx2 + 5; x += 0.5) {
    const u = (x - nx2) / 5;
    tint(cv, x, ny2 + 3.4 + u * u, SKIN.shade, 0.5 * (1 - abs(u) * 0.5));
  }
  for (let y = ny2 + 4; y < my - 2.6; y += 0.5) {
    tint(cv, nx2 - 1, y, SKIN.shade, 0.28); tint(cv, nx2 + 1, y, mix(SKIN.lit, skinBase, 0.5), 0.22);
  }
  for (let a = 0.35; a < PI - 0.35; a += 0.03) {
    const jx = cx + cos(a) * -17.5, jy = cy + sin(a) * 20.5;
    for (let d = 0; d < 3; d += 0.5) occlude(cv, jx, jy - d, 0.80);
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
  const dark = rgba(58, 26, 26, 255);
  const teeth = rgba(226, 218, 200, 255);
  const lipC = SKIN.lip;
  const put2 = (x, y, c, a = 1) => tint(cv, x, y, c, a);
  if (kind === 'flat') {
    for (let x = mx - 9; x <= mx + 9; x += 0.5) {
      const u = (x - mx) / 9;
      const y = my + u * u * 2.0 + (tier <= 2 ? 0.6 : 0);
      const end = pow(abs(u), 3);
      put2(x, y - 0.5, mix(dark, rgba(30, 14, 14, 255), end), 1);
      put2(x, y + 0.5, mix(dark, rgba(30, 14, 14, 255), end), 1);
      // lit lower lip and a shadow under it
      put2(x, y + 1.8, mix(lipC, SKIN.lit, 0.35 - abs(u) * 0.3), 0.9);
      put2(x, y + 3.0, SKIN.shade, 0.55 * (1 - end));
      // upper lip in shadow
      put2(x, y - 2.0, mix(lipC, SKIN.shade, 0.55), 0.75);
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
    key: norm3(-0.40, -0.78, 0.52),
    keyCol: [1.0, 0.94, 0.86],
    fill: 0.34, fillCol: [0.52, 0.56, 0.70],
    rim: 0.26, env: 0.35, exposure: 1.02,
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
            const n = fbm(seed + 93 + c2, (px2 + i) / 7, (py2 + j) / 7, 3, 8);
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
          const n = fbm(seed + 43 + c2, (px2 + i) / 6, (py2 + j) / 6, 3, 8);
          blend(f, px2 + i, py2 + j, rgba(92, 92, 98, 255), pow(1 - d, 1.7) * (0.08 + n * 0.16) * (1 - t * 0.5));
        }
      }
    }
  }

  // --- haze pooled at the base: the thing that makes it read as distance ---
  for (let y = GROUND - 17; y < CH; y++) {
    const k = smoothstep(GROUND - 17, GROUND + 5, y);
    for (let x = 0; x < CW; x++) {
      const n = fbm(seed + 5, x / 22, y / 8, 3, 8);
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
