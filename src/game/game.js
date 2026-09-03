// game.js - the machine that runs NUKEHAUS: state, level flow, and every
// callback the sky war and the enemies fire back into.

import { Raycaster, LightGrid } from '../engine/raycaster.js';
import { Sky } from '../engine/skybox.js';
import { Level } from './level.js';
import { Player, EYE_HEIGHT, FUSE_MIN, FUSE_MAX } from './player.js';
import { Enemy, Bolt, ENEMY_TYPES, ST } from './entities.js';
import { Particles } from './particles.js';
import { SkyWar, City, WARHEAD_TYPES, CITY_MAX_HP } from './sky.js';
import { WEAPONS, WEAPON_ORDER, AMMO_FLAK, AMMO_NAIL, AMMO_CHARGE, weaponBySlot } from './weapons.js';
import { Hud } from '../ui/hud.js';
import { Text, blitFrame, fillRectBuf, addRectBuf } from '../ui/text.js';
import { parseLevelDef } from '../engine/assets.js';
import { clamp, damp, lerp, dist, dist3, wrapAngle, makeRng, randRange, commas, TAU } from '../core/math.js';
import { rgba } from '../core/pixels.js';

export const STATE = {
  TITLE: 'title', BRIEF: 'brief', PLAY: 'play', PAUSE: 'pause',
  INTERMISSION: 'intermission', GAMEOVER: 'gameover', VICTORY: 'victory',
};

const SKY_PALETTES = ['dusk', 'ash', 'night', 'furnace', 'terminal'];

// What the three exposure settings on the title screen actually change.
// Score threshold at which MUTTER rebuilds a city, straight out of 1980.
export const BONUS_CITY_EVERY = 15000;

export const DIFFICULTY = [
  { name: 'CLERICAL',   warheadSpeed: 0.80, enemyDamage: 0.55, enemyHp: 0.85,
    waveCount: 0.75, maxAliveDelta: -1, blast: 1.18, health: 125, regen: 1.8 },
  { name: 'WARDEN',     warheadSpeed: 1.00, enemyDamage: 1.00, enemyHp: 1.00,
    waveCount: 1.00, maxAliveDelta: 0,  blast: 1.00, health: 100, regen: 1.0 },
  { name: 'LAST SHIFT', warheadSpeed: 1.28, enemyDamage: 1.45, enemyHp: 1.20,
    waveCount: 1.30, maxAliveDelta: 2,  blast: 0.90, health: 100, regen: 0.5 },
];

/** Never let a missing audio module take the game down. */
function safeSound(s) {
  const noop = () => {};
  if (!s) return { sfx: noop, music: noop, stopMusic: noop, setMaster: noop, setMusicVol: noop,
                   setSfxVol: noop, duck: noop, panic: noop, update: noop, ready: false, ctx: null };
  const wrap = {};
  for (const k of ['sfx', 'music', 'stopMusic', 'setMaster', 'setMusicVol', 'setSfxVol', 'duck', 'panic', 'update']) {
    wrap[k] = typeof s[k] === 'function' ? (...a) => { try { return s[k](...a); } catch (e) { /* audio never kills a frame */ } } : noop;
  }
  Object.defineProperty(wrap, 'ready', { get: () => !!s.ready });
  Object.defineProperty(wrap, 'ctx', { get: () => s.ctx });
  wrap.raw = s;
  return wrap;
}

function safeVox(v) {
  const noop = () => 0;
  if (!v) return { say: noop, sayLine: noop, cancel: () => {}, setVolume: () => {}, busy: false, LINES: {} };
  return {
    say: (...a) => { try { return v.say(...a) || 0; } catch { return 0; } },
    sayLine: (...a) => { try { return (v.sayLine ? v.sayLine(...a) : v.say(...a)) || 0; } catch { return 0; } },
    cancel: () => { try { v.cancel && v.cancel(); } catch { /* ignore */ } },
    setVolume: (x) => { try { v.setVolume && v.setVolume(x); } catch { /* ignore */ } },
    get busy() { return !!v.busy; },
  };
}

export class Game {
  constructor(art, sound, vox, input, post, text) {
    this.art = art;
    this.sound = safeSound(sound);
    this.vox = safeVox(vox);
    this.voxLines = (vox && vox.LINES) || {};
    this.input = input;
    this.post = post;
    this.text = text || new Text();
    this.rc = new Raycaster();
    this.lights = new LightGrid();
    this.hud = new Hud(this.text);
    this.player = new Player();
    this.particles = new Particles();
    this.sky = new SkyWar(this);
    this.skyDome = new Sky(art.vm);
    this.enemies = [];
    this.items = [];
    this.bolts = [];
    this.decals = [];
    this.state = STATE.TITLE;
    this.time = 0;
    this.levelTime = 0;
    this.levelIndex = 0;
    this.shake = 0;
    this.shakeX = 0; this.shakeY = 0;
    this.rng = makeRng(0xA11CE);
    this.spriteList = [];
    this.lightList = [];
    this.rangeLock = null;
    this.horizon = 0;
    this.subtitlesOn = true;
    this.difficulty = 1;
    this.totalScoreCarry = 0;
    this.pendingState = null;
    this.messageQueue = [];
    this.diff = DIFFICULTY[1];
    this.nextBonusCity = BONUS_CITY_EVERY;
    this.idleTaunt = 22;
    this.bossKilled = false;
    this.hitStop = 0;
    // Player-facing settings the title screen's calibration page edits directly.
    this.volMaster = 0.85;
    this.volMusic = 0.7;
    this.volVox = 0.9;
    this.sens = 1.0;
    this.invertY = false;
    this.resScale = 1.0;
    this.resLocked = false;

    const M = art.maps;
    this.mapDefs = M.MAPS || [];
    this.totalLevels = this.mapDefs.length;
    this.parse = (i) => {
      if (M.parseLevel) {
        try { const r = M.parseLevel(i); if (r && r.w) return r; } catch (e) { console.warn('parseLevel failed', e); }
      }
      return parseLevelDef(this.mapDefs[i], i);
    };
  }

  // ------------------------------------------------------------- lifecycle

  newGame(difficulty = 1) {
    this.difficulty = clamp(difficulty | 0, 0, DIFFICULTY.length - 1);
    this.diff = DIFFICULTY[this.difficulty];
    this.player.reset();
    this.player.maxHealth = this.diff.health;
    this.player.health = this.diff.health;
    this.sky = new SkyWar(this);
    this.levelIndex = 0;
    this.totalScoreCarry = 0;
    this.bossKilled = false;
    this.nextBonusCity = BONUS_CITY_EVERY;
    this.loadLevel(0);
  }

