// audio-check.js — drives src/audio/synth.js against a fake Web Audio API.
//
// Web Audio does not exist in node, so this file implements just enough of it to
// record every node created, every connection, every param automation and every
// start/stop, and to scream if any of them ever receives a NaN or a time in the
// past. Run: node tools/audio-check.js
//
// Assertions:
//   a  every SFX name schedules at least one source
//   b  no SFX name throws
//   c  after panic() every source ever created has been stopped
//   d  live (created-but-not-disconnected) node count stays bounded
//   e  no NaN reaches any AudioParam, start() or stop()
//   f  every scheduled time is >= currentTime

import { Sound, SFX_NAMES as EXPORTED_NAMES, TRACK_NAMES as EXPORTED_TRACKS } from '../src/audio/synth.js';

/* ------------------------------------------------------------------ stub */

const LOG = { nan: [], past: [], nodes: [], srcs: [], created: 0, started: 0, connects: 0, autos: 0 };

// Chromium throws TypeError on a non-finite AudioParam value, and `undefined`
// coerces to NaN, so anything that is not a finite number is a real crash.
function chk(where, t, val, ctx) {
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    if (LOG.nan.length < 40) LOG.nan.push(`${where}: value=${val}`);
    return true;
  }
  if (t !== undefined) {
    if (typeof t !== 'number' || !Number.isFinite(t)) {
      if (LOG.nan.length < 40) LOG.nan.push(`${where}: time=${t}`);
    } else if (t < ctx.currentTime - 1e-9) {
      if (LOG.past.length < 40) {
        LOG.past.push(`${where}: t=${t.toFixed(4)} < now=${ctx.currentTime.toFixed(4)}`);
      }
    }
  }
}

class Param {
  constructor(ctx, owner, name, v) {
    this._ctx = ctx; this._o = owner; this._nm = name; this._v = v;
    this.events = 0; this.inputs = 0;
  }
  get value() { return this._v; }
  set value(v) {
    // mirror Chromium: a non-finite assignment is a TypeError, not a silent NaN
    if (chk(`${this._o._type}.${this._nm}.value`, undefined, v, this._ctx)) {
      throw new TypeError(`The provided float value is non-finite (${this._o._type}.${this._nm}=${v})`);
    }
    this._v = v;
  }
  _e(kind, v, t) {
    if (chk(`${this._o._type}.${this._nm}.${kind}`, t, v, this._ctx)) {
      throw new TypeError(`non-finite value in ${this._o._type}.${this._nm}.${kind}: ${v}`);
    }
    this.events++; LOG.autos++;
    if (typeof v === 'number' && Number.isFinite(v)) this._v = v;
    return this;
  }
  setValueAtTime(v, t) { return this._e('setValueAtTime', v, t); }
  linearRampToValueAtTime(v, t) { return this._e('linearRamp', v, t); }
  exponentialRampToValueAtTime(v, t) {
    if (v === 0) LOG.nan.push(`${this._o._type}.${this._nm}: exponentialRamp to 0`);
    return this._e('expoRamp', v, t);
  }
  setTargetAtTime(v, t, c) { chk(`${this._o._type}.${this._nm}.tc`, undefined, c, this._ctx); return this._e('setTarget', v, t); }
  setValueCurveAtTime(curve, t, d) {
    chk(`${this._o._type}.${this._nm}.curve`, t, d, this._ctx);
    if (!(curve instanceof Float32Array)) LOG.nan.push(`${this._nm}: curve is not Float32Array`);
    else for (let i = 0; i < curve.length; i++) {
      if (!Number.isFinite(curve[i])) { LOG.nan.push(`${this._nm}: curve[${i}]=${curve[i]}`); break; }
    }
    this.events++; LOG.autos++;
    return this;
  }
  cancelScheduledValues(t) { chk(`${this._nm}.cancel`, t, 0, this._ctx); return this; }
  cancelAndHoldAtTime(t) { chk(`${this._nm}.cancelHold`, t, 0, this._ctx); return this; }
}

let NODE_ID = 0;

class Node {
  constructor(ctx, type) {
    this._ctx = ctx; this._type = type; this._id = NODE_ID++;
    this._out = []; this._disconnected = false;
    this.channelCount = 2;
    LOG.nodes.push(this);
  }
  connect(d) {
    if (!d) throw new Error(`${this._type}.connect(undefined)`);
    this._out.push(d); this._disconnected = false; LOG.connects++;
    if (d instanceof Param) d.inputs++;
    return d;
  }
  disconnect() { this._out.length = 0; this._disconnected = true; }
}

