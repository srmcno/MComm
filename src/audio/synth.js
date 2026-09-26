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

    // master chain: everything sums here. A slow-attack glue compressor lets
    // each transient through before it leans on the body, which is where punch
    // comes from; a fast one behind it holds the peaks, and the shaper after
    // that is the ceiling nothing gets past.
    this._comp = ctx.createDynamicsCompressor();
    this._comp.threshold.value = -14;
    this._comp.knee.value = 16;
    this._comp.ratio.value = 4;
    this._comp.attack.value = 0.008;
    this._comp.release.value = 0.22;

    this._peak = ctx.createDynamicsCompressor();
    this._peak.threshold.value = -2.5;
    this._peak.knee.value = 3;
    this._peak.ratio.value = 20;
    this._peak.attack.value = 0.001;
    this._peak.release.value = 0.09;

    // Final ceiling. The limiter's 1 ms attack still lets the very front of a
    // transient through, and a chain of airbursts can stack past 0 dBFS, so
    // everything ends in a shaper that is exactly linear below -4.2 dBFS and
    // cannot exceed ~0.95.
    this._pre = g(0.5);                  // halve, so the curve's domain covers +-2
    this._limit = ctx.createWaveShaper();
    this._limit.curve = limiterCurve(2048);
    this._limit.oversample = 'none';   // 2x resampling rings past the ceiling
    // The limiter adds its own make-up gain; take it back, so the soundtrack
    // sits exactly where it did before the limiter existed.
    this._peakTrim = g(0.85);
    this._comp.connect(this._peak);
    this._peak.connect(this._peakTrim);
    this._peakTrim.connect(this._pre);
    this._pre.connect(this._limit);
    this._limit.connect(ctx.destination);

    this._master = g(this._vMaster);
    this._master.connect(this._comp);

    // music: track -> duck (the announcer) -> pump (the explosions) -> volume
    this._music = g(this._vMusic);
    this._duck = g(1);
    this._pump = g(1);
    this._music.connect(this._master);
    this._pump.connect(this._music);
    this._duck.connect(this._pump);

    // Effects have their own bus compressor ahead of the volume: it glues a
    // gun, its room and whatever it hit into one event. The announcer joins at
    // the volume stage, after it, so an explosion never squashes a line.
    this._sfx = g(this._vSfx);
    this._sfx.connect(this._master);
    this._fxComp = ctx.createDynamicsCompressor();
    this._fxComp.threshold.value = -12;
    this._fxComp.knee.value = 8;
    this._fxComp.ratio.value = 2.5;
    this._fxComp.attack.value = 0.008;
    this._fxComp.release.value = 0.14;
    this._fxTrim = g(0.8);               // takes back the compressor's make-up gain
    this._fx = g(1);
    this._fx.connect(this._fxComp);
    this._fxComp.connect(this._fxTrim);
    this._fxTrim.connect(this._sfx);

    // Two rooms. Corridors are short, dark and concrete. The silo deck is open
    // air: longer, brighter, and it takes a beat to come back at you.
    this._convS = ctx.createConvolver();
    this._convS.normalize = true;
    this._convS.buffer = this._ir(0.85, 3.4, 0.30, 0.004);
    this._convS.connect(this._fx);

    const preB = ctx.createDelay(0.2);
    preB.delayTime.value = 0.024;
    this._convB = ctx.createConvolver();
    this._convB.normalize = true;
    this._convB.buffer = this._ir(3.1, 1.9, 0.78, 0.012);
    preB.connect(this._convB);
    this._convB.connect(this._fx);
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
    bkWarm(this);
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
    tail.connect(dest || this._fx);
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
      this._pump.gain.cancelScheduledValues(t);
      this._pump.gain.setValueAtTime(1, t);
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
      o.vol = clamp(fin(opts.vol, 1), 0, 4) * (MIX[name] || 1);
      o.rate = clamp(fin(opts.rate, 1), 0.25, 4);
      o.pan = clamp(fin(opts.pan, 0), -1, 1);
      o.delay = clamp(fin(opts.delay, 0), 0, 20);
      const t = this._t(this._now() + o.delay);
      fn(this, t, o);
      const p = PUMP[name];
      if (p) this._pumpMusic(t, p * Math.min(1, fin(opts.vol, 1)));
    } catch (e) { this._err = e; /* a broken sound effect must never stop the game */ }
  }

  /**
   * Sidechain, by hand: the big hits shove the music out of the way for a beat
   * and let it swell back. It is the cheapest way to make an explosion feel
   * bigger than the soundtrack, and it never touches the announcer's duck.
   */
  _pumpMusic(t, depth) {
    const p = this._pump && this._pump.gain;
    if (!p || depth < 0.02) return;
    try {
      const now = this._now(), cur = clamp(fin(p.value, 1), 0.05, 1);
      const floor = clamp(1 - depth, 0.3, 1);
      if (floor >= cur) return;          // already pushed down at least as far
      if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(now); else p.cancelScheduledValues(now);
      p.setValueAtTime(cur, now);
      p.linearRampToValueAtTime(floor, t + 0.02);
      p.setTargetAtTime(1, t + 0.09, 0.22);
    } catch (e) { /* ignore */ }
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

/** Baked recipes, by key. Filled by bake() calls throughout this section. */
const BK = Object.create(null);

/**
 * The mixing desk: a per-sound trim, applied to the caller's vol. Everything
 * was balanced by A-weighted loudness against the Widow, so a pickup no longer
 * outshouts a gunshot and a ghoul's pain no longer outshouts the ghoul.
 */
const MIX = Object.assign(Object.create(null), {
  flak_fire: 2.3, splitter_fire: 2, nailer_fire: 2.2, deadman_blow: 1.3, pipebomb_blow: 1.4,
  wrencher_alert: 0.55, wrencher_pain: 0.5, wrencher_die: 0.5, enemy_pain: 0.45, enemy_die: 0.5,
  ghoul_alert: 0.45, ghoul_pain: 0.38, ghoul_die: 0.45, howler_alert: 0.5, howler_pain: 0.42,
  howler_die: 0.45, priest_pain: 0.45, priest_die: 0.5, bellows_pain: 0.7, sparker_fire: 0.7,
  pickup_key: 0.45, pickup_treasure: 0.45, pickup_health: 0.7, pickup_weapon: 1.3, chain2: 0.75,
  chain3: 0.75, chain4: 0.75, chain5: 0.8, ricochet: 0.55, alarm: 0.7, limb_rip: 0.7,
  blood_spurt: 0.7, bone_bounce: 1.8, bone_crack: 1.8, meat_thud: 1.8, hit_flesh: 1.4, hit_wall: 1.3,
  head_punt: 0.5, kick_hit: 2, kick_wall: 2, kick_swing: 0.5, punt: 1.4, dryfire: 1.7, ui_move: 1.8,
  smart_evade: 0.6, pipebomb_land: 0.65, pipebomb_throw: 0.6, perfect_burst: 0.8, objective: 0.8,
  radio_open: 2, radio_close: 2.5, radio_static: 1.8,
});

/** How far each big hit pushes the music down (see Sound._pumpMusic). */
const PUMP = Object.assign(Object.create(null), {
  deadman_blow: 0.6, city_hit: 0.5, boss_death: 0.55, maw_die: 0.4, roof_open: 0.3,
  barrel_explode: 0.35, pipebomb_blow: 0.35, gorger_burst: 0.3, airburst: 0.22,
  splitter_fire: 0.16, flak_fire: 0.1, halo_fire: 0.14, player_die: 0.5,
});

/** Pitch jitter: every repeat of a sound lands a little differently. */
const jr = (S, o, w) => o.rate * (1 + (S._r() - 0.5) * w);

/* ---------------------------------------------------------- weapon recipes */
// Every gun is the same five parts in a different order of importance: the
// transient (the N-wave and the click), the body (a saturated pitch-dropping
// sine, the chamber), the blast (lowpassed noise closing like a fist), the
// mechanism (struck modes: frames, springs, pumps, cases) and the room (early
// reflections baked in; the convolver adds the tail live, in stereo).

// THE WIDOW. A hand cannon that happens to fire flak: BOOM, the thoonk of a
// shell leaving a tube, then the break-action relatching itself.
bake('widow', 0.6, 2, (d, sr, R) => {
  const j = 1 + (R() - 0.5) * 0.06;
  kClick(d, sr, 0, 1.4, 3);
  kNoise(d, sr, R, 0, 0.025, { type: 'hp', f0: 2600, q: 0.8, atk: 0.0002, tau: 0.006, amp: 5 });
  kThump(d, sr, 0.0008, 230 * j, 46 * j, 0.014, 0.08, 1.0, 3.5, 0.0006);
  kNoise(d, sr, R, 0.0005, 0.32, { type: 'lp', f0: 8000, f1: 420, sw: 0.09, q: 1.1, atk: 0.0006, tau: 0.045, amp: 6.5, col: 1 });
  kNoise(d, sr, R, 0.0008, 0.15, { type: 'bp', f0: 1300, f1: 520, q: 1.2, atk: 0.0008, tau: 0.03, amp: 5.5 });
  kMode(d, sr, 0.0015, 470 * j, 0.034, 0.45, 0.92);
  kMode(d, sr, 0.001, 2180 * j, 0.045, 0.1);
  kMode(d, sr, 0.001, 3390 * j, 0.03, 0.07);
  kMode(d, sr, 0.001, 5070 * j, 0.02, 0.05);
  kSlap(d, sr, [[0.013, 0.34], [0.024, 0.22], [0.041, 0.13], [0.067, 0.08]], 0.22);
  kSat(d, 1.9);
  kNorm(d, 1);
  const a = 0.24 + R() * 0.02, b = a + 0.034;
  kClick(d, sr, a, 0.07, 3);
  kMode(d, sr, a, 3300 * j, 0.006, 0.07);
  kThump(d, sr, b, 420, 250, 0.008, 0.014, 0.09, 1.5);
  kMode(d, sr, b, 2450 * j, 0.011, 0.07);
  kMode(d, sr, b, 4100 * j, 0.006, 0.05);
  kClick(d, sr, b, 0.08, 4);
});

// THE SPLITTER. Three shells through one breech: three cracks a few ms apart,
// a chest-deep boom, the pump racked back and slammed home, and the empty hull
// skittering off the deck.
bake('splitter', 1.05, 1, (d, sr, R) => {
  const j = 1 + (R() - 0.5) * 0.05;
  for (let s = 0; s < 3; s++) {
    const tt = s * (0.003 + R() * 0.0025);
    kClick(d, sr, tt, 0.9, 3);
    kNoise(d, sr, R, tt, 0.02, { type: 'hp', f0: 2200, q: 0.8, atk: 0.0002, tau: 0.005, amp: 3.2 });
  }
  kThump(d, sr, 0.001, 165 * j, 38 * j, 0.022, 0.12, 1.1, 4, 0.0008);
  kNoise(d, sr, R, 0.001, 0.5, { type: 'lp', f0: 9000, f1: 320, sw: 0.16, q: 0.9, atk: 0.0008, tau: 0.07, amp: 7.5, col: 1 });
  kNoise(d, sr, R, 0.002, 0.2, { type: 'bp', f0: 1500, f1: 600, q: 1.3, atk: 0.001, tau: 0.04, amp: 5.5 });
  kSlap(d, sr, [[0.011, 0.36], [0.021, 0.27], [0.034, 0.18], [0.055, 0.11], [0.083, 0.06]], 0.2);
  kSat(d, 2.3);
  kNorm(d, 1);
  // pump back: the slide, then the stop
  const pb = 0.33 + R() * 0.02;
  kNoise(d, sr, R, pb - 0.03, 0.05, { type: 'bp', f0: 1900, f1: 3200, q: 2.2, atk: 0.02, tau: 0.01, amp: 0.05 });
  kClick(d, sr, pb, 0.14, 3);
  kMode(d, sr, pb, 1850 * j, 0.012, 0.13);
  kMode(d, sr, pb + 0.003, 3120 * j, 0.008, 0.09);
  // pump forward: heavier, it is locking a shell in
  const pf = pb + 0.115;
  kNoise(d, sr, R, pf - 0.035, 0.05, { type: 'bp', f0: 3000, f1: 1700, q: 2.2, atk: 0.025, tau: 0.01, amp: 0.05 });
  kThump(d, sr, pf, 280, 150, 0.01, 0.02, 0.22, 1.5);
  kClick(d, sr, pf, 0.18, 3);
  kMode(d, sr, pf, 2280 * j, 0.015, 0.16);
  kMode(d, sr, pf, 3650 * j, 0.01, 0.1);
  kMode(d, sr, pf, 5400 * j, 0.006, 0.06);
  // the hull: hollow plastic with a brass base, bouncing shorter each time
  const hb = [0.64, 0.765, 0.85, 0.9, 0.93];
  for (let i = 0; i < hb.length; i++) {
    const a = 0.075 / (1 + i * 0.75), tt = hb[i] + R() * 0.01;
    kClick(d, sr, tt, a, 2);
    kMode(d, sr, tt, 1080 * j * (1 + R() * 0.12), 0.01, a * 0.8);
    kMode(d, sr, tt, 2760 * j, 0.022, a * 0.7);
    kMode(d, sr, tt, 4230 * j, 0.016, a * 0.45);
  }
});

// THE NAILDRIVER. Ten a second, so every variant is a slightly different
// thunk-tick-hiss and no two in a row are the same.
bake('nailer', 0.2, 5, (d, sr, R) => {
  const j = 1 + (R() - 0.5) * 0.1;
  kClick(d, sr, 0, 0.7, 2);
  kThump(d, sr, 0, 185 * j, 68 * j, 0.009, 0.026, 0.8, 2.6, 0.0005);
  kMode(d, sr, 0.0005, 2950 * j, 0.007, 0.34);
  kMode(d, sr, 0.0005, 4620 * j, 0.005, 0.24);
  kMode(d, sr, 0.0008, 1640 * j, 0.011, 0.2);
  kMode(d, sr, 0.001, 540 * j, 0.016, 0.4);
  kNoise(d, sr, R, 0, 0.05, { type: 'bp', f0: 1300, f1: 600, q: 1.5, atk: 0.0005, tau: 0.012, amp: 4.2 });
  kNoise(d, sr, R, 0.006, 0.11, { type: 'bp', f0: 3200, f1: 5200, q: 0.9, atk: 0.003, tau: 0.024, amp: 1.3 });
  kSlap(d, sr, [[0.009, 0.24], [0.019, 0.13]], 0.3);
  kSat(d, 1.6);
});

// THE HALO. Spin-up whine, a whoomp you feel in your teeth, a hot crackle, and
// the ring of the emitter hanging in the air after.
bake('halo', 1.5, 1, (d, sr, R) => {
  const j = 1 + (R() - 0.5) * 0.04, w = 0.1;
  kTone(d, sr, 0, w + 0.01, 320 * j, 2600 * j, 0.22, 0.08, 0, 1);
  kNoise(d, sr, R, 0, w, { type: 'bp', f0: 600, f1: 5200, q: 3, atk: w * 0.9, tau: 0.01, amp: 0.25 });
  kClick(d, sr, w, 0.8, 4);
  kThump(d, sr, w, 150 * j, 34 * j, 0.05, 0.2, 1.2, 2.6, 0.005);
  kNoise(d, sr, R, w, 0.8, { type: 'bp', f0: 3600, f1: 170, sw: 0.45, q: 3.4, atk: 0.003, tau: 0.2, amp: 4.5 });
  kNoise(d, sr, R, w, 0.5, { type: 'lp', f0: 5000, f1: 300, sw: 0.3, q: 0.9, atk: 0.002, tau: 0.08, amp: 3.5, col: 1 });
  kCrackle(d, sr, R, w + 0.01, 0.75, 1500, 0.55, 1.6);
  kMode(d, sr, w + 0.02, 1180 * j, 0.36, 0.13);
  kMode(d, sr, w + 0.02, 1188 * j, 0.4, 0.11);
  kMode(d, sr, w + 0.02, 1772 * j, 0.3, 0.08);
  kMode(d, sr, w + 0.02, 2361 * j, 0.22, 0.05);
  kSlap(d, sr, [[0.017, 0.25], [0.031, 0.15]], 0.35);
  kSat(d, 1.5);
});

// The ring blooming at the fuse range: a band of air torn round in a circle.
bake('halo_ring', 0.95, 1, (d, sr, R) => {
  kNoise(d, sr, R, 0, 0.9, { type: 'bp', f0: 240, f1: 5200, sw: 0.55, q: 4.5, atk: 0.2, tau: 0.22, amp: 1, am: [17, 0.6] });
  kNoise(d, sr, R, 0.02, 0.8, { type: 'bp', f0: 480, f1: 7800, sw: 0.5, q: 5, atk: 0.22, tau: 0.2, amp: 0.5, am: [23, 0.5] });
  kCrackle(d, sr, R, 0.15, 0.7, 900, 0.5, 1.2);
});

// DEADMAN'S SWITCH, the hand end of it: the guard flipped, the key turned, a
// single klaxon whoop. Everything after that is deadman_blow.
bake('deadman_key', 0.7, 1, (d, sr, R) => {
  kClick(d, sr, 0, 0.3, 3);
  kMode(d, sr, 0, 2700, 0.01, 0.3);
  kMode(d, sr, 0, 4300, 0.006, 0.2);
  kThump(d, sr, 0.07, 240, 120, 0.01, 0.03, 0.6, 2);
  kMode(d, sr, 0.07, 1500, 0.02, 0.3);
  kMode(d, sr, 0.07, 2350, 0.014, 0.2);
  kClick(d, sr, 0.07, 0.4, 4);
  kTone(d, sr, 0.12, 0.5, 420, 1250, 0.35, 0.02, 0.25, 2, [9, 0.02]);
  kTone(d, sr, 0.12, 0.5, 423, 1262, 0.2, 0.02, 0.25, 2);
});

// The nuke. Flash, then a pressure wave that bottoms out below hearing, then a
// roar that crackles with things burning a long way off.
bakeLo('nuke', 1.95, 1, (d, sr, R) => {
  kClick(d, sr, 0, 1.2, 5);
  kNoise(d, sr, R, 0, 0.06, { type: 'hp', f0: 1800, q: 0.7, atk: 0.0005, tau: 0.018, amp: 4 });
  kThump(d, sr, 0.002, 95, 18, 0.12, 0.5, 1.4, 3.2, 0.004);
  kNoise(d, sr, R, 0.002, 1.9, { type: 'lp', f0: 6000, f1: 110, sw: 1.2, q: 0.8, atk: 0.004, tau: 0.55, amp: 5.5, col: 2 });
  kNoise(d, sr, R, 0.05, 1.85, { type: 'bp', f0: 900, f1: 200, sw: 1.8, q: 0.8, atk: 0.15, tau: 0.6, amp: 3.5, col: 1, grain: 0.5 });
  kCrackle(d, sr, R, 0.03, 1.8, 700, 0.5, 1.2);
  kSat(d, 2.6);
});

/* ---------------------------------------------------------- explosion recipes */

// A flak shell in the open sky: all crack and air, and less floor than anything
// that goes off on the ground.
bake('burst', 1.0, 2, (d, sr, R) => {
  const j = 1 + (R() - 0.5) * 0.12;
  kClick(d, sr, 0, 1, 4);
  kNoise(d, sr, R, 0, 0.04, { type: 'hp', f0: 2400 * j, q: 0.7, atk: 0.0003, tau: 0.009, amp: 4.5 });
  kThump(d, sr, 0.002, 125 * j, 34 * j, 0.03, 0.15, 1.1, 2.8, 0.002);
  kNoise(d, sr, R, 0.001, 0.9, { type: 'lp', f0: 6500, f1: 220, sw: 0.35, q: 0.9, atk: 0.001, tau: 0.13, amp: 6.5, col: 1 });
  kCrackle(d, sr, R, 0.01, 0.5, 2200, 0.5, 2.2);
  kSat(d, 2.1);
});

// A chain secondary. Thirty can land at once, so it is a single buffer.
bake('burst_s', 0.7, 3, (d, sr, R) => {
  const j = 1 + (R() - 0.5) * 0.2;
  kClick(d, sr, 0, 0.7, 3);
  kThump(d, sr, 0.001, 160 * j, 50 * j, 0.02, 0.1, 0.9, 2.4, 0.001);
  kNoise(d, sr, R, 0, 0.7, { type: 'lp', f0: 5500 * j, f1: 240, sw: 0.25, q: 1, atk: 0.001, tau: 0.1, amp: 5.5, col: 1 });
  kCrackle(d, sr, R, 0.01, 0.35, 1600, 0.4, 2);
  kSat(d, 1.8);
});

// A barrel. Floor-shaking, then the drum itself tearing (inharmonic metal
// bending flat as it goes), a gout of fire, and everything coming back down.
bake('barrel', 1.6, 1, (d, sr, R) => {
  const j = 1 + (R() - 0.5) * 0.08;
  kClick(d, sr, 0, 1.1, 4);
  kNoise(d, sr, R, 0, 0.05, { type: 'hp', f0: 1900, q: 0.7, atk: 0.0003, tau: 0.012, amp: 4 });
  kThump(d, sr, 0.002, 135 * j, 30 * j, 0.04, 0.24, 1.3, 3.6, 0.002);
  kNoise(d, sr, R, 0.002, 1.1, { type: 'lp', f0: 5500, f1: 200, sw: 0.5, q: 1, atk: 0.002, tau: 0.22, amp: 6.5, col: 1 });
  for (let m = 0; m < METAL.length; m++) {
    kMode(d, sr, 0.004 + R() * 0.01, 290 * j * METAL[m], 0.28 / (1 + m * 0.3), 0.2 / (1 + m * 0.4), 0.9);
  }
  kNoise(d, sr, R, 0.03, 1.0, { type: 'bp', f0: 420, f1: 1500, sw: 0.25, q: 1.3, atk: 0.06, tau: 0.28, amp: 3.2, am: [11, 0.5], col: 1 });
  kDebris(d, sr, R, 0.25, 1.3, 70, 900, 6200, 0.3, 0.01);
  kSlap(d, sr, [[0.019, 0.3], [0.037, 0.18]], 0.2);
  kSat(d, 2.4);
});

// A pipe bomb in a corridor: tight, dry, over-driven, and full of shrapnel.
bake('pipe', 0.85, 1, (d, sr, R) => {
  const j = 1 + (R() - 0.5) * 0.08;
  kClick(d, sr, 0, 1.3, 3);
  kNoise(d, sr, R, 0, 0.03, { type: 'hp', f0: 2800, q: 0.7, atk: 0.0002, tau: 0.007, amp: 5 });
  kThump(d, sr, 0.001, 175 * j, 40 * j, 0.02, 0.12, 1.2, 5, 0.001);
  kNoise(d, sr, R, 0.001, 0.5, { type: 'lp', f0: 8000, f1: 300, sw: 0.18, q: 1, atk: 0.001, tau: 0.08, amp: 7, col: 1 });
  kMode(d, sr, 0.001, 1150 * j, 0.05, 0.2);
  kMode(d, sr, 0.001, 1627 * j, 0.04, 0.14);
  kDebris(d, sr, R, 0.03, 0.7, 45, 1600, 8000, 0.3, 0.007);
  kSlap(d, sr, [[0.008, 0.42], [0.015, 0.33], [0.026, 0.24], [0.039, 0.15], [0.061, 0.09]], 0.25);
  kSat(d, 3);
});

/* ------------------------------------------------------------- weapons */

const SFX = {

  // THE WIDOW
  flak_fire(S, t, o) {
    const v = V(S, o, 6, 0.3, 0.14); if (!v) return;
    const r = jr(S, o, 0.05);
    smp(S, v, t, 'widow', { g: 1.05, rate: r });
    // the room answering, in stereo, which the baked mono layer cannot do
    S._nz(v, t + 0.006, 0.55, { type: 'lowpass', f: 1400 * r, f2: 110, q: 0.8, g: 0.26, atk: 0.004, dec: 0.5, pink: true });
  },

  // THE SPLITTER. weapons.js still points the Splitter at flak_fire; this is
  // the sound it should be making.
  splitter_fire(S, t, o) {
    const v = V(S, o, 7, 0.34, 0.16); if (!v) return;
    const r = jr(S, o, 0.04);
    smp(S, v, t, 'splitter', { g: 1.1, rate: r });
    S._nz(v, t + 0.008, 0.8, { type: 'lowpass', f: 1200 * r, f2: 90, q: 0.8, g: 0.34, atk: 0.005, dec: 0.72, pink: true });
  },

  // The fuse dial. Plays on every wheel notch, so: one buffer, pitched by rate.
  flak_arm(S, t, o) {
    const v = V(S, o, 2, 0.1, 0); if (!v) return;
    smp(S, v, t, 'tick', { g: 0.5, rate: jr(S, o, 0.06) });
  },

  // The money sound: crack, body, and thunder that rolls away across the deck.
  airburst(S, t, o) {
    const v = V(S, o, 9, 0.2, 0.72); if (!v) return;
    const r = jr(S, o, 0.1);
    smp(S, v, t, 'burst', { g: 1.05, rate: r });
    const roll = S._nz(v, t + 0.05, 2.6, { type: 'lowpass', f: 520 * r, f2: 85, q: 0.9, g: 0.5, atk: 0.12, dec: 2.4, pink: true });
    gate(S, v, roll, S._crackleCurve, t + 0.05, 2.5);
  },

  airburst_small(S, t, o) {
    const v = V(S, o, 7, 0.2, 0.5); if (!v) return;
    smp(S, v, t, 'burst_s', { g: 0.9, rate: jr(S, o, 0.25) });
  },

  nailer_fire(S, t, o) {
    const v = V(S, o, 5, 0.16, 0); if (!v) return;
    smp(S, v, t, 'nailer', { g: 0.85, rate: jr(S, o, 0.07) });
  },

  halo_fire(S, t, o) {
    const v = V(S, o, 7, 0.22, 0.45); if (!v) return;
    const r = jr(S, o, 0.03);
    smp(S, v, t, 'halo', { g: 1.0, rate: r });
    // a live shimmer on top, so the hang of the ring moves in the stereo field
    const sh = S._nz(v, t + 0.12, 1.2, { type: 'bandpass', f: 4800 * r, f2: 2400 * r, q: 3, g: 0.12, atk: 0.02, dec: 1.1 });
    S._lfo(v, t + 0.12, 1.25, sh.gain, 13, 0.06);
  },

  halo_sweep(S, t, o) {
    const v = V(S, o, 5, 0.18, 0.5); if (!v) return;
    smp(S, v, t, 'halo_ring', { g: 0.75, rate: jr(S, o, 0.05) });
  },

  deadman_arm(S, t, o) {
    const v = V(S, o, 8, 0.3, 0.2); if (!v) return;
    smp(S, v, t, 'deadman_key', { g: 0.7, rate: o.rate });
  },

  deadman_blow(S, t, o) {
    const v = V(S, o, 11, 0.2, 0.95); if (!v) return;
    smp(S, v, t, 'nuke', { g: 1.2, rate: o.rate });
    // below the buffer: a sub that keeps falling for three seconds
    S._tone(v, t, 3.2, { type: 'sine', f: 52 * o.rate, f2: 14, sweep: 0.8, g: 0.8, atk: 0.01, dec: 3.0 });
    const roar = S._nz(v, t + 0.4, 4.2, { type: 'lowpass', f: 700, f2: 70, q: 0.9, g: 0.75, atk: 0.4, dec: 3.7, pink: true });
    gate(S, v, roar, S._crackleCurve, t + 0.4, 4.1);
  },

  // A lighter pistol, kept for anything that wants a plain gunshot.
  pistol_fire(S, t, o) {
    const v = V(S, o, 5, 0.3, 0.1); if (!v) return;
    smp(S, v, t, 'widow', { g: 0.7, rate: jr(S, o, 0.05) * 1.45, hp: 180 });
  },

  dryfire(S, t, o) {
    const v = V(S, o, 3, 0.2, 0); if (!v) return;
    smp(S, v, t, 'dry', { g: 0.6, rate: jr(S, o, 0.05) });
  },

  reload(S, t, o) {
    const v = V(S, o, 4, 0.22, 0); if (!v) return;
    smp(S, v, t, 'reload', { g: 0.7, rate: jr(S, o, 0.04) });
  },

  weapon_switch(S, t, o) {
    const v = V(S, o, 4, 0.2, 0); if (!v) return;
    smp(S, v, t, 'switch', { g: 0.65, rate: jr(S, o, 0.05) });
  },
};

/* ------------------------------------------------ handling, dial, empties */

bake('tick', 0.05, 3, (d, sr, R) => {
  kClick(d, sr, 0, 0.5, 2);
  kMode(d, sr, 0, 4200 * (1 + R() * 0.1), 0.003, 0.5);
  kMode(d, sr, 0, 6650, 0.002, 0.3);
  kMode(d, sr, 0, 980, 0.006, 0.25);
});

// A hammer falling on nothing, and the trigger coming back.
bake('dry', 0.14, 3, (d, sr, R) => {
  const j = 1 + (R() - 0.5) * 0.08;
  kClick(d, sr, 0, 0.6, 2);
  kMode(d, sr, 0, 3800 * j, 0.004, 0.5);
  kMode(d, sr, 0, 5900 * j, 0.003, 0.3);
  kMode(d, sr, 0.001, 1250 * j, 0.016, 0.2);
  kClick(d, sr, 0.045, 0.25, 2);
  kMode(d, sr, 0.045, 2900 * j, 0.004, 0.2);
});

// Mag out, mag in, slide racked: the whole ritual in 0.7 s.
bake('reload', 0.75, 1, (d, sr, R) => {
  const j = 1 + (R() - 0.5) * 0.06;
  kNoise(d, sr, R, 0, 0.06, { type: 'bp', f0: 1500, f1: 2600, q: 2, atk: 0.04, tau: 0.01, amp: 0.2 });
  kClick(d, sr, 0.06, 0.4, 3); kMode(d, sr, 0.06, 2100 * j, 0.012, 0.35); kMode(d, sr, 0.06, 3300 * j, 0.008, 0.2);
  kNoise(d, sr, R, 0.24, 0.08, { type: 'bp', f0: 2400, f1: 1300, q: 2, atk: 0.05, tau: 0.01, amp: 0.2 });
  kThump(d, sr, 0.31, 260, 160, 0.01, 0.025, 0.5, 1.5);
  kClick(d, sr, 0.31, 0.5, 3); kMode(d, sr, 0.31, 1650 * j, 0.016, 0.4); kMode(d, sr, 0.31, 2800 * j, 0.01, 0.25);
  kNoise(d, sr, R, 0.47, 0.07, { type: 'bp', f0: 1800, f1: 3400, q: 2.4, atk: 0.05, tau: 0.01, amp: 0.2 });
  kClick(d, sr, 0.53, 0.4, 3); kMode(d, sr, 0.53, 2500 * j, 0.012, 0.3);
  kThump(d, sr, 0.6, 300, 170, 0.01, 0.02, 0.5, 1.5);
  kClick(d, sr, 0.6, 0.6, 3); kMode(d, sr, 0.6, 2250 * j, 0.016, 0.45); kMode(d, sr, 0.6, 3700 * j, 0.01, 0.3);
});

// Leather, a sling of steel coming round, and the new gun announcing itself.
bake('switch', 0.42, 3, (d, sr, R) => {
  const j = 1 + (R() - 0.5) * 0.08;
  kNoise(d, sr, R, 0, 0.16, { type: 'bp', f0: 500, f1: 2600, q: 1.6, atk: 0.09, tau: 0.03, amp: 0.35, col: 1 });
  kMode(d, sr, 0.12, 1420 * j, 0.03, 0.25); kMode(d, sr, 0.12, 2230 * j, 0.02, 0.18); kClick(d, sr, 0.12, 0.2, 3);
  const c = 0.2 + R() * 0.02;
  kClick(d, sr, c, 0.45, 3); kMode(d, sr, c, 2600 * j, 0.01, 0.4); kMode(d, sr, c, 4000 * j, 0.006, 0.25);
  kThump(d, sr, c + 0.07, 300, 170, 0.01, 0.022, 0.6, 1.8);
  kClick(d, sr, c + 0.07, 0.55, 3); kMode(d, sr, c + 0.07, 2150 * j, 0.016, 0.45); kMode(d, sr, c + 0.07, 3500 * j, 0.01, 0.3);
});

/* ------------------------------------------------------- impacts / world */

// A nail into concrete: the chip, a spit of grit, the thud behind it.
bake('chip', 0.26, 4, (d, sr, R) => {
  const j = 1 + (R() - 0.5) * 0.2;
  kClick(d, sr, 0, 0.8, 2);
  kNoise(d, sr, R, 0, 0.05, { type: 'bp', f0: 3400 * j, f1: 2200 * j, q: 1.2, atk: 0.0003, tau: 0.008, amp: 3.5 });
  kThump(d, sr, 0, 420 * j, 210 * j, 0.006, 0.012, 0.7, 2);
  kNoise(d, sr, R, 0.002, 0.08, { type: 'lp', f0: 2400, f1: 500, q: 1, atk: 0.001, tau: 0.018, amp: 2.2, col: 1 });
  kDebris(d, sr, R, 0.012, 0.16, 7, 2500, 8000, 0.25, 0.004);
});

// A nail into something that was alive a moment ago.
bake('thwack', 0.25, 3, (d, sr, R) => {
  const j = 1 + (R() - 0.5) * 0.2;
  kClick(d, sr, 0, 0.5, 4);
  kThump(d, sr, 0, 160 * j, 72 * j, 0.012, 0.03, 1, 2.2);
  kNoise(d, sr, R, 0, 0.09, { type: 'bp', f0: 900 * j, f1: 320, q: 1.4, atk: 0.0008, tau: 0.022, amp: 4.5, col: 1 });
  kSquish(d, sr, R, 0.004, 0.11, 10, 260, 1100, 0.3, 1.8);
});

// The whine of something tumbling away at a thousand feet a second.
bake('rico', 0.5, 4, (d, sr, R) => {
  const f = 2400 + R() * 1600, f1 = f * (0.3 + R() * 0.12), L = 0.3 + R() * 0.15;
  kClick(d, sr, 0, 0.7, 2);
  kNoise(d, sr, R, 0, 0.03, { type: 'bp', f0: 3800, q: 2, atk: 0.0003, tau: 0.006, amp: 2.5 });
  kTone(d, sr, 0.004, L, f, f1, 0.6, 0.006, L * 0.5, 0, [38 + R() * 30, 0.025]);
  kTone(d, sr, 0.004, L * 0.8, f * 1.51, f1 * 1.49, 0.15, 0.006, L * 0.35, 0);
});

// Industrial door: a latch you can hear the weight behind, and the stop.
bake('latch', 0.3, 1, (d, sr, R) => {
  const j = 1 + (R() - 0.5) * 0.06;
  kThump(d, sr, 0, 150 * j, 70 * j, 0.02, 0.05, 1, 2.5);
  kClick(d, sr, 0, 0.5, 5);
  kMode(d, sr, 0.001, 690 * j, 0.06, 0.3);
  kMode(d, sr, 0.001, 1130 * j, 0.045, 0.22);
  kMode(d, sr, 0.001, 1870 * j, 0.03, 0.14);
  kNoise(d, sr, R, 0, 0.1, { type: 'lp', f0: 1800, f1: 300, q: 1, atk: 0.001, tau: 0.025, amp: 2, col: 1 });
  kSlap(d, sr, [[0.014, 0.3], [0.027, 0.18]], 0.3);
});

// The far end of a slab of steel hitting its stop, and ringing about it.
bakeLo('slam', 0.9, 1, (d, sr, R) => {
  const j = 1 + (R() - 0.5) * 0.05;
  kThump(d, sr, 0, 110 * j, 42 * j, 0.03, 0.12, 1.2, 3);
  kClick(d, sr, 0, 0.6, 6);
  kNoise(d, sr, R, 0, 0.25, { type: 'lp', f0: 3000, f1: 200, q: 1.1, atk: 0.001, tau: 0.05, amp: 4, col: 1 });
  for (let m = 0; m < METAL.length; m++) kMode(d, sr, 0.002, 212 * j * METAL[m], 0.35 / (1 + m * 0.35), 0.16 / (1 + m * 0.5));
  kDebris(d, sr, R, 0.02, 0.3, 8, 1500, 5000, 0.12, 0.006);
  kSlap(d, sr, [[0.017, 0.35], [0.031, 0.2], [0.052, 0.12]], 0.25);
  kSat(d, 1.6);
});

// Hydraulics: the pressure let go, with the hiss going thin as it empties.
bake('hiss', 0.55, 1, (d, sr, R) => {
  kNoise(d, sr, R, 0, 0.55, { type: 'bp', f0: 2600, f1: 4800, q: 0.9, atk: 0.01, hold: 0.12, tau: 0.12, amp: 2.4 });
  kNoise(d, sr, R, 0, 0.3, { type: 'bp', f0: 700, f1: 1400, q: 2, atk: 0.005, tau: 0.05, amp: 1.2 });
});

// A slab of stone that has not moved since the bunker was poured, moving.
bakeLo('grind', 1.2, 1, (d, sr, R) => {
  kNoise(d, sr, R, 0, 1.2, { type: 'bp', f0: 170, f1: 260, q: 1.4, atk: 0.08, hold: 0.8, tau: 0.08, amp: 6, col: 2, grain: 0.7 });
  kNoise(d, sr, R, 0, 1.2, { type: 'bp', f0: 900, f1: 1300, q: 2, atk: 0.1, hold: 0.8, tau: 0.08, amp: 1.2, grain: 0.55 });
  kDebris(d, sr, R, 0.05, 1.05, 30, 700, 3000, 0.14, 0.01);
  kThump(d, sr, 0, 90, 45, 0.03, 0.12, 0.8, 2);
});

// Payday. A box of shells has weight and it rattles.
bake('ammo', 0.36, 1, (d, sr, R) => {
  kThump(d, sr, 0, 190, 110, 0.015, 0.03, 0.7, 2);
  kClick(d, sr, 0, 0.4, 4);
  for (let c = 0; c < 9; c++) {
    const tt = 0.01 + Math.pow(R(), 1.4) * 0.16, f = 2200 + R() * 3600;
    kMode(d, sr, tt, f, 0.02, 0.2 + R() * 0.2);
    kMode(d, sr, tt, f * 1.63, 0.012, 0.1);
  }
  kThump(d, sr, 0.17, 240, 150, 0.01, 0.025, 0.6, 2);
  kClick(d, sr, 0.17, 0.35, 4);
  kMode(d, sr, 0.17, 1500, 0.03, 0.3);
  kMode(d, sr, 0.17, 2600, 0.02, 0.2);
});

// A ring of keys, shaken once.
bake('keys', 0.45, 1, (d, sr, R) => {
  for (let c = 0; c < 14; c++) {
    const tt = Math.pow(R(), 1.5) * 0.28, f = 2800 + R() * 4400;
    kMode(d, sr, tt, f, 0.03 + R() * 0.04, 0.15 + R() * 0.2);
    kMode(d, sr, tt, f * 2.76, 0.015, 0.06);
    kClick(d, sr, tt, 0.08, 2);
  }
});

// Coins. A lot of coins.
bake('coins', 0.8, 1, (d, sr, R) => {
  for (let c = 0; c < 34; c++) {
    const tt = Math.pow(R(), 1.3) * 0.55, f = 3000 + R() * 3500;
    kMode(d, sr, tt, f, 0.04 + R() * 0.08, 0.1 + R() * 0.18);
    kMode(d, sr, tt, f * 1.48, 0.03, 0.05);
    kMode(d, sr, tt, f * 2.31, 0.02, 0.04);
  }
});

// The pickup riff: a palm-muted D5 power chord through a cranked amp. It is
// the single most 1996 sound in the game and it is not sorry.
bakeLo('riff', 0.9, 1, (d, sr, R) => {
  const F = [73.42, 110, 146.83];
  for (let i = 0; i < 3; i++) {
    kTone(d, sr, 0, 0.9, F[i] * 1.004, F[i], 0.5, 0.004, 0.32, 1);
    kTone(d, sr, 0.002, 0.9, F[i] * 0.997, F[i] * 0.998, 0.4, 0.004, 0.3, 1);
  }
  kSat(d, 5);
  kFilt(d, sr, 0, 0.9, 'lp', 4200, 1600, 0.9);
  kNoise(d, sr, R, 0, 0.03, { type: 'bp', f0: 2500, q: 1, atk: 0.001, tau: 0.008, amp: 0.8 });
});

// Red alert. A horn through a cheap PA, whooping upward twice.
bakeLo('klaxon', 1.3, 1, (d, sr) => {
  for (let k = 0; k < 2; k++) {
    kTone(d, sr, k * 0.62, 0.55, 380, 760, 0.6, 0.03, 0, 2, [7, 0.01]);
    kTone(d, sr, k * 0.62, 0.55, 385, 770, 0.4, 0.03, 0, 1);
  }
  kSat(d, 3);
  kFilt(d, sr, 0, 1.3, 'bp', 1200, 1200, 0.9);
});

// A lift arriving. Everyone knows this ding; that is the joke.
bakeLo('ding', 1.4, 1, (d, sr) => {
  kBell(d, sr, 0, 1318.5, [1, 2.01, 2.76, 4.1], 0.5, 0.5);
  kBell(d, sr, 0.28, 1046.5, [1, 2.01, 2.76, 4.1], 0.6, 0.5);
});

Object.assign(SFX, {

  hit_wall(S, t, o) {
    const v = V(S, o, 3, 0.35, 0); if (!v) return;
    smp(S, v, t, 'chip', { g: 0.75, rate: jr(S, o, 0.12) });
  },

  hit_flesh(S, t, o) {
    const v = V(S, o, 4, 0.25, 0); if (!v) return;
    smp(S, v, t, 'thwack', { g: 0.85, rate: jr(S, o, 0.14) });
  },

  ricochet(S, t, o) {
    const v = V(S, o, 4, 0.4, 0.15); if (!v) return;
    smp(S, v, t, 'rico', { g: 0.55, rate: jr(S, o, 0.2) });
  },

  barrel_explode(S, t, o) {
    const v = V(S, o, 9, 0.42, 0.4); if (!v) return;
    const r = jr(S, o, 0.06);
    smp(S, v, t, 'barrel', { g: 1.1, rate: r });
    S._tone(v, t, 1.3, { type: 'sine', f: 58 * r, f2: 22, sweep: 0.6, g: 0.55, atk: 0.004, dec: 1.2 });
    // what is left of the barrel, still burning
    const fire = S._nz(v, t + 0.2, 2.2, { type: 'bandpass', f: 650, f2: 300, q: 0.8, g: 0.3, atk: 0.2, dec: 1.9, pink: true });
    gate(S, v, fire, S._crackleCurve, t + 0.2, 2.1);
  },

  // A door opens in 0.6 s: latch, hydraulics and motor, then the stop.
  door_open(S, t, o) {
    const v = V(S, o, 6, 0.5, 0.1); if (!v) return;
    const r = jr(S, o, 0.05);
    smp(S, v, t, 'latch', { g: 0.8, rate: r });
    smp(S, v, t + 0.04, 'hiss', { g: 0.3, rate: r });
    S._tone(v, t + 0.05, 0.6, { type: 'sawtooth', f: 62 * r, f2: 96 * r, sweep: 0.8, g: 0.2, atk: 0.06, hold: 0.4, rel: 0.1 });
    const run = S._nz(v, t + 0.05, 0.6, { type: 'bandpass', f: 240, f2: 420, q: 2.2, g: 0.55, atk: 0.06, hold: 0.42, rel: 0.08, pink: true });
    gate(S, v, run, S._grindCurve, t + 0.05, 0.58);
    smp(S, v, t + 0.6, 'slam', { g: 0.5, rate: r * 1.25 });
  },

  door_close(S, t, o) {
    const v = V(S, o, 6, 0.55, 0.1); if (!v) return;
    const r = jr(S, o, 0.05);
    smp(S, v, t, 'hiss', { g: 0.22, rate: r * 0.9 });
    S._tone(v, t, 0.6, { type: 'sawtooth', f: 96 * r, f2: 60 * r, sweep: 0.8, g: 0.2, atk: 0.05, hold: 0.45, rel: 0.1 });
    const run = S._nz(v, t, 0.62, { type: 'bandpass', f: 420, f2: 230, q: 2.2, g: 0.55, atk: 0.05, hold: 0.47, rel: 0.08, pink: true });
    gate(S, v, run, S._grindCurve, t, 0.6);
    smp(S, v, t + 0.59, 'slam', { g: 1.0, rate: r });
  },

  // Locked: the handle rattles, the latch refuses, and the buzzer is smug.
  door_locked(S, t, o) {
    const v = V(S, o, 5, 0.4, 0); if (!v) return;
    smp(S, v, t, 'latch', { g: 0.55, rate: 1.2 });
    smp(S, v, t + 0.085, 'latch', { g: 0.45, rate: 1.32 });
    const bz = S._tone(v, t + 0.16, 0.42, { type: 'square', f: 116, g: 0.2, atk: 0.006, hold: 0.32, rel: 0.06 });
    S._lfo(v, t + 0.16, 0.44, bz.gain, 24, 0.12);
  },

  // Stone moving, and then the bunker admitting you found something.
  secret_found(S, t, o) {
    const v = V(S, o, 7, 0.6, 0.2); if (!v) return;
    smp(S, v, t, 'grind', { g: 0.9, rate: jr(S, o, 0.04) });
    const N = [74, 81, 86, 93];
    for (let i = 0; i < 4; i++) {
      S.fmBell(t + 0.5 + i * 0.09, mtof(N[i]), 1.6 - i * 0.2, {
        g: 0.22, ratio: 2.007, index: 3.2, revB: 0.35, revS: 0.2, pri: 7, vol: o.vol, pan: o.pan,
      });
    }
    S._nz(v, t + 0.5, 0.9, { type: 'highpass', f: 5500, q: 0.7, g: 0.08, atk: 0.2, dec: 0.6 });
  },

  // A glug and a bright major third: it tastes like medicine and victory.
  pickup_health(S, t, o) {
    const v = V(S, o, 5, 0.25, 0); if (!v) return;
    smp(S, v, t, 'glug', { g: 0.55, rate: o.rate });
    S._tone(v, t + 0.06, 0.3, { type: 'triangle', f: 587 * o.rate, g: 0.2, atk: 0.004, dec: 0.28 });
    S._tone(v, t + 0.14, 0.55, { type: 'triangle', f: 880 * o.rate, g: 0.22, atk: 0.004, dec: 0.5 });
    S._tone(v, t + 0.14, 0.6, { type: 'sine', f: 1760 * o.rate, g: 0.07, atk: 0.01, dec: 0.55 });
  },

  pickup_ammo(S, t, o) {
    const v = V(S, o, 4, 0.3, 0); if (!v) return;
    smp(S, v, t, 'ammo', { g: 0.8, rate: jr(S, o, 0.05) });
    smp(S, v, t + 0.2, 'switch', { g: 0.35, rate: 1.15, k: 2 });
  },

  pickup_key(S, t, o) {
    const v = V(S, o, 6, 0.3, 0.2); if (!v) return;
    smp(S, v, t, 'keys', { g: 0.6, rate: o.rate });
    S.fmBell(t + 0.12, mtof(88), 1.5, { g: 0.22, ratio: 3.01, index: 3, revB: 0.3, pri: 6, vol: o.vol, pan: o.pan });
    S.fmBell(t + 0.2, mtof(95), 1.2, { g: 0.14, ratio: 2.007, index: 2, revB: 0.3, pri: 5, vol: o.vol, pan: o.pan });
  },

  pickup_treasure(S, t, o) {
    const v = V(S, o, 6, 0.28, 0.25); if (!v) return;
    smp(S, v, t, 'coins', { g: 0.7, rate: o.rate });
    const N = [81, 86, 88, 93];
    for (let i = 0; i < 4; i++) {
      S.fmBell(t + 0.05 + i * 0.06, mtof(N[i]), 1.1 + i * 0.25, {
        g: 0.18, ratio: 2.007, index: 2.6, revS: 0.25, revB: 0.35, pri: 6, vol: o.vol, pan: o.pan,
      });
    }
  },

  pickup_weapon(S, t, o) {
    const v = V(S, o, 7, 0.3, 0.2); if (!v) return;
    smp(S, v, t, 'switch', { g: 0.8, rate: 0.9, k: 1 });
    smp(S, v, t + 0.24, 'riff', { g: 0.55, rate: o.rate });
    S._tone(v, t + 0.24, 0.5, { type: 'sine', f: 73.4 * o.rate, f2: 55 * o.rate, sweep: 0.6, g: 0.4, atk: 0.004, dec: 0.45 });
  },

  // The lift: the brake letting go, the motor, the cable, and the ding.
  elevator(S, t, o) {
    const v = V(S, o, 6, 0.5, 0); if (!v) return;
    smp(S, v, t, 'latch', { g: 0.7, rate: 0.8 });
    const m = S._tone(v, t + 0.1, 2.2, { type: 'sawtooth', f: 52, f2: 76, sweep: 0.4, g: 0.24, atk: 0.35, hold: 1.2, rel: 0.5 });
    S._lfo(v, t + 0.1, 2.3, m.gain, 7.5, 0.06);
    const cab = S._nz(v, t + 0.1, 2.1, { type: 'bandpass', f: 1500, f2: 2300, q: 5, g: 0.2, atk: 0.4, hold: 1.1, rel: 0.5 });
    gate(S, v, cab, S._scrabbleCurve, t + 0.1, 2.05);
    S._nz(v, t + 0.1, 2.1, { type: 'lowpass', f: 380, f2: 650, q: 3, g: 0.22, atk: 0.4, dec: 1.6, pink: true });
    smp(S, v, t + 2.2, 'ding', { g: 0.35 });
  },

  // The roof grinding open. The siege starts here, so it had better be enormous.
  roof_open(S, t, o) {
    const v = V(S, o, 10, 0.35, 0.9); if (!v) return;
    smp(S, v, t, 'slam', { g: 0.9, rate: 0.62 });
    smp(S, v, t + 0.25, 'hiss', { g: 0.4, rate: 0.7 });
    // two motors, slightly out of phase with each other
    const m1 = S._tone(v, t, 4.6, { type: 'sawtooth', f: 31, f2: 44, sweep: 0.7, g: 0.42, atk: 0.9, hold: 2.6, rel: 1.0 });
    const m2 = S._tone(v, t + 0.05, 4.4, { type: 'sawtooth', f: 47, f2: 63, sweep: 0.7, g: 0.24, atk: 1.1, hold: 2.3, rel: 0.9 });
    S._lfo(v, t, 4.7, m1.gain, 5.2, 0.13);
    S._lfo(v, t, 4.6, m2.gain, 3.1, 0.08);
    S._tone(v, t, 4.5, { type: 'sine', f: 26, f2: 33, sweep: 0.8, g: 0.55, atk: 1.2, hold: 2.0, rel: 1.2 });
    // the grind itself: a stuttering gain curve on a swept band of noise
    const grind = S._nz(v, t, 4.3, {
      type: 'bandpass', f: 210, f2: 900, q: 6, g: 0.55, atk: 0.5, hold: 2.8, rel: 0.9, pink: true,
    });
    gate(S, v, grind, S._grindCurve, t, 4.2);
    S._nz(v, t + 0.2, 4.0, { type: 'highpass', f: 2400, q: 0.7, g: 0.07, atk: 1.0, hold: 2.0, rel: 0.9 });
    // and it slams home
    smp(S, v, t + 4.35, 'slam', { g: 1.2, rate: 0.55 });
    S._tone(v, t + 4.35, 0.9, { type: 'sine', f: 70, f2: 26, sweep: 0.45, g: 0.8, dec: 0.8 });
  },

  alarm(S, t, o) {
    const v = V(S, o, 7, 0.4, 0.5); if (!v) return;
    smp(S, v, t, 'klaxon', { g: 0.5, rate: o.rate });
  },
});

// The medical kind of swallow: a big bubble going up, and the gulp.
bakeLo('glug', 0.35, 1, (d, sr, R) => {
  kBubble(d, sr, 0, 240, 0.03, 0.8, 2.5);
  kBubble(d, sr, 0.07, 330, 0.03, 0.7, 2.2);
  kThump(d, sr, 0.14, 190, 120, 0.02, 0.04, 0.5, 1.5);
  kNoise(d, sr, R, 0.13, 0.08, { type: 'bp', f0: 600, f1: 350, q: 2, atk: 0.005, tau: 0.02, amp: 1.2 });
});

/* ============================================================ the bake kit */
// Some layers are better computed than patched. A gunshot's crack, a shell
// casing bouncing on concrete, a grunt with an actual glottis behind it: as live
// graphs those cost a dozen nodes each and still sound like filters. Rendered
// once into a mono buffer they cost two nodes (a source and a gain) and can be
// as detailed as the arithmetic allows.
//
// Recipes are registered with bake() next to the sounds that use them. Each is
// rendered on first use, or earlier by the idle warm-up, from a seeded RNG, and
// normalised to a peak of 1 so the sound that plays it sets the level. Buffers
// are shared by every context at the same sample rate, which the spec allows
// and the render tools, which build a context per sound, appreciate.

const TWO_PI = Math.PI * 2;
const BAKED = Object.create(null);          // `${sr}:${key}` -> AudioBuffer[]
const kNow = () => (globalThis.performance && performance.now ? performance.now() : Date.now());

/** Register a recipe: `n` variants of `len` seconds, rendered by fn(d, sr, R, k). */
function bake(key, len, n, fn, lo) { BK[key] = { len, n, fn, lo: !!lo, last: -1 }; }

/**
 * The same, rendered at half the context rate. Voices, roars and rumbles have
 * nothing above 10 kHz worth keeping, and this halves what they cost to hold.
 */
function bakeLo(key, len, n, fn) { bake(key, len, n, fn, true); }

function kSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

function kRng(seed) {
  let s = (seed >>> 0) || 1;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

function bkBuf(S, key, k) {
  const r = BK[key];
  if (!r) return null;
  const ctx = S._ctx, sr = r.lo ? ctx.sampleRate / 2 : ctx.sampleRate;
  const id = ctx.sampleRate + ':' + key;
  const arr = BAKED[id] || (BAKED[id] = []);
  if (arr[k]) return arr[k];
  const n = Math.max(64, Math.ceil(r.len * sr));
  const d = new Float32Array(n);
  r.fn(d, sr, kRng(kSeed(key) + k * 7919), k);
  kFinish(d, sr);
  const b = ctx.createBuffer(1, n, sr);
  if (b.copyToChannel) b.copyToChannel(d, 0); else b.getChannelData(0).set(d);
  arr[k] = b;
  return b;
}

/**
 * Play a baked layer into voice `v`. a: { g, rate, k (variant; default is a
 * random one that is never the last one played), to, lp | hp (+q) }.
 * Returns the layer's gain node, or null.
 */
function smp(S, v, t, key, a) {
  const r = BK[key];
  if (!r || !v.alive) return null;
  let k = a.k;
  if (k === undefined) {
    k = (S._r() * r.n) | 0;
    if (r.n > 1 && k === r.last) k = (k + 1) % r.n;
  }
  k = clamp(k | 0, 0, r.n - 1);
  r.last = k;
  const buf = bkBuf(S, key, k);
  if (!buf) return null;
  const ctx = S._ctx;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const rate = clamp(fin(a.rate, 1), 0.1, 8);
  src.playbackRate.value = rate;
  const g = ctx.createGain();
  g.gain.value = fin(a.g, 1);
  S._n(v, src); S._n(v, g);
  if (a.lp || a.hp) {
    const b = ctx.createBiquadFilter();
    b.type = a.lp ? 'lowpass' : 'highpass';
    b.frequency.value = clamp(fin(a.lp || a.hp, 1000), 20, 20000);
    b.Q.value = clamp(fin(a.q, 0.7), 0.0001, 30);
    src.connect(b); b.connect(g); S._n(v, b);
  } else src.connect(g);
  g.connect(a.to || v.out);
  S._go(v, src, t, buf.duration / rate + 0.01);
  return g;
}

/**
 * Render every recipe ahead of need, a few milliseconds at a time, so the first
 * shot of the game does not pay for its own buffer. Anything asked for before
 * the warm-up reaches it is simply rendered on the spot.
 */
function bkWarm(S) {
  const st = globalThis.setTimeout;
  if (typeof st !== 'function' || S._offline) return;
  const keys = Object.keys(BK);
  let i = 0, k = 0;
  const step = () => {
    if (!S._ready) return;
    const t0 = kNow();
    try {
      while (i < keys.length && kNow() - t0 < 5) {
        bkBuf(S, keys[i], k);
        if (++k >= BK[keys[i]].n) { k = 0; i++; }
      }
    } catch (e) { S._err = e; return; }
    if (i < keys.length) st(step, 20);
  };
  try { st(step, 300); } catch (e) { /* no timers: everything bakes on demand */ }
}

/* ---- the DSP. Everything adds into d (Float32Array, mono) in place. ---- */

const kIx = (sr, t) => (t > 0 ? Math.round(t * sr) : 0);

/** Piecewise-linear lookup in [[t, v], ...]. */
function kAt(pts, t) {
  if (typeof pts === 'number') return pts;
  if (t <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const b = pts[i];
    if (t < b[0]) { const a = pts[i - 1]; return a[1] + (b[1] - a[1]) * (t - a[0]) / (b[0] - a[0]); }
  }
  return pts[pts.length - 1][1];
}

/** A struck resonance: exponentially damped sine. tau = seconds to 1/e. */
function kMode(d, sr, t0, f, tau, amp, glide) {
  let i = kIx(sr, t0);
  const end = Math.min(d.length, i + Math.ceil(tau * 7 * sr));
  let w = Math.min(Math.PI * 0.95, TWO_PI * f / sr);
  const dec = Math.exp(-1 / (tau * sr));
  if (!glide) {
    // two-pole recursion: a damped sine for two multiplies a sample
    const c = 2 * dec * Math.cos(w), r2 = dec * dec;
    let y1 = amp * Math.sin(w) * dec, y2 = 0;
    if (i < end) d[i++] += 0;
    for (; i < end; i++) { d[i] += y1; const y = c * y1 - r2 * y2; y2 = y1; y1 = y; }
    return;
  }
  const gl = Math.pow(glide, 1 / (tau * 3 * sr));
  let a = amp, ph = 0;
  for (; i < end; i++) { d[i] += a * Math.sin(ph); ph += w; w *= gl; a *= dec; }
}

/** A bank of modes with the same excitation: ratios[], taus scale per mode. */
function kBell(d, sr, t0, f, ratios, tau, amp, R) {
  for (let m = 0; m < ratios.length; m++) {
    const jf = R ? 1 + (R() - 0.5) * 0.02 : 1;
    kMode(d, sr, t0, f * ratios[m] * jf, tau / (1 + m * 0.45), amp / (1 + m * 0.6));
  }
}

/**
 * Sine thump with an exponential pitch drop (f0 -> f1, time constant tp), linear
 * attack, exponential decay tau. `drive` saturates it while it is loud and lets
 * it go clean as it decays, which is what a kick drum and a gunshot both do.
 */
function kThump(d, sr, t0, f0, f1, tp, tau, amp, drive, atk) {
  const i0 = kIx(sr, t0), n = Math.min(d.length, i0 + Math.ceil(tau * 8 * sr));
  const at = Math.max(1, (atk || 0.0015) * sr), dr = drive || 0, nd = dr ? kSc(dr) : 1;
  const kp = Math.exp(-1 / (tp * sr)), ke = Math.exp(-1 / (tau * sr)), w1 = TWO_PI * f1 / sr;
  let ph = 0, wx = TWO_PI * (f0 - f1) / sr, e = 1;
  for (let i = i0; i < n; i++) {
    const j = i - i0;
    ph += w1 + wx; wx *= kp;
    const s = Math.sin(ph) * e * (j < at ? j / at : 1);
    e *= ke;
    d[i] += amp * (dr ? kSc(s * dr) / nd : s);
  }
}

/** Cheap tanh: a rational fit, exact enough for colour and far faster. */
function kSc(x) {
  if (x > 3) return 1;
  if (x < -3) return -1;
  const x2 = x * x;
  return x * (27 + x2) / (27 + 9 * x2);
}

/**
 * Filtered noise burst through a state-variable filter whose cutoff sweeps
 * exponentially from f0 to f1 over `sw` seconds.
 * o: { type: lp|hp|bp, f0, f1, sw, q, atk, tau, hold, amp, col: 0 white | 1 pink | 2 brown,
 *      am: [rate Hz, depth] (flutter), grain: 0..1 (sparse gating, for spatter) }
 */
function kNoise(d, sr, R, t0, len, o) {
  const atk = Math.max(1e-4, o.atk || 0.001), tau = o.tau || len * 0.3, hold = o.hold || 0;
  // nothing is audible 80 dB down, so stop there rather than at `len`
  const i0 = kIx(sr, t0), n = Math.min(d.length, i0 + Math.ceil(Math.min(len, atk + hold + tau * 9.2) * sr));
  const mode = o.type === 'bp' ? 1 : o.type === 'hp' ? 2 : 0, q = o.q || 0.7, k = 1 / q;
  const f0 = o.f0 || 1000, f1 = o.f1 || f0, sw = o.sw || len;
  const amp = o.amp === undefined ? 1 : o.amp, col = o.col || 0;
  const am = o.am, grain = o.grain || 0;
  const fadeN = Math.max(1, Math.min(0.004, len * 0.2) * sr);
  const iA = atk * sr, iH = (atk + hold) * sr, kd = Math.exp(-1 / (tau * sr));
  const amW = am ? TWO_PI * am[0] / sr : 0;
  let ic1 = 0, ic2 = 0, a1 = 0, a2 = 0, a3 = 0, ed = 1;
  let b0 = 0, b1 = 0, b2 = 0, br = 0, gv = 1, gcount = 0;
  for (let i = i0; i < n; i++) {
    const j = i - i0;
    if ((j & 15) === 0) {
      const t = j / sr;
      const f = Math.min(sr * 0.45, t >= sw ? f1 : f0 * Math.pow(f1 / f0, t / sw));
      const g = Math.tan(Math.PI * f / sr);
      a1 = 1 / (1 + g * (g + k)); a2 = g * a1; a3 = g * a2;
    }
    const w = R() * 2 - 1;
    let x;
    if (col === 0) x = w;
    else if (col === 1) {
      b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913;
      x = (b0 + b1 + b2 + w * 0.1848) * 0.25;
    } else { br = br * 0.985 + w * 0.12; x = br; }
    const v3 = x - ic2, v1 = a1 * ic1 + a2 * v3, v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1; ic2 = 2 * v2 - ic2;
    const y = mode === 0 ? v2 : mode === 1 ? v1 * k : x - k * v1 - v2;
    let e;
    if (j < iA) e = j / iA;
    else if (j < iH) e = 1;
    else { e = ed; ed *= kd; }
    if (n - i < fadeN) e *= (n - i) / fadeN;
    if (am) e *= 1 - am[1] * (0.5 + 0.5 * Math.sin(amW * j));
    if (grain) {
      if (--gcount <= 0) { gcount = 1 + ((R() * sr * 0.004) | 0); gv = R() < grain ? 0.25 + R() : 0.03; }
      e *= gv;
    }
    d[i] += y * e * amp;
  }
}

/** Filter a region of d in place (same SVF, swept f0 -> f1). */
function kFilt(d, sr, t0, t1, type, f0, f1, q) {
  const i0 = kIx(sr, t0), n = Math.min(d.length, t1 ? kIx(sr, t1) : d.length);
  const k = 1 / (q || 0.7), span = Math.max(1, n - i0);
  let ic1 = 0, ic2 = 0, a1 = 0, a2 = 0, a3 = 0;
  for (let i = i0; i < n; i++) {
    if (((i - i0) & 15) === 0) {
      const f = Math.min(sr * 0.45, f0 * Math.pow((f1 || f0) / f0, (i - i0) / span));
      const g = Math.tan(Math.PI * f / sr);
      a1 = 1 / (1 + g * (g + k)); a2 = g * a1; a3 = g * a2;
    }
    const x = d[i];
    const v3 = x - ic2, v1 = a1 * ic1 + a2 * v3, v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1; ic2 = 2 * v2 - ic2;
    d[i] = type === 'lp' ? v2 : type === 'bp' ? v1 * k : x - k * v1 - v2;
  }
}

/** A click: one raised-cosine lobe `w` samples wide, with a smaller rebound. */
function kClick(d, sr, t0, amp, w) {
  const i0 = kIx(sr, t0), ww = Math.max(2, w | 0);
  for (let j = 0; j < ww * 2 && i0 + j < d.length; j++) {
    const s = j < ww ? Math.sin(Math.PI * j / ww) : -0.45 * Math.sin(Math.PI * (j - ww) / ww);
    d[i0 + j] += amp * s;
  }
}

/**
 * A bubble (Minnaert): a damped sine whose pitch rises as it collapses. A few
 * dozen of them is wet; a few hundred is a mess. rise = fractional pitch rise.
 */
function kBubble(d, sr, t0, f, tau, amp, rise) {
  let i = kIx(sr, t0);
  const end = Math.min(d.length, i + Math.ceil(tau * 6 * sr)), i0 = i;
  const dec = Math.exp(-1 / (tau * sr)), rr = rise === undefined ? 1.2 : rise;
  let a = amp, ph = 0;
  for (; i < end; i++) {
    const t = (i - i0) / sr;
    ph += TWO_PI * f * (1 + rr * t / tau) / sr;
    // a 1 ms rise, or every bubble is a click
    d[i] += a * Math.sin(ph) * (t < 0.001 ? t * 1000 : 1);
    a *= dec;
  }
}

/** Scatter `count` bubbles over [t0, t0+span], density falling off with `fall`. */
function kSquish(d, sr, R, t0, span, count, fLo, fHi, amp, fall) {
  for (let b = 0; b < count; b++) {
    const u = Math.pow(R(), fall || 1.6);
    const f = fLo * Math.pow(fHi / fLo, R());
    kBubble(d, sr, t0 + u * span, f, 0.004 + 0.012 * R() * (600 / f), amp * (0.35 + 0.65 * R()) * (1 - u * 0.6), 0.6 + R() * 1.6);
  }
}

/**
 * Debris: small struck things landing over [t0, t0+span], thinning out as they
 * do. f range sets what it is made of (grit, glass, bolts, bone).
 */
function kDebris(d, sr, R, t0, span, count, fLo, fHi, amp, tau) {
  for (let b = 0; b < count; b++) {
    const u = Math.pow(R(), 1.8);
    const f = fLo * Math.pow(fHi / fLo, R());
    const a = amp * (0.3 + 0.7 * R()) * (1 - u * 0.7);
    const tt = t0 + u * span;
    kMode(d, sr, tt, f, (tau || 0.012) * (0.5 + R()), a);
    kClick(d, sr, tt, a * 0.8, 2 + R() * 4);
  }
}

/** Crackle: sparse impulses at `rate` per second, thinning by `fall` (power). */
function kCrackle(d, sr, R, t0, len, rate, amp, fall) {
  const i0 = kIx(sr, t0), n = Math.min(d.length, i0 + Math.ceil(len * sr));
  const p = rate / sr;
  for (let i = i0; i < n; i++) {
    const u = (i - i0) / (n - i0);
    if (R() < p * Math.pow(1 - u, fall || 1)) {
      const a = amp * (R() < 0.15 ? 1 : 0.2 + 0.5 * R()) * (R() < 0.5 ? -1 : 1);
      d[i] += a; if (i + 1 < n) d[i + 1] -= a * 0.6;
    }
  }
}

/** Soft clip a region. The gain is compensated, so drive changes colour only. */
function kSat(d, drive, t0, t1, sr) {
  const i0 = sr ? kIx(sr, t0) : 0, n = sr && t1 ? Math.min(d.length, kIx(sr, t1)) : d.length;
  let pk = 0;
  for (let i = i0; i < n; i++) { const a = Math.abs(d[i]); if (a > pk) pk = a; }
  if (pk <= 0) return;
  const s = drive / pk, nd = pk / kSc(drive);
  for (let i = i0; i < n; i++) d[i] = nd * kSc(d[i] * s);
}

/**
 * Early reflections: delayed, darkened copies of everything so far. This is the
 * "room" that tells you the gun went off indoors, before the convolver's tail.
 * taps: [[seconds, gain], ...]; lp is a one-pole coefficient (lower = darker).
 */
function kSlap(d, sr, taps, lp) {
  const src = d.slice(), a = lp || 0.3;
  for (let k = 0; k < taps.length; k++) {
    const D = kIx(sr, taps[k][0]), g = taps[k][1];
    let z = 0;
    for (let i = D; i < d.length; i++) { z += a * (src[i - D] - z); d[i] += g * z; }
  }
}

/**
 * A pitched tone sweeping exponentially f0 -> f1 over len, attack atk, then
 * exponential decay tau (0 = flat). wave: 0 sine, 1 buzzy (odd+even harmonics),
 * 2 square-ish. vib: [rate Hz, depth as a pitch fraction].
 */
function kTone(d, sr, t0, len, f0, f1, amp, atk, tau, wave, vib) {
  const L = tau ? Math.min(len, (atk || 0) + tau * 9.2) : len;
  const i0 = kIx(sr, t0), n = Math.min(d.length, i0 + Math.ceil(L * sr));
  const at = Math.max(1, (atk || 0.002) * sr), fadeN = Math.max(1, Math.min(0.006, L * 0.3) * sr);
  const step = Math.pow(f1 / f0, 1 / (len * sr)), kd = tau ? Math.exp(-1 / (tau * sr)) : 1;
  const vw = vib ? TWO_PI * vib[0] / sr : 0, vd = vib ? vib[1] : 0;
  let ph = 0, w = TWO_PI * f0 / sr, e = 1;
  for (let i = i0; i < n; i++) {
    const j = i - i0;
    ph += vib ? w * (1 + vd * Math.sin(vw * j)) : w;
    w *= step;
    let env = j < at ? j / at : (e *= kd);
    if (n - i < fadeN) env *= (n - i) / fadeN;
    let s = Math.sin(ph);
    if (wave === 1) {
      const c = Math.cos(ph), s2 = 2 * s * c, c2 = 1 - 2 * s * s;
      s = 0.6 * s + 0.3 * s2 + 0.2 * (s * c2 + c * s2) + 0.12 * (2 * s2 * c2);
    } else if (wave === 2) s = kSc(4 * s);
    d[i] += amp * env * s;
  }
}

/** Scale everything so the loudest sample is `pk`. For staging layers mid-recipe. */
function kNorm(d, pk) {
  let m = 0;
  for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > m) m = a; }
  if (m > 1e-9) { const s = pk / m; for (let i = 0; i < d.length; i++) d[i] *= s; }
}

