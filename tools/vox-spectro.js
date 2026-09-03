// vox-spectro.js — STFT spectrogram + waveform PNGs for rendered speech.
// (The bundled Playwright ffmpeg is a stripped build with no showspectrumpic,
// so we draw our own. Output is canvas-order u32, written by tools/png.js.)
import fs from 'node:fs';
import { writePng } from './png.js';

/* iterative radix-2 FFT, in place, re/im Float64Array of length n (pow2) */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

const rgba = (r, g, b) => (255 << 24 | (b & 255) << 16 | (g & 255) << 8 | (r & 255)) >>> 0;

/** black → purple → red → orange → white; formant bands pop out of it. */
function heat(t) {
  t = Math.max(0, Math.min(1, t));
  const stops = [
    [0, 0, 0], [22, 8, 60], [88, 12, 110], [170, 32, 88],
    [232, 82, 40], [252, 168, 44], [255, 240, 170], [255, 255, 255],
  ];
  const x = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const a = stops[i], b = stops[i + 1];
  return rgba(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f);
}

/**
 * Render `samples` to a spectrogram PNG with a waveform strip underneath.
 * maxHz caps the frequency axis; gridlines every 1 kHz (brighter every 2 kHz).
 */
export function writeSpectrogram(path, samples, sampleRate, {
  width = 1400, height = 560, waveH = 110, fftSize = 1024, maxHz = 8000, floorDb = -46,
} = {}) {
  const N = fftSize;
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));

  const bins = Math.min(N / 2, Math.ceil((maxHz / (sampleRate / 2)) * (N / 2)));
  const cols = width;
  const hop = Math.max(1, Math.floor((samples.length - N) / Math.max(1, cols - 1)));
  const mag = new Float32Array(cols * bins);

  let peakDb = -Infinity;
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let c = 0; c < cols; c++) {
    const off = c * hop;
    for (let i = 0; i < N; i++) {
      const s = off + i < samples.length ? samples[off + i] : 0;
      re[i] = s * win[i]; im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < bins; k++) {
      const m = Math.sqrt(re[k] * re[k] + im[k] * im[k]) / (N / 4);
      const db = 20 * Math.log10(m + 1e-12);
      mag[c * bins + k] = db;
      if (db > peakDb) peakDb = db;
    }
  }
  if (!Number.isFinite(peakDb)) peakDb = 0;

  const specH = height - waveH;
  const out = new Uint32Array(width * height).fill(rgba(8, 8, 12));

  for (let x = 0; x < width; x++) {
    for (let y = 0; y < specH; y++) {
      // y=0 is the top = maxHz
      const fr = 1 - y / (specH - 1);
      const k = Math.min(bins - 1, Math.round(fr * (bins - 1)));
      const db = mag[x * bins + k];
      const t = Math.pow(Math.max(0, (db - (peakDb + floorDb)) / (-floorDb)), 1.9);
      out[y * width + x] = heat(t);
    }
  }
  // frequency gridlines
  const hzTop = (bins - 1) * (sampleRate / N);
  for (let hz = 1000; hz < hzTop; hz += 1000) {
    const y = Math.round((1 - hz / hzTop) * (specH - 1));
    if (y < 0 || y >= specH) continue;
    const bright = hz % 2000 === 0;
    const tick = bright ? 26 : 12;
    for (let x = 0; x < width; x++) {
      if (x < tick || (bright && x % 80 < 2)) {
        const p = y * width + x;
        out[p] = rgba(120, 200, 255);
      }
    }
  }
  // waveform strip
  const wy0 = specH + 2;
  const mid = wy0 + (waveH - 4) / 2;
  for (let x = 0; x < width; x++) {
    const a = Math.floor((x / width) * samples.length);
    const b = Math.floor(((x + 1) / width) * samples.length);
    let lo = 0, hi = 0;
    for (let i = a; i < b && i < samples.length; i++) {
      if (samples[i] < lo) lo = samples[i];
      if (samples[i] > hi) hi = samples[i];
    }
    const y0 = Math.round(mid - hi * (waveH - 6) / 2);
    const y1 = Math.round(mid - lo * (waveH - 6) / 2);
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
      if (y >= wy0 && y < height) out[y * width + x] = rgba(90, 240, 150);
    }
    out[Math.round(mid) * width + x] = rgba(40, 90, 60);
  }
  // 100 ms time ticks along the bottom of the spectrogram
  const dur = samples.length / sampleRate;
  for (let t = 0.1; t < dur; t += 0.1) {
    const x = Math.round((t / dur) * (width - 1));
    const h = Math.abs(t % 0.5) < 0.02 || Math.abs((t % 0.5) - 0.5) < 0.02 ? 14 : 7;
    for (let y = specH - h; y < specH; y++) out[y * width + x] = rgba(150, 150, 170);
  }
  writePng(path, width, height, out);
  return path;
}

/** 16-bit mono WAV. */
export function writeWav(path, samples, sampleRate) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  fs.writeFileSync(path, buf);
  return path;
}
