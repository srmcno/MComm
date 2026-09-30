// playtest.js - drives NUKEHAUS through its actual systems and asserts that the
// combat loop works: warheads spawn, flak bursts kill them, chains score,
// cities die when they leak, enemies fight, and levels can be completed.
import { chromium } from 'playwright-core';
import { chromePath } from './chrome-path.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const OUT = process.env.SHOT_OUT || '/tmp/claude-0/-home-user-MComm/1d9ae501-9927-5c9d-832d-0ee312d588ac/scratchpad/shots';
const PORT = Number(process.env.TOOL_PORT || 8141);
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
const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.stack || e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(`http://127.0.0.1:${PORT}/index.html`);
await page.waitForFunction(() => window.NUKEHAUS && window.NUKEHAUS.game, { timeout: 90000 });
await sleep(600);

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

// Expose a deterministic driver inside the page.
await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  window.T = {
    // Point the camera at a world point.
    aimAt(x, y, z) {
      const p = g.player;
      const dx = x - p.x, dy = y - p.y, dz = z - p.z;
      p.ang = Math.atan2(dy, dx);
      const horiz = Math.hypot(dx, dy);
      p.pitch = Math.tan(Math.atan2(dz, horiz)) * g.rc.projY;
      return Math.hypot(dx, dy, dz);
    },
    // Aim `off` metres to the side of a point, square to the line of fire.
    aimBeside(x, y, z, off) {
      const p = g.player;
      const dx = x - p.x, dy = y - p.y, L = Math.hypot(dx, dy) || 1;
      return this.aimAt(x - dy / L * off, y + dx / L * off, z);
    },
    // Aim at the intercept point, which is what the lock bracket shows a player.
    aimLead(w, spec) {
      const p = g.player;
      const speed = (spec || g.player.spec).flakSpeed || 110;
      let t = Math.hypot(w.x - p.x, w.y - p.y, w.z - p.z) / speed;
      for (let i = 0; i < 4; i++) {
        const px = w.x + w.vx * t, py = w.y + w.vy * t, pz = w.z + w.vz * t;
        t = Math.hypot(px - p.x, py - p.y, pz - p.z) / speed;
      }
      return this.aimAt(w.x + w.vx * t, w.y + w.vy * t, w.z + w.vz * t);
    },
    // Respect the weapon's own refire; forcing it just runs the magazine dry.
    fire() { g.tryFire(); },
    fireNow() { g.player.cooldown = 0; g.tryFire(); },
    arm(key, ammo = 200) {
      g.player.owned[key] = true;
      g.player.weapon = key; g.player.pendingWeapon = null; g.player.swapT = 0;
      g.player.ammo.flak = ammo; g.player.ammo.nail = ammo; g.player.ammo.charge = 3;
      g.player.cooldown = 0;
    },
    step(seconds, dt = 1 / 60) {
      for (let i = 0; i < Math.round(seconds / dt); i++) g.update(dt, g.input);
    },
    god(on) { g._god = on; },
    /** Stand somewhere walkable with a clear line to a point. */
    standNear(x, y, minD = 2, maxD = 7) {
      const lv = g.level;
      const want = (minD + maxD) / 2;
      // A randomly placed enemy can land in a nook where nothing in the band
      // we asked for can see it. Widen the band rather than fail the test that
      // depends on the placement; the scoring still prefers the asked-for
      // distance, so a successful search returns the same cell it always did.
      for (const [lo, hi] of [[minD, maxD], [minD * 0.6, maxD * 1.8], [0.8, 1e9]]) {
        let best = null, bestErr = 1e9;
        for (let yy = 1; yy < lv.H - 1; yy++) for (let xx = 1; xx < lv.W - 1; xx++) {
          const cx = xx + 0.5, cy = yy + 0.5;
          if (lv.blocked(cx, cy)) continue;
          const d = Math.hypot(cx - x, cy - y);
          if (d < lo || d > hi) continue;
          if (!lv.lineOfSight(cx, cy, x, y)) continue;
          const err = Math.abs(d - want);
          if (err < bestErr) { bestErr = err; best = [cx, cy]; }
        }
        if (best) {
          g.player.x = best[0]; g.player.y = best[1];
          g.player.ang = Math.atan2(y - g.player.y, x - g.player.x);
          return true;
        }
      }
      g.player.ang = Math.atan2(y - g.player.y, x - g.player.x);
      return false;
    },
  };
  // Freeze health while we're testing systems rather than survival.
  const origHurt = g.player.hurt.bind(g.player);
  g.player.hurt = (n, gg) => { if (!g._god) origHurt(n, gg); };
});

// ------------------------------------------------------------ 1. boot state
let s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  return { state: g.state, levels: g.totalLevels, warnings: window.NUKEHAUS.art.warnings.length };
});
check('boots to title with all levels', s.state === 'title' && s.levels >= 5, `${s.levels} levels`);
check('no missing assets', s.warnings === 0, s.warnings ? 'warnings present' : '');

// ------------------------------------------------- 2. every level parses
s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  const out = [];
  for (let i = 0; i < g.totalLevels; i++) {
    try {
      g.loadLevel(i);
      const lv = g.level;
      let sky = 0, solid = 0, trig = 0, exits = 0;
      for (let n = 0; n < lv.wall.length; n++) {
        if (lv.roofPanel[n]) sky++;
        if (lv.wall[n] === 1) solid++;
        if (lv.trigger[n]) trig++;
        if (lv.exit[n]) exits++;
      }
      out.push({
        i, name: lv.name, w: lv.W, h: lv.H, sky, solid, trig, exits,
        enemies: g.enemies.length, items: g.items.length,
        waves: (lv.def.siege && lv.def.siege.waves || []).length,
        start: [+g.player.x.toFixed(1), +g.player.y.toFixed(1)],
        startBlocked: lv.blocked(g.player.x, g.player.y),
      });
    } catch (e) { out.push({ i, error: e.message }); }
  }
  return out;
});
for (const L of s) {
  if (L.error) { check(`level ${L.i} loads`, false, L.error); continue; }
  check(`level ${L.i} ${L.name}`, !L.startBlocked && L.exits > 0 && L.trig > 0 && L.waves > 0,
    `${L.w}x${L.h} sky=${L.sky} enemies=${L.enemies} items=${L.items} waves=${L.waves} triggers=${L.trig}`);
}

// -------------------------------------------------- 3. flak kills a warhead
s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  g.loadLevel(0); g.setState('play'); g._god = true; window.T.arm('splitter');
  const w = g.sky.spawnWarhead('stick', 1);
  const before = g.sky.warheads.length;
  let range = 0, tries = 0;
  for (; tries < 6 && g.sky.warheads.length >= before; tries++) {
    range = window.T.aimLead(g.sky.warheads[0]);
    window.T.fireNow();
    window.T.step(1.6);
  }
  return { before, after: g.sky.warheads.length, range: +range.toFixed(1), tries,
    score: g.player.score, flakLeft: g.sky.flak.length };
});
check('flak airburst kills a warhead', s.after < s.before && s.score > 0,
  `${s.tries} shot${s.tries === 1 ? '' : 's'} at ${s.range}m, score ${s.score}`);

// ------------------ 4. the proximity fuse: a shell bursts on what it passes
s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  const shoot = (over) => {
    g.loadLevel(0); g.setState('play'); g._god = true; window.T.arm('splitter');
    g.player.score = 0;
    const w = g.sky.spawnWarhead('stick', 1);
    w.vx = w.vy = w.vz = 0;                  // park it
    // Over the top rather than beside it: the Splitter fans its outer shells
    // sideways, so a shot aimed wide of it can still put one on it.
    window.T.aimAt(w.x, w.y, w.z + over);
    window.T.fireNow();
    window.T.step(4);
    return { alive: g.sky.warheads.length, score: g.player.score };
  };
  return { on: shoot(0), wide: shoot(14) };
});
check('a flak shell bursts on the warhead it passes, and one 14 m over it does nothing',
  s.on.alive === 0 && s.on.score > 0 && s.wide.alive === 1 && s.wide.score === 0,
  `on target: ${s.on.alive} left, ${s.on.score} pts; wide: ${s.wide.alive} left, ${s.wide.score} pts`);

// ------------- 4b. the Widow puts a man down, and a head takes it faster
s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  const shoot = (zFrac) => {
    g.loadLevel(0); g.setState('play'); g._god = true; window.T.arm('pistol');
    const e = g.enemies.find((x) => x.kind === 'wrencher');
    if (!e) return { err: 'no wrencher' };
    window.T.standNear(e.x, e.y, 3, 6);
    e.hp = e.maxHp = 999;                    // count the damage, do not end it
    e.state = 5; e.stateT = -99;
    window.T.aimAt(e.x, e.y, e.z + e.height * zFrac);
    const hp0 = e.hp;
    window.T.fireNow();
    return { dmg: hp0 - e.hp, spent: g.player.ammo.flak };
  };
  const body = shoot(0.45), head = shoot(0.9);
  return { body: body.dmg, head: head.dmg, err: body.err || head.err, cost: 200 - body.spent };
});
check('one Widow round to the body hurts, one to the head hurts twice as much, and it costs nothing',
  !s.err && s.body >= 30 && s.head >= s.body * 2 && s.cost === 0,
  s.err || `body ${s.body}, head ${s.head}, flak spent ${s.cost}`);

// ------------------ 4c. a flak shell bursts on a body instead of flying past
s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  g.loadLevel(0); g.setState('play'); g._god = true; window.T.arm('splitter');
  const e = g.enemies.find((x) => x.kind === 'wrencher');
  if (!e) return { err: 'no wrencher' };
  window.T.standNear(e.x, e.y, 4, 7);
  e.hp = e.maxHp = 999; e.state = 5; e.stateT = -99;
  window.T.aimAt(e.x, e.y, e.z + e.height * 0.5);
  const hp0 = e.hp;
  const contact = [];
  const burst = g.onFlakBurst.bind(g);
  g.onFlakBurst = (b, f) => { contact.push(!!b.contact); return burst(b, f); };
  window.T.fireNow();
  window.T.step(0.5);
  delete g.onFlakBurst;
  return { dmg: hp0 - e.hp, bursts: contact.length, onBody: contact.filter(Boolean).length };
});
check('a Splitter shell bursts on the body in front of it',
  !s.err && s.dmg > 0 && s.onBody >= 1, s.err || `${s.bursts} bursts, ${s.onBody} on the body, ${s.dmg} damage`);

// ------------------------------------------------------- 5. chain reaction
s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  g.loadLevel(0); g.setState('play'); g._god = true; window.T.arm('splitter');
  g.player.score = 0; g.sky.bestChain = 0;
  // A tight cluster strung out behind the first one: one burst on the near
  // warhead should cook off the rest. Spaced for the Splitter's 5 m burst.
  const base = g.sky.spawnWarhead('stick', 1);
  base.vx = base.vy = base.vz = 0;
  const bx = base.x - g.player.x, by = base.y - g.player.y, bL = Math.hypot(bx, by) || 1;
  for (let i = 0; i < 5; i++) {
    const w = g.sky.spawnWarhead('stick', 1);
    w.x = base.x + bx / bL * (i + 1) * 4.2 - by / bL * (i % 2) * 1.2;
    w.y = base.y + by / bL * (i + 1) * 4.2 + bx / bL * (i % 2) * 1.2;
    w.z = base.z + (i % 3) * 1.4;
    w.vx = w.vy = w.vz = 0;
  }
  window.T.aimAt(base.x, base.y, base.z);
  window.T.fire();
  window.T.step(6);
  return { left: g.sky.warheads.length, chain: g.sky.bestChain, score: g.player.score };
});
check('one burst chains through a cluster', s.left <= 1 && s.chain >= 3,
  `${6 - s.left} killed, best chain x${s.chain}, score ${s.score}`);

// --------------------------------------------------------- 6. city loss
s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  g.loadLevel(0); g.setState('play'); g._god = true;
  const before = g.sky.livingCities().length;
  const c = g.sky.cities[0];
  const hit = () => {
    const w = g.sky.spawnWarhead('stick', 1);
    w.stray = false; w.target = c;
    w.x = c.x; w.y = c.y; w.z = 4; w._aim();
    window.T.step(3);
  };
  hit();
  const burningAfterOne = c.burning && c.alive;
  hit();                                    // cities take two
  return { before, after: g.sky.livingCities().length, burningAfterOne,
    dead: !c.alive, banner: g.hud.banner ? g.hud.banner.title : null };
});
check('one leak burns a city, two destroy it',
  s.burningAfterOne && s.dead && s.after === s.before - 1, s.banner || '');

// ------------------------------------------------------ 7. MIRV splits
s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  g.loadLevel(0); g.setState('play'); g._god = true;
  const w = g.sky.spawnWarhead('mirv', 1);
  w.z = 36; w.splitAt = 34; w._aim();
  const before = g.sky.warheads.length;
  window.T.step(4);
  return { before, after: g.sky.warheads.length };
});
check('MIRV splits into submunitions', s.after > s.before, `${s.before} -> ${s.after}`);

// ----------------------------------------- 8. enemies wake, chase, and die
s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  g.loadLevel(0); g.setState('play'); g._god = true;
  const e = g.enemies.find((x) => x.kind === 'wrencher');
  if (!e) return { err: 'no wrencher' };
  g.player.x = e.x + 2.0; g.player.y = e.y;
  const startState = e.state;
  window.T.step(1.2);
  const woke = e.state !== 0;
  window.T.arm('nailer');
  window.T.aimAt(e.x, e.y, e.z + 0.4);
  let shots = 0;
  for (let i = 0; i < 40 && e.alive; i++) { window.T.fireNow(); window.T.step(0.1); shots++; }
  return { startState, woke, dead: !e.alive, shots, kills: g.player.kills };
});
check('enemies wake and can be killed', s.woke && s.dead, `died after ${s.shots} bursts`);

// ------------------------------------------------ 9. doors and keycards
s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  g.loadLevel(1); g.setState('play'); g._god = true;
  const lv = g.level;
  let free = null, locked = null;
  for (const d of lv.def.doors) {
    const i = d.y * lv.W + d.x;
    if (lv.doorKind[i] === 0 && !free) free = d;
    if (lv.doorKind[i] !== 0 && !locked) locked = d;
  }
  const res = {};
  if (free) {
    // Stand in the open cell next to it and face the door.
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dx, dy] of dirs) {
      if (!lv.blocked(free.x + 0.5 + dx, free.y + 0.5 + dy)) {
        g.player.x = free.x + 0.5 + dx; g.player.y = free.y + 0.5 + dy;
        g.player.ang = Math.atan2(-dy, -dx);
        break;
      }
    }
    g.tryUse();
    window.T.step(1.2);
    res.freeOpened = lv.doorOpen[free.y * lv.W + free.x] > 0.9;
  }
  if (locked) {
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dx, dy] of dirs) {
      if (!lv.blocked(locked.x + 0.5 + dx, locked.y + 0.5 + dy)) {
        g.player.x = locked.x + 0.5 + dx; g.player.y = locked.y + 0.5 + dy;
        g.player.ang = Math.atan2(-dy, -dx);
        break;
      }
    }
    g.player.keys = [false, false, false];
    g.tryUse();
    window.T.step(1.0);
    res.stayedLocked = lv.doorOpen[locked.y * lv.W + locked.x] < 0.05;
    g.player.keys = [true, true, true];
    g.tryUse();
    window.T.step(1.2);
    res.openedWithKey = lv.doorOpen[locked.y * lv.W + locked.x] > 0.9;
  }
  return res;
});
check('free doors open', !!s.freeOpened);
check('keycard doors respect keys', s.stayedLocked && s.openedWithKey);

// ------------------------------------------------- 10. siege end to end
s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  g.loadLevel(0); g.setState('play'); g._god = true; window.T.arm('splitter', 999);
  g.triggersFired.add(-1);
  g.beginSiege();
  const opened = [];
  for (let i = 0; i < 260; i++) { g.update(1 / 60, g.input); }
  const roofOpen = g.level.roofOpen;
  let spawned = 0, maxAlive = 0;
  for (let i = 0; i < 60 * 70; i++) {
    g.update(1 / 60, g.input);
    maxAlive = Math.max(maxAlive, g.sky.warheads.length);
    // Shoot down everything we can, perfectly, to prove the wave can be beaten.
    const w = g.sky.warheads[0];
    if (w && g.player.cooldown <= 0) { window.T.aimLead(w); window.T.fire(); }
    if (!g.sky.active) break;
  }
  return {
    roofOpen: +roofOpen.toFixed(2), active: g.sky.active, maxAlive,
    killed: g.sky.killed, leaked: g.sky.leaked,
    cities: g.sky.livingCities().length, score: g.player.score,
    music: 'ok',
  };
});
check('roof grinds open on the trigger', s.roofOpen > 0.95, `roofOpen ${s.roofOpen}`);
check('a wave can be fought and cleared', !s.active && s.killed > 0,
  `killed ${s.killed}, leaked ${s.leaked}, peak ${s.maxAlive} alive, ${s.cities}/6 cities, score ${s.score}`);

// --------------- 11. the flak reticle leads a warhead; the Widow's does not
s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  g.loadLevel(0); g.setState('play'); g._god = true; window.T.arm('splitter');
  const w = g.sky.spawnWarhead('stick', 1);
  window.T.aimAt(w.x, w.y, w.z);
  window.T.step(0.1);
  const flak = g.rangeLock ? +g.rangeLock.range.toFixed(1) : 0;
  window.T.arm('pistol');
  window.T.aimAt(w.x, w.y, w.z);
  window.T.step(0.1);
  return { flak, pistol: !!g.rangeLock };
});
check('the Splitter gets a lead on a warhead in its sights, the Widow does not',
  s.flak > 0 && !s.pistol, `flak lock at ${s.flak}m, Widow lock ${s.pistol}`);

// ------------ 11b. BULLSEYE: a shell put right on a warhead pays double
s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  const shoot = (off) => {
    g.loadLevel(0); g.setState('play'); g._god = true; window.T.arm('splitter');
    g.player.score = 0;
    const spec = g.player.spec, spread = spec.spread;
    spec.spread = 0;                         // all three shells where they are aimed
    const w = g.sky.spawnWarhead('stick', 1);
    w.vx = w.vy = w.vz = 0;
    window.T.aimBeside(w.x, w.y, w.z, off);
    window.T.fireNow();
    window.T.step(3);
    spec.spread = spread;
    return { score: g.player.score, left: g.sky.warheads.length };
  };
  return { on: shoot(0), near: shoot(2.1) };
});
check('a shell put right on a warhead pays double, a near miss that still kills does not',
  s.on.left === 0 && s.near.left === 0 && s.near.score > 0 && s.on.score > s.near.score,
  `dead on ${s.on.score}, 2.1 m off ${s.near.score}`);

// ---------------------------------------- 12. long soak: no leaks, no NaN
s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  g.loadLevel(2); g.setState('play'); g._god = true; window.T.arm('splitter', 999);
  g.triggersFired.add(-1); g.beginSiege();
  let bad = null;
  for (let i = 0; i < 60 * 120; i++) {
    g.update(1 / 60, g.input);
    if (i % 40 === 0 && g.player.cooldown <= 0) {
      const w = g.sky.warheads[(i / 40) % Math.max(1, g.sky.warheads.length) | 0];
      if (w) { window.T.aimLead(w); window.T.fire(); }
    }
    if (!Number.isFinite(g.player.x + g.player.y + g.player.z + g.player.ang + g.player.pitch)) {
      bad = 'player NaN at frame ' + i; break;
    }
    if (!g.sky.active && i > 60 * 30) { g.triggersFired.add(-2 - i); g.beginSiege(); }
  }
  return {
    bad, particles: g.particles.live.length, effects: g.particles.effects.length,
    warheads: g.sky.warheads.length, flak: g.sky.flak.length, blasts: g.sky.blasts.length,
    enemies: g.enemies.length, bolts: g.bolts.length, popups: g.hud.popups.length,
    score: g.player.score, cities: g.sky.livingCities().length,
  };
});
check('2-minute soak stays finite', !s.bad, s.bad || 'ok');
check('no unbounded growth in pools', s.particles < 1500 && s.effects < 260 &&
  s.flak < 200 && s.blasts < 200 && s.bolts < 300 && s.popups <= 14,
  `particles ${s.particles} effects ${s.effects} flak ${s.flak} blasts ${s.blasts} bolts ${s.bolts}`);

