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
        const t0 = (k - 1) / m, px0 = x + (f.x - x) * t0, py0 = y + (f.y - y) * t0, pz0 = z + (f.z - z) * t0;
        if (pz > 1.6) break;
        if (wallAt(lv, px, py, pz)) inside += L / m;
        if (lv.hitsCeiling(px0, py0, pz0, px, py, pz)) inside += 1;
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

  // two walls that meet only at a corner seal it: no blast through the gap
  let corners = 0, leaks = [];
  for (let li = 0; li < MAPS.length; li++) {
    const L = new Level(parseLevel(li), art);
    const gl = Object.create(Game.prototype); gl.level = L;
    const op = (x, y) => L.opaque(x + 0.5, y + 0.5);
    for (let y = 1; y < L.H - 2; y++) for (let x = 1; x < L.W - 2; x++) {
      // opaque at (x, y) and (x+1, y+1), open at (x+1, y) and (x, y+1), or the mirror
      for (const [a, b, c, d] of [[[x, y], [x + 1, y + 1], [x + 1, y], [x, y + 1]], [[x + 1, y], [x, y + 1], [x, y], [x + 1, y + 1]]]) {
        if (!op(...a) || !op(...b) || op(...c) || op(...d)) continue;
        corners++;
        // from deep in one open cell, through the shared corner, to deep in the other
        const cx = Math.max(c[0], d[0]), cy = Math.max(c[1], d[1]);
        const sx = c[0] + 0.5 + (c[0] + 0.5 - cx) * 0.6, sy = c[1] + 0.5 + (c[1] + 0.5 - cy) * 0.6;
        const tx = d[0] + 0.5 + (d[0] + 0.5 - cx) * 0.6, ty = d[1] + 0.5 + (d[1] + 0.5 - cy) * 0.6;
        if (gl.blastReaches(sx, sy, tx, ty)) leaks.push(`L${li} ${x},${y}`);
      }
    }
  }
  check(`a blast does not get through where two walls meet at a corner (${corners} such corners)`, corners > 0 && leaks.length === 0, leaks.slice(0, 4).join(', '));

  // exactly down the diagonal through each such corner, both ways: a round, a
  // flak shell and a Halo ring each stop on their own side of it
  const specs = Object.values(WEAPONS).filter((w) => w.kind === 'flak' || w.kind === 'ring');
  let paths = 0; const slips = [];
  for (let li = 0; li < MAPS.length; li++) {
    const L = new Level(parseLevel(li), art);
    const gl = Object.create(Game.prototype); gl.level = L;
    const fake = { level: L, enemies: [], items: [], props: { lampAt: () => null, at: () => null, hit() {} } };
    const game = { level: L, props: null, enemies: [], player: { x: 0, y: 0, z: 0.5 },
      onFlakDud() {}, onFlakBurst() {}, onBlastSweep() {}, onBlastHurtPlayer() {}, onWarheadKilled() {} };
    const sky = new SkyWar(game);
    const op = (x, y) => L.opaque(x + 0.5, y + 0.5);
    for (let y = 1; y < L.H - 2; y++) for (let x = 1; x < L.W - 2; x++) {
      for (const [a, b, c, d] of [[[x, y], [x + 1, y + 1], [x + 1, y], [x, y + 1]], [[x + 1, y], [x, y + 1], [x, y], [x + 1, y + 1]]]) {
        if (!op(...a) || !op(...b) || op(...c) || op(...d)) continue;
        const cx = Math.max(c[0], d[0]), cy = Math.max(c[1], d[1]);
        const P = (e) => [e[0] + 0.5 + (e[0] + 0.5 - cx) * 0.6, e[1] + 0.5 + (e[1] + 0.5 - cy) * 0.6];
        for (const [s0, s1] of [[P(c), P(d)], [P(d), P(c)]]) {
          paths++;
          const D = Math.hypot(s1[0] - s0[0], s1[1] - s0[1]), ux = (s1[0] - s0[0]) / D, uy = (s1[1] - s0[1]) / D;
          const past = (px, py) => Math.hypot(px - s0[0], py - s0[1]) > D / 2 + 0.02;   // beyond the corner
          const where = `L${li} ${s0[0].toFixed(1)},${s0[1].toFixed(1)}`;
          const hit = Game.prototype.traceHit.call(fake, s0[0], s0[1], 0.5, ux, uy, 0, D + 2, 0);
          if (!hit.wall || past(hit.x, hit.y)) slips.push(`round ${where}`);
          const f = sky.fireFlak(s0[0], s0[1], 0.48, ux, uy, 0, specs[paths % specs.length], 60);
          for (let k = 0; k < 600 && sky.flak.includes(f); k++) sky._updateFlak(1 / 60, game);
          sky.blasts.length = 0;
          if (past(f.x, f.y)) slips.push(`flak ${where}`);
          const r = gl.ringClip(s0[0], s0[1], 0.5, s1[0], s1[1], 0.5);
          if (!r || past(r.x, r.y)) slips.push(`ring ${where}`);
        }
      }
    }
  }
  check(`a round, a shell and a Halo ring each stop at such a corner, straight down its diagonal (${paths} paths)`, paths > 0 && slips.length === 0, slips.slice(0, 4).join(', '));

  // a parapet, with the roof open: a blast below its top does not get over it,
  // one above it does
  {
    const P = new Level(parseLevel(0), art);
    P.roofTarget = 1; for (let k = 0; k < 400; k++) P.updateRoof(0.05);
    const gp = Object.create(Game.prototype); gp.level = P;
    let at = null;
    for (let y = 1; y < P.H - 1 && !at; y++) for (let x = 1; x < P.W - 1 && !at; x++) {
      const i = P.idx(x, y);
      if (P.parapet[i] && P.wall[i] === 1 && !P.wall[i - 1] && !P.wall[i + 1] && !P.propBlock[i - 1] && !P.propBlock[i + 1]) at = { x, y, h: P.wallHeight(i) };
    }
    const low = at && gp.blastReaches(at.x - 0.2, at.y + 0.5, at.x + 1.2, at.y + 0.5, at.h * 0.45);
    const high = at && gp.blastReaches(at.x - 0.2, at.y + 0.5, at.x + 1.2, at.y + 0.5, at.h + 0.15);
    check('a blast below a parapet\'s top does not get over it; one above it does', !!at && !low && high,
      at ? `parapet at ${at.x},${at.y}, ${at.h.toFixed(2)} high: low ${low}, high ${high}` : 'no parapet found');
  }

  // a half-open door stops a blast where its slab still is, and not where it has gone
  {
    const D = new Level(parseLevel(0), art);
    const gd = Object.create(Game.prototype); gd.level = D;
    let door = null;
    for (let y = 1; y < D.H - 1 && !door; y++) for (let x = 1; x < D.W - 1 && !door; x++) {
      const i = D.idx(x, y);
      if (D.wall[i] !== 2) continue;
      const vert = D.doorVert[i] === 1;
      const a = vert ? i - 1 : i - D.W, b = vert ? i + 1 : i + D.W;
      if (!D.wall[a] && !D.wall[b] && !D.propBlock[a] && !D.propBlock[b]) door = { x, y, i, vert };
    }
    const through = (open, f) => {
      D.doorOpen[door.i] = open;
      // across the door, crossing its slab's plane at f along the way it slides
      return door.vert
        ? gd.blastReaches(door.x - 0.6, door.y + f, door.x + 1.6, door.y + f)
        : gd.blastReaches(door.x + f, door.y - 0.6, door.x + f, door.y + 1.6);
    };
    const r = door && [through(0.7, 0.35), through(0.7, 0.85), through(0.4, 0.2), through(0.4, 0.7), through(0, 0.5), through(1, 0.5)];
    check('a half-open door stops a blast where the slab is and lets it through the gap', !!door && r[0] && !r[1] && r[2] && !r[3] && !r[4] && r[5],
      door ? `door at ${door.x},${door.y}: 70% open ${r[0]}/${r[1]}, 40% open ${r[2]}/${r[3]}, shut ${r[4]}, open ${r[5]}` : 'no door found');
  }

  // a column stops a blast that goes through it, and not one that goes past it
  {
    let col = null, gc = null;
    for (let li = 0; li < MAPS.length && !col; li++) {
      const parsed = parseLevel(li);
      const C = new Level(parsed, art);
      // the game stands its columns up as it loads a floor
      for (const e of parsed.ents) if (e.kind === 'pillar') { const i = C.idx(e.x, e.y); C.propBlock[i] = 1; C.propH[i] = 0; }
      for (let y = 1; y < C.H - 1 && !col; y++) for (let x = 2; x < C.W - 2 && !col; x++) {
        const i = C.idx(x, y);
        if (!C.propBlock[i] || C.propH[i]) continue;
        if ([i - 1, i + 1, i - 2, i + 2].some((j) => C.wall[j] || C.propBlock[j])) continue;
        col = { li, x, y }; gc = Object.create(Game.prototype); gc.level = C;
      }
    }
    const thru = col && gc.blastReaches(col.x - 0.7, col.y + 0.5, col.x + 1.7, col.y + 0.5, 0.5);
    const past = col && gc.blastReaches(col.x - 0.7, col.y + 0.9, col.x + 1.7, col.y + 0.9, 0.5);
    const from = col && gc.blastReaches(col.x + 0.1, col.y + 0.5, col.x + 1.7, col.y + 0.5, 0.5);
    check('a column stops a blast straight through it, not one that passes it, even from inside its cell', !!col && !thru && past && !from,
      col ? `L${col.li} column at ${col.x},${col.y}: through ${thru}, past ${past}, from behind it ${from}` : 'no column found');
  }

  // a ring burst that splashes on top of a roof is up on the roof, not in the room under it
  const top = g.ringClip(rx, ry, CEIL_H + 0.01, rx + 0.05, ry, CEIL_H - 0.6);
  check('a ring burst that lands on a roof does not reach the room under it', !!top && top.z >= CEIL_H && !g.blastReaches(top.x, top.y, rx, ry, top.z),
    top ? `burst at z ${top.z.toFixed(2)}` : 'not clipped');
}

