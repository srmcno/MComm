// propmodels.js - what the bunker's furniture is made of, piece by piece.
//
// Each model is a function of a Model builder (propstudio.js): it lays down
// boxes, cylinders, cones and spheres in the prop's own space (x its right,
// y up, z out of its front, one world unit to a wall cell) with materials.
// M.state is 'ok', 'hurt' or 'wreck'; the builder already knocks a wreck's
// parts askew and loses the small ones, so a model only has to say what is
// different about it broken: the desk top snaps, the monitor is on the floor.
//
// dirs: how many directions it is drawn from (1 for anything round).
// front: how far its front face stands from its centre, the edge it tips over.
// variants: how many dressings it has (what is on the desk, what the crate says).

import { C, TAU, mat, inkAt, terminal, stencil } from './propkit.js';
import { MODELS_OFFICE } from './propmodels_office.js';
import { MODELS_WORKS } from './propmodels_works.js';

// ------------------------------------------------------------------ office

/** Steel tanker desk: a drawer pedestal, a modesty panel, what somebody left on it. */
function desk(M) {
  const W = 0.8, D = 0.38, H = 0.36, top = 0.024;
  const body = M.variant === 1 ? C.officeGreen : C.steelGrey;
  const broken = M.wreck;
  // the top, snapped and sagging at one end when it is a wreck
  if (broken) {
    M.slab(-W / 2, H - top, -D / 2, 0.02, H, D / 2, C.laminate, { bevel: 0.006, keep: true, roll: 0.05 });
    M.box([0.2, H - 0.09, 0], [W / 2 - 0.02, top, D], C.laminate, { bevel: 0.006, keep: true, roll: -0.42 });
  } else {
    M.slab(-W / 2, H - top, -D / 2, W / 2, H, D / 2, C.laminate, { bevel: 0.008, fixed: true });
  }
  // pedestal with three drawers
  M.slab(-W / 2 + 0.01, 0.02, -D / 2 + 0.01, -W / 2 + 0.25, H - top, D / 2 - 0.01, body, { bevel: 0.006, fixed: true });
  for (let k = 0; k < 3; k++) {
    const y0 = 0.04 + k * 0.1, open = !broken && M.hurt && k === 1 ? 0.09 : 0;
    M.slab(-W / 2 + 0.025, y0, D / 2 - 0.01 + open, -W / 2 + 0.235, y0 + 0.088, D / 2 + 0.004 + open, body, { bevel: 0.005 });
    M.slab(-W / 2 + 0.1, y0 + 0.06, D / 2 + 0.004 + open, -W / 2 + 0.16, y0 + 0.07, D / 2 + 0.014 + open, C.chrome);
    if (open) M.slab(-W / 2 + 0.035, y0 + 0.02, D / 2 - 0.08 + open, -W / 2 + 0.225, y0 + 0.1, D / 2 - 0.01 + open, C.manila);
  }
  // modesty panel and the far leg
  M.slab(-W / 2 + 0.25, 0.1, -D / 2 + 0.02, W / 2 - 0.03, H - top, -D / 2 + 0.035, body, { fixed: true });
  M.slab(W / 2 - 0.05, 0.02, -D / 2 + 0.01, W / 2 - 0.01, H - top, D / 2 - 0.01, body, { bevel: 0.004, fixed: true });
  M.slab(-W / 2, 0, -D / 2, -W / 2 + 0.26, 0.02, D / 2, C.darkMetal, { fixed: true });
  M.slab(W / 2 - 0.06, 0, -D / 2, W / 2, 0.02, D / 2, C.darkMetal, { fixed: true });
  if (broken) {
    // what was on it is on the floor now
    M.push([0.26, 0.08, 0.2], 0.6, 1.2, 0.2);
    crt(M, 0.13);
    M.pop();
    M.slab(-0.1, 0, 0.12, 0.12, 0.012, 0.3, C.paper, { yaw: 0.4 });
    return;
  }
  const v = M.variant;
  if (v === 0 || v === 1) {
    M.push([0.1, H, -0.04], -0.2);
    crt(M, 0.13);
    M.pop();
    M.slab(-0.08, H, 0.07, 0.14, H + 0.012, 0.15, C.cream, { bevel: 0.003, yaw: -0.15 });          // keyboard
  } else {
    // a typewriter with a sheet in it
    M.slab(0.0, H, -0.06, 0.2, H + 0.05, 0.08, C.black, { bevel: 0.01 });
    M.cyl([0.1, H + 0.062, -0.03], 0.018, 0.23, C.darkMetal, { axis: 'x' });
    M.slab(0.03, H + 0.06, -0.035, 0.17, H + 0.15, -0.03, C.paper, { pitch: -0.2 });
  }
  // coffee, a lamp or a phone, and the paperwork
  M.cyl([-0.26, H + 0.03, 0.08], 0.022, 0.055, C.mug);
  M.cyl([-0.26, H + 0.057, 0.08], 0.019, 0.004, C.coffee);
  if (v !== 1) {
    M.slab(-0.2, H, -0.1, -0.02, H + 0.03, 0.02, C.manila, { yaw: 0.1 });
    M.slab(-0.19, H + 0.03, -0.09, -0.03, H + 0.036, 0.01, C.paper, { yaw: 0.16 });
  } else {
    // green banker's lamp
    M.cyl([-0.12, H + 0.01, -0.1], 0.04, 0.02, C.brass);
    M.rod([-0.12, H + 0.02, -0.1], [-0.12, H + 0.12, -0.08], 0.006, C.brass);
    M.cyl([-0.12, H + 0.13, -0.06], 0.035, 0.06, mat('glass', [40, 120, 70], { glow: 0.2 }), { axis: 'x' });
  }
}

