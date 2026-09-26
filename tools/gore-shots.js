// gore-shots.js - stages dismemberment moments and photographs them, so the
// gore can be judged frame by frame instead of in a blur of play.
//
//   GORE_OUT=/some/dir TOOL_PORT=9104 node tools/gore-shots.js [--stub]
//
// --stub paints a crude stand-in for the sprite generator's maim() and part
// frames, for previewing on a build that does not have them yet. It lives in
// this file only and never ships.
import { chromium } from 'playwright-core';
import { chromePath } from './chrome-path.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const OUT = process.env.GORE_OUT || '/tmp/gore-shots';
const PORT = Number(process.env.TOOL_PORT || 8149);
const STUB = process.argv.includes('--stub');
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

await page.evaluate(async (stub) => {
  const g = window.NUKEHAUS.game;
  const art = window.NUKEHAUS.art;
  const gore = await import('/src/game/gore.js');
  g.resLocked = true; g.resScale = 1.25;
  g.player.hurt = () => {};
  // Freeze the simulation between staged steps; the renderer keeps drawing.
  const realUpdate = g.update.bind(g);
  g._frozen = false;
  g.update = (dt, input) => { if (!g._frozen) realUpdate(dt, input); };

  if (stub && typeof art.maim !== 'function') {
    const R = gore.RIG_DEFAULT;
    const cache = new Map();
    const RED = 0xff2018c0, BONE = 0xffc8d8e8, DARK = 0xff101060;
    const put = (o, x, y, c) => { x |= 0; y |= 0; if (x >= 0 && y >= 0 && x < o.w && y < o.h) o.data[y * o.w + x] = c; };
    const stump = (o, cx, cy, r) => {
      for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) {
        const d = Math.hypot(x, y);
        if (d <= r) put(o, cx + x, cy + y, d < r * 0.45 ? BONE : d < r * 0.8 ? RED : DARK);
      }
      for (let k = 0; k < 3; k++) for (let y = 0; y < 3 + k * 2; y++) put(o, cx - r + k * r, cy + r + y, RED);
    };
    art.maim = (key, mask) => {
      const f = art.sprites[key];
      const kind = key.split('_')[0];
      const r = R[kind];
      if (!f || !r || gore.QUADRUPED[kind]) return null;
      if (!mask) return f;
      const ck = key + '|' + mask;
      if (cache.has(ck)) return cache.get(ck);
      const o = { w: f.w, h: f.h, data: f.data.slice() };
      const row = (fr) => Math.round(f.h - 1 - fr * (f.h - 1));
      const m = /walk(\d)/.exec(key);
      const D = m ? +m[1] : 0;
      const cx = f.w / 2;
      // Which screen side is the character's right: facing you, it is your left.
      const rightX = D === 2 ? 1 : D === 0 ? -1 : D === 1 ? 0 : 0;
      const neck = row(r.neck), hip = row(r.hip), sh = row(r.shoulder);
      const clear = (x0, y0, x1, y1) => {
        for (let y = Math.max(0, y0); y < Math.min(f.h, y1); y++) for (let x = Math.max(0, x0); x < Math.min(f.w, x1); x++) o.data[y * f.w + x] = 0;
      };
      if (/die|dead/.test(key)) { cache.set(ck, null); return null; }
      if (mask & 1) { clear(0, 0, f.w, neck); stump(o, cx, neck, 3); }
      const half = f.w * 0.17;
      for (const [bit, s, arm] of [[2, 1, true], [4, -1, true], [8, 1, false], [16, -1, false]]) {
        if (!(mask & bit)) continue;
        let sx = rightX * s;
        if (sx === 0) sx = s * (D === 1 ? 1 : -1);
        if (arm) {
          if (sx < 0) clear(0, sh - 4, cx - half, hip + 10); else clear(cx + half, sh - 4, f.w, hip + 10);
          stump(o, cx + sx * half, sh + 1, 2);
        } else {
          if (sx < 0) clear(0, hip + 1, cx, f.h); else clear(cx, hip + 1, f.w, f.h);
          stump(o, cx + sx * half * 0.6, hip + 2, 3);
        }
      }
      cache.set(ck, o);
      return o;
    };
    art.rig = R;
    // Parts: crops of the standing frame, turned in eighths.
    for (const kind of ['wrencher', 'sparker', 'bellows', 'priest', 'howler', 'gorger']) {
      const f = art.sprites[`${kind}_walk0_0`];
      if (!f) continue;
      const r = R[kind];
      const row = (fr) => Math.round(f.h - 1 - fr * (f.h - 1));
      const crop = (x0, y0, x1, y1) => {
        const S = Math.max(x1 - x0, y1 - y0);
        const o = { w: S, h: S, data: new Uint32Array(S * S) };
        const ox = ((S - (x1 - x0)) / 2) | 0, oy = ((S - (y1 - y0)) / 2) | 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
          if (x < 0 || y < 0 || x >= f.w || y >= f.h) continue;
          o.data[(y - y0 + oy) * S + (x - x0 + ox)] = f.data[y * f.w + x];
        }
        return o;
      };
      const neck = row(r.neck), hip = row(r.hip), sh = row(r.shoulder);
      const parts = {
        head: crop(f.w / 2 - 12, 0, f.w / 2 + 12, neck + 2),
        arm: crop(0, sh - 3, f.w * 0.36, hip + 10),
        leg: crop(f.w * 0.2, hip, f.w * 0.52, f.h),
      };
      for (const [name, base] of Object.entries(parts)) {
        for (let k = 0; k < 8; k++) art.sprites[`${kind}_part_${name}_${k}`] = gore.rotFrame(base, k * Math.PI / 4);
      }
    }
  }

  window.S = {
    gore,
    /** An indoor spot with room in front of it and a wall behind the targets. */
    arena(level = 1) {
      g.loadLevel(level); g.setState('play');
      g.enemies.length = 0;
      const lv = g.level;
      let best = null, bestScore = -1;
      for (let y = 3; y < lv.H - 3; y++) for (let x = 3; x < lv.W - 3; x++) {
        if (lv.wall[y * lv.W + x] || lv.sky[y * lv.W + x]) continue;
        // Want a run of at least five open cells east, then a wall.
        let run = 0;
        while (run < 9 && !lv.wall[y * lv.W + x + run + 1] && x + run + 1 < lv.W) run++;
        if (run < 5 || run > 7) continue;
        let open = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = 0; dx <= run; dx++) if (!lv.wall[(y + dy) * lv.W + x + dx]) open++;
        if (open > bestScore) { bestScore = open; best = [x + 0.5, y + 0.5, run]; }
      }
      g.player.x = best[0]; g.player.y = best[1]; g.player.ang = 0; g.player.pitch = 0;
      g.player.z = 0.5;
      return best;
    },
    spawn(kind, dx, dy, face = Math.PI) {
      const { Enemy } = window.__ENT;
      const e = new Enemy(kind, g.player.x + dx, g.player.y + dy);
      e.ang = face;
      e.state = 1;
      g.enemies.push(e);
      return e;
    },
    step(sec) { g._frozen = false; for (let i = 0; i < Math.round(sec * 60); i++) g.update(1 / 60, g.input); g._frozen = true; },
    clearHud() { g.hud.banner = null; g.hud.subtitle = null; },
    arm(key) {
      g.player.owned[key] = true; g.player.weapon = key; g.player.pendingWeapon = null; g.player.swapT = 0;
      g.player.ammo.flak = 200; g.player.ammo.nail = 400; g.player.cooldown = 0;
    },
    aimAt(x, y, z) {
      const p = g.player;
      p.ang = Math.atan2(y - p.y, x - p.x);
      p.pitch = ((z - p.z) / Math.hypot(x - p.x, y - p.y)) * g.rc.projY;
    },
  };
  window.__ENT = await import('/src/game/entities.js');
}, STUB);

