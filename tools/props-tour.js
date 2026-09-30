// props-tour.js - walk the camera round the furniture and photograph it.
//
//   node tools/props-tour.js [OUT_DIR] [level=N] [kinds=a,b] [max=N] [act=none|kick|shoot|blast]
//
// For each prop picked (distinct kinds first), the player is stood a little
// way off its front and turned to it, the room is emptied of enemies, and the
// frame is saved; then from its side. With act= the prop is kicked, shot or
// blown up and the aftermath photographed too. Nothing is asserted: this is
// for looking at, the way preview-maps is.
import { chromium } from 'playwright-core';
import { chromePath } from './chrome-path.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.includes('=')).map((a) => a.split('=')));
const OUT = process.argv[2] && !process.argv[2].includes('=') ? process.argv[2]
  : '/tmp/claude-0/-home-user-MComm/1d9ae501-9927-5c9d-832d-0ee312d588ac/scratchpad/tour';
const LEVEL = Number(args.level || 0);
const KINDS = args.kinds ? args.kinds.split(',') : null;
const MAX = Number(args.max || 8);
const ACT = args.act || 'none';
const PORT = Number(process.env.TOOL_PORT || 8143);
fs.mkdirSync(OUT, { recursive: true });

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
process.on('exit', () => { try { server.kill('SIGKILL'); } catch { /* ignore */ } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(700);
const CHROME = chromePath();
const browser = await chromium.launch({
  ...(CHROME ? { executablePath: CHROME } : {}),
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + (e.stack || e.message)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.NUKEHAUS && window.NUKEHAUS.game, null, { timeout: 120000 });
await page.keyboard.press('Enter'); await sleep(1200);
await page.keyboard.press('Space'); await sleep(900);

const picked = await page.evaluate(({ LEVEL, KINDS, MAX }) => {
  const g = window.NUKEHAUS.game;
  g.loadLevel(LEVEL);
  g.setState('play'); g.noViewmodel = true; g.hud.hidden = true;
  g.player.hurt = () => {};
  g.enemies.length = 0;
  g.breach = { ...g.breach, cap: 0 };
  const st = g.art.props;
  const seen = new Set(), out = [];
  for (const d of g.level.decor) {
    if (KINDS && !KINDS.includes(d.kind)) continue;
    if (!KINDS && (seen.has(d.kind) || !(st && st.has(d.kind)))) continue;
    seen.add(d.kind);
    out.push({ i: g.level.decor.indexOf(d), kind: d.kind, x: d.x, y: d.y, yaw: d.yaw });
    if (out.length >= MAX) break;
  }
  if (st) st.pump(4000);
  return out;
}, { LEVEL, KINDS, MAX });
console.log('picked', picked.map((p) => p.kind).join(', '));

const standAt = async (d, off, dist) => page.evaluate(({ d, off, dist }) => {
  const g = window.NUKEHAUS.game, lv = g.level, p = g.player;
  // back off along the prop's facing (turned by `off`) until the view is clear
  for (let r = dist; r > 0.5; r -= 0.1) {
    const a = d.yaw + off;
    const x = d.x + Math.cos(a) * r, y = d.y + Math.sin(a) * r;
    const ii = lv.idx(x, y);
    if (!lv.blocked(x, y) && !lv.exit[ii] && !lv.trigger[ii]) { p.x = x; p.y = y; p.ang = Math.atan2(d.y - y, d.x - x); p.pitch = -g.rc.h * 0.12; return true; }
  }
  return false;
}, { d, off, dist });
const settle = async (ms = 500) => {
  await page.evaluate(() => { const g = window.NUKEHAUS.game; if (g.art.props) g.art.props.pump(3000); });
  await sleep(ms);
};

let n = 0;
for (const d of picked) {
  for (const [label, off] of [['front', 0], ['side', 1.1]]) {
    if (!(await standAt(d, off, 1.7))) continue;
    await settle();
    await page.screenshot({ path: path.join(OUT, `${String(n).padStart(2, '0')}-${d.kind}-${label}.png`) });
  }
  if (ACT !== 'none') {
    await standAt(d, 0, 1.4);
    await page.evaluate(({ d, ACT }) => {
      const g = window.NUKEHAUS.game, o = g.level.decor[d.i];
      if (ACT === 'kick') { g.props.kick(g.player, 1.6, 0.5); g.props.kick(g.player, 1.6, 0.5); }
      else if (ACT === 'shoot') for (let k = 0; k < 6; k++) g.props.hit(o, 12, o.x, o.y, o.z + o.h * 0.5, 'shot', Math.cos(g.player.ang), Math.sin(g.player.ang));
      else if (ACT === 'blast') g.explodeAt(o.x + Math.cos(o.yaw) * 0.6, o.y + Math.sin(o.yaw) * 0.6, 0.3, 3, 70);
    }, { d, ACT });
    await settle(250);
    await page.screenshot({ path: path.join(OUT, `${String(n).padStart(2, '0')}-${d.kind}-${ACT}0.png`) });
    await settle(1200);
    await page.screenshot({ path: path.join(OUT, `${String(n).padStart(2, '0')}-${d.kind}-${ACT}1.png`) });
    const after = await page.evaluate((i) => {
      const g = window.NUKEHAUS.game, o = g.level.decor[i], p = g.player;
      const f = o._spr && o._spr.frame;
      return { hp: Math.round(o.hp), broken: o.broken, gone: o.gone, fall: o.fall && { ang: +o.fall.ang.toFixed(2), landed: o.fall.landed }, pose: o.pose,
        at: [+o.x.toFixed(2), +o.y.toFixed(2)], hit: [+o.hx.toFixed(2), +o.hy.toFixed(2)], player: [+p.x.toFixed(2), +p.y.toFixed(2)],
        spr: o._spr && { z: +o._spr.z.toFixed(2), h: +o._spr.h.toFixed(2), fw: f && f.w, fh: f && f.h, below: f && f.below && +f.below.toFixed(2) },
        debris: g.props.debris.length, flying: g.props.flying.length,
        fallen: g.level.decor.filter((q) => q.fall).map((q) => ({ k: q.kind, at: [+q.x.toFixed(2), +q.y.toFixed(2)], yaw: +q.yaw.toFixed(2), pose: q.pose,
          ang: +q.fall.ang.toFixed(2), z: q._spr && +q._spr.z.toFixed(2), h: q._spr && +q._spr.h.toFixed(2), fw: q._spr && q._spr.frame && q._spr.frame.w, fh: q._spr && q._spr.frame && q._spr.frame.h })) };
    }, d.i);
    console.log(d.kind, JSON.stringify(after));
  }
  n++;
}
const stats = await page.evaluate(() => { const s = window.NUKEHAUS.game.art.props; return s ? { made: s.made, ms: Math.round(s.ms), queue: s.queue.length } : null; });
console.log('studio', JSON.stringify(stats));
console.log(errors.length ? 'ERRORS:\n' + errors.slice(0, 8).join('\n') : 'no page errors');
await browser.close();
process.exit(errors.length ? 1 : 0);
