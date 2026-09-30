// propmodels_office.js - the washroom, the copier room and the canteen.
//
// See propmodels.js for how a model is written. The washroom fixtures
// (toilet, urinal, sink) hang or stand with their backs on the wall plane a
// little behind the origin (z -0.18..-0.2) and their pipes run into it; the
// rest is centred on its footprint like the core furniture.

import { C, TAU, mat, inkAt } from './propkit.js';

// ------------------------------------------------------------------ helpers

function h3(x, y, z, s) {
  let h = (Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 2147483647) ^ Math.imul(s | 0, 1274126177)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
/** Smooth value noise, for stains and blotches painted on a face. */
function vn3(x, y, z, s) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy), uz = fz * fz * (3 - 2 * fz);
  const L = (a, b, t) => a + (b - a) * t;
  const c = (i, j, k) => h3(ix + i, iy + j, iz + k, s);
  return L(L(L(c(0, 0, 0), c(1, 0, 0), ux), L(c(0, 1, 0), c(1, 1, 0), ux), uy),
    L(L(c(0, 0, 1), c(1, 0, 1), ux), L(c(0, 1, 1), c(1, 1, 1), ux), uy), uz);
}
/** A little seeded generator, so a shelf is stocked the same whole or broken. */
function srand(seed) {
  let s = seed >>> 0 || 1;
  return () => { s = (Math.imul(s ^ (s >>> 15), 2246822519) + 0x9e3779b9) >>> 0; return s / 4294967296; };
}
/**
 * Lift anything a wreck has knocked through the floor back up onto it. Only
 * standing frames: a falling pose carries its own transform on the stack.
 */
function settle(M, from = 0) {
  if (M.stack.length !== 1) return;
  for (let i = from; i < M.prims.length; i++) {
    const p = M.prims[i], X = p.X, h = p.half;
    let ext;
    if (p.type === 0) ext = Math.abs(X[3]) * h[0] + Math.abs(X[4]) * h[1] + Math.abs(X[5]) * h[2];
    else if (p.type === 3) ext = Math.hypot(X[3] * h[0], X[4] * h[1], X[5] * h[2]);
    else ext = Math.abs(X[4]) * h[1] + Math.hypot(X[3], X[5]) * h[0];
    const low = X[10] - ext;
    if (low < 0) X[10] -= low;
  }
}
/** Round a cylinder: 0 at its front (+z), positive toward its right (+x). */
const around = (lx, lz) => Math.atan2(lx, lz);
const shade = (c, k) => [Math.min(255, c[0] * k), Math.min(255, c[1] * k), Math.min(255, c[2] * k)];
/** A crack running down a face, somewhere about u0. */
const crackAt = (u, v, u0, s) => Math.abs(u - (u0 + 0.05 * Math.sin(v * 21 + s) + 0.02 * Math.sin(v * 63 + s * 3))) < 0.008;

// ------------------------------------------------------------------ materials

const X = {
  seat: mat('plastic', [222, 214, 192], { gloss: 0.5 }),
  water: mat('glass', [104, 134, 140], { gloss: 0.9 }),
  pee: mat('glass', [184, 170, 86], { gloss: 0.9 }),
  dirty: mat('glass', [104, 96, 64], { gloss: 0.85 }),
  pink: mat('plastic', [238, 126, 172], { gloss: 0.15 }),
  soap: mat('plastic', [206, 218, 150], { gloss: 0.35 }),
  tapRed: mat('plastic', [206, 36, 32], { gloss: 0.6 }),
  tapBlue: mat('plastic', [40, 84, 206], { gloss: 0.6 }),
  mag: mat('paper', [236, 204, 70], { gloss: 0.3 }),
  potPlastic: mat('plastic', [206, 198, 180], { gloss: 0.3 }),
  stem: mat('wood', [96, 76, 50], { grain: 0.4 }),
  cane: mat('wood', [210, 186, 118], { grain: 0.5 }),
  rubberLeaf: mat('plastic', [40, 88, 42], { gloss: 0.55, pw: 26 }),
  sheath: mat('plastic', [176, 66, 56], { gloss: 0.3 }),
  yuccaLeaf: mat('plastic', [80, 136, 60], { gloss: 0.3 }),
  bark: mat('wood', [132, 114, 88], { grain: 0.6 }),
  butt: mat('paper', [230, 218, 196]),
  binGreen: mat('paint', [84, 104, 90], { wear: 0.6, rust: 0.15 }),
  banana: mat('plastic', [230, 198, 60], { gloss: 0.2 }),
  yellow: mat('plastic', [236, 186, 30], { gloss: 0.4 }),
  greyPlastic: mat('plastic', [100, 102, 100]),
  mopHead: mat('fabric', [182, 172, 146]),
  orange: mat('plastic', [242, 102, 28], { gloss: 0.45 }),
  card: mat('paper', [178, 146, 100]),
  book: mat('leather', [160, 160, 160]),
  binder: mat('plastic', [160, 160, 160], { gloss: 0.4 }),
  copier: mat('plastic', [218, 210, 186], { gloss: 0.3 }),
  copierBrown: mat('plastic', [128, 100, 74], { gloss: 0.3 }),
  lid: mat('plastic', [100, 96, 90]),
  panel: mat('plastic', [66, 66, 70]),
  lcd: mat('screen', [40, 90, 50], { glow: 0.7 }),
  startGreen: mat('plastic', [60, 170, 80], { gloss: 0.5 }),
  platen: mat('glass', [70, 90, 96]),
  toner: mat('plastic', [20, 20, 22], { gloss: 0.15 }),
  bentwood: mat('wood', [96, 58, 34], { gloss: 0.35 }),
  khaki: mat('fabric', [172, 148, 102]),
  khakiDark: mat('fabric', [136, 114, 78]),
  felt: mat('fabric', [74, 66, 60]),
  red: mat('paint', [194, 28, 26], { wear: 0.3, gloss: 0.5 }),
  pinYellow: mat('plastic', [236, 204, 40]),
  tag: mat('paper', [238, 222, 120]),
  powder: mat('foam', [238, 238, 230]),
  cart: mat('paint', [54, 56, 62], { wear: 0.5 }),
  tvWood: mat('wood', [120, 76, 42], { grain: 1.1, gloss: 0.3 }),
  tvBack: mat('plastic', [70, 52, 40]),
  bezel: mat('plastic', [42, 40, 38]),
  knob: mat('plastic', [150, 150, 146], { gloss: 0.5 }),
  tvScreen: mat('screen', [140, 150, 160], { glow: 0.55 }),
  vcr: mat('plastic', [54, 54, 58], { gloss: 0.4 }),
  tape: mat('plastic', [28, 28, 30]),
  ribbon: mat('plastic', [76, 50, 30], { gloss: 0.6 }),
  formica: mat('plastic', [178, 200, 184], { gloss: 0.35 }),
  tray: mat('plastic', [168, 120, 76], { gloss: 0.3 }),
  trayGrey: mat('plastic', [140, 148, 150], { gloss: 0.3 }),
  mash: mat('foam', [236, 226, 190]),
  meat: mat('flesh', [112, 62, 38]),
  peas: mat('plastic', [96, 150, 50], { gloss: 0.4 }),
  jello: mat('glass', [210, 34, 44], { gloss: 0.8 }),
  ketchup: mat('plastic', [200, 24, 20], { gloss: 0.6 }),
  splat: mat('plastic', [170, 16, 14], { gloss: 0.7 }),
  can: mat('metal', [190, 190, 196], { gloss: 0.6 }),
  chipR: mat('plastic', [196, 40, 40]),
  chipB: mat('plastic', [40, 70, 180]),
  chipW: mat('plastic', [230, 228, 220]),
  cash: mat('paper', [150, 180, 130]),
  donut: mat('foam', [196, 140, 80]),
  pinkBox: mat('paper', [232, 170, 180]),
  flask: mat('metal', [150, 60, 50], { gloss: 0.5 }),
};

// ------------------------------------------------------------------ the washroom

/** Institutional toilet: cistern on the wall, cream seat, the lid up or down. */
function toilet(M) {
  const P = C.porcelain, zw = -0.2;
  const wreck = M.wreck, hurt = M.hurt && !wreck, lidUp = M.variant === 1;
  // water from the wall: a rose, a stop valve with its red wheel, the riser up into the cistern
  M.cyl([-0.088, 0.09, zw + 0.004], 0.02, 0.008, C.chrome, { axis: 'z' });
  M.rod([-0.088, 0.09, zw], [-0.088, 0.09, -0.15], 0.007, C.chrome);
  M.sph([-0.088, 0.09, -0.158], 0.013, C.brass);
  M.cyl([-0.088, 0.106, -0.158], 0.013, 0.006, C.colaRed);
  M.rod([-0.088, 0.09, -0.158], [-0.088, wreck ? 0.15 : 0.21, -0.158], 0.007, C.chrome);
  // the foot flares onto the floor; capped bolts either side
  M.slab(-0.086, 0, -0.15, 0.086, 0.02, 0.075, P, { bevel: 0.01, fixed: true });
  M.slab(-0.062, 0.01, -0.14, 0.062, wreck ? 0.085 : 0.125, 0.064, P, { bevel: 0.02, fixed: true });
  for (const s of [-1, 1]) M.sph([s * 0.074, 0.026, -0.03], [0.01, 0.009, 0.013], P);
  // the back of the bowl, which carries the cistern
  M.slab(-0.075, 0.1, -0.168, 0.075, 0.208, -0.07, P, { bevel: 0.02, fixed: true });
  M.slab(-0.12, 0.208, -0.197, 0.12, 0.405, -0.102, P, {
    bevel: 0.016, fixed: true,
    paint: (u, v, face) => {
      if (face !== 4) return null;
      if ((hurt || wreck) && v > 0.05 && v < 0.8 && crackAt(u, v, 0.7, 2)) return [70, 70, 70];
      if (u > 0.42 && u < 0.58 && v > 0.14 && v < 0.26) return v > 0.19 && v < 0.21 && u > 0.45 && u < 0.55 ? [236, 232, 220] : [46, 70, 150];
      return null;
    },
  });
  // flush lever
  M.cyl([-0.088, 0.372, -0.098], 0.012, 0.008, C.chrome, { axis: 'z' });
  M.slab(-0.088, 0.366, -0.1, -0.036, 0.377, -0.09, C.chrome, { bevel: 0.004 });
  if (wreck) {
    // the cistern lid is on the floor, the bowl in pieces round the stump
    M.slab(0.1, 0, -0.1, 0.35, 0.025, 0.006, P, { bevel: 0.01, keep: true, yaw: 0.5 });
    M.push([0.08, 0, 0.16], 0.9);
    M.cone([0, 0.06, 0], 0.056, 0.092, 0.09, P, { keep: true, roll: 1.4 });
    M.pop();
    M.sph([-0.07, 0.03, 0.14], [0.07, 0.03, 0.05], P, { keep: true, yaw: 0.4, roll: 0.5 });
    for (const [x, z, a] of [[-0.16, 0.02, 0.6], [0.02, 0.26, 2.1], [-0.2, 0.2, 1.2], [0.22, 0.1, 2.8], [-0.02, 0.1, 0.3]]) {
      M.box([x, 0.01, z], [0.055, 0.012, 0.035], P, { keep: true, yaw: a, roll: 0.25 });
    }
    M.sph([-0.2, 0.05, 0.08], [0.094, 0.009, 0.114], X.seat, { keep: true, roll: 0.5, yaw: 0.5 });
    M.sph([0.0, 0.004, 0.1], [0.28, 0.005, 0.2], X.water, { keep: true });
    M.slab(0.2, 0, 0.18, 0.3, 0.006, 0.25, X.mag, { keep: true, yaw: -0.4, paint: magCover });
    settle(M);
    return;
  }
  // the cistern lid: knocked askew when it has been hit
  if (hurt) M.box([0.03, 0.418, -0.135], [0.252, 0.025, 0.104], P, { bevel: 0.012, yaw: 0.22, roll: -0.04 });
  else M.slab(-0.126, 0.405, -0.2, 0.126, 0.43, -0.096, P, { bevel: 0.012, fixed: true });
  if (!lidUp && !hurt) M.slab(-0.1, 0.43, -0.185, 0.0, 0.436, -0.115, X.mag, { yaw: 0.25, paint: magCover });
  // the bowl: two cones make it oval
  for (const z of [-0.034, 0.034]) {
    M.cone([0, 0.16, z], 0.056, 0.092, 0.09, P, {
      fixed: true,
      paint: hurt && z > 0 ? (u, v, face, lx, ly, lz) => (Math.abs(around(lx, lz) - 0.4 - ly * 6) < 0.05 ? [70, 70, 70] : null) : null,
    });
  }
  // the seat: the bowl and the water show through its hole
  M.sph([0, 0.212, 0.01], [0.094, 0.009, 0.114], X.seat, {
    paint: (u, v, face, lx, ly, lz) => {
      if (face !== 2) return null;
      const e = (lx / 0.062) ** 2 + ((lz - 0.006) / 0.078) ** 2;
      if (e > 1) return null;
      if (e > 0.5) return [226, 226, 220];
      return lidUp ? [176, 162, 80, 2.4] : [104, 134, 140, 2.4];
    },
  });
  for (const s of [-1, 1]) M.cyl([s * 0.045, 0.218, -0.094], 0.008, 0.022, C.chrome, { axis: 'x' });
  if (lidUp) {
    M.push([0, 0.222, -0.088], 0, -1.62, 0);
    M.sph([0, 0, 0.108], [0.09, 0.008, 0.108], X.seat);
    M.pop();
  } else {
    M.sph([0, 0.225, 0.01], [0.092, 0.008, 0.112], X.seat);
  }
  if (hurt) M.cyl([0.16, 0.024, 0.08], 0.03, 0.046, C.paper, { axis: 'x', yaw: 0.7, paint: rollEnd });
}

