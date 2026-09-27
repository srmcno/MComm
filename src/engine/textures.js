// textures.js - the procedural texture atlas for NUKEHAUS.
//
// 32 surfaces, 64x64 each, packed into one Uint32Array. No assets, no canvas,
// no unseeded randomness: the same bunker rots identically every load.
//
// House style: late-Cold-War brutalism gone bad, rendered like a 256-colour VGA
// wall. Nothing is one flat tone. Every surface gets a base gradient, at least
// three material tones, grain, and one piece of storytelling - a stain, a weld,
// a stencil, a crack, something that leaked.
//
// Tiling: walls repeat horizontally across adjacent cells, so anything in the
// CONCRETE / STEEL / PIPES / RUST / TILE / FLOOR_* / CEIL_* families is painted
// on a torus (wrapping plot + period-locked noise). Vertically a wall is drawn
// exactly once floor-to-ceiling, so every wall gets a lighter top and a filthy
// dark skirt - free ambient occlusion.

import { rgba, mix as blend, shade, clamp, lerp, makeRng, makeNoise, fbm, TEX } from '../core/pixels.js';

const W = TEX;          // 64
const AREA = W * W;     // 4096

// The original 32, in their original slots. Level data and saved state index
// into this, so new surfaces only ever go on the end (see EXTRA below).
const BASE_ORDER = [
  'CONCRETE', 'CONCRETE_CRACKED', 'STEEL_PLATE', 'STEEL_RIVET',
  'HAZARD', 'PIPES', 'VENT', 'TILE',
  'TILE_BLOOD', 'RUST', 'SANDBAG', 'SCREENS',
  'CIRCUIT', 'SILO_WALL', 'WARNING', 'DOOR',
  'DOOR_JAMB', 'DOOR_RED', 'DOOR_BLUE', 'DOOR_GOLD',
  'ELEVATOR', 'FLESH', 'FLOOR_CONCRETE', 'FLOOR_GRATE',
  'FLOOR_TILE', 'FLOOR_DIRT', 'FLOOR_BLOOD', 'CEIL_CONCRETE',
  'CEIL_LAMP', 'CEIL_PIPES', 'CEIL_FLESH', 'FLOOR_DECK',
];

// 1 = self lit, ignores distance fog. 0.35 = signage that glows a little so you
// can still read a keydoor from the far end of a black corridor.
const EMISSIVE_TABLE = {
  SCREENS: 1, CIRCUIT: 1, CEIL_LAMP: 1,
  WARNING: 0.35, DOOR_RED: 0.35, DOOR_BLUE: 0.35, DOOR_GOLD: 0.35,
};

// ---------------------------------------------------------------------------
// colour arithmetic (rgba() masks instead of clamping, so never hand it a
// channel outside 0..255 - always go through rgb())
// ---------------------------------------------------------------------------

/** Blend, with t pinned to 0..1. rgba() masks rather than clamps, so a t of
 *  1.05 silently wraps a channel to black. Ask how I know. */
function mix(ca, cb, t) { return blend(ca, cb, clamp(t, 0, 1)); }

function rgb(r, g, b) {
  return rgba(clamp(r, 0, 255) | 0, clamp(g, 0, 255) | 0, clamp(b, 0, 255) | 0, 255);
}
const CR = (c) => c & 255;
const CG = (c) => (c >>> 8) & 255;
const CB = (c) => (c >>> 16) & 255;
function mul(c, s) { return s <= 1 && s >= 0 ? shade(c, s) : rgb(CR(c) * s, CG(c) * s, CB(c) * s); }
function add(c, d) { return rgb(CR(c) + d, CG(c) + d, CB(c) + d); }
function addRGB(c, r, g, b) { return rgb(CR(c) + r, CG(c) + g, CB(c) + b); }
function lum(c) { return 0.299 * CR(c) + 0.587 * CG(c) + 0.114 * CB(c); }

const BLACK = rgba(0, 0, 0);
const WHITE = rgba(255, 255, 255);

const C = {
  conc: rgba(96, 98, 104), concMid: rgba(66, 68, 74), concDk: rgba(38, 40, 46),
  damp: rgba(74, 86, 74), moss: rgba(58, 72, 56),
  steel: rgba(88, 96, 112), steelMid: rgba(62, 69, 84), steelDk: rgba(34, 39, 50),
  spec: rgba(160, 172, 190), specHot: rgba(206, 216, 232),
  rust: rgba(140, 72, 38), rustDk: rgba(92, 44, 24), rustLt: rgba(178, 108, 56),
  rustBloom: rgba(120, 58, 30),
  yellow: rgba(226, 178, 42), yellowDk: rgba(160, 122, 26), black: rgba(24, 22, 20),
  blood: rgba(112, 18, 24), bloodDk: rgba(58, 10, 14), bloodWet: rgba(158, 34, 36),
  cyan: rgba(96, 232, 244), amber: rgba(255, 176, 64), green: rgba(96, 240, 140),
  flesh: rgba(168, 92, 84), fleshDk: rgba(96, 46, 46), vein: rgba(96, 36, 44),
  wet: rgba(238, 196, 182),
  tile: rgba(150, 154, 142), tileDk: rgba(104, 110, 100), grout: rgba(48, 50, 46),
  burlap: rgba(122, 106, 74), burlapDk: rgba(62, 54, 38),
  dirt: rgba(96, 82, 62), dirtDk: rgba(48, 40, 30),
  keyRed: rgba(214, 44, 40), keyBlue: rgba(58, 122, 232), keyGold: rgba(236, 184, 52),
};

// ---------------------------------------------------------------------------
// plotting. everything wraps on the torus; features that must not wrap are
// simply drawn inside the bounds.
// ---------------------------------------------------------------------------

function wrap(v) { const i = Math.floor(v) % W; return i < 0 ? i + W : i; }
function idx(x, y) { return wrap(y) * W + wrap(x); }
function put(t, x, y, c) { t[idx(x, y)] = c >>> 0; }
function at(t, x, y) { return t[idx(x, y)] >>> 0; }
function blendPx(t, x, y, c, a) {
  if (!(a > 0)) return;
  const i = idx(x, y);
  t[i] = a >= 1 ? (c >>> 0) : mix(t[i] >>> 0, c >>> 0, a);
}
function fill(t, c) { t.fill(c >>> 0); }
function rect(t, x, y, w, h, c, a = 1) {
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) blendPx(t, x + i, y + j, c, a);
}
function hline(t, y, x0, x1, c, a = 1) { for (let x = x0; x <= x1; x++) blendPx(t, x, y, c, a); }
function vline(t, x, y0, y1, c, a = 1) { for (let y = y0; y <= y1; y++) blendPx(t, x, y, c, a); }

/** Soft-edged filled disc. */
function disc(t, cx, cy, r, c, a = 1, feather = 1) {
  const n = Math.ceil(r + feather + 1);
  for (let j = -n; j <= n; j++) {
    for (let i = -n; i <= n; i++) {
      const d = Math.sqrt(i * i + j * j);
      const k = clamp((r + 0.5 - d) / Math.max(feather, 0.001), 0, 1);
      if (k > 0) blendPx(t, cx + i, cy + j, c, k * a);
    }
  }
}
/** Radial glow, alpha falling off as a power curve. */
function glow(t, cx, cy, r, c, a = 1, pow = 2) {
  const n = Math.ceil(r);
  for (let j = -n; j <= n; j++) {
    for (let i = -n; i <= n; i++) {
      const d = Math.sqrt(i * i + j * j) / r;
      if (d >= 1) continue;
      blendPx(t, cx + i, cy + j, c, Math.pow(1 - d, pow) * a);
    }
  }
}
function segment(t, x0, y0, x1, y1, c, thick = 1, a = 1) {
  const dx = x1 - x0, dy = y1 - y0;
  const n = Math.max(2, Math.ceil(Math.hypot(dx, dy) * 2));
  for (let s = 0; s <= n; s++) {
    const u = s / n;
    disc(t, x0 + dx * u, y0 + dy * u, thick * 0.5, c, a, 0.9);
  }
}
/** Raised (or sunken) bevel around a rect. */
function bevel(t, x, y, w, h, light, dark, raised = true, thick = 1, a = 0.85) {
  const A = raised ? light : dark, B = raised ? dark : light;
  for (let k = 0; k < thick; k++) {
    const aa = a * (1 - k * 0.28);
    for (let i = k; i < w - k; i++) {
      blendPx(t, x + i, y + k, A, aa);
      blendPx(t, x + i, y + h - 1 - k, B, aa);
    }
    for (let j = k; j < h - k; j++) {
      blendPx(t, x + k, y + j, A, aa * 0.9);
      blendPx(t, x + w - 1 - k, y + j, B, aa * 0.9);
    }
  }
}

// ---------------------------------------------------------------------------
// noise fields. `cells` is the wrap period, and x,y are mapped so the field
// tiles exactly across the 64px texture in both axes.
// ---------------------------------------------------------------------------

function field(seed, cells, oct = 4) {
  const f = new Float32Array(AREA);
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) f[y * W + x] = fbm(seed, (x * cells) / W, (y * cells) / W, oct, cells);
  }
  return f;
}
/** Anisotropic streak field - horizontal smears, still wrapping in x. */
function brushField(seed) {
  const a = makeNoise(seed, 23), b = makeNoise(seed + 17, 31);
  const f = new Float32Array(AREA);
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      f[y * W + x] = a((x * 23) / W, y * 3.1) * 0.55 + b((x * 31) / W, y * 1.3) * 0.45;
    }
  }
  return f;
}
/** Vertical streak field - drips and run marks, wrapping in x. */
function runField(seed) {
  const a = makeNoise(seed, 29), b = makeNoise(seed + 41, 13);
  const f = new Float32Array(AREA);
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      f[y * W + x] = a((x * 29) / W, y * 0.09) * 0.6 + b((x * 13) / W, y * 0.22) * 0.4;
    }
  }
  return f;
}
const F = (f, x, y) => f[idx(x, y)];

// ---------------------------------------------------------------------------
// generic painters
// ---------------------------------------------------------------------------

/** Per-pixel multiplicative film grain. White noise, so it is seamless. */
function grain(t, seed, amt) {
  const rng = makeRng(seed);
  for (let i = 0; i < AREA; i++) t[i] = mul(t[i] >>> 0, 1 + (rng() - 0.5) * 2 * amt);
}
/** Scattered specks - aggregate, dust, pitting. */
function speckle(t, seed, n, c, aLo = 0.2, aHi = 0.6, r = 0.6) {
  const rng = makeRng(seed);
  for (let i = 0; i < n; i++) {
    const x = rng() * W, y = rng() * W;
    disc(t, x, y, r * (0.6 + rng() * 0.9), c, lerp(aLo, aHi, rng()), 0.8);
  }
}
/** Horizontal box blur on the torus - turns speckle into brushed metal. */
function hblur(t, radius) {
  const r = new Float32Array(AREA), g = new Float32Array(AREA), b = new Float32Array(AREA);
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      let sr = 0, sg = 0, sb = 0, n = 0;
      for (let k = -radius; k <= radius; k++) {
        const c = at(t, x + k, y); sr += CR(c); sg += CG(c); sb += CB(c); n++;
      }
      const i = y * W + x; r[i] = sr / n; g[i] = sg / n; b[i] = sb / n;
    }
  }
  for (let i = 0; i < AREA; i++) t[i] = rgb(r[i], g[i], b[i]);
}
/** Additive bloom pass - what makes the emissive textures feel lit. */
function bloom(t, radius, thresh, strength) {
  const src = t.slice();
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      let sr = 0, sg = 0, sb = 0, n = 0;
      for (let j = -radius; j <= radius; j++) {
        for (let i = -radius; i <= radius; i++) {
          const wgt = 1 / (1 + i * i + j * j);
          const c = src[idx(x + i, y + j)];
          const l = lum(c);
          const k = l > thresh ? (l - thresh) / 255 : 0;
          sr += CR(c) * k * wgt; sg += CG(c) * k * wgt; sb += CB(c) * k * wgt; n += wgt;
        }
      }
      const i2 = y * W + x, c = t[i2];
      t[i2] = rgb(CR(c) + (sr / n) * strength, CG(c) + (sg / n) * strength, CB(c) + (sb / n) * strength);
    }
  }
}
/** Snapshot / erode-back: paint over a surface then chip the paint off again. */
function chipBack(t, snap, seed, cells, thresh, amount, oct = 4) {
  const f = field(seed, cells, oct);
  for (let i = 0; i < AREA; i++) {
    const m = clamp((f[i] - thresh) * 6, 0, 1) * amount;
    if (m > 0) t[i] = mix(t[i] >>> 0, snap[i] >>> 0, m);
  }
}
/** Top-lit gradient plus a filthy skirt at the floor line. Walls only. */
function wallLight(t, opt = {}) {
  const top = opt.top == null ? 1.20 : opt.top;
  const mid = opt.mid == null ? 1.0 : opt.mid;
  const bot = opt.bot == null ? 0.58 : opt.bot;
  const grimeH = opt.grimeH == null ? 16 : opt.grimeH;
  const grimeCol = opt.grimeCol || rgba(22, 20, 18);
  const grimeA = opt.grime == null ? 0.5 : opt.grime;
  const f = field(opt.seed == null ? 9001 : opt.seed, 6, 3);
  for (let y = 0; y < W; y++) {
    const v = y / (W - 1);
    const s = v < 0.45 ? lerp(top, mid, v / 0.45) : lerp(mid, bot, (v - 0.45) / 0.55);
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      let c = mul(t[i] >>> 0, s);
      const gy = (y - (W - grimeH)) / grimeH;
      if (gy > 0) c = mix(c, grimeCol, clamp(gy * gy, 0, 1) * grimeA * (0.45 + 0.8 * f[i]));
      const ty = (4 - y) / 4;
      if (ty > 0) c = mix(c, add(c, 22), ty * 0.5);
      t[i] = c;
    }
  }
}
/** Darken toward the cell border - reads as a slab joint on floors. */
function edgeDark(t, amount = 0.35, w = 3) {
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const dx = Math.min(x, W - 1 - x), dy = Math.min(y, W - 1 - y);
      const d = Math.min(dx, dy);
      if (d < w) blendPx(t, x, y, BLACK, (1 - d / w) * amount);
    }
  }
}
/** Green-grey damp bloom creeping up from the floor. */
function dampBloom(t, seed, strength = 0.55, col = C.damp) {
  const f = field(seed, 4, 3);
  for (let y = 0; y < W; y++) {
    const v = clamp((y / (W - 1) - 0.32) / 0.68, 0, 1);
    for (let x = 0; x < W; x++) {
      const m = clamp((f[y * W + x] - 0.44) * 2.6, 0, 1) * Math.pow(v, 1.5);
      if (m > 0) blendPx(t, x, y, col, m * strength);
    }
  }
}
/** A run of liquid down the wall - rust weep, blood, condensation. */
function drip(t, seed, x, y0, y1, col, alpha = 0.55, wdt = 1.5) {
  const rng = makeRng(seed);
  let cx = x;
  const span = Math.max(1, y1 - y0);
  for (let y = y0; y <= y1; y++) {
    cx += (rng() - 0.5) * 0.32;
    const u = (y - y0) / span;
    const fade = Math.pow(1 - u, 0.7);
    const w = wdt * (0.35 + fade * 0.9);
    const n = Math.ceil(w) + 1;
    for (let i = -n; i <= n; i++) {
      const k = clamp(1 - Math.abs(i) / (w + 0.4), 0, 1);
      blendPx(t, cx + i, y, col, k * k * alpha * (0.3 + 0.7 * fade));
    }
    if (rng() < 0.06) disc(t, cx, y, 0.9 + rng(), col, alpha * 0.8, 0.9);
  }
}
/** Lambert term for a cylinder, u = -1..1 across its width. Light upper-left. */
function cyl(u) {
  u = clamp(u, -1, 1);
  const nz = Math.sqrt(Math.max(0, 1 - u * u));
  return clamp(u * -0.55 + nz * 0.85, 0, 1);
}
/** A domed rivet head with specular and contact shadow. */
function rivet(t, cx, cy, r, base, spec = C.specHot) {
  const outer = r + 1.2;
  const n = Math.ceil(outer);
  for (let j = -n; j <= n; j++) {
    for (let i = -n; i <= n; i++) {
      const d = Math.sqrt(i * i + j * j);
      if (d > outer) continue;
      if (d > r) {
        const s = (i * 0.6 + j * 0.8) / r;
        if (s > 0) blendPx(t, cx + i, cy + j, BLACK, clamp(s, 0, 1) * 0.55 * (1 - (d - r) / 1.2));
        continue;
      }
      const nx = i / r, ny = j / r;
      const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
      const lam = clamp(nx * -0.42 + ny * -0.52 + nz * 0.75, 0, 1);
      let c = mul(base, 0.4 + 1.2 * lam);
      if (lam > 0.86) c = mix(c, spec, ((lam - 0.86) / 0.14) * 0.85);
      const rim = clamp((r - d) / 1.3, 0, 1);
      c = mix(mul(base, 0.3), c, 0.25 + rim * 0.75);
      blendPx(t, cx + i, cy + j, c, 1);
    }
  }
}
/** Flat screw head with a slot. */
function screw(t, cx, cy, r, base) {
  rivet(t, cx, cy, r, base);
  segment(t, cx - r * 0.7, cy - r * 0.7, cx + r * 0.7, cy + r * 0.7, mul(base, 0.28), 1.1, 0.9);
}
/** Branching, tapering fracture. Not a scatter of noise - a real crack. */
function crack(t, rng, x, y, ang, len, wdt, dark, chip, depth) {
  let px = x, py = y, a = ang;
  for (let s = 0; s < len; s++) {
    a += (rng() - 0.5) * 0.6;
    px += Math.cos(a); py += Math.sin(a);
    const u = s / len;
    const w = Math.max(0.35, wdt * (1 - u * u));
    disc(t, px, py, w * 0.5, dark, 0.92, 0.85);
    if (w > 0.8 && rng() < 0.7) {
      blendPx(t, px + Math.sin(a) * (w * 0.5 + 1), py - Math.cos(a) * (w * 0.5 + 1), chip, 0.3);
    }
    if (depth > 0 && s > 3 && rng() < 0.045) {
      crack(t, rng, px, py, a + (rng() < 0.5 ? -1 : 1) * (0.5 + rng() * 0.7),
        len * (0.3 + rng() * 0.35), w * 0.72, dark, chip, depth - 1);
    }
  }
}
/** Diagonal caution striping. period must divide 64 to stay seamless. */
function stripes(t, colA, colB, period, phase = 0, slope = 1, a = 1) {
  const half = period * 0.5;
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const s = (((x * slope + y + phase) % period) + period) % period;
      const edge = Math.min(s, period - s, Math.abs(s - half));
      let c = s < half ? colA : colB;
      if (edge < 1) c = mix(c, mul(c, 0.7), 1 - edge);
      blendPx(t, x, y, c, a);
    }
  }
}
/** CRT scanlines with a slightly hot line every few rows. */
function scanlines(t, x0, y0, w, h, strength = 0.35) {
  for (let y = y0; y < y0 + h; y++) {
    const dark = (y & 1) === 0;
    for (let x = x0; x < x0 + w; x++) {
      if (dark) blendPx(t, x, y, BLACK, strength);
      else if (y % 6 === 3) blendPx(t, x, y, WHITE, strength * 0.12);
    }
  }
}
/** fbm-thresholded corrosion eating in from the edges. */
function edgeRust(t, seed, amount = 1, opt = {}) {
  const fromTop = opt.top == null ? 0.35 : opt.top;
  const fromBot = opt.bot == null ? 1 : opt.bot;
  const fromSide = opt.side == null ? 0 : opt.side;
  const f = field(seed, 5, 4);
  const f2 = field(seed + 313, 12, 3);
  for (let y = 0; y < W; y++) {
    const v = y / (W - 1);
    const bias = Math.max(fromTop * Math.pow(1 - v, 2.2), fromBot * Math.pow(v, 2.2));
    for (let x = 0; x < W; x++) {
      const sx = Math.min(x, W - 1 - x) / (W * 0.5);
      const b = Math.max(bias, fromSide * Math.pow(1 - sx, 2.4));
      const n = f[y * W + x] + b * 0.3;
      const m = clamp((n - 0.63) * 3.6, 0, 1) * amount;
      if (m <= 0) continue;
      const g = f2[y * W + x];
      let c = g > 0.62 ? C.rustLt : g > 0.4 ? C.rust : C.rustDk;
      if (n > 0.98) c = mul(C.rustDk, 0.55);
      blendPx(t, x, y, c, clamp(m, 0, 0.9));
      if (m > 0.12 && m < 0.3) blendPx(t, x, y, C.rustLt, 0.35); // flake edge
    }
  }
}

// ---------------------------------------------------------------------------
// 5x7 stencil font. Chunky enough to read on a wall, small enough to fit.
// ---------------------------------------------------------------------------

const FONT = {
  ' ': '00000/00000/00000/00000/00000/00000/00000',
  '0': '01110/10001/10011/10101/11001/10001/01110',
  '1': '00100/01100/00100/00100/00100/00100/01110',
  '2': '01110/10001/00001/00010/00100/01000/11111',
  '3': '11111/00010/00100/00010/00001/10001/01110',
  '4': '00010/00110/01010/10010/11111/00010/00010',
  '5': '11111/10000/11110/00001/00001/10001/01110',
  '6': '00110/01000/10000/11110/10001/10001/01110',
  '7': '11111/00001/00010/00100/01000/01000/01000',
  '8': '01110/10001/10001/01110/10001/10001/01110',
  '9': '01110/10001/10001/01111/00001/00010/01100',
  A: '01110/10001/10001/11111/10001/10001/10001',
  B: '11110/10001/10001/11110/10001/10001/11110',
  C: '01110/10001/10000/10000/10000/10001/01110',
  D: '11100/10010/10001/10001/10001/10010/11100',
  E: '11111/10000/10000/11110/10000/10000/11111',
  F: '11111/10000/10000/11110/10000/10000/10000',
  G: '01110/10001/10000/10111/10001/10001/01111',
  H: '10001/10001/10001/11111/10001/10001/10001',
  I: '01110/00100/00100/00100/00100/00100/01110',
  J: '00111/00010/00010/00010/00010/10010/01100',
  K: '10001/10010/10100/11000/10100/10010/10001',
  L: '10000/10000/10000/10000/10000/10000/11111',
  M: '10001/11011/10101/10101/10001/10001/10001',
  N: '10001/11001/10101/10011/10001/10001/10001',
  O: '01110/10001/10001/10001/10001/10001/01110',
  P: '11110/10001/10001/11110/10000/10000/10000',
  Q: '01110/10001/10001/10001/10101/10010/01101',
  R: '11110/10001/10001/11110/10100/10010/10001',
  S: '01111/10000/10000/01110/00001/00001/11110',
  T: '11111/00100/00100/00100/00100/00100/00100',
  U: '10001/10001/10001/10001/10001/10001/01110',
  V: '10001/10001/10001/10001/10001/01010/00100',
  W: '10001/10001/10001/10101/10101/11011/01010',
  X: '10001/10001/01010/00100/01010/10001/10001',
  Y: '10001/10001/01010/00100/00100/00100/00100',
  Z: '11111/00001/00010/00100/01000/10000/11111',
  '-': '00000/00000/00000/11111/00000/00000/00000',
  '.': '00000/00000/00000/00000/00000/01100/01100',
  ':': '00000/01100/01100/00000/01100/01100/00000',
  '/': '00001/00010/00010/00100/01000/01000/10000',
  '!': '00100/00100/00100/00100/00100/00000/00100',
  '*': '00000/10101/01110/11111/01110/10101/00000',
  "'": '00100/00100/01000/00000/00000/00000/00000',
  '?': '01110/10001/00001/00110/00100/00000/00100',
  ',': '00000/00000/00000/00000/01100/00100/01000',
  '#': '01010/01010/11111/01010/11111/01010/01010',
  '+': '00000/00100/00100/11111/00100/00100/00000',
  '=': '00000/00000/11111/00000/11111/00000/00000',
  '&': '01100/10010/10100/01000/10101/10010/01101',
  '>': '01000/00100/00010/00001/00010/00100/01000',
  '<': '00010/00100/01000/10000/01000/00100/00010',
  '(': '00010/00100/01000/01000/01000/00100/00010',
  ')': '01000/00100/00010/00010/00010/00100/01000',
  '%': '11001/11010/00010/00100/01000/01011/10011',
};
const GLYPHS = (() => {
  const m = {};
  for (const k in FONT) m[k] = FONT[k].split('/');
  return m;
})();

function textWidth(s, scale) { return s.length * 6 * scale - scale; }

function drawText(t, s, x, y, scale, col, opt = {}) {
  if (opt.shadow) {
    drawText(t, s, x + Math.max(1, scale * 0.5), y + Math.max(1, scale * 0.5), scale,
      opt.shadowCol || BLACK, { alpha: opt.shadowAlpha == null ? 0.5 : opt.shadowAlpha });
  }
  const a = opt.alpha == null ? 1 : opt.alpha;
  let cx = x;
  const str = String(s).toUpperCase();
  for (let n = 0; n < str.length; n++) {
    const g = GLYPHS[str[n]];
    if (g) {
      for (let r = 0; r < 7; r++) {
        const row = g[r];
        for (let c2 = 0; c2 < 5; c2++) {
          if (row.charCodeAt(c2) !== 49) continue;
          for (let j = 0; j < scale; j++) {
            for (let i = 0; i < scale; i++) blendPx(t, cx + c2 * scale + i, y + r * scale + j, col, a);
          }
        }
      }
    }
    cx += 6 * scale;
  }
  return cx - x - scale;
}
function drawTextCentered(t, s, cx, y, scale, col, opt) {
  return drawText(t, s, Math.round(cx - textWidth(s, scale) / 2), y, scale, col, opt);
}

// ---------------------------------------------------------------------------
// material bases
// ---------------------------------------------------------------------------

function concreteBase(t, seed, opt = {}) {
  const tone = opt.tone == null ? 1 : opt.tone;
  const lo = opt.lo || C.concDk, hi = opt.hi || C.conc;
  const broad = field(seed, opt.cells || 3, 5);
  const patch = field(seed + 211, 9, 3);
  const agg = field(seed + 77, 16, 3);
  const fine = field(seed + 151, 32, 2);
  for (let i = 0; i < AREA; i++) {
    let c = mix(lo, hi, clamp(broad[i] * 1.55 - 0.28 + (patch[i] - 0.5) * 0.35, 0, 1));
    const a = agg[i];
    c = mix(c, add(c, 52), clamp((a - 0.57) * 4, 0, 1) * 0.85);  // pale aggregate
    c = mix(c, mul(c, 0.44), clamp((0.4 - a) * 4, 0, 1) * 0.8);  // blow holes
    c = mul(c, 0.9 + fine[i] * 0.2);
    t[i] = mul(c, tone);
  }
}

function steelBase(t, seed, opt = {}) {
  const base = opt.col || C.steel;
  const b = brushField(seed);
  const blot = field(seed + 61, 4, 3);
  for (let i = 0; i < AREA; i++) {
    let c = mix(mul(base, 0.6), mul(base, 1.22), clamp(b[i] * 1.25 - 0.12, 0, 1));
    c = mix(c, mul(c, 0.82), clamp((blot[i] - 0.5) * 2, 0, 1) * 0.5);
    t[i] = c;
  }
  grain(t, seed + 9, 0.055);
  hblur(t, 1);
}

/** Recessed dimple - a form tie hole, a drilled anchor. */
function dimple(t, cx, cy, r, dark) {
  const n = Math.ceil(r) + 2;
  for (let j = -n; j <= n; j++) {
    for (let i = -n; i <= n; i++) {
      const d = Math.hypot(i, j);
      if (d > r + 1.6) continue;
      if (d <= r) {
        // inside a hole the far (lower) wall catches the light
        const k = clamp((j / r) * 0.5 + 0.5, 0, 1);
        blendPx(t, cx + i, cy + j, mix(mul(dark, 0.5), add(dark, 34), Math.pow(k, 2)), 0.94);
      } else {
        const s = -(i * 0.4 + j * 0.75) / r;
        blendPx(t, cx + i, cy + j, s > 0 ? add(C.conc, 26) : BLACK,
          clamp(Math.abs(s), 0, 1) * 0.4 * (1 - (d - r) / 1.6));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 0  CONCRETE
// ---------------------------------------------------------------------------
function paintConcrete(t) {
  concreteBase(t, 1101, { tone: 1.08 });
  const wob = field(1177, 6, 2);
  for (const sy of [21, 43]) {                       // shuttering board seams
    for (let x = 0; x < W; x++) {
      const y = sy + (wob[idx(x, sy)] - 0.5) * 1.8;
      blendPx(t, x, y - 1, add(C.conc, 22), 0.28);
      blendPx(t, x, y, C.concDk, 0.6);
      blendPx(t, x, y + 1, BLACK, 0.2);
    }
  }
  for (let x = 11; x < W; x += 32) {                 // form tie holes (period 32)
    for (const y of [13, 35, 57]) dimple(t, x, y, 2.4, mul(C.concDk, 0.8));
  }
  const wash = runField(4241);                       // decades of water down one line
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const v = wash[y * W + x];
      if (v > 0.56) blendPx(t, x, y, mul(C.concDk, 0.6), clamp((v - 0.56) * 2.6, 0, 1) * 0.45 * (0.3 + y / W));
    }
  }
  drip(t, 4242, 43, 22, 60, mul(C.concDk, 0.5), 0.55, 2.4);  // the wall weeps
  drip(t, 4243, 11, 14, 40, mul(C.rustDk, 0.85), 0.3, 1.2);
  speckle(t, 4244, 90, add(C.conc, 40), 0.15, 0.4, 0.7);
  speckle(t, 4245, 60, mul(C.concDk, 0.6), 0.15, 0.45, 0.7);
  dampBloom(t, 4246, 0.8);
  speckle(t, 4249, 55, C.moss, 0.15, 0.4, 1.3);
  speckle(t, 4250, 40, add(C.conc, 64), 0.15, 0.45, 0.9);
  grain(t, 4247, 0.085);
  wallLight(t, { seed: 4248 });
}

// ---------------------------------------------------------------------------
// 1  CONCRETE_CRACKED
// ---------------------------------------------------------------------------
function paintConcreteCracked(t) {
  concreteBase(t, 1301);
  const wob = field(1377, 6, 2);
  for (const sy of [21, 43]) {
    for (let x = 0; x < W; x++) {
      const y = sy + (wob[idx(x, sy)] - 0.5) * 1.8;
      blendPx(t, x, y, C.concDk, 0.5);
      blendPx(t, x, y - 1, add(C.conc, 18), 0.24);
    }
  }
  // spall: a chunk of face knocked out, exposing pale aggregate and rebar
  const sp = field(1399, 7, 4);
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const dx = (x - 41) / 13, dy = (y - 40) / 11;
      const d = Math.sqrt(dx * dx + dy * dy) - (sp[y * W + x] - 0.5) * 0.85;
      if (d < 1) {
        const i = y * W + x;
        const deep = clamp((1 - d) * 1.6, 0, 1);
        let c = mix(t[i], mul(C.concMid, 0.72), deep * 0.9);
        c = mix(c, add(c, 46), clamp((sp[i] - 0.55) * 5, 0, 1) * 0.55);
        t[i] = c;
        if (d > 0.82) t[i] = mix(t[i], BLACK, 0.4);   // shadowed lip
        if (d > 0.68 && d < 0.82) t[i] = mix(t[i], add(C.conc, 40), 0.35);
      }
    }
  }
  for (const [x0, y0, x1, y1] of [[32, 36, 50, 34], [33, 44, 51, 43]]) {   // exposed rebar
    segment(t, x0, y0 + 1, x1, y1 + 1, BLACK, 2.4, 0.5);
    segment(t, x0, y0, x1, y1, mul(C.rustDk, 1.15), 2, 0.95);
    segment(t, x0, y0 - 0.6, x1, y1 - 0.6, C.rust, 0.9, 0.7);
  }
  const rng = makeRng(90210);
  crack(t, rng, 27, 2, 1.45, 58, 2.6, mul(C.concDk, 0.4), add(C.conc, 46), 3);
  crack(t, rng, 8, 63, -1.35, 26, 1.6, mul(C.concDk, 0.45), add(C.conc, 38), 2);
  speckle(t, 1344, 70, add(C.conc, 40), 0.15, 0.4, 0.7);
  dampBloom(t, 1346, 0.45);
  grain(t, 1347, 0.085);
  wallLight(t, { seed: 1348 });
}

// ---------------------------------------------------------------------------
// 2  STEEL_PLATE
// ---------------------------------------------------------------------------
function paintSteelPlate(t) {
  steelBase(t, 2101);
  // plate joint straddling the cell seam, so plates read across the corridor
  for (let y = 0; y < W; y++) {
    blendPx(t, 63, y, mul(C.steelDk, 0.75), 0.85);
    blendPx(t, 0, y, mul(C.steelDk, 0.6), 0.9);
    blendPx(t, 1, y, C.spec, 0.35);
    blendPx(t, 62, y, mul(C.steel, 0.75), 0.4);
  }
  // weld bead across the middle - lumpy, hot-looking, the story of the plate
  const wob = field(2177, 8, 2);
  for (let x = 0; x < W; x++) {
    const y = 32 + (wob[idx(x, 32)] - 0.5) * 2.2;
    const lump = 0.5 + 0.5 * Math.sin(x * 1.35);
    blendPx(t, x, y - 2, BLACK, 0.22);
    blendPx(t, x, y - 1, mix(C.spec, C.steel, 1 - lump), 0.75);
    blendPx(t, x, y, mix(C.specHot, C.steel, 0.35 - lump * 0.3), 0.9);
    blendPx(t, x, y + 1, mul(C.steelDk, 0.9), 0.8);
    blendPx(t, x, y + 2, BLACK, 0.3);
    blendPx(t, x, y + 3, mul(C.rustDk, 1.1), 0.2);
  }
  const rng = makeRng(2199);                       // scratches
  for (let s = 0; s < 14; s++) {
    const x = rng() * W, y = rng() * W, l = 3 + rng() * 12, a = (rng() - 0.5) * 0.5;
    segment(t, x, y, x + Math.cos(a) * l, y + Math.sin(a) * l, C.spec, 1, 0.3 + rng() * 0.3);
  }
  edgeRust(t, 2233, 0.55, { top: 0.1, bot: 0.7, side: 0 });
  drip(t, 2244, 22, 34, 60, mul(C.rustDk, 1.05), 0.4, 1.4);
  grain(t, 2247, 0.06);
  wallLight(t, { seed: 2248, grime: 0.55 });
}

