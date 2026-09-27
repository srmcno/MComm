// characters.js - the cast: Brick Hardigan's HUD status face (64x72) and the
// two radio portraits (Brick, Dr. Ilsa Vance, 128x128). Pure math into
// Uint32Arrays like the rest of the art; no DOM, no canvas API, no assets.
//
// HOW THIS FILE WORKS
// -------------------
// Every character is sculpted, not drawn. A "studio" is a relief canvas: each
// pixel holds a height, a material id, an albedo, gloss and emission. Painters
// add ellipsoids, rounded boxes, capsules and free-form fields in MODEL space
// (the 128-unit portrait space) and a per-studio transform maps that onto the
// canvas, so one Brick model serves both the full-frame portrait and the tight
// HUD crop, and a head can roll or turn without redrawing it.
//
// The render pass then does what makes it read as a painting instead of a
// plastic toy: normals from the height gradient, cavity occlusion from a
// blurred copy of the heights (eye sockets, the gap under a flat-top, the
// inside of a mouth all darken on their own), screen-space cast shadows (the
// shades shadow the cheeks, the cigar shadows the chin), warm subsurface light
// in the skin's terminator, a hot rim light from the burning bunker on one
// side and a cool one on the other. Everything is supersampled 1.5x and
// filtered down, then sharpened, so small features stay crisp at HUD size.
//
// Determinism: every bit of noise comes from hash2/fbm with fixed seeds.

import { rgba, clamp, lerp, makeFrame, outline } from '../core/pixels.js';

const PI = Math.PI, TAU = PI * 2;
const sin = Math.sin, cos = Math.cos, abs = Math.abs, sqrt = Math.sqrt;
const floor = Math.floor, ceil = Math.ceil, min = Math.min, max = Math.max;
const pow = Math.pow, atan2 = Math.atan2, exp = Math.exp;

function hash2(x, y, s = 0) {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263 + (s | 0) * 1442695041;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise on the integer lattice; no period, so nothing repeats across a face. */
function vnoise(seed, x, y) {
  const xi = floor(x), yi = floor(y);
  let xf = x - xi, yf = y - yi;
  xf = xf * xf * (3 - 2 * xf); yf = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  const top = a + (b - a) * xf;
  return top + (c + (d - c) * xf - top) * yf;
}

/** Octaves of vnoise, 0..1. Same call shape as pixels.fbm minus the period. */
function fbm(seed, x, y, oct = 3) {
  let sum = 0, amp = 0.5, tot = 0;
  for (let o = 0; o < oct; o++) {
    sum += amp * vnoise(seed + o * 977, x, y);
    tot += amp; amp *= 0.5; x *= 2; y *= 2;
  }
  return sum / tot;
}

function smoothstep(a, b, t) {
  const x = clamp((t - a) / (b - a || 1e-6), 0, 1);
  return x * x * (3 - 2 * x);
}

// Working colours are packed WITHOUT alpha (0x00BBGGRR). With the alpha byte
// set, every colour is a uint32 above 2^31, which V8 cannot keep as a small
// integer: each mix would allocate a heap number, and a face mixes colours
// hundreds of thousands of times. Alpha is added once, on the way out.
function rgb(r, g, b) { return (r & 255) | (g & 255) << 8 | (b & 255) << 16; }
const hyp = (x, y) => sqrt(x * x + y * y);   // Math.hypot is not inlined and boxes its result

// packed-colour helpers that clamp (pixels.shade() wraps above 1.0)
const cR = (c) => c & 255, cG = (c) => (c >>> 8) & 255, cB = (c) => (c >>> 16) & 255;
function mixc(a, b, t) {
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return rgb(cR(a) + (cR(b) - cR(a)) * t, cG(a) + (cG(b) - cG(a)) * t, cB(a) + (cB(b) - cB(a)) * t);
}
function shadec(c, s) {
  return rgb(min(255, cR(c) * s), min(255, cG(c) * s), min(255, cB(c) * s));
}

// ---------------------------------------------------------------------------
// materials
// ---------------------------------------------------------------------------
// gl: specular strength, pw: tightness, sss: warm terminator glow (skin),
// env: mirror reflection of the room, rim: how much rim light it catches.

const M_SKIN = 1, M_HAIR = 2, M_LENS = 3, M_CLOTH = 4, M_METAL = 5, M_CIGAR = 6;
const M_TEETH = 7, M_MOUTH = 8, M_EYE = 9, M_PLASTIC = 10, M_TONGUE = 11;
const M_EMBER = 12, M_LEATHER = 13, M_PLASTER = 14, M_ASH = 15;

const MATS = [];
function mat(id, gl, pw, sss = 0, env = 0, rim = 1) { MATS[id] = { gl, pw, sss, env, rim }; }
mat(0, 0, 1);
mat(M_SKIN, 0.30, 16, 1, 0, 1);
mat(M_HAIR, 0.20, 9, 0, 0, 1.1);
mat(M_LENS, 0.95, 70, 0, 1, 0.8);
mat(M_CLOTH, 0.05, 4, 0, 0, 0.8);
mat(M_METAL, 0.80, 40, 0, 0.55, 1);
mat(M_CIGAR, 0.16, 10, 0.25, 0, 1);
mat(M_TEETH, 0.45, 26, 0.3, 0, 0.5);
mat(M_MOUTH, 0.35, 20, 0.6, 0, 0.2);
mat(M_EYE, 0.85, 60, 0, 0.15, 0.4);
mat(M_PLASTIC, 0.40, 22, 0, 0.12, 1);
mat(M_TONGUE, 0.60, 24, 0.8, 0, 0.4);
mat(M_EMBER, 0, 1, 0, 0, 0);
mat(M_LEATHER, 0.30, 14, 0, 0, 1);
mat(M_PLASTER, 0.10, 6, 0.2, 0, 0.8);
mat(M_ASH, 0.05, 4, 0, 0, 0.6);

// ---------------------------------------------------------------------------
// the studio: a relief canvas with a model transform
// ---------------------------------------------------------------------------

// Studios are built one after another, so their buffers are pooled by size:
// thirty-odd faces and portraits would otherwise churn through ~30 MB of
// typed arrays at boot and hand the collector a lot of work for nothing.
// releaseStudios() drops the pool once the cast is painted.
const POOL = new Map();

/** Let the pooled studio buffers go (a couple of MB) once nothing more will be painted. */
export function releaseStudios() { POOL.clear(); TURN.key = ''; TURN.S = null; }

/**
 * w,h canvas pixels; k canvas px per model unit; (ox,oy) canvas position of
 * model (0,0). A roll (setRoll) rotates model space about a pivot, used for a
 * head knocked sideways without re-authoring it.
 */
function makeStudio(w, h, k, ox, oy, slot = 0) {
  const n = w * h;
  let B = POOL.get(n * 4 + slot);
  if (!B) {
    B = {
      z: new Float32Array(n), m: new Uint8Array(n), col: new Uint32Array(n),
      gl: new Float32Array(n), em: new Float32Array(n), t0: new Float32Array(n), t1: new Float32Array(n),
    };
    POOL.set(n * 4 + slot, B);
  } else {
    B.z.fill(0); B.m.fill(0); B.col.fill(0); B.gl.fill(0); B.em.fill(0);
  }
  return {
    w, h, k, ox, oy, cr: 1, sr: 0, px: 64, py: 64, dx: 0, dy: 0, zo: 0, sc: 1,
    z: B.z, m: B.m, col: B.col, gl: B.gl, em: B.em, t0: B.t0, t1: B.t1,
  };
}

/**
 * Rotate everything painted from now on by `ang` about model (px,py), then
 * shift by (dx,dy). `zo` lifts absolute heights: the head floats a little in
 * front of the neck so the jaw casts its shadow instead of sinking into it.
 */
function setRoll(S, ang = 0, px = 64, py = 64, dx = 0, dy = 0, zo = 0, sc = 1) {
  S.cr = cos(ang) * sc; S.sr = sin(ang) * sc; S.px = px; S.py = py; S.dx = dx; S.dy = dy; S.zo = zo; S.sc = sc;
}

function toCanvasX(S, mx, my) {
  const ux = mx - S.px, uy = my - S.py;
  return S.ox + (S.px + ux * S.cr - uy * S.sr + S.dx) * S.k;
}
function toCanvasY(S, mx, my) {
  const ux = mx - S.px, uy = my - S.py;
  return S.oy + (S.py + ux * S.sr + uy * S.cr + S.dy) * S.k;
}

/**
 * Visit every canvas pixel whose centre maps inside the model-space box. The
 * pixel's model coordinates travel in FP rather than as arguments: a dozen
 * different callbacks make this call site megamorphic, and V8 would box two
 * fresh doubles for every pixel of every primitive otherwise.
 */
const FP = new Float64Array(5);
const LS = new Float64Array(2);   // the shades' local frame, see brickShades
function forPix(S, mx0, my0, mx1, my1, fn) {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (let c = 0; c < 4; c++) {
    const mx = c & 1 ? mx1 : mx0, my = c & 2 ? my1 : my0;
    const X = toCanvasX(S, mx, my), Y = toCanvasY(S, mx, my);
    if (X < x0) x0 = X; if (X > x1) x1 = X; if (Y < y0) y0 = Y; if (Y > y1) y1 = Y;
  }
  x0 = max(0, floor(x0) - 1); y0 = max(0, floor(y0) - 1);
  x1 = min(S.w - 1, ceil(x1) + 1); y1 = min(S.h - 1, ceil(y1) + 1);
  const ik = 1 / S.k, isc2 = 1 / (S.sc * S.sc);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      // canvas -> model (inverse roll)
      const rx = (x + 0.5 - S.ox) * ik - S.dx - S.px, ry = (y + 0.5 - S.oy) * ik - S.dy - S.py;
      const mx = S.px + (rx * S.cr + ry * S.sr) * isc2;
      const my = S.py + (-rx * S.sr + ry * S.cr) * isc2;
      FP[0] = mx; FP[1] = my;
      fn(y * S.w + x);
    }
  }
}

function matches(only, m) {
  if (!only) return true;
  if (typeof only === 'number') return m === only;
  return only.indexOf(m) >= 0;
}

/**
 * Write one relief sample. mode 'max' unions (higher surface wins), 'over'
 * replaces, 'lift' raises the existing surface by h and repaints it (an eye
 * set into a socket, a plaster stuck on a nose), 'add' only nudges height.
 */
function writePx(S, i, id, c, mode, only, shader) {
  let hgt = FP[4];
  const m0 = S.m[i];
  if (mode === 'add') {
    if (!m0 || !matches(only, m0)) return;
    S.z[i] += hgt; return;
  }
  if (only && (!m0 || !matches(only, m0))) return;
  if (mode === 'lift') {
    if (!m0) return;
    S.z[i] += hgt;
  } else if (mode === 'max') {
    hgt += S.zo * S.k;
    if (m0 && hgt <= S.z[i]) return;
    S.z[i] = hgt;
  } else {
    S.z[i] = hgt + S.zo * S.k;
  }
  if (id) {
    S.m[i] = id; S.gl[i] = MATS[id].gl; S.em[i] = id === M_EMBER ? 1 : 0;
  }
  if (shader) c = shader();
  if (c) S.col[i] = c;
}

/**
 * Ellipsoid cap. o.rot rotates it, o.taper narrows it toward its bottom,
 * o.sq squares it off (a jaw), o.base lifts the whole cap, o.shader(mx,my,u,v)
 * supplies albedo per pixel.
 */
function ell(S, cx, cy, rx, ry, amp, id, col, o = {}) {
  const { rot = 0, taper = 0, sq = 0, base = 0, mode = 'max', only = 0, shader = null, p = 0 } = o;
  const cr = cos(rot), sr = sin(rot);
  const Rx = (rot ? max(rx * (1 + max(0, -taper)), ry) : rx * (1 + max(0, -taper))) + 1;
  const Ry = (rot ? Rx - 1 : ry) + 1;
  const e = 2 + sq * 4, k = S.k;
  forPix(S, cx - Rx, cy - Ry, cx + Rx, cy + Ry, (i) => {
    const mx = FP[0], my = FP[1];
    const lx = mx - cx, ly = my - cy;
    const ux0 = lx * cr + ly * sr, uy = -lx * sr + ly * cr;
    const v = uy / ry;
    const rr = rx * (1 - taper * (v > 0 ? v * v : 0));
    const u = ux0 / rr;
    let d;
    if (sq > 0) {
      const de = pow(abs(u), e) + pow(abs(v), e);
      if (de >= 1) return;
      d = pow(de, 1 / e);
    } else {
      const d2 = u * u + v * v;
      if (d2 >= 1) return;
      d = sqrt(d2);
    }
    const prof = p ? pow(1 - d, p) : sqrt(1 - d * d);
    const hgt = (prof * amp + base) * k;
    FP[2] = u; FP[3] = v; FP[4] = hgt;
    writePx(S, i, id, col, mode, only, shader);
  });
}

/** Additive soft bump restricted to materials: brow ridges, cheekbones, lumps. */
function bump(S, cx, cy, rx, ry, amp, o = {}) {
  const { p = 1.6, only = 0, rot = 0 } = o;
  const cr = cos(rot), sr = sin(rot);
  const Rx = (rot ? max(rx, ry) : rx) + 1, Ry = (rot ? max(rx, ry) : ry) + 1, k = S.k;
  forPix(S, cx - Rx, cy - Ry, cx + Rx, cy + Ry, (i) => {
    const mx = FP[0], my = FP[1];
    if (!S.m[i] || !matches(only, S.m[i])) return;
    const lx = mx - cx, ly = my - cy;
    const u = (lx * cr + ly * sr) / rx, v = (-lx * sr + ly * cr) / ry;
    const d = sqrt(u * u + v * v);
    if (d >= 1) return;
    S.z[i] += pow(1 - d, p) * amp * k;
  });
}

/** Rounded box, domed a little. Flat-tops, plasters, collar tabs. */
function box(S, x0, y0, x1, y1, amp, id, col, o = {}) {
  const { round = 3, dome = 0.25, base = 0, mode = 'max', only = 0, shader = null, domeX = -1, domeY = -1 } = o;
  const dx = domeX < 0 ? dome : domeX, dy = domeY < 0 ? dome : domeY;
  const k = S.k;
  forPix(S, x0, y0, x1, y1, (i) => {
    const mx = FP[0], my = FP[1];
    const ex = min(mx - x0, x1 - mx), ey = min(my - y0, y1 - my);
    if (ex < 0 || ey < 0) return;
    let edge = 1;
    if (ex < round && ey < round) {
      const ox = round - ex, oy = round - ey;
      const d = sqrt(ox * ox + oy * oy);
      if (d > round) return;
      edge = sqrt(max(0, 1 - pow(d / round, 2)));
    } else if (ex < round) edge = sqrt(max(0, 1 - pow(1 - ex / round, 2)));
    else if (ey < round) edge = sqrt(max(0, 1 - pow(1 - ey / round, 2)));
    const u = ((mx - x0) / max(1e-3, x1 - x0)) * 2 - 1;
    const v = ((my - y0) / max(1e-3, y1 - y0)) * 2 - 1;
    const hgt = (amp * (1 - dx * u * u * 0.5 - dy * v * v * 0.5) * (0.35 + 0.65 * edge) + base) * k;
    FP[2] = u; FP[3] = v; FP[4] = hgt;
    writePx(S, i, id, col, mode, only, shader);
  });
}

/**
 * Capsule: a round tube between two points, radius r0 -> r1, riding at height
 * `base`. The cigar, glasses arms, straps, braids and the boom mic.
 */
function cap(S, x0, y0, x1, y1, r0, r1, base, id, col, o = {}) {
  const { mode = 'max', only = 0, shader = null, zk = 1 } = o;
  const ddx = x1 - x0, ddy = y1 - y0;
  const len2 = ddx * ddx + ddy * ddy || 1e-6;
  const len = sqrt(len2);
  const pxn = -ddy / len, pyn = ddx / len;
  const R = max(r0, r1) + 1, k = S.k;
  forPix(S, min(x0, x1) - R, min(y0, y1) - R, max(x0, x1) + R, max(y0, y1) + R, (i) => {
    const mx = FP[0], my = FP[1];
    const vx = mx - x0, vy = my - y0;
    const t = (vx * ddx + vy * ddy) / len2;
    const tc = t < 0 ? 0 : t > 1 ? 1 : t;
    const ox = mx - (x0 + ddx * tc), oy = my - (y0 + ddy * tc);
    const d = sqrt(ox * ox + oy * oy);
    const rr = r0 + (r1 - r0) * tc;
    if (d >= rr) return;
    const hgt = (base + sqrt(1 - (d / rr) * (d / rr)) * rr * zk) * k;
    const u = (ox * pxn + oy * pyn) / rr;
    FP[2] = tc; FP[3] = u; FP[4] = hgt;
    writePx(S, i, id, col, mode, only, shader);
  });
}

