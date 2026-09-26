// preview-sprites.js - build the sprite set, validate it, and dump contact
// sheets so the art can actually be looked at.  node tools/preview-sprites.js
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { buildSprites } from '../src/engine/sprites.js';
import { writeSheet, writePng } from './png.js';

const OUT = process.env.SPRITE_OUT ||
  '/tmp/claude-0/-home-user-MComm/1d9ae501-9927-5c9d-832d-0ee312d588ac/scratchpad';
fs.mkdirSync(OUT, { recursive: true });

const t0 = Date.now();
const built = buildSprites();
const { frames, maim, rig } = built;
const buildMs = Date.now() - t0;

// determinism: a second build must be pixel-identical to the first
const secondBuild = buildSprites();
const second = secondBuild.frames;

// ---------------------------------------------------------------------------
// expected key list
// ---------------------------------------------------------------------------
const ENEMIES = ['wrencher', 'sparker', 'bellows', 'wasp', 'priest'];
const MUTANTS = ['ghoul', 'gorger', 'howler', 'stalker'];
const expected = [];
for (const id of ENEMIES) {
  for (let d = 0; d < 4; d++) for (let f = 0; f < 4; f++) expected.push(`${id}_walk${d}_${f}`);
  expected.push(`${id}_aim`, `${id}_fire`, `${id}_pain`);
  for (let k = 0; k < 4; k++) expected.push(`${id}_die${k}`);
  expected.push(`${id}_dead`);
}
for (let i = 0; i < 4; i++) expected.push(`mutter_idle${i}`);
for (let i = 0; i < 3; i++) expected.push(`mutter_fire${i}`);
expected.push('mutter_pain');
for (let i = 0; i < 6; i++) expected.push(`mutter_die${i}`);
expected.push('mutter_dead');
expected.push('key_red', 'key_blue', 'key_gold', 'medkit_small', 'medkit_big', 'ammo_flak', 'ammo_crate');
for (let i = 0; i < 4; i++) expected.push(`treasure${i}`);
expected.push('barrel', 'barrel_lit', 'pillar', 'lamp');
for (let i = 0; i < 3; i++) expected.push(`flare${i}`);
expected.push('weapon_splitter', 'weapon_nailer', 'weapon_halo', 'weapon_pipebomb', 'weapon_deadman');
expected.push('wh_stick', 'wh_mirv', 'wh_smart', 'wh_screamer', 'wh_buster');
for (let i = 0; i < 4; i++) expected.push(`skymine${i}`);
for (let i = 0; i < 3; i++) expected.push(`blood${i}`);
expected.push('scorch');

// --- the mutant expansion
for (const id of MUTANTS) {
  for (let d = 0; d < 4; d++) for (let f = 0; f < 4; f++) expected.push(`${id}_walk${d}_${f}`);
  expected.push(`${id}_aim`, `${id}_fire`, `${id}_pain`);
  for (let k = 0; k < 4; k++) expected.push(`${id}_die${k}`);
  expected.push(`${id}_dead`);
}
for (let i = 0; i < 4; i++) expected.push(`maw_idle${i}`);
for (let i = 0; i < 3; i++) expected.push(`maw_fire${i}`);
expected.push('maw_pain');
for (let i = 0; i < 6; i++) expected.push(`maw_die${i}`);
expected.push('maw_dead');
for (let i = 0; i < 8; i++) expected.push(`gib${i}`);
for (let i = 0; i < 4; i++) expected.push(`gore_pool${i}`);
for (let i = 0; i < 3; i++) expected.push(`viscera${i}`);
for (let i = 0; i < 3; i++) expected.push(`acid${i}`);

