// props.js - the bunker's furniture, and what it does when Brick gets to it.
//
// Set dressing used to be scenery: you could not shoot a desk, kick a chair,
// buy a soda, or find out what is in the locker. Now everything with a body
// has hit points and a material, takes a round or a boot or a blast, and comes
// apart in a way that suits what it was made of. Some of it can be used, and
// pays out. Some of it flies when kicked. A few things hold what a place like
// this would: a drawer of paperwork, a machine full of cans, a locker with
// somebody's gym socks in it.
//
// The level's decor list (maps.js) stays the source of truth for where things
// are. This module adds the state (hit points, uses left, is it flying), the
// litter (papers, cans, coins: little sprites that live on the floor after),
// and every rule. game.js only forwards: a bullet, a boot, a blast, the use key.

import { rgba, makeFrame } from '../core/pixels.js';
import { clamp, dist, makeRng, randRange, TAU } from '../core/math.js';

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
  sand: { hit: 'hit_wall', hitVol: 0.35, cols: [[190, 170, 120]], dust: 1 },
};

/**
 * hp: how much it takes (Infinity: it never breaks). kick: boot damage, or
 * 'fly' to send it across the room. use: what the use key does. cash: the
 * damages, in dollars, that go on the invoice when it breaks.
 */
const DEFS = {
  desk: { name: 'DESK', mat: 'wood', hp: 46, kick: 22, use: 'desk', papers: 26, hitPapers: 3, chunks: 12, coins: 2, cash: 340 },
  chair: { name: 'CHAIR', mat: 'wood', hp: 18, kick: 'fly', chunks: 7, cash: 60, thud: 9 },
  filing: { name: 'FILING CABINET', mat: 'metal', hp: 70, kick: 20, use: 'filing', papers: 34, hitPapers: 2, chunks: 6, cash: 280, wreck: 0.28 },
  locker: { name: 'LOCKER', mat: 'metal', hp: 80, kick: 18, use: 'locker', chunks: 8, cash: 190, wreck: 0.26 },
  vending: { name: 'VENDING MACHINE', mat: 'metal', hp: 130, kick: 14, use: 'vending', cans: 5, foam: 26, glass: true, chunks: 8, coins: 6, cash: 900, wreck: 0.3 },
  cooler: { name: 'WATER COOLER', mat: 'glass', hp: 46, kick: 20, use: 'cooler', water: 18, cash: 120, wreck: 0.4 },
  toilet: { name: 'TOILET', mat: 'porcelain', hp: 36, kick: 18, geyser: 5, cash: 250, wreck: 0.4 },
  urinal: { name: 'URINAL', mat: 'porcelain', hp: 30, kick: 18, geyser: 4, cash: 180, wreck: 0.4 },
  console: { name: 'CONSOLE', mat: 'tech', hp: 60, kick: 18, use: 'console', zap: 1, chunks: 6, cash: 1200 },
  pinball: { name: 'PINBALL MACHINE', mat: 'tech', hp: 55, kick: 16, use: 'pinball', zap: 1, chunks: 6, coins: 8, cash: 700 },
  plant: { name: 'PLANT', mat: 'plant', hp: 8, kick: 12, chunks: 12, cash: 40, wreck: 0.28 },
  trash: { name: 'TRASH CAN', mat: 'metal', hp: 14, kick: 'fly', papers: 12, cans: 2, cash: 20, wreck: 0.45, thud: 6 },
  crate: { name: 'CRATE', mat: 'wood', hp: 34, kick: 20, chunks: 14, loot: 0.4, cash: 150, wreck: 0.3 },
  crates: { name: 'CRATES', mat: 'wood', hp: 70, kick: 20, chunks: 20, loot: 0.75, cash: 300, wreck: 0.26 },
  pew: { name: 'PEW', mat: 'wood', hp: 40, kick: 18, chunks: 12, cash: 90, wreck: 0.3 },
  skeleton: { name: 'SKELETON', mat: 'bone', hp: 8, kick: 12, chunks: 12, cash: 0, wreck: 0.3 },
  mop: { name: 'MOP', mat: 'wood', hp: 8, kick: 12, chunks: 3, cash: 10, wreck: 0.4 },
  cone: { name: 'CONE', mat: 'plastic', hp: 6, kick: 'fly', chunks: 5, cash: 15, thud: 4 },
  // These take a hit and shrug. They still answer it, so shooting them is not silent.
  sandbags: { mat: 'sand', hp: Infinity },
  nosecone: { mat: 'metal', hp: Infinity, ring: 1 },
  chains: { mat: 'metal', hp: Infinity, swing: 1 },
  hook: { mat: 'metal', hp: Infinity, swing: 1 },
  corpse: { mat: 'bone', hp: Infinity, gore: 1 },
  corpse2: { mat: 'bone', hp: Infinity, gore: 1 },
};

