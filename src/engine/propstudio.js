// propstudio.js - the bunker's furniture, built from solids and rendered.
//
// The first set dressing was painted straight into small billboards from one
// angle, so a desk seen from the side was still the front of a desk. Here a
// prop is a little model instead: boxes, cylinders, cones and ellipsoids in
// its own space, each with a material (wood with a grain that runs along the
// plank, painted steel worn back at the edges, fabric, glass, a lit screen).
// The studio ray-traces the model from eight directions around it, a little
// from above, the way you see furniture from standing height:
//
//   * light from the ceiling fixtures (fixed to the room, so the top of a
//     desk is lit whichever side you see it from), with its shadow, so the
//     drawers under a desk top sit in the dark;
//   * a softer key from over the viewer's left shoulder, the same one the
//     painted cast is lit by, so furniture and staff read as one set;
//   * ambient occlusion from the depth buffer, bevelled edges that catch the
//     light, grime near the floor;
//   * a soft contact shadow on the floor under it, which is most of what
//     makes a billboard look like it is standing on something.
//
// Model space: x is the prop's own right as you face its front, y is up from
// the floor, z points out of its front. One world unit is one wall cell. A
// frame is PPU pixels to the world unit whatever it shows, and carries how far
// below its foot the picture reaches (`below`), because seen from above the
// front edge of a desk is lower on screen than its middle.
//
// Frames are made on demand and kept: the level asks for what it holds while
// the briefing card is up (prewarm), and anything else (a wreck, a machine
// halfway through falling over) is made the first time it is seen.

import { makeFrame } from '../core/pixels.js';

export const PPU = 128;
export const DIRS = 8;
const PITCH = 17 * Math.PI / 180;
const FAR = 20;
const INK = [16, 12, 20];

// ------------------------------------------------------------------ noise

function hash3(x, y, z, s) {
  let h = (Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 2147483647) ^ Math.imul(s | 0, 1274126177)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
// Value noise from a fixed lattice: a table lookup is several times cheaper
// than hashing eight corners, and a 32-cell period never shows on a prop.
const LAT = (() => {
  const t = new Float32Array(32768);
  for (let i = 0; i < t.length; i++) t[i] = hash3(i, i >>> 5, i >>> 10, 77);
  return t;
})();
function vnoise(x, y, z, s) {
  x += (s * 7.31) % 32; y += (s * 3.17) % 32;
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy), uz = fz * fz * (3 - 2 * fz);
  const x0 = ix & 31, x1 = (ix + 1) & 31, y0 = (iy & 31) << 5, y1 = ((iy + 1) & 31) << 5;
  const z0 = (iz & 31) << 10, z1 = ((iz + 1) & 31) << 10;
  const a = LAT[x0 + y0 + z0], b = LAT[x1 + y0 + z0], c = LAT[x0 + y1 + z0], d = LAT[x1 + y1 + z0];
  const e = LAT[x0 + y0 + z1], f = LAT[x1 + y0 + z1], g = LAT[x0 + y1 + z1], h = LAT[x1 + y1 + z1];
  const k1 = a + (b - a) * ux, k2 = c + (d - c) * ux, k3 = e + (f - e) * ux, k4 = g + (h - g) * ux;
  const m1 = k1 + (k2 - k1) * uy, m2 = k3 + (k4 - k3) * uy;
  return m1 + (m2 - m1) * uz;
}
function fbm(x, y, z, s, oct = 3) {
  let v = 0, a = 0.5, f = 1, n = 0;
  for (let i = 0; i < oct; i++) { v += vnoise(x * f, y * f, z * f, s + i * 31) * a; n += a; a *= 0.5; f *= 2.03; }
  return v / n;
}
const sstep = (a, b, t) => { t = (t - a) / (b - a); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };

// ------------------------------------------------------------------ lettering

// 3x5 capitals and digits, for stencils, labels and badges.
const FONT = {
  A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110', E: '111100110100111',
  F: '111100110100100', G: '011100101101011', H: '101101111101101', I: '111010010010111', J: '001001001101010',
  K: '101101110101101', L: '100100100100111', M: '101111111101101', N: '110101101101101', O: '010101101101010',
  P: '110101110100100', Q: '010101101110011', R: '110101110101101', S: '011100010001110', T: '111010010010010',
  U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101', Y: '101101010010010',
  Z: '111001010100111', 0: '111101101101111', 1: '010110010010111', 2: '110001010100111', 3: '110001010001110',
  4: '101101111001001', 5: '111100110001110', 6: '011100111101111', 7: '111001010010010', 8: '111101111101111',
  9: '111101111001110', '-': '000000111000000', '.': '000000000000010', '!': '010010010000010', '/': '001001010100100',
  '#': '101111101111101', '%': '101001010100101', '+': '000010111010000', ':': '000010000010000', "'": '010010000000000',
};

/**
 * Is (u, v), in 0..1 across a label box, on the ink of `text`? Letters are 3
 * wide with a 1 gap, 5 tall; the text is centred and fills the box height.
 */
export function inkAt(text, u, v) {
  const n = text.length;
  if (!n || u < 0 || u >= 1 || v < 0 || v >= 1) return false;
  const cols = n * 4 - 1;
  const cx = Math.floor(u * cols), cy = Math.floor(v * 5);
  const ch = text[(cx / 4) | 0];
  const gx = cx % 4;
  if (gx === 3) return false;
  const g = FONT[ch];
  return !!g && g[cy * 3 + gx] === '1';
}

// ------------------------------------------------------------------ materials

/**
 * kind: wood | paint | metal | plastic | fabric | glass | screen | porcelain |
 * rubber | paper | burlap | brass | leather | foam | light
 *   c      base colour [r, g, b]
 *   gloss  0..1, how much specular it has (per kind default)
 *   pw     specular exponent
 *   rust   0..1 blotches of rust (paint, metal)
 *   wear   0..1 bare metal showing at the edges (paint)
 *   grain  wood grain strength
 *   glow   screens and lamps: how much of it is its own light
 */
