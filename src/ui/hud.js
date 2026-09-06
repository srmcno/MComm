// hud.js - drawn straight into the software framebuffer so it lives inside the
// CRT effect. The important job here is making a three-axis targeting problem
// legible at a glance: where, how high, and HOW FAR.

import { rgba, mix } from '../core/pixels.js';
import { clamp, lerp, commas, mmss, wrapAngle, TAU } from '../core/math.js';
import { Text, fillRectBuf, addRectBuf, lineBuf, circleBuf, blitFrame } from './text.js';
import { FUSE_MIN, FUSE_MAX } from '../game/player.js';
import { WEAPONS, WEAPON_ORDER, AMMO_FLAK, AMMO_NAIL, AMMO_CHARGE } from '../game/weapons.js';

const AMBER = rgba(255, 186, 64, 255);
const AMBER_DIM = rgba(150, 104, 34, 255);
const CYAN = rgba(110, 236, 244, 255);
const RED = rgba(255, 74, 62, 255);
const GREEN = rgba(126, 232, 128, 255);
const WHITE = rgba(240, 238, 230, 255);
const BONE = rgba(214, 204, 180, 255);
const INK = rgba(10, 8, 12, 255);

export class Hud {
  constructor(text) {
    this.text = text || new Text();
    this.popups = [];
    this.banner = null;
    this.subtitle = null;
    this.mapOpen = false;
    this.faceLook = 1;
    this.faceTimer = 0;
    this.faceOverride = null;
    this.faceOverrideT = 0;
    this.damageDirs = [];
    this.tick = 0;
    this.hit = 0;
    this.hitKill = false;
    this.splats = [];
  }

  /**
   * Gore on the lens. Nothing in a shooter says "that happened right here" as
   * cheaply as the screen itself getting dirty.
   */
  splatter(n, seed) {
    for (let i = 0; i < n; i++) {
      if (this.splats.length > 26) this.splats.shift();
      const a = Math.random() * Math.PI * 2;
      const r = Math.pow(Math.random(), 0.6) * 0.5;
      this.splats.push({
        x: 0.5 + Math.cos(a) * r, y: 0.5 + Math.sin(a) * r * 0.8,
        s: 0.008 + Math.random() * 0.030,
        t: 0, life: 4.5 + Math.random() * 4,
        drip: Math.random() * 0.05,
        tone: 0.55 + Math.random() * 0.45,
      });
    }
  }

  /** Crosshair confirmation. Reads instantly and costs nothing. */
  hitMark(killed) {
    this.hit = killed ? 0.4 : 0.22;
    this.hitKill = this.hitKill || killed;
  }

  popup(str, opts = {}) {
    this.popups.push({
      str, t: 0, life: opts.life || 1.5, size: opts.size || 16,
      color: opts.color || AMBER, y: opts.y || 0, dy: opts.dy === undefined ? -26 : opts.dy,
      glow: opts.glow === undefined ? 0.9 : opts.glow, x: opts.x,
    });
    if (this.popups.length > 14) this.popups.shift();
  }

  showBanner(title, sub, life = 3.0, color = AMBER) {
    this.banner = { title, sub, t: 0, life, color };
  }

  say(str, life = 4.0) {
    this.subtitle = { str, t: 0, life };
  }

  setFace(key, time = 1.6) { this.faceOverride = key; this.faceOverrideT = time; }

  damageFrom(ang) { this.damageDirs.push({ ang, t: 0 }); }

  update(dt) {
    this.tick += dt;
    for (let i = this.splats.length - 1; i >= 0; i--) {
      const sp = this.splats[i];
      sp.t += dt;
      sp.y += sp.drip * dt * 0.12;
      if (sp.t >= sp.life) this.splats.splice(i, 1);
    }
    if (this.hit > 0) {
      this.hit -= dt;
      if (this.hit <= 0) { this.hit = 0; this.hitKill = false; }
    }
    for (let i = this.popups.length - 1; i >= 0; i--) {
      const p = this.popups[i];
      p.t += dt;
      if (p.t >= p.life) this.popups.splice(i, 1);
    }
    if (this.banner) { this.banner.t += dt; if (this.banner.t >= this.banner.life) this.banner = null; }
    if (this.subtitle) { this.subtitle.t += dt; if (this.subtitle.t >= this.subtitle.life) this.subtitle = null; }
    this.faceTimer -= dt;
    if (this.faceTimer <= 0) { this.faceTimer = 1.1 + Math.random() * 2.4; this.faceLook = (Math.random() * 3) | 0; }
    if (this.faceOverrideT > 0) { this.faceOverrideT -= dt; if (this.faceOverrideT <= 0) this.faceOverride = null; }
    for (let i = this.damageDirs.length - 1; i >= 0; i--) {
      this.damageDirs[i].t += dt;
      if (this.damageDirs[i].t > 1.1) this.damageDirs.splice(i, 1);
    }
  }

