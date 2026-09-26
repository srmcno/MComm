// title.js - the front door. Renders the live sky dome as a slowly turning
// backdrop, silhouettes a bunker parapet against it, and puts the logo on top.

import { rgba, mix, clamp as pclamp } from '../core/pixels.js';
import { clamp, lerp, makeRng, TAU } from '../core/math.js';
import { fillRectBuf, addRectBuf, lineBuf, blitFrame } from './text.js';
import { getScores } from '../core/scores.js';
import { PAD_GLYPHS } from '../core/input.js';
import { VOICE_MODES, saveVoiceMode } from '../audio/speech.js';

const AMBER = rgba(255, 186, 64, 255);
const HOT = rgba(255, 236, 190, 255);
const RUST = rgba(196, 84, 32, 255);
const CYAN = rgba(110, 236, 244, 255);
const BONE = rgba(216, 206, 184, 255);
const DIM = rgba(126, 112, 96, 255);
const INK = rgba(8, 6, 12, 255);

export const MENU = [
  { id: 'start', label: 'BEGIN THE SHIFT' },
  { id: 'howto', label: 'HOW TO SHOOT THE SKY' },
  { id: 'options', label: 'CALIBRATION' },
  { id: 'credits', label: 'PERSONNEL FILE' },
];

const DIFFS = [
  { id: 0, name: 'CLERICAL', blurb: 'Warheads dawdle. MUTTER is almost kind.' },
  { id: 1, name: 'WARDEN', blurb: 'As designed. Six cities, one of you.' },
  { id: 2, name: 'LAST SHIFT', blurb: 'Faster, meaner, and it remembers your name.' },
];

export class TitleScreen {
  constructor() {
    this.t = 0;
    this.sel = 0;
    this.page = 'menu';     // menu | howto | options | credits | difficulty
    this.diff = 1;
    this.optSel = 0;
    this.streaks = [];
    this.rng = makeRng(0xD00D);
    this.flicker = 1;
    this.enterT = 0;
    this.az = 4.7;
    this.beams = [
      { az: 0.9, sweep: 0.4, speed: 0.19, phase: 0 },
      { az: 3.6, sweep: 0.55, speed: -0.13, phase: 2.1 },
      { az: 5.5, sweep: 0.32, speed: 0.24, phase: 4.4 },
    ];
  }

  reset() { this.page = 'menu'; this.sel = 0; this.enterT = 0; }

  update(dt, input, game) {
    this.t += dt;
    this.enterT = Math.min(1, this.enterT + dt * 0.55);
    this.az += dt * 0.018;
    this.flicker = 0.93 + 0.07 * Math.sin(this.t * 31) * Math.sin(this.t * 7.3);

    // Warheads keep falling on the horizon behind the logo. It never stops.
    if (this.rng() < dt * 1.7) {
      this.streaks.push({
        az: this.rng() * TAU, e0: 0.55 + this.rng() * 0.5, e1: 0.02 + this.rng() * 0.05,
        t: 0, life: 2.2 + this.rng() * 2.4, hue: this.rng(),
      });
    }
    for (let i = this.streaks.length - 1; i >= 0; i--) {
      const s = this.streaks[i];
      s.t += dt;
      if (s.t >= s.life) {
        this.streaks.splice(i, 1);
        this.flashT = 0.5;
      }
    }
    this.flashT = Math.max(0, (this.flashT || 0) - dt);

    let action = null;
    // Menu context: the pad's d-pad and face buttons wear their menu hats here,
    // which they deliberately do not during play.
    const M = (a) => (input.menuJustPressed ? input.menuJustPressed(a) : input.justPressed(a));
    const up = M('up') || input.rawJustPressed('KeyW');
    const down = M('down') || input.rawJustPressed('KeyS');
    const ok = M('confirm') || input.justPressed('use') || input.justPressed('fire');
    const back = M('escape');

    if (this.page === 'menu') {
      if (up) { this.sel = (this.sel + MENU.length - 1) % MENU.length; action = 'move'; }
      if (down) { this.sel = (this.sel + 1) % MENU.length; action = 'move'; }
      if (ok) {
        const id = MENU[this.sel].id;
        if (id === 'start') { this.page = 'difficulty'; this.sel = this.diff; action = 'select'; }
        else { this.page = id; action = 'select'; }
      }
    } else if (this.page === 'difficulty') {
      if (up) { this.sel = (this.sel + DIFFS.length - 1) % DIFFS.length; action = 'move'; }
      if (down) { this.sel = (this.sel + 1) % DIFFS.length; action = 'move'; }
      if (ok) { this.diff = this.sel; return { action: 'start', difficulty: this.diff }; }
      if (back) { this.page = 'menu'; this.sel = 0; action = 'back'; }
    } else {
      if (this.page === 'options') {
        const opts = this.optionList(game);
        if (up) { this.optSel = (this.optSel + opts.length - 1) % opts.length; action = 'move'; }
        if (down) { this.optSel = (this.optSel + 1) % opts.length; action = 'move'; }
        const l = M('left') || input.rawJustPressed('KeyA');
        const r = M('right') || input.rawJustPressed('KeyD');
        if (l) { opts[this.optSel].adj(-1); action = 'move'; }
        if (r || ok) { opts[this.optSel].adj(1); action = 'move'; }
      }
      if (back || (this.page !== 'options' && ok)) { this.page = 'menu'; action = 'back'; }
    }
    return action ? { action } : null;
  }