/** The end of a paper roll: its cardboard core. */
const rollEnd = (u, v, face, lx, ly, lz) => (face === 2 || face === 3) && lx * lx + lz * lz < 0.012 * 0.012 ? [150, 120, 84] : null;

/** A dog-eared magazine: red masthead, a lot of skin, yellow border. */
const magCover = (u, v, face) => {
  if (face !== 2) return null;
  if (v < 0.22) return inkAt('BOOM', (u - 0.15) / 0.7, (v - 0.04) / 0.14) ? [250, 240, 220] : [200, 30, 30];
  const d = ((u - 0.5) / 0.3) ** 2 + ((v - 0.62) / 0.3) ** 2;
  if (d < 1) return [226, 170, 136];
  return null;
};

/** Wall urinal: a flush valve over it, a pink cake in the drain, a target to aim at. */
function urinal(M) {
  const P = C.porcelain, zw = -0.18;
  const wreck = M.wreck, hurt = M.hurt && !wreck;
  // supply out of the wall, the flushometer, its handle, down into the spud
  M.cyl([0.07, 0.6, zw + 0.004], 0.018, 0.008, C.chrome, { axis: 'z' });
  M.rod([0.07, 0.6, zw], [0.07, 0.6, -0.14], 0.008, C.chrome);
  M.rod([0.07, 0.6, -0.14], [0.015, 0.6, -0.14], 0.008, C.chrome);
  M.cyl([0, 0.6, -0.14], 0.019, 0.04, C.chrome);
  M.sph([0, 0.62, -0.14], [0.019, 0.008, 0.019], C.chrome);
  M.rod([-0.004, 0.596, -0.124], [-0.03, 0.578, -0.098], 0.006, C.chrome);
  M.sph([-0.03, 0.578, -0.098], 0.008, C.black);
  if (wreck) M.rod([0, 0.58, -0.14], [0.02, 0.5, -0.1], 0.009, C.chrome);
  else M.rod([0, 0.58, -0.14], [0, 0.55, -0.14], 0.009, C.chrome);
  // the waste out of the bottom and back into the wall
  M.cyl([0, 0.085, zw + 0.004], 0.022, 0.008, C.chrome, { axis: 'z' });
  M.rod([0, 0.085, zw], [0, 0.085, wreck ? -0.15 : -0.115], 0.012, C.chrome);
  if (!wreck) {
    M.sph([0, 0.085, -0.115], 0.012, C.chrome);
    M.rod([0, 0.085, -0.115], [0, 0.15, -0.115], 0.012, C.chrome);
  }
  const target = (u, v, face) => {
    if (face !== 4) return null;
    if (hurt && v > 0.1 && v < 0.6 && crackAt(u, v, 0.3, 5)) return [80, 80, 80];
    const d = Math.hypot((u - 0.5) * 0.2, (v - 0.54) * 0.385);
    if (d < 0.006) return [200, 30, 30];
    if (d < 0.011) return [240, 236, 226];
    if (d < 0.017) return [200, 30, 30];
    return null;
  };
  if (wreck) {
    // a stub of it left on the wall, the rest on the floor
    M.slab(-0.1, 0.36, zw, 0.1, 0.55, zw + 0.028, P, { bevel: 0.014, keep: true });
    M.sph([0, 0.54, -0.145], [0.102, 0.022, 0.036], P, { keep: true });
    M.sph([0.084, 0.47, -0.13], [0.02, 0.09, 0.05], P, { keep: true });
    M.box([-0.06, 0.37, -0.15], [0.08, 0.05, 0.02], P, { keep: true, roll: 0.6 });
    M.push([0.06, 0, 0.12], 0.8);
    M.cone([0, 0.06, 0], 0.045, 0.09, 0.12, P, { keep: true, roll: 1.3 });
    M.pop();
    M.sph([-0.14, 0.02, 0.1], [0.02, 0.18, 0.06], P, { keep: true, roll: 1.5, yaw: 0.5 });
    M.sph([0.2, 0.02, 0.2], [0.02, 0.1, 0.05], P, { keep: true, roll: 1.4, yaw: -0.7 });
    for (const [x, z, a] of [[-0.05, 0.28, 0.3], [0.16, -0.05, 1.9], [-0.24, 0.24, 2.4], [0.02, 0.05, 1.1]]) {
      M.box([x, 0.01, z], [0.06, 0.012, 0.04], P, { keep: true, yaw: a, roll: 0.3 });
    }
    M.box([-0.1, 0.01, 0.3], [0.046, 0.016, 0.032], X.pink, { keep: true, bevel: 0.007, yaw: 0.9 });
    M.sph([0.0, 0.004, 0.14], [0.26, 0.005, 0.18], X.pee, { keep: true });
    settle(M);
    return;
  }
  // porcelain: a back plate, a rounded hood, two wings, the basin and its lip
  M.slab(-0.1, 0.16, zw, 0.1, 0.545, zw + 0.028, P, { bevel: 0.014, fixed: true, paint: target });
  M.sph([0, 0.535, -0.142], [0.102, 0.026, 0.038], P, { fixed: true });
  for (const s of [-1, 1]) {
    if (hurt && s < 0) M.sph([-0.084, 0.45, -0.12], [0.02, 0.1, 0.055], P, { fixed: true });
    else M.sph([s * 0.084, 0.355, -0.12], [0.02, 0.195, 0.062], P, { fixed: true });
  }
  M.cone([0, 0.2, -0.09], 0.045, 0.09, 0.12, P, { fixed: true });
  M.sph([0, 0.262, -0.032], [0.086, 0.014, 0.034], P, { fixed: true });
  // the drain and the cake in it
  M.cyl([0, 0.262, -0.118], 0.02, 0.006, C.chrome, {
    paint: (u, v, face, lx, ly, lz) => (face === 2 && (Math.floor(lx * 220 + 20) + Math.floor(lz * 220 + 20)) % 2 === 0 ? [30, 30, 30] : null),
  });
  M.box([0.01, 0.272, -0.108], [0.046, 0.016, 0.032], X.pink, { bevel: 0.007, yaw: 0.35 });
  if (hurt) M.sph([-0.16, 0.02, 0.12], [0.02, 0.09, 0.05], P, { roll: 1.5, yaw: 0.6 });
}

/** Pedestal basin: two pillar taps, a bar of soap, the trap into the wall. */
function sink(M) {
  const P = C.porcelain, zw = -0.18;
  const wreck = M.wreck, hurt = M.hurt && !wreck;
  // the trap and the supplies, out of the wall
  M.cyl([0, 0.27, zw + 0.004], 0.022, 0.008, C.chrome, { axis: 'z' });
  M.rod([0, 0.27, zw], [0, 0.27, wreck ? -0.14 : -0.13], 0.011, C.chrome);
  for (const s of [-1, 1]) {
    M.rod([s * 0.075, 0.23, zw], [s * 0.075, 0.23, -0.15], 0.006, C.chrome);
    M.cyl([s * 0.075, 0.23, -0.15], 0.011, 0.02, C.chrome, { axis: 'z' });
    if (!wreck) M.rod([s * 0.075, 0.23, -0.15], [s * 0.075, 0.33, -0.15], 0.006, C.chrome);
  }
  if (wreck) {
    // the basin is off the wall and in pieces, the pedestal over on its side
    M.push([0.06, 0, 0.1], 0.4);
    M.cone([0, 0.05, 0], 0.058, 0.042, 0.33, P, { keep: true, roll: 1.52 });
    M.pop();
    M.push([-0.1, 0.04, 0.16], -0.4, 0.2, 0.4);
    M.slab(-0.12, -0.03, -0.1, 0.1, 0.03, 0.08, P, { keep: true, bevel: 0.02 });
    M.pop();
    for (const [x, z, a] of [[0.2, 0.25, 0.4], [-0.25, 0.0, 1.7], [0.02, 0.34, 2.6], [0.27, -0.05, 0.9], [-0.05, -0.08, 2.0]]) {
      M.box([x, 0.01, z], [0.06, 0.014, 0.04], P, { keep: true, yaw: a, roll: 0.2 });
    }
    M.box([0.14, 0.01, 0.34], [0.046, 0.018, 0.028], X.soap, { keep: true, bevel: 0.008, yaw: 1.0 });
    tap(M, -0.2, 0.25, X.tapRed, { keep: true, roll: 1.4, yaw: 0.6 });
    M.sph([0.02, 0.004, 0.16], [0.28, 0.005, 0.19], X.water, { keep: true });
    settle(M);
    return;
  }
  M.rod([0, 0.27, -0.13], [0, 0.33, -0.13], 0.011, C.chrome);
  // the pedestal, flared at the floor and under the basin
  M.cyl([0, 0.012, -0.095], 0.064, 0.024, P, { fixed: true });
  M.cone([0, 0.165, -0.095], 0.056, 0.04, 0.29, P, { fixed: true });
  M.cone([0, 0.315, -0.095], 0.04, 0.066, 0.04, P, { fixed: true });
  // the basin: its body, and a rim round the bowl
  const crack = hurt ? (u, v, face) => (face === 4 && crackAt(u, v, 0.32, 1) ? [70, 70, 70] : null) : null;
  M.slab(-0.14, 0.33, zw, 0.14, 0.372, 0.06, P, { bevel: 0.02, fixed: true, paint: crack });
  M.slab(-0.14, 0.368, zw, 0.14, 0.4, -0.1, P, { bevel: 0.012, fixed: true });
  M.slab(-0.14, 0.368, 0.032, 0.14, 0.4, 0.06, P, { bevel: 0.012, fixed: true, paint: crack });
  for (const s of [-1, 1]) M.slab(s * 0.14, 0.368, -0.1, s * 0.112, 0.4, 0.032, P, { bevel: 0.01, fixed: true });
  M.cyl([0, 0.374, -0.03], 0.013, 0.004, C.chrome, { paint: (u, v, face, lx, ly, lz) => (face === 2 && lx * lx + lz * lz < 0.006 * 0.006 ? [24, 24, 24] : null) });
  // pillar taps, hot on the left; a bar of soap between them
  if (!hurt) tap(M, -0.075, -0.14, X.tapRed);
  else M.cyl([-0.075, 0.405, -0.14], 0.008, 0.01, C.chrome);
  tap(M, 0.075, -0.14, X.tapBlue);
  M.box([0.0, 0.409, -0.14], [0.046, 0.018, 0.028], X.soap, { bevel: 0.008, yaw: 0.2 });
}

