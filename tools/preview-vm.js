// preview-vm.js - render every viewmodel frame to PNGs and run structural
// self-checks. Run: node tools/preview-vm.js
import fs from 'node:fs';
import path from 'node:path';
import { writePng, writeSheet } from './png.js';
import { buildViewmodels } from '../src/engine/viewmodels.js';
import { VM_BASELINE } from './vm-baseline.js';
import { frameHash } from './vm-hash.js';

const OUT = process.env.VM_OUT
  || '/tmp/claude-0/-home-user-MComm/1d9ae501-9927-5c9d-832d-0ee312d588ac/scratchpad';
fs.mkdirSync(OUT, { recursive: true });

const t0 = Date.now();
const { frames } = buildViewmodels();
const buildMs = Date.now() - t0;

// ---------------------------------------------------------------------------
// expected key list (hardcoded on purpose - this is the contract)
// ---------------------------------------------------------------------------
const WEAPONS = ['pistol', 'splitter', 'nailer', 'halo', 'deadman', 'boot', 'pipebomb'];
const POSES = ['idle', 'fire0', 'fire1', 'fire2', 'reload0', 'reload1'];
const EXPECT = {};
for (const w of WEAPONS) for (const p of POSES) EXPECT[`${w}_${p}`] = [200, 150];
for (const k of ['flash_small', 'flash_medium', 'flash_large', 'flash_ring', 'flash_plume']) EXPECT[k] = [128, 128];
for (let i = 0; i < 8; i++) EXPECT['boom' + i] = [128, 128];
for (let i = 0; i < 10; i++) EXPECT['nuke' + i] = [192, 192];
for (let i = 0; i < 4; i++) EXPECT['spark' + i] = [16, 16];
for (let i = 0; i < 6; i++) EXPECT['smoke' + i] = [48, 48];
for (let i = 0; i < 4; i++) EXPECT['debris' + i] = [12, 12];
for (let i = 0; i < 4; i++) EXPECT['shockring' + i] = [160, 160];
for (let n = 0; n <= 4; n++) for (let m = 0; m <= 2; m++) EXPECT[`face_h${n}_${m}`] = [64, 72];
for (const k of ['face_hurt', 'face_dead', 'face_grin', 'face_key']) EXPECT[k] = [64, 72];
for (let i = 0; i < 6; i++) {
  EXPECT['city' + i] = [240, 96];
  EXPECT[`city${i}_hit`] = [240, 96];
  EXPECT[`city${i}_dead`] = [240, 96];
}
for (let i = 0; i < 4; i++) EXPECT['cloud' + i] = [256, 64];
EXPECT.moon = [48, 48];
EXPECT.contrail = [64, 8];
// radio portraits and their furniture
for (let i = 0; i < 4; i++) {
  EXPECT[`portrait_brick_${i}`] = [128, 128];
  EXPECT[`portrait_ilsa_${i}`] = [128, 128];
}
EXPECT.portrait_frame = [144, 144];
for (let i = 0; i < 3; i++) EXPECT['portrait_static' + i] = [128, 128];
// expansion FX
for (let i = 0; i < 6; i++) EXPECT['gib_burst' + i] = [96, 96];
for (let i = 0; i < 4; i++) EXPECT['acid_splash' + i] = [64, 64];
for (let i = 0; i < 3; i++) EXPECT['kick_impact' + i] = [96, 96];
EXPECT.pipebomb_prop = [28, 28];
for (let i = 0; i < 3; i++) EXPECT['pipebomb_lit' + i] = [28, 28];

// ---------------------------------------------------------------------------
// checks
// ---------------------------------------------------------------------------
const fails = [];
const warns = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); return cond; };

function stats(f) {
  let opaque = 0, clear = 0, partial = 0, bottomOpaque = 0, nan = 0;
  const half = (f.h >> 1) * f.w;
  for (let i = 0; i < f.data.length; i++) {
    const v = f.data[i];
    if (!Number.isFinite(v)) { nan++; continue; }
    const a = (v >>> 0) >>> 24;
    if (a === 0) clear++;
    else if (a === 255) { opaque++; if (i >= half) bottomOpaque++; }
    else { partial++; if (i >= half) bottomOpaque++; }
  }
  return { opaque, clear, partial, bottomOpaque, nan, total: f.data.length };
}