  optionList(game) {
    const s = game.post.settings;
    const step = (v, d, lo, hi) => clamp(v + d * 0.1, lo, hi);
    return [
      { label: 'MASTER VOLUME', value: () => pct(game.volMaster), adj: (d) => { game.volMaster = step(game.volMaster, d, 0, 1); game.sound.setMaster(game.volMaster); } },
      { label: 'MUSIC', value: () => pct(game.volMusic), adj: (d) => { game.volMusic = step(game.volMusic, d, 0, 1); game.sound.setMusicVol(game.volMusic); } },
      { label: 'VOICE VOLUME', value: () => pct(game.volVox), adj: (d) => { game.volVox = step(game.volVox, d, 0, 1); game.vox.setVolume(game.volVox); } },
      { label: 'VOICE', value: () => voiceLabel(game), adj: (d) => cycleVoice(game, d) },
      { label: 'SUBTITLES', value: () => (game.subtitlesOn ? 'ON' : 'OFF'), adj: () => { game.subtitlesOn = !game.subtitlesOn; } },
      { label: 'CRT SCANLINES', value: () => pct(s.scan / 0.6), adj: (d) => { s.scan = clamp(s.scan + d * 0.06, 0, 0.6); } },
      { label: 'BLOOM', value: () => pct(s.bloom / 1.6), adj: (d) => { s.bloom = clamp(s.bloom + d * 0.16, 0, 1.6); } },
      { label: 'LENS WARP', value: () => pct(s.barrel / 0.12), adj: (d) => { s.barrel = clamp(s.barrel + d * 0.012, 0, 0.12); } },
      { label: 'FILM GRAIN', value: () => pct(s.grain / 0.09), adj: (d) => { s.grain = clamp(s.grain + d * 0.009, 0, 0.09); } },
      { label: 'RESOLUTION', value: () => `${game.resScale.toFixed(2)}x`, adj: (d) => { game.resScale = clamp(game.resScale + d * 0.1, 0.5, 1.6); game.resLocked = true; } },
      { label: 'MOUSE SENSITIVITY', value: () => `${game.sens.toFixed(2)}`, adj: (d) => { game.sens = clamp(game.sens + d * 0.1, 0.2, 3); } },
    ];
  }

  // ------------------------------------------------------------------ draw

  draw(buf, W, H, game) {
    const s = H / 450;
    const T = game.text;
    T.frameTick(this.t);
    this.drawSkyBackdrop(buf, W, H, game);
    this.drawStreaks(buf, W, H, s, game);
    this.drawParapet(buf, W, H, s);
    this.drawLogo(buf, W, H, s, game);

    switch (this.page) {
      case 'menu': this.drawHero(buf, W, H, s, game); this.drawMenu(buf, W, H, s, game); break;
      case 'difficulty': this.drawDifficulty(buf, W, H, s, game); break;
      case 'howto': this.drawHowTo(buf, W, H, s, game); break;
      case 'options': this.drawOptions(buf, W, H, s, game); break;
      case 'credits': this.drawCredits(buf, W, H, s, game); break;
      default: break;
    }

    // Vignette-ish darkening at the very bottom for the footer text.
    const pad = game.input && game.input.padSeen;
    const G = PAD_GLYPHS[(game.input && game.input.padKind) || 'generic'];
    T.draw(buf, W, H, W / 2, H - 10 * s,
      this.page === 'menu'
        ? (pad ? `D-PAD  ·  ${G.a} SELECT  ·  ${G.b} BACK` : 'ARROWS / W S  ·  ENTER SELECT  ·  ESC BACK')
        : (pad ? `${G.b} BACK` : 'ESC BACK'), {
      size: Math.round(7.5 * s), color: DIM, align: 'center', track: 3, alpha: 0.62,
    });
    if (pad) {
      T.draw(buf, W, H, W - 14 * s, H - 10 * s, 'CONTROLLER READY', {
        size: Math.round(7.5 * s), color: rgba(126, 232, 128, 255), align: 'right',
        track: 2.4, alpha: 0.7,
      });
    }
  }

