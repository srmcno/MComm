// audio-render.js — renders the soundtrack for real and looks at the result.
//
// The stub in audio-check.js proves the graph is well-formed; it cannot tell you
// whether the music is any good. This drives the actual module inside Chromium's
// Web Audio implementation through an OfflineAudioContext, writes a WAV, and
// draws its own spectrogram (log-frequency, Hann-windowed FFT) so the structure
// can be eyeballed. ffmpeg is not used: the bundled build has no showspectrumpic.
//
//   node tools/audio-render.js [seconds]
//
// Output lands in tools/render/: <name>.wav and <name>.png

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { writePng } from './png.js';

// The globally installed playwright is the one whose Chromium revision matches
// PLAYWRIGHT_BROWSERS_PATH; playwright-core from the repo is the fallback.
const require = createRequire(import.meta.url);
const chromium = await (async () => {
  try { return require('/opt/node22/lib/node_modules/playwright').chromium; } catch (e) { /* not global */ }
  return (await import('playwright-core')).chromium;
})();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'tools', 'render');
const SECONDS = Number(process.argv[2]) || 20;
const SR = 44100;

const JOBS = [
  { name: 'title', track: 'title' },
  { name: 'prowl', track: 'prowl' },
  { name: 'siege-lo', track: 'siege', intensity: 0.15 },
  { name: 'siege-hi', track: 'siege', intensity: 1.0 },
  { name: 'boss', track: 'boss' },
  { name: 'victory', track: 'victory', stinger: 14 },
  { name: 'gameover', track: 'gameover', stinger: 16 },
  { name: 'sfx-montage', sfx: true },
  // prowl -> siege mid-render: proves the cross-fade never stacks two tracks
  { name: 'crossfade', track: 'prowl', switchTo: 'siege', switchAt: 9, fade: 2.5 },
];

/* ----------------------------------------------------------- page script */
// Runs inside Chromium. Drives the sequencer with suspend()/resume() so
// update() sees a real, advancing ctx.currentTime.

