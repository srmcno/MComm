// entities.js - everything walking, hovering or bolted to a wall that wants you dead.

import { clamp, damp, dist, wrapAngle, makeRng, randRange, TAU } from '../core/math.js';

export const ENEMY_TYPES = {
  wrencher: {
    hp: 44, speed: 2.55, radius: 0.32, height: 0.86, eye: 0.5,
    sight: 15, attack: 'melee', range: 1.35, damage: 19, windup: 0.42, cooldown: 1.05,
    score: 100, alert: 'wrencher_alert', pain: 0.28, gib: 3,
    z: 0, walkFps: 7, deathFps: 12, stride: 1.45,
  },
  sparker: {
    hp: 28, speed: 2.9, radius: 0.28, height: 0.8, eye: 0.52,
    sight: 20, attack: 'bolt', range: 15, damage: 9, windup: 0.34, cooldown: 1.35,
    score: 120, alert: 'wrencher_alert', pain: 0.34, gib: 2,
    z: 0, walkFps: 8, deathFps: 13, stride: 1.3, strafes: true,
  },
  bellows: {
    hp: 118, speed: 1.55, radius: 0.40, height: 0.94, eye: 0.55,
    sight: 14, attack: 'flame', range: 5.2, damage: 26, windup: 0.55, cooldown: 0.9,
    score: 300, alert: 'bellows_flame', pain: 0.14, gib: 5, explodes: true,
    z: 0, walkFps: 5, deathFps: 10, stride: 1.05,
  },
  wasp: {
    hp: 22, speed: 4.4, radius: 0.24, height: 0.44, eye: 0.1,
    sight: 22, attack: 'bolt', range: 11, damage: 7, windup: 0.22, cooldown: 0.85,
    score: 150, alert: 'wasp_buzz', pain: 0.18, gib: 2, flying: true,
    z: 0.48, walkFps: 14, deathFps: 13, stride: 0,
  },
  priest: {
    hp: 96, speed: 1.9, radius: 0.32, height: 1.0, eye: 0.62,
    sight: 24, attack: 'bless', range: 999, damage: 0, windup: 1.1, cooldown: 3.2,
    score: 500, alert: 'priest_chant', pain: 0.2, gib: 4,
    z: 0, walkFps: 5, deathFps: 11, stride: 1.2,
  },
  // ---- the radiation cases -------------------------------------------------
  // Everything the leak made out of the day shift. Fast, wet, and wrong.
  ghoul: {
    hp: 34, speed: 4.2, radius: 0.28, height: 0.74, eye: 0.42,
    sight: 18, attack: 'lunge', range: 2.2, damage: 16, windup: 0.30, cooldown: 0.85,
    score: 180, alert: 'ghoul_alert', die: 'ghoul_die', pain: 0.34, gib: 5, mutant: true,
    z: 0, walkFps: 12, deathFps: 14, stride: 1.25, strafes: true, lungeSpeed: 11,
  },
  gorger: {
    hp: 190, speed: 1.25, radius: 0.46, height: 0.92, eye: 0.5,
    sight: 13, attack: 'chomp', range: 1.7, damage: 30, windup: 0.62, cooldown: 1.35,
    score: 450, alert: 'gorger_alert', die: 'gorger_burst', pain: 0.06, gib: 9,
    mutant: true, bursts: true,
    z: 0, walkFps: 4, deathFps: 9, stride: 0.95,
  },
  howler: {
    hp: 70, speed: 2.1, radius: 0.30, height: 1.02, eye: 0.72,
    // Sustained chip damage at 17 cells, from as many howlers as the breach cap
    // allows. It was tuned when the Boot could reach through walls to clear
    // them; now that it cannot, breaking line of sight is the only counter and
    // the spit has to leave room for a player who is doing that imperfectly.
    sight: 24, attack: 'spit', range: 17, damage: 9, windup: 0.72, cooldown: 2.6,
    score: 380, alert: 'howler_alert', die: 'howler_die', pain: 0.24, gib: 6,
    mutant: true, acid: true,
    z: 0, walkFps: 6, deathFps: 11, stride: 1.6, strafes: true,
  },
  stalker: {
    hp: 46, speed: 5.6, radius: 0.26, height: 0.52, eye: 0.3,
    sight: 26, attack: 'rend', range: 1.9, damage: 22, windup: 0.22, cooldown: 0.7,
    score: 300, alert: 'stalker_alert', die: 'stalker_die', pain: 0.18, gib: 5,
    mutant: true, charger: true,
    z: 0, walkFps: 16, deathFps: 15, stride: 2.2, strafes: true, lungeSpeed: 15,
  },
  maw: {
    hp: 1500, speed: 0.9, radius: 0.9, height: 1.9, eye: 1.1,
    sight: 30, attack: 'maw', range: 12, damage: 26, windup: 0.85, cooldown: 1.7,
    score: 4000, alert: 'maw_roar', die: 'maw_die', pain: 0.02, gib: 16,
    mutant: true, miniboss: true,
    z: 0, walkFps: 4, deathFps: 6,
  },

  boss: {
    // Sits on the deck rather than hovering over it; MUTTER is bolted to the silo.
    hp: 2600, speed: 0, radius: 1.2, height: 2.9, eye: 1.6,
    // Damage per BOLT, and it fires five to nine at a time. It was tuned at 16
    // back when a fixed downward slope buried the whole salvo in the deck; a
    // volley that actually arrives has to leave you standing long enough to
    // close on it, which is what the 0.9s windup is a tell for.
    sight: 60, attack: 'boss', range: 60, damage: 6, windup: 0.9, cooldown: 2.1,
    score: 10000, alert: 'boss_roar', pain: 0.0, gib: 20, boss: true,
    z: 0.02, walkFps: 4, deathFps: 6,
  },
};

