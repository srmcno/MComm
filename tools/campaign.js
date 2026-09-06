// campaign.js - a bot plays the whole game headlessly and reports what happened.
// This is the balance instrument: it says whether the campaign is completable,
// how long each level takes, how much health it costs, and how many cities
// survive at each difficulty.
import { chromium } from 'playwright-core';
import { chromePath } from './chrome-path.js';
import { spawn } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const PORT = Number(process.env.CAMPAIGN_PORT || 8149);
// Accept a name or an index; `Number('clerical') | 0` silently meant CLERICAL.
const DIFF_NAMES = ['clerical', 'warden', 'last shift', 'lastshift'];
const raw = process.argv[2];
let DIFF = 1;
if (raw !== undefined) {
  const n = Number(raw);
  if (Number.isFinite(n)) DIFF = n | 0;
  else {
    const i = DIFF_NAMES.indexOf(String(raw).toLowerCase());
    if (i < 0) { console.error(`unknown difficulty "${raw}" — use 0|1|2 or clerical|warden|"last shift"`); process.exit(2); }
    DIFF = Math.min(i, 2);
  }
}
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'],
  { cwd: ROOT, stdio: 'ignore' });
process.on('exit', () => { try { server.kill('SIGKILL'); } catch {} });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(600);

const browser = await chromium.launch({
  ...(chromePath() ? { executablePath: chromePath() } : {}),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--mute-audio', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
const errs = [];
page.on('pageerror', (e) => errs.push((e.stack || e.message).split('\n').slice(0, 2).join(' | ')));
await page.goto(`http://127.0.0.1:${PORT}/index.html`);
await page.waitForFunction(() => window.NUKEHAUS && window.NUKEHAUS.game, { timeout: 90000 });
await sleep(500);

const report = await page.evaluate(async (difficulty) => {
  const g = window.NUKEHAUS.game;

  // A synthetic input the bot drives instead of a keyboard.
  const IN = {
    mouseDX: 0, mouseDY: 0, wheel: 0, padLookX: 0, padLookY: 0, locked: true,
    fwd: 0, strafe: 0, run: true,
    isDown: () => false, justPressed: () => false, justReleased: () => false,
    rawJustPressed: () => false, anyPressed: () => false,
    firing: () => false, rumble: () => {}, update: () => {},
    padActive: false, lookScale: 1, mouseMoved: false, padSeen: false,
    axes() { return { fwd: this.fwd, strafe: this.strafe, turn: 0, run: this.run }; },
    endFrame() { this.mouseDX = 0; this.mouseDY = 0; this.wheel = 0; },
    requestLock() {}, releaseLock() {},
  };

  const path2 = (lv, sx, sy, test) => {
    // BFS over the grid, treating a locked door as passable only with its key.
    const W = lv.W, H = lv.H;
    const prev = new Int32Array(W * H).fill(-1);
    const seen = new Uint8Array(W * H);
    const q = [(sy | 0) * W + (sx | 0)];
    seen[q[0]] = 1;
    let goal = -1;
    for (let h = 0; h < q.length && goal < 0; h++) {
      const i = q[h];
      if (test(i % W, (i / W) | 0, i)) { goal = i; break; }
      const x = i % W, y = (i / W) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 1 || ny < 1 || nx >= W - 1 || ny >= H - 1) continue;
        const j = ny * W + nx;
        if (seen[j]) continue;
        if (lv.propBlock[j] || lv.wall[j] === 1) continue;
        if (lv.wall[j] === 2) {
          const k = lv.doorKind[j];
          if (k && !g.player.keys[k - 1]) continue;
        }
        seen[j] = 1; prev[j] = i; q.push(j);
      }
    }
    if (goal < 0) return null;
    const out = [];
    for (let i = goal; i >= 0; i = prev[i]) out.push([(i % W) + 0.5, ((i / W) | 0) + 0.5]);
    return out.reverse();
  };

  const results = [];
  g.newGame(difficulty);
  g.setState('play');

  for (let L = 0; L < g.totalLevels; L++) {
    if (g.levelIndex !== L) { g.loadLevel(L); }
    g.setState('play');
    const lv = g.level;
    const startHealth = g.player.health;
    const startScore = g.player.score;
    const citiesBefore = g.sky.livingCities().length;
    let route = null, routeI = 0, replan = 0, stuck = 0;
    let lastPos = [g.player.x, g.player.y];
    let died = false, finished = false, cause = '';
    g.dmgLedger = {};
    let t = 0;
    const DT = 1 / 40;                       // coarse but stable for a long soak
    let sieges = 0, shots = 0;
    let spawned = 0, downed = 0, leaked = 0, wasActive = false, onDeckTime = 0;
    // Shots that go nowhere usually mean the target is behind architecture;
    // give up on it for a moment rather than feeding it the whole magazine.
    const misses = new Map();

    while (t < 480 && !finished) {
      t += DT;
      const p = g.player;

      // --- shooting -------------------------------------------------------
      let fired = false;
      // Something swinging a wrench at you outranks anything in the sky.
      let close = null, cd = 1e9;
      for (const e of g.enemies) {
        if (!e.alive || e.state === 7 || e.state === 6) continue;
        const d = Math.hypot(e.x - p.x, e.y - p.y);
        if (d < cd && d < 7 && lv.lineOfSight(p.x, p.y, e.x, e.y)) { cd = d; close = e; }
      }
      // Back off while shooting, the way a person would, instead of walking
      // into a wrench.
      let evade = 0, evadeStrafe = 0;
      if (close && cd < 4.2) { evade = -0.8; evadeStrafe = (Math.floor(t * 0.6) % 2) ? 0.9 : -0.9; }
      // Anything inside boot range gets the boot; it costs nothing and it works.
      if (close && cd < 2.1 && p.kickCooldown <= 0) {
        p.ang = Math.atan2(close.y - p.y, close.x - p.x);
        g.tryKick();
      }
      if (close && g.sky.warheads.length) {
        if (p.owned.nailer && p.ammo.nail > 4) p.weapon = 'nailer';
        p.ang = Math.atan2(close.y - p.y, close.x - p.x);
        p.pitch = ((close.z + close.height * 0.5 - p.z) / Math.max(0.8, cd)) * g.rc.projY;
        p.fuse = Math.max(8, cd + 2);
        if (p.cooldown <= 0) { g.tryFire(); shots++; fired = true; }
      } else if (g.sky.warheads.length) {
        // Splitter costs 3 shells for one fuse: worth it against a flight,
        // wasteful against a single warhead.
        let clustered = 0;
        if (g.sky.warheads.length > 1) {
          const a = g.sky.warheads[0];
          for (const w of g.sky.warheads) {
            if (Math.hypot(w.x - a.x, w.y - a.y, w.z - a.z) < 14) clustered++;
          }
        }
        const wantSplit = p.owned.splitter && clustered >= 3 && p.ammo.flak > 40;
        p.weapon = wantSplit ? 'splitter' : 'pistol';
        let best = null, bestD = 1e9;
        for (const w of g.sky.warheads) {
          const m = misses.get(w.id);
          if (m && m.until > t) continue;
          if (w.z < bestD) { bestD = w.z; best = w; }
        }
        if (!best) {
          for (const w of g.sky.warheads) if (w.z < bestD) { bestD = w.z; best = w; }
        }
        if (best) {
          const spd = p.spec.flakSpeed || 110;
          let tt = Math.hypot(best.x - p.x, best.y - p.y, best.z - p.z) / spd;
          for (let k = 0; k < 4; k++) {
            const px = best.x + best.vx * tt, py = best.y + best.vy * tt, pz = best.z + best.vz * tt;
            tt = Math.hypot(px - p.x, py - p.y, pz - p.z) / spd;
          }
          const lx = best.x + best.vx * tt, ly = best.y + best.vy * tt, lz = best.z + best.vz * tt;
          p.ang = Math.atan2(ly - p.y, lx - p.x);
          const horiz = Math.hypot(lx - p.x, ly - p.y);
          p.pitch = ((lz - p.z) / horiz) * g.rc.projY;
          p.fuse = Math.hypot(lx - p.x, ly - p.y, lz - p.z);
          p.autoFuse = false;
          if (p.cooldown <= 0) {
            g.tryFire(); shots++; fired = true;
            const m = misses.get(best.id) || { n: 0, until: 0 };
            m.n++;
            if (m.n >= 3) { m.until = t + 3; m.n = 0; }
            misses.set(best.id, m);
          }
        }
      } else {
        // Ground threats.
        let target = null, td = 1e9;
        for (const e of g.enemies) {
          if (!e.alive) continue;
          const d = Math.hypot(e.x - p.x, e.y - p.y);
          if (d < td && d < 16 && lv.lineOfSight(p.x, p.y, e.x, e.y)) { td = d; target = e; }
        }
        if (target) {
          if (p.owned.nailer && p.ammo.nail > 6 && td < 20) p.weapon = 'nailer';
          else p.weapon = 'pistol';
          p.ang = Math.atan2(target.y - p.y, target.x - p.x);
          p.pitch = ((target.z + target.height * 0.5 - p.z) / Math.max(0.6, td)) * g.rc.projY;
          p.fuse = Math.max(8, td);
          if (p.cooldown <= 0 && td > 2.2) { g.tryFire(); shots++; fired = true; }
        }
      }

      // --- moving ---------------------------------------------------------
      replan -= DT;
      const needTrigger = [...Array(lv.wall.length).keys()]
        .some((i) => lv.trigger[i] && !g.triggersFired.has(i));
      if (!route || routeI >= route.length || replan <= 0) {
        replan = 1.5;
        const wantExit = !needTrigger && !g.sky.active &&
          (g.levelIndex !== g.totalLevels - 1 || g.bossKilled);
        route = path2(lv, p.x, p.y, (x, y, i) => {
          if (g.sky.active) {
            // During a siege, hold the deck.
            return !!lv.roofPanel[i] && Math.hypot(x + 0.5 - p.x, y + 0.5 - p.y) > 1.5;
          }
          if (wantExit) return !!lv.exit[i];
          if (needTrigger) return !!lv.trigger[i] && !g.triggersFired.has(i);
          return !!lv.exit[i];
        });
        // Detour for a key or weapon that is on the way and still on the floor.
        if (!g.sky.active) {
          for (const it of g.items) {
            if (it.taken || it.prop) continue;
            if (!it.kind.startsWith('key_') && it.kind !== 'weapon' &&
                it.kind !== 'medkit_big' && !(it.kind === 'medkit_small' && p.health < 45)) continue;
            if (it.kind === 'medkit_big' && p.health > 60) continue;
            const r2 = path2(lv, p.x, p.y, (x, y) => Math.hypot(x + 0.5 - it.x, y + 0.5 - it.y) < 0.8);
            if (r2 && r2.length < 60) { route = r2; break; }
          }
        }
        routeI = 1;
      }
      if (route && routeI < route.length) {
        const [wx, wy] = route[routeI];
        const d = Math.hypot(wx - p.x, wy - p.y);
        if (d < 0.45) routeI++;
        else if (!g.sky.warheads.length) {
          p.ang = Math.atan2(wy - p.y, wx - p.x);
          p.pitch *= 0.7;
        }
        IN.fwd = g.sky.warheads.length ? 0.35 : 1;
      } else IN.fwd = 0;
      if (evade) { IN.fwd = evade; IN.strafe = evadeStrafe; } else IN.strafe = 0;

      // Doors and stubborn corners.
      const moved = Math.hypot(p.x - lastPos[0], p.y - lastPos[1]);
      lastPos = [p.x, p.y];
      if (moved < 0.004 && IN.fwd > 0) {
        stuck++;
        if (stuck % 6 === 0) g.tryUse();
        if (stuck > 90) { stuck = 0; replan = 0; p.ang += 1.1; }
      } else stuck = 0;

      g.update(DT, IN);
      IN.endFrame();

      if (g.player.dead || g.state === 'gameover') {
        died = true;
        cause = g.overReason || g.player.lastHurtBy || 'unknown';
        break;
      }
      if (g.state === 'intermission') { finished = true; break; }
      if (g.state === 'victory') { finished = true; break; }
      if (g.sky.active) {
        if (!wasActive) { wasActive = true; sieges++; }
        if (lv.underSky(p.x, p.y)) onDeckTime += DT;
      } else if (wasActive) {
        wasActive = false;
        spawned += g.sky.spawned; downed += g.sky.killed; leaked += g.sky.leaked;
      }
    }

    results.push({
      L, name: lv.name, time: +t.toFixed(0), finished, died, cause,
      damage: Object.fromEntries(Object.entries(g.dmgLedger || {})
        .sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => [k, Math.round(v)])),
      health: Math.round(g.player.health),
      healthLost: Math.round(startHealth - g.player.health),
      score: g.player.score - startScore,
      kills: g.levelKills, enemies: g.enemyTotal,
      secrets: g.player.secretsFound,
      citiesLost: citiesBefore - g.sky.livingCities().length,
      citiesLeft: g.sky.livingCities().length,
      weapons: Object.entries(g.player.owned).filter(([, v]) => v).map(([k]) => k).join('+'),
      shots, sieges,
      spawned: spawned + (wasActive ? g.sky.spawned : 0),
      downed: downed + (wasActive ? g.sky.killed : 0),
      leaked: leaked + (wasActive ? g.sky.leaked : 0),
      onDeck: +onDeckTime.toFixed(0),
      state: g.state,
    });
    if (died || g.state === 'gameover') break;
    if (g.state === 'victory') break;
    if (g.state === 'intermission') { g.loadLevel(g.levelIndex + 1); g.setState('play'); }
  }
  return { difficulty: g.diff.name, results, score: g.player.score, state: g.state };
}, DIFF);

