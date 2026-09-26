// gore.js - where the bits go.
//
// Hit locations, severed parts as real physics objects, arterial fountains,
// blood smeared up the walls, brass on the floor, and the popups when a
// punted head clears the uprights. The enemy sprites keep their own art; this
// module decides which parts come off, throws them, and keeps score.
//
// Budget: every object here lives in a fixed pool with a hard cap, the update
// loops allocate nothing, and the renderer is handed recycled sprite records.
// A room full of limbs costs a few hundred billboards, never a hitch.

import { clamp, randRange, makeRng, TAU, wrapAngle } from '../core/math.js';
import { rgba, makeFrame } from '../core/pixels.js';
import { ST } from './entities.js';

// Mask bits, as the sprite generator understands them. R/L are the
// CHARACTER'S own right and left, not the screen's.
export const HEAD = 1, ARM_R = 2, ARM_L = 4, LEG_R = 8, LEG_L = 16;
const ALL_PARTS = HEAD | ARM_R | ARM_L | LEG_R | LEG_L;

/**
 * Joint heights as fractions of the frame height, measured up from the feet.
 * The sprite generator publishes its own rig and that wins; these are the
 * numbers read off the current skeletons, so a build without it still puts
 * the stumps somewhere sensible. Quadrupeds read hip as the hind hip and
 * shoulder as the front shoulder.
 */
export const RIG_DEFAULT = {
  wrencher: { hip: 0.41, shoulder: 0.65, neck: 0.69, head: 0.82 },
  sparker: { hip: 0.45, shoulder: 0.70, neck: 0.75, head: 0.84 },
  bellows: { hip: 0.37, shoulder: 0.63, neck: 0.67, head: 0.76 },
  priest: { hip: 0.46, shoulder: 0.71, neck: 0.75, head: 0.84 },
  gorger: { hip: 0.32, shoulder: 0.62, neck: 0.64, head: 0.71 },
  howler: { hip: 0.42, shoulder: 0.65, neck: 0.69, head: 0.80 },
  ghoul: { hip: 0.50, shoulder: 0.41, neck: 0.52, head: 0.60 },
  stalker: { hip: 0.46, shoulder: 0.35, neck: 0.48, head: 0.56 },
};
export const QUADRUPED = { ghoul: true, stalker: true };
// Attacks that need hands. Lose both and the thing has to improvise.
const ARM_ATTACK = { melee: true, bolt: true, flame: true };

/** What each weapon does to a body, when a weapon has no gore block of its own. */
export const EXPLOSION_GORE = { sever: 0.8, head: 0.45, parts: 3, knock: 16, gib: 46, lift: 4.2 };
export const SLAM_GORE = { sever: 0.4, head: 0.1, parts: 1, knock: 0, gib: 0, lift: 0 };

const MAX_PARTS = 80;
const MAX_GIBS = 90;
const MAX_CASINGS = 56;
const MAX_FOUNTAINS = 28;
const GRAVITY = 13.5;

const T_PART = 0, T_GIB = 1, T_CASING = 2;

const LIMB_POP = {
  arm: ['DISARMED', 'NEED A HAND?', 'ARMLESS', 'ELBOW ROOM', 'HANDS FREE'],
  leg: ['LEGLESS', 'HOP IT', 'STUMPED', 'NO LEG TO STAND ON', 'FOOTLOOSE'],
  head: ['HEAD POP', 'NO BRAINER', 'HEADSHOT', 'TOP OFF', 'HEADS UP', 'LOST HIS HEAD'],
  many: ['CHUNKY', 'SOME ASSEMBLY REQUIRED', 'HOLY SH*T', 'MEAT SALAD', 'SPARE PARTS'],
};
const PUNT_POP = ['FIELD GOAL', 'IT IS GOOD!', 'GOAL!', 'TOUCHDOWN', 'THROUGH THE UPRIGHTS', 'EXTRA POINT'];
const BONK_POP = ['HEAD TO HEAD', 'SKULL MAIL', 'HEADS UP', 'RETURN TO SENDER', 'CATCH'];

// Frame keys are built once per kind and part, never per frame.
const PART_KEYS = {};
function partKeys(kind, part) {
  const id = kind + '|' + part;
  let k = PART_KEYS[id];
  if (!k) {
    k = [];
    for (let r = 0; r < 8; r++) k.push(`${kind}_part_${part}_${r}`);
    PART_KEYS[id] = k;
  }
  return k;
}

export function partOf(bit) { return bit === HEAD ? 'head' : (bit === ARM_R || bit === ARM_L) ? 'arm' : 'leg'; }
function sideOf(bit) { return (bit === ARM_R || bit === LEG_R) ? 1 : -1; }
function bitIndex(bit) { return bit === 1 ? 0 : bit === 2 ? 1 : bit === 4 ? 2 : bit === 8 ? 3 : 4; }
function popcount(m) { let n = 0; while (m) { n += m & 1; m >>= 1; } return n; }

// ------------------------------------------------------------ rotation

const ROT = new WeakMap();
const ROT_STEPS = 16;

/**
 * A frame turned by `ang` radians clockwise, snapped to one of sixteen steps
 * and cached against the source frame. Built the first time it is asked for;
 * a spinning gib costs one rotation per step, once per game.
 */
export function rotFrame(f, ang) {
  if (!f) return f;
  let step = Math.round(ang / (TAU / ROT_STEPS)) % ROT_STEPS;
  if (step < 0) step += ROT_STEPS;
  if (step === 0) return f;
  let arr = ROT.get(f);
  if (!arr) { arr = new Array(ROT_STEPS).fill(null); ROT.set(f, arr); }
  let out = arr[step];
  if (!out) { out = rotate(f, step * TAU / ROT_STEPS); arr[step] = out; }
  return out;
}

function rotate(f, a) {
  // Square canvas big enough for the diagonal, so nothing is cropped.
  const D = Math.ceil(Math.hypot(f.w, f.h)) | 1;
  const out = makeFrame(D, D);
  const c = Math.cos(a), s = Math.sin(a);
  const hw = f.w / 2, hh = f.h / 2, hD = D / 2;
  for (let y = 0; y < D; y++) {
    const dy = y + 0.5 - hD;
    for (let x = 0; x < D; x++) {
      const dx = x + 0.5 - hD;
      // Inverse map: where in the source did this output pixel come from.
      const sx = Math.floor(c * dx + s * dy + hw), sy = Math.floor(-s * dx + c * dy + hh);
      if (sx < 0 || sy < 0 || sx >= f.w || sy >= f.h) continue;
      out.data[y * D + x] = f.data[sy * f.w + sx];
    }
  }
  return out;
}

// -------------------------------------------------------------- casings

/** Spent brass and spent hulls, painted once. Tiny, but they are seen up close. */
function paintCasing(kind) {
  if (kind === 'flak') {
    // A fat red plastic hull on a brass head: the flak pistol is a shotgun at heart.
    const f = makeFrame(6, 12);
    for (let y = 0; y < 12; y++) {
      for (let x = 0; x < 6; x++) {
        const lit = x === 1 ? 1.25 : x === 4 ? 0.7 : x === 5 || x === 0 ? 0.55 : 1;
        let r, g, b;
        if (y >= 8) { r = 214; g = 170; b = 72; }          // brass head
        else if (y === 0) { r = 70; g = 18; b = 20; }       // crimped mouth
        else { r = 176; g = 34; b = 30; }                   // hull
        if (y === 8) { r *= 0.7; g *= 0.7; b *= 0.7; }      // the rim
        f.data[y * 6 + x] = rgba(clamp(r * lit, 0, 255), clamp(g * lit, 0, 255), clamp(b * lit, 0, 255), 255);
      }
    }
    return f;
  }
  const f = makeFrame(4, 9);
  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 4; x++) {
      const lit = x === 1 ? 1.3 : x === 3 ? 0.62 : x === 0 ? 0.8 : 1;
      let r = 222, g = 176, b = 80;
      if (y === 0) { r = 60; g = 44; b = 22; }              // open mouth
      if (y === 8) { r = 150; g = 110; b = 52; }            // primer rim
      f.data[y * 4 + x] = rgba(clamp(r * lit, 0, 255), clamp(g * lit, 0, 255), clamp(b * lit, 0, 255), 255);
    }
  }
  return f;
}

