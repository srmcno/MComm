// math.js - small numeric helpers shared across the engine.

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
export function lerp(a, b, t) { return a + (b - a) * t; }
export function invLerp(a, b, v) { return b === a ? 0 : (v - a) / (b - a); }
export function smoothstep(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }
export function sign(v) { return v < 0 ? -1 : v > 0 ? 1 : 0; }

/** Frame-rate independent exponential approach. `rate` is roughly "per second". */
export function damp(a, b, rate, dt) { return lerp(a, b, 1 - Math.exp(-rate * dt)); }

/** Wrap an angle into (-PI, PI]. */
export function wrapAngle(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/** Shortest signed angular difference from a to b. */
export function angleDelta(a, b) { return wrapAngle(b - a); }

export function dist2(ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  return dx * dx + dy * dy;
}
export function dist(ax, ay, bx, by) { return Math.sqrt(dist2(ax, ay, bx, by)); }
export function dist3(ax, ay, az, bx, by, bz) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Mulberry32: fast, seedable, good enough for gameplay randomness. */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randRange(rng, lo, hi) { return lo + rng() * (hi - lo); }
export function randInt(rng, lo, hi) { return Math.floor(lo + rng() * (hi - lo + 1)); }
export function pick(rng, arr) { return arr[Math.floor(rng() * arr.length) % arr.length]; }

/** Shuffle in place. */
export function shuffle(rng, arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

/** Format a number with thousands separators, for the score readouts. */
export function commas(n) {
  return String(Math.max(0, Math.round(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function pad(n, w, c = '0') { return String(n).padStart(w, c); }

export function mmss(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return pad(Math.floor(s / 60), 2) + ':' + pad(s % 60, 2);
}