const S = {};
for (const [k, [w, h]] of Object.entries(EXPECT)) {
  const f = frames[k];
  if (!ok(f, `MISSING key ${k}`)) continue;
  ok(f.w === w && f.h === h, `BAD SIZE ${k}: ${f.w}x${f.h} expected ${w}x${h}`);
  ok(f.data instanceof Uint32Array, `BAD TYPE ${k}: data is not Uint32Array`);
  ok(f.data.length === f.w * f.h, `BAD LENGTH ${k}`);
  const s = stats(f); S[k] = s;
  ok(s.nan === 0, `NaN in ${k}`);
  ok(s.opaque + s.partial > 0, `FULLY TRANSPARENT ${k}`);
}
const extra = Object.keys(frames).filter((k) => !(k in EXPECT));
if (extra.length) warns.push(`extra keys not in contract: ${extra.join(', ')}`);

// ---------------------------------------------------------------------------
// REGRESSION GATE: every frame that shipped must still be byte-identical.
// The expansion is additive; if a shared painter, a light rig constant or the
// model transform drifted, art already in the game would silently repaint. This
// catches that rather than letting it through.
// ---------------------------------------------------------------------------
let baselineChecked = 0;
for (const [k, want] of Object.entries(VM_BASELINE)) {
  const f = frames[k];
  if (!f) { fails.push(`BASELINE ${k}: frame disappeared`); continue; }
  const got = `${f.w}x${f.h}:${frameHash(f.data)}`;
  if (got !== want) fails.push(`BASELINE ${k}: pixels changed (${want} -> ${got})`);
  else baselineChecked++;
}
ok(baselineChecked === Object.keys(VM_BASELINE).length,
  `BASELINE: only ${baselineChecked}/${Object.keys(VM_BASELINE).length} shipped frames verified identical`);

// weapon frames: content in the bottom half, strict 0/255 alpha.
// The kick is a leg, not a gun: at rest it is meant to be almost entirely out
// of frame, so boot_idle carries its own documented floor. Everything else
// keeps the original thresholds.
// boot_idle is the leg at rest, almost entirely below the frame; reload0 is the
// most retracted point of the kick. Both are deliberately sparse.
const OPAQUE_FLOOR = { boot_idle: 1800, boot_fire2: 4200, boot_reload0: 3200, boot_reload1: 2600 };
const BOTTOM_FLOOR = { boot_fire0: 1400 };   // full extension lifts the boot up-frame
for (const w of WEAPONS) for (const p of POSES) {
  const k = `${w}_${p}`, s = S[k]; if (!s) continue;
  const bmin = BOTTOM_FLOOR[k] ?? 2500;
  ok(s.bottomOpaque > bmin, `${k}: only ${s.bottomOpaque} px in bottom half (want > ${bmin})`);
  ok(s.partial === 0, `${k}: weapon frames must be alpha 0 or 255, found ${s.partial} partial`);
  const omin = OPAQUE_FLOOR[k] ?? 6000;
  ok(s.opaque > omin, `${k}: only ${s.opaque} opaque px, looks empty (want > ${omin})`);
}

