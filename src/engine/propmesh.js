// propmesh.js - the furniture as real geometry.
//
// The studio used to ray-trace each prop from eight fixed directions and the
// renderer stood the nearest picture up as a billboard. However well a single
// picture was lit, a billboard turns with you: walk round a desk and it swings
// to face you, then snaps to the next picture. So now a model's solids are
// turned into triangles instead, and the renderer draws them in 3D with a
// depth buffer (meshdraw.js). A desk is a desk from wherever you stand, a
// locker really goes over on its face, and a chair tumbles end over end.
//
// Each solid is cut into patches (the six faces of a box, the side and caps
// of a cylinder or cone, the skin of an ellipsoid). Every patch gets its own
// small texture, baked once from the same materials the studio used (wood
// grain along the plank, chipped paint at the edges, stencils, screens,
// bullet pits and scorch on a wreck), lit by the room's ceiling light with the
// shadows the model casts on itself and a little ambient occlusion where parts
// meet. What is baked does not depend on where you stand, which is exactly
// what a thing in a room should look like; the room's own coloured light and
// the haze are applied when it is drawn.
//
// Baking is the expensive part, so it is done in slices: a floor's furniture
// is baked whole while the briefing card is up, and a wreck or a pulled-open
// locker is baked in the gaps between frames the first time it is wanted (the
// standing one is shown meanwhile).

import { Model, STUDIO_INTERNALS } from './propstudio.js';

const { prepare, albedo, hitPrim, toLocal, dirLocal, hashStr, T_BOX, T_CYL, T_CONE } = STUDIO_INTERNALS;

const TPU = 84;          // texels per world unit
const MAXT = 176;        // largest side of one patch's texture
const TWO_PI = Math.PI * 2;

const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const sstep = (a, b, t) => { t = (t - a) / (b - a); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };
function norm3(x, y, z) { const l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; }

// The room light (fixed to the prop, from above and a little in front) and
// three soft fills so no side of anything is a flat slab of one colour.
const OVH = norm3(0.28, 1, 0.38);
const FILLS = [[norm3(0.9, 0.35, 0.55), 0.22], [norm3(-0.8, 0.3, -0.55), 0.17], [norm3(-0.2, 0.25, 1), 0.14]];

function segsFor(r) { return Math.max(6, Math.min(22, Math.round(r * TWO_PI * 42))); }
function texSize(len) { return clamp(Math.ceil(len * TPU), 2, MAXT); }

// ------------------------------------------------------------------ occlusion

/** Is there anything (other than `skip`) within `maxT` of (x,y,z) along (dx,dy,dz)? */
const _o = new Float64Array(3), _d = new Float64Array(3);
function blocked(prims, x, y, z, dx, dy, dz, maxT, skip) {
  for (let i = 0; i < prims.length; i++) {
    const p = prims[i];
    if (p === skip) continue;
    const cx = p.X[9] - x, cy = p.X[10] - y, cz = p.X[11] - z;
    const tc = cx * dx + cy * dy + cz * dz;
    if (tc < -p.rad || tc - p.rad > maxT) continue;
    const d2 = cx * cx + cy * cy + cz * cz - tc * tc;
    if (d2 > p.rad * p.rad) continue;
    toLocal(p, x, y, z, _o); dirLocal(p, dx, dy, dz, _d);
    const t = hitPrim(p, _o[0], _o[1], _o[2], _d[0], _d[1], _d[2]);
    if (t > 0.003 && t < maxT) return true;
  }
  return false;
}

// ------------------------------------------------------------------ patches

/**
 * A patch is a piece of a solid's surface with a (u, v) in 0..1 across it.
 * `at(u, v, P, N)` writes the local point and local normal.
 */
function boxPatches(p) {
  const h = p.half, out = [];
  for (let a = 0; a < 3; a++) {
    const t1 = (a + 1) % 3, t2 = (a + 2) % 3;
    for (const s of [1, -1]) {
      out.push({
        p, tw: texSize(2 * h[t1]), th: texSize(2 * h[t2]), cap: false,
        at(u, v, P, N) {
          P[a] = s * h[a]; P[t1] = (u * 2 - 1) * h[t1]; P[t2] = (v * 2 - 1) * h[t2];
          N[0] = N[1] = N[2] = 0; N[a] = s;
        },
        // the face as two triangles, corners in (u, v)
        grid: [[0, 0], [1, 0], [1, 1], [0, 1]], quad: true,
      });
    }
  }
  return out;
}

