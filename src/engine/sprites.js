// sprites.js - procedural sprite generator for NUKEHAUS.
//
// Everything here is built from a tiny 3D skeleton + a parametric humanoid
// painter, so the whole cast is lit consistently (key light upper-left, toward
// the viewer) and animates coherently. No binary assets, no DOM, deterministic.
//
// Body space: bx = the character's own RIGHT, by = up from the floor (feet at
// 0), bz = the direction it is facing. Facing D rotates that space around the
// vertical axis: 0 front, 1 its right side, 2 back, 3 its left side.

import {
  rgba, mix, shade, clamp, lerp, makeRng, makeNoise, fbm,
  makeFrame, px, getpx, fillRect, fillCircle, line, mirrorX, outline,
} from '../core/pixels.js';

// ---------------------------------------------------------------------------
// colour / shading
// ---------------------------------------------------------------------------

const INK = rgba(7, 5, 10, 255);          // outline black
const COOL = rgba(24, 22, 48, 255);       // shadow tint
const WARM = rgba(255, 242, 212, 255);    // key light tint

// Key light, in screen space: upper-left, leaning toward the camera.
const LX = -0.52, LY = -0.66, LZ = 0.54;

/** Deterministic per-pixel hash, for grain and dithering. */
function hash2(x, y, s) {
  let h = (Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 2147483647)) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
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