export const ST = {
  IDLE: 0, ALERT: 1, CHASE: 2, WINDUP: 3, ATTACK: 4, PAIN: 5, DYING: 6, DEAD: 7,
};

let NEXT = 1;

export class Enemy {
  constructor(kind, x, y) {
    const d = ENEMY_TYPES[kind];
    this.id = NEXT++;
    this.kind = kind;
    this.def = d;
    this.x = x; this.y = y;
    this.z = d.z;
    this.hp = d.hp;
    this.maxHp = d.hp;
    this.ang = Math.random() * TAU;
    this.state = ST.IDLE;
    this.stateT = 0;
    this.animT = 0;
    this.animFrame = 0;
    this.cooldown = randRange(Math.random, 0, 0.8);
    this.alive = true;
    this.strafeDir = Math.random() < 0.5 ? 1 : -1;
    this.strafeT = 0;
    this.bobPhase = Math.random() * TAU;
    this.painFlash = 0;
    this.lastSeen = null;
    this.deathFrame = 0;
    // Animation: distance walked (the walk cycle runs off it), time spent
    // standing about (the breathing loop), which flinch is showing, and the
    // beat after an attack when the weight comes back.
    this.walkDist = Math.random() * 4;
    this.idleT = 0;
    this.stillT = 0;
    this.painVar = 0;
    this.recoverT = 0;
    this.rng = makeRng((this.id * 2654435761) >>> 0);
    this.spawnGrace = 0.25;
    this.kvx = 0; this.kvy = 0;      // knockback velocity
    this.airborne = 0;
    this.launched = false;
    // What has come off, as the sprite generator's mask (1 head, 2/4 right and
    // left arm, 8/16 right and left leg), and what that does to getting about.
    this.maim = 0;
    this.limbDmg = new Float32Array(5);
    this.mobility = 1;
    this.hop = false;
    this.crawl = false;
    this.armless = false;
    this.hopPh = 0;
    this.zOff = 0;
    // A body that has lost its head and not yet been told.
    this.headlessT = 0;
    this.zigT = 0;
    // Ragdoll: a dead body's vertical speed and how far it has turned over.
    this.vz = 0;
    this.roll = 0;
    this.rollV = 0;
    this.gibbed = false;
  }

  /** Shove this thing. A hard enough shove into a wall is fatal by itself. */
  shove(dx, dy, force, lift = 0) {
    const L = Math.hypot(dx, dy) || 1;
    // Heavier things move less. A gorger barely notices; a stalker sails.
    const mass = Math.max(0.35, this.def.radius * 2.6 + this.maxHp / 120);
    const f = force / mass;
    this.kvx += (dx / L) * f;
    this.kvy += (dy / L) * f;
    if (lift && this.def.speed > 0) this.airborne = Math.max(this.airborne, lift / mass);
    if (Math.hypot(this.kvx, this.kvy) > 9) this.launched = true;
  }

  get radius() { return this.def.radius; }
  get height() { return this.def.height; }

