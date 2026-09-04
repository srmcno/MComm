// sky.js - the Missile Command half of NUKEHAUS.
//
// Warheads fall out of the dome toward six cities on the horizon. Your flak does
// no contact damage at all: only the airburst kills, so a shot needs azimuth,
// elevation AND range. A burst that catches a warhead cooks off its payload,
// which bursts in turn — that chain is the whole scoring soul of the thing.

import { clamp, dist3, makeRng, randRange, TAU } from '../core/math.js';
import { CITY_AZIMUTH, CITY_NAMES } from '../engine/skybox.js';

export const CITY_RADIUS = 62;
// A shell is inert for its first few metres. Below this it passes through
// geometry rather than bursting on it.
export const FLAK_ARM_DIST = 5.5;

export const SPAWN_RADIUS_MIN = 88;
export const SPAWN_RADIUS_MAX = 118;
export const SPAWN_ALT_MIN = 44;
export const SPAWN_ALT_MAX = 76;

export const WARHEAD_TYPES = {
  // `h` is world height. These are deliberately oversized: a warhead 80 units
  // out has to stay a readable target, not a subpixel speck.
  stick:    { hp: 1, speed: 9.2,  score: 100, frame: 'wh_stick',    h: 5.6, glow: [1.0, 0.55, 0.2] },
  mirv:     { hp: 1, speed: 9.0,  score: 150, frame: 'wh_mirv',     h: 7.0, glow: [1.0, 0.75, 0.3] },
  smart:    { hp: 1, speed: 12.5, score: 300, frame: 'wh_smart',    h: 5.0, glow: [0.4, 1.0, 0.9] },
  screamer: { hp: 1, speed: 19.0, score: 250, frame: 'wh_screamer', h: 4.6, glow: [1.0, 0.35, 0.35] },
  buster:   { hp: 2, speed: 8.5,  score: 400, frame: 'wh_buster',   h: 6.6, glow: [1.0, 0.9, 0.55] },
  mine:     { hp: 1, speed: 0.9,  score: 50,  frame: 'skymine0',    h: 4.2, glow: [0.9, 0.3, 1.0] },
};

export const CITY_MAX_HP = 2;

export class City {
  constructor(i) {
    this.index = i;
    this.name = CITY_NAMES[i];
    this.az = CITY_AZIMUTH[i];
    // Two hits, not one. The first leaves it burning and still worth defending,
    // which is the difference between a setback and a death spiral.
    this.hp = CITY_MAX_HP;
    this.x = 0; this.y = 0;
  }
  get alive() { return this.hp > 0; }
  get burning() { return this.hp === 1; }
  place(cx, cy) {
    this.x = cx + Math.cos(this.az) * CITY_RADIUS;
    this.y = cy + Math.sin(this.az) * CITY_RADIUS;
  }
}

let NEXT_ID = 1;

export class Warhead {
  constructor(type, x, y, z, target) {
    const d = WARHEAD_TYPES[type];
    this.id = NEXT_ID++;
    this.type = type;
    this.x = x; this.y = y; this.z = z;
    this.hp = d.hp;
    this.speed = d.speed;
    this.target = target;        // City, or {x,y,z} for a buster chasing the player
    this.alive = true;
    this.shield = 0;             // an Ordnance Priest can bless one
    this.age = 0;
    this.splitAt = type === 'mirv' ? randRange(Math.random, 26, 34) : -1;
    this.trail = [];
    this.trailT = 0;
    this.evadeCool = 0;
    this.warned = false;
    this.vx = 0; this.vy = 0; this.vz = 0;
    this._aim();
  }

  _aim() {
    const t = this.target;
    const dx = t.x - this.x, dy = t.y - this.y, dz = (t.z || 0) - this.z;
    const L = Math.hypot(dx, dy, dz) || 1;
    this.vx = (dx / L) * this.speed;
    this.vy = (dy / L) * this.speed;
    this.vz = (dz / L) * this.speed;
  }

  get pos() { return this; }
}

export class Flak {
  constructor(x, y, z, dx, dy, dz, speed, fuse, blast, weapon) {
    this.x = x; this.y = y; this.z = z;
    this.vx = dx * speed; this.vy = dy * speed; this.vz = dz * speed;
    this.fuse = fuse;
    this.blast = blast;
    this.weapon = weapon;
    this.travelled = 0;
    this.alive = true;
    this.trail = [];
    this.trailT = 0;
    this.idealRange = -1;    // set by the ranger, for the ACE bonus
  }
}

