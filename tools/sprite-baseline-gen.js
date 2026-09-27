// sprite-baseline-gen.js - rewrite tools/sprite-baseline.json from the current art.
//
// Run this ONLY when a change to already-shipped sprite art is intended.
// Normally preview-sprites.js asserting against the existing baseline is the
// point: it is what stops an edit to a shared painter from silently repainting
// frames the game already uses.  node tools/sprite-baseline-gen.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSprites } from '../src/engine/sprites.js';

// Same fingerprint preview-sprites.js checks: FNV-1a over the frame's bytes.
function hash32(u32) {
  let h = 0x811c9dc5 >>> 0;
  const b = new Uint8Array(u32.buffer, u32.byteOffset, u32.byteLength);
  for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
const sig = (f) => `${f.w}x${f.h}:${hash32(f.data).toString(16).padStart(8, '0')}`;

const here = path.dirname(fileURLToPath(import.meta.url));
const { frames } = buildSprites();
const out = {};
for (const k of Object.keys(frames).sort()) out[k] = sig(frames[k]);
fs.writeFileSync(path.join(here, 'sprite-baseline.json'), `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote sprite-baseline.json with ${Object.keys(out).length} entries`);
