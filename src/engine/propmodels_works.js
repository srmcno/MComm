// propmodels_works.js - the control room, the chapel, the workshop, the stores
// and the meat locker. See propmodels.js for how a model is written.
//
// Props that stand against a wall keep their backs toward -z inside the cell;
// the rest are centred on their footprint.

import { C, TAU, mat, inkAt, terminal, stencil } from './propkit.js';

// ------------------------------------------------------------------ helpers

function hh(x, y, s) {
  let h = (Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 1274126177)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
/** Smooth 2-D value noise, for stains and blotches painted on a face. */
function vn(x, y, s) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hh(ix, iy, s), b = hh(ix + 1, iy, s), c = hh(ix, iy + 1, s), d = hh(ix + 1, iy + 1, s);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
function fb(x, y, s) { return vn(x, y, s) * 0.6 + vn(x * 2.1, y * 2.1, s + 9) * 0.3 + vn(x * 4.3, y * 4.3, s + 17) * 0.1; }
/** A little seeded generator, so a pile is stacked the same whole or broken. */
function srand(seed) {
  let s = seed >>> 0 || 1;
  return () => { s = (Math.imul(s ^ (s >>> 15), 2246822519) + 0x9e3779b9) >>> 0; return s / 4294967296; };
}
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
/** Text in a box (u0..u1, v0..v1) of a face: true on the ink. */
const txt = (s, u, v, u0, v0, u1, v1) => inkAt(s, (u - u0) / (u1 - u0), (v - v0) / (v1 - v0));
/** Round the side of an upright cylinder: u 0..1 across angles a0..a1 (0 is its front), v down from y1 to y0. */
function wrapUV(lx, ly, lz, a0, a1, y0, y1) { return [(Math.atan2(lx, lz) - a0) / (a1 - a0), (y1 - ly) / (y1 - y0)]; }
/** Yellow and black hazard stripes. */
const hazard = (u, v, n = 8) => (Math.floor((u + v) * n) & 1 ? [30, 28, 24] : [226, 184, 40]);

// ------------------------------------------------------------------ materials

const K = {
  console: mat('paint', [126, 134, 118], { wear: 0.45 }),
  panel: mat('paint', [50, 54, 56], { wear: 0.25 }),
  bakelite: mat('plastic', [30, 28, 28], { gloss: 0.55 }),
  redPhone: mat('plastic', [176, 26, 22], { gloss: 0.6 }),
  btnRed: mat('plastic', [200, 36, 30], { gloss: 0.5 }),
  btnGreen: mat('plastic', [50, 160, 70], { gloss: 0.5 }),
  btnAmber: mat('plastic', [230, 160, 40], { gloss: 0.5 }),
  btnWhite: mat('plastic', [224, 222, 210], { gloss: 0.5 }),
  btnBlue: mat('plastic', [50, 90, 180], { gloss: 0.5 }),
  scope: mat('screen', [30, 120, 70]),
  gaugeFace: mat('paint', [226, 220, 196], { wear: 0, gloss: 0.5 }),
  cabinet: mat('paint', [34, 30, 38], { wear: 0.35 }),
  wire: [mat('rubber', [190, 40, 30]), mat('rubber', [220, 190, 40]), mat('rubber', [40, 90, 190]), mat('rubber', [40, 140, 60]), mat('rubber', [30, 30, 32])],
  pewWood: mat('wood', [112, 66, 36], { grain: 1.1 }),
  pewDark: mat('wood', [78, 44, 24]),
  hymnRed: mat('leather', [110, 26, 24]),
  hymnBlack: mat('leather', [34, 30, 30]),
  bag: mat('burlap', [170, 144, 100]),
  bag2: mat('burlap', [150, 128, 88]),
  bag3: mat('burlap', [182, 160, 116]),
  sand: mat('fabric', [176, 150, 104]),
  string: mat('fabric', [120, 100, 70]),
};

// ------------------------------------------------------------------ control room

/** Launch console: sloped desk of toggles and buttons, scopes and a big gauge under a hood, a phone. */
function consoleM(M) {
  const W = 0.8, D = 0.4, alarm = M.variant === 1, wreck = M.wreck;
  const body = K.console;
  M.slab(-W / 2 + 0.012, 0, -D / 2 + 0.01, W / 2 - 0.012, 0.03, D / 2 - 0.02, C.darkMetal, { fixed: true });
  M.slab(-W / 2, 0.03, -D / 2, W / 2, 0.3, D / 2, body, {
    bevel: 0.008, fixed: true,
    paint: (u, v, f) => {
      if (f === 0 || f === 1) {
        if (u > 0.2 && u < 0.8 && v > 0.55 && v < 0.85 && Math.floor(v * 60) % 2 === 0) return [24, 26, 26];
        return txt('USAF', u, v, 0.3, 0.2, 0.7, 0.4) ? [232, 230, 220] : null;
      }
      if (f === 4 && v > 0.84 && Math.floor(u * 80) % 2 === 0) return [28, 30, 30];
      return null;
    },
  });
  // two access doors in the kick panel, one sprung when it is shot
  for (let k = 0; k < 2; k++) {
    const x0 = -0.36 + k * 0.37, x1 = x0 + 0.33;
    const ajar = M.hurt && k === 1;
    M.push([x0, 0, D / 2], ajar ? (wreck ? -1.2 : -0.55) : 0);
    M.slab(0.005, 0.055, 0, x1 - x0, 0.25, 0.008, body, {
      bevel: 0.004,
      paint: (u, v) => {
        if (v > 0.12 && v < 0.35 && u > 0.2 && u < 0.8 && Math.floor(v * 70) % 2 === 0) return [26, 28, 28];
        if (v > 0.5 && v < 0.62 && u > 0.3 && u < 0.7) return txt(k ? 'PWR' : 'LOGIC', u, v, 0.33, 0.52, 0.67, 0.6) ? [30, 30, 30] : [220, 214, 190];
        return null;
      },
    });
    M.slab(k ? 0.02 : x1 - x0 - 0.035, 0.13, 0.008, k ? 0.035 : x1 - x0 - 0.02, 0.19, 0.02, C.chrome, { bevel: 0.003 });
    M.pop();
  }
  // the sloped desk: a thick wedge whose top is the control face
  const a = 0.44, L = 0.265, sx0 = -W / 2, sx1 = 0.22;
  const slopeY = 0.356, slopeZ = 0.08;
  if (wreck) M.push([-0.09, slopeY - 0.06, slopeZ - 0.03], 0.08, a - Math.PI / 2 - 0.34, 0.12);
  else M.push([(sx0 + sx1) / 2 + 0.09, slopeY, slopeZ], 0, a - Math.PI / 2);
  const hw = (sx1 - sx0) / 2;
  M.slab(-hw, -L / 2, -0.1, hw, L / 2, 0, body, {
    bevel: 0.006, fixed: true,
    paint: (u, v, f) => {
      if (f !== 4 || u < 0.03 || u > 0.97 || v < 0.05 || v > 0.95) return null;
      // chrome bezels under the toggles
      const x = u * 2 * hw - hw, y = L / 2 - v * L;
      const t = (x + hw - 0.055) / 0.056, i = Math.round(t);
      if (i >= 0 && i < (alarm ? 7 : 10) && Math.hypot((t - i) * 0.056, y - 0.07) < 0.011) return [170, 174, 180, 1.5];
      return [52, 56, 58, 0.6];
    },
  });
  // dymo labels over the rows, then toggles, buttons and a lamp strip
  M.slab(-hw + 0.03, 0.095, 0, hw - 0.03, 0.108, 0.003, C.paper, {
    paint: (u) => (Math.floor(u * 11) % 1 === 0 && (u * 11) % 1 > 0.2 && (u * 11) % 1 < 0.8 ? [210, 206, 190] : [52, 56, 58]),
  });
  const cols = alarm ? 7 : 10;
  for (let i = 0; i < cols; i++) {
    if (M.hurt && (i === 3 || i === 7)) continue;
    const x = -hw + 0.055 + i * 0.056, up = (i * 7 + 3) % 5 < 2 ? -1 : 1;
    M.rod([x, 0.07, 0.0], [x, 0.07 + up * 0.012, 0.032], 0.005, C.chrome);
  }
  const bcol = [K.btnRed, K.btnGreen, K.btnAmber, K.btnWhite, K.btnBlue, K.btnGreen, K.btnWhite, K.btnAmber];
  const nb = alarm ? 5 : 8;
  for (let i = 0; i < nb; i++) {
    M.slab(-hw + 0.04 + i * 0.066, -0.005, 0, -hw + 0.074 + i * 0.066, 0.025, 0.013, bcol[i], { bevel: 0.003 });
  }
  const lampOn = !wreck;
  M.slab(-hw + 0.03, -0.1, 0, (alarm ? 0.02 : hw) - 0.03, -0.045, 0.004, lampOn ? mat('light', [20, 22, 22]) : C.black, {
    paint: (u, v) => {
      const cu = (u * 14) % 1, cv = (v * 3) % 1, iu = Math.floor(u * 14), iv = Math.floor(v * 3);
      if ((cu - 0.5) ** 2 + (cv - 0.5) ** 2 > 0.1) return null;
      if (!lampOn) return [40, 36, 34];
      const on = hh(iu, iv, alarm ? 5 : 3) > (M.hurt ? 0.5 : 0.3);
      const c = alarm ? [255, 60, 40] : [[255, 70, 50], [90, 255, 110], [255, 190, 60]][(iu + iv * 2) % 3];
      return on ? c : [c[0] * 0.25, c[1] * 0.25, c[2] * 0.25];
    },
  });
  if (alarm) {
    // THE button: hazard plate, red mushroom, a clear red cover flipped up
    const bx = hw - 0.1;
    M.slab(bx - 0.075, -0.1, 0, bx + 0.075, 0.1, 0.005, C.steelGrey, { paint: (u, v) => (u > 0.08 && u < 0.92 && v > 0.08 && v < 0.92 ? null : hazard(u, v, 6)) });
    M.cyl([bx, -0.02, 0.014], 0.036, 0.018, C.darkMetal, { axis: 'z' });
    M.sph([bx, -0.02, 0.026], [0.032, 0.032, 0.018], mat('plastic', [220, 20, 16], { gloss: 0.8 }));
    M.push([bx, 0.045, 0.02], 0, wreck ? 0.2 : -1.25);
    M.slab(-0.05, -0.003, -0.13, 0.05, 0.008, 0, mat('glass', [200, 40, 40], { gloss: 0.9 }), { bevel: 0.004 });
    M.pop();
    M.slab(bx - 0.06, 0.075, 0.005, bx + 0.06, 0.095, 0.007, C.paper, { paint: (u, v) => (txt('LAUNCH', u, v, 0.08, 0.1, 0.92, 0.9) ? [200, 20, 20] : null) });
  }
  M.pop();
  // the flat ledge at the right with the phone on it
  M.slab(sx1, 0.3, -0.04, W / 2, 0.33, D / 2, body, { bevel: 0.005, fixed: true });
  const ph = alarm ? K.redPhone : K.bakelite;
  if (wreck) M.push([0.2, 0, 0.3], 0.9, 0, 1.4);
  else M.push([0.31, 0.33, 0.07], -0.25);
  M.slab(-0.05, 0, -0.045, 0.05, 0.03, 0.045, ph, { bevel: 0.01 });
  M.box([0, 0.036, 0.02], [0.08, 0.026, 0.05], ph, {
    bevel: 0.006, pitch: -0.5,
    paint: (u, v, f) => {
      if (f !== 2 && f !== 4) return null;
      const d = Math.hypot(u - 0.5, (v - 0.5) * 0.6);
      if (d < 0.3 && d > 0.12) return Math.floor(Math.atan2(u - 0.5, v - 0.5) * 1.6 + 5) % 2 ? [236, 232, 220] : [40, 38, 36];
      return null;
    },
  });
  if (!M.hurt) {
    M.sph([-0.05, 0.05, -0.02], [0.018, 0.018, 0.028], ph);
    M.sph([0.05, 0.05, -0.02], [0.018, 0.018, 0.028], ph);
    M.rod([-0.05, 0.062, -0.02], [0.05, 0.062, -0.02], 0.011, ph);
  }
  M.pop();
  if (M.hurt && !wreck) {
    // off the hook, hanging down the front on its cord
    M.rod([0.26, 0.33, 0.08], [0.25, 0.17, D / 2 + 0.03], 0.005, K.wire[4]);
    M.push([0.25, 0.13, D / 2 + 0.03], 0, 0, 0.2);
    M.sph([0, 0.045, 0], [0.018, 0.028, 0.018], ph);
    M.sph([0, -0.045, 0], [0.018, 0.028, 0.018], ph);
    M.cyl([0, 0, 0], 0.011, 0.09, ph);
    M.pop();
  }
  // the upper panel under its hood
  const uz = -0.04, top = 0.6;
  if (wreck) M.push([0, 0, 0], 0.04, 0.05, -0.06);
  M.slab(-W / 2, 0.3, -D / 2, W / 2, top, uz, body, {
    bevel: 0.006, fixed: true,
    paint: (u, v, f) => {
      if (f !== 5) return null;
      // the service panel round the back: screws at its corners, vents, a warning
      if ((Math.abs(u - 0.08) < 0.012 || Math.abs(u - 0.92) < 0.012) && (Math.abs(v - 0.12) < 0.03 || Math.abs(v - 0.88) < 0.03)) return [40, 40, 40];
      if (u > 0.15 && u < 0.5 && v > 0.25 && v < 0.75 && (v * 40) % 1 < 0.4) return [26, 28, 28];
      if (u > 0.58 && u < 0.86 && v > 0.36 && v < 0.64) return txt('HIGH VOLTAGE', u, v, 0.6, 0.42, 0.84, 0.58) ? [20, 20, 20] : [226, 184, 40];
      return null;
    },
  });
  M.slab(-W / 2 - 0.012, top - 0.015, -D / 2, W / 2 + 0.012, top + 0.03, uz + 0.035, body, {
    bevel: 0.006, fixed: true,
    paint: (u, v, f) => (f === 4 ? (txt(alarm ? 'RED ALERT' : 'STRATCOM 7', u, v, 0.3, 0.18, 0.7, 0.82) ? [236, 232, 214] : [44, 48, 48]) : null),
  });
  // DEFCON lamps under the hood
  M.slab(-0.36, 0.553, uz, -0.04, 0.574, uz + 0.006, lampOn ? mat('light', [24, 24, 24]) : C.black, {
    paint: (u, v) => {
      const i = Math.floor(u * 5), cu = (u * 5) % 1;
      if (cu < 0.1 || cu > 0.9 || v < 0.12 || v > 0.88) return null;
      const lvl = alarm ? 4 : M.hurt ? 2 : 1;
      const on = lampOn && i === lvl;
      const c = on ? [255, 220, 120] : lampOn ? [120, 110, 90] : [50, 48, 44];
      return txt(String(5 - i), cu, v, 0.3, 0.2, 0.7, 0.8) ? [20, 20, 20] : c;
    },
  });
  for (const s of [-1, 1]) M.slab(s * W / 2 - 0.012, 0.41, uz - 0.01, s * W / 2 + 0.012, top, uz + 0.035, body, { bevel: 0.004 });
  // two oscilloscopes
  for (let k = 0; k < 2; k++) {
    const x = -0.3 + k * 0.135, y = 0.482;
    M.cyl([x, y, uz + 0.006], 0.056, 0.014, C.darkMetal, { axis: 'z' });
    const dead = wreck || (M.hurt && k === 1);
    M.cyl([x, y, uz + 0.012], 0.046, 0.006, dead ? C.glass : K.scope, {
      axis: 'z',
      paint: dead ? null : (u, v, f, lx, ly, lz) => {
        const X = lx / 0.046, Y = -lz / 0.046;
        const tr = k ? 0.45 * Math.sin(X * 9) * Math.cos(X * 2) : 0.35 * Math.sign(Math.sin(X * 6));
        if (Math.abs(Y - tr) < 0.09) return [170, 255, 190];
        if (Math.abs((X * 4) % 1) < 0.07 || Math.abs((Y * 4) % 1) < 0.07) return [40, 110, 70];
        return [10, 50, 30];
      },
    });
  }
  // the big gauge
  const gx = 0.03, gy = 0.482;
  M.cyl([gx, gy, uz + 0.008], 0.068, 0.018, C.chrome, { axis: 'z' });
  M.cyl([gx, gy, uz + 0.016], 0.058, 0.006, wreck ? C.glass : K.gaugeFace, {
    axis: 'z',
    paint: wreck ? null : (u, v, f, lx, ly, lz) => {
      const X = lx / 0.058, Y = -lz / 0.058, r = Math.hypot(X, Y), an = Math.atan2(X, Y);
      const needle = M.hurt ? 1.9 : alarm ? 1.5 : -0.6;
      const dA = an - needle;
      if (r < 0.8 && Math.abs(dA) < 0.06 / Math.max(r, 0.1) && Math.abs(dA) < 0.5) return [20, 20, 20];
      if (r < 0.12) return [30, 30, 30];
      if (r > 0.72 && r < 0.9 && Math.abs(an) < 2.2) {
        if (an > 1.2) return [200, 30, 24];
        return Math.floor((an + 2.2) * 6) % 2 ? [30, 30, 30] : null;
      }
      if (M.hurt && Math.abs(X * 0.7 - Y + 0.1) < 0.03) return [250, 250, 250];
      return txt('RADS', (X + 1) / 2, (Y + 1) / 2, 0.3, 0.6, 0.7, 0.75) ? [40, 40, 40] : null;
    },
  });
  // a little green CRT at the right
  M.slab(0.17, 0.42, uz, 0.37, 0.548, uz + 0.02, C.darkMetal, { bevel: 0.008 });
  M.slab(0.185, 0.433, uz + 0.02, 0.355, 0.535, uz + 0.024, wreck ? C.glass : alarm ? mat('screen', [220, 50, 40]) : C.screenGreen,
    { paint: wreck ? null : terminal([0.8, 0.4, 0.7, 0.55, 0.3], alarm ? [255, 70, 50] : [80, 230, 130]) });
  if (alarm && !wreck) {
    M.cyl([0.3, top + 0.04, -0.12], 0.03, 0.02, C.darkMetal);
    M.cyl([0.3, top + 0.068, -0.12], 0.024, 0.036, mat('glass', [240, 40, 30], { glow: 0.6 }));
  }
  if (wreck) M.pop();
  if (wreck) {
    // wires out of the hole where the desk was
    for (let i = 0; i < 6; i++) {
      const x = -0.3 + i * 0.09, z = 0.14 + (i % 2) * 0.03;
      const mid = [x + 0.02, 0.2 - (i % 3) * 0.04, z + 0.06];
      M.rod([x, 0.32, z - 0.04], mid, 0.006, K.wire[i % 5], { keep: true });
      M.rod(mid, [x - 0.01 + (i % 2) * 0.03, 0.01, z + 0.1], 0.006, K.wire[i % 5], { keep: true });
    }
  }
}

/** NUKE 'EM: a 1970s pinball table on four legs, a lit backglass, a coin door. */
function pinball(M) {
  const W = 0.34, L = 0.6, lit = !M.wreck, wreck = M.wreck;
  const cab = K.cabinet;
  const tilt = 0.07;
  // legs, splayed a touch, and levelling feet
  const legs = [[-1, 0.25, 0.27], [1, 0.25, 0.27], [-1, -0.21, 0.305], [1, -0.21, 0.305]];
  legs.forEach(([s, z, h], i) => {
    if (wreck && i === 0) {
      M.rod([-0.3, 0.012, 0.2], [-0.05, 0.03, 0.34], 0.014, C.chrome, { keep: true });
      return;
    }
    const lh = wreck && i === 1 ? h - 0.06 : h;
    M.rod([s * (W / 2 - 0.02), lh, z], [s * (W / 2 + 0.005), 0.016, z + (z > 0 ? 0.02 : -0.02)], 0.014, C.chrome);
    M.cyl([s * (W / 2 + 0.005), 0.008, z + (z > 0 ? 0.02 : -0.02)], 0.02, 0.016, C.darkMetal);
  });
  // the cabinet, its playfield pitched up toward the backbox
  if (wreck) M.push([0, 0.3, 0.0], 0, tilt + 0.1, 0.16);
  else M.push([0, 0.36, 0.0], 0, tilt);
  M.slab(-W / 2, -0.07, -L / 2, W / 2, 0.034, L / 2, cab, {
    bevel: 0.008, fixed: true,
    paint: (u, v, f) => {
      if (f === 2) return playfield(u, v, wreck);
      if (f === 0 || f === 1) {
        // side art: flames licking up from the bottom, the name
        const fl = 0.55 + 0.25 * Math.sin(u * 40) * Math.sin(u * 13 + 1);
        if (v > fl) return v > fl + 0.15 ? [236, 60, 20] : [250, 170, 30];
        if (txt("NUKE 'EM", u, v, 0.18, 0.18, 0.82, 0.48)) return [250, 214, 40];
        return null;
      }
      return null;
    },
  });
  // chrome rails round the glass, the lockdown bar
  for (const s of [-1, 1]) M.slab(s * W / 2 - 0.012, 0.034, -L / 2, s * W / 2 + 0.004 * s, 0.05, L / 2, C.chrome, { bevel: 0.004 });
  M.slab(-W / 2, 0.034, L / 2 - 0.03, W / 2, 0.052, L / 2 + 0.006, C.chrome, { bevel: 0.006 });
  // bumpers, slingshots, flippers, a ball
  if (!wreck) {
    for (const [x, z] of [[-0.07, -0.16], [0.07, -0.16], [0, -0.08]]) {
      M.cyl([x, 0.046, z], 0.03, 0.024, mat('plastic', [210, 40, 30], { gloss: 0.5 }));
      M.cyl([x, 0.062, z], 0.034, 0.008, mat('light', [255, 236, 170]));
    }
    for (const s of [-1, 1]) {
      M.box([s * 0.085, 0.044, 0.12], [0.022, 0.02, 0.08], K.btnWhite, { yaw: s * 0.35, bevel: 0.006 });
      if (M.hurt && s === 1) continue;
      M.box([s * 0.042, 0.042, 0.2], [0.064, 0.014, 0.016], mat('plastic', [236, 232, 224]), { yaw: s * 0.45, bevel: 0.006 });
    }
    M.sph([0.03, 0.046, 0.05], 0.012, C.chrome);
  }
  // coin door, lit slots, flipper buttons and the plunger
  const cd = M.hurt ? -1.1 : 0;
  M.push([-0.07, 0, L / 2], cd);
  M.slab(0, -0.058, 0, 0.14, 0.02, 0.01, C.darkMetal, { bevel: 0.004 });
  M.slab(0.02, -0.005, 0.01, 0.06, 0.012, 0.016, lit ? mat('light', [255, 70, 40]) : K.btnRed, { paint: (u, v) => (txt('25', u, v, 0.25, 0.15, 0.75, 0.85) ? [60, 10, 10] : null) });
  M.slab(0.08, -0.005, 0.01, 0.12, 0.012, 0.016, lit ? mat('light', [255, 70, 40]) : K.btnRed, { paint: (u, v) => (txt('25', u, v, 0.25, 0.15, 0.75, 0.85) ? [60, 10, 10] : null) });
  M.cyl([0.07, -0.035, 0.012], 0.008, 0.01, C.chrome, { axis: 'z' });
  M.pop();
  for (const s of [-1, 1]) M.cyl([s * (W / 2 + 0.004), -0.01, L / 2 - 0.06], 0.012, 0.012, K.btnRed, { axis: 'x' });
  M.rod([W / 2 - 0.04, -0.01, L / 2], [W / 2 - 0.04, -0.01, L / 2 + 0.04], 0.006, C.chrome);
  M.sph([W / 2 - 0.04, -0.01, L / 2 + 0.045], 0.012, K.btnRed);
  M.pop();
  // the backbox on its neck, the backglass lit from inside
  if (wreck) M.push([0.02, 0.36, -0.25], 0.25, -0.2, 0.32);
  else M.push([0, 0.43, -0.25]);
  M.slab(-W / 2 + 0.01, 0, -0.05, W / 2 - 0.01, 0.04, 0.05, cab, { bevel: 0.006, fixed: true });
  M.slab(-W / 2, 0.04, -0.06, W / 2, 0.3, 0.05, cab, {
    bevel: 0.008, fixed: true,
    paint: (u, v, f) => (f === 0 || f === 1 ? (v < 0.4 && Math.floor((u + v) * 10) % 2 ? [236, 60, 20] : null) : null),
  });
  M.slab(-W / 2 + 0.02, 0.06, 0.05, W / 2 - 0.02, 0.285, 0.056, lit ? mat('light', [30, 30, 60]) : mat('paint', [30, 26, 34], { wear: 0 }), {
    paint: (u, v) => backglass(u, v, lit, M.hurt),
  });
  M.slab(-W / 2 - 0.004, 0.296, -0.064, W / 2 + 0.004, 0.306, 0.058, C.chrome, { bevel: 0.003 });
  M.pop();
  if (wreck) {
    for (let i = 0; i < 4; i++) M.box([-0.1 + i * 0.09, 0.004, 0.36 - (i % 2) * 0.1], [0.05, 0.006, 0.035], C.glass, { yaw: i * 1.3, keep: true });
    M.sph([0.22, 0.012, 0.3], 0.012, C.chrome, { keep: true });
  }
}
function playfield(u, v, dark) {
  let c;
  const x = u - 0.5;
  if (v < 0.12 && Math.floor(u * 6) % 2 === 0 && (u * 6) % 1 < 0.15) c = [236, 232, 220];                       // top lanes
  else if (v > 0.9 && Math.abs(x) < 0.08) c = [10, 10, 14];                                                    // the drain
  else if ((x / 0.3) ** 2 + ((v - 0.3) / 0.12) ** 2 < 1) c = (x / 0.3) ** 2 + ((v - 0.3) / 0.12) ** 2 < 0.45 ? [255, 200, 60] : [236, 100, 30];   // the cloud
  else if (Math.abs(x) < 0.06 + (v - 0.4) * 0.3 && v > 0.38 && v < 0.62) c = [220, 120, 40];                    // its stem
  else if (txt("NUKE'EM", u, v, 0.12, 0.66, 0.88, 0.74)) c = [250, 230, 60];
  else if (v > 0.78 && Math.abs(Math.abs(x) - (0.4 - (v - 0.78) * 0.9)) < 0.012) c = [236, 232, 220];          // inlanes
  else if (hh(Math.floor(u * 40), Math.floor(v * 60), 4) < 0.05) c = [250, 240, 200];                            // stars
  else c = [26, 34, 96];
  if (dark) c = [c[0] * 0.5, c[1] * 0.45, c[2] * 0.45];
  // the glass over it catches the lights in two bands
  const g = (u * 0.7 + v) % 0.5;
  if (!dark && g > 0.08 && g < 0.13) c = lerp3(c, [255, 255, 255], 0.3);
  return [c[0], c[1], c[2], 2.2];
}
function backglass(u, v, lit, flicker) {
  let c;
  const x = u - 0.5;
  if (v > 0.82) {
    // score reels
    c = v > 0.85 && v < 0.97 && u > 0.2 && u < 0.8 ? (txt('1983000', u, v, 0.23, 0.87, 0.77, 0.95) ? [255, 140, 30] : [16, 10, 8]) : [40, 20, 60];
  } else if (txt('NUKE', u, v, 0.1, 0.06, 0.9, 0.3)) c = [255, 230, 60];
  else if (txt("'EM", u, v, 0.25, 0.34, 0.75, 0.56)) c = [255, 230, 60];
  else if ((txt('NUKE', u - 0.012, v - 0.012, 0.1, 0.06, 0.9, 0.3) || txt("'EM", u - 0.012, v - 0.012, 0.25, 0.34, 0.75, 0.56))) c = [200, 30, 20];
  else if (v > 0.56 && (x / 0.34) ** 2 + ((v - 0.68) / 0.1) ** 2 < 1) c = [255, 150, 40];
  else if (v > 0.62 && Math.abs(x) < 0.06) c = [240, 110, 30];
  else c = Math.floor(Math.atan2(x, v - 0.7) * 5 + 20) % 2 ? [60, 30, 120] : [110, 40, 150];
  if (!lit) return [c[0] * 0.25, c[1] * 0.22, c[2] * 0.25];
  if (flicker && u > 0.55) return [c[0] * 0.35, c[1] * 0.35, c[2] * 0.4];
  return c;
}

// ------------------------------------------------------------------ chapel

/** A church pew: seat, slatted back, carved ends, a rack of hymn books behind. */
function pew(M) {
  if (M.wreck) {
    // snapped in the middle: each half sags onto the floor at the break
    M.push([-0.45, 0, 0], 0, 0, -0.34); pewHalf(M, -1); M.pop();
    M.push([0.45, 0, 0.02], -0.1, 0, 0.5); pewHalf(M, 1); M.pop();
    M.box([0.02, 0.01, 0.16], [0.14, 0.012, 0.03], K.hymnRed, { yaw: 0.6, keep: true });
    return;
  }
  M.push([-0.45, 0, 0]); pewHalf(M, -1); M.pop();
  M.push([0.45, 0, 0]); pewHalf(M, 1); M.pop();
  if (M.hurt) M.box([0.1, 0.235, 0.1], [0.1, 0.018, 0.07], K.hymnBlack, { yaw: 0.4, bevel: 0.004 });
}
/** Half a pew from its end panel (at local x 0) in to the middle (0.45 toward -side). */
function pewHalf(M, side) {
  const w = K.pewWood, dk = K.pewDark, s = -side, Lh = 0.45;
  const x0 = s * 0.02, x1 = s * Lh;
  const sl = (a, b) => [Math.min(a, b), Math.max(a, b)];
  const [ax, bx] = sl(x0, x1);
  // the carved end: a thick board, a raised inset with a cross, a scroll on top, a foot
  M.slab(-0.022, 0.02, -0.14, 0.022, 0.4, 0.2, w, {
    bevel: 0.01, fixed: true,
    paint: (u, v, f) => {
      if (f !== 0 && f !== 1) return null;
      const cu = (f === 0 ? u : 1 - u), inset = cu > 0.18 && cu < 0.82 && v > 0.12 && v < 0.78;
      if (inset && (cu < 0.21 || cu > 0.79 || v < 0.15 || v > 0.75)) return [60, 34, 18];
      if (inset && ((Math.abs(cu - 0.5) < 0.04 && v > 0.22 && v < 0.68) || (Math.abs(v - 0.36) < 0.035 && Math.abs(cu - 0.5) < 0.16))) return [58, 32, 16];
      return null;
    },
  });
  M.cyl([0, 0.41, 0.08], 0.03, 0.05, w, { axis: 'x' });
  M.cyl([0, 0.4, -0.1], 0.04, 0.05, w, { axis: 'x' });
  M.slab(-0.03, 0, -0.16, 0.03, 0.03, 0.22, dk, { bevel: 0.008, fixed: true });
  // seat and its front lip
  M.slab(ax, 0.2, -0.08, bx, 0.222, 0.19, w, { bevel: 0.006, fixed: true });
  M.slab(ax, 0.18, 0.16, bx, 0.2, 0.19, dk, { bevel: 0.004 });
  M.slab(ax, 0.06, -0.02, bx, 0.085, 0.0, dk);
  // the back: two rails and slats, leaning a little
  M.push([0, 0.222, -0.09], 0, -0.14);
  M.slab(ax, 0.2, -0.02, bx, 0.24, 0.018, w, { bevel: 0.008 });
  M.slab(ax, 0.02, -0.014, bx, 0.05, 0.014, w, { bevel: 0.005 });
  for (let k = 0; k < 4; k++) {
    if (M.hurt && !M.wreck && side === 1 && k === 2) continue;
    const xs = s * (0.07 + k * 0.1);
    M.slab(xs - 0.025, 0.05, -0.01, xs + 0.025, 0.2, 0.01, w, { bevel: 0.004 });
  }
  // the hymn book rack on its back, and the books
  M.slab(ax + 0.01, 0.02, -0.1, bx - 0.01, 0.03, -0.014, dk, { bevel: 0.003 });
  M.slab(ax + 0.01, 0.03, -0.108, bx - 0.01, 0.1, -0.096, dk, { bevel: 0.003 });
  const books = [K.hymnRed, K.hymnBlack, K.hymnRed, K.hymnRed, K.hymnBlack];
  for (let k = 0; k < 4; k++) {
    if (M.hurt && k === 1 + (side > 0 ? 1 : 0)) continue;
    const xb = s * (0.06 + k * 0.1);
    M.box([xb, 0.08, -0.057], [0.075, 0.1, 0.022], books[k + (side > 0 ? 1 : 0)], { bevel: 0.004, roll: (k % 2 ? 0.08 : -0.05) });
  }
  M.pop();
}

// ------------------------------------------------------------------ stores

/** A curved wall of burlap sandbags, three courses, staggered. */
function sandbags(M) {
  const R = 0.56, cz = -0.4;
  const mats = [K.bag, K.bag2, K.bag3];
  const rr = srand(911);
  const course = (n, y, k, dropped) => {
    for (let i = 0; i < n; i++) {
      const t = (i - (n - 1) / 2) * 0.3;
      const jit = rr(), jr = rr();
      let x = Math.sin(t) * R, z = cz + Math.cos(t) * R, yy = y, yaw = t + (jit - 0.5) * 0.14, roll = (jr - 0.5) * 0.08;
      if (dropped && dropped(i)) {
        // knocked off the top onto the floor in front
        x += (jit - 0.5) * 0.2; z += 0.2 + jr * 0.1; yy = 0.05; yaw += (jit - 0.5) * 1.5; roll = 0;
      } else if (M.hurt && k === 2 && i === 1) continue;
      const m = mats[(i * 2 + k) % 3];
      M.push([x, yy, z], yaw, 0, roll);
      M.sph([0, 0, 0], [0.108, 0.064, 0.082], m, { keep: true });
      M.box([0, 0, 0], [0.15, 0.088, 0.12], m, { bevel: 0.03, keep: true });
      const e = (i + k) % 2 ? 1 : -1;
      M.sph([e * 0.104, 0.004, 0], [0.024, 0.032, 0.04], m);
      M.cyl([e * 0.088, 0.004, 0], 0.028, 0.012, K.string, { axis: 'x' });
      M.pop();
    }
  };
  course(5, 0.064, 0);
  course(4, 0.19, 1);
  course(3, 0.316, 2, M.wreck ? (i) => i !== 0 : null);
  if (M.hurt) {
    // spilled sand out of a torn bag
    M.sph([0.05, 0.0, 0.24], [0.12, 0.02, 0.07], K.sand, { keep: true });
    if (M.wreck) M.sph([-0.2, 0, 0.28], [0.1, 0.018, 0.08], K.sand, { keep: true });
  }
}

// ------------------------------------------------------------------ the silo

const K2 = {
  warhead: mat('paint', [230, 228, 220], { wear: 0.2, gloss: 0.45 }),
  tipRed: mat('paint', [196, 34, 28], { wear: 0.3, gloss: 0.45 }),
  alu: mat('metal', [168, 172, 176], { gloss: 0.5 }),
  cradle: mat('paint', [84, 96, 108], { wear: 0.6, rust: 0.15 }),
  wax: mat('plastic', [250, 242, 214], { gloss: 0.3 }),
  waxOld: mat('plastic', [240, 222, 180], { gloss: 0.3 }),
  wick: mat('plastic', [30, 24, 20]),
  flame: mat('light', [255, 150, 40]),
  flameCore: mat('light', [255, 236, 176]),
  propane: mat('paint', [186, 36, 30], { wear: 0.5, rust: 0.1 }),
  oxygen: mat('paint', [46, 110, 64], { wear: 0.5, rust: 0.1 }),
  argon: mat('paint', [120, 124, 126], { wear: 0.5, rust: 0.1 }),
  chain: mat('metal', [110, 108, 104], { gloss: 0.5 }),
  scorch: mat('rubber', [22, 18, 16]),
  shelf: mat('paint', [118, 124, 126], { wear: 0.55, rust: 0.12 }),
  card: mat('paper', [172, 132, 86]),
  card2: mat('paper', [150, 116, 76]),
  rope: mat('fabric', [190, 160, 108]),
};

/** A trefoil in a yellow disc: true-ish colour or null, at offset (du, dv) from its centre, radius r. */
function trefoil(du, dv, r) {
  const d = Math.hypot(du, dv);
  if (d > r) return null;
  if (d < r * 0.18) return [20, 20, 20];
  const a = Math.atan2(dv, du) + Math.PI / 2;
  if (d > r * 0.3 && d < r * 0.85 && ((a * 3 / TAU) % 1 + 1) % 1 < 0.5) return [20, 20, 20];
  return [240, 200, 40];
}

/** A warhead nose cone on a steel cradle: bolted ring, red tip, stencils. */
function nosecone(M) {
  const cr = K2.cradle, fx = { fixed: true, bevel: 0.006 };
  // the cradle: a square frame, four raked posts, the saddle ring
  const e = 0.22;
  for (const s of [-1, 1]) {
    M.slab(-e - 0.02, 0, s * e - 0.02, e + 0.02, 0.04, s * e + 0.02, cr, { ...fx, paint: (u, v, f) => (f === 4 || f === 5 ? hazard(u, v, 7) : null) });
    M.slab(s * e - 0.02, 0, -e + 0.02, s * e + 0.02, 0.04, e - 0.02, cr, fx);
  }
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) M.rod([sx * e, 0.04, sz * e], [sx * 0.15, 0.2, sz * 0.15], 0.014, cr);
  M.cyl([0, 0.205, 0], 0.235, 0.03, cr, { fixed: true });
  M.slab(-0.06, 0.06, e + 0.02, 0.06, 0.1, e + 0.03, C.paper, { paint: (u, v) => (txt('MK-7', u, v, 0.15, 0.2, 0.85, 0.8) ? [30, 30, 30] : null) });
  if (M.wreck) {
    // knocked off its cradle and lying on the floor in front
    M.cyl([0, 0.24, 0], 0.212, 0.03, K2.alu, { fixed: true });
    M.push([0.06, 0.212, -0.1], 0.35, Math.PI / 2 - 0.02, 0);
    M.push([0, -0.24, 0]);
  }
  // the bolted ring at its base
  M.cyl([0, 0.24, 0], 0.216, 0.05, K2.alu, { fixed: true });
  const nb = 12;
  for (let i = 0; i < nb; i++) {
    const a = (i + 0.5) * TAU / nb;
    M.cyl([Math.sin(a) * 0.218, 0.24, Math.cos(a) * 0.218], 0.011, 0.012, C.darkMetal, { yaw: a, pitch: Math.PI / 2 });
  }
  // the ogive in three frustums, a seam band, the red tip and the fuze probe
  const hatch = M.hurt;
  M.cone([0, 0.385, 0], 0.206, 0.17, 0.24, K2.warhead, {
    fixed: true,
    paint: (u, v, f, lx, ly, lz) => {
      const [a, b] = wrapUV(lx, ly, lz, -0.62, 0.62, -0.12, 0.12);
      if (txt('NO STEP', a, b, 0.05, 0.22, 0.95, 0.46)) return [30, 30, 30];
      if (txt('W47-0451', a, b, 0.14, 0.6, 0.86, 0.76)) return [30, 30, 30];
      const an = Math.atan2(lx, lz), rr = Math.hypot(lx, lz);
      for (const s of [-1, 1]) {
        const t = trefoil((an - s * 1.55) * rr, ly - 0.01, 0.042);
        if (t) return t;
      }
      // the access hatch round the back
      const hu = (an > 0 ? an - Math.PI : an + Math.PI) * rr;
      if (Math.abs(hu) < 0.05 && Math.abs(ly) < 0.06) {
        if (hatch) return [20, 20, 22];
        if (Math.abs(hu) > 0.044 || Math.abs(ly) > 0.054) return [90, 90, 90];
      }
      if (M.hurt && fb(an * 4, ly * 20, 5) > 0.66) return [70, 64, 58];
      return null;
    },
  });
  M.cyl([0, 0.508, 0], 0.172, 0.012, C.darkMetal);
  M.cone([0, 0.614, 0], 0.17, 0.105, 0.2, K2.warhead, {
    paint: (u, v, f, lx, ly, lz) => {
      const [a, b] = wrapUV(lx, ly, lz, -0.8, 0.8, -0.1, 0.1);
      if (txt('USAF', a, b, 0.25, 0.3, 0.75, 0.6)) return [30, 30, 30];
      return null;
    },
  });
  M.cone([0, 0.784, 0], 0.105, 0.04, 0.14, K2.tipRed);
  M.sph([0, 0.852, 0], [0.042, 0.03, 0.042], K2.tipRed);
  M.cyl([0, 0.892, 0], 0.01, 0.05, K2.alu);
  if (hatch && !M.wreck) {
    // the hatch hangs off one hinge
    M.box([0.14, 0.3, -0.16], [0.1, 0.12, 0.012], K2.warhead, { yaw: 2.2, roll: 0.3, bevel: 0.004 });
  }
  if (M.wreck) { M.pop(); M.pop(); }
}