/**
 * Free-form sculpt: fn(mx,my) returns a height in model units, or a negative
 * number for "not here". Lenses, mouths, the braid.
 */
function sculpt(S, x0, y0, x1, y1, id, fn, shader, o = {}) {
  const { mode = 'max', only = 0 } = o;
  const k = S.k;
  forPix(S, x0, y0, x1, y1, (i) => {
    const hgt = fn();
    if (!(hgt >= 0)) return;
    FP[4] = hgt * k;
    writePx(S, i, id, 0, mode, only, shader);
  });
}

/**
 * Soft round brush in albedo (and optionally height, gloss, glow). The
 * painterly layer: stubble, blood, bruises, lens flares, cuts.
 */
function dab(S, x, y, r, c, a = 1, o = {}) {
  const { hard = 0.35, only = 0, dz = 0, gl = -1, em = 0, sx = 1, sy = 1, rot = 0, not = 0 } = o;
  const cr = cos(rot), sr = sin(rot);
  const R = r * max(sx, sy), k = S.k;
  const cr0 = cR(c), cg0 = cG(c), cb0 = cB(c);
  // straight in canvas space: this is the hottest painter by call count
  const cx = toCanvasX(S, x, y), cy = toCanvasY(S, x, y);
  const Rc = R * k * S.sc + 1;
  const x0 = max(0, floor(cx - Rc)), x1 = min(S.w - 1, ceil(cx + Rc));
  const y0 = max(0, floor(cy - Rc)), y1 = min(S.h - 1, ceil(cy + Rc));
  const ik = 1 / k, isc2 = 1 / (S.sc * S.sc);
  const irx = 1 / (r * sx), iry = 1 / (r * sy);
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      const i = py * S.w + px;
      const m0 = S.m[i];
      if (!m0) continue;
      if (only && !matches(only, m0)) continue;
      if (not && matches(not, m0)) continue;
      const dxc = (px + 0.5 - cx) * ik, dyc = (py + 0.5 - cy) * ik;
      const lx = (dxc * S.cr + dyc * S.sr) * isc2, ly = (-dxc * S.sr + dyc * S.cr) * isc2;
      const u = (lx * cr + ly * sr) * irx, v = (-lx * sr + ly * cr) * iry;
      const d2 = u * u + v * v;
      if (d2 >= 1) continue;
      const d = sqrt(d2);
      const f = a * (d <= hard ? 1 : 1 - smoothstep(hard, 1, d));
      if (f <= 0.003) continue;
      const o0 = S.col[i];
      S.col[i] = rgb(cR(o0) + (cr0 - cR(o0)) * f, cG(o0) + (cg0 - cG(o0)) * f, cB(o0) + (cb0 - cB(o0)) * f);
      if (dz) S.z[i] += dz * f * k;
      if (gl >= 0) S.gl[i] += (gl - S.gl[i]) * f;
      if (em) S.em[i] = max(S.em[i], em * f);
    }
  }
}

/** A brush stroke: dabs along a polyline, radius r0 -> r1 from end to end. */
function stroke(S, pts, r0, r1, c, a = 1, o = {}) {
  let total = 0;
  for (let j = 1; j < pts.length; j++) total += hyp(pts[j][0] - pts[j - 1][0], pts[j][1] - pts[j - 1][1]);
  if (total <= 0) { dab(S, pts[0][0], pts[0][1], r0, c, a, o); return; }
  let acc = 0;
  for (let j = 1; j < pts.length; j++) {
    const ax = pts[j - 1][0], ay = pts[j - 1][1], bx = pts[j][0], by = pts[j][1];
    const L = hyp(bx - ax, by - ay);
    const r = max(r0, r1);
    const step = max(0.6 / (S.k * S.sc), min(r0, r1) * 0.45);
    for (let s = 0; s <= L; s += step) {
      const t = (acc + s) / total;
      dab(S, ax + (bx - ax) * (s / (L || 1)), ay + (by - ay) * (s / (L || 1)), lerp(r0, r1, t), c,
        a * (o.fade ? 1 - t * o.fade : 1), o);
    }
    acc += L;
    if (r <= 0) break;
  }
}

/** Sample a curve fn(t) -> [x,y] into a polyline for stroke(). */
function curve(fn, n = 12) {
  const pts = [];
  for (let j = 0; j <= n; j++) pts.push(fn(j / n));
  return pts;
}

// ---------------------------------------------------------------------------
// render: relief -> lit pixels
// ---------------------------------------------------------------------------

function norm3(x, y, z) {
  const l = sqrt(x * x + y * y + z * z) || 1;
  return [x / l, y / l, z / l];
}

/** Separable box blur of the height field; empty pixels count as ground. */
function blurHeights(S, r) {
  const { w, h } = S;
  const tmp = S.t0, out = S.t1;
  const inv = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    let acc = 0;
    const row = y * w;
    for (let x = -r; x <= r; x++) acc += S.z[row + clamp(x, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc * inv;
      acc += S.z[row + min(w - 1, x + r + 1)] - S.z[row + max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[clamp(y, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc * inv;
      acc += tmp[min(h - 1, y + r + 1) * w + x] - tmp[max(0, y - r) * w + x];
    }
  }
  return out;
}

/**
 * Light rig. All directions point TOWARD the light, image space (+y down,
 * +z toward the viewer). Rims are screen-plane directions.
 */
const RIG_BRICK = {
  key: norm3(-0.64, -0.52, 0.58), keyCol: [1.16, 1.0, 0.82],
  sky: [0.30, 0.33, 0.48], ground: [0.24, 0.15, 0.13], fillK: 1.0,
  rims: [
    { dir: [0.92, -0.25], col: [1.25, 0.56, 0.22], k: 1.25, p: 2.2 },   // the bunker is on fire behind him
    { dir: [-0.95, -0.1], col: [0.34, 0.52, 0.95], k: 0.55, p: 2.6 },  // cool monitor bounce
  ],
  sssCol: [1.0, 0.30, 0.16], env: [[70, 90, 130], [255, 196, 140]],
  shadowLen: 12, shadowK: 0.45, aoR: 4, aoK: 0.10, ns: 1.05, exposure: 1.04,
};

const RIG_ILSA = {
  key: norm3(-0.40, -0.66, 0.64), keyCol: [0.98, 1.00, 1.02],
  sky: [0.36, 0.44, 0.50], ground: [0.18, 0.20, 0.20], fillK: 1.0,
  rims: [
    { dir: [0.95, -0.2], col: [0.40, 0.95, 0.80], k: 0.95, p: 2.4 },   // console glow
    { dir: [-0.9, -0.3], col: [0.70, 0.78, 1.0], k: 0.45, p: 2.6 },
  ],
  sssCol: [1.0, 0.36, 0.26], env: [[80, 100, 110], [200, 230, 220]],
  shadowLen: 7, shadowK: 0.42, aoR: 4, aoK: 0.12, ns: 1.0, exposure: 0.98,
};

function render(S, rig) {
  const { w, h, z, m } = S;
  const k = S.k;
  const out = makeFrame(w, h);
  const zb = blurHeights(S, max(1, Math.round(rig.aoR * k)));
  const L = rig.key;
  const H = norm3(L[0], L[1], L[2] + 1);
  const ll = hyp(L[0], L[1]) || 1;
  const stepX = L[0] / ll, stepY = L[1] / ll, rise = L[2] / ll;
  const maxT = rig.shadowLen * k;
  const ns = rig.ns;
  const gmax = 2.4;
  let zMax = 0;
  for (let i = 0; i < w * h; i++) if (m[i] && z[i] > zMax) zMax = z[i];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const id = m[i];
      if (!id) continue;
      const M = MATS[id];
      const z0 = z[i];
      // --- normal from the height gradient, clamped so cliffs become bevels ---
      const zl = x > 0 && m[i - 1] ? z[i - 1] : z0 * 0.6;
      const zr = x < w - 1 && m[i + 1] ? z[i + 1] : z0 * 0.6;
      const zu = y > 0 && m[i - w] ? z[i - w] : z0 * 0.6;
      const zd = y < h - 1 && m[i + w] ? z[i + w] : z0 * 0.6;
      let gx = clamp((zr - zl) * 0.5 / k, -gmax, gmax) * ns;
      let gy = clamp((zd - zu) * 0.5 / k, -gmax, gmax) * ns;
      let nl = sqrt(gx * gx + gy * gy + 1);
      const nx = -gx / nl, ny = -gy / nl, nz = 1 / nl;
      // --- cavity occlusion ---
      const cav = max(0, zb[i] - z0) / k;
      const ao = 1 - min(0.72, cav * rig.aoK);
      // --- cast shadow: march toward the light across the relief ---
      let sh = 0;
      const reach = min(maxT, (zMax - z0) / max(0.05, rise));
      for (let t = 1.5; t < reach; t += 1.5) {
        const sx = (x + stepX * t) | 0, sy = (y + stepY * t) | 0;
        if (sx < 0 || sy < 0 || sx >= w || sy >= h) break;
        const j = sy * w + sx;
        if (!m[j]) continue;
        const over = z[j] - (z0 + t * rise);
        if (over > 0) { sh = max(sh, min(1, over / (2.5 * k))); if (sh >= 1) break; }
      }
      const lit = 1 - sh * rig.shadowK;
      // --- diffuse ---
      const ndl = nx * L[0] + ny * L[1] + nz * L[2];
      const wrap = max(0, (ndl + 0.18) / 1.18);
      const diff = wrap * sqrt(sqrt(wrap)) * lit;
      const up = clamp(-ny * 0.5 + 0.5, 0, 1);
      const fr = lerp(rig.ground[0], rig.sky[0], up) * rig.fillK * ao;
      const fg = lerp(rig.ground[1], rig.sky[1], up) * rig.fillK * ao;
      const fb = lerp(rig.ground[2], rig.sky[2], up) * rig.fillK * ao;
      const aoD = 0.35 + 0.65 * ao;
      let lr = fr + diff * rig.keyCol[0] * aoD;
      let lg = fg + diff * rig.keyCol[1] * aoD;
      let lb = fb + diff * rig.keyCol[2] * aoD;
      // warm light scattering under the skin, strongest at the terminator
      if (M.sss) {
        const term = max(0, 1 - abs(ndl - 0.05) * 2.6) * M.sss * 0.30 * aoD;
        lr += term * rig.sssCol[0]; lg += term * rig.sssCol[1]; lb += term * rig.sssCol[2];
      }
      const a = S.col[i];
      const ar = cR(a), ag = cG(a), ab = cB(a);
      let r = ar * lr, g = ag * lg, b = ab * lb;
      // --- rim lights ---
      const edge = 1 - nz;
      for (let q = 0; q < rig.rims.length; q++) {
        const rl = rig.rims[q];
        const dd = nx * rl.dir[0] + ny * rl.dir[1];
        if (dd <= 0) continue;
        const amt = edge * dd * sqrt(dd) * rl.k * M.rim * (0.4 + 0.6 * ao);
        r += amt * rl.col[0] * (60 + ar * 0.7);
        g += amt * rl.col[1] * (60 + ag * 0.7);
        b += amt * rl.col[2] * (60 + ab * 0.7);
      }
      // --- mirror reflection (lenses, chrome) ---
      const gl = S.gl[i];
      if (M.env) {
        const e = M.env * (0.25 + 0.75 * pow(up, 1.6));
        r += lerp(rig.env[0][0], rig.env[1][0], up) * e * 0.5;
        g += lerp(rig.env[0][1], rig.env[1][1], up) * e * 0.5;
        b += lerp(rig.env[0][2], rig.env[1][2], up) * e * 0.5;
      }
      // --- key specular ---
      if (gl > 0.01) {
        const sd = nx * H[0] + ny * H[1] + nz * H[2];
        if (sd > 0.6) {
          const sp = pow(sd, M.pw) * gl * 190 * lit * aoD;
          r += sp * rig.keyCol[0]; g += sp * rig.keyCol[1]; b += sp * rig.keyCol[2];
        }
      }
      // --- emission ---
      const em = S.em[i];
      if (em > 0.001) {
        r = lerp(r, ar * 1.25 + 30, em); g = lerp(g, ag * 1.25 + 10, em); b = lerp(b, ab * 1.25, em);
      }
      const ex = rig.exposure;
      out.data[i] = rgba(min(255, r * ex), min(255, g * ex), min(255, b * ex), 255);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// post: filter down, sharpen, grade
// ---------------------------------------------------------------------------

/**
 * Area-weighted box filter down to (ow, oh), for ratios that are not whole
 * numbers. A pixel survives if at least half of what it covers was painted.
 */
function downsampleTo(f, ow, oh) {
  const o = makeFrame(ow, oh);
  const sx = f.w / ow, sy = f.h / oh;
  for (let y = 0; y < oh; y++) {
    const y0 = y * sy, y1 = y0 + sy;
    for (let x = 0; x < ow; x++) {
      const x0 = x * sx, x1 = x0 + sx;
      let r = 0, g = 0, b = 0, wsum = 0, cov = 0;
      for (let j = floor(y0); j < y1; j++) {
        const wy = min(y1, j + 1) - max(y0, j);
        for (let i = floor(x0); i < x1; i++) {
          const w = (min(x1, i + 1) - max(x0, i)) * wy;
          cov += w;
          const c = f.data[j * f.w + i];
          if (!(c >>> 24)) continue;
          r += (c & 255) * w; g += ((c >>> 8) & 255) * w; b += ((c >>> 16) & 255) * w; wsum += w;
        }
      }
      if (wsum >= cov * 0.5) o.data[y * ow + x] = rgba(r / wsum, g / wsum, b / wsum, 255);
    }
  }
  return o;
}

function sCurve(v, contrast) {
  v = clamp(v, 0, 255) / 255;
  const s = v * v * (3 - 2 * v);
  return clamp((v + (s - v) * contrast * 2) * 255, 0, 255);
}

/**
 * Unsharp mask inside the figure plus a gentle contrast S-curve and a touch of
 * saturation: the "painted cover art" push.
 */
function grade(f, sharp = 0.5, contrast = 0.12, sat = 1.08) {
  const { w, h } = f;
  const src = f.data.slice();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const c = src[i];
      if (!(c >>> 24)) continue;
      let r = c & 255, g = (c >>> 8) & 255, b = (c >>> 16) & 255;
      if (sharp > 0) {
        let sr = 0, sg = 0, sb = 0, n = 0;
        for (let q = 0; q < 4; q++) {
          const j = q === 0 ? i - 1 : q === 1 ? i + 1 : q === 2 ? i - w : i + w;
          if (j < 0 || j >= src.length) continue;
          const d = src[j];
          if (!(d >>> 24)) continue;
          sr += d & 255; sg += (d >>> 8) & 255; sb += (d >>> 16) & 255; n++;
        }
        if (n) { r += (r - sr / n) * sharp; g += (g - sg / n) * sharp; b += (b - sb / n) * sharp; }
      }
      const lum = r * 0.3 + g * 0.59 + b * 0.11;
      r = lum + (r - lum) * sat; g = lum + (g - lum) * sat; b = lum + (b - lum) * sat;
      f.data[i] = rgba(sCurve(r, contrast), sCurve(g, contrast), sCurve(b, contrast), 255);
    }
  }
  return f;
}

/** Source-over a straight-alpha colour into a frame (smoke, glints). */
function blendPx(f, x, y, c, a) {
  x |= 0; y |= 0;
  if (x < 0 || y < 0 || x >= f.w || y >= f.h || a <= 0.004) return;
  if (a > 1) a = 1;
  const i = y * f.w + x, d = f.data[i];
  const da = (d >>> 24) / 255;
  const oa = a + da * (1 - a);
  const k = a / oa, kd = da * (1 - a) / oa;
  f.data[i] = rgba(cR(c) * k + cR(d) * kd, cG(c) * k + cG(d) * kd, cB(c) * k + cB(d) * kd, oa * 255);
}

/**
 * Cigar smoke: a ribbon that rises and curls, soft-edged, thinning out. Drawn
 * after filtering so it stays translucent over the figure and the void alike.
 */
function smokeWisp(f, x0, y0, len, seed, o = {}) {
  const { drift = 0.35, width = 1.6, alpha = 0.34, minX = 0, maxX = f.w - 1, minY = 6 } = o;
  let x = x0, y = y0;
  for (let s = 0; s < len; s += 0.5) {
    const t = s / len;
    const wob = sin(s * 0.21 + seed) * (1.5 + t * 5) + fbm(seed, s / 9, 0.5, 2) * 4 - 2;
    const px = x + wob + s * drift * 0.2, py = y - s;
    const rad = width * (0.7 + t * 2.2);
    const a = alpha * (t < 0.08 ? t / 0.08 : 1) * pow(1 - t, 1.3);
    if (py < minY) break;
    for (let j = -ceil(rad); j <= ceil(rad); j++) {
      for (let i = -ceil(rad); i <= ceil(rad); i++) {
        const d = hyp(i, j) / rad;
        if (d >= 1) continue;
        const X = px + i;
        if (X < minX || X > maxX) continue;
        const n = hash2((X | 0), ((py + j) | 0), seed);
        blendPx(f, X, py + j, rgb(208 + n * 30, 204 + n * 30, 196 + n * 30), a * (1 - d) * 0.35);
      }
    }
  }
}

/**
 * The CRT treatment. Ilsa is not in the room; she is a transmission.
 * Scanlines, a green-phosphor cast and a horizontal bloom, confined to the
 * figure so the surround stays transparent.
 */
function crtPass(f, seed) {
  const { w, h, data } = f;
  const src = data.slice();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!(src[i] >>> 24)) continue;
      let r = src[i] & 255, g = (src[i] >>> 8) & 255, b = (src[i] >>> 16) & 255;
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
      const lum = (r * 0.3 + g * 0.6 + b * 0.1);
      r = lerp(r, lum * 0.88, 0.09) * 1.04;
      g = lerp(g, lum * 1.08, 0.09) * 1.06 + 3;
      b = lerp(b, lum * 0.92, 0.09) * 1.02;
      const scan = (y & 1) ? 0.95 : 1.02;
      const band = 1 + 0.04 * sin((y + (seed % 17)) * 0.10);
      const jitter = ((y % 5) === 0) ? 1.03 : 1;
      const k2 = scan * band * jitter;
      data[i] = rgba(clamp(r * k2, 0, 255), clamp(g * k2, 0, 255), clamp(b * k2, 0, 255), 255);
    }
  }
  return f;
}

