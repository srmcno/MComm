// walldamage.js - the building takes it too.
//
// Rounds leave holes in the walls, blasts leave soot and cracks, and the thin
// walls come down: an office partition, a run of tiles, a salt wall, a block
// of concrete between two rooms can be blown through (and the office board can
// be sawn through). Shooting a strip light puts it out. Shooting a pipe lets
// the steam out, and the steam cooks whoever is standing in it.
//
// Marks are painted into the same per-face overlay the blood writing uses
// (level.scrawl: cell * 4 + face -> { strip, ws, off }), so the raycaster
// draws them for nothing. A wall only comes down where both sides were
// already reachable without a key: a hole can open a short cut, never a way
// round a locked door or into a secret.

import { TEX, rgba } from '../core/pixels.js';
import { dist, makeRng, randRange, TAU } from '../core/math.js';
import { CEIL_H } from '../core/world.js';

const CELL_SOLID = 1;
const MAX_FACES = 260;          // marked faces kept; the oldest go first
const MAX_STEAM = 6;

/** What a wall is made of decides whether it comes down, and what it comes down as. */
function wallStuff(name) {
  if (!name) return null;
  if (name.startsWith('OFFICE')) return { hp: 80, piece: 1, dust: [226, 222, 210], kind: 'board' };
  if (name.startsWith('TILE')) return { hp: 110, piece: 1, tiles: true, dust: [230, 230, 224], kind: 'tile' };
  if (name.startsWith('SALT')) return { hp: 140, piece: 2, dust: [236, 230, 214], kind: 'salt' };
  if (name.startsWith('CONCRETE') || name.startsWith('CRACKED')) return { hp: 220, piece: 0, dust: [150, 146, 136], kind: 'concrete' };
  if (name.startsWith('RUST') && name !== 'RUST_FURNACE') return { hp: 170, piece: 0, sheet: true, dust: [120, 90, 70], kind: 'sheet' };
  return null;
}

const SOOT = [20, 16, 14];

export class WallDamage {
  constructor(game) {
    this.g = game;
    this.rng = makeRng(0x5ca1ab);
    this.faces = [];          // keys this module made, oldest first
    this.hp = new Map();      // breakable cell -> hp left
    this.stuff = new Map();   // breakable cell -> wallStuff
    this.steam = [];
    this.broken = 0;
  }