class Src extends Node {
  constructor(ctx, type) {
    super(ctx, type);
    this.onended = null;
    this._started = false; this._stopped = false;
    this._t0 = 0; this._t1 = Infinity; this._fired = false;
    LOG.srcs.push(this); LOG.created++;
  }
  start(t = this._ctx.currentTime, off) {
    if (this._started) throw new Error(`${this._type}.start() twice`);
    if (!Number.isFinite(t)) { LOG.nan.push(`${this._type}.start: time=${t}`); throw new TypeError('non-finite start time'); }
    chk(`${this._type}.start`, t, 0, this._ctx);
    if (off !== undefined) chk(`${this._type}.start.offset`, undefined, off, this._ctx);
    this._started = true; this._t0 = t; LOG.started++;
  }
  stop(t = this._ctx.currentTime) {
    if (!this._started) throw new Error(`${this._type}.stop() before start()`);
    if (!Number.isFinite(t)) { LOG.nan.push(`${this._type}.stop: time=${t}`); throw new TypeError('non-finite stop time'); }
    chk(`${this._type}.stop`, t, 0, this._ctx);
    this._stopped = true;
    this._t1 = Math.max(t, this._t0);
  }
}

class Ctx {
  constructor(sr = 48000) {
    this.sampleRate = sr; this.currentTime = 0; this.state = 'running';
    this.destination = new Node(this, 'destination');
    this._pend = [];
  }
  resume() { this.state = 'running'; return Promise.resolve(); }
  suspend() { return Promise.resolve(); }
  close() { return Promise.resolve(); }

  createGain() { const n = new Node(this, 'gain'); n.gain = new Param(this, n, 'gain', 1); return n; }
  createOscillator() {
    const n = new Src(this, 'osc'); n.type = 'sine';
    n.frequency = new Param(this, n, 'frequency', 440);
    n.detune = new Param(this, n, 'detune', 0);
    return n;
  }
  createBufferSource() {
    const n = new Src(this, 'bufsrc'); n.buffer = null; n.loop = false;
    n.loopStart = 0; n.loopEnd = 0;
    n.playbackRate = new Param(this, n, 'playbackRate', 1);
    n.detune = new Param(this, n, 'detune', 0);
    return n;
  }
  createBiquadFilter() {
    const n = new Node(this, 'biquad'); n.type = 'lowpass';
    n.frequency = new Param(this, n, 'frequency', 350);
    n.Q = new Param(this, n, 'Q', 1);
    n.gain = new Param(this, n, 'gain', 0);
    n.detune = new Param(this, n, 'detune', 0);
    return n;
  }
  createStereoPanner() { const n = new Node(this, 'panner'); n.pan = new Param(this, n, 'pan', 0); return n; }
  createConvolver() { const n = new Node(this, 'convolver'); n.buffer = null; n.normalize = true; return n; }
  createDynamicsCompressor() {
    const n = new Node(this, 'comp');
    for (const k of ['threshold', 'knee', 'ratio', 'attack', 'release']) n[k] = new Param(this, n, k, 0);
    return n;
  }
  createWaveShaper() {
    const n = new Node(this, 'shaper');
    n.oversample = 'none';
    let cur = null;
    Object.defineProperty(n, 'curve', {
      get: () => cur,
      set: (c) => {
        if (c !== null) {
          if (!(c instanceof Float32Array)) LOG.nan.push('waveshaper curve is not a Float32Array');
          else for (let i = 0; i < c.length; i++) {
            if (!Number.isFinite(c[i])) { LOG.nan.push(`waveshaper curve[${i}]=${c[i]}`); break; }
          }
        }
        cur = c;
      },
    });
    return n;
  }
  createDelay(max = 1) {
    const n = new Node(this, 'delay');
    n.delayTime = new Param(this, n, 'delayTime', 0);
    n._max = max;
    return n;
  }
  createBuffer(ch, len, sr) {
    if (!Number.isFinite(len) || len <= 0) throw new Error(`createBuffer bad length ${len}`);
    const data = [];
    for (let i = 0; i < ch; i++) data.push(new Float32Array(len));
    return {
      numberOfChannels: ch, length: len, sampleRate: sr, duration: len / sr,
      getChannelData: (i) => data[i],
    };
  }

