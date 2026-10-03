// audio-integration.js - checks that the game and the audio modules agree.
// Static half: every sfx name and every announcer line the game calls must exist.
// Live half: boot a browser, start audio, and confirm sound is actually produced.
import { chromium } from 'playwright-core';
import { chromePath } from './chrome-path.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { SFX_NAMES } from '../src/audio/synth.js';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const PORT = Number(process.env.TOOL_PORT || 8147);
let fails = 0;
const check = (name, ok, detail = '') => {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

// ---------------------------------------------------------------- static
// Every game and UI module, not a hand-kept list: gore.js calls seven sounds of
// its own, and a list that missed it would ship a typo as silence.
const srcFiles = [
  ...fs.readdirSync(path.join(ROOT, 'src/game')).filter((f) => f.endsWith('.js')).map((f) => 'src/game/' + f),
  ...fs.readdirSync(path.join(ROOT, 'src/ui')).filter((f) => f.endsWith('.js')).map((f) => 'src/ui/' + f),
  'src/main.js',
];
const gameSrc = srcFiles.map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
const synthSrc = fs.readFileSync(path.join(ROOT, 'src/audio/synth.js'), 'utf8');
const voxSrc = fs.readFileSync(path.join(ROOT, 'src/audio/vox.js'), 'utf8');

/** The first argument of every sfx( call, up to its comma or bracket. */
function sfxArgs(src) {
  const out = [];
  for (const m of src.matchAll(/\bsfx\(/g)) {
    let i = m.index + m[0].length, depth = 0, q = null;
    const start = i;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (q) { if (ch === q && src[i - 1] !== '\\') q = null; continue; }
      if (ch === "'" || ch === '"' || ch === '`') q = ch;
      else if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') { if (depth === 0) break; depth--; }
      else if (ch === ',' && depth === 0) break;
    }
    out.push(src.slice(start, i));
  }
  return out;
}

const usedSfx = new Set();
// Every quoted name the argument can evaluate to counts, so sfx(x ? 'a' : 'b')
// and sfx(e.def.die || 'enemy_die') are checked on both sides. A string that is
// compared against (=== 'rend') or built on ('chain' + n) is not a name.
for (const arg of sfxArgs(gameSrc)) {
  for (const m of arg.matchAll(/(?<![=!]=?=\s*)'([a-z0-9_]+)'(?!\s*\+)/g)) usedSfx.add(m[1]);
}
for (const m of gameSrc.matchAll(/\b(?:alert|die): '([a-z0-9_]+)'/g)) usedSfx.add(m[1]);
// The chain stings are built by concatenation.
for (let i = 2; i <= 5; i++) usedSfx.add('chain' + i);
for (const m of gameSrc.matchAll(/sfx\(spec\.sfx/g)) {
  for (const w of fs.readFileSync(path.join(ROOT, 'src/game/weapons.js'), 'utf8')
    .matchAll(/sfx: '([a-z0-9_]+)'/g)) usedSfx.add(w[1]);
}

// Ask the synth itself: sfx() on a name it does not know is a silent no-op.
const known = new Set(SFX_NAMES);
const missingSfx = [...usedSfx].filter((n) => !known.has(n));
check(`all ${usedSfx.size} sfx names the game calls exist in synth.js`, missingSfx.length === 0,
  missingSfx.join(', '));

const storySrc = fs.readFileSync(path.join(ROOT, 'src/game/story.js'), 'utf8');
const usedLines = new Set();
for (const m of gameSrc.matchAll(/speak\(\s*'([a-z0-9_]+)'/g)) usedLines.add(m[1]);
for (const m of gameSrc.matchAll(/speakAs\(\s*[a-zA-Z.]+\s*,\s*'([a-z0-9_]+)'/g)) usedLines.add(m[1]);
for (const m of gameSrc.matchAll(/\.say\(\s*'[a-z]+'\s*,\s*'([a-z0-9_]+)'/g)) usedLines.add(m[1]);
for (const m of gameSrc.matchAll(/this\.brick\(\s*'([a-z0-9_]+)'/g)) usedLines.add(m[1]);
for (const m of storySrc.matchAll(/L\('[a-z]+',\s*'([a-z0-9_]+)'/g)) usedLines.add(m[1]);
const missingLines = [...usedLines].filter((n) => !new RegExp(`\\b${n}\\s*:`).test(voxSrc));
check(`all ${usedLines.size} announcer lines the game asks for exist in vox.js`,
  missingLines.length === 0, missingLines.join(', '));

const usedTracks = new Set();
for (const m of gameSrc.matchAll(/music\(\s*'([a-z]+)'/g)) usedTracks.add(m[1]);
// corridorTrack() returns names as bare strings rather than calling music().
for (const m of gameSrc.matchAll(/return '([a-z]+)';\s*\n\s*return this\.level\.def\.music/g)) usedTracks.add(m[1]);
usedTracks.add('hunt');
for (const m of fs.readFileSync(path.join(ROOT, 'src/game/maps.js'), 'utf8')
  .matchAll(/music:\s*'([a-z]+)'/g)) usedTracks.add(m[1]);
const missingTracks = [...usedTracks].filter((n) => !new RegExp(`\\n\\s*${n}\\s*:\\s*\\{`).test(synthSrc));
check(`all ${usedTracks.size} music tracks exist`, missingTracks.length === 0, missingTracks.join(', '));

// ------------------------------------------------------------------ live
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'],
  { cwd: ROOT, stdio: 'ignore' });
process.on('exit', () => { try { server.kill('SIGKILL'); } catch {} });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(600);

const browser = await chromium.launch({
  ...(chromePath() ? { executablePath: chromePath() } : {}),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 560 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto(`http://127.0.0.1:${PORT}/index.html`);
await page.waitForFunction(() => window.NUKEHAUS && window.NUKEHAUS.game, { timeout: 90000 });
await sleep(500);
await page.mouse.click(450, 280);      // the gesture that starts audio
await sleep(1500);

let r = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  return {
    ready: !!(g.sound && g.sound.ready),
    ctx: !!(g.sound && g.sound.ctx),
    state: g.sound && g.sound.ctx ? g.sound.ctx.state : 'none',
    vox: typeof g.vox.say === 'function',
    lines: Object.keys(g.voxLines || {}).length,
  };
});
check('audio context starts on the first click', r.ready && r.ctx && r.state === 'running',
  `ctx ${r.state}`);
check('announcer is wired with its script', r.vox && r.lines > 40, `${r.lines} lines`);

// Three characters, three vocal tracts. Confirm they are actually different.
r = await page.evaluate(async () => {
  const voxMod = await import('/src/audio/vox.js');
  const g = window.NUKEHAUS.game;
  const raw = g.sound.raw;
  const ctx = raw.ctx;
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const an = ctx.createAnalyser();
  an.fftSize = 4096;
  raw.sfxBus.connect(an);
  const bins = new Float32Array(an.frequencyBinCount);
  const hz = ctx.sampleRate / an.fftSize;
  const out = {};
  const v = new voxMod.Vox(ctx, raw.sfxBus);
  v.setVolume(1);
  for (const voice of ['mutter', 'brick', 'ilsa']) {
    // Average spectrum over one spoken vowel sweep per voice.
    const acc = new Float64Array(an.frequencyBinCount);
    let frames = 0;
    v.say('{IY1 EH1 AA1 UW1}', { voice });
    const until = performance.now() + 1600;
    while (performance.now() < until) {
      an.getFloatFrequencyData(bins);
      for (let i = 0; i < bins.length; i++) acc[i] += Math.pow(10, bins[i] / 20);
      frames++;
      await sleep(16);
    }
    // Spectral centroid: a compact proxy for where the formants sit.
    let num = 0, den = 0, peak = 0, peakHz = 0;
    for (let i = 2; i < 400; i++) {
      const m = acc[i] / Math.max(1, frames);
      num += m * i * hz; den += m;
      if (m > peak) { peak = m; peakHz = i * hz; }
    }
    out[voice] = { centroid: Math.round(den ? num / den : 0), peakHz: Math.round(peakHz) };
    v.cancel();
    await sleep(220);
  }
  raw.sfxBus.disconnect(an);
  return out;
});
check('the three voices sit in different registers',
  r.brick.centroid > 0 && r.ilsa.centroid > r.brick.centroid * 1.12,
  `centroid Hz — brick ${r.brick.centroid}, mutter ${r.mutter.centroid}, ilsa ${r.ilsa.centroid}`);

// Fire every sfx name the game can call and make sure none of them throws.
r = await page.evaluate(async (names) => {
  const g = window.NUKEHAUS.game;
  const bad = [];
  for (const n of names) {
    try { g.sound.raw ? g.sound.raw.sfx(n, { vol: 0.001 }) : g.sound.sfx(n, { vol: 0.001 }); }
    catch (e) { bad.push(n + ': ' + e.message); }
  }
  return { bad };
}, [...usedSfx]);
check('every sfx name plays without throwing', r.bad.length === 0, r.bad.slice(0, 4).join('; '));

// Tap the live graph the game is actually using and confirm it makes sound.
r = await page.evaluate(async () => {
  const g = window.NUKEHAUS.game;
  const raw = g.sound.raw;
  const ctx = raw.ctx;
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

  const tap = (node) => {
    const an = ctx.createAnalyser();
    an.fftSize = 2048;
    node.connect(an);
    const buf = new Float32Array(an.fftSize);
    return {
      // Peak-hold RMS over a window, so a sparse pattern still registers.
      async measure(ms) {
        let peak = 0, best = 0;
        const until = performance.now() + ms;
        while (performance.now() < until) {
          an.getFloatTimeDomainData(buf);
          let sum = 0, p = 0;
          for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > p) p = a; sum += buf[i] * buf[i]; }
          const rms = Math.sqrt(sum / buf.length);
          if (rms > best) best = rms;
          if (p > peak) peak = p;
          await sleep(20);
        }
        return { peak: +peak.toFixed(3), rms: +best.toFixed(4) };
      },
      done() { try { node.disconnect(an); } catch (e) { /* ignore */ } },
    };
  };

  const out = {};
  const mt = tap(raw.musicBus);
  for (const track of ['title', 'siege', 'boss']) {
    raw.stopMusic(0.05);
    await sleep(120);
    raw.setMusicVol(1); raw.setMaster(1);
    raw.music(track, { fadeIn: 0.05, intensity: 0.85 });
    await sleep(400);
    out[`music:${track}`] = await mt.measure(2200);
  }
  raw.stopMusic(0.05);
  await sleep(200);
  mt.done();

  const st = tap(raw.sfxBus);
  raw.setSfxVol(1);
  const sfxP = st.measure(2200);
  for (const [i, n] of ['airburst', 'city_hit', 'roof_open', 'chain5', 'nailer_fire'].entries()) {
    setTimeout(() => raw.sfx(n), i * 260);
  }
  out.sfx = await sfxP;

  const voxP = st.measure(3200);
  g.vox.sayLine('city_lost', { args: ['ASHGROVE', '5'] });
  out.vox = await voxP;
  st.done();
  return out;
});
for (const [k, v] of Object.entries(r)) {
  // These taps sit on the buses, upstream of the master limiter, so a peak
  // above 1 is expected and not a clip.
  check(`${k} produces audio`, v.peak > 0.01 && Number.isFinite(v.peak) && v.rms > 0.002,
    `peak ${v.peak} rms ${v.rms}`);
}

// ------------------------------------------------------------- voices
// Headless Chromium has a speechSynthesis with no voices, so the game must have
// fallen back to the formant synth on its own, and said so on the options page.
r = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  let voices = -1;
  try { voices = window.speechSynthesis ? window.speechSynthesis.getVoices().length : -1; } catch { voices = -2; }
  const opt = g.titleScreen.optionList(g).find((o) => o.label === 'VOICE');
  return { engine: g.vox.engine, voices, label: opt ? opt.value() : null, mode: g.voiceMode };
});
check('with no browser voices the game falls back to the formant synth',
  r.engine === 'robot' || r.voices > 0, `engine ${r.engine}, ${r.voices} voices`);
check('the VOICE option exists and reports what is playing', !!r.label && r.mode === 'natural', `${r.label}`);

// A second page with a stand-in speechSynthesis that has a desktop's voices,
// to drive the natural path through the real boot wiring: casting, captions,
// the pause cutting speech off, and the VOICE switch.
{
  const pg = await browser.newPage({ viewport: { width: 900, height: 560 } });
  pg.on('pageerror', (e) => errs.push(e.message));
  await pg.addInitScript(() => {
    const V = (name, lang) => ({ name, lang, voiceURI: name, localService: false, default: false });
    const voices = [
      V('Microsoft Davis Online (Natural) - English (United States)', 'en-US'),
      V('Microsoft Jenny Online (Natural) - English (United States)', 'en-US'),
      V('Microsoft Ryan Online (Natural) - English (United Kingdom)', 'en-GB'),
      V('Microsoft Katja Online (Natural) - German (Germany)', 'de-DE'),
    ];
    const log = [];
    const synth = {
      speaking: false, pending: false, paused: false, cancels: 0, cur: null,
      getVoices: () => voices,
      addEventListener() {},
      speak(u) {
        log.push({ text: u.text, voice: u.voice && u.voice.name, pitch: u.pitch, rate: u.rate, volume: u.volume });
        synth.speaking = true; synth.cur = u;
        setTimeout(() => { if (synth.cur === u && u.onstart) u.onstart({}); }, 20);
        setTimeout(() => { if (synth.cur === u) { synth.cur = null; synth.speaking = false; if (u.onend) u.onend({}); } },
          20 + u.text.length * 55);
      },
      cancel() { synth.cancels++; synth.cur = null; synth.speaking = false; },
      pause() {}, resume() {},
    };
    function Utterance(text) { this.text = text; this.volume = 1; this.pitch = 1; this.rate = 1; }
    Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: Utterance, configurable: true });
    window.__speechLog = log;
  });
  await pg.goto(`http://127.0.0.1:${PORT}/index.html`);
  await pg.waitForFunction(() => window.NUKEHAUS && window.NUKEHAUS.game, null, { timeout: 120000 });
  await sleep(300);
  await pg.mouse.click(450, 280);
  await sleep(900);
  const v = await pg.evaluate(async () => {
    const g = window.NUKEHAUS.game;
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    const out = { engine: g.vox.engine, casting: g.vox.casting };
    window.__speechLog.length = 0;
    g.newGame(1); g.loadLevel(0); g.setState('play');
    // A line with no recorded take: the game reads it to nobody. It is a
    // subtitle, not the browser voice (the first of Ilsa's pools nobody recorded).
    // The cast arrives behind the game (voices/*.js); wait for all of it.
    for (let i = 0; i < 600 && !g.castLoaded; i++) await sleep(50);
    const VOICE_PACK = { clips: g.castBank ? g.castBank.clips.slice() : [] };
    out.castLoaded = g.castLoaded || 0;
    const { voiceOf } = await import('./src/audio/vox.js');
    const taken = new Set(VOICE_PACK.clips.map((c) => c.k));
    // A pool nobody recorded, if there still is one; otherwise words nobody did.
    const bare = Object.keys(g.voxLines).find((k) => Array.isArray(g.voxLines[k]) && voiceOf(k) === 'ilsa'
      && !taken.has(k) && g.voxLines[k].every((s) => !s.includes('%s')));
    out.bare = bare || 'exact words';
    const dur = bare ? g.speakAs('ilsa', bare, '') : g.speakAs('ilsa', null, 'Vance here. This sentence was never recorded by anyone.');
    out.dur = dur;
    out.caption = g.lastSpoken && g.lastSpoken.text;
    await sleep(80);
    out.first = window.__speechLog.slice();
    out.busy = g.vox.busy;
    // The recorded cast: a line with a take plays from the pack through Web
    // Audio, and the browser voice says nothing.
    out.pack = VOICE_PACK.clips.length;
    if (out.pack) {
      const key = VOICE_PACK.clips.find((c) => c.k && !c.a).k;
      g.vox.cancel();
      await sleep(50);
      const n0 = window.__speechLog.length;
      const d2 = g.speakAs(VOICE_PACK.clips.find((c) => c.k === key).r, key, '');
      await sleep(120);
      out.take = { key, acted: g.vox.acted, d: d2, tts: window.__speechLog.length - n0,
        caption: g.lastSpoken && g.lastSpoken.text,
        recorded: VOICE_PACK.clips.filter((c) => c.k === key).map((c) => c.t) };
      g.vox.cancel();
      await sleep(50);
    }
    g.radio.say('brick', 'brick_boot', 'Doctor Vance. Sit tight.', { priority: 3 });
    g.radio.update(1 / 60);
    const cancels = window.speechSynthesis.cancels;
    g.setState('pause');
    out.pauseCancelled = window.speechSynthesis.cancels > cancels && !g.vox.busy;
    out.held = g.radio.queue.length;
    const opt = g.titleScreen.optionList(g).find((o) => o.label === 'VOICE');
    out.onLabel = opt.value();
    opt.adj(1);                        // ON -> OFF
    out.off = { mode: g.voiceMode, said: g.vox.say('Anyone there?', { voice: 'brick' }), label: opt.value() };
    opt.adj(1);                        // OFF -> ON
    let stored = null;
    try { stored = localStorage.getItem('nukehaus.voice.v1'); } catch { stored = 'blocked'; }
    out.back = { mode: g.voiceMode, engine: g.vox.engine, stored };
    // Walking back to the title (after victory or game over) stops the cast.
    g.setState('play');
    g.speakAs('mutter', 'boot', '');
    const c2 = window.speechSynthesis.cancels;
    g.setState('title');
    out.titleCancelled = window.speechSynthesis.cancels > c2 && !g.vox.busy;
    const all = window.__speechLog.map((e) => e.text).join(' ');
    out.leak = /[{}|]|\b[A-Z]{1,2}[012]\b|%s/.test(all + ' ' + out.caption);
    return out;
  });
  await pg.close();
  check('natural voices: the engine is the browser voice', v.engine === 'natural', v.engine);
  check('natural voices: Brick, Ilsa and MUTTER are cast to three voices',
    /Davis/.test(v.casting.brick) && /Katja/.test(v.casting.ilsa) && /Ryan/.test(v.casting.mutter),
    `${v.casting.brick} / ${v.casting.ilsa} / ${v.casting.mutter}`);
  check('a line nobody recorded is a subtitle: captioned, and no browser (or any synthetic) voice says it',
    !!v.bare && !v.first.length && !(v.dur > 0) && !!v.caption, `${v.bare}: ${v.dur}s, ${v.first.length} utterances, "${String(v.caption).slice(0, 40)}"`);
  check('natural voices: nothing spoken or captioned carries phones or braces', !v.leak);
  check('the recorded cast arrives behind the game, from the voices folder', v.castLoaded > 400 && v.pack === v.castLoaded, `${v.castLoaded} clips loaded, ${v.pack} in the bank`);
  if (v.pack) {
    const t = v.take;
    check('recorded cast: a line with a take plays the take, captioned with its words, and no browser voice',
      t.acted && t.d > 0.3 && t.tts === 0 && t.recorded.includes(t.caption), `${t.key}: ${t.d}s "${t.caption}" tts ${t.tts}`);
  }
  check('natural voices: pausing cancels speech and holds the radio line', v.pauseCancelled && v.held >= 1, `held ${v.held}`);
  check('VOICE reads as the recorded cast, and there is no ROBOT to pick', /RECORDED CAST|ON/.test(v.onLabel) && v.off.mode === 'off', `${v.onLabel} -> ${v.off.label}`);
  check('VOICE: OFF is silent', v.off.mode === 'off' && v.off.said === 0 && v.off.label === 'OFF');
  check('natural voices: going back to the title stops speech', v.titleCancelled);
  check('VOICE: back to NATURAL, and the choice is stored', v.back.mode === 'natural' && v.back.engine === 'natural' &&
    (v.back.stored === 'natural' || v.back.stored === 'blocked'), `${v.back.stored}`);
}

// Every take in the pack decodes in a real browser to about the length it claims.
{
  const pg = await browser.newPage();
  pg.on('pageerror', (e) => errs.push(e.message));
  await pg.goto(`http://127.0.0.1:${PORT}/index.html`);
  await pg.waitForFunction(() => window.NUKEHAUS && window.NUKEHAUS.game, null, { timeout: 120000 });
  const d = await pg.evaluate(async () => {
    const g = window.NUKEHAUS.game;
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    const { ClipBank } = await import('./src/audio/acted.js');
    const { VOICE_FILES } = await import('./src/audio/voicepack.js');
    const want = (set) => VOICE_FILES.filter((f) => f.set === set).reduce((n, f) => n + f.clips, 0);
    for (let i = 0; i < 600 && !g.castLoaded; i++) await sleep(50);
    const first = g.brickVoice;
    const clips = g.castBank.clips.slice();
    // and the other Brick: switching to him fetches his takes in place of these
    const other = g.brickVoices.find((b) => b.id !== first).id;
    const out = { n: 0, bad: [], worst: 0, first, other, swapped: false };
    g.setBrickVoice(other);
    for (let i = 0; i < 600; i++) {
      if (g.castBank.clips.filter((c) => c.r === 'brick').length === want(other)) break;
      await sleep(50);
    }
    const his = g.castBank.clips.filter((c) => c.r === 'brick');
    out.swapped = his.length === want(other) && g.castBank.clips.length === clips.filter((c) => c.r !== 'brick').length + his.length;
    out.label = g.titleScreen.optionList(g).find((o) => o.label === 'BRICK VOICE').value();
    g.setBrickVoice(first);
    out.back = g.castBank.clips.filter((c) => c.r === 'brick').length === want(first);
    const ctx = new OfflineAudioContext(1, 22050, 22050);
    const bank = new ClipBank({ clips: [...clips, ...his] });
    bank.attach(ctx, ctx.destination);
    out.n = bank.clips.length;
    for (const c of bank.clips) {
      try {
        const buf = await bank._decode(c);
        const off = Math.abs(buf.duration - c.d);
        out.worst = Math.max(out.worst, off);
        if (off > 0.2) out.bad.push(`${c.k}.${c.i}: ${buf.duration.toFixed(2)} vs ${c.d}`);
      } catch (e) { out.bad.push(`${c.k}.${c.i}: ${e && e.message}`); }
    }
    return out;
  });
  await pg.close();
  check(`BRICK VOICE switches his takes (${d.first} to ${d.other} and back) and leaves the rest of the cast alone`, d.swapped && d.back, `${d.label}`);
  check(`every recorded take, both Bricks, decodes to its stated length (${d.n})`, d.bad.length === 0,
    d.bad.length ? d.bad.slice(0, 4).join('; ') : `worst ${d.worst.toFixed(3)}s off`);
}

// Switching Brick while his first cast is still coming in: the rest of that
// cast is not fetched, nothing is fetched twice, and the new one all arrives.
{
  const pg = await browser.newPage();
  pg.on('pageerror', (e) => errs.push(e.message));
  const asked = [];
  await pg.route('**/voices/*.js', async (route) => {
    asked.push(route.request().url().replace(/^.*\/voices\//, ''));
    await sleep(250);
    await route.continue();
  });
  await pg.goto(`http://127.0.0.1:${PORT}/index.html`);
  await pg.waitForFunction(() => window.NUKEHAUS && window.NUKEHAUS.game, null, { timeout: 120000 });
  const s = await pg.evaluate(async () => {
    const g = window.NUKEHAUS.game;
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    const { VOICE_FILES } = await import('./src/audio/voicepack.js');
    const first = g.brickVoice;
    const other = g.brickVoices.find((b) => b.id !== first).id;
    const want = VOICE_FILES.filter((f) => f.set === other).reduce((n, f) => n + f.clips, 0);
    g.setBrickVoice(other);
    for (let i = 0; i < 800; i++) {
      if (g.castLoaded && g.castBank.clips.filter((c) => c.r === 'brick').length === want) break;
      await sleep(50);
    }
    return {
      first, other, castLoaded: g.castLoaded || 0,
      brick: g.castBank.clips.filter((c) => c.r === 'brick').length, want,
      files: VOICE_FILES.map((f) => ({ name: f.src.replace(/^voices\//, ''), set: f.set })),
    };
  });
  await pg.close();
  const of = (set) => s.files.filter((f) => f.set === set).map((f) => f.name);
  const stale = asked.filter((n) => of(s.first).includes(n));
  const twice = asked.filter((n, i) => asked.indexOf(n) !== i);
  const missing = [...of('cast'), ...of(s.other)].filter((n) => !asked.includes(n));
  check(`switching Brick mid-download stops ${s.first}'s files and fetches ${s.other}'s (${s.brick}/${s.want} takes)`,
    stale.length <= 1 && !twice.length && !missing.length && s.brick === s.want && s.castLoaded > 0,
    `${stale.length} of ${of(s.first).length} ${s.first} files fetched${twice.length ? `, twice: ${twice.join(' ')}` : ''}${missing.length ? `, missing: ${missing.join(' ')}` : ''}`);
}

// With VOICE off the cast is not downloaded at all; turning it on fetches it.
{
  const pg = await browser.newPage();
  pg.on('pageerror', (e) => errs.push(e.message));
  await pg.addInitScript(() => { try { localStorage.setItem('nukehaus.voice.v1', 'off'); } catch {} });
  const asked = [];
  await pg.route('**/voices/*.js', async (route) => {
    asked.push(route.request().url().replace(/^.*\/voices\//, ''));
    await route.continue();
  });
  await pg.goto(`http://127.0.0.1:${PORT}/index.html`);
  await pg.waitForFunction(() => window.NUKEHAUS && window.NUKEHAUS.game, null, { timeout: 120000 });
  await sleep(2500);
  const whileOff = asked.length;
  const o = await pg.evaluate(async () => {
    const g = window.NUKEHAUS.game;
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    const { VOICE_FILES } = await import('./src/audio/voicepack.js');
    const mode = g.voiceMode;
    g.titleScreen.optionList(g).find((x) => x.label === 'VOICE').adj(1);
    for (let i = 0; i < 600 && !g.castLoaded; i++) await sleep(50);
    return {
      mode, now: g.voiceMode, castLoaded: g.castLoaded || 0, brick: g.brickVoice,
      files: VOICE_FILES.map((f) => ({ name: f.src.replace(/^voices\//, ''), set: f.set })),
    };
  });
  await pg.close();
  const want = o.files.filter((f) => f.set === 'cast' || f.set === o.brick).map((f) => f.name);
  const missing = want.filter((n) => !asked.includes(n));
  const extra = asked.filter((n) => !want.includes(n) || asked.indexOf(n) !== asked.lastIndexOf(n));
  check('with VOICE off nothing is downloaded; turning it on fetches the cast and his Brick, once each',
    o.mode === 'off' && o.now !== 'off' && whileOff === 0 && !missing.length && !extra.length && o.castLoaded > 400,
    `${whileOff} files while off, then ${asked.length} (${o.castLoaded} takes)${missing.length ? `, missing ${missing.join(' ')}` : ''}${extra.length ? `, extra ${extra.join(' ')}` : ''}`);
}

if (errs.length) { console.log('\nPAGE ERRORS:'); for (const e of errs.slice(0, 6)) console.log('  ' + e); }
console.log(`\n${fails ? fails + ' failures' : 'all audio checks passed'}`);
await browser.close();
server.kill('SIGKILL');
process.exit(fails || errs.length ? 1 : 0);
