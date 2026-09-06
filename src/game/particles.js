// particles.js - sparks, blood, smoke, casings, and the animated sprite effects
// (airbursts, mushroom clouds, shockrings) that carry most of the game's spectacle.
//
// Point particles render as tiny additive/alpha dots the renderer tints, so one
// generated frame covers every colour. Effects play a named frame sequence and
// can push a coloured light into the world while they burn.

import { rgba, makeFrame, clamp as pclamp } from '../core/pixels.js';
import { clamp, makeRng, randRange } from '../core/math.js';

const MAX_PARTICLES = 1400;
const MAX_EFFECTS = 220;

function makeDot(size, hard) {
  const f = makeFrame(size, size);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c) / (c + 0.5);
      if (d > 1) continue;
      // Hard dots are solid discs with a soft rim. At low resolution a fast
      // falloff turns into a visible plus sign the moment one gets magnified.
      const a = hard ? Math.min(1, (1 - d) * 3.2) : Math.pow(1 - d, 1.9);
      if (a <= 0.02) continue;
      f.data[y * size + x] = rgba(255, 255, 255, a * 255);
    }
  }
  return f;
}

export class Particles {
  constructor() {
    this.dotSoft = makeDot(11, false);
    this.dotHard = makeDot(9, true);
    this.dotTiny = makeDot(7, true);
    this.pool = [];
    this.live = [];
    this.effects = [];
    this.rng = makeRng(0xf00d);
    for (let i = 0; i < MAX_PARTICLES; i++) this.pool.push(this._blank());
  }

  _blank() {
    return {
      x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, maxLife: 1,
      size: 0.08, r: 255, g: 255, b: 255, drag: 1.6, grav: 2.2,
      additive: true, hard: false, fadePow: 1, grow: 0, bounce: 0, glow: 0,
    };
  }

  clear() {
    while (this.live.length) this.pool.push(this.live.pop());
    this.effects.length = 0;
  }

  _take() {
    if (this.pool.length) return this.pool.pop();
    // Recycle the oldest rather than allocating during a firefight.
    if (this.live.length) return this.live.shift();
    return this._blank();
  }

  spawn(o) {
    const p = this._take();
    p.x = o.x; p.y = o.y; p.z = o.z;
    p.vx = o.vx || 0; p.vy = o.vy || 0; p.vz = o.vz || 0;
    p.maxLife = p.life = o.life || 0.6;
    p.size = o.size || 0.09;
    p.r = o.r; p.g = o.g; p.b = o.b;
    p.drag = o.drag === undefined ? 1.6 : o.drag;
    p.grav = o.grav === undefined ? 2.2 : o.grav;
    p.additive = o.additive !== false;
    p.hard = !!o.hard;
    p.fadePow = o.fadePow || 1;
    p.grow = o.grow || 0;
    p.bounce = o.bounce || 0;
    this.live.push(p);
    return p;
  }

  // ------------------------------------------------------------- emitters

  sparks(x, y, z, n, spread, col, speed = 6) {
    const rng = this.rng;
    for (let i = 0; i < n; i++) {
      const a = rng() * Math.PI * 2, e = (rng() - 0.35) * spread;
      const s = speed * randRange(rng, 0.35, 1.25);
      this.spawn({
        x, y, z,
        vx: Math.cos(a) * Math.cos(e) * s, vy: Math.sin(a) * Math.cos(e) * s, vz: Math.sin(e) * s + 1.4,
        life: randRange(rng, 0.16, 0.52), size: randRange(rng, 0.035, 0.075),
        r: col[0], g: col[1], b: col[2], drag: 2.6, grav: 5.4, hard: true, fadePow: 1.7,
      });
    }
  }

  blood(x, y, z, n, dirX, dirY) {
    const rng = this.rng;
    for (let i = 0; i < n; i++) {
      const a = rng() * Math.PI * 2;
      const s = randRange(rng, 0.6, 3.4);
      this.spawn({
        x, y, z: z + randRange(rng, -0.12, 0.22),
        vx: Math.cos(a) * s + dirX * 1.6, vy: Math.sin(a) * s + dirY * 1.6, vz: randRange(rng, 0.6, 3.2),
        life: randRange(rng, 0.45, 1.05), size: randRange(rng, 0.045, 0.11),
        r: randRange(rng, 120, 190) | 0, g: 16, b: 22,
        drag: 1.1, grav: 8.5, additive: false, hard: true, fadePow: 0.6,
      });
    }
  }

