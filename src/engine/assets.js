// assets.js - loads the generated art, audio and level modules.
//
// Every generator is imported dynamically and independently. If one is missing or
// throws, a procedural stand-in takes its place and the game still boots, which
// keeps a single bad module from turning into a black screen.

import { TEX, rgba, mix, shade, makeFrame, fillRect, fillCircle, outline, makeRng, fbm, clamp } from '../core/pixels.js';
// Static imports so a bundler can see them. Each generator is still called
// defensively below, and any frame a generator misses is patched from the
// procedural stand-ins in this file, so one bad module cannot black the screen.
import { buildTextures } from './textures.js';
import { buildSprites } from './sprites.js';
import { buildViewmodels } from './viewmodels.js';
import * as MAPS_MODULE from '../game/maps.js';

export const TEXTURE_ORDER = [
  'CONCRETE', 'CONCRETE_CRACKED', 'STEEL_PLATE', 'STEEL_RIVET',
  'HAZARD', 'PIPES', 'VENT', 'TILE',
  'TILE_BLOOD', 'RUST', 'SANDBAG', 'SCREENS',
  'CIRCUIT', 'SILO_WALL', 'WARNING', 'DOOR',
  'DOOR_JAMB', 'DOOR_RED', 'DOOR_BLUE', 'DOOR_GOLD',
  'ELEVATOR', 'FLESH', 'FLOOR_CONCRETE', 'FLOOR_GRATE',
  'FLOOR_TILE', 'FLOOR_DIRT', 'FLOOR_BLOOD', 'CEIL_CONCRETE',
  'CEIL_LAMP', 'CEIL_PIPES', 'CEIL_FLESH', 'FLOOR_DECK',
];

const BASE_TONES = {
  CONCRETE: [88, 90, 96], CONCRETE_CRACKED: [78, 80, 86], STEEL_PLATE: [86, 94, 110],
  STEEL_RIVET: [96, 104, 120], HAZARD: [200, 158, 40], PIPES: [104, 100, 92],
  VENT: [70, 74, 80], TILE: [150, 152, 146], TILE_BLOOD: [120, 70, 70],
  RUST: [132, 70, 38], SANDBAG: [128, 116, 84], SCREENS: [40, 200, 190],
  CIRCUIT: [40, 150, 190], SILO_WALL: [92, 96, 104], WARNING: [190, 160, 60],
  DOOR: [96, 104, 118], DOOR_JAMB: [56, 60, 68], DOOR_RED: [150, 52, 48],
  DOOR_BLUE: [58, 88, 160], DOOR_GOLD: [176, 146, 54], ELEVATOR: [104, 110, 124],
  FLESH: [156, 88, 82], FLOOR_CONCRETE: [74, 76, 80], FLOOR_GRATE: [58, 60, 66],
  FLOOR_TILE: [128, 130, 128], FLOOR_DIRT: [96, 82, 62], FLOOR_BLOOD: [96, 40, 40],
  CEIL_CONCRETE: [58, 60, 66], CEIL_LAMP: [230, 220, 180], CEIL_PIPES: [70, 72, 78],
  CEIL_FLESH: [130, 74, 70], FLOOR_DECK: [82, 86, 92],
};

const EMISSIVE = { SCREENS: 1, CIRCUIT: 1, CEIL_LAMP: 1, WARNING: 0.35, DOOR_RED: 0.35, DOOR_BLUE: 0.35, DOOR_GOLD: 0.35 };

function fallbackTextures() {
  const count = TEXTURE_ORDER.length;
  const atlas = new Uint32Array(count * TEX * TEX);
  const emissive = new Float32Array(count);
  TEXTURE_ORDER.forEach((name, i) => {
    emissive[i] = EMISSIVE[name] || 0;
    const [br, bg, bb] = BASE_TONES[name] || [100, 100, 100];
    const base = i * TEX * TEX;
    const rng = makeRng(0x1000 + i * 77);
    for (let y = 0; y < TEX; y++) {
      for (let x = 0; x < TEX; x++) {
        const n = fbm(i * 31 + 7, x / 9, y / 9, 4, 8);
        const grain = (rng() - 0.5) * 16;
        const top = 1 - (y / TEX) * 0.34;
        const seam = (x % 32 === 0 || y % 32 === 0) ? 0.78 : 1;
        const v = (0.72 + n * 0.5) * top * seam;
        atlas[base + y * TEX + x] = rgba(
          clamp(br * v + grain, 0, 255), clamp(bg * v + grain, 0, 255), clamp(bb * v + grain, 0, 255), 255);
      }
    }
  });
  return { atlas, count, names: TEXTURE_ORDER, emissive };
}