export function mat(kind, c, o = {}) {
  const D = MAT_DEFAULTS[kind] || MAT_DEFAULTS.plastic;
  return { kind, c, gloss: D.gloss, pw: D.pw, rust: 0, wear: D.wear || 0, grain: D.grain || 0, glow: D.glow || 0, ...o };
}
const MAT_DEFAULTS = {
  wood: { gloss: 0.18, pw: 14, grain: 1 },
  paint: { gloss: 0.3, pw: 22, wear: 0.5 },
  metal: { gloss: 0.7, pw: 30 },
  brass: { gloss: 0.8, pw: 26 },
  plastic: { gloss: 0.35, pw: 30 },
  fabric: { gloss: 0.02, pw: 6 },
  leather: { gloss: 0.25, pw: 12 },
  glass: { gloss: 0.9, pw: 60 },
  screen: { gloss: 0.5, pw: 50, glow: 0.85 },
  light: { gloss: 0, pw: 1, glow: 1 },
  porcelain: { gloss: 0.75, pw: 40 },
  rubber: { gloss: 0.08, pw: 8 },
  paper: { gloss: 0.02, pw: 4 },
  burlap: { gloss: 0.0, pw: 4 },
  foam: { gloss: 0.05, pw: 6 },
  bone: { gloss: 0.15, pw: 10 },
  flesh: { gloss: 0.45, pw: 18 },
};

// ------------------------------------------------------------------ transforms

// A transform is [r00 r01 r02 r10 r11 r12 r20 r21 r22 tx ty tz]: a rotation
// taking local directions to model space, and where the local origin sits.
const IDENT = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

function rotYXZ(yaw, pitch, roll) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cx = Math.cos(pitch), sx = Math.sin(pitch);
  const cz = Math.cos(roll), sz = Math.sin(roll);
  // R = Ry(yaw) * Rx(pitch) * Rz(roll)
  const rx = [1, 0, 0, 0, cx, -sx, 0, sx, cx];
  const ry = [cy, 0, sy, 0, 1, 0, -sy, 0, cy];
  const rz = [cz, -sz, 0, sz, cz, 0, 0, 0, 1];
  return mul3(mul3(ry, rx), rz);
}
function mul3(a, b) {
  const o = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    o[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  }
  return o;
}
function compose(P, R, t) {
  // parent P (12), child rotation R (9) and translation t (3)
  const r = mul3(P, R);
  return [...r,
    P[0] * t[0] + P[1] * t[1] + P[2] * t[2] + P[9],
    P[3] * t[0] + P[4] * t[1] + P[5] * t[2] + P[10],
    P[6] * t[0] + P[7] * t[1] + P[8] * t[2] + P[11]];
}

// ------------------------------------------------------------------ the model

const T_BOX = 0, T_CYL = 1, T_CONE = 2, T_SPH = 3;

/**
 * What a model function draws with. Positions and sizes are in world units.
 *   box(c, s, m, o)    centred at c, full size s = [w, h, d]
 *   slab(x0, y0, z0, x1, y1, z1, m, o)   the same by its corners
 *   cyl(c, r, h, m, o) upright by default; o.axis 'x' or 'z' lays it down
 *   cone(c, r0, r1, h, m, o)   r0 at the bottom, r1 at the top
 *   sph(c, r, m, o)    r a number or [rx, ry, rz]
 *   rod(a, b, r, m, o) a cylinder from point a to point b (legs, rails, pipes)
 *   push(t, yaw, pitch, roll) / pop()   a sub-assembly: a drawer, a door
 * o: { yaw, pitch, roll } in radians, bevel (box edge radius, world units),
 *    paint(u, v, face, lp) -> [r, g, b] | null, to print on a face.
 */
export class Model {
  constructor(state = 'ok', seed = 1, variant = 0) {
    this.prims = [];
    this.stack = [IDENT];
    this.state = state;
    this.variant = variant;
    this.seed = seed >>> 0;
    let s = this.seed || 1;
    this.rng = () => { s = (Math.imul(s ^ (s >>> 15), 2246822519) + 0x9e3779b9) >>> 0; return s / 4294967296; };
    this.wreck = state === 'wreck';
    this.hurt = state === 'hurt' || state === 'wreck';
  }
  push(t = [0, 0, 0], yaw = 0, pitch = 0, roll = 0) {
    this.stack.push(compose(this.stack[this.stack.length - 1], rotYXZ(yaw, pitch, roll), t));
    return this;
  }
  pop() { if (this.stack.length > 1) this.stack.pop(); return this; }
  _add(type, c, half, m, o = {}) {
    const top = this.stack[this.stack.length - 1];
    let R = rotYXZ(o.yaw || 0, o.pitch || 0, o.roll || 0);
    let cc = c;
    if (this.wreck && !o.keep) {
      // A wreck is its own parts knocked askew; small ones go missing.
      const vol = half[0] * half[1] * half[2];
      if (!o.fixed && vol < 0.00012 && this.rng() < 0.35) return null;
      const j = o.fixed ? 0.02 : 0.16;
      R = mul3(rotYXZ((this.rng() - 0.5) * j * 2, (this.rng() - 0.5) * j, (this.rng() - 0.5) * j), R);
      cc = [c[0] + (this.rng() - 0.5) * 0.02, c[1], c[2] + (this.rng() - 0.5) * 0.02];
    }
    const X = compose(top, R, cc);
    const p = { type, X, half, m, bevel: o.bevel || 0, paint: o.paint || null, id: this.prims.length, holes: o.holes };
    this.prims.push(p);
    return p;
  }
  box(c, s, m, o) { return this._add(T_BOX, c, [s[0] / 2, s[1] / 2, s[2] / 2], m, o); }
  slab(x0, y0, z0, x1, y1, z1, m, o) {
    return this.box([(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], [Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0)], m, o);
  }
  cyl(c, r, h, m, o = {}) {
    const oo = { ...o };
    if (o.axis === 'x') oo.roll = (o.roll || 0) + Math.PI / 2;
    else if (o.axis === 'z') oo.pitch = (o.pitch || 0) + Math.PI / 2;
    return this._add(T_CYL, c, [r, h / 2, r], m, oo);
  }
  cone(c, r0, r1, h, m, o = {}) {
    const oo = { ...o };
    if (o.axis === 'x') oo.roll = (o.roll || 0) - Math.PI / 2;
    else if (o.axis === 'z') oo.pitch = (o.pitch || 0) + Math.PI / 2;
    const p = this._add(T_CONE, c, [Math.max(r0, r1), h / 2, Math.max(r0, r1)], m, oo);
    if (p) { p.r0 = r0; p.r1 = r1; }
    return p;
  }
  sph(c, r, m, o) { const rr = typeof r === 'number' ? [r, r, r] : r; return this._add(T_SPH, c, rr, m, o); }
  rod(a, b, r, m, o = {}) {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const L = Math.hypot(dx, dy, dz) || 1e-6;
    // Point local +y along a->b: yaw about y, then pitch the column over.
    const yaw = Math.atan2(dx, dz);
    const pitch = Math.acos(Math.max(-1, Math.min(1, dy / L)));
    return this._add(T_CYL, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], [r, L / 2, r], m, { ...o, yaw, pitch });
  }
}

