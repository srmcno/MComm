// skybox.js - the dusk dome the whole Missile Command layer happens against.
//
// Two equirectangular layers indexed by (azimuth, elevation): an opaque `base`
// carrying the gradient, stars, moon, haze and the six horizon cities, and a
// `cloud` layer with alpha that the renderer scrolls at two speeds for parallax.
// The cities live in the dome rather than in the world so a player standing on a
// silo deck can see them over the parapet without a portal renderer.

import { rgba, mix, clamp, lerp, makeRng, fbm } from '../core/pixels.js';

export const SKY_W = 1024;
export const SKY_H = 512;
export const ELEV_MIN = -0.42;
export const ELEV_MAX = Math.PI / 2;

// Where each city sits on the compass, in radians. Deliberately uneven so the
// horizon never looks like a clock face.
export const CITY_AZIMUTH = [0.35, 1.28, 2.35, 3.31, 4.36, 5.35];
export const CITY_NAMES = ['VERITY', 'ASHGROVE', 'LOW SABBATH', 'CANDLEMARK', 'HOLLOW BAY', 'SAINT ERROL'];
// How many dome rows a city occupies. SKY_H rows span ELEV_MIN..ELEV_MAX.
const CITY_DOME_H = 58;

const SUN_AZ = 4.05;   // the dying sun, behind LOW SABBATH / HOLLOW BAY

function elevToRow(e) {
  return clamp((e - ELEV_MIN) / (ELEV_MAX - ELEV_MIN), 0, 1) * (SKY_H - 1);
}
function rowToElev(v) {
  return ELEV_MIN + (v / (SKY_H - 1)) * (ELEV_MAX - ELEV_MIN);
}

export class Sky {
  constructor(vmFrames) {
    this.w = SKY_W;
    this.h = SKY_H;
    this.base = new Uint32Array(SKY_W * SKY_H);
    this.cloud = new Uint32Array(SKY_W * SKY_H);
    this.elevMin = ELEV_MIN;
    this.elevMax = ELEV_MAX;
    this.vm = vmFrames || {};
    this.palette = 'dusk';
    this._gradient = new Uint32Array(SKY_W * SKY_H);
    this.buildGradient();
    this.buildClouds();
  }

  /** Palettes shift per level so each act of the game has its own sky. */
  setPalette(name) {
    if (this.palette === name) return;
    this.palette = name;
    this._gen = (this._gen || 0) + 1;
    this.buildGradient();
  }

  _pal() {
    switch (this.palette) {
      case 'night':  return { zen: [6, 8, 24], mid: [16, 20, 52], hor: [58, 44, 84],
                              glow: [140, 96, 150], haze: [30, 30, 58], star: 1.0, sun: 0.35 };
      case 'ash':    return { zen: [22, 18, 26], mid: [58, 40, 40], hor: [126, 74, 54],
                              glow: [206, 120, 62], haze: [92, 62, 52], star: 0.25, sun: 0.8 };
      case 'furnace':return { zen: [30, 10, 14], mid: [86, 20, 20], hor: [188, 62, 34],
                              glow: [255, 148, 58], haze: [126, 48, 34], star: 0.1, sun: 1.0 };
      case 'terminal':return{ zen: [10, 4, 20], mid: [44, 10, 44], hor: [140, 30, 62],
                              glow: [255, 90, 90], haze: [78, 26, 50], star: 0.5, sun: 0.9 };
      default:       return { zen: [10, 12, 34], mid: [38, 34, 74], hor: [128, 82, 92],
                              glow: [242, 148, 84], haze: [72, 58, 74], star: 0.7, sun: 0.75 };
    }
  }