export class Blast {
  constructor(x, y, z, radius, chain, source) {
    this.x = x; this.y = y; this.z = z;
    this.maxR = radius;
    this.r = radius * 0.18;
    this.t = 0;
    this.life = 0.55 + radius * 0.03;
    this.chain = chain;
    this.source = source;
    this.hit = new Set();
    this.alive = true;
  }
}

export class SkyWar {
  constructor(game) {
    this.game = game;
    this.cities = [];
    for (let i = 0; i < 6; i++) this.cities.push(new City(i));
    this.warheads = [];
    this.flak = [];
    this.blasts = [];
    this.rng = makeRng(0x5eed01);
    this.active = false;
    this.wave = null;
    this.waveIndex = -1;
    this.waveTime = 0;
    this.pending = [];
    this.spawned = 0;
    this.killed = 0;
    this.leaked = 0;
    this.intensity = 0;
    this.comboTimer = 0;
    this.combo = 0;
    this.bestChain = 0;
    this.cx = 0; this.cy = 0;
  }

  placeCities(level) {
    this.cx = level.W * 0.5;
    this.cy = level.H * 0.5;
    for (const c of this.cities) c.place(this.cx, this.cy);
  }

  livingCities() { return this.cities.filter((c) => c.alive); }

  /** Start one wave from the level's siege table. */
  startWave(def, index) {
    this.active = true;
    this.wave = def;
    this.waveIndex = index;
    this.waveTime = 0;
    this.spawned = 0;
    this.killed = 0;
    this.leaked = 0;
    this.intensity = def.intensity || 0.5;
    this.pending = [];
    this.salvos = new Map();
    let salvoId = 1;
    for (const g of def.spawn || []) {
      const n = g.count | 0;
      // Group into salvos of 2-3 launched together. Missile Command's chains
      // came from missiles flying near each other; a 3D dome only gets that if
      // the arsenal is fired in flights rather than one at a time.
      const solo = g.type === 'buster' || g.type === 'mine';
      let i = 0;
      while (i < n) {
        const size = solo ? 1 : Math.min(n - i, 2 + ((this.rng() * 2) | 0));
        const id = salvoId++;
        const centre = n === 1 ? (g.from + g.to) * 0.5
          : g.from + ((g.to - g.from) * i) / Math.max(1, n - 1);
        for (let k = 0; k < size; k++) {
          this.pending.push({
            type: g.type, at: Math.max(0, centre + k * 0.28 + (this.rng() - 0.5) * 0.5),
            speed: g.speed || 1, salvo: solo ? 0 : id,
          });
        }
        i += size;
      }
    }
    this.pending.sort((a, b) => a.at - b.at);
    this.totalToSpawn = this.pending.length;
  }

  endWave() {
    this.active = false;
    this.wave = null;
    for (const w of this.warheads) w.alive = false;
    this.warheads.length = 0;
  }

  get waveComplete() {
    return this.active && this.pending.length === 0 && this.warheads.length === 0 &&
           this.waveTime > 1.5;
  }

  spawnWarhead(type, speedMul = 1, salvo = 0) {
    const alive = this.livingCities();
    if (!alive.length && type !== 'buster') type = 'buster';
    let target, stray = false;
    if (type === 'buster') {
      const p = this.game.player;
      target = { x: p.x, y: p.y, z: 0 };
    } else if ((type === 'stick' || type === 'screamer') && this.rng() < 0.24) {
      // Aimed at the complex, not at a city. Still lethal, just not to them.
      stray = true;
      target = {
        x: this.cx + (this.rng() - 0.5) * this.game.level.W * 0.55,
        y: this.cy + (this.rng() - 0.5) * this.game.level.H * 0.55,
        z: 0,
      };
    } else {
      target = alive[(this.rng() * alive.length) | 0];
    }
    // Members of a salvo share a target and launch point, spread just far
    // enough apart that one good burst can take the flight rather than one shell.
    let lead = salvo ? this.salvos && this.salvos.get(salvo) : null;
    if (salvo && !lead) {
      lead = {
        target, stray,
        az: (target.az === undefined ? this.rng() * TAU : target.az) + (this.rng() - 0.5) * 1.4,
        rad: randRange(this.rng, SPAWN_RADIUS_MIN, SPAWN_RADIUS_MAX),
        alt: randRange(this.rng, SPAWN_ALT_MIN, SPAWN_ALT_MAX),
      };
      if (this.salvos) this.salvos.set(salvo, lead);
    }
    if (lead) { target = lead.target; stray = !!lead.stray; }
    if (lead && lead.stray === undefined) lead.stray = stray;
    const az = type === 'buster' ? this.rng() * TAU
      : lead ? lead.az + (this.rng() - 0.5) * 0.055
      : target.az + (this.rng() - 0.5) * 1.5;
    const rad = lead ? lead.rad + (this.rng() - 0.5) * 5 : randRange(this.rng, SPAWN_RADIUS_MIN, SPAWN_RADIUS_MAX);
    const x = this.cx + Math.cos(az) * rad;
    const y = this.cy + Math.sin(az) * rad;
    const z = lead ? lead.alt + (this.rng() - 0.5) * 6 : randRange(this.rng, SPAWN_ALT_MIN, SPAWN_ALT_MAX);
    const w = new Warhead(type, x, y, z, target);
    w.stray = stray;
    w.speed *= speedMul;
    w._aim();
    if (type === 'mine') { w.vx *= 0.15; w.vy *= 0.15; w.vz = -0.35; }
    this.warheads.push(w);
    this.spawned++;
    return w;
  }

