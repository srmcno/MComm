// preview-maps.js - validate + eyeball the NUKEHAUS levels.
//   node tools/preview-maps.js            all levels
//   node tools/preview-maps.js 3          just level 3
// Prints problems, coloured ANSI art and per-level stats, and writes a top-down
// PNG per level (12px/cell) with the reachability flood overlaid in magenta.
import fs from 'node:fs';
import path from 'node:path';
import { writePng } from './png.js';
import { MAPS, LEGEND, parseLevel, validateAll } from '../src/game/maps.js';

const OUT = process.env.MAP_OUT
  || '/tmp/claude-0/-home-user-MComm/1d9ae501-9927-5c9d-832d-0ee312d588ac/scratchpad';
const CELL = 12;

// --- palette ---------------------------------------------------------------
const rgb = (r, g, b, a = 255) => (((a << 24) | (b << 16) | (g << 8) | r) >>> 0);

const WALL_RGB = {
  '#': [122, 122, 128], 'X': [104, 96, 88], '=': [126, 138, 152], '+': [104, 116, 132],
  '!': [206, 168, 40], 'p': [96, 112, 108], 'v': [80, 92, 96], 't': [186, 190, 186],
  ':': [150, 104, 104], 'R': [140, 96, 62], 'B': [150, 134, 88], 'S': [70, 132, 150],
  'C': [96, 78, 148], 'W': [92, 100, 118], 'N': [214, 128, 40], 'F': [172, 84, 88],
  '%': [230, 90, 200],
  '-': [200, 200, 200], '1': [220, 70, 70], '2': [70, 130, 230], '3': [230, 200, 60],
};
const FLOOR_RGB = {
  ' ': [42, 42, 48], '_': [50, 54, 58], ',': [58, 52, 42], ';': [64, 36, 40],
  '^': [26, 150, 176], 'Z': [232, 120, 30], 'E': [70, 220, 120], '@': [60, 230, 90],
};
const ENT_RGB = {
  a: [230, 90, 70], b: [255, 210, 60], c: [230, 130, 40], d: [200, 90, 220], e: [120, 240, 140],
  K: [255, 60, 60],
  r: [255, 60, 60], u: [70, 150, 255], g: [255, 215, 60],
  h: [120, 255, 160], H: [60, 255, 120], m: [255, 190, 90], M: [255, 150, 40],
  o: [255, 120, 40], D: [130, 130, 140], L: [255, 250, 190], T: [255, 190, 120],
  $: [255, 230, 80], w: [90, 230, 255],
};

// --- ANSI ------------------------------------------------------------------
const fg = (c, s) => `\x1b[38;2;${c[0]};${c[1]};${c[2]}m${s}\x1b[0m`;
const bgfg = (b, f, s) => `\x1b[48;2;${b[0]};${b[1]};${b[2]}m\x1b[38;2;${f[0]};${f[1]};${f[2]}m${s}\x1b[0m`;

function ansiCell(ch) {
  if (WALL_RGB[ch]) {
    const c = WALL_RGB[ch];
    if (ch === '-' || ch === '1' || ch === '2' || ch === '3') return bgfg([30, 30, 34], c, ch);
    if (ch === '%') return bgfg([60, 20, 55], c, '%');
    return fg(c, '█');
  }
  if (ENT_RGB[ch]) return bgfg([38, 38, 44], ENT_RGB[ch], ch);
  const f = FLOOR_RGB[ch];
  if (ch === '^') return bgfg([16, 60, 74], [80, 220, 240], '·');
  if (ch === 'Z') return bgfg([120, 60, 10], [255, 220, 140], 'Z');
  if (ch === 'E') return bgfg([20, 90, 50], [140, 255, 190], 'E');
  if (ch === '@') return bgfg([20, 100, 40], [180, 255, 190], '@');
  return fg(f || [70, 70, 70], ch === ' ' ? '·' : ch);
}

function printAnsi(rows) {
  const w = rows[0].length;
  let ruler = '    ';
  for (let x = 0; x < w; x++) ruler += x % 10 === 0 ? String((x / 10) | 0) : ' ';
  console.log('\x1b[90m' + ruler + '\x1b[0m');
  rows.forEach((r, y) => {
    let line = '\x1b[90m' + String(y).padStart(3) + ' \x1b[0m';
    for (let x = 0; x < w; x++) line += ansiCell(r[x]);
    console.log(line);
  });
}