  /** Advance the clock and fire onended for anything whose stop time has passed. */
  tick(dt) {
    this.currentTime += dt;
    const now = this.currentTime;
    for (let i = 0; i < LOG.srcs.length; i++) {
      const s = LOG.srcs[i];
      if (s._fired || !s._started) continue;
      if (s._t1 <= now) {
        s._fired = true;
        const cb = s.onended;
        if (cb) { try { cb({ target: s }); } catch (e) { fail(`onended threw: ${e.message}`); } }
      }
    }
    // sources that ended a long time ago can be forgotten, keeps the loop cheap
    if (LOG.srcs.length > 4000) LOG.srcs = LOG.srcs.filter((s) => !s._fired);
  }
}

/* --------------------------------------------------------------- harness */

let PASS = 0, FAIL = 0;
const FAILS = [];
function ok(cond, label, extra = '') {
  if (cond) { PASS++; console.log(`  PASS  ${label}${extra ? '  ' + extra : ''}`); }
  else { FAIL++; FAILS.push(label); console.log(`  FAIL  ${label}${extra ? '  ' + extra : ''}`); }
}
function fail(msg) { FAIL++; FAILS.push(msg); console.log(`  FAIL  ${msg}`); }

const liveNodes = () => LOG.nodes.reduce((a, n) => a + (n._disconnected ? 0 : 1), 0);

const SFX_NAMES = [
  'flak_fire', 'flak_arm', 'airburst', 'airburst_small', 'nailer_fire', 'halo_fire',
  'halo_sweep', 'deadman_arm', 'deadman_blow', 'pistol_fire', 'dryfire', 'reload',
  'weapon_switch',
  'hit_wall', 'hit_flesh', 'ricochet', 'barrel_explode', 'door_open', 'door_close',
  'door_locked', 'secret_found', 'pickup_health', 'pickup_ammo', 'pickup_key',
  'pickup_treasure', 'pickup_weapon', 'elevator', 'roof_open', 'alarm',
  'wrencher_alert', 'wrencher_swing', 'sparker_fire', 'bellows_flame', 'wasp_buzz',
  'priest_chant', 'enemy_pain', 'enemy_die', 'boss_roar', 'boss_hurt', 'boss_death',
  'warhead_launch', 'warhead_incoming', 'mirv_split', 'smart_evade', 'city_hit',
  'city_lost_sting', 'wave_start', 'wave_clear', 'chain2', 'chain3', 'chain4',
  'chain5', 'perfect_burst',
  'ui_move', 'ui_select', 'ui_back', 'ui_start', 'score_tick', 'countdown',
  'player_hurt', 'player_die', 'heartbeat', 'footstep_a', 'footstep_b',
  // --- expansion: mutants, gore, melee, radio, feel ---
  'ghoul_alert', 'ghoul_attack', 'ghoul_pain', 'ghoul_die',
  'gorger_alert', 'gorger_attack', 'gorger_pain', 'gorger_burst',
  'howler_alert', 'howler_spit', 'howler_pain', 'howler_die',
  'stalker_alert', 'stalker_charge', 'stalker_attack', 'stalker_pain', 'stalker_die',
  'maw_roar', 'maw_hurt', 'maw_die',
  'gib', 'splat', 'bone_crack', 'acid_hit', 'acid_burn',
  'kick_swing', 'kick_hit', 'kick_wall', 'punt',
  'pipebomb_throw', 'pipebomb_land', 'pipebomb_beep', 'pipebomb_blow',
  'radio_open', 'radio_close', 'radio_static', 'radio_beep', 'objective', 'story_sting',
  'combo_up', 'taunt_hit', 'heartbeat_fast', 'slowmo_in', 'slowmo_out',
];

