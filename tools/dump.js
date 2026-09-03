// Quick ASCII dump of one authoring module: node tools/dump.js lv1
import { assertSound } from './mapkit.js';
const which = process.argv[2] || 'lv1';
const mod = await import(`./${which}.js`);
const rows = mod.default();
assertSound(which, rows);
const w = rows[0].length;
let head = '    ';
for (let x = 0; x < w; x++) head += x % 10 === 0 ? String((x / 10) | 0) : ' ';
console.log(head);
head = '    ';
for (let x = 0; x < w; x++) head += String(x % 10);
console.log(head);
rows.forEach((r, y) => console.log(String(y).padStart(3) + ' ' + r));
console.log(`${which}: ${w}x${rows.length}`);