// ---------------------------------------------------------------------------
// 3  STEEL_RIVET
// ---------------------------------------------------------------------------
function paintSteelRivet(t) {
  steelBase(t, 3101, { col: addRGB(C.steel, 4, 2, 0) });
  // two plates per cell, joints at x=0 (split across the seam) and x=32
  for (const jx of [0, 32]) {
    for (let y = 0; y < W; y++) {
      blendPx(t, jx - 1, y, mul(C.steelDk, 0.55), 0.85);
      blendPx(t, jx, y, mul(C.steelDk, 0.8), 0.7);
      blendPx(t, jx + 1, y, C.spec, 0.3);
    }
  }
  hline(t, 3, 0, 63, mul(C.steelDk, 0.7), 0.6);
  hline(t, 4, 0, 63, C.spec, 0.22);
  hline(t, 60, 0, 63, mul(C.steelDk, 0.7), 0.6);
  hline(t, 59, 0, 63, C.spec, 0.18);
  const base = addRGB(C.steel, 26, 24, 18);
  for (const y of [8, 22, 36, 50]) {               // rivets down both joints
    for (const jx of [0, 32]) rivet(t, jx, y, 3, base);
  }
  for (const x of [8, 24, 40, 56]) {               // and along the top/bottom rails
    rivet(t, x, 8, 2.6, base);
    rivet(t, x, 55, 2.6, base);
  }
  edgeRust(t, 3233, 0.5, { top: 0.12, bot: 0.62, side: 0 });
  for (const y of [8, 22, 36, 50]) drip(t, 3300 + y, 32, y + 3, y + 16, mul(C.rustDk, 1.1), 0.3, 1.1);
  grain(t, 3247, 0.06);
  wallLight(t, { seed: 3248, grime: 0.5 });
}

// ---------------------------------------------------------------------------
// 4  HAZARD
// ---------------------------------------------------------------------------
function paintHazard(t) {
  steelBase(t, 4101, { col: C.steelMid });
  const snap = t.slice();
  stripes(t, C.yellow, C.black, 16, 0, 1, 1);
  // hand-painted unevenness
  const f = field(4155, 8, 3);
  for (let i = 0; i < AREA; i++) t[i] = mul(t[i], 0.86 + f[i] * 0.3);
  chipBack(t, snap, 4177, 6, 0.56, 1, 4);          // paint knocked off
  chipBack(t, snap, 4188, 20, 0.66, 0.9, 3);       // fine scuffing
  // bright chipped edges where paint lifted
  const ff = field(4177, 6, 4);
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const v = ff[y * W + x];
      if (v > 0.545 && v < 0.575) blendPx(t, x, y, C.specHot, 0.25);
    }
  }
  // bottom kick strip: things have been dragged along this wall
  for (let y = 48; y < W; y++) {                    // everything gets dragged along this wall
    const k = (y - 48) / 16;
    for (let x = 0; x < W; x++) {
      if (((x * 7 + y * 13) % 11) < 2) blendPx(t, x, y, snap[y * W + x], k * 0.55);
      blendPx(t, x, y, mul(C.steelDk, 0.8), k * 0.35);
    }
  }
  edgeRust(t, 4233, 0.7, { top: 0.1, bot: 0.9, side: 0 });
  grain(t, 4247, 0.075);
  wallLight(t, { seed: 4248, top: 1.12, bot: 0.62, grime: 0.55 });
}

// ---------------------------------------------------------------------------
// 5  PIPES  - four risers, the outer one split across the cell seam
// ---------------------------------------------------------------------------
function paintPipes(t, opt = {}) {
  concreteBase(t, 5101, { tone: 0.66 });
  for (let i = 0; i < AREA; i++) t[i] = mul(t[i], 0.85);
  const centres = [0, 16, 32, 48];
  const R = 6;
  const grimeF = runField(5133);
  const rustF = field(5155, 6, 4);
  for (const cx of centres) {
    for (let dx = -R - 3; dx <= R + 3; dx++) {
      const u = dx / R;
      if (dx > R) {                                  // cast shadow on the wall
        blendPx(t, cx + dx, 0, BLACK, 0);
        for (let y = 0; y < W; y++) blendPx(t, cx + dx, y, BLACK, clamp(1 - (dx - R) / 3.5, 0, 1) * 0.45);
        continue;
      }
      if (Math.abs(u) > 1) continue;
      const lam = cyl(u);
      for (let y = 0; y < W; y++) {
        let c = mix(mul(C.steelDk, 0.85), mul(C.steel, 1.16), lam);
        if (u > -0.72 && u < -0.28) c = mix(c, C.specHot, 0.32 * (1 - Math.abs(u + 0.5) / 0.22));
        c = mul(c, 0.86 + grimeF[idx(cx + dx, y)] * 0.3);
        const rv = rustF[idx(cx + dx, y)];
        if (rv > 0.6) c = mix(c, mix(C.rustDk, C.rust, lam), clamp((rv - 0.6) * 3.4, 0, 0.8));
        if (Math.abs(u) > 0.93) c = mul(c, 0.55);    // silhouette edge
        put(t, cx + dx, y, c);
      }
    }
  }
  // flanges, staggered so the bank does not read as a barcode
  const flange = (cx, fy) => {
    for (let dx = -R - 2; dx <= R + 2; dx++) {
      const u = dx / (R + 2);
      if (Math.abs(u) > 1) continue;
      const lam = cyl(u);
      for (let y = fy; y < fy + 7; y++) {
        const e = y === fy || y === fy + 6 ? 0.55 : 1;
        let c = mix(mul(C.steelDk, 0.9), mul(C.steel, 1.3), lam);
        c = mul(c, e);
        if (y === fy + 1) c = mix(c, C.specHot, 0.3 * lam);
        if (y === fy + 3) c = mul(c, 0.6);           // gasket groove
        put(t, cx + dx, y, c);
      }
      for (let y = fy + 7; y < fy + 10; y++) blendPx(t, cx + dx, y, BLACK, (1 - (y - fy - 7) / 3) * 0.5);
    }
    for (const bx of [-R + 1, R - 1]) rivet(t, cx + bx, fy + 3, 1.5, C.spec);
  };
  flange(0, 12); flange(32, 12); flange(16, 44); flange(48, 44);
  // valve wheel on the middle riser
  const vx = 32, vy = 34;
  const vcol = opt.valveCol || rgba(150, 52, 40), vhi = opt.valveHi || rgba(206, 96, 74);
  if (opt.valve !== false) {
  for (let j = -13; j <= 13; j++) {
    for (let i = -13; i <= 13; i++) {
      const d = Math.hypot(i, j);
      if (d > 12.4 || d < 9.2) continue;
      const u = (d - 10.8) / 1.6;
      const lam = clamp(cyl(u) * 0.7 + 0.3 - j * 0.02 - i * 0.012, 0, 1);
      blendPx(t, vx + i, vy + j, mix(mul(vcol, 0.5), vhi, lam), 1);
    }
  }
  for (let k = 0; k < 5; k++) {
    const a = k * (6.283 / 5) - 0.4;
    segment(t, vx, vy, vx + Math.cos(a) * 11, vy + Math.sin(a) * 11, mix(vcol, vhi, 0.3), 2.1, 1);
    segment(t, vx - 0.5, vy - 0.6, vx + Math.cos(a) * 10, vy + Math.sin(a) * 10 - 0.6, add(vhi, 8), 0.9, 0.55);
  }
  disc(t, vx, vy, 3.4, mul(vcol, 0.8), 1, 1);
  rivet(t, vx, vy, 2.2, C.spec);
  glow(t, vx + 2, vy + 3, 16, BLACK, 0.28, 1.6);
  }
  drip(t, 5301, 16, 51, 63, mul(C.rustDk, 1.1), 0.5, 1.6);
  drip(t, 5302, 33, 19, 44, mul(C.rustDk, 0.9), 0.35, 1.2);
  if (opt.extra) opt.extra(t);
  grain(t, 5247, 0.06);
  wallLight(t, { seed: 5248, top: 1.14, bot: 0.6, grime: 0.5 });
}

// ---------------------------------------------------------------------------
// 6  VENT
// ---------------------------------------------------------------------------
function paintVent(t) {
  steelBase(t, 6101, { col: C.steelMid });
  rect(t, 4, 4, 56, 56, mul(C.steelDk, 0.35), 1);         // recess
  bevel(t, 3, 3, 58, 58, mul(C.steelDk, 0.5), C.spec, false, 2, 0.7);
  const dust = field(6155, 10, 3);
  for (let sy = 7; sy < 57; sy += 7) {                    // louvre slats
    for (let x = 5; x < 59; x++) {
      blendPx(t, x, sy, BLACK, 0.92);                     // gap above the slat
      blendPx(t, x, sy + 1, BLACK, 0.6);
      const d = dust[idx(x, sy)];
      blendPx(t, x, sy + 2, mix(C.spec, C.steel, 0.15 + d * 0.5), 0.95);   // lit lip
      blendPx(t, x, sy + 3, mix(C.steel, C.steelDk, 0.15 + d * 0.4), 1);
      blendPx(t, x, sy + 4, mix(C.steelMid, C.steelDk, 0.55 + d * 0.3), 1);
      blendPx(t, x, sy + 5, mul(C.steelDk, 0.72), 1);
      blendPx(t, x, sy + 6, mul(C.steelDk, 0.42), 1);
    }
  }
  for (let y = 5; y < 59; y++) {                          // centre mullion
    const c = mix(C.steel, C.steelDk, 0.35);
    put(t, 31, y, mul(c, 1.25)); put(t, 32, y, c); put(t, 33, y, mul(c, 0.55));
  }
  for (const [x, y] of [[8, 8], [55, 8], [8, 55], [55, 55]]) screw(t, x, y, 2.2, C.spec);
  edgeRust(t, 6233, 0.5, { top: 0.2, bot: 0.62, side: 0.25 });
  drip(t, 6301, 20, 40, 62, mul(C.rustDk, 1.1), 0.45, 1.4);
  drip(t, 6302, 46, 12, 34, mul(C.rustDk, 0.9), 0.3, 1.1);
  grain(t, 6247, 0.05);
  wallLight(t, { seed: 6248, top: 1.14, bot: 0.66, grime: 0.45 });
}

// ---------------------------------------------------------------------------
// 7  TILE
// ---------------------------------------------------------------------------
function tileField(t, seed, opt = {}) {
  const size = opt.size || 16;
  const face = opt.face || C.tile;
  const dark = opt.dark || C.tileDk;
  const grout = opt.grout || C.grout;
  const rng = makeRng(seed);
  const tint = [];
  for (let i = 0; i < (W / size) * (W / size); i++) tint.push(rng());
  const dirt = field(seed + 51, 6, 4);
  const fine = field(seed + 91, 24, 2);
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const tx = Math.floor(x / size), ty = Math.floor(y / size);
      const lx = x % size, ly = y % size;
      const i = y * W + x;
      if (lx < 2 || ly < 2) {                              // grout channel
        const deep = (lx === 0 || ly === 0) ? 1 : 0.6;
        let c = mul(grout, 0.5 + fine[i] * 0.5);
        c = mul(c, 1 - deep * 0.3);
        c = mix(c, mul(C.dirtDk, 0.8), clamp(dirt[i], 0, 1) * 0.65);
        t[i] = c;
        continue;
      }
      const v = tint[ty * (W / size) + tx];
      let c = mix(dark, face, 0.12 + v * 0.88);
      const gx = (lx - 2) / (size - 2), gy = (ly - 2) / (size - 2);
      c = mul(c, 1.12 - gy * 0.26 - gx * 0.05);            // per-tile top light
      if (gy < 0.12) c = mix(c, add(c, 40), 0.5 - gy * 3);  // glaze highlight
      c = mix(c, mul(C.dirtDk, 1.1), clamp((dirt[i] - 0.4) * 2.2, 0, 1) * 0.55);
      if (gy > 0.86 || gx > 0.9) c = mul(c, 0.86);          // grime in the corners
      c = mul(c, 0.94 + fine[i] * 0.12);
      t[i] = c;
    }
  }
}

function paintTile(t) {
  tileField(t, 7101);
  const rng = makeRng(7133);
  crack(t, rng, 39, 20, 1.5, 22, 1.3, mul(C.grout, 0.5), add(C.tile, 30), 1);  // cracked tile
  for (const [x, y] of [[18, 33], [50, 49], [33, 3]]) {                        // chipped corners
    disc(t, x, y, 2.2, mul(C.grout, 0.8), 0.85, 1);
    disc(t, x - 0.6, y - 0.6, 1.4, add(C.tileDk, 20), 0.5, 1);
  }
  speckle(t, 7144, 70, mul(C.dirtDk, 1.2), 0.1, 0.3, 0.8);
  dampBloom(t, 7155, 0.5);
  drip(t, 7166, 27, 6, 34, mul(C.dirtDk, 1.1), 0.3, 1.3);
  grain(t, 7177, 0.07);
  wallLight(t, { seed: 7188, top: 1.16, bot: 0.6, grime: 0.55 });
}

// ---------------------------------------------------------------------------
// 8  TILE_BLOOD
// ---------------------------------------------------------------------------
function paintTileBlood(t) {
  tileField(t, 8101, { face: mul(C.tile, 0.9), dark: mul(C.tileDk, 0.85) });
  const rng = makeRng(8133);
  // arterial splatter, high and wide
  for (let i = 0; i < 46; i++) {
    const a = rng() * 6.283, d = Math.pow(rng(), 0.6) * 26;
    const x = 36 + Math.cos(a) * d, y = 17 + Math.sin(a) * d * 0.8;
    const r = 0.5 + Math.pow(rng(), 2) * 2.6;
    disc(t, x, y, r, rng() < 0.4 ? C.bloodDk : C.blood, 0.8, 0.9);
  }
  disc(t, 36, 17, 9, C.blood, 0.9, 3);
  disc(t, 35, 15, 5.5, C.bloodDk, 0.75, 3);
  for (let i = 0; i < 7; i++) {                        // runs down the grout
    const x = 22 + i * 6 + rng() * 3;
    drip(t, 8200 + i, x, 18 + rng() * 8, 42 + rng() * 21, C.blood, 0.75, 1.1 + rng());
  }
  // pooling at the skirting
  const pool = field(8177, 7, 3);
  for (let y = 46; y < W; y++) {
    const k = Math.pow((y - 46) / 18, 1.3);
    for (let x = 0; x < W; x++) {
      const m = clamp(k * (0.45 + pool[y * W + x] * 1.1) - 0.12, 0, 1);
      if (m > 0) {
        blendPx(t, x, y, mix(C.bloodDk, C.blood, pool[y * W + x]), clamp(m, 0, 0.92));
        if (m > 0.25 && m < 0.36) blendPx(t, x, y, C.bloodWet, 0.28);   // crust rim
      }
    }
  }
  for (let i = 0; i < 40; i++) {                       // wet sheen
    const x = rng() * W, y = 48 + rng() * 15;
    disc(t, x, y, 0.6 + rng(), C.bloodWet, 0.25, 1);
  }
  grain(t, 8177, 0.07);
  wallLight(t, { seed: 8188, top: 1.14, bot: 0.62, grime: 0.5 });
}

// ---------------------------------------------------------------------------
// 9  RUST
// ---------------------------------------------------------------------------
function paintRust(t) {
  steelBase(t, 9101, { col: mul(C.steel, 0.9) });
  const a = field(9111, 3, 5), b = field(9222, 8, 4), c3 = field(9333, 22, 3);
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const v = a[i] * 0.62 + b[i] * 0.38;
      let col = null, k = 0;
      if (v > 0.44) { col = add(C.rustLt, 22); k = clamp((v - 0.44) * 7, 0, 1) * 0.7; }
      if (v > 0.52) { col = C.rust; k = clamp((v - 0.52) * 8, 0, 1) * 0.95; }
      if (v > 0.62) { col = C.rustDk; k = 1; }
      if (v > 0.72) { col = mul(C.rustDk, 0.5); k = 1; }
      if (col) {
        t[i] = mix(t[i], mul(col, 0.78 + c3[i] * 0.48), clamp(k, 0, 1));
        if (v > 0.615 && v < 0.638) t[i] = mix(t[i], add(C.rustLt, 40), 0.75);  // flake lip
        if (v > 0.715 && v < 0.735) t[i] = mix(t[i], C.rustLt, 0.5);
        if (v > 0.515 && v < 0.532) t[i] = mix(t[i], add(C.rustLt, 26), 0.55);
      }
      if (v > 0.8 && c3[i] > 0.58) t[i] = mix(t[i], rgba(14, 10, 10), 0.9);      // pit through
    }
  }
  for (let i = 0; i < 5; i++) drip(t, 9400 + i, 6 + i * 13, 16 + i * 6, 52 + (i % 3) * 6, mul(C.rustDk, 1.05), 0.5, 1.6);
  speckle(t, 9444, 120, mul(C.rustDk, 0.5), 0.2, 0.5, 0.7);
  speckle(t, 9445, 70, C.rustLt, 0.15, 0.4, 0.6);
  grain(t, 9247, 0.09);
  wallLight(t, { seed: 9248, top: 1.16, bot: 0.6, grime: 0.5 });
}

// ---------------------------------------------------------------------------
// 10  SANDBAG
// ---------------------------------------------------------------------------
function paintSandbag(t) {
  fill(t, mul(C.dirtDk, 0.55));
  const weave = field(10133, 32, 2);
  const dirtF = field(10155, 5, 4);
  const rng = makeRng(10101);
  const rowTint = [];
  for (let i = 0; i < 6 * 5; i++) rowTint.push(rng());
  for (let r = 0; r < 6; r++) {
    const y0 = -6 + r * 13;
    const cy = y0 + 6.5;
    const off = (r % 2) * 8;
    for (let x = 0; x < W; x++) {                       // shadow under the row above
      for (let y = y0 - 2; y < y0 + 2; y++) blendPx(t, x, y, BLACK, 0.5);
    }
    for (let k = 0; k < 4; k++) {
      const cx = off + k * 16 + 8;
      const tint = rowTint[r * 5 + k];
      const hw = 8.6, hh = 6.6;
      for (let j = -8; j <= 8; j++) {
        for (let i = -10; i <= 10; i++) {
          const nx = i / hw, ny = j / hh;
          const d2 = Math.pow(Math.abs(nx), 2.3) + Math.pow(Math.abs(ny), 2.3);
          if (d2 > 1) continue;
          const x = cx + i, y = cy + j;
          const nz = Math.sqrt(Math.max(0, 1 - d2));
          const lam = clamp(nx * -0.4 + ny * -0.46 + nz * 0.8, 0, 1);
          let c = mix(mul(C.burlapDk, 0.7), mul(C.burlap, 1.15), lam);
          c = mix(c, mul(c, 0.86), tint * 0.5);
          const wv = weave[idx(x, y)];
          c = mul(c, 0.9 + wv * 0.2);
          if (((x + y) & 1) === 0) c = mul(c, 0.95);     // hessian weave
          c = mix(c, mul(C.dirt, 0.6), clamp((dirtF[idx(x, y)] - 0.5) * 2.4, 0, 1) * 0.4);
          if (d2 > 0.86) c = mul(c, 0.62 + (1 - d2) * 2);
          blendPx(t, x, y, c, 1);
        }
      }
      // stitched seam along the crown of the bag
      for (let i = -6; i <= 6; i++) {
        if (((i + 60) % 3) === 0) continue;
        blendPx(t, cx + i, cy - 4.4 + Math.abs(i) * 0.1, mul(C.burlapDk, 0.7), 0.65);
        blendPx(t, cx + i, cy - 5.4 + Math.abs(i) * 0.1, add(C.burlap, 26), 0.35);
      }
      blendPx(t, cx - 8.4, cy, mul(C.burlapDk, 0.5), 0.6);
      blendPx(t, cx + 8.4, cy, mul(C.burlapDk, 0.5), 0.6);
    }
  }
  speckle(t, 10222, 80, mul(C.dirtDk, 1.2), 0.15, 0.4, 0.8);
  speckle(t, 10223, 50, add(C.burlap, 30), 0.1, 0.3, 0.6);
  grain(t, 10247, 0.09);
  wallLight(t, { seed: 10248, top: 1.14, bot: 0.62, grime: 0.5 });
}

// ---------------------------------------------------------------------------
// 11  SCREENS  (emissive)
// ---------------------------------------------------------------------------
function crtScreen(t, x, y, w, h, kind, seed) {
  const rng = makeRng(seed);
  const glass = rgba(8, 12, 12);
  rect(t, x - 2, y - 2, w + 4, h + 4, mul(C.steelDk, 0.55));         // bezel
  bevel(t, x - 2, y - 2, w + 4, h + 4, C.steel, BLACK, true, 1, 0.6);
  bevel(t, x - 1, y - 1, w + 2, h + 2, BLACK, mul(C.steel, 0.7), false, 1, 0.8);
  rect(t, x, y, w, h, glass);
  const mid = y + h / 2;
  if (kind === 'wave') {
    for (let i = 0; i < w; i += 4) vline(t, x + i, y, y + h - 1, rgba(20, 54, 34), 0.9);
    for (let j = 0; j < h; j += 4) hline(t, y + j, x, x + w - 1, rgba(20, 54, 34), 0.9);
    for (let i = 0; i < w; i++) {
      const p = i / w * 6.283;
      const v = Math.sin(p * 2.1) * 0.5 + Math.sin(p * 5.3 + 1.1) * 0.28 + Math.sin(p * 11 + 2) * 0.12;
      const yy = mid + v * (h * 0.36);
      disc(t, x + i, yy, 0.9, C.green, 0.95, 1.1);
      blendPx(t, x + i, yy + 1.6, C.green, 0.3);
      blendPx(t, x + i, yy - 1.6, C.green, 0.3);
    }
    rect(t, x, y + h - 8, w, 8, rgba(6, 12, 10), 0.8);
    drawText(t, '07', x + 2, y + h - 8, 1, mul(C.green, 0.9), { alpha: 0.95 });
    for (let k = 0; k < 3; k++) rect(t, x + 15 + k * 3, y + h - 6, 2, 4, C.green, 0.55 + k * 0.15);
  } else if (kind === 'text') {
    drawText(t, 'silo', x + 1, y + 2, 1, C.amber);
    for (let r = 0; r < 5; r++) {
      const yy = y + 12 + r * 4;
      let cx = x + 1;
      while (cx < x + w - 2) {
        const len = 2 + Math.floor(rng() * 6);
        if (rng() < 0.78) rect(t, cx, yy, Math.min(len, x + w - 1 - cx), 2, C.amber, 0.85);
        cx += len + 2;
      }
    }
    rect(t, x + 1, y + h - 4, 3, 3, C.amber, 1);                      // cursor
  } else if (kind === 'radar') {
    const cx = x + w / 2, cy = y + h / 2, R = Math.min(w, h) * 0.45;
    for (const rr of [R, R * 0.66, R * 0.33]) {
      for (let a = 0; a < 6.283; a += 0.06) {
        blendPx(t, cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, rgba(30, 96, 56), 0.9);
      }
    }
    vline(t, Math.round(cx), y + 1, y + h - 2, rgba(26, 80, 48), 0.8);
    hline(t, Math.round(cy), x + 1, x + w - 2, rgba(26, 80, 48), 0.8);
    const sa = -0.9;
    for (let d = 0; d < R; d += 0.5) {
      blendPx(t, cx + Math.cos(sa) * d, cy + Math.sin(sa) * d, C.green, 0.9 - d / R * 0.4);
    }
    for (let k = 0; k < 8; k++) {
      const a = sa - 0.15 - k * 0.14;
      for (let d = 0; d < R; d += 0.6) blendPx(t, cx + Math.cos(a) * d, cy + Math.sin(a) * d, C.green, (0.5 - k * 0.06) * 0.5);
    }
    for (let k = 0; k < 4; k++) {
      const a = rng() * 6.283, d = rng() * R * 0.9;
      disc(t, cx + Math.cos(a) * d, cy + Math.sin(a) * d, 1.1, rgba(180, 255, 200), 0.95, 1);
    }
  } else {                                                            // dead set
    for (let i = 0; i < w; i++) blendPx(t, x + i, mid + Math.sin(i * 0.9) * 0.4, rgba(90, 130, 100), 0.55);
    rect(t, x, y + 3, w, 2, rgba(40, 60, 48), 0.5);                   // vertical hold bar
    rect(t, x, y + 4, w, 1, rgba(70, 100, 80), 0.4);
    drawText(t, 'err', x + 3, y + h - 10, 1, rgba(120, 60, 40), { alpha: 0.8 });
  }
  scanlines(t, x, y, w, h, 0.42);
  for (let j = 0; j < h; j++) {                                       // glass curvature
    for (let i = 0; i < w; i++) {
      const nx = (i / (w - 1)) * 2 - 1, ny = (j / (h - 1)) * 2 - 1;
      const v = Math.max(Math.abs(nx), Math.abs(ny));
      if (v > 0.8) blendPx(t, x + i, y + j, BLACK, (v - 0.8) * 1.6);
      if (nx < -0.35 && ny < -0.3 && nx > -0.85 && ny > -0.8) blendPx(t, x + i, y + j, WHITE, 0.07);
    }
  }
}

function paintScreens(t) {
  fill(t, rgba(17, 18, 22));
  const f = field(11101, 8, 3);
  for (let i = 0; i < AREA; i++) t[i] = mul(t[i], 0.75 + f[i] * 0.55);
  for (const x of [0, 31, 62]) { vline(t, x, 0, 63, mul(C.steelDk, 0.9), 0.9); vline(t, x + 1, 0, 63, mul(C.steel, 0.55), 0.5); }
  for (const y of [0, 31, 62]) { hline(t, y, 0, 63, mul(C.steelDk, 0.9), 0.8); hline(t, y + 1, 0, 63, mul(C.steel, 0.5), 0.4); }
  crtScreen(t, 6, 6, 22, 21, 'wave', 1111);
  crtScreen(t, 37, 6, 22, 21, 'text', 2222);
  crtScreen(t, 6, 37, 22, 21, 'radar', 3333);
  crtScreen(t, 37, 37, 22, 21, 'dead', 4444);
  for (let k = 0; k < 6; k++) {                        // rack indicator lamps
    const x = 4 + k * 11, on = k !== 3 && k !== 5;
    const col = k % 2 ? C.amber : C.cyan;
    disc(t, x, 33, 1.2, on ? col : rgba(40, 30, 24), on ? 1 : 0.9, 0.9);
    if (on) glow(t, x, 33, 4, col, 0.5, 2);
  }
  bloom(t, 3, 96, 0.9);
  grain(t, 11247, 0.045);
}

// ---------------------------------------------------------------------------
// 12  CIRCUIT  (emissive)
// ---------------------------------------------------------------------------
function paintCircuit(t, alt = 0) {
  const board = rgba(16, 34, 26);
  fill(t, board);
  const weaveF = field(12101, 24, 2);
  const blot = field(12111, 5, 3);
  for (let i = 0; i < AREA; i++) {
    t[i] = mul(mix(t[i], rgba(24, 48, 34), blot[i] * 0.7), 0.86 + weaveF[i] * 0.28);
  }
  const trace = rgba(72, 132, 92), traceHi = rgba(110, 186, 128), copper = rgba(168, 122, 54);
  const rng = makeRng(12133 + alt * 977);
  const drawTrace = (x0, y0, x1, y1) => {
    const midx = Math.round((x0 + x1) / 2 / 2) * 2;
    const pts = [[x0, y0], [midx, y0], [midx, y1], [x1, y1]];
    for (let k = 0; k < pts.length - 1; k++) {
      segment(t, pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1], trace, 1.4, 1);
      segment(t, pts[k][0], pts[k][1] - 0.8, pts[k + 1][0], pts[k + 1][1] - 0.8, traceHi, 0.8, 0.4);
    }
    for (const p of [pts[1], pts[2]]) disc(t, p[0], p[1], 1.3, trace, 1, 0.9);
  };
  for (let i = 0; i < 22; i++) {
    drawTrace(2 + Math.floor(rng() * 30) * 2, 2 + Math.floor(rng() * 30) * 2,
      2 + Math.floor(rng() * 30) * 2, 2 + Math.floor(rng() * 30) * 2);
  }
  for (let i = 0; i < 26; i++) {                       // vias
    const x = 2 + Math.floor(rng() * 30) * 2, y = 2 + Math.floor(rng() * 30) * 2;
    disc(t, x, y, 1.8, copper, 1, 0.9);
    disc(t, x, y, 0.7, rgba(10, 12, 12), 1, 0.8);
  }
  const chip = (x, y, w, h, label) => {               // dual-inline packages
    rect(t, x, y, w, h, rgba(26, 26, 30));
    bevel(t, x, y, w, h, rgba(60, 60, 66), BLACK, true, 1, 0.8);
    for (let i = 2; i < w - 1; i += 3) {
      rect(t, x + i, y - 2, 2, 2, rgba(150, 152, 158), 0.9);
      rect(t, x + i, y + h, 2, 2, rgba(120, 122, 128), 0.9);
    }
    disc(t, x + 2.5, y + 2.5, 1, rgba(70, 70, 76), 1, 0.8);
    if (label) drawText(t, label, x + 2, y + Math.floor((h - 7) / 2), 1, rgba(140, 144, 150), { alpha: 0.75 });
  };
  if (alt) {
    chip(34, 8, 20, 11, null);
    chip(8, 36, 17, 9, 'x');
    chip(40, 44, 14, 9, null);
  } else {
    chip(12, 12, 20, 11, 'mu');
    chip(38, 40, 17, 9, null);
    chip(8, 44, 14, 9, null);
  }
  for (let i = 0; i < 7; i++) rect(t, 2 + i * 9, 60, 6, 4, copper, 0.9);   // edge fingers
  const nodes = [[48, 10, C.cyan], [56, 22, C.cyan], [30, 34, C.amber], [20, 27, C.cyan], [44, 56, C.amber], [10, 34, C.cyan], [58, 46, C.cyan]];
  for (const [x0, y, col] of nodes) {
    const x = alt ? 64 - x0 : x0;
    glow(t, x, y, 9, col, 0.55, 2.2);
    disc(t, x, y, 1.5, col, 1, 0.8);
    disc(t, x, y, 0.7, WHITE, 0.85, 0.7);
  }
  bloom(t, 3, 70, 0.75);
  grain(t, 12247, 0.05);
}

// ---------------------------------------------------------------------------
// 13  SILO_WALL
// ---------------------------------------------------------------------------
function paintSiloWall(t, num = '07', extra = null) {
  concreteBase(t, 13101, { tone: 0.9, hi: addRGB(C.conc, -6, -4, 4) });
  for (let y = 0; y < W; y++) {                        // vertical panel ribs, period 16
    for (let x = 0; x < W; x++) {
      const u = (x % 16) / 16;
      let s = 0.72 + 0.5 * Math.pow(1 - u, 1.4);
      if (u > 0.93) s = 0.4;
      if (u < 0.045) s = 1.42;
      t[y * W + x] = mul(t[y * W + x], s);
    }
  }
  for (let x = 15; x < W; x += 16) { vline(t, x, 0, 63, BLACK, 0.55); vline(t, x + 1, 0, 63, C.spec, 0.22); }
  hline(t, 12, 0, 63, BLACK, 0.35); hline(t, 13, 0, 63, C.spec, 0.16);
  hline(t, 51, 0, 63, BLACK, 0.35); hline(t, 52, 0, 63, C.spec, 0.16);
  for (let x = 7; x < W; x += 16) { rivet(t, x, 12, 2, C.steel); rivet(t, x, 52, 2, C.steel); }
  const snap = t.slice();
  drawTextCentered(t, num, 32, 22, 3, mul(C.yellow, 0.94), { shadow: true, shadowAlpha: 0.45 });
  drawTextCentered(t, 'silo', 32, 44, 1, mul(C.yellow, 0.8), { alpha: 0.85 });
  chipBack(t, snap, 13177, 9, 0.62, 0.7, 4);
  if (extra) extra(t);
  chipBack(t, snap, 13188, 22, 0.7, 0.6, 3);
  edgeRust(t, 13233, 0.45, { top: 0.25, bot: 0.6, side: 0 });
  drip(t, 13301, 7, 14, 46, mul(C.rustDk, 1.1), 0.42, 1.3);
  drip(t, 13302, 39, 54, 63, mul(C.rustDk, 1.0), 0.35, 1.2);
  dampBloom(t, 13246, 0.4);
  grain(t, 13247, 0.075);
  wallLight(t, { seed: 13248, top: 1.18, bot: 0.55, grime: 0.55 });
}

// ---------------------------------------------------------------------------
// 14  WARNING
// ---------------------------------------------------------------------------
function trefoil(t, cx, cy, R, col, a = 1) {
  const hubR = R * 0.2;
  const n = Math.ceil(R) + 1;
  for (let j = -n; j <= n; j++) {
    for (let i = -n; i <= n; i++) {
      const d = Math.hypot(i, j);
      let inside = d <= hubR + 0.5;
      if (!inside && d >= R * 0.36 && d <= R) {
        const ang = Math.atan2(j, i);
        for (let k = 0; k < 3; k++) {
          let da = ang - (-Math.PI / 2 + k * 2.0943951);
          while (da > Math.PI) da -= 6.2831853;
          while (da < -Math.PI) da += 6.2831853;
          if (Math.abs(da) <= 0.5235988) { inside = true; break; }
        }
      }
      if (inside) blendPx(t, cx + i, cy + j, col, a);
    }
  }
}

function paintWarning(t) {
  steelBase(t, 14101, { col: C.steelMid });
  bevel(t, 1, 1, 62, 62, C.spec, BLACK, true, 2, 0.55);
  const snap = t.slice();
  disc(t, 32, 24, 21, C.yellow, 1, 1.2);               // painted disc
  const paintF = field(14155, 10, 3);
  for (let j = -22; j <= 22; j++) {
    for (let i = -22; i <= 22; i++) {
      if (Math.hypot(i, j) > 21.5) continue;
      const ix = idx(32 + i, 24 + j);
      t[ix] = mul(t[ix], 0.88 + paintF[ix] * 0.26);
    }
  }
  trefoil(t, 32, 24, 18.5, C.black, 1);
  rect(t, 8, 47, 48, 11, C.black, 0.95);               // stencil bar
  bevel(t, 8, 47, 48, 11, mul(C.yellow, 0.55), BLACK, true, 1, 0.35);
  drawTextCentered(t, 'danger', 32, 49, 1, C.yellow, { alpha: 1 });
  chipBack(t, snap, 14177, 8, 0.53, 0.9, 4);           // weathering
  chipBack(t, snap, 14188, 24, 0.64, 0.8, 3);
  const ff = field(14177, 8, 4);
  for (let i = 0; i < AREA; i++) {
    const v = ff[i];
    if (v > 0.52 && v < 0.548) t[i] = mix(t[i], C.specHot, 0.22);
  }
  for (const [x, y] of [[6, 6], [57, 6], [6, 57], [57, 57]]) rivet(t, x, y, 2.6, C.steel);
  const rng = makeRng(14199);
  for (let s = 0; s < 10; s++) {                       // scratches
    const x = rng() * W, y = 10 + rng() * 44, l = 4 + rng() * 14, a = (rng() - 0.5) * 1.2;
    segment(t, x, y, x + Math.cos(a) * l, y + Math.sin(a) * l, C.specHot, 1, 0.22 + rng() * 0.2);
  }
  edgeRust(t, 14233, 0.55, { top: 0.3, bot: 0.7, side: 0.4 });
  drip(t, 14301, 6, 9, 40, mul(C.rustDk, 1.1), 0.4, 1.2);
  drip(t, 14302, 57, 9, 34, mul(C.rustDk, 1.1), 0.35, 1.1);
  grain(t, 14247, 0.06);
  wallLight(t, { seed: 14248, top: 1.1, bot: 0.72, grime: 0.4 });
}

