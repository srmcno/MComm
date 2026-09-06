// png.js - minimal PNG writer so generator code can be eyeballed as an image.
// Input pixels are canvas-order u32 (0xAABBGGRR), matching src/core/pixels.js.
import zlib from 'node:zlib';
import fs from 'node:fs';

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Write w*h canvas-order u32 pixels to an RGBA PNG at `path`. */
export function writePng(path, w, h, u32) {
  const raw = Buffer.alloc(h * (w * 4 + 1));
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const c = u32[y * w + x] >>> 0;
      raw[o++] = c & 255;          // r
      raw[o++] = (c >>> 8) & 255;  // g
      raw[o++] = (c >>> 16) & 255; // b
      raw[o++] = (c >>> 24) & 255; // a
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  fs.writeFileSync(path, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]));
  return path;
}

/**
 * Lay frames out on a grid contact sheet and write it. Frames may differ in size.
 * `frames` is an array of {w,h,data} or [name,{w,h,data}] pairs.
 * `scale` nearest-neighbour magnifies so small sprites are actually visible.
 */
export function writeSheet(path, frames, { cols = 8, scale = 3, pad = 4, bg = 0xff201822 } = {}) {
  const list = frames.map((f) => (Array.isArray(f) ? f[1] : f));
  const cw = Math.max(...list.map((f) => f.w)) * scale + pad * 2;
  const ch = Math.max(...list.map((f) => f.h)) * scale + pad * 2;
  const rows = Math.ceil(list.length / cols);
  const W = cw * cols, H = ch * rows;
  const out = new Uint32Array(W * H).fill(bg >>> 0);
  list.forEach((f, i) => {
    const ox = (i % cols) * cw + pad + ((cw - pad * 2 - f.w * scale) >> 1);
    const oy = Math.floor(i / cols) * ch + pad;
    for (let y = 0; y < f.h * scale; y++) {
      for (let x = 0; x < f.w * scale; x++) {
        const c = f.data[((y / scale) | 0) * f.w + ((x / scale) | 0)] >>> 0;
        if (!(c >>> 24)) continue;
        out[(oy + y) * W + ox + x] = c;
      }
    }
  });
  return writePng(path, W, H, out);
}
