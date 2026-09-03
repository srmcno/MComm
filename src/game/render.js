// render.js - assembles the frame: world sprites, dynamic lights, the raycast
// pass, the first-person weapon, and the non-play screens.

import { rgba, mix } from '../core/pixels.js';
import { clamp, lerp, damp, commas, mmss, dist3, TAU } from '../core/math.js';
import { Text, fillRectBuf, addRectBuf, lineBuf, blitFrame } from '../ui/text.js';
import { WARHEAD_TYPES } from './sky.js';
import { ST } from './entities.js';
import { STATE } from './game.js';
import { WEAPONS } from './weapons.js';

const AMBER = rgba(255, 186, 64, 255);
const HOT = rgba(255, 240, 200, 255);
const BONE = rgba(216, 206, 184, 255);
const DIM = rgba(120, 108, 94, 255);
const RED = rgba(255, 74, 62, 255);
const GREEN = rgba(126, 232, 128, 255);
const CYAN = rgba(110, 236, 244, 255);
const INK = rgba(8, 6, 12, 255);

const FOG = {
  dusk: rgba(46, 42, 62, 255), ash: rgba(58, 44, 40, 255), night: rgba(20, 22, 44, 255),
  furnace: rgba(64, 26, 22, 255), terminal: rgba(44, 16, 40, 255),
};