  smoke(x, y, z, n, scale = 1, col = [70, 66, 64]) {
    const rng = this.rng;
    for (let i = 0; i < n; i++) {
      const a = rng() * Math.PI * 2, s = randRange(rng, 0.2, 1.5) * scale;
      this.spawn({
        x, y, z,
        vx: Math.cos(a) * s, vy: Math.sin(a) * s, vz: randRange(rng, 0.5, 2.1) * scale,
        life: randRange(rng, 0.9, 2.4), size: randRange(rng, 0.2, 0.55) * scale,
        r: col[0], g: col[1], b: col[2],
        drag: 0.9, grav: -0.35, additive: false, fadePow: 1.5, grow: 0.55 * scale,
      });
    }
  }

  embers(x, y, z, n, scale = 1) {
    const rng = this.rng;
    for (let i = 0; i < n; i++) {
      const a = rng() * Math.PI * 2, s = randRange(rng, 0.5, 4) * scale;
      this.spawn({
        x, y, z,
        vx: Math.cos(a) * s, vy: Math.sin(a) * s, vz: randRange(rng, 1, 5) * scale,
        life: randRange(rng, 0.5, 1.6), size: randRange(rng, 0.05, 0.14) * scale,
        r: 255, g: randRange(rng, 120, 210) | 0, b: randRange(rng, 20, 70) | 0,
        drag: 1.3, grav: 3.2, fadePow: 1.4,
      });
    }
  }

  dust(x, y, z, n) {
    const rng = this.rng;
    for (let i = 0; i < n; i++) {
      const a = rng() * Math.PI * 2, s = randRange(rng, 0.1, 0.9);
      this.spawn({
        x, y, z: z + rng() * 0.5,
        vx: Math.cos(a) * s, vy: Math.sin(a) * s, vz: randRange(rng, 0.1, 0.8),
        life: randRange(rng, 0.8, 2.0), size: randRange(rng, 0.12, 0.34),
        r: 120, g: 112, b: 98, drag: 1.4, grav: 0.4, additive: false, fadePow: 1.8, grow: 0.3,
      });
    }
  }

  casing(x, y, z, ang) {
    const rng = this.rng;
    const side = ang + Math.PI / 2;
    this.spawn({
      x, y, z,
      vx: Math.cos(side) * randRange(rng, 1.4, 2.6), vy: Math.sin(side) * randRange(rng, 1.4, 2.6),
      vz: randRange(rng, 1.6, 2.8),
      life: 1.5, size: 0.045, r: 210, g: 168, b: 78,
      drag: 0.6, grav: 9.6, additive: false, hard: true, fadePow: 0.3, bounce: 0.35,
    });
  }

  /** A long tapering contrail behind a warhead or shell. */
  trailPuff(x, y, z, col, size, life) {
    this.spawn({
      x, y, z, vx: 0, vy: 0, vz: 0.1,
      life, size, r: col[0], g: col[1], b: col[2],
      drag: 0.4, grav: -0.05, fadePow: 1.4, grow: size * 0.9,
    });
  }

  // -------------------------------------------------------------- effects

  /**
   * @param {object} o {x,y,z,keys,fps,size,additive,light:{r,g,b,intensity,radius,decay},
   *                    fade, wobble}
   */
  effect(o) {
    if (this.effects.length >= MAX_EFFECTS) this.effects.shift();
    const e = {
      x: o.x, y: o.y, z: o.z, keys: o.keys, fps: o.fps || 22,
      size: o.size || 1, t: 0, additive: o.additive !== false,
      light: o.light || null, fade: o.fade === undefined ? 0 : o.fade,
      grow: o.grow || 0, alpha: o.alpha === undefined ? 1 : o.alpha,
      vz: o.vz || 0, vx: o.vx || 0, vy: o.vy || 0, drag: o.drag || 0,
      noFog: !!o.noFog, spinOut: o.spinOut || 0,
    };
    e.dur = e.keys.length / e.fps;
    this.effects.push(e);
    return e;
  }

