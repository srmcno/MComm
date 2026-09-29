// speech.js - the cast, read aloud by the browser's own speech engine.
//
// The formant synthesiser in vox.js has character, but a player in a firefight
// could not tell what it was saying, and a comedy nobody can hear is not a
// comedy. So the primary voice is now the Web Speech API: every desktop and
// phone browser ships a few voices, and the good ones (Edge's "Online
// (Natural)" set, macOS Enhanced voices, Google's network voices) are far past
// anything we could synthesise in a few kilobytes.
//
// What this module adds on top of speechSynthesis:
//   - CASTING. Brick, Ilsa and MUTTER each get a voice picked from whatever the
//     machine offers, by language, apparent gender, quality and a preference
//     list per platform, and never the same voice twice when there is a choice.
//     Ilsa prefers a German voice reading the English script, which is the
//     cheapest real accent there is.
//   - PROSODY per character (pitch, rate, mood), adjusted when casting had to
//     settle for the wrong register.
//   - HONEST TIMING. onend is unreliable (Chrome drops it, some engines never
//     send it), so every line returns a duration estimated from its syllables,
//     and onend/onerror only ever shorten it.
//   - THE CHROME QUIRKS: a queue wedged in "pending" (cancel first), utterances
//     silently cut off after ~15 s (split at sentence boundaries), a paused
//     synth that needs a resume() nudge, and utterance objects that get
//     garbage collected mid-sentence unless something holds them.
//   - FALLBACK to the formant synth when the API is missing, throws, has no
//     voices ~1.5 s after first use, or produces dead air; and by choice, when
//     the player sets VOICE to ROBOT.
//
// Nothing here touches window.speechSynthesis at module load: in a sandboxed
// frame even reading the property can throw, so it is probed inside try/catch
// when the first Speech is constructed, which main.js does inside the first
// user gesture.

import { pickLine, pickLineAt, voiceOf, lineStarted } from './vox.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v, d) => (isNum(v) ? v : d);
/** Tell a queued line's owner it will never be spoken (it was cut or bumped). */
function dropped(item) {
  const f = item && item.opts && item.opts.onDrop;
  if (typeof f === 'function') { try { f(); } catch { /* a caller's hook must not break the queue */ } }
}
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export const VOICE_MODES = Object.freeze(['natural', 'robot', 'off']);
const STORE_KEY = 'nukehaus.voice.v1';

/** The saved VOICE setting. Storage can be absent or throw; default NATURAL. */
export function loadVoiceMode() {
  try {
    const v = localStorage.getItem(STORE_KEY);
    if (VOICE_MODES.includes(v)) return v;
  } catch { /* private window, sandboxed frame: use the default */ }
  return 'natural';
}