const LEGEND_ORDER = [
  ['#XN=+!pvt:RBSCWF', 'walls'],
  ['-123', 'doors: blast / red / blue / gold'],
  ['%', 'pushwall'],
  ['^ZE@', 'open sky / trigger / exit / start'],
  ['abcde', 'wrencher sparker bellows wasp priest'],
  ['K', 'boss'],
  ['rug', 'keys'],
  ['hHmM$w', 'medkits ammo treasure weapon'],
  ['oDLT', 'barrel pillar lamp flare'],
];
function printLegend() {
  console.log('\x1b[90mlegend:\x1b[0m');
  for (const [chars, label] of LEGEND_ORDER) {
    let s = '  ';
    for (const ch of chars) s += ansiCell(ch);
    console.log(`${s} \x1b[90m${label}\x1b[0m`);
  }
}

// --- reachability (same rules as validateAll, re-derived for the overlay) ---
function reachMask(def, secretsPassable = false) {
  const rows = def.rows, h = rows.length, w = rows[0].length;
  const have = { red: false, blue: false, gold: false };
  let sx = 0, sy = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (rows[y][x] === '@') { sx = x; sy = y; }
  let seen = new Uint8Array(w * h);
  for (let round = 0; round < 8; round++) {
    const cur = new Uint8Array(w * h);
    const stack = [[sx, sy]];
    while (stack.length) {
      const [x, y] = stack.pop();
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const i = y * w + x;
      if (cur[i]) continue;
      const d = LEGEND[rows[y][x]];
      if (!d || d.type === 'wall') continue;
      if (d.type === 'secret' && !secretsPassable) continue;
      if (d.type === 'door' && d.door !== 'free' && !have[d.door]) continue;
      cur[i] = 1;
      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
    let grew = false;
    for (let i = 0; i < cur.length; i++) if (cur[i] !== seen[i]) { grew = true; break; }
    seen = cur;
    let gotKey = false;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!seen[y * w + x]) continue;
      const d = LEGEND[rows[y][x]];
      if (d && d.key && !have[d.key]) { have[d.key] = true; gotKey = true; }
    }
    if (!grew && !gotKey) break;
  }
  return seen;
}

// --- PNG -------------------------------------------------------------------
function renderPng(def, file) {
  const rows = def.rows, h = rows.length, w = rows[0].length;
  const lv = parseLevel(MAPS.indexOf(def));
  const seen = reachMask(def);
  const seenSecret = reachMask(def, true);
  const W = w * CELL, H = h * CELL;
  const img = new Uint32Array(W * H);
  const px = (x, y, c) => { if (x >= 0 && y >= 0 && x < W && y < H) img[y * W + x] = c; };
  const box = (cx, cy, x0, y0, x1, y1, c) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) px(cx * CELL + x, cy * CELL + y, c);
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ch = rows[y][x];
      const i = y * w + x;
      const isWall = !!WALL_RGB[ch];
      let base;
      if (isWall) {
        const c = WALL_RGB[ch];
        base = rgb(c[0], c[1], c[2]);
      } else if (lv.sky[i]) {
        base = rgb(22, 120, 146);
      } else {
        const f = FLOOR_RGB[ch] || FLOOR_RGB[' '];
        base = rgb(f[0], f[1], f[2]);
      }
      box(x, y, 0, 0, CELL - 1, CELL - 1, base);
      // grid hairline so cells stay countable
      if (!isWall) {
        for (let k = 0; k < CELL; k++) {
          px(x * CELL + k, y * CELL, rgb(0, 0, 0, 40));
          px(x * CELL, y * CELL + k, rgb(0, 0, 0, 40));
        }
      }
      // behind a pushwall = dim purple; genuinely unreachable = screaming magenta
      if (!isWall && !seen[i]) {
        box(x, y, 2, 2, CELL - 3, CELL - 3, seenSecret[i] ? rgb(96, 48, 120) : rgb(255, 0, 220));
      }
      // doors keep their key colour as a fat bar
      if (ch === '-' || ch === '1' || ch === '2' || ch === '3') {
        const c = WALL_RGB[ch];
        box(x, y, 0, 0, CELL - 1, CELL - 1, rgb(24, 24, 28));
        box(x, y, 1, 4, CELL - 2, CELL - 5, rgb(c[0], c[1], c[2]));
      }
      if (ch === '%') box(x, y, 3, 3, CELL - 4, CELL - 4, rgb(255, 60, 220));
      if (lv.trigger[i]) box(x, y, 2, 2, CELL - 3, CELL - 3, rgb(240, 130, 30));
      if (lv.exit[i]) box(x, y, 1, 1, CELL - 2, CELL - 2, rgb(60, 230, 130));
      // entity dot
      const ec = ENT_RGB[ch];
      if (ec && ch !== 'K') box(x, y, 3, 3, CELL - 4, CELL - 4, rgb(ec[0], ec[1], ec[2]));
      if (ch === 'K') box(x, y, 1, 1, CELL - 2, CELL - 2, rgb(255, 50, 50));
      // player start: a green wedge pointing the way they face
      if (ch === '@') {
        box(x, y, 0, 0, CELL - 1, CELL - 1, rgb(30, 90, 40));
        const dir = lv.start.dir;
        const ux = Math.round(Math.cos(dir)), uy = Math.round(Math.sin(dir));
        for (let k = 0; k < 5; k++) {
          const cx = x * CELL + 6 + ux * k, cy = y * CELL + 6 + uy * k;
          for (let s = -(4 - k); s <= 4 - k; s++) {
            px(cx + (uy ? s : 0), cy + (ux ? s : 0), rgb(90, 255, 110));
          }
        }
      }
    }
  }
  writePng(file, W, H, img);
  return file;
}