const ENEMY_IDS = ['wrencher', 'sparker', 'bellows', 'wasp', 'priest',
  'ghoul', 'gorger', 'howler', 'stalker'];
const ENEMY_TINT = {
  wrencher: [214, 118, 34], sparker: [150, 156, 168], bellows: [188, 92, 48],
  wasp: [120, 140, 160], priest: [96, 84, 122],
  ghoul: [176, 168, 142], gorger: [132, 158, 118], howler: [150, 128, 138], stalker: [110, 118, 96],
};

export function requiredSpriteKeys() {
  const keys = [];
  for (const id of ENEMY_IDS) {
    for (let d = 0; d < 4; d++) for (let f = 0; f < 4; f++) keys.push(`${id}_walk${d}_${f}`);
    keys.push(`${id}_aim`, `${id}_fire`, `${id}_pain`, `${id}_dead`);
    for (let i = 0; i < 4; i++) keys.push(`${id}_die${i}`);
  }
  for (const boss of ['mutter', 'maw']) {
    for (let i = 0; i < 4; i++) keys.push(`${boss}_idle${i}`);
    for (let i = 0; i < 3; i++) keys.push(`${boss}_fire${i}`);
    keys.push(`${boss}_pain`, `${boss}_dead`);
    for (let i = 0; i < 6; i++) keys.push(`${boss}_die${i}`);
  }
  for (let i = 0; i < 8; i++) keys.push(`gib${i}`);
  for (let i = 0; i < 4; i++) keys.push(`gore_pool${i}`);
  for (let i = 0; i < 3; i++) keys.push(`viscera${i}`, `acid${i}`);
  keys.push('key_red', 'key_blue', 'key_gold', 'medkit_small', 'medkit_big',
    'ammo_flak', 'ammo_crate', 'barrel', 'barrel_lit', 'pillar', 'lamp',
    'weapon_splitter', 'weapon_nailer', 'weapon_halo', 'weapon_pipebomb', 'weapon_deadman',
    'wh_stick', 'wh_mirv', 'wh_smart', 'wh_screamer', 'wh_buster', 'scorch');
  for (let i = 0; i < 4; i++) keys.push(`treasure${i}`, `skymine${i}`);
  for (let i = 0; i < 3; i++) keys.push(`flare${i}`);
  for (let i = 0; i < 3; i++) keys.push(`blood${i}`);
  return keys;
}

function fallbackSprites() {
  const frames = {};
  const blob = (w, h, col, seed) => {
    const f = makeFrame(w, h);
    const rng = makeRng(seed);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const nx = (x / w - 0.5) * 2, ny = y / h;
        const r = 0.46 - Math.abs(nx) * 0.34 + Math.sin(ny * 3.4) * 0.08;
        if (Math.abs(nx) > r * 2.1) continue;
        if (ny < 0.06) continue;
        const sh = 0.62 + (1 - Math.abs(nx)) * 0.5 - ny * 0.18 + (rng() - 0.5) * 0.1;
        f.data[y * w + x] = rgba(col[0] * sh, col[1] * sh, col[2] * sh, 255);
      }
    }
    fillCircle(f, w / 2, h * 0.16, w * 0.13, rgba(col[0] * 0.8, col[1] * 0.8, col[2] * 0.8, 255));
    return outline(f);
  };
  for (const key of requiredSpriteKeys()) {
    const id = key.split('_')[0];
    const col = ENEMY_TINT[id] || (key.startsWith('key_') ? [220, 60, 60]
      : key.startsWith('wh_') ? [200, 200, 210] : [160, 150, 140]);
    const seed = [...key].reduce((a, c) => a + c.charCodeAt(0), 7);
    const dying = key.includes('_die') || key.includes('_dead');
    frames[key] = blob(dying ? 64 : 56, dying ? 34 : 70, col, seed);
  }
  return { frames };
}