// ------------------------------------------------------------------ chapel, again

/** A clump of melted church candles on a puddle of wax, lit. */
function candles(M) {
  const cs = [[0, 0, 0.032, 0.21], [0.062, 0.032, 0.026, 0.155], [-0.058, 0.03, 0.028, 0.115], [0.018, -0.06, 0.024, 0.18],
    [-0.066, -0.04, 0.022, 0.085], [0.08, -0.034, 0.02, 0.07], [-0.014, 0.078, 0.021, 0.06]];
  // the puddle, two lobes
  M.cyl([0, 0.005, 0], 0.13, 0.01, K2.waxOld, { keep: true });
  M.sph([0.08, 0.008, 0.07], [0.07, 0.008, 0.05], K2.waxOld, { keep: true });
  M.sph([-0.09, 0.008, -0.05], [0.06, 0.008, 0.06], K2.waxOld, { keep: true });
  cs.forEach(([x, z, r, h], i) => {
    const wm = i % 3 === 2 ? K2.waxOld : K2.wax;
    if (M.wreck && i !== 4) {
      // knocked over and rolled apart
      const a = i * 2.1;
      M.cyl([x * 2.4 + Math.sin(a) * 0.05, r, z * 2.4 + Math.cos(a) * 0.05], r, h, wm, { axis: 'x', yaw: a, keep: true });
      M.cyl([x * 2.4 + Math.sin(a) * 0.05 - Math.cos(a) * (h / 2 + 0.004), r, z * 2.4 + Math.cos(a) * 0.05 + Math.sin(a) * (h / 2 + 0.004)], 0.004, 0.012, K2.wick, { axis: 'x', yaw: a });
      return;
    }
    M.cyl([x, 0.01 + h / 2, z], r, h, wm, { keep: true });
    // a melted rim and runs down the side
    M.cyl([x, 0.01 + h - 0.002, z], r * 1.06, 0.008, wm);
    for (let k = 0; k < 2; k++) {
      const a = i * 1.7 + k * 2.4, len = 0.02 + ((i + k) % 3) * 0.012;
      M.sph([x + Math.sin(a) * r, 0.01 + h - len * 0.7, z + Math.cos(a) * r], [0.008, len, 0.008], wm);
    }
    const top = 0.01 + h + 0.004;
    M.cyl([x, top + 0.005, z], 0.004, 0.012, K2.wick);
    const out = M.hurt && (i === 1 || i === 3 || i === 5 || M.wreck);
    if (out) return;
    M.sph([x, top + 0.018, z], [0.012, 0.016, 0.012], K2.flameCore);
    M.cone([x, top + 0.043, z], 0.011, 0.001, 0.036, K2.flame);
  });
}