/** Side of a cylinder (r0 === r1) or cone, radius r0 at the bottom, r1 at the top. */
function sidePatch(p, r0, r1) {
  const hh = p.half[1];
  const rm = (r0 + r1) / 2, k = (r1 - r0) / (2 * hh);
  const segs = segsFor(Math.max(r0, r1));
  return {
    p, tw: texSize(TWO_PI * Math.max(r0, r1)), th: texSize(2 * hh * Math.hypot(1, k)), segs, side: true,
    at(u, v, P, N) {
      const th = u * TWO_PI, y = (v * 2 - 1) * hh, ry = rm + k * y;
      const c = Math.cos(th), s = Math.sin(th);
      P[0] = ry * c; P[1] = y; P[2] = ry * s;
      const l = Math.hypot(1, k);
      N[0] = c / l; N[1] = -k / l; N[2] = s / l;
    },
  };
}

function capPatch(p, r, top) {
  const hh = p.half[1];
  const segs = segsFor(r);
  return {
    p, tw: texSize(2 * r), th: texSize(2 * r), segs, cap: true, r, y: top ? hh : -hh, top,
    at(u, v, P, N) {
      P[0] = (u * 2 - 1) * r; P[1] = top ? hh : -hh; P[2] = (v * 2 - 1) * r;
      N[0] = 0; N[1] = top ? 1 : -1; N[2] = 0;
    },
  };
}

function sphPatch(p) {
  const h = p.half;
  // round things are mostly small (sandbags, leaves, bulbs): a few facets do
  const segs = Math.max(6, Math.min(12, Math.round(Math.max(h[0], h[2]) * TWO_PI * 30)));
  const rings = Math.max(3, (segs >> 1) - 1);
  return {
    p, tw: texSize(TWO_PI * Math.max(h[0], h[2])), th: texSize(Math.PI * h[1]), segs, rings, sph: true,
    at(u, v, P, N) {
      const ph = u * TWO_PI, la = (v - 0.5) * Math.PI;
      const cl = Math.cos(la), sl = Math.sin(la);
      const x = h[0] * cl * Math.cos(ph), y = h[1] * sl, z = h[2] * cl * Math.sin(ph);
      P[0] = x; P[1] = y; P[2] = z;
      const nx = x / (h[0] * h[0]), ny = y / (h[1] * h[1]), nz = z / (h[2] * h[2]);
      const l = Math.hypot(nx, ny, nz) || 1;
      N[0] = nx / l; N[1] = ny / l; N[2] = nz / l;
    },
  };
}

function patchesOf(p) {
  switch (p.type) {
    case T_BOX: return boxPatches(p);
    case T_CYL: return [sidePatch(p, p.half[0], p.half[0]), capPatch(p, p.half[0], true), capPatch(p, p.half[0], false)];
    case T_CONE: {
      const out = [sidePatch(p, p.r0, p.r1)];
      if (p.r1 > 0.0005) out.push(capPatch(p, p.r1, true));
      if (p.r0 > 0.0005) out.push(capPatch(p, p.r0, false));
      return out;
    }
    default: return [sphPatch(p)];
  }
}

// ------------------------------------------------------------------ geometry

/**
 * Triangles for every patch, in model space. Vertices are not shared between
 * patches (each carries its own patch's texture coordinates).
 */