export function requiredViewmodelKeys() {
  const keys = [];
  for (const w of ['pistol', 'splitter', 'nailer', 'halo', 'deadman', 'pipebomb', 'boot']) {
    keys.push(`${w}_idle`, `${w}_fire0`, `${w}_fire1`, `${w}_fire2`, `${w}_reload0`, `${w}_reload1`);
  }
  keys.push('flash_small', 'flash_medium', 'flash_large', 'flash_ring', 'flash_plume');
  for (let i = 0; i < 8; i++) keys.push(`boom${i}`);
  for (let i = 0; i < 10; i++) keys.push(`nuke${i}`);
  for (let i = 0; i < 4; i++) keys.push(`spark${i}`, `debris${i}`, `shockring${i}`);
  for (let i = 0; i < 6; i++) keys.push(`smoke${i}`);
  for (let n = 0; n < 5; n++) for (let m = 0; m < 3; m++) keys.push(`face_h${n}_${m}`);
  keys.push('face_hurt', 'face_dead', 'face_grin', 'face_key');
  for (let i = 0; i < 6; i++) keys.push(`city${i}`, `city${i}_hit`, `city${i}_dead`);
  for (let i = 0; i < 4; i++) keys.push(`cloud${i}`);
  keys.push('moon', 'contrail');
  for (let i = 0; i < 4; i++) keys.push(`portrait_brick_${i}`, `portrait_ilsa_${i}`);
  keys.push('portrait_frame');
  for (let i = 0; i < 3; i++) keys.push(`portrait_static${i}`, `kick_impact${i}`, `pipebomb_lit${i}`);
  for (let i = 0; i < 6; i++) keys.push(`gib_burst${i}`);
  for (let i = 0; i < 4; i++) keys.push(`acid_splash${i}`);
  keys.push('pipebomb_prop');
  return keys;
}