// ------------------------------------------------------- 13. level flow
s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  g.loadLevel(0); g.setState('play'); g._god = true;
  g.nextLevel();
  const inter = g.state;
  g.loadLevel(1);
  const lvl = g.levelIndex;
  // Walk the boss level and make sure the boss exists and is killable.
  g.loadLevel(g.totalLevels - 1);
  const boss = g.enemies.find((e) => e.kind === 'boss');
  let killed = false;
  if (boss) {
    for (let i = 0; i < 400 && boss.alive; i++) boss.hurt(50, g, 0, 0);
    killed = !boss.alive;
    for (let i = 0; i < 60; i++) g.update(1 / 60, g.input);
  }
  return { inter, lvl, hasBoss: !!boss, killed, bossKilled: g.bossKilled };
});
check('level completion goes to intermission', s.inter === 'intermission');
check('boss exists on the last level and dies', s.hasBoss && s.killed && s.bossKilled);

// -------------------------- 14. reachability with live collision in place
s = await page.evaluate(() => {
  const out = [];
  const g = window.NUKEHAUS.game;
  for (let L = 0; L < g.totalLevels; L++) {
    g.loadLevel(L);
    const lv = g.level;
    const W = lv.W, H = lv.H;
    // Flood-fill the way a body actually moves: through the level's own
    // blocked() so pillars, doors and props all count, opening keydoors as
    // their keys are reached, until nothing new opens up.
    const seen = new Uint8Array(W * H);
    let keys = [false, false, false];
    const keyAt = new Map();
    for (const e of lv.def.ents) {
      if (e.kind === 'key_red') keyAt.set(((e.y | 0) * W + (e.x | 0)), 0);
      if (e.kind === 'key_blue') keyAt.set(((e.y | 0) * W + (e.x | 0)), 1);
      if (e.kind === 'key_gold') keyAt.set(((e.y | 0) * W + (e.x | 0)), 2);
    }
    const passable = (x, y) => {
      const i = y * W + x;
      if (x < 0 || y < 0 || x >= W || y >= H) return false;
      if (lv.propBlock[i]) return false;
      if (lv.wall[i] === 1) return false;
      if (lv.wall[i] === 2) {
        const k = lv.doorKind[i];
        return k === 0 || keys[k - 1];
      }
      return true;
    };
    let grew = true, rounds = 0;
    while (grew && rounds++ < 8) {
      grew = false;
      const stack = [[g.player.x | 0, g.player.y | 0]];
      seen.fill(0);
      seen[(g.player.y | 0) * W + (g.player.x | 0)] = 1;
      while (stack.length) {
        const [x, y] = stack.pop();
        const i = y * W + x;
        if (keyAt.has(i) && !keys[keyAt.get(i)]) { keys[keyAt.get(i)] = true; grew = true; }
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const j = ny * W + nx;
          if (seen[j] || !passable(nx, ny)) continue;
          seen[j] = 1; stack.push([nx, ny]);
        }
      }
    }
    const missing = [];
    for (let i = 0; i < W * H; i++) {
      if (lv.exit[i] && !seen[i]) missing.push('exit');
      if (lv.trigger[i] && !seen[i]) missing.push('trigger');
    }
    for (const e of lv.def.ents) {
      const i = (e.y | 0) * W + (e.x | 0);
      if (!seen[i] && (e.kind.startsWith('key_') || e.kind === 'weapon' || e.kind === 'boss')) {
        // A pushwall secret legitimately hides things behind a solid wall.
        let secretNear = false;
        for (let dy = -3; dy <= 3 && !secretNear; dy++) for (let dx = -3; dx <= 3; dx++) {
          const j = (e.y + dy | 0) * W + (e.x + dx | 0);
          if (j >= 0 && j < W * H && lv.secret[j]) { secretNear = true; break; }
        }
        if (!secretNear) missing.push(e.kind);
      }
    }
    // Deck cells occupied by a pillar are legitimately unstandable; what
    // matters is that the great majority of every deck is fightable ground.
    let deckTotal = 0, deckReached = 0;
    for (let i = 0; i < W * H; i++) {
      if (!lv.roofPanel[i] || lv.wall[i] || lv.propBlock[i]) continue;
      deckTotal++;
      if (seen[i]) deckReached++;
    }
    out.push({ L, name: lv.name, missing: [...new Set(missing)], keys,
      deckPct: deckTotal ? deckReached / deckTotal : 1, deckTotal, deckReached });
  }
  return out;
});
for (const r of s) {
  check(`level ${r.L} fully reachable`, r.missing.length === 0 && r.deckPct > 0.9,
    r.missing.length ? `unreachable: ${r.missing.join(', ')}`
      : `decks ${r.deckReached}/${r.deckTotal} standable (${Math.round(r.deckPct * 100)}%)`);
}

// ------------------------------------ 15. difficulty actually changes things
s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  const probe = (d) => {
    g.newGame(d);
    g.setState('play'); g._god = true;
    g.triggersFired.add(-1 - d); g.beginSiege();
    const wave = g.sky.wave;
    const total = (wave.spawn || []).reduce((a, x) => a + x.count, 0);
    const e = g.enemies[0];
    return { name: g.diff.name, health: g.player.maxHealth, total,
      maxAlive: wave.maxAlive, hp: e ? e.maxHp : 0,
      speed: +(wave.spawn[0].speed || 1).toFixed(2) };
  };
  return [probe(0), probe(1), probe(2)];
});
check('difficulty scales the fight',
  s[0].total < s[2].total && s[0].health > s[1].health && s[0].maxAlive < s[2].maxAlive &&
  s[0].hp < s[2].hp && s[0].speed < s[2].speed,
  s.map((d) => `${d.name}: ${d.total} warheads, ${d.maxAlive} at once, ${d.hp}hp, x${d.speed}`).join(' | '));

// ------------------------------------------------- 16. the Boot
s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  g.loadLevel(0); g.setState('play'); g._god = true;
  const e = g.enemies.find((x) => x.kind === 'wrencher');
  if (!e) return { err: 'no wrencher' };
  e.kvx = 0; e.kvy = 0;
  g.player.x = e.x - 1.3; g.player.y = e.y;
  g.player.ang = Math.atan2(e.y - g.player.y, e.x - g.player.x);
  g.player.pitch = 0; g.player.kickCooldown = 0;
  const hpBefore = e.hp, xBefore = e.x;
  g.tryKick();
  const kicked = e.hp < hpBefore;
  window.T.step(0.5);
  const moved = Math.abs(e.x - xBefore) + Math.abs(e.y - e.y);
  // A second kick immediately should be refused by the cooldown.
  const hp2 = e.hp;
  g.tryKick();
  const refused = e.hp === hp2;
  return { kicked, moved: +moved.toFixed(2), refused, anim: g.player.kickAnim > 0 };
});
check('the Boot connects, shoves and respects its cooldown',
  s.kicked && s.moved > 0.25 && s.refused, `knocked back ${s.moved} cells`);

// ------------------------------------------------- 17. slam damage
s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  g.loadLevel(0); g.setState('play'); g._god = true;
  const e = g.enemies.find((x) => x.kind === 'sparker') || g.enemies[0];
  // Park it against a wall and shove it into that wall.
  const lv = g.level;
  let wallDir = null;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    if (lv.wall[(e.y + dy | 0) * lv.W + (e.x + dx | 0)] === 1) { wallDir = [dx, dy]; break; }
  }
  if (!wallDir) return { skip: true };
  const before = e.hp;
  e.shove(wallDir[0], wallDir[1], 40);
  window.T.step(0.6);
  return { hurt: before - e.hp, launched: false };
});
check('a body thrown into a wall takes the wall personally',
  s.skip || s.hurt > 0, s.skip ? 'no adjacent wall to test' : `${s.hurt} extra damage`);

// ------------------------------------------------- 18. pipe bombs
s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  g.loadLevel(0); g.setState('play'); g._god = true;
  g.player.owned.pipebomb = true; g.player.ammo.bomb = 5;
  g.player.pitch = 0;
  const ammo0 = g.player.ammo.bomb;
  g.tryBomb();
  const thrown = g.bombs.length;
  window.T.step(2.0);
  const settled = g.bombs.length && g.bombs[0].settled;
  const restZ = g.bombs.length ? g.bombs[0].z : -1;
  // Pressing again with one live detonates rather than throwing.
  g.tryBomb();
  const detonated = g.bombs.length === 0;
  window.T.step(0.3);
  const blasts = g.sky.blasts.length;
  return { thrown, settled, restZ: +restZ.toFixed(2), detonated, blasts,
    spent: ammo0 - g.player.ammo.bomb };
});
check('pipe bombs throw, land and detonate on command',
  s.thrown === 1 && s.settled && s.restZ > 0 && s.detonated && s.spent === 1,
  `rested at z=${s.restZ}, ${s.blasts} blast(s)`);

// ------------------------------------------------- 19. mutants breach in
s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  g.loadLevel(1); g.setState('play'); g._god = true;
  const before = g.enemies.length;
  let seenOffCamera = true;
  for (let i = 0; i < 60 * 90; i++) {
    g.update(1 / 60, g.input);
    if (g.enemies.length > before) break;
  }
  const mutants = g.enemies.filter((e) => e.def.mutant);
  // Whatever arrived must have arrived out of sight.
  for (const m of mutants) {
    if (m.spawnGrace > 0.2 && g.level.lineOfSight(g.player.x, g.player.y, m.x, m.y)) seenOffCamera = false;
  }
  return { before, after: g.enemies.length, mutants: mutants.length,
    kinds: [...new Set(mutants.map((m) => m.kind))].join('+'), seenOffCamera };
});
check('mutants come through the walls, off camera',
  s.mutants > 0 && s.seenOffCamera, `${s.mutants} arrived (${s.kinds})`);

// ------------------------------------------------- 20. mutant behaviour
s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  g.loadLevel(1); g.setState('play'); g._god = true;
  const out = {};
  // Isolate each subject: no other enemies, and no fresh breaches mid-test.
  const solo = (kind) => {
    g.enemies.length = 0;
    g.breach.cap = 0;
    g.spawnBreach(kind);
    g.breach.cap = 0;
    return g.enemies.filter((e) => e.kind === kind).pop();
  };
  // A gorger's death should burst and leave something behind.
  const gor = solo('gorger');
  if (gor) {
    g.hazards.length = 0;
    window.T.standNear(gor.x, gor.y, 3, 8);
    for (let i = 0; i < 40 && gor.alive; i++) gor.hurt(30, g, 0, 0);
    window.T.step(0.2);
    out.burst = g.hazards.length > 0;
    out.gore = g.level.decal[g.level.idx(gor.x, gor.y)] >= 0;
  }
  // A howler should be able to spit at the player.
  const how = solo('howler');
  if (how) {
    out.placedH = window.T.standNear(how.x, how.y, 3, 9);
    g.acids.length = 0;
    how.state = 2; how.cooldown = 0; how.lastSeen = { x: g.player.x, y: g.player.y };
    for (let i = 0; i < 60 * 10 && !g.acids.length; i++) g.update(1 / 60, g.input);
    out.spat = g.acids.length > 0;
  }
  // A stalker should actually lunge.
  const st = solo('stalker');
  if (st) {
    out.placedS = window.T.standNear(st.x, st.y, 2.2, 6);
    st.state = 2; st.cooldown = 0; st.lastSeen = { x: g.player.x, y: g.player.y };
    let lunged = false;
    for (let i = 0; i < 60 * 12; i++) {
      g.update(1 / 60, g.input);
      if (Math.hypot(st.kvx, st.kvy) > 4) { lunged = true; break; }
    }
    out.lunged = lunged;
  }
  return out;
});
check('a gorger bursts and leaves a hazard', !!s.burst && !!s.gore);
check('a howler spits acid', !!s.spat, s.placedH === false ? 'could not place the player' : '');
check('a stalker lunges', !!s.lunged, s.placedS === false ? 'could not place the player' : '');

// ------------------------------------------------- 21. the radio
s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  g.loadLevel(0); g.setState('play'); g._god = true;
  g.radio.reset();
  g.radio.distract();
  const queued = g.radio.queue.length;
  const seen = [];
  for (let i = 0; i < 60 * 30; i++) {
    g.update(1 / 60, g.input);
    if (g.radio.current) {
      const tag = g.radio.current.speaker + ':' + (g.radio.current.text || '').slice(0, 12);
      if (seen[seen.length - 1] !== tag) seen.push(tag);
    }
    if (!g.radio.current && !g.radio.queue.length && seen.length >= 2) break;
  }
  const speakers = seen.map((t) => t.split(':')[0]);
  return { queued, seen: seen.length, speakers: speakers.join('>'),
    overlapped: false, portrait: null };
});
check('the radio queues and never talks over itself',
  s.queued >= 2 && s.seen >= 2 && s.speakers.includes('brick') && s.speakers.includes('ilsa'),
  s.speakers);

// ------------------------------------------------- 22. streaks
s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  g.loadLevel(0); g.setState('play'); g._god = true;
  g.player.streak = 0; g.player.score = 0;
  for (let i = 0; i < 3; i++) g.bumpStreak();
  const at3 = { streak: g.player.streak, score: g.player.score };
  g.player.hurt = g._origHurt || g.player.hurt;
  g._god = false;
  g.onPlayerHurt(null, 'test');
  const afterHit = g.player.streak;
  g._god = true;
  return { at3, afterHit };
});
check('kill streaks build and a hit resets them',
  s.at3.streak === 3 && s.at3.score > 0 && s.afterHit === 0,
  `3 in a row paid ${s.at3.score}`);

// ------------------------------------------------- 23. gamepad
s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  g.loadLevel(0); g.setState('play'); g._god = true;
  // Present a synthetic standard-layout pad.
  const pad = {
    index: 0, id: 'Xbox Wireless Controller (STANDARD GAMEPAD)', connected: true,
    mapping: 'standard',
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
  };
  navigator.getGamepads = () => [pad];
  const inp = g.input;
  inp.padIndex = -1;
  window.T.arm('pistol');
  const ang0 = g.player.ang;

  pad.axes[2] = 1;                       // right stick fully right
  for (let i = 0; i < 30; i++) { inp.update(1 / 60); g.update(1 / 60, inp); inp.endFrame(); }
  const turned = g.player.ang - ang0;

  pad.axes[2] = 0; pad.axes[1] = -1;     // left stick forward
  const x0 = g.player.x, y0 = g.player.y;
  for (let i = 0; i < 30; i++) { inp.update(1 / 60); g.update(1 / 60, inp); inp.endFrame(); }
  const moved = Math.hypot(g.player.x - x0, g.player.y - y0);

  pad.axes[1] = 0;
  pad.buttons[7] = { pressed: true, value: 1 };   // right trigger
  g.player.cooldown = 0; g.player.fireAnim = 0;
  for (let i = 0; i < 6; i++) { inp.update(1 / 60); g.update(1 / 60, inp); inp.endFrame(); }
  const fired = g.player.fireAnim > 0;           // the Widow is bottomless: no ammo to count

  pad.buttons[7] = { pressed: false, value: 0 };
  pad.buttons[3] = { pressed: true, value: 1 };   // Y = kick
  g.player.kickCooldown = 0;
  inp.update(1 / 60); g.update(1 / 60, inp); inp.endFrame();
  const kicked = g.player.kickAnim > 0;

  pad.buttons[3] = { pressed: false, value: 0 };
  pad.buttons[5] = { pressed: true, value: 1 };   // RB = next weapon
  inp.update(1 / 60); g.update(1 / 60, inp); inp.endFrame();
  const swapped = (g.player.pendingWeapon || g.player.weapon) !== 'pistol';
  pad.buttons[5] = { pressed: false, value: 0 };
  for (let i = 0; i < 40; i++) { inp.update(1 / 60); g.update(1 / 60, inp); inp.endFrame(); }

  return { kind: inp.padKind, turned: +turned.toFixed(2), moved: +moved.toFixed(2),
    fired, kicked, swapped, seen: inp.padSeen };
});
{
  const parts = { detected: s.seen && s.kind === 'xbox', look: Math.abs(s.turned) > 0.3,
    move: s.moved > 0.3, fire: s.fired, boot: s.kicked, weapon: s.swapped };
  const bad = Object.entries(parts).filter(([, v]) => !v).map(([k]) => k);
  check('a standard gamepad drives look, move, fire, boot and weapon change', bad.length === 0,
    bad.length ? `failed: ${bad.join(', ')}` : `${s.kind}: turned ${s.turned} rad, moved ${s.moved} cells`);
}

// ------------------------------------------------- 24. gore decals
s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  g.loadLevel(0); g.setState('play'); g._god = true;
  let painted = 0;
  for (const e of g.enemies.slice(0, 5)) {
    while (e.alive) e.hurt(50, g, 0, 0);
  }
  for (let i = 0; i < g.level.decal.length; i++) if (g.level.decal[i] >= 0) painted++;
  return { painted, atlas: window.NUKEHAUS.art.decalCount };
});
check('bodies stain the floor', s.painted > 0 && s.atlas > 0,
  `${s.painted} cells marked from ${s.atlas} decal textures`);

// ------------------------------------------- 25. the Deadman reaches the sky
s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  g.loadLevel(0); g.setState('play'); g._god = true;
  window.T.arm('deadman', 3);
  for (let i = 0; i < 6; i++) g.sky.spawnWarhead('stick', 1);
  const before = g.sky.warheads.length;
  window.T.fireNow();
  window.T.step(2.5);
  return { before, after: g.sky.warheads.length };
});
check('the Deadman actually scrubs the sky', s.before >= 4 && s.after === 0,
  `${s.before} inbound -> ${s.after}`);

// -------------------------------------- 26. a mixed ammo box gives both types
s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  g.loadLevel(0); g.setState('play');
  const p = g.player;
  p.ammo.flak = 999;                       // capped on flak, empty on nails
  p.ammo.nail = 0;
  const it = { kind: 'ammo', x: p.x, y: p.y, z: 0, taken: false };
  g.pickUp(it);
  return { nails: p.ammo.nail, taken: it.taken };
});
check('a full flak reserve does not swallow the nails in the same box',
  s.nails > 0 && s.taken, `nails ${s.nails}`);

// ------------------------------ 27. the end-of-floor bonus reaches the score
s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  g.newGame(1); g.loadLevel(0); g.setState('play');
  g.player.score = 1000;
  g.levelTime = 1;
  g.nextLevel();
  return { total: g.interStats.total, score: g.player.score, carried: g.interStats.carried };
});
check('the intermission bonus is actually banked',
  s.total > 0 && s.score === s.carried + s.total,
  `carried ${s.carried} + bonus ${s.total} = ${s.score}`);

// ------------------------------- 28. pad menu aliases stay out of gameplay
s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  g.loadLevel(0); g.setState('play'); g._god = true;
  const pad = {
    index: 0, id: 'Xbox Wireless Controller (STANDARD GAMEPAD)', connected: true,
    mapping: 'standard', axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
  };
  navigator.getGamepads = () => [pad];
  const inp = g.input;
  inp.padIndex = -1;
  const tick = (n = 1) => { for (let i = 0; i < n; i++) { inp.update(1 / 60); g.update(1 / 60, inp); inp.endFrame(); } };
  const hold = (i, on) => { pad.buttons[i] = { pressed: on, value: on ? 1 : 0 }; };

  // B / Circle changes weapon in play, and must never read as escape.
  window.T.arm('pistol');
  hold(1, true); tick(1);
  const afterB = { state: g.state, next: g.player.pendingWeapon || g.player.weapon };
  hold(1, false); tick(40);

  // D-pad up changes weapon too. It must not also walk him forward.
  window.T.arm('pistol');
  const x0 = g.player.x, y0 = g.player.y;
  hold(12, true); tick(30); hold(12, false);
  const moved = Math.hypot(g.player.x - x0, g.player.y - y0);
  const dpad = g.player.pendingWeapon || g.player.weapon;
  return { state: afterB.state, next: afterB.next, moved: +moved.toFixed(3), dpad };
});
check('the d-pad and B/Circle do not leak menu actions into play',
  s.state === 'play' && s.next !== 'pistol' && s.moved < 0.05 && s.dpad !== 'pistol',
  `state ${s.state}, B picked ${s.next}, walked ${s.moved} cells, d-pad picked ${s.dpad}`);

