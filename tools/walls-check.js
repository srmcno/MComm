// walls-check.js - nothing goes through a wall: not a flak shell, not a round,
// not the blast of either. Thousands of shots on every floor, in node, against
// the real collision code.
//   node tools/walls-check.js
import { MAPS, parseLevel } from '../src/game/maps.js';
import { Level } from '../src/game/level.js';
import { TEXTURE_ORDER } from '../src/engine/textures.js';
import { SkyWar } from '../src/game/sky.js';
import { WEAPONS } from '../src/game/weapons.js';
import { CEIL_H } from '../src/core/world.js';

const { Game } = await import('../src/game/game.js');
const art = { texIndex: new Map(TEXTURE_ORDER.map((n, i) => [n, i])), texNames: TEXTURE_ORDER, texAtlas: null };
let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
}
const rngOf = (seed) => { let s = seed; return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff); };
// a full-height wall (or a shut door) at this point, at this height
const wallAt = (lv, x, y, z) => {
  if (x < 0 || y < 0 || x >= lv.W || y >= lv.H) return false;
  const i = lv.idx(x, y);
  if (lv.wall[i] === 1) return !lv.parapet[i] && z < lv.wallHeight(i);
  if (lv.wall[i] === 2) return z < CEIL_H && lv.blocked(x, y);
  return false;
};

// ------------------------------------------------------------------ flak
{
  const specs = Object.values(WEAPONS).filter((w) => w.kind === 'flak' || w.kind === 'ring');
  let shots = 0, duds = 0, leaks = [];
  for (let li = 0; li < MAPS.length; li++) {
    const lv = new Level(parseLevel(li), art);
    if (li % 2 === 0) { lv.roofTarget = 1; for (let k = 0; k < 400; k++) lv.updateRoof(0.05); }
    let dud = null;
    const game = { level: lv, props: null, enemies: [], player: { x: 0, y: 0, z: 0.5 },
      onFlakDud(f, k) { dud = k; }, onFlakBurst() {}, onBlastSweep() {}, onBlastHurtPlayer() {}, onWarheadKilled() {} };
    const sky = new SkyWar(game);
    const rnd = rngOf(12345 + li);
    for (let n = 0; n < 2000; n++) {
      let x, y;
      do { x = 1 + rnd() * (lv.W - 2); y = 1 + rnd() * (lv.H - 2); } while (lv.blocked(x, y) || lv.wall[lv.idx(x, y)]);
      const a = rnd() * Math.PI * 2, pitch = (rnd() - 0.35) * 0.9, z = 0.48;
      const spec = specs[n % specs.length];
      const f = sky.fireFlak(x, y, z, Math.cos(a) * Math.cos(pitch), Math.sin(a) * Math.cos(pitch), Math.sin(pitch), spec, 60);
      dud = null;
      for (let k = 0; k < 2000 && sky.flak.includes(f); k++) sky._updateFlak(1 / 60, game);
      sky.blasts.length = 0;
      shots++;
      if (dud) duds++;
      // the straight path from the muzzle to where it ended: through nothing solid
      const L = Math.hypot(f.x - x, f.y - y, f.z - z), m = Math.ceil(L / 0.01);
      let inside = 0;
      for (let k = 1; k <= m; k++) {
        const t = k / m, px = x + (f.x - x) * t, py = y + (f.y - y) * t, pz = z + (f.z - z) * t;
        const pz0 = z + (f.z - z) * ((k - 1) / m);
        if (pz > 1.6) break;
        if (wallAt(lv, px, py, pz)) inside += L / m;
        if (lv.hitsCeiling(px, py, pz0, pz) && !lv.wall[lv.idx(px, py)]) inside += 1;
      }
      if (inside > 0.12) leaks.push(`L${li} from ${x.toFixed(1)},${y.toFixed(1)} to ${f.x.toFixed(1)},${f.y.toFixed(1)},${f.z.toFixed(1)}`);
    }
  }
  check(`no flak shell goes through a wall, a door or a ceiling (${shots} shots, every floor)`, leaks.length === 0, leaks.slice(0, 3).join('; '));
  check('one that hits inside its arming distance is a dud where it hit, not a burst next door', duds > shots * 0.2, `${duds} duds`);
}