  /** A new floor: find the walls that can come down. */
  load(lv) {
    this.faces.length = 0;
    this.hp.clear();
    this.stuff.clear();
    this.steam.length = 0;
    this.broken = 0;
    if (!lv) return;
    const { W, H, wall, secret, sky, parapet, doorKind } = lv;
    const names = this.g.art.texNames || [];
    // Rooms you can reach without a key: flood fill through open floor and
    // unlocked doors, stopping at walls, locked doors and secret walls.
    const region = new Int32Array(W * H).fill(-1);
    let label = 0;
    const open = (i) => (wall[i] === 0) || (wall[i] !== CELL_SOLID && !doorKind[i] && !secret[i]);
    for (let s = 0; s < W * H; s++) {
      if (region[s] >= 0 || !open(s)) continue;
      const stack = [s];
      region[s] = label;
      while (stack.length) {
        const i = stack.pop();
        const x = i % W, y = (i / W) | 0;
        for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1]) {
          if (j < 0 || region[j] >= 0 || !open(j)) continue;
          region[j] = label;
          stack.push(j);
        }
      }
      label++;
    }
    for (let y = 2; y < H - 2; y++) {
      for (let x = 2; x < W - 2; x++) {
        const i = y * W + x;
        if (wall[i] !== CELL_SOLID || secret[i] || parapet[i]) continue;
        const st = wallStuff(names[lv.wallTex[i]]);
        if (!st) continue;
        // a partition: floor on two opposite sides, and those are one room already
        let a = -1, b = -1;
        if (wall[i - 1] === 0 && wall[i + 1] === 0 && wall[i - W] && wall[i + W]) { a = i - 1; b = i + 1; }
        else if (wall[i - W] === 0 && wall[i + W] === 0 && wall[i - 1] && wall[i + 1]) { a = i - W; b = i + W; }
        if (a < 0 || sky[a] || sky[b] || region[a] < 0 || region[a] !== region[b]) continue;
        // not beside a door, a secret or the way out
        let bad = false;
        for (let dy = -1; dy <= 1 && !bad; dy++) for (let dx = -1; dx <= 1; dx++) {
          const j = i + dy * W + dx;
          if ((wall[j] && wall[j] !== CELL_SOLID) || secret[j] || lv.exit[j] || lv.trigger[j]) { bad = true; break; }
        }
        if (bad) continue;
        this.hp.set(i, st.hp);
        this.stuff.set(i, st);
      }
    }
  }

  // ------------------------------------------------------------ face overlays

  /** The overlay strip for a face, made if there is none. */
  _strip(i, f) {
    const lv = this.g.level;
    const key = i * 4 + f;
    let ov = lv.scrawl.get(key);
    if (!ov) {
      ov = { strip: new Uint32Array(TEX * TEX), ws: TEX, off: 0, marks: true };
      lv.scrawl.set(key, ov);
      this.faces.push(key);
      if (this.faces.length > MAX_FACES) {
        const old = this.faces.shift();
        const o = lv.scrawl.get(old);
        if (o && o.marks) lv.scrawl.delete(old);
      }
    }
    return ov;
  }

  _blend(ov, tx, ty, r, g, b, a) {
    if (tx < 0 || ty < 0 || tx >= TEX || ty >= TEX || a <= 0) return;
    const k = ty * ov.ws + ov.off + tx;
    const d = ov.strip[k];
    const da = d >>> 24;
    const na = Math.min(255, a + da * (1 - a / 255));
    const t = a / Math.max(1, na);
    const mr = ((d & 255) * (1 - t) + r * t) | 0, mg = (((d >>> 8) & 255) * (1 - t) + g * t) | 0, mb = (((d >>> 16) & 255) * (1 - t) + b * t) | 0;
    ov.strip[k] = ((na | 0) << 24 | mb << 16 | mg << 8 | mr) >>> 0;
  }

  /**
   * Where a ray from (x, y) along (dx, dy) meets the wall: the cell, the face
   * the viewer sees, and the texel. null if there is no wall within `reach`.
   */
  _faceAt(x, y, z, dx, dy, reach = 0.5) {
    const lv = this.g.level;
    const L = Math.hypot(dx, dy) || 1;
    dx /= L; dy /= L;
    let px = x, py = y;
    for (let t = 0; t < reach; t += 0.01) {
      const nx = x + dx * t, ny = y + dy * t;
      const cx = Math.floor(nx), cy = Math.floor(ny);
      if (!lv.inBounds(cx, cy)) return null;
      const i = cy * lv.W + cx;
      if (lv.wall[i] === CELL_SOLID) {
        // which boundary did we cross
        const side = Math.floor(px) !== cx ? 0 : 1;
        let u, f;
        if (side === 0) { u = ny - cy; f = dx < 0 ? 1 : 0; if (dx < 0) u = 1 - u; }
        else { u = nx - cx; f = dy < 0 ? 3 : 2; if (dy > 0) u = 1 - u; }
        const wallH = lv.height[i] || CEIL_H;
        const tx = Math.max(0, Math.min(TEX - 1, (u * TEX) | 0));
        const ty = Math.max(0, Math.min(TEX - 1, (((wallH - z) / wallH) * TEX) | 0));
        return { i, f, tx, ty, x: nx, y: ny, nx: side === 0 ? -Math.sign(dx) : 0, ny: side === 1 ? -Math.sign(dy) : 0 };
      }
      px = nx; py = ny;
    }
    return null;
  }

  /** A round into a wall: a hole with a lip, chips of whatever it was. */
  bulletHole(x, y, z, dx, dy, big = false) {
    const g = this.g, rng = this.rng;
    const hit = this._faceAt(x, y, z, dx, dy);
    if (!hit) return null;
    const ov = this._strip(hit.i, hit.f);
    const r0 = big ? 2 : 1;
    const name = (g.art.texNames || [])[g.level.wallTex[hit.i]] || '';
    const metal = /STEEL|RIVET|PIPES|RUST|VENT|SILO|SCREENS|SERVER|CIRCUIT|LOCKERS/.test(name);
    for (let dy2 = -r0 - 1; dy2 <= r0 + 1; dy2++) {
      for (let dx2 = -r0 - 1; dx2 <= r0 + 1; dx2++) {
        const d = Math.hypot(dx2, dy2);
        if (d <= r0 * 0.75) this._blend(ov, hit.tx + dx2, hit.ty + dy2, 14, 12, 12, 255);
        else if (d <= r0 + 0.6) this._blend(ov, hit.tx + dx2, hit.ty + dy2, metal ? 200 : 60, metal ? 196 : 54, metal ? 186 : 50, metal ? 150 : 170);
        else if (d <= r0 + 1.3 && rng() < 0.4) this._blend(ov, hit.tx + dx2, hit.ty + dy2, 30, 26, 24, 90);
      }
    }
    if (big || rng() < 0.25) {
      // a crack or two off the hole
      for (let k = 0; k < (big ? 3 : 1); k++) this._crack(ov, hit.tx, hit.ty, 3 + (rng() * 5) | 0);
    }
    // breakables take rounds too, a little
    if (this.hp.has(hit.i)) this._hurtWall(hit.i, big ? 6 : 3, hit);
    // a pipe with a hole in it
    if (name.startsWith('PIPES') && this.steam.length < MAX_STEAM && !this.steam.some((s) => s.i === hit.i && s.f === hit.f)) {
      this._steam(hit);
    }
    return hit;
  }

  _crack(ov, x, y, len) {
    const rng = this.rng;
    let a = rng() * TAU;
    for (let k = 0; k < len; k++) {
      a += (rng() - 0.5) * 1.1;
      x += Math.round(Math.cos(a)); y += Math.round(Math.sin(a));
      this._blend(ov, x, y, 22, 18, 16, 200);
    }
  }

  /** Soot on every wall face within reach of a blast, heaviest nearest. */
  scorch(x, y, z, radius) {
    const g = this.g, lv = g.level, rng = this.rng;
    const r = Math.ceil(radius);
    for (let cy = Math.floor(y) - r; cy <= Math.floor(y) + r; cy++) {
      for (let cx = Math.floor(x) - r; cx <= Math.floor(x) + r; cx++) {
        if (!lv.inBounds(cx, cy)) continue;
        const i = cy * lv.W + cx;
        if (lv.wall[i] !== CELL_SOLID) continue;
        // the faces that look toward the blast
        const faces = [];
        if (x < cx) faces.push([0, cx, y]);
        if (x > cx + 1) faces.push([1, cx + 1, y]);
        if (y < cy) faces.push([2, x, cy]);
        if (y > cy + 1) faces.push([3, x, cy + 1]);
        for (const [f, fx, fy] of faces) {
          const px = Math.max(cx, Math.min(cx + 1, fx)), py = Math.max(cy, Math.min(cy + 1, fy));
          const d = Math.hypot(px - x, py - y);
          if (d > radius) continue;
          // only a face the blast can see: not one in the next room, behind another wall
          const ox = f === 0 ? -0.05 : f === 1 ? 0.05 : 0, oy = f === 2 ? -0.05 : f === 3 ? 0.05 : 0;
          if (!lv.lineOfSight(x, y, px + ox, py + oy)) continue;
          const k = 1 - d / radius;
          // where on the face the blast centre falls
          let u = f < 2 ? py - cy : px - cx;
          if (f === 1 || f === 2) u = 1 - u;
          const wallH = lv.height[i] || CEIL_H;
          const tx = (u * TEX) | 0, ty = (((wallH - z) / wallH) * TEX) | 0;
          const ov = this._strip(i, f);
          const R = TEX * (0.25 + 0.55 * k);
          for (let yy = Math.max(0, ty - R) | 0; yy < Math.min(TEX, ty + R); yy++) {
            for (let xx = Math.max(0, tx - R) | 0; xx < Math.min(TEX, tx + R); xx++) {
              const q = Math.hypot(xx - tx, (yy - ty) * 1.3) / R;
              if (q >= 1) continue;
              const n = 0.6 + 0.4 * rng();
              this._blend(ov, xx, yy, SOOT[0], SOOT[1], SOOT[2], (1 - q) * (1 - q) * 210 * k * n);
            }
          }
          if (k > 0.5) for (let c = 0; c < 4; c++) this._crack(ov, tx, ty, 6 + (rng() * 10) | 0);
        }
      }
    }
  }

  /** A blast: soot, cracks, and the thin walls it is close enough to. Returns cells brought down. */
  blast(x, y, z, radius, damage) {
    this.scorch(x, y, z, radius * 0.9);
    this._tubesNear(x, y, radius * 0.7);
    let n = 0;
    for (const [i, hp] of this.hp) {
      const lv = this.g.level;
      const cx = (i % lv.W) + 0.5, cy = ((i / lv.W) | 0) + 0.5;
      const d = dist(x, y, cx, cy);
      if (d > radius + 0.5) continue;
      // through the open, to the face of it nearest the blast; not through another wall
      const nx = cx + Math.max(-0.56, Math.min(0.56, x - cx)), ny = cy + Math.max(-0.56, Math.min(0.56, y - cy));
      if (!lv.lineOfSight(x, y, nx, ny)) continue;
      const k = Math.max(0.15, 1 - Math.max(0, d - 0.5) / radius);
      if (this._hurtWall(i, damage * 2.4 * k, null, x, y)) n++;
    }
    return n;
  }

  /** The saw against a wall. True if it is a wall that gives. */
  saw(x, y, z, dx, dy, amount) {
    const hit = this._faceAt(x, y, z, dx, dy, 1.0);
    if (!hit || !this.hp.has(hit.i)) return false;
    const st = this.stuff.get(hit.i);
    if (st.kind !== 'board' && st.kind !== 'tile') return false;
    const ov = this._strip(hit.i, hit.f);
    for (let k = -3; k <= 3; k++) this._blend(ov, hit.tx, hit.ty + k, 12, 10, 10, 230);
    this._hurtWall(hit.i, amount, hit, x, y);
    return true;
  }

  _hurtWall(i, dmg, hit, fx, fy) {
    const g = this.g, lv = g.level;
    let hp = this.hp.get(i);
    if (hp === undefined) return false;
    hp -= dmg;
    const st = this.stuff.get(i);
    // cracks spread on both faces as it weakens
    const frac = hp / st.hp;
    if (frac < 0.66 && !(st.cracked > 0) || frac < 0.33 && st.cracked < 2) {
      st.cracked = (st.cracked || 0) + 1;
      for (let f = 0; f < 4; f++) {
        const ov = lv.scrawl.get(i * 4 + f) || this._strip(i, f);
        for (let c = 0; c < 5 * st.cracked; c++) this._crack(ov, 10 + ((this.rng() * 44) | 0), 8 + ((this.rng() * 48) | 0), 8 + ((this.rng() * 14) | 0));
      }
      g.sound.sfx('bone_crack', { pan: g.panAt(i % lv.W, (i / lv.W) | 0), vol: 0.5, rate: 0.6 });
    }
    if (hp > 0) { this.hp.set(i, hp); return false; }
    this.breakWall(i, fx, fy);
    return true;
  }

  /** It comes down: the cell is floor now, and the room is full of it. */
  breakWall(i, fx, fy) {
    const g = this.g, lv = g.level, rng = this.rng;
    const st = this.stuff.get(i);
    this.hp.delete(i);
    this.stuff.delete(i);
    const W = lv.W, x = i % W, y = (i / W) | 0;
    const cx = x + 0.5, cy = y + 0.5;
    // take the floor and ceiling of a neighbour
    let nb = -1;
    for (const j of [i - 1, i + 1, i - W, i + W]) if (lv.wall[j] === 0 && !lv.sky[j]) { nb = j; break; }
    lv.wall[i] = 0;
    if (nb >= 0) { lv.floorTex[i] = lv.floorTex[nb]; lv.ceilTex[i] = lv.ceilTex[nb]; }
    for (let f = 0; f < 4; f++) lv.scrawl.delete(i * 4 + f);
    lv.propBlock[i] = 0;
    this.broken++;
    // the debris goes away from whatever did it
    let ax = 0, ay = 0;
    if (fx !== undefined) { ax = cx - fx; ay = cy - fy; const L = Math.hypot(ax, ay) || 1; ax /= L; ay /= L; }
    const P = g.props;
    for (let k = 0; k < 14; k++) {
      const a = rng() * TAU, s = randRange(rng, 1, 4.5);
      P.spawnDebris(st.sheet ? (k % 3 ? 'panel' : 'chunk') : st.tiles && k % 2 ? 'tile' : 'chunk', st.sheet && k % 3 ? 1 : st.piece, cx + (rng() - 0.5) * 0.8, cy + (rng() - 0.5) * 0.8, randRange(rng, 0.2, 1.1),
        Math.cos(a) * s + ax * 3, Math.sin(a) * s + ay * 3, randRange(rng, 0.5, 3.5));
    }
    for (let k = 0; k < 3; k++) g.particles.dust(cx, cy, 0.2 + k * 0.35, 8);
    g.particles.smoke(cx, cy, 0.6, 10, 1.2, st.dust);
    g.addDecal(cx, cy, 'scorch');
    g.sound.sfx('wall_crumble', { pan: g.panAt(cx, cy) });
    g.shake = Math.max(g.shake, 2.2);
    // whoever was on the other side
    for (const e of g.enemies) {
      if (!e.alive) continue;
      const d = dist(cx, cy, e.x, e.y);
      if (d > 1.6) continue;
      const killed = e.hurt(35 * (1 - d / 1.6) + 10, g, cx - ax, cy - ay);
      e.shove(e.x - cx + ax, e.y - cy + ay, 6, 1);
      g.hud.hitMark(killed);
    }
    if (st.sheet) g.particles.sparks(cx, cy, 0.6, 20, 2.4, [255, 210, 150], 6);
    g.hud.popup(st.kind === 'board' ? 'OPEN PLAN OFFICE' : st.kind === 'tile' ? 'RENOVATED' : st.kind === 'sheet' ? 'VENTILATED' : 'NEW DOOR', { size: 13, life: 1.4, color: rgba(255, 208, 72, 255) });
    g.chat('brick', 'brick_smash', { chance: 0.5, cooldown: 6 });
    g.chat('mutter', 'mutter_prop', { chance: 0.35, cooldown: 14, delay: 1.3 });
    g.levelDamage = (g.levelDamage || 0) + 1800;
  }

  // ------------------------------------------------------------ strip lights

  /** A round into the ceiling: if it is a tube, the tube goes. */
  ceilingHit(x, y) {
    const g = this.g, lv = g.level;
    if (!lv.inBounds(x | 0, y | 0)) return false;
    const i = lv.idx(x, y);
    const tube = g.art.texIndex.get('CEIL_TUBE');
    if (tube === undefined || lv.ceilTex[i] !== tube) return false;
    this._breakTube(i);
    return true;
  }

  _tubesNear(x, y, r) {
    const lv = this.g.level, tube = this.g.art.texIndex.get('CEIL_TUBE');
    if (tube === undefined) return;
    const R = Math.ceil(r);
    for (let cy = Math.floor(y) - R; cy <= Math.floor(y) + R; cy++) {
      for (let cx = Math.floor(x) - R; cx <= Math.floor(x) + R; cx++) {
        if (!lv.inBounds(cx, cy)) continue;
        const i = cy * lv.W + cx;
        if (lv.ceilTex[i] === tube && dist(x, y, cx + 0.5, cy + 0.5) < r && lv.lineOfSight(x, y, cx + 0.5, cy + 0.5)) this._breakTube(i);
      }
    }
  }

  _breakTube(i) {
    const g = this.g, lv = g.level;
    const dead = g.art.texIndex.get('CEIL_LAMP_DEAD');
    lv.ceilTex[i] = dead !== undefined ? dead : -1;
    const x = (i % lv.W) + 0.5, y = ((i / lv.W) | 0) + 0.5;
    const k = lv.fixtureLights.findIndex((L) => Math.abs(L.x - x) < 0.3 && Math.abs(L.y - y) < 0.3);
    if (k >= 0) lv.fixtureLights.splice(k, 1);
    g.sound.sfx('tube_pop', { pan: g.panAt(x, y) });
    g.particles.sparks(x, y, CEIL_H - 0.05, 16, 2.2, [220, 240, 255], 3);
    for (let n = 0; n < 8; n++) {
      g.particles.spawn({ x: x + (this.rng() - 0.5) * 0.5, y: y + (this.rng() - 0.5) * 0.5, z: CEIL_H - 0.05, vx: 0, vy: 0, vz: -0.5,
        life: 0.9, size: 0.04, r: 220, g: 236, b: 244, drag: 0.5, grav: 9, additive: false, hard: true, bounce: 0.2 });
    }
    g.hud.popup('LIGHTS OUT', { size: 9, life: 0.9, y: -50, dy: -8, color: rgba(200, 194, 180, 255) });
  }

  // ------------------------------------------------------------ steam

  _steam(hit) {
    const g = this.g;
    const s = { i: hit.i, f: hit.f, x: hit.x + hit.nx * 0.05, y: hit.y + hit.ny * 0.05, z: 0.45 + this.rng() * 0.4,
      nx: hit.nx, ny: hit.ny, t: 5 + this.rng() * 2, snd: 0 };
    this.steam.push(s);
    g.sound.sfx('steam_hiss', { pan: g.panAt(s.x, s.y) });
  }

  update(dt) {
    const g = this.g, rng = this.rng;
    for (let k = this.steam.length - 1; k >= 0; k--) {
      const s = this.steam[k];
      s.t -= dt;
      if (s.t <= 0) { this.steam.splice(k, 1); continue; }
      const n = Math.ceil(dt * 60);
      for (let q = 0; q < n; q++) {
        const sp = randRange(rng, 2.2, 4);
        g.particles.spawn({
          x: s.x, y: s.y, z: s.z, vx: s.nx * sp + (rng() - 0.5) * 0.8, vy: s.ny * sp + (rng() - 0.5) * 0.8, vz: (rng() - 0.3) * 0.8,
          life: randRange(rng, 0.5, 1.1), size: randRange(rng, 0.08, 0.16), r: 236, g: 238, b: 240,
          drag: 1.8, grav: -0.8, additive: false, fadePow: 1.4, grow: 0.9,
        });
      }
      s.snd -= dt;
      if (s.snd <= 0) { s.snd = 2.2; g.sound.sfx('steam_hiss', { pan: g.panAt(s.x, s.y), vol: 0.6 }); }
      // it scalds
      for (const e of g.enemies) {
        if (!e.alive) continue;
        const ax = e.x - s.x, ay = e.y - s.y;
        const along = ax * s.nx + ay * s.ny, perp = Math.abs(-ax * s.ny + ay * s.nx);
        if (along > 0 && along < 1.5 && perp < 0.45) {
          const killed = e.hurt(30 * dt, g, s.x, s.y);
          if (killed) { g.hud.hitMark(true); g.hud.popup('STEAMED', { size: 12, life: 1.1, color: rgba(240, 240, 240, 255) }); }
        }
      }
      const p = g.player;
      const ax = p.x - s.x, ay = p.y - s.y;
      if (!p.dead && ax * s.nx + ay * s.ny > 0 && ax * s.nx + ay * s.ny < 1.2 && Math.abs(-ax * s.ny + ay * s.nx) < 0.35) p.hurt(8 * dt, g, 'steam');
    }
  }
}

export default WallDamage;
