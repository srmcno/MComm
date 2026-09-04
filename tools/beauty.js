// beauty.js - composes specific scenes and photographs them, so the look of the
// game can be judged instead of guessed at.
import { chromium } from 'playwright-core';
import { chromePath } from './chrome-path.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const OUT = '/tmp/claude-0/-home-user-MComm/1d9ae501-9927-5c9d-832d-0ee312d588ac/scratchpad/beauty';
const PORT = 8143;
fs.mkdirSync(OUT, { recursive: true });
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'],
  { cwd: ROOT, stdio: 'ignore' });
process.on('exit', () => { try { server.kill('SIGKILL'); } catch {} });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(700);

const browser = await chromium.launch({
  ...(chromePath() ? { executablePath: chromePath() } : {}),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--mute-audio', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.log('PAGEERROR', (e.stack || e.message).split('\n')[0]));
await page.goto(`http://127.0.0.1:${PORT}/index.html`);
await page.waitForFunction(() => window.NUKEHAUS && window.NUKEHAUS.game, { timeout: 90000 });
await sleep(700);
await page.mouse.click(640, 400);        // dismiss the audio gate so it isn't in shot
await sleep(500);

// Lock resolution high so the shots show the game at its best.
await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  g.resLocked = true; g.resScale = 1.25;
  g.player.hurt = () => {};
  window.S = {
    /** Put the player on the biggest open deck cell of the current level. */
    onDeck(level) {
      g.loadLevel(level); g.setState('play');
      const lv = g.level;
      lv.roofTarget = 1;
      for (let i = 0; i < 200; i++) lv.updateRoof(0.05);
      let best = null, bestScore = -1;
      for (let y = 2; y < lv.H - 2; y++) for (let x = 2; x < lv.W - 2; x++) {
        const i = y * lv.W + x;
        if (!lv.roofPanel[i] || lv.wall[i]) continue;
        let open = 0;
        for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
          const j = (y + dy) * lv.W + (x + dx);
          if (j >= 0 && j < lv.wall.length && !lv.wall[j]) open++;
        }
        if (open > bestScore) { bestScore = open; best = [x + 0.5, y + 0.5]; }
      }
      if (best) { g.player.x = best[0]; g.player.y = best[1]; }
      return best;
    },
    /** Nearest standable cell to a point, so shots never start inside a wall. */
    standNear(x, y, minD = 2.2, maxD = 6) {
      const lv = g.level;
      let best = null, bestErr = 1e9;
      for (let yy = 1; yy < lv.H - 1; yy++) for (let xx = 1; xx < lv.W - 1; xx++) {
        const cx = xx + 0.5, cy = yy + 0.5;
        if (lv.blocked(cx, cy)) continue;
        const d = Math.hypot(cx - x, cy - y);
        if (d < minD || d > maxD) continue;
        if (!lv.lineOfSight(cx, cy, x, y)) continue;
        const err = Math.abs(d - (minD + maxD) / 2);
        if (err < bestErr) { bestErr = err; best = [cx, cy]; }
      }
      if (best) { g.player.x = best[0]; g.player.y = best[1]; }
      g.player.ang = Math.atan2(y - g.player.y, x - g.player.x);
      return best;
    },
    lookAt(az, elevDeg) {
      g.player.ang = az;
      g.player.pitch = Math.tan(elevDeg * Math.PI / 180) * g.rc.projY;
    },
    /** Hand-place a flight of warheads on a bearing at a chosen range. */
    flight(azOffset, count, range, alt, type = 'stick') {
      const out = [];
      for (let i = 0; i < count; i++) {
        const w = g.sky.spawnWarhead(type, 1);
        const az = g.sky.cities[0].az + azOffset + (i - count / 2) * 0.05;
        w.x = g.sky.cx + Math.cos(az) * range;
        w.y = g.sky.cy + Math.sin(az) * range;
        w.z = alt + i * 3;
        w._aim();
        for (let k = 0; k < 40; k++) {           // lay down a contrail
          w.trail.push(w.x - w.vx * k * 0.09, w.y - w.vy * k * 0.09, w.z - w.vz * k * 0.09);
        }
        out.push(w);
      }
      return out;
    },
    step(sec) { for (let i = 0; i < Math.round(sec * 60); i++) g.update(1 / 60, g.input); },
    clearHud() { g.hud.banner = null; g.hud.subtitle = null; g.hud.popups.length = 0; },
  };
});