function fallbackViewmodels() {
  const frames = {};
  const radial = (size, cols, pow) => {
    const f = makeFrame(size, size);
    const c = (size - 1) / 2;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c) / c;
      if (d > 1) continue;
      const t = Math.pow(1 - d, pow);
      const i = Math.min(cols.length - 1, Math.floor((1 - t) * cols.length));
      const col = cols[i];
      f.data[y * size + x] = rgba(col[0], col[1], col[2], t * 255);
    }
    return f;
  };
  const HOT = [[255, 255, 240], [255, 220, 130], [255, 150, 40], [190, 70, 20], [80, 60, 60]];
  for (const key of requiredViewmodelKeys()) {
    if (key.startsWith('boom')) { frames[key] = radial(128, HOT, 1.4 + (+key.slice(4)) * 0.28); continue; }
    if (key.startsWith('nuke')) { frames[key] = radial(192, HOT, 1.2 + (+key.slice(4)) * 0.2); continue; }
    if (key.startsWith('flash')) { frames[key] = radial(128, [[255, 255, 235], [255, 200, 110], [255, 130, 40]], 2.2); continue; }
    if (key.startsWith('shockring')) { frames[key] = radial(160, [[255, 255, 255], [200, 220, 255]], 6); continue; }
    if (key.startsWith('smoke')) { frames[key] = radial(48, [[110, 106, 102], [70, 68, 66]], 2); continue; }
    if (key.startsWith('spark') || key.startsWith('debris')) { frames[key] = radial(16, [[255, 230, 170]], 1.4); continue; }
    if (key.startsWith('cloud')) {
      const f = makeFrame(256, 64);
      for (let y = 0; y < 64; y++) for (let x = 0; x < 256; x++) {
        const n = fbm(9, x / 22, y / 12, 4, 8);
        const a = clamp((n - 0.5) * 3 * (1 - Math.abs(y / 32 - 1)), 0, 1);
        if (a > 0.02) f.data[y * 256 + x] = rgba(150, 140, 150, a * 160);
      }
      frames[key] = f; continue;
    }
    if (key.startsWith('city')) {
      const f = makeFrame(240, 96);
      const idx = +key[4];
      const dead = key.endsWith('dead'), hit = key.endsWith('hit');
      const rng = makeRng(0x300 + idx * 91);
      for (let b = 0; b < 26; b++) {
        const bw = 6 + rng() * 20, bx = rng() * (240 - bw), bh = 12 + rng() * 70;
        const body = dead ? rgba(42, 40, 46, 255) : rgba(20, 18, 30, 255);
        fillRect(f, bx | 0, (96 - bh) | 0, bw | 0, bh | 0, body);
        if (!dead) {
          for (let wy = 96 - bh + 4; wy < 92; wy += 5) {
            for (let wx = bx + 2; wx < bx + bw - 2; wx += 4) {
              if (rng() < 0.45) f.data[(wy | 0) * 240 + (wx | 0)] =
                hit ? rgba(255, 140, 50, 255) : rgba(255, 208, 130, 255);
            }
          }
        }
      }
      frames[key] = f; continue;
    }
    if (key.startsWith('portrait_brick') || key.startsWith('portrait_ilsa')) {
      const f = makeFrame(128, 128);
      const warm = key.includes('brick');
      fillCircle(f, 64, 58, 34, rgba(warm ? 196 : 168, warm ? 152 : 140, warm ? 120 : 128, 255));
      fillRect(f, 30, 92, 68, 36, rgba(warm ? 90 : 64, warm ? 86 : 88, warm ? 76 : 96, 255));
      fillCircle(f, 52, 54, 5, rgba(28, 24, 22, 255));
      fillCircle(f, 76, 54, 5, rgba(28, 24, 22, 255));
      frames[key] = outline(f); continue;
    }
    if (key === 'portrait_frame') {
      const f = makeFrame(144, 144);
      fillRect(f, 0, 0, 144, 144, rgba(46, 42, 48, 255));
      fillRect(f, 8, 8, 128, 128, 0);
      frames[key] = f; continue;
    }
    if (key.startsWith('portrait_static')) { frames[key] = radial(128, [[190, 200, 210]], 0.4); continue; }
    if (key.startsWith('gib_burst')) { frames[key] = radial(96, [[190, 40, 40], [120, 20, 24], [60, 12, 16]], 1.6); continue; }
    if (key.startsWith('acid_splash')) { frames[key] = radial(64, [[190, 255, 200], [120, 255, 140], [40, 150, 60]], 1.8); continue; }
    if (key.startsWith('kick_impact')) { frames[key] = radial(96, [[240, 230, 210], [150, 140, 130]], 4); continue; }
    if (key === 'pipebomb_prop' || key.startsWith('pipebomb_lit')) {
      const f = makeFrame(28, 28);
      fillRect(f, 6, 10, 16, 8, rgba(118, 114, 108, 255));
      fillRect(f, 4, 11, 3, 6, rgba(78, 74, 70, 255));
      fillRect(f, 21, 11, 3, 6, rgba(78, 74, 70, 255));
      if (key !== 'pipebomb_prop') fillCircle(f, 14, 8, 2, rgba(255, 60, 40, 255));
      frames[key] = outline(f); continue;
    }
    if (key.startsWith('face')) {
      const f = makeFrame(64, 72);
      fillRect(f, 8, 8, 48, 56, rgba(186, 146, 118, 255));
      fillRect(f, 6, 4, 52, 14, rgba(74, 78, 70, 255));
      fillCircle(f, 22, 34, 4, rgba(30, 26, 24, 255));
      fillCircle(f, 42, 34, 4, rgba(30, 26, 24, 255));
      fillRect(f, 22, 50, 20, 4, rgba(90, 40, 40, 255));
      frames[key] = outline(f); continue;
    }
    if (key === 'moon') { frames[key] = radial(48, [[235, 232, 220], [180, 178, 170]], 0.6); continue; }
    if (key === 'contrail') {
      const f = makeFrame(64, 8);
      for (let x = 0; x < 64; x++) for (let y = 0; y < 8; y++) {
        f.data[y * 64 + x] = rgba(230, 230, 240, (1 - x / 64) * (1 - Math.abs(y - 3.5) / 4) * 200);
      }
      frames[key] = f; continue;
    }
    // Weapon viewmodels: a blocky gun shape, enough to prove the pipeline.
    const f = makeFrame(200, 150);
    const fire = key.includes('fire');
    const dy = fire ? 10 : 0;
    fillRect(f, 74, 70 + dy, 52, 80, rgba(58, 60, 68, 255));
    fillRect(f, 88, 30 + dy, 24, 46, rgba(78, 82, 92, 255));
    fillRect(f, 60, 104 + dy, 80, 46, rgba(46, 34, 26, 255));
    if (fire) fillCircle(f, 100, 26 + dy, 16, rgba(255, 220, 140, 255));
    frames[key] = outline(f);
  }
  return { frames };
}