  /** Sprite key for the current state, given where the camera is. */
  frameKey(camX, camY) {
    if (this.kind === 'maw') return mawFrame(this, camX, camY);
    if (this.kind === 'boss') return mutterFrame(this);
    const K = keysOf(this.kind);
    if (this.state === ST.DEAD) return K.dead;
    if (this.state === ST.DYING && this.headlessT > 0) {
      // Still running. It has not got the memo.
      return K.walk[this.facing(camX, camY)][this.walkFrame()];
    }
    if (this.state === ST.DYING) return K.die[clamp(this.deathFrame | 0, 0, DIE_FRAMES - 1)];
    if (this.painFlash > 0.001 && this.state === ST.PAIN) return K.pain[this.painVar];
    // The attack in beats: wind up, wind all the way up, the strike, the
    // follow-through, and a moment to get the weight back. A lunger shows
    // the strike for as long as it is in the air.
    if (this.state === ST.WINDUP) return this.stateT < this.def.windup * 0.45 ? K.aim0 : K.aim1;
    if (this.state === ST.ATTACK) return this.stateT < 0.09 ? K.fire0 : K.fire1;
    if (this.lungeT > 0) return K.fire1;
    if (this.recoverT > 0) return K.recover;
    const D = this.facing(camX, camY);
    // A hovering drone never stands still: its rotors are the walk.
    if (!this.def.flying && (this.state === ST.IDLE || this.state === ST.ALERT || this.stillT > 0.2)) {
      return K.idle[D][((this.idleT * 1.25 + this.bobPhase) | 0) & 1];
    }
    return K.walk[D][this.walkFrame()];
  }

  /** Walk frame from distance covered, so the feet keep pace with the floor. */
  walkFrame() {
    const st = this.def.stride;
    if (!st) return this.animFrame % WALK_FRAMES;
    return ((this.walkDist / st) * WALK_FRAMES | 0) % WALK_FRAMES;
  }

  /**
   * Which of the four painted views the camera is looking at: 0 the front,
   * 1 the character's right side, 2 its back, 3 its left side, as the sprite
   * generator paints them. Measured from the body's facing round to the
   * camera; on this y-down grid that turn is positive towards the body's
   * right, so a camera off its right flank reads 1 and sees the right arm.
   */
  facing(camX, camY) {
    const a = wrapAngle(Math.atan2(camY - this.y, camX - this.x) - this.ang);
    const d = Math.round(a / (Math.PI / 2));
    return ((d % 4) + 4) % 4;
  }

  hurt(n, game, fromX, fromY) {
    if (!this.alive || this.state === ST.DYING || this.state === ST.DEAD) return false;
    if (this.shielded) {
      // Armour plate. Loud, and completely ineffective.
      this.painFlash = Math.max(this.painFlash, 0.5);
      if (game && !this._clangAt) {
        this._clangAt = 0.2;
        game.sound.sfx('ricochet', { pan: game.panOf(this) });
      }
      return false;
    }
    this.hp -= n;
    this.painFlash = 1;
    if (this.state === ST.IDLE) this.wake(game);
    if (this.hp <= 0) {
      this.state = ST.DYING;
      this.stateT = 0;
      this.deathFrame = 0;
      this.alive = false;
      game.onEnemyKilled(this);
      return true;
    }
    // Bigger creatures shrug off flinching; a Sparker is staggered by anything.
    if (this.rng() < this.def.pain) {
      // a different flinch from the last one, so a burst of hits reads as a burst
      if (this.state !== ST.PAIN || this.stateT > 0.08) this.painVar ^= 1;
      this.state = ST.PAIN;
      this.stateT = 0;
      game.onEnemyPain(this);
    }
    return false;
  }

  wake(game) {
    if (this.state !== ST.IDLE) return;
    this.state = ST.ALERT;
    this.stateT = 0;
    game.onEnemyAlert(this);
  }

