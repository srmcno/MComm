// player.js - the warden: movement, look, the fuse dial, and pulling triggers.

import { clamp, damp, lerp, wrapAngle, TAU } from '../core/math.js';
import { WEAPONS, WEAPON_ORDER, AMMO_MAX, AMMO_FLAK, AMMO_NAIL, AMMO_CHARGE, weaponBySlot } from './weapons.js';

export const EYE_HEIGHT = 0.56;
export const FUSE_MIN = 6;
export const FUSE_MAX = 145;

export class Player {
  constructor() {
    this.reset();
  }

  reset() {
    this.x = 2.5; this.y = 2.5; this.z = EYE_HEIGHT;
    this.ang = 0;
    this.pitch = 0;              // pixels of shear, converted to elevation on demand
    this.vx = 0; this.vy = 0;
    this.radius = 0.28;
    this.health = 100;
    this.maxHealth = 100;
    this.armour = 0;
    this.dead = false;
    this.keys = [false, false, false];
    this.owned = { pistol: true, splitter: false, nailer: false, halo: false, deadman: false };
    this.ammo = { [AMMO_FLAK]: 60, [AMMO_NAIL]: 0, [AMMO_CHARGE]: 0 };
    this.weapon = 'pistol';
    this.pendingWeapon = null;
    this.cooldown = 0;
    this.fuse = 52;
    this.autoFuse = true;
    this.bob = 0;
    this.bobPhase = 0;
    this.kick = 0;
    this.kickVel = 0;
    this.recoilPitch = 0;
    this.flashTimer = 0;
    this.fireAnim = 0;
    this.stepDist = 0;
    this.hurtFlash = 0;
    this.emp = 0;                 // Deadman aftermath: instruments dead
    this.regenTimer = 0;
    this.lastDamageAt = -99;
    this.score = 0;
    this.kills = 0;
    this.secretsFound = 0;
    this.treasure = 0;
  }

  get spec() { return WEAPONS[this.weapon]; }

  /** Unit 3D aim vector through the crosshair. */
  aimVector(projY) {
    const py = projY > 1 ? projY : 400;
    const elev = Math.atan((this.pitch + this.recoilPitch) / py);
    const ce = Math.cos(elev);
    return { x: Math.cos(this.ang) * ce, y: Math.sin(this.ang) * ce, z: Math.sin(elev), elev };
  }

  ammoFor(key) {
    const s = WEAPONS[key];
    return this.ammo[s.ammo] === undefined ? 0 : this.ammo[s.ammo];
  }

  canFire() {
    const s = this.spec;
    return this.cooldown <= 0 && this.ammoFor(this.weapon) >= s.cost;
  }

  giveAmmo(type, n) {
    const before = this.ammo[type] || 0;
    this.ammo[type] = clamp(before + n, 0, AMMO_MAX[type]);
    return this.ammo[type] - before;
  }

  giveWeapon(key) {
    const isNew = !this.owned[key];
    this.owned[key] = true;
    const s = WEAPONS[key];
    if (s.ammo === AMMO_NAIL) this.giveAmmo(AMMO_NAIL, 90);
    else if (s.ammo === AMMO_CHARGE) this.giveAmmo(AMMO_CHARGE, 1);
    else this.giveAmmo(AMMO_FLAK, 24);
    if (isNew) this.pendingWeapon = key;
    return isNew;
  }

  selectSlot(slot) {
    const k = weaponBySlot(slot);
    if (!k || !this.owned[k] || k === this.weapon) return false;
    this.pendingWeapon = k;
    return true;
  }

  cycleWeapon(dir) {
    const owned = WEAPON_ORDER.filter((k) => this.owned[k]);
    if (owned.length < 2) return false;
    let i = owned.indexOf(this.weapon);
    i = (i + dir + owned.length) % owned.length;
    this.pendingWeapon = owned[i];
    return true;
  }