/** Multiply a region by env(u), u = 0..1 across it. */
function kShape(d, sr, t0, t1, env) {
  const i0 = kIx(sr, t0), n = Math.min(d.length, kIx(sr, t1)), span = Math.max(1, n - i0);
  for (let i = i0; i < n; i++) d[i] *= env((i - i0) / span);
}

/** DC out, normalise to a peak of 1, fade the last few ms to a true zero. */
function kFinish(d, sr) {
  const n = d.length, c = Math.exp(-TWO_PI * 18 / sr);
  let x1 = 0, y1 = 0, pk = 0;
  for (let i = 0; i < n; i++) {
    const x = d[i], y = x - x1 + c * y1;
    x1 = x; y1 = y; d[i] = y;
    const a = Math.abs(y); if (a > pk) pk = a;
  }
  if (!(pk > 1e-9)) return;
  const s = 1 / pk, f = Math.min(n, Math.ceil(sr * 0.006));
  for (let i = 0; i < n; i++) d[i] *= s;
  for (let i = 0; i < f; i++) d[n - 1 - i] *= i / f;
}

/*
 * The throat. A Rosenberg glottal pulse (with jitter, shimmer and optional
 * period-doubling growl) and a breath source, through a cascade of four formant
 * resonators, Klatt style. Cascade rather than parallel because it gets the
 * relative formant levels right for free: this is what makes a grunt read as a
 * person, or as something that used to be one.
 */