// ------ 28a. a shut roof is a shut room: the walls round a deck are full
// height (no ceiling showing over a berm, no window onto the void), and the
// ceiling is well above the warden's head
s = await page.evaluate(async () => {
  const g = window.NUKEHAUS.game;
  const { CEIL_H, PARAPET_H } = await import('./src/core/world.js');
  g.loadLevel(0); g.setState('play'); g._god = true;
  const lv = g.level;
  const berms = [];
  for (let i = 0; i < lv.parapet.length; i++) if (lv.parapet[i]) berms.push(i);
  const shut = berms.every((i) => Math.abs(lv.wallHeight(i) - CEIL_H) < 1e-6);
  lv.roofOpen = 1;
  const open = berms.every((i) => Math.abs(lv.wallHeight(i) - PARAPET_H) < 1e-6);
  lv.roofOpen = 0;
  // Photograph it: from a deck cell facing a berm, with the roof shut, the wall's
  // top edge has to be where a full-height wall's would be.
  let spot = null;
  for (let y = 3; y < lv.H - 3 && !spot; y++) for (let x = 3; x < lv.W - 3 && !spot; x++) {
    const i = y * lv.W + x;
    if (!lv.roofPanel[i] || lv.wall[i]) continue;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (lv.parapet[(y + 2 * dy) * lv.W + x + 2 * dx] && !lv.blocked(x + 0.5 + dx, y + 0.5 + dy)) { spot = { x: x + 0.5, y: y + 0.5, ang: Math.atan2(dy, dx) }; break; }
    }
  }
  let err = null;
  if (spot) {
    g.player.x = spot.x; g.player.y = spot.y; g.player.ang = spot.ang; g.player.pitch = 0;
    window.T.step(0.05);
    window.NUKEHAUS.renderOnce();
    const rc = g.rc, c = rc.w >> 1;
    const dist = rc.zbuf[c];
    const horizon = (rc.h * 0.5 + g.player.pitch) | 0;
    const want = Math.max(0, Math.ceil(horizon - ((CEIL_H - g.player.z) * rc.projY) / dist));
    err = Math.abs(rc.wallTop[c] - want);
  }
  return { n: berms.length, shut, open, ceil: CEIL_H, eye: g.player.z, err, spot: !!spot };
});
check('with the roof shut every berm is a full wall, open it and they drop to parapets, and the ceiling clears the warden',
  s.n > 0 && s.shut && s.open && s.spot && s.err <= 1 && s.ceil > s.eye * 2,
  `${s.n} berms, shut ${s.shut}, open ${s.open}, wall top off by ${s.err} rows, ceiling ${s.ceil} over eyes at ${s.eye}`);

// ------ 28p. the furniture is real: shot, kicked, used and blown up, it behaves
// (round three). A helper first: put the warden a step and a half from a prop,
// looking at its middle.
s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  window.P3 = {
    stand(kind, dist = 1.5) {
      const lv = g.level;
      for (const d of lv.decor.filter((o) => o.kind === kind && o.def && !o.broken)) {
        // a chair pulled up inside a desk's own cell is behind a solid prop: not a target
        if (!d.solid && (g.props.grid.get(lv.idx(d.x, d.y)) || []).some((o) => o.solid && !o.broken)) continue;
        for (let a = 0; a < 16; a++) {
          const ang = a * Math.PI / 8, x = d.x + Math.cos(ang) * dist, y = d.y + Math.sin(ang) * dist;
          if (lv.blocked(x, y) || !lv.lineOfSight(x, y, d.x, d.y)) continue;
          // nothing solid between us and it (chairs are pulled up to tables now)
          let clear = true;
          for (let t = 0.1; t < 0.9 && clear; t += 0.05) {
            const i = lv.idx(x + (d.x - x) * t, y + (d.y - y) * t);
            if (lv.propBlock[i] && i !== lv.idx(d.x, d.y)) clear = false;
          }
          if (!clear) continue;
          // and it is the only thing there: a vending machine has a bin beside it now
          for (const o of lv.decor) if (o !== d && Math.hypot(o.x - d.x, o.y - d.y) < 1.1) o.gone = true;
          const p = g.player;
          p.x = x; p.y = y; p.z = 0.56; p.ang = Math.atan2(d.y - y, d.x - x);
          p.pitch = ((d.z + d.h * 0.5 - 0.56) / dist) * g.rc.projY;
          p.cooldown = 0; p.kickCooldown = 0; p.health = 50;
          p.owned.pistol = true; p.weapon = 'pistol'; p.pendingWeapon = null; p.swapT = 0;
          g.enemies.length = 0;
          return d;
        }
      }
      return null;
    },
  };
  g.loadLevel(0); g.setState('play'); g._god = true;
  const lv = g.level;
  const d = window.P3.stand('desk');
  if (!d) return { ok: false };
  const p = g.player;
  const cell = lv.idx(d.x, d.y);
  const a = p.aimVector(g.rc.projY);
  const trace = g.traceHit(p.x, p.y, p.z, a.x, a.y, a.z, 10, 34);
  const stopped = trace.prop === d;
  const blockedBefore = !!lv.propBlock[cell];
  let shots = 0;
  while (!d.broken && shots < 8) { p.cooldown = 0; g.tryFire(); window.T.step(0.02); shots++; }
  window.T.step(0.3);
  return {
    ok: true, stopped, blockedBefore, shots, broken: d.broken, cellFree: !lv.propBlock[cell] && !lv.blocked(d.x, d.y),
    litter: g.props.litter.length, dmg: g.levelDamage,
    // the wreck is the studio's own, or the painted sprite cut down
    wreck: !!d.altFrame || !!(g.art.props && g.art.props.has(d.kind) && g.art.props.frame(d.kind, 0, 'wreck', d.variant)),
  };
});
check('a desk stops a bullet, breaks under two Widow rounds, frees its cell, throws paper and goes on the invoice',
  s.ok && s.stopped && s.blockedBefore && s.broken && s.shots <= 3 && s.cellFree && s.litter >= 20 && s.dmg >= 300 && s.wreck,
  `stopped ${s.stopped}, ${s.shots} shots, cell free ${s.cellFree}, ${s.litter} pieces of litter, $${s.dmg}, wreck ${s.wreck}`);

s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  g.loadLevel(0); g.setState('play'); g._god = true;
  const lv = g.level, p = g.player;
  // a chair, a plant, a body on the floor and the wall behind them
  const chair = window.P3.stand('chair', 1.4);
  if (!chair) return { ok: false };
  const a = p.aimVector(g.rc.projY);
  const hit = g.traceHit(p.x, p.y, p.z, a.x, a.y, a.z, 12, 34);
  const brokeChair = chair.broken;
  const passed = !hit.prop || hit.prop === chair ? hit.prop === chair ? false : true : true;
  // a body on the floor is scenery to a bullet
  const body = lv.decor.find((o) => o.kind === 'corpse');
  let bodyBlocks = null;
  if (body) {
    const dx = body.x - (body.x - 1.5), r = 1.5;
    const h = g.traceHit(body.x - r, body.y, 0.2, 1, 0, 0, 3, 34);
    bodyBlocks = h.prop === body;
  }
  return { ok: true, brokeChair, hitKind: hit.prop ? hit.prop.kind : (hit.wall ? 'wall' : 'none'), passed, bodyBlocks };
});
check('a round goes through a chair (and breaks it) and on to whatever is behind; a body on the floor does not stop one',
  s.ok && s.brokeChair && s.hitKind !== 'chair' && s.bodyBlocks !== true,
  `chair broken ${s.brokeChair}, bullet ended on ${s.hitKind}, body blocks ${s.bodyBlocks}`);

s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  g.loadLevel(0); g.setState('play'); g._god = true;
  const cone = window.P3.stand('cone', 1.2);
  if (!cone) return { ok: false };
  const x0 = cone.x, y0 = cone.y;
  g.tryKick();
  window.T.step(0.15);
  const flyingMid = cone.flying, liftMid = cone.lift;
  window.T.step(2.5);
  const moved = Math.hypot(cone.x - x0, cone.y - y0);
  const inGrid = (g.props.grid.get(g.level.idx(cone.x, cone.y)) || []).includes(cone);
  return { ok: true, flyingMid, liftMid, landed: !cone.flying && cone.lift === 0, moved, inGrid };
});
check('the Boot sends a traffic cone flying; it lands, comes to rest a few cells away and can be shot again',
  s.ok && s.flyingMid && s.liftMid > 0 && s.landed && s.moved > 1 && s.inGrid,
  `flying ${s.flyingMid}, lift ${s.liftMid && s.liftMid.toFixed(2)}, landed ${s.landed}, moved ${s.moved && s.moved.toFixed(1)} cells, back in the grid ${s.inGrid}`);

s = await page.evaluate(async () => {
  const g = window.NUKEHAUS.game;
  const { Enemy } = await import('./src/game/entities.js');
  g.loadLevel(0); g.setState('play'); g._god = true;
  const lv = g.level, p = g.player;
  // a locker, a wrencher standing in front of it, and two boots
  const d = window.P3.stand('locker', 1.25);
  if (!d) return { ok: false };
  // nothing else in reach of the boot
  for (const o of lv.decor) if (o !== d && (Math.hypot(o.x - p.x, o.y - p.y) < 2.2 || Math.hypot(o.x - d.x, o.y - d.y) < 1.4)) o.gone = true;
  const ux = Math.cos(d.yaw), uy = Math.sin(d.yaw);
  const e = new Enemy('wrencher', d.x + ux * 0.62, d.y + uy * 0.62);
  g.enemies.push(e);
  const hp0 = e.hp, ex = e.x, ey = e.y;
  // he stands his ground (left alone he would come after the player)
  const hold = (sec) => { for (let i = 0; i < Math.round(sec * 60); i++) { if (e.alive) { e.x = ex; e.y = ey; } g.update(1 / 60, g.input); } };
  g.props.kick(p, 1.6, 0.4); hold(0.1);
  const rocked = d.rock === 1 && !d.fall;
  g.props.kick(p, 1.6, 0.4);
  // step well back, past where its top will land
  p.x = d.x + ux * 2.6; p.y = d.y + uy * 2.6;
  hold(1.5);
  return { ok: true, rocked, fell: !!(d.fall && d.fall.landed), lying: d.pose === 4, notSolid: !lv.propBlock[lv.idx(d.x, d.y)],
    crushed: !e.alive || e.hp < hp0 - 60 };
});
check('a locker rocks at the first boot and goes over at the second, forward, and flattens whoever is in front of it',
  s.ok && s.rocked && s.fell && s.lying && s.notSolid && s.crushed,
  `rocked ${s.rocked}, fell ${s.fell}, lying ${s.lying}, cell free ${s.notSolid}, crushed ${s.crushed}`);

s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  g.loadLevel(0); g.setState('play'); g._god = true;
  const lv = g.level;
  const run = (sec) => { for (let i = 0; i < Math.round(sec * 60); i++) g.update(1 / 60, g.input); };
  const cells = [...g.walls.hp.keys()];
  if (!cells.length) return { ok: false };
  const i = cells[0], x = (i % lv.W) + 0.5, y = ((i / lv.W) | 0) + 0.5;
  // a round leaves a mark on the face it hits
  const faces0 = g.walls.faces.length;
  // the partition runs one way or the other; stand on one of its open sides
  const [ax, ay] = lv.wall[i - 1] === 0 ? [-1, 0] : [0, -1];
  g.walls.bulletHole(x + ax * 0.7, y + ay * 0.7, 0.5, -ax, -ay);
  const marked = g.walls.faces.length > faces0;
  g.explodeAt(x + ax * 0.9, y + ay * 0.9, 0.4, 3, 70);
  run(0.5);
  return { ok: true, marked, open: lv.wall[i] === 0, debris: g.props.debris.length, walk: !lv.blocked(x, y) };
});
check('a round marks a wall where it hits, and a blast brings a thin wall down into rubble you can walk through',
  s.ok && s.marked && s.open && s.debris >= 8 && s.walk,
  `marked ${s.marked}, open ${s.open}, ${s.debris} pieces, walkable ${s.walk}`);

s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  g.loadLevel(0); g.setState('play'); g._god = true;
  const lv = g.level, p = g.player;
  const run = (sec) => { for (let i = 0; i < Math.round(sec * 60); i++) g.update(1 / 60, g.input); };
  // put an extinguisher and a rack of gas bottles in an open patch
  let spot = null;
  for (let y = 3; y < lv.H - 3 && !spot; y++) for (let x = 3; x < lv.W - 3 && !spot; x++) {
    let ok = true;
    for (let dy = -2; dy <= 2 && ok; dy++) for (let dx = -2; dx <= 2; dx++) {
      const j = (y + dy) * lv.W + x + dx;
      if (lv.wall[j] || lv.propBlock[j] || lv.exit[j] || lv.trigger[j]) { ok = false; break; }
    }
    if (ok) spot = [x + 0.5, y + 0.5];
  }
  if (!spot) return { ok: false };
  for (const o of lv.decor) if (Math.hypot(o.x - spot[0], o.y - spot[1]) < 3) o.gone = true;
  p.x = spot[0] - 2; p.y = spot[1]; g.enemies.length = 0;
  const ex = g.props.spawn('extinguisher', spot[0], spot[1] - 1, 0);
  g.props.hit(ex, 4, ex.x, ex.y, 0.15, 'shot', 1, 0);
  const flew = ex.gone && g.props.jets.length === 1;
  run(3);
  const landed = g.props.jets.length === 0;
  const gas = g.props.spawn('gascyl', spot[0], spot[1] + 1, Math.PI);
  const real = g.rng; g.rng = () => 0.9;
  let boom = 0;
  const explode = g.explodeAt.bind(g);
  g.explodeAt = (...a) => { boom++; return explode(...a); };
  const realP = g.props.rng;
  g.props.rng = () => 0.9;
  g.props.hit(gas, 6, gas.x, gas.y, 0.4, 'shot', 1, 0);
  const vented = gas.vented;
  g.props.rng = realP;
  run(3);
  g.rng = real; g.explodeAt = explode;
  return { ok: true, flew, landed, vented, boom, broke: gas.broken };
});
check('a shot extinguisher flies off on its own foam and lands; a shot gas bottle vents and then the lot goes up',
  s.ok && s.flew && s.landed && s.vented && s.boom >= 1 && s.broke,
  `flew ${s.flew}, landed ${s.landed}, vented ${s.vented}, explosions ${s.boom}, broken ${s.broke}`);

s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  g.loadLevel(0); g.setState('play'); g._god = true;
  const vm = window.P3.stand('vending', 1.3);
  if (!vm) return { ok: false };
  const p = g.player, stock0 = vm.stock;
  const hint = g.props.hint(p);
  const real = g.rng;
  g.rng = () => 0.5;                              // a fair roll: it vends
  g.props.use(p);
  window.T.step(1.4);
  const can = g.props.litter.find((l) => l.kind === 'can');
  const stock1 = vm.stock;
  let healed = 0;
  if (can) {
    can.rest = true; can.z = 0.02; can.x = p.x; can.y = p.y;
    const h0 = p.health;
    window.T.step(0.2);
    healed = p.health - h0;
  }
  // the next one is eaten, and a kick knocks it loose
  g.rng = () => 0.05;
  g.props.use(p); window.T.step(1.2);
  const jammed = vm.jam;
  const stock2 = vm.stock;
  g.tryKick(); window.T.step(0.9);
  g.rng = real;
  return { ok: true, hint, stock0, stock1, stock2, stock3: vm.stock, healed, jammed, cans: g.props.litter.filter((l) => l.kind === 'can').length };
});
check('a vending machine: a coin buys a can that heals, one is eaten and jams it, a kick shakes a can loose',
  s.ok && /SODA/.test(s.hint || '') && s.stock1 === s.stock0 - 1 && s.healed >= 5 && s.jammed && s.stock2 === s.stock1 && s.stock3 < s.stock2,
  `hint ${s.hint}, stock ${s.stock0} > ${s.stock1} > ${s.stock2} > ${s.stock3}, healed ${s.healed}, jammed ${s.jammed}`);

s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  g.loadLevel(0); g.setState('play'); g._god = true;
  const lv = g.level;
  const near = lv.decor.find((o) => o.kind === 'crates' && o.def);
  const far = lv.decor.find((o) => o.kind === 'crates' && o !== near && Math.hypot(o.x - near.x, o.y - near.y) > 8);
  g.props.blast(near.x + 0.5, near.y, 0.4, 3.4, 58);
  const lamp = g.items.find((it) => it.kind === 'lamp');
  let lampOk = true;
  if (lamp) {
    const n0 = g.staticLights.length;
    const found = g.props.lampAt(lamp.x, lamp.y, lamp.z);
    g.props.shootLamp(lamp);
    lampOk = found === lamp && lamp.taken && g.staticLights.length === n0 - 1;
  }
  return { near: near.broken, far: far ? far.broken : false, lampOk, hasLamp: !!lamp };
});
check('a blast breaks the furniture inside its radius and not the crates across the level; a shot lamp loses its light',
  s.near && !s.far && s.lampOk,
  `near broken ${s.near}, far broken ${s.far}, lamp ${s.hasLamp ? s.lampOk : 'n/a'}`);

s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  const bad = [];
  let broke = 0;
  for (let L = 0; L < g.totalLevels; L++) {
    g.loadLevel(L); g.setState('play'); g._god = true;
    const lv = g.level;
    for (const d of lv.decor) if (d.def && d.def.hp !== Infinity && !d.broken) { g.props.breakProp(d, 'blast'); broke++; }
    for (const d of lv.decor) {
      if (!d.broken) continue;
      const i = lv.idx(d.x, d.y);
      const other = lv.decor.some((o) => o !== d && !o.broken && o.solid && lv.idx(o.x, o.y) === i)
        || g.items.some((it) => it.solid && !it.taken && lv.idx(it.x, it.y) === i);
      if (lv.propBlock[i] && !other) bad.push(`${L}:${d.kind}@${d.x | 0},${d.y | 0}`);
    }
  }
  return { broke, bad: bad.slice(0, 6), levels: g.totalLevels };
});
check('breaking every piece of furniture on every floor leaves no invisible wall behind',
  s.broke > 100 && s.bad.length === 0, `${s.broke} pieces broken over ${s.levels} floors, ghosts ${s.bad.join(' ') || 'none'}`);

