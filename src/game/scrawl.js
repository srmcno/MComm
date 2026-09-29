// scrawl.js - writing on the walls, in blood, and the thin man who does it.
//
// Two things live here. The first is a layer of writing on wall faces: a
// message is set in a 5x7 hand font, roughened so it looks done with a
// finger, dressed with drips, and laid over the wall texture as an overlay the
// raycaster blends in per pixel. It can write itself, left to right, over a few
// seconds, or arrive all at once (a curse where blood has hit a wall).
//
// The second is the Scribe, who does the writing when somebody is looking: a
// tall stick figure in a bunker with no reason to have one. He comes and goes,
// goes invisible while he works, giggles, and never lays a finger on the
// player. He is here for the walls.
//
// Everything is deterministic given the game's rng, so the playtest can pin it.

import { CELL_EMPTY, CELL_SOLID } from './level.js';
import { CEIL_H } from '../core/world.js';
import { TEX, rgba, clamp } from '../core/pixels.js';
import { makeRng } from '../core/math.js';

// ---------------------------------------------------------------------------
// faces
// ---------------------------------------------------------------------------

/** The way a viewer looks at wall face f: 0 east-bound, 1 west, 2 south, 3 north (y grows down). */
export const FACE_D = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** Which way is right for a viewer looking at face f (the raycaster's u runs this way). */
export function faceRight(f) { const d = FACE_D[f]; return [-d[1], d[0]]; }

/** The face a splash of blood on a wall with outward normal (nx, ny) lands on. */
export function faceOfNormal(nx, ny) {
  const dx = -nx, dy = -ny;
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? 0 : 1;
  return dy > 0 ? 2 : 3;
}

// ---------------------------------------------------------------------------
// the hand
// ---------------------------------------------------------------------------

const GLYPHS = {
  ' ': '00000/00000/00000/00000/00000/00000/00000',
  A: '01110/10001/10001/11111/10001/10001/10001',
  B: '11110/10001/10001/11110/10001/10001/11110',
  C: '01110/10001/10000/10000/10000/10001/01110',
  D: '11110/10001/10001/10001/10001/10001/11110',
  E: '11111/10000/10000/11110/10000/10000/11111',
  F: '11111/10000/10000/11110/10000/10000/10000',
  G: '01110/10001/10000/10111/10001/10001/01111',
  H: '10001/10001/10001/11111/10001/10001/10001',
  I: '01110/00100/00100/00100/00100/00100/01110',
  J: '00111/00010/00010/00010/00010/10010/01100',
  K: '10001/10010/10100/11000/10100/10010/10001',
  L: '10000/10000/10000/10000/10000/10000/11111',
  M: '10001/11011/10101/10101/10001/10001/10001',
  N: '10001/11001/10101/10011/10001/10001/10001',
  O: '01110/10001/10001/10001/10001/10001/01110',
  P: '11110/10001/10001/11110/10000/10000/10000',
  Q: '01110/10001/10001/10001/10101/10010/01101',
  R: '11110/10001/10001/11110/10100/10010/10001',
  S: '01111/10000/10000/01110/00001/00001/11110',
  T: '11111/00100/00100/00100/00100/00100/00100',
  U: '10001/10001/10001/10001/10001/10001/01110',
  V: '10001/10001/10001/10001/10001/01010/00100',
  W: '10001/10001/10001/10101/10101/11011/10001',
  X: '10001/10001/01010/00100/01010/10001/10001',
  Y: '10001/10001/01010/00100/00100/00100/00100',
  Z: '11111/00001/00010/00100/01000/10000/11111',
  0: '01110/10001/10011/10101/11001/10001/01110',
  1: '00100/01100/00100/00100/00100/00100/01110',
  2: '01110/10001/00001/00010/00100/01000/11111',
  3: '11110/00001/00001/01110/00001/00001/11110',
  4: '00010/00110/01010/10010/11111/00010/00010',
  5: '11111/10000/11110/00001/00001/10001/01110',
  6: '00110/01000/10000/11110/10001/10001/01110',
  7: '11111/00001/00010/00100/01000/01000/01000',
  8: '01110/10001/10001/01110/10001/10001/01110',
  9: '01110/10001/10001/01111/00001/00010/01100',
  '!': '00100/00100/00100/00100/00100/00000/00100',
  '?': '01110/10001/00001/00010/00100/00000/00100',
  '.': '00000/00000/00000/00000/00000/01100/01100',
  ',': '00000/00000/00000/00000/00110/00100/01000',
  "'": '00100/00100/01000/00000/00000/00000/00000',
  '-': '00000/00000/00000/11111/00000/00000/00000',
  ':': '00000/01100/01100/00000/01100/01100/00000',
  '(': '00010/00100/01000/01000/01000/00100/00010',
  ')': '01000/00100/00010/00010/00010/00100/01000',
  '&': '01100/10010/10100/01000/10101/10010/01101',
};
const FONT = {};
for (const k of Object.keys(GLYPHS)) FONT[k] = GLYPHS[k].split('/').map((r) => parseInt(r, 2));

/** Can every character of this line be written? */
export function canWrite(text) {
  for (const ch of text.toUpperCase()) if (!FONT[ch]) return false;
  return true;
}

const SS = 3;   // supersampling: each output pixel is a 3x3 of finger

/**
 * Set lines of text in the hand font at a glyph box of `size` pixels, roughened
 * by a seeded rng. Returns coverage 0..1 per pixel, plus where each line sits.
 */
export function rasterText(lines, size, seed) {
  const rng = makeRng(seed);
  const adv = Math.round(size * 1.15), pitch = Math.round(size * 1.5);
  let maxN = 0;
  for (const l of lines) maxN = Math.max(maxN, l.length);
  const w = maxN * adv + 4, h = lines.length * pitch + 2;
  const hw = w * SS, hh = h * SS;
  const hi = new Uint8Array(hw * hh);
  const fill = (x0, y0, x1, y1) => {
    x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
    x1 = Math.min(hw, Math.ceil(x1)); y1 = Math.min(hh, Math.ceil(y1));
    for (let y = y0; y < y1; y++) hi.fill(1, y * hw + x0, y * hw + Math.max(x0, x1));
  };
  const boxes = [];
  let nch = 0;
  lines.forEach((line, li) => {
    const lw = line.length * adv, xOff = (w - lw) / 2;
    boxes.push({ x0: Math.floor(xOff), x1: Math.ceil(xOff + lw), y0: li * pitch, y1: li * pitch + pitch, n: line.length });
    nch += line.length;
    for (let j = 0; j < line.length; j++) {
      const g = FONT[line[j].toUpperCase()];
      if (!g || line[j] === ' ') continue;
      const gx = (xOff + j * adv) * SS, gy = (li * pitch + 1) * SS;
      const sx = (size * SS) / 5, sy = (size * SS) / 7;
      const wob = (rng() - 0.5) * 0.14 * size * SS, slant = (rng() - 0.5) * 0.5, big = 0.92 + rng() * 0.2;
      for (let r = 0; r < 7; r++) {
        for (let c = 0; c < 5; c++) {
          if (!(g[r] & (16 >> c))) continue;
          if (rng() < 0.025) continue;                 // the finger skips
          const jx = (rng() - 0.5) * 0.5, jy = (rng() - 0.5) * 0.5;
          const x0 = gx + (c + jx) * sx * big + slant * (3 - r) * sy;
          const y0 = gy + (r + jy) * sy * big + wob;
          fill(x0, y0, x0 + sx * 1.22, y0 + sy * 1.22);
        }
      }
    }
  });
  const cov = new Float32Array(w * h);
  const inv = 1 / (SS * SS);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let j = 0; j < SS; j++) {
        const row = (y * SS + j) * hw + x * SS;
        for (let i = 0; i < SS; i++) s += hi[row + i];
      }
      cov[y * w + x] = clamp((s * inv - 0.18) * 1.9, 0, 1);
    }
  }
  return { w, h, cov, boxes, nch, adv, pitch };
}

