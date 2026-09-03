// title.js - the front door. Renders the live sky dome as a slowly turning
// backdrop, silhouettes a bunker parapet against it, and puts the logo on top.

import { rgba, mix, clamp as pclamp } from '../core/pixels.js';
import { clamp, lerp, makeRng, TAU } from '../core/math.js';
import { fillRectBuf, addRectBuf, lineBuf, blitFrame } from './text.js';
import { getScores } from '../core/scores.js';
import { PAD_GLYPHS } from '../core/input.js';

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
    const up = input.justPressed('up') || input.rawJustPressed('KeyW');
    const down = input.justPressed('down') || input.rawJustPressed('KeyS');
    const ok = input.justPressed('confirm') || input.justPressed('use') || input.justPressed('fire');
    const back = input.justPressed('escape');

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
        const l = input.justPressed('left') || input.rawJustPressed('KeyA');
        const r = input.justPressed('right') || input.rawJustPressed('KeyD');
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
      { label: 'ANNOUNCER', value: () => pct(game.volVox), adj: (d) => { game.volVox = step(game.volVox, d, 0, 1); game.vox.setVolume(game.volVox); } },
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
      case 'menu': this.drawMenu(buf, W, H, s, game); break;
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
    for (let y = 0; y < H; y++) {
      const elev = ((horizon - y) / H) * fovScale + 0.02;
      let v = (elev - eMin) / eSpan;
      v = v < 0 ? 0 : v > 1 ? 1 : v;
      const row = ((v * (SH - 1)) | 0) * SW;
      for (let x = 0; x < W; x++) {
        const az = this.az + ((x / W) - 0.5) * 2.4;
        let u = az / TAU; u -= Math.floor(u);
        const su = (u * SW) | 0;
        let px = dome.base[row + su];
        const k1 = dome.cloud[row + ((su + cloudA) % SW)];
        const a1 = k1 >>> 24;
        if (a1) px = mix(px, k1 | (255 << 24), (a1 / 255) * 0.9);
        const k2 = dome.cloud[row + ((su + cloudB) % SW)];
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
    const mx = Math.round(W * 0.845);
    fillRectBuf(buf, W, H, mx, base - 108 * s, 2 * s, 108 * s, rgba(14, 12, 16, 255), 1);
    for (let i = 1; i < 5; i++) {
      const y = base - 108 * s + i * 22 * s;
      lineBuf(buf, W, H, mx - 9 * s, y, mx + 11 * s, y - 6 * s, rgba(14, 12, 16, 255), 1);
    }
    const beacon = 0.5 + 0.5 * Math.sin(this.t * 2.1);
    addRectBuf(buf, W, H, mx - 1 * s, base - 112 * s, 4 * s, 4 * s, rgba(255, 40, 30, 255), 0.35 + beacon * 0.65);
    addRectBuf(buf, W, H, mx - 4 * s, base - 115 * s, 10 * s, 10 * s, rgba(255, 40, 30, 255), beacon * 0.14);
  }

  drawLogo(buf, W, H, s, game) {
    const T = game.text;
    const cy = H * 0.29;
    const size = Math.round(H * 0.19);
    const e = this.enterT;
    const ease = 1 - Math.pow(1 - e, 3);
    const y = lerp(cy - 40 * s, cy, ease);
    const a = ease;

    // Heavy extruded shadow so the word has mass.
    for (let d = 7; d >= 1; d--) {
      T.draw(buf, W, H, W / 2 + d * 0.8 * s, y + d * 1.1 * s, 'NUKEHAUS', {
        size, display: true, track: Math.round(2 * s), align: 'center',
        color: rgba(6, 4, 8, 255), alpha: a * (0.13 + d * 0.03), shadow: false, crisp: 0.4,
      });
    }
    // Body: a hot metal ramp painted by stacking passes with clipping bands.
    const r = T.raster('NUKEHAUS', { size, display: true, track: Math.round(2 * s), weight: 700, crisp: 0.4 });
    const ox = Math.round(W / 2 - (r.w - 4) / 2 - 2);
    const oy = Math.round(y - r.base);
    for (let ry = 0; ry < r.h; ry++) {
      const t = ry / r.h;
      // Sodium-lamp gradient: white top, amber middle, rust bottom, with a
      // scanline shimmer rolling through it.
      const shimmer = 0.5 + 0.5 * Math.sin((ry * 0.35) - this.t * 3.4);
      let col;
      if (t < 0.4) col = mix(rgba(255, 252, 240, 255), rgba(255, 206, 96, 255), t / 0.4);
      else if (t < 0.62) col = mix(rgba(255, 206, 96, 255), rgba(226, 128, 36, 255), (t - 0.4) / 0.22);
      else col = mix(rgba(226, 128, 36, 255), rgba(122, 40, 20, 255), (t - 0.62) / 0.38);
      col = mix(col, rgba(255, 255, 230, 255), shimmer * 0.10);
      const dst = (oy + ry) * W + ox;
      const src = ry * r.w;
      if (oy + ry < 0 || oy + ry >= H) continue;
      for (let rx = 0; rx < r.w; rx++) {
        const sa = r.data[src + rx] >>> 24;
        if (!sa) continue;
        const px = ox + rx;
        if (px < 0 || px >= W) continue;
        const al = (sa / 255) * a * this.flicker;
        const o = dst + rx;
        const d0 = buf[o];
        const cr = col & 255, cg = (col >>> 8) & 255, cb = (col >>> 16) & 255;
        let dr = d0 & 255, dg = (d0 >>> 8) & 255, db = (d0 >>> 16) & 255;
        dr += (cr - dr) * al; dg += (cg - dg) * al; db += (cb - db) * al;
        buf[o] = (255 << 24 | (db | 0) << 16 | (dg | 0) << 8 | (dr | 0)) >>> 0;
      }
    }
    // Chromatic ghost, sold as a failing CRT.
    T.draw(buf, W, H, W / 2 - 1.6 * s, y, 'NUKEHAUS', {
      size, display: true, track: Math.round(2 * s), align: 'center',
      color: rgba(255, 60, 40, 255), alpha: a * 0.11, shadow: false, crisp: 0.4,
    });

    // Hazard rule under the word.
    const rw = (r.w - 4);
    const ry0 = y + size * 0.16;
    for (let x = 0; x < rw; x++) {
      const px = W / 2 - rw / 2 + x;
      const band = (Math.floor((x + this.t * 14) / (7 * s)) % 2) === 0;
      fillRectBuf(buf, W, H, px, ry0, 1, 3 * s, band ? AMBER : rgba(24, 20, 18, 255), a * 0.9);
    }
    T.draw(buf, W, H, W / 2, ry0 + 18 * s, 'SIX CITIES.  ONE DOCTOR.  ONE BOOT.', {
      size: Math.round(12 * s), color: BONE, align: 'center', track: Math.round(9 * s),
      alpha: a * 0.92, glow: 0.35, glowColor: AMBER,
    });
    T.draw(buf, W, H, W / 2, ry0 + 32 * s,
      'WARDEN B. HARDIGAN  ·  BUNKER SIEBEN  ·  DO NOT RESUSCITATE', {
      size: Math.round(7 * s), color: DIM, align: 'center', track: Math.round(2.4 * s), alpha: a * 0.7,
    });
  }

  drawMenu(buf, W, H, s, game) {
    const T = game.text;
    const y0 = H * 0.58;
    MENU.forEach((m, i) => {
      const on = i === this.sel;
      const y = y0 + i * 22 * s;
      if (on) {
        const pulse = 0.55 + 0.45 * Math.sin(this.t * 5.2);
        fillRectBuf(buf, W, H, W / 2 - 150 * s, y - 11 * s, 300 * s, 19 * s, rgba(30, 22, 16, 255), 0.55);
        fillRectBuf(buf, W, H, W / 2 - 150 * s, y - 11 * s, 2 * s, 19 * s, AMBER, pulse);
        fillRectBuf(buf, W, H, W / 2 + 148 * s, y - 11 * s, 2 * s, 19 * s, AMBER, pulse);
      }
      T.draw(buf, W, H, W / 2, y + 3 * s, m.label, {
        size: Math.round(12 * s), color: on ? HOT : DIM, align: 'center',
        track: Math.round(4 * s), glow: on ? 0.8 : 0, glowColor: AMBER,
      });
    });
    const sc = getScores();
    const best = Math.max(...sc.best);
    if (best > 0) {
      T.draw(buf, W, H, W / 2, y0 + MENU.length * 22 * s + 16 * s,
        `BEST SHIFT  ${best.toLocaleString()}` +
        (sc.cleared.some(Boolean) ? '   ·   BUNKER CLEARED' : `   ·   REACHED LEVEL ${sc.deepest}`), {
        size: Math.round(8 * s), color: AMBER, align: 'center',
        track: Math.round(3 * s), alpha: 0.75,
      });
    }
  }

  drawPanel(buf, W, H, s, title, game) {
    const x = W * 0.16, y = H * 0.44, w = W * 0.68, h = H * 0.46;
    fillRectBuf(buf, W, H, x, y, w, h, INK, 0.82);
    fillRectBuf(buf, W, H, x, y, w, 1.5 * s, AMBER, 0.8);
    fillRectBuf(buf, W, H, x, y + h - 1.5 * s, w, 1.5 * s, AMBER, 0.4);
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
    ];
    lines.forEach(([k, v], i) => {
      const y = p.y + 38 * s + i * 13.5 * s;
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
    opts.forEach((o, i) => {
      const on = i === this.optSel;
      const y = p.y + 40 * s + i * 16 * s;
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