  update(dt, game) {
    const p = game.player;
    const lv = game.level;
    const d = this.def;
    this.stateT += dt;
    this.painFlash = damp(this.painFlash, 0, 6, dt);
    if (this._clangAt) { this._clangAt -= dt; if (this._clangAt <= 0) this._clangAt = 0; }
    this.spawnGrace = Math.max(0, this.spawnGrace - dt);
    this.animT += dt;
    if (this.animT > 1 / d.walkFps) { this.animT = 0; this.animFrame++; }
    this.idleT += dt;
    if (this.recoverT > 0) this.recoverT -= dt;

    // Knockback runs whatever the state, so a corpse still slides.
    const floorZ = this.alive ? d.z : (d.flying ? 0 : d.z);
    const flying = !this.alive && this.z > floorZ + 0.03;
    if (this.kvx || this.kvy) {
      const bx = this.x, by = this.y;
      lv.move(this, this.kvx * dt, this.kvy * dt, this.def.radius);
      const moved = Math.hypot(this.x - bx, this.y - by);
      const speed = Math.hypot(this.kvx, this.kvy);
      const want = speed * dt;
      if (this.launched && want > 0.02 && moved < want * 0.45) {
        // Hit a wall while travelling. That is a wall's problem now.
        this.launched = false;
        const sx = this.kvx / (speed || 1), sy = this.kvy / (speed || 1);
        game.onEnemySlammed(this, speed, sx, sy);
        // A corpse comes off the wall; a live body mostly stops dead.
        const rest = this.alive ? -0.18 : -0.34;
        this.kvx *= rest; this.kvy *= rest;
        if (!this.alive) this.rollV = -this.rollV * 0.6;
      }
      // Air barely slows a thrown body; the floor does, and it slides.
      const drag = Math.exp(-(flying ? 0.6 : this.alive ? 6.5 : 3.8) * dt);
      this.kvx *= drag; this.kvy *= drag;
      if (Math.abs(this.kvx) < 0.05 && Math.abs(this.kvy) < 0.05) {
        this.kvx = 0; this.kvy = 0; this.launched = false;
      }
    }
    if (!this.alive && (this.vz !== 0 || this.z > floorZ + 0.002)) this._fall(dt, game, floorZ);
    this._pose(dt, game);
    if (this.airborne > 0) {
      this.airborne -= dt * 4.5;
      if (this.airborne < 0) this.airborne = 0;
    }

    if (this.state === ST.DEAD) return;
    if (this.state === ST.DYING) {
      if (this.headlessT > 0) { this._headless(dt, game); return; }
      const n = DIE_FRAMES;
      this.deathFrame += dt * d.deathFps;
      // In the air it is still twisting over; the floor finishes the job.
      if (this.z > floorZ + 0.05 && this.deathFrame > 2.9) this.deathFrame = 2.9;
      if (this.deathFrame >= n) { this.state = ST.DEAD; this.deathFrame = n - 1; }
      return;
    }

    const toP = dist(this.x, this.y, p.x, p.y);
    const sees = toP < d.sight && lv.lineOfSight(this.x, this.y, p.x, p.y);
    if (sees) this.lastSeen = { x: p.x, y: p.y };

    if (this.state === ST.IDLE) {
      if (sees && !p.dead) this.wake(game);
      return;
    }
    if (this.state === ST.PAIN) {
      if (this.stateT > 0.28) { this.state = ST.CHASE; this.stateT = 0; }
      return;
    }
    if (this.state === ST.ALERT) {
      // A beat of hesitation before the charge. Gives the player a read.
      this.turnToward(p.x, p.y, dt, 7);
      if (this.stateT > 0.32) { this.state = ST.CHASE; this.stateT = 0; }
      return;
    }

    if (this.lungeT > 0) {
      this.lungeT -= dt;
      if (this.lungeDamage && toP < this.def.radius + 0.75) {
        p.hurt(this.lungeDamage, game, this.kind + ':lunge');
        game.onPlayerHurt(this, 'lunge');
        this.lungeDamage = 0;
        this.kvx *= 0.2; this.kvy *= 0.2;
      }
      if (this.lungeT <= 0) this.lungeDamage = 0;
    }

    this.cooldown -= dt;

    if (this.state === ST.WINDUP) {
      this.turnToward(p.x, p.y, dt, 4.5);
      if (this.stateT >= d.windup) {
        this.state = ST.ATTACK;
        this.stateT = 0;
        this._strike(game, sees, toP);
      }
      return;
    }
    if (this.state === ST.ATTACK) {
      if (this.stateT > 0.22) {
        this.state = ST.CHASE;
        this.stateT = 0;
        this.recoverT = 0.24;
        // One hand is slower than two, and no hands is slower still.
        this.cooldown = d.cooldown * randRange(this.rng, 0.85, 1.25) *
          (this.armless ? 1.4 : (this.maim & 6) && d.attack !== 'bless' ? 1.25 : 1);
      }
      return;
    }

    // CHASE
    if (p.dead) { this.state = ST.IDLE; return; }
    // No hands, no gun: the armless close in and use their heads.
    const range = this.armless ? 1.35 : d.range;
    const canAct = sees && this.cooldown <= 0 && toP <= range;
    if (canAct || (d.attack === 'bless' && this.cooldown <= 0 && game.sky.warheads.length)) {
      this.state = ST.WINDUP;
      this.stateT = 0;
      game.onEnemyWindup(this);
      return;
    }

    this.turnToward(this.lastSeen ? this.lastSeen.x : p.x, this.lastSeen ? this.lastSeen.y : p.y, dt, 5);
    if (d.speed <= 0) return;

    // Keep a preferred standoff distance rather than piling onto the player.
    const want = (d.attack === 'melee' || this.armless) ? range * 0.72 : range * 0.62;
    let mx = 0, my = 0;
    const tx = this.lastSeen ? this.lastSeen.x : p.x;
    const ty = this.lastSeen ? this.lastSeen.y : p.y;
    const dx = tx - this.x, dy = ty - this.y;
    const L = Math.hypot(dx, dy) || 1;
    const approach = toP > want ? 1 : (toP < want * 0.55 ? -0.7 : 0);
    mx += (dx / L) * approach;
    my += (dy / L) * approach;

    if (d.strafes || this.armless || (sees && toP < range * 1.3)) {
      this.strafeT -= dt;
      if (this.strafeT <= 0) { this.strafeT = randRange(this.rng, 0.7, 1.9); this.strafeDir *= -1; }
      mx += (-dy / L) * this.strafeDir * 0.55;
      my += (dx / L) * this.strafeDir * 0.55;
    }

    // Nudge apart from crowded neighbours so groups fan out in a doorway.
    for (const o of game.enemies) {
      if (o === this || !o.alive) continue;
      const ddx = this.x - o.x, ddy = this.y - o.y;
      const dd = Math.hypot(ddx, ddy);
      const min = this.radius + o.radius + 0.12;
      if (dd < min && dd > 0.001) {
        mx += (ddx / dd) * (1 - dd / min) * 1.5;
        my += (ddy / dd) * (1 - dd / min) * 1.5;
      }
    }

    const ml = Math.hypot(mx, my);
    let walked = 0;
    if (ml > 0.001) {
      const sp = d.speed * this.mobility * dt;
      const stepX = (mx / ml) * sp, stepY = (my / ml) * sp;
      const before = this.x, beforeY = this.y;
      lv.move(this, stepX, stepY, this.radius);
      walked = Math.hypot(this.x - before, this.y - beforeY);
      if (Math.abs(this.x - before) < 1e-6 && Math.abs(stepX) > 1e-6) {
        // Wall-hugging: swing around instead of grinding into the corner.
        this.strafeDir *= -1;
      }
    }
    // The legs go as far as the body did, and a body that is going nowhere
    // stands and breathes instead of marching on the spot.
    this.walkDist += walked;
    if (walked < d.speed * dt * 0.2) this.stillT += dt; else this.stillT = 0;

    if (this.airborne > 0 && !d.flying) this.z = d.z + this.airborne * 0.10;
    else if (!d.flying) this.z = d.z;
    if (d.flying) {
      this.bobPhase += dt * 3.4;
      this.z = d.z + Math.sin(this.bobPhase) * 0.10 + (toP < 6 ? 0.06 : 0);
    }
  }