/** A pillar tap: a chrome column, a spout over the bowl, a cross-head with a coloured cap. */
function tap(M, x, z, cap, o) {
  if (o) M.push([x, 0.02, z], o.yaw || 0, 0, o.roll || 0);
  else M.push([x, 0.4, z]);
  const k = o ? { keep: true } : {};
  M.cyl([0, 0.02, 0], 0.012, 0.04, C.chrome, k);
  M.rod([0, 0.03, 0.006], [0, 0.026, 0.046], 0.0065, C.chrome, k);
  M.box([0, 0.046, 0], [0.042, 0.009, 0.01], C.chrome, { ...k, bevel: 0.003 });
  M.box([0, 0.046, 0], [0.01, 0.009, 0.042], C.chrome, { ...k, bevel: 0.003 });
  M.cyl([0, 0.054, 0], 0.009, 0.008, cap, k);
  M.pop();
}

// ------------------------------------------------------------------ the plant

/** The office rubber plant (0) or yucca (1), in a pot somebody uses as an ashtray. */
function plant(M) {
  const yucca = M.variant === 1;
  const pot = yucca ? X.potPlastic : C.terracotta;
  const R = srand(yucca ? 77 : 41);
  if (M.wreck) {
    // the pot on its side and broken, the plant pulled out across the floor
    M.push([0.14, 0, -0.04], 0.9);
    M.cone([0, 0.1, 0], 0.074, 0.098, 0.158, pot, { keep: true, roll: 1.5, paint: potBand(yucca) });
    M.pop();
    for (const [x, z, a] of [[-0.02, -0.16, 0.5], [0.26, 0.12, 2.0], [0.02, 0.2, 1.1]]) {
      M.box([x, 0.02, z], [0.06, 0.012, 0.05], pot, { keep: true, yaw: a, roll: 0.5 });
    }
    for (const [x, z, rx, rz] of [[0.02, 0.02, 0.14, 0.09], [-0.1, 0.1, 0.09, 0.07], [0.12, 0.1, 0.07, 0.05]]) {
      M.sph([x, 0.006, z], [rx, 0.012, rz], C.soil, { keep: true });
    }
    M.push([-0.04, 0.05, 0.05], -0.5, 0, 1.35);
    M.sph([0, -0.02, 0], [0.06, 0.05, 0.06], C.soil, { keep: true });
    if (yucca) yuccaTop(M, R, -0.19, true); else rubberTop(M, R, -0.19, true);
    M.pop();
    settle(M);
    return;
  }
  M.cyl([0, 0.008, 0], 0.09, 0.016, pot, { fixed: true });
  M.cone([0, 0.095, 0], 0.074, 0.098, 0.158, pot, { fixed: true, paint: potBand(yucca) });
  M.cyl([0, 0.176, 0], 0.106, 0.026, pot, {
    fixed: true,
    paint: (u, v, face, lx, ly, lz) => {
      if (face !== 2 || lx * lx + lz * lz > 0.094 * 0.094) return null;
      const k = 0.75 + 0.5 * vn3(lx * 140, lz * 140, 0, 3);
      return [58 * k, 42 * k, 30 * k, 0.1];
    },
  });
  // cigarette ends in the soil
  M.cyl([0.03, 0.192, 0.035], 0.006, 0.028, X.butt, { axis: 'x', yaw: 0.6 });
  M.cyl([-0.045, 0.192, 0.02], 0.006, 0.024, X.butt, { axis: 'x', yaw: -1.1 });
  if (yucca) yuccaTop(M, R, 0.19, M.hurt); else rubberTop(M, R, 0.19, M.hurt);
  if (M.hurt) M.sph([0.17, 0.006, 0.1], [0.06, 0.005, 0.028], yucca ? X.yuccaLeaf : X.rubberLeaf, { yaw: 0.8, paint: leafVeins });
}

const potBand = (plastic) => (plastic
  ? (u, v, face, lx, ly) => (ly > 0.05 && ly < 0.062 ? [120, 150, 110] : null)
  : null);

/** Lighter underside and a pale midrib on a leaf that runs along its local x. */
const leafVeins = (u, v, face, lx, ly, lz) => {
  if (Math.abs(lz) < 0.0035) return [150, 176, 112];
  if (ly < 0) return [104, 138, 84];
  return null;
};

/** A leaf on a stalk from `at`, pointing round by yaw and up by elev. */
function leaf(M, at, yaw, elev, len, wid, m, o = {}) {
  M.push(at, yaw, 0, elev);
  M.rod([0, 0, 0], [0.02, 0, 0], 0.004, X.stem, o);
  M.sph([0.018 + len, 0, 0], [len, 0.006, wid], m, { ...o, paint: leafVeins });
  M.pop();
}

function rubberTop(M, R, base, hurt) {
  M.rod([0, base - 0.01, 0], [0.012, 0.56, 0.008], 0.009, X.stem);
  M.rod([-0.03, base - 0.01, -0.028], [-0.034, 0.46, -0.032], 0.006, X.cane);
  M.sph([-0.018, 0.4, -0.016], [0.016, 0.007, 0.016], mat('plastic', [60, 110, 60]));
  const n = 12;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const len = 0.062 - t * 0.014 + R() * 0.01, a = i * 2.4 + 0.3, elev = -0.4 + t * 0.95;
    if (hurt && i % 4 === 1) continue;
    leaf(M, [0.012 * t, base + 0.05 + t * 0.32, 0.008 * t], a, elev, len, len * 0.46, X.rubberLeaf);
  }
  M.cone([0.013, 0.585, 0.009], 0.009, 0.002, 0.05, X.sheath);
}

function yuccaTop(M, R, base, hurt) {
  const canes = [[-0.032, 0.02, 0.36], [0.036, -0.018, 0.47], [0.004, 0.038, 0.27]];
  for (let c = 0; c < canes.length; c++) {
    const [x, z, top] = canes[c];
    M.cyl([x, (base + top) / 2, z], 0.017, top - base, X.bark, {
      paint: (u, v, face, lx, ly) => ((Math.floor(ly * 90) % 3) === 0 ? [96, 84, 64] : null),
    });
    M.sph([x, top, z], [0.02, 0.014, 0.02], X.yuccaLeaf);
    const n = 9;
    for (let i = 0; i < n; i++) {
      if (hurt && (i + c) % 3 === 0) continue;
      const a = i * 2.4 + c * 1.3, elev = 1.25 - (i % 4) * 0.5 + R() * 0.2, len = 0.068 + R() * 0.02;
      M.push([x, top, z], a, 0, elev);
      M.sph([len + 0.006, 0, 0], [len, 0.005, 0.012], X.yuccaLeaf, { paint: leafVeins });
      M.pop();
    }
  }
}

// ------------------------------------------------------------------ bins, buckets and cones

/** Crumpled paper: facets of light and dark on a paper ball. */
const crumple = (s) => (u, v, face, lx, ly, lz) => {
  const k = 0.78 + 0.26 * h3(Math.floor(lx * 70 + ly * 40), Math.floor(ly * 70 - lz * 30), Math.floor(lz * 70 + lx * 20), s);
  return [236 * k, 232 * k, 218 * k];
};

/** Round steel office bin, full of balled-up paper, a banana skin over the rim. */
function trash(M) {
  const B = X.binGreen;
  const side = (u, v, face, lx, ly, lz) => {
    const a = around(lx, lz);
    if (Math.abs(a) < 0.95 && inkAt('TRASH', (a + 0.95) / 1.9, (0.105 - ly) / 0.05)) return [226, 220, 196];
    if (Math.abs(ly - 0.03) < 0.004 || Math.abs(ly + 0.1) < 0.004) return [60, 72, 64];
    return null;
  };
  const mouth = (u, v, face, lx, ly, lz) => (face === 2 && lx * lx + lz * lz < 0.099 * 0.099 ? [26, 24, 22] : null);
  const balls = [[0.02, 0.37, 0.03, 0.036], [-0.045, 0.366, -0.02, 0.034], [0.05, 0.362, -0.04, 0.03], [-0.015, 0.386, -0.05, 0.03], [-0.035, 0.362, 0.055, 0.028]];
  if (M.wreck) {
    // over on its side, dented, the paper across the floor
    M.push([0.06, 0.105, -0.04], 0.5, 0, 1.52);
    M.cyl([0, -0.173, 0], 0.094, 0.014, C.darkMetal, { keep: true });
    M.cone([0, 0, 0], 0.09, 0.106, 0.34, B, { keep: true, paint: side });
    M.cyl([0, 0.174, 0], 0.112, 0.016, C.chrome, { keep: true, paint: mouth, roll: 0.12 });
    M.pop();
    const spill = [[-0.2, 0.12, 0.036], [-0.28, 0.05, 0.03], [-0.16, 0.26, 0.033], [-0.34, 0.2, 0.028], [-0.06, 0.3, 0.03]];
    spill.forEach(([x, z, r], i) => M.sph([x, r * 0.8, z], [r, r * 0.8, r], C.paper, { keep: true, paint: crumple(i) }));
    banana(M, [0.1, 0.02, 0.26], 0.5, true);
    settle(M);
    return;
  }
  M.cyl([0, 0.007, 0], 0.094, 0.014, C.darkMetal, { fixed: true });
  M.cone([0, 0.18, 0], 0.09, 0.106, 0.34, B, { fixed: true, paint: side });
  M.cyl([0, 0.354, 0], 0.112, 0.016, C.chrome, { fixed: true, paint: mouth, roll: M.hurt ? 0.1 : 0, pitch: M.hurt ? 0.05 : 0 });
  balls.forEach(([x, y, z, r], i) => {
    if (M.hurt && i === 2) M.sph([0.17, r * 0.8, 0.1], [r, r * 0.8, r], C.paper, { paint: crumple(i) });
    else M.sph([x, y, z], [r, r * 0.82, r], i === 4 ? C.manila : C.paper, { paint: crumple(i) });
  });
  if (M.hurt) banana(M, [-0.16, 0.02, 0.12], 2.2, true);
  else banana(M, [0.056, 0.364, 0.098], 0.52, false);
}

/** A banana skin: draped over a rim, or flat on the floor. */
function banana(M, at, yaw, flat) {
  const spots = (u, v, face, lx, ly, lz) => (vn3(lx * 160, ly * 160, lz * 160, 5) > 0.72 ? [110, 80, 30] : null);
  M.push(at, yaw);
  M.sph([0, 0.006, 0], [0.018, 0.01, 0.018], X.banana, { paint: spots, keep: true });
  if (flat) {
    for (const a of [0.3, 2.3, 4.3]) M.sph([Math.cos(a) * 0.04, 0.004, Math.sin(a) * 0.04], [0.04, 0.005, 0.012], X.banana, { yaw: -a, paint: spots, keep: true });
  } else {
    M.sph([0, -0.042, 0.014], [0.013, 0.045, 0.005], X.banana, { pitch: 0.18, paint: spots });
    M.sph([0.028, -0.02, 0.008], [0.012, 0.036, 0.005], X.banana, { roll: 0.8, pitch: 0.2, paint: spots });
    M.sph([-0.012, 0.0, -0.03], [0.012, 0.03, 0.005], X.banana, { roll: -0.5, pitch: -0.9, paint: spots });
  }
  M.pop();
}

/** A caster: a swivel fork and a rubber wheel. */
function caster(M, x, z, r, o = {}) {
  M.slab(x - 0.01, r, z - 0.011, x + 0.01, 2 * r + 0.008, z + 0.011, C.darkMetal, o);
  M.cyl([x, r, z], r, 0.013, C.rubber, { ...o, axis: 'x' });
}