function hash2(x, y, s) {
  let h = (Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 2147483647)) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** One pixel of blood: dark in the body, a shade lighter where it is thin. */
function bloodPixel(cov, x, y, seed, dry) {
  const n = hash2(x, y, seed);
  const thin = 1 - cov;
  const k = 0.35 + 0.4 * n + 0.3 * thin;
  const r = (54 + 74 * k) * dry, g = (2 + 8 * k) * dry, b = (4 + 9 * k) * dry;
  return rgba(r | 0, g | 0, b | 0, Math.round(clamp(cov * 1.05, 0, 1) * 240));
}

// ---------------------------------------------------------------------------
// what he writes
// ---------------------------------------------------------------------------

/**
 * Messages, each a list of lines (two at most). Uppercase, plain ASCII, drawn
 * from the hand font. The Scribe is cheerful, patient, and a little bit in love
 * with the warden.
 */
export const MESSAGES = [
  ['HELLO WARDEN', 'I LIKE YOUR SKIN'],
  ['KEVIN WAS HERE', 'KEVIN IS NOW IN THE VENTS'],
  ['DEAR DIARY', 'TODAY I ATE A SUPERVISOR'],
  ['THE CAKE IS A LIE', 'SO IS YOUR TATTOO'],
  ['SMILE', 'THEY ARE WATCHING'],
  ['YOUR DOG IS FINE', '(IT IS NOT FINE)'],
  ['I CAN SEE YOUR HOUSE', 'FROM HERE'],
  ['ROXANNE SENDS HER LOVE', 'AND THE LAWYER'],
  ['WISH YOU WERE HERE', 'I AM IN THE WALL'],
  ['THE ONLY WAY OUT', 'IS THROUGH ME'],
  ['DO NOT LOOK BEHIND YOU', 'I DID'],
  ['I FOUND A DOOR', 'IT WAS A MOUTH'],
  ['WORK HARD PLAY HARD', 'DIE HARD'],
  ['HE LOVES YOU', 'HE LOVES YOU NOT', 'HE LOVES YOUR LIVER'],
  ['PEEKABOO'],
  ['NICE MULLET', 'I WANT IT'],
  ['HI BRICK', 'BYE BRICK'],
  ["DON'T LOOK UP"],
];

