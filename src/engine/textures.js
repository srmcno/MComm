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

export const TEXTURE_ORDER = [
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
function paintPipes(t) {
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
  for (let j = -13; j <= 13; j++) {
    for (let i = -13; i <= 13; i++) {
      const d = Math.hypot(i, j);
      if (d > 12.4 || d < 9.2) continue;
      const u = (d - 10.8) / 1.6;
      const lam = clamp(cyl(u) * 0.7 + 0.3 - j * 0.02 - i * 0.012, 0, 1);
      blendPx(t, vx + i, vy + j, mix(mul(rgba(150, 52, 40), 0.5), rgba(206, 96, 74), lam), 1);
    }
  }
  for (let k = 0; k < 5; k++) {
    const a = k * (6.283 / 5) - 0.4;
    segment(t, vx, vy, vx + Math.cos(a) * 11, vy + Math.sin(a) * 11, rgba(168, 62, 46), 2.1, 1);
    segment(t, vx - 0.5, vy - 0.6, vx + Math.cos(a) * 10, vy + Math.sin(a) * 10 - 0.6, rgba(214, 108, 84), 0.9, 0.55);
  }
  disc(t, vx, vy, 3.4, rgba(120, 44, 34), 1, 1);
  rivet(t, vx, vy, 2.2, C.spec);
  glow(t, vx + 2, vy + 3, 16, BLACK, 0.28, 1.6);
  drip(t, 5301, 16, 51, 63, mul(C.rustDk, 1.1), 0.5, 1.6);
  drip(t, 5302, 33, 19, 44, mul(C.rustDk, 0.9), 0.35, 1.2);
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
function paintCircuit(t) {
  const board = rgba(16, 34, 26);
  fill(t, board);
  const weaveF = field(12101, 24, 2);
  const blot = field(12111, 5, 3);
  for (let i = 0; i < AREA; i++) {
    t[i] = mul(mix(t[i], rgba(24, 48, 34), blot[i] * 0.7), 0.86 + weaveF[i] * 0.28);
  }
  const trace = rgba(72, 132, 92), traceHi = rgba(110, 186, 128), copper = rgba(168, 122, 54);
  const rng = makeRng(12133);
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
  chip(12, 12, 20, 11, 'mu');
  chip(38, 40, 17, 9, null);
  chip(8, 44, 14, 9, null);
  for (let i = 0; i < 7; i++) rect(t, 2 + i * 9, 60, 6, 4, copper, 0.9);   // edge fingers
  const nodes = [[48, 10, C.cyan], [56, 22, C.cyan], [30, 34, C.amber], [20, 27, C.cyan], [44, 56, C.amber], [10, 34, C.cyan], [58, 46, C.cyan]];
  for (const [x, y, col] of nodes) {
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
function paintSiloWall(t) {
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
  drawTextCentered(t, '07', 32, 22, 3, mul(C.yellow, 0.94), { shadow: true, shadowAlpha: 0.45 });
  drawTextCentered(t, 'silo', 32, 44, 1, mul(C.yellow, 0.8), { alpha: 0.85 });
  chipBack(t, snap, 13177, 9, 0.62, 0.7, 4);
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
        let c = mix(mul(col, 0.42), mul(col, 1.25), lam);
        if (dy / R > -0.72 && dy / R < -0.3) c = mix(c, C.specHot, 0.28);
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
        let c = mix(mul(C.steelDk, 1.05), C.spec, lam * 0.95);
        c = mix(mul(C.steelDk, 0.8), c, 0.3 + rim * 0.7);
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
  edgeRust(t, 31233, 0.4, { top: 0.15, bot: 0.35, side: 0.15 });
  const grimeF = field(31199, 5, 4);
  for (let i = 0; i < AREA; i++) t[i] = mix(t[i], mul(C.dirtDk, 1.05), clamp((grimeF[i] - 0.55) * 2.4, 0, 1) * 0.4);
  speckle(t, 31200, 60, mul(C.dirtDk, 1.1), 0.12, 0.32, 0.8);
  edgeDark(t, 0.2, 3);
  grain(t, 31247, 0.055);
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

/** Build the whole atlas. Deterministic: same pixels every call. */
export function buildTextures() {
  const count = TEXTURE_ORDER.length;
  const atlas = new Uint32Array(count * AREA);
  const emissive = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const name = TEXTURE_ORDER[i];
    emissive[i] = EMISSIVE_TABLE[name] || 0;
    const t = atlas.subarray(i * AREA, (i + 1) * AREA);
    PAINTERS[i](t);
    for (let k = 0; k < AREA; k++) t[k] = (t[k] | 0xff000000) >>> 0;   // walls are never see-through
  }
  return { atlas, count, names: TEXTURE_ORDER, emissive };
}
