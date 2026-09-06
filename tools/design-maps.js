// design-maps.js - builds the five NUKEHAUS levels from the per-level authoring
// modules (lv1..lv5) and injects their ASCII into src/game/maps.js between the
// <ascii:begin> / <ascii:end> markers. Run: node tools/design-maps.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSound } from './mapkit.js';
import intake from './lv1.js';
import organLoft from './lv2.js';
import saltCathedral from './lv3.js';
import furnace from './lv4.js';
import mutter from './lv5.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TARGET = path.join(HERE, '..', 'src', 'game', 'maps.js');

const LEVELS = [
  ['ROWS_INTAKE', 'INTAKE - 40x40', intake],
  ['ROWS_ORGAN_LOFT', 'THE ORGAN LOFT - 48x48', organLoft],
  ['ROWS_SALT_CATHEDRAL', 'SALT CATHEDRAL - 52x52', saltCathedral],
  ['ROWS_FURNACE', 'THE FURNACE - 56x56', furnace],
  ['ROWS_MUTTER', 'MUTTER - 34x34', mutter],
];

const blocks = LEVELS.map(([name, title, build]) => {
  const rows = assertSound(name, build());
  const body = rows.map((r) => `  '${r}',`).join('\n');
  return `// ${title}\nconst ${name} = [\n${body}\n];`;
});

const src = fs.readFileSync(TARGET, 'utf8');
const begin = src.indexOf('// <ascii:begin>');
const end = src.indexOf('// <ascii:end>');
if (begin < 0 || end < 0) throw new Error('maps.js is missing its <ascii:*> markers');
const out = `${src.slice(0, begin)}// <ascii:begin>\n${blocks.join('\n\n')}\n${src.slice(end)}`;
fs.writeFileSync(TARGET, out);

const total = LEVELS.reduce((a, [, , b]) => a + b().length, 0);
console.log(`injected ${LEVELS.length} levels (${total} rows) into ${path.relative(process.cwd(), TARGET)}`);