/** Names that shipped in the first version. None of them may ever disappear. */
const SHIPPED = [
  'flak_fire', 'flak_arm', 'airburst', 'airburst_small', 'nailer_fire', 'halo_fire',
  'halo_sweep', 'deadman_arm', 'deadman_blow', 'pistol_fire', 'dryfire', 'reload',
  'weapon_switch', 'hit_wall', 'hit_flesh', 'ricochet', 'barrel_explode', 'door_open',
  'door_close', 'door_locked', 'secret_found', 'pickup_health', 'pickup_ammo',
  'pickup_key', 'pickup_treasure', 'pickup_weapon', 'elevator', 'roof_open', 'alarm',
  'wrencher_alert', 'wrencher_swing', 'sparker_fire', 'bellows_flame', 'wasp_buzz',
  'priest_chant', 'enemy_pain', 'enemy_die', 'boss_roar', 'boss_hurt', 'boss_death',
  'warhead_launch', 'warhead_incoming', 'mirv_split', 'smart_evade', 'city_hit',
  'city_lost_sting', 'wave_start', 'wave_clear', 'chain2', 'chain3', 'chain4',
  'chain5', 'perfect_burst', 'ui_move', 'ui_select', 'ui_back', 'ui_start',
  'score_tick', 'countdown', 'player_hurt', 'player_die', 'heartbeat',
  'footstep_a', 'footstep_b',
];
const SHIPPED_TRACKS = ['title', 'prowl', 'siege', 'boss', 'victory', 'gameover'];
const TRACK_NAMES = ['title', 'prowl', 'siege', 'boss', 'victory', 'gameover', 'hunt', 'hero'];