// ---------------------------------------------------------------------------
// BRICK HARDIGAN
// ---------------------------------------------------------------------------
// One sculpt, parameterised: head turn (yaw), roll, brows, eyes, the shades
// (on, down the nose, knocked askew, pushed up, dangling off an ear), the
// mouth, the cigar and a damage kit (cuts, bruises, a black eye, nosebleed,
// missing teeth, plasters, a lump, a singed flat-top, sweat). The HUD face and
// the radio portrait are the same man lit by the same rig.

const BR = {
  skin: rgb(204, 144, 104), lit: rgb(238, 186, 140), sh: rgb(150, 90, 66), deep: rgb(92, 50, 40),
  flush: rgb(226, 104, 80), pale: rgb(196, 170, 150),
  stubble: rgb(92, 88, 104),
  hair: rgb(244, 206, 104), hairMid: rgb(204, 158, 64), hairRoot: rgb(116, 80, 36),
  brow: rgb(92, 60, 26), lash: rgb(58, 36, 28),
  lip: rgb(176, 100, 84), lipLit: rgb(206, 132, 112),
  frame: rgb(26, 26, 32),
  tank: rgb(226, 220, 204), tankSh: rgb(170, 160, 142), grime: rgb(150, 128, 96),
  leather: rgb(96, 58, 32), leatherD: rgb(58, 34, 20),
  cigar: rgb(124, 76, 42), cigarD: rgb(76, 44, 24), band: rgb(178, 28, 32), gold: rgb(226, 180, 72),
  ash: rgb(150, 146, 140),
  blood: rgb(170, 18, 20), bloodD: rgb(96, 6, 10), bruise: rgb(98, 52, 108), bruiseY: rgb(156, 150, 74),
  plaster: rgb(226, 190, 146), plasterD: rgb(186, 148, 108),
  teeth: rgb(236, 228, 206), mouth: rgb(70, 18, 20), tongue: rgb(206, 88, 96),
  sclera: rgb(238, 230, 218), iris: rgb(86, 150, 204),
};

/** The shades' lens outline in their own space (x across, 0 = bridge; y down, 0 = centre line). */
function lensTop(x) { const a = abs(x) / 30; return -6.6 - 1.6 * a * a * a * a; }
function lensBot(x) {
  const a = abs(x);
  return 7.0 - 2.6 * pow((a - 16) / 14, 2) - 7.4 * exp(-(x * x) / 13);
}

/**
 * Mouth. A mouth is a line that can open: corners lifted by `smile`, one side
 * hitched by `skew`, the gap filled with teeth, tongue and dark. Returns the
 * cigar anchor (the image-right corner).
 */
function brickMouth(S, cx, cy, Q, C = BR) {
  const w = Q.w, hw = w / 2;
  const open = Q.open || 0, smile = Q.smile || 0, skew = Q.skew || 0;
  const sqr = Q.square ? 0.35 : 0.75;
  const gaps = Q.gaps || [];
  const lift = (u) => smile * u * u * 6 + skew * u * 3;
  const op = (u) => open * pow(max(0, 1 - u * u), sqr);
  const yU = (u) => cy - lift(u) - op(u) * 0.30;
  const yL = (u) => cy - lift(u) + op(u) * 0.70;
  const k = S.k;
  // lips and the fold of flesh around them, so the mouth sits IN a face
  bump(S, cx, cy + 3 + open * 0.5, hw * 0.8, 3 + open * 0.2, 1.0, { only: M_SKIN });
  bump(S, cx, cy - 2, hw * 0.8, 2.2, 0.6, { only: M_SKIN });
  // cheeks bunch up when the corners go up
  if (smile > 0.3) {
    for (const sx of [-1, 1]) bump(S, cx + sx * (hw + 2), cy - 6 - smile * 2, 8, 6, 2.6 * smile, { only: M_SKIN });
  }
  if (open > 0.6) {
    const th = Q.clench ? 99 : Q.teethU === undefined ? min(4.4, open * 0.42) : Q.teethU * min(4.6, open * 0.46);
    const tl = Q.clench ? 99 : (Q.teethL || 0) * min(3.6, open * 0.36);
    forPix(S, cx - hw - 1, cy - 12 - open, cx + hw + 1, cy + open + 4, (i) => {
      const mx = FP[0], my = FP[1];
      if (S.m[i] !== M_SKIN) return;
      const u = (mx - cx) / hw;
      if (u <= -1 || u >= 1) return;
      // the lip curves, inline: this runs for every pixel of the mouth box
      const mid = cy - (smile * u * u * 6 + skew * u * 3);
      const o = open * pow(1 - u * u, sqr);
      const a = mid - o * 0.30, b = mid + o * 0.70;
      if (my <= a || my >= b) return;
      const depth = (my - a) / max(0.01, b - a);
      // tooth index across the arch; a gap tooth is just more dark
      const tIdx = Math.round((mx - cx) / 3.4);
      const toothX = (mx - cx) / 3.4 - tIdx;
      const gap = gaps.indexOf(tIdx) >= 0;
      const top = !Q.clench ? my < a + th : my < mid;
      const bot = !Q.clench ? my > b - tl : my >= mid;
      if (!gap && (top || bot) && abs(u) < 0.94) {
        const edgeT = top ? (my - a) / max(1, Q.clench ? mid - a : th) : (b - my) / max(1, Q.clench ? b - mid : tl);
        let c = mixc(C.teeth, rgb(170, 150, 120), abs(toothX) * 0.9 + abs(u) * 0.45);
        if (edgeT > 0.8) c = mixc(c, rgb(210, 196, 170), 0.5);
        const seam = abs(abs(toothX) - 0.5) < 0.09;
        if (seam) c = mixc(c, rgb(120, 90, 70), 0.55);
        if (Q.clench && abs(my - mid) < 0.45) c = rgb(60, 20, 20);
        if (Q.bloodTeeth && hash2(tIdx + 9, top ? 1 : 2, 71) < 0.45) c = mixc(c, C.blood, 0.45);
        S.z[i] -= (1.4 + abs(u) * 1.6) * k;
        S.m[i] = M_TEETH; S.col[i] = c; S.gl[i] = MATS[M_TEETH].gl * (seam ? 0.3 : 1); S.em[i] = 0;
        return;
      }
      // the dark inside, and a tongue on the floor of it
      const tongue = Q.tongue && my > b - (b - a) * 0.42 && abs(u) < 0.62;
      S.z[i] -= (tongue ? 3.2 : 5 + open * 0.2) * k;
      S.m[i] = tongue ? M_TONGUE : M_MOUTH;
      S.col[i] = tongue ? mixc(C.tongue, rgb(120, 40, 50), abs(u) * 0.8)
        : mixc(C.mouth, rgb(30, 6, 10), depth * 0.6 + (1 - abs(u)) * 0.3);
      S.gl[i] = MATS[S.m[i]].gl; S.em[i] = 0;
    });
  }
  // lips: dark parting line, shadowed upper lip, lit fat lower lip
  const lineY = (u) => (open > 0.6 ? yU(u) - 0.4 : cy - lift(u));
  const lowY = (u) => (open > 0.6 ? yL(u) : cy - lift(u));
  if (open <= 0.6) {
    stroke(S, curve((t) => { const u = t * 2 - 1; return [cx + u * hw, lineY(u)]; }, 24),
      0.9, 0.9, rgb(70, 30, 30), 0.95, { only: M_SKIN, dz: -0.6 });
  }
  const lk = Q.lips === undefined ? 1 : Q.lips;
  stroke(S, curve((t) => { const u = t * 2 - 1; return [cx + u * hw * 0.9, lineY(u) - 1.6]; }, 20),
    1.1, 1.1, mixc(C.lip, C.sh, 0.5), 0.4 * lk, { only: M_SKIN });
  stroke(S, curve((t) => { const u = t * 2 - 1; return [cx + u * hw * 0.75, lowY(u) + 1.7]; }, 24),
    1.4, 1.4, C.lip, 0.35 * lk, { only: M_SKIN, gl: 0.38, dz: 0.4 });
  stroke(S, curve((t) => { const u = t * 2 - 1; return [cx + u * hw * 0.5, lowY(u) + 1.5]; }, 16),
    0.6, 0.6, C.lipLit, 0.35 * lk, { only: M_SKIN });
  stroke(S, curve((t) => { const u = t * 2 - 1; return [cx + u * hw * 0.55, lowY(u) + 4.2]; }, 16),
    1.0, 1.0, C.sh, 0.3, { only: M_SKIN });
  // corner creases: up for a smile, down for a scowl
  for (const sx of [-1, 1]) {
    const x0 = cx + sx * hw, y0 = cy - lift(sx);
    const up = (smile + skew * sx * 0.5) > 0.15 ? -1 : 1;
    stroke(S, [[x0, y0], [x0 + sx * 2.2, y0 + up * 2.2], [x0 + sx * 2.6, y0 + up * 4]], 0.7, 0.4, C.sh,
      0.6 * (Q.creases === undefined ? 1 : Q.creases), { only: M_SKIN });
  }
  if (Q.dimple) dab(S, cx + hw + 3.5, cy - lift(1) - 1.5, 1.4, C.sh, 0.6, { only: M_SKIN, dz: -0.6 });
  if (Q.sparkle) {
    // *ting*: the toothpaste-commercial glint on a winning smile
    const gx = cx - hw * 0.28, gy = yU(-0.28) + 1.2;
    dab(S, gx, gy, 1.3, rgb(255, 255, 255), 1, { em: 1, hard: 0.4 });
    for (const [dx, dy, L] of [[1, 0, 4.5], [-1, 0, 4.5], [0, 1, 3.5], [0, -1, 3.5]]) {
      stroke(S, [[gx, gy], [gx + dx * L, gy + dy * L]], 0.5, 0.1, rgb(255, 255, 240), 1, { em: 1 });
    }
  }
  if (Q.split) {
    stroke(S, [[cx - hw * 0.35, lowY(-0.35) + 0.5], [cx - hw * 0.38, lowY(-0.35) + 3.2]], 0.7, 0.5, C.blood, 0.95, { gl: 0.9 });
    dab(S, cx - hw * 0.36, lowY(-0.35) + 1.6, 1.3, C.blood, 0.8, { gl: 0.9, dz: 0.3 });
  }
  if (Q.tongueOut) {
    // the tongue lolls out of the low corner and over the lip
    const tx = cx + hw * 0.3, ty = lowY(0.3) - 2;
    cap(S, tx, ty, tx + 3, ty + 11, 4.8, 4.2, 23, M_TONGUE, 0, {
      shader: () => { const mx = FP[0], my = FP[1], t = FP[2], u = FP[3]; return mixc(mixc(rgb(226, 104, 112), rgb(150, 50, 62), abs(u) * 0.7), rgb(120, 40, 50), abs(u) < 0.12 ? 0.35 : 0); },
    });
  }
  return { x: cx + hw - 1.5, y: cy - lift(1) };
}

/** An eye, for whenever the shades are not doing their job. */
function brickEye(S, ex, ey, E, side, C = BR) {
  const kind = E.kind || 'open';
  bump(S, ex, ey + 0.4, 8.6, 6.2, -2.6, { only: M_SKIN, p: 1.3 });
  if (E.black) {
    const b = E.black;
    dab(S, ex, ey + 1, 10.5, mixc(C.bruiseY, C.skin, 0.4), 0.45 * b, { only: M_SKIN, hard: 0.2 });
    dab(S, ex, ey + 0.8, 8.4, C.bruise, 0.75 * b, { only: M_SKIN, hard: 0.3 });
    dab(S, ex, ey + 0.6, 5.6, rgb(60, 26, 64), 0.6 * b, { only: M_SKIN, hard: 0.2 });
    bump(S, ex, ey + 3.5, 8, 4.5, 2.4 * b, { only: M_SKIN });
  }
  const lidCol = mixc(C.sh, C.skin, 0.3);
  if (kind === 'open' || kind === 'wide') {
    const open = kind === 'wide' ? 1.25 : (E.open === undefined ? 1 : E.open);
    const rh = 4.1 * clamp(open, 0.15, 1.3);
    const ecy = ey + (1 - min(1, open)) * 1.6;
    ell(S, ex, ecy, 6.2, rh, 1.5, M_EYE, 0, {
      mode: 'lift', only: M_SKIN,
      shader: () => { const mx = FP[0], my = FP[1], u = FP[2], v = FP[3]; return mixc(C.sclera, rgb(170, 150, 140), clamp(abs(u) * 0.8 + max(0, -v) * 0.5, 0, 1)); },
    });
    if (E.bloodshot) {
      for (let v = 0; v < 6; v++) {
        const sd = v & 1 ? -1 : 1;
        const yy = ecy + (hash2(v, side + 3, 17) - 0.5) * rh * 1.2;
        stroke(S, [[ex + sd * 6, yy], [ex + sd * 4.2, yy + (hash2(v, 2, 3) - 0.5) * 1.4], [ex + sd * 2.8, yy]],
          0.35, 0.25, rgb(196, 40, 40), 0.85 * E.bloodshot, { only: M_EYE });
      }
    }
    const ix = ex + (E.look || 0) * 2.6 + (E.cross ? -side * 1.8 : 0), iy = ecy + (E.lookY || 0) * 1.6 + 0.3;
    const ir = 3.0 * (kind === 'wide' ? 0.8 : 1);
    ell(S, ix, iy, ir, ir, 0.5, M_EYE, 0, {
      mode: 'lift', only: M_EYE,
      shader: () => {
        const mx = FP[0], my = FP[1], u = FP[2], v = FP[3];
        const d = sqrt(u * u + v * v);
        let c = mixc(C.iris, rgb(30, 60, 96), clamp(d * 1.1 - 0.1, 0, 1));
        if (((atan2(v, u) * 7 + 20) | 0) % 2 === 0) c = shadec(c, 1.12);
        if (d > 0.82) c = rgb(24, 36, 54);
        return c;
      },
    });
    const pr = ir * (E.pupil || 0.45);
    dab(S, ix, iy, pr, rgb(8, 8, 12), 1, { only: M_EYE, hard: 0.7 });
    dab(S, ix - ir * 0.35, iy - ir * 0.4, 0.8, rgb(255, 255, 255), 1, { only: M_EYE, hard: 0.5, em: 0.9 });
    // upper lid: a heavy fold with lashes along its edge
    const top = ecy - rh;
    stroke(S, curve((t) => { const u = t * 2 - 1; return [ex + u * 6.6, top + u * u * 2.0 + 0.2]; }, 16),
      1.0, 1.0, C.lash, 0.95, { only: [M_EYE, M_SKIN] });
    stroke(S, curve((t) => { const u = t * 2 - 1; return [ex + u * 6.8, top - 2.0 + u * u * 1.6]; }, 16),
      1.2, 1.2, lidCol, 0.55, { only: M_SKIN, dz: 0.5 });
    stroke(S, curve((t) => { const u = t * 2 - 1; return [ex + u * 5.6, ecy + rh + 0.6 - u * u * 1.2]; }, 12),
      0.6, 0.6, C.sh, 0.5, { only: [M_SKIN, M_EYE] });
  } else if (kind === 'shut' || kind === 'squeeze' || kind === 'happy') {
    const bend = kind === 'happy' ? -2.6 : kind === 'squeeze' ? 1.2 : 1.8;
    const w = kind === 'squeeze' ? 5.6 : 6.4;
    const yy = ey + (kind === 'happy' ? 1.2 : 0.8);
    const lw = kind === 'shut' ? 1.1 : 1.5;
    stroke(S, curve((t) => { const u = t * 2 - 1; return [ex + u * w, yy + (1 - u * u) * bend]; }, 16),
      lw, lw, mixc(C.lash, rgb(20, 10, 8), 0.4), 1, { only: M_SKIN, dz: -0.5 });
    stroke(S, curve((t) => { const u = t * 2 - 1; return [ex + u * w, yy - 2.2 + (1 - u * u) * bend * 0.8]; }, 16),
      1.5, 1.5, lidCol, 0.5, { only: M_SKIN, dz: 0.8 });
    if (kind !== 'shut') {
      // crow's feet: the squint that says it hurts, or that it is hilarious
      for (let j = -1; j <= 1; j++) {
        const ox = ex + side * (w + 1.2);
        stroke(S, [[ox, yy + j * 1.6], [ox + side * 3.4, yy + j * 2.8]], 0.55, 0.3, C.sh, 0.75, { only: M_SKIN });
      }
      bump(S, ex, yy + 3.2, 7, 3.2, 1.6, { only: M_SKIN });
    }
  } else if (kind === 'x') {
    bump(S, ex, ey, 6, 5, -1.4, { only: M_SKIN });
    for (const d of [-1, 1]) {
      stroke(S, [[ex - 4.4, ey - 3.6 * d], [ex + 4.4, ey + 3.6 * d]], 1.25, 1.25, rgb(40, 14, 16), 1, { only: M_SKIN, dz: -0.4 });
    }
  } else if (kind === 'swollen') {
    bump(S, ex, ey + 0.5, 8.2, 6.4, 3.6, { only: M_SKIN, p: 1.1 });
    dab(S, ex, ey + 0.5, 7.6, mixc(C.bruise, rgb(140, 60, 110), 0.3), 0.85, { only: M_SKIN, gl: 0.55 });
    stroke(S, [[ex - 4.6, ey + 1.4], [ex, ey + 1.9], [ex + 4.6, ey + 1.2]], 0.7, 0.7, rgb(34, 14, 24), 1, { only: M_SKIN });
  }
}

