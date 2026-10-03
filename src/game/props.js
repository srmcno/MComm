// props.js - the bunker's furniture, and what it does when Brick gets to it.
//
// Everything with a body has hit points and a material, takes a round or a
// boot or a blast, and comes apart in a way that suits what it was made of.
// Some of it can be used and pays out. And it moves:
//
//   * light things (chairs, bins, cones, plants, a coat stand) are shoved by
//     rounds, thrown by blasts and hoofed across the room by the boot; they
//     tumble, bounce off the walls and hurt whatever they land on;
//   * tall things (lockers, filing cabinets, the vending machine, shelving,
//     the server racks) rock when kicked and go over: forward, onto whoever
//     is standing in front of them. A blast knocks them over too. What is
//     under one when it lands is flattened;
//   * broken things throw their parts (planks, drawers, a monitor, sheet
//     steel, books, cans) which bounce, spin and stay on the floor;
//   * gas bottles vent and then go up, and sometimes one takes off first;
//     an extinguisher shot or kicked flies round the room on its own foam;
//     a server rack or a generator that breaks arcs into whoever is near.
//
// The level's decor list (maps.js) says where things are and which way they
// face. This module adds the state (hit points, uses left, motion), the
// litter and the debris, and every rule. game.js only forwards: a bullet, a
// boot, a blast, the use key. The pictures come from the prop studio
// (engine/propstudio.js), one for each side of a thing, whole, battered,
// wrecked or on its way over; anything the studio does not model keeps its
// painted sprite.

import { rgba, makeFrame } from '../core/pixels.js';
import { clamp, dist, makeRng, randRange, TAU } from '../core/math.js';
import { viewDir } from '../engine/propstudio.js';
import { rotFrame } from './gore.js';
import { DECOR } from './maps.js';

/**
 * What a thing is made of decides how it sounds, what flies off it and how it
 * looks afterwards. cols are the chips; hit/brk are sfx names.
 */
const MAT = {
  wood: { hit: 'wood_hit', brk: 'wood_break', cols: [[178, 132, 82], [124, 86, 52], [206, 162, 106]] },
  metal: { hit: 'metal_hit', brk: 'metal_break', cols: [[164, 168, 176], [112, 116, 124], [198, 202, 210]], sparks: 1 },
  glass: { hit: 'metal_hit', hitRate: 1.7, hitVol: 0.5, brk: 'glass_break', cols: [[190, 232, 244], [230, 248, 252], [150, 210, 226]] },
  porcelain: { hit: 'metal_hit', hitRate: 1.5, hitVol: 0.6, brk: 'glass_break', brkRate: 0.8,
    cols: [[236, 234, 226], [206, 204, 196], [250, 248, 240]] },
  plant: { hit: 'wood_hit', hitRate: 1.35, hitVol: 0.5, brk: 'wood_break', brkRate: 1.3,
    cols: [[70, 130, 58], [104, 76, 48], [52, 96, 44], [170, 96, 60]] },
  tech: { hit: 'metal_hit', hitRate: 1.25, brk: 'metal_break', brkRate: 1.15,
    cols: [[60, 64, 76], [110, 116, 130], [240, 200, 80]], sparks: 2 },
  bone: { hit: 'bone_crack', hitVol: 0.6, brk: 'bone_crack', cols: [[226, 220, 200], [190, 182, 160]] },
  plastic: { hit: 'wood_hit', hitRate: 1.7, hitVol: 0.6, brk: 'wood_break', brkRate: 1.55,
    cols: [[240, 120, 40], [240, 236, 226]] },
  fabric: { hit: 'wood_hit', hitRate: 0.8, hitVol: 0.5, brk: 'wood_break', brkRate: 1.2, cols: [[58, 76, 124], [40, 40, 44]] },
  meat: { hit: 'hit_flesh', hitVol: 0.8, brk: 'splat', cols: [[150, 30, 30], [200, 150, 130], [110, 20, 24]] },
  sand: { hit: 'hit_wall', hitVol: 0.35, cols: [[190, 170, 120]], dust: 1 },
};

/**
 * hp: how much it takes (Infinity: it never breaks). kick: boot damage, or
 * 'fly' to send it across the room. use: what the use key does. cash: the
 * damages, in dollars, that go on the invoice when it breaks.
 *   mass   'light' moves when shot, flies when kicked or blasted
 *          'heavy' (the default) stays where it is put, unless it is tall
 *   tall   goes over: forward for anything backed against a wall, away from
 *          the boot or the blast for anything standing on its own
 *   crush  what it does to what it lands on
 *   debris [piece, count, finish] thrown when it breaks (propmodels.js PIECES)
 *   boom   { r, dmg } it explodes when it breaks
 *   vent   'gas' | 'foam': a round through it lets out what is inside
 *   arc    it shorts to anything within this radius when it breaks
 */
const DEFS = {
  desk: { name: 'DESK', mat: 'wood', hp: 46, kick: 22, use: 'desk', papers: 26, hitPapers: 3, chunks: 12, coins: 2, cash: 340, wreck: 0.32,
    debris: [['plank', 3, 3], ['drawer', 2, 0], ['monitor', 1], ['keyboard', 1]] },
  chair: { name: 'CHAIR', mat: 'fabric', hp: 18, kick: 'fly', chunks: 7, cash: 60, thud: 9, mass: 'light',
    debris: [['cushion', 1, 0], ['leg', 2, 0]] },
  filing: { name: 'FILING CABINET', mat: 'metal', hp: 70, kick: 20, use: 'filing', papers: 34, hitPapers: 2, chunks: 6, cash: 280, wreck: 0.28,
    tall: true, crush: 70, debris: [['drawer', 3, 0], ['panel', 2, 0]] },
  locker: { name: 'LOCKER', mat: 'metal', hp: 80, kick: 18, use: 'locker', chunks: 8, cash: 190, wreck: 0.26,
    tall: true, crush: 90, debris: [['panel', 3, 1]] },
  vending: { name: 'VENDING MACHINE', mat: 'metal', hp: 130, kick: 14, use: 'vending', cans: 5, foam: 26, glass: true, chunks: 8, coins: 6, cash: 900, wreck: 0.3,
    tall: true, crush: 160, debris: [['panel', 3, 2], ['glass', 3, 0], ['can', 4, 0]] },
  cooler: { name: 'WATER COOLER', mat: 'glass', hp: 46, kick: 20, use: 'cooler', water: 18, cash: 120, wreck: 0.4,
    debris: [['panel', 1, 4], ['glass', 2, 0]] },
  toilet: { name: 'TOILET', mat: 'porcelain', hp: 36, kick: 18, geyser: 5, cash: 250, wreck: 0.4, debris: [['tile', 5, 0]] },
  urinal: { name: 'URINAL', mat: 'porcelain', hp: 30, kick: 18, geyser: 4, cash: 180, wreck: 0.4, debris: [['tile', 4, 0]] },
  sink: { name: 'SINK', mat: 'porcelain', hp: 30, kick: 18, use: 'sink', geyser: 4, cash: 150, wreck: 0.4, debris: [['tile', 4, 0]] },
  console: { name: 'CONSOLE', mat: 'tech', hp: 60, kick: 18, use: 'console', zap: 1, chunks: 6, cash: 1200, arc: 1.8,
    debris: [['board', 2, 0], ['panel', 2, 7], ['glass', 2, 0]] },
  pinball: { name: 'PINBALL MACHINE', mat: 'tech', hp: 55, kick: 16, use: 'pinball', zap: 1, chunks: 6, coins: 8, cash: 700,
    debris: [['glass', 3, 0], ['board', 1, 0], ['panel', 2, 7]] },
  plant: { name: 'PLANT', mat: 'plant', hp: 8, kick: 'fly', chunks: 12, cash: 40, wreck: 0.28, mass: 'light', thud: 6 },
  trash: { name: 'TRASH CAN', mat: 'metal', hp: 14, kick: 'fly', papers: 12, cans: 2, cash: 20, wreck: 0.45, thud: 6, mass: 'light' },
  crate: { name: 'CRATE', mat: 'wood', hp: 34, kick: 20, chunks: 14, loot: 0.4, cash: 150, wreck: 0.3, debris: [['plank', 5, 4]] },
  crates: { name: 'CRATES', mat: 'wood', hp: 70, kick: 20, chunks: 20, loot: 0.75, cash: 300, wreck: 0.26, debris: [['plank', 8, 4]] },
  pew: { name: 'PEW', mat: 'wood', hp: 40, kick: 18, chunks: 12, cash: 90, wreck: 0.3, debris: [['plank', 5, 2]] },
  skeleton: { name: 'SKELETON', mat: 'bone', hp: 8, kick: 12, chunks: 12, cash: 0, wreck: 0.3 },
  mop: { name: 'MOP BUCKET', mat: 'plastic', hp: 8, kick: 'fly', chunks: 3, cash: 10, wreck: 0.4, mass: 'light', water: 8, thud: 5 },
  cone: { name: 'CONE', mat: 'plastic', hp: 6, kick: 'fly', chunks: 5, cash: 15, thud: 4, mass: 'light' },
  // the new stock
  bookshelf: { name: 'BOOKSHELF', mat: 'wood', hp: 60, kick: 16, papers: 18, chunks: 10, cash: 260, tall: true, crush: 90,
    debris: [['book', 10, 0], ['plank', 3, 1]] },
  photocopier: { name: 'PHOTOCOPIER', mat: 'tech', hp: 70, kick: 16, use: 'copier', papers: 40, zap: 1, toner: 1, cash: 2400,
    debris: [['panel', 3, 6], ['glass', 2, 0], ['board', 1, 0]] },
  coatrack: { name: 'COAT STAND', mat: 'wood', hp: 14, kick: 'fly', chunks: 6, cash: 45, mass: 'light', thud: 8, debris: [['plank', 2, 1]] },
  extinguisher: { name: 'EXTINGUISHER', mat: 'metal', hp: 10, kick: 'jet', vent: 'foam', cash: 90, mass: 'light' },
  tvcart: { name: 'TV CART', mat: 'tech', hp: 30, kick: 'fly', zap: 1, glass: true, cash: 400, mass: 'light', thud: 14,
    debris: [['glass', 3, 0], ['board', 1, 0], ['panel', 1, 7]] },
  table: { name: 'TABLE', mat: 'wood', hp: 40, kick: 18, chunks: 10, cash: 120, tall: 'flip', crush: 20,
    debris: [['plank', 3, 3], ['leg', 2, 1]] },
  gascyl: { name: 'GAS BOTTLES', mat: 'metal', hp: 34, kick: 14, vent: 'gas', cash: 300, boom: { r: 3.3, dmg: 90 },
    debris: [['bottle', 1, 1], ['panel', 1, 7]] },
  shelving: { name: 'SHELVING', mat: 'metal', hp: 70, kick: 16, chunks: 8, cash: 350, tall: true, crush: 110, loot: 0.5,
    debris: [['panel', 2, 0], ['can', 4, 0], ['plank', 3, 4]] },
  workbench: { name: 'WORKBENCH', mat: 'wood', hp: 60, kick: 18, chunks: 10, cash: 400, loot: 0.5,
    debris: [['plank', 4, 1], ['leg', 2, 1], ['panel', 1, 0]] },
  generator: { name: 'GENERATOR', mat: 'tech', hp: 90, kick: 14, zap: 1, cash: 5000, arc: 2.2, boom: { r: 2.8, dmg: 70 },
    debris: [['panel', 4, 3], ['board', 1, 0]] },
  spool: { name: 'CABLE REEL', mat: 'wood', hp: 50, kick: 'fly', chunks: 10, cash: 80, mass: 'light', thud: 24, roll: true,
    debris: [['plank', 4, 0]] },
  lectern: { name: 'LECTERN', mat: 'wood', hp: 24, kick: 14, papers: 14, chunks: 8, cash: 200, tall: true, crush: 25,
    debris: [['plank', 3, 2], ['book', 1, 5]] },
  candelabra: { name: 'CANDELABRA', mat: 'metal', hp: 30, kick: 12, cash: 150, tall: true, crush: 30, embers: 1 },
  butcher: { name: 'BUTCHER BLOCK', mat: 'meat', hp: 60, kick: 18, chunks: 10, cash: 180, bloody: 1,
    debris: [['meat', 4, 0], ['plank', 3, 2]] },
  serverrack: { name: 'SERVER RACK', mat: 'tech', hp: 90, kick: 14, zap: 1, cash: 8000, arc: 2.4, tall: true, crush: 150,
    debris: [['panel', 3, 7], ['board', 4, 0], ['glass', 2, 0]] },
  crtstack: { name: 'MONITORS', mat: 'tech', hp: 40, kick: 16, zap: 1, glass: true, cash: 600,
    debris: [['monitor', 3, 0], ['glass', 3, 0], ['keyboard', 1, 0]] },
  pallet: { name: 'PALLET', mat: 'wood', hp: 50, kick: 18, chunks: 12, loot: 0.35, cash: 120, debris: [['plank', 5, 0]] },
  // These take a hit and shrug. They still answer it, so shooting them is not silent.
  sandbags: { mat: 'sand', hp: Infinity },
  nosecone: { mat: 'metal', hp: Infinity, ring: 1 },
  chains: { mat: 'metal', hp: Infinity, swing: 1 },
  hook: { mat: 'metal', hp: Infinity, swing: 1 },
  corpse: { mat: 'bone', hp: Infinity, gore: 1 },
  corpse2: { mat: 'bone', hp: Infinity, gore: 1 },
};

/** A crushed body goes mostly to pieces, flat. */
const CRUSH_GORE = { sever: 0.8, head: 0.7, parts: 3, knock: 3, gib: 55, lift: 0.4 };

