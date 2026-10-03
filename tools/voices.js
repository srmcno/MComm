// voices.js - the recorded cast, read straight off disk for the tools. The
// game fetches the same files over the network (src/audio/voicepack.js).
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { VOICE_FILES } from '../src/audio/voicepack.js';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
let cache = null;

/** Every clip in the voice files, by set: { cast: [...], stevem: [...], texas: [...] }. */
export async function readVoices() {
  if (cache) return cache;
  const bySet = {};
  for (const f of VOICE_FILES) {
    globalThis.NUKEHAUS_VOICES = [];
    await import(pathToFileURL(path.join(ROOT, f.src)).href);
    for (const p of globalThis.NUKEHAUS_VOICES) (bySet[p.set || 'cast'] || (bySet[p.set || 'cast'] = [])).push(...p.clips);
  }
  globalThis.NUKEHAUS_VOICES = [];
  cache = bySet;
  return bySet;
}

export default readVoices;
