// vox-g2p.js — dump the phoneme string for every word in every LINES entry.
// Read the output. Fix anything that looks wrong via rules, DICT, or {} escapes.
//   node tools/vox-g2p.js            every distinct word, sorted
//   node tools/vox-g2p.js --new      only words the story update introduced
//   node tools/vox-g2p.js --lines    each line phonemised in full
//   node tools/vox-g2p.js --lines brick_   ... filtered to matching keys
import { LINES, g2pWord, textToPhonemes, PHONE_SET, VOICE_OF } from '../src/audio/vox.js';

// The 28 keys that existed before the three-voice story update.
const ORIGINAL = new Set(['boot', 'wave_start', 'wave_clear', 'city_lost',
  'city_lost_last', 'all_cities_lost', 'player_hurt_bad', 'player_death',
  'level_clear', 'secret_found', 'key_taken', 'weapon_taken', 'low_ammo',
  'chain_praise', 'perfect_burst', 'boss_intro', 'boss_death', 'idle_taunt',
  'elevator', 'roof_opening', 'mirv_warning', 'buster_warning', 'smart_warning',
  'game_over', 'victory', 'title_idle']);

const showLines = process.argv.includes('--lines');
const onlyNew = process.argv.includes('--new');
const filter = process.argv[3] || '';

const all = [];
for (const k of Object.keys(LINES)) {
  for (const s of (Array.isArray(LINES[k]) ? LINES[k] : [LINES[k]])) all.push([k, s]);
}

if (showLines) {
  for (const [k, s] of all) {
    if (filter && !k.includes(filter)) continue;
    const ph = textToPhonemes(s.replace(/%s/g, 'ASHGROVE'));
    console.log(`\n[${VOICE_OF[k]}/${k}] ${s}`);
    console.log(`   ${ph.map((p) => (p.p ? p.p + (p.st ? String(p.st) : '') : '/')).join(' ')}`);
  }
  process.exit(0);
}

// Distinct words, tracking which keys (and so which speakers) use them.
const words = new Map();
for (const [k, s] of all) {
  const plain = s.replace(/\{[^}]*\}/g, ' ').replace(/%s/g, ' ');
  for (const w of plain.match(/[A-Za-z][A-Za-z']*|\d+/g) || []) {
    const key = w.toUpperCase();
    if (!words.has(key)) words.set(key, new Set());
    words.get(key).add(k);
  }
}
for (const c of ['VERITY', 'ASHGROVE', 'LOW', 'SABBATH', 'CANDLEMARK', 'HOLLOW',
  'BAY', 'SAINT', 'ERROL']) if (!words.has(c)) words.set(c, new Set(['<city>']));

const isNew = (keys) => ![...keys].some((k) => ORIGINAL.has(k));
const names = [...words.keys()].filter((w) => !onlyNew || isNew(words.get(w))).sort();

let bad = 0;
for (const W of names) {
  if (/^\d+$/.test(W)) { console.log(`    ${W.padEnd(14)} (spoken as a number)`); continue; }
  const ph = g2pWord(W);
  const known = ph.every((p) => PHONE_SET.includes(p.replace(/\d$/, '')));
  const hasVowel = ph.some((p) => /^(AA|AE|AH|AO|AX|EH|ER|IH|IY|OW|UH|UW|AY|EY|OY|AW)\d?$/.test(p));
  const ok = ph.length && known && hasVowel;
  if (!ok) bad++;
  const who = [...new Set([...words.get(W)].map((k) => (VOICE_OF[k] || '?')[0]))].sort().join('');
  console.log(`${ok ? '   ' : '!! '}${who.padEnd(4)}${W.padEnd(14)} ${ph.join(' ')}`);
}
console.log(`\n${names.length} ${onlyNew ? 'new ' : ''}distinct words, ${bad} flagged`);
console.log(`phone inventory: ${PHONE_SET.length}`);
console.log(`LINES keys: ${Object.keys(LINES).length}`);