export function saveVoiceMode(mode) {
  try { if (VOICE_MODES.includes(mode)) localStorage.setItem(STORE_KEY, mode); }
  catch { /* the setting just will not survive a reload */ }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* TEXT                                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

// {Sieben|S IY1 B AH N}: the written word, a pipe, then phones for the formant
// synth. A bare {S IY1 B AH N} is the legacy form: phones only, no word, so
// there is nothing a person should see or a TTS voice should read. It goes.
const PIPE_GROUP = /\{([^{}|]*)\|[^{}]*\}/g;
const LEGACY_GROUP = /\{[^{}]*\}/g;

/**
 * Script text as a person reads it: the caption, and the base of what a TTS
 * voice is given. Pronunciation groups become their written word, legacy
 * phone-only groups disappear, stray %s tokens and the spaces they leave go.
 */
export function plainText(text) {
  if (text == null) return '';
  return String(text)
    .replace(PIPE_GROUP, (m, word) => word.trim())
    .replace(LEGACY_GROUP, ' ')
    .replace(/[{}|]/g, ' ')
    .replace(/%s/g, '')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([,;:])(?=[,;:.!?])/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// English voices say these wrong on their own. The German voice gets the
// originals, which it says right.
const RESPELL_EN = [
  [/\bSieben\b/gi, 'Zeeben'],
  [/\bMUTTER\b/g, 'Mooter'],
  [/\bMutter\b/g, 'Mooter'],
  [/\bNUKEHAUS\b/gi, 'Nuke house'],
  [/\bMIRVs\b/g, 'Mervs'],
  [/\bMIRV\b/g, 'Merv'],
];

/**
 * What the TTS engine is actually handed. Words in capitals are softened to
 * title case (several engines spell out anything in caps longer than a word
 * or two, so LOW SABBATH came out as letters), then respelled for English.
 */
export function ttsText(text, lang) {
  let t = plainText(text);
  if (!/^de\b/i.test(String(lang || ''))) for (const [re, to] of RESPELL_EN) t = t.replace(re, to);
  const soft = (w) => w[0] + w.slice(1).toLowerCase();
  // A run of capitalised words is a name (LOW SABBATH); a lone short one may
  // be an acronym and is left for the engine to spell.
  return t.replace(/\b[A-Z][A-Z']+(?:\s+[A-Z][A-Z']+)+\b/g, (run) => run.replace(/[A-Z][A-Z']+/g, soft))
    .replace(/\b[A-Z][A-Z']{3,}\b/g, soft);
}

/**
 * Delivery, the only direction a TTS engine takes: punctuation. Neural voices
 * lift an exclamation and flatten a full stop, so Brick's short lines are
 * barked (he has never ended a one-liner on a full stop in his life), and
 * MUTTER, which does not raise its voice, never exclaims at all. Only the
 * spoken text changes; the caption keeps the script's punctuation.
 */
export function deliver(role, text) {
  const t = String(text || '');
  if (role === 'brick' && t.length <= 64) return t.replace(/\.(["')\]]?)$/, '!$1');
  if (role === 'mutter') return t.replace(/!+/g, '.');
  return t;
}

/**
 * Break a line into pieces short enough that Chrome will not cut them off
 * (it drops anything past ~15 s). Splits at sentence ends, then at commas,
 * then at spaces, in that order of preference.
 */
export function splitChunks(text, max = 170) {
  const t = String(text || '').trim();
  if (!t) return [];
  if (t.length <= max) return [t];
  const out = [];
  const pushPiece = (piece) => {
    let p = piece.trim();
    while (p.length > max) {
      let cut = p.lastIndexOf(', ', max);
      if (cut >= max * 0.4) cut += 1;                  // keep the comma
      else cut = p.lastIndexOf(' ', max);
      if (cut < max * 0.3) cut = max;                  // one enormous word: just cut it
      out.push(p.slice(0, cut).trim());
      p = p.slice(cut).trim();
    }
    if (p) out.push(p);
  };
  const sentences = t.match(/[^.!?]+(?:[.!?]+["')\]]*|$)\s*/g) || [t];
  let cur = '';
  for (const s of sentences) {
    if ((cur + s).trim().length <= max) { cur += s; continue; }
    if (cur.trim()) out.push(cur.trim());
    cur = '';
    if (s.trim().length > max) pushPiece(s); else cur = s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

// Commas, semicolons, spaced dashes of any length, and ellipses: each one is
// a breath. Built from code points so no long dash appears in the source.
const DASH_BREAK = new RegExp('[,;:]|\\s[-' + String.fromCharCode(0x2013, 0x2014) + ']+\\s|\\.\\.\\.|' +
  String.fromCharCode(0x2026), 'g');

function numberSyllables(digits) {
  const n = digits.length;
  // "four hundred and twelve" is six; "1979" as a year is five.
  return n <= 1 ? 1.2 : n === 2 ? 2.2 : n === 3 ? 4.5 : n === 4 ? 5 : n * 1.6;
}

/**
 * Seconds a TTS voice takes to say `text` at `rate`. English TTS runs at about
 * 4.4 syllables a second at rate 1; sentence ends and commas add their own
 * pauses; engine start-up latency and the tail add a little. This errs long,
 * because a caption that lingers is harmless and one that vanishes mid-word,
 * or a radio queue that starts the next speaker early, is not.
 */
export function estimateSeconds(text, rate = 1) {
  const t = plainText(text);
  if (!t) return 0;
  let syl = 0;
  for (const w of t.match(/[A-Za-z']+|\d+/g) || []) {
    if (/^\d+$/.test(w)) { syl += numberSyllables(w); continue; }
    const lw = w.toLowerCase().replace(/'/g, '');
    const core = lw.length > 3 ? lw.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '') : lw;
    const groups = core.match(/[aeiouy]+/g);
    syl += Math.max(1, groups ? groups.length : 1);
  }
  const stops = (t.match(/[.!?]+(?=\s|$)/g) || []).length;
  const breaks = (t.match(DASH_BREAK) || []).length;
  const secs = syl / 4.4 + stops * 0.30 + breaks * 0.17;
  return +(secs / clamp(num(rate, 1), 0.3, 3) + 0.32).toFixed(3);
}

/* ────────────────────────────────────────────────────────────────────────── */
/* CASTING                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

// Voice names across Windows (SAPI and Edge's online set), macOS/iOS, Chrome's
// Google voices, Android's locale codes, and a few Linux engines. Gender is
// never in the API, so it is read off the name where the name gives it away.
const FEMALE_NAMES = [
  'zira', 'hazel', 'susan', 'heather', 'katja', 'hedda', 'anna', 'petra', 'helena',
  'marlene', 'vicki', 'amala', 'seraphina', 'louisa', 'elke', 'gisela', 'klarissa',
  'maja', 'tanja', 'ingrid', 'jenny', 'aria', 'sara', 'michelle', 'ana', 'emma',
  'ava', 'libby', 'sonia', 'maisie', 'natasha', 'clara', 'samantha', 'victoria',
  'karen', 'moira', 'tessa', 'fiona', 'serena', 'kate', 'allison', 'nicky',
  'joanna', 'salli', 'kimberly', 'ivy', 'kendra', 'kathy', 'princess', 'zoe',
  'ellen', 'amelie', 'catherine', 'linda', 'eva', 'ashley', 'cora', 'elizabeth',
  'jane', 'nancy', 'monica', 'paulina', 'veena', 'tessa', 'martha', 'shelley',
  'grandma', 'flo', 'sandy', 'google us english', 'google deutsch',
  'en-us-x-sfg', 'en-us-x-tpf', 'en-us-x-tpc', 'en-us-x-iob', 'en-us-x-iog',
  'en-gb-x-gba', 'en-gb-x-gbc', 'en-gb-x-gbg', 'de-de-x-dea', 'de-de-x-nfh',
];
const MALE_NAMES = [
  'david', 'mark', 'george', 'richard', 'james', 'guy', 'davis', 'christopher',
  'eric', 'roger', 'steffan', 'andrew', 'brian', 'tony', 'jason', 'ryan', 'thomas',
  'william', 'liam', 'conrad', 'killian', 'kasper', 'ralf', 'bernd', 'christoph',
  'stefan', 'markus', 'yannick', 'viktor', 'florian', 'alex', 'daniel', 'fred',
  'tom', 'aaron', 'evan', 'nathan', 'oliver', 'arthur', 'gordon', 'reed', 'rocko',
  'ralph', 'grandpa', 'junior', 'albert', 'bruce', 'rishi', 'eddy', 'lee', 'sean',
  'zarvox', 'trinoids', 'ravi', 'hemant', 'paul',
  'en-us-x-iol', 'en-us-x-iom', 'en-us-x-tpd', 'en-gb-x-gbd', 'en-gb-x-rjs',
  'de-de-x-deb', 'de-de-x-deg',
];
const NOVELTY = /\b(albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|deranged|hysterical)\b/;
const ELOQUENCE = /\b(eddy|flo|grandma|grandpa|reed|rocko|sandy|shelley)\b/;
const nameRe = (n) => new RegExp(`(^|[^a-z])${n.replace(/[-]/g, '\\-')}([^a-z]|$)`);
const FEMALE_RE = FEMALE_NAMES.map(nameRe);
const MALE_RE = MALE_NAMES.map(nameRe);

// Voice objects are stable for a page's life (Chrome hands back the same ones
// on every getVoices()), and a recast scores each one three times against
// ~140 name patterns: remember the answer per object.
const INFO_CACHE = typeof WeakMap === 'function' ? new WeakMap() : null;

/** What can be inferred about a voice from the little the API reports. */
export function voiceInfo(v) {
  if (INFO_CACHE && v && typeof v === 'object') {
    const hit = INFO_CACHE.get(v);
    if (hit && hit.name === String(v.name || '') && hit.rawLang === String(v.lang || '')) return hit;
    const info = readVoice(v);
    INFO_CACHE.set(v, info);
    return info;
  }
  return readVoice(v);
}

function readVoice(v) {
  const name = String((v && v.name) || '');
  const n = name.toLowerCase();
  const lang = String((v && v.lang) || '').replace(/_/g, '-').toLowerCase();
  let gender = null;
  if (/\bfemale\b|\bwoman\b|\bfrau\b/.test(n)) gender = 'f';
  else if (/\bmale\b|\bman\b|\bmann\b/.test(n)) gender = 'm';
  else if (FEMALE_RE.some((re) => re.test(n))) gender = 'f';
  else if (MALE_RE.some((re) => re.test(n))) gender = 'm';
  let quality = 1;
  if (/natural|neural|premium|enhanced|wavenet|studio|journey|siri/.test(n)) quality = 3;
  else if (/online|google/.test(n) || (v && v.localService === false)) quality = 2;
  if (/espeak|pico|mbrola|festival|flite/.test(n)) quality = 0;
  if (ELOQUENCE.test(n)) quality = 0;
  if (NOVELTY.test(n)) quality = -2;
  return { name, rawLang: String((v && v.lang) || ''), n, lang, gender, quality, de: /^de\b/.test(lang), en: /^en\b/.test(lang),
    enUS: /^en-us\b/.test(lang), enGB: /^en-gb\b/.test(lang) };
}

// Preference orders, best first. Only a tiebreak on top of language, gender
// and quality; an unlisted voice can still win on those.
const PREFS = {
  // Deep, cocky, American. Edge's Davis and Guy have the gravel; SAPI David
  // and Mark are the reliable Windows floor; Alex is the Mac's best man.
  brick: ['davis', 'guy', 'christopher', 'eric', 'roger', 'tony', 'jason', 'andrew',
    'brian', 'steffan', 'evan', 'nathan', 'tom', 'alex', 'aaron', 'david', 'mark',
    'en-us-x-iol', 'en-us-x-iom', 'en-us-x-tpd', 'google uk english male', 'richard',
    'james', 'ralph', 'rocko', 'fred'],
  // A German engineer on a radio: a German voice reading English first, then
  // the clearest English women.
  ilsa: ['katja', 'amala', 'seraphina', 'louisa', 'elke', 'gisela', 'klarissa', 'maja',
    'tanja', 'anna', 'petra', 'helena', 'marlene', 'vicki', 'hedda', 'google deutsch',
    'sonia', 'libby', 'maisie', 'jenny', 'aria', 'michelle', 'emma', 'ava', 'hazel',
    'samantha', 'karen', 'moira', 'tessa', 'serena', 'kate', 'fiona', 'victoria', 'zira',
    'google uk english female', 'google us english'],
  // Institutional, British, measured. Fred is a 1984 Macintosh and a perfectly
  // good launch computer; Zarvox is a last resort with a certain charm.
  mutter: ['ryan', 'thomas', 'daniel', 'george', 'google uk english male', 'oliver',
    'arthur', 'rishi', 'fred', 'christopher', 'eric', 'roger', 'mark', 'david',
    'conrad', 'markus', 'yannick', 'stefan', 'zarvox'],
};

// Compiled once: a recast scores every voice for every part.
const PREFS_RE = {};
for (const r of Object.keys(PREFS)) PREFS_RE[r] = PREFS[r].map(nameRe);

function prefBonus(role, n) {
  const list = PREFS_RE[role];
  for (let i = 0; i < list.length; i++) {
    if (list[i].test(n)) return 24 - i * 0.7;
  }
  return 0;
}

/** How well a voice suits a part. Higher is better; negative is a bad fit. */
export function scoreVoice(role, v) {
  const I = voiceInfo(v);
  let s = I.quality * 10 + prefBonus(role, I.n) + (v && v.default ? 1 : 0);
  if (role === 'brick') {
    s += I.enUS ? 36 : I.en ? 22 : -80;
    s += I.gender === 'm' ? 40 : I.gender === 'f' ? -30 : 4;
  } else if (role === 'ilsa') {
    if (I.de) s += 50 + (I.gender === 'f' ? 40 : I.gender === 'm' ? -35 : 10);
    else if (I.en) s += 20 + (I.gender === 'f' ? 35 : I.gender === 'm' ? -30 : 0) + (I.enGB ? 4 : 0);
    else s -= 70;
  } else {
    s += I.enGB ? 30 : I.en ? 22 : I.de ? 4 : -80;
    s += I.gender === 'm' ? 22 : I.gender === 'f' ? -4 : 4;
  }
  if (I.quality < 0 && !(role === 'mutter' && /zarvox/.test(I.n))) s -= 30;
  return s;
}

// Base prosody per character. SpeechSynthesisUtterance pitch runs 0..2 and
// rate 0.1..10, both 1 at neutral.
const PROSODY = {
  brick: { pitch: 0.74, rate: 1.07 },
  ilsa: { pitch: 1.06, rate: 1.02 },
  mutter: { pitch: 0.58, rate: 0.90 },
};
const MOOD = {
  calm: { pitch: 1, rate: 1 },
  urgent: { pitch: 1.05, rate: 1.13 },
  sweet: { pitch: 1.07, rate: 0.93 },
  dying: { pitch: 0.86, rate: 0.80 },
};
export const ROLES = Object.freeze(['brick', 'ilsa', 'mutter']);

function prosodyFor(role, v) {
  const base = PROSODY[role];
  const I = v ? voiceInfo(v) : { gender: null, de: false, n: '' };
  let { pitch, rate } = base;
  // Casting settled for the wrong register: push harder the other way so the
  // three characters still sound like three people.
  if (role === 'brick' && I.gender === 'f') pitch = 0.5;
  if (role === 'mutter' && I.gender === 'f') pitch = 0.66;
  // A name that gives nothing away ("English United States" on Android) is,
  // more often than not, the platform's default woman. Lean low anyway: on a
  // man it only sounds deeper, on a woman it is the difference between Brick
  // and his aunt.
  if (role === 'brick' && I.gender === null) pitch = 0.62;
  if (role === 'mutter' && I.gender === null) pitch = 0.5;
  if (role === 'ilsa' && I.gender === 'm') pitch = 1.38;
  if (role === 'ilsa' && I.gender === null) pitch = 1.14;
  // Accented English is harder to follow; give it a hair more time.
  if (role === 'ilsa' && I.de) rate = 0.97;
  // The Mac's old robot voices are already flat and slow.
  if (/\b(fred|zarvox)\b/.test(I.n)) { pitch = Math.max(pitch, 0.9); rate = Math.max(rate, 1); }
  return { pitch, rate };
}

/**
 * Pick a voice for each part. Tries the best few candidates per part and takes
 * the combination with the highest total, where casting one voice twice costs
 * points, so a duplicate only happens when the machine has nothing else.
 * Returns { brick, ilsa, mutter } of { voice, name, lang, pitch, rate, score }.
 */
export function castVoices(list) {
  const voices = Array.from(list || []).filter((v) => v && typeof v === 'object');
  const out = {};
  if (!voices.length) {
    for (const r of ROLES) out[r] = { voice: null, name: '', lang: 'en-US', ...prosodyFor(r, null), score: 0 };
    return out;
  }
  const top = {};
  for (const r of ROLES) {
    top[r] = voices.map((v, i) => ({ v, i, s: scoreVoice(r, v) }))
      .sort((a, b) => b.s - a.s || a.i - b.i).slice(0, 7);
  }
  let best = null, bestS = -Infinity;
  for (const b of top.brick) for (const l of top.ilsa) for (const m of top.mutter) {
    let s = b.s + l.s + m.s;
    if (b.v === l.v) s -= 45;
    if (l.v === m.v) s -= 45;
    if (b.v === m.v) s -= 60;       // two low male voices blur into one
    if (s > bestS) { bestS = s; best = { brick: b, ilsa: l, mutter: m }; }
  }
  for (const r of ROLES) {
    const c = best[r];
    out[r] = { voice: c.v, name: String(c.v.name || ''), lang: String(c.v.lang || 'en-US'),
      ...prosodyFor(r, c.v), score: +c.s.toFixed(1) };
  }
  // One voice for both men: spread them apart. On a man's voice Brick goes up
  // towards its own register and MUTTER down into the basement; on a woman's
  // (or one we cannot tell) Brick has to stay low, so MUTTER goes lower still
  // and leans on its slower rate.
  if (out.brick.voice === out.mutter.voice) {
    const male = out.brick.voice && voiceInfo(out.brick.voice).gender === 'm';
    if (male) {
      out.brick.pitch = Math.max(out.brick.pitch, 0.88);
      out.mutter.pitch = Math.min(out.mutter.pitch, 0.5);
    } else {
      out.brick.pitch = Math.min(out.brick.pitch, 0.64);
      out.mutter.pitch = Math.min(out.mutter.pitch, 0.4);
      out.mutter.rate = Math.min(out.mutter.rate, 0.84);
    }
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* THE ENGINE                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

/** Look for the Web Speech API without letting a sandboxed frame throw at us. */
export function detectSpeech(scope) {
  try {
    const w = scope || (typeof window !== 'undefined' ? window : globalThis);
    const synth = w.speechSynthesis;
    const Utterance = w.SpeechSynthesisUtterance;
    if (!synth || typeof synth.speak !== 'function' || typeof Utterance !== 'function') return null;
    return { synth, Utterance };
  } catch { return null; }
}

const VOICE_WAIT = 1.5;        // seconds to wait for a voice list before giving up
const DEAD_AIR = 2.6;          // seconds after speak() with no sign of life
const SLOW_START = 2.4;        // extra grace when the line is still queued at that point
const DEAD_STRIKES = 2;        // that many in a row and the API is written off
const RETRY_DEAD = 90;         // seconds before a written-off engine gets one more try
const RETRY_NET = 120;         // seconds before the network voices are tried again
// The formant under MUTTER, relative to its own level: about -20 dB, a hum of
// machinery under the words rather than a second reading of them.
const LAYER_VOL = 0.1;
// The formant synth as the main voice (ROBOT, fallback) talks a touch slower:
// its consonants are the weak point, and they scale with the rate.
const ROBOT_RATE = 0.93;

/**
 * Speech: the object main.js hands the game as `game.vox`. Same surface as the
 * formant Vox (say, sayLine, cancel, setVolume, busy, lastLine, lastRequested,
 * lastVoice), plus setMode()/mode/engine for the VOICE option and
 * attachFormant() because the formant synth needs an AudioContext that only
 * exists once audio has started.
 *
 * Options (all optional; tests use them to stand in for the browser):
 *   formant   a Vox, used for ROBOT mode, fallback, and MUTTER's undertone
 *   mode      'natural' | 'robot' | 'off'
 *   gain      () => number, multiplied into utterance volume (the master slider)
 *   api       { synth, Utterance } or null to force "no Web Speech API"
 *   now       () => seconds;  setTimeout / clearTimeout: timer functions
 *   layer     false to skip the formant undertone under MUTTER
 */
export class Speech {
  constructor(opts = {}) {
    const o = opts && typeof opts === 'object' ? opts : {};
    this.formant = o.formant || null;
    this.mode = VOICE_MODES.includes(o.mode) ? o.mode : 'natural';
    this._gain = typeof o.gain === 'function' ? o.gain : () => 1;
    this._layer = o.layer !== false;
    this._now = typeof o.now === 'function' ? o.now : defaultNow;
    this._setT = typeof o.setTimeout === 'function' ? o.setTimeout : defaultSetTimeout;
    this._clearT = typeof o.clearTimeout === 'function' ? o.clearTimeout : defaultClearTimeout;
    this._vol = 1;
    this._active = null;
    this._queue = [];
    this._voices = [];
    this.cast = castVoices([]);
    this._lastText = '';
    this._reqText = '';
    this._lastVoice = 'mutter';
    this._route = 'natural';
    this._strikes = 0;
    this._dead = false;
    this._deadAt = 0;
    this._netDown = false;
    this._netDownAt = 0;
    this._serial = 0;
    this._timers = new Set();
    this._born = this._now();
    this.clips = null;         // the recorded takes (acted.js), when there are any

    const api = 'api' in o ? o.api : detectSpeech();
    this.synth = (api && api.synth) || null;
    this.Utterance = (api && api.Utterance) || null;
    if (this.synth) {
      try {
        const onVoices = () => this._refreshVoices();
        if (typeof this.synth.addEventListener === 'function') {
          this.synth.addEventListener('voiceschanged', onVoices);
        } else if (!this.synth.onvoiceschanged) {
          this.synth.onvoiceschanged = onVoices;
        }
      } catch { /* polling in _refreshVoices covers it */ }
      this._refreshVoices();
    }
  }

  /* ---------------- setup ------------------------------------------------ */

  /**
   * The recorded takes arrive with the AudioContext too. From then on a line
   * that has a take is played from it, in NATURAL mode, and the browser voice
   * covers the rest.
   */
  attachClips(bank) {
    this.clips = bank && bank.size ? bank : null;
  }

  /** Takes are in use: NATURAL mode, and a pack wired into the audio graph. */
  _acted() {
    return !!(this.clips && this.clips.ready && this.mode === 'natural');
  }

  /** Is the recorded cast speaking, for the options page. */
  get acted() { return this._acted(); }

  /** Does this line key have a recorded take (false when takes are off). */
  hasTake(key) {
    return this._acted() && this.clips.has(key);
  }

  /**
   * Can these exact words be said in the voice the rest of the cast is using:
   * always without takes; with them, only if these words were recorded.
   */
  canVoice(role, text) {
    if (!this._acted()) return true;
    return !!this.clips.find(ROLES.includes(role) ? role : 'mutter', plainText(text));
  }

  /** The formant synth arrives once the AudioContext exists. */
  attachFormant(vox) {
    this.formant = vox || null;
    if (this.formant) { try { this.formant.setVolume(this._vol); } catch { /* ignore */ } }
  }

  /**
   * iOS will not let speechSynthesis make a sound until one utterance has been
   * started inside a user gesture. main.js calls this from the first click or
   * key press: a single silent space, which every other engine ignores.
   */
  unlock() {
    if (!this.synth || !this.Utterance || this._unlocked) return;
    this._unlocked = true;
    try {
      const u = new this.Utterance(' ');
      u.volume = 0;
      this._hold = u;           // keep a reference, or Chrome may never finish it
      this.synth.speak(u);
    } catch { /* a refusal here just means the fallback decides later */ }
  }

  setMode(mode) {
    if (!VOICE_MODES.includes(mode) || mode === this.mode) return;
    this.cancel();
    this.mode = mode;
  }

  _refreshVoices() {
    if (!this.synth) return;
    let list = [];
    try { list = Array.from(this.synth.getVoices() || []); } catch { list = []; }
    const sig = list.map((v) => v && v.name).join('|');
    if (sig === this._sig) return;
    const had = this._sig !== undefined && this._voices.length > 0;
    this._sig = sig;
    this._voices = list;
    // A new voice list is a new engine as far as we know (voices installed,
    // the network back, speech-dispatcher finally up): forgive the old one.
    if (had) { this._dead = false; this._strikes = 0; this._netDown = false; }
    this._recast();
  }

  /** Cast from the voice list, without the network voices once one has failed us. */
  _recast() {
    const usable = this._netDown ? this._voices.filter((v) => v && v.localService !== false) : this._voices;
    this.cast = castVoices(usable.length ? usable : this._voices);
  }

  /**
   * Which engine a line would use right now:
   *   natural  the browser voice          robot  the formant synth
   *   pending  waiting for a voice list   off    silence
   */
  get engine() {
    if (this.mode === 'off') return 'off';
    if (this.mode === 'robot') return this.formant ? 'robot' : 'off';
    if (this._dead && this._now() - this._deadAt > RETRY_DEAD) {
      // One more try, on probation: a single further failure writes it off again.
      this._dead = false;
      this._strikes = DEAD_STRIKES - 1;
    }
    if (this.synth && !this._dead) {
      if (!this._voices.length) this._refreshVoices();
      if (this._voices.length) return 'natural';
      if (this._now() - this._born < VOICE_WAIT) return 'pending';
    }
    return this.formant ? 'robot' : 'off';
  }

  /**
   * Why a NATURAL request is on the robot, for the options label:
   * '' (it is not), 'noapi', 'novoices' or 'silent' (voices exist but the
   * engine produced nothing).
   */
  get fallback() {
    if (this.mode !== 'natural') return '';
    const e = this.engine;
    if (e === 'natural' || e === 'pending') return '';
    if (!this.synth) return 'noapi';
    return this._dead ? 'silent' : 'novoices';
  }

  /** Who is voicing whom, for the options page and the diagnostics. */
  get casting() {
    const out = {};
    for (const r of ROLES) out[r] = this.cast[r] ? this.cast[r].name : '';
    return out;
  }

  /* ---------------- public API ------------------------------------------ */

  get busy() {
    this._pump();
    if (this._active) return true;
    try { return !!(this.formant && this._route === 'formant' && this.formant.busy); }
    catch { return false; }
  }

  /** The words of the line now playing, caption-ready. */
  get lastLine() {
    if (this._route === 'formant' && this.formant) {
      try { return plainText(this.formant.lastLine); } catch { return this._lastText; }
    }
    return this._lastText;
  }

  /** The words of the most recent request, spoken yet or not, caption-ready. */
  get lastRequested() { return this._reqText; }

  get lastVoice() {
    if (this._route === 'formant' && this.formant) {
      try { return this.formant.lastVoice || this._lastVoice; } catch { return this._lastVoice; }
    }
    return this._lastVoice;
  }

  setVolume(v) {
    this._vol = clamp(num(v, 1), 0, 4);
    if (this.formant) { try { this.formant.setVolume(this._vol); } catch { /* ignore */ } }
  }

  cancel() {
    this._queue.length = 0;
    const a = this._active;
    this._active = null;
    if (a) { a.dead = true; if (a.handle) a.handle.stop(); }
    for (const t of this._timers) { try { this._clearT(t); } catch { /* ignore */ } }
    this._timers.clear();
    if (this.synth) { try { this.synth.cancel(); } catch { /* ignore */ } }
    if (this.formant) { try { this.formant.cancel(); } catch { /* ignore */ } }
  }

  /**
   * Speak a canned line by key, exactly as the formant Vox does: the variant
   * is picked here, `%s` tokens are filled from opts.args left to right, and
   * the speaker comes from the key unless opts.voice says otherwise.
   */
  sayLine(key, opts = {}) {
    try {
      const o = opts && typeof opts === 'object' ? opts : {};
      // A recorded take of this line, when there is one: its words are the line.
      const take = this._acted() ? this.clips.pick(key, o) : null;
      if (take) return this.say(take.t, { ...o, voice: o.voice || voiceOf(key), take });
      let text = isNum(o.pick) ? pickLineAt(key, o.pick) : pickLine(key);
      if (!text) return 0;
      const args = o.args;
      if (args && args.length) {
        let k = 0;
        text = text.replace(/%s/g, () => (k < args.length ? String(args[k++]) : ''));
      }
      text = text.replace(/%s/g, '').replace(/\s{2,}/g, ' ').trim();
      return this.say(text, o.voice ? o : { ...o, voice: voiceOf(key) });
    } catch { return 0; }
  }

  /**
   * Speak. Returns the estimated duration in seconds, or 0 if nothing will be
   * said. Floor rules match the formant Vox: a higher priority cuts in, equal
   * or lower waits in a queue of at most two, and a stale line is dropped.
   * A queued line returns its estimate too; `opts.onStart` fires when it
   * really starts, on either engine, and never for a line that was dropped.
   */
  say(text, opts = {}) {
    try {
      if (text == null) return 0;
      const raw = String(text);
      const plain = plainText(raw);
      if (!plain) return 0;
      const o = opts && typeof opts === 'object' ? opts : {};
      this._reqText = plain;
      const eng = this.engine;
      if (eng === 'off') return 0;
      const take = this._acted() ? (o.take || this.clips.find(this._role(o), plain)) : null;
      if (take) return this._sayTake(take, raw, o);
      if (eng === 'robot' || (eng === 'pending' && this.formant)) return this._sayFormant(raw, o);

      this._pump();
      const prio = num(o.priority, 0);
      if (this._active) {
        if (prio > this._active.priority) {
          this._stopActive();
          this._queue = this._queue.filter((q) => q.priority >= prio || (dropped(q), false));
        } else {
          const est = this._estimate(raw, o);
          const item = { raw, opts: o, priority: prio, est };
          if (this._queue.length < 2) { this._queue.push(item); return est; }
          let worst = 0;
          for (let i = 1; i < this._queue.length; i++) {
            if (this._queue[i].priority < this._queue[worst].priority) worst = i;
          }
          if (prio > this._queue[worst].priority) { dropped(this._queue[worst]); this._queue[worst] = item; return est; }
          return 0;
        }
      }
      return this._speakNatural(raw, o, prio);
    } catch { return 0; }
  }

  /* ---------------- internals ------------------------------------------- */

  _role(o) { return ROLES.includes(o.voice) ? o.voice : 'mutter'; }

  _prosody(role, o) {
    const c = this.cast[role] || { pitch: 1, rate: 1 };
    const m = MOOD[o.mood] || MOOD.calm;
    // A little life per line, so a repeated bark is not a recording.
    const wob = 1 + (((this._serial * 0x9E3779B1) >>> 0) / 4294967296 - 0.5) * 0.05;
    const pitch = clamp(c.pitch * m.pitch * num(o.pitch, 1) * wob, 0.1, 2);
    const rate = clamp(c.rate * m.rate * num(o.rate, 1), 0.5, 2);
    return { pitch, rate };
  }

  _estimate(raw, o) {
    const role = this._role(o);
    const { rate } = this._prosody(role, o);
    return estimateSeconds(raw, rate);
  }

  _sayFormant(raw, o) {
    const f = this.formant;
    if (!f) return 0;
    this._route = 'formant';
    let d = 0;
    try { d = f.say(raw, { ...o, rate: num(o.rate, 1) * ROBOT_RATE }) || 0; } catch { d = 0; }
    if (d) this._lastVoice = this._role(o);
    return d;
  }

  _later(fn, ms) {
    let id = null;
    const run = () => { this._timers.delete(id); try { fn(); } catch { /* never throw from a timer */ } };
    try { id = this._setT(run, ms); this._timers.add(id); } catch { /* no timers: pump on demand */ }
    return id;
  }

  /** Retire the active line when it is done and start the next one waiting. */
  _pump() {
    const a = this._active;
    if (a) {
      const now = this._now();
      let speaking = false;
      if (!a.take && a.started && !a.ended && now < a.hardEnd) {
        try { speaking = !!this.synth.speaking; } catch { speaking = false; }
      }
      if (a.ended || (now >= a.endAt && !speaking)) this._active = null;
    }
    if (!this._active && this._queue.length) {
      let best = 0;
      for (let i = 1; i < this._queue.length; i++) {
        if (this._queue[i].priority > this._queue[best].priority) best = i;
      }
      // A take waits for a robot line to finish: the formant keeps its own
      // queue, and the two would otherwise talk over each other.
      if (this._queue[best].take && this._formantBusy()) { this._waitFormant(); return; }
      const item = this._queue.splice(best, 1)[0];
      if (item.take && this._acted()) this._playTake(item.take, item.raw, item.opts, item.priority);
      else if (this.engine === 'natural') this._speakNatural(item.raw, item.opts, item.priority);
      else if (this.formant) this._sayFormant(item.raw, item.opts);
    }
  }

  _formantBusy() {
    try { return !!(this.formant && this._route === 'formant' && this.formant.busy); }
    catch { return false; }
  }

  _waitFormant() {
    if (this._waiting) return;
    this._waiting = true;
    this._later(() => { this._waiting = false; this._pump(); }, 150);
  }

  /**
   * A recorded take, on the same floor as the browser voice: a higher
   * priority cuts in, equal or lower waits in a queue of at most two.
   */
  _sayTake(take, raw, o) {
    this._pump();
    const prio = num(o.priority, 0);
    const est = take.d;
    const robot = !this._active && this._formantBusy();
    if (this._active || robot) {
      const outranks = this._active ? prio > this._active.priority : prio > 0;
      if (outranks) {
        if (this._active) this._stopActive();
        else { try { this.formant.cancel(); } catch { /* ignore */ } }
        this._queue = this._queue.filter((q) => q.priority >= prio || (dropped(q), false));
      } else {
        const item = { raw, opts: o, priority: prio, est, take };
        if (this._queue.length < 2) {
          this._queue.push(item);
          if (robot) this._waitFormant();
          return est;
        }
        let worst = 0;
        for (let i = 1; i < this._queue.length; i++) {
          if (this._queue[i].priority < this._queue[worst].priority) worst = i;
        }
        if (prio > this._queue[worst].priority) {
          dropped(this._queue[worst]);
          this._queue[worst] = item;
          if (robot) this._waitFormant();
          return est;
        }
        return 0;
      }
    }
    return this._playTake(take, raw, o, prio);
  }

  _playTake(take, raw, o, prio) {
    this._serial++;
    const role = this._role(o);
    const now = this._now();
    const est = take.d;
    const a = {
      priority: prio, role, raw, est, opts: o, start: now, endAt: now + est + 0.25,
      hardEnd: now + est + 2, started: false, ended: false, dead: false,
      utts: [], layered: false, id: this._serial, take, handle: null,
    };
    if (this._prev && this._prev !== a) this._prev.dead = true;
    this._prev = a;
    this._active = a;
    this._route = 'take';
    this._lastText = plainText(raw);
    this._lastVoice = role;
    lineStarted(o, est);
    a.handle = this.clips.play(take, {
      vol: this._vol,
      onStart: () => { if (!a.dead) a.started = true; },
      onEnd: () => this._finish(a),
      onFail: () => {
        // The take would not play: say the words the way they would have
        // been said without it. Its start was already announced.
        if (a.dead || this._active !== a) return;
        a.dead = true;
        this._active = null;
        const rest = { ...o, onStart: null, take: null };
        if (this.engine === 'natural') this._speakNatural(raw, rest, prio);
        else if (this.formant) this._sayFormant(raw, rest);
      },
    });
    this._later(() => this._settle(a), Math.ceil(est * 1000) + 300);
    return est;
  }

  _stopActive() {
    const a = this._active;
    this._active = null;
    if (a) { a.dead = true; if (a.handle) a.handle.stop(); }
    try { this.synth.cancel(); } catch { /* ignore */ }
    if (a && a.layered && this.formant) { try { this.formant.cancel(); } catch { /* ignore */ } }
  }

  _finish(a) {
    if (a.ended) return;
    a.ended = true;
    if (this._active === a) {
      this._active = null;
      this._later(() => this._pump(), 30);
    }
  }

  _speakNatural(raw, o, prio) {
    const synth = this.synth, U = this.Utterance;
    if (!synth || !U) return 0;
    if (this._netDown && this._now() - this._netDownAt > RETRY_NET) {
      this._netDown = false;     // maybe the network is back; one failure puts it off again
      this._recast();
    }
    this._serial++;
    const role = this._role(o);
    const cast = this.cast[role] || {};
    const { pitch, rate } = this._prosody(role, o);
    const lang = cast.voice ? cast.lang : 'en-US';
    const chunks = splitChunks(deliver(role, ttsText(raw, lang)));
    if (!chunks.length) return 0;
    let est = 0;
    for (const c of chunks) est += estimateSeconds(c, rate);
    est = +est.toFixed(3);
    const vol = clamp(this._vol * clamp(num(this._gain(), 1), 0, 1), 0, 1);

    const now = this._now();
    const a = {
      priority: prio, role, raw, est, opts: o, start: now, endAt: now + est, voice: cast.voice || null,
      hardEnd: now + est * 1.7 + 1.5, started: false, ended: false, dead: false,
      utts: [], layered: false, id: this._serial,
    };
    // The previous line is over as far as we are concerned, even if the engine
    // is still finishing it: whatever it reports from here on (an error from
    // the cancel below, a late end) is not news about the engine's health.
    if (this._prev && this._prev !== a) this._prev.dead = true;
    this._prev = a;
    this._active = a;
    this._route = 'natural';
    this._lastText = plainText(raw);
    this._lastVoice = role;
    lineStarted(o, est);

    const fire = () => {
      if (a.dead || this._active !== a) return;
      chunks.forEach((text, i) => {
        if (a.dead) return;      // an earlier chunk was refused and the line handed on
        let u;
        try { u = new U(text); } catch { return; }
        try {
          if (cast.voice) u.voice = cast.voice;
          u.lang = lang;
          u.pitch = pitch; u.rate = rate; u.volume = vol;
        } catch { /* a read-only field is not worth losing the line over */ }
        u.onstart = () => {
          if (a.dead) return;
          a.started = true;
          this._strikes = 0;
          if (i === 0) this._undertone(a);
        };
        u.onend = () => { if (i === chunks.length - 1) this._finish(a); };
        u.onerror = (e) => {
          const why = String((e && e.error) || '');
          if (a.dead || why === 'interrupted' || why === 'canceled') return;
          this._strike(a);
        };
        a.utts.push(u);        // Chrome collects an unreferenced utterance and never ends it
        try { synth.speak(u); } catch { this._strike(a); }
      });
      // Chrome can leave the synth paused (another tab, a suspended page);
      // resume() is harmless when it is not.
      try { synth.resume(); } catch { /* ignore */ }
      this._later(() => this._watch(a), DEAD_AIR * 1000);
      this._keepAlive(a);
    };
    // A queue wedged in "pending" only clears with a cancel, and a speak() in
    // the same tick as a cancel is sometimes silently dropped, so wait a beat.
    let dirty = false;
    try { dirty = !!(synth.speaking || synth.pending); } catch { dirty = false; }
    if (dirty) {
      try { synth.cancel(); } catch { /* ignore */ }
      if (this._later(fire, 40) == null) fire();
    } else {
      fire();
    }
    this._later(() => this._settle(a), Math.ceil(est * 1000) + 60);
    return est;
  }

  /**
   * At the estimated end, retire the line and start the next; if the engine
   * is still audibly talking, look again shortly. Without this a queued line
   * would wait for somebody to ask whether we were busy.
   */
  _settle(a) {
    this._pump();
    if (this._active === a) this._later(() => this._settle(a), 350);
  }

  /** A slow resume() nudge while a line plays; Chrome sometimes stalls without it. */
  _keepAlive(a) {
    this._later(() => {
      if (a.dead || a.ended || this._active !== a) return;
      try { if (this.synth.paused) this.synth.resume(); } catch { /* ignore */ }
      this._keepAlive(a);
    }, 4000);
  }

  /**
   * No start event yet. Blink reports speaking from the moment speak() is
   * called, so there this only ever catches a truly wedged engine; Gecko and a
   * cold speech-dispatcher report nothing until audio starts, so a line still
   * sitting in the queue gets a second look before anyone is blamed.
   */
  _watch(a) {
    if (a.dead || a.started || a.ended) return;
    let speaking = false, pending = false;
    try { speaking = !!this.synth.speaking; pending = !!this.synth.pending; } catch { /* treat as silent */ }
    if (speaking) { a.started = true; return; }
    if (pending && !a.graced) {
      a.graced = true;
      this._later(() => this._watch(a), SLOW_START * 1000);
      return;
    }
    // Nothing queued, nothing playing, and the line has outlived its own
    // estimate: it may well have played on an engine that sends no events.
    // That is not evidence of anything, and a replay now would be late.
    if (!pending && this._now() >= a.endAt) { this._finish(a); return; }
    this._strike(a);
  }

  _strike(a) {
    if (a.struck) return;
    a.struck = true;
    const v = a.voice;
    const now = this._now();
    const hasLocal = this._voices.some((x) => x && x.localService !== false);
    let net = false;
    if (v && v.localService === false && !this._netDown && hasLocal) {
      // A network voice (Edge's Online set, Google's) failing means no
      // network, not no speech: the local voices still work. Recast onto
      // them, and do not hold it against the API.
      this._netDown = true;
      this._netDownAt = now;
      this._recast();
      net = true;
    } else {
      this._strikes++;
      if (this._strikes >= DEAD_STRIKES) { this._dead = true; this._deadAt = now; }
    }
    const free = !this._active || this._active === a;
    const wasDead = a.dead;
    a.dead = true;             // whatever this utterance reports from here on is stale
    this._finish(a);
    if (wasDead || !free) return;
    // The engine may yet wake up and start it: make sure it cannot, so the
    // replay below is never read twice over itself.
    try { this.synth.cancel(); } catch { /* ignore */ }
    // Say it anyway, if it is still fresh enough to matter: on a local voice
    // when only the network failed, otherwise on the formant synth.
    if (now >= a.endAt) return;
    if (net && this.engine === 'natural') this._speakNatural(a.raw, a.opts || { voice: a.role }, a.priority);
    else if (this.formant) this._sayFormant(a.raw, { ...(a.opts || {}), voice: a.role, priority: a.priority });
  }

  /**
   * MUTTER's own machinery, quietly under the natural voice: the formant synth
   * speaks the same line, stretched to the same length, well below it. It is
   * never quite in step, which is exactly what a building talking sounds like.
   */
  _undertone(a) {
    if (!this._layer || a.role !== 'mutter' || !this.formant) return;
    try {
      const probe = typeof this.formant._estimate === 'function'
        ? this.formant._estimate(a.raw, { voice: 'mutter' }) : 0;
      const fr = probe > 0 ? clamp(probe / Math.max(0.5, a.est - 0.3), 0.6, 1.8) : 1;
      this.formant.cancel();
      this.formant.say(a.raw, { voice: 'mutter', vol: LAYER_VOL, rate: fr, glitch: 0.12 });
      a.layered = true;
    } catch { /* the undertone is garnish */ }
  }
}

function defaultNow() {
  try { return performance.now() / 1000; } catch { return Date.now() / 1000; }
}
function defaultSetTimeout(fn, ms) { return setTimeout(fn, ms); }
function defaultClearTimeout(id) { clearTimeout(id); }

export default Speech;