const PAPER_TINTS = [
  rgba(255, 255, 255, 0), rgba(244, 236, 200, 90), rgba(196, 220, 244, 110),
  rgba(255, 246, 168, 120), rgba(255, 255, 255, 0), rgba(226, 226, 232, 80),
];
const CAN_TINTS = [rgba(214, 56, 44, 140), rgba(60, 110, 210, 140), rgba(60, 170, 90, 140), rgba(230, 170, 50, 140)];

const REACH = 1.5;                 // how far the use key reaches
const CAP_LITTER = 220;
const CAP_DEBRIS = 130;
const HALF_PI = Math.PI / 2;

// ------------------------------------------------------------ out of the walls
//
// The furniture is solid models, and a model that ends up reaching into a wall
// is cut off by it: half a chair sticking out of the plaster, or the end of a
// bench showing past a corner. Flying, sliding, spinning, falling and coming
// to rest, a prop is kept out of the walls by its real extent (the model's own
// bounds), not just by its middle.

/** A wall to the furniture: off the map, solid, or a door that is not open. */
function wallCell(lv, cx, cy) {
  if (cx < 0 || cy < 0 || cx >= lv.W || cy >= lv.H) return true;
  const i = cy * lv.W + cx, c = lv.wall[i];
  if (c === 1) return true;
  if (c === 2) return lv.doorOpen[i] < 0.95;
  return false;
}

/** A model's bounds in its own frame (x right, y up, z front), worked out once. */
function meshFoot(m) {
  if (m._foot) return m._foot;
  const f = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity, top: 0, cy: m.cy || 0 };
  for (let i = 0; i < m.vx.length; i++) {
    const x = m.vx[i], y = m.vy[i], z = m.vz[i];
    if (x < f.minX) f.minX = x;
    if (x > f.maxX) f.maxX = x;
    if (z < f.minZ) f.minZ = z;
    if (z > f.maxZ) f.maxZ = z;
    if (y > f.top) f.top = y;
  }
  if (!(f.maxX > f.minX)) { f.minX = f.maxX = f.minZ = f.maxZ = 0; }
  m._foot = f;
  return f;
}

/**
 * Where a box's corners, edge middles and face middles come down on the floor
 * once it is turned (yaw), tipped over its front edge (tilt) and rolled about
 * its middle (roll), exactly as meshdraw.js draws it. Fills `out` with
 * x, y pairs and returns it.
 */
function boxFootprint(f, x0, y0, yaw, tilt, front, roll, rollY, out) {
  const fX = Math.cos(yaw), fY = Math.sin(yaw), rX = fY, rY = -fX;
  const ct = Math.cos(tilt), st = Math.sin(tilt), cr = Math.cos(roll), sr = Math.sin(roll);
  out.length = 0;
  for (let a = 0; a < 3; a++) {
    const bx = f.minX + (f.maxX - f.minX) * a * 0.5;
    for (let b = 0; b < 3; b++) {
      const by = f.top * b * 0.5;
      for (let c = 0; c < 3; c++) {
        let y = by, z = f.minZ + (f.maxZ - f.minZ) * c * 0.5;
        if (tilt) { const zz = z - front; const y1 = y * ct - zz * st; z = y * st + zz * ct + front; y = y1; }
        if (roll) { const yy = y - rollY; const y1 = yy * cr - z * sr; z = yy * sr + z * cr; y = y1 + rollY; }
        out.push(x0 + bx * rX + z * fX, y0 + bx * rY + z * fY);
      }
    }
  }
  return out;
}

/**
 * How far to move a footprint to get every point of it out of the walls, as
 * [dx, dy], or null if it is clear. Each point leaves its wall cell by the
 * nearest face with open floor beyond it.
 */
function wallPush(lv, pts) {
  let mx = 0, my = 0, any = false;
  for (let k = 0; k < pts.length; k += 2) {
    const px = pts[k], py = pts[k + 1];
    const cx = Math.floor(px), cy = Math.floor(py);
    if (!wallCell(lv, cx, cy)) continue;
    const fx = px - cx, fy = py - cy;
    let best = 0.75, ox = 0, oy = 0;
    if (fx < best && !wallCell(lv, cx - 1, cy)) { best = fx; ox = -(fx + 0.01); oy = 0; }
    if (1 - fx < best && !wallCell(lv, cx + 1, cy)) { best = 1 - fx; ox = 1 - fx + 0.01; oy = 0; }
    if (fy < best && !wallCell(lv, cx, cy - 1)) { best = fy; ox = 0; oy = -(fy + 0.01); }
    if (1 - fy < best && !wallCell(lv, cx, cy + 1)) { best = 1 - fy; ox = 0; oy = 1 - fy + 0.01; }
    if (!ox && !oy) continue;     // deep in the rock: nothing sensible to do from here
    any = true;
    if (Math.abs(ox) > Math.abs(mx)) mx = ox;
    if (Math.abs(oy) > Math.abs(my)) my = oy;
  }
  return any ? [mx, my] : null;
}

const pack = (r, g, b, a) => ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
const rgbOf = (c) => [c & 255, (c >>> 8) & 255, (c >>> 16) & 255];
const pickOf = (rng, arr) => arr[Math.min(arr.length - 1, (rng() * arr.length) | 0)];

// --------------------------------------------------------------------- frames

/** A sheet of typing paper, upright, as it tumbles. Tinted per sheet. */
function paperFrame() {
  const f = makeFrame(8, 10);
  const white = pack(238, 234, 222, 255), edge = pack(176, 172, 160, 255), ink = pack(128, 126, 124, 255);
  for (let y = 0; y < 10; y++) for (let x = 0; x < 8; x++) {
    const rim = x === 0 || x === 7 || y === 0 || y === 9;
    f.data[y * 8 + x] = rim ? edge : (y === 3 || y === 5 || y === 7) && x > 1 && x < 6 ? ink : white;
  }
  f.data[0] = 0; f.data[7] = 0;        // a clipped corner
  return f;
}

/** The same sheet on the floor, seen from eye height. */
function paperFlat() {
  const f = makeFrame(12, 4);
  const white = pack(232, 228, 216, 255), edge = pack(160, 156, 146, 255);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 12; x++) {
    const rim = y === 3 || x === 0 || x === 11;
    f.data[y * 12 + x] = rim ? edge : white;
  }
  f.data[2 * 12 + 4] = pack(140, 138, 134, 255); f.data[2 * 12 + 5] = pack(140, 138, 134, 255);
  return f;
}

function canFrame() {
  const f = makeFrame(6, 10);
  const alu = pack(196, 198, 204, 255), dark = pack(120, 122, 130, 255), label = pack(236, 232, 226, 255);
  for (let y = 0; y < 10; y++) for (let x = 0; x < 6; x++) {
    const rim = y === 0 || y === 9;
    const side = x === 0 || x === 5;
    f.data[y * 6 + x] = rim ? dark : side ? dark : (y >= 3 && y <= 6 ? label : alu);
  }
  f.data[0] = 0; f.data[5] = 0; f.data[9 * 6] = 0; f.data[9 * 6 + 5] = 0;
  return f;
}

function coinFrame() {
  const f = makeFrame(7, 7);
  const gold = pack(238, 196, 64, 255), hi = pack(255, 244, 170, 255), rim = pack(168, 122, 28, 255);
  for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
    const d = Math.hypot(x - 3, y - 3);
    if (d > 3.4) continue;
    f.data[y * 7 + x] = d > 2.6 ? rim : (x + y < 5 ? hi : gold);
  }
  return f;
}

/**
 * What is left of a painted prop: the bottom of its own picture, torn across
 * the top, scorched and dented. Only for kinds the studio does not model.
 */
function wreckFrame(src, keep, mat, seed) {
  const w = src.w, h0 = src.h;
  const h = Math.max(6, Math.round(h0 * keep));
  const f = makeFrame(w, h);
  const rng = makeRng(seed);
  const cols = (MAT[mat] || MAT.wood).cols;
  for (let x = 0; x < w; x++) {
    const cut = (rng() * 4) | 0;
    for (let y = cut; y < h; y++) {
      const c = src.data[(h0 - h + y) * w + x];
      if (!(c >>> 24)) continue;
      const k = 0.5 + rng() * 0.22;
      const [r, g, b] = rgbOf(c);
      f.data[y * w + x] = pack(r * k | 0, g * k | 0, b * k | 0, 255);
    }
  }
  for (let i = 0; i < Math.max(8, (w * h) >> 4); i++) {
    const x = (rng() * w) | 0, y = (rng() * h) | 0;
    const [r, g, b] = pickOf(rng, cols);
    if (f.data[y * w + x] >>> 24 || y > h * 0.55) f.data[y * w + x] = pack(r, g, b, 255);
  }
  for (let i = 0; i < (w * h) >> 6; i++) {
    const x = (rng() * w) | 0, y = (h * 0.5 + rng() * h * 0.5) | 0;
    if (f.data[y * w + x] >>> 24) f.data[y * w + x] = pack(24, 22, 26, 255);
  }
  return f;
}

/** A painted locker with its door ajar: the middle of the picture gone to shadow. */
function openedFrame(src) {
  const f = makeFrame(src.w, src.h);
  f.data.set(src.data);
  const x0 = Math.floor(src.w * 0.3), x1 = Math.ceil(src.w * 0.72);
  const y0 = Math.floor(src.h * 0.1), y1 = Math.ceil(src.h * 0.9);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (!(f.data[y * src.w + x] >>> 24)) continue;
      f.data[y * src.w + x] = x === x1 - 1 ? pack(150, 156, 166, 255) : pack(16, 14, 20, 255);
    }
  }
  return f;
}

// ---------------------------------------------------------------- the module

export class Props {
  constructor(game) {
    this.g = game;
    this.rng = makeRng(0xc0ffee);
    this.frames = { paper: paperFrame(), flat: paperFlat(), can: canFrame(), coin: coinFrame() };
    this.litter = [];
    this.flying = [];
    this.debris = [];
    this.spouts = [];
    this.jets = [];
    this.grid = new Map();
    this._recs = [];
    this._drecs = [];
    this.hintText = null;
    this._snd = 0;
  }

  get studio() { return (this.g.art && this.g.art.props) || null; }
  /** The same models as solid geometry, drawn in 3D (propmesh.js, meshdraw.js). */
  get meshes() { return (this.g.art && this.g.art.meshes) || null; }

  /** A new level: forget the last one's rubble and register this one's furniture. */
  load(lv) {
    this.litter.length = 0;
    this.flying.length = 0;
    this.debris.length = 0;
    this.spouts.length = 0;
    this.jets.length = 0;
    this.grid.clear();
    this.hintText = null;
    const kinds = new Set();
    for (const d of lv.decor || []) {
      d.def = DEFS[d.kind] || null;
      d.hp = d.def && d.def.hp !== undefined ? d.def.hp : 0;
      d.broken = false; d.flying = false; d.shake = 0; d.lift = 0;
      d.stock = d.kind === 'vending' ? 4 : 0;
      d.uses = 0;
      d.gal = d.kind === 'cooler' ? 6 : 0;
      d.altFrame = null; d.altH = 0; d._spr = undefined; d._fk = null;
      d.yaw = d.yaw || 0; d.variant = d.variant || 0;
      d.hx = d.x; d.hy = d.y; d.hr = 0.26;
      d.roll = 0; d.spin = 0; d.pose = 0; d.fall = null; d.rock = 0; d.vented = false; d.gone = false;
      d.h0 = d.h;
      // Stand it with its back to the wall, not a hand's width off it: the map
      // only knows which wall, the model knows how deep it is.
      const st0 = this.studio;
      if (d.wall && st0 && st0.has(d.kind)) {
        const b = st0.bounds(d.kind, d.variant);
        if (b) {
          const ux = Math.cos(d.yaw), uy = Math.sin(d.yaw);
          // how far the wall behind is from where it stands now
          let gap = 0;
          for (let r = 0.05; r <= 0.6; r += 0.01) { if (lv.blocked(d.x - ux * r, d.y - uy * r)) { gap = r; break; } }
          const shift = gap - (-b.minZ) - 0.012;
          if (gap && shift > 0 && shift < 0.3) { d.x -= ux * shift; d.y -= uy * shift; }
        }
      }
      d.hx = d.x; d.hy = d.y;
      if (d.def) this._gridAdd(d, lv);
      kinds.add(d.kind);
    }
    // Draw what this floor holds now, while the briefing card is up; the rest
    // (other sides, the wrecks) is made in the gaps between frames. The last
    // floor's wrecks and falls are let go; they are made again if wanted.
    const st = this.studio;
    if (st) {
      try { st.trim(); } catch (e) { /* keep them */ }
    }
    // Every piece of this floor's furniture as a solid model, now, while the
    // briefing card is up; then, in the gaps between frames, the battered and
    // wrecked ones and the pieces they come apart into.
    const mb = this.meshes;
    if (mb) {
      try {
        mb.trim();
        const mk = [...kinds].filter((k) => mb.has(k));
        // the floor's columns and drums are modelled as well
        for (const k of [lv.pillarKey && mb.has(lv.pillarKey) ? lv.pillarKey : 'pillar', 'barrel']) if (mb.has(k) && !mk.includes(k)) mk.push(k);
        mb.prewarm(mk, ['ok'], Infinity);
        const pieces = new Set();
        for (const k of mk) for (const [pc] of (DEFS[k] && DEFS[k].debris) || []) pieces.add(pc);
        for (const pc of ['chunk', 'plank', 'panel']) pieces.add(pc);
        mb.prewarm([...pieces], ['ok'], Infinity, true);
        for (const k of mk) {
          const nv = (mb.models[k] && mb.models[k].variants) || 1;
          for (let v = 0; v < nv; v++) { mb.get(k, 'wreck', v); mb.get(k, 'hurt', v); }
        }
      } catch (e) { /* the studio's pictures stand in */ }
    } else if (st) {
      try { st.prewarm([...kinds].filter((k) => st.has(k)), ['ok'], 250); } catch (e) { /* the painted set stands in */ }
    }
  }

