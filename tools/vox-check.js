// vox-check.js — headless correctness harness for src/audio/vox.js.
//
// Implements just enough of Web Audio to run the synthesiser, and validates
// EVERY value that reaches an AudioParam or a start()/stop() call. Also tracks
// node lifetimes so leaks show up as a rising live-node count.
//
//   node tools/vox-check.js
import {
  Vox, LINES, pickLine, pickLineAt, textToPhonemes, g2pWord, PHONE_SET,
  seedVox, VOICE_OF, voiceOf, CITIES, EXES, CAST,
} from '../src/audio/vox.js';

const VOICES = ['mutter', 'brick', 'ilsa'];

/* ───────────────────────── stub Web Audio ───────────────────────── */

const bad = [];      // every illegal value we ever see
let nodeId = 0;

function note(what, detail) { bad.push(`${what}: ${detail}`); }
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

class StubParam {
  constructor(node, name, v) {
    this.node = node; this.name = name; this._v = v;
    this.events = 0;
  }
  get value() { return this._v; }
  set value(v) {
    if (!finite(v)) note('NaN param assign', `${this.node.kind}.${this.name} = ${v}`);
    else this._v = v;
  }
  _chk(v, t, op) {
    if (!finite(v)) note('NaN param value', `${this.node.kind}.${this.name} ${op}(${v}, ${t})`);
    if (!finite(t)) note('NaN param time', `${this.node.kind}.${this.name} ${op}(${v}, ${t})`);
    else if (t < 0) note('negative param time', `${this.node.kind}.${this.name} ${op}(${v}, ${t})`);
    if (this.name === 'frequency' && finite(v) && (v <= 0 || v > this.node.ctx.sampleRate / 2)) {
      note('frequency out of range', `${this.node.kind}.frequency = ${v}`);
    }
    if (this.name === 'Q' && finite(v) && (v < 0 || v > 1000)) {
      note('Q out of range', `${this.node.kind}.Q = ${v}`);
    }
    if (finite(v)) this._v = v;
    this.events++;
    if (this.events > 20000) note('automation explosion', `${this.node.kind}.${this.name}`);
  }
  setValueAtTime(v, t) { this._chk(v, t, 'setValueAtTime'); return this; }
  linearRampToValueAtTime(v, t) { this._chk(v, t, 'linearRamp'); return this; }
  exponentialRampToValueAtTime(v, t) {
    if (finite(v) && v <= 0) note('exp ramp to <= 0', `${this.node.kind}.${this.name}`);
    this._chk(v, t, 'expRamp'); return this;
  }
  setTargetAtTime(v, t, tc) {
    if (!finite(tc) || tc <= 0) note('bad time constant', `${this.node.kind}.${this.name} tc=${tc}`);
    this._chk(v, t, 'setTarget'); return this;
  }
  cancelScheduledValues(t) {
    if (!finite(t)) note('NaN cancel time', `${this.node.kind}.${this.name}`);
    return this;
  }
}

class StubNode {
  constructor(ctx, kind) {
    this.ctx = ctx; this.kind = kind; this.id = ++nodeId;
    this.outs = []; this.disconnected = false; this.started = false;
    this.stopped = false; this.onended = null;
    ctx.nodes.push(this);
  }
  connect(dst) {
    if (!dst) note('connect to nothing', this.kind);
    this.outs.push(dst);
    return dst && dst.kind ? dst : dst;
  }
  disconnect() { this.disconnected = true; this.outs.length = 0; }
  _start(t) {
    if (!finite(t)) { note('NaN start time', this.kind); t = 0; }
    if (t < 0) note('negative start time', `${this.kind} ${t}`);
    if (this.started) note('double start', this.kind);
    this.started = true; this.startAt = t;
  }
  _stop(t) {
    if (!finite(t)) { note('NaN stop time', this.kind); t = 0; }
    if (t < 0) note('negative stop time', `${this.kind} ${t}`);
    if (!this.started) note('stop before start', this.kind);
    if (this.stopAt === undefined || t < this.stopAt) this.stopAt = t;
    this.stopped = true;
  }
}

