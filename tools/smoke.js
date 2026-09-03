// smoke.js - boots NUKEHAUS in a real browser, drives it, and writes screenshots.
// Usage: node tools/smoke.js [outDir] [--shots=title,play,siege] [--seconds=N]
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const OUT = process.argv[2] && !process.argv[2].startsWith('--')
  ? process.argv[2]
  : '/tmp/claude-0/-home-user-MComm/1d9ae501-9927-5c9d-832d-0ee312d588ac/scratchpad/shots';
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PORT = 8137;

fs.mkdirSync(OUT, { recursive: true });

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], {
  cwd: ROOT, stdio: 'ignore', detached: false,
});
const stop = () => { try { server.kill('SIGKILL'); } catch { /* ignore */ } };
process.on('exit', stop);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(700);

const browser = await chromium.launch({
  executablePath: CHROME,
  args: [
    '--no-sandbox', '--disable-dev-shm-usage',
    '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-features=AudioServiceOutOfProcess',
    '--mute-audio',
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });

const logs = [];
const errors = [];
page.on('console', (m) => {
  const t = `${m.type()}: ${m.text()}`;
  logs.push(t);
  if (m.type() === 'error') errors.push(t);
});
page.on('pageerror', (e) => errors.push('pageerror: ' + (e.stack || e.message)));
page.on('requestfailed', (r) => errors.push('404? ' + r.url()));
page.on('response', (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });

console.log('booting...');
await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });

// Wait for the game object to appear (asset generation takes a moment).
try {
  await page.waitForFunction(() => window.NUKEHAUS && window.NUKEHAUS.game, { timeout: 90000 });
} catch (e) {
  const fatal = await page.evaluate(() => {
    const el = document.getElementById('fatal');
    return el && el.style.display === 'block' ? document.getElementById('fatal-body').textContent : null;
  }).catch(() => null);
  console.log('BOOT FAILED');
  if (fatal) console.log('FATAL:\n' + fatal);
  console.log(errors.slice(0, 12).join('\n'));
  await page.screenshot({ path: path.join(OUT, 'boot-fail.png') });
  await browser.close(); stop(); process.exit(1);
}

const shot = async (name) => {
  await page.screenshot({ path: path.join(OUT, name + '.png') });
  console.log('  shot:', name);
};

await sleep(1200);
await page.mouse.click(640, 400);      // wake audio
await sleep(900);
await shot('01-title');

// Walk the title pages so their layout gets eyes on it too.
const openPage = async (index, name) => {
  await page.evaluate((i) => { window.NUKEHAUS.title.page = 'menu'; window.NUKEHAUS.title.sel = i; }, index);
  await sleep(150);
  await page.keyboard.press('Enter');
  await sleep(450);
  await shot(name);
  await page.keyboard.press('Escape');
  await sleep(250);
};
await openPage(1, '02-howto');
await openPage(2, '03-options');
await openPage(3, '04-credits');
await page.evaluate(() => { window.NUKEHAUS.title.page = 'difficulty'; window.NUKEHAUS.title.sel = 1; });
await sleep(300); await shot('05-difficulty');

// Start a run.
await page.keyboard.press('Enter');
await sleep(1500);
await shot('06-brief');
await page.keyboard.press('Space'); await sleep(1000);
await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  const h = g.player.hurt.bind(g.player);
  g.player.hurt = () => {};
});
await shot('07-play');

// Walk forward a bit and look around.
await page.keyboard.down('KeyW');
await sleep(1500);
await page.keyboard.up('KeyW');
await sleep(400);
await shot('08-corridor');

// Force a siege so the sky layer gets exercised regardless of level layout.
const siegeInfo = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  if (!g.level) return { ok: false, reason: 'no level loaded; state=' + g.state };
  const waves = (g.level.def.siege && g.level.def.siege.waves) || [];
  if (!waves.length) return { ok: false, reason: 'no waves defined' };
  // Stand on an actual deck cell so the sky shot shows the sky.
  let best = null;
  for (let y = 0; y < g.level.H; y++) for (let x = 0; x < g.level.W; x++) {
    const i = y * g.level.W + x;
    if (g.level.roofPanel[i] && !g.level.wall[i]) { best = [x + 0.5, y + 0.5]; }
  }
  if (best) { g.player.x = best[0]; g.player.y = best[1]; }
  g.triggersFired.add(-1);
  g.beginSiege();
  // Let the roof actually animate; updateRoof is a no-op once it has settled.
  for (let i = 0; i < 80; i++) g.level.updateRoof(0.1);
  return { ok: true, wave: waves[0].name, cities: g.sky.cities.length };
});
console.log('  siege:', JSON.stringify(siegeInfo));
await sleep(3400);
await page.evaluate(() => { window.NUKEHAUS.game.player.pitch = window.NUKEHAUS.game.rc.h * 0.55; });
await sleep(1200);
await shot('09-siege-up');
// Face the horizon and a live warhead: cities, contrails and the lock bracket.
await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  const w = g.sky.warheads[0];
  if (w) {
    g.player.ang = Math.atan2(w.y - g.player.y, w.x - g.player.x);
    const horiz = Math.hypot(w.x - g.player.x, w.y - g.player.y);
    g.player.pitch = ((w.z - g.player.z) / horiz) * g.rc.projY * 0.75;
  } else {
    g.player.ang = g.sky.cities[0].az;
    g.player.pitch = g.rc.h * 0.12;
  }
  g.player.autoFuse = true;
});
await sleep(900);
await shot('10-horizon');

// Fire a few shells.
for (let i = 0; i < 5; i++) {
  await page.mouse.down(); await sleep(90); await page.mouse.up(); await sleep(420);
}
await shot('11-firing');
await sleep(1500);
await shot('12-bursts');

// Automap.
await page.keyboard.press('Tab'); await sleep(400); await shot('13-map');
await page.keyboard.press('Tab'); await sleep(300);

// Performance sample.
const perf = await page.evaluate(async () => {
  const g = window.NUKEHAUS.game;
  const t = [];
  let last = performance.now();
  await new Promise((res) => {
    let n = 0;
    const step = () => {
      const now = performance.now();
      t.push(now - last); last = now;
      if (++n < 140) requestAnimationFrame(step); else res();
    };
    requestAnimationFrame(step);
  });
  t.sort((a, b) => a - b);
  return {
    median: t[t.length >> 1], p95: t[Math.floor(t.length * 0.95)],
    internal: window.NUKEHAUS.size, frameMs: g.frameMs,
    sprites: g.spriteList.length, lights: g.lightList.length,
    warheads: g.sky.warheads.length, particles: g.particles.live.length,
    webgl: !!window.NUKEHAUS.post.gl,
  };
});
console.log('  perf:', JSON.stringify(perf));

const state = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  return {
    state: g.state, level: g.level.name, health: Math.round(g.player.health),
    score: g.player.score, enemies: g.enemies.length,
    citiesAlive: g.sky.livingCities().length,
    warnings: (window.NUKEHAUS.art.warnings || []).slice(0, 6),
  };
});
console.log('  state:', JSON.stringify(state));

console.log(errors.length ? `\nERRORS (${errors.length}):` : '\nNO PAGE ERRORS');
for (const e of errors.slice(0, 14)) console.log('  ' + e);
const warnLogs = logs.filter((l) => l.startsWith('warning') || l.includes('[assets]') || l.includes('unavailable'));
if (warnLogs.length) { console.log('\nWARNINGS:'); for (const w of warnLogs.slice(0, 12)) console.log('  ' + w); }

await browser.close();
stop();
console.log('\nshots in', OUT);
process.exit(errors.length ? 2 : 0);