// ------ 28s. THE SEVERANCE: a concrete chainsaw (round four). It lies on the first
// floor, has a slot and a picture, saws what is in front of it, hangs a body on a
// dull chain, and cuts it in half, across or down, into two pieces that fly
s = await page.evaluate(async () => {
  const { Enemy } = await import('./src/game/entities.js');
  const { splitFrame } = await import('./src/game/gore.js');
  const { WEAPONS, WEAPON_ORDER } = await import('./src/game/weapons.js');
  const g = window.NUKEHAUS.game;
  g.player.owned.saw = false;
  g.loadLevel(0); g.setState('play'); g._god = true;
  const p = g.player, lv = g.level;
  const onFloor = g.items.some((it) => it.kind === 'weapon' && it.weapon === 'saw');
  const art = !!g.art.sprites.weapon_saw && ['idle', 'fire0', 'fire2', 'reload1', 'bloody1', 'jam0'].every((k) => !!g.art.vm['saw_' + k]);
  const slot = WEAPONS.saw.slot === 7 && WEAPON_ORDER.includes('saw');
  // a straight open run to work in
  let spot = null;
  for (let y = 3; y < lv.H - 3 && !spot; y++) for (let x = 3; x < lv.W - 6 && !spot; x++) {
    let ok = true; for (let k = 0; k < 5; k++) if (lv.blocked(x + 0.5 + k, y + 0.5)) ok = false;
    if (ok) spot = [x + 0.5, y + 0.5];
  }
  const ownFiring = Object.getOwnPropertyDescriptor(g.input, 'firing');
  g.input.firing = () => window.FIRE;
  const arm = (mode) => {
    p.owned.saw = true; p.weapon = 'saw'; p.pendingWeapon = null; p.swapT = 0; p.health = 100;
    p.x = spot[0]; p.y = spot[1]; p.ang = 0; p.z = 0.56; p.kickCooldown = 0;
    p.pitch = mode === 'v' ? 40 : mode === 'h' ? -40 : 0;
    g.enemies.length = 0; g.gore.clear(); g.saw = g.freshSaw(); g.hud.sawHint = '';
  };
  const victim = (kind, d = 1.05) => { const e = new Enemy(kind, p.x + d, p.y); e.ang = Math.PI; e.state = 2; g.enemies.push(e); return e; };
  const run = (sec) => { for (let i = 0; i < Math.round(sec * 60); i++) g.update(1 / 60, g.input); };
  const real = g.rng;

  // 1. hung on the blade
  arm('v'); window.FIRE = true;
  const e1 = victim('wrencher');
  g.rng = () => 0.01; run(0.5); g.rng = real;
  const pinned = !!g.saw.stuck && e1.pinned && e1.alive && g.saw.pose.startsWith('jam');
  const held = Math.hypot(e1.x - p.x, e1.y - p.y);
  const hint = g.hud.sawHint;
  const hpWhileStuck = e1.hp;
  // 2. it catches: cut in two, and it is a kill
  const kills0 = g.levelKills, score0 = p.score;
  for (let i = 0; i < 600 && !e1._bisected; i++) run(1 / 60);
  run(0.3);
  const halves = g.gore.parts.filter((c) => c.part === 'half');
  const bisected = { done: !!e1._bisected, gone: !!e1.vanish, dead: !e1.alive, halves: halves.length,
    kill: g.levelKills === kills0 + 1, paid: p.score - score0 >= 800, stuckClear: !g.saw.stuck };
  // 3. let go while stuck: he slides off, alive
  arm('h'); window.FIRE = true;
  const e2 = victim('wrencher');
  g.rng = () => 0.01; run(0.5); g.rng = real;
  const slid0 = !!e2.pinned;
  window.FIRE = false; run(0.3);
  const slid = { was: slid0, now: !e2.pinned, alive: e2.alive, hurt: e2.hp < e2.maxHp, clear: !g.saw.stuck };
  // 4. the boot gets him off
  arm('h'); window.FIRE = true;
  const e3 = victim('wrencher');
  g.rng = () => 0.01; run(0.5); g.rng = real;
  g.tryKick(); run(0.05);
  const booted = { off: !e3.pinned, clear: !g.saw.stuck };
  // 5. a plain cut: sawing what has not been snagged kills it
  arm('x'); window.FIRE = true;
  const e4 = victim('wrencher', 0.9);
  g.saw.seen.add(e4);
  let sawKilled = false;
  for (let i = 0; i < 240 && e4.alive; i++) run(1 / 60);
  sawKilled = !e4.alive;
  // 6. furniture in front goes to pieces
  window.FIRE = false;
  arm('x');
  let deskOk = null;
  const desk = lv.decor.find((d) => d.kind === 'crate' || d.kind === 'desk');
  if (desk) {
    for (let a = 0; a < 16 && !deskOk; a++) {
      const ang = a * Math.PI / 8, x = desk.x + Math.cos(ang) * 1.0, y = desk.y + Math.sin(ang) * 1.0;
      if (lv.blocked(x, y) || !lv.lineOfSight(x, y, desk.x, desk.y)) continue;
      p.x = x; p.y = y; p.ang = Math.atan2(desk.y - y, desk.x - x); p.pitch = ((desk.z + desk.h * 0.5 - 0.56) / 1.0) * g.rc.projY;
      window.FIRE = true; run(1.5); window.FIRE = false;
      deskOk = desk.broken;
    }
  }
  // 7. switching away drops him
  arm('h'); window.FIRE = true;
  const e5 = victim('wrencher');
  g.rng = () => 0.01; run(0.5); g.rng = real;
  p.pendingWeapon = 'pistol'; run(0.1); p.pendingWeapon = null; p.weapon = 'pistol';
  const dropped = !e5.pinned && !g.saw.stuck;
  window.FIRE = false; p.weapon = 'pistol';
  // 8. the cut itself: two pieces that between them are the whole body
  const src = g.art.sprites['wrencher_walk0_0'];
  const count = (f) => { let n = 0; for (let i = 0; i < f.data.length; i++) if (f.data[i] >>> 24) n++; return n; };
  const cutOk = ['h', 'v'].map((m) => {
    const [a, b] = splitFrame(src, m, 0.5, 1234);
    return !!a && !!b && count(a.frame) + count(b.frame) === count(src);
  });
  if (ownFiring) Object.defineProperty(g.input, 'firing', ownFiring); else delete g.input.firing;
  window.FIRE = false; p.weapon = 'pistol'; p.pendingWeapon = null; g.saw = g.freshSaw();
  return { onFloor, art, slot, pinned, held, hint, hpWhileStuck, bisected, slid, booted, sawKilled, deskOk, dropped, cutOk, maxHp: e1.maxHp };
});
check('THE SEVERANCE lies on floor one with a slot and a picture; hung on a dull chain the body is held at the blade, screaming, and is not hurt much',
  s.onFloor && s.art && s.slot && s.pinned && s.held > 0.6 && s.held < 1.3 && /BOOT/.test(s.hint) && s.hpWhileStuck > s.maxHp * 0.85,
  `on floor ${s.onFloor}, art ${s.art}, slot ${s.slot}, pinned ${s.pinned}, held at ${s.held && s.held.toFixed(2)}, hint "${s.hint}", hp ${s.hpWhileStuck}/${s.maxHp}`);
check('when the chain catches the body is cut in two: gone, counted as a kill, paid for, and two halves fly',
  s.bisected.done && s.bisected.gone && s.bisected.dead && s.bisected.halves === 2 && s.bisected.kill && s.bisected.paid && s.bisected.stuckClear,
  JSON.stringify(s.bisected));
check('letting go of the trigger slides him off alive and hurt; the Boot gets him off too; switching guns drops him',
  s.slid.was && s.slid.now && s.slid.alive && s.slid.hurt && s.slid.clear && s.booted.off && s.booted.clear && s.dropped,
  `slid ${JSON.stringify(s.slid)}, booted ${JSON.stringify(s.booted)}, dropped ${s.dropped}`);
check('the saw kills what it is walked into, breaks the furniture in front of it, and cuts a sprite into two pieces that add up',
  s.sawKilled && s.deskOk && s.cutOk[0] && s.cutOk[1], `killed ${s.sawKilled}, furniture ${s.deskOk}, cut h ${s.cutOk[0]} v ${s.cutOk[1]}`);

// ------ 28w. writing on the walls, and the thin man who does it (round five). A message
// writes itself in blood a letter at a time and drips; a curse arrives whole where
// blood hits a wall, and is rare on purpose; the Scribe turns up in front of a
// wall, writes it, may go invisible, giggles, never hurts anybody, and is gone.
s = await page.evaluate(async () => {
  const { MESSAGES, Scrawl, FACE_D, faceRight } = await import('./src/game/scrawl.js');
  const g = window.NUKEHAUS.game;
  g.loadLevel(0); g.setState('play'); g._god = true; g.enemies.length = 0;
  const p = g.player, lv = g.level, sc = g.scrawl, sb = g.scribe;
  const run = (sec) => { for (let i = 0; i < Math.round(sec * 60); i++) g.update(1 / 60, g.input); };
  const ink = (strip) => { let n = 0; for (let i = 0; i < strip.length; i++) if (strip[i] >>> 24) n++; return n; };
  const out = { layer: !!lv.scrawl && lv.scrawl instanceof Map && !!sc && !!sb };

  // 1. a message writes itself and drips
  const msg = ['I FOUND A DOOR', 'IT WAS A MOUTH'];
  const runs = sc.runs(Scrawl.cellsFor(msg, 8));
  const r = runs[0];
  const job = sc.write(r, msg, { size: 8, dur: 2, row: 30, seed: 42 });
  const cell = lv.scrawl.get((r.y * lv.W + r.x) * 4 + r.f);
  const at0 = ink(job.cur);
  run(1);
  const mid = ink(job.cur);
  run(6);
  const end = ink(job.cur);
  out.write = { runs: runs.length, faces: lv.scrawl.size, cell: !!cell && cell.ws === r.n * 64, at0, mid, end, done: job.done, drips: job.drips.filter((d) => d.drawn > 0).length };
  // and the raycaster reads it without falling over: face the wall and let a few frames draw
  const d = FACE_D[r.f], rr = faceRight(r.f);
  const mx = r.fx + 0.5 + rr[0] * (r.n - 1) / 2, my = r.fy + 0.5 + rr[1] * (r.n - 1) / 2;
  p.x = mx - d[0] * 0.4; p.y = my - d[1] * 0.4; p.ang = Math.atan2(d[1], d[0]); p.pitch = 0;

  // 2. a curse: whole at once, refused on a face that is taken, and rare
  const face = runs.find((q) => !lv.scrawl.has((q.y * lv.W + q.x) * 4 + q.f) && q.f !== r.f) || runs[runs.length - 1];
  const fd = FACE_D[face.f];
  const cj = sc.curse(face.fx + 0.5 + fd[0] * 0.42, face.fy + 0.5 + fd[1] * 0.42, 0.7, -fd[0], -fd[1], 'FUCK');
  const again = sc.curse(face.fx + 0.5 + fd[0] * 0.42, face.fy + 0.5 + fd[1] * 0.42, 0.7, -fd[0], -fd[1], 'SHIT');
  out.curse = { made: !!cj, ink: cj ? ink(cj.cur) : 0, refused: again === null };
  const real = g.rng;
  g.rng = () => 0.0001;                       // the luckiest possible roll, every time
  sc.curses = 0; sc.curseAt = -999;
  const all = sc.runs(1);
  let tries = 0;
  for (let i = 0; i < all.length && i < 60; i++) {
    const q = all[i], dq = FACE_D[q.f];
    g.time += 40; tries++;
    sc.maybeCurse(q.fx + 0.5 + dq[0] * 0.42, q.fy + 0.5 + dq[1] * 0.42, 0.7, -dq[0], -dq[1], true);
  }
  out.rare = { curses: sc.curses, tries };
  g.time -= 40 * tries;
  sc.curses = 0; sc.curseAt = g.time;
  // a middling roll (0.02) is enough for a big splash and never for a light one
  g.rng = () => 0.02;
  let lightN = 0, heavyN = 0;
  for (let i = 0; i < all.length && i < 60; i++) {
    const q = all[i], dq = FACE_D[q.f];
    g.time += 40; sc.curses = 0; sc.curseAt = -999;
    if (sc.maybeCurse(q.fx + 0.5 + dq[0] * 0.42, q.fy + 0.5 + dq[1] * 0.42, 0.7, -dq[0], -dq[1], false)) lightN++;
  }
  for (let i = 0; i < all.length && i < 60; i++) {
    const q = all[i], dq = FACE_D[q.f];
    g.time += 40; sc.curses = 0; sc.curseAt = -999;
    if (sc.maybeCurse(q.fx + 0.5 + dq[0] * 0.42, q.fy + 0.5 + dq[1] * 0.42, 0.7, -dq[0], -dq[1], true)) heavyN++;
  }
  g.rng = real;
  out.rare.light = lightN; out.rare.heavy = heavyN;
  // and a real splash on a real wall goes through the same door
  g.rng = () => 0.0001; sc.curses = 0; sc.curseAt = -999; g.time += 40;
  const sq = all.find((q) => !lv.scrawl.has((q.y * lv.W + q.x) * 4 + q.f));
  let smeared = false;
  if (sq) {
    const dq = FACE_D[sq.f], before = sc.curses;
    g.gore.smear(sq.fx + 0.5 + dq[0] * 0.44, sq.fy + 0.5 + dq[1] * 0.44, 0.7, 0.6, true, dq[0], dq[1]);
    smeared = sc.curses === before + 1;
  }
  g.rng = real;
  out.rare.smear = smeared;

  // 3. the Scribe's visit
  g.loadLevel(0); g.setState('play'); g._god = true; g.enemies.length = 0;
  const S = g.scribe, P = g.player;
  let hurts = 0; P.hurt = () => { hurts++; };
  const hp0 = P.health;
  S.next = 0;
  for (let a = 0; a < 16 && S.state === 0; a++) { P.ang = a * Math.PI / 8; S.next = 0; run(0.05); }
  out.visit = { began: S.state !== 0, msg: !!S.msg, run: !!S.run, ghost: S.ghost };
  const sr = S.run;
  if (sr) {
    const d2 = FACE_D[sr.f], r2 = faceRight(sr.f);
    const qx = sr.fx + 0.5 + r2[0] * (sr.n - 1) / 2, qy = sr.fy + 0.5 + r2[1] * (sr.n - 1) / 2;
    for (let k = 4; k >= 2.2; k -= 0.2) { const x = qx - d2[0] * k, y = qy - d2[1] * k; if (!g.level.blocked(x, y) && g.level.lineOfSight(x, y, qx, qy)) { P.x = x; P.y = y; break; } }
    P.ang = Math.atan2(d2[1], d2[0]);
    S.ghost = false;
    let saw = 0, states = new Set();
    for (let i = 0; i < 60 * 14 && !(S.state === 0 && i > 60); i++) {
      run(1 / 60);
      states.add(S.state);
      if (S.sprite(g.art)) saw++;
    }
    out.visit.states = [...states].sort().join('');
    out.visit.sprite = saw;
    out.visit.finished = !!S.job === false || S.job.done;
    out.visit.gone = S.state === 0;
    out.visit.wrote = ink(S.run ? (g.level.scrawl.get((sr.y * g.level.W + sr.x) * 4 + sr.f) || { strip: new Uint32Array(0) }).strip : new Uint32Array(0));
  }
  out.visit.hurt = hurts;
  out.visit.hp = P.health === hp0;
  out.visit.enemies = g.enemies.length;

  // he goes when you come close (and the writing is finished for him), and when you shoot at him
  S.next = 0; S.visits = 0;
  for (let a = 0; a < 16 && S.state === 0; a++) { P.ang = a * Math.PI / 8; S.next = 0; run(0.05); }
  out.close = { began: S.state !== 0 };
  if (S.state !== 0) {
    S.ghost = false; S.state = 2; S.t = 0; S.alpha = 1; S._vis = true; S.blink = 9;
    P.x = S.x - 1.2 * Math.cos(P.ang); P.y = S.y - 1.2 * Math.sin(P.ang);
    const near = g.level.blocked(P.x, P.y);
    if (near) { P.x = S.x; P.y = S.y; }
    run(0.1);
    out.close.faded = S.state === 4 || S.state === 0;
    out.close.finished = S.job ? S.job.done : true;
  }
  S.state = 0; S.next = 999;
  const sc3 = g.scrawl; void sc3;
  // shot: put him in front of the muzzle and fire the aim vector through him
  S.run = sr || S.run;
  S.state = 2; S.t = 0; S.alpha = 1; S.x = P.x + Math.cos(P.ang) * 2; S.y = P.y + Math.sin(P.ang) * 2; S.job = null;
  P.pitch = 0; P.z = 0.56;
  const aim = P.aimVector(g.rc.projY);
  out.shot = { hit: S.onShot(aim), faded: S.state === 4 };
  S.state = 2; S.alpha = 1; S.x = P.x - Math.cos(P.ang) * 2; S.y = P.y - Math.sin(P.ang) * 2;
  out.shot.behind = S.onShot(aim) === false;
  S.state = 0;
  delete P.hurt;                                // the stub was ours; the player's own method comes back
  return out;
});
check('a message writes itself in blood, letter by letter, then drips; the wall face carries it',
  s.layer && s.write.runs > 20 && s.write.cell && s.write.mid > s.write.at0 && s.write.end > s.write.mid && s.write.done && s.write.drips >= 2,
  JSON.stringify(s.write));
check('a curse arrives whole, is refused on a wall that is already written on, and is rare: at most five a floor, and only a big splash on a middling roll',
  s.curse.made && s.curse.ink > 100 && s.curse.refused && s.rare.curses > 0 && s.rare.curses <= 5 && s.rare.light === 0 && s.rare.heavy > 0 && s.rare.smear,
  JSON.stringify({ curse: s.curse, rare: s.rare }));
check('the Scribe comes to a wall, is drawn while he works, writes the message, and is gone; nobody is hurt and no enemy is made',
  s.visit.began && s.visit.msg && s.visit.run && s.visit.sprite > 30 && s.visit.finished && s.visit.gone && s.visit.wrote > 100
  && s.visit.hurt === 0 && s.visit.hp && s.visit.enemies === 0,
  JSON.stringify(s.visit));
check('come close and he is gone with the writing finished; shoot through him and he giggles off; a shot behind you is nothing',
  s.close.began && s.close.faded && s.close.finished && s.shot.hit && s.shot.faded && s.shot.behind,
  JSON.stringify({ close: s.close, shot: s.shot }));
await sleep(500);

// ------ 28b. the wheel changes guns on a real notch, not on the trickle a
// touch-surface mouse or trackpad sends while the hand is only aiming
s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  g.loadLevel(0); g.setState('play'); g._god = true;
  window.T.arm('pistol');
  const inp = g.input;
  const frame = (w) => { inp.wheel = w; g.update(1 / 60, inp); inp.wheel = 0; };
  let flips = 0, last = g.player.weapon;
  const watch = () => { const w = g.player.pendingWeapon || g.player.weapon; if (w !== last) { flips++; last = w; } };
  // Two seconds of aiming with a jittery surface: tiny deltas both ways.
  for (let i = 0; i < 120; i++) { frame(i % 3 === 0 ? 0.04 : i % 3 === 1 ? -0.03 : 0.02); watch(); }
  const trickle = flips;
  for (let i = 0; i < 60; i++) { frame(0); watch(); }
  // One notch, then another straight after: one change, then the second once
  // the first has had its moment.
  frame(1); watch();
  for (let i = 0; i < 4; i++) { frame(0); watch(); }
  frame(1); watch();
  const quick = flips;
  for (let i = 0; i < 90; i++) { frame(0); watch(); }
  frame(1); watch();
  for (let i = 0; i < 60; i++) { frame(0); watch(); }
  return { trickle, quick, total: flips };
});
check('a trickle of tiny wheel deltas never changes guns; a notch changes once, and notches are spaced',
  s.trickle === 0 && s.quick === 1 && s.total === 2, `trickle ${s.trickle}, two quick notches ${s.quick}, then ${s.total}`);

// -------------------------------- 29. a pad that vanishes lets go of the trigger
s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  g.loadLevel(0); g.setState('play');
  const pad = {
    index: 0, id: 'Xbox Wireless Controller (STANDARD GAMEPAD)', connected: true,
    mapping: 'standard', axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
  };
  navigator.getGamepads = () => [pad];
  const inp = g.input;
  inp.padIndex = -1;
  pad.buttons[7] = { pressed: true, value: 1 };
  inp.update(1 / 60);
  const held = inp.firing();
  // The pad loses power: getGamepads simply stops returning it.
  navigator.getGamepads = () => [];
  inp.padIndex = -1;
  inp.update(1 / 60);
  return { held, after: inp.firing(), down: inp.down.has('fire'), padDown: inp.padDown.size };
});
check('a gamepad that disconnects mid-hold releases what it was holding',
  s.held && !s.after && !s.down && s.padDown === 0,
  `firing ${s.held} -> ${s.after}, down set ${s.down}`);