// ------------------------------------------------------------------ the workshop

/** A gas bottle: body with labels, shoulder, valve and handwheel or a cap. */
function bottle(M, kind, o = {}) {
  const r = 0.062, H = 0.48;
  const m = [K2.propane, K2.oxygen, K2.argon][kind];
  const name = ['PROPANE', 'OXYGEN', 'ARGON'][kind];
  const dia = [[220, 40, 30], [240, 200, 40], [60, 160, 70]][kind];
  M.cyl([0, 0.006, 0], r - 0.004, 0.012, C.darkMetal);
  M.cyl([0, 0.012 + H / 2, 0], r, H, m, {
    fixed: true,
    paint: (u, v, f, lx, ly, lz) => {
      // the name runs down a white strip, then the hazard diamond
      const an = Math.atan2(lx, lz);
      if (Math.abs(an) < 0.5 && ly > -0.12 && ly < 0.2) {
        return txt(name, (0.19 - ly) / 0.3, (0.42 - an) / 0.84, 0.02, 0.2, 0.98, 0.8) ? [24, 24, 24] : [236, 232, 220];
      }
      const du = an * r, dv = ly + 0.17;
      const dd = Math.abs(du) + Math.abs(dv);
      if (dd < 0.036) return dd > 0.03 ? [20, 20, 20] : dd < 0.01 ? [20, 20, 20] : dia;
      if (Math.abs(ly - 0.215) < 0.008) return [236, 232, 220];
      return null;
    },
  });
  M.sph([0, 0.012 + H, 0], [r, 0.05, r], m);
  M.cyl([0, H + 0.07, 0], 0.022, 0.03, m);
  if (kind === 2 && !o.nocap) {
    M.cyl([0, H + 0.11, 0], 0.036, 0.06, C.darkMetal);
    M.sph([0, H + 0.14, 0], [0.036, 0.018, 0.036], C.darkMetal);
    return;
  }
  M.cyl([0, H + 0.1, 0], 0.016, 0.034, C.brass);
  M.rod([0, H + 0.098, 0], [0.04, H + 0.098, 0.01], 0.008, C.brass);
  M.cyl([0.044, H + 0.098, 0.011], 0.012, 0.014, C.brass, { axis: 'x' });
  M.cyl([0, H + 0.124, 0], 0.028, 0.01, kind === 1 ? K.btnGreen : C.black);
}