  buildGradient() {
    const p = this._pal();
    const g = this._gradient;
    const rng = makeRng(0x51c0);
    // Vertical gradient with a warm bloom around the setting sun's azimuth.
    for (let y = 0; y < SKY_H; y++) {
      const e = rowToElev(y);
      const t = clamp((e - ELEV_MIN) / (ELEV_MAX - ELEV_MIN), 0, 1);
      // Two-stop ramp: horizon -> mid -> zenith, eased so the horizon band is thin.
      const tt = Math.pow(t, 0.62);
      let cr, cg, cb;
      if (tt < 0.34) {
        const k = tt / 0.34;
        cr = lerp(p.hor[0], p.mid[0], k); cg = lerp(p.hor[1], p.mid[1], k); cb = lerp(p.hor[2], p.mid[2], k);
      } else {
        const k = (tt - 0.34) / 0.66;
        cr = lerp(p.mid[0], p.zen[0], k); cg = lerp(p.mid[1], p.zen[1], k); cb = lerp(p.mid[2], p.zen[2], k);
      }
      for (let x = 0; x < SKY_W; x++) {
        const az = (x / SKY_W) * Math.PI * 2;
        let d = Math.abs(((az - SUN_AZ + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        // Sun glow: strong near the horizon, decaying with angular distance.
        const glow = Math.exp(-d * d * 1.5) * Math.exp(-Math.max(0, e) * 3.4) * p.sun;
        let r = cr + p.glow[0] * glow * 0.85;
        let gg = cg + p.glow[1] * glow * 0.7;
        let b = cb + p.glow[2] * glow * 0.5;
        // Banding-killing dither; the eye reads this as film grain, not noise.
        const d2 = (rng() - 0.5) * 1.7;
        g[y * SKY_W + x] = rgba(clamp(r + d2, 0, 255), clamp(gg + d2, 0, 255), clamp(b + d2, 0, 255), 255);
      }
    }
    this._stars(g, p);
    this._moon(g, p);
    this.rebuild();
  }

  _stars(g, p) {
    if (p.star <= 0.01) return;
    const rng = makeRng(0xbeef11);
    const n = (1600 * p.star) | 0;
    for (let i = 0; i < n; i++) {
      const x = (rng() * SKY_W) | 0;
      const e = ELEV_MIN + Math.pow(rng(), 0.55) * (ELEV_MAX - ELEV_MIN);
      const y = elevToRow(e) | 0;
      // Stars wash out toward the horizon and near the sun.
      const alt = clamp((e - 0.12) / 1.2, 0, 1);
      let az = (x / SKY_W) * Math.PI * 2;
      const dsun = Math.abs(((az - SUN_AZ + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      const vis = alt * clamp(dsun / 2.2, 0.15, 1) * p.star;
      if (vis < 0.06) continue;
      const b = 120 + rng() * 135;
      const warm = rng();
      const c = rgba(b * (0.85 + warm * 0.2), b * 0.92, b * (1.0 - warm * 0.12), 255);
      const o = y * SKY_W + x;
      g[o] = mix(g[o], c, vis * (0.5 + rng() * 0.5));
      if (rng() < 0.1) {            // a few bright ones get a cross flare
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const xx = (x + dx + SKY_W) % SKY_W, yy = clamp(y + dy, 0, SKY_H - 1);
          const oo = yy * SKY_W + xx;
          g[oo] = mix(g[oo], c, vis * 0.3);
        }
      }
    }
  }

  _moon(g, p) {
    const mx = ((1.9 / (Math.PI * 2)) * SKY_W) | 0;
    const my = elevToRow(0.86) | 0;
    const R = 26;
    for (let dy = -R - 3; dy <= R + 3; dy++) {
      for (let dx = -R - 3; dx <= R + 3; dx++) {
        const d = Math.hypot(dx, dy);
        const x = (mx + dx + SKY_W) % SKY_W, y = clamp(my + dy, 0, SKY_H - 1);
        const o = y * SKY_W + x;
        if (d <= R) {
          // Crater mottling plus a terminator so it reads as a sphere.
          const n = fbm(0x1121, (dx + R) / 9, (dy + R) / 9, 4, 8);
          const lightSide = clamp(0.35 + (-dx * 0.5 - dy * 0.35) / R * 0.9, 0, 1);
          const b = 150 + n * 55;
          const v = b * (0.42 + lightSide * 0.7);
          g[o] = mix(g[o], rgba(v * 1.02, v * 0.99, v * 0.9, 255), clamp(0.95 - n * 0.2, 0, 1));
        } else {
          const halo = Math.exp(-(d - R) * 0.28) * 0.5;
          if (halo > 0.01) g[o] = mix(g[o], rgba(190, 190, 205, 255), halo);
        }
      }
    }
  }

  buildClouds() {
    const c = this.cloud;
    c.fill(0);
    const rng = makeRng(0x9931);
    for (let y = 0; y < SKY_H; y++) {
      const e = rowToElev(y);
      // Cloud decks live in a band above the horizon and thin out at the zenith.
      const band = Math.exp(-Math.pow((e - 0.16) / 0.30, 2)) * 0.95 +
                   Math.exp(-Math.pow((e - 0.62) / 0.42, 2)) * 0.4;
      if (band < 0.02) continue;
      for (let x = 0; x < SKY_W; x++) {
        // fbm on a torus in x keeps the wrap seamless as it scrolls.
        const u = (x / SKY_W) * 8;
        const n = fbm(0x77aa, u, e * 5.5 + 3, 5, 8);
        let a = (n - 0.52) * 3.4 * band;
        if (a <= 0.02) continue;
        a = clamp(a, 0, 1);
        // Lit tops, shadowed bellies.
        const top = clamp((n - 0.52) * 3.0, 0, 1);
        const r = lerp(52, 214, top), g2 = lerp(46, 168, top), b = lerp(66, 158, top);
        c[y * SKY_W + x] = rgba(r, g2, b, a * 168);
      }
    }
  }

  /**
   * Recomposite the cities onto the gradient. Cheap enough to call whenever a
   * city's condition changes, which is rare and dramatic.
   * @param {Array} cities [{alive, burning, hitAt}] or null before the game starts
   */
  rebuild(cities) {
    this._gen = (this._gen || 0) + 1;
    this.base.set(this._gradient);
    this._haze();
    this.cities = cities || this.cities;
    if (!this.cities) return;
    for (let i = 0; i < this.cities.length; i++) {
      const st = this.cities[i];
      const key = !st.alive ? `city${i}_dead` : st.burning ? `city${i}_hit` : `city${i}`;
      const f = this.vm[key] || this.vm[`city${i}`];
      if (!f) continue;
      this._blitCity(f, CITY_AZIMUTH[i], st);
    }
  }

  _haze() {
    // A dense band right on the horizon: distance haze that the cities sit inside.
    const p = this._pal();
    const y0 = elevToRow(ELEV_MIN) | 0, y1 = elevToRow(0.20) | 0;
    for (let y = y0; y <= y1; y++) {
      const e = rowToElev(y);
      const a = clamp(1 - Math.abs(e) / 0.20, 0, 1);
      const aa = Math.pow(a, 1.7) * 0.55;
      if (aa < 0.01) continue;
      const hz = rgba(p.haze[0], p.haze[1], p.haze[2], 255);
      for (let x = 0; x < SKY_W; x++) {
        const o = y * SKY_W + x;
        this.base[o] = mix(this.base[o], hz, aa);
      }
    }
  }

  /**
   * Paint a city onto the dome, standing on the horizon.
   *
   * Two things to keep straight: dome row 0 is the LOWEST elevation, so the
   * sprite has to be flipped vertically, and the sprite is far larger than a
   * city should subtend, so it is scaled down to a readable angular size —
   * about 23 degrees wide and 10 tall, which is generous but you need to know
   * at a glance which city a warhead has picked.
   */
  _blitCity(f, az, st) {
    const dh = CITY_DOME_H;
    const dw = Math.max(8, Math.round(dh * (f.w / f.h)));
    const cx = ((az / (Math.PI * 2)) * SKY_W) | 0;
    const baseRow = elevToRow(0.004) | 0;
    const x0 = cx - (dw >> 1);
    const sx = f.w / dw, sy = f.h / dh;
    for (let y = 0; y < dh; y++) {
      const ty = baseRow + y;                       // up the dome = up the city
      if (ty < 0 || ty >= SKY_H) continue;
      const srcY = Math.min(f.h - 1, ((dh - 1 - y) * sy) | 0);
      const srcRow = srcY * f.w;
      const dstRow = ty * SKY_W;
      for (let x = 0; x < dw; x++) {
        const s = f.data[srcRow + Math.min(f.w - 1, (x * sx) | 0)];
        const a = s >>> 24;
        if (!a) continue;
        const tx = ((x0 + x) % SKY_W + SKY_W) % SKY_W;
        const o = dstRow + tx;
        this.base[o] = a === 255 ? (s >>> 0) : mix(this.base[o], (s | (255 << 24)) >>> 0, a / 255);
      }
    }
  }

  /**
   * Base + both cloud decks flattened into one lookup table.
   *
   * Compositing two alpha layers per sky pixel per frame is the single most
   * expensive thing the renderer can do when you're staring at open sky. The
   * decks only scroll a couple of texels a second, so we flatten once and reuse
   * the result until a shift actually changes.
   */
  composite(shiftA, shiftB) {
    const a = shiftA | 0, b = shiftB | 0;
    if (this._comp && this._compA === a && this._compB === b && this._compGen === this._gen) {
      return this._comp;
    }
    if (!this._comp) this._comp = new Uint32Array(SKY_W * SKY_H);
    const out = this._comp, base = this.base, cloud = this.cloud;
    for (let y = 0; y < SKY_H; y++) {
      const row = y * SKY_W;
      for (let x = 0; x < SKY_W; x++) {
        let px = base[row + x];
        const k1 = cloud[row + ((x - a) & (SKY_W - 1))];
        const a1 = k1 >>> 24;
        if (a1) {
          const t = a1 / 255;
          const r = (px & 255) + (((k1 & 255) - (px & 255)) * t);
          const g = ((px >>> 8) & 255) + ((((k1 >>> 8) & 255) - ((px >>> 8) & 255)) * t);
          const bl = ((px >>> 16) & 255) + ((((k1 >>> 16) & 255) - ((px >>> 16) & 255)) * t);
          px = (255 << 24 | (bl | 0) << 16 | (g | 0) << 8 | (r | 0)) >>> 0;
        }
        const k2 = cloud[row + ((x - b) & (SKY_W - 1))];
        const a2 = (k2 >>> 24) * 0.5;
        if (a2 > 2) {
          const t = a2 / 255;
          const r = (px & 255) + (((k2 & 255) - (px & 255)) * t);
          const g = ((px >>> 8) & 255) + ((((k2 >>> 8) & 255) - ((px >>> 8) & 255)) * t);
          const bl = ((px >>> 16) & 255) + ((((k2 >>> 16) & 255) - ((px >>> 16) & 255)) * t);
          px = (255 << 24 | (bl | 0) << 16 | (g | 0) << 8 | (r | 0)) >>> 0;
        }
        out[row + x] = px;
      }
    }
    this._compA = a; this._compB = b; this._compGen = this._gen;
    return out;
  }

  /** Screen-space azimuth of a city, for HUD threat arrows. */
  cityAzimuth(i) { return CITY_AZIMUTH[i]; }
}
