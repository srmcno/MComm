import { chromium } from 'playwright-core';
import { chromePath } from './chrome-path.js';
import { spawn } from 'node:child_process';
const PORT = 8139;
const server = spawn('python3', ['-m','http.server',String(PORT),'--bind','127.0.0.1'], { cwd: '/home/user/MComm', stdio:'ignore' });
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
await sleep(600);
const b = await chromium.launch({ ...(chromePath() ? { executablePath: chromePath() } : {}),
  args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--mute-audio'] });
const p = await b.newPage({ viewport:{width:1280,height:800} });
await p.goto(`http://127.0.0.1:${PORT}/index.html`);
await p.waitForFunction(()=>window.NUKEHAUS&&window.NUKEHAUS.game,{timeout:90000});
await sleep(800);
await p.evaluate(()=>{ const g=window.NUKEHAUS.game; g.newGame(1); g.setState('play'); g.resLocked=true; g.resScale=1.0; });
await sleep(1500);
const measure = async (label, setup) => {
  await p.evaluate(setup);
  await sleep(700);
  const r = await p.evaluate(async () => {
    const t=[]; let last=performance.now();
    await new Promise(res=>{ let n=0; const step=()=>{const now=performance.now(); t.push(now-last); last=now; if(++n<90) requestAnimationFrame(step); else res();}; requestAnimationFrame(step); });
    t.sort((a,b)=>a-b);
    return { med: +t[t.length>>1].toFixed(1), cpu:+window.NUKEHAUS.game.frameMs.toFixed(1), res: window.NUKEHAUS.size.join('x') };
  });
  console.log(label.padEnd(28), JSON.stringify(r));
};
await measure('post ON  res 1.0', ()=>{ window.NUKEHAUS.post.enabled=true; window.NUKEHAUS.game.resScale=1.0; });
await measure('post OFF res 1.0', ()=>{ window.NUKEHAUS.post.enabled=false; });
await measure('post ON  res 0.6', ()=>{ window.NUKEHAUS.post.enabled=true; window.NUKEHAUS.game.resScale=0.6; });
await measure('post OFF res 0.6', ()=>{ window.NUKEHAUS.post.enabled=false; });
await b.close(); server.kill('SIGKILL');