const PAGE = `
<!doctype html><meta charset="utf-8"><title>render</title>
<script type="module">
import { Sound } from '/src/audio/synth.js';

const BLOCK = 128 * 16;   // suspend points must land on a 128-sample boundary

async function render(job, seconds, sr) {
  const total = Math.floor(seconds * sr);
  const oc = new OfflineAudioContext(2, total, sr);
  const s = new Sound();
  await s.init(oc);
  s.setMaster(0.85);

  // The montage fires from the clock, exactly like the game would: queueing 50
  // sounds in one frame is what the voice pool exists to throw away.
  const cue = [];
  if (job.sfx) {
    const list = job.list;
    for (let i = 0; i < list.length; i++) {
      cue.push({ at: 0.05 + (i * (seconds - 0.6)) / list.length, name: list[i], pan: (i % 5) / 4 - 0.5 });
    }
  } else {
    s.music(job.track, { fadeIn: 0.6, intensity: job.intensity === undefined ? 0.5 : job.intensity });
  }

  const dt = BLOCK / sr;
  let next = 0, switched = false;
  for (let n = BLOCK; n < total; n += BLOCK) {
    const when = n / sr;
    oc.suspend(when).then(() => {
      if (job.switchTo && !switched && when >= job.switchAt) {
        switched = true;
        s.music(job.switchTo, { fadeIn: job.fade, intensity: 0.85 });
      }
      while (next < cue.length && cue[next].at <= when) {
        s.sfx(cue[next].name, { vol: 1, pan: cue[next].pan });
        next++;
      }
      s.update(dt);
      oc.resume();
    });
  }
  const buf = await oc.startRendering();

  const L = buf.getChannelData(0), R = buf.getChannelData(1);
  let peak = 0, sum = 0, dc = 0, clipped = 0;
  const pcm = new Int16Array(total * 2);
  for (let i = 0; i < total; i++) {
    const l = L[i], r = R[i];
    const a = Math.abs(l) > Math.abs(r) ? Math.abs(l) : Math.abs(r);
    if (a > peak) peak = a;
    if (a > 0.995) clipped++;
    sum += l * l + r * r;
    dc += l + r;
    pcm[i * 2] = Math.max(-32768, Math.min(32767, Math.round(l * 32767)));
    pcm[i * 2 + 1] = Math.max(-32768, Math.min(32767, Math.round(r * 32767)));
  }
  const rms = Math.sqrt(sum / (total * 2));
  // silence check per second, so a track that dies halfway is caught
  const secs = [];
  for (let t = 0; t + sr <= total; t += sr) {
    let m = 0;
    for (let i = t; i < t + sr; i += 7) { const a = Math.abs(L[i]) + Math.abs(R[i]); if (a > m) m = a; }
    secs.push(+m.toFixed(4));
  }
  let bin = '';
  const u8 = new Uint8Array(pcm.buffer);
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) bin += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  const err = s._err ? (s._err.stack || String(s._err)).split(String.fromCharCode(10)).slice(0, 3).join(' | ') : null;
  return { peak, rms, dc: dc / (total * 2), clipped, secs, b64: btoa(bin), frames: total, err };
}

/**
 * sfx() cost. performance.now() is 1 ms-quantised here, so everything is timed
 * over thousands of calls and divided down.
 *
 * The number that actually matters for a shooter is the last one: what a single
 * frame costs when a chain reaction dumps 30 explosions at once. The voice cap
 * is what bounds it — calls past the cap are refused, not built.
 */
async function benchSfx(n) {
  const rapid = ['nailer_fire', 'flak_fire', 'pistol_fire', 'hit_wall', 'hit_flesh',
                 'ricochet', 'footstep_a', 'footstep_b', 'score_tick', 'ui_move',
                 'dryfire', 'airburst_small'];
  const big = ['airburst', 'city_hit', 'roof_open', 'chain5', 'deadman_blow', 'boss_death'];
  const out = { rapid: {}, big: {}, frame: 0 };

  for (const [group, names] of [['rapid', rapid], ['big', big]]) {
    for (const nm of names) {
      // a fresh context per sound: an OfflineAudioContext that is never rendered
      // keeps every dead node, and Chromium's graph bookkeeping slows with it
      const oc = new OfflineAudioContext(2, 44100, 44100);
      const s = new Sound();
      await s.init(oc);
      // Build cost per call including its own teardown: panic every 12 so the
      // pool always has room and every call really allocates. (Hammering a full
      // pool measures the refusal path, which is ~1 us and proves nothing.)
      for (let i = 0; i < 240; i++) { s.sfx(nm); if (i % 12 === 11) s.panic(); }
      const t0 = performance.now();
      for (let i = 0; i < n; i++) { s.sfx(nm); if (i % 12 === 11) s.panic(); }
      out[group][nm] = (performance.now() - t0) / n;
      s.panic();
    }
  }

  // 30 explosions inside one frame, from an empty pool, 200 times over
  const oc = new OfflineAudioContext(2, 44100, 44100);
  const s = new Sound();
  await s.init(oc);
  for (let i = 0; i < 200; i++) { s.sfx('airburst'); for (let k = 0; k < 29; k++) s.sfx('airburst_small'); s.panic(); }
  const t1 = performance.now();
  for (let b = 0; b < 200; b++) {
    s.sfx('airburst');
    for (let k = 0; k < 29; k++) s.sfx('airburst_small');
    s.panic();
  }
  out.frame = (performance.now() - t1) / 200;      // includes the panic teardown
  return out;
}

window.__render = render;
window.__bench = benchSfx;
window.__ready = true;
</script>
`;

/* ------------------------------------------------------------------- WAV */

function writeWav(file, b64, sr) {
  const pcm = Buffer.from(b64, 'base64');
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22);
  h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, pcm]));
  return pcm;
}

/* ------------------------------------------------------------------- FFT */

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

const rgba = (r, g, b) => (255 << 24 | (b & 255) << 16 | (g & 255) << 8 | (r & 255)) >>> 0;