function buildGeometry(prims) {
  const P = [0, 0, 0], Nn = [0, 0, 0];
  const vx = [], vy = [], vz = [], vu = [], vv = [];
  const tri = [], tpatch = [], tn = [];
  const patches = [];
  const vert = (pt, u, v) => {
    pt.at(u, v, P, Nn);
    const X = pt.p.X;
    vx.push(X[0] * P[0] + X[1] * P[1] + X[2] * P[2] + X[9]);
    // a wreck's parts knocked askew can dip into the floor: the floor stops them
    vy.push(Math.max(0, X[3] * P[0] + X[4] * P[1] + X[5] * P[2] + X[10]));
    vz.push(X[6] * P[0] + X[7] * P[1] + X[8] * P[2] + X[11]);
    vu.push(u); vv.push(v);
    return vx.length - 1;
  };
  const face = (pi, a, b, c) => {
    // outward normal from the triangle itself, turned away from the solid's centre
    const ax = vx[b] - vx[a], ay = vy[b] - vy[a], az = vz[b] - vz[a];
    const bx = vx[c] - vx[a], by = vy[c] - vy[a], bz = vz[c] - vz[a];
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-12) return;
    nx /= l; ny /= l; nz /= l;
    const X = patches[pi].p.X;
    const mx = (vx[a] + vx[b] + vx[c]) / 3 - X[9], my = (vy[a] + vy[b] + vy[c]) / 3 - X[10], mz = (vz[a] + vz[b] + vz[c]) / 3 - X[11];
    if (nx * mx + ny * my + nz * mz < 0) { nx = -nx; ny = -ny; nz = -nz; }
    tri.push(a, b, c); tpatch.push(pi); tn.push(nx, ny, nz);
  };
  for (const p of prims) {
    for (const pt of patchesOf(p)) {
      const pi = patches.length;
      patches.push(pt);
      if (pt.quad) {
        const i0 = vert(pt, 0, 0), i1 = vert(pt, 1, 0), i2 = vert(pt, 1, 1), i3 = vert(pt, 0, 1);
        face(pi, i0, i1, i2); face(pi, i0, i2, i3);
      } else if (pt.side) {
        const n = pt.segs;
        const base = vx.length;
        for (let s = 0; s <= n; s++) { vert(pt, s / n, 0); vert(pt, s / n, 1); }
        for (let s = 0; s < n; s++) {
          const a = base + s * 2, b = a + 2;
          face(pi, a, b, b + 1); face(pi, a, b + 1, a + 1);
        }
      } else if (pt.cap) {
        const n = pt.segs;
        const c = vert(pt, 0.5, 0.5);
        const ring = [];
        for (let s = 0; s < n; s++) {
          const th = (s / n) * TWO_PI;
          ring.push(vert(pt, 0.5 + 0.5 * Math.cos(th), 0.5 + 0.5 * Math.sin(th)));
        }
        for (let s = 0; s < n; s++) face(pi, c, ring[s], ring[(s + 1) % n]);
      } else if (pt.sph) {
        const n = pt.segs, m = pt.rings;
        const base = vx.length;
        for (let j = 0; j <= m; j++) for (let s = 0; s <= n; s++) vert(pt, s / n, j / m);
        for (let j = 0; j < m; j++) for (let s = 0; s < n; s++) {
          const a = base + j * (n + 1) + s, b = a + 1, c = a + n + 1, d = c + 1;
          if (j > 0) face(pi, a, b, d);
          if (j < m - 1) face(pi, a, d, c);
        }
      }
    }
  }
  return {
    vx: Float32Array.from(vx), vy: Float32Array.from(vy), vz: Float32Array.from(vz),
    vu: Float32Array.from(vu), vv: Float32Array.from(vv),
    tri: Uint32Array.from(tri), tpatch: Uint16Array.from(tpatch), tn: Float32Array.from(tn),
    patches,
  };
}

// ------------------------------------------------------------------ baking

const LP = [0, 0, 0], LN = [0, 0, 0];
const COL = new Float64Array(3);

/** Light arriving at a model-space point with model-space normal n: 0.. (1 is plain daylight). */
function lightAt(prims, p, mx, my, mz, nx, ny, nz, glossy) {
  const ex = mx + nx * 0.004, ey = my + ny * 0.004, ez = mz + nz * 0.004;
  const facing = nx * OVH[0] + ny * OVH[1] + nz * OVH[2];
  let dO = 0;
  if (facing > 0) dO = blocked(prims, ex, ey, ez, OVH[0], OVH[1], OVH[2], 8, p) ? facing * 0.2 : facing;
  let L = 0.4 + 0.1 * ny + 0.56 * dO;
  for (const [f, w] of FILLS) { const d = nx * f[0] + ny * f[1] + nz * f[2]; if (d > 0) L += w * d; }
  // ambient occlusion: the normal and four directions leaning off it
  let tx = -nz, ty = 0, tz = nx;
  if (Math.abs(ny) > 0.9) { tx = 1; ty = 0; tz = 0; }
  const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
  const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
  let occ = 0;
  const R = 0.15;
  if (blocked(prims, ex, ey, ez, nx, ny, nz, R, null)) occ += 1.2;
  for (let k = 0; k < 4; k++) {
    const a = k * Math.PI / 2 + 0.4;
    const ca = Math.cos(a) * 0.82, sa = Math.sin(a) * 0.82;
    let dx = nx * 0.58 + tx * ca + bx * sa, dy = ny * 0.58 + ty * ca + by * sa, dz = nz * 0.58 + tz * ca + bz * sa;
    const l = Math.hypot(dx, dy, dz); dx /= l; dy /= l; dz /= l;
    // the floor is in the way too
    if (dy < -0.05 && ey / -dy < R) { occ += 1; continue; }
    if (blocked(prims, ex, ey, ez, dx, dy, dz, R, null)) occ += 1;
  }
  L *= 1 - Math.min(0.55, occ * 0.12);
  // the last few centimetres above the floor are always a little in the dark
  L *= 0.8 + 0.2 * sstep(0, 0.1, my);
  if (glossy > 0) L *= 1 + glossy * 0.12;
  return L;
}