export function renderWorld(game, W, H) {
  const rc = game.rc;
  const p = game.player;
  const lv = game.level;
  const art = game.art;

  rc.resize(W, H);
  const cam = {
    x: p.x + game.shakeX, y: p.y + game.shakeX * 0.6, z: p.z,
    ang: p.ang, pitch: p.pitch + p.recoilPitch * 0.6 + game.shakeY,
  };
  game.horizon = (H * 0.5 + cam.pitch) | 0;

  // ------------------------------------------------------------- lights
  const lights = game.lightList;
  lights.length = 0;
  for (const L of game.staticLights) {
    const f = L.flicker ? 1 - L.flicker * (0.5 + 0.5 * Math.sin(game.time * 11 + L.x * 3.1 + L.y * 1.7)) : 1;
    lights.push({ x: L.x, y: L.y, r: L.r, g: L.g, b: L.b, intensity: L.intensity * f, radius: L.radius });
  }
  if (p.flashTimer > 0) {
    const c = p.spec.light || [1, 0.8, 0.4];
    const k = p.flashTimer / 0.075;
    lights.push({ x: p.x, y: p.y, r: c[0], g: c[1], b: c[2], intensity: 2.4 * k, radius: 9 });
  }
  game.particles.collectLights(lights);
  for (const e of game.enemies) {
    if (e.alive && e.state === ST.WINDUP && e.kind === 'sparker') {
      lights.push({ x: e.x, y: e.y, r: 0.5, g: 0.8, b: 1.0, intensity: 0.8, radius: 4.5 });
    }
  }
  for (const b of game.bolts) {
    lights.push({ x: b.x, y: b.y, r: 0.5, g: 0.85, b: 1.0, intensity: 0.5, radius: 3.4 });
  }
  // Keep the grid build bounded no matter how loud the frame gets.
  if (lights.length > 26) {
    lights.sort((a, b) => (dist3(a.x, a.y, 0, p.x, p.y, 0) - a.radius) - (dist3(b.x, b.y, 0, p.x, p.y, 0) - b.radius));
    lights.length = 26;
  }

  // A soft glow riding with the player. Wolf3D was flat-lit; this keeps the
  // nearby geometry readable without turning the bunker into a lit stage.
  lights.push({ x: p.x, y: p.y, r: 0.95, g: 0.88, b: 0.78, intensity: 0.34, radius: 7.5 });

  const underSky = lv.underSky(p.x, p.y);
  const ambient = underSky
    ? [0.80, 0.78, 0.88]
    : [0.55, 0.53, 0.60];
  game.lights.build(cam, ambient, lights, 24);

  // ------------------------------------------------------------- sprites
  const S = game.spriteList;
  S.length = 0;

  for (const e of game.enemies) {
    const f = art.sprites[e.frameKey(cam.x, cam.y)];
    if (!f) continue;
    S.push({
      x: e.x, y: e.y, z: e.z, frame: f, h: e.height,
      tint: e.painFlash > 0.02 ? rgba(255, 90, 70, 255) : 0,
      alphaOverride: undefined,
      _pain: e.painFlash,
    });
    if (e.painFlash > 0.02) S[S.length - 1].tint = rgba(255, 110, 90, Math.min(200, e.painFlash * 210));
  }

  for (const it of game.items) {
    if (it.taken) continue;
    const key = it.kind === 'weapon' ? `weapon_${it.weapon || 'splitter'}`
      : it.kind === 'treasure' ? `treasure${(Math.floor(game.time * 6) % 4)}`
      : it.kind === 'flare' ? `flare${Math.floor(game.time * 9) % 3}`
      : it.kind === 'ammo' ? 'ammo_flak'
      : it.kind;
    const f = art.sprites[key];
    if (!f) continue;
    const bob = it.prop ? 0 : Math.sin((it.bob || 0)) * 0.035;
    S.push({
      x: it.x, y: it.y, z: (it.z || 0) + bob,
      frame: f,
      h: it.kind === 'pillar' ? 0.95 : it.kind === 'barrel' ? 0.62 : it.kind === 'lamp' ? 0.16 : 0.34,
      emissive: it.kind === 'lamp' || it.kind === 'flare',
    });
  }

  // Warheads and their contrails. The trail is what makes a sky read as busy.
  for (const w of game.sky.warheads) {
    const def = WARHEAD_TYPES[w.type];
    const key = w.type === 'mine' ? `skymine${Math.floor(game.time * 6) % 4}` : def.frame;
    const f = art.sprites[key];
    if (f) {
      S.push({ x: w.x, y: w.y, z: w.z, frame: f, h: def.h, noFog: true, emissive: true });
    }
    const g = def.glow;
    const tr = w.trail;
    for (let i = 0; i < tr.length; i += 3) {
      const k = i / Math.max(1, tr.length);
      S.push({
        x: tr[i], y: tr[i + 1], z: tr[i + 2],
        frame: game.particles.dotSoft, h: lerp(0.9, 3.4, k) + (w.type === 'screamer' ? 1.2 : 0),
        tint: rgba(g[0] * 255, g[1] * 255, g[2] * 255, 255),
        alpha: k * 0.42, additive: true, emissive: true, noFog: true,
      });
    }
    if (w.shield > 0) {
      S.push({
        x: w.x, y: w.y, z: w.z, frame: game.particles.dotSoft, h: def.h * 1.5,
        tint: rgba(200, 110, 255, 255), alpha: 0.30 + 0.12 * Math.sin(game.time * 9),
        additive: true, emissive: true, noFog: true,
      });
    }
  }

  for (const f of game.sky.flak) {
    S.push({
      x: f.x, y: f.y, z: f.z, frame: game.particles.dotSoft, h: 0.9,
      tint: rgba(255, 236, 190, 255), alpha: 0.95, additive: true, emissive: true, noFog: true,
    });
    const tr = f.trail;
    for (let i = 0; i < tr.length; i += 3) {
      const k = i / Math.max(1, tr.length);
      S.push({
        x: tr[i], y: tr[i + 1], z: tr[i + 2], frame: game.particles.dotSoft,
        h: lerp(0.12, 0.5, k), tint: rgba(255, 200, 130, 255),
        alpha: k * 0.4, additive: true, emissive: true, noFog: true,
      });
    }
  }

  for (const b of game.bolts) {
    S.push({
      x: b.x, y: b.y, z: b.z, frame: game.particles.dotSoft, h: 0.26,
      tint: rgba(150, 230, 255, 255), alpha: 1, additive: true, emissive: true,
    });
  }

  game.particles.collect(S, art.vm);

  const palette = game.skyDome.palette;
  const opts = {
    fogFar: underSky ? 58 : 34,
    fogColor: FOG[palette] || FOG.dusk,
    time: game.time,
  };

  return rc.render(lv, cam, {
    texAtlas: art.texAtlas, texEmissive: art.texEmissive, sky: game.skyDome,
  }, game.lights, S, opts);
}