/** Capsule between two screen points, lit like a cylinder with round caps. */
function capsule(f, x0, y0, x1, y1, r0, r1, ramp, o = {}) {
  if (o.edge !== undefined) {
    const ew = o.edgeW === undefined ? 1.0 : o.edgeW;
    capsule(f, x0, y0, x1, y1, r0 + ew, r1 + ew, flat(o.edge), {});
  }
  const shift = o.shift || 0, grain = o.grain || 0, seed = o.seed || 11;
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
      if (ex * ex + ey * ey > r * r) continue;
      const sp = (ex * pxx + ey * pyy) / r;
      const sa = (ex * ux + ey * uy) / r;
      const nx = pxx * sp + ux * sa, ny = pyy * sp + uy * sa;
      const nz = Math.sqrt(Math.max(0, 1 - sp * sp - sa * sa));
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
    blob(f, cx, cy, rx + ew, ry + ew, flat(o.edge), { mode: o.mode, nyBias: o.nyBias });
  }
  const shift = o.shift || 0, grain = o.grain || 0, seed = o.seed || 5;
  const cyl = o.mode === 'cyl';
  const nyB = o.nyBias === undefined ? -0.16 : o.nyBias;
  const rxs = Math.max(rx, 0.5), rys = Math.max(ry, 0.5);
  for (let y = Math.floor(cy - rys); y <= Math.ceil(cy + rys); y++) {
    for (let x = Math.floor(cx - rxs); x <= Math.ceil(cx + rxs); x++) {
      const u = (x - cx) / rxs, v = (y - cy) / rys;
      if (u * u + v * v > 1.0) continue;
      let nx, ny, nz;
      if (cyl) { nx = u; ny = nyB; nz = Math.sqrt(Math.max(0, 1 - u * u - ny * ny)); }
      else { nx = u; ny = v; nz = Math.sqrt(Math.max(0, 1 - u * u - v * v)); }
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
// the humanoid painter
// ---------------------------------------------------------------------------

/**
 * Build a projector for one facing plus an optional screen-space transform
 * (used to topple the whole body over during death animations).
 */
function projector(theta, cx, groundY, xf) {
  const c = Math.cos(theta), s = Math.sin(theta);
  return function P(b) {
    let x = cx - b.x * c + b.z * s;
    let y = groundY - b.y;
    const z = b.x * s + b.z * c;
    if (xf) {
      const dx = x - xf.px, dy = y - xf.py;
      const cr = Math.cos(xf.rot), sr = Math.sin(xf.rot);
      x = xf.px + dx * cr - dy * sr + (xf.dx || 0);
      y = xf.py + dx * sr + dy * cr + (xf.dy || 0);
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

/**
 * Paint a character. `ch` is the body description, `pose` the animation state,
 * D the facing. Parts are depth-sorted so every facing composes correctly.
 */
function humanoid(f, ch, pose, D) {
  const theta = D * Math.PI / 2;
  const cx = ch.cx === undefined ? f.w / 2 : ch.cx;
  const groundY = f.h - 1;
  const P = projector(theta, cx, groundY, pose.xform);
  const R = ch.ramps;

  const drop = pose.hipDrop || 0;
  const hipY = ch.hipY - drop;
  const lean = pose.lean || 0;

  // --- legs: explicit foot targets keep the feet planted, IK finds the knees.
  const legs = [];
  for (let i = 0; i < 2; i++) {
    const side = i === 0 ? 1 : -1;              // +1 = character's right
    const ft = pose.feet[i];
    const hipJ = V(side * ch.legHalf, hipY, (pose.hipZ || 0));
    const sol = ik(hipJ, ft, ch.thigh, ch.shin, V(side * 0.35, 0.15, 1));
    legs.push({ side, hip: hipJ, knee: sol.joint, foot: sol.end });
  }

  // --- upper body, pitched about the hip.
  const hipC = V(0, hipY, pose.hipZ || 0);
  const shC = leanPt(V(0, ch.shoulderY, 0), hipY, lean);
  const neck = leanPt(V(0, ch.neckY, ch.neckZ || 0), hipY, lean);
  const head = leanPt(V(0, ch.headY, ch.headZ || 0), hipY, lean);
  head.y += pose.headBob || 0;
  head.z += pose.headPush || 0;

  const arms = [];
  for (let i = 0; i < 2; i++) {
    const side = i === 0 ? 1 : -1;
    const sh = leanPt(V(side * ch.shoulderHalf, ch.shoulderY - 0.5, 0), hipY, lean);
    const hand = pose.hands[i];
    const ap = ch.armPole || V(0.85, -0.25, -0.75);
    const sol = ik(sh, hand, ch.upper, ch.fore, V(side * ap.x, ap.y, ap.z));
    arms.push({ side, sh, elbow: sol.joint, hand: sol.end });
  }

  const parts = [];
  const add = (z, draw) => parts.push({ z, draw });

  // --- legs
  for (const L of legs) {
    const h2 = P(L.hip), k2 = P(L.knee), f2 = P(L.foot);
    const zz = (k2.z + f2.z) * 0.5;
    add(zz - 0.6, () => {
      const sft = zz < -0.8 ? -1 : 0;
      const E = { edge: ch.edge, edgeW: 0.9 };
      capsule(f, h2.x, h2.y, k2.x, k2.y, ch.legThick, ch.legThick * 0.88, R.trouser, { shift: sft, grain: 0.05, seed: 21, ...E });
      capsule(f, k2.x, k2.y, f2.x, f2.y, ch.legThick * 0.88, ch.legThick * 0.7, R.trouser, { shift: sft, grain: 0.05, seed: 22, ...E });
      // boot: a wedge pointing along the character's facing
      const toe = P(vadd(L.foot, V(0, -0.4, ch.footLen)));
      capsule(f, f2.x, f2.y + 0.4, toe.x, toe.y, ch.legThick * 0.85, ch.legThick * 0.66, R.boot, { shift: sft, ...E });
    });
  }

  // --- torso as a stack of elliptical slices
  const torsoZ = P(V(0, ch.shoulderY, 0)).z;
  add(torsoZ + 0.1, () => {
    const n = ch.slices || 13;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const pr = profileAt(ch.profile, t);
      const p = leanPt(V(0, lerp(hipY - 1.5, ch.shoulderY + 1, t), 0), hipY, lean);
      const s2 = P(p);
      const rx = Math.sqrt(Math.pow(pr.w * Math.cos(theta), 2) + Math.pow(pr.d * Math.sin(theta), 2));
      blob(f, s2.x, s2.y, rx, 1.9, R.torso, { mode: 'cyl', nyBias: lerp(-0.05, -0.4, t), grain: 0.06, seed: 33 + i });
    }
  });

  // --- head
  const hd = P(head);
  add(hd.z + 14, () => {
    if (ch.head) ch.head(f, { P, head, hd, theta, D, ch, pose, R, cx, groundY });
  });

  // --- arms
  for (const A of arms) {
    const s2 = P(A.sh), e2 = P(A.elbow), h2 = P(A.hand);
    const zz = (e2.z + h2.z) * 0.5 + 1.2;
    add(zz, () => {
      const sft = zz < -0.8 ? -1 : 0;
      const E = { edge: ch.edge, edgeW: 0.9 };
      capsule(f, s2.x, s2.y, e2.x, e2.y, ch.armThick * 1.05, ch.armThick * 0.9, R.sleeve, { shift: sft, grain: 0.05, seed: 41, ...E });
      capsule(f, e2.x, e2.y, h2.x, h2.y, ch.armThick * 0.9, ch.armThick * 0.78, R.sleeve, { shift: sft, grain: 0.05, seed: 42, ...E });
      blob(f, h2.x, h2.y, ch.armThick * 0.98, ch.armThick * 0.98, R.glove, { shift: sft, ...E });
    });
  }

  // --- character-specific gear (packs, tanks, weapons, tabards)
  if (ch.gear) {
    ch.gear({ f, ch, pose, D, theta, P, add, R, legs, arms, hipC, shC, neck, head, hipY, cx, groundY });
  }

  parts.sort((a, b) => a.z - b.z);
  for (const p of parts) p.draw();
}

// ---------------------------------------------------------------------------
// poses
// ---------------------------------------------------------------------------

/**
 * Four-frame walk. Feet are placed explicitly: planted through stance, lifted
 * only during swing, so the contact frames both put a boot on the floor and
 * nothing bounces vertically. The hip dips at contact instead.
 */
function walkPose(ch, F, o = {}) {
  const p = F * Math.PI / 2;
  const stride = (o.stride === undefined ? ch.stride : o.stride);
  const lift = (o.lift === undefined ? ch.lift : o.lift);
  const feet = [], legPh = [];
  for (let i = 0; i < 2; i++) {
    const q = p + i * Math.PI;
    legPh.push(q);
    const sw = Math.max(0, Math.cos(q));
    feet.push(V((i === 0 ? 1 : -1) * ch.legHalf * 1.02,
      ch.ankleY + lift * Math.pow(sw, 1.3),
      stride * Math.sin(q)));
  }
  const dip = ch.hipDip * Math.abs(Math.sin(p));
  return {
    feet, legPh, phase: p, hipDrop: dip, lean: ch.lean,
    hands: [V(0, 0, 0), V(0, 0, 0)],  // replaced by the character
    hipZ: 0, headBob: -dip * 0.25,
  };
}

// ---------------------------------------------------------------------------
// character definitions
// ---------------------------------------------------------------------------

/** Shared skull/mask painter helpers. */
function faceVisible(theta) { return Math.cos(theta) > 0.35; }

/**
 * Wrencher - bunker maintenance tech. Orange coveralls, battered hardhat with
 * a dead headlamp, welding goggles over a rubber mask, huge pipe wrench.
 */
function makeWrencher() {
  const orange = rgba(196, 96, 24, 255);
  const R = {
    torso: mat(orange, { contrast: 1.15 }),
    sleeve: mat(rgba(150, 70, 20, 255), { contrast: 1.15 }),
    trouser: mat(rgba(112, 54, 20, 255), { contrast: 1.1 }),
    boot: mat(rgba(42, 34, 32, 255)),
    glove: mat(rgba(64, 44, 32, 255)),
    hat: mat(rgba(214, 162, 32, 255), { contrast: 1.15 }),
    mask: mat(rgba(56, 52, 58, 255)),
    lens: mat(rgba(138, 182, 96, 255), { contrast: 1.35 }),
    steel: mat(rgba(150, 156, 168, 255), { contrast: 1.3 }),
    strap: mat(rgba(58, 42, 32, 255)),
    dark: mat(rgba(38, 36, 42, 255)),
  };
  return {
    id: 'wrencher', w: 64, h: 72,
    hipY: 29, shoulderY: 46.5, neckY: 49, headY: 58, neckZ: 2.0, headZ: 4.4,
    shoulderHalf: 12.0, legHalf: 5.4, ankleY: 4.2, footLen: 5,
    thigh: 14.0, shin: 13.0, upper: 11.5, fore: 11,
    armThick: 3.7, legThick: 4.7, stride: 7, lift: 4.2, hipDip: 1.6, lean: 0.28,
    edge: rgba(28, 14, 10, 255),
    profile: [[0, 9.2, 6.8], [0.35, 10.6, 7.4], [0.74, 12.8, 8.0], [1, 12.0, 7.2]],
    ramps: R,
    head(f, c) {
      const { hd, theta, R } = c;
      const fw = Math.cos(theta), sd = Math.sin(theta);
      // skull / hood
      blob(f, hd.x, hd.y + 1.6, 7.8, 7.8, R.mask, { grain: 0.05, seed: 61, edge: c.ch.edge, edgeW: 0.9 });
      // hardhat: dome + brim, brim on the facing side
      blob(f, hd.x, hd.y - 3.8, 8.8, 6.0, R.hat, { grain: 0.04, seed: 62, edge: c.ch.edge, edgeW: 0.9 });
      fillRect(f, Math.round(hd.x - 8.2), Math.round(hd.y - 3.0), 17, 1, R.hat[1]);
      const brimZ = 4.2 * fw, brimX = -4.2 * sd;
      capsule(f, hd.x + brimX - 7.0, hd.y - 1.6 + brimZ * 0.2, hd.x + brimX + 7.0, hd.y - 1.6 + brimZ * 0.2, 1.8, 1.8, R.hat, { shift: fw > 0 ? 0 : -1, edge: c.ch.edge, edgeW: 0.8 });
      // crest ridge
      if (Math.abs(fw) > 0.4) line(f, hd.x, hd.y - 8.3, hd.x, hd.y - 5.5, R.hat[4]);
      if (fw > 0.35) {
        // goggles
        const gy = hd.y + 0.2;
        capsule(f, hd.x - 5.2, gy, hd.x + 5.2, gy, 3.0, 3.0, R.dark, { edge: c.ch.edge, edgeW: 0.8 });
        blob(f, hd.x - 2.9, gy - 0.2, 2.4, 2.2, R.lens);
        blob(f, hd.x + 2.9, gy - 0.2, 2.4, 2.2, R.lens);
        px(f, Math.round(hd.x - 3.6), Math.round(gy - 1.1), R.lens[4]);
        px(f, Math.round(hd.x + 2.2), Math.round(gy - 1.1), R.lens[4]);
        // respirator
        blob(f, hd.x, hd.y + 5.0, 4.0, 3.2, R.mask, { shift: 1, edge: c.ch.edge, edgeW: 0.8 });
        blob(f, hd.x, hd.y + 6.0, 2.4, 1.9, R.steel, { shift: -1 });
        for (let i = 0; i < 3; i++) line(f, hd.x - 3, hd.y + 4.2 + i, hd.x + 3, hd.y + 4.2 + i, R.mask[i % 2 ? 0 : 3]);
        // dead headlamp
        blob(f, hd.x, hd.y - 4.6, 2.1, 1.7, R.steel);
        blob(f, hd.x, hd.y - 4.6, 1.2, 1.0, R.dark, { shift: -1 });
      } else if (Math.abs(sd) > 0.5) {
        // profile: filter canister and strap
        const fx = hd.x + (sd > 0 ? -1 : 1) * 4.2;
        blob(f, fx, hd.y + 3.4, 2.6, 2.4, R.mask, { shift: 1 });
        blob(f, fx + (sd > 0 ? -1.4 : 1.4), hd.y + 3.6, 1.5, 1.4, R.steel, { shift: -1 });
        line(f, hd.x - 5, hd.y + 0.6, hd.x + 5, hd.y + 0.6, R.dark[1]);
        blob(f, hd.x + (sd > 0 ? 3.6 : -3.6), hd.y + 0.3, 1.6, 1.6, R.lens, { shift: -1 });
      } else {
        // back of the head: strap buckles
        line(f, hd.x - 5, hd.y + 0.6, hd.x + 5, hd.y + 0.6, R.dark[1]);
        line(f, hd.x - 4, hd.y + 3.4, hd.x + 4, hd.y + 3.4, R.dark[1]);
        blob(f, hd.x, hd.y + 2.0, 1.6, 1.4, R.steel, { shift: -1 });
      }
    },
    gear(c) {
      const { f, add, P, R, arms, pose, ch, theta, hipY } = c;
      const E = { edge: ch.edge, edgeW: 0.9 };
      const fwd = Math.cos(theta);
      // X harness across the chest / back
      const hz = P(V(0, ch.shoulderY - 6, fwd >= 0 ? 8.2 : -8.2));
      add(hz.z + 0.7, () => {
        const wpx = Math.abs(fwd) * 8.5 + 2.2;
        capsule(f, hz.x - wpx, hz.y - 8, hz.x + wpx * 0.35, hz.y + 8, 1.9, 1.9, R.strap, { ...E });
        capsule(f, hz.x + wpx, hz.y - 8, hz.x - wpx * 0.35, hz.y + 8, 1.9, 1.9, R.strap, { ...E });
        blob(f, hz.x, hz.y + 0.5, 2.8, 2.4, R.steel, { shift: 0, ...E });
        px(f, Math.round(hz.x - 1), Math.round(hz.y - 0.5), R.steel[4]);
      });
      // tool belt around the hips
      const bz2 = P(V(0, hipY + 2.5, 0));
      add(bz2.z + 0.4, () => {
        const wpx = Math.sqrt(Math.pow(10.2 * Math.cos(theta), 2) + Math.pow(7.6 * Math.sin(theta), 2));
        for (let i = 0; i < 4; i++) blob(f, bz2.x, bz2.y + i - 1, wpx, 1.4, R.strap, { mode: 'cyl', nyBias: -0.1, ...(i ? {} : E) });
        blob(f, bz2.x + wpx * 0.55 * (fwd >= 0 ? 1 : -1), bz2.y + 2.5, 2.4, 3.0, R.strap, { shift: 1, ...E });
        blob(f, bz2.x - wpx * 0.5, bz2.y + 2, 1.8, 2.4, R.steel, { shift: -1, ...E });
        if (Math.abs(fwd) > 0.4) {
          blob(f, bz2.x, bz2.y, 2.4, 1.8, R.steel, { shift: 1 });
          px(f, Math.round(bz2.x - 1), Math.round(bz2.y - 1), R.steel[4]);
        }
      });
      // coverall seams: zip, pocket, knee patches
      const dz = P(V(0, ch.shoulderY - 12, 8.4));
      add(dz.z + 0.5, () => {
        if (fwd < 0.25) return;
        for (let i = 0; i < 14; i++) over(f, dz.x, dz.y - 6 + i, R.torso[0], 0.55);
        fillRect(f, Math.round(dz.x + 3), Math.round(dz.y - 4), 5, 5, R.torso[1]);
        fillRect(f, Math.round(dz.x + 3), Math.round(dz.y - 4), 5, 1, R.torso[4]);
        fillRect(f, Math.round(dz.x - 8), Math.round(dz.y - 3), 4, 4, R.torso[1]);
      });
      // shoulder pad on the wrench arm
      const sp = P(V(11.5, ch.shoulderY + 1, 0));
      add(sp.z + 1.6, () => {
        blob(f, sp.x, sp.y, 5.0, 3.4, R.strap, { shift: 1, grain: 0.06, seed: 77, ...E });
        for (let i = -1; i <= 1; i++) px(f, Math.round(sp.x + i * 2.5), Math.round(sp.y - 1.5), R.steel[3]);
      });
      // pipe wrench spanning both hands
      const A = arms[0].hand, B = arms[1].hand;
      const mid = vmul(vadd(A, B), 0.5);
      const dir = vnorm(vsub(pose.wrenchTip || V(mid.x, mid.y + 14, mid.z + 3), mid));
      const tip = vadd(mid, vmul(dir, ch_wrenchLen));
      const butt = vadd(mid, vmul(dir, -7));
      const p0 = P(butt), p1 = P(tip);
      add(Math.max(P(A).z, P(B).z) + 2.6, () => {
        const sft = p1.z < -1 ? -1 : 0;
        const EW = { edge: rgba(20, 18, 22, 255), edgeW: 0.9 };
        capsule(f, p0.x, p0.y, p1.x, p1.y, 2.4, 2.0, R.steel, { shift: sft, grain: 0.06, seed: 71, ...EW });
        // jaw head at the tip, perpendicular in screen space
        const dx = p1.x - p0.x, dy = p1.y - p0.y, L = Math.hypot(dx, dy) || 1;
        const ux = dx / L, uy = dy / L, nx = -uy, ny = ux;
        // head: a heavy fixed jaw with a shorter movable jaw above it, C-gap between
        const jx = p1.x + ux * 1.2, jy = p1.y + uy * 1.2;
        capsule(f, jx - nx * 3.0, jy - ny * 3.0, jx + nx * 4.0, jy + ny * 4.0, 2.6, 2.6, R.steel, { shift: sft, ...EW });
        const mx2 = jx + ux * 5.4, my2 = jy + uy * 5.4;
        capsule(f, mx2 - nx * 3.0, my2 - ny * 3.0, mx2 + nx * 1.6, my2 + ny * 1.6, 1.9, 1.9, R.steel, { shift: sft, ...EW });
        // serrated inner faces
        for (let i = 0; i < 3; i++) {
          px(f, jx + nx * (0.5 + i * 1.4) + ux * 2.4, jy + ny * (0.5 + i * 1.4) + uy * 2.4, R.steel[0]);
          px(f, mx2 + nx * (0.2 + i * 1.0) - ux * 1.8, my2 + ny * (0.2 + i * 1.0) - uy * 1.8, R.steel[0]);
        }
        px(f, jx - nx * 2.2 - ux * 1.0, jy - ny * 2.2 - uy * 1.0, R.steel[4]);
        // adjuster knurl + grip band
        capsule(f, jx - ux * 3.0 - nx * 1.0, jy - uy * 3.0 - ny * 1.0, jx - ux * 5.5 - nx * 1.0, jy - uy * 5.5 - ny * 1.0, 2.2, 2.0, R.dark, { shift: sft });
        capsule(f, p0.x + ux * 5, p0.y + uy * 5, p0.x + ux * 9, p0.y + uy * 9, 2.3, 2.3, R.dark, { shift: sft, ...EW });
      });
    },
  };
}
const ch_wrenchLen = 21;

/**
 * Sparker - twitchy clerk. Grey uniform, tabard of dangling ID badges, snub
 * electro-pistol cabled to a battery pack with a glowing charge indicator.
 */
function makeSparker() {
  const grey = rgba(112, 116, 128, 255);
  const R = {
    torso: mat(grey, { contrast: 1.15 }), sleeve: mat(rgba(84, 88, 100, 255), { contrast: 1.15 }),
    trouser: mat(rgba(62, 66, 78, 255), { contrast: 1.1 }), boot: mat(rgba(34, 32, 38, 255)),
    glove: mat(rgba(52, 54, 64, 255)),
    skin: mat(rgba(214, 182, 158, 255), { contrast: 1.2 }),
    tabard: mat(rgba(178, 176, 168, 255), { contrast: 1.2 }),
    steel: mat(rgba(134, 138, 150, 255), { contrast: 1.25 }),
    dark: mat(rgba(34, 34, 42, 255)),
    cap: mat(rgba(46, 50, 64, 255), { contrast: 1.3 }),
    badge: mat(rgba(214, 206, 176, 255)),
  };
  return {
    id: 'sparker', w: 64, h: 72,
    hipY: 32, shoulderY: 50, neckY: 53, headY: 59.5, neckZ: 0.6, headZ: 1.2,
    shoulderHalf: 9, legHalf: 4.2, ankleY: 3.6, footLen: 4.4,
    thigh: 15, shin: 14.5, upper: 11.5, fore: 11,
    armThick: 2.7, legThick: 3.4, stride: 7.6, lift: 4.6, hipDip: 1.5, lean: 0.1,
    edge: rgba(18, 18, 24, 255),
    profile: [[0, 6.4, 4.6], [0.4, 7.0, 5.0], [0.75, 8.8, 5.4], [1, 8.4, 5.0]],
    ramps: R,
    head(f, c) {
      const { hd, theta, R, pose } = c;
      const fw = Math.cos(theta), sd = Math.sin(theta);
      blob(f, hd.x, hd.y + 0.6, 5.2, 6.0, R.skin, { grain: 0.04, seed: 81 });
      // peaked cap
      blob(f, hd.x, hd.y - 3.8, 5.6, 3.6, R.cap);
      const peak = 4.0 * fw, pxs = -4.0 * sd;
      capsule(f, hd.x + pxs - 4.2, hd.y - 1.9 + peak * 0.1, hd.x + pxs + 4.2, hd.y - 1.9 + peak * 0.1, 1.2, 1.2, R.cap, { shift: fw > 0 ? 0 : -1 });
      fillRect(f, Math.round(hd.x - 5.4), Math.round(hd.y - 2.6), 11, 1, R.dark[1]);
      if (fw > 0.35) {
        const ey = hd.y + 0.6;
        blob(f, hd.x - 2.3, ey, 1.5, 1.2, R.dark, { shift: 1 });
        blob(f, hd.x + 2.3, ey, 1.5, 1.2, R.dark, { shift: 1 });
        px(f, Math.round(hd.x - 2.3), Math.round(ey), rgba(230, 236, 244, 255));
        px(f, Math.round(hd.x + 2.3), Math.round(ey), rgba(230, 236, 244, 255));
        line(f, hd.x - 1.5, hd.y + 4.2, hd.x + 1.5, hd.y + 4.2, R.dark[1]);
        if (pose.gasp) fillRect(f, Math.round(hd.x - 1), Math.round(hd.y + 3.4), 3, 2, R.dark[0]);
      } else if (Math.abs(sd) > 0.5) {
        const ex = hd.x + (sd > 0 ? -2.6 : 2.6);
        blob(f, ex, hd.y + 0.6, 1.3, 1.2, R.dark, { shift: 1 });
        blob(f, hd.x + (sd > 0 ? 3.4 : -3.4), hd.y + 1.6, 1.4, 1.6, R.skin, { shift: -1 });
        line(f, hd.x + (sd > 0 ? -4 : 4), hd.y + 3.6, hd.x + (sd > 0 ? -2 : 2), hd.y + 4.2, R.dark[1]);
      } else {
        capsule(f, hd.x - 3.4, hd.y + 3.6, hd.x + 3.4, hd.y + 3.6, 1.4, 1.4, R.dark, { shift: 1 });
        blob(f, hd.x, hd.y + 1.0, 3.2, 2.6, R.skin, { shift: -1 });
      }
    },
    gear(c) {
      const { f, add, P, R, arms, ch, pose, theta } = c;
      const chg = pose.charge === undefined ? 0.25 : pose.charge;
      // battery pack on the back
      const packC = V(0, ch.shoulderY - 6, -6.4);
      const pk = P(packC);
      add(pk.z - 0.4, () => {
        const wpx = Math.abs(Math.cos(theta)) * 5.6 + Math.abs(Math.sin(theta)) * 3.6;
        box(f, Math.round(pk.x - wpx), Math.round(pk.y - 6), Math.round(wpx * 2), 12, R.steel, { grain: 0.07, seed: 91 });
        const gc = mix(rgba(70, 240, 150, 255), rgba(255, 255, 245, 255), chg);
        fillRect(f, Math.round(pk.x - wpx + 1), Math.round(pk.y - 3), Math.max(1, Math.round(wpx * 2 - 2)), 2, R.dark[0]);
        const bars = Math.max(1, Math.round((wpx * 2 - 2) * (0.35 + 0.65 * chg)));
        fillRect(f, Math.round(pk.x - wpx + 1), Math.round(pk.y - 3), bars, 2, gc);
        glow(f, pk.x - wpx + 1 + bars * 0.5, pk.y - 2, 3 + chg * 4, gc, { halo: chg > 0.6 ? 0.8 : 0.35, seed: 92, base: rgba(16, 30, 24, 255) });
      });
      // tabard of ID badges on the chest
      const tz = P(V(0, ch.shoulderY - 4, 5.0));
      add(tz.z + 0.6, () => {
        if (Math.cos(theta) < -0.2) return;
        const wpx = Math.abs(Math.cos(theta)) * 5.4 + 1.4;
        box(f, Math.round(tz.x - wpx), Math.round(tz.y - 5), Math.round(wpx * 2), 11, R.tabard, { grain: 0.06, seed: 93 });
        fillRect(f, Math.round(tz.x - wpx), Math.round(tz.y - 5), Math.round(wpx * 2), 1, R.tabard[4]);
        fillRect(f, Math.round(tz.x - wpx * 0.55), Math.round(tz.y - 3), 3, 2, rgba(206, 62, 50, 255));
        // ID badges dangling below the tabard, where they show against the uniform
        for (let i = 0; i < 5; i++) {
          const bx = tz.x - wpx + 1.5 + (i * (wpx * 2 - 3)) / 4;
          const by = tz.y + 6 + (i % 3);
          line(f, bx, tz.y + 3, bx, by, R.dark[0]);
          fillRect(f, Math.round(bx - 1), Math.round(by), 3, 5, R.badge[3]);
          fillRect(f, Math.round(bx - 1), Math.round(by), 3, 1, R.badge[4]);
          fillRect(f, Math.round(bx - 1), Math.round(by + 2), 3, 1, R.dark[1]);
          px(f, Math.round(bx), Math.round(by + 3), i % 2 ? rgba(198, 58, 48, 255) : rgba(70, 140, 220, 255));
        }
      });
      // collar flash
      const cz = P(V(0, ch.shoulderY + 1.5, 0));
      add(cz.z + 1.2, () => {
        const wpx = Math.sqrt(Math.pow(8.4 * Math.cos(theta), 2) + Math.pow(5.2 * Math.sin(theta), 2));
        blob(f, cz.x, cz.y, wpx, 1.6, R.tabard, { mode: 'cyl', nyBias: -0.4, edge: ch.edge, edgeW: 0.8 });
        blob(f, cz.x, cz.y - 1, wpx * 0.8, 1.1, R.tabard, { mode: 'cyl', nyBias: -0.5 });
      });
      // pistol + cable
      const hand = arms[0].hand;
      const hp = P(hand);
      add(hp.z + 3, () => {
        const aim = pose.gunDir || V(0, 0.1, 1);
        const d = vnorm(aim);
        const t0 = P(vadd(hand, vmul(d, 1)));
        const t1 = P(vadd(hand, vmul(d, 6.5)));
        const slen = Math.hypot(t1.x - t0.x, t1.y - t0.y);
        const E = { edge: ch.edge, edgeW: 0.9 };
        if (slen < 4.5) {
          // pointed at the camera: draw it end-on, a dark bore in a steel ring
          blob(f, hp.x, hp.y - 1.6, 3.4, 3.2, R.dark, { ...E });
          blob(f, hp.x, hp.y - 1.8, 2.1, 2.0, R.steel, { shift: -1 });
          blob(f, hp.x, hp.y - 1.8, 1.0, 1.0, flat(rgba(14, 14, 18, 255)));
          px(f, Math.round(hp.x - 1), Math.round(hp.y - 3), R.steel[4]);
        } else {
          capsule(f, t0.x, t0.y, t1.x, t1.y, 2.1, 1.7, R.dark, { shift: 1, ...E });
          blob(f, t1.x, t1.y, 2.0, 2.0, R.steel, { shift: -1 });
          blob(f, t1.x, t1.y, 0.9, 0.9, flat(rgba(14, 14, 18, 255)));
        }
        capsule(f, hp.x, hp.y + 1.2, hp.x - 0.6, hp.y + 4.4, 1.7, 1.4, R.dark, { ...E });
        if (pose.muzzle) {
          const mz = P(vadd(hand, vmul(d, 8)));
          glow(f, mz.x, mz.y, 6.5, rgba(210, 244, 255, 255), { halo: 1, seed: 95, base: rgba(40, 60, 90, 255) });
          glow(f, mz.x, mz.y, 3, rgba(255, 255, 255, 255), { halo: 1, seed: 96, base: rgba(120, 180, 220, 255) });
          for (let i = 0; i < 5; i++) {
            const a = i * 1.27 + 0.4;
            line(f, mz.x, mz.y, mz.x + Math.cos(a) * (5 + i), mz.y + Math.sin(a) * (5 + i), rgba(180, 226, 255, 255));
          }
        } else if (chg > 0.5) {
          glow(f, t1.x, t1.y, 2.6, rgba(150, 220, 255, 255), { halo: 0.5, seed: 97, base: rgba(30, 44, 60, 255) });
        }
        // cable: hand -> a loop past the hip -> the pack
        const pts = [P(vadd(hand, V(0, -2, -1))), P(V(-5, ch.hipY + 2, -1)),
          P(V(-6, ch.hipY + 8, -5)), P(V(-1, ch.shoulderY - 10, -6.4))];
        for (let i = 0; i < pts.length - 1; i++) {
          capsule(f, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, 1.3, 1.3, R.dark, { edge: ch.edge, edgeW: 0.8 });
          capsule(f, pts[i].x - 0.4, pts[i].y - 0.5, pts[i + 1].x - 0.4, pts[i + 1].y - 0.5, 0.5, 0.5, flat(R.steel[1]), {});
        }
      });
    },
  };
}

/**
 * Bellows - enormously fat flamer unit. Scorched fire suit, riveted breathing
 * apparatus, twin tanks with a bright valve (shoot it), hose to the nozzle.
 */
function makeBellows() {
  const suit = rgba(164, 148, 118, 255);
  const R = {
    torso: mat(suit, { contrast: 1.15 }), sleeve: mat(rgba(124, 110, 88, 255), { contrast: 1.15 }),
    trouser: mat(rgba(96, 86, 72, 255), { contrast: 1.1 }), boot: mat(rgba(42, 36, 32, 255)),
    glove: mat(rgba(72, 62, 50, 255)),
    tank: mat(rgba(150, 92, 40, 255), { contrast: 1.2 }),
    steel: mat(rgba(96, 100, 108, 255), { contrast: 1.3 }),
    brass: mat(rgba(202, 162, 72, 255), { contrast: 1.3 }),
    dark: mat(rgba(40, 36, 38, 255)),
    lens: mat(rgba(236, 200, 96, 255), { contrast: 1.4 }),
  };
  return {
    id: 'bellows', w: 64, h: 72,
    hipY: 26, shoulderY: 45, neckY: 47.5, headY: 53.5, neckZ: 1.0, headZ: 1.6,
    shoulderHalf: 14, legHalf: 7.0, ankleY: 4.4, footLen: 5.4,
    thigh: 12.5, shin: 11.5, upper: 11, fore: 10.5,
    armThick: 4.4, legThick: 5.6, stride: 5.2, lift: 3.2, hipDip: 1.4, lean: 0.06,
    slices: 15, edge: rgba(26, 20, 16, 255),
    profile: [[0, 13.0, 9.6], [0.3, 15.4, 11.4], [0.58, 15.0, 11.0], [0.85, 13.4, 9.4], [1, 12.2, 8.4]],
    ramps: R,
    head(f, c) {
      const { hd, theta, R } = c;
      const fw = Math.cos(theta), sd = Math.sin(theta);
      // hood over a big round mask
      blob(f, hd.x, hd.y + 0.4, 6.6, 6.2, R.torso, { grain: 0.06, seed: 101 });
      blob(f, hd.x, hd.y - 4.4, 7.0, 3.4, R.torso, { grain: 0.05, seed: 102 });
      if (fw > 0.35) {
        blob(f, hd.x, hd.y + 1.4, 5.2, 4.8, R.steel, { grain: 0.05, seed: 103, edge: c.ch.edge, edgeW: 0.9 });
        // rivets around the faceplate
        for (let i = 0; i < 8; i++) {
          const a = i * Math.PI / 4 + 0.2;
          px(f, Math.round(hd.x + Math.cos(a) * 4.2), Math.round(hd.y + 1.4 + Math.sin(a) * 3.9), R.steel[4]);
        }
        blob(f, hd.x - 2.3, hd.y + 0.4, 1.9, 1.7, R.lens, { shift: 1 });
        blob(f, hd.x + 2.3, hd.y + 0.4, 1.9, 1.7, R.lens, { shift: 1 });
        glow(f, hd.x - 2.3, hd.y + 0.4, 3.4, rgba(255, 220, 120, 255), { halo: 0, seed: 106 });
        glow(f, hd.x + 2.3, hd.y + 0.4, 3.4, rgba(255, 220, 120, 255), { halo: 0, seed: 107 });
        px(f, Math.round(hd.x - 2.6), Math.round(hd.y - 0.1), rgba(250, 244, 210, 255));
        px(f, Math.round(hd.x + 1.8), Math.round(hd.y - 0.1), rgba(250, 244, 210, 255));
        // corrugated snout
        blob(f, hd.x, hd.y + 4.6, 3.0, 2.6, R.dark, { shift: 1 });
        for (let i = 0; i < 3; i++) line(f, hd.x - 2.6, hd.y + 3.6 + i, hd.x + 2.6, hd.y + 3.6 + i, R.dark[i % 2 ? 0 : 2]);
      } else if (Math.abs(sd) > 0.5) {
        const s = sd > 0 ? -1 : 1;
        blob(f, hd.x + s * 3.0, hd.y + 1.6, 3.2, 4.0, R.steel, { shift: -1, grain: 0.05, seed: 104 });
        blob(f, hd.x + s * 4.2, hd.y + 3.6, 2.2, 2.0, R.dark, { shift: 1 });
        blob(f, hd.x + s * 3.4, hd.y + 0.4, 1.4, 1.3, R.lens, { shift: 1 });
        // hose to the tanks
        for (let i = 0; i < 5; i++) {
          const t = i / 4;
          blob(f, hd.x + s * (4.4 - t * 3) - s * 0, hd.y + 5.4 + t * 4.5, 1.5, 1.3, R.dark, { shift: i % 2 ? 0 : -1 });
        }
      } else {
        blob(f, hd.x, hd.y + 1.2, 5.4, 5.0, R.torso, { grain: 0.06, seed: 105 });
        line(f, hd.x - 4.6, hd.y + 0.6, hd.x + 4.6, hd.y + 0.6, R.dark[1]);
        line(f, hd.x - 4.2, hd.y + 3.4, hd.x + 4.2, hd.y + 3.4, R.dark[1]);
        blob(f, hd.x, hd.y + 2.0, 1.8, 1.5, R.steel, { shift: -1 });
      }
    },
    gear(c) {
      const { f, add, P, R, arms, ch, pose, theta } = c;
      // scorching on the suit
      const soot = P(V(0, ch.hipY + 4, 11));
      add(soot.z + 0.9, () => {
        if (Math.cos(theta) < -0.3) return;
        for (let j = 0; j < 26; j++) {
          for (let i = -11; i <= 11; i++) {
            const y = soot.y + 8 - j;
            const t = j / 25;
            if (hash2(soot.x + i, y, 108) > 0.30 * (1 - t * 0.7) * (1 - Math.abs(i) / 14)) continue;
            over(f, soot.x + i, y, rgba(28, 22, 20, 255), 0.5);
          }
        }
      });
      // twin tanks
      for (let i = 0; i < 2; i++) {
        const side = i === 0 ? 1 : -1;
        const tc = V(side * 7.5, ch.shoulderY - 8, -10.5);
        const tp = P(tc);
        add(tp.z - 0.5, () => {
          const sft = tp.z < -2 ? -1 : 0;
          for (let k = 0; k <= 9; k++) {
            const t = k / 9;
            blob(f, tp.x, tp.y - 8 + t * 17, 4.4, 1.9, R.tank, { mode: 'cyl', nyBias: -0.1, shift: sft, grain: 0.07, seed: 111 + k });
          }
          blob(f, tp.x, tp.y - 8.4, 4.4, 2.4, R.tank, { shift: sft });
          blob(f, tp.x, tp.y + 8.6, 4.4, 2.2, R.tank, { shift: sft - 1 });
          // band + valve: the obvious weak point
          fillRect(f, Math.round(tp.x - 4.4), Math.round(tp.y - 1), 9, 2, R.dark[1]);
          blob(f, tp.x, tp.y - 10.4, 2.2, 1.8, R.brass, { shift: 1 });
          blob(f, tp.x, tp.y - 11.6, 1.4, 1.1, R.brass, { shift: 1 });
          glow(f, tp.x, tp.y - 11.4, 4.6, rgba(255, 246, 200, 255), { halo: 0.7, seed: 113, base: rgba(46, 34, 18, 255) });
          fillRect(f, Math.round(tp.x - 4.4), Math.round(tp.y - 5), 9, 2, R.brass[3]);
          px(f, Math.round(tp.x - 0.5), Math.round(tp.y - 11.8), rgba(255, 255, 240, 255));
        });
      }
      // hose from the tanks to the nozzle
      const hand = arms[0].hand;
      const hp = P(hand);
      add(hp.z + 3.2, () => {
        const a2 = P(V(4, ch.shoulderY - 12, -9));
        const pts = [a2, P(V(8, ch.hipY + 1, -4)), P(vadd(hand, V(0, -3, -2))), hp];
        for (let i = 0; i < pts.length - 1; i++) {
          capsule(f, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, 1.5, 1.5, R.dark, { shift: 0 });
        }
        // nozzle
        const E = { edge: ch.edge, edgeW: 0.9 };
        const d = vnorm(pose.gunDir || V(0, 0.05, 1));
        const n0 = P(vadd(hand, vmul(d, 1.5)));
        const n1 = P(vadd(hand, vmul(d, 10)));
        const nlen = Math.hypot(n1.x - n0.x, n1.y - n0.y);
        if (nlen < 5) {
          blob(f, n0.x, n0.y - 1, 4.0, 3.8, R.steel, { grain: 0.05, seed: 115, ...E });
          blob(f, n0.x, n0.y - 1, 2.2, 2.1, R.dark, { shift: 1 });
        } else {
          capsule(f, n0.x, n0.y, n1.x, n1.y, 2.5, 2.1, R.steel, { grain: 0.06, seed: 115, ...E });
          blob(f, n1.x, n1.y, 2.8, 2.8, R.steel, { shift: -1, ...E });
          blob(f, n1.x, n1.y, 1.5, 1.5, R.dark, { shift: 1 });
        }
        // pilot flame / firing plume
        const tipv = nlen < 5 ? vadd(hand, V(0, -1, 2)) : vadd(hand, vmul(d, 11));
        const pf = P(tipv);
        if (pose.flame) {
          const dx2 = pf.x - P(hand).x, dy2 = pf.y - P(hand).y;
          const jl = Math.hypot(dx2, dy2) || 1;
          const jx2 = dx2 / jl, jy2 = dy2 / jl;
          for (let i = 0; i < 26; i++) {
            const t = i / 25;
            const spread = t * 6.5;
            const q = {
              x: pf.x + jx2 * t * 14 + Math.sin(i * 2.3 + (pose.flameSeed || 0)) * spread,
              y: pf.y + jy2 * t * 14 + Math.cos(i * 1.7) * spread * 0.7 + t * t * 5,
            };
            const r = (3.2 + t * 6.5) * (1 + 0.2 * Math.sin(i * 2.1 + (pose.flameSeed || 0)));
            glow(f, q.x, q.y, r, mix(rgba(255, 252, 228, 255), rgba(222, 58, 14, 255), Math.min(1, t * 1.35)),
              { halo: 1, seed: 120 + i, base: rgba(58, 18, 8, 255), core: 0.48 });
          }
          glow(f, pf.x, pf.y, 5.5, rgba(255, 255, 246, 255), { halo: 1, seed: 119, base: rgba(140, 70, 22, 255) });
        } else {
          glow(f, pf.x, pf.y, 2.8, rgba(255, 200, 110, 255), { halo: 0.7, seed: 118, base: rgba(50, 24, 10, 255) });
        }
      });
    },
  };
}

/**
 * Ordnance Priest - tall hooded figure in a rubber apron-robe. No legs: the
 * robe is a cone with a swaying hem and boot tips peeking out.
 */
function makePriest() {
  const robe = rgba(58, 66, 60, 255);
  const R = {
    torso: mat(robe, { contrast: 1.1 }), sleeve: mat(shade(robe, 0.86)),
    trouser: mat(shade(robe, 0.8)), boot: mat(rgba(34, 32, 32, 255)),
    glove: mat(rgba(176, 168, 150, 255)),
    hood: mat(rgba(44, 50, 46, 255), { contrast: 1.15 }),
    void: flat(rgba(10, 12, 14, 255)),
    lamp: mat(rgba(198, 232, 250, 255), { contrast: 1.4 }),
    chain: mat(rgba(150, 150, 158, 255), { contrast: 1.3 }),
    brass: mat(rgba(184, 148, 66, 255), { contrast: 1.3 }),
    apron: mat(rgba(76, 84, 76, 255)),
  };
  return {
    id: 'priest', w: 64, h: 80,
    hipY: 36, shoulderY: 56, neckY: 59, headY: 66, neckZ: 0.4, headZ: 0.8,
    shoulderHalf: 9.5, legHalf: 4.6, ankleY: 3.0, footLen: 4.2,
    thigh: 17, shin: 16, upper: 12.5, fore: 12,
    armThick: 3.0, legThick: 4.0, stride: 3.0, lift: 1.2, hipDip: 0.9, lean: 0.02,
    robed: true, slices: 20, edge: rgba(14, 18, 16, 255),
    armPole: V(0.32, -0.85, -0.35),
    profile: [[0, 9.0, 7.0], [0.5, 9.6, 7.4], [0.8, 10.4, 7.6], [1, 9.6, 7.0]],
    ramps: R,
    head(f, c) {
      const { hd, theta, R, pose } = c;
      const fw = Math.cos(theta), sd = Math.sin(theta);
      const E = { edge: c.ch.edge, edgeW: 0.9 };
      // cowl: a tall teardrop leaning back, with a heavy front rim
      for (let i = 0; i <= 12; i++) {
        const t = i / 12;
        const y = hd.y - 9 + t * 15;
        const rx = lerp(2.6, 8.2, Math.pow(t, 0.62));
        blob(f, hd.x + sd * (1 - t) * 2.4, y, rx, 1.9, R.hood, { mode: 'cyl', nyBias: -0.3, grain: 0.05, seed: 131 + i, ...(i ? {} : E) });
      }
      blob(f, hd.x, hd.y + 3.6, 8.0, 5.0, R.hood, { grain: 0.05, seed: 145, ...E });
      if (fw > 0.3) {
        // the void inside the hood
        for (let i = 0; i <= 9; i++) {
          const t = i / 9;
          blob(f, hd.x, hd.y - 3.4 + t * 10, lerp(2.2, 5.0, Math.pow(t, 0.5)), 1.6, R.void, { mode: 'cyl' });
        }
        const g = pose.eyeGlow === undefined ? 1 : pose.eyeGlow;
        const ec = mix(rgba(126, 184, 214, 255), rgba(252, 254, 255, 255), g);
        for (const ex of [-2.6, 2.6]) {
          blob(f, hd.x + ex, hd.y + 1.2, 1.7, 1.4, flat(mix(ec, R.void[0], 0.4)));
          blob(f, hd.x + ex, hd.y + 1.0, 1.0, 0.9, flat(ec));
          glow(f, hd.x + ex, hd.y + 1.1, 3.4 + g * 2.4, ec, { halo: 0, seed: 133 });
        }
        // hood rim catches the light
        for (let a = -1.5; a < 1.5; a += 0.1) {
          px(f, Math.round(hd.x + Math.sin(a) * 6.6), Math.round(hd.y + 1.0 - Math.cos(a) * 7.4), R.hood[a < 0 ? 4 : 2]);
          px(f, Math.round(hd.x + Math.sin(a) * 7.4), Math.round(hd.y + 1.0 - Math.cos(a) * 8.2), R.hood[a < 0 ? 3 : 1]);
        }
      } else if (Math.abs(sd) > 0.5) {
        const s2 = sd > 0 ? -1 : 1;
        for (let i = 0; i <= 7; i++) {
          const t = i / 7;
          blob(f, hd.x + s2 * (2.2 + t * 2.2), hd.y - 2.4 + t * 8, lerp(1.8, 3.4, t), 1.5, R.void, { mode: 'cyl' });
        }
        const g = pose.eyeGlow === undefined ? 1 : pose.eyeGlow;
        const ec = mix(rgba(126, 184, 214, 255), rgba(252, 254, 255, 255), g);
        blob(f, hd.x + s2 * 5.0, hd.y + 1.0, 1.2, 1.1, flat(ec));
        glow(f, hd.x + s2 * 5.0, hd.y + 1.0, 3.4, ec, { halo: 0, seed: 135 });
        for (let a = -1.4; a < 1.4; a += 0.12) {
          px(f, Math.round(hd.x + s2 * (3.0 + Math.cos(a) * 3.6)), Math.round(hd.y + 0.6 + Math.sin(a) * 8.0), R.hood[3]);
        }
      } else {
        // back of the hood: a seam and a hanging cowl point
        for (let i = 0; i < 12; i++) px(f, Math.round(hd.x), Math.round(hd.y - 7 + i), R.hood[i % 3 ? 1 : 3]);
        blob(f, hd.x, hd.y + 6.0, 3.0, 2.4, R.hood, { shift: -1 });
      }
    },
    gear(c) {
      const { f, add, P, R, arms, ch, pose, theta, hipY } = c;
      const sway = pose.sway || 0;
      // robe cone from the hip to the floor - replaces the legs
      const rz = P(V(0, ch.hipY, 0));
      add(rz.z + 0.2, () => {
        const n = 22;
        for (let i = 0; i <= n; i++) {
          const t = i / n;
          const y = lerp(ch.hipY + 3, 0.6, t);
          const wide = lerp(9.4, 15.6, Math.pow(t, 1.25));
          const dep = lerp(7.2, 12.4, Math.pow(t, 1.25));
          const rx = Math.sqrt(Math.pow(wide * Math.cos(theta), 2) + Math.pow(dep * Math.sin(theta), 2));
          const p = P(V(sway * t * 1.4, y, 0));
          blob(f, p.x, p.y, rx, 2.1, R.torso, { mode: 'cyl', nyBias: -0.02, grain: 0.07, seed: 140 + i });
        }
        // vertical folds
        const base = P(V(0, 0.8, 0));
        for (let k = -3; k <= 3; k++) {
          if (k === 0) continue;
          const x0 = P(V(k * 2.4, ch.hipY + 2, 0));
          const x1 = P(V(k * 4.6 + sway * 1.4, 1.2, 0));
          line(f, x0.x, x0.y, x1.x, x1.y, R.torso[k % 2 ? 1 : 0]);
        }
        // hem shadow + boot tips
        for (let x = Math.round(base.x - 17); x < base.x + 17; x++) {
          for (let y = f.h - 3; y < f.h; y++) over(f, x, y, R.torso[0], 0.55);
        }
        const bt = pose.bootPhase || 0;
        const b1 = P(V(3.4, 0.6, 3.0 + Math.sin(bt) * 2.2));
        const b2 = P(V(-3.4, 0.6, 3.0 - Math.sin(bt) * 2.2));
        capsule(f, b1.x, b1.y, b1.x, b1.y + 1.2, 2.0, 2.0, R.boot);
        capsule(f, b2.x, b2.y, b2.x, b2.y + 1.2, 2.0, 2.0, R.boot);
      });
      // shoulder mantle over the robe
      const mz = P(V(0, ch.shoulderY - 2, 0));
      add(mz.z + 1.4, () => {
        for (let i = 0; i <= 8; i++) {
          const t = i / 8;
          const wide = lerp(9.0, 13.0, t), dep = lerp(7.4, 10.0, t);
          const rx = Math.sqrt(Math.pow(wide * Math.cos(theta), 2) + Math.pow(dep * Math.sin(theta), 2));
          blob(f, mz.x, mz.y - 2 + t * 10, rx, 2.0, R.hood, { mode: 'cyl', nyBias: -0.25, grain: 0.05, seed: 190 + i, ...(i ? {} : { edge: ch.edge, edgeW: 0.9 }) });
        }
        for (let k = -2; k <= 2; k++) {
          const x0 = P(V(k * 3.4, ch.shoulderY - 1, 0));
          const x1 = P(V(k * 4.6, ch.shoulderY - 10, 0));
          line(f, x0.x, x0.y, x1.x, x1.y, R.hood[k % 2 ? 0 : 3]);
        }
      });
      // apron panel + dosimeter chains
      const ap = P(V(0, ch.hipY + 9, 7.4));
      add(ap.z + 0.5, () => {
        if (Math.cos(theta) < -0.25) return;
        const wpx = Math.abs(Math.cos(theta)) * 7.0 + 1.6;
        for (let i = 0; i <= 12; i++) {
          const t = i / 12;
          blob(f, ap.x, ap.y - 9 + t * 20, wpx * lerp(0.8, 1.15, t), 1.7, R.apron, { mode: 'cyl', grain: 0.06, seed: 160 + i });
        }
        // stencilled trefoil-ish warhead mark
        const my2 = ap.y + 2;
        blob(f, ap.x, my2, 3.0, 4.0, flat(mix(R.brass[3], R.apron[2], 0.35)));
        blob(f, ap.x, my2 - 4.4, 1.8, 2.0, flat(mix(R.brass[4], R.apron[2], 0.3)));
        for (let k = -1; k <= 1; k += 2) {
          line(f, ap.x + k * 3, my2 + 4, ap.x + k * 5.5, my2 + 7, mix(R.brass[2], R.apron[1], 0.3));
        }
        for (let i = 0; i < 3; i++) {
          const bx = ap.x - wpx * 0.6 + i * wpx * 0.6;
          const by = ap.y - 6 + (i % 2) * 3;
          for (let k = 0; k < 6; k++) px(f, Math.round(bx + (k % 2 ? 0 : 1)), Math.round(ap.y - 12 + k), R.chain[k % 2 ? 2 : 3]);
          fillRect(f, Math.round(bx - 1), Math.round(by), 3, 4, R.chain[2]);
          px(f, Math.round(bx), Math.round(by + 1), rgba(220, 60, 50, 255));
        }
      });
      // censer on a chain, trailing smoke
      const hand = arms[1].hand;
      add(P(hand).z + 3, () => {
        const swing = pose.censer === undefined ? 0 : pose.censer;
        const cpos = vadd(hand, V(swing * 3.2, -9 - Math.abs(swing) * 1.5, 2 + swing * 1.2));
        const h2 = P(hand), c2 = P(cpos);
        line(f, h2.x, h2.y, c2.x, c2.y, R.chain[3]);
        line(f, h2.x + 1, h2.y, c2.x + 0.6, c2.y - 1, R.chain[1]);
        blob(f, c2.x, c2.y, 3.2, 3.0, R.brass, { grain: 0.05, seed: 171 });
        blob(f, c2.x, c2.y - 3.2, 2.0, 1.4, R.brass, { shift: 1 });
        for (let i = 0; i < 3; i++) line(f, c2.x - 2 + i * 2, c2.y + 1, c2.x - 2 + i * 2, c2.y + 2.4, R.void[0]);
        glow(f, c2.x, c2.y + 1.6, 3.6, rgba(255, 150, 60, 255), { halo: 0.7, seed: 172, base: rgba(40, 20, 10, 255) });
        // smoke plume
        for (let i = 0; i < 7; i++) {
          const t = i / 6;
          const sx = c2.x + Math.sin(i * 1.7 + swing * 2) * (1.6 + t * 4) - t * 2;
          const sy = c2.y - 4 - t * 12;
          glow(f, sx, sy, 2.2 + t * 3.4, mix(rgba(150, 158, 150, 255), rgba(48, 54, 58, 255), t),
            { halo: 0.7 - t * 0.5, seed: 180 + i, base: rgba(26, 30, 34, 255), core: 0.7 });
        }
      });
      // floating reliquary
      if (pose.reliquary) {
        const rp = P(V(0, ch.hipY + 21, 16));
        add(rp.z + 6, () => {
          const g = pose.reliquary;
          const EW = { edge: rgba(26, 22, 12, 255), edgeW: 0.9 };
          capsule(f, rp.x, rp.y - 7, rp.x, rp.y + 6, 4.2, 5.0, R.brass, { grain: 0.05, seed: 181, ...EW });
          blob(f, rp.x, rp.y - 8.8, 3.0, 3.4, R.brass, { shift: 1, ...EW });
          blob(f, rp.x, rp.y - 11.2, 1.4, 1.8, R.brass, { shift: 1 });
          fillRect(f, Math.round(rp.x - 5.2), Math.round(rp.y + 6), 11, 2, R.chain[2]);
          fillRect(f, Math.round(rp.x - 5.2), Math.round(rp.y + 6), 11, 1, R.chain[4]);
          for (let i = -1; i <= 1; i++) line(f, rp.x + i * 3.4, rp.y - 3, rp.x + i * 3.4, rp.y + 4, R.brass[i ? 1 : 0]);
          for (let k = -1; k <= 1; k += 2) {
            capsule(f, rp.x + k * 4.4, rp.y + 5, rp.x + k * 7.5, rp.y + 9, 1.6, 1.2, R.brass, { shift: k > 0 ? 0 : -1 });
          }
          glow(f, rp.x, rp.y + 1, 8 + g * 5, mix(rgba(120, 210, 145, 255), rgba(240, 255, 225, 255), g),
            { halo: 0.45 + g * 0.3, seed: 182, base: rgba(20, 34, 24, 255), core: 0.35 });
        });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// per-character pose scripts
// ---------------------------------------------------------------------------

/** Arms for a two-handed carry: both hands on a bar in front of the chest. */
function wrencherHands(ch, pose, mode, F) {
  const sw = Math.sin(pose.phase || 0);
  if (mode === 'walk') {
    // wrench cocked over the right shoulder, both hands on the grip
    const bob = sw * 1.2;
    pose.hands = [V(9.5, ch.shoulderY - 4 + bob, 6.2), V(4.0, ch.shoulderY - 8 + bob * 0.7, 7.4)];
    pose.wrenchTip = V(16.5, ch.shoulderY + 13 + bob, -1.5);
  } else if (mode === 'aim') {
    pose.hands = [V(9.0, ch.shoulderY + 3, 5.0), V(2.5, ch.shoulderY - 1, 7.0)];
    pose.wrenchTip = V(15, ch.shoulderY + 16, -6);
    pose.lean = -0.13;
  } else if (mode === 'fire') {
    pose.hands = [V(4.0, ch.shoulderY - 12, 13.5), V(-1.5, ch.shoulderY - 9, 12.0)];
    pose.wrenchTip = V(-2, ch.shoulderY - 26, 20);
    pose.lean = 0.36;
  } else if (mode === 'pain') {
    pose.hands = [V(12, ch.shoulderY - 1, 3.0), V(-11, ch.shoulderY + 5, 1.0)];
    pose.wrenchTip = V(21, ch.shoulderY + 15, 1.0);
    pose.lean = -0.24;
  } else {
    pose.hands = [V(9, ch.shoulderY - 8, 4), V(-9, ch.shoulderY - 9, 3)];
    pose.wrenchTip = V(14, ch.shoulderY + 2, 4);
  }
}

function sparkerHands(ch, pose, mode) {
  const sw = Math.sin(pose.phase || 0);
  if (mode === 'walk') {
    pose.hands = [V(6.5 - sw * 1.2, ch.shoulderY - 12 + sw * 1.5, 5.4 + sw * 3.4),
      V(-7.5 - sw * 0.6, ch.shoulderY - 13 - sw * 1.5, -1.5 - sw * 3.4)];
    pose.gunDir = V(0.8, -0.15, 0.6);
    pose.charge = 0.22 + 0.08 * Math.abs(sw);
  } else if (mode === 'aim') {
    pose.hands = [V(3.0, ch.shoulderY - 2.5, 9.0), V(-6.0, ch.shoulderY - 9, 2.0)];
    pose.gunDir = V(0.55, 0.02, 1);
    pose.charge = 0.85; pose.lean = 0.16; pose.gasp = 1;
  } else if (mode === 'fire') {
    pose.hands = [V(3.4, ch.shoulderY - 1.0, 8.0), V(-6.5, ch.shoulderY - 8, 1.0)];
    pose.gunDir = V(0.5, -0.1, 1);
    pose.charge = 1; pose.muzzle = 1; pose.lean = -0.06; pose.gasp = 1;
  } else if (mode === 'pain') {
    pose.hands = [V(9, ch.shoulderY + 3, 2), V(-9, ch.shoulderY + 4, 1)];
    pose.gunDir = V(0.4, -0.6, 0.6);
    pose.charge = 0.4; pose.lean = -0.28; pose.gasp = 1;
  } else {
    pose.hands = [V(7, ch.shoulderY - 10, 3), V(-7, ch.shoulderY - 11, 2)];
    pose.gunDir = V(0.3, 0.3, 0.9);
    pose.charge = 0.3;
  }
}

function bellowsHands(ch, pose, mode) {
  const sw = Math.sin(pose.phase || 0);
  if (mode === 'walk') {
    pose.hands = [V(13.0, ch.shoulderY - 11 + sw * 1.0, 6.0 + sw * 1.6),
      V(-13.0, ch.shoulderY - 13 - sw * 1.0, 2.0 - sw * 1.6)];
    pose.gunDir = V(0.95, 0.1, 0.35);
  } else if (mode === 'aim') {
    pose.hands = [V(9, ch.shoulderY - 6, 10), V(-3, ch.shoulderY - 9, 8)];
    pose.gunDir = V(0.9, -0.35, 0.3);
    pose.lean = 0.12;
  } else if (mode === 'fire') {
    pose.hands = [V(6, ch.shoulderY - 6, 12), V(-4, ch.shoulderY - 9, 10)];
    pose.gunDir = V(0.5, -0.8, 0.34);
    pose.flame = 1; pose.flameSeed = 1.1; pose.lean = -0.05;
  } else if (mode === 'pain') {
    pose.hands = [V(14, ch.shoulderY + 2, 2), V(-14, ch.shoulderY + 3, 1)];
    pose.gunDir = V(0.5, -0.5, 0.7);
    pose.lean = -0.2;
  } else {
    pose.hands = [V(12, ch.shoulderY - 10, 4), V(-12, ch.shoulderY - 11, 3)];
    pose.gunDir = V(0.4, 0.2, 0.9);
  }
}

function priestHands(ch, pose, mode) {
  const sw = Math.sin(pose.phase || 0);
  pose.sway = sw * 0.9;
  pose.bootPhase = pose.phase || 0;
  pose.censer = Math.sin((pose.phase || 0) + 0.7) * 0.9;
  if (mode === 'walk') {
    pose.hands = [V(5.5, ch.shoulderY - 20 + sw * 1.0, 7.5), V(-6.0, ch.shoulderY - 19 - sw * 1.0, 6.5)];
    pose.eyeGlow = 0.55 + 0.2 * Math.abs(sw);
  } else if (mode === 'aim') {
    pose.hands = [V(11.5, ch.shoulderY + 4, 12), V(-11.5, ch.shoulderY + 4, 12)];
    pose.reliquary = 0.5; pose.eyeGlow = 0.85; pose.censer = 0.5;
  } else if (mode === 'fire') {
    pose.hands = [V(10.5, ch.shoulderY + 8, 14), V(-10.5, ch.shoulderY + 8, 14)];
    pose.reliquary = 1; pose.eyeGlow = 1; pose.censer = -0.4;
  } else if (mode === 'pain') {
    pose.hands = [V(12, ch.shoulderY - 6, 3), V(-12, ch.shoulderY - 5, 2)];
    pose.eyeGlow = 1; pose.lean = -0.2; pose.censer = 1.1;
  } else {
    pose.hands = [V(6, ch.shoulderY - 19, 6), V(-6, ch.shoulderY - 19, 6)];
    pose.eyeGlow = 0.5;
  }
}

const HANDS = {
  wrencher: wrencherHands, sparker: sparkerHands, bellows: bellowsHands, priest: priestHands,
};

/** Standing pose with the feet planted (used by aim/fire/pain/death). */
function standPose(ch, o = {}) {
  return {
    phase: o.phase || 0,
    feet: [V(ch.legHalf * 1.05, ch.ankleY, (o.fz0 === undefined ? 2.0 : o.fz0)),
      V(-ch.legHalf * 1.05, ch.ankleY, (o.fz1 === undefined ? -2.0 : o.fz1))],
    hipDrop: o.hipDrop || 0,
    lean: o.lean === undefined ? ch.lean : o.lean,
    hands: [V(0, 0, 0), V(0, 0, 0)],
    hipZ: o.hipZ || 0,
    headBob: o.headBob || 0,
    headPush: o.headPush || 0,
    xform: o.xform || null,
  };
}

/**
 * Death keyframes: the body buckles at the knees and topples, and the whole
 * projected figure is rotated about a pivot that walks down to the floor.
 */
function deathPose(ch, k) {
  // k: 0..1 through die0..die3, then the corpse.
  const rot = lerp(0, -1.42, Math.pow(k, 0.86));
  const drop = lerp(0, ch.hipY * 0.62, Math.pow(k, 1.4));
  const pivY = ch.h - 1 - lerp(0, 2, k);
  const p = standPose(ch, {
    hipDrop: drop,
    lean: lerp(-0.22, 0.5, k),
    fz0: lerp(3.0, -1.5, k), fz1: lerp(-3.0, 1.5, k),
    xform: { px: ch.w / 2 - 2, py: pivY, rot, dx: lerp(0, -3, k), dy: lerp(0, 2.5, k) },
  });
  p.feet[0].y = ch.ankleY + lerp(0, 3.5, k);
  p.feet[1].y = ch.ankleY + lerp(0, 1.5, k);
  p.hands = [V(11 + k * 5, ch.shoulderY + lerp(2, -6, k), lerp(1, -6, k)),
    V(-11 - k * 4, ch.shoulderY + lerp(3, -5, k), lerp(0, -7, k))];
  p.headPush = lerp(0, -3, k);
  p.dying = k;
  return p;
}

// ---------------------------------------------------------------------------
// enemy frame assembly (humanoids)
// ---------------------------------------------------------------------------

function finishEnemy(f, o = {}) {
  if (o.flash) wash(f, rgba(228, 70, 58, 255), o.flash);
  topRim(f, WARM, 0.22, 0.08);
  outline(f, o.ink || INK);
  return f;
}

function paintHumanoidSet(out, ch) {
  const id = ch.id, hands = HANDS[id];
  for (let D = 0; D < 4; D++) {
    for (let F = 0; F < 4; F++) {
      const f = makeFrame(ch.w, ch.h);
      const pose = walkPose(ch, F);
      hands(ch, pose, 'walk', F);
      humanoid(f, ch, pose, D);
      out[`${id}_walk${D}_${F}`] = finishEnemy(f);
    }
  }
  for (const mode of ['aim', 'fire', 'pain']) {
    const f = makeFrame(ch.w, ch.h);
    const pose = standPose(ch, { phase: 0.7 });
    hands(ch, pose, mode);
    humanoid(f, ch, pose, 0);
    out[`${id}_${mode}`] = finishEnemy(f, { flash: mode === 'pain' ? 0.2 : 0 });
  }
  for (let k = 0; k < 4; k++) {
    const f = makeFrame(ch.w, ch.h);
    const t = [0.12, 0.4, 0.72, 0.97][k];
    const pose = deathPose(ch, t);
    hands(ch, pose, 'die');
    if (id === 'sparker') pose.charge = 0.5 - t * 0.5;
    if (id === 'priest') pose.eyeGlow = Math.max(0, 1 - t * 1.3);
    humanoid(f, ch, pose, 0);
    if (k === 0) wash(f, rgba(228, 70, 58, 255), 0.16);
    if (k >= 2) bloodSpray(f, ch, t);
    out[`${id}_die${k}`] = finishEnemy(f);
  }
  out[`${id}_dead`] = paintCorpse(ch);
}

function bloodSpray(f, ch, t) {
  const rng = makeRng(0x51e0 + ch.id.length * 977);
  const cx = ch.w / 2, cy = ch.h - 6;
  const dark = rgba(96, 16, 22, 255), lit = rgba(150, 30, 30, 255);
  for (let i = 0; i < 26 * t; i++) {
    const a = rng() * Math.PI * 2, r = rng() * 20 * t;
    const x = cx - 4 + Math.cos(a) * r * 1.4, y = cy + Math.sin(a) * r * 0.35 + 2;
    if (y > ch.h - 1) continue;
    px(f, x, y, rng() < 0.4 ? lit : dark);
    if (rng() < 0.4) px(f, x + 1, y, dark);
  }
}

function paintCorpse(ch) {
  const f = makeFrame(ch.w, ch.h);
  const R = ch.ramps;
  const gy = ch.h - 1;
  const cx = ch.w / 2;
  // blood pool first, so the body lies on it
  const pool = rgba(84, 14, 20, 255), pool2 = rgba(112, 22, 26, 255);
  for (let y = gy - 7; y <= gy; y++) {
    for (let x = 4; x < ch.w - 4; x++) {
      const u = (x - cx) / 24, v = (y - (gy - 2.5)) / 5.0;
      const d = u * u + v * v;
      if (d > 1) continue;
      if (d > 0.72 && hash2(x, y, 5501) > 0.55) continue;
      px(f, x, y, hash2(x, y, 5502) < 0.3 ? pool2 : pool);
    }
  }
  // the body: a heap of slumped masses
  const bodyR = ch.robed ? R.torso : R.torso;
  capsule(f, cx - 13, gy - 7, cx + 9, gy - 5, 6.2, 5.0, bodyR, { grain: 0.08, seed: 61 });
  capsule(f, cx + 6, gy - 5, cx + 18, gy - 2, 4.4, 3.0, R.trouser, { grain: 0.07, seed: 62 });
  capsule(f, cx + 2, gy - 3, cx + 15, gy - 1, 3.6, 2.6, R.trouser, { grain: 0.07, seed: 63 });
  capsule(f, cx + 14, gy - 2, cx + 20, gy - 1, 2.8, 2.4, R.boot, {});
  capsule(f, cx + 11, gy - 1, cx + 17, gy, 2.6, 2.2, R.boot, {});
  capsule(f, cx - 8, gy - 4, cx - 17, gy - 1, 3.0, 2.4, R.sleeve, { grain: 0.06, seed: 64 });
  blob(f, cx - 20, gy - 1, 2.6, 2.0, R.glove, {});
  // head
  const headR = ch.id === 'wrencher' ? R.hat : ch.id === 'priest' ? R.hood : ch.id === 'sparker' ? R.cap : R.steel;
  blob(f, cx - 16, gy - 8, 5.6, 4.6, headR, { grain: 0.05, seed: 65 });
  if (ch.id === 'wrencher') {
    blob(f, cx - 12, gy - 9, 4.0, 2.0, R.hat, { shift: 1 });
    capsule(f, cx + 4, gy - 9, cx + 20, gy - 7, 1.8, 1.6, R.steel, {});
    capsule(f, cx + 19, gy - 9, cx + 22, gy - 5, 2.4, 2.4, R.steel, {});
  }
  if (ch.id === 'priest') {
    blob(f, cx - 20, gy - 7, 4.0, 3.2, R.void, {});
    for (let i = 0; i <= 14; i++) {
      const t = i / 14;
      blob(f, cx - 2 + t * 18, gy - 5 + t * 3, lerp(7, 3, t), 2.2, R.torso, { mode: 'cyl', grain: 0.07, seed: 200 + i });
    }
  }
  if (ch.id === 'bellows') {
    blob(f, cx + 4, gy - 9, 5.0, 3.4, R.tank, { grain: 0.06, seed: 66 });
    blob(f, cx + 12, gy - 8, 4.4, 3.0, R.tank, { grain: 0.06, seed: 67 });
    blob(f, cx + 17, gy - 10, 1.8, 1.4, R.brass, { shift: 1 });
  }
  if (ch.id === 'sparker') {
    box(f, Math.round(cx + 6), gy - 10, 9, 6, R.steel, { grain: 0.07, seed: 68 });
    fillRect(f, Math.round(cx + 7), gy - 8, 7, 1, rgba(40, 60, 50, 255));
  }
  wash(f, rgba(60, 20, 26, 255), 0.16, (x, y) => y > gy - 5);
  topRim(f, WARM, 0.2, 0.06);
  outline(f, INK);
  return f;
}

// ---------------------------------------------------------------------------
// wasp - hovering drone, not humanoid
// ---------------------------------------------------------------------------

const WASP = {
  hull: mat(rgba(112, 124, 112, 255), { contrast: 1.2 }),
  hull2: mat(rgba(78, 88, 84, 255), { contrast: 1.25 }),
  steel: mat(rgba(134, 138, 146, 255), { contrast: 1.25 }),
  dark: mat(rgba(30, 32, 34, 255)),
  optic: mat(rgba(236, 62, 42, 255), { contrast: 1.45 }),
  warn: mat(rgba(206, 162, 42, 255), { contrast: 1.25 }),
  ink: rgba(14, 16, 16, 255),
};

/** Blurred rotor disc: a dithered ellipse ring, densities varying per frame. */
function rotor(f, cx, cy, rx, ry, ph, seed, dir) {
  const c1 = rgba(198, 208, 216, 255), c2 = rgba(104, 112, 122, 255), c3 = rgba(58, 62, 70, 255);
  for (let y = Math.floor(cy - ry - 1); y <= Math.ceil(cy + ry + 1); y++) {
    for (let x = Math.floor(cx - rx - 1); x <= Math.ceil(cx + rx + 1); x++) {
      const u = (x - cx) / rx, v = (y - cy) / ry;
      const d = Math.hypot(u, v);
      if (d > 1.02 || d < 0.2) continue;
      const a = Math.atan2(v, u);
      // two blades smeared by rotation: density peaks where a blade is
      const sp = 0.5 + 0.5 * Math.cos(2 * (a - ph * dir));
      let dens = (0.16 + 0.72 * Math.pow(sp, 1.8)) * (0.4 + 0.6 * d);
      if (d > 0.86) dens = Math.max(dens, 0.72);        // the blade-tip path
      const h = hash2(x, y, seed);
      if (h > dens) continue;
      px(f, x, y, h < dens * 0.32 ? c1 : (h < dens * 0.72 ? c2 : c3));
    }
  }
  // hub
  blob(f, cx, cy, 2.4, 1.8, WASP.steel, { edge: WASP.ink });
  blob(f, cx, cy - 0.4, 1.1, 0.9, WASP.dark, { shift: 1 });
}

function paintWasp(D, F, mode) {
  const w = 56, h = 40;
  const f = makeFrame(w, h);
  const R = WASP;
  const E = { edge: R.ink, edgeW: 0.9 };
  const cx = w / 2;
  const bob = mode === 'walk' ? Math.sin(F * Math.PI / 2) * 1.5 : (mode === 'pain' ? 2.2 : 0);
  const cy = 16 + bob;
  const theta = D * Math.PI / 2;
  const fw = Math.cos(theta), sd = Math.sin(theta);
  const side = Math.abs(sd) > 0.6;
  const ph = F * 0.9 + (mode === 'fire' ? 0.4 : 0);
  const len = side ? 12.5 : 7.5;

  // outriggers + rotors: far ones first
  const arm = side ? 8.5 : 13.5;
  const rots = side
    ? [{ x: cx - arm * (sd > 0 ? 1 : -1), y: cy - 10.5, near: false, r: 7.6 },
       { x: cx + arm * (sd > 0 ? 1 : -1), y: cy - 11.5, near: true, r: 9.0 }]
    : [{ x: cx - arm, y: cy - 11, near: true, r: 9.5 }, { x: cx + arm, y: cy - 11, near: true, r: 9.5 }];
  for (const rt of rots) {
    if (rt.near) continue;
    capsule(f, cx + (rt.x > cx ? 2 : -2), cy - 4.0, rt.x, rt.y + 1.5, 2.0, 1.4, R.hull2, { shift: -1, ...E });
    rotor(f, rt.x, rt.y, rt.r, 2.9, ph + 1.1, 601, -1);
  }
  // dangling grabber claws
  for (let i = 0; i < 2; i++) {
    const s2 = i ? 1 : -1;
    const lx = cx + s2 * (side ? 4.5 : 5.5);
    const sw2 = Math.sin(F * 1.1 + i * 2) * 1.4;
    capsule(f, lx, cy + 4, lx + sw2, cy + 10, 1.2, 1.0, R.steel, { shift: -1, ...E });
    capsule(f, lx + sw2, cy + 10, lx + sw2 * 1.7 + s2 * 1.5, cy + 15, 1.0, 0.8, R.steel, { shift: -1, ...E });
    blob(f, lx + sw2 * 1.7 + s2 * 1.5, cy + 15.5, 1.3, 1.1, R.steel, { shift: -1 });
  }
  // hull: a horizontal lozenge, lit like a cylinder lying on its side (shading
  // must vary with y here, not with x, or the body ends up striped)
  const hy = 5.6, hx = len;
  for (let y = Math.floor(cy - hy - 1.2); y <= Math.ceil(cy + hy + 1.2); y++) {
    const v = (y - cy - 0.4) / (hy + 1.2);
    if (Math.abs(v) > 1) continue;
    const hw = (hx + 1.2) * Math.sqrt(1 - v * v);
    for (let x = Math.round(cx - hw); x <= Math.round(cx + hw); x++) px(f, x, y, R.ink);
  }
  for (let y = Math.floor(cy - hy); y <= Math.ceil(cy + hy); y++) {
    const v = (y - cy - 0.4) / hy;
    if (Math.abs(v) > 1) continue;
    const hw = hx * Math.sqrt(1 - v * v);
    const nz = Math.sqrt(Math.max(0, 1 - v * v));
    for (let x = Math.round(cx - hw); x <= Math.round(cx + hw); x++) {
      const u = (x - cx) / Math.max(hw, 0.6);
      let b = band(clamp(lamOf(u * 0.28, v, nz * 0.95) * 0.72 + 0.3, 0, 1));
      if (hash2(x, y, 611) < 0.05) b -= 1;
      px(f, x, y, R.hull[clamp(b, 0, 4)]);
    }
  }
  // armoured upper deck
  capsule(f, cx - len * 0.74, cy - 4.6, cx + len * 0.74, cy - 5.0, 2.2, 2.0, R.hull2, { shift: 1, ...E });
  for (let i = -2; i <= 2; i++) px(f, Math.round(cx + i * len * 0.34), Math.round(cy - 6.2), R.steel[4]);
  // panel seams + hazard flash
  for (let i = -1; i <= 1; i++) {
    const sx = cx + i * len * 0.44;
    line(f, sx, cy - 3.4, sx, cy + 3.4, R.hull2[1]);
    line(f, sx + 1, cy - 3.4, sx + 1, cy + 3.4, R.hull[3]);
  }
  for (let x = -5; x <= 5; x++) {
    if (((x + 10) % 4) < 2) { px(f, cx + x, cy + 3.6, R.warn[3]); px(f, cx + x, cy + 4.4, R.warn[1]); }
  }
  // running lights on the flanks
  for (const sgn of [-1, 1]) {
    const lx = cx + sgn * len * 0.66;
    blob(f, lx, cy + 1.6, 1.1, 1.0, flat(rgba(255, 150, 70, 255)));
    glow(f, lx, cy + 1.6, 2.4, rgba(255, 140, 60, 255), { halo: 0, tint: 0.55, seed: 645 });
  }
  if (fw > 0.35) {
    // face: a single optic in a dark socket
    const g = mode === 'fire' ? 1 : mode === 'aim' ? 0.75 : 0.35 + 0.15 * Math.sin(F * 1.6);
    blob(f, cx, cy - 0.2, 5.2, 4.6, R.dark, { shift: 1, ...E });
    blob(f, cx, cy - 0.2, 3.6, 3.2, R.optic, { shift: g > 0.6 ? 1 : 0 });
    blob(f, cx, cy - 0.2, 1.6, 1.4, flat(mix(rgba(255, 200, 180, 255), rgba(130, 12, 10, 255), 1 - g)));
    glow(f, cx, cy - 0.2, 5.5 + g * 2, rgba(255, 80, 50, 255), { halo: 0.34 + g * 0.3, tint: 0.3, seed: 620, base: rgba(34, 12, 10, 255), core: 0.8 });
    px(f, Math.round(cx - 1), Math.round(cy - 1.8), rgba(255, 226, 212, 255));
  } else if (side) {
    const s2 = sd > 0 ? -1 : 1;
    blob(f, cx + s2 * len * 0.78, cy - 0.4, 2.8, 3.2, R.dark, { shift: 1, ...E });
    const g = mode === 'fire' ? 1 : 0.5;
    blob(f, cx + s2 * len * 0.82, cy - 0.4, 1.5, 1.9, R.optic, {});
    glow(f, cx + s2 * len * 0.82, cy - 0.4, 4.5, rgba(255, 80, 50, 255), { halo: 0.45, tint: 0.35, seed: 621, base: rgba(34, 12, 10, 255), core: 0.8 });
    stencil(f, Math.round(cx - 5), Math.round(cy - 2), '7', R.warn[4], 0.9);
  } else {
    // back: exhaust ports
    for (let i = -1; i <= 1; i++) {
      blob(f, cx + i * 4.6, cy - 0.2, 2.0, 2.0, R.dark, { shift: 1, ...E });
      glow(f, cx + i * 4.6, cy - 0.2, 3.0, rgba(255, 150, 70, 255), { halo: 0.35, tint: 0.4, seed: 630 + i, base: rgba(34, 18, 10, 255), core: 0.85 });
    }
    fillRect(f, Math.round(cx - 6), Math.round(cy - 3.4), 13, 1, R.warn[3]);
  }
  // near rotors
  for (const rt of rots) {
    if (!rt.near) continue;
    capsule(f, cx + (rt.x > cx ? 2 : -2), cy - 4.0, rt.x, rt.y + 1.5, 2.2, 1.6, R.hull2, { ...E });
    rotor(f, rt.x, rt.y, rt.r, 3.3, ph, 602, 1);
  }
  // faint underglow, clear of the hull so it does not tint the armour
  glow(f, cx, cy + 7.6, 4.4, rgba(255, 120, 50, 255),
    { halo: 0.13, tint: 0.18, seed: 640, base: rgba(24, 12, 9, 255), core: 1.0 });
  return f;
}

function paintWaspSet(out) {
  for (let D = 0; D < 4; D++) {
    for (let F = 0; F < 4; F++) {
      out[`wasp_walk${D}_${F}`] = finishEnemy(paintWasp(D, F, 'walk'));
    }
  }
  out.wasp_aim = finishEnemy(paintWasp(0, 1, 'aim'));
  out.wasp_fire = finishEnemy(paintWasp(0, 2, 'fire'));
  out.wasp_pain = finishEnemy(paintWasp(0, 3, 'pain'), { flash: 0.2 });
  for (let k = 0; k < 4; k++) out[`wasp_die${k}`] = finishEnemy(paintWaspDie(k));
  out.wasp_dead = finishEnemy(paintWaspDead());
}

function paintWaspDie(k) {
  const w = 56, h = 40;
  const f = makeFrame(w, h);
  const R = WASP;
  const t = k / 3;
  const cx = w / 2 - 2 + k, cy = 13 + t * 16;
  const rot = t * 1.5;
  const cr = Math.cos(rot), sr = Math.sin(rot);
  const bodyLen = 9;
  for (let i = -bodyLen; i <= bodyLen; i++) {
    const tt = i / bodyLen;
    const ry = 6.0 * Math.sqrt(Math.max(0, 1 - tt * tt * 0.82));
    const x = cx + i * cr, y = cy + i * sr;
    blob(f, x, y, 1.3, ry, R.hull, { mode: 'cyl', nyBias: -0.2, grain: 0.06 + t * 0.12, seed: 650 + i, shift: k >= 2 ? -1 : 0 });
  }
  // one rotor sheared off, the other stalling
  if (k < 3) rotor(f, cx - 12 + k * 3, cy - 6 + k * 2, 10.5 - k * 2.2, 3.0, k * 1.3, 651, 1);
  capsule(f, cx, cy - 3, cx - 10 + k * 2, cy - 4 + k * 3, 2.2, 1.6, R.hull2, { shift: -1 });
  if (k === 0) {
    rotor(f, cx + 13, cy - 6, 11, 3.2, 0.4, 652, -1);
  } else {
    // shrapnel
    const rng = makeRng(0x9a11 + k);
    for (let i = 0; i < 8 + k * 4; i++) {
      const a = rng() * 6.28, r = 6 + rng() * (10 + k * 6);
      px(f, cx + Math.cos(a) * r, cy + Math.sin(a) * r * 0.8, R.steel[rng() < 0.5 ? 1 : 3]);
    }
  }
  // fire + smoke
  glow(f, cx + 3, cy - 1, 5 + k * 2.5, mix(rgba(255, 230, 160, 255), rgba(230, 70, 20, 255), t), { halo: 0.9, seed: 660 + k, base: rgba(50, 20, 10, 255) });
  for (let i = 0; i < 4 + k * 2; i++) {
    const q = i / 6;
    glow(f, cx + 4 + Math.sin(i * 1.9) * 5, cy - 4 - i * 3.2, 2.4 + i * 1.1,
      mix(rgba(140, 140, 140, 255), rgba(40, 44, 48, 255), q), { halo: 0.6, seed: 670 + i, base: rgba(24, 26, 30, 255), core: 0.7 });
  }
  if (k >= 2) wash(f, rgba(30, 24, 22, 255), 0.22);
  return f;
}

function paintWaspDead() {
  const w = 56, h = 40;
  const f = makeFrame(w, h);
  const R = WASP;
  const gy = h - 1, cx = w / 2;
  // scorch under the wreck
  for (let y = gy - 5; y <= gy; y++) {
    for (let x = 6; x < w - 6; x++) {
      const u = (x - cx) / 20, v = (y - (gy - 2)) / 4;
      if (u * u + v * v > 1) continue;
      if (hash2(x, y, 700) > 0.7) continue;
      px(f, x, y, rgba(26, 22, 22, 255));
    }
  }
  capsule(f, cx - 10, gy - 4, cx + 8, gy - 2, 4.6, 3.4, R.hull, { grain: 0.14, seed: 701, shift: -1 });
  capsule(f, cx + 5, gy - 6, cx + 16, gy - 3, 2.4, 1.8, R.hull2, { grain: 0.1, seed: 702, shift: -1 });
  // bent rotor
  for (let i = 0; i < 14; i++) {
    const t = i / 13;
    px(f, cx - 12 - t * 9, gy - 6 + Math.sin(t * 2.6) * 4, R.steel[t < 0.5 ? 2 : 1]);
    px(f, cx - 12 - t * 9, gy - 5 + Math.sin(t * 2.6) * 4, R.steel[1]);
  }
  blob(f, cx - 2, gy - 5, 2.4, 2.0, R.dark, { shift: 1 });
  glow(f, cx - 2, gy - 5, 3.2, rgba(180, 40, 30, 255), { halo: 0.3, seed: 703, base: rgba(30, 12, 10, 255) });
  for (let i = 0; i < 3; i++) {
    glow(f, cx + 2 + i * 3, gy - 8 - i * 3, 2.2 + i, rgba(90, 96, 100, 255), { halo: 0.5, seed: 710 + i, base: rgba(24, 26, 30, 255), core: 0.7 });
  }
  wash(f, rgba(24, 20, 20, 255), 0.2);
  return f;
}

export function buildSprites() {
  const frames = {};
  const cast = [makeWrencher(), makeSparker(), makeBellows(), makePriest()];
  for (const ch of cast) paintHumanoidSet(frames, ch);
  paintWaspSet(frames);
  paintMutterSet(frames);
  paintProps(frames);
  paintSky(frames);
  paintDecals(frames);
  return { frames };
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
  // --- cheek plates flanking the mouth
  for (const sx of [-1, 1]) {
    const cx0 = MMX + sx * 33 - 10;
    box(f, cx0, 98, 20, 26, R.steel2, { grain: 0.07, seed: 806 + sx });
    for (let i = 0; i < 4; i++) {
      blob(f, cx0 + 4 + (i % 2) * 12, 103 + ((i / 2) | 0) * 15, 2.2, 2.2, R.steel, {});
      px(f, cx0 + 3 + (i % 2) * 12, 102 + ((i / 2) | 0) * 15, R.steel[4]);
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

function paintMutter(o) {
  const f = makeFrame(MW, MH);
  mutterCables(f, o.droop || 0);
  mutterShell(f);
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
  topRim(f, WARM, 0.26, 0.1);
  outline(f, MU.ink);
  return f;
}

function paintMutterSet(out) {
  for (let i = 0; i < 4; i++) {
    const p = i / 4 * Math.PI * 2;
    out[`mutter_idle${i}`] = paintMutter({
      eye: 0.40 + 0.18 * Math.sin(p), eyeR: 0.40 + 0.18 * Math.sin(p + 1.6),
      lidL: i === 2 ? 0.62 : 0, lidR: i === 2 ? 0.45 : 0,
      iris: 0, droop: 0.05 * Math.sin(p),
    });
  }
  out.mutter_fire0 = paintMutter({ eye: 0.78, iris: 0.3, droop: 0.02 });
  out.mutter_fire1 = paintMutter({ eye: 0.95, iris: 0.8, fire: 0.4 });
  out.mutter_fire2 = paintMutter({ eye: 1, iris: 1, fire: 1, flash: 0.1 });
  out.mutter_pain = paintMutter({ eye: 1, eyeR: 1, iris: 0.12, flash: 0.1, lidL: 0.3, damage: 0.1, hurt: 1 });
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
    });
  }
  out.mutter_dead = paintMutter({
    damage: 1, eye: 0, eyeR: 0, brokenL: true, brokenR: true,
    iris: 0.3, dead: true, droop: 1.2, soot: 0.52, lidL: 0.4, lidR: 0.55,
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
  out.weapon_deadman = paintWeapon('deadman');
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