function fallbackMaps() {
  const W = 34, H = 34;
  const rows = [];
  for (let y = 0; y < H; y++) {
    let r = '';
    for (let x = 0; x < W; x++) {
      const edge = x === 0 || y === 0 || x === W - 1 || y === H - 1;
      const pillar = x % 8 === 0 && y % 8 === 0 && x > 2 && y > 2;
      const deck = x > 10 && x < 24 && y > 10 && y < 24;
      r += edge || pillar ? '#' : (deck ? '^' : ' ');
    }
    rows.push(r);
  }
  rows[3] = rows[3].slice(0, 3) + '@' + rows[3].slice(4);
  rows[9] = rows[9].slice(0, 17) + 'Z' + rows[9].slice(18);
  const def = {
    name: 'TEST RANGE', subtitle: 'fallback level', brief: 'Generated stand-in level.',
    rows, wallTex: {}, floorTex: 'FLOOR_CONCRETE', ceilTex: 'CEIL_CONCRETE',
    deckFloorTex: 'FLOOR_DECK', music: 'prowl', weapons: [], par: 200,
    siege: {
      waves: [{
        trigger: 0, name: 'TEST FLIGHT', duration: 60, maxAlive: 5, intensity: 0.5,
        spawn: [{ type: 'stick', count: 8, from: 0, to: 30, speed: 1 },
                { type: 'mirv', count: 2, from: 10, to: 34, speed: 1 }],
        grunts: [],
      }],
    },
  };
  return { MAPS: [def], parseLevel: null, validateAll: () => [] };
}