  /**
   * Put a prop down at (x, y) facing `yaw`, as if the level had it: for the
   * tools, and for anything that wants to furnish a room after the fact.
   */
  spawn(kind, x, y, yaw = 0, variant = 0) {
    const g = this.g, lv = g.level, spec = DECOR[kind];
    if (!lv || !spec) return null;
    const d = {
      kind, key: `prop_${kind}`, x, y, z: spec.z || 0, h: spec.h, solid: !!spec.solid, emissive: !!spec.emissive,
      fixture: spec.fixture || null, yaw, variant, wall: !!spec.wall,
    };
    d.def = DEFS[kind] || null;
    d.hp = d.def && d.def.hp !== undefined ? d.def.hp : 0;
    d.broken = false; d.flying = false; d.shake = 0; d.lift = 0; d.stock = kind === 'vending' ? 4 : 0; d.uses = 0;
    d.gal = kind === 'cooler' ? 6 : 0; d.altFrame = null; d.altH = 0; d._spr = undefined; d._fk = null;
    d.hx = x; d.hy = y; d.hr = 0.26; d.roll = 0; d.spin = 0; d.pose = 0; d.fall = null; d.rock = 0; d.vented = false; d.gone = false; d.h0 = d.h;
    lv.decor.push(d);
    if (d.def) this._gridAdd(d, lv);
    if (d.solid) { const i = lv.idx(x, y); lv.propBlock[i] = 1; lv.propH[i] = Math.max(lv.propH[i], d.z + d.h); }
    return d;
  }

  _gridAdd(d, lv) {
    const i = (lv || this.g.level).idx(d.hx, d.hy);
    let l = this.grid.get(i);
    if (!l) { l = []; this.grid.set(i, l); }
    if (!l.includes(d)) l.push(d);
    d._cell = i;
  }
  _gridDel(d) {
    const i = d._cell;
    const l = this.grid.get(i);
    if (!l) return;
    const k = l.indexOf(d);
    if (k >= 0) l.splice(k, 1);
    if (!l.length) this.grid.delete(i);
  }

  /** The prop a shot at (x, y, z) has just struck, if any. */
  at(x, y, z) {
    const l = this.grid.get(this.g.level.idx(x, y));
    if (!l) return null;
    for (let k = 0; k < l.length; k++) {
      const d = l[k];
      if (d.broken || d.flying || d.gone) continue;
      // Bodies on the floor and chains from the ceiling are scenery to a bullet.
      if (!d.solid && d.def.hp === Infinity) continue;
      if (z < d.z || z > d.z + d.h) continue;
      // Something you can walk through is only hit if the shot passes through it.
      if (!d.solid && Math.hypot(x - d.hx, y - d.hy) > d.hr) continue;
      return d;
    }
    return null;
  }

  /** A ceiling lamp a shot at (x, y, z) has reached. */
  lampAt(x, y, z) {
    if (z < 0.95) return null;
    for (const it of this.g.items) {
      if (it.kind !== 'lamp' || it.taken) continue;
      if (Math.abs(it.x - x) < 0.3 && Math.abs(it.y - y) < 0.3) return it;
    }
    return null;
  }

  /** Shoot the light out: glass, sparks, and the room goes a shade darker. */
  shootLamp(it) {
    const g = this.g;
    if (it.taken) return;
    it.taken = true;
    const k = g.staticLights.findIndex((L) => L.x === it.x && L.y === it.y);
    if (k >= 0) g.staticLights.splice(k, 1);
    g.sound.sfx('glass_break', { pan: g.panAt(it.x, it.y), vol: 0.8, rate: 1.15 });
    g.particles.sparks(it.x, it.y, it.z, 14, 2.4, [255, 236, 180], 4);
    this._chips(it.x, it.y, it.z, 10, MAT.glass, 1.6);
    g.particles.smoke(it.x, it.y, it.z, 2, 0.3);
    g.hud.popup('LIGHTS OUT', { size: 9, life: 0.9, y: -50, dy: -8, color: rgba(200, 194, 180, 255) });
    g.chat('brick', 'brick_smash', { chance: 0.25, cooldown: 8 });
  }

  // ------------------------------------------------------------------ damage

  /**
   * A round, a boot or a blast landed on it. False if it does not care.
   * dx, dy: which way the hit was travelling, for what it shoves.
   */
  hit(d, dmg, x, y, z, how, dx = 0, dy = 0) {
    const def = d.def;
    if (!def || d.broken || d.flying || d.gone) return false;
    if (def.hp === Infinity) { this._shrug(d, x, y, z); return true; }
    d.hp -= dmg;
    d.shake = 0.3;
    this._hitFx(d, x, y, z, how);
    // the first hit: have its battered and wrecked pictures made now, from where
    // the player is looking, so they are ready when it needs them
    const mb = this.meshes;
    if (!d._warm && mb && mb.has(d.kind)) {
      d._warm = true;
      mb.get(d.kind, 'wreck', d.variant);
      mb.get(d.kind, 'hurt', d.variant);
    }
    const st = mb ? null : this.studio;
    if (!d._warm && st && st.has(d.kind)) {
      d._warm = true;
      const p = this.g.player;
      const dir = viewDir(d.x, d.y, d.yaw, p.x, p.y, st.dirsOf(d.kind));
      st.want(d.kind, dir, 'wreck', d.variant, 0);
      st.want(d.kind, dir, 'hurt', d.variant, 0);
    }
    // A round through a bottle lets out what is in it.
    if (def.vent && !d.vented && how !== 'blast' && d.hp > 0) this._vent(d, dx, dy);
    if (d.hp <= 0) { this.breakProp(d, how, x, y); return true; }
    // Light things take the round with them.
    if (def.mass === 'light' && !d.solid && how === 'shot' && (dx || dy)) {
      const L = Math.hypot(dx, dy) || 1;
      this.shove(d, dx / L, dy / L, Math.min(3.2, dmg * 0.09), dmg > 20 ? 1.4 : 0);
    }
    // Something tall with most of its insides shot out can go on its own.
    if (def.tall && !d.fall && how === 'shot' && d.hp < def.hp * 0.35 && this.rng() < 0.18) {
      this.topple(d, dx, dy, 0.1);
    }
    return true;
  }

  /** Things that take it: dust off sandbags, a ring off a warhead nose, a rattle off chains. */
  _shrug(d, x, y, z) {
    const g = this.g, m = MAT[d.def.mat];
    d.shake = Math.max(d.shake, 0.25);
    if (g.time - (d._snd || -9) > 0.12) {
      d._snd = g.time;
      const rico = d.def.ring;
      g.sound.sfx(rico ? 'ricochet' : d.def.gore ? 'hit_flesh' : m.hit, { pan: g.panAt(d.x, d.y), vol: m.hitVol || 0.7 });
    }
    if (m.dust) g.particles.dust(x, y, z, 3);
    else if (d.def.gore) g.particles.blood(x, y, z, 6, 0, 0);
    else g.particles.sparks(x, y, z, 5, 1.6, [255, 226, 170], 5);
  }

  _hitFx(d, x, y, z, how) {
    const g = this.g, def = d.def, m = MAT[def.mat];
    if (g.time - (d._snd || -9) > 0.08) {
      d._snd = g.time;
      g.sound.sfx(m.hit, { pan: g.panAt(d.x, d.y), rate: m.hitRate || 1, vol: m.hitVol || 1 });
    }
    this._chips(x, y, z, how === 'kick' ? 6 : 4, m, 2.4);
    if (m.sparks) g.particles.sparks(x, y, z, 5, 1.6, [255, 220, 150], 5);
    if (def.bloody) g.particles.blood(x, y, z, 5, 0, 0);
    if (def.hitPapers) this.papers(d.x, d.y, d.z + d.h * 0.8, def.hitPapers, 0.6);
  }

  _chips(x, y, z, n, m, speed) {
    const P = this.g.particles, rng = this.rng;
    for (let i = 0; i < n; i++) {
      const a = rng() * TAU, s = randRange(rng, 0.5, 1) * speed;
      const [r, gg, b] = pickOf(rng, m.cols);
      P.spawn({
        x, y, z, vx: Math.cos(a) * s, vy: Math.sin(a) * s, vz: randRange(rng, 1.4, 4.2),
        life: randRange(rng, 0.7, 1.6), size: randRange(rng, 0.03, 0.07), r, g: gg, b,
        drag: 1.1, grav: 9, additive: false, hard: true, fadePow: 0.5, bounce: 0.35,
      });
    }
  }

  /** Everything within reach of a blast takes it, less with distance; light things fly, tall things go over. */
  blast(x, y, z, radius, damage) {
    const lv = this.g.level;
    if (!lv || !lv.decor) return;
    // Only what the blast can reach: a wall between keeps the next room's
    // furniture, lights and litter where they are, and a burst up over the
    // roof does not reach down through it.
    const g = this.g;
    const sees = (tx, ty) => (g.blastReaches ? g.blastReaches(x, y, tx, ty, z) : lv.clearLine(x, y, tx, ty));
    for (const it of this.g.items) {
      if (it.kind === 'lamp' && !it.taken && dist(x, y, it.x, it.y) < radius * 0.8 && sees(it.x, it.y)) this.shootLamp(it);
    }
    for (const d of lv.decor) {
      if (!d.def || d.broken || d.gone || d.def.hp === Infinity) continue;
      const r = dist(x, y, d.hx, d.hy);
      if (r >= radius) continue;
      if (!sees(d.hx, d.hy)) continue;
      const k = 1 - r / radius;
      const L = r || 1, ux = r > 0.05 ? (d.hx - x) / L : this.rng() - 0.5, uy = r > 0.05 ? (d.hy - y) / L : this.rng() - 0.5;
      const force = damage * k;
      if (!d.flying) this.hit(d, 8 + damage * 1.3 * k, d.hx, d.hy, d.z + d.h * 0.5, 'blast', ux, uy);
      if (d.broken || d.gone) continue;
      if (d.def.vent === 'foam' && !d.vented) { d.vented = true; this._jetFrom(d, 'foam', ux, uy); continue; }
      if (d.def.mass === 'light' && !d.solid) {
        this._launch(d, ux, uy, 4 + force * 0.14, 2.2 + force * 0.05, true);
      } else if (d.def.tall && !d.fall && force > 22) {
        this.topple(d, ux, uy, 0.05);
      }
    }
    // Debris on the floor is thrown again.
    for (const b of this.debris) {
      const r = dist(x, y, b.x, b.y);
      if (r >= radius || b.jet || !sees(b.x, b.y)) continue;
      const k = 1 - r / radius, L = r || 1;
      b.vx += ((b.x - x) / L) * (3 + damage * 0.12 * k);
      b.vy += ((b.y - y) / L) * (3 + damage * 0.12 * k);
      b.vz = Math.max(b.vz, 2 + damage * 0.05 * k);
      b.rollRate = (this.rng() - 0.5) * 30;
      b.rest = false;
    }
  }

  // ------------------------------------------------------------------- break

  breakProp(d, how, fx, fy) {
    const def = d.def, g = this.g, lv = g.level, m = MAT[def.mat];
    if (d.broken) return;
    d.broken = true; d.hp = 0; d.shake = 0;
    this._clearBlock(d);
    if (d.fixture) { const i = lv.idx(d.x, d.y); lv.fixture[i] = 0; lv.fixtureUsed[i] = 1; }
    if (d.flying) this._unfly(d, false);

    const x = d.hx, y = d.hy, zc = d.z + d.h * 0.55;
    const pan = g.panAt(x, y);
    g.sound.sfx(m.brk || 'wood_break', { pan, rate: m.brkRate || 1 });
    if (def.glass) g.sound.sfx('glass_break', { pan, vol: 0.9 });
    this._chips(x, y, zc, def.chunks || 8, m, 3.6);
    if (m.sparks) g.particles.sparks(x, y, zc, 10 * m.sparks, 2.2, [255, 214, 140], 6);
    if (def.zap) {
      g.particles.smoke(x, y, zc, 6, 0.6);
      g.particles.sparks(x, y, zc + 0.1, 16, 2.4, [150, 220, 255], 7);
    }
    if (def.toner) g.particles.smoke(x, y, zc, 14, 0.9, [24, 22, 26]);
    if (def.papers) this.papers(x, y, d.z + d.h * 0.7, def.papers, 1);
    if (def.coins) for (let k = 0; k < def.coins; k++) this._coin(x, y, zc, 25);
    if (def.foam) this._foam(x, y, zc, def.foam);
    if (def.water) this._spray(x, y, d.z + 0.3, def.water, 1);
    if (def.cans) {
      const n = def.cans + Math.max(0, d.stock);
      for (let k = 0; k < n; k++) this._spawnCan(x, y, d.z + d.h * 0.5, true);
      d.stock = 0;
    }
    if (def.geyser) {
      this.spouts.push({ x, y, z: d.z + 0.15, t: def.geyser, T: def.geyser });
      g.sound.sfx('water_burst', { pan });
    }
    if (def.bloody) {
      g.particles.blood(x, y, zc, 26, 0, 0);
      g.addDecal(x, y, 'gore');
      g.sound.sfx('splat', { pan });
    }
    if (def.embers) g.particles.embers(x, y, zc, 12, 0.6);
    if (m.dust) g.particles.dust(x, y, zc, 6);
    if (def.loot && g.rng() < def.loot) this._loot(x, y);
    if (how === 'blast' || how === 'crash') g.shake = Math.max(g.shake, 0.9);
    if (def.debris) this._throwDebris(d, def.debris, how, fx, fy);
    if (def.arc) this._arc(d, def.arc);
    if (def.boom) {
      // fuel, or a bottle of it: it goes up a beat after it breaks
      g.after(0.08, () => {
        g.sound.sfx('barrel_explode', { pan: g.panAt(x, y) });
        g.explodeAt(x, y, 0.45, def.boom.r, def.boom.dmg);
        g.particles.embers(x, y, 0.5, 24, 1.2);
      });
    }

    // What is left. The studio has a wreck of everything it models; the rest
    // is the old picture cut down.
    const st = this.studio;
    if (!(st && st.has(d.kind))) {
      const src = g.art.sprites[d.key];
      if (src) {
        d.altFrame = wreckFrame(src, def.wreck || 0.32, def.mat, (Math.imul(d._cell | 0, 2654435761) ^ 0x9e37) >>> 0);
        d.altH = d.h * (d.altFrame.h / src.h);
        if (d.kind === 'urinal') d.z = 0;
      }
    }
    d._spr = undefined; d._fk = null;
    // A wreck is low enough to shoot over.
    d.h = Math.min(d.h, d.h0 * 0.45);
    if (def.cash) {
      g.levelDamage = (g.levelDamage || 0) + def.cash;
      g.hud.popup(`DAMAGES  $${def.cash}`, { size: 9, life: 1.2, y: -58, dy: -10, color: rgba(255, 196, 90, 255) });
    }
    g.onPropBroken(d, how);
  }