/** Brow: thick, low, and doing all the acting the shades will not let the eyes do. */
function brickBrow(S, side, B, yw, gap) {
  const inner = 64 + yw * 4 + side * 4.5, outer = 64 + yw * 4 + side * 25;
  const by = 40.5;
  const pt = (t) => [lerp(inner, outer, t),
    by - (B.lift || 0) + (B.tilt || 0) * (0.5 - t) * 6 - (B.arch || 0) * sin(t * PI) * 2.4 + t * t * 1.2];
  bump(S, lerp(inner, outer, 0.45), by - (B.lift || 0) * 0.6 + 1.5, 13, 4.2, 2.2, { only: M_SKIN });
  for (let s = 0; s <= 1; s += 0.035) {
    if (gap && abs(s - 0.52) < 0.06) continue;
    const [x, y] = pt(s);
    const r = lerp(3.0, 1.5, s);
    dab(S, x, y, r, BR.brow, 0.95, { only: M_SKIN, hard: 0.55, dz: 0.4 });
    // individual hairs, raked outward
    const hx = hash2((s * 40) | 0, side + 4, 911);
    stroke(S, [[x - side * 0.6, y + r * 0.6], [x + side * 1.5, y - r * 0.8 - hx]], 0.35, 0.25,
      mixc(BR.brow, BR.hairMid, hx), 0.8, { only: M_SKIN });
  }
}

/**
 * The shades. Painted in their own frame: centre (cx,cy), rotation `rot`, so
 * they can sit on the nose, slide down it, get knocked crooked or dangle.
 */
function brickShades(S, sh, yw) {
  if (!sh || sh.mode === 'none') return;
  let cx = 64 + yw * 4.5, cy = 52, rot = 0;
  if (sh.mode === 'low') cy += 12.5;
  if (sh.mode === 'askew') { cy += sh.dy === undefined ? 5 : sh.dy; rot = sh.rot === undefined ? -0.2 : sh.rot; cx += sh.dx || 0; }
  if (sh.mode === 'up') cy = 27.5;
  if (sh.mode === 'hang') {
    // still hooked over his left ear by one arm, the rest swinging free
    rot = sh.rot === undefined ? -0.4 : sh.rot;
    const hx = cx + 30.5, hy = cy - 5.5;
    cx = hx - (30.5 * cos(rot) + 5.5 * sin(rot));
    cy = hy - (30.5 * sin(rot) - 5.5 * cos(rot));
  }
  const cr = cos(rot), sr = sin(rot);
  const base = sh.mode === 'up' ? 32 : sh.mode === 'hang' ? 26 : 28.5;
  const tint = sh.tint || 'dusk';
  const lensState = (x) => (x < 0 ? sh.lensL : sh.lensR) || 'ok';
  const hL = sh.holeL || [-14, 0], hR = sh.holeR || [14, 0];
  // model -> shades space, into a scratch pair rather than an array (or a
  // boxed closure variable) per pixel
  const toLocal = (mx, my) => {
    const dx = mx - cx, dy = my - cy;
    LS[0] = dx * cr + dy * sr; LS[1] = -dx * sr + dy * cr;
  };
  const toM = (x, y) => [cx + x * cr - y * sr, cy + x * sr + y * cr];
  const inHole = (lx, ly) => {
    if (lensState(lx) !== 'hole') return false;
    const hx = lx < 0 ? hL[0] : hR[0], hy = lx < 0 ? hL[1] : hR[1];
    const d = hyp(lx - hx, ly - hy);
    const a = atan2(ly - hy, lx - hx);
    return d < 6.2 * (0.78 + 0.34 * sin(a * 5 + 1.3) + 0.12 * sin(a * 11));
  };
  const R = 36;
  const lensV = (lx, ly) => (ly - lensTop(lx)) / max(1, lensBot(lx) - lensTop(lx));
  // lenses
  sculpt(S, cx - R, cy - R, cx + R, cy + R, M_LENS, () => {
    const mx = FP[0], my = FP[1];
    toLocal(mx, my);
    const lx = LS[0], ly = LS[1];
    if (abs(lx) > 30.5) return -1;
    const t = lensTop(lx), b = lensBot(lx);
    if (ly < t || ly > b) return -1;
    if (lensState(lx) === 'gone' || inHole(lx, ly)) return -1;
    return base + 6 - 8 * (lx / 30) * (lx / 30) - 0.8 * pow((ly - (t + b) / 2) / 6, 2);
  }, () => {
    const mx = FP[0], my = FP[1];
    toLocal(mx, my);
    const lx = LS[0], ly = LS[1];
    const v = lensV(lx, ly);
    const hz = 0.52 + (abs(lx) / 30) * 0.06;
    let c;
    if (tint === 'fire') {
      c = v < hz ? mixc(rgb(120, 30, 20), rgb(255, 120, 40), pow(v / hz, 2.2))
        : mixc(rgb(80, 14, 10), rgb(16, 6, 8), pow((v - hz) / (1 - hz), 0.5));
    } else {
      c = v < hz ? mixc(rgb(34, 44, 78), rgb(236, 132, 70), pow(v / hz, 2.6))
        : mixc(rgb(46, 22, 34), rgb(8, 8, 14), pow((v - hz) / (1 - hz), 0.5));
      // a sliver of skyline along the horizon, because these are 90s shades
      const sky = hash2((lx * 0.9 + 40) | 0, 3, 7);
      if (v < hz && v > hz - 0.08 - sky * 0.12) c = mixc(c, rgb(34, 20, 36), 0.8);
    }
    if (abs(v - hz) < 0.045) c = mixc(c, rgb(255, 226, 170), 0.85);
    return c;
  });
  // the reflection is a light source, not paint
  forPix(S, cx - R, cy - R, cx + R, cy + R, (i) => {
    const mx = FP[0], my = FP[1];
    if (S.m[i] !== M_LENS) return;
    toLocal(mx, my);
    const lx = LS[0], ly = LS[1];
    const v = lensV(lx, ly);
    S.em[i] = abs(v - 0.54) < 0.06 ? 0.9 : v < 0.54 ? 0.45 : 0.12;
  });
  // the frame: a brow bar along the top, a wire at the outer ends, the bridge
  sculpt(S, cx - R, cy - R, cx + R, cy + R, M_PLASTIC, () => {
    const mx = FP[0], my = FP[1];
    toLocal(mx, my);
    const lx = LS[0], ly = LS[1];
    if (abs(lx) > 31.5) return -1;
    const t = lensTop(lx), b = lensBot(lx);
    const zc = base + 7.5 - 8 * (lx / 30) * (lx / 30);
    if (ly >= t - 1.3 && ly <= t + 0.6) return zc;
    if (abs(lx) > 28.8 && ly >= t && ly <= b) return zc - 1;
    if (abs(lx) < 3.0 && ly > t && ly < b + 0.6) return zc - 0.5;
    return -1;
  }, () => {
    const mx = FP[0], my = FP[1];
    toLocal(mx, my);
    const lx = LS[0], ly = LS[1];
    return ly < lensTop(lx) - 0.5 ? rgb(60, 60, 72) : BR.frame;
  });
  // arms back toward the ears
  for (const s2 of [-1, 1]) {
    if (sh.mode === 'hang' && s2 < 0) continue;       // that arm snapped off
    const [ax, ay] = toM(s2 * 30.5, -5.5);
    const [bx, by] = toM(s2 * 34, -2.5);
    cap(S, ax, ay, bx, by, 1.6, 1.3, base - 3, M_PLASTIC, BR.frame);
  }
  // cracks
  for (const s2 of [-1, 1]) {
    const st = s2 < 0 ? sh.lensL : sh.lensR;
    if (st !== 'crack' && st !== 'hole') continue;
    const [hx, hy] = s2 < 0 ? hL : hR;
    const r0 = st === 'hole' ? 5.6 : 0.5;
    for (let r = 0; r < 7; r++) {
      const a = r * (TAU / 7) + hash2(r, s2 + 5, 41) * 0.6;
      const len = 5 + hash2(r, s2 + 7, 43) * 9;
      const pts = [];
      for (let q = 0; q <= 4; q++) {
        const d = r0 + (q / 4) * len;
        const j = (hash2(r, q, 47) - 0.5) * 1.8;
        pts.push(toM(hx + cos(a) * d - sin(a) * j, hy + sin(a) * d + cos(a) * j));
      }
      stroke(S, pts, 0.45, 0.25, rgb(226, 236, 246), 0.95, { only: M_LENS, em: 0.8 });
    }
    for (let r = 0; r < 14; r++) {
      const a = r * (TAU / 14);
      const d = (st === 'hole' ? 8.2 : 3.4) + hash2(r, 3, 49) * 1.4;
      stroke(S, [toM(hx + cos(a) * d, hy + sin(a) * d), toM(hx + cos(a + 0.42) * d, hy + sin(a + 0.42) * d)],
        0.32, 0.32, rgb(214, 226, 240), 0.8, { only: M_LENS, em: 0.7 });
    }
  }
  // the star glint that makes the whole look
  if (sh.glint) {
    const g = sh.glint;
    const [gx, gy] = toM(-21, -3.4);
    const star = { not: [M_CLOTH], em: 1 };
    dab(S, gx, gy, 1.9 * g, rgb(255, 255, 250), 1, { ...star, hard: 0.35 });
    dab(S, gx, gy, 4.2 * g, rgb(255, 236, 200), 0.5, { ...star, hard: 0 });
    for (const [dx, dy, L] of [[1, 0, 8], [-1, 0, 8], [0, 1, 5.5], [0, -1, 5.5], [0.7, 0.7, 3], [-0.7, -0.7, 3], [0.7, -0.7, 3], [-0.7, 0.7, 3]]) {
      stroke(S, [[gx, gy], [gx + dx * L * g, gy + dy * L * g]], 0.75 * g, 0.12, rgb(255, 250, 232), 0.95, star);
    }
  }
}

/**
 * The cigar. From the mouth corner out: band, leaf, ash, ember. `state` bends,
 * snaps, shortens or wilts it; the ember is emissive so it reads from across
 * the room.
 */
function brickCigar(S, anchor, C) {
  if (!C || C.state === 'none') return null;
  const st = C.state || 'lit';
  const x0 = anchor.x - 4.5, y0 = anchor.y + 0.4;
  const baseZ = 24.5;
  const leaf = (mx, my, t, u) => {
    const wrap = 0.5 + 0.5 * sin(t * 30 + u * 2.4 + (mx + my) * 0.25);
    let c = mixc(BR.cigarD, BR.cigar, clamp(0.55 - u * 0.75, 0, 1));
    c = shadec(c, 0.9 + wrap * 0.18);
    if (hash2((mx * 2) | 0, (my * 2) | 0, 311) < 0.08) c = mixc(c, BR.cigarD, 0.5);
    return c;
  };
  const segs = [];
  const ang = C.ang === undefined ? -0.3 : C.ang;
  if (st === 'lit' || st === 'droop') segs.push([ang, C.len || 25]);
  else if (st === 'bent') { segs.push([ang, 11]); segs.push([ang + 0.95, 14]); }
  else if (st === 'snapped') { segs.push([ang, 8.5]); segs.push([1.35, 12]); }
  else if (st === 'stub') segs.push([ang, 9.5]);
  let x = x0, y = y0, total = 0;
  const pts = [[x, y]];
  for (const [a, L] of segs) { x += cos(a) * L; y += sin(a) * L; pts.push([x, y]); total += L; }
  let acc = 0;
  for (let s = 0; s < segs.length; s++) {
    const L = segs[s][1];
    const [ax, ay] = pts[s], [bx, by] = pts[s + 1];
    const t0 = acc / total, t1 = (acc + L) / total;
    const thin = st === 'snapped' && s === 1 ? 0.92 : 1;
    cap(S, ax, ay, bx, by, lerp(3.2, 3.6, t0) * thin, lerp(3.2, 3.6, t1) * thin, baseZ - s * 1.5, M_CIGAR, 0, {
      shader: () => {
        const mx = FP[0], my = FP[1], t = FP[2], u = FP[3];
        const T = lerp(t0, t1, t) * total;
        let c = leaf(mx, my, t, u);
        // the band, a few units out from the lips
        if (s === 0 && T > 3.2 && T < 6.8 && st !== 'stub') {
          c = abs(T - 5) < 0.55 ? BR.gold : mixc(BR.band, rgb(110, 10, 16), clamp(u, 0, 1) * 0.6);
        }
        return c;
      },
    });
    acc += L;
  }
  const [ex, ey] = pts[pts.length - 1];
  const [px2, py2] = pts[pts.length - 2];
  const ea = atan2(ey - py2, ex - px2);
  if (st === 'bent' || st === 'snapped') {
    // torn wrapper at the break
    const [kx, ky] = pts[1];
    for (let j = 0; j < 7; j++) {
      const a = ea + (hash2(j, 1, 77) - 0.5) * 2.4 - 1.2;
      const l = 2 + hash2(j, 2, 77) * 2.6;
      stroke(S, [[kx, ky], [kx + cos(a) * l, ky + sin(a) * l]], 0.5, 0.3, rgb(170, 120, 70), 0.9, { only: M_CIGAR });
    }
    dab(S, kx, ky, 2.4, rgb(160, 110, 66), 0.6, { only: M_CIGAR });
  }
  // ash and the burning tip
  const out = C.out || st === 'droop';
  const ashL = st === 'stub' || st === 'snapped' ? 1.4 : 3.0;
  const ax = ex - cos(ea) * ashL, ay = ey - sin(ea) * ashL;
  cap(S, ax, ay, ex + cos(ea) * 0.6, ey + sin(ea) * 0.6, 3.5, 3.3, baseZ - (segs.length - 1) * 1.5, M_ASH, 0, {
    shader: () => { const mx = FP[0], my = FP[1]; return mixc(BR.ash, rgb(96, 92, 90), hash2((mx * 2.5) | 0, (my * 2.5) | 0, 5) * 0.8); },
  });
  if (!out) {
    // the cherry: a ring of ember under the ash, brightest at the lip
    forPix(S, ex - 5, ey - 5, ex + 5, ey + 5, (i) => {
      const mx = FP[0], my = FP[1];
      if (S.m[i] !== M_ASH && S.m[i] !== M_CIGAR) return;
      const along = (mx - ex) * cos(ea) + (my - ey) * sin(ea);
      if (along < -2.2 || along > 1.2) return;
      const n = hash2((mx * 3) | 0, (my * 3) | 0, 17);
      if (along > -0.6 || n < 0.45) {
        S.m[i] = M_EMBER; S.em[i] = 1; S.gl[i] = 0;
        S.col[i] = mixc(rgb(255, 226, 120), rgb(230, 60, 20), clamp((-along + 1.2) / 3 + n * 0.3, 0, 1));
      }
    });
  }
  return { x: ex, y: ey, ang: ea, lit: !out };
}