  loadLevel(i) {
    this.levelIndex = clamp(i, 0, this.totalLevels - 1);
    const parsed = this.parse(this.levelIndex);
    this.level = new Level(parsed, this.art);
    this.sky.placeCities(this.level);
    this.skyDome.setPalette(SKY_PALETTES[this.levelIndex % SKY_PALETTES.length]);
    this.skyDome.rebuild(this.sky.cities);
    this.lights.resize(this.level.W, this.level.H);
    this.particles.clear();
    this.enemies.length = 0;
    this.items.length = 0;
    this.bolts.length = 0;
    this.decals.length = 0;
    this.sky.warheads.length = 0;
    this.sky.flak.length = 0;
    this.sky.blasts.length = 0;
    this.sky.active = false;
    this.levelTime = 0;
    this.waveQueue = [];
    this.triggersFired = new Set();
    this.bossKilled = false;
    this.staticLights = [];
    this.hitStop = 0;

    const p = this.player;
    p.x = parsed.start.x; p.y = parsed.start.y; p.z = EYE_HEIGHT;
    p.ang = parsed.start.dir; p.pitch = 0; p.vx = 0; p.vy = 0;
    p.keys = [false, false, false];
    p.dead = false;
    p.emp = 0;
    p.health = Math.max(p.health, 45);

    this.triggerOrder = [];
    for (let n = 0; n < this.level.trigger.length; n++) {
      if (this.level.trigger[n]) this.triggerOrder.push(n);
    }
    this.waveQueue = [];
    let secretTotal = 0, treasureTotal = 0;
    for (let n = 0; n < this.level.secret.length; n++) if (this.level.secret[n]) secretTotal++;

    for (const e of parsed.ents) {
      if (ENEMY_TYPES[e.kind]) {
        const en = new Enemy(e.kind, e.x, e.y);
        en.hp = en.maxHp = Math.round(en.maxHp * this.diff.enemyHp);
        this.enemies.push(en);
      } else if (e.kind === 'lamp' || e.kind === 'flare') {
        const warm = e.kind === 'flare';
        this.staticLights.push({
          x: e.x, y: e.y,
          r: warm ? 1.0 : 0.92, g: warm ? 0.62 : 0.88, b: warm ? 0.28 : 0.82,
          intensity: warm ? 0.85 : 0.72, radius: warm ? 6.5 : 8.2, flicker: warm ? 0.28 : 0.05,
        });
        this.items.push({ kind: e.kind, x: e.x, y: e.y, z: e.kind === 'lamp' ? 0.86 : 0.7, prop: true, taken: false });
      } else if (e.kind === 'pillar' || e.kind === 'barrel') {
        this.items.push({
          kind: e.kind, x: e.x, y: e.y, z: 0, prop: true, taken: false,
          solid: true, hp: e.kind === 'barrel' ? 20 : 999,
        });
        // A pillar is architecture, so it stops you. A drum you can shove past.
        if (e.kind === 'pillar') this.level.propBlock[this.level.idx(e.x, e.y)] = 1;
      } else {
        if (e.kind === 'treasure') treasureTotal++;
        this.items.push({ kind: e.kind, x: e.x, y: e.y, z: 0, weapon: e.weapon, taken: false, bob: Math.random() * TAU });
      }
    }
    this.enemyTotal = this.enemies.length;
    this.levelKills = 0;
    this.secretTotal = secretTotal;
    this.treasureTotal = treasureTotal;

    this.hud.popups.length = 0;
    this.hud.mapOpen = false;
    this.setState(STATE.BRIEF);
    this.briefT = 0;
  }

  setState(s) {
    this.state = s;
    if (s === STATE.PLAY) {
      this.sound.music(this.sky.active ? 'siege' : (this.level.def.music || 'prowl'),
        { fadeIn: 1.2, intensity: this.sky.intensity });
    }
  }

  nextLevel() {
    if (this.levelIndex + 1 >= this.totalLevels) { this.win(); return; }
    this.totalScoreCarry = this.player.score;
    this.setState(STATE.INTERMISSION);
    this.interT = 0;
    this.interStats = this.buildStats();
    this.sound.stopMusic(0.8);
    this.sound.sfx('elevator');
    this.speak('level_clear', {}, 'The floor below is worse.');
  }

  buildStats() {
    const p = this.player;
    const timeBonus = Math.max(0, Math.round((this.level.def.par - this.levelTime) * 25));
    const cityBonus = this.sky.livingCities().length * 2500;
    const killPct = this.enemyTotal ? p.kills / this.enemyTotal : 1;
    const secretPct = this.secretTotal ? p.secretsFound / this.secretTotal : 1;
    const perfect = (killPct >= 1 ? 5000 : 0) + (secretPct >= 1 ? 5000 : 0);
    return {
      time: this.levelTime, timeBonus, cityBonus, perfect,
      kills: this.levelKills, enemyTotal: this.enemyTotal,
      secrets: p.secretsFound, secretTotal: this.secretTotal,
      treasure: p.treasure, treasureTotal: this.treasureTotal,
      bestChain: this.sky.bestChain,
      skyKills: p.skyKills,
      total: timeBonus + cityBonus + perfect,
    };
  }

  win() {
    this.setState(STATE.VICTORY);
    this.victoryT = 0;
    this.sound.stopMusic(0.6);
    this.sound.music('victory', { fadeIn: 0.2 });
    this.speak('victory', {}, 'You have won. There is nothing left to win.');
  }

  gameOver(reason) {
    if (this.state === STATE.GAMEOVER) return;
    this.setState(STATE.GAMEOVER);
    this.overT = 0;
    this.overReason = reason;
    this.sound.stopMusic(0.5);
    this.sound.music('gameover', { fadeIn: 0.3 });
    this.sound.sfx('player_die');
    this.speak(reason === 'cities' ? 'all_cities_lost' : 'game_over', {},
      reason === 'cities' ? 'All six are gone. You may stand down.' : 'The warden is no longer with us.');
  }

  // ---------------------------------------------------------------- speech

