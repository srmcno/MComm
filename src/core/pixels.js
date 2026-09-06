// pixels.js - shared pixel buffer conventions for NUKEHAUS.
// All image data in this project is a Uint32Array in native canvas byte order:
// little-endian 0xAABBGGRR. Use rgba() to build colors, never raw hex literals.

export const TEX = 64; // wall/floor texture edge length

/** Pack r,g,b,a (0-255) into a canvas-order u32. */
export function rgba(r, g, b, a = 255) {
  return ((a & 255) << 24 | (b & 255) << 16 | (g & 255) << 8 | (r & 255)) >>> 0;
}

export function unpack(c) {
  return { r: c & 255, g: (c >>> 8) & 255, b: (c >>> 16) & 255, a: (c >>> 24) & 255 };
}

/** Linear blend between two packed colors. t=0 -> a, t=1 -> b. */
export function mix(ca, cb, t) {
  const ar = ca & 255, ag = (ca >>> 8) & 255, ab = (ca >>> 16) & 255, aa = (ca >>> 24) & 255;
  const br = cb & 255, bg = (cb >>> 8) & 255, bb = (cb >>> 16) & 255, ba = (cb >>> 24) & 255;
  return rgba(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t, aa + (ba - aa) * t);
}

/** Multiply a packed color's RGB by scalar s (alpha preserved). */
export function shade(c, s) {
  return rgba((c & 255) * s, ((c >>> 8) & 255) * s, ((c >>> 16) & 255) * s, (c >>> 24) & 255);
}

export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
export function lerp(a, b, t) { return a + (b - a) * t; }

/** Deterministic hash-based RNG. Same seed always yields the same art. */
export function makeRng(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  return function rng() {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/** Classic value-noise field sampled on a torus so textures tile seamlessly. */
export function makeNoise(seed, period = 8) {
  const rng = makeRng(seed);
  const g = new Float32Array(period * period);
  for (let i = 0; i < g.length; i++) g[i] = rng();
  const at = (x, y) => g[(((y % period) + period) % period) * period + (((x % period) + period) % period)];
  const smooth = (t) => t * t * (3 - 2 * t);
  return function noise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = smooth(x - xi), yf = smooth(y - yi);
    const a = at(xi, yi), b = at(xi + 1, yi), c = at(xi, yi + 1), d = at(xi + 1, yi + 1);
    return (a + (b - a) * xf) + ((c + (d - c) * xf) - (a + (b - a) * xf)) * yf;
  };
}

/** Sum of octaves of makeNoise, still tiling on `period` cells. */
export function fbm(seed, x, y, octaves = 4, period = 8) {
  let sum = 0, amp = 0.5, tot = 0, p = period, fx = x, fy = y;
  for (let o = 0; o < octaves; o++) {
    sum += amp * NOISE_CACHE(seed + o * 977, p)(fx, fy);
    tot += amp; amp *= 0.5; fx *= 2; fy *= 2; p *= 2;
  }
  return sum / tot;
}

const _noiseCache = new Map();
function NOISE_CACHE(seed, period) {
  const k = seed + ':' + period;
  let n = _noiseCache.get(k);
  if (!n) { n = makeNoise(seed, period); _noiseCache.set(k, n); }
  return n;
}

/** A sprite frame: RGBA pixels with alpha 0 meaning "not drawn". */
export function makeFrame(w, h) {
  return { w, h, data: new Uint32Array(w * h) };
}

/** Alpha-aware plot into a frame. */
export function px(frame, x, y, c) {
  x |= 0; y |= 0;
  if (x < 0 || y < 0 || x >= frame.w || y >= frame.h) return;
  frame.data[y * frame.w + x] = c;
}

/** Read a pixel, returning 0 when out of bounds. */
export function getpx(frame, x, y) {
  x |= 0; y |= 0;
  if (x < 0 || y < 0 || x >= frame.w || y >= frame.h) return 0;
  return frame.data[y * frame.w + x];
}

export function fillRect(frame, x, y, w, h, c) {
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) px(frame, x + i, y + j, c);
}

export function fillCircle(frame, cx, cy, r, c) {
  const r2 = r * r;
  for (let j = -Math.ceil(r); j <= Math.ceil(r); j++) {
    for (let i = -Math.ceil(r); i <= Math.ceil(r); i++) {
      if (i * i + j * j <= r2) px(frame, cx + i, cy + j, c);
    }
  }
}

export function line(frame, x0, y0, x1, y1, c) {
  x0 |= 0; y0 |= 0; x1 |= 0; y1 |= 0;
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    px(frame, x0, y0, c);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

/** Mirror the left half of a frame onto the right half. Keeps characters symmetric. */
export function mirrorX(frame) {
  const { w, h, data } = frame;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < (w >> 1); x++) {
      data[y * w + (w - 1 - x)] = data[y * w + x];
    }
  }
  return frame;
}

/** Add a 1px dark outline around every opaque cluster. Makes sprites pop against walls. */
export function outline(frame, c = rgba(6, 4, 8, 255)) {
  const { w, h } = frame;
  const copy = frame.data.slice();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (copy[y * w + x] >>> 24) continue;
      const near = (copy[(y - 1 >= 0 ? y - 1 : 0) * w + x] >>> 24) ||
                   (copy[(y + 1 < h ? y + 1 : h - 1) * w + x] >>> 24) ||
                   (copy[y * w + (x - 1 >= 0 ? x - 1 : 0)] >>> 24) ||
                   (copy[y * w + (x + 1 < w ? x + 1 : w - 1)] >>> 24);
      if (near) frame.data[y * w + x] = c;
    }
  }
  return frame;
}