function bakePatchRows(prims, pt, st, rowFrom, rowTo) {
  const { tw, th, p } = pt;
  const X = p.X, m = p.m, h = p.half;
  const tex = pt.tex;
  // Light is smooth: work it out on every other texel and blend between.
  const lw = pt.lw, lh = pt.lh, lgrid = pt.lgrid;
  for (let j = rowFrom; j < rowTo; j++) {
    const v = (j + 0.5) / th;
    const lj = j >> 1, lf = (j & 1) ? 0.5 : 0;
    // make sure the light rows this row needs exist
    for (const r of [lj, lj + 1]) {
      if (r >= lh || pt.lrow[r]) continue;
      pt.lrow[r] = 1;
      const lv = Math.min(1, (r * 2 + 0.5) / th);
      for (let i = 0; i < lw; i++) {
        const lu = Math.min(1, (i * 2 + 0.5) / tw);
        pt.at(lu, lv, LP, LN);
        const mx = X[0] * LP[0] + X[1] * LP[1] + X[2] * LP[2] + X[9];
        const my = X[3] * LP[0] + X[4] * LP[1] + X[5] * LP[2] + X[10];
        const mz = X[6] * LP[0] + X[7] * LP[1] + X[8] * LP[2] + X[11];
        const nx = X[0] * LN[0] + X[1] * LN[1] + X[2] * LN[2];
        const ny = X[3] * LN[0] + X[4] * LN[1] + X[5] * LN[2];
        const nz = X[6] * LN[0] + X[7] * LN[1] + X[8] * LN[2];
        lgrid[r * lw + i] = m.glow >= 0.999 ? 1 : lightAt(prims, p, mx, my, mz, nx, ny, nz, m.kind === 'metal' || m.kind === 'brass' ? m.gloss : 0);
      }
    }
    for (let i = 0; i < tw; i++) {
      const u = (i + 0.5) / tw;
      pt.at(u, v, LP, LN);
      let nx = LN[0], ny = LN[1], nz = LN[2];
      const lx = LP[0], ly = LP[1], lz = LP[2];
      // bevelled edges catch the light, the way the studio drew them
      if (p.type === T_BOX && p.bevel > 0) {
        const bv = p.bevel;
        const ex = h[0] - Math.abs(lx), ey = h[1] - Math.abs(ly), ez = h[2] - Math.abs(lz);
        if (Math.abs(nx) < 0.5 && ex < bv) nx += Math.sign(lx) * (1 - ex / bv) * 0.9;
        if (Math.abs(ny) < 0.5 && ey < bv) ny += Math.sign(ly) * (1 - ey / bv) * 0.9;
        if (Math.abs(nz) < 0.5 && ez < bv) nz += Math.sign(lz) * (1 - ez / bv) * 0.9;
        const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
      }
      const my = X[3] * lx + X[4] * ly + X[5] * lz + X[10];
      albedo(p, lx, ly, lz, nx, ny, nz, my, st, COL);
      // light, blended from the coarse grid
      const li = i >> 1, lfi = (i & 1) ? 0.5 : 0;
      const i1 = Math.min(lw - 1, li + 1), j1 = Math.min(lh - 1, lj + 1);
      const a = lgrid[lj * lw + li], b = lgrid[lj * lw + i1], c = lgrid[j1 * lw + li], d = lgrid[j1 * lw + i1];
      let L = (a + (b - a) * lfi) + ((c + (d - c) * lfi) - (a + (b - a) * lfi)) * lf;
      // the bevel's own highlight: a rounded edge facing the light is brighter
      if (p.type === T_BOX && p.bevel > 0 && m.glow < 0.999) {
        const Ny = X[3] * nx + X[4] * ny + X[5] * nz;
        L *= 0.94 + 0.12 * Math.max(0, Ny);
      }
      let R, G, B;
      if (m.glow >= 0.999) { R = COL[0]; G = COL[1]; B = COL[2]; }
      else {
        if (m.glow > 0) L = L * (1 - m.glow) + 1.05 * m.glow;
        R = COL[0] * L; G = COL[1] * L; B = COL[2] * L;
      }
      R = R > 220 ? 220 + (R - 220) * 0.35 : R; G = G > 220 ? 220 + (G - 220) * 0.35 : G; B = B > 220 ? 220 + (B - 220) * 0.35 : B;
      tex[j * tw + i] = (255 << 24 | (Math.min(255, B) | 0) << 16 | (Math.min(255, G) | 0) << 8 | (Math.min(255, R) | 0)) >>> 0;
    }
  }
}