// ---------------------------------------------------------------- pools

function blankChunk() {
  return {
    type: T_PART, kind: '', part: '', keys: null, base: null, pxScale: 0,
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, ang: 0, spin: 0, h: 0.2, rad: 0.06,
    age: 0, life: 0, fade: 0, settled: false, stuck: 0, snx: 0, sny: 0, slide: 0,
    trail: 0, trailT: 0, punted: false, px0: 0, py0: 0, landed: false, bounces: 0,
    rest: 0.3, head: false, bone: false, hitId: 0, dead: false, dripT: 0,
  };
}

function blankFountain() {
  return { active: false, e: null, bit: 0, t: 0, life: 0, next: 0, str: 1, jx: 0, jy: 0, jz: 1, sp: 0 };
}

export class Gore {
  constructor(game) {
    this.game = game;
    this.rng = makeRng(0x90e5eed);
    this.free = [];
    for (let i = 0; i < MAX_PARTS + MAX_GIBS + MAX_CASINGS; i++) this.free.push(blankChunk());
    this.parts = [];
    this.gibs = [];
    this.casings = [];
    this.fountains = [];
    for (let i = 0; i < MAX_FOUNTAINS; i++) this.fountains.push(blankFountain());
    this.casingFrames = { nail: paintCasing('nail'), flak: paintCasing('flak') };
    this._spr = [];
    this._sprN = 0;
    this._J = { x: 0, y: 0, z: 0, px: 0, py: 0, pz: 0, ox: 0, oy: 0 };
    this._order = [0, 0, 0, 0, 0];
    this._bodyPx = {};
    this.sndT = { land: 0, spurt: 0, tink: 0, bump: 0 };
    this.stats = { severed: 0, heads: 0, punts: 0, goals: 0 };
  }

  clear() {
    for (const list of [this.parts, this.gibs, this.casings]) {
      while (list.length) this.free.push(list.pop());
    }
    for (const f of this.fountains) { f.active = false; f.e = null; }
  }

  get art() { return this.game.art || {}; }

  /** The joint table for a kind, or null if it cannot lose parts. */
  rigOf(kind) {
    const r = this.art.rig && this.art.rig[kind];
    if (r && r.hip > 0 && r.neck > 0) return r;
    return RIG_DEFAULT[kind] || null;
  }

  canMaim(e) { return !!(e && !e.def.boss && !e.def.miniboss && !e.def.flying && this.rigOf(e.kind)); }

  /** Maimed art for a body, or null when the generator has none to give. */
  maimFrame(key, mask) {
    const m = this.art.maim;
    if (!mask || typeof m !== 'function') return null;
    try { return m(key, mask) || null; } catch { return null; }
  }

  // ------------------------------------------------------ hit location

  /**
   * Which part a point on a body belongs to. The lateral offset is taken
   * against the enemy's own right-hand vector, so a Wrencher facing you has
   * its right arm on your left without anyone having to think about it.
   * Returns a mask bit, or 0 for the torso.
   */
  zoneAt(e, hx, hy, hz) {
    const rig = this.rigOf(e.kind);
    if (!rig) return 0;
    const zf = (hz - (e.z + (e.zOff || 0))) / (e.height || 1);
    const ox = hx - e.x, oy = hy - e.y;
    const ca = Math.cos(e.ang), sa = Math.sin(e.ang);
    const r = e.radius || 0.3;
    const bx = (ox * -sa + oy * ca) / r;        // across the body, + = its right
    const bz = (ox * ca + oy * sa) / r;         // along its facing
    const right = bx >= 0;
    if (QUADRUPED[e.kind]) {
      const legTop = Math.min(rig.hip, rig.shoulder) * 0.95;
      if (zf < legTop) return bz >= 0 ? (right ? ARM_R : ARM_L) : (right ? LEG_R : LEG_L);
      if (bz > 0.45 && zf > legTop) return HEAD;
      return 0;
    }
    if (zf >= rig.neck) return HEAD;
    if (zf < rig.hip) return right ? LEG_R : LEG_L;
    if (Math.abs(bx) > 0.42 && zf < rig.shoulder + 0.06) return right ? ARM_R : ARM_L;
    return 0;
  }

  /** World position of a joint (the stump) and of the part hanging off it. */
  joint(e, bit) {
    const J = this._J;
    const rig = this.rigOf(e.kind) || RIG_DEFAULT.wrencher;
    const h = e.height, z0 = e.z + (e.zOff || 0);
    const ca = Math.cos(e.ang), sa = Math.sin(e.ang);
    const rx = -sa, ry = ca, r = e.radius;
    const s = bit === HEAD ? 0 : sideOf(bit);
    J.ox = rx * s; J.oy = ry * s;                  // which way the stump points
    const quad = QUADRUPED[e.kind];
    // A body on the floor has no standing pose to read joints off; put the
    // stump at the end of the corpse nearest where the part used to be.
    const down = !e.alive && e.headlessT <= 0 && e.state !== ST.DYING;
    if (bit === HEAD) {
      const fwd = quad ? 0.8 : 0.1;
      J.x = e.x + ca * r * fwd; J.y = e.y + sa * r * fwd;
      J.z = down ? z0 + 0.12 : z0 + rig.neck * h;
      J.px = J.x; J.py = J.y; J.pz = down ? z0 + 0.16 : z0 + rig.head * h;
      J.ox = ca * 0.3; J.oy = sa * 0.3;
    } else if (bit === ARM_R || bit === ARM_L) {
      if (quad) {
        J.x = e.x + ca * r * 0.6 + rx * s * r * 0.4; J.y = e.y + sa * r * 0.6 + ry * s * r * 0.4;
        J.z = z0 + rig.shoulder * h * 0.8;
        J.px = J.x; J.py = J.y; J.pz = z0 + rig.shoulder * h * 0.45;
      } else {
        J.x = e.x + rx * s * r * 0.75; J.y = e.y + ry * s * r * 0.75;
        J.z = z0 + rig.shoulder * h;
        J.px = e.x + rx * s * r * 0.9; J.py = e.y + ry * s * r * 0.9;
        J.pz = z0 + (rig.shoulder + rig.hip) * 0.5 * h;
      }
    } else {
      if (quad) {
        J.x = e.x - ca * r * 0.6 + rx * s * r * 0.4; J.y = e.y - sa * r * 0.6 + ry * s * r * 0.4;
        J.z = z0 + rig.hip * h * 0.8;
        J.px = J.x; J.py = J.y; J.pz = z0 + rig.hip * h * 0.45;
      } else {
        J.x = e.x + rx * s * r * 0.35; J.y = e.y + ry * s * r * 0.35;
        J.z = z0 + rig.hip * h;
        J.px = J.x; J.py = J.y; J.pz = z0 + rig.hip * h * 0.5;
      }
    }
    if (down) { J.z = z0 + 0.1; J.pz = Math.min(J.pz, z0 + 0.14); }
    return J;
  }