  /** A dead body in the air: gravity, a bounce, and a turn or two on the way. */
  _fall(dt, game, floorZ) {
    this.vz -= 15 * dt;
    this.z += this.vz * dt;
    this.roll += this.rollV * dt;
    // Under a roof, a thrown body finds the ceiling before it finds the floor.
    const lv = game.level;
    const top = this.z + this.height * 0.55;
    if (this.vz > 0 && top > 1 && lv.inBounds(this.x, this.y) && !lv.sky[lv.idx(this.x, this.y)]) {
      this.z = 1 - this.height * 0.55;
      if (this.vz > 3) game.sound.sfx('meat_thud', { pan: game.panOf(this), vol: 0.6, rate: 0.8 });
      this.vz = -this.vz * 0.25;
    }
    if (this.z <= floorZ) {
      this.z = floorZ;
      const vi = -this.vz;
      if (vi > 2.6) {
        this.vz = vi * 0.28;
        this.rollV *= 0.45;
        game.onCorpseLanded(this, vi);
      } else {
        this.vz = 0; this.rollV = 0; this.roll = 0;
        if (vi > 1) game.onCorpseLanded(this, vi);
      }
    }
  }

  /** Where the sprite sits: a hop for the one-legged, the floor for the legless. */
  _pose(dt, game) {
    let off = 0;
    const moving = this.alive || this.headlessT > 0;
    if (this.crawl) {
      const rig = game.gore && game.gore.rigOf(this.kind);
      const drop = rig ? rig.hip * this.height : 0;
      const k = this.alive ? 1 : this.state === ST.DYING ? clamp(1 - this.deathFrame / (DIE_FRAMES - 1), 0, 1) : 0;
      if (moving) this.hopPh += dt * 7;
      off = -drop * k + (this.alive ? Math.abs(Math.sin(this.hopPh)) * 0.025 : 0);
    } else if (this.hop && moving) {
      this.hopPh += dt * (this.headlessT > 0 ? 13 : 9.5);
      off = Math.abs(Math.sin(this.hopPh)) * 0.14 * this.height;
    }
    this.zOff = off;
  }