  drawSkyBackdrop(buf, W, H, game) {
    // Sample the real dome so the six cities on the title are the six cities
    // you're about to lose.
    const dome = game.skyDome;
    const SW = dome.w, SH = dome.h;
    const eMin = dome.elevMin, eSpan = dome.elevMax - dome.elevMin;
    const horizon = H * 0.66;
    const fovScale = 1.15;
    const cloudA = ((this.t * 2.4) % SW) | 0;
    const cloudB = ((this.t * 5.1) % SW) | 0;
    // Which dome column each screen column samples depends only on x, so work
    // it out once per frame rather than once per pixel: this loop covers the
    // whole screen and was most of the title's frame time.
    if (!this._colU || this._colU.length !== W) {
      this._colU = new Int32Array(W); this._colA = new Int32Array(W); this._colB = new Int32Array(W);
    }
    const colU = this._colU, colA = this._colA, colB = this._colB;
    for (let x = 0; x < W; x++) {
      const az = this.az + ((x / W) - 0.5) * 2.4;
      let u = az / TAU; u -= Math.floor(u);
      const su = Math.min(SW - 1, (u * SW) | 0);
      colU[x] = su; colA[x] = (su + cloudA) % SW; colB[x] = (su + cloudB) % SW;
    }
    const base = dome.base, cloud = dome.cloud;
    for (let y = 0; y < H; y++) {
      const elev = ((horizon - y) / H) * fovScale + 0.02;
      let v = (elev - eMin) / eSpan;
      v = v < 0 ? 0 : v > 1 ? 1 : v;
      const row = ((v * (SH - 1)) | 0) * SW;
      for (let x = 0; x < W; x++) {
        let px = base[row + colU[x]];
        const k1 = cloud[row + colA[x]];
        const a1 = k1 >>> 24;
        if (a1) px = mix(px, k1 | (255 << 24), (a1 / 255) * 0.9);
        const k2 = cloud[row + colB[x]];
        const a2 = k2 >>> 24;
        if (a2) px = mix(px, k2 | (255 << 24), (a2 / 255) * 0.45);
        buf[y * W + x] = px;
      }
    }
    if (this.flashT > 0) {
      const a = this.flashT / 0.5;
      addRectBuf(buf, W, H, 0, 0, W, H, rgba(255, 190, 120, 255), a * 0.22);
    }
  }

  drawStreaks(buf, W, H, s, game) {
    const horizon = H * 0.66;
    const fovScale = 1.15;
    const toScreen = (az, elev) => {
      let rel = az - this.az;
      rel = ((rel + Math.PI * 3) % TAU) - Math.PI;
      return { x: W / 2 + (rel / 2.4) * W, y: horizon - (elev - 0.02) / fovScale * H };
    };
    for (const st of this.streaks) {
      const k = st.t / st.life;
      const e = lerp(st.e0, st.e1, k * k);
      const p = toScreen(st.az, e);
      const tailE = lerp(st.e0, st.e1, Math.max(0, k - 0.10) ** 2);
      const q = toScreen(st.az, tailE);
      if (p.x < -60 || p.x > W + 60) continue;
      const col = st.hue > 0.72 ? CYAN : AMBER;
      lineBuf(buf, W, H, q.x, q.y, p.x, p.y, col, 0.35, true);
      addRectBuf(buf, W, H, p.x - 1.5 * s, p.y - 1.5 * s, 3 * s, 3 * s, HOT, 0.9);
      addRectBuf(buf, W, H, p.x - 3 * s, p.y - 3 * s, 6 * s, 6 * s, col, 0.25);
    }
    // Searchlights sweeping the cloud base.
    for (const b of this.beams) {
      const a = b.az + Math.sin(this.t * b.speed + b.phase) * b.sweep;
      const base = toScreen(a, 0.0);
      const tip = toScreen(a + Math.sin(this.t * 0.4 + b.phase) * 0.05, 0.52);
      for (let i = 0; i < 26; i++) {
        const t = i / 26;
        const x = lerp(base.x, tip.x, t), y = lerp(base.y, tip.y, t);
        const w = lerp(2, 16, t) * s;
        addRectBuf(buf, W, H, x - w / 2, y, w, 3 * s, rgba(180, 210, 255, 255), 0.035 * (1 - t) * this.flicker);
      }
    }
  }

  drawParapet(buf, W, H, s) {
    // A hard silhouette gives the sky something to be far away from.
    const base = H * 0.845;
    const rng = makeRng(0x515);
    fillRectBuf(buf, W, H, 0, base, W, H - base, rgba(8, 7, 11, 255), 1);
    // Crenellated blast berm.
    for (let x = 0; x < W; x += Math.round(26 * s)) {
      const hgt = (10 + rng() * 8) * s;
      fillRectBuf(buf, W, H, x, base - hgt, Math.round(18 * s), hgt + 4, rgba(11, 10, 14, 255), 1);
      fillRectBuf(buf, W, H, x, base - hgt, Math.round(18 * s), 1, rgba(58, 50, 46, 255), 0.55);
    }
    fillRectBuf(buf, W, H, 0, base - 1, W, 2, rgba(64, 54, 48, 255), 0.6);
    // Antenna mast with a slow red beacon.
    const mx = Math.round(W * 0.585);
    fillRectBuf(buf, W, H, mx, base - 108 * s, 2 * s, 108 * s, rgba(14, 12, 16, 255), 1);
    for (let i = 1; i < 5; i++) {
      const y = base - 108 * s + i * 22 * s;
      lineBuf(buf, W, H, mx - 9 * s, y, mx + 11 * s, y - 6 * s, rgba(14, 12, 16, 255), 1);
    }
    const beacon = 0.5 + 0.5 * Math.sin(this.t * 2.1);
    addRectBuf(buf, W, H, mx - 1 * s, base - 112 * s, 4 * s, 4 * s, rgba(255, 40, 30, 255), 0.35 + beacon * 0.65);
    addRectBuf(buf, W, H, mx - 4 * s, base - 115 * s, 10 * s, 10 * s, rgba(255, 40, 30, 255), beacon * 0.14);
  }