// ---------------------------------------------------------------------------
// 15-19  the blast door family
// ---------------------------------------------------------------------------
function blastDoorBase(t, seed, tintCol) {
  steelBase(t, seed, { col: tintCol || addRGB(C.steel, 8, 6, 0) });
  rect(t, 0, 0, 64, 64, BLACK, 0.12);
  // jamb frame
  rect(t, 0, 0, 7, 64, mul(C.steelDk, 1.15));
  rect(t, 57, 0, 7, 64, mul(C.steelDk, 1.05));
  rect(t, 0, 0, 64, 3, mul(C.steelDk, 1.2));
  rect(t, 0, 60, 64, 4, mul(C.steelDk, 0.8));
  const fb = brushField(seed + 5);
  for (let y = 0; y < W; y++) {
    for (const x of [0, 1, 2, 3, 4, 5, 6, 57, 58, 59, 60, 61, 62, 63]) {
      t[y * W + x] = mul(t[y * W + x], 0.85 + fb[y * W + x] * 0.35);
    }
  }
  // hydraulic struts in the frame
  for (const sx of [3, 60]) {
    for (let dx = -2; dx <= 2; dx++) {
      const lam = cyl(dx / 2);
      for (let y = 4; y < 60; y++) {
        put(t, sx + dx, y, mix(mul(C.steelDk, 0.9), mul(C.spec, 0.95), lam));
      }
    }
    for (const cy of [10, 32, 54]) {                   // clamps
      for (let dx = -3; dx <= 3; dx++) {
        const lam = cyl(dx / 3);
        for (let y = cy - 3; y <= cy + 3; y++) {
          const e = (y === cy - 3 || y === cy + 3) ? 0.6 : 1;
          put(t, sx + dx, y, mul(mix(mul(C.steelDk, 0.8), mul(C.spec, 1.05), lam), e));
        }
      }
      rivet(t, sx, cy, 1.5, C.spec);
    }
  }
  // leaves + centre seam
  bevel(t, 7, 3, 25, 57, C.spec, BLACK, true, 1, 0.5);
  bevel(t, 32, 3, 25, 57, C.spec, BLACK, true, 1, 0.5);
  for (let y = 3; y < 60; y++) {
    blendPx(t, 30, y, mul(C.steel, 0.8), 0.5);
    blendPx(t, 31, y, BLACK, 0.85);
    blendPx(t, 32, y, BLACK, 0.7);
    blendPx(t, 33, y, C.spec, 0.28);
  }
  // recessed panels
  for (const px0 of [10, 35]) {
    rect(t, px0, 8, 19, 47, BLACK, 0.16);
    bevel(t, px0, 8, 19, 47, BLACK, C.spec, false, 2, 0.5);
  }
  // reinforcing ribs
  for (const ry of [14, 47]) {
    for (const px0 of [8, 33]) {
      rect(t, px0, ry, 23, 5, mul(C.steel, 1.02), 0.55);
      bevel(t, px0, ry, 23, 5, C.spec, BLACK, true, 1, 0.7);
    }
  }
  for (const bx of [13, 26, 38, 51]) {
    for (const by of [10, 52]) rivet(t, bx, by, 2.1, addRGB(C.steel, 20, 18, 12));
  }
  edgeRust(t, seed + 233, 0.6, { top: 0.15, bot: 0.85, side: 0.25 });
  drip(t, seed + 301, 20, 50, 63, mul(C.rustDk, 1.05), 0.4, 1.3);
  drip(t, seed + 302, 45, 18, 44, mul(C.rustDk, 0.9), 0.28, 1.1);
  grain(t, seed + 247, 0.055);
}

function paintDoor(t) {
  blastDoorBase(t, 15101);
  // vault wheel straddling the seam
  const cx = 32, cy = 31;
  glow(t, cx + 2, cy + 3, 20, BLACK, 0.4, 1.5);
  for (let j = -14; j <= 14; j++) {
    for (let i = -14; i <= 14; i++) {
      const d = Math.hypot(i, j);
      if (d > 13.2 || d < 9.6) continue;
      const u = (d - 11.4) / 1.8;
      const lam = clamp(cyl(u) * 0.72 + 0.28 - j * 0.018 - i * 0.012, 0, 1);
      blendPx(t, cx + i, cy + j, mix(mul(C.steelDk, 0.85), C.specHot, lam), 1);
    }
  }
  for (let k = 0; k < 5; k++) {
    const a = k * 1.2566 - 0.5;
    segment(t, cx, cy, cx + Math.cos(a) * 12, cy + Math.sin(a) * 12, mul(C.steel, 1.05), 2.4, 1);
    segment(t, cx - 0.6, cy - 0.7, cx + Math.cos(a) * 11, cy + Math.sin(a) * 11 - 0.7, C.spec, 1, 0.6);
  }
  disc(t, cx, cy, 4.4, mul(C.steelDk, 1.1), 1, 1);
  disc(t, cx - 0.8, cy - 0.9, 3.2, mul(C.steel, 1.15), 1, 1.2);
  rivet(t, cx, cy, 2.2, C.specHot);
  wallLight(t, { seed: 15248, top: 1.12, bot: 0.62, grime: 0.5 });
}

function paintDoorJamb(t) {
  steelBase(t, 16101, { col: mul(C.steel, 0.95) });
  // left cheek catches the corridor light, right cheek falls into the dark
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      let s2;
      if (x < 12) s2 = 1.15 - x * 0.02;
      else if (x > 51) s2 = 0.5 - (x - 51) * 0.012;
      else s2 = 0.34;
      t[y * W + x] = mul(t[y * W + x], s2);
    }
  }
  vline(t, 11, 0, 63, C.specHot, 0.55); vline(t, 12, 0, 63, BLACK, 0.8);
  vline(t, 13, 0, 63, BLACK, 0.45);
  vline(t, 51, 0, 63, BLACK, 0.7); vline(t, 52, 0, 63, mul(C.spec, 0.85), 0.4);
  // the slide track: two machined rails with a slot between them
  for (const rx of [22, 42]) {
    for (let dx = -3; dx <= 3; dx++) {
      const lam = cyl(dx / 3);
      for (let y = 0; y < W; y++) {
        put(t, rx + dx, y, mix(mul(C.steelDk, 0.6), mul(C.specHot, 0.92), lam));
      }
    }
    for (let y = 0; y < W; y++) blendPx(t, rx + 4, y, BLACK, 0.6);
  }
  rect(t, 27, 0, 11, 64, BLACK, 0.78);               // slot
  vline(t, 26, 0, 63, mul(C.spec, 0.7), 0.3);
  vline(t, 38, 0, 63, BLACK, 0.5);
  for (let y = 3; y < 62; y += 9) {                  // sleepers under the rails
    rect(t, 16, y, 32, 3, mul(C.steelDk, 1.25), 0.75);
    hline(t, y, 16, 47, mul(C.spec, 0.8), 0.4);
    hline(t, y + 3, 16, 47, BLACK, 0.5);
  }
  // painted stripe on the near cheek so the opening reads at a glance
  const snap = t.slice();
  for (let y = 0; y < W; y++) {
    const yellow = ((y >> 2) & 1) === 0;
    for (let x = 3; x < 9; x++) blendPx(t, x, y, yellow ? C.yellow : C.black, 0.92);
  }
  chipBack(t, snap, 16411, 12, 0.5, 0.95, 4);
  for (const x of [1, 55, 61]) for (let y = 6; y < 60; y += 13) rivet(t, x, y, 2.2, C.steel);
  for (let y = 0; y < W; y++) {                      // conduit down the far cheek
    blendPx(t, 57, y, rgba(38, 34, 30), 0.85);
    blendPx(t, 58, y, rgba(66, 60, 52), 0.7);
    blendPx(t, 59, y, BLACK, 0.5);
  }
  edgeRust(t, 16233, 0.34, { top: 0.1, bot: 0.5, side: 0.12 });
  drip(t, 16301, 46, 22, 60, mul(C.rustDk, 1.1), 0.35, 1.2);
  drip(t, 16302, 15, 30, 63, mul(C.rustDk, 0.9), 0.3, 1);
  grain(t, 16247, 0.07);
  wallLight(t, { seed: 16248, top: 1.18, bot: 0.5, grime: 0.55 });
}

/** Shared keydoor art: a huge shape in the key colour you can read at range. */
function keyDoor(t, seed, key, shape, digit, word) {
  blastDoorBase(t, seed, addRGB(C.steel, 0, 0, 4));
  const cx = 32, cy = 26, dark = mul(key, 0.35), lite = add(key, 60);
  glow(t, cx + 2, cy + 3, 26, BLACK, 0.45, 1.5);
  const inside = (i, j) => {
    const ax = Math.abs(i), ay = Math.abs(j);
    if (shape === 'diamond') return ax / 21 + ay / 19 <= 1;
    if (shape === 'square') return Math.max(ax / 16.5, ay / 16.5) <= 1 && (ax / 20 + ay / 20) <= 1.22;
    const q = ax / 19;                                  // hexagon, point up
    return q <= 1 && ay <= 19 - q * 8;
  };
  for (let j = -24; j <= 24; j++) {
    for (let i = -24; i <= 24; i++) {
      if (!inside(i, j)) continue;
      const edge = !(inside(i - 1, j) && inside(i + 1, j) && inside(i, j - 1) && inside(i, j + 1));
      const g = clamp(0.5 - j / 52 - i / 150, 0, 1);
      let c = mix(dark, lite, 0.25 + g * 0.9);
      if (edge) c = mul(key, 0.3);
      blendPx(t, cx + i, cy + j, c, 1);
    }
  }
  for (let j = -24; j <= 24; j++) {                     // 2px dark outline for punch
    for (let i = -24; i <= 24; i++) {
      if (inside(i, j)) continue;
      if (inside(i - 1, j) || inside(i + 1, j) || inside(i, j - 1) || inside(i, j + 1) ||
          inside(i - 2, j) || inside(i + 2, j) || inside(i, j - 2) || inside(i, j + 2)) {
        blendPx(t, cx + i, cy + j, BLACK, 0.75);
      }
    }
  }
  const snap = t.slice();
  drawTextCentered(t, digit, cx, cy - 11, 3, rgba(16, 14, 16), { alpha: 0.94 });
  chipBack(t, snap, seed + 411, 14, 0.62, 0.6, 3);
  // stencil bar under the emblem
  rect(t, 8, 49, 48, 11, rgba(14, 13, 14), 0.95);
  bevel(t, 8, 49, 48, 11, mul(key, 0.8), BLACK, true, 1, 0.6);
  const snap2 = t.slice();
  drawTextCentered(t, word, cx, 51, 1, add(key, 40), { alpha: 1 });
  chipBack(t, snap2, seed + 433, 16, 0.6, 0.55, 3);
  // indicator lamp above the emblem
  disc(t, cx, 6, 2.8, mul(key, 0.45), 1, 1);
  disc(t, cx, 6, 1.7, add(key, 100), 1, 0.9);
  glow(t, cx, 6, 9, key, 0.65, 2);
  for (let k = 0; k < 3; k++) {                         // chevrons in the frame
    for (const sx of [3, 60]) {
      const y = 18 + k * 9;
      segment(t, sx - 2.5, y, sx, y + 3.5, key, 1.7, 0.8);
      segment(t, sx + 2.5, y, sx, y + 3.5, key, 1.7, 0.8);
    }
  }
  wallLight(t, { seed: seed + 248, top: 1.1, bot: 0.68, grime: 0.4 });
  glow(t, cx, cy, 30, key, 0.16, 2.4);
}

function paintDoorRed(t) { keyDoor(t, 17101, C.keyRed, 'diamond', '1', 'red'); }
function paintDoorBlue(t) { keyDoor(t, 18101, C.keyBlue, 'square', '2', 'blue'); }
function paintDoorGold(t) { keyDoor(t, 19101, C.keyGold, 'hex', '3', 'gold'); }

// ---------------------------------------------------------------------------
// 20  ELEVATOR
// ---------------------------------------------------------------------------
function paintElevator(t) {
  steelBase(t, 20101, { col: mul(C.steel, 0.8) });
  rect(t, 0, 0, 64, 64, BLACK, 0.1);
  rect(t, 4, 6, 44, 55, mul(C.steelDk, 0.8));          // recess for the doors
  bevel(t, 3, 5, 46, 57, BLACK, C.spec, false, 2, 0.6);
  const bf = brushField(20155);
  for (let y = 7; y < 60; y++) {
    for (let x = 5; x < 47; x++) {
      const u = (x - 5) / 42;
      const leaf = x < 26 ? (x - 5) / 21 : (x - 26) / 21;
      let c = mix(mul(C.steel, 0.72), mul(C.steel, 1.25), 0.35 + bf[y * W + x] * 0.5);
      c = mul(c, 1.1 - Math.abs(leaf - 0.35) * 0.4 - u * 0.05);
      put(t, x, y, c);
    }
  }
  for (let y = 7; y < 60; y++) {                        // centre seam
    blendPx(t, 25, y, mul(C.steel, 0.85), 0.5);
    blendPx(t, 26, y, BLACK, 0.9);
    blendPx(t, 27, y, C.spec, 0.3);
  }
  for (const lx of [8, 23, 29, 44]) vline(t, lx, 9, 57, BLACK, 0.22);
  hline(t, 58, 5, 46, BLACK, 0.7); hline(t, 59, 5, 46, mul(C.rustDk, 1.1), 0.45);
  rect(t, 4, 60, 45, 3, mul(C.steelDk, 0.6));           // floor track
  hline(t, 61, 4, 48, C.spec, 0.25);
  // floor indicator
  rect(t, 6, 8, 40, 0, BLACK, 0);
  rect(t, 5, 0, 44, 6, rgba(14, 12, 12), 1);
  bevel(t, 5, 0, 44, 6, mul(C.steel, 0.7), BLACK, true, 1, 0.6);
  drawText(t, '-07', 8, 0, 1, C.amber, { alpha: 1 });
  for (let k = 0; k < 5; k++) {
    const on = k < 2;
    rect(t, 30 + k * 4, 2, 3, 3, on ? C.amber : rgba(48, 34, 18), 1);
    if (on) glow(t, 31 + k * 4, 3, 4, C.amber, 0.5, 2);
  }
  // call panel
  rect(t, 51, 22, 11, 22, mul(C.steelDk, 1.15));
  bevel(t, 51, 22, 11, 22, C.spec, BLACK, true, 1, 0.7);
  rect(t, 52, 23, 9, 20, mul(C.steelDk, 0.85), 0.8);
  disc(t, 56.5, 29, 3.2, mul(C.steelDk, 0.7), 1, 1);
  disc(t, 56.5, 29, 2.2, C.amber, 1, 0.9); glow(t, 56.5, 29, 6, C.amber, 0.65, 2);
  disc(t, 56.5, 37, 3.2, mul(C.steelDk, 0.7), 1, 1);
  disc(t, 56.5, 37, 2.2, rgba(60, 46, 30), 1, 0.9);
  for (const [x, y] of [[52, 23], [60, 23], [52, 42], [60, 42]]) screw(t, x, y, 1.3, C.spec);
  drawText(t, 'up', 53, 46, 1, mul(C.yellow, 0.85), { alpha: 0.8 });
  // painted chevrons over the door head
  const snap = t.slice();
  for (let k = 0; k < 2; k++) {
    const y = 8 + k * 10;
    segment(t, 16, y + 6, 26, y, C.yellow, 2.1, 0.95);
    segment(t, 36, y + 6, 26, y, C.yellow, 2.1, 0.95);
    segment(t, 16, y + 7.6, 26, y + 1.6, mul(C.yellowDk, 0.65), 1.1, 0.45);
    segment(t, 36, y + 7.6, 26, y + 1.6, mul(C.yellowDk, 0.65), 1.1, 0.45);
  }
  chipBack(t, snap, 20411, 10, 0.58, 0.8, 3);
  edgeRust(t, 20233, 0.4, { top: 0.1, bot: 0.6, side: 0.2 });
  drip(t, 20301, 34, 20, 52, mul(C.rustDk, 1.0), 0.3, 1.2);
  grain(t, 20247, 0.06);
  wallLight(t, { seed: 20248, top: 1.12, bot: 0.6, grime: 0.5 });
  glow(t, 26, 3, 22, C.amber, 0.12, 2.2);
}

// ---------------------------------------------------------------------------
// 21  FLESH
// ---------------------------------------------------------------------------
function fleshBase(t, seed) {
  const broad = field(seed, 4, 5);
  const med = field(seed + 61, 9, 4);
  const fine = field(seed + 131, 22, 3);
  for (let i = 0; i < AREA; i++) {
    const v = broad[i] * 0.6 + med[i] * 0.4;
    let c = mix(C.fleshDk, C.flesh, clamp((v - 0.24) * 1.85, 0, 1));
    c = mix(c, mul(C.vein, 1.1), clamp((0.36 - v) * 2.6, 0, 1) * 0.7);
    c = mix(c, addRGB(C.flesh, 46, 24, 14), clamp((v - 0.66) * 3.4, 0, 1) * 0.65);
    c = mul(c, 0.88 + fine[i] * 0.26);
    t[i] = c;
  }
}
function veins(t, seed, n, len, wdt) {
  const rng = makeRng(seed);
  for (let i = 0; i < n; i++) {
    const x = rng() * W, y = rng() * W;
    crack(t, rng, x, y, rng() * 6.283, len, wdt, mul(C.vein, 0.95), addRGB(C.flesh, 40, 10, 6), 3);
  }
}
function wetSheen(t, seed, n, amount) {
  const rng = makeRng(seed);
  for (let i = 0; i < n; i++) {
    const x = rng() * W, y = rng() * W, r = 1 + rng() * 3.4;
    glow(t, x, y, r * 2.6, C.wet, amount * (0.4 + rng() * 0.6), 2.4);
    disc(t, x - r * 0.25, y - r * 0.3, r * 0.35, C.wet, amount * 0.9, 0.8);
  }
}
function paintFlesh(t) {
  fleshBase(t, 21101);
  veins(t, 21133, 9, 30, 2.6);
  veins(t, 21134, 14, 12, 1.5);
  const pore = makeRng(21155);
  for (let i = 0; i < 13; i++) {                       // pores
    const x = pore() * W, y = pore() * W, r = 1 + Math.pow(pore(), 1.8) * 4.6;
    disc(t, x, y, r, mul(C.vein, 0.55), 0.9, 1.2);
    disc(t, x, y, r * 0.45, rgba(28, 10, 14), 0.9, 1);
    for (let a = 0; a < 6.283; a += 0.3) {
      blendPx(t, x + Math.cos(a) * (r + 0.9), y + Math.sin(a) * (r + 0.9),
        Math.sin(a) < -0.2 ? C.wet : mul(C.fleshDk, 0.8), 0.35);
    }
  }
  wetSheen(t, 21177, 22, 0.45);
  drip(t, 21301, 21, 30, 62, mul(C.vein, 0.8), 0.45, 1.5);
  drip(t, 21302, 48, 12, 40, mul(C.vein, 0.9), 0.35, 1.2);
  grain(t, 21247, 0.075);
  wallLight(t, { seed: 21248, top: 1.14, bot: 0.56, grime: 0.45, grimeCol: rgba(30, 12, 16) });
}

// ---------------------------------------------------------------------------
// 22  FLOOR_CONCRETE
// ---------------------------------------------------------------------------
function paintFloorConcrete(t) {
  concreteBase(t, 22101, { tone: 1.02 });
  for (let y = 0; y < W; y++) {                        // slab joints on the cell grid
    for (let x = 0; x < W; x++) {
      const d = Math.min(x, W - 1 - x, y, W - 1 - y);
      if (d < 2) blendPx(t, x, y, mul(C.concDk, 0.5), (2 - d) / 2 * 0.8);
      else if (d < 3) blendPx(t, x, y, add(C.conc, 26), 0.22);
    }
  }
  const stain = field(22133, 5, 4);
  for (let i = 0; i < AREA; i++) {
    const v = stain[i];
    if (v > 0.56) t[i] = mix(t[i], mul(C.dirtDk, 1.1), clamp((v - 0.56) * 2.6, 0, 1) * 0.55);
    if (v < 0.34) t[i] = mix(t[i], add(t[i], 22), clamp((0.34 - v) * 3, 0, 1) * 0.35);
  }
  const rng = makeRng(22155);
  for (let i = 0; i < 22; i++) {                       // spalled pits and old repairs
    const x = rng() * W, y = rng() * W, r = 1.5 + rng() * 4;
    disc(t, x, y, r, mul(C.concDk, 0.65), 0.55, 1.4);
    disc(t, x - r * 0.2, y - r * 0.25, r * 0.7, add(C.conc, 30), 0.3, 1.4);
  }
  for (let i = 0; i < 26; i++) {                       // scuffs and drag marks
    const x = rng() * W, y = rng() * W, l = 4 + rng() * 16, a = rng() * 6.283;
    segment(t, x, y, x + Math.cos(a) * l, y + Math.sin(a) * l, mul(C.concDk, 0.75), 1 + rng(), 0.2 + rng() * 0.25);
  }
  crack(t, makeRng(22177), 12, 8, 0.85, 34, 1.5, mul(C.concDk, 0.5), add(C.conc, 30), 2);
  speckle(t, 22188, 160, add(C.conc, 60), 0.2, 0.55, 0.8);
  speckle(t, 22189, 120, mul(C.concDk, 0.45), 0.2, 0.55, 0.8);
  dampBloom(t, 22190, 0.3);
  edgeDark(t, 0.32, 4);
  grain(t, 22247, 0.085);
}

// ---------------------------------------------------------------------------
// 23  FLOOR_GRATE
// ---------------------------------------------------------------------------
function paintFloorGrate(t) {
  const deep = field(23101, 6, 4);
  for (let i = 0; i < AREA; i++) t[i] = mix(rgba(3, 3, 5), rgba(22, 20, 24), Math.pow(deep[i], 1.6));
  const sd = (v, p) => { const m = ((v % p) + p) % p; return m > p / 2 ? m - p : m; };
  // ghost of a second grating far below - parallax, so you feel the drop
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const a = Math.abs(sd(x + y + 6, 16)), b = Math.abs(sd(x - y + 5, 16));
      if (Math.min(a, b) < 1.6) blendPx(t, x, y, rgba(40, 40, 46), 0.28);
    }
  }
  for (let y = 0; y < W; y++) {                        // cast shadow of the real grating
    for (let x = 0; x < W; x++) {
      const a = Math.abs(sd(x + y - 5, 16)), b = Math.abs(sd(x - y - 3, 16));
      if (Math.min(a, b) < 2.3) blendPx(t, x, y, BLACK, 0.65);
    }
  }
  const rustF = field(23155, 8, 4);
  const grimeF = field(23166, 16, 3);
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const sa = sd(x + y, 16), sb = sd(x - y, 16);
      const da = Math.abs(sa), db = Math.abs(sb);
      const half = 2.3;
      if (Math.min(da, db) > half) continue;
      let lam;
      if (da <= db) lam = cyl(sa / half);
      else lam = clamp(cyl(sb / half) * 0.55 + 0.3, 0, 1);
      if (da < half && db < half) lam = Math.max(lam, 0.85);          // welded node
      const i = y * W + x;
      let c = mix(mul(C.steelDk, 0.8), mul(C.spec, 0.98), lam);
      c = mul(c, 0.82 + grimeF[i] * 0.32);
      const rv = rustF[i];
      if (rv > 0.55) c = mix(c, mix(C.rustDk, C.rust, lam), clamp((rv - 0.55) * 3, 0, 0.85));
      if (Math.min(da, db) > half - 0.8) c = mul(c, 0.55);            // bar edge
      t[i] = c;
    }
  }
  for (const [x, y] of [[8, 8], [8, 40], [40, 8], [40, 40]]) {         // fixings, period 32
    disc(t, x, y, 2.6, mul(C.steelDk, 1.1), 1, 1);
    rivet(t, x, y, 1.8, C.spec);
  }
  speckle(t, 23188, 60, mul(C.dirtDk, 1.2), 0.15, 0.45, 0.8);
  grain(t, 23247, 0.07);
}

// ---------------------------------------------------------------------------
// 24  FLOOR_TILE
// ---------------------------------------------------------------------------
function paintFloorTile(t) {
  tileField(t, 24101, { face: mul(C.tile, 0.92), dark: mul(C.tileDk, 0.92) });
  const rng = makeRng(24133);
  for (let i = 0; i < 16; i++) {                       // scuff arcs from boots
    const x = rng() * W, y = rng() * W, r = 4 + rng() * 9, a0 = rng() * 6.283, sp = 0.7 + rng();
    for (let a = a0; a < a0 + sp; a += 0.05) {
      blendPx(t, x + Math.cos(a) * r, y + Math.sin(a) * r, mul(C.dirtDk, 1.1), 0.25 + rng() * 0.2);
    }
  }
  crack(t, rng, 20, 4, 1.25, 30, 1.3, mul(C.grout, 0.45), add(C.tile, 26), 2);
  for (const [x, y] of [[46, 20], [12, 50]]) {         // a tile lifted out
    for (let j = -6; j <= 6; j++) {
      for (let i = -6; i <= 6; i++) {
        if (Math.max(Math.abs(i), Math.abs(j)) > 5.5) continue;
        const wallK = clamp(Math.max(-i, -j) / 5.5, 0, 1);              // recess walls
        let c = mix(mul(C.dirtDk, 0.9), BLACK, wallK * 0.85);
        if (i > 2 || j > 2) c = mix(c, mul(C.dirt, 0.85), 0.35);        // lit far wall
        blendPx(t, x + i, y + j, c, 0.95);
      }
    }
    speckle(t, 24300 + x, 26, mul(C.conc, 0.7), 0.3, 0.7, 0.6);
    bevel(t, x - 6, y - 6, 12, 12, BLACK, mul(C.tile, 0.9), false, 2, 0.7);
  }
  const dirtF = field(24177, 4, 4);
  for (let i = 0; i < AREA; i++) t[i] = mix(t[i], mul(C.dirt, 0.8), clamp((dirtF[i] - 0.5) * 2.4, 0, 1) * 0.4);
  speckle(t, 24188, 90, mul(C.dirtDk, 1.1), 0.12, 0.35, 0.8);
  edgeDark(t, 0.22, 3);
  grain(t, 24247, 0.07);
}

// ---------------------------------------------------------------------------
// 25  FLOOR_DIRT
// ---------------------------------------------------------------------------
function paintFloorDirt(t) {
  const broad = field(25101, 4, 5), med = field(25111, 11, 4), fine = field(25121, 26, 2);
  for (let i = 0; i < AREA; i++) {
    const v = broad[i] * 0.55 + med[i] * 0.45;
    let c = mix(C.dirtDk, C.dirt, clamp((v - 0.22) * 1.7, 0, 1));
    c = mix(c, mul(C.concMid, 0.85), clamp((v - 0.62) * 3, 0, 1) * 0.55);
    c = mul(c, 0.86 + fine[i] * 0.3);
    t[i] = c;
  }
  const rng = makeRng(25133);
  for (let i = 0; i < 34; i++) {                       // broken slab chunks
    const cx = rng() * W, cy = rng() * W, r = 1.6 + rng() * 3.6, rot = rng() * 6.283;
    const n = 5 + Math.floor(rng() * 3);
    const pts = [];
    for (let k = 0; k < n; k++) {
      const a = rot + (k / n) * 6.283;
      const rr = r * (0.65 + rng() * 0.5);
      pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
    }
    const pick = rng();
    const base = pick < 0.45 ? mix(C.concMid, C.conc, rng())
      : pick < 0.72 ? mix(C.dirtDk, C.dirt, 0.3 + rng() * 0.6)
        : pick < 0.9 ? mix(mul(C.concDk, 0.8), C.concMid, rng() * 0.5)
          : mix(C.rustDk, C.rust, rng());
    for (let j = -Math.ceil(r) - 1; j <= Math.ceil(r) + 1; j++) {
      for (let i2 = -Math.ceil(r) - 1; i2 <= Math.ceil(r) + 1; i2++) {
        let insideP = false;
        const px2 = cx + i2, py2 = cy + j;
        for (let k = 0, l = pts.length - 1; k < pts.length; l = k++) {
          const [xi, yi] = pts[k], [xj, yj] = pts[l];
          if ((yi > py2) !== (yj > py2) && px2 < ((xj - xi) * (py2 - yi)) / (yj - yi) + xi) insideP = !insideP;
        }
        if (!insideP) continue;
        const lam = clamp(0.55 - j / (r * 3) - i2 / (r * 6), 0.15, 1);
        blendPx(t, px2 + 1, py2 + 1.2, BLACK, 0.35);
        blendPx(t, px2, py2, mul(base, 0.55 + lam * 0.85), 1);
      }
    }
  }
  speckle(t, 25155, 220, mul(C.dirtDk, 0.55), 0.25, 0.65, 0.8);
  speckle(t, 25156, 150, add(C.dirt, 56), 0.15, 0.5, 0.7);
  speckle(t, 25157, 60, mul(C.conc, 0.95), 0.2, 0.5, 1.1);
  const dust = field(25177, 3, 3);
  for (let i = 0; i < AREA; i++) t[i] = mix(t[i], add(C.dirt, 18), clamp((dust[i] - 0.55) * 2, 0, 1) * 0.28);
  edgeDark(t, 0.2, 5);
  grain(t, 25247, 0.1);
}

// ---------------------------------------------------------------------------
// 26  FLOOR_BLOOD
// ---------------------------------------------------------------------------
function paintFloorBlood(t) {
  tileField(t, 26101, { face: mul(C.tile, 0.75), dark: mul(C.tileDk, 0.72), grout: mul(C.grout, 0.8) });
  const pool = field(26133, 4, 5), fine = field(26144, 14, 3);
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const v = pool[i];
      if (v > 0.44) {
        const k = clamp((v - 0.44) * 4.5, 0, 1);
        let c = mix(C.blood, C.bloodDk, clamp((v - 0.5) * 2.5, 0, 1));
        c = mul(c, 0.85 + fine[i] * 0.3);
        t[i] = mix(t[i], c, clamp(k, 0, 0.94));
        if (v > 0.44 && v < 0.485) t[i] = mix(t[i], mul(C.bloodDk, 0.75), 0.5);  // dried rim
        if (v > 0.66) t[i] = mix(t[i], C.bloodWet, clamp((v - 0.66) * 2, 0, 1) * 0.35 * (0.4 + fine[i]));
      }
    }
  }
  const rng = makeRng(26155);
  for (let i = 0; i < 40; i++) {                       // cast-off spatter
    const x = rng() * W, y = rng() * W;
    disc(t, x, y, 0.5 + Math.pow(rng(), 2) * 2.4, rng() < 0.35 ? C.bloodDk : C.blood, 0.85, 0.9);
  }
  for (let i = 0; i < 5; i++) {                        // something was dragged
    const y0 = 8 + rng() * 40;
    segment(t, 0, y0, 63, y0 + (rng() - 0.5) * 14, mul(C.bloodDk, 1.1), 1.6 + rng() * 2, 0.4);
  }
  for (let i = 0; i < 30; i++) {                       // wet highlights
    const x = rng() * W, y = rng() * W;
    if (pool[idx(x, y)] < 0.55) continue;
    glow(t, x, y, 2 + rng() * 3, rgba(210, 120, 110), 0.3, 2);
  }
  edgeDark(t, 0.25, 3);
  grain(t, 26247, 0.075);
}

// ---------------------------------------------------------------------------
// 27  CEIL_CONCRETE
// ---------------------------------------------------------------------------
function paintCeilConcrete(t) {
  concreteBase(t, 27101, { tone: 0.78 });
  const wob = field(27122, 8, 2);
  for (let y = 0; y < W; y++) {                        // shuttering boards, period 16
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const ly = (y + (wob[i] - 0.5) * 1.6) % 16;
      if (ly < 1) t[i] = mix(t[i], mul(C.concDk, 0.42), 0.75);
      else if (ly < 2) t[i] = mix(t[i], add(t[i], 30), 0.5);
      else t[i] = mul(t[i], 1.03 - ly * 0.008);
    }
  }
  const stain = field(27133, 4, 4);
  for (let i = 0; i < AREA; i++) {
    const v = stain[i];
    if (v > 0.5) t[i] = mix(t[i], mul(C.dirtDk, 0.75), clamp((v - 0.5) * 2.6, 0, 1) * 0.7);
    if (v < 0.34) t[i] = mix(t[i], add(t[i], 30), clamp((0.34 - v) * 3, 0, 1) * 0.5);
  }
  crack(t, makeRng(27144), 4, 46, -0.5, 30, 1.4, mul(C.concDk, 0.4), add(C.conc, 26), 2);
  for (let k = 0; k < 3; k++) {                        // conduit clipped to the soffit
    const y = 8 + k * 1.4;
    for (let x = 0; x < W; x++) {
      blendPx(t, x, y + 1.6, BLACK, 0.35);
      blendPx(t, x, y, k === 1 ? rgba(52, 48, 44) : rgba(34, 32, 30), 0.85);
    }
  }
  for (const bx of [12, 44]) rect(t, bx, 6, 3, 6, mul(C.steelDk, 1.2), 0.9);
  rect(t, 26, 26, 12, 12, mul(C.steelDk, 1.1), 0.9);   // an anchor plate
  bevel(t, 26, 26, 12, 12, C.spec, BLACK, true, 1, 0.6);
  for (const [x, y] of [[29, 29], [35, 29], [29, 35], [35, 35]]) rivet(t, x, y, 1.5, C.steel);
  drip(t, 27155, 20, 30, 46, mul(C.rustDk, 0.95), 0.4, 1.3);
  for (let i = 0; i < AREA; i++) {                     // efflorescence, salt leaching through
    const v = stain[i];
    if (v > 0.66) t[i] = mix(t[i], rgba(186, 186, 176), clamp((v - 0.66) * 3.2, 0, 1) * 0.45);
  }
  dampBloom(t, 27166, 0.35, C.moss);
  speckle(t, 27188, 110, mul(C.concDk, 0.45), 0.2, 0.5, 0.8);
  speckle(t, 27189, 70, add(C.conc, 40), 0.15, 0.4, 0.7);
  edgeDark(t, 0.35, 4);
  grain(t, 27247, 0.08);
}

