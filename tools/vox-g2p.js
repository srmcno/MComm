// vox-g2p.js — dump the phoneme string for every word in every LINES entry.
// Read the output. Fix anything that looks wrong via rules, DICT, or {} escapes.
//   node tools/vox-g2p.js            list every distinct word, sorted
//   node tools/vox-g2p.js --lines    show each line phonemised in full
import { LINES, g2pWord, textToPhonemes, PHONE_SET } from '../src/audio/vox.js';

const showLines = process.argv.includes('--lines');
const all = [];
for (const k of Object.keys(LINES)) {
  const v = LINES[k];
  for (const s of Array.isArray(v) ? v : [v]) all.push([k, s]);
}

if (showLines) {
  for (const [k, s] of all) {
    const ph = textToPhonemes(s.replace(/%s/g, 'ASHGROVE'));
    const str = ph.map((p) => (p.p ? p.p + (p.st ? String(p.st) : '') : '/')).join(' ');
    console.log(`\n[${k}] ${s}`);
    console.log(`      ${str}`);
  }
  process.exit(0);
}

// Distinct words across every line.
const words = new Map();
for (const [k, s] of all) {
  const plain = s.replace(/\{[^}]*\}/g, ' ').replace(/%s/g, ' ');
  for (const w of plain.match(/[A-Za-z][A-Za-z']*|\d+/g) || []) {
    const key = w.toUpperCase();
    if (!words.has(key)) words.set(key, { w, keys: new Set() });
    words.get(key).keys.add(k);
  }
}
// The six cities are substituted in at runtime.
for (const c of ['VERITY', 'ASHGROVE', 'LOW', 'SABBATH', 'CANDLEMARK', 'HOLLOW',
  'BAY', 'SAINT', 'ERROL']) if (!words.has(c)) words.set(c, { w: c, keys: new Set(['<city>']) });

const names = [...words.keys()].sort();
let bad = 0;
for (const W of names) {
  const src = /^\d+$/.test(W) ? null : W;
  const ph = src ? g2pWord(src) : [];
  const flat = ph.join(' ');
  const known = ph.every((p) => PHONE_SET.includes(p.replace(/\d$/, '')));
  const hasVowel = ph.some((p) => /^(AA|AE|AH|AO|AX|EH|ER|IH|IY|OW|UH|UW|AY|EY|OY|AW)\d?$/.test(p));
  const flag = !src ? '   ' : !ph.length || !known || !hasVowel ? '!! ' : (DICTED(W) ? ' d ' : '   ');
  if (flag === '!! ') bad++;
  console.log(`${flag}${W.padEnd(16)} ${flat}`);
}
function DICTED(w) {
  // crude: dictionary entries carry explicit stress digits far more often
  return false;
}
console.log(`\n${names.length} distinct words, ${bad} flagged`);
console.log(`phone inventory: ${PHONE_SET.length} -> ${PHONE_SET.join(' ')}`);
