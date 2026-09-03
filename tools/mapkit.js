// mapkit.js - grid stamping helpers used to author the NUKEHAUS ASCII levels.
// Authoring aid only; the shipped data lives in src/game/maps.js.

export const WALL_CHARS_SET = new Set('#X=+!pvt:RBSCWNF%-123'.split(''));
export const FLOOR_CHARS_SET = new Set([' ', '_', ',', ';', '^', 'Z', 'E', '@']);

export function G(w, h, fill = '#') {
  const g = [];
  for (let y = 0; y < h; y++) g.push(new Array(w).fill(fill));
  g.W = w; g.H = h;
  return g;
}

const inb = (g, x, y) => x >= 0 && y >= 0 && y < g.length && x < g[0].length;

export function put(g, x, y, ch) {
  if (!inb(g, x, y)) throw new Error(`put out of bounds ${x},${y}`);
  g[y][x] = ch;
}

/** Place an entity/marker char; throws unless the cell is currently walkable. */
export function place(g, x, y, ch) {
  if (!inb(g, x, y)) throw new Error(`place out of bounds ${x},${y}`);
  const cur = g[y][x];
  if (!FLOOR_CHARS_SET.has(cur)) {
    throw new Error(`place '${ch}' at ${x},${y}: cell is '${cur}', not walkable floor`);
  }
  g[y][x] = ch;
}

export function fill(g, x0, y0, x1, y1, ch) {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) put(g, x, y, ch);
}

export function row(g, x0, x1, y, ch) { for (let x = x0; x <= x1; x++) put(g, x, y, ch); }
export function col(g, x, y0, y1, ch) { for (let y = y0; y <= y1; y++) put(g, x, y, ch); }

/** Paint the ring of a rect, but only over cells that are currently wall. */
export function outlineIfWall(g, x0, y0, x1, y1, ch) {
  for (let x = x0; x <= x1; x++) { ifWall(g, x, y0, ch); ifWall(g, x, y1, ch); }
  for (let y = y0; y <= y1; y++) { ifWall(g, x0, y, ch); ifWall(g, x1, y, ch); }
}

export function ifWall(g, x, y, ch) {
  if (!inb(g, x, y)) return;
  if (WALL_CHARS_SET.has(g[y][x])) g[y][x] = ch;
}

/** Paint a run of wall cells (skips anything already carved). */
export function rowIfWall(g, x0, x1, y, ch) { for (let x = x0; x <= x1; x++) ifWall(g, x, y, ch); }
export function colIfWall(g, x, y0, y1, ch) { for (let y = y0; y <= y1; y++) ifWall(g, x, y, ch); }

/** Scatter chars over a rect on a stride, only where currently `over`. */
export function speckle(g, x0, y0, x1, y1, ch, stride = 3, phase = 0, over = null) {
  let i = phase;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++, i++) {
    if (i % stride) continue;
    if (!inb(g, x, y)) continue;
    if (over && !over.includes(g[y][x])) continue;
    g[y][x] = ch;
  }
}

/** Stamp a multi-line pattern; '.' leaves the existing cell alone. */
export function stamp(g, x, y, lines) {
  lines.forEach((line, dy) => {
    for (let dx = 0; dx < line.length; dx++) {
      const c = line[dx];
      if (c === '.') continue;
      put(g, x + dx, y + dy, c);
    }
  });
}

export function toRows(g) { return g.map((r) => r.join('')); }

/** Sanity: rectangular + fully enclosed. Throws with a useful message. */
export function assertSound(name, rows) {
  const w = rows[0].length;
  rows.forEach((r, y) => { if (r.length !== w) throw new Error(`${name}: row ${y} is ${r.length}, expected ${w}`); });
  for (let x = 0; x < w; x++) {
    if (!WALL_CHARS_SET.has(rows[0][x]) || WALL_CHARS_SET.has(rows[rows.length - 1][x]) === false) {
      throw new Error(`${name}: leak on top/bottom border at x=${x}`);
    }
  }
  for (let y = 0; y < rows.length; y++) {
    if (!WALL_CHARS_SET.has(rows[y][0]) || !WALL_CHARS_SET.has(rows[y][w - 1])) {
      throw new Error(`${name}: leak on left/right border at y=${y}`);
    }
  }
  return rows;
}