// ---------------------------------------------------------------------------
// 28  CEIL_LAMP  (emissive)
// ---------------------------------------------------------------------------
function paintCeilLamp(t) {
  concreteBase(t, 28101, { tone: 0.5 });
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const d = Math.hypot(x - 32, y - 32);
    if (d > 26) blendPx(t, x, y, BLACK, clamp((d - 26) / 12, 0, 1) * 0.45);
  }
  for (let j = -30; j <= 30; j++) {                    // housing ring
    for (let i = -30; i <= 30; i++) {
      const d = Math.hypot(i, j);
      if (d > 29 || d < 23) continue;
      const lam = clamp(0.45 - (i * 0.02 + j * 0.03), 0.1, 1);
      blendPx(t, 32 + i, 32 + j, mix(mul(C.steelDk, 0.9), C.spec, lam), 1);
    }
  }
  for (let k = 0; k < 8; k++) {
    const a = k * 0.7854 + 0.39;
    rivet(t, 32 + Math.cos(a) * 26, 32 + Math.sin(a) * 26, 1.6, C.steel);
  }
  const glass = rgba(255, 248, 214);
  for (let j = -24; j <= 24; j++) {                    // the light itself
    for (let i = -24; i <= 24; i++) {
      const d = Math.hypot(i, j) / 23;
      if (d >= 1) continue;
      const k = Math.pow(1 - d, 1.5);
      let c = mix(rgba(104, 74, 32), C.amber, clamp(k * 1.6, 0, 1));
      c = mix(c, glass, clamp((k - 0.38) * 2.4, 0, 1));
      c = mix(c, WHITE, clamp((k - 0.62) * 3.2, 0, 1));
      blendPx(t, 32 + i, 32 + j, c, 1);
    }
  }
  const dirtF = field(28133, 7, 3);                    // filthy glass
  for (let j = -23; j <= 23; j++) for (let i = -23; i <= 23; i++) {
    if (Math.hypot(i, j) > 22) continue;
    const ix = idx(32 + i, 32 + j);
    t[ix] = mul(t[ix], 0.82 + dirtF[ix] * 0.3);
  }
  for (const rr of [10, 17, 22.5]) {                   // cage rings
    for (let a = 0; a < 6.2832; a += 0.02) {
      const x = 32 + Math.cos(a) * rr, y = 32 + Math.sin(a) * rr;
      blendPx(t, x, y + 0.6, BLACK, 0.5);
      blendPx(t, x, y, mul(C.steelDk, 1.2), 0.92);
      blendPx(t, x, y - 0.7, C.spec, 0.3);
    }
  }
  for (let k = 0; k < 6; k++) {                        // cage ribs
    const a = k * 1.0472 + 0.2;
    segment(t, 32 + Math.cos(a) * 3, 32 + Math.sin(a) * 3, 32 + Math.cos(a) * 23, 32 + Math.sin(a) * 23, mul(C.steelDk, 1.15), 1.8, 0.9);
    segment(t, 32 + Math.cos(a) * 3, 32 + Math.sin(a) * 3 - 0.7, 32 + Math.cos(a) * 22, 32 + Math.sin(a) * 22 - 0.7, C.spec, 0.9, 0.35);
  }
  disc(t, 32, 32, 4.5, mul(C.steelDk, 1.1), 1, 1);     // lamp holder
  disc(t, 31, 31, 2.6, C.spec, 0.9, 1);
  glow(t, 32, 32, 30, rgba(255, 214, 150), 0.45, 1.8);
  bloom(t, 3, 150, 0.55);
  grain(t, 28247, 0.035);
}

// ---------------------------------------------------------------------------
// 29  CEIL_PIPES
// ---------------------------------------------------------------------------
function paintCeilPipes(t) {
  concreteBase(t, 29101, { tone: 0.55 });
  const grimeF = brushField(29133), rustF = field(29155, 7, 4);
  const runPipe = (cy, R, col) => {
    for (let x = 0; x < W; x++) {                      // shadow cast below
      for (let dy = R; dy <= R + 4; dy++) blendPx(t, x, cy + dy, BLACK, clamp(1 - (dy - R) / 4, 0, 1) * 0.5);
    }
    for (let dy = -R; dy <= R; dy++) {
      const lam = cyl(dy / R);
      for (let x = 0; x < W; x++) {
        // Kept dull on purpose: brighter, three pipes down every corridor read
        // as strip lights from any distance.
        let c = mix(mul(col, 0.32), mul(col, 0.78), lam);
        c = mul(c, 0.86 + grimeF[idx(x, cy + dy)] * 0.3);
        const rv = rustF[idx(x, cy + dy)];
        if (rv > 0.58) c = mix(c, mix(C.rustDk, C.rust, lam), clamp((rv - 0.58) * 3, 0, 0.8));
        if (Math.abs(dy) > R - 1) c = mul(c, 0.6);
        put(t, x, cy + dy, c);
      }
    }
  };
  runPipe(12, 6, C.steel);
  runPipe(33, 4.5, addRGB(C.steel, 22, 6, -14));
  runPipe(52, 5.5, C.steel);
  for (const bx of [10, 42]) {                         // brackets, period 32
    for (const [cy, R] of [[12, 6], [33, 4.5], [52, 5.5]]) {
      for (let dy = -R - 2; dy <= R + 2; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const shade2 = dx === -1 ? 1.25 : dx === 1 ? 0.6 : 1;
          if (Math.abs(dy) <= R + 2) put(t, bx + dx, cy + dy, mul(mix(C.steelDk, C.spec, 0.4), shade2));
        }
      }
      rivet(t, bx, cy - R - 2, 1.4, C.spec);
      rivet(t, bx, cy + R + 2, 1.4, C.spec);
    }
    for (let y = 0; y < W; y++) put(t, bx, y, mix(at(t, bx, y), mul(C.steelDk, 1.1), 0.35));
  }
  for (let k = 0; k < 3; k++) {                        // cable run
    const y = 43 + k * 1.6;
    for (let x = 0; x < W; x++) {
      const sag = Math.sin((x / W) * 6.283 * 2) * 0.9;
      blendPx(t, x, y + sag + 1.2, BLACK, 0.4);
      blendPx(t, x, y + sag, k === 1 ? rgba(80, 54, 30) : rgba(30, 30, 34), 0.95);
      blendPx(t, x, y + sag - 0.6, rgba(120, 96, 70), 0.3);
    }
  }
  drip(t, 29301, 26, 18, 30, mul(C.rustDk, 1.0), 0.3, 1);
  grain(t, 29247, 0.06);
  edgeDark(t, 0.28, 4);
}

// ---------------------------------------------------------------------------
// 30  CEIL_FLESH
// ---------------------------------------------------------------------------
function paintCeilFlesh(t) {
  fleshBase(t, 30101);
  veins(t, 30133, 10, 26, 2.2);
  const cx = 32, cy = 32;
  for (let j = -24; j <= 24; j++) {                    // the sphincter
    for (let i = -24; i <= 24; i++) {
      const d = Math.hypot(i, j);
      if (d > 23) continue;
      const a = Math.atan2(j, i);
      const fold = Math.sin(a * 11) * 0.5 + 0.5;
      const rr = d + fold * 1.6;
      const ring = Math.sin(rr * 1.15) * 0.5 + 0.5;
      let c = mix(mul(C.fleshDk, 0.9), addRGB(C.flesh, 20, 6, 2), ring);
      const pull = clamp(1 - d / 23, 0, 1);
      c = mix(t[idx(cx + i, cy + j)], c, Math.pow(pull, 0.55));
      c = mul(c, 0.72 + pull * 0.5);
      if (d < 7.5) {                                   // the hole
        const k = clamp(1 - d / 7.5, 0, 1);
        c = mix(c, rgba(26, 8, 12), Math.pow(k, 0.5));
        if (d > 5.5) c = mix(c, C.wet, 0.2 * (1 - Math.abs(d - 6.4)));
      }
      blendPx(t, cx + i, cy + j, c, 1);
    }
  }
  for (let a = 0; a < 6.2832; a += 0.05) {             // wet lip around the hole
    const r = 8.2 + Math.sin(a * 11) * 0.8;
    blendPx(t, cx + Math.cos(a) * r, cy + Math.sin(a) * r, C.wet, 0.35 + 0.3 * Math.max(0, -Math.sin(a + 0.7)));
  }
  for (let k = 0; k < 14; k++) {                       // radial tendons
    const a = k * 0.4488 + 0.2;
    segment(t, cx + Math.cos(a) * 9, cy + Math.sin(a) * 9, cx + Math.cos(a) * (21 + (k % 3)), cy + Math.sin(a) * (21 + (k % 3)), mul(C.vein, 1.05), 1.6, 0.5);
  }
  wetSheen(t, 30177, 26, 0.5);
  glow(t, 32, 32, 26, BLACK, 0.3, 1.4);
  grain(t, 30247, 0.07);
  edgeDark(t, 0.3, 5);
}

// ---------------------------------------------------------------------------
// 31  FLOOR_DECK  - tread plate
// ---------------------------------------------------------------------------
function paintFloorDeck(t) {
  steelBase(t, 31101, { col: addRGB(C.steel, 10, 10, 4) });
  for (let i = 0; i < AREA; i++) t[i] = mul(t[i], 0.78);      // base plate sits low
  // raised teardrop treads: shadows first, then every bar, so nothing draws on
  // top of its neighbour's shadow
  const bars = [];
  for (let by = 0; by < 8; by++) {
    for (let bx = 0; bx < 8; bx++) {
      const ang = ((bx + by) & 1) ? 0.7854 : -0.7854;
      bars.push([bx * 8 + 2.6, by * 8 + 4, ang]);
      bars.push([bx * 8 + 5.6, by * 8 + 4, ang]);
    }
  }
  const HW = 1.55, HL = 2.5;
  for (const [cx, cy, ang] of bars) {
    const dx = Math.cos(ang), dy = Math.sin(ang);
    for (let j = -5; j <= 5; j++) {
      for (let i = -5; i <= 5; i++) {
        const along = clamp(i * dx + j * dy, -HL, HL);
        const d = Math.hypot(i - dx * along, j - dy * along);
        if (d > HW + 1.4) continue;
        blendPx(t, cx + i + 1.1, cy + j + 1.3, BLACK, clamp(1 - (d - HW * 0.4) / 2, 0, 1) * 0.45);
      }
    }
  }
  for (const [cx, cy, ang] of bars) {
    const dx = Math.cos(ang), dy = Math.sin(ang);
    const nx = -dy, ny = dx;
    for (let j = -5; j <= 5; j++) {
      for (let i = -5; i <= 5; i++) {
        const s2 = i * dx + j * dy;
        const along = clamp(s2, -HL, HL);
        const d = Math.hypot(i - dx * along, j - dy * along);
        if (d > HW) continue;
        const u = clamp((i * nx + j * ny) / HW, -1, 1);
        const nz = Math.sqrt(Math.max(0, 1 - u * u));
        const lam = clamp(nx * u * -0.44 + ny * u * -0.56 + nz * 0.8, 0, 1);
        const rim = clamp((HW - d) * 1.6, 0, 1);
        // Kept low-contrast: a deck fills half the screen in a siege, and hot
        // treads at that density shimmer into moire.
        let c = mix(mul(C.steelDk, 1.1), mul(C.spec, 0.82), lam * 0.8);
        c = mix(mul(C.steelDk, 0.9), c, 0.35 + rim * 0.6);
        blendPx(t, cx + i, cy + j, c, 1);
      }
    }
  }
  const snap = t.slice();                              // worn painted edge stripe
  for (let y = 0; y < 11; y++) {
    const keep = y < 8 ? 1 : 1 - (y - 8) / 3;
    for (let x = 0; x < W; x++) {
      const st = (((x + y) % 16) + 16) % 16;
      const col = st < 8 ? C.yellow : C.black;
      blendPx(t, x, y, col, keep * 0.92);
    }
  }
  chipBack(t, snap, 31177, 9, 0.5, 1, 4);
  chipBack(t, snap, 31188, 24, 0.62, 0.85, 3);
  edgeRust(t, 31233, 0.22, { top: 0.15, bot: 0.35, side: 0.15 });
  const grimeF = field(31199, 5, 4);
  for (let i = 0; i < AREA; i++) t[i] = mix(t[i], mul(C.dirtDk, 1.05), clamp((grimeF[i] - 0.55) * 2.4, 0, 1) * 0.4);
  speckle(t, 31200, 60, mul(C.dirtDk, 1.1), 0.12, 0.32, 0.8);
  edgeDark(t, 0.2, 3);
  grain(t, 31247, 0.055);
}

// ===========================================================================
// DRESSING: the variant set
//
// Thirty-two surfaces repeated down every corridor is how a bunker ends up
// looking like a screensaver. Everything below is either a new material or a
// dressed copy of an existing one: the base is painted once, copied, and a
// story is added on top (a poster, a crack someone has been hitting, a screen
// that crashed in 1994). The level parser picks one per cell, so a long wall
// reads as a place people worked in rather than a pattern.
// ===========================================================================

// 3x5 micro font. Rows are 3-bit masks, MSB on the left. Small enough for the
// fine print on a safety poster, which nobody in this bunker ever read.
const MICRO = {
  A: [2, 5, 7, 5, 5], B: [6, 5, 6, 5, 6], C: [3, 4, 4, 4, 3], D: [6, 5, 5, 5, 6],
  E: [7, 4, 6, 4, 7], F: [7, 4, 6, 4, 4], G: [3, 4, 5, 5, 3], H: [5, 5, 7, 5, 5],
  I: [7, 2, 2, 2, 7], J: [1, 1, 1, 5, 2], K: [5, 5, 6, 5, 5], L: [4, 4, 4, 4, 7],
  M: [5, 7, 7, 5, 5], N: [5, 7, 7, 7, 5], O: [2, 5, 5, 5, 2], P: [6, 5, 6, 4, 4],
  Q: [2, 5, 5, 7, 3], R: [6, 5, 6, 5, 5], S: [3, 4, 2, 1, 6], T: [7, 2, 2, 2, 2],
  U: [5, 5, 5, 5, 3], V: [5, 5, 5, 5, 2], W: [5, 5, 7, 7, 5], X: [5, 5, 2, 5, 5],
  Y: [5, 5, 2, 2, 2], Z: [7, 1, 2, 4, 7], 0: [7, 5, 5, 5, 7], 1: [2, 6, 2, 2, 7],
  2: [6, 1, 2, 4, 7], 3: [6, 1, 2, 1, 6], 4: [5, 5, 7, 1, 1], 5: [7, 4, 6, 1, 6],
  6: [3, 4, 7, 5, 7], 7: [7, 1, 2, 2, 2], 8: [7, 5, 7, 5, 7], 9: [7, 5, 7, 1, 6],
  '-': [0, 0, 7, 0, 0], '.': [0, 0, 0, 0, 2], '/': [1, 1, 2, 4, 4], ' ': [0, 0, 0, 0, 0],
  ':': [0, 2, 0, 2, 0], '!': [2, 2, 2, 0, 2], '?': [6, 1, 2, 0, 2], "'": [2, 2, 0, 0, 0],
  ',': [0, 0, 0, 2, 4], '*': [5, 2, 7, 2, 5], '+': [0, 2, 7, 2, 0], '=': [0, 7, 0, 7, 0],
  '#': [5, 7, 5, 7, 5], '&': [2, 5, 2, 5, 3], '(': [1, 2, 2, 2, 1], ')': [4, 2, 2, 2, 4],
  '>': [4, 2, 1, 2, 4], '<': [1, 2, 4, 2, 1], '%': [5, 1, 2, 4, 5], $: [3, 6, 2, 3, 6],
};
function microWidth(s) { return s.length * 4 - 1; }
function micro(t, s, x, y, col, a = 1) {
  let cx = Math.round(x);
  const yy = Math.round(y);
  for (const ch of String(s).toUpperCase()) {
    const g = MICRO[ch] || MICRO[' '];
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 3; c++) if (g[r] & (4 >> c)) blendPx(t, cx + c, yy + r, col, a);
    }
    cx += 4;
  }
  return cx - 1;
}
function microC(t, s, cx, y, col, a) { return micro(t, s, cx - microWidth(s) / 2, y, col, a); }

/**
 * Paint a dressing onto a finished base, then light only what changed with
 * the same top-lit, grimy-skirt falloff the base already has, so a poster
 * does not glow like it is backlit. Blended edge pixels get lit twice at a
 * fraction of their strength, which is too small to see.
 */
function dress(t, kind, seed, fn) {
  const snap = t.slice();
  fn(t);
  const rng = makeRng(seed);
  const wall = kind === 'wall';
  // Feather back to the untouched base over the outer three texels: walls
  // join left and right, floors and ceilings on all four sides, and the
  // neighbour is usually plain.
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const e = wall ? Math.min(x, W - 1 - x) : Math.min(x, W - 1 - x, y, W - 1 - y);
      if (e >= 3) continue;
      const i = y * W + x;
      t[i] = mix(snap[i] >>> 0, t[i] >>> 0, e / 3);
    }
  }
  for (let y = 0; y < W; y++) {
    const v = y / (W - 1);
    const s = !wall ? 0.96
      : v < 0.45 ? lerp(1.08, 1.0, v / 0.45) : lerp(1.0, 0.72, (v - 0.45) / 0.55);
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const g = 1 + (rng() - 0.5) * 0.1;
      if (t[i] !== snap[i]) t[i] = mul(t[i] >>> 0, s * g);
    }
  }
}

/**
 * field() for a dressing that only touches a small patch: same values, but
 * computed per texel on demand instead of for all 4096 up front. Most of the
 * cost of painting a poster used to be the noise for the wall around it.
 */
function localField(seed, cells, oct) {
  return (x, y) => fbm(seed, (wrap(x) * cells) / W, (wrap(y) * cells) / W, oct, cells);
}

/** Filled convex-ish polygon via even-odd, anti-aliasing left to the grain. */
function poly(t, pts, c, a = 1) {
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) {
    for (let x = Math.floor(x0); x <= Math.ceil(x1); x++) {
      let inside = false;
      const px2 = x + 0.5, py2 = y + 0.5;
      for (let k = 0, l = pts.length - 1; k < pts.length; l = k++) {
        const [xi, yi] = pts[k], [xj, yj] = pts[l];
        if ((yi > py2) !== (yj > py2) && px2 < ((xj - xi) * (py2 - yi)) / (yj - yi) + xi) inside = !inside;
      }
      if (inside) blendPx(t, x, y, c, a);
    }
  }
}

/** Soft drop shadow for anything fixed to a wall: down and to the right. */
function castShadow(t, x, y, w, h, a = 0.45, off = 1.5) {
  for (let j = 0; j < h + 3; j++) {
    for (let i = 0; i < w + 3; i++) {
      const dx = i - off, dy = j - off;
      const inX = dx >= 0 && dx < w, inY = dy >= 0 && dy < h;
      if (!inX || !inY) continue;
      const e = Math.min(dx + 1, dy + 1, w - dx, h - dy);
      blendPx(t, x + i, y + j, BLACK, a * clamp(e / 2, 0.3, 1));
    }
  }
}

/** A sheet of paper stuck to the wall: shadow, stains, curled tape, a dog-ear. */
function paper(t, x, y, w, h, col, seed, opt = {}) {
  const rng = makeRng(seed);
  castShadow(t, x, y, w, h, 0.42);
  const f = localField(seed + 5, 6, 3);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const v = f(x + i, y + j);
      let c = mul(col, 0.9 + v * 0.2 - (j / h) * 0.08);
      if (v > 0.66) c = mix(c, rgba(150, 120, 70), (v - 0.66) * 1.6);    // water foxing
      blendPx(t, x + i, y + j, c, 1);
    }
  }
  bevel(t, x, y, w, h, add(col, 20), mul(col, 0.6), true, 1, 0.35);
  if (opt.tape !== false) {
    for (const [tx, ty] of [[x - 1, y - 1], [x + w - 3, y - 1]]) rect(t, tx, ty, 4, 3, rgba(214, 206, 160), 0.62);
  }
  if (opt.torn) {                                      // a strip ripped off the bottom
    for (let i = 0; i < w; i++) {
      const cut = Math.floor(2 + Math.abs(Math.sin(i * 1.7 + seed)) * 3 + rng() * 2);
      for (let j = 0; j < cut; j++) {
        const ix = idx(x + i, y + h - 1 - j);
        t[ix] = opt.under ? opt.under[ix] : t[ix];
      }
      blendPx(t, x + i, y + h - cut, add(col, 24), 0.6);
    }
  }
  if (opt.dogEar !== false) {                          // one curled corner, catching light
    const cx = x + w - 1, cy = y;
    for (let j = 0; j < 4; j++) for (let i = 0; i < 4 - j; i++) blendPx(t, cx - i, cy + j, mul(col, 0.62), 0.9);
    blendPx(t, cx - 1, cy + 1, add(col, 30), 0.8);
  }
}

/** Ragged hole where a bullet went in: dark core, a blown pale crater, cracks. */
function bulletHole(t, x, y, r, rng, base) {
  for (let k = 0; k < 5; k++) {
    const a = rng() * 6.283, l = r * (1.8 + rng() * 2.6);
    segment(t, x, y, x + Math.cos(a) * l, y + Math.sin(a) * l, mul(base, 0.3), 0.7, 0.6);
  }
  disc(t, x, y, r + 1.6, add(base, 46), 0.55, 1.2);      // fresh material, paler than the weathered face
  disc(t, x + 0.5, y + 0.6, r + 0.4, mul(base, 0.4), 0.8, 1);
  disc(t, x, y, r, rgba(8, 7, 7), 1, 0.8);
  blendPx(t, x - r * 0.5, y - r * 0.6, add(base, 60), 0.6);
}

/**
 * A bloody hand, pressed flat and dragged down. A drawn bitmap rather than
 * discs: at wall scale four separate fingers are what makes it read as a hand.
 */
const HAND = [
  '...#.......',
  '.#.#.#.....',
  '.#.#.#.#...',
  '.#.#.#.#...',
  '.#.#.#.#...',
  '.#######...',
  '.#######.#.',
  '.########..',
  '.#######...',
  '..######...',
  '..#####....',
  '...####....',
];
function handprint(t, x, y, s, col, rng, drag = 0) {
  const sc = Math.max(1, Math.round(s));
  const ox = Math.round(x - 5 * sc), oy = Math.round(y - 6 * sc);
  const c2 = mul(col, 0.72);
  for (let r = 0; r < HAND.length; r++) {
    for (let c = 0; c < HAND[r].length; c++) {
      if (HAND[r][c] !== '#') continue;
      const a = rng() < 0.18 ? 0.45 : 0.9;
      rect(t, ox + c * sc, oy + r * sc, sc, sc, (r + c) % 3 ? col : c2, a);
    }
  }
  if (drag > 0) {
    for (let k = 0; k < 4; k++) {
      const xx = ox + (2 + k * 2) * sc;
      segment(t, xx, oy + 11 * sc, xx + (rng() - 0.5) * 2, oy + 11 * sc + drag * (0.6 + rng() * 0.4), c2, sc, 0.6);
    }
  }
  for (let k = 0; k < 3; k++) {
    drip(t, (rng() * 1e6) | 0, ox + (2 + rng() * 6) * sc, oy + 11 * sc, oy + 14 * sc + rng() * 12, mul(col, 0.8), 0.55, 1);
  }
}

/**
 * Spray-painted words: hard core stroke, overspray halo, runs where the can
 * was held too long. `jit` wobbles each glyph so it does not look typeset.
 */
function spray(t, s, x, y, scale, col, rng, opt = {}) {
  const jit = opt.jit == null ? 0.8 : opt.jit;
  const str = String(s).toUpperCase();
  let cx = x;
  const tmp = [];
  for (let n = 0; n < str.length; n++) {
    const g = GLYPHS[str[n]];
    const oy = (rng() - 0.5) * jit * 2, ox = (rng() - 0.5) * jit;
    if (g) {
      for (let r = 0; r < 7; r++) {
        for (let c2 = 0; c2 < 5; c2++) {
          if (g[r].charCodeAt(c2) !== 49) continue;
          tmp.push([cx + ox + c2 * scale + scale / 2, y + oy + r * scale + scale / 2]);
        }
      }
    }
    cx += 6 * scale + (opt.track || 0);
  }
  for (const [px2, py2] of tmp) glow(t, px2, py2, scale * 1.9, col, 0.16, 1.6);    // overspray
  for (const [px2, py2] of tmp) disc(t, px2, py2, scale * 0.62, col, 0.92, 0.9);
  const runs = opt.runs == null ? 3 : opt.runs;
  for (let k = 0; k < runs && tmp.length; k++) {
    const p = tmp[(rng() * tmp.length) | 0];
    drip(t, (rng() * 1e6) | 0, p[0], p[1], p[1] + 4 + rng() * 10, col, 0.7, 0.9);
  }
  return cx - x;
}

/** Marker-pen scrawl in the micro font, slightly wobbly. */
function scrawl(t, s, x, y, col, rng, a = 0.9) {
  let cx = x;
  for (const ch of String(s).toUpperCase()) {
    micro(t, ch, cx, y + Math.round((rng() - 0.5) * 1.2), col, a);
    cx += 4;
  }
  return cx;
}

/** Tally marks, in groups of five with the slash. */
function tally(t, x, y, n, col, h = 6) {
  let cx = x;
  for (let k = 0; k < n; k++) {
    if (k % 5 === 4) {
      segment(t, cx - 17, y + h - 1, cx - 1, y + 1, col, 1, 0.9);
      cx += 3;
    } else {
      vline(t, cx, y, y + h, col, 0.9);
      cx += 4;
    }
  }
}

/** Rigid sign: screwed plate, bevelled, one or more lines of 5x7 or micro text. */
function placard(t, x, y, w, h, bg, fg, lines, opt = {}) {
  castShadow(t, x, y, w, h, 0.5, 1.5);
  rect(t, x, y, w, h, bg, 1);
  const f = localField(opt.seed || 5501, 8, 3);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const ix = idx(x + i, y + j);
    t[ix] = mul(t[ix], 0.9 + f(x + i, y + j) * 0.2);
  }
  bevel(t, x, y, w, h, add(bg, 40), mul(bg, 0.45), true, 1, 0.8);
  if (opt.border) {
    const b = opt.border;
    for (let i = 2; i < w - 2; i++) { blendPx(t, x + i, y + 2, b, 0.9); blendPx(t, x + i, y + h - 3, b, 0.9); }
    for (let j = 2; j < h - 2; j++) { blendPx(t, x + 2, y + j, b, 0.9); blendPx(t, x + w - 3, y + j, b, 0.9); }
  }
  let ly = y + (opt.pad == null ? 3 : opt.pad);
  for (const L of lines) {
    const big = L.big;
    const s = L.text;
    const col = L.col || fg;
    if (big) {
      drawTextCentered(t, s, x + w / 2, ly, 1, col);
      ly += 9;
    } else {
      microC(t, s, x + w / 2, ly, col);
      ly += 6;
    }
  }
  if (opt.screws !== false) {
    for (const [sx, sy] of [[x + 1.5, y + 1.5], [x + w - 2.5, y + 1.5], [x + 1.5, y + h - 2.5], [x + w - 2.5, y + h - 2.5]]) {
      blendPx(t, sx, sy, mul(C.steel, 1.3), 0.9);
      blendPx(t, sx + 1, sy + 1, BLACK, 0.5);
    }
  }
}

/** Tide-line water stain spreading down from something that leaked above. */
function waterStain(t, cx, y0, w, h, seed, col = rgba(58, 52, 40)) {
  const fl = localField(seed, 8, 4);
  for (let y = y0; y < Math.min(W, y0 + h); y++) {
    const v = (y - y0) / h;
    const half = w * 0.5 * (0.35 + Math.sin(v * Math.PI * 0.9) * 0.65);
    for (let x = Math.floor(cx - half - 3); x <= Math.ceil(cx + half + 3); x++) {
      const d = Math.abs(x - cx) / Math.max(1, half) + (fl(x, y) - 0.5) * 0.6;
      if (d > 1.05) continue;
      const rim = d > 0.86 ? 0.55 : 0.2 + v * 0.12;
      blendPx(t, x, y, col, rim);
    }
  }
}

/** A dragged smear of blood, darker and drier at the tail. */
function smear(t, x0, y0, x1, y1, wdt, rng) {
  const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 1.5);
  for (let s2 = 0; s2 <= n; s2++) {
    const u = s2 / n;
    const x = lerp(x0, x1, u), y = lerp(y0, y1, u);
    const ww = wdt * (1 - u * 0.6);
    for (let k = -ww; k <= ww; k += 0.8) {
      if (rng() < 0.18 + u * 0.4) continue;
      const nx = -(y1 - y0), ny = x1 - x0, nl = Math.hypot(nx, ny) || 1;
      blendPx(t, x + nx / nl * k, y + ny / nl * k, mix(C.bloodWet, C.bloodDk, u), 0.55 + (1 - u) * 0.35);
    }
  }
}

/** A grey fuse box on the wall with a conduit running up out of it. */
function fuseBox(t, x, y, w, h, rng, open = false) {
  const body = rgba(96, 102, 96);
  const cx = x + (w >> 1);
  for (let k = 0; k < 2; k++) {                        // conduit up to the ceiling
    const vx = cx - 3 + k * 5;
    vline(t, vx + 1, 0, y, BLACK, 0.4);
    vline(t, vx, 0, y, mul(C.steel, 1.05), 0.95);
    vline(t, vx - 1, 0, y, mul(C.spec, 0.8), 0.45);
    for (let yy = 6; yy < y; yy += 14) rect(t, vx - 2, yy, 4, 2, mul(C.steelDk, 1.4), 0.9);
  }
  castShadow(t, x, y, w, h, 0.55, 2);
  rect(t, x, y, w, h, body, 1);
  bevel(t, x, y, w, h, add(body, 46), mul(body, 0.4), true, 1, 0.9);
  if (open) {
    rect(t, x + 2, y + 2, w - 4, h - 4, rgba(26, 28, 30), 1);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 4; c++) {
        const bx = x + 4 + c * ((w - 8) / 4), by = y + 4 + r * 5;
        rect(t, bx, by, 2, 3, c === 2 && r === 1 ? rgba(200, 60, 40) : rgba(190, 186, 170), 1);
      }
    }
    rect(t, x + w, y + 1, 3, h - 2, mul(body, 0.8), 1);          // door swung open
    bevel(t, x + w, y + 1, 3, h - 2, add(body, 30), BLACK, true, 1, 0.8);
  } else {
    hline(t, y + 5, x + 2, x + w - 3, mul(body, 0.55), 0.8);
    rect(t, x + w - 5, y + (h >> 1) - 2, 2, 5, rgba(40, 40, 40), 1);   // latch
    // the lightning-bolt sticker every fuse box in the world has
    const bx = x + (w >> 1) - 3, by = y + 8;
    poly(t, [[bx, by], [bx + 7, by], [bx + 7, by + 7], [bx, by + 7]], C.yellow, 1);
    poly(t, [[bx + 4, by + 1], [bx + 1.5, by + 4], [bx + 3.5, by + 4], [bx + 2.5, by + 6.5], [bx + 5.5, by + 3], [bx + 3.5, by + 3]], BLACK, 1);
  }
  for (const [sx, sy] of [[x + 1, y + 1], [x + w - 2, y + 1], [x + 1, y + h - 2], [x + w - 2, y + h - 2]]) blendPx(t, sx, sy, C.spec, 0.8);
  drip(t, (rng() * 1e6) | 0, x + 3, y + h, y + h + 12, mul(C.rustDk, 1.1), 0.45, 1.1);
}

/** Loose cables clipped along the wall, one hanging free with bare copper. */
function cables(t, y, rng, n = 3, loose = true) {
  const cols = [rgba(30, 30, 34), rgba(24, 24, 26), rgba(130, 36, 28), rgba(40, 40, 46)];
  const x0 = 3, x1 = 60;
  for (let k = 0; k < n; k++) {
    const sag = 2 + rng() * 2.5, yy = y + k * 2;
    const col = cols[k % cols.length];
    for (let x = x0; x <= x1; x++) {
      const u = (x - x0) / (x1 - x0);
      const s2 = Math.abs(Math.sin(u * Math.PI * 2)) * sag;   // two swags between three clips
      blendPx(t, x, yy + s2 + 1.4, BLACK, 0.35);
      blendPx(t, x, yy + s2, col, 0.95);
      blendPx(t, x, yy + s2 - 0.7, add(col, 50), 0.3);
    }
  }
  for (const cx of [x0, (x0 + x1) >> 1, x1]) {          // the clips
    rect(t, cx - 1, y - 1, 3, n * 2 + 1, mul(C.steel, 1.1), 1);
    blendPx(t, cx - 1, y - 1, C.specHot, 0.6);
  }
  if (loose) {
    let px2 = 14 + rng() * 34, py2 = y + n * 2 + 3;
    for (let s2 = 0; s2 < 22; s2++) {
      px2 += Math.sin(s2 * 0.3) * 0.35; py2 += 1;
      blendPx(t, px2 + 1, py2 + 0.6, BLACK, 0.3);
      blendPx(t, px2, py2, rgba(30, 30, 34), 0.95);
    }
    disc(t, px2, py2 + 1, 1, C.rustLt, 1, 0.8);                    // bare copper
    blendPx(t, px2 + 1, py2 + 2, rgba(255, 220, 140), 0.8);
  }
}

/** A cartoon pin-up silhouette, mudflap style. Cheeky, never explicit. */
function pinupGirl(t, x, y, s, col) {
  const P = (u, v) => [x + u * s, y + v * s];
  const seg = (a, b, th) => segment(t, ...P(...a), ...P(...b), col, th * s, 1);
  disc(t, ...P(0.30, 0.10), 0.075 * s, col, 1, 0.8);           // head
  seg([0.30, 0.08], [0.16, 0.20], 0.09);                      // hair, flicked back
  seg([0.18, 0.18], [0.12, 0.28], 0.06);
  seg([0.31, 0.17], [0.36, 0.36], 0.12);                      // chest
  disc(t, ...P(0.40, 0.27), 0.06 * s, col, 1, 0.8);
  seg([0.36, 0.36], [0.37, 0.48], 0.08);                      // waist
  disc(t, ...P(0.40, 0.54), 0.095 * s, col, 1, 0.8);          // hips
  seg([0.29, 0.20], [0.15, 0.38], 0.045);                     // arm propped behind
  seg([0.15, 0.38], [0.14, 0.58], 0.04);
  seg([0.42, 0.56], [0.70, 0.62], 0.1);                       // thigh
  seg([0.70, 0.62], [0.62, 0.90], 0.065);                     // shin
  seg([0.62, 0.90], [0.70, 0.95], 0.04);                      // pointed toe
  seg([0.44, 0.52], [0.62, 0.40], 0.09);                      // knee up
  seg([0.62, 0.40], [0.66, 0.64], 0.06);
}