class StubCtx {
  constructor(sampleRate = 48000) {
    this.sampleRate = sampleRate;
    this.currentTime = 0;
    this.state = 'running';
    this.nodes = [];
    this.destination = new StubNode(this, 'destination');
  }
  _param(node, name, v) { return new StubParam(node, name, v); }
  createGain() {
    const n = new StubNode(this, 'gain');
    n.gain = this._param(n, 'gain', 1);
    return n;
  }
  createOscillator() {
    const n = new StubNode(this, 'oscillator');
    n.frequency = this._param(n, 'frequency', 440);
    n.detune = this._param(n, 'detune', 0);
    n.type = 'sine';
    n.setPeriodicWave = (w) => { if (!w || !w.__wave) note('bad PeriodicWave', 'osc'); };
    n.start = (t = 0) => n._start(t);
    n.stop = (t = 0) => n._stop(t);
    return n;
  }
  createBiquadFilter() {
    const n = new StubNode(this, 'biquad');
    n.frequency = this._param(n, 'frequency', 350);
    n.Q = this._param(n, 'Q', 1);
    n.gain = this._param(n, 'gain', 0);
    n.detune = this._param(n, 'detune', 0);
    n.type = 'lowpass';
    return n;
  }
  createWaveShaper() {
    const n = new StubNode(this, 'waveshaper');
    n._curve = null;
    Object.defineProperty(n, 'curve', {
      get() { return n._curve; },
      set(c) {
        if (!(c instanceof Float32Array)) { note('bad curve type', 'waveshaper'); return; }
        if (c.length < 2) note('curve too short', 'waveshaper');
        for (let i = 0; i < c.length; i++) {
          if (!finite(c[i])) { note('NaN in waveshaper curve', `index ${i}`); break; }
        }
        n._curve = c;
      },
    });
    return n;
  }
  createDynamicsCompressor() {
    const n = new StubNode(this, 'compressor');
    n.threshold = this._param(n, 'threshold', -24);
    n.knee = this._param(n, 'knee', 30);
    n.ratio = this._param(n, 'ratio', 12);
    n.attack = this._param(n, 'attack', 0.003);
    n.release = this._param(n, 'release', 0.25);
    n.reduction = 0;
    return n;
  }
  createDelay(max = 1) {
    const n = new StubNode(this, 'delay');
    n.delayTime = this._param(n, 'delayTime', 0);
    n.maxDelayTime = max;
    return n;
  }
  createConvolver() {
    const n = new StubNode(this, 'convolver');
    n.normalize = true;
    n._buffer = null;
    Object.defineProperty(n, 'buffer', {
      get() { return n._buffer; },
      set(b) {
        if (b) {
          const d = b.getChannelData(0);
          for (let i = 0; i < d.length; i++) {
            if (!finite(d[i])) { note('NaN in impulse response', `index ${i}`); break; }
          }
        }
        n._buffer = b;
      },
    });
    return n;
  }
  createBufferSource() {
    const n = new StubNode(this, 'buffersource');
    n.playbackRate = this._param(n, 'playbackRate', 1);
    n.detune = this._param(n, 'detune', 0);
    n.loop = false; n.buffer = null;
    n.start = (t = 0) => n._start(t);
    n.stop = (t = 0) => n._stop(t);
    return n;
  }
  createBuffer(ch, len, sr) {
    if (!finite(len) || len <= 0) note('bad buffer length', String(len));
    const data = [];
    for (let i = 0; i < ch; i++) data.push(new Float32Array(Math.max(1, len | 0)));
    return { numberOfChannels: ch, length: len, sampleRate: sr, getChannelData: (i) => data[i] };
  }
  createPeriodicWave(re, im) {
    for (let i = 0; i < re.length; i++) {
      if (!finite(re[i]) || !finite(im[i])) { note('NaN in PeriodicWave', `harmonic ${i}`); break; }
    }
    return { __wave: true };
  }
  /** Advance the clock, firing onended for anything whose stop time passed. */
  advance(dt) {
    this.currentTime += dt;
    for (const n of this.nodes) {
      if (n.stopped && !n.reaped && n.stopAt <= this.currentTime) {
        n.reaped = true;
        if (typeof n.onended === 'function') { try { n.onended(); } catch (e) { note('onended threw', String(e)); } }
      }
    }
  }
  liveNodes() {
    return this.nodes.filter((n) => !n.disconnected && n.kind !== 'destination').length;
  }
}