// -------------------------------------------------------------- viewmodel

export function drawViewmodel(game, buf, W, H) {
  const p = game.player;
  if (p.dead) return;
  const art = game.art;
  const spec = p.spec;
  const s = H / 450;

  let stateKey = 'idle';
  if (p.fireAnim > 0) {
    const k = 1 - p.fireAnim / Math.max(0.001, Math.min(0.22, spec.refire * 0.85));
    stateKey = k < 0.34 ? 'fire0' : k < 0.68 ? 'fire1' : 'fire2';
  } else if (p.cooldown > spec.refire * 0.45 && spec.refire > 0.5) {
    stateKey = p.cooldown > spec.refire * 0.7 ? 'reload0' : 'reload1';
  }
  const f = art.vm[`${spec.vm}_${stateKey}`] || art.vm[`${spec.vm}_idle`];
  if (!f) return;

  // Weapon swap dip.
  let swapOff = 0;
  if (p.pendingWeapon) {
    const t = p.swapT || 0;
    swapOff = (t < 0.5 ? t / 0.5 : (1 - t) / 0.5) * H * 0.45;
  }

  const scale = (H * 0.52) / f.h;
  const bobX = Math.sin(p.bobPhase) * 9 * s * p.bob;
  const bobY = Math.abs(Math.cos(p.bobPhase)) * 7 * s * p.bob;
  const x = W / 2 - (f.w * scale) / 2 + bobX + game.shakeX * 40;
  // Sit the weapon low enough that the crosshair stays clear; the art is
  // composed for the lower two-thirds of its frame, so push the rest off-screen.
  const y = H - f.h * scale + bobY + p.kick * 1.4 * s + swapOff + f.h * scale * 0.13;

  // Light the weapon by whatever is lighting the player.
  const L = game.lights.sample(p.x, p.y);
  const lum = clamp(0.62 + (L[0] + L[1] + L[2]) / 3 * 0.55 + (p.flashTimer > 0 ? 0.7 : 0), 0.5, 1.9);
  blitFrame(buf, W, H, f, x, y, { scale, lum });

  if (p.flashTimer > 0) {
    const fl = art.vm[spec.flash] || art.vm.flash_medium;
    if (fl) {
      const k = p.flashTimer / 0.075;
      const fs = scale * (1.6 + (1 - k) * 0.9);
      blitFrame(buf, W, H, fl,
        x + f.w * scale * 0.5 - (fl.w * fs) / 2,
        y - fl.h * fs * 0.34,
        { scale: fs, additive: true, alpha: 0.55 + k * 0.45 });
    }
  }
}

// ------------------------------------------------------------ full screens