/** Wall clock, stopped at the moment someone gave up. */
function wallClock(t, cx, cy, r, hh, mm) {
  castShadow(t, cx - r, cy - r, r * 2, r * 2, 0.35, 1.2);
  disc(t, cx, cy, r, rgba(40, 40, 42), 1, 1);
  disc(t, cx, cy, r - 1.2, rgba(222, 218, 200), 1, 1);
  for (let k = 0; k < 12; k++) {
    const a = k * 0.5236;
    blendPx(t, cx + Math.cos(a) * (r - 2.2), cy + Math.sin(a) * (r - 2.2), BLACK, 0.9);
  }
  const ha = (hh / 12) * 6.283 - 1.5708, ma = (mm / 60) * 6.283 - 1.5708;
  segment(t, cx, cy, cx + Math.cos(ha) * r * 0.45, cy + Math.sin(ha) * r * 0.45, BLACK, 1, 1);
  segment(t, cx, cy, cx + Math.cos(ma) * r * 0.72, cy + Math.sin(ma) * r * 0.72, BLACK, 0.8, 1);
  glow(t, cx - r * 0.35, cy - r * 0.4, r * 0.5, WHITE, 0.25, 2);
}

/** The Kilroy doodle: nose over a wall. Every war has one. */
function kilroy(t, x, y, col, a = 0.9) {
  hline(t, y + 6, x, x + 14, col, a);
  for (let i = 0; i <= 8; i++) {
    const u = i / 8 * Math.PI;
    blendPx(t, x + 3 + i, y + 6 - Math.sin(u) * 5, col, a);
  }
  disc(t, x + 5.5, y + 3.5, 0.8, col, a, 0.6); disc(t, x + 8.5, y + 3.5, 0.8, col, a, 0.6);
  segment(t, x + 7, y + 4, x + 7, y + 9, col, 1.4, a);           // the nose
  for (const fx of [x + 1, x + 13]) { vline(t, fx, y + 5, y + 7, col, a); blendPx(t, fx + (fx < x + 7 ? 1 : -1), y + 5, col, a); }
}

/** Mortar-free rubble chunks on a floor, lit from the upper left. */
function rubble(t, cx, cy, n, spread, rng, base) {
  for (let k = 0; k < n; k++) {
    const x = cx + (rng() - 0.5) * spread * 2, y = cy + (rng() - 0.5) * spread * 2;
    const r = 0.9 + rng() * 2.2;
    const pts = [];
    const m = 5 + ((rng() * 3) | 0), rot = rng() * 6.283;
    for (let q = 0; q < m; q++) {
      const a = rot + q / m * 6.283, rr = r * (0.6 + rng() * 0.5);
      pts.push([x + Math.cos(a) * rr, y + Math.sin(a) * rr]);
    }
    poly(t, pts.map(([a, b]) => [a + 0.9, b + 1.1]), BLACK, 0.45);
    const c = mul(base, 0.7 + rng() * 0.6);
    poly(t, pts, c, 1);
    blendPx(t, x - r * 0.3, y - r * 0.3, add(c, 40), 0.6);
  }
}

/** Dark reflective puddle with a lit rim and a streak of ceiling light in it. */
function puddle(t, cx, cy, rx, ry, seed, tint = rgba(20, 24, 28)) {
  const fl = localField(seed, 8, 3);
  for (let y = Math.floor(cy - ry - 3); y <= Math.ceil(cy + ry + 3); y++) {
    for (let x = Math.floor(cx - rx - 3); x <= Math.ceil(cx + rx + 3); x++) {
      const d = Math.hypot((x - cx) / rx, (y - cy) / ry) + (fl(x, y) - 0.5) * 0.5;
      if (d > 1.08) continue;
      if (d > 0.92) { blendPx(t, x, y, mul(tint, 1.8), 0.5); continue; }       // wet rim
      const c = mix(tint, rgba(70, 80, 92), clamp(0.3 - (y - cy) / ry * 0.3, 0, 1));
      blendPx(t, x, y, c, 0.82);
    }
  }
  segment(t, cx - rx * 0.5, cy - ry * 0.25, cx + rx * 0.2, cy - ry * 0.35, rgba(170, 180, 190), 1.2, 0.35);
}

/** Round floor drain with a slotted cover, grime ring, a dark wet halo. */
function drain(t, cx, cy, r) {
  glow(t, cx, cy, r + 7, rgba(22, 20, 16), 0.5, 1.4);
  disc(t, cx, cy, r + 1.4, mul(C.steelDk, 0.9), 1, 1);
  disc(t, cx, cy, r, mul(C.steel, 0.9), 1, 1);
  for (let k = -r + 2; k <= r - 2; k += 2.5) {
    const hw = Math.sqrt(Math.max(0, r * r - k * k)) - 1.5;
    if (hw > 0) segment(t, cx - hw, cy + k, cx + hw, cy + k, rgba(6, 6, 8), 1.1, 1);
  }
  for (let a = 0; a < 6.283; a += 0.05) blendPx(t, cx + Math.cos(a) * r, cy + Math.sin(a) * r, Math.sin(a + 0.8) < 0 ? C.spec : BLACK, 0.4);
  rivet(t, cx, cy, 1.2, C.steel);
}

/** Iridescent oil stain: dark core, rainbow ring where it thins. */
function oilStain(t, cx, cy, r, seed) {
  const fl = localField(seed, 6, 3);
  for (let y = Math.floor(cy - r - 2); y <= Math.ceil(cy + r + 2); y++) {
    for (let x = Math.floor(cx - r - 2); x <= Math.ceil(cx + r + 2); x++) {
      const d = Math.hypot(x - cx, y - cy) / r + (fl(x, y) - 0.5) * 0.7;
      if (d > 1) continue;
      blendPx(t, x, y, rgba(12, 10, 12), 0.72 * (1 - d * 0.4));
      if (d > 0.7) {
        const h = (d - 0.7) / 0.3;
        const c = h < 0.33 ? rgba(90, 60, 120) : h < 0.66 ? rgba(40, 110, 100) : rgba(130, 110, 40);
        blendPx(t, x, y, c, 0.28);
      }
    }
  }
}

/** Stencilled floor arrow. */
function floorArrow(t, cx, cy, s, col, a = 0.8) {
  poly(t, [[cx - s * 0.3, cy + s], [cx + s * 0.3, cy + s], [cx + s * 0.3, cy], [cx + s * 0.7, cy],
    [cx, cy - s], [cx - s * 0.7, cy], [cx - s * 0.3, cy]], col, a);
}

/** A skull, for walls and floors that have seen things. */
function skull(t, cx, cy, s, bone = rgba(206, 196, 170)) {
  disc(t, cx + 0.6, cy + 0.8, s, BLACK, 0.4, 1);
  disc(t, cx, cy, s, bone, 1, 0.9);
  rect(t, cx - s * 0.55, cy + s * 0.5, s * 1.1, s * 0.7, bone, 1);
  disc(t, cx - s * 0.4, cy + s * 0.05, s * 0.3, rgba(26, 20, 16), 1, 0.7);
  disc(t, cx + s * 0.4, cy + s * 0.05, s * 0.3, rgba(26, 20, 16), 1, 0.7);
  blendPx(t, cx, cy + s * 0.5, rgba(26, 20, 16), 1);
  for (let k = -1; k <= 1; k++) vline(t, cx + k * s * 0.35, cy + s * 0.8, cy + s * 1.1, mul(bone, 0.5), 0.8);
  glow(t, cx - s * 0.4, cy - s * 0.5, s * 0.6, WHITE, 0.25, 2);
}

// ---------------------------------------------------------------------------
// new materials
// ---------------------------------------------------------------------------

/** INTAKE's corridors: painted cinderblock, government green under cream. */
function paintOfficeWall(t) {
  concreteBase(t, 40101, { tone: 1.05 });
  const cream = rgba(188, 180, 150), green = rgba(72, 100, 82), band = rgba(92, 64, 44);
  const brush = field(40111, 12, 3);
  for (let y = 0; y < W; y++) {
    const course = y >> 3, ly = y & 7;
    const off = (course & 1) ? 8 : 0;
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const lx = (x + off) & 15;
      const l = lum(t[i]) / 90;
      const paint = y < 36 ? cream : y < 39 ? band : green;
      let c = mul(paint, 0.78 + l * 0.26 + brush[i] * 0.08);
      // mortar joints: painted over, so recessed rather than grey
      if (ly === 7 || lx === 15) c = mul(c, 0.66);
      else if (ly === 0 || lx === 0) c = mul(c, 1.1);
      else if (ly === 6) c = mul(c, 0.9);
      t[i] = c;
    }
  }
  hline(t, 35, 0, 63, add(band, 30), 0.5);             // the dado stripe catches light
  hline(t, 39, 0, 63, BLACK, 0.35);
  const snap = t.slice();
  const rng = makeRng(40133);
  for (let i = 0; i < 16; i++) {                       // chair backs and trolley scuffs
    const x = rng() * W, y = 40 + rng() * 14, l = 3 + rng() * 9;
    segment(t, x, y, x + l, y + (rng() - 0.5) * 2, rgba(30, 30, 30), 1, 0.25 + rng() * 0.25);
  }
  for (let i = 0; i < 5; i++) {                        // chipped paint showing block
    const x = rng() * W, y = rng() * W;
    disc(t, x, y, 1 + rng() * 1.6, mul(C.conc, 0.95), 0.9, 1);
  }
  chipBack(t, snap, 40144, 20, 0.74, 0.35, 3);
  dampBloom(t, 40155, 0.32);
  grain(t, 40177, 0.05);
  wallLight(t, { seed: 40188, top: 1.12, bot: 0.62, grime: 0.55 });
}

/** SALT CATHEDRAL: groundwater got in and left the concrete furred with salt. */
function saltCrust(t, seed, amt = 1) {
  const f = field(seed, 6, 4), f2 = field(seed + 11, 18, 3);
  for (let y = 0; y < W; y++) {
    const v = y / (W - 1);
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const tide = Math.exp(-Math.pow((v - 0.72) / 0.14, 2)) * 0.35 + Math.exp(-Math.pow((v - 0.3) / 0.06, 2)) * 0.2;
      const n = f[i] * 0.7 + f2[i] * 0.3 + tide + v * 0.18;
      const k = clamp((n - 0.58) * 3.4, 0, 1) * amt;
      if (k <= 0) continue;
      const crystal = mix(rgba(168, 176, 184), rgba(236, 238, 236), clamp(f2[i] * 1.6 - 0.3, 0, 1));
      t[i] = mix(t[i], crystal, k * 0.9);
      if (k > 0.2 && k < 0.35) t[i] = mix(t[i], rgba(120, 104, 80), 0.35);       // brown fringe
    }
  }
  const rng = makeRng(seed + 23);
  for (let k = 0; k < 90 * amt; k++) {                 // glints
    const x = rng() * W, y = rng() * W;
    if (lum(at(t, x, y)) > 150) blendPx(t, x, y, WHITE, 0.7);
  }
}
function paintSaltWall(t) {
  concreteBase(t, 41101, { tone: 0.92, lo: rgba(44, 48, 56), hi: rgba(104, 110, 118) });
  for (const y of [18, 46]) {                          // pour lines from the shuttering
    hline(t, y, 0, 63, BLACK, 0.3); hline(t, y + 1, 0, 63, add(C.conc, 30), 0.15);
  }
  for (let x = 6; x < W; x += 32) for (const y of [9, 31, 55]) dimple(t, x + 10, y, 1.5, C.concDk);
  saltCrust(t, 41111, 1);
  const rng = makeRng(41122);
  for (let k = 0; k < 7; k++) {                        // cubic crystal clusters on the tide line
    const cx = rng() * W, cy = 40 + rng() * 14;
    for (let q = 0; q < 4; q++) {
      const x = cx + (rng() - 0.5) * 5, y = cy + (rng() - 0.5) * 3, s = 1 + rng() * 1.6;
      rect(t, x + 0.8, y + 0.8, s + 1, s + 1, BLACK, 0.4);
      rect(t, x, y, s + 1, s + 1, rgba(214, 222, 228), 1);
      blendPx(t, x, y, WHITE, 0.9);
    }
  }
  for (let k = 0; k < 5; k++) drip(t, 41133 + k, rng() * W, 20 + rng() * 20, 60, rgba(222, 226, 226), 0.4, 1.3);
  grain(t, 41147, 0.06);
  wallLight(t, { seed: 41148, top: 1.14, bot: 0.66, grime: 0.35, grimeCol: rgba(40, 44, 50) });
}

/** Four steel lockers per cell, government blue-grey, all slightly dented. */
function lockerBank(t, seed, labels, open = -1) {
  steelBase(t, seed, { col: rgba(74, 92, 104) });
  const rng = makeRng(seed + 7);
  for (let k = 0; k < 4; k++) {
    const x0 = k * 16;
    vline(t, x0, 0, 63, rgba(14, 16, 20), 0.9);        // gap between doors
    vline(t, x0 + 1, 2, 60, add(C.spec, -40), 0.35);
    vline(t, x0 + 15, 2, 60, BLACK, 0.35);
    hline(t, 2, x0 + 1, x0 + 14, BLACK, 0.5);
    hline(t, 60, x0 + 1, x0 + 14, BLACK, 0.6);
    rect(t, x0 + 1, 61, 14, 3, rgba(26, 28, 30), 1);    // kick plinth
    if (k === open) {
      rect(t, x0 + 1, 3, 14, 57, rgba(18, 18, 20), 1);   // the inside
      for (let y = 3; y < 60; y++) blendPx(t, x0 + 14, y, mul(C.spec, 0.5), 0.3);
      hline(t, 14, x0 + 2, x0 + 13, mul(C.steel, 0.9), 1);   // hat shelf
      hline(t, 15, x0 + 2, x0 + 13, BLACK, 0.8);
      continue;
    }
    for (let v = 0; v < 4; v++) {                      // vent slits, top and bottom
      for (const y0 of [6, 50]) {
        const y = y0 + v * 2;
        hline(t, y, x0 + 4, x0 + 11, rgba(10, 10, 12), 0.95);
        hline(t, y + 1, x0 + 4, x0 + 11, add(C.spec, -30), 0.35);
      }
    }
    rect(t, x0 + 5, 17, 6, 4, rgba(170, 146, 76), 1);    // brass number plate
    bevel(t, x0 + 5, 17, 6, 4, rgba(220, 200, 130), rgba(90, 70, 30), true, 1, 0.7);
    micro(t, labels[k], x0 + 5.5 + (labels[k].length === 1 ? 1.5 : -0.5), 17, rgba(40, 30, 16), 0.9);
    rect(t, x0 + 11, 28, 2, 7, rgba(170, 176, 184), 1);   // handle
    blendPx(t, x0 + 11, 28, WHITE, 0.6);
    rect(t, x0 + 12, 29, 1, 6, BLACK, 0.4);
    disc(t, x0 + 12, 38, 1.1, rgba(150, 150, 150), 1, 0.8);   // lock
    if (rng() < 0.5) {                                 // somebody kicked it
      const dx = x0 + 4 + rng() * 7, dy = 34 + rng() * 14;
      disc(t, dx + 0.6, dy + 0.6, 2.2, BLACK, 0.35, 1.5);
      disc(t, dx - 0.6, dy - 0.6, 1.6, add(C.spec, -20), 0.3, 1.2);
    }
  }
  edgeRust(t, seed + 33, 0.45, { top: 0.1, bot: 0.8, side: 0 });
  grain(t, seed + 44, 0.05);
  wallLight(t, { seed: seed + 55, top: 1.12, bot: 0.6, grime: 0.5 });
}
function paintLockers(t) { lockerBank(t, 42101, ['13', '14', '15', '16']); }

/** MUTTER's own racks: black 19-inch units, a thousand little lights. */
function paintServer(t, seed = 43101) {
  fill(t, rgba(14, 14, 18));
  const rng = makeRng(seed);
  for (const rx of [0, 32]) {
    rect(t, rx, 0, 3, 64, rgba(40, 42, 48), 1);         // rails
    rect(t, rx + 29, 0, 3, 64, rgba(34, 36, 42), 1);
    for (let y = 2; y < 64; y += 4) { blendPx(t, rx + 1, y, BLACK, 0.9); blendPx(t, rx + 30, y, BLACK, 0.9); }
    vline(t, rx + 2, 0, 63, rgba(80, 84, 92), 0.5);
    let y = 2;
    while (y < 60) {
      const hU = [4, 4, 6, 8, 4, 10][(rng() * 6) | 0];
      if (y + hU > 62) break;
      const face = rgba(30 + ((rng() * 14) | 0), 30 + ((rng() * 14) | 0), 36 + ((rng() * 14) | 0));
      rect(t, rx + 3, y, 26, hU - 1, face, 1);
      bevel(t, rx + 3, y, 26, hU - 1, add(face, 36), BLACK, true, 1, 0.8);
      const kind = rng();
      if (kind < 0.35) {                                // disk shelf: drive caddies
        for (let d = 0; d < 6; d++) {
          rect(t, rx + 5 + d * 4, y + 1, 3, hU - 3, rgba(58, 60, 66), 1);
          blendPx(t, rx + 5 + d * 4, y + 1, rng() < 0.7 ? C.green : C.amber, 1);
        }
      } else if (kind < 0.6) {                          // LED matrix
        for (let r = 0; r < hU - 3; r += 2) {
          for (let c = 0; c < 20; c += 2) {
            if (rng() < 0.45) blendPx(t, rx + 6 + c, y + 1 + r, rng() < 0.8 ? C.green : C.amber, 1);
          }
        }
      } else if (kind < 0.8) {                          // tape slot and a readout
        rect(t, rx + 6, y + 1, 12, 2, rgba(6, 6, 8), 1);
        rect(t, rx + 20, y + 1, 7, hU - 3, rgba(10, 30, 16), 1);
        micro(t, (rng() * 90 + 10 | 0) + '', rx + 20, y + 1, C.green, 0.9);
      } else {                                          // vent grille
        for (let c = 0; c < 22; c += 2) vline(t, rx + 5 + c, y + 1, y + hU - 3, BLACK, 0.8);
        if (hU > 5) blendPx(t, rx + 26, y + 2, C.cyan, 1);
      }
      y += hU;
    }
  }
  bloom(t, 2, 110, 0.9);
  grain(t, 43111, 0.05);
  wallLight(t, { seed: 43122, top: 1.05, bot: 0.8, grime: 0.3 });
}

/** THE ORGAN LOFT: the air handler grew pipes and started singing. */
function paintOrganPipes(t, tops = [22, 14, 8, 4, 4, 8, 14, 22]) {
  const wood = field(44101, 16, 3), grainF = runField(44111);
  for (let i = 0; i < AREA; i++) {
    t[i] = mul(mix(rgba(42, 24, 16), rgba(78, 46, 28), grainF[i]), 0.8 + wood[i] * 0.3);
  }
  // tops: the mitre, tall in the middle by default
  const verd = field(44122, 10, 3);
  for (let k = 0; k < 8; k++) {
    const x0 = k * 8 + 0.5, top = tops[k], cx = x0 + 3.5;
    for (let y = top; y < 56; y++) {
      const foot = y > 46 ? (y - 46) / 10 : 0;          // tapering foot
      const hw = 3.4 - foot * 2.2;
      for (let x = Math.floor(cx - hw - 1); x <= Math.ceil(cx + hw + 1); x++) {
        const u = (x + 0.5 - cx) / hw;
        if (Math.abs(u) > 1) { if (Math.abs(u) < 1.35) blendPx(t, x, y, BLACK, 0.5); continue; }
        const lam = cyl(u);
        let c = mix(rgba(84, 58, 22), rgba(236, 196, 104), lam);
        if (lam > 0.9) c = mix(c, rgba(255, 244, 200), (lam - 0.9) * 6);
        const vv = verd[idx(x, y)];
        if (vv > 0.6) c = mix(c, rgba(70, 120, 96), clamp((vv - 0.6) * 3, 0, 0.7));   // verdigris
        put(t, x, y, c);
      }
    }
    for (let x = -3; x <= 3; x++) blendPx(t, cx + x, top, rgba(20, 12, 6), 0.95);   // open top
    const my = 40 - (k % 2) * 4;                        // the mouth, where it speaks
    rect(t, cx - 2, my, 5, 4, rgba(16, 10, 6), 1);
    hline(t, my - 1, cx - 2, cx + 2, rgba(255, 236, 170), 0.7);
    for (let x = -2; x <= 2; x++) blendPx(t, cx + x, my + 4 - Math.abs(x) * 0.5, rgba(120, 84, 36), 0.9);
  }
  rect(t, 0, 56, 64, 8, rgba(36, 20, 12), 1);          // the wind chest
  hline(t, 56, 0, 63, rgba(120, 80, 44), 0.6);
  for (let x = 4; x < W; x += 8) rivet(t, x, 60, 1.2, rgba(150, 110, 50));
  grain(t, 44133, 0.06);
  wallLight(t, { seed: 44144, top: 1.1, bot: 0.62, grime: 0.4 });
}

/** INTAKE floor: speckled vinyl composition tile, waxed until 1991. */
function paintFloorLino(t) {
  const a = rgba(146, 140, 118), b = rgba(88, 104, 90);
  const wax = field(45101, 4, 4), fine = field(45111, 32, 2);
  const rng = makeRng(45122);
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const chk = ((x >> 4) + (y >> 4)) & 1;
      let c = chk ? a : b;
      c = mul(c, 0.86 + fine[i] * 0.2 + (wax[i] - 0.5) * 0.18);
      if (rng() < 0.08) c = mul(c, rng() < 0.5 ? 0.7 : 1.2);            // VCT chips
      const lx = x & 15, ly = y & 15;
      if (lx === 0 || ly === 0) c = mul(c, 0.72);
      t[i] = c;
    }
  }
  for (let i = 0; i < 14; i++) {                       // black heel marks
    const x = rng() * W, y = rng() * W, r = 3 + rng() * 6, a0 = rng() * 6.283;
    for (let q = 0; q < 1; q += 0.05) blendPx(t, x + Math.cos(a0 + q) * r, y + Math.sin(a0 + q) * r, rgba(24, 22, 20), 0.35);
  }
  const dirt = field(45133, 5, 3);
  for (let i = 0; i < AREA; i++) t[i] = mix(t[i], rgba(70, 60, 44), clamp((dirt[i] - 0.55) * 2.2, 0, 1) * 0.4);
  edgeDark(t, 0.18, 3);
  grain(t, 45144, 0.05);
}

/** Salt drifted over concrete, crusted into rosettes. */
function paintFloorSalt(t) {
  concreteBase(t, 46101, { tone: 0.95, lo: rgba(52, 52, 56), hi: rgba(110, 108, 104) });
  const f = field(46111, 5, 4), f2 = field(46122, 16, 3);
  for (let i = 0; i < AREA; i++) {
    const n = f[i] * 0.75 + f2[i] * 0.25;
    const k = clamp((n - 0.46) * 3, 0, 1);
    t[i] = mix(t[i], mix(rgba(140, 144, 146), rgba(190, 192, 188), f2[i]), k * 0.75);
  }
  const rng = makeRng(46133);
  for (let k = 0; k < 16; k++) {                       // cubic crystals grown in the brine
    const x = 5 + rng() * 54, y = 5 + rng() * 54, sz = 1 + rng() * 2;
    rect(t, x + 1, y + 1, sz + 1, sz + 1, BLACK, 0.4);
    rect(t, x, y, sz + 1, sz + 1, rgba(226, 230, 232), 1);
    blendPx(t, x, y, WHITE, 0.9);
  }
  speckle(t, 46144, 70, rgba(220, 224, 226), 0.2, 0.5, 0.5);
  edgeDark(t, 0.25, 4);
  grain(t, 46155, 0.06);
}

/** MUTTER's machine room: raised access floor, the odd perforated panel. */
function paintFloorRaised(t) {
  const f = field(47101, 8, 3);
  for (let i = 0; i < AREA; i++) t[i] = mul(rgba(96, 100, 108), 0.86 + f[i] * 0.22);
  for (let py = 0; py < 2; py++) {
    for (let px2 = 0; px2 < 2; px2++) {
      const x0 = px2 * 32, y0 = py * 32;
      bevel(t, x0, y0, 32, 32, add(C.spec, -10), BLACK, true, 2, 0.7);
      if (px2 === py) {                                // perforated cooling tile
        for (let y = 5; y < 28; y += 3) for (let x = 5; x < 28; x += 3) {
          blendPx(t, x0 + x, y0 + y, rgba(8, 8, 10), 1);
          blendPx(t, x0 + x + 1, y0 + y, rgba(8, 8, 10), 0.6);
        }
      }
      for (const [sx, sy] of [[3, 3], [28, 3], [3, 28], [28, 28]]) screw(t, x0 + sx, y0 + sy, 1.1, C.steel);
    }
  }
  const rng = makeRng(47111);
  for (let i = 0; i < 12; i++) {
    const x = rng() * W, y = rng() * W, l = 3 + rng() * 8;
    segment(t, x, y, x + l, y + (rng() - 0.5) * 3, rgba(40, 40, 44), 1, 0.3);
  }
  grain(t, 47122, 0.05);
}

/** THE FURNACE: floor plates baked black and blue by the heat underneath. */
function paintFloorScorch(t) {
  steelBase(t, 48101, { col: rgba(70, 66, 64) });
  const soot = field(48111, 5, 4), temper = field(48122, 3, 3);
  for (let i = 0; i < AREA; i++) {
    const v = temper[i];
    // heat tint: straw, bronze, purple, blue, the order steel goes as it cooks
    const tc = v < 0.35 ? rgba(150, 120, 70) : v < 0.5 ? rgba(130, 80, 60) : v < 0.62 ? rgba(90, 60, 110) : rgba(60, 80, 130);
    t[i] = mix(t[i], tc, 0.13);
    t[i] = mix(t[i], rgba(12, 10, 10), clamp((soot[i] - 0.4) * 2.2, 0, 1) * 0.75);
  }
  for (const p of [0, 32]) {                           // plate seams with weld beads
    for (let k = 0; k < W; k++) {
      blendPx(t, p, k, BLACK, 0.7); blendPx(t, k, p, BLACK, 0.7);
      if (k % 3 === 0) { blendPx(t, p + 1, k, rgba(120, 110, 100), 0.5); blendPx(t, k, p + 1, rgba(120, 110, 100), 0.5); }
    }
  }
  const rng = makeRng(48133);
  for (let k = 0; k < 4; k++) crack(t, rng, rng() * W, rng() * W, rng() * 6.283, 10 + rng() * 10, 1.2, rgba(14, 8, 6), rgba(150, 60, 20), 1);
  edgeRust(t, 48144, 0.15, { top: 0.3, bot: 0.3, side: 0.3 });
  edgeDark(t, 0.2, 3);
  grain(t, 48155, 0.07);
}

/** INTAKE ceiling: suspended acoustic tiles in a T-bar grid. */
function acousticTile(t, seed) {
  const f = field(seed, 8, 3);
  const rng = makeRng(seed + 1);
  for (let i = 0; i < AREA; i++) t[i] = mul(rgba(124, 120, 108), 0.86 + f[i] * 0.18);
  for (let k = 0; k < 420; k++) {                      // the fissured pattern
    const x = rng() * W, y = rng() * W;
    if (rng() < 0.6) blendPx(t, x, y, rgba(64, 60, 52), 0.6);
    else segment(t, x, y, x + (rng() - 0.5) * 3, y + (rng() - 0.5) * 3, rgba(80, 76, 66), 0.7, 0.5);
  }
  for (const p of [0, 32]) {
    for (let k = 0; k < W; k++) {
      for (const [x, y] of [[p, k], [k, p]]) blendPx(t, x, y, rgba(158, 158, 152), 1);
      blendPx(t, p + 1, k, rgba(60, 58, 54), 0.6); blendPx(t, k, p + 1, rgba(60, 58, 54), 0.6);
      blendPx(t, (p + 63) % 64, k, rgba(60, 58, 54), 0.5); blendPx(t, k, (p + 63) % 64, rgba(60, 58, 54), 0.5);
    }
  }
}
function paintCeilOffice(t) {
  acousticTile(t, 49101);
  const y = field(49111, 4, 3);
  for (let i = 0; i < AREA; i++) t[i] = mix(t[i], rgba(150, 130, 90), clamp((y[i] - 0.6) * 2, 0, 1) * 0.35);  // nicotine
  grain(t, 49122, 0.04);
}

/** A fluorescent troffer, the one light that still works on this floor. */
function paintCeilTube(t) {
  acousticTile(t, 50101);
  for (let i = 0; i < AREA; i++) t[i] = mul(t[i], 0.62);
  rect(t, 8, 6, 48, 52, rgba(90, 92, 96), 1);           // housing
  bevel(t, 8, 6, 48, 52, rgba(200, 200, 204), BLACK, true, 2, 0.8);
  for (const tx of [21, 42]) {                         // two tubes behind the diffuser
    for (let x = -4; x <= 4; x++) {
      const k = 1 - Math.abs(x) / 4.5;
      vline(t, tx + x, 9, 54, mix(rgba(200, 220, 230), rgba(255, 255, 250), k), 1);
    }
  }
  for (let y = 9; y < 55; y += 3) hline(t, y, 11, 52, rgba(150, 170, 180), 0.35);   // prismatic lens
  for (let x = 11; x < 53; x += 3) vline(t, x, 9, 54, rgba(150, 170, 180), 0.25);
  disc(t, 21, 50, 2, rgba(40, 36, 30), 0.8, 1.2);       // a dead fly
  glow(t, 32, 32, 34, rgba(230, 245, 255), 0.35, 1.6);
  grain(t, 50111, 0.03);
}

/** SALT CATHEDRAL ceiling: raw rock hung with salt straws. */
function paintCeilSalt(t) {
  concreteBase(t, 51101, { tone: 0.6, lo: rgba(30, 32, 38), hi: rgba(80, 84, 92), cells: 4 });
  saltCrust(t, 51111, 0.28);
  for (let i = 0; i < AREA; i++) t[i] = mul(t[i], 0.72);
  const rng = makeRng(51122);
  for (let k = 0; k < 9; k++) {                        // salt straws, seen end-on
    const x = 4 + rng() * 56, y = 4 + rng() * 56, r = 0.9 + rng() * 1.4;
    disc(t, x + 1, y + 1.2, r, BLACK, 0.4, 1.2);
    disc(t, x, y, r, rgba(176, 182, 186), 1, 1);
    blendPx(t, x - r * 0.3, y - r * 0.3, rgba(230, 234, 236), 0.7);
  }
  edgeDark(t, 0.25, 4);
  grain(t, 51133, 0.06);
}

/** MUTTER ceiling: cable trays carrying the nervous system. */
function paintCeilCables(t) {
  concreteBase(t, 52101, { tone: 0.5 });
  // One ladder tray per cell, the cables mostly black: brighter and busier,
  // a room of these read as a rainbow from across the floor.
  const cols = [rgba(26, 26, 30), rgba(34, 34, 38), rgba(96, 30, 26), rgba(22, 22, 26), rgba(30, 30, 34),
    rgba(40, 60, 96), rgba(28, 28, 32), rgba(104, 90, 36), rgba(24, 24, 28)];
  const ty = 26;
  rect(t, 0, ty + 12, 64, 3, BLACK, 0.4);
  rect(t, 0, ty - 1, 64, 1, mul(C.steel, 1.1), 1);      // tray rails
  rect(t, 0, ty + 11, 64, 1, mul(C.steel, 0.75), 1);
  for (let x = 4; x < W; x += 8) rect(t, x, ty, 1, 11, mul(C.steelDk, 1.3), 1);   // rungs
  for (let c = 0; c < 9; c++) {
    const yy = ty + 1 + c * 1.1, col = cols[c];
    for (let x = 0; x < W; x++) {
      const w2 = Math.sin((x / W) * 6.283 * 2 + c) * 0.4;
      blendPx(t, x, yy + w2, col, 0.95);
      blendPx(t, x, yy + w2 - 0.5, add(col, 24), 0.2);
    }
  }
  for (let x = 12; x < W; x += 32) rect(t, x, ty, 2, 11, rgba(16, 16, 16), 0.9);  // cable ties
  for (const x of [20, 52]) {                            // hanger rods up to the slab
    vline(t, x, 0, ty - 1, mul(C.steel, 0.9), 1);
    vline(t, x + 1, 0, ty - 1, BLACK, 0.4);
  }
  drip(t, 52122, 30, 40, 50, rgba(40, 60, 40), 0.4, 1);
  edgeDark(t, 0.2, 3);
  grain(t, 52133, 0.05);
}


/** THE ORGAN LOFT ceiling: timber beams under old plaster, like the chapel it thinks it is. */
function paintCeilBeams(t) {
  const f = field(53101, 6, 4), fine = field(53111, 24, 2);
  for (let i = 0; i < AREA; i++) t[i] = mul(rgba(100, 96, 88), 0.78 + f[i] * 0.22 + fine[i] * 0.1);
  const grainF = runField(53122);
  const beam = (x0, x1, lo, hi) => {
    for (let x = x0; x <= x1; x++) {
      const u = (x - x0) / Math.max(1, x1 - x0);
      for (let y = 0; y < W; y++) {
        const c = mix(lo, hi, cyl(u * 2 - 1));
        put(t, x, y, mul(c, 0.8 + grainF[idx(y, x)] * 0.4));
      }
    }
  };
  // joists across, then the main beam on the cell line so neighbours join it
  for (const y0 of [12, 44]) {
    for (let y = y0; y < y0 + 5; y++) {
      const u = (y - y0) / 4;
      for (let x = 0; x < W; x++) put(t, x, y, mul(mix(rgba(40, 26, 16), rgba(96, 64, 38), cyl(u * 2 - 1)), 0.85 + grainF[idx(x, y)] * 0.3));
    }
    hline(t, y0 + 5, 0, 63, BLACK, 0.45); hline(t, y0 + 6, 0, 63, BLACK, 0.2);
  }
  beam(-6, 5, rgba(34, 22, 14), rgba(104, 70, 42));
  beam(58, 69, rgba(34, 22, 14), rgba(104, 70, 42));
  for (const y of [14, 46]) for (const x of [0, 63]) rivet(t, x, y + 1, 1.3, rgba(90, 80, 70));
  const rng = makeRng(53133);
  crack(t, rng, 20, 30, 0.3, 22, 1, rgba(50, 46, 40), rgba(150, 140, 120), 2);
  grain(t, 53144, 0.05);
}
function vCeilBeamsStain(t) { waterStain(t, 32, 18, 34, 26, 53201, rgba(70, 56, 36)); }
function vCeilBeamsHole(t) {
  const rng = makeRng(53301);
  const pts = [];
  for (let k = 0; k < 9; k++) { const a = k / 9 * 6.283; const r = 8 + rng() * 5; pts.push([32 + Math.cos(a) * r * 1.2, 29 + Math.sin(a) * r * 0.8]); }
  poly(t, pts, rgba(10, 8, 8), 1);
  for (let k = 0; k < 5; k++) segment(t, 18, 24 + k * 3, 46, 23 + k * 3, rgba(90, 64, 40), 1, 0.9);   // the lath behind
  segment(t, 30, 30, 34, 44, rgba(40, 40, 44), 1.2, 1);    // and a cable dangling through
}