// ------------------------------------------------------------------ intersection

// Local-space hits. Each returns t (>0) or -1, and leaves the local normal in N.
const N = new Float64Array(3);

function hitBox(ox, oy, oz, dx, dy, dz, h) {
  let tmin = -1e30, tmax = 1e30, ax = -1, sg = 0;
  const hx = h[0], hy = h[1], hz = h[2];
  if (dx > -1e-12 && dx < 1e-12) { if (ox < -hx || ox > hx) return -1; }
  else {
    const inv = 1 / dx;
    let t1 = (-hx - ox) * inv, t2 = (hx - ox) * inv, s = -1;
    if (t1 > t2) { const q = t1; t1 = t2; t2 = q; s = 1; }
    if (t1 > tmin) { tmin = t1; ax = 0; sg = s; }
    if (t2 < tmax) tmax = t2;
  }
  if (dy > -1e-12 && dy < 1e-12) { if (oy < -hy || oy > hy) return -1; }
  else {
    const inv = 1 / dy;
    let t1 = (-hy - oy) * inv, t2 = (hy - oy) * inv, s = -1;
    if (t1 > t2) { const q = t1; t1 = t2; t2 = q; s = 1; }
    if (t1 > tmin) { tmin = t1; ax = 1; sg = s; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  if (dz > -1e-12 && dz < 1e-12) { if (oz < -hz || oz > hz) return -1; }
  else {
    const inv = 1 / dz;
    let t1 = (-hz - oz) * inv, t2 = (hz - oz) * inv, s = -1;
    if (t1 > t2) { const q = t1; t1 = t2; t2 = q; s = 1; }
    if (t1 > tmin) { tmin = t1; ax = 2; sg = s; }
    if (t2 < tmax) tmax = t2;
  }
  if (tmin > tmax || tmin <= 1e-6 || ax < 0) return -1;
  N[0] = N[1] = N[2] = 0; N[ax] = sg;
  return tmin;
}

function hitCyl(ox, oy, oz, dx, dy, dz, h) {
  const r = h[0], hh = h[1];
  let best = -1;
  const a = dx * dx + dz * dz;
  if (a > 1e-12) {
    const b = 2 * (ox * dx + oz * dz), c = ox * ox + oz * oz - r * r;
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const t = (-b - Math.sqrt(disc)) / (2 * a);
      if (t > 1e-6) {
        const y = oy + t * dy;
        if (y >= -hh && y <= hh) { best = t; N[0] = (ox + t * dx) / r; N[1] = 0; N[2] = (oz + t * dz) / r; }
      }
    }
  }
  if (dy > 1e-12 || dy < -1e-12) {
    const yc = dy > 0 ? -hh : hh;
    const t = (yc - oy) / dy;
    if (t > 1e-6 && (best < 0 || t < best)) {
      const x = ox + t * dx, z = oz + t * dz;
      if (x * x + z * z <= r * r) { best = t; N[0] = 0; N[1] = dy > 0 ? -1 : 1; N[2] = 0; }
    }
  }
  return best;
}

function hitCone(ox, oy, oz, dx, dy, dz, h, r0, r1) {
  const hh = h[1];
  const rm = (r0 + r1) / 2, k = (r1 - r0) / (2 * hh);
  let best = -1;
  const a = dx * dx + dz * dz - k * k * dy * dy;
  const ro = rm + k * oy;
  const b = 2 * (ox * dx + oz * dz - k * ro * dy);
  const c = ox * ox + oz * oz - ro * ro;
  if (a > 1e-12 || a < -1e-12) {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      const ta = (-b - sq) / (2 * a), tb = (-b + sq) / (2 * a);
      for (const t of ta < tb ? [ta, tb] : [tb, ta]) {
        if (t <= 1e-6) continue;
        const y = oy + t * dy;
        if (y < -hh || y > hh) continue;
        const ry = rm + k * y;
        if (ry < 0) continue;
        best = t;
        const x = ox + t * dx, z = oz + t * dz;
        const nl = Math.hypot(x, -k * ry, z) || 1;
        N[0] = x / nl; N[1] = -k * ry / nl; N[2] = z / nl;
        break;
      }
    }
  }
  if (dy > 1e-12 || dy < -1e-12) {
    const yc = dy > 0 ? -hh : hh, rc = dy > 0 ? r0 : r1;
    if (rc > 0) {
      const t = (yc - oy) / dy;
      if (t > 1e-6 && (best < 0 || t < best)) {
        const x = ox + t * dx, z = oz + t * dz;
        if (x * x + z * z <= rc * rc) { best = t; N[0] = 0; N[1] = dy > 0 ? -1 : 1; N[2] = 0; }
      }
    }
  }
  return best;
}

function hitSph(ox, oy, oz, dx, dy, dz, h) {
  const px = ox / h[0], py = oy / h[1], pz = oz / h[2];
  const qx = dx / h[0], qy = dy / h[1], qz = dz / h[2];
  const a = qx * qx + qy * qy + qz * qz, b = 2 * (px * qx + py * qy + pz * qz), c = px * px + py * py + pz * pz - 1;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  if (t <= 1e-6) return -1;
  const x = ox + t * dx, y = oy + t * dy, z = oz + t * dz;
  const nx = x / (h[0] * h[0]), ny = y / (h[1] * h[1]), nz = z / (h[2] * h[2]);
  const nl = Math.hypot(nx, ny, nz) || 1;
  N[0] = nx / nl; N[1] = ny / nl; N[2] = nz / nl;
  return t;
}

