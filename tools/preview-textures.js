// preview-textures.js - build the atlas, check it, and dump contact sheets so a
// human (or a model with eyes) can actually look at the art.
//
//   node tools/preview-textures.js [outDir]
import { writePng } from './png.js';
import { buildTextures, TEXTURE_ORDER } from '../src/engine/textures.js';

const OUT = process.argv[2] || '/tmp/claude-0/-home-user-MComm/1d9ae501-9927-5c9d-832d-0ee312d588ac/scratchpad';
const TEX = 64, AREA = TEX * TEX;

// ---- tiny 3x5 label font -------------------------------------------------
const F = {
  A: '010/101/111/101/101', B: '110/101/110/101/110', C: '011/100/100/100/011',
  D: '110/101/101/101/110', E: '111/100/110/100/111', F: '111/100/110/100/100',
  G: '011/100/101/101/011', H: '101/101/111/101/101', I: '111/010/010/010/111',
  J: '001/001/001/101/010', K: '101/101/110/101/101', L: '100/100/100/100/111',
  M: '101/111/111/101/101', N: '101/110/111/011/101', O: '010/101/101/101/010',
  P: '110/101/110/100/100', Q: '010/101/101/011/001', R: '110/101/110/101/101',
  S: '011/100/010/001/110', T: '111/010/010/010/010', U: '101/101/101/101/011',
  V: '101/101/101/101/010', W: '101/101/111/111/101', X: '101/101/010/101/101',
  Y: '101/101/010/010/010', Z: '111/001/010/100/111',
  0: '111/101/101/101/111', 1: '010/110/010/010/111', 2: '110/001/010/100/111',
  3: '110/001/010/001/110', 4: '101/101/111/001/001', 5: '111/100/110/001/110',
  6: '011/100/110/101/010', 7: '111/001/010/010/010', 8: '010/101/010/101/010',
  9: '010/101/011/001/110', _: '000/000/000/000/111', ' ': '000/000/000/000/000',
};
const GL = {}; for (const k in F) GL[k] = F[k].split('/');
function label(buf, w, s, x, y, col) {
  let cx = x;
  for (const ch of String(s).toUpperCase()) {
    const g = GL[ch];
    if (g) for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) {
      if (g[r][c] === '1') buf[(y + r) * w + cx + c] = col;
    }
    cx += 4;
  }
  return cx - x;
}

// ---- sheet builder -------------------------------------------------------
function sheet(path, items, { cols, scale, bg = 0xff181418, fg = 0xffc8c8d0 }) {
  const cw = TEX * scale + 8, chh = TEX * scale + 8 + 7;
  const rows = Math.ceil(items.length / cols);
  const W = cw * cols, H = chh * rows;
  const out = new Uint32Array(W * H).fill(bg);
  items.forEach((it, n) => {
    const ox = (n % cols) * cw + 4, oy = Math.floor(n / cols) * chh + 4;
    for (let y = -1; y <= TEX * scale; y++) for (let x = -1; x <= TEX * scale; x++) {
      out[(oy + y) * W + ox + x] = 0xff30303a;
    }
    for (let y = 0; y < TEX * scale; y++) {
      for (let x = 0; x < TEX * scale; x++) {
        out[(oy + y) * W + ox + x] = it.data[((y / scale) | 0) * TEX + ((x / scale) | 0)] >>> 0;
      }
    }
    label(out, W, it.label, ox, oy + TEX * scale + 2, it.ok === false ? 0xff4040ff : fg);
  });
  writePng(path, W, H, out);
  return path;
}

// ---- build + check -------------------------------------------------------
const { atlas, count, names, emissive } = buildTextures();
const lumOf = (c) => 0.299 * (c & 255) + 0.587 * ((c >>> 8) & 255) + 0.114 * ((c >>> 16) & 255);

let fails = 0;
const rows = [];
const frames = [];
for (let i = 0; i < count; i++) {
  const data = atlas.subarray(i * AREA, (i + 1) * AREA);
  const colours = new Set();
  let bad = 0, nan = 0, sum = 0, sum2 = 0, lo = 255, hi = 0;
  for (let k = 0; k < AREA; k++) {
    const c = data[k] >>> 0;
    if (!Number.isFinite(c)) nan++;
    if ((c >>> 24) !== 255) bad++;
    colours.add(c);
    const l = lumOf(c);
    if (!Number.isFinite(l)) nan++;
    sum += l; sum2 += l * l;
    if (l < lo) lo = l; if (l > hi) hi = l;
  }
  const mean = sum / AREA;
  const sd = Math.sqrt(Math.max(0, sum2 / AREA - mean * mean));
  const ok = bad === 0 && nan === 0 && colours.size >= 12 && sd > 8;
  if (!ok) fails++;
  rows.push({ i, name: names[i], colours: colours.size, sd, mean, lo, hi, bad, nan, ok });
  frames.push({ data, label: `${i} ${names[i]}`, ok });
}