// FX frames must actually use partial alpha
for (const k of ['flash_small', 'flash_medium', 'flash_large', 'flash_ring', 'flash_plume',
  'smoke0', 'smoke3', 'smoke5', 'boom2', 'boom5', 'boom7', 'nuke3', 'nuke6', 'nuke9',
  'shockring0', 'shockring2', 'cloud0', 'cloud2', 'contrail',
  'gib_burst0', 'gib_burst3', 'gib_burst5', 'acid_splash0', 'acid_splash3',
  'kick_impact0', 'kick_impact2', 'portrait_static0', 'portrait_static2']) {
  const s = S[k]; if (!s) continue;
  ok(s.partial > 60, `${k}: expected soft partial-alpha falloff, found ${s.partial} partial px`);
}
// faces and cities should be substantially solid
for (const k of ['face_h4_1', 'face_h0_1', 'face_dead', 'city0', 'city3_hit', 'city5_dead']) {
  const s = S[k]; if (!s) continue;
  ok(s.opaque > 400, `${k}: only ${s.opaque} opaque px`);
}
// portraits: a solid figure on a genuinely transparent surround
for (let i = 0; i < 4; i++) for (const who of ['brick', 'ilsa']) {
  const k = `portrait_${who}_${i}`, s = S[k]; if (!s) continue;
  ok(s.opaque > 3500, `${k}: only ${s.opaque} opaque px, figure too small`);
  ok(s.clear > 2500, `${k}: only ${s.clear} transparent px, background not cut out`);
  // Top corners must be sky: a chest-up figure legitimately fills the bottom
  // corners with shoulder, so only the upper ones prove the cut-out.
  const f = frames[k];
  const corners = [0, f.w - 1, 3 * f.w + 3, 4 * f.w - 4];
  ok(corners.every((c) => (f.data[c] >>> 24) === 0), `${k}: top corners must be transparent`);
}
// the bezel is a ring: its middle has to be see-through
{
  const f = frames.portrait_frame;
  if (f) {
    const mid = ((f.h >> 1) * f.w + (f.w >> 1));
    ok((f.data[mid] >>> 24) === 0, 'portrait_frame: centre must be transparent (it frames a portrait)');
    ok(S.portrait_frame.opaque > 3000, 'portrait_frame: bezel too thin');
  }
}
for (const k of ['pipebomb_prop', 'pipebomb_lit0', 'pipebomb_lit2']) {
  const s = S[k]; if (!s) continue;
  ok(s.opaque > 180, `${k}: only ${s.opaque} opaque px`);
}

// ---------------------------------------------------------------------------
// contact sheets
// ---------------------------------------------------------------------------
const BG = 0xff1a1420;
const pick = (keys) => keys.filter((k) => frames[k]).map((k) => frames[k]);

// Alpha-aware contact sheet. writeSheet() copies pixels without blending, which
// makes every partial-alpha FX layer look like an opaque white blob - useless
// for judging smoke and haze. This composites for real, optionally over a sky.
function sheet(name, list, { cols = 8, scale = 1, pad = 4, bg = BG, sky = null } = {}) {
  if (!list.length) { warns.push(`sheet ${name} skipped (no frames yet)`); return; }
  const cw = Math.max(...list.map((f) => f.w)) * scale + pad * 2;
  const ch = Math.max(...list.map((f) => f.h)) * scale + pad * 2;
  const rows = Math.ceil(list.length / cols);
  const W = cw * cols, H = ch * rows;
  const out = new Uint32Array(W * H).fill(bg >>> 0);
  list.forEach((f, i) => {
    const ox = (i % cols) * cw + pad + ((cw - pad * 2 - f.w * scale) >> 1);
    const oy = Math.floor(i / cols) * ch + pad;
    if (sky) {
      for (let y = 0; y < f.h * scale; y++) {
        const c = sky(y / (f.h * scale));
        for (let x = 0; x < f.w * scale; x++) out[(oy + y) * W + ox + x] = c;
      }
    }
    for (let y = 0; y < f.h * scale; y++) {
      for (let x = 0; x < f.w * scale; x++) {
        const c = f.data[((y / scale) | 0) * f.w + ((x / scale) | 0)] >>> 0;
        const a = (c >>> 24) / 255;
        if (a <= 0) continue;
        const j = (oy + y) * W + ox + x, d = out[j];
        out[j] = (255 << 24
          | (Math.round(((c >>> 16) & 255) * a + ((d >>> 16) & 255) * (1 - a)) << 16)
          | (Math.round(((c >>> 8) & 255) * a + ((d >>> 8) & 255) * (1 - a)) << 8)
          | Math.round((c & 255) * a + (d & 255) * (1 - a))) >>> 0;
      }
    }
  });
  return writePng(path.join(OUT, name), W, H, out);
}
const duskSky = (t) => {
  const r = 26 + 176 * Math.pow(t, 2.3), g = 28 + 92 * Math.pow(t, 2.8), b = 62 + 26 * Math.pow(t, 4) + 20 * (1 - t);
  return (255 << 24 | (b & 255) << 16 | (g & 255) << 8 | (r & 255)) >>> 0;
};

for (const w of WEAPONS) {
  sheet(`vm-${w}.png`, pick(POSES.map((p) => `${w}_${p}`)),
    { cols: 6, scale: 1, pad: 6, bg: BG });
}
sheet('vm-boom.png', pick([...Array(8)].map((_, i) => 'boom' + i)),
  { cols: 4, scale: 2, pad: 4, bg: BG });
