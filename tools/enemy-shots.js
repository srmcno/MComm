// enemy-shots.js - lines the cast up in a lit room and photographs every kind
// walking, turning, winding up, attacking, flinching and dying, so enemy art
// is judged where it is actually seen: in the renderer, at game distances.
//
//   ENEMY_OUT=/some/dir TOOL_PORT=9801 node tools/enemy-shots.js [kind ...]
import { chromium } from 'playwright-core';
import { chromePath } from './chrome-path.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const OUT = process.env.ENEMY_OUT || '/tmp/enemy-shots';
const PORT = Number(process.env.TOOL_PORT || 8151);
const ONLY = process.argv.slice(2);
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
page.on('pageerror', (e) => console.log('PAGEERROR', (e.stack || e.message).split('\n').slice(0, 3).join(' | ')));
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text()); });
await page.goto(`http://127.0.0.1:${PORT}/index.html`);
await page.waitForFunction(() => window.NUKEHAUS && window.NUKEHAUS.game, { timeout: 90000 });
await sleep(700);
await page.mouse.click(640, 400);
await sleep(500);

await page.evaluate(async () => {
  const g = window.NUKEHAUS.game;
  const { Enemy, ST } = await import('/src/game/entities.js');
  g.resLocked = true; g.resScale = 1.25;
  g.player.hurt = () => {};
  const realUpdate = g.update.bind(g);
  g._frozen = false;
  g.update = (dt, input) => { if (!g._frozen) realUpdate(dt, input); };

  /** The indoor cell with the longest clear, wide view down +x. */
  function stage(level) {
    g._frozen = false;
    g.loadLevel(level); g.setState('play');
    const lv = g.level;
    let best = null, bestScore = -1;
    for (let y = 4; y < lv.H - 4; y++) {
      for (let x = 1; x < lv.W - 8; x++) {
        let n = 0;
        for (let dx = 0; dx <= 7; dx++) {
          let ok = true;
          for (let dy = -3; dy <= 3; dy++) if (lv.blocked(x + dx + 0.5, y + dy + 0.5)) { ok = false; break; }
          if (!ok) break;
          n++;
        }
        const i = y * lv.W + x;
        const score = n - (lv.sky && lv.sky[i] ? 3 : 0);
        if (score > bestScore) { bestScore = score; best = [x + 0.5, y + 0.5]; }
      }
    }
    g.player.x = best[0]; g.player.y = best[1]; g.player.ang = 0; g.player.pitch = 0;
    return best;
  }

  const ang = (e) => Math.atan2(g.player.y - e.y, g.player.x - e.x);
  window.E = {
    stage,
    /** Replace the level's crew with these, frozen in the given poses. */
    place(list) {
      g._frozen = true;
      g.enemies.length = 0;
      if (g.gore && g.gore.reset) g.gore.reset();
      const p = g.player;
      for (const s of list) {
        const e = new Enemy(s.kind, p.x + s.d, p.y + s.lat);
        e.state = ST[s.st || 'CHASE'];
        e.ang = ang(e) + (s.turn || 0);
        e.painFlash = 0;
        for (const [k, v] of Object.entries(s.set || {})) e[k] = v;
        if (e.state === ST.DYING || e.state === ST.DEAD) e.alive = false;
        g.enemies.push(e);
      }
      g.hud.banner = null; g.hud.subtitle = null; g.hud.popups.length = 0;
    },
  };
});

const shot = async (n) => {
  await sleep(450);
  await page.screenshot({ path: path.join(OUT, n + '.png'), clip: { x: 0, y: 140, width: 1280, height: 480 } });
  console.log('  ', n);
};

const KINDS = ['wrencher', 'sparker', 'bellows', 'priest', 'wasp', 'ghoul', 'gorger', 'howler', 'stalker'];
const kinds = ONLY.length ? KINDS.filter((k) => ONLY.includes(k)) : KINDS;