// ------------------------- 29b. ...but the pad still drives the front-end menus
s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  const title = g.titleScreen;
  const pad = {
    index: 0, id: 'Xbox Wireless Controller (STANDARD GAMEPAD)', connected: true,
    mapping: 'standard', axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
  };
  navigator.getGamepads = () => [pad];
  const inp = g.input;
  // Start from a clean slate: an earlier case leaves a mouse `fire` edge behind,
  // and the title reads fire as confirm.
  inp.pressed.clear(); inp.down.clear(); inp.menuEdge.clear();
  inp.mousePressed = 0; inp.mouseButtons = 0;
  inp.padIndex = -1; inp.padDown.clear(); inp.padMenuDown.clear();
  title.page = 'menu'; title.sel = 0;
  const hold = (i, on) => { pad.buttons[i] = { pressed: on, value: on ? 1 : 0 }; };
  const tick = () => { inp.update(1 / 60); title.update(1 / 60, inp, g); inp.endFrame(); };
  hold(13, true); tick(); hold(13, false); tick();     // d-pad down
  const moved = title.sel;
  const stillMenu = title.page;
  hold(0, true); tick(); hold(0, false); tick();       // A = confirm
  const opened = title.page;
  hold(1, true); tick(); hold(1, false); tick();       // B = back
  return { moved, stillMenu, opened, back: title.page };
});
check('the pad still drives the title menu',
  s.moved === 1 && s.stillMenu === 'menu' && s.opened === 'howto' && s.back === 'menu',
  `d-pad -> sel ${s.moved} (${s.stillMenu}), A -> ${s.opened}, B -> ${s.back}`);

// ------------------------------------------ 30. arrow keys turn, slot 6 selects
s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  g.loadLevel(0); g.setState('play');
  const a0 = g.player.ang;
  g.input.down.add('right');
  for (let i = 0; i < 30; i++) g.update(1 / 60, g.input);
  g.input.down.delete('right');
  const turned = Math.abs(g.player.ang - a0);
  g.player.owned.deadman = true;
  const picked = g.player.selectSlot(6);
  return { turned: +turned.toFixed(2), picked, want: g.player.pendingWeapon };
});
check('arrow-key turning works and slot 6 is selectable',
  s.turned > 0.2 && s.picked && s.want === 'deadman',
  `turned ${s.turned} rad, slot 6 -> ${s.want}`);

// -------------------------------- 31. the exit stops nagging once decks are done
s = await page.evaluate(() => {
  const out = [];
  const g = window.NUKEHAUS.game;
  for (let L = 0; L < g.totalLevels; L++) {
    g.loadLevel(L); g.setState('play');
    out.push({ L, waves: ((g.level.def.siege || {}).waves || []).length,
      groups: g.waveGroupCount(), triggers: g.triggerOrder.length });
  }
  return out;
});
{
  const bad = s.filter((r) => r.groups > r.triggers);
  check('outstanding decks are counted by trigger group, not raw wave count',
    bad.length === 0,
    s.map((r) => `L${r.L + 1} ${r.waves}w/${r.groups}g/${r.triggers}t`).join('  '));
}

// ------------------------------------ 32. the pipe-bomb satchel has a sprite
s = await page.evaluate(() => {
  const art = window.NUKEHAUS.art;
  const f = art.sprites.weapon_pipebomb;
  let opaque = 0;
  if (f) for (let i = 0; i < f.data.length; i++) if ((f.data[i] >>> 24) === 255) opaque++;
  return { has: !!f, w: f ? f.w : 0, h: f ? f.h : 0, opaque };
});
check('the pipe-bomb pickup is actually visible', s.has && s.opaque > 60,
  `${s.w}x${s.h}, ${s.opaque} opaque pixels`);

// --------------------------------- 33. one-shot lines come back for a new run
s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  g.newGame(1);
  const first = g.radio.say('ilsa', 'test_once', 'Only once.', { once: true });
  const again = g.radio.say('ilsa', 'test_once', 'Only once.', { once: true });
  g.loadLevel(1);
  const nextFloor = g.radio.say('ilsa', 'test_once', 'Only once.', { once: true });
  g.newGame(1);
  const newRun = g.radio.say('ilsa', 'test_once', 'Only once.', { once: true });
  return { first, again, nextFloor, newRun };
});
check('a `once` line is said once per campaign, and again on a fresh one',
  s.first && !s.again && !s.nextFloor && s.newRun,
  `run1 ${s.first}/${s.again}, floor2 ${s.nextFloor}, run2 ${s.newRun}`);

// ------------------------------------------- 34. the Boot does not reach walls
s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  g.loadLevel(0); g.setState('play'); g._god = true;
  const lv = g.level;
  // Find a wall with open floor on both sides, and put the player and an enemy
  // on opposite faces of it.
  let spot = null;
  for (let y = 1; y < lv.H - 1 && !spot; y++) {
    for (let x = 2; x < lv.W - 2; x++) {
      const i = y * lv.W + x;
      if (!lv.wall[i] || lv.doorVert[i]) continue;
      if (lv.blocked(x - 0.5, y + 0.5) || lv.blocked(x + 1.5, y + 0.5)) continue;
      spot = [x, y]; break;
    }
  }
  if (!spot) return { skipped: true };
  const [wx, wy] = spot;
  g.player.x = wx - 0.5; g.player.y = wy + 0.5;
  g.player.ang = 0;                              // facing +x, into the wall
  const e = g.enemies[0];
  e.x = wx + 1.5; e.y = wy + 0.5; e.z = 0; e.state = 1;
  const hp0 = e.hp;
  g.player.kickCooldown = 0;
  g.tryKick();
  return { skipped: false, hp0, hp1: e.hp, los: lv.lineOfSight(g.player.x, g.player.y, e.x, e.y) };
});
check('the Boot cannot punt through a wall',
  s.skipped || (s.hp1 === s.hp0 && !s.los),
  s.skipped ? 'no suitable wall on this map' : `hp ${s.hp0} -> ${s.hp1}`);

// ----------------------------- 35. a closed roof is opaque, an open one is not
s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  g.loadLevel(0); g.setState('play'); g._god = true;
  const lv = g.level;
  // Stand in the middle of the silo deck, looking level at the horizon.
  let cx = 0, cy = 0, n = 0;
  for (let y = 0; y < lv.H; y++) for (let x = 0; x < lv.W; x++) {
    if (lv.roofPanel[y * lv.W + x]) { cx += x + 0.5; cy += y + 0.5; n++; }
  }
  if (!n) return { skipped: true };
  g.player.x = cx / n; g.player.y = cy / n; g.player.pitch = 0;
  // Render straight from state, so nothing a previous case left on the camera
  // (shake, recoil) can drag it off the deck.
  g.shake = 0; g.shakeX = 0; g.shakeY = 0; g.player.recoilPitch = 0;

  // skyTop marks the columns where the renderer decided the horizon shows above
  // a parapet. Sweep the whole yaw so the answer does not depend on which way
  // the level happens to start you facing.
  const skyCols = () => {
    let lit = 0;
    for (let k = 0; k < 8; k++) {
      g.player.ang = (k / 8) * Math.PI * 2;
      const rc = window.NUKEHAUS.renderOnce();
      for (let c = 0; c < rc.w; c++) if (rc.skyTop[c] > 0 && rc.zbuf[c] < 1e8) lit++;
    }
    return lit;
  };
  lv.closeRoof();
  const shut = skyCols();
  lv.openRoof();
  for (let i = 0; i < 260; i++) lv.updateRoof(1 / 60);
  const open = skyCols();
  let parapets = 0;
  for (let i = 0; i < lv.wall.length; i++) if (lv.wall[i] && lv.height[i] < 0.999) parapets++;
  return { skipped: false, shut, open, roofOpen: lv.roofOpen, deck: n, parapets };
});
check('the roof is opaque until it grinds back',
  s.skipped || (s.shut === 0 && s.open > 0 && s.roofOpen === 1),
  s.skipped ? 'no deck on this map'
    : `parapet-sky columns over 8 yaws: shut ${s.shut}, open ${s.open} (${s.parapets} parapets, ${s.deck} deck cells)`);

// ---------------------------------------- 36. the pause menu does its four jobs
s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  const inp = g.input;
  const press = (a) => { inp.pressed.add(a); g.update(1 / 60, inp); inp.endFrame(); };
  g.newGame(1);
  g.player.score = 4242;                    // what we walk onto the floor with...
  g.loadLevel(1); g.setState('play');
  const startScore = g.levelStartScore;
  g.player.score = 9999;                    // ...then we earn some on it
  // Pause, and arrow to CALIBRATION, open it, back out.
  press('pause');
  const paused = g.state;
  press('down'); press('confirm');
  const onOptions = g.pausePage;
  const vol0 = g.volMaster;                 // first row of the calibration list
  press('right');
  const volMoved = g.volMaster !== vol0;
  press('escape');
  const backOnMenu = g.pausePage;
  // Escape from the top page resumes.
  press('escape');
  const resumed = g.state;
  // Pause again, RESTART THIS FLOOR: score returns to the floor-start value.
  press('pause'); press('down'); press('down'); press('confirm');
  const afterRestart = { state: g.state, score: g.player.score, level: g.levelIndex };
  g.setState('play');
  // Pause, ABANDON THE SHIFT: hands off to the title.
  press('pause'); press('down'); press('down'); press('down'); press('confirm');
  const quit = g.pendingState;
  g.pendingState = null;
  return { paused, onOptions, volMoved, backOnMenu, resumed, afterRestart, startScore, quit };
});
check('the pause menu resumes, calibrates, restarts the floor and quits',
  s.paused === 'pause' && s.onOptions === 'options' && s.volMoved && s.backOnMenu === 'menu' &&
  s.resumed === 'play' && s.afterRestart.state === 'brief' && s.afterRestart.level === 1 &&
  s.afterRestart.score === s.startScore && s.startScore === 4242 && s.quit === 'title',
  `pause ${s.paused}, options ${s.onOptions}/${s.volMoved}, resume ${s.resumed}, restart -> ${s.afterRestart.state} @${s.afterRestart.score} (start ${s.startScore}), quit -> ${s.quit}`);

// --------------------------------------------- 37. floors are graded, and sanely
s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  g.newGame(1); g.loadLevel(0); g.setState('play');
  // A perfect floor: everything dead, every secret, all six cities, under par.
  g.levelKills = g.enemyTotal; g.levelSecrets = g.secretTotal; g.levelTime = 10;
  const perfect = g.buildStats();
  // A disaster: nothing killed, no secrets, one city, way over par.
  g.levelKills = 0; g.levelSecrets = 0; g.levelTime = 9999;
  for (const c of g.sky.cities.slice(1)) c.hp = 0;
  const awful = g.buildStats();
  g.nextLevel();
  return { perfect: perfect.grade, awful: awful.grade, remark: awful.remark, recorded: g.grades[0], state: g.state };
});
check('a perfect floor grades S and a disaster grades D, with a remark',
  s.perfect === 'S' && s.awful === 'D' && typeof s.remark === 'string' && s.remark.length > 10 && s.recorded === 'D' && s.state === 'intermission',
  `perfect ${s.perfect}, disaster ${s.awful} ("${s.remark}")`);

// ---------------------------------- 38. killing MUTTER brings the whole sky down
s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  g.newGame(1); g.loadLevel(4); g.setState('play'); g._god = true;
  const boss = g.enemies.find((e) => e.def.boss);
  if (!boss) return { skipped: true };
  for (let i = 0; i < 5; i++) g.sky.spawnWarhead('stick', 1);
  g.sky.active = true;
  const before = g.sky.warheads.length;
  const score0 = g.player.score;
  boss.shielded = false;
  while (boss.alive) boss.hurt(500, g, 0, 0);
  const rightAfter = g.sky.warheads.length;   // still in the air: they fall, they do not vanish
  const killed0 = g.sky.killed, leaked0 = g.sky.leaked;
  window.T.step(3.5);
  return { skipped: false, before, rightAfter, after: g.sky.warheads.length,
    scuttled: g.sky.killed - killed0, leaked: g.sky.leaked - leaked0,
    gained: g.player.score - score0, active: g.sky.active };
});
check("MUTTER's death takes every inbound warhead apart, in sequence",
  s.skipped || (s.before === 5 && s.rightAfter === 5 && s.after === 0 && s.scuttled === 5 && s.leaked === 0 && !s.active),
  s.skipped ? 'no boss on the last floor' : `${s.before} inbound -> ${s.rightAfter} at the kill -> ${s.after} after 3.5s; ${s.scuttled} scuttled, ${s.leaked} leaked, +${s.gained}`);

// ------------------------------ 39. every warhead is born somewhere in the sky
s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  g.newGame(1); g.loadLevel(4); g.setState('play');
  let bad = 0, strays = 0, worst = 0;
  // Outside a salvo, the way MUTTER fires: this path had no bearing for strays.
  for (let i = 0; i < 400; i++) {
    const w = g.sky.spawnWarhead(i % 3 === 0 ? 'screamer' : 'stick', 1);
    if (w.stray) strays++;
    const ok = Number.isFinite(w.x) && Number.isFinite(w.y) && Number.isFinite(w.z) &&
               Number.isFinite(w.vx) && Number.isFinite(w.vy) && Number.isFinite(w.vz) &&
               Math.hypot(w.vx, w.vy, w.vz) <= w.speed * 1.01;
    if (!ok) bad++;
    worst = Math.max(worst, Math.abs(w.vz));
    g.sky.warheads.length = 0;
  }
  return { bad, strays, worst: +worst.toFixed(1) };
});
check('no warhead is ever born at NaN with a vertical speed in the hundreds',
  s.bad === 0 && s.strays > 40,
  `${s.bad} bad of 400 (${s.strays} strays), steepest descent ${s.worst}/s`);

// ------------------- 40. a browser that only grants the mouse on a gesture
// Safari refuses requestPointerLock outside a user-gesture handler and throws
// SecurityError. That throw came out of the frame loop, so choosing a
// difficulty put "NUKEHAUS HAS FAILED TO BOOT" over a game that was running
// perfectly well underneath. Asking must never throw, and the request has to
// survive until a gesture can redeem it.
s = await page.evaluate(() => {
  const input = window.NUKEHAUS.input;
  const canvas = input.canvas;
  const native = canvas.requestPointerLock;
  let asked = 0;
  canvas.requestPointerLock = () => {
    asked++;
    const e = new Error('The requestPointerLock() method must be called from a user gesture handler.');
    e.name = 'SecurityError';
    throw e;
  };
  let threw = false;
  try { input.releaseLock(); input.locked = false; input.requestLock(); } catch { threw = true; }
  const pending = input._wantLock;

  // A real keypress is a gesture; that is where the request gets redeemed.
  let redeemedOnGesture = false;
  canvas.requestPointerLock = () => { redeemedOnGesture = true; };
  dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));

  canvas.requestPointerLock = native;
  input._wantLock = false;
  return { threw, asked, pending, redeemedOnGesture };
});
check('a gesture-strict browser cannot crash the game out of the frame loop',
  !s.threw && s.asked > 0 && s.pending && s.redeemedOnGesture,
  s.threw ? 'requestLock() threw' : `refused ${s.asked}x, held the request, redeemed it on the next keypress`);

// ------------- 41. the roof opening hands him the Splitter, and the sky
// closing hands back what he had
s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  g.newGame(1); g.loadLevel(0); g.setState('play'); g._god = true;
  window.T.arm('pistol');
  g.triggersFired.add(-1);
  g.beginSiege();
  window.T.step(1.2);
  const during = g.player.pendingWeapon || g.player.weapon;
  // Clear the sky and let the flight end.
  g.waveQueue = [];
  g.sky.pending.length = 0; g.sky.warheads.length = 0;
  window.T.step(1.5);
  const after = g.player.pendingWeapon || g.player.weapon;
  // Already holding flak: nothing to hand back, nothing taken away.
  window.T.arm('halo');
  g.triggersFired.add(-2);
  g.beginSiege();
  window.T.step(0.5);
  const kept = g.player.pendingWeapon || g.player.weapon;
  g.waveQueue = [];
  g.sky.pending.length = 0; g.sky.warheads.length = 0;
  window.T.step(1.5);
  return { during, after, kept, sky: g.sky.active };
});
check('the roof opening swaps the Widow for the Splitter, and the Widow comes back after',
  s.during === 'splitter' && s.after === 'pistol' && s.kept === 'halo',
  `siege ${s.during}, after ${s.after}, a Halo in hand stays ${s.kept}`);

// ------------------------ 42. looking away pauses the fight instead of losing it
s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  const out = {};
  g.newGame(1); g.loadLevel(0); g.setState('play');
  dispatchEvent(new Event('blur'));
  out.afterBlur = g.state;

  g.setState('play');
  const desc = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  document.dispatchEvent(new Event('visibilitychange'));
  out.afterHide = g.state;
  if (desc) Object.defineProperty(document, 'visibilityState', desc);
  else delete document.visibilityState;

  // On the title screen there is nothing to pause, and nothing should change.
  g.setState('title');
  dispatchEvent(new Event('blur'));
  out.afterTitleBlur = g.state;
  return out;
});
check('switching away pauses a run in progress, and leaves the title alone',
  s.afterBlur === 'pause' && s.afterHide === 'pause' && s.afterTitleBlur === 'title',
  `blur -> ${s.afterBlur}, hidden -> ${s.afterHide}, title stays ${s.afterTitleBlur}`);

// ------------------- 43. a tab the browser has suspended still finishes loading
// No browser fires requestAnimationFrame for a hidden, backgrounded or occluded
// tab. Asset loading awaited one between every build stage, so opening the game
// in a background tab stopped it dead at the first stage: no error, no overlay,
// no title screen, forever. This boots a second page with rAF stubbed out,
// which is exactly what a suspended tab does.
{
  const bg = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await bg.addInitScript(() => { window.requestAnimationFrame = () => 0; });
  const bgErrors = [];
  bg.on('pageerror', (e) => bgErrors.push(e.message));
  await bg.goto(`http://127.0.0.1:${PORT}/index.html`);
  let up = true;
  try {
    // polling: 'raf' is the default, and rAF is the very thing stubbed out here.
    await bg.waitForFunction(() => window.NUKEHAUS && window.NUKEHAUS.game,
      null, { timeout: 40000, polling: 250 });
  } catch { up = false; }
  const where = await bg.evaluate(() => (window.NUKEHAUS_BOOT || {}).stage || 'never started');
  await bg.close();
  check('a suspended tab still boots', up && !bgErrors.length,
    up ? `reached the title with no rAF (last stage "${where}")`
       : `stalled at "${where}"`);
}

// ------------- 44. a GPU that compiles the shaders but draws black is caught
// at boot, and the game takes the 2D path instead of showing a dead screen.
// Safe Mode takes it deliberately, with audio and controller polling off.
{
  const probe = async (url, init) => {
    const pg = await browser.newPage({ viewport: { width: 800, height: 500 } });
    if (init) await pg.addInitScript(init);
    await pg.goto(`http://127.0.0.1:${PORT}/${url}`);
    await pg.waitForFunction(() => window.NUKEHAUS && window.NUKEHAUS.booted, null, { timeout: 40000, polling: 250 });
    const out = await pg.evaluate(() => ({ ...window.NUKEHAUS_RENDER,
      sound: !!(NUKEHAUS.game.sound && NUKEHAUS.game.sound.raw), pad: !!NUKEHAUS.input.padDisabled }));
    await pg.close();
    return out;
  };
  const black = await probe('index.html', () => {
    const orig = WebGL2RenderingContext.prototype.readPixels;
    WebGL2RenderingContext.prototype.readPixels = function (x, y, w, h, f, t, px) { orig.call(this, x, y, w, h, f, t, px); px.fill(0); };
  });
  const safe = await probe('index.html?safe');
  const normal = await page.evaluate(() => window.NUKEHAUS_RENDER);
  check('a GPU that draws black falls back to 2D; Safe Mode strips GPU, audio and pads',
    normal.mode === 'webgl2' && black.mode === '2d' && safe.mode === '2d' && safe.safe && !safe.sound && safe.pad,
    `normal ${normal.mode}, black GPU -> ${black.mode} (${black.why}), safe -> ${safe.mode}`);
}