  /** The cell stops blocking bodies when what blocked it is gone or lying down. */
  _clearBlock(d) {
    if (!d.solid) return;
    const lv = this.g.level;
    d.solid = false;
    const i = lv.idx(d.x, d.y);
    let h = 0, any = false;
    for (const o of this.grid.get(i) || []) if (o !== d && o.solid && !o.broken) { any = true; h = Math.max(h, o.z + o.h); }
    if (!any) { lv.propBlock[i] = 0; lv.propH[i] = 0; } else lv.propH[i] = h;
  }

  /** Parts of it across the floor, thrown away from whatever did it. */
  _throwDebris(d, list, how, fx, fy) {
    const rng = this.rng;
    const hard = how === 'blast' || how === 'crash' || how === 'crush';
    let ax = d.hx - (fx === undefined ? d.hx : fx), ay = d.hy - (fy === undefined ? d.hy : fy);
    const L = Math.hypot(ax, ay);
    if (L > 0.01) { ax /= L; ay /= L; } else { ax = 0; ay = 0; }
    for (const [piece, n, fin] of list) {
      for (let k = 0; k < n; k++) {
        const a = rng() * TAU, s = randRange(rng, 0.8, hard ? 4.5 : 2.4);
        this.spawnDebris(piece, fin || 0, d.hx + (rng() - 0.5) * 0.3, d.hy + (rng() - 0.5) * 0.3, d.z + d.h * randRange(rng, 0.3, 0.8),
          Math.cos(a) * s + ax * 1.6, Math.sin(a) * s + ay * 1.6, randRange(rng, 1.5, hard ? 5.5 : 3.5));
      }
    }
  }

  /** A loose part: a plank, a drawer, a can. It falls, bounces, spins and stays. */
  spawnDebris(piece, variant, x, y, z, vx, vy, vz, o = {}) {
    if (this.debris.length >= CAP_DEBRIS) {
      let k = this.debris.findIndex((b) => b.rest);
      if (k < 0) k = 0;
      this.debris.splice(k, 1);
    }
    const rng = this.rng;
    const b = {
      piece, v: variant, x, y, z, vx, vy, vz, yaw: rng() * TAU, spin: (rng() - 0.5) * 16,
      roll: rng() * TAU, rollRate: (rng() - 0.5) * 26, rest: false, age: 0, bounced: 0, ...o,
    };
    this.debris.push(b);
    return b;
  }

  /** Mains voltage looking for the floor through whoever is nearest. */
  _arc(d, radius) {
    const g = this.g, rng = this.rng;
    const x = d.hx, y = d.hy, z = d.z + d.h * 0.6;
    g.sound.sfx('zap_arc', { pan: g.panAt(x, y) });
    let hits = 0;
    for (const e of g.enemies) {
      if (!e.alive || hits >= 4) continue;
      const r = dist(x, y, e.x, e.y);
      if (r > radius) continue;
      hits++;
      // the bolt: a ragged line of sparks
      const n = Math.ceil(r * 8);
      for (let k = 0; k <= n; k++) {
        const t = k / Math.max(1, n);
        g.particles.spawn({
          x: x + (e.x - x) * t + (rng() - 0.5) * 0.12, y: y + (e.y - y) * t + (rng() - 0.5) * 0.12,
          z: z + (e.z + e.height * 0.5 - z) * t + (rng() - 0.5) * 0.12,
          life: randRange(rng, 0.12, 0.3), size: 0.06, r: 170, g: 220, b: 255, drag: 0, grav: 0, additive: true,
        });
      }
      const killed = e.hurt(45, g, x, y);
      g.hud.hitMark(killed);
      g.particles.sparks(e.x, e.y, e.z + e.height * 0.5, 12, 2, [170, 220, 255], 5);
      if (killed) g.hud.popup('ELECTROCUTED', { size: 12, life: 1.2, color: rgba(150, 220, 255, 255) });
    }
    const p = g.player;
    if (!p.dead && dist(x, y, p.x, p.y) < radius * 0.6) p.hurt(8, g, 'arc');
    g.particles.smoke(x, y, z, 8, 0.6, [40, 40, 46]);
  }

  // ---------------------------------------------------------- motion

  /** Push a light prop along the floor (and a little into the air). */
  shove(d, ux, uy, speed, hop = 0) {
    if (d.flying) {
      d.mv.vx += ux * speed; d.mv.vy += uy * speed;
      return;
    }
    this._launch(d, ux, uy, speed, hop, false);
  }

  /**
   * Set a prop moving: kicked, blasted or shot. `tumble` sends it end over end;
   * without it, it slides and spins where it stands.
   */
  _launch(d, ux, uy, speed, vz, tumble) {
    const g = this.g;
    if (d.broken || d.gone) return;
    if (!d.flying) {
      this._gridDel(d);
      d.flying = true;
      d.mv = { vx: 0, vy: 0, vz: 0, hit: new Set(), tumble: false };
      this.flying.push(d);
    }
    const rng = this.rng;
    d.mv.vx += ux * speed + (rng() - 0.5) * speed * 0.15;
    d.mv.vy += uy * speed + (rng() - 0.5) * speed * 0.15;
    d.mv.vz = Math.max(d.mv.vz, vz);
    d.mv.tumble = d.mv.tumble || !!tumble;
    d.spin += (rng() - 0.5) * (4 + speed * 1.6);
    if (tumble) d.rollRate = (rng() < 0.5 ? -1 : 1) * (6 + speed * 1.4);
    d.lift = Math.max(d.lift, 0.01);
    if (speed > 6 && g.time - (this._launchSnd || -9) > 0.1) {
      this._launchSnd = g.time;
      g.sound.sfx(MAT[d.def.mat].hit, { pan: g.panAt(d.x, d.y), rate: 1.2 });
    }
  }

  /** The model's bounds, from its solid model if it has one, else from the studio. */
  _foot(d) {
    if (d._foot && d._footK === d.kind) return d._foot;
    let f = null;
    const mb = this.meshes;
    if (mb && mb.has(d.kind)) {
      const m = mb.get(d.kind, 'ok', d.variant);
      if (m && m.ready) f = meshFoot(m);
    }
    const st = this.studio;
    if (!f && st && st.has(d.kind)) {
      const b = st.bounds(d.kind, d.variant);
      const top = (b && b.top) || d.h0 || d.h;
      if (b && b.maxX > b.minX) f = { minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ, top, cy: top * 0.5 };
    }
    if (f) { d._foot = f; d._footK = d.kind; }
    return f;
  }

  /** How far the model's front face is from its middle: what it tips over on. */
  _frontOf(d) {
    const M = (this.meshes && this.meshes.models) || (this.studio && this.studio.models);
    const m = M && M[d.kind];
    return m && m.front !== undefined ? m.front : 0.2;
  }

  /** Round enough to slide along a wall on: the smaller of its half-widths. */
  _radius(d) {
    const f = this._foot(d);
    if (!f) return 0.2;
    const r = Math.min(Math.max(-f.minX, f.maxX), Math.max(-f.minZ, f.maxZ));
    return clamp(r, 0.12, 0.42);
  }

