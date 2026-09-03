// playtest.js - drives NUKEHAUS through its actual systems and asserts that the
// combat loop works: warheads spawn, flak bursts kill them, chains score,
// cities die when they leak, enemies fight, and levels can be completed.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const OUT = '/tmp/claude-0/-home-user-MComm/1d9ae501-9927-5c9d-832d-0ee312d588ac/scratchpad/shots';
const PORT = 8141;
fs.mkdirSync(OUT, { recursive: true });

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'],
  { cwd: ROOT, stdio: 'ignore' });
process.on('exit', () => { try { server.kill('SIGKILL'); } catch {} });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(700);

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
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
    // Point the camera at a world point and set the fuse to the true range.
    aimAt(x, y, z, exact = true) {
      const p = g.player;
      const dx = x - p.x, dy = y - p.y, dz = z - p.z;
      p.ang = Math.atan2(dy, dx);
      const horiz = Math.hypot(dx, dy);
      p.pitch = Math.tan(Math.atan2(dz, horiz)) * g.rc.projY;
      if (exact) { p.fuse = Math.hypot(dx, dy, dz); p.autoFuse = false; }
      return Math.hypot(dx, dy, dz);
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
      g.player.cooldown = 0; g.player.autoFuse = false;
    },
    step(seconds, dt = 1 / 60) {
      for (let i = 0; i < Math.round(seconds / dt); i++) g.update(dt, g.input);
    },
    god(on) { g._god = on; },
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
  g.loadLevel(0); g.setState('play'); g._god = true; window.T.arm('pistol');
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

// ----------------------------------------------- 4. contact does NOT kill
s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  g.loadLevel(0); g.setState('play'); g._god = true; window.T.arm('pistol');
  g.player.score = 0;
  const w = g.sky.spawnWarhead('stick', 1);
  w.vx = w.vy = w.vz = 0;                    // park it
  window.T.aimAt(w.x, w.y, w.z, false);
  g.player.fuse = 6;                          // burst right at the muzzle
  g.player.autoFuse = false;
  window.T.fire();
  window.T.step(4);
  return { alive: g.sky.warheads.length, score: g.player.score };
});
check('contact alone does not kill (fuse matters)', s.alive === 1 && s.score === 0,
  `warheads ${s.alive}, score ${s.score}`);

// ------------------------------------------------------- 5. chain reaction
s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  g.loadLevel(0); g.setState('play'); g._god = true; window.T.arm('pistol');
  g.player.score = 0; g.sky.bestChain = 0;
  // A tight cluster: one burst should cook off the rest.
  const base = g.sky.spawnWarhead('stick', 1);
  base.vx = base.vy = base.vz = 0;
  for (let i = 0; i < 5; i++) {
    const w = g.sky.spawnWarhead('stick', 1);
    w.x = base.x + (i + 1) * 4.6;
    w.y = base.y + (i % 2) * 1.2;
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
  window.T.aimAt(e.x, e.y, e.z + 0.4, false);
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
  g.loadLevel(0); g.setState('play'); g._god = true; window.T.arm('pistol', 999);
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

// ---------------------------------------- 11. auto-range produces a lock
s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  g.loadLevel(0); g.setState('play'); g._god = true; window.T.arm('pistol');
  g.player.fuse = 52;
  const w = g.sky.spawnWarhead('stick', 1);
  window.T.aimAt(w.x, w.y, w.z, false);
  g.player.autoFuse = true;
  window.T.step(0.6);
  const lock = g.rangeLock;
  return { has: !!lock, range: lock ? +lock.range.toFixed(1) : 0,
    fuse: +g.player.fuse.toFixed(1),
    err: lock ? Math.abs(g.player.fuse - lock.range) / lock.range : 1 };
});
check('auto-ranging locks and dials the fuse', s.has && s.err < 0.15,
  `lock ${s.range}m, fuse ${s.fuse}m`);

// -------------------------- 11b. the precision bonus is for manual fuses only
s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  const shoot = (auto) => {
    g.loadLevel(0); g.setState('play'); g._god = true; window.T.arm('pistol');
    g.player.score = 0;
    const w = g.sky.spawnWarhead('stick', 1);
    window.T.aimLead(w);
    g.player.autoFuse = auto;
    window.T.step(0.1);
    // Both shots are equally well aimed; only the source of the fuse differs.
    window.T.aimLead(w);
    g.player.autoFuse = auto;
    if (auto && g.rangeLock) g.player.fuse = g.rangeLock.range;
    window.T.fireNow();
    window.T.step(3);
    return g.player.score;
  };
  return { manual: shoot(false), auto: shoot(true) };
});
check('a hand-dialled fuse pays double, auto-ranging does not',
  s.manual >= 200 && s.auto > 0 && s.auto < s.manual,
  `manual ${s.manual}, auto ${s.auto}`);

// ---------------------------------------- 12. long soak: no leaks, no NaN
s = await page.evaluate(() => {
  const g = window.NUKEHAUS.game;
  g.loadLevel(2); g.setState('play'); g._god = true; window.T.arm('pistol', 999);
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