// Curses, for when blood hits a wall the wrong way. Weights are how often.
export const WORDS = [['FUCK', 4], ['SHIT', 4], ['ASS', 1], ['DICK', 2], ['PISS', 1], ['HELL', 1], ['COCK', 1], ['TITS', 1], ['DAMN', 1], ['CUNT', 1]];
export const PHRASES = ['FUCK YOU', 'OH SHIT', 'SUCK IT', 'EAT SHIT', 'FUCK ME', 'PISS OFF'];

function pickWeighted(list, r) {
  let tot = 0;
  for (const it of list) tot += it[1];
  let x = r * tot;
  for (const it of list) { x -= it[1]; if (x < 0) return it[0]; }
  return list[list.length - 1][0];
}

// ---------------------------------------------------------------------------
// the layer
// ---------------------------------------------------------------------------

export class Scrawl {
  constructor(game) {
    this.game = game;
    this.jobs = [];
    this.curseAt = -999;
    this.curses = 0;
    this.written = 0;
    this._seed = 1;
  }

  reset() { this.jobs.length = 0; this.curseAt = -999; this.curses = 0; this.written = 0; }

  get level() { return this.game.level; }

  _okWall(x, y) {
    const lv = this.level;
    if (x < 1 || y < 1 || x >= lv.W - 1 || y >= lv.H - 1) return false;
    const i = y * lv.W + x;
    if (lv.wall[i] !== CELL_SOLID || lv.propBlock[i] || lv.parapet[i] || lv.secret[i]) return false;
    if (lv.height[i] < CEIL_H - 0.001) return false;
    const em = this.game.art.texEmissive;
    return !(em && em[lv.wallTex[i]] > 0.05);
  }