/** Three gas bottles chained to a wall bracket. They go off. */
function gascyl(M) {
  const zc = -0.03, xs = [-0.14, 0, 0.14];
  // the wall plate and its arms
  M.slab(-0.25, 0.3, -0.122, 0.25, 0.44, -0.1, C.olive, {
    bevel: 0.006, fixed: true,
    paint: (u, v, f) => (f === 4 && v > 0.3 && v < 0.7 && u > 0.3 && u < 0.7 ? (txt('NO SMOKING', u, v, 0.32, 0.36, 0.68, 0.64) ? [236, 232, 220] : [190, 30, 26]) : null),
  });
  for (const x of [-0.22, 0.22]) {
    M.cyl([x, 0.37, -0.098], 0.012, 0.01, C.chrome, { axis: 'z' });
    M.slab(x - 0.012, 0.36, -0.1, x + 0.012, 0.38, 0.03, C.olive, { bevel: 0.003 });
  }
  M.slab(-0.23, 0, -0.12, 0.23, 0.02, 0.07, C.darkMetal, { fixed: true, bevel: 0.004 });
  if (M.wreck) {
    // the right one went up: a torn stub, soot; the others are on the floor
    M.cyl([0.14, 0.03, zc], 0.066, 0.04, K2.scorch, { keep: true });
    M.sph([0.14, 0.002, zc + 0.06], [0.2, 0.002, 0.14], K2.scorch, { keep: true });
    M.box([0.2, 0.012, 0.16], [0.08, 0.012, 0.05], K2.argon, { yaw: 0.8, keep: true });
    M.push([-0.26, 0.062, 0.06], 0.2, 0, -Math.PI / 2 + 0.02); bottle(M, 0); M.pop();
    M.push([0.24, 0.062, 0.2], -0.5, 0, Math.PI / 2 - 0.02); bottle(M, 1); M.pop();
    for (let i = 0; i < 4; i++) M.sph([-0.22, 0.36 - i * 0.03, 0.03], [0.008, 0.014, 0.004], K2.chain, { keep: true });
    return;
  }
  for (let k = 0; k < 3; k++) {
    const lean = M.hurt && k === 0 ? 0.07 : 0;
    M.push([xs[k], 0.0, zc], 0.3 * k - 0.3, 0, -lean);
    bottle(M, k, { nocap: M.hurt });
    M.pop();
  }
  // the chain across their fronts, link by link
  const pts = M.hurt ? [[-0.22, 0.37, 0.03], [-0.2, 0.28, 0.06], [-0.19, 0.2, 0.06]] : [[-0.22, 0.37, 0.03], [-0.14, 0.37, zc + 0.066], [0, 0.37, zc + 0.066], [0.14, 0.37, zc + 0.066], [0.22, 0.37, 0.03]];
  for (let s = 0; s < pts.length - 1; s++) {
    const [a, b] = [pts[s], pts[s + 1]];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), n = Math.max(1, Math.round(L / 0.026));
    const yaw = Math.atan2(b[2] - a[2], b[0] - a[0]);
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
      M.sph(p, i % 2 ? [0.016, 0.004, 0.009] : [0.016, 0.009, 0.004], K2.chain, { yaw: -yaw, keep: true });
    }
  }
}

// ------------------------------------------------------------------ stores, again

/** A cardboard box: tape across the top, a stencil. */
function carton(M, c, s, word, o = {}) {
  M.box(c, s, o.m || K2.card, {
    bevel: 0.006, yaw: o.yaw || 0, roll: o.roll || 0, pitch: o.pitch || 0,
    paint: (u, v, f) => {
      if (f === 2) return Math.abs(u - 0.5) < 0.08 ? [196, 170, 110] : Math.abs(v - 0.5) < 0.012 ? [110, 80, 50] : null;
      if ((f === 4 || f === 5) && Math.abs(u - 0.5) < 0.08 && v < 0.2) return [196, 170, 110];
      if (f === 4 && word) return txt(word, u, v, 0.1, 0.4, 0.9, 0.62) ? [50, 36, 24] : null;
      return null;
    },
  });
}
/** A paint tin with its colour run down the side. */
function tin(M, c, col, o = {}) {
  M.cyl(c, 0.034, 0.07, C.chrome, {
    yaw: o.yaw || 0, roll: o.roll || 0, pitch: o.pitch || 0,
    paint: (u, v, f, lx, ly, lz) => {
      if (f === 2) return Math.hypot(lx, lz) > 0.026 && Math.hypot(lx, lz) < 0.03 ? [90, 90, 94] : col;
      const a = Math.atan2(lx, lz);
      if (ly > 0.02 && Math.sin(a * 5) > 0.3 - (ly - 0.02) * 20) return col;
      if (ly > -0.02 && ly < 0.02) return (a > -1.2 && a < 1.2) ? [236, 232, 220] : col;
      return null;
    },
  });
}
/** A jerry can standing: the X pressed in its side, three handles, a spout. */
function jerry(M, c, m, o = {}) {
  M.push(c, o.yaw || 0, o.pitch || 0, o.roll || 0);
  M.box([0, 0.085, 0], [0.15, 0.17, 0.075], m, {
    bevel: 0.012,
    paint: (u, v, f) => ((f === 4 || f === 5) && u > 0.1 && u < 0.9 && v > 0.12 && v < 0.9 && (Math.abs((u - 0.5) * 0.9 - (v - 0.51)) < 0.04 || Math.abs((u - 0.5) * 0.9 + (v - 0.51)) < 0.04) ? [m.c[0] * 0.7, m.c[1] * 0.7, m.c[2] * 0.7] : null),
  });
  M.rod([-0.05, 0.19, 0], [0.03, 0.19, 0], 0.009, m);
  M.cyl([0.056, 0.182, 0], 0.016, 0.024, m, { roll: -0.4 });
  M.pop();
}
/** A coil of rope lying flat. */
function rope(M, c, o = {}) {
  M.cyl(c, 0.075, 0.045, K2.rope, {
    roll: o.roll || 0, pitch: o.pitch || 0,
    paint: (u, v, f, lx, ly, lz) => {
      if (f === 2 || f === 3) return (Math.hypot(lx, lz) * 180) % 1 < 0.3 ? [120, 96, 60] : null;
      return ((ly * 300 + Math.atan2(lx, lz) * 2) % 1 + 1) % 1 < 0.3 ? [140, 112, 72] : null;
    },
  });
  M.cyl([c[0], c[1] + 0.001, c[2]], 0.03, 0.047, C.black, { roll: o.roll || 0, pitch: o.pitch || 0 });
}

/** Grey steel shelving on angle-iron posts, stocked. */
function shelving(M) {
  const W = 0.8, D = 0.28, x0 = -W / 2, x1 = W / 2, z0 = -D / 2, z1 = D / 2;
  const ys = [0.03, 0.27, 0.51, 0.75], wreck = M.wreck;
  const st = K2.shelf;
  const posts = (x, z, sx, sz, h) => {
    const holes = (u, v, f) => ((v * 40) % 1 < 0.35 && Math.abs(u - 0.5) < 0.18 && (f === 4 || f === 5 || f === 0 || f === 1) ? [30, 30, 32] : null);
    M.slab(x, 0, z, x + sx * 0.04, h, z + sz * 0.009, st, { bevel: 0.002, fixed: true, paint: holes });
    M.slab(x, 0, z, x + sx * 0.009, h, z + sz * 0.04, st, { bevel: 0.002, fixed: true, paint: holes });
  };
  if (!wreck) {
    for (const [x, z, sx, sz] of [[x0, z1, 1, -1], [x1, z1, -1, -1], [x0, z0, 1, 1], [x1, z0, -1, 1]]) posts(x, z, sx, sz, 0.8);
  } else {
    // the right-hand posts buckled; the left ones hold
    posts(x0, z1, 1, -1, 0.8); posts(x0, z0, 1, 1, 0.8);
    posts(x1, z1, -1, -1, 0.26); posts(x1, z0, -1, 1, 0.26);
    M.box([x1 + 0.12, 0.02, 0.1], [0.5, 0.04, 0.04], st, { yaw: 0.9, keep: true });
  }
  const shelfAt = (k) => {
    if (!wreck) return { y: ys[k], roll: M.hurt && k === 2 ? -0.1 : 0 };
    const yl = ys[k], yr = Math.max(0.02, ys[k] * 0.35);
    return { y: (yl + yr) / 2, roll: -Math.atan2(yl - yr, W) };
  };
  for (let k = 0; k < 4; k++) {
    const { y, roll } = shelfAt(k);
    M.push([0, y, 0], 0, 0, roll);
    M.slab(x0 + 0.004, 0, z0 + 0.004, x1 - 0.004, 0.018, z1 - 0.004, st, { bevel: 0.004, fixed: true });
    M.slab(x0 + 0.004, -0.018, z1 - 0.012, x1 - 0.004, 0.018, z1 - 0.002, st, { bevel: 0.003, fixed: true });
    M.pop();
  }
  M.rod([x0 + 0.02, 0.04, z0 + 0.01], [x1 - 0.02, wreck ? 0.26 : 0.76, z0 + 0.01], 0.006, st);
  M.rod([x1 - 0.02, 0.04, z0 + 0.01], [x0 + 0.02, 0.76, z0 + 0.01], 0.006, st);
  if (wreck) {
    // everything slid off to the right onto the floor
    jerry(M, [0.3, 0.04, 0.26], C.olive, { yaw: 0.6, roll: Math.PI / 2 });
    carton(M, [0.1, 0.07, 0.3], [0.2, 0.14, 0.16], 'MRE', { yaw: 0.3 });
    carton(M, [0.42, 0.06, 0.08], [0.18, 0.12, 0.16], null, { yaw: -0.4, m: K2.card2 });
    carton(M, [-0.05, 0.12, 0.08], [0.16, 0.1, 0.14], 'PAPER', { yaw: 0.2, roll: 0.3 });
    tin(M, [0.2, 0.034, 0.44], [60, 110, 170], { roll: Math.PI / 2, yaw: 0.3 });
    tin(M, [0.52, 0.034, 0.3], [210, 190, 50], { pitch: Math.PI / 2 });
    rope(M, [-0.2, 0.024, 0.28]);
    M.sph([0.3, 0.001, 0.4], [0.1, 0.003, 0.06], mat('plastic', [60, 110, 170], { gloss: 0.7 }), { keep: true });
    return;
  }
  const s = (k) => ys[k] + 0.018;
  // bottom: two jerry cans and a rope
  jerry(M, [-0.26, s(0), 0.02], C.olive);
  jerry(M, [-0.08, s(0), 0.02], C.colaRed, { yaw: 0.15 });
  rope(M, [0.2, s(0) + 0.023, 0.0]);
  // second: boxes and tins
  carton(M, [-0.22, s(1) + 0.08, -0.01], [0.26, 0.16, 0.2], 'MRE');
  tin(M, [0.03, s(1) + 0.035, 0.04], [60, 110, 170]);
  tin(M, [0.11, s(1) + 0.035, 0.03], [210, 190, 50]);
  tin(M, [0.07, s(1) + 0.105, 0.03], [200, 50, 40]);
  carton(M, [0.26, s(1) + 0.07, -0.01], [0.2, 0.14, 0.2], null, { m: K2.card2, yaw: -0.1 });
  // third: a sagging shelf when shot
  const sag = M.hurt;
  M.push([0, s(2), 0], 0, 0, sag ? -0.1 : 0);
  carton(M, [-0.24, 0.06, 0.0], [0.22, 0.12, 0.2], 'PAPER');
  carton(M, [0.02, 0.09, -0.02], [0.2, 0.18, 0.18], 'FRAGILE', { m: K2.card2 });
  if (!sag) jerry(M, [0.25, 0, 0.02], mat('paint', [60, 90, 60], { wear: 0.6 }), { yaw: -0.2 });
  M.pop();
  if (sag) jerry(M, [0.3, 0.04, 0.26], mat('paint', [60, 90, 60], { wear: 0.6 }), { yaw: 0.5, roll: Math.PI / 2 });
  // top
  carton(M, [-0.2, s(3) + 0.065, 0], [0.24, 0.13, 0.2], null, { yaw: 0.06 });
  rope(M, [0.12, s(3) + 0.023, 0.0]);
  tin(M, [0.28, s(3) + 0.035, 0.03], [236, 232, 220]);
}