  /** Recompute how a body gets about after losing something. */
  updateMobility(e) {
    const m = e.maim;
    if (QUADRUPED[e.kind]) {
      const n = popcount(m & (ARM_R | ARM_L | LEG_R | LEG_L));
      e.mobility = n === 0 ? 1 : n === 1 ? 0.62 : n === 2 ? 0.42 : n === 3 ? 0.3 : 0.2;
      e.hop = n > 0;
      e.crawl = false;
      e.armless = false;
      return;
    }
    const legs = popcount(m & (LEG_R | LEG_L));
    e.mobility = legs === 2 ? 0.3 : legs === 1 ? 0.5 : 1;
    e.hop = legs === 1;
    e.crawl = legs === 2;
    e.armless = (m & (ARM_R | ARM_L)) === (ARM_R | ARM_L) && !!ARM_ATTACK[e.def.attack];
  }

  // ------------------------------------------------------------ severing

  /**
   * Take one part off a body and throw it. `dx, dy` is the push direction,
   * `power` roughly the speed it leaves at. Losing the head is fatal; how
   * fatal, and how quickly, depends on whether the rest of it has legs.
   */
  sever(e, bit, dx, dy, power, opts) {
    if (!this.canMaim(e) || (e.maim & bit) || e.gibbed) return false;
    const game = this.game;
    const rng = this.rng;
    const J = this.joint(e, bit);
    e.maim |= bit;
    e._lastBit = bit;
    this.stats.severed++;
    const part = partOf(bit);
    const L = Math.hypot(dx, dy) || 1;
    const ux = dx / L, uy = dy / L;
    const sp = clamp(power, 1.5, 16) * randRange(rng, 0.7, 1.1);
    // Out along the push, a shove away from the body on the stump's side, and
    // an upward pop, because a limb that just drops is a missed opportunity.
    let vx = ux * sp + J.ox * randRange(rng, 0.8, 2.4);
    let vy = uy * sp + J.oy * randRange(rng, 0.8, 2.4);
    let vz = randRange(rng, 2.4, 4.6) + (bit === HEAD ? randRange(rng, 2.0, 3.6) : 0) + sp * 0.12;
    if (opts && opts.vx !== undefined) { vx = opts.vx; vy = opts.vy; vz = opts.vz; }
    const c = this.spawnPart(e, part, J.px, J.py, J.pz, vx, vy, vz);
    if (c && opts && opts.punted) this.markPunt(c, e.x, e.y);

    // The wet part: a burst at the joint, then the fountain takes over.
    const P = game.particles;
    const pan = game.panAt(J.x, J.y);
    for (let i = 0; i < 22; i++) {
      const a = rng() * TAU, s = randRange(rng, 0.8, 4.2);
      P.emit(J.x, J.y, J.z, Math.cos(a) * s + ux * 1.8, Math.sin(a) * s + uy * 1.8, randRange(rng, 0.8, 4),
        randRange(rng, 0.4, 0.9), randRange(rng, 0.028, 0.075), randRange(rng, 150, 215) | 0, 14, 22,
        1.0, 9, false, true, 0.6, 0);
    }
    const vol = this.volAt(J.x, J.y, 1);
    if (bit === HEAD) {
      this.stats.heads++;
      game.sound.sfx('head_pop', { pan, vol, rate: randRange(rng, 0.92, 1.12) });
      // A little pink mist where the head was, for the frame it takes to read.
      // An explosion brings its own cloud; two would read as a balloon.
      if (!(opts && opts.noRun)) P.effect({
        x: J.x, y: J.y, z: J.z + 0.08,
        keys: ['gib_burst0', 'gib_burst1', 'gib_burst2', 'gib_burst3'],
        fps: 24, size: e.height * 0.8, additive: false, alpha: 0.8,
      });
    } else {
      game.sound.sfx('limb_rip', { pan, vol, rate: randRange(rng, 0.9, 1.15) });
    }
    this.fountain(e, bit, bit === HEAD ? 3.2 : randRange(rng, 2.0, 4.0), bit === HEAD ? 1.5 : 1);
    this.updateMobility(e);
    // A headless sprinter that loses its legs as well has run out of ideas.
    if (e.headlessT > 0 && e.crawl) { e.headlessT = 0; e.deathFrame = 0; }
    // A beat of hit-stop when it happens close enough to see.
    const pd = Math.hypot(J.x - game.player.x, J.y - game.player.y);
    if (pd < 9) {
      game.hitStop = Math.max(game.hitStop, bit === HEAD ? 0.06 : 0.035);
      game.shake = Math.max(game.shake, bit === HEAD ? 0.9 : 0.5);
    }
    this.splatterIfClose(J.x, J.y, 2.6, 2);

    if (bit === HEAD) {
      e._headPop = true;
      if (e.alive) e.hurt(e.hp + 9999, game, J.x, J.y);
      // With legs under it and nothing throwing it about, the body has not
      // been told yet. It runs.
      const legs = 2 - popcount(e.maim & (LEG_R | LEG_L));
      if (e.state === ST.DYING && e.deathFrame < 1.2 && legs > 0 && !e.launched &&
          Math.hypot(e.kvx, e.kvy) < 6 && !(opts && opts.noRun)) {
        e.headlessT = randRange(rng, 1.5, 3.0);
        e.deathFrame = 0;
        e.zigT = 0;
        const f = this.fountainOf(e, HEAD);
        if (f) { f.life = e.headlessT + 1.2; f.str = 1.7; }
        game.after(0.7, () => { if (e.headlessT > 0) game.goreQuip('headless', 0.7); });
      } else {
        game.goreQuip('headshot', 0.5);
      }
    } else if (e.alive && e.crawl && !e._crawlSaid) {
      e._crawlSaid = true;
      game.after(0.9, () => { if (e.alive && e.crawl) game.goreQuip('crawler', 0.75); });
    } else {
      game.goreQuip('dismember', 0.3);
    }
    return true;
  }

  /** Everything off at once: explosions and the like. */
  explode(e, dx, dy, force) {
    if (!this.canMaim(e)) return 0;
    let n = 0;
    const rng = this.rng;
    for (let b = 1; b <= 16; b <<= 1) {
      if (e.maim & b) continue;
      // Scatter in a rough cone around the blast direction, not all one way.
      const a = Math.atan2(dy, dx) + randRange(rng, -1.1, 1.1);
      if (this.sever(e, b, Math.cos(a), Math.sin(a), force * randRange(rng, 0.45, 0.9), { noRun: true })) n++;
    }
    // Five stumps pumping at once is one too many jokes; keep it to a gush.
    for (const f of this.fountains) if (f.active && f.e === e) f.life = Math.min(f.life, randRange(rng, 0.8, 1.6));
    e.gibbed = true;
    return n;
  }

  /**
   * A hitscan round arriving at a point on a body. Damage accumulates per
   * part, so the Naildriver chips a limb off in a burst rather than by lottery,
   * and a killing shot always takes what it hit.
   */
  hitscan(e, hx, hy, hz, dx, dy, dmg, spec, killed) {
    if (!this.canMaim(e) || !spec) return 0;
    const bit = this.zoneAt(e, hx, hy, hz);
    if (!bit || (e.maim & bit)) return 0;
    const i = bitIndex(bit);
    e.limbDmg[i] += dmg;
    const thr = e.maxHp * (bit === HEAD ? 0.5 : bit <= ARM_L ? 0.3 : 0.4);
    let p = (bit === HEAD ? spec.head : spec.sever) * dmg / Math.max(8, e.maxHp * 0.25);
    if (killed) p = 1;
    if (e.limbDmg[i] >= thr || this.rng() < p) {
      if (this.sever(e, bit, dx, dy, 5 + dmg * 0.18)) {
        this.popLimb(e, bit, 1);
        return 1;
      }
    }
    return 0;
  }