  _okFront(x, y) {
    const lv = this.level;
    if (x < 0 || y < 0 || x >= lv.W || y >= lv.H) return false;
    const i = y * lv.W + x;
    return lv.wall[i] === CELL_EMPTY && !lv.propBlock[i] && !lv.sky[i] && lv.ceilTex[i] >= 0;
  }

  /**
   * Every place a straight run of `n` bare wall cells faces into an open room,
   * as { x, y, f, n, fx, fy }: (x, y) the leftmost wall cell as the viewer sees
   * it, f the face, (fx, fy) the floor cell in front of it.
   */
  runs(n) {
    const lv = this.level, out = [];
    for (let y = 1; y < lv.H - 1; y++) {
      for (let x = 1; x < lv.W - 1; x++) {
        if (!this._okWall(x, y)) continue;
        for (let f = 0; f < 4; f++) {
          const d = FACE_D[f], r = faceRight(f);
          const fx = x - d[0], fy = y - d[1];
          let ok = true;
          for (let k = 0; k < n && ok; k++) {
            ok = this._okWall(x + r[0] * k, y + r[1] * k) && this._okFront(fx + r[0] * k, fy + r[1] * k)
              && !lv.scrawl.has(((y + r[1] * k) * lv.W + x + r[0] * k) * 4 + f);
          }
          if (ok) out.push({ x, y, f, n, fx, fy });
        }
      }
    }
    return out;
  }

  /**
   * Lay `lines` on a run of cells. `size` is the glyph box in pixels, `row` the
   * pixel row the block is centred on (the wall is 64 tall, floor at the
   * bottom), `dur` seconds to write it (0 is instant), `seed` picks the hand.
   * Returns the job, or null if it does not fit.
   */
  write(run, lines, o = {}) {
    const lv = this.level;
    const size = o.size || 8;
    const R = rasterText(lines, size, o.seed || (this._seed += 7919));
    const ws = run.n * TEX;
    if (R.w > ws - 2) return null;
    const ox = Math.round((ws - R.w) / 2);
    const row = o.row === undefined ? 29 : o.row;
    const oy = clamp(Math.round(row - R.h / 2), 2, TEX - R.h - 6);
    const seed = (o.seed || this._seed) | 0;
    const base = new Uint32Array(ws * TEX), cur = new Uint32Array(ws * TEX);
    for (let y = 0; y < R.h; y++) {
      for (let x = 0; x < R.w; x++) {
        const c = R.cov[y * R.w + x];
        if (c > 0.02) base[(oy + y) * ws + ox + x] = bloodPixel(c, x, y, seed, 1);
      }
    }
    const dur = o.dur === undefined ? 0 : o.dur;
    const job = {
      run, lines, ws, base, cur, dur, t: 0, ox, oy, R, seed, boxes: R.boxes.map((b) => ({ ...b, x0: b.x0 + ox, x1: b.x1 + ox, y0: b.y0 + oy, y1: b.y1 + oy, rx: b.x0 + ox - 4 })),
      drips: [], dried: false, done: false, statics: false,
    };
    // Drips start under the bottom edges of strokes, and run in their own time.
    const rng = makeRng(seed ^ 0x9e3779b9);
    const per = Math.max(3, Math.round(R.nch * 0.5));
    for (let tries = 0; tries < 600 && job.drips.length < per; tries++) {
      const x = ox + ((rng() * R.w) | 0), y = oy + ((rng() * R.h) | 0);
      if ((base[y * ws + x] >>> 24) < 200 || (base[(y + 1) * ws + x] >>> 24) > 40) continue;
      if (job.drips.some((d) => Math.abs(d.x - x) < 3)) continue;
      const bi = job.boxes.findIndex((b) => y >= b.y0 && y < b.y1);
      const b = job.boxes[Math.max(0, bi)];
      const frac = b.x1 > b.x0 ? (x - b.x0) / (b.x1 - b.x0) : 0;
      // when its letter was written: the lines are written one after another
      let before = 0; for (let i = 0; i < bi; i++) before += job.boxes[i].n;
      const at = dur > 0 ? ((before + frac * b.n) / R.nch) * dur : 0;
      job.drips.push({ x, y: y + 1, L: 3 + rng() * size * 1.8, tau: 1.4 + rng() * 2.6, t0: at + 0.25 + rng() * 0.5, drawn: 0, w: rng() < 0.25 ? 2 : 1 });
    }
    // register the faces
    const r = faceRight(run.f);
    for (let k = 0; k < run.n; k++) {
      const idx = (run.y + r[1] * k) * lv.W + run.x + r[0] * k;
      lv.scrawl.set(idx * 4 + run.f, { strip: cur, ws, off: k * TEX });
    }
    this.jobs.push(job);
    this.written++;
    if (dur <= 0) this._step(job, 0.001);
    return job;
  }