function hitPrim(p, ox, oy, oz, dx, dy, dz) {
  switch (p.type) {
    case T_BOX: return hitBox(ox, oy, oz, dx, dy, dz, p.half);
    case T_CYL: return hitCyl(ox, oy, oz, dx, dy, dz, p.half);
    case T_CONE: return hitCone(ox, oy, oz, dx, dy, dz, p.half, p.r0, p.r1);
    default: return hitSph(ox, oy, oz, dx, dy, dz, p.half);
  }
}

/** Model-space ray to a prim's local space. */
function toLocal(p, x, y, z, out) {
  const X = p.X;
  const qx = x - X[9], qy = y - X[10], qz = z - X[11];
  out[0] = X[0] * qx + X[3] * qy + X[6] * qz;
  out[1] = X[1] * qx + X[4] * qy + X[7] * qz;
  out[2] = X[2] * qx + X[5] * qy + X[8] * qz;
}
function dirLocal(p, x, y, z, out) {
  const X = p.X;
  out[0] = X[0] * x + X[3] * y + X[6] * z;
  out[1] = X[1] * x + X[4] * y + X[7] * z;
  out[2] = X[2] * x + X[5] * y + X[8] * z;
}

function prepare(prims) {
  for (const p of prims) {
    const h = p.half;
    p.rad = p.type === T_BOX ? Math.hypot(h[0], h[1], h[2]) : p.type === T_SPH ? Math.max(h[0], h[1], h[2]) : Math.hypot(h[0], h[1]);
    // model-space corners of the local bounding box
    const cs = [];
    for (let i = 0; i < 8; i++) {
      const lx = i & 1 ? h[0] : -h[0], ly = i & 2 ? h[1] : -h[1], lz = i & 4 ? h[2] : -h[2];
      const X = p.X;
      cs.push([X[0] * lx + X[1] * ly + X[2] * lz + X[9], X[3] * lx + X[4] * ly + X[5] * lz + X[10], X[6] * lx + X[7] * ly + X[8] * lz + X[11]]);
    }
    p.corners = cs;
  }
}

/** Does anything block the model-space ray from (x,y,z) along (dx,dy,dz)? */
const _o = new Float64Array(3), _d = new Float64Array(3);
function occluded(prims, x, y, z, dx, dy, dz, skip) {
  for (let i = 0; i < prims.length; i++) {
    const p = prims[i];
    if (p === skip) continue;
    // bounding sphere first
    const cx = p.X[9] - x, cy = p.X[10] - y, cz = p.X[11] - z;
    const tc = cx * dx + cy * dy + cz * dz;
    if (tc < -p.rad) continue;
    const d2 = cx * cx + cy * cy + cz * cz - tc * tc;
    if (d2 > p.rad * p.rad) continue;
    toLocal(p, x, y, z, _o); dirLocal(p, dx, dy, dz, _d);
    if (hitPrim(p, _o[0], _o[1], _o[2], _d[0], _d[1], _d[2]) > 0.004) return true;
  }
  return false;
}

// ------------------------------------------------------------------ shading

const LP = new Float64Array(3);