sheet('vm-nuke.png', pick([...Array(10)].map((_, i) => 'nuke' + i)),
  { cols: 5, scale: 1, pad: 4, bg: BG });
sheet('vm-faces.png', pick([
  ...[4, 3, 2, 1, 0].flatMap((n) => [0, 1, 2].map((m) => `face_h${n}_${m}`)),
  'face_hurt', 'face_dead', 'face_grin', 'face_key',
]), { cols: 3, scale: 3, pad: 5, bg: BG });
sheet('vm-cities.png', pick([
  ...[0, 1, 2, 3, 4, 5].flatMap((i) => [`city${i}`, `city${i}_hit`, `city${i}_dead`]),
]), { cols: 3, scale: 1, pad: 5, bg: 0xff141018, sky: duskSky });
sheet('vm-portraits.png', pick([
  ...[0, 1, 2, 3].map((i) => `portrait_brick_${i}`),
  ...[0, 1, 2, 3].map((i) => `portrait_ilsa_${i}`),
  'portrait_frame', 'portrait_static0', 'portrait_static1', 'portrait_static2',
]), { cols: 4, scale: 2, pad: 6, bg: 0xff141018 });
sheet('vm-newfx.png', pick([
  ...[0, 1, 2, 3, 4, 5].map((i) => `gib_burst${i}`),
  ...[0, 1, 2, 3].map((i) => `acid_splash${i}`),
  ...[0, 1, 2].map((i) => `kick_impact${i}`),
  'pipebomb_prop', 'pipebomb_lit0', 'pipebomb_lit1', 'pipebomb_lit2',
]), { cols: 6, scale: 2, pad: 6, bg: BG });
sheet('vm-fx.png', pick([
  'flash_small', 'flash_medium', 'flash_large', 'flash_ring', 'flash_plume',
  'shockring0', 'shockring1', 'shockring2', 'shockring3',
  'smoke0', 'smoke1', 'smoke2', 'smoke3', 'smoke4', 'smoke5',
  'spark0', 'spark1', 'spark2', 'spark3',
  'debris0', 'debris1', 'debris2', 'debris3',
  'cloud0', 'cloud1', 'cloud2', 'cloud3', 'moon', 'contrail',
]), { cols: 5, scale: 1, pad: 5, bg: BG });