await page.evaluate(() => window.E.stage(1));

// Per kind: a row of movement poses, then a row of action poses.
for (const kind of kinds) {
  // walk: front at two points of the stride, the right side, the back, the left side, standing idle
  await page.evaluate((kind) => {
    const row = [
      { st: 'CHASE', set: { animFrame: 0, walkDist: 0 } },
      { st: 'CHASE', set: { animFrame: 2, walkDist: 0.5 } },
      { st: 'CHASE', turn: Math.PI / 2, set: { animFrame: 1, walkDist: 0.3 } },
      { st: 'CHASE', turn: Math.PI / 2, set: { animFrame: 3, walkDist: 0.8 } },
      { st: 'CHASE', turn: Math.PI, set: { animFrame: 1, walkDist: 0.3 } },
      { st: 'CHASE', turn: -Math.PI / 2, set: { animFrame: 2, walkDist: 0.6 } },
      { st: 'IDLE', set: { animFrame: 0 } },
    ];
    window.E.place(row.map((r, i) => ({ kind, d: 4.4, lat: (i - 3) * 0.86, ...r })));
  }, kind);
  await shot(`${kind}-a-move`);
  await page.evaluate((kind) => {
    const row = [
      { st: 'WINDUP', set: { stateT: 0.05 } },
      { st: 'WINDUP', set: { stateT: 10 } },
      { st: 'ATTACK', set: { stateT: 0.02 } },
      { st: 'ATTACK', set: { stateT: 0.18 } },
      { st: 'CHASE', set: { recoverT: 0.2 } },
      { st: 'PAIN', set: { painFlash: 0.6, painVar: 0, stateT: 0.05 } },
      { st: 'PAIN', set: { painFlash: 0.6, painVar: 1, stateT: 0.05 } },
    ];
    window.E.place(row.map((r, i) => ({ kind, d: 4.8, lat: (i - 3) * 0.95, ...r })));
  }, kind);
  await shot(`${kind}-b-act`);
  await page.evaluate((kind) => {
    const row = [0.5, 1.5, 2.5, 3.5, 4.5, 5.5].map((df) => ({ st: 'DYING', set: { deathFrame: df } }));
    row.push({ st: 'DEAD', set: { deathFrame: 99 } });
    window.E.place(row.map((r, i) => ({ kind, d: 4.8, lat: (i - 3) * 1.05, ...r })));
  }, kind);
  await shot(`${kind}-c-die`);
  // close-up, walking straight at the camera
  await page.evaluate((kind) => {
    window.E.place([{ kind, d: 1.9, lat: -0.55, st: 'CHASE', set: { animFrame: 1, walkDist: 0.2 } },
      { kind, d: 1.9, lat: 0.55, st: 'CHASE', turn: Math.PI / 2, set: { animFrame: 3, walkDist: 0.7 } }]);
  }, kind);
  await shot(`${kind}-d-close`);
  // close-up of the attack: wound up, the strike, the follow-through
  await page.evaluate((kind) => {
    window.E.place([{ kind, d: 2.9, lat: -1.15, st: 'WINDUP', set: { stateT: 10 } },
      { kind, d: 2.9, lat: 0, st: 'ATTACK', set: { stateT: 0.02 } },
      { kind, d: 2.9, lat: 1.15, st: 'ATTACK', set: { stateT: 0.18 } }]);
  }, kind);
  await shot(`${kind}-e-close-attack`);
}

// The whole roster at fighting distance, for readability against the room.
await page.evaluate((kinds) => {
  window.E.place(kinds.map((kind, i) => ({ kind, d: 6.2 + (i % 2) * 1.0, lat: (i - (kinds.length - 1) / 2) * 0.72,
    st: 'CHASE', set: { animFrame: i, walkDist: i * 0.37 } })));
}, kinds);
await shot('zz-roster-far');

console.log('\nshots in', OUT);
await browser.close();
server.kill('SIGKILL');
