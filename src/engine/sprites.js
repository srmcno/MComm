// sprites.js - procedural sprite generator for NUKEHAUS.
//
// Everything here is built from a tiny 3D skeleton + a parametric humanoid
// painter, so the whole cast is lit consistently (key light upper-left, toward
// the viewer, a cool rim from behind-right) and animates coherently. No binary
// assets, no DOM, deterministic.
//
// Body space: bx = the character's own RIGHT, by = up from the floor (feet at
// 0), bz = the direction it is facing. Facing D rotates that space around the
// vertical axis: 0 front, 1 its right side, 2 back, 3 its left side.
//
// The walking cast is authored in design units (the old 64x72 grid) and
// painted at K pixels per unit. The renderer maps a frame's full height to the
// enemy's world height whatever its pixel size, so K buys detail, not size.
//
// Dismemberment: every humanoid and quadruped frame is painted by a recipe
// that takes a mask of missing parts (1 head, 2 armR, 4 armL, 8 legR, 16 legL,
// the character's own right and left). buildSprites() returns maim(), which
// re-runs a recipe with a mask on demand and keeps the result in a bounded
// cache, and rig, the joint heights the gore code needs to launch the parts.

import {
  rgba, mix, shade, clamp, lerp, makeRng, makeNoise, fbm,
  makeFrame, getpx, fillRect, fillCircle, line, mirrorX, outline,
} from '../core/pixels.js';

// ---------------------------------------------------------------------------
// paint order: which part of a figure laid each pixel down
// ---------------------------------------------------------------------------

// While a figure is being assembled, every plot also records the index of the
// part doing the plotting. The contact-shadow pass reads it back to find where
// a nearer part overhangs a farther one, which is most of what makes a pile of
// capsules look like a body with an arm in front of it.
let ORD = new Uint8Array(0), ORD_F = null, CUR_ORD = 0;

/** pixels.js px(), plus the paint-order record for the figure in progress. */
function px(frame, x, y, c) {
  x |= 0; y |= 0;
  if (x < 0 || y < 0 || x >= frame.w || y >= frame.h) return;
  const i = y * frame.w + x;
  frame.data[i] = c;
  if (frame === ORD_F) ORD[i] = CUR_ORD;
}

function beginOrder(f) {
  const n = f.w * f.h;
  if (ORD.length < n) ORD = new Uint8Array(n);
  else ORD.fill(0, 0, n);
  ORD_F = f; CUR_ORD = 0;
}

const SHADOW = rgba(14, 10, 26, 255);

/**
 * Contact shadows and ambient occlusion from the paint order: a pixel sitting
 * just below and right of a part drawn over it (the key light is up and to the
 * left) is in that part's shadow, and anything butted right up against a
 * nearer part gets a thin occlusion line. Ends the paint-order record.
 */
function contactShadow(f, k, strength = 0.5) {
  const { w, h, data } = f;
  const R = Math.max(2, Math.round(2.2 * k));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const a = ORD[i];
      if (!a || !(data[i] >>> 24)) continue;
      let occ = 0;
      for (let d = 1; d <= R; d++) {
        const qx = x - ((d * 0.6 + 0.5) | 0), qy = y - d;
        if (qx < 0 || qy < 0) break;
        const q = qy * w + qx;
        if (!(data[q] >>> 24)) break;
        if (ORD[q] > a) { occ = 1 - (d - 1) / (R + 1); break; }
      }
      if (occ < 0.5) {
        if ((x > 0 && ORD[i - 1] > a) || (x + 1 < w && ORD[i + 1] > a) ||
            (y > 0 && ORD[i - w] > a) || (y + 1 < h && ORD[i + w] > a)) occ = Math.max(occ, 0.5);
      }
      if (occ > 0) data[i] = mix(data[i], SHADOW, occ * strength);
    }
  }
  ORD_F = null;
}

// ---------------------------------------------------------------------------
// colour / shading
// ---------------------------------------------------------------------------

const INK = rgba(7, 5, 10, 255);          // outline black
const COOL = rgba(24, 22, 48, 255);       // shadow tint
const WARM = rgba(255, 242, 212, 255);    // key light tint
const RIM = rgba(150, 196, 255, 255);     // back light: cool, from behind-right

/** Pixels per design unit for the walking cast. */
const K = 1.5;

// Key light, in screen space: upper-left, leaning toward the camera.
const LX = -0.52, LY = -0.66, LZ = 0.54;
// Half-vector between the key light and the eye, for specular glints.
const HX = -0.296, HY = -0.376, HZ = 0.878;

/** Deterministic per-pixel hash, for grain and dithering. */
function hash2(x, y, s) {
  let h = (Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 2147483647)) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Smooth value noise straight off hash2, two octaves, 0..1. fbm() is lovely
 * but keys a cache with a string per call, which is too slow for anything a
 * maimed frame repaints on demand.
 */
function vnoise(seed, x, y) {
  let sum = 0, amp = 0.66, tot = 0;
  for (let o = 0; o < 2; o++) {
    const xi = Math.floor(x), yi = Math.floor(y);
    let xf = x - xi, yf = y - yi;
    xf = xf * xf * (3 - 2 * xf); yf = yf * yf * (3 - 2 * yf);
    const s = seed + o * 977;
    const a = hash2(xi, yi, s), b = hash2(xi + 1, yi, s), c = hash2(xi, yi + 1, s), d = hash2(xi + 1, yi + 1, s);
    sum += amp * (a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf);
    tot += amp; amp *= 0.5; x *= 2.03; y *= 2.03;
  }
  return sum / tot;
}

/** Five-step shading ramp for one material: [deep, dark, base, lit, hot]. */
function mat(base, o = {}) {
  const k = o.contrast === undefined ? 1 : o.contrast;
  const sh = o.shadow || COOL, li = o.light || WARM;
  return [
    mix(shade(base, 0.30), sh, 0.42 * k),
    mix(shade(base, 0.56), sh, 0.20 * k),
    base,
    mix(base, li, 0.20 * k),
    mix(base, li, 0.46 * k),
  ];
}

/** Flat ramp - same colour at every band (for lenses, glass, decals). */
function flat(c) { return [c, c, c, c, c]; }

/** Push a whole ramp darker/lighter without rebuilding it. */
function dimRamp(r, t) { return r.map((c) => mix(c, COOL, t)); }

function band(l) {
  return l < 0.13 ? 0 : l < 0.33 ? 1 : l < 0.57 ? 2 : l < 0.79 ? 3 : 4;
}

function lamOf(nx, ny, nz) { return clamp(nx * LX + ny * LY + nz * LZ, 0, 1); }

/** Blend a colour over an already-opaque pixel; never paints on empty space. */
function over(f, x, y, c, t) {
  const d = getpx(f, x, y);
  if (d >>> 24) px(f, x, y, t >= 1 ? c : mix(d, c, t));
}

/** Blend over the whole opaque silhouette (hit flash, scorching, fade). */
function wash(f, c, t, pred) {
  for (let y = 0; y < f.h; y++) {
    for (let x = 0; x < f.w; x++) {
      const d = f.data[y * f.w + x];
      if (!(d >>> 24)) continue;
      if (pred && !pred(x, y)) continue;
      f.data[y * f.w + x] = mix(d, c, t);
    }
  }
}

/**
 * Radial glow. Writes opaque pixels (alpha is only ever 0 or 255) - over the
 * body it tints, off the body it lays down a dithered halo that fades out.
 */
function glow(f, cx, cy, r, c, o = {}) {
  const seed = o.seed || 3, halo = o.halo === undefined ? 1 : o.halo;
  const base = o.base || rgba(20, 12, 10, 255);
  const core = o.core === undefined ? 0.32 : o.core;
  const tint = o.tint === undefined ? 1.15 : o.tint;
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      const d = Math.hypot(x - cx, y - cy) / r;
      if (d > 1) continue;
      let t = Math.pow(1 - d, 1.7);
      const dst = getpx(f, x, y);
      if (dst >>> 24) {
        px(f, x, y, mix(dst, c, clamp(t * tint, 0, 1)));
      } else if (halo) {
        if (t < core && hash2(x, y, seed) > t * 2.1) continue;
        px(f, x, y, mix(base, c, clamp(t * halo, 0, 1)));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// shaded primitives
// ---------------------------------------------------------------------------

/**
 * Capsule between two screen points, lit like a cylinder with round caps.
 * `spec` paints a hard glint where the surface faces the light's half-vector.
 */
function capsule(f, x0, y0, x1, y1, r0, r1, ramp, o = {}) {
  if (o.edge !== undefined) {
    const ew = o.edgeW === undefined ? 1.0 : o.edgeW;
    capsule(f, x0, y0, x1, y1, r0 + ew, r1 + ew, flat(o.edge), { hole: ew });
  }
  const shift = o.shift || 0, grain = o.grain || 0, seed = o.seed || 11, hole = o.hole || 0;
  const spec = o.spec, specT = o.specT || 0.965;
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1e-4;
  const ux = dx / len, uy = dy / len, pxx = -uy, pyy = ux;
  const rm = Math.max(r0, r1) + 1.5;
  const ax0 = Math.floor(Math.min(x0, x1) - rm), ax1 = Math.ceil(Math.max(x0, x1) + rm);
  const ay0 = Math.floor(Math.min(y0, y1) - rm), ay1 = Math.ceil(Math.max(y0, y1) + rm);
  for (let y = ay0; y <= ay1; y++) {
    for (let x = ax0; x <= ax1; x++) {
      let t = ((x - x0) * ux + (y - y0) * uy) / len;
      t = clamp(t, 0, 1);
      const cxp = x0 + dx * t, cyp = y0 + dy * t;
      const ex = x - cxp, ey = y - cyp;
      const r = lerp(r0, r1, t);
      const d2 = ex * ex + ey * ey;
      if (d2 > r * r) continue;
      if (hole && r > hole && d2 < (r - hole) * (r - hole)) continue;
      const sp = (ex * pxx + ey * pyy) / r;
      const sa = (ex * ux + ey * uy) / r;
      const nx = pxx * sp + ux * sa, ny = pyy * sp + uy * sa;
      const nz = Math.sqrt(Math.max(0, 1 - sp * sp - sa * sa));
      if (spec && nx * HX + ny * HY + nz * HZ > specT) { px(f, x, y, spec); continue; }
      let b = band(lamOf(nx, ny, nz)) + shift;
      if (grain && hash2(x, y, seed) < grain) b -= 1;
      px(f, x, y, ramp[clamp(b | 0, 0, 4)]);
    }
  }
}

/**
 * Shaded ellipse. mode 'sphere' shades like a ball, 'cyl' like a slice of a
 * vertical cylinder (so stacking slices into a torso gives no banding).
 */
function blob(f, cx, cy, rx, ry, ramp, o = {}) {
  if (o.edge !== undefined) {
    const ew = o.edgeW === undefined ? 1.0 : o.edgeW;
    blob(f, cx, cy, rx + ew, ry + ew, flat(o.edge), { mode: o.mode, nyBias: o.nyBias, rot: o.rot, sy: o.sy, hole: ew });
  }
  const hole = o.hole || 0;
  const hx = hole ? rx / Math.max(0.01, rx - hole) : 0, hy = hole ? ry / Math.max(0.01, ry - hole) : 0;
  const shift = o.shift || 0, grain = o.grain || 0, seed = o.seed || 5;
  const spec = o.spec, specT = o.specT || 0.965;
  const cyl = o.mode === 'cyl';
  const nyB = o.nyBias === undefined ? -0.16 : o.nyBias;
  const rxs = Math.max(rx, 0.5), rys = Math.max(ry, 0.5);
  // rotated and/or squashed: sample in the ellipse's own frame, light in screen space
  const rot = o.rot || 0, isy = 1 / (o.sy || 1);
  const cr = Math.cos(rot), sr = Math.sin(rot);
  const turned = rot !== 0 || isy !== 1;
  const bx = turned ? Math.max(rxs, rys) : rxs, by = turned ? Math.max(rxs, rys) : rys;
  for (let y = Math.floor(cy - by); y <= Math.ceil(cy + by); y++) {
    for (let x = Math.floor(cx - bx); x <= Math.ceil(cx + bx); x++) {
      let u, v;
      if (turned) {
        const dx = x - cx, dy = (y - cy) * isy;
        u = (dx * cr + dy * sr) / rxs; v = (-dx * sr + dy * cr) / rys;
      } else { u = (x - cx) / rxs; v = (y - cy) / rys; }
      if (u * u + v * v > 1.0) continue;
      if (hole && rx > hole && ry > hole && (u * hx) * (u * hx) + (v * hy) * (v * hy) < 1) continue;
      let nx, ny, nz;
      if (cyl) { nx = u; ny = nyB; nz = Math.sqrt(Math.max(0, 1 - u * u - ny * ny)); }
      else { nx = u; ny = v; nz = Math.sqrt(Math.max(0, 1 - u * u - v * v)); }
      if (turned) { const tx = nx * cr - ny * sr; ny = nx * sr + ny * cr; nx = tx; }
      if (spec && nx * HX + ny * HY + nz * HZ > specT) { px(f, x, y, spec); continue; }
      let b = band(lamOf(nx, ny, nz)) + shift;
      if (grain && hash2(x, y, seed) < grain) b -= 1;
      px(f, x, y, ramp[clamp(b | 0, 0, 4)]);
    }
  }
}

/** Axis-aligned shaded box: lit top and left, dark bottom and right. */
function box(f, x, y, w, h, ramp, o = {}) {
  const shift = o.shift || 0, grain = o.grain || 0, seed = o.seed || 17;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let b = 2;
      if (j === 0) b = 4; else if (j === 1) b = 3;
      else if (j >= h - 1) b = 0; else if (j >= h - 2) b = 1;
      if (i === 0) b = Math.min(4, b + 1); else if (i >= w - 1) b = Math.max(0, b - 1);
      b += shift;
      if (grain && hash2(x + i, y + j, seed) < grain) b -= 1;
      px(f, x + i, y + j, ramp[clamp(b | 0, 0, 4)]);
    }
  }
}

/** Sprinkle flecks (rust, scorch, dirt) inside the existing silhouette. */
function speckle(f, x0, y0, w, h, c, density, seed, t = 1) {
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      if (hash2(x0 + i, y0 + j, seed) < density) over(f, x0 + i, y0 + j, c, t);
    }
  }
}

/** Brighten the topmost opaque pixel of every column - a global sky/top light. */
function topRim(f, c, t0 = 0.3, t1 = 0.12) {
  for (let x = 0; x < f.w; x++) {
    for (let y = 0; y < f.h; y++) {
      if (f.data[y * f.w + x] >>> 24) {
        over(f, x, y, c, t0);
        if (t1) over(f, x, y + 1, c, t1);
        break;
      }
    }
  }
}

/**
 * Back light: every opaque pixel with empty space to its right catches a cool
 * rim. It is what separates a dark figure from a dark corridor.
 */
function sideRim(f, c, t0 = 0.34, t1 = 0.12) {
  const { w, h, data } = f;
  for (let y = 0; y < h; y++) {
    for (let x = w - 1; x >= 0; x--) {
      if (!(data[y * w + x] >>> 24)) continue;
      if (x + 1 < w && (data[y * w + x + 1] >>> 24)) continue;
      const up = y > 0 && !(data[(y - 1) * w + x] >>> 24);
      data[y * w + x] = mix(data[y * w + x], c, up ? t0 * 1.25 : t0);
      if (t1 && x > 0 && (data[y * w + x - 1] >>> 24)) data[y * w + x - 1] = mix(data[y * w + x - 1], c, t1);
    }
  }
}

/** Darken the bottom-most opaque pixel of every column. */
function underShade(f, c, t0 = 0.4, t1 = 0.18) {
  for (let x = 0; x < f.w; x++) {
    for (let y = f.h - 1; y >= 0; y--) {
      if (f.data[y * f.w + x] >>> 24) {
        over(f, x, y, c, t0);
        if (t1) over(f, x, y - 1, c, t1);
        break;
      }
    }
  }
}

/** Dashed line: stitching, zips, cable ties. Only paints over the body. */
function stitch(f, x0, y0, x1, y1, c, t = 1, on = 1, off = 1) {
  const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
  for (let i = 0; i <= n; i++) {
    if ((i % (on + off)) >= on) continue;
    over(f, x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n, c, t);
  }
}

/** Scanline polygon fill. */
function fillPoly(f, pts, c) {
  let miny = 1e9, maxy = -1e9;
  for (const p of pts) { if (p.y < miny) miny = p.y; if (p.y > maxy) maxy = p.y; }
  for (let y = Math.floor(miny); y <= Math.ceil(maxy); y++) {
    const xs = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) xs.push(a.x + (y - a.y) / (b.y - a.y) * (b.x - a.x));
    }
    xs.sort((u, v) => u - v);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      for (let x = Math.floor(xs[i]); x <= Math.ceil(xs[i + 1]); x++) px(f, x, y, c);
    }
  }
}

/**
 * A pen bound to a frame, an origin and a scale: every coordinate and radius
 * it takes is in design units relative to the origin, so a head or a prop can
 * be painted at any pixel density. `fx` = -1 mirrors it for the other profile.
 */
function pen(f, ox, oy, k, fx = 1, rot = 0, sy = 1) {
  const X = (dx) => ox + dx * k * fx, Y = (dy) => oy + dy * k;
  const cr = Math.cos(rot), sr = Math.sin(rot);
  const turned = rot !== 0 || sy !== 1;
  const pt = turned
    ? (dx, dy) => { const a = dx * k * fx, b = dy * k; return [ox + a * cr - b * sr, oy + (a * sr + b * cr) * sy]; }
    : (dx, dy) => [X(dx), Y(dy)];
  const bo = (o) => (turned ? { ...(o || {}), rot, sy } : o);
  return {
    f, k, X, Y, pt,
    blob: (dx, dy, rx, ry, ramp, o) => { const p = pt(dx, dy); blob(f, p[0], p[1], rx * k, ry * k, ramp, bo(o)); },
    cap: (x0, y0, x1, y1, r0, r1, ramp, o) => { const a = pt(x0, y0), b = pt(x1, y1); capsule(f, a[0], a[1], b[0], b[1], r0 * k, r1 * k, ramp, o); },
    glow: (dx, dy, r, c, o) => { const p = pt(dx, dy); glow(f, p[0], p[1], r * k, c, o); },
    dot: (dx, dy, c) => { const p = pt(dx, dy); px(f, Math.round(p[0]), Math.round(p[1]), c); },
    over: (dx, dy, c, t) => { const p = pt(dx, dy); over(f, Math.round(p[0]), Math.round(p[1]), c, t); },
    line: (x0, y0, x1, y1, c) => { const a = pt(x0, y0), b = pt(x1, y1); line(f, Math.round(a[0]), Math.round(a[1]), Math.round(b[0]), Math.round(b[1]), c); },
    stitch: (x0, y0, x1, y1, c, t, on, off) => { const a = pt(x0, y0), b = pt(x1, y1); stitch(f, a[0], a[1], b[0], b[1], c, t, on, off); },
    rect: (dx, dy, w, h, c) => {
      if (turned) {
        const q = [pt(dx, dy), pt(dx + w, dy), pt(dx + w, dy + h), pt(dx, dy + h)];
        fillPoly(f, q.map((p) => ({ x: p[0], y: p[1] })), c);
        return;
      }
      const xa = X(dx), xb = X(dx + w);
      fillRect(f, Math.round(Math.min(xa, xb)), Math.round(Y(dy)),
        Math.max(1, Math.round(Math.abs(xb - xa))), Math.max(1, Math.round(h * k)), c);
    },
    poly: (pts, c) => fillPoly(f, pts.map((p) => { const q = pt(p[0], p[1]); return { x: q[0], y: q[1] }; }), c),
  };
}

// ---------------------------------------------------------------------------
// 3x5 stencil font, for crate markings and bulkhead plates
// ---------------------------------------------------------------------------

const GLYPH = {
  A: [2, 5, 7, 5, 5], B: [6, 5, 6, 5, 6], C: [3, 4, 4, 4, 3], D: [6, 5, 5, 5, 6],
  E: [7, 4, 6, 4, 7], F: [7, 4, 6, 4, 4], G: [3, 4, 5, 5, 3], H: [5, 5, 7, 5, 5],
  I: [7, 2, 2, 2, 7], J: [1, 1, 1, 5, 2], K: [5, 5, 6, 5, 5], L: [4, 4, 4, 4, 7],
  M: [5, 7, 7, 5, 5], N: [5, 7, 7, 7, 5], O: [2, 5, 5, 5, 2], P: [6, 5, 6, 4, 4],
  Q: [2, 5, 5, 7, 3], R: [6, 5, 6, 5, 5], S: [3, 4, 2, 1, 6], T: [7, 2, 2, 2, 2],
  U: [5, 5, 5, 5, 3], V: [5, 5, 5, 5, 2], W: [5, 5, 7, 7, 5], X: [5, 5, 2, 5, 5],
  Y: [5, 5, 2, 2, 2], Z: [7, 1, 2, 4, 7], '0': [7, 5, 5, 5, 7], '1': [2, 6, 2, 2, 7],
  '2': [6, 1, 2, 4, 7], '3': [6, 1, 2, 1, 6], '4': [5, 5, 7, 1, 1], '5': [7, 4, 6, 1, 6],
  '6': [3, 4, 7, 5, 7], '7': [7, 1, 2, 2, 2], '8': [7, 5, 7, 5, 7], '9': [7, 5, 7, 1, 6],
  '-': [0, 0, 7, 0, 0], '.': [0, 0, 0, 0, 2], '/': [1, 1, 2, 4, 4], ' ': [0, 0, 0, 0, 0],
  ':': [0, 2, 0, 2, 0], '(': [1, 2, 2, 2, 1], ')': [4, 2, 2, 2, 4], '!': [2, 2, 2, 0, 2],
  '?': [6, 1, 2, 0, 2], '>': [4, 2, 1, 2, 4], '<': [1, 2, 4, 2, 1],
};

function stencil(f, x, y, text, c, t = 1) {
  let cx = x;
  for (const ch of text.toUpperCase()) {
    const g = GLYPH[ch] || GLYPH[' '];
    for (let j = 0; j < 5; j++) {
      for (let i = 0; i < 3; i++) {
        if (g[j] & (4 >> i)) { if (t >= 1) px(f, cx + i, y + j, c); else over(f, cx + i, y + j, c, t); }
      }
    }
    cx += 4;
  }
  return cx;
}

// ---------------------------------------------------------------------------
// tiny 3D vector helpers + two-bone IK
// ---------------------------------------------------------------------------

const V = (x, y, z) => ({ x, y, z });
const vadd = (a, b) => V(a.x + b.x, a.y + b.y, a.z + b.z);
const vsub = (a, b) => V(a.x - b.x, a.y - b.y, a.z - b.z);
const vmul = (a, s) => V(a.x * s, a.y * s, a.z * s);
const vdot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const vlen = (a) => Math.hypot(a.x, a.y, a.z);
const vnorm = (a) => { const l = vlen(a) || 1e-6; return vmul(a, 1 / l); };

/**
 * Two-bone IK. Returns {joint, end} - `end` is the reachable target (clamped
 * when the limb is too short), so hands and feet stay welded to the bones.
 */
function ik(A, T, l1, l2, pole) {
  let d = vsub(T, A);
  let dist = vlen(d);
  const maxd = (l1 + l2) * 0.998, mind = Math.abs(l1 - l2) + 0.05;
  if (dist < 1e-4) { d = V(0, -1, 0); dist = 1; }
  if (dist > maxd) { d = vmul(vnorm(d), maxd); dist = maxd; }
  if (dist < mind) { d = vmul(vnorm(d), mind); dist = mind; }
  const u = vmul(d, 1 / dist);
  let p = vsub(pole, vmul(u, vdot(pole, u)));
  if (vlen(p) < 1e-4) p = V(0, 0, 1);
  p = vnorm(p);
  const a = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  return { joint: vadd(A, vadd(vmul(u, a), vmul(p, h))), end: vadd(A, d) };
}

/** Pitch a point about the hip in the sagittal plane (leaning the torso). */
function leanPt(p, hipY, ang) {
  const dy = p.y - hipY, dz = p.z;
  return V(p.x, hipY + dy * Math.cos(ang) - dz * Math.sin(ang), dz * Math.cos(ang) + dy * Math.sin(ang));
}

// ---------------------------------------------------------------------------
// gore: stumps, drips, pools. Cartoon-bright on purpose: a severed arm should
// read as a joke from across the room, not as a medical photograph.
// ---------------------------------------------------------------------------

const GORE = {
  meat: mat(rgba(206, 30, 38, 255), { contrast: 1.35 }),
  deep: rgba(92, 6, 16, 255),
  ring: rgba(150, 14, 26, 255),
  hi: rgba(255, 150, 136, 255),
  bone: mat(rgba(240, 232, 208, 255), { contrast: 1.2 }),
  marrow: rgba(172, 44, 48, 255),
  blood: rgba(178, 16, 28, 255),
  bloodD: rgba(104, 8, 18, 255),
  fat: rgba(248, 222, 150, 255),
};

/** A hanging drip with a bead on the end. */
function drip(f, x, y, len, c, bead = 1.4) {
  for (let i = 0; i < len; i++) px(f, x, y + i, mix(c, INK, 0.15 + 0.35 * (i / len)));
  blob(f, x, y + len, bead, bead * 1.25, flat(c));
  px(f, x - 1, y + len - 1, mix(c, rgba(255, 220, 210, 255), 0.5));
}

/**
 * The business end of a missing limb. (x0,y0) is the joint, (dx,dy) the unit
 * screen direction the limb used to point, r its radius in pixels. Paints a
 * short stub of the limb's own material, a torn cloth fringe, the cut face (a
 * dark ring, bright meat, a white bone nub) and a couple of drips.
 */
function stump(f, x0, y0, dx, dy, r, ramp, o = {}) {
  const seed = o.seed || 71;
  const len = o.len === undefined ? r * 0.9 : o.len;
  const L = Math.hypot(dx, dy) || 1;
  const ux = dx / L, uy = dy / L, nx = -uy, ny = ux;
  const ex = x0 + ux * len, ey = y0 + uy * len;
  if (len > 0.5) capsule(f, x0, y0, ex, ey, r, r * 0.96, ramp, { shift: o.shift || 0, edge: o.edge, edgeW: 0.9 });
  // torn fringe: ragged teeth of the material poking past the cut
  if (o.fringe !== false) {
    const nT = Math.max(3, Math.round(r * 1.1));
    for (let i = 0; i < nT; i++) {
      const s = -1 + (2 * (i + 0.5)) / nT;
      const tl = r * (0.25 + 0.55 * hash2(i, seed, 3));
      const bx = ex + nx * s * r * 0.92, by = ey + ny * s * r * 0.92;
      line(f, Math.round(bx), Math.round(by), Math.round(bx + ux * tl), Math.round(by + uy * tl), ramp[i % 2 ? 1 : 3]);
    }
  }
  // the cut face: an ellipse across the limb, seen a little from the side
  const ra = r * 1.0, rb = Math.max(1.1, r * (o.flat === undefined ? 0.55 : o.flat));
  const fx = ex + ux * rb * 0.35, fy = ey + uy * rb * 0.35;
  const bb = Math.ceil(ra + 1);
  for (let y = Math.floor(fy - bb); y <= Math.ceil(fy + bb); y++) {
    for (let x = Math.floor(fx - bb); x <= Math.ceil(fx + bb); x++) {
      const qx = x - fx, qy = y - fy;
      const a = (qx * nx + qy * ny) / ra, b = (qx * ux + qy * uy) / rb;
      const d = a * a + b * b;
      if (d > 1) continue;
      let c = d > 0.62 ? GORE.ring : (a - b < -0.3 ? GORE.meat[3] : GORE.meat[2]);
      if (d > 0.9) c = GORE.deep;
      if (d < 0.62 && hash2(x, y, seed) < 0.12) c = GORE.meat[1];
      px(f, x, y, c);
    }
  }
  // fat layer glint and the bone
  over(f, fx - nx * ra * 0.7 - ux * rb * 0.3, fy - ny * ra * 0.7 - uy * rb * 0.3, GORE.hi, 0.8);
  const br = Math.max(0.9, r * (o.bone === undefined ? 0.36 : o.bone));
  const bx = fx + ux * br * 0.9, by = fy + uy * br * 0.9;
  capsule(f, fx, fy, bx, by, br, br * 1.08, GORE.bone, {});
  blob(f, bx, by, br * 1.15, br * 1.15, GORE.bone, { shift: 1 });
  px(f, Math.round(bx - br * 0.4), Math.round(by - br * 0.4), rgba(255, 255, 250, 255));
  if (br > 1.3) px(f, Math.round(bx + br * 0.2), Math.round(by + br * 0.1), GORE.marrow);
  // drips from the lowest edge of the cut
  if (o.drips !== 0) {
    const n = o.drips || 2;
    for (let i = 0; i < n; i++) {
      const s = (i - (n - 1) / 2) * 0.8;
      const lx = fx + nx * s * ra * 0.7, ly = fy + Math.abs(ny) * ra * 0.5 + rb * 0.5;
      drip(f, Math.round(lx), Math.round(ly), Math.round(2 + hash2(i, seed, 9) * r * 1.4), GORE.blood, Math.max(0.8, r * 0.18));
    }
  }
}

/** Splattered gore under a dying or dead body. */
function gorePool(f, cx, cy, rx, ry, seed, o = {}) {
  const dark = o.dark || rgba(70, 6, 14, 255);
  const mid = o.mid || rgba(128, 12, 22, 255);
  const lit = o.lit || rgba(176, 28, 34, 255);
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const u = (x - cx) / rx, v = (y - cy) / ry;
      const d = Math.hypot(u, v);
      const wob = 0.78 + vnoise(seed, x * 0.15, y * 0.3) * 0.44;
      if (d > wob) continue;
      px(f, x, y, d > wob * 0.8 ? dark : (hash2(x, y, seed + 1) < 0.16 ? lit : mid));
    }
  }
  for (let i = 0; i < (o.spots || 12); i++) {
    const a = hash2(i, seed, 3) * 6.28, r = (1.05 + hash2(i, seed, 4) * 0.5) * rx;
    px(f, cx + Math.cos(a) * r, cy + Math.sin(a) * r * (ry / rx) * 1.4, hash2(i, seed, 5) < 0.4 ? mid : dark);
  }
  // cartoon wet glints
  for (let i = 0; i < (o.glints === undefined ? 3 : o.glints); i++) {
    const gx = cx + (hash2(i, seed, 6) - 0.5) * rx, gy = cy - ry * 0.3 + (hash2(i, seed, 7) - 0.5) * ry * 0.5;
    over(f, gx, gy, GORE.hi, 0.55);
    over(f, gx + 1, gy, GORE.hi, 0.3);
  }
}

// ---------------------------------------------------------------------------
// the humanoid painter
// ---------------------------------------------------------------------------

/**
 * Build a projector for one facing plus an optional screen-space transform
 * (used to topple the whole body over during death animations). Body units
 * go in, pixels come out; xf.px/py are pixels, xf.dx/dy design units, and
 * xf.sy squashes the result toward the floor line (a body lying flat is seen
 * from above at a low angle, so it is much less tall than it is wide).
 */
function projector(theta, cx, groundY, xf, k = 1) {
  const c = Math.cos(theta), s = Math.sin(theta);
  return function P(b) {
    let x = cx + (-b.x * c + b.z * s) * k;
    let y = groundY - b.y * k;
    const z = b.x * s + b.z * c;
    if (xf) {
      const dx = x - xf.px, dy = y - xf.py;
      const cr = Math.cos(xf.rot), sr = Math.sin(xf.rot);
      x = xf.px + dx * cr - dy * sr + (xf.dx || 0) * k;
      y = xf.py + dx * sr + dy * cr + (xf.dy || 0) * k;
      if (xf.sy) y = groundY - (groundY - y) * xf.sy;
    }
    return { x, y, z };
  };
}

function profileAt(prof, t) {
  t = clamp(t, 0, 1);
  for (let i = 0; i < prof.length - 1; i++) {
    const a = prof[i], b = prof[i + 1];
    if (t <= b[0] || i === prof.length - 2) {
      const k = (t - a[0]) / Math.max(1e-6, b[0] - a[0]);
      return { w: lerp(a[1], b[1], clamp(k, 0, 1)), d: lerp(a[2], b[2], clamp(k, 0, 1)) };
    }
  }
  return { w: prof[0][1], d: prof[0][2] };
}

/** Short darker creases across a limb (cloth folds at knees and elbows). */
function creases(f, a, b, r, n, c, t0, t1, t = 0.55) {
  const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1;
  const ux = dx / L, uy = dy / L, nx = -uy, ny = ux;
  for (let i = 0; i < n; i++) {
    const q = lerp(t0, t1, n > 1 ? i / (n - 1) : 0.5);
    const mx = a.x + dx * q, my = a.y + dy * q;
    const w = r * (0.55 + 0.25 * (i % 2));
    const sk = (i % 2 ? 0.35 : -0.35) * r;
    const x0 = mx - nx * w, y0 = my - ny * w, x1 = mx + nx * w + ux * sk, y1 = my + ny * w + uy * sk;
    const m = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
    for (let j = 0; j <= m; j++) over(f, x0 + (x1 - x0) * j / m, y0 + (y1 - y0) * j / m, c, t);
  }
}

/** A band around a limb at fraction q along it (cuffs, stripes, knee pads). */
function limbBand(f, a, b, q, r, w, ramp, o = {}) {
  const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1;
  const ux = dx / L, uy = dy / L, nx = -uy, ny = ux;
  const mx = a.x + dx * q, my = a.y + dy * q;
  const hw = Math.max(0.5, w * 0.5), bb = Math.ceil(r + hw + 1);
  const shift = o.shift || 0;
  for (let y = Math.floor(my - bb); y <= Math.ceil(my + bb); y++) {
    for (let x = Math.floor(mx - bb); x <= Math.ceil(mx + bb); x++) {
      const along = (x - mx) * ux + (y - my) * uy, across = (x - mx) * nx + (y - my) * ny;
      if (Math.abs(along) > hw || Math.abs(across) > r) continue;
      if (o.onBody && !(getpx(f, x, y) >>> 24)) continue;
      const s = across / r;
      const b2 = band(lamOf(nx * s, ny * s - 0.1, Math.sqrt(Math.max(0, 1 - s * s)))) + shift;
      px(f, x, y, ramp[clamp(b2 | 0, 0, 4)]);
    }
  }
  if (o.edge !== undefined) {
    for (const e of [-hw - 0.6, hw + 0.6]) {
      for (let s = -r; s <= r; s += 0.7) over(f, mx + ux * e + nx * s, my + uy * e + ny * s, o.edge, 0.5);
    }
  }
}

/**
 * Paint a character. `ch` is the body description, `pose` the animation state,
 * D the facing, `mask` the parts it no longer has. Parts are depth-sorted so
 * every facing composes correctly.
 *
 * Everything above the feet rides on the pose: the hip drops, the upper body
 * pitches (lean), shifts over the planted foot (sway), turns about the spine
 * (twist, the shoulders counter to the hips) and rolls sideways (tilt). Hand
 * targets and weapon points are given relative to the upright, undropped
 * torso and carried along with it, so a gun stays in the hand through a bob.
 */
function humanoid(f, ch, pose, D, mask = 0) {
  const k = ch.k || K;
  const theta = D * Math.PI / 2;
  const cx = f.w / 2;
  const groundY = f.h - 1;
  const P0 = projector(theta, cx, groundY, pose.xform, k);
  const R = ch.ramps;
  const E = { edge: ch.edge, edgeW: 0.9 };

  const drop = pose.hipDrop || 0;
  const hipY = ch.hipY - drop;
  const lean = pose.lean || 0;
  const shrug = pose.shrug || 0;
  const sway = pose.sway || 0, twist = pose.twist || 0, tilt = pose.tilt || 0;
  const legSpan = Math.max(1, hipY - ch.ankleY), upSpan = Math.max(1, ch.shoulderY - ch.hipY);
  const ct = Math.cos(tilt), st = Math.sin(tilt);
  const P = (sway || twist || tilt) ? (b) => {
    const wl = clamp((b.y - ch.ankleY) / legSpan, 0, 1);
    let x = b.x + sway * wl, y = b.y, z = b.z;
    const u = (b.y - hipY) / upSpan;
    if (u > 0) {
      if (twist) {
        // the shoulders turn fully, the head only partly: it keeps its eyes on you
        const a = twist * (u < 1 ? u : Math.max(0.35, 1 - (u - 1) * 2.4));
        const ca = Math.cos(a), sa = Math.sin(a), dx = x - sway;
        x = sway + dx * ca + z * sa; z = z * ca - dx * sa;
      }
      if (tilt) {
        const dx = x - sway, dy = y - hipY;
        x = sway + dx * ct + dy * st; y = hipY - dx * st + dy * ct;
      }
    }
    return P0(V(x, y, z));
  } : P0;

  // --- legs: explicit foot targets keep the feet planted, IK finds the knees.
  const legs = [];
  for (let i = 0; i < 2; i++) {
    const side = i === 0 ? 1 : -1;              // +1 = character's right
    const ft = pose.feet[i];
    const hipJ = V(side * ch.legHalf, hipY, (pose.hipZ || 0));
    const sol = ik(hipJ, ft, ch.thigh, ch.shin, V(side * 0.35, 0.15, 1));
    legs.push({ side, hip: hipJ, knee: sol.joint, foot: sol.end, pitch: pose.footPitch ? pose.footPitch[i] : 0 });
  }

  // --- upper body, dropped with the hip and pitched about it.
  const U = (x, y, z) => leanPt(V(x, y - drop, z), hipY, lean);
  const hipC = V(0, hipY, pose.hipZ || 0);
  const shC = U(0, ch.shoulderY + shrug, 0);
  const neck = U(0, ch.neckY + shrug, ch.neckZ || 0);
  const head = U(pose.headTilt || 0, ch.headY + shrug + (pose.headBob || 0), (ch.headZ || 0) + (pose.headPush || 0));

  // hands and weapon points live in the torso's frame; carry them along
  if (!pose._carried) {
    pose._carried = 1;
    pose.hands = pose.hands.map((h) => U(h.x, h.y + shrug * 0.6, h.z));
    if (pose.wrenchTip) pose.wrenchTip = U(pose.wrenchTip.x, pose.wrenchTip.y + shrug * 0.6, pose.wrenchTip.z);
    if (pose.gunDir && lean) pose.gunDir = vsub(U(pose.gunDir.x, ch.hipY + pose.gunDir.y, pose.gunDir.z), U(0, ch.hipY, 0));
  }

  const arms = [];
  for (let i = 0; i < 2; i++) {
    const side = i === 0 ? 1 : -1;
    const sh = U(side * ch.shoulderHalf, ch.shoulderY - 0.5 + shrug, 0);
    const hand = pose.hands[i];
    const ap = ch.armPole || V(0.85, -0.25, -0.75);
    const sol = ik(sh, hand, ch.upper, ch.fore, V(side * ap.x, ap.y, ap.z));
    arms.push({ side, sh, elbow: sol.joint, hand: sol.end });
  }

  const parts = [];
  const add = (z, draw) => parts.push({ z, draw });
  const xf = pose.xform;
  const rot = xf ? xf.rot || 0 : 0, sy = xf && xf.sy ? xf.sy : 1;
  const ctx = {
    f, ch, pose, D, theta, P, add, R, legs, arms, hipC, shC, neck, head, hipY: ch.hipY, cx, groundY, k, mask, E, rot, sy, U,
  };

  // --- legs
  if (!ch.robed) {
    for (const L of legs) {
      const h2 = P(L.hip), k2 = P(L.knee), f2 = P(L.foot);
      const zz = (k2.z + f2.z) * 0.5;
      const bit = L.side > 0 ? 8 : 16;
      add(zz - 0.6, () => {
        const sft = zz < -0.8 ? -1 : 0;
        if (mask & bit) {
          stump(f, h2.x, h2.y, k2.x - h2.x, k2.y - h2.y, ch.legThick * k * 1.02, R.trouser,
            { shift: sft, edge: ch.edge, seed: 80 + L.side, len: ch.legThick * k * 0.6 });
          return;
        }
        paintLeg(ctx, L, h2, k2, f2, sft);
      });
    }
  }

  // --- torso as a stack of elliptical slices
  const torsoZ = P(V(0, ch.shoulderY, 0)).z;
  add(torsoZ + 0.1, () => {
    const n = ch.slices || 13;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const pr = profileAt(ch.profile, t);
      const p = U(0, lerp(ch.hipY - 1.5, ch.shoulderY + 1 + shrug * t, t), 0);
      const s2 = P(p);
      const rx = Math.sqrt(Math.pow(pr.w * Math.cos(theta), 2) + Math.pow(pr.d * Math.sin(theta), 2)) * k;
      blob(f, s2.x, s2.y, rx, 1.9 * k, R.torso, { mode: 'cyl', nyBias: lerp(-0.05, -0.4, t), grain: 0.06, seed: 33 + i, rot, sy });
    }
    if (ch.torsoDetail) ch.torsoDetail(ctx);
  });

  // --- neck and head
  const hd = P(head), nk = P(neck);
  add(hd.z + 13.5, () => {
    if (mask & 1) {
      const dx = hd.x - nk.x, dy = hd.y - nk.y;
      stump(f, nk.x, nk.y, dx, dy, (ch.neckR || 3) * k, R.neck || R.torso,
        { edge: ch.edge, seed: 90, len: (ch.neckR || 3) * k * 0.7, flat: 0.62, bone: 0.42, drips: 3 });
      return;
    }
    if (ch.neckR) capsule(f, nk.x, nk.y + k, hd.x, hd.y, ch.neckR * k, ch.neckR * k * 0.9, R.neck || R.torso, { ...E });
  });
  add(hd.z + 14, () => {
    if (mask & 1) return;
    if (ch.head) ch.head(f, { ...ctx, hd, headB: head });
  });

  // --- arms
  for (const A of arms) {
    const s2 = P(A.sh), e2 = P(A.elbow), h2 = P(A.hand);
    const zz = (e2.z + h2.z) * 0.5 + 1.2;
    const bit = A.side > 0 ? 2 : 4;
    add(zz, () => {
      const sft = zz < -0.8 ? -1 : 0;
      if (mask & bit) {
        blob(f, s2.x, s2.y, ch.armThick * 1.3 * k, ch.armThick * 1.2 * k, R.shoulder || R.sleeve, { shift: sft, ...E });
        stump(f, s2.x, s2.y, e2.x - s2.x, e2.y - s2.y, ch.armThick * 1.08 * k, R.sleeve,
          { shift: sft, edge: ch.edge, seed: 84 + A.side, len: ch.armThick * k * 0.5 });
        return;
      }
      paintArm(ctx, A, s2, e2, h2, sft);
    });
  }

  // --- character-specific gear (packs, tanks, weapons, tabards)
  if (ch.gear) ch.gear(ctx);

  parts.sort((a, b) => a.z - b.z);
  beginOrder(f);
  for (let i = 0; i < parts.length; i++) { CUR_ORD = Math.min(250, i + 1); parts[i].draw(); }
  contactShadow(f, k, ch.shadow === undefined ? 0.5 : ch.shadow);
  // screen points for whatever gets painted over the figure (wounds, spray)
  return {
    chest: P(U(-2, ch.shoulderY - 5, profileAt(ch.profile, 0.8).d * 0.9)),
    gut: P(U(2.5, ch.hipY + 6, profileAt(ch.profile, 0.3).d * 0.9)),
    head: hd, P, U,
  };
}

/** Thigh, knee, shin and a proper boot: shaft, upper, toe cap and sole. */
function paintLeg(c, L, h2, k2, f2, sft) {
  const { f, ch, R, k, P, E } = c;
  const t = ch.legThick * k;
  capsule(f, h2.x, h2.y, k2.x, k2.y, t, t * 0.9, R.trouser, { shift: sft, grain: 0.05, seed: 21, ...E });
  capsule(f, k2.x, k2.y, f2.x, f2.y, t * 0.9, t * 0.74, R.trouser, { shift: sft, grain: 0.05, seed: 22, ...E });
  creases(f, h2, k2, t, 2, R.trouser[0], 0.72, 0.9, 0.5);
  creases(f, k2, f2, t * 0.9, 1, R.trouser[1], 0.35, 0.35, 0.45);
  if (R.kneePad) blob(f, k2.x, k2.y, t * 0.82, t * 0.72, R.kneePad, { shift: sft, spec: R.kneePad[4], ...E });
  if (ch.legDetail) ch.legDetail(c, L, h2, k2, f2, sft);
  // boot: a dark sole peeking out under the upper, then the upper and toe cap
  const bt = t * (ch.bootScale || 1);
  // the foot rolls: toe up at heel strike, heel up at push-off
  const fp = L.pitch || 0, cp = Math.cos(fp), sp = Math.sin(fp);
  const heel = P(vadd(L.foot, V(0, -0.3 * cp - ch.footLen * 0.3 * sp, -ch.footLen * 0.3 * cp + 0.3 * sp)));
  const toe = P(vadd(L.foot, V(0, -0.8 * cp + ch.footLen * sp, ch.footLen * cp + 0.8 * sp)));
  const B = R.boot;
  const mx = (heel.x + toe.x) / 2, my = (heel.y + toe.y) / 2;
  const half = Math.hypot(toe.x - heel.x, toe.y - heel.y) / 2;
  const ang = Math.atan2(toe.y - heel.y, toe.x - heel.x);
  const rot = Math.abs(half) > 0.5 ? ang : 0;
  capsule(f, f2.x, f2.y - bt * 0.4, f2.x, f2.y + bt * 0.2, bt * 0.8, bt * 0.86, B, { shift: sft, ...E });
  blob(f, mx, my + bt * 0.46, half + bt * 0.98, bt * 0.5, R.sole || flat(B[0]), { ...E, rot });
  blob(f, mx, my, half + bt * 0.86, bt * 0.66, B, { shift: sft, spec: B[4], specT: 0.975, ...E, rot });
  blob(f, toe.x, toe.y - bt * 0.08, bt * 0.5, bt * 0.36, R.toeCap || B, { shift: sft, spec: B[4] });
  // laces or a buckle up the front of the shaft
  if (Math.cos(c.theta) > 0.3) {
    for (let i = 0; i < 2; i++) over(f, f2.x, f2.y - bt * 0.1 + i * 2, B[4], 0.6);
  }
}

/** Deltoid, upper arm, elbow fold, forearm, cuff and a big comic-book fist. */
function paintArm(c, A, s2, e2, h2, sft, noDeltoid) {
  const { f, ch, R, k, E } = c;
  const t = ch.armThick * k;
  if (!noDeltoid) blob(f, s2.x, s2.y + 0.3 * k, t * 1.3, t * 1.2, R.shoulder || R.sleeve, { shift: sft, spec: (R.shoulder || R.sleeve)[4], ...E });
  capsule(f, s2.x, s2.y, e2.x, e2.y, t * 1.05, t * 0.9, R.sleeve, { shift: sft, grain: 0.05, seed: 41, ...E });
  capsule(f, e2.x, e2.y, h2.x, h2.y, t * 0.92, t * 0.8, R.forearm || R.sleeve, { shift: sft, grain: 0.05, seed: 42, ...E });
  creases(f, s2, e2, t, 2, R.sleeve[0], 0.78, 0.92, 0.45);
  if (ch.armDetail) ch.armDetail(c, A, s2, e2, h2, sft);
  if (R.cuff) limbBand(f, e2, h2, 0.8, t * 0.95, t * 0.9, R.cuff, { shift: sft, ...E });
  // fist: palm, thumb wrapped over the front, knuckle ridge catching the light
  const G = R.glove;
  const hr = t * (ch.handScale || 1.12);
  blob(f, h2.x, h2.y, hr, hr * 0.94, G, { shift: sft, spec: G[4], ...E });
  const dx = h2.x - e2.x, dy = h2.y - e2.y, L = Math.hypot(dx, dy) || 1;
  const ux = dx / L, uy = dy / L;
  capsule(f, h2.x - uy * hr * 0.55, h2.y + ux * hr * 0.55, h2.x + ux * hr * 0.5 - uy * hr * 0.3, h2.y + uy * hr * 0.5 + ux * hr * 0.3,
    hr * 0.36, hr * 0.3, G, { shift: sft + 1 });
  for (let i = -1; i <= 1; i++) over(f, h2.x + ux * hr * 0.55 - uy * i * hr * 0.4, h2.y + uy * hr * 0.55 + ux * i * hr * 0.4, G[0], 0.45);
}

// ---------------------------------------------------------------------------
// poses
// ---------------------------------------------------------------------------

/** Frames in a walk cycle, per facing. */
const WALK_N = 8;
const TAU = Math.PI * 2;
const pick = (v, d) => (v === undefined ? d : v);

/** How far a boot rolled by `p` must come up so its lowest point stays on the floor. */
function footRaise(ch, p) {
  if (!p) return 0;
  const cp = Math.cos(p), sp = Math.sin(p);
  const low = Math.min(-0.3 * cp - ch.footLen * 0.3 * sp, -0.8 * cp + ch.footLen * sp);
  return Math.max(0, -0.8 - low);
}

/**
 * Eight-frame walk: 0 contact (right heel down, left toe about to leave), 1
 * down (the weight lands and the hip bottoms out), 2 passing (left leg swings
 * through), 3 up (the right leg pushes the body to the top of its arc), then
 * the same again on the other foot. A foot is planted for `duty` of the cycle
 * and slides back at a constant rate while it is, so it never skates, and at
 * least one foot is always down. `ch.gait` gives each body its own way of
 * getting about: how far it drops, rolls, sways and twists doing it.
 */
function walkPose(ch, F) {
  const g = ch.gait || {};
  const duty = pick(g.duty, 0.56);
  const phi = (F / WALK_N) * TAU;
  const stride = ch.stride, lift = ch.lift;
  const strike = pick(g.strike, 0.22), push = pick(g.push, 0.42);
  const reach = (ch.thigh + ch.shin) * 0.985;
  const feet = [], pitch = [];
  let swing = 0, need = 0;
  for (let i = 0; i < 2; i++) {
    const side = i === 0 ? 1 : -1;
    let u = F / WALK_N + i * 0.5;
    u -= Math.floor(u);
    let y = ch.ankleY, z, p;
    if (u < duty) {
      const s = u / duty;
      z = stride * (1 - 2 * s);
      p = s < 0.22 ? strike * (1 - s / 0.22) : s > 0.68 ? -push * Math.pow((s - 0.68) / 0.32, 1.5) : 0;
    } else {
      const s = (u - duty) / (1 - duty);
      const e = s * s * (3 - 2 * s);
      z = stride * (-1 + 2 * e);
      y += lift * Math.sin(Math.PI * Math.pow(s, 0.75));
      p = lerp(-push * 1.3, strike, e);
    }
    y += footRaise(ch, p);
    if (i === 0) swing = z / stride;
    const fx = side * ch.legHalf * 1.02 * pick(g.wide, 1);
    feet.push(V(fx, y, z));
    pitch.push(p);
    if (u < duty) {
      const dx = fx - side * ch.legHalf;
      need = Math.max(need, ch.hipY - y - Math.sqrt(Math.max(0, reach * reach - dx * dx - z * z)));
    }
  }
  // down on the frame after contact, up on the one before it
  const drop = Math.max(need, ch.hipDip * (0.5 + 0.5 * Math.sin(2 * phi + pick(g.dipPh, 0))));
  const pose = {
    feet, footPitch: pitch, phase: phi, swing, walkF: F,
    hipDrop: drop,
    lean: ch.lean + pick(g.leanBob, 0) * Math.sin(2 * phi + 0.5),
    sway: pick(g.sway, 0) * Math.sin(phi),
    tilt: pick(g.tilt, 0) * Math.sin(phi),
    twist: pick(g.twist, 0.08) * swing,
    headBob: pick(g.bob, 0.4) * Math.sin(2 * phi - 0.9),
    headTilt: pick(g.jitter, 0) * (hash2(F, 5, 77) - 0.5),
    hands: [V(0, 0, 0), V(0, 0, 0)],  // replaced by the character
    hipZ: 0,
  };
  return pose;
}

/** Standing pose with the feet planted (used by idle, attacks, pain and death). */
function standPose(ch, o = {}) {
  const p = {
    phase: o.phase || 0, swing: 0,
    feet: [V(ch.legHalf * 1.05 + (o.fx0 || 0), ch.ankleY, pick(o.fz0, 2.0)),
      V(-ch.legHalf * 1.05 - (o.fx1 || 0), ch.ankleY, pick(o.fz1, -2.0))],
    footPitch: [0, 0],
    hipDrop: o.hipDrop || 0,
    lean: pick(o.lean, ch.lean),
    hands: [V(0, 0, 0), V(0, 0, 0)],
    hipZ: o.hipZ || 0,
    xform: o.xform || null,
  };
  for (const key of ['sway', 'twist', 'tilt', 'shrug', 'headBob', 'headPush', 'headTilt']) p[key] = o[key] || 0;
  return p;
}

/** Idle: planted, breathing. F 0 breathes out, 1 in: chest and shoulders up, head up. */
function idlePose(ch, F) {
  const g = ch.gait || {};
  return standPose(ch, {
    fz0: 1.6, fz1: -1.4, fx0: 0.6, fx1: 0.6,
    lean: ch.lean * 0.7 + (F ? -0.02 : 0.02),
    shrug: F ? pick(g.breath, 0.7) : 0,
    hipDrop: F ? 0 : 0.35,
    headBob: F ? 0.35 : -0.1,
    headTilt: F ? pick(g.jitter, 0) * 0.5 : 0,
    phase: F ? 1.2 : 0,
  });
}

/**
 * Death with some weight to it: the hit throws the head back and the arms up,
 * the knees go, the body twists as it drops and topples, hits the floor hard
 * enough to squash, bounces once and settles. The whole projected figure turns
 * about the hip and lands on the floor line; the frames are wider than the
 * walk frames so the body always fits. t: 0..1 through die0..die5, 1 the corpse.
 */
const DEATH = [
  // rot, lift (design units above the floor line), lean, arms up, squash,
  // hip drop (fraction of its height), twist, tilt
  { t: 0.0, rot: 0.0, lift: 0, lean: 0.0, up: 0.2, sy: 1, drop: 0, tw: 0, tl: 0 },
  { t: 0.08, rot: 0.1, lift: 0, lean: -0.4, up: 1.0, sy: 1, drop: 0.03, tw: -0.3, tl: 0.14 },
  { t: 0.26, rot: 0.04, lift: 0, lean: 0.36, up: 0.05, sy: 1, drop: 0.34, tw: 0.35, tl: -0.12 },
  { t: 0.46, rot: -0.55, lift: 0, lean: 0.24, up: 0.55, sy: 0.96, drop: 0.4, tw: 0.85, tl: -0.1 },
  { t: 0.66, rot: -1.2, lift: 2, lean: 0.08, up: 0.4, sy: 0.84, drop: 0.36, tw: 0.6, tl: 0 },
  { t: 0.84, rot: -1.571, lift: 0, lean: 0, up: -0.3, sy: 0.52, drop: 0.3, tw: 0.4, tl: 0 },
  { t: 0.94, rot: -1.5, lift: 2.8, lean: 0, up: -0.1, sy: 0.68, drop: 0.3, tw: 0.4, tl: 0 },
  { t: 1.0, rot: -1.571, lift: 0, lean: 0, up: -0.35, sy: 0.6, drop: 0.3, tw: 0.4, tl: 0 },
];
const DIE_T = [0.08, 0.26, 0.46, 0.66, 0.84, 0.94];
const DIE_N = DIE_T.length;

function deathKey(t) {
  let a = DEATH[0], b = DEATH[DEATH.length - 1];
  for (let i = 0; i < DEATH.length - 1; i++) {
    if (t >= DEATH[i].t && t <= DEATH[i + 1].t) { a = DEATH[i]; b = DEATH[i + 1]; break; }
  }
  const q = clamp((t - a.t) / Math.max(1e-6, b.t - a.t), 0, 1);
  const o = {};
  for (const k of ['rot', 'lift', 'lean', 'up', 'sy', 'drop', 'tw', 'tl']) o[k] = lerp(a[k], b[k], q);
  return o;
}

function deathPose(ch, t, W) {
  const k = ch.k || K;
  const d = deathKey(t);
  const H = Math.round(ch.h * k);
  const groundY = H - 1;
  const drop = ch.hipY * d.drop;
  const hy = ch.hipY - drop;
  // pivot at the hip, wherever the knees have let it get to
  const pivY = groundY - hy * k;
  const land = hy - (ch.lieH || 7);
  const fall = clamp(-d.rot / 1.571, 0, 1);
  const p = standPose(ch, {
    hipDrop: drop, lean: d.lean, twist: d.tw, tilt: d.tl,
    fz0: 2.4, fz1: -1.6,
    xform: { px: W / 2, py: pivY, rot: d.rot, dx: 0, dy: land * Math.pow(fall, 1.4) - d.lift, sy: d.sy },
  });
  // planted while the knees go, then kicked out straight as it goes over
  const reach = (ch.thigh + ch.shin) * 0.95;
  const e = clamp((t - 0.36) / 0.45, 0, 1), ee = e * e * (3 - 2 * e);
  const flop = t > 0.9 && t < 0.99 ? 3 : 0;
  p.feet[0] = V(ch.legHalf * 1.3 + ee * 2, lerp(ch.ankleY, hy - reach, ee) + flop, lerp(2.4, 4, ee));
  p.feet[1] = V(-ch.legHalf * 1.2 - ee * 2, lerp(ch.ankleY, hy - reach * 0.72, ee) + flop * 0.5, lerp(-1.6, 7, ee));
  // arms: flung up by the hit, dropped as the knees go, splayed on the floor
  const up = d.up;
  p.hands = [V(ch.shoulderHalf + 3 + t * 4, ch.shoulderY + up * 14 - 4, lerp(3, -3, t)),
    V(-ch.shoulderHalf - 4 - t * 3, ch.shoulderY + up * 11 - 5 + (t > 0.3 && t < 0.8 ? -6 : 0), lerp(2, -4, t))];
  p.headPush = lerp(-1.8, -2.5, t);
  p.headTilt = lerp(0, 1.1, t);
  p.dying = t;
  return p;
}

// ---------------------------------------------------------------------------
// frame assembly, recipes and the maim cache
// ---------------------------------------------------------------------------

let INK_SCRATCH = new Uint8Array(0);

/**
 * outline() from pixels.js, minus the per-call copy of the frame: coverage
 * goes into one reused byte mask. maim() calls this on demand, mid-game.
 */
function inkEdge(f, c) {
  const { w, h, data } = f;
  if (INK_SCRATCH.length < w * h) INK_SCRATCH = new Uint8Array(w * h);
  const m = INK_SCRATCH;
  for (let i = 0; i < w * h; i++) m[i] = data[i] >>> 24 ? 1 : 0;
  for (let y = 0; y < h; y++) {
    const r = y * w, up = (y > 0 ? y - 1 : 0) * w, dn = (y + 1 < h ? y + 1 : h - 1) * w;
    for (let x = 0; x < w; x++) {
      if (m[r + x]) continue;
      if (m[up + x] || m[dn + x] || m[r + (x > 0 ? x - 1 : 0)] || m[r + (x + 1 < w ? x + 1 : w - 1)]) data[r + x] = c;
    }
  }
  return f;
}

/**
 * Grade a finished figure for the renderer: the light grid routinely runs
 * 1.5 to 2.3 in a lit room and the player's own glow, and a sprite painted with a
 * texture's brightness comes out chalky. Pull the values down and push the
 * saturation up so a lit enemy lands where the walls do, still in colour.
 */
const GRADE = new Uint8Array(256);
for (let v = 0; v < 256; v++) GRADE[v] = Math.round(v * (0.76 - 0.15 * v / 255));

function grade(f, sat = 1.28) {
  const d = f.data;
  for (let i = 0; i < d.length; i++) {
    const c = d[i];
    if (!(c >>> 24)) continue;
    const r = c & 255, g = (c >>> 8) & 255, b = (c >>> 16) & 255;
    const l = r * 0.3 + g * 0.55 + b * 0.15;
    d[i] = rgba(GRADE[clamp((l + (r - l) * sat) | 0, 0, 255)], GRADE[clamp((l + (g - l) * sat) | 0, 0, 255)],
      GRADE[clamp((l + (b - l) * sat) | 0, 0, 255)], 255);
  }
}

/**
 * The key light catching the silhouette's upper and left edges, the warm twin
 * of sideRim: together they cut a figure out of a corridor from either side.
 */
function keyRim(f, c, t0, t1) {
  const { w, h, data } = f;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!(data[i] >>> 24)) continue;
      const left = x === 0 || !(data[i - 1] >>> 24), up = y === 0 || !(data[i - w] >>> 24);
      if (!left && !up) continue;
      data[i] = mix(data[i], c, left && up ? t0 * 1.3 : t0);
      if (t1 && left && x + 1 < w && (data[i + 1] >>> 24)) data[i + 1] = mix(data[i + 1], c, t1);
    }
  }
}

function finishEnemy(f, o = {}) {
  if (o.flash) wash(f, rgba(228, 70, 58, 255), o.flash);
  if (o.grade !== false) grade(f);
  topRim(f, WARM, 0.14, 0.06);
  keyRim(f, WARM, 0.2, 0.07);
  if (o.rim !== false) sideRim(f, o.rimC || RIM, 0.36, 0.14);
  inkEdge(f, o.ink || INK);
  return f;
}

/** Columns x0..x0+cw-1 of a frame, as a new frame. */
function cropX(f, x0, cw) {
  const o = makeFrame(cw, f.h);
  for (let y = 0; y < f.h; y++) o.data.set(f.data.subarray(y * f.w + x0, y * f.w + x0 + cw), y * cw);
  return o;
}

/**
 * Register a key: `paint(frame, mask)` fills a fresh w x h frame. The unmaimed
 * frame is painted now; maimed variants are painted by maim() when asked for.
 *
 * Canvases are sized for the widest thing a body can do, and most frames use
 * a fraction of that, so the empty margins come off: symmetrically, because
 * the renderer centres a frame on the body, and by the same amount for every
 * maimed variant, which only ever has less on it.
 */
function register(out, recipes, key, w, h, paint) {
  const full = makeFrame(w, h);
  paint(full, 0);
  let lo = w, hi = -1;
  for (let y = 0; y < h; y++) {
    const r = y * w;
    for (let x = 0; x < lo; x++) if (full.data[r + x] >>> 24) { lo = x; break; }
    for (let x = w - 1; x > hi; x--) if (full.data[r + x] >>> 24) { hi = x; break; }
  }
  const half = Math.max(w / 2 - lo, hi + 1 - w / 2, 1);
  let cw = Math.min(w, 2 * Math.ceil(half) + 2);
  if ((w - cw) & 1) cw++;
  const x0 = (w - cw) >> 1;
  const rec = {
    paint: (mask) => {
      const f = makeFrame(w, h);
      paint(f, mask);
      return cw === w ? f : cropX(f, x0, cw);
    },
    v: [],
  };
  recipes[key] = rec;
  out[key] = cw === w ? full : cropX(full, x0, cw);
}

/**
 * maim(key, mask): the frame for `key` with the parts in `mask` missing, or
 * null for a key no recipe knows. Variants live on their recipe (so a hit is
 * two array reads), and a ring remembers the insertion order so the oldest
 * go first once the cache holds MAX variants or MAX_PX pixels.
 */
function makeMaim(frames, recipes) {
  const MAX = 2000, MAX_PX = 16e6;
  const ring = [];
  let head = 0, count = 0, pixels = 0;
  function maim(key, mask) {
    const rec = recipes[key];
    if (!rec) return null;
    const m = (mask | 0) & 31;
    if (!m) return frames[key] || null;
    const hit = rec.v[m];
    if (hit) return hit;
    const f = rec.paint(m);
    rec.v[m] = f;
    ring.push(rec, m);
    count++; pixels += f.w * f.h;
    while (count > MAX || (pixels > MAX_PX && count > 1)) {
      const r = ring[head], mm = ring[head + 1];
      const old = r.v[mm];
      if (old) pixels -= old.w * old.h;
      r.v[mm] = undefined;
      head += 2; count--;
    }
    if (head > 8192) { ring.splice(0, head); head = 0; }
    return f;
  }
  maim.cached = () => count;
  return maim;
}

// ---------------------------------------------------------------------------
// surface helpers for gear painters
// ---------------------------------------------------------------------------

/** Torso slice at body height y: screen centre and half-width in pixels. */
function torsoAt(c, y) {
  const { ch, P, theta, hipY, pose, k } = c;
  const t = clamp((y - (hipY - 1.5)) / (ch.shoulderY + 1 - (hipY - 1.5)), 0, 1);
  const pr = profileAt(ch.profile, t);
  const s2 = P(c.U(0, y, 0));
  const rx = Math.sqrt(Math.pow(pr.w * Math.cos(theta), 2) + Math.pow(pr.d * Math.sin(theta), 2)) * k;
  return { x: s2.x, y: s2.y, rx, pr };
}

/**
 * Paint a band round the torso at body height y, `hgt` design units tall,
 * shaded like the cylinder it wraps. Only touches pixels the torso already
 * covers, so it can never spill past the silhouette.
 */
function torsoBand(c, y, hgt, ramp, o = {}) {
  const { f, k } = c;
  const s = torsoAt(c, y);
  const rx = s.rx * (o.grow || 1.03);
  const hh = Math.max(0.5, hgt * k * 0.5);
  const rot = c.rot || 0, isy = 1 / (c.sy || 1);
  const cr = Math.cos(rot), sr = Math.sin(rot);
  const bb = Math.ceil(Math.max(rx, hh) + 1);
  for (let yy = Math.floor(s.y - bb); yy <= Math.ceil(s.y + bb); yy++) {
    for (let x = Math.floor(s.x - bb); x <= Math.ceil(s.x + bb); x++) {
      if (!(getpx(f, x, yy) >>> 24)) continue;
      const dx = x - s.x, dy = (yy - s.y) * isy;
      const lx = dx * cr + dy * sr, ly = -dx * sr + dy * cr;
      if (ly < -hh - 0.5 || ly > hh - 0.5) continue;
      const u = lx / rx;
      if (Math.abs(u) > 1) continue;
      const v = ly / hh;
      const n0 = u, n1 = -0.15 + v * 0.35;
      let b = band(lamOf(n0 * cr - n1 * sr, n0 * sr + n1 * cr, Math.sqrt(Math.max(0, 1 - u * u))));
      if (o.grain && hash2(x, yy, o.seed || 3) < o.grain) b--;
      px(f, x, yy, ramp[clamp(b + (o.shift || 0), 0, 4)]);
    }
  }
  return s;
}

/** Screen point on the front (zf=1) or back (zf=-1) surface of the torso. */
function surf(c, x, y, zf = 1) {
  const { ch, hipY, pose, P } = c;
  const t = clamp((y - (hipY - 1.5)) / (ch.shoulderY + 1 - (hipY - 1.5)), 0, 1);
  const pr = profileAt(ch.profile, t);
  const z = pr.d * Math.sqrt(Math.max(0, 1 - (x / pr.w) * (x / pr.w))) * zf * 0.96;
  return P(c.U(x, y, z));
}

/** Point on the side surface (+1 its right, -1 its left) at body height y. */
function sideSurf(c, side, y, z = 0) {
  const { ch, hipY, pose, P } = c;
  const t = clamp((y - (hipY - 1.5)) / (ch.shoulderY + 1 - (hipY - 1.5)), 0, 1);
  const pr = profileAt(ch.profile, t);
  return P(c.U(side * pr.w * 0.97, y, z));
}

// ---------------------------------------------------------------------------
// character definitions
// ---------------------------------------------------------------------------

/**
 * Wrencher - bunker maintenance. Hi-vis orange coveralls stretched over a gut,
 * battered hardhat, brass welding goggles over a rubber gas mask, a tool belt
 * with a hammer on it, and a pipe wrench as long as his leg.
 */
function makeWrencher() {
  const orange = rgba(222, 104, 24, 255);
  const R = {
    torso: mat(orange, { contrast: 1.15 }),
    sleeve: mat(rgba(208, 94, 22, 255), { contrast: 1.15 }),
    shoulder: mat(rgba(214, 98, 22, 255), { contrast: 1.15 }),
    trouser: mat(rgba(190, 84, 22, 255), { contrast: 1.12 }),
    boot: mat(rgba(58, 42, 34, 255), { contrast: 1.2 }),
    toeCap: mat(rgba(132, 136, 146, 255), { contrast: 1.3 }),
    sole: flat(rgba(24, 18, 16, 255)),
    glove: mat(rgba(104, 72, 42, 255), { contrast: 1.25 }),
    cuff: mat(rgba(168, 72, 18, 255), { contrast: 1.1 }),
    kneePad: mat(rgba(46, 46, 52, 255), { contrast: 1.3 }),
    hat: mat(rgba(242, 190, 30, 255), { contrast: 1.2 }),
    mask: mat(rgba(66, 72, 64, 255), { contrast: 1.25 }),
    neck: mat(rgba(66, 72, 64, 255), { contrast: 1.25 }),
    lens: mat(rgba(118, 222, 104, 255), { contrast: 1.4 }),
    brass: mat(rgba(204, 156, 62, 255), { contrast: 1.3 }),
    steel: mat(rgba(166, 172, 184, 255), { contrast: 1.3 }),
    can: mat(rgba(104, 112, 70, 255), { contrast: 1.2 }),
    leather: mat(rgba(96, 62, 34, 255), { contrast: 1.15 }),
    dark: mat(rgba(38, 36, 42, 255)),
    hivis: mat(rgba(232, 240, 196, 255), { contrast: 1.05 }),
    grip: mat(rgba(200, 40, 34, 255), { contrast: 1.25 }),
    tape: mat(rgba(236, 200, 40, 255), { contrast: 1.2 }),
  };
  const ch = {
    id: 'wrencher', w: 64, h: 72, dieW: 104, k: K,
    hipY: 31, shoulderY: 50, neckY: 52.6, headY: 58.4, neckZ: 1.2, headZ: 2.0,
    shoulderHalf: 11.6, legHalf: 5.1, ankleY: 4.0, footLen: 5.8,
    thigh: 14.6, shin: 14.2, upper: 12, fore: 11.4,
    armThick: 3.5, legThick: 4.4, stride: 10, lift: 5.4, hipDip: 2.4, lean: 0.16,
    // a heavy trudge: lands hard, rolls over the planted boot, shoulders swinging
    gait: { duty: 0.6, sway: 1.2, tilt: 0.05, twist: 0.14, bob: 0.5, leanBob: 0.05, wide: 1.08, strike: 0.2, push: 0.36 },
    neckR: 3.1, lieH: 17, handScale: 1.02,
    edge: rgba(34, 14, 6, 255), ink: rgba(10, 5, 4, 255),
    profile: [[0, 9.4, 7.0], [0.2, 10.8, 9.6], [0.42, 10.6, 8.8], [0.78, 12.8, 7.8], [1, 11.6, 7.0]],
    ramps: R,
    head(f, c) {
      const { hd, theta, E, k, pose } = c;
      const fw = Math.cos(theta), sd = Math.sin(theta);
      const face = fw > 0.35, back = fw < -0.35, s = sd >= 0 ? 1 : -1;
      const g = pen(f, hd.x, hd.y, k, 1, c.rot || 0, c.sy || 1);
      // rubber hood over the whole skull
      g.blob(0, 0.8, 5.0, 5.5, R.mask, { grain: 0.05, seed: 61, ...E, spec: R.mask[4] });
      // hardhat: brim first, then the dome sits on it
      const bx = face || back ? 0 : s * 1.8;
      g.blob(bx, -3.3, face || back ? 7.2 : 8.0, 1.6, R.hat, { shift: face ? 0 : -1, ...E });
      g.blob(0, -5.0, 5.4, 4.1, R.hat, { grain: 0.04, seed: 62, ...E, spec: rgba(255, 252, 226, 255) });
      if (face || back) g.cap(0, -8.6, 0, -5.4, 0.75, 0.9, R.hat, { shift: 1 });
      else g.cap(-3.8, -7.0, 3.8, -7.0, 0.7, 0.7, R.hat, { shift: 1 });
      g.over(-2.6, -6.2, R.hat[1], 0.7); g.over(2.4, -4.4, R.hat[0], 0.55); g.over(1.2, -7.4, R.hat[1], 0.5);
      if (face) {
        // sticker on the dome: a tiny skull, because of course
        g.rect(1.6, -6.6, 2.0, 1.6, rgba(236, 236, 228, 255));
        g.dot(2.1, -6.1, rgba(30, 28, 30, 255)); g.dot(3.1, -6.1, rgba(30, 28, 30, 255));
        // dead headlamp on the brow of the hat
        g.blob(-1.8, -4.3, 1.5, 1.2, R.steel, { ...E });
        g.blob(-1.8, -4.3, 0.9, 0.7, flat(rgba(70, 64, 48, 255)));
        g.dot(-2.2, -4.7, rgba(255, 250, 230, 255));
        // goggle strap and goggles: brass rims, green glass, a hard glint
        g.rect(-5.1, -1.8, 10.2, 1.1, R.leather[1]);
        const cracked = pose && (pose.dead || pose.severed);
        for (const ex of [-2.3, 2.3]) {
          g.blob(ex, -1.2, 2.25, 2.05, R.brass, { ...E, spec: rgba(255, 244, 200, 255) });
          g.blob(ex, -1.2, 1.5, 1.35, R.lens, { shift: 1 });
          g.dot(ex - 0.6, -1.8, rgba(250, 255, 240, 255));
          if (cracked) {
            g.line(ex - 1, -2.2, ex + 0.8, -0.2, rgba(20, 30, 18, 255));
            g.line(ex, -1.2, ex + 1.1, -1.9, rgba(230, 255, 220, 255));
          }
        }
        g.cap(-0.7, -1.2, 0.7, -1.2, 0.45, 0.45, R.brass);
        // respirator: snout, a grilled centre canister, two olive side filters
        g.blob(0, 2.7, 3.1, 2.3, R.mask, { shift: 1, ...E });
        for (const ex of [-3.5, 3.5]) {
          g.blob(ex, 3.0, 1.55, 1.8, R.can, { ...E, spec: R.can[4] });
          g.line(ex - 1, 3.4, ex + 1, 3.4, R.can[0]);
        }
        g.blob(0, 3.5, 1.9, 1.7, R.steel, { ...E, spec: rgba(255, 255, 255, 255) });
        for (let i = -1; i <= 1; i++) g.dot(i * 0.7, 3.6, R.dark[0]);
        g.over(0, 5.4, R.mask[0], 0.6);
      } else if (!back) {
        const q = pen(f, hd.x, hd.y, k, s, c.rot || 0, c.sy || 1);
        q.rect(-5, -1.8, 9, 1.0, R.leather[1]);
        q.blob(-3.2, -1.3, 1.1, 1.1, R.brass, { ...E });
        q.blob(3.3, -1.3, 1.5, 2.0, R.brass, { ...E });
        q.blob(3.7, -1.3, 0.9, 1.4, R.lens, { shift: 1 });
        q.dot(3.9, -2.0, rgba(250, 255, 240, 255));
        q.blob(3.4, 2.8, 2.6, 2.1, R.mask, { shift: 1, ...E });
        q.blob(5.2, 3.2, 1.3, 1.6, R.steel, { ...E, spec: rgba(255, 255, 255, 255) });
        q.blob(1.0, 3.6, 1.5, 1.8, R.can, { ...E, spec: R.can[4] });
        // corrugated hose down to the chest
        for (let i = 0; i < 4; i++) q.blob(2.6 - i * 0.5, 5.4 + i * 1.1, 1.0, 0.8, R.dark, { shift: i % 2 ? 0 : 1 });
        q.blob(4.8, -4.2, 1.2, 1.0, R.steel, { ...E });
      } else {
        g.rect(-5.1, -1.8, 10.2, 1.1, R.leather[1]);
        g.blob(0, -1.3, 1.2, 1.0, R.brass, { ...E });
        g.line(0, 0.5, 0, 5.4, R.mask[0]);
        g.line(-4, 3.0, 4, 3.0, R.leather[0]);
        g.over(-2, 1.5, R.mask[4], 0.4);
      }
    },
    torsoDetail(c) {
      const { f, theta, k, hipY } = c;
      const fw = Math.cos(theta);
      // reflective bands, and the collar
      torsoBand(c, ch.shoulderY - 8.6, 1.4, R.hivis, {});
      torsoBand(c, ch.shoulderY - 11.6, 1.4, R.hivis, {});
      torsoBand(c, ch.shoulderY + 0.4, 1.2, R.cuff, { shift: 1 });
      // grimy seat of the pants
      speckle(f, Math.round(c.cx - 20 * k), Math.round(c.groundY - (hipY + 8) * k), Math.round(40 * k), Math.round(12 * k), R.torso[0], 0.05, 31, 0.5);
      if (fw > 0.3) {
        const z0 = surf(c, 0, ch.shoulderY), z1 = surf(c, 0, hipY + 2.5);
        line(f, Math.round(z0.x), Math.round(z0.y), Math.round(z1.x), Math.round(z1.y), R.torso[0]);
        stitch(f, z0.x + 1, z0.y, z1.x + 1, z1.y, R.steel[3], 0.8, 1, 2);
        // chest pocket with pens (his left, screen right), name patch (his right)
        const pk = surf(c, -5.2, ch.shoulderY - 3.2);
        box(f, Math.round(pk.x - 2.2 * k), Math.round(pk.y - 1.4 * k), Math.round(4.4 * k), Math.round(3.2 * k), R.torso, { shift: -1 });
        stitch(f, pk.x - 2.2 * k, pk.y - 1.4 * k, pk.x + 2.2 * k, pk.y - 1.4 * k, R.torso[4], 0.7);
        px(f, Math.round(pk.x - 1.2 * k), Math.round(pk.y - 2.4 * k), rgba(40, 70, 190, 255));
        px(f, Math.round(pk.x - 1.2 * k), Math.round(pk.y - 1.8 * k), rgba(40, 70, 190, 255));
        px(f, Math.round(pk.x + 0.2 * k), Math.round(pk.y - 2.2 * k), rgba(200, 40, 40, 255));
        const np = surf(c, 5.0, ch.shoulderY - 3.0);
        fillRect(f, Math.round(np.x - 2.4 * k), Math.round(np.y - 1.0 * k), Math.round(4.8 * k), Math.round(2.0 * k), rgba(236, 232, 220, 255));
        stitch(f, np.x - 1.8 * k, np.y, np.x + 1.8 * k, np.y, rgba(190, 36, 30, 255), 1, 2, 1);
        // the gut strains the zip
        const gz = surf(c, 0, hipY + 5.5);
        over(f, gz.x - 1, gz.y, R.torso[4], 0.5); over(f, gz.x, gz.y + 1, R.torso[0], 0.6);
      } else if (fw < -0.3) {
        const bp = surf(c, 0, ch.shoulderY - 4.2, -1);
        stencil(f, Math.round(bp.x - 10), Math.round(bp.y - 3), 'MAINT', rgba(70, 28, 8, 255), 0.9);
      }
      // tool belt
      torsoBand(c, hipY + 1.4, 2.6, R.leather, { grain: 0.08, seed: 7 });
      if (fw > 0.3) {
        const bk = surf(c, 0, hipY + 1.4);
        box(f, Math.round(bk.x - 1.6 * k), Math.round(bk.y - 1.3 * k), Math.round(3.2 * k), Math.round(2.6 * k), R.brass, {});
        px(f, Math.round(bk.x), Math.round(bk.y), R.leather[0]);
      }
    },
    legDetail(c, L, h2, k2, f2, sft) {
      limbBand(c.f, k2, f2, 0.4, ch.legThick * c.k * 0.92, 1.3 * c.k, R.hivis, { shift: sft, onBody: true });
    },
    armDetail(c, A, s2, e2, h2, sft) {
      limbBand(c.f, s2, e2, 0.6, ch.armThick * c.k * 1.0, 1.2 * c.k, R.hivis, { shift: sft, onBody: true });
    },
    gear(c) {
      const { f, add, P, arms, pose, theta, hipY, k, mask } = c;
      const E = { edge: ch.edge, edgeW: 0.9 };
      // pouches on both hips, the hammer and the tape on them
      for (const side of [1, -1]) {
        const pp = sideSurf(c, side, hipY - 0.6, 1.2);
        add(pp.z + 0.3, () => {
          box(f, Math.round(pp.x - 2.0 * k), Math.round(pp.y - 1.0 * k), Math.round(4.0 * k), Math.round(4.2 * k), R.leather, { grain: 0.08, seed: 12 + side });
          fillRect(f, Math.round(pp.x - 2.0 * k), Math.round(pp.y - 1.0 * k), Math.round(4.0 * k), Math.round(1.1 * k), R.leather[1]);
          if (side < 0) {
            // claw hammer hanging head-down through a loop
            capsule(f, pp.x + 0.6 * k, pp.y - 2.4 * k, pp.x + 0.2 * k, pp.y + 5.4 * k, 0.75 * k, 0.7 * k, R.leather, { ...E, shift: 1 });
            capsule(f, pp.x - 1.6 * k, pp.y + 5.8 * k, pp.x + 2.0 * k, pp.y + 5.8 * k, 1.0 * k, 0.8 * k, R.steel, { ...E, spec: rgba(255, 255, 255, 255) });
          } else {
            box(f, Math.round(pp.x - 1.4 * k), Math.round(pp.y + 3.4 * k), Math.round(3.0 * k), Math.round(2.6 * k), R.tape, {});
            px(f, Math.round(pp.x), Math.round(pp.y + 4.6 * k), R.dark[0]);
          }
        });
      }
      // the pipe wrench: held two-handed, or in whichever hand is left
      const haveR = !(mask & 2), haveL = !(mask & 4);
      if (!haveR && !haveL) return;
      const A = arms[0].hand, B = arms[1].hand;
      const mid = haveR && haveL ? vmul(vadd(A, B), 0.5) : (haveR ? A : B);
      const dir = vnorm(vsub(pose.wrenchTip || V(mid.x, mid.y + 14, mid.z + 3), mid));
      const tip = vadd(mid, vmul(dir, WRENCH_LEN));
      const butt = vadd(mid, vmul(dir, -8));
      const p0 = P(butt), p1 = P(tip);
      const zw = Math.max(haveR ? P(A).z : -99, haveL ? P(B).z : -99) + 2.6;
      if (pose.smear) {
        // the swing, smeared across the frame it happened in
        const from = pose.smear === 1 ? c.U(20, ch.shoulderY + 16, -12) : c.U(-9, ch.shoulderY + 4, 30);
        const d0 = vnorm(vsub(from, mid));
        add(zw - 0.05, () => {
          for (let i = 0; i < 9; i++) {
            const q = i / 9;
            const dq = vnorm(vadd(vmul(d0, 1 - q), vmul(dir, q)));
            const a = P(vadd(mid, vmul(dq, WRENCH_LEN * 0.4))), b = P(vadd(mid, vmul(dq, WRENCH_LEN + 4)));
            smearBand(f, a, b, (1.2 + 2.4 * q) * k, mix(rgba(226, 232, 246, 255), rgba(140, 150, 170, 255), 1 - q), 0.2 + 0.55 * q, 77 + i);
          }
        });
      }
      add(zw, () => {
        paintWrench(f, p0, p1, k, p1.z < -1 ? -1 : 0);
      });
    },
  };
  return ch;
}
const WRENCH_LEN = 22;

/** The wrench, butt to jaw, in screen space. Shared by the frames and the corpse. */
function paintWrench(f, p0, p1, k, sft) {
  const steel = mat(rgba(166, 172, 184, 255), { contrast: 1.3 });
  const dark = mat(rgba(38, 36, 42, 255));
  const grip = mat(rgba(200, 40, 34, 255), { contrast: 1.25 });
  const EW = { edge: rgba(18, 16, 20, 255), edgeW: 0.9 };
  const dx = p1.x - p0.x, dy = p1.y - p0.y, L = Math.hypot(dx, dy) || 1;
  const ux = dx / L, uy = dy / L, nx = -uy, ny = ux;
  capsule(f, p0.x, p0.y, p1.x, p1.y, 1.6 * k, 1.35 * k, steel, { shift: sft, grain: 0.06, seed: 71, ...EW, spec: rgba(255, 255, 255, 255) });
  // red dipped grip on the butt, with a hanging hole
  capsule(f, p0.x, p0.y, p0.x + ux * 6.5 * k, p0.y + uy * 6.5 * k, 1.95 * k, 1.8 * k, grip, { shift: sft, ...EW, spec: rgba(255, 190, 180, 255) });
  px(f, Math.round(p0.x + ux * 1.4 * k), Math.round(p0.y + uy * 1.4 * k), rgba(20, 8, 8, 255));
  // rust freckles along the shaft
  for (let i = 0; i < 5; i++) {
    const q = 0.4 + i * 0.1;
    over(f, p0.x + dx * q + nx * (i % 2 ? 0.6 : -0.4) * k, p0.y + dy * q + ny * (i % 2 ? 0.6 : -0.4) * k, rgba(130, 64, 28, 255), 0.7);
  }
  // head: a fat hook jaw, a shorter sliding jaw, the knurled nut between
  const jx = p1.x + ux * 1.0 * k, jy = p1.y + uy * 1.0 * k;
  capsule(f, jx - nx * 2.6 * k, jy - ny * 2.6 * k, jx + nx * 4.4 * k, jy + ny * 4.4 * k, 2.3 * k, 2.1 * k, steel, { shift: sft, ...EW, spec: rgba(255, 255, 255, 255) });
  const mx2 = jx + ux * 5.2 * k, my2 = jy + uy * 5.2 * k;
  capsule(f, mx2 - nx * 2.6 * k, my2 - ny * 2.6 * k, mx2 + nx * 2.0 * k, my2 + ny * 2.0 * k, 1.8 * k, 1.6 * k, steel, { shift: sft, ...EW });
  capsule(f, jx - ux * 2.6 * k - nx * 0.6 * k, jy - uy * 2.6 * k - ny * 0.6 * k, jx - ux * 0.2 * k - nx * 0.6 * k, jy - uy * 0.2 * k - ny * 0.6 * k, 1.9 * k, 1.9 * k, dark, { shift: sft, ...EW });
  for (let i = 0; i < 3; i++) {
    const q = -2.2 + i * 0.8;
    px(f, Math.round(jx + ux * q * k - nx * 1.9 * k), Math.round(jy + uy * q * k - ny * 1.9 * k), dark[4]);
  }
  // serrated inner faces of the jaws
  for (let i = 0; i < 4; i++) {
    px(f, Math.round(jx + nx * (1.0 + i * 1.0) * k + ux * 2.0 * k), Math.round(jy + ny * (1.0 + i * 1.0) * k + uy * 2.0 * k), steel[0]);
    px(f, Math.round(mx2 + nx * (0.4 + i * 0.6) * k - ux * 1.6 * k), Math.round(my2 + ny * (0.4 + i * 0.6) * k - uy * 1.6 * k), steel[0]);
  }
}

/**
 * Sparker - the clerk from Launch Records. Slate uniform and peaked cap,
 * round spectacles, a mustache doing its best, a lanyard of ID badges, a
 * pocket protector, and a snub electro-pistol on a cable to a battery pack.
 */
function makeSparker() {
  const slate = rgba(104, 114, 132, 255);
  const R = {
    torso: mat(slate, { contrast: 1.15 }), sleeve: mat(rgba(122, 134, 156, 255), { contrast: 1.15 }),
    trouser: mat(rgba(80, 86, 104, 255), { contrast: 1.12 }),
    boot: mat(rgba(30, 28, 34, 255), { contrast: 1.4 }), toeCap: mat(rgba(40, 38, 46, 255), { contrast: 1.5 }),
    sole: flat(rgba(14, 12, 16, 255)),
    glove: mat(rgba(222, 178, 150, 255), { contrast: 1.2 }),
    cuff: mat(rgba(214, 218, 222, 255), { contrast: 1.1 }),
    skin: mat(rgba(226, 186, 158, 255), { contrast: 1.2 }),
    neck: mat(rgba(226, 186, 158, 255), { contrast: 1.2 }),
    tie: mat(rgba(188, 40, 44, 255), { contrast: 1.25 }),
    shirt: mat(rgba(222, 226, 228, 255), { contrast: 1.1 }),
    steel: mat(rgba(140, 146, 158, 255), { contrast: 1.3 }),
    copper: mat(rgba(200, 116, 52, 255), { contrast: 1.3 }),
    dark: mat(rgba(34, 34, 42, 255)),
    cap: mat(rgba(52, 58, 76, 255), { contrast: 1.3 }),
    brass: mat(rgba(220, 176, 70, 255), { contrast: 1.3 }),
    badge: mat(rgba(226, 220, 196, 255)),
    hair: mat(rgba(92, 64, 44, 255), { contrast: 1.2 }),
    pack: mat(rgba(90, 100, 84, 255), { contrast: 1.25 }),
  };
  const ch = {
    id: 'sparker', w: 64, h: 72, dieW: 104, k: K,
    hipY: 33, shoulderY: 51, neckY: 54.4, headY: 59.8, neckZ: 0.8, headZ: 1.6,
    shoulderHalf: 9.2, legHalf: 4.2, ankleY: 3.4, footLen: 5.0,
    thigh: 15.4, shin: 15, upper: 12, fore: 11.5,
    armThick: 2.7, legThick: 3.3, stride: 9, lift: 7, hipDip: 1.6, lean: 0.12,
    // a twitchy trot: high knees, quick feet, head never quite still
    gait: { duty: 0.5, twist: 0.16, bob: 0.8, jitter: 1.1, leanBob: 0.05, strike: 0.26, push: 0.55, breath: 0.9 },
    neckR: 1.9, lieH: 14, handScale: 1.05, bootScale: 0.9,
    edge: rgba(16, 16, 24, 255),
    profile: [[0, 6.6, 4.8], [0.4, 6.8, 5.0], [0.78, 8.8, 5.6], [1, 8.4, 5.0]],
    ramps: R,
    head(f, c) {
      const { hd, theta, E, k, pose } = c;
      const fw = Math.cos(theta), sd = Math.sin(theta);
      const face = fw > 0.35, back = fw < -0.35, s = sd >= 0 ? 1 : -1;
      const g = pen(f, hd.x, hd.y, k, 1, c.rot || 0, c.sy || 1);
      const dead = pose && (pose.dead || pose.severed);
      // big ears first, then a long worried head
      if (face || back) for (const ex of [-4.6, 4.6]) g.blob(ex, 0.8, 1.3, 1.8, R.skin, { ...E, shift: -1 });
      g.blob(0, 0.5, 4.3, 5.2, R.skin, { grain: 0.04, seed: 81, ...E, spec: R.skin[4] });
      // peaked cap with a brass badge
      g.blob(0, -3.7, 4.9, 2.9, R.cap, { ...E, spec: R.cap[4] });
      g.rect(-4.8, -2.3, 9.6, 0.9, R.dark[1]);
      if (face) {
        g.blob(0, -1.6, 4.6, 0.9, R.dark, { shift: 1 });
        g.blob(0, -4.4, 1.0, 0.9, R.brass, { spec: rgba(255, 250, 220, 255) });
        // spectacles: big round glass that catches the light
        for (const ex of [-1.9, 1.9]) {
          g.blob(ex, 0.4, 1.65, 1.55, flat(R.dark[1]));
          g.blob(ex, 0.4, 1.2, 1.1, flat(mix(rgba(196, 226, 236, 255), R.skin[2], 0.4)));
          if (dead) {
            g.line(ex - 0.7, -0.3, ex + 0.7, 1.1, R.dark[0]); g.line(ex - 0.7, 1.1, ex + 0.7, -0.3, R.dark[0]);
          } else {
            g.blob(ex + 0.2, 0.6, 0.55, 0.55, flat(rgba(20, 20, 30, 255)));
            g.dot(ex - 0.5, -0.2, rgba(255, 255, 255, 255));
          }
        }
        g.dot(0, 0.2, R.dark[1]);
        // nose, mustache, and a mouth frozen mid-yelp
        g.blob(0, 2.0, 0.9, 1.1, R.skin, { shift: 1 });
        g.cap(-1.9, 3.3, 1.9, 3.3, 0.7, 0.7, R.hair, { shift: 0 });
        g.dot(-1.9, 3.8, R.hair[1]); g.dot(1.9, 3.8, R.hair[1]);
        if (pose.gasp || dead) g.blob(0, 4.5, 1.0, dead ? 0.6 : 0.9, flat(rgba(60, 14, 20, 255)));
        else g.line(-1, 4.5, 1, 4.5, R.skin[0]);
        if (dead) g.blob(0.6, 5.2, 0.6, 0.8, flat(rgba(226, 100, 110, 255)));
        // a bead of sweat on the temple
        g.blob(3.4, -0.6, 0.45, 0.7, flat(rgba(200, 236, 255, 255)));
      } else if (!back) {
        const q = pen(f, hd.x, hd.y, k, s, c.rot || 0, c.sy || 1);
        q.blob(-0.6, 0.8, 1.2, 1.7, R.skin, { ...E, shift: -1 });
        q.cap(0.8, -1.8, 5.8, -1.6, 0.8, 0.6, R.cap, { ...E });
        q.blob(2.6, 0.4, 1.2, 1.1, flat(mix(rgba(196, 226, 236, 255), R.skin[2], 0.4)));
        q.line(1.4, 0.2, -0.6, 0.2, R.dark[1]);
        q.dot(2.9, 0.4, dead ? R.dark[1] : rgba(20, 20, 30, 255));
        q.blob(4.6, 1.8, 0.9, 1.0, R.skin, { shift: 1 });
        q.cap(3.4, 3.2, 4.6, 3.3, 0.6, 0.6, R.hair);
        q.line(-3.6, 1.0, -3.8, 4, R.hair[1]);
      } else {
        g.blob(0, 1.6, 3.6, 2.8, R.hair, { shift: -1 });
        g.line(-2, 4.6, 2, 4.6, R.skin[0]);
      }
    },
    torsoDetail(c) {
      const { f, theta, k, hipY } = c;
      const fw = Math.cos(theta);
      torsoBand(c, hipY + 1.0, 1.6, R.dark, { shift: 1 });
      if (fw > 0.3) {
        // white shirt placket and a red tie, knotted too tight
        const a = surf(c, 0, ch.shoulderY + 0.6), b = surf(c, 0, hipY + 4);
        for (let y = Math.round(a.y); y <= Math.round(a.y + 2.4 * k); y++) {
          const w = Math.round(2.2 * k - (y - a.y) * 0.5);
          for (let x = -w; x <= w; x++) over(f, a.x + x, y, R.shirt[x < 0 ? 3 : 2], 1);
        }
        blob(f, a.x, a.y + 1.8 * k, 1.0 * k, 0.9 * k, R.tie, { spec: R.tie[4] });
        fillPoly(f, [{ x: a.x - 0.8 * k, y: a.y + 2.4 * k }, { x: a.x + 0.8 * k, y: a.y + 2.4 * k },
          { x: b.x + 1.4 * k, y: b.y - 1.5 * k }, { x: b.x, y: b.y }, { x: b.x - 1.4 * k, y: b.y - 1.5 * k }], R.tie[2]);
        line(f, Math.round(a.x - 0.8 * k), Math.round(a.y + 2.4 * k), Math.round(b.x - 1.4 * k), Math.round(b.y - 1.5 * k), R.tie[4]);
        for (let i = 0; i < 3; i++) px(f, Math.round(b.x), Math.round(a.y + (5 + i * 4) * k), R.tie[0]);
        // pocket protector full of pens
        const pk = surf(c, -4.2, ch.shoulderY - 4.2);
        box(f, Math.round(pk.x - 1.8 * k), Math.round(pk.y - 1.0 * k), Math.round(3.6 * k), Math.round(3.0 * k), R.shirt, {});
        const pens = [rgba(30, 60, 200, 255), rgba(200, 30, 30, 255), rgba(30, 30, 34, 255), rgba(40, 150, 60, 255)];
        for (let i = 0; i < 4; i++) {
          fillRect(f, Math.round(pk.x - 1.4 * k + i * 0.9 * k), Math.round(pk.y - 2.2 * k), 1, Math.round(1.6 * k), pens[i]);
        }
        // lanyard badges on his right chest, one of them upside down
        const ly = surf(c, 3.6, ch.shoulderY - 2.4);
        for (let i = 0; i < 3; i++) {
          const bx = ly.x - 1.6 * k + i * 1.8 * k, by = ly.y + i * 1.3 * k;
          line(f, Math.round(a.x + 1), Math.round(a.y + 1), Math.round(bx), Math.round(by), R.tie[1]);
          box(f, Math.round(bx - 0.8 * k), Math.round(by), Math.max(2, Math.round(1.8 * k)), Math.round(2.6 * k), R.badge, {});
          px(f, Math.round(bx), Math.round(by + (i === 1 ? 2.2 : 0.8) * k), i % 2 ? rgba(200, 50, 44, 255) : rgba(60, 130, 220, 255));
        }
      } else if (fw < -0.3) {
        stitch(f, surf(c, 0, ch.shoulderY, -1).x, surf(c, 0, ch.shoulderY, -1).y, surf(c, 0, hipY + 2, -1).x, surf(c, 0, hipY + 2, -1).y, R.torso[1], 0.6, 2, 1);
      }
    },
    legDetail(c, L, h2, k2, f2, sft) {
      // a knife-edge crease down the front of each trouser leg
      const q = 0.35;
      over(c.f, lerp(h2.x, k2.x, q), lerp(h2.y, k2.y, q), R.trouser[4], 0.5);
      over(c.f, lerp(k2.x, f2.x, q), lerp(k2.y, f2.y, q), R.trouser[4], 0.5);
    },
    gear(c) {
      const { f, add, P, arms, pose, theta, k, mask, hipY } = c;
      const E = { edge: ch.edge, edgeW: 0.9 };
      const chg = pose.charge === undefined ? 0.25 : pose.charge;
      // battery pack on the back, a sticker-covered army-surplus box
      const pk = P(c.U(0, ch.shoulderY - 6.5, -6.4));
      add(pk.z - 0.4, () => {
        const wpx = (Math.abs(Math.cos(theta)) * 5.4 + Math.abs(Math.sin(theta)) * 3.4) * k;
        const hh = 12 * k;
        box(f, Math.round(pk.x - wpx), Math.round(pk.y - hh / 2), Math.round(wpx * 2), Math.round(hh), R.pack, { grain: 0.07, seed: 91 });
        fillRect(f, Math.round(pk.x - wpx), Math.round(pk.y - hh / 2), Math.round(wpx * 2), Math.round(1.2 * k), R.steel[3]);
        const gc = mix(rgba(70, 240, 150, 255), rgba(255, 255, 245, 255), chg);
        const gy = Math.round(pk.y - 2 * k);
        fillRect(f, Math.round(pk.x - wpx + k), gy, Math.max(1, Math.round(wpx * 2 - 2 * k)), Math.round(1.6 * k), R.dark[0]);
        const bars = Math.max(1, Math.round((wpx * 2 - 2 * k) * (0.35 + 0.65 * chg)));
        for (let i = 0; i < bars; i += 2) fillRect(f, Math.round(pk.x - wpx + k) + i, gy, 1, Math.round(1.6 * k), gc);
        glow(f, pk.x - wpx + k + bars * 0.5, gy + k, (3 + chg * 4) * k, gc, { halo: chg > 0.6 ? 0.8 : 0.35, seed: 92, base: rgba(16, 30, 24, 255) });
        // the aerial: a whip antenna with a spark ball, crackling when charged
        const ax = pk.x + (Math.abs(Math.cos(theta)) > 0.5 ? wpx + k : wpx * 0.3), ay = pk.y - hh / 2;
        // lying down, the aerial snapped off in the fall
        const tipY = ay - (Math.abs(c.rot || 0) > 0.6 ? 3 : 22) * k;
        line(f, Math.round(ax), Math.round(ay), Math.round(ax + 1.5 * k), Math.round(tipY), R.steel[3]);
        line(f, Math.round(ax + 1), Math.round(ay), Math.round(ax + 1.5 * k + 1), Math.round(tipY), R.steel[1]);
        blob(f, ax + 1.5 * k, tipY, 1.4 * k, 1.4 * k, flat(mix(rgba(120, 200, 255, 255), rgba(255, 255, 255, 255), chg)), { edge: ch.edge, edgeW: 0.8 });
        glow(f, ax + 1.5 * k, tipY, (2.5 + chg * 3) * k, rgba(150, 220, 255, 255), { halo: 0.5 + chg * 0.4, seed: 93, base: rgba(30, 44, 70, 255) });
        if (chg > 0.5) arcs(f, ax + 1.5 * k, tipY, 5 * k, 3, 94);
        if (Math.cos(theta) < -0.3) {
          stencil(f, Math.round(pk.x - 5), Math.round(pk.y + 2 * k), 'HV', rgba(236, 200, 40, 255), 0.9);
          for (let i = 0; i < 3; i++) px(f, Math.round(pk.x + 3 + i * 2), Math.round(pk.y + 3 * k), R.steel[4]);
        }
      });
      // pistol in the right hand, cable looped to the pack
      if (mask & 2) {
        // no hand, no gun: the cable hangs loose and sparks
        const hp = P(c.U(-5, hipY + 1, -1));
        add(hp.z + 0.5, () => {
          const a = P(c.U(-1, ch.shoulderY - 10, -6.4));
          capsule(f, a.x, a.y, hp.x, hp.y + 6 * k, 0.9 * k, 0.9 * k, R.dark, { ...E });
          glow(f, hp.x, hp.y + 7 * k, 3 * k, rgba(200, 240, 255, 255), { halo: 0.8, seed: 99, base: rgba(40, 60, 90, 255) });
        });
        return;
      }
      const hand = arms[0].hand;
      const hp = P(hand);
      add(hp.z + 3, () => {
        const aim = pose.gunDir || V(0, 0.1, 1);
        const d = vnorm(aim);
        const t0 = P(vadd(hand, vmul(d, 0.8)));
        const t1 = P(vadd(hand, vmul(d, 6.5)));
        const slen = Math.hypot(t1.x - t0.x, t1.y - t0.y);
        if (slen < 4.5 * k) {
          // pointed at the camera: the business end, a coil ring round a dark bore
          blob(f, hp.x, hp.y - 1.6 * k, 3.4 * k, 3.2 * k, R.dark, { ...E });
          for (let a = 0; a < 6.283; a += 0.5) px(f, Math.round(hp.x + Math.cos(a) * 2.6 * k), Math.round(hp.y - 1.6 * k + Math.sin(a) * 2.4 * k), R.copper[a < 3 ? 4 : 2]);
          blob(f, hp.x, hp.y - 1.8 * k, 1.5 * k, 1.4 * k, R.steel, { shift: -1 });
          blob(f, hp.x, hp.y - 1.8 * k, 0.8 * k, 0.8 * k, flat(chg > 0.5 ? rgba(200, 240, 255, 255) : rgba(14, 14, 18, 255)));
        } else {
          capsule(f, t0.x, t0.y, t1.x, t1.y, 2.0 * k, 1.5 * k, R.dark, { shift: 1, ...E, spec: R.steel[4] });
          // copper coil rings
          for (let i = 0; i < 3; i++) {
            const q = 0.35 + i * 0.2;
            limbBand(f, t0, t1, q, 2.1 * k, 0.5 * k, R.copper, {});
          }
          blob(f, t1.x, t1.y, 1.8 * k, 1.8 * k, R.steel, { shift: -1 });
          blob(f, t1.x, t1.y, 0.9 * k, 0.9 * k, flat(chg > 0.5 ? rgba(200, 240, 255, 255) : rgba(14, 14, 18, 255)));
        }
        capsule(f, hp.x, hp.y + 1.2 * k, hp.x - 0.6 * k, hp.y + 4.2 * k, 1.5 * k, 1.3 * k, R.dark, { ...E });
        if (pose.muzzle) {
          // the discharge: a hard white star, a blue bloom, arcs crawling off it
          const m = pose.muzzle;
          const mz = P(vadd(hand, vmul(d, 8)));
          glow(f, mz.x, mz.y, (4 + 6 * m) * k, rgba(170, 220, 255, 255), { halo: 1, seed: 95, base: rgba(40, 60, 90, 255) });
          flare(f, mz.x, mz.y, (6 + 10 * m) * k, 8, rgba(236, 250, 255, 255), rgba(120, 190, 255, 255), 95 + Math.round(m * 7));
          glow(f, mz.x, mz.y, (1.5 + 2.5 * m) * k, rgba(255, 255, 255, 255), { halo: 1, seed: 96, base: rgba(160, 210, 240, 255) });
          arcs(f, mz.x, mz.y, (5 + 7 * m) * k, m > 0.7 ? 7 : 3, 95);
        } else if (chg > 0.5) {
          glow(f, t1.x, t1.y, 2.8 * k, rgba(150, 220, 255, 255), { halo: 0.5, seed: 97, base: rgba(30, 44, 60, 255) });
          arcs(f, t1.x, t1.y, 4 * k, 2, 98);
        }
        if (pose.smoke) puffs(f, t1.x, t1.y - 2 * k, k, 4, 97, rgba(150, 160, 176, 255));
        // cable: hand, a loop past the hip, the pack
        const pts = [P(vadd(hand, V(0, -2, -1))), P(c.U(-5, ch.hipY + 2, -1)),
          P(c.U(-6, ch.hipY + 8, -5)), P(c.U(-1, ch.shoulderY - 10, -6.4))];
        for (let i = 0; i < pts.length - 1; i++) {
          capsule(f, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, 0.9 * k, 0.9 * k, R.dark, { ...E });
          line(f, Math.round(pts[i].x - 0.5), Math.round(pts[i].y - 0.5), Math.round(pts[i + 1].x - 0.5), Math.round(pts[i + 1].y - 0.5), R.steel[1]);
        }
      });
    },
  };
  return ch;
}

/** Jagged electric arcs out of a point. */
function arcs(f, x, y, r, n, seed) {
  for (let i = 0; i < n; i++) {
    let a = hash2(i, seed, 1) * 6.283, px0 = x, py0 = y;
    const segs = 4;
    for (let s = 1; s <= segs; s++) {
      a += (hash2(i, s, seed) - 0.5) * 1.6;
      const rr = r * s / segs;
      const nx = x + Math.cos(a) * rr, ny = y + Math.sin(a) * rr;
      line(f, Math.round(px0), Math.round(py0), Math.round(nx), Math.round(ny), s < 3 ? rgba(240, 252, 255, 255) : rgba(150, 210, 255, 255));
      px0 = nx; py0 = ny;
    }
  }
}

/**
 * A muzzle star: n tapering rays, long and short alternately, hot at the
 * middle. Opaque, like everything else here, so it reads at any distance.
 */
function flare(f, x, y, r, n, hot, cool, seed) {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + hash2(i, seed, 3) * 0.3;
    const L = r * (i % 2 ? 0.5 : 1) * (0.75 + 0.25 * hash2(i, seed, 4));
    const ux = Math.cos(a), uy = Math.sin(a);
    for (let s = 0; s < L; s += 0.5) {
      const w = (1 - s / L) * Math.max(1, r * 0.12);
      for (let o = -w; o <= w; o += 0.5) px(f, x + ux * s - uy * o, y + uy * s + ux * o, s < L * 0.45 ? hot : cool);
    }
  }
  blob(f, x, y, r * 0.22, r * 0.22, flat(hot));
}

/** A stack of dirty smoke puffs drifting up and a little sideways. */
function puffs(f, x, y, k, n, seed, c) {
  for (let i = 0; i < n; i++) {
    const t = i / Math.max(1, n - 1);
    glow(f, x + (Math.sin(i * 1.9 + seed) * 2.5 + t * 3) * k, y - i * 3.2 * k, (2 + t * 2.6) * k,
      mix(c, rgba(34, 32, 36, 255), t * 0.6), { halo: 0.75 - t * 0.35, seed: seed + i * 7, base: mix(c, rgba(20, 20, 24, 255), 0.6), core: 0.6 });
  }
}

/**
 * A motion smear: a stippled band from a to b, thinning and thinning out
 * toward the end the thing has already left.
 */
function smearBand(f, a, b, r, c, density, seed) {
  const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1;
  const ux = dx / L, uy = dy / L;
  for (let s = 0; s <= L; s += 0.6) {
    const q = s / L;
    const w = r * (0.4 + 0.6 * q);
    for (let o = -w; o <= w; o += 0.6) {
      const x = a.x + ux * s - uy * o, y = a.y + uy * s + ux * o;
      if (hash2(Math.round(x), Math.round(y), seed) > density * (0.35 + 0.65 * q)) continue;
      px(f, x, y, c);
    }
  }
}

/**
 * Bellows - the fire team. A barrel of a man in an aluminised proximity suit
 * with a gold visor, a pressure gauge on his chest, twin hazard-striped tanks
 * on his back with a bright valve (shoot it), and a hose to the nozzle.
 */
function makeBellows() {
  const suit = rgba(178, 176, 168, 255);
  const R = {
    torso: mat(suit, { contrast: 1.3 }), sleeve: mat(rgba(164, 162, 156, 255), { contrast: 1.3 }),
    shoulder: mat(rgba(170, 168, 160, 255), { contrast: 1.3 }),
    trouser: mat(rgba(150, 148, 142, 255), { contrast: 1.3 }),
    boot: mat(rgba(44, 36, 30, 255), { contrast: 1.2 }), sole: flat(rgba(20, 16, 14, 255)),
    toeCap: mat(rgba(60, 50, 40, 255), { contrast: 1.2 }),
    glove: mat(rgba(120, 88, 50, 255), { contrast: 1.25 }),
    cuff: mat(rgba(96, 70, 42, 255), { contrast: 1.2 }),
    neck: mat(rgba(150, 148, 142, 255), { contrast: 1.3 }),
    tank: mat(rgba(186, 44, 36, 255), { contrast: 1.25 }),
    hazard: mat(rgba(236, 192, 40, 255), { contrast: 1.2 }),
    steel: mat(rgba(104, 108, 118, 255), { contrast: 1.3 }),
    brass: mat(rgba(210, 168, 72, 255), { contrast: 1.3 }),
    dark: mat(rgba(40, 36, 38, 255)),
    visor: mat(rgba(236, 176, 60, 255), { contrast: 1.45 }),
    soot: rgba(34, 28, 26, 255),
  };
  const ch = {
    id: 'bellows', w: 64, h: 72, dieW: 108, k: K,
    hipY: 27, shoulderY: 46, neckY: 48.2, headY: 53.8, neckZ: 1.0, headZ: 1.8,
    shoulderHalf: 14, legHalf: 6.9, ankleY: 4.4, footLen: 6.0,
    thigh: 12.4, shin: 11.6, upper: 11, fore: 10.5,
    armThick: 4.5, legThick: 5.6, stride: 6.4, lift: 3.4, hipDip: 2.0, lean: 0.05,
    // a tank's walk: short heavy steps, the whole barrel rocking over each one
    gait: { duty: 0.64, sway: 2.0, tilt: 0.09, twist: 0.05, bob: 0.3, wide: 1.1, strike: 0.12, push: 0.25 },
    slices: 16, neckR: 4.4, lieH: 21, handScale: 1.1,
    edge: rgba(26, 22, 18, 255),
    profile: [[0, 13.2, 9.8], [0.3, 15.8, 12.0], [0.58, 15.4, 11.4], [0.85, 13.6, 9.6], [1, 12.4, 8.6]],
    ramps: R,
    head(f, c) {
      const { hd, theta, E, k, pose } = c;
      const fw = Math.cos(theta), sd = Math.sin(theta);
      const face = fw > 0.35, back = fw < -0.35, s = sd >= 0 ? 1 : -1;
      const g = pen(f, hd.x, hd.y, k, 1, c.rot || 0, c.sy || 1);
      // proximity hood: a boxy aluminised helmet with a cape over the shoulders
      g.blob(0, 2.8, 7.4, 4.2, R.torso, { grain: 0.06, seed: 101, ...E });
      g.blob(0, -0.4, 6.2, 6.4, R.torso, { grain: 0.05, seed: 102, ...E, spec: rgba(255, 255, 255, 255), specT: 0.95 });
      g.rect(-6.0, -4.6, 12.0, 0.9, R.torso[1]);
      const cracked = pose && (pose.dead || pose.severed);
      if (face) {
        // gold visor: a wide lozenge reflecting the room
        g.blob(0, 0.2, 4.8, 3.2, flat(R.dark[0]), {});
        g.blob(0, 0.1, 4.3, 2.7, R.visor, { shift: 0 });
        for (let i = 0; i < 3; i++) g.line(-3.4 + i * 1.2, -1.8, -1.6 + i * 1.2, 1.4, mix(R.visor[4], WARM, 0.5));
        g.line(-4, 1.4, 4, 1.4, R.visor[0]);
        if (cracked) {
          g.line(-1, -2, 1.5, 0.6, R.dark[0]); g.line(1.5, 0.6, 0.4, 2.4, R.dark[0]); g.line(1.5, 0.6, 3.6, 0.2, R.dark[0]);
        } else {
          // two eyes glowing behind the gold
          g.glow(-1.6, 0.2, 2.2, rgba(255, 236, 160, 255), { halo: 0, seed: 106 });
          g.glow(1.6, 0.2, 2.2, rgba(255, 236, 160, 255), { halo: 0, seed: 107 });
        }
        // breathing valve below the visor, riveted
        g.blob(0, 4.6, 2.2, 1.5, R.steel, { ...E, spec: rgba(255, 255, 255, 255) });
        for (let i = -1; i <= 1; i++) g.dot(i * 1.0, 4.7, R.dark[0]);
        for (let i = 0; i < 6; i++) {
          const a = i * Math.PI / 3 + 0.3;
          g.dot(Math.cos(a) * 5.4, -0.2 + Math.sin(a) * 4.1, R.torso[4]);
        }
      } else if (!back) {
        const q = pen(f, hd.x, hd.y, k, s, c.rot || 0, c.sy || 1);
        q.blob(3.6, 0.2, 2.4, 2.8, flat(R.dark[0]));
        q.blob(3.8, 0.1, 1.9, 2.3, R.visor, {});
        q.line(3.0, -1.6, 4.4, 1.2, mix(R.visor[4], WARM, 0.5));
        q.blob(4.2, 4.2, 1.6, 1.3, R.steel, { ...E });
        // breathing hose from the valve back to the tanks
        for (let i = 0; i < 6; i++) q.blob(3.4 - i * 1.3, 5.4 + i * 0.9, 1.3, 1.1, R.dark, { shift: i % 2 ? 0 : 1 });
      } else {
        g.line(0, -5, 0, 4, R.torso[1]);
        g.stitch(-5, 0, 5, 0, R.torso[1], 0.6);
      }
      // soot from the day job
      for (let i = 0; i < 12; i++) g.over((hash2(i, 1, 108) - 0.5) * 11, -4 + hash2(i, 2, 108) * 9, R.soot, 0.35);
    },
    torsoDetail(c) {
      const { f, theta, k, hipY } = c;
      const fw = Math.cos(theta);
      // quilted panels and a heavy belt under the belly
      torsoBand(c, ch.shoulderY - 4, 0.8, R.torso, { shift: -1 });
      torsoBand(c, ch.shoulderY - 12, 0.8, R.torso, { shift: -1 });
      torsoBand(c, hipY + 1.6, 3.0, R.dark, { grain: 0.06, seed: 9, shift: 1 });
      if (fw > 0.3) {
        const bk = surf(c, 0, hipY + 1.6);
        box(f, Math.round(bk.x - 2.6 * k), Math.round(bk.y - 1.6 * k), Math.round(5.2 * k), Math.round(3.2 * k), R.brass, {});
        stencil(f, Math.round(bk.x - 5), Math.round(bk.y - 2), 'FD', R.dark[0], 0.9);
        // pressure gauge on the chest, needle in the red
        const gg = surf(c, 4.6, ch.shoulderY - 7.5);
        blob(f, gg.x, gg.y, 2.6 * k, 2.6 * k, R.brass, { edge: ch.edge, edgeW: 0.9 });
        blob(f, gg.x, gg.y, 1.9 * k, 1.9 * k, flat(rgba(236, 232, 214, 255)));
        for (let a = 3.6; a < 6.2; a += 0.45) px(f, Math.round(gg.x + Math.cos(a) * 1.6 * k), Math.round(gg.y + Math.sin(a) * 1.6 * k), a > 5.4 ? rgba(210, 30, 30, 255) : R.dark[1]);
        line(f, Math.round(gg.x), Math.round(gg.y), Math.round(gg.x + 1.3 * k), Math.round(gg.y - 0.8 * k), rgba(200, 20, 20, 255));
        // the fire team motto, across the chest
        const wz = surf(c, 0, ch.shoulderY - 2.6);
        stencil(f, Math.round(wz.x - 12), Math.round(wz.y - 2), 'NO FUN', rgba(190, 40, 30, 255), 0.85);
      }
      // scorch on the suit: fine soot, heavier toward the gut and the cuffs
      const t0 = torsoAt(c, hipY + 8);
      for (let j = 0; j < 22 * k; j++) {
        for (let i = -Math.round(t0.rx); i <= Math.round(t0.rx); i++) {
          const y = Math.round(t0.y + 6 * k - j);
          const t = j / (22 * k);
          if (hash2(t0.x + i, y, 108) > 0.22 * (1 - t * 0.7) * (1 - Math.abs(i) / (t0.rx + 2))) continue;
          over(f, t0.x + i, y, R.soot, 0.45);
        }
      }
    },
    armDetail(c, A, s2, e2, h2, sft) {
      creases(c.f, e2, h2, ch.armThick * c.k, 2, R.sleeve[1], 0.2, 0.45, 0.5);
    },
    gear(c) {
      const { f, add, P, arms, pose, theta, k, mask, hipY } = c;
      const E = { edge: ch.edge, edgeW: 0.9 };
      // twin tanks, red with yellow hazard bands; the valve is the weak point
      for (let i = 0; i < 2; i++) {
        const side = i === 0 ? 1 : -1;
        const tp = P(c.U(side * 7.4, ch.shoulderY - 8, -11));
        add(tp.z - 0.5, () => {
          const sft = tp.z < -2 ? -1 : 0;
          const tr = 4.4 * k;
          for (let q = 0; q <= 12; q++) {
            const t = q / 12;
            blob(f, tp.x, tp.y + (-8 + t * 17) * k, tr, 1.6 * k, R.tank, { mode: 'cyl', nyBias: -0.1, shift: sft, grain: 0.06, seed: 111 + q });
          }
          blob(f, tp.x, tp.y - 8.4 * k, tr, 2.4 * k, R.tank, { shift: sft, spec: rgba(255, 220, 210, 255) });
          blob(f, tp.x, tp.y + 8.6 * k, tr, 2.2 * k, R.tank, { shift: sft - 1 });
          for (const by of [-3.6, 3.4]) {
            for (let y = Math.round(tp.y + by * k); y < Math.round(tp.y + (by + 2) * k); y++) {
              for (let x = Math.round(tp.x - tr); x <= Math.round(tp.x + tr); x++) {
                if (!(getpx(f, x, y) >>> 24)) continue;
                const st = ((x + y) % 6 + 6) % 6 < 3;
                const u = (x - tp.x) / tr;
                const b = clamp(band(lamOf(u, -0.1, Math.sqrt(Math.max(0, 1 - u * u)))) + sft, 0, 4);
                px(f, x, y, st ? R.hazard[b] : R.dark[b]);
              }
            }
          }
          blob(f, tp.x, tp.y - 10.4 * k, 2.2 * k, 1.8 * k, R.brass, { shift: 1 });
          blob(f, tp.x, tp.y - 11.6 * k, 1.4 * k, 1.1 * k, R.brass, { shift: 1 });
          glow(f, tp.x, tp.y - 11.4 * k, 4.6 * k, rgba(255, 246, 200, 255), { halo: 0.7, seed: 113, base: rgba(46, 34, 18, 255) });
          px(f, Math.round(tp.x - 0.5), Math.round(tp.y - 11.8 * k), rgba(255, 255, 240, 255));
        });
      }
      // hose from the tanks to the nozzle
      if (mask & 2) {
        add(P(c.U(8, hipY, -4)).z + 1, () => {
          const a = P(c.U(4, ch.shoulderY - 12, -9)), b = P(c.U(10, hipY - 6, -2));
          capsule(f, a.x, a.y, b.x, b.y, 1.5 * k, 1.5 * k, R.dark, { ...E });
          glow(f, b.x, b.y + 2 * k, 3 * k, rgba(255, 170, 80, 255), { halo: 0.8, seed: 118, base: rgba(50, 24, 10, 255) });
        });
        return;
      }
      const hand = arms[0].hand;
      const hp = P(hand);
      add(hp.z + 3.2, () => {
        const a2 = P(c.U(4, ch.shoulderY - 12, -9));
        const pts = [a2, P(c.U(8, ch.hipY + 1, -4)), P(vadd(hand, V(0, -3, -2))), hp];
        for (let i = 0; i < pts.length - 1; i++) {
          capsule(f, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, 1.5 * k, 1.5 * k, R.dark, { ...E });
          for (let q = 0.2; q < 1; q += 0.25) over(f, lerp(pts[i].x, pts[i + 1].x, q), lerp(pts[i].y, pts[i + 1].y, q) - k, R.dark[4], 0.7);
        }
        // nozzle: a steel wand with a flared tip and a pilot light
        const d = vnorm(pose.gunDir || V(0, 0.05, 1));
        const n0 = P(vadd(hand, vmul(d, 1.5)));
        const n1 = P(vadd(hand, vmul(d, 11)));
        const nlen = Math.hypot(n1.x - n0.x, n1.y - n0.y);
        if (nlen < 5 * k) {
          blob(f, n0.x, n0.y - k, 4.0 * k, 3.8 * k, R.steel, { grain: 0.05, seed: 115, ...E });
          blob(f, n0.x, n0.y - k, 2.2 * k, 2.1 * k, R.dark, { shift: 1 });
        } else {
          capsule(f, n0.x, n0.y, n1.x, n1.y, 1.8 * k, 1.5 * k, R.steel, { grain: 0.06, seed: 115, ...E, spec: rgba(255, 255, 255, 255) });
          limbBand(f, n0, n1, 0.2, 2.4 * k, 2.4 * k, R.dark, {});
          blob(f, n1.x, n1.y, 2.6 * k, 2.6 * k, R.steel, { shift: -1, ...E });
          blob(f, n1.x, n1.y, 1.4 * k, 1.4 * k, R.dark, { shift: 1 });
        }
        const tipv = nlen < 5 * k ? vadd(hand, V(0, -1, 2)) : vadd(hand, vmul(d, 12));
        const pf = P(tipv);
        if (pose.flame) {
          // the gout: it comes at you, so it grows as it comes, rolling and
          // billowing, white at the nozzle and dirty orange at the edges
          const fl = pose.flame, fs = pose.flameSeed || 0;
          const tip3 = vadd(hand, vmul(d, 12 + 26 * fl));
          const pe = P(tip3);
          const toward = clamp(d.z, 0, 1);
          for (let i = 34; i >= 0; i--) {
            const t = i / 34;
            const wob = Math.sin(i * 2.3 + fs) * t;
            const q = {
              x: lerp(pf.x, pe.x, t) + wob * (5 + 5 * fl) * k,
              y: lerp(pf.y, pe.y, t) + Math.cos(i * 1.7 + fs) * t * 4 * k - t * t * 6 * k * fl,
            };
            const r = (2.6 + t * (7 + 9 * toward) * fl) * k * (1 + 0.22 * Math.sin(i * 2.1 + fs));
            const col = t < 0.3 ? mix(rgba(255, 255, 240, 255), rgba(255, 214, 90, 255), t / 0.3)
              : mix(rgba(255, 196, 60, 255), rgba(206, 56, 14, 255), (t - 0.3) / 0.7);
            glow(f, q.x, q.y, r, col, { halo: 1, seed: 120 + i, base: rgba(90, 26, 8, 255), core: 0.45 });
          }
          // greasy black smoke rolling off the top of it
          puffs(f, pe.x, pe.y - 6 * k * fl, k * (1 + fl * 0.6), 5, 121 + Math.round(fs * 3), rgba(70, 58, 52, 255));
          glow(f, pf.x, pf.y, 5.5 * k, rgba(255, 255, 246, 255), { halo: 1, seed: 119, base: rgba(140, 70, 22, 255) });
        } else {
          // the pilot: a blue tongue that grows into a roar as he winds up
          const pl = pose.pilot === undefined ? 1 : pose.pilot;
          if (pl > 0) {
            glow(f, pf.x, pf.y, (1.6 + 1.6 * pl) * k, rgba(120, 170, 255, 255), { halo: 0.7, seed: 118, base: rgba(20, 24, 50, 255) });
            glow(f, pf.x, pf.y - pl * k, (1 + 1.2 * pl) * k, rgba(255, 210, 120, 255), { halo: 0.6, seed: 117, base: rgba(50, 24, 10, 255) });
            if (pl > 1.5) flare(f, pf.x, pf.y, (3 + 2 * pl) * k, 6, rgba(220, 236, 255, 255), rgba(90, 140, 255, 255), 116);
          }
          if (pose.smoke) {
            puffs(f, pf.x, pf.y - 3 * k, k, 5, 115, rgba(84, 74, 70, 255));
            for (let i = 0; i < 3; i++) drip(f, Math.round(pf.x + (i - 1) * k), Math.round(pf.y + k), 2 + i, rgba(255, 170, 60, 255), 0.8);
          }
        }
      });
    },
  };
  return ch;
}

/**
 * Ordnance Priest - tall hooded figure in a rubber apron-robe with gold trim,
 * a stole embroidered with fallout trefoils, a rosary of rifle cartridges, a
 * censer on a chain and, when it prays, a floating reliquary. No legs: the
 * robe is a cone with a swaying hem and boot tips peeking out.
 */
function makePriest() {
  const robe = rgba(56, 66, 58, 255);
  const R = {
    torso: mat(robe, { contrast: 1.1 }), sleeve: mat(shade(robe, 0.9), { contrast: 1.1 }),
    trouser: mat(shade(robe, 0.8)), boot: mat(rgba(34, 32, 32, 255)),
    glove: mat(rgba(196, 186, 160, 255), { contrast: 1.2 }),
    neck: mat(rgba(44, 50, 46, 255), { contrast: 1.15 }),
    hood: mat(rgba(44, 50, 46, 255), { contrast: 1.15 }),
    void: flat(rgba(10, 12, 14, 255)),
    chain: mat(rgba(160, 160, 168, 255), { contrast: 1.3 }),
    brass: mat(rgba(196, 156, 66, 255), { contrast: 1.35 }),
    gold: mat(rgba(222, 184, 70, 255), { contrast: 1.35 }),
    apron: mat(rgba(78, 88, 78, 255), { contrast: 1.1 }),
    stole: mat(rgba(150, 30, 36, 255), { contrast: 1.25 }),
    rope: mat(rgba(176, 150, 100, 255), { contrast: 1.2 }),
    copper: mat(rgba(196, 116, 56, 255), { contrast: 1.3 }),
  };
  const ch = {
    id: 'priest', w: 64, h: 80, dieW: 112, k: K,
    hipY: 36, shoulderY: 56, neckY: 58.6, headY: 65.6, neckZ: 0.4, headZ: 0.8,
    shoulderHalf: 9.5, legHalf: 4.6, ankleY: 3.0, footLen: 4.2,
    thigh: 17, shin: 16, upper: 12.5, fore: 12,
    armThick: 3.0, legThick: 4.0, stride: 3.0, lift: 1.2, hipDip: 0.4, lean: 0.02,
    // it does not walk so much as glide, the hem doing all the work
    gait: { duty: 0.5, sway: 0.5, tilt: 0.02, twist: 0.03, bob: 0.1, strike: 0, push: 0 },
    robed: true, slices: 20, neckR: 3.0, lieH: 17,
    edge: rgba(14, 18, 16, 255),
    armPole: V(0.32, -0.85, -0.35),
    profile: [[0, 9.2, 7.2], [0.5, 9.8, 7.4], [0.8, 10.6, 7.6], [1, 9.8, 7.0]],
    ramps: R,
    head(f, c) {
      const { hd, theta, E, k, pose } = c;
      const fw = Math.cos(theta), sd = Math.sin(theta);
      const g = pen(f, hd.x, hd.y, k, 1, c.rot || 0, c.sy || 1);
      const dead = pose && (pose.dead || pose.severed);
      // cowl: a tall teardrop leaning back, with a heavy front rim
      for (let i = 0; i <= 12; i++) {
        const t = i / 12;
        g.blob(sd * (1 - t) * 2.4, -9 + t * 15, lerp(2.6, 8.0, Math.pow(t, 0.62)), 1.9, R.hood, { mode: 'cyl', nyBias: -0.3, grain: 0.05, seed: 131 + i, ...(i ? {} : E) });
      }
      g.blob(0, 3.6, 7.8, 5.0, R.hood, { grain: 0.05, seed: 145, ...E });
      const gg = pose.eyeGlow === undefined ? 1 : pose.eyeGlow;
      const ec = dead ? rgba(70, 90, 100, 255) : mix(rgba(126, 184, 214, 255), rgba(252, 254, 255, 255), gg);
      if (fw > 0.3) {
        for (let i = 0; i <= 9; i++) {
          const t = i / 9;
          g.blob(0, -3.4 + t * 10, lerp(2.2, 4.9, Math.pow(t, 0.5)), 1.6, R.void, { mode: 'cyl' });
        }
        for (const ex of [-2.4, 2.4]) {
          if (dead) { g.line(ex - 0.8, 0.4, ex + 0.8, 1.8, ec); g.line(ex - 0.8, 1.8, ex + 0.8, 0.4, ec); continue; }
          g.blob(ex, 1.2, 1.6, 1.3, flat(mix(ec, R.void[0], 0.4)));
          g.blob(ex, 1.0, 0.95, 0.85, flat(ec));
          g.glow(ex, 1.1, 3.2 + gg * 2.2, ec, { halo: 0, seed: 133 });
        }
        // breathing tube dangling out of the dark, to a canister on the chest
        for (let i = 0; i < 5; i++) g.blob(0.4 + Math.sin(i) * 0.4, 4.2 + i * 1.3, 0.9, 0.7, flat(i % 2 ? rgba(30, 32, 34, 255) : rgba(50, 54, 56, 255)));
        // gold trim round the hood opening
        for (let a = -1.5; a < 1.5; a += 0.07) {
          g.dot(Math.sin(a) * 6.4, 1.0 - Math.cos(a) * 7.2, R.gold[a < 0 ? 4 : 2]);
          g.dot(Math.sin(a) * 7.2, 1.0 - Math.cos(a) * 8.0, R.hood[a < 0 ? 3 : 1]);
        }
      } else if (Math.abs(sd) > 0.5) {
        const q = pen(f, hd.x, hd.y, k, sd > 0 ? 1 : -1, c.rot || 0, c.sy || 1);
        for (let i = 0; i <= 7; i++) {
          const t = i / 7;
          q.blob(2.2 + t * 2.2, -2.4 + t * 8, lerp(1.8, 3.2, t), 1.5, R.void, { mode: 'cyl' });
        }
        if (!dead) {
          q.blob(4.8, 1.0, 1.1, 1.0, flat(ec));
          q.glow(4.8, 1.0, 3.4, ec, { halo: 0, seed: 135 });
        }
        for (let a = -1.4; a < 1.4; a += 0.1) q.dot(3.0 + Math.cos(a) * 3.6, 0.6 + Math.sin(a) * 8.0, R.gold[3]);
      } else {
        for (let i = 0; i < 12; i++) g.dot(0, -7 + i, R.hood[i % 3 ? 1 : 3]);
        g.blob(0, 6.0, 3.0, 2.4, R.hood, { shift: -1 });
        g.stitch(-5, 2, 5, 2, R.gold[2], 0.8, 1, 1);
      }
    },
    torsoDetail(c) {
      const { f, theta, k, hipY } = c;
      const fw = Math.cos(theta);
      // rope cincture
      torsoBand(c, hipY + 2.6, 1.6, R.rope, { grain: 0.1, seed: 150 });
    },
    stoleDetail(c) {
      const { f, theta, k, hipY } = c;
      const fw = Math.cos(theta);
      if (fw < -0.25) {
        // a big gold trefoil embroidered across the back of the mantle
        const bc = surf(c, 0, ch.shoulderY - 5, -1);
        for (let j = 0; j < 3; j++) {
          const an = j * 2.094 - 1.57;
          blob(f, bc.x + Math.cos(an) * 2.2 * k, bc.y + Math.sin(an) * 2.2 * k, 1.6 * k, 1.6 * k, R.gold, { spec: R.gold[4] });
        }
        blob(f, bc.x, bc.y, 0.9 * k, 0.9 * k, R.hood, { shift: -1 });
      }
      if (fw > 0.25) {
        // the stole: two red bands down the front, trefoils embroidered in gold
        for (const sx of [-3.8, 3.8]) {
          const a = surf(c, sx * 0.8, ch.shoulderY), b = surf(c, sx, hipY + 4);
          capsule(f, a.x, a.y, b.x, b.y, 1.5 * k, 1.7 * k, R.stole, { edge: ch.edge, edgeW: 0.8, spec: R.stole[4] });
          for (let i = 0; i < 3; i++) {
            const q = 0.25 + i * 0.28;
            const tx = lerp(a.x, b.x, q), ty = lerp(a.y, b.y, q);
            for (let j = 0; j < 3; j++) {
              const an = j * 2.094 - 1.57;
              px(f, Math.round(tx + Math.cos(an) * 0.9 * k), Math.round(ty + Math.sin(an) * 0.9 * k), R.gold[4]);
            }
            px(f, Math.round(tx), Math.round(ty), R.gold[2]);
          }
          fillRect(f, Math.round(b.x - 1.5 * k), Math.round(b.y), Math.round(3 * k), 1, R.gold[3]);
        }
        // the rosary: a loop of cartridges
        const top = surf(c, 0, ch.shoulderY - 1);
        for (let i = 0; i < 11; i++) {
          const a = (i / 10) * Math.PI;
          const bx = top.x + Math.cos(a) * 4.2 * k, by = top.y + Math.sin(a) * 7.2 * k;
          fillRect(f, Math.round(bx), Math.round(by), 1, 2, i % 2 ? R.brass[4] : R.copper[3]);
        }
        const cz = surf(c, 0, ch.shoulderY - 9);
        blob(f, cz.x, cz.y, 1.6 * k, 1.8 * k, R.copper, { spec: rgba(255, 230, 190, 255), edge: ch.edge, edgeW: 0.8 });
        blob(f, cz.x, cz.y - 2 * k, 0.8 * k, 1.0 * k, R.copper, { shift: 1 });
      }
    },
    armDetail(c, A, s2, e2, h2, sft) {
      // bell sleeve flaring round the wrist
      const dx = h2.x - e2.x, dy = h2.y - e2.y, L = Math.hypot(dx, dy) || 1;
      const ux = dx / L, uy = dy / L;
      capsule(c.f, e2.x + dx * 0.35, e2.y + dy * 0.35, h2.x - ux * 1.4 * c.k, h2.y - uy * 1.4 * c.k, ch.armThick * c.k, ch.armThick * c.k * 1.7, R.sleeve,
        { shift: sft, ...c.E });
      limbBand(c.f, e2, h2, 0.72, ch.armThick * c.k * 1.72, 0.6 * c.k, R.gold, { shift: sft });
    },
    gear(c) {
      const { f, add, P, arms, pose, theta, hipY, k, mask } = c;
      const E = { edge: ch.edge, edgeW: 0.9 };
      const sway = pose.hem || 0;
      const legs = ((mask & 8) ? 1 : 0) + ((mask & 16) ? 1 : 0);
      const RS = { rot: c.rot, sy: c.sy };
      const topple = Math.abs(c.rot || 0) > 0.05;
      // robe cone from the hip to the floor - replaces the legs
      const rz = P(V(0, ch.hipY, 0));
      add(rz.z + 0.2, () => {
        const n = 26;
        const hemY = legs === 2 ? hipY - 3 : 0.6;
        for (let i = 0; i <= n; i++) {
          const t = i / n;
          const y = lerp(hipY + 3, hemY, t);
          const tt = legs === 2 ? t * 0.3 : t;
          const wide = lerp(9.4, 15.8, Math.pow(tt, 1.25));
          const dep = lerp(7.2, 12.4, Math.pow(tt, 1.25));
          const rx = Math.sqrt(Math.pow(wide * Math.cos(theta), 2) + Math.pow(dep * Math.sin(theta), 2)) * k;
          const p = P(V(sway * tt * 1.4, y, 0));
          blob(f, p.x, p.y, rx, 2.1 * k, R.torso, { mode: 'cyl', nyBias: -0.02, grain: 0.07, seed: 140 + i, ...RS });
        }
        const base = P(V(0, hemY + 0.2, 0));
        if (legs === 2) {
          // blown off at the thighs: a ragged hem and two stumps under it
          for (const side of [1, -1]) {
            const hj = P(V(side * ch.legHalf, hipY - 2, 0)), kn = P(V(side * ch.legHalf, 0, 1));
            stump(f, hj.x, hj.y, kn.x - hj.x, kn.y - hj.y, ch.legThick * k, R.trouser, { seed: 150 + side, len: 2.5 * k });
          }
        } else {
          // vertical folds
          for (let q = -3; q <= 3; q++) {
            if (q === 0) continue;
            const x0 = P(V(q * 2.4, hipY + 2, 0));
            const x1 = P(V(q * 4.6 + sway * 1.4, 1.2, 0));
            line(f, Math.round(x0.x), Math.round(x0.y), Math.round(x1.x), Math.round(x1.y), R.torso[q % 2 ? 1 : 0]);
          }
          // gold hem band and the boot tips under it
          const hw = Math.sqrt(Math.pow(15.8 * Math.cos(theta), 2) + Math.pow(12.4 * Math.sin(theta), 2)) * k;
          if (!topple) for (let x = Math.round(base.x - hw); x <= Math.round(base.x + hw); x++) {
            for (let y = f.h - Math.round(3.2 * k); y < f.h - Math.round(1.6 * k); y++) {
              const d = getpx(f, x, y);
              if (!(d >>> 24)) continue;
              const u = (x - base.x) / hw;
              px(f, x, y, R.gold[clamp(band(lamOf(u, 0, Math.sqrt(Math.max(0, 1 - u * u)))) - 1, 0, 4)]);
            }
          }
          const bt = pose.bootPhase || 0;
          for (const side of [1, -1]) {
            const bit = side > 0 ? 8 : 16;
            const b1 = P(V(side * 3.4, 0.6, 3.0 + side * Math.sin(bt) * 2.2));
            if (mask & bit) {
              for (let i = 0; i < 3; i++) drip(f, Math.round(b1.x - k + i * k), Math.round(f.h - 3 * k), Math.round(2 + i), GORE.blood, 0.9);
              continue;
            }
            capsule(f, b1.x, b1.y, b1.x, b1.y + 1.2 * k, 2.0 * k, 2.0 * k, R.boot, { spec: R.boot[4] });
          }
        }
      });
      // shoulder mantle over the robe
      const mz = P(c.U(0, ch.shoulderY - 2, 0));
      add(mz.z + 1.4, () => {
        for (let i = 0; i <= 8; i++) {
          const t = i / 8;
          const wide = lerp(9.0, 13.0, t), dep = lerp(7.4, 10.0, t);
          const rx = Math.sqrt(Math.pow(wide * Math.cos(theta), 2) + Math.pow(dep * Math.sin(theta), 2)) * k;
          const p = P(c.U(0, ch.shoulderY - t * 10, 0));
          blob(f, p.x, p.y, rx, 2.0 * k, R.hood, { mode: 'cyl', nyBias: -0.25, grain: 0.05, seed: 190 + i, ...RS, ...(i ? {} : E) });
          if (i === 8 && !topple) for (let x = -rx; x <= rx; x++) over(f, p.x + x, p.y + 1.6 * k, R.gold[x < 0 ? 4 : 2], 0.9);
        }
      });
      add(mz.z + 1.6, () => ch.stoleDetail(c));
      // censer on a chain, trailing smoke, in the left hand
      if (!(mask & 4)) {
        const hand = arms[1].hand;
        add(P(hand).z + 3, () => {
          const swing = pose.censer === undefined ? 0 : pose.censer;
          const cpos = vadd(hand, V(swing * 3.2, -9 - Math.abs(swing) * 1.5, 2 + swing * 1.2));
          const h2 = P(hand), c2 = P(cpos);
          for (let i = 0; i <= 8; i++) {
            const q = i / 8;
            px(f, Math.round(lerp(h2.x, c2.x, q) + (i % 2)), Math.round(lerp(h2.y, c2.y, q)), R.chain[i % 2 ? 2 : 4]);
          }
          blob(f, c2.x, c2.y, 3.0 * k, 2.8 * k, R.brass, { grain: 0.05, seed: 171, ...E, spec: rgba(255, 250, 220, 255) });
          blob(f, c2.x, c2.y - 3.0 * k, 1.9 * k, 1.3 * k, R.brass, { shift: 1, ...E });
          for (let i = 0; i < 3; i++) line(f, Math.round(c2.x + (-2 + i * 2) * k), Math.round(c2.y + k), Math.round(c2.x + (-2 + i * 2) * k), Math.round(c2.y + 2.4 * k), R.void[0]);
          glow(f, c2.x, c2.y + 1.6 * k, 3.6 * k, rgba(255, 150, 60, 255), { halo: 0.7, seed: 172, base: rgba(40, 20, 10, 255) });
          for (let i = 0; i < 7; i++) {
            const t = i / 6;
            const sx = c2.x + (Math.sin(i * 1.7 + swing * 2) * (1.6 + t * 4) - t * 2) * k;
            const sy = c2.y + (-4 - t * 12) * k;
            glow(f, sx, sy, (2.2 + t * 3.4) * k, mix(rgba(160, 168, 160, 255), rgba(48, 54, 58, 255), t),
              { halo: 0.7 - t * 0.5, seed: 180 + i, base: rgba(26, 30, 34, 255), core: 0.7 });
          }
        });
      }
      // floating reliquary
      if (pose.reliquary) {
        const rp = P(c.U(0, ch.hipY + 21 + (pose.relLift || 0), 17));
        if (pose.burst) {
          // the blessing goes off: shafts of sick green light in every direction
          add(rp.z + 5.9, () => {
            const b = pose.burst;
            for (let i = 0; i < 14; i++) {
              const a = i * TAU / 14 + 0.2;
              const L = (12 + 10 * b + hash2(i, 3, 186) * 8) * k;
              for (let s2 = 3 * k; s2 < L; s2 += 0.5) {
                const w = 0.5 + (s2 / L) * 2.2 * k;
                const q2 = s2 / L;
                for (let o2 = -w; o2 <= w; o2 += 1) {
                  const x = rp.x + Math.cos(a) * s2 - Math.sin(a) * o2, y = rp.y + Math.sin(a) * s2 + Math.cos(a) * o2;
                  if (hash2(Math.round(x), Math.round(y), 187) > (1 - q2) * 0.85 * b) continue;
                  px(f, x, y, mix(rgba(250, 255, 236, 255), rgba(120, 230, 150, 255), q2));
                }
              }
            }
          });
        }
        add(rp.z + 6, () => {
          const g = pose.reliquary;
          const q = pen(f, rp.x, rp.y, k * (0.4 + 0.32 * g));
          const EW = { edge: rgba(26, 22, 12, 255), edgeW: 0.9 };
          q.cap(0, -7, 0, 6, 4.2, 5.0, R.gold, { grain: 0.05, seed: 181, ...EW, spec: rgba(255, 252, 220, 255) });
          q.blob(0, -8.8, 3.0, 3.4, R.gold, { shift: 1, ...EW });
          q.blob(0, -11.6, 1.2, 1.6, R.gold, { shift: 1 });
          // a glass window with the relic inside: a tiny warhead
          q.blob(0, -0.5, 2.6, 4.2, flat(mix(rgba(120, 210, 145, 255), rgba(240, 255, 225, 255), g * 0.6)));
          q.cap(0, -3.2, 0, 2.2, 0.9, 1.1, R.chain, {});
          q.blob(0, -3.6, 0.9, 1.1, R.stole, {});
          q.rect(-5.2, 6, 10.4, 2, R.chain[2]);
          q.rect(-5.2, 6, 10.4, 1, R.chain[4]);
          for (const s of [-1, 1]) q.cap(s * 4.4, 5, s * 7.5, 9, 1.6, 1.2, R.gold, { shift: s > 0 ? 0 : -1 });
          glow(f, rp.x, rp.y + k, (8 + g * 5) * k, mix(rgba(120, 210, 145, 255), rgba(240, 255, 225, 255), g),
            { halo: 0.45 + g * 0.3, seed: 182, base: rgba(20, 34, 24, 255), core: 0.35 });
        });
      }
    },
  };
  return ch;
}

// ---------------------------------------------------------------------------
// per-character pose scripts
// ---------------------------------------------------------------------------

// Hand targets and weapon points are in the torso's own frame (see humanoid):
// x its right, y up from the floor as if standing straight, z forward. Each
// script covers the walk and idle loops, the attack in five beats (aim0 the
// anticipation, aim1 fully wound, fire0 the strike, fire1 the follow-through,
// recover on the way back), two different flinches and the death.

function wrencherHands(ch, pose, mode) {
  const Y = ch.shoulderY, sw = pose.swing || 0;
  switch (mode) {
    case 'walk':
    case 'idle': {
      // wrench cocked over the right shoulder, both hands on the grip; at rest
      // he gives it a thoughtful little bounce on the shoulder pad
      const tap = mode === 'idle' && pose.shrug ? 1 : 0;
      pose.hands = [V(9.5, Y - 4 - sw * 0.5, 6.2 + sw * 0.9), V(4.0, Y - 8 - sw * 0.4, 7.6 + sw * 0.7)];
      pose.wrenchTip = V(15.5 + tap * 1.5, Y + 14 - tap * 3 + Math.abs(sw) * 1.2, -2.5 - sw * 1.6);
      break;
    }
    case 'aim0':
      // draws it back: the wind-up you get to see coming
      pose.hands = [V(10.5, Y + 0.5, 3.5), V(5.5, Y - 2.5, 6)];
      pose.wrenchTip = V(15, Y + 17, -8);
      pose.lean = -0.06; pose.twist = 0.3; pose.hipDrop = 1;
      break;
    case 'aim1':
      // fully wound: up and behind the head, gut out, weight on the back foot
      pose.hands = [V(8.5, Y + 7, 0.5), V(3.5, Y + 5, 2.5)];
      pose.wrenchTip = V(20, Y + 16, -12);
      pose.lean = -0.24; pose.twist = 0.5; pose.shrug = 0.9; pose.tilt = 0.08;
      break;
    case 'fire0':
      // coming over: the jaw leads and everything he has is behind it
      pose.hands = [V(3, Y - 6, 13), V(-1.5, Y - 8, 12)];
      pose.wrenchTip = V(-9, Y + 4, 30);
      pose.lean = 0.3; pose.twist = -0.32; pose.hipDrop = 2.5; pose.smear = 1;
      break;
    case 'fire1':
      // follow-through: buried somewhere around your knees
      pose.hands = [V(-2, Y - 18, 11), V(-6, Y - 19, 9)];
      pose.wrenchTip = V(-13, 3, 18);
      pose.lean = 0.5; pose.twist = -0.55; pose.hipDrop = 4.5; pose.smear = 2;
      break;
    case 'recover':
      pose.hands = [V(7, Y - 9, 9), V(2.5, Y - 11, 9)];
      pose.wrenchTip = V(13, Y + 8, 4);
      pose.lean = 0.2; pose.twist = -0.1; pose.hipDrop = 1.5;
      break;
    case 'pain0':
      // rocked back on his heels, arms thrown wide
      pose.hands = [V(14, Y - 2, 2), V(-11, Y + 3, 1)];
      pose.wrenchTip = V(22, Y + 12, 0);
      pose.lean = -0.3; pose.twist = 0.25; pose.tilt = 0.14; pose.headPush = -1.5;
      break;
    case 'pain1':
      // gut shot: folds round it, the wrench hanging off one hand
      pose.hands = [V(4, ch.hipY + 8, 9), V(-4, ch.hipY + 7, 9)];
      pose.wrenchTip = V(9, 2, 14);
      pose.lean = 0.42; pose.twist = -0.2; pose.tilt = -0.12; pose.hipDrop = 3;
      break;
    default:
      // dying: the wrench goes wherever the right hand goes, jaw first
      pose.wrenchTip = vadd(pose.hands[0], V(8, 10, -6));
  }
}

function sparkerHands(ch, pose, mode) {
  const Y = ch.shoulderY, sw = pose.swing || 0;
  pose.gasp = mode === 'walk' || mode === 'idle' ? 0 : 1;
  switch (mode) {
    case 'walk':
      // a nervous trot: gun up and ready, the off hand pumping
      pose.hands = [V(6.5, Y - 11 + Math.abs(sw) * 1.2, 6 - sw * 1.4), V(-7.5, Y - 13 + Math.abs(sw), sw * 4.5)];
      pose.gunDir = V(0.75, -0.1, 0.65);
      pose.charge = 0.22 + 0.1 * Math.abs(sw);
      break;
    case 'idle':
      // gun hanging, and on the in-breath he pushes his glasses back up his nose
      pose.hands = [V(7.5, Y - 16, 3), pose.shrug ? V(-1.6, Y + 5.5, 6.5) : V(-8, Y - 16, 1)];
      pose.gunDir = V(0.3, -0.85, 0.45);
      pose.charge = 0.18;
      break;
    case 'aim0':
      pose.hands = [V(5, Y - 5, 8.5), V(-5, Y - 10, 4)];
      pose.gunDir = V(0.6, 0.15, 0.8);
      pose.charge = 0.6; pose.lean = 0.08; pose.twist = 0.1;
      break;
    case 'aim1':
      // two-handed, arm locked, the coil whining
      pose.hands = [V(3, Y - 2.5, 10.5), V(0, Y - 4, 9)];
      pose.gunDir = V(0.25, 0.02, 1);
      pose.charge = 1; pose.lean = 0.14; pose.twist = 0.2; pose.hipDrop = 1;
      break;
    case 'fire0':
      pose.hands = [V(3, Y - 2, 10), V(0, Y - 3.5, 8.5)];
      pose.gunDir = V(0.25, 0.05, 1);
      pose.charge = 1; pose.muzzle = 1; pose.lean = 0.06; pose.headPush = -0.5; pose.hipDrop = 1;
      break;
    case 'fire1':
      // the kick: gun up, a lick of arc still hanging off the coil
      pose.hands = [V(3.5, Y + 2.5, 8.5), V(-1, Y - 1, 7.5)];
      pose.gunDir = V(0.3, 0.6, 0.8);
      pose.charge = 0.5; pose.muzzle = 0.45; pose.lean = -0.12; pose.twist = 0.25; pose.headPush = -1;
      break;
    case 'recover':
      pose.hands = [V(5.5, Y - 8, 7), V(-6, Y - 12, 3)];
      pose.gunDir = V(0.6, -0.2, 0.7);
      pose.charge = 0.3; pose.smoke = 1;
      break;
    case 'pain0':
      pose.hands = [V(10, Y + 3, 2), V(-9, Y + 4, 1)];
      pose.gunDir = V(0.4, -0.6, 0.6);
      pose.charge = 0.4; pose.lean = -0.28; pose.tilt = 0.12;
      break;
    case 'pain1':
      // hit in the shoulder: the free hand goes to it
      pose.hands = [V(8, Y - 15, 6), V(5, Y - 1.5, 4.5)];
      pose.gunDir = V(0.2, -0.9, 0.3);
      pose.charge = 0.3; pose.lean = 0.25; pose.tilt = -0.15; pose.twist = 0.3; pose.hipDrop = 2;
      break;
    default:
      pose.gunDir = V(0.3, 0.6, 0.6);
      pose.charge = 0.5 - (pose.dying || 0) * 0.5;
  }
}

function bellowsHands(ch, pose, mode) {
  const Y = ch.shoulderY, sw = pose.swing || 0;
  pose.pilot = 1;
  switch (mode) {
    case 'walk':
      pose.hands = [V(13, Y - 11, 6 - sw * 1.4), V(-13, Y - 13, 2 + sw * 1.4)];
      pose.gunDir = V(0.95, 0.1, 0.35);
      break;
    case 'idle':
      // nozzle at the floor, the pilot light breathing with him
      pose.hands = [V(12, Y - 13, 4), V(-12.5, Y - 14, 1)];
      pose.gunDir = V(0.7, -0.6, 0.35);
      pose.pilot = pose.shrug ? 1.3 : 0.8;
      break;
    case 'aim0':
      pose.hands = [V(10, Y - 8, 9), V(-4, Y - 10, 7)];
      pose.gunDir = V(0.9, -0.2, 0.4);
      pose.pilot = 1.6; pose.lean = 0.06;
      break;
    case 'aim1':
      // braced, nozzle level, the pilot roaring blue
      pose.hands = [V(7, Y - 6, 11), V(-3, Y - 8, 9)];
      pose.gunDir = V(0.55, -0.25, 0.8);
      pose.pilot = 2.4; pose.lean = 0.14; pose.hipDrop = 1.5; pose.twist = -0.1;
      break;
    case 'fire0':
      pose.hands = [V(6, Y - 6, 12), V(-4, Y - 9, 10)];
      pose.gunDir = V(0.45, -0.3, 0.85);
      pose.flame = 1; pose.flameSeed = 1.1; pose.lean = 0.02; pose.hipDrop = 1.5;
      break;
    case 'fire1':
      // the gout at full stretch, and it shoves him back
      pose.hands = [V(6.5, Y - 5, 11), V(-3.5, Y - 8, 9.5)];
      pose.gunDir = V(0.5, -0.2, 0.85);
      pose.flame = 1.35; pose.flameSeed = 2.7; pose.lean = -0.08; pose.hipDrop = 1;
      break;
    case 'recover':
      pose.hands = [V(10, Y - 10, 8), V(-6, Y - 12, 5)];
      pose.gunDir = V(0.8, -0.5, 0.4);
      pose.pilot = 0.6; pose.smoke = 1;
      break;
    case 'pain0':
      pose.hands = [V(14, Y + 2, 2), V(-14, Y + 3, 1)];
      pose.gunDir = V(0.5, -0.5, 0.7);
      pose.lean = -0.2; pose.tilt = 0.1;
      break;
    case 'pain1':
      pose.hands = [V(9, Y - 16, 7), V(-6, Y - 12, 8)];
      pose.gunDir = V(0.6, -0.7, 0.3);
      pose.lean = 0.3; pose.tilt = -0.12; pose.hipDrop = 2.5; pose.twist = -0.2;
      break;
    default:
      pose.gunDir = V(0.4, 0.6, 0.6);
      pose.pilot = Math.max(0, 1 - (pose.dying || 0) * 2);
  }
}

function priestHands(ch, pose, mode) {
  const Y = ch.shoulderY, ph = pose.phase || 0, sw = pose.swing || 0;
  pose.hem = sw * 0.9;
  pose.bootPhase = ph;
  pose.censer = Math.sin(ph + 0.7) * 0.9;
  switch (mode) {
    case 'walk':
      pose.hands = [V(5.5, Y - 20, 7.5), V(-6.0, Y - 19, 6.5)];
      pose.eyeGlow = 0.55 + 0.2 * Math.abs(sw);
      break;
    case 'idle':
      pose.hands = [V(5.5, Y - 20, 7), V(-6, Y - 19, 6)];
      pose.censer = pose.shrug ? 0.45 : -0.35;
      pose.eyeGlow = pose.shrug ? 0.8 : 0.5;
      break;
    case 'aim0':
      // the hands come up, and something gold starts to take shape between them
      pose.hands = [V(6.5, Y - 12, 12), V(-6.5, Y - 12, 12)];
      pose.reliquary = 0.35; pose.relLift = -10; pose.eyeGlow = 0.8; pose.censer = 0.5;
      break;
    case 'aim1':
      pose.hands = [V(7, Y - 6, 13), V(-7, Y - 6, 13)];
      pose.reliquary = 0.75; pose.relLift = -4; pose.eyeGlow = 1; pose.lean = -0.1; pose.shrug = 0.8; pose.censer = -0.4;
      break;
    case 'fire0':
      // raised high, and it goes off like a lighthouse
      pose.hands = [V(7.5, Y - 3, 14), V(-7.5, Y - 3, 14)];
      pose.reliquary = 1; pose.relLift = -1; pose.burst = 1; pose.eyeGlow = 1; pose.lean = -0.14; pose.shrug = 1;
      break;
    case 'fire1':
      pose.hands = [V(13, Y + 4, 8), V(-13, Y + 4, 8)];
      pose.reliquary = 1; pose.relLift = -1; pose.burst = 0.5; pose.eyeGlow = 1; pose.lean = -0.08; pose.shrug = 0.6;
      break;
    case 'recover':
      pose.hands = [V(8, Y - 8, 10), V(-8, Y - 8, 10)];
      pose.reliquary = 0.3; pose.relLift = -12; pose.eyeGlow = 0.7;
      break;
    case 'pain0':
      pose.hands = [V(12, Y - 6, 3), V(-12, Y - 5, 2)];
      pose.eyeGlow = 1; pose.lean = -0.2; pose.censer = 1.1; pose.tilt = 0.1;
      break;
    case 'pain1':
      pose.hands = [V(4, Y - 11, 8), V(-5, Y - 10, 8)];
      pose.eyeGlow = 1; pose.lean = 0.3; pose.tilt = -0.1; pose.hipDrop = 3; pose.censer = -1;
      break;
    default:
      pose.eyeGlow = Math.max(0, 1 - (pose.dying || 0) * 1.3);
      pose.censer = 1.2;
      pose.hem = 0;
  }
}

function gorgerHands(ch, pose, mode) {
  const Y = ch.shoulderY, sw = pose.swing || 0;
  switch (mode) {
    case 'walk':
      pose.hands = [V(15, Y - 10 + Math.abs(sw), 9 - sw * 2.5), V(-15, Y - 10 + Math.abs(sw), 8 + sw * 2.5)];
      break;
    case 'idle':
      pose.hands = [V(15, Y - 12, 8), V(-15, Y - 12, 7)];
      pose.funnel = pose.shrug ? 0.3 : 0;
      break;
    case 'aim0':
      pose.hands = [V(17, Y - 5, 10), V(-17, Y - 6, 9)];
      pose.funnel = 0.45; pose.lean = -0.06;
      break;
    case 'aim1':
      // rears back and opens right up
      pose.hands = [V(18, Y + 2, 8), V(-18, Y + 1, 7)];
      pose.funnel = 0.85; pose.lean = -0.16; pose.shrug = 1;
      break;
    case 'fire0':
      pose.hands = [V(14, Y - 4, 16), V(-14, Y - 5, 15)];
      pose.funnel = 1; pose.lean = 0.3; pose.hipDrop = 2;
      break;
    case 'fire1':
      // snaps shut on whatever was there
      pose.hands = [V(9, Y - 8, 15), V(-9, Y - 9, 14)];
      pose.funnel = 0; pose.chomp = 1; pose.lean = 0.22; pose.hipDrop = 1.5;
      break;
    case 'recover':
      pose.hands = [V(16, Y - 9, 10), V(-16, Y - 10, 9)];
      pose.funnel = 0.2; pose.lean = 0.06;
      break;
    case 'pain0':
      pose.hands = [V(18, Y + 5, 6), V(-18, Y + 4, 5)];
      pose.lean = -0.16; pose.tilt = 0.08; pose.funnel = 0.5;
      break;
    case 'pain1':
      pose.hands = [V(10, Y - 14, 12), V(-12, Y - 13, 12)];
      pose.lean = 0.2; pose.tilt = -0.1; pose.hipDrop = 2;
      break;
    default: break;
  }
}

function howlerHands(ch, pose, mode) {
  const Y = ch.shoulderY, sw = pose.swing || 0;
  switch (mode) {
    case 'walk':
      // a long loping stride, arms dangling and swinging off the shoulders
      pose.hands = [V(9, Y - 17, 3 - sw * 6), V(-9, Y - 17, 1 + sw * 6)];
      pose.open = 0.12 + 0.1 * Math.abs(sw);
      break;
    case 'idle':
      pose.hands = [V(10, Y - 18, 2), V(-10, Y - 18, 1)];
      pose.open = pose.shrug ? 0.3 : 0.1;
      break;
    case 'aim0':
      pose.hands = [V(12, Y - 4, 4), V(-12, Y - 3, 3)];
      pose.open = 0.5; pose.lean = -0.15; pose.shrug = 0.4;
      break;
    case 'aim1':
      // the chest heaves up, everything peels open
      pose.hands = [V(14, Y + 3, 2), V(-14, Y + 4, 1)];
      pose.open = 0.9; pose.lean = -0.28; pose.shrug = 1;
      break;
    case 'fire0':
      pose.hands = [V(15, Y + 5, 1), V(-15, Y + 6, 0)];
      pose.open = 1; pose.lean = -0.16; pose.spit = 1;
      break;
    case 'fire1':
      pose.hands = [V(13, Y + 1, 4), V(-13, Y + 2, 3)];
      pose.open = 0.8; pose.lean = -0.04; pose.spit = 0.5;
      break;
    case 'recover':
      pose.hands = [V(11, Y - 8, 4), V(-11, Y - 8, 3)];
      pose.open = 0.4;
      break;
    case 'pain0':
      pose.hands = [V(11, Y + 2, 6), V(-12, Y + 3, 5)];
      pose.lean = -0.26; pose.tilt = 0.1; pose.open = 0.9;
      break;
    case 'pain1':
      pose.hands = [V(6, Y - 12, 9), V(-7, Y - 11, 9)];
      pose.lean = 0.3; pose.tilt = -0.12; pose.hipDrop = 2.5; pose.open = 0.6;
      break;
    default:
      pose.open = Math.max(0, 0.9 - (pose.dying || 0));
  }
}

const HANDS = {
  wrencher: wrencherHands, sparker: sparkerHands, bellows: bellowsHands, priest: priestHands,
};

// ---------------------------------------------------------------------------
// enemy frame sets (humanoid rig)
// ---------------------------------------------------------------------------

const ATTACK = ['aim0', 'aim1', 'fire0', 'fire1', 'recover'];

/**
 * The full set for a character on the humanoid rig, every key registered as
 * a recipe so maim() can repaint it with parts missing, plus its rig heights
 * and the severed-part frames:
 *   walk{D}_{0..7}  eight-frame walk per facing
 *   idle{D}_{0..1}  breathing out and in, per facing
 *   aim0 aim1 fire0 fire1 recover   the attack, facing the camera
 *   pain0 pain1     two different flinches
 *   die0..die5, dead
 */
function paintHumanoidSet(out, ch, hands, recipes, rig) {
  const id = ch.id, k = ch.k || K;
  const W = Math.round(ch.w * k), H = Math.round(ch.h * k), WD = Math.round((ch.dieW || ch.w) * k);
  const WA = Math.round((ch.atkW || ch.w * 1.6) * k);
  const ink = ch.ink || ch.edge;
  const prep = (pose, mode, F, t) => {
    hands(ch, pose, mode, F);
    if (ch.prep) ch.prep(pose, mode, F, t);
  };
  for (let D = 0; D < 4; D++) {
    for (let F = 0; F < WALK_N; F++) {
      register(out, recipes, `${id}_walk${D}_${F}`, W, H, (f, mask) => {
        const pose = walkPose(ch, F);
        prep(pose, 'walk', F);
        humanoid(f, ch, pose, D, mask);
        finishEnemy(f, { ink });
      });
    }
    for (let F = 0; F < 2; F++) {
      register(out, recipes, `${id}_idle${D}_${F}`, W, H, (f, mask) => {
        const pose = idlePose(ch, F);
        prep(pose, 'idle', F);
        humanoid(f, ch, pose, D, mask);
        finishEnemy(f, { ink });
      });
    }
  }
  for (const mode of ATTACK) {
    register(out, recipes, `${id}_${mode}`, WA, H, (f, mask) => {
      const pose = standPose(ch, { phase: 0.7, fz0: 3.2, fz1: -3.4, fx0: 0.6, fx1: 0.6 });
      prep(pose, mode, 0);
      const b = humanoid(f, ch, pose, 0, mask);
      if (ch.attackFx) ch.attackFx(f, mode, b, pose, mask);
      finishEnemy(f, { ink });
    });
  }
  for (let v = 0; v < 2; v++) {
    register(out, recipes, `${id}_pain${v}`, W, H, (f, mask) => {
      const pose = standPose(ch, { phase: 0.7, fz0: v ? 2.6 : 1.2, fz1: v ? -1.2 : -3.0 });
      prep(pose, `pain${v}`, 0);
      const b = humanoid(f, ch, pose, 0, mask);
      // where it went in, and what came out
      const at = v ? b.gut : b.chest;
      spurt(f, at.x, at.y, v ? 1 : -0.8, v ? -0.3 : -1, (v ? 10 : 12) * k, k, 0x3a1 + v * 71 + id.length, ch.blood);
      finishEnemy(f, { flash: 0.12, ink });
    });
  }
  for (let kk = 0; kk < DIE_N; kk++) {
    const t = DIE_T[kk];
    register(out, recipes, `${id}_die${kk}`, WD, H, (f, mask) => {
      const pose = deathPose(ch, t, WD);
      prep(pose, 'die', kk, t);
      const seed = 0x7700 + kk * 37 + id.length;
      if (kk >= 4) gorePool(f, WD / 2 - 6 * k, H - 3 * k, (12 + (kk - 4) * 8) * k, (2.6 + (kk - 4)) * k, seed, { spots: 12 + kk * 2, ...ch.pool });
      const b = humanoid(f, ch, pose, 0, mask);
      if (kk === 0) {
        wash(f, rgba(228, 70, 58, 255), 0.16);
        spurt(f, b.chest.x, b.chest.y, -0.4, -1, 16 * k, k, seed, ch.blood);
      }
      if (kk >= 1 && kk <= 3) bloodArc(f, WD / 2, H - (ch.hipY - 6) * k, kk, k, 0x51e0 + id.length * 977, ch.blood);
      if (kk === 4) splash(f, WD / 2 - 4 * k, H - 2 * k, 22 * k, k, seed, ch.blood);
      if (kk === 5) bloodArc(f, WD / 2 - 6 * k, H - 8 * k, 1, k, 0x52e0 + id.length * 977, ch.blood);
      if (ch.dieFx) ch.dieFx(f, kk, t, mask, b);
      finishEnemy(f, { ink });
    });
  }
  register(out, recipes, `${id}_dead`, WD, H, (f, mask) => {
    if (ch.corpse) { ch.corpse(f, mask); return; }
    const pose = deathPose(ch, 1, WD);
    pose.dead = 1;
    prep(pose, 'die', DIE_N, 1);
    gorePool(f, WD / 2 - 12 * k, H - 3.5 * k, 30 * k, 4.4 * k, 0x9911 + W, { spots: 22, ...ch.pool });
    const b = humanoid(f, ch, pose, 0, mask);
    if (ch.dieFx) ch.dieFx(f, DIE_N, 1, mask, b);
    wash(f, rgba(60, 20, 26, 255), 0.14, (x, y) => y > H - 5 * k);
    finishEnemy(f, { ink });
  });
  rig[id] = {
    hip: ch.hipY / ch.h, shoulder: ch.shoulderY / ch.h,
    neck: ch.neckY / ch.h, head: ch.headY / ch.h,
  };
  paintHumanoidParts(out, ch);
}

/** A cartoon arc of blood droplets thrown up and out of a falling body. */
function bloodArc(f, cx, cy, kk, k, seed, B) {
  const rng = makeRng(seed + kk * 131);
  const n = 10 + kk * 8;
  const c0 = B ? B[0] : GORE.blood, c1 = B ? B[1] : GORE.bloodD;
  for (let i = 0; i < n; i++) {
    const a = -Math.PI * (0.15 + rng() * 0.7);
    const r = (4 + rng() * (8 + kk * 5)) * k;
    const x = cx + Math.cos(a) * r * 1.3 - kk * 3 * k, y = cy + Math.sin(a) * r * 0.8 + kk * 4 * k;
    if (y > f.h - 1 || y < 0) continue;
    const s = rng() < 0.3 ? 1.2 * k : 0.6 * k;
    blob(f, x, y, s, s, flat(rng() < 0.4 ? c0 : c1));
    if (s > k) px(f, Math.round(x - s * 0.4), Math.round(y - s * 0.4), GORE.hi);
  }
}

/**
 * A jet out of a wound along (dx,dy): a thick wet gout that breaks up into
 * droplets and falls off under its own weight. B overrides the colours (the
 * mutants bleed something greener).
 */
function spurt(f, x, y, dx, dy, len, k, seed, B) {
  const L = Math.hypot(dx, dy) || 1;
  const ux = dx / L, uy = dy / L;
  const rng = makeRng(seed);
  const c0 = B ? B[0] : GORE.blood, c1 = B ? B[1] : GORE.bloodD;
  const hot = B ? B[2] || GORE.hi : GORE.hi;
  for (let i = 0; i < 10; i++) {
    const t = i / 9;
    const r = (1.9 - t * 1.1) * k;
    const bx = x + ux * len * t + (rng() - 0.5) * t * 3 * k;
    const by = y + uy * len * t + t * t * 6 * k + (rng() - 0.5) * t * 3 * k;
    blob(f, bx, by, r, r * 0.9, flat(i % 3 === 1 ? c1 : c0));
    if (r > k) px(f, Math.round(bx - r * 0.4), Math.round(by - r * 0.4), hot);
  }
  for (let i = 0; i < 9; i++) {
    const t = 0.5 + rng() * 0.8;
    const s = (0.5 + rng() * 0.7) * k;
    blob(f, x + ux * len * t + (rng() - 0.5) * 8 * k, y + uy * len * t + t * t * 8 * k + (rng() - 0.5) * 6 * k, s, s, flat(rng() < 0.5 ? c0 : c1));
  }
  // the hole it came out of
  blob(f, x, y, 1.5 * k, 1.3 * k, flat(B ? B[1] : GORE.deep));
  px(f, Math.round(x - 0.5 * k), Math.round(y - 0.5 * k), hot);
}

/** The landing: a crown of splatter thrown out low along the floor. */
function splash(f, cx, gy, w, k, seed, B) {
  const rng = makeRng(seed ^ 0x5bd1);
  const c0 = B ? B[0] : GORE.blood, c1 = B ? B[1] : GORE.bloodD;
  for (let i = 0; i < 26; i++) {
    const side = rng() < 0.5 ? -1 : 1;
    const r = rng() * w;
    const x = cx + side * r, y = gy - Math.sin((r / w) * Math.PI) * (3 + rng() * 7) * k;
    const s = (0.5 + rng() * 0.9) * k;
    blob(f, x, y, s * 1.3, s, flat(rng() < 0.45 ? c0 : c1));
  }
}

// ---------------------------------------------------------------------------
// severed parts: painted upright at twice the density, then turned
// ---------------------------------------------------------------------------

/**
 * Paint a part upright into a 2x canvas with `paint(f)`, then resample it
 * into eight square frames `${key}_${r}`, turned r*45 degrees clockwise. The
 * 2x source is sampled four times per output pixel (alpha by majority), so a
 * diagonal limb stays as crisp as a straight one.
 */
function paintPart(out, key, S2, paint, o = {}) {
  const src = makeFrame(S2, S2);
  paint(src);
  let x0 = S2, y0 = S2, x1 = -1, y1 = -1;
  for (let y = 0; y < S2; y++) {
    for (let x = 0; x < S2; x++) {
      if (!(src.data[y * S2 + x] >>> 24)) continue;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return;
  const cx = (x0 + x1 + 1) / 2, cy = (y0 + y1 + 1) / 2;
  let rmax = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!(src.data[y * S2 + x] >>> 24)) continue;
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d > rmax) rmax = d;
    }
  }
  const side = 2 * Math.ceil(rmax / 2) + 3;
  const sample = (X, Y) => {
    const xi = Math.floor(X), yi = Math.floor(Y);
    if (xi < 0 || yi < 0 || xi >= S2 || yi >= S2) return 0;
    return src.data[yi * S2 + xi];
  };
  for (let r = 0; r < 8; r++) {
    const a = r * Math.PI / 4, ca = Math.cos(a), sa = Math.sin(a);
    const f = makeFrame(side, side);
    const c1 = side / 2;
    for (let j = 0; j < side; j++) {
      for (let i = 0; i < side; i++) {
        let n = 0, first = 0, mid = 0;
        for (let s = 0; s < 5; s++) {
          const ox = s === 4 ? 0 : (s & 1 ? 0.25 : -0.25), oy = s === 4 ? 0 : (s & 2 ? 0.25 : -0.25);
          const u = i + 0.5 + ox - c1, v = j + 0.5 + oy - c1;
          const c = sample(cx + (u * ca + v * sa) * 2, cy + (-u * sa + v * ca) * 2);
          if (!(c >>> 24)) continue;
          if (s === 4) mid = c; else { n++; if (!first) first = c; }
        }
        if (n >= 2 || (mid && n >= 1)) f.data[j * side + i] = mid || first;
      }
    }
    grade(f);
    topRim(f, WARM, 0.2, 0.06);
    sideRim(f, RIM, 0.26, 0.08);
    inkEdge(f, o.ink || INK);
    out[`${key}_${r}`] = f;
  }
}

/** Head, arm and leg for a character on the humanoid rig. */
function paintHumanoidParts(out, ch) {
  const id = ch.id, R = ch.ramps;
  const k2 = (ch.k || K) * 2;
  const S2 = Math.round(48 * k2);
  const E = { edge: ch.edge, edgeW: 1.8 };
  const c0 = S2 / 2;
  // the head, looking suitably surprised, on a neck stub torn off at the base
  paintPart(out, `${id}_part_head`, S2, (f) => {
    const nr = (ch.neckR || 3) * k2;
    const drop = (ch.headY - ch.neckY) * k2;
    stump(f, c0, c0 + drop * 0.35, 0, 1, nr, R.neck || R.torso, { len: drop * 0.55, seed: 7, flat: 0.6, bone: 0.4, drips: 3, edge: ch.edge });
    if (ch.partHead) { ch.partHead(f, c0, c0, k2, E); return; }
    const P = projector(0, c0, c0 + ch.headY * k2, null, k2);
    ch.head(f, { f, ch, hd: { x: c0, y: c0, z: 0 }, theta: 0, D: 0, R, k: k2, E, P, mask: 0, pose: { severed: 1, eyeGlow: 0 } });
  }, { ink: ch.ink || ch.edge });
  // the arm: shoulder torn at the top, elbow cocked, fist at the bottom
  paintPart(out, `${id}_part_arm`, S2, (f) => {
    const s2 = { x: c0 - 1.0 * k2, y: c0 - 11.5 * k2 }, e2 = { x: c0 + 1.6 * k2, y: c0 - 0.2 * k2 }, h2 = { x: c0 - 0.4 * k2, y: c0 + 10.8 * k2 };
    const c = { f, ch, R, k: k2, E, theta: 0 };
    paintArm(c, { side: 1 }, s2, e2, h2, 0, true);
    stump(f, s2.x, s2.y, s2.x - e2.x, s2.y - e2.y, ch.armThick * k2 * 1.04, R.sleeve, { len: 0, seed: 11, drips: 0, edge: ch.edge });
  }, { ink: ch.ink || ch.edge });
  // the leg: hip torn at the top, a slight bend, boot pointing sideways
  paintPart(out, `${id}_part_leg`, S2, (f) => {
    const reach = (ch.thigh + ch.shin) * 0.94;
    const P = projector(Math.PI / 2, c0, c0 + (ch.ankleY + reach / 2) * k2, null, k2);
    const L = { side: 1, hip: V(0, ch.ankleY + reach, -0.5), knee: V(0, ch.ankleY + ch.shin * 0.96, 1.8), foot: V(0, ch.ankleY, 0) };
    const h2 = P(L.hip), kn = P(L.knee), f2 = P(L.foot);
    const c = { f, ch, R, k: k2, E, theta: Math.PI / 2, P };
    if (ch.robed) {
      capsule(f, h2.x, h2.y, kn.x, kn.y, ch.legThick * k2, ch.legThick * k2 * 0.9, R.trouser, { ...E });
      capsule(f, kn.x, kn.y, f2.x, f2.y, ch.legThick * k2 * 0.9, ch.legThick * k2 * 0.74, R.trouser, { ...E });
      const toe = P(vadd(L.foot, V(0, -0.5, ch.footLen)));
      capsule(f, f2.x, f2.y, toe.x, toe.y, ch.legThick * k2 * 0.8, ch.legThick * k2 * 0.7, R.boot, { ...E, spec: R.boot[4] });
    } else {
      paintLeg(c, L, h2, kn, f2, 0);
    }
    stump(f, h2.x, h2.y, h2.x - kn.x, h2.y - kn.y, ch.legThick * k2 * 1.02, R.trouser, { len: 0, seed: 13, drips: 0, edge: ch.edge });
  }, { ink: ch.ink || ch.edge });
}

// ---------------------------------------------------------------------------
// wasp - hovering drone, not humanoid
// ---------------------------------------------------------------------------

const WASP = {
  hull: mat(rgba(118, 130, 112, 255), { contrast: 1.2 }),
  hull2: mat(rgba(80, 90, 86, 255), { contrast: 1.25 }),
  steel: mat(rgba(140, 144, 152, 255), { contrast: 1.3 }),
  dark: mat(rgba(30, 32, 34, 255)),
  optic: mat(rgba(236, 62, 42, 255), { contrast: 1.45 }),
  warn: mat(rgba(214, 170, 42, 255), { contrast: 1.25 }),
  ink: rgba(14, 16, 16, 255),
};
const WASP_W = 56, WASP_H = 40;

/** Blurred rotor disc inside a thin guard ring, densities varying per frame. */
function rotor(f, cx, cy, rx, ry, ph, seed, dir, k) {
  const c1 = rgba(206, 214, 222, 255), c2 = rgba(110, 118, 128, 255), c3 = rgba(58, 62, 70, 255);
  for (let y = Math.floor(cy - ry - 1); y <= Math.ceil(cy + ry + 1); y++) {
    for (let x = Math.floor(cx - rx - 1); x <= Math.ceil(cx + rx + 1); x++) {
      const u = (x - cx) / rx, v = (y - cy) / ry;
      const d = Math.hypot(u, v);
      if (d > 1.02 || d < 0.2) continue;
      const a = Math.atan2(v, u);
      // two blades smeared by rotation: density peaks where a blade is
      const sp = 0.5 + 0.5 * Math.cos(2 * (a - ph * dir));
      let dens = (0.14 + 0.72 * Math.pow(sp, 1.8)) * (0.4 + 0.6 * d);
      if (d > 0.88) dens = Math.max(dens, 0.8);        // the guard ring
      const h = hash2(x, y, seed);
      if (h > dens) continue;
      px(f, x, y, d > 0.9 ? (v < 0 ? WASP.steel[3] : WASP.steel[1]) : (h < dens * 0.32 ? c1 : (h < dens * 0.72 ? c2 : c3)));
    }
  }
  blob(f, cx, cy, 2.4 * k, 1.8 * k, WASP.steel, { edge: WASP.ink, spec: rgba(255, 255, 255, 255) });
  blob(f, cx, cy - 0.4 * k, 1.1 * k, 0.9 * k, WASP.dark, { shift: 1 });
}

function paintWasp(D, F, mode) {
  const k = K;
  const f = makeFrame(Math.round(WASP_W * k), Math.round(WASP_H * k));
  const R = WASP;
  const E = { edge: R.ink, edgeW: 0.9 };
  const cx = WASP_W * k / 2;
  const bob = mode === 'walk' ? Math.sin(F * TAU / WALK_N) * 1.5 : mode === 'pain' ? 2.2 : mode === 'pain1' ? -1.6
    : mode === 'fire1' ? -0.8 : mode === 'aim1' ? 0.6 : 0;
  const cy = (16 + bob) * k;
  const theta = D * Math.PI / 2;
  const fw = Math.cos(theta), sd = Math.sin(theta);
  const side = Math.abs(sd) > 0.6;
  const firing = mode === 'fire0' || mode === 'fire1';
  const ph = F * 0.9 + (firing ? 0.4 : 0);
  const len = (side ? 12.5 : 7.5) * k;
  const g = pen(f, cx, cy, k);

  // outriggers + rotors: far ones first
  const arm = (side ? 8.5 : 13.5) * k;
  const rots = side
    ? [{ x: cx - arm * (sd > 0 ? 1 : -1), y: cy - 10.5 * k, near: false, r: 7.6 * k },
       { x: cx + arm * (sd > 0 ? 1 : -1), y: cy - 11.5 * k, near: true, r: 9.0 * k }]
    : [{ x: cx - arm, y: cy - 11 * k, near: true, r: 9.5 * k }, { x: cx + arm, y: cy - 11 * k, near: true, r: 9.5 * k }];
  for (const rt of rots) {
    if (rt.near) continue;
    capsule(f, cx + (rt.x > cx ? 2 : -2) * k, cy - 4.0 * k, rt.x, rt.y + 1.5 * k, 2.0 * k, 1.4 * k, R.hull2, { shift: -1, ...E });
    rotor(f, rt.x, rt.y, rt.r, 2.9 * k, ph + 1.1, 601, -1, k);
  }
  // dangling grabber claws, three fingers each
  for (let i = 0; i < 2; i++) {
    const s2 = i ? 1 : -1;
    const lx = s2 * (side ? 4.5 : 5.5);
    const sw2 = Math.sin(F * 1.1 + i * 2) * 1.4;
    g.cap(lx, 4, lx + sw2, 10, 1.1, 0.9, R.steel, { shift: -1, ...E });
    g.cap(lx + sw2, 10, lx + sw2 * 1.7 + s2 * 1.5, 15, 0.9, 0.7, R.steel, { shift: -1, ...E });
    const hx = lx + sw2 * 1.7 + s2 * 1.5;
    g.blob(hx, 15.5, 1.3, 1.1, R.steel, { shift: -1 });
    for (let q = -1; q <= 1; q++) g.cap(hx, 16, hx + q * 1.3, 18.2, 0.5, 0.35, R.dark, { shift: 1 });
  }
  // under-slung twin bolt emitters
  {
    const bx = side ? (sd > 0 ? 1 : -1) * 3 : 0;
    for (const s2 of [-2, 2]) {
      g.cap(bx + s2, 5.2, bx + s2, 7.4, 0.9, 0.8, R.dark, { ...E });
      if (firing) {
        const m = mode === 'fire0' ? 1 : 0.5;
        g.glow(bx + s2, 8.2, 2 + 2.4 * m, rgba(180, 230, 255, 255), { halo: 1, seed: 646 + s2, base: rgba(40, 60, 90, 255) });
        flare(f, g.pt(bx + s2, 8.6)[0], g.pt(bx + s2, 8.6)[1], (3 + 5 * m) * k, 6, rgba(236, 250, 255, 255), rgba(120, 190, 255, 255), 647 + s2);
      } else if (mode === 'aim1') {
        g.glow(bx + s2, 8.0, 2.2, rgba(150, 210, 255, 255), { halo: 0.6, seed: 646 + s2, base: rgba(30, 44, 70, 255) });
      }
    }
  }
  // hull: a horizontal lozenge, lit like a cylinder lying on its side (shading
  // must vary with y here, not with x, or the body ends up striped)
  const hy = 5.6 * k, hx = len;
  for (let y = Math.floor(cy - hy - 1.2); y <= Math.ceil(cy + hy + 1.2); y++) {
    const v = (y - cy - 0.4 * k) / (hy + 1.2);
    if (Math.abs(v) > 1) continue;
    const hw = (hx + 1.2) * Math.sqrt(1 - v * v);
    for (let x = Math.round(cx - hw); x <= Math.round(cx + hw); x++) px(f, x, y, R.ink);
  }
  for (let y = Math.floor(cy - hy); y <= Math.ceil(cy + hy); y++) {
    const v = (y - cy - 0.4 * k) / hy;
    if (Math.abs(v) > 1) continue;
    const hw = hx * Math.sqrt(1 - v * v);
    const nz = Math.sqrt(Math.max(0, 1 - v * v));
    for (let x = Math.round(cx - hw); x <= Math.round(cx + hw); x++) {
      const u = (x - cx) / Math.max(hw, 0.6);
      let b = band(clamp(lamOf(u * 0.28, v, nz * 0.95) * 0.72 + 0.3, 0, 1));
      if (hash2(x, y, 611) < 0.05) b -= 1;
      px(f, x, y, R.hull[clamp(b, 0, 4)]);
      if (nz > 0.2 && v < -0.45 && v > -0.62 && Math.abs(u) < 0.7) px(f, x, y, R.hull[4]);
    }
  }
  // armoured upper deck with rivets and an antenna
  capsule(f, cx - len * 0.74, cy - 4.6 * k, cx + len * 0.74, cy - 5.0 * k, 2.2 * k, 2.0 * k, R.hull2, { shift: 1, ...E, spec: R.hull2[4] });
  for (let i = -2; i <= 2; i++) px(f, Math.round(cx + i * len * 0.34), Math.round(cy - 6.2 * k), R.steel[4]);
  const ax = side ? -(sd > 0 ? 1 : -1) * 4 : 3;
  g.line(ax, -6, ax + 1, -12, R.dark[2]);
  const blink = (F % 2 === 0) || firing;
  g.blob(ax + 1, -12.4, 0.8, 0.8, flat(blink ? rgba(255, 90, 60, 255) : rgba(120, 30, 20, 255)));
  if (blink) g.glow(ax + 1, -12.4, 2.4, rgba(255, 90, 60, 255), { halo: 0.6, seed: 648, base: rgba(40, 12, 10, 255) });
  // panel seams + hazard flash
  for (let i = -1; i <= 1; i++) {
    const sx = cx + i * len * 0.44;
    line(f, Math.round(sx), Math.round(cy - 3.4 * k), Math.round(sx), Math.round(cy + 3.4 * k), R.hull2[1]);
    line(f, Math.round(sx + 1), Math.round(cy - 3.4 * k), Math.round(sx + 1), Math.round(cy + 3.4 * k), R.hull[3]);
    for (let q = -2; q <= 2; q += 2) px(f, Math.round(sx + 2), Math.round(cy + q * k), R.steel[4]);
  }
  for (let x = Math.round(-6 * k); x <= Math.round(6 * k); x++) {
    if (((x + 20) % 6) < 3) { px(f, Math.round(cx + x), Math.round(cy + 3.6 * k), R.warn[3]); px(f, Math.round(cx + x), Math.round(cy + 4.4 * k), R.warn[1]); }
  }
  // running lights on the flanks
  for (const sgn of [-1, 1]) {
    const lx = cx + sgn * len * 0.66;
    blob(f, lx, cy + 1.6 * k, 1.1 * k, 1.0 * k, flat(sgn < 0 ? rgba(255, 70, 60, 255) : rgba(90, 255, 120, 255)));
    glow(f, lx, cy + 1.6 * k, 2.4 * k, sgn < 0 ? rgba(255, 70, 60, 255) : rgba(90, 255, 120, 255), { halo: 0, tint: 0.55, seed: 645 });
  }
  // near rotors
  for (const rt of rots) {
    if (!rt.near) continue;
    // outriggers leave the hull at its shoulders, clear of the optic
    const sx = cx + (rt.x > cx ? 1 : -1) * len * 0.62;
    capsule(f, sx, cy - 3.0 * k, rt.x, rt.y + 1.5 * k, 1.8 * k, 1.3 * k, R.hull2, { ...E, spec: R.hull2[4] });
    rotor(f, rt.x, rt.y, rt.r, 3.3 * k, ph, 602, 1, k);
  }
  // the face goes on last, over the outrigger roots
  if (fw > 0.35) {
    // face: a camera optic in a dark socket, iris leaves, a hot core
    const gl = firing ? 1 : mode === 'aim1' ? 0.9 : mode === 'aim0' ? 0.6 : 0.35 + 0.15 * Math.sin(F * 1.6);
    g.blob(0, -0.2, 5.2, 4.6, R.dark, { shift: 1, ...E });
    g.blob(0, -0.2, 4.3, 3.8, R.steel, { shift: -1 });
    g.blob(0, -0.2, 3.5, 3.1, R.optic, { shift: gl > 0.6 ? 1 : 0 });
    for (let i = 0; i < 6; i++) {
      const a = i * 1.047 + 0.3;
      g.line(Math.cos(a) * 1.4, -0.2 + Math.sin(a) * 1.2, Math.cos(a) * 3.1, -0.2 + Math.sin(a) * 2.7, R.optic[0]);
    }
    g.blob(0, -0.2, 1.5, 1.3, flat(mix(rgba(255, 220, 200, 255), rgba(130, 12, 10, 255), 1 - gl)));
    glow(f, cx, cy - 0.2 * k, (5.5 + gl * 2) * k, rgba(255, 80, 50, 255), { halo: 0.34 + gl * 0.3, tint: 0.3, seed: 620, base: rgba(34, 12, 10, 255), core: 0.8 });
    g.dot(-1.2, -1.8, rgba(255, 236, 222, 255));
    g.dot(-0.6, -1.8, rgba(255, 236, 222, 255));
  } else if (side) {
    const s2 = sd > 0 ? 1 : -1;
    const ox = s2 * len * 0.78 / k;
    g.blob(ox, -0.4, 2.8, 3.2, R.dark, { shift: 1, ...E });
    g.blob(ox + s2 * 0.3, -0.4, 1.5, 1.9, R.optic, {});
    glow(f, cx + s2 * len * 0.82, cy - 0.4 * k, 4.5 * k, rgba(255, 80, 50, 255), { halo: 0.45, tint: 0.35, seed: 621, base: rgba(34, 12, 10, 255), core: 0.8 });
    stencil(f, Math.round(cx - 2 * k - s2 * 3 * k), Math.round(cy - 2 * k), '7', R.warn[4], 0.9);
    stencil(f, Math.round(cx + 1 * k - s2 * 3 * k), Math.round(cy - 2 * k), 'B', R.warn[4], 0.7);
  } else {
    // back: exhaust ports with a heat shimmer
    for (let i = -1; i <= 1; i++) {
      g.blob(i * 4.6, -0.2, 2.0, 2.0, R.dark, { shift: 1, ...E });
      glow(f, cx + i * 4.6 * k, cy - 0.2 * k, 3.0 * k, rgba(255, 150, 70, 255), { halo: 0.35, tint: 0.4, seed: 630 + i, base: rgba(34, 18, 10, 255), core: 0.85 });
    }
    fillRect(f, Math.round(cx - 6 * k), Math.round(cy - 3.4 * k), Math.round(13 * k), 1, R.warn[3]);
  }
  // faint underglow, clear of the hull so it does not tint the armour
  glow(f, cx, cy + 7.6 * k, 4.4 * k, rgba(255, 120, 50, 255),
    { halo: 0.13, tint: 0.18, seed: 640, base: rgba(24, 12, 9, 255), core: 1.0 });
  return f;
}

function paintWaspSet(out) {
  const fin = (f, o) => finishEnemy(f, { ink: WASP.ink, ...o });
  for (let D = 0; D < 4; D++) {
    for (let F = 0; F < WALK_N; F++) out[`wasp_walk${D}_${F}`] = fin(paintWasp(D, F, 'walk'));
    // it never stops hovering: the idle loop is the walk, held
    for (let F = 0; F < 2; F++) out[`wasp_idle${D}_${F}`] = out[`wasp_walk${D}_${F * 4}`];
  }
  out.wasp_aim0 = fin(paintWasp(0, 1, 'aim0'));
  out.wasp_aim1 = fin(paintWasp(0, 2, 'aim1'));
  out.wasp_fire0 = fin(paintWasp(0, 3, 'fire0'));
  out.wasp_fire1 = fin(paintWasp(0, 4, 'fire1'));
  out.wasp_recover = fin(paintWasp(0, 5, 'recover'));
  out.wasp_pain0 = fin(paintWasp(0, 3, 'pain'), { flash: 0.2 });
  out.wasp_pain1 = fin(paintWasp(1, 6, 'pain1'), { flash: 0.2 });
  for (let kk = 0; kk < DIE_N; kk++) out[`wasp_die${kk}`] = fin(paintWaspDie(kk * 3 / (DIE_N - 1)));
  out.wasp_dead = fin(paintWaspDead());
}

function paintWaspDie(kk) {
  // kk runs 0..3, in fractional steps
  const k = K;
  const f = makeFrame(Math.round(WASP_W * k), Math.round(WASP_H * k));
  const R = WASP;
  const t = kk / 3;
  const cx = (WASP_W / 2 - 2 + kk) * k, cy = (13 + t * 16) * k;
  const rot = t * 1.5;
  const cr = Math.cos(rot), sr = Math.sin(rot);
  const bodyLen = 9 * k;
  for (let i = -bodyLen; i <= bodyLen; i++) {
    const tt = i / bodyLen;
    const ry = 6.0 * k * Math.sqrt(Math.max(0, 1 - tt * tt * 0.82));
    const x = cx + i * cr, y = cy + i * sr;
    blob(f, x, y, 1.3 * k, ry, R.hull, { mode: 'cyl', nyBias: -0.2, grain: 0.06 + t * 0.12, seed: 650 + Math.round(i), shift: kk >= 2 ? -1 : 0 });
  }
  // the optic, cracked, dying down
  blob(f, cx - 4 * k * cr, cy - 4 * k * sr, 2.4 * k, 2.2 * k, R.dark, { shift: 1 });
  blob(f, cx - 4 * k * cr, cy - 4 * k * sr, 1.3 * k, 1.2 * k, flat(mix(rgba(255, 90, 60, 255), rgba(60, 20, 16, 255), t)));
  line(f, Math.round(cx - 5 * k * cr - k), Math.round(cy - 4 * k * sr - k), Math.round(cx - 3 * k * cr + k), Math.round(cy - 4 * k * sr + k), rgba(230, 230, 230, 255));
  // one rotor sheared off, the other stalling
  if (kk < 2.9) rotor(f, cx + (-12 + kk * 3) * k, cy + (-6 + kk * 2) * k, (10.5 - kk * 2.2) * k, 3.0 * k, kk * 1.3, 651, 1, k);
  capsule(f, cx, cy - 3 * k, cx + (-10 + kk * 2) * k, cy + (-4 + kk * 3) * k, 2.2 * k, 1.6 * k, R.hull2, { shift: -1 });
  if (kk < 0.5) {
    rotor(f, cx + 13 * k, cy - 6 * k, 11 * k, 3.2 * k, 0.4, 652, -1, k);
  } else {
    // shrapnel and a spinning bolt or two
    const rng = makeRng(0x9a11 + Math.round(kk * 5));
    for (let i = 0; i < 10 + kk * 5; i++) {
      const a = rng() * 6.28, r = (6 + rng() * (10 + kk * 6)) * k;
      const s = rng() < 0.3 ? 2 : 1;
      fillRect(f, Math.round(cx + Math.cos(a) * r), Math.round(cy + Math.sin(a) * r * 0.8), s, s, R.steel[rng() < 0.5 ? 1 : 3]);
    }
  }
  // fire + smoke
  glow(f, cx + 3 * k, cy - k, (5 + kk * 2.5) * k, mix(rgba(255, 230, 160, 255), rgba(230, 70, 20, 255), t), { halo: 0.9, seed: 660 + kk, base: rgba(50, 20, 10, 255) });
  for (let i = 0; i < 4 + Math.round(kk * 2); i++) {
    const q = i / 6;
    glow(f, cx + (4 + Math.sin(i * 1.9) * 5) * k, cy + (-4 - i * 3.2) * k, (2.4 + i * 1.1) * k,
      mix(rgba(140, 140, 140, 255), rgba(40, 44, 48, 255), q), { halo: 0.6, seed: 670 + i, base: rgba(24, 26, 30, 255), core: 0.7 });
  }
  if (kk >= 2) wash(f, rgba(30, 24, 22, 255), 0.22);
  return f;
}

function paintWaspDead() {
  const k = K;
  const w = Math.round(WASP_W * k), h = Math.round(WASP_H * k);
  const f = makeFrame(w, h);
  const R = WASP;
  const gy = h - 1, cx = w / 2;
  // scorch under the wreck
  for (let y = gy - 5 * k; y <= gy; y++) {
    for (let x = 6 * k; x < w - 6 * k; x++) {
      const u = (x - cx) / (20 * k), v = (y - (gy - 2 * k)) / (4 * k);
      if (u * u + v * v > 1) continue;
      if (hash2(x, y, 700) > 0.7) continue;
      px(f, x, y, rgba(26, 22, 22, 255));
    }
  }
  capsule(f, cx - 10 * k, gy - 4 * k, cx + 8 * k, gy - 2 * k, 4.6 * k, 3.4 * k, R.hull, { grain: 0.14, seed: 701, shift: -1 });
  capsule(f, cx + 5 * k, gy - 6 * k, cx + 16 * k, gy - 3 * k, 2.4 * k, 1.8 * k, R.hull2, { grain: 0.1, seed: 702, shift: -1 });
  // bent rotor
  for (let i = 0; i < 20; i++) {
    const t = i / 19;
    px(f, cx - (12 + t * 9) * k, gy + (-6 + Math.sin(t * 2.6) * 4) * k, R.steel[t < 0.5 ? 2 : 1]);
    px(f, cx - (12 + t * 9) * k, gy + (-5 + Math.sin(t * 2.6) * 4) * k, R.steel[1]);
  }
  blob(f, cx - 2 * k, gy - 5 * k, 2.4 * k, 2.0 * k, R.dark, { shift: 1 });
  glow(f, cx - 2 * k, gy - 5 * k, 3.2 * k, rgba(180, 40, 30, 255), { halo: 0.3, seed: 703, base: rgba(30, 12, 10, 255) });
  for (let i = 0; i < 3; i++) {
    glow(f, cx + (2 + i * 3) * k, gy - (8 + i * 3) * k, (2.2 + i) * k, rgba(90, 96, 100, 255), { halo: 0.5, seed: 710 + i, base: rgba(24, 26, 30, 255), core: 0.7 });
  }
  wash(f, rgba(24, 20, 20, 255), 0.2);
  return f;
}

export function buildSprites() {
  const frames = {};
  const recipes = {};
  const rig = {};
  const cast = [makeWrencher(), makeSparker(), makeBellows(), makePriest()];
  for (const ch of cast) paintHumanoidSet(frames, ch, HANDS[ch.id], recipes, rig);
  paintWaspSet(frames);
  paintMutterSet(frames);
  paintQuadSet(frames, makeGhoul(), recipes, rig);
  paintQuadSet(frames, makeStalker(), recipes, rig);
  paintHumanoidSet(frames, makeGorger(), gorgerHands, recipes, rig);
  paintHumanoidSet(frames, makeHowler(), howlerHands, recipes, rig);
  paintMawSet(frames);
  paintGore(frames);
  paintProps(frames);
  paintSky(frames);
  paintDecals(frames);
  return { frames, maim: makeMaim(frames, recipes), rig };
}

// ---------------------------------------------------------------------------
// MUTTER - the launch-control intelligence as a wall-mounted machine face
// ---------------------------------------------------------------------------

const MU = {
  crete: mat(rgba(122, 120, 114, 255), { contrast: 0.9 }),
  crete2: mat(rgba(98, 96, 92, 255), { contrast: 0.9 }),
  steel: mat(rgba(116, 122, 132, 255), { contrast: 1.25 }),
  steel2: mat(rgba(78, 84, 94, 255), { contrast: 1.25 }),
  dark: mat(rgba(28, 28, 34, 255)),
  cable: mat(rgba(40, 38, 44, 255), { contrast: 1.4 }),
  rust: mat(rgba(124, 70, 34, 255)),
  brass: mat(rgba(180, 144, 62, 255), { contrast: 1.3 }),
  board: mat(rgba(38, 88, 60, 255), { contrast: 1.25 }),
  ink: rgba(10, 10, 14, 255),
};

const MW = 192, MH = 160;
// face landmarks
const MEY = 62, MEXL = 63, MEXR = 129, MMY = 113, MMX = 96;

/** Concrete fill with fbm mottling and a bevel toward the given edges. */
function creteSpan(f, x0, x1, y, ramp, top, bot, seed) {
  for (let x = Math.round(x0); x <= Math.round(x1); x++) {
    const n = fbm(seed, x * 0.10, y * 0.10, 4, 8);
    let b = 2 + (n > 0.585 ? 1 : n < 0.415 ? -1 : 0);
    if (x < x0 + 2.5) b += 1; else if (x < x0 + 5) b += 0;
    if (x > x1 - 2.5) b -= 1;
    if (top) b += 1;
    if (bot) b -= 2;
    px(f, x, y, ramp[clamp(b, 0, 4)]);
  }
}

/** The bulkhead: overhanging brow, tapered jaw slab, vent shroud. */
function mutterShell(f) {
  const R = MU;
  // --- brow lintel, overhanging and casting shadow on the face below
  const bx0 = 28, bx1 = MW - 28, by0 = 10, by1 = 30;
  for (let y = by0; y <= by1; y++) {
    const inset = y > by1 - 4 ? (y - (by1 - 4)) * 2.6 : 0;
    creteSpan(f, bx0 + inset, bx1 - inset, y, R.crete2, y < by0 + 2, y > by1 - 2, 0x2a1);
  }
  // --- main slab, tapering to a jaw
  const top = 28, bot = 132;
  for (let y = top; y <= bot; y++) {
    const t = (y - top) / (bot - top);
    const half = lerp(56, 37, Math.pow(t, 1.7));
    creteSpan(f, MW / 2 - half, MW / 2 + half, y, R.crete, false, y > bot - 3, 0x2a1);
  }
  // brow shadow across the top of the face
  for (let y = top; y < top + 9; y++) {
    const k = 1 - (y - top) / 9;
    for (let x = 24; x < MW - 24; x++) over(f, x, y, R.ink, 0.55 * k);
  }
  // --- vent shroud / jaw
  box(f, 68, bot - 2, MW - 136, 14, R.steel2, { grain: 0.08, seed: 802 });
  for (let i = 0; i < 4; i++) {
    fillRect(f, 73, bot + 2 + i * 3, MW - 146, 2, R.dark[1]);
    fillRect(f, 73, bot + 2 + i * 3, MW - 146, 1, R.steel2[3]);
  }
  // --- eye brow recess: one long inset band holding both optics
  const rx0 = 40, rx1 = MW - 40, ry0 = 40, ry1 = 88;
  for (let y = ry0; y <= ry1; y++) {
    for (let x = rx0; x <= rx1; x++) {
      const n = fbm(0x77b, x * 0.16, y * 0.16, 3, 8);
      px(f, x, y, R.steel2[n > 0.56 ? 1 : 0]);
    }
  }
  for (let x = rx0 - 2; x <= rx1 + 2; x++) {
    for (let k = 0; k < 3; k++) {
      over(f, x, ry0 - 1 - k, R.ink, 0.55 - k * 0.16);
      over(f, x, ry1 + 1 + k, R.crete[4], 0.42 - k * 0.13);
    }
  }
  for (let y = ry0 - 2; y <= ry1 + 2; y++) {
    for (let k = 0; k < 3; k++) {
      over(f, rx0 - 1 - k, y, R.ink, 0.5 - k * 0.15);
      over(f, rx1 + 1 + k, y, R.crete[4], 0.35 - k * 0.11);
    }
  }
  // --- nose: an armoured intake column between the eyes
  box(f, MMX - 11, 46, 22, 52, R.steel, { grain: 0.07, seed: 805 });
  for (let i = 0; i < 7; i++) {
    fillRect(f, MMX - 8, 52 + i * 6, 16, 3, R.dark[1]);
    fillRect(f, MMX - 8, 52 + i * 6, 16, 1, R.steel[4]);
  }
  fillRect(f, MMX - 11, 46, 22, 2, R.steel[4]);
  fillRect(f, MMX - 12, 96, 24, 4, R.steel2[2]);
  // --- cheek plates flanking the mouth: speaker grilles, the voice comes from here
  for (const sx of [-1, 1]) {
    const cx0 = MMX + sx * 33 - 10;
    box(f, cx0, 98, 20, 26, R.steel2, { grain: 0.07, seed: 806 + sx });
    for (let j = 0; j < 5; j++) {
      for (let i = 0; i < 4; i++) {
        blob(f, cx0 + 4.5 + i * 3.7, 104.5 + j * 3.6, 1.1, 1.1, flat(R.dark[0]));
        px(f, cx0 + 4 + i * 3.7, 104 + j * 3.6, R.steel2[0]);
      }
    }
    for (let i = 0; i < 4; i++) {
      px(f, cx0 + 1 + (i % 2) * 17, 100 + ((i / 2) | 0) * 22, R.steel[4]);
    }
  }
  // --- hex bolts around the border
  for (let i = 0; i < 7; i++) {
    const bxp = 42 + i * ((MW - 84) / 6);
    for (const byp of [22, 128]) {
      blob(f, bxp, byp, 3.2, 3.0, R.steel, {});
      blob(f, bxp, byp, 1.6, 1.5, R.steel, { shift: -1 });
      px(f, Math.round(bxp - 1), Math.round(byp - 1), R.steel[4]);
    }
  }
  for (let i = 0; i < 3; i++) {
    for (const bxp of [42, MW - 42]) {
      const byp = 52 + i * 30;
      blob(f, bxp + (bxp < 96 ? 4 : -4), byp, 3.0, 2.8, R.steel, {});
      px(f, Math.round(bxp + (bxp < 96 ? 3 : -5)), Math.round(byp - 1), R.steel[4]);
    }
  }
  // --- stencil plate on the brow
  box(f, MW / 2 - 34, 12, 68, 13, R.steel2, { grain: 0.06, seed: 803 });
  stencil(f, MW / 2 - 29, 15, 'MUTTER', mix(R.brass[3], WARM, 0.25));
  stencil(f, MW / 2 + 4, 16, '-01', R.brass[1]);
  // --- the forehead monitor housing (the screen itself is painted per frame)
  box(f, 31, 11, 30, 17, R.steel2, { grain: 0.05, seed: 811 });
  fillRect(f, 33, 13, 26, 13, R.ink);
  // --- status lamp strip under the nameplate, and a warning placard
  box(f, MW / 2 + 36, 13, 24, 11, R.dark, {});
  // a yellow sticky note on the brow, the handwriting illegible and polite
  fillRect(f, 142, 32, 13, 11, rgba(236, 222, 96, 255));
  fillRect(f, 142, 32, 13, 2, rgba(214, 198, 70, 255));
  for (let i = 0; i < 3; i++) stitch(f, 144, 36 + i * 2.4, 152 - i * 2, 36 + i * 2.4, rgba(60, 60, 140, 255), 1, 2, 1);
  // danger placard hanging off the jaw on two chains
  for (const cx0 of [78, 114]) for (let y = 142; y < 148; y++) px(f, cx0, y, R.steel[y % 2 ? 1 : 3]);
  box(f, 70, 147, 52, 10, mat(rgba(214, 170, 50, 255), { contrast: 1.1 }), {});
  for (let x = 71; x < 121; x += 4) fillRect(f, x, 155, 2, 1, R.dark[0]);
  // --- bullet dings: bright rims round dark pits
  const bings = [[52, 34], [140, 58], [150, 96], [44, 118], [118, 34], [34, 80], [158, 76], [64, 126]];
  for (const [x, y] of bings) {
    blob(f, x, y, 1.6, 1.5, flat(rgba(40, 38, 40, 255)));
    over(f, x - 1, y - 2, WARM, 0.55); over(f, x + 1, y + 2, R.ink, 0.5);
  }
  // --- rust runs
  const rng = makeRng(0x4411);
  for (let i = 0; i < 34; i++) {
    const rx = 30 + rng() * (MW - 60), ry = 28 + rng() * 96;
    const ln = 6 + rng() * 24;
    for (let k = 0; k < ln; k++) {
      if (hash2(rx, ry + k, 8100) < 0.35) continue;
      over(f, rx, ry + k, R.rust[1], 0.34 * (1 - k / ln));
      if (rng() < 0.25) over(f, rx + 1, ry + k, R.rust[0], 0.22);
    }
  }
}

/**
 * The forehead monitor. MUTTER is unfailingly polite, and the face on its
 * screen says so right up until it doesn't: a smile at idle, a stare while
 * firing, a wince in pain, and a blue screen when it finally dies.
 */
function mutterScreen(f, mood, flick) {
  const x0 = 33, y0 = 13, w = 26, h = 13;
  const bgc = mood === 'bsod' ? rgba(24, 48, 170, 255) : rgba(12, 30, 20, 255);
  const fg = mood === 'bsod' ? rgba(236, 240, 255, 255) : mood === 'angry' ? rgba(255, 96, 70, 255) : rgba(120, 255, 150, 255);
  fillRect(f, x0, y0, w, h, bgc);
  const txt = mood === 'smile' ? ':)' : mood === 'wink' ? ';)' : mood === 'angry' ? '>:(' : mood === 'hurt' ? ':O' : mood === 'bsod' ? ':(' : ':|';
  if (mood === 'wink') { stencil(f, x0 + 9, y0 + 4, ':', fg); fillRect(f, x0 + 10, y0 + 5, 2, 1, fg); stencil(f, x0 + 13, y0 + 4, ')', fg); }
  else stencil(f, x0 + (mood === 'angry' ? 7 : 9), y0 + 4, txt, fg);
  if (mood === 'bsod') { for (let i = 0; i < 3; i++) fillRect(f, x0 + 3, y0 + 2 + i * 4, i === 1 ? 4 : 20, 1, mix(bgc, fg, 0.5)); }
  // scanlines and a phosphor bloom
  for (let y = y0; y < y0 + h; y += 2) for (let x = x0; x < x0 + w; x++) over(f, x, y, rgba(0, 0, 0, 255), 0.22);
  if (flick) for (let x = x0; x < x0 + w; x++) over(f, x, y0 + (flick % h), fg, 0.3);
  glow(f, x0 + w / 2, y0 + h / 2, 16, fg, { halo: 0, tint: 0.12, seed: 812 });
}

/** Status lamps in the strip beside the nameplate, a new pattern per frame. */
function mutterLamps(f, n, alarm) {
  const cols = [rgba(90, 255, 120, 255), rgba(255, 200, 60, 255), rgba(255, 70, 50, 255), rgba(90, 170, 255, 255)];
  for (let i = 0; i < 5; i++) {
    const on = alarm ? ((i + n) % 2 === 0) : hash2(i, n, 813) < 0.6;
    const c = alarm ? cols[2] : cols[i % 4];
    const x = MW / 2 + 39 + i * 4, y = 18;
    blob(f, x, y, 1.3, 1.3, flat(on ? c : mix(c, rgba(20, 20, 24, 255), 0.75)));
    if (on) px(f, x - 1, y - 1, rgba(255, 255, 240, 255));
  }
  if (alarm) stencil(f, 84, 149, 'DANGER', rgba(200, 30, 20, 255));
  else { stencil(f, 74, 149, 'NO', rgba(30, 26, 20, 255)); stencil(f, 86, 149, 'HUMANS', rgba(30, 26, 20, 255)); }
}

/** Feed cables: they leave the top of the brow and hang down both sides. */
function mutterCables(f, droop) {
  const R = MU;
  for (let i = 0; i < 8; i++) {
    const s2 = i % 2 ? 1 : -1;
    const k = (i / 2) | 0;                       // 0..3 outward
    const xTop = MW / 2 + s2 * (28 + k * 10);    // leaves the brow here
    const xHang = MW / 2 + s2 * (63 + k * 7);    // then hangs in the side margin
    const yEnd = 66 + k * 14 + droop * 22 + (i % 2) * 6;
    let pxp = xTop, pyp = 2;
    for (let q = 1; q <= 22; q++) {
      const t = q / 22;
      // swing out fast, then fall
      const ease = Math.pow(Math.min(1, t * 2.1), 0.7);
      const bx = lerp(xTop, xHang, ease) + s2 * Math.sin(t * 5.5 + k) * 1.8 * t;
      const by = lerp(6, yEnd, Math.pow(t, 1.35));
      capsule(f, pxp, pyp, bx, by, 2.1 - t * 0.7, 1.9 - t * 0.7, R.cable,
        { shift: i % 3 ? 0 : -1, edge: R.ink, edgeW: 0.8 });
      if (q % 5 === 2) over(f, bx, by, rgba(214, 170, 60, 255), 0.6);   // cable ties
      pxp = bx; pyp = by;
    }
    // connector boot on the end
    blob(f, pxp, pyp + 1, 2.3, 2.7, R.steel, { shift: -1, edge: R.ink });
    fillRect(f, Math.round(pxp - 2), Math.round(pyp + 3), 5, 1, R.dark[1]);
    // clamp collar partway down
    const ct = 0.42;
    const cxp = lerp(xTop, xHang, Math.pow(Math.min(1, ct * 2.1), 0.7));
    const cyp = lerp(6, yEnd, Math.pow(ct, 1.35));
    if (k % 2 === 0) blob(f, cxp, cyp, 3.2, 2.6, R.brass, { edge: R.ink });
  }
}

/** One optic: a deep socket, a bezel, a hot lens, satellites and a shutter. */
function mutterEye(f, cx, cy, bright, lid, broken, seedn) {
  const R = MU;
  // socket
  blob(f, cx, cy, 20, 18, R.dark, { shift: 0, edge: R.ink, edgeW: 1.2 });
  blob(f, cx, cy, 17.5, 15.5, R.steel2, { grain: 0.08, seed: seedn });
  // bezel with screws
  for (let a = 0; a < 6.283; a += 0.04) {
    px(f, cx + Math.cos(a) * 14.6, cy + Math.sin(a) * 13.0, R.steel[a > 3.4 && a < 5.9 ? 4 : 1]);
    px(f, cx + Math.cos(a) * 13.6, cy + Math.sin(a) * 12.1, R.steel[a > 3.4 && a < 5.9 ? 3 : 0]);
  }
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4 + 0.35;
    blob(f, cx + Math.cos(a) * 15.7, cy + Math.sin(a) * 14.0, 1.7, 1.6, R.steel, {});
    px(f, cx + Math.cos(a) * 15.3, cy + Math.sin(a) * 13.5, R.steel[4]);
  }
  blob(f, cx, cy, 13.5, 12.0, R.dark, { shift: 1 });
  if (broken) {
    blob(f, cx, cy, 11.5, 10.2, flat(rgba(14, 13, 17, 255)));
    const rng = makeRng(0x777 + seedn);
    for (let i = 0; i < 11; i++) {
      const a = rng() * 6.28;
      line(f, cx, cy, cx + Math.cos(a) * 11, cy + Math.sin(a) * 9.8, rgba(104, 108, 118, 255));
      line(f, cx + Math.cos(a) * 5, cy + Math.sin(a) * 4.4, cx + Math.cos(a + 0.5) * 11, cy + Math.sin(a + 0.5) * 9.8, rgba(52, 54, 62, 255));
    }
    for (let i = 0; i < 7; i++) {
      const a = rng() * 6.28, r = rng() * 8;
      px(f, cx + Math.cos(a) * r, cy + Math.sin(a) * r, rgba(158, 164, 176, 255));
    }
    // a spring and a loose wire boing out of the empty socket
    for (let i = 0; i < 10; i++) {
      const t = i / 9;
      px(f, cx + 3 + Math.sin(t * 18) * 2.4, cy + 2 - t * 14, rgba(190, 196, 206, 255));
      px(f, cx + 4 + Math.sin(t * 18) * 2.4, cy + 2 - t * 14, rgba(96, 100, 110, 255));
    }
    if (bright > 0) glow(f, cx + 3, cy + 2, 5 + bright * 5, rgba(255, 120, 40, 255), { halo: 0, seed: seedn + 3 });
  } else {
    const lc = mix(rgba(146, 40, 24, 255), rgba(255, 226, 160, 255), bright);
    blob(f, cx, cy, 11.5, 10.2, flat(mix(rgba(34, 12, 10, 255), lc, 0.30)));
    blob(f, cx, cy, 8.6, 7.6, flat(mix(rgba(60, 18, 12, 255), lc, 0.68)));
    blob(f, cx, cy, 5.4, 4.8, flat(mix(lc, rgba(255, 246, 220, 255), 0.25 + bright * 0.5)));
    blob(f, cx, cy, 3.4, 3.0, flat(mix(lc, rgba(255, 252, 236, 255), 0.45 + bright * 0.5)));
    blob(f, cx, cy, 2.4, 2.1, flat(rgba(18, 10, 12, 255)));           // pupil
    // iris leaves
    for (let i = 0; i < 10; i++) {
      const a = i * 0.6283 + 0.2;
      line(f, cx + Math.cos(a) * 3.0, cy + Math.sin(a) * 2.6, cx + Math.cos(a) * 8.2, cy + Math.sin(a) * 7.2,
        mix(lc, i % 2 ? rgba(20, 10, 10, 255) : WARM, 0.35));
    }
    glow(f, cx, cy, 20 + bright * 9, lc, { halo: 0.4 + bright * 0.4, seed: seedn + 1, base: rgba(26, 13, 11, 255), core: 0.62 });
    blob(f, cx - 3.6, cy - 3.4, 2.0, 1.5, flat(rgba(255, 252, 238, 255)));
    px(f, cx + 3, cy + 3, rgba(255, 240, 220, 255));
  }
  // satellite optics stacked below the socket
  for (let i = 0; i < 3; i++) {
    const sx = cx - 13 + i * 13, sy = cy + 23;
    blob(f, sx, sy, 4.2, 4.0, R.steel, { edge: R.ink });
    const sc = broken ? rgba(38, 38, 44, 255) : mix(rgba(56, 116, 86, 255), rgba(206, 255, 224, 255), bright);
    blob(f, sx, sy, 2.3, 2.2, flat(sc));
    if (!broken) glow(f, sx, sy, 5, sc, { halo: 0.3, seed: seedn + 10 + i, base: rgba(14, 26, 20, 255), core: 0.85 });
  }
  // armoured shutter sliding down over the socket
  if (lid > 0.01) {
    const hgt = Math.round(42 * lid);
    box(f, Math.round(cx - 21), Math.round(cy - 20), 42, hgt, R.steel, { grain: 0.06, seed: seedn + 20 });
    fillRect(f, Math.round(cx - 21), Math.round(cy - 20 + hgt - 1), 42, 1, R.dark[1]);
    for (let i = 0; i < 5; i++) {
      fillRect(f, Math.round(cx - 18 + i * 8), Math.round(cy - 19), 2, Math.max(1, hgt - 3), R.steel[i % 2 ? 1 : 3]);
    }
  }
}

/** The launch aperture: an armoured ring with iris blades and fire behind. */
function mutterMouth(f, cx, cy, iris, fire, dead) {
  const R = MU;
  const rad = 27, ry = 22;
  // recessed ring housing
  blob(f, cx, cy, rad + 6, ry + 6, R.steel2, { grain: 0.07, seed: 830, edge: R.ink, edgeW: 1.4 });
  for (let a = 0; a < 6.283; a += 0.03) {
    px(f, cx + Math.cos(a) * (rad + 4), cy + Math.sin(a) * (ry + 4), R.steel[a > 3.3 && a < 6.0 ? 4 : 1]);
  }
  for (let i = 0; i < 14; i++) {
    const a = i * 0.4488 + 0.2;
    blob(f, cx + Math.cos(a) * (rad + 2.4), cy + Math.sin(a) * (ry + 2.4), 1.9, 1.8, R.steel, {});
    px(f, cx + Math.cos(a) * (rad + 2.0), cy + Math.sin(a) * (ry + 2.0), R.steel[4]);
  }
  blob(f, cx, cy, rad, ry, R.dark, { shift: 0 });
  // fiery bore
  const bore = 1 - Math.pow(1 - iris, 1.3);
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
    for (let x = Math.floor(cx - rad); x <= Math.ceil(cx + rad); x++) {
      const d = Math.hypot((x - cx) / rad, (y - cy) / ry);
      if (d > 1) continue;
      let c;
      if (dead) c = mix(rgba(16, 15, 17, 255), rgba(46, 42, 44, 255), 1 - d);
      else {
        const heat = clamp(1 - d / Math.max(0.12, bore), 0, 1);
        c = mix(rgba(22, 12, 10, 255), mix(rgba(238, 108, 24, 255), rgba(255, 250, 216, 255), Math.pow(heat, 1.6)), Math.pow(heat, 0.55));
        if (fire > 0) c = mix(c, rgba(255, 255, 244, 255), fire * Math.pow(heat, 2.0));
      }
      px(f, x, y, c);
    }
  }
  if (!dead && iris > 0.1) {
    glow(f, cx, cy, rad * (0.9 + fire * 0.7), rgba(255, 168, 56, 255),
      { halo: 0.45 + fire * 0.5, seed: 831, base: rgba(48, 20, 8, 255), core: 0.55 });
  }
  // iris blades: trapezoids from the rim inward, retracting as iris -> 1
  const n = 8;
  for (let i = 0; i < n; i++) {
    const a0 = i * 2 * Math.PI / n - 0.18, a1 = (i + 1) * 2 * Math.PI / n + 0.18;
    const ti = Math.max(0.04, iris);
    const pts = [
      { x: cx + Math.cos(a0) * rad, y: cy + Math.sin(a0) * ry },
      { x: cx + Math.cos(a1) * rad, y: cy + Math.sin(a1) * ry },
      { x: cx + Math.cos(a1 - 0.1) * rad * ti, y: cy + Math.sin(a1 - 0.1) * ry * ti },
      { x: cx + Math.cos(a0 + 0.1) * rad * ti, y: cy + Math.sin(a0 + 0.1) * ry * ti },
    ];
    const am = (a0 + a1) / 2;
    const lam = lamOf(Math.cos(am) * 0.75, Math.sin(am) * 0.6, 0.72);
    fillPoly(f, pts, R.steel[clamp(band(lam), 1, 3)]);
    line(f, pts[0].x, pts[0].y, pts[3].x, pts[3].y, R.dark[1]);
    line(f, pts[3].x, pts[3].y, pts[2].x, pts[2].y, R.steel[4]);
    // hazard chevron on every other blade
    if (i % 2 === 0 && iris < 0.6) {
      const mx = cx + Math.cos(am) * rad * (0.55 + ti * 0.2), my = cy + Math.sin(am) * ry * (0.55 + ti * 0.2);
      blob(f, mx, my, 1.8, 1.4, flat(mix(rgba(214, 170, 40, 255), R.steel[2], 0.3)));
    }
  }
  if (dead) {
    wash(f, rgba(20, 18, 20, 255), 0.4, (x, y) => Math.hypot((x - cx) / (rad + 7), (y - cy) / (ry + 7)) < 1);
  }
}

/** Accumulating structural damage: cracks, holes, exposed burning circuitry. */
function mutterDamage(f, level) {
  if (level <= 0) return;
  const R = MU;
  const rng = makeRng(0xbeef);
  const cracks = [];
  for (let i = 0; i < 16; i++) {
    cracks.push({ x: 34 + rng() * (MW - 68), y: 30 + rng() * 100, a: rng() * 6.28, l: 14 + rng() * 36 });
  }
  const nc = Math.round(cracks.length * clamp(level, 0, 1));
  for (let i = 0; i < nc; i++) {
    const c = cracks[i];
    let x = c.x, y = c.y, a = c.a;
    for (let k = 0; k < c.l; k++) {
      a += (hash2(x, y, 900 + i) - 0.5) * 0.55;
      x += Math.cos(a); y += Math.sin(a);
      over(f, x, y, rgba(13, 11, 13, 255), 0.85);
      over(f, x + 1, y, rgba(184, 180, 172, 255), 0.32);
      if (k % 7 === 3) {
        let bx = x, by = y, ba = a + (hash2(x, y, 901) < 0.5 ? 1 : -1);
        for (let m = 0; m < 9; m++) { bx += Math.cos(ba); by += Math.sin(ba); over(f, bx, by, rgba(15, 13, 15, 255), 0.7); }
      }
    }
  }
  const holes = [[44, 40, 9], [150, 44, 8], [36, 104, 10], [158, 108, 9], [96, 34, 11], [76, 136, 8]];
  const nh = Math.round(holes.length * clamp((level - 0.25) / 0.75, 0, 1));
  for (let i = 0; i < nh; i++) {
    const [hx, hy, hr] = holes[i];
    for (let y = hy - hr; y <= hy + hr; y++) {
      for (let x = hx - hr; x <= hx + hr; x++) {
        const d = Math.hypot(x - hx, y - hy) / hr;
        if (d > 1 - hash2(x, y, 910 + i) * 0.3) continue;
        if (!(getpx(f, x, y) >>> 24)) continue;
        px(f, x, y, d > 0.7 ? rgba(20, 17, 19, 255) : R.board[hash2(x, y, 911) < 0.4 ? 1 : 2]);
      }
    }
    for (let k = 0; k < 6; k++) {
      const a = k * 1.05;
      line(f, hx, hy, hx + Math.cos(a) * hr * 0.7, hy + Math.sin(a) * hr * 0.7, R.brass[3]);
    }
    glow(f, hx, hy, hr * 1.3, rgba(255, 148, 48, 255), { halo: 0, seed: 920 + i });
    for (let k = 0; k < 5; k++) {
      const a = hash2(hx, hy + k, 930) * 6.28, r = hash2(hx + k, hy, 931) * hr;
      px(f, hx + Math.cos(a) * r, hy + Math.sin(a) * r, rgba(255, 232, 176, 255));
    }
    for (let k = 0; k < 18; k++) {
      const t = k / 17;
      speckle(f, Math.round(hx - 5 - t * 5), Math.round(hy - hr - k), 12, 1, rgba(18, 16, 16, 255), 0.55 * (1 - t), 940 + k, 0.55);
    }
  }
}

let MUTTER_SHELL = null;

function paintMutter(o) {
  const f = makeFrame(MW, MH);
  mutterCables(f, o.droop || 0);
  // the shell is identical in every frame and is most of the cost: paint once
  if (!MUTTER_SHELL) { MUTTER_SHELL = makeFrame(MW, MH); mutterShell(MUTTER_SHELL); }
  const S = MUTTER_SHELL.data;
  for (let i = 0; i < S.length; i++) if (S[i] >>> 24) f.data[i] = S[i];
  mutterScreen(f, o.mood || 'smile', o.flick || 0);
  mutterLamps(f, o.lamps || 0, !!o.alarm);
  const eb = o.eye === undefined ? 0.5 : o.eye;
  mutterEye(f, MEXL, MEY, eb, o.lidL || 0, o.brokenL, 41);
  mutterEye(f, MEXR, MEY, o.eyeR === undefined ? eb : o.eyeR, o.lidR || 0, o.brokenR, 57);
  mutterMouth(f, MMX, MMY, o.iris || 0, o.fire || 0, o.dead);
  mutterDamage(f, o.damage || 0);
  if (o.hurt) {
    for (const ex of [MEXL, MEXR]) glow(f, ex, MEY, 30, rgba(255, 244, 226, 255), { halo: 0, seed: 850 });
    glow(f, MMX, MMY, 34, rgba(255, 150, 90, 255), { halo: 0, seed: 851 });
  }
  if (o.flash) wash(f, rgba(226, 84, 44, 255), o.flash);
  if (o.soot) wash(f, rgba(20, 18, 18, 255), o.soot);
  grade(f, 1.12);
  topRim(f, WARM, 0.26, 0.1);
  sideRim(f, RIM, 0.22, 0.08);
  outline(f, MU.ink);
  return f;
}

function paintMutterSet(out) {
  for (let i = 0; i < 4; i++) {
    const p = i / 4 * Math.PI * 2;
    out[`mutter_idle${i}`] = paintMutter({
      eye: 0.40 + 0.18 * Math.sin(p), eyeR: 0.40 + 0.18 * Math.sin(p + 1.6),
      lidL: i === 2 ? 0.62 : 0, lidR: i === 2 ? 0.45 : 0,
      iris: 0, droop: 0.05 * Math.sin(p), mood: i === 2 ? 'wink' : 'smile', lamps: i, flick: i * 4,
    });
  }
  out.mutter_fire0 = paintMutter({ eye: 0.78, iris: 0.3, droop: 0.02, mood: 'neutral', lamps: 5, alarm: true });
  out.mutter_fire1 = paintMutter({ eye: 0.95, iris: 0.8, fire: 0.4, mood: 'angry', lamps: 6, alarm: true });
  out.mutter_fire2 = paintMutter({ eye: 1, iris: 1, fire: 1, flash: 0.1, mood: 'angry', lamps: 7, alarm: true });
  out.mutter_pain = paintMutter({ eye: 1, eyeR: 1, iris: 0.12, flash: 0.1, lidL: 0.3, damage: 0.1, hurt: 1, mood: 'hurt', lamps: 8, alarm: true });
  for (let k = 0; k < 6; k++) {
    const t = (k + 1) / 6;
    out[`mutter_die${k}`] = paintMutter({
      damage: t,
      eye: k < 3 ? 1 - t * 0.4 : 0.3 * (1 - t),
      eyeR: k < 2 ? 0.9 : 0,
      brokenL: k >= 4, brokenR: k >= 2,
      lidL: k === 5 ? 0.3 : 0, lidR: k >= 3 ? 0.22 : 0,
      iris: k < 4 ? 0.5 - t * 0.3 : 0.22,
      fire: k < 3 ? 0.5 : 0,
      droop: t * 0.9,
      soot: t * 0.3,
      flash: 0,
      mood: k < 2 ? 'hurt' : 'bsod', lamps: 9 + k, alarm: k % 2 === 0, flick: k * 3,
    });
  }
  out.mutter_dead = paintMutter({
    damage: 1, eye: 0, eyeR: 0, brokenL: true, brokenR: true,
    iris: 0.3, dead: true, droop: 1.2, soot: 0.52, lidL: 0.4, lidR: 0.55, mood: 'bsod', lamps: 20,
  });
}

// ---------------------------------------------------------------------------
// pickups & props
// ---------------------------------------------------------------------------

const PR = {
  steel: mat(rgba(126, 132, 142, 255), { contrast: 1.2 }),
  dark: mat(rgba(38, 38, 44, 255)),
  brass: mat(rgba(190, 152, 60, 255), { contrast: 1.3 }),
  gold: mat(rgba(226, 182, 58, 255), { contrast: 1.35 }),
  olive: mat(rgba(86, 102, 70, 255), { contrast: 1.1 }),
  wood: mat(rgba(140, 104, 62, 255), { contrast: 1.05 }),
  rust: mat(rgba(132, 76, 40, 255), { contrast: 1.1 }),
  drum: mat(rgba(96, 104, 96, 255), { contrast: 1.15 }),
  hazard: mat(rgba(216, 176, 40, 255), { contrast: 1.2 }),
  crete: mat(rgba(132, 130, 124, 255), { contrast: 0.9 }),
  white: mat(rgba(226, 228, 232, 255), { contrast: 1.1 }),
  red: mat(rgba(198, 48, 44, 255), { contrast: 1.25 }),
  copper: mat(rgba(178, 106, 52, 255), { contrast: 1.25 }),
};

function finishProp(f, ink) {
  topRim(f, WARM, 0.22, 0.08);
  outline(f, ink || INK);
  return f;
}

/** Chunky keycard: coloured body, magnetic stripe, chevron, chip, teeth. */
function paintKey(base) {
  const f = makeFrame(32, 32);
  const R = mat(base, { contrast: 1.35 });
  const D = mat(shade(base, 0.5), { contrast: 1.2 });
  const cx = 16, cy = 16;
  const hw = 10, hh = 8;
  const ink = mix(shade(base, 0.24), INK, 0.45);
  // card body, slightly tilted, with rounded corners
  for (let y = -hh; y <= hh; y++) {
    const sk = Math.round(y * 0.18);
    const cut = Math.abs(y) > hh - 2 ? 2 : 0;
    for (let x = -hw + cut; x <= hw - cut; x++) {
      let b = 2;
      if (y < -hh + 2) b = 4; else if (y < -hh + 4) b = 3;
      else if (y > hh - 2) b = 0; else if (y > hh - 4) b = 1;
      if (x < -hw + cut + 1) b = Math.min(4, b + 1);
      if (x > hw - cut - 1) b = Math.max(0, b - 1);
      if (hash2(x, y, 1002) < 0.05) b -= 1;
      px(f, cx + x + sk, cy + y, R[clamp(b, 0, 4)]);
    }
  }
  // magnetic stripe across the top third
  for (let y = -5; y <= -3; y++) {
    for (let x = -9; x <= 9; x++) px(f, cx + x + Math.round(y * 0.18), cy + y, y === -5 ? PR.dark[3] : PR.dark[1]);
  }
  // chevron pointing right, in the card's own bright tint
  for (let i = 0; i < 5; i++) {
    for (let k = 0; k < 3; k++) {
      px(f, cx - 6 + i + k, cy + 1 + i, R[4]);
      px(f, cx - 6 + i + k, cy + 1 - i, R[4]);
    }
  }
  for (let i = 0; i < 5; i++) {
    px(f, cx - 6 + i, cy + 1 + i, D[1]);
    px(f, cx - 6 + i, cy + 1 - i, D[1]);
  }
  // gold contact chip + punch hole
  box(f, cx + 3, cy + 1, 6, 5, PR.brass, {});
  for (let i = 0; i < 2; i++) line(f, cx + 4, cy + 2 + i * 2, cx + 8, cy + 2 + i * 2, PR.brass[0]);
  blob(f, cx + 7, cy - 6, 1.6, 1.4, flat(ink));
  // key teeth along the bottom edge
  for (let i = 0; i < 4; i++) fillRect(f, cx - 8 + i * 5, cy + hh - 1, 3, 3, D[2]);
  for (let i = 0; i < 4; i++) fillRect(f, cx - 8 + i * 5, cy + hh - 1, 3, 1, D[3]);
  glow(f, cx, cy, 15, base, { halo: 0.16, tint: 0.1, seed: 1001, base: shade(base, 0.22), core: 0.92 });
  return finishProp(f);
}

function paintMedkit(big) {
  const f = makeFrame(32, 32);
  const cx = 16, by = big ? 28 : 26;
  const tw = big ? 13 : 10, th = big ? 13 : 10;
  const EW = { edge: rgba(20, 24, 16, 255), edgeW: 0.9 };
  // body
  box(f, cx - tw, by - th, tw * 2, th, PR.olive, { grain: 0.07, seed: 1101 });
  // lid overhanging the body
  box(f, cx - tw - 1, by - th - 4, tw * 2 + 2, 5, PR.olive, { grain: 0.05, seed: 1102 });
  fillRect(f, cx - tw - 1, by - th - 1, tw * 2 + 2, 1, PR.dark[0]);
  fillRect(f, cx - tw - 1, by - th - 4, tw * 2 + 2, 1, PR.olive[4]);
  // corner reinforcements + latches
  for (const sx of [-1, 1]) {
    fillRect(f, cx + sx * tw - (sx > 0 ? 2 : 0), by - th, 2, th, PR.olive[sx > 0 ? 0 : 3]);
    box(f, cx + sx * (tw - 5) - 1, by - th - 2, 4, 4, PR.steel, {});
  }
  // handle
  capsule(f, cx - 4, by - th - 6, cx + 4, by - th - 6, 1.4, 1.4, PR.steel, { ...EW });
  fillRect(f, cx - 5, by - th - 5, 2, 2, PR.steel[1]);
  fillRect(f, cx + 4, by - th - 5, 2, 2, PR.steel[1]);
  // cross on a pale panel so it reads at any size
  const cc = big ? PR.red : PR.white;
  const arm = big ? 9 : 7, bar = big ? 3 : 3;
  const cyy = by - th + Math.round(th / 2);
  if (big) {
    const pw = arm + 4;
    box(f, cx - (pw >> 1), cyy - (pw >> 1), pw, pw, PR.white, { shift: -1 });
  }
  fillRect(f, cx - (arm >> 1), cyy - (bar >> 1), arm, bar, cc[2]);
  fillRect(f, cx - (bar >> 1), cyy - (arm >> 1), bar, arm, cc[2]);
  fillRect(f, cx - (arm >> 1), cyy - (bar >> 1), arm, 1, cc[3]);
  fillRect(f, cx - (bar >> 1), cyy - (arm >> 1), bar, 1, cc[3]);
  if (big) stencil(f, cx - 9, by - th - 3, 'FIELD', mix(PR.white[1], PR.olive[0], 0.3), 0.9);
  speckle(f, cx - tw, by - th, tw * 2, th, PR.dark[0], 0.05, 1103, 0.5);
  return finishProp(f);
}

function paintAmmoFlak() {
  const f = makeFrame(32, 32);
  const by = 26;
  // clip
  box(f, 8, by - 9, 17, 9, PR.steel, { grain: 0.06, seed: 1201 });
  fillRect(f, 8, by - 6, 17, 1, PR.dark[1]);
  // four stubby shells
  for (let i = 0; i < 4; i++) {
    const sx = 10 + i * 4;
    for (let k = 0; k < 9; k++) blob(f, sx, by - 12 - k * 0.9, 1.7, 1.2, PR.brass, { mode: 'cyl', nyBias: -0.1, shift: i % 2 ? 0 : 0 });
    blob(f, sx, by - 20.5, 1.6, 2.0, PR.copper, { shift: 0 });
    px(f, sx - 1, by - 21.5, PR.copper[4]);
  }
  fillRect(f, 8, by - 13, 17, 2, PR.dark[2]);
  fillRect(f, 8, by - 13, 17, 1, PR.steel[3]);
  return finishProp(f);
}

function paintAmmoCrate() {
  const f = makeFrame(32, 32);
  const by = 28;
  box(f, 3, by - 14, 26, 14, PR.wood, { grain: 0.14, seed: 1301 });
  // planks
  for (let i = 1; i < 4; i++) fillRect(f, 3, by - 14 + i * 4, 26, 1, shade(PR.wood[0], 0.8));
  // corner irons
  box(f, 3, by - 14, 3, 14, PR.steel, {});
  box(f, 26, by - 14, 3, 14, PR.steel, {});
  fillRect(f, 3, by - 2, 26, 2, PR.steel[1]);
  // lid, prised open
  for (let i = 0; i < 22; i++) {
    const y = by - 15 - Math.round(i * 0.28);
    px(f, 6 + i, y, PR.wood[3]);
    px(f, 6 + i, y + 1, PR.wood[2]);
    px(f, 6 + i, y + 2, PR.wood[1]);
  }
  // spilling shells
  const rng = makeRng(0x3131);
  for (let i = 0; i < 6; i++) {
    const sx = 8 + rng() * 16, sy = by - 17 + rng() * 4;
    const a = rng() * 1.2 - 0.6;
    capsule(f, sx, sy, sx + Math.cos(a) * 4, sy - Math.sin(a) * 4, 1.7, 1.5, PR.brass, {});
    blob(f, sx + Math.cos(a) * 5, sy - Math.sin(a) * 5, 1.5, 1.5, PR.copper, {});
  }
  stencil(f, 8, by - 11, 'FLAK', mix(PR.white[2], PR.wood[0], 0.3), 0.85);
  stencil(f, 8, by - 6, '40MM', mix(PR.hazard[3], PR.wood[0], 0.35), 0.8);
  speckle(f, 3, by - 14, 26, 14, PR.dark[0], 0.05, 1302, 0.4);
  return finishProp(f);
}

/** Gold launch key on a chain, spun over four frames. */
function paintTreasure(F) {
  const f = makeFrame(32, 32);
  const cx = 16, cy = 18;
  const a = F * Math.PI / 4;
  const sc = Math.abs(Math.cos(a));            // 1 = face on, 0 = edge on
  const wide = Math.max(1.0, sc * 6.2);
  const EW = { edge: rgba(58, 40, 8, 255), edgeW: 0.9 };
  // chain
  for (let i = 0; i < 7; i++) {
    px(f, cx + (i % 2 ? 0 : 1), 2 + i, PR.steel[i % 2 ? 2 : 4]);
    px(f, cx + (i % 2 ? 1 : 0), 2 + i, PR.steel[i % 2 ? 3 : 1]);
  }
  // split ring
  for (let t = 0; t < 6.283; t += 0.14) {
    px(f, cx + Math.cos(t) * 3.2, 11 + Math.sin(t) * 2.6, PR.steel[Math.sin(t) < 0 ? 4 : 1]);
  }
  // bow: a ring, foreshortened by the spin
  for (let t = 0; t < 6.283; t += 0.06) {
    const rx = wide, ry = 5.6;
    const x = cx + Math.cos(t) * rx, y = cy - 1 + Math.sin(t) * ry;
    capsule(f, x, y, x, y, 1.7, 1.7, PR.gold, { shift: Math.sin(t) < -0.2 ? 1 : (Math.sin(t) > 0.4 ? -1 : 0), ...EW });
  }

  // shaft with a hollow bore and two bits
  capsule(f, cx, cy + 4, cx, cy + 12, 2.0 * Math.max(0.5, sc * 1.1) + 0.4, 1.6, PR.gold, { ...EW });
  fillRect(f, Math.round(cx + 1), cy + 7, 4, 2, PR.gold[3]);
  fillRect(f, Math.round(cx + 1), cy + 10, 3, 2, PR.gold[3]);
  px(f, cx - 1, cy + 6, PR.gold[4]);
  glow(f, cx, cy, 11 + sc * 2, rgba(255, 214, 90, 255), { halo: 0.1, tint: 0.14, seed: 1402, base: rgba(48, 36, 10, 255), core: 0.94 });
  if (sc > 0.5) {
    // punch the bow open last, so nothing fills it back in
    const hx = wide - 2.4, hy = 3.4;
    for (let y = -5; y <= 5; y++) {
      for (let x = -7; x <= 7; x++) {
        if ((x * x) / (hx * hx) + (y * y) / (hy * hy) <= 1) px(f, cx + x, cy - 1 + y, 0);
      }
    }
    for (let t = 0; t < 6.283; t += 0.14) {
      px(f, cx + Math.cos(t) * (hx + 0.9), cy - 1 + Math.sin(t) * (hy + 0.9), PR.gold[Math.sin(t) > 0 ? 1 : 4]);
    }
  }
  if (F % 2 === 0) {
    for (let i = 0; i < 4; i++) {
      const ang = i * Math.PI / 2 + 0.5;
      px(f, cx + Math.cos(ang) * 11, cy + Math.sin(ang) * 11, rgba(255, 246, 200, 255));
    }
  }
  return finishProp(f);
}

function paintBarrel(lit) {
  const w = 40, h = 64;
  const f = makeFrame(w, h);
  const cx = 20, top = 12, bot = h - 2;
  const rx = 13;
  for (let y = top; y <= bot; y++) {
    const t = (y - top) / (bot - top);
    blob(f, cx, y, rx, 1.2, PR.drum, { mode: 'cyl', nyBias: -0.06, grain: 0.09, seed: 1500 + y });
  }
  // top rim ellipse
  blob(f, cx, top, rx, 4.4, PR.drum, { shift: 1, grain: 0.06, seed: 1501 });
  blob(f, cx, top, rx - 3, 3.0, PR.drum, { shift: -1, grain: 0.08, seed: 1502 });
  blob(f, cx + 5, top - 0.5, 2.6, 1.6, PR.steel, { shift: 1 });
  // rolling hoops
  for (const y of [top + 12, top + 26, bot - 6]) {
    blob(f, cx, y, rx + 0.8, 2.0, PR.drum, { mode: 'cyl', nyBias: -0.5, shift: 1 });
    fillRect(f, cx - rx, y + 2, rx * 2 + 1, 1, PR.drum[0]);
  }
  // hazard band
  const by0 = top + 16;
  for (let y = by0; y < by0 + 9; y++) {
    for (let x = cx - rx; x <= cx + rx; x++) {
      if (!(getpx(f, x, y) >>> 24)) continue;
      const s = ((x - y * 1.0) % 10 + 10) % 10;
      const u = (x - cx) / rx;
      const b = band(lamOf(u, -0.1, Math.sqrt(Math.max(0, 1 - u * u))));
      px(f, x, y, s < 5 ? PR.hazard[clamp(b, 0, 4)] : PR.dark[clamp(b, 0, 4)]);
    }
  }
  // rust and dents
  const rng = makeRng(0x77aa);
  for (let i = 0; i < 26; i++) {
    const x = cx - rx + rng() * rx * 2, y = top + rng() * (bot - top);
    const r = 1 + rng() * 3;
    for (let j = -r; j <= r; j++) for (let k = -r; k <= r; k++) {
      if (j * j + k * k > r * r) continue;
      if (hash2(x + j, y + k, 1503) < 0.45) over(f, x + j, y + k, PR.rust[1], 0.6);
    }
  }
  stencil(f, cx - 10, bot - 16, 'H2', mix(PR.white[1], PR.drum[0], 0.35), 0.7);
  if (lit) {
    // glowing seams + a lit fuse
    for (let y = top + 2; y < bot; y++) {
      for (let x = cx - rx; x <= cx + rx; x++) {
        if (!(getpx(f, x, y) >>> 24)) continue;
        const n = fbm(0x9c3, x * 0.2, y * 0.14, 3, 8);
        if (n > 0.66) over(f, x, y, mix(rgba(255, 170, 50, 255), rgba(255, 240, 190, 255), (n - 0.66) * 3), 0.85);
      }
    }
    glow(f, cx, top + 30, 20, rgba(255, 120, 30, 255), { halo: 0.18, seed: 1504, base: rgba(40, 16, 8, 255), core: 0.95 });
    // fuse
    for (let i = 0; i < 9; i++) px(f, cx + 5 + Math.sin(i * 0.7) * 2, top - 2 - i, PR.dark[2]);
    glow(f, cx + 5 + Math.sin(6.3) * 2, top - 11, 5.5, rgba(255, 250, 210, 255), { halo: 1, seed: 1505, base: rgba(80, 40, 10, 255) });
    for (let i = 0; i < 6; i++) {
      const ang = i * 1.05;
      px(f, cx + 5 + Math.cos(ang) * (6 + i), top - 11 + Math.sin(ang) * (5 + i), rgba(255, 226, 150, 255));
    }
  }
  return finishProp(f);
}

function paintPillar() {
  const w = 40, h = 64;
  const f = makeFrame(w, h);
  const cx = 20;
  const rx = 11;
  for (let y = 6; y < h - 4; y++) {
    const n = fbm(0x1b7, cx * 0.1, y * 0.12, 3, 8);
    blob(f, cx, y, rx + (n > 0.6 ? 0.6 : 0), 1.2, PR.crete, { mode: 'cyl', nyBias: -0.04, grain: 0.11, seed: 1600 + y });
  }
  // steel cap and base
  box(f, cx - rx - 3, 2, (rx + 3) * 2, 6, PR.steel, { grain: 0.07, seed: 1601 });
  box(f, cx - rx - 3, h - 8, (rx + 3) * 2, 7, PR.steel, { grain: 0.07, seed: 1602 });
  for (let i = 0; i < 5; i++) {
    px(f, cx - rx + 1 + i * 5, 4, PR.steel[4]);
    px(f, cx - rx + 1 + i * 5, h - 6, PR.steel[4]);
  }
  // chips exposing aggregate
  const rng = makeRng(0x2b4c);
  for (let i = 0; i < 5; i++) {
    const x = cx - rx + rng() * rx * 2, y = 12 + rng() * 40, r = 2 + rng() * 3;
    for (let j = -r; j <= r; j++) for (let k = -r; k <= r; k++) {
      if (j * j + k * k > r * r) continue;
      over(f, x + j, y + k, PR.crete[0], 0.7);
    }
    over(f, x, y - r, PR.crete[4], 0.6);
  }
  speckle(f, cx - rx, 8, rx * 2, h - 14, PR.crete[0], 0.06, 1603, 0.5);
  speckle(f, cx - rx, 8, rx * 2, h - 14, PR.crete[4], 0.04, 1604, 0.4);
  // hazard chevrons near the base
  for (let y = h - 18; y < h - 10; y++) {
    for (let x = cx - rx; x <= cx + rx; x++) {
      if (!(getpx(f, x, y) >>> 24)) continue;
      const s = ((x + y) % 12 + 12) % 12;
      if (s < 6) over(f, x, y, PR.hazard[2], 0.75);
    }
  }
  return finishProp(f);
}

function paintLamp() {
  const w = 32, h = 24;
  const f = makeFrame(w, h);
  const cx = 16;
  const EW = { edge: rgba(22, 20, 18, 255), edgeW: 0.9 };
  // ceiling mount and stem
  box(f, cx - 6, 0, 12, 4, PR.steel, { grain: 0.06, seed: 1701 });
  capsule(f, cx, 3, cx, 8, 1.8, 1.8, PR.dark, { ...EW });
  // conical shade
  for (let y = 7; y < 13; y++) {
    const t = (y - 7) / 6;
    blob(f, cx, y, 4.5 + t * 5.5, 1.3, PR.steel, { mode: 'cyl', nyBias: -0.45, grain: 0.05, seed: 1702 + y });
  }
  fillRect(f, cx - 10, 12, 21, 1, PR.dark[1]);
  // bulb
  blob(f, cx, 16, 6.0, 5.0, flat(rgba(255, 186, 74, 255)));
  blob(f, cx, 15.4, 4.2, 3.6, flat(rgba(255, 232, 150, 255)));
  blob(f, cx, 15.0, 2.4, 2.0, flat(rgba(255, 255, 246, 255)));
  glow(f, cx, 15.4, 14, rgba(255, 206, 120, 255), { halo: 0.55, tint: 0.25, seed: 1703, base: rgba(52, 36, 16, 255), core: 0.45 });
  // cage: three verticals bowing out, two hoops
  for (let i = -1; i <= 1; i++) {
    for (let y = 12; y < 22; y++) {
      const t = (y - 12) / 10;
      const xx = cx + i * (4.2 + Math.sin(t * Math.PI) * 3.4);
      px(f, xx, y, PR.dark[2]);
      px(f, xx + 1, y, PR.dark[0]);
    }
  }
  for (const [yy, rr] of [[15, 7.4], [19, 6.2]]) {
    for (let x = -rr; x <= rr; x++) {
      px(f, cx + x, yy + Math.abs(x) * 0.14, PR.dark[2]);
    }
  }
  blob(f, cx, 21.6, 2.4, 1.4, PR.dark, { shift: 1 });
  return finishProp(f, rgba(26, 22, 20, 255));
}

function paintFlare(F) {
  const w = 24, h = 36;
  const f = makeFrame(w, h);
  const cx = 12;
  // wall bracket
  box(f, cx - 2, 20, 5, 14, PR.steel, { grain: 0.06, seed: 1801 });
  box(f, cx - 5, 18, 11, 4, PR.steel, { grain: 0.05, seed: 1802 });
  capsule(f, cx, 20, cx, 14, 2.2, 2.0, PR.dark, {});
  // flame, flickering per frame
  const seedn = 1810 + F * 13;
  const lean = [0, 0.9, -0.7][F];
  const hgt = [13, 15, 11][F];
  for (let i = 0; i < 16; i++) {
    const t = i / 15;
    const fx = cx + lean * t * 2.4 + Math.sin(t * 5 + F * 1.7) * (1.6 + t * 2);
    const fy = 13 - t * hgt;
    const r = (5.2 - t * 3.4) * (1 + 0.2 * Math.sin(i * 2.3 + F));
    const c = mix(mix(rgba(255, 255, 235, 255), rgba(255, 170, 40, 255), t * 1.2),
      rgba(200, 50, 20, 255), Math.max(0, t * 1.6 - 0.6));
    glow(f, fx, fy, r, c, { halo: 1, seed: seedn + i, base: rgba(60, 22, 8, 255), core: 0.62 });
  }
  glow(f, cx, 10, 15, rgba(255, 150, 60, 255), { halo: 0.22, seed: seedn + 40, base: rgba(46, 18, 8, 255), core: 0.95 });
  // sparks
  for (let i = 0; i < 4; i++) {
    const a = (i * 1.7 + F) % 6.28;
    px(f, cx + Math.cos(a) * (5 + i * 2), 8 - i * 2.5, rgba(255, 236, 180, 255));
  }
  return finishProp(f, rgba(38, 16, 10, 255));
}

/** Weapon pickups: each one silhouette-readable at a glance. */
function paintWeapon(kind) {
  const w = 48, h = 28;
  const f = makeFrame(w, h);
  const cy = 15;
  if (kind === 'splitter') {
    // twin-barrel flak scattergun, drum magazine
    capsule(f, 12, cy - 3, 42, cy - 4, 3.2, 3.0, PR.steel, { grain: 0.06, seed: 1901 });
    capsule(f, 12, cy + 2, 42, cy + 1, 3.0, 2.8, PR.steel, { grain: 0.06, seed: 1902 });
    blob(f, 43, cy - 4, 3.6, 3.4, PR.dark, { shift: 1 });
    blob(f, 43, cy + 1, 3.4, 3.2, PR.dark, { shift: 1 });
    box(f, 10, cy - 6, 12, 13, PR.steel, { grain: 0.07, seed: 1903 });
    blob(f, 16, cy + 7, 6.5, 5.5, PR.copper, { grain: 0.06, seed: 1904 });
    blob(f, 16, cy + 7, 2.2, 2.0, PR.dark, { shift: 1 });
    capsule(f, 10, cy - 2, 3, cy + 6, 3.0, 2.6, PR.wood, { grain: 0.09, seed: 1905 });
    line(f, 26, cy - 7, 34, cy - 7, PR.dark[2]);
  } else if (kind === 'nailer') {
    // long thin rivet gun with a belt of spikes
    capsule(f, 8, cy - 1, 44, cy - 3, 2.2, 1.6, PR.steel, { grain: 0.06, seed: 1911 });
    box(f, 6, cy - 5, 16, 9, PR.steel, { grain: 0.07, seed: 1912 });
    box(f, 20, cy - 7, 8, 5, PR.dark, {});
    capsule(f, 8, cy + 3, 4, cy + 10, 2.6, 2.2, PR.dark, {});
    // spike belt
    for (let i = 0; i < 9; i++) {
      const bx = 12 + i * 3.4, by = cy + 6 + Math.sin(i * 0.7) * 2;
      capsule(f, bx, by, bx + 1, by + 3.5, 1.3, 0.7, PR.copper, {});
      px(f, bx, by - 1, PR.copper[4]);
    }
    blob(f, 44, cy - 3, 2.4, 2.4, PR.dark, { shift: 1 });
    px(f, 45, cy - 4, PR.steel[4]);
  } else if (kind === 'halo') {
    // ring emitter
    for (let a = 0; a < 6.283; a += 0.05) {
      const rx0 = 10, ry0 = 10;
      const x = 30 + Math.cos(a) * rx0, y = cy + Math.sin(a) * ry0;
      capsule(f, x, y, x, y, 2.4, 2.4, PR.steel, {});
    }
    for (let a = 0; a < 6.283; a += 0.09) {
      const x = 30 + Math.cos(a) * 10, y = cy + Math.sin(a) * 10;
      over(f, x, y, mix(rgba(120, 220, 255, 255), rgba(255, 255, 255, 255), 0.4), 0.75);
    }
    glow(f, 30, cy, 15, rgba(90, 200, 255, 255), { halo: 0.3, seed: 1921, base: rgba(14, 30, 44, 255), core: 0.9 });
    box(f, 6, cy - 5, 16, 10, PR.steel, { grain: 0.07, seed: 1922 });
    capsule(f, 20, cy, 26, cy, 3.0, 2.6, PR.steel, {});
    capsule(f, 8, cy + 4, 5, cy + 11, 2.6, 2.2, PR.dark, {});
    blob(f, 14, cy - 1, 2.4, 2.2, flat(rgba(150, 240, 255, 255)));
  } else if (kind === 'pipebomb') {
    // a canvas satchel with three capped pipes and the detonator clipped on top.
    // Ilsa's drop on the second floor had no sprite at all: the render pass
    // skipped the missing frame, so the only pipe-bomb unlock in the game was
    // invisible and found by walking into it.
    box(f, 9, cy - 4, 26, 14, PR.olive, { grain: 0.11, seed: 1941 });
    fillRect(f, 9, cy - 4, 26, 1, PR.olive[3]);
    // flap and buckles
    fillRect(f, 9, cy - 1, 26, 4, mix(PR.olive[1], PR.dark[2], 0.35));
    box(f, 14, cy, 3, 3, PR.brass, {});
    box(f, 27, cy, 3, 3, PR.brass, {});
    capsule(f, 11, cy - 5, 33, cy - 5, 1.4, 1.2, PR.wood, { grain: 0.08, seed: 1942 });
    // three pipes standing out of the mouth of the bag
    for (let i = 0; i < 3; i++) {
      const bx = 15 + i * 6, top = cy - 12 + (i === 1 ? -2 : 0);
      capsule(f, bx, top, bx, cy - 5, 2.6, 2.4, PR.steel, { grain: 0.07, seed: 1950 + i });
      blob(f, bx, top, 3.0, 1.8, PR.dark, { shift: 1 });
      fillRect(f, bx - 2, top + 3, 5, 1, PR.copper[3]);
      // the fuse
      for (let k = 0; k < 5; k++) px(f, bx + Math.round(Math.sin(k * 1.1) * 2), top - 2 - k, PR.rust[2]);
    }
    // detonator: a plunger box with a live red lamp
    box(f, 33, cy - 3, 10, 9, PR.dark, { grain: 0.06, seed: 1943 });
    fillRect(f, 34, cy - 2, 8, 1, PR.steel[2]);
    blob(f, 38, cy - 5, 2.6, 1.8, PR.red, { shift: 1 });
    glow(f, 38, cy - 5, 5, rgba(255, 70, 60, 255), { halo: 0.28, seed: 1944, base: rgba(30, 8, 8, 255) });
    stencil(f, 12, cy + 6, 'HE', mix(PR.hazard[3], PR.olive[0], 0.15), 0.9);
  } else {
    // deadman: boxy launcher with a big red plunger and a chain
    box(f, 8, cy - 7, 26, 15, PR.steel, { grain: 0.08, seed: 1931 });
    box(f, 10, cy - 5, 8, 5, PR.dark, {});
    fillRect(f, 11, cy - 4, 6, 1, rgba(255, 190, 60, 255));
    fillRect(f, 11, cy - 2, 4, 1, rgba(90, 230, 130, 255));
    capsule(f, 34, cy - 2, 44, cy - 2, 4.0, 3.4, PR.dark, { grain: 0.05, seed: 1932 });
    blob(f, 44, cy - 2, 3.6, 3.4, PR.steel, { shift: -1 });
    // plunger
    capsule(f, 20, cy - 7, 20, cy - 12, 2.0, 2.0, PR.steel, {});
    blob(f, 20, cy - 13, 5.2, 3.0, PR.red, { shift: 1 });
    glow(f, 20, cy - 13, 7, rgba(255, 70, 60, 255), { halo: 0.3, seed: 1933, base: rgba(40, 10, 10, 255) });
    capsule(f, 8, cy + 5, 4, cy + 11, 2.6, 2.2, PR.wood, {});
    // chain
    for (let i = 0; i < 9; i++) px(f, 26 + i * 1.6, cy + 8 + Math.sin(i * 0.9) * 2.2, PR.steel[i % 2 ? 2 : 3]);
    stencil(f, 11, cy + 2, 'DM', mix(PR.hazard[3], PR.steel[0], 0.2), 0.9);
  }
  return finishProp(f);
}

// ---------------------------------------------------------------------------
// set dressing: the furniture of a bunker that was an office until it was not
// ---------------------------------------------------------------------------

const DR = {
  metal: mat(rgba(118, 124, 130, 255), { contrast: 1.15 }),
  desk: mat(rgba(150, 142, 118, 255), { contrast: 1.1 }),
  lam: mat(rgba(170, 132, 88, 255), { contrast: 1.05 }),
  fabric: mat(rgba(52, 70, 120, 255), { contrast: 1.1 }),
  olive: mat(rgba(92, 100, 78, 255), { contrast: 1.1 }),
  locker: mat(rgba(78, 98, 110, 255), { contrast: 1.15 }),
  cola: mat(rgba(196, 34, 36, 255), { contrast: 1.2 }),
  porcelain: mat(rgba(226, 226, 220, 255), { contrast: 1.1 }),
  bone: mat(rgba(214, 204, 176, 255), { contrast: 1.15 }),
  burlap: mat(rgba(150, 132, 92, 255), { contrast: 1.05 }),
  pine: mat(rgba(172, 128, 72, 255), { contrast: 1.05 }),
  console: mat(rgba(96, 104, 92, 255), { contrast: 1.15 }),
  terra: mat(rgba(164, 88, 54, 255), { contrast: 1.1 }),
  dead: mat(rgba(122, 104, 58, 255), { contrast: 1.1 }),
  yellow: mat(rgba(232, 196, 42, 255), { contrast: 1.2 }),
  chain: mat(rgba(104, 100, 96, 255), { contrast: 1.35 }),
  meat: mat(rgba(170, 70, 64, 255), { contrast: 1.2 }),
  fat: mat(rgba(226, 200, 170, 255), { contrast: 1.05 }),
  coat: mat(rgba(214, 214, 206, 255), { contrast: 1.05 }),
  skin: mat(rgba(200, 150, 118, 255), { contrast: 1.05 }),
  cone: mat(rgba(226, 226, 222, 255), { contrast: 1.15 }),
  pewwood: mat(rgba(112, 70, 40, 255), { contrast: 1.1 }),
  wax: mat(rgba(232, 222, 190, 255), { contrast: 1.0 }),
  bottle: mat(rgba(96, 156, 214, 255), { contrast: 1.2 }),
  cab: mat(rgba(40, 44, 70, 255), { contrast: 1.2 }),
  bin: mat(rgba(100, 108, 104, 255), { contrast: 1.2 }),
  blood: mat(rgba(130, 16, 20, 255), { contrast: 1.0 }),
};
const GLOW_GREEN = rgba(120, 255, 150, 255), CRT_DARK = rgba(8, 26, 14, 255);

/**
 * A block in oblique projection: front face, a lit top receding up and to the
 * right, a shaded right side. The whole set is drawn this way so furniture
 * reads as having depth even though it is a billboard.
 */
function slab(f, x, y, w, h, d, R, o = {}) {
  const dx = Math.round(d * 0.7), dy = Math.round(d * 0.5);
  fillPoly(f, [{ x, y }, { x: x + w, y }, { x: x + w + dx, y: y - dy }, { x: x + dx, y: y - dy }], R[o.topBand === undefined ? 4 : o.topBand]);
  fillPoly(f, [{ x: x + w, y }, { x: x + w + dx, y: y - dy }, { x: x + w + dx, y: y - dy + h }, { x: x + w, y: y + h }], R[1]);
  box(f, x, y, w, h, R, { grain: o.grain || 0.05, seed: o.seed || 17, shift: o.shift || 0 });
  if (o.edge !== false) {
    line(f, x, y, x + w, y, R[4]);
    line(f, x + w, y, x + w + dx, y - dy, R[3]);
  }
}

/** A flat screen face with a phosphor glow; lit from inside so it reads in the dark. */
function screenFace(f, x, y, w, h, col, seed) {
  fillRect(f, x, y, w, h, CRT_DARK);
  for (let j = 1; j < h - 1; j += 2) {
    for (let i = 1; i < w - 1; i++) {
      if (hash2(x + i, y + j, seed) < 0.55) px(f, x + i, y + j, mix(CRT_DARK, col, 0.6));
    }
  }
  px(f, x + 1, y + 1, mix(col, WARM, 0.5));
}

function paintDesk() {
  const f = makeFrame(60, 40);
  const top = 17, fy = 20;
  slab(f, 4, fy, 46, 3, 8, DR.lam, { seed: 3101 });                  // laminate top
  box(f, 6, fy + 3, 16, 17, DR.desk, { grain: 0.05, seed: 3102 });   // drawer pedestal
  for (let k = 0; k < 3; k++) {
    const yy = fy + 4 + k * 5;
    fillRect(f, 7, yy + 4, 14, 1, DR.desk[0]);
    fillRect(f, 11, yy + 1, 6, 1, DR.metal[4]);
  }
  box(f, 22, fy + 3, 25, 11, DR.desk, { shift: -1, seed: 3103 });   // modesty panel
  box(f, 45, fy + 3, 3, 17, DR.desk, { seed: 3104 });                // far leg
  fillRect(f, 22, fy + 14, 23, 6, 0);
  // a CRT with the day's work still on it
  slab(f, 25, top - 12, 15, 11, 7, DR.desk, { seed: 3105 });
  screenFace(f, 27, top - 10, 11, 7, GLOW_GREEN, 3106);
  fillRect(f, 30, top - 1, 5, 2, DR.desk[1]);
  // coffee, going cold since 1994, and the paperwork
  box(f, 11, top - 1, 4, 4, DR.porcelain, { seed: 3107 });
  px(f, 15, top, DR.porcelain[1]); px(f, 15, top + 1, DR.porcelain[1]);
  fillRect(f, 11, top - 1, 4, 1, rgba(70, 40, 20, 255));
  for (let k = 0; k < 4; k++) fillRect(f, 43 - k, top + 1 - k, 8, 1, DR.coat[k % 2 ? 3 : 4]);
  stencil(f, 8, fy + 6, 'IN', DR.desk[0], 0.7);
  return finishProp(f);
}

function paintChair() {
  const f = makeFrame(30, 38);
  const cx = 15;
  // backrest, seat
  box(f, cx - 8, 4, 16, 14, DR.fabric, { grain: 0.08, seed: 3201 });
  for (let k = 0; k < 3; k++) fillRect(f, cx - 7, 7 + k * 4, 14, 1, DR.fabric[1]);
  capsule(f, cx, 18, cx, 21, 1.5, 1.5, DR.metal, {});
  slab(f, cx - 9, 21, 18, 3, 6, DR.fabric, { seed: 3202 });
  capsule(f, cx - 10, 16, cx - 10, 22, 1, 1, DR.metal, {});           // armrests
  capsule(f, cx + 10, 16, cx + 10, 22, 1, 1, DR.metal, {});
  fillRect(f, cx - 11, 15, 4, 2, DR.metal[2]); fillRect(f, cx + 8, 15, 4, 2, DR.metal[2]);
  capsule(f, cx, 24, cx, 31, 1.4, 1.4, DR.metal, {});                // gas lift
  for (const [ex, ey] of [[-10, 35], [10, 35], [-5, 36], [5, 36], [0, 34]]) {
    line(f, cx, 31, cx + ex, ey, DR.metal[1]);
    blob(f, cx + ex, ey, 1.6, 1.3, PR.dark, {});
  }
  return finishProp(f);
}

function paintFiling() {
  const f = makeFrame(30, 46);
  slab(f, 3, 7, 20, 38, 7, DR.metal, { seed: 3301 });
  for (let k = 0; k < 4; k++) {
    const y = 8 + k * 9;
    fillRect(f, 4, y + 8, 18, 1, DR.metal[0]);
    box(f, 9, y + 3, 8, 2, DR.metal, { shift: 1 });
    fillRect(f, 11, y + 1, 4, 1, DR.coat[3]);                         // label holder
  }
  // the second drawer hangs open, stuffed with somebody's secrets
  box(f, 2, 17, 22, 8, DR.metal, { shift: -1, seed: 3302 });
  for (let k = 0; k < 7; k++) fillRect(f, 4 + k * 3, 14 + (k % 3), 2, 4, k % 2 ? rgba(214, 190, 120, 255) : DR.coat[3]);
  fillRect(f, 3, 17, 20, 1, DR.metal[4]);
  over(f, 16, 30, PR.dark[0], 0.6); over(f, 17, 31, PR.dark[0], 0.6); over(f, 16, 31, DR.metal[4], 0.5);  // kicked in
  stencil(f, 5, 38, 'TOP SECRET'.slice(0, 3), PR.red[2], 0.8);
  return finishProp(f);
}

function paintLocker() {
  const f = makeFrame(26, 64);
  slab(f, 2, 5, 18, 58, 6, DR.locker, { seed: 3401 });
  line(f, 11, 6, 11, 62, DR.locker[0]);
  for (const x0 of [3, 12]) {
    for (let v = 0; v < 4; v++) fillRect(f, x0 + 2, 9 + v * 2, 5, 1, PR.dark[0]);
    for (let v = 0; v < 4; v++) fillRect(f, x0 + 2, 52 + v * 2, 5, 1, PR.dark[0]);
    fillRect(f, x0 + 6, 28, 1, 6, DR.metal[4]);
  }
  box(f, 4, 19, 6, 4, PR.brass, {}); stencil(f, 5, 19, '7', PR.dark[0], 0.8);
  box(f, 13, 19, 6, 4, PR.brass, {}); stencil(f, 14, 19, '8', PR.dark[0], 0.8);
  // a bumper sticker, because someone had to
  fillRect(f, 13, 38, 7, 4, PR.hazard[3]); stencil(f, 13, 38, 'NUK', PR.dark[0], 0.9);
  over(f, 6, 40, PR.dark[0], 0.6); over(f, 7, 41, PR.dark[0], 0.6); over(f, 6, 41, DR.locker[4], 0.5);
  speckle(f, 2, 5, 18, 58, PR.rust[1], 0.04, 3402, 0.7);
  return finishProp(f);
}

function paintVending() {
  const f = makeFrame(44, 64);
  slab(f, 2, 5, 34, 58, 8, DR.cola, { seed: 3501 });
  // the glass: rows of cans, lit from inside
  fillRect(f, 5, 9, 20, 40, rgba(30, 24, 28, 255));
  const cans = [PR.red, PR.hazard, DR.bottle, PR.white, PR.olive];
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 4; c++) {
      const R = cans[(r * 2 + c) % cans.length];
      box(f, 6 + c * 5, 11 + r * 8, 3, 5, R, {});
      if ((r + c) % 3 === 0) fillRect(f, 6 + c * 5, 16 + r * 8, 3, 1, PR.dark[1]);
    }
    fillRect(f, 5, 17 + r * 8, 20, 1, DR.metal[1]);
  }
  for (let y = 9; y < 49; y++) over(f, 5 + ((y * 7) % 3), y, WARM, 0.25);            // glass sheen
  // selection panel and slot
  box(f, 27, 12, 7, 18, DR.metal, { seed: 3502 });
  for (let k = 0; k < 6; k++) px(f, 29 + (k % 2) * 3, 14 + ((k / 2) | 0) * 4, PR.dark[0]);
  fillRect(f, 28, 33, 5, 2, PR.dark[0]);
  fillRect(f, 7, 52, 18, 6, PR.dark[0]);                             // the dispenser flap
  fillRect(f, 7, 52, 18, 1, DR.metal[3]);
  // the logo, the one thing still working
  stencil(f, 27, 38, 'MEGA', PR.white[4], 1);
  stencil(f, 27, 44, 'COLA', PR.white[4], 1);
  glow(f, 15, 30, 12, rgba(255, 236, 200, 255), { halo: 0, tint: 0.2, seed: 3503 });
  return finishProp(f);
}

function paintCooler() {
  const f = makeFrame(24, 46);
  const cx = 11;
  // the bottle, upside down, one glug of water left
  for (let y = 2; y < 17; y++) {
    const r = y < 5 ? 3 + y : 8;
    blob(f, cx, y, r, 1.2, DR.bottle, { mode: 'cyl', nyBias: -0.1 });
  }
  for (let y = 12; y < 17; y++) for (let x = cx - 7; x <= cx + 7; x++) if (getpx(f, x, y) >>> 24) over(f, x, y, rgba(120, 200, 255, 255), 0.4);
  fillRect(f, cx - 7, 8, 14, 1, DR.bottle[4]);
  slab(f, cx - 8, 18, 16, 27, 5, DR.porcelain, { seed: 3601 });
  box(f, cx - 4, 22, 3, 2, PR.red, {}); box(f, cx + 1, 22, 3, 2, DR.bottle, {});
  fillRect(f, cx - 5, 27, 10, 3, PR.dark[1]);
  box(f, cx + 8, 26, 3, 7, DR.coat, {});                              // paper cups
  return finishProp(f);
}

function paintToilet() {
  // Three-quarter view: cistern against the wall, bowl coming toward us.
  const f = makeFrame(30, 34);
  const cx = 14;
  slab(f, cx - 8, 5, 16, 11, 5, DR.porcelain, { seed: 3701 });        // cistern
  box(f, cx - 9, 3, 18, 3, DR.porcelain, { shift: 1 });                // its lid
  fillRect(f, cx + 5, 8, 3, 1, DR.metal[4]); px(f, cx + 5, 9, DR.metal[2]);   // flush lever
  box(f, cx - 4, 15, 8, 4, DR.porcelain, { shift: -1 });               // neck down to the bowl
  capsule(f, cx - 8, 17, cx + 8, 17, 1.4, 1.4, PR.dark, {});           // seat, flipped up, as left by men
  blob(f, cx, 24, 9, 4.5, DR.porcelain, {});                           // bowl
  blob(f, cx, 22.4, 7.4, 2.8, DR.porcelain, { shift: 1 });             // rim
  blob(f, cx, 23, 5.4, 1.7, flat(rgba(118, 124, 92, 255)), {});        // the water, which is not blue
  box(f, cx - 4, 27, 8, 6, DR.porcelain, { seed: 3702 });              // pedestal
  blob(f, cx, 33, 6, 1.2, DR.porcelain, { shift: -1 });
  over(f, cx - 3, 29, rgba(150, 120, 50, 255), 0.6); over(f, cx + 2, 30, rgba(150, 120, 50, 255), 0.5);
  over(f, cx + 1, 21, WARM, 0.6);
  return finishProp(f);
}

function paintUrinal() {
  const f = makeFrame(22, 32);
  const cx = 10;
  capsule(f, cx, 1, cx, 6, 1, 1, DR.metal, {});                       // flush pipe
  box(f, cx - 3, 5, 6, 2, DR.metal, {});
  for (let y = 7; y < 29; y++) {
    const t = (y - 7) / 22;
    const r = 7 - Math.max(0, t - 0.6) * 10;
    blob(f, cx, y, Math.max(2, r), 1.1, DR.porcelain, { mode: 'cyl', nyBias: -0.2 });
  }
  blob(f, cx, 18, 4.6, 5.5, flat(rgba(160, 160, 152, 255)), {});      // the scoop
  blob(f, cx, 23, 2.6, 1.4, flat(rgba(250, 130, 180, 255)), {});      // the cake. pink. always pink.
  over(f, cx - 1, 22, WARM, 0.5);
  return finishProp(f);
}

function paintSkeleton() {
  const f = makeFrame(34, 30);
  const B = DR.bone;
  // slumped against the wall: legs splayed toward us, skull lolling
  capsule(f, 13, 22, 4, 27, 1.2, 1, B, {});
  capsule(f, 4, 27, 1, 28, 1, 1, B, {});
  capsule(f, 19, 22, 29, 26, 1.2, 1, B, {});
  capsule(f, 29, 26, 32, 28, 1, 1, B, {});
  blob(f, 16, 21, 5, 2.5, B, {});                                     // pelvis
  capsule(f, 16, 20, 16, 11, 1, 1, B, {});                            // spine
  for (let k = 0; k < 4; k++) {                                       // ribs
    const y = 11 + k * 2.2;
    line(f, 16, y, 11 + k * 0.5, y + 2, B[3]);
    line(f, 16, y, 21 - k * 0.5, y + 2, B[3]);
  }
  capsule(f, 12, 11, 9, 19, 1, 1, B, {}); capsule(f, 9, 19, 12, 24, 0.9, 0.9, B, {});
  capsule(f, 20, 11, 24, 18, 1, 1, B, {}); capsule(f, 24, 18, 22, 23, 0.9, 0.9, B, {});
  blob(f, 18, 6, 4.2, 4.2, B, {});                                    // skull, tipped to one side
  blob(f, 19, 9.5, 2.6, 1.5, B, { shift: -1 });
  px(f, 16, 6, INK); px(f, 17, 6, INK); px(f, 20, 6, INK); px(f, 21, 6, INK);
  px(f, 18, 8, INK);
  // still wearing the hard hat: health and safety to the last
  blob(f, 17, 3, 5, 2.4, PR.hazard, { shift: 1 });
  fillRect(f, 11, 4, 13, 1, PR.hazard[1]);
  return finishProp(f);
}

function paintSandbags() {
  const f = makeFrame(44, 28);
  const bag = (x, y, w) => {
    blob(f, x + w / 2, y, w / 2, 3.6, DR.burlap, { grain: 0.12, seed: 3801 + x + y });
    line(f, x + 2, y - 1, x + 3, y + 1, DR.burlap[0]);
    line(f, x + w - 2, y - 1, x + w - 3, y + 1, DR.burlap[0]);
  };
  for (let k = 0; k < 4; k++) bag(2 + k * 10, 23, 10);
  for (let k = 0; k < 3; k++) bag(7 + k * 10, 17, 10);
  for (let k = 0; k < 2; k++) bag(12 + k * 10, 11, 10);
  speckle(f, 0, 6, 44, 22, DR.burlap[0], 0.05, 3802, 0.6);
  stencil(f, 16, 21, 'SAND', DR.burlap[0], 0.7);
  return finishProp(f);
}

function crateAt(f, x, y, s, seed, words) {
  slab(f, x, y, s, s, Math.round(s * 0.45), DR.pine, { grain: 0.12, seed });
  const t = Math.max(2, Math.round(s / 9));
  fillRect(f, x, y, t, s, DR.pine[1]); fillRect(f, x + s - t, y, t, s, DR.pine[1]);
  fillRect(f, x, y, s, t, DR.pine[3]); fillRect(f, x, y + s - t, s, t, DR.pine[1]);
  line(f, x + t, y + t, x + s - t, y + s - t, DR.pine[1]);          // the diagonal brace
  line(f, x + t, y + t + 1, x + s - t - 1, y + s - t, DR.pine[3]);
  let yy = y + Math.round(s * 0.3);
  for (const wd of words || []) { stencil(f, x + 3, yy, wd, mix(PR.dark[1], DR.pine[1], 0.2), 0.85); yy += 6; }
}
function paintCrate() {
  const f = makeFrame(40, 36);
  crateAt(f, 3, 9, 26, 3901, ['SIEBEN', 'UP']);
  return finishProp(f);
}
function paintCrates() {
  const f = makeFrame(44, 62);
  crateAt(f, 2, 32, 28, 3902, ['FRAG', 'ILE']);
  crateAt(f, 6, 9, 20, 3903, ['MRE']);
  return finishProp(f);
}

function paintConsole() {
  const f = makeFrame(44, 46);
  box(f, 3, 22, 34, 23, DR.console, { grain: 0.05, seed: 4001 });
  // sloped desk
  fillPoly(f, [{ x: 3, y: 22 }, { x: 37, y: 22 }, { x: 41, y: 14 }, { x: 7, y: 14 }], DR.console[3]);
  line(f, 3, 22, 37, 22, DR.console[4]);
  // riser with a screen
  slab(f, 9, 1, 26, 13, 5, DR.console, { seed: 4002 });
  screenFace(f, 12, 3, 20, 9, GLOW_GREEN, 4003);
  stencil(f, 13, 6, 'ARMED', GLOW_GREEN, 0.9);
  // buttons, one of them BIG
  const cols = [PR.red, PR.hazard, DR.bottle, PR.olive];
  for (let k = 0; k < 6; k++) box(f, 9 + k * 4, 17, 2, 2, cols[k % 4], {});
  blob(f, 33, 17, 3, 2, PR.red, { shift: 1 });
  capsule(f, 20, 30, 24, 25, 1, 1, DR.metal, {});                      // a lever, thrown
  blob(f, 24, 24.5, 1.8, 1.8, PR.red, {});
  for (let k = 0; k < 3; k++) fillRect(f, 6, 27 + k * 5, 10, 1, DR.console[1]);
  return finishProp(f);
}

function paintPlant() {
  const f = makeFrame(28, 44);
  const cx = 13;
  // the pot
  for (let y = 30; y < 43; y++) blob(f, cx, y, 6 - (y - 30) * 0.18, 1, DR.terra, { mode: 'cyl', nyBias: -0.1 });
  blob(f, cx, 30, 7, 1.8, DR.terra, { shift: 1 });
  blob(f, cx, 30, 5.6, 1.1, flat(rgba(60, 44, 30, 255)), {});
  // what used to be a ficus, now mostly an argument for going outside
  capsule(f, cx, 30, cx - 1, 12, 1, 0.7, DR.dead, {});
  const leaves = [[-6, 10, 0.6], [5, 7, 0.4], [-8, 18, 1.4], [7, 15, 1.2], [-3, 4, 0.2], [8, 24, 1.8], [-9, 26, 2.2]];
  for (const [lx, ly, droop] of leaves) {
    line(f, cx, ly + 4, cx + lx * 0.6, ly + 2, DR.dead[1]);
    blob(f, cx + lx, ly + droop * 2, 2.6, 1.3, DR.dead, { shift: -1 });
  }
  for (const [lx, ly] of [[-4, 41], [6, 42], [2, 42]]) blob(f, cx + lx, ly, 1.8, 0.8, DR.dead, { shift: -1 });
  return finishProp(f);
}

function paintMop() {
  const f = makeFrame(30, 40);
  // yellow mop bucket with the wringer
  slab(f, 3, 26, 18, 12, 5, DR.yellow, { seed: 4201 });
  box(f, 5, 23, 12, 4, DR.metal, {});
  for (const x of [5, 18]) blob(f, x, 38, 1.6, 1.4, PR.dark, {});
  fillRect(f, 5, 28, 14, 2, rgba(110, 120, 100, 255));                // grey water
  // the mop, leaning
  capsule(f, 12, 26, 24, 1, 0.9, 0.9, DR.pine, {});
  for (let k = 0; k < 7; k++) capsule(f, 11, 25, 7 + k * 1.6, 30 + (k % 3), 0.6, 0.6, DR.coat, {});
  stencil(f, 6, 31, 'WET', PR.dark[1], 0.8);
  return finishProp(f);
}

function paintCone() {
  // A-frame CAUTION WET FLOOR sign: in a nuclear bunker, the least of anyone's worries
  const f = makeFrame(22, 30);
  fillPoly(f, [{ x: 4, y: 29 }, { x: 8, y: 1 }, { x: 14, y: 1 }, { x: 18, y: 29 }], DR.yellow[2]);
  fillPoly(f, [{ x: 16, y: 29 }, { x: 14, y: 1 }, { x: 15, y: 1 }, { x: 19, y: 29 }], DR.yellow[0]);
  line(f, 8, 1, 14, 1, DR.yellow[4]);
  fillRect(f, 7, 4, 8, 3, PR.dark[1]);
  stencil(f, 7, 5, 'WET', DR.yellow[4], 1);
  // the little man, mid-slip
  blob(f, 11, 12, 1.4, 1.4, PR.dark, {});
  line(f, 11, 13, 10, 18, PR.dark[1]);
  line(f, 10, 18, 14, 21, PR.dark[1]);
  line(f, 10, 18, 7, 22, PR.dark[1]);
  line(f, 11, 15, 14, 12, PR.dark[1]);
  line(f, 11, 15, 8, 14, PR.dark[1]);
  fillRect(f, 6, 24, 10, 1, PR.dark[1]);
  return finishProp(f);
}

function paintChains() {
  const f = makeFrame(22, 44);
  const link = (x, y, side) => {
    if (side) { fillRect(f, x - 1, y - 2, 2, 5, DR.chain[2]); px(f, x - 1, y - 2, DR.chain[4]); }
    else { blob(f, x, y, 1.8, 2.6, DR.chain, {}); px(f, x, y, INK); }
  };
  for (let k = 0; k < 11; k++) link(6 + Math.sin(k * 0.4) * 0.6, 2 + k * 3.6, k % 2);
  for (let k = 0; k < 8; k++) link(15 + Math.sin(k * 0.5) * 0.8, 2 + k * 3.6, k % 2);
  // a hook on the long one, with a scrap of somebody's overalls
  capsule(f, 6, 41, 6, 43, 1, 1, DR.chain, {});
  capsule(f, 6, 43, 9, 40, 0.9, 0.9, DR.chain, {});
  fillRect(f, 7, 38, 4, 3, rgba(200, 110, 40, 255));
  return finishProp(f);
}

function paintHook() {
  const f = makeFrame(26, 48);
  const cx = 12;
  for (let k = 0; k < 4; k++) blob(f, cx, 2 + k * 3.4, 1.5, 2, DR.chain, {});
  capsule(f, cx, 14, cx, 17, 1, 1, DR.chain, {});
  capsule(f, cx, 17, cx + 3, 15, 0.9, 0.9, DR.chain, {});
  // a side of something, hung by the hock: a narrow shank, then the ribcage
  capsule(f, cx, 17, cx - 1, 25, 1.8, 2.6, DR.meat, { grain: 0.1, seed: 4401 });
  blob(f, cx - 1, 16.5, 2, 1.6, DR.bone, {});                           // the knuckle on the hook
  const body = [{ x: cx - 4, y: 24 }, { x: cx + 3, y: 24 }, { x: cx + 9, y: 32 }, { x: cx + 8, y: 42 },
    { x: cx + 2, y: 47 }, { x: cx - 6, y: 45 }, { x: cx - 8, y: 36 }];
  fillPoly(f, body, DR.meat[2]);
  for (let y = 24; y < 47; y++) {                                       // shade it round
    for (let x = cx - 9; x <= cx + 10; x++) {
      if (!(getpx(f, x, y) >>> 24)) continue;
      const u = (x - cx) / 9;
      over(f, x, y, u > 0.3 ? DR.meat[1] : u < -0.4 ? DR.meat[3] : DR.meat[2], 0.8);
    }
  }
  fillPoly(f, [{ x: cx + 6, y: 29 }, { x: cx + 9, y: 32 }, { x: cx + 8, y: 42 }, { x: cx + 5, y: 44 }], DR.fat[2]);
  for (let k = 0; k < 6; k++) {                                         // the ribs, exposed
    const y = 29 + k * 2.6;
    line(f, cx - 5 + k * 0.3, y, cx + 5, y + 1.5, DR.bone[3]);
    line(f, cx - 5 + k * 0.3, y + 1, cx + 5, y + 2.5, DR.meat[0]);
  }
  for (let k = 0; k < 3; k++) px(f, cx - 1 + k * 2, 47 + (k % 2), DR.blood[2]);
  fillRect(f, cx - 6, 36, 7, 5, rgba(226, 226, 216, 255));               // the sticker
  stencil(f, cx - 6, 36, '???', PR.red[1], 1);
  return finishProp(f);
}

function paintBody(dead) {
  // A member of staff, lying down on the job. Head to the left, feet to the right.
  const f = makeFrame(52, 20);
  const Rb = dead === 'guard' ? DR.olive : DR.coat;
  for (let k = 0; k < 30; k++) {                                       // the pool first
    const x = 10 + hash2(k, 1, 4501) * 30, y = 15 + hash2(k, 2, 4501) * 4;
    blob(f, x, y, 2 + hash2(k, 3, 4501) * 4, 1.3, DR.blood, {});
  }
  capsule(f, 13, 11, 31, 12, 5, 4.4, Rb, { grain: 0.06, seed: 4502 }); // torso
  capsule(f, 31, 12, 46, 9, 2.6, 2.2, dead === 'guard' ? DR.olive : PR.dark, {});   // legs
  capsule(f, 31, 13, 45, 15, 2.6, 2.2, dead === 'guard' ? DR.olive : PR.dark, {});
  blob(f, 48, 9, 2.4, 1.6, PR.dark, {}); blob(f, 47, 15.5, 2.4, 1.6, PR.dark, {});
  capsule(f, 16, 8, 24, 3, 1.6, 1.4, Rb, {});                           // an arm flung out
  blob(f, 25, 2.5, 1.6, 1.4, DR.skin, {});
  if (dead === 'guard') {
    blob(f, 7, 12, 4.4, 3.6, DR.olive, { shift: 1 });                  // face down, helmet on
    fillRect(f, 3, 14, 9, 1, DR.olive[0]);
  } else {
    blob(f, 7, 11, 3.8, 3.6, DR.skin, {});                            // face up, glasses askew
    fillRect(f, 5, 10, 5, 1, INK);
    px(f, 6, 13, DR.blood[2]);
    fillRect(f, 16, 14, 6, 4, rgba(150, 110, 60, 255));               // the clipboard
    fillRect(f, 17, 15, 4, 2, DR.coat[4]);
    over(f, 20, 10, DR.blood[2], 0.9); over(f, 21, 11, DR.blood[1], 0.9); over(f, 22, 10, DR.blood[2], 0.9);
  }
  return finishProp(f);
}

function paintNosecone() {
  const f = makeFrame(32, 64);
  const cx = 15;
  // cradle
  box(f, 3, 55, 26, 8, PR.hazard, { seed: 4601 });
  for (let x = 3; x < 29; x += 6) fillRect(f, x, 55, 3, 8, PR.dark[1]);
  // the cone, standing on its base like someone forgot where it goes
  for (let y = 2; y < 56; y++) {
    const t = (y - 2) / 53;
    const r = 1.5 + Math.pow(t, 0.62) * 11;
    blob(f, cx, y, r, 1.2, PR.white, { mode: 'cyl', nyBias: -0.25, grain: 0.03, seed: 4602 + y });
  }
  for (let y = 2; y < 10; y++) for (let x = cx - 5; x <= cx + 5; x++) if (getpx(f, x, y) >>> 24) over(f, x, y, PR.red[2], 0.9);
  for (let x = cx - 12; x <= cx + 12; x++) for (let y = 38; y < 42; y++) if (getpx(f, x, y) >>> 24) over(f, x, y, PR.dark[1], 0.9);
  stencil(f, cx - 3, 26, '07', PR.dark[1], 0.9);
  stencil(f, cx - 3, 44, 'NO', PR.dark[1], 0.8);
  stencil(f, cx - 7, 50, 'STEP', PR.dark[1], 0.8);
  for (let k = 0; k < 5; k++) px(f, cx - 8 + k * 4, 36, PR.dark[0]);
  return finishProp(f);
}

function paintPinball() {
  const f = makeFrame(46, 52);
  // backbox: an explosion and a woman in a bikini riding a bomb. It was 1987.
  box(f, 7, 1, 30, 20, DR.cab, { seed: 4701 });
  fillRect(f, 9, 3, 26, 13, rgba(40, 20, 60, 255));
  blob(f, 22, 12, 9, 6, flat(rgba(255, 150, 40, 255)), {});
  blob(f, 22, 11, 6, 4, flat(rgba(255, 230, 120, 255)), {});
  capsule(f, 14, 8, 28, 10, 2.2, 2, PR.steel, {});                      // the bomb
  blob(f, 19, 6.4, 1.3, 1.3, flat(rgba(40, 18, 40, 255)), {});          // her, silhouetted
  capsule(f, 19, 7, 21, 9, 1, 1, flat(rgba(40, 18, 40, 255)), {});
  capsule(f, 21, 9, 24, 11, 0.8, 0.8, flat(rgba(40, 18, 40, 255)), {});
  stencil(f, 10, 16, 'NUKE EM', PR.hazard[4], 1);
  glow(f, 22, 10, 12, rgba(255, 200, 120, 255), { halo: 0, tint: 0.15, seed: 4702 });
  // cabinet and playfield glass
  fillPoly(f, [{ x: 5, y: 34 }, { x: 37, y: 34 }, { x: 43, y: 22 }, { x: 11, y: 22 }], rgba(30, 40, 90, 255));
  for (let k = 0; k < 8; k++) px(f, 14 + k * 3.4, 25 + (k % 3) * 2.5, [PR.red[4], PR.hazard[4], GLOW_GREEN][k % 3]);
  line(f, 5, 34, 37, 34, DR.cab[4]);
  box(f, 5, 34, 32, 8, DR.cab, { seed: 4703 });
  stencil(f, 16, 36, 'TILT', PR.red[3], 1);
  for (const x of [6, 34]) fillRect(f, x, 42, 2, 9, DR.metal[2]);
  for (const x of [11, 39]) fillRect(f, x, 34, 2, 13, DR.metal[1]);
  return finishProp(f);
}

function paintCandles() {
  const f = makeFrame(28, 20);
  const set = [[5, 7], [9, 11], [13, 5], [17, 9], [21, 13], [11, 16], [19, 17]];
  blob(f, 13, 18, 12, 2, DR.wax, { shift: -1 });                        // the puddle of wax
  for (const [x, hgt] of set) {
    const top = 19 - hgt;
    box(f, x - 1, top, 3, hgt, DR.wax, {});
    px(f, x, top - 1, rgba(40, 30, 20, 255));
    blob(f, x, top - 3, 1.1, 2, flat(rgba(255, 196, 80, 255)), {});
    px(f, x, top - 3, rgba(255, 250, 220, 255));
    over(f, x + 1, top + 1, DR.wax[4], 0.8);
  }
  glow(f, 13, 8, 12, rgba(255, 170, 60, 255), { halo: 0.35, tint: 0.2, seed: 4801, base: rgba(40, 20, 8, 255), core: 0.5 });
  return finishProp(f);
}

function paintPew() {
  const f = makeFrame(60, 32);
  slab(f, 2, 17, 48, 4, 8, DR.pewwood, { seed: 4901 });                 // seat
  box(f, 5, 3, 44, 12, DR.pewwood, { grain: 0.1, seed: 4902 });         // back
  fillRect(f, 5, 3, 44, 1, DR.pewwood[4]);
  for (let k = 0; k < 3; k++) fillRect(f, 5, 6 + k * 3, 44, 1, DR.pewwood[1]);
  box(f, 2, 21, 3, 10, DR.pewwood, {}); box(f, 46, 21, 3, 10, DR.pewwood, {});
  // the end panel, carved with the sign of the thing they pray to
  box(f, 0, 4, 6, 27, DR.pewwood, { shift: 1, seed: 4903 });
  const cx = 3, cy = 12;
  for (let k = 0; k < 3; k++) {
    const a = -Math.PI / 2 + k * 2.094;
    px(f, cx + Math.cos(a) * 1.8, cy + Math.sin(a) * 1.8, DR.pewwood[0]);
    px(f, cx + Math.cos(a) * 2.2, cy + Math.sin(a) * 2.2, DR.pewwood[0]);
  }
  px(f, cx, cy, DR.pewwood[0]);
  fillRect(f, 20, 13, 9, 2, rgba(120, 30, 30, 255));                    // a hymn book
  return finishProp(f);
}

function paintTrash() {
  const f = makeFrame(24, 32);
  const cx = 11;
  for (let y = 9; y < 31; y++) blob(f, cx, y, 7 - (y - 9) * 0.05, 1, DR.bin, { mode: 'cyl', nyBias: -0.1 });
  for (const y of [12, 20, 28]) fillRect(f, cx - 7, y, 14, 1, DR.bin[1]);
  blob(f, cx, 9, 7.5, 2, DR.bin, { shift: 1 });
  // overflowing: memos, a pizza box, the banana peel of legend
  for (let k = 0; k < 6; k++) blob(f, cx - 5 + k * 2, 6 + (k % 3), 2.4, 1.6, DR.coat, { shift: k % 2 });
  slab(f, cx - 2, 3, 10, 2, 4, DR.pine, { seed: 5001 });
  capsule(f, cx - 7, 29, cx - 12, 30, 1, 0.6, DR.yellow, {});
  capsule(f, cx - 7, 29, cx - 10, 26, 0.8, 0.6, DR.yellow, {});
  px(f, cx + 5, 1, INK); px(f, cx + 2, 0, INK); px(f, cx + 8, 2, INK);  // flies
  return finishProp(f);
}


/**
 * Each floor's own column, so the same concrete post is not holding up every
 * ceiling in the bunker. Same 40x64 frame and footprint as the stock pillar.
 */
function paintPillarStyle(style) {
  const w = 40, h = 64;
  const f = makeFrame(w, h);
  const cx = 20;
  if (style === 'wood') {
    // THE ORGAN LOFT: a timber post, iron-banded, carved with the priests' sign
    for (let y = 4; y < h - 3; y++) blob(f, cx, y, 9, 1.2, DR.pewwood, { mode: 'cyl', nyBias: -0.04, grain: 0.14, seed: 5101 + y });
    for (let y = 6; y < h - 4; y += 3) for (let x = cx - 8; x <= cx + 8; x += 5) over(f, x + ((y * 3) % 4), y, DR.pewwood[0], 0.5);
    for (const y of [8, 30, 52]) box(f, cx - 10, y, 20, 4, PR.dark, { shift: 1 });
    for (const y of [8, 30, 52]) for (const x of [cx - 7, cx, cx + 7]) px(f, x, y + 1, PR.steel[4]);
    box(f, cx - 12, 1, 24, 5, DR.pewwood, { shift: 1, seed: 5102 });   // capital
    box(f, cx - 12, h - 5, 24, 5, DR.pewwood, { shift: -1, seed: 5103 });
    const ty = 20;
    for (let k = 0; k < 3; k++) {                                          // the carved trefoil
      const a = -Math.PI / 2 + k * 2.094;
      blob(f, cx + Math.cos(a) * 3.5, ty + Math.sin(a) * 3.5, 1.8, 1.8, flat(DR.pewwood[0]), {});
    }
    px(f, cx, ty, DR.pewwood[0]);
  } else if (style === 'salt') {
    // SALT CATHEDRAL: the concrete is still in there somewhere
    for (let y = 6; y < h - 4; y++) blob(f, cx, y, 11, 1.2, PR.crete, { mode: 'cyl', nyBias: -0.04, grain: 0.1, seed: 5201 + y });
    for (let y = 6; y < h - 3; y++) {
      for (let x = cx - 13; x <= cx + 13; x++) {
        const n = fbm(0x5a17, x * 0.18, y * 0.12, 3, 8);
        const lo = (y - 6) / (h - 10);
        if (n + lo * 0.35 > 0.72 && Math.abs(x - cx) <= 11 + (n > 0.8 ? 2 : 0)) {
          px(f, x, y, mix(DR.porcelain[3], DR.porcelain[1], hash2(x, y, 5202) * 0.5));
        }
      }
    }
    for (let k = 0; k < 6; k++) {                                          // crystals on the shoulders
      const x = cx - 10 + k * 4, y = 7 + (k % 2) * 2;
      box(f, x, y - 3, 3, 4, DR.porcelain, {});
    }
    blob(f, cx, h - 3, 14, 2.5, DR.porcelain, { shift: -1 });              // a drift at the foot
  } else if (style === 'rust') {
    // THE FURNACE: an I-beam gone orange, sweating at the rivets
    box(f, cx - 12, 2, 24, 5, PR.rust, { shift: 1, seed: 5301 });
    box(f, cx - 12, h - 7, 24, 6, PR.rust, { shift: -1, seed: 5302 });
    box(f, cx - 4, 7, 8, h - 14, PR.rust, { grain: 0.12, seed: 5303 });     // the web
    box(f, cx - 12, 7, 5, h - 14, PR.rust, { shift: 1, grain: 0.1, seed: 5304 });   // flanges
    box(f, cx + 7, 7, 5, h - 14, PR.rust, { shift: -1, grain: 0.1, seed: 5305 });
    for (let y = 10; y < h - 8; y += 6) { px(f, cx - 10, y, PR.rust[4]); px(f, cx + 9, y, PR.rust[3]); }
    speckle(f, cx - 12, 7, 24, h - 14, PR.rust[0], 0.08, 5306, 0.8);
    for (let k = 0; k < 4; k++) {                                          // heat-bluing near the floor
      for (let x = cx - 12; x < cx + 12; x++) over(f, x, h - 12 - k * 2, rgba(80, 70, 120, 255), 0.25);
    }
    glow(f, cx, h - 10, 8, rgba(255, 120, 40, 255), { halo: 0, tint: 0.25, seed: 5307 });
  } else {
    // MUTTER: a conduit column wrapped in cable, blinking to itself
    box(f, cx - 11, 2, 22, h - 4, DR.cab, { grain: 0.06, seed: 5401 });
    for (let y = 6; y < h - 6; y += 5) {
      for (let x = cx - 10; x < cx + 10; x++) px(f, x, y + ((x + y) & 1), PR.dark[(x >> 2) & 1 ? 1 : 2]);
    }
    const cols = [PR.red, DR.bottle, PR.hazard];
    for (let k = 0; k < 3; k++) {
      for (let y = 3; y < h - 3; y++) {
        const x = cx - 8 + k * 7 + Math.sin(y * 0.3 + k) * 1.5;
        px(f, x, y, cols[k][2]); px(f, x + 1, y, cols[k][1]);
      }
    }
    for (let k = 0; k < 6; k++) px(f, cx - 6 + (k % 3) * 6, 12 + k * 8, k % 2 ? GLOW_GREEN : PR.red[4]);
    box(f, cx - 13, 1, 26, 4, DR.metal, { shift: 1 });
    box(f, cx - 13, h - 5, 26, 4, DR.metal, { shift: -1 });
  }
  return finishProp(f);
}
function paintProps(out) {
  out.key_red = paintKey(rgba(206, 46, 42, 255));
  out.key_blue = paintKey(rgba(56, 118, 224, 255));
  out.key_gold = paintKey(rgba(228, 180, 46, 255));
  out.medkit_small = paintMedkit(false);
  out.medkit_big = paintMedkit(true);
  out.ammo_flak = paintAmmoFlak();
  out.ammo_crate = paintAmmoCrate();
  for (let i = 0; i < 4; i++) out[`treasure${i}`] = paintTreasure(i);
  out.barrel = paintBarrel(false);
  out.barrel_lit = paintBarrel(true);
  out.pillar = paintPillar();
  out.lamp = paintLamp();
  for (let i = 0; i < 3; i++) out[`flare${i}`] = paintFlare(i);
  out.weapon_splitter = paintWeapon('splitter');
  out.weapon_nailer = paintWeapon('nailer');
  out.weapon_halo = paintWeapon('halo');
  out.weapon_pipebomb = paintWeapon('pipebomb');
  out.weapon_deadman = paintWeapon('deadman');
  // set dressing (maps.js DECOR names these prop_<kind>)
  out.prop_desk = paintDesk();
  out.prop_chair = paintChair();
  out.prop_filing = paintFiling();
  out.prop_locker = paintLocker();
  out.prop_vending = paintVending();
  out.prop_cooler = paintCooler();
  out.prop_toilet = paintToilet();
  out.prop_urinal = paintUrinal();
  out.prop_skeleton = paintSkeleton();
  out.prop_sandbags = paintSandbags();
  out.prop_crate = paintCrate();
  out.prop_crates = paintCrates();
  out.prop_console = paintConsole();
  out.prop_plant = paintPlant();
  out.prop_mop = paintMop();
  out.prop_cone = paintCone();
  out.prop_chains = paintChains();
  out.prop_hook = paintHook();
  out.prop_corpse = paintBody('staff');
  out.prop_corpse2 = paintBody('guard');
  out.prop_nosecone = paintNosecone();
  out.prop_pinball = paintPinball();
  out.prop_candles = paintCandles();
  out.prop_pew = paintPew();
  out.prop_trash = paintTrash();
  for (const style of ['wood', 'salt', 'rust', 'tech']) out[`pillar_${style}`] = paintPillarStyle(style);
}

// ---------------------------------------------------------------------------
// sky threats - lit from above, dark underside, no black outline
// ---------------------------------------------------------------------------

const SKY = {
  body: mat(rgba(158, 160, 166, 255), { contrast: 1.25 }),
  body2: mat(rgba(112, 116, 126, 255), { contrast: 1.25 }),
  dark: mat(rgba(52, 54, 62, 255), { contrast: 1.2 }),
  warn: mat(rgba(206, 72, 46, 255), { contrast: 1.25 }),
  hazard: mat(rgba(212, 176, 52, 255), { contrast: 1.2 }),
  tung: mat(rgba(124, 118, 108, 255), { contrast: 1.3 }),
  glass: mat(rgba(90, 210, 230, 255), { contrast: 1.4 }),
};

/** Warheads dive nose-down-left; `plume` streams from the tail. */
function warheadFrame(kind) {
  const w = 48, h = 56;
  const f = makeFrame(w, h);
  // axis: nose at the lower-left, tail at the upper-right
  const ang = -1.16;                      // pointing down and slightly left
  const ux = Math.cos(ang + Math.PI), uy = Math.sin(ang + Math.PI); // toward the nose
  const cx = 27, cy = 33;
  const nose = { x: cx + ux * 17, y: cy + uy * 17 };
  const tail = { x: cx - ux * 15, y: cy - uy * 15 };
  const nx = -uy, ny = ux;                // screen perpendicular

  const at = (t, o = 0) => ({ x: lerp(tail.x, nose.x, t) + nx * o, y: lerp(tail.y, nose.y, t) + ny * o });

  // engine plume first, so the body sits on top of it
  const pl = 17;
  for (let i = 0; i < 20; i++) {
    const t = i / 19;
    const p = { x: tail.x - ux * (2 + t * pl), y: tail.y - uy * (2 + t * pl) };
    const r = (kind === 'screamer' ? 5.4 : 4.4) * (1 - t * 0.68) * (1 + 0.22 * Math.sin(i * 2.7));
    const c = mix(mix(rgba(255, 252, 236, 255), rgba(255, 170, 50, 255), Math.min(1, t * 2.1)),
      rgba(180, 60, 24, 255), Math.max(0, t * 1.4 - 0.45));
    glow(f, p.x, p.y, r, c, { halo: 1, seed: 2001 + i, base: rgba(48, 20, 10, 255), core: 0.55 });
  }

  if (kind === 'stick') {
    for (let i = 0; i <= 26; i++) {
      const t = i / 26;
      const p = at(t);
      const r = t < 0.72 ? 5.6 : 5.6 * (1 - (t - 0.72) / 0.28) + 0.3;
      blob(f, p.x, p.y, r, r, SKY.body, { shift: 0, grain: 0.05, seed: 2100 + i });
    }
    // fins
    for (let k = -1; k <= 1; k += 2) {
      const a = at(0.14), b = at(0.02);
      capsule(f, a.x + nx * k * 2, a.y + ny * k * 2, b.x + nx * k * 9, b.y + ny * k * 9, 2.4, 1.4, SKY.body2, { shift: k > 0 ? 0 : -1 });
    }
    const bd = at(0.55);
    fillRect(f, Math.round(bd.x - 6), Math.round(bd.y - 1), 12, 3, SKY.warn[2]);
    const nb = at(0.86);
    blob(f, nb.x, nb.y, 4.2, 4.2, SKY.warn, { shift: 0 });
  } else if (kind === 'mirv') {
    for (let i = 0; i <= 26; i++) {
      const t = i / 26;
      const p = at(t);
      const bulge = 5.0 + 4.0 * Math.sin(Math.pow(t, 0.8) * Math.PI * 0.9);
      blob(f, p.x, p.y, bulge, bulge, SKY.body, { grain: 0.06, seed: 2200 + i });
    }
    // sub-warhead segments
    for (let k = 0; k < 3; k++) {
      const t = 0.40 + k * 0.16;
      const p = at(t);
      capsule(f, p.x + nx * 9, p.y + ny * 9, p.x - nx * 9, p.y - ny * 9, 1.0, 1.0, SKY.dark, { shift: 1 });
      for (let sgn = -1; sgn <= 1; sgn += 2) {
        const q = { x: p.x + nx * sgn * 7.2, y: p.y + ny * sgn * 7.2 };
        const q2 = { x: q.x + ux * 4.2, y: q.y + uy * 4.2 };
        capsule(f, q.x, q.y, q2.x, q2.y, 3.4, 2.0, SKY.body2,
          { shift: sgn > 0 ? 1 : -1, edge: rgba(30, 34, 44, 255), edgeW: 0.9 });
        blob(f, q2.x, q2.y, 1.8, 1.8, SKY.warn, { shift: 1 });
      }
    }
    const nb = at(0.9);
    blob(f, nb.x, nb.y, 3.4, 3.4, SKY.hazard, {});
  } else if (kind === 'smart') {
    for (let i = 0; i <= 26; i++) {
      const t = i / 26;
      const p = at(t);
      const r = 4.4 * (1 - Math.pow(Math.max(0, t - 0.62) / 0.38, 1.6) * 0.85);
      blob(f, p.x, p.y, r, r, SKY.body, { grain: 0.04, seed: 2300 + i });
    }
    for (let k = -1; k <= 1; k += 2) {
      const a = at(0.3), b = at(0.12);
      capsule(f, a.x + nx * k * 3, a.y + ny * k * 3, b.x + nx * k * 12, b.y + ny * k * 12, 2.0, 1.0, SKY.body2, { shift: k > 0 ? 1 : -1 });
      const c2 = at(0.62), d2 = at(0.55);
      capsule(f, c2.x + nx * k * 3, c2.y + ny * k * 3, d2.x + nx * k * 8, d2.y + ny * k * 8, 1.6, 0.9, SKY.body2, { shift: k > 0 ? 1 : -1 });
    }
    const eye = at(0.9);
    blob(f, eye.x, eye.y, 3.4, 3.4, SKY.dark, { shift: 1 });
    blob(f, eye.x, eye.y, 2.2, 2.2, SKY.glass, {});
    glow(f, eye.x, eye.y, 7, rgba(120, 240, 255, 255), { halo: 0.6, seed: 2301, base: rgba(14, 34, 44, 255) });
    for (let k = 0; k < 3; k++) {
      const s = at(0.42 + k * 0.1);
      capsule(f, s.x + nx * 4, s.y + ny * 4, s.x - nx * 4, s.y - ny * 4, 0.9, 0.9, SKY.dark, { shift: 1 });
    }
  } else if (kind === 'screamer') {
    for (let i = 0; i <= 26; i++) {
      const t = i / 26;
      const p = at(t);
      const r = 3.4 * (1 - Math.pow(Math.max(0, t - 0.5) / 0.5, 1.4) * 0.7);
      blob(f, p.x, p.y, r, r, SKY.body, { grain: 0.04, seed: 2400 + i });
    }
    // heavily swept wings
    for (let k = -1; k <= 1; k += 2) {
      const root = at(0.5), tip = at(0.08);
      fillPoly(f, [
        { x: root.x + nx * k * 1.6, y: root.y + ny * k * 1.6 },
        { x: tip.x + nx * k * 1.6, y: tip.y + ny * k * 1.6 },
        { x: tip.x + nx * k * 14, y: tip.y + ny * k * 14 },
        { x: root.x + nx * k * 3.4, y: root.y + ny * k * 3.4 },
      ], SKY.body2[k > 0 ? 3 : 1]);
      const e0 = { x: tip.x + nx * k * 1.6, y: tip.y + ny * k * 1.6 };
      const e1 = { x: tip.x + nx * k * 14, y: tip.y + ny * k * 14 };
      line(f, e0.x, e0.y, e1.x, e1.y, SKY.body2[k > 0 ? 4 : 0]);
      // canard up front
      const c0 = at(0.72);
      fillPoly(f, [
        { x: c0.x + nx * k * 1.4, y: c0.y + ny * k * 1.4 },
        { x: c0.x + nx * k * 7.5 - ux * 3, y: c0.y + ny * k * 7.5 - uy * 3 },
        { x: c0.x + nx * k * 2.0 - ux * 5, y: c0.y + ny * k * 2.0 - uy * 5 },
      ], SKY.body2[k > 0 ? 3 : 1]);
    }
    const nb = at(0.94);
    blob(f, nb.x, nb.y, 2.4, 2.4, SKY.warn, { shift: 1 });
    for (let k = 0; k < 5; k++) {
      const s = at(0.2 + k * 0.14);
      px(f, s.x + nx * 3, s.y + ny * 3, SKY.warn[3]);
      px(f, s.x - nx * 3, s.y - ny * 3, SKY.warn[1]);
    }
  } else {
    // buster: heavy tungsten dart with a drill nose
    for (let i = 0; i <= 26; i++) {
      const t = i / 26;
      const p = at(t);
      const r = t < 0.7 ? 6.4 : lerp(6.4, 2.0, (t - 0.7) / 0.3);
      blob(f, p.x, p.y, r, r, SKY.tung, { grain: 0.07, seed: 2500 + i });
    }
    // drill nose: a fluted cone spiralling to a point
    for (let k = 0; k < 9; k++) {
      const t = 0.70 + k * 0.038;
      const a = at(t);
      const wob = Math.sin(k * 1.15) * (6.4 - k * 0.62);
      capsule(f, a.x + nx * wob, a.y + ny * wob, a.x - nx * wob * 0.2, a.y - ny * wob * 0.2, 1.3, 1.3, SKY.dark, { shift: 1 });
      const rr = 6.4 - k * 0.66;
      capsule(f, a.x - nx * rr, a.y - ny * rr, a.x + nx * rr, a.y + ny * rr, 1.1, 1.1, SKY.tung, { shift: k % 2 ? 1 : -1 });
    }
    const nb = at(1.02);
    blob(f, nb.x, nb.y, 1.6, 1.6, SKY.body, { shift: 1 });
    // stabiliser strakes
    for (let k = -1; k <= 1; k += 2) {
      const a = at(0.22), b = at(0.05);
      capsule(f, a.x + nx * k * 5, a.y + ny * k * 5, b.x + nx * k * 8, b.y + ny * k * 8, 2.2, 1.6, SKY.body2, { shift: k > 0 ? 1 : -1 });
    }
    const bd = at(0.4);
    for (let k = 0; k < 3; k++) {
      const s = at(0.34 + k * 0.08);
      capsule(f, s.x + nx * 6.4, s.y + ny * 6.4, s.x - nx * 6.4, s.y - ny * 6.4, 1.0, 1.0, SKY.dark, { shift: 1 });
    }
    fillRect(f, Math.round(bd.x - 5), Math.round(bd.y - 5), 3, 3, SKY.hazard[3]);
  }
  topRim(f, rgba(255, 250, 230, 255), 0.42, 0.2);
  underShade(f, rgba(20, 26, 42, 255), 0.5, 0.24);
  outline(f, rgba(38, 42, 54, 255));
  return f;
}

function paintSkymine(F) {
  const w = 48, h = 56;
  const f = makeFrame(w, h);
  const cx = 24, cy = 27;
  const r = 13;
  // spikes first
  for (let i = 0; i < 14; i++) {
    const a = i * Math.PI * 2 / 14 + 0.12;
    const ex = cx + Math.cos(a) * (r + 8), ey = cy + Math.sin(a) * (r + 8) * 0.94;
    capsule(f, cx + Math.cos(a) * (r - 2), cy + Math.sin(a) * (r - 2), ex, ey, 3.0, 0.7, SKY.body2,
      { shift: Math.cos(a) < -0.2 ? 0 : (Math.sin(a) > 0.3 ? -1 : 0) });
    blob(f, ex, ey, 1.0, 1.0, SKY.body, { shift: 1 });
  }
  // orb
  blob(f, cx, cy, r, r * 0.98, SKY.body2, { grain: 0.07, seed: 2600 });
  blob(f, cx, cy, r - 2.5, r * 0.98 - 2.5, SKY.body2, { shift: 0, grain: 0.09, seed: 2601 });
  // equatorial band + panel seams
  for (let a = 0; a < 6.283; a += 0.06) {
    px(f, cx + Math.cos(a) * (r - 1), cy + Math.sin(a) * (r - 1) * 0.98, SKY.dark[2]);
  }
  fillRect(f, cx - r + 2, cy - 1, (r - 2) * 2, 3, SKY.dark[1]);
  fillRect(f, cx - r + 2, cy - 1, (r - 2) * 2, 1, SKY.body[3]);
  for (let i = 0; i < 6; i++) {
    const a = i * 1.05;
    line(f, cx, cy, cx + Math.cos(a) * (r - 2), cy + Math.sin(a) * (r - 2), SKY.body2[1]);
  }
  // blinking lights - a different one lit each frame
  const lights = [[-6, -5], [6, -5], [-7, 4], [7, 4], [0, -8], [0, 7]];
  for (let i = 0; i < lights.length; i++) {
    const [lx, ly] = lights[i];
    const on = (i % 4) === F;
    const c = on ? rgba(255, 240, 200, 255) : rgba(120, 40, 34, 255);
    blob(f, cx + lx, cy + ly, 2.0, 1.8, flat(c));
    if (on) glow(f, cx + lx, cy + ly, 6.5, rgba(255, 120, 60, 255), { halo: 0.55, seed: 2610 + i, base: rgba(40, 16, 10, 255) });
  }
  // hazard chevrons on the band
  for (let x = cx - r + 3; x < cx + r - 2; x++) {
    if (((x - cx) % 6 + 6) % 6 < 3) over(f, x, cy, SKY.hazard[3], 0.8);
  }
  // small station-keeping thruster underneath, pulsing with the frame
  const th = 0.45 + 0.55 * ((F % 2) === 0 ? 1 : 0.4);
  capsule(f, cx, cy + r, cx, cy + r + 3, 3.0, 2.4, SKY.dark, {});
  for (let i = 0; i < 6; i++) {
    glow(f, cx, cy + r + 5 + i * 2.2, (4 - i * 0.5) * th, mix(rgba(210, 240, 255, 255), rgba(70, 120, 220, 255), i / 5),
      { halo: 1, seed: 2620 + i, base: rgba(16, 24, 48, 255), core: 0.6 });
  }
  topRim(f, rgba(255, 250, 230, 255), 0.4, 0.18);
  underShade(f, rgba(20, 26, 42, 255), 0.45, 0.2);
  outline(f, rgba(34, 38, 48, 255));
  return f;
}

function paintSky(out) {
  out.wh_stick = warheadFrame('stick');
  out.wh_mirv = warheadFrame('mirv');
  out.wh_smart = warheadFrame('smart');
  out.wh_screamer = warheadFrame('screamer');
  out.wh_buster = warheadFrame('buster');
  for (let i = 0; i < 4; i++) out[`skymine${i}`] = paintSkymine(i);
}

// ---------------------------------------------------------------------------
// decals - flat on the floor, no black outline
// ---------------------------------------------------------------------------

function paintBlood(k) {
  const w = 48, h = 24;
  const f = makeFrame(w, h);
  const cx = 24, cy = 14;
  const rng = makeRng(0x1000 + k * 7717);
  const dark = rgba(44, 8, 14, 255), mid = rgba(78, 12, 18, 255), lit = rgba(112, 22, 24, 255);
  const rx = 9 + k * 6, ry = 4 + k * 2.4;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = (x - cx) / rx, v = (y - cy) / ry;
      const d = Math.hypot(u, v);
      const wob = 0.82 + fbm(0x3311 + k, x * 0.16, y * 0.3, 3, 8) * 0.42;
      if (d > wob) continue;
      px(f, x, y, d > wob * 0.78 ? dark : (hash2(x, y, 3001 + k) < 0.14 ? lit : mid));
    }
  }
  // droplets and a drag streak
  for (let i = 0; i < 10 + k * 8; i++) {
    const a = rng() * 6.28, r = (1.1 + rng() * 0.9) * rx;
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r * (ry / rx) * 1.5;
    const s = rng() < 0.3 ? 2 : 1;
    fillRect(f, Math.round(x), Math.round(y), s, s, rng() < 0.4 ? mid : dark);
  }
  if (k === 2) {
    for (let i = 0; i < 16; i++) {
      const t = i / 15;
      fillRect(f, Math.round(cx + 12 + t * 12), Math.round(cy + 3 - t * 2), Math.max(1, Math.round(3 - t * 2)), Math.max(1, Math.round(2 - t)), t < 0.5 ? mid : dark);
    }
  }
  // wet specular
  for (let i = 0; i < 5 + k * 3; i++) {
    const x = cx - rx * 0.4 + rng() * rx * 0.5, y = cy - ry * 0.4 + rng() * ry * 0.5;
    over(f, x, y, rgba(170, 66, 58, 255), 0.4);
  }
  outline(f, rgba(24, 4, 8, 255));
  return f;
}

function paintScorch() {
  const w = 48, h = 24;
  const f = makeFrame(w, h);
  const cx = 24, cy = 13;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = (x - cx) / 20, v = (y - cy) / 9;
      const d = Math.hypot(u, v);
      const wob = 0.78 + fbm(0x5aa1, x * 0.10, y * 0.20, 3, 8) * 0.4;
      if (d > wob) continue;
      const t = clamp(d / wob, 0, 1);
      // dithered fade at the edge only
      if (t > 0.68 && hash2(x, y, 3101) > (1 - t) / 0.32) continue;
      const n = fbm(0x5ab2, x * 0.22, y * 0.34, 3, 8);
      const c = mix(rgba(14, 12, 14, 255), rgba(62, 56, 54, 255), Math.pow(t, 1.7) * 0.8 + n * 0.25);
      px(f, x, y, c);
    }
  }
  // heat-cracked centre with a few live embers
  for (let i = 0; i < 7; i++) {
    const a = i * 0.9, r = 3 + (i % 3) * 3;
    line(f, cx, cy, cx + Math.cos(a) * r * 1.7, cy + Math.sin(a) * r * 0.75, rgba(38, 34, 32, 255));
  }
  for (let i = 0; i < 5; i++) {
    const x = cx - 7 + i * 3.6, y = cy - 2 + (i % 3) * 3;
    over(f, x, y, rgba(174, 76, 30, 255), 0.5);
    over(f, x + 1, y, rgba(120, 46, 20, 255), 0.4);
  }
  outline(f, rgba(12, 10, 12, 255));
  return f;
}

function paintDecals(out) {
  for (let i = 0; i < 3; i++) out[`blood${i}`] = paintBlood(i);
  out.scorch = paintScorch();
}

// ---------------------------------------------------------------------------
// RADIATION MUTANTS
// One shared sick palette and one shared unnatural glow, so the whole mutant
// cast reads as a single species of accident.
// ---------------------------------------------------------------------------

const ROT = {
  flesh: rgba(122, 132, 104, 255),   // grey-green necrotic
  sick: rgba(112, 116, 74, 255),     // the walking cast's own: yellower, deader
  bruise: rgba(96, 64, 88, 255),     // bruised purple
  muscle: rgba(158, 58, 54, 255),    // wet exposed muscle
  bone: rgba(214, 206, 180, 255),
  glow: rgba(120, 255, 140, 255),    // the shared unnatural glow
};

const RR = {
  flesh: mat(ROT.sick, { contrast: 1.5 }),
  fleshD: mat(mix(shade(ROT.sick, 0.72), ROT.bruise, 0.25), { contrast: 1.5 }),
  fleshP: mat(mix(ROT.sick, ROT.bruise, 0.45), { contrast: 1.4 }),
  bruise: mat(ROT.bruise, { contrast: 1.25 }),
  muscle: mat(ROT.muscle, { contrast: 1.3 }),
  bone: mat(ROT.bone, { contrast: 1.2 }),
  fang: mat(rgba(232, 226, 202, 255), { contrast: 1.25 }),
  gum: mat(rgba(78, 28, 34, 255), { contrast: 1.2 }),
  maw: flat(rgba(20, 8, 12, 255)),
  chitin: mat(rgba(76, 70, 78, 255), { contrast: 1.4 }),
  claw: mat(rgba(38, 34, 36, 255), { contrast: 1.5 }),
  glow: flat(ROT.glow),
  rag: mat(rgba(196, 96, 24, 255), { contrast: 1.15 }),   // wrencher orange
  hivis: mat(rgba(214, 222, 180, 255), { contrast: 1.05 }),
  hat: mat(rgba(236, 184, 34, 255), { contrast: 1.2 }),
  tongue: mat(rgba(206, 96, 112, 255), { contrast: 1.25 }),
  coat: mat(rgba(206, 208, 200, 255), { contrast: 1.2 }),
  ink: rgba(13, 12, 14, 255),
};
const WETC = rgba(228, 244, 214, 255);
// Mutants bleed darker and thicker, with something glowing in it.
const MUTANT_BLOOD = [rgba(150, 30, 26, 255), rgba(74, 14, 18, 255), rgba(196, 255, 150, 255)];
const MUTANT_POOL = { dark: rgba(52, 10, 14, 255), mid: rgba(104, 20, 20, 255), lit: rgba(110, 170, 60, 255) };
const MASK_KEY = rgba(3, 5, 7, 255);   // sentinel for the mass shader

/**
 * Shade a flat sentinel-coloured mass as one coherent volume: every column is
 * lit like a slice of a lying cylinder, plus a lateral term. Lets an organic
 * body built from overlapping blobs come out smooth instead of lumpy.
 */
function massShade(f, bx0, by0, bx1, by1, ramp, o = {}) {
  const kx = o.kx === undefined ? 0.7 : o.kx;
  const ky = o.ky === undefined ? 0.7 : o.ky;
  const shift = o.shift || 0, grain = o.grain || 0, seed = o.seed || 9;
  const mcx = o.cx === undefined ? (bx0 + bx1) / 2 : o.cx;
  const mrx = Math.max(2, o.rx === undefined ? (bx1 - bx0) / 2 : o.rx);
  for (let x = Math.max(0, bx0); x <= Math.min(f.w - 1, bx1); x++) {
    let top = -1, bot = -1;
    for (let y = Math.max(0, by0); y <= Math.min(f.h - 1, by1); y++) {
      if (getpx(f, x, y) === MASK_KEY) { if (top < 0) top = y; bot = y; }
    }
    if (top < 0) continue;
    const hh = Math.max(1, bot - top);
    const u = clamp((x - mcx) / mrx, -1, 1);
    for (let y = top; y <= bot; y++) {
      if (getpx(f, x, y) !== MASK_KEY) continue;
      const v = ((y - top) / hh) * 2 - 1;
      const nx = u * kx, ny = v * ky;
      const nz = Math.sqrt(Math.max(0.04, 1 - nx * nx - ny * ny));
      let b = band(lamOf(nx, ny, nz)) + shift;
      if (grain && hash2(x, y, seed) < grain) b -= 1;
      px(f, x, y, ramp[clamp(b | 0, 0, 4)]);
    }
  }
}

/** Wet specular flecks - rot only reads as rot when it looks damp. */
function wetness(f, x0, y0, x1, y1, seed, density = 0.012) {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (hash2(x, y, seed) > density) continue;
      const d = getpx(f, x, y);
      if (!(d >>> 24)) continue;
      if (!(getpx(f, x, y - 1) >>> 24)) continue;
      if (((d >>> 8) & 255) < 70) continue;      // keep specks off the dark underside
      px(f, x, y, WETC);
      over(f, x + 1, y, WETC, 0.35);
      over(f, x, y + 1, mix(WETC, ROT.flesh, 0.5), 0.5);
    }
  }
}

/** A wandering vein over a body part. */
function vein(f, x, y, a, n, step, c, seed) {
  for (let i = 0; i < n; i++) {
    a += (hash2(i, seed, 71) - 0.5) * 0.9;
    x += Math.cos(a) * step; y += Math.sin(a) * step;
    over(f, x, y, c, 0.6);
    if (i % 4 === 2) over(f, x + 1, y, c, 0.3);
  }
}

/**
 * Sores over whatever is already painted in a box: a bruised rim, then either
 * an open weeping hole or a fat pustule of the glowing stuff with a wet
 * highlight, some of them running. Only ever lands on the body.
 */
function sores(f, x0, y0, x1, y1, n, k, seed) {
  for (let i = 0; i < n; i++) {
    const x = lerp(x0, x1, hash2(i, 1, seed)), y = lerp(y0, y1, hash2(i, 2, seed));
    if (!(getpx(f, Math.round(x), Math.round(y)) >>> 24)) continue;
    const r = (0.8 + hash2(i, 3, seed) * 1.1) * k;
    const pus = hash2(i, 4, seed) < 0.45;
    for (let yy = Math.floor(y - r * 1.6); yy <= Math.ceil(y + r * 1.6); yy++) {
      for (let xx = Math.floor(x - r * 1.6); xx <= Math.ceil(x + r * 1.6); xx++) {
        const d = Math.hypot(xx - x, yy - y) / r;
        if (d > 1.6 || !(getpx(f, xx, yy) >>> 24)) continue;
        if (d > 1) over(f, xx, yy, ROT.bruise, 0.55 * (1.6 - d) / 0.6);
        else if (pus) px(f, xx, yy, d > 0.7 ? rgba(150, 120, 40, 255) : mix(rgba(236, 255, 170, 255), ROT.glow, d));
        else px(f, xx, yy, d > 0.65 ? RR.muscle[1] : d > 0.3 ? RR.muscle[0] : rgba(34, 6, 10, 255));
      }
    }
    px(f, Math.round(x - r * 0.35), Math.round(y - r * 0.4), WETC);
    if (hash2(i, 5, seed) < 0.4) drip(f, Math.round(x), Math.round(y + r), Math.round(2 + hash2(i, 6, seed) * 3 * k), pus ? mix(rgba(200, 230, 120, 255), ROT.glow, 0.4) : GORE.blood, 0.8);
  }
}

/**
 * A row of needle fangs along a line, pointing along (nx,ny).
 * Light teeth on a dark mouth: the silhouette detail that survives downscaling.
 */
function fangRow(f, x0, y0, x1, y1, n, len, nx, ny, o = {}) {
  const ramp = o.ramp || RR.fang;
  const seed = o.seed || 5;
  const dx = (x1 - x0) / n, dy = (y1 - y0) / n;
  const gap = o.gap === undefined ? 0.22 : o.gap;      // dark slot between teeth
  const vary = o.vary === undefined ? 0.36 : o.vary;
  for (let i = 0; i < n; i++) {
    const h = hash2(i, seed, 77);
    const L = len * (1 - vary * h);
    const arc = o.arc || 0;
    const ca = (t) => arc * (1 - 4 * (t - 0.5) * (t - 0.5));
    const ta = (i + gap) / n, tb = (i + 1 - gap) / n;
    const ax = x0 + dx * (i + gap) + nx * ca(ta), ay = y0 + dy * (i + gap) + ny * ca(ta);
    const bx = x0 + dx * (i + 1 - gap) + nx * ca(tb), by = y0 + dy * (i + 1 - gap) + ny * ca(tb);
    const mx = (ax + bx) / 2, my = (ay + by) / 2;
    const tipx = mx + nx * L - dx * (o.rake || 0) * 0.35;
    const tipy = my + ny * L - dy * (o.rake || 0) * 0.35;
    fillPoly(f, [{ x: ax, y: ay }, { x: bx, y: by }, { x: tipx, y: tipy }], ramp[h < 0.4 ? 3 : 2]);
    // lit leading edge, dark trailing edge, so each needle separates
    line(f, ax, ay, tipx, tipy, ramp[4]);
    line(f, bx, by, tipx, tipy, ramp[0]);
    line(f, ax - dx * gap, ay - dy * gap, ax - dx * gap + nx * L * 0.5, ay - dy * gap + ny * L * 0.5, RR.maw[0]);
    px(f, mx, my, ramp[4]);
  }
}

/** A gaping mouth: dark cavity, gums, opposed fang rows, optional glow. */
function gape(f, cx, cy, rx, ry, o = {}) {
  const rows = o.rows || 1;
  blob(f, cx, cy, rx + 1.2, ry + 1.2, RR.gum, { shift: 0, edge: o.ink || RR.ink, edgeW: 0.9 });
  blob(f, cx, cy, rx, ry, RR.maw, {});
  if (o.glow) {
    glow(f, cx, cy + ry * 0.25, rx * 0.95, ROT.glow, { halo: 0, tint: 0.5 * o.glow, seed: (o.seed || 3) + 1 });
    blob(f, cx, cy + ry * 0.35, rx * 0.42, ry * 0.3, flat(mix(rgba(30, 60, 34, 255), ROT.glow, 0.55 * o.glow)));
  }
  if (o.tongue) {
    capsule(f, cx, cy + ry * 0.2, cx + (o.tongue > 0 ? rx * 0.5 : -rx * 0.5), cy + ry * 0.95,
      ry * 0.28, ry * 0.16, RR.muscle, { shift: 0 });
  }
  const n = o.n || Math.max(5, Math.round(rx * 0.9));
  const maxL = ry * 0.5;                              // teeth never meet: keep a throat
  for (let r = 0; r < rows; r++) {
    const k = 1 - r * 0.26;
    const fl = Math.min(o.len || ry * 0.72, maxL) * k;
    fangRow(f, cx - rx * k, cy - ry * (0.72 - r * 0.2), cx + rx * k, cy - ry * (0.72 - r * 0.2),
      n - r, fl, 0, 1, { seed: (o.seed || 5) + r * 3, rake: r ? 0.4 : 0 });
    fangRow(f, cx - rx * k, cy + ry * (0.72 - r * 0.2), cx + rx * k, cy + ry * (0.72 - r * 0.2),
      n - r, fl * 0.86, 0, -1, { seed: (o.seed || 5) + 11 + r * 3, rake: r ? -0.4 : 0 });
  }
  // wet rim
  for (let a = 0; a < 6.283; a += 0.12) {
    over(f, cx + Math.cos(a) * (rx + 0.8), cy + Math.sin(a) * (ry + 0.8), Math.sin(a) < 0 ? WETC : RR.gum[0], 0.35);
  }
}

/** A long lolling tongue out of a mouth, the joke that sells a monster. */
function tongue(f, x0, y0, x1, y1, r, seed) {
  const mx = (x0 + x1) / 2 + (y1 - y0) * 0.25, my = (y0 + y1) / 2 + Math.abs(x1 - x0) * 0.2;
  capsule(f, x0, y0, mx, my, r, r * 1.05, RR.tongue, { edge: RR.ink, edgeW: 0.8 });
  capsule(f, mx, my, x1, y1, r * 1.05, r * 0.9, RR.tongue, { edge: RR.ink, edgeW: 0.8, spec: rgba(255, 220, 230, 255) });
  line(f, Math.round(x0), Math.round(y0), Math.round(mx), Math.round(my), RR.tongue[0]);
  drip(f, Math.round(x1), Math.round(y1 + r * 0.6), 2 + Math.round(hash2(1, seed, 2) * 3), mix(RR.tongue[3], WETC, 0.4), 0.9);
}

// ---------------------------------------------------------------------------
// quadruped rig - a spine you can pitch, four IK legs, digitigrade hindquarters
// ---------------------------------------------------------------------------

const QBIT = [2, 4, 8, 16];   // front right, front left, hind right, hind left

function quadruped(f, ch, pose, D, mask = 0) {
  const k = ch.k || K;
  const theta = D * Math.PI / 2;
  const cx = f.w / 2;
  const groundY = f.h - 1;
  const P = projector(theta, cx, groundY, pose.xform, k);
  const R = ch.ramps;
  const E = { edge: ch.edge, edgeW: 0.9 };
  const pitch = pose.pitch || 0, rise = pose.rise || 0;
  const acos = Math.abs(Math.cos(theta)), asin = Math.abs(Math.sin(theta));

  const hipAnchor = V(0, ch.hipY + rise, -ch.bodyLen * 0.5);
  const spine = (t) => {
    const p = V(0, lerp(ch.hipY, ch.shoulderY, t) + rise, lerp(-ch.bodyLen * 0.5, ch.bodyLen * 0.5, t));
    const dy = p.y - hipAnchor.y, dz = p.z - hipAnchor.z;
    const c = Math.cos(pitch), s = Math.sin(pitch);
    return V(p.x, hipAnchor.y + dy * c + dz * s, hipAnchor.z + dz * c - dy * s);
  };

  const parts = [];
  const add = (z, draw) => parts.push({ z, draw });
  const ctx = { f, ch, pose, D, theta, P, add, R, spine, E, acos, asin, k, mask };

  // --- legs
  const legs = [];
  for (let i = 0; i < 4; i++) {
    const front = i < 2, side = (i % 2) ? -1 : 1;
    const root = vadd(spine(front ? ch.shoulderT : ch.hipT),
      V(side * (front ? ch.legHalfF : ch.legHalfR), front ? -0.5 : -1.0, 0));
    const tgt = pose.feet[i];
    if (front) {
      const sol = ik(root, tgt, ch.humerus, ch.radius, V(side * 0.3, 0.1, -1));
      legs.push({ front, side, root, j1: sol.joint, j2: sol.end, foot: sol.end, bit: QBIT[i] });
    } else {
      const hockT = V(tgt.x, tgt.y + ch.hockH, tgt.z - ch.hockZ);
      const sol = ik(root, hockT, ch.femur, ch.tibia, V(side * 0.2, 0, 1));
      legs.push({ front, side, root, j1: sol.joint, j2: sol.end, foot: tgt, bit: QBIT[i] });
    }
  }
  ctx.legs = legs;
  for (const L of legs) {
    const a = P(L.root), b = P(L.j1), c = P(L.j2), d = P(L.foot);
    const zz = (b.z + c.z) * 0.5 + (L.front ? 0.4 : -0.4);
    add(zz, () => {
      const sft = zz < -1 ? -1 : 0;
      const tk = (L.front ? ch.armThick : ch.legThick) * k;
      if (mask & L.bit) {
        stump(f, a.x, a.y, b.x - a.x, b.y - a.y, tk * 1.2, L.front ? R.limbF : R.limbR,
          { shift: sft, edge: ch.edge, seed: 300 + L.bit, len: tk * 0.8, fringe: false });
        return;
      }
      paintQuadLeg(ctx, L, a, b, c, d, sft);
    });
  }

  // --- body mass along the spine
  add(0.2, () => {
    const n = ch.bodySlices || 11;
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const pr = profileAt(ch.body, t);
      const s2 = P(spine(t));
      const rxs = Math.sqrt(Math.pow(pr.w * Math.cos(theta), 2) + Math.pow((ch.bodyLen / n) * 1.15 * Math.sin(theta), 2)) * k;
      const rys = pr.d * k;
      blob(f, s2.x, s2.y, Math.max(rxs, 0.8), rys, flat(MASK_KEY), {});
      x0 = Math.min(x0, s2.x - rxs - 2); x1 = Math.max(x1, s2.x + rxs + 2);
      y0 = Math.min(y0, s2.y - rys - 2); y1 = Math.max(y1, s2.y + rys + 2);
    }
    const mid = P(spine(0.5));
    massShade(f, Math.floor(x0), Math.floor(y0), Math.ceil(x1), Math.ceil(y1), R.body, {
      kx: 0.28 + 0.62 * acos, ky: 0.92 - 0.22 * acos, cx: mid.x,
      rx: (x1 - x0) / 2, grain: 0.07, seed: 311,
    });
    if (ch.hide) ch.hide(f, { ...ctx, x0, y0, x1, y1 });
  });

  // --- neck and head at the front of the spine
  const nk0 = spine(1);
  const headB = vadd(nk0, V(0, ch.headUp + (pose.headUp || 0), ch.headFwd + (pose.headFwd || 0)));
  const hd = P(headB);
  add(hd.z + 12, () => {
    const seg = ch.neckSegs || 5;
    const reach = (mask & 1) ? 0.45 : 1;
    for (let i = 0; i <= seg; i++) {
      const t = i / seg * reach;
      const p = P(vadd(nk0, vmul(vsub(headB, nk0), t)));
      const r = lerp(ch.neckR0, ch.neckR1, t) * k;
      blob(f, p.x, p.y, r, r * 0.92, R.limbF, { grain: 0.05, seed: 320 + i, ...(i === 0 ? E : {}) });
    }
    if (mask & 1) {
      const a = P(vadd(nk0, vmul(vsub(headB, nk0), reach * 0.7))), b = P(vadd(nk0, vmul(vsub(headB, nk0), reach)));
      stump(f, a.x, a.y, b.x - a.x, b.y - a.y, ch.neckR1 * k * 1.05, R.limbF, { len: 0, seed: 330, flat: 0.62, bone: 0.42, drips: 3, fringe: false });
      return;
    }
    ch.head(f, { ...ctx, hd, headB });
  });

  if (ch.gear) ch.gear({ ...ctx, legs, headB, hd });

  parts.sort((a, b) => a.z - b.z);
  beginOrder(f);
  for (let i = 0; i < parts.length; i++) { CUR_ORD = Math.min(250, i + 1); parts[i].draw(); }
  contactShadow(f, k, 0.55);
  return { body: P(spine(0.5)), head: hd };
}

/** One quadruped leg: upper, lower, the digitigrade cannon bone, the paw. */
function paintQuadLeg(c, L, a, b, cc, d, sft) {
  const { f, ch, R, k, E } = c;
  const tk = (L.front ? ch.armThick : ch.legThick) * k;
  const ramp = L.front ? R.limbF : R.limbR;
  capsule(f, a.x, a.y, b.x, b.y, tk * 1.15, tk * 0.85, ramp, { shift: sft, grain: 0.05, seed: 301, ...E });
  capsule(f, b.x, b.y, cc.x, cc.y, tk * 0.85, tk * 0.6, ramp, { shift: sft, grain: 0.05, seed: 302, ...E });
  if (!L.front) capsule(f, cc.x, cc.y, d.x, d.y, tk * 0.6, tk * 0.5, R.limbR, { shift: sft, ...E });
  // knobbly joint
  blob(f, b.x, b.y, tk * 0.7, tk * 0.62, ramp, { shift: sft + 1 });
  over(f, b.x - tk * 0.3, b.y - tk * 0.3, WETC, 0.4);
  if (ch.paw) ch.paw(f, { p: d, prev: cc, side: L.side, front: L.front, sft, ch, R, P: c.P, theta: c.theta, E, k });
}

/**
 * Quadruped walk, eight frames, generated from a footfall pattern: each paw
 * is planted for `duty` of the cycle starting at its own offset (front right,
 * front left, hind right, hind left) and slides back at a constant rate while
 * it is, so something is always on the floor and nothing skates. The spine
 * rises and pitches on top of it, and the head bobs against it.
 */
function quadPose(ch, F, o = {}) {
  const g = ch.qgait;
  const u0 = F / WALK_N;
  const feet = [];
  for (let i = 0; i < 4; i++) {
    const front = i < 2, side = (i % 2) ? -1 : 1;
    let u = u0 - g.offs[i];
    u -= Math.floor(u);
    const stride = front ? g.strideF : g.strideR, z0 = front ? g.zF : g.zR;
    let y = 0, z;
    if (u < g.duty) {
      z = z0 + stride * (1 - 2 * u / g.duty);
    } else {
      const s = (u - g.duty) / (1 - g.duty), e = s * s * (3 - 2 * s);
      z = z0 + stride * (-1 + 2 * e);
      y = (front ? g.liftF : g.liftR) * Math.sin(Math.PI * Math.pow(s, 0.75));
    }
    feet.push(V(side * (front ? ch.footHalfF : ch.footHalfR), ch.ankleY + y, z));
  }
  const a = u0 * TAU;
  return {
    feet,
    pitch: g.pitch * Math.sin(a * g.freq + g.pitchPh),
    rise: g.rise * (0.5 + 0.5 * Math.sin(a * g.freq + g.risePh)),
    headUp: g.hu * Math.sin(a * g.freq + g.risePh - 1.2),
    headFwd: g.hf * (0.5 + 0.5 * Math.sin(a * g.freq + g.risePh)),
    jaw: g.jaw + g.jawAmp * (0.5 + 0.5 * Math.sin(a * g.freq + 0.8)),
    phase: a, xform: o.xform || null,
  };
}

/** Ghoul - what is left of the bunker day shift. Runs on all fours. */
function makeGhoul() {
  const R = {
    body: RR.flesh, limbF: RR.fleshD, limbR: RR.fleshD,
    skull: mat(mix(ROT.sick, ROT.bone, 0.36), { contrast: 1.45 }),
    rag: RR.rag, bone: RR.bone, bruise: RR.bruise,
  };
  return {
    id: 'ghoul', w: 56, h: 66, k: K,
    hipY: 33, shoulderY: 26.5, bodyLen: 23, shoulderT: 0.86, hipT: 0.14,
    body: [[0, 8.2, 6.8], [0.32, 9.6, 7.8], [0.66, 7.4, 6.2], [1, 5.2, 4.6]],
    bodySlices: 12,
    legHalfF: 6.0, legHalfR: 6.4, footHalfF: 7.0, footHalfR: 7.4, ankleY: 2.2,
    humerus: 15.5, radius: 15, femur: 14.5, tibia: 13, hockH: 5.2, hockZ: 5.4,
    armThick: 2.5, legThick: 3.0,
    neckSegs: 5, neckR0: 3.4, neckR1: 3.8, headUp: -1.6, headFwd: 7.6,
    edge: rgba(18, 18, 14, 255), ramps: R,
    // a scuttle: one paw at a time, hind leg then the front leg on the same
    // side, the spine rolling over it and the head hanging, bobbing, drooling
    qgait: {
      offs: [0.75, 0.25, 0.5, 0.0], duty: 0.66, freq: 2,
      zF: 8.5, zR: -9.5, strideF: 4.6, strideR: 4.4, liftF: 4.6, liftR: 3.8,
      rise: 1.1, risePh: 0.4, pitch: 0.04, pitchPh: 1.2, hu: 0.9, hf: 0.8, jaw: 0.28, jawAmp: 0.22,
    },
    paw(f, c) {
      const { p, front, sft, E, k } = c;
      if (front) {
        // long fingers ending in split nails
        blob(f, p.x, p.y, 2.4 * k, 2.0 * k, RR.fleshD, { shift: sft, ...E });
        for (let i = -1; i <= 1; i++) {
          const fx = p.x + i * 1.8 * k, fy = p.y + (2.4 + Math.abs(i) * 0.4) * k;
          capsule(f, p.x + i * 0.9 * k, p.y + 0.6 * k, fx, fy, 1.0 * k, 0.7 * k, RR.fleshD, { shift: sft, ...E });
          px(f, Math.round(fx), Math.round(fy + k), RR.bone[3]);
          px(f, Math.round(fx + (i > 0 ? 1 : -1) * 0.6 * k), Math.round(fy + 1.6 * k), RR.bone[1]);
        }
      } else {
        blob(f, p.x, p.y - 0.4 * k, 2.8 * k, 1.9 * k, RR.fleshD, { shift: sft, ...E });
        for (let i = -1; i <= 1; i++) px(f, Math.round(p.x + i * 2 * k), Math.round(p.y + 1.4 * k), RR.bone[2]);
      }
    },
    hide(f, c) {
      const { P, spine, theta, ch, R: RM, x0, y0, x1, y1, k } = c;
      const fw = Math.cos(theta), sd = Math.sin(theta);
      // ribs showing through waxy translucent skin
      for (let i = 0; i < 6; i++) {
        const t = 0.42 + i * 0.09;
        const s2 = P(spine(t));
        const pr = profileAt(ch.body, t);
        const rw = Math.sqrt(Math.pow(pr.w * fw, 2) + Math.pow(2.4 * sd, 2)) * k;
        for (let a = -1.25; a <= 1.25; a += 0.07) {
          const rx = s2.x + Math.sin(a) * rw * 0.94;
          const ry = s2.y + 0.6 * k + Math.cos(a) * pr.d * k * 0.72;
          over(f, rx, ry, RM.bone[3], 0.46 - Math.abs(a) * 0.14);
          over(f, rx, ry + 1, RM.bone[0], 0.30);
        }
      }
      // shoulder hump, so the back view is not a bare column
      {
        const s2 = P(spine(0.3));
        const pr = profileAt(ch.body, 0.3);
        const rw = Math.sqrt(Math.pow(pr.w * fw, 2) + Math.pow(4.0 * sd, 2)) * k;
        blob(f, s2.x, s2.y - pr.d * k * 0.5, rw * 0.82, 3.4 * k, RM.body, { mode: 'cyl', nyBias: -0.55, grain: 0.06, seed: 344 });
      }
      // spine knuckles
      for (let i = 0; i <= 8; i++) {
        const s2 = P(spine(0.12 + i * 0.1));
        const pr = profileAt(ch.body, 0.12 + i * 0.1);
        blob(f, s2.x, s2.y - pr.d * k * 0.86, 1.0 * k, 0.8 * k, RM.bone, { shift: i % 2 });
      }
      // torn orange coverall scraps, a strip of hi-vis still hanging on
      for (let i = 0; i < 3; i++) {
        const t = 0.24 + i * 0.2;
        const s2 = P(spine(t));
        const pr = profileAt(ch.body, t);
        const rw = Math.sqrt(Math.pow(pr.w * fw, 2) + Math.pow(3.0 * sd, 2)) * k;
        for (let x = -rw; x <= rw; x++) {
          const hgt = (3 + Math.round(2.5 * Math.abs(Math.sin(x / k * 0.9 + i)))) * k;
          for (let y = 0; y < hgt; y++) {
            if (hash2(s2.x + x, s2.y + y, 340 + i) < 0.14) continue;
            const yy = s2.y + pr.d * k * 0.25 + y;
            if (!(getpx(f, s2.x + x, yy) >>> 24)) continue;
            const stripe = i === 1 && y > hgt * 0.35 && y < hgt * 0.6;
            px(f, s2.x + x, yy, stripe ? RR.hivis[y < hgt * 0.45 ? 3 : 2] : RM.rag[y < k ? 3 : (y > hgt - 2 * k ? 0 : 2)]);
          }
        }
      }
      // bruises and a few open sores
      for (let i = 0; i < 5; i++) {
        const s2 = P(spine(0.15 + i * 0.17));
        const pr = profileAt(ch.body, 0.15 + i * 0.17);
        const bx = s2.x + (hash2(i, 1, 345) - 0.5) * pr.w * k, by = s2.y + (hash2(i, 2, 345) - 0.2) * pr.d * k;
        blob(f, bx, by, 1.2 * k, 1.0 * k, i % 2 ? RR.bruise : RR.muscle, { shift: -1 });
        if (i % 2 === 0) px(f, Math.round(bx - 0.4 * k), Math.round(by - 0.4 * k), WETC);
      }
      sores(f, x0 + (x1 - x0) * 0.15, y0 + (y1 - y0) * 0.3, x1 - (x1 - x0) * 0.15, y1 - (y1 - y0) * 0.15, 7, k, 342);
      wetness(f, Math.floor(x0), Math.floor(y0), Math.ceil(x1), Math.ceil(y1), 341, 0.012);
    },
    poses: {
      // crouches, gathers, rears, throws itself, lands in a heap
      aim0: { f: [{ y: 0, z: 8 }, { y: 0, z: 7 }, { y: 0, z: -7 }, { y: 0, z: -9 }], pitch: -0.12, rise: -3.5, hu: -1.2, hf: 1, jaw: 0.5 },
      aim1: { f: [{ y: 17, z: 6 }, { y: 15, z: 4 }, { y: 0, z: -6 }, { y: 0, z: -9 }], pitch: 1.02, rise: -1, hu: 1, jaw: 0.7 },
      fire0: { f: [{ y: 21, z: 13 }, { y: 19, z: 11 }, { y: 0, z: -7 }, { y: 0, z: -10 }], pitch: 1.16, rise: -1, hu: 2.5, hf: 2, jaw: 1.0 },
      fire1: { f: [{ y: 9, z: 17 }, { y: 8, z: 15 }, { y: 2, z: -13 }, { y: 1, z: -15 }], pitch: 0.28, rise: 3.5, hu: 1, hf: 3, jaw: 1.0 },
      recover: { f: [{ y: 0, z: 11 }, { y: 0, z: 9 }, { y: 0, z: -9 }, { y: 0, z: -11 }], pitch: -0.05, rise: -2.5, hu: -0.5, jaw: 0.6 },
      pain0: { f: [{ y: 8, z: 4 }, { y: 6, z: 2 }, { y: 0, z: -9, x: 3 }, { y: 0, z: -12, x: 3 }], pitch: 0.62, rise: -3, hu: 1.5, jaw: 0.85 },
      pain1: { f: [{ y: 0, z: 9, x: -2 }, { y: 3, z: 6, x: 3 }, { y: 0, z: -10, x: -2 }, { y: 0, z: -12, x: 2 }], pitch: -0.15, rise: -4, hu: -2, hf: -1, jaw: 0.95 },
    },
    dieRot: -0.55,
    dieKey(t) {
      return {
        f: [{ y: lerp(9, 0, t), z: lerp(6, 11, t), x: lerp(0, 5, t) },
          { y: lerp(7, 0, t), z: lerp(3, 9, t), x: lerp(0, 6, t) },
          { y: 0, z: lerp(-9, -13, t), x: lerp(0, 5, t) },
          { y: 0, z: lerp(-12, -15, t), x: lerp(0, 6, t) }],
        pitch: lerp(0.5, -0.16, t), rise: lerp(-2, -20, Math.pow(t, 1.2)),
        hu: lerp(2, -4, t), hf: lerp(0, 3, t), jaw: lerp(0.9, 0.55, t),
      };
    },
    deadKey: {
      f: [{ y: 0, z: 12, x: 8 }, { y: 0, z: 8, x: 9 }, { y: 0, z: -13, x: 7 }, { y: 0, z: -15, x: 8 }],
      pitch: -0.12, rise: -24, hu: -4, hf: 2, jaw: 0.7,
    },
    head(f, c) {
      const { hd, theta, R: RM, pose, E, k } = c;
      const fw = Math.cos(theta), sd = Math.sin(theta);
      const jaw = pose.jaw === undefined ? 0.3 : pose.jaw;
      const g = pen(f, hd.x, hd.y, k, 1, c.rot || 0, c.sy || 1);
      const dead = pose.dead || pose.severed;
      // cranium: smooth swollen brow, no eyes at all, veins crawling over it
      g.blob(sd * 1.2, -1.6, 7.2, 6.2, RM.skull, { grain: 0.05, seed: 350, ...E, spec: WETC, specT: 0.975 });
      g.blob(sd * 1.6, -3.6, 6.4, 4.2, RM.skull, { shift: 1, grain: 0.04, seed: 351 });
      for (let i = 0; i < 3; i++) vein(f, g.X(-4 + i * 3), g.Y(-6.5), 1.2 + i * 0.3, 7, k, RM.bruise[1], 352 + i);
      // stringy leftover hair
      for (let i = 0; i < 5; i++) g.line(-3 + i * 1.5, -7.2, -3.6 + i * 1.5 + sd, -3.8 + (i % 2), rgba(44, 40, 30, 255));
      // the hardhat: dented, three sizes too small now, still on
      g.blob(sd * 2.4 + 1.2, -7.8, 3.4, 2.2, RR.hat, { ...E, spec: rgba(255, 250, 220, 255) });
      g.cap(sd * 2.4 - 2.6, -6.6, sd * 2.4 + 5.0, -7.4, 0.7, 0.6, RR.hat, { shift: -1 });
      g.over(sd * 2.4 + 2, -8.6, RR.hat[0], 0.7);
      if (fw > 0.3) {
        // shallow dimples where the eyes were
        g.blob(-2.8, -0.6, 1.6, 1.2, RM.skull, { shift: -1 });
        g.blob(2.8, -0.6, 1.6, 1.2, RM.skull, { shift: -1 });
        g.over(-2.8, -1.2, INK, 0.35);
        g.over(2.8, -1.2, INK, 0.35);
        // unhinged jaw, far too wide, three rows of needles, and the tongue
        const ry = (3.0 + jaw * 6.0) * k;
        gape(f, hd.x, hd.y + (4.2 + jaw * 2.4) * k, 8.6 * k, ry, { rows: 3, n: 10, seed: 7, ink: RR.ink, arc: 1.2 * k });
        g.cap(-8.0, 2.2, -6.2, 6.0 + jaw * 3, 1.6, 1.2, RM.skull, { shift: -1 });
        g.cap(8.0, 2.2, 6.2, 6.0 + jaw * 3, 1.6, 1.2, RM.skull, { shift: -1 });
        if (jaw > 0.35 || dead) tongue(f, g.X(1), g.Y(5 + jaw * 3), g.X(4.5), g.Y(10 + jaw * 5), 1.3 * k, 355);
        // drool ropes off the lower jaw
        for (let i = 0; i < 3; i++) drip(f, Math.round(g.X(-5 + i * 4)), Math.round(g.Y(6 + jaw * 7)), Math.round((2 + i) * k), mix(WETC, ROT.glow, 0.3), 0.8);
      } else if (Math.abs(sd) > 0.5) {
        const s2 = sd > 0 ? -1 : 1;
        g.blob(s2 * 3.4, -0.4, 4.6, 4.6, RM.skull, { grain: 0.04, seed: 352 });
        g.over(s2 * 4.6, -1.0, INK, 0.35);
        const jx = hd.x + s2 * 3.0 * k, jy = hd.y + (3.6 + jaw * 2.0) * k;
        gape(f, jx, jy, 6.2 * k, (2.2 + jaw * 4.4) * k, { rows: 2, n: 8, seed: 9, ink: RR.ink });
        capsule(f, hd.x - s2 * 2.4 * k, hd.y + 1.4 * k, jx + s2 * 4.6 * k, jy + (1.4 + jaw * 2) * k, 1.7 * k, 1.2 * k, RM.skull, { shift: -1 });
        if (jaw > 0.35) tongue(f, jx + s2 * 2 * k, jy + k, jx + s2 * 6 * k, jy + 6 * k, 1.2 * k, 356);
      } else {
        g.blob(0, 0.4, 6.0, 5.4, RM.skull, { grain: 0.05, seed: 353 });
        for (let i = 0; i < 4; i++) g.cap(-3 + i * 2, 3.6, -3 + i * 2, 7.4, 1.1, 0.9, RR.fleshD, { shift: i % 2 ? 0 : -1 });
        g.over(0, -4.6, RM.skull[4], 0.6);
      }
    },
  };
}

/** Stalker - the fast one. Chitin, blade forelimbs, a bear trap for a head, a sting. */
function makeStalker() {
  const chit = mat(rgba(84, 78, 88, 255), { contrast: 1.45 });
  const R = {
    body: chit, limbF: mat(rgba(66, 62, 72, 255), { contrast: 1.45 }),
    limbR: mat(rgba(74, 70, 80, 255), { contrast: 1.45 }),
    plate: mat(rgba(106, 98, 108, 255), { contrast: 1.45 }),
    sinew: RR.muscle, bone: RR.bone,
  };
  return {
    id: 'stalker', w: 52, h: 60, k: K,
    hipY: 27, shoulderY: 20.5, bodyLen: 21, shoulderT: 0.84, hipT: 0.16,
    body: [[0, 8.6, 7.2], [0.3, 9.4, 7.8], [0.66, 7.2, 6.4], [1, 5.0, 4.4]],
    bodySlices: 12,
    legHalfF: 6.0, legHalfR: 7.0, footHalfF: 6.6, footHalfR: 7.6, ankleY: 2.0,
    humerus: 12.5, radius: 12, femur: 14.5, tibia: 12.5, hockH: 5.4, hockZ: 5.8,
    armThick: 2.4, legThick: 3.4,
    neckSegs: 4, neckR0: 3.0, neckR1: 3.2, headUp: -2.8, headFwd: 6.6,
    edge: rgba(12, 11, 15, 255), ramps: R,
    // a rotary gallop: the hind pair drive, the spine flexes and stretches,
    // the front pair strike, and it is never more than a paw on the floor
    qgait: {
      offs: [0.62, 0.5, 0.12, 0.0], duty: 0.44, freq: 1,
      zF: 9, zR: -9, strideF: 5.5, strideR: 5.2, liftF: 7, liftR: 5,
      rise: 2.4, risePh: -0.6, pitch: 0.18, pitchPh: 0.9, hu: 0.9, hf: 1.2, jaw: 0.2, jawAmp: 0.35,
    },
    paw(f, c) {
      const { p, prev, side, front, sft, E, k } = c;
      if (front) {
        // scythe blade instead of a paw, with a serrated back edge
        const dx = p.x - prev.x, dy = p.y - prev.y;
        const L = Math.hypot(dx, dy) || 1;
        const ux = dx / L, uy = dy / L, nx2 = -uy, ny2 = ux;
        const tipx = p.x + (ux * 8.5 + nx2 * side * 3.0) * k;
        const tipy = p.y + (uy * 8.5 + ny2 * side * 3.0) * k;
        fillPoly(f, [
          { x: p.x - nx2 * 2.4 * k, y: p.y - ny2 * 2.4 * k },
          { x: p.x + nx2 * 2.4 * k, y: p.y + ny2 * 2.4 * k },
          { x: tipx, y: tipy },
        ], RR.bone[sft ? 1 : 2]);
        line(f, Math.round(p.x - nx2 * 2.4 * k), Math.round(p.y - ny2 * 2.4 * k), Math.round(tipx), Math.round(tipy), RR.bone[4]);
        line(f, Math.round(p.x + nx2 * 2.4 * k), Math.round(p.y + ny2 * 2.4 * k), Math.round(tipx), Math.round(tipy), RR.claw[0]);
        for (let i = 1; i < 4; i++) {
          const q = i / 4;
          px(f, Math.round(lerp(p.x + nx2 * 2.4 * k, tipx, q) + nx2 * k), Math.round(lerp(p.y + ny2 * 2.4 * k, tipy, q) + ny2 * k), RR.bone[1]);
        }
        blob(f, p.x, p.y, 2.0 * k, 1.8 * k, c.R.plate, { shift: sft, ...E, spec: c.R.plate[4] });
      } else {
        blob(f, p.x, p.y - 0.4 * k, 2.6 * k, 1.8 * k, c.R.limbR, { shift: sft, ...E });
        for (let i = -1; i <= 1; i++) {
          capsule(f, p.x + i * 1.4 * k, p.y + 0.6 * k, p.x + i * 2.4 * k, p.y + 2.2 * k, 0.9 * k, 0.5 * k, RR.claw, { shift: sft });
        }
      }
    },
    hide(f, c) {
      const { P, spine, theta, ch, R: RM, x0, y0, x1, y1, k } = c;
      const fw = Math.cos(theta), sd = Math.sin(theta);
      // segmented chitin plates over the spine, each with a spike
      for (let i = 0; i <= 7; i++) {
        const t = 0.1 + i * 0.115;
        const s2 = P(spine(t));
        const pr = profileAt(ch.body, t);
        const rw = Math.sqrt(Math.pow(pr.w * fw, 2) + Math.pow(2.0 * sd, 2)) * k;
        blob(f, s2.x, s2.y - pr.d * k * 0.55, rw * 0.88, 2.0 * k, RM.plate, { mode: 'cyl', nyBias: -0.5, grain: 0.05, seed: 360 + i, spec: RM.plate[4], specT: 0.95 });
        for (let q = -1; q <= 1; q += 2) {
          const sx = s2.x + q * rw * 0.8;
          capsule(f, sx, s2.y - pr.d * k * 0.5, sx + q * 2.2 * k, s2.y - pr.d * k * 0.5 - 3.0 * k, 1.2 * k, 0.5 * k, RM.plate, { shift: q > 0 ? 0 : -1 });
        }
        capsule(f, s2.x, s2.y - pr.d * k * 0.9, s2.x - sd * k, s2.y - pr.d * k * 0.9 - (2 + (i % 2)) * k, 0.9 * k, 0.3 * k, RR.bone, { shift: 0 });
      }
      // sinew showing in the flank gaps
      for (let i = 0; i < 5; i++) {
        const t = 0.22 + i * 0.13;
        const s2 = P(spine(t));
        const pr = profileAt(ch.body, t);
        for (let y = -k; y <= 2 * k; y++) {
          for (let x = -2 * k; x <= 2 * k; x++) {
            if (hash2(s2.x + x, s2.y + y, 370 + i) > 0.4) continue;
            over(f, s2.x + x, s2.y + y + pr.d * k * 0.15, RM.sinew[1], 0.5);
          }
        }
      }
      wetness(f, Math.floor(x0), Math.floor(y0), Math.ceil(x1), Math.ceil(y1), 371, 0.010);
    },
    gear(c) {
      // a segmented sting curling up over the hips
      const { f, add, P, spine, k, E } = c;
      const base = spine(0);
      const z0 = P(base).z;
      add(z0 - 0.3, () => {
        let prev = null;
        for (let i = 0; i <= 8; i++) {
          const t = i / 8;
          const p = P(vadd(base, V(0, 1.5 + Math.sin(t * 2.6) * 11, -2 - Math.cos(t * 2.4) * 7 + t * 4)));
          const r = lerp(2.6, 1.2, t) * k;
          blob(f, p.x, p.y, r, r * 0.9, c.R.plate, { shift: i % 2 ? 0 : 1, ...E });
          prev = p;
        }
        const tp = prev;
        capsule(f, tp.x, tp.y, tp.x + 2.6 * k, tp.y + 2.4 * k, 1.1 * k, 0.3 * k, RR.bone, { ...E, shift: 1 });
        glow(f, tp.x + 2.6 * k, tp.y + 2.4 * k, 1.8 * k, ROT.glow, { halo: 0.4, seed: 374, base: rgba(16, 34, 20, 255) });
      });
    },
    poses: {
      // low, lower, coiled, then the spring and the scythes coming down
      aim0: { f: [{ y: 0, z: 9 }, { y: 0, z: 7 }, { y: 0, z: -9 }, { y: 0, z: -11 }], pitch: -0.1, rise: -1.5, hu: -0.8, hf: 1, jaw: 0.4, eye: 1 },
      aim1: { f: [{ y: 0, z: 8 }, { y: 0, z: 6 }, { y: 0, z: -10 }, { y: 0, z: -12 }], pitch: -0.2, rise: -3.5, hu: -1.5, hf: 2, jaw: 0.6, eye: 1 },
      fire0: { f: [{ y: 9, z: 15, x: 4 }, { y: 8, z: 13, x: 4 }, { y: 0, z: -9 }, { y: 1, z: -12 }], pitch: 0.3, rise: 2.5, hu: 1.5, hf: 4, jaw: 1.0, eye: 1 },
      fire1: { f: [{ y: 2, z: 16, x: 1 }, { y: 5, z: 12, x: 5 }, { y: 3, z: -12 }, { y: 4, z: -14 }], pitch: -0.05, rise: 3, hu: 0, hf: 5, jaw: 1.0, eye: 1 },
      recover: { f: [{ y: 0, z: 10 }, { y: 0, z: 8 }, { y: 0, z: -10 }, { y: 0, z: -12 }], pitch: 0.05, rise: -1, hu: 0.3, jaw: 0.5, eye: 0.8 },
      pain0: { f: [{ y: 5, z: 4, x: 4 }, { y: 4, z: 2, x: 4 }, { y: 0, z: -11, x: 3 }, { y: 0, z: -13, x: 3 }], pitch: -0.34, rise: -2, hu: 2, jaw: 0.85, eye: 1 },
      pain1: { f: [{ y: 6, z: 7, x: -3 }, { y: 0, z: 9, x: 4 }, { y: 0, z: -12, x: -2 }, { y: 2, z: -11, x: 3 }], pitch: 0.2, rise: -2.5, hu: 2.5, hf: -1, jaw: 0.9, eye: 1 },
    },
    dieRot: -0.62,
    dieKey(t) {
      return {
        f: [{ y: lerp(6, 0, t), z: lerp(9, 12, t), x: lerp(2, 8, t) },
          { y: lerp(4, 0, t), z: lerp(7, 10, t), x: lerp(2, 9, t) },
          { y: 0, z: lerp(-10, -13, t), x: lerp(0, 7, t) },
          { y: 0, z: lerp(-12, -15, t), x: lerp(0, 8, t) }],
        pitch: lerp(-0.3, 0.1, t), rise: lerp(-1, -17, Math.pow(t, 1.15)),
        hu: lerp(2, -3, t), jaw: lerp(1, 0.5, t), eye: Math.max(0, 1 - t * 1.4),
      };
    },
    deadKey: {
      f: [{ y: 0, z: 12, x: 9 }, { y: 0, z: 9, x: 10 }, { y: 0, z: -12, x: 8 }, { y: 0, z: -14, x: 9 }],
      pitch: 0.06, rise: -19, hu: -3, jaw: 0.45, eye: 0,
    },
    head(f, c) {
      const { hd, theta, R: RM, pose, E, k } = c;
      const fw = Math.cos(theta), sd = Math.sin(theta);
      const jaw = pose.jaw === undefined ? 0.3 : pose.jaw;
      const gl = pose.eye === undefined ? 0.7 : pose.eye;
      const g = pen(f, hd.x, hd.y, k, 1, c.rot || 0, c.sy || 1);
      // low wedge skull with horns swept back
      g.blob(sd * 1.0, -1.0, 6.6, 4.6, RM.plate, { grain: 0.05, seed: 380, ...E, spec: RM.plate[4], specT: 0.95 });
      g.blob(sd * 2.0, -3.0, 5.0, 2.6, RM.plate, { shift: 1, seed: 381 });
      for (const s of [-1, 1]) g.cap(s * 4.4 - sd * 2, -3.4, s * 6.8 - sd * 4, -7.4, 1.3, 0.4, RR.bone, { ...E, shift: s > 0 ? 0 : -1 });
      if (fw > 0.3) {
        // one huge milky eye
        g.blob(0, -2.2, 3.4, 2.8, RR.maw, { shift: 0 });
        g.blob(0, -2.2, 2.4, 2.0, flat(mix(rgba(198, 226, 190, 255), ROT.glow, 0.45 * gl)));
        g.blob(0.6, -1.8, 1.0, 0.9, flat(rgba(40, 70, 44, 255)));
        if (gl > 0.05) glow(f, hd.x, hd.y - 2.2 * k, 6.5 * k, ROT.glow, { halo: 0.35 * gl, tint: 0.3, seed: 382, base: rgba(16, 34, 20, 255), core: 0.8 });
        g.dot(-1.4, -3.2, rgba(250, 255, 246, 255));
        // bear trap: no lips, permanent grin, interlocking fangs
        const my = hd.y + (2.6 + jaw * 2.2) * k;
        const rx = 7.4 * k;
        blob(f, hd.x, my, rx, (1.4 + jaw * 4.0) * k, RR.maw, { edge: RR.ink, edgeW: 0.9 });
        fangRow(f, hd.x - rx, my - (0.4 + jaw * 3.4) * k, hd.x + rx, my - (0.4 + jaw * 3.4) * k, 9, (3.4 + jaw * 2) * k, 0, 1, { seed: 3, arc: 1.6 * k });
        fangRow(f, hd.x - rx + 0.7 * k, my + (0.4 + jaw * 3.4) * k, hd.x + rx + 0.7 * k, my + (0.4 + jaw * 3.4) * k, 9, (3.4 + jaw * 2) * k, 0, -1, { seed: 8, arc: 1.2 * k });
        capsule(f, hd.x - rx - 0.6 * k, my - k, hd.x + rx + 0.6 * k, my - k, 1.1 * k, 1.1 * k, RM.plate, { shift: 1 });
        for (let i = 0; i < 2; i++) drip(f, Math.round(hd.x + (-3 + i * 6) * k), Math.round(my + (1.6 + jaw * 4) * k), Math.round((2 + i * 2) * k), mix(WETC, ROT.glow, 0.25), 0.8);
      } else if (Math.abs(sd) > 0.5) {
        const s2 = sd > 0 ? -1 : 1;
        g.blob(s2 * 3.0, -1.6, 4.2, 3.4, RM.plate, { grain: 0.04, seed: 383 });
        g.blob(s2 * 1.6, -2.4, 2.2, 1.9, flat(mix(rgba(198, 226, 190, 255), ROT.glow, 0.45 * gl)));
        if (gl > 0.05) glow(f, hd.x + s2 * 1.6 * k, hd.y - 2.4 * k, 5 * k, ROT.glow, { halo: 0.3 * gl, tint: 0.3, seed: 384, base: rgba(16, 34, 20, 255), core: 0.8 });
        const my = hd.y + (2.2 + jaw * 1.6) * k;
        blob(f, hd.x + s2 * 2.2 * k, my, 5.6 * k, (1.2 + jaw * 3.0) * k, RR.maw, { edge: RR.ink, edgeW: 0.9 });
        fangRow(f, hd.x + s2 * 7.6 * k, my - (0.4 + jaw * 2.6) * k, hd.x - s2 * 3.2 * k, my - (0.4 + jaw * 2.6) * k, 7, (3.0 + jaw * 1.6) * k, 0, 1, { seed: 4 });
        fangRow(f, hd.x + s2 * 7.6 * k, my + (0.4 + jaw * 2.6) * k, hd.x - s2 * 3.2 * k, my + (0.4 + jaw * 2.6) * k, 7, (2.8 + jaw * 1.6) * k, 0, -1, { seed: 6 });
      } else {
        g.blob(0, -1.0, 5.4, 4.2, RM.plate, { grain: 0.05, seed: 385 });
        for (let i = -1; i <= 1; i += 2) g.cap(i * 2, -3.4, i * 4.4, -6.4, 1.3, 0.6, RM.plate, { shift: i > 0 ? 0 : -1 });
        g.over(0, -2.6, RM.plate[4], 0.5);
      }
    },
  };
}

/** Build a quadruped pose from an explicit keyframe (same notation as `gait`). */
function quadKey(ch, kf, xform) {
  const feet = [];
  for (let i = 0; i < 4; i++) {
    const front = i < 2, side = (i % 2) ? -1 : 1;
    const g = kf.f[i];
    feet.push(V(side * (front ? ch.footHalfF : ch.footHalfR) + (g.x || 0) * side, ch.ankleY + g.y, g.z));
  }
  return {
    feet, pitch: kf.pitch || 0, rise: kf.rise || 0,
    headUp: kf.hu || 0, headFwd: kf.hf || 0,
    jaw: kf.jaw === undefined ? 0.3 : kf.jaw,
    eye: kf.eye, phase: 0, xform: xform || null, extra: kf.extra,
  };
}

/** Standing on all fours and breathing: b 0 out, 1 in. */
function quadStand(ch, b) {
  const g = ch.qgait;
  const zF = g.zF, zR = g.zR;
  return quadKey(ch, {
    f: [{ y: 0, z: zF + 1 }, { y: 0, z: zF - 1 }, { y: 0, z: zR + 1 }, { y: 0, z: zR - 1 }],
    rise: b ? 0.7 : -0.3, pitch: b ? 0.04 : 0, hu: b ? 0.9 : -0.3, jaw: b ? 0.45 : 0.22, eye: 0.7,
  });
}

/** Full set for a quadruped mutant, matching the humanoid key pattern. */
function paintQuadSet(out, ch, recipes, rig) {
  const id = ch.id, k = ch.k || K;
  const W = Math.round(ch.w * k), H = Math.round(ch.h * k);
  const WA = Math.round(ch.w * 1.4 * k), WD = Math.round(ch.w * 1.3 * k);
  const ink = ch.edge;
  for (let D = 0; D < 4; D++) {
    for (let F = 0; F < WALK_N; F++) {
      register(out, recipes, `${id}_walk${D}_${F}`, W, H, (f, mask) => {
        quadruped(f, ch, quadPose(ch, F), D, mask);
        finishEnemy(f, { ink });
      });
    }
    for (let F = 0; F < 2; F++) {
      register(out, recipes, `${id}_idle${D}_${F}`, W, H, (f, mask) => {
        quadruped(f, ch, quadStand(ch, F), D, mask);
        finishEnemy(f, { ink });
      });
    }
  }
  for (const mode of ATTACK) {
    register(out, recipes, `${id}_${mode}`, WA, H, (f, mask) => {
      quadruped(f, ch, quadKey(ch, ch.poses[mode]), 0, mask);
      finishEnemy(f, { ink });
    });
  }
  for (let v = 0; v < 2; v++) {
    register(out, recipes, `${id}_pain${v}`, W, H, (f, mask) => {
      const b = quadruped(f, ch, quadKey(ch, ch.poses[`pain${v}`]), 0, mask);
      spurt(f, b.body.x + (v ? 3 : -2) * k, b.body.y - (v ? 1 : 3) * k, v ? 1 : -0.7, -1, 11 * k, k, 0x3b1 + v * 53 + id.length, MUTANT_BLOOD);
      finishEnemy(f, { flash: 0.12, ink });
    });
  }
  for (let kk = 0; kk < DIE_N; kk++) {
    const t = DIE_T[kk];
    register(out, recipes, `${id}_die${kk}`, WD, H, (f, mask) => {
      const key = ch.dieKey(t);
      // the hit knocks it back, it goes over, lands hard and bounces once
      const rot = lerp(0, ch.dieRot === undefined ? -0.85 : ch.dieRot, Math.pow(Math.min(1, t / 0.84), 0.85)) * (kk === 5 ? 0.9 : 1);
      if (kk === 5) key.rise += 3;
      if (kk >= 3) gorePool(f, WD / 2 + (kk - 3) * k, H - 3 * k, (8 + kk * 3.5) * k, (2.4 + kk * 0.6) * k, 0x5100 + kk * 91, { spots: 6 + kk * 4, ...MUTANT_POOL });
      const pose = quadKey(ch, key, { px: WD / 2 - 2 * k, py: H - 1, rot, dx: lerp(0, -2, t), dy: lerp(0, 1.5, t) });
      pose.dead = t > 0.9 ? 1 : 0;
      const b = quadruped(f, ch, pose, 0, mask);
      if (kk === 0) {
        wash(f, rgba(228, 70, 58, 255), 0.16);
        spurt(f, b.body.x, b.body.y - 2 * k, -0.5, -1, 14 * k, k, 0x61e + id.length, MUTANT_BLOOD);
      }
      if (kk >= 1 && kk <= 3) bloodArc(f, WD / 2, H - 14 * k, kk, k, 0x61 + kk, MUTANT_BLOOD);
      if (kk === 4) splash(f, WD / 2, H - 2 * k, 18 * k, k, 0x62 + id.length, MUTANT_BLOOD);
      finishEnemy(f, { ink });
    });
  }
  register(out, recipes, `${id}_dead`, WD, H, (f, mask) => {
    gorePool(f, WD / 2, H - 4 * k, ch.w * 0.42 * k, 5.5 * k, 0x9911 + ch.w, { spots: 22, ...MUTANT_POOL });
    const pose = quadKey(ch, ch.deadKey);
    pose.dead = 1;
    const b = quadruped(f, ch, pose, 0, mask);
    // opened up on the way down: a loop of gut out of the belly
    sausages(f, b.body.x - 6 * k, b.body.y + 2 * k, b.body.x + 7 * k, H - 3 * k, 4, 1.4 * k, 0x3c + id.length);
    wash(f, rgba(52, 18, 24, 255), 0.18, (x, y) => y > H - 9 * k);
    finishEnemy(f, { ink });
  });
  rig[id] = {
    hip: ch.hipY / ch.h, shoulder: ch.shoulderY / ch.h,
    neck: ch.shoulderY / ch.h, head: clamp((ch.shoulderY + ch.headUp) / ch.h, 0, 1),
  };
  paintQuadParts(out, ch);
}

/** Head, front leg ("arm") and hind leg for a quadruped. */
function paintQuadParts(out, ch) {
  const id = ch.id, R = ch.ramps;
  const k2 = (ch.k || K) * 2;
  const S2 = Math.round(48 * k2);
  const E = { edge: ch.edge, edgeW: 1.8 };
  const c0 = S2 / 2;
  paintPart(out, `${id}_part_head`, S2, (f) => {
    const nr = ch.neckR1 * k2;
    stump(f, c0 + 5 * k2, c0 + 1 * k2, 1, 0.2, nr, R.limbF, { len: 3 * k2, seed: 17, flat: 0.6, bone: 0.42, drips: 3, fringe: false });
    ch.head(f, { f, ch, hd: { x: c0, y: c0, z: 0 }, theta: 0, D: 0, R, k: k2, E, mask: 0, pose: { severed: 1, jaw: 0.8, eye: 0 } });
  }, { ink: ch.edge });
  for (const front of [true, false]) {
    paintPart(out, `${id}_part_${front ? 'arm' : 'leg'}`, S2, (f) => {
      const fold = front ? 0.92 : 0.72;
      const l1 = (front ? ch.humerus : ch.femur) * fold, l2 = (front ? ch.radius : ch.tibia) * fold;
      const tot = l1 + l2 + (front ? 0 : ch.hockH);
      const y0 = c0 - tot / 2 * k2;
      const a = { x: c0 - 0.5 * k2, y: y0 };
      const b = { x: c0 + (front ? -1.5 : 5) * k2, y: y0 + l1 * k2 };
      const cc = { x: c0 + (front ? 0.5 : -3) * k2, y: y0 + (l1 + l2) * k2 };
      const d = front ? cc : { x: c0 + 0.5 * k2, y: y0 + tot * k2 };
      const L = { front, side: 1 };
      paintQuadLeg({ f, ch, R, k: k2, E, theta: 0 }, L, a, b, cc, d, 0);
      const tk = (front ? ch.armThick : ch.legThick) * k2;
      stump(f, a.x, a.y, a.x - b.x, a.y - b.y, tk * 1.2, front ? R.limbF : R.limbR, { len: 0, seed: 19, drips: 0, fringe: false });
    }, { ink: ch.edge });
  }
}

/** Gorger - an obese translucent sac with something boiling inside it. */
function makeGorger() {
  const hide = mix(ROT.sick, rgba(186, 168, 104, 255), 0.3);
  const R = {
    torso: mat(hide, { contrast: 1.4 }),
    sleeve: mat(mix(shade(hide, 0.8), ROT.bruise, 0.15), { contrast: 1.4 }),
    trouser: mat(mix(shade(hide, 0.66), ROT.bruise, 0.4), { contrast: 1.35 }),
    boot: mat(rgba(52, 40, 44, 255)), sole: flat(rgba(30, 24, 26, 255)),
    glove: mat(mix(ROT.muscle, ROT.flesh, 0.4), { contrast: 1.2 }),
    head: mat(mix(hide, ROT.bruise, 0.3), { contrast: 1.4 }),
    neck: mat(hide, { contrast: 1.4 }),
    muscle: RR.muscle, bone: RR.bone, bruise: RR.bruise,
  };
  const baseProfile = [[0, 17.0, 14.5], [0.3, 21.5, 18.0], [0.62, 20.5, 17.0], [0.85, 16.0, 13.5], [1, 12.5, 10.5]];
  return {
    id: 'gorger', w: 76, h: 74, dieW: 116, k: K, blood: MUTANT_BLOOD, pool: MUTANT_POOL,
    hipY: 23, shoulderY: 45, neckY: 47, headY: 51, neckZ: 2.0, headZ: 5.0,
    shoulderHalf: 13, legHalf: 8.5, ankleY: 4.4, footLen: 5.6,
    thigh: 11.5, shin: 10.5, upper: 9.5, fore: 9,
    armThick: 4.2, legThick: 6.2, stride: 5, lift: 3.0, hipDip: 1.8, lean: 0.04,
    // a waddle: side to side more than forward, everything wobbling after it
    gait: { duty: 0.62, sway: 2.6, tilt: 0.13, twist: 0.04, bob: 0.7, wide: 1.05, strike: 0.1, push: 0.2 },
    slices: 20, edge: rgba(24, 22, 18, 255), lieH: 24, neckR: 4.5,
    profile: baseProfile, baseProfile, ramps: R,
    swell(t) {
      this.profile = baseProfile.map(([a, w, d]) => [a, w * (1 + t * 0.30), d * (1 + t * 0.26)]);
    },
    torsoDetail(c) {
      // boils and weeping sores all over the upper sac, where the belly patch is not
      const a = torsoAt(c, c.ch.shoulderY - 1), b = torsoAt(c, c.ch.hipY + 3);
      sores(c.f, Math.min(a.x - a.rx, b.x - b.rx), a.y, Math.max(a.x + a.rx, b.x + b.rx), b.y, 12, c.k, 405);
    },
    head(f, c) {
      const { hd, theta, R: RM, pose, ch, k } = c;
      const fw = Math.cos(theta), sd = Math.sin(theta);
      const E = c.E || { edge: ch.edge, edgeW: 0.9 };
      const funnel = pose.funnel || 0;
      const g = pen(f, hd.x, hd.y, k, 1, c.rot || 0, c.sy || 1);
      // vestigial head sunk into shoulder meat, a few rolls of chins under it
      g.blob(sd * 1.2, 1.0, 6.4, 5.4, RM.head, { grain: 0.06, seed: 400, ...E, spec: WETC, specT: 0.975 });
      g.blob(0, 4.6, 8.4, 4.0, RM.torso, { grain: 0.06, seed: 401 });
      g.blob(0, 6.6, 7.2, 2.4, RM.torso, { shift: -1 });
      if (fw > 0.3) {
        if (funnel > 0.25) {
          // lamprey funnel: concentric rings of fangs around a wet throat
          const rr = (3.0 + funnel * 4.6) * k;
          const cy2 = hd.y + 0.6 * k;
          blob(f, hd.x, cy2, rr + 1.6 * k, rr + 1.4 * k, RR.gum, { shift: 0, edge: RR.ink, edgeW: 0.9 });
          blob(f, hd.x, cy2, rr, rr * 0.94, RR.maw, {});
          for (let ring = 0; ring < 3; ring++) {
            const rad = rr * (1 - ring * 0.27);
            const n = 12 - ring * 2;
            for (let i = 0; i < n; i++) {
              const a = i * 6.283 / n + ring * 0.26;
              const bx = hd.x + Math.cos(a) * rad, by = cy2 + Math.sin(a) * rad * 0.94;
              const tx = hd.x + Math.cos(a) * rad * 0.42, ty = cy2 + Math.sin(a) * rad * 0.40;
              const w = 0.85 * k;
              fillPoly(f, [
                { x: bx + Math.cos(a + 1.3) * w, y: by + Math.sin(a + 1.3) * w },
                { x: bx - Math.cos(a + 1.3) * w, y: by - Math.sin(a + 1.3) * w },
                { x: tx, y: ty }], RR.fang[(i + ring) % 3 ? 3 : 2]);
              line(f, Math.round(bx + Math.cos(a + 1.3) * w * 1.5), Math.round(by + Math.sin(a + 1.3) * w * 1.5), Math.round(tx), Math.round(ty), RR.fang[4]);
            }
          }
          blob(f, hd.x, cy2, rr * 0.42, rr * 0.40, flat(rgba(16, 6, 10, 255)));
          glow(f, hd.x, cy2, rr * 0.9, ROT.glow, { halo: 0, tint: 0.3, seed: 402 });
        } else {
          // shut: a wet vertical slit with a couple of teeth showing, and a lip
          g.cap(0, -2.4, 0, 3.6, 1.6, 1.4, RR.gum, { shift: 0 });
          g.cap(0, -2.0, 0, 3.2, 0.8, 0.7, RR.maw, {});
          for (let i = 0; i < 4; i++) {
            g.dot(-0.7, -1.6 + i * 1.6, RR.fang[3]);
            g.dot(0.7, -0.8 + i * 1.6, RR.fang[2]);
          }
          drip(f, Math.round(hd.x), Math.round(hd.y + 4 * k), Math.round(3 * k), mix(WETC, ROT.glow, 0.3), 0.8);
        }
        if (pose.chomp) {
          // snapped shut on something, and not all of it made it in
          for (let i = 0; i < 9; i++) {
            const a = hash2(i, 4, 403) * TAU, r = (4 + hash2(i, 5, 403) * 6) * k;
            const bx = hd.x + Math.cos(a) * r, by = hd.y + 1.5 * k + Math.sin(a) * r * 0.6;
            blob(f, bx, by, (0.7 + hash2(i, 6, 403)) * k, 0.8 * k, i % 3 ? RR.muscle : GORE.meat, { spec: WETC, specT: 0.9 });
          }
          for (let i = 0; i < 3; i++) drip(f, Math.round(hd.x + (i - 1) * 1.6 * k), Math.round(hd.y + 3.5 * k), Math.round((3 + i) * k), GORE.blood, 1.0);
        }
        // piggy little eyes buried in the fat
        for (const ex of [-4.4, 4.4]) {
          g.blob(ex, -2.6, 1.4, 1.1, RR.maw, { shift: 1 });
          g.blob(ex, -2.7, 0.8, 0.6, flat(rgba(222, 236, 200, 255)));
          g.dot(ex + 0.3, -2.6, rgba(20, 20, 20, 255));
        }
        g.over(-4.4, -4.2, RM.head[0], 0.6); g.over(4.4, -4.2, RM.head[0], 0.6);
      } else if (Math.abs(sd) > 0.5) {
        const s2 = sd > 0 ? -1 : 1;
        g.cap(s2 * 4.6, -2.0, s2 * 4.6, 3.0, 1.4, 1.2, RR.gum, { shift: 0 });
        g.blob(s2 * 3.0, -2.6, 1.2, 1.0, RR.maw, { shift: 1 });
      } else {
        for (let i = 0; i < 4; i++) g.over(-3 + i * 2, 0.5, RM.head[0], 0.5);
        g.blob(0, -1, 2.0, 1.4, RR.bruise, { shift: -1 });
      }
      // folds of neck fat
      for (let i = 0; i < 3; i++) {
        for (let x = -8; x <= 8; x += 0.5) g.over(x, 5.5 + i * 2.2, RM.torso[0], 0.4);
      }
    },
    gear(c) {
      const { f, add, P, R: RM, ch, pose, theta, k } = c;
      const fw = Math.cos(theta);
      const burst = pose.burst || 0;
      const near = fw >= 0 ? 12 : -12;
      const bz = P(c.U(0, ch.hipY + 9, near));
      add(bz.z + (fw >= 0 ? 0.8 : -0.8), () => {
        const pr = profileAt(ch.profile, 0.35);
        const rw = Math.sqrt(Math.pow(pr.w * fw, 2) + Math.pow(pr.d * Math.sin(theta), 2)) * k;
        const hh = 14 * k;
        // translucent belly: something luminous is boiling in there
        const cyb = bz.y - 2 * k;
        for (let y = Math.floor(cyb - hh - k); y <= Math.ceil(cyb + hh + k); y++) {
          for (let x = Math.floor(bz.x - rw); x <= Math.ceil(bz.x + rw); x++) {
            const u = (x - bz.x) / (rw * 0.86), v = (y - cyb) / hh;
            const d2 = u * u + v * v;
            if (d2 > 1) continue;
            if (!(getpx(f, x, y) >>> 24)) continue;
            const n = vnoise(0x6c11, x / k * 0.16, y / k * 0.16);
            const cell = vnoise(0x6c12, x / k * 0.34, y / k * 0.30);
            let q = Math.pow(1 - d2, 1.5) * (0.30 + 0.55 * n);
            if (cell > 0.62) q += 0.34 * (cell - 0.62) * 6;
            over(f, x, y, mix(rgba(46, 96, 54, 255), ROT.glow, clamp(q * 1.5, 0, 1)), clamp(q, 0, 0.85));
          }
        }
        glow(f, bz.x, cyb + 2 * k, rw * 0.55, ROT.glow, { halo: 0, tint: 0.16, seed: 410 });
        if (fw > 0.3 && burst < 0.2) {
          // lunch, still visible through the skin: a hardhat and a boot, gently rotating
          const hx = bz.x - rw * 0.32, hy = cyb - 3 * k;
          const sil = mix(rgba(20, 44, 26, 255), ROT.glow, 0.15);
          blob(f, hx, hy, 4.0 * k, 3.0 * k, flat(mix(rgba(236, 184, 34, 255), ROT.glow, 0.3)));
          capsule(f, hx - 5 * k, hy + 2.2 * k, hx + 5 * k, hy + 2.2 * k, 0.8 * k, 0.8 * k, flat(mix(rgba(200, 150, 30, 255), ROT.glow, 0.35)), {});
          // a skull, grinning, because it is the only one in here having a good time
          const sx2 = bz.x + rw * 0.05, sy2 = cyb - 7 * k;
          blob(f, sx2, sy2, 2.6 * k, 2.4 * k, flat(mix(RR.bone[3], ROT.glow, 0.3)));
          blob(f, sx2 - 1 * k, sy2, 0.7 * k, 0.8 * k, flat(sil)); blob(f, sx2 + 1 * k, sy2, 0.7 * k, 0.8 * k, flat(sil));
          line(f, Math.round(sx2 - 1.2 * k), Math.round(sy2 + 1.6 * k), Math.round(sx2 + 1.2 * k), Math.round(sy2 + 1.6 * k), sil);
          const bx2 = bz.x + rw * 0.34, by2 = cyb + 3 * k;
          capsule(f, bx2, by2 - 4 * k, bx2, by2, 1.7 * k, 1.7 * k, flat(sil), {});
          capsule(f, bx2, by2, bx2 + 3.6 * k, by2 + 0.5 * k, 1.7 * k, 1.4 * k, flat(sil), {});
          // and a fish skeleton, nobody knows why
          const fx = bz.x - 1 * k, fy = cyb + 7 * k;
          line(f, Math.round(fx - 3 * k), Math.round(fy), Math.round(fx + 3 * k), Math.round(fy), mix(RR.bone[3], ROT.glow, 0.4));
          for (let i = -2; i <= 2; i++) line(f, Math.round(fx + i * k), Math.round(fy - k), Math.round(fx + i * k), Math.round(fy + k), mix(RR.bone[2], ROT.glow, 0.4));
          fillPoly(f, [{ x: fx + 3 * k, y: fy }, { x: fx + 4.5 * k, y: fy - 1.5 * k }, { x: fx + 4.5 * k, y: fy + 1.5 * k }], mix(RR.bone[2], ROT.glow, 0.4));
        }
        // veins crawling over the sac, stretch marks at the sides
        for (let i = 0; i < 7; i++) {
          let vx = bz.x + (hash2(i, 3, 411) - 0.5) * rw * 1.4;
          let vy = cyb - 12 * k + hash2(i, 5, 412) * 6 * k;
          let a = 1.2 + hash2(i, 7, 413) * 0.8;
          for (let q = 0; q < 16 * k; q++) {
            a += (hash2(Math.round(vx), Math.round(vy), 414) - 0.5) * 0.7;
            vx += Math.cos(a) * 1.4; vy += Math.sin(a) * 1.4;
            over(f, vx, vy, RM.bruise[1], 0.45);
            over(f, vx, vy + 1, RM.bruise[0], 0.25);
          }
        }
        for (const s of [-1, 1]) {
          for (let i = 0; i < 4; i++) {
            const sx = bz.x + s * rw * 0.72, sy = cyb - 6 * k + i * 3 * k;
            stitch(f, sx, sy, sx + s * 2 * k, sy + k, mix(RM.torso[4], RR.bruise[3], 0.3), 0.8, 1, 0);
          }
        }
        // belly seam and a belly button, outie
        for (let y = -13 * k; y <= 13 * k; y++) {
          over(f, bz.x + Math.sin(y / k * 0.3) * 1.2 * k, cyb + y, RM.bruise[0], 0.5);
        }
        if (fw > 0.3) {
          blob(f, bz.x + 1.2 * k, cyb + 8.5 * k, 1.4 * k, 1.2 * k, RM.torso, { shift: 1, edge: RM.torso[0], edgeW: 0.8 });
          px(f, Math.round(bz.x + 0.8 * k), Math.round(cyb + 8.1 * k), WETC);
        }
        if (burst > 0) {
          // split along the seam and rupture
          const hw = 2 * k + burst * (rw * 0.62);
          for (let y = -hh; y <= hh; y++) {
            const w2 = hw * Math.sqrt(Math.max(0, 1 - (y / hh) * (y / hh)));
            for (let x = -w2; x <= w2; x++) {
              const xx = bz.x + x + Math.sin(y / k * 0.4) * 1.6 * k, yy = cyb + y;
              if (!(getpx(f, xx, yy) >>> 24)) continue;
              const d2 = Math.abs(x) / Math.max(1, w2);
              px(f, xx, yy, d2 > 0.82 ? RM.muscle[0] : mix(rgba(28, 10, 14, 255), rgba(70, 18, 20, 255), hash2(Math.round(xx), Math.round(yy), 415)));
            }
          }
          // ragged flaps of skin
          for (let i = 0; i < 10; i++) {
            const yy = cyb + (-12 + i * 2.6) * k;
            const w2 = hw * Math.sqrt(Math.max(0, 1 - Math.pow((yy - cyb) / hh, 2)));
            for (const sgn of [-1, 1]) {
              capsule(f, bz.x + sgn * w2, yy, bz.x + sgn * (w2 + (2.4 + burst * 2) * k), yy + (hash2(i, sgn, 416) - 0.5) * 3 * k,
                1.6 * k, 0.8 * k, RM.muscle, { shift: sgn > 0 ? -1 : 0 });
            }
          }
          glow(f, bz.x, cyb, hw * 1.5, ROT.glow, { halo: 0.5, tint: 0.35, seed: 417, base: rgba(18, 40, 22, 255), core: 0.7 });
          // spilling contents: sausage-link guts and a very surprised hardhat
          for (let i = 0; i < 22 * burst; i++) {
            const a = hash2(i, 1, 418) * 6.28, r = hash2(i, 2, 419) * (hw + 10 * k);
            const gx = bz.x + Math.cos(a) * r, gy = cyb + Math.sin(a) * r * 1.1 + burst * 6 * k;
            blob(f, gx, gy, 1.4 * k, 1.2 * k, hash2(i, 3, 420) < 0.4 ? RM.muscle : flat(mix(rgba(60, 120, 66, 255), ROT.glow, 0.4)), { spec: WETC });
          }
          if (burst > 0.4) sausages(f, bz.x - hw * 0.5, cyb + 4 * k, bz.x + hw * 0.4, cyb + hh + 4 * k, 5, 1.5 * k, 420);
        }
        wetness(f, Math.floor(bz.x - rw), Math.floor(cyb - hh), Math.ceil(bz.x + rw), Math.ceil(cyb + hh), 421, 0.012);
        if (fw > 0.35) {
          for (let i = 0; i < 3; i++) {
            drip(f, Math.round(bz.x + (-10 + i * 10) * k), Math.round(cyb + (13 + (i % 2) * 2) * k), Math.round((3 + i) * k), mix(RM.muscle[2], ROT.glow, 0.3));
          }
        }
        if (fw < -0.2) {
          // back: boils and bruised blotches so it is not a bare sac
          for (let i = 0; i < 8; i++) {
            const a = hash2(i, 2, 422) * 6.28, r = hash2(i, 3, 423) * rw * 0.8;
            const px0 = bz.x + Math.cos(a) * r, py0 = cyb + Math.sin(a) * 13 * k;
            const rr2 = (1.2 + hash2(i, 4, 424) * 1.8) * k;
            blob(f, px0, py0, rr2, rr2 * 0.85, RM.head, { shift: -1 });
            blob(f, px0 - 0.4 * k, py0 - 0.4 * k, rr2 * 0.45, rr2 * 0.4, RM.head, { shift: 1, spec: WETC });
          }
          for (let i = 0; i < 9; i++) {
            const y2 = cyb + (-12 + i * 3) * k;
            over(f, bz.x, y2, RM.bruise[0], 0.55);
            over(f, bz.x + 1, y2, RM.torso[4], 0.4);
          }
        }
      });
    },
    prep(pose, mode, F, t) {
      if (pose.funnel === undefined) pose.funnel = 0;
      if (mode === 'die') {
        this.swell(t < 0.5 ? t * 1.6 : Math.max(0, 1.6 - t * 1.2));
        pose.burst = t < 0.3 ? 0 : clamp((t - 0.3) / 0.45, 0, 1);
        pose.funnel = 0.8;
      } else {
        // the belly lags the step and slops about after it
        const jig = mode === 'walk' ? 0.07 * Math.sin(2 * pose.phase - 1.2)
          : mode === 'idle' ? (pose.shrug ? 0.05 : 0) : mode === 'fire0' ? 0.06 : mode === 'pain1' ? -0.05 : 0;
        this.swell(jig);
        pose.burst = 0;
      }
    },
    corpse(f, mask) {
      const k = this.k;
      const R2 = this.ramps, gy = f.h - 1, cx = f.w / 2;
      gorePool(f, cx, gy - 4 * k, 32 * k, 7 * k, 0x4242, { spots: 30 });
      // a deflated bag of skin in a lake of its own contents
      for (let i = 0; i <= 16; i++) {
        const t = i / 16;
        blob(f, cx + (-22 + t * 44) * k, gy - (6 + Math.sin(t * Math.PI) * 5) * k, 4.0 * k, (2.6 + Math.sin(t * Math.PI) * 3.2) * k,
          flat(MASK_KEY), {});
      }
      massShade(f, Math.round(cx - 30 * k), Math.round(gy - 18 * k), Math.round(cx + 30 * k), gy, R2.torso, { kx: 0.5, ky: 0.85, cx, rx: 26 * k, grain: 0.09, seed: 430 });
      sausages(f, cx - 16 * k, gy - 3 * k, cx + 12 * k, gy - 1 * k, 7, 1.8 * k, 436);
      if (!(mask & 1)) {
        blob(f, cx - 24 * k, gy - 8 * k, 6.0 * k, 4.4 * k, R2.head, { grain: 0.06, seed: 431, edge: this.edge });
        // piggy eyes crossed out, tongue out
        for (const ex of [-26.5, -21.5]) {
          line(f, Math.round(cx + (ex - 0.8) * k), Math.round(gy - 10 * k), Math.round(cx + (ex + 0.8) * k), Math.round(gy - 8.4 * k), RR.ink);
          line(f, Math.round(cx + (ex - 0.8) * k), Math.round(gy - 8.4 * k), Math.round(cx + (ex + 0.8) * k), Math.round(gy - 10 * k), RR.ink);
        }
        tongue(f, cx - 24 * k, gy - 5 * k, cx - 28 * k, gy - 1 * k, 1.1 * k, 437);
      } else {
        stump(f, cx - 20 * k, gy - 8 * k, -1, -0.3, 4 * k, R2.torso, { len: 0, seed: 438, fringe: false });
      }
      if (!(mask & 4)) capsule(f, cx - 26 * k, gy - 5 * k, cx - 30 * k, gy - 1 * k, 1.6 * k, 1.2 * k, R2.glove, { edge: this.edge });
      glow(f, cx + 6 * k, gy - 6 * k, 12 * k, ROT.glow, { halo: 0.2, tint: 0.22, seed: 432, base: rgba(20, 38, 22, 255), core: 0.8 });
      for (let i = 0; i < 26; i++) {
        const a = hash2(i, 9, 433) * 6.28, r = (6 + hash2(i, 8, 434) * 26) * k;
        blob(f, cx + Math.cos(a) * r, gy - 5 * k + Math.sin(a) * r * 0.28, 1.3 * k, 1.1 * k,
          hash2(i, 7, 435) < 0.35 ? flat(mix(rgba(60, 120, 66, 255), ROT.glow, 0.35)) : R2.muscle);
      }
      wash(f, rgba(48, 16, 22, 255), 0.16, (x, y) => y > gy - 8 * k);
      finishEnemy(f, { ink: this.edge });
    },
  };
}

/**
 * Howler - a scream with a skeleton, in what is left of a lab coat. Four
 * mandibles peel open like a flower around an acid gullet.
 */
function makeHowler() {
  const skin = mix(ROT.sick, ROT.bruise, 0.34);
  const R = {
    torso: mat(skin, { contrast: 1.45 }),
    sleeve: mat(rgba(200, 202, 194, 255), { contrast: 1.2 }),
    forearm: mat(shade(skin, 0.8), { contrast: 1.45 }),
    shoulder: mat(rgba(206, 208, 200, 255), { contrast: 1.2 }),
    trouser: mat(shade(skin, 0.72), { contrast: 1.45 }),
    boot: mat(rgba(46, 40, 44, 255)),
    glove: mat(mix(skin, ROT.muscle, 0.4), { contrast: 1.3 }),
    neck: mat(mix(ROT.muscle, ROT.flesh, 0.5), { contrast: 1.3 }),
    bone: RR.bone, muscle: RR.muscle, sinew: mat(mix(ROT.muscle, ROT.flesh, 0.5), { contrast: 1.3 }),
  };
  const ch = {
    id: 'howler', w: 60, h: 78, dieW: 108, k: K, blood: MUTANT_BLOOD, pool: MUTANT_POOL,
    hipY: 32, shoulderY: 50, neckY: 53, headY: 61, neckZ: -1.0, headZ: -3.2,
    shoulderHalf: 10, legHalf: 4.6, ankleY: 3.2, footLen: 5.4,
    thigh: 16, shin: 15.5, upper: 13, fore: 12.5,
    armThick: 2.4, legThick: 3.2, stride: 11, lift: 7, hipDip: 2.4, lean: 0.06,
    // a long loping stride, pitched forward, arms swinging loose
    gait: { duty: 0.5, twist: 0.18, bob: 1.1, leanBob: 0.08, strike: 0.3, push: 0.55, tilt: 0.04 },
    slices: 16, edge: rgba(16, 14, 18, 255), lieH: 15, neckR: 2.6,
    profile: [[0, 6.2, 4.8], [0.4, 7.2, 5.4], [0.78, 9.4, 6.2], [1, 8.4, 5.6]],
    ramps: R,
    head(f, c) {
      const { hd, theta, R: RM, pose, k } = c;
      const fw = Math.cos(theta), sd = Math.sin(theta);
      const E = c.E || { edge: ch.edge, edgeW: 0.9 };
      const open = pose.severed ? 1 : (pose.open || 0);
      const g = pen(f, hd.x, hd.y, k, 1, c.rot || 0, c.sy || 1);
      // cranium, thrown back: the face points at the ceiling
      g.blob(sd * 1.4, 1.8, 6.4, 5.8, RM.bone, { grain: 0.05, seed: 440, ...E, spec: rgba(255, 252, 236, 255), specT: 0.97 });
      g.blob(sd * 2.0, 4.4, 5.0, 3.4, RM.bone, { shift: -1, grain: 0.05, seed: 441 });
      for (let i = 0; i < 4; i++) g.over(-3 + i * 2, 5.4, RM.bone[0], 0.5);
      // cracked skull plate
      g.line(sd * 1.4 - 2, -1.8, sd * 1.4 + 0.5, 1.4, RM.bone[0]);
      g.line(sd * 1.4 + 0.5, 1.4, sd * 1.4 + 2.5, 0.8, RM.bone[0]);
      const mx = hd.x + sd * 0.8 * k, my = hd.y - 2.8 * k;
      // acid gullet
      const gr = (2.2 + open * 3.4) * k;
      blob(f, mx, my, gr + 1.4 * k, gr + 1.2 * k, RR.gum, { shift: 0, edge: RR.ink, edgeW: 0.9 });
      blob(f, mx, my, gr, gr * 0.94, RR.maw, {});
      glow(f, mx, my, gr * (1.3 + open), ROT.glow, { halo: 0.35 + open * 0.4, tint: 0.42, seed: 442, base: rgba(16, 40, 22, 255), core: 0.7 });
      blob(f, mx, my + gr * 0.2, gr * 0.5, gr * 0.4, flat(mix(rgba(40, 96, 48, 255), ROT.glow, 0.55)));
      // four mandibles peeling open around it
      const base = [-2.62, -1.98, -1.16, -0.52];
      for (let i = 0; i < 4; i++) {
        const spread = open * 0.5;
        const a = base[i] + (base[i] < -1.57 ? -spread : spread) * (i === 0 || i === 3 ? 1.3 : 0.5);
        const L = 7.4 * k;
        const ex = mx + Math.cos(a) * L, ey = my + Math.sin(a) * L * 0.92;
        capsule(f, mx + Math.cos(a) * 1.6 * k, my + Math.sin(a) * 1.5 * k, ex, ey, 2.3 * k, 0.9 * k, RM.bone, { shift: i % 2 ? 0 : -1, ...E });
        // inner teeth along each mandible
        const nx2 = -Math.sin(a), ny2 = Math.cos(a);
        const sgn = i < 2 ? 1 : -1;
        fangRow(f, mx + Math.cos(a) * 2.6 * k, my + Math.sin(a) * 2.4 * k, ex * 0.96 + mx * 0.04, ey * 0.96 + my * 0.04,
          4, 2.2 * k, nx2 * sgn, ny2 * sgn, { seed: 12 + i, gap: 0.3 });
        px(f, Math.round(ex), Math.round(ey), RM.bone[4]);
      }
      // acid dribbling off the lip, uphill, because it is screaming at the ceiling
      for (let i = 0; i < 2; i++) drip(f, Math.round(mx + (i ? 2 : -2.5) * k), Math.round(my + gr * 0.8), Math.round((2 + i * 2) * k), ROT.glow, 0.8);
      if (pose.spit) {
        // the spit: a rope of glowing acid hurled up and out, breaking into gobbets
        const sp = pose.spit;
        for (let i = 0; i < 12; i++) {
          const t = i / 11;
          const gx = mx - t * (8 + 8 * sp) * k + Math.sin(i * 1.3) * t * 1.5 * k;
          const gy = my - t * (7 + 3 * sp) * k + t * t * 12 * k;
          const r = (1.0 + t * 1.8 * sp) * k;
          glow(f, gx, gy, r * 1.9, ROT.glow, { halo: 0.8, tint: 0.5, seed: 460 + i, base: rgba(20, 60, 26, 255), core: 0.5 });
          blob(f, gx, gy, r, r * 0.9, flat(mix(rgba(214, 255, 190, 255), ROT.glow, t)));
        }
      }
      if (fw > 0.3) {
        // sunken eye pits, high on the skull, pinpricks of light in them
        for (const ex of [-3.0, 3.0]) {
          g.blob(ex, 1.6, 1.6, 1.3, RR.maw, { shift: 1 });
          g.dot(ex, 1.4, pose.severed ? rgba(90, 100, 90, 255) : rgba(200, 255, 190, 255));
        }
      }
      g.dot(-2, 4.2, WETC);
    },
    torsoDetail(c) {
      // the remains of a lab coat: white lapels, a torn pocket, a name tag
      const { f, theta, k, hipY } = c;
      const fw = Math.cos(theta);
      const ta = torsoAt(c, ch.shoulderY), tb = torsoAt(c, hipY);
      sores(f, ta.x - ta.rx, ta.y, ta.x + ta.rx, tb.y, 8, k, 455);
      if (fw > 0.3) {
        for (const s of [-1, 1]) {
          const a = surf(c, s * 6.6, ch.shoulderY + 0.5), b = surf(c, s * 5.0, hipY - 1);
          capsule(f, a.x, a.y, b.x, b.y, 1.8 * k, 2.2 * k, RR.coat, { edge: ch.edge, edgeW: 0.8 });
          for (let i = 0; i < 3; i++) {
            const tx = b.x + (i - 1) * 1.2 * k, ty = b.y + 1.5 * k;
            line(f, Math.round(tx), Math.round(ty), Math.round(tx + (hash2(i, s, 457) - 0.5) * 2 * k), Math.round(ty + (1 + hash2(i, s, 458) * 2.5) * k), RR.coat[i % 2 ? 1 : 3]);
          }
        }
        const nt = surf(c, 6.2, ch.shoulderY - 4);
        fillRect(f, Math.round(nt.x - 1.4 * k), Math.round(nt.y - 0.8 * k), Math.round(2.8 * k), Math.round(1.6 * k), rgba(236, 236, 232, 255));
        fillRect(f, Math.round(nt.x - 1.4 * k), Math.round(nt.y - 0.8 * k), Math.round(2.8 * k), 1, rgba(40, 90, 200, 255));
      } else if (fw < -0.3) {
        // back of the coat, split up the middle
        const a = surf(c, 0, ch.shoulderY + 0.5, -1), b = surf(c, 0, hipY - 2, -1);
        for (let y = Math.round(a.y); y <= Math.round(b.y); y++) {
          const t = (y - a.y) / Math.max(1, b.y - a.y);
          const w = Math.round((7.6 - t * 1.5) * k);
          for (let x = -w; x <= w; x++) {
            if (Math.abs(x) < t * 3 * k) continue;
            const d = getpx(f, a.x + x, y);
            if (!(d >>> 24)) continue;
            const u = x / w;
            px(f, a.x + x, y, RR.coat[clamp(band(lamOf(u, -0.1, Math.sqrt(Math.max(0, 1 - u * u)))), 0, 4)]);
          }
        }
      }
    },
    gear(c) {
      const { f, add, P, R: RM, ch: C, theta, k, mask, hipY, pose } = c;
      const fw = Math.cos(theta), sd = Math.sin(theta);
      const E = { edge: C.edge, edgeW: 0.9 };
      // hugely elongated neck, arching back
      const nz = P(c.U(0, (C.shoulderY + C.headY) / 2, -2));
      add(nz.z + 6, () => {
        const n = 9;
        const reach = (mask & 1) ? 0.5 : 1;
        let last = null, prev = null;
        for (let i = 0; i <= n; i++) {
          const t = i / n * reach;
          const y = lerp(C.shoulderY - 1, C.headY - 4.0, t);
          const z = -1.2 - Math.sin(t * Math.PI) * 3.2;
          const p = P(c.U(0, y, z));
          const r = lerp(3.6, 2.5, t) * k;
          blob(f, p.x, p.y, r, r * 0.9, RM.sinew, { grain: 0.06, seed: 450 + i, ...(i === 0 ? E : {}) });
          if (i % 2 === 0) over(f, p.x + 1.6 * k, p.y, RM.bone[3], 0.5);
          prev = last; last = p;
        }
        // vertebrae ridge
        for (let i = 0; i <= n; i++) {
          const t = i / n * reach;
          const p = P(c.U(0, lerp(C.shoulderY, C.headY - 4.5, t), -4.4 - Math.sin(t * Math.PI) * 2.6));
          blob(f, p.x, p.y, 1.5 * k, 1.1 * k, RM.bone, { shift: i % 2 ? 0 : 1 });
        }
        if ((mask & 1) && prev) stump(f, prev.x, prev.y, last.x - prev.x, last.y - prev.y, 2.9 * k, RM.sinew, { len: 0, seed: 459, flat: 0.62, drips: 3, fringe: false });
      });
      // ribcage burst outward through the skin
      const rz = P(c.U(0, C.shoulderY - 8, 7));
      add(rz.z + 1.4, () => {
        const rib = dimRamp(RM.bone, 0.30);
        const halfw = (7.5 * (0.35 + 0.65 * Math.abs(fw)) + Math.abs(sd) * 4) * k;
        // the chest cavity behind the ribs: a dark wet hole
        for (let y = -9 * k; y <= 10 * k; y++) {
          const w2 = halfw * Math.sqrt(Math.max(0, 1 - (y / (11 * k)) * (y / (11 * k)))) * 0.92;
          for (let x = -w2; x <= w2; x++) {
            const xx = rz.x + x, yy = rz.y + y;
            if (!(getpx(f, xx, yy) >>> 24)) continue;
            const d = Math.abs(x) / Math.max(1, w2);
            px(f, xx, yy, d > 0.8 ? RM.muscle[0] : mix(rgba(22, 10, 14, 255), rgba(64, 18, 22, 255), hash2(Math.round(xx), Math.round(yy), 451) * 0.8));
          }
        }
        glow(f, rz.x, rz.y + k, halfw * 0.8, rgba(120, 26, 26, 255), { halo: 0, tint: 0.3, seed: 453 });
        // a heart in there, still going
        if (fw > 0.3) blob(f, rz.x - 1.5 * k, rz.y + 2 * k, 1.8 * k, 1.6 * k, RR.muscle, { shift: 1, spec: WETC });
        // four heavy ribs a side, sprung outward out of the skin
        for (let i = 0; i < 4; i++) {
          const y = rz.y + (-7 + i * 4.6) * k;
          const w = halfw * (0.72 + i * 0.12);
          for (const sgn of [-1, 1]) {
            const bow = 1 + (i % 2) * 0.25 + (sgn > 0 ? 0.12 : 0);
            const pts = [];
            for (let q = 0; q <= 7; q++) {
              const t = q / 7;
              pts.push({
                x: rz.x + sgn * (2 * k + w * Math.sin(t * 1.75) * bow),
                y: y + (t * 4.4 - Math.cos(t * 1.75) * 2.6) * k,
              });
            }
            for (let q = 0; q < pts.length - 1; q++) {
              capsule(f, pts[q].x, pts[q].y, pts[q + 1].x, pts[q + 1].y, (1.9 - q * 0.12) * k, (1.8 - q * 0.12) * k,
                rib, { shift: sgn > 0 ? 0 : -1, ...(q === 0 ? E : {}) });
            }
            capsule(f, rz.x + sgn * 1.2 * k, y - 0.5 * k, rz.x + sgn * (w * 0.45), y + 0.8 * k, 2.0 * k, 1.3 * k, RM.muscle, { shift: -1 });
            px(f, Math.round(pts[7].x), Math.round(pts[7].y), RM.bone[4]);
          }
        }
        // split sternum
        capsule(f, rz.x, rz.y - 9 * k, rz.x, rz.y + 9 * k, 2.0 * k, 1.5 * k, rib, { shift: 1 });
        for (let i = 0; i < 7; i++) over(f, rz.x + (i % 2 ? 0 : 1), rz.y + (-8 + i * 2.6) * k, RR.ink, 0.65);
        wetness(f, Math.round(rz.x - 14 * k), Math.round(rz.y - 11 * k), Math.round(rz.x + 14 * k), Math.round(rz.y + 12 * k), 452, 0.02);
        for (let i = 0; i < 2; i++) drip(f, Math.round(rz.x + (-6 + i * 12) * k), Math.round(rz.y + 9 * k), Math.round((4 + i * 2) * k), RM.muscle[2]);
      });
    },
    armDetail(c, A, s2, e2, h2, sft) {
      // torn coat sleeve ends at the elbow; long bony claws on the hand
      limbBand(c.f, s2, e2, 0.92, ch.armThick * c.k * 1.25, 1.6 * c.k, RR.coat, { shift: sft });
      const dx = h2.x - e2.x, dy = h2.y - e2.y, L = Math.hypot(dx, dy) || 1;
      const ux = dx / L, uy = dy / L;
      for (let i = -1; i <= 1; i++) {
        const bx = h2.x + ux * 1.2 * c.k - uy * i * c.k, by = h2.y + uy * 1.2 * c.k + ux * i * c.k;
        capsule(c.f, bx, by, bx + (ux * 4 - uy * i * 1.2) * c.k, by + (uy * 4 + ux * i * 1.2) * c.k, 0.6 * c.k, 0.3 * c.k, RR.bone, { shift: sft + 1, ...c.E });
      }
    },
  };
  return ch;
}

/** A string of sausage-link guts from (x0,y0) to (x1,y1), n links of radius r. */
function sausages(f, x0, y0, x1, y1, n, r, seed) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push({
      x: lerp(x0, x1, t) + Math.sin(t * 6.3 + seed) * r * 1.8,
      y: lerp(y0, y1, t) + Math.cos(t * 5.1 + seed) * r * 1.2,
    });
  }
  const G = mat(rgba(214, 112, 116, 255), { contrast: 1.25 });
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[i + 1];
    // each link is its own fat little sausage, pinched shut at both ends
    const ax = lerp(a.x, b.x, 0.14), ay = lerp(a.y, b.y, 0.14), bx = lerp(a.x, b.x, 0.86), by = lerp(a.y, b.y, 0.86);
    capsule(f, ax, ay, bx, by, r, r, G, { edge: rgba(70, 14, 22, 255), edgeW: 0.8, spec: rgba(255, 236, 236, 255), specT: 0.94 });
  }
  for (let i = 1; i < n; i++) {
    blob(f, pts[i].x, pts[i].y, r * 0.42, r * 0.42, flat(rgba(96, 26, 36, 255)));
  }
}

// ---------------------------------------------------------------------------
// MAW - a wall of fused bodies grown together into one screaming mass
// ---------------------------------------------------------------------------

const MAW_W = 176, MAW_H = 150;
let MAW_MOTTLE = null;   // the same noise under every frame: computed once

const MAWR = {
  flesh: mat(mix(ROT.flesh, rgba(126, 70, 66, 255), 0.62), { contrast: 1.25 }),
  fleshD: mat(mix(ROT.flesh, rgba(120, 76, 74, 255), 0.5), { contrast: 1.3 }),
  face: mat(mix(ROT.flesh, rgba(214, 198, 172, 255), 0.55), { contrast: 1.3 }),
  bruise: RR.bruise, muscle: RR.muscle, bone: RR.bone, fang: RR.fang,
  gum: RR.gum, ink: rgba(14, 12, 14, 255),
};

/** One fused face in the mass: skull, mismatched eyes, a screaming mouth. */
function mawFace(f, x, y, s, o = {}) {
  const R = MAWR;
  const open = o.open === undefined ? 0.6 : o.open;
  const tilt = o.tilt || 0;
  const dead = o.dead || 0;
  blob(f, x, y, 7.5 * s + 1.4, 8.5 * s + 1.4, flat(mix(R.ink, R.flesh[0], 0.35)), {});
  blob(f, x, y, 7.5 * s, 8.5 * s, R.face, { grain: 0.06, seed: 500 + (x | 0), spec: WETC, specT: 0.975 });
  blob(f, x + tilt * 1.6, y - 3.4 * s, 6.6 * s, 4.6 * s, R.face, { shift: 1, grain: 0.05, seed: 501 + (y | 0) });
  // gaunt cheeks pull the face into a scream
  for (const sgn of [-1, 1]) {
    blob(f, x + sgn * 5.2 * s, y + 1.6 * s, 2.4 * s, 3.0 * s, R.face, { shift: -1 });
  }
  // brow and cheekbone
  for (let i = -3; i <= 3; i++) over(f, x + i * 1.6 * s, y - 6.2 * s, R.bone[3], 0.45);
  // eyes: deliberately mismatched
  const ex = [-3.2 * s + tilt, 3.6 * s + tilt];
  const er = [1.9 * s, 1.35 * s];
  for (let i = 0; i < 2; i++) {
    if (o.burst && i === (o.burst - 1)) {
      blob(f, x + ex[i], y - 2.0 * s, er[i] + 0.6, er[i] * 0.9 + 0.6, flat(rgba(46, 12, 16, 255)));
      for (let q = 0; q < 4; q++) {
        const a = q * 1.6;
        line(f, x + ex[i], y - 2.0 * s, x + ex[i] + Math.cos(a) * er[i] * 2, y - 2.0 * s + Math.sin(a) * er[i] * 2, R.muscle[1]);
      }
      drip(f, x + ex[i], y - 2.0 * s + er[i], 4 * s, R.muscle[2], 1.1);
      continue;
    }
    blob(f, x + ex[i], y - 2.0 * s, er[i] + 0.8, er[i] * 0.9 + 0.8, RR.maw, { shift: 0 });
    const eye = dead ? rgba(78, 76, 70, 255) : mix(rgba(226, 224, 206, 255), ROT.glow, i ? 0.35 : 0.05);
    blob(f, x + ex[i], y - 2.0 * s, er[i], er[i] * 0.85, flat(eye));
    blob(f, x + ex[i] + (i ? -0.5 : 0.6) * s, y - 2.0 * s, er[i] * 0.45, er[i] * 0.42, flat(rgba(22, 16, 20, 255)));
    px(f, Math.round(x + ex[i] - er[i] * 0.5), Math.round(y - 2.6 * s), rgba(255, 255, 246, 255));
  }
  // what they were wearing when it happened
  if (o.glasses) {
    for (let i = 0; i < 2; i++) {
      for (let a = 0; a < 6.283; a += 0.3) px(f, x + ex[i] + Math.cos(a) * (er[i] + 1.2), y - 2.0 * s + Math.sin(a) * (er[i] + 1.0), rgba(30, 28, 30, 255));
    }
    line(f, x + ex[0] + er[0] + 1, y - 2.2 * s, x + ex[1] - er[1] - 1, y - 2.2 * s, rgba(30, 28, 30, 255));
    line(f, x + ex[1] - er[1] + 1, y - 3.4 * s, x + ex[1] + er[1], y - 1.2 * s, rgba(236, 240, 244, 255));
  }
  if (o.hat) {
    blob(f, x + tilt, y - 7.6 * s, 6.4 * s, 4.0 * s, RR.hat, { edge: R.ink, edgeW: 0.9, spec: rgba(255, 252, 226, 255) });
    capsule(f, x + tilt - 8 * s, y - 4.8 * s, x + tilt + 8 * s, y - 5.6 * s, 1.1 * s, 1.1 * s, RR.hat, { shift: -1, edge: R.ink, edgeW: 0.8 });
  }
  if (o.tag) {
    fillRect(f, Math.round(x + 3 * s), Math.round(y + 3 * s), Math.round(6 * s), Math.round(3.6 * s), rgba(236, 236, 230, 255));
    fillRect(f, Math.round(x + 3 * s), Math.round(y + 3 * s), Math.round(6 * s), Math.max(1, Math.round(1.2 * s)), rgba(200, 40, 40, 255));
    stitch(f, x + 4 * s, y + 5.4 * s, x + 8 * s, y + 5.4 * s, rgba(40, 40, 120, 255), 1, 1, 1);
  }
  // screaming mouth
  const my = y + 4.2 * s;
  gape(f, x + tilt, my, 4.6 * s, (1.1 + open * 3.2) * s, {
    rows: s > 0.9 ? 2 : 1, n: Math.max(5, Math.round(5 * s)), seed: 500 + (x | 0), ink: R.ink, arc: 0.9 * s,
    glow: o.glow ? o.glow : 0,
  });
  if (!dead) px(f, Math.round(x - 2 * s), Math.round(my - 3 * s), WETC);
}

function paintMaw(o) {
  const f = makeFrame(MAW_W, MAW_H);
  const R = MAWR;
  const cx = MAW_W / 2;
  const dmg = o.damage || 0, sag = o.sag || 0, throat = o.throat || 0;
  const rng = makeRng(0x1a7e);

  // --- the mass: a broad wall of fused bodies, edge deliberately irregular
  for (let gy = 0; gy < 3; gy++) {
    for (let gx = 0; gx < 4; gx++) {
      const jx = hash2(gx, gy, 505), jy = hash2(gx, gy, 506), jr = hash2(gx, gy, 507);
      const lx = 40 + gx * 32 + (jx - 0.5) * 14;
      const ly = 40 + gy * 34 + (jy - 0.5) * 14 + sag * (2 + gy * 3);
      blob(f, lx, ly, 16 + jr * 8, 16 + (1 - jr) * 8, flat(MASK_KEY), {});
    }
  }
  blob(f, cx, 78 + sag * 4, 40, 33, flat(MASK_KEY), {});
  blob(f, cx - 34, 62, 20, 22, flat(MASK_KEY), {});
  blob(f, cx + 34, 60, 19, 21, flat(MASK_KEY), {});
  massShade(f, 2, 2, MAW_W - 2, MAW_H - 2, R.flesh, {
    kx: 0.58, ky: 0.5, cx, rx: 70, grain: 0.12, seed: 510,
  });
  // mottling: bruised patches and raw red ones, so it reads as meat, not putty
  if (!MAW_MOTTLE) {
    MAW_MOTTLE = new Float32Array(MAW_W * MAW_H);
    for (let y = 0; y < MAW_H; y++) for (let x = 0; x < MAW_W; x++) MAW_MOTTLE[y * MAW_W + x] = vnoise(0x5a1, x * 0.07, y * 0.07);
  }
  for (let y = 2; y < MAW_H - 2; y++) {
    for (let x = 2; x < MAW_W - 2; x++) {
      if (!(f.data[y * MAW_W + x] >>> 24)) continue;
      const n = MAW_MOTTLE[y * MAW_W + x];
      if (n > 0.62) over(f, x, y, R.bruise[1], (n - 0.62) * 1.6);
      else if (n < 0.36) over(f, x, y, R.muscle[2], (0.36 - n) * 1.4);
    }
  }
  for (let i = 0; i < 16; i++) {
    vein(f, 20 + hash2(i, 1, 517) * (MAW_W - 40), 20 + hash2(i, 2, 517) * (MAW_H - 40), hash2(i, 3, 517) * 6.28, 30, 1.2, rgba(90, 40, 80, 255), 518 + i);
  }
  // bruised seams where one body is fused into the next
  for (let i = 0; i < 12; i++) {
    let x = 24 + hash2(i, 1, 511) * (MAW_W - 48);
    let y = 22 + hash2(i, 2, 512) * 104;
    let a = hash2(i, 3, 513) * 6.28;
    for (let q = 0; q < 26; q++) {
      a += (hash2(x, y, 514) - 0.5) * 0.5;
      x += Math.cos(a) * 1.6; y += Math.sin(a) * 1.6;
      if (!(getpx(f, x, y) >>> 24)) continue;
      over(f, x, y, R.bruise[0], 0.5);
      over(f, x, y - 1, R.flesh[4], 0.28);
    }
  }
  // scraps of uniform stretched over the mass: orange coverall, a lab coat, a tie
  for (const [sx, sy, sw, sh, col] of [[34, 84, 22, 14, RR.rag], [128, 90, 20, 16, RR.coat], [68, 124, 16, 10, RR.rag]]) {
    for (let y = sy; y < sy + sh; y++) {
      for (let x = sx; x < sx + sw; x++) {
        const d = getpx(f, x, y);
        if (!(d >>> 24) || hash2(x, y, 515) < 0.08) continue;
        if (y > sy + sh - 3 && hash2(x, 0, 516) < 0.5) continue;
        const u = (x - sx) / sw * 2 - 1;
        px(f, x, y, col[clamp(band(lamOf(u * 0.6, (y - sy) / sh - 0.6, 0.7)), 0, 4)]);
      }
    }
  }
  fillPoly(f, [{ x: 136, y: 98 }, { x: 140, y: 98 }, { x: 141, y: 112 }, { x: 138, y: 116 }, { x: 135, y: 112 }], rgba(40, 70, 160, 255));
  line(f, 137, 99, 137, 113, rgba(90, 120, 210, 255));

  // --- fused limbs shoving out of the mass
  for (let i = 0; i < 7; i++) {
    const a = -2.75 + i * 0.55;
    const bx = cx + Math.cos(a) * 50, by = 76 + Math.sin(a) * 42 + sag * 4;
    const reach = 12 + (i % 3) * 4;
    const ex = bx + Math.cos(a) * reach, ey = by + Math.sin(a) * reach * 0.8;
    capsule(f, bx, by, ex, ey, 5.0, 3.6, R.flesh, { shift: i % 2 ? -1 : 0, grain: 0.08, seed: 520 + i, edge: R.ink, edgeW: 1.0 });
    if (i === 1 || i === 5) limbBand(f, { x: bx, y: by }, { x: ex, y: ey }, 0.5, 4.4, 4, i === 1 ? RR.rag : RR.coat, {});
    // clawing hand
    blob(f, ex, ey, 4.2, 3.8, R.fleshD, { shift: 0, grain: 0.06, seed: 526 + i, edge: R.ink, edgeW: 1.0 });
    if (i === 6 && !o.dead) {
      // one of them is still holding its coffee
      box(f, Math.round(ex + 1), Math.round(ey - 6), 7, 8, mat(rgba(236, 234, 226, 255)), {});
      blob(f, ex + 9, ey - 2, 1.8, 2.2, flat(rgba(200, 198, 190, 255)));
      blob(f, ex + 4.5, ey - 3, 1.4, 1.2, flat(rgba(210, 40, 50, 255)));
      fillRect(f, Math.round(ex + 2), Math.round(ey - 6), 5, 1, rgba(80, 50, 30, 255));
    }
    for (let q = -1; q <= 2; q++) {
      const fa = a + q * 0.30 - 0.15;
      const fl = 6.0 - Math.abs(q) * 1.0;
      capsule(f, ex, ey, ex + Math.cos(fa) * fl, ey + Math.sin(fa) * fl, 1.5, 0.9, R.fleshD,
        { shift: q > 0 ? 0 : -1, edge: R.ink, edgeW: 0.8 });
      const nx2 = ex + Math.cos(fa) * (fl + 1.4), ny2 = ey + Math.sin(fa) * (fl + 1.4);
      capsule(f, ex + Math.cos(fa) * fl, ey + Math.sin(fa) * fl, nx2, ny2, 1.1, 0.5, R.bone, { shift: 1 });
    }
    over(f, ex - 2, ey - 3, WETC, 0.5);
  }

  // --- ribs and vertebrae surfacing through the skin
  for (let i = 0; i < 8; i++) {
    const bx = 26 + i * 19, by = 26 + ((i * 41) % 96);
    for (let q = 0; q < 6; q++) {
      const t = q / 5;
      over(f, bx + Math.sin(t * 2.2) * 11 - 5, by + t * 11, R.bone[3], 0.45);
      over(f, bx + Math.sin(t * 2.2) * 11 - 4, by + t * 11 + 1, R.bone[0], 0.3);
    }
  }

  // --- the faces: several are always looking at you, all of them screaming
  const faces = [
    [cx - 42, 46, 1.55, -0.8, { hat: 1 }], [cx + 41, 43, 1.4, 0.7, { glasses: 1 }], [cx - 38, 104, 1.25, 0.5, { tag: 1 }],
    [cx + 43, 102, 1.3, -0.6, {}], [cx - 4, 26, 1.1, 0.2, { hat: 1 }], [cx + 6, 128, 0.95, -0.3, { glasses: 1 }],
  ];
  faces.forEach((fc, i) => {
    const [fx, fy, fs, ft, extra] = fc;
    const burst = dmg > 0.2 + i * 0.1 ? ((i % 2) + 1) : 0;
    mawFace(f, fx, fy + sag * (2 + i * 0.4), fs, {
      open: o.faceOpen === undefined ? 0.35 + 0.35 * Math.abs(Math.sin(i * 1.7 + (o.phase || 0))) : o.faceOpen,
      tilt: ft, burst, dead: o.dead ? 1 : 0,
      glow: throat > 0.5 && i % 3 === 0 ? throat : 0,
      ...extra,
    });
  });

  // --- the central throat
  const ty = 78 + sag * 5;
  const trx = 15 + throat * 15, tryy = 17 + throat * 21;
  blob(f, cx, ty, trx + 7, tryy + 7, R.muscle, { grain: 0.08, seed: 530, edge: R.ink, edgeW: 1.1 });
  blob(f, cx, ty, trx + 3.5, tryy + 3.5, R.gum, { shift: 0, grain: 0.06, seed: 531 });
  blob(f, cx, ty, trx, tryy, RR.maw, {});
  if (!o.dead) {
    glow(f, cx, ty + tryy * 0.2, trx * (0.9 + throat), ROT.glow,
      { halo: 0.3 + throat * 0.5, tint: 0.3 + throat * 0.3, seed: 532, base: rgba(16, 40, 22, 255), core: 0.6 });
    blob(f, cx, ty + tryy * 0.3, trx * 0.5, tryy * 0.3, flat(mix(rgba(40, 100, 50, 255), ROT.glow, 0.4 + throat * 0.4)));
    // a dangling uvula, swinging
    capsule(f, cx + Math.sin(o.phase || 0) * 2, ty - tryy * 0.7, cx + Math.sin((o.phase || 0) + 0.6) * 3, ty - tryy * 0.25, 2.2, 3.0, RR.tongue, { spec: WETC });
  }
  // concentric rings of fangs down the throat
  for (let ring = 0; ring < 3; ring++) {
    const q = 1 - ring * 0.26;
    fangRow(f, cx - trx * q, ty - tryy * (0.74 - ring * 0.18), cx + trx * q, ty - tryy * (0.74 - ring * 0.18),
      9 - ring, tryy * 0.36 * q, 0, 1, { seed: 20 + ring, arc: 2.2 * q, ramp: R.fang });
    fangRow(f, cx - trx * q, ty + tryy * (0.74 - ring * 0.18), cx + trx * q, ty + tryy * (0.74 - ring * 0.18),
      9 - ring, tryy * 0.34 * q, 0, -1, { seed: 30 + ring, arc: -1.8 * q, ramp: R.fang });
  }
  // tusks framing the throat
  for (const sgn of [-1, 1]) {
    capsule(f, cx + sgn * (trx + 6), ty - tryy * 0.5, cx + sgn * (trx + 12), ty + tryy * 0.7, 3.4, 1.0,
      R.bone, { shift: sgn > 0 ? 0 : -1, edge: R.ink, edgeW: 0.9, spec: rgba(255, 252, 236, 255) });
  }

  // --- damage: splits, sloughing, and pooling gore
  if (dmg > 0) {
    const nc = Math.round(10 * dmg);
    for (let i = 0; i < nc; i++) {
      let x = 26 + rng() * (MAW_W - 52), y = 24 + rng() * 100, a = rng() * 6.28;
      const len = 14 + rng() * 30;
      for (let q = 0; q < len; q++) {
        a += (hash2(x, y, 540 + i) - 0.5) * 0.6;
        x += Math.cos(a); y += Math.sin(a);
        if (!(getpx(f, x, y) >>> 24)) continue;
        px(f, x, y, q < len * 0.7 ? mix(rgba(30, 8, 12, 255), R.muscle[1], hash2(x, y, 541)) : R.muscle[0]);
        over(f, x, y - 1, R.muscle[3], 0.4);
      }
    }
    const nw = Math.round(6 * clamp((dmg - 0.3) / 0.7, 0, 1));
    for (let i = 0; i < nw; i++) {
      const wx = 34 + ((i * 53) % (MAW_W - 68)), wy = 34 + ((i * 71) % 92);
      const wr = 8 + (i % 3) * 4;
      for (let y = wy - wr; y <= wy + wr; y++) {
        for (let x = wx - wr; x <= wx + wr; x++) {
          const d = Math.hypot(x - wx, y - wy) / wr;
          if (d > 1 - hash2(x, y, 550 + i) * 0.3) continue;
          if (!(getpx(f, x, y) >>> 24)) continue;
          px(f, x, y, d > 0.72 ? R.muscle[0] : mix(rgba(26, 8, 12, 255), rgba(74, 18, 22, 255), hash2(x, y, 551)));
        }
      }
      for (let q = 0; q < 5; q++) {
        const a = hash2(i, q, 552) * 6.28;
        const rr = wr * (0.6 + hash2(i, q, 553) * 0.5);
        capsule(f, wx + Math.cos(a) * wr * 0.3, wy + Math.sin(a) * wr * 0.3,
          wx + Math.cos(a) * rr, wy + Math.sin(a) * rr, 1.5, 0.7, R.muscle, { shift: q % 2 });
      }
      if (i % 2 === 0) sausages(f, wx - 4, wy + 2, wx + 3, wy + wr + 8, 4, 2.0, 560 + i);
      let dy2 = wy;
      while (dy2 < MAW_H - 2 && (getpx(f, wx, dy2 + 1) >>> 24)) dy2++;
      drip(f, wx, dy2, 4 + (i % 3) * 3, rgba(120, 24, 26, 255));
    }
  }
  // --- always wet
  wetness(f, 10, 10, MAW_W - 10, MAW_H - 10, 560, 0.0035);
  for (let i = 0; i < 8; i++) {
    const dx = 24 + i * 18;
    let dy2 = 60;
    while (dy2 < MAW_H - 3 && (getpx(f, dx, dy2 + 1) >>> 24)) dy2++;
    if (dy2 > 60) drip(f, dx, dy2, 4 + (i % 4) * 4, mix(R.muscle[2], rgba(70, 110, 60, 255), (i % 3) * 0.3));
  }
  if (o.flash) wash(f, rgba(226, 84, 44, 255), o.flash);
  if (o.dead) wash(f, rgba(26, 20, 24, 255), 0.44);
  grade(f, 1.2);
  topRim(f, WARM, 0.24, 0.1);
  sideRim(f, RIM, 0.22, 0.08);
  outline(f, R.ink);
  return f;
}

function paintMawSet(out) {
  for (let i = 0; i < 4; i++) {
    out[`maw_idle${i}`] = paintMaw({ phase: i * 1.4, throat: 0.05 + 0.05 * Math.sin(i * 1.6), sag: 0.1 * Math.sin(i * 1.1) });
  }
  out.maw_fire0 = paintMaw({ phase: 0.4, throat: 0.4, faceOpen: 0.7 });
  out.maw_fire1 = paintMaw({ phase: 0.8, throat: 0.75, faceOpen: 0.9 });
  out.maw_fire2 = paintMaw({ phase: 1.2, throat: 1, faceOpen: 1, flash: 0.08 });
  out.maw_pain = paintMaw({ phase: 2.1, throat: 0.55, faceOpen: 1, flash: 0.2, damage: 0.12 });
  for (let k = 0; k < 6; k++) {
    const t = (k + 1) / 6;
    out[`maw_die${k}`] = paintMaw({
      phase: k * 0.9, damage: t, sag: t * 1.6,
      throat: k < 3 ? 0.7 - t * 0.3 : 0.2,
      faceOpen: k < 4 ? 1 : 0.5 - t * 0.3,
      dead: k >= 5,
    });
  }
  out.maw_dead = paintMaw({ phase: 3, damage: 1, sag: 2.2, throat: 0.18, faceOpen: 0.12, dead: true });
}

// ---------------------------------------------------------------------------
// gore - cartoon butcher's shop: bones with knobs on, sausage-link guts, an
// eyeball with its cable still attached, a hand with one finger up
// ---------------------------------------------------------------------------

const GIB = 22;

function paintGib(i) {
  const f = makeFrame(GIB, GIB);
  const c = GIB / 2;
  const E = { edge: RR.ink, edgeW: 0.9 };
  const meat = GORE.meat, bone = GORE.bone;
  if (i === 0) {
    // the classic cartoon bone: a shaft with two knuckles at each end
    capsule(f, 5, 16, 16, 5, 1.9, 1.9, bone, { ...E, spec: rgba(255, 255, 255, 255) });
    for (const [x, y, a] of [[5, 16, 1], [16, 5, -1]]) {
      blob(f, x - 1.6 * a, y - 0.4 * a, 2.4, 2.4, bone, { ...E });
      blob(f, x + 0.4 * a, y + 1.6 * a, 2.4, 2.4, bone, { ...E });
      blob(f, x - 1.6 * a, y - 0.4 * a, 2.0, 2.0, bone, { shift: 1 });
      blob(f, x + 0.4 * a, y + 1.6 * a, 2.0, 2.0, bone, {});
    }
    capsule(f, 6, 15, 15, 6, 1.2, 1.2, bone, { shift: 1 });
    over(f, 10, 11, GORE.blood, 0.8); over(f, 11, 11, GORE.blood, 0.5); px(f, 9, 12, GORE.bloodD);
  } else if (i === 1) {
    // a steak: marbled meat, a rind of fat, a round bone in the middle
    blob(f, c, c + 1, 8.4, 6.4, flat(GORE.fat), { ...E });
    blob(f, c - 0.5, c + 0.5, 7.2, 5.4, meat, { grain: 0.1, seed: 601, spec: rgba(255, 190, 180, 255), specT: 0.95 });
    for (let k = 0; k < 5; k++) line(f, 5 + k * 3, 8 + (k % 2) * 3, 7 + k * 3, 13 - (k % 2), mix(GORE.fat, meat[2], 0.4));
    blob(f, c + 2, c + 1, 2.2, 2.0, bone, { ...E });
    blob(f, c + 2, c + 1, 0.9, 0.9, flat(GORE.marrow));
  } else if (i === 2) {
    // sausage-link guts, coiled
    sausages(f, 3, 6, 18, 15, 5, 2.4, 3);
  } else if (i === 3) {
    // a lower jaw, big square teeth, one of them gold
    fillPoly(f, [{ x: 2, y: 9 }, { x: 20, y: 9 }, { x: 17, y: 17 }, { x: 5, y: 17 }], GORE.bone[2]);
    capsule(f, 3, 15, 19, 15, 2.0, 2.0, GORE.bone, { ...E });
    capsule(f, 3, 11, 19, 11, 1.8, 1.8, mat(rgba(196, 76, 96, 255)), { ...E });
    for (let k = 0; k < 5; k++) {
      const tx = 4 + k * 3.2;
      box(f, Math.round(tx), 5, 3, 5, k === 3 ? mat(rgba(236, 196, 60, 255), { contrast: 1.3 }) : mat(rgba(244, 240, 226, 255)), {});
    }
    px(f, 5, 6, rgba(255, 255, 255, 255));
    over(f, 3, 13, GORE.blood, 0.8); over(f, 18, 16, GORE.blood, 0.8);
  } else if (i === 4) {
    // a severed hand, one finger raised in a last opinion
    const G = mat(rgba(214, 170, 140, 255), { contrast: 1.2 });
    blob(f, c, c + 3, 4.4, 3.8, G, { ...E });
    for (let k = 0; k < 4; k++) {
      if (k === 1) continue;
      blob(f, c - 3.4 + k * 2.3, c + 0.2, 1.3, 1.3, G, { ...E, shift: k % 2 });
    }
    capsule(f, c - 1.1, c + 1, c - 1.1, c - 7.4, 1.2, 1.1, G, { ...E, spec: rgba(255, 236, 220, 255) });
    px(f, Math.round(c - 1.4), Math.round(c - 8.2), rgba(250, 236, 226, 255));
    capsule(f, c + 3.6, c + 3.4, c + 5.6, c + 1.4, 1.1, 0.9, G, { ...E });
    stump(f, c, c + 5.5, 0, 1, 3.1, G, { len: 1, seed: 604, drips: 1, fringe: false });
  } else if (i === 5) {
    // eyeball trailing its nerve, bloodshot
    for (let k = 0; k < 7; k++) {
      const t = k / 6;
      blob(f, c - 2 - t * 6, c + 3 + Math.sin(t * 4) * 2 + t * 4, 1.2 - t * 0.4, 1.2 - t * 0.4, meat, { shift: k % 2 });
    }
    blob(f, c + 1, c - 1, 5.6, 5.4, mat(rgba(246, 244, 236, 255), { contrast: 1.1 }), { ...E, spec: rgba(255, 255, 255, 255) });
    for (let k = 0; k < 6; k++) {
      const a = k * 1.05 + 0.4;
      vein(f, c + 1 + Math.cos(a) * 5, c - 1 + Math.sin(a) * 5, a + Math.PI, 4, 0.9, rgba(210, 40, 46, 255), 610 + k);
    }
    blob(f, c + 2.4, c - 1.8, 2.8, 2.7, flat(rgba(60, 150, 200, 255)));
    blob(f, c + 2.4, c - 1.8, 1.9, 1.8, flat(rgba(40, 110, 160, 255)));
    blob(f, c + 2.6, c - 1.8, 1.3, 1.3, flat(rgba(12, 12, 16, 255)));
    px(f, Math.round(c + 1.6), Math.round(c - 3), rgba(255, 255, 255, 255));
  } else if (i === 6) {
    // a rack of ribs on a length of spine
    capsule(f, 4, 4, 4, 18, 1.8, 1.8, bone, { ...E });
    for (let k = 0; k < 4; k++) {
      const pts = [];
      for (let q = 0; q <= 6; q++) {
        const t = q / 6;
        pts.push({ x: 5 + t * 13, y: 5 + k * 3.8 + Math.sin(t * 2.4) * 2.6 });
      }
      for (let q = 0; q < 6; q++) {
        capsule(f, pts[q].x, pts[q].y, pts[q + 1].x, pts[q + 1].y, 1.2, 1.0, bone, { shift: k % 2 ? 0 : -1, ...(q ? {} : E) });
      }
    }
    for (let k = 0; k < 5; k++) blob(f, 4, 4 + k * 3.5, 1.6, 1.1, bone, { shift: 1 });
    over(f, 9, 11, GORE.blood, 0.7); over(f, 13, 15, GORE.meat[1], 0.8);
  } else {
    // a lump of brain: pink, wrinkly, surprisingly bouncy
    const B = mat(rgba(236, 150, 164, 255), { contrast: 1.2 });
    blob(f, c, c + 1, 8.0, 6.2, B, { ...E, spec: rgba(255, 230, 236, 255), specT: 0.95 });
    line(f, Math.round(c), 5, Math.round(c + 0.5), 17, B[0]);
    for (let k = 0; k < 9; k++) {
      let x = 4 + hash2(k, 1, 617) * 14, y = 6 + hash2(k, 2, 617) * 9, a = hash2(k, 3, 617) * 6.28;
      for (let q = 0; q < 6; q++) {
        a += (q % 2 ? 1.4 : -1.4);
        x += Math.cos(a) * 0.9; y += Math.sin(a) * 0.9;
        over(f, x, y, B[1], 0.8);
      }
    }
    stump(f, c + 1, c + 6, 0.2, 1, 1.8, B, { len: 0, seed: 618, drips: 1, fringe: false, bone: 0.2 });
  }
  wetness(f, 0, 0, GIB - 1, GIB - 1, 610 + i, 0.03);
  topRim(f, WARM, 0.2, 0.06);
  outline(f, RR.ink);
  return f;
}

function paintGorePool(i) {
  const f = makeFrame(48, 24);
  const cx = 24, cy = 13;
  gorePool(f, cx, cy, 9 + i * 5.5, 4 + i * 2.4, 0x3000 + i * 313, { spots: 8 + i * 7, glints: 2 + i * 2 });
  // clots and, in the bigger pools, bits you would rather not identify
  for (let k = 0; k < i * 3; k++) {
    const a = hash2(k, i, 620) * 6.28, r = hash2(k, i, 621) * (7 + i * 4);
    blob(f, cx + Math.cos(a) * r, cy + Math.sin(a) * r * 0.42, 1.6, 1.3, GORE.meat, { shift: -1 });
  }
  if (i >= 1) {
    // a floating tooth
    box(f, cx + 7, cy - 2, 2, 3, mat(rgba(244, 240, 226, 255)), {});
  }
  if (i >= 2) {
    capsule(f, cx - 4, cy + 1, cx + 6, cy - 1, 1.2, 1.2, GORE.bone, { spec: rgba(255, 255, 255, 255) });
    blob(f, cx - 5, cy + 1.6, 1.5, 1.5, GORE.bone, {}); blob(f, cx - 5, cy + 0, 1.5, 1.5, GORE.bone, {});
    blob(f, cx + 7, cy - 2.4, 1.5, 1.5, GORE.bone, {}); blob(f, cx + 7, cy - 0.6, 1.5, 1.5, GORE.bone, {});
  }
  if (i === 3) {
    // an eyeball, looking up at you from the puddle
    blob(f, cx - 12, cy + 1, 2.6, 2.2, flat(rgba(244, 242, 232, 255)));
    blob(f, cx - 11.4, cy + 0.6, 1.2, 1.1, flat(rgba(50, 130, 190, 255)));
    px(f, cx - 11, cy, rgba(12, 12, 16, 255));
    sausages(f, cx + 4, cy + 4, cx + 16, cy + 2, 3, 1.3, 7);
  }
  outline(f, rgba(24, 4, 8, 255));
  return f;
}

function paintViscera(i) {
  const f = makeFrame(28, 20);
  const rng = makeRng(0x2200 + i * 77);
  // wall splat: an impact star with strings of guts hanging out of it
  const cx = 13 + i, cy = 5 + i;
  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 28; x++) {
      const u = (x - cx) / (8 + i * 2.5), v = (y - cy) / 4.2;
      const d = Math.hypot(u, v);
      const a = Math.atan2(v, u);
      const wob = 0.7 + fbm(0x99 + i, x * 0.2, y * 0.35, 3, 8) * 0.5 + Math.max(0, Math.cos(a * 5 + i)) * 0.25;
      if (d > wob) continue;
      px(f, x, y, d > wob * 0.72 ? GORE.bloodD : (hash2(x, y, 630 + i) < 0.2 ? GORE.meat[3] : GORE.blood));
    }
  }
  const n = 2 + i;
  for (let q = 0; q < n; q++) {
    const x = cx - 6 + (q * 12 / n) + rng() * 3;
    const y = cy + 2 + rng() * 2;
    const len = 6 + rng() * (7 + i * 3);
    sausages(f, x, y, x + (rng() - 0.5) * 4, y + len, Math.max(2, Math.round(len / 3.2)), 1.3, 630 + q + i * 7);
  }
  if (i === 1) {
    // an eyeball stuck to the wall, dead centre, staring
    blob(f, cx + 3, cy - 1, 2.4, 2.3, flat(rgba(244, 242, 232, 255)), { edge: RR.ink, edgeW: 0.8 });
    blob(f, cx + 3.4, cy - 1, 1.1, 1.1, flat(rgba(50, 130, 190, 255)));
    px(f, cx + 3, cy - 2, rgba(255, 255, 255, 255));
  }
  if (i === 2) {
    capsule(f, cx - 7, cy - 2, cx - 2, cy - 4, 1.0, 1.0, GORE.bone, {});
    blob(f, cx - 7.5, cy - 1.2, 1.2, 1.2, GORE.bone, {}); blob(f, cx - 7.8, cy - 2.8, 1.2, 1.2, GORE.bone, {});
  }
  for (let k = 0; k < 6 + i * 3; k++) {
    const x = rng() * 28, y = rng() * 20;
    if (getpx(f, x, y) >>> 24) continue;
    if (rng() < 0.5) px(f, x, y, GORE.bloodD);
  }
  wetness(f, 0, 0, 27, 19, 640 + i, 0.04);
  outline(f, rgba(22, 4, 8, 255));
  return f;
}

function paintAcid(i) {
  const f = makeFrame(20, 20);
  const cx = 10, cy = 10 + i * 0.5;
  const r = 4.6 + i * 1.6;
  // a glob with a bright core, sagging as the index grows
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r * 1.3); y++) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      const sag = Math.max(0, (y - cy) / (r * 1.3));
      const u = (x - cx) / (r * (1 - sag * 0.45)), v = (y - cy) / r;
      const d = Math.hypot(u, v * 0.92);
      if (d > 1) continue;
      const k = Math.pow(1 - d, 1.3);
      px(f, x, y, mix(mix(rgba(30, 74, 38, 255), rgba(74, 176, 86, 255), k * 1.2), ROT.glow, Math.pow(k, 1.8)));
    }
  }
  blob(f, cx - 1, cy - 1.4, r * 0.34, r * 0.3, flat(rgba(228, 255, 232, 255)));
  glow(f, cx, cy, r * 1.7, ROT.glow, { halo: 0.42, tint: 0.3, seed: 650 + i, base: rgba(14, 34, 18, 255), core: 0.6 });
  // drips off the bottom, more with index
  for (let k = 0; k <= i; k++) {
    const dx = cx - 3 + k * 3.4;
    drip(f, dx, cy + r * 0.9, 3 + k * 2, mix(rgba(90, 200, 100, 255), ROT.glow, 0.4), 1.2);
  }
  // spatter
  for (let k = 0; k < 3 + i * 3; k++) {
    const a = hash2(k, i, 660) * 6.28, rr = r * (1.15 + hash2(k, i, 661) * 0.6);
    px(f, cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, mix(rgba(70, 150, 78, 255), ROT.glow, 0.5));
  }
  outline(f, rgba(18, 44, 22, 255));
  return f;
}

function paintGore(out) {
  for (let i = 0; i < 8; i++) out[`gib${i}`] = paintGib(i);
  for (let i = 0; i < 4; i++) out[`gore_pool${i}`] = paintGorePool(i);
  for (let i = 0; i < 3; i++) out[`viscera${i}`] = paintViscera(i);
  for (let i = 0; i < 3; i++) out[`acid${i}`] = paintAcid(i);
}