// Walking cast frames are painted at 1.5 pixels per design unit. Death and
// corpse frames of the humanoid rig are wider (the body lies down in them),
// but keep the same height, so the renderer draws them at the same scale.
const SIZES = {
  wrencher: [96, 108], sparker: [96, 108], bellows: [96, 108], priest: [96, 120],
  wasp: [84, 60], mutter: [192, 160],
  ghoul: [84, 99], gorger: [114, 111], howler: [90, 117], stalker: [78, 90], maw: [176, 150],
};
const DIE_W = { wrencher: 156, sparker: 156, bellows: 162, priest: 168, gorger: 174, howler: 162 };
const MAIMABLE = ['wrencher', 'sparker', 'bellows', 'priest', 'gorger', 'howler', 'ghoul', 'stalker'];
const PARTS = ['head', 'arm', 'leg'];
for (const id of MAIMABLE) for (const p of PARTS) for (let r = 0; r < 8; r++) expected.push(`${id}_part_${p}_${r}`);

// exact sizes for the flat prop/gore keys
const EXACT = {};
for (let i = 0; i < 8; i++) EXACT[`gib${i}`] = [22, 22];
for (let i = 0; i < 4; i++) EXACT[`gore_pool${i}`] = [48, 24];
for (let i = 0; i < 3; i++) EXACT[`viscera${i}`] = [28, 20];
for (let i = 0; i < 3; i++) EXACT[`acid${i}`] = [20, 20];
for (const k of ['key_red', 'key_blue', 'key_gold', 'medkit_small', 'medkit_big', 'ammo_flak', 'ammo_crate',
  'treasure0', 'treasure1', 'treasure2', 'treasure3']) EXACT[k] = [32, 32];
for (const k of ['barrel', 'barrel_lit', 'pillar']) EXACT[k] = [40, 64];
EXACT.lamp = [32, 24];
for (const k of ['weapon_splitter', 'weapon_nailer', 'weapon_halo', 'weapon_pipebomb', 'weapon_deadman']) EXACT[k] = [48, 28];
for (const k of ['wh_stick', 'wh_mirv', 'wh_smart', 'wh_screamer', 'wh_buster',
  'skymine0', 'skymine1', 'skymine2', 'skymine3']) EXACT[k] = [48, 56];
for (const k of ['blood0', 'blood1', 'blood2', 'scorch']) EXACT[k] = [48, 24];

// ---------------------------------------------------------------------------
// checks
// ---------------------------------------------------------------------------
const fails = [];
const warn = [];
const check = (cond, msg) => { if (!cond) fails.push(msg); };