/** The shadow a model throws on the floor under it: alpha only, from straight up and a little round about. */
function bakeShadow(prims, b) {
  const pad = 0.1;
  const x0 = b.minX - pad, x1 = b.maxX + pad, z0 = b.minZ - pad, z1 = b.maxZ + pad;
  const S = 40;
  const tw = clamp(Math.ceil((x1 - x0) * S), 2, 96), th = clamp(Math.ceil((z1 - z0) * S), 2, 96);
  const tex = new Uint32Array(tw * th);
  const J = [[0, 0], [0.22, 0.1], [-0.2, 0.14], [0.06, -0.24], [-0.1, -0.2]].map((j) => norm3(j[0], 1, j[1]));
  let any = false;
  for (let j = 0; j < th; j++) for (let i = 0; i < tw; i++) {
    const gx = x0 + (i + 0.5) / tw * (x1 - x0), gz = z0 + (j + 0.5) / th * (z1 - z0);
    let hits = 0;
    for (let k = 0; k < J.length; k++) if (blocked(prims, gx, 0.002, gz, J[k][0], J[k][1], J[k][2], 6, null)) hits++;
    if (!hits) continue;
    any = true;
    const a = Math.round(hits / J.length * 165);
    tex[j * tw + i] = (a << 24 | 10 << 16 | 8 << 8 | 8) >>> 0;
  }
  if (!any) return null;
  return { tw, th, tex, x0, x1, z0, z1, alpha: true };
}

// ------------------------------------------------------------------ the bank

/**
 * A baked model: geometry in model space, one texture per patch.
 *   vx vy vz vu vv    vertices
 *   tri tpatch tn     triangles, the patch each one is textured from, their outward normals
 *   patches[k]        { tw, th, tex }
 *   shadow            { tw, th, tex, x0, x1, z0, z1 } or null: the floor under it
 *   minX.. top, cx cy cz r   bounds and a bounding sphere
 */