  /** How long it takes the Scribe to write these lines. */
  static writeTime(lines) {
    let n = 0;
    for (const l of lines) n += l.length;
    return 0.5 + n * 0.11;
  }

  /** The width in cells that a message needs, and the glyph size to use. */
  static cellsFor(lines, size = 8) {
    let m = 0;
    for (const l of lines) m = Math.max(m, l.length);
    return Math.max(1, Math.ceil((m * Math.round(size * 1.15) + 8) / TEX));
  }

  /** Finish a job now: the rest of the text, at once. */
  finish(job) { job.t = Math.max(job.t, job.dur); this._step(job, 0.001); }

  update(dt) {
    for (let i = this.jobs.length - 1; i >= 0; i--) {
      const job = this.jobs[i];
      this._step(job, dt);
      if (job.statics) this.jobs.splice(i, 1);
    }
  }

  _step(job, dt) {
    job.t += dt;
    const { cur, base, ws } = job;
    const p = job.dur > 0 ? clamp(job.t / job.dur, 0, 1) : 1;
    // reveal, line by line, left to right
    const nch = job.R.nch;
    let before = 0;
    for (const b of job.boxes) {
      const f = clamp((p * nch - before) / b.n, 0, 1);
      before += b.n;
      // the reveal runs a few pixels past each end: slanted letters lean out of their box
      const nx = Math.min(job.ws, Math.round(b.x0 - 4 + f * (b.x1 - b.x0 + 8)));
      if (nx > b.rx) {
        const y1 = Math.min(TEX, b.y1 + 2);
        for (let y = Math.max(0, b.y0 - 1); y < y1; y++) {
          const o = y * ws;
          for (let x = b.rx; x < nx; x++) cur[o + x] = base[o + x];
        }
        b.rx = nx;
      }
    }
    job.done = p >= 1;
    // drips run once their letter is down
    let live = false;
    for (const d of job.drips) {
      if (job.t < d.t0) { live = true; continue; }
      const len = Math.min(d.L, d.L * (1 - Math.exp(-(job.t - d.t0) / d.tau)));
      const want = Math.floor(len);
      for (let k = d.drawn; k < want; k++) {
        const y = d.y + k;
        if (y >= TEX - 2) break;
        const a = 236 - (k > want - 2 ? 40 : 0);
        for (let w = 0; w < d.w; w++) cur[y * ws + d.x + w] = rgba(88 + ((hash2(d.x, y, job.seed) * 30) | 0), 3, 6, a);
      }
      if (want > d.drawn) d.drawn = want;
      if (len < d.L - 0.4) live = true;
    }
    // a minute later it has dried a shade darker, and stops costing anything
    if (job.done && !live && !job.dried && job.t > job.dur + 20) {
      for (let i = 0; i < cur.length; i++) {
        const c = cur[i];
        if (!(c >>> 24)) continue;
        cur[i] = rgba(((c & 255) * 0.74) | 0, ((c >>> 8) & 255), ((c >>> 16) & 255), c >>> 24);
      }
      job.dried = true;
      job.statics = true;
    }
  }