/** The surface colour at a hit, before light. Writes into out[0..2], returns gloss scale. */
function albedo(p, lx, ly, lz, nx, ny, nz, my, st, out) {
  const m = p.m, h = p.half;
  let r = m.c[0], g = m.c[1], b = m.c[2];
  const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
  const face = ax >= ay && ax >= az ? (nx > 0 ? 0 : 1) : ay >= az ? (ny > 0 ? 2 : 3) : (nz > 0 ? 4 : 5);
  const seed = (p.id * 97 + 13) | 0;
  let gl = 1;

  // printed faces first: labels, panels, screens
  if (p.paint && p.type === T_BOX) {
    let u, v;
    switch (face) {
      case 4: u = (lx + h[0]) / (2 * h[0]); v = (h[1] - ly) / (2 * h[1]); break;          // front
      case 5: u = (h[0] - lx) / (2 * h[0]); v = (h[1] - ly) / (2 * h[1]); break;          // back
      case 0: u = (h[2] - lz) / (2 * h[2]); v = (h[1] - ly) / (2 * h[1]); break;          // right side
      case 1: u = (lz + h[2]) / (2 * h[2]); v = (h[1] - ly) / (2 * h[1]); break;          // left side
      case 2: u = (lx + h[0]) / (2 * h[0]); v = (lz + h[2]) / (2 * h[2]); break;          // top
      default: u = (lx + h[0]) / (2 * h[0]); v = (h[2] - lz) / (2 * h[2]); break;         // bottom
    }
    const c = p.paint(u, v, face, lx, ly, lz);
    if (c) { r = c[0]; g = c[1]; b = c[2]; if (c[3] !== undefined) gl = c[3]; }
  } else if (p.paint) {
    const c = p.paint(0, 0, face, lx, ly, lz);
    if (c) { r = c[0]; g = c[1]; b = c[2]; if (c[3] !== undefined) gl = c[3]; }
  }

  let k = 1;
  switch (m.kind) {
    case 'wood': {
      // grain runs along the longest side of the piece
      const L = h[0] >= h[1] && h[0] >= h[2] ? 0 : h[1] >= h[2] ? 1 : 2;
      const along = L === 0 ? lx : L === 1 ? ly : lz;
      const a1 = L === 0 ? ly : lx, a2 = L === 2 ? ly : lz;
      const warp = fbm(along * 3, a1 * 3, a2 * 3, seed, 2);
      const ring = Math.sin((a1 * 90 + a2 * 70 + warp * 9) ) * 0.5 + 0.5;
      const streak = fbm(along * 2.5, a1 * 60, a2 * 60, seed + 7, 2);
      k = 0.8 + 0.14 * ring * m.grain + 0.18 * (streak - 0.5) * m.grain;
      if (hash3(Math.floor(along * 14), Math.floor(a1 * 30), Math.floor(a2 * 30), seed + 3) < 0.004) k *= 0.6;   // a knot
      break;
    }
    case 'paint': case 'metal': case 'brass': {
      k = 0.93 + 0.1 * (fbm(lx * 22, ly * 22, lz * 22, seed, 2) - 0.5);
      if (m.kind === 'metal') k += 0.07 * (vnoise(lx * 4, ly * 140, lz * 4, seed + 5) - 0.5);    // brushed
      if (m.rust > 0) {
        const ru = fbm(lx * 9 + 3, ly * 9, lz * 9, seed + 11, 3);
        const t = sstep(0.72 - m.rust * 0.3, 0.8 - m.rust * 0.2, ru);
        if (t > 0) { r += (128 - r) * t; g += (66 - g) * t; b += (36 - b) * t; gl *= 1 - t * 0.8; }
      }
      break;
    }
    case 'fabric': case 'burlap': {
      const f = m.kind === 'burlap' ? 70 : 150;
      const w1 = (Math.floor(lx * f + ly * f * 0.3) + Math.floor(lz * f + ly * f * 0.7)) & 1;
      k = 0.88 + 0.08 * w1 + 0.12 * (fbm(lx * 12, ly * 12, lz * 12, seed, 2) - 0.5);
      break;
    }
    case 'paper': k = 0.95 + 0.05 * (hash3(Math.floor(lx * 200), Math.floor(ly * 200), Math.floor(lz * 200), seed) - 0.5); break;
    case 'glass': {
      const s = Math.sin((lx + ly * 1.6) * 30) > 0.93 ? 1.4 : 1;
      k = s;
      break;
    }
    case 'screen': case 'light': break;
    case 'flesh': k = 0.85 + 0.3 * (fbm(lx * 18, ly * 18, lz * 18, seed, 3) - 0.5); break;
    default: k = 0.96 + 0.06 * (fbm(lx * 30, ly * 30, lz * 30, seed, 2) - 0.5);
  }
  r *= k; g *= k; b *= k;

  // box edges: bare metal where paint has chipped, a highlight where wood is worn
  if (p.type === T_BOX && m.kind !== 'screen' && m.kind !== 'light') {
    const e0 = h[0] - Math.abs(lx), e1 = h[1] - Math.abs(ly), e2 = h[2] - Math.abs(lz);
    const s1 = face < 2 ? Math.min(e1, e2) : face < 4 ? Math.min(e0, e2) : Math.min(e0, e1);
    if (s1 < 0.012) {
      const t = 1 - s1 / 0.012;
      if (m.kind === 'paint' && m.wear > 0 && hash3(Math.floor(lx * 80), Math.floor(ly * 80), Math.floor(lz * 80), seed + 9) < m.wear * 0.7) {
        r += (170 - r) * t * 0.7; g += (170 - g) * t * 0.7; b += (176 - b) * t * 0.7;
      } else {
        r *= 1 + 0.12 * t; g *= 1 + 0.12 * t; b *= 1 + 0.12 * t;
      }
    }
  }

  // damage: pits from rounds, then scorch
  if (st > 0 && m.kind !== 'light') {
    const q = 34;
    const cx = Math.floor(lx * q), cy = Math.floor(ly * q), cz = Math.floor(lz * q);
    if (hash3(cx, cy, cz, seed + 61) < 0.025 * st) {
      const fx = lx * q - cx - 0.5, fy = ly * q - cy - 0.5, fz = lz * q - cz - 0.5;
      const d = fx * fx + fy * fy + fz * fz;
      if (d < 0.12) { r *= 0.2; g *= 0.18; b *= 0.18; gl = 0; }
      else if (d < 0.2) { r *= 1.25; g *= 1.2; b *= 1.15; }
    }
    if (st > 1) {
      const burn = sstep(0.45, 0.72, fbm(lx * 6 + 9, ly * 6, lz * 6, seed + 71, 3));
      r *= 1 - burn * 0.72; g *= 1 - burn * 0.75; b *= 1 - burn * 0.75; gl *= 1 - burn;
    }
  }

  // grime where it meets the floor
  const gr = 0.72 + 0.28 * sstep(0.0, 0.07, my);
  out[0] = r * gr; out[1] = g * gr; out[2] = b * gr;
  return gl;
}

// ------------------------------------------------------------------ render

/**
 * Render a built model seen from azimuth `theta` (0: in front of it, PI/2: off
 * its right side). Returns a frame with .below (world units the picture
 * reaches under the foot) and .ppu, or null for an empty model.
 */