// ---------------------------------------------------------------------------
// vm-composite.png - the mock game frame. This is the one that matters.
// ---------------------------------------------------------------------------
function composite() {
  const W = 960, H = 600;
  const out = new Uint32Array(W * H);
  const put = (x, y, r, g, b, a = 255) => {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    out[y * W + x] = ((a & 255) << 24 | (b & 255) << 16 | (g & 255) << 8 | (r & 255)) >>> 0;
  };
  const over = (x, y, c) => {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const a = ((c >>> 24) & 255) / 255;
    if (a <= 0) return;
    const i = y * W + x, d = out[i];
    const dr = d & 255, dg = (d >>> 8) & 255, db = (d >>> 16) & 255;
    const sr = c & 255, sg = (c >>> 8) & 255, sb = (c >>> 16) & 255;
    put(x, y, sr * a + dr * (1 - a), sg * a + dg * (1 - a), sb * a + db * (1 - a));
  };
  const add = (x, y, c, k = 1) => {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const a = (((c >>> 24) & 255) / 255) * k;
    if (a <= 0) return;
    const i = y * W + x, d = out[i];
    put(x, y,
      Math.min(255, (d & 255) + (c & 255) * a),
      Math.min(255, ((d >>> 8) & 255) + ((c >>> 8) & 255) * a),
      Math.min(255, ((d >>> 16) & 255) + ((c >>> 16) & 255) * a));
  };

  const horizon = 372;
  // dusk sky gradient
  for (let y = 0; y < H; y++) {
    const t = y / horizon;
    let r, g, b;
    if (y < horizon) {
      r = 22 + 190 * Math.pow(t, 2.6);
      g = 26 + 96 * Math.pow(t, 3.0);
      b = 58 + 30 * Math.pow(t, 4.0) + 22 * (1 - t);
    } else {
      const u = (y - horizon) / (H - horizon);
      r = 46 - 30 * Math.pow(u, 0.6); g = 34 - 22 * Math.pow(u, 0.6); b = 38 - 24 * Math.pow(u, 0.6);
    }
    for (let x = 0; x < W; x++) {
      const n = ((x * 7 + y * 13) % 17) / 17 - 0.5;
      put(x, y, r + n * 3, g + n * 3, b + n * 3);
    }
  }
  // ground haze band
  for (let y = horizon - 30; y < horizon + 8; y++) {
    const a = Math.max(0, 1 - Math.abs(y - horizon) / 30) * 0.5;
    for (let x = 0; x < W; x++) over(x, y, ((a * 255) << 24 | 60 << 16 | 92 << 8 | 168) >>> 0);
  }

  const stamp = (f, ox, oy, scale = 1, mode = 'over', k = 1) => {
    if (!f) return;
    for (let y = 0; y < f.h * scale; y++) {
      for (let x = 0; x < f.w * scale; x++) {
        const c = f.data[((y / scale) | 0) * f.w + ((x / scale) | 0)] >>> 0;
        if (!(c >>> 24)) continue;
        if (mode === 'add') add(ox + x, oy + y, c, k); else over(ox + x, oy + y, c);
      }
    }
  };

  if (frames.moon) stamp(frames.moon, 742, 74, 1, 'over');
  for (let i = 0; i < 4; i++) stamp(frames['cloud' + i], (i * 233) % 900 - 40, 96 + i * 44, 1);
  // three cities along the horizon, one of them burning
  stamp(frames.city0, 24, horizon - 96, 1);
  stamp(frames.city3_hit, 330, horizon - 96, 1);
  stamp(frames.city5, 660, horizon - 96, 1);
  // contrails
  for (let i = 0; i < 3; i++) stamp(frames.contrail, 180 + i * 260, 130 + i * 30, 1);

  // an airburst mid-air plus its shock ring
  stamp(frames.shockring1, 476, 60, 1.1, 'add', 0.95);
  stamp(frames.boom3, 512, 122, 1.5, 'over');
  stamp(frames.boom6, 208, 150, 1.3, 'over');
  stamp(frames.nuke6, 668, horizon - 180, 1.0, 'over');
  for (let i = 0; i < 7; i++) stamp(frames['spark' + (i % 4)], 540 + i * 21 - 40, 150 + (i % 3) * 26, 1.5, 'add');
  for (let i = 0; i < 4; i++) stamp(frames['smoke' + (i + 2)], 470 + i * 32, 96 + i * 12, 1.2, 'over');

  // the viewmodel, bottom-centre, at the scale the game uses
  const scale = 2.2;
  const vm = frames.splitter_fire0;
  const vw = vm.w * scale, vh = vm.h * scale;
  const vx = ((W - vw) / 2) | 0, vy = (H - 76 - vh + 22) | 0;
  stamp(vm, vx, vy, scale);
  // muzzle flash over the muzzle, additively
  const fl = frames.flash_large;
  const fs = scale * 0.62;
  stamp(fl, (vx + 98 * scale - (fl.w * fs) / 2) | 0, (vy + 46 * scale - (fl.h * fs) / 2) | 0, fs, 'add', 1);

  // a HUD strip with the warden portrait
  const hudH = 76;
  for (let y = H - hudH; y < H; y++) for (let x = 0; x < W; x++) {
    const d = out[y * W + x];
    const k = 0.22;
    put(x, y, (d & 255) * k + 28, ((d >>> 8) & 255) * k + 24, ((d >>> 16) & 255) * k + 26);
  }
  for (let x = 0; x < W; x++) put(x, H - hudH, 96, 84, 70);
  for (const [fk, fx0] of [['face_h4_1', 330], ['face_h2_0', 420], ['face_h0_1', 510], ['face_grin', 600]]) {
    const face = frames[fk];
    if (!face) continue;
    for (let y = 0; y < 68; y++) for (let x = 0; x < 60; x++) {
      const c = face.data[(((y / 68) * face.h) | 0) * face.w + (((x / 60) * face.w) | 0)] >>> 0;
      over(fx0 + x, H - hudH + 5 + y, c);
    }
  }
  writePng(path.join(OUT, 'vm-composite.png'), W, H, out);
}
composite();

/**
 * vm-composite-radio.png - the story frame: both portraits in their bezels at
 * the size the HUD will actually blit them, over a bunker-lit background, with
 * the boot viewmodel underneath and the new FX in play.
 */
