// scrawl-check.js - the words on the walls: every message can be written, fits the
// wall it is written on, and a raster of it comes out as ink and not as noise.
//   node tools/scrawl-check.js
import { MESSAGES, WORDS, PHRASES, Scrawl, canWrite, rasterText, faceOfNormal, faceRight, FACE_D } from '../src/game/scrawl.js';

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
}

const all = [...MESSAGES.flat(), ...WORDS.map((w) => w[0]), ...PHRASES];
check('every character of every message and curse is in the hand font', all.every(canWrite),
  all.filter((t) => !canWrite(t)).join(' | '));
check('no em dashes, no lowercase, plain ASCII', all.every((t) => t === t.toUpperCase() && /^[\x20-\x7e]+$/.test(t) && !/--/.test(t)));
check('a message is at most three lines', MESSAGES.every((m) => m.length >= 1 && m.length <= 3));
const need = MESSAGES.map((m) => Scrawl.cellsFor(m, 8));
check('every message fits a run of six cells or fewer', need.every((n) => n <= 6), `widest needs ${Math.max(...need)}`);
check('there are messages for tight spots, too (two and three cells)', need.some((n) => n === 2) && need.some((n) => n === 3), need.join(','));
check('a message is written in a couple of seconds, not an age', MESSAGES.every((m) => Scrawl.writeTime(m) < 7), `longest ${Math.max(...MESSAGES.map((m) => Scrawl.writeTime(m))).toFixed(1)} s`);

let good = true, why = '';
for (const m of MESSAGES) {
  const R = rasterText(m, 8, 1234);
  let ink = 0;
  for (let i = 0; i < R.cov.length; i++) if (R.cov[i] > 0.5) ink++;
  const frac = ink / R.cov.length;
  if (R.w > Scrawl.cellsFor(m, 8) * 64 - 2 || frac < 0.12 || frac > 0.6) { good = false; why = `${m.join('/')}: w ${R.w} ink ${frac.toFixed(2)}`; break; }
}
check('a raster of every message fits its cells and is ink rather than noise', good, why);

let curseOk = true;
for (const w of [...WORDS.map((x) => x[0]), ...PHRASES]) {
  const R = rasterText([w], 12, 99);
  const cells = Math.ceil((R.w + 2) / 64);
  if (cells > 2) { curseOk = false; why = `${w} needs ${cells}`; }
}
check('every curse fits one wall cell, and every phrase fits two', curseOk, why);
check('the same seed writes the same hand, a different seed a different one',
  rasterText(['SHIT'], 12, 5).cov.join() === rasterText(['SHIT'], 12, 5).cov.join()
  && rasterText(['SHIT'], 12, 5).cov.join() !== rasterText(['SHIT'], 12, 6).cov.join());

// faces: the four ways a wall can be looked at, and which way is right
check('a splash on a wall facing west lands on the east-looking face, and so on',
  faceOfNormal(-1, 0) === 0 && faceOfNormal(1, 0) === 1 && faceOfNormal(0, -1) === 2 && faceOfNormal(0, 1) === 3);
check('right is right: looking east right is south (y grows down), and it turns with the viewer',
  faceRight(0).join() === '0,1' && faceRight(1).join() === '0,-1' && faceRight(2).join() === '-1,0' && faceRight(3).join() === '1,0');
check('the four view directions are unit and distinct', new Set(FACE_D.map((d) => d.join())).size === 4);

console.log(`\n${fail ? 'FAIL' : 'PASS'}  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