/** Blue -> cyan -> yellow -> white. Reads well on both screens and in a report. */
function heat(v) {
  const t = Math.max(0, Math.min(1, v));
  if (t < 0.25) return rgba(8 + t * 40, 8 + t * 120, 40 + t * 300);
  if (t < 0.5) { const u = (t - 0.25) * 4; return rgba(18, 38 + u * 160, 115 + u * 130); }
  if (t < 0.78) { const u = (t - 0.5) / 0.28; return rgba(18 + u * 230, 198 + u * 50, 245 - u * 200); }
  const u = (t - 0.78) / 0.22;
  return rgba(248, 248, 45 + u * 210);
}

/** Log-frequency spectrogram, 30 Hz .. 16 kHz, dB scaled. */
function spectrogram(pcm, sr, W = 1024, H = 512, N = 2048) {
  const frames = pcm.length / 4;
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    mono[i] = (pcm.readInt16LE(i * 4) + pcm.readInt16LE(i * 4 + 2)) / 65536;
  }
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));

  const hop = Math.max(1, Math.floor((frames - N) / W));
  const cols = new Float32Array(W * H);
  const re = new Float64Array(N), im = new Float64Array(N);
  const F0 = 30, F1 = 16000;
  const logF0 = Math.log(F0), logSpan = Math.log(F1) - logF0;

  for (let x = 0; x < W; x++) {
    const off = x * hop;
    for (let i = 0; i < N; i++) { const s = off + i; re[i] = (s < frames ? mono[s] : 0) * win[i]; im[i] = 0; }
    fft(re, im);
    for (let y = 0; y < H; y++) {
      // each row is a log-spaced band; take the max bin inside it
      const f0 = Math.exp(logF0 + (logSpan * y) / H);
      const f1 = Math.exp(logF0 + (logSpan * (y + 1)) / H);
      let b0 = Math.max(1, Math.round((f0 * N) / sr));
      let b1 = Math.min(N / 2 - 1, Math.round((f1 * N) / sr));
      if (b1 < b0) b1 = b0;
      let m = 0;
      for (let b = b0; b <= b1; b++) {
        const p = re[b] * re[b] + im[b] * im[b];
        if (p > m) m = p;
      }
      // normalise so a full-scale sine reads 0 dB, then show 96 dB of range
      const db = 10 * Math.log10(m + 1e-12) - 20 * Math.log10(N / 4);
      cols[(H - 1 - y) * W + x] = Math.max(0, Math.min(1, (db + 96) / 96));
    }
  }
  const img = new Uint32Array(W * H);
  for (let i = 0; i < img.length; i++) img[i] = heat(cols[i]);

  // reference grid: octaves from 62.5 Hz, and a tick every 5 seconds
  const line = rgba(120, 140, 160);
  for (let f = 62.5; f < F1; f *= 2) {
    const y = H - 1 - Math.round((H * (Math.log(f) - logF0)) / logSpan);
    if (y < 0 || y >= H) continue;
    for (let x = 0; x < W; x += 3) img[y * W + x] = line;
  }
  const secs = frames / sr;
  for (let t = 5; t < secs; t += 5) {
    const x = Math.round((W * t) / secs);
    if (x >= W) continue;
    for (let y = 0; y < H; y += 3) img[y * W + x] = line;
  }
  return { img, W, H };
}

/* ---------------------------------------------------------------- driver */

const SFX_LIST = [
  'flak_fire', 'flak_arm', 'airburst', 'airburst_small', 'nailer_fire', 'nailer_fire',
  'nailer_fire', 'halo_fire', 'deadman_arm', 'deadman_blow', 'pistol_fire', 'dryfire',
  'reload', 'weapon_switch', 'hit_wall', 'hit_flesh', 'ricochet', 'barrel_explode',
  'door_open', 'door_locked', 'secret_found', 'pickup_treasure', 'pickup_key',
  'elevator', 'roof_open', 'alarm', 'wrencher_alert', 'sparker_fire', 'bellows_flame',
  'wasp_buzz', 'priest_chant', 'enemy_die', 'boss_roar', 'boss_death',
  'warhead_launch', 'warhead_incoming', 'mirv_split', 'smart_evade', 'city_hit',
  'city_lost_sting', 'wave_start', 'chain2', 'chain3', 'chain4', 'chain5',
  'perfect_burst', 'ui_start', 'countdown', 'player_hurt', 'player_die', 'heartbeat',
  'footstep_a', 'footstep_b',
];