  /**
   * Blood has just hit a wall at (x, y, z), the face's outward normal (nx, ny).
   * Now and then the splash is a word. Rare on purpose: a cooldown, a cap per
   * floor, and a small chance on top of that.
   */
  maybeCurse(x, y, z, nx, ny, heavy) {
    const g = this.game;
    if (this.curses >= 5 || g.time - this.curseAt < 35) return false;
    if (g.rng() >= (heavy ? 0.035 : 0.01)) return false;
    return this.curse(x, y, z, nx, ny);
  }

  /** Write a curse on the face at (x, y) now. Returns the job or null. */
  curse(x, y, z, nx, ny, word) {
    const g = this.game, lv = this.level;
    const cx = Math.floor(x - nx * 0.08), cy = Math.floor(y - ny * 0.08);
    if (!this._okWall(cx, cy)) return null;
    const f = faceOfNormal(nx, ny), r = faceRight(f);
    const key = (cy * lv.W + cx) * 4 + f;
    if (lv.scrawl.has(key)) return null;
    const d = FACE_D[f];
    if (!this._okFront(cx - d[0], cy - d[1])) return null;
    let text = word, n = 1;
    if (!text) {
      const two = this._okWall(cx + r[0], cy + r[1]) && this._okFront(cx - d[0] + r[0], cy - d[1] + r[1])
        && !lv.scrawl.has(((cy + r[1]) * lv.W + cx + r[0]) * 4 + f) && g.rng() < 0.3;
      if (two) { text = PHRASES[(g.rng() * PHRASES.length) | 0]; n = 2; }
      else text = pickWeighted(WORDS, g.rng());
    } else n = text.length * Math.round(12 * 1.15) + 8 > TEX ? 2 : 1;
    const wallH = lv.height[cy * lv.W + cx] || CEIL_H;
    const row = clamp((1 - z / wallH) * TEX, 12, 44);
    const job = this.write({ x: cx, y: cy, f, n, fx: cx - d[0], fy: cy - d[1] }, [text], { size: 12, row, dur: 0, seed: (g.rng() * 1e9) | 0 });
    if (job) { this.curses++; this.curseAt = g.time; }
    return job;
  }
}

// ---------------------------------------------------------------------------
// the Scribe
// ---------------------------------------------------------------------------

/** Where he is in his visit. */
const ST = { WAIT: 0, APPEAR: 1, WRITE: 2, LURK: 3, FADE: 4 };

export class Scribe {
  constructor(game) {
    this.game = game;
    this.reset();
  }

  reset() {
    const g = this.game;
    this.state = ST.WAIT;
    this.t = 0;
    this.next = 22 + (g.rng ? g.rng() : 0.5) * 26;     // the first visit
    this.visits = 0;
    this.x = 0; this.y = 0;
    this.alpha = 0;
    this.ghost = false;
    this.job = null;
    this.msg = null;
    this.run = null;
    this.blink = 0;
    this.scratchT = 0;
    this.snicker = false;
  }

  get active() { return this.state !== ST.WAIT; }

  /** The sprite record for this frame, or null. */
  sprite(art) {
    if (this.state === ST.WAIT || this.alpha <= 0.01) return null;
    const S = this.state;
    let key = 'scribe_stand';
    if (S === ST.WRITE) key = 'scribe_write' + (Math.floor(this.t * 7) & 1);
    else if (S === ST.LURK) key = this.t > 0.6 ? 'scribe_wave' + (Math.floor(this.t * 5) & 1) : 'scribe_peek';
    const frame = art.sprites[key] || art.sprites.scribe_stand;
    if (!frame) return null;
    const rec = this._rec || (this._rec = {});
    rec.x = this.x; rec.y = this.y; rec.z = 0; rec.h = 1.12; rec.wScale = 1;
    rec.frame = frame; rec.alpha = this.alpha; rec.emissive = true; rec.noFog = false;
    rec.tint = 0; rec.additive = false;
    return rec;
  }