/** A CRT: beige case, curved green glass, the day's work still on it. */
function crt(M, s) {
  M.slab(-s * 0.5, 0, -s * 0.55, s * 0.5, s * 0.82, s * 0.35, C.cream, { bevel: 0.01 });
  M.slab(-s * 0.36, s * 0.05, -s * 0.85, s * 0.36, s * 0.7, -s * 0.5, C.cream, { bevel: 0.02 });
  M.slab(-s * 0.4, s * 0.12, s * 0.35, s * 0.4, s * 0.72, s * 0.37, M.wreck ? C.glass : C.screenGreen,
    { paint: M.wreck ? null : terminal([0.8, 0.5, 0.65, 0.3, 0.7]) });
  M.slab(-s * 0.3, 0.0, -s * 0.2, s * 0.3, s * 0.05, s * 0.3, C.cream);
}

/** A swivel chair: five-star base on casters, gas lift, seat, back, arms. */
function chair(M) {
  const seatY = 0.21;
  const fab = M.variant === 1 ? C.fabricRed : C.fabricBlue;
  for (let k = 0; k < 5; k++) {
    const a = k * TAU / 5 + 0.3;
    const x = Math.sin(a) * 0.13, z = Math.cos(a) * 0.13;
    M.rod([0, 0.045, 0], [x, 0.03, z], 0.012, C.darkMetal);
    M.sph([x, 0.016, z], 0.016, C.rubber);
  }
  M.cyl([0, 0.1, 0], 0.014, 0.12, C.chrome);
  M.cyl([0, 0.055, 0], 0.03, 0.03, C.darkMetal);
  M.slab(-0.12, seatY - 0.02, -0.12, 0.12, seatY + 0.025, 0.12, fab, { bevel: 0.02 });
  M.slab(-0.05, seatY - 0.035, -0.05, 0.05, seatY - 0.02, 0.05, C.darkMetal);
  // the back leans a little, on a spine
  M.rod([0, seatY - 0.02, -0.1], [0, seatY + 0.08, -0.14], 0.012, C.darkMetal);
  M.box([0, seatY + 0.16, -0.14], [0.22, 0.2, 0.04], fab, { bevel: 0.018, pitch: -0.12 });
  for (const sx of [-1, 1]) {
    M.rod([sx * 0.11, seatY + 0.02, 0.0], [sx * 0.12, seatY + 0.1, 0.0], 0.008, C.darkMetal);
    M.slab(sx * 0.12 - 0.015, seatY + 0.1, -0.06, sx * 0.12 + 0.015, seatY + 0.115, 0.07, C.black, { bevel: 0.006 });
  }
}

/** Four-drawer filing cabinet; one drawer never quite shuts. */
function filing(M) {
  const W = 0.26, D = 0.3, H = 0.62;
  const body = M.variant === 1 ? C.olive : C.steelGrey;
  M.slab(-W / 2, 0.01, -D / 2, W / 2, H, D / 2, body, { bevel: 0.008, fixed: true });
  for (let k = 0; k < 4; k++) {
    const y0 = 0.03 + k * 0.148;
    const open = (M.variant === 0 && k === 2) || (M.hurt && k === 1) ? 0.07 : 0;
    M.slab(-W / 2 + 0.012, y0, D / 2 - 0.004 + open, W / 2 - 0.012, y0 + 0.138, D / 2 + 0.006 + open, body, { bevel: 0.005 });
    M.slab(-0.04, y0 + 0.085, D / 2 + 0.006 + open, 0.04, y0 + 0.1, D / 2 + 0.02 + open, C.chrome, { bevel: 0.003 });
    M.slab(-0.03, y0 + 0.108, D / 2 + 0.006 + open, 0.03, y0 + 0.126, D / 2 + 0.009 + open, C.paper,
      { paint: stencil(['A-F', 'G-M', 'N-S', 'T-Z'][3 - k], 0.1, 0.15, 0.9, 0.85, [40, 40, 44]) });
    if (open) {
      for (let j = 0; j < 5; j++) {
        M.slab(-W / 2 + 0.03, y0 + 0.02, D / 2 - 0.1 + j * 0.03 + open, W / 2 - 0.03, y0 + 0.14 + (j % 2) * 0.012, D / 2 - 0.092 + j * 0.03 + open,
          j % 2 ? C.manila : C.paper);
      }
    }
  }
  M.slab(-W / 2, 0, -D / 2, W / 2, 0.012, D / 2, C.darkMetal, { fixed: true });
  if (!M.wreck) M.slab(-0.07, H, -0.05, 0.08, H + 0.02, 0.1, C.manila, { yaw: 0.2 });
}

