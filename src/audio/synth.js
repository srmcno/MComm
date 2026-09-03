// synth.js — NUKEHAUS audio. Bunker Sieben has no sample library, no CD, and no
// network. Every sound below is built out of oscillators, buffers filled with
// arithmetic, biquads and envelopes. Pure Web Audio, browser-safe ES module.
//
// Architecture
//   voices ─┬─> sfxBus ────────────────> master -> comp -> destination
//           ├─> sendS[n] -> convSmall -> sfxBus      (concrete corridor)
//           └─> sendB[n] -> convBig   -> sfxBus      (open deck, siege sky)
//   track  ──> track.bus (+ feedback-delay space) -> musicDuck -> musicBus -> master
//
// Every one-shot node is owned by a "voice": a small record holding its nodes and
// its sources. Sources are always start()ed AND stop()ped, and the last source's
// onended disconnects the whole voice. Nothing is ever left connected.

/* ------------------------------------------------------------------ helpers */

const fin = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
/** MIDI note -> Hz. 69 = A4 = 440. */
const mtof = (m) => 440 * Math.pow(2, (fin(m, 69) - 69) / 12);

/** Deterministic 32-bit hash -> 0..1. Used for pattern variation. */
function hash(x) {
  x = Math.imul(x ^ (x >>> 16), 2246822507);
  x = Math.imul(x ^ (x >>> 13), 3266489909);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}
const h2 = (a, b) => hash((a * 73856093) ^ (b * 19349663));

/* --------------------------------------------------------- musical material */
// The whole soundtrack lives on D so the tracks feel like one piece of music.
// D Phrygian (D Eb F G A Bb C) is the house scale: the flat second is the menace.

const ROOT = 38;                            // D2, 73.42 Hz
const PHRYG = [0, 1, 3, 5, 7, 8, 10];       // D Eb F G A Bb C

/** Scale degree (may run past an octave, or negative) -> semitones over ROOT. */
function deg(n) {
  const o = Math.floor(n / 7);
  return o * 12 + PHRYG[n - o * 7];
}

/** Same, for the major pentatonic `hero` runs up and down. */
function pent(n) {
  const o = Math.floor(n / 5);
  return o * 12 + PENT[n - o * 5];
}

/** Chord voicings, semitones above ROOT. Shared by every track. */
const CHORD = {
  i:    [0, 3, 7, 10],      // Dm7
  bII:  [1, 5, 8, 13],      // Eb
  bIII: [3, 7, 10, 15],     // F
  iv:   [5, 8, 12, 17],     // Gm
  v:    [7, 10, 14, 19],    // Am
  bVI:  [8, 12, 15, 20],    // Bb
  bVII: [10, 14, 17, 22],   // C
  I:    [0, 4, 7, 11],      // D  (victory only)
  IV:   [5, 9, 12, 16],     // G
  V:    [7, 11, 14, 18],    // A
};

/** The four-note theme, the thing you hum after the title screen. */
const MOTIF = [77, 75, 74, 69];             // F5  Eb5  D5  A4  — a descending sigh

/** Inharmonic partial ratios for struck metal. */
const METAL = [1, 1.414, 1.932, 2.618, 3.142, 4.075];

const TRACKS = {
  title:    { bpm: 78,  spb: 16, bars: 4, gain: 0.86, loop: true,  space: [0.31, 0.62, 2600] },
  prowl:    { bpm: 104, spb: 16, bars: 8, gain: 1.00, loop: true,  space: [0.17, 0.42, 1500] },
  siege:    { bpm: 148, spb: 16, bars: 4, gain: 0.90, loop: true,  space: [0.101, 0.34, 3200] },
  boss:     { bpm: 132, spb: 14, bars: 4, gain: 0.84, loop: true,  space: [0.227, 0.55, 1800] },
  victory:  { bpm: 120, spb: 16, bars: 7, gain: 1.00, loop: false, tail: 3.2, space: [0.25, 0.5, 4000] },
  gameover: { bpm: 62,  spb: 16, bars: 4, gain: 0.95, loop: false, tail: 4.5, space: [0.41, 0.66, 2000] },
  hunt:     { bpm: 96,  spb: 16, bars: 8, gain: 1.00, loop: true,  space: [0.195, 0.5, 1200] },
  hero:     { bpm: 118, spb: 16, bars: 8, gain: 0.90, loop: true,  space: [0.127, 0.3, 3800] },
};

/** Major pentatonic, for the one track that is allowed to enjoy itself. */
const PENT = [0, 2, 4, 7, 9];

/* -------------------------------------------------------------------- limits */

const MAXV = [20, 24];          // concurrent voices: [sfx, music]
const BUDGET = [96, 128];       // hard node ceiling per pool — the anti-leak valve
const LOOKAHEAD = 0.15;         // sequencer scheduling horizon, seconds
const SEND_LV = [0.16, 0.36, 0.7];

/* =================================================================== Sound */

export class Sound {
  constructor() {
    this._ctx = null;
    this._ready = false;
    this._boot = null;

    // persistent graph
    this._master = null; this._comp = null;
    this._music = null; this._duck = null; this._sfx = null;
    this._convS = null; this._convB = null;
    this._sendS = null; this._sendB = null;

    // reusable buffers
    this._nzW = null; this._nzP = null;
    this._satCurve = null; this._crushCurve = null;
    this._grindCurve = null; this._crackleCurve = null;

    // voice pool
    this._voices = [];
    this._nc = [0, 0];
    this._seq = 0;
    this._rs = 0x1a2b3c4d;

    // mix state (settable before init)
    this._vMaster = 0.85; this._vMusic = 0.8; this._vSfx = 0.95;

    // sequencer
    this._tracks = [];
    this._pending = null;
    this._lastResume = 0;
    this._err = null;   // last swallowed error, for tools/audio-render.js

    // scratch opts object, reused so sfx() allocates nothing
    this._o = { vol: 1, rate: 1, pan: 0, delay: 0 };
  }

  get ready() { return this._ready; }
  get ctx() { return this._ctx; }
  get sfxBus() { return this._sfx; }
  get musicBus() { return this._music; }

  /* ------------------------------------------------------------------ init */

  /**
   * Build the context and the whole graph. Call from a user gesture.
   * Idempotent — repeated calls return the same promise.
   * @param {BaseAudioContext} [externalCtx] optional (OfflineAudioContext for rendering/tests)
   */
  async init(externalCtx = null) {
    if (this._boot) return this._boot;
    this._boot = this._build(externalCtx).catch(() => { this._ready = false; return false; });
    return this._boot;
  }

  async _build(externalCtx) {
    let ctx = externalCtx;
    if (!ctx) {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AC) return false;
      ctx = new AC({ latencyHint: 'interactive' });
    }
    this._ctx = ctx;
    this._offline = typeof ctx.startRendering === 'function';
    if (!this._offline && ctx.state === 'suspended' && ctx.resume) {
      try { await ctx.resume(); } catch (e) { /* gesture will retry */ }
    }

    const g = (v) => { const n = ctx.createGain(); n.gain.value = v; return n; };

    // master chain: everything sums here, a soft-knee compressor keeps a chain of
    // airbursts from turning into square-wave mush.
    this._comp = ctx.createDynamicsCompressor();
    this._comp.threshold.value = -14;
    this._comp.knee.value = 20;          // soft
    this._comp.ratio.value = 5;
    this._comp.attack.value = 0.003;
    this._comp.release.value = 0.22;

    // Final ceiling. The compressor's 3 ms attack lets transients through, and a
    // chain of airbursts can still stack past 0 dBFS, so everything ends in a
    // shaper that is exactly linear below -3.7 dBFS and cannot exceed ~0.99.
    this._pre = g(0.5);                  // halve, so the curve's domain covers +-2
    this._limit = ctx.createWaveShaper();
    this._limit.curve = limiterCurve(2048);
    this._limit.oversample = 'none';   // 2x resampling rings past the ceiling
    this._comp.connect(this._pre);
    this._pre.connect(this._limit);
    this._limit.connect(ctx.destination);

    this._master = g(this._vMaster);
    this._master.connect(this._comp);

    this._music = g(this._vMusic);
    this._duck = g(1);
    this._music.connect(this._master);
    this._duck.connect(this._music);

    this._sfx = g(this._vSfx);
    this._sfx.connect(this._master);

    // Two rooms. Corridors are short, dark and concrete. The silo deck is open
    // air: longer, brighter, and it takes a beat to come back at you.
    this._convS = ctx.createConvolver();
    this._convS.normalize = true;
    this._convS.buffer = this._ir(0.85, 3.4, 0.30, 0.004);
    this._convS.connect(this._sfx);

    const preB = ctx.createDelay(0.2);
    preB.delayTime.value = 0.024;
    this._convB = ctx.createConvolver();
    this._convB.normalize = true;
    this._convB.buffer = this._ir(3.1, 1.9, 0.78, 0.012);
    preB.connect(this._convB);
    this._convB.connect(this._sfx);
    this._preB = preB;

    // Fixed send buckets instead of a per-voice send gain: three levels is all the
    // resolution reverb depth ever needs, and it saves a node on every single shot.
    this._sendS = SEND_LV.map((v) => { const n = g(v * 0.9); n.connect(this._convS); return n; });
    this._sendB = SEND_LV.map((v) => { const n = g(v * 1.05); n.connect(preB); return n; });

    // Reusable noise. Built once — a shooter must never allocate a buffer per shot.
    this._nzW = this._noiseBuf(2.5, 0);
    this._nzP = this._noiseBuf(2.5, 1);

    this._satCurve = curve(2.4, 1024);
    this._crushCurve = curve(9, 1024);
    this._grindCurve = shapeCurve(128, (i, n) => {
      const t = i / n;
      return 0.35 + 0.65 * Math.abs(Math.sin(t * Math.PI * 9.3)) * (0.6 + 0.4 * hash(i * 7));
    });
    this._crackleCurve = shapeCurve(160, (i, n) => {
      const t = i / n;
      const decay = Math.pow(1 - t, 1.7);
      return decay * (0.25 + 0.75 * Math.pow(hash(i * 2654435761), 2));
    });
    // Slow irregular bubbling — the inside of something that should not be moving.
    this._gurgleCurve = shapeCurve(192, (i, n) => {
      const t = i / n;
      const slow = 0.5 + 0.5 * Math.sin(t * Math.PI * 5.7 + Math.sin(t * 11.3) * 1.6);
      return (0.18 + 0.82 * slow * slow) * (0.55 + 0.45 * hash(i * 40503));
    });
    // Dense spatter that thins out as the mess finishes landing.
    this._splatCurve = shapeCurve(512, (i, n) => {
      const t = i / n;
      const density = Math.pow(1 - t, 1.25);
      const grain = hash(i * 2246822507);
      // hard gaps between landings: the contrast is the whole effect
      return density * (grain > 0.55 ? 0.2 + 0.8 * grain * grain : 0.015);
    });
    // Claw impacts that speed up: spike spacing shrinks toward the end.
    this._scrabbleCurve = shapeCurve(384, (i, n) => {
      const t = i / n;
      const phase = t * t * 26 + t * 7;             // accelerating
      const f = phase - Math.floor(phase);
      const hit = Math.pow(1 - f, 7);
      return hit * (0.45 + 0.55 * hash(Math.floor(phase) * 7919)) * (0.5 + 0.5 * t);
    });
    // Fast dry chittering, mandibles rather than machinery.
    this._chitterCurve = shapeCurve(224, (i, n) => {
      const t = i / n;
      const phase = t * 34;
      const f = phase - Math.floor(phase);
      const on = hash(Math.floor(phase) * 26699) > 0.34 ? 1 : 0;
      return on * Math.pow(1 - f, 4.5) * Math.pow(1 - t, 0.7);
    });
    // Acid on armour: a hiss that keeps spitting.
    this._sizzleCurve = shapeCurve(160, (i, n) => {
      const t = i / n;
      const base = Math.pow(1 - t, 1.4);
      const spit = hash(i * 374761393) > 0.86 ? 1.7 : 1;
      return base * 0.55 * spit;
    });