  speak(key, opts = {}, fallbackText = '') {
    const lines = this.voxLines;
    let text = fallbackText;
    const entry = lines[key];
    if (entry) text = Array.isArray(entry) ? entry[(Math.random() * entry.length) | 0] : entry;
    if (opts.args) {
      for (const a of opts.args) text = text.replace('%s', a);
    }
    // Strip inline phoneme escapes before the text hits the screen.
    const shown = String(text).replace(/\{[^}]*\}/g, (m) => m.slice(1, -1).replace(/[0-9]/g, '').toLowerCase());
    this.sound.duck(0.4, 1.6);
    const dur = this.vox.sayLine ? this.vox.sayLine(key, opts) : 0;
    if (!dur && text) this.vox.say(text, opts);
    if (this.subtitlesOn && shown) this.hud.say(shown, Math.max(2.6, (dur || 3.2)));
  }

  // ---------------------------------------------------------------- update

  update(dt, input) {
    this.time += dt;
    this.text.frameTick(this.time);

    if (this.hitStop > 0) { this.hitStop -= dt; dt *= 0.22; }

    switch (this.state) {
      case STATE.BRIEF: this.updateBrief(dt, input); break;
      case STATE.PLAY: this.updatePlay(dt, input); break;
      case STATE.PAUSE: this.updatePause(dt, input); break;
      case STATE.INTERMISSION: this.updateIntermission(dt, input); break;
      case STATE.GAMEOVER: this.updateGameOver(dt, input); break;
      case STATE.VICTORY: this.updateVictory(dt, input); break;
      default: break;
    }
    this.hud.update(dt);

    this.shake = damp(this.shake, 0, 5.5, dt);
    const sh = this.shake;
    this.shakeX = (this.rng() - 0.5) * sh * 0.06;
    this.shakeY = (this.rng() - 0.5) * sh * 9;
    this.post.flash = damp(this.post.flash, 0, 9.5, dt);
    this.post.warp = damp(this.post.warp, 0, 3.2, dt);
    this.post.damage = clamp(this.player.hurtFlash * 0.75 +
      (this.player.health < 28 && !this.player.dead ? 0.12 + 0.08 * Math.sin(this.time * 4.4) : 0), 0, 1);
  }

  updateBrief(dt, input) {
    this.briefT += dt;
    if (this.briefT > 0.6 && (input.anyPressed() || this.briefT > 6.5)) {
      this.setState(STATE.PLAY);
      this.speak('boot', {}, 'Good morning. Bunker Sieben is operating normally.');
    }
  }

  updatePause(dt, input) {
    if (input.justPressed('pause') || input.justPressed('escape')) {
      this.setState(STATE.PLAY);
      input.requestLock();
    }
  }

  updateIntermission(dt, input) {
    this.interT += dt;
    if (this.interT > 1.2 && input.anyPressed()) {
      this.loadLevel(this.levelIndex + 1);
    }
  }

  updateGameOver(dt, input) {
    this.overT += dt;
    this.particles.update(dt, this.level);
    if (this.overT > 2.2 && input.anyPressed()) this.pendingState = 'title';
  }

  updateVictory(dt, input) {
    this.victoryT += dt;
    this.particles.update(dt, this.level);
    if (this.victoryT > 3.0 && input.anyPressed()) this.pendingState = 'title';
  }

  updatePlay(dt, input) {
    const p = this.player;
    const lv = this.level;
    this.levelTime += dt;

    if (input.justPressed('pause') || input.justPressed('escape')) {
      this.setState(STATE.PAUSE);
      input.releaseLock();
      return;
    }
    if (input.justPressed('map')) { this.hud.mapOpen = !this.hud.mapOpen; this.sound.sfx('ui_select'); }

    if (!p.dead) {
      p.applyLook(input.mouseDX + (input.padLookX || 0) * 14, input.mouseDY + (input.padLookY || 0) * 12,
        this.sens, this.invertY, this.rc.projY, this.rc.h);
      const axes = input.axes();
      p.moveWith(dt, axes, lv, this);

      // Fuse dial.
      if (input.wheel) { p.adjustFuse(-input.wheel * 5.5); this.sound.sfx('flak_arm', { vol: 0.35 }); }
      if (input.isDown('fuseUp')) p.adjustFuse(38 * dt);
      if (input.isDown('fuseDown')) p.adjustFuse(-38 * dt);
      if (input.justPressed('autoFuse') || input.justPressed('altfire')) {
        p.autoFuse = !p.autoFuse;
        this.sound.sfx('ui_move');
        this.hud.popup(p.autoFuse ? 'AUTO-RANGING ON' : 'MANUAL FUSE', { size: 11, life: 1.1, color: rgba(110, 236, 244, 255) });
      }
      for (let s = 1; s <= 5; s++) if (input.justPressed('slot' + s)) {
        if (p.selectSlot(s)) this.sound.sfx('weapon_switch');
      }
      if (input.justPressed('use')) this.tryUse();
      if (input.isDown('fire')) this.tryFire();
    }

    p.update(dt, input, lv, this);

    // Auto-range: point at a warhead and the fuse follows it.
    this.updateRangeLock();
    if (p.autoFuse && this.rangeLock) {
      p.fuse = damp(p.fuse, clamp(this.rangeLock.range, FUSE_MIN, FUSE_MAX), 14, dt);
    }

    lv.update(dt, (kind, x, y) => {
      if (kind === 'close') this.sound.sfx('door_close', { pan: this.panAt(x, y) });
      if (kind === 'push') {
        this.sound.sfx('secret_found', { pan: this.panAt(x, y), vol: 0.7 });
        this.particles.dust(x, y, 0.4, 14);
        this.shake = Math.max(this.shake, 1.2);
      }
    });
    if (lv.updateRoof(dt)) {
      if (lv.roofOpen > 0.02 && lv.roofOpen < 0.99) this.shake = Math.max(this.shake, 0.55);
    }

    for (const e of this.enemies) e.update(dt, this);
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      this.bolts[i].update(dt, this);
      if (!this.bolts[i].alive) this.bolts.splice(i, 1);
    }
    this.sky.update(dt, this);
    this.particles.update(dt, lv);
    this.checkBonusCity();
    this.updateItems(dt);
    this.updateTriggers(dt);
    this.updateWave(dt);
    lv.markVisited(p.x, p.y, 5);

    // Idle chatter in the quiet stretches.
    this.idleTaunt -= dt;
    if (this.idleTaunt <= 0 && !this.sky.active && !this.vox.busy) {
      this.idleTaunt = randRange(this.rng, 40, 80);
      this.speak('idle_taunt', {}, 'Productivity is within tolerance.');
    }

    if (p.dead) {
      this.deathT = (this.deathT || 0) + dt;
      p.pitch = damp(p.pitch, -this.rc.h * 0.18, 2, dt);
      p.z = damp(p.z, 0.16, 2.2, dt);
      if (this.deathT > 2.6) { this.deathT = 0; this.gameOver('killed'); }
    }
  }

  /** Every BONUS_CITY_EVERY points, the machine puts one back. */
  checkBonusCity() {
    if (this.player.score < this.nextBonusCity) return;
    this.nextBonusCity += BONUS_CITY_EVERY;
    const hurt = this.sky.cities.filter((c) => c.hp < CITY_MAX_HP)
      .sort((a, b) => a.hp - b.hp);
    if (!hurt.length) {
      this.player.score += 5000;
      this.hud.popup('ALL SIX INTACT  +5,000', { size: 14, life: 2.4, color: rgba(126, 232, 128, 255) });
      return;
    }
    const c = hurt[0];
    const wasDead = !c.alive;
    c.hp = CITY_MAX_HP;
    this.skyDome.rebuild(this.sky.cities);
    this.sound.sfx('pickup_treasure');
    this.sound.sfx('wave_clear', { delay: 0.25 });
    this.hud.showBanner(wasDead ? `${c.name} REBUILT` : `${c.name} REPAIRED`,
      'THE MACHINE SEES NO CONTRADICTION', 3.6, rgba(126, 232, 128, 255));
    this.hud.setFace('face_grin', 2.4);
    this.speak('city_rebuilt', {},
      `${c.name} has been reissued. The previous ${c.name} is not to be discussed.`);
  }

  updateRangeLock() {
    const p = this.player;
    if (p.spec.kind === 'kinetic' || p.spec.kind === 'nuke') { this.rangeLock = null; return; }
    const a = p.aimVector(this.rc.projY);
    this.rangeLock = this.sky.rangeAlong(p.x, p.y, p.z, a.x, a.y, a.z, p.spec.flakSpeed || 70, 0.30);
  }

  updateItems(dt) {
    const p = this.player;
    for (const it of this.items) {
      if (it.taken) continue;
      if (it.prop) continue;
      it.bob = (it.bob || 0) + dt * 3.2;
      if (dist(p.x, p.y, it.x, it.y) < 0.62) this.pickUp(it);
    }
  }

  pickUp(it) {
    const p = this.player;
    let got = true, msg = '', col = rgba(126, 232, 128, 255);
    switch (it.kind) {
      case 'key_red': p.keys[0] = true; msg = 'RED KEYCARD'; col = rgba(255, 74, 62, 255);
        this.sound.sfx('pickup_key'); this.hud.setFace('face_key', 1.8);
        this.speak('key_taken', {}, 'You have taken something that was not yours. Wonderful.'); break;
      case 'key_blue': p.keys[1] = true; msg = 'BLUE KEYCARD'; col = rgba(80, 140, 255, 255);
        this.sound.sfx('pickup_key'); this.hud.setFace('face_key', 1.8);
        this.speak('key_taken', {}, 'Access granted. Against my advice.'); break;
      case 'key_gold': p.keys[2] = true; msg = 'GOLD KEYCARD'; col = rgba(255, 208, 72, 255);
        this.sound.sfx('pickup_key'); this.hud.setFace('face_key', 1.8);
        this.speak('key_taken', {}, 'That one opens the bad room.'); break;
      case 'medkit_small': got = p.heal(18) > 0; msg = '+18 VITALS'; this.sound.sfx('pickup_health'); break;
      case 'medkit_big': got = p.heal(48) > 0; msg = '+48 VITALS'; this.sound.sfx('pickup_health'); break;
      case 'ammo': got = p.giveAmmo(AMMO_FLAK, 20) > 0 || p.giveAmmo(AMMO_NAIL, 26) > 0;
        msg = 'FLAK SHELLS'; col = rgba(255, 186, 64, 255); this.sound.sfx('pickup_ammo'); break;
      case 'ammo_crate':
        p.giveAmmo(AMMO_FLAK, 50); p.giveAmmo(AMMO_NAIL, 60);
        msg = 'AMMO CRATE'; col = rgba(255, 186, 64, 255); this.sound.sfx('pickup_ammo'); break;
      case 'treasure': p.treasure++; p.score += 2500; msg = 'LAUNCH KEY  +2500';
        col = rgba(255, 208, 72, 255); this.sound.sfx('pickup_treasure'); this.hud.setFace('face_grin', 1.6); break;
      case 'weapon': {
        const w = it.weapon || 'splitter';
        const isNew = p.giveWeapon(w);
        msg = isNew ? WEAPONS[w].name : 'AMMO';
        col = rgba(110, 236, 244, 255);
        this.sound.sfx('pickup_weapon');
        if (isNew) {
          this.hud.popup(WEAPONS[w].blurb, { size: 9, life: 3.4, y: 22, dy: -8, color: rgba(200, 194, 180, 255), glow: 0.2 });
          this.speak('weapon_taken', {}, 'Try not to point that at the ceiling.');
        }
        break;
      }
      default: got = false;
    }
    if (!got) return;
    it.taken = true;
    this.hud.popup(msg, { size: 13, life: 1.5, color: col });
    this.particles.sparks(it.x, it.y, 0.5, 8, 1.2, [col & 255, (col >>> 8) & 255, (col >>> 16) & 255], 3);
  }

  updateTriggers(dt) {
    const p = this.player;
    const lv = this.level;
    const i = lv.idx(p.x, p.y);
    if (lv.trigger[i] && !this.triggersFired.has(i) && !this.sky.active) {
      this.triggersFired.add(i);
      this.beginSiege(i);
    }
    if (lv.exit[i] && this.canExit()) {
      this.sound.sfx('elevator');
      this.nextLevel();
    }
  }

  canExit() {
    if (this.level.def.siege && this.level.def.siege.waves &&
        this.level.def.siege.waves.length > this.triggersFired.size) {
      // Decks still unfought: let them leave anyway, but say something about it.
      if (!this._nagged) {
        this._nagged = true;
        this.hud.popup('SILO DECKS STILL LIVE', { size: 12, life: 2.2, color: rgba(255, 74, 62, 255) });
      }
    }
    if (this.levelIndex === this.totalLevels - 1 && !this.bossKilled) {
      this.hud.popup('MUTTER IS STILL TALKING', { size: 12, life: 2.0, color: rgba(255, 74, 62, 255) });
      return false;
    }
    return true;
  }

  /**
   * Start the wave (or run of waves) belonging to a trigger.
   *
   * A trigger owns every wave whose `trigger` index matches its reading-order
   * position, and those run back to back, so a deck can escalate. Levels with
   * more waves than triggers depend on this.
   */
  beginSiege(triggerCell) {
    const waves = (this.level.def.siege && this.level.def.siege.waves) || [];
    if (!waves.length) return;
    let tIdx = 0;
    if (triggerCell !== undefined && this.triggerOrder) {
      const at = this.triggerOrder.indexOf(triggerCell);
      if (at >= 0) tIdx = at;
    } else {
      tIdx = clamp(this.triggersFired.size - 1, 0, waves.length - 1);
    }
    let queue = waves.map((w, i) => ({ w, i })).filter(({ w }) => (w.trigger || 0) === tIdx);
    if (!queue.length) queue = [{ w: waves[clamp(tIdx, 0, waves.length - 1)], i: tIdx }];
    this.waveQueue = queue.slice(1);
    this.startWaveDef(queue[0].w, queue[0].i);
  }

  startWaveDef(defIn, idx) {
    let def = defIn;
    if (!def) return;
    const D = this.diff;
    if (D.waveCount !== 1 || D.maxAliveDelta !== 0 || D.warheadSpeed !== 1) {
      def = {
        ...def,
        maxAlive: clamp((def.maxAlive || 6) + D.maxAliveDelta, 2, 14),
        spawn: (def.spawn || []).map((g) => ({
          ...g,
          count: Math.max(1, Math.round(g.count * D.waveCount)),
          speed: (g.speed || 1) * D.warheadSpeed,
        })),
      };
    }
    this.level.openRoof();
    this.sound.sfx('roof_open');
    this._siegeIntensity = def.intensity || 0.5;
    this.sound.music('siege', { fadeIn: 1.6, intensity: this._siegeIntensity });
    this.shake = 3.2;
    this.sky.startWave(def, idx);
    const more = this.waveQueue && this.waveQueue.length;
    this.hud.showBanner(def.name || 'INBOUND',
      more ? `DEFEND THE SIX  ·  ${more + 1} FLIGHTS` : 'DEFEND THE SIX',
      3.2, rgba(255, 74, 62, 255));
    this.speak('roof_opening', {}, 'The roof is opening. Please look up.');
    this.pendingGrunts = (def.grunts || []).map((g) => ({ ...g, spawned: 0 }));
  }

  updateWave(dt) {
    if (!this.sky.active) return;
    // Deck reinforcements drop in mid-siege so you can never just stare upward.
    if (this.pendingGrunts) {
      for (const g of this.pendingGrunts) {
        const span = Math.max(0.001, g.to - g.from);
        const want = clamp((this.sky.waveTime - g.from) / span, 0, 1) * g.count;
        while (g.spawned < Math.floor(want)) {
          g.spawned++;
          this.spawnDeckEnemy(g.kind);
        }
      }
    }
    // music() cross-fades, so only nudge it when the intensity has actually
    // moved. Calling it every frame restarts the track sixty times a second.
    if (this._siegeIntensity === undefined ||
        Math.abs(this.sky.intensity - this._siegeIntensity) > 0.06) {
      this._siegeIntensity = this.sky.intensity;
      this.sound.music('siege', { fadeIn: 0.4, intensity: this.sky.intensity });
    }
    if (this.sky.waveComplete) {
      const cleared = this.sky.livingCities().length;
      const next = this.waveQueue && this.waveQueue.shift();
      this.sky.endWave();
      this._siegeIntensity = undefined;
      if (next) {
        // Another flight from the same deck: a breather, then it starts again.
        this.player.score += 900 + this.sky.bestChain * 200;
        this.hud.showBanner('FLIGHT DOWN', 'ANOTHER IS COMING', 2.6, rgba(255, 186, 64, 255));
        this.sound.sfx('wave_clear');
        this.speak('wave_clear', {}, 'That flight is accounted for. The next one is not.');
        const at = this.levelIndex;
        setTimeout(() => {
          if (this.state === STATE.PLAY && this.levelIndex === at) this.startWaveDef(next.w, next.i);
        }, 6000);
        return;
      }
      this.level.roofTarget = 0;
      this.sound.sfx('wave_clear');
      this.sound.music(this.level.def.music || 'prowl', { fadeIn: 2.2 });
      const bonus = 1500 + cleared * 900 + this.sky.bestChain * 400;
      this.player.score += bonus;
      this.hud.showBanner('SKY CLEAR', `+${commas(bonus)}   ${cleared} CITIES STANDING`, 3.4,
        rgba(126, 232, 128, 255));
      this.speak('wave_clear', {}, 'The sky is empty. For now.');
    }
  }

  spawnDeckEnemy(kind) {
    const lv = this.level;
    void 0;
    // Drop them on a deck cell away from the player's feet.
    const cands = [];
    for (let y = 0; y < lv.H; y++) for (let x = 0; x < lv.W; x++) {
      const i = y * lv.W + x;
      if (lv.roofPanel[i] && !lv.wall[i]) {
        const d = dist(x + 0.5, y + 0.5, this.player.x, this.player.y);
        if (d > 4.5) cands.push([x + 0.5, y + 0.5]);
      }
    }
    if (!cands.length) return;
    const [x, y] = cands[(this.rng() * cands.length) | 0];
    const e = new Enemy(kind, x, y);
    e.state = ST.ALERT;
    this.enemies.push(e);
    this.enemyTotal++;
    this.particles.dust(x, y, 0.2, 16);
    this.sound.sfx('enemy_pain', { pan: this.panAt(x, y), vol: 0.4, rate: 0.7 });
  }

  // ---------------------------------------------------------------- firing

  tryUse() {
    const p = this.player;
    const r = this.level.tryUse(p.x, p.y, p.ang, p.keys, (x, y) => {
      p.secretsFound++;
      p.score += 1500;
      this.hud.popup('SECRET FOUND  +1500', { size: 13, life: 2.0, color: rgba(255, 208, 72, 255) });
      this.hud.setFace('face_grin', 2.0);
      this.speak('secret_found', {}, 'You found the room I was saving.');
    });
    if (r === 'opened') this.sound.sfx('door_open');
    else if (r === 'locked') {
      this.sound.sfx('door_locked');
      this.hud.popup('LOCKED — KEYCARD REQUIRED', { size: 11, life: 1.4, color: rgba(255, 74, 62, 255) });
    }
  }

  tryFire() {
    const p = this.player;
    if (!p.canFire()) {
      if (p.cooldown <= 0 && this.ammoDry !== this.time) {
        this.ammoDry = this.time;
        this.sound.sfx('dryfire');
        if (p.ammoFor(p.weapon) < p.spec.cost) {
          this.hud.popup('DRY', { size: 12, life: 0.8, color: rgba(255, 74, 62, 255) });
          this.speak('low_ammo', {}, 'You are out. That is a personnel issue.');
        }
      }
      return;
    }
    const spec = p.spec;
    p.ammo[spec.ammo] -= spec.cost;
    p.cooldown = spec.refire;
    p.kick = spec.kick;
    p.kickVel = 0;
    p.flashTimer = 0.075;
    p.fireAnim = Math.min(0.22, spec.refire * 0.85);
    this.shake = Math.max(this.shake, spec.shakeAmount);
    this.sound.sfx(spec.sfx, { vol: 1 });

    // Take the aim vector BEFORE applying recoil: the shell leaves along where
    // you were pointing, and the kick moves the view afterwards. The other way
    // round throws every shot high by the recoil of the shot itself.
    const a = p.aimVector(this.rc.projY);
    const muzzle = {
      x: p.x + a.x * 0.35, y: p.y + a.y * 0.35, z: p.z + a.z * 0.35 - 0.08,
    };
    this.particles.sparks(muzzle.x, muzzle.y, muzzle.z, 5, 0.6,
      [255, 200, 120], 4);

    switch (spec.kind) {
      case 'flak': this.fireFlak(spec, a, muzzle); break;
      case 'ring': this.fireHalo(spec, a, muzzle); break;
      case 'kinetic': this.fireKinetic(spec, a, muzzle); break;
      case 'nuke': this.fireDeadman(spec, a, muzzle); break;
      default: break;
    }
    p.recoilPitch += spec.kick * 0.9;
    this.alertNearby(p.x, p.y, spec.kind === 'kinetic' ? 9 : 15);
    if (spec.kind !== 'nuke') this.particles.casing(muzzle.x, muzzle.y, p.z - 0.12, p.ang);
  }

  fireFlak(spec, a, m) {
    const ideal = this.rangeLock ? this.rangeLock.range : -1;
    spec = this.diff.blast === 1 ? spec : { ...spec, blastRadius: spec.blastRadius * this.diff.blast };
    for (let i = 0; i < spec.pellets; i++) {
      let dx = a.x, dy = a.y, dz = a.z;
      if (spec.spread) {
        // Fan the Splitter's three shells across the aim axis.
        const ang = (i - (spec.pellets - 1) / 2) * spec.spread * 2;
        const cs = Math.cos(ang), sn = Math.sin(ang);
        const nx = dx * cs - dy * sn, ny = dx * sn + dy * cs;
        dx = nx; dy = ny;
        dz += (i - (spec.pellets - 1) / 2) * spec.spread * 0.6;
        const L = Math.hypot(dx, dy, dz); dx /= L; dy /= L; dz /= L;
      }
      this.sky.fireFlak(m.x, m.y, m.z, dx, dy, dz, spec, this.player.fuse, ideal);
    }
  }

  fireHalo(spec, a, m) {
    const ideal = this.rangeLock ? this.rangeLock.range : -1;
    const f = this.sky.fireFlak(m.x, m.y, m.z, a.x, a.y, a.z, spec, this.player.fuse, ideal);
    f.ring = spec;
  }

  fireKinetic(spec, a, m) {
    const p = this.player;
    const sp = spec.spread;
    const dx = a.x + (this.rng() - 0.5) * sp, dy = a.y + (this.rng() - 0.5) * sp, dz = a.z + (this.rng() - 0.5) * sp;
    const L = Math.hypot(dx, dy, dz);
    // Instant trace with a visible tracer: nails are fast enough to be hitscan.
    const hit = this.traceHit(m.x, m.y, m.z, dx / L, dy / L, dz / L, spec.range);
    this.particles.trailPuff(m.x + a.x, m.y + a.y, m.z + a.z, [255, 214, 140], 0.05, 0.07);
    if (hit.enemy) {
      hit.enemy.hurt(spec.damage, this, p.x, p.y);
      this.particles.blood(hit.x, hit.y, hit.z, 6, a.x, a.y);
      this.sound.sfx('hit_flesh', { pan: this.panAt(hit.x, hit.y) });
    } else if (hit.item) {
      this.damageProp(hit.item, spec.damage);
    } else if (hit.wall) {
      this.particles.sparks(hit.x, hit.y, hit.z, 5, 1.6, [255, 220, 170], 5);
      this.sound.sfx('hit_wall', { pan: this.panAt(hit.x, hit.y), vol: 0.5 });
    }
  }

  fireDeadman(spec, a, m) {
    const p = this.player;
    const bx = p.x, by = p.y, bz = spec.altitude;
    this.sound.sfx('deadman_blow');
    const b = this.sky.detonate(bx, by, bz, spec.blastRadius, 0, 'deadman');
    b.deadman = true;
    this.particles.effect({
      x: bx, y: by, z: bz,
      keys: ['nuke0', 'nuke1', 'nuke2', 'nuke3', 'nuke4', 'nuke5', 'nuke6', 'nuke7'],
      fps: 6, size: 70, grow: 30, noFog: true,
      light: { r: 1, g: 0.95, b: 0.85, intensity: 5, radius: 90, decay: 0.7 },
    });
    this.post.flash = 1.5;
    this.post.flashCol = [1, 0.98, 0.94];
    this.post.warp = 1.4;
    this.post.warpCentre = [0.5, 0.4];
    this.shake = 9;
    p.emp = 6.5;
    p.hurt(12, this);
    this.hud.showBanner('DEADMAN', 'THE SKY IS CLEAN. SO ARE YOUR INSTRUMENTS.', 3.2, rgba(255, 240, 200, 255));
  }

  /** Trace a ray against enemies, props and geometry. */
  traceHit(x, y, z, dx, dy, dz, maxDist) {
    const step = 0.12;
    let best = { wall: false, enemy: null, item: null, x, y, z };
    for (let t = 0; t < maxDist; t += step) {
      const px = x + dx * t, py = y + dy * t, pz = z + dz * t;
      if (pz < 0.02 || pz > 1.5 || this.level.blocked(px, py)) {
        return { wall: true, enemy: null, item: null, x: px - dx * step, y: py - dy * step, z: pz };
      }
      for (const e of this.enemies) {
        if (!e.alive || e.state === ST.DYING || e.state === ST.DEAD) continue;
        const dxy = Math.hypot(px - e.x, py - e.y);
        if (dxy < e.radius + 0.1 && pz > e.z && pz < e.z + e.height) {
          return { wall: false, enemy: e, item: null, x: px, y: py, z: pz };
        }
      }
      for (const it of this.items) {
        if (!it.solid || it.taken) continue;
        if (Math.hypot(px - it.x, py - it.y) < 0.34 && pz < 0.9) {
          return { wall: false, enemy: null, item: it, x: px, y: py, z: pz };
        }
      }
    }
    return best;
  }

  damageProp(it, n) {
    if (it.kind !== 'barrel' || it.taken) return;
    it.hp -= n;
    if (it.hp <= 0) {
      it.taken = true;
      this.explodeAt(it.x, it.y, 0.5, 3.4, 58);
      this.sound.sfx('barrel_explode', { pan: this.panAt(it.x, it.y) });
    }
  }

  explodeAt(x, y, z, radius, damage) {
    this.particles.airburst(x, y, z, radius * 0.8, 0);
    this.particles.smoke(x, y, z, 10, radius * 0.3);
    this.shake = Math.max(this.shake, 2.4);
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const d = dist(x, y, e.x, e.y);
      if (d < radius) e.hurt(damage * (1 - d / radius), this, x, y);
    }
    for (const it of this.items) {
      if (it.solid && !it.taken && it.kind === 'barrel' && dist(x, y, it.x, it.y) < radius) {
        // Chained barrels: give the next one a beat so it reads as a chain.
        const lvl = this.level;
        setTimeout(() => { if (this.level === lvl && !it.taken) this.damageProp(it, 999); }, 90);
      }
    }
    const p = this.player;
    const dp = dist(x, y, p.x, p.y);
    if (dp < radius) {
      p.hurt(damage * 0.5 * (1 - dp / radius), this);
      this.hud.damageFrom(Math.atan2(y - p.y, x - p.x));
    }
  }

  alertNearby(x, y, r) {
    for (const e of this.enemies) {
      if (e.state !== ST.IDLE) continue;
      if (dist(x, y, e.x, e.y) < r) e.wake(this);
    }
  }

  panAt(x, y) {
    const p = this.player;
    const rel = wrapAngle(Math.atan2(y - p.y, x - p.x) - p.ang);
    return clamp(Math.sin(rel), -1, 1) * 0.8;
  }
  panOf(e) { return this.panAt(e.x, e.y); }

  projectWorld(x, y, z) {
    return this.rc.project(
      { x: this.player.x, y: this.player.y, z: this.player.z, ang: this.player.ang },
      x, y, z, this.horizon);
  }

  // -------------------------------------------------------------- callbacks

  onFootstep() {
    this.sound.sfx(this.footToggle ? 'footstep_a' : 'footstep_b', { rate: randRange(this.rng, 0.92, 1.1), vol: 0.4 });
    this.footToggle = !this.footToggle;
  }

  onWeaponSwitched(k) { this.hud.popup(WEAPONS[k].name, { size: 11, life: 1.1, color: rgba(255, 186, 64, 255), dy: -10 }); }

  onWarheadLaunched(w) {
    this.sound.sfx('warhead_incoming', { pan: this.panAt(w.x, w.y), vol: 0.55 });
    if (w.type === 'mirv' && !this._mirvSaid) {
      this._mirvSaid = true;
      this.speak('mirv_warning', {}, 'Multiple independent re-entry vehicles. Plural. Enjoy.');
    }
  }

  onMirvSplit(w) {
    this.sound.sfx('mirv_split', { pan: this.panAt(w.x, w.y) });
    this.particles.sparks(w.x, w.y, w.z, 12, 2.2, [255, 200, 120], 8);
  }

  onSmartEvade(w) { this.sound.sfx('smart_evade', { pan: this.panAt(w.x, w.y), vol: 0.6 }); }

  onSmartWarning() { this.speak('smart_warning', {}, 'That one is thinking about you.'); }

  onBusterWarning(w) {
    this.speak('buster_warning', {}, 'A device has selected you personally. Congratulations.');
    this.hud.showBanner('BUNKER BUSTER', 'IT IS COMING FOR YOU', 2.6, rgba(255, 74, 62, 255));
    this.sound.sfx('alarm');
  }

  onShieldBreak(w) {
    this.sound.sfx('ricochet', { pan: this.panAt(w.x, w.y) });
    this.particles.sparks(w.x, w.y, w.z, 14, 2.4, [200, 160, 255], 7);
    this.hud.popup('BLESSED — SHIELD BROKEN', { size: 11, life: 1.4, color: rgba(200, 110, 255, 255) });
  }

  onFlakBurst(b, f) {
    const spec = WEAPONS[f.weapon];
    this.particles.airburst(b.x, b.y, b.z, b.maxR, 0);
    this.sound.sfx('airburst', { pan: this.panAt(b.x, b.y), vol: clamp(1 - dist3(b.x, b.y, b.z, this.player.x, this.player.y, this.player.z) / 140, 0.15, 1) });
    if (f.ring) {
      // The Halo blooms into a ring of secondary bursts at the fuse range.
      const p = this.player;
      const ax = b.x - p.x, ay = b.y - p.y, az = b.z - p.z;
      const L = Math.hypot(ax, ay, az) || 1;
      const fx = ax / L, fy = ay / L, fz = az / L;
      // Two vectors spanning the plane normal to the shot.
      let ux = -fy, uy = fx, uz = 0;
      const ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
      const vx = fy * uz - fz * uy, vy = fz * ux - fx * uz, vz = fx * uy - fy * ux;
      const R = f.ring.ringRadius;
      for (let i = 0; i < f.ring.ringCount; i++) {
        const t = (i / f.ring.ringCount) * TAU;
        const cx = b.x + (ux * Math.cos(t) + vx * Math.sin(t)) * R;
        const cy = b.y + (uy * Math.cos(t) + vy * Math.sin(t)) * R;
        const cz = b.z + (uz * Math.cos(t) + vz * Math.sin(t)) * R;
        const sub = this.sky.detonate(cx, cy, cz, f.ring.blastRadius, 0, 'halo');
        sub.secondary = true;
        this.particles.airburst(cx, cy, cz, f.ring.blastRadius * 0.8, 0);
      }
      this.sound.sfx('halo_sweep');
    }
    // Ground blast: flak that bursts low hurts what's standing there.
    if (b.z < 2.4) {
      const gd = spec ? (spec.groundDamage || 24) : 24;
      for (const e of this.enemies) {
        if (!e.alive) continue;
        const d = dist(b.x, b.y, e.x, e.y);
        if (d < b.maxR) e.hurt(gd * (1 - d / b.maxR), this, b.x, b.y);
      }
      for (const it of this.items) {
        if (it.solid && !it.taken && dist(b.x, b.y, it.x, it.y) < b.maxR) this.damageProp(it, 999);
      }
    }
  }

  onWarheadKilled(w, b, chain) {
    const p = this.player;
    const def = WARHEAD_TYPES[w.type];
    let pts = def.score * chain;
    let label = `${def.score * chain}`;
    let col = rgba(255, 186, 64, 255);

    this.sky.combo = Math.max(this.sky.combo, chain);
    this.sky.comboTimer = 2.4;
    p.skyKills++;

    // The ACE bonus: the fuse landed within 12% of true range.
    if (chain === 1 && b.idealRange > 0 && b.travelled > 0) {
      const err = Math.abs(b.travelled - b.idealRange) / b.idealRange;
      if (err < 0.12) {
        pts = Math.round(pts * 2);
        label = `AIRBURST  ${pts}`;
        col = rgba(126, 232, 128, 255);
        this.sound.sfx('perfect_burst');
        this.speak('perfect_burst', {}, 'Textbook. I hate that.');
      }
    }
    if (chain >= 2) {
      label = `CHAIN ×${chain}   ${pts}`;
      col = chain >= 5 ? rgba(255, 120, 255, 255) : chain >= 3 ? rgba(255, 208, 72, 255) : col;
      this.sound.sfx('chain' + clamp(chain, 2, 5));
      if (chain >= 4) {
        this.hud.setFace('face_grin', 2.2);
        this.post.flash = Math.max(this.post.flash, 0.22);
        if (chain >= 5) this.speak('chain_praise', {}, 'Five at once. You are enjoying this.');
      }
    }
    p.score += pts;
    const pr = this.projectWorld(w.x, w.y, w.z);
    this.hud.popup(label, {
      size: chain >= 3 ? 17 : 13, life: chain >= 3 ? 2.0 : 1.3, color: col,
      x: pr ? pr.x : undefined, y: pr ? pr.y - this.rc.h * 0.42 : 0,
    });
    this.particles.airburst(w.x, w.y, w.z, b.maxR * 0.7, chain);
    if (chain > 1) this.sound.sfx('airburst_small', { pan: this.panAt(w.x, w.y), vol: 0.6 });
    this.shake = Math.max(this.shake, clamp(2.2 - dist3(w.x, w.y, w.z, p.x, p.y, p.z) / 40, 0, 2.2));
  }

  onBlastSweep(b) {
    for (const e of this.enemies) {
      if (!e.alive || b.hit.has('e' + e.id)) continue;
      if (Math.abs(e.z - b.z) > b.r + 1) continue;
      if (dist(b.x, b.y, e.x, e.y) > b.r) continue;
      b.hit.add('e' + e.id);
      e.hurt(b.deadman ? 999 : 42, this, b.x, b.y);
    }
  }

  onBlastHurtPlayer(b, d) {
    if (b.deadman) return;
    const p = this.player;
    const dmg = clamp(26 * (1 - d / (b.r * 0.85)), 4, 30);
    p.hurt(dmg, this);
    this.hud.damageFrom(Math.atan2(b.y - p.y, b.x - p.x));
    this.sound.sfx('player_hurt');
    this.hud.popup('TOO CLOSE', { size: 12, life: 1.2, color: rgba(255, 74, 62, 255) });
  }

  onCityHit(city, w) {
    if (!city.alive) return;
    city.hp--;
    this.skyDome.rebuild(this.sky.cities);
    if (city.alive) {
      // Hurt, not gone. Still on the board, still worth shells.
      this.sound.sfx('city_hit', { vol: 0.8 });
      this.post.flash = 0.45;
      this.post.flashCol = [1, 0.7, 0.42];
      this.shake = 4.2;
      const bx = this.sky.cx + Math.cos(city.az) * 58;
      const by = this.sky.cy + Math.sin(city.az) * 58;
      this.particles.mushroom(bx, by, 3);
      this.hud.showBanner(`${city.name} IS BURNING`, 'ONE MORE AND IT IS GONE', 3.0,
        rgba(255, 132, 46, 255));
      this.hud.setFace('face_hurt', 1.6);
      this.player.score = Math.max(0, this.player.score - 750);
      this.speak('city_burning', { args: [city.name] },
        `${city.name} is on fire. This is within acceptable parameters.`);
      return;
    }
    this.sound.sfx('city_hit');
    this.sound.sfx('city_lost_sting', { delay: 0.4 });
    this.post.flash = 0.85;
    this.post.flashCol = [1, 0.86, 0.62];
    this.post.warp = 1.0;
    this.shake = 7;
    this.hitStop = 0.16;
    // A mushroom cloud on the horizon at the city's bearing.
    const bx = this.sky.cx + Math.cos(city.az) * 58;
    const by = this.sky.cy + Math.sin(city.az) * 58;
    this.particles.mushroom(bx, by, 3);
    const left = this.sky.livingCities().length;
    this.hud.showBanner(`${city.name} IS GONE`, left ? `${left} CITIES REMAIN` : 'NOTHING REMAINS', 3.6,
      rgba(255, 74, 62, 255));
    this.hud.setFace('face_hurt', 2.2);
    this.player.score = Math.max(0, this.player.score - 2000);
    if (left === 0) {
      this.speak('all_cities_lost', {}, 'That was the last one. You are relieved of duty.');
      const at = this.levelIndex;
      setTimeout(() => {
        if (this.state === STATE.PLAY && this.levelIndex === at &&
            !this.sky.livingCities().length) this.gameOver('cities');
      }, 2600);
    } else if (left === 1) {
      this.speak('city_lost_last', { args: [city.name] }, `${city.name} is retired. One left. No pressure.`);
    } else {
      this.speak('city_lost', { args: [city.name, String(left)] },
        `${city.name} has been retired. Please do not be discouraged. ${left} remain.`);
    }
  }

  onCityCooled(city) { this.skyDome.rebuild(this.sky.cities); }


  onStrayImpact(w) {
    // Aimed at the complex rather than a city, which does not make it harmless.
    this.explodeAt(w.x, w.y, 0.7, 6.4, 48);
    this.sound.sfx('barrel_explode', { pan: this.panAt(w.x, w.y) });
    this.sound.sfx('airburst', { pan: this.panAt(w.x, w.y), vol: 0.7 });
    const d = dist(w.x, w.y, this.player.x, this.player.y);
    if (d < 14) {
      this.shake = Math.max(this.shake, 4 * (1 - d / 14));
      this.hud.damageFrom(Math.atan2(w.y - this.player.y, w.x - this.player.x));
    }
  }

  onBusterImpact(w) {
    const p = this.player;
    const d = dist(w.x, w.y, p.x, p.y);
    this.explodeAt(w.x, w.y, 0.8, 7.5, 62);
    this.sound.sfx('city_hit', { vol: 0.7 });
    this.post.flash = 0.6;
    this.shake = 6;
    if (d < 8) this.hud.popup('BUSTER IMPACT', { size: 15, life: 1.6, color: rgba(255, 74, 62, 255) });
  }

  onEnemyAlert(e) {
    this.sound.sfx(e.def.alert || 'wrencher_alert', { pan: this.panOf(e), vol: 0.7 });
  }
  onEnemyWindup(e) {
    if (e.kind === 'priest') this.sound.sfx('priest_chant', { pan: this.panOf(e) });
  }
  onEnemyPain(e) {
    this.sound.sfx('enemy_pain', { pan: this.panOf(e), rate: randRange(this.rng, 0.9, 1.15) });
  }
  onEnemyKilled(e) {
    const p = this.player;
    p.kills++;
    this.levelKills++;
    p.score += e.def.score;
    this.sound.sfx(e.def.boss ? 'boss_death' : 'enemy_die', { pan: this.panOf(e) });
    this.particles.blood(e.x, e.y, e.z + e.height * 0.5, e.def.gib * 3, 0, 0);
    if (e.def.explodes) {
      this.explodeAt(e.x, e.y, 0.5, 4.2, 46);
      this.sound.sfx('barrel_explode', { pan: this.panOf(e) });
    }
    if (e.def.boss) {
      this.bossKilled = true;
      this.hud.showBanner('MUTTER IS SILENT', 'THE ELEVATOR IS UNLOCKED', 5, rgba(126, 232, 128, 255));
      this.speak('boss_death', {}, 'Oh. Oh, that is not... that is not covered by...');
      this.post.flash = 2.2;
      this.shake = 8;
      this.sky.endWave();
      const at = this.levelIndex;
      setTimeout(() => {
        if (this.state === STATE.PLAY && this.levelIndex === at) this.win();
      }, 6500);
    }
  }
  onPlayerHurt(src, how) {
    this.sound.sfx('player_hurt');
    if (src) this.hud.damageFrom(Math.atan2(src.y - this.player.y, src.x - this.player.x));
    this.hud.setFace('face_hurt', 0.9);
    this.shake = Math.max(this.shake, 1.1);
    if (this.player.health < 25 && !this._hurtSaid) {
      this._hurtSaid = true;
      this.speak('player_hurt_bad', {}, 'Your vitals are a formality at this point.');
      setTimeout(() => { this._hurtSaid = false; }, 22000);
    }
    if (this.player.dead) {
      this.sound.sfx('player_die');
      this.speak('player_death', {}, 'The warden has stopped. Thank you for your service.');
    }
  }
  onBoltImpact(b, hitPlayer) {
    if (hitPlayer) return;
    this.particles.sparks(b.x, b.y, b.z, 6, 1.8, [180, 220, 255], 5);
    this.sound.sfx('hit_wall', { pan: this.panAt(b.x, b.y), vol: 0.35 });
  }
  onPriestBless(e) {
    // A Priest shields warheads in the sky. Kill the Priest or waste your shells.
    let n = 0;
    for (const w of this.sky.warheads) {
      if (w.shield > 0 || w.type === 'mine') continue;
      w.shield = 1;
      if (++n >= 3) break;
    }
    if (n) {
      this.sound.sfx('priest_chant', { pan: this.panOf(e) });
      this.hud.popup('WARHEADS BLESSED', { size: 11, life: 1.6, color: rgba(200, 110, 255, 255) });
    }
  }
  onBossAttack(e) {
    const p = this.player;
    this.sound.sfx('boss_roar', { pan: this.panOf(e) });
    // Salvo of bolts plus a fresh warhead: MUTTER fights on both axes.
    for (let i = -2; i <= 2; i++) {
      const a = Math.atan2(p.y - e.y, p.x - e.x) + i * 0.14;
      this.bolts.push(new Bolt(e.x, e.y, e.z + 1.2, Math.cos(a), Math.sin(a), -0.06, 13, e.def.damage, e));
    }
    if (this.sky.warheads.length < 9 && this.rng() < 0.6) {
      const t = this.rng() < 0.35 ? 'buster' : this.rng() < 0.5 ? 'mirv' : 'screamer';
      const w = this.sky.spawnWarhead(t, 1.05);
      this.onWarheadLaunched(w);
    }
  }

  spawnBolt(e, p) {
    const dz = (p.z - (e.z + e.def.eye));
    const dx = p.x - e.x, dy = p.y - e.y;
    const L = Math.hypot(dx, dy, dz) || 1;
    this.bolts.push(new Bolt(e.x, e.y, e.z + e.def.eye, dx / L, dy / L, dz / L, 14,
      e.def.damage * this.diff.enemyDamage, e));
  }

  spawnFlame(e, p) {
    const a = Math.atan2(p.y - e.y, p.x - e.x);
    for (let i = 0; i < 10; i++) {
      const s = randRange(this.rng, 2, 6.5);
      const sp = randRange(this.rng, -0.22, 0.22);
      this.particles.spawn({
        x: e.x, y: e.y, z: e.z + 0.5,
        vx: Math.cos(a + sp) * s, vy: Math.sin(a + sp) * s, vz: randRange(this.rng, 0.2, 1.4),
        life: randRange(this.rng, 0.24, 0.55), size: randRange(this.rng, 0.16, 0.4),
        r: 255, g: randRange(this.rng, 110, 200) | 0, b: 40, drag: 2.2, grav: -1.2, fadePow: 1.6, grow: 0.5,
      });
    }
  }
}