  airburst(x, y, z, radius, chain = 0) {
    const s = radius * 2.1;
    this.effect({
      x, y, z, keys: ['boom0', 'boom1', 'boom2', 'boom3', 'boom4', 'boom5', 'boom6', 'boom7'],
      fps: 20, size: s, grow: s * 0.35, noFog: true,
      light: { r: 1.0, g: 0.68, b: 0.3, intensity: 2.6 + chain * 0.35, radius: radius * 2.4, decay: 3.4 },
    });
    this.effect({
      x, y, z, keys: ['shockring0', 'shockring1', 'shockring2', 'shockring3'],
      fps: 14, size: s * 1.5, grow: s * 2.2, alpha: 0.75, noFog: true,
    });
    this.embers(x, y, z, 10 + chain * 3, radius * 0.32);
  }

  mushroom(x, y, z) {
    this.effect({
      x, y, z, keys: ['nuke0', 'nuke1', 'nuke2', 'nuke3', 'nuke4', 'nuke5', 'nuke6', 'nuke7', 'nuke8', 'nuke9'],
      fps: 4.5, size: 46, grow: 26, vz: 1.1, noFog: true,
      light: { r: 1.0, g: 0.62, b: 0.28, intensity: 3.2, radius: 60, decay: 0.55 },
    });
  }

  // --------------------------------------------------------------- update

  update(dt, level) {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const p = this.live[i];
      p.life -= dt;
      if (p.life <= 0) { this.live.splice(i, 1); this.pool.push(p); continue; }
      const d = Math.exp(-p.drag * dt);
      p.vx *= d; p.vy *= d; p.vz *= d;
      p.vz -= p.grav * dt;
      const nx = p.x + p.vx * dt, ny = p.y + p.vy * dt;
      if (level && p.z < 1.4 && level.blocked(nx, ny)) {
        // Cheap wall response: kill lateral motion so debris doesn't tunnel.
        p.vx *= -0.24; p.vy *= -0.24;
      } else { p.x = nx; p.y = ny; }
      p.z += p.vz * dt;
      if (p.z < 0.02) {
        p.z = 0.02;
        if (p.bounce > 0 && Math.abs(p.vz) > 0.6) { p.vz = -p.vz * p.bounce; p.vx *= 0.6; p.vy *= 0.6; }
        else { p.vz = 0; p.vx *= 0.72; p.vy *= 0.72; }
      }
      if (p.grow) p.size += p.grow * dt;
    }
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const e = this.effects[i];
      e.t += dt;
      const dd = Math.exp(-e.drag * dt);
      e.vx *= dd; e.vy *= dd;
      e.x += e.vx * dt; e.y += e.vy * dt; e.z += e.vz * dt;
      if (e.grow) e.size += e.grow * dt;
      if (e.t >= e.dur) { this.effects.splice(i, 1); }
    }
  }

  /** Push renderable billboards for everything alive. */
  collect(out, frames) {
    for (let i = 0; i < this.live.length; i++) {
      const p = this.live[i];
      const k = clamp(p.life / p.maxLife, 0, 1);
      const a = Math.pow(k, p.fadePow);
      out.push({
        x: p.x, y: p.y, z: p.z,
        frame: p.hard ? (p.size < 0.06 ? this.dotTiny : this.dotHard) : this.dotSoft,
        h: p.size, wScale: 1,
        tint: rgba(p.r, p.g, p.b, 255),
        alpha: a, additive: p.additive, emissive: p.additive, noFog: p.additive,
        // A speck of blood a hand's width from the lens should not be the size
        // of a door. Cap what any one particle may cover.
        maxFrac: p.additive ? 0.16 : 0.09,
      });
    }
    for (let i = 0; i < this.effects.length; i++) {
      const e = this.effects[i];
      const fi = clamp(Math.floor(e.t * e.fps), 0, e.keys.length - 1);
      const f = frames[e.keys[fi]];
      if (!f) continue;
      const k = clamp(1 - e.t / e.dur, 0, 1);
      out.push({
        x: e.x, y: e.y, z: e.z, frame: f, h: e.size, wScale: 1,
        alpha: e.alpha * (e.fade ? Math.pow(k, e.fade) : 1),
        additive: e.additive, emissive: true, noFog: e.noFog,
      });
    }
  }

  /** Coloured lights contributed by burning effects. */
  collectLights(out) {
    for (let i = 0; i < this.effects.length; i++) {
      const e = this.effects[i];
      const L = e.light;
      if (!L) continue;
      const k = Math.exp(-L.decay * e.t);
      if (k < 0.02) continue;
      out.push({
        x: e.x, y: e.y, r: L.r, g: L.g, b: L.b,
        intensity: L.intensity * k, radius: L.radius,
      });
    }
  }
}