    this._ready = true;
    if (this._pending) { const p = this._pending; this._pending = null; this.music(p.t, p.o); }
    return true;
  }

  /* --------------------------------------------------------------- buffers */

  /** White (kind=0) or pink-ish (kind=1) noise, stereo, decorrelated. */
  _noiseBuf(seconds, kind) {
    const ctx = this._ctx, sr = ctx.sampleRate;
    const n = Math.max(1024, Math.floor(sr * seconds));
    const buf = ctx.createBuffer(2, n, sr);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      let b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < n; i++) {
        const w = Math.random() * 2 - 1;
        if (kind === 0) { d[i] = w * 0.85; continue; }
        // Paul Kellet's economy pink filter — three one-poles summed.
        b0 = 0.99765 * b0 + w * 0.0990460;
        b1 = 0.96300 * b1 + w * 0.2965164;
        b2 = 0.57000 * b2 + w * 1.0526913;
        d[i] = clamp((b0 + b1 + b2 + w * 0.1848) * 0.22, -1, 1);
      }
    }
    return buf;
  }

  /**
   * Decaying-noise impulse response. `bright` is a one-pole coefficient (low =
   * dark concrete, high = open sky), `pre` seconds of pre-delay + early taps.
   */
  _ir(seconds, decay, bright, pre) {
    const ctx = this._ctx, sr = ctx.sampleRate;
    const n = Math.max(256, Math.floor(sr * seconds));
    const buf = ctx.createBuffer(2, n, sr);
    const p = Math.floor(sr * pre);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      let lp = 0;
      const a = bright;
      for (let i = p; i < n; i++) {
        const t = (i - p) / (n - p);
        const env = Math.pow(1 - t, decay);
        lp += a * ((Math.random() * 2 - 1) - lp);
        d[i] = lp * env;
      }
      // early reflections: the slap that tells you the walls are close
      const taps = [0.0071, 0.0134, 0.0193, 0.0291, 0.0417];
      for (let k = 0; k < taps.length; k++) {
        const idx = p + Math.floor(sr * taps[k] * (1 + c * 0.07));
        if (idx < n) d[idx] += (k % 2 ? -1 : 1) * (0.55 - k * 0.09);
      }
    }
    return buf;
  }

  /* ---------------------------------------------------------- voice pooling */

  _now() { return this._ctx ? this._ctx.currentTime : 0; }
  /** Sanitise a schedule time: finite, and never in the past. */
  _t(x) { const n = this._now(); const v = fin(x, n); return v < n ? n : v; }
  _r() { this._rs = (Math.imul(this._rs, 1664525) + 1013904223) >>> 0; return this._rs / 4294967296; }

  /**
   * Allocate a voice. `pri` decides who survives when the pool is full: a new
   * sound steals the weakest older voice, or is dropped if it is the weakest.
   */
  _v(pri, o, revS, revB, pool, dest) {
    if (!this._ready) return null;
    pool = pool || 0;
    const score = pri * 1e6 + (this._seq++);
    const arr = this._voices;

    // Full pool: a new sound only gets in by displacing something less important.
    // At equal priority the newcomer is refused rather than stealing, which is
    // what keeps a thirty-way chain reaction from costing a build-and-teardown
    // for every shell after the tenth. You cannot hear the thirtieth anyway.
    let count = 0;
    for (let i = 0; i < arr.length; i++) if (arr[i].pool === pool) count++;
    if (count >= MAXV[pool] && !this._evict(pool, pri)) return null;
    // hard node ceiling — the thing that actually stops the tab from dying
    let guard = 0;
    while (this._nc[pool] > BUDGET[pool] && guard++ < 48) {
      if (!this._evict(pool, pri)) return null;
    }

    const ctx = this._ctx;
    const out = ctx.createGain();
    // o is either the sfx() scratch opts or a voice-layer options bag, which may
    // carry neither vol nor pan. An undefined here is a hard TypeError in Chrome.
    out.gain.value = o ? clamp(fin(o.vol, 1), 0, 4) : 1;
    const v = {
      pool, pri, score, out, nodes: [out], srcs: [], pending: 0,
      end: this._now(), alive: true, owner: null, onend: null,
    };
    v.onend = () => { if (--v.pending <= 0) this._free(v); };
    this._nc[pool]++;

    let tail = out;
    const pan = o ? fin(o.pan, 0) : 0;
    if (Math.abs(pan) > 0.02 && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(pan, -1, 1);
      out.connect(p); tail = p; v.nodes.push(p); this._nc[pool]++;
    }
    tail.connect(dest || this._sfx);
    if (revS > 0) tail.connect(this._sendS[revS < 0.25 ? 0 : revS < 0.5 ? 1 : 2]);
    if (revB > 0) tail.connect(this._sendB[revB < 0.25 ? 0 : revB < 0.5 ? 1 : 2]);

    arr.push(v);
    return v;
  }

  /**
   * Kill the least important voice in `pool` — lowest priority, oldest first —
   * but only if it is strictly less important than `pri`.
   * Voices with no sources yet are still being assembled (a sound that calls the
   * voice layer can re-enter allocation mid-build) — they make no noise, so
   * stealing them would free nothing and would orphan their remaining nodes.
   */
  _evict(pool, pri) {
    const arr = this._voices;
    let wi = -1, ws = Infinity;
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (v.pool !== pool || v.pending === 0) continue;
      if (v.score < ws) { ws = v.score; wi = i; }
    }
    if (wi < 0 || arr[wi].pri >= pri) return false;
    this._kill(arr[wi]);
    return true;
  }

  /**
   * Register a node with a voice so it is guaranteed to be disconnected.
   * If the voice died while it was being built, drop the node on the spot.
   */
  _n(v, node) {
    if (!v.alive) { try { node.disconnect(); } catch (e) { /* gone */ } return node; }
    v.nodes.push(node); this._nc[v.pool]++; return node;
  }

  /** Start + stop + register a source. Every source that exists gets stopped. */
  _go(v, src, t0, dur, offset) {
    if (!v.alive) {
      // voice was stolen mid-build: terminate the source rather than leak it
      const n = this._now();
      try { src.start(n); src.stop(n); } catch (e) { /* ignore */ }
      try { src.disconnect(); } catch (e) { /* ignore */ }
      return src;
    }
    const a = this._t(t0);
    const b = a + Math.max(0.004, fin(dur, 0.1));
    try {
      if (offset === undefined) src.start(a); else src.start(a, offset);
      src.stop(b);
    } catch (e) { return src; }
    v.srcs.push(src); v.pending++;
    src.onended = v.onend;
    if (b > v.end) v.end = b;
    return src;
  }

  _free(v) {
    if (!v.alive) return;
    v.alive = false;
    const nodes = v.nodes;
    for (let i = 0; i < nodes.length; i++) { try { nodes[i].disconnect(); } catch (e) { /* gone */ } }
    this._nc[v.pool] -= nodes.length;
    if (this._nc[v.pool] < 0) this._nc[v.pool] = 0;
    nodes.length = 0; v.srcs.length = 0;
    const i = this._voices.indexOf(v);
    if (i >= 0) this._voices.splice(i, 1);
  }

  _kill(v) {
    if (!v.alive) return;
    const t = this._now();
    for (let i = 0; i < v.srcs.length; i++) {
      const s = v.srcs[i];
      s.onended = null;
      try { s.stop(t); } catch (e) { /* already done */ }
    }
    this._free(v);
  }

  /* -------------------------------------------------------------- mix / API */

  setMaster(x) { this._vMaster = clamp(fin(x, 1), 0, 1); this._ramp(this._master, this._vMaster); }
  setMusicVol(x) { this._vMusic = clamp(fin(x, 1), 0, 1); this._ramp(this._music, this._vMusic); }
  setSfxVol(x) { this._vSfx = clamp(fin(x, 1), 0, 1); this._ramp(this._sfx, this._vSfx); }

  _ramp(node, v) {
    if (!node) return;
    const t = this._now();
    try {
      node.gain.cancelScheduledValues(t);
      node.gain.setValueAtTime(fin(node.gain.value, v), t);
      node.gain.linearRampToValueAtTime(v, t + 0.05);
    } catch (e) { /* never break the game for a volume slider */ }
  }

  /**
   * Pull the music down while the announcer talks. `amount` is the depth of the
   * duck (0.35 => music drops to 65%), held for `seconds`, then released.
   */
  duck(amount = 0.35, seconds = 1.2) {
    if (!this._ready) return;
    const a = clamp(fin(amount, 0.35), 0, 0.95);
    const hold = clamp(fin(seconds, 1.2), 0.05, 30);
    const target = clamp(1 - a, 0.05, 1);
    const t = this._now(), p = this._duck.gain;
    try {
      if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(t); else p.cancelScheduledValues(t);
      p.setValueAtTime(clamp(fin(p.value, 1), 0.02, 1), t);
      p.linearRampToValueAtTime(target, t + 0.07);
      p.setValueAtTime(target, t + 0.07 + hold);
      p.linearRampToValueAtTime(1, t + 0.07 + hold + 0.45);
    } catch (e) { /* ignore */ }
  }

  /** Hard stop. Death, level change, or the player alt-tabbing out of a firefight. */
  panic() {
    if (!this._ready) return;
    for (let i = this._voices.length - 1; i >= 0; i--) this._kill(this._voices[i]);
    for (let i = this._tracks.length - 1; i >= 0; i--) this._drop(this._tracks[i]);
    this._tracks.length = 0;
    this._nc[0] = 0; this._nc[1] = 0;
    const t = this._now();
    try {
      this._duck.gain.cancelScheduledValues(t);
      this._duck.gain.setValueAtTime(1, t);
    } catch (e) { /* ignore */ }
  }

  /* =================================================================== sfx */

  /**
   * Fire a one-shot by name. Never throws, silently no-ops before init() or on
   * an unknown name, and allocates nothing but the nodes it plays.
   * @param {string} name
   * @param {{vol?:number,rate?:number,pan?:number,delay?:number}} opts
   */
  sfx(name, opts = {}) {
    if (!this._ready) return;
    const fn = SFX[name];
    if (!fn) return;
    try {
      const o = this._o;
      o.vol = clamp(fin(opts.vol, 1), 0, 4);
      o.rate = clamp(fin(opts.rate, 1), 0.25, 4);
      o.pan = clamp(fin(opts.pan, 0), -1, 1);
      o.delay = clamp(fin(opts.delay, 0), 0, 20);
      fn(this, this._t(this._now() + o.delay), o);
    } catch (e) { this._err = e; /* a broken sound effect must never stop the game */ }
  }

  /* ============================================================= sequencer */

  /**
   * Start a track, cross-fading from whatever is playing.
   * @param {string} track  title|prowl|siege|boss|victory|gameover
   * @param {{fadeIn?:number,intensity?:number}} opts
   */
  music(track, opts = {}) {
    try {
      const def = TRACKS[track];
      if (!def) return;
      if (!this._ready) { this._pending = { t: track, o: opts }; return; }
      const fade = clamp(fin(opts.fadeIn, 1.5), 0.02, 15);
      const intensity = clamp(fin(opts.intensity, 0.5), 0, 1);

      const cur = this._live();
      if (cur && cur.name === track) { cur.intensity = intensity; return; }
      for (let i = 0; i < this._tracks.length; i++) this._retire(this._tracks[i], fade);

      const ctx = this._ctx, now = this._now();
      const bus = ctx.createGain();
      bus.gain.setValueAtTime(0.0001, now);
      bus.gain.linearRampToValueAtTime(def.gain, now + fade);
      bus.connect(this._duck);

      // Per-track ambience: a damped feedback delay living inside the music bus,
      // so setMusicVol and duck() move the tail with the music. Cheap, and it
      // keeps the two convolvers reserved for the world.
      const [dt, fb, damp] = def.space;
      const send = ctx.createGain(); send.gain.value = 1;
      const dly = ctx.createDelay(1.5); dly.delayTime.value = dt;
      const dmp = ctx.createBiquadFilter(); dmp.type = 'lowpass'; dmp.frequency.value = damp;
      const fbg = ctx.createGain(); fbg.gain.value = fb;
      send.connect(dly); dly.connect(dmp); dmp.connect(fbg); fbg.connect(dly); dmp.connect(bus);

      const spb = def.spb;
      const t = {
        name: track, def, bus, send, nodes: [bus, send, dly, dmp, fbg],
        stepDur: 60 / def.bpm / 4, spb, total: def.loop ? Infinity : spb * def.bars,
        step: 0, nextTime: now + 0.06, intensity, dying: false, endsAt: 0,
      };
      this._tracks.push(t);
    } catch (e) { this._err = e; /* music must never take the game down */ }
  }

  stopMusic(fade = 1.0) {
    if (!this._ready) { this._pending = null; return; }
    const f = clamp(fin(fade, 1), 0.02, 15);
    for (let i = 0; i < this._tracks.length; i++) this._retire(this._tracks[i], f);
  }

  /** The newest track that is still allowed to schedule notes. */
  _live() {
    for (let i = this._tracks.length - 1; i >= 0; i--) if (!this._tracks[i].dying) return this._tracks[i];
    return null;
  }

  _retire(t, fade) {
    if (t.dying) return;
    t.dying = true;
    const now = this._now(), p = t.bus.gain;
    try {
      if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(now); else p.cancelScheduledValues(now);
      p.setValueAtTime(clamp(fin(p.value, t.def.gain), 0.0001, 4), now);
      p.exponentialRampToValueAtTime(0.0001, now + fade);
      p.linearRampToValueAtTime(0, now + fade + 0.02);
    } catch (e) { /* ignore */ }
    t.endsAt = now + fade + 0.06;
  }

  _drop(t) {
    for (let i = this._voices.length - 1; i >= 0; i--) {
      if (this._voices[i].owner === t) this._kill(this._voices[i]);
    }
    for (let i = 0; i < t.nodes.length; i++) { try { t.nodes[i].disconnect(); } catch (e) { /* gone */ } }
    t.nodes.length = 0;
    const i = this._tracks.indexOf(t);
    if (i >= 0) this._tracks.splice(i, 1);
  }

  /** Called ~60x/s. Sweeps dead voices and runs the lookahead scheduler. */
  update(dt) {
    if (!this._ready) return;
    try {
      const now = this._now();

      // safety sweep: anything whose sources are long past their stop time
      const vs = this._voices;
      for (let i = vs.length - 1; i >= 0; i--) if (vs[i].end + 0.4 < now) this._kill(vs[i]);

      for (let i = this._tracks.length - 1; i >= 0; i--) {
        const t = this._tracks[i];
        if (t.dying) { if (now >= t.endsAt) this._drop(t); continue; }
        this._advance(t, now);
      }

      // autoplay policy: the context can be suspended out from under us
      if (!this._offline && this._ctx.state === 'suspended' && now - this._lastResume > 1) {
        this._lastResume = now;
        if (this._ctx.resume) this._ctx.resume().catch(() => {});
      }
    } catch (e) { this._err = e; }
  }

  /** Classic lookahead: while the next step falls inside the horizon, schedule it. */
  _advance(t, now) {
    // If the tab was hidden the clock jumped; skip forward on the grid rather
    // than firing a hundred notes into the past.
    if (t.nextTime < now) {
      const skip = Math.ceil((now + 0.02 - t.nextTime) / t.stepDur);
      t.step += skip;
      t.nextTime += skip * t.stepDur;
    }
    const horizon = now + LOOKAHEAD;
    let guard = 0;
    while (t.nextTime < horizon && guard++ < 64) {
      if (t.step >= t.total) {
        this._retire(t, 0.8);
        t.endsAt = Math.max(t.endsAt, t.nextTime + fin(t.def.tail, 2));
        return;
      }
      const fn = STEP[t.name];
      if (fn) { try { fn(this, t, t.step, t.nextTime); } catch (e) { this._err = e; } }
      t.step++;
      t.nextTime += t.stepDur;
    }
  }

  /** Tag a music voice with its track and give it a wet send. */
  _own(v, t, wet) {
    if (!v) return v;
    v.owner = t;
    if (wet > 0) {
      const g = this._ctx.createGain();
      g.gain.value = wet;
      v.out.connect(g);
      g.connect(t.send);
      this._n(v, g);
    }
    return v;
  }

  /* ============================================================ primitives */

  /**
   * Percussive gain envelope. Returns the time the envelope is finished.
   * exponential body, linear tail to a true zero so nothing ever clicks.
   */
  _env(g, t, peak, atk, dec) {
    const p = g.gain, pk = Math.max(1e-4, peak);
    p.setValueAtTime(1e-4, t);
    p.linearRampToValueAtTime(pk, t + atk);
    p.exponentialRampToValueAtTime(pk * 0.0016, t + atk + dec);
    p.linearRampToValueAtTime(0, t + atk + dec + 0.012);
    return atk + dec + 0.02;
  }

  /** Attack / hold / release envelope for sustained material. */
  _ahr(g, t, peak, atk, hold, rel) {
    const p = g.gain, pk = Math.max(1e-4, peak);
    p.setValueAtTime(1e-4, t);
    p.linearRampToValueAtTime(pk, t + atk);
    p.setValueAtTime(pk, t + atk + hold);
    p.exponentialRampToValueAtTime(pk * 0.0016, t + atk + hold + rel);
    p.linearRampToValueAtTime(0, t + atk + hold + rel + 0.015);
    return atk + hold + rel + 0.025;
  }

  /**
   * One oscillator through its own gain. `f2` sweeps the pitch over `sweep` of
   * the duration. Returns the gain node so the caller can re-route it.
   */
  _tone(v, t, dur, a) {
    const ctx = this._ctx;
    const o = ctx.createOscillator();
    o.type = a.type || 'sine';
    const f = Math.max(0.01, fin(a.f, 220));
    o.frequency.setValueAtTime(f, t);
    if (a.f2) {
      const f2 = Math.max(0.01, fin(a.f2, f));
      o.frequency.exponentialRampToValueAtTime(f2, t + dur * fin(a.sweep, 0.9));
    }
    if (a.detune) o.detune.value = fin(a.detune, 0);
    const g = ctx.createGain();
    g.gain.value = 0;
    o.connect(g);
    g.connect(a.to || v.out);
    this._n(v, o); this._n(v, g);
    const len = a.hold !== undefined
      ? this._ahr(g, t, fin(a.g, 0.4), fin(a.atk, 0.004), a.hold, fin(a.rel, dur * 0.5))
      : this._env(g, t, fin(a.g, 0.4), fin(a.atk, 0.004), fin(a.dec, dur));
    this._go(v, o, t, len + 0.01);
    return g;
  }

  /** Noise burst through a biquad. The workhorse: impacts, hats, air, grit. */
  _nz(v, t, dur, a) {
    const ctx = this._ctx;
    const s = ctx.createBufferSource();
    const buf = a.pink ? this._nzP : this._nzW;
    s.buffer = buf;
    s.loop = true;
    if (a.rate && a.rate !== 1) s.playbackRate.value = clamp(fin(a.rate, 1), 0.06, 16);
    const b = ctx.createBiquadFilter();
    b.type = a.type || 'bandpass';
    const f = clamp(fin(a.f, 1200), 10, 20000);
    b.frequency.setValueAtTime(f, t);
    if (a.f2) b.frequency.exponentialRampToValueAtTime(clamp(fin(a.f2, f), 10, 20000), t + dur * fin(a.sweep, 0.95));
    b.Q.value = clamp(fin(a.q, 1), 0.0001, 40);
    const g = ctx.createGain();
    g.gain.value = 0;
    s.connect(b); b.connect(g); g.connect(a.to || v.out);
    this._n(v, s); this._n(v, b); this._n(v, g);
    const len = a.hold !== undefined
      ? this._ahr(g, t, fin(a.g, 0.4), fin(a.atk, 0.003), a.hold, fin(a.rel, dur * 0.5))
      : this._env(g, t, fin(a.g, 0.4), fin(a.atk, 0.003), fin(a.dec, dur));
    this._go(v, s, t, len + 0.01, this._r() * buf.duration * 0.9);
    return g;
  }

  /** Low-frequency oscillator modulating an AudioParam. Costs two nodes. */
  _lfo(v, t, dur, param, rate, depth, type) {
    const ctx = this._ctx;
    const o = ctx.createOscillator();
    o.type = type || 'sine';
    o.frequency.value = clamp(fin(rate, 5), 0.01, 400);
    const d = ctx.createGain();
    d.gain.value = fin(depth, 1);
    o.connect(d); d.connect(param);
    this._n(v, o); this._n(v, d);
    this._go(v, o, t, dur);
    return d;
  }

  /* =========================================================== voice layer */
  // These are the instruments. Every track is built out of them, so the five
  // pieces of music sound like one score played by one band.

  /** Short plucked blip: square/saw through a snapping lowpass. */
  pluck(t0, freq, dur, a = {}) {
    if (!this._ready) return null;
    const v = this._v(fin(a.pri, 3), a, fin(a.revS, 0), fin(a.revB, 0), fin(a.pool, 0), a.dest);
    if (!v) return null;
    const t = this._t(t0), ctx = this._ctx;
    const f = Math.max(1, hzOf(freq));
    const o = ctx.createOscillator();
    o.type = a.type || 'square';
    o.frequency.setValueAtTime(f, t);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    const co = clamp(fin(a.cutoff, f * 7 + 700), 40, 18000);
    lp.frequency.setValueAtTime(co, t);
    lp.frequency.exponentialRampToValueAtTime(Math.max(60, co * 0.16), t + dur * 0.85);
    lp.Q.value = fin(a.q, 3);
    const g = ctx.createGain(); g.gain.value = 0;
    o.connect(lp); lp.connect(g); g.connect(v.out);
    this._n(v, o); this._n(v, lp); this._n(v, g);
    const len = this._env(g, t, fin(a.g, 0.3), fin(a.atk, 0.002), dur);
    this._go(v, o, t, len);
    return v;
  }

  /** Sustained chord pad. One voice holds every note, which keeps nodes cheap. */
  pad(t0, notes, dur, a = {}) {
    if (!this._ready) return null;
    const v = this._v(fin(a.pri, 4), a, fin(a.revS, 0), fin(a.revB, 0), fin(a.pool, 1), a.dest);
    if (!v) return null;
    const t = this._t(t0), ctx = this._ctx;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    const co = clamp(fin(a.cutoff, 1400), 60, 18000);
    lp.frequency.setValueAtTime(co * 0.42, t);
    lp.frequency.linearRampToValueAtTime(co, t + dur * fin(a.open, 0.55));
    lp.frequency.linearRampToValueAtTime(co * 0.55, t + dur);
    lp.Q.value = fin(a.q, 1.2);
    const g = ctx.createGain(); g.gain.value = 0;
    lp.connect(g); g.connect(v.out);
    this._n(v, lp); this._n(v, g);
    const det = fin(a.detune, 9);
    const per = clamp(Math.round(fin(a.voices, 2)), 1, 4);
    const atk = fin(a.atk, dur * 0.3), rel = fin(a.rel, dur * 0.5);
    // sum of N uncorrelated saws grows ~sqrt(N); scale so chords never overshoot
    const peak = fin(a.g, 0.2) / Math.sqrt(Math.max(1, notes.length * per));
    const len = this._ahr(g, t, peak, atk, Math.max(0.01, dur - atk), rel);
    for (let i = 0; i < notes.length; i++) {
      const f = hzOf(notes[i]);
      for (let k = 0; k < per; k++) {
        const o = ctx.createOscillator();
        o.type = a.type || 'sawtooth';
        o.frequency.value = f;
        o.detune.value = (k - (per - 1) / 2) * det * 2 + (this._r() - 0.5) * det;
        o.connect(lp);
        this._n(v, o);
        this._go(v, o, t, len);
      }
    }
    if (a.vib) this._lfo(v, t, len, lp.frequency, fin(a.vib, 0.2), co * 0.18);
    return v;
  }

  /** Two-operator FM bell. The game's theme instrument. */
  fmBell(t0, freq, dur, a = {}) {
    if (!this._ready) return null;
    const v = this._v(fin(a.pri, 5), a, fin(a.revS, 0), fin(a.revB, 0.25), fin(a.pool, 0), a.dest);
    if (!v) return null;
    const t = this._t(t0), ctx = this._ctx;
    const f = Math.max(1, hzOf(freq));
    const car = ctx.createOscillator(); car.type = 'sine'; car.frequency.value = f;
    const mod = ctx.createOscillator(); mod.type = 'sine';
    mod.frequency.value = f * fin(a.ratio, 2.007);
    const mg = ctx.createGain();
    const idx = fin(a.index, 5) * f;
    mg.gain.setValueAtTime(idx, t);
    mg.gain.exponentialRampToValueAtTime(Math.max(1, idx * 0.02), t + dur * 0.55);
    mod.connect(mg); mg.connect(car.frequency);
    const g = ctx.createGain(); g.gain.value = 0;
    car.connect(g); g.connect(v.out);
    this._n(v, car); this._n(v, mod); this._n(v, mg); this._n(v, g);
    const len = this._env(g, t, fin(a.g, 0.28), fin(a.atk, 0.003), dur);
    this._go(v, car, t, len);
    this._go(v, mod, t, len);
    return v;
  }

  /** The floor moving. Sine with a hard downward pitch drop, plus optional grit. */
  subBoom(t0, freq, dur, a = {}) {
    if (!this._ready) return null;
    const v = this._v(fin(a.pri, 7), a, fin(a.revS, 0), fin(a.revB, 0), fin(a.pool, 0), a.dest);
    if (!v) return null;
    const t = this._t(t0);
    const f = Math.max(8, hzOf(freq));
    this._tone(v, t, dur, {
      type: 'sine', f, f2: Math.max(9, f * fin(a.drop, 0.32)), sweep: fin(a.sweep, 0.35),
      g: fin(a.g, 0.85), atk: 0.004, dec: dur,
    });
    if (a.body !== 0) {
      this._nz(v, t, dur * 0.5, {
        type: 'lowpass', f: 190, f2: 70, q: 0.9, g: fin(a.g, 0.85) * 0.28, dec: dur * 0.5, pink: true,
      });
    }
    return v;
  }

  /** Filtered noise hit — every impact, hat, clank and gust in the game. */
  noiseHit(t0, dur, a = {}) {
    if (!this._ready) return null;
    const v = this._v(fin(a.pri, 3), a, fin(a.revS, 0), fin(a.revB, 0), fin(a.pool, 0), a.dest);
    if (!v) return null;
    this._nz(v, this._t(t0), dur, a);
    return v;
  }

  /** 3-7 detuned saws. Analogue brass, choir, and the siege lead. */
  superSaw(t0, freq, dur, a = {}) {
    if (!this._ready) return null;
    const v = this._v(fin(a.pri, 4), a, fin(a.revS, 0), fin(a.revB, 0), fin(a.pool, 1), a.dest);
    if (!v) return null;
    const t = this._t(t0), ctx = this._ctx;
    const f = Math.max(1, hzOf(freq));
    const n = clamp(Math.round(fin(a.n, 5)), 1, 7);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    const co = clamp(fin(a.cutoff, 2200), 60, 18000);
    lp.frequency.setValueAtTime(co * fin(a.co0, 0.5), t);
    lp.frequency.linearRampToValueAtTime(co, t + dur * fin(a.open, 0.4));
    lp.Q.value = fin(a.q, 2);
    const g = ctx.createGain(); g.gain.value = 0;
    lp.connect(g); g.connect(v.out);
    this._n(v, lp); this._n(v, g);
    const atk = fin(a.atk, 0.02);
    const rel = fin(a.rel, dur * 0.4);
    const len = this._ahr(g, t, fin(a.g, 0.22) / Math.sqrt(n), atk, Math.max(0.01, dur - atk), rel);
    const det = fin(a.detune, 14);
    for (let i = 0; i < n; i++) {
      const o = ctx.createOscillator();
      o.type = a.type || 'sawtooth';
      o.frequency.value = f;
      o.detune.value = ((i - (n - 1) / 2) / Math.max(1, (n - 1) / 2)) * det;
      o.connect(lp);
      this._n(v, o);
      this._go(v, o, t, len);
    }
    return v;
  }

  /** Saw into a resonant lowpass with an envelope on the cutoff. 303 lineage. */
  acidBass(t0, freq, dur, a = {}) {
    if (!this._ready) return null;
    const v = this._v(fin(a.pri, 5), a, fin(a.revS, 0), fin(a.revB, 0), fin(a.pool, 1), a.dest);
    if (!v) return null;
    const t = this._t(t0), ctx = this._ctx;
    const f = Math.max(1, hzOf(freq));
    const o = ctx.createOscillator();
    o.type = a.type || 'sawtooth';
    o.frequency.setValueAtTime(f, t);
    if (a.slide) o.frequency.exponentialRampToValueAtTime(Math.max(1, hzOf(a.slide)), t + dur * 0.35);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    const base = clamp(fin(a.cutoff, 260), 40, 16000);
    const peak = clamp(base + fin(a.env, 1900) * (a.accent ? 1.6 : 1), 40, 16000);
    lp.frequency.setValueAtTime(peak, t);
    lp.frequency.exponentialRampToValueAtTime(base, t + Math.max(0.02, dur * fin(a.decay, 0.7)));
    lp.Q.value = clamp(fin(a.q, 9), 0.0001, 30);
    const g = ctx.createGain(); g.gain.value = 0;
    o.connect(lp);
    let tail = lp;
    if (a.drive) {
      const ws = ctx.createWaveShaper();
      ws.curve = a.drive > 1 ? this._crushCurve : this._satCurve;
      ws.oversample = '2x';
      lp.connect(ws); tail = ws; this._n(v, ws);
    }
    tail.connect(g); g.connect(v.out);
    this._n(v, o); this._n(v, lp); this._n(v, g);
    const len = this._env(g, t, fin(a.g, 0.3) * (a.accent ? 1.25 : 1), fin(a.atk, 0.004), dur);
    this._go(v, o, t, len);
    return v;
  }
}