// ------------------------------------------------------------------ the workshop, again

const K3 = {
  block: mat('wood', [196, 156, 104], { grain: 0.8 }),
  leg: mat('wood', [150, 110, 66]),
  peg: mat('wood', [152, 112, 72], { grain: 0.3 }),
  vise: mat('paint', [62, 84, 112], { wear: 0.6 }),
  handleRed: mat('plastic', [196, 40, 30]),
  handleYel: mat('plastic', [226, 184, 40]),
  handleBlue: mat('plastic', [50, 90, 180]),
  cord: mat('rubber', [226, 110, 30]),
  lampShade: mat('paint', [46, 92, 60], { wear: 0.4 }),
  bulb: mat('light', [255, 240, 190]),
  steel: mat('metal', [140, 144, 150], { gloss: 0.6 }),
  drab: mat('paint', [88, 96, 62], { wear: 0.55, rust: 0.12 }),
  drabDark: mat('paint', [64, 70, 46], { wear: 0.5, rust: 0.15 }),
  exhaust: mat('metal', [70, 58, 50], { gloss: 0.3, rust: 0.5 }),
  diesel: mat('plastic', [16, 14, 16], { gloss: 0.9 }),
  reel: mat('wood', [180, 136, 84], { grain: 1.2 }),
  cable: mat('rubber', [30, 30, 34], { gloss: 0.3 }),
  oakDark: mat('wood', [118, 72, 40]),
  page: mat('paper', [236, 226, 196]),
  cover: mat('leather', [96, 24, 22]),
  ribbon: mat('fabric', [170, 30, 30]),
};

/** Heavy bench, a vise, tools left out, a pegboard of tools, a clamp lamp. */
function workbench(M) {
  const W = 0.84, wreck = M.wreck, hurt = M.hurt;
  const top = 0.4;
  // the back uprights carry the pegboard; the front legs are short
  for (const s of [-1, 1]) {
    M.slab(s * 0.4 - 0.025, 0, -0.18, s * 0.4 + 0.025, 0.86, -0.13, K3.leg, { bevel: 0.006, fixed: true });
    if (wreck && s === -1) M.box([-0.3, 0.025, 0.24], [0.05, 0.05, 0.36], K3.leg, { yaw: 1.2, keep: true });
    else M.slab(s * 0.4 - 0.025, 0, 0.1, s * 0.4 + 0.025, top - 0.04, 0.15, K3.leg, { bevel: 0.006, fixed: true });
  }
  M.slab(-0.38, 0.08, -0.14, 0.38, 0.1, 0.13, K3.leg, { bevel: 0.004, fixed: true });
  // the top: a thick laminated block, sagging to the broken leg in a wreck
  M.push(wreck ? [0, top - 0.02, 0] : [0, top, 0], 0, wreck ? 0.08 : 0, wreck ? 0.24 : 0);
  M.slab(-W / 2, -0.045, -0.13, W / 2, 0, 0.18, K3.block, {
    bevel: 0.008, fixed: true,
    paint: (u, v, f) => {
      if (f === 2 || f === 4) {
        const k = f === 2 ? v * 7 : u * 30;
        if (f === 2 && k % 1 < 0.06) return [120, 88, 54];
        if (f === 2 && hh(Math.floor(u * 50), Math.floor(v * 30), 7) < 0.03) return [90, 70, 50];
      }
      return null;
    },
  });
  // drawer under the front
  M.slab(0.04, -0.1, 0.13, 0.3, -0.045, 0.172, K3.leg, { bevel: 0.004 });
  M.slab(0.14, -0.08, 0.172, 0.2, -0.068, 0.184, C.chrome);
  // the vise on the front left
  M.slab(-0.36, 0, 0.08, -0.24, 0.035, 0.17, K3.vise, { bevel: 0.006 });
  M.slab(-0.36, 0.035, 0.15, -0.24, 0.085, 0.175, K3.vise, { bevel: 0.005 });
  M.slab(-0.36, 0.03, 0.2, -0.24, 0.085, 0.225, K3.vise, { bevel: 0.005 });
  M.slab(-0.33, 0.035, 0.175, -0.27, 0.06, 0.2, K3.vise);
  M.rod([-0.3, 0.05, 0.225], [-0.3, 0.05, 0.27], 0.009, K3.steel);
  M.rod([-0.36, 0.05, 0.27], [-0.24, 0.05, 0.27], 0.007, K3.steel, { roll: 0.3 });
  if (!hurt) {
    // tools left out: hammer, spanner, saw
    M.rod([-0.05, 0.012, 0.02], [0.13, 0.012, 0.09], 0.011, K3.leg);
    M.box([0.14, 0.02, 0.095], [0.022, 0.03, 0.08], C.darkMetal, { yaw: 1.2, bevel: 0.004 });
  }
  M.box([0.2, 0.006, -0.03], [0.14, 0.012, 0.022], K3.steel, { yaw: -0.5, bevel: 0.003 });
  M.cyl([0.265, 0.006, -0.065], 0.02, 0.012, K3.steel);
  M.box([-0.12, 0.006, -0.07], [0.24, 0.01, 0.06], K3.steel, { yaw: 0.12, paint: (u, v, f) => (f === 2 && v > 0.9 ? [90, 90, 94] : null) });
  M.box([0.02, 0.012, -0.08], [0.07, 0.022, 0.075], K3.leg, { yaw: 0.12, bevel: 0.006 });
  M.pop();
  // the red toolbox on the shelf
  M.slab(-0.3, 0.1, -0.08, -0.08, 0.2, 0.06, C.colaRed, { bevel: 0.006 });
  M.slab(-0.305, 0.2, -0.085, -0.075, 0.215, 0.065, C.colaRed, { bevel: 0.004 });
  M.rod([-0.24, 0.225, -0.01], [-0.14, 0.225, -0.01], 0.008, C.black);
  // the pegboard and what hangs on it, with the painted shadows of what does not
  M.push([0, 0, 0], 0, 0, wreck ? -0.1 : 0);
  M.slab(-W / 2 + 0.02, top + 0.01, -0.13, W / 2 - 0.02, 0.84, -0.115, K3.peg, {
    fixed: true,
    paint: (u, v, f) => {
      if (f !== 4) return null;
      if ((u * 40) % 1 < 0.22 && (v * 20) % 1 < 0.22) return [60, 42, 28];
      if (u > 0.62 && u < 0.66 && v > 0.2 && v < 0.62) return [230, 226, 214];       // the missing screwdriver
      if (u > 0.7 && u < 0.76 && v > 0.22 && v < 0.6 && (u < 0.705 || u > 0.755 || v < 0.23)) return [230, 226, 214];
      return null;
    },
  });
  const pz = -0.108;
  // hand saw
  M.box([-0.27, 0.66, pz], [0.1, 0.2, 0.01], K3.steel, { roll: 0.1 });
  M.box([-0.28, 0.8, pz + 0.004], [0.08, 0.07, 0.016], K3.leg, { roll: 0.1, bevel: 0.006 });
  // screwdrivers
  [K3.handleRed, K3.handleYel, K3.handleBlue].forEach((hm, i) => {
    if (hurt && i === 1) return;
    const x = -0.1 + i * 0.05;
    M.cyl([x, 0.74, pz + 0.01], 0.012, 0.06, hm);
    M.rod([x, 0.71, pz + 0.01], [x, 0.6 - i * 0.02, pz + 0.01], 0.005, K3.steel);
  });
  // spanners, big to small
  for (let i = 0; i < 3; i++) M.box([0.08 + i * 0.045, 0.66 + i * 0.01, pz + 0.004], [0.022, 0.16 - i * 0.03, 0.01], K3.steel, { bevel: 0.003 });
  // extension cord coiled on a hook
  M.cyl([0.3, 0.64, pz + 0.02], 0.065, 0.03, K3.cord, { axis: 'z' });
  M.cyl([0.3, 0.64, pz + 0.026], 0.035, 0.03, K3.peg, { axis: 'z' });
  M.pop();
  // the clamp lamp on the right upright
  const dangle = hurt;
  M.rod([0.4, 0.84, -0.14], [0.36, 0.88, -0.06], 0.008, C.darkMetal);
  if (dangle && !wreck) {
    M.rod([0.36, 0.88, -0.06], [0.33, 0.62, 0.02], 0.005, C.black);
    M.cone([0.33, 0.58, 0.02], 0.055, 0.02, 0.07, K3.lampShade, { roll: 0.5 });
    M.sph([0.34, 0.55, 0.02], 0.02, K3.bulb);
  } else if (!wreck) {
    M.rod([0.36, 0.88, -0.06], [0.3, 0.82, 0.02], 0.008, C.darkMetal);
    M.cone([0.3, 0.78, 0.04], 0.06, 0.02, 0.07, K3.lampShade, { pitch: 0.35 });
    M.sph([0.3, 0.755, 0.05], 0.022, K3.bulb);
  }
  if (wreck) {
    // on the floor now
    M.rod([-0.1, 0.012, 0.3], [0.08, 0.012, 0.36], 0.011, K3.leg, { keep: true });
    M.box([0.09, 0.02, 0.365], [0.022, 0.03, 0.08], C.darkMetal, { yaw: 1.3, keep: true });
    M.cone([0.3, 0.03, 0.26], 0.055, 0.02, 0.07, K3.lampShade, { roll: 1.5, yaw: 0.4, keep: true });
    M.slab(-0.34, 0, 0.2, -0.12, 0.1, 0.34, C.colaRed, { yaw: 0.3, bevel: 0.006, keep: true });
  }
}

/** Diesel generator on skids: engine, radiator, alternator, tank, stack, controls. */
function generator(M) {
  const wreck = M.wreck, hurt = M.hurt, dr = K3.drab, fx = { fixed: true };
  // the skids and their cross members
  for (const s of [-1, 1]) {
    M.slab(-0.37, 0, s * 0.14 - 0.025, 0.37, 0.04, s * 0.14 + 0.025, C.darkMetal, { bevel: 0.006, ...fx });
    for (const e of [-1, 1]) M.cyl([e * 0.37, 0.02, s * 0.14], 0.02, 0.05, C.darkMetal, { axis: 'z' });
  }
  for (const x of [-0.26, 0, 0.24]) M.slab(x - 0.02, 0.03, -0.16, x + 0.02, 0.05, 0.16, C.darkMetal, fx);
  // radiator at the right end, a grille to the room
  M.slab(0.24, 0.05, -0.13, 0.33, 0.36, 0.13, dr, {
    bevel: 0.008, ...fx,
    paint: (u, v, f) => {
      if (f === 0 && u > 0.08 && u < 0.92 && v > 0.08 && v < 0.9) return (v * 36) % 1 < 0.45 ? [24, 26, 20] : [70, 76, 50];
      if (f === 2 && Math.hypot(u - 0.5, v - 0.3) < 0.12) return [40, 40, 34];
      return null;
    },
  });
  M.cyl([0.29, 0.37, -0.05], 0.022, 0.02, C.darkMetal);
  // engine block, rocker cover with fins, air cleaner
  M.slab(-0.1, 0.05, -0.11, 0.24, 0.28, 0.11, dr, {
    bevel: 0.01, ...fx,
    paint: (u, v, f) => {
      if (f !== 4) return null;
      if (u > 0.05 && u < 0.95 && v > 0.1 && v < 0.42) {
        return txt('DANGER', u, v, 0.1, 0.15, 0.9, 0.37) ? [244, 240, 232] : [190, 30, 24];
      }
      if (u > 0.05 && u < 0.95 && v > 0.44 && v < 0.6) return txt('440V', u, v, 0.3, 0.46, 0.7, 0.58) ? [20, 20, 20] : [236, 230, 210];
      return null;
    },
  });
  M.slab(-0.07, 0.28, -0.08, 0.2, 0.33, 0.08, K3.drabDark, { bevel: 0.01, paint: (u, v, f) => (f === 4 || f === 5 ? ((u * 18) % 1 < 0.35 ? [40, 44, 30] : null) : null) });
  M.cyl([0.14, 0.36, -0.02], 0.045, 0.05, K3.drabDark);
  M.cyl([0.14, 0.39, -0.02], 0.05, 0.008, C.darkMetal);
  // alternator at the left end
  M.cyl([-0.22, 0.17, 0], 0.115, 0.24, dr, {
    axis: 'x', ...fx,
    paint: (u, v, f, lx, ly, lz) => (f < 2 && Math.abs(ly) > 0.03 && Math.abs(ly) < 0.1 && (Math.atan2(lz, lx) * 5 + 20) % 1 < 0.35 ? [30, 32, 24] : null),
  });
  M.cyl([-0.345, 0.17, 0], 0.07, 0.015, C.darkMetal, { axis: 'x' });
  // fuel tank across the back, strapped down
  if (!wreck) {
    M.cyl([0.03, 0.39, -0.06], 0.06, 0.34, K3.drabDark, { axis: 'x' });
    for (const x of [-0.08, 0.14]) M.slab(x - 0.012, 0.32, -0.125, x + 0.012, 0.455, 0.005, C.darkMetal);
    if (!hurt) M.cyl([-0.1, 0.455, -0.06], 0.018, 0.02, C.black);
  } else {
    M.cyl([0.05, 0.43, -0.1], 0.06, 0.34, K3.drabDark, { axis: 'x', roll: 0.35, yaw: 0.2, keep: true });
  }
  // exhaust stack, muffler, rain cap
  if (!wreck) {
    M.cyl([0.06, 0.355, 0.06], 0.036, 0.07, K3.exhaust);
    M.cyl([0.06, 0.41, 0.06], 0.014, 0.05, K3.exhaust);
    if (!hurt) M.cyl([0.06, 0.438, 0.066], 0.02, 0.006, K3.exhaust, { pitch: 0.4 });
  } else {
    M.cyl([0.1, 0.036, 0.26], 0.036, 0.11, K3.exhaust, { axis: 'x', yaw: 0.6, keep: true });
  }
  // the control box over the alternator: gauges, switches, a start button
  M.push([-0.22, 0.3, 0.02], wreck ? 0.3 : 0, 0, wreck ? 0.5 : 0);
  M.slab(-0.12, 0, -0.07, 0.1, 0.15, 0.07, K3.drabDark, { bevel: 0.008 });
  for (let i = 0; i < 3; i++) {
    const x = -0.08 + i * 0.06;
    M.cyl([x, 0.105, 0.072], 0.024, 0.008, C.chrome, { axis: 'z' });
    const broken = (hurt && i === 1) || wreck;
    M.cyl([x, 0.105, 0.077], 0.02, 0.004, broken ? C.glass : K.gaugeFace, {
      axis: 'z',
      paint: broken ? null : (u, v, f, lx, ly, lz) => {
        const X = lx / 0.02, Y = -lz / 0.02, an = Math.atan2(X, Y), n = -0.8 + i * 0.7;
        if (Math.abs(an - n) < 0.25 && Math.hypot(X, Y) < 0.8) return [20, 20, 20];
        if (Math.hypot(X, Y) > 0.7 && an > 0.9 && an < 2) return [200, 30, 24];
        return null;
      },
    });
  }
  for (let i = 0; i < 3; i++) M.rod([-0.08 + i * 0.03, 0.04, 0.07], [-0.08 + i * 0.03, 0.05, 0.09], 0.005, C.chrome);
  M.cyl([0.06, 0.045, 0.074], 0.016, 0.012, K.btnRed, { axis: 'z' });
  M.pop();
  if (hurt) M.sph([0.1, 0.001, 0.2], [0.14, 0.002, 0.08], K3.diesel, { keep: true });
}