// --- stats -----------------------------------------------------------------
function stats(def) {
  const lv = parseLevel(MAPS.indexOf(def));
  const counts = {};
  for (const e of lv.ents) counts[e.kind] = (counts[e.kind] || 0) + 1;
  let walkable = 0, sky = 0, secret = 0;
  for (let i = 0; i < lv.w * lv.h; i++) {
    if (!lv.wall[i]) walkable++;
    if (lv.sky[i]) sky++;
    if (lv.secret[i]) secret++;
  }
  const enemyKinds = ['wrencher', 'sparker', 'bellows', 'wasp', 'priest', 'boss'];
  const itemKinds = ['medkit_small', 'medkit_big', 'ammo', 'ammo_crate', 'treasure', 'weapon',
    'key_red', 'key_blue', 'key_gold', 'barrel', 'pillar', 'lamp', 'flare'];
  const fmt = (ks) => ks.filter((k) => counts[k]).map((k) => `${k} ${counts[k]}`).join('  ') || 'none';
  const enemies = enemyKinds.reduce((a, k) => a + (counts[k] || 0), 0);
  console.log(`  size ${lv.w}x${lv.h}   walkable ${walkable}   deck(sky) ${sky}   secrets ${secret}   doors ${lv.doors.length}   triggers ${lv.trigger.reduce((a, b) => a + b, 0)}`);
  console.log(`  enemies ${enemies}: ${fmt(enemyKinds)}`);
  console.log(`  items: ${fmt(itemKinds)}`);
  console.log(`  par ${lv.par}s   waves ${lv.siege.waves.length}   music ${lv.music}   weapons [${(def.weapons || []).join(', ')}]`);
}

// --- main ------------------------------------------------------------------
const only = process.argv[2] ? Number(process.argv[2]) : null;
fs.mkdirSync(OUT, { recursive: true });

const problems = validateAll();
console.log('\x1b[1mvalidateAll()\x1b[0m');
if (problems.length) {
  for (const p of problems) console.log('  \x1b[31m' + p + '\x1b[0m');
  console.log(`  \x1b[1;31mFAIL - ${problems.length} problem(s)\x1b[0m`);
} else {
  console.log('  \x1b[1;32mPASS - all five levels are sound\x1b[0m');
}
console.log('');
printLegend();

MAPS.forEach((def, i) => {
  if (only !== null && only !== i + 1) return;
  console.log('');
  console.log(`\x1b[1m=== ${i + 1}. ${def.name} \x1b[0m\x1b[90m- ${def.subtitle}\x1b[0m`);
  printAnsi(def.rows);
  stats(def);
  const f = renderPng(def, path.join(OUT, `map${i + 1}.png`));
  console.log(`  \x1b[90mpng: ${f}\x1b[0m`);
});

process.exitCode = problems.length ? 1 : 0;
