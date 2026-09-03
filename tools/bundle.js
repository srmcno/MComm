// bundle.js - roll the whole game into one self-contained HTML file.
// No network, no module loading: paste it anywhere and it runs.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const OUT = path.join(ROOT, 'dist');
fs.mkdirSync(OUT, { recursive: true });

const result = await build({
  entryPoints: [path.join(ROOT, 'src/main.js')],
  bundle: true,
  format: 'iife',
  globalName: 'NUKEHAUS_MAIN',
  target: ['es2021'],
  minify: process.argv.includes('--minify'),
  write: false,
  legalComments: 'none',
});
const js = result.outputFiles[0].text;

const FAVICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' fill='%230a0810'/%3E%3Ccircle cx='16' cy='16' r='7' fill='%23ffba40'/%3E%3Ccircle cx='16' cy='16' r='3' fill='%23120c08'/%3E%3C/svg%3E";

const html = `<title>NUKEHAUS</title>
<link rel="icon" href="${FAVICON}">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0; height: 100%; width: 100%; overflow: hidden;
    background: #06050a; color: #d8d2c4;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }
  #wrap { position: fixed; inset: 0; display: grid; place-items: center; background: #06050a; }
  canvas#screen {
    display: block; width: 100%; height: 100%;
    image-rendering: pixelated; cursor: none; touch-action: none;
  }
  #overlay { position: fixed; inset: 0; display: grid; place-items: center; pointer-events: none; z-index: 10; }
  #click-to-play {
    pointer-events: auto; text-align: center; letter-spacing: .3em; font-size: 13px;
    color: #ffcf5c; text-transform: uppercase; text-shadow: 0 0 18px rgba(255,160,40,.7);
    animation: pulse 1.6s ease-in-out infinite; background: rgba(6,5,10,.55);
    padding: 18px 30px; border: 1px solid rgba(255,160,40,.35);
  }
  @keyframes pulse { 0%,100% { opacity: .45 } 50% { opacity: 1 } }
  #fatal {
    position: fixed; inset: 0; z-index: 50; display: none; padding: 40px;
    background: #0a0208; color: #ff8d7a; font-size: 13px; line-height: 1.6;
    overflow: auto; white-space: pre-wrap;
  }
  #fatal h1 { color: #ffcf5c; letter-spacing: .3em; font-size: 15px; }
</style>
<div id="wrap"><canvas id="screen"></canvas></div>
<div id="overlay"></div>
<div id="fatal"><h1>NUKEHAUS HAS FAILED TO BOOT</h1><div id="fatal-body"></div></div>
<script>
(function () {
  var fatal = function (err) {
    var el = document.getElementById('fatal');
    document.getElementById('fatal-body').textContent = (err && (err.stack || err.message)) || String(err);
    el.style.display = 'block';
    console.error(err);
  };
  window.addEventListener('error', function (e) { fatal(e.error || e.message); });
  window.addEventListener('unhandledrejection', function (e) { fatal(e.reason); });
  try {
${js.split('\n').map((l) => '    ' + l).join('\n')}
    NUKEHAUS_MAIN.boot().catch(fatal);
  } catch (e) { fatal(e); }
})();
</script>
`;

const file = path.join(OUT, 'nukehaus.html');
fs.writeFileSync(file, html);
const kb = (fs.statSync(file).size / 1024).toFixed(0);
console.log(`wrote ${file}  (${kb} KB, single file, no external requests)`);
