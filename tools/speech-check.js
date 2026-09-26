// speech-check.js - headless harness for src/audio/speech.js, the natural voice.
//
// There is no speechSynthesis in node, and headless Chromium has one with no
// voices, so the real browsers are stood in for by a mock synth that behaves
// like each of them: the voice lists Windows/Edge, Windows/Chrome, macOS,
// ChromeOS, Android and Linux actually report, voices that arrive late or
// never, an engine that never starts, one that never says it finished, one
// that throws. Time is a fake clock, so every timeout is exact.
//
//   node tools/speech-check.js
import fs from 'node:fs';
import {
  Speech, castVoices, voiceInfo, plainText, ttsText, splitChunks, estimateSeconds, deliver,
  detectSpeech, loadVoiceMode, saveVoiceMode, VOICE_MODES, ROLES,
} from '../src/audio/speech.js';
import { LINES, PHONE_SET, textToPhonemes, voiceOf } from '../src/audio/vox.js';
import { Radio, SPEAKERS } from '../src/game/story.js';

let pass = 0, fail = 0;
const results = [];
function check(name, ok, extra = '') {
  if (ok) pass++; else fail++;
  results.push(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `   (${extra})` : ''}`);
}

/* ─────────────────────────── fake clock ─────────────────────────── */

function makeClock() {
  let t = 100, seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: t + Math.max(0, ms) / 1000, fn }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    advance(sec) {
      const end = t + sec;
      for (;;) {
        let nextId = null, next = null;
        for (const [id, tm] of timers) if (tm.at <= end && (!next || tm.at < next.at)) { next = tm; nextId = id; }
        if (!next) break;
        timers.delete(nextId);
        t = Math.max(t, next.at);
        next.fn();
      }
      t = end;
    },
    pending: () => timers.size,
  };
}

/* ─────────────────────────── mock speechSynthesis ─────────────────────────── */

class MockUtterance {
  constructor(text) {
    this.text = text; this.voice = null; this.lang = ''; this.pitch = 1; this.rate = 1; this.volume = 1;
    this.onstart = null; this.onend = null; this.onerror = null;
  }
}

/**
 * behaviour: { voices, voicesAt (sec after construction, or Infinity), noStart,
 * noEnd, speed (actual seconds per estimated second), throwSpeak, pendingStuck }
 */
function makeSynth(clock, behaviour = {}) {
  const b = { voices: [], voicesAt: 0, speed: 0.8, ...behaviour };
  const born = clock.now();
  const listeners = [];
  const s = {
    spoken: [], cancels: 0, resumes: 0, queue: [], speaking: false, pending: !!b.pendingStuck, paused: false,
    getVoices() { return clock.now() - born >= b.voicesAt ? b.voices.slice() : []; },
    addEventListener(type, fn) { if (type === 'voiceschanged') listeners.push(fn); },
    speak(u) {
      if (b.throwSpeak) throw new Error('not allowed');
      s.spoken.push(u);
      s.queue.push(u);
      if (!s.speaking) s._next();
    },
    _next() {
      const u = s.queue.shift();
      if (!u) { s.speaking = false; return; }
      if (b.noStart) { s.pending = true; return; }
      s.speaking = true; s.pending = false;
      const dur = estimateSeconds(u.text, u.rate) * b.speed;
      clock.setTimeout(() => {
        if (s.current !== u) return;
        u.onstart && u.onstart({ type: 'start' });
        clock.setTimeout(() => {
          if (s.current !== u) return;
          s.current = null;
          if (!b.noEnd) u.onend && u.onend({ type: 'end' });
          s._next();
        }, dur * 1000);
      }, 30);
      s.current = u;
    },
    cancel() {
      s.cancels++;
      const q = [s.current, ...s.queue].filter(Boolean);
      s.queue.length = 0; s.current = null; s.speaking = false; s.pending = false;
      for (const u of q) u.onerror && u.onerror({ error: 'interrupted' });
    },
    pause() { s.paused = true; },
    resume() { s.resumes++; s.paused = false; },
    fireVoicesChanged() { for (const f of listeners) f(); },
  };
  return s;
}

/** A formant Vox stand-in that records what it was asked to say. */
function makeFormant(clock) {
  const f = {
    said: [], cancels: 0, vol: 1, _end: 0, lastLine: '', lastVoice: 'mutter',
    say(text, o = {}) { const d = 1 + String(text).length * 0.05; f.said.push({ text, o }); f.lastLine = text; f.lastVoice = o.voice || 'mutter'; f._end = clock.now() + d; return d; },
    sayLine(key, o) { return f.say(key, o); },
    cancel() { f.cancels++; f._end = 0; },
    setVolume(v) { f.vol = v; },
    get busy() { return clock.now() < f._end; },
    _estimate(text) { return 1 + String(text).length * 0.05; },
  };
  return f;
}

/* ─────────────────────────── voice lists ─────────────────────────── */

const V = (name, lang, extra = {}) => ({ name, lang, voiceURI: name, localService: true, default: false, ...extra });
const PLATFORMS = {
  'Windows / Edge': [
    V('Microsoft David - English (United States)', 'en-US', { default: true }),
    V('Microsoft Mark - English (United States)', 'en-US'),
    V('Microsoft Zira - English (United States)', 'en-US'),
    V('Microsoft Aria Online (Natural) - English (United States)', 'en-US', { localService: false }),
    V('Microsoft Jenny Online (Natural) - English (United States)', 'en-US', { localService: false }),
    V('Microsoft Guy Online (Natural) - English (United States)', 'en-US', { localService: false }),
    V('Microsoft Davis Online (Natural) - English (United States)', 'en-US', { localService: false }),
    V('Microsoft Christopher Online (Natural) - English (United States)', 'en-US', { localService: false }),
    V('Microsoft Eric Online (Natural) - English (United States)', 'en-US', { localService: false }),
    V('Microsoft Ryan Online (Natural) - English (United Kingdom)', 'en-GB', { localService: false }),
    V('Microsoft Sonia Online (Natural) - English (United Kingdom)', 'en-GB', { localService: false }),
    V('Microsoft Katja Online (Natural) - German (Germany)', 'de-DE', { localService: false }),
    V('Microsoft Conrad Online (Natural) - German (Germany)', 'de-DE', { localService: false }),
    V('Microsoft Denise Online (Natural) - French (France)', 'fr-FR', { localService: false }),
  ],
  'Windows / Chrome': [
    V('Microsoft David - English (United States)', 'en-US', { default: true }),
    V('Microsoft Mark - English (United States)', 'en-US'),
    V('Microsoft Zira - English (United States)', 'en-US'),
    V('Google Deutsch', 'de-DE', { localService: false }),
    V('Google US English', 'en-US', { localService: false }),
    V('Google UK English Female', 'en-GB', { localService: false }),
    V('Google UK English Male', 'en-GB', { localService: false }),
    V('Google español', 'es-ES', { localService: false }),
    V('Google français', 'fr-FR', { localService: false }),
  ],
  'Windows / bare SAPI': [
    V('Microsoft David Desktop - English (United States)', 'en-US', { default: true }),
    V('Microsoft Zira Desktop - English (United States)', 'en-US'),
  ],
  'macOS / Safari': [
    V('Alex', 'en-US', { default: true }), V('Daniel', 'en-GB'), V('Fred', 'en-US'),
    V('Samantha', 'en-US'), V('Karen', 'en-AU'), V('Moira', 'en-IE'), V('Tessa', 'en-ZA'),
    V('Anna', 'de-DE'), V('Markus', 'de-DE'), V('Zarvox', 'en-US'), V('Albert', 'en-US'),
    V('Bad News', 'en-US'), V('Good News', 'en-US'), V('Bells', 'en-US'), V('Whisper', 'en-US'),
    V('Thomas', 'fr-FR'), V('Amélie', 'fr-CA'),
  ],
  'macOS / Chrome': [
    V('Alex', 'en-US', { default: true }), V('Daniel', 'en-GB'), V('Fred', 'en-US'),
    V('Samantha', 'en-US'), V('Anna', 'de-DE'), V('Zarvox', 'en-US'), V('Trinoids', 'en-US'),
    V('Google Deutsch', 'de-DE', { localService: false }), V('Google US English', 'en-US', { localService: false }),
    V('Google UK English Female', 'en-GB', { localService: false }),
    V('Google UK English Male', 'en-GB', { localService: false }),
  ],
  'iOS / Safari': [
    V('Samantha', 'en-US', { default: true }), V('Daniel', 'en-GB'), V('Arthur', 'en-GB'),
    V('Aaron', 'en-US'), V('Nicky', 'en-US'), V('Anna', 'de-DE'), V('Martin', 'de-DE'),
    V('Fred', 'en-US'), V('Rocko', 'en-US'), V('Grandpa', 'en-US'),
  ],
  'ChromeOS': [
    V('Google US English', 'en-US', { localService: false, default: true }),
    V('Google UK English Female', 'en-GB', { localService: false }),
    V('Google UK English Male', 'en-GB', { localService: false }),
    V('Google Deutsch', 'de-DE', { localService: false }),
    V('Chrome OS US English 1', 'en-US'), V('Chrome OS UK English 1', 'en-GB'),
  ],
  'Android / Chrome': [
    V('English United States', 'en-US', { default: true }), V('English United Kingdom', 'en-GB'),
    V('English India', 'en-IN'), V('Deutsch Deutschland', 'de-DE'), V('français France', 'fr-FR'),
  ],
  'Linux / espeak-ng': [
    V('English (America) espeak-ng', 'en-US', { default: true }), V('English (Great Britain) espeak-ng', 'en-GB'),
    V('German espeak-ng', 'de'), V('French (France) espeak-ng', 'fr'),
  ],
};

/* 1. casting per platform */
{
  const cast = {};
  for (const [plat, list] of Object.entries(PLATFORMS)) cast[plat] = castVoices(list);
  const nm = (plat, r) => cast[plat][r].name;
  const show = (plat) => ROLES.map((r) => `${r}=${nm(plat, r)} p${cast[plat][r].pitch.toFixed(2)}`).join(', ');

  check('Edge: Brick is a natural US man (Davis or Guy)', /Davis|Guy/.test(nm('Windows / Edge', 'brick')), show('Windows / Edge'));
  check('Edge: Ilsa is a German woman (Katja)', /Katja/.test(nm('Windows / Edge', 'ilsa')));
  check('Edge: MUTTER is the British natural man (Ryan)', /Ryan/.test(nm('Windows / Edge', 'mutter')));
  check('Windows Chrome: Brick is an American man', /David|Mark/.test(nm('Windows / Chrome', 'brick')), show('Windows / Chrome'));
  check('Windows Chrome: Ilsa is Google Deutsch', /Google Deutsch/.test(nm('Windows / Chrome', 'ilsa')));
  check('Windows Chrome: MUTTER is Google UK English Male', /UK English Male/.test(nm('Windows / Chrome', 'mutter')));
  check('bare SAPI: Brick David, Ilsa Zira', /David/.test(nm('Windows / bare SAPI', 'brick')) && /Zira/.test(nm('Windows / bare SAPI', 'ilsa')),
    show('Windows / bare SAPI'));
  {
    const c = cast['Windows / bare SAPI'];
    // Two voices for three parts: someone doubles, but never in the same register.
    const pairs = [['brick', 'mutter'], ['ilsa', 'mutter'], ['brick', 'ilsa']];
    const blurred = pairs.filter(([a, b]) => c[a].voice === c[b].voice && Math.abs(c[a].pitch - c[b].pitch) < 0.2);
    check('bare SAPI: a doubled voice is pitched well apart', blurred.length === 0, show('Windows / bare SAPI'));
  }
  check('macOS Safari: Brick Alex, Ilsa Anna, MUTTER Daniel',
    nm('macOS / Safari', 'brick') === 'Alex' && nm('macOS / Safari', 'ilsa') === 'Anna' && nm('macOS / Safari', 'mutter') === 'Daniel',
    show('macOS / Safari'));
  check('macOS Chrome: Ilsa German, Brick Alex', /Anna|Deutsch/.test(nm('macOS / Chrome', 'ilsa')) && nm('macOS / Chrome', 'brick') === 'Alex',
    show('macOS / Chrome'));
  check('iOS: Brick is Aaron (a man), Ilsa Anna', nm('iOS / Safari', 'brick') === 'Aaron' && nm('iOS / Safari', 'ilsa') === 'Anna',
    show('iOS / Safari'));
  check('ChromeOS: Ilsa Google Deutsch and nobody triples up',
    /Deutsch/.test(nm('ChromeOS', 'ilsa')) && new Set(ROLES.map((r) => nm('ChromeOS', r))).size >= 2, show('ChromeOS'));
  check('Android (no gender in names): Ilsa German, Brick en-US, MUTTER en-GB',
    /Deutsch/.test(nm('Android / Chrome', 'ilsa')) && cast['Android / Chrome'].brick.lang === 'en-US' &&
    cast['Android / Chrome'].mutter.lang === 'en-GB', show('Android / Chrome'));
  check('Linux espeak: Ilsa gets the German voice, all three distinct',
    /German/.test(nm('Linux / espeak-ng', 'ilsa')) && new Set(ROLES.map((r) => nm('Linux / espeak-ng', r))).size === 3,
    show('Linux / espeak-ng'));
  let novelty = [];
  for (const [plat, c] of Object.entries(cast)) {
    for (const r of ROLES) if (/Bad News|Good News|Bells|Whisper|Albert|Trinoids/.test(c[r].name)) novelty.push(`${plat}:${r}`);
  }
  check('novelty voices (Bells, Bad News...) are never cast', novelty.length === 0, novelty.join(','));
  let distinct = [];
  for (const [plat, c] of Object.entries(cast)) {
    const n = new Set(ROLES.map((r) => c[r].voice)).size;
    if (PLATFORMS[plat].length >= 3 && n < 3 && plat !== 'ChromeOS') distinct.push(plat);
  }
  check('three distinct voices wherever three plausible ones exist', distinct.length === 0, distinct.join(','));
  const pitchOrder = Object.entries(cast).filter(([, c]) =>
    !(c.mutter.pitch < c.brick.pitch + 0.001 || c.mutter.voice !== c.brick.voice));
  check('MUTTER sits lowest when it shares a register with Brick', pitchOrder.length === 0);
  const pitchesOk = Object.values(cast).every((c) => ROLES.every((r) => c[r].pitch > 0 && c[r].pitch <= 2 && c[r].rate >= 0.5 && c[r].rate <= 2));
  check('every cast pitch and rate is inside the Web Speech range', pitchesOk);
  const empty = castVoices([]);
  check('an empty voice list casts nobody without throwing', ROLES.every((r) => empty[r].voice === null));
  check('voiceInfo reads gender off Google UK English Female correctly', voiceInfo(V('Google UK English Female', 'en-GB')).gender === 'f');
  check('voiceInfo reads gender off Google UK English Male correctly', voiceInfo(V('Google UK English Male', 'en-GB')).gender === 'm');
}

/* 2. text: nothing with braces or ARPAbet ever reaches a caption or a voice */
{
  const PH = new Set(PHONE_SET);
  const arpabet = (s) => {
    if (/[{}|]/.test(s)) return 'brace';
    if (/\b[A-Z]{1,2}[012]\b/.test(s)) return 'stress digit';
    // two or more bare phone codes in a row is ARPAbet, not English
    const toks = s.split(/\s+/);
    for (let i = 0; i + 1 < toks.length; i++) {
      if (PH.has(toks[i]) && PH.has(toks[i + 1]) && toks[i].length <= 2 && toks[i + 1].length <= 2 &&
        /^[A-Z]+$/.test(toks[i]) && /^[A-Z]+$/.test(toks[i + 1])) return `phones "${toks[i]} ${toks[i + 1]}"`;
    }
    if (/%s/.test(s)) return 'token';
    return '';
  };
  const bad = [];
  let n = 0;
  for (const k of Object.keys(LINES)) {
    for (const raw of (Array.isArray(LINES[k]) ? LINES[k] : [LINES[k]])) {
      const s = raw.replace(/%s/g, 'LOW SABBATH');
      for (const [what, out] of [['caption', plainText(s)], ['tts-en', ttsText(s, 'en-US')], ['tts-de', ttsText(s, 'de-DE')]]) {
        n++;
        const why = arpabet(out);
        if (why) bad.push(`${k}/${what}: ${why}`);
        if (!out.trim()) bad.push(`${k}/${what}: empty`);
      }
    }
  }
  check(`no caption or TTS text has braces, ARPAbet or tokens (${n} renderings)`, bad.length === 0, bad.slice(0, 4).join(' | '));

  check('{Word|PHONES} captions as the word',
    plainText('Bunker {Sieben|S IY1 B AH N} is fine.') === 'Bunker Sieben is fine.');
  check('legacy {PHONES} is dropped cleanly',
    plainText('Logged under {W EH1 DH ER0}.') === 'Logged under.' &&
    plainText('Bunker {S IY1 B AH N} is fine.') === 'Bunker is fine.', plainText('Logged under {W EH1 DH ER0}.'));
  check('English voices get respellings, the German voice the original',
    /Zeeben/.test(ttsText('Bunker {Sieben|S IY1 B AH N}.', 'en-GB')) && /Sieben/.test(ttsText('Bunker {Sieben|S IY1 B AH N}.', 'de-DE')));
  check('names in capitals are not spelled out letter by letter',
    ttsText('LOW SABBATH is gone.', 'en-US') === 'Low Sabbath is gone.' && ttsText('SAINT ERROL', 'en-US') === 'Saint Errol');
  const ph = textToPhonemes('Bunker {Sieben|S IY1 B AH N}').map((p) => p.p + (p.st || '')).join(' ');
  check('the formant synth reads the phones after the pipe', /S IY1 B AH N/.test(ph) && !/SIEBEN/.test(ph), ph);
  check('Brick barks his short lines, MUTTER never exclaims, Ilsa is left alone',
    deliver('brick', 'Get bent.') === 'Get bent!' && deliver('brick', 'You want some?') === 'You want some?' &&
    deliver('mutter', 'Wonderful!') === 'Wonderful.' && deliver('ilsa', 'Watch the ceiling.') === 'Watch the ceiling.');
  check('profanity goes through untouched',
    ttsText('Well, shit. Eat lead, you ugly son of a bitch.', 'en-US') === 'Well, shit. Eat lead, you ugly son of a bitch.');

  const long = 'Warden. ' + 'This sentence is here to be long enough to matter. '.repeat(8);
  const chunks = splitChunks(long);
  check('long text splits into pieces under the Chrome cut-off', chunks.length > 1 && chunks.every((c) => c.length <= 170),
    chunks.map((c) => c.length).join(','));
  check('splitting loses no words', chunks.join(' ').replace(/\s+/g, ' ') === long.trim().replace(/\s+/g, ' '));
  const giant = splitChunks('x'.repeat(400));
  check('an unbreakable run is still split and nothing lost', giant.join('').length === 400 && giant.every((c) => c.length <= 170));

  const d1 = estimateSeconds('Get bent.'), d2 = estimateSeconds(LINES.ilsa_intro ? [].concat(LINES.ilsa_intro)[0] : 'x '.repeat(40));
  check('estimates are positive and grow with length', d1 > 0.5 && d2 > d1 * 3, `${d1}s / ${d2}s`);
  check('a slower rate means a longer estimate', estimateSeconds('Please remain calm.', 0.8) > estimateSeconds('Please remain calm.', 1.2));
  check('empty text estimates to zero', estimateSeconds('') === 0 && estimateSeconds('{S IY1}') === 0);
}

/* 3. the engine against each platform's mock */
function rig(plat, behaviour = {}, opts = {}) {
  const clock = makeClock();
  const synth = makeSynth(clock, { voices: PLATFORMS[plat] || [], ...behaviour });
  const formant = opts.noFormant ? null : makeFormant(clock);
  const sp = new Speech({ api: behaviour.noApi ? null : { synth, Utterance: MockUtterance }, formant,
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, gain: opts.gain, mode: opts.mode });
  return { clock, synth, formant, sp };
}

{
  const { clock, synth, sp } = rig('Windows / Edge');
  check('Edge: engine is natural straight away', sp.engine === 'natural');
  const d = sp.sayLine('brick_boot');
  const u = synth.spoken[0];
  check('sayLine returns a duration > 0 and speaks', d > 0 && !!u, String(d));
  check('Brick is spoken by his cast voice with his prosody', u && u.voice === sp.cast.brick.voice && u.pitch < 0.9 && u.rate > 1,
    u ? `${u.voice && u.voice.name} p${u.pitch.toFixed(2)} r${u.rate.toFixed(2)}` : '');
  check('lastVoice / lastLine / lastRequested report the line', sp.lastVoice === 'brick' && sp.lastLine && sp.lastRequested === sp.lastLine);
  check('busy while speaking', sp.busy === true);
  clock.advance(d + 0.5);
  check('not busy after the line ends', sp.busy === false);

  // Every line in the script, through the engine: nothing spoken has braces.
  const leaks = [];
  let spokeAll = 0;
  for (const k of Object.keys(LINES)) {
    sp.cancel();
    const dd = sp.sayLine(k, { args: ['LOW SABBATH', '4'] });
    clock.advance(0.1);
    if (dd > 0) spokeAll++;
    for (const uu of synth.spoken.slice(-4)) if (/[{}|]|\b[A-Z]{1,2}[012]\b|%s/.test(uu.text)) leaks.push(k);
    if (/[{}|]|%s/.test(sp.lastLine)) leaks.push(k + '(caption)');
  }
  check(`every LINES key speaks with a positive duration (${spokeAll}/${Object.keys(LINES).length})`, spokeAll === Object.keys(LINES).length);
  check('no spoken utterance or caption carries braces, ARPAbet or %s', leaks.length === 0, [...new Set(leaks)].slice(0, 5).join(','));
  const voicesUsed = new Set(synth.spoken.map((x) => x.voice && x.voice.name));
  check('all three cast voices get used across the script', voicesUsed.size >= 3, [...voicesUsed].join(' / '));
  sp.cancel();
}

{
  // args substitution before speaking
  const { synth, sp } = rig('Windows / Chrome');
  sp.sayLine('city_lost', { args: ['ASHGROVE', '5'] });
  const t = synth.spoken.map((u) => u.text).join(' ');
  check('args are substituted before speaking', /Ashgrove/.test(t) && !/%s/.test(t) && /\b5\b|five/i.test(t), t.slice(0, 70));
}

{
  // queue and priority, as the formant Vox does it
  const { clock, synth, sp } = rig('macOS / Safari');
  const a = sp.say('First line, spoken now.', { voice: 'mutter' });
  const b = sp.say('Second line, waits its turn.', { voice: 'ilsa' });
  check('an equal-priority line queues instead of cutting in', a > 0 && b > 0 && synth.spoken.length === 1 && synth.cancels === 0);
  sp.say('Third.', { voice: 'brick' });
  const dropped = sp.say('Fourth, nobody wants this.', { voice: 'brick' });
  check('the queue holds at most two; a stale fourth is dropped', dropped === 0);
  clock.advance(a + 1);
  check('the queued line starts when the first ends', synth.spoken.some((u) => /Second line/.test(u.text)));
  const c = sp.say('Urgent. Incoming.', { voice: 'ilsa', priority: 5 });
  check('a higher priority cuts in (cancel, then speak)', c > 0 && synth.cancels >= 1);
  clock.advance(0.1);
  check('...and is what is speaking', /Urgent/.test(synth.spoken[synth.spoken.length - 1].text));
  clock.advance(20);
  check('the queue drains to idle', sp.busy === false);
}

{
  // honest durations: onend clears early, a missing onend is bounded
  const { clock, sp } = rig('macOS / Safari', { speed: 0.5 });
  const d = sp.say('A sentence of ordinary length for timing.', { voice: 'brick' });
  clock.advance(d * 0.5 + 0.2);
  check('onend clears busy before the estimate runs out', sp.busy === false);
  const r2 = rig('macOS / Safari', { noEnd: true, speed: 1 });
  const d2 = r2.sp.say('A sentence of ordinary length for timing.', { voice: 'brick' });
  r2.clock.advance(d2 + 0.2);
  check('with no onend, busy still ends when the engine goes quiet', r2.sp.busy === false);
  const r3 = rig('macOS / Safari', { noEnd: true, speed: 50 });
  const d3 = r3.sp.say('A sentence of ordinary length for timing.', { voice: 'brick' });
  r3.clock.advance(d3 * 1.7 + 2);
  check('an engine that talks forever is cut loose at a hard limit', r3.sp.busy === false);
}

{
  // Chrome quirks
  const { clock, synth, sp } = rig('Windows / Chrome', { pendingStuck: true });
  sp.say('Stuck queue test.', { voice: 'ilsa' });
  check('a wedged "pending" queue is cancelled before speaking', synth.cancels === 1 && synth.spoken.length === 0);
  clock.advance(0.1);
  check('...and the line is spoken a beat later', synth.spoken.length === 1);
  const r = rig('Windows / Chrome');
  const long = 'Warden. ' + 'This is a very long transmission that goes on and on. '.repeat(9);
  const dl = r.sp.say(long, { voice: 'ilsa' });
  check('a long line is sent as several utterances', r.synth.spoken.length > 1 && r.synth.spoken.every((u) => u.text.length <= 170),
    `${r.synth.spoken.length} pieces`);
  r.synth.paused = true;
  r.clock.advance(4.5);
  check('a paused synth gets a resume() keepalive', r.synth.resumes >= 2 && r.synth.paused === false);
  r.clock.advance(dl + 2);
  check('the long line ends with the last piece', r.sp.busy === false);
}

{
  // volume
  const { synth, sp } = rig('Windows / Edge', {}, { gain: () => 0.5 });
  sp.setVolume(0.8);
  sp.say('Volume check.', { voice: 'brick' });
  check('utterance volume is the voice slider times the master slider', Math.abs(synth.spoken[0].volume - 0.4) < 1e-9, String(synth.spoken[0].volume));
}

{
  // MUTTER's formant undertone
  const { clock, formant, sp } = rig('Windows / Edge');
  sp.say('Good morning. The bunker is operating normally.', { voice: 'mutter' });
  clock.advance(0.2);
  const u = formant.said[0];
  check('MUTTER gets the formant synth quietly underneath', !!u && u.o.voice === 'mutter' && u.o.vol < 0.5, u ? `vol ${u.o.vol} rate ${u.o.rate.toFixed(2)}` : 'none');
  sp.cancel();
  formant.said.length = 0;
  sp.say('No robot under me, chief.', { voice: 'brick' });
  clock.advance(0.2);
  check('Brick and Ilsa do not', formant.said.length === 0);
  check('cancel() also silences the undertone', formant.cancels >= 1);
}

/* 4. fallback to the formant synth */
{
  const r = rig('Windows / Edge', { noApi: true });
  check('no Web Speech API: engine is robot', r.sp.engine === 'robot');
  const d = r.sp.sayLine('boot');
  check('...and lines go to the formant synth with a duration', d > 0 && r.formant.said.length === 1);
  check('...captioned without braces', !/[{}]/.test(r.sp.lastLine) && !!r.sp.lastLine, r.sp.lastLine);
}
{
  const hostile = {};
  Object.defineProperty(hostile, 'speechSynthesis', { get() { throw new Error('SecurityError: sandboxed'); } });
  check('a speechSynthesis getter that throws is caught', detectSpeech(hostile) === null);
  check('a scope with no speech API is detected as none', detectSpeech({}) === null);
  const clock = makeClock();
  const formant = makeFormant(clock);
  let threw = false, sp = null;
  const savedWin = globalThis.window;
  try {
    globalThis.window = hostile;
    sp = new Speech({ formant, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  } catch { threw = true; }
  if (savedWin === undefined) delete globalThis.window; else globalThis.window = savedWin;
  check('constructing Speech in a hostile frame does not throw, and falls back', !threw && sp && sp.engine === 'robot');
}
{
  const r = rig('Linux / espeak-ng', { voices: [] });
  check('no voices yet: engine is pending', r.sp.engine === 'pending');
  r.sp.say('Early line.', { voice: 'mutter' });
  check('a line during the wait goes to the formant synth', r.formant.said.length === 1 && r.synth.spoken.length === 0);
  r.clock.advance(1.6);
  check('still no voices after 1.5 s: the formant synth takes over', r.sp.engine === 'robot');
  const d = r.sp.say('Later line.', { voice: 'ilsa' });
  check('...and speaks with a duration', d > 0 && r.formant.said.length === 2);
}
{
  const r = rig('macOS / Chrome', { voicesAt: 0.4 });
  check('Chrome-style late voice list: pending at first', r.sp.engine === 'pending');
  r.clock.advance(0.5);
  r.synth.fireVoicesChanged();
  check('voiceschanged brings the natural voice in and casts it', r.sp.engine === 'natural' && r.sp.cast.brick.name === 'Alex');
  const r2 = rig('macOS / Chrome', { voicesAt: 3 });
  r2.clock.advance(1.6);
  check('voices that arrive after the deadline still win it back', r2.sp.engine === 'robot');
  r2.clock.advance(2);
  r2.synth.fireVoicesChanged();
  check('...once they do', r2.sp.engine === 'natural');
}
{
  const r = rig('Windows / Chrome', { noStart: true });
  const d = r.sp.say('Can anybody hear me?', { voice: 'ilsa' });
  r.clock.advance(3);
  check('dead air: the lost line is replayed on the formant synth', d > 0 && r.formant.said.length === 1 && r.sp.engine === 'natural');
  r.sp.say('Hello?', { voice: 'ilsa' });
  r.clock.advance(3);
  check('a second silent line writes the API off for good', r.sp.engine === 'robot');
  const n = r.synth.spoken.length;
  r.sp.say('Now what.', { voice: 'brick' });
  check('...after which nothing more is sent to it', r.synth.spoken.length === n && r.formant.said.length === 3);
}
{
  const r = rig('Windows / Chrome', { throwSpeak: true });
  let threw = false, d = 0;
  try { d = r.sp.say('Speak throws.', { voice: 'brick' }); } catch { threw = true; }
  check('a speak() that throws is contained and handed to the formant synth', !threw && d > 0 && r.formant.said.length === 1);
}
{
  const r = rig('Windows / Chrome', { noApi: true }, { noFormant: true });
  let ok = true;
  try {
    ok = r.sp.say('hello') === 0 && r.sp.sayLine('boot') === 0 && r.sp.busy === false && r.sp.engine === 'off';
    r.sp.cancel(); r.sp.setVolume(NaN); r.sp.setVolume('loud');
  } catch { ok = false; }
  check('no API and no formant synth: silent, zero durations, never throws', ok);
}

/* 5. modes and the setting */
{
  const r = rig('Windows / Edge', {}, { mode: 'robot' });
  r.sp.say('Robot on purpose.', { voice: 'brick' });
  check('ROBOT uses the formant synth even with voices available', r.formant.said.length === 1 && r.synth.spoken.length === 0);
  r.sp.setMode('off');
  check('OFF says nothing and returns 0', r.sp.say('Quiet.', { voice: 'brick' }) === 0 && r.synth.spoken.length === 0 && r.formant.said.length === 1);
  r.sp.setMode('natural');
  r.sp.say('Natural again.', { voice: 'brick' });
  check('NATURAL switches back', r.synth.spoken.length === 1);
  r.sp.setMode('robot');
  check('changing mode cancels whatever was speaking', r.synth.cancels >= 1 && r.sp.busy === false);
  let junk = true;
  try { r.sp.setMode('loud'); junk = r.sp.mode === 'robot'; } catch { junk = false; }
  check('an unknown mode is ignored', junk);

  const store = new Map();
  globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
  check('default VOICE is NATURAL', loadVoiceMode() === 'natural');
  saveVoiceMode('robot');
  check('VOICE persists', loadVoiceMode() === 'robot');
  saveVoiceMode('garbage');
  check('junk is not persisted', loadVoiceMode() === 'robot');
  globalThis.localStorage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  let ok = true;
  try { saveVoiceMode('off'); ok = loadVoiceMode() === 'natural'; } catch { ok = false; }
  delete globalThis.localStorage;
  check('storage that throws falls back to NATURAL', ok);
  check('three modes', VOICE_MODES.join(',') === 'natural,robot,off');
}
{
  const r = rig('iOS / Safari');
  r.sp.unlock();
  r.sp.unlock();
  check('unlock() speaks one silent utterance, once', r.synth.spoken.length === 1 && r.synth.spoken[0].volume === 0);
}

/* 6. pause: the radio stops the voice and keeps the line */
{
  const { clock, synth, sp } = rig('Windows / Edge');
  const game = {
    vox: sp, rng: Math.random, lastSpoken: null,
    sfxLog: [],
    sound: { sfx(n) { game.sfxLog.push(n); }, duck() {} },
    speakAs(voice, key, text) { const d = sp.say(text, { voice }); this.lastSpoken = { voice, text: sp.lastRequested }; return d; },
  };
  const radio = new Radio(game);
  radio.say('ilsa', 'ilsa_level2', 'The pipe gallery is full of them. Watch the ceiling, Hardigan.');
  radio.update(1 / 60);
  clock.advance(0.3);
  check('the radio line is speaking', sp.busy && !!radio.current);
  const cancels = synth.cancels;
  radio.hold();
  check('pausing cancels the speech', synth.cancels > cancels && sp.busy === false && !radio.current);
  check('...and puts the interrupted line back at the front', radio.queue.length === 1 && /pipe gallery/.test(radio.queue[0].text));
  for (let i = 0; i < 60; i++) radio.update(1 / 60);
  check('resuming says it again', /pipe gallery/.test(synth.spoken[synth.spoken.length - 1].text));
  radio.reset();
  check('a level transition (radio.reset) cancels speech', sp.busy === false && radio.queue.length === 0);

  // Ilsa on a natural voice gets radio crackle under her and a squelch after
  game.sfxLog.length = 0;
  radio.say('ilsa', 'q', 'Hardigan, the reactor is venting into the pipe gallery. Keep your head down and your fuse short.', { exact: true });
  for (let i = 0; i < 60 * 14 && (radio.current || radio.queue.length || i < 10); i++) { radio.update(1 / 60); clock.advance(1 / 60); }
  const crackles = game.sfxLog.filter((n) => n === 'radio_static').length;
  check('Ilsa on a natural voice crackles now and then, and keys off with a squelch',
    crackles >= 1 && crackles <= 6 && game.sfxLog[game.sfxLog.length - 1] === 'radio_close', game.sfxLog.join(','));
  radio.reset();

  // the radio waits for the voice rather than trusting its own clock
  radio.say('brick', 'x', 'First.', { exact: true });
  radio.say('ilsa', 'y', 'Second.', { exact: true });
  radio.update(1 / 60);
  const firstLife = radio.current.life;
  radio.current.t = firstLife;       // the caption's time is up...
  sp._active.endAt = clock.now() + 5; // ...but the voice is still going
  radio.update(1 / 60);
  check('the radio holds the next line while the voice is still talking', /First/.test(radio.current && radio.current.text));

  // ...and does not start a line while somebody else (MUTTER on the tannoy)
  // is still talking, unless it is urgent
  radio.reset();
  sp.say('Attention. This is a long and very important announcement about nothing.', { voice: 'mutter' });
  radio.say('ilsa', 'z', 'Wait for it.', { exact: true });
  for (let i = 0; i < 30; i++) radio.update(1 / 60);
  check('the radio waits for the tannoy to finish before it speaks', !radio.current && radio.queue.length === 1);
  radio.say('ilsa', 'u', 'Incoming, now!', { exact: true, priority: 6 });
  for (let i = 0; i < 30; i++) radio.update(1 / 60);
  check('...but an urgent line in the queue ends the wait', !!radio.current);
  radio.reset();

  const gsrc = fs.readFileSync(new URL('../src/game/game.js', import.meta.url), 'utf8');
  check('game.js stops the radio when the game pauses', /s === STATE\.PAUSE\)[^\n]*radio\.hold\(\)/.test(gsrc) ||
    /STATE\.PAUSE[\s\S]{0,80}radio\.hold\(\)/.test(gsrc));
  check('game.js stops speech at game over and between floors', /STATE\.GAMEOVER[\s\S]{0,120}radio\.reset\(\)/.test(gsrc));
}

/* 7. the cast table and the engine agree */
{
  check('every SPEAKERS voice is a cast role', Object.values(SPEAKERS).every((s) => ROLES.includes(s.voice)));
  check('voiceOf routes line keys to the cast', voiceOf('brick_kill') === 'brick' && voiceOf('ilsa_intro') === 'ilsa' && voiceOf('boot') === 'mutter');
  const src = fs.readFileSync(new URL('../src/audio/speech.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const topLevel = src.split('\n').filter((l) => /^\S/.test(l) && /speechSynthesis|window\./.test(l));
  check('speech.js never touches speechSynthesis at module top level', topLevel.length === 0, topLevel.join(' | '));
  check('speech.js uses no Math.random', !/Math\.random/.test(src));
  const raw = fs.readFileSync(new URL('../src/audio/speech.js', import.meta.url), 'utf8');
  check('no long dashes in speech.js', !/—/.test(raw));
}

console.log('\nspeech-check - Web Speech casting, text, timing and fallback\n');
for (const r of results) console.log(r);
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
