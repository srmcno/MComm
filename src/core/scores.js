// scores.js - the cabinet's memory. Best runs per difficulty, kept in
// localStorage, which can be absent or throw in a private window, so every
// access is defensive and a failure just means the machine forgets.

const KEY = 'nukehaus.scores.v1';

const BLANK = () => ({
  best: [0, 0, 0],          // best score per difficulty
  bestCities: [0, 0, 0],    // most cities standing at the end of a run
  runs: 0,
  cleared: [false, false, false],
  deepest: 0,               // furthest level reached, 1-based
});

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return BLANK();
    const v = JSON.parse(raw);
    const b = BLANK();
    return {
      best: Array.isArray(v.best) ? v.best.slice(0, 3).map((n) => (+n || 0)) : b.best,
      bestCities: Array.isArray(v.bestCities) ? v.bestCities.slice(0, 3).map((n) => (+n || 0)) : b.bestCities,
      runs: +v.runs || 0,
      cleared: Array.isArray(v.cleared) ? v.cleared.slice(0, 3).map(Boolean) : b.cleared,
      deepest: +v.deepest || 0,
    };
  } catch { return BLANK(); }
}

function write(v) {
  try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* nothing to be done */ }
}

let cache = null;

export function getScores() {
  if (!cache) cache = read();
  return cache;
}

/** @param {object} run {difficulty, score, cities, level, won} */
export function recordRun(run) {
  const s = getScores();
  const d = Math.max(0, Math.min(2, run.difficulty | 0));
  s.runs++;
  if (run.score > s.best[d]) s.best[d] = Math.round(run.score);
  if (run.cities > s.bestCities[d]) s.bestCities[d] = run.cities;
  if (run.won) s.cleared[d] = true;
  if (run.level > s.deepest) s.deepest = run.level;
  write(s);
  return s;
}

export function bestFor(d) { return getScores().best[Math.max(0, Math.min(2, d | 0))] || 0; }
export function anyBest() { return Math.max(...getScores().best); }