/** Brick, head and shoulders. P: see brickFaceParams / BRICK_PORTRAITS. */
function paintBrick(S, P) {
  const yw = P.yaw || 0;
  const X = (x, d) => x + yw * d;           // parallax: d = how far the feature stands proud of the skull
  const pale = P.pale || 0, flush = P.flush || 0;
  const skinBase = mixc(BR.skin, BR.pale, pale), skinLit = mixc(BR.lit, BR.pale, pale * 0.8);

  // ---------------- body (does not roll with the head) ----------------
  setRoll(S, 0, 64, 64, 0, P.bodyDy || 0);
  const skinBody = () => {
    const mx = FP[0], my = FP[1];
    const n = fbm(701, mx / 9, my / 9, 3);
    return mixc(mixc(skinBase, skinLit, clamp(n * 1.3 - 0.2, 0, 1)), BR.sh, clamp((my - 116) / 30, 0, 0.5));
  };
  ell(S, 64, 156, 66, 42, 13, M_SKIN, 0, { shader: skinBody });                // chest
  ell(S, 20, 130, 34, 24, 13, M_SKIN, 0, { shader: skinBody });                // traps like foothills
  ell(S, 108, 130, 34, 24, 13, M_SKIN, 0, { shader: skinBody });
  ell(S, 64, 104, 25, 24, 15, M_SKIN, 0, { shader: skinBody, sq: 0.4 });                // the neck, all of it
  for (const sx of [-1, 1]) {
    bump(S, 64 + sx * 11, 104, 5.5, 17, 3.2, { only: M_SKIN, rot: sx * 0.42 }); // sternocleidomastoid
    bump(S, 64 + sx * 24, 118, 14, 8, 2.4, { only: M_SKIN });
  }
  bump(S, 64 + yw, 98, 3.4, 4.2, 2.0, { only: M_SKIN });                      // Adam's apple
  // the ribbed tank top: scooped neck, straps over the traps
  const neckY = (dx) => 115 + 9 * max(0, 1 - pow(dx / 23, 2));
  const inTank = (mx, my) => {
    const dx = mx - 64;
    if (abs(dx) < 23 && my > neckY(dx)) return true;
    const strap = 30 + (my - 104) * 0.10;
    if (my > 102 && (abs(mx - (64 - strap)) < 6.2 || abs(mx - (64 + strap)) < 6.2)) return true;
    return abs(dx) >= 23 && abs(dx) < 36 && my > 118 + (abs(dx) - 23) * 0.5;
  };
  sculpt(S, 0, 96, 128, 180, M_CLOTH, () => { const mx = FP[0], my = FP[1]; return (inTank(mx, my) ? 1.3 : -1); }, () => {
    const mx = FP[0], my = FP[1];
    const rib = 0.5 + 0.5 * sin(mx * 2.2);
    let c = mixc(BR.tankSh, BR.tank, 0.55 + rib * 0.35);
    const g = fbm(733, mx / 7, my / 7, 3);
    if (g > 0.6) c = mixc(c, BR.grime, (g - 0.6) * 1.6);
    const sweat = pow(max(0, 1 - hyp((mx - 64) / 10, (my - 126) / 9)), 1.5);
    c = mixc(c, rgb(180, 164, 130), sweat * 0.5);
    if (abs(mx - 64) < 23 && my - neckY(mx - 64) < 1.6) c = mixc(c, BR.tankSh, 0.5);
    return c;
  }, { mode: 'lift', only: M_SKIN });
  // shoulder holster strap, because a tank top alone says "off duty"
  cap(S, 8, 110, 40, 152, 5.0, 5.6, 12, M_LEATHER, 0, {
    zk: 0.3,
    shader: () => {
      const mx = FP[0], my = FP[1], t = FP[2], u = FP[3];
      let c = mixc(BR.leatherD, BR.leather, clamp(0.6 - u * 0.6, 0, 1));
      if (abs(abs(u) - 0.72) < 0.09 && ((t * 60) | 0) % 2) c = rgb(190, 160, 110);
      return c;
    },
  });
  box(S, 18.5, 122, 26.5, 129, 2, M_METAL, rgb(170, 160, 130), { base: 14, round: 1.5 });
  dab(S, 22.5, 125.5, 1.6, rgb(40, 36, 30), 0.9, { only: M_METAL, hard: 0.7 });
  // dog tags on a ball chain
  for (const sx of [-1, 1]) {
    for (let t = 0; t <= 1; t += 0.05) {
      const bx = 64 + sx * lerp(19, 3.5, t) + yw * 0.5, by = lerp(103, 117, t) + sin(t * PI) * 1.5;
      ell(S, bx, by, 0.95, 0.95, 1.0, M_METAL, rgb(196, 196, 204), { base: 15 - t * 2 });
    }
  }
  ell(S, 60.5 + yw * 0.5, 123, 4.6, 6.6, 1.6, M_METAL, rgb(184, 186, 194), { base: 13.5, sq: 0.7, rot: 0.12 });
  ell(S, 67.5 + yw * 0.5, 125.5, 4.6, 6.6, 1.6, M_METAL, rgb(150, 152, 160), { base: 14.2, sq: 0.7, rot: -0.1 });
  for (let r = 0; r < 4; r++) {
    stroke(S, [[58 + yw * 0.5, 120 + r * 1.8], [63 + yw * 0.5, 120.6 + r * 1.8]], 0.35, 0.35, rgb(90, 92, 100), 0.8, { only: M_METAL });
  }

  // the jaw's shadow pooled on the neck (painted: it is the one shadow the
  // relief is too shallow to cast convincingly)
  stroke(S, curve((t) => [40 + t * 48, 93 + sin(t * PI) * 5], 20), 6, 6, rgb(96, 54, 42), 0.55, { only: M_SKIN, hard: 0 });
  // ---------------- head ----------------
  setRoll(S, P.roll || 0, 64, 100, P.jx || 0, P.jy || 0, 8);
  const skinHead = () => {
    const mx = FP[0], my = FP[1];
    const fx = mx - yw * 3;
    const n = fbm(711, mx / 8, my / 8, 3);
    let c = mixc(skinBase, skinLit, clamp(n * 1.35 - 0.25, 0, 1));
    // sun on the nose, cheeks and ears; a boxer's ruddiness
    const nose = pow(max(0, 1 - hyp((fx - 64) / 7, (my - 62) / 8)), 1.6) * 0.45;
    const cheeks = pow(max(0, 1 - hyp((abs(fx - 64) - 17) / 10, (my - 64) / 8)), 1.6) * 0.3;
    const ears = pow(max(0, 1 - hyp((abs(fx - 64) - 27) / 5, (my - 57) / 10)), 1.2) * 0.45;
    c = mixc(c, BR.flush, (nose + cheeks + ears) * (1 - pale * 0.8) + flush * 0.45 * (my > 36 ? 1 : 0));
    // stubble: jaw, chin, upper lip, a dark bluish grain
    const dx = abs(fx - 64);
    // beard line: under the cheekbones, up the jaw to the sideburns
    const beard = 66 - max(0, dx - 12) * 0.55;
    let st = smoothstep(beard - 3, beard + 5, my) * (1 - smoothstep(30, 32, dx));
    const lipZone = hyp((fx - 64) / 14, (my - 79.5) / 2.6);
    if (lipZone < 1) st *= 0.1 + lipZone * 0.4;
    if (dx < 9 && my < 71 && my > 67) st *= 0.4;
    if (st > 0.02) {
      const dot = hash2((mx * 2.4) | 0, (my * 2.4) | 0, 331);
      c = mixc(c, BR.stubble, st * (0.26 + (dot < 0.5 ? 0.22 : 0)));
    }
    // high-and-tight: skin shows through the clipper fade at the temples
    if (dx > 22 && my < 50 && my > 20) {
      const fade = smoothstep(22, 27, dx) * smoothstep(52, 42, my);
      const dot = hash2((mx * 2.6) | 0, (my * 2.6) | 0, 337);
      c = mixc(c, mixc(BR.hairRoot, BR.hairMid, dot), fade * (0.35 + (dot < 0.5 ? 0.3 : 0)));
    }
    return c;
  };
  // ears first so the skull tucks over them
  for (const sx of [-1, 1]) {
    const near = sx * yw;                     // turning away from an ear shows more of it
    ell(S, X(64 + sx * 29.2, -2.5), 57, 5.0 + near * 0.8, 10.5, 13 + near * 2, M_SKIN, 0, { shader: skinHead, rot: sx * 0.14 });
    dab(S, X(64 + sx * 30, -2.5), 57.5, 2.4, BR.deep, 0.6, { only: M_SKIN, dz: -1.2 });
    stroke(S, curve((t) => [X(64 + sx * (31.4 + sin(t * PI) * 1.4), -2.5), 48.5 + t * 16]), 0.8, 0.6, BR.lit, 0.35, { only: M_SKIN, dz: 0.6 });
  }
  ell(S, X(64, 0.5), 47, 27.5, 31, 28, M_SKIN, 0, { shader: skinHead, taper: 0.05 });  // skull
  ell(S, X(64, 1.2), 70, 28.5, 21, 26.5, M_SKIN, 0, { shader: skinHead, sq: 0.95 });   // and a frankly excessive jaw
  bump(S, X(64, 3), 86, 12.5, 7, 3.4, { only: M_SKIN });                              // chin
  bump(S, X(64, 3), 87, 2.6, 4.4, -2.2, { only: M_SKIN, p: 1.2 });                    // cleft
  for (const sx of [-1, 1]) {
    bump(S, X(64 + sx * 18, 3), 60, 10, 6.5, 2.8, { only: M_SKIN });                 // cheekbones
    bump(S, X(64 + sx * 23, 1), 76, 7, 9, 1.8, { only: M_SKIN });                    // jaw muscle
    bump(S, X(64 + sx * 13, 4), 43, 13, 4.8, 4.0, { only: M_SKIN });                 // brow ridge
    bump(S, X(64 + sx * 7, 5), 70, 3.6, 7.5, -1.4, { only: M_SKIN, rot: sx * -0.5 });
  }
  // the nose, broken at least twice
  const nx = X(64, 7) + (P.crook || 0);
  bump(S, X(64, 6), 53, 4.6, 12, 7.0, { only: M_SKIN, p: 1.1 });                     // bridge
  bump(S, nx, 63, 7.2, 6.2, 7.0, { only: M_SKIN, p: 1.2 });                          // tip
  bump(S, X(64, 6.5) + (P.crook || 0) * 0.5, 55, 4.4, 3, 1.4, { only: M_SKIN });     // where it healed wrong
  for (const sx of [-1, 1]) {
    bump(S, nx + sx * 5.2, 65.5, 3.4, 2.8, 1.8, { only: M_SKIN });                   // nostril wings
    dab(S, nx + sx * 3.4, 67.2, 1.8, BR.deep, 0.9, { only: M_SKIN, dz: -1.2, sx: 1.3 });
  }
  stroke(S, [[nx - 8, 66], [nx - 4.5, 68.6], [nx + 4.5, 68.6], [nx + 8, 66]], 0.8, 0.8, BR.sh, 0.35, { only: M_SKIN });
  // nasolabial folds, deeper when he grins
  const fold = 0.45 + max(0, P.mouth.smile || 0) * 0.4;
  for (const sx of [-1, 1]) {
    stroke(S, curve((t) => [nx + sx * (8 + t * 7), 64 + t * 13 + t * t * 2]), 0.9, 0.5, BR.sh, fold, { only: M_SKIN, dz: -0.4 });
  }
  // the flat-top, the actual flat top of which you could land a helicopter on
  const topY = 5;
  const hairTop = (dx) => topY + 3.2 * (1 - sqrt(max(0, 1 - pow(max(0, abs(dx) - 23) / 4.2, 2))));
  sculpt(S, 34, 2, 94, 36, M_HAIR, () => {
    const mx = FP[0], my = FP[1];
    const dx = mx - X(64, 1);
    if (abs(dx) > 27.2) return -1;
    const ragged = sin(mx * 1.7) * 0.8 + sin(mx * 3.1 + 1) * 0.5;
    const bot = 31.5 + ragged - 6 * smoothstep(15, 26, abs(dx));
    // bristle tips break the top edge up: a flat-top is a lawn, not a plank
    const top = hairTop(dx) + (hash2((mx * 2.2) | 0, 7, 745) < 0.35 ? 0.6 : 0);
    if (my < top || my > bot) return -1;
    const roundTop = pow(1 - smoothstep(0, 3.2, my - top), 2) * 3.2;
    const fadeBot = smoothstep(bot - 5, bot, my) * 5;
    const flank = sqrt(max(0, 1 - pow(dx / 27.4, 2)));
    const comb = (fbm(749, mx / 0.9, my / 14, 2) - 0.5) * 1.2;       // grooves the comb left
    return 29.5 + 5.5 * flank - roundTop - fadeBot + comb;
  }, () => {
    const mx = FP[0], my = FP[1];
    const dx = mx - X(64, 1);
    const bristle = fbm(741, mx / 1.3, my / 9, 3);
    const clump = fbm(743, mx / 4, my / 4, 2);
    let c = mixc(BR.hairMid, BR.hair, clamp(bristle * 1.7 - 0.4 + clump * 0.35, 0, 1));
    if (hash2((mx * 2.4) | 0, (my * 0.8) | 0, 751) < 0.12) c = mixc(c, rgb(255, 240, 170), 0.5);   // stray lit strands
    const top = hairTop(dx);
    if (my - top < 2.4) c = mixc(c, rgb(255, 234, 150), 0.55 - (my - top) * 0.2);   // sun on the deck
    c = mixc(c, BR.hairRoot, smoothstep(22, 32, my) * 0.75);
    if (P.soot) {
      const s = fbm(747, mx / 5, my / 5, 3);
      if (s > 0.62 - P.soot * 0.25) c = mixc(c, rgb(40, 30, 26), min(0.85, (s - 0.5) * 2.4 * P.soot));
    }
    return c;
  });
  // hairline shadow on the forehead: the flat-top overhangs it
  stroke(S, curve((t) => [X(52 + t * 24, 1), 33 + sin(t * PI) * 0.8], 16), 2.6, 2.6, mixc(BR.sh, BR.skin, 0.2), 0.35, { only: M_SKIN });
  if (P.scorch) {
    // a black-edged crater where something went off next to his head
    const sx = X(74, 1), sy = 8;
    forPix(S, sx - 9, 2, sx + 9, sy + 9, (i) => {
      const mx = FP[0], my = FP[1];
      if (S.m[i] !== M_HAIR) return;
      const d = hyp((mx - sx) / 8, (my - sy) / 6);
      if (d > 1) return;
      S.z[i] -= (1 - d) * 3.2 * S.k;
      S.col[i] = mixc(S.col[i], d < 0.55 ? rgb(58, 34, 30) : rgb(24, 18, 16), 0.85);
    });
    for (let j = 0; j < 7; j++) {
      const a = -PI / 2 + (j - 3) * 0.33;
      const x0 = sx + cos(a) * 5, y0 = sy + sin(a) * 4 + 3;
      cap(S, x0, y0, x0 + cos(a) * 6 + sin(j * 1.7) * 1.4, y0 + sin(a) * 6 - 1.5, 0.6, 0.45, 32, M_HAIR, rgb(40, 28, 22));
    }
  }
  // brows
  const bl = P.browL || {}, brr = P.browR || {};
  brickBrow(S, -1, bl, yw, P.scar !== false);
  brickBrow(S, 1, brr, yw, false);
  if ((bl.lift || 0) + (brr.lift || 0) > 5) {
    for (let r = 0; r < 3; r++) {
      stroke(S, curve((t) => [X(50 + t * 28, 3), 33.5 - r * 2.4 - sin(t * PI) * 0.8 + sin(t * 9 + r) * 0.3], 14),
        0.6, 0.6, BR.sh, 0.42, { only: M_SKIN, dz: -0.3 });
    }
  }
  if ((bl.tilt || 0) + (brr.tilt || 0) > 1.4) {
    for (const sx of [-1, 1]) stroke(S, [[X(64 + sx * 2.2, 5), 36], [X(64 + sx * 1.5, 5), 42]], 0.6, 0.45, BR.sh, 0.6, { only: M_SKIN, dz: -0.5 });
  }
  // two creases across the forehead, earned squinting at explosions
  for (let r = 0; r < 2; r++) {
    stroke(S, curve((t) => [X(53 + t * 22, 3), 35.5 - r * 2.6 - sin(t * PI) * 0.7], 12), 0.5, 0.5, BR.sh, 0.3, { only: M_SKIN, dz: -0.25 });
  }
  if (P.scar !== false) {
    // the scar through his right brow: somebody else's story, told by him
    const sc = [[47.5, 31.5], [48.8, 38], [50, 45], [51.6, 58], [52.4, 64.5]];
    stroke(S, sc.map(([x, y]) => [X(x, 3), y]), 1.0, 0.7, rgb(240, 200, 176), 0.9, { only: M_SKIN, dz: 0.6 });
    stroke(S, sc.map(([x, y]) => [X(x + 1.0, 3), y]), 0.55, 0.4, BR.sh, 0.55, { only: M_SKIN });
  }
  // eyes (the shades cover them when they are on)
  brickEye(S, X(51, 4), 51.5, P.eyeL || { kind: 'open' }, -1);
  brickEye(S, X(77, 4), 51.5, P.eyeR || { kind: 'open' }, 1);
  // mouth and what is in it
  const anchor = brickMouth(S, X(64, 4.5), 79 + (P.mouthDy || 0), P.mouth);
  // damage that sits on the skin
  const D = P.dmg || {};
  if (D.bruise) {
    dab(S, X(83, 3), 64, 7, mixc(BR.bruise, BR.skin, 0.35), 0.5 * D.bruise, { only: M_SKIN, hard: 0.1 });
    dab(S, X(83, 3), 64, 4.5, BR.bruise, 0.45 * D.bruise, { only: M_SKIN, hard: 0.1 });
  }
  if (D.cut) {
    const cx0 = X(D.cut[0], 2), cy0 = D.cut[1];
    stroke(S, [[cx0 - 3.4, cy0 - 1.2], [cx0, cy0], [cx0 + 3.2, cy0 + 1.4]], 0.8, 0.6, BR.bloodD, 1, { only: M_SKIN, dz: -0.4 });
    stroke(S, [[cx0 - 3.4, cy0 - 2.0], [cx0 + 3.2, cy0 + 0.6]], 0.5, 0.5, rgb(236, 150, 140), 0.5, { only: M_SKIN });
    for (let d = 0; d < (D.drips || 1); d++) {
      const dx = cx0 - 2 + d * 2.3, len = 6 + hash2(d, 4, 61) * 10;
      stroke(S, curve((t) => [dx + sin(t * 4 + d) * 0.6, cy0 + t * len], 8), 0.9, 0.6, BR.blood, 0.95, { only: M_SKIN, gl: 0.95, dz: 0.3 });
      dab(S, dx + sin(4 + d) * 0.6, cy0 + len, 1.1, BR.blood, 0.95, { only: M_SKIN, gl: 1, dz: 0.5, hard: 0.6 });
    }
  }
  if (D.nosebleed) {
    for (const sx of [-1, 1]) {
      const len = 10 * D.nosebleed + 4;
      stroke(S, curve((t) => [nx + sx * 3.4 + sin(t * 3) * 0.5 + sx * t * 1.4, 68 + t * len], 10), 1.3, 0.8, BR.blood, 0.95,
        { gl: 0.95, dz: 0.35, not: [M_TEETH, M_MOUTH, M_TONGUE] });
    }
  }
  if (D.sheet) {
    for (let j = 0; j < 9; j++) {
      const x = X(44 + hash2(j, 5, 31) * 40, 2), y0 = 31 + hash2(j, 6, 37) * 4;
      const len = 8 + hash2(j, 7, 41) * 22 * D.sheet;
      stroke(S, curve((t) => [x + sin(t * 5 + j) * 0.8, y0 + t * len], 10), 1.0, 0.7, j & 1 ? BR.blood : BR.bloodD, 0.8,
        { only: [M_SKIN, M_EYE], gl: 0.9, dz: 0.3 });
    }
  }
  if (D.lump) {
    const [lx, ly] = D.lump;
    bump(S, X(lx, 2), ly, 5.8, 5.2, 5.0, { only: [M_SKIN, M_HAIR], p: 0.8 });
    dab(S, X(lx, 2), ly, 5.4, rgb(214, 96, 84), 0.55, { only: [M_SKIN, M_HAIR], hard: 0.2, gl: 0.5 });
    dab(S, X(lx - 1.6, 2), ly - 2, 1.5, rgb(255, 220, 200), 0.6, { only: [M_SKIN, M_HAIR], em: 0.3 });
  }
  if (D.plasters) {
    for (const [px, py, rot, cross] of D.plasters) {
      const pc = () => {
        const mx = FP[0], my = FP[1], u = FP[2], v = FP[3];
        let c = mixc(BR.plaster, BR.plasterD, abs(v) * 0.5);
        if (abs(u) < 0.34) c = mixc(rgb(246, 236, 222), rgb(200, 180, 150), abs(v) * 0.4);
        if (hash2((mx * 3) | 0, (my * 3) | 0, 91) < 0.1) c = shadec(c, 0.86);
        return c;
      };
      ell(S, X(px, 3), py, 7.4, 2.4, 0.9, M_PLASTER, 0, { rot, sq: 0.9, mode: 'lift', only: [M_SKIN, M_HAIR], shader: pc });
      if (cross) ell(S, X(px, 3), py, 7.4, 2.4, 1.2, M_PLASTER, 0, { rot: -rot, sq: 0.9, mode: 'lift', only: [M_SKIN, M_HAIR, M_PLASTER], shader: pc });
    }
  }
  if (P.vein) {
    const vc = mixc(BR.flush, rgb(120, 50, 70), 0.4);
    stroke(S, curve((t) => [X(78 + t * 4, 2) + sin(t * 7) * 0.8, 30 + t * 9], 12), 0.9, 0.7, vc, 0.7, { only: M_SKIN, dz: 1.2 });
    stroke(S, [[X(80, 2), 34], [X(84, 2), 33]], 0.6, 0.5, vc, 0.6, { only: M_SKIN, dz: 0.9 });
    for (const sx of [-1, 1]) {
      stroke(S, curve((t) => [64 + sx * (13 + t * 5), 92 + t * 16]), 1.0, 0.8, mixc(BR.sh, rgb(120, 60, 70), 0.3), 0.55, { only: M_SKIN, dz: 1.4 });
    }
  }
  if (P.sweat) {
    const drops = [[42, 36], [86, 38], [39, 60], [90, 66], [58, 31], [72, 30]];
    for (let d = 0; d < P.sweat; d++) {
      const [sx, sy] = drops[d % drops.length];
      const x = X(sx, 2);
      stroke(S, curve((t) => [x + sin(t * 3) * 0.4, sy + t * 5], 5), 0.8, 1.2, mixc(skinLit, rgb(236, 244, 250), 0.35), 0.5, { only: M_SKIN, gl: 0.9, dz: 0.4 });
      dab(S, x, sy + 5.6, 1.5, mixc(skinLit, rgb(240, 248, 255), 0.4), 0.9, { only: M_SKIN, gl: 1, dz: 1.2, hard: 0.6 });
      dab(S, x - 0.5, sy + 5, 0.5, rgb(255, 255, 255), 1, { only: M_SKIN, em: 0.9 });
    }
  }
  if (P.flyingSweat) {
    for (const [sx, sy, r] of [[29, 30, 1.8], [99, 34, 1.6], [25, 44, 1.2], [103, 48, 1.3]]) {
      ell(S, sx, sy, r, r * 1.3, 1.5, M_EYE, rgb(210, 232, 244), { base: 34 });
    }
  }
  // shades, then the cigar last: it sits in front of everything
  brickShades(S, P.shades, yw);
  const tip = brickCigar(S, anchor, P.cigar);
  const tipC = tip ? [toCanvasX(S, tip.x, tip.y), toCanvasY(S, tip.x, tip.y), tip.lit] : null;
  setRoll(S, 0);
  return { tip: tipC };
}

