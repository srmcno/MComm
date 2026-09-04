// verify-bundle.js - boot dist/nukehaus.html in a browser and check it plays.
import { chromium } from 'playwright-core';
import { chromePath } from './chrome-path.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const OUT = '/tmp/claude-0/-home-user-MComm/1d9ae501-9927-5c9d-832d-0ee312d588ac/scratchpad';
const PORT = 8157;
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'],
  { cwd: path.join(ROOT, 'dist'), stdio: 'ignore' });
process.on('exit', () => { try { server.kill('SIGKILL'); } catch {} });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(600);

const browser = await chromium.launch({
  ...(chromePath() ? { executablePath: chromePath() } : {}),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--mute-audio', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
const errs = [];
page.on('pageerror', (e) => errs.push((e.stack || e.message).split('\n')[0]));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
const requests = [];
page.on('request', (r) => { if (!r.url().endsWith('/nukehaus.html')) requests.push(r.url()); });

await page.goto(`http://127.0.0.1:${PORT}/nukehaus.html`);
let ok = true;
const check = (n, v, d = '') => { if (!v) ok = false; console.log(`${v ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };

try {
  await page.waitForFunction(() => window.NUKEHAUS && window.NUKEHAUS.game, { timeout: 90000 });
  check('single file boots', true);
} catch (e) {
  const fatal = await page.evaluate(() => {
    const el = document.getElementById('fatal');
    return el && el.style.display === 'block' ? document.getElementById('fatal-body').textContent : null;
  }).catch(() => null);
  check('single file boots', false, fatal || errs[0] || 'timeout');
  await page.screenshot({ path: path.join(OUT, 'bundle-fail.png') });
  await browser.close(); server.kill('SIGKILL'); process.exit(1);
}

await sleep(900);
await page.mouse.click(550, 350);
await sleep(900);
await page.screenshot({ path: path.join(OUT, 'bundle-title.png') });

const state = await page.evaluate(async () => {
  const g = window.NUKEHAUS.game;
  g.newGame(1);
  g.setState('play');
  g.player.hurt = () => {};
  g.triggersFired.add(-1); g.beginSiege();
  for (let i = 0; i < 200; i++) g.level.updateRoof(0.05);
  await new Promise((r) => setTimeout(r, 2500));
  return {
    level: g.level.name, warheads: g.sky.warheads.length,
    art: window.NUKEHAUS.art.warnings.length,
    tex: window.NUKEHAUS.art.texAtlas.length,
    sprites: Object.keys(window.NUKEHAUS.art.sprites).length,
    vm: Object.keys(window.NUKEHAUS.art.vm).length,
    levels: g.totalLevels, audio: !!(g.sound && g.sound.ready),
    webgl: !!window.NUKEHAUS.post.gl,
  };
});
await page.screenshot({ path: path.join(OUT, 'bundle-play.png') });

check('all art generated in the bundle', state.art === 0 && state.tex > 100000 &&
  state.sprites > 150 && state.vm > 100,
  `${state.sprites} sprites, ${state.vm} viewmodel frames, ${state.tex} texture pixels`);
check('all levels present', state.levels === 5, `${state.levels}`);
check('a siege runs', state.warheads >= 0 && state.level.length > 0, state.level);
check('audio started', state.audio);
check('WebGL post chain active', state.webgl);
check('no external requests', requests.length === 0,
  requests.length ? requests.slice(0, 3).join(', ') : 'fully self-contained');
// Pointer lock can be refused in an embedded frame, so the cursor-steering
// fallback has to be able to fly the game on its own.
await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  g.newGame(1); g.setState('play'); g.player.hurt = () => {};
  g.player.ang = 0; g.input.locked = false;
  document.exitPointerLock && document.exitPointerLock();
});
await page.mouse.move(550, 350);
await sleep(120);
const before = await page.evaluate(() => window.NUKEHAUS.game.player.ang);
await page.mouse.move(1000, 350);       // hold the cursor right of centre
await sleep(900);
const after = await page.evaluate(() => ({
  ang: window.NUKEHAUS.game.player.ang, moved: window.NUKEHAUS.game.input.mouseMoved,
}));
check('plays without pointer lock', after.moved && Math.abs(after.ang - before) > 0.25,
  `turned ${(after.ang - before).toFixed(2)} rad from the cursor alone`);

check('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));

console.log(ok ? '\nbundle verified' : '\nbundle has problems');
await browser.close();
server.kill('SIGKILL');
process.exit(ok ? 0 : 1);