/** Voice-layer pitches are always Hz. Sequencers call mtof() themselves. */
function hzOf(x) { return Math.max(0.01, fin(x, 440)); }

/* ------------------------------------------------------------ curve helpers */

/**
 * Output ceiling: unity below 0.62, tanh knee above, hard ceiling at ~0.95.
 * The curve's input axis is pre-scaled by 0.5 so it covers +-2.0 of headroom.
 */
function limiterCurve(n) {
  const c = new Float32Array(n);
  const K = 0.62, R = 0.33;   // ceiling f(2.0) ~= 0.95
  for (let i = 0; i < n; i++) {
    const u = (i * 2) / (n - 1) - 1;
    const x = u * 2;
    const a = Math.abs(x);
    const y = a <= K ? a : K + R * Math.tanh((a - K) / R);
    c[i] = x < 0 ? -y : y;            // pre-gain is already folded into x
  }
  return c;
}

function curve(k, n) {
  const c = new Float32Array(n);
  const d = Math.tanh(k);
  for (let i = 0; i < n; i++) c[i] = Math.tanh(k * ((i * 2) / (n - 1) - 1)) / d;
  return c;
}

function shapeCurve(n, fn) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = fn(i, n - 1);
  return c;
}

/* ================================================================== tracks */
// Note data is written as scale degrees over ROOT so every track shares one
// harmonic world. mk() routes a voice into the track bus and keeps it away from
// the SFX convolvers (music gets its own space, inside the music bus).

const mk = (t, a) => { a.dest = t.bus; a.pool = 1; a.revS = 0; a.revB = 0; return a; };

/** Dead-thumping kick used by prowl / siege / boss. */
function kick(S, t, T, g, tune, len) {
  const v = S._v(6, null, 0, 0, 1, t.bus);
  if (!v) return;
  v.owner = t;
  S._tone(v, T, len, { type: 'sine', f: 132 * tune, f2: 41 * tune, sweep: 0.16, g, atk: 0.002, dec: len });
  S._nz(v, T, 0.03, { type: 'highpass', f: 1400, q: 0.7, g: g * 0.32, dec: 0.028 });
}

/** Hard snare: tuned body plus a wide noise crack. */
function snare(S, t, T, g) {
  const v = S._v(6, null, 0, 0, 1, t.bus);
  if (!v) return;
  v.owner = t;
  S._tone(v, T, 0.13, { type: 'triangle', f: 196, f2: 138, sweep: 0.5, g: g * 0.5, dec: 0.12 });
  S._nz(v, T, 0.19, { type: 'highpass', f: 1150, q: 0.8, g: g * 0.85, dec: 0.17 });
  S._nz(v, T, 0.09, { type: 'bandpass', f: 340, q: 1.4, g: g * 0.4, dec: 0.08 });
}

/**
 * One noise source through several resonant peaks. Sharing the source is the
 * whole point: correlated formants read as one throat, whereas separate noise
 * per band reads as two filters. Peaks may sweep at different rates, which is
 * how `howler_alert` gets three tones beating against each other.
 *
 * peaks: [{f, f2, sweep, q, g}]   o: {g, atk, dec, hold, rel, pink, rate, rate2}
 */
function gullet(S, v, t, dur, peaks, o) {
  const ctx = S._ctx;
  const src = ctx.createBufferSource();
  const buf = o.pink === false ? S._nzW : S._nzP;
  src.buffer = buf;
  src.loop = true;
  const r0 = clamp(fin(o.rate, 1), 0.06, 16);
  src.playbackRate.setValueAtTime(r0, t);
  if (o.rate2) {
    src.playbackRate.exponentialRampToValueAtTime(clamp(fin(o.rate2, r0), 0.06, 16), t + dur * 0.9);
  }
  const g = ctx.createGain();
  g.gain.value = 0;
  src.connect(g);
  S._n(v, src); S._n(v, g);
  for (let i = 0; i < peaks.length; i++) {
    const p = peaks[i];
    const b = ctx.createBiquadFilter();
    b.type = p.type || 'bandpass';
    const f = clamp(fin(p.f, 800), 20, 18000);
    b.frequency.setValueAtTime(f, t);
    if (p.f2) b.frequency.exponentialRampToValueAtTime(clamp(fin(p.f2, f), 20, 18000), t + dur * fin(p.sweep, 0.9));
    b.Q.value = clamp(fin(p.q, 9), 0.0001, 40);
    const bg = ctx.createGain();
    bg.gain.value = fin(p.g, 0.3);
    g.connect(b); b.connect(bg); bg.connect(o.to || v.out);
    S._n(v, b); S._n(v, bg);
  }
  const len = o.hold !== undefined
    ? S._ahr(g, t, fin(o.g, 0.5), fin(o.atk, 0.01), o.hold, fin(o.rel, dur * 0.4))
    : S._env(g, t, fin(o.g, 0.5), fin(o.atk, 0.01), fin(o.dec, dur));
  S._go(v, src, t, len + 0.01, S._r() * buf.duration * 0.9);
  return g;
}

/**
 * Re-route a layer through a generated amplitude curve — the granular gate that
 * turns smooth noise into spatter, chittering or claws. Costs one node.
 */
function gate(S, v, node, curveArr, t, dur) {
  const cg = S._ctx.createGain();
  cg.gain.setValueCurveAtTime(curveArr, t, dur);
  cg.gain.setValueAtTime(0, t + dur + 0.002);
  node.disconnect();
  node.connect(cg);
  cg.connect(v.out);
  S._n(v, cg);
  return cg;
}

function hat(S, t, T, g, open) {
  const v = S._v(2, null, 0, 0, 1, t.bus);
  if (!v) return;
  v.owner = t;
  S._nz(v, T, open ? 0.26 : 0.045, {
    type: 'highpass', f: open ? 6200 : 7600, q: 0.7, g, dec: open ? 0.24 : 0.04,
  });
}

const STEP = {

  /* ---- TITLE — 78 BPM, D Phrygian. Slow, enormous, and it wants to be heard. */
  title(S, t, s, T) {
    const st = s % 64, bar = st >> 4, phase = (s / 64) | 0;
    const barLen = t.stepDur * 16;
    const CH = [CHORD.i, CHORD.bVI, CHORD.bII, CHORD.i][bar];
    const chRoot = [0, 8, 1, 0][bar];

    if (st % 16 === 0) {
      // detuned analogue brass, chord in the middle octave plus its own root
      const f = [];
      for (let i = 0; i < CH.length; i++) f.push(mtof(ROOT + 12 + CH[i]));
      f.push(mtof(ROOT + CH[0]));
      S._own(S.pad(T, f, barLen * 1.2, mk(t, {
        g: 0.62, detune: 12, voices: 2, cutoff: bar === 2 ? 1600 : 1150,
        atk: barLen * 0.34, rel: barLen * 0.6, q: 1.1, pri: 6, vib: 0.13,
      })), t, 0.42);
      // low brass underneath — the thing that makes the room feel big
      S._own(S.superSaw(T, mtof(ROOT - 12 + chRoot), barLen * 1.1, mk(t, {
        n: 3, detune: 7, cutoff: 380, co0: 0.6, g: 0.34,
        atk: barLen * 0.22, rel: barLen * 0.5, pri: 6,
      })), t, 0.1);
    }

    // stalking bass: four deliberate steps a bar, never quite settling
    const BP = [0, 6, 8, 14];
    const BD = [[0, 0, 7, 3], [8, 8, 3, 10], [1, 1, 8, 5], [0, 0, 10, 7]][bar];
    const bi = BP.indexOf(st % 16);
    if (bi >= 0) {
      S._own(S.acidBass(T, mtof(ROOT - 12 + BD[bi]), t.stepDur * (bi === 3 ? 3.4 : 2.1), mk(t, {
        cutoff: 190, env: 620, q: 6, g: 0.38, decay: 0.5, drive: 1, pri: 6,
      })), t, 0.12);
    }

    // the theme: four notes, a long way apart, with the room around them
    const MPOS = [20, 26, 34, 44];
    const mi = MPOS.indexOf(st);
    if (mi >= 0) {
      const n = MOTIF[mi] + (phase % 2 === 1 && mi === 3 ? 5 : 0);
      S._own(S.fmBell(T, mtof(n), 2.9, mk(t, {
        g: 0.34, ratio: 2.007, index: 4.2, atk: 0.004, pri: 8,
      })), t, 0.62);
      if (mi === 3) {
        S._own(S.fmBell(T + 0.09, mtof(n - 12), 3.4, mk(t, {
          g: 0.16, ratio: 1.41, index: 2.4, pri: 7,
        })), t, 0.7);
      }
    }

    // distant sub booms — somebody else's war, two rooms away
    if (st === 0 && (phase & 1) === 0) {
      S._own(S.subBoom(T, 47, 1.9, mk(t, { g: 0.6, drop: 0.4, sweep: 0.4, pri: 8 })), t, 0.3);
    }
    if (st === 40) {
      S._own(S.subBoom(T, 33, 2.6, mk(t, { g: 0.34, drop: 0.5, sweep: 0.55, pri: 7 })), t, 0.85);
    }
    // wind through the intake shafts
    if (st === 48) {
      S._own(S.noiseHit(T, 2.6, mk(t, {
        type: 'bandpass', f: 260, f2: 620, q: 2.2, g: 0.1, atk: 0.9, dec: 1.7, pink: true, pri: 4,
      })), t, 0.8);
    }
  },

  /* ---- PROWL — 104 BPM. Corridors. Sparse on purpose: SFX owns the midrange. */
  prowl(S, t, s, T) {
    const st = s % 16, bar = (s / 16) | 0, vari = (bar >> 3) & 3;
    const barLen = t.stepDur * 16;

    const PKICK = [[0, 6, 10], [0, 3, 8, 11], [0, 6, 10, 14], [0, 7, 10]][vari];
    if (PKICK.indexOf(st) >= 0) kick(S, t, T, 0.72, 0.94, 0.34);

    // industrial metal: deterministic per bar, so it varies but never wanders
    if (h2(bar * 3 + vari, st * 7) > 0.76) {
      const f = 420 * (1 + 3.4 * h2(st, bar + 7));
      const v = S._v(3, null, 0, 0, 1, t.bus);
      if (v) {
        v.owner = t;
        const d = 0.05 + 0.12 * h2(bar, st + 31);
        S._nz(v, T, d, { type: 'bandpass', f, q: 11, g: 0.2, dec: d });
        S._nz(v, T, 0.02, { type: 'highpass', f: 3800, q: 0.7, g: 0.09, dec: 0.02 });
        S._own(v, t, 0.4);
      }
    }
    if (st === 4 || st === 12) {
      const v = S._v(4, null, 0, 0, 1, t.bus);
      if (v) {
        v.owner = t;
        const f = [1180, 860, 1460, 640][vari];
        for (let k = 0; k < 3; k++) {
          S._nz(v, T, 0.3, { type: 'bandpass', f: f * METAL[k], q: 16, g: 0.09 / (k + 1), dec: 0.28 });
        }
        S._own(v, t, 0.55);
      }
    }
    if (st % 2 === 1) hat(S, t, T, 0.05, false);

    // the drone that never quite lets you relax
    if (st === 0 && bar % 2 === 0) {
      S._own(S.superSaw(T, mtof(ROOT - 12), barLen * 2.1, mk(t, {
        n: 3, detune: 6, cutoff: 210, co0: 0.7, g: 0.27,
        atk: barLen * 0.4, rel: barLen * 0.8, pri: 6,
      })), t, 0.1);
      if (vari >= 2) {
        S._own(S.superSaw(T + 0.02, mtof(ROOT - 5), barLen * 2.05, mk(t, {
          n: 2, detune: 9, cutoff: 300, g: 0.13, atk: barLen * 0.5, rel: barLen * 0.7, pri: 5,
        })), t, 0.25);
      }
    }
    // dissonant stab at the end of every eight bars
    if (bar % 8 === 7 && st === 12) {
      const cl = [deg(7) + 1, deg(11), deg(14) + 1];   // Eb / C / Eb, a semitone apart
      S._own(S.pad(T, [mtof(ROOT + cl[0]), mtof(ROOT + cl[1]), mtof(ROOT + cl[2])], 0.75, mk(t, {
        g: 0.3, detune: 16, voices: 1, cutoff: 2400, atk: 0.01, rel: 0.55, q: 3, pri: 7,
      })), t, 0.75);
    }
    // something enormous going off a long way above you
    if (bar % 4 === 2 && st === 8) {
      S._own(S.subBoom(T, 37, 2.4, mk(t, { g: 0.34, drop: 0.5, sweep: 0.6, pri: 7 })), t, 0.8);
    }
  },

  /* ---- SIEGE — 148 BPM. Missile Command. intensity adds layers, not volume. */
  siege(S, t, s, T) {
    const st = s % 16, bar = (s / 16) | 0;
    const I = t.intensity;
    const SB = [0, 0, 12, 0, 0, 10, 0, 12, 0, 0, 15, 0, 10, 0, 12, 3];

    if (st % 4 === 0) kick(S, t, T, 0.85, 1, 0.3);
    if (st === 4 || st === 12) snare(S, t, T, 0.5);
    if (st % 2 === 1) hat(S, t, T, 0.075 + I * 0.05, false);
    if (I > 0.45 && st % 4 === 2) hat(S, t, T, 0.07, true);

    // relentless 16ths
    S._own(S.acidBass(T, mtof(ROOT + SB[st]), t.stepDur * 0.92, mk(t, {
      cutoff: 220 + I * 900, env: 1400 + I * 2400, q: 10.5, g: 0.3,
      accent: st % 4 === 0 || st === 10, decay: 0.62, drive: 1, pri: 6,
    })), t, 0.06);
    if (I > 0.3 && st % 2 === 0) {
      S._own(S.acidBass(T, mtof(ROOT + 12 + SB[st]), t.stepDur * 0.8, mk(t, {
        cutoff: 500 + I * 1400, env: 900, q: 7, g: 0.1, decay: 0.5, pri: 4,
      })), t, 0.15);
    }

    // arpeggiated lead, doubled an octave up when it gets hairy
    const CH = [CHORD.i, CHORD.i, CHORD.bVII, CHORD.bVI][bar % 4];
    const ARP = [0, 1, 2, 3, 2, 3, 1, 2];
    const dense = I > 0.62 ? 1 : 2;
    if (I > 0.12 && st % dense === 0) {
      const n = ROOT + 24 + CH[ARP[st % 8]];
      S._own(S.pluck(T, mtof(n), t.stepDur * 1.5, mk(t, {
        type: 'sawtooth', g: 0.13 + I * 0.06, cutoff: 1400 + I * 3600, q: 4, pri: 5,
      })), t, 0.3);
      if (I > 0.72) {
        S._own(S.pluck(T + 0.004, mtof(n + 12), t.stepDur * 1.1, mk(t, {
          type: 'square', g: 0.055, cutoff: 5200, q: 2, pri: 4,
        })), t, 0.45);
      }
    }
    // eight-bar riser into the next phase of the wave
    if (bar % 8 === 7 && st === 0) {
      S._own(S.noiseHit(T, 1.7, mk(t, {
        type: 'bandpass', f: 220, f2: 6200, q: 3, g: 0.14, atk: 1.5, dec: 0.2, pri: 6,
      })), t, 0.5);
    }
    if (bar % 8 === 0 && st === 0) {
      S._own(S.subBoom(T, 52, 1.1, mk(t, { g: 0.5, drop: 0.35, pri: 7 })), t, 0.25);
    }
  },

  /* ---- BOSS — MUTTER. 132 BPM in 7/8, so it never sits down. */
  boss(S, t, s, T) {
    const st = s % 14, bar = ((s / 14) | 0) % 4;
    const barLen = t.stepDur * 14;
    const CH = [CHORD.i, CHORD.bII, CHORD.i, CHORD.bVI][bar];

    if (st === 0 || st === 6 || st === 10) kick(S, t, T, 0.9, 0.9, 0.4);
    if (st === 13 && bar % 2 === 1) kick(S, t, T, 0.4, 1.1, 0.2);
    if (st === 6) snare(S, t, T, 0.45);
    if (st === 3 || st === 9) hat(S, t, T, 0.06, st === 9);

    // monstrous distorted bass, seven eighths of it
    if (st % 2 === 0) {
      const RIFF = [0, 0, 1, 0, 3, -2, 0];
      S._own(S.acidBass(T, mtof(ROOT - 12 + RIFF[st / 2] + (CH === CHORD.bVI ? 8 : 0)), t.stepDur * 1.85, mk(t, {
        cutoff: 130, env: 780, q: 8, g: 0.42, decay: 0.75, drive: 2, pri: 7,
      })), t, 0.1);
    }
    // choir: badly-tuned, far too many voices, entirely sincere
    if (st === 0) {
      const f = [];
      for (let i = 0; i < CH.length; i++) f.push(mtof(ROOT + 12 + CH[i]));
      S._own(S.pad(T, f, barLen * 1.25, mk(t, {
        type: 'sawtooth', g: 0.42, detune: 19, voices: 3, cutoff: 1250,
        atk: barLen * 0.3, rel: barLen * 0.55, q: 2.2, vib: 0.9, pri: 7,
      })), t, 0.55);
    }
    if (st === 0 && bar % 2 === 0) {
      S._own(S.subBoom(T, 41, 1.5, mk(t, { g: 0.62, drop: 0.42, pri: 8 })), t, 0.2);
    }
    // toms falling down the stairs
    if ((bar === 1 && st === 9) || (bar === 3 && st === 11) || (bar === 2 && st === 12)) {
      const v = S._v(5, null, 0, 0, 1, t.bus);
      if (v) {
        v.owner = t;
        S._tone(v, T, 0.34, { type: 'sine', f: 150, f2: 78, sweep: 0.6, g: 0.5, dec: 0.32 });
        S._nz(v, T, 0.12, { type: 'bandpass', f: 620, q: 2, g: 0.16, dec: 0.11 });
        S._own(v, t, 0.5);
      }
    }
  },

  /* ---- VICTORY — 120 BPM, the theme finally allowed to be in a major key. */
  victory(S, t, s, T) {
    const st = s % 16, bar = (s / 16) | 0;
    const barLen = t.stepDur * 16;
    const PROG = [CHORD.I, CHORD.IV, CHORD.V, CHORD.I, CHORD.IV, CHORD.V, CHORD.I];
    const CH = PROG[Math.min(bar, 6)];

    if (st === 0) {
      const f = [];
      for (let i = 0; i < CH.length; i++) f.push(mtof(ROOT + 12 + CH[i]));
      S._own(S.pad(T, f, barLen * (bar === 6 ? 3.4 : 1.15), mk(t, {
        g: 0.6, detune: 10, voices: 2, cutoff: 2600, atk: bar === 0 ? 0.5 : 0.09,
        rel: barLen * (bar === 6 ? 2.4 : 0.5), pri: 7,
      })), t, 0.4);
      S._own(S.superSaw(T, mtof(ROOT - 12 + CH[0]), barLen * 1.05, mk(t, {
        n: 3, detune: 7, cutoff: 520, g: 0.34, atk: 0.04, rel: barLen * 0.5, pri: 6,
      })), t, 0.1);
      S._own(S.subBoom(T, 58, 1.1, mk(t, { g: 0.7, drop: 0.4, pri: 8 })), t, 0.3);
    }
    if (st % 4 === 0 && bar < 6) kick(S, t, T, 0.6, 1.05, 0.26);
    if ((st === 8 || st === 14) && bar < 6) snare(S, t, T, 0.4);

    // fanfare
    if (bar < 4 && st % 2 === 0) {
      const A = [0, 2, 1, 3, 2, 3, 1, 0];
      S._own(S.pluck(T, mtof(ROOT + 24 + CH[A[st / 2]]), 0.4, mk(t, {
        type: 'sawtooth', g: 0.16, cutoff: 4200, q: 3, pri: 6,
      })), t, 0.35);
    }
    // the theme, in the parallel major, at last
    const VM = [86, 84, 81, 86];
    const VP = [64, 72, 80, 96];
    const vi = VP.indexOf(s);
    if (vi >= 0) {
      S._own(S.fmBell(T, mtof(VM[vi]), vi === 3 ? 4.5 : 1.6, mk(t, {
        g: 0.34, ratio: 2.007, index: 3.6, pri: 8,
      })), t, 0.55);
      S._own(S.fmBell(T + 0.01, mtof(VM[vi] - 12), vi === 3 ? 5 : 1.4, mk(t, {
        g: 0.18, ratio: 1.41, index: 2, pri: 7,
      })), t, 0.6);
    }
  },

  /* ---- GAMEOVER — 62 BPM. Six cities. Nobody is going to say well done. */
  gameover(S, t, s, T) {
    const st = s % 16, bar = (s / 16) | 0;
    const barLen = t.stepDur * 16;
    const PROG = [CHORD.i, CHORD.bVI, CHORD.iv, CHORD.bII];
    const CH = PROG[Math.min(bar, 3)];

    if (st === 0) {
      const f = [];
      for (let i = 0; i < CH.length; i++) f.push(mtof(ROOT + 12 + CH[i]));
      S._own(S.pad(T, f, barLen * (bar === 3 ? 2.6 : 1.15), mk(t, {
        g: 0.5, detune: 13, voices: 2, cutoff: 780, atk: barLen * 0.35,
        rel: barLen * (bar === 3 ? 1.8 : 0.6), q: 1.4, vib: 0.11, pri: 7,
      })), t, 0.6);
      S._own(S.superSaw(T, mtof(ROOT - 12 + CH[0]), barLen * 1.2, mk(t, {
        n: 3, detune: 5, cutoff: 240, g: 0.3, atk: barLen * 0.3, rel: barLen * 0.7, pri: 6,
      })), t, 0.15);
    }
    // a bell tolling down through the scale, slower each time
    const GM = [74, 72, 70, 69];
    const GP = [8, 22, 38, 56];
    const gi = GP.indexOf(s);
    if (gi >= 0) {
      S._own(S.fmBell(T, mtof(GM[gi]), 3.2 + gi * 0.9, mk(t, {
        g: 0.3 - gi * 0.03, ratio: 2.007, index: 3.4, pri: 8,
      })), t, 0.72);
    }
    if (s === 56) {
      S._own(S.fmBell(T + 0.6, mtof(50), 6, mk(t, { g: 0.26, ratio: 1.41, index: 2.6, pri: 8 })), t, 0.8);
      S._own(S.subBoom(T + 0.6, 30, 4, mk(t, { g: 0.4, drop: 0.6, sweep: 0.7, pri: 8 })), t, 0.5);
    }
    if (st === 0 && bar === 0) {
      S._own(S.subBoom(T, 44, 2.6, mk(t, { g: 0.5, drop: 0.45, pri: 8 })), t, 0.4);
    }
    // dust falling off the ceiling
    if (st === 9 || st === 13) {
      S._own(S.noiseHit(T, 1.4, mk(t, {
        type: 'bandpass', f: 380, q: 3, g: 0.055, atk: 0.5, dec: 0.85, pink: true, pri: 3,
      })), t, 0.7);
    }
  },
};