export function renderModel(model, theta, o = {}) {
  const prims = model.prims;
  if (!prims.length) return null;
  prepare(prims);
  const st = o.damage !== undefined ? o.damage : model.state === 'wreck' ? 2 : model.state === 'hurt' ? 1 : 0;
  const ppu = o.ppu || PPU;
  const cp = Math.cos(PITCH), sp = Math.sin(PITCH);
  const ct = Math.cos(theta), stt = Math.sin(theta);
  // camera basis in model space
  const fx = -stt * cp, fy = -sp, fz = -ct * cp;             // looking in
  let rx = -fz, rz = fx; const rl = Math.hypot(rx, rz); rx /= rl; rz /= rl;  // right
  const ux = 0 * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - 0 * fx;  // up = r x f

  // bounds on screen, including the floor under it for the shadow
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
  let fminx = 1e9, fmaxx = -1e9, fminz = 1e9, fmaxz = -1e9;
  for (const p of prims) {
    for (const c of p.corners) {
      const sx = c[0] * rx + c[2] * rz, sy = c[0] * ux + c[1] * uy + c[2] * uz;
      if (sx < minX) minX = sx; if (sx > maxX) maxX = sx;
      if (sy < minY) minY = sy; if (sy > maxY) maxY = sy;
      if (c[0] < fminx) fminx = c[0]; if (c[0] > fmaxx) fmaxx = c[0];
      if (c[2] < fminz) fminz = c[2]; if (c[2] > fmaxz) fmaxz = c[2];
    }
  }
  const sh = o.shadow === false ? 0 : 0.05;
  for (const x of [fminx - sh, fmaxx + sh]) for (const z of [fminz - sh, fmaxz + sh]) {
    const sx = x * rx + z * rz, sy = x * ux + z * uz;
    if (sx < minX) minX = sx; if (sx > maxX) maxX = sx;
    if (sy < minY) minY = sy; if (sy > maxY) maxY = sy;
  }
  const half = Math.max(-minX, maxX) + 2 / ppu;
  const W = Math.max(2, Math.ceil(half * 2 * ppu)) | 0;
  const top = maxY + 2 / ppu, bot = minY - 2 / ppu;
  const H = Math.max(2, Math.ceil((top - bot) * ppu)) | 0;
  const n = W * H;
  const depth = new Float32Array(n).fill(1e9);
  const pid = new Int16Array(n).fill(-1);
  const inv = 1 / ppu;
  const cx0 = W / 2;

  // --- visibility: each prim tests the pixels its box covers
  const Lr = new Float64Array(3), Lu = new Float64Array(3), L0 = new Float64Array(3), Ld = new Float64Array(3);
  for (let pi = 0; pi < prims.length; pi++) {
    const p = prims[pi];
    let a = 1e9, b = -1e9, c = 1e9, d = -1e9;
    for (const q of p.corners) {
      const sx = q[0] * rx + q[2] * rz, sy = q[0] * ux + q[1] * uy + q[2] * uz;
      if (sx < a) a = sx; if (sx > b) b = sx; if (sy < c) c = sy; if (sy > d) d = sy;
    }
    const x0 = Math.max(0, Math.floor(cx0 + a * ppu) - 1), x1 = Math.min(W - 1, Math.ceil(cx0 + b * ppu) + 1);
    const y0 = Math.max(0, Math.floor((top - d) * ppu) - 1), y1 = Math.min(H - 1, Math.ceil((top - c) * ppu) + 1);
    dirLocal(p, rx, 0, rz, Lr);
    dirLocal(p, ux, uy, uz, Lu);
    toLocal(p, -fx * FAR, -fy * FAR, -fz * FAR, L0);
    dirLocal(p, fx, fy, fz, Ld);
    for (let y = y0; y <= y1; y++) {
      const sy = top - (y + 0.5) * inv;
      for (let x = x0; x <= x1; x++) {
        const sx = (x + 0.5 - cx0) * inv;
        const ox = L0[0] + Lr[0] * sx + Lu[0] * sy, oy = L0[1] + Lr[1] * sx + Lu[1] * sy, oz = L0[2] + Lr[2] * sx + Lu[2] * sy;
        const t = hitPrim(p, ox, oy, oz, Ld[0], Ld[1], Ld[2]);
        if (t > 0) {
          const i = y * W + x;
          if (t < depth[i]) { depth[i] = t; pid[i] = pi; }
        }
      }
    }
  }

  // --- light
  const ovh = norm3(0.28, 1, 0.38);
  const key = norm3(-0.62 * rx + 0.58 * ux - 0.55 * fx, 0.58 * uy - 0.55 * fy, -0.62 * rz + 0.58 * uz - 0.55 * fz);
  const rim = norm3(0.7 * rx + 0.2 * ux + 0.68 * fx, 0.2 * uy + 0.68 * fy, 0.7 * rz + 0.2 * uz + 0.68 * fz);
  const vx = -fx, vy = -fy, vz = -fz;
  const hk = norm3(key[0] + vx, key[1] + vy, key[2] + vz);
  const ho = norm3(ovh[0] + vx, ovh[1] + vy, ovh[2] + vz);

  const f = makeFrame(W, H);
  const out = f.data;
  const col = new Float64Array(3);
  const lit = new Float32Array(n * 3);
  const Pm = new Float64Array(3), Nm = new Float64Array(3);

  for (let y = 0; y < H; y++) {
    const sy = top - (y + 0.5) * inv;
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const pi = pid[i];
      if (pi < 0) continue;
      const p = prims[pi];
      const sx = (x + 0.5 - cx0) * inv;
      const t = depth[i];
      // model-space point
      const mx = sx * rx + sy * ux - fx * FAR + fx * t;
      const my = sy * uy - fy * FAR + fy * t;
      const mz = sx * rz + sy * uz - fz * FAR + fz * t;
      // local point and normal again, for the winning prim only
      toLocal(p, mx - fx * 0.001, my - fy * 0.001, mz - fz * 0.001, LP);
      dirLocal(p, fx, fy, fz, Ld);
      hitPrim(p, LP[0], LP[1], LP[2], Ld[0], Ld[1], Ld[2]);
      const lx = LP[0] + Ld[0] * 0.001, ly = LP[1] + Ld[1] * 0.001, lz = LP[2] + Ld[2] * 0.001;
      let nx = N[0], ny = N[1], nz = N[2];
      // bevel: round the normal toward the edge it is near
      if (p.type === T_BOX && p.bevel > 0) {
        const h = p.half, bv = p.bevel;
        const ex = h[0] - Math.abs(lx), ey = h[1] - Math.abs(ly), ez = h[2] - Math.abs(lz);
        if (Math.abs(nx) < 0.5 && ex < bv) nx += Math.sign(lx) * (1 - ex / bv) * 0.9;
        if (Math.abs(ny) < 0.5 && ey < bv) ny += Math.sign(ly) * (1 - ey / bv) * 0.9;
        if (Math.abs(nz) < 0.5 && ez < bv) nz += Math.sign(lz) * (1 - ez / bv) * 0.9;
        const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
      }
      const gl = albedo(p, lx, ly, lz, nx, ny, nz, my, st, col);
      // normal to model space
      const X = p.X;
      Nm[0] = X[0] * nx + X[1] * ny + X[2] * nz;
      Nm[1] = X[3] * nx + X[4] * ny + X[5] * nz;
      Nm[2] = X[6] * nx + X[7] * ny + X[8] * nz;
      const m = p.m;
      let R, G, B;
      if (m.glow >= 0.999) {
        R = col[0]; G = col[1]; B = col[2];
      } else {
        const shadowed = occluded(prims, mx + Nm[0] * 0.004, my + Nm[1] * 0.004, mz + Nm[2] * 0.004, ovh[0], ovh[1], ovh[2], p);
        const dO = Math.max(0, Nm[0] * ovh[0] + Nm[1] * ovh[1] + Nm[2] * ovh[2]) * (shadowed ? 0.18 : 1);
        const kd = Nm[0] * key[0] + Nm[1] * key[1] + Nm[2] * key[2];
        const dK = Math.max(0, (kd + 0.25) / 1.25);
        const dR = Math.max(0, Nm[0] * rim[0] + Nm[1] * rim[1] + Nm[2] * rim[2]);
        const amb = 0.3 + 0.1 * Nm[1];
        let L = amb + 0.62 * dO + 0.4 * dK + 0.2 * dR * dR;
        let spec = 0;
        const g = m.gloss * gl;
        if (g > 0) {
          const s1 = Math.max(0, Nm[0] * hk[0] + Nm[1] * hk[1] + Nm[2] * hk[2]);
          const s2 = Math.max(0, Nm[0] * ho[0] + Nm[1] * ho[1] + Nm[2] * ho[2]);
          // Schlick's cheap power: s^n ~ s / (n - n s + s)
          const n = m.pw;
          spec = (s1 / (n - n * s1 + s1) * 0.7 + (shadowed ? 0 : s2 / (n - n * s2 + s2) * 0.8)) * g * 190;
        }
        if (m.glow > 0) L = L * (1 - m.glow) + 1.05 * m.glow;
        R = col[0] * L + spec; G = col[1] * L + spec; B = col[2] * L + spec * 0.96;
      }
      lit[i * 3] = R; lit[i * 3 + 1] = G; lit[i * 3 + 2] = B;
    }
  }

  // --- ambient occlusion and creases from the depth buffer
  const OFF = [[-3, 0], [3, 0], [0, -3], [0, 3], [-2, -2], [2, -2], [-2, 2], [2, 2], [-6, 0], [6, 0], [0, -6], [0, 6]];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (pid[i] < 0) continue;
      const d0 = depth[i];
      let occ = 0;
      for (let k = 0; k < OFF.length; k++) {
        const xx = x + OFF[k][0], yy = y + OFF[k][1];
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const j = yy * W + xx;
        if (pid[j] < 0) continue;
        const dd = d0 - depth[j];
        if (dd > 0.012 && dd < 0.25) occ += k < 8 ? 1 : 0.6;
      }
      let a = 1 - Math.min(0.42, occ * 0.055);
      // a crease where a different part sits in front, one pixel up or left
      const up = y > 0 ? i - W : -1, lf = x > 0 ? i - 1 : -1;
      if ((up >= 0 && pid[up] >= 0 && pid[up] !== pid[i] && depth[up] < d0 - 0.01) ||
          (lf >= 0 && pid[lf] >= 0 && pid[lf] !== pid[i] && depth[lf] < d0 - 0.01)) a *= 0.72;
      const m = prims[pid[i]].m;
      if (m.glow >= 0.999) a = 1;
      let R = lit[i * 3] * a, G = lit[i * 3 + 1] * a, B = lit[i * 3 + 2] * a;
      // gentle shoulder instead of a hard clip
      R = R > 220 ? 220 + (R - 220) * 0.35 : R; G = G > 220 ? 220 + (G - 220) * 0.35 : G; B = B > 220 ? 220 + (B - 220) * 0.35 : B;
      out[i] = (255 << 24 | (Math.min(255, B) | 0) << 16 | (Math.min(255, G) | 0) << 8 | (Math.min(255, R) | 0)) >>> 0;
    }
  }

  // --- outline the silhouette
  const solid = new Uint8Array(n);
  for (let i = 0; i < n; i++) solid[i] = pid[i] >= 0 ? 1 : 0;
  const ink = (255 << 24 | INK[2] << 16 | INK[1] << 8 | INK[0]) >>> 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (solid[i]) continue;
      if ((x > 0 && solid[i - 1]) || (x < W - 1 && solid[i + 1]) || (y > 0 && solid[i - W]) || (y < H - 1 && solid[i + W])) out[i] = ink;
    }
  }

  // --- the floor under it: rays that reach the floor, and whether the room light can see that spot
  if (o.shadow !== false) {
    const J = [[0, 0], [0.18, 0.1], [-0.16, 0.12], [0.05, -0.2]].map((j) => norm3(j[0], 1, j[1]));
    for (let y = 0; y < H; y++) {
      const sy = top - (y + 0.5) * inv;
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (out[i] >>> 24) continue;
        const sx = (x + 0.5 - cx0) * inv;
        const oy0 = sy * uy - fy * FAR;
        const t = -oy0 / fy;
        const gx = sx * rx + sy * ux - fx * FAR + fx * t, gz = sx * rz + sy * uz - fz * FAR + fz * t;
        if (gx < fminx - 0.08 || gx > fmaxx + 0.08 || gz < fminz - 0.08 || gz > fmaxz + 0.08) continue;
        let hits = 0;
        for (let k = 0; k < J.length; k++) {
          const L = J[k];
          if (occluded(prims, gx, 0.002, gz, L[0], L[1], L[2], null)) hits++;
          else if (k === 0) break;          // lit straight down: the edge of a shadow is not soft enough to matter
        }
        if (!hits) continue;
        const a = Math.round(hits / J.length * 150);
        out[i] = (a << 24 | 10 << 16 | 8 << 8 | 8) >>> 0;
      }
    }
  }

  f.below = -bot;
  f.ppu = ppu;
  f.worldH = H / ppu;
  return f;
}