console.log(`\n=== CAMPAIGN: ${report.difficulty} ===`);
console.log('lvl  name            time  end             hp  kills    sieges  sky(down/leak/spawn)  deck  cities  score');
for (const r of report.results) {
  console.log(
    `${String(r.L + 1).padEnd(4)} ${r.name.padEnd(15)} ${String(r.time).padStart(4)}s ` +
    `${(r.died ? `DIED:${r.cause}` : r.finished ? 'cleared' : 'timeout').padEnd(14)} ` +
    `${String(r.health).padStart(3)}  ${String(r.kills + '/' + r.enemies).padEnd(8)} ` +
    `${String(r.sieges).padStart(6)}  ${String(r.downed + '/' + r.leaked + '/' + r.spawned).padStart(20)}  ` +
    `${String(r.onDeck + 's').padStart(4)}  ${String(r.citiesLeft + '/6').padStart(5)}  ${String(r.score).padStart(6)}` +
    `   ${Object.entries(r.damage).map(([k, v]) => `${k} ${v}`).join(', ')}`);
}
console.log(`final: ${report.state}, score ${report.score}`);
if (errs.length) { console.log('\nPAGE ERRORS:'); for (const e of errs.slice(0, 6)) console.log('  ' + e); }
await browser.close();
server.kill('SIGKILL');
process.exit(errs.length ? 1 : 0);