const PAPER_TINTS = [
  rgba(255, 255, 255, 0), rgba(244, 236, 200, 90), rgba(196, 220, 244, 110),
  rgba(255, 246, 168, 120), rgba(255, 255, 255, 0), rgba(226, 226, 232, 80),
];
const CAN_TINTS = [rgba(214, 56, 44, 140), rgba(60, 110, 210, 140), rgba(60, 170, 90, 140), rgba(230, 170, 50, 140)];

const REACH = 1.5;                 // how far the use key reaches
const CAP_PAPER = 150, CAP_LITTER = 220;

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
 * What is left of a thing: the bottom of its own picture, torn across the top,
 * scorched and dented, with bits of what it was made of lying about. It is the
 * original sprite cut down, so a desk wrecks into a desk and a vending machine
 * into a vending machine, and nothing new has to be drawn.
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
  // splinters, shards and scorch marks
  for (let i = 0; i < Math.max(8, (w * h) >> 4); i++) {
    const x = (rng() * w) | 0, y = (rng() * h) | 0;
    const [r, g, b] = pickOf(rng, cols);
    if (f.data[y * w + x] >>> 24 || y > h * 0.55) {
      f.data[y * w + x] = pack(r, g, b, 255);
    }
  }
  for (let i = 0; i < (w * h) >> 6; i++) {
    const x = (rng() * w) | 0, y = (h * 0.5 + rng() * h * 0.5) | 0;
    if (f.data[y * w + x] >>> 24) f.data[y * w + x] = pack(24, 22, 26, 255);
  }
  return f;
}