  draw(buf, W, H, game) {
    const s = H / 450;
    const T = this.text;
    T.frameTick(this.tick);
    const p = game.player;
    const empty = p.emp > 0;

    if (!empty) {
      this.drawReticle(buf, W, H, s, game);
      this.drawThreatRing(buf, W, H, s, game);
      this.drawCities(buf, W, H, s, game);
      this.drawFuseLadder(buf, W, H, s, game);
    } else {
      this.drawEmpStatic(buf, W, H, s, game);
    }
    this.drawSplatter(buf, W, H);
    this.drawObjective(buf, W, H, s, game);
    this.drawRadio(buf, W, H, s, game);
    this.drawBottom(buf, W, H, s, game);
    this.drawDamageDirs(buf, W, H, s, game);
    this.drawPopups(buf, W, H, s);
    this.drawBanner(buf, W, H, s);
    this.drawSubtitle(buf, W, H, s, game);
    if (this.mapOpen) this.drawMap(buf, W, H, s, game);
  }

  // -------------------------------------------------------------- reticle

  drawReticle(buf, W, H, s, game) {
    const p = game.player;
    const cx = W / 2, cy = H / 2;
    if (!game.input.locked && game.input.mouseMoved) {
      // Cursor steering: show where the cursor is and which way it is pushing.
      const mx = clamp(game.input.mouseX, 0, 1) * W;
      const my = clamp(game.input.mouseY, 0, 1) * H;
      circleBuf(buf, W, H, cx, cy, 9 * s, rgba(120, 110, 96, 255), 0.30, true, 1);
      lineBuf(buf, W, H, cx, cy, mx, my, rgba(150, 200, 220, 255), 0.20, true);
      for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        lineBuf(buf, W, H, mx + dx * 3 * s, my + dy * 3 * s, mx + dx * 8 * s, my + dy * 8 * s,
          rgba(190, 230, 250, 255), 0.6, true);
      }
    }
    // Low on the screen: the radio panel owns the top-left, and the range
    // readout under the reticle owns the band just below centre.
    //
    // Two different messages live here. Once the mouse has moved, this is a
    // gentle reminder for someone who pressed Escape. But a gesture-strict
    // browser (Safari) refuses the mouse until the player clicks, and that
    // player has not necessarily moved it yet — for them this is the only
    // instruction that matters, so it gets said loudly.
    const pending = !game.input.locked && game.input._wantLock;
    if (!game.input.locked && (pending || game.input.mouseMoved)) {
      this.text.draw(buf, W, H, W / 2, H * 0.735,
        pending ? 'CLICK TO TAKE THE MOUSE' : 'CLICK TO CAPTURE THE MOUSE', {
          size: Math.round((pending ? 11 : 8) * s),
          color: pending ? rgba(255, 207, 92, 255) : rgba(150, 200, 220, 255),
          align: 'center', track: Math.round(3 * s),
          glow: pending ? 0.7 : 0, glowColor: rgba(255, 160, 40, 255),
          alpha: (pending ? 0.72 : 0.35) + 0.25 * Math.abs(Math.sin(this.tick * 2.2)),
        });
    }
    const spec = p.spec;
    const T = this.text;
    const lock = game.rangeLock;