function norm3(x, y, z) { const l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; }

// ------------------------------------------------------------------ the studio

/**
 * Frames of every prop, made when first wanted and kept for the session.
 * models: { kind: { dirs, build(M), sym } }, pieces the same for debris.
 */
export class PropStudio {
  constructor(models, pieces = {}) {
    this.models = models || {};
    this.pieces = pieces;
    this.cache = new Map();
    this.ms = 0;
    this.made = 0;
    this.queue = [];
    this.queued = new Set();
  }

  has(kind) { return !!this.models[kind]; }

  /** A model's footprint standing: { minX, maxX, minZ, maxZ, top } in world units. */
  bounds(kind, variant = 0) {
    const key = `b:${kind}|${variant}`;
    let b = this.cache.get(key);
    if (b) return b;
    const def = this.models[kind];
    if (!def) return null;
    b = { minX: 0, maxX: 0, minZ: 0, maxZ: 0, top: 0 };
    try {
      const M = new Model('ok', hashStr(kind) ^ (variant * 7919), variant % (def.variants || 1));
      def.build(M);
      prepare(M.prims);
      let first = true;
      for (const p of M.prims) for (const c of p.corners) {
        if (first) { b.minX = b.maxX = c[0]; b.minZ = b.maxZ = c[2]; first = false; }
        b.minX = Math.min(b.minX, c[0]); b.maxX = Math.max(b.maxX, c[0]);
        b.minZ = Math.min(b.minZ, c[2]); b.maxZ = Math.max(b.maxZ, c[2]);
        b.top = Math.max(b.top, c[1]);
      }
    } catch (e) { /* no footprint: leave it where the map put it */ }
    this.cache.set(key, b);
    return b;
  }

