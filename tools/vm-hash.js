// vm-hash.js - one deterministic fingerprint for a frame's pixel data.
//
// Two independent FNV-1a-style rolls over the raw u32 words, concatenated for
// 64 bits of signal. Pure JS on purpose: the regression check should depend on
// nothing but the art module itself.

/** @param {Uint32Array} u32 @returns {string} 16 hex chars */
export function frameHash(u32) {
  let a = 0x811c9dc5 >>> 0, b = 0x01000193 >>> 0;
  for (let i = 0; i < u32.length; i++) {
    const v = u32[i] >>> 0;
    a = Math.imul(a ^ (v & 0xffff), 16777619) >>> 0;
    a = Math.imul(a ^ (v >>> 16), 16777619) >>> 0;
    b = Math.imul(b + (v ^ i), 2246822519) >>> 0;
    b = ((b << 13) | (b >>> 19)) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}
