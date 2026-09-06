// text.js - rasterises strings once on a scratch 2D canvas and caches them as
// pixel buffers, so the HUD can be blitted straight into the software
// framebuffer and live inside the CRT effect with everything else.

import { rgba, clamp } from '../core/pixels.js';

const FAMILY = '"SF Mono", ui-monospace, Menlo, Consolas, "DejaVu Sans Mono", monospace';
const DISPLAY = '"Impact", "Haettenschweiler", "Arial Narrow Bold", system-ui, sans-serif';

export class Text {
  constructor() {
    this.cache = new Map();
    this.canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
    this.ctx = this.canvas ? this.canvas.getContext('2d', { willReadFrequently: true }) : null;
    this.budget = 900;
  }

  _key(str, o) {
    return `${str}|${o.size}|${o.weight}|${o.display ? 1 : 0}|${o.track}|${o.crisp}|${o.italic ? 1 : 0}`;
  }

  /**
   * @returns {{w,h,data:Uint32Array,base:number}} white glyphs with real alpha
   */
  raster(str, opts = {}) {
    const o = {
      size: opts.size || 12,
      weight: opts.weight || 700,
      display: !!opts.display,
      track: opts.track === undefined ? 0 : opts.track,
      crisp: opts.crisp === undefined ? 0.45 : opts.crisp,
      italic: !!opts.italic,
    };
    const key = this._key(str, o);
    const hit = this.cache.get(key);
    if (hit) { hit.used = this._tick; return hit; }
    if (!this.ctx) return { w: 0, h: 0, data: new Uint32Array(0), base: 0 };

    const ctx = this.ctx;
    const font = `${o.italic ? 'italic ' : ''}${o.weight} ${o.size}px ${o.display ? DISPLAY : FAMILY}`;
    ctx.font = font;
    const chars = [...str];
    let w = 0;
    for (const c of chars) w += ctx.measureText(c).width + o.track;
    w = Math.ceil(w) + 4;
    const h = Math.ceil(o.size * 1.42) + 4;
    if (this.canvas.width < w || this.canvas.height < h) {
      this.canvas.width = Math.max(this.canvas.width, w, 64);
      this.canvas.height = Math.max(this.canvas.height, h, 64);
    }
    ctx.clearRect(0, 0, w, h);
    ctx.font = font;
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'alphabetic';
    const base = Math.round(o.size * 1.06) + 2;
    let x = 2;
    for (const c of chars) {
      ctx.fillText(c, x, base);
      x += ctx.measureText(c).width + o.track;
    }
    const img = ctx.getImageData(0, 0, w, h);
    const data = new Uint32Array(w * h);
    const cut = o.crisp;
    for (let i = 0; i < w * h; i++) {
      let a = img.data[i * 4 + 3] / 255;
      if (cut > 0) a = a >= cut ? 1 : (a >= cut * 0.55 ? 0.55 : 0);
      if (a <= 0) continue;
      data[i] = rgba(255, 255, 255, a * 255);
    }
    const entry = { w, h, data, base, used: this._tick };
    this.cache.set(key, entry);
    if (this.cache.size > this.budget) {
      // Drop the least recently used third rather than thrashing every frame.
      const ents = [...this.cache.entries()].sort((a, b) => (a[1].used || 0) - (b[1].used || 0));
      for (let i = 0; i < ents.length / 3; i++) this.cache.delete(ents[i][0]);
    }
    return entry;
  }

  frameTick(t) { this._tick = t; }

  measure(str, opts) { const r = this.raster(str, opts); return { w: r.w - 4, h: r.h }; }