const VOWEL = {
  a: [730, 1090, 2440, 3400], ae: [660, 1720, 2410, 3400], eh: [530, 1840, 2480, 3500],
  ih: [390, 1990, 2550, 3600], iy: [270, 2290, 3010, 3700], uh: [640, 1190, 2390, 3400],
  aw: [570, 840, 2410, 3400], oo: [440, 1020, 2240, 3300], uw: [300, 870, 2240, 3300],
  er: [490, 1350, 1690, 3300], ow: [500, 900, 2300, 3300], mm: [250, 1200, 2200, 3300],
};

/**
 * o: { f0: [[t, hz]...], v: [[t, 'vowel']...], amp: [[t, a]...], asp: [[t, a]...]
 *      (breath level, independent of voicing), tract (formant scale, <1 = bigger),
 *      jit, shim, growl (0..1), press (0 lax .. 1 pressed/shouted), bw }
 */
function kVoice(d, sr, R, t0, dur, o) {
  const i0 = kIx(sr, t0), n = Math.min(d.length, i0 + Math.ceil(dur * sr));
  const tract = o.tract || 1, jit = o.jit === undefined ? 0.012 : o.jit;
  const shim = o.shim === undefined ? 0.12 : o.shim, growl = o.growl || 0;
  const press = o.press === undefined ? 0.5 : o.press, bwS = o.bw || 1;
  const oq = 0.72 - 0.34 * press, tp = oq * 0.62, tn = oq * 0.38;
  const vs = o.v || [[0, 'a']];
  const BW = [70 * bwS, 95 * bwS, 150 * bwS, 220 * bwS];
  const y1 = [0, 0, 0, 0], y2 = [0, 0, 0, 0], A = [0, 0, 0, 0], B = [0, 0, 0, 0], C = [0, 0, 0, 0];
  let ph = 0, prevU = 0, per = 0, pj = 1, pa = 1, f0 = 100, amp = 0, asp = 0, lp = 0;
  for (let i = i0; i < n; i++) {
    const t = (i - i0) / sr;
    if (((i - i0) & 31) === 0) {
      f0 = kAt(o.f0, t); amp = kAt(o.amp || [[0, 1]], t); asp = kAt(o.asp || [[0, 0.06]], t);
      // vowel: find the segment and blend its two tables
      let va = VOWEL[vs[0][1]], vb = va, u = 0;
      for (let s = 1; s < vs.length; s++) {
        if (t < vs[s][0]) { va = VOWEL[vs[s - 1][1]]; vb = VOWEL[vs[s][1]]; u = (t - vs[s - 1][0]) / (vs[s][0] - vs[s - 1][0]); break; }
        va = vb = VOWEL[vs[s][1]]; u = 0;
      }
      for (let m = 0; m < 4; m++) {
        const F = Math.min(sr * 0.42, (va[m] + (vb[m] - va[m]) * u) * tract);
        const r = Math.exp(-Math.PI * BW[m] / sr);
        C[m] = -r * r; B[m] = 2 * r * Math.cos(TWO_PI * F / sr); A[m] = 1 - B[m] - C[m];
      }
    }
    ph += f0 * pj / sr;
    if (ph >= 1) {
      ph -= 1; per++;
      pj = 1 + (R() * 2 - 1) * jit;
      pa = (1 - R() * shim) * (growl && (per & 1) ? 1 - growl : 1);
    }
    let u;
    if (ph < tp) u = 0.5 - 0.5 * Math.cos(Math.PI * ph / tp);
    else if (ph < tp + tn) u = Math.cos(0.5 * Math.PI * (ph - tp) / tn);
    else u = 0;
    const e = (u - prevU) * sr / Math.max(40, f0) * 0.02;
    prevU = u;
    const w = R() * 2 - 1;
    lp += 0.45 * (w - lp);
    let x = e * pa * amp + lp * asp * (0.35 + 0.65 * u + (amp < 0.05 ? 0.65 : 0));
    for (let m = 0; m < 4; m++) {
      const y = A[m] * x + B[m] * y1[m] + C[m] * y2[m];
      y2[m] = y1[m]; y1[m] = y; x = y;
    }
    d[i] += x;
  }
}