/** The janitor's yellow bucket: casters, a wringer, the mop left standing in it. */
function mop(M) {
  const Y = X.yellow, wreck = M.wreck, hurt = M.hurt && !wreck;
  const wet = (u, v, face) => {
    if (face === 4 || face === 5) return inkAt('WET', (u - 0.16) / 0.68, (v - 0.22) / 0.56) ? [30, 28, 26] : null;
    if (face === 0 || face === 1) {
      // a warning triangle with its !
      const t = (v - 0.18) / 0.64, w = t * 0.36;
      if (t > 0 && t < 1 && Math.abs(u - 0.5) < w) {
        if (t > 0.86 || Math.abs(u - 0.5) > w - 0.06) return [30, 28, 26];
        if (Math.abs(u - 0.5) < 0.03 && (t > 0.3 && t < 0.62 || t > 0.68 && t < 0.78)) return [30, 28, 26];
      }
    }
    return null;
  };
  const water = (u, v, face) => (face === 2 && u > 0.05 && u < 0.95 && v > 0.07 && v < 0.93 ? [104, 96, 66, 2.4] : null);
  if (wreck) {
    M.sph([0.0, 0.004, 0.1], [0.32, 0.005, 0.2], X.dirty, { keep: true });
    M.push([0.02, 0.1, -0.06], 0.25, 0, -1.5);
    M.slab(-0.15, -0.08, -0.1, 0.13, 0.08, 0.1, Y, { bevel: 0.022, keep: true, paint: wet });
    M.slab(-0.156, 0.075, -0.106, 0.136, 0.097, 0.106, Y, { bevel: 0.008, keep: true });
    for (const [x, z] of [[-0.12, -0.075], [0.1, -0.075], [-0.12, 0.075]]) {
      M.cyl([x, -0.1, z], 0.018, 0.013, C.rubber, { keep: true, axis: 'x' });
    }
    M.pop();
    M.push([-0.26, 0.04, 0.18], 1.1, 0.3, 0.6);
    M.slab(-0.06, -0.04, -0.09, 0.06, 0.045, 0.08, X.greyPlastic, { bevel: 0.012, keep: true });
    M.pop();
    M.rod([-0.36, 0.012, 0.3], [0.3, 0.012, 0.3], 0.011, C.pine, { keep: true });
    M.sph([0.34, 0.02, 0.28], [0.07, 0.02, 0.06], X.mopHead, { keep: true });
    for (const a of [0.2, 0.9, -0.5]) M.box([0.34 + Math.cos(a) * 0.08, 0.008, 0.28 + Math.sin(a) * 0.08], [0.07, 0.008, 0.016], X.mopHead, { keep: true, yaw: -a });
    settle(M);
    return;
  }
  for (const [x, z] of [[-0.125, -0.075], [0.105, -0.075], [-0.125, 0.075], [0.105, 0.075]]) caster(M, x, z, 0.018);
  M.slab(-0.15, 0.044, -0.1, 0.13, 0.205, 0.1, Y, { bevel: 0.022, fixed: true, paint: wet });
  M.slab(-0.156, 0.198, -0.106, 0.136, 0.22, 0.106, Y, { bevel: 0.008, fixed: true, paint: water });
  for (const s of [-1, 1]) M.slab(-0.05, 0.16, s * 0.1, 0.03, 0.175, s * 0.112, Y, { bevel: 0.004 });   // moulded grips
  // the wringer on the right, its lever up behind it
  M.slab(0.012, 0.215, -0.092, 0.132, 0.292, 0.078, X.greyPlastic, { bevel: 0.012 });
  M.slab(0.03, 0.29, -0.07, 0.114, 0.298, 0.06, C.black);
  for (const s of [0.012, 0.132]) M.cyl([s, 0.268, -0.07], 0.012, 0.008, C.chrome, { axis: 'x' });
  M.rod([0.018, 0.27, -0.07], [0.028, 0.55, -0.13], 0.008, C.chrome);
  if (!hurt) {
    M.rod([0.126, 0.27, -0.07], [0.116, 0.55, -0.13], 0.008, C.chrome);
    M.cyl([0.072, 0.552, -0.13], 0.013, 0.104, C.black, { axis: 'x' });
  } else {
    M.rod([0.126, 0.27, -0.07], [0.15, 0.36, -0.02], 0.008, C.chrome);
    M.cyl([0.2, 0.013, 0.14], 0.013, 0.104, C.black, { axis: 'x', yaw: 0.7 });
  }
  // the mop: a grey head sulking in the water, strands over the side, the handle leaning out
  M.sph([-0.075, 0.224, 0.0], [0.066, 0.022, 0.062], X.mopHead);
  for (let k = 0; k < 4; k++) M.box([-0.16, 0.19, -0.045 + k * 0.03], [0.009, 0.07, 0.016], X.mopHead, { roll: -0.12 + k * 0.05 });
  const tip = hurt ? [0.12, 0.5, 0.2] : [-0.2, 0.585, -0.075];
  M.rod([-0.075, 0.24, 0], [-0.075 + (tip[0] + 0.075) * 0.1, 0.24 + (tip[1] - 0.24) * 0.1, tip[2] * 0.1], 0.016, C.chrome);
  M.rod([-0.075, 0.23, 0], tip, 0.011, C.pine);
  M.sph(tip, 0.013, C.colaRed);
  if (hurt) M.sph([0.2, 0.004, 0.16], [0.14, 0.005, 0.09], X.dirty);
}

/** Orange traffic cone on a square foot, two reflective collars. */
function cone(M) {
  const O = X.orange, wreck = M.wreck, hurt = M.hurt && !wreck;
  // height above the foot of a point on a cone piece whose centre is `yc` above it
  const bands = (yc) => (u, v, face, lx, ly, lz) => {
    if (face === 2) return [40, 18, 10];
    const y = yc + ly;
    if ((y > 0.19 && y < 0.235) || (y > 0.115 && y < 0.145)) return [238, 238, 232, 1.8];
    if (hurt && y < 0.1 && vn3(lx * 90, ly * 90, lz * 90, 3) > 0.7) return [40, 36, 34];
    return null;
  };
  if (wreck) {
    // knocked flat, the tip folded over
    M.push([0.0, 0.07, 0.0], 0.6, 0, 1.36);
    M.slab(-0.085, -0.16, -0.085, 0.085, -0.138, 0.085, O, { bevel: 0.01, keep: true });
    M.cone([0, -0.04, 0], 0.066, 0.034, 0.2, O, { keep: true, paint: bands(0.12) });
    M.push([0, 0.06, 0], 0, 0, 0.7);
    M.cone([0, 0.045, 0], 0.034, 0.012, 0.09, O, { keep: true, paint: bands(0.265) });
    M.pop();
    M.pop();
    settle(M);
    return;
  }
  M.slab(-0.085, 0, -0.085, 0.085, 0.022, 0.085, O, { bevel: 0.01, fixed: true, paint: hurt ? (u, v, face) => (face === 2 && Math.abs(u - v * 0.6 - 0.2) < 0.08 && ((u * 40 | 0) % 2) ? [40, 36, 34] : null) : null });
  M.cyl([0, 0.027, 0], 0.074, 0.01, O, { fixed: true });
  if (hurt) {
    M.cone([0, 0.116, 0], 0.066, 0.031, 0.18, O, { paint: bands(0.088) });
    M.push([0, 0.205, 0], 0, 0.15, 0.45);
    M.cone([0, 0.047, 0], 0.031, 0.012, 0.094, O, { paint: bands(0.225) });
    M.pop();
    return;
  }
  M.cone([0, 0.163, 0], 0.066, 0.012, 0.27, O, { paint: bands(0.135) });
}

// ------------------------------------------------------------------ the bookcase

const BOOKS = [[128, 36, 32], [38, 56, 98], [42, 86, 56], [176, 142, 66], [98, 40, 72], [62, 62, 66], [156, 98, 48],
  [200, 188, 152], [30, 30, 34], [110, 28, 28], [50, 92, 112], [214, 206, 180]];
const BINDERS = [[36, 38, 44], [40, 54, 96], [116, 34, 32], [44, 80, 54], [150, 150, 142], [196, 170, 60]];
const LABELS = 'ABCDEFGHIJKLMNOPRSTUVWXYZ0123456789';

/** One box that is several books or binders side by side, their spines painted on its front. */
function spines(sp, gw, gh, binders) {
  return (u, v, face) => {
    if (face === 1) return sp[0].c;
    if (face === 0) return sp[sp.length - 1].c;
    let s = sp[sp.length - 1];
    for (const q of sp) if (u < q.u1) { s = q; break; }
    const f = (u - s.u0) / (s.u1 - s.u0);
    if (face === 2) return binders || f < 0.14 || f > 0.86 || v > 0.93 ? s.c : [222, 212, 184];
    if (face !== 4) return s.c;
    if (f < 0.06 || f > 0.94) return shade(s.c, 0.4);
    if (binders) {
      if (v > 0.1 && v < 0.4 && f > 0.14 && f < 0.86) {
        return inkAt(s.label, (f - 0.26) / 0.48, (v - 0.15) / 0.2) ? [30, 30, 32] : [232, 228, 214];
      }
      const d = Math.hypot((f - 0.5) * (s.u1 - s.u0) * gw, (v - 0.76) * gh);
      if (d < 0.006) return [16, 16, 18];
      if (d < 0.0085) return [180, 180, 184];
      return null;
    }
    if (s.gilt && ((v > 0.07 && v < 0.1) || (v > 0.88 && v < 0.91))) return [206, 170, 84];
    if (s.title && v > 0.2 && v < 0.46 && f > 0.28 && f < 0.72) return s.gilt ? [206, 170, 84] : [230, 224, 206];
    return s.c;
  };
}

function fillRow(M, R, x0, x1, y, hMax, zf, binders, lab, o = {}) {
  let x = x0 + 0.003, flat = false, n = 0;
  while (x < x1 - 0.03) {
    const r = R();
    if (r < 0.12 && n > 0) { x += 0.02 + R() * 0.035; n++; continue; }
    if (r < 0.24 && !flat && x1 - x > 0.16) {
      flat = true;
      const w = binders ? 0.125 : 0.11 + R() * 0.03, k = binders ? 2 : 2 + (R() * 2 | 0);
      let yy = y;
      for (let i = 0; i < k; i++) {
        const t = binders ? 0.036 : 0.018 + R() * 0.012, c = binders ? BINDERS[(R() * 6) | 0] : BOOKS[(R() * 12) | 0];
        const dx = (R() - 0.5) * 0.012;
        M.slab(x + dx, yy, zf - (binders ? 0.12 : 0.09 + R() * 0.02), x + w + dx, yy + t, zf - 0.004, binders ? X.binder : X.book,
          { ...o, bevel: 0.003, paint: (u, v, face) => (face === 4 ? (v > 0.2 && v < 0.8 && Math.abs(u - 0.5) < 0.3 && !binders ? [222, 212, 184] : c) : c) });
        yy += t;
      }
      x += w + 0.008; n++;
      continue;
    }
    const k = binders ? 2 + (R() * 2 | 0) : 1 + (R() * 4 | 0);
    const sp = [];
    let w = 0;
    for (let i = 0; i < k; i++) {
      const sw = binders ? 0.036 + R() * 0.012 : 0.015 + R() * 0.016;
      if (x + w + sw > x1 - 0.003) break;
      sp.push({ u0: w, u1: w + sw, c: binders ? BINDERS[(R() * 6) | 0] : BOOKS[(R() * 12) | 0], gilt: R() < 0.4, title: R() < 0.6, label: LABELS[(lab.n++) % LABELS.length] });
      w += sw;
    }
    if (!sp.length) break;
    for (const s of sp) { s.u0 /= w; s.u1 /= w; }
    const hh = binders ? hMax - 0.012 : Math.min(hMax - 0.006, 0.085 + R() * 0.05);
    const dd = binders ? 0.124 : 0.095 + R() * 0.03, df = R() * 0.008;
    M.slab(x, y, zf - dd - df, x + w, y + hh, zf - df, binders ? X.binder : X.book, { ...o, bevel: 0.003, paint: spines(sp, w, hh, binders) });
    x += w; n++;
  }
  // the last one leans on its neighbour
  if (x1 - x > 0.045 && !binders) {
    const bw = 0.02, hh = Math.min(hMax - 0.01, 0.11), a = 0.32, c = BOOKS[(R() * 12) | 0];
    M.box([x + bw / 2 * Math.cos(a) + hh / 2 * Math.sin(a) + 0.002, y + hh / 2 * Math.cos(a) + bw / 2 * Math.sin(a), zf - 0.055],
      [bw, hh, 0.1], X.book, { ...o, bevel: 0.003, roll: a, paint: () => c });
  }
}