  /** Headless and running: a panicked zigzag into whatever is nearest. */
  _headless(dt, game) {
    const lv = game.level;
    this.headlessT -= dt;
    this.zigT -= dt;
    this.animT += dt * 0.6;    // the legs go faster than they need to
    if (this.zigT <= 0) {
      this.zigT = randRange(this.rng, 0.16, 0.42);
      this.ang = wrapAngle(this.ang + (this.rng() < 0.5 ? -1 : 1) * randRange(this.rng, 0.5, 1.7));
    }
    const sp = Math.max(2.3, this.def.speed * 1.2) * (this.hop ? 0.55 : 1) * dt;
    const bx = this.x, by = this.y;
    lv.move(this, Math.cos(this.ang) * sp, Math.sin(this.ang) * sp, this.radius);
    this.walkDist += Math.hypot(this.x - bx, this.y - by) * 1.4;   // the legs go faster than they need to
    if (Math.hypot(this.x - bx, this.y - by) < sp * 0.4) {
      this.ang = wrapAngle(this.ang + Math.PI + randRange(this.rng, -0.8, 0.8));
      this.zigT = randRange(this.rng, 0.3, 0.6);
      game.onHeadlessBump(this);
    }
    if (this.headlessT <= 0) {
      this.headlessT = 0;
      this.deathFrame = 0;
      game.onHeadlessCollapse(this);
    }
  }

  turnToward(tx, ty, dt, rate) {
    const want = Math.atan2(ty - this.y, tx - this.x);
    this.ang = wrapAngle(this.ang + wrapAngle(want - this.ang) * clamp(rate * dt, 0, 1));
  }

  _strike(game, sees, toP) {
    const d = this.def;
    const p = game.player;
    const dmgScale = (game.diff && game.diff.enemyDamage) || 1;
    if (this.armless) {
      // Both arms gone and still clocked in. It headbutts. A brawler's head
      // was half of what it hit with anyway; the ones that carried a gun or a
      // flamer have lost what made them dangerous, and a headbutt that always
      // lands must not out-hurt a bolt you could have dodged.
      if (sees && toP <= 1.6) {
        const base = d.attack === 'melee' ? Math.max(7, d.damage * 0.6) : Math.min(8, d.damage * 0.4);
        p.hurt(base * dmgScale * randRange(this.rng, 0.8, 1.2), game, this.kind + ':headbutt');
        game.onPlayerHurt(this, 'melee');
      }
      game.sound.sfx('kick_hit', { pan: game.panOf(this), rate: 0.8 });
      return;
    }
    switch (d.attack) {
      case 'melee':
        if (sees && toP <= d.range * 1.2) {
          p.hurt(d.damage * dmgScale * randRange(this.rng, 0.8, 1.2), game, this.kind + ':melee');
          game.onPlayerHurt(this, 'melee');
        }
        game.sound.sfx('wrencher_swing', { pan: game.panOf(this) });
        break;
      case 'bolt':
        if (sees) game.spawnBolt(this, p);
        game.sound.sfx('sparker_fire', { pan: game.panOf(this) });
        break;
      case 'flame':
        if (sees && toP <= d.range) {
          const falloff = 1 - toP / d.range;
          p.hurt(d.damage * dmgScale * falloff * randRange(this.rng, 0.7, 1.1), game, this.kind + ':hitscan');
          game.onPlayerHurt(this, 'flame');
        }
        game.spawnFlame(this, p);
        game.sound.sfx('bellows_flame', { pan: game.panOf(this) });
        break;
      case 'bless':
        game.onPriestBless(this);
        break;
      case 'lunge':
      case 'rend':
        // Throws itself at you. Connecting is not guaranteed, which is the point.
        if (sees) {
          const a = Math.atan2(p.y - this.y, p.x - this.x);
          // A three-legged lunge is a short one.
          this.kvx += Math.cos(a) * (d.lungeSpeed || 10) * this.mobility;
          this.kvy += Math.sin(a) * (d.lungeSpeed || 10) * this.mobility;
          this.lungeDamage = d.damage * dmgScale;
          this.lungeT = 0.42;
        }
        game.sound.sfx(d.attack === 'rend' ? 'stalker_attack' : 'ghoul_attack', { pan: game.panOf(this) });
        break;
      case 'chomp':
        if (sees && toP <= d.range * 1.25) {
          p.hurt(d.damage * dmgScale * randRange(this.rng, 0.85, 1.15), game, this.kind + ':maw');
          game.onPlayerHurt(this, 'chomp');
        }
        game.sound.sfx('gorger_attack', { pan: game.panOf(this) });
        break;
      case 'spit':
        if (sees) game.spawnAcid(this, p);
        game.sound.sfx('howler_spit', { pan: game.panOf(this) });
        break;
      case 'maw':
        game.onMawAttack(this);
        break;
      case 'boss':
        game.onBossAttack(this);
        break;
      default: break;
    }
  }
}