function compositeRadio() {
  const W = 960, H = 600;
  const out = new Uint32Array(W * H);
  const put = (x, y, r, g, b) => {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    out[y * W + x] = (255 << 24 | (b & 255) << 16 | (g & 255) << 8 | (r & 255)) >>> 0;
  };
  const over = (x, y, c) => {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const a = ((c >>> 24) & 255) / 255;
    if (a <= 0) return;
    const d = out[y * W + x];
    put(x, y, (c & 255) * a + (d & 255) * (1 - a),
      ((c >>> 8) & 255) * a + ((d >>> 8) & 255) * (1 - a),
      ((c >>> 16) & 255) * a + ((d >>> 16) & 255) * (1 - a));
  };
  const add = (x, y, c, k = 1) => {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const a = (((c >>> 24) & 255) / 255) * k;
    if (a <= 0) return;
    const d = out[y * W + x];
    put(x, y, Math.min(255, (d & 255) + (c & 255) * a),
      Math.min(255, ((d >>> 8) & 255) + ((c >>> 8) & 255) * a),
      Math.min(255, ((d >>> 16) & 255) + ((c >>> 16) & 255) * a));
  };
  // a corridor: dark concrete with a warm lamp pool
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = Math.hypot((x - W * 0.5) / 520, (y - 210) / 320);
      const k = Math.pow(Math.max(0, 1 - d), 1.8);
      const n = ((x * 7 + y * 13) % 23) / 23 - 0.5;
      put(x, y, 24 + k * 92 + n * 5, 22 + k * 68 + n * 5, 26 + k * 44 + n * 5);
    }
  }
  const stamp = (f, ox, oy, w, h, mode = 'over', k = 1) => {
    if (!f) return;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const c = f.data[(((y / h) * f.h) | 0) * f.w + (((x / w) * f.w) | 0)] >>> 0;
        if (!(c >>> 24)) continue;
        if (mode === 'add') add(ox + x, oy + y, c, k); else over(ox + x, oy + y, c);
      }
    }
  };
  // FX in the world behind them
  stamp(frames.gib_burst2, 120, 150, 144, 144, 'over');
  stamp(frames.gib_burst5, 690, 96, 168, 168, 'over');
  stamp(frames.kick_impact1, 300, 300, 150, 150, 'add', 0.9);
  stamp(frames.acid_splash1, 640, 320, 110, 110, 'add', 0.95);
  stamp(frames.acid_splash3, 520, 250, 120, 120, 'add', 0.8);
  stamp(frames.pipebomb_prop, 430, 402, 56, 56);
  for (let i = 0; i < 3; i++) stamp(frames['pipebomb_lit' + i], 500 + i * 66, 402, 56, 56);

  // the two portraits, in bezels, at HUD size
  const N = 96, BZ = 8;
  stamp(frames.portrait_brick_1, 96, 40, N, N);
  stamp(frames.portrait_frame, 96 - BZ, 40 - BZ, N + BZ * 2, N + BZ * 2);
  stamp(frames.portrait_ilsa_2, W - 96 - N, 40, N, N);
  stamp(frames.portrait_frame, W - 96 - N - BZ, 40 - BZ, N + BZ * 2, N + BZ * 2);
  stamp(frames.portrait_static1, W - 96 - N, 40, N, N);

  // the kick, bottom-centre, at the scale the game uses
  const scale = 2.2;
  const vm = frames.boot_fire0;
  const vw = vm.w * scale, vh = vm.h * scale;
  stamp(vm, ((W - vw) / 2) | 0, (H - vh + 22) | 0, vw, vh);

  writePng(path.join(OUT, 'vm-composite-radio.png'), W, H, out);
}
compositeRadio();

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------
let pixels = 0;
for (const f of Object.values(frames)) pixels += f.w * f.h;
console.log(`frames: ${Object.keys(frames).length}   pixels: ${(pixels / 1e6).toFixed(2)}M   bytes: ${(pixels * 4 / 1048576).toFixed(1)} MiB   build: ${buildMs}ms`);
for (const w of warns) console.log('warn: ' + w);
for (const f of fails) console.log('  FAIL ' + f);
console.log(fails.length === 0
  ? `PASS  ${Object.keys(EXPECT).length}/${Object.keys(EXPECT).length} required keys, all dimensions, alpha and content checks OK`
  : `FAIL  ${fails.length} problem(s)`);
process.exitCode = fails.length ? 1 : 0;