/* ===================================================================== SFX */
// Every name the game can call. A missing name is a silent no-op, never a throw.
// revS = concrete-corridor send, revB = open-deck send. Sky things get revB.

/** One-shot voice on the sfx bus, carrying the caller's vol/pan. */
const V = (S, o, pri, revS, revB) => S._v(pri, o, revS, revB, 0, null);

const SFX = {

  /* ------------------------------------------------------------- weapons */

  flak_fire(S, t, o) {
    const v = V(S, o, 6, 0.3, 0.12); if (!v) return;
    const r = o.rate;
    S._tone(v, t, 0.3, { type: 'sine', f: 168 * r, f2: 44 * r, sweep: 0.2, g: 0.8, dec: 0.26 });
    S._nz(v, t, 0.17, { type: 'lowpass', f: 880 * r, f2: 250, q: 1.1, g: 0.5, dec: 0.15, pink: true });
    S._nz(v, t + 0.019, 0.055, { type: 'bandpass', f: 2750 * r, q: 5.5, g: 0.3, dec: 0.045 });
    S._nz(v, t + 0.03, 0.24, { type: 'highpass', f: 1700, q: 0.7, g: 0.09, dec: 0.22 });
  },

  flak_arm(S, t, o) {
    const v = V(S, o, 2, 0.14, 0); if (!v) return;
    S._tone(v, t, 0.02, { type: 'square', f: 1850 * o.rate, g: 0.2, atk: 0.0008, dec: 0.016 });
    S._nz(v, t, 0.014, { type: 'bandpass', f: 3600, q: 8, g: 0.16, dec: 0.012 });
  },

  // The money sound: crack, body, and a tail that rolls away across the deck.
  airburst(S, t, o) {
    const v = V(S, o, 9, 0.22, 0.7); if (!v) return;
    const r = o.rate;
    S._nz(v, t, 0.085, { type: 'highpass', f: 2100 * r, q: 0.7, g: 0.95, atk: 0.0015, dec: 0.075 });
    S._tone(v, t + 0.004, 0.75, { type: 'sine', f: 108 * r, f2: 30 * r, sweep: 0.42, g: 0.95, dec: 0.62 });
    S._nz(v, t + 0.004, 0.9, { type: 'lowpass', f: 540, f2: 115, q: 1.2, g: 0.8, atk: 0.006, dec: 0.82, pink: true });
    S._nz(v, t + 0.05, 2.5, { type: 'bandpass', f: 240, f2: 92, q: 0.9, g: 0.42, atk: 0.1, dec: 2.3, pink: true });
    S._nz(v, t + 0.02, 0.75, { type: 'highpass', f: 3300, q: 0.6, g: 0.15, atk: 0.004, dec: 0.7 });
  },

  // The chain secondary. Thirty of these can land in one frame, so it is two
  // layers: a lowpass that opens at the transient is the crack and the body both.
  airburst_small(S, t, o) {
    const v = V(S, o, 7, 0.2, 0.5); if (!v) return;
    const r = o.rate * (0.88 + S._r() * 0.3);
    S._tone(v, t, 0.34, { type: 'sine', f: 168 * r, f2: 52 * r, sweep: 0.4, g: 0.6, dec: 0.3 });
    S._nz(v, t, 0.85, {
      type: 'lowpass', f: 4200 * r, f2: 175, q: 1.1, g: 0.62, atk: 0.0015, dec: 0.8, sweep: 0.13, pink: true,
    });
  },

  // Ten a second. Six nodes, and the pitch walks so it never buzzes.
  nailer_fire(S, t, o) {
    const v = V(S, o, 5, 0.18, 0); if (!v) return;
    const j = 0.93 + S._r() * 0.16;
    const r = o.rate * j;
    S._nz(v, t, 0.05, { type: 'bandpass', f: 1550 * r, q: 3.2, g: 0.5, atk: 0.001, dec: 0.045 });
    S._tone(v, t, 0.055, { type: 'square', f: 235 * r, f2: 92 * r, sweep: 0.55, g: 0.28, atk: 0.001, dec: 0.05 });
  },

  halo_fire(S, t, o) {
    const v = V(S, o, 7, 0.2, 0.45); if (!v) return;
    const r = o.rate;
    S._nz(v, t, 0.4, { type: 'bandpass', f: 300 * r, f2: 3100 * r, q: 2.4, g: 0.4, atk: 0.16, dec: 0.24 });
    S._tone(v, t + 0.3, 1.3, { type: 'sine', f: 1180 * r, g: 0.24, atk: 0.01, dec: 1.25 });
    S._tone(v, t + 0.3, 1.1, { type: 'sine', f: 1772 * r, g: 0.11, atk: 0.012, dec: 1.05 });
    S._tone(v, t + 0.3, 0.9, { type: 'sine', f: 2360 * r, g: 0.05, atk: 0.014, dec: 0.85 });
  },

  halo_sweep(S, t, o) {
    const v = V(S, o, 4, 0.16, 0.4); if (!v) return;
    S._nz(v, t, 0.55, { type: 'bandpass', f: 220 * o.rate, f2: 4200 * o.rate, q: 3.4, g: 0.34, atk: 0.24, dec: 0.3 });
    S._nz(v, t, 0.5, { type: 'highpass', f: 900, q: 0.7, g: 0.08, atk: 0.3, dec: 0.2 });
  },

  deadman_arm(S, t, o) {
    const v = V(S, o, 6, 0.3, 0.2); if (!v) return;
    const N = [392, 466, 587];
    for (let i = 0; i < 3; i++) {
      S._tone(v, t + i * 0.17, 0.1, { type: 'square', f: N[i] * o.rate, g: 0.2, atk: 0.004, dec: 0.09 });
    }
    S._tone(v, t, 0.62, { type: 'sawtooth', f: 55, f2: 62, sweep: 0.9, g: 0.1, atk: 0.2, dec: 0.4 });
  },

  deadman_blow(S, t, o) {
    const v = V(S, o, 10, 0.2, 0.85); if (!v) return;
    S._nz(v, t, 0.1, { type: 'highpass', f: 1500, q: 0.7, g: 0.8, atk: 0.002, dec: 0.09 });
    S._tone(v, t, 1.7, { type: 'sine', f: 66, f2: 17, sweep: 0.55, g: 1.1, atk: 0.006, dec: 1.5 });
    S._nz(v, t, 2.6, { type: 'lowpass', f: 420, f2: 80, q: 1.3, g: 0.85, atk: 0.012, dec: 2.4, pink: true });
    S._nz(v, t + 0.34, 2.2, { type: 'bandpass', f: 190, f2: 70, q: 0.8, g: 0.5, atk: 0.12, dec: 2, pink: true });
    S._tone(v, t + 0.34, 1.2, { type: 'sine', f: 44, f2: 14, sweep: 0.6, g: 0.6, atk: 0.02, dec: 1.1 });
  },

  pistol_fire(S, t, o) {
    const v = V(S, o, 5, 0.3, 0.1); if (!v) return;
    const r = o.rate;
    S._nz(v, t, 0.1, { type: 'highpass', f: 1300 * r, q: 0.7, g: 0.62, atk: 0.001, dec: 0.09 });
    S._tone(v, t, 0.11, { type: 'square', f: 330 * r, f2: 105 * r, sweep: 0.4, g: 0.3, atk: 0.001, dec: 0.1 });
    S._nz(v, t + 0.01, 0.3, { type: 'lowpass', f: 700, q: 1, g: 0.16, dec: 0.28, pink: true });
  },

  dryfire(S, t, o) {
    const v = V(S, o, 2, 0.2, 0); if (!v) return;
    S._nz(v, t, 0.022, { type: 'bandpass', f: 1650 * o.rate, q: 8, g: 0.34, atk: 0.0008, dec: 0.02 });
    S._tone(v, t, 0.018, { type: 'square', f: 140, f2: 90, g: 0.1, atk: 0.0008, dec: 0.016 });
  },

  reload(S, t, o) {
    const v = V(S, o, 4, 0.25, 0); if (!v) return;
    const F = [2100, 1350, 900];
    for (let i = 0; i < 3; i++) {
      S._nz(v, t + i * 0.13, 0.05, { type: 'bandpass', f: F[i] * o.rate, q: 6, g: 0.26, atk: 0.001, dec: 0.045 });
    }
    S._tone(v, t + 0.27, 0.13, { type: 'square', f: 150, f2: 62, sweep: 0.4, g: 0.24, atk: 0.002, dec: 0.12 });
  },

  weapon_switch(S, t, o) {
    const v = V(S, o, 3, 0.2, 0); if (!v) return;
    S._nz(v, t, 0.04, { type: 'bandpass', f: 1900, q: 7, g: 0.22, atk: 0.001, dec: 0.035 });
    S._nz(v, t + 0.06, 0.14, { type: 'bandpass', f: 700, f2: 2400, q: 2.5, g: 0.16, atk: 0.05, dec: 0.09 });
    S._tone(v, t + 0.09, 0.1, { type: 'triangle', f: 220, f2: 330, sweep: 0.7, g: 0.16, dec: 0.09 });
  },
};

/* ------------------------------------------------------- impacts / world */

