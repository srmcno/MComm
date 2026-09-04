// game.js - the machine that runs NUKEHAUS: state, level flow, and every
// callback the sky war and the enemies fire back into.

import { Raycaster, LightGrid } from '../engine/raycaster.js';
import { Sky } from '../engine/skybox.js';
import { Level } from './level.js';
import { Player, EYE_HEIGHT, FUSE_MIN, FUSE_MAX } from './player.js';
import { Enemy, Bolt, PipeBomb, Acid, ENEMY_TYPES, ST } from './entities.js';
import { Particles } from './particles.js';
import { SkyWar, City, WARHEAD_TYPES, CITY_MAX_HP } from './sky.js';
import { WEAPONS, WEAPON_ORDER, AMMO_FLAK, AMMO_NAIL, AMMO_CHARGE, AMMO_BOMB, BOOT, weaponBySlot } from './weapons.js';
import { Hud } from '../ui/hud.js';
import { Text, blitFrame, fillRectBuf, addRectBuf } from '../ui/text.js';
import { parseLevelDef } from '../engine/assets.js';
import { clamp, damp, lerp, dist, dist3, wrapAngle, makeRng, randRange, commas, TAU } from '../core/math.js';
import { rgba } from '../core/pixels.js';
import { recordRun, bestFor } from '../core/scores.js';
import { Radio, LEVEL_STORY, BRICK_LINES, EXES, MUTTER_MUTANT, MUTTER_BRICK_FILE, SPEAKERS } from './story.js';

export const STATE = {
  TITLE: 'title', BRIEF: 'brief', PLAY: 'play', PAUSE: 'pause',
  INTERMISSION: 'intermission', GAMEOVER: 'gameover', VICTORY: 'victory',
};

const SKY_PALETTES = ['dusk', 'ash', 'night', 'furnace', 'terminal'];

// What the three exposure settings on the title screen actually change.
// Score threshold at which MUTTER rebuilds a city, straight out of 1980.
export const BONUS_CITY_EVERY = 15000;

/**
 * How hard the walls leak per level. Mutants are not in the map data; they
 * arrive on this schedule, out of sight, and the mix gets worse as you descend.
 */
const BREACH_SCHEDULE = [
  { first: 999, gapMin: 99, gapMax: 99, cap: 0, pack: 1, kinds: ['ghoul'] },
  { first: 26, gapMin: 22, gapMax: 40, cap: 5, pack: 2, kinds: ['ghoul', 'ghoul', 'stalker'] },
  { first: 20, gapMin: 18, gapMax: 33, cap: 6, pack: 2, kinds: ['ghoul', 'stalker', 'howler'] },
  { first: 15, gapMin: 14, gapMax: 27, cap: 8, pack: 3, kinds: ['ghoul', 'stalker', 'howler', 'gorger'], maw: 70 },
  { first: 11, gapMin: 12, gapMax: 22, cap: 9, pack: 3, kinds: ['ghoul', 'stalker', 'howler', 'gorger'], maw: 40 },
];

export const DIFFICULTY = [
  { name: 'CLERICAL',   warheadSpeed: 0.80, enemyDamage: 0.55, enemyHp: 0.85,
    waveCount: 0.75, maxAliveDelta: -1, blast: 1.18, health: 125, regen: 1.8,
    breachGap: 1.7, breachCap: 0.55 },
  { name: 'WARDEN',     warheadSpeed: 1.00, enemyDamage: 1.00, enemyHp: 1.00,
    waveCount: 1.00, maxAliveDelta: 0,  blast: 1.00, health: 100, regen: 1.0,
    breachGap: 1.0, breachCap: 1.0 },
  { name: 'LAST SHIFT', warheadSpeed: 1.28, enemyDamage: 1.45, enemyHp: 1.20,
    waveCount: 1.30, maxAliveDelta: 2,  blast: 0.90, health: 100, regen: 0.5,
    breachGap: 0.72, breachCap: 1.4 },
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
    get lastLine() { return v.lastLine; },
    get lastVoice() { return v.lastVoice; },
  };
}

export class Game {
  constructor(art, sound, vox, input, post, text) {
    this.art = art;
    // Tools and tests hand us a minimal input stub; fill in what the game calls.
    if (input && !input.rumble) input.rumble = () => {};
    if (input && !input.firing) input.firing = function () { return this.isDown('fire'); };
    if (input && input.padActive === undefined) input.padActive = false;
    if (input && input.lookScale === undefined) input.lookScale = 1;
    this.sound = safeSound(sound);
    this.vox = safeVox(vox);
    this.voxLines = (vox && vox.LINES) || {};
    this.input = input;
    this.post = post;
    this.text = text || new Text();
    this.rc = new Raycaster();
    this.lights = new LightGrid();
    this.hud = new Hud(this.text);
    this.radio = new Radio(this);
    this.player = new Player();
    this.particles = new Particles();
    this.sky = new SkyWar(this);
    this.skyDome = new Sky(art.vm);
    this.enemies = [];
    this.items = [];
    this.bolts = [];
    this.bombs = [];
    this.acids = [];
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
    this._recorded = false;
    this.beatBest = false;
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
    this.bombs.length = 0;
    this.acids.length = 0;
    this.decals.length = 0;
    this.sky.warheads.length = 0;
    this.sky.flak.length = 0;
    this.sky.blasts.length = 0;
    this.sky.active = false;
    this.levelTime = 0;
    this.waveQueue = [];
    this.triggersFired = new Set();
    this.bossKilled = false;
    this.rescuePending = false;
    this.staticLights = [];
    this.hitStop = 0;

    const p = this.player;
    p.x = parsed.start.x; p.y = parsed.start.y; p.z = EYE_HEIGHT;
    p.ang = parsed.start.dir; p.pitch = 0; p.vx = 0; p.vy = 0;
    p.keys = [false, false, false];
    p.dead = false;
    p.emp = 0;
    p.health = Math.max(p.health, 45);

    // Level one stays clean until its siege; the leak announces itself there.
    const bs = BREACH_SCHEDULE[Math.min(this.levelIndex, BREACH_SCHEDULE.length - 1)];
    const D = this.diff;
    this.breach = {
      ...bs, t: 0, next: undefined, mawDone: false,
      first: bs.first * (D.breachGap || 1),
      gapMin: bs.gapMin * (D.breachGap || 1),
      gapMax: bs.gapMax * (D.breachGap || 1),
      cap: Math.max(1, Math.round(bs.cap * (D.breachCap || 1))),
    };
    if (bs.cap === 0) this.breach.cap = 0;
    this.hazards = [];

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
    // Ilsa leaves a satchel on the second floor. The map data predates the
    // bombs, so drop one in near the start rather than editing five levels.
    if (this.levelIndex === 1 && !this.player.owned.pipebomb) {
      const lv = this.level;
      let spot = null, bestD = 1e9;
      for (let y = 1; y < lv.H - 1 && !spot; y++) {
        for (let x = 1; x < lv.W - 1; x++) {
          const i = y * lv.W + x;
          if (lv.wall[i] || lv.propBlock[i] || lv.trigger[i] || lv.exit[i]) continue;
          const d = dist(x + 0.5, y + 0.5, parsed.start.x, parsed.start.y);
          if (d < 4 || d > 16) continue;
          if (!lv.lineOfSight(parsed.start.x, parsed.start.y, x + 0.5, y + 0.5)) continue;
          if (Math.abs(d - 9) < bestD) { bestD = Math.abs(d - 9); spot = [x + 0.5, y + 0.5]; }
        }
      }
      if (spot) {
        this.items.push({ kind: 'weapon', x: spot[0], y: spot[1], z: 0,
          weapon: 'pipebomb', taken: false, bob: 0 });
      }
    }

    this.enemyTotal = this.enemies.length;
    this.levelKills = 0;
    this.secretTotal = secretTotal;
    this.treasureTotal = treasureTotal;

    this.hud.popups.length = 0;
    this.hud.mapOpen = false;
    this.radio.reset();
    this.storyQueued = false;
    this.mutantSeen = false;
    this.distractTimer = randRange(this.rng, 26, 46);
    this.fileTimer = randRange(this.rng, 55, 90);
    this.setState(STATE.BRIEF);
    this.briefT = 0;
  }