  /**
   * A blast of `force` (damage actually dealt) centred at bx, by, bz. Takes
   * the parts facing it at the height it went off, more of them the harder it
   * hit, and at gib force takes the lot and throws what is left.
   */
  blast(e, bx, by, bz, force, spec, killed) {
    if (!spec) return 0;
    const rng = this.rng;
    let dx = e.x - bx, dy = e.y - by;
    let L = Math.hypot(dx, dy);
    if (L < 0.05) { const a = rng() * TAU; dx = Math.cos(a); dy = Math.sin(a); L = 1; }
    dx /= L; dy /= L;
    const knock = (spec.knock || 0) * clamp(force / 30, 0.35, 1.6);
    if (e.gibbed) {
      // Nothing left to take off. What is left can still be thrown.
      if (killed) this.launch(e, dx, dy, knock, spec.lift || 0);
      return 0;
    }

    if (!this.canMaim(e)) {
      if (killed && spec.gib && force >= spec.gib) this.game.gib(e);
      if (killed) this.launch(e, dx, dy, knock, spec.lift || 0);
      return 0;
    }
    const heavy = e.maxHp >= 150;
    if (killed && spec.gib && force >= spec.gib * (heavy ? 1.6 : 1)) {
      const n = this.explode(e, dx, dy, 6 + knock * 0.6);
      this.game.gib(e);
      this.launch(e, dx, dy, knock * 1.2, (spec.lift || 3) + 1.5);
      if (n) this.popMany(e, n);
      return n;
    }

    const rig = this.rigOf(e.kind);
    const zf = (bz - e.z) / e.height;
    const ca = Math.cos(e.ang), sa = Math.sin(e.ang);
    const facing = ((bx - e.x) * -sa + (by - e.y) * ca) >= 0 ? 1 : -1;
    const arm = facing > 0 ? ARM_R : ARM_L, armO = facing > 0 ? ARM_L : ARM_R;
    const leg = facing > 0 ? LEG_R : LEG_L, legO = facing > 0 ? LEG_L : LEG_R;
    const o = this._order;
    // The part nearest the blast goes first; the rest follow in order of
    // how exposed they are at that height.
    if (zf >= rig.neck - 0.04) { o[0] = HEAD; o[1] = arm; o[2] = armO; o[3] = leg; o[4] = legO; }
    else if (zf >= rig.hip) { o[0] = arm; o[1] = armO; o[2] = leg; o[3] = legO; o[4] = HEAD; }
    else { o[0] = leg; o[1] = legO; o[2] = arm; o[3] = armO; o[4] = HEAD; }

    const ratio = force / Math.max(10, e.maxHp);
    let p = spec.sever * clamp(ratio * 2.2, 0.25, 1.5) * (killed ? 1.5 : 1);
    // A burst right at the head is a headshot, and the Widow fused to the
    // range is built to deliver exactly that. Measured to the head itself, so
    // a burst two cells over it does not count.
    const near = Math.hypot(bx - e.x, by - e.y, bz - (e.z + rig.head * e.height));
    const headshot = zf >= rig.neck - 0.04 && near < 1.4;
    let n = 0;
    const max = spec.parts || 1;
    for (let k = 0; k < 5 && n < max; k++) {
      const b = o[k];
      if (e.maim & b) continue;
      // Losing a head is fatal, so off a hit that was not, it takes a real
      // headshot. Off a kill it is just another part.
      let chance = b !== HEAD ? p : headshot ? spec.head * (1.15 - near / 2.8) : killed ? spec.head * p * 0.35 : 0;
      if (rng() < chance) {
        if (this.sever(e, b, dx, dy, 3 + knock * 0.55)) { n++; p *= 0.6; }
      }
    }
    if (killed) this.launch(e, dx, dy, knock, spec.lift || 0);
    if (n > 1) this.popMany(e, n);
    else if (n === 1) this.popLimb(e, e._lastBit || 0, 1);
    return n;
  }

  /** Throw a dead body along its knockback: it flies, turns over, and lands. */
  launch(e, dx, dy, knock, lift) {
    if (e.alive || knock <= 0.5) return;
    const rng = this.rng;
    if (e.headlessT > 0 && knock < 14) {
      // The head went and the legs did not get the message; a nudge sends it
      // off running rather than flying. Only a real blast overrules that.
      e.shove(dx, dy, knock * 0.3, 0);
      e.launched = false;
      return;
    }
    e.shove(dx, dy, knock, 0);
    const mass = Math.max(0.35, e.def.radius * 2.6 + e.maxHp / 120);
    if (lift > 0 && e.def.speed > 0) {
      e.vz = Math.max(e.vz || 0, (lift / Math.sqrt(mass)) * randRange(rng, 0.85, 1.2));
      e.rollV = (rng() < 0.5 ? -1 : 1) * randRange(rng, 5, 11) * clamp(knock / 12, 0.5, 1.4);
    }
    if (Math.hypot(e.kvx, e.kvy) > 5) e.launched = true;
    // A flying body is not a headless sprinter.
    e.headlessT = 0;
  }

  popLimb(e, bit, n) {
    if (!n) return;
    const pool = LIMB_POP[partOf(bit)];
    this.callout(e, pool[(this.rng() * pool.length) | 0], bit === HEAD ? 13 : 11);
  }

  popMany(e, n) {
    const pool = LIMB_POP.many;
    this.callout(e, pool[(this.rng() * pool.length) | 0], 15);
  }

  /**
   * Gore gets its own lane beside the crosshair, on the side the body is,
   * so it never lands on top of the streak and chain callouts in the middle.
   * It is commentary, not currency: a limb pays nothing, the kill pays as it
   * always did, and a burst of them inside a third of a second says one thing.
   */
  callout(e, text, size) {
    const game = this.game;
    if (game.time < (this._calloutAt || 0)) return;
    this._calloutAt = game.time + 0.35;
    const p = game.player;
    const rel = wrapAngle(Math.atan2(e.y - p.y, e.x - p.x) - p.ang);
    const W = (game.rc && game.rc.w) || 960;
    game.hud.popup(text, {
      size, life: 1.2, color: rgba(255, 96, 70, 255), y: 18, dy: -18,
      x: W * (rel < 0 ? 0.3 : 0.7),
    });
  }

  // --------------------------------------------------------------- chunks

  _take(list, cap) {
    let c;
    if (list.length >= cap) c = list.shift();
    else c = this.free.pop() || blankChunk();
    // Let the oldest few go quietly before the cap forces a hard recycle.
    if (list.length > cap - 6) {
      for (let i = 0; i < list.length && i < 3; i++) if (!list[i].fade) list[i].fade = 1;
    }
    c.x = c.y = c.z = c.vx = c.vy = c.vz = 0;
    c.ang = 0; c.spin = 0; c.age = 0; c.life = 0; c.fade = 0; c.settled = false; c.stuck = 0;
    c.trail = 0; c.trailT = 0; c.punted = false; c.landed = false; c.bounces = 0; c.hitId = 0;
    c.dead = false; c.keys = null; c.base = null; c.head = false; c.bone = false; c.dripT = 0; c.slide = 0;
    list.push(c);
    return c;
  }