/** A locker with its door ajar: the middle of the picture gone to shadow. */
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
    this.spouts = [];
    this.grid = new Map();
    this._recs = [];
    this.hintText = null;
    this._snd = 0;
  }

  /** A new level: forget the last one's rubble and register this one's furniture. */
  load(lv) {
    this.litter.length = 0;
    this.flying.length = 0;
    this.spouts.length = 0;
    this.grid.clear();
    this.hintText = null;
    for (const d of lv.decor || []) {
      d.def = DEFS[d.kind] || null;
      d.hp = d.def && d.def.hp !== undefined ? d.def.hp : 0;
      d.broken = false; d.flying = false; d.shake = 0; d.lift = 0;
      d.stock = d.kind === 'vending' ? 4 : 0;
      d.uses = 0;
      d.gal = d.kind === 'cooler' ? 6 : 0;
      d.altFrame = null; d.altH = 0; d._spr = undefined;
      if (d.def) this._gridAdd(d, lv);
    }
  }

  _cell(d) { return this.g.level.idx(d.x, d.y); }
  _gridAdd(d, lv) {
    const i = (lv || this.g.level).idx(d.x, d.y);
    let l = this.grid.get(i);
    if (!l) { l = []; this.grid.set(i, l); }
    l.push(d);
  }
  _gridDel(d) {
    const i = this._cell(d);
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
      if (d.broken || d.flying) continue;
      // Bodies on the floor and chains from the ceiling are scenery to a bullet.
      if (!d.solid && d.def.hp === Infinity) continue;
      if (z < d.z || z > d.z + d.h) continue;
      // Something you can walk through is only hit if the shot passes through it.
      if (!d.solid && Math.hypot(x - d.x, y - d.y) > 0.26) continue;
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

  /** A round, a boot or a blast landed on it. False if it does not care. */
  hit(d, dmg, x, y, z, how) {
    const def = d.def;
    if (!def || d.broken || d.flying) return false;
    const g = this.g;
    if (def.hp === Infinity) { this._shrug(d, x, y, z); return true; }
    d.hp -= dmg;
    d.shake = 0.3;
    this._hitFx(d, x, y, z, how);
    if (d.hp <= 0) this.breakProp(d, how, x, y);
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

  /** Everything within reach of a blast takes it, less with distance. */
  blast(x, y, z, radius, damage) {
    const lv = this.g.level;
    if (!lv || !lv.decor) return;
    for (const it of this.g.items) {
      if (it.kind === 'lamp' && !it.taken && dist(x, y, it.x, it.y) < radius * 0.8) this.shootLamp(it);
    }
    for (const d of lv.decor) {
      if (!d.def || d.broken || d.flying || d.def.hp === Infinity) continue;
      const r = dist(x, y, d.x, d.y);
      if (r >= radius) continue;
      this.hit(d, 8 + damage * 1.3 * (1 - r / radius), d.x, d.y, d.z + d.h * 0.5, 'blast');
    }
  }

  // ------------------------------------------------------------------- break

  breakProp(d, how, fx, fy) {
    const def = d.def, g = this.g, lv = g.level, m = MAT[def.mat];
    d.broken = true; d.hp = 0; d.shake = 0;
    const wasSolid = d.solid;
    d.solid = false;
    const i = this._cell(d);
    if (wasSolid) {
      let h = 0, any = false;
      for (const o of this.grid.get(i) || []) if (o !== d && o.solid && !o.broken) { any = true; h = Math.max(h, o.z + o.h); }
      if (!any) { lv.propBlock[i] = 0; lv.propH[i] = 0; } else lv.propH[i] = h;
    }
    if (d.fixture) { lv.fixture[i] = 0; lv.fixtureUsed[i] = 1; }

    const x = d.x, y = d.y, zc = d.z + d.h * 0.55;
    const pan = g.panAt(x, y);
    g.sound.sfx(m.brk || 'wood_break', { pan, rate: m.brkRate || 1 });
    if (def.glass) g.sound.sfx('glass_break', { pan, vol: 0.9 });
    this._chips(x, y, zc, def.chunks || 8, m, 3.6);
    if (m.sparks) g.particles.sparks(x, y, zc, 10 * m.sparks, 2.2, [255, 214, 140], 6);
    if (def.zap) {
      g.particles.smoke(x, y, zc, 6, 0.6);
      g.particles.sparks(x, y, zc + 0.1, 16, 2.4, [150, 220, 255], 7);
    }
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
    if (m.dust) g.particles.dust(x, y, zc, 6);
    if (def.loot && g.rng() < def.loot) this._loot(x, y);
    if (how === 'blast' || how === 'crash') g.shake = Math.max(g.shake, 0.9);

    // What is left. The original picture, cut down.
    const src = g.art.sprites[d.key];
    if (src) {
      d.altFrame = wreckFrame(src, def.wreck || 0.32, def.mat, (Math.imul(i, 2654435761) ^ 0x9e37) >>> 0);
      d.altH = d.h * (d.altFrame.h / src.h);
      if (d.kind === 'urinal') d.z = 0;
      d._spr = undefined;
    }
    if (def.cash) {
      g.levelDamage = (g.levelDamage || 0) + def.cash;
      g.hud.popup(`DAMAGES  $${def.cash}`, { size: 9, life: 1.2, y: -58, dy: -10, color: rgba(255, 196, 90, 255) });
    }
    g.onPropBroken(d, how);
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
      if (!d.def || d.broken || d.flying || !want(d)) continue;
      const dx = d.x - p.x, dy = d.y - p.y, r = Math.hypot(dx, dy);
      if (r > range) continue;
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

    if (def.kick === 'fly') { this._launch(d, ca, sa); return true; }
    g.sound.sfx('kick_hit', { pan: g.panAt(d.x, d.y), vol: 0.8 });
    this.hit(d, def.kick, d.x - ca * 0.2, d.y - sa * 0.2, d.z + d.h * 0.5, 'kick');
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
    } else if (d.kind === 'filing' || d.kind === 'desk') {
      this.papers(d.x, d.y, d.z + d.h * 0.8, 6, 0.8);
      g.sound.sfx('paper_flurry', { pan: g.panAt(d.x, d.y), vol: 0.6 });
    } else if (d.kind === 'cooler') {
      this._spray(d.x, d.y, d.z + 0.4, 8, 0.8);
      g.sound.sfx('water_burst', { pan: g.panAt(d.x, d.y), vol: 0.4 });
    } else if (d.kind === 'plant') {
      d.shake = 0.5;
    }
    return true;
  }

  /** A chair, a cone, a bin: hoofed across the room, hurting what it meets. */
  _launch(d, ca, sa) {
    const g = this.g;
    this._gridDel(d);
    d.flying = true;
    const speed = 11;
    d.mv = { vx: ca * speed + (this.rng() - 0.5) * 1.6, vy: sa * speed + (this.rng() - 0.5) * 1.6, vz: 3.6, hit: new Set(), ground: d.z };
    d.lift = 0.02;
    this.flying.push(d);
    g.sound.sfx('kick_hit', { pan: g.panAt(d.x, d.y) });
    g.sound.sfx(MAT[d.def.mat].hit, { pan: g.panAt(d.x, d.y), rate: 1.2 });
    g.particles.effect({
      x: d.x, y: d.y, z: d.z + 0.3, keys: ['kick_impact0', 'kick_impact1', 'kick_impact2'], fps: 18, size: 0.9, alpha: 0.8,
    });
    g.hud.popup(d.kind === 'cone' ? 'CONED' : d.kind === 'chair' ? 'CHAIR TOSS' : 'HEADS UP', { size: 11, life: 0.9, y: -30, color: rgba(255, 208, 72, 255) });
    g.chat('brick', 'brick_smash', { chance: 0.25, cooldown: 12 });
  }

  _fly(d, dt) {
    const g = this.g, lv = g.level, mv = d.mv, def = d.def;
    mv.vz -= 9.8 * dt;
    d.lift += mv.vz * dt;
    let landed = false;
    if (d.lift <= 0) {
      d.lift = 0;
      if (mv.vz < -1.8) {
        mv.vz = -mv.vz * 0.32;
        g.sound.sfx(MAT[def.mat].hit, { pan: g.panAt(d.x, d.y), vol: 0.6, rate: 0.9 });
      } else { mv.vz = 0; landed = true; }
      const f = Math.exp(-2.6 * dt);
      mv.vx *= f; mv.vy *= f;
    }
    const nx = d.x + mv.vx * dt, ny = d.y + mv.vy * dt;
    const speed = Math.hypot(mv.vx, mv.vy);
    if (lv.blocked(nx, ny)) {
      // A hard stop at speed finishes it; a soft one just turns it round.
      if (speed > 5 && def.hp !== Infinity && d.kind !== 'cone') {
        d.flying = false;
        d.broken = false;
        this._unfly(d, false);
        this.hit(d, 999, d.x, d.y, d.z + 0.3, 'crash');
        return;
      }
      if (lv.blocked(nx, d.y)) mv.vx *= -0.35;
      if (lv.blocked(d.x, ny)) mv.vy *= -0.35;
    } else { d.x = nx; d.y = ny; }

    if (speed > 2.5) {
      for (const e of g.enemies) {
        if (!e.alive || mv.hit.has(e)) continue;
        if (dist(d.x, d.y, e.x, e.y) > e.radius + 0.35) continue;
        if (d.lift > e.height) continue;
        mv.hit.add(e);
        const died = e.hurt(def.thud || 8, g, d.x - mv.vx, d.y - mv.vy);
        e.shove(mv.vx / (speed || 1), mv.vy / (speed || 1), 3, 0.5);
        g.sound.sfx('kick_hit', { pan: g.panAt(e.x, e.y), rate: 1.2 });
        g.particles.blood(e.x, e.y, e.z + e.height * 0.5, 5, mv.vx, mv.vy);
        g.hud.hitMark(died);
        mv.vx *= 0.35; mv.vy *= 0.35;
      }
    }
    if (landed && speed < 0.45) this._unfly(d, true);
    this._place(d);
  }

  _unfly(d, settle) {
    const k = this.flying.indexOf(d);
    if (k >= 0) this.flying.splice(k, 1);
    d.flying = false; d.lift = 0; d.mv = null;
    if (settle) { this._gridAdd(d); this._place(d); }
  }

  _place(d) {
    const s = d._spr;
    if (s) { s.x = d.x; s.y = d.y; s.z = d.z + d.lift; }
  }

  // ---------------------------------------------------------------- the use key

  /** The prop the use key would act on, with a short label for the HUD. */
  _useTarget(p) {
    return this._front(p, REACH, 0.74, (d) => d.def.use && this._usable(d));
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

  _openLocker(d) {
    const g = this.g;
    d.opened = true;
    const src = g.art.sprites[d.key];
    if (src) { d.altFrame = openedFrame(src); d.altH = d.h; d._spr = undefined; }
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

    // shivers: whatever was just hit or kicked rocks a little, across the view
    const px = -Math.sin(p.ang), py = Math.cos(p.ang);
    for (const d of lv.decor) {
      if (d.busy > 0) d.busy = Math.max(0, d.busy - dt);
      if (d.shake > 0) {
        d.shake = Math.max(0, d.shake - dt);
        const s = d._spr;
        if (s && !d.flying) {
          const off = d.shake > 0 ? Math.sin(g.time * 55) * d.shake * 0.16 : 0;
          s.x = d.x + px * off; s.y = d.y + py * off;
        }
      }
    }
    // burst pipes
    for (let i = this.spouts.length - 1; i >= 0; i--) {
      const s = this.spouts[i];
      s.t -= dt;
      if (s.t <= 0) { this.spouts.splice(i, 1); continue; }
      const k = s.t / s.T;
      this._spray(s.x, s.y, s.z, Math.ceil(dt * 90 * (0.4 + k)), 0.9 + k * 0.5);
      s._n = (s._n || 0) - dt;
      if (s._n <= 0) { s._n = 1.3; g.sound.sfx('water_burst', { pan: g.panAt(s.x, s.y), vol: 0.35 + 0.4 * k }); }
    }
    this.hintText = p.dead ? null : this.hint(p);
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