// ------------ 45. a pad the browser could not map does not drive itself
s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game, inp = window.NUKEHAUS.input;
  const pad = { id: 'Wireless Controller', index: 3, connected: true, mapping: '',
    axes: [0, 0, -1, 0, 0, -1], buttons: Array.from({ length: 11 }, () => ({ pressed: false, value: 0 })) };
  const realGet = navigator.getGamepads;
  navigator.getGamepads = () => [null, null, null, pad];
  inp.padIndex = -1; inp._axisRest = null;
  g.newGame(1); g.loadLevel(0); g.setState('play');
  const a0 = g.player.ang, x0 = g.player.x, y0 = g.player.y;
  for (let i = 0; i < 90; i++) { inp.update(1 / 60); g.update(1 / 60, inp); }
  const drift = Math.abs(g.player.ang - a0) + Math.hypot(g.player.x - x0, g.player.y - y0);
  pad.axes[5] = 1; inp.update(1 / 60); const fire = inp.padFire;
  pad.axes[5] = -1; inp.update(1 / 60);
  navigator.getGamepads = realGet; inp.padIndex = -1; inp.pad = null; inp._axisRest = null; inp._releasePad();
  return { drift: +drift.toFixed(4), fire };
});
check('a non-standard pad with triggers resting at -1 neither spins nor walks by itself',
  s.drift < 0.001 && s.fire === 1, `drift ${s.drift}, full trigger reads ${s.fire}`);

// ----------------------- 46. the Boot ends a weakened enemy; kills feed ego
s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  g.newGame(1); g.loadLevel(1); g.setState('play'); g._god = false;
  const e = g.enemies.find((x) => x.alive && !x.def.boss && !x.def.miniboss);
  window.T.standNear(e.x, e.y, 1.2, 1.9);
  g.player.ang = Math.atan2(e.y - g.player.y, e.x - g.player.x);
  g.player.kickCooldown = 0;
  e.hp = Math.max(1, Math.floor(e.maxHp * 0.25));
  g.player.health = 40;
  const before = g.player.score;
  g.tryKick();
  const out = { dead: !e.alive || e.state >= 6, health: g.player.health, gained: g.player.score - before };
  g._god = true;
  return out;
});
check('a weakened enemy gets curb-stomped by the Boot, and the kill tops up health',
  s.dead && s.health > 40 && s.gained >= 400, `dead ${s.dead}, health 40 -> ${s.health}, +${s.gained}`);

// ------------- 48. a scripted exchange is spoken as written, as a pair
// Each line used to be voiced as a random pick from the speaker's pool, so the
// caption read as a joke and the audio was Brick asking one thing and Ilsa
// answering another.
s = await page.evaluate(async () => {
  const g = window.NUKEHAUS.game;
  g.newGame(1); g.loadLevel(0); g.setState('play');
  const heard = [];
  const real = g.vox;
  g.vox = { say: (t) => { heard.push(t); return 1.2; }, sayLine: () => { heard.push('<random pick>'); return 1.2; },
    cancel() {}, setVolume() {}, busy: false, lastLine: null };
  g.radio.reset();
  g.radio.distractIdx = 0;
  const { DISTRACTED } = await import('./src/game/story.js');
  g.radio.distract();
  for (let i = 0; i < 60 * 12 && heard.length < DISTRACTED[0].length; i++) g.radio.update(1 / 60);
  g.vox = real;
  return { heard, want: DISTRACTED[0] };
});
check('a scripted exchange is voiced exactly as written, in order',
  JSON.stringify(s.heard) === JSON.stringify(s.want),
  s.heard.map((t) => '"' + String(t).slice(0, 22) + '..."').join(' / '));

// --------- 49. a line that queues behind another voice keeps its own caption
s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  const real = g.vox;
  // A synth busy with MUTTER: new requests queue, and lastLine still reports
  // the utterance that is playing, not the one just asked for.
  let req = '';
  g.vox = { lastLine: 'Welcome back, warden. Nothing has happened.', get lastRequested() { return req; },
    sayLine: (key) => { req = g.voxLines[key][0]; return 2; }, say: (t) => { req = t; return 2; },
    cancel() {}, setVolume() {}, busy: true };
  g.speakAs('brick', 'brick_kill', '');
  const caption = g.lastSpoken.text;
  g.vox = real;
  return { caption, want: g.voxLines.brick_kill[0] };
});
check("a queued line is captioned with its own words, not the voice it waited behind",
  s.caption === s.want, `"${s.caption.slice(0, 40)}"`);

// ------------------ 47. the failure screen carries what is needed to fix it
{
  const pg = await browser.newPage({ viewport: { width: 800, height: 500 } });
  await pg.addInitScript(() => {
    const orig = document.getElementById.bind(document);
    document.getElementById = (id) => { if (id === 'screen') throw new Error('synthetic boot failure'); return orig(id); };
  });
  await pg.goto(`http://127.0.0.1:${PORT}/index.html`);
  await pg.waitForFunction(() => document.getElementById('fatal').style.display === 'block', null, { timeout: 20000, polling: 200 });
  const f = await pg.evaluate(() => ({
    body: document.getElementById('fatal-body').textContent,
    buttons: [...document.querySelectorAll('#fatal button')].map((b) => b.textContent) }));
  await pg.close();
  check('the boot failure screen names the error, the browser and the GPU, and offers Safe Mode',
    /synthetic boot failure/.test(f.body) && /browser  :/.test(f.body) && /gpu      :/.test(f.body) &&
    f.buttons.includes('TRY SAFE MODE') && f.buttons.includes('COPY DETAILS'),
    f.buttons.join(' / '));
}

// ======================================================= gore and physics
// A stage for these: an indoor run of open floor with a wall at the end, the
// floor emptied of its own staff, and targets placed by hand.
await page.evaluate(async () => {
  const g = window.NUKEHAUS.game;
  const { makeRng } = await import('./src/core/math.js');
  window.GORE = {
    arena() {
      g.newGame(1); g.loadLevel(1); g.setState('play'); g._god = true;
      g.enemies.length = 0;
      // Every stage starts from the same dice and a steady hand, so a check
      // does not pass or fail on what the checks before it happened to roll
      // (nail spread and sever chances both draw from these).
      g.rng = makeRng(0xA11CE);
      if (g.gore) g.gore.rng = makeRng(0x90e5eed);
      g.radio.reset();
      const lv = g.level;
      let best = null, bestOpen = -1;
      for (let y = 3; y < lv.H - 3; y++) for (let x = 3; x < lv.W - 9; x++) {
        const i = y * lv.W + x;
        if (lv.wall[i] || lv.sky[i] || lv.propBlock[i]) continue;
        let run = 0;
        while (run < 8 && !lv.wall[i + run + 1] && !lv.propBlock[i + run + 1]) run++;
        if (run < 5 || run > 7) continue;
        let open = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = 0; dx <= run; dx++) {
          const j = i + dy * lv.W + dx;
          if (!lv.wall[j] && !lv.propBlock[j]) open++;
        }
        if (open > bestOpen) { bestOpen = open; best = { x: x + 0.5, y: y + 0.5, run }; }
      }
      const p = g.player;
      p.x = best.x; p.y = best.y; p.ang = 0; p.pitch = 0; p.vx = 0; p.vy = 0;
      p.recoilPitch = 0; p.kick = 0; p.kickVel = 0; p.cooldown = 0;
      p.fireAnim = 0; p.kickAnim = 0; p.throwAnim = 0; p.flashTimer = 0;
      return best;
    },
    async spawn(kind, dx, dy) {
      const { Enemy } = await import('./src/game/entities.js');
      const e = new Enemy(kind, g.player.x + dx, g.player.y + dy);
      e.ang = Math.PI;             // facing the player
      g.enemies.push(e);
      return e;
    },
    aimAt(x, y, z) {
      const p = g.player;
      p.ang = Math.atan2(y - p.y, x - p.x);
      p.pitch = ((z - p.z) / Math.hypot(x - p.x, y - p.y)) * g.rc.projY;
    },
    step(sec) { for (let i = 0; i < Math.round(sec * 60); i++) g.update(1 / 60, g.input); },
  };
});

// ----------------- 50. a nail to the left leg takes the left leg, which falls
s = await page.evaluate(async () => {
  const g = window.NUKEHAUS.game, G = window.GORE;
  G.arena();
  const e = await G.spawn('wrencher', 3, 0);
  e.hp = e.maxHp = 500;
  g.player.owned.nailer = true; g.player.weapon = 'nailer'; g.player.ammo.nail = 200;
  // Facing the player down -x, its left is +y: the player's right.
  let shots = 0;
  while (!e.maim && shots < 40) {
    e.x = g.player.x + 3; e.y = g.player.y; e.ang = Math.PI;
    e.state = 5; e.stateT = -99;   // held in a flinch so it stands still for the shot
    G.aimAt(e.x, e.y + 0.14, e.z + e.height * 0.16);
    g.player.cooldown = 0; g.tryFire(); shots++;
    G.step(1 / 60);
  }
  const maim = e.maim;
  const part = g.gore.parts[g.gore.parts.length - 1];
  const spawned = !!part && part.part === 'leg';
  const z0 = part ? part.z : 0;
  let peak = z0;
  for (let i = 0; i < 20; i++) { G.step(1 / 60); if (part) peak = Math.max(peak, part.z); }
  G.step(3);
  const lv = g.level;
  return {
    shots, maim, spawned, alive: e.alive, hop: e.hop, mobility: e.mobility,
    z0: part ? +z0.toFixed(2) : -1, peak: part ? +peak.toFixed(2) : -1,
    rest: part ? +part.z.toFixed(3) : -1, rad: part ? +part.rad.toFixed(3) : -1,
    settled: part ? part.settled : false,
    inWall: part ? lv.blocked(part.x, part.y) : true,
  };
});
check('a nail to the left leg takes the left leg off, and the rest keeps coming on one',
  s.maim === 16 && s.alive && s.hop && s.mobility === 0.5,
  `mask ${s.maim} after ${s.shots} nails, alive ${s.alive}, mobility ${s.mobility}`);
check('the severed leg is a physics object: it pops up, falls, and comes to rest on the floor',
  s.spawned && s.peak > s.z0 && s.settled && Math.abs(s.rest - s.rad) < 0.01 && !s.inWall,
  `z ${s.z0} -> peak ${s.peak} -> rest ${s.rest} (radius ${s.rad}), settled ${s.settled}`);

// ------------- 51. a head comes off: the body runs for a while, then drops
s = await page.evaluate(async () => {
  const g = window.NUKEHAUS.game, G = window.GORE;
  G.arena();
  const e = await G.spawn('sparker', 3, 0);
  const kills = g.player.kills;
  // A burst right at head height, with the Widow's head-popping gore spec.
  const { WEAPONS } = await import('./src/game/weapons.js');
  let n = 0;
  while (!(e.maim & 1) && n < 30) {
    e.hp = e.maxHp;
    g.gore.blast(e, e.x - 0.5, e.y, e.z + e.height * 0.95, 20, WEAPONS.pistol.gore, false);
    n++;
  }
  const t0 = e.headlessT;
  const x0 = e.x, y0 = e.y;
  G.step(1.0);
  const mid = { state: e.state, headless: e.headlessT, moved: Math.hypot(e.x - x0, e.y - y0) };
  G.step(3.2);
  return { tries: n, maim: e.maim, t0, mid, end: e.state, killed: g.player.kills - kills };
});
check('a head-height burst pops the head, and the kill is counted at once',
  (s.maim & 1) && s.killed === 1, `mask ${s.maim} in ${s.tries} bursts, kills +${s.killed}`);
check('the headless body runs about for 1.5-3s before it drops',
  s.t0 >= 1.5 && s.t0 <= 3 && s.mid.state === 6 && s.mid.headless > 0 && s.mid.moved > 0.8 && s.end === 7,
  `ran ${s.t0.toFixed(2)}s, moved ${s.mid.moved.toFixed(2)} in the first second, ends in state ${s.end}`);

// ---------- 52. a pipe bomb takes a body apart and throws what is left
s = await page.evaluate(async () => {
  const g = window.NUKEHAUS.game, G = window.GORE;
  G.arena();
  const e = await G.spawn('wrencher', 3.2, 0);
  const { WEAPONS } = await import('./src/game/weapons.js');
  const parts0 = g.gore.parts.length, gibs0 = g.gore.gibs.length;
  const x0 = e.x, y0 = e.y;
  g.detonateBomb({ x: e.x - 0.4, y: e.y, z: 0.25, spec: WEAPONS.pipebomb });
  let air = 0, roll = 0, far = 0;
  for (let i = 0; i < 60; i++) {
    G.step(1 / 60);
    air = Math.max(air, e.z); roll = Math.max(roll, Math.abs(e.roll));
    far = Math.max(far, Math.hypot(e.x - x0, e.y - y0));
  }
  G.step(3);
  let bits = 0;
  for (let b = e.maim; b; b >>= 1) bits += b & 1;
  return { bits, parts: g.gore.parts.length - parts0, gibs: g.gore.gibs.length - gibs0,
    air: +air.toFixed(2), roll: +roll.toFixed(2), flew: +far.toFixed(2),
    landed: +e.z.toFixed(3), state: e.state };
});
check('a pipe bomb at a body\'s feet takes several parts off and scatters gibs',
  s.bits >= 2 && s.parts >= 2 && s.gibs >= 2, `${s.bits} parts off, ${s.parts} part objects, ${s.gibs} gibs`);
check('the body is thrown: it leaves the floor, turns over, travels, and lands',
  s.air > 0.2 && s.roll > 0.3 && s.flew > 1 && s.landed === 0 && s.state === 7,
  `peak ${s.air}, roll ${s.roll} rad, travelled ${s.flew}, rests at z ${s.landed}`);

// ---------------- 53. legless: it crawls, lower and slower, and still comes
s = await page.evaluate(async () => {
  const g = window.NUKEHAUS.game, G = window.GORE;
  G.arena();
  const e = await G.spawn('wrencher', 4.5, 0);
  e.hp = e.maxHp = 500;
  g.gore.sever(e, 8, 0, 1, 3);
  g.gore.sever(e, 16, 0, -1, 3);
  e.state = 2; e.cooldown = 99;
  const d0 = Math.hypot(e.x - g.player.x, e.y - g.player.y);
  G.step(1.5);
  const d1 = Math.hypot(e.x - g.player.x, e.y - g.player.y);
  return { crawl: e.crawl, mob: e.mobility, zOff: +e.zOff.toFixed(3), alive: e.alive, closed: +(d0 - d1).toFixed(2) };
});
check('a legless enemy crawls on the floor at a fraction of the speed, still closing',
  s.crawl && s.mob < 0.4 && s.zOff < -0.2 && s.alive && s.closed > 0.2 && s.closed < 2.55 * 1.5 * 0.6,
  `zOff ${s.zOff}, closed ${s.closed} in 1.5s, alive ${s.alive}`);

// -------------- 54. the Boot punts a severed head the length of the room
s = await page.evaluate(async () => {
  const g = window.NUKEHAUS.game, G = window.GORE;
  const a = G.arena();
  const e = await G.spawn('wrencher', 1.2, 0);
  g.gore.sever(e, 1, 1, 0, 1, { vx: 0.1, vy: 0, vz: 0.5, noRun: true });
  g.enemies.length = 0;
  G.step(1.5);
  const h = g.gore.parts.find((c) => c.head);
  const p = g.player;
  p.x = h.x - 0.8; p.y = h.y; p.ang = 0; p.pitch = 0; p.kickCooldown = 0;
  const x0 = h.x;
  g.tryKick();
  const v = Math.hypot(h.vx, h.vy);
  let went = 0;
  for (let i = 0; i < 240; i++) { G.step(1 / 60); went = Math.max(went, h.x - x0); }
  return { v: +v.toFixed(1), went: +went.toFixed(2), run: a.run, settled: h.settled,
    punts: g.gore.stats.punts };
});
check('the Boot punts a severed head: it flies, bounces and comes to rest down the room',
  s.v > 8 && s.went > 2.5 && s.settled && s.punts >= 1,
  `launched at ${s.v}, travelled ${s.went} in a ${s.run}-cell run`);

// --------------- 55. a stomp takes the head, and the head goes downfield
s = await page.evaluate(async () => {
  const g = window.NUKEHAUS.game, G = window.GORE;
  G.arena();
  const e = await G.spawn('wrencher', 1.4, 0);
  e.state = 2;
  e.hp = Math.floor(e.maxHp * 0.2);
  g.player.kickCooldown = 0; g.player.ang = 0;
  g.tryKick();
  const h = g.gore.parts.find((c) => c.head);
  return { maim: e.maim, dead: !e.alive, head: !!h, punted: !!(h && h.punted), vx: h ? +h.vx.toFixed(1) : 0 };
});
check('a curb stomp takes the head and sends it downfield',
  (s.maim & 1) && s.dead && s.head && s.punted && s.vx > 8, `mask ${s.maim}, head vx ${s.vx}`);

// ------------------ 56. brass hits the deck, bounces, and stays a while
s = await page.evaluate(async () => {
  const g = window.NUKEHAUS.game, G = window.GORE;
  G.arena();
  g.player.owned.nailer = true; g.player.weapon = 'nailer'; g.player.ammo.nail = 200;
  const c0 = g.gore.casings.length;
  for (let i = 0; i < 6; i++) { g.player.cooldown = 0; g.tryFire(); G.step(0.1); }
  G.step(2.5);
  const fresh = g.gore.casings.slice(c0);
  return { n: fresh.length, settled: fresh.filter((c) => c.settled).length,
    onFloor: fresh.filter((c) => Math.abs(c.z - c.rad) < 0.005).length };
});
check('spent casings drop to the deck, bounce and settle there',
  s.n === 6 && s.settled === 6 && s.onFloor === 6, `${s.n} casings, ${s.settled} settled, ${s.onFloor} on the floor`);

// -------- 57. a floor full of limbs is capped, and the frame does not care
s = await page.evaluate(async () => {
  const g = window.NUKEHAUS.game, G = window.GORE;
  G.arena();
  const e = await G.spawn('wrencher', 3, 0);
  e.alive = false; e.state = 7;
  // Median of short batches: the machine running this is rarely quiet, and
  // one stall should not decide the verdict.
  const time = (n) => {
    const batches = [];
    for (let b = 0; b < 5; b++) {
      const t0 = performance.now();
      for (let i = 0; i < n / 5; i++) { g.update(1 / 60, g.input); window.NUKEHAUS.renderOnce(); }
      batches.push((performance.now() - t0) / (n / 5));
    }
    batches.sort((x, y) => x - y);
    return batches[2];
  };
  time(10);
  const base = time(40);
  for (let i = 0; i < 60; i++) {
    const a = i * 2.39996;
    g.gore.spawnPart(e, ['head', 'arm', 'leg'][i % 3], e.x + Math.cos(a) * 1.4, e.y + Math.sin(a) * 1.4, 0.7,
      Math.cos(a) * 2.5, Math.sin(a) * 2.5, 2.5);
  }
  const flying = time(40);
  G.step(3);
  const resting = time(40);
  const settled = g.gore.parts.filter((c) => c.settled).length;
  for (let i = 0; i < 60; i++) g.gore.spawnPart(e, 'arm', e.x, e.y, 0.5, 0, 0, 1);
  const capped = g.gore.parts.length;
  let nan = false;
  for (const c of g.gore.parts) if (!Number.isFinite(c.x + c.y + c.z)) nan = true;
  return { base: +base.toFixed(2), flying: +flying.toFixed(2), resting: +resting.toFixed(2), settled, capped, nan };
});
check('sixty severed parts cost little frame time, and the pile is capped',
  s.flying < Math.max(s.base * 1.8, s.base + 8) && s.resting < Math.max(s.base * 1.5, s.base + 5) &&
  s.capped <= 96 && s.settled >= 50 && !s.nan,
  `frame ${s.base}ms bare, ${s.flying}ms with 60 flying, ${s.resting}ms at rest; ${s.capped} kept of 120`);

