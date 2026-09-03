// entities.js - everything walking, hovering or bolted to a wall that wants you dead.

import { clamp, damp, dist, wrapAngle, makeRng, randRange, TAU } from '../core/math.js';

export const ENEMY_TYPES = {
  wrencher: {
    hp: 44, speed: 2.55, radius: 0.32, height: 0.86, eye: 0.5,
    sight: 15, attack: 'melee', range: 1.35, damage: 19, windup: 0.42, cooldown: 1.05,
    score: 100, alert: 'wrencher_alert', pain: 0.28, gib: 3,
    z: 0, walkFps: 7, deathFps: 11,
  },
  sparker: {
    hp: 28, speed: 2.9, radius: 0.28, height: 0.8, eye: 0.52,
    sight: 20, attack: 'bolt', range: 15, damage: 9, windup: 0.34, cooldown: 1.35,
    score: 120, alert: 'wrencher_alert', pain: 0.34, gib: 2,
    z: 0, walkFps: 8, deathFps: 12, strafes: true,
  },
  bellows: {
    hp: 118, speed: 1.55, radius: 0.40, height: 0.94, eye: 0.55,
    sight: 14, attack: 'flame', range: 5.2, damage: 26, windup: 0.55, cooldown: 0.9,
    score: 300, alert: 'bellows_flame', pain: 0.14, gib: 5, explodes: true,
    z: 0, walkFps: 5, deathFps: 9,
  },
  wasp: {
    hp: 22, speed: 4.4, radius: 0.24, height: 0.44, eye: 0.1,
    sight: 22, attack: 'bolt', range: 11, damage: 7, windup: 0.22, cooldown: 0.85,
    score: 150, alert: 'wasp_buzz', pain: 0.18, gib: 2, flying: true,
    z: 1.05, walkFps: 14, deathFps: 12,
  },
  priest: {
    hp: 96, speed: 1.9, radius: 0.32, height: 1.0, eye: 0.62,
    sight: 24, attack: 'bless', range: 999, damage: 0, windup: 1.1, cooldown: 3.2,
    score: 500, alert: 'priest_chant', pain: 0.2, gib: 4,
    z: 0, walkFps: 5, deathFps: 10,
  },
  boss: {
    // Sits on the deck rather than hovering over it; MUTTER is bolted to the silo.
    hp: 2600, speed: 0, radius: 1.2, height: 2.9, eye: 1.6,
    sight: 60, attack: 'boss', range: 60, damage: 16, windup: 0.9, cooldown: 2.1,
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
    this.rng = makeRng((this.id * 2654435761) >>> 0);
    this.spawnGrace = 0.25;
  }

  get radius() { return this.def.radius; }
  get height() { return this.def.height; }

  /** Sprite key for the current state, given where the camera is. */
  frameKey(camX, camY) {
    const k = this.kind === 'boss' ? 'mutter' : this.kind;
    if (this.state === ST.DEAD) return `${k}_dead`;
    if (this.state === ST.DYING) {
      const n = this.kind === 'boss' ? 6 : 4;
      return `${k}_die${clamp(this.deathFrame | 0, 0, n - 1)}`;
    }
    if (this.painFlash > 0.001 && this.state === ST.PAIN) return `${k}_pain`;
    if (this.kind === 'boss') {
      if (this.state === ST.ATTACK || this.state === ST.WINDUP) {
        return `mutter_fire${clamp(this.animFrame % 3, 0, 2)}`;
      }
      return `mutter_idle${this.animFrame % 4}`;
    }
    if (this.state === ST.ATTACK) return `${k}_fire`;
    if (this.state === ST.WINDUP) return `${k}_aim`;
    const a = wrapAngle(this.ang - Math.atan2(camY - this.y, camX - this.x));
    let d = Math.round(a / (Math.PI / 2));
    d = ((d % 4) + 4) % 4;
    const f = this.state === ST.IDLE ? 0 : this.animFrame % 4;
    return `${k}_walk${d}_${f}`;
  }

  hurt(n, game, fromX, fromY) {
    if (!this.alive || this.state === ST.DYING || this.state === ST.DEAD) return false;
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
    this.spawnGrace = Math.max(0, this.spawnGrace - dt);
    this.animT += dt;
    if (this.animT > 1 / d.walkFps) { this.animT = 0; this.animFrame++; }

    if (this.state === ST.DEAD) return;
    if (this.state === ST.DYING) {
      const n = this.kind === 'boss' ? 6 : 4;
      this.deathFrame += dt * d.deathFps;
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
        this.cooldown = d.cooldown * randRange(this.rng, 0.85, 1.25);
      }
      return;
    }

    // CHASE
    if (p.dead) { this.state = ST.IDLE; return; }
    const canAct = sees && this.cooldown <= 0 && toP <= d.range;
    if (canAct || (d.attack === 'bless' && this.cooldown <= 0 && game.sky.warheads.length)) {
      this.state = ST.WINDUP;
      this.stateT = 0;
      game.onEnemyWindup(this);
      return;
    }

    this.turnToward(this.lastSeen ? this.lastSeen.x : p.x, this.lastSeen ? this.lastSeen.y : p.y, dt, 5);
    if (d.speed <= 0) return;

    // Keep a preferred standoff distance rather than piling onto the player.
    const want = d.attack === 'melee' ? d.range * 0.72 : d.range * 0.62;
    let mx = 0, my = 0;
    const tx = this.lastSeen ? this.lastSeen.x : p.x;
    const ty = this.lastSeen ? this.lastSeen.y : p.y;
    const dx = tx - this.x, dy = ty - this.y;
    const L = Math.hypot(dx, dy) || 1;
    const approach = toP > want ? 1 : (toP < want * 0.55 ? -0.7 : 0);
    mx += (dx / L) * approach;
    my += (dy / L) * approach;

    if (d.strafes || (sees && toP < d.range * 1.3)) {
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
    if (ml > 0.001) {
      const sp = d.speed * dt;
      const stepX = (mx / ml) * sp, stepY = (my / ml) * sp;
      const before = this.x;
      lv.move(this, stepX, stepY, this.radius);
      if (Math.abs(this.x - before) < 1e-6 && Math.abs(stepX) > 1e-6) {
        // Wall-hugging: swing around instead of grinding into the corner.
        this.strafeDir *= -1;
      }
    }

    if (d.flying) {
      this.bobPhase += dt * 3.4;
      this.z = d.z + Math.sin(this.bobPhase) * 0.22 + (toP < 6 ? 0.22 : 0);
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
    switch (d.attack) {
      case 'melee':
        if (sees && toP <= d.range * 1.2) {
          p.hurt(d.damage * dmgScale * randRange(this.rng, 0.8, 1.2), game);
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
          p.hurt(d.damage * dmgScale * falloff * randRange(this.rng, 0.7, 1.1), game);
          game.onPlayerHurt(this, 'flame');
        }
        game.spawnFlame(this, p);
        game.sound.sfx('bellows_flame', { pan: game.panOf(this) });
        break;
      case 'bless':
        game.onPriestBless(this);
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
    if (this.z < 0.05 || this.z > 2.4 || game.level.blocked(this.x, this.y)) {
      this.alive = false;
      game.onBoltImpact(this, null);
      return;
    }
    const p = game.player;
    if (Math.hypot(this.x - p.x, this.y - p.y) < 0.36 && Math.abs(this.z - p.z) < 0.62) {
      this.alive = false;
      p.hurt(this.damage, game);
      game.onPlayerHurt(this.owner, 'bolt');
      game.onBoltImpact(this, p);
    }
  }
}