/** THE ORGAN LOFT floor: boards, worn pale down the middle by a century of pacing. */
function paintFloorBoards(t) {
  const grainF = brushField(54101), blot = field(54111, 4, 3);
  const tones = [rgba(92, 68, 48), rgba(80, 60, 42), rgba(100, 74, 52), rgba(74, 56, 40)];
  for (let y = 0; y < W; y++) {
    const plank = y >> 3, ly = y & 7;
    const joint = (plank * 23) & 63;                   // staggered butt joints
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      let c = mul(tones[plank & 3], 0.8 + grainF[i] * 0.4);
      c = mix(c, mul(c, 0.7), clamp((blot[i] - 0.5) * 2, 0, 1) * 0.4);
      if (ly === 7) c = mul(c, 0.35);                    // the gap
      else if (ly === 0) c = mul(c, 1.12);
      if (x === joint || x === ((joint + 32) & 63)) c = mul(c, 0.4);
      t[i] = c;
    }
  }
  for (let plank = 0; plank < 8; plank++) {             // nails either side of each joint
    const joint = (plank * 23) & 63;
    for (const x of [joint + 2, joint - 2, joint + 34, joint + 30]) {
      blendPx(t, x, plank * 8 + 2, rgba(40, 36, 34), 0.9); blendPx(t, x, plank * 8 + 5, rgba(40, 36, 34), 0.9);
    }
  }
  speckle(t, 54122, 60, rgba(40, 28, 18), 0.2, 0.5, 0.7);
  edgeDark(t, 0.15, 3);
  grain(t, 54133, 0.05);
}
function vBoardsHole(t) {
  const rng = makeRng(54201);
  const pts = [];
  for (let k = 0; k < 10; k++) { const a = k / 10 * 6.283; const r = 9 + rng() * 5; pts.push([32 + Math.cos(a) * r * 1.3, 32 + Math.sin(a) * r * 0.9]); }
  poly(t, pts, rgba(8, 6, 6), 1);
  for (let k = 0; k < 6; k++) {                          // splintered ends
    const a = rng() * 6.283;
    segment(t, 32 + Math.cos(a) * 12, 32 + Math.sin(a) * 9, 32 + Math.cos(a) * 17, 32 + Math.sin(a) * 12, rgba(150, 110, 70), 1.2, 0.9);
  }
  hline(t, 32, 20, 44, rgba(60, 50, 44), 0.8);           // a joist below
}
function vBoardsBlood(t) {
  const f = field(54301, 5, 3);
  for (let y = 8; y < 56; y++) for (let x = 8; x < 56; x++) {
    const d = Math.hypot(x - 30, y - 34) / 20 + (f[idx(x, y)] - 0.5) * 0.6;
    if (d < 1) blendPx(t, x, y, C.bloodDk, (1 - d) * 0.8);
  }
}

/** The underside of a silo roof: two steel leaves, a seal, and the reason to stand clear. */
function paintCeilRoof(t, alt = 0) {
  steelBase(t, 55101 + alt, { col: rgba(78, 82, 90) });
  for (let i = 0; i < AREA; i++) t[i] = mul(t[i], 0.75);
  for (const p of [0, 63]) { vline(t, p, 0, 63, BLACK, 0.8); hline(t, p, 0, 63, BLACK, 0.8); }
  for (let y = 0; y < W; y++) {                        // chevrons along the meeting seam
    const s2 = ((y + (alt ? 8 : 0)) % 16);
    for (let x = 28; x < 36; x++) blendPx(t, x, y, s2 < 8 ? C.yellow : C.black, 0.85);
  }
  vline(t, 31, 0, 63, BLACK, 0.9); vline(t, 32, 0, 63, rgba(20, 20, 20), 0.9);   // rubber seal
  for (const x of [6, 22, 42, 58]) for (const y of [6, 22, 42, 58]) rivet(t, x, y, 1.6, C.steel);
  const snap = t.slice();
  if (alt) drawTextCentered(t, 'STAND', 16, 30, 1, mul(C.yellow, 0.8), { alpha: 0.8 });
  else drawTextCentered(t, 'CLEAR', 48, 30, 1, mul(C.yellow, 0.8), { alpha: 0.8 });
  chipBack(t, snap, 55122 + alt, 10, 0.6, 0.8, 3);
  edgeRust(t, 55133 + alt, 0.5, { top: 0.3, bot: 0.3, side: 0.3 });
  grain(t, 55144, 0.05);
}
function vCeilRoofB(t) { paintCeilRoof(t, 1); }

// ---------------------------------------------------------------------------
// wall dressings. Each paints over a copy of its base; keep everything inside
// x 2..61 so a dressed cell still meets a plain neighbour cleanly.
// ---------------------------------------------------------------------------

const RED = rgba(196, 36, 30), PAPER = rgba(214, 208, 188);

/** Pin-up calendar, June 1986, every day crossed off by someone lonely. */
function calendar(t, x, y, seed) {
  const rng = makeRng(seed);
  const under = t.slice();
  paper(t, x, y, 30, 40, PAPER, seed, { torn: true, under });
  for (let j = 0; j < 19; j++) {                       // sunset behind her
    const c = mix(rgba(255, 120, 150), rgba(255, 190, 90), j / 18);
    hline(t, y + 2 + j, x + 2, x + 27, c, 1);
  }
  disc(t, x + 22, y + 12, 3.4, rgba(255, 236, 150), 0.9, 1);   // the sun
  hline(t, y + 17, x + 2, x + 27, rgba(90, 60, 110), 0.7);
  pinupGirl(t, x + 5, y + 3, 17, rgba(40, 18, 40));
  microC(t, 'MISS', x + 15, y + 22, RED);
  microC(t, 'MEGATON', x + 15, y + 28, RED);
  for (let r = 0; r < 3; r++) {                        // the month, crossed off
    for (let c = 0; c < 7; c++) {
      const cx = x + 3 + c * 3.5, cy = y + 34 + r * 1.6;
      blendPx(t, cx, cy, rgba(80, 76, 70), 0.8);
      if (rng() < 0.85) blendPx(t, cx + 1, cy, RED, 0.8);
    }
  }
}

/** "HANG IN THERE" with the cat. The most 1990s object that exists. */
function hangInThere(t, x, y, seed) {
  paper(t, x, y, 30, 42, rgba(120, 170, 210), seed);
  for (let j = 1; j < 41; j++) hline(t, y + j, x + 1, x + 28, mix(rgba(150, 200, 236), rgba(60, 100, 170), j / 41), 0.9);
  segment(t, x + 2, y + 8, x + 28, y + 6, rgba(70, 44, 24), 2, 1);         // the branch
  segment(t, x + 9, y + 7, x + 7, y + 3, rgba(70, 44, 24), 1, 1);
  const cx = x + 16, fur = rgba(236, 150, 60), furDk = rgba(180, 100, 40);
  segment(t, cx - 2, y + 7, cx - 2, y + 14, fur, 1.4, 1);                  // paws on the branch
  segment(t, cx + 2, y + 7, cx + 2, y + 14, fur, 1.4, 1);
  disc(t, cx, y + 17, 3.6, fur, 1, 0.9);                                  // head
  poly(t, [[cx - 4, y + 16], [cx - 3.5, y + 12], [cx - 1.5, y + 15]], fur, 1);
  poly(t, [[cx + 4, y + 16], [cx + 3.5, y + 12], [cx + 1.5, y + 15]], fur, 1);
  blendPx(t, cx - 1.4, y + 16.5, BLACK, 1); blendPx(t, cx + 1.4, y + 16.5, BLACK, 1);
  blendPx(t, cx, y + 18.5, rgba(200, 80, 80), 1);
  disc(t, cx, y + 24, 3.2, fur, 1, 0.9);                                  // body, dangling
  for (let k = 0; k < 3; k++) hline(t, y + 22 + k * 2, cx - 2, cx + 2, furDk, 0.7);
  segment(t, cx - 1.5, y + 26, cx - 2, y + 29, fur, 1.2, 1);              // legs kicking
  segment(t, cx + 1.5, y + 26, cx + 2.5, y + 29, fur, 1.2, 1);
  segment(t, cx + 3, y + 25, cx + 7, y + 22, fur, 1, 1);                  // tail
  microC(t, 'HANG IN', x + 15, y + 31, WHITE);
  microC(t, 'THERE', x + 15, y + 37, WHITE);
}

function vConcreteStain(t) {
  // Same seed twice: a pale salt halo first, the wet dark body inside it.
  waterStain(t, 24, 0, 38, 56, 60101, rgba(150, 148, 132));
  waterStain(t, 24, 0, 30, 48, 60101, rgba(20, 18, 14));
  waterStain(t, 51, 0, 14, 30, 60102, rgba(46, 30, 16));
  const rng = makeRng(60103);
  for (let k = 0; k < 6; k++) drip(t, 60110 + k, 12 + rng() * 26, 16 + rng() * 10, 48 + rng() * 14, rgba(20, 26, 18), 0.65, 1.4);
  dampBloom(t, 60104, 0.9, C.moss);
}
function vConcretePoster(t) {
  calendar(t, 17, 7, 60201);
  const rng = makeRng(60202);
  scrawl(t, 'CALL ME', 18, 52, rgba(30, 30, 90), rng, 0.8);
}
function vConcreteGraffiti(t) {
  const rng = makeRng(60301);
  spray(t, 'BRICK', 4, 10, 2, rgba(200, 30, 26), rng, { jit: 1.2 });
  spray(t, 'WAS HERE', 9, 30, 1, rgba(200, 30, 26), rng, { runs: 2 });
  tally(t, 12, 44, 13, rgba(230, 226, 210), 7);
  kilroy(t, 44, 44, rgba(30, 30, 30), 0.85);
}
function vConcreteSign(t) {
  placard(t, 9, 5, 46, 43, rgba(226, 222, 210), BLACK, [], { border: RED, seed: 60401 });
  disc(t, 32, 14, 7, RED, 1, 1);                       // no-smoking roundel
  disc(t, 32, 14, 5.2, rgba(226, 222, 210), 1, 1);
  rect(t, 26, 13, 10, 3, WHITE, 1); rect(t, 36, 13, 2, 3, rgba(220, 120, 40), 1);
  segment(t, 27, 9, 37, 19, RED, 1.8, 1);
  microC(t, 'NO SMOKING', 32, 23, BLACK);
  microC(t, 'NEAR THE', 32, 29, BLACK);
  drawTextCentered(t, 'NUKES', 32, 36, 1, RED);
  glow(t, 20, 54, 7, BLACK, 0.55, 1.4);                // somebody stubbed one out anyway
  disc(t, 20, 54, 1.2, rgba(40, 36, 30), 0.9, 1);
}
function vConcreteFuse(t) {
  const rng = makeRng(60501);
  fuseBox(t, 10, 20, 22, 26, rng);
  micro(t, 'DANGER', 36, 24, RED, 0.9);
  micro(t, 'LIVE', 36, 30, RED, 0.9);
  micro(t, 'NO PEE', 36, 40, rgba(30, 30, 30), 0.7);
}
function vConcreteHoles(t) {
  const rng = makeRng(60601);
  for (let k = 0; k < 9; k++) bulletHole(t, 14 + rng() * 34, 12 + rng() * 24, 1.4 + rng() * 0.9, rng, add(C.conc, 20));
  handprint(t, 44, 36, 1, C.blood, rng, 14);
}
function vCrackedBlood(t) {
  const rng = makeRng(60701);
  handprint(t, 24, 22, 1.15, C.blood, rng, 22);
  handprint(t, 38, 30, 1, C.bloodDk, rng, 14);
  for (let k = 0; k < 30; k++) disc(t, 10 + rng() * 44, 8 + rng() * 30, 0.4 + rng() * 1.2, C.blood, 0.8, 0.8);
}
function vCrackedRebar(t) {
  const rng = makeRng(60801);
  const pts = [];
  for (let k = 0; k < 12; k++) {
    const a = k / 12 * 6.283, r = 12 + rng() * 6;
    pts.push([32 + Math.cos(a) * r * 1.2, 30 + Math.sin(a) * r]);
  }
  poly(t, pts.map(([x, y]) => [x + 1.5, y + 1.5]), add(C.conc, 40), 0.5);
  poly(t, pts, rgba(34, 34, 38), 1);                   // the crater
  const inner = pts.map(([x, y]) => [32 + (x - 32) * 0.7, 30 + (y - 30) * 0.7]);
  poly(t, inner, rgba(14, 14, 16), 1);
  for (const y of [22, 34]) {                          // rebar across the hole
    segment(t, 14, y + 1, 50, y + 1 + (rng() - 0.5) * 3, BLACK, 2, 0.5);
    segment(t, 14, y, 50, y + (rng() - 0.5) * 3, C.rust, 1.8, 1);
    for (let x = 16; x < 50; x += 3) blendPx(t, x, y - 1, C.rustLt, 0.8);
  }
  segment(t, 26, 16, 30, 46, C.rustDk, 1.6, 1);
  rubble(t, 32, 56, 6, 10, rng, C.conc);
}
function vCrackedGraffiti(t) {
  const rng = makeRng(60901);
  spray(t, 'MUTTER', 14, 8, 1, rgba(60, 200, 80), rng);
  spray(t, 'SUCKS', 16, 18, 1, rgba(60, 200, 80), rng);
  spray(t, 'EAT SH*T', 8, 38, 1, rgba(230, 230, 220), rng, { runs: 1 });
  segment(t, 52, 14, 52, 30, rgba(60, 200, 80), 1.4, 0.9);    // helpful arrow at the core
  segment(t, 52, 30, 48, 26, rgba(60, 200, 80), 1.4, 0.9);
  segment(t, 52, 30, 56, 26, rgba(60, 200, 80), 1.4, 0.9);
}

// --- OFFICE_WALL ------------------------------------------------------------
function vOfficeEmployee(t) {
  castShadow(t, 8, 4, 48, 46, 0.5, 2);
  rect(t, 8, 4, 48, 46, rgba(92, 58, 30), 1);          // walnut plaque
  bevel(t, 8, 4, 48, 46, rgba(160, 110, 60), rgba(40, 22, 10), true, 2, 0.8);
  microC(t, 'EMPLOYEE OF', 32, 7, rgba(236, 200, 110));
  microC(t, 'THE MONTH', 32, 13, rgba(236, 200, 110));
  rect(t, 23, 19, 18, 19, rgba(90, 110, 140), 1);       // the photo
  disc(t, 32, 31, 6.4, rgba(210, 150, 110), 1, 1);      // square jaw
  rect(t, 26, 27, 12, 8, rgba(210, 150, 110), 1);
  rect(t, 26, 21, 12, 5, rgba(60, 40, 24), 1);          // flat-top
  rect(t, 25, 28, 14, 3, rgba(10, 10, 14), 1);          // aviators
  blendPx(t, 27, 28, WHITE, 0.8); blendPx(t, 35, 28, WHITE, 0.8);
  hline(t, 34, 29, 35, rgba(120, 50, 40), 1);           // smirk
  blendPx(t, 35, 33, rgba(120, 50, 40), 1);
  rect(t, 24, 36, 16, 2, rgba(60, 70, 60), 1);
  rect(t, 15, 40, 34, 8, rgba(200, 170, 80), 1);        // brass name plate
  bevel(t, 15, 40, 34, 8, rgba(250, 230, 150), rgba(110, 80, 30), true, 1, 0.7);
  microC(t, 'HARDIGAN', 32, 41.5, rgba(40, 26, 10));
  const rng = makeRng(61001);
  scrawl(t, 'STILL', 38, 54, rgba(30, 30, 90), rng, 0.7);
}
function vOfficeBoard(t) {
  const rng = makeRng(61101);
  castShadow(t, 8, 8, 48, 32, 0.5, 2);
  rect(t, 8, 8, 48, 32, rgba(90, 56, 30), 1);
  bevel(t, 8, 8, 48, 32, rgba(150, 100, 60), BLACK, true, 2, 0.8);
  const cork = field(61102, 16, 2);
  for (let j = 11; j < 37; j++) for (let i = 11; i < 53; i++) put(t, i, j, mul(rgba(170, 128, 80), 0.8 + cork[idx(i, j)] * 0.35));
  const note = (x, y, w, h, col, words) => {
    rect(t, x + 1, y + 1, w, h, BLACK, 0.3);
    rect(t, x, y, w, h, col, 1);
    let ly = y + 2;
    for (const wd of words) { micro(t, wd, x + 1, ly, rgba(30, 30, 40), 0.9); ly += 6; }
    disc(t, x + w / 2, y + 1, 0.9, [RED, rgba(40, 120, 220), rgba(40, 170, 60)][(rng() * 3) | 0], 1, 0.6);
  };
  note(12, 12, 17, 13, rgba(240, 236, 220), ['LOST', 'CAT']);
  note(31, 11, 20, 13, rgba(250, 230, 90), ['BAKE', 'SALE']);
  note(14, 26, 22, 9, rgba(240, 236, 220), ['PARTY']);
  note(38, 24, 14, 13, rgba(160, 220, 240), ['WHO', 'ATE']);
  scrawl(t, 'MY LUNCH?', 18, 44, rgba(30, 30, 80), rng, 0.75);
}
function vOfficeClock(t) {
  wallClock(t, 32, 10, 7.5, 3, 47);
  placard(t, 9, 21, 46, 30, rgba(236, 232, 218), BLACK, [
    { text: 'DAYS SINCE' }, { text: 'LAST OOPS' },
  ], { border: rgba(40, 110, 50), seed: 61201, pad: 4 });
  rect(t, 26, 36, 12, 11, rgba(30, 30, 30), 1);
  drawTextCentered(t, '0', 32, 38, 1, RED);
  const rng = makeRng(61202);
  scrawl(t, 'LOL', 44, 54, rgba(160, 30, 30), rng, 0.8);
}
function vOfficeSafety(t) {
  const under = t.slice();
  paper(t, 12, 5, 40, 48, rgba(234, 230, 216), 61301, { torn: true, under });
  drawTextCentered(t, 'SAFETY', 32, 8, 1, RED);
  microC(t, 'FIRST!', 32, 17, BLACK);
  // a mushroom cloud with a big dumb smile
  const cy = 32;
  rect(t, 29, cy + 2, 6, 11, rgba(150, 140, 130), 1);
  disc(t, 32, cy, 8, rgba(240, 150, 60), 1, 1);
  disc(t, 27, cy - 1, 4, rgba(250, 190, 80), 1, 1); disc(t, 37, cy - 1, 4, rgba(250, 190, 80), 1, 1);
  disc(t, 32, cy - 4, 4.5, rgba(255, 210, 110), 1, 1);
  disc(t, 29.5, cy - 1, 0.9, BLACK, 1, 0.5); disc(t, 34.5, cy - 1, 0.9, BLACK, 1, 0.5);
  for (let k = -3; k <= 3; k++) blendPx(t, 32 + k, cy + 3 - (k * k) * 0.12, BLACK, 1);
  rect(t, 24, cy + 12, 16, 2, rgba(120, 110, 100), 1);
  microC(t, 'NUKES 2ND', 32, 47, RED);
}
function vOfficeExting(t) {
  placard(t, 22, 4, 20, 11, RED, WHITE, [{ text: 'FIRE' }], { seed: 61401, pad: 3 });
  segment(t, 32, 17, 32, 21, RED, 1.6, 1);
  segment(t, 32, 22, 29, 19, RED, 1.2, 1); segment(t, 32, 22, 35, 19, RED, 1.2, 1);
  rect(t, 27, 25, 12, 3, mul(C.steel, 1.1), 1);         // wall bracket
  castShadow(t, 28, 26, 9, 26, 0.5, 2);
  for (let y = 27; y < 52; y++) {                       // the cylinder
    for (let x = 28; x < 37; x++) {
      const u = (x - 32) / 4.5;
      let c = mix(rgba(90, 10, 10), rgba(236, 70, 56), cyl(u));
      if (y > 49) c = mul(c, 0.7);
      put(t, x, y, c);
    }
  }
  disc(t, 32, 27, 3.5, rgba(160, 20, 16), 1, 1);
  rect(t, 30, 21, 5, 5, rgba(40, 40, 40), 1);           // valve head
  segment(t, 34, 22, 40, 22, rgba(50, 50, 50), 1.4, 1);
  segment(t, 30, 24, 25, 30, rgba(20, 20, 20), 1.6, 1); // hose
  segment(t, 25, 30, 26, 44, rgba(20, 20, 20), 1.6, 1);
  rect(t, 29, 33, 7, 8, rgba(226, 222, 210), 1);        // instruction label
  for (let k = 0; k < 3; k++) hline(t, 35 + k * 2, 30, 34, rgba(60, 60, 60), 0.8);
  glow(t, 30, 30, 4, WHITE, 0.35, 2);
}
function vOfficeCat(t) { hangInThere(t, 17, 6, 61501); }
function vOfficePinup(t) { calendar(t, 17, 6, 61601); }
function vOfficeBlood(t) {
  const rng = makeRng(61701);
  for (let k = 0; k < 6; k++) bulletHole(t, 22 + rng() * 24, 12 + rng() * 16, 1.3 + rng() * 0.7, rng, rgba(170, 160, 130));
  handprint(t, 20, 28, 1, C.blood, rng, 18);
  handprint(t, 30, 34, 1, C.bloodDk, rng, 10);
  smear(t, 24, 38, 54, 50, 3.5, rng);
  for (let k = 0; k < 24; k++) disc(t, 28 + rng() * 26, 10 + rng() * 22, 0.4 + rng(), C.blood, 0.85, 0.8);
}

// --- steel ------------------------------------------------------------------
function vSteelSign(t) {
  placard(t, 10, 8, 44, 32, C.yellow, BLACK, [
    { text: 'AUTHORIZED' }, { text: 'PERSONNEL' }, { text: 'ONLY', big: true },
  ], { border: BLACK, seed: 62101, pad: 6 });
  const rng = makeRng(62102);
  scrawl(t, 'THAT MEANS U', 9, 46, rgba(230, 230, 230), rng, 0.8);
}
function vSteelDents(t) {
  const rng = makeRng(62201);
  glow(t, 32, 28, 20, rgba(20, 16, 14), 0.3, 1.3);       // powder burn
  for (let k = 0; k < 14; k++) {
    const x = 12 + rng() * 40, y = 12 + rng() * 30, r = 1.1 + rng() * 1.1;
    disc(t, x, y, r + 1.4, C.specHot, 0.35, 1.2);         // bright scuffed ring
    disc(t, x + 0.4, y + 0.5, r, mul(C.steelDk, 0.8), 0.9, 0.8);
    disc(t, x - r * 0.35, y - r * 0.35, r * 0.45, C.spec, 0.55, 0.7);
  }
}
function vSteelPanel(t) {
  castShadow(t, 7, 12, 50, 32, 0.55, 2);
  rect(t, 7, 12, 50, 32, rgba(70, 76, 70), 1);
  bevel(t, 7, 12, 50, 32, rgba(140, 150, 140), BLACK, true, 1, 0.9);
  for (let k = 0; k < 6; k++) {                        // toggles
    rect(t, 11 + k * 5, 16, 3, 5, rgba(30, 30, 30), 1);
    segment(t, 12.5 + k * 5, 18, 12.5 + k * 5 + (k % 2 ? 1 : -1), 15, rgba(210, 210, 210), 1, 1);
  }
  for (let k = 0; k < 5; k++) disc(t, 13 + k * 5, 25, 1.2, [C.green, C.amber, RED, C.green, C.amber][k], 1, 0.8);
  disc(t, 46, 22, 6, rgba(40, 20, 20), 1, 1);           // THE button
  disc(t, 46, 21.4, 4.8, rgba(220, 40, 30), 1, 1);
  disc(t, 44.8, 20, 1.6, rgba(255, 150, 130), 0.8, 1);
  rect(t, 8, 32, 48, 9, rgba(236, 230, 200), 1);
  microC(t, 'DO NOT PRESS', 32, 34, RED);
  const rng = makeRng(62301);
  scrawl(t, 'SERIOUSLY', 14, 50, rgba(230, 230, 230), rng, 0.7);
}
function vSteelCables(t) {
  const rng = makeRng(62401);
  cables(t, 8, rng, 4, true);
  castShadow(t, 40, 30, 12, 12, 0.5, 1.5);
  rect(t, 40, 30, 12, 12, rgba(70, 72, 78), 1);         // junction box
  bevel(t, 40, 30, 12, 12, C.spec, BLACK, true, 1, 0.8);
  micro(t, '4', 44, 34, C.yellow, 0.9);
}
function vRivetHatch(t) {
  castShadow(t, 14, 12, 36, 38, 0.55, 2);
  rect(t, 14, 12, 36, 38, mul(C.steel, 0.9), 1);
  bevel(t, 14, 12, 36, 38, C.specHot, BLACK, true, 2, 0.85);
  rect(t, 18, 16, 28, 30, mul(C.steelDk, 1.2), 1);
  bevel(t, 18, 16, 28, 30, BLACK, C.spec, false, 1, 0.7);
  for (const y of [18, 42]) { rect(t, 11, y, 5, 4, mul(C.steel, 0.7), 1); rivet(t, 13, y + 2, 1.2, C.steel); }
  rect(t, 44, 28, 3, 8, rgba(30, 30, 30), 1);            // dog lever
  segment(t, 45, 32, 51, 36, mul(C.steel, 1.2), 2, 1);
  drawTextCentered(t, 'MAINT', 32, 26, 1, mul(C.yellow, 0.9), { shadow: true });
  for (const [x, y] of [[16, 14], [47, 14], [16, 47], [47, 47]]) rivet(t, x, y, 1.3, C.steel);
}
function gauge(t, cx, cy, r, ang, label) {
  castShadow(t, cx - r, cy - r, r * 2, r * 2, 0.4, 1.4);
  disc(t, cx, cy, r + 1, rgba(150, 120, 60), 1, 1);
  disc(t, cx, cy, r, rgba(226, 222, 204), 1, 1);
  for (let a = -2.4; a <= 0.3; a += 0.08) blendPx(t, cx + Math.cos(a) * (r - 1.5), cy + Math.sin(a) * (r - 1.5), BLACK, 0.8);
  for (let a = 0.3; a <= 0.8; a += 0.06) blendPx(t, cx + Math.cos(a) * (r - 1.5), cy + Math.sin(a) * (r - 1.5), RED, 1);
  segment(t, cx, cy, cx + Math.cos(ang) * (r - 1), cy + Math.sin(ang) * (r - 1), RED, 0.9, 1);
  disc(t, cx, cy, 1, BLACK, 1, 0.6);
  glow(t, cx - r * 0.4, cy - r * 0.4, r * 0.6, WHITE, 0.35, 2);
  if (label) microC(t, label, cx, cy + r + 3, BLACK, 0.8);
}
function vRivetGauges(t) {
  rect(t, 6, 38, 52, 4, BLACK, 0.4);
  for (let x = 4; x < 60; x++) {                       // the manifold
    for (let dy = -3; dy <= 3; dy++) put(t, x, 36 + dy, mix(mul(C.steel, 0.45), mul(C.steel, 1.25), cyl(dy / 3)));
  }
  for (const x of [16, 32, 48]) rect(t, x - 1, 24, 3, 10, mul(C.steel, 1.1), 1);
  gauge(t, 16, 20, 5.5, -1.4);
  gauge(t, 32, 20, 5.5, -0.6);
  gauge(t, 48, 20, 5.5, 1.1);                          // pinned in the red
  placard(t, 5, 45, 54, 9, rgba(236, 232, 218), RED, [{ text: 'DO NOT EXCEED' }], { seed: 62501, pad: 2 });
}
function vRivetStencil(t) {
  const snap = t.slice();
  drawTextCentered(t, 'DECK', 32, 10, 2, mul(C.yellow, 0.95), { shadow: true, shadowAlpha: 0.4 });
  drawTextCentered(t, 'C', 32, 27, 3, mul(C.yellow, 0.95), { shadow: true, shadowAlpha: 0.4 });
  chipBack(t, snap, 62601, 12, 0.6, 0.8, 3);
  microC(t, 'LEVEL -3', 32, 52, mul(C.yellow, 0.8), 0.8);
}
function vHazardSign(t) {
  placard(t, 4, 12, 56, 36, rgba(236, 232, 218), BLACK, [], { border: BLACK, seed: 62701 });
  poly(t, [[32, 16], [42, 32], [22, 32]], C.yellow, 1);
  poly(t, [[33, 20], [29.5, 26], [32, 26], [30.5, 30.5], [35, 24], [32.5, 24]], BLACK, 1);
  microC(t, 'HIGH VOLTAGE', 32, 35, BLACK);
  microC(t, 'LOW STANDARDS', 32, 41, RED);
}
function vHazardWorn(t) {
  const rng = makeRng(62801);
  for (let k = 0; k < 16; k++) {                       // forklift gouges
    const x = 4 + rng() * 50, y = 30 + rng() * 26, l = 6 + rng() * 14;
    segment(t, x, y + 0.8, x + l, y + (rng() - 0.5) * 2 + 0.8, BLACK, 1.4, 0.4);
    segment(t, x, y, x + l, y + (rng() - 0.5) * 2, C.spec, 1, 0.5);
  }
  edgeRust(t, 62802, 0.9, { top: 0.2, bot: 1, side: 0.1 });
  spray(t, 'OOPS', 18, 12, 1, rgba(240, 240, 240), rng, { runs: 2 });
}

// --- pipes and vents ----------------------------------------------------------
function valveWheel(t, cx, cy, r, col) {
  disc(t, cx + 1, cy + 1.2, r + 1, BLACK, 0.4, 1.2);
  for (let a = 0; a < 6.283; a += 0.03) {
    for (let w = -1; w <= 1; w++) blendPx(t, cx + Math.cos(a) * (r + w * 0.6), cy + Math.sin(a) * (r + w * 0.6), w < 0 ? add(col, 50) : col, 1);
  }
  for (let k = 0; k < 5; k++) {
    const a = k * 1.2566 + 0.3;
    segment(t, cx, cy, cx + Math.cos(a) * r, cy + Math.sin(a) * r, col, 1.4, 1);
  }
  disc(t, cx, cy, 2.2, mul(col, 0.7), 1, 1);
  rivet(t, cx, cy, 1.2, C.spec);
}
function vPipesValve(t) {
  paintPipes(t, {
    valveCol: rgba(40, 70, 150), valveHi: rgba(90, 140, 230),
    extra(u) {
      segment(u, 38, 38, 42, 46, rgba(200, 200, 200), 0.6, 1);   // the tag on a string
      rect(u, 38, 46, 14, 12, rgba(226, 190, 90), 1);
      bevel(u, 38, 46, 14, 12, rgba(250, 230, 150), rgba(120, 90, 30), true, 1, 0.7);
      micro(u, 'DO', 42, 47, BLACK); micro(u, 'NOT', 40, 53, BLACK, 0.9);
    },
  });
}
function vPipesLeak(t) {
  const rng = makeRng(63101);
  for (let k = 0; k < 40; k++) {                       // the steam, from a split joint
    const u = rng();
    glow(t, 30 + u * 22 + (rng() - 0.5) * 6 * u, 20 - u * 14 + (rng() - 0.5) * 8 * u, 2 + u * 7, rgba(230, 232, 236), 0.2, 1.4);
  }
  disc(t, 30, 20, 2, BLACK, 0.8, 1);
  for (let k = 0; k < 6; k++) drip(t, 63110 + k, 26 + rng() * 10, 22, 50 + rng() * 12, rgba(70, 90, 100), 0.5, 1.2);
  puddle(t, 32, 60, 14, 2.5, 63102);
}
function vPipesBare(t) { paintPipes(t, { valve: false }); }
function vPipesGauge(t) {
  paintPipes(t, {
    valve: false,
    extra(u) {
      rect(u, 30, 26, 4, 10, mul(C.steel, 1.1), 1);
      gauge(u, 32, 20, 8, 0.55, null);
      placard(u, 5, 40, 54, 9, rgba(236, 232, 218), RED, [{ text: 'DO NOT EXCEED' }], { seed: 63201, pad: 2 });
      const rng = makeRng(63202);
      scrawl(u, 'OOPS', 38, 54, rgba(30, 30, 30), rng, 0.8);
    },
  });
}
function vVentBlood(t) {
  const rng = makeRng(63301);
  for (let k = 0; k < 7; k++) drip(t, 63310 + k, 12 + rng() * 40, 30 + rng() * 10, 60, C.blood, 0.75, 1.6);
  smear(t, 20, 58, 44, 46, 4, rng);
  for (let k = 0; k < 3; k++) {                        // bent slats
    segment(t, 24 + k * 6, 24, 30 + k * 5, 34, rgba(8, 8, 10), 2.5, 1);
  }
  handprint(t, 44, 28, 0.9, C.blood, rng, 10);
}
function vVentEyes(t) {
  for (const [x, y] of [[24, 30], [36, 30], [46, 20], [52, 20]]) {
    glow(t, x, y, 5, rgba(255, 200, 40), 0.55, 2);
    disc(t, x, y, 1.4, rgba(255, 240, 150), 1, 0.7);
    blendPx(t, x, y, BLACK, 0.8);
  }
}
function vVentFan(t) {
  disc(t, 32, 32, 24, rgba(20, 20, 24), 1, 1);
  disc(t, 32, 32, 25, mul(C.steel, 0.8), 0.9, 0.6);
  for (let k = 0; k < 5; k++) {
    const a = k * 1.2566;
    poly(t, [[32, 32], [32 + Math.cos(a) * 22, 32 + Math.sin(a) * 22], [32 + Math.cos(a + 0.55) * 22, 32 + Math.sin(a + 0.55) * 22]],
      mix(mul(C.steel, 0.7), C.spec, 0.4 + (k % 2) * 0.2), 1);
  }
  disc(t, 32, 32, 4, mul(C.steel, 0.6), 1, 1);
  rivet(t, 32, 32, 2, C.spec);
  for (let a = 0; a < 6.283; a += 0.35) segment(t, 32, 32, 32 + Math.cos(a) * 24, 32 + Math.sin(a) * 24, mul(C.steelDk, 1.4), 0.6, 0.5);
  for (const r of [8, 16, 24]) for (let a = 0; a < 6.283; a += 0.02) blendPx(t, 32 + Math.cos(a) * r, 32 + Math.sin(a) * r, mul(C.steelDk, 1.4), 0.6);
}