  /** How deep a circle at (x, y) reaches into the walls round it (0 if it does not). */
  _overlap(x, y, r) {
    const lv = this.g.level;
    const cx = Math.floor(x), cy = Math.floor(y);
    let o = 0;
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const gx = cx + i, gy = cy + j;
        if (!wallCell(lv, gx, gy)) continue;
        if (!i && !j) return r + 1;
        const qx = x < gx ? gx : x > gx + 1 ? gx + 1 : x;
        const qy = y < gy ? gy : y > gy + 1 ? gy + 1 : y;
        const dd = Math.hypot(x - qx, y - qy);
        if (r - dd > o) o = r - dd;
      }
    }
    return o;
  }

  /**
   * Stand it back out of any wall its model reaches into: as it is, turned,
   * tipped or rolling. A few rounds, since getting out of one wall can put a
   * corner into the one opposite in a tight spot. True if it had to move.
   */
  _unwall(d) {
    const lv = this.g.level, f = this._foot(d);
    if (!lv || !f) return false;
    const pts = this._pts || (this._pts = []);
    const front = this._frontOf(d);
    let moved = false;
    for (let it = 0; it < 4; it++) {
      const tilt = d.fall ? d.fall.ang : 0, roll = d.flying ? d.roll || 0 : 0;
      boxFootprint(f, d.x, d.y, d.yaw, tilt, front, roll, f.cy, pts);
      const push = wallPush(lv, pts);
      if (!push) break;
      const nx = d.x + push[0], ny = d.y + push[1];
      if (wallCell(lv, Math.floor(nx), Math.floor(ny))) break;
      d.x = nx; d.y = ny; moved = true;
    }
    return moved;
  }

  /**
   * How far over a tall thing can go before it meets a wall: it comes to rest
   * leaning on the wall at that angle, instead of falling through it into the
   * next room. Whatever of it was touching a wall standing up does not count.
   */
  _fallRoom(d) {
    const lv = this.g.level, f = this._foot(d);
    if (!lv || !f) return HALF_PI;
    const pts = this._pts || (this._pts = []);
    const front = this._frontOf(d);
    boxFootprint(f, d.x, d.y, d.yaw, 0, front, 0, 0, pts);
    const was = [];
    for (let k = 0; k < pts.length; k += 2) was.push(wallCell(lv, Math.floor(pts[k]), Math.floor(pts[k + 1])));
    let last = 0;
    for (let a = 0.05; a < HALF_PI + 0.05; a += 0.05) {
      const ang = Math.min(a, HALF_PI);
      boxFootprint(f, d.x, d.y, d.yaw, ang, front, 0, 0, pts);
      for (let k = 0; k < pts.length; k += 2) {
        if (!was[k >> 1] && wallCell(lv, Math.floor(pts[k]), Math.floor(pts[k + 1]))) return Math.max(0.12, last);
      }
      last = ang;
    }
    return HALF_PI;
  }

  /** A piece at rest is laid alongside a wall, not into it. */
  _unwallPiece(b) {
    const mb = this.meshes, lv = this.g.level;
    if (!mb || !lv || !mb.has(b.piece, true)) return;
    const m = mb.get(b.piece, 'ok', b.v, true);
    if (!m || !m.ready) return;
    const f = meshFoot(m);
    const pts = this._pts || (this._pts = []);
    for (let it = 0; it < 3; it++) {
      boxFootprint(f, b.x, b.y, b.yaw, 0, 0, b.roll || 0, f.cy, pts);
      const push = wallPush(lv, pts);
      if (!push) break;
      const nx = b.x + push[0], ny = b.y + push[1];
      if (wallCell(lv, Math.floor(nx), Math.floor(ny))) break;
      b.x = nx; b.y = ny;
    }
  }

  /** Kicked: a chair, a cone, a bin, hoofed across the room, hurting what it meets. */
  _kickFly(d, ca, sa) {
    const g = this.g;
    this._launch(d, ca, sa, d.def.roll ? 7 : 11, d.def.roll ? 0.6 : 3.6, !d.def.roll);
    if (d.def.roll) d.yaw = Math.atan2(sa, ca);
    g.sound.sfx('kick_hit', { pan: g.panAt(d.x, d.y) });
    g.particles.effect({
      x: d.x, y: d.y, z: d.z + 0.3, keys: ['kick_impact0', 'kick_impact1', 'kick_impact2'], fps: 18, size: 0.9, alpha: 0.8,
    });
    const word = { cone: 'CONED', chair: 'CHAIR TOSS', coatrack: 'COAT CHECK', spool: 'ROLL OUT', tvcart: 'TV DINNER', plant: 'REPOTTED', mop: 'MOPPED' }[d.kind] || 'HEADS UP';
    g.hud.popup(word, { size: 11, life: 0.9, y: -30, color: rgba(255, 208, 72, 255) });
    g.chat('brick', 'brick_smash', { chance: 0.25, cooldown: 12 });
  }

  _fly(d, dt) {
    const g = this.g, lv = g.level, mv = d.mv, def = d.def;
    mv.vz -= 9.8 * dt;
    d.lift += mv.vz * dt;
    let landed = false;
    const rolling = def.roll;
    if (d.lift <= 0) {
      d.lift = 0;
      if (mv.vz < -1.8) {
        mv.vz = -mv.vz * 0.32;
        g.sound.sfx(MAT[def.mat].hit, { pan: g.panAt(d.x, d.y), vol: 0.6, rate: 0.9 });
        if (mv.tumble) d.rollRate *= 0.6;
      } else { mv.vz = 0; landed = true; }
      const f = Math.exp(-(rolling ? 0.7 : 2.6) * dt);
      mv.vx *= f; mv.vy *= f;
      d.spin *= Math.exp(-3 * dt);
    }
    // tumbling: settle upright once it is on the floor and slow
    if (mv.tumble) {
      d.roll += d.rollRate * dt;
      if (d.lift <= 0.001) {
        const target = Math.round(d.roll / TAU) * TAU;
        d.roll += (target - d.roll) * (1 - Math.exp(-10 * dt));
        d.rollRate *= Math.exp(-6 * dt);
      }
    }
    d.yaw += d.spin * dt;
    const nx = d.x + mv.vx * dt, ny = d.y + mv.vy * dt;
    const speed = Math.hypot(mv.vx, mv.vy);
    // Its body meets the wall, not just its middle: a chair stops with its
    // legs against the plaster, not with half of it through it.
    const rad = this._radius(d), o0 = this._overlap(d.x, d.y, rad);
    const stopped = (x, y) => lv.blocked(x, y) || this._overlap(x, y, rad) > o0 + 1e-3;
    if (stopped(nx, ny)) {
      // A hard stop at speed finishes it; a soft one just turns it round.
      if (speed > 6.5 && def.hp !== Infinity && d.kind !== 'cone' && d.kind !== 'spool') {
        this._unfly(d, false);
        this.hit(d, 999, d.x, d.y, d.z + 0.3, 'crash');
        return;
      }
      if (stopped(nx, d.y)) mv.vx *= -0.4;
      if (stopped(d.x, ny)) mv.vy *= -0.4;
      if (speed > 2) g.sound.sfx(MAT[def.mat].hit, { pan: g.panAt(d.x, d.y), vol: 0.5 });
      d.spin += (this.rng() - 0.5) * 8;
    } else { d.x = nx; d.y = ny; }
    // spinning or tumbling, the ends of it still stay this side of the wall
    this._unwall(d);
    d.hx = d.x; d.hy = d.y;

    if (speed > 2.5) {
      for (const e of g.enemies) {
        if (!e.alive || mv.hit.has(e)) continue;
        if (dist(d.x, d.y, e.x, e.y) > e.radius + 0.35) continue;
        if (d.lift > e.height) continue;
        mv.hit.add(e);
        const died = e.hurt((def.thud || 8) * clamp(speed / 7, 0.6, 1.8), g, d.x - mv.vx, d.y - mv.vy);
        e.shove(mv.vx / (speed || 1), mv.vy / (speed || 1), rolling ? 6 : 3, rolling ? 1 : 0.5);
        g.sound.sfx('kick_hit', { pan: g.panAt(e.x, e.y), rate: 1.2 });
        g.particles.blood(e.x, e.y, e.z + e.height * 0.5, 5, mv.vx, mv.vy);
        g.hud.hitMark(died);
        if (died && rolling) g.hud.popup('BOWLED OVER', { size: 12, life: 1, color: rgba(255, 208, 72, 255) });
        if (!rolling) { mv.vx *= 0.35; mv.vy *= 0.35; }
      }
      // the player can be clipped by his own furniture, a little
      const p = g.player;
      if (!p.dead && !mv.hitP && d.lift < 0.6 && dist(d.x, d.y, p.x, p.y) < 0.4 && speed > 5 && !mv.fromPlayer) {
        mv.hitP = true;
        p.hurt(4, g, 'furniture');
      }
    }
    if (landed && speed < 0.35 && Math.abs(d.rollRate) < 1 && d.lift <= 0) this._unfly(d, true);
  }

  _unfly(d, settle) {
    const k = this.flying.indexOf(d);
    if (k >= 0) this.flying.splice(k, 1);
    d.flying = false; d.lift = 0; d.mv = null; d.roll = 0; d.rollRate = 0; d.spin = 0;
    this._unwall(d);
    d.hx = d.x; d.hy = d.y;
    if (settle && !d.broken) this._gridAdd(d);
  }

  /**
   * Tip it over. Backed against a wall it comes forward, into the room;
   * standing on its own it goes the way it was pushed. `delay` is how long
   * it rocks first (a kick gives whoever did it a moment to step back).
   */
  topple(d, ux, uy, delay = 0) {
    const g = this.g, def = d.def;
    if (d.fall || d.broken || d.gone || !def.tall) return;
    const backed = d.wall || def.tall === true && d.solid && this._backed(d);
    if (!backed && (ux || uy)) d.yaw = Math.atan2(uy, ux);
    d.fall = { t: -delay, ang: 0, vel: 0, dir: d.yaw, landed: false, max: HALF_PI };
    d.fall.max = this._fallRoom(d);
    d.shake = Math.max(d.shake, delay + 0.2);
    g.sound.sfx('creak_topple', { pan: g.panAt(d.x, d.y) });
    if (delay > 0.2) g.hud.popup('TIMBER', { size: 12, life: 0.9, y: -40, color: rgba(255, 208, 72, 255) });
  }

  _backed(d) {
    const lv = this.g.level;
    const bx = d.x - Math.cos(d.yaw) * 0.6, by = d.y - Math.sin(d.yaw) * 0.6;
    return lv.blocked(bx, by);
  }

  _fall(d, dt) {
    const g = this.g, f = d.fall, def = d.def;
    f.t += dt;
    if (f.t < 0) return;
    // it goes slowly, then all at once
    f.vel += (4 + 10 * Math.sin(f.ang + 0.2)) * dt;
    f.ang += f.vel * dt;
    const lim = f.max || HALF_PI;
    if (f.ang >= lim) {
      f.ang = lim;
      if (!f.landed) this._land(d);
    }
    d.pose = Math.min(4, Math.round(f.ang / HALF_PI * 4));
    if (f.t === 0 || d.pose === 1) this._clearBlock(d);
  }

  /** It lands: the floor shakes, and whatever it landed on is under it. */
  _land(d) {
    const g = this.g, f = d.fall, def = d.def, lv = g.level;
    f.landed = true;
    this._clearBlock(d);
    const ux = Math.cos(f.dir), uy = Math.sin(f.dir);
    const front = (g.art.props && g.art.props.models[d.kind] && g.art.props.models[d.kind].front) || 0.2;
    // how far along the floor it reaches: all of it, or less if it came to
    // rest leaning on a wall
    const lean = f.ang < HALF_PI - 0.01;
    const len = d.h0 * Math.sin(f.ang);
    // the footprint lying down: from its front edge out to where its top came down
    const px = d.x + ux * front, py = d.y + uy * front;
    const cx = px + ux * len * 0.5, cy = py + uy * len * 0.5;
    this._gridDel(d);
    d.hx = cx; d.hy = cy; d.hr = len * 0.5;
    d.h = Math.max(Math.min(d.h0, front * 2 + 0.05), lean ? d.h0 * Math.cos(f.ang) + front : 0);
    this._gridAdd(d);
    const heavy = (def.crush || 40) >= 80;
    g.sound.sfx(heavy ? 'crash_heavy' : MAT[def.mat].brk || 'wood_break', { pan: g.panAt(cx, cy) });
    g.shake = Math.max(g.shake, heavy ? 1.6 : 0.8);
    g.particles.dust(cx, cy, 0.1, heavy ? 10 : 5);
    this._chips(cx, cy, 0.1, 8, MAT[def.mat], 2.8);
    const within = (x, y, r = 0) => {
      const ax = x - px, ay = y - py;
      const along = ax * ux + ay * uy, perp = Math.abs(-ax * uy + ay * ux);
      return along > -0.15 && along < len + 0.2 && perp < 0.32 + r;
    };
    let flat = 0;
    for (const e of g.enemies) {
      if (!e.alive || !within(e.x, e.y, e.radius)) continue;
      const killed = e.hurt(def.crush || 40, g, px, py);
      g.hud.hitMark(killed);
      g.particles.blood(e.x, e.y, 0.2, 18, ux, uy);
      if (killed) {
        flat++;
        if (!e.def.boss) g.gore.blast(e, e.x - ux * 0.3, e.y - uy * 0.3, e.z + e.height, 60, CRUSH_GORE, true);
        g.addDecal(e.x, e.y, e.def.mutant ? 'gore' : 'blood');
      }
    }
    if (flat) {
      g.hud.popup(flat > 1 ? `FLATTENED x${flat}` : 'FLATTENED', { size: 15, life: 1.6, color: rgba(255, 110, 70, 255) });
      g.sound.sfx('splat', { pan: g.panAt(cx, cy) });
      g.chat('brick', 'brick_smash', { cooldown: 5 });
      if (g.bumpStreak) g.bumpStreak(flat);
    }
    const p = g.player;
    if (!p.dead && within(p.x, p.y, 0.1)) {
      p.hurt(Math.min(30, (def.crush || 40) * 0.25), g, 'furniture');
      g.hud.popup(`CRUSHED BY ${def.name}`, { size: 12, life: 1.6, color: rgba(255, 74, 62, 255) });
    }
    // it lands on the rest of the furniture too
    for (const o of lv.decor) {
      if (o === d || !o.def || o.broken || o.gone || o.def.hp === Infinity) continue;
      if (within(o.hx, o.hy)) this.hit(o, def.crush || 40, o.hx, o.hy, 0.2, 'crush', ux, uy);
    }
    // what was in it comes out
    if (def.papers) this.papers(cx, cy, 0.2, Math.ceil(def.papers * 0.5), 1);
    if (d.kind === 'vending' && d.stock > 0) {
      for (let k = 0; k < d.stock + 2; k++) this._spawnCan(cx, cy, 0.3, true);
      d.stock = 0;
    }
    if (d.kind === 'bookshelf' || d.kind === 'shelving') this._throwDebris(d, d.kind === 'bookshelf' ? [['book', 8, 0]] : [['can', 3, 0], ['plank', 2, 4]], 'crash', d.x, d.y);
    if (d.kind === 'candelabra') g.particles.embers(cx, cy, 0.2, 14, 0.7);
    d.hp = Math.min(d.hp, def.hp * 0.45);
    d._fk = null;
  }

  // ------------------------------------------------------------ vents and jets

  /** A hole in something under pressure. */
  _vent(d, dx, dy) {
    const g = this.g, def = d.def;
    d.vented = true;
    if (def.vent === 'foam') {
      // The extinguisher takes off on its own foam.
      this._jetFrom(d, 'foam', dx, dy);
      return;
    }
    if (def.vent === 'gas') {
      // One bottle goes: either it screams off across the room, or it stands
      // there hissing fire until it gives the rest of them a reason.
      g.sound.sfx('gas_hiss', { pan: g.panAt(d.x, d.y) });
      d.state = 'hurt';
      d._fk = null;
      if (this.rng() < 0.55) {
        this._jet('gas', d.hx, d.hy, 0.35, d.yaw + (this.rng() - 0.5) * 1.6, 0);
        g.hud.popup('BOTTLE ROCKET', { size: 12, life: 1.1, color: rgba(255, 180, 60, 255) });
      } else {
        this.spouts.push({ x: d.hx + Math.cos(d.yaw) * 0.2, y: d.hy + Math.sin(d.yaw) * 0.2, z: 0.5, t: 1.6, T: 1.6, fire: true, d });
      }
    }
  }

  /** A prop becomes a rocket: it is gone from where it stood and in the air as a piece. */
  _jetFrom(d, kind, dx, dy) {
    const g = this.g;
    d.gone = true; d.broken = true;
    this._gridDel(d);
    this._clearBlock(d);
    d._fk = null; d._spr = undefined;
    const a = (dx || dy) ? Math.atan2(dy, dx) + (this.rng() - 0.5) * 1.2 : this.rng() * TAU;
    this._jet(kind, d.hx, d.hy, 0.15, a, kind === 'foam' ? 3 : 1);
    g.hud.popup(kind === 'foam' ? 'FOAM ROCKET' : 'BOTTLE ROCKET', { size: 12, life: 1.1, color: rgba(255, 208, 72, 255) });
  }

  _jet(kind, x, y, z, ang, variant) {
    const g = this.g;
    const b = this.spawnDebris('bottle', variant, x, y, z, Math.cos(ang) * 3, Math.sin(ang) * 3, 2.5, {
      jet: { kind, t: kind === 'gas' ? 1.5 : 2.2, ang, snd: 0 },
    });
    b.yaw = ang;
    b.rollRate = (this.rng() - 0.5) * 20;
    g.sound.sfx(kind === 'gas' ? 'gas_hiss' : 'foam_spray', { pan: g.panAt(x, y) });
    this.jets.push(b);
    return b;
  }

  _updateJet(b, dt) {
    const g = this.g, j = b.jet, rng = this.rng;
    j.t -= dt;
    // thrust along where the nozzle points, which wanders
    j.ang += (rng() - 0.5) * 9 * dt;
    const thrust = j.kind === 'gas' ? 26 : 16;
    b.vx += Math.cos(j.ang) * thrust * dt;
    b.vy += Math.sin(j.ang) * thrust * dt;
    b.vz += (j.kind === 'gas' ? 7 : 5) * dt;
    const sp = Math.hypot(b.vx, b.vy), cap = j.kind === 'gas' ? 9 : 7;
    if (sp > cap) { b.vx *= cap / sp; b.vy *= cap / sp; }
    b.yaw = j.ang;
    // the plume
    const bx = b.x - Math.cos(j.ang) * 0.2, by = b.y - Math.sin(j.ang) * 0.2;
    if (j.kind === 'gas') {
      g.particles.spawn({ x: bx, y: by, z: b.z + 0.05, vx: -Math.cos(j.ang) * 3, vy: -Math.sin(j.ang) * 3, vz: 0.4,
        life: 0.35, size: 0.14, r: 255, g: 160 + (rng() * 60) | 0, b: 50, drag: 2, grav: -1, additive: true, grow: 0.4 });
      if (rng() < 0.5) g.particles.smoke(bx, by, b.z, 1, 0.4);
    } else {
      for (let q = 0; q < 2; q++) {
        g.particles.spawn({ x: bx, y: by, z: b.z + 0.05, vx: -Math.cos(j.ang) * 2.5 + (rng() - 0.5), vy: -Math.sin(j.ang) * 2.5 + (rng() - 0.5), vz: 0.2,
          life: 1.2, size: 0.18, r: 246, g: 246, b: 240, drag: 1.4, grav: 1.2, additive: false, grow: 0.5, fadePow: 1.2 });
      }
    }
    j.snd -= dt;
    if (j.snd <= 0) { j.snd = 0.7; g.sound.sfx(j.kind === 'gas' ? 'gas_hiss' : 'foam_spray', { pan: g.panAt(b.x, b.y), vol: 0.7 }); }
    // it hits people
    for (const e of g.enemies) {
      if (!e.alive || (b._hitE && b._hitE.has(e))) continue;
      if (dist(b.x, b.y, e.x, e.y) > e.radius + 0.25 || b.z > e.height + 0.2) continue;
      (b._hitE || (b._hitE = new Set())).add(e);
      const killed = e.hurt(j.kind === 'gas' ? 30 : 22, g, b.x, b.y);
      e.shove(b.vx, b.vy, 5, 1);
      g.sound.sfx('kick_hit', { pan: g.panAt(e.x, e.y), rate: 1.3 });
      g.hud.hitMark(killed);
      if (j.kind === 'gas') { j.t = 0; break; }
    }
    if (j.t <= 0) {
      b.jet = null;
      const k = this.jets.indexOf(b);
      if (k >= 0) this.jets.splice(k, 1);
      if (j.kind === 'gas') {
        g.sound.sfx('barrel_explode', { pan: g.panAt(b.x, b.y) });
        g.explodeAt(b.x, b.y, Math.max(0.3, b.z), 2.8, 75);
        const i = this.debris.indexOf(b);
        if (i >= 0) this.debris.splice(i, 1);
      } else {
        this._foam(b.x, b.y, b.z + 0.1, 30);
        g.particles.smoke(b.x, b.y, b.z, 6, 0.8, [230, 230, 226]);
        b.rollRate = 0;
      }
    }
  }

  _updateDebris(dt) {
    const g = this.g, lv = g.level, D = this.debris;
    for (let i = D.length - 1; i >= 0; i--) {
      const b = D[i];
      if (b.jet) this._updateJet(b, dt);
      if (b.rest) { b.age += dt; continue; }
      b.vz -= 9.8 * dt;
      b.z += b.vz * dt;
      const nx = b.x + b.vx * dt, ny = b.y + b.vy * dt;
      if (lv.blocked(nx, ny)) {
        if (lv.blocked(nx, b.y)) b.vx *= -0.45;
        if (lv.blocked(b.x, ny)) b.vy *= -0.45;
        if (b.jet) b.jet.ang = Math.atan2(b.vy, b.vx) + (this.rng() - 0.5) * 0.8;
      } else { b.x = nx; b.y = ny; }
      if (b.z > 1.25) { b.z = 1.25; b.vz = -Math.abs(b.vz) * 0.4; }
      b.yaw += b.spin * dt;
      b.roll += b.rollRate * dt;
      if (b.z <= 0) {
        b.z = 0;
        if (b.vz < -1.4) {
          b.vz = -b.vz * 0.3;
          b.rollRate *= 0.5;
          if (b.bounced++ < 2 && g.time - this._snd > 0.04) {
            this._snd = g.time;
            const sfx = b.piece === 'can' ? 'can_clunk' : b.piece === 'glass' || b.piece === 'tile' ? 'coin_clink' : b.piece === 'meat' ? 'meat_thud'
              : b.piece === 'plank' || b.piece === 'book' ? 'wood_hit' : 'metal_hit';
            g.sound.sfx(sfx, { pan: g.panAt(b.x, b.y), vol: 0.35, rate: 1.2 });
          }
        } else b.vz = 0;
        const f = Math.exp(-4 * dt);
        b.vx *= f; b.vy *= f; b.spin *= f;
        // come to rest lying flat
        const target = Math.round(b.roll / Math.PI) * Math.PI;
        b.roll += (target - b.roll) * (1 - Math.exp(-12 * dt));
        b.rollRate *= Math.exp(-8 * dt);
        if (!b.jet && Math.hypot(b.vx, b.vy) < 0.15 && Math.abs(b.vz) < 0.1) { b.rest = true; b.roll = target; this._unwallPiece(b); }
      }
    }
  }

  _foam(x, y, z, n) {
    const P = this.g.particles, rng = this.rng;
    for (let i = 0; i < n; i++) {
      const a = rng() * TAU, s = randRange(rng, 0.4, 2.6);
      P.spawn({
        x, y, z, vx: Math.cos(a) * s, vy: Math.sin(a) * s, vz: randRange(rng, 0.8, 3.6),
        life: randRange(rng, 0.7, 1.7), size: randRange(rng, 0.06, 0.15),
        r: 246, g: 240, b: 226, drag: 1.3, grav: 4.2, additive: false, fadePow: 1.2, grow: 0.05,
      });
    }
  }

  _spray(x, y, z, n, power) {
    const P = this.g.particles, rng = this.rng;
    for (let i = 0; i < n; i++) {
      const a = rng() * TAU, s = randRange(rng, 0.3, 1.8) * power;
      P.spawn({
        x, y, z, vx: Math.cos(a) * s, vy: Math.sin(a) * s, vz: randRange(rng, 2, 5.4) * power,
        life: randRange(rng, 0.6, 1.3), size: randRange(rng, 0.03, 0.08),
        r: 150, g: 196, b: 238, drag: 0.5, grav: 9, additive: false, hard: true, fadePow: 0.5,
      });
    }
  }

  _flame(s, dt) {
    const g = this.g, P = g.particles, rng = this.rng;
    const n = Math.ceil(dt * 70);
    const a = s.d ? s.d.yaw : 0;
    for (let i = 0; i < n; i++) {
      const sp = randRange(rng, 1.5, 3.2);
      P.spawn({
        x: s.x, y: s.y, z: s.z, vx: Math.cos(a) * sp + (rng() - 0.5), vy: Math.sin(a) * sp + (rng() - 0.5), vz: randRange(rng, 0.2, 1.2),
        life: randRange(rng, 0.25, 0.5), size: randRange(rng, 0.08, 0.16),
        r: 255, g: 150 + (rng() * 80) | 0, b: 40, drag: 1.6, grav: -1.5, additive: true, grow: 0.5,
      });
    }
    // anything standing in the jet cooks
    for (const e of g.enemies) {
      if (!e.alive) continue;
      const ax = e.x - s.x, ay = e.y - s.y;
      const along = ax * Math.cos(a) + ay * Math.sin(a), perp = Math.abs(-ax * Math.sin(a) + ay * Math.cos(a));
      if (along > 0 && along < 1.6 && perp < 0.4) {
        const killed = e.hurt(40 * dt, g, s.x, s.y);
        if (killed) g.hud.hitMark(true);
      }
    }
  }

  /** A small reward for wrecking the place: ammo, or a first aid kit. */
  _loot(x, y) {
    const g = this.g;
    const kind = g.rng() < 0.62 ? 'ammo' : 'medkit_small';
    g.items.push({ kind, x, y, z: 0, taken: false, bob: g.rng() * TAU });
    g.hud.popup(kind === 'ammo' ? 'SUPPLIES' : 'FIRST AID', { size: 10, life: 1.2, y: -44, dy: -8, color: rgba(126, 232, 128, 255) });
  }

  // ------------------------------------------------------------------ litter

  papers(x, y, z, n, power) {
    const rng = this.rng;
    for (let i = 0; i < n; i++) {
      if (this.litter.length >= CAP_LITTER) this._evict('paper');
      const a = rng() * TAU, s = randRange(rng, 0.4, 1.8) * power;
      this.litter.push({
        kind: 'paper', x, y, z: z + rng() * 0.1,
        vx: Math.cos(a) * s, vy: Math.sin(a) * s, vz: randRange(rng, 1.2, 4.2) * power,
        ph: rng() * TAU, t: 0, rest: false, age: 0, life: randRange(rng, 30, 60),
        tint: pickOf(rng, PAPER_TINTS),
      });
    }
  }

  _evict(kind) {
    let k = this.litter.findIndex((l) => l.kind === kind && l.rest);
    if (k < 0) k = this.litter.findIndex((l) => l.kind === kind);
    if (k < 0) k = 0;
    this.litter.splice(k, 1);
  }

  /** A can. If it is a live one it heals whoever picks it up. */
  _spawnCan(x, y, z, toss, toward) {
    const rng = this.rng;
    if (this.litter.length >= CAP_LITTER) this._evict('paper');
    const a = toward !== undefined ? toward + randRange(rng, -0.4, 0.4) : rng() * TAU;
    const s = toss ? randRange(rng, 1.2, 3.4) : randRange(rng, 0.3, 0.9);
    this.litter.push({
      kind: 'can', x, y, z, vx: Math.cos(a) * s, vy: Math.sin(a) * s, vz: toss ? randRange(rng, 2.2, 4.6) : 1.2,
      ph: rng() * TAU, t: 0, rest: false, age: 0, life: 90, pick: 'cola', tint: pickOf(rng, CAN_TINTS),
    });
  }

  _coin(x, y, z, value) {
    const rng = this.rng;
    if (this.litter.length >= CAP_LITTER) this._evict('paper');
    const a = rng() * TAU, s = randRange(rng, 0.6, 2.4);
    this.litter.push({
      kind: 'coin', x, y, z, vx: Math.cos(a) * s, vy: Math.sin(a) * s, vz: randRange(rng, 2.6, 5),
      ph: rng() * TAU, t: 0, rest: false, age: 0, life: 90, value, tint: 0,
    });
  }

  _updateLitter(dt) {
    const g = this.g, lv = g.level, p = g.player;
    const L = this.litter;
    for (let i = L.length - 1; i >= 0; i--) {
      const l = L[i];
      l.t += dt;
      if (!l.rest) {
        if (l.kind === 'paper') {
          // A sheet does not fall, it argues with the air about it.
          l.vz += (-0.5 - l.vz) * (1 - Math.exp(-2.4 * dt));
          const drag = Math.exp(-1.7 * dt);
          l.vx *= drag; l.vy *= drag;
          l.vx += Math.sin(l.t * 4.3 + l.ph) * 1.6 * dt;
          l.vy += Math.cos(l.t * 3.7 + l.ph) * 1.6 * dt;
        } else {
          l.vz -= 9.6 * dt;
        }
        const nx = l.x + l.vx * dt, ny = l.y + l.vy * dt;
        if (lv.blocked(nx, ny)) { l.vx *= -0.3; l.vy *= -0.3; } else { l.x = nx; l.y = ny; }
        l.z += l.vz * dt;
        if (l.z <= 0.02) {
          l.z = 0.02;
          if (l.kind !== 'paper' && Math.abs(l.vz) > 1.1) {
            l.vz = -l.vz * (l.kind === 'coin' ? 0.5 : 0.36);
            l.vx *= 0.7; l.vy *= 0.7;
            if (l.kind === 'coin' && g.time - this._snd > 0.05) { this._snd = g.time; g.sound.sfx('coin_clink', { pan: g.panAt(l.x, l.y), vol: 0.5 }); }
            if (l.kind === 'can' && g.time - this._snd > 0.05) { this._snd = g.time; g.sound.sfx('can_clunk', { pan: g.panAt(l.x, l.y), vol: 0.45 }); }
          } else {
            l.vz = 0; l.vx *= 0.8; l.vy *= 0.8;
            if (l.kind === 'paper' || Math.hypot(l.vx, l.vy) < 0.25) l.rest = true;
          }
        }
      } else {
        l.age += dt;
        if (l.age > l.life) { L.splice(i, 1); continue; }
      }
      if (l.pick || l.value) {
        const near = dist(l.x, l.y, p.x, p.y);
        if (near < 0.6 && l.z < 0.5 && !p.dead && this._collect(l)) { L.splice(i, 1); continue; }
      }
    }
  }

  /** Walk over it. False leaves it where it lies (a soda is no use to a man at full health). */
  _collect(l) {
    const g = this.g, p = g.player;
    if (l.value) {
      p.score += l.value;
      g.sound.sfx('coin_clink', { vol: 0.8 });
      g.hud.popup(`+${l.value}`, { size: 9, life: 0.8, y: -30, dy: -12, color: rgba(255, 216, 90, 255) });
      return true;
    }
    if (l.pick === 'cola') {
      if (p.health >= p.maxHealth) return false;
      const got = p.heal(6);
      if (got <= 0) return false;
      g.sound.sfx('soda_pop');
      g.after(0.3, () => g.sound.sfx('pickup_health', { vol: 0.3 }));
      g.hud.popup('+6 VITALS  COLA', { size: 11, life: 1.3, color: rgba(126, 232, 128, 255) });
      return true;
    }
    return true;
  }

  // -------------------------------------------------------------- the boot

  /** The nearest prop in front of the player that satisfies `want`. */
  _front(p, range, cosArc, want) {
    const lv = this.g.level;
    const ca = Math.cos(p.ang), sa = Math.sin(p.ang);
    let best = null, bs = Infinity;
    for (const d of lv.decor || []) {
      if (!d.def || d.broken || d.flying || d.gone || !want(d)) continue;
      const dx = d.hx - p.x, dy = d.hy - p.y, r = Math.hypot(dx, dy);
      if (r > range + (d.hr > 0.3 ? d.hr - 0.26 : 0)) continue;
      const c = (dx * ca + dy * sa) / (r || 1);
      if (c < cosArc && r > 0.55) continue;
      const s = r - c;
      if (s < bs) { bs = s; best = d; }
    }
    return best;
  }

  /** The nearest thing the saw can chew on, straight ahead. */
  sawFront(p, reach) {
    return this._front(p, reach, 0.72, (d) => d.def.hp !== Infinity);
  }

  /** The boot. True if it found something to hit. */
  kick(p, range, cosArc) {
    const g = this.g;
    const d = this._front(p, range, cosArc, (o) => o.def.hp !== Infinity || !!o.def.ring);
    if (!d) return false;
    const def = d.def, ca = Math.cos(p.ang), sa = Math.sin(p.ang);
    g.hitStop = Math.max(g.hitStop, 0.05);
    g.input.rumble(0.5, 0.35, 110);
    if (def.hp === Infinity) { this._shrug(d, d.x, d.y, d.z + d.h * 0.5); return true; }

    if (def.kick === 'jet') {
      g.sound.sfx('kick_hit', { pan: g.panAt(d.x, d.y) });
      this._jetFrom(d, 'foam', ca, sa);
      return true;
    }
    if (def.kick === 'fly' && !d.solid) { this._kickFly(d, ca, sa); if (d.mv) d.mv.fromPlayer = true; return true; }
    g.sound.sfx('kick_hit', { pan: g.panAt(d.x, d.y), vol: 0.8 });
    // Tall things rock, and the second boot (or a weak one) sends them over.
    if (def.tall && !d.fall) {
      d.rock++;
      if (def.tall === 'flip' || d.rock >= 2 || d.hp < def.hp * 0.5 || !d.solid) {
        this.topple(d, ca, sa, def.tall === 'flip' ? 0 : 0.35);
        this.hit(d, def.kick * 0.5, d.hx - ca * 0.2, d.hy - sa * 0.2, d.z + d.h * 0.5, 'kick', ca, sa);
        if (def.tall === 'flip') g.hud.popup('TABLE FLIP', { size: 12, life: 1, color: rgba(255, 208, 72, 255) });
        return true;
      }
      d.shake = 0.6;
      g.sound.sfx('creak_topple', { pan: g.panAt(d.x, d.y), vol: 0.6, rate: 1.2 });
    }
    this.hit(d, def.kick, d.hx - ca * 0.2, d.hy - sa * 0.2, d.z + d.h * 0.5, 'kick', ca, sa);
    if (d.broken) return true;

    // The rest is what kicking each one does that shooting it does not.
    if (d.kind === 'vending') {
      g.sound.sfx('can_rattle', { pan: g.panAt(d.x, d.y) });
      d.shake = 0.5;
      g.chat('brick', 'brick_vending_kick', { cooldown: 5 });
      if (d.stock > 0 && (d.jam || g.rng() < 0.5)) {
        const n = d.jam ? Math.min(2, d.stock) : 1;
        d.jam = false;
        g.after(0.35, () => { if (!d.broken) this._dispense(d, n, p); });
      } else if (d.stock <= 0) g.hud.popup('EMPTY', { size: 10, life: 0.9, y: -30, color: rgba(255, 74, 62, 255) });
    } else if (d.kind === 'locker' && !d.opened && g.rng() < 0.3) {
      this._openLocker(d);
    } else if (d.kind === 'filing' || d.kind === 'desk' || d.kind === 'bookshelf') {
      this.papers(d.x, d.y, d.z + d.h * 0.8, 6, 0.8);
      g.sound.sfx('paper_flurry', { pan: g.panAt(d.x, d.y), vol: 0.6 });
    } else if (d.kind === 'cooler') {
      this._spray(d.x, d.y, d.z + 0.4, 8, 0.8);
      g.sound.sfx('water_burst', { pan: g.panAt(d.x, d.y), vol: 0.4 });
    } else if (d.kind === 'gascyl' && !d.vented && g.rng() < 0.35) {
      this._vent(d, ca, sa);
    }
    return true;
  }

  // ---------------------------------------------------------------- the use key

  /** The prop the use key would act on, with a short label for the HUD. */
  _useTarget(p) {
    return this._front(p, REACH, 0.74, (d) => d.def.use && !d.fall && this._usable(d));
  }

  _usable(d) {
    switch (d.def.use) {
      case 'vending': return true;
      case 'cooler': return d.gal > 0;
      case 'locker': return !d.opened;
      case 'filing': return d.uses < 3;
      case 'desk': return d.uses < 2;
      case 'console': return !d.hacked;
      case 'pinball': return d.uses < 3 && !d.busy;
      case 'copier': return d.uses < 2 && !d.busy;
      case 'sink': return d.uses < 2;
      default: return false;
    }
  }

  hint(p) {
    const d = this._useTarget(p);
    if (!d) {
      // Duke's rule: a working toilet is a medkit with a flush.
      const lv = this.g.level, dx = Math.cos(p.ang), dy = Math.sin(p.ang);
      for (let r = 0.4; r <= REACH; r += 0.35) {
        const cx = (p.x + dx * r) | 0, cy = (p.y + dy * r) | 0;
        if (!lv.inBounds(cx, cy)) break;
        const i = cy * lv.W + cx;
        if (lv.fixture && lv.fixture[i]) return lv.fixtureUsed[i] ? null : 'RELIEVE YOURSELF';
      }
      return null;
    }
    switch (d.def.use) {
      case 'vending': return d.stock <= 0 ? 'SOLD OUT' : d.jam ? 'JAMMED: KICK IT' : 'BUY A SODA';
      case 'cooler': return 'DRINK';
      case 'locker': return 'OPEN LOCKER';
      case 'filing': return 'OPEN DRAWER';
      case 'desk': return 'SEARCH DESK';
      case 'console': return 'HACK IT';
      case 'pinball': return 'PLAY';
      case 'copier': return 'MAKE A COPY';
      case 'sink': return 'WASH UP';
      default: return null;
    }
  }

  /** The use key. True if a prop took it. */
  use(p) {
    const d = this._useTarget(p);
    if (!d) return false;
    const g = this.g;
    d.shake = 0.12;
    switch (d.def.use) {
      case 'vending': this._useVending(d, p); break;
      case 'cooler': this._useCooler(d, p); break;
      case 'locker': this._openLocker(d); break;
      case 'filing': this._useDrawer(d, 'CLASSIFIED', 0.16); break;
      case 'desk': this._useDrawer(d, 'JUST PAPERWORK', 0.3); break;
      case 'console': this._useConsole(d, p); break;
      case 'pinball': this._usePinball(d, p); break;
      case 'copier': this._useCopier(d, p); break;
      case 'sink': this._useSink(d, p); break;
      default: return false;
    }
    g.input.rumble(0.2, 0.15, 60);
    return true;
  }

  _useVending(d, p) {
    const g = this.g;
    if (d.busy > 0) return;
    if (d.stock <= 0) {
      g.sound.sfx('buzz_deny', { pan: g.panAt(d.x, d.y) });
      g.hud.popup('SOLD OUT', { size: 12, life: 1, color: rgba(255, 74, 62, 255) });
      g.chat('brick', 'brick_vending_empty', { cooldown: 6 });
      return;
    }
    g.sound.sfx('coin_clink', { pan: g.panAt(d.x, d.y) });
    d.busy = 0.8;
    g.after(0.7, () => {
      if (d.broken) return;
      const roll = g.rng();
      if (d.jam || roll < 0.22) {
        d.jam = true;
        g.sound.sfx('buzz_deny', { pan: g.panAt(d.x, d.y) });
        g.hud.popup('IT ATE YOUR QUARTER', { size: 12, life: 1.6, color: rgba(255, 120, 80, 255) });
        g.chat('brick', 'brick_vending_eaten', { cooldown: 4 });
        g.chat('mutter', 'mutter_vending', { chance: 0.6, cooldown: 12, delay: 1.4 });
        d.shake = 0.3;
      } else if (roll > 0.86) {
        this._dispense(d, Math.min(2, d.stock), p);
        for (let k = 0; k < 5; k++) this._coin(d.x, d.y, d.z + 0.4, 25);
        g.sound.sfx('coin_clink', { pan: g.panAt(d.x, d.y) });
        g.hud.popup('JACKPOT', { size: 15, life: 1.6, color: rgba(255, 216, 72, 255) });
      } else {
        this._dispense(d, 1, p);
      }
    });
  }

  _dispense(d, n, p) {
    const g = this.g;
    const toward = Math.atan2(p.y - d.y, p.x - d.x);
    for (let k = 0; k < n && d.stock > 0; k++) {
      d.stock--;
      g.after(k * 0.22, () => {
        if (d.broken) return;
        g.sound.sfx('can_clunk', { pan: g.panAt(d.x, d.y) });
        this._spawnCan(d.x + Math.cos(toward) * 0.45, d.y + Math.sin(toward) * 0.45, d.z + 0.4, false, toward);
        d.shake = 0.2;
      });
    }
    g.hud.popup(n > 1 ? 'TWO SODAS' : 'SODA', { size: 12, life: 1.2, color: rgba(255, 236, 190, 255) });
    g.chat('brick', 'brick_vending', { cooldown: 5, delay: 0.5 });
  }

  _useCooler(d, p) {
    const g = this.g;
    if (p.health >= p.maxHealth) {
      g.hud.popup('NOT THIRSTY', { size: 11, life: 0.9, color: rgba(200, 194, 180, 255) });
      return;
    }
    d.gal--;
    p.heal(5);
    g.sound.sfx('pickup_health', { vol: 0.5, pan: g.panAt(d.x, d.y) });
    this._spray(d.x, d.y, d.z + d.h * 0.5, 3, 0.4);
    g.hud.popup(d.gal > 0 ? '+5 VITALS  WATER' : '+5 VITALS  LAST OF THE WATER', { size: 11, life: 1.3, color: rgba(126, 232, 128, 255) });
    g.chat('brick', 'brick_cooler', { chance: 0.6, cooldown: 8 });
  }

  _useSink(d, p) {
    const g = this.g;
    d.uses++;
    this._spray(d.x, d.y, d.z + d.h * 0.8, 6, 0.4);
    g.sound.sfx('water_burst', { vol: 0.35, pan: g.panAt(d.x, d.y) });
    if (p.health < p.maxHealth) {
      p.heal(3);
      g.hud.popup('+3 VITALS  CLEAN HANDS', { size: 11, life: 1.3, color: rgba(126, 232, 128, 255) });
    } else {
      g.hud.popup('SQUEAKY CLEAN', { size: 11, life: 1.1, color: rgba(200, 220, 240, 255) });
    }
  }

  _useCopier(d, p) {
    const g = this.g;
    d.uses++;
    d.busy = 1.4;
    g.sound.sfx('console_blip', { pan: g.panAt(d.x, d.y) });
    g.after(0.5, () => { if (!d.broken) { this.papers(d.x, d.y, d.z + d.h, 6, 0.9); g.sound.sfx('paper_flurry', { pan: g.panAt(d.x, d.y), vol: 0.6 }); } });
    const lines = d.uses === 1 ? ['COPIES OF YOUR FACE: 6', 'NOT A GOOD ANGLE'] : ['COPIES OF YOUR ASS: 6', 'FILED UNDER EVIDENCE'];
    g.hud.popup(lines[0], { size: 12, life: 1.5, color: rgba(255, 236, 190, 255) });
    g.after(0.9, () => g.hud.popup(lines[1], { size: 10, life: 1.3, y: -20, color: rgba(200, 194, 180, 255) }));
    p.score += 50;
    g.chat('mutter', 'mutter_prop', { chance: 0.5, cooldown: 12, delay: 1.2 });
  }

  _openLocker(d) {
    const g = this.g;
    d.opened = true;
    d._fk = null;
    if (this.meshes) this.meshes.get(d.kind, 'open', d.variant);
    const st = this.studio;
    if (!(st && st.has(d.kind))) {
      const src = g.art.sprites[d.key];
      if (src) { d.altFrame = openedFrame(src); d.altH = d.h; d._spr = undefined; }
    }
    g.sound.sfx('metal_hit', { pan: g.panAt(d.x, d.y), rate: 0.8 });
    g.after(0.1, () => g.sound.sfx('door_open', { vol: 0.35, pan: g.panAt(d.x, d.y) }));
    const roll = g.rng();
    if (roll < 0.3) {
      g.items.push({ kind: 'ammo', x: d.x, y: d.y, z: 0, taken: false, bob: 0 });
      g.hud.popup('SOMEBODY LEFT AMMO IN HERE', { size: 10, life: 1.6, color: rgba(255, 186, 64, 255) });
    } else if (roll < 0.55) {
      g.items.push({ kind: 'medkit_small', x: d.x, y: d.y, z: 0, taken: false, bob: 0 });
      g.hud.popup('FIRST AID', { size: 11, life: 1.4, color: rgba(126, 232, 128, 255) });
    } else if (roll < 0.8) {
      const n = 3 + ((g.rng() * 4) | 0);
      for (let k = 0; k < n; k++) this._coin(d.x, d.y, d.z + 0.5, 25);
      g.sound.sfx('coin_clink', { pan: g.panAt(d.x, d.y) });
      g.hud.popup('LOOSE CHANGE', { size: 11, life: 1.4, color: rgba(255, 216, 90, 255) });
    } else {
      g.hud.popup('GYM SOCKS', { size: 12, life: 1.4, color: rgba(200, 194, 180, 255) });
    }
    g.chat('brick', 'brick_locker', { cooldown: 6 });
  }

  _useDrawer(d, label, richness) {
    const g = this.g;
    d.uses++;
    this.papers(d.x, d.y, d.z + d.h * 0.8, 12, 1);
    g.sound.sfx('paper_flurry', { pan: g.panAt(d.x, d.y) });
    g.after(0.05, () => g.sound.sfx('metal_hit', { pan: g.panAt(d.x, d.y), vol: 0.5, rate: 1.3 }));
    if (g.rng() < richness) {
      const kind = g.rng() < 0.5 ? 'ammo' : 'medkit_small';
      g.items.push({ kind, x: d.x, y: d.y, z: 0, taken: false, bob: 0 });
      g.hud.popup(kind === 'ammo' ? 'AMMO IN THE DRAWER' : 'MEDICAL FILE. AND A KIT', { size: 10, life: 1.5, color: rgba(126, 232, 128, 255) });
    } else {
      g.player.score += 100;
      g.hud.popup(`${label}  +100`, { size: 11, life: 1.3, color: rgba(255, 236, 190, 255) });
    }
    g.chat('brick', 'brick_papers', { cooldown: 8, chance: 0.7 });
  }

  _useConsole(d, p) {
    const g = this.g;
    d.hacked = true;
    g.sound.sfx('console_blip', { pan: g.panAt(d.x, d.y) });
    g.particles.sparks(d.x, d.y, d.z + d.h * 0.7, 6, 1.4, [120, 220, 255], 3);
    g.chat('brick', 'brick_console', { cooldown: 4 });
    if (g.rng() < 0.55) {
      g.after(0.9, () => {
        g.level.markVisited(p.x, p.y, 20);
        g.hud.popup('FLOOR PLAN DOWNLOADED', { size: 12, life: 2, color: rgba(120, 220, 255, 255) });
        g.sound.sfx('objective', { vol: 0.5 });
      });
    } else {
      g.after(0.9, () => {
        g.sound.sfx('buzz_deny', { pan: g.panAt(d.x, d.y) });
        g.hud.popup('ACCESS DENIED', { size: 12, life: 1.6, color: rgba(255, 74, 62, 255) });
        g.chat('mutter', 'mutter_prop', { cooldown: 8, delay: 0.6 });
      });
    }
  }

  _usePinball(d, p) {
    const g = this.g;
    d.uses++;
    d.busy = 2;
    g.sound.sfx('pinball_play', { pan: g.panAt(d.x, d.y) });
    g.chat('brick', 'brick_pinball', { cooldown: 5, delay: 0.3 });
    g.after(1.7, () => {
      if (d.broken) return;
      if (g.rng() < 0.2) {
        g.sound.sfx('buzz_deny', { pan: g.panAt(d.x, d.y) });
        g.hud.popup('TILT', { size: 16, life: 1.4, color: rgba(255, 74, 62, 255) });
      } else {
        const pts = 300 + ((g.rng() * 22) | 0) * 100;
        p.score += pts;
        g.sound.sfx('combo_up', { vol: 0.6 });
        g.hud.popup(`HIGH SCORE  +${pts}`, { size: 13, life: 1.8, color: rgba(255, 216, 72, 255) });
      }
    });
  }

  // ---------------------------------------------------------------- per frame

  update(dt) {
    const g = this.g, lv = g.level, p = g.player;
    if (!lv || !lv.decor) return;
    this._updateLitter(dt);
    for (let i = this.flying.length - 1; i >= 0; i--) this._fly(this.flying[i], dt);
    this._updateDebris(dt);
    // Walk into a chair and it goes where you are going. Enemies too.
    const movers = this._movers || (this._movers = []);
    movers.length = 0;
    if (!p.dead && Math.hypot(p.vx, p.vy) > 0.6) movers.push([p.x, p.y, p.vx, p.vy, 0.3]);
    // and a body thrown across the room takes the furniture with it
    const bodies = this._bodies || (this._bodies = []);
    bodies.length = 0;
    for (const e of g.enemies) {
      const kv = Math.hypot(e.kvx || 0, e.kvy || 0);
      if (kv > 5) bodies.push([e.x, e.y, e.kvx, e.kvy, e.radius, kv, e]);
    }
    for (const e of g.enemies) {
      if (e.alive && e._px !== undefined && dt > 0) {
        const vx = (e.x - e._px) / dt, vy = (e.y - e._py) / dt;
        if (vx * vx + vy * vy > 0.36 && vx * vx + vy * vy < 400) movers.push([e.x, e.y, vx, vy, e.radius]);
      }
      e._px = e.x; e._py = e.y;
    }
    for (const d of lv.decor) {
      if (d.busy > 0) d.busy = Math.max(0, d.busy - dt);
      if (d.shake > 0) d.shake = Math.max(0, d.shake - dt);
      if (d.fall && !d.fall.landed) this._fall(d, dt);
      if (bodies.length && d.def && d.def.hp !== Infinity && !d.flying && !d.broken && !d.gone) {
        for (const [bx, by, vx, vy, r, kv, e] of bodies) {
          if (Math.hypot(d.hx - bx, d.hy - by) > r + (d.solid ? 0.55 : 0.3)) continue;
          if ((d._hitBy || null) === e) continue;
          d._hitBy = e;
          const ux = vx / kv, uy = vy / kv;
          this.hit(d, kv * 2.5, d.hx, d.hy, d.z + d.h * 0.4, 'crash', ux, uy);
          if (d.broken || d.gone) break;
          if (d.def.mass === 'light' && !d.solid) this._launch(d, ux, uy, kv * 0.8, 2 + kv * 0.1, true);
          else if (d.def.tall && !d.fall && kv > 8) this.topple(d, ux, uy, 0);
          break;
        }
      }
      if (movers.length && d.def && d.def.mass === 'light' && !d.solid && !d.flying && !d.broken && !d.gone) {
        for (const [mx, my, vx, vy, r] of movers) {
          const dx = d.x - mx, dy = d.y - my, q = Math.hypot(dx, dy);
          if (q > r + 0.22 || dx * vx + dy * vy <= 0) continue;
          const sp = Math.hypot(vx, vy);
          // along the way it was going, and a little out of the way
          this.shove(d, (vx / sp) * 0.8 + (dx / (q || 1)) * 0.4, (vy / sp) * 0.8 + (dy / (q || 1)) * 0.4, Math.min(2.4, sp * 1.1), 0);
          if (g.time - (d._snd || -9) > 0.3) { d._snd = g.time; g.sound.sfx(MAT[d.def.mat].hit, { pan: g.panAt(d.x, d.y), vol: 0.35, rate: 1.1 }); }
          break;
        }
      }
    }
    // burst pipes, and a bottle venting fire
    for (let i = this.spouts.length - 1; i >= 0; i--) {
      const s = this.spouts[i];
      s.t -= dt;
      if (s.fire) {
        if (s.t <= 0 || !s.d || s.d.broken) {
          this.spouts.splice(i, 1);
          // the rest of the bottles go with it
          if (s.d && !s.d.broken) this.breakProp(s.d, 'blast', s.x, s.y);
          continue;
        }
        this._flame(s, dt);
        s._n = (s._n || 0) - dt;
        if (s._n <= 0) { s._n = 0.8; g.sound.sfx('gas_hiss', { pan: g.panAt(s.x, s.y), vol: 0.6 }); }
        continue;
      }
      if (s.t <= 0) { this.spouts.splice(i, 1); continue; }
      const k = s.t / s.T;
      this._spray(s.x, s.y, s.z, Math.ceil(dt * 90 * (0.4 + k)), 0.9 + k * 0.5);
      s._n = (s._n || 0) - dt;
      if (s._n <= 0) { s._n = 1.3; g.sound.sfx('water_burst', { pan: g.panAt(s.x, s.y), vol: 0.35 + 0.4 * k }); }
    }
    this.hintText = p.dead ? null : this.hint(p);
    // frames for the studio, a little each frame
    const st = this.studio;
    if (st) st.pump(2.5);
    if (this.meshes) this.meshes.pump(3);
  }

  /** The billboards for every piece of furniture, turned to the camera. */
  collectDecor(out, cam, art, solids = null) {
    const lv = this.g.level;
    if (!lv || !lv.decor) return;
    const st = this.studio;
    const mb = solids ? this.meshes : null;
    const sx = -Math.sin(cam.ang), sy = Math.cos(cam.ang);
    for (let i = 0; i < lv.decor.length; i++) {
      const d = lv.decor[i];
      if (d.gone) continue;
      if (mb && mb.has(d.kind)) {
        const state = d.broken ? 'wreck' : d.opened ? 'open' : d.state === 'hurt' || (d.def && d.def.hp !== Infinity && d.hp < d.def.hp * 0.5) ? 'hurt' : 'ok';
        const mesh = mb.get(d.kind, state, d.variant);
        if (mesh) {
          let x = d.x, y = d.y;
          if (d.shake > 0 && !d.flying) {
            const off = Math.sin(this.g.time * 55) * d.shake * 0.05;
            x += sx * off; y += sy * off;
          }
          const m = d._mi || (d._mi = {});
          m.mesh = mesh; m.x = x; m.y = y; m.z = (d.z || 0) + (d.lift || 0); m.yaw = d.yaw;
          m.tilt = d.fall ? d.fall.ang : (d.rockA || 0);
          m.front = mb.models[d.kind].front !== undefined ? mb.models[d.kind].front : 0.2;
          m.roll = d.flying ? d.roll || 0 : 0;
          m.rollY = undefined;
          m.emissive = !!d.emissive && !d.broken && !d.fall;
          m.shadow = !d.flying;
          solids.push(m);
          continue;
        }
      }
      let spr = d._spr;
      if (!spr) spr = d._spr = { x: d.x, y: d.y, z: 0, frame: null, h: 0, emissive: false };
      let f = null, h = 0, z = d.z || 0;
      if (st && st.has(d.kind)) {
        const state = d.broken ? 'wreck' : d.opened ? 'open' : d.state === 'hurt' || (d.def && d.def.hp !== Infinity && d.hp < d.def.hp * 0.5) ? 'hurt' : 'ok';
        const dir = viewDir(d.x, d.y, d.yaw, cam.x, cam.y, st.dirsOf(d.kind));
        const pose = d.fall ? d.pose : 0;
        const fk = `${dir}|${state}|${pose}`;
        if (fk === d._fk && d._f) f = d._f;
        else {
          f = st.want(d.kind, dir, state, d.variant, pose);
          const exact = st.exact && !!f;
          // not drawn yet: the same thing less damaged, or standing, meanwhile
          if (!f && state !== 'ok') f = st.want(d.kind, dir, 'hurt', d.variant, pose) || st.want(d.kind, dir, 'ok', d.variant, pose);
          if (!f && pose) f = st.want(d.kind, dir, state, d.variant, 0) || st.want(d.kind, dir, 'ok', d.variant, 0);
          if (exact) { d._fk = fk; d._f = f; } else d._fk = null;
        }
        if (f) {
          h = f.h / f.ppu;
          z -= f.below;
          if (d.flying && d.roll) {
            const rf = rotFrame(f, d.roll);
            const k = rf.h / f.h;
            z += h * 0.5 * (1 - k);
            h *= k; f = rf;
          }
        }
      }
      if (!f) {
        f = d.altFrame || art.sprites[d.key];
        h = d.altH || d.h0 || d.h;
      }
      if (!f) continue;
      let x = d.x, y = d.y;
      if (d.shake > 0 && !d.flying) {
        const off = Math.sin(this.g.time * 55) * d.shake * 0.16;
        x += sx * off; y += sy * off;
      }
      spr.x = x; spr.y = y; spr.z = z + (d.lift || 0); spr.frame = f; spr.h = h;
      spr.emissive = !!d.emissive && !d.broken && !d.fall;
      out.push(spr);
    }
    // debris
    const recs = this._drecs, D = this.debris;
    for (let i = 0; i < D.length; i++) {
      const b = D[i];
      let s = recs[i];
      if (!s) { s = {}; recs[i] = s; }
      if (mb && mb.has(b.piece, true)) {
        const mesh = mb.get(b.piece, 'ok', b.v, true);
        if (mesh) {
          const m = b._mi || (b._mi = {});
          m.mesh = mesh; m.x = b.x; m.y = b.y; m.z = b.z; m.yaw = b.yaw; m.tilt = 0; m.front = 0;
          m.roll = b.roll || 0; m.rollY = undefined; m.emissive = false; m.shadow = false;
          solids.push(m);
          continue;
        }
      }
      let f = st ? st.want(b.piece, viewDir(b.x, b.y, b.yaw, cam.x, cam.y, st.dirsOf(b.piece)), 'ok', b.v, 0, true) : null;
      if (!f) continue;
      let h = f.h / f.ppu, z = b.z - f.below;
      if (!b.rest && b.roll) {
        const rf = rotFrame(f, b.roll);
        const k = rf.h / f.h;
        z += h * 0.5 * (1 - k);
        h *= k; f = rf;
      }
      s.x = b.x; s.y = b.y; s.z = z; s.frame = f; s.h = h; s.emissive = false; s.alpha = 1;
      out.push(s);
    }
  }

  /** Push the litter as sprites. */
  collect(out) {
    const F = this.frames, recs = this._recs, L = this.litter;
    for (let i = 0; i < L.length; i++) {
      const l = L[i];
      let s = recs[i];
      if (!s) { s = {}; recs[i] = s; }
      s.x = l.x; s.y = l.y; s.z = l.z; s.tint = l.tint || 0;
      s.alpha = l.rest && l.life - l.age < 4 ? Math.max(0, (l.life - l.age) / 4) : 1;
      s.maxFrac = 0.06;
      if (l.kind === 'paper') {
        if (l.rest) { s.frame = F.flat; s.h = 0.05; s.wScale = 1; s.z = 0.01; }
        else { s.frame = F.paper; s.h = 0.1; s.wScale = 0.15 + 0.85 * Math.abs(Math.cos(l.t * 8 + l.ph)); }
      } else if (l.kind === 'can') {
        s.frame = F.can; s.h = 0.12; s.wScale = 1;
      } else {
        s.frame = F.coin; s.h = 0.055;
        s.wScale = l.rest ? 1 : 0.25 + 0.75 * Math.abs(Math.cos(l.t * 14 + l.ph));
      }
      out.push(s);
    }
  }
}

export { DEFS as PROP_DEFS, wreckFrame, openedFrame };
export default Props;