/** A slow visible projectile, so the player can actually dodge. */
export class Bolt {
  constructor(x, y, z, dx, dy, dz, speed, damage, owner) {
    this.x = x; this.y = y; this.z = z;
    this.vx = dx * speed; this.vy = dy * speed; this.vz = dz * speed;
    this.damage = damage;
    this.owner = owner;
    this.life = 4.5;
    this.alive = true;
    this.t = 0;
  }
  update(dt, game) {
    this.t += dt;
    this.life -= dt;
    this.x += this.vx * dt; this.y += this.vy * dt; this.z += this.vz * dt;
    if (this.life <= 0) { this.alive = false; return; }
    if (this.z < 0.05 || this.z > 2.4 || game.level.blockedShot(this.x, this.y, this.z)) {
      this.alive = false;
      game.onBoltImpact(this, null);
      return;
    }
    const p = game.player;
    if (Math.hypot(this.x - p.x, this.y - p.y) < 0.36 && Math.abs(this.z - p.z) < 0.62) {
      this.alive = false;
      p.hurt(this.damage, game, 'bolt');
      game.onPlayerHurt(this.owner, 'bolt');
      game.onBoltImpact(this, p);
    }
  }
}

/**
 * A pipe bomb. Thrown on an arc, bounces, sits there ticking, and goes off when
 * you press the button or when it gets bored. Detonating your own is a
 * legitimate tactic and also a legitimate way to die.
 */
export class PipeBomb {
  constructor(x, y, z, dx, dy, dz, speed, spec, game) {
    this.x = x; this.y = y; this.z = z;
    this.vx = dx * speed; this.vy = dy * speed; this.vz = dz * speed + 3.2;
    this.spec = spec;
    this.fuse = spec.fuse;
    this.alive = true;
    this.settled = false;
    this.t = 0;
    this.beepAt = 0;
    this.spin = 0;
  }

  update(dt, game) {
    this.t += dt;
    this.fuse -= dt;
    this.spin += dt * (this.settled ? 0 : 9);
    if (this.fuse <= 0) { this.alive = false; game.detonateBomb(this); return; }

    // Tick faster as it runs out, which is the whole tension of the thing.
    const period = this.fuse > 3 ? 0.9 : this.fuse > 1.4 ? 0.42 : 0.17;
    if (this.t >= this.beepAt) {
      this.beepAt = this.t + period;
      game.sound.sfx('pipebomb_beep', { pan: game.panAt(this.x, this.y), vol: 0.3 });
    }
    if (this.settled) return;

    this.vz -= 16 * dt;
    const nx = this.x + this.vx * dt, ny = this.y + this.vy * dt;
    if (game.level.blockedAt(nx, ny, this.z)) {
      // Bounce off the wall it hit, on whichever axis actually blocked.
      if (game.level.blockedAt(nx, this.y, this.z)) this.vx *= -0.42; else this.x = nx;
      if (game.level.blockedAt(this.x, ny, this.z)) this.vy *= -0.42; else this.y = ny;
      game.sound.sfx('pipebomb_land', { pan: game.panAt(this.x, this.y), vol: 0.5 });
    } else { this.x = nx; this.y = ny; }
    this.z += this.vz * dt;
    // The floor here, or the top of whatever parapet or prop it came down on.
    const rest = 0.08 + (game.level.restAt ? game.level.restAt(this.x, this.y) : 0);
    if (this.z <= rest) {
      this.z = rest;
      if (Math.abs(this.vz) > 1.4) {
        this.vz = -this.vz * 0.28;
        this.vx *= 0.55; this.vy *= 0.55;
        game.sound.sfx('pipebomb_land', { pan: game.panAt(this.x, this.y), vol: 0.6 });
      } else {
        this.vz = 0; this.vx *= 0.4; this.vy *= 0.4;
        if (Math.hypot(this.vx, this.vy) < 0.3) { this.settled = true; this.vx = 0; this.vy = 0; }
      }
    }
  }
}