async function main() {
  console.log('NUKEHAUS audio-check — stub Web Audio driver\n');

  // ---- no-throw before init -------------------------------------------------
  const cold = new Sound();
  let coldOk = true;
  try {
    cold.sfx('airburst'); cold.sfx('nope_not_a_sound');
    cold.music('siege'); cold.stopMusic(); cold.update(0.016);
    cold.duck(); cold.panic(); cold.setMaster(0.5); cold.setSfxVol(0.5); cold.setMusicVol(0.5);
  } catch (e) { coldOk = false; console.log('    ' + e.stack.split('\n')[0]); }
  ok(coldOk, 'no method throws before init()');
  ok(cold.ready === false && cold.ctx === null && cold.sfxBus === null, 'cold getters are inert');

  // ---- init -----------------------------------------------------------------
  const ctx = new Ctx();
  const S = new Sound();
  await S.init(ctx);
  ok(S.ready === true, 'init() reports ready');
  ok(S.ctx === ctx, 'ctx getter returns the context');
  ok(S.sfxBus && S.sfxBus._type === 'gain', 'sfxBus is a GainNode (vox.js target)');
  const graphNodes = liveNodes();
  const b1 = S.sfxBus;
  await S.init(ctx);
  ok(S.sfxBus === b1 && liveNodes() === graphNodes, 'init() is idempotent', `${graphNodes} persistent nodes`);
  // The game shipped calling these by name; losing one is a broken build.
  const goneS = SHIPPED.filter((n) => !EXPORTED_NAMES.includes(n));
  const goneT = SHIPPED_TRACKS.filter((n) => !EXPORTED_TRACKS.includes(n));
  ok(goneS.length === 0, 'every shipped SFX name still exists', goneS.join(','));
  ok(goneT.length === 0, 'every shipped track still exists', goneT.join(','));

  const hasComp = LOG.nodes.some((n) => n._type === 'comp');
  const hasConv = LOG.nodes.filter((n) => n._type === 'convolver').length;
  ok(hasComp, 'master compressor present');
  ok(hasConv >= 2, 'two reverb impulse responses', `${hasConv} convolvers`);

  // ---- (a)(b) every name ----------------------------------------------------
  console.log('\n-- SFX coverage --');
  const missing = [], threw = [], silent = [];
  for (const name of SFX_NAMES) {
    const before = LOG.started;
    try { S.sfx(name, { vol: 0.9, rate: 1, pan: 0.2, delay: 0 }); } catch (e) { threw.push(`${name}: ${e.message}`); }
    const after = LOG.started;
    if (after <= before) silent.push(name);
    ctx.tick(0.4);
    S.update(0.4);
  }
  ok(threw.length === 0, '(b) no SFX name throws', threw.join(' | '));
  ok(silent.length === 0, '(a) every SFX name schedules a source', silent.join(','));
  // unknown names and hostile options must be silent, not fatal
  let junkOk = true;
  try {
    S.sfx('does_not_exist');
    S.sfx('airburst', { vol: NaN, rate: NaN, pan: NaN, delay: NaN });
    S.sfx('airburst', { vol: Infinity, rate: -5, pan: 99, delay: -3 });
    S.sfx('nailer_fire', { vol: 'loud', rate: null, pan: {}, delay: [] });
    S.sfx(null); S.sfx(undefined); S.sfx(123);
    // inherited Object members must not be reachable as sound names
    for (const n of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) S.sfx(n);
    for (const n of ['constructor', 'toString', '__proto__']) S.music(n);
  } catch (e) { junkOk = false; console.log('    ' + e.stack.split('\n')[0]); }
  ok(junkOk, 'unknown names + NaN/garbage opts are silent no-ops');
  ok(S._tracks.length === 0, 'Object members are not reachable as track names');
  const extra = SFX_NAMES.filter((n) => !EXPORTED_NAMES.includes(n));
  const surplus = EXPORTED_NAMES.filter((n) => !SFX_NAMES.includes(n));
  ok(extra.length === 0, 'every name the game needs is registered', extra.join(','));
  ok(surplus.length === 0, 'no unreachable extras in the registry', surplus.join(','));
  ok(EXPORTED_TRACKS.length === TRACK_NAMES.length, 'exported track list matches', EXPORTED_TRACKS.join(','));
  ctx.tick(6); S.update(6);

  // ---- music: 60 simulated seconds per track --------------------------------
  console.log('\n-- music (60 s at 60 fps per track) --');
  const peaks = {};
  for (const track of TRACK_NAMES) {
    const startNodes = liveNodes();
    S.music(track, { fadeIn: 1.2, intensity: 0.5 });
    let peak = 0, steps = 0;
    const before = LOG.created;
    for (let f = 0; f < 3600; f++) {
      ctx.tick(1 / 60);
      S.update(1 / 60);
      if (track === 'siege' && f % 600 === 0) S.music('siege', { intensity: f / 3600 });
      const lv = liveNodes();
      if (lv > peak) peak = lv;
    }
    steps = LOG.created - before;
    peaks[track] = peak;
    S.stopMusic(0.6);
    for (let f = 0; f < 120; f++) { ctx.tick(1 / 60); S.update(1 / 60); }
    ok(steps > 40, `${track}: sequencer produced voices`, `${steps} sources, peak live nodes ${peak}`);
    ok(liveNodes() <= startNodes + 4, `${track}: torn down after stopMusic()`, `${liveNodes()} live`);
  }

  // ---- cross-fade -----------------------------------------------------------
  console.log('\n-- cross-fade --');
  S.music('prowl', { fadeIn: 0.8 });
  for (let f = 0; f < 60; f++) { ctx.tick(1 / 60); S.update(1 / 60); }
  S.music('siege', { fadeIn: 0.8, intensity: 0.9 });
  let both = false;
  for (let f = 0; f < 30; f++) {
    ctx.tick(1 / 60); S.update(1 / 60);
    if (S._tracks.length === 2) both = true;
  }
  ok(both, 'two tracks overlap during the cross-fade');
  for (let f = 0; f < 180; f++) { ctx.tick(1 / 60); S.update(1 / 60); }
  ok(S._tracks.length === 1 && S._tracks[0].name === 'siege', 'old track is dropped after the fade');
  const busGains = S._tracks.map((t) => t.bus.gain.value);
  ok(busGains.every((g) => g <= 1.05), 'no track is left above unity', busGains.join(','));

  // ---- (d) the shooter stress test -----------------------------------------
  console.log('\n-- 60 s of prowl + 500 nailer_fire + 300 gib + 200 stalker_attack --');
  S.panic();
  ctx.tick(0.5); S.update(0.5);
  S.music('prowl', { fadeIn: 0.5 });
  let stressPeak = 0, fired = 0, gibs = 0, claws = 0;
  for (let f = 0; f < 3600; f++) {
    ctx.tick(1 / 60); S.update(1 / 60);
    if (fired < 500 && f % 6 === 0) { S.sfx('nailer_fire', { pan: (f % 7) / 7 - 0.5 }); fired++; }
    if (gibs < 300 && f % 11 === 0) { S.sfx('gib', { rate: 0.8 + (f % 5) * 0.1 }); gibs++; }
    if (claws < 200 && f % 17 === 0) { S.sfx('stalker_attack', { pan: 0.3 }); claws++; }
    const lv = liveNodes();
    if (lv > stressPeak) stressPeak = lv;
  }
  ok(fired === 500 && gibs === 300 && claws === 200, 'fired the whole magazine',
    `${fired} nailer, ${gibs} gib, ${claws} stalker_attack`);
  ok(liveNodes() < 200, '(d) live nodes bounded after the run', `${liveNodes()} live, peak ${stressPeak}`);
  ok(stressPeak < 200, '(d) live nodes bounded throughout the run', `peak ${stressPeak}`);

  // pathological: an entire magazine inside one frame
  let burstPeak = 0;
  for (let i = 0; i < 500; i++) S.sfx('nailer_fire');
  for (let i = 0; i < 300; i++) S.sfx('gib');
  burstPeak = liveNodes();
  for (let i = 0; i < 40; i++) S.sfx('airburst');
  for (let i = 0; i < 30; i++) S.sfx('gorger_burst');
  const burst2 = liveNodes();
  ok(burstPeak < 200 && burst2 < 200, 'voice cap survives a single-frame burst',
    `500 nailer + 300 gib -> ${burstPeak}, +40 airburst +30 gorger_burst -> ${burst2}`);
  for (let f = 0; f < 600; f++) { ctx.tick(1 / 60); S.update(1 / 60); }

  // ---- ducking + volumes ----------------------------------------------------
  console.log('\n-- mix control --');
  const duckParam = S._duck.gain;
  const before = duckParam.events;
  S.duck(0.5, 1.0);
  ok(duckParam.events > before, 'duck() automates the music duck gain');
  S.setMaster(0.4); S.setMusicVol(0.3); S.setSfxVol(0.6);
  ok(S._master.gain.value <= 1 && S._music.gain.value <= 1 && S._sfx.gain.value <= 1, 'volume setters clamp to 0..1');
  S.setMaster(NaN); S.setMusicVol(Infinity); S.setSfxVol(-9);
  ok(Number.isFinite(S._master.gain.value) && S._sfx.gain.value >= 0, 'volume setters reject NaN/out-of-range');

  // ---- (c) panic ------------------------------------------------------------
  console.log('\n-- panic --');
  S.music('boss', { fadeIn: 0.4 });
  for (let f = 0; f < 120; f++) { ctx.tick(1 / 60); S.update(1 / 60); }
  for (const n of ['airburst', 'city_hit', 'roof_open', 'boss_roar', 'deadman_blow',
                   'maw_roar', 'gorger_burst', 'maw_die', 'stalker_charge', 'howler_alert']) S.sfx(n);
  const liveBefore = liveNodes();
  S.panic();
  const unstopped = LOG.srcs.filter((s) => s._started && !s._stopped);
  ok(unstopped.length === 0, '(c) every started source has been stopped', `${LOG.created} created`);
  ok(S._tracks.length === 0, 'panic() drops every track');
  const survivors = {};
  for (const n of LOG.nodes) if (!n._disconnected) survivors[n._type] = (survivors[n._type] || 0) + 1;
  ok(liveNodes() <= graphNodes + 2, 'panic() leaves only the persistent graph',
    `${liveBefore} -> ${liveNodes()} (graph ${graphNodes}) ${JSON.stringify(survivors)}`);
  let afterOk = true;
  try { S.sfx('flak_fire'); S.music('prowl'); ctx.tick(0.5); S.update(0.5); } catch (e) { afterOk = false; }
  ok(afterOk, 'audio still works after panic()');

  // ---- suspended context ----------------------------------------------------
  ctx.state = 'suspended';
  let suspOk = true;
  try { S.sfx('airburst'); S.update(0.016); } catch (e) { suspOk = false; }
  ctx.state = 'running';
  ok(suspOk, 'no throw while the context is suspended');

  // ---- (e)(f) global invariants --------------------------------------------
  console.log('\n-- invariants --');
  ok(LOG.nan.length === 0, '(e) no NaN reached any AudioParam / start / stop',
    LOG.nan.slice(0, 5).join(' | '));
  ok(LOG.past.length === 0, '(f) no time scheduled before currentTime',
    LOG.past.slice(0, 5).join(' | '));
  const orphan = LOG.srcs.filter((s) => !s._started);
  ok(orphan.length === 0, 'no source was created without being started', `${orphan.length}`);
  // synth.js swallows errors so a bad note never kills the game; _err keeps the
  // last one, so a silent track shows up here instead of as mysterious silence.
  ok(S._err === null, 'nothing was silently swallowed',
    S._err ? String(S._err.stack || S._err).split('\n').slice(0, 2).join(' | ') : '');

  console.log(`\n  ${NODE_ID} nodes created, ${LOG.connects} connections, ${LOG.autos} param events`);
  console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'}  ${PASS} passed, ${FAIL} failed`);
  if (FAIL) { console.log('failed: ' + FAILS.join('; ')); process.exitCode = 1; }
}

main().catch((e) => { console.error('HARNESS CRASH\n', e); process.exitCode = 1; });