// ------------------------------------------------------------------ rounds
{
  let shots = 0; const leaks = [];
  for (let li = 0; li < MAPS.length; li++) {
    const lv = new Level(parseLevel(li), art);
    const fake = { level: lv, enemies: [], items: [], props: { lampAt: () => null, at: () => null, hit() {} } };
    const rnd = rngOf(777 + li);
    for (let n = 0; n < 4000; n++) {
      let x, y;
      do { x = 1 + rnd() * (lv.W - 2); y = 1 + rnd() * (lv.H - 2); } while (lv.blocked(x, y) || lv.wall[lv.idx(x, y)]);
      // straight at a cell corner a few cells off: the worst case for a stepped trace
      const tx = Math.floor(x) + Math.round((rnd() - 0.5) * 12), ty = Math.floor(y) + Math.round((rnd() - 0.5) * 12);
      let dx = tx - x, dy = ty - y; const L0 = Math.hypot(dx, dy) || 1; dx /= L0; dy /= L0;
      const dz = (rnd() - 0.5) * 0.1, L = Math.hypot(dx, dy, dz);
      const hit = Game.prototype.traceHit.call(fake, x, y, 0.5, dx / L, dy / L, dz / L, 30, 0);
      shots++;
      const D = Math.hypot(hit.x - x, hit.y - y), m = Math.ceil(D / 0.002);
      let inside = 0;
      for (let k = 1; k <= m; k++) {
        const t = k / m, px = x + (hit.x - x) * t, py = y + (hit.y - y) * t, pz = 0.5 + (hit.z - 0.5) * t;
        if (lv.blockedShot(px, py, pz) && lv.wall[lv.idx(px, py)]) inside += D / m;
      }
      if (inside > 0.003) leaks.push(`L${li} from ${x.toFixed(2)},${y.toFixed(2)}`);
    }
  }
  check(`no round slips through a wall, or between two that only meet at a corner (${shots} shots)`, leaks.length === 0, leaks.slice(0, 3).join('; '));
}

// ------------------------------------------------------------------ blasts
{
  // a blast against one side of a wall, a body against the other side
  const lv = new Level(parseLevel(0), art);
  let found = null;
  for (let y = 1; y < lv.H - 1 && !found; y++) {
    for (let x = 1; x < lv.W - 1 && !found; x++) {
      const i = lv.idx(x, y);
      if (lv.wall[i] !== 1 || lv.parapet[i]) continue;
      if (!lv.wall[i - 1] && !lv.wall[i + 1] && !lv.propBlock[i - 1] && !lv.propBlock[i + 1]) found = { x, y };
    }
  }
  const g = Object.create(Game.prototype);
  g.level = lv;
  const a = { x: found.x - 0.3, y: found.y + 0.5 }, b = { x: found.x + 1.3, y: found.y + 0.5 }, c = { x: found.x - 1.6, y: found.y + 0.5 };
  check('a blast does not reach a body on the other side of a wall', !g.blastReaches(a.x, a.y, b.x, b.y), `wall at ${found.x},${found.y}`);
  check('it does reach one in the open at the same distance', g.blastReaches(a.x, a.y, c.x, c.y));
  // up over the roofs: what is out in the open, not what is under a roof
  const roofed = (() => { for (let i = 0; i < lv.W * lv.H; i++) if (!lv.wall[i] && !lv.sky[i]) return i; return -1; })();
  const rx = (roofed % lv.W) + 0.5, ry = Math.floor(roofed / lv.W) + 0.5;
  check('a burst up over the building does not reach down through a roof', !g.blastReaches(rx, ry, rx, ry, CEIL_H + 2));
}

console.log(`\nwalls-check - flak, rounds and blasts against walls, doors and ceilings\n`);
console.log(`${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