  _pos(k) {
    const run = this.run, d = FACE_D[run.f], r = faceRight(run.f);
    const cx = run.fx + 0.5 + r[0] * k + d[0] * 0.3, cy = run.fy + 0.5 + r[1] * k + d[1] * 0.3;
    return [cx, cy];
  }

  update(dt) {
    const g = this.game, p = g.player;
    if (!p || p.dead) return;
    this.t += dt;
    switch (this.state) {
      case ST.WAIT: {
        if (g.levelIndex >= g.totalLevels - 1) break;       // not in MUTTER's own house
        this.next -= dt;
        if (this.next <= 0 && this.visits < 4) this._begin();
        else if (this.next <= 0) this.next = 60;
        break;
      }
      case ST.APPEAR: {
        this.alpha = this.ghost ? 0 : Math.min(1, this.t / 0.6) * (0.75 + 0.25 * Math.sin(this.t * 40));
        if (this.t > 0.6) { this.state = ST.WRITE; this.t = 0; this.snicker = false; }
        break;
      }
      case ST.WRITE: {
        const job = this.job, run = this.run;
        const k = job.dur > 0 ? clamp(this.t / job.dur, 0, 1) * (run.n - 1) : 0;
        [this.x, this.y] = this._pos(k);
        // he blinks in and out while he works; a ghost only shows in a flicker
        this.blink -= dt;
        if (this.blink <= 0) { this.blink = 0.15 + g.rng() * 0.5; this._vis = g.rng() < (this.ghost ? 0.06 : 0.7); }
        this.alpha = this._vis ? 1 : 0;
        this.scratchT -= dt;
        if (this.scratchT <= 0) { this.scratchT = 0.42; this._sound('scribe_scratch', 0.5); }
        if (this._close(2.0)) { g.scrawl.finish(job); this._giggle(); this.state = ST.FADE; this.t = 0; break; }
        if (this.t >= job.dur) { this.state = ST.LURK; this.t = 0; this.alpha = this.ghost ? 0 : 1; if (!this.ghost) this._react(); }
        break;
      }
      case ST.LURK: {
        // done; he turns round, and if you can see him he waves
        this.alpha = this.ghost ? 0 : 1;
        if (!this.snicker && this.t > 0.5) { this.snicker = true; this._giggle(); }
        if (this.t > 3.2 || this._close(2.0)) { this.state = ST.FADE; this.t = 0; }
        break;
      }
      case ST.FADE: {
        this.alpha = Math.max(0, this.alpha - dt * 1.8) * (Math.sin(this.t * 55) > -0.4 ? 1 : 0.2);
        if (this.t > 0.7) { this.alpha = 0; this.state = ST.WAIT; this.t = 0; this.next = 55 + g.rng() * 60; this.job = null; }
        break;
      }
      default: break;
    }
  }

  /**
   * A shot went past. If it went past him he giggles and is gone; the bullet
   * does nothing, because there is nothing there to hit. `a` is the aim vector.
   */
  onShot(a) {
    if (this.state === ST.WAIT || this.state === ST.FADE || this.alpha < 0.3) return false;
    const p = this.game.player, dx = this.x - p.x, dy = this.y - p.y;
    const flat = Math.hypot(a.x, a.y) || 1, d = Math.hypot(dx, dy);
    if ((dx * a.x + dy * a.y) / flat <= 0) return false;
    if (Math.abs(dx * a.y - dy * a.x) / flat > 0.3) return false;
    const zAt = p.z + (a.z / flat) * d;
    if (zAt < -0.05 || zAt > 1.15) return false;
    if (this.job && this.game.scrawl) this.game.scrawl.finish(this.job);
    this._giggle();
    this.game.chat('brick', 'brick_scribe_shot', { chance: 0.7, cooldown: 30, delay: 0.8 });
    this.state = ST.FADE; this.t = 0;
    return true;
  }