Object.assign(SFX, {

  hit_wall(S, t, o) {
    const v = V(S, o, 3, 0.35, 0); if (!v) return;
    const r = o.rate;
    S._nz(v, t, 0.13, { type: 'lowpass', f: 760 * r, f2: 300, q: 1.2, g: 0.45, atk: 0.001, dec: 0.12 });
    S._nz(v, t, 0.19, { type: 'highpass', f: 3200, q: 0.7, g: 0.1, atk: 0.002, dec: 0.18 });
  },

  hit_flesh(S, t, o) {
    const v = V(S, o, 4, 0.25, 0); if (!v) return;
    S._nz(v, t, 0.18, { type: 'lowpass', f: 330 * o.rate, f2: 150, q: 1.4, g: 0.55, atk: 0.001, dec: 0.17, pink: true });
    S._tone(v, t, 0.16, { type: 'sine', f: 118, f2: 58, sweep: 0.5, g: 0.34, dec: 0.15 });
    S._nz(v, t + 0.008, 0.07, { type: 'bandpass', f: 940, q: 2.2, g: 0.2, dec: 0.06 });
  },

  ricochet(S, t, o) {
    const v = V(S, o, 4, 0.4, 0.15); if (!v) return;
    const r = o.rate * (0.85 + S._r() * 0.35);
    S._tone(v, t, 0.3, { type: 'triangle', f: 2700 * r, f2: 640 * r, sweep: 0.95, g: 0.28, atk: 0.002, dec: 0.28 });
    S._nz(v, t, 0.1, { type: 'bandpass', f: 3200 * r, f2: 1200, q: 4, g: 0.2, atk: 0.001, dec: 0.09 });
  },

  barrel_explode(S, t, o) {
    const v = V(S, o, 8, 0.4, 0.35); if (!v) return;
    S._nz(v, t, 0.07, { type: 'highpass', f: 1900, q: 0.7, g: 0.8, atk: 0.0015, dec: 0.06 });
    S._tone(v, t, 0.55, { type: 'sine', f: 128, f2: 36, sweep: 0.4, g: 0.85, dec: 0.5 });
    S._nz(v, t, 1.1, { type: 'lowpass', f: 700, f2: 160, q: 1.2, g: 0.6, atk: 0.005, dec: 1, pink: true });
    for (let k = 1; k < 4; k++) {
      S._nz(v, t + 0.02 + k * 0.03, 0.5, {
        type: 'bandpass', f: 780 * METAL[k], q: 12, g: 0.14 / k, atk: 0.002, dec: 0.45,
      });
    }
  },

  door_open(S, t, o) {
    const v = V(S, o, 6, 0.55, 0.1); if (!v) return;
    S._tone(v, t, 1.7, { type: 'sawtooth', f: 48, f2: 72, sweep: 0.8, g: 0.3, atk: 0.25, hold: 1.0, rel: 0.4 });
    S._nz(v, t, 1.6, { type: 'lowpass', f: 240, f2: 620, q: 4.5, g: 0.4, atk: 0.3, dec: 1.2, pink: true });
    S._nz(v, t + 0.1, 1.3, { type: 'bandpass', f: 1400, f2: 700, q: 3, g: 0.11, atk: 0.4, dec: 0.85 });
    S._nz(v, t + 1.55, 0.3, { type: 'bandpass', f: 320, q: 3, g: 0.34, atk: 0.002, dec: 0.28 });
  },

  door_close(S, t, o) {
    const v = V(S, o, 6, 0.55, 0.1); if (!v) return;
    S._tone(v, t, 1.3, { type: 'sawtooth', f: 74, f2: 44, sweep: 0.85, g: 0.3, atk: 0.2, hold: 0.7, rel: 0.35 });
    S._nz(v, t, 1.2, { type: 'lowpass', f: 560, f2: 200, q: 4, g: 0.36, atk: 0.25, dec: 0.9, pink: true });
    S._nz(v, t + 1.25, 0.45, { type: 'lowpass', f: 420, f2: 130, q: 1.6, g: 0.7, atk: 0.002, dec: 0.42 });
    S._tone(v, t + 1.25, 0.4, { type: 'sine', f: 96, f2: 44, sweep: 0.4, g: 0.5, dec: 0.36 });
  },

  door_locked(S, t, o) {
    const v = V(S, o, 5, 0.4, 0); if (!v) return;
    S._nz(v, t, 0.22, { type: 'lowpass', f: 300, f2: 150, q: 1.6, g: 0.6, atk: 0.002, dec: 0.2 });
    S._tone(v, t, 0.2, { type: 'sine', f: 84, f2: 52, sweep: 0.5, g: 0.45, dec: 0.18 });
    // and the buzzer, because the bunker enjoys this
    const bz = S._tone(v, t + 0.1, 0.42, { type: 'square', f: 138, g: 0.16, atk: 0.006, hold: 0.3, rel: 0.09 });
    S._lfo(v, t + 0.1, 0.45, bz.gain, 22, 0.11);
  },

  secret_found(S, t, o) {
    const v = V(S, o, 7, 0.6, 0.2); if (!v) return;
    S._nz(v, t, 1.15, { type: 'bandpass', f: 260, f2: 520, q: 5, g: 0.42, atk: 0.16, dec: 0.9, pink: true });
    S._tone(v, t, 1.0, { type: 'sawtooth', f: 42, f2: 55, sweep: 0.8, g: 0.2, atk: 0.2, hold: 0.4, rel: 0.3 });
    const N = [74, 81, 86];
    for (let i = 0; i < 3; i++) {
      S.fmBell(t + 0.55 + i * 0.11, mtof(N[i]), 1.5 - i * 0.2, {
        g: 0.2, ratio: 2.007, index: 3.2, revB: 0.35, revS: 0.2, pri: 7, vol: o.vol, pan: o.pan,
      });
    }
  },

  pickup_health(S, t, o) {
    const v = V(S, o, 5, 0.25, 0); if (!v) return;
    S._tone(v, t, 0.24, { type: 'sine', f: 523, g: 0.24, atk: 0.006, dec: 0.22 });
    S._tone(v, t + 0.09, 0.42, { type: 'sine', f: 784, g: 0.22, atk: 0.006, dec: 0.4 });
    S._tone(v, t + 0.09, 0.5, { type: 'triangle', f: 1568, g: 0.06, atk: 0.01, dec: 0.48 });
  },

  pickup_ammo(S, t, o) {
    const v = V(S, o, 4, 0.3, 0); if (!v) return;
    for (let i = 0; i < 3; i++) {
      S._nz(v, t + i * 0.045, 0.07, {
        type: 'bandpass', f: 1500 + i * 620, q: 7, g: 0.2 - i * 0.03, atk: 0.001, dec: 0.06,
      });
    }
    S._tone(v, t + 0.1, 0.16, { type: 'square', f: 190, f2: 120, sweep: 0.5, g: 0.16, dec: 0.14 });
  },

  pickup_key(S, t, o) {
    const v = V(S, o, 6, 0.3, 0.2); if (!v) return;
    S._nz(v, t, 0.05, { type: 'bandpass', f: 3400, q: 6, g: 0.16, atk: 0.001, dec: 0.045 });
    S.fmBell(t + 0.02, mtof(88), 1.5, { g: 0.22, ratio: 3.01, index: 3, revB: 0.3, pri: 6, vol: o.vol, pan: o.pan });
    S.fmBell(t + 0.02, mtof(95), 1.2, { g: 0.12, ratio: 2.007, index: 2, revB: 0.3, pri: 5, vol: o.vol, pan: o.pan });
  },

  pickup_treasure(S, t, o) {
    const N = [81, 86, 88, 93];
    for (let i = 0; i < 4; i++) {
      S.fmBell(t + i * 0.065, mtof(N[i]), 1.1 + i * 0.25, {
        g: 0.19, ratio: 2.007, index: 2.6, revS: 0.25, revB: 0.35, pri: 6, vol: o.vol, pan: o.pan,
      });
    }
  },

  pickup_weapon(S, t, o) {
    const v = V(S, o, 6, 0.3, 0.1); if (!v) return;
    S._nz(v, t, 0.09, { type: 'bandpass', f: 1200, f2: 2600, q: 4, g: 0.26, atk: 0.002, dec: 0.08 });
    S._nz(v, t + 0.1, 0.06, { type: 'bandpass', f: 820, q: 6, g: 0.24, atk: 0.001, dec: 0.055 });
    S._tone(v, t + 0.12, 0.6, { type: 'sawtooth', f: 98, f2: 147, sweep: 0.6, g: 0.2, atk: 0.02, dec: 0.55 });
    S._tone(v, t + 0.12, 0.55, { type: 'sine', f: 294, g: 0.1, atk: 0.03, dec: 0.5 });
  },

  elevator(S, t, o) {
    const v = V(S, o, 6, 0.5, 0); if (!v) return;
    const m = S._tone(v, t, 2.6, { type: 'sawtooth', f: 58, f2: 71, sweep: 0.5, g: 0.26, atk: 0.35, hold: 1.5, rel: 0.6 });
    S._lfo(v, t, 2.7, m.gain, 7.5, 0.06);
    S._nz(v, t, 2.5, { type: 'lowpass', f: 380, f2: 700, q: 3, g: 0.2, atk: 0.4, dec: 1.9, pink: true });
    S._nz(v, t, 2.4, { type: 'bandpass', f: 1900, q: 9, g: 0.05, atk: 0.5, dec: 1.7 });
  },

  // The roof grinding open. The siege starts here, so it had better be enormous.
  roof_open(S, t, o) {
    const v = V(S, o, 10, 0.35, 0.9); if (!v) return;
    const ctx = S._ctx;
    // two motors, slightly out of phase with each other
    const m1 = S._tone(v, t, 4.6, { type: 'sawtooth', f: 31, f2: 44, sweep: 0.7, g: 0.42, atk: 0.9, hold: 2.6, rel: 1.0 });
    const m2 = S._tone(v, t + 0.05, 4.4, { type: 'sawtooth', f: 47, f2: 63, sweep: 0.7, g: 0.24, atk: 1.1, hold: 2.3, rel: 0.9 });
    S._lfo(v, t, 4.7, m1.gain, 5.2, 0.13);
    S._lfo(v, t, 4.6, m2.gain, 3.1, 0.08);
    // concrete rumble under everything
    S._tone(v, t, 4.5, { type: 'sine', f: 26, f2: 33, sweep: 0.8, g: 0.55, atk: 1.2, hold: 2.0, rel: 1.2 });
    // the grind itself: a stuttering gain curve on a swept band of noise
    const grind = S._nz(v, t, 4.3, {
      type: 'bandpass', f: 210, f2: 900, q: 6, g: 0.5, atk: 0.5, hold: 2.8, rel: 0.9, pink: true,
    });
    const gj = ctx.createGain();
    gj.gain.setValueCurveAtTime(S._grindCurve, t, 4.2);
    gj.gain.setValueAtTime(0, t + 4.22);
    grind.disconnect();
    grind.connect(gj);
    gj.connect(v.out);
    S._n(v, gj);
    S._nz(v, t + 0.2, 4.0, { type: 'highpass', f: 2400, q: 0.7, g: 0.07, atk: 1.0, hold: 2.0, rel: 0.9 });
    // and it slams home
    S._nz(v, t + 4.35, 0.7, { type: 'lowpass', f: 500, f2: 130, q: 1.5, g: 0.85, atk: 0.003, dec: 0.65 });
    S._tone(v, t + 4.35, 0.8, { type: 'sine', f: 78, f2: 30, sweep: 0.45, g: 0.7, dec: 0.72 });
  },

  alarm(S, t, o) {
    const v = V(S, o, 7, 0.4, 0.5); if (!v) return;
    const r = o.rate;
    for (let i = 0; i < 2; i++) {
      const t0 = t + i * 0.6;
      S._tone(v, t0, 0.34, { type: 'sawtooth', f: 356 * r, f2: 264 * r, sweep: 0.9, g: 0.24, atk: 0.03, hold: 0.2, rel: 0.1 });
      S._tone(v, t0, 0.32, { type: 'square', f: 178 * r, f2: 132 * r, sweep: 0.9, g: 0.1, atk: 0.03, hold: 0.18, rel: 0.1 });
    }
  },
});

/* ------------------------------------------------------------- enemies */
// Voices are formant-ish: a buzzy source through two resonant bands. Cheap, and
// it lands in the same uncanny place as the PA announcer.

/** source -> two bandpass formants -> voice out. */
function throat(S, v, t, dur, f0, f1, f2, g, drop, type) {
  const ctx = S._ctx;
  const o = ctx.createOscillator();
  o.type = type || 'sawtooth';
  o.frequency.setValueAtTime(Math.max(8, f0), t);
  o.frequency.exponentialRampToValueAtTime(Math.max(8, f0 * drop), t + dur * 0.85);
  const g0 = ctx.createGain(); g0.gain.value = 0;
  const b1 = ctx.createBiquadFilter(); b1.type = 'bandpass'; b1.frequency.value = f1; b1.Q.value = 4;
  const b2 = ctx.createBiquadFilter(); b2.type = 'bandpass'; b2.frequency.value = f2; b2.Q.value = 6;
  o.connect(g0); g0.connect(b1); g0.connect(b2); b1.connect(v.out); b2.connect(v.out);
  S._n(v, o); S._n(v, g0); S._n(v, b1); S._n(v, b2);
  const len = S._ahr(g0, t, g, dur * 0.12, dur * 0.5, dur * 0.4);
  S._go(v, o, t, len);
  return g0;
}

Object.assign(SFX, {

  wrencher_alert(S, t, o) {
    const v = V(S, o, 6, 0.5, 0.1); if (!v) return;
    throat(S, v, t, 0.55, 132 * o.rate, 640, 1180, 0.5, 0.72);
    S._nz(v, t, 0.5, { type: 'bandpass', f: 900, f2: 500, q: 1.6, g: 0.11, atk: 0.05, dec: 0.42 });
  },

  wrencher_swing(S, t, o) {
    const v = V(S, o, 4, 0.35, 0); if (!v) return;
    S._nz(v, t, 0.16, { type: 'bandpass', f: 380, f2: 2100, q: 2.6, g: 0.32, atk: 0.09, dec: 0.07 });
    S._nz(v, t + 0.15, 0.16, { type: 'bandpass', f: 2100, f2: 420, q: 2.6, g: 0.26, atk: 0.02, dec: 0.14 });
  },

  sparker_fire(S, t, o) {
    const v = V(S, o, 5, 0.3, 0.15); if (!v) return;
    const ctx = S._ctx;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(2400 * o.rate, t);
    for (let i = 1; i <= 7; i++) {
      osc.frequency.setValueAtTime((700 + hash(i * 977) * 3400) * o.rate, t + i * 0.035);
    }
    const g = ctx.createGain(); g.gain.value = 0;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2200; bp.Q.value = 2;
    osc.connect(bp); bp.connect(g); g.connect(v.out);
    S._n(v, osc); S._n(v, bp); S._n(v, g);
    S._go(v, osc, t, S._env(g, t, 0.3, 0.002, 0.3));
    S._nz(v, t, 0.34, { type: 'highpass', f: 3600, q: 0.7, g: 0.16, atk: 0.002, dec: 0.32 });
  },

  bellows_flame(S, t, o) {
    const v = V(S, o, 6, 0.3, 0.3); if (!v) return;
    const roar = S._nz(v, t, 1.5, {
      type: 'lowpass', f: 620, f2: 900, q: 2.2, g: 0.5, atk: 0.14, hold: 0.9, rel: 0.45, pink: true,
    });
    S._lfo(v, t, 1.55, roar.gain, 8.5, 0.14);
    S._tone(v, t, 1.4, { type: 'sawtooth', f: 62, f2: 78, sweep: 0.8, g: 0.16, atk: 0.2, hold: 0.7, rel: 0.5 });
    S._nz(v, t, 1.3, { type: 'highpass', f: 2800, q: 0.7, g: 0.07, atk: 0.25, hold: 0.6, rel: 0.4 });
  },

  wasp_buzz(S, t, o) {
    const v = V(S, o, 4, 0.25, 0.1); if (!v) return;
    const r = o.rate;
    const a = S._tone(v, t, 0.85, { type: 'sawtooth', f: 178 * r, f2: 205 * r, sweep: 0.9, g: 0.22, atk: 0.05, hold: 0.55, rel: 0.25 });
    S._tone(v, t, 0.8, { type: 'sawtooth', f: 183 * r, f2: 211 * r, sweep: 0.9, g: 0.14, atk: 0.06, hold: 0.5, rel: 0.24 });
    S._lfo(v, t, 0.9, a.gain, 31, 0.1);
  },

  priest_chant(S, t, o) {
    const v = V(S, o, 6, 0.4, 0.55); if (!v) return;
    throat(S, v, t, 1.7, 98 * o.rate, 420, 900, 0.34, 0.94);
    throat(S, v, t + 0.06, 1.6, 147 * o.rate, 430, 1150, 0.16, 0.94);
    S._tone(v, t, 1.6, { type: 'sine', f: 49 * o.rate, g: 0.2, atk: 0.4, hold: 0.7, rel: 0.5 });
  },

  enemy_pain(S, t, o) {
    const v = V(S, o, 5, 0.4, 0.1); if (!v) return;
    throat(S, v, t, 0.26, 168 * o.rate, 620, 1250, 0.44, 0.7);
    S._nz(v, t, 0.14, { type: 'bandpass', f: 800, q: 1.6, g: 0.12, atk: 0.004, dec: 0.13 });
  },

  enemy_die(S, t, o) {
    const v = V(S, o, 6, 0.45, 0.15); if (!v) return;
    throat(S, v, t, 1.05, 186 * o.rate, 560, 1080, 0.42, 0.36);
    S._nz(v, t + 0.85, 0.28, { type: 'lowpass', f: 420, f2: 160, q: 1.4, g: 0.4, atk: 0.003, dec: 0.26 });
    S._tone(v, t + 0.85, 0.3, { type: 'sine', f: 96, f2: 46, sweep: 0.5, g: 0.3, dec: 0.28 });
  },

  boss_roar(S, t, o) {
    const v = V(S, o, 9, 0.3, 0.7); if (!v) return;
    const r = o.rate;
    const ctx = S._ctx;
    const ws = ctx.createWaveShaper();
    ws.curve = S._crushCurve; ws.oversample = '2x';
    ws.connect(v.out); S._n(v, ws);
    // route the throat through the shaper: MUTTER does not have a clean voice
    const th = throat(S, v, t, 2.2, 55 * r, 350, 760, 0.5, 0.8);
    th.disconnect(); th.connect(ws);
    S._tone(v, t, 2.1, { type: 'sine', f: 31 * r, f2: 24 * r, sweep: 0.8, g: 0.6, atk: 0.25, hold: 1.1, rel: 0.7 });
    S._nz(v, t, 2.0, { type: 'lowpass', f: 700, f2: 300, q: 2, g: 0.2, atk: 0.2, hold: 0.9, rel: 0.8, pink: true });
  },

  boss_hurt(S, t, o) {
    const v = V(S, o, 7, 0.35, 0.4); if (!v) return;
    for (let k = 0; k < 3; k++) {
      S._nz(v, t, 0.55, { type: 'bandpass', f: 430 * METAL[k + 1], q: 14, g: 0.2 / (k + 1), atk: 0.002, dec: 0.5 });
    }
    throat(S, v, t + 0.02, 0.5, 74 * o.rate, 380, 820, 0.34, 0.66);
  },

  boss_death(S, t, o) {
    const v = V(S, o, 11, 0.3, 0.9); if (!v) return;
    throat(S, v, t, 2.4, 92, 300, 640, 0.42, 0.24);
    S._nz(v, t, 2.2, { type: 'bandpass', f: 520, f2: 170, q: 5, g: 0.3, atk: 0.1, hold: 1.1, rel: 0.9, pink: true });
    S._tone(v, t, 2.6, { type: 'sine', f: 70, f2: 20, sweep: 0.85, g: 0.6, atk: 0.2, hold: 1.2, rel: 1.1 });
    // and then it comes apart
    S._nz(v, t + 1.9, 0.12, { type: 'highpass', f: 1800, q: 0.7, g: 0.9, atk: 0.002, dec: 0.11 });
    S._nz(v, t + 1.9, 2.6, { type: 'lowpass', f: 460, f2: 100, q: 1.2, g: 0.8, atk: 0.008, dec: 2.4, pink: true });
    S._tone(v, t + 1.9, 1.5, { type: 'sine', f: 96, f2: 22, sweep: 0.5, g: 0.9, dec: 1.4 });
  },
});