const shot = async (n) => {
  await sleep(450);
  await page.screenshot({ path: path.join(OUT, n + '.png') });
  console.log('  ', n);
};

// 1. A nail to the shin: the leg leaves, the rest keeps coming.
let info = await page.evaluate(() => {
  const g = window.NUKEHAUS.game, S = window.S;
  S.arena(1); S.arm('nailer');
  const e = S.spawn('wrencher', 3.2, -0.9, Math.PI);
  e.hp = e.maxHp = 400;
  let shots = 0;
  while (!(e.maim & 24) && shots < 30) {
    S.aimAt(e.x, e.y + 0.12, e.z + e.height * 0.18);
    g.player.cooldown = 0; g.tryFire(); shots++;
    S.step(1 / 60);
  }
  S.step(0.16); S.clearHud();
  S.aimAt(e.x + 0.3, e.y + 0.3, 0.45);
  return { shots, maim: e.maim, parts: S.gore && g.gore.parts.length };
});
console.log('leg', info);
await shot('01-nail-leg-off');
await page.evaluate(() => { window.S.step(1.2); window.S.clearHud(); });
await shot('02-one-leg-hopping');

// 3. A burst at head height: the head goes up, the body goes for a run.
info = await page.evaluate(() => {
  const g = window.NUKEHAUS.game, S = window.S;
  S.arena(1);
  const e = S.spawn('sparker', 3.4, -0.8, Math.PI);
  S.aimAt(e.x, e.y + 0.4, 0.62);
  g.gore.sever(e, 1, 1, 0, 6);
  S.step(0.22); S.clearHud();
  return { headless: e.headlessT, state: e.state };
});
console.log('head', info);
await shot('03-head-pop');
await page.evaluate(() => { window.S.step(0.7); window.S.clearHud(); });
await shot('04-headless-runner');

