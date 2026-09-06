// main.js - boot, canvas, the loop, and the state plumbing that owns them.

import { Input } from './core/input.js';
import { Post } from './engine/post.js';
import { loadAssets } from './engine/assets.js';
import { Text } from './ui/text.js';
import { TitleScreen } from './ui/title.js';
import { Game, STATE } from './game/game.js';
import {
  renderWorld, drawViewmodel, drawBrief, drawIntermission,
  drawGameOver, drawVictory, drawPause, drawLoading,
} from './game/render.js';
import { clamp, damp } from './core/math.js';
// Static so the single-file build can see them; both are still optional at
// runtime and the game plays silently if either fails to construct.
import { Sound } from './audio/synth.js';
import { Vox, LINES as VOX_LINES } from './audio/vox.js';

// Internal render width bounds. The ceiling is generous so a fast machine gets
// a crisp image; the adaptive controller pulls it back down on anything slower.
const MIN_W = 428, MAX_W = 1600;

export async function boot() {
  const canvas = document.getElementById('screen');
  const overlay = document.getElementById('overlay');
  const post = new Post(canvas);
  const text = new Text();
  const input = new Input(canvas);

  let cssW = 0, cssH = 0, dpr = 1;
  let iw = 640, ih = 400;
  let frame = new Uint32Array(iw * ih);
  let resScale = 1.0;

  function sizeCanvas() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const r = canvas.getBoundingClientRect();
    cssW = Math.max(320, r.width | 0);
    cssH = Math.max(200, r.height | 0);
    const w = Math.round(cssW * dpr), h = Math.round(cssH * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }

  function sizeInternal() {
    // Internal render resolution: chunky enough to be honest, sharp enough to be
    // pretty, and adaptive so a heavy frame doesn't tank the framerate.
    const aspect = cssW / cssH;
    let w = clamp(Math.round(cssW * 0.72 * resScale), MIN_W, MAX_W);
    w -= w % 2;
    let h = Math.round(w / aspect);
    h -= h % 2;
    if (h < 260) { h = 260; w = Math.round(h * aspect); w -= w % 2; }
    if (w !== iw || h !== ih) {
      iw = w; ih = h;
      frame = new Uint32Array(iw * ih);
    }
  }

  sizeCanvas(); sizeInternal();
  addEventListener('resize', () => { sizeCanvas(); sizeInternal(); });

  // ------------------------------------------------------------ loading

  let progress = 0, progressLabel = 'WARMING THE CATHODES';
  let booted = false;
  const loadStart = performance.now();

  // A boot that stalls silently is the worst kind: no error, no overlay, just a
  // loading screen forever. This says how far it got, so a stall can be named
  // from the console instead of guessed at.
  const stage = (name) => {
    window.NUKEHAUS_BOOT = { stage: name, at: +(performance.now() - loadStart).toFixed(0) };
  };
  stage('start');

  function loadingFrame() {
    if (booted) return;
    sizeCanvas(); sizeInternal();
    drawLoading(frame, iw, ih, text, progress, progressLabel, performance.now() / 1000);
    post.present(frame, iw, ih, (performance.now() - loadStart) / 1000);
    requestAnimationFrame(loadingFrame);
  }
  requestAnimationFrame(loadingFrame);

  const art = await loadAssets((p, label) => { progress = p; progressLabel = label; stage(label); });
  stage('assets');
  progress = 0.95; progressLabel = 'CLEARING THE STAIRWELL';

  // Audio is optional; the game runs mute if either module fails to construct.
  let sound = null, vox = null, VoxLines = {};
  try { sound = new Sound(); } catch (e) { console.warn('[audio] synth unavailable', e); }
  try { vox = { ctor: Vox, LINES: VOX_LINES || {} }; VoxLines = VOX_LINES || {}; }
  catch (e) { console.warn('[audio] vox unavailable', e); }

  stage('audio-constructed');
  const game = new Game(art, sound, null, input, post, text);
  game.voxLines = VoxLines;
  const title = new TitleScreen();
  game.titleScreen = title;
  game.skyDome.rebuild(game.sky.cities);
  stage('game-constructed');

  if (art.warnings.length) console.warn('[assets]', art.warnings);

  // Audio can only start inside a gesture, so wire it to the first real input.
  let audioStarted = false;
  const startAudio = async () => {
    if (audioStarted) return;
    audioStarted = true;
    try {
      if (sound) {
        await sound.init();
        sound.setMaster(game.volMaster);
        sound.setMusicVol(game.volMusic);
        sound.setSfxVol(0.95);
        if (vox && sound.ctx) {
          const v = new vox.ctor(sound.ctx, sound.sfxBus || sound.ctx.destination);
          game.vox = wrapVox(v);
          game.vox.setVolume(game.volVox);
        }
        if (game.state === STATE.TITLE) sound.music('title', { fadeIn: 2.0 });
      }
    } catch (e) { console.warn('[audio] init failed', e); }
    hideGate();
  };
  function wrapVox(v) {
    return {
      say: (...a) => { try { return v.say(...a) || 0; } catch { return 0; } },
      sayLine: (...a) => { try { return (v.sayLine ? v.sayLine(...a) : v.say(...a)) || 0; } catch { return 0; } },
      cancel: () => { try { v.cancel && v.cancel(); } catch { /* ignore */ } },
      setVolume: (x) => { try { v.setVolume && v.setVolume(x); } catch { /* ignore */ } },
      get busy() { return !!v.busy; },
      // The announcer picks which variant of a line to speak. Forward it so the
      // subtitle shows the words that were actually said, not a second draw.
      get lastLine() { return v.lastLine; },
      get lastVoice() { return v.lastVoice; },
    };
  }

  const gate = document.createElement('div');
  gate.id = 'click-to-play';
  gate.textContent = 'Click to wake Bunker Sieben';
  overlay.appendChild(gate);
  const hideGate = () => { if (gate.parentNode) gate.remove(); };
  gate.addEventListener('click', startAudio);
  addEventListener('keydown', startAudio, { once: false });
  canvas.addEventListener('mousedown', startAudio);

  booted = true;
  progress = 1;

  // Switching away mid-fight should not cost you six cities. Losing the pointer
  // lock already pauses (below), but a player steering with the cursor never had
  // a lock to lose, and on that path the run just kept going out of sight.
  const pauseIfPlaying = () => {
    if (game.state === STATE.PLAY) {
      game.setState(STATE.PAUSE);
      game.sound.duck(0.9);
    }
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') pauseIfPlaying();
  });
  addEventListener('blur', pauseIfPlaying);

  input.onUnlock = () => {
    if (game.state === STATE.PLAY) {
      game.setState(STATE.PAUSE);
      // Escape both drops the pointer lock and registers as a key. Without this
      // the pause menu reads the same press on the next frame and resumes, so
      // the one thing Escape reliably did was nothing.
      input.consume('escape');
      input.consume('pause');
    }
  };

  // ------------------------------------------------------------- the loop

  let last = performance.now();
  let smoothedCpu = 16.7;
  let smoothedFrame = 16.7;
  let resCooldown = 2;

  // A frame that throws must not take the whole run with it. One bad frame is
  // survivable — the next one usually redraws over it — but a frame that fails
  // every time it runs is a broken build, and that earns the boot screen.
  let sickFrames = 0;
  function loop(now) {
    requestAnimationFrame(loop);
    try {
      frameBody(now);
      sickFrames = 0;
    } catch (e) {
      if (++sickFrames === 1 || sickFrames % 120 === 0) console.error('[frame]', e);
      if (sickFrames === 120 && window.__NUKEHAUS_FATAL__) window.__NUKEHAUS_FATAL__(e);
    }
  }

  function frameBody(now) {
    let dt = (now - last) / 1000;
    last = now;
    if (dt > 0.1) dt = 0.1;      // a tab that was backgrounded must not teleport anyone
    if (dt <= 0) dt = 1 / 240;

    const t0 = performance.now();
    sizeCanvas();
    input.update(dt);          // poll the gamepad before anything reads actions
    // The music sequencer has to be ticked in every state, not just gameplay,
    // or the title theme never advances past its first 150ms of lookahead.
    game.sound.update(dt);

    // --------------------------------------------------------- update
    if (game.state === STATE.TITLE) {
      const r = title.update(dt, input, game);
      if (r) {
        if (r.action === 'move') game.sound.sfx('ui_move');
        else if (r.action === 'select') game.sound.sfx('ui_select');
        else if (r.action === 'back') game.sound.sfx('ui_back');
        else if (r.action === 'start') {
          game.sound.sfx('ui_start');
          game.sound.stopMusic(0.7);
          game.newGame(r.difficulty);
          input.requestLock();
        }
      }
    } else {
      game.update(dt, input);
      if (game.pendingState === 'title') {
        game.pendingState = null;
        game.setState(STATE.TITLE);
        title.reset();
        input.releaseLock();
        game.sound.stopMusic(0.5);
        game.sound.music('title', { fadeIn: 1.6 });
      }
      if (game.state === STATE.PLAY && !input.locked && input.mousePressed & 1) input.requestLock();
    }

    // --------------------------------------------------------- render
    sizeInternal();
    if (game.state === STATE.TITLE) {
      title.draw(frame, iw, ih, game);
    } else {
      game.rc.resize(iw, ih);
      renderWorld(game, iw, ih);
      frame.set(game.rc.buf);
      if (game.state !== STATE.GAMEOVER || game.overT < 0.8) drawViewmodel(game, frame, iw, ih);
      // The HUD belongs to gameplay; the full-screen cards own the frame outright.
      if (game.state === STATE.PLAY || game.state === STATE.PAUSE) {
        game.hud.draw(frame, iw, ih, game);
      }
      if (game.state === STATE.BRIEF) drawBrief(game, frame, iw, ih);
      else if (game.state === STATE.PAUSE) drawPause(game, frame, iw, ih);
      else if (game.state === STATE.INTERMISSION) drawIntermission(game, frame, iw, ih);
      else if (game.state === STATE.GAMEOVER) drawGameOver(game, frame, iw, ih);
      else if (game.state === STATE.VICTORY) drawVictory(game, frame, iw, ih);
    }
    post.present(frame, iw, ih, now / 1000);
    input.endFrame();

    // ------------------------------------------------ adaptive resolution
    const spent = performance.now() - t0;
    smoothedCpu = smoothedCpu * 0.92 + spent * 0.08;
    smoothedFrame = smoothedFrame * 0.9 + dt * 1000 * 0.1;
    resCooldown -= dt;
    if (!game.resLocked && resCooldown <= 0) {
      // Adapt on the real frame interval, not just our own CPU slice, so a slow
      // GPU pushes the resolution down too. Above vsync means we're missing.
      if (smoothedFrame > 21 && resScale > 0.55) {
        resScale = Math.max(0.55, resScale - 0.12); resCooldown = 1.8;
      } else if (smoothedFrame < 17.6 && smoothedCpu < 9 && resScale < 1.3) {
        resScale = Math.min(1.3, resScale + 0.06); resCooldown = 2.4;
      }
      game.resScale = resScale;
    } else if (game.resLocked) {
      resScale = game.resScale;
    }
    game.frameMs = smoothedCpu;
    game.frameDelta = smoothedFrame;
  }
  requestAnimationFrame(loop);

  // Handy for poking at the game from the console or a test harness.
  window.NUKEHAUS = { game, title, input, post, art, booted: true,
    // Render one world frame on demand, so a harness can assert on what the
    // raycaster actually produced rather than on the state that fed it.
    renderOnce: () => { renderWorld(game, iw, ih); return game.rc; },
    get frame() { return frame; }, get size() { return [iw, ih]; } };
}