/** Tall shelving, wooden and full of books (0) or steel and full of labelled binders (1). */
function bookshelf(M) {
  const W = 0.22, D = 0.08, H = 0.86, bind = M.variant === 1;
  const wreck = M.wreck, hurt = M.hurt && !wreck;
  const body = bind ? C.steelGrey : C.oak;
  const fx = { bevel: 0.005, fixed: true };
  const slots = (u, v, face) => (face === 4 && Math.abs(u - 0.5) < 0.22 && (Math.floor(v * 70) % 3 === 0) ? [40, 42, 44] : null);
  M.slab(-W, 0, -D, -W + 0.02, H, D, body, bind ? { ...fx, paint: slots } : fx);
  M.slab(W - 0.02, 0, -D, W, H, D, body, bind ? { ...fx, paint: slots } : fx);
  M.slab(-W - 0.006, H - 0.022, -D - 0.004, W + 0.006, H, D + 0.006, body, fx);
  M.slab(-W + 0.02, 0.01, -D, W - 0.02, H - 0.022, -D + 0.01, bind ? C.darkMetal : C.darkwood, { fixed: true });
  M.slab(-W + 0.02, 0, D - 0.024, W - 0.02, 0.034, D - 0.01, body, { fixed: true });
  const ys = [0.05, 0.205, 0.36, 0.515, 0.67], top = H - 0.022;
  const R = srand(bind ? 991 : 313), lab = { n: 0 };
  const zf = D - 0.008;
  if (wreck) {
    // the shelves have come down at one end; what was on them is on the floor
    M.slab(-W + 0.02, 0.034, -D + 0.01, W - 0.02, 0.05, D - 0.004, body, { fixed: true });
    fillRow(M, R, -W + 0.02, W - 0.02, 0.05, ys[1] - 0.016 - 0.05, zf, bind, lab, { keep: true });
    for (let k = 1; k < 5; k++) {
      const left = k % 2 === 1, px = left ? -W + 0.02 : W - 0.02, a = (left ? -1 : 1) * 0.4;
      M.push([px, ys[k], 0], 0, 0, a);
      M.slab(left ? 0 : -0.4, -0.016, -D + 0.01, left ? 0.4 : 0, 0, D - 0.004, body, { keep: true, bevel: 0.004 });
      if (k < 4) M.slab(left ? 0.26 : -0.38, 0, -D + 0.02, left ? 0.38 : -0.26, bind ? 0.036 : 0.03, D - 0.01, bind ? X.binder : X.book,
        { keep: true, paint: () => (bind ? BINDERS : BOOKS)[k * 3 % 6] });
      M.pop();
    }
    const Q = srand(55);
    for (let i = 0; i < 13; i++) {
      const c = (bind ? BINDERS : BOOKS)[(Q() * (bind ? 6 : 12)) | 0];
      const len = bind ? 0.13 : 0.09 + Q() * 0.04, th = bind ? 0.04 : 0.018 + Q() * 0.016, wd = bind ? 0.12 : 0.08 + Q() * 0.03;
      const x = (Q() - 0.5) * 0.66, z = D + 0.06 + Q() * 0.26, open = !bind && i % 5 === 2;
      if (open) {
        // face down and open, like a tent
        M.push([x, 0.0, z], Q() * TAU);
        for (const s of [-1, 1]) M.box([s * len * 0.24, len * 0.12, 0], [len * 0.5, 0.008, wd], X.book, { keep: true, roll: -s * 0.45, paint: () => c });
        M.pop();
        continue;
      }
      M.box([x, th / 2 + (i % 4 === 3 ? 0.03 : 0), z], [len, th, wd], bind ? X.binder : X.book,
        { keep: true, yaw: Q() * TAU, roll: i % 4 === 3 ? 0.35 : 0, paint: (u, v, face) => (face === 2 || face === 3 ? c : face === 4 || face === 5 ? [222, 212, 184] : c) });
    }
    M.slab(-0.34, 0, -0.02, -0.16, 0.066, 0.1, X.card, { keep: true, bevel: 0.006, yaw: 0.7, roll: 0.2 });
    for (const [x, z, a] of [[0.26, 0.2, 0.3], [-0.16, 0.34, 1.2]]) M.slab(x - 0.05, 0, z - 0.035, x + 0.05, 0.004, z + 0.035, C.paper, { keep: true, yaw: a });
    settle(M);
    return;
  }
  for (let k = 0; k < 5; k++) {
    const y = ys[k], ceil = k < 4 ? ys[k + 1] - 0.016 : top;
    const sag = hurt && k === 2;
    if (sag) M.push([-W + 0.02, y, 0], 0, 0, -0.13);
    else M.push([-W + 0.02, y, 0]);
    M.slab(0, -0.016, -D + 0.01, 2 * W - 0.04, 0, D - 0.004, body, { bevel: 0.004 });
    fillRow(M, R, 0, 2 * W - 0.04, 0, ceil - y, zf, bind, lab);
    M.pop();
  }
  // an archive box on top
  M.push([-0.03, H, 0.0], 0.12);
  M.slab(-0.11, 0, -0.065, 0.09, 0.062, 0.065, X.card, {
    bevel: 0.005,
    paint: (u, v, face) => (face === 4 && inkAt('1962', (u - 0.25) / 0.5, (v - 0.3) / 0.4) ? [60, 40, 30] : null),
  });
  M.slab(-0.114, 0.056, -0.069, 0.094, 0.072, 0.069, X.card, { bevel: 0.004, paint: (u, v, face) => (face === 4 ? [150, 120, 80] : null) });
  M.pop();
  if (hurt) {
    M.box([0.1, 0.012, D + 0.12], [0.11, 0.024, 0.085], X.book, { yaw: 0.6, paint: () => BOOKS[0] });
    M.box([-0.08, 0.01, D + 0.16], [0.13, 0.02, 0.09], X.book, { yaw: -0.3, paint: () => BOOKS[3] });
  }
}

// ------------------------------------------------------------------ the copier

/** A big beige photocopier on its paper cabinet. Somebody has been copying their backside. */
function photocopier(M) {
  const wreck = M.wreck, hurt = M.hurt && !wreck;
  const B = X.copier;
  const toner = (lx, ly, lz) => wreck && vn3(lx * 16 + 3, ly * 16, lz * 16, 9) > 0.62;
  for (const [x, z] of [[-0.18, -0.115], [0.18, -0.115], [-0.18, 0.115], [0.18, 0.115]]) caster(M, x, z, 0.012, { fixed: true });
  M.slab(-0.2, 0.03, -0.135, 0.2, 0.22, 0.135, X.copierBrown, { bevel: 0.008, fixed: true });
  for (let k = 0; k < 2; k++) {
    const y0 = 0.042 + k * 0.088, out = wreck && k === 1 ? 0.12 : 0;
    M.slab(-0.19, y0, 0.126 + out, 0.19, y0 + 0.08, 0.142 + out, B, {
      bevel: 0.006,
      paint: (u, v, face) => (face === 4 && u > 0.08 && u < 0.16 && v > 0.3 && v < 0.7 ? (inkAt(k ? '1' : '2', (u - 0.1) / 0.05, (v - 0.35) / 0.3) ? [30, 30, 30] : [236, 234, 226]) : null),
    });
    M.slab(-0.05, y0 + 0.05, 0.142 + out, 0.05, y0 + 0.064, 0.152 + out, C.black, { bevel: 0.004 });
    if (out) {
      M.slab(-0.17, y0 + 0.01, 0.02 + out, 0.17, y0 + 0.07, 0.126 + out, B);
      M.slab(-0.15, y0 + 0.07, 0.03 + out, 0.15, y0 + 0.08, 0.12 + out, C.paper);
    }
  }
  // the machine
  M.slab(-0.21, 0.22, -0.14, 0.21, 0.46, 0.14, B, {
    bevel: 0.012, fixed: true,
    paint: (u, v, face, lx, ly, lz) => {
      if (toner(lx, ly, lz)) return [22, 22, 24, 0.3];
      if (face === 0 || face === 1) return u > 0.25 && u < 0.75 && v > 0.2 && v < 0.5 && (Math.floor(v * 60) % 2) ? [70, 66, 58] : null;
      if (face !== 4) return null;
      if (inkAt('KOPY', (u - 0.06) / 0.44, (v - 0.1) / 0.18)) return [120, 70, 40];
      if (v > 0.1 && v < 0.28 && u > 0.52 && u < 0.56) return [196, 120, 50];
      if (u > 0.74 && u < 0.92 && v > 0.1 && v < 0.2) return inkAt('0417', (u - 0.75) / 0.16, (v - 0.12) / 0.06) ? [230, 230, 220] : [24, 24, 26];
      if (v > 0.4 && v < 0.96 && u > 0.03 && u < 0.97 && (v < 0.415 || v > 0.945 || u < 0.045 || u > 0.955)) return [150, 142, 118];
      if (Math.hypot((u - 0.9) * 0.42, (v - 0.55) * 0.24) < 0.006) return [40, 40, 40];
      return null;
    },
  });
  // the lid over the glass: shut, propped open, or on the floor
  if (hurt) {
    M.slab(-0.19, 0.46, -0.125, 0.095, 0.463, 0.118, X.platen);
    M.slab(-0.19, 0.4625, 0.01, 0.095, 0.464, 0.02, mat('light', [180, 255, 190]));
    M.push([0, 0.462, -0.13], 0, -0.8, 0);
    M.slab(-0.2, 0, 0, 0.1, 0.03, 0.255, X.lid, { bevel: 0.008 });
    M.slab(-0.08, 0.008, 0.255, 0.02, 0.024, 0.27, C.black, { bevel: 0.004 });
    M.pop();
  } else if (!wreck) {
    M.slab(-0.2, 0.46, -0.13, 0.1, 0.49, 0.125, X.lid, { bevel: 0.008 });
    M.slab(-0.08, 0.466, 0.125, 0.02, 0.482, 0.14, C.black, { bevel: 0.004 });
  } else {
    M.slab(-0.19, 0.46, -0.125, 0.095, 0.463, 0.118, X.platen, { paint: (u, v, face) => (Math.hypot(u - 0.4, v - 0.5) < 0.18 ? [14, 14, 16] : null) });
    M.push([-0.14, 0.0, 0.26], 0.5, 0, 0.12);
    M.slab(-0.15, 0, -0.127, 0.15, 0.03, 0.127, X.lid, { bevel: 0.008, keep: true });
    M.pop();
  }
  // the control panel, sloped toward whoever is waiting
  M.push([0.158, 0.466, 0.035], 0, 0.22, 0);
  M.box([0, 0.012, 0], [0.095, 0.026, 0.19], X.panel, {
    bevel: 0.006,
    paint: (u, v, face) => {
      if (face !== 2) return null;
      if (wreck && Math.hypot((u - 0.45) * 0.095, (v - 0.55) * 0.19) < 0.035) return (Math.floor(u * 30) + Math.floor(v * 40)) % 3 ? [16, 16, 18] : [120, 110, 90];
      if (u > 0.12 && u < 0.62 && v > 0.42 && v < 0.92) {
        const a = (u - 0.12) / 0.5 * 3, b = (v - 0.42) / 0.5 * 4;
        return a % 1 > 0.2 && a % 1 < 0.85 && b % 1 > 0.2 && b % 1 < 0.8 ? [206, 204, 196] : null;
      }
      if (u > 0.7 && u < 0.9 && v > 0.42 && v < 0.54) return [200, 50, 40];
      return null;
    },
  });
  if (!wreck) {
    M.slab(-0.036, 0.024, -0.08, 0.02, 0.029, -0.045, X.lcd, {
      paint: (u, v) => (inkAt(hurt ? 'E4' : '01', (u - 0.2) / 0.6, (v - 0.2) / 0.6) ? [120, 255, 150] : [20, 50, 28]),
    });
    M.box([0.022, 0.027, 0.06], [0.03, 0.01, 0.028], X.startGreen, { bevel: 0.004 });
  }
  M.pop();
  // the bypass tray on the right with a ream on it
  M.push([0.21, 0.35, 0], 0, 0, 0.3);
  M.slab(0, -0.005, -0.1, 0.11, 0.004, 0.1, X.lid, { bevel: 0.003 });
  if (!wreck) M.slab(0.004, 0.004, -0.085, 0.092, 0.02, 0.085, C.paper);
  M.pop();
  // the output tray on the left, and the last copy on it
  M.push([-0.21, 0.29, 0], 0, 0, -0.26);
  M.slab(-0.13, -0.005, -0.11, 0, 0.004, 0.11, X.lid, { bevel: 0.003 });
  M.slab(-0.13, 0.004, -0.11, -0.118, 0.03, 0.11, X.lid);
  M.slab(-0.11, 0.004, -0.075, -0.012, 0.009, 0.072, C.paper, {
    yaw: 0.08,
    paint: (u, v, face) => {
      if (face !== 2) return null;
      for (const c of [0.34, 0.66]) {
        if (((u - c) / 0.2) ** 2 + ((v - 0.5) / 0.3) ** 2 < 1) return [70, 70, 74];
      }
      return null;
    },
  });
  M.pop();
  if (hurt) {
    // a paper jam out of its side, and a sign on it
    M.sph([-0.215, 0.4, 0.06], [0.02, 0.03, 0.035], C.paper, { paint: crumple(4) });
    M.slab(0.0, 0.33, 0.14, 0.17, 0.4, 0.144, C.paper, {
      roll: -0.06,
      paint: (u, v, face) => (face === 4 && inkAt('KAPUT', (u - 0.08) / 0.84, (v - 0.2) / 0.6) ? [30, 30, 34] : null),
    });
  }
  if (wreck) {
    for (const [x, z, a] of [[0.2, 0.25, 0.4], [0.06, 0.34, 1.3], [-0.3, 0.3, 2.2]]) M.slab(x - 0.05, 0, z - 0.035, x + 0.05, 0.004, z + 0.035, C.paper, { keep: true, yaw: a });
    M.sph([0.1, 0.004, 0.2], [0.14, 0.004, 0.08], X.toner, { keep: true, yaw: 0.3 });
    M.sph([0.24, 0.004, 0.1], [0.06, 0.004, 0.05], X.toner, { keep: true });
    settle(M);
  }
}