  dirsOf(kind) { const m = this.models[kind] || this.pieces[kind]; return m ? (m.dirs || DIRS) : 1; }

  /**
   * The frame of `kind` seen from direction `dir` (0..dirs-1; 0 is its front).
   * state: 'ok' | 'hurt' | 'wreck'. pose: 0 standing, 1..3 falling forward,
   * 4 lying on its face.
   */
  frame(kind, dir = 0, state = 'ok', variant = 0, pose = 0, piece = false) {
    const def = piece ? this.pieces[kind] : this.models[kind];
    if (!def) return null;
    const dirs = def.dirs || DIRS;
    dir = ((dir % dirs) + dirs) % dirs;
    const nv = def.variants || 1;
    variant = ((variant % nv) + nv) % nv;
    const key = `${piece ? 'p:' : ''}${kind}|${variant}|${state}|${pose}|${dir}`;
    let f = this.cache.get(key);
    if (f !== undefined) return f;
    const t0 = now();
    try {
      const M = new Model(state, hashStr(kind) ^ (variant * 7919), variant);
      if (pose > 0) {
        // Falling forward about the front bottom edge; 4 is flat on its face.
        const a = Math.min(1, pose / 4) * Math.PI / 2;
        const zf = def.front !== undefined ? def.front : 0.2;
        M.push([0, 0, zf], 0, a, 0);
        M.push([0, 0, -zf]);
      }
      def.build(M);
      f = renderModel(M, dir * (Math.PI * 2 / dirs), { damage: def.noDamage ? 0 : undefined });
    } catch (e) {
      f = null;
    }
    this.ms += now() - t0;
    this.made++;
    this.cache.set(key, f);
    return f;
  }

  /**
   * The frame if it is made, else null, and it goes on the list to be made.
   * The game asks with this while playing, so a prop never costs a hitch;
   * until its frame is ready it shows the nearest direction that is.
   */
  want(kind, dir = 0, state = 'ok', variant = 0, pose = 0, piece = false) {
    const def = piece ? this.pieces[kind] : this.models[kind];
    if (!def) return null;
    const dirs = def.dirs || DIRS;
    dir = ((dir % dirs) + dirs) % dirs;
    const nv = def.variants || 1;
    variant = ((variant % nv) + nv) % nv;
    const key = `${piece ? 'p:' : ''}${kind}|${variant}|${state}|${pose}|${dir}`;
    const f = this.cache.get(key);
    this.exact = f !== undefined;
    if (f !== undefined) return f;
    if (!this.queued.has(key)) { this.queued.add(key); this.queue.push([kind, dir, state, variant, pose, piece, key]); }
    // meanwhile: the nearest direction already made, then any pose of it
    for (let k = 1; k <= dirs >> 1; k++) {
      for (const dd of [dir + k, dir - k]) {
        const g = this.cache.get(`${piece ? 'p:' : ''}${kind}|${variant}|${state}|${pose}|${((dd % dirs) + dirs) % dirs}`);
        if (g) return g;
      }
    }
    return null;
  }

  /** Make queued frames until `budgetMs` is spent. Returns how many are left. */
  pump(budgetMs = 3) {
    const t0 = now();
    // newest first: what was asked for this frame is what is on screen
    while (this.queue.length && now() - t0 < budgetMs) {
      const [kind, dir, state, variant, pose, piece, key] = this.queue.pop();
      this.queued.delete(key);
      if (!this.cache.has(key)) this.frame(kind, dir, state, variant, pose, piece);
    }
    return this.queue.length;
  }

  /**
   * Make every frame these kinds will need standing, now rather than mid-fight,
   * up to `budgetMs`; whatever is left is queued and made while playing.
   */
  prewarm(kinds, states = ['ok'], budgetMs = Infinity) {
    const t0 = now();
    for (const k of kinds) {
      const def = this.models[k];
      if (!def) continue;
      const nv = def.variants || 1;
      for (let v = 0; v < nv; v++) for (const s of states) for (let d = 0; d < (def.dirs || DIRS); d++) {
        if (now() - t0 < budgetMs) this.frame(k, d, s, v);
        else this.want(k, d, s, v);
      }
    }
  }

  clear() { this.cache.clear(); this.queue.length = 0; this.queued.clear(); }

  /** Keep only standing, whole frames: the rest is made again when it is wanted. */
  trim() {
    for (const k of [...this.cache.keys()]) {
      if (k.startsWith('b:')) continue;
      const parts = k.split('|');
      if (parts[2] !== 'ok' || parts[3] !== '0') this.cache.delete(k);
    }
    this.queue.length = 0; this.queued.clear();
  }
}

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

/** Which of `dirs` frames to show for a prop facing `yaw`, seen from a camera at (cx, cy). */
export function viewDir(px, py, yaw, cx, cy, dirs = DIRS) {
  if (dirs <= 1) return 0;
  const a = Math.atan2(cy - py, cx - px);
  const theta = yaw - a;
  let d = Math.round(theta / (Math.PI * 2 / dirs)) % dirs;
  if (d < 0) d += dirs;
  return d;
}