// ---------------------------------------------------------------------------
// Brick's expressions
// ---------------------------------------------------------------------------

const MOUTHS = {
  smirk: { w: 30, open: 0, smile: 0.25, skew: 1.1 },
  flat: { w: 28, open: 0, smile: -0.05 },
  smile: { w: 30, open: 0, smile: 0.7, skew: 0.8, dimple: 1 },
  talk: { w: 26, open: 7.5, smile: 0.1, skew: 0.4, teethU: 1, teethL: 0.3, tongue: 1 },
  shout: { w: 30, open: 14, smile: -0.1, teethU: 1, teethL: 1, tongue: 1 },
  grit: { w: 32, open: 5.5, smile: 0.05, skew: 0.3, clench: 1 },
  grin: { w: 44, open: 10.5, smile: 1.1, skew: 0.3, clench: 1, sparkle: 1 },
  laugh: { w: 36, open: 14, smile: 0.8, teethU: 1, teethL: 0.6, tongue: 1 },
  roar: { w: 36, open: 18, smile: -0.4, teethU: 1, teethL: 1, tongue: 1, square: 1 },
  slack: { w: 24, open: 7, smile: -0.45, skew: -0.4, teethU: 0.6, tongueOut: 1 },
  wince: { w: 32, open: 4.5, smile: -0.25, skew: -0.9, clench: 1 },
};
const mouth = (name, extra) => Object.assign({}, MOUTHS[name], extra || {});

/**
 * The status face: five health tiers that get comically worse, three glances
 * each, and the special moods. Kept as data so the tiers read as a sequence.
 */
function brickFaceParams(o) {
  const tier = o.tier === undefined ? 4 : o.tier;
  const look = o.look || 0;
  const P = {
    yaw: look * 0.95, scar: true, bodyDy: -8,
    browL: { lift: 0.5, tilt: 0.15 }, browR: { lift: 1.8, tilt: -0.2 },
    shades: { mode: 'on', glint: 1.1 },
    mouth: mouth('smirk'),
    cigar: { state: 'lit', ang: -0.3 },
    dmg: {},
  };
  if (tier <= 3) {
    P.browL = { lift: -0.4, tilt: 0.55 }; P.browR = { lift: 0.4, tilt: 0.45 };
    P.shades = { mode: 'on', glint: 0.8, lensL: 'crack', holeL: [-24, -3] };
    P.mouth = mouth('grit');
    P.cigar = { state: 'lit', ang: -0.12 };
    P.dmg = { cut: [80, 33], drips: 1, bruise: 0.6 };
    P.sweat = 2;
  }
  if (tier <= 2) {
    P.browL = { lift: -1.4, tilt: 1.0 }; P.browR = { lift: -0.2, tilt: 0.8 };
    P.shades = { mode: 'on', glint: 0.6, lensL: 'hole', holeL: [-13, 0.5], lensR: 'ok' };
    P.eyeL = { kind: 'open', open: 0.55, black: 1, bloodshot: 1, look: look * 0.6 };
    P.mouth = mouth('grit', { bloodTeeth: 1, split: 1 });
    P.cigar = { state: 'bent', ang: -0.1 };
    P.dmg = { cut: [80, 33], drips: 2, bruise: 1, nosebleed: 1 };
    P.sweat = 3; P.soot = 0.45;
  }
  if (tier <= 1) {
    P.browL = { lift: -1.2, tilt: 1.1 }; P.browR = { lift: 3.2, tilt: -0.4 };
    P.shades = { mode: 'askew', rot: -0.24, dy: 7.5, dx: 1, lensL: 'gone', lensR: 'crack', holeR: [10, 2] };
    P.eyeL = { kind: 'swollen' };
    P.eyeR = { kind: 'wide', bloodshot: 1, pupil: 0.3, look: look * 0.8 };
    P.mouth = mouth('grit', { bloodTeeth: 1, gaps: [-1], split: 1, smile: -0.15 });
    P.cigar = { state: 'snapped', ang: -0.2 };
    P.dmg = { cut: [80, 33], drips: 2, bruise: 1, nosebleed: 1.5, lump: [47, 30], plasters: [[82, 37, 0.62, true]] };
    P.sweat = 4; P.soot = 0.8; P.scorch = 1; P.crook = 1.2;
  }
  if (tier <= 0) {
    P.browL = { lift: 2.4, tilt: -0.9 }; P.browR = { lift: 3.4, tilt: -0.8 };
    P.shades = { mode: 'hang', lensR: 'gone', lensL: 'crack', holeL: [-12, 1] };
    P.eyeL = { kind: 'swollen' };
    P.eyeR = { kind: 'wide', bloodshot: 1, pupil: 0.28, cross: 1 };
    P.mouth = mouth('grit', { bloodTeeth: 1, gaps: [-1, 2], split: 1, smile: -0.5, skew: -0.6, open: 6.5 });
    P.cigar = { state: 'stub', ang: 0.35 };
    P.dmg = { cut: [80, 33], drips: 3, bruise: 1, nosebleed: 2, sheet: 1, lump: [47, 30],
      plasters: [[47, 30, 0.6, true], [84, 67, 0.25, false]] };
    P.sweat = 5; P.soot = 1; P.scorch = 1; P.crook = 2.4; P.pale = 0.25;
  }
  switch (o.mode) {
    case 'hurt':
      Object.assign(P, {
        browL: { lift: -2.2, tilt: 1.3 }, browR: { lift: -1.6, tilt: 1.3 },
        shades: { mode: 'askew', rot: 0.2, dy: -12.5, lensL: 'hole', holeL: [-13, 0.5] },
        eyeL: { kind: 'squeeze', black: 0.8 }, eyeR: { kind: 'squeeze' },
        mouth: mouth('wince', { bloodTeeth: 1 }),
        cigar: { state: 'bent', ang: 0.45 },
        roll: -0.07, jx: -1.5, jy: 1, flush: 0.45, flyingSweat: 1,
      });
      break;
    case 'grin':
      Object.assign(P, {
        yaw: 0, browL: { lift: 3.0, tilt: -0.3 }, browR: { lift: 3.6, tilt: -0.3 },
        shades: { mode: 'on', glint: 1.7 },
        eyeL: undefined, eyeR: undefined,
        mouth: mouth('grin'),
        cigar: { state: 'lit', ang: -0.95, len: 23 },
      });
      P.dmg = tier <= 3 ? { cut: [80, 33], drips: 1 } : {};
      break;
    case 'key':
      Object.assign(P, {
        browL: { lift: 0.2, tilt: 0.2 }, browR: { lift: 5.5, tilt: -0.3, arch: 1.4 },
        shades: { mode: 'low', glint: 0.9 },
        eyeL: { kind: 'open', open: 0.62, look: 1 }, eyeR: { kind: 'open', open: 0.75, look: 1 },
        mouth: mouth('smirk', { skew: 1.4 }),
        cigar: { state: 'lit', ang: -0.55 },
      });
      break;
    case 'dead':
      Object.assign(P, {
        yaw: 0, browL: { lift: 2, tilt: -0.6 }, browR: { lift: 2.6, tilt: -0.7 },
        shades: { mode: 'hang', rot: -0.75, lensR: 'gone', lensL: 'crack', holeL: [-12, 1] },
        eyeL: { kind: 'x' }, eyeR: { kind: 'x' },
        mouth: mouth('slack'),
        cigar: { state: 'droop', ang: 1.15, len: 22 },
        roll: 0.13, jy: 1.5, pale: 0.55, sweat: 0,
      });
      break;
    case 'rage':
      Object.assign(P, {
        browL: { lift: -2.6, tilt: 1.5 }, browR: { lift: -2.2, tilt: 1.5 },
        shades: { mode: 'on', glint: 1.2, tint: 'fire' },
        eyeL: undefined, eyeR: undefined,
        mouth: mouth('roar'),
        cigar: { state: 'stub', ang: -0.15 },
        flush: 0.75, vein: 1, sweat: 3,
      });
      P.dmg = { cut: [80, 33], drips: 1 };
      break;
    case 'ecstatic':
      Object.assign(P, {
        yaw: 0, browL: { lift: 5.5, tilt: -0.4, arch: 1.5 }, browR: { lift: 5.5, tilt: -0.4, arch: 1.5 },
        shades: { mode: 'up', glint: 1.2 },
        eyeL: { kind: 'happy' }, eyeR: { kind: 'happy' },
        mouth: mouth('laugh'),
        cigar: { state: 'lit', ang: -0.85, len: 23 },
        flush: 0.3, dmg: {},
      });
      break;
    default:
  }
  return P;
}

/**
 * Radio portrait moods. 0 is the resting frame; 1 and 2 alternate while he
 * talks, so they share a head and differ in the mouth and one brow; 3 is the
 * title-screen charmer, shades down the nose.
 */
const BRICK_PORTRAITS = [
  { browL: { lift: 0.6, tilt: 0.15 }, browR: { lift: 2.6, tilt: -0.3 }, mouth: mouth('smirk'), cigar: { state: 'lit', ang: -0.32 } },
  { browL: { lift: 1.2, tilt: 0.35 }, browR: { lift: 1.6, tilt: 0.25 }, mouth: mouth('talk'), cigar: { state: 'lit', ang: -0.2 } },
  { browL: { lift: 0.3, tilt: 0.7 }, browR: { lift: 3.0, tilt: -0.1 }, mouth: mouth('grit', { w: 34 }), cigar: { state: 'lit', ang: -0.26 } },
  {
    browL: { lift: 1.0, tilt: 0 }, browR: { lift: 5.6, tilt: -0.3, arch: 1.4 }, mouth: mouth('smile'),
    cigar: { state: 'lit', ang: -0.55 }, shades: { mode: 'low', glint: 0.9 },
    eyeL: { kind: 'open', open: 0.7, lookY: -0.5 }, eyeR: { kind: 'open', open: 0.8, lookY: -0.5 },
  },
];