    if (spec.kind === 'kinetic' || spec.kind === 'throw') {
      // Simple two-axis cross; nothing to fuse.
      const g = 4 * s + p.kick * 0.6;
      const L = 7 * s;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        lineBuf(buf, W, H, cx + dx * g, cy + dy * g, cx + dx * (g + L), cy + dy * (g + L), AMBER, 0.9);
      }
      fillRectBuf(buf, W, H, cx - 1, cy - 1, 2, 2, AMBER, 0.85);
      this.drawHitMark(buf, W, H, s, cx, cy);
      return;
    }

    // The fuse ring: its radius IS the armed range. Dial out, the ring grows.
    const t = (p.fuse - FUSE_MIN) / (FUSE_MAX - FUSE_MIN);
    const R = (7 + t * 46) * s;
    const armed = p.canFire();
    const col = armed ? (p.autoFuse ? CYAN : AMBER) : rgba(150, 60, 54, 255);
    circleBuf(buf, W, H, cx, cy, R, col, 0.5, true, 1);

    // Ticks every 20 units so the ring is a readable scale, not just a circle.
    for (let d = 20; d <= FUSE_MAX; d += 20) {
      const rr = (7 + ((d - FUSE_MIN) / (FUSE_MAX - FUSE_MIN)) * 46) * s;
      for (let i = 0; i < 4; i++) {
        const a = i * Math.PI / 2 + Math.PI / 4;
        addRectBuf(buf, W, H, cx + Math.cos(a) * rr - 0.5, cy + Math.sin(a) * rr - 0.5, 1, 1, AMBER_DIM, 0.55);
      }
    }

    // Crosshair core.
    const g = 3 * s;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      lineBuf(buf, W, H, cx + dx * g, cy + dy * g, cx + dx * (g + 5 * s), cy + dy * (g + 5 * s), col, 0.95, true);
    }

    // Lock bracket on whatever the ranger has, plus the lead point to aim at.
    if (lock) {
      const pr = game.projectWorld(lock.lead.x, lock.lead.y, lock.lead.z);
      if (pr) {
        const b = clamp(16 * s * (28 / Math.max(8, lock.range)), 5 * s, 34 * s);
        const good = Math.abs(p.fuse - lock.range) / Math.max(1, lock.range) < 0.12;
        const lc = good ? GREEN : CYAN;
        const a = 0.55 + 0.35 * Math.sin(this.tick * 9);
        for (const [ox, oy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
          lineBuf(buf, W, H, pr.x + ox * b, pr.y + oy * b, pr.x + ox * b * 0.45, pr.y + oy * b, lc, a, true);
          lineBuf(buf, W, H, pr.x + ox * b, pr.y + oy * b, pr.x + ox * b, pr.y + oy * b * 0.45, lc, a, true);
        }
        T.draw(buf, W, H, pr.x, pr.y - b - 3 * s, `${lock.range.toFixed(0)}`, {
          size: Math.round(9 * s), color: lc, align: 'center', glow: 0.8, glowColor: lc,
        });
        if (good && !p.autoFuse) {
          T.draw(buf, W, H, pr.x, pr.y + b + 10 * s, 'FUSE MATCHED  ×2', {
            size: Math.round(7 * s), color: GREEN, align: 'center', track: 1.4,
          });
        }
      }
    }

    this.drawHitMark(buf, W, H, s, cx, cy);

    // Numeric fuse readout under the ring.
    T.draw(buf, W, H, cx, cy + R + 12 * s, `${p.fuse.toFixed(0)}m`, {
      size: Math.round(10 * s), color: col, align: 'center', glow: 0.7, glowColor: col, track: 0.5,
    });
    // Clear of the readout above: 10*s of glyph plus its glow needs more than
    // a 10*s gap, or the ranging mode sits inside the metres.
    T.draw(buf, W, H, cx, cy + R + 30 * s, p.autoFuse ? 'AUTO-RANGING' : 'MANUAL  ×2', {
      size: Math.round(7 * s), color: p.autoFuse ? CYAN : GREEN, align: 'center',
      track: 2, alpha: 0.8,
    });
  }

  drawSplatter(buf, W, H) {
    for (const sp of this.splats) {
      const k = 1 - sp.t / sp.life;
      const a = Math.pow(k, 0.55) * 0.62;
      if (a < 0.02) continue;
      const cx = sp.x * W, cy = sp.y * H, r = sp.s * W;
      // A soft blob plus a couple of satellites, darkening rather than painting.
      const r2 = r * r;
      const x0 = Math.max(0, (cx - r) | 0), x1 = Math.min(W, (cx + r) | 0 + 1);
      const y0 = Math.max(0, (cy - r) | 0), y1 = Math.min(H, (cy + r) | 0 + 1);
      for (let y = y0; y < y1; y++) {
        const dy = y - cy;
        for (let x = x0; x < x1; x++) {
          const dx = x - cx;
          const d2 = dx * dx + dy * dy;
          if (d2 > r2) continue;
          const f = (1 - d2 / r2) * a * sp.tone;
          const o = y * W + x, dcol = buf[o];
          const dr = dcol & 255, dg = (dcol >>> 8) & 255, db = (dcol >>> 16) & 255;
          buf[o] = (255 << 24 |
            ((db * (1 - f * 0.92)) | 0) << 16 |
            ((dg * (1 - f * 0.94)) | 0) << 8 |
            ((dr * (1 - f * 0.35) + 46 * f) | 0)) >>> 0;
        }
      }
    }
  }

  drawHitMark(buf, W, H, s, cx, cy) {
    if (this.hit <= 0) return;
    const k = this.hit / (this.hitKill ? 0.4 : 0.22);
    const col = this.hitKill ? rgba(255, 96, 72, 255) : WHITE;
    const r = (this.hitKill ? 13 : 9) * s * (1.35 - k * 0.35);
    for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      lineBuf(buf, W, H, cx + dx * r * 0.45, cy + dy * r * 0.45,
        cx + dx * r, cy + dy * r, col, k, true);
    }
    if (this.hitKill) {
      circleBuf(buf, W, H, cx, cy, r * 1.35, col, k * 0.45, true, 1);
    }
  }

  // ---------------------------------------------------------- threat ring

  drawThreatRing(buf, W, H, s, game) {
    const p = game.player;
    const wh = game.sky.warheads;
    if (!wh.length) return;
    const y = 26 * s;
    const halfW = W * 0.34;
    const cx = W / 2;
    fillRectBuf(buf, W, H, cx - halfW, y - 5 * s, halfW * 2, 10 * s, INK, 0.30);
    lineBuf(buf, W, H, cx - halfW, y + 5 * s, cx + halfW, y + 5 * s, AMBER_DIM, 0.35);
    // Compass ticks so the bar reads as a heading strip.
    for (let i = -4; i <= 4; i++) {
      const x = cx + (i / 4) * halfW;
      fillRectBuf(buf, W, H, x, y - 5 * s, 1, i === 0 ? 10 * s : 5 * s, AMBER_DIM, 0.5);
    }
    for (const w of wh) {
      const az = Math.atan2(w.y - p.y, w.x - p.x);
      const rel = wrapAngle(az - p.ang);
      const x = cx + (rel / Math.PI) * halfW;
      const alt = clamp(w.z / 80, 0, 1);
      const urgent = w.z < 22 || w.type === 'buster';
      const col = w.type === 'buster' ? RED : w.type === 'smart' ? CYAN
        : w.type === 'mine' ? rgba(200, 110, 255, 255) : AMBER;
      const blink = urgent ? (0.45 + 0.55 * Math.abs(Math.sin(this.tick * 8))) : 0.9;
      const size = Math.max(2, 4 * s * (0.5 + (1 - alt)));
      addRectBuf(buf, W, H, x - size / 2, y - 4 * s + (1 - alt) * 8 * s, size, size, col, blink);
    }
    this.text.draw(buf, W, H, cx, y - 9 * s, `${wh.length} INBOUND`, {
      size: Math.round(8 * s), color: AMBER, align: 'center', track: 2.2, alpha: 0.9,
    });
  }

  // -------------------------------------------------------------- cities

  drawCities(buf, W, H, s, game) {
    const cities = game.sky.cities;
    const T = this.text;
    const bw = 74 * s, gap = 4 * s;
    const total = cities.length * bw + (cities.length - 1) * gap;
    let x = (W - total) / 2;
    const y = H - 63 * s;
    for (const c of cities) {
      const targeted = game.sky.warheads.some((w) => w.target === c);
      const alive = c.alive;
      const col = !alive ? rgba(72, 66, 66, 255) : c.burning ? rgba(255, 132, 46, 255)
        : targeted ? RED : GREEN;
      const label = !alive ? `† ${c.name}` : c.burning ? `${c.name} ✦` : c.name;
      const bg = !alive ? rgba(24, 20, 22, 255) : INK;
      fillRectBuf(buf, W, H, x, y, bw, 12 * s, bg, 0.62);
      fillRectBuf(buf, W, H, x, y, bw, 1.5 * s, col, alive ? 0.95 : 0.4);
      const blink = targeted && alive ? 0.55 + 0.45 * Math.abs(Math.sin(this.tick * 7)) : 1;
      T.draw(buf, W, H, x + bw / 2, y + 9 * s, label, {
        size: Math.round(7.4 * s), color: col, align: 'center', track: 0.6, alpha: blink * (alive ? 1 : 0.55),
      });
      x += bw + gap;
    }
  }

  // ---------------------------------------------------------- fuse ladder

  drawFuseLadder(buf, W, H, s, game) {
    const p = game.player;
    if (p.spec.kind === 'kinetic') return;
    const x = W - 26 * s, y0 = H * 0.28, y1 = H * 0.70;
    fillRectBuf(buf, W, H, x - 6 * s, y0 - 6 * s, 12 * s, (y1 - y0) + 12 * s, INK, 0.35);
    lineBuf(buf, W, H, x, y0, x, y1, AMBER_DIM, 0.55);
    for (let d = 0; d <= FUSE_MAX; d += 25) {
      const t = (d - FUSE_MIN) / (FUSE_MAX - FUSE_MIN);
      const yy = lerp(y1, y0, clamp(t, 0, 1));
      fillRectBuf(buf, W, H, x - 3 * s, yy, 6 * s, 1, AMBER_DIM, 0.6);
    }
    // Where the ranger says the target is.
    if (game.rangeLock) {
      const t = (game.rangeLock.range - FUSE_MIN) / (FUSE_MAX - FUSE_MIN);
      const yy = lerp(y1, y0, clamp(t, 0, 1));
      for (let i = 0; i < 3; i++) {
        addRectBuf(buf, W, H, x - 9 * s + i, yy - 1, 2, 2, CYAN, 0.85 - i * 0.2);
      }
      lineBuf(buf, W, H, x - 7 * s, yy, x + 7 * s, yy, CYAN, 0.7, true);
    }
    // Where you have it set.
    const t = (p.fuse - FUSE_MIN) / (FUSE_MAX - FUSE_MIN);
    const yy = lerp(y1, y0, clamp(t, 0, 1));
    for (let i = -3; i <= 3; i++) {
      const w = 5 * s - Math.abs(i) * 1.2 * s;
      addRectBuf(buf, W, H, x - w / 2, yy + i, w, 1, AMBER, 0.95);
    }
    this.text.draw(buf, W, H, x, y0 - 10 * s, 'FUSE', {
      size: Math.round(7 * s), color: AMBER, align: 'center', track: 1.6, alpha: 0.8,
    });
  }

  drawEmpStatic(buf, W, H, s, game) {
    const T = this.text;
    const a = 0.35 + 0.4 * Math.abs(Math.sin(this.tick * 22));
    T.draw(buf, W, H, W / 2, H / 2 - 40 * s, 'INSTRUMENTS OFFLINE', {
      size: Math.round(16 * s), color: RED, align: 'center', track: 4, alpha: a, glow: 1,
    });
    T.draw(buf, W, H, W / 2, H / 2 - 24 * s, `RECOVERING  ${game.player.emp.toFixed(1)}s`, {
      size: Math.round(9 * s), color: rgba(200, 90, 80, 255), align: 'center', track: 2, alpha: 0.8,
    });
    for (let i = 0; i < 30; i++) {
      const y = (Math.random() * H) | 0;
      fillRectBuf(buf, W, H, 0, y, W, 1, WHITE, Math.random() * 0.06);
    }
  }

  // ------------------------------------------------------------ bottom bar

  drawBottom(buf, W, H, s, game) {
    const p = game.player;
    const T = this.text;
    const barH = 46 * s;
    const y = H - barH;
    fillRectBuf(buf, W, H, 0, y, W, barH, INK, 0.55);
    fillRectBuf(buf, W, H, 0, y, W, 1, AMBER_DIM, 0.5);

    // Warden face, dead centre, Wolf3D style.
    const tier = clamp(Math.floor((p.health / p.maxHealth) * 4.999), 0, 4);
    let faceKey = this.faceOverride || (p.dead ? 'face_dead' : `face_h${tier}_${this.faceLook}`);
    if (!game.art.vm[faceKey]) faceKey = `face_h${tier}_1`;
    const face = game.art.vm[faceKey];
    if (face) {
      const fs = (barH - 8 * s) / face.h;
      blitFrame(buf, W, H, face, W / 2 - (face.w * fs) / 2, y + 4 * s, { scale: fs });
    }

    // Health, left.
    const hx = 14 * s;
    T.draw(buf, W, H, hx, y + 15 * s, 'VITALS', { size: Math.round(7 * s), color: AMBER_DIM, track: 2.4 });
    const hcol = p.health > 60 ? GREEN : p.health > 25 ? AMBER : RED;
    T.draw(buf, W, H, hx, y + 34 * s, String(Math.ceil(p.health)).padStart(3, ' '), {
      size: Math.round(20 * s), color: hcol, glow: 0.8, glowColor: hcol,
    });
    const bx = hx + 48 * s;
    fillRectBuf(buf, W, H, bx, y + 24 * s, 90 * s, 7 * s, rgba(40, 34, 34, 255), 0.9);
    fillRectBuf(buf, W, H, bx, y + 24 * s, 90 * s * (p.health / p.maxHealth), 7 * s, hcol, 0.92);
    if (p.armour > 0) {
      fillRectBuf(buf, W, H, bx, y + 33 * s, 90 * s * (p.armour / 100), 3 * s, CYAN, 0.9);
    }

    // Keys.
    const keyCols = [RED, rgba(80, 140, 255, 255), rgba(255, 208, 72, 255)];
    for (let i = 0; i < 3; i++) {
      const kx = bx + 100 * s + i * 13 * s;
      fillRectBuf(buf, W, H, kx, y + 24 * s, 9 * s, 12 * s,
        p.keys[i] ? keyCols[i] : rgba(46, 42, 44, 255), p.keys[i] ? 0.95 : 0.55);
      if (p.keys[i]) fillRectBuf(buf, W, H, kx + 2 * s, y + 27 * s, 5 * s, 3 * s, INK, 0.8);
    }

    // Ammo + weapon, right.
    const ax = W - 14 * s;
    const spec = p.spec;
    T.draw(buf, W, H, ax, y + 15 * s, spec.name, {
      size: Math.round(8 * s), color: AMBER, align: 'right', track: 2.2,
    });
    const ammo = p.ammoFor(p.weapon);
    const acol = ammo < spec.cost ? RED : ammo < 20 ? AMBER : BONE;
    const label = spec.ammo === AMMO_CHARGE ? `${ammo} CHG` : String(ammo);
    T.draw(buf, W, H, ax, y + 36 * s, label, {
      size: Math.round(20 * s), color: acol, align: 'right', glow: 0.7, glowColor: acol,
    });

    // Weapon slots.
    let sx = W / 2 + 44 * s;
    for (const k of WEAPON_ORDER) {
      const owned = p.owned[k];
      const cur = k === p.weapon;
      const c = cur ? AMBER : owned ? rgba(120, 100, 70, 255) : rgba(52, 48, 50, 255);
      fillRectBuf(buf, W, H, sx, y + 26 * s, 11 * s, 11 * s, c, cur ? 0.9 : 0.5);
      T.draw(buf, W, H, sx + 5.5 * s, y + 35 * s, String(WEAPONS[k].slot), {
        size: Math.round(8 * s), color: cur ? INK : rgba(180, 160, 130, 255), align: 'center', shadow: false,
      });
      sx += 13 * s;
    }

    // Score + level, top strip of the bar.
    T.draw(buf, W, H, W / 2, y + 12 * s, commas(p.score), {
      size: Math.round(12 * s), color: BONE, align: 'center', track: 1.6,
    });
    T.draw(buf, W, H, 14 * s, 12 * s, `${game.levelIndex + 1}/${game.totalLevels}  ${game.level.name}`, {
      size: Math.round(8 * s), color: AMBER_DIM, track: 2.4,
    });
    T.draw(buf, W, H, W - 14 * s, 12 * s, mmss(game.levelTime), {
      size: Math.round(8 * s), color: AMBER_DIM, align: 'right', track: 2.4,
    });
    if (p.streak >= 3) {
      const k = clamp(p.streakTimer / 4.2, 0, 1);
      T.draw(buf, W, H, W - 14 * s, y - 10 * s, `${p.streak} STREAK`, {
        size: Math.round(11 * s), color: rgba(255, 208, 72, 255), align: 'right',
        track: 2, alpha: 0.4 + k * 0.6, glow: k * 0.7, glowColor: rgba(255, 208, 72, 255),
      });
    }
    if (game.sky.combo > 1) {
      const c = clamp(game.sky.comboTimer / 2.2, 0, 1);
      T.draw(buf, W, H, W / 2, y - 26 * s, `CHAIN ×${game.sky.combo}`, {
        size: Math.round(13 * s), color: AMBER, align: 'center', track: 2, glow: c,
        alpha: 0.5 + c * 0.5,
      });
    }
  }

  /**
   * Whoever is talking, with their portrait. This is where the story lives, so
   * it sits high-left, out of the way of the sky and the crosshair.
   */
  /** A world-space arrow to the current objective. Only when there is one. */
  drawObjective(buf, W, H, s, game) {
    if (!game.rescuePending || !game.level) return;
    const lv = game.level;
    if (this._exitCell === undefined || this._exitLevel !== game.levelIndex) {
      this._exitLevel = game.levelIndex;
      this._exitCell = null;
      for (let i = 0; i < lv.exit.length; i++) {
        if (lv.exit[i]) { this._exitCell = [(i % lv.W) + 0.5, ((i / lv.W) | 0) + 0.5]; break; }
      }
    }
    if (!this._exitCell) return;
    const [ex, ey] = this._exitCell;
    const p = game.player;
    const rel = wrapAngle(Math.atan2(ey - p.y, ex - p.x) - p.ang);
    const d = Math.hypot(ex - p.x, ey - p.y);
    const pulse = 0.55 + 0.45 * Math.abs(Math.sin(this.tick * 3.4));
    const col = rgba(126, 232, 244, 255);
    const cx = clamp(W / 2 + (rel / 0.7) * (W * 0.42), 24 * s, W - 24 * s);
    const cy = H * 0.30;
    for (let i = 0; i < 9; i++) {
      const t = i / 9;
      addRectBuf(buf, W, H, cx - 8 * s + t * 16 * s, cy - 4 * s * (1 - Math.abs(t - 0.5) * 2),
        2, 4 * s, col, pulse * (1 - Math.abs(t - 0.5) * 1.2));
    }
    this.text.draw(buf, W, H, cx, cy - 8 * s, `DR. VANCE  ${d.toFixed(0)}m`, {
      size: Math.round(8 * s), color: col, align: 'center', track: 2, alpha: pulse,
      glow: 0.5, glowColor: col,
    });
  }

  drawRadio(buf, W, H, s, game) {
    const r = game.radio;
    if (!r || !r.current) return;
    const m = r.current;
    const sp = m.speakerDef;
    const inT = clamp(m.t / 0.22, 0, 1);
    const outT = clamp((m.life - m.t) / 0.3, 0, 1);
    const a = Math.min(inT, outT);
    if (a <= 0.01) return;

    const size = Math.round(76 * s);
    const x = Math.round(16 * s), y = Math.round(46 * s + (1 - inT) * 12 * s);
    const col = rgba(sp.color[0], sp.color[1], sp.color[2], 255);
    const key = r.portraitKey;
    const f = key ? game.art.vm[key] : null;

    if (f) {
      fillRectBuf(buf, W, H, x - 3 * s, y - 3 * s, size + 6 * s, size + 6 * s, INK, 0.82 * a);
      // Lift the portrait off the scene behind it; Ilsa's CRT is dark by design.
      blitFrame(buf, W, H, f, x, y, { scale: size / f.w, alpha: a, lum: 1.22 });
      // Bezel: two corner brackets and a live status lamp.
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const cx = x - 3 * s + dx * (size + 6 * s), cy = y - 3 * s + dy * (size + 6 * s);
        fillRectBuf(buf, W, H, cx - (dx ? 9 * s : 0), cy - (dy ? 1.5 * s : 0), 9 * s, 1.5 * s, col, 0.85 * a);
        fillRectBuf(buf, W, H, cx - (dx ? 1.5 * s : 0), cy - (dy ? 9 * s : 0), 1.5 * s, 9 * s, col, 0.85 * a);
      }
      const live = 0.45 + 0.55 * Math.abs(Math.sin(this.tick * 5));
      addRectBuf(buf, W, H, x + size - 6 * s, y + 3 * s, 4 * s, 4 * s, col, live * a);
      // Occasional dropout on the transmission.
      if (m.speaker === 'ilsa' && Math.sin(this.tick * 13.7 + m.t * 3) > 0.93) {
        for (let i = 0; i < 5; i++) {
          const ly = y + ((Math.random() * size) | 0);
          fillRectBuf(buf, W, H, x, ly, size, 1, rgba(200, 240, 255, 255), 0.25 * a);
        }
      }
    }

    const tx = f ? x + size + 10 * s : x;
    // A plate behind the dialogue, or it competes with whatever wall is behind it.
    const plateW = Math.min(W - tx - 12 * s, 460 * s);
    fillRectBuf(buf, W, H, tx - 6 * s, y - 3 * s, plateW + 12 * s, size + 6 * s, INK, 0.66 * a);
    fillRectBuf(buf, W, H, tx - 6 * s, y - 3 * s, 1.5 * s, size + 6 * s, col, 0.7 * a);
    this.text.draw(buf, W, H, tx, y + 10 * s, sp.name, {
      size: Math.round(9 * s), color: col, track: Math.round(3 * s), alpha: a,
      glow: 0.5 * a, glowColor: col,
    });
    // Word-wrapped line, so long dialogue never runs off the screen.
    const maxW = plateW - 8 * s;
    const words = String(m.text || '').split(' ');
    const lines = [];
    let cur = '';
    for (const w of words) {
      const test = cur ? cur + ' ' + w : w;
      if (this.text.measure(test, { size: Math.round(9.5 * s) }).w > maxW && cur) { lines.push(cur); cur = w; }
      else cur = test;
    }
    if (cur) lines.push(cur);
    // Type the line on rather than dropping it in whole.
    const chars = Math.floor(m.t * 46);
    let used = 0;
    lines.slice(0, 4).forEach((ln, i) => {
      const take = clamp(chars - used, 0, ln.length);
      used += ln.length;
      if (take <= 0) return;
      this.text.draw(buf, W, H, tx, y + 27 * s + i * 12.5 * s, ln.slice(0, take), {
        size: Math.round(9.5 * s), color: rgba(232, 226, 212, 255), track: 0.4, alpha: a,
        shadow: true,
      });
    });
  }

  drawDamageDirs(buf, W, H, s, game) {
    const p = game.player;
    for (const d of this.damageDirs) {
      const rel = wrapAngle(d.ang - p.ang);
      const a = (1 - d.t / 1.1) * 0.8;
      const r = H * 0.3;
      const cx = W / 2 + Math.sin(rel) * r * 1.4;
      const cy = H / 2 - Math.cos(rel) * r * 0.7;
      for (let i = 0; i < 12; i++) {
        const t = i / 12;
        addRectBuf(buf, W, H, cx - 14 * s + t * 28 * s, cy - 3 * s * (1 - Math.abs(t - 0.5) * 2),
          2, 3 * s, RED, a * (1 - Math.abs(t - 0.5) * 1.4));
      }
    }
  }

  drawPopups(buf, W, H, s) {
    const T = this.text;
    for (const p of this.popups) {
      const k = p.t / p.life;
      const a = k < 0.12 ? k / 0.12 : Math.pow(1 - k, 0.7);
      const yy = H * 0.42 + p.y + p.dy * Math.pow(k, 0.6) * s;
      T.draw(buf, W, H, p.x === undefined ? W / 2 : p.x, yy, p.str, {
        size: Math.round(p.size * s), color: p.color, align: 'center',
        alpha: a, glow: p.glow * a, glowColor: p.color, track: 1.6,
      });
    }
  }

  drawBanner(buf, W, H, s) {
    if (!this.banner) return;
    const b = this.banner;
    const k = b.t / b.life;
    const a = k < 0.1 ? k / 0.1 : k > 0.75 ? (1 - k) / 0.25 : 1;
    const y = H * 0.24;
    fillRectBuf(buf, W, H, 0, y - 24 * s, W, 46 * s, INK, 0.42 * a);
    fillRectBuf(buf, W, H, 0, y - 24 * s, W, 1, b.color, 0.7 * a);
    fillRectBuf(buf, W, H, 0, y + 22 * s, W, 1, b.color, 0.7 * a);
    this.text.draw(buf, W, H, W / 2, y + 2 * s, b.title, {
      size: Math.round(26 * s), color: b.color, align: 'center', display: true,
      track: 5, alpha: a, glow: a, glowColor: b.color,
    });
    if (b.sub) {
      this.text.draw(buf, W, H, W / 2, y + 17 * s, b.sub, {
        size: Math.round(9 * s), color: BONE, align: 'center', track: 3, alpha: a * 0.85,
      });
    }
  }

  drawSubtitle(buf, W, H, s, game) {
    // The radio panel already shows what was said; don't print it twice.
    if (game && game.radio && game.radio.current) return;
    if (!this.subtitle) return;
    const st = this.subtitle;
    const k = st.t / st.life;
    const a = k > 0.82 ? (1 - k) / 0.18 : 1;
    const y = H - 82 * s;
    const m = this.text.measure(st.str, { size: Math.round(10 * s), track: 0.8 });
    fillRectBuf(buf, W, H, W / 2 - m.w / 2 - 8 * s, y - 11 * s, m.w + 16 * s, 17 * s, INK, 0.6 * a);
    this.text.draw(buf, W, H, W / 2, y, st.str, {
      size: Math.round(10 * s), color: rgba(190, 236, 255, 255), align: 'center',
      track: 0.8, alpha: a, glow: 0.4 * a, glowColor: CYAN,
    });
  }

  // ---------------------------------------------------------------- automap

  drawMap(buf, W, H, s, game) {
    const lv = game.level, p = game.player;
    const cell = clamp(Math.min(W * 0.60 / lv.W, H * 0.62 / lv.H), 2, 9);
    const mw = lv.W * cell, mh = lv.H * cell;
    const ox = (W - mw) / 2, oy = (H - mh) / 2 - 16 * s;
    fillRectBuf(buf, W, H, 0, 0, W, H, INK, 0.90);
    fillRectBuf(buf, W, H, ox - 7, oy - 7, mw + 14, mh + 14, rgba(16, 14, 20, 255), 0.96);
    // Frame corners, so the panel reads as an instrument rather than a hole.
    const cl = Math.max(8, 16 * s);
    for (const [cx, cy, dx, dy] of [[ox - 7, oy - 7, 1, 1], [ox + mw + 7, oy - 7, -1, 1],
                                    [ox - 7, oy + mh + 7, 1, -1], [ox + mw + 7, oy + mh + 7, -1, -1]]) {
      fillRectBuf(buf, W, H, dx > 0 ? cx : cx - cl, cy - (dy > 0 ? 0 : 1), cl, 1.5 * s, AMBER, 0.8);
      fillRectBuf(buf, W, H, cx - (dx > 0 ? 0 : 1), dy > 0 ? cy : cy - cl, 1.5 * s, cl, AMBER, 0.8);
    }
    for (let y = 0; y < lv.H; y++) {
      for (let x = 0; x < lv.W; x++) {
        const i = y * lv.W + x;
        const px = ox + x * cell, py = oy + y * cell;
        if (!lv.visited[i]) {
          // Unsurveyed ground: a faint lattice, so the dark reads as fog rather
          // than as nothing having been drawn.
          if (((x + y) & 3) === 0) {
            fillRectBuf(buf, W, H, px + cell * 0.5 - 0.5, py + cell * 0.5 - 0.5, 1, 1,
              rgba(70, 66, 78, 255), 0.35);
          }
          continue;
        }
        if (lv.wall[i] === 1) {
          const c = lv.height[i] < 0.9 ? rgba(126, 112, 70, 255) : rgba(104, 108, 122, 255);
          fillRectBuf(buf, W, H, px, py, cell, cell, c, 0.95);
        } else if (lv.wall[i] === 2) {
          const k = lv.doorKind[i];
          fillRectBuf(buf, W, H, px, py, cell, cell,
            k === 1 ? RED : k === 2 ? rgba(80, 140, 255, 255) : k === 3 ? rgba(255, 208, 72, 255) : AMBER, 0.95);
        } else if (lv.roofPanel[i]) {
          fillRectBuf(buf, W, H, px, py, cell, cell, rgba(44, 104, 124, 255), 0.9);
          if (lv.sky[i]) addRectBuf(buf, W, H, px, py, cell, cell, rgba(60, 150, 180, 255), 0.35);
        } else if (lv.exit[i]) {
          fillRectBuf(buf, W, H, px, py, cell, cell, GREEN, 0.9);
        } else if (lv.trigger[i]) {
          fillRectBuf(buf, W, H, px, py, cell, cell, rgba(200, 70, 60, 255), 0.85);
        } else {
          fillRectBuf(buf, W, H, px, py, cell, cell, rgba(44, 44, 54, 255), 0.9);
        }
      }
    }
    for (const e of game.enemies) {
      if (!e.alive) continue;
      const i = (e.y | 0) * lv.W + (e.x | 0);
      if (!lv.visited[i]) continue;
      addRectBuf(buf, W, H, ox + e.x * cell - 1, oy + e.y * cell - 1, 3, 3, RED, 0.9);
    }
    for (const it of game.items) {
      if (it.taken) continue;
      const i = (it.y | 0) * lv.W + (it.x | 0);
      if (!lv.visited[i]) continue;
      addRectBuf(buf, W, H, ox + it.x * cell - 1, oy + it.y * cell - 1, 2, 2, CYAN, 0.75);
    }
    // Player arrow.
    const px = ox + p.x * cell, py = oy + p.y * cell;
    const ca = Math.cos(p.ang), sa = Math.sin(p.ang);
    lineBuf(buf, W, H, px - ca * 4, py - sa * 4, px + ca * 6, py + sa * 6, GREEN, 1, true);
    lineBuf(buf, W, H, px + ca * 6, py + sa * 6, px + (-ca * 0.4 - sa * 0.6) * 6, py + (-sa * 0.4 + ca * 0.6) * 6, GREEN, 1, true);
    lineBuf(buf, W, H, px + ca * 6, py + sa * 6, px + (-ca * 0.4 + sa * 0.6) * 6, py + (-sa * 0.4 - ca * 0.6) * 6, GREEN, 1, true);

    this.text.draw(buf, W, H, W / 2, oy - 16 * s,
      `${game.level.name}  —  ${game.level.def.subtitle || ''}`, {
      size: Math.round(10 * s), color: AMBER, align: 'center', track: 3,
    });
    this.text.draw(buf, W, H, W / 2, oy + mh + 20 * s,
      `SECRETS ${game.player.secretsFound}/${game.secretTotal}` +
      `   ·   KILLS ${game.levelKills}/${game.enemyTotal}` +
      `   ·   LAUNCH KEYS ${game.player.treasure}/${game.treasureTotal}` +
      `   ·   WARHEADS DOWN ${game.player.skyKills}`, {
      size: Math.round(8 * s), color: BONE, align: 'center', track: 2, alpha: 0.85,
    });
    this.text.draw(buf, W, H, W / 2, oy + mh + 32 * s,
      'DECKS IN BLUE   ·   TRIGGERS IN RED   ·   EXIT IN GREEN', {
      size: Math.round(7 * s), color: rgba(110, 100, 90, 255), align: 'center', track: 2.2,
    });
  }
}