const WALK_FRAMES = 8;
const DIE_FRAMES = 6;

// Frame keys per kind, built once: frameKey() runs for every enemy every
// frame and should not be making strings to do it.
const KEYS = {};
function keysOf(k) {
  let K = KEYS[k];
  if (K) return K;
  K = { walk: [], idle: [], die: [], pain: [`${k}_pain0`, `${k}_pain1`], dead: `${k}_dead`,
    aim0: `${k}_aim0`, aim1: `${k}_aim1`, fire0: `${k}_fire0`, fire1: `${k}_fire1`, recover: `${k}_recover` };
  for (let d = 0; d < 4; d++) {
    const w = [], i = [];
    for (let f = 0; f < WALK_FRAMES; f++) w.push(`${k}_walk${d}_${f}`);
    for (let f = 0; f < 2; f++) i.push(`${k}_idle${d}_${f}`);
    K.walk.push(w); K.idle.push(i);
  }
  for (let f = 0; f < DIE_FRAMES; f++) K.die.push(`${k}_die${f}`);
  KEYS[k] = K;
  return K;
}

const MUTTER_KEYS = {
  idle: ['mutter_idle0', 'mutter_idle1', 'mutter_idle2', 'mutter_idle3'],
  fire: ['mutter_fire0', 'mutter_fire1', 'mutter_fire2'],
  die: ['mutter_die0', 'mutter_die1', 'mutter_die2', 'mutter_die3', 'mutter_die4', 'mutter_die5'],
};

/** MUTTER is bolted to the silo: a face, not a body, and its own frame set. */
function mutterFrame(e) {
  if (e.state === ST.DEAD) return 'mutter_dead';
  if (e.state === ST.DYING) return MUTTER_KEYS.die[clamp(e.deathFrame | 0, 0, 5)];
  if (e.painFlash > 0.001 && e.state === ST.PAIN) return 'mutter_pain';
  if (e.state === ST.ATTACK || e.state === ST.WINDUP) return MUTTER_KEYS.fire[e.animFrame % 3];
  return MUTTER_KEYS.idle[e.animFrame % 4];
}

/** The maw reuses the boss frame naming, because it is boss-shaped. */
function mawFrame(e, camX, camY) {
  if (e.state === ST.DEAD) return 'maw_dead';
  if (e.state === ST.DYING) return `maw_die${clamp(e.deathFrame | 0, 0, 5)}`;
  if (e.painFlash > 0.001 && e.state === ST.PAIN) return 'maw_pain';
  if (e.state === ST.ATTACK || e.state === ST.WINDUP) return `maw_fire${clamp(e.animFrame % 3, 0, 2)}`;
  return `maw_idle${e.animFrame % 4}`;
}

/** An arcing glob of something that should not be inside a living thing. */
export class Acid {
  constructor(x, y, z, dx, dy, dz, speed, damage, owner) {
    this.x = x; this.y = y; this.z = z;
    this.vx = dx * speed; this.vy = dy * speed; this.vz = dz * speed + 2.6;
    this.damage = damage;
    this.owner = owner;
    this.life = 5;
    this.alive = true;
    this.t = 0;
  }
  update(dt, game) {
    this.t += dt;
    this.life -= dt;
    this.vz -= 11 * dt;
    this.x += this.vx * dt; this.y += this.vy * dt; this.z += this.vz * dt;
    const p = game.player;
    if (this.life <= 0) { this.alive = false; return; }
    if (Math.hypot(this.x - p.x, this.y - p.y) < 0.42 && Math.abs(this.z - p.z) < 0.7) {
      this.alive = false;
      p.hurt(this.damage, game, 'acid');
      game.onPlayerHurt(this.owner, 'acid');
      game.onAcidSplash(this, true);
      return;
    }
    if (this.z < 0.06 || game.level.blockedAt(this.x, this.y, this.z)) {
      this.alive = false;
      game.onAcidSplash(this, false);
    }
  }
}
