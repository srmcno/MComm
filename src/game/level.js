// level.js - turns parsed map data into the flat typed arrays the renderer eats,
// and owns everything that mutates the grid at runtime: doors, secret pushwalls,
// and the roof panels that grind open when a siege starts.

import { clamp, damp } from '../core/math.js';

export const CELL_EMPTY = 0;
export const CELL_SOLID = 1;
export const CELL_DOOR = 2;
export const CELL_SECRET = 3;

const DOOR_SPEED = 1.7;       // fraction of a cell per second
const DOOR_HOLD = 4.5;        // seconds a door stays open before closing itself
const PUSH_STEP_TIME = 0.34;  // seconds per cell a pushwall travels
export const PARAPET_H = 0.44;

export class Level {
  /**
   * @param {object} parsed  from game/maps.js parseLevel()
   * @param {object} art     { texIndex: Map<string,number> }
   */
  constructor(parsed, art) {
    const W = this.W = parsed.w;
    const H = this.H = parsed.h;
    const n = W * H;
    this.def = parsed;
    this.name = parsed.name;
    this.index = parsed.index;

    this.wall = new Uint8Array(n);          // CELL_* kind
    this.wallTex = new Int16Array(n);
    this.floorTex = new Int16Array(n).fill(-1);
    this.ceilTex = new Int16Array(n).fill(-1);
    this.sky = new Uint8Array(n);
    this.height = new Float32Array(n).fill(1);
    this.doorOpen = new Float32Array(n);
    this.doorVert = new Int8Array(n);       // 0 none, 1 plane at x+0.5, 2 plane at y+0.5
    this.doorKind = new Uint8Array(n);      // 0 free, 1 red, 2 blue, 3 gold
    this.doorTimer = new Float32Array(n);
    this.doorState = new Uint8Array(n);     // 0 shut, 1 opening, 2 open, 3 closing
    this.secret = new Uint8Array(n);
    this.trigger = new Uint8Array(n);
    this.exit = new Uint8Array(n);
    this.visited = new Uint8Array(n);       // for the automap
    this.roofPanel = new Uint8Array(n);     // sky cells that start closed
    this.propBlock = new Uint8Array(n);     // pillars and other standing props
    this.decal = new Int16Array(n).fill(-1); // floor decal index, -1 for none
    this.decalAge = new Float32Array(n);
    this.roofOpen = 0;                      // 0..1 how far the roof has ground back

    const tex = (name, fallback = 0) => {
      const i = art.texIndex.get(name);
      return i === undefined ? fallback : i;
    };
    this.texIndex = art.texIndex;

    for (let i = 0; i < n; i++) {
      const wt = parsed.wallTexName[i];
      if (wt) {
        this.wall[i] = CELL_SOLID;
        this.wallTex[i] = tex(wt);
      }
      this.floorTex[i] = tex(parsed.floorTexName[i] || 'FLOOR_CONCRETE');
      const ct = parsed.ceilTexName[i];
      this.ceilTex[i] = ct ? tex(ct) : -1;
      if (parsed.sky[i]) { this.sky[i] = 1; this.roofPanel[i] = 1; this.ceilTex[i] = -1; }
      if (parsed.secret[i]) { this.secret[i] = 1; }
      if (parsed.trigger[i]) this.trigger[i] = 1;
      if (parsed.exit[i]) this.exit[i] = 1;
    }

    this.doorJambTex = tex('DOOR_JAMB', tex('STEEL_PLATE'));
    for (const d of parsed.doors || []) {
      const i = d.y * W + d.x;
      this.wall[i] = CELL_DOOR;
      this.doorKind[i] = d.kind === 'red' ? 1 : d.kind === 'blue' ? 2 : d.kind === 'gold' ? 3 : 0;
      this.wallTex[i] = tex(
        d.kind === 'red' ? 'DOOR_RED' : d.kind === 'blue' ? 'DOOR_BLUE'
          : d.kind === 'gold' ? 'DOOR_GOLD' : 'DOOR');
      // A door slides along the axis of the wall it sits in.
      const solidX = this.isSolidRaw(d.x - 1, d.y) && this.isSolidRaw(d.x + 1, d.y);
      this.doorVert[i] = solidX ? 2 : 1;
    }

    // The roof over a silo deck starts shut. Sieges open it; that grinding sound
    // and the widening slot of sky is the game's best moment.
    this.deckCeilTex = tex('CEIL_CONCRETE');
    this.closeRoof();

    this.autoParapets();
    this.pushwalls = [];
    this.lights = [];
  }