/** A pair of gym lockers: vents, handles, numbers, a sticker. */
function locker(M) {
  const W = 0.4, D = 0.28, H = 0.92;
  const body = M.variant === 1 ? C.olive : C.lockerBlue;
  M.slab(-W / 2, 0.03, -D / 2, W / 2, H, D / 2, body, { bevel: 0.006, fixed: true });
  M.slab(-W / 2, 0, -D / 2 + 0.01, W / 2, 0.03, D / 2 - 0.01, C.darkMetal, { fixed: true });
  const nums = M.variant === 1 ? ['13', '14'] : ['7', '8'];
  for (let k = 0; k < 2; k++) {
    const x0 = -W / 2 + 0.008 + k * (W / 2), x1 = x0 + W / 2 - 0.016;
    const open = M.state === 'open' && k === 0;
    if (open) {
      // door swung out on its hinge, and the dark inside
      M.slab(x0, 0.05, D / 2 - 0.2, x1, H - 0.01, D / 2 - 0.01, mat('paint', [20, 20, 24]));
      M.push([x0, 0, D / 2], -1.9);
      M.slab(0, 0.05, 0, x1 - x0, H - 0.01, 0.01, body, { bevel: 0.004 });
      M.pop();
      M.slab(x0 + 0.02, 0.06, 0.0, x1 - 0.02, 0.1, D / 2 - 0.04, C.fabricRed);       // gym bag
      continue;
    }
    M.slab(x0, 0.05, D / 2 - 0.002, x1, H - 0.012, D / 2 + 0.006, body, {
      bevel: 0.004,
      paint: (u, v) => {
        // louvres top and bottom, a number plate
        const lv = (v < 0.14 && v > 0.04) || (v > 0.86 && v < 0.96);
        if (lv && u > 0.2 && u < 0.8 && Math.floor(v * 110) % 2 === 0) return [18, 20, 26];
        if (v > 0.2 && v < 0.25 && u > 0.34 && u < 0.66) {
          const t = inkAt(nums[k], (u - 0.38) / 0.24, (v - 0.205) / 0.04);
          return t ? [40, 32, 18] : [206, 170, 80];
        }
        if (k === 1 && v > 0.52 && v < 0.6 && u > 0.14 && u < 0.86) {
          return inkAt('NUKE', (u - 0.18) / 0.64, (v - 0.53) / 0.06) ? [30, 26, 20] : [230, 196, 40];
        }
        return null;
      },
    });
    M.slab(x1 - 0.04, 0.44, D / 2 + 0.006, x1 - 0.028, 0.52, D / 2 + 0.02, C.chrome);
  }
  if (!M.wreck) M.slab(-0.12, H, -0.08, 0.1, H + 0.06, 0.1, mat('plastic', [150, 60, 40]), { bevel: 0.01, yaw: 0.3 });   // a box on top
}

