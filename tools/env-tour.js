// env-tour.js - walks each level's interiors and photographs the dressing, so
// "does this corridor still look copy-pasted?" is answered by looking.
//
//   TOOL_PORT=9109 ENV_OUT=/some/dir node tools/env-tour.js [shotsPerLevel]
//
// Spots are chosen the same way every run: open floor well away from the
// previous pick, facing down the longest clear sightline, never on a deck.
import { chromium } from 'playwright-core';
import { chromePath } from './chrome-path.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const OUT = process.env.ENV_OUT || '/tmp/claude-0/-home-user-MComm/1d9ae501-9927-5c9d-832d-0ee312d588ac/scratchpad/env-tour';
const PORT = Number(process.env.TOOL_PORT || 8151);
const PER = Number(process.argv[2] || 4);
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
const errors = [];
page.on('pageerror', (e) => { errors.push(e.message); console.log('PAGEERROR', (e.stack || e.message).split('\n')[0]); });
await page.goto(`http://127.0.0.1:${PORT}/index.html`);
await page.waitForFunction(() => window.NUKEHAUS && window.NUKEHAUS.game, { timeout: 90000 });
await sleep(700);
await page.mouse.click(640, 400);
await sleep(500);

for (let L = 0; L < 5; L++) {
  const spots = await page.evaluate(([lvl, per]) => {
    const g = window.NUKEHAUS.game;
    g.resLocked = true; g.resScale = 1.25;
    g.player.hurt = () => {};
    g.loadLevel(lvl); g.setState('play');
    const lv = g.level;
    const cand = [];
    for (let y = 2; y < lv.H - 2; y++) {
      for (let x = 2; x < lv.W - 2; x++) {
        const i = y * lv.W + x;
        if (lv.wall[i] || lv.roofPanel[i] || lv.blocked(x + 0.5, y + 0.5)) continue;
        let best = 0, bestA = 0;
        for (let a = 0; a < 8; a++) {
          const ang = a * Math.PI / 4;
          let d = 0;
          while (d < 20 && !lv.opaque(x + 0.5 + Math.cos(ang) * d, y + 0.5 + Math.sin(ang) * d)) d += 0.5;
          if (d > best) { best = d; bestA = ang; }
        }
        if (best > 7) cand.push([x + 0.5, y + 0.5, bestA]);
      }
    }
    const out = [];
    let s = 777 + lvl;
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    for (let k = 0; k < 600 && out.length < per; k++) {
      const c = cand[(rnd() * cand.length) | 0];
      if (c && out.every((q) => Math.hypot(q[0] - c[0], q[1] - c[1]) > 9)) out.push(c);
    }
    return out;
  }, [L, PER]);
  for (let k = 0; k < spots.length; k++) {
    await page.evaluate(([x, y, a]) => {
      const g = window.NUKEHAUS.game;
      const p = g.player;
      // Nobody moves while the photographer works.
      for (const e of g.enemies) { e.update = () => {}; }
      p.x = x; p.y = y; p.ang = a; p.pitch = 0;
      for (let i = 0; i < 12; i++) g.update(1 / 60, g.input);
      g.hud.banner = null; g.hud.subtitle = null; g.hud.popups.length = 0;
    }, spots[k]);
    await sleep(350);
    const file = path.join(OUT, `L${L + 1}-${k}.png`);
    await page.screenshot({ path: file });
    console.log('  ', path.basename(file));
  }
}
console.log(errors.length ? `${errors.length} page errors` : 'no page errors');
console.log('\nshots in', OUT);
await browser.close();
server.kill('SIGKILL');
process.exitCode = errors.length ? 1 : 0;