function startBake(def, state, variant, seedKind) {
  const M = new Model(state, hashStr(seedKind) ^ (variant * 7919), variant);
  def.build(M);
  const prims = M.prims;
  if (!prims.length) return null;
  prepare(prims);
  const g = buildGeometry(prims);
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9, minZ = 1e9, maxZ = -1e9;
  for (let i = 0; i < g.vx.length; i++) {
    const x = g.vx[i], y = g.vy[i], z = g.vz[i];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
  const mesh = {
    ...g, minX, maxX, minY, maxY, minZ, maxZ, top: maxY, cx, cy, cz,
    r: Math.hypot(maxX - cx, maxY - cy, maxZ - cz), shadow: null, ready: false,
  };
  for (const pt of mesh.patches) {
    pt.tex = new Uint32Array(pt.tw * pt.th);
    pt.lw = (pt.tw >> 1) + 2; pt.lh = (pt.th >> 1) + 2;
    pt.lgrid = new Float32Array(pt.lw * pt.lh);
    pt.lrow = new Uint8Array(pt.lh);
  }
  const st = def.noDamage ? 0 : state === 'wreck' ? 2 : state === 'hurt' ? 1 : 0;
  return { mesh, prims, st, pi: 0, row: 0, shadowDone: false };
}

/** Bake until `until` (a time) or done. Returns true when the mesh is ready. */
function stepBake(job, until) {
  const { mesh, prims, st } = job;
  const P = mesh.patches;
  while (job.pi < P.length) {
    const pt = P[job.pi];
    const rows = Math.max(1, Math.min(pt.th - job.row, 8));
    bakePatchRows(prims, pt, st, job.row, job.row + rows);
    job.row += rows;
    if (job.row >= pt.th) {
      job.pi++; job.row = 0;
      pt.lgrid = null; pt.lrow = null;     // done with the light grid
    }
    if (until && now() > until) return false;
  }
  if (!job.shadowDone) {
    job.shadowDone = true;
    mesh.shadow = bakeShadow(prims, mesh);
  }
  mesh.ready = true;
  return true;
}

export class MeshBank {
  /** models and pieces as propmodels.js exports them. */
  constructor(models, pieces = {}) {
    this.models = models || {};
    this.pieces = pieces || {};
    this.cache = new Map();      // key -> mesh (ready) or null (cannot be made)
    this.jobs = new Map();       // key -> bake in progress
    this.queue = [];
    this.ms = 0;
    this.made = 0;
  }

  has(kind, piece = false) { return !!(piece ? this.pieces[kind] : this.models[kind]); }

  _key(kind, state, variant, piece) {
    const def = piece ? this.pieces[kind] : this.models[kind];
    if (!def) return null;
    const nv = def.variants || 1;
    variant = ((variant % nv) + nv) % nv;
    return { def, variant, key: `${piece ? 'p:' : ''}${kind}|${variant}|${state}` };
  }

  /** Bake now, whatever it costs. */
  make(kind, state = 'ok', variant = 0, piece = false) {
    const k = this._key(kind, state, variant, piece);
    if (!k) return null;
    const hit = this.cache.get(k.key);
    if (hit !== undefined) return hit;
    const t0 = now();
    let mesh = null;
    try {
      let job = this.jobs.get(k.key);
      if (!job) job = startBake(k.def, state, k.variant, kind);
      if (job) { stepBake(job, 0); mesh = job.mesh; }
    } catch (e) { mesh = null; }
    this.jobs.delete(k.key);
    this.cache.set(k.key, mesh);
    this.ms += now() - t0;
    this.made++;
    return mesh;
  }

  /**
   * The mesh if it is baked; otherwise it goes on the list and this returns
   * the nearest thing that is ready (a wreck shows the battered one, a
   * battered one the whole one), or null.
   */
  get(kind, state = 'ok', variant = 0, piece = false) {
    const k = this._key(kind, state, variant, piece);
    if (!k) return null;
    const hit = this.cache.get(k.key);
    if (hit !== undefined) return hit;
    if (!this.jobs.has(k.key) && !this.queue.includes(k.key)) this.queue.push(k.key);
    const fall = state === 'wreck' ? ['hurt', 'ok'] : state === 'ok' ? [] : ['ok'];
    for (const s of fall) {
      const m = this.cache.get(`${piece ? 'p:' : ''}${kind}|${k.variant}|${s}`);
      if (m) return m;
    }
    return null;
  }

  /** Bake what has been asked for until `budgetMs` is spent. Returns how much is left. */
  pump(budgetMs = 3) {
    const t0 = now(), until = t0 + budgetMs;
    while (this.queue.length && now() < until) {
      // newest first: what was asked for this frame is what is on screen
      const key = this.queue[this.queue.length - 1];
      if (this.cache.has(key)) { this.queue.pop(); continue; }
      let job = this.jobs.get(key);
      if (!job) {
        const [kk, v, state] = key.split('|');
        const piece = kk.startsWith('p:');
        const kind = piece ? kk.slice(2) : kk;
        const def = piece ? this.pieces[kind] : this.models[kind];
        try { job = def ? startBake(def, state, Number(v), kind) : null; } catch (e) { job = null; }
        if (!job) { this.cache.set(key, null); this.queue.pop(); continue; }
        this.jobs.set(key, job);
      }
      let done = false;
      try { done = stepBake(job, until); } catch (e) { this.cache.set(key, null); this.jobs.delete(key); this.queue.pop(); continue; }
      if (done) {
        this.cache.set(key, job.mesh);
        this.jobs.delete(key);
        this.queue.pop();
        this.made++;
      }
    }
    this.ms += now() - t0;
    return this.queue.length;
  }

  /** Bake every variant of these kinds in these states now, up to `budgetMs`; queue the rest. */
  prewarm(kinds, states = ['ok'], budgetMs = Infinity, piece = false) {
    const t0 = now();
    for (const kind of kinds) {
      const def = piece ? this.pieces[kind] : this.models[kind];
      if (!def) continue;
      for (let v = 0; v < (def.variants || 1); v++) for (const s of states) {
        if (now() - t0 < budgetMs) this.make(kind, s, v, piece);
        else this.get(kind, s, v, piece);
      }
    }
  }

  /** Let go of everything but the standing ones (a floor's wrecks are not the next floor's). */
  trim() {
    for (const k of [...this.cache.keys()]) if (!k.endsWith('|ok')) this.cache.delete(k);
    this.jobs.clear();
    this.queue.length = 0;
  }

  clear() { this.cache.clear(); this.jobs.clear(); this.queue.length = 0; }
}