  hurt(n, game) {
    if (this.dead) return;
    // Armour eats the majority of a hit until it's gone.
    if (this.armour > 0) {
      const soak = Math.min(this.armour, n * 0.6);
      this.armour -= soak;
      n -= soak;
    }
    this.health -= n;
    this.hurtFlash = Math.min(1.2, this.hurtFlash + n / 45);
    this.lastDamageAt = game ? game.time : 0;
    if (this.health <= 0) { this.health = 0; this.dead = true; }
  }

  heal(n) {
    const before = this.health;
    this.health = clamp(this.health + n, 0, this.maxHealth);
    return this.health - before;
  }

  adjustFuse(delta) {
    this.fuse = clamp(this.fuse + delta, FUSE_MIN, FUSE_MAX);
    this.autoFuse = false;
  }

  update(dt, input, level, game) {
    const s = this.spec;
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.flashTimer = Math.max(0, this.flashTimer - dt);
    this.fireAnim = Math.max(0, this.fireAnim - dt);
    this.hurtFlash = damp(this.hurtFlash, 0, 3.4, dt);
    this.emp = Math.max(0, this.emp - dt);

    // The Widow quietly tops you up so you're never stranded with nothing.
    this.regenTimer += dt;
    if (this.regenTimer > 2.6) {
      this.regenTimer = 0;
      if (this.ammo[AMMO_FLAK] < 26) this.giveAmmo(AMMO_FLAK, 2);
    }

    // Weapon swap: the viewmodel dips out and back.
    if (this.pendingWeapon) {
      this.swapT = (this.swapT || 0) + dt * 4.2;
      if (this.swapT >= 0.5 && this.weapon !== this.pendingWeapon) {
        this.weapon = this.pendingWeapon;
        game && game.onWeaponSwitched(this.weapon);
      }
      if (this.swapT >= 1) { this.swapT = 0; this.pendingWeapon = null; }
    }

    // Recoil settles with a spring so it feels weighty rather than snapping.
    this.kickVel += -this.kick * 62 * dt - this.kickVel * 11 * dt;
    this.kick += this.kickVel * dt;
    this.recoilPitch = damp(this.recoilPitch, 0, 9, dt);
  }

  applyLook(dx, dy, sens, invert, projY, h) {
    this.ang = wrapAngle(this.ang + dx * 0.0022 * sens);
    const d = (invert ? -dy : dy) * 0.0022 * sens * projY;
    // Generous up-look: you spend half this game staring at the sky.
    this.pitch = clamp(this.pitch - d, -h * 0.72, h * 1.55);
  }

  moveWith(dt, axes, level, game) {
    const speed = (axes.run ? 5.05 : 3.35) * (this.dead ? 0 : 1);
    const ca = Math.cos(this.ang), sa = Math.sin(this.ang);
    let wx = ca * axes.fwd + (-sa) * -axes.strafe;
    let wy = sa * axes.fwd + (ca) * -axes.strafe;
    const L = Math.hypot(wx, wy);
    if (L > 1) { wx /= L; wy /= L; }
    const targetVx = wx * speed, targetVy = wy * speed;
    // Slight inertia. Not ice, just enough weight to feel like a body.
    this.vx = damp(this.vx, targetVx, 16, dt);
    this.vy = damp(this.vy, targetVy, 16, dt);

    const before = { x: this.x, y: this.y };
    level.move(this, this.vx * dt, this.vy * dt, this.radius);
    const moved = Math.hypot(this.x - before.x, this.y - before.y);

    this.stepDist += moved;
    if (this.stepDist > 1.35) {
      this.stepDist = 0;
      game && game.onFootstep();
    }
    this.bobPhase += moved * 6.4;
    const targetBob = Math.min(moved / dt / 5, 1);
    this.bob = damp(this.bob, targetBob, 9, dt);
    this.z = EYE_HEIGHT + Math.sin(this.bobPhase) * 0.018 * this.bob;

    if (axes.turn) this.ang = wrapAngle(this.ang + axes.turn * 2.4 * dt);
  }
}