/* ───────────────────────────── assertions ───────────────────────────── */

let pass = 0, fail = 0;
const results = [];
function check(name, ok, extra = '') {
  if (ok) { pass++; results.push(`  PASS  ${name}`); }
  else { fail++; results.push(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
}
function badSince(n) { return bad.slice(n); }

/* 1. construction */
const ctx = new StubCtx();
seedVox(20260903);
let vox;
try { vox = new Vox(ctx, ctx.destination); } catch (e) { vox = null; note('constructor threw', String(e)); }
check('constructs against a stub AudioContext', !!vox);
const chainNodes = ctx.liveNodes();
check('persistent chains are small (3 voices, <= 70 nodes)',
  chainNodes <= 70, `${chainNodes} nodes`);

/* 2. degenerate input is a safe no-op */
{
  const before = bad.length;
  const r = [vox.say(''), vox.say(null), vox.say(undefined), vox.say('   '),
    vox.say('...'), vox.say('{}'), vox.say({}), vox.say(0)];
  check('say("") / say(null) / junk are safe no-ops',
    r.slice(0, 6).every((v) => v === 0) && badSince(before).length === 0,
    JSON.stringify(r));
  vox.cancel();
  ctx.advance(0.2);
}

/* 3. hostile options never produce a bad param write */
{
  const before = bad.length;
  const hostile = [
    { pitch: NaN }, { rate: NaN }, { vol: NaN }, { glitch: NaN }, { priority: NaN },
    { pitch: Infinity }, { rate: -5 }, { vol: 1e9 }, { glitch: 99 },
    { mood: 'nonsense' }, { mood: null }, { pitch: 0 }, { rate: 0 },
  ];
  for (const o of hostile) { vox.say('Hostile options test one two three.', o); vox.cancel(); ctx.advance(0.05); }
  check('hostile opts produce no invalid AudioParam writes',
    badSince(before).length === 0, badSince(before).slice(0, 3).join(' | '));
}

/* 4. every LINES key speaks, in every mood, without throwing */
{
  const before = bad.length;
  const keys = Object.keys(LINES);
  let spoke = 0, threw = 0;
  const moods = ['calm', 'urgent', 'sweet', 'dying'];
  for (const k of keys) {
    const variants = Array.isArray(LINES[k]) ? LINES[k] : [LINES[k]];
    for (let v = 0; v < variants.length; v++) {
      for (const voice of VOICES) {
        const mood = moods[(spoke + v) % moods.length];
        try {
          const d = vox.sayLine(k, {
            mood, voice, args: ['Ashgrove', 'Five'], glitch: 0.35, priority: 5,
          });
          if (!(typeof d === 'number' && Number.isFinite(d) && d > 0.2 && d < 30)) {
            note('implausible duration', `${k}/${voice} -> ${d}`);
          }
          spoke++;
        } catch (e) { threw++; note('sayLine threw', `${k}/${voice}: ${e && e.message}`); }
        vox.cancel();
        ctx.advance(0.06);
      }
    }
  }
  check(`all ${keys.length} LINES keys speak in 3 voices x 4 moods (${spoke} utterances)`,
    threw === 0 && spoke > 0);
  check('no invalid values while speaking every line',
    badSince(before).length === 0, badSince(before).slice(0, 4).join(' | '));
}

/* 5. required keys present */
{
  const original = ['boot', 'wave_start', 'wave_clear', 'city_lost', 'city_lost_last',
    'all_cities_lost', 'player_hurt_bad', 'player_death', 'level_clear', 'secret_found',
    'key_taken', 'weapon_taken', 'low_ammo', 'chain_praise', 'perfect_burst', 'boss_intro',
    'boss_death', 'idle_taunt', 'elevator', 'roof_opening', 'mirv_warning',
    'buster_warning', 'smart_warning', 'game_over', 'victory', 'title_idle'];
  const story = [
    'brick_boot', 'brick_kill', 'brick_kill_mutant', 'brick_chain', 'brick_hurt',
    'brick_low_health', 'brick_pickup_weapon', 'brick_secret', 'brick_kick',
    'brick_distracted', 'brick_city_lost', 'brick_wave_start', 'brick_wave_clear',
    'brick_boss_taunt', 'brick_dry', 'brick_death', 'brick_victory', 'brick_idle',
    'ilsa_intro', 'ilsa_level1', 'ilsa_level2', 'ilsa_level3', 'ilsa_level4',
    'ilsa_level5', 'ilsa_fuse_tip', 'ilsa_chain_tip', 'ilsa_mutant_warning',
    'ilsa_city_lost', 'ilsa_city_burning', 'ilsa_city_rebuilt', 'ilsa_wave_incoming',
    'ilsa_boss_warning', 'ilsa_low_health', 'ilsa_distracted_reply', 'ilsa_secret',
    'ilsa_almost_there', 'ilsa_rescued', 'ilsa_victory', 'ilsa_death',
    'mutter_ex_file', 'mutter_mutant', 'mutter_brick_file', 'mutter_ilsa', 'mutter_kick',
  ];
  const missingStory = story.filter((k) => !LINES[k]);
  check(`all ${story.length} story keys exist`, missingStory.length === 0, missingStory.join(','));
  const thin = story.filter((k) => !Array.isArray(LINES[k]) || LINES[k].length < 3);
  check('every story key has at least 3 variants', thin.length === 0, thin.join(','));
  const distracted = LINES.brick_distracted || [];
  check('brick_distracted has at least 6 variants', distracted.length >= 6, `${distracted.length}`);
  const exFile = LINES.mutter_ex_file || [];
  check('mutter_ex_file has one variant per city',
    exFile.length >= CITIES.length && exFile.every((l) => l.includes('%s')),
    `${exFile.length} vs ${CITIES.length} cities`);
  const required = original;
  const missing = required.filter((k) => !LINES[k]);
  check(`all ${required.length} required LINES keys exist`, missing.length === 0, missing.join(','));
  const idle = LINES.idle_taunt;
  check('idle_taunt has several variants', Array.isArray(idle) && idle.length >= 4,
    `${Array.isArray(idle) ? idle.length : 0}`);
}

/* 6. pickLine resolves arrays and never repeats back-to-back */
{
  let repeats = 0, empties = 0;
  for (const k of Object.keys(LINES)) {
    let prev = null;
    for (let i = 0; i < 40; i++) {
      const s = pickLine(k);
      if (typeof s !== 'string' || !s.length) empties++;
      if (s === prev && (Array.isArray(LINES[k]) && LINES[k].length > 1)) repeats++;
      prev = s;
    }
  }
  check('pickLine always returns a non-empty string', empties === 0, `${empties} empty`);
  check('pickLine never repeats consecutively', repeats === 0, `${repeats} repeats`);
  check('pickLine on an unknown key returns ""', pickLine('no_such_key') === '');
}

/* 7. %s substitution */
{
  const before = bad.length;
  const d = vox.sayLine('city_lost', { args: ['Low Sabbath', 'Three'] });
  check('sayLine with args returns a duration', d > 0.5, String(d));
  vox.cancel(); ctx.advance(0.1);
  const d2 = vox.sayLine('city_lost', {});          // no args: tokens stripped
  check('sayLine without args still speaks', d2 > 0.5, String(d2));
  vox.cancel(); ctx.advance(0.1);
  check('token substitution writes nothing invalid', badSince(before).length === 0);
}

/* 8. busy transitions */
{
  vox.cancel(); ctx.advance(0.5);
  check('busy is false when idle', vox.busy === false);
  const d = vox.say('Bunker Sieben is operating normally.', { priority: 1 });
  check('busy is true immediately after say()', vox.busy === true);
  ctx.advance(d * 0.5);
  check('busy is still true mid-utterance', vox.busy === true);
  ctx.advance(d * 0.5 + 0.2);
  check('busy is false after the utterance ends', vox.busy === false);
}

/* 9. priority: higher interrupts, equal/lower does not steal the floor */
{
  vox.cancel(); ctx.advance(0.5);
  const a = vox.say('Low priority announcement about the corridors.', { priority: 0 });
  check('first utterance starts', a > 0);
  const b = vox.say('Equal priority is not allowed to barge in.', { priority: 0 });
  check('equal priority does not interrupt (queued or dropped)', vox.busy === true);
  const c = vox.say('High priority warhead warning.', { priority: 9 });
  check('higher priority is accepted', c > 0);
  // queue must stay bounded
  for (let i = 0; i < 50; i++) vox.say(`Filler announcement number ${i}.`, { priority: 1 });
  check('queue stays bounded at 2', vox._queue.length <= 2, `${vox._queue.length}`);
  vox.cancel(); ctx.advance(0.5);
  check('cancel() empties the queue', vox._queue.length === 0 && vox.busy === false);
}

/* 10. cancel() stops everything it created */
{
  vox.cancel(); ctx.advance(1.0);
  const mark = ctx.nodes.length;
  vox.say('This announcement will be cut off half way through, warden.', { priority: 3 });
  const made = ctx.nodes.slice(mark);
  const sources = made.filter((n) => n.kind === 'oscillator' || n.kind === 'buffersource');
  check('an utterance creates sources', sources.length >= 3, `${sources.length}`);
  check('one utterance costs a bounded number of nodes (<= 40)',
    made.length <= 40, `${made.length}`);
  vox.cancel();
  check('cancel() stops every source it created',
    sources.every((n) => n.stopped), sources.filter((n) => !n.stopped).map((n) => n.kind).join(','));
  const stopSoon = sources.every((n) => n.stopAt - ctx.currentTime <= 0.05);
  check('cancel() stops within ~50ms (no long tail)', stopSoon);
  ctx.advance(0.3);
  check('cancelled utterance disconnects all its nodes',
    made.every((n) => n.disconnected),
    made.filter((n) => !n.disconnected).map((n) => n.kind).join(','));
  check('cancel() leaves busy false', vox.busy === false);
}

/* 11. node budget: speak every line back to back, count live nodes */
{
  vox.cancel(); ctx.advance(1.0);
  const beforeBad = bad.length;
  let peak = 0;
  const keys = Object.keys(LINES);
  for (let round = 0; round < 3; round++) {
    for (const k of keys) {
      const d = vox.sayLine(k, {
        args: ['Candlemark', 'Two'],
        mood: ['calm', 'urgent', 'sweet', 'dying'][round % 4],
        voice: VOICES[round % 3],
        glitch: 0.4, priority: round,
      });
      // let it finish, then let the reaper run
      ctx.advance(Math.max(0.05, d + 0.15));
      vox.busy;                                   // pumps the queue
      ctx.advance(0.05);
      peak = Math.max(peak, ctx.liveNodes());
    }
  }
  check(`live node count stays bounded across ${keys.length * 3} utterances (< 150)`,
    peak < 150, `peak ${peak}`);
  check('steady-state returns to the persistent chain',
    ctx.liveNodes() <= chainNodes + 30, `${ctx.liveNodes()} vs chain ${chainNodes}`);
  check('no invalid values during the node-budget run',
    badSince(beforeBad).length === 0, badSince(beforeBad).slice(0, 3).join(' | '));
}

/* 12. rapid-fire firefight: say() spammed with no time to finish */
{
  vox.cancel(); ctx.advance(1.0);
  const beforeBad = bad.length;
  const startNodes = ctx.liveNodes();
  for (let i = 0; i < 400; i++) {
    vox.say(`Inbound warhead ${i % 9}, bearing ${i % 360}.`,
      { priority: i % 4, mood: 'urgent', glitch: 0.5 });
    ctx.advance(0.02);
  }
  ctx.advance(10);
  vox.busy;
  ctx.advance(10);
  vox.cancel();
  ctx.advance(1);
  const endNodes = ctx.liveNodes();
  check('400 interleaved say() calls leak no nodes',
    endNodes <= startNodes + 30, `${startNodes} -> ${endNodes}`);
  check('firefight spam writes nothing invalid',
    badSince(beforeBad).length === 0, badSince(beforeBad).slice(0, 3).join(' | '));
}

/* 13. setVolume + no-context safety */
{
  const before = bad.length;
  for (const v of [0, 0.5, 1, 2, NaN, -1, Infinity, null, undefined, 'loud']) vox.setVolume(v);
  check('setVolume tolerates junk', badSince(before).length === 0);

  let ok = true;
  try {
    const dead = new Vox(null, null);
    ok = dead.say('Speaking with no audio context at all.') === 0 && dead.busy === false;
    dead.cancel(); dead.setVolume(0.5); dead.sayLine('boot');
  } catch (e) { ok = false; note('null-ctx Vox threw', String(e)); }
  check('Vox with no AudioContext never throws', ok);

  let ok2 = true;
  try {
    const c2 = new StubCtx();
    const v2 = new Vox(c2, c2.destination);
    c2.state = 'closed';
    ok2 = v2.say('closed context') === 0;
  } catch (e) { ok2 = false; }
  check('say() on a closed context returns 0', ok2);
}

/* 13b. three voices */
{
  vox.cancel(); ctx.advance(1);

  // VOICE_OF must cover every key and follow the documented prefix rule
  const wrong = Object.keys(LINES).filter((k) => {
    const want = k.startsWith('brick_') ? 'brick' : k.startsWith('ilsa_') ? 'ilsa' : 'mutter';
    return VOICE_OF[k] !== want || voiceOf(k) !== want;
  });
  check('VOICE_OF covers every key and matches the prefix rule',
    wrong.length === 0 && Object.keys(VOICE_OF).length === Object.keys(LINES).length,
    wrong.slice(0, 5).join(','));
  check('voiceOf() also resolves keys that are not in LINES',
    voiceOf('brick_未known') === 'brick' && voiceOf('ilsa_zzz') === 'ilsa'
    && voiceOf('anything_else') === 'mutter' && voiceOf(null) === 'mutter');
  check('CAST names all three voices',
    VOICES.every((v) => typeof CAST[v] === 'string' && CAST[v].length > 2));
  check('CITIES and EXES are index-matched',
    CITIES.length === 6 && EXES.length === 6);

  // every voice must build a *different* formant scaling, not just a pitch
  const seen = {};
  for (const v of VOICES) {
    vox.cancel(); ctx.advance(0.6);
    const mark = ctx.nodes.length;
    vox.say('The six cities are not people.', { voice: v, priority: 9 });
    const made = ctx.nodes.slice(mark);
    const biquads = made.filter((n) => n.kind === 'biquad');
    // F2 of the first vowel, read straight off the resonator we scheduled
    seen[v] = biquads.length ? biquads[1].frequency.value : 0;
    check(`voice "${v}" builds a bounded utterance chain`, made.length <= 40, `${made.length}`);
  }
  check('brick sits below mutter and ilsa above it (F2 placement)',
    seen.brick < seen.mutter && seen.mutter < seen.ilsa,
    `brick=${seen.brick|0} mutter=${seen.mutter|0} ilsa=${seen.ilsa|0}`);
  check('the formant shift is substantial, not cosmetic',
    seen.ilsa / seen.brick > 1.25, `ratio ${(seen.ilsa / seen.brick).toFixed(2)}`);

  // sayLine picks the speaker on its own
  vox.cancel(); ctx.advance(0.6);
  const beforeBad = bad.length;
  for (const k of ['brick_kill', 'ilsa_intro', 'mutter_kick', 'boot']) {
    const d = vox.sayLine(k, { priority: 9 });
    if (!(d > 0)) note('auto-voice sayLine returned 0', k);
    vox.cancel(); ctx.advance(0.1);
  }
  check('sayLine auto-selects the voice without opts.voice', badSince(beforeBad).length === 0);

  // an unknown voice must fall back rather than throw, and must not mutate opts
  const o = { voice: 'nobody', priority: 9 };
  const d = vox.say('Unknown voice fallback.', o);
  check('unknown voice falls back to mutter', d > 0 && o.voice === 'nobody');
  vox.cancel(); ctx.advance(0.5);

  // pickLineAt is deterministic and stays in range
  let atOk = true;
  for (let i = -8; i < 20; i++) {
    const a = pickLineAt('mutter_ex_file', i);
    if (typeof a !== 'string' || !a.length) atOk = false;
    if (a !== pickLineAt('mutter_ex_file', i)) atOk = false;
  }
  check('pickLineAt is deterministic and wraps safely', atOk);
  check('pickLineAt matches city order',
    pickLineAt('mutter_ex_file', 0) === LINES.mutter_ex_file[0]
    && pickLineAt('mutter_ex_file', 5) === LINES.mutter_ex_file[5]);
  check('pickLineAt on an unknown key returns ""', pickLineAt('nope', 0) === '');

  // lastLine must report exactly what was spoken, so subtitles can match
  vox.cancel(); ctx.advance(0.6);
  vox.sayLine('city_lost', { args: ['Low Sabbath', 'Three'], priority: 9 });
  const said = vox.lastLine;
  check('lastLine reports the substituted text that was actually spoken',
    said.includes('Low Sabbath') && said.includes('Three') && !said.includes('%s'), said);
  vox.cancel(); ctx.advance(0.6);
  vox.sayLine('ilsa_intro', { priority: 9 });
  check('lastVoice reports the auto-selected voice', vox.lastVoice === 'ilsa', vox.lastVoice);
  vox.cancel(); ctx.advance(0.6);

  // ilsa's squelch must not leak: her utterances still tear down completely
  vox.cancel(); ctx.advance(1);
  const mark = ctx.nodes.length;
  const dur = vox.say('Radio check, warden.', { voice: 'ilsa', priority: 9 });
  const made = ctx.nodes.slice(mark);
  ctx.advance(dur + 0.5);
  vox.busy;
  check('ilsa utterance (with squelch) disconnects everything',
    made.every((n) => n.disconnected), `${made.filter((n) => !n.disconnected).length} left`);
}

/* 13c. MUTTER must be bit-for-bit the voice she was before the story update */
{
  vox.cancel(); ctx.advance(1);
  const sample = ['boot', 'city_lost', 'chain_praise', 'boss_death', 'idle_taunt', 'victory'];
  let same = true;
  for (const k of sample) {
    const text = pickLine(k);   // one text: pickLine deliberately never repeats
    for (const mood of ['calm', 'urgent', 'sweet', 'dying']) {
      seedVox(4242);
      const a = vox.say(text, { mood, priority: 9 });
      vox.cancel(); ctx.advance(0.4);
      seedVox(4242);
      const b = vox.say(text, { mood, voice: 'mutter', priority: 9 });
      vox.cancel(); ctx.advance(0.4);
      if (a !== b || !(a > 0)) same = false;
    }
  }
  check('default voice is identical to explicit "mutter"', same);

  // mutter's formant scale must still be exactly 1.0 — read the resonator back
  vox.cancel(); ctx.advance(0.6);
  const mark = ctx.nodes.length;
  vox.say('{EH1}', { voice: 'mutter', priority: 9 });
  const bq = ctx.nodes.slice(mark).filter((n) => n.kind === 'biquad');
  const f1 = bq[0] ? bq[0].frequency.value : 0;
  const f2 = bq[1] ? bq[1].frequency.value : 0;
  check('mutter formants are unscaled (EH = 530 / 1840)',
    Math.abs(f1 - 530) < 1 && Math.abs(f2 - 1840) < 1, `${f1|0}/${f2|0}`);
  vox.cancel(); ctx.advance(0.6);

  // and every original key still resolves to her
  const originals = ['boot', 'wave_start', 'city_lost', 'player_death', 'victory', 'title_idle'];
  check('original keys still route to mutter',
    originals.every((k) => voiceOf(k) === 'mutter'));
}

/* 14. G2P sanity */
{
  const spot = {
    SIX: 'S IH1 K S', SKY: 'S K AY1', WARDEN: 'W AO1 R D AH N',
    CITIES: 'S IH1 T IY Z', THROUGH: 'TH R UW1', PHONE: 'F OW1 N',
    NATION: 'N EY1 SH AH N', KNOCK: 'N AA1 K', WRITE: 'R AY1 T',
    QUICK: 'K W IH1 K', CHURCH: 'CH ER1 CH', PACKED: 'P AE1 K T',
    HARDIGAN: 'HH AA1 R D IH G AH N', VANCE: 'V AE1 N S', BRICK: 'B R IH1 K',
    ILSA: 'IH1 L S AH', LORETTA: 'L ER EH1 T AH', CHERYL: 'SH EH1 R AH L',
    TRUCK: 'T R AH1 K', WOMAN: 'W UH1 M AH N', ABOUT: 'AH B AW1 T',
    FULL: 'F UH1 L', FITTED: 'F IH1 T IH D', OKAY: 'OW K EY1',
  };
  let g2pBad = [];
  for (const [w, want] of Object.entries(spot)) {
    const got = g2pWord(w).join(' ');
    if (got !== want) g2pBad.push(`${w}: got "${got}" want "${want}"`);
  }
  check('G2P spot-checks (digraphs, silent letters, -ed, tion)',
    g2pBad.length === 0, g2pBad.join(' | '));

  const esc = textToPhonemes('the {M UH1 TH ER} protocol').map((p) => p.p + (p.st || ''));
  check('{...} phoneme escape is honoured',
    esc.join(' ').includes('M UH1 TH ER'), esc.join(' '));

  const yr = textToPhonemes('in 1979 and 6 more').map((p) => p.p || '/').join(' ');
  check('numbers and years are spoken', /N AY N T IY N/.test(yr) && /S IH K S/.test(yr), yr);

  // every phone the G2P can emit must exist in the synthesiser's tables
  const emitted = new Set();
  for (const k of Object.keys(LINES)) {
    for (const s of (Array.isArray(LINES[k]) ? LINES[k] : [LINES[k]])) {
      for (const p of textToPhonemes(s.replace(/%s/g, 'Saint Errol'))) if (p.p) emitted.add(p.p);
    }
  }
  const unknown = [...emitted].filter((p) => !PHONE_SET.includes(p));
  check('every phone in LINES is a known phone', unknown.length === 0, unknown.join(','));

  // no line should phonemise to nothing
  const emptyLines = [];
  for (const k of Object.keys(LINES)) {
    for (const s of (Array.isArray(LINES[k]) ? LINES[k] : [LINES[k]])) {
      if (textToPhonemes(s.replace(/%s/g, 'Verity')).filter((p) => p.p).length < 4) emptyLines.push(k);
    }
  }
  check('no LINES entry phonemises to (almost) nothing', emptyLines.length === 0, emptyLines.join(','));
}

/* 15. no forbidden APIs anywhere in the module */
{
  const fs = await import('node:fs');
  const raw = fs.readFileSync(new URL('../src/audio/vox.js', import.meta.url), 'utf8');
  // strip comments — the header prose legitimately *names* the APIs we avoid
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const forbidden = [
    ['speechSynthesis', /speechSynthesis/],
    ['SpeechSynthesisUtterance', /SpeechSynthesisUtterance/],
    ['node: import', /from\s+['"]node:/],
    ['fetch/XHR', /\bfetch\s*\(|XMLHttpRequest/],
    ['require()', /\brequire\s*\(/],
    ['audio file decode', /decodeAudioData/],
  ];
  const hits = forbidden.filter(([, re]) => re.test(src)).map(([n]) => n);
  check('module uses no forbidden APIs', hits.length === 0, hits.join(','));
  check('module is an ES module with the contract exports',
    /export class Vox/.test(src) && /export const LINES/.test(src) && /export function pickLine/.test(src));
}

/* ─────────────────────────────── report ─────────────────────────────── */

console.log('\nvox-check — stub Web Audio conformance\n');
for (const r of results) console.log(r);
if (bad.length) {
  console.log(`\n  ${bad.length} invalid value(s) observed:`);
  const seen = new Set();
  for (const b of bad) { if (!seen.has(b)) { seen.add(b); console.log(`    ${b}`); } }
}
console.log(`\n  nodes created total: ${ctx.nodes.length}, live now: ${ctx.liveNodes()}`);
console.log(`  phones: ${PHONE_SET.length}   LINES keys: ${Object.keys(LINES).length}`);
console.log(`\n${fail === 0 && bad.length === 0 ? 'PASS' : 'FAIL'}  ${pass} passed, ${fail} failed, ${bad.length} invalid values\n`);
process.exit(fail === 0 && bad.length === 0 ? 0 : 1);