export function drawBrief(game, buf, W, H) {
  const s = H / 450;
  const T = game.text;
  const lv = game.level;
  const t = clamp(game.briefT / 0.55, 0, 1);
  fillRectBuf(buf, W, H, 0, 0, W, H, INK, 0.86 * t);
  const y = H * 0.30;
  T.draw(buf, W, H, W / 2, y - 26 * s, `LEVEL ${game.levelIndex + 1} OF ${game.totalLevels}`, {
    size: Math.round(9 * s), color: AMBER, align: 'center', track: Math.round(7 * s), alpha: t,
  });
  T.draw(buf, W, H, W / 2, y + 10 * s, lv.name, {
    size: Math.round(40 * s), color: HOT, align: 'center', display: true,
    track: Math.round(4 * s), alpha: t, glow: t, glowColor: AMBER,
  });
  T.draw(buf, W, H, W / 2, y + 28 * s, lv.def.subtitle || '', {
    size: Math.round(9 * s), color: BONE, align: 'center', track: Math.round(4 * s), alpha: t * 0.8,
  });
  fillRectBuf(buf, W, H, W / 2 - 130 * s, y + 40 * s, 260 * s, 1, AMBER, t * 0.5);

  const brief = lv.def.brief || '';
  const words = brief.split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).length > 62) { lines.push(cur); cur = w; }
    else cur = cur ? cur + ' ' + w : w;
  }
  if (cur) lines.push(cur);
  lines.forEach((l, i) => {
    T.draw(buf, W, H, W / 2, y + 62 * s + i * 14 * s, l, {
      size: Math.round(9.5 * s), color: rgba(190, 236, 255, 255), align: 'center',
      track: 0.6, alpha: t * clamp((game.briefT - 0.3 - i * 0.16) * 3, 0, 1),
    });
  });

  const alive = game.sky.livingCities();
  T.draw(buf, W, H, W / 2, H * 0.72, `CITIES STANDING: ${alive.length} / 6`, {
    size: Math.round(11 * s), color: alive.length > 3 ? GREEN : alive.length > 1 ? AMBER : RED,
    align: 'center', track: Math.round(3 * s), alpha: t,
  });
  T.draw(buf, W, H, W / 2, H * 0.76, alive.map((c) => c.name).join('  ·  ') || 'NONE',
    { size: Math.round(8 * s), color: DIM, align: 'center', track: 1.4, alpha: t * 0.85 });

  if (game.briefT > 0.9) {
    T.draw(buf, W, H, W / 2, H * 0.88, 'PRESS ANYTHING', {
      size: Math.round(9 * s), color: AMBER, align: 'center', track: Math.round(6 * s),
      alpha: 0.4 + 0.5 * Math.abs(Math.sin(game.time * 3.4)),
    });
  }
}

export function drawIntermission(game, buf, W, H) {
  const s = H / 450;
  const T = game.text;
  const st = game.interStats;
  fillRectBuf(buf, W, H, 0, 0, W, H, INK, 0.9);
  const y0 = H * 0.20;
  T.draw(buf, W, H, W / 2, y0, 'FLOOR CLEARED', {
    size: Math.round(30 * s), color: HOT, align: 'center', display: true,
    track: Math.round(5 * s), glow: 0.8, glowColor: AMBER,
  });
  T.draw(buf, W, H, W / 2, y0 + 18 * s, game.level.name, {
    size: Math.round(10 * s), color: AMBER, align: 'center', track: Math.round(5 * s),
  });

  const rows = [
    ['TIME', mmss(st.time), `+${commas(st.timeBonus)}`],
    ['KILLS', `${st.kills} / ${st.enemyTotal}`, st.kills >= st.enemyTotal ? '+5,000' : ''],
    ['SECRETS', `${st.secrets} / ${st.secretTotal}`, st.secrets >= st.secretTotal && st.secretTotal ? '+5,000' : ''],
    ['LAUNCH KEYS', `${st.treasure} / ${st.treasureTotal}`, ''],
    ['WARHEADS DOWN', `${st.skyKills}`, ''],
    ['BEST CHAIN', `×${st.bestChain}`, ''],
    ['CITIES STANDING', `${game.sky.livingCities().length} / 6`, `+${commas(st.cityBonus)}`],
  ];
  const reveal = clamp(game.interT * 2.2, 0, rows.length + 1);
  rows.forEach((r, i) => {
    if (i > reveal) return;
    const y = y0 + 52 * s + i * 20 * s;
    const a = clamp((reveal - i), 0, 1);
    T.draw(buf, W, H, W * 0.30, y, r[0], { size: Math.round(10 * s), color: DIM, track: 2.6, alpha: a });
    T.draw(buf, W, H, W * 0.58, y, r[1], { size: Math.round(11 * s), color: BONE, align: 'right', track: 1.4, alpha: a });
    if (r[2]) T.draw(buf, W, H, W * 0.72, y, r[2], { size: Math.round(11 * s), color: GREEN, track: 1.4, alpha: a });
  });
  if (reveal > rows.length) {
    T.draw(buf, W, H, W / 2, y0 + 52 * s + rows.length * 20 * s + 22 * s,
      `SCORE  ${commas(game.player.score)}`, {
      size: Math.round(18 * s), color: AMBER, align: 'center', track: Math.round(3 * s),
      glow: 0.8, glowColor: AMBER,
    });
    T.draw(buf, W, H, W / 2, H * 0.90, 'PRESS ANYTHING TO DESCEND', {
      size: Math.round(9 * s), color: AMBER, align: 'center', track: Math.round(6 * s),
      alpha: 0.4 + 0.5 * Math.abs(Math.sin(game.time * 3.4)),
    });
  }
}

