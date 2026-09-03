// input.js - keyboard, mouse, pointer lock, and gamepad, normalised into one poll-able object.
import { clamp } from './math.js';

const KEY_ALIASES = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  KeyW: 'up', KeyS: 'down', KeyA: 'strafeLeft', KeyD: 'strafeRight',
  KeyQ: 'left', KeyE: 'right',
  Space: 'use', KeyF: 'use', Enter: 'confirm', Escape: 'escape',
  ShiftLeft: 'run', ShiftRight: 'run', ControlLeft: 'fire', ControlRight: 'fire',
  KeyR: 'reload', Tab: 'map', KeyM: 'map', KeyP: 'pause',
  BracketLeft: 'fuseDown', BracketRight: 'fuseUp',
  KeyZ: 'fuseDown', KeyX: 'fuseUp', KeyC: 'autoFuse',
  Digit1: 'slot1', Digit2: 'slot2', Digit3: 'slot3', Digit4: 'slot4', Digit5: 'slot5',
};

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.down = new Set();          // logical action names currently held
    this.pressed = new Set();       // actions that went down this frame
    this.released = new Set();
    this.rawDown = new Set();       // physical codes, for menus that want any-key
    this.rawPressed = new Set();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
    this.mouseButtons = 0;
    this.mousePressed = 0;
    this.mouseX = 0;
    this.mouseY = 0;
    this.locked = false;
    this.sensitivity = 1.0;
    this.invertY = false;
    this.anyInputSinceLastCheck = false;
    this._bind();
  }

  _bind() {
    const stopKeys = new Set(['Tab', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Slash', 'Quote']);
    addEventListener('keydown', (e) => {
      if (stopKeys.has(e.code)) e.preventDefault();
      if (e.repeat) return;
      this.rawDown.add(e.code);
      this.rawPressed.add(e.code);
      this.anyInputSinceLastCheck = true;
      const a = KEY_ALIASES[e.code];
      if (a && !this.down.has(a)) { this.down.add(a); this.pressed.add(a); }
    });
    addEventListener('keyup', (e) => {
      this.rawDown.delete(e.code);
      const a = KEY_ALIASES[e.code];
      if (a) { this.down.delete(a); this.released.add(a); }
    });
    addEventListener('blur', () => { this.down.clear(); this.rawDown.clear(); this.mouseButtons = 0; });

    this.canvas.addEventListener('mousedown', (e) => {
      this.mouseButtons |= 1 << e.button;
      this.mousePressed |= 1 << e.button;
      this.anyInputSinceLastCheck = true;
      if (e.button === 0) { this.down.add('fire'); this.pressed.add('fire'); }
      if (e.button === 2) { this.down.add('altfire'); this.pressed.add('altfire'); }
    });
    addEventListener('mouseup', (e) => {
      this.mouseButtons &= ~(1 << e.button);
      if (e.button === 0) { this.down.delete('fire'); this.released.add('fire'); }
      if (e.button === 2) { this.down.delete('altfire'); this.released.add('altfire'); }
    });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    addEventListener('mousemove', (e) => {
      const r = this.canvas.getBoundingClientRect();
      this.mouseX = (e.clientX - r.left) / r.width;
      this.mouseY = (e.clientY - r.top) / r.height;
      if (this.locked) {
        this.mouseDX += e.movementX || 0;
        this.mouseDY += e.movementY || 0;
      }
    });
    addEventListener('wheel', (e) => {
      // Normalise across trackpads (small px deltas) and wheels (big line deltas).
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
      this.wheel += clamp((e.deltaY * unit) / 100, -3, 3);
      if (this.locked) e.preventDefault();
    }, { passive: false });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) this.onUnlock && this.onUnlock();
    });
  }

  requestLock() {
    if (this.locked) return;
    const p = this.canvas.requestPointerLock({ unadjustedMovement: true });
    if (p && p.catch) p.catch(() => { try { this.canvas.requestPointerLock(); } catch { /* ignore */ } });
  }

  releaseLock() { if (document.pointerLockElement) document.exitPointerLock(); }

  isDown(a) { return this.down.has(a); }
  justPressed(a) { return this.pressed.has(a); }
  justReleased(a) { return this.released.has(a); }
  rawJustPressed(code) { return this.rawPressed.has(code); }
  anyPressed() { return this.rawPressed.size > 0 || this.mousePressed !== 0; }

  /** Movement axes, -1..1, combining WASD and arrows. */
  axes() {
    let fwd = 0, str = 0, turn = 0;
    if (this.down.has('up')) fwd += 1;
    if (this.down.has('down')) fwd -= 1;
    if (this.down.has('strafeRight')) str += 1;
    if (this.down.has('strafeLeft')) str -= 1;
    if (this.down.has('right')) turn += 1;
    if (this.down.has('left')) turn -= 1;
    const gp = navigator.getGamepads && navigator.getGamepads()[0];
    if (gp) {
      const dz = (v) => (Math.abs(v) < 0.18 ? 0 : v);
      str += dz(gp.axes[0] || 0);
      fwd -= dz(gp.axes[1] || 0);
      this.padLookX = dz(gp.axes[2] || 0);
      this.padLookY = dz(gp.axes[3] || 0);
      if (gp.buttons[7] && gp.buttons[7].pressed) this.down.add('fire'); else if (!(this.mouseButtons & 1)) this.down.delete('fire');
    } else { this.padLookX = 0; this.padLookY = 0; }
    return {
      fwd: clamp(fwd, -1, 1),
      strafe: clamp(str, -1, 1),
      turn: clamp(turn, -1, 1),
      run: this.down.has('run'),
    };
  }

  /** Consume this frame's edge-triggered state. Call once at the end of each update. */
  endFrame() {
    this.pressed.clear();
    this.released.clear();
    this.rawPressed.clear();
    this.mousePressed = 0;
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
  }
}