  fireFlak(x, y, z, dx, dy, dz, spec, fuse, idealRange) {
    const f = new Flak(x, y, z, dx, dy, dz, spec.flakSpeed, fuse, spec.blastRadius, spec.id);
    f.idealRange = idealRange;
    this.flak.push(f);
    return f;
  }

  detonate(x, y, z, radius, chain, source) {
    const b = new Blast(x, y, z, radius, chain, source);
    this.blasts.push(b);
    return b;
  }

  update(dt, game) {
    const p = game.player;
    this.comboTimer = Math.max(0, this.comboTimer - dt);
    if (this.comboTimer === 0 && this.combo > 0) {
      this.combo = 0;
    }

    if (this.active) {
      this.waveTime += dt;
      const maxAlive = this.wave.maxAlive || 6;
      while (this.pending.length && this.pending[0].at <= this.waveTime &&
             this.warheads.length < maxAlive) {
        const s = this.pending.shift();
        const w = this.spawnWarhead(s.type, s.speed, s.salvo);
        game.onWarheadLaunched(w);
      }
      // Ramp intensity as the wave's back half arrives.
      const prog = this.totalToSpawn ? 1 - this.pending.length / this.totalToSpawn : 1;
      this.intensity = clamp((this.wave.intensity || 0.5) + prog * 0.35, 0, 1);
    }

    this._updateWarheads(dt, game);
    this._updateFlak(dt, game);
    this._updateBlasts(dt, game);


  }

  _updateWarheads(dt, game) {
    const p = game.player;
    for (let i = this.warheads.length - 1; i >= 0; i--) {
      const w = this.warheads[i];
      if (!w.alive) { this.warheads.splice(i, 1); continue; }
      w.age += dt;

      if (w.type === 'buster') {
        // Re-aims at the player, slowly, so it can be dodged but not ignored.
        const t = w.target;
        t.x = p.x; t.y = p.y; t.z = 0.5;
        const dx = t.x - w.x, dy = t.y - w.y, dz = t.z - w.z;
        const L = Math.hypot(dx, dy, dz) || 1;
        const k = 1 - Math.exp(-0.7 * dt);
        w.vx += ((dx / L) * w.speed - w.vx) * k;
        w.vy += ((dy / L) * w.speed - w.vy) * k;
        w.vz += ((dz / L) * w.speed - w.vz) * k;
      }

      if (w.type === 'smart') {
        w.evadeCool -= dt;
        // Smart bombs sidestep an incoming burst. The counter is to lead them
        // or to bracket with two shells.
        if (w.evadeCool <= 0) {
          for (const f of this.flak) {
            const d = dist3(w.x, w.y, w.z, f.x, f.y, f.z);
            if (d < 16) {
              const px = -w.vy, py = w.vx;
              const L = Math.hypot(px, py) || 1;
              const s = this.rng() < 0.5 ? 1 : -1;
              w.x += (px / L) * s * 2.6;
              w.y += (py / L) * s * 2.6;
              w.z += (this.rng() - 0.3) * 1.6;
              w._aim();
              w.evadeCool = 1.15;
              game.onSmartEvade(w);
              break;
            }
          }
        }
      }

      if (w.type === 'mirv' && w.splitAt > 0 && w.z <= w.splitAt) {
        w.splitAt = -1;
        this._split(w, game);
        // The carrier IS the payload. It used to keep flying after shedding its
        // children, so every MIRV quietly added a third warhead to the wave.
        w.alive = false;
        this.warheads.splice(i, 1);
        continue;
      }

      w.x += w.vx * dt; w.y += w.vy * dt; w.z += w.vz * dt;

      w.trailT += dt;
      if (w.trailT > 0.035) {
        w.trailT = 0;
        w.trail.push(w.x, w.y, w.z);
        if (w.trail.length > 90) w.trail.splice(0, 3);
      }

      if (!w.warned) {
        const d = Math.hypot(w.x - p.x, w.y - p.y);
        if (w.type === 'buster' && d < 70) { w.warned = true; game.onBusterWarning(w); }
        else if (w.type === 'smart' && d < 60) { w.warned = true; game.onSmartWarning(w); }
      }

      if (w.z <= 0.6) {
        w.alive = false;
        this.warheads.splice(i, 1);
        this.leaked++;
        if (w.type === 'buster') game.onBusterImpact(w);
        else if (w.target instanceof City) game.onCityHit(w.target, w);
        else game.onStrayImpact(w);
      }
    }
  }