// ------------------------------------------------------------------ stores, again

/** A wooden cable drum on its side: two plank flanges, black cable wound on. */
function spool(M) {
  const R = 0.23, hx = 0.16, wreck = M.wreck, hurt = M.hurt;
  const flange = (x, side) => {
    M.cyl([x, R, 0], R, 0.03, K3.reel, {
      axis: 'x', fixed: true,
      paint: (u, v, f, lx, ly, lz) => {
        if (f >= 2) return null;
        // planks across, and the stencil on the outside face
        const out = Math.sign(-ly) === side;
        if ((lz * 11 + 20) % 1 < 0.06) return [100, 70, 40];
        if (!out) return null;
        const su = side > 0 ? (R - lz) / (2 * R) : (lz + R) / (2 * R), sv = (R - lx) / (2 * R);
        if (txt('BELL', su, sv, 0.28, 0.2, 0.72, 0.33)) return [40, 30, 22];
        if (txt('NO 12', su, sv, 0.3, 0.7, 0.7, 0.8)) return [40, 30, 22];
        if (hurt && Math.abs(lz - 0.08) < 0.03 && lx > 0) return [30, 22, 16];
        return null;
      },
    });
    // a batten across the outside, the arbor hole
    M.box([x + side * 0.02, R, 0], [0.012, 0.05, 0.38], K3.reel, { bevel: 0.004 });
    M.cyl([x + side * 0.024, R, 0], 0.035, 0.012, C.darkMetal, { axis: 'x' });
    M.cyl([x + side * 0.026, R, 0], 0.02, 0.014, C.black, { axis: 'x' });
    for (const [a, b] of [[0.17, 0.12], [-0.17, -0.12]]) M.cyl([x + side * 0.02, R + a, b], 0.012, 0.012, C.darkMetal, { axis: 'x' });
  };
  if (wreck) {
    // one flange burst off; the drum fell over onto the other, the cable spilling off it
    M.cyl([0.24, 0.232, -0.2], R, 0.03, K3.reel, { axis: 'x', roll: -0.26, yaw: 0.5, keep: true });
    M.push([R - 0.08, hx + 0.015, -0.04], 0, 0, Math.PI / 2);
    flange(-hx, -1);
    M.cyl([0, R, 0], 0.16, 2 * hx - 0.03, K3.cable, { axis: 'x', fixed: true, paint: (u, v, f, lx, ly, lz) => (f < 2 && (ly * 42 + 20) % 1 < 0.28 ? [14, 14, 16] : null) });
    M.cyl([hx - 0.01, R, 0], 0.12, 0.012, K3.reel, { axis: 'x' });
    M.cyl([hx - 0.004, R, 0], 0.03, 0.006, C.black, { axis: 'x' });
    M.pop();
    const pts = [[-0.1, 0.3, 0.1], [-0.16, 0.14, 0.2], [-0.2, 0.012, 0.26], [0.0, 0.012, 0.36], [0.2, 0.012, 0.34], [0.34, 0.012, 0.42]];
    for (let i = 0; i < pts.length - 1; i++) M.rod(pts[i], pts[i + 1], 0.012, K3.cable, { keep: true });
    return;
  }
  flange(-hx, -1);
  flange(hx, 1);
  M.cyl([0, R, 0], hurt ? 0.15 : 0.175, 2 * hx - 0.03, K3.cable, {
    axis: 'x', fixed: true,
    paint: (u, v, f, lx, ly, lz) => ((ly * 42 + Math.atan2(lz, lx) * 0.16 + 20) % 1 < 0.28 ? [14, 14, 16] : null),
  });
  // the loose end over the top and down to the floor
  const pts = hurt ? [[0.05, 0.38, 0.1], [0.08, 0.2, 0.26], [0.1, 0.012, 0.32], [-0.1, 0.012, 0.42], [-0.28, 0.012, 0.34]]
    : [[0.06, 0.4, 0.07], [0.08, 0.3, 0.2], [0.1, 0.12, 0.26], [0.12, 0.012, 0.28]];
  for (let i = 0; i < pts.length - 1; i++) M.rod(pts[i], pts[i + 1], 0.011, K3.cable);
}

// ------------------------------------------------------------------ chapel, again

/** Church lectern: plinth, carved column, a slanted desk with a big open book, a brass lamp. */
function lectern(M) {
  const wreck = M.wreck, hurt = M.hurt, w = K.pewWood;
  M.slab(-0.16, 0, -0.14, 0.16, 0.03, 0.14, K.pewDark, { bevel: 0.008, fixed: true });
  M.slab(-0.12, 0.03, -0.1, 0.12, 0.055, 0.1, w, { bevel: 0.006, fixed: true });
  M.push([0, 0.055, 0], 0, wreck ? 0.1 : 0, wreck ? -0.18 : 0);
  M.slab(-0.065, 0, -0.055, 0.065, 0.33, 0.055, w, {
    bevel: 0.008, fixed: true,
    paint: (u, v, f) => {
      if (f !== 4 && f !== 5) return null;
      if (u > 0.14 && u < 0.86 && v > 0.08 && v < 0.9 && (u < 0.2 || u > 0.8 || v < 0.13 || v > 0.85)) return [66, 38, 20];
      if ((Math.abs(u - 0.5) < 0.06 && v > 0.2 && v < 0.7) || (Math.abs(v - 0.34) < 0.03 && Math.abs(u - 0.5) < 0.2)) return [206, 166, 74, 2];
      return null;
    },
  });
  M.slab(-0.08, 0.3, -0.07, 0.08, 0.33, 0.07, K.pewDark, { bevel: 0.006 });
  M.pop();
  // the desk: its case, then the sloped board, lip and book
  if (wreck) M.push([0.06, 0.11, 0.28], 0.5, 1.2, 0.1);
  else M.push([0, 0.39, 0]);
  M.slab(-0.15, 0, -0.1, 0.15, 0.06, 0.1, w, { bevel: 0.006 });
  M.push([0, 0.075, 0], 0, 0.38);
  M.slab(-0.18, -0.015, -0.14, 0.18, 0.015, 0.14, w, { bevel: 0.006, fixed: true });
  M.slab(-0.18, 0.015, 0.125, 0.18, 0.035, 0.145, K.pewDark, { bevel: 0.004 });
  if (!wreck) {
    M.slab(-0.14, 0.015, -0.11, 0.14, 0.025, 0.12, K3.cover, { bevel: 0.003 });
    if (hurt) {
      // shut and knocked askew
      M.box([0.03, 0.04, 0.0], [0.15, 0.03, 0.2], K3.cover, { yaw: 0.35, bevel: 0.006 });
    } else {
      for (const s of [-1, 1]) {
        M.box([s * 0.066, 0.034, 0.005], [0.13, 0.018, 0.21], K3.page, {
          roll: s * 0.1,
          paint: (u, v, f) => (f === 2 && u > 0.12 && u < 0.88 && v > 0.1 && v < 0.9 && (v * 22) % 1 < 0.45 && hh(Math.floor(u * 9), Math.floor(v * 22), s + 3) > 0.12 ? [110, 100, 88] : f === 2 && v > 0.12 && v < 0.2 && u > 0.2 && u < 0.4 && s < 0 ? [170, 30, 30] : null),
        });
      }
      M.slab(-0.008, 0.02, 0.1, 0.008, 0.028, 0.2, K3.ribbon);
    }
  }
  M.pop();
  // the brass lamp on the high edge
  if (!wreck) {
    const bend = hurt ? 0.07 : 0;
    M.cyl([0.13, 0.12, -0.11], 0.022, 0.012, C.brass);
    M.rod([0.13, 0.12, -0.11], [0.12, 0.2 - bend, -0.08], 0.007, C.brass);
    M.rod([0.12, 0.2 - bend, -0.08], [0.04, 0.2 - bend * 1.6, -0.02], 0.007, C.brass);
    M.cyl([0.02, 0.19 - bend * 1.6, -0.01], 0.024, 0.13, C.brass, { axis: 'x', yaw: 0.3 });
    M.box([0.02, 0.172 - bend * 1.6, -0.01], [0.1, 0.008, 0.02], K3.bulb, { yaw: 0.3 });
  }
  M.pop();
  if (wreck) {
    // the book face down, the lamp in pieces
    M.box([-0.14, 0.02, 0.26], [0.28, 0.04, 0.2], K3.cover, { yaw: -0.4, roll: 0.06, bevel: 0.006, keep: true });
    M.box([-0.12, 0.012, 0.25], [0.26, 0.024, 0.19], K3.page, { yaw: -0.4, keep: true });
    M.rod([0.2, 0.01, -0.2], [0.3, 0.01, -0.05], 0.007, C.brass, { keep: true });
  }
}

// ------------------------------------------------------------------ chapel, last

const K4 = {
  iron: mat('metal', [58, 54, 56], { gloss: 0.35, rust: 0.25 }),
  taper: mat('plastic', [246, 238, 212], { gloss: 0.3 }),
  endgrain: mat('wood', [190, 146, 98], { grain: 0.5 }),
  blood: [110, 10, 10],
  pool: mat('plastic', [96, 8, 8], { gloss: 0.8 }),
  meat: mat('flesh', [176, 44, 42]),
  fat: mat('flesh', [236, 214, 186]),
  bone: mat('bone', [230, 222, 196]),
  pig: mat('flesh', [226, 156, 146]),
  pigDark: mat('flesh', [150, 70, 70]),
  sausage: mat('flesh', [156, 84, 66]),
  galv: mat('metal', [150, 156, 160], { gloss: 0.5 }),
  rackBody: mat('paint', [196, 190, 172], { wear: 0.3 }),
  rackBlue: mat('paint', [64, 86, 124], { wear: 0.4 }),
  reel: mat('plastic', [60, 70, 90], { gloss: 0.6 }),
  tape: mat('plastic', [96, 62, 40], { gloss: 0.4 }),
  lampOff: mat('plastic', [50, 44, 40]),
  lamps: [mat('light', [255, 60, 40]), mat('light', [80, 255, 100]), mat('light', [255, 186, 50])],
  greyCase: mat('plastic', [150, 150, 146]),
  beigeCase: mat('plastic', [196, 184, 150]),
  pallet: mat('wood', [178, 142, 92], { grain: 1.3 }),
  palletOld: mat('wood', [150, 118, 78], { grain: 1.3 }),
  strap: mat('fabric', [220, 176, 40]),
  grain: mat('fabric', [210, 190, 130]),
  drumBlue: mat('paint', [44, 72, 140], { wear: 0.6, rust: 0.25 }),
  drumYellow: mat('paint', [214, 176, 40], { wear: 0.6, rust: 0.25 }),
};

/** Wrought-iron floor candelabra: tripod feet, a knotted stem, five lit tapers. */
function candelabra(M) {
  const wreck = M.wreck, hurt = M.hurt;
  if (wreck) M.push([-0.36, 0.03, 0.02], 1.35, 1.49, 0);
  // tripod: three splayed legs on ball feet, a collar
  for (let k = 0; k < 3; k++) {
    const a = k * TAU / 3 + Math.PI;
    const fx = Math.sin(a) * 0.17, fz = Math.cos(a) * 0.17;
    M.rod([0, 0.13, 0], [fx * 0.6, 0.06, fz * 0.6], 0.011, K4.iron);
    M.rod([fx * 0.6, 0.06, fz * 0.6], [fx, 0.02, fz], 0.011, K4.iron);
    M.sph([fx, 0.02, fz], 0.02, K4.iron);
  }
  M.cyl([0, 0.13, 0], 0.024, 0.04, K4.iron);
  M.rod([0, 0.13, 0], [0, 0.56, 0], 0.012, K4.iron, { fixed: true });
  M.sph([0, 0.32, 0], [0.026, 0.04, 0.026], K4.iron);
  M.sph([0, 0.52, 0], 0.024, K4.iron);
  // five arms fanned left to right, cups, tapers, flames
  const arms = [[-0.2, 0.55], [-0.1, 0.58], [0, 0.61], [0.1, 0.58], [0.2, 0.55]];
  arms.forEach(([x, cy], i) => {
    let tx = x, ty = cy;
    if (hurt && !wreck && i === 4) { tx = 0.22; ty = 0.47; }
    if (x !== 0) {
      M.rod([0, 0.52, 0], [x * 0.9, 0.5, 0], 0.009, K4.iron);
      M.rod([x * 0.9, 0.5, 0], [tx, ty, 0], 0.009, K4.iron);
      M.sph([x * 0.55, 0.49, 0], [0.018, 0.012, 0.012], K4.iron);
    } else M.rod([0, 0.56, 0], [0, cy, 0], 0.012, K4.iron);
    M.cyl([tx, ty + 0.004, 0], 0.034, 0.008, K4.iron);
    M.cyl([tx, ty + 0.018, 0], 0.017, 0.022, K4.iron);
    const h = 0.14 - Math.abs(x) * 0.12;
    if (wreck && i % 2) return;
    M.cyl([tx, ty + 0.028 + h / 2, 0], 0.014, h, K4.taper, { keep: true });
    M.sph([tx + 0.012, ty + 0.028 + h - 0.02, 0.004], [0.007, 0.018, 0.007], K4.taper);
    const top = ty + 0.028 + h;
    M.cyl([tx, top + 0.005, 0], 0.004, 0.012, K2.wick);
    if (wreck || (hurt && (i === 1 || i === 4))) return;
    M.sph([tx, top + 0.018, 0], [0.012, 0.016, 0.012], K2.flameCore);
    M.cone([tx, top + 0.042, 0], 0.011, 0.001, 0.034, K2.flame);
  });
  if (wreck) {
    M.pop();
    // the tapers that came out, and one still burning on the floor
    M.cyl([0.2, 0.014, 0.32], 0.014, 0.12, K4.taper, { axis: 'x', yaw: 0.8, keep: true });
    M.cyl([-0.22, 0.014, 0.26], 0.014, 0.1, K4.taper, { axis: 'x', yaw: -0.4, keep: true });
    M.sph([-0.27, 0.02, 0.29], [0.012, 0.016, 0.012], K2.flameCore, { keep: true });
    M.cone([-0.27, 0.044, 0.29], 0.011, 0.001, 0.034, K2.flame, { keep: true });
  }
}