// ------------------------------------------------------------------ the coat stand

/** A bentwood coat stand with a trench coat and a fedora: somebody is still in the building. */
function coatrack(M) {
  const wreck = M.wreck, hurt = M.hurt && !wreck;
  if (wreck) {
    M.push([0.36, 0.03, -0.2], 2.5, 0, 1.5);
    stand(M, true);
    M.pop();
    // the coat in a heap, the hat rolled off
    M.sph([-0.1, 0.03, 0.14], [0.14, 0.035, 0.1], X.khaki, { keep: true, yaw: 0.4 });
    M.sph([-0.2, 0.025, 0.24], [0.1, 0.03, 0.07], X.khaki, { keep: true, yaw: -0.5 });
    M.sph([0.02, 0.02, 0.26], [0.03, 0.02, 0.14], X.khaki, { keep: true, yaw: 0.9 });
    M.box([-0.12, 0.06, 0.14], [0.2, 0.02, 0.05], X.khakiDark, { keep: true, yaw: 0.3, roll: 0.1 });
    hat(M, [0.22, 0.0, 0.26], 0.3, 0, 0);
    settle(M);
    return;
  }
  stand(M, false);
  // the coat on the front hook, slipped off one shoulder if it has been knocked
  M.push([0, 0.752, 0.078], 0, 0, hurt ? 0.22 : 0);
  coat(M);
  M.pop();
  if (hurt) hat(M, [0.2, 0, 0.16], 0.4, 0, 0);
  else hat(M, [0.1, 0.705, 0.058], -0.52, 0, -1.1);
}

function stand(M, keep) {
  const wd = X.bentwood, k = keep ? { keep: true } : {};
  M.cyl([0, 0.44, 0], 0.016, 0.76, wd, { ...k, fixed: true });
  M.sph([0, 0.84, 0], [0.024, 0.026, 0.024], wd, k);
  M.cyl([0, 0.806, 0], 0.022, 0.016, wd, k);
  M.cyl([0, 0.2, 0], 0.024, 0.04, wd, k);
  // four legs, bent out and down to the floor
  const P = [[0.02, 0.2], [0.07, 0.12], [0.125, 0.045], [0.175, 0.014]];
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + i * Math.PI / 2, dx = Math.sin(a), dz = Math.cos(a);
    const pt = (q) => [q[0] * dx, q[1], q[0] * dz];
    for (let j = 0; j < 3; j++) M.rod(pt(P[j]), pt(P[j + 1]), 0.01, wd, k);
    M.sph(pt(P[1]), 0.01, wd, k);
    M.sph(pt(P[2]), 0.01, wd, k);
    M.sph([P[3][0] * dx, 0.013, P[3][0] * dz], 0.013, C.rubber, k);
  }
  // six hooks at two heights
  for (let i = 0; i < 6; i++) {
    const a = i * TAU / 6, dx = Math.sin(a), dz = Math.cos(a), hy = i % 2 ? 0.74 : 0.77;
    M.rod([0.014 * dx, hy + 0.012, 0.014 * dz], [0.07 * dx, hy - 0.03, 0.07 * dz], 0.0075, wd, k);
    M.rod([0.07 * dx, hy - 0.03, 0.07 * dz], [0.1 * dx, hy + 0.004, 0.1 * dz], 0.0075, wd, k);
    M.sph([0.1 * dx, hy + 0.006, 0.1 * dz], 0.01, wd, k);
  }
}

/** A trench coat hanging by its collar from the local origin. */
function coat(M) {
  const K = X.khaki, KD = X.khakiDark;
  const front = (u, v, face) => {
    if (face !== 4) return null;
    if (Math.abs(u - 0.62) < 0.018) return [118, 98, 66];
    if (v < 0.36 && Math.abs(Math.abs(u - 0.5) - (0.36 - v) * 0.9) < 0.022) return [118, 98, 66];
    for (const bu of [0.4, 0.74]) for (const bv of [0.5, 0.7, 0.9]) if (Math.hypot((u - bu) * 0.17, (v - bv) * 0.26) < 0.007) return [50, 40, 30];
    return null;
  };
  const skirt = (u, v, face) => {
    if (face !== 4) return null;
    if (Math.abs(u - 0.62) < 0.016) return [118, 98, 66];
    if (Math.abs(v - 0.2 - (u < 0.5 ? u : 1 - u) * 0.3) < 0.02 && (u < 0.4 || u > 0.66) && (u > 0.12 && u < 0.88)) return [118, 98, 66];
    return null;
  };
  M.sph([0, -0.004, 0], [0.036, 0.026, 0.032], KD);
  M.sph([0, -0.05, 0], [0.1, 0.04, 0.042], K);
  for (const s of [-1, 1]) M.box([s * 0.06, -0.022, 0], [0.05, 0.012, 0.03], KD, { bevel: 0.004, roll: s * -0.35 });
  M.box([0, -0.19, 0], [0.17, 0.26, 0.058], K, { bevel: 0.022, paint: front });
  M.box([0, -0.41, 0.003], [0.19, 0.2, 0.054], K, { bevel: 0.02, paint: skirt });
  M.box([0, -0.29, 0], [0.178, 0.026, 0.066], KD, { bevel: 0.006 });
  M.box([0.02, -0.29, 0.034], [0.024, 0.02, 0.006], C.brass, { bevel: 0.003 });
  M.box([0.04, -0.34, 0.036], [0.02, 0.1, 0.008], KD, { roll: 0.12 });
  for (const s of [-1, 1]) {
    M.sph([s * 0.098, -0.2, -0.004], [0.03, 0.155, 0.036], K, { roll: s * 0.06 });
    M.box([s * 0.104, -0.33, -0.004], [0.05, 0.02, 0.06], KD, { roll: s * 0.06, bevel: 0.008 });
  }
}

/** A grey fedora: brim, pinched crown, black band. */
function hat(M, at, yaw, pitch, roll) {
  M.push(at, yaw, pitch, roll);
  M.cyl([0, 0.004, 0], 0.056, 0.008, X.felt, { keep: true });
  M.cyl([0, 0.028, 0], 0.036, 0.042, X.felt, { keep: true });
  M.sph([0, 0.05, 0], [0.036, 0.012, 0.03], X.felt, { keep: true });
  M.cyl([0, 0.014, 0], 0.037, 0.012, C.black, { keep: true });
  M.pop();
}

// ------------------------------------------------------------------ the extinguisher

/** Red fire extinguisher: gauge, lever, pin and seal, the hose clipped down its right side. */
function extinguisher(M) {
  const wreck = M.wreck, hurt = M.hurt && !wreck;
  if (wreck) {
    // down on its side and emptied across the floor
    M.push([0.02, 0.045, -0.04], 0.7, 0, -1.55);
    extBody(M, 'wreck');
    M.pop();
    const hose = [[0.19, 0.008, 0.09], [0.24, 0.008, 0.16], [0.2, 0.008, 0.24], [0.26, 0.008, 0.3]];
    for (let i = 0; i < 3; i++) M.rod(hose[i], hose[i + 1], 0.008, C.rubber, { keep: true });
    M.cone([0.28, 0.012, 0.32], 0.012, 0.008, 0.03, C.black, { keep: true, axis: 'z' });
    for (const [x, z, rx, rz, h] of [[0.1, 0.24, 0.16, 0.12, 0.02], [-0.12, 0.2, 0.12, 0.09, 0.016], [0.26, 0.36, 0.1, 0.07, 0.014], [-0.02, 0.36, 0.08, 0.06, 0.012]]) {
      M.sph([x, 0, z], [rx, h, rz], X.powder, { keep: true });
    }
    settle(M);
    return;
  }
  extBody(M, hurt ? 'hurt' : 'ok');
  if (hurt) {
    for (const [x, z, rx, rz] of [[0.14, 0.14, 0.09, 0.06], [0.2, 0.06, 0.05, 0.04]]) M.sph([x, 0, z], [rx, 0.012, rz], X.powder);
  }
}