/** MEGA COLA: lit window full of cans, logo down the side, coin slot, flap. */
function vending(M) {
  const W = 0.44, D = 0.38, H = 0.9;
  const lit = !M.wreck;
  const side = (u, v, face) => {
    if (face !== 0 && face !== 1) return null;
    // the side: a white wave and the name running up it
    const wave = 0.62 + 0.08 * Math.sin(u * 7.5 + 0.8);
    if (v > wave && v < wave + 0.05) return [244, 240, 232];
    if (v > wave + 0.07 && v < wave + 0.09) return [244, 240, 232];
    if (inkAt('MEGA', (u - 0.12) / 0.76, (v - 0.12) / 0.12)) return [250, 246, 236];
    if (inkAt('COLA', (u - 0.12) / 0.76, (v - 0.28) / 0.12)) return [250, 246, 236];
    return null;
  };
  // A shell, not a block: the window is a hole into the lit recess.
  const o = { bevel: 0.01, fixed: true };
  M.slab(-W / 2, 0.02, -D / 2, -W / 2 + 0.03, H, D / 2, C.colaRed, { ...o, paint: side });          // left side
  M.slab(W / 2 - 0.03, 0.02, -D / 2, W / 2, H, D / 2, C.colaRed, { ...o, paint: side });            // right side
  M.slab(-W / 2, 0.02, -D / 2, W / 2, H, -D / 2 + 0.03, C.colaRed, o);                              // back
  M.slab(-W / 2, H - 0.035, -D / 2, W / 2, H, D / 2, C.colaRed, o);                                 // top
  M.slab(-W / 2, 0.02, -D / 2, W / 2, 0.19, D / 2, C.colaRed, o);                                   // the base, round the flap
  M.slab(-W / 2 + 0.01, 0, -D / 2 + 0.01, W / 2 - 0.01, 0.02, D / 2 - 0.01, C.darkMetal, { fixed: true });
  // the recess behind the window, lit from inside
  M.slab(-W / 2 + 0.03, 0.2, D / 2 - 0.2, W / 2 - 0.12, H - 0.05, D / 2 - 0.19,
    mat('paint', lit ? [236, 226, 200] : [40, 36, 36], { glow: lit ? 0.75 : 0, wear: 0 }));
  const cans = [[210, 40, 40], [60, 110, 210], [230, 190, 50], [70, 170, 90], [236, 236, 230]];
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 4; c++) {
      if (M.hurt && (r * 4 + c) % 3 === 1) continue;
      const col = cans[(r + c * 2) % cans.length];
      const cx = -W / 2 + 0.058 + c * 0.066, cy = 0.245 + r * 0.13;
      M.cyl([cx, cy, D / 2 - 0.1], 0.025, 0.078, mat('metal', col, { gloss: 0.55 }));
      M.cyl([cx, cy + 0.041, D / 2 - 0.1], 0.02, 0.006, C.chrome);
    }
    // the shelf and its spiral
    M.slab(-W / 2 + 0.03, 0.198 + r * 0.13, D / 2 - 0.19, W / 2 - 0.12, 0.206 + r * 0.13, D / 2 - 0.05, C.chrome);
  }
  // the window frame, and a sheen on the glass that is not there
  M.slab(-W / 2 + 0.012, 0.185, D / 2 - 0.02, -W / 2 + 0.03, H - 0.035, D / 2 + 0.006, C.darkMetal);
  M.slab(W / 2 - 0.125, 0.185, D / 2 - 0.02, W / 2 - 0.11, H - 0.035, D / 2 + 0.006, C.darkMetal);
  M.slab(-W / 2 + 0.012, H - 0.05, D / 2 - 0.02, W / 2 - 0.11, H - 0.035, D / 2 + 0.006, C.darkMetal);
  M.slab(-W / 2 + 0.012, 0.185, D / 2 - 0.02, W / 2 - 0.11, 0.2, D / 2 + 0.006, C.darkMetal);
  if (lit) {
    for (const [x, k] of [[-0.12, 0.012], [-0.05, 0.006]]) {
      M.box([x, 0.55, D / 2 - 0.004], [k, 0.62, 0.002], mat('light', [255, 255, 255]), { roll: 0.35 });
    }
  } else {
    M.box([-0.06, 0.4, D / 2 - 0.004], [0.2, 0.004, 0.002], mat('light', [210, 220, 230]), { roll: 0.6 });
    M.box([-0.1, 0.62, D / 2 - 0.004], [0.14, 0.004, 0.002], mat('light', [210, 220, 230]), { roll: -0.9 });
  }
  // the right-hand panel: logo, buttons, slot
  M.slab(W / 2 - 0.11, 0.19, D / 2 - 0.004, W / 2 - 0.015, H - 0.04, D / 2 + 0.008, C.colaRed, {
    paint: (u, v) => {
      if (v > 0.06 && v < 0.2) return inkAt('MEGA', (u - 0.08) / 0.84, (v - 0.07) / 0.06) || inkAt('COLA', (u - 0.08) / 0.84, (v - 0.14) / 0.06) ? [250, 246, 236] : null;
      if (v > 0.26 && v < 0.5 && u > 0.2 && u < 0.8) {
        const bx = Math.floor((u - 0.2) / 0.3), by = Math.floor((v - 0.26) / 0.06);
        const fu = ((u - 0.2) / 0.3) % 1, fv = ((v - 0.26) / 0.06) % 1;
        if (fu > 0.15 && fu < 0.85 && fv > 0.2 && fv < 0.8) return (bx + by) % 3 ? [226, 226, 230] : [250, 210, 60];
      }
      if (v > 0.56 && v < 0.64 && u > 0.35 && u < 0.65) return [20, 20, 24];
      return null;
    },
  });
  // dispenser flap
  M.slab(-W / 2 + 0.05, 0.06, D / 2 - 0.02, W / 2 - 0.16, 0.14, D / 2 + 0.01, C.black, { bevel: 0.006 });
}

/** A water cooler: steel cabinet, a big blue bottle upside down, two taps. */
function cooler(M) {
  M.slab(-0.12, 0.01, -0.12, 0.12, 0.42, 0.12, C.beige, { bevel: 0.01, fixed: true });
  M.slab(-0.1, 0.0, -0.1, 0.1, 0.012, 0.1, C.darkMetal, { fixed: true });
  M.slab(-0.07, 0.12, 0.12, 0.07, 0.2, 0.125, C.darkMetal);
  M.slab(-0.07, 0.28, 0.12, -0.02, 0.33, 0.14, mat('plastic', [60, 110, 220]));
  M.slab(0.02, 0.28, 0.12, 0.07, 0.33, 0.14, mat('plastic', [210, 60, 50]));
  if (M.wreck) {
    M.cyl([0.05, 0.1, 0.18], 0.1, 0.24, mat('glass', [90, 160, 230]), { axis: 'z', yaw: 0.7 });
    return;
  }
  const bottle = mat('glass', [110, 170, 230], { gloss: 0.8 });
  M.cyl([0, 0.43, 0], 0.04, 0.03, bottle);
  M.cone([0, 0.48, 0], 0.04, 0.1, 0.06, bottle);
  M.cyl([0, 0.59, 0], 0.1, 0.16, bottle);
  M.cone([0, 0.685, 0], 0.1, 0.05, 0.03, bottle);
  M.cyl([0, 0.52 + (M.hurt ? 0.03 : 0.07), 0], 0.098, 0.005, mat('glass', [170, 210, 250]));
}

// ------------------------------------------------------------------ storage