// ------------------------------------------------------------------ the meat locker

/** Butcher's block: scarred end-grain top soaked in blood, steel legs, a cleaver in it, meat. */
function butcher(M) {
  const wreck = M.wreck, hurt = M.hurt, pig = M.variant === 1;
  const T = 0.3;
  const bloodTop = (u, v) => {
    const b = fb(u * 5 + 3, v * 5, 11);
    if (b > 0.6) return [K4.blood[0] * (1.4 - b), K4.blood[1], K4.blood[2], 2.5];
    if (hh(Math.floor(u * 90), Math.floor(v * 6), 3) < 0.05 || hh(Math.floor(u * 8), Math.floor(v * 70), 5) < 0.05) return [80, 50, 34];
    return (Math.floor(u * 12) + Math.floor(v * 9)) & 1 ? [178, 136, 90] : null;
  };
  const bloodSide = (u, v) => {
    const k = Math.floor(u * 26), run = hh(k, 1, 7);
    if (run < 0.4 && v < 0.15 + run * 1.6 && (u * 26) % 1 < 0.55) return [K4.blood[0], K4.blood[1], K4.blood[2], 2];
    return (u * 12) % 1 < 0.05 ? [120, 86, 54] : null;
  };
  // steel legs, a shelf with a bucket, a rail of hooks along the front
  const sag = wreck ? 0.36 : 0;
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    if (wreck && sx === 1 && sz === 1) { M.rod([0.3, 0.012, 0.3], [0.12, 0.012, 0.42], 0.014, K3.steel, { keep: true }); continue; }
    M.slab(sx * 0.25 - 0.016, 0, sz * 0.15 - 0.016, sx * 0.25 + 0.016, T - 0.08, sz * 0.15 + 0.016, K3.steel, { bevel: 0.004, fixed: true });
  }
  M.slab(-0.26, 0.06, -0.16, 0.26, 0.072, 0.16, K3.steel, { bevel: 0.003, fixed: true });
  if (!wreck) {
    M.cyl([0.12, 0.13, 0], 0.07, 0.11, K4.galv);
    M.cyl([0.12, 0.183, 0], 0.062, 0.004, K4.pool);
  } else {
    M.cyl([0.1, 0.06, 0.3], 0.07, 0.11, K4.galv, { axis: 'x', yaw: 0.9, keep: true });
  }
  // the block
  M.push([0, T - 0.08, 0], 0, wreck ? 0.14 : 0, wreck ? -sag : 0);
  M.slab(-0.29, 0, -0.19, 0.29, 0.08, 0.19, K4.endgrain, {
    bevel: 0.01, fixed: true,
    paint: (u, v, f) => (f === 2 ? bloodTop(u, v) : f === 3 ? null : bloodSide(u, v)),
  });
  // the hook rail under the front edge
  M.rod([-0.26, -0.02, 0.21], [0.26, -0.02, 0.21], 0.007, K3.steel);
  for (const x of [-0.25, 0.25]) M.slab(x - 0.008, -0.03, 0.18, x + 0.008, 0, 0.215, K3.steel);
  // a string of sausages and a boning knife on S-hooks
  if (!wreck) {
    M.rod([-0.14, -0.02, 0.215], [-0.14, -0.05, 0.22], 0.004, K3.steel);
    for (let i = 0; i < 4; i++) M.sph([-0.14 + Math.sin(i * 1.3) * 0.012, -0.08 - i * 0.045, 0.222], [0.018, 0.026, 0.018], K4.sausage);
    M.rod([0.08, -0.02, 0.215], [0.08, -0.05, 0.22], 0.004, K3.steel);
    M.slab(0.07, -0.08, 0.214, 0.09, -0.05, 0.23, K.pewDark);
    M.slab(0.074, -0.19, 0.218, 0.086, -0.08, 0.227, K3.steel, { paint: (u, v) => (v > 0.7 ? [140, 20, 20] : null) });
  }
  // meat on the block: a joint with its fat cap and bone, or less of it
  const mx = pig ? 0.12 : -0.1;
  if (!wreck) {
    const s = hurt ? 0.6 : 1;
    M.sph([mx, 0.08 + 0.04 * s, 0.02], [0.1 * s, 0.045 * s, 0.07 * s], K4.meat, {
      paint: (u, v, f, lx, ly, lz) => (Math.sin(lx * 90 + Math.sin(lz * 60) * 2) > 0.85 ? [236, 206, 190] : null),
    });
    M.sph([mx - 0.01, 0.08 + 0.06 * s, 0.0], [0.09 * s, 0.03 * s, 0.06 * s], K4.fat);
    M.rod([mx + 0.08 * s, 0.08 + 0.04 * s, 0.02], [mx + 0.14 * s, 0.08 + 0.05 * s, 0.03], 0.016 * s, K4.bone);
    M.sph([mx + 0.145 * s, 0.08 + 0.05 * s, 0.03], [0.022 * s, 0.02 * s, 0.024 * s], K4.bone);
  }
  if (pig && !wreck) pigHead(M, [-0.12, 0.08, 0.0], 0.2);
  // the cleaver, stuck in, or fallen flat
  if (!hurt) {
    M.push([0.02, 0.08, 0.09], 0.35, 0, -0.08);
    M.slab(-0.05, -0.012, -0.004, 0.05, 0.055, 0.004, K3.steel, { paint: (u, v) => (v > 0.55 && hh(Math.floor(u * 16), Math.floor(v * 8), 9) < 0.6 ? [130, 16, 14] : null) });
    M.rod([0.05, 0.045, 0], [0.13, 0.07, 0], 0.011, K.pewDark);
    M.pop();
  } else if (!wreck) {
    M.box([0.03, 0.086, 0.12], [0.1, 0.008, 0.066], K3.steel, { yaw: 0.2 });
    M.rod([0.08, 0.09, 0.12], [0.16, 0.09, 0.14], 0.011, K.pewDark);
  }
  M.pop();
  // blood on the floor
  M.sph([0.02, 0.001, 0.22], [hurt ? 0.2 : 0.14, 0.002, hurt ? 0.12 : 0.07], K4.pool, { keep: true });
  if (wreck) {
    M.sph([-0.2, 0.05, 0.32], [0.1, 0.045, 0.07], K4.meat, { yaw: 0.7, keep: true });
    M.rod([-0.12, 0.05, 0.36], [-0.06, 0.05, 0.4], 0.016, K4.bone, { keep: true });
    if (pig) pigHead(M, [0.28, 0.0, 0.26], -0.9, 1.2);
    M.box([0.2, 0.012, 0.44], [0.1, 0.008, 0.066], K3.steel, { yaw: 0.8, keep: true });
  }
}
/** A pig's head, neck down on whatever it is put on. */
function pigHead(M, c, yaw, roll = 0) {
  M.push(c, yaw, 0, roll);
  M.cyl([0, 0.006, 0], 0.062, 0.012, K4.meat, { keep: true });
  M.sph([0, 0.065, 0], [0.07, 0.062, 0.072], K4.pig, { keep: true });
  M.sph([0, 0.045, 0.05], [0.058, 0.04, 0.05], K4.pig, { keep: true });
  M.cyl([0, 0.05, 0.1], 0.028, 0.03, K4.pig, {
    axis: 'z', keep: true,
    paint: (u, v, f, lx, ly, lz) => (f === 2 && (Math.hypot(lx - 0.01, lz) < 0.007 || Math.hypot(lx + 0.01, lz) < 0.007) ? [60, 20, 24] : f === 2 ? [236, 170, 160] : null),
  });
  for (const s of [-1, 1]) {
    M.sph([s * 0.05, 0.12, 0.0], [0.03, 0.045, 0.012], K4.pig, { roll: -s * 0.6, pitch: 0.5 });
    M.sph([s * 0.036, 0.09, 0.062], [0.014, 0.004, 0.006], K4.pigDark, { roll: s * 0.3 });
  }
  M.sph([0.012, 0.022, 0.082], [0.016, 0.006, 0.014], K4.pigDark);
  M.pop();
}

// ------------------------------------------------------------------ the computer room

/** A tape reel face on: blue plastic flange with windows onto the brown tape pack. */
function reelPaint(full) {
  return (u, v, f, lx, ly, lz) => {
    if (f < 2) return null;
    const r = Math.hypot(lx, lz), a = Math.atan2(lx, lz);
    if (r < 0.018) return [170, 174, 180];
    if (r < 0.024) return [30, 30, 36];
    const win = r > 0.03 && r < 0.074 && ((a * 3 / TAU + 10) % 1) < 0.62;
    if (win) return full && r < 0.066 ? [96, 62, 40] : r < 0.034 ? [96, 62, 40] : [26, 26, 32];
    return null;
  };
}

/** 1980s tape drive cabinet: two reels behind a glass door, banks of lamps, vents, cables out the top. */
function serverrack(M) {
  const W = 0.44, D = 0.34, H = 0.86, wreck = M.wreck, hurt = M.hurt, z1 = D / 2;
  const body = K4.rackBody, blue = K4.rackBlue;
  M.slab(-W / 2 + 0.01, 0, -D / 2 + 0.01, W / 2 - 0.01, 0.03, D / 2 - 0.02, C.darkMetal, { fixed: true });
  M.slab(-W / 2, 0.03, -D / 2, W / 2, H, D / 2, body, {
    bevel: 0.01, fixed: true,
    paint: (u, v, f) => {
      if ((f === 0 || f === 1) && u > 0.15 && u < 0.85 && ((v > 0.62 && v < 0.9) || (v > 0.1 && v < 0.3)) && (v * 90) % 1 < 0.4) return [40, 40, 40];
      if (f === 4 && v > 0.97) return [60, 60, 64];
      if (wreck && fb(u * 4, v * 6, 21) > 0.62) return [26, 22, 20];
      return null;
    },
  });
  // the blue band with the maker's name
  M.slab(-W / 2 + 0.01, H - 0.07, z1, W / 2 - 0.01, H - 0.02, z1 + 0.006, blue, {
    paint: (u, v) => (txt('COMPUTRON', u, v, 0.08, 0.22, 0.62, 0.78) ? [236, 232, 220] : u > 0.7 && u < 0.92 && v > 0.3 && v < 0.7 ? [200, 50, 40] : null),
  });
  // the tape deck: dark panel, two reels, the head between them, vacuum columns under
  const dk = mat('paint', [40, 42, 48], { wear: 0.2 });
  M.slab(-W / 2 + 0.02, 0.46, z1 - 0.01, W / 2 - 0.02, H - 0.08, z1 + 0.002, dk, {
    paint: (u, v) => {
      if (v > 0.66 && v < 0.96 && ((u > 0.12 && u < 0.3) || (u > 0.7 && u < 0.88))) {
        const cu = u < 0.5 ? (u - 0.12) / 0.18 : (u - 0.7) / 0.18;
        const loop = 0.66 + 0.2 + (u < 0.5 ? 0.04 : -0.03);
        if (cu > 0.1 && cu < 0.9 && v < loop && v > loop - 0.03) return [96, 62, 40];
        return cu < 0.08 || cu > 0.92 ? [120, 124, 130] : [70, 80, 96];
      }
      return null;
    },
  });
  const reelOut = wreck ? 0 : 2;
  for (let k = 0; k < reelOut; k++) {
    const x = k ? 0.1 : -0.1;
    M.cyl([x, 0.7, z1 + 0.008], 0.082, 0.012, K4.reel, { axis: 'z', paint: reelPaint(!(hurt && k === 1)) });
  }
  M.slab(-0.03, 0.62, z1, 0.03, 0.66, z1 + 0.02, C.chrome, { bevel: 0.004 });
  if (!wreck) M.slab(-0.1, 0.632, z1 + 0.012, 0.1, 0.642, z1 + 0.016, K4.tape);
  // the glass door over the deck: just its frame, swung open in a wreck
  M.push([-W / 2 + 0.012, wreck ? 0.05 : 0, z1 + 0.012], wreck ? -0.9 : hurt ? -0.25 : 0, 0, wreck ? 0.2 : 0);
  const fr = C.chrome;
  M.slab(0, 0.45, 0, 0.012, H - 0.075, 0.012, fr);
  M.slab(W - 0.036, 0.45, 0, W - 0.024, H - 0.075, 0.012, fr);
  M.slab(0, H - 0.087, 0, W - 0.024, H - 0.075, 0.012, fr);
  M.slab(0, 0.45, 0, W - 0.024, 0.462, 0.012, fr);
  if (!wreck) M.box([0.3, 0.7, 0.006], [0.01, 0.16, 0.002], mat('light', [150, 160, 172]), { roll: 0.5 });
  M.pop();
  // the lamp panel: a bank of lit buttons in rows
  const rr = srand(hurt ? 57 : 31);
  M.slab(-W / 2 + 0.02, 0.33, z1, W / 2 - 0.02, 0.44, z1 + 0.008, dk);
  for (let row = 0; row < 3; row++) for (let c = 0; c < 8; c++) {
    const on = !wreck && rr() > (hurt ? 0.5 : 0.25);
    const m = on ? K4.lamps[(row + c * 2 + (rr() > 0.5 ? 1 : 0)) % 3] : K4.lampOff;
    M.slab(-0.17 + c * 0.044, 0.345 + row * 0.03, z1 + 0.008, -0.145 + c * 0.044, 0.365 + row * 0.03, z1 + 0.016, m);
  }
  // the lower door: vents, a key, and it hangs off a hinge when wrecked
  M.push([-W / 2 + 0.014, 0.3, z1], wreck ? -0.5 : 0, 0, wreck ? -0.3 : 0);
  M.slab(0, -0.26, 0, W - 0.028, 0.0, 0.01, body, {
    bevel: 0.005,
    paint: (u, v, f) => (f === 4 && u > 0.12 && u < 0.88 && ((v > 0.12 && v < 0.4) || (v > 0.6 && v < 0.88)) && (v * 50) % 1 < 0.45 ? [36, 36, 38] : null),
  });
  M.cyl([W - 0.07, -0.13, 0.014], 0.012, 0.008, C.chrome, { axis: 'z' });
  M.pop();
  // cable bundle out of the top and back to the wall
  const cols = [K.wire[4], K.wire[4], K.wire[2], K.wire[1], K.wire[4]];
  for (let i = 0; i < 5; i++) {
    const x = -0.08 + i * 0.03;
    if (wreck && i % 2) continue;
    M.rod([x, H - 0.01, -0.06], [x * 0.7, H + 0.05, -0.12], 0.01, cols[i]);
    M.rod([x * 0.7, H + 0.05, -0.12], [x * 0.6 + 0.02, H + 0.06, -0.22], 0.01, cols[i]);
  }
  if (wreck) {
    // a reel on the floor spewing tape
    M.cyl([0.18, 0.04, 0.34], 0.082, 0.012, K4.reel, { axis: 'z', pitch: 1.3, yaw: 0.5, paint: reelPaint(true), keep: true });
    M.rod([0.14, 0.02, 0.32], [0.0, 0.01, 0.4], 0.008, K4.tape, { keep: true });
    M.rod([0.0, 0.01, 0.4], [-0.14, 0.01, 0.3], 0.008, K4.tape, { keep: true });
    M.rod([-0.12, 0.36, 0.2], [-0.16, 0.12, 0.24], 0.007, K.wire[0], { keep: true });
  }
}