// seam metric: how much worse is the wrap edge than a typical interior edge?
// Seam metric. A texture is allowed genuine high-contrast features across the
// wrap (a grout line, a panel rib) - what is NOT allowed is a discontinuity
// worse than anything inside the texture. So compare the wrap line against the
// worst interior line of the same kind.
function seam(data, axis) {
  const lines = [];
  for (let x = 0; x < TEX; x++) {
    let s = 0;
    for (let k = 0; k < TEX; k++) {
      const a = axis === 'x' ? data[k * TEX + x] : data[x * TEX + k];
      const b = axis === 'x' ? data[k * TEX + (x + 1) % TEX] : data[((x + 1) % TEX) * TEX + k];
      s += Math.abs(lumOf(a) - lumOf(b));
    }
    lines.push(s / TEX);
  }
  const edge = lines[TEX - 1];
  const inner = lines.slice(0, TEX - 1);
  const worst = Math.max(...inner);
  return edge / Math.max(0.001, worst);
}
const TILE_X = ['CONCRETE', 'CONCRETE_CRACKED', 'STEEL_PLATE', 'STEEL_RIVET', 'PIPES', 'RUST', 'TILE',
  'TILE_BLOOD', 'SANDBAG', 'SILO_WALL', 'VENT', 'FLESH', 'FLOOR_CONCRETE', 'FLOOR_GRATE', 'FLOOR_TILE',
  'FLOOR_DIRT', 'FLOOR_BLOOD', 'CEIL_CONCRETE', 'CEIL_PIPES', 'CEIL_FLESH', 'FLOOR_DECK'];
const TILE_Y = ['FLOOR_CONCRETE', 'FLOOR_GRATE', 'FLOOR_TILE', 'FLOOR_DIRT', 'FLOOR_BLOOD',
  'CEIL_CONCRETE', 'CEIL_PIPES', 'CEIL_FLESH', 'FLOOR_DECK'];

console.log(`atlas ${atlas.length} px  (expect ${32 * AREA}) ${atlas.length === 32 * AREA ? 'OK' : 'WRONG'}`);
console.log('idx name              colours   sd  mean  min  max  seamX seamY  emis  result');
for (const r of rows) {
  const d = atlas.subarray(r.i * AREA, (r.i + 1) * AREA);
  const sx = TILE_X.includes(r.name) ? seam(d, 'x') : null;
  const sy = TILE_Y.includes(r.name) ? seam(d, 'y') : null;
  const seamBad = (sx !== null && sx > 1.25) || (sy !== null && sy > 1.25);
  if (seamBad) { r.ok = false; fails++; }
  console.log(
    String(r.i).padStart(3) + ' ' + r.name.padEnd(17) +
    String(r.colours).padStart(6) + ' ' + r.sd.toFixed(1).padStart(5) +
    r.mean.toFixed(0).padStart(6) + String(Math.round(r.lo)).padStart(5) + String(Math.round(r.hi)).padStart(5) +
    (sx === null ? '     -' : sx.toFixed(2).padStart(6)) +
    (sy === null ? '     -' : sy.toFixed(2).padStart(6)) +
    emissive[r.i].toFixed(2).padStart(6) + '  ' +
    (r.ok ? 'PASS' : 'FAIL' + (r.bad ? ' alpha' : '') + (r.nan ? ' nan' : '') +
      (r.colours < 12 ? ' colours' : '') + (r.sd <= 8 ? ' flat' : '') + (seamBad ? ' seam' : ''))
  );
}
console.log(fails === 0 ? `ALL ${count} TEXTURES PASS` : `${fails} FAILURES of ${count}`);

// ---- images --------------------------------------------------------------
sheet(`${OUT}/textures.png`, frames, { cols: 8, scale: 3 });
sheet(`${OUT}/detail-a.png`, frames.slice(0, 16), { cols: 4, scale: 5 });
sheet(`${OUT}/detail-b.png`, frames.slice(16), { cols: 4, scale: 5 });

// tiling proof: 3x2 repeat of each tileable texture
{
  const items = TILE_X.map((n) => {
    const i = names.indexOf(n);
    const src = atlas.subarray(i * AREA, (i + 1) * AREA);
    const data = new Uint32Array(AREA);
    // shift by half a texture so the wrap seam lands dead centre
    for (let y = 0; y < TEX; y++) for (let x = 0; x < TEX; x++) {
      data[y * TEX + x] = src[((y + 32) % TEX) * TEX + ((x + 32) % TEX)];
    }
    return { data, label: n };
  });
  sheet(`${OUT}/seams.png`, items, { cols: 7, scale: 3 });
}
{
  const wide = 3, tall = 2;
  const picks = ['CONCRETE', 'STEEL_RIVET', 'PIPES', 'TILE', 'RUST', 'SANDBAG', 'FLOOR_GRATE', 'FLOOR_DECK', 'CEIL_PIPES'];
  const W = TEX * wide, H = TEX * tall * picks.length;
  const out = new Uint32Array(W * H);
  picks.forEach((n, k) => {
    const src = atlas.subarray(names.indexOf(n) * AREA, (names.indexOf(n) + 1) * AREA);
    for (let y = 0; y < TEX * tall; y++) {
      for (let x = 0; x < W; x++) out[(k * TEX * tall + y) * W + x] = src[(y % TEX) * TEX + (x % TEX)];
    }
  });
  writePng(`${OUT}/tiled.png`, W, H, out);
}
console.log(`wrote ${OUT}/textures.png, detail-a.png, detail-b.png, seams.png, tiled.png`);