/** A nailed pine crate with battens and a stencil. */
function crate(M) {
  const S = 0.46;
  const words = [['SIEBEN', 'UP'], ['FRAGILE'], ['MRE'], ['AMMO']][M.variant % 4];
  M.slab(-S / 2, 0, -S / 2, S / 2, S, S / 2, C.crate, {
    bevel: 0.01, fixed: true,
    paint: (u, v, face) => {
      if (face === 2 || face === 3) return null;
      // planks
      if (Math.floor(v * 5 + 0.02) !== Math.floor(v * 5 - 0.02)) return [96, 68, 40];
      const w = words[face === 4 || face === 5 ? 0 : words.length - 1];
      return inkAt(w, (u - 0.18) / 0.64, (v - 0.42) / 0.16) ? [44, 34, 24] : null;
    },
  });
  // battens round the edges, and the cross brace
  const t = 0.028, e = S / 2 + 0.004;
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) M.slab(x * e - t, 0, z * e - t, x * e + t, S, z * e + t, C.pine, { bevel: 0.004 });
  for (const y of [0.02, S - 0.02]) {
    M.slab(-e, y - 0.02, e - 0.01, e, y + 0.02, e + 0.006, C.pine, { bevel: 0.004 });
    M.slab(-e, y - 0.02, -e - 0.006, e, y + 0.02, -e + 0.01, C.pine, { bevel: 0.004 });
  }
  if (M.variant === 1) M.box([0, S / 2, e + 0.002], [0.05, S * 1.25, 0.012], C.pine, { roll: 0.78 });
  if (M.wreck) M.slab(-0.12, S, -0.1, 0.1, S + 0.03, 0.12, mat('paper', [200, 190, 150]));
}

/** Two crates stacked, the top one off-true. */
function crates(M) {
  M.push([0, 0, 0]); M.variant = 2; crate(M); M.pop();
  M.push([0.02, 0.46, -0.02], 0.3); M.variant = 0; crateSmall(M); M.pop();
}
function crateSmall(M) {
  M.push([0, 0, 0]);
  const S = 0.34;
  M.slab(-S / 2, 0, -S / 2, S / 2, S, S / 2, C.crate, {
    bevel: 0.008,
    paint: (u, v, face) => (face === 4 && inkAt('UP', (u - 0.3) / 0.4, (v - 0.4) / 0.2) ? [44, 34, 24] : Math.floor(v * 4 + 0.02) !== Math.floor(v * 4 - 0.02) && face !== 2 ? [96, 68, 40] : null),
  });
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) M.slab(x * S / 2 - 0.022, 0, z * S / 2 - 0.022, x * S / 2 + 0.022, S, z * S / 2 + 0.022, C.pine);
  M.pop();
}

// ------------------------------------------------------------------ the barrel

/** A 55-gallon drum of something you should not shoot: ribs, a hazard band, a bung. */
function barrel(M) {
  const drum = mat('paint', [150, 40, 30], { wear: 0.5, rust: 0.35 });
  const R = 0.15, H = 0.58;
  M.cyl([0, H / 2, 0], R, H - 0.01, drum, {
    paint: (u, v, face, lx, ly, lz) => {
      // the hazard band, as diagonal stripes round the middle
      if (ly > 0.02 && ly < 0.1) {
        const a = Math.atan2(lz, lx);
        return (Math.floor(a * 7 + ly * 60) % 2 + 2) % 2 ? [236, 190, 40] : [30, 26, 22];
      }
      if (ly > -0.04 && ly < -0.015 && Math.atan2(lz, lx) > 0.9 && Math.atan2(lz, lx) < 2.2) return [236, 226, 206];
      return null;
    },
  });
  // rolling hoops and the chimes top and bottom
  for (const y of [0.012, 0.19, 0.39, H - 0.012]) M.cyl([0, y, 0], R + 0.008, 0.018, drum);
  M.cyl([0, H + 0.002, 0], R - 0.012, 0.006, mat('paint', [120, 34, 26], { wear: 0.6 }));
  M.cyl([0.07, H + 0.012, 0.03], 0.022, 0.016, C.darkMetal);
  M.cyl([-0.08, H + 0.008, -0.04], 0.012, 0.01, C.darkMetal);
}

// ------------------------------------------------------------------ the columns

// What holds the roof up, floor to ceiling. They were painted cards that
// turned to face you; now they are solid, and each floor has its own.
const COL_H = 1.31;
const heightOf = (ly, h) => ly + h / 2;            // a cylinder's local y, as height off its foot

/** The bunker standard: poured concrete, a hazard band at knee height, plinth and capital. */
function pillar(M) {
  const crete = mat('paint', [140, 136, 128], { gloss: 0.05, wear: 0.06 });
  const sh = COL_H - 0.18;
  M.box([0, 0.05, 0], [0.5, 0.1, 0.5], crete, { bevel: 0.012 });
  M.box([0, COL_H - 0.045, 0], [0.5, 0.09, 0.5], crete, { bevel: 0.012 });
  M.cyl([0, 0.1 + sh / 2, 0], 0.22, sh, crete, {
    paint: (u, v, f, lx, ly, lz) => {
      const y = heightOf(ly, sh) + 0.1, a = Math.atan2(lz, lx);
      if (y > 0.24 && y < 0.36) return (Math.floor(a * 3.2 + y * 9) % 2 + 2) % 2 ? [226, 180, 40] : [36, 32, 28];
      if (y < 0.17) return [104, 100, 94];                                   // where the mop never reaches
      if (Math.sin(a * 9.0) > 0.93 && y < 1.0 - Math.sin(a * 5) * 0.2) return [122, 118, 110];   // a run of damp
      return null;
    },
  });
}