  /**
   * Stamp a text raster's alpha mask into the framebuffer, colouring each
   * pixel with colAt(rx, ry). Returning 0 from colAt skips that pixel.
   */
  stamp(buf, W, H, r, ox, oy, colAt, alpha) {
    ox = Math.round(ox); oy = Math.round(oy);
    for (let ry = 0; ry < r.h; ry++) {
      const py = oy + ry;
      if (py < 0 || py >= H) continue;
      const src = ry * r.w, dst = py * W;
      for (let rx = 0; rx < r.w; rx++) {
        const sa = r.data[src + rx] >>> 24;
        if (!sa) continue;
        const px = ox + rx;
        if (px < 0 || px >= W) continue;
        const col = colAt(rx, ry);
        if (!col) continue;
        const al = (sa / 255) * alpha;
        const o = dst + px, d0 = buf[o];
        let dr = d0 & 255, dg = (d0 >>> 8) & 255, db = (d0 >>> 16) & 255;
        dr += ((col & 255) - dr) * al; dg += (((col >>> 8) & 255) - dg) * al; db += (((col >>> 16) & 255) - db) * al;
        buf[o] = (255 << 24 | (db | 0) << 16 | (dg | 0) << 8 | (dr | 0)) >>> 0;
      }
    }
  }

  /**
   * The static part of the logo — a deep extrusion graded from hot rust at
   * the face to black at the back, and a hard ink outline — composed once per
   * size into its own frame, so the title does not redo nineteen full-word
   * passes every frame.
   */
  logoBase(r, s) {
    const key = r.w + 'x' + r.h;
    if (this._logoBase && this._logoBase.key === key) return this._logoBase;
    const depth = Math.max(3, Math.round(9 * s));
    const ow = Math.max(1, Math.round(1.7 * s));
    const pad = ow + 1;
    const w = r.w + depth + pad * 2, h = r.h + depth + pad * 2;
    const data = new Uint32Array(w * h);
    const put = (dx, dy, col) => {
      for (let ry = 0; ry < r.h; ry++) {
        const src = ry * r.w, dst = (ry + dy) * w + dx;
        for (let rx = 0; rx < r.w; rx++) {
          const sa = r.data[src + rx] >>> 24;
          if (sa < 60) continue;
          data[dst + rx] = ((col & 0xffffff) | (255 << 24)) >>> 0;
        }
      }
    };
    for (let d = depth; d >= 1; d--) {
      const k = d / depth;
      put(pad + Math.round(d * 0.72), pad + d, mix(rgba(168, 58, 18, 255), rgba(12, 6, 10, 255), Math.pow(k, 0.8)));
    }
    for (let dy = -ow; dy <= ow; dy++) for (let dx = -ow; dx <= ow; dx++) {
      if (dx * dx + dy * dy > ow * ow + 1) continue;
      put(pad + dx, pad + dy, rgba(10, 6, 10, 255));
    }
    this._logoBase = { key, w, h, data, pad };
    return this._logoBase;
  }