  /**
   * Blit text into a u32 framebuffer.
   * @param {object} opts {size,weight,display,track,color,alpha,align:'left'|'center'|'right',
   *                       shadow, shadowColor, glow, glowColor, outline}
   */
  draw(buf, W, H, x, y, str, opts = {}) {
    if (!str) return 0;
    const r = this.raster(str, opts);
    if (!r.w) return 0;
    const color = opts.color === undefined ? 0xffffffff : opts.color;
    const alpha = opts.alpha === undefined ? 1 : opts.alpha;
    if (alpha <= 0.004) return r.w - 4;
    const align = opts.align || 'left';
    let ox = x - 2;
    if (align === 'center') ox = x - (r.w - 4) / 2 - 2;
    else if (align === 'right') ox = x - (r.w - 4) - 2;
    const oy = y - r.base;

    if (opts.glow) {
      const gc = opts.glowColor === undefined ? color : opts.glowColor;
      const g = opts.glow;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const d = Math.hypot(dx, dy);
          if (d < 0.5 || d > 2.3) continue;
          this._blit(buf, W, H, r, ox + dx, oy + dy, gc, alpha * g * (1 - d / 2.6) * 0.5, true);
        }
      }
    }
    if (opts.outline) {
      const oc = opts.outlineColor === undefined ? rgba(0, 0, 0, 255) : opts.outlineColor;
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        this._blit(buf, W, H, r, ox + dx, oy + dy, oc, alpha, false);
      }
    } else if (opts.shadow !== false) {
      const sc = opts.shadowColor === undefined ? rgba(0, 0, 0, 255) : opts.shadowColor;
      this._blit(buf, W, H, r, ox + 1, oy + 1, sc, alpha * 0.85, false);
    }
    this._blit(buf, W, H, r, ox, oy, color, alpha, false);
    return r.w - 4;
  }

  _blit(buf, W, H, r, ox, oy, color, alpha, additive) {
    ox = Math.round(ox); oy = Math.round(oy);
    const cr = color & 255, cg = (color >>> 8) & 255, cb = (color >>> 16) & 255;
    const ca = ((color >>> 24) & 255) / 255;
    const y0 = Math.max(0, -oy), y1 = Math.min(r.h, H - oy);
    const x0 = Math.max(0, -ox), x1 = Math.min(r.w, W - ox);
    for (let y = y0; y < y1; y++) {
      const src = y * r.w, dst = (oy + y) * W + ox;
      for (let x = x0; x < x1; x++) {
        const s = r.data[src + x];
        const sa = (s >>> 24);
        if (!sa) continue;
        const a = (sa / 255) * alpha * ca;
        const o = dst + x;
        const d = buf[o];
        let dr = d & 255, dg = (d >>> 8) & 255, db = (d >>> 16) & 255;
        if (additive) { dr += cr * a; dg += cg * a; db += cb * a; }
        else { dr += (cr - dr) * a; dg += (cg - dg) * a; db += (cb - db) * a; }
        buf[o] = (255 << 24 | (db > 255 ? 255 : db) << 16 | (dg > 255 ? 255 : dg) << 8 | (dr > 255 ? 255 : dr)) >>> 0;
      }
    }
  }
}

// ---------------------------------------------------------------- primitives

export function fillRectBuf(buf, W, H, x, y, w, h, color, alpha = 1) {
  x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
  const cr = color & 255, cg = (color >>> 8) & 255, cb = (color >>> 16) & 255;
  const ca = ((color >>> 24) & 255) / 255 * alpha;
  if (ca <= 0.003) return;
  const x0 = Math.max(0, x), x1 = Math.min(W, x + w);
  const y0 = Math.max(0, y), y1 = Math.min(H, y + h);
  for (let yy = y0; yy < y1; yy++) {
    const row = yy * W;
    for (let xx = x0; xx < x1; xx++) {
      const o = row + xx;
      const d = buf[o];
      const dr = d & 255, dg = (d >>> 8) & 255, db = (d >>> 16) & 255;
      buf[o] = (255 << 24 |
        ((db + (cb - db) * ca) | 0) << 16 |
        ((dg + (cg - dg) * ca) | 0) << 8 |
        ((dr + (cr - dr) * ca) | 0)) >>> 0;
    }
  }
}