/** THE ORGAN LOFT: a squared timber post, iron-banded, on a plinth of the same. */
function pillarWood(M) {
  const timber = mat('wood', [112, 72, 42], { grain: 1.1 });
  M.box([0, COL_H / 2, 0], [0.32, COL_H - 0.16, 0.32], timber, { bevel: 0.012 });
  M.box([0, 0.05, 0], [0.42, 0.1, 0.42], timber, { bevel: 0.016 });
  M.box([0, COL_H - 0.04, 0], [0.42, 0.08, 0.42], timber, { bevel: 0.016 });
  for (const y of [0.27, 0.67, 1.07]) {
    M.box([0, y, 0], [0.336, 0.05, 0.336], C.darkMetal, { bevel: 0.004 });
    for (const [x, z] of [[0.17, 0.09], [0.17, -0.09], [-0.17, 0.09], [-0.17, -0.09]]) M.cyl([x, y, z], 0.012, 0.012, C.darkMetal, { axis: 'x' });
    for (const [x, z] of [[0.09, 0.17], [-0.09, 0.17], [0.09, -0.17], [-0.09, -0.17]]) M.cyl([x, y, z], 0.012, 0.012, C.darkMetal, { axis: 'z' });
  }
}

/** SALT CATHEDRAL: the concrete is still in there somewhere, under a crust that grows. */
function pillarSalt(M) {
  const salt = mat('porcelain', [228, 232, 236], { gloss: 0.22 });
  M.cyl([0, COL_H / 2, 0], 0.22, COL_H - 0.02, salt, {
    paint: (u, v, f, lx, ly, lz) => {
      const y = heightOf(ly, COL_H - 0.02), a = Math.atan2(lz, lx);
      const n = Math.sin(a * 5 + y * 7) * 0.5 + Math.sin(a * 11 - y * 13) * 0.3 + Math.sin(y * 23 + a * 3) * 0.2;
      if (n > 0.5 - y * 0.22) return [146, 142, 134];                       // concrete showing through
      if (n > 0.38 - y * 0.22) return [196, 198, 196];
      return null;
    },
  });
  M.cone([0, 0.07, 0], 0.36, 0.2, 0.14, salt);                               // the drift at its foot
  for (let k = 0; k < 7; k++) {                                              // crystals on the shoulders
    const a = k * 0.9 + 0.3, r = 0.2;
    M.cone([Math.cos(a) * r, COL_H - 0.16 - (k % 3) * 0.06, Math.sin(a) * r], 0.045, 0.004, 0.13 + (k % 2) * 0.05, salt,
      { roll: Math.cos(a) * -0.35, pitch: Math.sin(a) * 0.35 });
  }
  for (let k = 0; k < 6; k++) {                                              // lumps of crust on the shaft
    const a = k * 1.7, y = 0.3 + k * 0.15;
    M.sph([Math.cos(a) * 0.2, y, Math.sin(a) * 0.2], [0.06, 0.08, 0.06], salt);
  }
}

/** THE FURNACE: an I-beam gone orange, sweating at the rivets. */
function pillarRust(M) {
  const steel = mat('metal', [150, 70, 36], { rust: 0.85, gloss: 0.3 });
  const hh = COL_H - 0.12;
  M.box([0, COL_H / 2, 0.15], [0.36, hh, 0.035], steel);
  M.box([0, COL_H / 2, -0.15], [0.36, hh, 0.035], steel);
  M.box([0, COL_H / 2, 0], [0.04, hh, 0.27], steel);
  M.box([0, 0.03, 0], [0.48, 0.06, 0.46], steel, { bevel: 0.006 });
  M.box([0, COL_H - 0.03, 0], [0.48, 0.06, 0.46], steel, { bevel: 0.006 });
  for (let y = 0.16; y < COL_H - 0.1; y += 0.15) {
    for (const z of [0.17, -0.17]) for (const x of [-0.13, 0.13]) M.cyl([x, y, z], 0.011, 0.012, C.darkMetal, { axis: 'z' });
  }
  // heat-blued near the floor, where the furnace breathes on it
  M.box([0, 0.14, 0.152], [0.362, 0.12, 0.034], mat('metal', [74, 70, 108], { gloss: 0.5 }));
  M.box([0, 0.14, -0.152], [0.362, 0.12, 0.034], mat('metal', [74, 70, 108], { gloss: 0.5 }));
}

