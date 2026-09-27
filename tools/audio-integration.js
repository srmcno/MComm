// audio-integration.js - checks that the game and the audio modules agree.
// Static half: every sfx name and every announcer line the game calls must exist.
// Live half: boot a browser, start audio, and confirm sound is actually produced.
import { chromium } from 'playwright-core';
import { chromePath } from './chrome-path.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const PORT = Number(process.env.TOOL_PORT || 8147);
let fails = 0;
const check = (name, ok, detail = '') => {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

// ---------------------------------------------------------------- static
const gameSrc = ['src/game/game.js', 'src/game/render.js', 'src/main.js', 'src/game/entities.js']
  .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
const synthSrc = fs.readFileSync(path.join(ROOT, 'src/audio/synth.js'), 'utf8');
const voxSrc = fs.readFileSync(path.join(ROOT, 'src/audio/vox.js'), 'utf8');

const usedSfx = new Set();
for (const m of gameSrc.matchAll(/\bsfx\(\s*'([a-z0-9_]+)'/g)) usedSfx.add(m[1]);
for (const m of gameSrc.matchAll(/sfx\(\s*e\.def\.alert \|\| '([a-z0-9_]+)'/g)) usedSfx.add(m[1]);
for (const m of gameSrc.matchAll(/alert: '([a-z0-9_]+)'/g)) usedSfx.add(m[1]);
// The chain stings are built by concatenation.
for (let i = 2; i <= 5; i++) usedSfx.add('chain' + i);
for (const m of gameSrc.matchAll(/sfx\(spec\.sfx/g)) {
  for (const w of fs.readFileSync(path.join(ROOT, 'src/game/weapons.js'), 'utf8')
    .matchAll(/sfx: '([a-z0-9_]+)'/g)) usedSfx.add(w[1]);
}

// The synth registers sounds as object keys or methods, so match either shape.
const missingSfx = [...usedSfx].filter((n) => !new RegExp(`\\b${n}\\s*[:(]`).test(synthSrc));
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
    const dur = g.speakAs('ilsa', 'ilsa_intro', '');
    out.dur = dur;
    out.caption = g.lastSpoken && g.lastSpoken.text;
    await sleep(80);
    out.first = window.__speechLog.slice();
    out.busy = g.vox.busy;
    g.radio.say('brick', 'brick_boot', 'Doctor Vance. Sit tight.', { priority: 3 });
    g.radio.update(1 / 60);
    const cancels = window.speechSynthesis.cancels;
    g.setState('pause');
    out.pauseCancelled = window.speechSynthesis.cancels > cancels && !g.vox.busy;
    out.held = g.radio.queue.length;
    const opt = g.titleScreen.optionList(g).find((o) => o.label === 'VOICE');
    opt.adj(1);                        // NATURAL -> ROBOT
    out.robot = { mode: g.voiceMode, engine: g.vox.engine, label: opt.value() };
    opt.adj(1);                        // ROBOT -> OFF
    out.off = { mode: g.voiceMode, said: g.vox.say('Anyone there?', { voice: 'brick' }) };
    opt.adj(1);                        // OFF -> NATURAL
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
  const u = v.first[0] || {};
  check('natural voices: Ilsa speaks in Katja with a duration and a caption',
    /Katja/.test(u.voice || '') && v.dur > 1 && !!v.caption && v.busy, `${v.dur}s "${String(v.caption).slice(0, 40)}"`);
  check('natural voices: nothing spoken or captioned carries phones or braces', !v.leak);
  check('natural voices: pausing cancels speech and holds the radio line', v.pauseCancelled && v.held >= 1, `held ${v.held}`);
  check('VOICE: ROBOT switches to the formant synth', v.robot.mode === 'robot' && v.robot.engine === 'robot' && v.robot.label === 'ROBOT');
  check('VOICE: OFF is silent', v.off.mode === 'off' && v.off.said === 0);
  check('natural voices: going back to the title stops speech', v.titleCancelled);
  check('VOICE: back to NATURAL, and the choice is stored', v.back.mode === 'natural' && v.back.engine === 'natural' &&
    (v.back.stored === 'natural' || v.back.stored === 'blocked'), `${v.back.stored}`);
}

if (errs.length) { console.log('\nPAGE ERRORS:'); for (const e of errs.slice(0, 6)) console.log('  ' + e); }
console.log(`\n${fails ? fails + ' failures' : 'all audio checks passed'}`);
await browser.close();
server.kill('SIGKILL');
process.exit(fails || errs.length ? 1 : 0);