// ---------------------------------------------------------------------------
// public builders
// ---------------------------------------------------------------------------

// The status face is painted at 1.5x and filtered down. It is drawn at about
// 1:1 behind a CRT, and 2x cost a third more boot time for detail nobody sees.
const FACE_SS = 1.5;

// How far a feature slides when he glances sideways, per unit of height above
// the neck: the nose and the cigar travel furthest, the ears barely move.
const TURN_K = 4.2;
function turnShift(z, k, look) { return look * TURN_K * clamp((z / k - 16) / 20, 0, 1.6) * k; }

/**
 * Glance left or right by re-projecting an already painted head: every pixel
 * slides sideways in proportion to how far it stands proud of the neck, the
 * higher surface wins where two land on one spot, and anything uncovered
 * inside the old silhouette borrows its neighbour. Then it is lit afresh. The
 * three glances of a health tier thereby cost one sculpt, not three.
 */
function turnStudio(S, look, slot) {
  const T = makeStudio(S.w, S.h, S.k, S.ox, S.oy, slot);
  const { w, h } = S;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!S.m[i]) continue;
      const x2 = Math.round(x + turnShift(S.z[i], S.k, look));
      if (x2 < 0 || x2 >= w) continue;
      const j = y * w + x2;
      if (T.m[j] && T.z[j] >= S.z[i]) continue;
      T.z[j] = S.z[i]; T.m[j] = S.m[i]; T.col[j] = S.col[i]; T.gl[j] = S.gl[i]; T.em[j] = S.em[i];
    }
    // fill the seams the slide opened, from the side the head moved away from
    const dir = look > 0 ? -1 : 1;
    for (let pass = 0; pass < 3; pass++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (T.m[i] || !S.m[i]) continue;
        const xn = x + dir;
        if (xn < 0 || xn >= w) continue;
        const j = y * w + xn;
        if (!T.m[j]) continue;
        T.z[i] = T.z[j]; T.m[i] = T.m[j]; T.col[i] = T.col[j]; T.gl[i] = T.gl[j]; T.em[i] = T.em[j];
      }
    }
  }
  return T;
}

// The last sculpted tier, kept so its other two glances can be re-projected.
const TURN = { key: '', S: null, tip: null, tipZ: 0 };

/**
 * HUD status face, 64x72: supersampled on a 96x108 studio with the head
 * filling the frame. `f.ember` carries the cigar tip in frame pixels (or null)
 * so the HUD can keep the smoke rising off it.
 */
export function buildBrickFace(o = {}) {
  const k = 1.26 * FACE_SS / 2;
  const w = 64 * FACE_SS, h = 72 * FACE_SS, ox = 32 * FACE_SS - 64 * k, oy = 2 * FACE_SS - 5 * k;
  const look = o.mode ? 0 : (o.look || 0);
  let S, tip;
  if (o.mode) {
    S = makeStudio(w, h, k, ox, oy);
    tip = paintBrick(S, brickFaceParams(o)).tip;
  } else {
    // sculpt the tier facing front once, into its own slot, then turn it
    const key = 'tier' + (o.tier === undefined ? 4 : o.tier);
    if (TURN.key !== key || !TURN.S) {
      const F = makeStudio(w, h, k, ox, oy, 1);
      const t = paintBrick(F, brickFaceParams({ tier: o.tier, look: 0 })).tip;
      TURN.key = key; TURN.S = F; TURN.tip = t;
      TURN.tipZ = t ? F.z[clamp(t[1] | 0, 0, h - 1) * w + clamp(t[0] | 0, 0, w - 1)] : 0;
    }
    S = look ? turnStudio(TURN.S, look, 2) : TURN.S;
    tip = TURN.tip && [TURN.tip[0] + turnShift(TURN.tipZ, k, look), TURN.tip[1], TURN.tip[2]];
  }
  const f = downsampleTo(render(S, RIG_BRICK), 64, 72);
  grade(f, 0.6, 0.16, 1.14);
  outline(f, rgba(10, 8, 10, 255));
  f.ember = tip && tip[2] ? [tip[0] / FACE_SS, tip[1] / FACE_SS] : null;
  return f;
}

// Radio portraits are 128 px, painted at 1.5x. They show at about 1:1 on the
// radio and get blown up on the title screen, where extra supersampling of the
// source buys nothing.
const PW = 128, PORT_SS = 1.5;

/** Radio portrait, 128x128, chest up on a transparent surround. */
export function buildBrickPortrait(idx) {
  const S = makeStudio(PW * PORT_SS, PW * PORT_SS, PORT_SS, 0, 0);
  const P = Object.assign({ yaw: 0, scar: true, shades: { mode: 'on', glint: 1 }, dmg: {} }, BRICK_PORTRAITS[idx] || BRICK_PORTRAITS[0]);
  const { tip } = paintBrick(S, P);
  const f = downsampleTo(render(S, RIG_BRICK), PW, PW);
  grade(f, 0.5, 0.14, 1.1);
  outline(f, rgba(12, 10, 14, 255));
  if (tip && tip[2]) {
    smokeWisp(f, tip[0] / PORT_SS + 1, tip[1] / PORT_SS - 2, 46, 9100 + idx * 7, { maxX: 121, minY: 7 });
    smokeWisp(f, tip[0] / PORT_SS + 2, tip[1] / PORT_SS - 4, 30, 9150 + idx * 7, { maxX: 121, minY: 7, alpha: 0.22, width: 1.2 });
  }
  f.ember = tip && tip[2] ? [tip[0] / PORT_SS, tip[1] / PORT_SS] : null;
  return f;
}

// ---------------------------------------------------------------------------
// DR. ILSA VANCE
// ---------------------------------------------------------------------------
// Chief engineer of Bunker Sieben and the only competent person on the radio.
// Crown braid, wire spectacles, a headset with a boom mic, and a field-grey
// signals tunic buttoned to the throat. Deadpan is her resting state; the
// brows do the rest. A pencil lives behind her ear.

const IL = {
  skin: rgb(206, 154, 122), lit: rgb(240, 196, 162), sh: rgb(138, 86, 72), deep: rgb(86, 46, 42),
  blush: rgb(214, 120, 110),
  hair: rgb(214, 184, 118), hairHi: rgb(250, 232, 176), hairSh: rgb(128, 98, 56),
  brow: rgb(92, 70, 46), lash: rgb(34, 24, 22),
  lip: rgb(164, 60, 70), lipLit: rgb(204, 108, 110),
  teeth: rgb(240, 234, 222), mouth: rgb(76, 22, 26), tongue: rgb(200, 96, 100),
  sclera: rgb(240, 236, 230), iris: rgb(96, 132, 104),
  bruise: rgb(98, 52, 108), bruiseY: rgb(156, 150, 74), blood: rgb(170, 18, 20),
  tunic: rgb(96, 104, 100), tunicD: rgb(52, 58, 58), collar: rgb(46, 60, 52),
  piping: rgb(206, 208, 200), button: rgb(176, 170, 146),
  set: rgb(40, 42, 48), setHi: rgb(84, 88, 98), wire: rgb(170, 160, 120),
};

const ILSA_PORTRAITS = [
  // 0 level, businesslike, fractionally disappointed in you
  { browL: { lift: -0.3, tilt: 0.25 }, browR: { lift: -0.3, tilt: 0.25 }, eye: { open: 0.66 }, mouth: { w: 14, open: 0, smile: 0 } },
  // 1 mid-explanation
  { browL: { lift: 0.8, tilt: 0.1 }, browR: { lift: 1.2, tilt: 0 }, eye: { open: 0.74 }, mouth: { w: 13, open: 4.2, smile: 0, teethU: 1, teethL: 0.5, tongue: 1 } },
  // 2 deeply unimpressed: the one the game uses most
  { browL: { lift: -0.6, tilt: 0.35 }, browR: { lift: 3.8, tilt: -0.3, arch: 1.2 }, eye: { open: 0.52 }, mouth: { w: 14, open: 0, smile: -0.05, skew: 0.4 } },
  // 3 a real, tired smile
  { browL: { lift: 1.0, tilt: -0.25 }, browR: { lift: 1.0, tilt: -0.25 }, eye: { open: 0.62, squint: 1 }, mouth: { w: 15, open: 0, smile: 0.5 } },
];

// 3x5 stencil glyphs for the name tape
const GLYPH = { V: [5, 5, 5, 5, 2], A: [2, 5, 7, 5, 5], N: [5, 7, 7, 7, 5], C: [3, 4, 4, 4, 3], E: [7, 4, 6, 4, 7] };
function stencilText(S, text, x, y, sc, col) {
  let cx = x;
  for (const ch of text) {
    const g = GLYPH[ch];
    if (g) {
      for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) {
        if (g[r] & (4 >> c)) box(S, cx + c * sc, y + r * sc, cx + (c + 1) * sc - 0.05, y + (r + 1) * sc - 0.05, 0.25, 0, 0, { mode: 'lift', only: M_CLOTH, round: 0.01 });
        if (g[r] & (4 >> c)) dab(S, cx + (c + 0.5) * sc, y + (r + 0.5) * sc, sc * 0.72, col, 1, { only: M_CLOTH, hard: 0.8 });
      }
    }
    cx += 4 * sc;
  }
}

/** Her eye: almond, lashed, a flick of liner. Smaller and sharper than his. */
function ilsaEye(S, ex, ey, E, side) {
  const C = IL;
  const open = E.open === undefined ? 1 : E.open;
  const rh = 2.9 * clamp(open, 0.1, 1.2);
  const ecy = ey + (1 - open) * 0.9;
  ell(S, ex, ecy, 5.2, rh, 1.2, M_EYE, 0, {
    mode: 'lift', only: M_SKIN, rot: side * -0.06,
    shader: () => { const mx = FP[0], my = FP[1], u = FP[2], v = FP[3]; return mixc(C.sclera, rgb(176, 160, 156), clamp(abs(u) * 0.7 + max(0, -v) * 0.6, 0, 1)); },
  });
  const ix = ex + (E.look || 0) * 2, iy = ecy + 0.2;
  ell(S, ix, iy, 2.4, 2.4, 0.4, M_EYE, 0, {
    mode: 'lift', only: M_EYE,
    shader: () => {
      const mx = FP[0], my = FP[1], u = FP[2], v = FP[3];
      const d = sqrt(u * u + v * v);
      let c = mixc(C.iris, rgb(40, 64, 52), clamp(d * 1.1 - 0.1, 0, 1));
      if (d > 0.8) c = rgb(30, 44, 38);
      return c;
    },
  });
  dab(S, ix, iy, 1.05, rgb(8, 8, 10), 1, { only: M_EYE, hard: 0.7 });
  dab(S, ix - 0.8, iy - 0.9, 0.6, rgb(255, 255, 255), 1, { only: M_EYE, hard: 0.5, em: 0.9 });
  // upper lid and lash line, heavy, with a wing at the outer corner
  const top = (u) => ecy - rh * (1 - u * u * 0.5) + (u * side > 0 ? u * u * 0.4 : 0);
  stroke(S, curve((t) => { const u = t * 2 - 1; return [ex + u * 5.6, top(u) - 0.1]; }, 16), 0.9, 0.9, C.lash, 1, { only: [M_EYE, M_SKIN] });
  stroke(S, [[ex + side * 5.2, top(side) + 0.2], [ex + side * 7.4, top(side) - 1.6]], 0.7, 0.25, C.lash, 0.95, { only: M_SKIN });
  if (open < 0.95) {
    // the lid comes down like a shutter: this is her unimpressed setting
    stroke(S, curve((t) => { const u = t * 2 - 1; return [ex + u * 5.4, top(u) - 1.0]; }, 16), 1.2, 1.2, mixc(C.skin, C.sh, 0.3), 0.8, { only: M_SKIN, dz: 0.4 });
  }
  stroke(S, curve((t) => { const u = t * 2 - 1; return [ex + u * 5.8, ecy - 5.2 + u * u * 1.4]; }, 12), 0.7, 0.7, C.sh, 0.45, { only: M_SKIN });
  stroke(S, curve((t) => { const u = t * 2 - 1; return [ex + u * 4.6, ecy + rh + 0.5 - u * u * 0.8]; }, 12), 0.45, 0.45, mixc(C.lash, C.sh, 0.4), 0.55, { only: [M_SKIN, M_EYE] });
  if (E.squint) {
    stroke(S, curve((t) => { const u = t * 2 - 1; return [ex + u * 5, ecy + rh + 1.6 - u * u * 0.8]; }, 10), 1.1, 1.1, mixc(C.skin, C.sh, 0.3), 0.7, { only: M_SKIN, dz: 0.5 });
  }
  dab(S, ex, ecy - 3.6, 5.6, rgb(150, 124, 132), 0.22, { only: M_SKIN, hard: 0.1, sy: 0.55 });
}