/* ------------------------------------------------------------- enemies */
// The day shift, what is left of it. Each one gets its own throat now: kVoice
// is a glottis and a vocal tract, so the barks are words-ish (HEY, OI, UGH) in
// each man's own register, with jitter so no two are quite the same. Every
// kind has an alert, a pain and a death; the game currently routes the humans'
// pain and death through the generic enemy_pain / enemy_die, which draw from
// all of them at random, so a firefight is never one man grunting on a loop.

/** source -> two bandpass formants -> voice out. The old cheap throat, kept for
 *  the sounds that want a synth rather than a person. */
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

/** Ring-modulate a region against a sine: the voice through a bad transformer. */
function kRing(d, sr, t0, t1, f, mix) {
  const i0 = kIx(sr, t0), n = Math.min(d.length, kIx(sr, t1)), w = TWO_PI * f / sr;
  for (let i = i0; i < n; i++) d[i] *= 1 - mix + mix * Math.sin(w * (i - i0));
}

/** Sample-and-hold decimation: the cheap-DSP grit on anything electrical. */
function kCrush(d, sr, t0, t1, hold) {
  const i0 = kIx(sr, t0), n = Math.min(d.length, kIx(sr, t1));
  let v = 0;
  for (let i = i0; i < n; i++) { if ((i - i0) % hold === 0) v = Math.round(d[i] * 12) / 12; d[i] = v; }
}

/** A wet death rattle: breath through fluid. */
function kGurgle(d, sr, R, t0, span, amp) {
  kNoise(d, sr, R, t0, span, { type: 'bp', f0: 700, f1: 380, q: 1.8, atk: 0.03, hold: span * 0.4, tau: span * 0.2, amp: amp * 1.5, col: 1, am: [9, 0.6] });
  kSquish(d, sr, R, t0, span, 16, 180, 700, amp * 0.5, 1);
}

// The Wrencher: day-shift fitter, lungs like a bellows, opinions to match.
bakeLo('wr_alert', 0.62, 4, (d, sr, R, k) => {
  const p = 1 + (R() - 0.5) * 0.1;
  if (k === 0) {        // HEY!
    kVoice(d, sr, R, 0, 0.42, { f0: [[0, 125 * p], [0.09, 178 * p], [0.3, 150 * p], [0.42, 118 * p]],
      v: [[0, 'eh'], [0.2, 'eh'], [0.34, 'iy']], amp: [[0, 0], [0.05, 0], [0.08, 1], [0.32, 0.9], [0.42, 0]],
      asp: [[0, 0.5], [0.07, 0.3], [0.1, 0.05]], press: 0.85, growl: 0.12, jit: 0.02, tract: 0.97 });
  } else if (k === 1) { // OI!
    kVoice(d, sr, R, 0, 0.4, { f0: [[0, 150 * p], [0.08, 196 * p], [0.4, 140 * p]],
      v: [[0, 'aw'], [0.16, 'aw'], [0.3, 'iy']], amp: [[0, 0], [0.02, 1], [0.3, 0.9], [0.4, 0]],
      press: 0.9, growl: 0.15, jit: 0.02, tract: 0.97 });
  } else if (k === 2) { // HUH?!
    kVoice(d, sr, R, 0, 0.36, { f0: [[0, 105 * p], [0.18, 118 * p], [0.36, 205 * p]],
      v: [[0, 'uh']], amp: [[0, 0], [0.06, 0], [0.1, 1], [0.3, 0.9], [0.36, 0]],
      asp: [[0, 0.55], [0.08, 0.3], [0.12, 0.05]], press: 0.7, growl: 0.1, tract: 0.97 });
  } else {              // HEY YOU!
    kVoice(d, sr, R, 0, 0.6, { f0: [[0, 130 * p], [0.08, 172 * p], [0.22, 150 * p], [0.3, 185 * p], [0.6, 120 * p]],
      v: [[0, 'eh'], [0.14, 'iy'], [0.26, 'iy'], [0.36, 'uw']], amp: [[0, 0], [0.05, 0], [0.08, 1], [0.24, 0.6], [0.3, 1], [0.52, 0.9], [0.6, 0]],
      asp: [[0, 0.5], [0.07, 0.25], [0.1, 0.04]], press: 0.9, growl: 0.14, jit: 0.02, tract: 0.97 });
  }
  kSat(d, 1.6);
});