  _split(parent, game) {
    // Two, not three. Each MIRV used to triple a wave's real budget behind the
    // designer's back, which is why the later levels were unplayable.
    const n = 2;
    const alive = this.livingCities();
    for (let i = 0; i < n; i++) {
      const t = alive.length ? alive[(this.rng() * alive.length) | 0] : parent.target;
      const w = new Warhead('stick', parent.x, parent.y, parent.z, t);
      w.speed *= 1.05;
      w._aim();
      // Fan them out so a single burst can't trivially catch all three.
      w.vx += (this.rng() - 0.5) * 3.2;
      w.vy += (this.rng() - 0.5) * 3.2;
      this.warheads.push(w);
      this.spawned++;
    }
    game.onMirvSplit(parent);
  }

  _updateFlak(dt, game) {
    for (let i = this.flak.length - 1; i >= 0; i--) {
      const f = this.flak[i];
      const speed = Math.hypot(f.vx, f.vy, f.vz);
      // Stop exactly on the fuse distance rather than at the end of whatever
      // frame crossed it; a fast shell can otherwise overshoot by metres, which
      // is the difference between an airburst and a near miss.
      let h = dt;
      if (f.travelled + speed * dt >= f.fuse) h = Math.max(0, (f.fuse - f.travelled) / speed);
      const step = speed * h;
      const px = f.x, py = f.y, pz = f.z;
      f.x += f.vx * h; f.y += f.vy * h; f.z += f.vz * h;
      f.travelled += step;
      f.trailT += dt;
      if (f.trailT > 0.02) { f.trailT = 0; f.trail.push(f.x, f.y, f.z); if (f.trail.length > 30) f.trail.splice(0, 3); }

      let pop = false;
      if (f.travelled >= f.fuse) pop = true;
      // Same arming rule for the ground plane, or a shot fired downhill detonates
      // between the player's boots.
      if ((f.z < 0.4 && f.travelled > FLAK_ARM_DIST) || f.travelled > 190) pop = true;
      // A sky mine cooks a shell early. That's what mines are for.
      if (!pop) {
        for (const w of this.warheads) {
          if (w.type !== 'mine') continue;
          if (dist3(f.x, f.y, f.z, w.x, w.y, w.z) < 2.6) { pop = true; break; }
        }
      }
      // Shells burst on architecture, but only on what is actually in the way:
      // a parapet stops nothing above its cap, and the map boundary stops
      // nothing at all, since every warhead lives beyond it.
      // Sweep the whole step. A shell covers better than two cells per frame, so
      // testing only where it landed let it tunnel clean through a one-cell wall.
      // Nothing bursts inside the arming distance: a shell that clips the parapet
      // at the player's elbow passes through it, the way real flak does, instead
      // of taking his face off for shooting across his own deck.
      if (!pop && game.level && f.travelled > FLAK_ARM_DIST && (f.z < 1.4 || pz < 1.4)) {
        const n = Math.max(1, Math.ceil(step / 0.45));
        for (let k = 1; k <= n; k++) {
          const t = k / n;
          const sx = px + (f.x - px) * t, sy = py + (f.y - py) * t, sz = pz + (f.z - pz) * t;
          if (sz >= 1.4) continue;
          if (game.level.blockedAt(sx, sy, sz)) {
            // Burst at the contact point, not past it.
            f.x = sx; f.y = sy; f.z = sz;
            pop = true;
            break;
          }
        }
      }

      if (pop) {
        f.alive = false;
        this.flak.splice(i, 1);
        const b = this.detonate(f.x, f.y, f.z, f.blast, 0, f.weapon);
        b.idealRange = f.idealRange;
        b.travelled = f.travelled;
        game.onFlakBurst(b, f);
      }
    }
  }