export function addRectBuf(buf, W, H, x, y, w, h, color, alpha = 1) {
  x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
  const cr = (color & 255) * alpha, cg = ((color >>> 8) & 255) * alpha, cb = ((color >>> 16) & 255) * alpha;
  const x0 = Math.max(0, x), x1 = Math.min(W, x + w);
  const y0 = Math.max(0, y), y1 = Math.min(H, y + h);
  for (let yy = y0; yy < y1; yy++) {
    const row = yy * W;
    for (let xx = x0; xx < x1; xx++) {
      const o = row + xx, d = buf[o];
      const r = (d & 255) + cr, g = ((d >>> 8) & 255) + cg, b = ((d >>> 16) & 255) + cb;
      buf[o] = (255 << 24 | (b > 255 ? 255 : b) << 16 | (g > 255 ? 255 : g) << 8 | (r > 255 ? 255 : r)) >>> 0;
    }
  }
}

export function lineBuf(buf, W, H, x0, y0, x1, y1, color, alpha = 1, additive = false) {
  x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy, guard = 0;
  const f = additive ? addRectBuf : fillRectBuf;
  for (;;) {
    f(buf, W, H, x0, y0, 1, 1, color, alpha);
    if ((x0 === x1 && y0 === y1) || guard++ > 4000) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

export function circleBuf(buf, W, H, cx, cy, r, color, alpha = 1, additive = false, thickness = 1) {
  const f = additive ? addRectBuf : fillRectBuf;
  const steps = Math.max(12, Math.ceil(r * 6));
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    f(buf, W, H, cx + Math.cos(a) * r - thickness / 2, cy + Math.sin(a) * r - thickness / 2,
      thickness, thickness, color, alpha);
  }
}

/** Blit an arbitrary sprite frame into the framebuffer (HUD icons, viewmodels). */
export function blitFrame(buf, W, H, f, ox, oy, opts = {}) {
  if (!f) return;
  const scale = opts.scale || 1;
  const alpha = opts.alpha === undefined ? 1 : opts.alpha;
  if (alpha <= 0.004) return;
  const additive = !!opts.additive;
  const tint = opts.tint || 0;
  const tr = tint & 255, tg = (tint >>> 8) & 255, tb = (tint >>> 16) & 255;
  const ta = ((tint >>> 24) & 255) / 255;
  const lum = opts.lum === undefined ? 1 : opts.lum;
  const dw = Math.round(f.w * scale), dh = Math.round(f.h * scale);
  ox = Math.round(ox); oy = Math.round(oy);
  const x0 = Math.max(0, -ox), x1 = Math.min(dw, W - ox);
  const y0 = Math.max(0, -oy), y1 = Math.min(dh, H - oy);
  const ix = f.w / dw, iy = f.h / dh;
  for (let y = y0; y < y1; y++) {
    const sy = (y * iy) | 0;
    const dst = (oy + y) * W + ox;
    const src = sy * f.w;
    for (let x = x0; x < x1; x++) {
      const s = f.data[src + ((x * ix) | 0)];
      const sa = s >>> 24;
      if (!sa) continue;
      let r = (s & 255), g = (s >>> 8) & 255, b = (s >>> 16) & 255;
      if (ta) { r += (tr - r) * ta; g += (tg - g) * ta; b += (tb - b) * ta; }
      r *= lum; g *= lum; b *= lum;
      const a = (sa / 255) * alpha;
      const o = dst + x, d = buf[o];
      let dr = d & 255, dg = (d >>> 8) & 255, db = (d >>> 16) & 255;
      if (additive) { dr += r * a; dg += g * a; db += b * a; }
      else { dr += (r - dr) * a; dg += (g - dg) * a; db += (b - db) * a; }
      buf[o] = (255 << 24 | (db > 255 ? 255 : db) << 16 | (dg > 255 ? 255 : dg) << 8 | (dr > 255 ? 255 : dr)) >>> 0;
    }
  }
}