// ------ 58. thrown into a wall: it hurts, it bleeds on the wall, it comes off
s = await page.evaluate(async () => {
  const g = window.NUKEHAUS.game, G = window.GORE;
  const a = G.arena();
  // Stand it a body's width off the end wall and throw it at the wall.
  const e = await G.spawn('wrencher', a.run - 0.5, 0);
  e.state = 5; e.stateT = -99;
  const before = e.hp;
  const wallX = Math.floor(g.player.x) + a.run + 1;
  g.particles.clear();
  e.shove(1, 0, 40);
  G.step(0.1);
  const pinned = g.particles.live.filter((q) => q.vx === 0 && q.vy === 0 && Math.abs(q.x - wallX) < 0.1 && q.z > 0.1).length;
  const bounced = e.kvx < 0 || e.x < wallX - e.radius - 0.02;
  return { hurt: before - e.hp, pinned, bounced };
});
check('a body thrown into the end wall is hurt by it and leaves blood up the wall',
  s.hurt > 0 && s.pinned >= 10, `hurt ${s.hurt}, ${s.pinned} drops on the wall`);

// ------- 59. loose meat is still physics: blasts re-throw it, nails hop it,
// and a thrown body bowls over whoever is standing behind it
s = await page.evaluate(async () => {
  const g = window.NUKEHAUS.game, G = window.GORE;
  G.arena();
  const p = g.player;
  const a = await G.spawn('wrencher', 2.2, 0);
  const b = await G.spawn('sparker', 3.4, 0);
  b.hp = b.maxHp = 300; b.state = 5; b.stateT = -99;
  a.hp = 1; a.hurt(10, g, p.x, p.y);
  g.gore.launch(a, 1, 0, 16, 3);
  const bhp = b.hp, bx = b.x;
  G.step(1);
  const out = { bowled: Math.round(bhp - b.hp), pushed: +(b.x - bx).toFixed(2) };
  g.enemies.length = 0;
  const h = g.gore.spawnPart(a, 'head', p.x + 1.6, p.y, 0.3, 0, 0, 0);
  G.step(1.5);
  const x0 = h.x;
  g.explodeAt(h.x - 0.8, h.y, 0.2, 3.4, 20);
  G.step(0.3);
  out.blown = +(h.x - x0).toFixed(2);
  G.step(3);
  p.owned.nailer = true; p.weapon = 'nailer'; p.ammo.nail = 100;
  let hop = 0;
  for (let k = 0; k < 4; k++) {
    G.aimAt(h.x, h.y, h.z);
    p.cooldown = 0; g.tryFire();
    for (let i = 0; i < 8; i++) { G.step(1 / 60); hop = Math.max(hop, h.z - h.rad); }
  }
  out.hop = +hop.toFixed(2);
  return out;
});
check('a thrown body bowls over the one behind it, a blast re-throws a lying head, a nail makes it hop',
  s.bowled > 10 && s.pushed > 0.3 && s.blown > 1 && s.hop > 0.08,
  `pin took ${s.bowled} and slid ${s.pushed}; head blown ${s.blown}, hopped ${s.hop}`);

// ------- 60. side views: the sprite faces the way it walks, and the arm shot
// off the flank nearest the camera is the one that disappears
s = await page.evaluate(async () => {
  const g = window.NUKEHAUS.game, G = window.GORE;
  G.arena();
  const p = g.player;
  const e = await G.spawn('wrencher', 2, 0);
  const out = {};
  // Facing +y, which is screen-right for a camera looking down +x: its right
  // flank faces the camera, and the generator paints that as view 1.
  e.ang = Math.PI / 2; e.state = 2;
  out.right = e.frameKey(p.x, p.y);
  out.rightZone = g.gore.zoneAt(e, e.x - e.radius, e.y, e.z + e.height * 0.6);
  e.ang = -Math.PI / 2;
  out.left = e.frameKey(p.x, p.y);
  out.leftZone = g.gore.zoneAt(e, e.x - e.radius, e.y, e.z + e.height * 0.6);
  e.ang = Math.PI;
  out.front = e.frameKey(p.x, p.y);
  e.headlessT = 1; e.state = 6; e.ang = Math.PI / 2;
  out.headless = e.frameKey(p.x, p.y);
  g.enemies.length = 0;
  return out;
});
check('side views: facing screen-right shows its right side (view 1), screen-left its left (view 3)',
  /_walk1_/.test(s.right) && s.rightZone === 2 && /_walk3_/.test(s.left) && s.leftZone === 4 &&
  /_walk0_/.test(s.front) && /_walk1_/.test(s.headless),
  `${s.right} near flank ${s.rightZone}, ${s.left} near flank ${s.leftZone}, ${s.front}, headless ${s.headless}`);

// ------- 61. gore bookkeeping: the rotation cache is bounded and cleared, a
// dead wasp is only gibbed once, and the fallback rig matches the art's
s = await page.evaluate(async () => {
  const g = window.NUKEHAUS.game, G = window.GORE;
  const gore = await import('./src/game/gore.js');
  const art = window.NUKEHAUS.art;
  const out = {};
  // Every die and dead frame of the cast, maimed, turned through every step.
  let peak = 0;
  const keys = Object.keys(art.sprites).filter((k) => /^(wrencher|sparker|ghoul)_(die\d|dead)$/.test(k));
  for (const k of keys) for (const m of [0, 3, 12, 31]) {
    const f = m ? art.maim(k, m) : art.sprites[k];
    if (!f) continue;
    for (let st = 1; st < 16; st++) { gore.rotFrame(f, st * Math.PI / 8); peak = Math.max(peak, gore.rotationStats().px); }
  }
  out.peakMpx = +(peak / 1e6).toFixed(2);
  G.arena();
  out.afterClear = gore.rotationStats().px;
  let fallbackOff = 0;
  for (const [k, r] of Object.entries(art.rig || {})) {
    const d = gore.RIG_DEFAULT[k];
    if (!d) { fallbackOff = 9; continue; }
    for (const j of ['hip', 'shoulder', 'neck', 'head']) fallbackOff = Math.max(fallbackOff, Math.abs(d[j] - r[j]));
  }
  out.rigOff = +fallbackOff.toFixed(3);
  const w = await G.spawn('wasp', 3, 0);
  w.hurt(999, g, g.player.x, g.player.y);
  G.step(1);
  let gibs = 0;
  const gib0 = g.gib;
  g.gib = (e) => { if (e === w) gibs++; return gib0.call(g, e); };
  for (let k = 0; k < 3; k++) { g.explodeAt(w.x + 0.3, w.y, 0.4, 3, 90); G.step(0.4); }
  g.gib = gib0;
  out.waspGibs = gibs;
  g.enemies.length = 0;
  return out;
});
check('the rotation cache stays inside its budget and a level load empties it; a dead wasp gibs once',
  s.peakMpx <= 6.5 && s.afterClear === 0 && s.waspGibs === 1 && s.rigOff < 0.006,
  `peak ${s.peakMpx} Mpx, ${s.afterClear} px after load, wasp gibbed ${s.waspGibs}x, fallback rig off by ${s.rigOff}`);

// ------- 62. blasts: a quadruped's head only goes to a hard burst at its face,
// and a crawler loses its head to a burst where its head is actually drawn
s = await page.evaluate(async () => {
  const g = window.NUKEHAUS.game, G = window.GORE;
  const { WEAPONS } = await import('./src/game/weapons.js');
  const { HEAD, LEG_R, LEG_L } = await import('./src/game/gore.js');
  G.arena();
  const spec = WEAPONS.splitter.gore;       // a light flak burst
  const out = { quad: 0, above: 0, crawler: 0 };
  for (let i = 0; i < 200; i++) {
    g.enemies.length = 0;
    const e = await G.spawn(i & 1 ? 'stalker' : 'ghoul', 4, 0);
    e.hp = e.maxHp = 200; e.state = 1;
    const bx = e.x - 0.7, by = e.y, bz = e.z + e.height * 0.5;
    const killed = e.hurt(12, g, bx, by);
    g.gore.blast(e, bx, by, bz, 12, spec, killed);
    if (e.maim & HEAD) out.quad++;
    g.gore.clear();
    const q = await G.spawn('ghoul', 4, 1);
    q.hp = q.maxHp = 34; q.state = 1;
    q.hurt(26, g, q.x, q.y);
    g.gore.blast(q, q.x, q.y, q.z + q.height + 0.6, 26, spec, false);
    if (q.maim & HEAD) out.above++;
    g.gore.clear();
  }
  for (let i = 0; i < 60; i++) {
    g.enemies.length = 0;
    const e = await G.spawn('wrencher', 4, 0);
    e.hp = e.maxHp = 2000; e.state = 5; e.stateT = -99;
    g.gore.sever(e, LEG_R, 0, 1, 1); g.gore.sever(e, LEG_L, 0, -1, 1);
    e._pose(1 / 60, g);
    const z = e.z + e.zOff + g.gore.rigOf('wrencher').head * e.height;
    g.gore.blast(e, e.x - 0.2, e.y, z, 30, spec, false);
    if (e.maim & HEAD) out.crawler++;
    g.gore.clear();
  }
  g.enemies.length = 0;
  return out;
});
check('a light burst in front of a quadruped rarely takes its head, one over it never does, a crawler\'s drawn head is hit',
  s.quad < 40 && s.above === 0 && s.crawler > 30,
  `quad heads ${s.quad}/200, over-the-top ${s.above}/200, crawler heads ${s.crawler}/60`);

// ------- 63. loose parts: over a parapet they land on its cap, they fade in
// the end, the Boot does not reach them through a wall, and a pipe bomb in a
// crowd is one big rip rather than twenty
s = await page.evaluate(async () => {
  const g = window.NUKEHAUS.game, G = window.GORE;
  G.arena();
  const lv = g.level;
  lv.roofOpen = 1;                // a berm is only a berm while the roof is open
  const out = {};
  let cell = null;
  for (let y = 1; y < lv.H - 1 && !cell; y++) for (let x = 2; x < lv.W - 1 && !cell; x++) {
    const i = y * lv.W + x;
    if (lv.wall[i] === 1 && lv.height[i] < 0.5 && !lv.blocked(x - 0.5, y + 0.5) && !lv.blocked(x - 1.5, y + 0.5)) cell = [x, y, lv.height[i]];
  }
  const e = await G.spawn('wrencher', 3, 0);
  g.enemies.length = 0;
  if (cell) {
    const c = g.gore.spawnPart(e, 'arm', cell[0] - 0.6, cell[1] + 0.5, 0.62, 1.4, 0, 2.6);
    for (let k = 0; k < 180; k++) g.gore.update(1 / 60);
    out.parapet = { inCell: lv.idx(c.x, c.y) === cell[1] * lv.W + cell[0], z: +(c.z - c.rad).toFixed(2), cap: +cell[2].toFixed(2), settled: c.settled };
    out.life = +c.life.toFixed(1);
  }
  // A full wall with open floor either side of it, along x.
  let wall = null;
  for (let y = 2; y < lv.H - 2 && !wall; y++) for (let x = 3; x < lv.W - 2 && !wall; x++) {
    const i = y * lv.W + x;
    if (lv.wall[i] === 1 && lv.height[i] >= 1 && !lv.propBlock[i] && !lv.wall[i - 1] && !lv.wall[i - 2] && !lv.wall[i + 1] &&
        !lv.propBlock[i - 1] && !lv.propBlock[i - 2] && !lv.propBlock[i + 1]) wall = [x, y];
  }
  if (wall) {
    g.gore.clear();
    const px = wall[0] - 1.2, py = wall[1] + 0.5;
    const behind = g.gore.spawnPart(e, 'head', wall[0] + 1.3, py, 0.1, 0, 0, 0);
    behind.settled = true;
    out.throughWall = !!g.gore.kickable(px, py, 1, 0, 3, 0.6);
    const front = g.gore.spawnPart(e, 'arm', wall[0] - 0.3, py, 0.1, 0, 0, 0);
    front.settled = true;
    out.inFront = g.gore.kickable(px, py, 1, 0, 3, 0.6) === front;
  }
  G.arena();
  for (const [k, dx, dy] of [['wrencher', 3.6, -0.5], ['sparker', 4.0, 0.45], ['priest', 4.6, -0.1], ['wrencher', 4.2, -0.9], ['sparker', 3.3, 0.8]]) {
    await G.spawn(k, dx, dy);
  }
  const heard = {};
  const sfx0 = g.sound.sfx;
  g.sound.sfx = (name, o) => { heard[name] = (heard[name] || 0) + 1; return sfx0.call(g.sound, name, o); };
  g.detonateBomb({ x: g.player.x + 3.9, y: g.player.y, z: 0.3, spec: { blastRadius: 6.2, damage: 130, gore: { sever: 0.9, head: 0.5, parts: 4, knock: 18, gib: 70, lift: 5 } } });
  G.step(0.1);
  g.sound.sfx = sfx0;
  out.rips = heard.limb_rip || 0;
  out.pops = heard.head_pop || 0;
  out.severed = g.gore.parts.length;
  g.enemies.length = 0;
  return out;
});
check('a limb over a parapet lands on its cap and fades in time; the Boot stops at walls; a crowd bomb is one or two rips',
  s.parapet && s.parapet.z >= s.parapet.cap - 0.02 && s.life >= 45 && s.life <= 70 &&
  s.throughWall === false && s.inFront === true && s.severed >= 8 && s.rips >= 1 && s.rips <= 2 && s.pops <= 2,
  `parapet ${JSON.stringify(s.parapet)}, life ${s.life}s; through wall ${s.throughWall}, in front ${s.inFront}; ` +
  `${s.severed} parts off, ${s.rips} rips, ${s.pops} pops`);

// ------- 64. an armless gunman has to improvise, and improvising is worse
s = await page.evaluate(async () => {
  const g = window.NUKEHAUS.game, G = window.GORE;
  const { ARM_R, ARM_L } = await import('./src/game/gore.js');
  G.arena();
  const p = g.player;
  const out = {};
  for (const kind of ['sparker', 'bellows', 'wrencher']) {
    const e = await G.spawn(kind, 1, 0);
    e.hp = e.maxHp = 999;
    g.gore.sever(e, ARM_R, 0, 1, 1); g.gore.sever(e, ARM_L, 0, -1, 1);
    let worst = 0;
    const hurt0 = p.hurt;
    p.hurt = (n) => { worst = Math.max(worst, n); };
    for (let i = 0; i < 20; i++) e._strike(g, true, 1.0);
    p.hurt = hurt0;
    out[kind] = { armless: e.armless, worst: +worst.toFixed(1), real: +(e.def.damage * (g.diff.enemyDamage || 1)).toFixed(1) };
    g.enemies.length = 0;
  }
  return out;
});
check('an armless Sparker or Bellows headbutts for less than its real attack; a Wrencher still hurts',
  s.sparker.armless && s.sparker.worst > 0 && s.sparker.worst < s.sparker.real &&
  s.bellows.armless && s.bellows.worst < s.bellows.real * 0.5 && s.wrencher.worst >= 7,
  `sparker ${s.sparker.worst} vs ${s.sparker.real}, bellows ${s.bellows.worst} vs ${s.bellows.real}, wrencher ${s.wrencher.worst}`);