/* ------------------------------------------------- sky / Missile Command */

Object.assign(SFX, {

  warhead_launch(S, t, o) {
    const v = V(S, o, 6, 0.1, 0.8); if (!v) return;
    S._tone(v, t, 0.5, { type: 'sine', f: 74, f2: 34, sweep: 0.4, g: 0.34, atk: 0.02, dec: 0.46 });
    S._nz(v, t + 0.05, 1.5, {
      type: 'lowpass', f: 700, f2: 340, q: 1.4, g: 0.34, atk: 0.35, hold: 0.4, rel: 0.7, pink: true,
    });
    S._nz(v, t + 0.05, 1.3, { type: 'bandpass', f: 1500, f2: 600, q: 2.4, g: 0.08, atk: 0.4, dec: 0.85 });
  },

  // The dread sound. Rising, wobbling, and it is aimed at something you like.
  warhead_incoming(S, t, o) {
    const v = V(S, o, 8, 0.15, 0.55); if (!v) return;
    const r = o.rate;
    const a = S._tone(v, t, 1.9, { type: 'sawtooth', f: 210 * r, f2: 880 * r, sweep: 0.95, g: 0.24, atk: 0.25, hold: 1.1, rel: 0.5 });
    S._tone(v, t, 1.85, { type: 'sawtooth', f: 213 * r, f2: 892 * r, sweep: 0.95, g: 0.16, atk: 0.3, hold: 1.0, rel: 0.5 });
    S._lfo(v, t, 1.95, a.gain, 6.2, 0.05);
    S._nz(v, t, 1.8, { type: 'bandpass', f: 500, f2: 2600, q: 1.8, g: 0.16, atk: 0.5, hold: 0.7, rel: 0.55, pink: true });
  },

  mirv_split(S, t, o) {
    const v = V(S, o, 6, 0.15, 0.6); if (!v) return;
    S._nz(v, t, 0.07, { type: 'bandpass', f: 1800, q: 5, g: 0.34, atk: 0.001, dec: 0.06 });
    for (let i = 0; i < 3; i++) {
      S._tone(v, t + 0.05 + i * 0.035, 0.32, {
        type: 'square', f: (620 + i * 130) * o.rate, f2: (1500 + i * 320) * o.rate,
        sweep: 0.9, g: 0.11, atk: 0.005, dec: 0.3,
      });
    }
  },

  smart_evade(S, t, o) {
    const v = V(S, o, 5, 0.15, 0.4); if (!v) return;
    const r = o.rate;
    S._tone(v, t, 0.08, { type: 'square', f: 900 * r, f2: 1650 * r, sweep: 0.9, g: 0.2, atk: 0.003, dec: 0.07 });
    S._tone(v, t + 0.07, 0.1, { type: 'square', f: 1650 * r, f2: 1050 * r, sweep: 0.9, g: 0.16, atk: 0.003, dec: 0.09 });
    S._nz(v, t, 0.18, { type: 'highpass', f: 3000, q: 0.8, g: 0.1, atk: 0.005, dec: 0.17 });
  },

  // A city dies. Sub, then a roar that keeps crackling long after you want it to.
  city_hit(S, t, o) {
    const v = V(S, o, 12, 0.2, 1); if (!v) return;
    const ctx = S._ctx;
    // one wideband layer instead of two: a lowpass that starts wide open is the
    // crack and the body at once, and it saves three nodes on the biggest sound
    S._tone(v, t, 2.1, { type: 'sine', f: 58, f2: 14, sweep: 0.6, g: 1.15, atk: 0.01, dec: 1.9 });
    S._nz(v, t, 2.8, { type: 'lowpass', f: 5200, f2: 78, q: 1.3, g: 0.95, atk: 0.002, dec: 2.6, sweep: 0.16, pink: true });
    // the long crackling roar, gated by a generated crackle envelope
    const roar = S._nz(v, t + 0.12, 3.6, {
      type: 'bandpass', f: 820, f2: 340, q: 1.5, g: 0.5, atk: 0.2, hold: 1.6, rel: 1.6, pink: true,
    });
    const cg = ctx.createGain();
    cg.gain.setValueCurveAtTime(S._crackleCurve, t + 0.12, 3.5);
    cg.gain.setValueAtTime(0, t + 3.64);
    roar.disconnect(); roar.connect(cg); cg.connect(v.out); S._n(v, cg);
    // The "something structural giving way" groan rides the sub oscillator rather
    // than its own layer: this sound is 13 nodes and has to stay inside budget.
    S._tone(v, t + 0.3, 2.4, { type: 'sawtooth', f: 96, f2: 24, sweep: 0.95, g: 0.22, atk: 0.15, hold: 0.7, rel: 1.4 });
  },

  city_lost_sting(S, t, o) {
    const v = V(S, o, 9, 0.2, 0.75); if (!v) return;
    S.fmBell(t, mtof(62), 3.2, { g: 0.26, ratio: 1.41, index: 3.4, revB: 0.7, pri: 9, vol: o.vol });
    S.fmBell(t + 0.3, mtof(61), 3.4, { g: 0.22, ratio: 1.41, index: 3.0, revB: 0.7, pri: 9, vol: o.vol });
    S._tone(v, t, 3.0, { type: 'sawtooth', f: 36.7, f2: 34.6, sweep: 0.9, g: 0.3, atk: 0.4, hold: 1.2, rel: 1.3 });
    // a siren somewhere out on the plain, too late to be any use
    const sr = S._tone(v, t + 0.5, 2.4, { type: 'sawtooth', f: 330, f2: 262, sweep: 0.9, g: 0.07, atk: 0.5, hold: 0.9, rel: 0.9 });
    S._lfo(v, t + 0.5, 2.5, sr.gain, 0.7, 0.035);
  },

  wave_start(S, t, o) {
    const v = V(S, o, 8, 0.25, 0.6); if (!v) return;
    S._nz(v, t, 1.5, { type: 'bandpass', f: 200, f2: 5200, q: 2.6, g: 0.24, atk: 1.3, dec: 0.2 });
    S._tone(v, t, 1.6, { type: 'sawtooth', f: 55, f2: 73.4, sweep: 0.95, g: 0.26, atk: 1.2, hold: 0.1, rel: 0.3 });
    S._tone(v, t + 1.45, 0.5, { type: 'sawtooth', f: 356, f2: 264, sweep: 0.9, g: 0.2, atk: 0.02, hold: 0.28, rel: 0.16 });
    S._tone(v, t + 1.45, 0.5, { type: 'square', f: 89, g: 0.16, atk: 0.02, hold: 0.3, rel: 0.16 });
  },

  wave_clear(S, t, o) {
    const N = [74, 78, 81, 86];
    for (let i = 0; i < 4; i++) {
      S.fmBell(t + i * 0.08, mtof(N[i]), 2.2, {
        g: 0.2, ratio: 2.007, index: 2.4, revB: 0.5, pri: 8, vol: o.vol,
      });
    }
    const v = V(S, o, 7, 0.2, 0.5); if (!v) return;
    S._tone(v, t, 2.4, { type: 'sawtooth', f: 73.4, g: 0.22, atk: 0.25, hold: 1.1, rel: 0.9 });
  },

  chain2(S, t, o) { chain(S, t, o, 2); },
  chain3(S, t, o) { chain(S, t, o, 3); },
  chain4(S, t, o) { chain(S, t, o, 4); },
  chain5(S, t, o) { chain(S, t, o, 5); },

  perfect_burst(S, t, o) {
    const v = V(S, o, 8, 0.2, 0.6); if (!v) return;
    S.fmBell(t, 2349, 2.4, { g: 0.24, ratio: 3.51, index: 5, revB: 0.65, pri: 8, vol: o.vol });
    S.fmBell(t + 0.03, 3520, 1.9, { g: 0.12, ratio: 2.007, index: 3, revB: 0.65, pri: 7, vol: o.vol });
    S._nz(v, t, 0.5, { type: 'highpass', f: 7000, q: 0.8, g: 0.09, atk: 0.004, dec: 0.48 });
    S._tone(v, t, 1.2, { type: 'sine', f: 1174, g: 0.08, atk: 0.01, dec: 1.15 });
  },
});

/** Escalating confirmation stings. chain5 is meant to make you shout. */
function chain(S, t, o, lvl) {
  const up = [0, 3, 7, 12][lvl - 2];
  const base = 74 + up;                       // D5 and upward
  const N = [base, base + 7, base + 12, base + 19];
  const n = Math.min(lvl, 4);
  for (let i = 0; i < n; i++) {
    S.fmBell(t + i * 0.045, mtof(N[i]), 1.1 + i * 0.3 + lvl * 0.12, {
      g: 0.2 + lvl * 0.012, ratio: 2.007, index: 2.4 + lvl * 0.35,
      revS: 0.2, revB: 0.25 + lvl * 0.08, pri: 6 + lvl, vol: o.vol, pan: o.pan,
    });
  }
  if (lvl < 4) return;
  const v = V(S, o, 6 + lvl, 0.2, 0.5); if (!v) return;
  S._tone(v, t, 0.5, { type: 'sine', f: mtof(base - 24), f2: mtof(base - 31), sweep: 0.4, g: 0.5, dec: 0.45 });
  if (lvl < 5) return;
  // chain5: the whole rig leans in
  S.superSaw(t + 0.02, mtof(base - 12), 1.5, {
    n: 4, detune: 19, cutoff: 5200, co0: 0.35, open: 0.25, g: 0.34,
    atk: 0.015, rel: 0.9, revB: 0.4, pri: 10, pool: 0, vol: o.vol,
  });
  for (let i = 1; i < 4; i++) {
    S.pluck(t + 0.25 + i * 0.07, mtof(N[i] + 12), 0.5, {
      type: 'sawtooth', g: 0.15, cutoff: 6500, q: 3, revB: 0.45, pri: 9, vol: o.vol,
    });
  }
}

/* ------------------------------------------------------------ UI / player */

Object.assign(SFX, {

  ui_move(S, t, o) {
    const v = V(S, o, 2, 0.1, 0); if (!v) return;
    S._tone(v, t, 0.05, { type: 'triangle', f: 880 * o.rate, g: 0.16, atk: 0.002, dec: 0.045 });
  },

  ui_select(S, t, o) {
    const v = V(S, o, 3, 0.15, 0); if (!v) return;
    S._tone(v, t, 0.05, { type: 'square', f: 660 * o.rate, g: 0.14, atk: 0.002, dec: 0.045 });
    S._tone(v, t + 0.045, 0.13, { type: 'square', f: 990 * o.rate, g: 0.14, atk: 0.002, dec: 0.12 });
  },

  ui_back(S, t, o) {
    const v = V(S, o, 3, 0.15, 0); if (!v) return;
    S._tone(v, t, 0.05, { type: 'square', f: 620 * o.rate, g: 0.13, atk: 0.002, dec: 0.045 });
    S._tone(v, t + 0.045, 0.13, { type: 'square', f: 415 * o.rate, g: 0.13, atk: 0.002, dec: 0.12 });
  },

  ui_start(S, t, o) {
    const v = V(S, o, 7, 0.3, 0.35); if (!v) return;
    S._nz(v, t, 0.55, { type: 'bandpass', f: 400, f2: 3400, q: 2, g: 0.16, atk: 0.42, dec: 0.12 });
    const N = [38, 50, 57, 62];
    for (let i = 0; i < 4; i++) {
      S._tone(v, t + 0.4, 1.1, { type: 'sawtooth', f: mtof(N[i]), g: 0.12, atk: 0.012, hold: 0.4, rel: 0.6 });
    }
    S._tone(v, t + 0.4, 0.8, { type: 'sine', f: mtof(26), f2: mtof(24), sweep: 0.5, g: 0.55, dec: 0.75 });
  },

  score_tick(S, t, o) {
    const v = V(S, o, 1, 0, 0); if (!v) return;
    S._tone(v, t, 0.022, { type: 'square', f: 1450 * o.rate, g: 0.09, atk: 0.001, dec: 0.02 });
  },

  countdown(S, t, o) {
    const v = V(S, o, 6, 0.3, 0.15); if (!v) return;
    S._tone(v, t, 0.22, { type: 'square', f: 220 * o.rate, g: 0.2, atk: 0.005, hold: 0.1, rel: 0.1 });
    S._tone(v, t, 0.24, { type: 'sine', f: 110 * o.rate, g: 0.24, atk: 0.005, hold: 0.11, rel: 0.11 });
  },

  player_hurt(S, t, o) {
    const v = V(S, o, 8, 0.3, 0); if (!v) return;
    S._nz(v, t, 0.2, { type: 'lowpass', f: 520, f2: 180, q: 1.4, g: 0.6, atk: 0.002, dec: 0.19 });
    S._tone(v, t, 0.3, { type: 'sine', f: 128, f2: 52, sweep: 0.5, g: 0.55, dec: 0.28 });
    throat(S, v, t + 0.02, 0.34, 148, 480, 980, 0.22, 0.62);
  },

  player_die(S, t, o) {
    const v = V(S, o, 11, 0.35, 0.5); if (!v) return;
    S._nz(v, t, 0.25, { type: 'lowpass', f: 600, f2: 160, q: 1.4, g: 0.7, atk: 0.002, dec: 0.23 });
    throat(S, v, t, 1.6, 156, 460, 900, 0.3, 0.3);
    S._tone(v, t, 2.8, { type: 'sine', f: 88, f2: 19, sweep: 0.85, g: 0.75, atk: 0.03, dec: 2.6 });
    S._nz(v, t + 0.2, 2.6, { type: 'lowpass', f: 340, f2: 90, q: 1.1, g: 0.3, atk: 0.3, dec: 2.2, pink: true });
    // the last two beats
    S._tone(v, t + 1.5, 0.5, { type: 'sine', f: 60, f2: 34, sweep: 0.35, g: 0.6, dec: 0.45 });
    S._tone(v, t + 2.25, 0.6, { type: 'sine', f: 54, f2: 28, sweep: 0.35, g: 0.45, dec: 0.55 });
  },

  heartbeat(S, t, o) {
    const v = V(S, o, 5, 0.15, 0); if (!v) return;
    const r = o.rate;
    S._tone(v, t, 0.28, { type: 'sine', f: 64 * r, f2: 38 * r, sweep: 0.3, g: 0.7, atk: 0.008, dec: 0.26 });
    S._tone(v, t + 0.235 / r, 0.34, { type: 'sine', f: 58 * r, f2: 33 * r, sweep: 0.3, g: 0.5, atk: 0.01, dec: 0.32 });
  },

  footstep_a(S, t, o) {
    const v = V(S, o, 2, 0.28, 0); if (!v) return;
    const r = o.rate;
    S._nz(v, t, 0.09, { type: 'lowpass', f: 420 * r, f2: 180 * r, q: 1.3, g: 0.34, atk: 0.002, dec: 0.085 });
    S._nz(v, t + 0.006, 0.06, { type: 'bandpass', f: 1900 * r, q: 2.4, g: 0.09, atk: 0.002, dec: 0.055 });
  },

  footstep_b(S, t, o) {
    const v = V(S, o, 2, 0.28, 0); if (!v) return;
    const r = o.rate * 0.92;
    S._nz(v, t, 0.11, { type: 'lowpass', f: 360 * r, f2: 150 * r, q: 1.6, g: 0.32, atk: 0.002, dec: 0.1 });
    S._nz(v, t + 0.008, 0.07, { type: 'bandpass', f: 1450 * r, q: 3.2, g: 0.08, atk: 0.002, dec: 0.065 });
  },
});


/* ------------------------------------------------------------- mutants */
// Nothing in here is a clean tone. The mechanical enemies got oscillators and
// metal; these got filtered noise, resonant throats, collapsing pitch and
// granular gates. Wet, in the bad way.