function extBody(M, st) {
  const k = st === 'wreck' ? { keep: true } : {};
  const label = (u, v, face, lx, ly, lz) => {
    const a = around(lx, lz);
    if (Math.abs(a) > 0.95 || ly < -0.075 || ly > 0.05) return null;
    if (ly > 0.03) return [170, 22, 20];
    if (ly < -0.055) {
      const i = Math.floor((a + 0.95) / 0.63);
      return [[60, 150, 60], [200, 40, 40], [50, 80, 190]][Math.min(2, i)];
    }
    if (Math.floor((ly + 0.08) * 170) % 3 === 0 && Math.abs(a) < 0.8 && vn3(a * 6, ly * 170, 0, 2) > 0.3) return [60, 60, 60];
    return [236, 232, 220];
  };
  M.cyl([0, 0.009, 0], 0.045, 0.018, C.black, { ...k, fixed: true });
  M.cyl([0, 0.126, 0], 0.042, 0.228, X.red, { ...k, fixed: true, paint: label });
  M.sph([0, 0.24, 0], [0.042, 0.03, 0.042], X.red, k);
  M.cyl([0, 0.272, 0], 0.014, 0.014, C.brass, k);
  M.box([0, 0.285, 0], [0.028, 0.016, 0.03], C.chrome, { ...k, bevel: 0.004 });
  M.box([-0.036, 0.289, 0], [0.058, 0.008, 0.018], C.darkMetal, { ...k, bevel: 0.003 });
  M.box([-0.03, 0.304, 0], [0.056, 0.008, 0.018], C.chrome, { ...k, bevel: 0.003, roll: -0.22 });
  M.cyl([-0.004, 0.286, 0.019], 0.013, 0.008, C.chrome, {
    ...k, axis: 'z',
    paint: (u, v, face, lx, ly, lz) => (face !== 2 ? null : lx * lx + lz * lz > 0.0095 * 0.0095 ? null : lx > 0.002 && -lz > 0.002 ? [60, 170, 70] : [238, 238, 232]),
  });
  if (st === 'ok') {
    M.cyl([0.014, 0.3, 0.02], 0.009, 0.005, X.pinYellow, { axis: 'z' });
    M.box([0.02, 0.268, 0.026], [0.018, 0.028, 0.004], X.tag, { roll: 0.1, paint: (u, v) => (v > 0.2 && Math.floor(v * 10) % 2 ? [150, 140, 90] : null) });
  }
  if (st === 'wreck') return;
  // the hose, out of the valve and down the right side to the horn in its clip
  const hose = st === 'hurt'
    ? [[0.014, 0.284, 0], [0.05, 0.272, 0.01], [0.1, 0.2, 0.06], [0.12, 0.1, 0.1], [0.11, 0.012, 0.15]]
    : [[0.014, 0.284, 0], [0.044, 0.272, 0.004], [0.056, 0.23, 0.008], [0.056, 0.1, 0.012]];
  for (let i = 0; i < hose.length - 1; i++) {
    M.rod(hose[i], hose[i + 1], 0.0075, C.rubber);
    if (i > 0) M.sph(hose[i], 0.0075, C.rubber);
  }
  const e = hose[hose.length - 1];
  if (st === 'hurt') M.cone([e[0], e[1], e[2] + 0.015], 0.008, 0.012, 0.03, C.black, { axis: 'z' });
  else {
    M.cone([e[0], e[1] - 0.015, e[2]], 0.012, 0.008, 0.03, C.black);
    M.box([0.043, 0.09, 0.006], [0.02, 0.012, 0.03], C.chrome, { bevel: 0.003 });
  }
}

// ------------------------------------------------------------------ the AV cart

/** A wood-grain CRT television on an AV cart, a VCR under it blinking 12:00. */
function tvcart(M) {
  const wreck = M.wreck, hurt = M.hurt && !wreck;
  const W = 0.18, D = 0.13, T = 0.27, cm = X.cart;
  // the cart: casters, four posts, two shelves with lips; a wreck lost a wheel and leans on that corner
  if (wreck) M.push([0, 0.0, 0], 0, 0.04, -0.06);
  for (const [x, z] of [[-0.16, -0.11], [0.16, -0.11], [-0.16, 0.11], [0.16, 0.11]]) {
    if (wreck && x > 0 && z > 0) continue;
    caster(M, x, z, 0.018, wreck ? { fixed: true } : {});
  }
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    M.slab(x * W - (x > 0 ? 0.018 : 0), 0.044, z * D - (z > 0 ? 0.018 : 0), x * W + (x < 0 ? 0.018 : 0), T, z * D + (z < 0 ? 0.018 : 0), cm, { bevel: 0.003, fixed: true });
  }
  for (const y of [0.07, T - 0.016]) {
    M.slab(-W, y, -D, W, y + 0.016, D, cm, { bevel: 0.004, fixed: true });
    M.slab(-W, y + 0.016, D - 0.008, W, y + 0.028, D, cm, { bevel: 0.003, fixed: true });
  }
  // power strip on the right post, its cord coiled
  M.slab(W, 0.14, 0.02, W + 0.016, 0.24, 0.055, C.cream, { bevel: 0.004, paint: (u, v, face) => (face === 0 && Math.floor(v * 4) % 2 && u > 0.3 && u < 0.7 ? [30, 30, 30] : null) });
  M.cyl([W + 0.01, 0.1, -0.05], 0.03, 0.014, C.black, { axis: 'x' });
  if (wreck) M.pop();
  // VCR on the lower shelf, two tapes on it
  const vy = 0.086;
  M.slab(-0.15, vy, -0.09, 0.15, vy + 0.055, 0.1, X.vcr, {
    bevel: 0.006, keep: wreck,
    paint: (u, v, face) => {
      if (face !== 4) return null;
      if (u > 0.06 && u < 0.5 && v > 0.3 && v < 0.52) return [14, 14, 16];
      if (u > 0.55 && u < 0.95 && v > 0.7 && v < 0.82 && (Math.floor(u * 40) % 3)) return [170, 170, 166];
      if (v > 0.9) return [150, 150, 150];
      return null;
    },
  });
  M.slab(0.06, vy + 0.024, 0.1, 0.13, vy + 0.04, 0.104, X.lcd, { paint: (u, v) => (inkAt('12:00', u, (v - 0.1) / 0.8) ? [120, 255, 150] : [16, 34, 20]) });
  if (hurt) M.slab(-0.12, vy + 0.02, 0.06, 0.0, vy + 0.042, 0.16, X.tape, { paint: (u, v, face) => (face === 2 && u > 0.1 && u < 0.9 && v > 0.7 ? [230, 226, 210] : null) });
  if (!wreck) {
    M.slab(-0.13, vy + 0.055, -0.07, -0.03, vy + 0.075, 0.05, X.tape, { yaw: 0.1, paint: (u, v, face) => (face === 4 && u > 0.1 && u < 0.9 ? [230, 226, 210] : null) });
    M.slab(-0.12, vy + 0.075, -0.06, -0.02, vy + 0.095, 0.06, X.tape, { yaw: -0.15, paint: (u, v, face) => (face === 4 && u > 0.1 && u < 0.9 ? [206, 60, 50] : null) });
  }
  // cable from the set down to the VCR
  if (!wreck) M.rod([0.12, 0.33, -0.12], [0.13, 0.12, -0.1], 0.005, C.black);
  if (wreck) {
    // the set is on the floor on its face, the tape unspooled
    M.push([0.0, 0.0, 0.3], 0.35, 1.25, 0.1);
    tv(M, 0, 'wreck');
    M.pop();
    for (let i = 0; i < 4; i++) M.box([-0.1 + i * 0.07, 0.004, 0.2 + (i % 2) * 0.05], [0.18, 0.004, 0.016], X.ribbon, { keep: true, yaw: 0.6 + i * 0.9 });
    M.slab(-0.34, 0.0, 0.14, -0.24, 0.02, 0.2, X.tape, { keep: true, yaw: 0.4 });
    settle(M);
    return;
  }
  tv(M, T, hurt ? 'hurt' : 'ok');
}

function tv(M, ty, st) {
  const k = st === 'wreck' ? { keep: true } : {};
  const pic = M.variant === 1 ? testCard : mushroom;
  const screen = (u, v, face) => {
    if (face !== 4) return null;
    if (st === 'wreck') return Math.hypot(u - 0.45, v - 0.5) < 0.3 ? [8, 8, 10] : [40, 50, 56];
    if (st === 'hurt') {
      const n = h3(Math.floor(u * 60), Math.floor(v * 50), 0, 7) * 200;
      if (Math.abs(v - 0.3 - u * 0.5) < 0.02 || Math.abs(v - 0.9 + u * 0.7) < 0.015) return [230, 230, 230];
      return [n, n, n];
    }
    const c = pic(u, v), s = Math.floor(v * 36) % 2 ? 0.78 : 1;
    return [c[0] * s, c[1] * s, c[2] * s];
  };
  M.slab(-0.155, ty, -0.09, 0.155, ty + 0.225, 0.115, X.tvWood, { ...k, bevel: 0.012, fixed: true });
  M.slab(-0.11, ty + 0.025, -0.13, 0.11, ty + 0.2, -0.09, X.tvBack, { ...k, bevel: 0.02 });
  M.slab(-0.142, ty + 0.014, 0.112, 0.142, ty + 0.211, 0.12, X.bezel, { ...k, bevel: 0.005 });
  M.slab(-0.13, ty + 0.034, 0.116, 0.062, ty + 0.19, 0.126, X.tvScreen, { ...k, bevel: 0.016, paint: screen });
  M.cyl([0.1, ty + 0.162, 0.124], 0.02, 0.014, X.knob, {
    ...k, axis: 'z',
    paint: (u, v, face, lx, ly, lz) => (face === 2 && Math.abs(lx) < 0.003 && lz < 0 ? [30, 30, 30] : null),
  });
  M.cyl([0.1, ty + 0.112, 0.123], 0.012, 0.012, X.knob, { ...k, axis: 'z' });
  M.slab(0.074, ty + 0.03, 0.12, 0.128, ty + 0.086, 0.123, X.bezel, { ...k, paint: (u, v) => (Math.floor(v * 16) % 2 ? [20, 20, 20] : [70, 66, 60]) });
  M.slab(-0.06, ty + 0.018, 0.12, -0.0, ty + 0.028, 0.123, C.chrome, k);
  // rabbit ears
  M.sph([0.04, ty + 0.234, -0.02], [0.03, 0.012, 0.024], C.black, k);
  const L = st === 'hurt' ? [0.2, ty + 0.2, 0.06] : [-0.06, 0.62, -0.06];
  M.rod([0.035, ty + 0.238, -0.02], L, 0.0045, C.chrome, k);
  M.rod([0.045, ty + 0.238, -0.02], [0.14, 0.61, -0.05], 0.0045, C.chrome, k);
  M.sph(L, 0.006, C.chrome, k);
  M.sph([0.14, 0.61, -0.05], 0.006, C.chrome, k);
}

/** Tonight's programme: a mushroom cloud over the desert. */
const mushroom = (u, v) => {
  const dx = u - 0.5;
  const cap = (dx / 0.26) ** 2 + ((v - 0.3) / 0.15) ** 2;
  if (cap < 1) return cap < 0.35 ? [250, 226, 170] : [206, 160, 110];
  if (v > 0.38 && v < 0.8 && Math.abs(dx) < 0.05 + (v - 0.38) * 0.08) return [190, 150, 110];
  if (v > 0.78) return Math.abs(dx) < 0.3 - (v - 0.78) ? [150, 110, 80] : [70, 60, 50];
  return [60, 70, 96];
};
/** Or the test card at the end of the night. */
const testCard = (u, v) => {
  if (v < 0.66) return [[230, 230, 230], [220, 210, 60], [60, 200, 210], [60, 190, 70], [200, 60, 190], [200, 50, 50], [50, 60, 200]][Math.min(6, Math.floor(u * 7))];
  return u < 0.3 ? [30, 40, 90] : u < 0.5 ? [236, 236, 236] : [20, 20, 24];
};

// ------------------------------------------------------------------ the canteen

