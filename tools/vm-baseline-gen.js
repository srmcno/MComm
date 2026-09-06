// vm-baseline-gen.js - rewrite tools/vm-baseline.js from the current art.
//
// Run this ONLY when a change to already-shipped viewmodel art is intended.
// Normally preview-vm.js asserting against the existing baseline is the point:
// it is what stops an edit to a shared painter from silently repainting frames
// the game already uses.  node tools/vm-baseline-gen.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildViewmodels } from '../src/engine/viewmodels.js';
import { frameHash } from './vm-hash.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const { frames } = buildViewmodels();
const keys = Object.keys(frames).sort();
const head = `// vm-baseline.js - GENERATED GOLDEN FILE. Do not hand-edit.
//
// Per-frame fingerprints of the viewmodel frames the game already ships.
// preview-vm.js asserts every one of these still hashes identically, so any
// accidental change to a shared painter, a light rig constant or the model
// transform - which would silently repaint art already in the game - fails
// loudly instead.
//
// Regenerate ONLY when a change to the original art is actually intended:
//   node tools/vm-baseline-gen.js
`;
const body = keys.map((k) => `  '${k}': '${frames[k].w}x${frames[k].h}:${frameHash(frames[k].data)}',`);
fs.writeFileSync(path.join(here, 'vm-baseline.js'),
  `${head}\nexport const VM_BASELINE = {\n${body.join('\n')}\n};\n`);
console.log(`wrote vm-baseline.js with ${keys.length} entries`);