// Pain: the grunt of a man who did not expect a nail there.
bakeLo('grunt', 0.32, 6, (d, sr, R, k) => {
  const p = [1, 1.12, 0.9, 1.25, 0.8, 1.05][k] * (1 + (R() - 0.5) * 0.06);
  const V2 = [['uh', 'uh'], ['a', 'uh'], ['uw', 'uw'], ['eh', 'uh'], ['aw', 'uh'], ['ae', 'a']][k];
  const L = 0.18 + R() * 0.1;
  if (k === 5) kNoise(d, sr, R, 0, 0.02, { type: 'bp', f0: 2200, q: 1.5, atk: 0.001, tau: 0.006, amp: 1.2 });
  kVoice(d, sr, R, k === 5 ? 0.015 : 0, L, { f0: [[0, 160 * p], [L * 0.3, 150 * p], [L, 95 * p]],
    v: [[0, V2[0]], [L, V2[1]]], amp: [[0, 0], [0.012, 1], [L * 0.6, 0.8], [L, 0]],
    asp: [[0, 0.3], [0.02, 0.05], [L, k === 2 ? 0.4 : 0.05]], press: 0.95, growl: 0.2 + R() * 0.15, jit: 0.03, tract: 0.95 + R() * 0.06 });
  kSat(d, 1.8);
});

// Death: the long falling AAARGH, the gargle, and a body finding the floor.
bakeLo('wr_die', 1.3, 2, (d, sr, R, k) => {
  const p = 1 + (R() - 0.5) * 0.08;
  if (k === 2) {        // NNNOOOOoooo
    kVoice(d, sr, R, 0, 1.0, { f0: [[0, 170 * p], [0.12, 210 * p], [0.6, 180 * p], [1.0, 95 * p]],
      v: [[0, 'mm'], [0.1, 'mm'], [0.2, 'ow'], [0.7, 'ow'], [0.95, 'uw']], amp: [[0, 0], [0.04, 0.7], [0.2, 1], [0.8, 0.8], [1.0, 0]],
      press: 0.75, growl: 0.12, jit: 0.025, tract: 0.97 });
  } else {
    kVoice(d, sr, R, 0, 0.95, { f0: [[0, 195 * p], [0.1, 215 * p], [0.5, 150 * p], [0.95, 70 * p]],
      v: [[0, 'a'], [0.45, 'a'], [0.75, 'er']], amp: [[0, 0], [0.02, 1], [0.6, 0.85], [0.95, 0]],
      press: 0.95, growl: 0.15, jit: 0.03, tract: 0.95 });
    kShape(d, sr, 0.55, 0.95, (u) => 1 - 0.5 * u * (0.5 + 0.5 * Math.sin(u * 60)));
  }
  kGurgle(d, sr, R, 0.8, 0.35, 0.12);
  kSat(d, 1.5);
  kThump(d, sr, 1.08, 120, 55, 0.02, 0.06, 0.25, 2);
  kNoise(d, sr, R, 1.08, 0.18, { type: 'lp', f0: 1200, f1: 250, q: 1, atk: 0.002, tau: 0.04, amp: 0.9, col: 1 });
});

// The Sparker: jittery, electrical, and delighted about it.
bake('sp_alert', 0.6, 2, (d, sr, R, k) => {
  const p = 1 + (R() - 0.5) * 0.08;
  kCrackle(d, sr, R, 0, 0.12, 2400, 0.8, 0.5);
  if (k === 0) {        // heh-heh-HEH
    for (let s = 0; s < 3; s++) {
      const a = 0.08 + s * 0.13;
      kVoice(d, sr, R, a, 0.11, { f0: [[0, (225 + s * 30) * p], [0.11, (200 + s * 30) * p]], v: [[0, 'eh']],
        amp: [[0, 0], [0.03, 0], [0.04, 1], [0.1, 0]], asp: [[0, 0.7], [0.035, 0.1]], press: 0.8, tract: 1.1 });
    }
  } else {              // YAAH!
    kVoice(d, sr, R, 0.08, 0.4, { f0: [[0, 230 * p], [0.1, 310 * p], [0.4, 220 * p]],
      v: [[0, 'iy'], [0.08, 'a'], [0.4, 'a']], amp: [[0, 0], [0.03, 1], [0.3, 0.9], [0.4, 0]], press: 0.95, tract: 1.1, jit: 0.03 });
  }
  kRing(d, sr, 0.08, 0.6, 95, 0.35);
  kCrush(d, sr, 0.08, 0.6, 3);
  kSat(d, 1.7);
});

bake('sp_pain', 0.3, 3, (d, sr, R) => {
  const p = 1 + (R() - 0.5) * 0.15;
  kVoice(d, sr, R, 0.01, 0.2, { f0: [[0, 280 * p], [0.05, 340 * p], [0.2, 250 * p]], v: [[0, 'ae'], [0.2, 'iy']],
    amp: [[0, 0], [0.01, 1], [0.15, 0.8], [0.2, 0]], press: 1, tract: 1.12, jit: 0.035 });
  kRing(d, sr, 0, 0.3, 110, 0.3);
  kCrackle(d, sr, R, 0, 0.25, 1800, 0.7, 1.4);
  kSat(d, 1.8);
});

// Shorted out: a scream falling through the floor, a fizzle and a pop.
bakeLo('sp_die', 1.2, 1, (d, sr, R) => {
  const p = 1 + (R() - 0.5) * 0.08;
  kVoice(d, sr, R, 0, 0.8, { f0: [[0, 330 * p], [0.1, 360 * p], [0.8, 80 * p]], v: [[0, 'iy'], [0.4, 'eh'], [0.8, 'uh']],
    amp: [[0, 0], [0.02, 1], [0.6, 0.8], [0.8, 0]], press: 1, tract: 1.1, jit: 0.04 });
  kRing(d, sr, 0, 0.8, 70, 0.4);
  kCrush(d, sr, 0.3, 0.8, 5);
  kCrackle(d, sr, R, 0.05, 1.0, 3000, 0.9, 0.7);
  kClick(d, sr, 0.95, 1.2, 6);
  kNoise(d, sr, R, 0.95, 0.2, { type: 'hp', f0: 2500, q: 0.7, atk: 0.001, tau: 0.04, amp: 1.5 });
  kSat(d, 1.6);
});

// The zap itself: a sputtering arc and the crack of it landing.
bake('arc', 0.4, 3, (d, sr, R) => {
  kClick(d, sr, 0, 1, 2);
  kNoise(d, sr, R, 0, 0.35, { type: 'bp', f0: 3200, f1: 1800, q: 1.2, atk: 0.001, tau: 0.08, amp: 2.2, grain: 0.55 });
  kCrackle(d, sr, R, 0, 0.35, 3500, 0.9, 1.2);
  let f = 900 + R() * 600;
  for (let s = 0; s < 7; s++) {
    kTone(d, sr, s * 0.035, 0.04, f, f * (0.8 + R() * 0.5), 0.25, 0.001, 0.02, 2);
    f = 700 + R() * 2800;
  }
  kSat(d, 2);
});

// The Bellows: a big man with a gas tank and a pilot light.
bakeLo('flame', 1.5, 1, (d, sr, R) => {
  kClick(d, sr, 0, 0.6, 5);
  kNoise(d, sr, R, 0, 0.12, { type: 'bp', f0: 300, f1: 2400, q: 1.2, atk: 0.002, tau: 0.04, amp: 2.4 });
  kThump(d, sr, 0.01, 110, 45, 0.03, 0.1, 0.6, 2.2);
  kNoise(d, sr, R, 0.03, 1.45, { type: 'lp', f0: 900, f1: 1400, q: 1.4, atk: 0.12, hold: 0.85, tau: 0.15, amp: 6, col: 1, am: [8.5, 0.35] });
  kNoise(d, sr, R, 0.05, 1.4, { type: 'bp', f0: 2400, f1: 3200, q: 0.8, atk: 0.2, hold: 0.7, tau: 0.15, amp: 1, grain: 0.8 });
  kCrackle(d, sr, R, 0.05, 1.35, 500, 0.6, 0.4);
  kSat(d, 1.8);
});

bakeLo('bl_pain', 0.4, 1, (d, sr, R) => {
  kVoice(d, sr, R, 0, 0.3, { f0: [[0, 95], [0.3, 70]], v: [[0, 'uw'], [0.3, 'uh']], amp: [[0, 0], [0.02, 1], [0.22, 0.6], [0.3, 0]],
    asp: [[0, 0.4], [0.3, 0.6]], press: 0.8, growl: 0.35, tract: 0.84, bw: 1.4 });
  kMode(d, sr, 0.005, 420 * (1 + R() * 0.1), 0.12, 0.25);
  kMode(d, sr, 0.005, 1130, 0.07, 0.14);
  kSat(d, 1.6);
});

// Death by deflation: a long wheeze, then the tank lets go like the world's
// largest whoopee cushion. The explosion is a separate sound; this is the joke
// that plays just before it.
bakeLo('bl_die', 1.5, 1, (d, sr, R) => {
  kVoice(d, sr, R, 0, 0.6, { f0: [[0, 110], [0.6, 60]], v: [[0, 'aw'], [0.6, 'uh']], amp: [[0, 0], [0.03, 1], [0.4, 0.7], [0.6, 0]],
    asp: [[0, 0.5], [0.6, 0.9]], press: 0.6, growl: 0.4, tract: 0.84, bw: 1.5 });
  kTone(d, sr, 0.55, 0.9, 75, 240, 0.55, 0.03, 0, 1, [4, 0.08]);
  kShape(d, sr, 0.55, 1.45, (u) => (0.55 + 0.45 * Math.sin(u * TWO_PI * 26 * (1 + u))) * (u < 0.85 ? 1 : (1 - u) / 0.15));
  kNoise(d, sr, R, 0.55, 0.9, { type: 'bp', f0: 1200, f1: 3800, q: 1, atk: 0.05, hold: 0.6, tau: 0.08, amp: 0.8 });
  kSat(d, 2);
});

// The Wasp: a drone with a grudge.
bakeLo('wasp', 0.9, 1, (d, sr, R) => {
  const f = 170 + R() * 30;
  kTone(d, sr, 0, 0.9, f, f * 1.18, 0.5, 0.05, 0, 1, [31, 0.04]);
  kTone(d, sr, 0, 0.9, f * 1.012, f * 1.2, 0.35, 0.06, 0, 2, [23, 0.03]);
  kShape(d, sr, 0, 0.9, (u) => (0.7 + 0.3 * Math.sin(u * TWO_PI * 28)) * (u > 0.8 ? (1 - u) * 5 : 1));
  kNoise(d, sr, R, 0, 0.9, { type: 'bp', f0: 2600, q: 2, atk: 0.05, hold: 0.7, tau: 0.05, amp: 0.4, am: [62, 0.6] });
  kSat(d, 2);
});

bake('wasp_pain', 0.3, 1, (d, sr, R) => {
  const f = 220 + R() * 40;
  kTone(d, sr, 0, 0.28, f * 1.6, f, 0.6, 0.003, 0.1, 2, [45, 0.05]);
  kShape(d, sr, 0, 0.28, (u) => (Math.sin(u * TWO_PI * 9) > -0.2 ? 1 : 0.1));
  kClick(d, sr, 0, 0.7, 2);
  kMode(d, sr, 0, 2400, 0.03, 0.3);
});

// Spiralling in: the drone pitch-dives, wobbling, and the chassis hits the deck.
bakeLo('wasp_die', 1.3, 1, (d, sr, R) => {
  const f = 200 + R() * 30;
  kTone(d, sr, 0, 0.95, f * 1.2, f * 0.2, 0.55, 0.004, 0, 1, [5.5, 0.12]);
  kTone(d, sr, 0, 0.95, f * 1.22, f * 0.21, 0.35, 0.004, 0, 2, [6.1, 0.1]);
  kShape(d, sr, 0, 0.95, (u) => 1 - 0.8 * Math.pow(u, 3));
  kCrackle(d, sr, R, 0, 0.9, 900, 0.4, 0.5);
  kThump(d, sr, 0.95, 160, 70, 0.02, 0.06, 0.8, 2.5);
  kDebris(d, sr, R, 0.95, 0.3, 14, 1400, 6500, 0.25, 0.008);
  kNoise(d, sr, R, 0.95, 0.15, { type: 'lp', f0: 3000, f1: 400, q: 1, atk: 0.001, tau: 0.035, amp: 2, col: 1 });
});

// The Priest: a cult of the reactor, and the reactor has a choir.
bakeLo('chant', 1.9, 1, (d, sr, R, k) => {
  const f = k ? 98 : 110;
  const V1 = [[0, 'ow'], [0.9, 'ow'], [1.3, 'mm']];
  kVoice(d, sr, R, 0, 1.8, { f0: [[0, f * 0.98], [0.15, f], [1.2, f], [1.8, f * 0.97]], v: V1,
    amp: [[0, 0], [0.25, 1], [1.4, 0.9], [1.8, 0]], press: 0.35, jit: 0.006, shim: 0.04, tract: 0.95 });
  kVoice(d, sr, R, 0.03, 1.75, { f0: [[0, f * 1.5], [1.75, f * 1.49]], v: V1,
    amp: [[0, 0], [0.3, 0.6], [1.4, 0.55], [1.75, 0]], press: 0.3, jit: 0.006, shim: 0.04, tract: 1.05 });
  kVoice(d, sr, R, 0.05, 1.7, { f0: [[0, f * 0.5], [1.7, f * 0.5]], v: V1,
    amp: [[0, 0], [0.35, 0.7], [1.4, 0.6], [1.7, 0]], press: 0.4, growl: 0.3, jit: 0.006, tract: 0.85 });
  kShape(d, sr, 0.2, 1.8, (u) => 1 + 0.12 * Math.sin(u * TWO_PI * 8));
});

bakeLo('pr_pain', 0.35, 1, (d, sr, R) => {
  const p = 1 + (R() - 0.5) * 0.08;
  kVoice(d, sr, R, 0, 0.3, { f0: [[0, 330 * p], [0.07, 390 * p], [0.3, 300 * p]], v: [[0, 'a']],
    amp: [[0, 0], [0.015, 1], [0.2, 0.7], [0.3, 0]], press: 0.8, jit: 0.02, tract: 1.05 });
  kSat(d, 1.4);
});

// AAAAA-MEN. Sung, falling, and very sure of itself right to the end.
bakeLo('pr_die', 1.5, 1, (d, sr, R) => {
  kVoice(d, sr, R, 0, 1.4, { f0: [[0, 262], [0.5, 247], [0.75, 196], [1.1, 131], [1.4, 110]],
    v: [[0, 'a'], [0.65, 'a'], [0.8, 'mm'], [0.9, 'eh'], [1.2, 'eh'], [1.3, 'mm']],
    amp: [[0, 0], [0.05, 1], [0.7, 0.9], [0.8, 0.5], [0.9, 0.9], [1.4, 0]], press: 0.5, jit: 0.01, shim: 0.05, tract: 1.02 });
  kShape(d, sr, 0.1, 1.4, (u) => 1 + 0.15 * Math.sin(u * TWO_PI * 7));
  kThump(d, sr, 1.35, 110, 50, 0.02, 0.05, 0.3, 2);
});

// MUTTER. A reactor that learned to talk from the PA system, at the size of a
// silo. The throat is enormous and the whole of it goes through a crusher.
bakeLo('mutter_roar', 2.4, 1, (d, sr, R) => {
  kVoice(d, sr, R, 0, 2.3, { f0: [[0, 48], [0.4, 62], [1.6, 55], [2.3, 36]], v: [[0, 'a'], [1.2, 'aw'], [2.0, 'uh']],
    amp: [[0, 0], [0.25, 1], [1.7, 0.9], [2.3, 0]], asp: [[0, 0.2], [2.3, 0.4]], press: 1, growl: 0.55, jit: 0.04, tract: 0.6, bw: 1.3 });
  kTone(d, sr, 0.1, 2.1, 1200, 780, 0.05, 0.3, 0, 1, [4, 0.03]);
  kSat(d, 3);
  kCrush(d, sr, 0, 2.4, 4);
  kThump(d, sr, 0, 55, 30, 0.2, 0.9, 1.2, 1.5, 0.2);
});

bakeLo('mutter_hurt', 0.8, 1, (d, sr, R) => {
  for (let m = 0; m < 5; m++) kMode(d, sr, 0.002, 380 * METAL[m] * (1 + R() * 0.03), 0.22 / (1 + m * 0.4), 0.3 / (1 + m * 0.5));
  kClick(d, sr, 0, 0.8, 5);
  kVoice(d, sr, R, 0.03, 0.55, { f0: [[0, 75], [0.1, 90], [0.55, 55]], v: [[0, 'uh'], [0.55, 'er']],
    amp: [[0, 0], [0.03, 1], [0.4, 0.8], [0.55, 0]], press: 1, growl: 0.5, tract: 0.62 });
  kSat(d, 2.2);
});

Object.assign(SFX, {

  // The Sparker shares this one in entities.js; sparker_alert is its own.
  wrencher_alert(S, t, o) {
    const v = V(S, o, 6, 0.45, 0.1); if (!v) return;
    smp(S, v, t, 'wr_alert', { g: 0.8, rate: jr(S, o, 0.04) });
  },

  wrencher_pain(S, t, o) {
    const v = V(S, o, 5, 0.4, 0.1); if (!v) return;
    smp(S, v, t, 'grunt', { g: 0.8, rate: jr(S, o, 0.06), k: (S._r() * 3) | 0 });
  },

  wrencher_die(S, t, o) {
    const v = V(S, o, 6, 0.45, 0.15); if (!v) return;
    smp(S, v, t, 'wr_die', { g: 0.85, rate: jr(S, o, 0.05) });
  },

  // A wrench the size of a leg, through the air.
  wrencher_swing(S, t, o) {
    const v = V(S, o, 4, 0.35, 0); if (!v) return;
    smp(S, v, t, 'swish', { g: 0.7, rate: jr(S, o, 0.08) * 0.8 });
    smp(S, v, t + 0.02, 'grunt', { g: 0.3, rate: 1.1, k: 0 });
  },

  sparker_alert(S, t, o) {
    const v = V(S, o, 6, 0.4, 0.1); if (!v) return;
    smp(S, v, t, 'sp_alert', { g: 0.75, rate: jr(S, o, 0.05) });
  },

  sparker_pain(S, t, o) {
    const v = V(S, o, 5, 0.35, 0.1); if (!v) return;
    smp(S, v, t, 'sp_pain', { g: 0.7, rate: jr(S, o, 0.08) });
  },

  sparker_die(S, t, o) {
    const v = V(S, o, 6, 0.4, 0.15); if (!v) return;
    smp(S, v, t, 'sp_die', { g: 0.8, rate: jr(S, o, 0.05) });
  },

  sparker_fire(S, t, o) {
    const v = V(S, o, 5, 0.3, 0.15); if (!v) return;
    smp(S, v, t, 'arc', { g: 0.7, rate: jr(S, o, 0.1) });
  },

  // The Bellows' alert and his attack are the same sound: he says hello with fire.
  bellows_flame(S, t, o) {
    const v = V(S, o, 6, 0.3, 0.3); if (!v) return;
    const r = jr(S, o, 0.05);
    smp(S, v, t, 'flame', { g: 0.85, rate: r });
    S._tone(v, t + 0.05, 1.4, { type: 'sine', f: 55 * r, f2: 48 * r, sweep: 0.8, g: 0.3, atk: 0.12, hold: 0.8, rel: 0.4 });
  },

  bellows_pain(S, t, o) {
    const v = V(S, o, 5, 0.4, 0.1); if (!v) return;
    smp(S, v, t, 'bl_pain', { g: 0.8, rate: jr(S, o, 0.06) });
  },

  bellows_die(S, t, o) {
    const v = V(S, o, 6, 0.4, 0.2); if (!v) return;
    smp(S, v, t, 'bl_die', { g: 0.8, rate: jr(S, o, 0.04) });
  },

  wasp_buzz(S, t, o) {
    const v = V(S, o, 4, 0.25, 0.1); if (!v) return;
    smp(S, v, t, 'wasp', { g: 0.55, rate: jr(S, o, 0.08) });
  },

  wasp_pain(S, t, o) {
    const v = V(S, o, 4, 0.25, 0.1); if (!v) return;
    smp(S, v, t, 'wasp_pain', { g: 0.55, rate: jr(S, o, 0.1) });
  },

  wasp_die(S, t, o) {
    const v = V(S, o, 6, 0.3, 0.2); if (!v) return;
    smp(S, v, t, 'wasp_die', { g: 0.7, rate: jr(S, o, 0.06) });
  },

  priest_chant(S, t, o) {
    const v = V(S, o, 6, 0.4, 0.6); if (!v) return;
    smp(S, v, t, 'chant', { g: 0.7, rate: jr(S, o, 0.02) });
    S._tone(v, t, 1.8, { type: 'sine', f: 49 * o.rate, g: 0.18, atk: 0.4, hold: 0.9, rel: 0.5 });
  },

  priest_pain(S, t, o) {
    const v = V(S, o, 5, 0.4, 0.2); if (!v) return;
    smp(S, v, t, 'pr_pain', { g: 0.7, rate: jr(S, o, 0.06) });
  },

  priest_die(S, t, o) {
    const v = V(S, o, 6, 0.45, 0.4); if (!v) return;
    smp(S, v, t, 'pr_die', { g: 0.75, rate: o.rate });
  },

  // Everyone's pain, at random: every human in the game draws from one pool.
  enemy_pain(S, t, o) {
    const v = V(S, o, 5, 0.4, 0.1); if (!v) return;
    const u = S._r();
    if (u < 0.72) smp(S, v, t, 'grunt', { g: 0.8, rate: jr(S, o, 0.08) });
    else if (u < 0.86) smp(S, v, t, 'sp_pain', { g: 0.7, rate: jr(S, o, 0.08) });
    else smp(S, v, t, 'bl_pain', { g: 0.8, rate: jr(S, o, 0.08) });
    smp(S, v, t, 'thwack', { g: 0.25, rate: jr(S, o, 0.2) });
  },

  enemy_die(S, t, o) {
    const v = V(S, o, 6, 0.45, 0.15); if (!v) return;
    smp(S, v, t, S._r() < 0.8 ? 'wr_die' : 'sp_die', { g: 0.85, rate: jr(S, o, 0.06) });
  },

  boss_roar(S, t, o) {
    const v = V(S, o, 9, 0.3, 0.75); if (!v) return;
    const r = o.rate;
    smp(S, v, t, 'mutter_roar', { g: 1.0, rate: r });
    S._tone(v, t, 2.3, { type: 'sine', f: 31 * r, f2: 24 * r, sweep: 0.8, g: 0.55, atk: 0.25, hold: 1.2, rel: 0.7 });
    // servos grinding inside the silo wall
    const sv = S._nz(v, t + 0.1, 2.1, { type: 'bandpass', f: 900, f2: 1500, q: 6, g: 0.18, atk: 0.3, hold: 1.2, rel: 0.5 });
    gate(S, v, sv, S._grindCurve, t + 0.1, 2.05);
  },

  boss_hurt(S, t, o) {
    const v = V(S, o, 7, 0.35, 0.4); if (!v) return;
    smp(S, v, t, 'mutter_hurt', { g: 0.9, rate: jr(S, o, 0.05) });
  },

  // It comes apart in stages: the scream, the structure, the reactor.
  boss_death(S, t, o) {
    const v = V(S, o, 11, 0.3, 0.95); if (!v) return;
    smp(S, v, t, 'mutter_roar', { g: 1.0, rate: 0.82 });
    smp(S, v, t + 0.6, 'sp_die', { g: 0.5, rate: 0.5 });
    smp(S, v, t + 1.3, 'barrel', { g: 0.9, rate: 0.8 });
    smp(S, v, t + 1.9, 'nuke', { g: 1.1, rate: 0.9 });
    S._tone(v, t + 1.9, 2.6, { type: 'sine', f: 70, f2: 16, sweep: 0.8, g: 0.8, atk: 0.01, dec: 2.4 });
    const roar = S._nz(v, t + 2.0, 3.4, { type: 'lowpass', f: 520, f2: 80, q: 1, g: 0.6, atk: 0.2, dec: 3.1, pink: true });
    gate(S, v, roar, S._crackleCurve, t + 2.0, 3.3);
  },
});