// ---------------------------------------------------------------------------
// byte-identity guard: the 170 shipped frames must never move again
// ---------------------------------------------------------------------------
function hash32(u32) {
  let h = 0x811c9dc5 >>> 0;
  const b = new Uint8Array(u32.buffer, u32.byteOffset, u32.byteLength);
  for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
const sig = (f) => `${f.w}x${f.h}:${hash32(f.data).toString(16).padStart(8, '0')}`;

const BASE_PATH = path.join(path.dirname(url.fileURLToPath(import.meta.url)), 'sprite-baseline.json');
{
  const baseline = JSON.parse(fs.readFileSync(BASE_PATH, 'utf8'));
  const keys = Object.keys(baseline);
  let moved = 0;
  for (const k of keys) {
    const f = frames[k];
    if (!f) { fails.push(`BASELINE: shipped frame ${k} has disappeared`); moved++; continue; }
    const now = sig(f);
    if (now !== baseline[k]) { fails.push(`BASELINE: ${k} changed (${baseline[k]} -> ${now})`); moved++; }
  }
  console.log(moved === 0
    ? `baseline  ${keys.length} shipped frames byte-identical`
    : `baseline  ${moved} of ${keys.length} shipped frames MOVED`);
}

{
  const a = Object.keys(frames).sort(), b = Object.keys(second).sort();
  check(a.join() === b.join(), 'non-deterministic: key sets differ between builds');
  let diff = 0;
  for (const k of a) {
    const x = frames[k], y = second[k];
    if (!y || x.w !== y.w || x.h !== y.h) { diff++; continue; }
    for (let i = 0; i < x.data.length; i++) if (x.data[i] !== y.data[i]) { diff++; break; }
  }
  check(diff === 0, `non-deterministic: ${diff} frame(s) differ between two builds`);
}

for (const k of expected) check(frames[k], `missing key: ${k}`);
const extra = Object.keys(frames).filter((k) => !expected.includes(k));
check(extra.length === 0, `unexpected keys: ${extra.join(',')}`);

const cover = {};
for (const [k, f] of Object.entries(frames)) {
  check(f.data instanceof Uint32Array, `${k}: data is not Uint32Array`);
  check(f.data.length === f.w * f.h, `${k}: data length ${f.data.length} != ${f.w}x${f.h}`);
  let opaque = 0, badAlpha = 0, nan = 0;
  for (let i = 0; i < f.data.length; i++) {
    const c = f.data[i];
    if (!Number.isFinite(c)) { nan++; continue; }
    const a = c >>> 24;
    if (a === 255) opaque++;
    else if (a !== 0) badAlpha++;
  }
  check(nan === 0, `${k}: ${nan} non-finite pixels`);
  check(badAlpha === 0, `${k}: ${badAlpha} pixels with alpha not in {0,255}`);
  check(opaque > 0, `${k}: frame is fully transparent`);
  check(opaque < f.data.length, `${k}: frame is fully opaque (no alpha cutout)`);
  const pct = opaque / f.data.length;
  cover[k] = pct;

  if (EXACT[k]) {
    check(f.w === EXACT[k][0] && f.h === EXACT[k][1],
      `${k}: size ${f.w}x${f.h}, expected ${EXACT[k][0]}x${EXACT[k][1]}`);
  }
  const grp = k.split('_')[0];
  if (k.includes('_part_')) {
    check(f.w === f.h, `${k}: part frame ${f.w}x${f.h} is not square`);
    const [, eh] = SIZES[grp];
    check(f.w >= eh * 0.2 && f.w <= eh * 0.62, `${k}: part frame ${f.w}px out of proportion to a ${eh}px enemy`);
  } else if (SIZES[grp]) {
    const [w0, h] = SIZES[grp];
    const w = DIE_W[grp] && /_(die\d|dead)$/.test(k) ? DIE_W[grp] : w0;
    check(f.w === w && f.h === h, `${k}: size ${f.w}x${f.h}, expected ${w}x${h}`);
    check(pct >= 0.03 && pct <= 0.70, `${k}: coverage ${(pct * 100).toFixed(1)}% outside 3-70%`);
  }
  // walking humanoids must have their feet on the floor and not bounce
  if (/_walk\d_\d$/.test(k) && grp !== 'wasp') {
    let bottom = -1;
    for (let y = f.h - 1; y >= 0 && bottom < 0; y--) {
      for (let x = 0; x < f.w; x++) if (f.data[y * f.w + x] >>> 24) { bottom = y; break; }
    }
    check(bottom >= f.h - 2, `${k}: lowest opaque row is ${bottom}, expected >= ${f.h - 2}`);
  }
}

// feet must not jitter vertically across a walk cycle
for (const id of [...ENEMIES, ...MUTANTS]) {
  if (id === 'wasp') continue;
  for (let d = 0; d < 4; d++) {
    const bots = [];
    for (let fi = 0; fi < 4; fi++) {
      const f = frames[`${id}_walk${d}_${fi}`];
      if (!f) continue;
      let bottom = -1;
      for (let y = f.h - 1; y >= 0 && bottom < 0; y--) {
        for (let x = 0; x < f.w; x++) if (f.data[y * f.w + x] >>> 24) { bottom = y; break; }
      }
      bots.push(bottom);
    }
    const spread = Math.max(...bots) - Math.min(...bots);
    check(spread <= 1, `${id} facing ${d}: foot line jitters by ${spread}px across the walk (${bots})`);
  }
}

// silhouette sanity: a sprite should not be one solid blob edge-to-edge
for (const id of [...ENEMIES, ...MUTANTS]) {
  const f = frames[`${id}_walk0_1`];
  if (!f) continue;
  let cols = 0;
  for (let x = 0; x < f.w; x++) {
    for (let y = 0; y < f.h; y++) if (f.data[y * f.w + x] >>> 24) { cols++; break; }
  }
  if (cols > f.w - 2) warn.push(`${id}: silhouette spans the full frame width (${cols}/${f.w})`);
}

// ---------------------------------------------------------------------------
// dismemberment: maim(), rig, and what the gore code is promised
// ---------------------------------------------------------------------------
const MASKS = [1, 2, 4, 8, 16, 3, 6, 24, 25, 31];
const opaqueCount = (f) => { let n = 0; for (let i = 0; i < f.data.length; i++) if (f.data[i] >>> 24) n++; return n; };
const maimTimes = [];
check(typeof maim === 'function', 'buildSprites() returned no maim()');
check(rig && typeof rig === 'object', 'buildSprites() returned no rig');
if (typeof maim === 'function') {
  for (const id of MAIMABLE) {
    const r = rig[id];
    check(r, `rig: no entry for ${id}`);
    if (r) {
      for (const j of ['hip', 'shoulder', 'neck', 'head']) {
        check(Number.isFinite(r[j]) && r[j] > 0 && r[j] < 1, `rig.${id}.${j} = ${r[j]} is not a fraction`);
      }
      check(r.neck >= r.shoulder - 0.05 && r.head >= r.neck - 0.05, `rig.${id}: joints out of order (${JSON.stringify(r)})`);
    }
    const keys = [`${id}_walk0_0`, `${id}_walk1_2`, `${id}_walk2_1`, `${id}_walk3_3`,
      `${id}_aim`, `${id}_fire`, `${id}_pain`, `${id}_die1`, `${id}_die3`, `${id}_dead`];
    for (const key of keys) {
      check(maim(key, 0) === frames[key], `maim(${key}, 0) is not frames[${key}]`);
      for (const m of MASKS) {
        const t0 = process.hrtime.bigint();
        const f = maim(key, m);
        const dt = Number(process.hrtime.bigint() - t0) / 1e6;
        maimTimes.push(dt);
        if (!f) { fails.push(`maim(${key}, ${m}) returned null`); continue; }
        check(f.w === frames[key].w && f.h === frames[key].h, `maim(${key}, ${m}): ${f.w}x${f.h} != ${frames[key].w}x${frames[key].h}`);
        check(f !== frames[key], `maim(${key}, ${m}) returned the unmaimed frame`);
        check(maim(key, m) === f, `maim(${key}, ${m}) is not cached`);
        let badA = 0;
        for (let i = 0; i < f.data.length; i++) { const a = f.data[i] >>> 24; if (a && a !== 255) badA++; }
        check(badA === 0, `maim(${key}, ${m}): ${badA} pixels with fractional alpha`);
        const other = secondBuild.maim(key, m);
        let same = other && other.w === f.w && other.h === f.h;
        if (same) for (let i = 0; i < f.data.length; i++) if (f.data[i] !== other.data[i]) { same = false; break; }
        check(same, `maim(${key}, ${m}) is not deterministic across builds`);
      }
      // taking every limb off must visibly take something off
      if (!/_die0$/.test(key)) {
        check(opaqueCount(maim(key, 30)) < opaqueCount(frames[key]), `maim(${key}, 30) removed nothing`);
      }
    }
    for (const p of PARTS) {
      const a = frames[`${id}_part_${p}_0`], b = frames[`${id}_part_${p}_3`];
      if (a && b) check(a.w === b.w, `${id}_part_${p}: rotations differ in size`);
    }
  }
  for (const key of ['wasp_walk0_0', 'mutter_idle0', 'maw_idle0', 'gib0', 'key_red', 'nope_walk0_0']) {
    check(maim(key, 1) === null, `maim(${key}, 1) should be null`);
  }
  maimTimes.sort((a, b) => a - b);
  const avg = maimTimes.reduce((a, b) => a + b, 0) / maimTimes.length;
  const p90 = maimTimes[Math.floor(maimTimes.length * 0.9)];
  console.log(`maim      ${maimTimes.length} first paints: mean ${avg.toFixed(2)}ms, median ${maimTimes[maimTimes.length >> 1].toFixed(2)}ms, p90 ${p90.toFixed(2)}ms, max ${maimTimes[maimTimes.length - 1].toFixed(2)}ms, ${maim.cached ? maim.cached() : '?'} cached`);
  // the median is the honest number on a shared machine; GC pauses skew the mean
  const med = maimTimes[maimTimes.length >> 1];
  check(med < 3, `maim first paint median ${med.toFixed(2)}ms, budget is about 3ms`);
  if (avg > 3) warn.push(`maim first paint mean ${avg.toFixed(2)}ms (median ${med.toFixed(2)}ms): a busy machine, or a slow recipe`);
}

// ---------------------------------------------------------------------------
// contact sheets
// ---------------------------------------------------------------------------
const pick = (keys) => keys.map((k) => frames[k]).filter(Boolean);

if (typeof maim === 'function') {
  // every maim-capable kind x a spread of masks, on a walk, an attack and a corpse
  const sheet = [];
  for (const id of MAIMABLE) {
    for (const key of [`${id}_walk0_1`, `${id}_walk1_2`, `${id}_fire`, `${id}_die2`, `${id}_dead`]) {
      for (const m of [0, 1, 2, 4, 8, 16, 24, 31]) { const f = maim(key, m); if (f) sheet.push(f); }
    }
  }
  writeSheet(path.join(OUT, 'spr-maim.png'), sheet, { cols: 8, scale: 1, pad: 3 });
  writeSheet(path.join(OUT, 'spr-maim-4x.png'), MAIMABLE.flatMap((id) => [0, 1, 6, 24, 31].map((m) => maim(`${id}_walk0_1`, m))).filter(Boolean),
    { cols: 5, scale: 3, pad: 3 });
  writeSheet(path.join(OUT, 'spr-parts.png'), pick(MAIMABLE.flatMap((id) => PARTS.flatMap((p) => [0, 1, 2, 3, 4, 5, 6, 7].map((r) => `${id}_part_${p}_${r}`)))),
    { cols: 8, scale: 3, pad: 3 });
}

for (const id of [...ENEMIES, ...MUTANTS]) {
  const rows = [];
  for (let d = 0; d < 4; d++) for (let f = 0; f < 4; f++) rows.push(`${id}_walk${d}_${f}`);
  rows.push(`${id}_aim`, `${id}_fire`, `${id}_pain`, `${id}_dead`);
  rows.push(`${id}_die0`, `${id}_die1`, `${id}_die2`, `${id}_die3`);
  writeSheet(path.join(OUT, `spr-${id}.png`), pick(rows), { cols: 4, scale: 3, pad: 3 });
}

writeSheet(path.join(OUT, 'spr-boss.png'), pick([
  'mutter_idle0', 'mutter_idle1', 'mutter_idle2', 'mutter_idle3',
  'mutter_fire0', 'mutter_fire1', 'mutter_fire2', 'mutter_pain',
  'mutter_die0', 'mutter_die1', 'mutter_die2', 'mutter_die3',
  'mutter_die4', 'mutter_die5', 'mutter_dead',
]), { cols: 4, scale: 1, pad: 4 });

writeSheet(path.join(OUT, 'spr-props.png'), pick([
  'key_red', 'key_blue', 'key_gold', 'medkit_small', 'medkit_big', 'ammo_flak',
  'ammo_crate', 'treasure0', 'treasure1', 'treasure2', 'treasure3', 'lamp',
  'flare0', 'flare1', 'flare2', 'weapon_splitter', 'weapon_nailer', 'weapon_halo',
  'weapon_pipebomb', 'weapon_deadman', 'barrel', 'barrel_lit', 'pillar', 'blood0', 'blood1',
  'blood2', 'scorch',
]), { cols: 6, scale: 3, pad: 3 });

writeSheet(path.join(OUT, 'spr-sky.png'), pick([
  'wh_stick', 'wh_mirv', 'wh_smart', 'wh_screamer', 'wh_buster',
  'skymine0', 'skymine1', 'skymine2', 'skymine3',
]), { cols: 5, scale: 3, pad: 3, bg: 0xff6a4a32 });

writeSheet(path.join(OUT, 'spr-maw.png'), pick([
  'maw_idle0', 'maw_idle1', 'maw_idle2', 'maw_idle3',
  'maw_fire0', 'maw_fire1', 'maw_fire2', 'maw_pain',
  'maw_die0', 'maw_die1', 'maw_die2', 'maw_die3',
  'maw_die4', 'maw_die5', 'maw_dead',
]), { cols: 4, scale: 1, pad: 4 });

writeSheet(path.join(OUT, 'spr-gore.png'), pick([
  'gib0', 'gib1', 'gib2', 'gib3', 'gib4', 'gib5', 'gib6', 'gib7',
  'gore_pool0', 'gore_pool1', 'gore_pool2', 'gore_pool3',
  'viscera0', 'viscera1', 'viscera2', 'acid0', 'acid1', 'acid2',
]), { cols: 6, scale: 4, pad: 3 });

// scale-1 legibility for the new cast
writeSheet(path.join(OUT, 'spr-mutants-1x.png'), pick(
  MUTANTS.flatMap((id) => {
    const a = [];
    for (let d = 0; d < 4; d++) for (let f = 0; f < 4; f++) a.push(`${id}_walk${d}_${f}`);
    a.push(`${id}_aim`, `${id}_fire`, `${id}_pain`, `${id}_die1`, `${id}_die3`, `${id}_dead`);
    return a;
  }).concat(['gib0', 'gib1', 'gib3', 'gib4', 'gore_pool2', 'viscera1', 'acid1'])),
  { cols: 22, scale: 1, pad: 2 });

// small-size legibility: everything at scale 1
writeSheet(path.join(OUT, 'spr-small.png'), pick(expected.filter((k) => !k.startsWith('mutter'))),
  { cols: 20, scale: 1, pad: 2 });

// per-facing walk strips at 1x, to judge in-game legibility
writeSheet(path.join(OUT, 'spr-walk-1x.png'), pick(
  ENEMIES.flatMap((id) => {
    const a = [];
    for (let d = 0; d < 4; d++) for (let f = 0; f < 4; f++) a.push(`${id}_walk${d}_${f}`);
    return a;
  })), { cols: 16, scale: 1, pad: 2 });

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------
const cv = Object.entries(cover).filter(([k]) => SIZES[k.split('_')[0]]);
cv.sort((a, b) => a[1] - b[1]);
console.log(`built ${Object.keys(frames).length} frames in ${buildMs}ms -> ${OUT}`);
console.log(`coverage  lowest: ${cv.slice(0, 4).map(([k, v]) => `${k} ${(v * 100).toFixed(1)}%`).join(', ')}`);
console.log(`coverage highest: ${cv.slice(-4).map(([k, v]) => `${k} ${(v * 100).toFixed(1)}%`).join(', ')}`);
for (const w of warn) console.log(`WARN  ${w}`);
// intentional art changes move the baseline; list everything else first
const baseFails = fails.filter((m) => m.startsWith('BASELINE'));
for (const m of fails.filter((x) => !x.startsWith('BASELINE')).slice(0, 40)) console.log(`FAIL  ${m}`);
for (const m of baseFails.slice(0, 8)) console.log(`FAIL  ${m}`);
if (baseFails.length > 8) console.log(`FAIL  ... and ${baseFails.length - 8} more BASELINE changes`);
console.log(fails.length === 0
  ? `PASS  ${expected.length} required keys, all checks green`
  : `FAIL  ${fails.length} problem(s)`);
process.exit(fails.length ? 1 : 0);