  bodyPx(kind) {
    let v = this._bodyPx[kind];
    if (v === undefined) {
      const f = this.art.sprites && this.art.sprites[`${kind}_walk0_0`];
      v = f ? f.h : 72;
      this._bodyPx[kind] = v;
    }
    return v;
  }

  spawnPart(e, part, x, y, z, vx, vy, vz) {
    const rng = this.rng;
    const c = this._take(this.parts, MAX_PARTS);
    c.type = T_PART;
    c.kind = e.kind; c.part = part;
    c.head = part === 'head';
    c.keys = partKeys(e.kind, part);
    const S = this.art.sprites || {};
    const f0 = S[c.keys[0]];
    c.pxScale = e.height / this.bodyPx(e.kind);
    if (f0) {
      c.h = f0.h * c.pxScale;
    } else {
      // No part art: a gib stands in, sized like the part it replaces.
      c.keys = null;
      c.base = S[part === 'head' ? 'gib1' : part === 'arm' ? 'gib4' : 'gib0'] || null;
      c.h = e.height * (part === 'head' ? 0.26 : part === 'arm' ? 0.3 : 0.36);
    }
    c.rad = c.h * (c.head ? 0.36 : 0.22);
    c.x = x; c.y = y; c.z = Math.max(z, c.rad);
    c.vx = vx; c.vy = vy; c.vz = vz;
    c.ang = rng() * TAU;
    c.spin = this.screenSpin(vx, vy) * randRange(rng, 7, 15);
    c.rest = c.head ? 0.56 : 0.3;
    c.trail = randRange(rng, 0.8, 1.6);
    // Born inside the body it came off; it must not bounce back and hit it.
    c.hitId = e.id;
    return c;
  }

  spawnGib(x, y, z, vx, vy, vz, idx, size) {
    const S = this.art.sprites || {};
    const base = S[`gib${idx & 7}`];
    if (!base) return null;
    const rng = this.rng;
    const c = this._take(this.gibs, MAX_GIBS);
    c.type = T_GIB;
    c.base = base;
    // Bone shard, jaw and ribs clatter; the rest just lands.
    c.head = false;
    c.bone = (idx & 7) === 0 || (idx & 7) === 3 || (idx & 7) === 6;
    c.h = size;
    c.rad = size * 0.3;
    c.x = x; c.y = y; c.z = Math.max(z, c.rad);
    c.vx = vx; c.vy = vy; c.vz = vz;
    c.ang = rng() * TAU;
    c.spin = this.screenSpin(vx, vy) * randRange(rng, 6, 16);
    c.rest = 0.3;
    c.life = randRange(rng, 22, 34);
    c.trail = randRange(rng, 0.2, 0.7);
    return c;
  }

  /** Spent brass off the ejection port. It bounces, it tinks, it stays a while. */
  casing(x, y, z, ang, kind) {
    const rng = this.rng;
    const c = this._take(this.casings, MAX_CASINGS);
    c.type = T_CASING;
    const flak = kind !== 'kinetic';
    c.base = flak ? this.casingFrames.flak : this.casingFrames.nail;
    c.h = flak ? 0.085 : 0.05;
    c.rad = 0.02;
    const side = ang + Math.PI / 2 + randRange(rng, -0.25, 0.25);
    const s = randRange(rng, 1.5, 2.8);
    c.x = x; c.y = y; c.z = z;
    c.vx = Math.cos(side) * s + Math.cos(ang) * randRange(rng, -0.4, 0.3);
    c.vy = Math.sin(side) * s + Math.sin(ang) * randRange(rng, -0.4, 0.3);
    c.vz = randRange(rng, 1.6, 3.0);
    c.ang = rng() * TAU;
    c.spin = randRange(rng, 14, 26) * (rng() < 0.5 ? -1 : 1);
    c.rest = 0.46;
    c.life = randRange(rng, 7, 11);
    return c;
  }

  /** Clockwise on screen when it is travelling screen-right, so it rolls the way it flies. */
  screenSpin(vx, vy) {
    const p = this.game.player;
    const cx = Math.cos(p.ang), cy = Math.sin(p.ang);
    const lateral = cx * vy - cy * vx;
    return lateral >= 0 ? 1 : -1;
  }

  markPunt(c, x, y) {
    c.punted = true;
    c.px0 = x; c.py0 = y;
    c.landed = false;
    c.hitId = 0;
  }