/** Canteen table: steel legs, mint formica in a ribbed chrome edge, and what lunch left behind. */
function table(M) {
  const W = 0.4, D = 0.21, H = 0.362, v = M.variant;
  const wreck = M.wreck, hurt = M.hurt && !wreck;
  const fleck = (u, vv, face, lx, ly, lz) => (face === 2 && h3(Math.floor(lx * 300), Math.floor(lz * 300), 0, 4) < 0.06 ? [120, 140, 128] : null);
  const legs = (sx) => {
    for (const sz of [-1, 1]) {
      M.cyl([sx * 0.36, 0.18, sz * 0.17], 0.012, 0.32, C.chrome, { fixed: true });
      M.cyl([sx * 0.36, 0.01, sz * 0.17], 0.016, 0.02, C.rubber, { fixed: true });
    }
    M.rod([sx * 0.36, 0.08, -0.17], [sx * 0.36, 0.08, 0.17], 0.008, C.chrome, { fixed: true });
  };
  if (wreck) {
    // snapped down the middle, both halves sagging onto the floor between the legs
    for (const s of [-1, 1]) {
      legs(s);
      M.push([s * 0.4, 0.34, 0], 0, 0, s * 0.5);
      M.slab(s > 0 ? -0.4 : 0, 0, -D, s > 0 ? 0 : 0.4, 0.02, D, X.formica, { keep: true, bevel: 0.006, paint: fleck });
      M.slab(s > 0 ? -0.4 : 0, -0.024, -D - 0.004, s > 0 ? 0 : 0.4, 0, D + 0.004, C.chrome, { keep: true });
      M.pop();
    }
    // lunch on the floor: a tray face down, ketchup everywhere, a mug on its side, the paper
    M.box([0.1, 0.006, 0.32], [0.24, 0.012, 0.17], X.tray, { keep: true, yaw: 0.5, bevel: 0.004 });
    M.sph([-0.14, 0.003, 0.3], [0.1, 0.004, 0.06], X.splat, { keep: true, yaw: 0.4 });
    M.sph([-0.25, 0.003, 0.26], [0.04, 0.004, 0.03], X.splat, { keep: true });
    M.cyl([-0.2, 0.02, 0.36], 0.02, 0.08, X.ketchup, { keep: true, axis: 'x', yaw: 0.9 });
    M.cyl([0.28, 0.022, 0.24], 0.022, 0.05, C.mug, { keep: true, axis: 'z', yaw: -0.6 });
    M.sph([0.34, 0.003, 0.3], [0.07, 0.004, 0.05], C.coffee, { keep: true });
    M.slab(-0.06, 0, 0.36, 0.12, 0.006, 0.43, C.paper, { keep: true, yaw: -0.2, paint: news });
    M.sph([0.0, 0.03, 0.26], [0.035, 0.022, 0.03], X.mash, { keep: true });
    M.box([-0.3, 0.018, 0.16], [0.035, 0.035, 0.035], X.jello, { keep: true, bevel: 0.008, yaw: 0.6 });
    settle(M);
    return;
  }
  legs(-1);
  legs(1);
  M.slab(-0.37, 0.315, -0.18, 0.37, 0.338, 0.18, C.darkMetal, { fixed: true });
  M.slab(-W - 0.004, 0.336, -D - 0.004, W + 0.004, H - 0.002, D + 0.004, C.chrome, {
    fixed: true, paint: (u, vv, face) => (face !== 2 && face !== 3 && Math.floor(vv * 5) % 2 ? [120, 124, 130] : null),
  });
  M.slab(-W, 0.345, -D, W, H, D, X.formica, { bevel: 0.004, fixed: true, paint: fleck });
  if (v === 0) {
    tray(M, -0.2, 0.02, 0.12, X.tray, hurt);
    tray(M, 0.14, -0.06, -0.2, X.trayGrey, false);
    ketchup(M, 0.33, -0.12);
    mug(M, hurt ? null : [0.33, 0.1], hurt);
    M.slab(-0.02, H, 0.06, 0.16, H + 0.008, 0.19, C.paper, { yaw: 0.35, paint: news });
  } else if (v === 1) {
    // cards: chips, cans, the pot, a hand face down
    const stacks = [[-0.22, -0.1, X.chipR, 5], [-0.18, -0.12, X.chipB, 3], [-0.2, -0.06, X.chipW, 7], [0.24, 0.1, X.chipR, 2], [0.2, 0.12, X.chipW, 4], [0.03, -0.02, X.chipB, 6]];
    for (const [x, z, m, n] of stacks) M.cyl([x, H + n * 0.0045, z], 0.016, n * 0.009, m, { paint: (u, vv, face, lx, ly) => (face !== 2 && Math.floor((ly + 0.1) * 222) % 2 ? [236, 236, 230] : null) });
    for (const [x, z, a] of [[0.0, 0.08, 0.3], [0.03, 0.09, -0.2], [-0.03, 0.1, 0.8], [0.08, -0.1, 1.2]]) {
      M.slab(x - 0.018, H, z - 0.026, x + 0.018, H + 0.008, z + 0.026, C.paper, { yaw: a, paint: (u, vv, face) => (face === 2 && u > 0.1 && u < 0.9 && vv > 0.08 && vv < 0.92 ? [170, 40, 40] : null) });
    }
    for (const [x, z, c] of [[-0.32, 0.12, [200, 40, 40]], [0.32, -0.1, [40, 90, 200]], [0.34, -0.03, [200, 40, 40]]]) {
      M.cyl([x, H + 0.032, z], 0.02, 0.064, X.can, { paint: (u, vv, face, lx, ly) => (face === 2 ? null : Math.abs(ly) < 0.018 ? c : null) });
    }
    M.slab(0.1, H, 0.02, 0.2, H + 0.012, 0.07, X.cash, { yaw: 0.3 });
    ashtray(M, -0.1, 0.12);
  } else {
    // coffee break: a flask, the mugs, a box of doughnuts
    M.cyl([-0.3, H + 0.07, -0.1], 0.03, 0.14, X.flask);
    M.cyl([-0.3, H + 0.15, -0.1], 0.032, 0.03, C.black);
    mug(M, [-0.2, 0.1], false);
    mug(M, [0.02, -0.12], false);
    M.slab(0.06, H, -0.04, 0.26, H + 0.05, 0.12, X.pinkBox, { yaw: -0.15, bevel: 0.003, paint: (u, vv, face) => (face === 2 && u > 0.04 && u < 0.96 && vv > 0.04 && vv < 0.96 ? [240, 230, 214] : null) });
    M.push([0.16, H + 0.05, -0.04], -0.15, -1.1, 0);
    M.slab(-0.1, 0, -0.16, 0.1, 0.006, 0, X.pinkBox, { paint: (u, vv, face) => (face === 3 && inkAt('DONUTS', (u - 0.1) / 0.8, (vv - 0.35) / 0.3) ? [200, 40, 90] : null) });
    M.pop();
    for (const [x, z, ic] of [[0.11, 0.02, [236, 140, 170]], [0.19, 0.05, [90, 50, 30]], [0.13, 0.08, [236, 236, 226]]]) {
      M.sph([x, H + 0.064, z], [0.03, 0.014, 0.03], X.donut, {
        paint: (u, vv, face, lx, ly, lz) => {
          const r = Math.hypot(lx, lz);
          if (r < 0.009) return [60, 40, 20];
          return ly > 0.004 ? ic : null;
        },
      });
    }
    M.slab(-0.16, H, -0.02, 0.0, H + 0.008, 0.12, C.paper, { yaw: -0.3, paint: news });
  }
  if (hurt) M.sph([0.3, H + 0.002, 0.1], [0.07, 0.003, 0.05], C.coffee, { yaw: 0.3 });
}

/** A canteen tray: mash, mystery meat, peas, a red jelly, the spork. */
function tray(M, x, z, yaw, m, askew) {
  const H = 0.362;
  if (askew) M.push([x - 0.05, H + 0.012, z + 0.1], yaw + 0.5, 0.0, -0.08);
  else M.push([x, H, z], yaw);
  M.slab(-0.12, 0, -0.085, 0.12, 0.012, 0.085, m, {
    bevel: 0.004,
    paint: (u, v, face) => (face === 2 && (Math.abs(u - 0.55) < 0.012 || (u < 0.55 && Math.abs(v - 0.5) < 0.014)) ? shade(m.c, 0.72) : null),
  });
  M.sph([-0.06, 0.014, -0.035], [0.034, 0.024, 0.03], X.mash);
  M.sph([-0.06, 0.036, -0.035], [0.012, 0.004, 0.01], mat('plastic', [230, 200, 90], { gloss: 0.8 }));
  M.box([0.06, 0.022, -0.02], [0.07, 0.018, 0.06], X.meat, { bevel: 0.008, yaw: 0.2 });
  M.sph([-0.06, 0.016, 0.042], [0.04, 0.008, 0.026], X.peas, {
    paint: (u, v, face, lx, ly, lz) => (((Math.floor(lx * 180) + Math.floor(lz * 180)) & 1) ? [70, 118, 36] : null),
  });
  M.box([0.07, 0.03, 0.052], [0.034, 0.034, 0.034], X.jello, { bevel: 0.008 });
  M.slab(-0.02, 0.012, 0.03, 0.0, 0.02, 0.08, C.chrome, { yaw: 0.5 });
  M.pop();
}

function ketchup(M, x, z) {
  const H = 0.362;
  M.cyl([x, H + 0.04, z], 0.019, 0.08, X.ketchup, { paint: (u, v, face, lx, ly, lz) => (face !== 2 && Math.abs(ly) < 0.015 && Math.abs(around(lx, lz)) < 1.2 ? [236, 230, 210] : null) });
  M.cone([x, H + 0.09, z], 0.019, 0.007, 0.02, X.ketchup);
  M.cone([x, H + 0.107, z], 0.004, 0.0015, 0.016, C.cream);
}

function mug(M, at, spilt) {
  const H = 0.362;
  if (spilt) {
    M.cyl([0.3, H + 0.022, 0.06], 0.022, 0.05, C.mug, { axis: 'z', yaw: 0.8 });
    return;
  }
  M.cyl([at[0], H + 0.027, at[1]], 0.022, 0.054, C.mug);
  M.cyl([at[0], H + 0.052, at[1]], 0.019, 0.004, C.coffee);
  M.box([at[0] + 0.026, H + 0.028, at[1]], [0.014, 0.03, 0.008], C.mug, { bevel: 0.004 });
}

function ashtray(M, x, z) {
  const H = 0.362;
  M.cyl([x, H + 0.008, z], 0.032, 0.016, C.glass, { paint: (u, v, face, lx, ly, lz) => (face === 2 && lx * lx + lz * lz < 0.024 * 0.024 ? [70, 66, 62] : null) });
  for (const a of [0.4, 1.9, 3.6]) M.cyl([x + Math.cos(a) * 0.015, H + 0.02, z + Math.sin(a) * 0.015], 0.006, 0.028, X.butt, { axis: 'x', yaw: -a });
}

/** The Evening Standard of the bunker. */
const news = (u, v, face) => {
  if (face !== 2) return null;
  if (v < 0.1) return [30, 30, 30];
  if (v > 0.14 && v < 0.4) return inkAt('REDS!', (u - 0.08) / 0.84, (v - 0.14) / 0.26) ? [30, 30, 30] : null;
  if (v > 0.46 && u > 0.55 && u < 0.92 && v < 0.8) return [120, 120, 116];
  if (v > 0.46 && Math.floor(v * 40) % 2 === 0 && (Math.floor(u * 3) !== Math.floor((u + 0.03) * 3))) return null;
  if (v > 0.46 && Math.floor(v * 40) % 2 === 0) return [150, 148, 140];
  return null;
};

// ------------------------------------------------------------------ the table

export const MODELS_OFFICE = {
  toilet: { build: toilet, front: 0.13, variants: 2 },
  urinal: { build: urinal, front: 0.01 },
  sink: { build: sink, front: 0.06 },
  plant: { build: plant, front: 0.1, variants: 2 },
  trash: { build: trash, front: 0.11, dirs: 1 },
  mop: { build: mop, front: 0.1 },
  cone: { build: cone, front: 0.085 },
  bookshelf: { build: bookshelf, front: 0.085, variants: 2 },
  photocopier: { build: photocopier, front: 0.14 },
  coatrack: { build: coatrack, front: 0.12 },
  extinguisher: { build: extinguisher, front: 0.045 },
  tvcart: { build: tvcart, front: 0.13, variants: 2 },
  table: { build: table, front: 0.21, variants: 3 },
};