// ------------------------------------------------------------------ bolts and acid
{
  const { Bolt, Acid } = await import('../src/game/entities.js');
  const lv = new Level(parseLevel(0), art);
  let room = -1;
  for (let i = 0; i < lv.W * lv.H && room < 0; i++) if (!lv.wall[i] && !lv.sky[i] && !lv.propBlock[i]) room = i;
  const rx = (room % lv.W) + 0.5, ry = Math.floor(room / lv.W) + 0.5;
  let hit = null;
  const game = { level: lv, player: { x: -50, y: -50, z: 0.5 }, onBoltImpact(b) { hit = { x: b.x, y: b.y, z: b.z }; }, onAcidSplash(a) { hit = { x: a.x, y: a.y, z: a.z }; }, onPlayerHurt() {} };
  const fly = (P, n = 400) => { hit = null; for (let k = 0; k < n && P.alive; k++) P.update(1 / 60, game); return hit; };
  // straight up into a roofed ceiling, a step that ends above the roof
  const b = fly(new Bolt(rx, ry, CEIL_H - 0.1, 0, 0, 1, 12, 1, null));
  const a = fly(new Acid(rx, ry, CEIL_H - 0.3, 0, 0, 1, 12, 1, null));
  check('a bolt or an acid glob that hits a ceiling splashes under it, not on the roof', !!b && !!a && b.z < CEIL_H && a.z < CEIL_H,
    `bolt at z ${b && b.z.toFixed(2)}, acid at z ${a && a.z.toFixed(2)}`);
  // into a wall: the sparks land on its face, not inside it
  let wall = null;
  for (let y = 1; y < lv.H - 1 && !wall; y++) for (let x = 3; x < lv.W - 1 && !wall; x++) {
    const i = lv.idx(x, y);
    if (lv.wall[i] === 1 && lv.wallHeight(i) >= CEIL_H - 0.01 && !lv.wall[i - 1] && !lv.wall[i - 2] && !lv.propBlock[i - 1] && !lv.propBlock[i - 2]) wall = { x, y };
  }
  const w = wall && fly(new Bolt(wall.x - 1.5, wall.y + 0.5, 0.5, 1, 0, 0, 14, 1, null));
  check('a bolt that hits a wall sparks on its face, not inside it', !!w && !lv.blockedShot(w.x, w.y, w.z) && wall.x - w.x < 0.03,
    w ? `${(wall.x - w.x).toFixed(3)} short of the face at ${wall.x}` : 'no wall found');
}

console.log(`\nwalls-check - flak, rounds and blasts against walls, doors and ceilings\n`);
console.log(`${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
