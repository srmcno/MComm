// vox-render.js — render MUTTER through a real OfflineAudioContext in Chromium,
// dump WAVs, and draw spectrograms you can actually look at.
//
//   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node tools/vox-render.js
//   ... --out /tmp/vox   --sr 24000   --only boot,city_lost
//
// Asserts: peak < 0.99, rendered duration within 15% of say()'s return value,
// and that the signal is neither silent nor clipped.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { writeSpectrogram, writeWav } from './vox-spectro.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const OUT = arg('out', '/tmp/vox-render');
const SR = +arg('sr', 24000);
const ONLY = arg('only', '');
fs.mkdirSync(OUT, { recursive: true });

/* what to render: a spread of moods, phonetic content and glitch levels */
const CASES = [
  { id: '01-boot', kind: 'line', key: 'boot', pick: 0, opts: { mood: 'calm' } },
  { id: '02-city_lost', kind: 'line', key: 'city_lost', pick: 0, opts: { mood: 'sweet', args: ['Ashgrove', 'Five'] } },
  { id: '03-buster', kind: 'line', key: 'buster_warning', pick: 0, opts: { mood: 'urgent', glitch: 0.25 } },
  { id: '04-boss_death', kind: 'line', key: 'boss_death', pick: 0, opts: { mood: 'dying' } },
  { id: '05-idle', kind: 'line', key: 'idle_taunt', pick: 3, opts: { mood: 'calm' } },
  // phonetic probes — these are what the spectrograms are really for
  { id: '10-vowels', kind: 'text', text: '{IY1 IH1 EH1 AE1 AA1 AO1 UH1 UW1 ER1}', opts: { mood: 'calm', rate: 0.7 } },
  { id: '10b-hVd', kind: 'text', text: '{HH IY1 D} {HH EH1 D} {HH AA1 D} {HH UW1 D}', opts: { mood: 'calm', rate: 0.8 } },
  { id: '11-fricatives', kind: 'text', text: '{S AA1} {SH AA1} {F AA1} {TH AA1} {Z AA1} {HH AA1}', opts: { mood: 'calm', rate: 0.8 } },
  { id: '12-stops', kind: 'text', text: '{P AA1} {T AA1} {K AA1} {B AA1} {D AA1} {G AA1}', opts: { mood: 'calm', rate: 0.8 } },
  { id: '13-nasals', kind: 'text', text: '{M AA1} {N AA1} {NG AA1} {L AA1} {R AA1} {W AA1} {Y AA1}', opts: { mood: 'calm', rate: 0.8 } },
  { id: '14-diphthongs', kind: 'text', text: '{B AY1} {B EY1} {B OY1} {B AW1} {B OW1} {B ER1}', opts: { mood: 'calm', rate: 0.8 } },
  { id: '16-sustained', kind: 'text', text: '{AA1 AA1 AA1 AA1}', opts: { mood: 'calm', rate: 0.5 } },
  { id: '17-nofric', kind: 'text', text: '{M AA1 L IY1 W OW1 N AA1}', opts: { mood: 'calm', rate: 0.8 } },
  { id: '20-mood-calm', kind: 'text', text: 'Please do not be discouraged. Five remain.', opts: { mood: 'calm' } },
  { id: '21-mood-urgent', kind: 'text', text: 'Please do not be discouraged. Five remain.', opts: { mood: 'urgent' } },
  { id: '22-mood-sweet', kind: 'text', text: 'Please do not be discouraged. Five remain.', opts: { mood: 'sweet' } },
  { id: '23-mood-dying', kind: 'text', text: 'Please do not be discouraged. Five remain.', opts: { mood: 'dying' } },
  { id: '24-glitch', kind: 'text', text: 'Please do not be discouraged. Five remain.', opts: { mood: 'calm', glitch: 0.85 } },
  { id: '15-sentence', kind: 'text', text: 'The six cities are not people. The assets are screaming.', opts: { mood: 'calm' } },
];
const cases = ONLY ? CASES.filter((c) => ONLY.split(',').some((s) => c.id.includes(s))) : CASES;

/* ---- tiny static server so the page can `import` the real module ---- */
const MIME = { '.js': 'text/javascript', '.html': 'text/html' };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end('no'); return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'text/plain' });
  res.end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