  /**
   * Nuclear glow and a radiation trefoil behind the word. Baked once per size
   * into an additive frame: computing it per pixel per frame cost more than
   * the whole rest of the title.
   */
  glowFrame(rx, ry) {
    const key = (rx | 0) + 'x' + (ry | 0);
    if (this._glow && this._glow.key === key) return this._glow;
    const R = ry * 1.3;
    const w = Math.ceil(rx * 2.8), h = Math.ceil(R * 2.3);
    const cx = w / 2, cy = h / 2;
    const data = new Uint32Array(w * h);
    for (let y = 0; y < h; y++) {
      const ny = (y - cy) / ry;
      for (let x = 0; x < w; x++) {
        const nx = (x - cx) / rx;
        const q = nx * nx + ny * ny;
        let add = q < 1.96 ? Math.pow(1 - q / 1.96, 2) * 0.42 : 0;
        const dx = x - cx, dy = y - cy;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < R) {
          let ang = Math.atan2(dy, dx) + Math.PI / 2;
          ang = ((ang % (TAU / 3)) + TAU / 3) % (TAU / 3);
          const blade = d > R * 0.24 && d < R * 0.96 && ang > TAU / 12 && ang < TAU / 12 + Math.PI / 3;
          const hub = d < R * 0.15;
          if (blade || hub) add += 0.16 * (1 - d / R) + 0.05;
        }
        if (add <= 0.004) continue;
        data[y * w + x] = rgba(255, 128, 36, Math.min(255, add * 255));
      }
    }
    this._glow = { key, w, h, data };
    return this._glow;
  }

  drawGlow(buf, W, H, s, cx, cy, rx, ry, a) {
    const f = this.glowFrame(rx, ry);
    const pulse = 0.82 + 0.18 * Math.sin(this.t * 1.7) + (this.flashT || 0) * 0.7;
    blitFrame(buf, W, H, f, cx - f.w / 2, cy - f.h / 2, { additive: true, alpha: a * pulse });
  }

  drawLogo(buf, W, H, s, game) {
    const T = game.text;
    const size = Math.round(H * 0.2);
    const cy = H * 0.245;
    const e = this.enterT;
    // Slams down, overshoots a hair, settles.
    const ease = e < 1 ? 1 - Math.pow(1 - e, 3) * Math.cos(e * 5.2) : 1;
    const y = lerp(cy - 46 * s, cy, ease);
    const a = clamp(e * 1.6, 0, 1);
    const r = T.raster('NUKEHAUS', { size, display: true, track: Math.round(2 * s), weight: 700, crisp: 0.4 });
    const ox = Math.round(W / 2 - (r.w - 4) / 2 - 2);
    const oy = Math.round(y - r.base);

    this.drawGlow(buf, W, H, s, W / 2, oy + r.h * 0.52, r.w * 0.6, r.h * 0.95, a);

    const base = this.logoBase(r, s);
    blitFrame(buf, W, H, base, ox - base.pad, oy - base.pad, { alpha: a });

    // Chrome body: bright sky over a hard dark horizon over a hot reflection,
    // with a specular band sweeping across every few seconds.
    const sweep = ((this.t * 0.32) % 2.2) - 0.4;
    const body = [];
    for (let ry = 0; ry < r.h; ry++) {
      const t = ry / r.h;
      let col;
      if (t < 0.5) col = mix(rgba(255, 253, 242, 255), rgba(255, 196, 80, 255), Math.pow(t / 0.5, 1.5));
      else if (t < 0.545) col = rgba(110, 30, 12, 255);
      else col = mix(rgba(190, 58, 16, 255), rgba(255, 178, 64, 255), (t - 0.545) / 0.455);
      body.push(col);
    }
    const WHITE = rgba(255, 255, 255, 255);
    this.stamp(buf, W, H, r, ox, oy, (rx, ry) => {
      const band = rx / r.w - sweep - (1 - ry / r.h) * 0.22;
      const spec = 1 - Math.abs(band) * 16;
      return spec > 0 ? mix(body[ry], WHITE, spec * 0.8) : body[ry];
    }, a * this.flicker);
    // Bevel: a hairline of light along every top edge.
    this.stamp(buf, W, H, r, ox, oy, (rx, ry) =>
      (ry > 0 && (r.data[(ry - 1) * r.w + rx] >>> 24) < 50) ? WHITE : 0, a * 0.9);

    // Hazard rule, then the tagline on its own dark band so it reads.
    const rw = r.w - 4;
    const ry0 = y + size * 0.2;
    for (let x = 0; x < rw; x++) {
      const px = W / 2 - rw / 2 + x;
      const band = (Math.floor((x + this.t * 14) / (7 * s)) % 2) === 0;
      fillRectBuf(buf, W, H, px, ry0, 1, 3 * s, band ? AMBER : rgba(24, 20, 18, 255), a * 0.95);
    }
    fillRectBuf(buf, W, H, W / 2 - rw * 0.46, ry0 + 7 * s, rw * 0.92, 17 * s, INK, a * 0.62);
    T.draw(buf, W, H, W / 2, ry0 + 19 * s, 'SIX CITIES.   ONE DOCTOR.   ONE BOOT.', {
      size: Math.round(12 * s), color: HOT, align: 'center', track: Math.round(4.5 * s),
      alpha: a, glow: 0.55, glowColor: rgba(255, 120, 40, 255),
    });
    T.draw(buf, W, H, W / 2, ry0 + 35 * s, 'A BUNKER SIEBEN PRODUCTION  ·  RATED M FOR MUTANT', {
      size: Math.round(7 * s), color: DIM, align: 'center', track: Math.round(2.6 * s), alpha: a * 0.8,
    });
  }

  /**
   * Brick on the box art, where a hero belongs: a personnel photo with a
   * bezel, a nameplate, and the odd bad frame of static between expressions.
   */
  drawHero(buf, W, H, s, game) {
    const vm = game.art && game.art.vm;
    if (!vm) return;
    const size = Math.round(H * 0.38);
    const x = Math.round(W - size - 28 * s), y = Math.round(H - size - 44 * s);
    if (x < W * 0.52) return;               // too narrow a window to share with the menu
    const cycle = this.t / 3.4;
    const pose = Math.floor(cycle) % 4;
    const swap = cycle - Math.floor(cycle) < 0.035;
    const f = swap ? vm[`portrait_static${Math.floor(this.t * 20) % 3}`] : vm[`portrait_brick_${pose}`];
    const a = clamp(this.enterT * 1.4 - 0.2, 0, 1);
    if (a <= 0) return;
    fillRectBuf(buf, W, H, x + 5 * s, y + 5 * s, size + 6 * s, size + 30 * s, rgba(0, 0, 0, 255), 0.5 * a);
    fillRectBuf(buf, W, H, x - 3 * s, y - 3 * s, size + 6 * s, size + 30 * s, INK, 0.92 * a);
    if (f) blitFrame(buf, W, H, f, x, y, { scale: size / f.w, alpha: a, lum: 1.18 });
    // Hot rim light down the left edge, as if the sky were burning.
    for (let i = 0; i < 5 * s; i++) {
      addRectBuf(buf, W, H, x + i, y, 1, size, rgba(255, 110, 40, 255), 0.16 * (1 - i / (5 * s)) * a);
    }
    const bez = (cx, cy, dx, dy) => {
      fillRectBuf(buf, W, H, cx - (dx ? 12 * s : 0), cy - (dy ? 2 * s : 0), 12 * s, 2 * s, AMBER, 0.9 * a);
      fillRectBuf(buf, W, H, cx - (dx ? 2 * s : 0), cy - (dy ? 12 * s : 0), 2 * s, 12 * s, AMBER, 0.9 * a);
    };
    bez(x - 3 * s, y - 3 * s, 0, 0); bez(x + size + 3 * s, y - 3 * s, 1, 0);
    bez(x - 3 * s, y + size + 27 * s, 0, 1); bez(x + size + 3 * s, y + size + 27 * s, 1, 1);
    const T = game.text;
    T.draw(buf, W, H, x + size / 2, y + size + 12 * s, 'WARDEN B. HARDIGAN', {
      size: Math.round(9 * s), color: HOT, align: 'center', track: Math.round(2.4 * s), alpha: a,
    });
    T.draw(buf, W, H, x + size / 2, y + size + 22 * s, 'STILL THINKS IT IS 1996', {
      size: Math.round(6.5 * s), color: DIM, align: 'center', track: Math.round(2 * s), alpha: a * 0.85,
    });
  }

  drawMenu(buf, W, H, s, game) {
    const T = game.text;
    const itemH = 19 * s;
    const sc = getScores();
    const best = Math.max(...sc.best);
    const x0 = Math.round(26 * s);
    const plateW = Math.round(232 * s);
    const plateH = Math.round(MENU.length * itemH + 30 * s + (best > 0 ? 14 * s : 0));
    const plateY = Math.round(H - plateH - 30 * s);
    // A solid command plate with a drop shadow: nothing behind it bleeds through.
    fillRectBuf(buf, W, H, x0 + 5 * s, plateY + 5 * s, plateW, plateH, rgba(0, 0, 0, 255), 0.5);
    fillRectBuf(buf, W, H, x0, plateY, plateW, plateH, INK, 0.9);
    fillRectBuf(buf, W, H, x0, plateY, plateW, 1.5 * s, AMBER, 0.85);
    fillRectBuf(buf, W, H, x0, plateY, 3 * s, plateH, RUST, 0.95);
    fillRectBuf(buf, W, H, x0, plateY + plateH - 1, plateW, 1, AMBER, 0.3);
    T.draw(buf, W, H, x0 + 16 * s, plateY + 13 * s, 'SHIFT CONTROL', {
      size: Math.round(7 * s), color: DIM, track: Math.round(3 * s),
    });
    MENU.forEach((m, i) => {
      const on = i === this.sel;
      const y = plateY + 30 * s + i * itemH;
      if (on) {
        const pulse = 0.6 + 0.4 * Math.sin(this.t * 6);
        fillRectBuf(buf, W, H, x0 + 3 * s, y - 12 * s, plateW - 3 * s, itemH - 1 * s, rgba(112, 30, 14, 255), 0.85);
        fillRectBuf(buf, W, H, x0 + 3 * s, y - 12 * s, 3 * s, itemH - 1 * s, rgba(255, 200, 80, 255), pulse);
        T.draw(buf, W, H, x0 + 13 * s, y + 1 * s, '>', { size: Math.round(11 * s), color: AMBER, alpha: pulse });
      }
      T.draw(buf, W, H, x0 + 26 * s, y + 1 * s, m.label, {
        size: Math.round(11 * s), color: on ? HOT : BONE, alpha: on ? 1 : 0.62,
        track: Math.round(2.6 * s), glow: on ? 0.7 : 0, glowColor: AMBER,
      });
    });
    if (best > 0) {
      T.draw(buf, W, H, x0 + 16 * s, plateY + plateH - 9 * s,
        `BEST SHIFT  ${best.toLocaleString()}` + (sc.cleared.some(Boolean) ? '  ·  CLEARED' : `  ·  FLOOR ${sc.deepest}`), {
        size: Math.round(7 * s), color: AMBER, track: Math.round(2 * s), alpha: 0.8,
      });
    }
  }

  drawPanel(buf, W, H, s, title, game) {
    const x = W * 0.16, y = H * 0.44, w = W * 0.68, h = H * 0.46;
    // Solid, like the command plate: the skyline must not show through the text.
    fillRectBuf(buf, W, H, x + 5 * s, y + 5 * s, w, h, rgba(0, 0, 0, 255), 0.5);
    fillRectBuf(buf, W, H, x, y, w, h, INK, 0.95);
    fillRectBuf(buf, W, H, x, y, w, 1.5 * s, AMBER, 0.85);
    fillRectBuf(buf, W, H, x, y, 3 * s, h, RUST, 0.95);
    fillRectBuf(buf, W, H, x, y + h - 1, w, 1, AMBER, 0.3);
    game.text.draw(buf, W, H, x + 14 * s, y + 16 * s, title, {
      size: Math.round(11 * s), color: AMBER, track: Math.round(4 * s),
    });
    return { x, y, w, h };
  }

  drawDifficulty(buf, W, H, s, game) {
    const T = game.text;
    const p = this.drawPanel(buf, W, H, s, 'SELECT YOUR EXPOSURE', game);
    DIFFS.forEach((d, i) => {
      const on = i === this.sel;
      const y = p.y + 46 * s + i * 34 * s;
      if (on) fillRectBuf(buf, W, H, p.x + 10 * s, y - 12 * s, p.w - 20 * s, 28 * s, rgba(40, 28, 18, 255), 0.7);
      T.draw(buf, W, H, p.x + 22 * s, y, d.name, {
        size: Math.round(13 * s), color: on ? HOT : DIM, track: Math.round(3 * s),
        glow: on ? 0.7 : 0, glowColor: AMBER,
      });
      T.draw(buf, W, H, p.x + 22 * s, y + 13 * s, d.blurb, {
        size: Math.round(8 * s), color: on ? BONE : rgba(90, 82, 74, 255), track: 1,
      });
      const sc = getScores();
      if (sc.best[i] > 0) {
        T.draw(buf, W, H, p.x + p.w - 22 * s, y, sc.best[i].toLocaleString(), {
          size: Math.round(11 * s), color: on ? AMBER : rgba(110, 96, 74, 255),
          align: 'right', track: 1.4,
        });
        T.draw(buf, W, H, p.x + p.w - 22 * s, y + 13 * s,
          sc.cleared[i] ? 'CLEARED' : 'BEST', {
          size: Math.round(7 * s), color: sc.cleared[i] ? rgba(126, 232, 128, 255) : DIM,
          align: 'right', track: 2,
        });
      }
    });
  }

  drawHowTo(buf, W, H, s, game) {
    const T = game.text;
    const pad = game.input && game.input.padSeen;
    const G = PAD_GLYPHS[(game.input && game.input.padKind) || 'generic'];
    const p = this.drawPanel(buf, W, H, s, pad ? 'THREE AXES, NOT TWO' : 'THREE AXES, NOT TWO', game);

    const lines = pad ? [
      ['STICKS', 'Left moves. Right looks.'],
      [`${G.rt}`, 'Fire. Contact does nothing — only the airburst kills.'],
      [`${G.lt}`, 'Fine aim. Halves your look speed for threading a fuse.'],
      ['D-PAD ↑↓', 'THE FUSE. How far the shell flies before it bursts.'],
      ['', 'The ring around your crosshair IS that distance.'],
      [`${G.b}`, 'Auto-ranging on/off. Manual fuses score double.'],
      [`${G.y} / R3`, 'THE BOOT. No ammo. Ends arguments.'],
      [`${G.x}`, 'Pipe bomb. Press again to detonate. Timing is your problem.'],
      [`${G.a}`, 'Open doors, shove suspicious walls.'],
      [`${G.lb} ${G.rb}`, `Weapons.   ${G.back} map.   ${G.start} pause.`],
      ['THE SIX', 'Each city survives one hit. The second one erases it.'],
      ['', 'Every 15,000 points MUTTER reissues one. Score is a repair budget.'],
    ] : [
      ['MOUSE', 'Aim. Two axes, like anything else with a trigger.'],
      ['WHEEL / Z X', 'THE FUSE. How far the shell flies before it bursts.'],
      ['', 'The ring around your crosshair IS that distance.'],
      ['C', 'Auto-range on/off. Manual fuses score double on a clean burst.'],
      ['FIRE', 'Contact does nothing. Only the airburst kills.'],
      ['', 'A kill cooks off its payload, which bursts again. Chain them.'],
      ['V / MMB', 'THE BOOT. No ammo, no reload. Ends arguments.'],
      ['B or G', 'Pipe bomb. Press again to detonate. Timing is your problem.'],
      ['WASD', 'Move.  SHIFT run.  SPACE doors and suspicious walls.'],
      ['1-6', 'Weapons.   TAB map.   ESC pause.'],
      ['THE SIX', 'Each city survives one hit. The second one erases it.'],
      ['', 'Every 15,000 points MUTTER reissues one. Score is a repair budget.'],
    ];
    lines.forEach(([k, v], i) => {
      const y = p.y + 36 * s + i * 12.4 * s;
      T.draw(buf, W, H, p.x + 20 * s, y, k, { size: Math.round(8.5 * s), color: AMBER, track: 1.6 });
      T.draw(buf, W, H, p.x + 116 * s, y, v, { size: Math.round(8.5 * s), color: BONE, track: 0.4 });
    });
    T.draw(buf, W, H, p.x + p.w / 2, p.y + p.h - 14 * s, pad
      ? `${(game.input.padName || 'controller').slice(0, 34)} detected. Rumble is on.`
      : 'Plug in an Xbox or PlayStation pad and it will pick it up on its own.', {
      size: Math.round(8 * s), color: pad ? rgba(126, 232, 128, 255) : RUST,
      align: 'center', track: 1,
    });
  }

  drawOptions(buf, W, H, s, game) {
    const T = game.text;
    const p = this.drawPanel(buf, W, H, s, 'CALIBRATION', game);
    const opts = this.optionList(game);
    // Tighten the rows rather than run off the plate as the list grows.
    const row = Math.min(16, 156 / Math.max(1, opts.length - 1));
    opts.forEach((o, i) => {
      const on = i === this.optSel;
      const y = p.y + 40 * s + i * row * s;
      if (on) fillRectBuf(buf, W, H, p.x + 10 * s, y - 10 * s, p.w - 20 * s, 14 * s, rgba(40, 28, 18, 255), 0.66);
      T.draw(buf, W, H, p.x + 20 * s, y, o.label, {
        size: Math.round(8.5 * s), color: on ? HOT : DIM, track: 2,
      });
      T.draw(buf, W, H, p.x + p.w - 20 * s, y, o.value(), {
        size: Math.round(8.5 * s), color: on ? AMBER : rgba(120, 108, 90, 255), align: 'right', track: 1.4,
      });
    });
  }

  drawCredits(buf, W, H, s, game) {
    const T = game.text;
    const p = this.drawPanel(buf, W, H, s, 'PERSONNEL FILE', game);
    const lines = [
      'WARDEN B. HARDIGAN — a man out of his decade and delighted about it.',
      'DR. ILSA VANCE — chief engineer. Built the guns. Sealed in the core.',
      'MUTTER — launch control. Has read his file. Enjoys reading it aloud.',
      '',
      'NUKEHAUS runs on nothing but arithmetic. Every wall, every fang, every',
      'warhead and every note of music is generated at load time from code.',
      'There are no image files. There are no sound files. All three voices',
      'are the same formant synthesiser wearing different vocal tracts.',
      '',
      'Raycast renderer, WebGL post chain, procedural texture and sprite',
      'painters, Web Audio sequencer and voice, all built for this cabinet.',
      '',
      'With respect to MISSILE COMMAND (1980) and WOLFENSTEIN 3D (1992),',
      'and to every shareware hero who ever kicked a door for no reason.',
    ];
    lines.forEach((l, i) => {
      T.draw(buf, W, H, p.x + 20 * s, p.y + 34 * s + i * 11.5 * s, l, {
        size: Math.round(8 * s), color: l ? (i < 3 ? AMBER : BONE) : DIM, track: 0.6, alpha: 0.9,
      });
    });
  }
}