/** Fallback parser, also used when maps.js ships data without its own parser. */
export function parseLevelDef(def, index) {
  const rows = def.rows;
  const h = rows.length, w = rows[0].length;
  const n = w * h;
  const out = {
    index, name: def.name, subtitle: def.subtitle, brief: def.brief,
    music: def.music || 'prowl', par: def.par || 240, siege: def.siege || { waves: [] },
    w, h,
    wall: new Int16Array(n), wallTexName: new Array(n).fill(''),
    floorTexName: new Array(n).fill(def.floorTex || 'FLOOR_CONCRETE'),
    ceilTexName: new Array(n).fill(def.ceilTex || 'CEIL_CONCRETE'),
    sky: new Uint8Array(n), trigger: new Uint8Array(n), exit: new Uint8Array(n),
    secret: new Uint8Array(n), doors: [], ents: [], start: { x: 1.5, y: 1.5, dir: 0 },
  };
  const WALLS = {
    '#': 'CONCRETE', X: 'CONCRETE_CRACKED', '=': 'STEEL_PLATE', '+': 'STEEL_RIVET',
    '!': 'HAZARD', p: 'PIPES', v: 'VENT', t: 'TILE', ':': 'TILE_BLOOD', R: 'RUST',
    B: 'SANDBAG', S: 'SCREENS', C: 'CIRCUIT', W: 'SILO_WALL', N: 'WARNING', F: 'FLESH',
  };
  const ENTS = {
    a: 'wrencher', b: 'sparker', c: 'bellows', d: 'wasp', e: 'priest', K: 'boss',
    r: 'key_red', u: 'key_blue', g: 'key_gold', h: 'medkit_small', H: 'medkit_big',
    m: 'ammo', M: 'ammo_crate', o: 'barrel', D: 'pillar', L: 'lamp', T: 'flare',
    $: 'treasure', w: 'weapon',
  };
  const custom = def.wallTex || {};
  let wi = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ch = rows[y][x];
      const i = y * w + x;
      if (ch === '%') {
        out.wall[i] = 1; out.wallTexName[i] = custom['%'] || 'CONCRETE'; out.secret[i] = 1; continue;
      }
      if (WALLS[ch]) { out.wall[i] = 1; out.wallTexName[i] = custom[ch] || WALLS[ch]; continue; }
      if (ch === '-' || ch === '1' || ch === '2' || ch === '3') {
        out.doors.push({ x, y, kind: ch === '1' ? 'red' : ch === '2' ? 'blue' : ch === '3' ? 'gold' : 'free' });
        continue;
      }
      if (ch === '^') { out.sky[i] = 1; out.floorTexName[i] = def.deckFloorTex || 'FLOOR_DECK'; continue; }
      if (ch === 'Z') { out.trigger[i] = 1; out.floorTexName[i] = def.deckFloorTex || 'FLOOR_DECK'; continue; }
      if (ch === 'E') { out.exit[i] = 1; out.floorTexName[i] = 'FLOOR_TILE'; continue; }
      if (ch === '_') { out.floorTexName[i] = 'FLOOR_GRATE'; continue; }
      if (ch === ',') { out.floorTexName[i] = 'FLOOR_DIRT'; continue; }
      if (ch === ';') { out.floorTexName[i] = 'FLOOR_BLOOD'; continue; }
      if (ch === '@') { out.start = { x: x + 0.5, y: y + 0.5, dir: 0 }; continue; }
      if (ENTS[ch]) {
        const e = { kind: ENTS[ch], x: x + 0.5, y: y + 0.5 };
        if (ch === 'w') e.weapon = (def.weapons || [])[wi++] || 'splitter';
        out.ents.push(e);
      }
    }
  }
  // Face the start toward the most open direction.
  const sx = out.start.x | 0, sy = out.start.y | 0;
  const dirs = [[1, 0, 0], [0, 1, Math.PI / 2], [-1, 0, Math.PI], [0, -1, -Math.PI / 2]];
  let bestOpen = -1;
  for (const [dx, dy, a] of dirs) {
    let open = 0;
    for (let s = 1; s < 12; s++) {
      const cx = sx + dx * s, cy = sy + dy * s;
      if (cx < 0 || cy < 0 || cx >= w || cy >= h || out.wall[cy * w + cx]) break;
      open++;
    }
    if (open > bestOpen) { bestOpen = open; out.start.dir = a; }
  }
  return out;
}

/**
 * Hand the frame back to the browser so the loading screen can actually paint.
 * Generation is one long synchronous burn otherwise, and the player stares at a
 * blank canvas for the whole of it before the game appears fully formed.
 */
/**
 * Hand the browser a frame between build stages so the loading screen can
 * animate and the tab stays alive.
 *
 * This raced nothing and simply awaited requestAnimationFrame, which no browser
 * fires for a hidden, backgrounded or occluded tab. Open the game in a new tab
 * behind the one you are reading, or let another window cover it while the art
 * is generating, and loading stopped dead: no error, no overlay, no title
 * screen, forever. So the timer is not a fallback for browsers without rAF —
 * it is what makes loading finish when rAF is asleep. Whichever fires first
 * wins, and on a visible tab that is still rAF.
 */
function yieldFrame() {
  return new Promise((resolve) => {
    let done = false;
    const fire = () => { if (!done) { done = true; resolve(); } };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fire);
    setTimeout(fire, 32);
  });
}