// --- tile -------------------------------------------------------------------
function vTileMirror(t) {
  castShadow(t, 16, 6, 32, 28, 0.5, 2);
  rect(t, 16, 6, 32, 28, rgba(170, 176, 180), 1);
  for (let j = 0; j < 24; j++) hline(t, 8 + j, 18, 45, mix(rgba(90, 104, 112), rgba(40, 46, 54), j / 24), 1);
  for (let k = 0; k < 3; k++) segment(t, 20 + k * 8, 30, 30 + k * 8, 10, rgba(160, 180, 190), 1, 0.3);
  const rng = makeRng(63501);
  crack(t, rng, 38, 14, 2.2, 14, 0.9, rgba(210, 220, 225), rgba(210, 220, 225), 2);   // someone headbutted it
  castShadow(t, 18, 38, 28, 7, 0.5, 2);
  rect(t, 18, 38, 28, 7, rgba(226, 226, 220), 1);       // the basin
  bevel(t, 18, 38, 28, 7, WHITE, rgba(120, 120, 116), true, 1, 0.8);
  rect(t, 30, 34, 4, 4, mul(C.steel, 1.2), 1);           // tap
  blendPx(t, 31, 34, C.specHot, 1);
  segment(t, 30, 46, 30, 58, mul(C.steel, 0.8), 2, 1);  // trap
  drip(t, 63502, 33, 38, 48, rgba(140, 150, 90), 0.5, 1);
}
function vTileGraffiti(t) {
  const rng = makeRng(63601);
  scrawl(t, 'FOR A GOOD', 10, 8, rgba(30, 30, 110), rng);
  scrawl(t, 'TIME CALL', 12, 14, rgba(30, 30, 110), rng);
  scrawl(t, '555-NUKE', 14, 20, rgba(30, 30, 110), rng);
  for (let a = 0; a < 6.283; a += 0.05) {              // B + I in a heart
    const x = 16 * Math.pow(Math.sin(a), 3), y = -(13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a));
    blendPx(t, 40 + x * 0.55, 38 + y * 0.55, RED, 0.9);
  }
  micro(t, 'B+I', 34, 36, RED, 0.9);
  scrawl(t, 'MUTTER', 6, 44, rgba(20, 20, 20), rng, 0.8);
  scrawl(t, 'READS THIS', 4, 50, rgba(20, 20, 20), rng, 0.8);
}
function vTileMissing(t) {
  const rng = makeRng(63701);
  for (const [x, y] of [[16, 16], [32, 16], [16, 32], [48, 40]]) {
    if (rng() < 0.2) continue;
    rect(t, x + 1, y + 1, 14, 14, rgba(84, 80, 70), 1);
    for (let k = 0; k < 40; k++) blendPx(t, x + 2 + rng() * 12, y + 2 + rng() * 12, rgba(60, 56, 50), 0.8);
    for (let k = 0; k < 6; k++) segment(t, x + 2 + rng() * 11, y + 2 + rng() * 11, x + 2 + rng() * 11, y + 2 + rng() * 11, rgba(120, 116, 100), 1, 0.6);  // adhesive combing
    bevel(t, x + 1, y + 1, 14, 14, BLACK, rgba(200, 200, 190), false, 1, 0.8);
  }
  rubble(t, 28, 60, 5, 8, rng, rgba(200, 200, 190));
}
function vTileHand(t) {
  const rng = makeRng(63801);
  handprint(t, 28, 20, 1.2, C.blood, rng, 26);
  handprint(t, 40, 28, 1.1, C.bloodDk, rng, 20);
  smear(t, 30, 24, 36, 60, 4, rng);
}
function vTileSign(t) {
  placard(t, 12, 8, 40, 23, rgba(236, 232, 218), BLACK, [
    { text: 'EMPLOYEES' }, { text: 'MUST WASH' }, { text: 'HANDS' },
  ], { border: rgba(40, 80, 160), seed: 63901, pad: 4 });
  const rng = makeRng(63902);
  scrawl(t, 'AND FEET', 17, 36, rgba(30, 30, 110), rng);
  scrawl(t, 'AND SOUL', 19, 43, rgba(160, 30, 30), rng);
}
function vTileBlood2(t) {
  const rng = makeRng(64001);
  spray(t, 'HELP', 8, 18, 2, C.bloodWet, rng, { jit: 1.8, runs: 5 });
  smear(t, 14, 50, 50, 44, 4, rng);
}

// --- rust -------------------------------------------------------------------
function vRustHole(t) {
  const rng = makeRng(64101);
  const f = field(64102, 8, 3);
  for (let y = 16; y < 50; y++) {
    for (let x = 14; x < 50; x++) {
      const d = Math.hypot((x - 32) / 16, (y - 32) / 15) + (f[idx(x, y)] - 0.5) * 0.7;
      if (d < 0.72) put(t, x, y, mix(rgba(10, 8, 8), rgba(30, 20, 16), (y - 16) / 34));
      else if (d < 0.86) blendPx(t, x, y, d < 0.78 ? C.rustLt : C.rustDk, 0.95);
    }
  }
  for (let k = 0; k < 20; k++) blendPx(t, 16 + rng() * 32, 46 + rng() * 16, C.rustLt, 0.8);
}
function vRustPatch(t) {
  castShadow(t, 16, 16, 30, 26, 0.5, 1.5);
  rect(t, 16, 16, 30, 26, mul(C.steel, 0.85), 1);
  const f = brushField(64201);
  for (let j = 16; j < 42; j++) for (let i = 16; i < 46; i++) put(t, i, j, mul(at(t, i, j), 0.8 + f[idx(i, j)] * 0.35));
  for (let k = 0; k < 30; k++) {                       // weld bead all the way round
    for (const [x, y] of [[16 + k, 16], [16 + k, 41]]) disc(t, x, y, 1.2, (k % 2) ? rgba(120, 110, 100) : rgba(170, 160, 150), 1, 0.7);
  }
  for (let k = 0; k < 26; k++) for (const x of [16, 45]) disc(t, x, 16 + k, 1.2, (k % 2) ? rgba(120, 110, 100) : rgba(170, 160, 150), 1, 0.7);
  glow(t, 31, 29, 20, rgba(90, 60, 110), 0.25, 1.5);   // heat tint
  const rng = makeRng(64202);
  scrawl(t, 'HOT', 24, 26, rgba(236, 236, 226), rng, 0.85);
}
function vRustFurnace(t) {
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {   // soot-dark round the door, clean at the seams
    const d = Math.hypot(x - 32, y - 34) / 30;
    if (d < 1) t[y * W + x] = mul(t[y * W + x], 0.55 + d * d * 0.45);
  }
  disc(t, 32, 34, 20, rgba(26, 22, 20), 1, 1);          // the door
  for (let a = 0; a < 6.283; a += 0.03) for (let w = 0; w < 2; w++) {
    blendPx(t, 32 + Math.cos(a) * (19 + w), 34 + Math.sin(a) * (19 + w), Math.sin(a + 0.8) < 0 ? rgba(140, 120, 100) : rgba(20, 16, 14), 1);
  }
  for (let k = 0; k < 10; k++) rivet(t, 32 + Math.cos(k * 0.628) * 17, 34 + Math.sin(k * 0.628) * 17, 1.2, rgba(110, 90, 70));
  for (let j = 0; j < 14; j++) {                        // the grille, glowing
    const y = 27 + j;
    for (let x = 20; x < 44; x++) {
      const slot = (x - 20) % 4 < 2;
      const heat = 1 - Math.abs(y - 34) / 8;
      if (slot) put(t, x, y, mix(rgba(160, 40, 10), rgba(255, 220, 120), clamp(heat, 0, 1)));
      else put(t, x, y, rgba(30, 24, 20));
    }
  }
  glow(t, 32, 34, 26, rgba(255, 110, 30), 0.45, 1.6);
  rect(t, 44, 32, 9, 4, rgba(50, 44, 40), 1);           // latch handle
  blendPx(t, 44, 32, rgba(160, 140, 120), 1);
  for (let k = 0; k < 18; k++) {                        // soot licking up from the vents
    glow(t, 22 + k * 1.2, 12 - (k % 4), 5, BLACK, 0.18, 1.5);
  }
}

// --- sandbags ---------------------------------------------------------------
function vSandbagTorn(t) {
  const rng = makeRng(64401);
  poly(t, [[24, 28], [38, 26], [42, 34], [30, 38], [22, 34]], rgba(30, 24, 16), 1);   // the gash
  for (let k = 0; k < 120; k++) {                      // sand pouring out into a heap
    const u = rng();
    const x = 32 + (rng() - 0.5) * (4 + u * 26), y = 34 + u * 28;
    blendPx(t, x, y, mix(rgba(196, 170, 120), rgba(150, 126, 84), rng()), 0.95);
  }
  for (let y = 54; y < 64; y++) for (let x = 12; x < 54; x++) {
    const h = 54 + Math.abs(x - 32) * 0.45;
    if (y >= h) put(t, x, y, mix(rgba(186, 160, 110), rgba(120, 100, 70), (y - h) / 10));
  }
}
function vSandbagHelmet(t) {
  for (let y = 0; y < 14; y++) {                        // steel pot on the top course
    for (let x = 18; x < 46; x++) {
      const u = (x - 32) / 13, v = (y - 13) / 12;
      if (u * u + v * v > 1) continue;
      const lam = clamp(-u * 0.5 - v * 0.6 + 0.4, 0, 1);
      put(t, x, y, mix(rgba(40, 50, 34), rgba(120, 136, 96), lam));
    }
  }
  hline(t, 13, 17, 47, rgba(30, 36, 26), 1);
  disc(t, 36, 6, 1.2, BLACK, 1, 0.7);                   // with a hole in it
  const snap = t.slice();
  microC(t, 'BORN TO NUKE', 32, 34, rgba(230, 226, 210), 0.9);
  chipBack(t, snap, 64502, 14, 0.62, 0.7, 3);
}

// --- screens ----------------------------------------------------------------
function screenWall(t, seed) {
  fill(t, rgba(17, 18, 22));
  const f = field(seed, 8, 3);
  for (let i = 0; i < AREA; i++) t[i] = mul(t[i], 0.75 + f[i] * 0.55);
  for (const x of [0, 62]) { vline(t, x, 0, 63, mul(C.steelDk, 0.9), 0.9); vline(t, x + 1, 0, 63, mul(C.steel, 0.55), 0.5); }
  for (const y of [0, 62]) { hline(t, y, 0, 63, mul(C.steelDk, 0.9), 0.8); hline(t, y + 1, 0, 63, mul(C.steel, 0.5), 0.4); }
}
function bezel(t, x, y, w, h, glassCol) {
  rect(t, x - 2, y - 2, w + 4, h + 4, mul(C.steelDk, 0.55));
  bevel(t, x - 2, y - 2, w + 4, h + 4, C.steel, BLACK, true, 1, 0.6);
  bevel(t, x - 1, y - 1, w + 2, h + 2, BLACK, mul(C.steel, 0.7), false, 1, 0.8);
  rect(t, x, y, w, h, glassCol);
}
function glass(t, x, y, w, h) {
  scanlines(t, x, y, w, h, 0.36);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const nx = (i / (w - 1)) * 2 - 1, ny = (j / (h - 1)) * 2 - 1;
      const v = Math.max(Math.abs(nx), Math.abs(ny));
      if (v > 0.84) blendPx(t, x + i, y + j, BLACK, (v - 0.84) * 1.8);
      if (nx < -0.35 && ny < -0.3 && nx > -0.85 && ny > -0.8) blendPx(t, x + i, y + j, WHITE, 0.06);
    }
  }
}
function vScreensBsod(t) {
  screenWall(t, 65101);
  bezel(t, 6, 6, 52, 32, rgba(20, 30, 150));
  rect(t, 19, 9, 26, 5, rgba(170, 170, 170), 1);
  microC(t, 'MUTTER', 32, 9, rgba(20, 30, 150));
  microC(t, 'FATAL ERR 0E', 32, 16, WHITE);
  microC(t, 'PRESS ANY KEY', 32, 23, WHITE);
  microC(t, 'TO LAUNCH _', 32, 30, WHITE);
  glass(t, 6, 6, 52, 32);
  crtScreen(t, 7, 45, 20, 14, 'wave', 65102);
  crtScreen(t, 37, 45, 20, 14, 'radar', 65103);
  bloom(t, 3, 96, 0.8);
  grain(t, 65104, 0.04);
}
function vScreensFish(t) {
  screenWall(t, 65201);
  bezel(t, 5, 7, 54, 42, rgba(10, 40, 70));
  for (let j = 0; j < 42; j++) hline(t, 7 + j, 5, 58, mix(rgba(30, 120, 160), rgba(10, 40, 80), j / 42), 1);
  for (let x = 5; x < 59; x++) {                        // sand and weed
    const sy = 45 + Math.sin(x * 0.3) * 1.2;
    for (let y = sy; y < 49; y++) blendPx(t, x, y, rgba(190, 170, 110), 1);
  }
  for (const wx of [10, 16, 50]) {
    for (let y = 44; y > 28; y--) blendPx(t, wx + Math.sin(y * 0.5) * 1.5, y, rgba(40, 170, 80), 1);
  }
  const fish = (x, y, col, dir) => {
    disc(t, x, y, 2.4, col, 1, 0.8);
    poly(t, [[x - dir * 2, y], [x - dir * 5, y - 2.2], [x - dir * 5, y + 2.2]], col, 1);
    blendPx(t, x + dir * 1.2, y - 0.6, BLACK, 1);
  };
  fish(24, 18, rgba(255, 140, 40), 1);
  fish(42, 28, rgba(250, 220, 60), -1);
  fish(32, 38, rgba(255, 90, 90), 1);
  const rng = makeRng(65202);
  for (let k = 0; k < 10; k++) disc(t, 44 + rng() * 6, 10 + rng() * 26, 0.7, rgba(200, 240, 255), 0.8, 0.6);
  glass(t, 5, 7, 54, 42);
  rect(t, 38, 50, 18, 12, rgba(250, 230, 90), 1);       // sticky note on the bezel
  micro(t, 'DONT', 39, 51, rgba(30, 30, 60)); micro(t, 'TAP', 41, 57, rgba(30, 30, 60), 0.9);
  bloom(t, 3, 100, 0.7);
  grain(t, 65203, 0.04);
}
function vScreensPopup(t) {
  screenWall(t, 65301);
  bezel(t, 5, 6, 54, 44, rgba(0, 128, 128));            // 1995 teal
  rect(t, 7, 11, 50, 30, rgba(192, 192, 192), 1);      // the window
  bevel(t, 7, 11, 50, 30, WHITE, rgba(80, 80, 80), true, 1, 1);
  rect(t, 8, 12, 48, 5, rgba(0, 0, 150), 1);
  rect(t, 51, 13, 4, 3, rgba(192, 192, 192), 1);
  blendPx(t, 52, 14, BLACK, 0.9); blendPx(t, 53, 14, BLACK, 0.5);
  microC(t, 'HOT SINGLES', 32, 19, RED);
  microC(t, 'IN YOUR SILO', 32, 25, BLACK);
  for (let a = 0; a < 6.283; a += 0.1) {
    const x = 16 * Math.pow(Math.sin(a), 3), y = -(13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a));
    blendPx(t, 14 + x * 0.22, 34 + y * 0.22, rgba(230, 40, 120), 1);
  }
  rect(t, 26, 31, 24, 8, rgba(192, 192, 192), 1);
  bevel(t, 26, 31, 24, 8, WHITE, rgba(60, 60, 60), true, 1, 1);
  microC(t, 'CLICK', 38, 32.5, BLACK);
  rect(t, 5, 45, 54, 5, rgba(192, 192, 192), 1);        // taskbar
  rect(t, 6, 46, 9, 3, rgba(160, 160, 160), 1);
  glass(t, 5, 6, 54, 44);
  bloom(t, 3, 110, 0.6);
  grain(t, 65302, 0.04);
}
function vScreensRadar(t) {
  screenWall(t, 65401);
  bezel(t, 8, 5, 48, 48, rgba(6, 18, 10));
  crtScreen(t, 8, 5, 48, 48, 'radar', 65402);
  const rng = makeRng(65403);
  for (let k = 0; k < 4; k++) {                         // inbound tracks
    const a = rng() * 6.283, r = 10 + rng() * 10;
    const x = 32 + Math.cos(a) * r, y = 29 + Math.sin(a) * r;
    segment(t, x, y, x + Math.cos(a) * 5, y + Math.sin(a) * 5, rgba(255, 90, 60), 0.7, 0.8);
    disc(t, x, y, 1, rgba(255, 120, 80), 1, 0.6);
  }
  micro(t, 'INBOUND: LOTS', 7, 57, C.amber, 0.9);
  bloom(t, 3, 90, 0.8);
  grain(t, 65404, 0.04);
}
function vScreensDead(t) {
  screenWall(t, 65501);
  for (const [x, y, broke] of [[6, 6, true], [37, 6, false], [6, 37, false], [37, 37, true]]) {
    bezel(t, x, y, 22, 21, rgba(8, 10, 10));
    if (broke) {
      const rng = makeRng(65502 + x);
      for (let k = 0; k < 9; k++) {
        const a = rng() * 6.283;
        segment(t, x + 11, y + 10, x + 11 + Math.cos(a) * 14, y + 10 + Math.sin(a) * 12, rgba(150, 160, 160), 0.6, 0.6);
      }
      disc(t, x + 11, y + 10, 2.2, rgba(10, 10, 10), 1, 1);
      rect(t, x, y, 22, 21, BLACK, 0);
    } else {
      microC(t, 'NO', x + 11, y + 5, rgba(200, 200, 220));
      microC(t, 'SIGNAL', x + 11, y + 11, rgba(200, 200, 220));
      const rng = makeRng(65503 + y);
      for (let k = 0; k < 60; k++) blendPx(t, x + rng() * 22, y + rng() * 21, rgba(140, 150, 150), 0.3);
    }
    glass(t, x, y, 22, 21);
  }
  glow(t, 50, 50, 5, rgba(255, 220, 140), 0.6, 2);      // it is still arcing
  segment(t, 48, 48, 53, 52, WHITE, 0.7, 0.9);
  bloom(t, 3, 110, 0.7);
  grain(t, 65504, 0.04);
}
function vScreensToast(t) {
  screenWall(t, 65601);
  bezel(t, 5, 6, 54, 46, rgba(4, 4, 10));
  const rng = makeRng(65602);
  for (let k = 0; k < 20; k++) blendPx(t, 6 + rng() * 52, 7 + rng() * 44, rgba(200, 200, 230), 0.6);
  const toaster = (x, y, flap) => {                     // chrome toaster, flapping wings
    rect(t, x, y, 9, 6, rgba(190, 196, 206), 1);
    hline(t, y, x, x + 8, WHITE, 0.8);
    rect(t, x + 2, y + 1, 2, 1, BLACK, 1); rect(t, x + 5, y + 1, 2, 1, BLACK, 1);
    const wy = flap ? -3 : 1;
    poly(t, [[x + 1, y + 2], [x - 4, y + wy], [x - 3, y + 3]], WHITE, 1);
    poly(t, [[x + 8, y + 2], [x + 13, y + wy], [x + 12, y + 3]], WHITE, 1);
  };
  toaster(12, 14, true); toaster(36, 22, false); toaster(20, 36, false);
  const toast = (x, y) => { rect(t, x, y, 5, 4, rgba(200, 150, 80), 1); hline(t, y, x, x + 4, rgba(150, 90, 40), 1); };
  toast(44, 10); toast(46, 40); toast(10, 28);
  glass(t, 5, 6, 54, 46);
  micro(t, 'AFTER DUSK', 16, 55, C.cyan, 0.7);
  bloom(t, 3, 110, 0.6);
  grain(t, 65603, 0.04);
}

// --- circuit, silo, warning ---------------------------------------------------
function vCircuitBurnt(t) {
  glow(t, 36, 30, 22, rgba(10, 8, 6), 0.85, 1.3);
  const rng = makeRng(66101);
  for (let k = 0; k < 6; k++) crack(t, rng, 36, 30, rng() * 6.283, 14, 1, rgba(40, 20, 10), rgba(140, 90, 40), 1);
  disc(t, 36, 30, 4, rgba(60, 50, 40), 1, 1);           // the chip that let go
  disc(t, 35, 29, 1.5, rgba(160, 150, 120), 0.8, 1);
  glow(t, 12, 50, 5, rgba(255, 120, 40), 0.7, 2);
}
function vCircuitTape(t) {
  fill(t, rgba(150, 150, 140));
  const f = brushField(66201);
  for (let i = 0; i < AREA; i++) t[i] = mul(t[i], 0.78 + f[i] * 0.3);
  for (const cx of [20, 44]) {
    bezel(t, cx - 11, 6, 22, 30, rgba(20, 22, 26));
    for (const cy of [13, 28]) {
      disc(t, cx, cy, 6, rgba(40, 30, 24), 1, 1);
      disc(t, cx, cy, 5.2, rgba(90, 70, 50), 1, 1);
      disc(t, cx, cy, 2, rgba(200, 200, 200), 1, 1);
      for (let k = 0; k < 3; k++) segment(t, cx, cy, cx + Math.cos(k * 2.09 + cy) * 4.5, cy + Math.sin(k * 2.09 + cy) * 4.5, rgba(30, 30, 30), 0.8, 1);
    }
    glow(t, cx - 5, 10, 8, WHITE, 0.15, 2);
  }
  rect(t, 6, 42, 52, 16, rgba(60, 62, 66), 1);
  bevel(t, 6, 42, 52, 16, WHITE, BLACK, true, 1, 0.6);
  const rng = makeRng(66202);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 12; c++) {
    const on = rng() < 0.5;
    disc(t, 10 + c * 4, 46 + r * 4, 1, on ? [C.amber, RED, C.green][(c + r) % 3] : rgba(50, 40, 30), 1, 0.6);
  }
  bloom(t, 2, 150, 0.8);
  grain(t, 66203, 0.04);
}
function vSilo13(t) { paintSiloWall(t, '13'); }
function vSilo03(t) { paintSiloWall(t, '03'); }
function vSiloLadder(t) {
  for (const x of [22, 40]) {
    for (let y = 0; y < W; y++) {
      blendPx(t, x + 2, y, BLACK, 0.4);
      for (let w = -1; w <= 1; w++) blendPx(t, x + w, y, mix(mul(C.steel, 0.5), C.spec, cyl(w / 1.5)), 1);
    }
  }
  for (let y = 4; y < W; y += 7) {
    segment(t, 22, y + 1.5, 40, y + 1.5, BLACK, 1.4, 0.4);
    segment(t, 22, y, 40, y, mul(C.spec, 0.9), 1.4, 1);
  }
  for (const y of [10, 48]) for (const x of [22, 40]) { rect(t, x - 3, y, 7, 3, mul(C.steel, 0.8), 1); rivet(t, x, y + 1.5, 1, C.spec); }
}
function vSiloScorch(t) {
  const f = field(66601, 6, 4);
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const v = y / 63;
      const k = clamp((f[y * W + x] * 0.8 + v * 0.9 - 0.75) * 2.2, 0, 1) * (1 - Math.abs(x - 32) / 40);
      if (k > 0) blendPx(t, x, y, rgba(14, 12, 12), k * 0.95);
    }
  }
  const rng = makeRng(66602);
  for (let k = 0; k < 18; k++) {                        // blistered paint
    const x = 8 + rng() * 48, y = 26 + rng() * 30;
    disc(t, x, y, 0.8 + rng() * 1.2, rgba(90, 80, 70), 0.7, 0.8);
    blendPx(t, x - 0.5, y - 0.5, rgba(160, 150, 130), 0.6);
  }
}
function warnBase(t) {
  steelBase(t, 66701, { col: C.steelMid });
  bevel(t, 1, 1, 62, 62, C.spec, BLACK, true, 2, 0.55);
  for (const [x, y] of [[6, 6], [57, 6], [6, 57], [57, 57]]) rivet(t, x, y, 2.6, C.steel);
}
function vWarnSmoke(t) {
  warnBase(t);
  placard(t, 8, 8, 48, 46, C.yellow, BLACK, [], { border: BLACK, seed: 66702 });
  disc(t, 32, 19, 7.5, RED, 1, 1);
  disc(t, 32, 19, 5.6, C.yellow, 1, 1);
  rect(t, 26, 18, 11, 3, WHITE, 1); rect(t, 36, 18, 2, 3, rgba(220, 120, 40), 1);
  segment(t, 27, 14, 37, 24, RED, 2, 1);
  microC(t, 'NO SMOKING', 32, 30, BLACK);
  microC(t, 'NEAR THE', 32, 36, BLACK);
  drawTextCentered(t, 'NUKES', 32, 43, 1, RED);
  edgeRust(t, 66703, 0.5, { top: 0.3, bot: 0.7, side: 0.4 });
  wallLight(t, { seed: 66704, top: 1.1, bot: 0.72, grime: 0.4 });
}
function vWarnIncident(t) {
  warnBase(t);
  placard(t, 7, 7, 50, 48, rgba(236, 232, 218), BLACK, [
    { text: 'THIS SILO HAS' }, { text: 'GONE' },
  ], { border: rgba(40, 110, 50), seed: 66801, pad: 5 });
  rect(t, 22, 23, 20, 13, BLACK, 1);
  drawTextCentered(t, '0', 32, 26, 1, RED);
  microC(t, 'DAYS WITHOUT', 32, 39, BLACK);
  microC(t, 'AN INCIDENT', 32, 45, BLACK);
  edgeRust(t, 66802, 0.5, { top: 0.3, bot: 0.7, side: 0.4 });
  wallLight(t, { seed: 66803, top: 1.1, bot: 0.72, grime: 0.4 });
}
function vWarnGlow(t) {
  warnBase(t);
  disc(t, 32, 18, 13, C.yellow, 1, 1.2);
  trefoil(t, 32, 18, 11.5, C.black, 1);
  rect(t, 8, 34, 48, 22, C.black, 0.95);
  microC(t, 'IF YOU CAN', 32, 36, C.yellow);
  microC(t, 'READ THIS', 32, 43, C.yellow);
  microC(t, 'YOU GLOW', 32, 50, RED);
  edgeRust(t, 66902, 0.55, { top: 0.3, bot: 0.7, side: 0.4 });
  wallLight(t, { seed: 66903, top: 1.1, bot: 0.72, grime: 0.4 });
}

// --- flesh ------------------------------------------------------------------
function vFleshEye(t) {
  for (let j = -14; j <= 14; j++) {
    for (let i = -20; i <= 20; i++) {
      const lid = 13 * Math.sqrt(Math.max(0, 1 - (i / 20) ** 2));
      if (Math.abs(j) > lid + 2) continue;
      if (Math.abs(j) > lid) { blendPx(t, 32 + i, 28 + j, mul(C.fleshDk, 0.7), 0.9); continue; }
      put(t, 32 + i, 28 + j, mix(rgba(236, 226, 206), rgba(200, 150, 140), (Math.abs(i) / 20) ** 2));
    }
  }
  const rng = makeRng(67101);
  for (let k = 0; k < 8; k++) crack(t, rng, 32 + (rng() < 0.5 ? -19 : 19), 28 + (rng() - 0.5) * 10, rng() < 0.5 ? 0 : 3.14, 9, 0.6, rgba(190, 40, 40), rgba(220, 120, 120), 1);
  disc(t, 34, 27, 9, rgba(80, 150, 60), 1, 1);          // iris
  disc(t, 34, 27, 4.5, rgba(10, 8, 8), 1, 1);
  disc(t, 31, 24, 2, WHITE, 0.9, 1);
  segment(t, 12, 17, 52, 15, mul(C.fleshDk, 0.6), 2.5, 0.8);    // upper lid crease
  wetSheen(t, 67102, 6, 0.5);
}
function vFleshMouth(t) {
  const cx = 32, cy = 36;
  for (let i = -18; i <= 18; i++) {
    const open = 7 * Math.sqrt(Math.max(0, 1 - (i / 18) ** 2));
    for (let j = -open - 3; j <= open + 3; j++) {
      const d = Math.abs(j) - open;
      if (d < 0) put(t, cx + i, cy + j, mix(rgba(40, 6, 10), rgba(110, 20, 30), (j + open) / (2 * open + 1)));
      else blendPx(t, cx + i, cy + j, rgba(150, 50, 60), 0.7 * (1 - d / 3));
    }
  }
  for (let k = -4; k <= 4; k++) {                       // teeth, too many, too human
    const x = cx + k * 3.6, h = 6 * Math.sqrt(Math.max(0, 1 - (k / 5) ** 2));
    rect(t, x - 1, cy - h - 1, 3, h * 0.8, rgba(230, 220, 190), 1);
    rect(t, x - 1, cy + h * 0.3, 3, h * 0.7, rgba(210, 200, 170), 1);
  }
  wetSheen(t, 67201, 8, 0.5);
}
function vFleshTumor(t) {
  const rng = makeRng(67301);
  for (let k = 0; k < 11; k++) {
    const x = 8 + rng() * 48, y = 8 + rng() * 48, r = 2.5 + rng() * 5;
    disc(t, x + 1.2, y + 1.5, r, mul(C.fleshDk, 0.5), 0.7, 1.5);
    disc(t, x, y, r, mix(C.flesh, rgba(200, 170, 110), 0.3 + rng() * 0.3), 1, 1);
    disc(t, x - r * 0.1, y - r * 0.15, r * 0.45, rgba(236, 216, 120), 0.9, 1);
    disc(t, x - r * 0.3, y - r * 0.35, r * 0.2, WHITE, 0.6, 0.8);
  }
}
function vFleshFace(t) {
  const cx = 32, cy = 30;
  for (let j = -20; j <= 22; j++) {                     // a face pushing through
    for (let i = -14; i <= 14; i++) {
      const d = Math.hypot(i / 14, j / 21);
      if (d > 1) continue;
      const lam = clamp(-i / 14 * 0.4 - j / 21 * 0.5 + 0.5, 0, 1);
      blendPx(t, cx + i, cy + j, mix(mul(C.fleshDk, 0.9), addRGB(C.flesh, 40, 20, 10), lam), 0.85 * (1 - d * 0.4));
    }
  }
  disc(t, cx - 6, cy - 4, 3.4, rgba(24, 8, 10), 1, 1);  // sockets
  disc(t, cx + 6, cy - 4, 3.4, rgba(24, 8, 10), 1, 1);
  segment(t, cx, cy - 2, cx - 1, cy + 5, addRGB(C.flesh, 30, 16, 8), 3, 0.9);  // nose
  for (let a = 0; a < 6.283; a += 0.05) blendPx(t, cx + Math.cos(a) * 4, cy + 12 + Math.sin(a) * 5, rgba(30, 6, 10), 1);
  disc(t, cx, cy + 12, 3.6, rgba(30, 6, 10), 1, 1);     // screaming
  wetSheen(t, 67401, 10, 0.5);
}

// --- salt, lockers, racks, organ ------------------------------------------------
function vSaltCrystal(t) {
  const rng = makeRng(68101);
  for (let k = 0; k < 16; k++) {
    const x = 12 + rng() * 40, base = 62, h = 10 + rng() * 26, w = 2 + rng() * 3;
    const top = base - h;
    poly(t, [[x - w + 1, base], [x + w + 1, base], [x + w + 1, top + 3], [x + 1, top]], BLACK, 0.35);
    poly(t, [[x - w, base], [x + w, base], [x + w, top + 3], [x, top], [x - w, top + 3]], mix(rgba(190, 200, 210), rgba(240, 244, 246), rng()), 1);
    segment(t, x - w + 0.6, base, x - w + 0.6, top + 3, WHITE, 0.8, 0.7);
    segment(t, x + w - 0.6, base, x + w - 0.6, top + 3, rgba(120, 140, 160), 0.8, 0.7);
  }
}
function vSaltShrine(t) {
  const rng = makeRng(68201);
  spray(t, 'PRAISE', 14, 6, 1, rgba(170, 20, 20), rng);
  spray(t, 'THE BLAST', 5, 16, 1, rgba(170, 20, 20), rng);
  rect(t, 8, 44, 48, 4, rgba(90, 80, 70), 1);            // ledge
  hline(t, 44, 8, 55, rgba(170, 160, 150), 1);
  for (let k = 0; k < 7; k++) {                        // votives
    const x = 11 + k * 7 + (rng() - 0.5) * 2, h = 4 + rng() * 6;
    rect(t, x - 1, 44 - h, 3, h, rgba(230, 220, 190), 1);
    disc(t, x, 44 - h - 2, 1.2, rgba(255, 220, 110), 1, 0.8);
    glow(t, x, 44 - h - 2, 7, rgba(255, 170, 60), 0.3, 1.8);
  }
  for (let k = 0; k < 5; k++) drip(t, 68210 + k, 10 + k * 10, 46, 56 + rng() * 6, rgba(230, 220, 190), 0.8, 1.2);
  skull(t, 32, 30, 4);
}
function vSaltCracked(t) {
  const rng = makeRng(68301);
  crack(t, rng, 30, 0, 1.6, 64, 3, rgba(20, 20, 24), rgba(236, 238, 240), 3);
  crack(t, rng, 30, 20, 0.4, 24, 1.8, rgba(20, 20, 24), rgba(236, 238, 240), 2);
  for (let k = 0; k < 4; k++) drip(t, 68310 + k, 28 + k * 3, 10 + k * 8, 62, rgba(40, 50, 60), 0.55, 1.6);   // brine seep
}
function vSaltBones(t) {
  skull(t, 24, 30, 5, rgba(220, 214, 196));
  skull(t, 42, 44, 3.5, rgba(206, 200, 180));
  for (const [x, y, a] of [[34, 22, 0.3], [14, 48, -0.4], [48, 28, 1.2]]) {
    segment(t, x, y, x + Math.cos(a) * 9, y + Math.sin(a) * 9, rgba(214, 206, 186), 1.8, 1);
    disc(t, x, y, 1.5, rgba(226, 220, 200), 1, 0.8);
    disc(t, x + Math.cos(a) * 9, y + Math.sin(a) * 9, 1.5, rgba(226, 220, 200), 1, 0.8);
  }
  saltCrust(t, 68401, 0.5);
}
function vLockersOpen(t) {
  lockerBank(t, 68501, ['21', '22', '23', '24'], 2);
  const x0 = 33;
  rect(t, x0 + 1, 18, 12, 16, PAPER, 1);                // pin-up taped inside the door
  for (let j = 0; j < 14; j++) hline(t, 19 + j, x0 + 2, x0 + 12, mix(rgba(255, 120, 150), rgba(255, 190, 90), j / 14), 1);
  pinupGirl(t, x0 + 1.5, 19, 12, rgba(40, 18, 40));
  disc(t, 38, 10, 3.5, rgba(60, 70, 50), 1, 1);          // a helmet on the shelf
  rect(t, x0 + 3, 44, 8, 12, rgba(60, 70, 90), 1);        // somebody's jacket
  micro(t, 'NO', x0 + 4, 38, RED, 0.8);
}
function vServerB(t) { paintServer(t, 43977); }
function vServerLabel(t) {
  paintServer(t);
  rect(t, 6, 26, 52, 10, rgba(200, 200, 196), 1);
  bevel(t, 6, 26, 52, 10, WHITE, rgba(80, 80, 80), true, 1, 0.8);
  microC(t, 'MUTTER 9000', 32, 28, rgba(20, 20, 30));
  disc(t, 56, 31, 1.6, RED, 1, 0.8);
  glow(t, 56, 31, 5, RED, 0.6, 2);
}
function vOrganRamp(t) { paintOrganPipes(t, [4, 7, 10, 14, 18, 22, 26, 30]); }
function vOrganPipes2(t) {
  paintOrganPipes(t);
  const rng = makeRng(68701);
  spray(t, 'SING', 16, 44, 1, rgba(200, 30, 30), rng, { runs: 3 });
}


