// props-check.js - the furniture: every model draws, from every side and in
// every state, in reasonable time; every floor's furniture faces the right
// way and never cuts a route; the walls that can come down cannot open a way
// round a locked door.
//   node tools/props-check.js
import { PropStudio, DIRS, viewDir } from '../src/engine/propstudio.js';
import { MeshBank } from '../src/engine/propmesh.js';
import { MODELS, PIECES } from '../src/engine/propmodels.js';
import { MAPS, DECOR, parseLevel } from '../src/game/maps.js';
import { PROP_DEFS, Props } from '../src/game/props.js';
import { Level, COLUMN_R } from '../src/game/level.js';
import { WallDamage } from '../src/game/walldamage.js';
import { TEXTURE_ORDER } from '../src/engine/textures.js';

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
}

// ------------------------------------------------------------------ models
const studio = new PropStudio(MODELS, PIECES);
const bad = [], slow = [];
let frames = 0;
const t0 = performance.now();
for (const [kind, def] of Object.entries(MODELS)) {
  const nv = def.variants || 1;
  for (const state of ['ok', 'hurt', 'wreck']) {
    for (let v = 0; v < nv; v++) {
      for (let d = 0; d < (def.dirs || DIRS); d++) {
        if (state !== 'ok' && d % 2) continue;
        const f = studio.frame(kind, d, state, v);
        frames++;
        if (!f || !f.w || !f.h || f.w > 420 || f.h > 420 || !(f.below >= 0) || !(f.ppu > 0)) { bad.push(`${kind}/${state}/${v}/${d}`); continue; }
        let opaque = 0;
        for (let i = 0; i < f.data.length; i++) if ((f.data[i] >>> 24) === 255) opaque++;
        if (opaque < 60) bad.push(`${kind}/${state}/${v}/${d} empty`);
      }
    }
  }
  // falling over, and flat
  for (const pose of [2, 4]) { const f = studio.frame(kind, 1, 'ok', 0, pose); frames++; if (!f) bad.push(`${kind} pose ${pose}`); }
}
for (const [piece, def] of Object.entries(PIECES)) {
  for (let v = 0; v < (def.variants || 1); v++) for (let d = 0; d < (def.dirs || DIRS); d++) {
    const f = studio.frame(piece, d, 'ok', v, 0, true); frames++;
    if (!f) bad.push(`piece ${piece}/${v}/${d}`);
  }
}
const per = (performance.now() - t0) / frames;
check(`every model and piece draws from every side, whole, battered, wrecked and falling (${frames} frames)`, bad.length === 0, bad.slice(0, 6).join(', '));
check('a frame is cheap enough to make between game frames (under 12 ms on average)', per < 12, `${per.toFixed(1)} ms`);
check('the same model draws the same picture twice',
  (() => { const a = new PropStudio(MODELS, PIECES).frame('desk', 3), b = new PropStudio(MODELS, PIECES).frame('desk', 3); return a.data.join() === b.data.join(); })());
check('every prop the game can break is modelled or keeps its painted sprite',
  Object.keys(DECOR).every((k) => MODELS[k] || ['skeleton', 'chains', 'hook', 'corpse', 'corpse2'].includes(k)),
  Object.keys(DECOR).filter((k) => !MODELS[k]).join(','));
check('every kind the maps place has rules in props.js', Object.keys(DECOR).every((k) => PROP_DEFS[k] || k === 'candles'),
  Object.keys(DECOR).filter((k) => !PROP_DEFS[k] && k !== 'candles').join(','));
check('every piece a broken prop throws exists', Object.values(PROP_DEFS).every((d) => !d.debris || d.debris.every(([p]) => PIECES[p])));
check('viewDir: in front is 0, off its right side is 2, behind is 4',
  viewDir(0, 0, 0, 3, 0) === 0 && viewDir(0, 0, 0, 0, -3) === 2 && viewDir(0, 0, 0, -3, 0) === 4 && viewDir(0, 0, Math.PI / 2, 0, 3) === 0);