  _close(d) {
    const p = this.game.player;
    return Math.hypot(p.x - this.x, p.y - this.y) < d;
  }

  _sound(name, vol) {
    const g = this.game, p = g.player;
    const d = Math.hypot(p.x - this.x, p.y - this.y);
    g.sound.sfx(name, { pan: g.panAt(this.x, this.y), vol: vol * clamp(1.15 - d / 16, 0.15, 1) });
  }

  _giggle() { this._sound('scribe_giggle', 0.9); }

  /** MUTTER, Brick and the doctor have all noticed. Not often. */
  _react() {
    const g = this.game;
    g.chat('mutter', 'mutter_scribe', { chance: 0.4, cooldown: 60, delay: 1.6 });
    g.chat('brick', 'brick_scribe', { chance: 0.4, cooldown: 60, delay: 2.6 });
    g.chat('ilsa', 'ilsa_scribe', { chance: 0.2, cooldown: 90, delay: 4.6 });
  }

  /**
   * Wall runs of `n` cells near the player. Strictly, ones in front of them and in
   * plain sight, facing them; loosely, any within earshot, which is how a message
   * turns up on a wall that nobody watched being written.
   */
  _seen(n, loose) {
    const g = this.game, p = g.player, sc = g.scrawl;
    const ca = Math.cos(p.ang), sa = Math.sin(p.ang), out = [];
    for (const r of sc.runs(n)) {
      const cx = r.fx + 0.5, cy = r.fy + 0.5, dx = cx - p.x, dy = cy - p.y, d = Math.hypot(dx, dy);
      if (loose) { if (d > 4 && d < 13 && d > 0) out.push(r); continue; }
      if (d < 2.6 || d > 11) continue;
      if ((dx * ca + dy * sa) / d < 0.2) continue;                  // in front of you
      if (!g.level.lineOfSight(p.x, p.y, cx, cy)) continue;
      const fd = FACE_D[r.f];
      if ((fd[0] * dx + fd[1] * dy) / d < 0.3) continue;            // and the writing faces you, not edge-on
      out.push(r);
    }
    return out;
  }

  /** Pick a wall he can be seen at, and something to write on it. */
  _begin() {
    const g = this.game, sc = g.scrawl;
    if (g.state !== 'play') { this.next = 5; return; }
    // what fits: the longest walls first, then shorter until something is on offer
    const by = {};
    for (let n = 2; n <= 6; n++) { const r = this._seen(n, false); if (r.length) by[n] = r; }
    if (!Object.keys(by).length) for (let n = 2; n <= 6; n++) { const r = this._seen(n, true); if (r.length) by[n] = r; }
    const fits = MESSAGES.filter((m) => by[Scrawl.cellsFor(m, 8)]);
    if (!fits.length) { this.next = 6; return; }
    const msg = fits[(g.rng() * fits.length) | 0];
    const list = by[Scrawl.cellsFor(msg, 8)];
    const run = list[(g.rng() * list.length) | 0];
    const job = sc.write(run, msg, { size: 8, dur: Scrawl.writeTime(msg), row: 30, seed: (g.rng() * 1e9) | 0 });
    if (!job) { this.next = 6; return; }
    this.run = run; this.job = job; this.msg = msg;
    this.ghost = g.rng() < 0.4;
    this.visits++;
    this.state = ST.APPEAR; this.t = 0; this.alpha = 0; this.blink = 0; this._vis = true;
    [this.x, this.y] = this._pos(0);
    this._giggle();
  }
}