const MIME = { '.js': 'text/javascript', '.html': 'text/html' };

async function serve() {
  const srv = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); return;
    }
    const file = path.join(ROOT, path.normalize(url).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('no'); return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'text/plain' });
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, port: srv.address().port };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const { srv, port } = await serve();
  const browser = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.error('console:', m.text()); });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction('window.__ready === true', null, { timeout: 20000 });

  let fail = 0, pass = 0;
  const rows = [];
  for (const job of JOBS) {
    const t0 = Date.now();
    const r = await page.evaluate(
      ([j, sec, sr]) => window.__render(j, sec, sr),
      [{ ...job, list: SFX_LIST }, SECONDS, SR],
    );
    const wavPath = path.join(OUT, `${job.name}.wav`);
    const pcm = writeWav(wavPath, r.b64, SR);
    const { img, W, H } = spectrogram(pcm, SR);
    writePng(path.join(OUT, `${job.name}.png`), W, H, img);

    // a non-looping stinger is allowed to stop; only the part before its end counts
    const window = job.stinger ? Math.min(r.secs.length, job.stinger) : r.secs.length;
    const quiet = r.secs.slice(0, window).filter((v) => v < 0.02).length;
    const musical = job.sfx ? r.rms > 0.02 : r.rms >= 0.05 && r.rms <= 0.3;
    const checks = [
      [r.peak < 0.99, `peak ${r.peak.toFixed(3)} < 0.99`],
      [musical, `rms ${r.rms.toFixed(3)}${job.sfx ? '' : ' in 0.05..0.30'}`],
      [Math.abs(r.dc) < 0.01, `dc ${r.dc.toFixed(5)}`],
      [r.clipped < SR * 0.001, `clipped ${r.clipped}`],
      [quiet === 0, `silent seconds ${quiet}`],
    ];
    const bad = checks.filter((c) => !c[0]);
    if (bad.length) fail++; else pass++;
    rows.push({
      name: job.name, peak: r.peak, rms: r.rms, dc: r.dc, quiet,
      ms: Date.now() - t0, bad: bad.map((b) => b[1]),
    });
    console.log(
      `${bad.length ? 'FAIL' : 'PASS'}  ${job.name.padEnd(12)} ` +
      `peak ${r.peak.toFixed(3)}  rms ${r.rms.toFixed(3)}  dc ${r.dc.toFixed(5)}  ` +
      `clip ${r.clipped}  quiet-s ${quiet}  ${((Date.now() - t0) / 1000).toFixed(1)}s` +
      (bad.length ? `\n      -> ${bad.map((b) => b[1]).join(', ')}` : ''),
    );
    if (r.err) console.log(`      ERR ${r.err}`);
    console.log(`      env ${r.secs.map((v) => '.:-=+*#%@'[Math.min(8, Math.floor(v * 9))] || '@').join('')}`);
  }

  const bench = await page.evaluate(() => window.__bench(4000));
  console.log('\n-- sfx() cost per call, build + teardown --');
  let slow = 0;
  for (const [k, v] of Object.entries(bench.rapid)) {
    const bad = v > 0.3;
    if (bad) slow++;
    console.log(`${bad ? 'FAIL' : 'PASS'}  ${k.padEnd(15)} ${v.toFixed(4)} ms   (budget 0.3)`);
  }
  console.log('   the set-piece sounds, which fire at most a few times a second:');
  for (const [k, v] of Object.entries(bench.big)) console.log(`        ${k.padEnd(15)} ${v.toFixed(4)} ms`);
  const frameBad = bench.frame > 6;
  if (frameBad) slow++;
  console.log(`${frameBad ? 'FAIL' : 'PASS'}  30-explosion frame + teardown ${bench.frame.toFixed(3)} ms   (budget 6.0)`);
  if (slow) fail += slow; else pass++;

  await browser.close();
  srv.close();
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(rows, null, 2));
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} ok, ${fail} bad  (wav + png in tools/render/)`);
  if (fail) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