// ------------------------------------------------------------------ solid models
// The furniture is drawn as real 3D geometry now (propmesh.js, meshdraw.js);
// the studio's pictures above are only its fallback.
{
  const bank = new MeshBank(MODELS, PIECES);
  const badM = [];
  let n = 0, worst = 0, worstK = '', tris = 0;
  const t0 = performance.now();
  for (const [kind, def] of Object.entries(MODELS)) {
    for (const state of ['ok', 'hurt', 'wreck']) {
      for (let v = 0; v < (def.variants || 1); v++) {
        const a = performance.now();
        const m = bank.make(kind, state, v);
        const dt = performance.now() - a;
        n++;
        if (dt > worst) { worst = dt; worstK = `${kind}/${state}`; }
        if (!m || !m.ready || !(m.tri.length >= 36) || m.patches.some((p) => !p.tex || !p.tex.length) || !(m.top > 0.05)) { badM.push(`${kind}/${state}/${v}`); continue; }
        if (state === 'ok') tris = Math.max(tris, m.tri.length / 3);
        // every texel written, and nothing floating under the floor
        if (m.patches.some((p) => p.tex.some((c) => (c >>> 24) !== 255))) badM.push(`${kind}/${state}/${v} holes`);
        if (m.minY < -0.02) badM.push(`${kind}/${state}/${v} below the floor ${m.minY.toFixed(3)}`);
      }
    }
  }
  for (const [piece, def] of Object.entries(PIECES)) for (let v = 0; v < (def.variants || 1); v++) {
    const m = bank.make(piece, 'ok', v, true); n++;
    if (!m || !m.ready || !(m.tri.length >= 12)) badM.push(`piece ${piece}/${v}`);
  }
  const per = (performance.now() - t0) / n;
  check(`every model bakes into a solid 3D mesh, whole, battered and wrecked, and every piece too (${n} meshes)`, badM.length === 0, badM.slice(0, 6).join(', '));
  check('a mesh bakes quickly enough to do while the briefing is up (under 60 ms on average, 250 ms worst)', per < 60 && worst < 250, `${per.toFixed(0)} ms average, worst ${worst.toFixed(0)} ms (${worstK})`);
  check('no standing model is heavier than 4000 triangles', tris <= 4000, `${tris}`);
  // a column is what rounds hit: every one fits inside that circle
  const fat = [];
  for (const kind of Object.keys(MODELS).filter((k) => k === 'pillar' || k.startsWith('pillar_'))) {
    const m = bank.make(kind, 'ok', 0);
    let r = 0;
    for (let i = 0; i < m.vx.length; i++) r = Math.max(r, Math.hypot(m.vx[i], m.vz[i]));
    fat.push([kind, r]);
  }
  const over = fat.filter(([, r]) => r > COLUMN_R + 0.004);
  check(`every column model fits inside the circle rounds collide with (${COLUMN_R})`, fat.length >= 5 && over.length === 0,
    (over.length ? over : fat).map(([k, r]) => `${k} ${r.toFixed(3)}`).join(', '));
}