// A heavy thing swung hard: the air it moves, band-passed and swept.
bake('swish', 0.36, 3, (d, sr, R) => {
  const up = 700 + R() * 400;
  kNoise(d, sr, R, 0, 0.32, { type: 'bp', f0: up * 0.5, f1: up * 2.6, sw: 0.18, q: 1.8, atk: 0.13, tau: 0.05, amp: 2.5, col: 1 });
  kNoise(d, sr, R, 0.02, 0.28, { type: 'bp', f0: up * 1.4, f1: up * 4, sw: 0.18, q: 3, atk: 0.12, tau: 0.04, amp: 0.8 });
});

/* ------------------------------------------------- sky / Missile Command */

// Ignition, and a rocket climbing away until it is only a rumble.
bakeLo('launch', 1.7, 1, (d, sr, R) => {
  kThump(d, sr, 0, 90, 40, 0.04, 0.15, 0.8, 2.5, 0.01);
  kNoise(d, sr, R, 0, 0.12, { type: 'bp', f0: 600, f1: 2400, q: 1, atk: 0.003, tau: 0.04, amp: 2.5 });
  kNoise(d, sr, R, 0.02, 1.65, { type: 'lp', f0: 2600, f1: 380, sw: 1.5, q: 1.1, atk: 0.12, hold: 0.25, tau: 0.45, amp: 6, col: 1, am: [23, 0.35] });
  kCrackle(d, sr, R, 0.05, 1.3, 400, 0.4, 1.5);
  kSat(d, 1.6);
});

// The scream. A falling-bomb whistle that drops in pitch as it closes, two
// voices beating against each other and a jet roar underneath. It is aimed at
// something you like.
bakeLo('scream', 2.0, 1, (d, sr, R) => {
  const f = 2100 + R() * 400;
  kTone(d, sr, 0, 1.95, f, f * 0.34, 0.5, 1.45, 0, 0, [6.5, 0.012]);
  kTone(d, sr, 0, 1.95, f * 1.012, f * 0.346, 0.35, 1.5, 0, 0, [5.2, 0.01]);
  kTone(d, sr, 0, 1.95, f * 2, f * 0.68, 0.08, 1.5, 0, 0);
  kNoise(d, sr, R, 0, 1.95, { type: 'bp', f0: 700, f1: 1800, q: 0.9, atk: 1.6, tau: 0.3, amp: 2.2, col: 1, am: [31, 0.3] });
  kShape(d, sr, 1.85, 2.0, (u) => 1 - u);
});

// A carrier coming apart into three: pop, then three whistles fanning out.
bake('mirv', 1.1, 1, (d, sr, R) => {
  kClick(d, sr, 0, 0.9, 3);
  kNoise(d, sr, R, 0, 0.08, { type: 'bp', f0: 2200, f1: 900, q: 1.3, atk: 0.001, tau: 0.02, amp: 3 });
  kThump(d, sr, 0, 180, 80, 0.02, 0.05, 0.5, 2);
  for (let i = 0; i < 3; i++) {
    const f = 900 + i * 260;
    kTone(d, sr, 0.04 + i * 0.03, 0.95, f, f * (1.7 + i * 0.25), 0.25, 0.02, 0.35, 0, [7 + i, 0.01]);
  }
});

// Attitude jets: two sharp puffs and the guidance chip chirping about it.
bake('evade', 0.4, 1, (d, sr, R) => {
  kNoise(d, sr, R, 0, 0.1, { type: 'bp', f0: 3000, f1: 1400, q: 1.2, atk: 0.002, tau: 0.03, amp: 2.5 });
  kNoise(d, sr, R, 0.11, 0.1, { type: 'bp', f0: 2600, f1: 1200, q: 1.2, atk: 0.002, tau: 0.03, amp: 2 });
  kTone(d, sr, 0, 0.08, 900, 1700, 0.35, 0.002, 0, 2);
  kTone(d, sr, 0.08, 0.1, 1700, 1000, 0.3, 0.002, 0, 2);
});