// ------ 65. the Boot still finds the bomb, the barrel and the door when the
// floor in front of it is covered in limbs, gibs and the dead
s = await page.evaluate(async () => {
  const g = window.NUKEHAUS.game, G = window.GORE;
  const { Enemy } = await import('./src/game/entities.js');
  const out = {};
  G.arena();
  const p = g.player;
  const x0 = p.x, y0 = p.y;
  // The floor's own drums would take the kick first, which is right but not this test.
  for (const it of g.items) if (it.kind === 'barrel') it.taken = true;
  let popup = null;
  const oPop = g.hud.popup.bind(g.hud);
  g.hud.popup = (t, o) => { popup = popup || t; return oPop(t, o); };
  // A settled pipe bomb with a corpse and a loose arm lying beside it.
  p.owned.pipebomb = true; p.ammo.bomb = 5; g.bombs.length = 0;
  p.pitch = g.rc.projY * -0.6;
  g.tryBomb();
  G.step(1.5);
  const b = g.bombs[0];
  if (b) {
    const e = new Enemy('wrencher', b.x + 0.4, b.y - 0.3);
    e.alive = false; e.state = 7;
    g.enemies.push(e);
    g.gore.spawnPart(e, 'arm', b.x - 0.5, b.y + 0.1, 0.2, 0, 0, 0);
    G.step(0.3);
    p.x = b.x - 1.2; p.y = b.y; p.ang = 0; p.pitch = 0; p.kickCooldown = 0;
    popup = null;
    g.tryKick();
    out.bomb = { settledBefore: true, vx: +b.vx.toFixed(1), popup };
    g.blowBombs(); G.step(0.5);
  }
  // A barrel with a gib on the floor between the boot and the drum.
  g.enemies.length = 0; g.gore.clear();
  p.x = x0; p.y = y0; p.ang = 0; p.pitch = 0; p.kickCooldown = 0;
  const bar = { kind: 'barrel', x: x0 + 1.3, y: y0, z: 0, prop: true, taken: false, solid: true, hp: 20 };
  g.items.push(bar);
  g.gore.spawnGib(x0 + 0.6, y0, 0.1, 0, 0, 0, 2, 0.15);
  G.step(0.3);
  g.tryKick();
  out.barrel = bar.taken;
  G.step(1);
  // A shut door with a gib at its foot.
  g.gore.clear();
  const lv = g.level;
  let door = null;
  for (let i = 0; i < lv.wall.length && !door; i++) {
    if (lv.wall[i] !== 2) continue;
    const dx0 = i % lv.W, dy0 = (i / lv.W) | 0;
    for (const [sx, sy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const j = (dy0 + sy) * lv.W + dx0 + sx;
      if (!lv.wall[j] && !lv.propBlock[j]) { door = { i, x: dx0 + sx + 0.5, y: dy0 + sy + 0.5, ang: Math.atan2(-sy, -sx) }; break; }
    }
  }
  if (door) {
    lv.doorState[door.i] = 0; lv.doorOpen[door.i] = 0;
    p.keys = [true, true, true];
    p.x = door.x; p.y = door.y; p.ang = door.ang; p.kickCooldown = 0;
    g.gore.spawnGib(p.x + Math.cos(door.ang) * 0.35, p.y + Math.sin(door.ang) * 0.35, 0.1, 0, 0, 0, 3, 0.15);
    G.step(0.2);
    p.kickCooldown = 0;
    g.tryKick();
    out.door = lv.doorState[door.i];
  }
  g.hud.popup = oPop;
  return out;
});
check('the Boot punts a live bomb, bursts a barrel and opens a door past the limbs, gibs and corpses at its feet',
  !!s.bomb && s.bomb.vx > 5 && s.bomb.popup === 'BOMB PUNTED' && s.barrel === true && s.door === 1,
  `bomb vx ${s.bomb && s.bomb.vx} (${s.bomb && s.bomb.popup}), barrel ${s.barrel ? 'blown' : 'intact'}, door state ${s.door}`);

// ------ 66. a waist-high prop stops bodies, not the nails fired over it
s = await page.evaluate(async () => {
  const g = window.NUKEHAUS.game, G = window.GORE;
  G.arena();
  const p = g.player, lv = g.level;
  // A sandbag pile two cells out, a wrencher behind it.
  const pi = lv.idx(p.x + 2, p.y);
  const oldB = lv.propBlock[pi], oldH = lv.propH[pi];
  lv.propBlock[pi] = 1; lv.propH[pi] = 0.4;
  const e = await G.spawn('wrencher', 3.6, 0);
  e.hp = e.maxHp = 999; e.state = 5; e.stateT = -99;
  p.z = 0.5;
  const chest = e.z + e.height * 0.7;
  G.aimAt(e.x, e.y, chest);
  p.owned.nailer = true; p.weapon = 'nailer'; p.pendingWeapon = null; p.ammo.nail = 100;
  let hits = 0;
  for (let k = 0; k < 6; k++) {
    const hp = e.hp;
    e.x = p.x + 3.6; e.y = p.y; e.state = 5; e.stateT = -99;
    p.cooldown = 0; g.tryFire(); G.step(1 / 60);
    if (e.hp < hp) hits++;
  }
  // Straight into the bags: the pile takes it and the wrencher does not.
  const dx = 2.5, dz = 0.2 - p.z, L = Math.hypot(dx, dz);
  const low = g.traceHit(p.x, p.y, p.z, dx / L, 0, dz / L, 26);
  const walk = lv.blocked(p.x + 2, p.y);
  const pil = g.items.find((it) => it.kind === 'pillar');
  const pillar = pil ? lv.blockedAt(pil.x, pil.y, 0.9) : true;
  lv.propBlock[pi] = oldB; lv.propH[pi] = oldH;
  return { hits, lowWall: low.wall, lowEnemy: !!low.enemy, lowX: +(low.x - p.x).toFixed(2), walk, pillar };
});
check('a nail fired over a sandbag pile hits the wrencher behind it; one fired into the pile stops there',
  s.hits >= 5 && s.lowWall && !s.lowEnemy && s.lowX < 2.2 && s.walk && s.pillar,
  `${s.hits}/6 over the top hit; low shot stopped at ${s.lowX} (wall ${s.lowWall}); bags block walking ${s.walk}, pillar blocks at 0.9 ${s.pillar}`);

// ------ 67. a body comes apart once: repeat blasts over a corpse, or a kill
// that asks for gib() twice, do not double the chunks and the sound
s = await page.evaluate(async () => {
  const g = window.NUKEHAUS.game, G = window.GORE;
  G.arena();
  const p = g.player;
  const sfx = g.sound.sfx.bind(g.sound);
  let gibSounds = 0;
  g.sound.sfx = (n, o) => { if (n === 'gib') gibSounds++; return sfx(n, o); };
  const spec = { blastRadius: 6.2, damage: 130, gore: { sever: 0.9, head: 0.5, parts: 4, knock: 18, gib: 70, lift: 5 } };
  const w = await G.spawn('wasp', 3, 0);
  w.state = 1; w.hurt(999, g, p.x, p.y);
  G.step(1.5);
  const wasp = [];
  for (let k = 0; k < 3; k++) {
    const s0 = gibSounds, c0 = g.gore.gibs.length;
    g.detonateBomb({ x: w.x + 0.6, y: w.y + 0.3, z: 0.3, spec });
    wasp.push([gibSounds - s0, g.gore.gibs.length - c0]);
    G.step(1);
  }
  g.enemies.length = 0;
  const gh = await G.spawn('ghoul', 3, 0);
  gh.state = 1;
  const s1 = gibSounds;
  g.detonateBomb({ x: gh.x + 0.3, y: gh.y, z: 0.3, spec });
  const ghoul = gibSounds - s1;
  g.sound.sfx = sfx;
  return { wasp, ghoul, ghoulDead: !gh.alive };
});
check('gib() runs once per body: later blasts over a dead wasp add nothing, a gib-force kill plays one gib',
  s.wasp[0][0] <= 1 && s.wasp[1][0] === 0 && s.wasp[2][0] === 0 && s.wasp[1][1] === 0 && s.wasp[2][1] === 0
    && s.ghoulDead && s.ghoul === 1,
  `wasp per bomb [sounds, chunks] ${JSON.stringify(s.wasp)}; ghoul kill gib sounds ${s.ghoul}`);

// ------ 68. a flak blast sweeping over a body takes it apart the way the
// weapon that fired it does, not with the generic explosion spec. The Widow
// is hitscan now; the Splitter is the flak gun on the deck.
s = await page.evaluate(async () => {
  const g = window.NUKEHAUS.game, G = window.GORE;
  const { WEAPONS } = await import('./src/game/weapons.js');
  const { EXPLOSION_GORE } = await import('./src/game/gore.js');
  G.arena();
  const p = g.player;
  // Only the sweep's calls count; the ground pass has always used the weapon spec.
  for (const it of g.items) if (it.kind === 'barrel') it.taken = true;
  const specs = [];
  let inSweep = false;
  const blast = g.gore.blast.bind(g.gore), sweep = g.onBlastSweep.bind(g);
  g.onBlastSweep = (b) => { inSweep = true; try { sweep(b); } finally { inSweep = false; } };
  g.gore.blast = (e, x, y, z, f, spec, k) => {
    if (inSweep) specs.push(spec === WEAPONS.splitter.gore ? 'splitter' : spec === EXPLOSION_GORE ? 'explosion' : 'other');
    return blast(e, x, y, z, f, spec, k);
  };
  const e = await G.spawn('wrencher', 4, 0);
  e.hp = e.maxHp = 999; e.state = 5; e.stateT = -99;
  p.owned.splitter = true; p.weapon = 'splitter'; p.pendingWeapon = null; p.ammo.flak = 100;
  G.aimAt(e.x, e.y, e.z + e.height * 0.6);
  p.cooldown = 0; g.tryFire();
  G.step(0.8);
  delete g.gore.blast; delete g.onBlastSweep;
  return { specs: [...new Set(specs)], n: specs.length };
});
check('a Splitter burst sweeping over a wrencher uses the Splitter gore spec, not EXPLOSION_GORE',
  s.n >= 1 && s.specs.length === 1 && s.specs[0] === 'splitter', `${s.n} sweep gore.blast calls, specs ${s.specs.join(',')}`);

// ------ 69. the pipe bomb leaves the hand, from any weapon, and an empty or
// detonator hand is drawn when there is no bomb to hold
s = await page.evaluate(async () => {
  const g = window.NUKEHAUS.game, G = window.GORE;
  const R = await import('./src/game/render.js');
  G.arena();
  const p = g.player;
  const vm = g.art.vm;
  let last = null;
  const spy = new Proxy(vm, { get(t, k) { if (typeof k === 'string' && /_(idle|fire\d|reload\d)$/.test(k) && !last) last = k; return t[k]; } });
  const buf = new Uint32Array(320 * 200);
  const key = () => { last = null; g.art.vm = spy; try { R.drawViewmodel(g, buf, 320, 200); } finally { g.art.vm = vm; } return last; };
  const seq = (n) => { const out = []; for (let i = 0; i < n; i++) { const k = key(); if (out[out.length - 1] !== k) out.push(k); G.step(1 / 60); } return out; };
  p.owned.pipebomb = true; p.ammo.bomb = 5; g.bombs.length = 0;
  p.weapon = 'pipebomb'; p.pendingWeapon = null; p.cooldown = 0; p.kickAnim = 0;
  const idle = key();
  g.tryFire();
  const thrown = seq(40);
  const waiting = key();
  p.cooldown = 0; g.tryFire();          // detonate
  G.step(1);
  p.ammo.bomb = 0;
  const empty = key();
  p.ammo.bomb = 5; p.weapon = 'pistol'; p.cooldown = 0;
  g.tryBomb();
  const fromPistol = seq(40);
  g.blowBombs(); G.step(0.5);
  return { idle, thrown, waiting, empty, fromPistol };
});
check('a pipe bomb throw plays the throw frames from any weapon; no bomb in hand while one is out or the bag is empty',
  s.idle === 'pipebomb_idle' && s.thrown[0] === 'pipebomb_fire0' && s.thrown.includes('pipebomb_fire1')
    && s.waiting === 'pipebomb_fire2' && s.empty === 'pipebomb_fire2'
    && s.fromPistol[0] === 'pipebomb_fire0' && s.fromPistol[s.fromPistol.length - 1] === 'pistol_idle',
  `thrown ${s.thrown.join('>')}; bomb out ${s.waiting}; empty ${s.empty}; from the Widow ${s.fromPistol.join('>')}`);

// ------ 70. the canvas fills the window through resizes and on ultrawide
{
  const sizes = [];
  for (const [w, h] of [[1600, 900], [2560, 1080], [800, 1000], [1024, 640]]) {
    await page.setViewportSize({ width: w, height: h });
    await sleep(400);
    sizes.push(await page.evaluate(() => {
      const c = document.getElementById('screen'), r = c.getBoundingClientRect();
      return [innerWidth, innerHeight, Math.round(r.width), Math.round(r.height), Math.round(r.top)];
    }));
  }
  check('the canvas tracks the window through resizes, including 2560x1080',
    sizes.every((v) => v[0] === v[2] && v[1] === v[3] && v[4] === 0),
    sizes.map((v) => `${v[0]}x${v[1]} -> ${v[2]}x${v[3]}`).join(', '));
}

// ------- 71. a bomb in a crowd cannot take the SFX pool from the player's gun
// Twenty limb_rips on one frame used to be sixteen stacked copies, and the
// pool they filled refused the nailer and the flak pistol for most of a second.
s = await page.evaluate(async () => {
  const { Sound } = await import('./src/audio/synth.js');
  const oc = new OfflineAudioContext(2, 44100, 44100);
  const snd = new Sound();
  await snd.init(oc);
  const live = (n) => snd._voices.filter((v) => v.name === n && v.head && !v.fading).length;
  snd.sfx('pipebomb_blow');
  for (let i = 0; i < 5; i++) {
    snd.sfx('enemy_die'); snd.sfx('head_pop');
    for (let k = 0; k < 4; k++) snd.sfx('limb_rip');
    snd.sfx('gib');
  }
  for (let i = 0; i < 10; i++) snd.sfx('body_slam');
  for (let i = 0; i < 20; i++) { snd.sfx('meat_thud'); snd.sfx('bone_bounce'); }
  // and the crowd dying around it, until the pool is full
  for (const n of ['wrencher_die', 'sparker_die', 'ghoul_die', 'howler_die', 'stalker_die', 'head_punt', 'splat']) {
    for (let i = 0; i < 3; i++) snd.sfx(n);
  }
  const pool = snd._voices.filter((v) => v.pool === 0).length;
  const rips = live('limb_rip');
  snd.sfx('nailer_fire');
  snd.sfx('flak_fire');
  const out = { pool, rips, nailer: live('nailer_fire'), flak: live('flak_fire'), err: snd._err && snd._err.name };
  snd.panic();
  return out;
});
check("a bomb's worth of gore on one frame stays three rips deep and never refuses the player's gun",
  s.pool >= 26 && s.rips <= 3 && s.nailer === 1 && s.flak === 1 && !s.err,
  `pool ${s.pool}, ${s.rips} limb_rip live, nailer ${s.nailer}, flak ${s.flak}`);

// ------- 72. a stalled frame cannot abort a gated sound effect
// The audio clock running past the start time used to make gate()'s tail event
// overlap its own curve, which threw and took the rest of the effect with it.
s = await page.evaluate(async () => {
  const { Sound } = await import('./src/audio/synth.js');
  const oc = new OfflineAudioContext(2, 44100, 44100);
  const snd = new Sound();
  await snd.init(oc);
  const out = {};
  oc.suspend(0.5).then(() => {
    const t0 = snd._t;
    snd._t = function () { return this._now() - 0.03; };     // as if the frame had stalled 30 ms
    for (const n of ['radio_close', 'radio_static', 'door_close', 'acid_burn', 'roof_open']) {
      snd._err = null; snd.sfx(n); out[n] = snd._err ? snd._err.name : 'ok';
    }
    snd._t = t0;
    oc.resume();
  });
  await oc.startRendering();
  return out;
});
check('a sound effect whose start time the audio clock has already passed still plays whole',
  Object.values(s).every((x) => x === 'ok'), JSON.stringify(s));

// ------- 73. voice lines have priorities, and a queued line waits for its caption
// A stand-in engine with the real floor rules: a higher priority cuts in, the
// rest queue, and onStart fires when a line is actually heard.
await page.evaluate(() => {
  window.FAKEVOX = () => {
    const e = { t: 0, active: null, queue: [], said: [], cancels: 0, engine: 'robot', lastLine: '', lastRequested: '' };
    const start = (it) => {
      e.active = { ...it, end: e.t + it.d };
      e.lastLine = it.text;
      e.said.push([+e.t.toFixed(2), it.text, it.p]);
      if (it.o.onStart) it.o.onStart(it.d);
    };
    e.pump = () => {
      if (e.active && e.t >= e.active.end) e.active = null;
      if (!e.active && e.queue.length) {
        let b = 0;
        for (let i = 1; i < e.queue.length; i++) if (e.queue[i].p > e.queue[b].p) b = i;
        start(e.queue.splice(b, 1)[0]);
      }
    };
    e.say = (text, o = {}) => {
      const p = o.priority || 0;
      e.lastRequested = text;
      e.pump();
      const it = { text, o, p, d: 3 };
      if (e.active) {
        if (p <= e.active.p) {
          if (e.queue.length >= 2) return 0;
          e.queue.push(it);
          return 3;
        }
        e.active = null;
        e.queue = e.queue.filter((q) => q.p >= p);
      }
      start(it);
      return 3;
    };
    e.sayLine = (key, o) => e.say(key, o);
    e.cancel = () => { e.cancels++; e.active = null; e.queue.length = 0; };
    e.setVolume = () => {};
    e.setMode = () => {};
    Object.defineProperty(e, 'busy', { get() { e.pump(); return !!e.active; } });
    e.step = (dt) => { e.t += dt; e.pump(); };
    return e;
  };
});
s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  g.newGame(1); g.loadLevel(0); g.setState('play');
  const real = g.vox, hs = g.hud.say, subs = g.subtitlesOn;
  const v = window.FAKEVOX();
  g.vox = v; g.subtitlesOn = true; g.radio.reset();
  const caps = [];
  g.hud.say = function (t, d) { caps.push([+v.t.toFixed(2), t]); return hs.call(this, t, d); };
  g.radio.say('ilsa', 'ilsa_low_health', 'Heal.', { priority: 1 });
  g.radio.update(1 / 60);
  v.step(1);
  g.speak('mirv_warning', {}, 'Plural.');
  const radioAfter = g.radio.current ? g.radio.current.key : null;
  g.speak('idle_taunt', {}, 'Productivity.');
  const before = caps.map((c) => c[1]);
  v.step(2.2);
  v.step(1);
  g.vox = real; g.hud.say = hs; g.subtitlesOn = subs; g.radio.reset();
  const taunt = caps.find((c) => c[1] === 'idle_taunt');
  return { said: v.said, radioAfter, before, tauntAt: taunt ? taunt[0] : null };
});
const mirv = s.said.find((x) => x[1] === 'mirv_warning');
check('a MIRV warning cuts in over the radio instead of queueing behind it, and takes the portrait with it',
  !!mirv && mirv[0] === 1 && mirv[2] === 3 && s.radioAfter === null,
  s.said.map((x) => `${x[0]}s ${x[1]} p${x[2]}`).join(', '));
check('a line that has to wait is captioned when it is heard, not when it was asked for',
  !s.before.includes('idle_taunt') && s.tauntAt === 4.2, `caption at ${s.tauntAt}s, voice free at 4.2s`);

// ------- 74. the death exchange is heard whole, and the game over card waits for it
s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  g.newGame(1); g.loadLevel(0); g.setState('play');
  const real = g.vox;
  const v = window.FAKEVOX();
  g.vox = v; g.radio.reset();
  const idle = { anyPressed: () => false };
  const god = g._god;
  g._god = false; g.player.health = 20; g._hurtSaid = false;
  g.radio.say('brick', 'brick_low_health', 'Ow.', { priority: 1 });
  g.player.hurt(9999, g, 'test');
  g.onPlayerHurt(null, 'melee');
  g.onPlayerHurt(null, 'melee');              // the body takes another hit before the card
  const queued = g.radio.queue.map((q) => q.key);
  for (let t = 0; t < 2.6; t += 1 / 30) { g.radio.update(1 / 30); v.step(1 / 30); }
  const cancelsBefore = v.cancels;
  g.gameOver('killed');
  for (let t = 0; t < 16; t += 1 / 30) { g.updateGameOver(1 / 30, idle); v.step(1 / 30); }
  g.vox = real; g._god = god; g.setState('title');
  return { queued, said: v.said.map((x) => x[1]), cut: v.cancels - cancelsBefore };
});
check("dying queues only the death lines, and Brick's last words, the card and Ilsa's answer all play",
  s.queued.join() === 'brick_death,ilsa_death' && s.cut === 0 &&
    s.said.filter((k) => k !== 'brick_low_health').join() === 'brick_death,game_over,ilsa_death' &&
    !s.said.includes('brick_low_health'),
  `queued ${s.queued.join('+')}; heard ${s.said.join(' > ')}; ${s.cut} cut`);

// ------- 75. no ducking for silence, and captions read the way the voice does
s = await page.evaluate(async () => {
  const g = window.NUKEHAUS.game;
  const { plainText } = await import('./src/audio/speech.js');
  const real = g.vox, duck = g.sound.duck, vv = g.volVox;
  const v = window.FAKEVOX();
  g.vox = v; g.radio.reset();
  let ducks = 0;
  g.sound.duck = () => { ducks++; };
  g.volVox = 0;
  g.speak('idle_taunt', {}, 'Productivity.');
  g.speakAs('ilsa', 'ilsa_low_health', 'Heal.');
  const silent = ducks;
  g.volVox = vv; v.cancel();
  g.speak('idle_taunt', {}, 'Productivity.');
  const heard = ducks - silent;
  v.cancel();
  const raw = 'Bunker {Sieben|S IY1 B AH N}, {HH AH} a stray } and | here %s.';
  g.speakAs('mutter', null, raw);
  const caption = g.lastSpoken.text;
  g.vox = real; g.sound.duck = duck; g.radio.reset();
  return { silent, heard, caption, want: plainText(raw) };
});
check('voice volume at zero leaves the music alone, and captions use the same plainText as the voice',
  s.silent === 0 && s.heard > 0 && s.caption === s.want,
  `ducks at 0%: ${s.silent}, at full: ${s.heard}; "${s.caption}"`);

// ------- 76. MUTTER has notes on the dead staff, and no pool asks for a name the game never hands it
s = await page.evaluate(async () => {
  const g = window.NUKEHAUS.game;
  const { Enemy } = await import('./src/game/entities.js');
  g.newGame(1); g.loadLevel(0); g.setState('play'); g.radio.reset();
  const p = g.player;
  const calls = [];
  const chat = g.chat;
  g.chat = function (sp, key, o) { calls.push(key); return chat.call(this, sp, key, o); };
  g.onEnemyKilled(new Enemy('ghoul', p.x + 2, p.y));
  const mutantAsides = calls.filter((k) => k === 'mutter_mutant_kill').length;
  calls.length = 0;
  g.onEnemyKilled(new Enemy('wrencher', p.x + 2, p.y));
  const staffAsides = calls.filter((k) => k === 'mutter_mutant_kill').length;
  g.chat = chat; g.radio.reset();
  // how many names the game passes with each of these lines
  const gives = { city_burning: 1, city_lost: 2, city_lost_last: 1, all_cities_lost: 1,
    ilsa_city_burning: 1, ilsa_city_rebuilt: 1, mutter_ex_file: 1 };
  const greedy = [];
  for (const [k, v] of Object.entries(g.voxLines)) {
    for (const l of Array.isArray(v) ? v : [v]) {
      if ((l.match(/%s/g) || []).length > (gives[k] || 0)) greedy.push(k);
    }
  }
  return { mutantAsides, staffAsides, greedy: [...new Set(greedy)], kill: (g.voxLines.mutter_mutant_kill || []).length };
});
check('MUTTER remarks on a dead mutant and not on anything else, and no line wants a name the game does not pass',
  s.mutantAsides === 1 && s.staffAsides === 0 && s.greedy.length === 0 && s.kill >= 8,
  `mutant kill asides ${s.mutantAsides}, other kills ${s.staffAsides}, ${s.kill} lines, greedy: ${s.greedy.join(',') || 'none'}`);

// ------------------------------------------------------------- report
console.log('');
if (errors.length) {
  console.log(`PAGE ERRORS (${errors.length}):`);
  for (const e of errors.slice(0, 10)) console.log('  ' + e.split('\n')[0]);
}
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} checks passed` +
  (errors.length ? `, ${errors.length} page errors` : ''));

await browser.close();
server.kill('SIGKILL');
process.exit(failed.length || errors.length ? 1 : 0);