const shot = async (n) => { await page.screenshot({ path: path.join(OUT, n + '.png') }); console.log('  ', n); };

// 1. The defining shot: on a deck, horizon in view, a flight coming in.
await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  window.S.onDeck(0);
  const az = g.sky.cities[0].az;
  window.S.lookAt(az, 9);
  window.S.flight(0.02, 4, 78, 34);
  window.S.flight(0.5, 3, 92, 48, 'mirv');
  g.player.autoFuse = true;
  window.S.step(0.5);
  window.S.clearHud();
});
await sleep(900); await shot('01-horizon-flight');

// 2. Looking up into a full sky.
await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  window.S.lookAt(g.sky.cities[1].az, 42);
  window.S.flight(1.0, 3, 60, 46, 'screamer');
  window.S.step(0.4); window.S.clearHud();
});
await sleep(700); await shot('02-looking-up');

// 3. A chain going off.
await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  window.S.onDeck(0);
  const az = g.sky.cities[2].az;
  window.S.lookAt(az, 16);
  const f = window.S.flight(0, 5, 62, 26);
  const t = f[0];
  const p = g.player;
  const d = Math.hypot(t.x - p.x, t.y - p.y, t.z - p.z);
  p.ang = Math.atan2(t.y - p.y, t.x - p.x);
  p.pitch = ((t.z - p.z) / Math.hypot(t.x - p.x, t.y - p.y)) * g.rc.projY;
  p.fuse = d; p.autoFuse = false;
  g.tryFire();
  window.S.step(0.72);
  window.S.clearHud();
});
await sleep(600); await shot('03-chain');

// 4. Corridor combat with enemies.
await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  g.loadLevel(1); g.setState('play');
  const e = g.enemies.find((x) => x.kind === 'priest') || g.enemies[0];
  window.S.standNear(e.x, e.y, 2.6, 7);
  g.player.pitch = 0;
  for (const o of g.enemies) if (Math.hypot(o.x - e.x, o.y - e.y) < 9) o.wake(g);
  window.S.step(1.1);
  window.S.clearHud();
});
await sleep(600); await shot('04-corridor-fight');

// 5. The boss.
await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  g.loadLevel(g.totalLevels - 1); g.setState('play');
  const lv = g.level;
  lv.roofTarget = 1; for (let i = 0; i < 200; i++) lv.updateRoof(0.05);
  const b = g.enemies.find((e) => e.kind === 'boss');
  if (b) {
    window.S.standNear(b.x, b.y, 4.5, 9);
    g.player.pitch = g.rc.projY * 0.14;
    b.wake(g);
  }
  window.S.step(0.9); window.S.clearHud();
});
await sleep(600); await shot('05-boss');

// 6. A city dying, a beat after the flash.
await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  window.S.onDeck(2);
  const c = g.sky.cities[3];
  window.S.lookAt(c.az, 11);
  const w = g.sky.spawnWarhead('stick', 1);
  w.target = c; w.x = c.x; w.y = c.y; w.z = 3; w._aim();
  window.S.step(1.4);
  g.hud.banner = null; g.hud.subtitle = null;
});
await sleep(600); await shot('06-city-lost');

// 7. Each weapon in hand.
for (const [i, wep] of ['pistol', 'splitter', 'nailer', 'halo', 'deadman'].entries()) {
  await page.evaluate((w) => {
    const g = window.NUKEHAUS.game;
    g.player.owned[w] = true; g.player.weapon = w; g.player.pendingWeapon = null; g.player.swapT = 0;
    g.player.ammo.flak = 120; g.player.ammo.nail = 200; g.player.ammo.charge = 3;
    window.S.clearHud();
    window.S.step(0.2);
  }, wep);
  await sleep(350);
  await shot(`07-weapon-${i}-${wep}`);
}

// 8. A wider look at each level's deck.
for (let L = 0; L < 5; L++) {
  await page.evaluate((lv) => {
    const g = window.NUKEHAUS.game;
    window.S.onDeck(lv);
    window.S.lookAt(g.sky.cities[lv % 6].az, 7);
    window.S.flight(0.1, 3, 74, 30);
    g.player.owned.splitter = true; g.player.weapon = 'splitter';
    window.S.step(0.4); window.S.clearHud();
  }, L);
  await sleep(600);
  await shot(`08-deck-L${L + 1}`);
}

console.log('\nshots in', OUT);
await browser.close();
server.kill('SIGKILL');