Object.assign(SFX, {

  ghoul_alert(S, t, o) {
    const v = V(S, o, 6, 0.45, 0.15); if (!v) return;
    const r = o.rate;
    // the intake: a rising band with the attack on the wrong end
    S._nz(v, t, 0.26, { type: 'bandpass', f: 380 * r, f2: 1500 * r, q: 3.2, g: 0.3, atk: 0.19, dec: 0.07 });
    // and then it sees you
    gullet(S, v, t + 0.24, 0.62, [
      { f: 900 * r, f2: 1950 * r, q: 13, g: 0.5, sweep: 0.5 },
      { f: 1750 * r, f2: 3250 * r, q: 15, g: 0.34, sweep: 0.62 },
      { f: 2900 * r, f2: 4400 * r, q: 11, g: 0.16, sweep: 0.44 },
    ], { g: 0.75, atk: 0.02, dec: 0.6, rate: 1, rate2: 1.5 });
  },

  ghoul_attack(S, t, o) {
    const v = V(S, o, 5, 0.35, 0); if (!v) return;
    const r = o.rate * (0.92 + S._r() * 0.18);
    S._nz(v, t, 0.03, { type: 'highpass', f: 2600 * r, q: 0.7, g: 0.55, atk: 0.0012, dec: 0.026 });
    // the bone click inside the bite
    S._nz(v, t + 0.006, 0.06, { type: 'bandpass', f: 1150 * r, q: 19, g: 0.4, atk: 0.001, dec: 0.05 });
    S._nz(v, t + 0.004, 0.11, { type: 'lowpass', f: 430 * r, f2: 190, q: 1.6, g: 0.45, atk: 0.002, dec: 0.1 });
  },

  ghoul_pain(S, t, o) {
    const v = V(S, o, 5, 0.4, 0.1); if (!v) return;
    const r = o.rate;
    gullet(S, v, t, 0.26, [
      { f: 1050 * r, f2: 620 * r, q: 11, g: 0.55 },
      { f: 2150 * r, f2: 1400 * r, q: 9, g: 0.28 },
    ], { g: 0.7, atk: 0.006, dec: 0.24, rate: 1.25, rate2: 0.8 });
  },

  ghoul_die(S, t, o) {
    const v = V(S, o, 6, 0.5, 0.2); if (!v) return;
    const r = o.rate;
    const rattle = gullet(S, v, t, 1.35, [
      { f: 780 * r, f2: 300 * r, q: 10, g: 0.5 },
      { f: 1500 * r, f2: 520 * r, q: 8, g: 0.26 },
    ], { g: 0.75, atk: 0.02, dec: 1.3, rate: 1.15, rate2: 0.55 });
    gate(S, v, rattle, S._gurgleCurve, t, 1.3);
    S._nz(v, t + 1.1, 0.4, { type: 'lowpass', f: 300, f2: 130, q: 1.4, g: 0.3, atk: 0.01, dec: 0.38, pink: true });
  },

  gorger_alert(S, t, o) {
    const v = V(S, o, 6, 0.4, 0.25); if (!v) return;
    const r = o.rate;
    const drone = gullet(S, v, t, 1.7, [
      { f: 170 * r, f2: 230 * r, q: 7, g: 0.6 },
      { f: 430 * r, f2: 330 * r, q: 9, g: 0.35 },
      { f: 820 * r, f2: 640 * r, q: 12, g: 0.14 },
    ], { g: 0.7, atk: 0.25, hold: 0.9, rel: 0.55, rate: 0.7, rate2: 0.55 });
    gate(S, v, drone, S._gurgleCurve, t, 1.65);
    S._tone(v, t, 1.6, { type: 'sine', f: 47 * r, f2: 38 * r, sweep: 0.9, g: 0.45, atk: 0.3, hold: 0.7, rel: 0.55 });
  },

  gorger_attack(S, t, o) {
    const v = V(S, o, 6, 0.35, 0.1); if (!v) return;
    const r = o.rate;
    S._nz(v, t, 0.2, { type: 'bandpass', f: 260 * r, f2: 900 * r, q: 2, g: 0.32, atk: 0.14, dec: 0.07 });
    S._nz(v, t + 0.18, 0.2, { type: 'lowpass', f: 700 * r, f2: 200, q: 1.8, g: 0.6, atk: 0.002, dec: 0.19, pink: true });
    S._tone(v, t + 0.18, 0.28, { type: 'sine', f: 96 * r, f2: 44 * r, sweep: 0.45, g: 0.45, dec: 0.26 });
  },

  gorger_pain(S, t, o) {
    const v = V(S, o, 5, 0.4, 0.1); if (!v) return;
    const r = o.rate;
    gullet(S, v, t, 0.42, [
      { f: 240 * r, f2: 150 * r, q: 8, g: 0.6 },
      { f: 640 * r, f2: 400 * r, q: 10, g: 0.28 },
    ], { g: 0.75, atk: 0.008, dec: 0.4, rate: 0.8, rate2: 0.5 });
    S._tone(v, t, 0.3, { type: 'sine', f: 88 * r, f2: 50 * r, sweep: 0.6, g: 0.32, dec: 0.28 });
  },

  // The money sound. A pressurised thing at close range, ceasing to be one.
  gorger_burst(S, t, o) {
    const v = V(S, o, 10, 0.35, 0.7); if (!v) return;
    const r = o.rate;
    // the rupture itself — wide open, then it closes like a fist
    S._nz(v, t, 0.22, { type: 'bandpass', f: 1500 * r, f2: 190, q: 1.1, g: 0.95, atk: 0.0015, dec: 0.2, sweep: 0.3 });
    // the sub thump you feel in the floor
    S._tone(v, t + 0.005, 1.5, { type: 'sine', f: 74 * r, f2: 17, sweep: 0.5, g: 1.0, atk: 0.006, dec: 1.35 });
    // wet body
    S._nz(v, t + 0.01, 1.0, { type: 'lowpass', f: 880 * r, f2: 165, q: 1.5, g: 0.7, atk: 0.008, dec: 0.95, pink: true });
    // and then the long splattering tail, gated into individual landings
    const splat = S._nz(v, t + 0.1, 2.3, {
      type: 'bandpass', f: 1350 * r, f2: 520, q: 1.3, g: 0.75, atk: 0.02, dec: 2.2, pink: true,
    });
    gate(S, v, splat, S._splatCurve, t + 0.1, 2.25);
  },

  // Three formant peaks climbing at three different rates, so the scream beats
  // against itself. The detuned pair underneath makes the beating audible.
  howler_alert(S, t, o) {
    const v = V(S, o, 8, 0.3, 0.5); if (!v) return;
    const r = o.rate;
    gullet(S, v, t, 1.5, [
      { f: 620 * r, f2: 2300 * r, q: 16, g: 0.62, sweep: 0.95 },
      { f: 940 * r, f2: 3050 * r, q: 18, g: 0.5, sweep: 0.82 },
      { f: 1280 * r, f2: 3900 * r, q: 14, g: 0.32, sweep: 0.7 },
    ], { g: 1.5, atk: 0.28, hold: 0.7, rel: 0.5, rate: 0.9, rate2: 1.7 });
    S._tone(v, t + 0.05, 1.4, { type: 'sawtooth', f: 310 * r, f2: 1150 * r, sweep: 0.93, g: 0.17, atk: 0.35, hold: 0.6, rel: 0.4 });
    S._tone(v, t + 0.05, 1.4, { type: 'sawtooth', f: 317 * r, f2: 1178 * r, sweep: 0.87, g: 0.17, atk: 0.4, hold: 0.55, rel: 0.4 });
  },

  howler_spit(S, t, o) {
    const v = V(S, o, 6, 0.3, 0.35); if (!v) return;
    const r = o.rate;
    S._nz(v, t, 0.09, { type: 'bandpass', f: 700 * r, f2: 2200 * r, q: 4, g: 0.5, atk: 0.004, dec: 0.085 });
    S._tone(v, t, 0.16, { type: 'square', f: 420 * r, f2: 900 * r, sweep: 0.8, g: 0.16, atk: 0.003, dec: 0.15 });
    S._nz(v, t + 0.05, 0.5, { type: 'highpass', f: 3200 * r, q: 0.8, g: 0.16, atk: 0.03, dec: 0.46 });
  },

  howler_pain(S, t, o) {
    const v = V(S, o, 5, 0.35, 0.15); if (!v) return;
    const r = o.rate;
    gullet(S, v, t, 0.3, [
      { f: 1400 * r, f2: 800 * r, q: 15, g: 0.5 },
      { f: 2300 * r, f2: 1500 * r, q: 13, g: 0.3 },
    ], { g: 0.7, atk: 0.007, dec: 0.28, rate: 1.4, rate2: 0.85 });
  },

  howler_die(S, t, o) {
    const v = V(S, o, 6, 0.4, 0.35); if (!v) return;
    const r = o.rate;
    gullet(S, v, t, 1.5, [
      { f: 1500 * r, f2: 330 * r, q: 13, g: 0.5, sweep: 0.85 },
      { f: 2500 * r, f2: 700 * r, q: 11, g: 0.28, sweep: 0.8 },
      { f: 3600 * r, f2: 1100 * r, q: 9, g: 0.12, sweep: 0.75 },
    ], { g: 0.75, atk: 0.02, dec: 1.45, rate: 1.5, rate2: 0.45 });
  },

  stalker_alert(S, t, o) {
    const v = V(S, o, 5, 0.4, 0.1); if (!v) return;
    const r = o.rate;
    const ch = S._nz(v, t, 0.85, { type: 'bandpass', f: 2400 * r, f2: 3400 * r, q: 9, g: 0.42, atk: 0.005, dec: 0.82 });
    gate(S, v, ch, S._chitterCurve, t, 0.8);
    S._nz(v, t, 0.5, { type: 'bandpass', f: 800 * r, q: 5, g: 0.09, atk: 0.02, dec: 0.47 });
  },

  // Claws on grating, getting closer faster than you would like.
  stalker_charge(S, t, o) {
    const v = V(S, o, 7, 0.45, 0.1); if (!v) return;
    const r = o.rate;
    const sc = S._nz(v, t, 1.6, { type: 'bandpass', f: 1700 * r, f2: 2600 * r, q: 6, g: 0.5, atk: 0.005, dec: 1.55 });
    gate(S, v, sc, S._scrabbleCurve, t, 1.55);
    S._nz(v, t, 1.55, { type: 'lowpass', f: 300 * r, f2: 460 * r, q: 1.4, g: 0.22, atk: 0.4, hold: 0.7, rel: 0.4, pink: true });
  },

  stalker_attack(S, t, o) {
    const v = V(S, o, 5, 0.35, 0); if (!v) return;
    const r = o.rate * (0.9 + S._r() * 0.22);
    S._nz(v, t, 0.09, { type: 'bandpass', f: 2200 * r, f2: 900 * r, q: 3, g: 0.5, atk: 0.002, dec: 0.085 });
    S._nz(v, t + 0.02, 0.08, { type: 'lowpass', f: 520 * r, f2: 220, q: 1.6, g: 0.34, atk: 0.002, dec: 0.075 });
  },

  stalker_pain(S, t, o) {
    const v = V(S, o, 5, 0.35, 0); if (!v) return;
    const r = o.rate;
    gullet(S, v, t, 0.2, [
      { f: 1900 * r, f2: 1150 * r, q: 14, g: 0.5 },
      { f: 3100 * r, f2: 2000 * r, q: 12, g: 0.22 },
    ], { g: 0.65, atk: 0.004, dec: 0.19, rate: 1.6, rate2: 1.0 });
  },

  stalker_die(S, t, o) {
    const v = V(S, o, 6, 0.4, 0.15); if (!v) return;
    const r = o.rate;
    const d = gullet(S, v, t, 0.85, [
      { f: 2100 * r, f2: 620 * r, q: 12, g: 0.5 },
      { f: 3300 * r, f2: 1100 * r, q: 10, g: 0.22 },
    ], { g: 0.7, atk: 0.006, dec: 0.82, rate: 1.7, rate2: 0.5 });
    gate(S, v, d, S._chitterCurve, t, 0.8);
  },

  // MAW. Boss scale: several seconds, four layers, and a throat full of gravel.
  maw_roar(S, t, o) {
    const v = V(S, o, 11, 0.3, 0.85); if (!v) return;
    const r = o.rate;
    const ctx = S._ctx;
    const ws = ctx.createWaveShaper();
    ws.curve = S._crushCurve; ws.oversample = 'none';
    ws.connect(v.out); S._n(v, ws);
    gullet(S, v, t, 3.4, [
      { f: 210 * r, f2: 150 * r, q: 8, g: 0.55, sweep: 0.85 },
      { f: 470 * r, f2: 330 * r, q: 10, g: 0.36, sweep: 0.8 },
      { f: 910 * r, f2: 620 * r, q: 12, g: 0.16, sweep: 0.75 },
    ], { g: 0.85, atk: 0.35, hold: 1.9, rel: 1.1, rate: 0.6, rate2: 0.38, to: ws });
    S._tone(v, t, 3.5, { type: 'sine', f: 34 * r, f2: 25 * r, sweep: 0.9, g: 0.8, atk: 0.4, hold: 1.9, rel: 1.1 });
    const wetg = S._nz(v, t + 0.3, 2.8, {
      type: 'lowpass', f: 620 * r, f2: 260, q: 2.2, g: 0.3, atk: 0.5, hold: 1.3, rel: 0.9, pink: true,
    });
    gate(S, v, wetg, S._gurgleCurve, t + 0.3, 2.7);
  },

  maw_hurt(S, t, o) {
    const v = V(S, o, 8, 0.35, 0.45); if (!v) return;
    const r = o.rate;
    S._nz(v, t, 0.24, { type: 'lowpass', f: 900 * r, f2: 210, q: 1.7, g: 0.7, atk: 0.002, dec: 0.22, pink: true });
    gullet(S, v, t + 0.02, 0.65, [
      { f: 300 * r, f2: 190 * r, q: 9, g: 0.55 },
      { f: 720 * r, f2: 450 * r, q: 11, g: 0.26 },
    ], { g: 0.7, atk: 0.01, dec: 0.62, rate: 0.75, rate2: 0.5 });
  },

  maw_die(S, t, o) {
    const v = V(S, o, 12, 0.3, 0.9); if (!v) return;
    const r = o.rate;
    gullet(S, v, t, 2.6, [
      { f: 260 * r, f2: 90 * r, q: 8, g: 0.55, sweep: 0.9 },
      { f: 600 * r, f2: 210 * r, q: 10, g: 0.3, sweep: 0.85 },
    ], { g: 0.8, atk: 0.15, hold: 1.2, rel: 1.2, rate: 0.7, rate2: 0.3 });
    S._tone(v, t, 3.2, { type: 'sine', f: 62 * r, f2: 16, sweep: 0.85, g: 0.85, atk: 0.2, hold: 1.4, rel: 1.5 });
    // and then it comes apart, wetly
    S._nz(v, t + 2.0, 0.3, { type: 'bandpass', f: 1400, f2: 220, q: 1.2, g: 0.9, atk: 0.002, dec: 0.28, sweep: 0.3 });
    const sp = S._nz(v, t + 2.05, 2.4, {
      type: 'bandpass', f: 1200, f2: 430, q: 1.3, g: 0.75, atk: 0.02, dec: 2.3, pink: true,
    });
    gate(S, v, sp, S._splatCurve, t + 2.05, 2.35);
  },
});

/* ------------------------------------------------------------------ gore */

Object.assign(SFX, {

  // Fired by the dozen when something comes apart, so: three nodes plus a voice.
  gib(S, t, o) {
    const v = V(S, o, 4, 0.3, 0); if (!v) return;
    const r = o.rate * (0.8 + S._r() * 0.45);
    S._nz(v, t, 0.14, { type: 'lowpass', f: 1100 * r, f2: 210, q: 1.8, g: 0.55, atk: 0.0015, dec: 0.13, sweep: 0.35, pink: true });
    S._nz(v, t + 0.004, 0.07, { type: 'bandpass', f: 1900 * r, q: 3.5, g: 0.22, atk: 0.001, dec: 0.065 });
  },

  // Bodies hit walls in bunches, so this is two layers: one lowpass that starts
  // wide and closes carries the impact and the wet smear that follows it.
  splat(S, t, o) {
    const v = V(S, o, 5, 0.4, 0.1); if (!v) return;
    const r = o.rate * (0.9 + S._r() * 0.2);
    S._nz(v, t, 0.46, {
      type: 'lowpass', f: 1800 * r, f2: 155, q: 1.9, g: 0.8, atk: 0.002, dec: 0.44, sweep: 0.22, pink: true,
    });
    S._tone(v, t, 0.2, { type: 'sine', f: 105 * r, f2: 46 * r, sweep: 0.45, g: 0.42, dec: 0.18 });
  },

  bone_crack(S, t, o) {
    const v = V(S, o, 5, 0.35, 0); if (!v) return;
    const r = o.rate * (0.92 + S._r() * 0.16);
    S._nz(v, t, 0.055, { type: 'bandpass', f: 1450 * r, q: 21, g: 0.55, atk: 0.0008, dec: 0.05 });
    S._nz(v, t, 0.03, { type: 'highpass', f: 3400 * r, q: 0.7, g: 0.3, atk: 0.0008, dec: 0.026 });
    S._nz(v, t + 0.01, 0.1, { type: 'lowpass', f: 380 * r, f2: 170, q: 1.5, g: 0.28, atk: 0.002, dec: 0.09 });
  },

  acid_hit(S, t, o) {
    const v = V(S, o, 5, 0.3, 0.1); if (!v) return;
    const r = o.rate;
    S._nz(v, t, 0.1, { type: 'bandpass', f: 1600 * r, f2: 600, q: 2.4, g: 0.45, atk: 0.002, dec: 0.095 });
    const hiss = S._nz(v, t + 0.02, 1.0, { type: 'highpass', f: 4200 * r, q: 0.8, g: 0.4, atk: 0.01, dec: 0.97 });
    gate(S, v, hiss, S._sizzleCurve, t + 0.02, 0.95);
  },

  // Damage over time: this repeats every half second, so it stays tiny.
  acid_burn(S, t, o) {
    const v = V(S, o, 3, 0.2, 0); if (!v) return;
    const r = o.rate * (0.9 + S._r() * 0.24);
    const hiss = S._nz(v, t, 0.4, { type: 'highpass', f: 3600 * r, q: 0.8, g: 0.34, atk: 0.006, dec: 0.38 });
    gate(S, v, hiss, S._sizzleCurve, t, 0.36);
  },
});

/* --------------------------------------------------------- melee, ordnance */

Object.assign(SFX, {

  kick_swing(S, t, o) {
    const v = V(S, o, 4, 0.3, 0); if (!v) return;
    const r = o.rate;
    S._nz(v, t, 0.2, { type: 'bandpass', f: 300 * r, f2: 1500 * r, q: 2.2, g: 0.34, atk: 0.11, dec: 0.09 });
    S._nz(v, t + 0.02, 0.16, { type: 'lowpass', f: 700 * r, q: 1.2, g: 0.12, atk: 0.09, dec: 0.07 });
  },

  kick_hit(S, t, o) {
    const v = V(S, o, 6, 0.4, 0.1); if (!v) return;
    const r = o.rate;
    S._tone(v, t, 0.26, { type: 'sine', f: 124 * r, f2: 48 * r, sweep: 0.3, g: 0.8, atk: 0.002, dec: 0.24 });
    S._nz(v, t, 0.17, { type: 'lowpass', f: 560 * r, f2: 190, q: 1.7, g: 0.6, atk: 0.002, dec: 0.16, pink: true });
    S._nz(v, t + 0.008, 0.07, { type: 'bandpass', f: 980 * r, q: 8, g: 0.3, atk: 0.001, dec: 0.065 });
  },

  kick_wall(S, t, o) {
    const v = V(S, o, 4, 0.45, 0); if (!v) return;
    const r = o.rate;
    S._nz(v, t, 0.14, { type: 'lowpass', f: 420 * r, f2: 180, q: 1.5, g: 0.6, atk: 0.0015, dec: 0.13 });
    S._nz(v, t + 0.004, 0.1, { type: 'bandpass', f: 2400 * r, q: 3, g: 0.14, atk: 0.001, dec: 0.095 });
  },

  // A light enemy leaving the roof. This is allowed to be funny.
  punt(S, t, o) {
    const v = V(S, o, 8, 0.25, 0.6); if (!v) return;
    const r = o.rate;
    // leather on boot
    S._nz(v, t, 0.06, { type: 'bandpass', f: 1250 * r, q: 5, g: 0.7, atk: 0.001, dec: 0.055 });
    S._tone(v, t, 0.16, { type: 'sine', f: 150 * r, f2: 62 * r, sweep: 0.3, g: 0.6, atk: 0.002, dec: 0.15 });
    // the comedy departure: up, over, and away
    S._tone(v, t + 0.02, 0.85, { type: 'triangle', f: 240 * r, f2: 1250 * r, sweep: 0.75, g: 0.3, atk: 0.01, dec: 0.8 });
    S._tone(v, t + 0.02, 0.9, { type: 'sine', f: 480 * r, f2: 2500 * r, sweep: 0.72, g: 0.1, atk: 0.02, dec: 0.85 });
    // doppler wash as it clears the parapet
    S._nz(v, t + 0.05, 0.9, { type: 'bandpass', f: 900 * r, f2: 4200 * r, q: 3, g: 0.16, atk: 0.12, dec: 0.75 });
  },

  pipebomb_throw(S, t, o) {
    const v = V(S, o, 4, 0.3, 0.1); if (!v) return;
    const r = o.rate;
    S._nz(v, t, 0.22, { type: 'bandpass', f: 420 * r, f2: 1700 * r, q: 2.4, g: 0.3, atk: 0.12, dec: 0.1 });
    S._nz(v, t + 0.03, 0.05, { type: 'bandpass', f: 2900 * r, q: 9, g: 0.16, atk: 0.001, dec: 0.045 });
  },

  pipebomb_land(S, t, o) {
    const v = V(S, o, 5, 0.5, 0.1); if (!v) return;
    const r = o.rate;
    // three bounces, closer together each time, like a dropped pipe
    const at = [0, 0.13, 0.21, 0.26];
    for (let i = 0; i < 4; i++) {
      S._nz(v, t + at[i], 0.12, {
        type: 'bandpass', f: 1150 * r * METAL[i], q: 15, g: 0.32 / (1 + i * 0.8), atk: 0.001, dec: 0.11,
      });
    }
    S._nz(v, t, 0.1, { type: 'lowpass', f: 320 * r, f2: 150, q: 1.5, g: 0.35, atk: 0.0015, dec: 0.09 });
  },

  // Called every half second while it is armed. Two nodes. Do not add layers.
  pipebomb_beep(S, t, o) {
    const v = V(S, o, 3, 0.15, 0); if (!v) return;
    S._tone(v, t, 0.035, { type: 'square', f: 2100 * o.rate, g: 0.16, atk: 0.001, dec: 0.032 });
  },

  // Tighter and drier than airburst: this one went off in a corridor.
  pipebomb_blow(S, t, o) {
    const v = V(S, o, 9, 0.4, 0.2); if (!v) return;
    const r = o.rate;
    S._nz(v, t, 0.06, { type: 'highpass', f: 2600 * r, q: 0.7, g: 0.95, atk: 0.001, dec: 0.055 });
    S._tone(v, t, 0.34, { type: 'sine', f: 128 * r, f2: 36 * r, sweep: 0.3, g: 0.95, atk: 0.003, dec: 0.31 });
    S._nz(v, t, 0.42, { type: 'lowpass', f: 1600 * r, f2: 200, q: 1.4, g: 0.75, atk: 0.002, dec: 0.4, sweep: 0.2 });
    // shrapnel on concrete, and nothing else: no rolling tail
    S._nz(v, t + 0.015, 0.35, { type: 'highpass', f: 4200, q: 0.7, g: 0.2, atk: 0.003, dec: 0.33 });
  },
});