  isSolidRaw(x, y) {
    if (x < 0 || y < 0 || x >= this.W || y >= this.H) return true;
    const c = this.wall[y * this.W + x];
    return c === CELL_SOLID;
  }

  /**
   * Any wall touching open sky is dropped to parapet height, so a deck reads as
   * a rooftop with a blast berm around it and the horizon stays visible.
   */
  autoParapets() {
    const { W, H } = this;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (this.wall[i] !== CELL_SOLID) continue;
        let touchesSky = false;
        if (x > 0 && this.roofPanel[i - 1]) touchesSky = true;
        if (x < W - 1 && this.roofPanel[i + 1]) touchesSky = true;
        if (y > 0 && this.roofPanel[i - W]) touchesSky = true;
        if (y < H - 1 && this.roofPanel[i + W]) touchesSky = true;
        if (touchesSky) {
          this.height[i] = PARAPET_H;
          // Parapets get their own capping material so the silhouette reads.
          const t = this.texIndex.get('SANDBAG');
          if (t !== undefined && Math.abs((x * 7 + y * 13) % 5) < 2) this.wallTex[i] = t;
        }
      }
    }
  }

  openRoof() { this.roofTarget = 1; }
  closeRoof() {
    this.roofTarget = 0; this.roofOpen = 0;
    for (let i = 0; i < this.sky.length; i++) {
      if (this.roofPanel[i]) { this.sky[i] = 0; this.ceilTex[i] = this.deckCeilTex; }
    }
  }

  updateRoof(dt) {
    if (this.roofTarget === undefined) return false;
    const before = this.roofOpen;
    this.roofOpen = clamp(this.roofOpen + (this.roofTarget ? dt / 3.1 : -dt / 2.2), 0, 1);
    if (this.roofOpen === before) return false;
    // Panels retract from the middle of the deck outward, so the slot of sky
    // widens rather than blinking on.
    let cx = 0, cy = 0, cn = 0;
    if (this._deckCentre === undefined) {
      for (let y = 0; y < this.H; y++) for (let x = 0; x < this.W; x++) {
        if (this.roofPanel[y * this.W + x]) { cx += x; cy += y; cn++; }
      }
      this._deckCentre = cn ? [cx / cn, cy / cn] : [this.W / 2, this.H / 2];
      let maxd = 1;
      for (let y = 0; y < this.H; y++) for (let x = 0; x < this.W; x++) {
        if (this.roofPanel[y * this.W + x]) {
          maxd = Math.max(maxd, Math.hypot(x - this._deckCentre[0], y - this._deckCentre[1]));
        }
      }
      this._deckRadius = maxd;
    }
    const [dcx, dcy] = this._deckCentre;
    const reach = this.roofOpen * (this._deckRadius + 1.2);
    for (let y = 0; y < this.H; y++) {
      for (let x = 0; x < this.W; x++) {
        const i = y * this.W + x;
        if (!this.roofPanel[i]) continue;
        const open = Math.hypot(x - dcx, y - dcy) <= reach;
        this.sky[i] = open ? 1 : 0;
        this.ceilTex[i] = open ? -1 : this.deckCeilTex;
      }
    }
    return true;
  }

  idx(x, y) { return (y | 0) * this.W + (x | 0); }
  inBounds(x, y) { return x >= 0 && y >= 0 && x < this.W && y < this.H; }

  /** True if a body of `radius` cannot occupy this point. */
  blocked(x, y) {
    if (x < 0 || y < 0 || x >= this.W || y >= this.H) return true;
    const i = this.idx(x, y);
    if (this.propBlock[i]) return true;
    const c = this.wall[i];
    if (c === CELL_SOLID) return true;
    if (c === CELL_DOOR) {
      // The slab occupies the middle of the cell along its sliding axis.
      const open = this.doorOpen[i];
      if (open > 0.92) return false;
      if (this.doorVert[i] === 1) {
        if (Math.abs(x - ((x | 0) + 0.5)) > 0.30) return false;
        return (y - (y | 0)) >= open;
      } else {
        if (Math.abs(y - ((y | 0) + 0.5)) > 0.30) return false;
        return (x - (x | 0)) >= open;
      }
    }
    return false;
  }

  /**
   * Height-aware collision for things that fly.
   *
   * Two differences from blocked(): a parapet only stops what is below its
   * cap, and leaving the map is not an obstruction — flak has to cross the
   * boundary, because every warhead in the game is outside it.
   */
  blockedAt(x, y, z) {
    if (x < 0 || y < 0 || x >= this.W || y >= this.H) return false;
    const i = this.idx(x, y);
    if (this.propBlock[i] && z < 0.95) return true;
    const c = this.wall[i];
    if (c === CELL_SOLID) return z < this.height[i];
    if (c === CELL_DOOR) return z < 1 && this.blocked(x, y);
    return false;
  }

  /** True if the cell blocks line of sight (doors count until nearly open). */
  opaque(x, y) {
    if (x < 0 || y < 0 || x >= this.W || y >= this.H) return true;
    const i = this.idx(x, y);
    if (this.wall[i] === CELL_SOLID) return this.height[i] > 0.7;
    if (this.wall[i] === CELL_DOOR) return this.doorOpen[i] < 0.6;
    return false;
  }

  lineOfSight(ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const steps = Math.ceil(Math.hypot(dx, dy) * 3);
    if (steps <= 0) return true;
    const sx = dx / steps, sy = dy / steps;
    let x = ax, y = ay;
    for (let i = 0; i < steps; i++) {
      x += sx; y += sy;
      if (this.opaque(x, y)) return false;
    }
    return true;
  }

  /**
   * Try to open the door in front of `(x,y)` facing `ang`.
   * @returns {'opened'|'locked'|'secret'|'none'}
   */
  tryUse(x, y, ang, keys, onSecret) {
    const dx = Math.cos(ang), dy = Math.sin(ang);
    for (let d = 0.4; d <= 1.5; d += 0.35) {
      const cx = (x + dx * d) | 0, cy = (y + dy * d) | 0;
      if (!this.inBounds(cx, cy)) break;
      const i = cy * this.W + cx;
      if (this.wall[i] === CELL_DOOR) {
        const k = this.doorKind[i];
        if (k && !keys[k - 1]) return 'locked';
        if (this.doorState[i] === 0 || this.doorState[i] === 3) {
          this.doorState[i] = 1;
        }
        this.doorTimer[i] = DOOR_HOLD;
        return 'opened';
      }
      if (this.wall[i] === CELL_SOLID && this.secret[i]) {
        if (this.startPush(cx, cy, dx, dy)) { onSecret && onSecret(cx, cy); return 'secret'; }
      }
      if (this.wall[i] === CELL_SOLID) return 'none';
    }
    return 'none';
  }

  startPush(cx, cy, dx, dy) {
    for (const p of this.pushwalls) if (p.x === cx && p.y === cy) return false;
    // Push along the dominant axis of the player's facing.
    const sx = Math.abs(dx) > Math.abs(dy) ? Math.sign(dx) : 0;
    const sy = sx === 0 ? Math.sign(dy) : 0;
    const nx = cx + sx, ny = cy + sy;
    if (!this.inBounds(nx, ny) || this.wall[ny * this.W + nx] !== CELL_EMPTY) return false;
    this.pushwalls.push({
      x: cx, y: cy, sx, sy, steps: 0, max: 2, t: 0,
      tex: this.wallTex[cy * this.W + cx],
    });
    this.secret[cy * this.W + cx] = 0;
    return true;
  }

  /**
   * @param {number} dt
   * @param {function} onDoorEvent
   * @param {function(number):boolean} [occupied]  is a body standing in this cell?
   *   `_blockedByBody` was a flag nothing ever wrote, so doors shut on whoever
   *   was standing in them.
   */
  update(dt, onDoorEvent, occupied) {
    const { W } = this;
    for (let i = 0; i < this.wall.length; i++) {
      const st = this.doorState[i];
      if (!st) continue;
      if (st === 1) {
        this.doorOpen[i] += DOOR_SPEED * dt;
        if (this.doorOpen[i] >= 1) { this.doorOpen[i] = 1; this.doorState[i] = 2; }
      } else if (st === 2) {
        this.doorTimer[i] -= dt;
        if (this.doorTimer[i] <= 0 && !(occupied && occupied(i))) this.doorState[i] = 3;
        else if (this.doorTimer[i] <= 0) this.doorTimer[i] = 0.35;   // re-check shortly
      } else if (st === 3) {
        this.doorOpen[i] -= DOOR_SPEED * 0.75 * dt;
        if (this.doorOpen[i] <= 0) {
          this.doorOpen[i] = 0; this.doorState[i] = 0;
          onDoorEvent && onDoorEvent('close', (i % W) + 0.5, ((i / W) | 0) + 0.5);
        }
      }
    }
    for (let n = this.pushwalls.length - 1; n >= 0; n--) {
      const p = this.pushwalls[n];
      p.t += dt;
      if (p.t >= PUSH_STEP_TIME) {
        p.t -= PUSH_STEP_TIME;
        const from = p.y * W + p.x;
        const nx = p.x + p.sx, ny = p.y + p.sy;
        if (!this.inBounds(nx, ny) || this.wall[ny * W + nx] !== CELL_EMPTY) {
          this.pushwalls.splice(n, 1); continue;
        }
        const to = ny * W + nx;
        this.wall[from] = CELL_EMPTY; this.wallTex[from] = 0; this.height[from] = 1;
        this.wall[to] = CELL_SOLID; this.wallTex[to] = p.tex; this.height[to] = 1;
        p.x = nx; p.y = ny; p.steps++;
        onDoorEvent && onDoorEvent('push', p.x + 0.5, p.y + 0.5);
        if (p.steps >= p.max) this.pushwalls.splice(n, 1);
      }
    }
  }

  /** Slide-along-walls movement for any body. Mutates and returns {x,y}. */
  move(pos, vx, vy, radius) {
    let { x, y } = pos;
    const nx = x + vx;
    if (!this._hits(nx, y, radius)) x = nx;
    const ny = y + vy;
    if (!this._hits(x, ny, radius)) y = ny;
    pos.x = x; pos.y = y;
    return pos;
  }

  _hits(x, y, r) {
    return this.blocked(x - r, y - r) || this.blocked(x + r, y - r) ||
           this.blocked(x - r, y + r) || this.blocked(x + r, y + r) ||
           this.blocked(x, y);
  }

  markVisited(x, y, r = 4) {
    const x0 = clamp((x - r) | 0, 0, this.W - 1), x1 = clamp((x + r) | 0, 0, this.W - 1);
    const y0 = clamp((y - r) | 0, 0, this.H - 1), y1 = clamp((y + r) | 0, 0, this.H - 1);
    for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) {
      if (this.lineOfSight(x, y, xx + 0.5, yy + 0.5)) this.visited[yy * this.W + xx] = 1;
    }
  }

  /** Is the player standing somewhere the sky is visible? Drives music + fog. */
  underSky(x, y) {
    const r = 2;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const xx = (x | 0) + dx, yy = (y | 0) + dy;
      if (this.inBounds(xx, yy) && this.sky[yy * this.W + xx]) return true;
    }
    return false;
  }
}