export function drawGameOver(game, buf, W, H) {
  const s = H / 450;
  const T = game.text;
  const t = clamp(game.overT / 1.4, 0, 1);
  fillRectBuf(buf, W, H, 0, 0, W, H, rgba(28, 4, 8, 255), 0.8 * t);
  const title = game.overReason === 'cities' ? 'NOTHING LEFT TO DEFEND' : 'THE WARDEN HAS STOPPED';
  T.draw(buf, W, H, W / 2, H * 0.36, title, {
    size: Math.round(26 * s), color: rgba(255, 120, 100, 255), align: 'center', display: true,
    track: Math.round(4 * s), alpha: t, glow: t * 0.8, glowColor: RED,
  });
  const dead = game.sky.cities.filter((c) => !c.alive);
  if (dead.length) {
    T.draw(buf, W, H, W / 2, H * 0.47, 'RETIRED', {
      size: Math.round(8 * s), color: DIM, align: 'center', track: Math.round(6 * s), alpha: t,
    });
    T.draw(buf, W, H, W / 2, H * 0.51, dead.map((c) => c.name).join('   ·   '), {
      size: Math.round(9.5 * s), color: rgba(180, 90, 84, 255), align: 'center', track: 1.6, alpha: t,
    });
  }
  T.draw(buf, W, H, W / 2, H * 0.62, `FINAL SCORE  ${commas(game.player.score)}`, {
    size: Math.round(14 * s), color: BONE, align: 'center', track: Math.round(3 * s), alpha: t,
  });
  if (game.beatBest) {
    T.draw(buf, W, H, W / 2, H * 0.68, 'A NEW RECORD. NOBODY IS IMPRESSED.', {
      size: Math.round(9 * s), color: AMBER, align: 'center', track: Math.round(2.6 * s),
      alpha: t * (0.55 + 0.45 * Math.abs(Math.sin(game.time * 4))),
    });
  } else if (game.previousBest) {
    T.draw(buf, W, H, W / 2, H * 0.68, `BEST  ${commas(game.previousBest)}`, {
      size: Math.round(9 * s), color: DIM, align: 'center', track: Math.round(2.6 * s), alpha: t,
    });
  }
  if (game.overT > 2.2) {
    T.draw(buf, W, H, W / 2, H * 0.80, 'PRESS ANYTHING', {
      size: Math.round(9 * s), color: AMBER, align: 'center', track: Math.round(6 * s),
      alpha: 0.4 + 0.5 * Math.abs(Math.sin(game.time * 3.2)),
    });
  }
}

