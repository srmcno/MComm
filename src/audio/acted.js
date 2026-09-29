// acted.js - the cast, recorded.
//
// The lines heard most were recorded by voice actors (ElevenLabs takes) and
// ship in voicepack.js as small mp3 clips. This module is the player for them:
// Speech asks it whether a line has a take and, if so, has it played here,
// through the game's own Web Audio graph, instead of the browser's voice.
// Anything without a take falls through to the browser voice as before.
//
// A clip is { r: role, k: line key, i: variant index, a: the city it names
// (or null), t: the words, d: seconds, b: base64 mp3 }. Lines that name a city
// were recorded once per city, so a take is picked by the city as well as the
// key. Clips are decoded on first use and a few dozen are kept.
//
// Ilsa is on a radio, so her takes go through a band-pass and a little
// grit; MUTTER is a building, so his get a faint metallic comb. Brick is in
// the room and gets nothing.

const MAX_CACHED = 48;

/** Lowercase words only, for matching a request against a take's text. */
export function clipKey(role, text) {
  return `${role}|${String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`;
}

function b64ToBuffer(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export class ClipBank {
  constructor(pack, opts = {}) {
    const clips = (pack && Array.isArray(pack.clips)) ? pack.clips : [];
    this.clips = clips.filter((c) => c && c.r && c.t && c.b && c.d > 0);
    this.rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
    this.byText = new Map();
    this.byKey = new Map();
    for (const c of this.clips) {
      this.byText.set(clipKey(c.r, c.t), c);
      if (c.k) {
        if (!this.byKey.has(c.k)) this.byKey.set(c.k, []);
        this.byKey.get(c.k).push(c);
      }
    }
    this.ctx = null;
    this.buses = {};
    this.cache = new Map();
    this.last = {};
  }

  get size() { return this.clips.length; }

  /** Does this line key have any takes at all. */
  has(key) {
    const l = this.byKey.get(key);
    return !!(l && l.length);
  }

  /** The take of exactly these words by this speaker, or null. */
  find(role, text) {
    return this.byText.get(clipKey(role, text)) || null;
  }

  /**
   * A take of a line key. `pick` asks for one variant (the ex who lives in
   * this city); `args[0]` is the city, for lines that name it. Never the same
   * take twice running when there is another.
   */
  pick(key, opts = {}) {
    let l = this.byKey.get(key);
    if (!l || !l.length) return null;
    if (Number.isFinite(opts.pick)) l = l.filter((c) => c.i === opts.pick);
    const city = opts.args && opts.args.length ? String(opts.args[0]).toLowerCase() : '';
    const named = l.some((c) => c.a);
    if (named) l = l.filter((c) => c.a && c.a.toLowerCase() === city);
    if (!l.length) return null;
    // A line that has more variants than takes: the takes are the good ones and
    // get the larger share, but the rest are heard too, or a floor's worth of
    // kills would be the same five sentences. `spare` is how many variants
    // have no take. Not for a named city or a chosen variant: those are exact.
    if (!named && !Number.isFinite(opts.pick) && opts.spare > 0) {
      const take = Math.max(0.5, (l.length * 3) / (l.length * 3 + opts.spare));
      if (this.rng() >= take) return null;
    }
    const prev = this.last[key];
    const fresh = l.length > 1 ? l.filter((c) => c !== prev) : l;
    const c = fresh[Math.min(fresh.length - 1, Math.floor(this.rng() * fresh.length))];
    this.last[key] = c;
    return c;
  }

  /** Wire the player into the audio graph. Nothing plays before this. */
  attach(ctx, dest) {
    if (!ctx || !dest) return;
    this.ctx = ctx;
    try {
      this.buses.brick = ctx.createGain();
      this.buses.brick.connect(dest);

      // The radio: 300 Hz to 3.4 kHz, a touch of saturation.
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 300;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3400;
      const sh = ctx.createWaveShaper();
      const curve = new Float32Array(1024);
      for (let i = 0; i < curve.length; i++) {
        const x = (i / (curve.length - 1)) * 2 - 1;
        curve[i] = Math.tanh(x * 1.8) / Math.tanh(1.8);
      }
      sh.curve = curve;
      const ig = ctx.createGain(); ig.gain.value = 1.15;
      hp.connect(lp); lp.connect(sh); sh.connect(ig); ig.connect(dest);
      this.buses.ilsa = hp;

      // The building: the voice, plus a short feedback comb under it.
      const m = ctx.createGain();
      const dl = ctx.createDelay(0.05); dl.delayTime.value = 0.011;
      const fb = ctx.createGain(); fb.gain.value = 0.32;
      const wet = ctx.createGain(); wet.gain.value = 0.3;
      m.connect(dest);
      m.connect(dl); dl.connect(fb); fb.connect(dl); dl.connect(wet); wet.connect(dest);
      this.buses.mutter = m;
    } catch {
      this.buses = {};
      this.ctx = null;
    }
  }

  get ready() { return !!this.ctx; }

  _decode(c) {
    const hit = this.cache.get(c);
    if (hit) {
      this.cache.delete(c); this.cache.set(c, hit);    // most recently used last
      return Promise.resolve(hit);
    }
    const ctx = this.ctx;
    return new Promise((resolve, reject) => {
      let data;
      try { data = b64ToBuffer(c.b); } catch (e) { reject(e); return; }
      // Safari only has the callback form; the rest call both. Once is enough.
      let done = false;
      const ok = (buf) => {
        if (done) return;
        done = true;
        this.cache.set(c, buf);
        while (this.cache.size > MAX_CACHED) this.cache.delete(this.cache.keys().next().value);
        resolve(buf);
      };
      const bad = (e) => { if (!done) { done = true; reject(e); } };
      try {
        const p = ctx.decodeAudioData(data, ok, bad);
        if (p && typeof p.then === 'function') p.then(ok, bad);
      } catch (e) { bad(e); }
    });
  }

  /**
   * Play a take. `onStart(seconds)` when it is heard, `onEnd()` when it is
   * done, `onFail()` if it cannot be decoded or played (the caller says the
   * line some other way). Returns a handle whose stop() cuts it off.
   */
  play(c, opts = {}) {
    const h = { stopped: false, src: null, stop() {
      this.stopped = true;
      try { if (this.src) this.src.stop(); } catch { /* already stopped */ }
    } };
    const fail = () => { if (!h.stopped && typeof opts.onFail === 'function') opts.onFail(); };
    if (!this.ctx) { fail(); return h; }
    this._decode(c).then((buf) => {
      if (h.stopped) return;
      try {
        const ctx = this.ctx;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const g = ctx.createGain();
        g.gain.value = Math.max(0, Math.min(4, Number.isFinite(opts.vol) ? opts.vol : 1));
        src.connect(g);
        g.connect(this.buses[c.r] || this.buses.brick);
        src.onended = () => { if (typeof opts.onEnd === 'function') opts.onEnd(); };
        h.src = src;
        src.start();
        if (typeof opts.onStart === 'function') opts.onStart(buf.duration);
      } catch { fail(); }
    }, fail);
    return h;
  }
}

export default ClipBank;