/* ------------------------------------------------------------ radio, story */
// The radio is a narrow band with a hard shelf either side: everything here is
// deliberately small and mid-heavy so a spoken line sits on top of it.

Object.assign(SFX, {

  radio_open(S, t, o) {
    const v = V(S, o, 6, 0.2, 0); if (!v) return;
    const r = o.rate;
    // relay click, then the squelch letting go
    S._nz(v, t, 0.018, { type: 'bandpass', f: 2600 * r, q: 12, g: 0.34, atk: 0.0008, dec: 0.016 });
    const sq = S._nz(v, t + 0.015, 0.26, { type: 'bandpass', f: 1700 * r, f2: 900 * r, q: 1.6, g: 0.4, atk: 0.004, dec: 0.25 });
    gate(S, v, sq, S._crackleCurve, t + 0.015, 0.25);
  },

  radio_close(S, t, o) {
    const v = V(S, o, 5, 0.2, 0); if (!v) return;
    const r = o.rate;
    const sq = S._nz(v, t, 0.14, { type: 'bandpass', f: 1500 * r, f2: 2400 * r, q: 1.8, g: 0.3, atk: 0.004, dec: 0.13 });
    gate(S, v, sq, S._crackleCurve, t, 0.13);
    S._nz(v, t + 0.13, 0.02, { type: 'bandpass', f: 2200 * r, q: 12, g: 0.3, atk: 0.0008, dec: 0.018 });
  },

  radio_static(S, t, o) {
    const v = V(S, o, 4, 0.15, 0); if (!v) return;
    const r = o.rate;
    const st = S._nz(v, t, 0.34, { type: 'bandpass', f: 1900 * r, q: 1.1, g: 0.34, atk: 0.003, dec: 0.33 });
    gate(S, v, st, S._crackleCurve, t, 0.33);
  },

  // Plays constantly. Three nodes, and it has to stay likeable.
  radio_beep(S, t, o) {
    const v = V(S, o, 4, 0.15, 0); if (!v) return;
    const r = o.rate;
    S._tone(v, t, 0.07, { type: 'sine', f: 1046 * r, g: 0.17, atk: 0.004, dec: 0.065 });
    S._tone(v, t + 0.075, 0.11, { type: 'sine', f: 1568 * r, g: 0.15, atk: 0.004, dec: 0.105 });
  },

  objective(S, t, o) {
    const r = o.rate;
    S.fmBell(t, mtof(81) * r, 1.1, { g: 0.2, ratio: 2.007, index: 2.2, revS: 0.2, revB: 0.3, pri: 6, vol: o.vol, pan: o.pan });
    S.fmBell(t + 0.13, mtof(88) * r, 1.5, { g: 0.18, ratio: 2.007, index: 2.0, revS: 0.2, revB: 0.3, pri: 6, vol: o.vol, pan: o.pan });
  },

  story_sting(S, t, o) {
    const v = V(S, o, 8, 0.3, 0.65); if (!v) return;
    const r = o.rate;
    S._tone(v, t, 1.5, { type: 'sine', f: 49 * r, f2: 37 * r, sweep: 0.7, g: 0.7, atk: 0.01, dec: 1.4 });
    S.superSaw(t, mtof(50) * r, 1.4, {
      n: 5, detune: 16, cutoff: 1500, co0: 0.4, open: 0.2, g: 0.3,
      atk: 0.02, rel: 0.9, revB: 0.5, pri: 8, vol: o.vol,
    });
    S.superSaw(t + 0.01, mtof(51) * r, 1.3, {
      n: 3, detune: 12, cutoff: 1200, g: 0.16, atk: 0.03, rel: 0.85, revB: 0.5, pri: 7, vol: o.vol,
    });
    S.fmBell(t + 0.02, mtof(86) * r, 2.0, { g: 0.16, ratio: 1.41, index: 3.4, revB: 0.6, pri: 8, vol: o.vol });
  },
});

/* ------------------------------------------------------------------- feel */

Object.assign(SFX, {

  // The game raises opts.rate as the streak climbs, so these stack into a run.
  combo_up(S, t, o) {
    const v = V(S, o, 5, 0.2, 0.2); if (!v) return;
    const r = o.rate;
    S._tone(v, t, 0.07, { type: 'square', f: 784 * r, g: 0.12, atk: 0.002, dec: 0.065 });
    S._tone(v, t + 0.05, 0.22, { type: 'triangle', f: 1175 * r, g: 0.16, atk: 0.002, dec: 0.21 });
    S._tone(v, t + 0.05, 0.3, { type: 'sine', f: 2349 * r, g: 0.05, atk: 0.004, dec: 0.28 });
  },

  taunt_hit(S, t, o) {
    const v = V(S, o, 6, 0.25, 0.2); if (!v) return;
    const r = o.rate;
    S._tone(v, t, 0.2, { type: 'sine', f: 150 * r, f2: 55 * r, sweep: 0.25, g: 0.7, atk: 0.002, dec: 0.19 });
    S._nz(v, t, 0.1, { type: 'bandpass', f: 2200 * r, f2: 1100, q: 2.2, g: 0.24, atk: 0.001, dec: 0.095 });
    S._tone(v, t, 0.26, { type: 'sawtooth', f: 300 * r, f2: 220 * r, sweep: 0.4, g: 0.14, atk: 0.004, dec: 0.25 });
  },

  heartbeat_fast(S, t, o) {
    const v = V(S, o, 6, 0.15, 0); if (!v) return;
    const r = o.rate * 1.18;
    S._tone(v, t, 0.22, { type: 'sine', f: 72 * r, f2: 42 * r, sweep: 0.3, g: 0.8, atk: 0.005, dec: 0.2 });
    S._tone(v, t + 0.165 / r, 0.26, { type: 'sine', f: 65 * r, f2: 37 * r, sweep: 0.3, g: 0.6, atk: 0.007, dec: 0.24 });
  },

  slowmo_in(S, t, o) {
    const v = V(S, o, 8, 0.3, 0.5); if (!v) return;
    const r = o.rate;
    S._nz(v, t, 0.7, { type: 'lowpass', f: 5200 * r, f2: 190, q: 2.6, g: 0.42, atk: 0.02, dec: 0.68 });
    S._tone(v, t, 0.72, { type: 'sawtooth', f: 420 * r, f2: 58 * r, sweep: 0.85, g: 0.2, atk: 0.01, dec: 0.7 });
  },

  slowmo_out(S, t, o) {
    const v = V(S, o, 8, 0.3, 0.4); if (!v) return;
    const r = o.rate;
    S._nz(v, t, 0.5, { type: 'lowpass', f: 190 * r, f2: 6000 * r, q: 2.2, g: 0.38, atk: 0.36, dec: 0.14 });
    S._tone(v, t, 0.5, { type: 'sawtooth', f: 62 * r, f2: 480 * r, sweep: 0.88, g: 0.18, atk: 0.3, dec: 0.2 });
  },
});

/* ------------------------------------------------- the two expansion tracks */

/** 1987 gated snare: a real hit, a bright tail, and the tail cut off dead. */
function gatedSnare(S, t, T, g) {
  const v = S._v(6, null, 0, 0, 1, t.bus);
  if (!v) return;
  v.owner = t;
  S._tone(v, T, 0.13, { type: 'triangle', f: 210, f2: 146, sweep: 0.5, g: g * 0.5, dec: 0.12 });
  S._nz(v, T, 0.16, { type: 'highpass', f: 1250, q: 0.8, g: g * 0.9, dec: 0.15 });
  // the gate: held wide, then slammed shut mid-decay
  S._nz(v, T + 0.01, 0.24, {
    type: 'bandpass', f: 2100, q: 0.6, g: g * 0.55, atk: 0.006, hold: 0.185, rel: 0.012,
  });
}

Object.assign(STEP, {

  /* ---- HUNT — 96 BPM, D Phrygian. prowl, but something is in here with you. */
  hunt(S, t, s, T) {
    const st = s % 16, bar = (s / 16) | 0, vari = (bar >> 3) & 3;
    const barLen = t.stepDur * 16;

    const HK = [[0, 7], [0, 6, 11], [0, 9], [0, 5, 10]][vari];
    if (HK.indexOf(st) >= 0) kick(S, t, T, 0.7, 0.9, 0.36);

    // industrial percussion, darker and sparser than the corridors used to be
    if (h2(bar * 5 + vari, st * 11) > 0.8) {
      const v = S._v(3, null, 0, 0, 1, t.bus);
      if (v) {
        v.owner = t;
        const f = 340 * (1 + 2.6 * h2(st, bar + 19));
        const d = 0.06 + 0.14 * h2(bar, st + 5);
        S._nz(v, T, d, { type: 'bandpass', f, q: 13, g: 0.26, dec: d });
        S._own(v, t, 0.45);
      }
    }
    if (st === 6 && bar % 2 === 1) {
      const v = S._v(4, null, 0, 0, 1, t.bus);
      if (v) {
        v.owner = t;
        for (let k = 0; k < 2; k++) {
          S._nz(v, T, 0.34, { type: 'bandpass', f: 760 * METAL[k + 1], q: 17, g: 0.15 / (k + 1), dec: 0.32 });
        }
        S._own(v, t, 0.6);
      }
    }
    if (st % 4 === 2) hat(S, t, T, 0.04, false);

    // the brass-ish swell underneath — this is the part with teeth
    if (st === 0 && bar % 2 === 0) {
      S._own(S.superSaw(T, mtof(ROOT - 12), barLen * 2.15, mk(t, {
        n: 4, detune: 13, cutoff: 330, co0: 0.35, open: 0.55, g: 0.28,
        atk: barLen * 0.55, rel: barLen * 0.9, pri: 6,
      })), t, 0.12);
      const fifth = (bar >> 1) % 4 === 3 ? 1 : 7;      // slips to the flat second
      S._own(S.superSaw(T + 0.03, mtof(ROOT - 12 + fifth), barLen * 2.05, mk(t, {
        n: 3, detune: 17, cutoff: 340, co0: 0.5, g: 0.15, atk: barLen * 0.7, rel: barLen * 0.8, pri: 5,
      })), t, 0.3);
    }

    // Organic noises on their own clock. They deliberately do not land on the
    // grid: the hash is seeded from the absolute bar, so nothing ever repeats.
    if (h2(bar * 31, st * 7 + 3) > 0.965) {
      const v = S._v(5, null, 0, 0, 1, t.bus);
      if (v) {
        v.owner = t;
        const up = h2(bar, st) > 0.5;
        gullet(S, v, T, 1.1, [
          { f: up ? 300 : 520, f2: up ? 620 : 260, q: 6, g: 0.4 },
          { f: up ? 760 : 1150, f2: up ? 1250 : 640, q: 9, g: 0.18 },
        ], { g: 0.32, atk: 0.35, hold: 0.3, rel: 0.45, rate: 0.8, rate2: up ? 1.15 : 0.6 });
        S._own(v, t, 0.7);
      }
    }
    // a scrape somewhere off the corridor
    if (h2(bar * 17 + 5, st * 3) > 0.977) {
      const v = S._v(4, null, 0, 0, 1, t.bus);
      if (v) {
        v.owner = t;
        const sc = S._nz(v, T, 0.9, {
          type: 'bandpass', f: 1400, f2: 2300, q: 7, g: 0.24, atk: 0.01, dec: 0.88,
        });
        gate(S, v, sc, S._scrabbleCurve, T, 0.85);
        S._own(v, t, 0.75);
      }
    }
    // and once in a while, a long way off, something screams
    if (bar % 4 === 3 && st === 13) {
      const v = S._v(6, null, 0, 0, 1, t.bus);
      if (v) {
        v.owner = t;
        gullet(S, v, T, 1.6, [
          { f: 700, f2: 1900, q: 15, g: 0.4, sweep: 0.9 },
          { f: 1100, f2: 2700, q: 17, g: 0.26, sweep: 0.78 },
          { f: 1600, f2: 3400, q: 13, g: 0.12, sweep: 0.66 },
        ], { g: 0.16, atk: 0.4, hold: 0.6, rel: 0.6, rate: 0.9, rate2: 1.5 });
        S._own(v, t, 0.95);
      }
    }
    if (st === 0 && bar % 4 === 2) {
      S._own(S.subBoom(T, 34, 2.6, mk(t, { g: 0.32, drop: 0.5, sweep: 0.6, pri: 7 })), t, 0.8);
    }
  },

  /* ---- HERO — 118 BPM, D mixolydian. The warden's opinion of the warden. */
  hero(S, t, s, T) {
    const st = s % 16, bar = (s / 16) | 0, cyc = bar % 8;
    const sd = t.stepDur;
    // D D C G D D C A — the only chord progression he has ever needed
    const ROOTS = [0, 0, 10, 5, 0, 0, 10, 7];
    const root = ROOTS[cyc];
    const solo = cyc >= 4;

    if (st === 0 || st === 6 || st === 8 || st === 11) kick(S, t, T, 0.85, 1, 0.28);
    if (st === 4 || st === 12) gatedSnare(S, t, T, 0.5);
    if (st % 2 === 0 && st !== 4 && st !== 12) hat(S, t, T, 0.055, false);
    if (cyc === 0 && st === 0) hat(S, t, T, 0.16, true);
    if (cyc === 4 && st === 0) hat(S, t, T, 0.14, true);

    // palm-muted octave bass: every sixteenth, alternating octaves, all chug
    const oct = (st % 4 === 2 || st % 4 === 3) ? 12 : 0;
    S._own(S.acidBass(T, mtof(ROOT - 12 + root + oct), sd * 0.62, mk(t, {
      cutoff: 240, env: 820, q: 5, g: 0.34, accent: st % 4 === 0, decay: 0.5, drive: 1, pri: 6,
    })), t, 0.05);

    // power chords: root, fifth, octave — chugged, not strummed
    const CHUG = [0, 2, 3, 6, 7, 10, 11, 14];
    if (CHUG.indexOf(st) >= 0) {
      const long = st === 0 || st === 7;
      S._own(S.pad(T, [
        mtof(ROOT + 12 + root), mtof(ROOT + 19 + root), mtof(ROOT + 24 + root),
      ], long ? sd * 3.4 : sd * 1.25, mk(t, {
        g: 0.42, detune: 9, voices: 1, cutoff: 2600, q: 1.6,
        atk: 0.006, rel: long ? sd * 1.8 : sd * 0.7, pri: 6,
      })), t, 0.2);
    }

    // the solo. It is not a good solo. It is an extremely confident solo.
    const RUN = [7, 8, 9, 10, 9, 8, 9, 11, 10, 9, 8, 7, 8, 9, 7, 6];
    if (solo) {
      if (st % 2 === 0 || (cyc >= 6 && st % 2 === 1)) {
        const n = ROOT + 24 + root + pent(RUN[st]);
        const bend = st === 14 || st === 6;
        S._own(S.acidBass(T, mtof(n), sd * (bend ? 2.6 : 1.35), mk(t, {
          type: 'sawtooth', cutoff: 1700, env: 4200, q: 6.5, g: 0.2,
          slide: bend ? mtof(n + 2) : 0, decay: 0.55, accent: st % 4 === 0, pri: 7,
        })), t, 0.35);
        if (st % 4 === 0) {
          S._own(S.pluck(T + 0.006, mtof(n + 7), sd * 1.1, mk(t, {
            type: 'sawtooth', g: 0.07, cutoff: 3800, q: 3, pri: 5,
          })), t, 0.4);
        }
      }
    } else if (st === 8 || st === 13) {
      // the verse answer: two notes, delivered like they cost money
      const n = ROOT + 24 + root + pent(st === 8 ? 7 : 9);
      S._own(S.acidBass(T, mtof(n), sd * 2.2, mk(t, {
        type: 'sawtooth', cutoff: 1500, env: 3400, q: 6, g: 0.17, decay: 0.6, pri: 6,
      })), t, 0.4);
    }

    if (st === 0 && cyc === 0) {
      S._own(S.subBoom(T, 62, 0.9, mk(t, { g: 0.5, drop: 0.4, pri: 7 })), t, 0.2);
    }
  },
});

// Null-prototype the lookup tables: sfx('constructor') and music('toString')
// would otherwise find inherited Object members and try to call them.
Object.setPrototypeOf(SFX, null);
Object.setPrototypeOf(TRACKS, null);
Object.setPrototypeOf(CHORD, null);

/** Every sfx() name the game can call, for menus, tests and debug overlays. */
export const SFX_NAMES = Object.keys(SFX).sort();
/** Every music() track name. */
export const TRACK_NAMES = Object.keys(TRACKS);

export default Sound;