/** MUTTER: a conduit column wrapped in cable, blinking to itself. */
function pillarTech(M) {
  const cab = mat('paint', [52, 58, 66], { wear: 0.25 });
  M.box([0, COL_H / 2, 0], [0.36, COL_H - 0.02, 0.36], cab, {
    bevel: 0.01,
    paint: (u, v, f, lx, ly) => ((ly * 20 + 40) % 1 < 0.06 ? [30, 34, 40] : null),
  });
  const cols = [[170, 40, 36], [60, 150, 70], [210, 170, 40]];
  for (let k = 0; k < 3; k++) {
    const x = -0.1 + k * 0.1;
    for (let y = 0.02; y < COL_H - 0.12; y += 0.12) {
      const w0 = Math.sin(y * 9 + k) * 0.015, w1 = Math.sin((y + 0.12) * 9 + k) * 0.015;
      M.rod([x + w0, y, 0.19], [x + w1, y + 0.125, 0.19], 0.016, mat('rubber', cols[k]));
    }
  }
  for (const [x, y, z] of [[0.12, 0.42, 0.181], [-0.12, 0.86, 0.181], [0.181, 0.64, 0.1], [-0.181, 0.3, -0.08], [0.05, 1.12, -0.181]]) {
    M.box([x, y, z], [Math.abs(x) > 0.17 ? 0.01 : 0.03, 0.02, Math.abs(z) > 0.17 ? 0.01 : 0.03], mat('light', y > 0.8 ? [255, 80, 60] : [80, 230, 120]));
  }
}

// ------------------------------------------------------------------ the table

const MODELS_CORE = {
  desk: { build: desk, front: 0.19, variants: 3 },
  chair: { build: chair, front: 0.14, variants: 2 },
  filing: { build: filing, front: 0.15, variants: 2 },
  locker: { build: locker, front: 0.14, variants: 2 },
  vending: { build: vending, front: 0.19 },
  cooler: { build: cooler, front: 0.12 },
  crate: { build: crate, front: 0.23, variants: 4 },
  crates: { build: crates, front: 0.23 },
  barrel: { build: barrel, front: 0.15, dirs: 1, noDamage: true },
  pillar: { build: pillar, front: 0.25, dirs: 1, noDamage: true },
  pillar_wood: { build: pillarWood, front: 0.21, dirs: 1, noDamage: true },
  pillar_salt: { build: pillarSalt, front: 0.36, dirs: 1, noDamage: true },
  pillar_rust: { build: pillarRust, front: 0.24, dirs: 1, noDamage: true },
  pillar_tech: { build: pillarTech, front: 0.2, dirs: 1, noDamage: true },
};

/** Everything the studio can draw, by kind. */
export const MODELS = { ...MODELS_OFFICE, ...MODELS_WORKS, ...MODELS_CORE };

// ------------------------------------------------------------------ debris

// What a broken prop throws across the room. Each lies as it would come to
// rest on the floor; in the air the game turns the picture as it tumbles.
// variants pick the finish, so a pew breaks into dark oak and a vending
// machine into red steel.
const WOODS = [C.pine, C.oak, C.darkwood, C.laminate, C.crate];
const SHEETS = [C.steelGrey, C.lockerBlue, C.colaRed, C.olive, C.beige, C.officeGreen, C.cream, C.black];
const BOOKS = [[150, 40, 36], [40, 70, 130], [50, 110, 60], [200, 170, 60], [90, 60, 110], [220, 210, 190]];