function pct(v) { return `${Math.round(v * 100)}%`; }

// ------------------------------------------------------------------ voice

const VOICE_LABEL = { natural: 'NATURAL', robot: 'ROBOT', off: 'OFF' };

function voiceLabel(game) {
  const m = VOICE_MODES.includes(game.voiceMode) ? game.voiceMode : 'natural';
  // Asked for the browser's voices on a browser that has none: say what is
  // actually playing instead of pretending.
  if (m === 'natural' && game.vox && game.vox.engine === 'robot') return 'ROBOT (NO BROWSER VOICES)';
  return VOICE_LABEL[m];
}

// Somebody has to say something, or the setting is a guess.
const VOICE_SAMPLES = [
  ['brick', 'Check, one two. Brick Hardigan. Still the best-looking son of a bitch in this bunker.'],
  ['ilsa', 'Vance here. If you can understand me, stop playing with the settings and go to work.'],
  ['mutter', 'Voice calibration complete. You sound wonderful. I sound wonderful. We are all going to die.'],
];
let voiceSample = 0;

function cycleVoice(game, d) {
  const n = VOICE_MODES.length;
  const i = Math.max(0, VOICE_MODES.indexOf(game.voiceMode));
  const m = VOICE_MODES[(i + (d < 0 ? n - 1 : 1)) % n];
  game.voiceMode = m;
  saveVoiceMode(m);
  const v = game.vox;
  if (!v) return;
  if (v.setMode) v.setMode(m);
  if (m !== 'off' && v.say) {
    const [who, text] = VOICE_SAMPLES[voiceSample++ % VOICE_SAMPLES.length];
    if (v.cancel) v.cancel();
    v.say(text, { voice: who, priority: 4 });
  }
}