  setState(s) {
    this.state = s;
    if (s === STATE.PLAY) {
      this.sound.music(this.sky.active ? 'siege' : this.corridorTrack(),
        { fadeIn: 1.2, intensity: this.sky.intensity });
    }
  }

  /** Which corridor track fits right now. */
  corridorTrack() {
    // 'hunt' once the walls have started leaking; the map's own track until then.
    const mutantsAbout = this.enemies.some((e) => e.alive && e.def.mutant);
    if (mutantsAbout) return 'hunt';
    return this.level.def.music || 'prowl';
  }

  /** Swap the corridor track when the floor's character changes. */
  updateMusic(dt) {
    if (this.sky.active) return;
    const want = this.corridorTrack();
    if (want !== this._corridorTrack) {
      this._corridorTrack = want;
      this.sound.music(want, { fadeIn: 2.4 });
    }
  }

  nextLevel() {
    if (this.levelIndex + 1 >= this.totalLevels) { this.win(); return; }
    this.totalScoreCarry = this.player.score;
    this.setState(STATE.INTERMISSION);
    this.interT = 0;
    this.interStats = this.buildStats();
    this.sound.stopMusic(0.5);
    this.sound.music('hero', { fadeIn: 0.8 });
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
    this.recordThisRun(true);
    this.radio.reset();
    // The last exchange of the game.
    this.radio.say('ilsa', 'ilsa_rescued',
      "You actually did it. I had a spreadsheet on how you'd die and none of the rows said this.", { priority: 9 });
    this.radio.say('brick', 'brick_victory',
      "Told you, doc. Now about that dinner.", { priority: 9, delay: 0.5 });
    this.radio.say('ilsa', 'ilsa_victory',
      "One dinner. Somewhere with tablecloths. And you are not allowed to bring the boot.", { priority: 9, delay: 0.5 });
    this.sound.stopMusic(0.6);
    this.sound.music('victory', { fadeIn: 0.2 });
    // ...then his theme, because he will not shut up about this.
    const at = this.levelIndex;
    setTimeout(() => {
      if (this.state === STATE.VICTORY && this.levelIndex === at) {
        this.sound.music('hero', { fadeIn: 2.0 });
      }
    }, 15000);
    this.speak('victory', {}, 'You have won. There is nothing left to win.');
  }

  gameOver(reason) {
    if (this.state === STATE.GAMEOVER) return;
    this.recordThisRun(false);
    this.setState(STATE.GAMEOVER);
    this.overT = 0;
    this.overReason = reason;
    this.sound.stopMusic(0.5);
    this.sound.music('gameover', { fadeIn: 0.3 });
    this.sound.sfx('player_die');
    this.speak(reason === 'cities' ? 'all_cities_lost' : 'game_over', {},
      reason === 'cities' ? 'All six are gone. You may stand down.' : 'The warden is no longer with us.');
  }

  /** Commit the run to the cabinet's memory, once. */
  recordThisRun(won) {
    if (this._recorded) return;
    this._recorded = true;
    this.previousBest = bestFor(this.difficulty);
    this.scores = recordRun({
      difficulty: this.difficulty, score: this.player.score,
      cities: this.sky.livingCities().length, level: this.levelIndex + 1, won,
    });
    this.beatBest = this.player.score > this.previousBest;
  }

  // ---------------------------------------------------------------- speech