const PAGE = `<!doctype html><meta charset=utf-8><title>vox render</title>
<script type="module">
import { Vox, LINES, pickLine, seedVox } from '/src/audio/vox.js';
window.__render = async (c, sr) => {
  seedVox(20260903);
  // deterministic pick: pull the exact variant we asked for
  let text = c.kind === 'line'
    ? (Array.isArray(LINES[c.key]) ? LINES[c.key][c.pick % LINES[c.key].length] : LINES[c.key])
    : c.text;
  if (c.opts.args) { let k = 0; text = text.replace(/%s/g, () => String(c.opts.args[k++] ?? '')); }
  text = text.replace(/%s/g, '').trim();

  // 1) measure with a throwaway context so we know how long to render
  const probe = new OfflineAudioContext(1, sr, sr);
  const pv = new Vox(probe, probe.destination);
  const est = pv.say(text, c.opts);
  const len = Math.max(1, Math.ceil((est + 1.0) * sr));

  const ctx = new OfflineAudioContext(1, len, sr);
  const vox = new Vox(ctx, ctx.destination);
  seedVox(20260903);
  const dur = vox.say(text, c.opts);
  const buf = await ctx.startRendering();
  const d = buf.getChannelData(0);
  const i16 = new Int16Array(d.length);
  let peak = 0;
  for (let i = 0; i < d.length; i++) {
    const v = d[i];
    if (!Number.isFinite(v)) return { error: 'non-finite sample at ' + i, text };
    const a = Math.abs(v); if (a > peak) peak = a;
    i16[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  }
  let bin = '';
  const bytes = new Uint8Array(i16.buffer);
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return { text, dur, peak, sr, pcm: btoa(bin) };
};
window.__ready = true;
</script>`;
fs.writeFileSync(path.join(OUT, '_page.html'), PAGE);
fs.writeFileSync(path.join(ROOT, 'tools', '_vox-page.html'), PAGE);

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.error('console:', m.text()); });
await page.goto(`http://127.0.0.1:${PORT}/tools/_vox-page.html`);
await page.waitForFunction('window.__ready === true', null, { timeout: 20000 });

let fails = 0;
console.log(`\nrendering ${cases.length} cases at ${SR} Hz into ${OUT}\n`);
for (const c of cases) {
  const r = await page.evaluate(([cc, sr]) => window.__render(cc, sr), [c, SR]);
  if (!r || r.error) { console.log(`  FAIL ${c.id}: ${r && r.error}`); fails++; continue; }

  const bytes = Buffer.from(r.pcm, 'base64');
  const i16 = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2);
  const f = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f[i] = i16[i] / 32768;

  // where does the audible signal actually end?
  const thr = Math.max(1e-4, r.peak * 0.02);
  let last = 0, first = -1;
  for (let i = 0; i < f.length; i++) {
    if (Math.abs(f[i]) > thr) { last = i; if (first < 0) first = i; }
  }
  const audible = (last - Math.max(0, first)) / r.sr;
  const trimmed = f.subarray(0, Math.min(f.length, last + Math.floor(0.05 * r.sr)));

  const wav = path.join(OUT, `${c.id}.wav`);
  const png = path.join(OUT, `${c.id}.png`);
  writeWav(wav, trimmed, r.sr);
  writeSpectrogram(png, trimmed, r.sr, { maxHz: Math.min(+arg('maxhz', 5500), r.sr / 2) });

  // rms over the audible part, as a crude "is it actually speaking" measure
  let acc = 0;
  for (let i = 0; i < trimmed.length; i++) acc += trimmed[i] * trimmed[i];
  const rms = Math.sqrt(acc / Math.max(1, trimmed.length));

  // mean F0 over voiced frames (autocorrelation), so mood presets can be checked
  const f0s = [];
  for (let off = 0; off + 1024 < trimmed.length; off += 512) {
    let e = 0; for (let i = 0; i < 1024; i++) e += trimmed[off + i] * trimmed[off + i];
    if (Math.sqrt(e / 1024) < r.peak * 0.12) continue;
    let best = 0, bestLag = 0;
    const lo = Math.floor(r.sr / 320), hi = Math.floor(r.sr / 55);
    for (let lag = lo; lag <= hi; lag++) {
      let c = 0; for (let i = 0; i + lag < 1024; i++) c += trimmed[off + i] * trimmed[off + i + lag];
      if (c > best) { best = c; bestLag = lag; }
    }
    if (bestLag && best > 0) f0s.push(r.sr / bestLag);
  }
  f0s.sort((a, b) => a - b);
  const f0 = f0s.length ? f0s[Math.floor(f0s.length / 2)] : 0;

  const errPct = Math.abs(audible - r.dur) / r.dur * 100;
  const ok = r.peak < 0.99 && r.peak > 0.02 && errPct <= 15 && rms > 0.005;
  if (!ok) fails++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${c.id.padEnd(16)} say()=${r.dur.toFixed(2)}s ` +
    `audible=${audible.toFixed(2)}s (${errPct.toFixed(1)}%) peak=${r.peak.toFixed(3)} rms=${rms.toFixed(4)} F0=${f0.toFixed(0)}Hz`);
  if (!ok) console.log(`        peak<0.99:${r.peak < 0.99} peak>0.02:${r.peak > 0.02} dur<=15%:${errPct <= 15} rms>0.005:${rms > 0.005}`);
  console.log(`        "${r.text.slice(0, 96)}"`);
}

await browser.close();
server.close();
try { fs.unlinkSync(path.join(ROOT, 'tools', '_vox-page.html')); } catch (e) { /* ignore */ }
console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'}  ${cases.length - fails}/${cases.length} rendered cleanly\n`);
process.exit(fails === 0 ? 0 : 1);