Object.assign(SFX, {

  warhead_launch(S, t, o) {
    const v = V(S, o, 6, 0.1, 0.8); if (!v) return;
    smp(S, v, t, 'launch', { g: 0.8, rate: jr(S, o, 0.08) });
  },

  warhead_incoming(S, t, o) {
    const v = V(S, o, 8, 0.12, 0.5); if (!v) return;
    smp(S, v, t, 'scream', { g: 0.6, rate: jr(S, o, 0.06) });
  },

  mirv_split(S, t, o) {
    const v = V(S, o, 6, 0.15, 0.6); if (!v) return;
    smp(S, v, t, 'mirv', { g: 0.7, rate: jr(S, o, 0.05) });
  },

  smart_evade(S, t, o) {
    const v = V(S, o, 5, 0.15, 0.4); if (!v) return;
    smp(S, v, t, 'evade', { g: 0.6, rate: jr(S, o, 0.06) });
  },

  // A city dies, a long way off: the nuke again, slowed and darkened by the
  // miles, a sub that takes its time, and a roar that keeps crackling long
  // after you want it to.
  city_hit(S, t, o) {
    const v = V(S, o, 12, 0.2, 1); if (!v) return;
    smp(S, v, t, 'nuke', { g: 1.1, rate: 0.72, lp: 1400 });
    S._tone(v, t, 2.4, { type: 'sine', f: 50, f2: 14, sweep: 0.6, g: 1.0, atk: 0.01, dec: 2.2 });
    const roar = S._nz(v, t + 0.12, 3.6, {
      type: 'bandpass', f: 720, f2: 260, q: 1.2, g: 0.6, atk: 0.2, hold: 1.6, rel: 1.6, pink: true,
    });
    gate(S, v, roar, S._crackleCurve, t + 0.12, 3.5);
    // something structural giving way
    S._tone(v, t + 0.3, 2.4, { type: 'sawtooth', f: 96, f2: 24, sweep: 0.95, g: 0.2, atk: 0.15, hold: 0.7, rel: 1.4 });
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

  // The siren winds up, and the wave starts on a hit you feel in the chest.
  wave_start(S, t, o) {
    const v = V(S, o, 8, 0.25, 0.6); if (!v) return;
    S._nz(v, t, 1.5, { type: 'bandpass', f: 200, f2: 5200, q: 2.6, g: 0.24, atk: 1.3, dec: 0.2 });
    S._tone(v, t, 1.6, { type: 'sawtooth', f: 55, f2: 73.4, sweep: 0.95, g: 0.26, atk: 1.2, hold: 0.1, rel: 0.3 });
    smp(S, v, t + 0.2, 'klaxon', { g: 0.3 });
    smp(S, v, t + 1.45, 'slam', { g: 0.8, rate: 0.8 });
    S._tone(v, t + 1.45, 0.7, { type: 'sine', f: 73.4, f2: 36.7, sweep: 0.5, g: 0.6, dec: 0.6 });
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
    smp(S, v, t + 0.34, 'riff', { g: 0.35 });
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
    smp(S, v, t, 'coins', { g: 0.3, rate: 1.2 });
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
  if (lvl < 3) return;
  const v = V(S, o, 6 + lvl, 0.2, 0.5); if (!v) return;
  // from chain3 up, the kit joins in: a kick under the bells
  S._tone(v, t, 0.5, { type: 'sine', f: mtof(base - 24), f2: mtof(base - 31), sweep: 0.4, g: 0.5, dec: 0.45 });
  if (lvl < 4) return;
  smp(S, v, t, 'burst_s', { g: 0.35, rate: 1.3, k: 0 });
  if (lvl < 5) return;
  // chain5: the whole rig leans in
  smp(S, v, t + 0.02, 'riff', { g: 0.5, rate: mtof(base - 12) / 293.66 });
  S.superSaw(t + 0.02, mtof(base - 12), 1.5, {
    n: 4, detune: 19, cutoff: 5200, co0: 0.35, open: 0.25, g: 0.3,
    atk: 0.015, rel: 0.9, revB: 0.4, pri: 10, pool: 0, vol: o.vol,
  });
  for (let i = 1; i < 4; i++) {
    S.pluck(t + 0.25 + i * 0.07, mtof(N[i] + 12), 0.5, {
      type: 'sawtooth', g: 0.15, cutoff: 6500, q: 3, revB: 0.45, pri: 9, vol: o.vol,
    });
  }
}

/* ------------------------------------------------------------ UI / player */

// Boots on a bunker floor. Heel, roll, toe, and a little grit, never the same
// twice. Variants 0-3 are the left foot and 4-7 the right, a shade heavier.
bake('step', 0.24, 8, (d, sr, R, k) => {
  const j = (k < 4 ? 1.06 : 0.94) * (1 + (R() - 0.5) * 0.12);
  kThump(d, sr, 0, 120 * j, 62 * j, 0.012, 0.028, 1, 2, 0.001);
  kNoise(d, sr, R, 0, 0.07, { type: 'lp', f0: 1500 * j, f1: 380, q: 1.1, atk: 0.001, tau: 0.018, amp: 3.2, col: 1 });
  kNoise(d, sr, R, 0.002, 0.06, { type: 'bp', f0: 2600 * j, q: 1.5, atk: 0.002, tau: 0.012, amp: 1.2 * R() });
  const toe = 0.045 + R() * 0.03;
  kThump(d, sr, toe, 150 * j, 90 * j, 0.01, 0.018, 0.35, 1.5, 0.001);
  kNoise(d, sr, R, toe, 0.05, { type: 'bp', f0: 1900 * j, f1: 900, q: 1.3, atk: 0.001, tau: 0.01, amp: 1.4 });
  kDebris(d, sr, R, 0.005, 0.1, 2 + ((R() * 4) | 0), 3000, 8000, 0.06, 0.003);
});

// Brick getting hit. Lower and bigger than anything he is shooting at.
bakeLo('brick_hurt', 0.34, 5, (d, sr, R, k) => {
  const p = [1, 0.92, 1.08, 0.96, 1.15][k];
  const VV = [['uh', 'uh'], ['aw', 'uh'], ['a', 'er'], ['uw', 'uh'], ['eh', 'uh']][k];
  const L = 0.2 + R() * 0.1;
  kVoice(d, sr, R, 0.01, L, { f0: [[0, 118 * p], [0.05, 125 * p], [L, 82 * p]], v: [[0, VV[0]], [L, VV[1]]],
    amp: [[0, 0], [0.012, 1], [L * 0.6, 0.8], [L, 0]], asp: [[0, 0.35], [0.03, 0.05], [L, 0.2]],
    press: 0.95, growl: 0.25, jit: 0.025, tract: 0.9 });
  kSat(d, 1.7);
  kThump(d, sr, 0, 130, 55, 0.015, 0.05, 0.6, 2.5);
  kNoise(d, sr, R, 0, 0.1, { type: 'lp', f0: 1400, f1: 300, q: 1, atk: 0.001, tau: 0.03, amp: 2, col: 1 });
});

// Brick, down. A proper action-hero AAARGH, the floor, and the last beats.
bakeLo('brick_die', 2.8, 1, (d, sr, R) => {
  kVoice(d, sr, R, 0, 1.3, { f0: [[0, 140], [0.12, 165], [0.7, 130], [1.3, 60]], v: [[0, 'a'], [0.7, 'a'], [1.1, 'er']],
    amp: [[0, 0], [0.03, 1], [0.9, 0.85], [1.3, 0]], press: 1, growl: 0.25, jit: 0.03, tract: 0.9 });
  kSat(d, 1.8);
  kThump(d, sr, 1.25, 95, 38, 0.03, 0.14, 1.1, 3);
  kNoise(d, sr, R, 1.25, 0.3, { type: 'lp', f0: 1800, f1: 200, q: 1, atk: 0.002, tau: 0.06, amp: 4, col: 1 });
  kDebris(d, sr, R, 1.27, 0.25, 6, 1500, 4500, 0.12, 0.01);
  for (let b = 0; b < 2; b++) {
    const tt = 1.75 + b * 0.62, a = 0.55 - b * 0.2;
    kThump(d, sr, tt, 62, 36, 0.03, 0.08, a, 1.5, 0.006);
    kThump(d, sr, tt + 0.2, 55, 32, 0.03, 0.09, a * 0.7, 1.5, 0.008);
  }
});

Object.assign(SFX, {

  ui_move(S, t, o) {
    const v = V(S, o, 2, 0.08, 0); if (!v) return;
    S._tone(v, t, 0.05, { type: 'triangle', f: 1175 * o.rate, g: 0.14, atk: 0.001, dec: 0.045 });
    smp(S, v, t, 'tick', { g: 0.35, rate: 1.3 * o.rate });
  },

  ui_select(S, t, o) {
    const v = V(S, o, 3, 0.15, 0); if (!v) return;
    smp(S, v, t, 'tick', { g: 0.4, rate: 0.8 * o.rate });
    S._tone(v, t, 0.06, { type: 'square', f: 587 * o.rate, g: 0.12, atk: 0.001, dec: 0.055 });
    S._tone(v, t + 0.05, 0.16, { type: 'square', f: 880 * o.rate, g: 0.12, atk: 0.001, dec: 0.15 });
  },

  ui_back(S, t, o) {
    const v = V(S, o, 3, 0.15, 0); if (!v) return;
    smp(S, v, t, 'tick', { g: 0.4, rate: 0.7 * o.rate });
    S._tone(v, t, 0.06, { type: 'square', f: 587 * o.rate, g: 0.11, atk: 0.001, dec: 0.055 });
    S._tone(v, t + 0.05, 0.16, { type: 'square', f: 392 * o.rate, g: 0.11, atk: 0.001, dec: 0.15 });
  },

  // New game: the riff, a shotgun rack, and a floor-shaking hit. Let's rock.
  ui_start(S, t, o) {
    const v = V(S, o, 8, 0.3, 0.35); if (!v) return;
    smp(S, v, t, 'splitter', { g: 0.55, k: 0 });
    smp(S, v, t + 0.05, 'riff', { g: 0.6 });
    S._tone(v, t + 0.05, 0.9, { type: 'sine', f: mtof(26), f2: mtof(22), sweep: 0.5, g: 0.55, dec: 0.8 });
    S._nz(v, t + 0.05, 1.2, { type: 'highpass', f: 5200, q: 0.7, g: 0.12, atk: 0.003, dec: 1.1 });
  },

  score_tick(S, t, o) {
    const v = V(S, o, 1, 0, 0); if (!v) return;
    S._tone(v, t, 0.022, { type: 'square', f: 1450 * o.rate, g: 0.08, atk: 0.001, dec: 0.02 });
  },

  countdown(S, t, o) {
    const v = V(S, o, 6, 0.3, 0.15); if (!v) return;
    S._tone(v, t, 0.22, { type: 'square', f: 220 * o.rate, g: 0.18, atk: 0.003, hold: 0.1, rel: 0.1 });
    S._tone(v, t, 0.24, { type: 'sine', f: 110 * o.rate, g: 0.3, atk: 0.003, hold: 0.11, rel: 0.11 });
    smp(S, v, t, 'tick', { g: 0.4, rate: 0.6 });
  },

  player_hurt(S, t, o) {
    const v = V(S, o, 8, 0.25, 0); if (!v) return;
    smp(S, v, t, 'brick_hurt', { g: 0.9, rate: jr(S, o, 0.05) });
  },

  player_die(S, t, o) {
    const v = V(S, o, 11, 0.35, 0.5); if (!v) return;
    smp(S, v, t, 'brick_die', { g: 1.0, rate: o.rate });
    S._tone(v, t, 2.8, { type: 'sine', f: 88, f2: 19, sweep: 0.85, g: 0.5, atk: 0.03, dec: 2.6 });
    S._nz(v, t + 0.2, 2.6, { type: 'lowpass', f: 340, f2: 90, q: 1.1, g: 0.25, atk: 0.3, dec: 2.2, pink: true });
  },

  heartbeat(S, t, o) {
    const v = V(S, o, 5, 0.12, 0); if (!v) return;
    const r = o.rate;
    S._tone(v, t, 0.28, { type: 'sine', f: 68 * r, f2: 38 * r, sweep: 0.3, g: 0.75, atk: 0.006, dec: 0.26 });
    S._nz(v, t, 0.1, { type: 'lowpass', f: 260 * r, q: 1.2, g: 0.35, atk: 0.004, dec: 0.08, pink: true });
    S._tone(v, t + 0.235 / r, 0.34, { type: 'sine', f: 60 * r, f2: 33 * r, sweep: 0.3, g: 0.55, atk: 0.01, dec: 0.32 });
  },

  footstep_a(S, t, o) {
    const v = V(S, o, 2, 0.26, 0); if (!v) return;
    smp(S, v, t, 'step', { g: 0.7, rate: o.rate, k: (S._r() * 4) | 0 });
  },

  footstep_b(S, t, o) {
    const v = V(S, o, 2, 0.26, 0); if (!v) return;
    smp(S, v, t, 'step', { g: 0.7, rate: o.rate, k: 4 + ((S._r() * 4) | 0) });
  },
});

/* ------------------------------------------------------------- mutants */
// Nothing in here is a clean tone. The mechanical enemies got oscillators and
// metal; these got throats that were never meant to make these noises, noise
// through resonant peaks, collapsing pitch and granular gates. Wet, in the bad
// way, and every so often funny, in the worse way.

// The Ghoul: a gasp in, then the shriek of something that has just seen lunch.
bakeLo('gh_alert', 1.0, 1, (d, sr, R) => {
  const p = 1 + (R() - 0.5) * 0.1;
  kNoise(d, sr, R, 0, 0.26, { type: 'bp', f0: 380, f1: 1600, q: 3, atk: 0.2, tau: 0.03, amp: 1.6 });
  kVoice(d, sr, R, 0.24, 0.7, { f0: [[0, 520 * p], [0.12, 820 * p], [0.5, 700 * p], [0.7, 480 * p]], v: [[0, 'a'], [0.2, 'ae'], [0.6, 'iy']],
    amp: [[0, 0], [0.02, 1], [0.5, 0.9], [0.7, 0]], asp: [[0, 0.3], [0.7, 0.3]], press: 1, growl: 0.35, jit: 0.05, tract: 1.2 });
  kSat(d, 2.4);
});

bake('gh_bite', 0.3, 3, (d, sr, R) => {
  const j = 1 + (R() - 0.5) * 0.15;
  kVoice(d, sr, R, 0, 0.16, { f0: [[0, 310 * j], [0.16, 260 * j]], v: [[0, 'ae']], amp: [[0, 0], [0.01, 1], [0.16, 0]],
    asp: [[0, 0.5]], press: 1, growl: 0.6, jit: 0.06, tract: 1.15 });
  kClick(d, sr, 0.13, 1, 3);
  kMode(d, sr, 0.13, 1650 * j, 0.012, 0.5);
  kMode(d, sr, 0.13, 2900 * j, 0.008, 0.3);
  kNoise(d, sr, R, 0.13, 0.1, { type: 'lp', f0: 1200, f1: 300, q: 1.3, atk: 0.001, tau: 0.03, amp: 2.5, col: 1 });
  kSat(d, 1.8);
});

bakeLo('gh_pain', 0.3, 1, (d, sr, R) => {
  const p = 1 + (R() - 0.5) * 0.12;
  kVoice(d, sr, R, 0, 0.26, { f0: [[0, 900 * p], [0.05, 1000 * p], [0.26, 560 * p]], v: [[0, 'iy'], [0.26, 'eh']],
    amp: [[0, 0], [0.008, 1], [0.18, 0.7], [0.26, 0]], press: 1, growl: 0.3, jit: 0.05, tract: 1.25 });
  kSat(d, 2);
});

bakeLo('gh_die', 1.5, 1, (d, sr, R) => {
  const p = 1 + (R() - 0.5) * 0.1;
  kVoice(d, sr, R, 0, 0.9, { f0: [[0, 760 * p], [0.1, 820 * p], [0.9, 180 * p]], v: [[0, 'iy'], [0.4, 'a'], [0.9, 'uh']],
    amp: [[0, 0], [0.01, 1], [0.6, 0.7], [0.9, 0]], press: 1, growl: 0.4, jit: 0.07, tract: 1.2 });
  kGurgle(d, sr, R, 0.55, 0.7, 0.3);
  kSat(d, 1.8);
  kThump(d, sr, 1.25, 110, 50, 0.02, 0.06, 0.35, 2);
  kSquish(d, sr, R, 1.25, 0.15, 10, 200, 700, 0.2, 1.4);
});

// The Gorger is mostly stomach, and it announces itself the way a stomach
// would: one long, wet, reverberant belch.
bakeLo('go_alert', 1.7, 1, (d, sr, R) => {
  const p = 1 + (R() - 0.5) * 0.1;
  kVoice(d, sr, R, 0, 1.6, { f0: [[0, 62 * p], [0.3, 84 * p], [0.9, 72 * p], [1.6, 48 * p]], v: [[0, 'uh'], [0.5, 'er'], [1.1, 'aw'], [1.6, 'uh']],
    amp: [[0, 0], [0.08, 1], [1.2, 0.85], [1.6, 0]], asp: [[0, 0.2], [1.6, 0.3]], press: 0.9, growl: 0.7, jit: 0.09, shim: 0.3, tract: 0.72, bw: 1.6 });
  kSquish(d, sr, R, 0.05, 1.5, 40, 120, 520, 0.25, 1);
  kSat(d, 2.2);
});

bakeLo('go_chomp', 0.55, 1, (d, sr, R) => {
  kNoise(d, sr, R, 0, 0.2, { type: 'bp', f0: 260, f1: 900, q: 2, atk: 0.15, tau: 0.03, amp: 1.8, col: 1 });
  kThump(d, sr, 0.19, 120, 50, 0.02, 0.07, 1, 3);
  kClick(d, sr, 0.19, 1, 5);
  kMode(d, sr, 0.19, 780, 0.03, 0.4);
  kNoise(d, sr, R, 0.19, 0.2, { type: 'lp', f0: 1500, f1: 250, q: 1.4, atk: 0.001, tau: 0.05, amp: 3.5, col: 1 });
  kSquish(d, sr, R, 0.2, 0.25, 22, 180, 800, 0.35, 1.5);
});

bakeLo('go_pain', 0.5, 1, (d, sr, R) => {
  kVoice(d, sr, R, 0, 0.36, { f0: [[0, 110], [0.05, 125], [0.36, 70]], v: [[0, 'er'], [0.36, 'uh']], amp: [[0, 0], [0.01, 1], [0.25, 0.7], [0.36, 0]],
    asp: [[0, 0.5], [0.05, 0.2]], press: 1, growl: 0.6, jit: 0.08, tract: 0.75, bw: 1.4 });
  kSquish(d, sr, R, 0.05, 0.35, 14, 150, 600, 0.3, 1.2);
  kSat(d, 2);
});

// The money sound. A pressurised thing at close range, ceasing to be one:
// the skin going like a balloon, a sub thump, a wall of wet, then the rain.
bake('go_pop', 2.2, 1, (d, sr, R) => {
  kClick(d, sr, 0, 1.4, 3);
  kNoise(d, sr, R, 0, 0.04, { type: 'bp', f0: 2400, f1: 900, q: 0.9, atk: 0.0003, tau: 0.008, amp: 6 });
  kThump(d, sr, 0.003, 95, 22, 0.05, 0.3, 1.5, 3.5, 0.003);
  kNoise(d, sr, R, 0.004, 0.9, { type: 'lp', f0: 3500, f1: 180, sw: 0.4, q: 1.4, atk: 0.002, tau: 0.16, amp: 7, col: 1 });
  kSquish(d, sr, R, 0.01, 0.5, 90, 160, 1400, 0.7, 2);
  kSquish(d, sr, R, 0.3, 1.8, 120, 220, 1600, 0.35, 1.3);
  for (let c = 0; c < 9; c++) {
    const tt = 0.35 + Math.pow(R(), 1.3) * 1.6;
    kThump(d, sr, tt, 150 + R() * 80, 70, 0.01, 0.025, 0.25 + R() * 0.25, 2);
    kNoise(d, sr, R, tt, 0.06, { type: 'bp', f0: 1200, f1: 400, q: 1.2, atk: 0.001, tau: 0.015, amp: 1.5 });
  }
  kSat(d, 2.4);
});

// The Howler's scream: two throats climbing at different rates, beating
// against each other. The detune is the whole point.
bakeLo('ho_alert', 1.6, 1, (d, sr, R) => {
  kVoice(d, sr, R, 0, 1.55, { f0: [[0, 330], [0.4, 520], [1.2, 1050], [1.55, 900]], v: [[0, 'uh'], [0.5, 'a'], [1.2, 'ae']],
    amp: [[0, 0], [0.3, 1], [1.2, 1], [1.55, 0]], press: 1, growl: 0.25, jit: 0.03, tract: 1.25 });
  kVoice(d, sr, R, 0.04, 1.5, { f0: [[0, 338], [0.45, 545], [1.2, 1085], [1.5, 930]], v: [[0, 'uh'], [0.5, 'ae'], [1.2, 'iy']],
    amp: [[0, 0], [0.35, 0.7], [1.15, 0.8], [1.5, 0]], press: 1, growl: 0.3, jit: 0.03, tract: 1.3 });
  kSat(d, 2.2);
});

// HOCK. PTOO. Acid is a delivery method, not an excuse for manners.
bake('ho_spit', 0.55, 1, (d, sr, R) => {
  kNoise(d, sr, R, 0, 0.28, { type: 'bp', f0: 900, f1: 2600, q: 2.4, atk: 0.18, tau: 0.03, amp: 2.4, am: [34, 0.5] });
  kVoice(d, sr, R, 0.02, 0.24, { f0: [[0, 180], [0.24, 260]], v: [[0, 'er']], amp: [[0, 0], [0.1, 0.4], [0.24, 0]],
    asp: [[0, 0.6], [0.24, 0.9]], press: 1, growl: 0.7, jit: 0.1, tract: 1.1 });
  kClick(d, sr, 0.3, 1, 4);
  kTone(d, sr, 0.3, 0.05, 350, 1300, 0.7, 0.001, 0.015);
  kNoise(d, sr, R, 0.31, 0.2, { type: 'bp', f0: 2200, f1: 900, q: 1.5, atk: 0.002, tau: 0.05, amp: 2.2 });
  kSquish(d, sr, R, 0.31, 0.15, 8, 500, 1600, 0.3, 1.5);
});

bakeLo('ho_pain', 0.32, 1, (d, sr, R) => {
  const p = 1 + (R() - 0.5) * 0.1;
  kVoice(d, sr, R, 0, 0.28, { f0: [[0, 700 * p], [0.05, 820 * p], [0.28, 480 * p]], v: [[0, 'ae'], [0.28, 'uh']],
    amp: [[0, 0], [0.008, 1], [0.2, 0.7], [0.28, 0]], press: 1, growl: 0.2, jit: 0.04, tract: 1.25 });
  kSat(d, 2);
});

bakeLo('ho_die', 1.6, 1, (d, sr, R) => {
  kVoice(d, sr, R, 0, 1.4, { f0: [[0, 1000], [0.15, 1080], [1.4, 170]], v: [[0, 'ae'], [0.6, 'a'], [1.3, 'uh']],
    amp: [[0, 0], [0.01, 1], [1.0, 0.7], [1.4, 0]], press: 1, growl: 0.35, jit: 0.04, tract: 1.25 });
  kVoice(d, sr, R, 0.02, 1.35, { f0: [[0, 1030], [1.35, 190]], v: [[0, 'iy'], [1.3, 'uh']],
    amp: [[0, 0], [0.02, 0.6], [1.0, 0.4], [1.35, 0]], press: 1, growl: 0.4, jit: 0.04, tract: 1.3 });
  kGurgle(d, sr, R, 1.1, 0.45, 0.25);
  kSat(d, 1.9);
});

// The Stalker: mandibles. Fast dry clicking, a hiss behind it.
bake('chitter', 0.9, 1, (d, sr, R) => {
  let tt = 0;
  while (tt < 0.8) {
    const f = 2600 + R() * 2600, a = 0.3 + R() * 0.5;
    kClick(d, sr, tt, a, 2);
    kMode(d, sr, tt, f, 0.004, a);
    kMode(d, sr, tt, f * 1.7, 0.003, a * 0.5);
    tt += 0.018 + R() * 0.03 + (R() < 0.12 ? 0.06 : 0);
  }
  kNoise(d, sr, R, 0, 0.85, { type: 'bp', f0: 5200, f1: 3800, q: 1.2, atk: 0.1, hold: 0.4, tau: 0.1, amp: 0.8 });
});

bake('st_rend', 0.36, 2, (d, sr, R) => {
  const j = 1 + (R() - 0.5) * 0.15;
  kNoise(d, sr, R, 0, 0.12, { type: 'bp', f0: 1200 * j, f1: 5200 * j, q: 2, atk: 0.06, tau: 0.02, amp: 2.4 });
  kClick(d, sr, 0.07, 0.9, 2);
  kMode(d, sr, 0.07, 3100 * j, 0.006, 0.4);
  kNoise(d, sr, R, 0.075, 0.2, { type: 'bp', f0: 1400, f1: 500, q: 1.2, atk: 0.002, tau: 0.04, amp: 3, col: 1, grain: 0.8 });
  kSquish(d, sr, R, 0.08, 0.15, 8, 300, 1200, 0.25, 1.4);
});

bake('st_pain', 0.25, 1, (d, sr, R) => {
  const p = 1 + (R() - 0.5) * 0.1;
  kVoice(d, sr, R, 0, 0.2, { f0: [[0, 1300 * p], [0.2, 900 * p]], v: [[0, 'iy']], amp: [[0, 0], [0.005, 1], [0.2, 0]],
    press: 1, growl: 0.5, jit: 0.08, tract: 1.45 });
  kClick(d, sr, 0, 0.6, 2);
  kSat(d, 2);
});

bake('st_die', 1.2, 1, (d, sr, R) => {
  kVoice(d, sr, R, 0, 0.5, { f0: [[0, 1400], [0.5, 500]], v: [[0, 'iy'], [0.5, 'eh']], amp: [[0, 0], [0.005, 1], [0.5, 0]],
    press: 1, growl: 0.5, jit: 0.08, tract: 1.45 });
  let tt = 0.3, gap = 0.02;
  while (tt < 1.15) {
    kClick(d, sr, tt, 0.5, 2);
    kMode(d, sr, tt, 2400 + R() * 2000, 0.004, 0.5);
    tt += gap; gap *= 1.18;
  }
  kThump(d, sr, 0.45, 150, 70, 0.02, 0.05, 0.3, 2);
  kSat(d, 1.6);
});

// MAW. Boss scale: seconds long, a throat full of gravel and a crusher on it.
bakeLo('maw_roar', 3.3, 1, (d, sr, R) => {
  kVoice(d, sr, R, 0, 3.2, { f0: [[0, 38], [0.5, 52], [2.0, 46], [3.2, 30]], v: [[0, 'uh'], [0.8, 'a'], [2.2, 'aw'], [3.2, 'uh']],
    amp: [[0, 0], [0.35, 1], [2.3, 0.9], [3.2, 0]], asp: [[0, 0.25], [3.2, 0.4]], press: 1, growl: 0.75, jit: 0.07, shim: 0.3, tract: 0.5, bw: 1.5 });
  kVoice(d, sr, R, 0.05, 3.1, { f0: [[0, 57], [0.5, 78], [2.0, 70], [3.1, 45]], v: [[0, 'uh'], [0.8, 'aw'], [2.2, 'er']],
    amp: [[0, 0], [0.4, 0.5], [2.3, 0.45], [3.1, 0]], press: 1, growl: 0.6, jit: 0.06, tract: 0.6 });
  kGurgle(d, sr, R, 0.5, 2.5, 0.35);
  kSat(d, 3);
  kCrush(d, sr, 0, 3.3, 3);
});

bakeLo('maw_hurt', 0.8, 1, (d, sr, R) => {
  kThump(d, sr, 0, 120, 50, 0.03, 0.1, 0.8, 3);
  kVoice(d, sr, R, 0.01, 0.65, { f0: [[0, 70], [0.08, 90], [0.65, 48]], v: [[0, 'a'], [0.65, 'uh']],
    amp: [[0, 0], [0.02, 1], [0.4, 0.8], [0.65, 0]], press: 1, growl: 0.7, jit: 0.06, tract: 0.55, bw: 1.4 });
  kSquish(d, sr, R, 0.02, 0.4, 16, 150, 600, 0.3, 1.4);
  kSat(d, 2.5);
});

Object.assign(SFX, {

  ghoul_alert(S, t, o) {
    const v = V(S, o, 6, 0.45, 0.15); if (!v) return;
    smp(S, v, t, 'gh_alert', { g: 0.75, rate: jr(S, o, 0.06) });
  },

  ghoul_attack(S, t, o) {
    const v = V(S, o, 5, 0.35, 0); if (!v) return;
    smp(S, v, t, 'gh_bite', { g: 0.75, rate: jr(S, o, 0.12) });
  },

  ghoul_pain(S, t, o) {
    const v = V(S, o, 5, 0.4, 0.1); if (!v) return;
    smp(S, v, t, 'gh_pain', { g: 0.65, rate: jr(S, o, 0.1) });
  },

  ghoul_die(S, t, o) {
    const v = V(S, o, 6, 0.5, 0.2); if (!v) return;
    smp(S, v, t, 'gh_die', { g: 0.8, rate: jr(S, o, 0.06) });
  },

  gorger_alert(S, t, o) {
    const v = V(S, o, 6, 0.4, 0.25); if (!v) return;
    const r = jr(S, o, 0.05);
    smp(S, v, t, 'go_alert', { g: 0.85, rate: r });
    S._tone(v, t, 1.6, { type: 'sine', f: 47 * r, f2: 38 * r, sweep: 0.9, g: 0.35, atk: 0.3, hold: 0.7, rel: 0.55 });
  },

  gorger_attack(S, t, o) {
    const v = V(S, o, 6, 0.35, 0.1); if (!v) return;
    smp(S, v, t, 'go_chomp', { g: 0.85, rate: jr(S, o, 0.08) });
  },

  gorger_pain(S, t, o) {
    const v = V(S, o, 5, 0.4, 0.1); if (!v) return;
    smp(S, v, t, 'go_pain', { g: 0.75, rate: jr(S, o, 0.08) });
  },

  gorger_burst(S, t, o) {
    const v = V(S, o, 10, 0.35, 0.7); if (!v) return;
    const r = jr(S, o, 0.05);
    smp(S, v, t, 'go_pop', { g: 1.15, rate: r });
    S._tone(v, t + 0.005, 1.4, { type: 'sine', f: 70 * r, f2: 18, sweep: 0.5, g: 0.6, atk: 0.006, dec: 1.3 });
  },

  howler_alert(S, t, o) {
    const v = V(S, o, 8, 0.3, 0.5); if (!v) return;
    smp(S, v, t, 'ho_alert', { g: 0.75, rate: jr(S, o, 0.05) });
  },

  howler_spit(S, t, o) {
    const v = V(S, o, 6, 0.3, 0.35); if (!v) return;
    smp(S, v, t, 'ho_spit', { g: 0.75, rate: jr(S, o, 0.08) });
  },

  howler_pain(S, t, o) {
    const v = V(S, o, 5, 0.35, 0.15); if (!v) return;
    smp(S, v, t, 'ho_pain', { g: 0.65, rate: jr(S, o, 0.08) });
  },

  howler_die(S, t, o) {
    const v = V(S, o, 6, 0.4, 0.35); if (!v) return;
    smp(S, v, t, 'ho_die', { g: 0.75, rate: jr(S, o, 0.05) });
  },

  stalker_alert(S, t, o) {
    const v = V(S, o, 5, 0.4, 0.1); if (!v) return;
    smp(S, v, t, 'chitter', { g: 0.6, rate: jr(S, o, 0.1) });
    smp(S, v, t + 0.1, 'st_pain', { g: 0.3, rate: 0.7 });
  },

  // Claws on grating, getting closer faster than you would like.
  stalker_charge(S, t, o) {
    const v = V(S, o, 7, 0.45, 0.1); if (!v) return;
    const r = o.rate;
    const sc = S._nz(v, t, 1.6, { type: 'bandpass', f: 1700 * r, f2: 2600 * r, q: 6, g: 0.6, atk: 0.005, dec: 1.55 });
    gate(S, v, sc, S._scrabbleCurve, t, 1.55);
    S._nz(v, t, 1.55, { type: 'lowpass', f: 300 * r, f2: 460 * r, q: 1.4, g: 0.24, atk: 0.4, hold: 0.7, rel: 0.4, pink: true });
    smp(S, v, t + 0.2, 'chitter', { g: 0.4, rate: 1.2 * r });
  },

  stalker_attack(S, t, o) {
    const v = V(S, o, 5, 0.35, 0); if (!v) return;
    smp(S, v, t, 'st_rend', { g: 0.75, rate: jr(S, o, 0.14) });
  },

  stalker_pain(S, t, o) {
    const v = V(S, o, 5, 0.35, 0); if (!v) return;
    smp(S, v, t, 'st_pain', { g: 0.6, rate: jr(S, o, 0.1) });
  },

  stalker_die(S, t, o) {
    const v = V(S, o, 6, 0.4, 0.15); if (!v) return;
    smp(S, v, t, 'st_die', { g: 0.75, rate: jr(S, o, 0.06) });
  },

  maw_roar(S, t, o) {
    const v = V(S, o, 11, 0.3, 0.85); if (!v) return;
    const r = o.rate;
    smp(S, v, t, 'maw_roar', { g: 1.05, rate: r });
    S._tone(v, t, 3.5, { type: 'sine', f: 34 * r, f2: 25 * r, sweep: 0.9, g: 0.7, atk: 0.4, hold: 1.9, rel: 1.1 });
    const wetg = S._nz(v, t + 0.3, 2.8, {
      type: 'lowpass', f: 620 * r, f2: 260, q: 2.2, g: 0.3, atk: 0.5, hold: 1.3, rel: 0.9, pink: true,
    });
    gate(S, v, wetg, S._gurgleCurve, t + 0.3, 2.7);
  },

  maw_hurt(S, t, o) {
    const v = V(S, o, 8, 0.35, 0.45); if (!v) return;
    smp(S, v, t, 'maw_hurt', { g: 0.9, rate: jr(S, o, 0.06) });
  },

  maw_die(S, t, o) {
    const v = V(S, o, 12, 0.3, 0.9); if (!v) return;
    smp(S, v, t, 'maw_roar', { g: 1.0, rate: 0.8 });
    S._tone(v, t, 3.2, { type: 'sine', f: 62, f2: 16, sweep: 0.85, g: 0.75, atk: 0.2, hold: 1.4, rel: 1.5 });
    // and then it comes apart, wetly
    smp(S, v, t + 2.0, 'go_pop', { g: 1.1, rate: 0.75 });
  },
});

/* ------------------------------------------------------------------ gore */
// Wet, crunchy, and played for laughs. Everything here is exaggerated on
// purpose: a real limb coming off is a dull sound, and nobody wants that.

// A chunk of someone, landing. Fired by the dozen, so it is one buffer.
bake('gib', 0.32, 6, (d, sr, R) => {
  const j = 1 + (R() - 0.5) * 0.3;
  kThump(d, sr, 0, 170 * j, 80 * j, 0.01, 0.025, 0.6, 2);
  kNoise(d, sr, R, 0, 0.14, { type: 'lp', f0: 2200 * j, f1: 300, q: 1.6, atk: 0.001, tau: 0.03, amp: 3.2, col: 1 });
  kSquish(d, sr, R, 0.004, 0.2, 18, 240, 1300, 0.35, 1.6);
});

// A body meeting a wall: SPLAT, and the wall keeping some of it.
bake('splat', 0.6, 2, (d, sr, R) => {
  const j = 1 + (R() - 0.5) * 0.12;
  kClick(d, sr, 0, 0.9, 5);
  kThump(d, sr, 0, 130 * j, 50 * j, 0.015, 0.07, 1.1, 3);
  kNoise(d, sr, R, 0, 0.4, { type: 'lp', f0: 3200 * j, f1: 220, sw: 0.2, q: 2, atk: 0.001, tau: 0.07, amp: 6, col: 1 });
  kNoise(d, sr, R, 0.003, 0.2, { type: 'bp', f0: 1700 * j, f1: 700, q: 1.3, atk: 0.001, tau: 0.03, amp: 3 });
  kSquish(d, sr, R, 0.005, 0.55, 60, 180, 1500, 0.45, 2);
  kSat(d, 1.8);
});

// Bone. A green-stick snap: the crack, the splinters, the creak behind it.
bake('crack', 0.24, 4, (d, sr, R) => {
  const j = 1 + (R() - 0.5) * 0.2;
  kClick(d, sr, 0, 1.2, 2);
  kMode(d, sr, 0, 1450 * j, 0.012, 0.7);
  kMode(d, sr, 0, 2320 * j, 0.008, 0.5);
  kMode(d, sr, 0, 3900 * j, 0.005, 0.35);
  kCrackle(d, sr, R, 0.001, 0.05, 9000, 0.7, 2);
  kNoise(d, sr, R, 0.004, 0.12, { type: 'bp', f0: 700, f1: 400, q: 2.5, atk: 0.003, tau: 0.03, amp: 2.2, grain: 0.6 });
  kThump(d, sr, 0.002, 260 * j, 150 * j, 0.01, 0.02, 0.4, 2);
});

// Flesh tearing: a stick-slip rip that speeds up as the last of it lets go,
// the bone at the end of it snapping, and the schlorp of the part coming free.
bake('rip', 0.75, 2, (d, sr, R) => {
  const j = 1 + (R() - 0.5) * 0.12, L = 0.34 + R() * 0.08;
  const rip = new Float32Array(d.length);
  kCrackle(rip, sr, R, 0, L, 2600, 1, -1.2);
  kFilt(rip, sr, 0, L + 0.01, 'bp', 900 * j, 2600 * j, 0.9);
  for (let i = 0; i < rip.length; i++) d[i] += rip[i] * 3;
  kNoise(d, sr, R, 0, L, { type: 'bp', f0: 600 * j, f1: 1800 * j, q: 1.4, atk: L * 0.6, tau: 0.05, amp: 2.2, col: 1, grain: 0.7 });
  kSquish(d, sr, R, 0.02, L, 26, 200, 1100, 0.3, 0.8);
  // the bone
  kClick(d, sr, L, 1.3, 2);
  kMode(d, sr, L, 1600 * j, 0.012, 0.8);
  kMode(d, sr, L, 2700 * j, 0.007, 0.5);
  kCrackle(d, sr, R, L, 0.04, 8000, 0.7, 2);
  // schlorp: a big bubble collapsing upward
  kBubble(d, sr, L + 0.02, 180 * j, 0.05, 1.1, 3.5);
  kNoise(d, sr, R, L + 0.02, 0.25, { type: 'lp', f0: 1800, f1: 250, q: 1.8, atk: 0.002, tau: 0.05, amp: 3.5, col: 1 });
  kSquish(d, sr, R, L + 0.03, 0.3, 20, 250, 1300, 0.3, 1.8);
  kSat(d, 1.7);
});

// A head going like a champagne cork: the cartoon POP, then the squirt.
bake('pop', 0.6, 2, (d, sr, R) => {
  const j = 1 + (R() - 0.5) * 0.15;
  kClick(d, sr, 0, 1, 3);
  kTone(d, sr, 0, 0.045, 260 * j, 1500 * j, 1.1, 0.001, 0.014);
  kNoise(d, sr, R, 0, 0.05, { type: 'bp', f0: 1500 * j, q: 1.2, atk: 0.0005, tau: 0.01, amp: 3.5 });
  kThump(d, sr, 0.004, 150 * j, 70 * j, 0.01, 0.04, 0.6, 2);
  kNoise(d, sr, R, 0.03, 0.45, { type: 'bp', f0: 2600 * j, f1: 900, q: 1.6, atk: 0.005, tau: 0.1, amp: 2.4, am: [19, 0.7] });
  kSquish(d, sr, R, 0.02, 0.5, 45, 300, 2000, 0.3, 1.6);
  kSat(d, 1.5);
});

// A severed artery with a sense of rhythm: two or three pumps of squirt.
bake('spurt', 0.42, 4, (d, sr, R) => {
  const n = 2 + ((R() * 2) | 0), per = 0.1 + R() * 0.04;
  for (let p = 0; p < n; p++) {
    const tt = p * per, a = 1 - p * 0.25;
    kNoise(d, sr, R, tt, 0.1, { type: 'bp', f0: 2400 + R() * 600, f1: 1000, q: 1.8, atk: 0.006, tau: 0.035, amp: 2.4 * a });
    kSquish(d, sr, R, tt, 0.08, 6, 500, 1800, 0.25 * a, 1.4);
  }
});

// A limb landing: meat on concrete.
bakeLo('thud', 0.32, 4, (d, sr, R) => {
  const j = 1 + (R() - 0.5) * 0.25;
  kThump(d, sr, 0, 125 * j, 60 * j, 0.012, 0.04, 1, 2.6);
  kNoise(d, sr, R, 0, 0.14, { type: 'lp', f0: 1600 * j, f1: 260, q: 1.8, atk: 0.001, tau: 0.03, amp: 4, col: 1 });
  kSquish(d, sr, R, 0.004, 0.14, 10, 200, 900, 0.3, 1.8);
});

// A head bouncing. Somewhere between a jaw harp and a coconut, which is to say
// it goes BOING and then CLOK and it is never not funny.
bake('boing', 0.55, 2, (d, sr, R) => {
  const f = 160 + R() * 60, n = Math.ceil(0.5 * sr);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const fm = f * (1 + 0.5 * Math.exp(-t / 0.22) * Math.sin(TWO_PI * 13 * t) + 0.3 * Math.exp(-t / 0.04));
    ph += TWO_PI * fm / sr;
    const s = Math.sin(ph) + 0.35 * Math.sin(2 * ph) + 0.2 * Math.sin(3 * ph);
    d[i] += 0.55 * s * Math.exp(-t / 0.13) * (t < 0.003 ? t / 0.003 : 1);
  }
  kClick(d, sr, 0, 0.8, 4);
  kMode(d, sr, 0, 820 + R() * 100, 0.025, 0.7);
  kMode(d, sr, 0, 2150 + R() * 200, 0.012, 0.45);
  kThump(d, sr, 0, 200, 110, 0.01, 0.03, 0.4, 2);
});

// A corpse arriving somewhere at speed: floor, splat, rattle.
bake('slam_body', 0.7, 2, (d, sr, R) => {
  const j = 1 + (R() - 0.5) * 0.12;
  kThump(d, sr, 0, 105 * j, 40 * j, 0.02, 0.11, 1.3, 3.2);
  kClick(d, sr, 0, 0.8, 6);
  kNoise(d, sr, R, 0, 0.35, { type: 'lp', f0: 2400, f1: 200, q: 1.4, atk: 0.001, tau: 0.06, amp: 6, col: 1 });
  kSquish(d, sr, R, 0.005, 0.35, 30, 180, 1000, 0.35, 2);
  for (let b = 0; b < 5; b++) {
    const tt = 0.03 + R() * 0.2;
    kClick(d, sr, tt, 0.3, 2);
    kMode(d, sr, tt, 1300 + R() * 1500, 0.01, 0.25);
  }
  kSlap(d, sr, [[0.015, 0.3], [0.03, 0.18]], 0.3);
  kSat(d, 2);
});

// A boot meeting a head: the leather THOK and a rubber-duck squeak on the way
// out, because the head is surprised too.
bake('punt_head', 0.5, 1, (d, sr, R) => {
  kThump(d, sr, 0, 170, 70, 0.012, 0.05, 1.2, 3);
  kClick(d, sr, 0, 1, 3);
  kNoise(d, sr, R, 0, 0.06, { type: 'bp', f0: 1300, q: 1.6, atk: 0.0005, tau: 0.012, amp: 4 });
  const sq = new Float32Array(d.length);
  kTone(sq, sr, 0.05, 0.16, 820 + R() * 120, 1500 + R() * 200, 0.8, 0.01, 0, 2, [28, 0.06]);
  kFilt(sq, sr, 0.05, 0.22, 'bp', 1600, 1600, 1.4);
  for (let i = 0; i < d.length; i++) d[i] += sq[i] * 1.2;
  kSquish(d, sr, R, 0.01, 0.2, 10, 300, 1200, 0.25, 1.6);
});

// Acid: the splash of it, before the sizzle that is done live.
bake('splash', 0.3, 1, (d, sr, R) => {
  kClick(d, sr, 0, 0.5, 4);
  kNoise(d, sr, R, 0, 0.2, { type: 'bp', f0: 1800, f1: 700, q: 1.8, atk: 0.001, tau: 0.04, amp: 3 });
  kSquish(d, sr, R, 0, 0.2, 18, 500, 2200, 0.3, 1.6);
});

Object.assign(SFX, {

  gib(S, t, o) {
    const v = V(S, o, 4, 0.3, 0); if (!v) return;
    smp(S, v, t, 'gib', { g: 0.75, rate: jr(S, o, 0.3) });
  },

  splat(S, t, o) {
    const v = V(S, o, 5, 0.4, 0.1); if (!v) return;
    smp(S, v, t, 'splat', { g: 0.95, rate: jr(S, o, 0.12) });
  },

  bone_crack(S, t, o) {
    const v = V(S, o, 5, 0.35, 0); if (!v) return;
    smp(S, v, t, 'crack', { g: 0.8, rate: jr(S, o, 0.14) });
  },

  acid_hit(S, t, o) {
    const v = V(S, o, 5, 0.3, 0.1); if (!v) return;
    const r = o.rate;
    smp(S, v, t, 'splash', { g: 0.7, rate: jr(S, o, 0.1) });
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

  // --- dismemberment. The gore lane calls these by name; each is one voice.

  limb_rip(S, t, o) {
    const v = V(S, o, 6, 0.35, 0.05); if (!v) return;
    smp(S, v, t, 'rip', { g: 0.9, rate: jr(S, o, 0.1) });
  },

  head_pop(S, t, o) {
    const v = V(S, o, 7, 0.35, 0.1); if (!v) return;
    smp(S, v, t, 'pop', { g: 0.9, rate: jr(S, o, 0.1) });
  },

  // Called repeatedly while a stump pumps, so it is small and never repeats.
  blood_spurt(S, t, o) {
    const v = V(S, o, 3, 0.2, 0); if (!v) return;
    smp(S, v, t, 'spurt', { g: 0.5, rate: jr(S, o, 0.2) });
  },

  meat_thud(S, t, o) {
    const v = V(S, o, 4, 0.3, 0); if (!v) return;
    smp(S, v, t, 'thud', { g: 0.75, rate: jr(S, o, 0.2) });
  },

  bone_bounce(S, t, o) {
    const v = V(S, o, 4, 0.3, 0); if (!v) return;
    smp(S, v, t, 'boing', { g: 0.6, rate: jr(S, o, 0.12) });
  },

  body_slam(S, t, o) {
    const v = V(S, o, 5, 0.4, 0.05); if (!v) return;
    smp(S, v, t, 'slam_body', { g: 0.95, rate: jr(S, o, 0.1) });
  },

  head_punt(S, t, o) {
    const v = V(S, o, 7, 0.3, 0.3); if (!v) return;
    smp(S, v, t, 'punt_head', { g: 0.9, rate: jr(S, o, 0.06) });
    // and away it goes
    S._tone(v, t + 0.1, 0.7, { type: 'triangle', f: 420 * o.rate, f2: 1500 * o.rate, sweep: 0.8, g: 0.12, atk: 0.02, dec: 0.65 });
  },
});

/* --------------------------------------------------------- melee, ordnance */

// THE BOOT. Size 13, steel toe, and a kick that starts from the hip.
bake('boot_hit', 0.4, 2, (d, sr, R) => {
  const j = 1 + (R() - 0.5) * 0.1;
  kThump(d, sr, 0, 150 * j, 55 * j, 0.015, 0.07, 1.3, 3.5);
  kClick(d, sr, 0, 1, 4);
  kNoise(d, sr, R, 0, 0.08, { type: 'bp', f0: 1100 * j, q: 1.4, atk: 0.0005, tau: 0.015, amp: 4.5 });
  kNoise(d, sr, R, 0.002, 0.2, { type: 'lp', f0: 1800, f1: 250, q: 1.5, atk: 0.001, tau: 0.04, amp: 4, col: 1 });
  kSquish(d, sr, R, 0.005, 0.12, 8, 250, 900, 0.2, 1.6);
  kSlap(d, sr, [[0.012, 0.25], [0.023, 0.14]], 0.3);
  kSat(d, 2.2);
});

bake('boot_wall', 0.35, 1, (d, sr, R) => {
  kThump(d, sr, 0, 180, 80, 0.01, 0.04, 1, 3);
  kClick(d, sr, 0, 0.9, 3);
  kNoise(d, sr, R, 0, 0.08, { type: 'bp', f0: 2400, f1: 1200, q: 1.3, atk: 0.0005, tau: 0.012, amp: 3 });
  kDebris(d, sr, R, 0.005, 0.2, 7, 2000, 7000, 0.2, 0.004);
  kSlap(d, sr, [[0.01, 0.3], [0.02, 0.2]], 0.3);
});

// A pipe with a fuse in it: hollow steel, bouncing, rolling a little.
bake('pipe_land', 0.6, 1, (d, sr, R) => {
  const at = [0, 0.13, 0.215, 0.27, 0.305];
  const f = 1050 * (1 + (R() - 0.5) * 0.1);
  for (let i = 0; i < at.length; i++) {
    const a = 0.8 / (1 + i * 0.9);
    kClick(d, sr, at[i], a, 2);
    kMode(d, sr, at[i], f, 0.09, a * 0.6);
    kMode(d, sr, at[i], f * 2.74, 0.05, a * 0.4);
    kMode(d, sr, at[i], f * 5.4, 0.025, a * 0.25);
    kThump(d, sr, at[i], 240, 140, 0.008, 0.015, a * 0.3, 1);
  }
  kNoise(d, sr, R, 0.3, 0.25, { type: 'bp', f0: 2400, q: 3, atk: 0.02, tau: 0.08, amp: 0.4, grain: 0.7 });
});

Object.assign(SFX, {

  kick_swing(S, t, o) {
    const v = V(S, o, 4, 0.25, 0); if (!v) return;
    smp(S, v, t, 'swish', { g: 0.7, rate: jr(S, o, 0.08) * 0.65 });
    S._nz(v, t, 0.18, { type: 'bandpass', f: 250, f2: 700, q: 1, g: 0.18, atk: 0.1, dec: 0.08, pink: true });
  },

  kick_hit(S, t, o) {
    const v = V(S, o, 6, 0.4, 0.1); if (!v) return;
    smp(S, v, t, 'boot_hit', { g: 1.0, rate: jr(S, o, 0.08) });
    smp(S, v, t + 0.004, 'crack', { g: 0.3, rate: jr(S, o, 0.2) });
  },

  kick_wall(S, t, o) {
    const v = V(S, o, 4, 0.45, 0); if (!v) return;
    smp(S, v, t, 'boot_wall', { g: 0.9, rate: jr(S, o, 0.06) });
  },

  // A light enemy leaving the roof. This is allowed to be funny.
  punt(S, t, o) {
    const v = V(S, o, 8, 0.25, 0.6); if (!v) return;
    const r = o.rate;
    smp(S, v, t, 'boot_hit', { g: 1.1, rate: r * 0.9 });
    // the slide whistle: up, over, and away
    S._tone(v, t + 0.04, 0.9, { type: 'triangle', f: 240 * r, f2: 1400 * r, sweep: 0.8, g: 0.3, atk: 0.02, dec: 0.85 });
    S._tone(v, t + 0.04, 0.9, { type: 'sine', f: 480 * r, f2: 2800 * r, sweep: 0.78, g: 0.08, atk: 0.03, dec: 0.85 });
    // doppler wash as it clears the parapet
    S._nz(v, t + 0.05, 0.9, { type: 'bandpass', f: 900 * r, f2: 4200 * r, q: 3, g: 0.16, atk: 0.12, dec: 0.75 });
  },

  pipebomb_throw(S, t, o) {
    const v = V(S, o, 4, 0.3, 0.1); if (!v) return;
    smp(S, v, t, 'swish', { g: 0.6, rate: jr(S, o, 0.08) });
    S._nz(v, t + 0.03, 0.05, { type: 'bandpass', f: 2900, q: 9, g: 0.16, atk: 0.001, dec: 0.045 });
  },

  pipebomb_land(S, t, o) {
    const v = V(S, o, 5, 0.5, 0.1); if (!v) return;
    smp(S, v, t, 'pipe_land', { g: 0.75, rate: jr(S, o, 0.08) });
  },

  // Called every half second while it is armed. Two nodes. Do not add layers.
  pipebomb_beep(S, t, o) {
    const v = V(S, o, 3, 0.15, 0); if (!v) return;
    S._tone(v, t, 0.035, { type: 'square', f: 2100 * o.rate, g: 0.16, atk: 0.001, dec: 0.032 });
  },

  // Tighter and drier than airburst: this one went off in a corridor.
  pipebomb_blow(S, t, o) {
    const v = V(S, o, 9, 0.45, 0.2); if (!v) return;
    const r = jr(S, o, 0.06);
    smp(S, v, t, 'pipe', { g: 1.15, rate: r });
    S._tone(v, t, 0.5, { type: 'sine', f: 70 * r, f2: 28, sweep: 0.5, g: 0.55, atk: 0.003, dec: 0.45 });
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