function piecePlank(M) {
  const m = WOODS[M.variant % WOODS.length];
  const L = 0.2 + (M.variant % 3) * 0.04;
  M.slab(-L / 2, 0, -0.03, L / 2, 0.018, 0.03, m, { bevel: 0.003 });
  // the splintered end
  M.box([L / 2 + 0.015, 0.009, 0.01], [0.04, 0.014, 0.02], m, { yaw: 0.3 });
  M.box([L / 2 + 0.01, 0.009, -0.015], [0.03, 0.012, 0.016], m, { yaw: -0.4 });
}
function piecePanel(M) {
  const m = SHEETS[M.variant % SHEETS.length];
  M.slab(-0.1, 0, -0.07, 0.02, 0.01, 0.07, m, { bevel: 0.002 });
  M.box([0.06, 0.03, 0], [0.09, 0.01, 0.14], m, { roll: 0.7 });
}
function pieceDrawer(M) {
  const m = SHEETS[M.variant % SHEETS.length];
  M.slab(-0.1, 0, -0.13, 0.1, 0.01, 0.13, m);
  M.slab(-0.1, 0, 0.12, 0.1, 0.09, 0.13, m, { bevel: 0.004 });
  M.slab(-0.1, 0, -0.13, 0.1, 0.07, -0.12, m);
  M.slab(-0.1, 0, -0.13, -0.09, 0.07, 0.13, m);
  M.slab(0.09, 0, -0.13, 0.1, 0.07, 0.13, m);
  M.slab(-0.03, 0.05, 0.13, 0.03, 0.06, 0.14, C.chrome);
  M.slab(-0.08, 0.01, -0.1, 0.07, 0.05, 0.08, C.manila, { yaw: 0.1 });
}
function pieceLeg(M) {
  M.rod([-0.1, 0.012, 0], [0.1, 0.012, 0.02], 0.011, M.variant % 2 ? C.chrome : C.darkMetal);
  M.sph([0.11, 0.014, 0.02], 0.015, C.rubber);
}
function pieceMonitor(M) {
  M.push([0, 0, 0], 0, -1.3);
  M.slab(-0.065, 0, -0.07, 0.065, 0.11, 0.045, C.cream, { bevel: 0.008 });
  M.slab(-0.05, 0.015, 0.045, 0.05, 0.095, 0.05, C.glass);
  M.pop();
}
function pieceKeyboard(M) {
  M.slab(-0.1, 0, -0.035, 0.1, 0.014, 0.035, C.cream, { bevel: 0.003,
    paint: (u, v, face) => (face === 2 && (Math.floor(u * 18) + Math.floor(v * 5)) % 2 ? [150, 146, 136] : null) });
}
function pieceBook(M) {
  const c = BOOKS[M.variant % BOOKS.length];
  M.slab(-0.05, 0, -0.035, 0.05, 0.02, 0.035, mat('fabric', c), { bevel: 0.003 });
  M.slab(-0.047, 0.003, -0.034, 0.05, 0.017, 0.034, C.paper);
}
function pieceCan(M) {
  M.cyl([0, 0.022, 0], 0.022, 0.07, mat('metal', [[210, 40, 40], [60, 110, 210], [230, 190, 50]][M.variant % 3], { gloss: 0.5 }), { axis: 'x' });
}
function pieceChunk(M) {
  const m = [mat('paint', [150, 146, 136], { wear: 0 }), mat('paint', [226, 222, 210], { wear: 0 }), mat('paint', [196, 190, 172], { wear: 0 })][M.variant % 3];
  M.box([0, 0.035, 0], [0.09, 0.07, 0.08], m, { yaw: 0.4, roll: 0.2 });
  M.box([0.04, 0.03, 0.03], [0.06, 0.05, 0.05], m, { yaw: -0.3, pitch: 0.3 });
  M.box([-0.03, 0.02, -0.04], [0.05, 0.04, 0.05], m, { yaw: 0.9 });
}
function pieceTile(M) {
  M.slab(-0.05, 0, -0.04, 0.05, 0.012, 0.05, C.porcelain, { yaw: 0.3 });
}
function pieceGlass(M) {
  M.box([0, 0.004, 0], [0.07, 0.006, 0.04], mat('glass', [150, 200, 220]), { yaw: 0.5 });
  M.box([0.04, 0.004, 0.02], [0.03, 0.006, 0.05], mat('glass', [150, 200, 220]), { yaw: -0.4 });
}
function pieceCushion(M) {
  M.slab(-0.1, 0, -0.1, 0.1, 0.035, 0.1, M.variant % 2 ? C.fabricRed : C.fabricBlue, { bevel: 0.015 });
}
function pieceMeat(M) {
  const flesh = mat('flesh', [150, 42, 40]);
  M.sph([0, 0.035, 0], [0.07, 0.035, 0.05], flesh, { yaw: M.variant * 0.7 });
  M.sph([0.03, 0.05, 0.01], [0.03, 0.02, 0.03], mat('flesh', [226, 196, 170]));
}
function pieceBottle(M) {
  // a gas bottle or an extinguisher, lying down (and flying, in the worst case)
  const col = [[180, 34, 30], [40, 120, 70], [140, 144, 150], [200, 30, 30]][M.variant % 4];
  const m = mat('paint', col, { wear: 0.4 });
  M.cyl([0, 0.055, 0], 0.055, 0.34, m, { axis: 'x' });
  M.sph([0.17, 0.055, 0], [0.03, 0.05, 0.05], m);
  M.cyl([0.205, 0.055, 0], 0.018, 0.04, C.brass, { axis: 'x' });
  M.sph([-0.17, 0.055, 0], [0.012, 0.05, 0.05], m);
}
function pieceBoard(M) {
  // a circuit board out of a console
  M.slab(-0.07, 0, -0.05, 0.07, 0.006, 0.05, mat('plastic', [40, 110, 60]));
  for (let k = 0; k < 4; k++) M.slab(-0.05 + k * 0.03, 0.006, -0.02, -0.035 + k * 0.03, 0.014, 0.02, C.black);
}

export const PIECES = {
  plank: { build: piecePlank, variants: 5 },
  panel: { build: piecePanel, variants: 8 },
  drawer: { build: pieceDrawer, variants: 8 },
  leg: { build: pieceLeg, variants: 2 },
  monitor: { build: pieceMonitor },
  keyboard: { build: pieceKeyboard },
  book: { build: pieceBook, variants: 6 },
  can: { build: pieceCan, variants: 3, dirs: 4 },
  chunk: { build: pieceChunk, variants: 3, dirs: 4 },
  tile: { build: pieceTile, dirs: 2 },
  glass: { build: pieceGlass, dirs: 2 },
  cushion: { build: pieceCushion, variants: 2, dirs: 2 },
  meat: { build: pieceMeat, variants: 3, dirs: 4 },
  bottle: { build: pieceBottle, variants: 4 },
  board: { build: pieceBoard, dirs: 4 },
};

/** Which sheet-steel or wood finish a kind breaks into (the piece variant). */
export const FINISH = { pine: 0, oak: 1, darkwood: 2, laminate: 3, crate: 4,
  steelGrey: 0, lockerBlue: 1, colaRed: 2, olive: 3, beige: 4, officeGreen: 5, cream: 6, black: 7 };