function paintIlsa(S, P) {
  const C = IL;
  // ---------------- body ----------------
  setRoll(S, 0);
  const cloth = () => {
    const mx = FP[0], my = FP[1];
    const n = fbm(801, mx / 7, my / 7, 3);
    let c = mixc(C.tunicD, C.tunic, clamp(0.35 + n * 1.1, 0, 1));
    if (hash2((mx * 2) | 0, (my * 2) | 0, 803) < 0.18) c = shadec(c, 0.94);     // wool twill
    return c;
  };
  ell(S, 64, 152, 64, 44, 13, M_CLOTH, 0, { shader: cloth });                 // chest
  ell(S, 22, 128, 30, 22, 12, M_CLOTH, 0, { shader: cloth });                 // shoulders
  ell(S, 106, 128, 30, 22, 12, M_CLOTH, 0, { shader: cloth });
  // shoulder boards with silver piping, laid along the slope of the shoulder
  for (const sx of [-1, 1]) {
    cap(S, 64 + sx * 25, 111, 64 + sx * 43, 119, 2.6, 2.6, 11, M_CLOTH, 0, {
      zk: 0.5, shader: () => { const mx = FP[0], my = FP[1], t = FP[2], u = FP[3]; return (abs(u) > 0.62 || t > 0.93 ? C.piping : C.collar); },
    });
    ell(S, 64 + sx * 28, 112.5, 1.4, 1.4, 1.2, M_METAL, C.button, { base: 12.5 });
  }
  // neck
  ell(S, 64, 93, 13, 11, 16, M_SKIN, 0, {
    shader: () => { const mx = FP[0], my = FP[1]; return mixc(mixc(C.skin, C.lit, fbm(805, mx / 8, my / 8, 2)), C.sh, clamp((my - 88) / 14, 0.2, 0.55)); },
  });
  stroke(S, curve((t) => [53 + t * 22, 90 + sin(t * PI) * 2], 12), 3.2, 3.2, rgb(120, 76, 66), 0.3, { only: M_SKIN, hard: 0 });
  // high stand collar, buttoned to the throat, with the signals tabs
  sculpt(S, 42, 86, 86, 118, M_CLOTH, () => {
    const mx = FP[0], my = FP[1];
    const dx = mx - 64;
    const top = 91 - dx * dx * 0.006, bot = 107 + dx * dx * 0.012;
    if (abs(dx) > 19 || my < top || my > bot) return -1;
    if (abs(dx) < 1.2 && my < 107) return -1;                                   // the gap at the front
    return 16 + 3 * (1 - pow(dx / 19, 2));
  }, () => {
    const mx = FP[0], my = FP[1];
    const dx = mx - 64;
    const top = 91 - dx * dx * 0.006;
    let c = mixc(C.collar, rgb(76, 92, 80), fbm(807, mx / 5, my / 5, 2));
    if (my - top < 1.1) c = C.piping;
    return c;
  });
  for (const sx of [-1, 1]) {
    ell(S, 64 + sx * 7, 102, 5, 3.4, 0.8, M_CLOTH, 0, {
      mode: 'lift', only: M_CLOTH, sq: 0.8,
      shader: () => { const mx = FP[0], my = FP[1], u = FP[2], v = FP[3]; return (abs(v) < 0.22 && abs(u) < 0.7 ? C.piping : rgb(34, 40, 40)); },
    });
  }
  // placket, buttons, a pocket flap and the name tape
  for (let j = 0; j < 3; j++) ell(S, 64, 116 + j * 7, 1.6, 1.6, 1.4, M_METAL, C.button, { base: 14 });
  stroke(S, [[66.5, 112], [66.5, 132]], 0.5, 0.5, C.tunicD, 0.7, { only: M_CLOTH });
  box(S, 75, 117, 97, 123.5, 0.9, M_CLOTH, 0, { mode: 'lift', only: M_CLOTH, round: 1, shader: () => rgb(196, 190, 166) });
  stencilText(S, 'VANCE', 76.5, 118, 1.05, rgb(30, 30, 32));
  box(S, 31, 118, 51, 123, 0.8, M_CLOTH, 0, { mode: 'lift', only: M_CLOTH, round: 1.4, shader: cloth });
  ell(S, 41, 121.5, 1.3, 1.3, 1.0, M_METAL, C.button, { mode: 'lift', only: M_CLOTH });

  // ---------------- head ----------------
  setRoll(S, P.tilt || 0, 64, 92, 0, -1, 7, 1.12);
  const skinF = () => {
    const mx = FP[0], my = FP[1];
    const n = fbm(811, mx / 8, my / 8, 3);
    let c = mixc(C.skin, C.lit, clamp(n * 1.3 - 0.2, 0, 1));
    const cheeks = pow(max(0, 1 - hyp((abs(mx - 64) - 14) / 9, (my - 67) / 6)), 1.5) * 0.35;
    const nose = pow(max(0, 1 - hyp((mx - 64) / 5, (my - 68) / 5)), 2) * 0.18;
    c = mixc(c, C.blush, cheeks + nose);
    // fine hairs at the hairline, so it fades in instead of being cut out
    const dx = mx - 64;
    const hl = 38 + dx * dx * 0.012 + (abs(dx) > 14 ? (abs(dx) - 14) * 0.9 : 0);
    if (my < hl + 2.6 && hash2((mx * 3) | 0, (my * 3) | 0, 823) < 0.55) c = mixc(c, C.hairSh, (1 - (my - hl) / 2.6) * 0.5);
    return c;
  };
  const hairF = () => {
    const mx = FP[0], my = FP[1];
    const a = atan2(my - 60, mx - 64);
    const strand = 0.5 + 0.5 * sin(a * 26 + fbm(813, mx / 5, my / 5, 2) * 6);
    let c = mixc(C.hairSh, C.hair, clamp(0.35 + fbm(815, mx / 6, my / 6, 2) * 0.9, 0, 1));
    return mixc(c, C.hairHi, pow(strand, 3) * 0.45);
  };
  // hair mass first, the face stamped back over it for a hairline
  ell(S, 64, 46, 29, 33, 27, M_HAIR, 0, { shader: hairF });
  for (const sx of [-1, 1]) {
    ell(S, 64 + sx * 25.5, 62, 4.2, 8.5, 11, M_SKIN, 0, { shader: skinF, rot: sx * 0.1 });   // ears
    dab(S, 64 + sx * 26, 62, 2, C.deep, 0.5, { only: M_SKIN, dz: -1 });
  }
  ell(S, 64, 61, 23, 28.5, 26, M_SKIN, 0, { shader: skinF, taper: 0.42, mode: 'over', only: [M_HAIR] });
  ell(S, 64, 61, 23, 28.5, 26, M_SKIN, 0, { shader: skinF, taper: 0.42 });
  // hairline: centre parting, hair swept back off the forehead
  sculpt(S, 36, 12, 92, 56, M_HAIR, () => {
    const mx = FP[0], my = FP[1];
    const dx = mx - 64;
    const line = 38 + dx * dx * 0.012 + (abs(dx) > 14 ? (abs(dx) - 14) * 0.9 : 0);
    const e = (dx / 27) * (dx / 27) + ((my - 46) / 33) * ((my - 46) / 33);
    if (my > line || e > 1) return -1;
    // a dome over the skull, easing down into the hairline
    return 23 + 8.5 * sqrt(1 - e) - smoothstep(line - 3, line, my) * 2.6
      + (fbm(819, mx / 1.4, my / 5, 2) - 0.5) * 0.8;
  }, () => {
    const mx = FP[0], my = FP[1];
    const dx = mx - 64;
    const part = abs(dx) < 0.7 ? 0.6 : 0;
    // strands sweep up and back from the hairline, fanning away from the part
    const a = atan2(my - 74, abs(dx) + 0.5);
    const strand = 0.5 + 0.5 * sin(a * 46 + fbm(817, mx / 2.5, my / 5, 2) * 5);
    let c = mixc(C.hairSh, C.hair, 0.4 + strand * 0.45);
    c = mixc(c, C.hairHi, pow(strand, 4) * 0.45);
    // the sheen: one soft band where the crown turns toward the light
    const sheen = exp(-pow((my - 33 - dx * dx * 0.01) / 2.6, 2)) * (dx < 0 ? 0.55 : 0.3);
    c = mixc(c, C.hairHi, sheen * (0.5 + strand * 0.5));
    return mixc(c, C.hairSh, part);
  });
  bump(S, 64, 83, 11, 7, 2.6, { only: M_SKIN });                               // chin
  for (const sx of [-1, 1]) {
    bump(S, 64 + sx * 14, 64, 8, 5, 2.8, { only: M_SKIN });                    // cheekbones, high
    bump(S, 64 + sx * 16, 74, 6, 6, -1.4, { only: M_SKIN });                   // and the hollow under them
    bump(S, 64 + sx * 10, 52, 10, 4, 2.2, { only: M_SKIN });                   // brow bone
    bump(S, 64 + sx * 10, 58, 7.5, 5, -2.8, { only: M_SKIN, p: 1.3 });         // sockets
  }
  bump(S, 64, 61, 3.2, 12, 5.2, { only: M_SKIN, p: 1.1 });                     // a long straight nose
  stroke(S, [[63.2, 55], [63.4, 67]], 0.7, 0.8, IL.lit, 0.45, { only: M_SKIN });   // lit along the bridge
  for (const sx of [-1, 1]) bump(S, 64 + sx * 15, 80, 7, 5, 1.6, { only: M_SKIN });   // jaw corners
  bump(S, 64, 69.5, 4.8, 4, 3.6, { only: M_SKIN, p: 1.3 });
  for (const sx of [-1, 1]) {
    dab(S, 64 + sx * 2.6, 72, 1.3, C.deep, 0.85, { only: M_SKIN, dz: -0.8, sx: 1.3 });
    bump(S, 64 + sx * 3.8, 71, 2.2, 2, 1, { only: M_SKIN });
  }
  stroke(S, [[60, 73.2], [64, 74.2], [68, 73.2]], 0.6, 0.6, C.sh, 0.35, { only: M_SKIN });
  // philtrum
  for (const sx of [-1, 1]) stroke(S, [[64 + sx * 1.2, 74.5], [64 + sx * 1.6, 78]], 0.5, 0.5, C.sh, 0.25, { only: M_SKIN });

  // the crown braid, pinned over the top of her head ear to ear
  const braidPt = (t) => {
    const a = PI + t * PI;
    return [64 + cos(a) * 25, 52 + sin(a) * 31];
  };
  const lobes = 22;
  for (let j = 0; j < lobes; j++) {
    const t0 = (j + 0.5) / lobes;
    const [bx, by] = braidPt(t0);
    const [ax, ay] = braidPt(t0 - 0.01), [cx2, cy2] = braidPt(t0 + 0.01);
    const along = atan2(cy2 - ay, cx2 - ax);
    const side = j & 1 ? 1 : -1;
    ell(S, bx + cos(along + PI / 2) * side * 1.1, by + sin(along + PI / 2) * side * 1.1, 4.0, 2.6, 3.6, M_HAIR, 0, {
      rot: along + side * 0.55, base: 27.5,
      shader: () => {
        const mx = FP[0], my = FP[1], u = FP[2], v = FP[3];
        let c = mixc(C.hairSh, C.hair, clamp(0.75 - v * 0.6 - abs(u) * 0.25, 0, 1));
        const str = 0.5 + 0.5 * sin(u * 9 + v * 3);
        c = mixc(c, C.hairHi, pow(str, 3) * 0.4 * (1 - abs(v)));
        return c;
      },
    });
  }
  // eyes and brows
  const ey = 58.5;
  const E = P.eye || {};
  for (const sx of [-1, 1]) {
    const ex = 64 + sx * 9.6;
    ilsaEye(S, ex, ey, E, sx);
    const B = sx < 0 ? P.browL : P.browR;
    const inner = 64 + sx * 3.4, outer = 64 + sx * 18;
    const pt = (t) => [lerp(inner, outer, t), 51 - (B.lift || 0) + (B.tilt || 0) * (0.5 - t) * 4 - (B.arch || 0) * sin(t * PI) * 2 - sin(t * PI * 0.8) * 1.4 + t * 1.2];
    for (let t = 0; t <= 1; t += 0.04) {
      const [x, y] = pt(t);
      dab(S, x, y, lerp(1.3, 0.7, t), C.brow, 0.9, { only: M_SKIN, hard: 0.5 });
    }
  }
  // spectacles: thin round wire rims, a bridge, arms to the ears
  for (const sx of [-1, 1]) {
    const ex = 64 + sx * 9.6;
    forPix(S, ex - 10, ey - 10, ex + 10, ey + 10, (i) => {
      const mx = FP[0], my = FP[1];
      const d = hyp((mx - ex) / 7.4, (my - ey - 0.4) / 6.2);
      if (d > 1.0 || d < 0.86) return;
      FP[4] = (26 + (1 - abs(d - 0.93) / 0.07) * 0.8) * S.k;
      writePx(S, i, M_METAL, C.wire, 'max', 0, null);
    });
    // lens glare: a diagonal slash inside the rim, faint enough to keep her eyes
    forPix(S, ex - 9, ey - 9, ex + 9, ey + 9, (i) => {
      const mx = FP[0], my = FP[1];
      if (!S.m[i] || S.m[i] === M_METAL) return;
      const d = hyp((mx - ex) / 7.4, (my - ey - 0.4) / 6.2);
      if (d >= 0.86) return;
      const band = (mx - ex) + (my - ey) * 0.8;
      const g = max(0, 1 - abs(band + 2.5) / 1.6) * 0.30 + max(0, 1 - abs(band - 2.2) / 0.7) * 0.18;
      if (g <= 0) return;
      S.col[i] = mixc(S.col[i], rgb(236, 250, 246), g);
      S.em[i] = max(S.em[i], g);
    });
    cap(S, 64 + sx * 17, ey - 1, 64 + sx * 24.5, ey - 2.5, 0.55, 0.55, 25, M_METAL, C.wire);
  }
  cap(S, 61.8, ey - 1.2, 66.2, ey - 1.2, 0.6, 0.6, 28, M_METAL, C.wire, { zk: 0.5 });
  // mouth
  brickMouth(S, 64, 80, Object.assign({ lips: 0.25, creases: 0.3 }, P.mouth), C);
  // lipstick: the lips as shapes, a cupid's bow on top and a fuller lower lip
  const Q = P.mouth, hw = Q.w / 2;
  const lift = (u) => (Q.smile || 0) * u * u * 6 + (Q.skew || 0) * u * 3;
  const op = Q.open || 0;
  forPix(S, 64 - hw - 2, 72, 64 + hw + 2, 90, (i) => {
    const mx = FP[0], my = FP[1];
    if (S.m[i] !== M_SKIN) return;
    const u = (mx - 64) / hw;
    if (abs(u) >= 1) return;
    const env = pow(max(0, 1 - u * u), 0.75);
    const yU = 80 - lift(u) - op * 0.3 * env, yL = 80 - lift(u) + op * 0.7 * env;
    const bow = 1.9 * (1 - u * u) + 0.45 * exp(-pow((abs(u) - 0.28) / 0.16, 2)) - 0.5 * exp(-pow(u / 0.1, 2));
    const low = 2.6 * pow(1 - u * u, 0.8);
    let a = 0;
    if (my < yU && my > yU - bow) a = smoothstep(0, 0.6, my - (yU - bow)) * 0.9;
    else if (my > yL && my < yL + low) {
      a = 0.9 * (1 - smoothstep(0.6, 1, (my - yL) / low));
      S.gl[i] = 0.62;
      if (abs(u) < 0.45 && abs(my - yL - low * 0.4) < 0.5) S.em[i] = 0.2;
    }
    if (a > 0) S.col[i] = mixc(S.col[i], mixc(C.lip, C.lipLit, my > yL ? 0.35 : 0), a);
  });
  // contour: cheekbones cut high, the jaw drawn in
  for (const sx of [-1, 1]) {
    stroke(S, curve((t) => [64 + sx * (21 - t * 8), 64 + t * 12], 8), 3.2, 2.2, C.sh, 0.28, { only: M_SKIN, hard: 0 });
    stroke(S, curve((t) => [64 + sx * (20 - t * 12), 76 + t * 11 + sin(t * PI) * 1.5], 10), 2.2, 1.4, C.sh, 0.22, { only: M_SKIN, hard: 0 });
  }
  // a beauty mark, strictly regulation
  dab(S, 76.5, 72, 0.7, rgb(70, 40, 36), 0.95, { only: M_SKIN, hard: 0.7 });
  // the pencil behind her ear
  cap(S, 83, 46, 97, 66, 1.4, 1.4, 31, M_PLASTIC, 0, {
    shader: () => {
      const mx = FP[0], my = FP[1], t = FP[2], u = FP[3];
      if (t < 0.12) return mixc(rgb(226, 130, 140), rgb(150, 80, 90), abs(u));
      if (t < 0.2) return mixc(rgb(200, 200, 200), rgb(110, 110, 110), abs(u));
      if (t > 0.9) return rgb(56, 48, 44);
      if (t > 0.78) return mixc(rgb(226, 196, 150), rgb(160, 130, 90), abs(u));
      return mixc(rgb(236, 190, 40), rgb(150, 110, 20), abs(u) * 0.8 + (abs(u) > 0.5 ? 0.2 : 0));
    },
  });
  // headset: band over the braid, a big earcup on her right, pad on her left
  const bandPt = (t) => { const a = PI + t * PI; return [64 + cos(a) * 30, 60 + sin(a) * 43]; };
  for (let j = 0; j < 30; j++) {
    const [ax, ay] = bandPt(j / 30), [bx, by] = bandPt((j + 1) / 30);
    cap(S, ax, ay, bx, by, 2.1, 2.1, 27, M_PLASTIC, 0, { zk: 0.6, shader: () => { const mx = FP[0], my = FP[1], t = FP[2], u = FP[3]; return mixc(C.setHi, C.set, clamp(u + 0.3, 0, 1)); }});
  }
  const cup = (x, y, r) => {
    ell(S, x, y, r, r * 1.12, 6, M_PLASTIC, 0, {
      base: 26, shader: () => {
        const mx = FP[0], my = FP[1], u = FP[2], v = FP[3];
        const d = sqrt(u * u + v * v);
        let c = mixc(C.setHi, C.set, clamp(d * 0.9, 0, 1));
        if (abs(d - 0.62) < 0.07) c = rgb(24, 24, 28);
        return c;
      },
    });
  };
  cup(34.5, 63, 7.6);
  cup(94, 63, 5.2);
  dab(S, 34.5, 63, 1.6, rgb(120, 255, 150), 1, { only: M_PLASTIC, em: 1, hard: 0.6 });
  // coiled cord from the earcup down into the collar
  for (let t = 0; t <= 1; t += 0.012) {
    const x = 33 + t * 6 + sin(t * 44) * 1.4, y = 70 + t * 30;
    dab(S, x, y, 0.8, C.set, 1, { hard: 0.6, dz: 1.2, not: [M_PLASTIC] });
  }
  // boom mic swinging round toward her mouth
  let px = 36, py = 70;
  for (let t = 1; t <= 8; t++) {
    const tt = t / 8;
    const nx2 = 36 + tt * 16 + sin(tt * PI) * 2, ny2 = 70 + tt * 14 - sin(tt * PI) * 2;
    cap(S, px, py, nx2, ny2, 1.0, 1.0, 26.5, M_PLASTIC, C.set);
    px = nx2; py = ny2;
  }
  ell(S, px + 1.5, py + 0.5, 3.4, 2.8, 3, M_PLASTIC, 0, {
    base: 26, shader: () => { const mx = FP[0], my = FP[1]; return shadec(rgb(52, 52, 58), 0.8 + hash2((mx * 3) | 0, (my * 3) | 0, 821) * 0.4); },
  });
  setRoll(S, 0);
}

/** Radio portrait, 128x128, on a transparent surround, behind a CRT. */
export function buildIlsaPortrait(idx) {
  const S = makeStudio(PW * PORT_SS, PW * PORT_SS, PORT_SS, 0, 0);
  const P = ILSA_PORTRAITS[idx] || ILSA_PORTRAITS[0];
  paintIlsa(S, P);
  const f = downsampleTo(render(S, RIG_ILSA), PW, PW);
  grade(f, 0.5, 0.2, 1.12);
  outline(f, rgba(10, 14, 14, 255));
  crtPass(f, 9301 + idx);
  return f;
}