  /** The nearest part or gib inside the Boot's reach, for punting. Heads first. */
  kickable(px, py, ca, sa, range, arc) {
    let best = null, bestS = 1e9;
    const cosArc = Math.cos(arc);
    for (let pass = 0; pass < 2; pass++) {
      const list = pass === 0 ? this.parts : this.gibs;
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (c.fade || c.stuck) continue;
        const dx = c.x - px, dy = c.y - py;
        const d = Math.hypot(dx, dy);
        if (d > range || c.z > 1.1) continue;
        const cosA = (dx * ca + dy * sa) / (d || 1);
        if (cosA < cosArc && d > 0.5) continue;
        // Heads first: nobody walks up to a severed head to kick a toe.
        const s = d - cosA - (c.head ? 1.2 : 0) + (pass ? 0.8 : 0);
        if (s < bestS) { bestS = s; best = c; }
      }
    }
    return best;
  }

  /** Boot meets part. */
  punt(c, ca, sa, pitch) {
    const rng = this.rng;
    const game = this.game;
    const up = c.head ? randRange(rng, 5.2, 7.4) : randRange(rng, 3.4, 5.4);
    const sp = c.head ? randRange(rng, 12, 16) : randRange(rng, 8, 12);
    const lift = clamp(pitch || 0, -0.4, 0.8);
    c.vx = ca * sp; c.vy = sa * sp; c.vz = up + lift * 6;
    c.settled = false; c.stuck = 0; c.fade = 0; c.age = 0;
    if (c.life) c.life = Math.max(c.life, 20);
    c.spin = this.screenSpin(c.vx, c.vy) * randRange(rng, 14, 22) * (rng() < 0.2 ? -1 : 1);
    c.z = Math.max(c.z, c.rad + 0.05);
    c.trail = Math.max(c.trail, 0.5);
    this.markPunt(c, c.x, c.y);
    this.stats.punts++;
    game.sound.sfx('head_punt', { pan: game.panAt(c.x, c.y), rate: c.head ? 1 : 1.2 });
    const P = game.particles;
    for (let i = 0; i < 8; i++) {
      const a = rng() * TAU;
      P.emit(c.x, c.y, c.z, Math.cos(a) * 2 + ca * 3, Math.sin(a) * 2 + sa * 3, randRange(rng, 1, 3),
        randRange(rng, 0.3, 0.7), randRange(rng, 0.03, 0.06), 190, 18, 24, 1, 9, false, true, 0.6, 0);
    }
    game.goreQuip('punt', c.head ? 0.45 : 0.25);
  }

  // ------------------------------------------------------------ fountains

  fountain(e, bit, life, str) {
    let slot = null;
    for (const f of this.fountains) if (f.active && f.e === e && f.bit === bit) { slot = f; break; }
    if (!slot) for (const f of this.fountains) if (!f.active) { slot = f; break; }
    if (!slot) {
      // Full: take over whichever is closest to running dry.
      slot = this.fountains[0];
      for (const f of this.fountains) if (f.life - f.t < slot.life - slot.t) slot = f;
    }
    slot.active = true; slot.e = e; slot.bit = bit;
    slot.t = 0; slot.life = life; slot.next = 0.05; slot.str = str; slot.sp = 0;
    return slot;
  }

  fountainOf(e, bit) {
    for (const f of this.fountains) if (f.active && f.e === e && f.bit === bit) return f;
    return null;
  }

  _pulse(f) {
    const e = f.e;
    const game = this.game;
    const rng = this.rng;
    const J = this.joint(e, f.bit);
    const k = 1 - f.t / f.life;
    const str = f.str * (0.35 + 0.65 * k);
    let jx, jy, jz, sp;
    if (f.bit === HEAD) {
      // Straight up, wobbling, like a garden hose somebody dropped.
      jx = (rng() - 0.5) * 0.7 + J.ox * 0.4; jy = (rng() - 0.5) * 0.7 + J.oy * 0.4; jz = 1;
      sp = randRange(rng, 3.4, 5.2) * str;
      if (!e.alive && e.headlessT <= 0 && e.state === ST.DEAD) { jz = 0.5; jx = J.ox * 2 + (rng() - 0.5); jy = J.oy * 2 + (rng() - 0.5); sp *= 0.6; }
    } else if (f.bit === ARM_R || f.bit === ARM_L) {
      jx = J.ox + (rng() - 0.5) * 0.4; jy = J.oy + (rng() - 0.5) * 0.4; jz = 0.55;
      sp = randRange(rng, 2.4, 3.8) * str;
    } else {
      jx = J.ox * 0.8 + (rng() - 0.5) * 0.6; jy = J.oy * 0.8 + (rng() - 0.5) * 0.6; jz = 0.3;
      sp = randRange(rng, 1.8, 3.0) * str;
    }
    const n = 4 + ((7 * str) | 0);
    const P = game.particles;
    for (let i = 0; i < n; i++) {
      // Spread the pulse along its own length so it reads as a squirt, not a ball.
      const s = sp * randRange(rng, 0.6, 1.2);
      const lag = rng() * 0.05;
      P.emit(J.x + jx * s * lag, J.y + jy * s * lag, J.z + jz * s * lag,
        jx * s + (rng() - 0.5) * 0.4, jy * s + (rng() - 0.5) * 0.4, jz * s + (rng() - 0.5) * 0.3,
        randRange(rng, 0.55, 1.0), randRange(rng, 0.026, 0.06),
        randRange(rng, 170, 230) | 0, randRange(rng, 8, 24) | 0, 22, 0.5, 9.5, false, true, 0.5, 0);
    }
    f.jx = jx; f.jy = jy; f.jz = jz; f.sp = sp;
    const p = game.player;
    const d = Math.hypot(J.x - p.x, J.y - p.y);
    if (d < 9 && this.sndT.spurt <= 0) {
      this.sndT.spurt = 0.2;
      game.sound.sfx('blood_spurt', { pan: game.panAt(J.x, J.y), vol: clamp(str * (1 - d / 10), 0.1, 0.8), rate: randRange(rng, 0.9, 1.15) });
    }
    if (d < 1.7 && rng() < 0.25) game.hud.splatter(1);
  }

  _dribble(f) {
    const J = this.joint(f.e, f.bit);
    const rng = this.rng;
    const s = f.sp * 0.4;
    this.game.particles.emit(J.x, J.y, J.z,
      f.jx * s + (rng() - 0.5) * 0.3, f.jy * s + (rng() - 0.5) * 0.3, f.jz * s,
      randRange(rng, 0.35, 0.6), randRange(rng, 0.022, 0.04), 190, 14, 22, 0.6, 9.5, false, true, 0.5, 0);
  }

  splatterIfClose(x, y, r, n) {
    const game = this.game;
    const p = game.player;
    const d = Math.hypot(x - p.x, y - p.y);
    if (d > r) return;
    // Only if it happened in front of the lens.
    const dot = ((x - p.x) * Math.cos(p.ang) + (y - p.y) * Math.sin(p.ang)) / (d || 1);
    if (dot < 0.3) return;
    game.hud.splatter(clamp(Math.round(n * (1.4 - d / r)), 1, 6));
  }

  // --------------------------------------------------------------- smears

  /**
   * Blood up a wall. Painted as a spray of droplets pinned to the face rather
   * than one billboard: a flat card beside a wall floats the moment you look
   * at it from an angle, a cloud of dots does not. They run, slowly, and dry.
   * (x, y) is a point just off the face; (dx, dy) points into the wall.
   */
  smear(x, y, z, size, heavy, dx, dy) {
    const lv = this.game.level;
    // Work out which face was hit: the normal is whichever axis is solid.
    const sx = dx >= 0 ? 1 : -1, sy = dy >= 0 ? 1 : -1;
    let nx = 0, ny = 0;
    if (Math.abs(dx) > 1e-3 && lv.blocked(x + sx * 0.08, y)) nx = -sx;
    else if (Math.abs(dy) > 1e-3 && lv.blocked(x, y + sy * 0.08)) ny = -sy;
    else return;
    // Only on architecture; a pillar or a drum has no flat face to hold it.
    const ci = lv.idx(x - nx * 0.08, y - ny * 0.08);
    if (lv.wall[ci] !== 1 || lv.propBlock[ci]) return;
    const tx = -ny, ty = nx;
    const rng = this.rng;
    const P = this.game.particles;
    const n = heavy ? 42 : 20;
    const px = x + nx * 0.035, py = y + ny * 0.035;
    for (let i = 0; i < n; i++) {
      // Dense in the middle, ragged at the edges, and stretched along the
      // direction it was travelling.
      const r = Math.pow(rng(), 0.7) * size * 0.6, a = rng() * TAU;
      const u = Math.cos(a) * r * 1.3, w = Math.sin(a) * r * 0.8;
      const big = rng() < 0.18;
      const zz = clamp(z + w, 0.03, 0.96);
      P.emit(px + tx * u, py + ty * u, zz, 0, 0, 0,
        randRange(rng, 6, 11), big ? randRange(rng, 0.045, 0.07) : randRange(rng, 0.016, 0.036),
        randRange(rng, 110, 175) | 0, randRange(rng, 6, 18) | 0, 16,
        5, big ? randRange(rng, 0.1, 0.35) : 0.02, false, true, 0.25, 0);
    }
    // A few runs dripping down from it.
    const runs = heavy ? 5 : 2;
    for (let i = 0; i < runs; i++) {
      const u = (rng() - 0.5) * size * 0.9;
      const top = z + (rng() - 0.3) * size * 0.3;
      const len = randRange(rng, 0.08, 0.3) * (heavy ? 1.5 : 1);
      for (let k = 0; k < 6; k++) {
        const zz = top - (k / 6) * len;
        if (zz < 0.03) break;
        P.emit(px + tx * u, py + ty * u, zz, 0, 0, 0,
          randRange(rng, 7, 11), 0.02 - k * 0.0015, 130, 10, 16, 5, 0.05, false, true, 0.25, 0);
      }
    }
  }

  /** A point just off the nearest wall face from x,y in direction dx,dy. */
  wallPoint(x, y, dx, dy, out) {
    const lv = this.game.level;
    let px = x, py = y;
    for (let t = 0; t < 1.2; t += 0.03) {
      const nx = x + dx * t, ny = y + dy * t;
      if (lv.blocked(nx, ny)) { out.x = px; out.y = py; return true; }
      px = nx; py = ny;
    }
    return false;
  }

  // --------------------------------------------------------------- update

  update(dt) {
    const game = this.game;
    for (const k in this.sndT) this.sndT[k] -= dt;
    for (let i = 0; i < this.fountains.length; i++) {
      const f = this.fountains[i];
      if (!f.active) continue;
      f.t += dt;
      if (f.t >= f.life || !f.e || f.e.gibbedAway) { f.active = false; f.e = null; continue; }
      f.next -= dt;
      if (f.next <= 0) {
        // The heart slows as it runs out of things to pump.
        f.next = 0.2 + 0.26 * (f.t / f.life);
        this._pulse(f);
      } else if (f.sp && f.next > 0.1) {
        // Between beats it keeps dribbling, which is what makes it a fountain.
        this._dribble(f);
      }
    }
    this._stepList(this.parts, dt);
    this._stepList(this.gibs, dt);
    this._stepList(this.casings, dt);
    if (game.player) this._scuff(game.player);
  }

  _stepList(list, dt) {
    for (let i = list.length - 1; i >= 0; i--) {
      const c = list[i];
      this._step(c, dt);
      if (c.dead) { list.splice(i, 1); this.free.push(c); }
    }
  }

  _step(c, dt) {
    c.age += dt;
    if (c.fade > 0) {
      c.fade -= dt / 1.2;
      if (c.fade <= 0) { c.dead = true; return; }
    } else if (c.life > 0 && c.age > c.life) {
      c.fade = 1;
    }
    if (c.stuck > 0) { this._stuck(c, dt); return; }
    if (c.settled) return;

    const lv = this.game.level;
    const sp = Math.abs(c.vx) + Math.abs(c.vy) + Math.abs(c.vz);
    const n = Math.min(5, Math.max(1, Math.ceil(sp * dt / 0.2)));
    const h = dt / n;
    for (let k = 0; k < n && !c.stuck && !c.settled; k++) {
      c.vz -= GRAVITY * h;
      const nx = c.x + c.vx * h;
      if (this._solid(lv, nx, c.y, c.z)) this._wall(c, 1); else c.x = nx;
      const ny = c.y + c.vy * h;
      if (!c.stuck) { if (this._solid(lv, c.x, ny, c.z)) this._wall(c, 2); else c.y = ny; }
      if (c.stuck) break;
      c.z += c.vz * h;
      // Under a roof the ceiling is at one cell; out on a deck it is the sky.
      if (c.z > 0.97 - c.rad && c.vz > 0 && lv.inBounds(c.x, c.y) && !lv.sky[lv.idx(c.x, c.y)]) {
        c.z = 0.97 - c.rad;
        c.vz = -c.vz * 0.3;
      }
      if (c.z <= c.rad) { c.z = c.rad; this._floor(c, h); }
    }
    c.ang += c.spin * dt;

    // Blood trail while it flies.
    if (c.type !== T_CASING && c.trail > 0 && !c.settled && (Math.abs(c.vx) + Math.abs(c.vy) + Math.abs(c.vz)) > 1.5) {
      c.trailT -= dt;
      if (c.trailT <= 0) {
        c.trailT = 0.035;
        c.trail -= 0.035;
        const rng = this.rng;
        this.game.particles.emit(c.x, c.y, c.z, (rng() - 0.5) * 0.6, (rng() - 0.5) * 0.6, (rng() - 0.5) * 0.4,
          randRange(rng, 0.4, 0.8), randRange(rng, 0.026, 0.05), randRange(rng, 150, 205) | 0, 14, 22,
          1.2, 7, false, true, 0.6, 0);
      }
    }

    // A thrown head is a projectile, and the staff are standing in the way.
    if (c.type === T_PART && (c.punted || c.age < 0.5)) {
      const v2 = c.vx * c.vx + c.vy * c.vy;
      if (v2 > 36) this._bonk(c, Math.sqrt(v2));
    }
  }

  _solid(lv, x, y, z) {
    if (!lv.inBounds(x, y)) return true;
    return lv.blockedAt(x, y, z);
  }

  _wall(c, axis) {
    const game = this.game;
    const rng = this.rng;
    const v = axis === 1 ? c.vx : c.vy;
    const speed = Math.abs(v);
    if (axis === 1) { c.vx = -c.vx * c.rest * 1.1; c.vy *= 0.8; } else { c.vy = -c.vy * c.rest * 1.1; c.vx *= 0.8; }
    c.spin = -c.spin * 0.7;
    if (speed < 1.2) return;
    const pan = game.panAt(c.x, c.y);
    if (c.type === T_CASING) { this._tink(c, speed * 0.5); return; }
    if (c.head) game.sound.sfx('bone_bounce', { pan, vol: this.volAt(c.x, c.y, clamp(speed / 10, 0.2, 1)) });
    else if (this.sndT.land <= 0) {
      this.sndT.land = 0.05;
      game.sound.sfx('meat_thud', { pan, vol: this.volAt(c.x, c.y, clamp(speed / 10, 0.15, 0.9)), rate: randRange(rng, 0.9, 1.2) });
    }
    if (speed > 4) {
      const nx = axis === 1 ? -Math.sign(v) : 0, ny = axis === 2 ? -Math.sign(v) : 0;
      const W = this._wp || (this._wp = { x: 0, y: 0 });
      if (this.wallPoint(c.x, c.y, -nx, -ny, W)) this.smear(W.x, W.y, c.z, c.type === T_PART ? 0.3 : 0.2, false, -nx, -ny);
      if (c.punted && c.head && speed > 8 && !c.landed) {
        game.hud.popup(rng() < 0.5 ? 'DOINK' : 'OFF THE POST', { size: 12, life: 1, color: rgba(255, 208, 72, 255), y: -40 });
      }
      // Wet things stick for a moment before gravity wins.
      const stick = c.type === T_GIB ? 0.45 : c.head ? 0 : 0.22;
      if (rng() < stick) {
        c.stuck = randRange(rng, 0.8, 2.2);
        c.snx = nx; c.sny = ny;
        c.x += nx * 0.05; c.y += ny * 0.05;
        c.vx = c.vy = c.vz = 0;
        c.spin = 0;
        c.slide = randRange(rng, 0.06, 0.2);
      }
    }
  }

  _stuck(c, dt) {
    c.stuck -= dt;
    c.z -= c.slide * dt;
    c.dripT -= dt;
    if (c.dripT <= 0) {
      // A little red line on the way down.
      c.dripT = 0.14;
      const rng = this.rng;
      this.game.particles.emit(c.x + c.snx * 0.02, c.y + c.sny * 0.02, c.z, 0, 0, -0.05,
        randRange(rng, 2.5, 4), randRange(rng, 0.03, 0.05), 150, 12, 20, 0, 0, false, true, 0.4, 0);
    }
    if (c.stuck <= 0 || c.z <= c.rad) {
      c.stuck = 0;
      c.vx = c.snx * 0.4; c.vy = c.sny * 0.4; c.vz = 0;
      c.spin = (this.rng() - 0.5) * 6;
    }
  }

  _floor(c, h) {
    const game = this.game;
    const rng = this.rng;
    const vi = -c.vz;
    if (vi > 1.6) {
      c.vz = vi * c.rest;
      c.vx *= 0.72; c.vy *= 0.72;
      c.spin = c.spin * 0.6 + (rng() - 0.5) * 6;
      c.bounces++;
      const pan = game.panAt(c.x, c.y);
      if (c.type === T_CASING) {
        this._tink(c, vi);
      } else if ((c.head || c.bone) && vi > 2.2) {
        game.sound.sfx('bone_bounce', {
          pan, vol: this.volAt(c.x, c.y, clamp(vi / 8, 0.15, 1) * (c.bone ? 0.45 : 1)),
          rate: randRange(rng, 0.9, 1.15) * (c.bone ? 1.35 : 1),
        });
      } else if (!c.landed || vi > 3.5) {
        if (this.sndT.land <= 0) {
          this.sndT.land = 0.045;
          game.sound.sfx('meat_thud', {
            pan, vol: this.volAt(c.x, c.y, clamp(vi / 9, 0.12, 0.9) * (c.type === T_GIB ? 0.6 : 1)),
            rate: randRange(rng, 0.85, 1.2) * (c.type === T_GIB ? 1.25 : 1),
          });
        }
      }
      if (!c.landed && c.type !== T_CASING) {
        game.addDecal(c.x, c.y, 'blood');
        for (let i = 0; i < 5; i++) {
          const a = rng() * TAU, s = randRange(rng, 0.5, 2.2);
          game.particles.emit(c.x, c.y, 0.04, Math.cos(a) * s, Math.sin(a) * s, randRange(rng, 0.5, 1.8),
            randRange(rng, 0.3, 0.6), randRange(rng, 0.025, 0.05), 180, 16, 24, 1.5, 9, false, true, 0.6, 0);
        }
      }
      if (!c.landed && c.punted) this._puntLanded(c);
      c.landed = true;
      return;
    }
    c.vz = 0;
    const speed = Math.hypot(c.vx, c.vy);
    if (c.head) {
      // Heads roll, and they roll the way they are going.
      const k = Math.exp(-2.8 * h);
      c.vx *= k; c.vy *= k;
      c.spin = this.screenSpin(c.vx, c.vy) * speed / Math.max(0.05, c.rad);
    } else {
      const k = Math.exp(-(c.type === T_CASING ? 3 : 7) * h);
      c.vx *= k; c.vy *= k;
      c.spin *= Math.exp(-9 * h);
    }
    if (!c.landed && c.punted) this._puntLanded(c);
    c.landed = true;
    if (speed < 0.14) {
      c.settled = true;
      c.vx = c.vy = 0; c.spin = 0;
      if (c.type === T_PART && !c.head) {
        // Limbs come to rest lying down, not balanced on a stump.
        const q = Math.PI / 2;
        const a = wrapAngle(c.ang);
        c.ang = Math.abs(wrapAngle(a - q)) < Math.abs(wrapAngle(a + q)) ? q : -q;
      }
    }
  }

  _tink(c, v) {
    if (this.sndT.tink > 0) return;
    const game = this.game;
    const p = game.player;
    const d = Math.hypot(c.x - p.x, c.y - p.y);
    if (d > 7) return;
    this.sndT.tink = 0.035;
    // The bone crack is a narrow resonant ping underneath; pitched up and
    // played quiet it is exactly a shell case on concrete.
    game.sound.sfx('bone_crack', {
      pan: game.panAt(c.x, c.y), vol: clamp(v / 6, 0.05, 0.22) * (1 - d / 8),
      rate: randRange(this.rng, 2.0, 2.6) * (c.h > 0.07 ? 0.8 : 1),
    });
  }

  _puntLanded(c) {
    const game = this.game;
    const d = Math.hypot(c.x - c.px0, c.y - c.py0);
    c.punted = false;
    if (d < 6) return;
    const rng = this.rng;
    const yards = Math.round(d * 3.3);
    const pts = Math.min(500, 50 + Math.round(d * 12));
    this.stats.goals++;
    game.player.score += pts;
    const call = PUNT_POP[(rng() * PUNT_POP.length) | 0];
    game.hud.popup(c.head ? call : `${yards} YARD PUNT`, { size: 17, life: 1.6, color: rgba(255, 220, 80, 255), y: -52 });
    game.hud.popup(`${yards} YARDS  +${pts}`, { size: 10, life: 1.4, color: rgba(255, 186, 64, 255), y: -30 });
  }

  _bonk(c, speed) {
    const game = this.game;
    for (const e of game.enemies) {
      if (!e.alive || e.id === c.hitId) continue;
      const r = e.radius + c.rad;
      const dx = c.x - e.x, dy = c.y - e.y;
      if (dx * dx + dy * dy > r * r) continue;
      if (c.z < e.z || c.z > e.z + e.height) continue;
      c.hitId = e.id;
      const L = Math.hypot(c.vx, c.vy) || 1;
      const killed = e.hurt(8 + speed * 1.6, game, c.x, c.y);
      e.shove(c.vx / L, c.vy / L, speed * 0.5, 0);
      game.sound.sfx('head_punt', { pan: game.panAt(e.x, e.y), rate: 0.8 });
      game.sound.sfx('bone_bounce', { pan: game.panAt(e.x, e.y), vol: 0.8 });
      game.hud.hitMark(killed);
      game.particles.blood(c.x, c.y, c.z, 8, c.vx / L, c.vy / L);
      c.vx *= -0.3; c.vy *= -0.3; c.vz = Math.max(c.vz, 2.5);
      if (c.punted) {
        const pts = killed ? 300 : 120;
        game.player.score += pts;
        game.hud.popup(`${BONK_POP[(this.rng() * BONK_POP.length) | 0]}  +${pts}`, {
          size: 15, life: 1.5, color: rgba(255, 220, 80, 255), y: -52,
        });
        c.punted = false;
      }
      return;
    }
  }

  /** Walking through the debris moves the debris. */
  _scuff(p) {
    const pv = Math.hypot(p.vx || 0, p.vy || 0);
    if (pv < 1.2) return;
    for (let pass = 0; pass < 3; pass++) {
      const list = pass === 0 ? this.parts : pass === 1 ? this.gibs : this.casings;
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (!c.settled) continue;
        const dx = c.x - p.x, dy = c.y - p.y;
        const r = 0.3 + c.rad;
        if (dx * dx + dy * dy > r * r) continue;
        const L = Math.hypot(dx, dy) || 1;
        c.settled = false;
        c.vx = p.vx * 0.9 + (dx / L) * 1.2;
        c.vy = p.vy * 0.9 + (dy / L) * 1.2;
        c.vz = c.type === T_CASING ? 1.4 : 0.9;
        c.spin = this.screenSpin(c.vx, c.vy) * 8;
        if (c.type === T_CASING) this._tink(c, 2);
      }
    }
  }

  volAt(x, y, v) {
    const p = this.game.player;
    const d = Math.hypot(x - p.x, y - p.y);
    return clamp(v * (1.15 - d / 18), 0.05, 1);
  }

  // --------------------------------------------------------------- render

  _entry() {
    let s = this._spr[this._sprN];
    if (!s) { s = {}; this._spr[this._sprN] = s; }
    this._sprN++;
    s.wScale = 1; s.tint = 0; s.additive = false; s.emissive = false; s.noFog = false;
    s.maxFrac = 0; s.alpha = 1;
    return s;
  }

  /** Push billboards for every part, gib and casing. */
  collect(out) {
    this._sprN = 0;
    const S = this.art.sprites || {};
    for (let pass = 0; pass < 3; pass++) {
      const list = pass === 0 ? this.parts : pass === 1 ? this.gibs : this.casings;
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        let f = null, h = c.h;
        if (c.keys) {
          let r = Math.round(c.ang / (Math.PI / 4)) % 8;
          if (r < 0) r += 8;
          f = S[c.keys[r]] || S[c.keys[0]];
          if (f) h = f.h * c.pxScale;
        }
        if (!f && c.base) {
          f = rotFrame(c.base, c.ang);
          h = c.h * (f.h / c.base.h);
        }
        if (!f) continue;
        const s = this._entry();
        s.x = c.x; s.y = c.y; s.z = c.z - h * 0.5;
        s.frame = f; s.h = h;
        s.alpha = c.fade > 0 ? c.fade : 1;
        out.push(s);
      }
    }
  }

  get liveCount() { return this.parts.length + this.gibs.length + this.casings.length; }
}