  _updateBlasts(dt, game) {
    for (let i = this.blasts.length - 1; i >= 0; i--) {
      const b = this.blasts[i];
      b.t += dt;
      const k = clamp(b.t / b.life, 0, 1);
      // Fast out, slow settle: reads as a real overpressure front.
      b.r = b.maxR * (1 - Math.pow(1 - k, 2.4));
      const lethal = b.t < b.life * 0.72;

      if (lethal) {
        for (let j = this.warheads.length - 1; j >= 0; j--) {
          const w = this.warheads[j];
          if (!w.alive || b.hit.has(w.id)) continue;
          if (dist3(b.x, b.y, b.z, w.x, w.y, w.z) > b.r) continue;
          b.hit.add(w.id);
          if (w.shield > 0) { w.shield--; game.onShieldBreak(w); continue; }
          w.alive = false;
          this.warheads.splice(j, 1);
          this.killed++;
          const chain = b.chain + 1;
          this.bestChain = Math.max(this.bestChain, chain);
          game.onWarheadKilled(w, b, chain);
          // The warhead's own payload cooks off, and it is a bigger charge than
          // the shell that lit it. Chains grow for a few links, then choke, so a
          // well-placed first burst can cascade without becoming a free win.
          if (chain < 7) {
            const grow = chain < 4 ? 1.16 : 0.72;
            const sub = this.detonate(w.x, w.y, w.z, Math.min(b.maxR * grow, 16), chain, b.source);
            sub.secondary = true;
          }
        }
        // Blasts also swat the player and enemies if you burst too close.
        const p = game.player;
        if (!b.hurtPlayer) {
          const d = dist3(b.x, b.y, b.z, p.x, p.y, p.z);
          if (d < b.r * 0.85) { b.hurtPlayer = true; game.onBlastHurtPlayer(b, d); }
        }
        game.onBlastSweep(b);
      }

      if (b.t >= b.life) { b.alive = false; this.blasts.splice(i, 1); }
    }
  }

  /**
   * Pick the warhead nearest to a view ray. Drives the auto-ranger, the lead
   * marker and the "TRACKING" readout.
   * @returns {{target, range, lead:{x,y,z}, angle}|null}
   */
  rangeAlong(ox, oy, oz, dx, dy, dz, flakSpeed, maxAngle = 0.32) {
    let best = null, bestScore = Infinity;
    for (const w of this.warheads) {
      const vx = w.x - ox, vy = w.y - oy, vz = w.z - oz;
      const L = Math.hypot(vx, vy, vz);
      if (L < 2) continue;
      const cosA = (vx * dx + vy * dy + vz * dz) / L;
      if (cosA <= 0) continue;
      const ang = Math.acos(clamp(cosA, -1, 1));
      if (ang > maxAngle) continue;
      // Favour a tight angle, then proximity.
      const score = ang * 60 + L * 0.03;
      if (score < bestScore) { bestScore = score; best = { w, L, ang }; }
    }
    if (!best) return null;
    const w = best.w;
    // Iterative intercept solve: three passes is plenty at these speeds.
    let t = best.L / flakSpeed;
    for (let i = 0; i < 3; i++) {
      const px = w.x + w.vx * t, py = w.y + w.vy * t, pz = w.z + w.vz * t;
      t = Math.hypot(px - ox, py - oy, pz - oz) / flakSpeed;
    }
    const lx = w.x + w.vx * t, ly = w.y + w.vy * t, lz = w.z + w.vz * t;
    return {
      target: w,
      range: Math.hypot(lx - ox, ly - oy, lz - oz),
      lead: { x: lx, y: ly, z: lz },
      angle: best.ang,
      direct: best.L,
    };
  }

  /** Everything the HUD needs to draw threat arrows. */
  threats() { return this.warheads; }
}
