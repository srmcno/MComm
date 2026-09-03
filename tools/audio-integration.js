// audio-integration.js - checks that the game and the audio modules agree.
// Static half: every sfx name and every announcer line the game calls must exist.
// Live half: boot a browser, start audio, and confirm sound is actually produced.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const PORT = 8147;
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

const usedLines = new Set();
for (const m of gameSrc.matchAll(/speak\(\s*'([a-z0-9_]+)'/g)) usedLines.add(m[1]);
const missingLines = [...usedLines].filter((n) => !new RegExp(`\\b${n}\\s*:`).test(voxSrc));
check(`all ${usedLines.size} announcer lines the game asks for exist in vox.js`,
  missingLines.length === 0, missingLines.join(', '));

const usedTracks = new Set();
for (const m of gameSrc.matchAll(/music\(\s*'([a-z]+)'/g)) usedTracks.add(m[1]);
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
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
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
check('announcer is wired with its script', r.vox && r.lines > 10, `${r.lines} lines`);

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

if (errs.length) { console.log('\nPAGE ERRORS:'); for (const e of errs.slice(0, 6)) console.log('  ' + e); }
console.log(`\n${fails ? fails + ' failures' : 'all audio checks passed'}`);
await browser.close();
server.kill('SIGKILL');
process.exit(fails || errs.length ? 1 : 0);