  /**
   * Speak as a named character. The announcer module owns the written lines and
   * the voice characterisation; this passes through the fallback text so the
   * subtitle is right even before a line exists.
   */
  speakAs(voice, key, fallbackText, args) {
    const lines = this.voxLines;
    let text = fallbackText || '';
    const entry = lines[key];
    if (entry) text = Array.isArray(entry) ? entry[(this.rng() * entry.length) | 0] : entry;
    if (args) for (const a of args) text = text.replace('%s', a);
    this.sound.duck(0.45, 1.8);
    let dur = 0;
    try { dur = this.vox.sayLine(key, { voice, args }) || 0; } catch { dur = 0; }
    // The announcer chose a variant; caption that one, not another roll.
    let spoken = dur ? (this.vox.lastLine || text) : text;
    if (!dur && text) { try { dur = this.vox.say(text, { voice }) || 0; } catch { dur = 0; } }
    if (args && spoken) for (const a of args) spoken = spoken.replace('%s', a);
    const caption = String(spoken || '').replace(/\{[^}]*\}/g, (m) => m.slice(1, -1).replace(/[0-9]/g, '').toLowerCase());
    this.lastSpoken = { voice, text: caption };
    if (this.subtitlesOn && caption) this.hud.say(caption, Math.max(2.6, dur || 3.2));
    return dur;
  }

  /** Brick, talking to himself, which he does constantly. */
  brick(key, poolOrText) {
    const pool = typeof poolOrText === 'string' ? null : poolOrText;
    const text = pool ? this.radio.pick(key, pool) : poolOrText;
    if (this.radio.current || this.radio.queue.length) return;   // never talk over the plot
    this.radio.say('brick', key, text, { priority: -2 });
  }

  speak(key, opts = {}, fallbackText = '') {
    const lines = this.voxLines;
    let text = fallbackText;
    const entry = lines[key];
    if (entry) text = Array.isArray(entry) ? entry[(Math.random() * entry.length) | 0] : entry;
    if (opts.args) {
      for (const a of opts.args) text = text.replace('%s', a);
    }
    this.sound.duck(0.4, 1.6);
    const dur = this.vox.sayLine ? this.vox.sayLine(key, opts) : 0;
    let spoken = dur ? (this.vox.lastLine || text) : text;
    if (!dur && text) this.vox.say(text, opts);
    if (opts.args && spoken) for (const a of opts.args) spoken = String(spoken).replace('%s', a);
    const caption = String(spoken || '').replace(/\{[^}]*\}/g, (m) => m.slice(1, -1).replace(/[0-9]/g, '').toLowerCase());
    if (this.subtitlesOn && caption) this.hud.say(caption, Math.max(2.6, (dur || 3.2)));
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
      if (this.levelIndex === 0) {
        this.speak('boot', {}, 'Good morning. Bunker Sieben is operating normally. Please ignore the sirens.');
      }
      // The level's opening exchange, queued behind the boot line.
      const beats = LEVEL_STORY[this.levelIndex] || [];
      for (const b of beats) {
        this.radio.say(b.speaker, b.key, b.text, { priority: 3, delay: 0.4 });
      }
      this.storyQueued = true;
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
    this.radio.update(dt);
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
      // Right stick look is rate-based (degrees per second), unlike the mouse
      // which is displacement, so it has to be scaled by dt to be frame-rate
      // independent. Fine-aim on the left trigger slows it for fuse work.
      const padScale = (input.lookScale === undefined ? 1 : input.lookScale);
      let lx = input.mouseDX + (input.padLookX || 0) * 1180 * dt * padScale;
      let ly = input.mouseDY + (input.padLookY || 0) * 620 * dt * padScale;
      if (!input.locked && input.mouseMoved && !input.padActive) {
        // Pointer lock can be refused — an embedded frame, a browser setting, a
        // user who said no. Steer from the cursor's offset from centre instead,
        // so the game is playable either way.
        const dz = 0.07;
        const shape = (v) => {
          const a = Math.abs(v);
          return a < dz ? 0 : Math.sign(v) * Math.pow((a - dz) / (1 - dz), 1.7);
        };
        lx += shape(clamp((input.mouseX - 0.5) * 2, -1, 1)) * 1150 * dt;
        ly += shape(clamp((input.mouseY - 0.5) * 2, -1, 1)) * 620 * dt;
      }
      p.applyLook(lx, ly, this.sens, this.invertY, this.rc.projY, this.rc.h);
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
      if (input.justPressed('weapNext')) { if (p.cycleWeapon(1)) this.sound.sfx('weapon_switch'); }
      if (input.justPressed('weapPrev')) { if (p.cycleWeapon(-1)) this.sound.sfx('weapon_switch'); }
      if (input.justPressed('kick')) this.tryKick();
      if (input.justPressed('bomb')) this.tryBomb();
      if (input.justPressed('use')) this.tryUse();
      // Tolerate a minimal input object (tools and tests supply one).
      if (input.firing ? input.firing() : input.isDown('fire')) this.tryFire();
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
    for (let i = this.bombs.length - 1; i >= 0; i--) {
      this.bombs[i].update(dt, this);
      if (!this.bombs[i].alive) this.bombs.splice(i, 1);
    }
    for (let i = this.acids.length - 1; i >= 0; i--) {
      this.acids[i].update(dt, this);
      if (!this.acids[i].alive) this.acids.splice(i, 1);
    }
    this.updateBreaches(dt);
    this.updateHazards(dt);
    this.updateBoss(dt);
    this.sky.update(dt, this);
    this.particles.update(dt, lv);
    this.checkBonusCity();
    this.radio.update(dt);
    this.updateBanter(dt);
    this.updateMusic(dt);
    this.updateVitals(dt);
    this.updateItems(dt);
    this.updateTriggers(dt);
    this.updateWave(dt);
    lv.markVisited(p.x, p.y, 5);

    // Idle chatter in the quiet stretches.
    this.idleTaunt -= dt;
    if (this.idleTaunt <= 0 && !this.sky.active && !this.vox.busy && !this.radio.current) {
      this.idleTaunt = randRange(this.rng, 55, 95);
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

  /**
   * Mutants are not placed in the level data; they come through the walls while
   * you are in there. The schedule ramps with depth, they only ever appear out
   * of sight, and they announce themselves by tearing through a vent.
   */
  updateBreaches(dt) {
    if (this.player.dead || !this.breach) return;
    this.breach.t += dt;
    if (this.breach.next === undefined) this.breach.next = this.breach.first;
    // One miniboss per floor on the deep levels, announced properly.
    if (this.breach.maw && !this.breach.mawDone && this.breach.t > this.breach.maw) {
      this.breach.mawDone = true;
      if (this.spawnBreach('maw')) {
        this.sound.sfx('maw_roar');
        this.shake = Math.max(this.shake, 2.4);
        this.radio.say('ilsa', 'ilsa_mutant_warning',
          "Something big just came through the wall. Do not let it corner you.", { priority: 2 });
        this.hud.showBanner('SOMETHING LARGE', 'IT CAME THROUGH THE WALL', 3.0, rgba(150, 240, 140, 255));
      }
    }
    if (this.breach.t < this.breach.next) return;
    // Never let the floor become a slaughterhouse; cap what is alive at once.
    const aliveMutants = this.enemies.filter((e) => e.alive && e.def.mutant).length;
    // A siege already drops its own crew onto the deck. Breaching at full rate
    // on top of that turns the set piece into a scrum.
    const siege = this.sky.active;
    this.breach.next = this.breach.t +
      randRange(this.rng, this.breach.gapMin, this.breach.gapMax) * (siege ? 1.8 : 1);
    if (aliveMutants >= (siege ? Math.ceil(this.breach.cap / 2) : this.breach.cap)) return;
    const pack = 1 + ((this.rng() * this.breach.pack) | 0);
    let spawned = 0;
    for (let i = 0; i < pack; i++) {
      const kind = this.breach.kinds[(this.rng() * this.breach.kinds.length) | 0];
      if (this.spawnBreach(kind)) spawned++;
    }
    if (spawned && !this.mutantSeen) {
      this.mutantSeen = true;
      this.radio.say('ilsa', 'ilsa_mutant_warning',
        "Movement on your floor and it is not personnel. Whatever the leak did to them, they are fast and they are hungry.",
        { priority: 2, once: true });
      this.radio.say('mutter', 'mutter_mutant', this.radio.pick('mutant', MUTTER_MUTANT), { priority: 0, delay: 0.4 });
    }
  }

  spawnBreach(kind) {
    const lv = this.level;
    const p = this.player;
    const def = ENEMY_TYPES[kind];
    if (!def) return false;
    let best = null, bestD = 1e9;
    for (let tries = 0; tries < 90; tries++) {
      const x = 1 + (this.rng() * (lv.W - 2)) | 0;
      const y = 1 + (this.rng() * (lv.H - 2)) | 0;
      const i = y * lv.W + x;
      if (lv.wall[i] || lv.propBlock[i]) continue;
      const cx = x + 0.5, cy = y + 0.5;
      const d = dist(cx, cy, p.x, p.y);
      if (d < 7 || d > 30) continue;
      if (lv.lineOfSight(p.x, p.y, cx, cy)) continue;   // never pop in on camera
      if (d < bestD) { bestD = d; best = [cx, cy]; }
      if (bestD < 14) break;
    }
    if (!best) return false;
    const e = new Enemy(kind, best[0], best[1]);
    e.hp = e.maxHp = Math.round(e.maxHp * this.diff.enemyHp);
    e.state = ST.ALERT;
    this.enemies.push(e);
    this.enemyTotal++;
    this.particles.dust(best[0], best[1], 0.3, 18);
    this.sound.sfx(def.alert || 'ghoul_alert', { pan: this.panAt(best[0], best[1]), vol: 0.55 });
    return true;
  }

  /** Lingering ground hazards: a burst gorger leaves a cloud you do not want. */
  updateHazards(dt) {
    if (!this.hazards) this.hazards = [];
    const p = this.player;
    for (let i = this.hazards.length - 1; i >= 0; i--) {
      const h = this.hazards[i];
      h.t += dt;
      if (h.t >= h.life) { this.hazards.splice(i, 1); continue; }
      h.puff -= dt;
      if (h.puff <= 0) {
        h.puff = 0.12;
        this.particles.smoke(h.x + (this.rng() - 0.5) * h.r, h.y + (this.rng() - 0.5) * h.r,
          0.2 + this.rng() * 0.5, 2, 0.8, [96, 150, 90]);
      }
      const d = dist(h.x, h.y, p.x, p.y);
      if (d < h.r) {
        h.tick = (h.tick || 0) + dt;
        if (h.tick > 0.5) {
          h.tick = 0;
          p.hurt(h.dps * 0.5, this);
          this.sound.sfx('acid_burn', { vol: 0.5 });
          this.hud.damageFrom(Math.atan2(h.y - p.y, h.x - p.x));
        }
      }
      for (const e of this.enemies) {
        if (!e.alive || e.def.mutant) continue;
        if (dist(h.x, h.y, e.x, e.y) < h.r) e.hurt(h.dps * dt, this, h.x, h.y);
      }
    }
  }

  /** The two running gags, on their own timers so they never crowd the plot. */
  updateBanter(dt) {
    if (this.player.dead) return;
    this.distractTimer -= dt;
    this.fileTimer -= dt;
    const quiet = !this.radio.current && !this.radio.queue.length && !this.vox.busy;
    if (this.distractTimer <= 0 && quiet) {
      this.distractTimer = randRange(this.rng, 55, 95);
      this.radio.distract();
      return;
    }
    if (this.fileTimer <= 0 && quiet) {
      this.fileTimer = randRange(this.rng, 80, 130);
      this.radio.say('mutter', 'mutter_brick_file', this.radio.pick('file', MUTTER_BRICK_FILE), { priority: -1 });
    }
  }

  /** Heartbeat near death, and the low-health warning cadence. */
  updateVitals(dt) {
    const p = this.player;
    if (p.dead) return;
    const frac = p.health / p.maxHealth;
    if (frac > 0.3) { this._beat = 0; return; }
    this._beat = (this._beat || 0) - dt;
    if (this._beat <= 0) {
      const fast = frac < 0.15;
      this._beat = fast ? 0.52 : 0.92;
      this.sound.sfx(fast ? 'heartbeat_fast' : 'heartbeat', { vol: 0.5 });
    }
  }

  /** Kill streaks, which exist purely so Brick can be smug about them. */
  bumpStreak(n = 1) {
    const p = this.player;
    p.streak += n;
    p.streakTimer = 4.2;
    if (p.streak === 3 || p.streak === 6 || p.streak === 10 || p.streak === 16) {
      const bonus = p.streak * 150;
      p.score += bonus;
      this.sound.sfx('combo_up', { rate: 1 + Math.min(0.6, p.streak * 0.05) });
      this.hud.popup(`${p.streak} IN A ROW  +${bonus}`, {
        size: 14, life: 1.6, color: rgba(255, 208, 72, 255),
      });
      if (p.streak >= 6) this.hud.setFace('face_grin', 2.0);
      if (p.streak >= 10) this.brick('brick_chain', BRICK_LINES.chain);
    }
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
          this.radio.say('brick', 'brick_pickup_weapon', this.radio.pick('weap', BRICK_LINES.weapon), { priority: 1 });
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
    // Point the way once the core is open, so the rescue is never a hunt.
    if (this.rescuePending && !this._rescueHinted) {
      this._rescueHinted = true;
      this.hud.mapOpen = false;
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
    this.radio.say('brick', 'brick_wave_start', this.radio.pick('wavestart', BRICK_LINES.wave_start), { priority: 1, delay: 0.6 });
    this.radio.say('ilsa', 'ilsa_wave_incoming',
      "Flight inbound. Fuse first, aim second. The ring is your range, Hardigan, not a decoration.",
      { priority: 1, delay: 0.4, once: true });
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
      this._corridorTrack = this.corridorTrack();
      this.sound.music(this._corridorTrack, { fadeIn: 2.2 });
      const bonus = 1500 + cleared * 900 + this.sky.bestChain * 400;
      this.player.score += bonus;
      this.hud.showBanner('SKY CLEAR', `+${commas(bonus)}   ${cleared} CITIES STANDING`, 3.4,
        rgba(126, 232, 128, 255));
      this.speak('wave_clear', {}, 'The sky is empty. For now.');
      this.radio.say('brick', 'brick_wave_clear', this.radio.pick('waveclear', BRICK_LINES.wave_clear), { priority: 1, delay: 0.5 });
    }
  }

  spawnDeckEnemy(kind) {
    const lv = this.level;
    // The deeper you go, the less of the deck crew is still staff.
    const mutantChance = [0, 0.25, 0.45, 0.6, 0.7][Math.min(this.levelIndex, 4)];
    if (this.rng() < mutantChance) {
      const pool = (this.breach && this.breach.kinds) || ['ghoul'];
      kind = pool[(this.rng() * pool.length) | 0];
    }
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

  // ------------------------------------------------------------- the boot

  /**
   * The Boot. No ammo, no reload, and the only weapon that moves things.
   * A hard kick into a wall finishes what it started.
   */
  tryKick() {
    const p = this.player;
    if (!p.canKick()) return;
    p.kickCooldown = BOOT.refire;
    p.kickAnim = 0.34;
    p.kick = Math.max(p.kick, 6);
    this.shake = Math.max(this.shake, BOOT.shakeAmount);
    this.sound.sfx('kick_swing');
    this.input.rumble(0.35, 0.2, 90);

    const ca = Math.cos(p.ang), sa = Math.sin(p.ang);
    let best = null, bestScore = Infinity;
    for (const e of this.enemies) {
      if (!e.alive || e.state === ST.DEAD) continue;
      const dx = e.x - p.x, dy = e.y - p.y;
      const d = Math.hypot(dx, dy);
      if (d > BOOT.range + e.radius) continue;
      if (Math.abs(e.z - p.z) > 1.3) continue;
      const cosA = (dx * ca + dy * sa) / (d || 1);
      if (cosA < Math.cos(BOOT.arc)) continue;
      const score = d - cosA * 1.5;
      if (score < bestScore) { bestScore = score; best = e; }
    }

    if (best) {
      const lethal = best.hp <= BOOT.damage;
      best.shove(best.x - p.x, best.y - p.y, BOOT.knockback, BOOT.liftKick);
      const died = best.hurt(BOOT.damage, this, p.x, p.y);
      this.sound.sfx(died ? 'punt' : 'kick_hit', { pan: this.panOf(best) });
      this.particles.blood(best.x, best.y, best.z + best.height * 0.55, died ? 14 : 6, ca, sa);
      this.particles.effect({
        x: p.x + ca * 1.2, y: p.y + sa * 1.2, z: p.z - 0.1,
        keys: ['kick_impact0', 'kick_impact1', 'kick_impact2'], fps: 18, size: 1.4, alpha: 0.85,
      });
      this.hitStop = Math.max(this.hitStop, died ? 0.1 : 0.05);
      this.input.rumble(0.85, 0.6, 160);
      this.hud.popup(died ? 'PUNTED' : 'BOOTED', {
        size: died ? 15 : 12, life: 1.1, color: rgba(255, 208, 72, 255),
      });
      if (died) { this.player.score += 250; this.brick('brick_kick', 'Stay down. Stay very down.'); }
      return;
    }

    // Nothing to kick? Try the architecture, then a barrel, then a pipe bomb.
    for (const it of this.items) {
      if (it.taken || !it.solid) continue;
      const d = dist(p.x, p.y, it.x, it.y);
      if (d > BOOT.range + 0.4) continue;
      const cosA = ((it.x - p.x) * ca + (it.y - p.y) * sa) / (d || 1);
      if (cosA < Math.cos(BOOT.arc)) continue;
      if (it.kind === 'barrel') { this.damageProp(it, 999); return; }
    }
    for (const b of this.bombs) {
      const d = dist(p.x, p.y, b.x, b.y);
      if (d < BOOT.range && b.settled) {
        // Punting a live pipe bomb is exactly as good an idea as it sounds.
        b.settled = false;
        b.vx = ca * 13; b.vy = sa * 13; b.vz = 5.5;
        this.sound.sfx('punt');
        this.hud.popup('BOMB PUNTED', { size: 12, life: 1.1, color: rgba(255, 132, 46, 255) });
        return;
      }
    }
    this.tryUse();
    this.sound.sfx('kick_wall', { vol: 0.5 });
  }

  // ----------------------------------------------------------- pipe bombs

  tryBomb() {
    const p = this.player;
    const spec = WEAPONS.pipebomb;
    if (this.bombs.length) { this.blowBombs(); return; }
    if (!p.owned.pipebomb || p.ammo[AMMO_BOMB] < 1) {
      if (p.owned.pipebomb) { this.sound.sfx('dryfire'); this.hud.popup('NO BOMBS', { size: 11, life: 0.9, color: rgba(255, 74, 62, 255) }); }
      return;
    }
    if (this.bombs.length >= spec.maxLive) return;
    p.ammo[AMMO_BOMB]--;
    p.kick = Math.max(p.kick, 4);
    const a = p.aimVector(this.rc.projY);
    this.bombs.push(new PipeBomb(
      p.x + a.x * 0.4, p.y + a.y * 0.4, p.z - 0.05,
      a.x, a.y, a.z, spec.throwSpeed, spec, this));
    this.sound.sfx('pipebomb_throw');
    this.input.rumble(0.25, 0.15, 70);
  }

  blowBombs() {
    if (!this.bombs.length) return;
    const list = this.bombs.slice();
    this.bombs.length = 0;
    for (const b of list) { b.alive = false; this.detonateBomb(b); }
  }

  detonateBomb(b) {
    const spec = b.spec;
    this.sound.sfx('pipebomb_blow', { pan: this.panAt(b.x, b.y) });
    this.explodeAt(b.x, b.y, Math.max(0.25, b.z), spec.blastRadius, spec.damage);
    this.particles.airburst(b.x, b.y, Math.max(0.4, b.z), spec.blastRadius * 0.7, 0);
    this.particles.smoke(b.x, b.y, b.z + 0.2, 12, 0.8);
    this.shake = Math.max(this.shake, 3.4);
    this.input.rumble(0.9, 0.7, 220);
    // A bomb bursting in the sky counts as flak: it can catch a warhead.
    const blast = this.sky.detonate(b.x, b.y, Math.max(0.4, b.z), spec.blastRadius, 0, 'pipebomb');
    blast.idealRange = -1;
  }

  // ---------------------------------------------------------------- firing

  tryUse() {
    const p = this.player;
    const r = this.level.tryUse(p.x, p.y, p.ang, p.keys, (x, y) => {
      p.secretsFound++;
      p.score += 1500;
      this.hud.popup('SECRET FOUND  +1500', { size: 13, life: 2.0, color: rgba(255, 208, 72, 255) });
      this.hud.setFace('face_grin', 2.0);
      this.brick('brick_secret', BRICK_LINES.secret);
      this.radio.say('mutter', 'secret_found', 'You found the room I was saving.', { priority: 0, delay: 0.5 });
    });
    if (r === 'opened') this.sound.sfx('door_open');
    else if (r === 'locked') {
      this.sound.sfx('door_locked');
      this.hud.popup('LOCKED — KEYCARD REQUIRED', { size: 11, life: 1.4, color: rgba(255, 74, 62, 255) });
    }
  }

  tryFire() {
    const p = this.player;
    if (p.spec.kind === 'throw') {
      if (p.cooldown > 0) return;
      p.cooldown = p.spec.refire;
      this.tryBomb();
      return;
    }
    if (!p.canFire()) {
      if (p.cooldown <= 0 && this.ammoDry !== this.time) {
        this.ammoDry = this.time;
        this.sound.sfx('dryfire');
        if (p.ammoFor(p.weapon) < p.spec.cost) {
          this.hud.popup('DRY', { size: 12, life: 0.8, color: rgba(255, 74, 62, 255) });
          this.brick('brick_dry', BRICK_LINES.dry);
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
    this.particles.sparks(muzzle.x, muzzle.y, muzzle.z, 5, 0.6, [255, 200, 120], 4);
    if (spec.kind !== 'kinetic' || this.rng() < 0.3) {
      this.particles.smoke(muzzle.x + a.x * 0.2, muzzle.y + a.y * 0.2, muzzle.z + a.z * 0.2,
        spec.kind === 'kinetic' ? 1 : 3, 0.35, [104, 100, 96]);
    }
    this.input.rumble(clamp(spec.shakeAmount * 0.28, 0.08, 0.75),
      clamp(spec.shakeAmount * 0.2, 0.05, 0.5), 70);

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
    // The precision bonus is for dialling the fuse yourself. Auto-ranging is
    // there to keep you alive in a busy sky, not to pay you for it.
    const ideal = (this.rangeLock && !this.player.autoFuse) ? this.rangeLock.range : -1;
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
    const ideal = (this.rangeLock && !this.player.autoFuse) ? this.rangeLock.range : -1;
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
      const killed = hit.enemy.hurt(spec.damage, this, p.x, p.y);
      this.hud.hitMark(killed);
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
        if (d < b.maxR) {
          if (e.hurt(gd * (1 - d / b.maxR), this, b.x, b.y)) this.hud.hitMark(true);
          e.shove(e.x - b.x, e.y - b.y, 5 * (1 - d / b.maxR));
        }
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
    this.bumpStreak();

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
        if (chain >= 5) {
          this.brick('brick_chain', BRICK_LINES.chain);
          this.radio.say('ilsa', 'ilsa_chain_tip',
            "That is what the chain is for. Do that again.", { priority: 0, delay: 0.4, once: true });
        }
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
      this.exFile(city, 0.6);
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
    this.radio.say('brick', 'brick_city_lost', this.radio.pick('citylost', BRICK_LINES.city_lost), { priority: 2, delay: 0.5 });
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

  /**
   * MUTTER has read the warden's personnel file and considers the romantic
   * history relevant operational context. It is not wrong, exactly.
   */
  exFile(city, delay = 0) {
    const ex = EXES[city.index];
    if (!ex) return;
    this.radio.say('mutter', 'mutter_ex_file',
      `${ex.city} is where ${ex.name} lives. ${ex.note}`, { priority: 0, delay, once: true });
  }


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
    this.bumpStreak();
    this.sound.sfx(e.def.die || (e.def.boss ? 'boss_death' : 'enemy_die'), { pan: this.panOf(e) });
    this.particles.blood(e.x, e.y, e.z + e.height * 0.5, e.def.gib * 3, 0, 0);
    this.addDecal(e.x, e.y, e.def.mutant ? 'gore' : 'blood');
    if (e.def.gib >= 5) this.gib(e);
    if (this.rng() < 0.30) {
      this.brick(e.def.mutant ? 'brick_kill_mutant' : 'brick_kill',
        e.def.mutant ? BRICK_LINES.kill_mutant : BRICK_LINES.kill);
    }
    if (e.def.explodes) {
      this.explodeAt(e.x, e.y, 0.5, 4.2, 46);
      this.sound.sfx('barrel_explode', { pan: this.panOf(e) });
    }
    if (e.def.bursts) {
      // It has been swelling the whole fight. Now it stops.
      this.sound.sfx('gorger_burst', { pan: this.panOf(e) });
      this.gib(e);
      this.explodeAt(e.x, e.y, 0.4, 3.6, 30);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        this.addDecal(e.x + dx, e.y + dy, 'gore');
      }
      if (!this.hazards) this.hazards = [];
      this.hazards.push({ x: e.x, y: e.y, r: 3.1, dps: 16, life: 9, t: 0, puff: 0 });
      this.shake = Math.max(this.shake, 2.6);
    }
    if (e.def.miniboss) {
      this.hud.showBanner('IT STOPPED', 'WHATEVER THAT WAS', 2.6, rgba(150, 240, 140, 255));
      this.player.score += 1500;
      this.brick('brick_kill_mutant', BRICK_LINES.kill_mutant);
    }
    if (e.def.boss) {
      this.bossKilled = true;
      this.rescuePending = true;
      this.hud.showBanner('MUTTER IS SILENT', 'THE CORE IS OPEN — GET HER OUT', 5, rgba(126, 232, 128, 255));
      this.speak('boss_death', {}, 'Oh. Oh, that is not... that is not covered by...');
      this.post.flash = 1.1;
      this.shake = 8;
      this.sky.endWave();
      this.radio.say('ilsa', 'ilsa_almost_there',
        "The bulkhead just released. Hardigan, I can hear the door. Come and get me.",
        { priority: 4, delay: 1.2 });
      this.radio.say('brick', 'brick_boss_taunt',
        "On my way, doc. Don't touch anything.", { priority: 4, delay: 0.4 });
    }
  }
  onPlayerHurt(src, how) {
    this.sound.sfx('player_hurt');
    this.player.streak = 0;
    this.input.rumble(0.55, 0.4, 160);
    if (how === 'melee' || how === 'chomp' || how === 'lunge') this.hud.splatter(3);
    if (this.rng() < 0.16) this.brick('brick_hurt', BRICK_LINES.hurt);
    if (src) this.hud.damageFrom(Math.atan2(src.y - this.player.y, src.x - this.player.x));
    this.hud.setFace('face_hurt', 0.9);
    this.shake = Math.max(this.shake, 1.1);
    if (this.player.health < 25 && !this._hurtSaid) {
      this._hurtSaid = true;
      this.radio.say('brick', 'brick_low_health', this.radio.pick('lowhp', BRICK_LINES.low_health), { priority: 1 });
      this.radio.say('ilsa', 'ilsa_low_health',
        "Hardigan, your vitals are a mess. There is a medical cache on this floor. Use it.", { priority: 1, delay: 0.3 });
      setTimeout(() => { this._hurtSaid = false; }, 26000);
    }
    if (this.player.dead) {
      this.sound.sfx('player_die');
      this.radio.say('brick', 'brick_death', this.radio.pick('death', BRICK_LINES.death), { priority: 5 });
      this.radio.say('ilsa', 'ilsa_death', "Brick? Brick. Answer me. ...Damn it.", { priority: 5, delay: 0.4 });
    }
  }
  /** Stain the floor. Cheap, permanent for the level, and it accumulates. */
  addDecal(x, y, kind = 'blood') {
    const lv = this.level;
    if (!lv || !this.art.decalCount) return;
    const i = lv.idx(x, y);
    if (i < 0 || i >= lv.decal.length || lv.wall[i]) return;
    const names = this.art.decalNames;
    let pool;
    if (kind === 'gore') pool = names.filter((n) => n.startsWith('gore_pool'));
    else if (kind === 'scorch') pool = names.filter((n) => n === 'scorch');
    else if (kind === 'acid') pool = names.filter((n) => n.startsWith('acid'));
    else pool = names.filter((n) => n.startsWith('blood'));
    if (!pool.length) pool = names;
    const pick = pool[(this.rng() * pool.length) | 0];
    const idx = this.art.decalIndex.get(pick);
    if (idx === undefined) return;
    // A bigger stain wins; otherwise leave what is already there.
    const cur = lv.decal[i];
    if (cur >= 0 && names[cur].startsWith('gore_pool') && !pick.startsWith('gore_pool')) return;
    lv.decal[i] = idx;
    lv.decalAge[i] = 0;
  }

  onEnemySlammed(e, speed) {
    // Thrown into a wall hard enough to matter.
    const extra = clamp((speed - 9) * 9, 8, 70);
    this.sound.sfx('splat', { pan: this.panOf(e) });
    this.particles.blood(e.x, e.y, e.z + e.height * 0.5, 16, 0, 0);
    this.addDecal(e.x, e.y, 'gore');
    const died = e.hurt(extra, this, e.x, e.y);
    if (died) {
      this.player.score += 300;
      this.hud.popup('WALL', { size: 13, life: 1.1, color: rgba(255, 132, 46, 255) });
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
  /**
   * MUTTER fights in three phases and spends the middle one hiding behind its
   * own staff, which is exactly the kind of thing it would do.
   */
  updateBoss(dt) {
    const b = this.enemies.find((e) => e.def.boss && e.alive);
    if (!b) { this.bossShut = false; return; }
    if (b.phase === undefined) { b.phase = 1; b.shielded = false; b.adds = []; }
    const frac = b.hp / b.maxHp;
    const want = frac > 0.66 ? 1 : frac > 0.33 ? 2 : 3;
    if (want !== b.phase) {
      b.phase = want;
      this.sound.sfx('boss_hurt');
      this.shake = Math.max(this.shake, 4);
      if (want === 2) {
        // Shutters down. It will not take a scratch until its help is dead.
        b.shielded = true;
        b.adds = [];
        for (let i = 0; i < 4; i++) {
          if (this.spawnBreach(['ghoul', 'stalker', 'howler'][i % 3])) {
            b.adds.push(this.enemies[this.enemies.length - 1]);
          }
        }
        this.hud.showBanner('SHUTTERS DOWN', 'IT IS HIDING BEHIND THE STAFF', 3.2, rgba(255, 74, 62, 255));
        this.radio.say('ilsa', 'ilsa_boss_warning',
          "It has armoured over. Kill what it sent and it has to open again.", { priority: 3 });
      } else if (want === 3) {
        this.hud.showBanner('IT IS AFRAID', 'FINISH IT', 3.0, rgba(255, 208, 72, 255));
        this.radio.say('brick', 'brick_boss_taunt',
          "There it is. There's the fear. I love this part.", { priority: 3 });
      }
    }
    if (b.shielded) {
      b.adds = b.adds.filter((a) => a && a.alive);
      if (!b.adds.length) {
        b.shielded = false;
        this.sound.sfx('boss_hurt');
        this.post.flash = Math.max(this.post.flash, 0.4);
        this.hud.showBanner('SHUTTERS UP', 'HIT IT', 2.2, rgba(126, 232, 128, 255));
      }
    }
    this.bossShut = b.shielded;
  }

  onBossAttack(e) {
    const p = this.player;
    this.sound.sfx('boss_roar', { pan: this.panOf(e) });
    const phase = e.phase || 1;
    // Salvo of bolts plus fresh warheads: MUTTER fights on both axes at once.
    const spread = phase >= 3 ? 4 : 2;
    for (let i = -spread; i <= spread; i++) {
      const a = Math.atan2(p.y - e.y, p.x - e.x) + i * (phase >= 3 ? 0.11 : 0.14);
      this.bolts.push(new Bolt(e.x, e.y, e.z + 1.2, Math.cos(a), Math.sin(a), -0.06,
        13 + phase * 2, e.def.damage * this.diff.enemyDamage, e));
    }
    if (phase >= 3) {
      // It starts spitting too, because dignity is gone.
      for (let i = -1; i <= 1; i++) {
        const a = Math.atan2(p.y - e.y, p.x - e.x) + i * 0.3;
        this.acids.push(new Acid(e.x, e.y, e.z + 1.4, Math.cos(a), Math.sin(a), 0.16, 13,
          10 * this.diff.enemyDamage, e));
      }
    }
    const cap = 6 + phase * 2;
    if (this.sky.warheads.length < cap && this.rng() < 0.4 + phase * 0.15) {
      const t = this.rng() < 0.35 ? 'buster' : this.rng() < 0.5 ? 'mirv' : 'screamer';
      const w = this.sky.spawnWarhead(t, 1 + phase * 0.06);
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

  spawnAcid(e, p) {
    const dz = (p.z - (e.z + e.def.eye));
    const dx = p.x - e.x, dy = p.y - e.y;
    const flat = Math.hypot(dx, dy) || 1;
    // Lead the arc a little so a spit at range is not a free hit.
    const t = flat / 15;
    const L = Math.hypot(dx, dy, dz) || 1;
    this.acids.push(new Acid(e.x, e.y, e.z + e.def.eye,
      dx / L, dy / L, (dz / L) + t * 0.25, 15, e.def.damage * this.diff.enemyDamage, e));
  }

  onAcidSplash(a, hitPlayer) {
    this.sound.sfx('acid_hit', { pan: this.panAt(a.x, a.y) });
    this.particles.effect({
      x: a.x, y: a.y, z: Math.max(0.1, a.z),
      keys: ['acid_splash0', 'acid_splash1', 'acid_splash2', 'acid_splash3'],
      fps: 16, size: 0.9, additive: true,
      light: { r: 0.4, g: 1.0, b: 0.5, intensity: 0.9, radius: 4, decay: 4 },
    });
    for (let i = 0; i < 8; i++) {
      const ang = this.rng() * TAU;
      this.particles.spawn({
        x: a.x, y: a.y, z: Math.max(0.1, a.z),
        vx: Math.cos(ang) * randRange(this.rng, 0.5, 3), vy: Math.sin(ang) * randRange(this.rng, 0.5, 3),
        vz: randRange(this.rng, 0.6, 2.6),
        life: randRange(this.rng, 0.3, 0.9), size: randRange(this.rng, 0.05, 0.12),
        r: 120, g: 255, b: 140, drag: 2, grav: 7, fadePow: 1.3,
      });
    }
    if (!hitPlayer) this.addDecal(a.x, a.y, 'acid');
  }

  onMawAttack(e) {
    const p = this.player;
    this.sound.sfx('maw_roar', { pan: this.panOf(e) });
    // A spray of acid across an arc, so standing still is not an option.
    const base = Math.atan2(p.y - e.y, p.x - e.x);
    for (let i = -2; i <= 2; i++) {
      const a = base + i * 0.17;
      const dz = (p.z - (e.z + e.def.eye)) / Math.max(2, dist(e.x, e.y, p.x, p.y));
      this.acids.push(new Acid(e.x, e.y, e.z + e.def.eye,
        Math.cos(a), Math.sin(a), dz + 0.12, 14, e.def.damage * this.diff.enemyDamage * 0.7, e));
    }
  }

  /** Body comes apart. Gore is the point. */
  gib(e) {
    const n = Math.min(16, 4 + e.def.gib);
    for (let i = 0; i < n; i++) {
      const a = this.rng() * TAU;
      const sp = randRange(this.rng, 1.5, 6.5);
      this.particles.spawn({
        x: e.x, y: e.y, z: e.z + e.height * randRange(this.rng, 0.2, 0.9),
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, vz: randRange(this.rng, 1.5, 5.5),
        life: randRange(this.rng, 0.7, 1.6), size: randRange(this.rng, 0.06, 0.16),
        r: randRange(this.rng, 130, 195) | 0, g: randRange(this.rng, 18, 44) | 0, b: 28,
        drag: 0.9, grav: 11, additive: false, hard: true, fadePow: 0.4, bounce: 0.25,
      });
    }
    this.particles.effect({
      x: e.x, y: e.y, z: e.z + e.height * 0.5,
      keys: ['gib_burst0', 'gib_burst1', 'gib_burst2', 'gib_burst3', 'gib_burst4', 'gib_burst5'],
      fps: 20, size: e.height * 2.2, additive: false, alpha: 0.95,
    });
    this.sound.sfx('gib', { pan: this.panOf(e), rate: randRange(this.rng, 0.85, 1.2) });
    // Close enough and it goes on the lens.
    const d = dist(e.x, e.y, this.player.x, this.player.y);
    if (d < 5.5 && this.level.lineOfSight(this.player.x, this.player.y, e.x, e.y)) {
      this.hud.splatter(clamp(Math.round(7 - d), 2, 7));
    }
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