// 5. A pipe bomb in a crowd.
info = await page.evaluate(() => {
  const g = window.NUKEHAUS.game, S = window.S;
  S.arena(1);
  const a = S.spawn('wrencher', 3.6, -0.5, Math.PI);
  const b = S.spawn('sparker', 4.0, 0.45, Math.PI);
  const c = S.spawn('priest', 4.6, -0.1, Math.PI);
  const WEAP = { spec: { blastRadius: 6.2, damage: 130, gore: { sever: 0.9, head: 0.5, parts: 4, knock: 18, gib: 70, lift: 5 } } };
  g.detonateBomb({ x: g.player.x + 3.9, y: g.player.y, z: 0.3, spec: WEAP.spec });
  S.step(0.2); S.clearHud();
  return { maims: [a.maim, b.maim, c.maim], parts: g.gore.parts.length, gibs: g.gore.gibs.length };
});
console.log('bomb', info);
await shot('05-pipebomb-crowd');
await page.evaluate(() => { window.S.step(0.35); window.S.clearHud(); });
await shot('06-pipebomb-tumble');
await page.evaluate(() => { window.S.step(3.5); window.S.clearHud(); });
await shot('07-aftermath');

// 8. Walk up and punt a head.
info = await page.evaluate(() => {
  const g = window.NUKEHAUS.game, S = window.S;
  const run = S.arena(1)[2];
  const e = S.spawn('wrencher', 1.1, 0, Math.PI);
  g.gore.sever(e, 1, 1, 0, 1, { vx: 0.2, vy: 0, vz: 1, noRun: true });
  g.enemies.length = 0;
  S.step(1.2);
  const h = g.gore.parts.find((c) => c.head);
  const p = g.player;
  p.x = h.x - 0.9; p.y = h.y; p.ang = 0; p.pitch = g.rc.projY * 0.1;
  p.kickCooldown = 0;
  g.tryKick();
  S.step(0.2); S.clearHud();
  return { run, vx: h.vx, vz: h.vz, punted: h.punted };
});
console.log('punt', info);
await shot('08-punt');
await page.evaluate(() => { window.S.step(1.0); });
await shot('08b-punt-landed');

// 9. The legless keep crawling.
info = await page.evaluate(() => {
  const g = window.NUKEHAUS.game, S = window.S;
  S.arena(1);
  const e = S.spawn('wrencher', 4.4, -1.0, Math.PI);
  e.hp = e.maxHp = 400;
  g.gore.sever(e, 8, 0, 1, 4);
  g.gore.sever(e, 16, 0, -1, 4);
  S.step(1.1); S.clearHud();
  S.aimAt(e.x, e.y, 0.3);
  return { crawl: e.crawl, zOff: e.zOff, mob: e.mobility };
});
console.log('crawl', info);
await shot('09-crawler');

// 10. Blood up the wall and something stuck to it.
await page.evaluate(() => {
  const g = window.NUKEHAUS.game, S = window.S;
  const run = S.arena(1)[2];
  const e = S.spawn('wrencher', 2.0, 0, Math.PI);
  e.hp = 1;
  e.hurt(99, g, g.player.x, g.player.y);
  g.gore.launch(e, 1, 0, 20, 4);
  g.gib(e);
  S.step(0.5); S.clearHud();
});
await shot('10-wall-slam');

// 11. Sixty parts on the floor.
info = await page.evaluate(() => {
  const g = window.NUKEHAUS.game, S = window.S;
  S.arena(1);
  const e = S.spawn('wrencher', 3, 0, Math.PI);
  for (let i = 0; i < 60; i++) {
    const a = i * 2.4;
    g.gore.spawnPart(e, ['head', 'arm', 'leg'][i % 3], e.x + Math.cos(a) * 1.2, e.y + Math.sin(a) * 1.2, 0.8,
      Math.cos(a) * 3, Math.sin(a) * 3, 3);
  }
  e.alive = false; e.state = 7; e.gibbed = true;
  S.step(2.5); S.clearHud();
  const time = () => {
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) { g._frozen = false; g.update(1 / 60, g.input); g._frozen = true; window.NUKEHAUS.renderOnce(); }
    return +((performance.now() - t0) / 20).toFixed(2);
  };
  const withParts = time();
  const saved = g.gore.parts.splice(0);
  const without = time();
  g.gore.parts.push(...saved);
  return { withParts, without, parts: g.gore.parts.length };
});
console.log('sixty', info);
await shot('11-sixty-parts');

console.log('\nshots in', OUT);
await browser.close();
server.kill('SIGKILL');