export async function loadAssets(onProgress = () => {}) {
  const warnings = [];
  const warn = (label, e) => {
    warnings.push(`${label}: ${e && e.message ? e.message : e}`);
    console.warn(`[assets] ${label} unavailable, using fallback:`, e);
  };

  onProgress(0.05, 'CALIBRATING SURFACES');
  await yieldFrame();
  let textures = null;
  try { textures = buildTextures(); }
  catch (e) { warn('textures.build', e); }
  if (!textures || !textures.atlas || textures.atlas.length < TEX * TEX) textures = fallbackTextures();

  onProgress(0.28, 'WAKING THE STAFF');
  await yieldFrame();
  let sprites = null;
  try { sprites = buildSprites(); }
  catch (e) { warn('sprites.build', e); }
  if (!sprites || !sprites.frames) sprites = fallbackSprites();

  onProgress(0.52, 'ISSUING ORDNANCE');
  await yieldFrame();
  let viewmodels = null;
  try { viewmodels = buildViewmodels(); }
  catch (e) { warn('viewmodels.build', e); }
  if (!viewmodels || !viewmodels.frames) viewmodels = fallbackViewmodels();

  // Patch any key a generator missed so the game never draws undefined.
  const fbSpr = { frames: null };
  const ensure = (target, required, makeFallback) => {
    const missing = required.filter((k) => !target.frames[k]);
    if (!missing.length) return;
    if (!fbSpr.frames) fbSpr.frames = makeFallback().frames;
    for (const k of missing) target.frames[k] = fbSpr.frames[k];
    warnings.push(`patched ${missing.length} missing frames (${missing.slice(0, 4).join(', ')}${missing.length > 4 ? '…' : ''})`);
  };
  ensure(sprites, requiredSpriteKeys(), fallbackSprites);
  fbSpr.frames = null;
  ensure(viewmodels, requiredViewmodelKeys(), fallbackViewmodels);

  onProgress(0.72, 'SURVEYING THE BUNKER');
  await yieldFrame();
  let maps = null;
  try { maps = MAPS_MODULE.MAPS && MAPS_MODULE.MAPS.length ? MAPS_MODULE : null; }
  catch (e) { warn('maps', e); }
  if (!maps) { warn('maps', new Error('no levels found')); maps = fallbackMaps(); }

  // Floor decals: sprite art resampled into a small 64x64 atlas that keeps its
  // alpha, so the floor pass can blend blood and scorch marks in place with
  // correct perspective instead of pasting billboards on the ground.
  const DECAL_SOURCES = [
    'blood0', 'blood1', 'blood2', 'gore_pool0', 'gore_pool1', 'gore_pool2', 'gore_pool3',
    'scorch', 'acid0', 'acid1',
  ].filter((k) => sprites.frames[k]);
  const decalNames = DECAL_SOURCES.length ? DECAL_SOURCES : ['scorch'];
  const decalAtlas = new Uint32Array(decalNames.length * TEX * TEX);
  decalNames.forEach((key, i) => {
    const f = sprites.frames[key];
    const base = i * TEX * TEX;
    if (!f) return;
    // Fit the frame into the cell with a margin so decals do not tile-seam.
    const pad = 6;
    const inner = TEX - pad * 2;
    const sc = Math.min(inner / f.w, inner / f.h);
    const dw = Math.max(1, Math.round(f.w * sc)), dh = Math.max(1, Math.round(f.h * sc));
    const ox = ((TEX - dw) >> 1), oy = ((TEX - dh) >> 1);
    for (let y = 0; y < dh; y++) {
      const sy = Math.min(f.h - 1, ((y / sc) | 0));
      for (let x = 0; x < dw; x++) {
        const sx = Math.min(f.w - 1, ((x / sc) | 0));
        decalAtlas[base + (oy + y) * TEX + ox + x] = f.data[sy * f.w + sx];
      }
    }
  });
  const decalIndex = new Map();
  decalNames.forEach((n, i) => decalIndex.set(n, i));

  const texIndex = new Map();
  (textures.names || TEXTURE_ORDER).forEach((n, i) => texIndex.set(n, i));
  // Anything the level data asks for that art didn't provide falls back to concrete.
  for (const n of TEXTURE_ORDER) if (!texIndex.has(n)) texIndex.set(n, 0);

  onProgress(0.9, 'TUNING THE PUBLIC ADDRESS');
  await yieldFrame();
  return {
    texAtlas: textures.atlas,
    texEmissive: textures.emissive,
    texNames: textures.names || TEXTURE_ORDER,
    texIndex,
    sprites: sprites.frames,
    vm: viewmodels.frames,
    decalAtlas, decalNames, decalIndex, decalCount: decalNames.length,
    maps,
    warnings,
  };
}