/** One old monitor, its origin at the middle of the bottom, screen toward +z. */
function monitor(M, s, m, scr) {
  M.slab(-s * 0.5, 0, -s * 0.36, s * 0.5, s * 0.8, s * 0.34, m, { bevel: 0.01 });
  M.slab(-s * 0.34, s * 0.07, -s * 0.84, s * 0.34, s * 0.66, -s * 0.36, m, {
    bevel: 0.016, paint: (u, v, f) => (f === 2 && (u * 14) % 1 < 0.4 && v > 0.2 && v < 0.8 ? [40, 40, 40] : null),
  });
  const lit = scr === 'lit', cracked = scr === 'cracked';
  M.slab(-s * 0.4, s * 0.12, s * 0.34, s * 0.36, s * 0.7, s * 0.36, lit || cracked ? C.screenGreen : scr === 'smashed' ? C.black : C.glass, {
    paint: lit ? terminal([0.8, 0.45, 0.7, 0.3, 0.6]) : cracked ? (u, v) => {
      const d = Math.abs((u - 0.6) * 0.8 - (v - 0.4)), e = Math.abs((u - 0.6) + (v - 0.4) * 0.6);
      if (d < 0.02 || (e < 0.02 && u > 0.6) || Math.hypot(u - 0.6, v - 0.4) < 0.05) return [220, 255, 230];
      return terminal([0.7, 0.4, 0.8, 0.5, 0.3])(u, v);
    } : null,
  });
  M.slab(s * 0.38, s * 0.1, s * 0.34, s * 0.46, s * 0.14, s * 0.37, lit || cracked ? mat('light', [120, 255, 120]) : C.black);
}
/** A keyboard, origin at the middle of its bottom. */
function keyboard(M, m) {
  M.slab(-0.15, 0, -0.05, 0.15, 0.022, 0.05, m, {
    bevel: 0.006,
    paint: (u, v, f) => (f === 2 && v > 0.15 && v < 0.9 && u > 0.04 && u < 0.96 && ((u * 26) % 1 < 0.2 || (v * 6) % 1 < 0.2) ? [70, 66, 58] : null),
  });
}

/** Old monitors dumped on each other, a keyboard on top, one still on. */
function crtstack(M) {
  const wreck = M.wreck, hurt = M.hurt;
  if (wreck) {
    // the pile slid apart across the floor
    M.push([-0.18, 0, 0.0], 0.4); monitor(M, 0.24, C.cream, 'smashed'); M.pop();
    M.push([0.2, 0.0, 0.05], -0.6, 0, 0); monitor(M, 0.2, K4.greyCase, 'dark'); M.pop();
    M.push([0.05, 0.1, 0.3], 0.3, 1.4, 0); monitor(M, 0.16, K4.beigeCase, 'dark'); M.pop();
    M.push([-0.2, 0.2, 0.0], 0.3, -0.2, 0.4); monitor(M, 0.14, C.black, 'dark'); M.pop();
    M.push([0.25, 0.01, 0.3], 1.9, 0, 0); keyboard(M, C.cream); M.pop();
    for (let i = 0; i < 3; i++) M.box([-0.1 + i * 0.08, 0.004, 0.25 + (i % 2) * 0.06], [0.04, 0.006, 0.03], C.glass, { yaw: i * 1.7, keep: true });
    return;
  }
  // bottom: a big terminal square on the floor
  M.push([-0.02, 0, -0.04], 0.12); monitor(M, 0.25, C.cream, 'dark'); M.pop();
  // on it, a grey one turned and tipped
  M.push([0.03, 0.2, -0.06], -0.45, 0, 0.08); monitor(M, 0.2, K4.greyCase, 'dark'); M.pop();
  // on that, a small beige one face down at a slant
  if (!hurt) { M.push([-0.04, 0.37, -0.02], 0.5, 0.55, -0.1); monitor(M, 0.15, K4.beigeCase, 'dark'); M.pop(); }
  else { M.push([-0.22, 0.0, 0.18], 1.2, 0, Math.PI / 2 - 0.05); monitor(M, 0.15, K4.beigeCase, 'dark'); M.pop(); }
  // on the floor at the front, leaning on the pile, the one that is still on
  M.push([0.2, 0.0, 0.14], -0.35, -0.12, 0); monitor(M, 0.18, C.black, hurt ? 'cracked' : 'lit'); M.pop();
  // the keyboard draped over the top, its cord hanging
  M.push([0.04, hurt ? 0.37 : 0.46, 0.05], 0.3, 0.5, 0.2); keyboard(M, C.cream); M.pop();
  M.rod([0.12, hurt ? 0.37 : 0.46, 0.06], [0.2, 0.24, 0.16], 0.006, K.wire[4]);
  M.rod([0.2, 0.24, 0.16], [0.24, 0.02, 0.26], 0.006, K.wire[4]);
}

// ------------------------------------------------------------------ stores, last

/** A plain four-way pallet. */
function palletBase(M) {
  const wreck = M.wreck, w = K4.pallet;
  for (const z of [-0.2, 0, 0.2]) M.slab(-0.28, 0, z - 0.035, 0.28, 0.014, z + 0.035, K4.palletOld, { bevel: 0.003, fixed: true });
  for (const x of [-0.25, 0, 0.25]) {
    M.slab(x - 0.025, 0.014, -0.23, x + 0.025, 0.064, 0.23, K4.palletOld, {
      bevel: 0.003, fixed: true,
      paint: (u, v, f) => ((f === 0 || f === 1) && ((u > 0.18 && u < 0.38) || (u > 0.62 && u < 0.82)) && v > 0.5 ? [30, 24, 18] : null),
    });
  }
  for (let k = 0; k < 6; k++) {
    const z = -0.2 + k * 0.08;
    if (wreck && k === 4) { M.box([0.1, 0.1, z + 0.02], [0.3, 0.016, 0.07], w, { roll: 0.5, keep: true }); continue; }
    M.slab(-0.28, 0.064, z - 0.032, 0.28, 0.08, z + 0.032, w, {
      bevel: 0.003, fixed: true,
      paint: (u, v, f) => (f === 2 && Math.abs(u - 0.5) < 0.01 || (f === 2 && (Math.abs(u - 0.06) < 0.012 || Math.abs(u - 0.94) < 0.012) && Math.abs(v - 0.5) < 0.2) ? [50, 44, 40] : null),
    });
  }
}
/** A burlap sack of flour lying flat, origin at its middle. */
function sack(M, c, yaw, word, m = K.bag3, o = {}) {
  M.push(c, yaw, o.pitch || 0, o.roll || 0);
  M.sph([0, 0, 0], [0.13, 0.058, 0.1], m, { keep: true });
  M.box([0, 0, 0], [0.2, 0.08, 0.15], m, {
    bevel: 0.03, keep: true,
    paint: word ? (u, v, f) => (f === 2 && txt(word, u, v, 0.14, 0.32, 0.86, 0.68) ? [60, 60, 110] : null) : null,
  });
  M.pop();
}

/** A pallet stacked with flour sacks (0) or two oil drums (1), strapped on. */
function pallet(M) {
  const wreck = M.wreck, hurt = M.hurt, D = 0.08;
  palletBase(M);
  if (M.variant === 1) {
    // two drums, a ratchet strap round both
    const drum = (c, m, word, o = {}) => {
      M.push(c, o.yaw || 0, o.pitch || 0, o.roll || 0);
      M.cyl([0, 0.19, 0], 0.13, 0.38, m, {
        fixed: true,
        paint: (u, v, f, lx, ly, lz) => {
          if (f === 2) return Math.hypot(lx - 0.07, lz + 0.03) < 0.018 || Math.hypot(lx + 0.07, lz + 0.03) < 0.012 ? [30, 30, 30] : Math.hypot(lx, lz) > 0.12 ? [70, 70, 70] : null;
          const [a, b] = wrapUV(lx, ly, lz, -0.75, 0.75, -0.05, 0.1);
          if (a > 0 && a < 1 && b > 0 && b < 1) return txt(word, a, b, 0.08, 0.2, 0.92, 0.8) ? [24, 24, 24] : [236, 232, 220];
          if (m === K4.drumYellow) { const t = trefoil(Math.atan2(lx, lz) * 0.13, ly + 0.1, 0.045); if (t) return t[0] > 200 ? null : t; }
          return null;
        },
      });
      for (const y of [0.005, 0.125, 0.255, 0.375]) M.cyl([0, y, 0], 0.134, 0.012, m);
      M.pop();
    };
    if (wreck) {
      drum([-0.1, 0.13, 0.38], K4.drumBlue, 'DIESEL', { yaw: 1.4, roll: Math.PI / 2 });
      drum([0.14, D, -0.02], K4.drumYellow, 'WASTE', { roll: 0.14 });
      M.sph([0.0, 0.001, 0.3], [0.22, 0.003, 0.12], K3.diesel, { keep: true });
      return;
    }
    drum([-0.14, D, 0], K4.drumBlue, 'DIESEL', { yaw: 0.3, roll: hurt ? 0.07 : 0 });
    drum([0.14, D, 0], K4.drumYellow, 'WASTE', { yaw: -0.2 });
    if (!hurt) {
      M.slab(-0.27, D + 0.24, 0.12, 0.27, D + 0.27, 0.136, K4.strap);
      M.slab(-0.27, D + 0.24, -0.136, 0.27, D + 0.27, -0.12, K4.strap);
      M.slab(-0.05, D + 0.23, 0.13, 0.05, D + 0.28, 0.16, C.chrome, { bevel: 0.006 });
    } else {
      M.slab(-0.27, D + 0.24, 0.12, 0.0, D + 0.27, 0.136, K4.strap);
      M.box([0.12, 0.004, 0.3], [0.3, 0.006, 0.03], K4.strap, { yaw: 0.4 });
      M.sph([0.0, 0.001, 0.3], [0.14, 0.003, 0.08], K3.diesel, { keep: true });
    }
    return;
  }
  // flour sacks, three layers crossed, straps over the top
  const words = ['FLOUR', 'US', 'SUGAR', 'FLOUR'];
  if (wreck) {
    sack(M, [-0.13, D + 0.058, -0.1], 0, 'FLOUR');
    sack(M, [0.13, D + 0.058, 0.1], 0.1, null, K.bag);
    sack(M, [0.3, 0.058, 0.3], 0.9, 'SUGAR', K.bag2);
    sack(M, [-0.3, 0.058, 0.32], -0.5, null);
    sack(M, [0.0, 0.06, 0.42], 1.4, 'FLOUR', K.bag, { roll: 0.2 });
    M.sph([0.05, 0.0, 0.3], [0.16, 0.02, 0.1], K4.grain, { keep: true });
    return;
  }
  let y = D + 0.058;
  for (const [x, z] of [[-0.13, -0.11], [0.13, -0.11], [-0.13, 0.11], [0.13, 0.11]]) sack(M, [x, y, z], 0, words[(x > 0 ? 1 : 0) + (z > 0 ? 2 : 0)], (x > 0) !== (z > 0) ? K.bag : K.bag3);
  y += 0.11;
  for (const [x, z] of [[-0.12, 0], [0.12, 0]]) sack(M, [x, y, z], Math.PI / 2 + (x > 0 ? 0.06 : -0.04), 'FLOUR', x > 0 ? K.bag3 : K.bag2);
  y += 0.105;
  if (!hurt) sack(M, [0.02, y, 0.02], 0.12, 'US', K.bag3);
  else M.sph([0.12, 0.0, 0.3], [0.16, 0.02, 0.1], K4.grain, { keep: true });
  // two yellow straps over it all, hugging the sacks
  const top = hurt ? D + 0.225 : D + 0.33;
  for (const x of [-0.09, 0.13]) {
    const P = hurt ? [[D, 0.216], [D + 0.105, 0.216], [D + 0.2, 0.15], [top, 0.1], [D + 0.1, 0.34], [0.006, 0.36]]
      : [[D, 0.216], [D + 0.105, 0.216], [D + 0.2, 0.15], [top, 0.08], [top, -0.08], [D + 0.2, -0.15], [D + 0.105, -0.216], [D, -0.216]];
    for (let i = 0; i < P.length - 1; i++) M.rod([x, P[i][0], P[i][1]], [x, P[i + 1][0], P[i + 1][1]], 0.009, K4.strap, { keep: true });
  }
}

// ------------------------------------------------------------------ the table

export const MODELS_WORKS = {
  console: { build: consoleM, front: 0.2, variants: 2 },
  pinball: { build: pinball, front: 0.3 },
  pew: { build: pew, front: 0.19, dirs: 8 },
  sandbags: { build: sandbags, front: 0.2, dirs: 8 },
  nosecone: { build: nosecone, front: 0.24 },
  candles: { build: candles, front: 0.1, dirs: 1 },
  gascyl: { build: gascyl, front: 0.04 },
  shelving: { build: shelving, front: 0.14 },
  workbench: { build: workbench, front: 0.18 },
  generator: { build: generator, front: 0.16 },
  spool: { build: spool, front: 0.2, dirs: 8 },
  lectern: { build: lectern, front: 0.14, dirs: 8 },
  candelabra: { build: candelabra, front: 0.1 },
  butcher: { build: butcher, front: 0.2, variants: 2 },
  serverrack: { build: serverrack, front: 0.17 },
  crtstack: { build: crtstack, front: 0.2 },
  pallet: { build: pallet, front: 0.23, variants: 2 },
};