// --- the quiet ones: small differences that stop a run repeating -------------
function vRivetRust(t) {
  const rng = makeRng(69101);
  for (let k = 0; k < 7; k++) {
    const x = 6 + rng() * 52, y0 = 6 + rng() * 20;
    drip(t, 69110 + k, x, y0, y0 + 20 + rng() * 30, mul(C.rustDk, 1.1), 0.6, 1.6 + rng());
    disc(t, x, y0, 2 + rng() * 2, C.rust, 0.7, 1.5);
  }
  for (let k = 0; k < 40; k++) blendPx(t, 4 + rng() * 56, 30 + rng() * 30, C.rustLt, 0.5);
}
function vRivetDents(t) {
  const rng = makeRng(69201);
  for (let k = 0; k < 6; k++) {
    const x = 12 + rng() * 40, y = 16 + rng() * 32, r = 2.4 + rng() * 2.4;
    glow(t, x + 1, y + 1, r + 1.5, BLACK, 0.45, 1.2);
    glow(t, x - r * 0.4, y - r * 0.4, r * 0.8, C.specHot, 0.35, 1.5);
  }
  for (let k = 0; k < 8; k++) {
    const x = 6 + rng() * 50, y = 34 + rng() * 22, l = 5 + rng() * 10;
    segment(t, x, y, x + l, y + (rng() - 0.5) * 3, C.specHot, 0.8, 0.35);
  }
}
function vSiloStain(t) {
  const rng = makeRng(69301);
  for (let k = 0; k < 6; k++) drip(t, 69310 + k, 6 + rng() * 52, 10 + rng() * 10, 58, mul(C.rustDk, 1.05), 0.55, 1.4 + rng());
  dampBloom(t, 69302, 0.8, C.moss);
}
function vOfficeScuff(t) {
  const rng = makeRng(69401);
  castShadow(t, 44, 28, 5, 8, 0.4, 1);                  // light switch
  rect(t, 44, 28, 5, 8, rgba(210, 204, 186), 1);
  bevel(t, 44, 28, 5, 8, WHITE, rgba(120, 116, 100), true, 1, 0.8);
  rect(t, 46, 30, 1, 3, rgba(160, 156, 140), 1);
  castShadow(t, 12, 48, 6, 7, 0.4, 1);                  // an outlet, somebody's space heater
  rect(t, 12, 48, 6, 7, rgba(200, 194, 176), 1);
  blendPx(t, 14, 50, BLACK, 1); blendPx(t, 15, 50, BLACK, 1); blendPx(t, 14, 52, BLACK, 1); blendPx(t, 15, 52, BLACK, 1);
  disc(t, 28, 22, 3.5, rgba(214, 210, 190), 0.9, 1.4);   // a spackled-over hole, never painted
  for (let k = 0; k < 10; k++) {
    const x = 4 + rng() * 54, y = 40 + rng() * 14, l = 3 + rng() * 10;
    segment(t, x, y, x + l, y + (rng() - 0.5) * 2, rgba(26, 26, 26), 1, 0.35);
  }
}
function vOfficeVent(t) {
  castShadow(t, 22, 6, 20, 12, 0.5, 1.5);
  rect(t, 22, 6, 20, 12, rgba(170, 168, 156), 1);
  bevel(t, 22, 6, 20, 12, WHITE, rgba(90, 88, 80), true, 1, 0.8);
  for (let y = 8; y < 17; y += 2) hline(t, y, 24, 39, rgba(40, 40, 38), 0.9);
  for (let k = 0; k < 5; k++) drip(t, 69501 + k, 24 + k * 4, 18, 30 + k * 3, rgba(50, 46, 40), 0.35, 1.2);   // dust streaks
}
function vCircuitB(t) { paintCircuit(t, 1); }
function vTileSplat(t) {
  const rng = makeRng(69601);
  for (let k = 0; k < 30; k++) {
    const a = rng() * 6.283, d = Math.pow(rng(), 0.7) * 18;
    disc(t, 22 + Math.cos(a) * d, 40 + Math.sin(a) * d * 0.6, 0.5 + rng() * 2, rng() < 0.4 ? C.bloodDk : C.blood, 0.85, 0.9);
  }
  smear(t, 14, 44, 52, 50, 4, rng);
  for (let k = 0; k < 5; k++) drip(t, 69610 + k, 16 + k * 7, 40, 60, C.blood, 0.7, 1.2);
}

// ---------------------------------------------------------------------------
// floor and ceiling dressings: kept inside 3..60 on both axes, because these
// tile in two directions and their neighbours will not share the joke.
// ---------------------------------------------------------------------------

function vFloorDrain(t) { drain(t, 32, 32, 7); oilStain(t, 44, 42, 5, 70101); }
function vFloorOil(t) {
  oilStain(t, 28, 30, 14, 70201);
  oilStain(t, 46, 44, 6, 70202);
  const rng = makeRng(70203);
  for (let k = 0; k < 4; k++) {                          // tyre tracks through it
    const y = 18 + k * 8;
    segment(t, 4, y, 60, y + 4, rgba(20, 18, 16), 1.6, 0.25);
  }
  void rng;
}
function vFloorCrack(t) {
  const rng = makeRng(70301);
  crack(t, rng, 6, 20, 0.5, 60, 2.4, rgba(16, 16, 18), add(C.conc, 30), 3);
  for (let k = 0; k < 6; k++) {                          // weeds that should not grow down here
    const x = 20 + k * 6, y = 28 + Math.sin(k) * 4;
    for (let q = 0; q < 3; q++) segment(t, x, y, x + (rng() - 0.5) * 5, y - 2 - rng() * 3, rgba(70, 110, 40), 0.8, 0.9);
  }
}
function vFloorKeepClear(t) {
  // Painted in front of blast doors; by now mostly a suggestion.
  const snap = t.slice();
  for (let y = 6; y < 58; y++) {
    for (let x = 6; x < 58; x++) {
      const e = Math.min(x - 6, 57 - x, y - 6, 57 - y);
      if (e > 5) continue;
      const st = ((x + y) % 10) < 5;
      blendPx(t, x, y, st ? C.yellow : C.black, 0.85);
    }
  }
  drawTextCentered(t, 'KEEP', 32, 21, 1, mul(C.yellow, 0.9), { alpha: 0.9 });
  drawTextCentered(t, 'CLEAR', 32, 32, 1, mul(C.yellow, 0.9), { alpha: 0.9 });
  chipBack(t, snap, 70451, 10, 0.56, 0.9, 3);
  chipBack(t, snap, 70452, 26, 0.64, 0.8, 3);
}
function vFloorPuddle(t) { puddle(t, 32, 34, 18, 12, 70401); drip(t, 70402, 32, 20, 22, rgba(80, 90, 100), 0.3, 1); }
function vFloorRubble(t) {
  const rng = makeRng(70501);
  rubble(t, 30, 32, 26, 16, rng, C.conc);
  rubble(t, 36, 30, 10, 8, rng, rgba(150, 140, 120));
  segment(t, 18, 26, 30, 40, C.rustDk, 1, 1);           // a bent length of rebar
  segment(t, 30, 40, 44, 36, C.rustDk, 1, 1);
}
function vFloorOutline(t) {
  // The crime-scene chalk outline. Nobody has come to collect him.
  const pts = [[32, 6], [36, 8], [37, 13], [44, 16], [52, 26], [48, 28], [41, 21], [40, 32], [45, 44], [48, 58], [42, 59],
    [36, 44], [32, 40], [28, 44], [22, 59], [16, 58], [20, 44], [24, 32], [23, 21], [16, 28], [12, 26], [20, 16], [27, 13], [28, 8]];
  for (let k = 0; k < pts.length; k++) {
    const a = pts[k], b = pts[(k + 1) % pts.length];
    segment(t, a[0], a[1], b[0], b[1], rgba(226, 226, 216), 1.1, 0.8);
  }
  const rng = makeRng(70601);
  for (let k = 0; k < 20; k++) disc(t, 26 + rng() * 14, 20 + rng() * 24, 0.5 + rng() * 1.5, C.bloodDk, 0.75, 0.9);
}
function vFloorButts(t) {
  const rng = makeRng(70701);
  glow(t, 32, 32, 16, rgba(30, 28, 26), 0.5, 1.4);
  for (let k = 0; k < 14; k++) {                         // cigarette ends round a foot-shaped gap
    const x = 20 + rng() * 24, y = 20 + rng() * 24, a = rng() * 6.283;
    segment(t, x, y, x + Math.cos(a) * 3, y + Math.sin(a) * 3, rgba(226, 222, 206), 1.2, 1);
    blendPx(t, x + Math.cos(a) * 3, y + Math.sin(a) * 3, rgba(200, 140, 80), 1);
  }
  for (let k = 0; k < 40; k++) blendPx(t, 18 + rng() * 28, 18 + rng() * 28, rgba(110, 110, 106), 0.5);
}
function vTileFloorMissing(t) {
  const rng = makeRng(70801);
  for (const [x, y] of [[16, 16], [32, 32], [16, 32]]) {
    rect(t, x + 1, y + 1, 14, 14, rgba(62, 58, 50), 1);
    bevel(t, x + 1, y + 1, 14, 14, BLACK, rgba(160, 160, 150), false, 1, 0.8);
    for (let k = 0; k < 30; k++) blendPx(t, x + 2 + rng() * 12, y + 2 + rng() * 12, rgba(40, 38, 34), 0.8);
  }
  rubble(t, 46, 22, 6, 5, rng, rgba(170, 170, 160));
}
function vTileFloorCrack(t) {
  const rng = makeRng(70901);
  crack(t, rng, 10, 10, 0.8, 56, 1.8, rgba(30, 30, 28), rgba(200, 200, 190), 3);
}
function vTileFloorBlood(t) {
  const rng = makeRng(71001);
  for (let k = 0; k < 6; k++) {                          // bloody footprints walking off
    const x = 14 + k * 7, y = 50 - k * 7 + (k % 2) * 3;
    disc(t, x, y, 2.2, C.blood, 0.7 - k * 0.08, 1);
    disc(t, x + 1.6, y - 3.2, 1.6, C.blood, 0.7 - k * 0.08, 1);
  }
  for (let k = 0; k < 12; k++) disc(t, 10 + rng() * 14, 46 + rng() * 12, 0.5 + rng(), C.bloodDk, 0.8, 0.9);
}
function vGrateGlow(t) {
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, c = t[i];
    const k = clamp(1 - Math.hypot(x - 32, y - 32) / 30, 0, 1);
    if (lum(c) < 30) t[i] = mix(c, rgba(50, 150, 70), 0.45 * k);   // whatever is down there is glowing
  }
  glow(t, 32, 32, 26, rgba(90, 255, 120), 0.1, 1.5);
}
function vDirtBones(t) {
  const rng = makeRng(71201);
  skull(t, 26, 28, 4);
  for (let k = 0; k < 5; k++) {
    const x = 14 + rng() * 36, y = 14 + rng() * 36, a = rng() * 6.283;
    segment(t, x, y, x + Math.cos(a) * 8, y + Math.sin(a) * 8, rgba(214, 206, 186), 1.6, 1);
    disc(t, x + Math.cos(a) * 8, y + Math.sin(a) * 8, 1.3, rgba(226, 220, 200), 1, 0.8);
  }
}
function vDirtPuddle(t) { puddle(t, 30, 30, 16, 11, 71301, rgba(30, 28, 20)); }
function vDeckHatch(t) {
  disc(t, 32, 32, 20, BLACK, 0.5, 2);
  disc(t, 32, 32, 18, mul(C.steel, 0.8), 1, 1);
  for (let a = 0; a < 6.283; a += 0.02) blendPx(t, 32 + Math.cos(a) * 17, 32 + Math.sin(a) * 17, Math.sin(a + 0.8) < 0 ? C.spec : BLACK, 0.7);
  for (let k = 0; k < 8; k++) rivet(t, 32 + Math.cos(k * 0.785) * 15, 32 + Math.sin(k * 0.785) * 15, 1.2, C.steel);
  drawTextCentered(t, '07', 32, 29, 1, mul(C.yellow, 0.9));
  for (let a = 0; a < 6.283; a += 0.8) segment(t, 32 + Math.cos(a) * 19, 32 + Math.sin(a) * 19, 32 + Math.cos(a + 0.4) * 19, 32 + Math.sin(a + 0.4) * 19, C.yellow, 1.5, 0.8);
}
function vDeckOil(t) { oilStain(t, 30, 34, 12, 71501); }
function vBloodFloor2(t) {
  const rng = makeRng(71601);
  smear(t, 8, 30, 58, 36, 6, rng);
  handprint(t, 20, 24, 1.2, C.bloodDk, rng, 0);
}
function vLinoCoffee(t) {
  const rng = makeRng(71701);
  for (let a = 0; a < 6.283; a += 0.02) blendPx(t, 26 + Math.cos(a) * 9, 30 + Math.sin(a) * 7, rgba(90, 60, 30), 0.7);
  disc(t, 26, 30, 8, rgba(110, 76, 40), 0.35, 2);
  for (const [x, y, a] of [[40, 20, 0.3], [42, 40, -0.4]]) {   // dropped paperwork
    const c = Math.cos(a), s2 = Math.sin(a);
    const P = (u, v) => [x + u * c - v * s2, y + u * s2 + v * c];
    poly(t, [P(-6, -8), P(6, -8), P(6, 8), P(-6, 8)].map(([u, v]) => [u + 1, v + 1]), BLACK, 0.3);
    poly(t, [P(-6, -8), P(6, -8), P(6, 8), P(-6, 8)], rgba(230, 228, 220), 1);
    for (let k = -5; k < 6; k += 2) segment(t, ...P(-4, k), ...P(4, k), rgba(120, 120, 130), 0.5, 0.7);
  }
  void rng;
}
function vLinoMissing(t) { vTileFloorMissing(t); }
function vLinoBlood(t) { vTileFloorBlood(t); }
function vSaltFloorPuddle(t) { puddle(t, 32, 30, 17, 12, 71801, rgba(40, 56, 70)); }
function vRaisedOpen(t) {
  rect(t, 32, 32, 32, 32, BLACK, 0);
  rect(t, 33, 33, 29, 29, rgba(10, 10, 12), 1);        // tile lifted out
  const cols = [RED, rgba(40, 90, 200), C.yellow, rgba(40, 40, 44)];
  for (let k = 0; k < 7; k++) segment(t, 33, 36 + k * 3.5, 61, 38 + k * 3 + Math.sin(k) * 2, cols[k % 4], 1.4, 1);
  rect(t, 6, 10, 20, 20, rgba(96, 100, 108), 1);         // leaning against the next one
  bevel(t, 6, 10, 20, 20, C.spec, BLACK, true, 1, 0.7);
}
function vScorchGrille(t) {
  rect(t, 16, 16, 32, 32, BLACK, 1);
  for (let y = 18; y < 46; y++) for (let x = 18; x < 46; x++) {
    if ((x % 4) < 2) put(t, x, y, mix(rgba(120, 30, 10), rgba(255, 160, 60), clamp(1 - Math.hypot(x - 32, y - 32) / 16, 0, 1)));
  }
  for (let y = 16; y < 48; y += 4) hline(t, y, 16, 47, rgba(40, 36, 34), 1);
  bevel(t, 16, 16, 32, 32, rgba(120, 110, 100), BLACK, true, 1, 0.8);
}
function vCeilStain(t) { waterStain(t, 30, 8, 36, 44, 72101, rgba(80, 64, 40)); drip(t, 72102, 30, 30, 36, rgba(60, 50, 30), 0.5, 1.5); }
function vCeilVent(t) {
  rect(t, 16, 16, 32, 32, rgba(12, 12, 14), 1);
  bevel(t, 16, 16, 32, 32, C.spec, BLACK, true, 2, 0.8);
  for (let y = 19; y < 46; y += 3) hline(t, y, 19, 44, mul(C.steel, 0.9), 1);
  for (const [x, y] of [[18, 18], [45, 18], [18, 45], [45, 45]]) screw(t, x, y, 1.1, C.steel);
  glow(t, 32, 32, 22, BLACK, 0.25, 1.5);
}
function vCeilCables(t) {
  const rng = makeRng(72301);
  for (let k = 0; k < 4; k++) {
    const y0 = 12 + k * 10, col = [RED, rgba(40, 80, 180), C.yellow, rgba(30, 30, 34)][k];
    for (let x = 4; x < 60; x++) {
      const y = y0 + Math.sin((x - 4) / 56 * Math.PI) * (5 + k);
      blendPx(t, x + 1, y + 1.5, BLACK, 0.4);
      blendPx(t, x, y, col, 1);
    }
  }
  void rng;
}
function vCeilPipesVent(t) {
  rect(t, 20, 18, 24, 28, rgba(14, 14, 16), 1);
  bevel(t, 20, 18, 24, 28, C.spec, BLACK, true, 1, 0.8);
  for (let y = 21; y < 44; y += 3) hline(t, y, 22, 41, mul(C.steel, 0.9), 1);
}
function vCeilPipesLeak(t) {
  for (let k = 0; k < 3; k++) drip(t, 72501 + k, 20 + k * 12, 14, 40, rgba(80, 100, 110), 0.6, 1.3);
  glow(t, 30, 18, 10, rgba(230, 232, 236), 0.35, 1.5);
}
function vCeilFleshTumor(t) { vFleshTumor(t); }
function vCeilFleshEye(t) { vFleshEye(t); }
function vCeilOfficeStain(t) {
  waterStain(t, 32, 4, 44, 50, 72701, rgba(120, 90, 50));
  for (let a = 0; a < 6.283; a += 0.03) blendPx(t, 26 + Math.cos(a) * 12, 30 + Math.sin(a) * 10, rgba(110, 80, 40), 0.5);
}
function vCeilOfficeMissing(t) {
  rect(t, 33, 1, 30, 30, rgba(8, 8, 10), 1);             // a tile gone, the void above
  for (let k = 0; k < 3; k++) segment(t, 36 + k * 8, 3, 38 + k * 7, 30, [RED, rgba(30, 30, 34), rgba(50, 90, 170)][k], 1.2, 1);
  segment(t, 40, 20, 44, 36, rgba(40, 40, 44), 1.4, 1);   // cable hanging down through it
  disc(t, 44, 37, 1, C.rustLt, 1, 0.8);
  glow(t, 12, 14, 8, rgba(40, 30, 20), 0.3, 1.5);
}
function vCeilLampDead(t) {
  for (let i = 0; i < AREA; i++) t[i] = mul(t[i], 0.42);
  disc(t, 32, 32, 21, rgba(26, 24, 22), 0.9, 1);
  const rng = makeRng(72901);
  for (let k = 0; k < 10; k++) {                          // shards still in the cage
    const a = rng() * 6.283, r = 8 + rng() * 12;
    poly(t, [[32 + Math.cos(a) * r, 32 + Math.sin(a) * r], [32 + Math.cos(a + 0.2) * (r + 5), 32 + Math.sin(a + 0.2) * (r + 5)],
      [32 + Math.cos(a + 0.3) * r, 32 + Math.sin(a + 0.3) * r]], rgba(150, 140, 110), 0.7);
  }
  disc(t, 32, 32, 3.5, rgba(90, 80, 60), 1, 1);
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

const PAINTERS = [
  paintConcrete, paintConcreteCracked, paintSteelPlate, paintSteelRivet,
  paintHazard, paintPipes, paintVent, paintTile,
  paintTileBlood, paintRust, paintSandbag, paintScreens,
  paintCircuit, paintSiloWall, paintWarning, paintDoor,
  paintDoorJamb, paintDoorRed, paintDoorBlue, paintDoorGold,
  paintElevator, paintFlesh, paintFloorConcrete, paintFloorGrate,
  paintFloorTile, paintFloorDirt, paintFloorBlood, paintCeilConcrete,
  paintCeilLamp, paintCeilPipes, paintCeilFlesh, paintFloorDeck,
];

// Everything past the first 32. [name, base, kind, painter, emissive]
//   base   a texture to copy first (null: the painter starts from nothing)
//   kind   'wall' | 'floor' | 'ceil' relights only the dressing; null paints raw
const EXTRA = [
  ['CONCRETE_STAIN', 'CONCRETE', 'wall', vConcreteStain],
  ['CONCRETE_POSTER', 'CONCRETE', 'wall', vConcretePoster],
  ['CONCRETE_GRAFFITI', 'CONCRETE', 'wall', vConcreteGraffiti],
  ['CONCRETE_SIGN', 'CONCRETE', 'wall', vConcreteSign],
  ['CONCRETE_FUSE', 'CONCRETE', 'wall', vConcreteFuse],
  ['CONCRETE_HOLES', 'CONCRETE', 'wall', vConcreteHoles],
  ['CRACKED_BLOOD', 'CONCRETE_CRACKED', 'wall', vCrackedBlood],
  ['CRACKED_REBAR', 'CONCRETE_CRACKED', 'wall', vCrackedRebar],
  ['CRACKED_GRAFFITI', 'CONCRETE_CRACKED', 'wall', vCrackedGraffiti],
  ['OFFICE_WALL', null, null, paintOfficeWall],
  ['OFFICE_EMPLOYEE', 'OFFICE_WALL', 'wall', vOfficeEmployee],
  ['OFFICE_BOARD', 'OFFICE_WALL', 'wall', vOfficeBoard],
  ['OFFICE_CLOCK', 'OFFICE_WALL', 'wall', vOfficeClock],
  ['OFFICE_SAFETY', 'OFFICE_WALL', 'wall', vOfficeSafety],
  ['OFFICE_EXTING', 'OFFICE_WALL', 'wall', vOfficeExting],
  ['OFFICE_CAT', 'OFFICE_WALL', 'wall', vOfficeCat],
  ['OFFICE_PINUP', 'OFFICE_WALL', 'wall', vOfficePinup],
  ['OFFICE_BLOOD', 'OFFICE_WALL', 'wall', vOfficeBlood],
  ['OFFICE_SCUFF', 'OFFICE_WALL', 'wall', vOfficeScuff],
  ['OFFICE_VENT', 'OFFICE_WALL', 'wall', vOfficeVent],
  ['STEEL_SIGN', 'STEEL_PLATE', 'wall', vSteelSign],
  ['STEEL_DENTS', 'STEEL_PLATE', 'wall', vSteelDents],
  ['STEEL_PANEL', 'STEEL_PLATE', 'wall', vSteelPanel],
  ['STEEL_CABLES', 'STEEL_PLATE', 'wall', vSteelCables],
  ['RIVET_HATCH', 'STEEL_RIVET', 'wall', vRivetHatch],
  ['RIVET_RUST', 'STEEL_RIVET', 'wall', vRivetRust],
  ['RIVET_DENTS', 'STEEL_RIVET', 'wall', vRivetDents],
  ['RIVET_GAUGES', 'STEEL_RIVET', 'wall', vRivetGauges],
  ['RIVET_STENCIL', 'STEEL_RIVET', 'wall', vRivetStencil],
  ['HAZARD_SIGN', 'HAZARD', 'wall', vHazardSign],
  ['HAZARD_WORN', 'HAZARD', 'wall', vHazardWorn],
  ['PIPES_VALVE', null, null, vPipesValve],
  ['PIPES_BARE', null, null, vPipesBare],
  ['PIPES_LEAK', 'PIPES', 'wall', vPipesLeak],
  ['PIPES_GAUGE', null, null, vPipesGauge],
  ['VENT_BLOOD', 'VENT', 'wall', vVentBlood],
  ['VENT_EYES', 'VENT', null, vVentEyes],
  ['VENT_FAN', 'VENT', 'wall', vVentFan],
  ['TILE_MIRROR', 'TILE', 'wall', vTileMirror],
  ['TILE_GRAFFITI', 'TILE', 'wall', vTileGraffiti],
  ['TILE_MISSING', 'TILE', 'wall', vTileMissing],
  ['TILE_HAND', 'TILE', 'wall', vTileHand],
  ['TILE_SIGN', 'TILE', 'wall', vTileSign],
  ['TILE_HELP', 'TILE_BLOOD', 'wall', vTileBlood2],
  ['TILE_SPLAT', 'TILE', 'wall', vTileSplat],
  ['RUST_HOLE', 'RUST', 'wall', vRustHole],
  ['RUST_PATCH', 'RUST', 'wall', vRustPatch],
  ['RUST_FURNACE', 'RUST', null, vRustFurnace, 0.45],
  ['SANDBAG_TORN', 'SANDBAG', 'wall', vSandbagTorn],
  ['SANDBAG_HELMET', 'SANDBAG', 'wall', vSandbagHelmet],
  ['SCREENS_BSOD', null, null, vScreensBsod, 1],
  ['SCREENS_FISH', null, null, vScreensFish, 1],
  ['SCREENS_POPUP', null, null, vScreensPopup, 1],
  ['SCREENS_RADAR', null, null, vScreensRadar, 1],
  ['SCREENS_DEAD', null, null, vScreensDead, 1],
  ['SCREENS_TOAST', null, null, vScreensToast, 1],
  ['CIRCUIT_BURNT', 'CIRCUIT', null, vCircuitBurnt, 1],
  ['CIRCUIT_TAPE', null, null, vCircuitTape, 1],
  ['CIRCUIT_B', null, null, vCircuitB, 1],
  ['SILO_13', null, null, vSilo13],
  ['SILO_03', null, null, vSilo03],
  ['SILO_LADDER', 'SILO_WALL', 'wall', vSiloLadder],
  ['SILO_SCORCH', 'SILO_WALL', 'wall', vSiloScorch],
  ['SILO_STAIN', 'SILO_WALL', 'wall', vSiloStain],
  ['WARN_SMOKE', null, null, vWarnSmoke, 0.35],
  ['WARN_INCIDENT', null, null, vWarnIncident, 0.35],
  ['WARN_GLOW', null, null, vWarnGlow, 0.35],
  ['FLESH_EYE', 'FLESH', 'wall', vFleshEye],
  ['FLESH_MOUTH', 'FLESH', 'wall', vFleshMouth],
  ['FLESH_TUMOR', 'FLESH', 'wall', vFleshTumor],
  ['FLESH_FACE', 'FLESH', 'wall', vFleshFace],
  ['SALT_WALL', null, null, paintSaltWall],
  ['SALT_CRYSTAL', 'SALT_WALL', 'wall', vSaltCrystal],
  ['SALT_SHRINE', 'SALT_WALL', 'wall', vSaltShrine, 0.3],
  ['SALT_CRACKED', 'SALT_WALL', 'wall', vSaltCracked],
  ['SALT_BONES', 'SALT_WALL', 'wall', vSaltBones],
  ['LOCKERS', null, null, paintLockers],
  ['LOCKERS_OPEN', null, null, vLockersOpen],
  ['SERVER', null, null, paintServer, 0.3],
  ['SERVER_LABEL', null, null, vServerLabel, 0.3],
  ['SERVER_B', null, null, vServerB, 0.3],
  ['ORGAN_PIPES', null, null, paintOrganPipes],
  ['ORGAN_SING', null, null, vOrganPipes2],
  ['ORGAN_RAMP', null, null, vOrganRamp],
  ['FLOOR_CONCRETE_DRAIN', 'FLOOR_CONCRETE', 'floor', vFloorDrain],
  ['FLOOR_CONCRETE_OIL', 'FLOOR_CONCRETE', 'floor', vFloorOil],
  ['FLOOR_CONCRETE_CRACK', 'FLOOR_CONCRETE', 'floor', vFloorCrack],
  ['FLOOR_CONCRETE_PUDDLE', 'FLOOR_CONCRETE', 'floor', vFloorPuddle],
  ['FLOOR_CONCRETE_RUBBLE', 'FLOOR_CONCRETE', 'floor', vFloorRubble],
  ['FLOOR_CONCRETE_OUTLINE', 'FLOOR_CONCRETE', 'floor', vFloorOutline],
  ['FLOOR_CONCRETE_BUTTS', 'FLOOR_CONCRETE', 'floor', vFloorButts],
  ['FLOOR_KEEPCLEAR', 'FLOOR_CONCRETE', 'floor', vFloorKeepClear],
  ['FLOOR_TILE_MISSING', 'FLOOR_TILE', 'floor', vTileFloorMissing],
  ['FLOOR_TILE_CRACK', 'FLOOR_TILE', 'floor', vTileFloorCrack],
  ['FLOOR_TILE_BLOOD', 'FLOOR_TILE', 'floor', vTileFloorBlood],
  ['FLOOR_TILE_DRAIN', 'FLOOR_TILE', 'floor', vFloorDrain],
  ['FLOOR_GRATE_GLOW', 'FLOOR_GRATE', null, vGrateGlow, 0.2],
  ['FLOOR_DIRT_BONES', 'FLOOR_DIRT', 'floor', vDirtBones],
  ['FLOOR_DIRT_PUDDLE', 'FLOOR_DIRT', 'floor', vDirtPuddle],
  ['FLOOR_DECK_HATCH', 'FLOOR_DECK', 'floor', vDeckHatch],
  ['FLOOR_DECK_OIL', 'FLOOR_DECK', 'floor', vDeckOil],
  ['FLOOR_BLOOD_SMEAR', 'FLOOR_BLOOD', 'floor', vBloodFloor2],
  ['FLOOR_LINO', null, null, paintFloorLino],
  ['FLOOR_LINO_COFFEE', 'FLOOR_LINO', 'floor', vLinoCoffee],
  ['FLOOR_LINO_MISSING', 'FLOOR_LINO', 'floor', vLinoMissing],
  ['FLOOR_LINO_BLOOD', 'FLOOR_LINO', 'floor', vLinoBlood],
  ['FLOOR_LINO_OUTLINE', 'FLOOR_LINO', 'floor', vFloorOutline],
  ['FLOOR_SALT', null, null, paintFloorSalt],
  ['FLOOR_SALT_PUDDLE', 'FLOOR_SALT', 'floor', vSaltFloorPuddle],
  ['FLOOR_RAISED', null, null, paintFloorRaised],
  ['FLOOR_RAISED_OPEN', 'FLOOR_RAISED', 'floor', vRaisedOpen],
  ['FLOOR_SCORCH', null, null, paintFloorScorch],
  ['FLOOR_SCORCH_GRILLE', 'FLOOR_SCORCH', null, vScorchGrille, 0.35],
  ['CEIL_CONCRETE_STAIN', 'CEIL_CONCRETE', 'ceil', vCeilStain],
  ['CEIL_CONCRETE_VENT', 'CEIL_CONCRETE', 'ceil', vCeilVent],
  ['CEIL_CONCRETE_CABLES', 'CEIL_CONCRETE', 'ceil', vCeilCables],
  ['CEIL_PIPES_VENT', 'CEIL_PIPES', 'ceil', vCeilPipesVent],
  ['CEIL_PIPES_LEAK', 'CEIL_PIPES', 'ceil', vCeilPipesLeak],
  ['CEIL_FLESH_TUMOR', 'CEIL_FLESH', 'ceil', vCeilFleshTumor],
  ['CEIL_FLESH_EYE', 'CEIL_FLESH', 'ceil', vCeilFleshEye],
  ['CEIL_OFFICE', null, null, paintCeilOffice],
  ['CEIL_OFFICE_STAIN', 'CEIL_OFFICE', 'ceil', vCeilOfficeStain],
  ['CEIL_OFFICE_MISSING', 'CEIL_OFFICE', 'ceil', vCeilOfficeMissing],
  ['CEIL_TUBE', null, null, paintCeilTube, 1],
  ['CEIL_SALT', null, null, paintCeilSalt],
  ['CEIL_CABLES', null, null, paintCeilCables],
  ['CEIL_LAMP_DEAD', 'CEIL_LAMP', 'ceil', vCeilLampDead],
  ['CEIL_BEAMS', null, null, paintCeilBeams],
  ['CEIL_BEAMS_STAIN', 'CEIL_BEAMS', 'ceil', vCeilBeamsStain],
  ['CEIL_BEAMS_HOLE', 'CEIL_BEAMS', 'ceil', vCeilBeamsHole],
  ['FLOOR_BOARDS', null, null, paintFloorBoards],
  ['FLOOR_BOARDS_HOLE', 'FLOOR_BOARDS', 'floor', vBoardsHole],
  ['FLOOR_BOARDS_BLOOD', 'FLOOR_BOARDS', 'floor', vBoardsBlood],
  ['CEIL_ROOF', null, null, paintCeilRoof],
  ['CEIL_ROOF_B', null, null, vCeilRoofB],
];

export const TEXTURE_ORDER = BASE_ORDER.concat(EXTRA.map((e) => e[0]));
/** Dressed texture -> the material it was painted over (for the seam checks). */
export const TEXTURE_BASE = Object.fromEntries(EXTRA.filter((e) => e[1]).map((e) => [e[0], e[1]]));

/** Build the whole atlas. Deterministic: same pixels every call. */
// Dressed surfaces are painted when a level first asks for them rather than at
// boot: a floor uses forty-odd of them, and painting all hundred-and-some up
// front would add most of a second to a load that is already the slowest part
// of the game. Keyed by atlas so a fallback atlas simply never has any.
const LAZY = new WeakMap();

/**
 * Build the atlas. The original 32 are painted now; everything past them is
 * painted on demand by ensureTextures(), or now with { all: true }.
 * Deterministic either way: each painter owns its seeds, so order is irrelevant.
 */
export function buildTextures(opt = {}) {
  const count = TEXTURE_ORDER.length;
  const atlas = new Uint32Array(count * AREA);
  const emissive = new Float32Array(count);
  const painted = new Uint8Array(count);
  const slot = (i) => atlas.subarray(i * AREA, (i + 1) * AREA);
  const seal = (t) => { for (let k = 0; k < AREA; k++) t[k] = (t[k] | 0xff000000) >>> 0; };  // walls are never see-through
  for (let i = 0; i < BASE_ORDER.length; i++) {
    emissive[i] = EMISSIVE_TABLE[BASE_ORDER[i]] || 0;
    PAINTERS[i](slot(i));
    seal(slot(i));
    painted[i] = 1;
  }
  const paint = (i) => {
    if (i < 0 || i >= count || painted[i]) return;
    painted[i] = 1;
    const [, base, kind, painter] = EXTRA[i - BASE_ORDER.length];
    const t = slot(i);
    const b = base ? TEXTURE_ORDER.indexOf(base) : -1;
    if (b >= 0) { paint(b); t.set(slot(b)); }
    try {
      if (kind) dress(t, kind, 0x5eed + i * 131, painter);
      else painter(t);
    } catch (e) {
      // A dressing that throws falls back to its bare material, never to black.
      if (b >= 0) t.set(slot(b)); else t.fill(0xff404040);
    }
    seal(t);
  };
  for (let k = 0; k < EXTRA.length; k++) {
    const i = BASE_ORDER.length + k;
    emissive[i] = EXTRA[k][4] || 0;
    if (opt.all) paint(i);
  }
  LAZY.set(atlas, paint);
  return { atlas, count, names: TEXTURE_ORDER, emissive };
}

/** Paint any of these atlas slots that have not been painted yet. */
export function ensureTextures(atlas, indices) {
  const paint = atlas && LAZY.get(atlas);
  if (!paint) return;
  for (const i of indices) paint(i);
}