export function drawVictory(game, buf, W, H) {
  const s = H / 450;
  const T = game.text;
  const t = clamp(game.victoryT / 1.6, 0, 1);
  fillRectBuf(buf, W, H, 0, 0, W, H, rgba(8, 10, 20, 255), 0.72 * t);
  T.draw(buf, W, H, W / 2, H * 0.30, 'MUTTER IS SILENT', {
    size: Math.round(30 * s), color: HOT, align: 'center', display: true,
    track: Math.round(5 * s), alpha: t, glow: t, glowColor: AMBER,
  });
  const alive = game.sky.livingCities();
  T.draw(buf, W, H, W / 2, H * 0.42, alive.length === 6 ? 'ALL SIX STILL STANDING' :
    alive.length ? `${alive.length} CITIES SURVIVED YOUR SHIFT` : 'YOU WON. THERE IS NO ONE TO TELL.', {
    size: Math.round(12 * s), color: alive.length ? GREEN : RED, align: 'center',
    track: Math.round(3 * s), alpha: t,
  });
  T.draw(buf, W, H, W / 2, H * 0.49, alive.map((c) => c.name).join('   ·   '), {
    size: Math.round(9 * s), color: BONE, align: 'center', track: 1.6, alpha: t * 0.9,
  });
  T.draw(buf, W, H, W / 2, H * 0.60, `FINAL SCORE  ${commas(game.player.score)}`, {
    size: Math.round(16 * s), color: AMBER, align: 'center', track: Math.round(3 * s), alpha: t,
    glow: t * 0.7, glowColor: AMBER,
  });
  T.draw(buf, W, H, W / 2, H * 0.68,
    `SECRETS ${game.player.secretsFound}   ·   LAUNCH KEYS ${game.player.treasure}   ·   BEST CHAIN ×${game.sky.bestChain}`, {
    size: Math.round(9 * s), color: DIM, align: 'center', track: 2, alpha: t,
  });
  if (game.beatBest) {
    T.draw(buf, W, H, W / 2, H * 0.74, 'A NEW RECORD FOR THIS CABINET', {
      size: Math.round(9 * s), color: AMBER, align: 'center', track: Math.round(2.6 * s),
      alpha: t * (0.55 + 0.45 * Math.abs(Math.sin(game.time * 4))),
    });
  }
  if (game.victoryT > 3) {
    T.draw(buf, W, H, W / 2, H * 0.84, 'PRESS ANYTHING', {
      size: Math.round(9 * s), color: AMBER, align: 'center', track: Math.round(6 * s),
      alpha: 0.4 + 0.5 * Math.abs(Math.sin(game.time * 3.2)),
    });
  }
}

export function drawPause(game, buf, W, H) {
  const s = H / 450;
  const T = game.text;
  fillRectBuf(buf, W, H, 0, 0, W, H, INK, 0.7);
  T.draw(buf, W, H, W / 2, H * 0.42, 'HOLDING', {
    size: Math.round(28 * s), color: HOT, align: 'center', display: true, track: Math.round(6 * s),
    glow: 0.7, glowColor: AMBER,
  });
  T.draw(buf, W, H, W / 2, H * 0.52, 'ESC OR P TO RESUME', {
    size: Math.round(10 * s), color: BONE, align: 'center', track: Math.round(4 * s),
  });
  T.draw(buf, W, H, W / 2, H * 0.58, `${game.level.name}   ·   ${commas(game.player.score)}`, {
    size: Math.round(9 * s), color: DIM, align: 'center', track: 2,
  });
}

export function drawLoading(buf, W, H, text, progress, label, time) {
  const s = H / 450;
  for (let y = 0; y < H; y++) {
    const t = y / H;
    const c = mix(rgba(10, 8, 16, 255), rgba(26, 20, 30, 255), t);
    for (let x = 0; x < W; x++) buf[y * W + x] = c;
  }
  text.draw(buf, W, H, W / 2, H * 0.44, 'NUKEHAUS', {
    size: Math.round(H * 0.13), display: true, color: rgba(255, 200, 110, 255),
    align: 'center', track: Math.round(3 * s), glow: 0.9, glowColor: AMBER,
  });
  const bw = W * 0.42, bx = W / 2 - bw / 2, by = H * 0.60;
  fillRectBuf(buf, W, H, bx - 1, by - 1, bw + 2, 8 * s + 2, rgba(60, 50, 44, 255), 0.8);
  fillRectBuf(buf, W, H, bx, by, bw * clamp(progress, 0, 1), 8 * s, AMBER, 0.95);
  text.draw(buf, W, H, W / 2, by + 24 * s, label, {
    size: Math.round(9 * s), color: BONE, align: 'center', track: Math.round(4 * s), alpha: 0.85,
  });
  text.draw(buf, W, H, W / 2, H * 0.86, 'GENERATING EVERY PIXEL AND EVERY NOTE FROM SCRATCH', {
    size: Math.round(7.5 * s), color: DIM, align: 'center', track: Math.round(2.4 * s), alpha: 0.6,
  });
}