// ------------------------------------------------------------------ placement
const art = { texIndex: new Map(TEXTURE_ORDER.map((n, i) => [n, i])), texNames: TEXTURE_ORDER, texAtlas: null };
const facingBad = [], chairBad = [], routeBad = [], yawBad = [];
let total = 0;
for (let li = 0; li < MAPS.length; li++) {
  const P = parseLevel(li);
  const lv = new Level(P, art);
  const W = lv.W, H = lv.H;
  total += lv.decor.length;
  for (const d of lv.decor) {
    if (!Number.isFinite(d.yaw) || !Number.isInteger(d.variant)) yawBad.push(`${li}:${d.kind}`);
    if (d.wall) {
      // its front is toward the room and its back to a wall
      const fx = Math.floor(d.x + Math.cos(d.yaw) * 0.7), fy = Math.floor(d.y + Math.sin(d.yaw) * 0.7);
      const bx = Math.floor(d.x - Math.cos(d.yaw) * 0.7), by = Math.floor(d.y - Math.sin(d.yaw) * 0.7);
      if (lv.wall[fy * W + fx] === 1 || !lv.wall[by * W + bx]) facingBad.push(`${li}:${d.kind}@${d.x.toFixed(1)},${d.y.toFixed(1)}`);
    }
  }
  // a chair by a desk faces the desk
  for (const c of lv.decor) {
    if (c.kind !== 'chair') continue;
    const desk = lv.decor.find((d) => (d.kind === 'desk' || d.kind === 'console') && Math.hypot(d.x - c.x, d.y - c.y) < 0.7);
    if (!desk) continue;
    const want = Math.atan2(desk.y - c.y, desk.x - c.x);
    let da = Math.abs(((c.yaw - want) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI);
    if (da > 0.7) chairBad.push(`${li}@${c.x.toFixed(1)},${c.y.toFixed(1)}`);
  }
  // everything you could reach without the furniture, you can reach with it
  const reach = (useProps) => {
    const seen = new Uint8Array(W * H);
    const s = lv.idx(P.start.x, P.start.y);
    const st = [s]; seen[s] = 1; let n = 1;
    while (st.length) {
      const i = st.pop(), x = i % W, y = (i / W) | 0;
      for (const j of [i - 1, i + 1, i - W, i + W]) {
        if (j < 0 || j >= W * H || seen[j]) continue;
        const jx = j % W; if (Math.abs(jx - x) > 1) continue;
        if (lv.wall[j] === 1 && !lv.secret[j]) continue;
        if (useProps && lv.propBlock[j]) continue;
        seen[j] = 1; n++; st.push(j);
      }
    }
    return { seen, n };
  };
  const a = reach(false), b = reach(true);
  // cells that are blocked by props themselves do not count
  let lost = 0;
  for (let i = 0; i < W * H; i++) if (a.seen[i] && !b.seen[i] && !lv.propBlock[i]) lost++;
  if (lost) routeBad.push(`level ${li}: ${lost} cells cut off`);
}
check(`every prop has a facing and a dressing (${total} props on ${MAPS.length} floors)`, yawBad.length === 0, yawBad.slice(0, 5).join(', '));
check('everything that stands against a wall has its back to it and its front to the room', facingBad.length === 0, facingBad.slice(0, 5).join(', '));
check('a chair pulled out from a desk is turned to the desk', chairBad.length === 0, chairBad.slice(0, 5).join(', '));
check('no furniture cuts a route anywhere', routeBad.length === 0, routeBad.join('; '));

// ------------------------------------------------------------------ walls
const wallBad = [];
let breakable = 0, withAny = 0;
for (let li = 0; li < MAPS.length; li++) {
  const P = parseLevel(li);
  const lv = new Level(P, art);
  const game = { art, level: lv };
  const wd = new WallDamage(game);
  wd.load(lv);
  breakable += wd.hp.size;
  if (wd.hp.size) withAny++;
  // bring every breakable wall down and check the set of rooms reachable
  // without keys does not grow
  const W = lv.W, H = lv.H;
  const region = (wall) => {
    const seen = new Uint8Array(W * H);
    const s = lv.idx(P.start.x, P.start.y);
    const st = [s]; seen[s] = 1; let n = 1;
    while (st.length) {
      const i = st.pop(), x = i % W;
      for (const j of [i - 1, i + 1, i - W, i + W]) {
        if (j < 0 || j >= W * H || seen[j] || Math.abs((j % W) - x) > 1) continue;
        if (wall[j] === 1 || lv.doorKind[j] || lv.secret[j]) continue;
        seen[j] = 1; n++; st.push(j);
      }
    }
    return n;
  };
  const before = region(lv.wall);
  const opened = lv.wall.slice();
  for (const i of wd.hp.keys()) opened[i] = 0;
  const after = region(opened);
  if (after - before > wd.hp.size) wallBad.push(`level ${li}: ${after - before} new cells reachable`);
}
check(`walls that can come down exist on most floors (${breakable} on ${withAny} of ${MAPS.length})`, withAny >= 3);
check('bringing down every breakable wall opens nothing a key or a secret was guarding', wallBad.length === 0, wallBad.join('; '));

// ------------------------------------------------------------------ out of the walls
// A model that reaches into a wall is cut off by it, and from the right angle
// looks like the next room's furniture coming through. None stands in one,
// and none ends up in one after a boot, a blast or a fall.
{
  const noop = new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => 0 : noop), apply: () => noop });
  const art2 = { ...art, meshes: new MeshBank(MODELS, PIECES), props: new PropStudio(MODELS, PIECES), sprites: {} };
  const depthIn = (lv, props, d) => {
    const f = props._foot(d);
    if (!f) return 0;
    const fX = Math.cos(d.yaw), fY = Math.sin(d.yaw), rX = fY, rY = -fX;
    const tilt = d.fall ? d.fall.ang : 0, roll = d.flying ? d.roll || 0 : 0, front = props._frontOf(d);
    const ct = Math.cos(tilt), st = Math.sin(tilt), cr = Math.cos(roll), sr = Math.sin(roll);
    let w = 0;
    for (let a = 0; a <= 8; a++) for (let b = 0; b <= 4; b++) for (let c = 0; c <= 8; c++) {
      let y = f.top * b / 4, z = f.minZ + (f.maxZ - f.minZ) * c / 8;
      const x = f.minX + (f.maxX - f.minX) * a / 8;
      if (tilt) { const zz = z - front; const y1 = y * ct - zz * st; z = y * st + zz * ct + front; y = y1; }
      if (roll) { const yy = y - f.cy; const y1 = yy * cr - z * sr; z = yy * sr + z * cr; y = y1 + f.cy; }
      const wx = d.x + x * rX + z * fX, wy = d.y + x * rY + z * fY;
      const cx = Math.floor(wx), cy = Math.floor(wy);
      if (cx < 0 || cy < 0 || cx >= lv.W || cy >= lv.H) { w = 1; continue; }
      if (lv.wall[cy * lv.W + cx] !== 1) continue;
      const fx = wx - cx, fy = wy - cy;
      const open = (i, j) => lv.wall[(cy + j) * lv.W + cx + i] !== 1;
      let dd = 1;
      if (open(-1, 0)) dd = Math.min(dd, fx);
      if (open(1, 0)) dd = Math.min(dd, 1 - fx);
      if (open(0, -1)) dd = Math.min(dd, fy);
      if (open(0, 1)) dd = Math.min(dd, 1 - fy);
      w = Math.max(w, dd);
    }
    return w;
  };
  const standing = [], after = [];
  let n = 0;
  for (let li = 0; li < MAPS.length; li++) {
    const lv = new Level(parseLevel(li), art2);
    let t = 0;
    const base = { level: lv, art: art2, enemies: [], items: [], player: { x: -50, y: -50, z: 0.5, dead: false, hurt() {} }, get time() { return t; }, shake: 0 };
    const game = new Proxy(base, { get: (o, k) => (k in o ? o[k] : noop), set: (o, k, v) => { o[k] = v; return true; } });
    const props = new Props(game);
    props.load(lv);
    for (const d of lv.decor) {
      const p = depthIn(lv, props, d);
      if (p > 0.02) standing.push(`${li}:${d.kind}@${d.x.toFixed(1)},${d.y.toFixed(1)} ${p.toFixed(2)}`);
    }
    let rs = 99 + li;
    const rnd = () => ((rs = (rs * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let round = 0; round < 3; round++) {
      for (const d of lv.decor) {
        if (!d.def || d.def.hp === Infinity || d.gone || d.broken || d.fall) continue;
        const a = rnd() * Math.PI * 2;
        if (d.def.mass === 'light' && !d.solid) props._kickFly(d, Math.cos(a), Math.sin(a));
        else if (d.def.tall) props.topple(d, Math.cos(a), Math.sin(a), 0);
      }
      for (let k = 0; k < 60 * 4; k++) { t += 1 / 60; props.update(1 / 60); }
    }
    for (const d of lv.decor) {
      if (d.gone || d.broken) continue;
      n++;
      const p = depthIn(lv, props, d);
      if (p > 0.03) after.push(`${li}:${d.kind}@${d.x.toFixed(1)},${d.y.toFixed(1)} ${p.toFixed(2)}`);
    }
  }
  check('no furniture model stands with any part of it inside a wall', standing.length === 0, standing.slice(0, 5).join(', '));
  check(`kicked, thrown and toppled three times over, no furniture ends up inside a wall (${n} props)`, after.length === 0, after.slice(0, 5).join(', '));
}

console.log(`\nprops-check - furniture models, placement and breakable walls\n`);
console.log(`${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
