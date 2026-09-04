// input.js - keyboard, mouse, pointer lock and gamepad, normalised into one
// poll-able object. Everything ends up in the same logical action sets, so the
// game never asks where a button came from.
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
  KeyV: 'kick', KeyB: 'bomb', KeyG: 'bomb',
  Digit1: 'slot1', Digit2: 'slot2', Digit3: 'slot3', Digit4: 'slot4',
  Digit5: 'slot5', Digit6: 'slot6',
};

/**
 * Standard-layout gamepad mapping. Xbox and DualShock/DualSense both report
 * this layout in Chrome and Safari, so one table covers them.
 */
const PAD_BUTTONS = {
  0: 'use',          // A / Cross
  1: 'autoFuse',     // B / Circle
  2: 'bomb',         // X / Square
  3: 'kick',         // Y / Triangle
  4: 'weapPrev',     // LB / L1
  5: 'weapNext',     // RB / R1
  6: 'fineAim',      // LT / L2  (analog, see below)
  7: 'fire',         // RT / R2  (analog)
  8: 'map',          // Back / Share
  9: 'pause',        // Start / Options
  10: 'run',         // L3
  11: 'kick',        // R3
  12: 'fuseUp',      // D-pad up
  13: 'fuseDown',    // D-pad down
  14: 'weapPrev',    // D-pad left
  15: 'weapNext',    // D-pad right
};

// D-pad and face buttons double as menu navigation. These are MENU-ONLY aliases
// and never reach the gameplay action sets: folding them in meant B/Circle fired
// `autoFuse` and `escape` together (and updatePlay reads escape first, so the
// auto-ranger toggle paused the game), and the d-pad walked the player while it
// dialled the fuse. Read them through menuJustPressed().
const PAD_MENU = { 12: 'up', 13: 'down', 14: 'left', 15: 'right', 0: 'confirm', 1: 'escape', 9: 'confirm' };

const TRIGGER_ON = 0.42;   // analog trigger press threshold
const STICK_DEAD = 0.18;

function curve(v, dead) {
  const a = Math.abs(v);
  if (a < dead) return 0;
  const t = (a - dead) / (1 - dead);
  // Squared response: fine control near centre, full authority at the rim.
  return Math.sign(v) * t * t;
}

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.down = new Set();
    this.pressed = new Set();
    this.released = new Set();
    this.rawDown = new Set();
    this.rawPressed = new Set();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
    this.mouseButtons = 0;
    this.mousePressed = 0;
    this.mouseX = 0.5;
    this.mouseY = 0.5;
    this.mouseMoved = false;
    this.locked = false;
    this.sensitivity = 1.0;
    this.invertY = false;

    // Gamepad state
    this.pad = null;              // the live Gamepad object, or null
    this.padIndex = -1;
    this.padName = '';
    this.padKind = '';            // 'xbox' | 'playstation' | 'generic'
    this.padDown = new Set();
    this.padMenuDown = new Set();   // menu-only aliases the pad is holding
    this.menuEdge = new Set();      // menu-only edges for this frame
    this.padMoveX = 0; this.padMoveY = 0;
    this.padLookX = 0; this.padLookY = 0;
    this.padFire = 0;             // analog trigger, 0..1
    this.padFine = 0;
    this.padSeen = false;         // has any pad ever been used?
    this.padActive = false;       // was the pad the most recent input?
    this.lookScale = 1;
    this._rumbleUntil = 0;
    this._bind();
  }

  _bind() {
    const stopKeys = new Set(['Tab', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Slash', 'Quote']);
    addEventListener('keydown', (e) => {
      if (stopKeys.has(e.code)) e.preventDefault();
      if (e.repeat) return;
      this.rawDown.add(e.code);
      this.rawPressed.add(e.code);
      this.padActive = false;
      const a = KEY_ALIASES[e.code];
      if (a && !this.down.has(a)) { this.down.add(a); this.pressed.add(a); }
    });
    addEventListener('keyup', (e) => {
      this.rawDown.delete(e.code);
      const a = KEY_ALIASES[e.code];
      if (a && !this.padDown.has(a)) { this.down.delete(a); this.released.add(a); }
    });
    addEventListener('blur', () => {
      this.down.clear(); this.rawDown.clear(); this.padDown.clear(); this.mouseButtons = 0;
    });

    this.canvas.addEventListener('mousedown', (e) => {
      this.mouseButtons |= 1 << e.button;
      this.mousePressed |= 1 << e.button;
      this.padActive = false;
      if (e.button === 0) { this.down.add('fire'); this.pressed.add('fire'); }
      if (e.button === 2) { this.down.add('altfire'); this.pressed.add('altfire'); }
      if (e.button === 1) { this.down.add('kick'); this.pressed.add('kick'); }
    });
    addEventListener('mouseup', (e) => {
      this.mouseButtons &= ~(1 << e.button);
      if (e.button === 0 && !this.padDown.has('fire')) { this.down.delete('fire'); this.released.add('fire'); }
      if (e.button === 2) { this.down.delete('altfire'); this.released.add('altfire'); }
      if (e.button === 1 && !this.padDown.has('kick')) this.down.delete('kick');
    });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    addEventListener('mousemove', (e) => {
      const r = this.canvas.getBoundingClientRect();
      this.mouseX = (e.clientX - r.left) / r.width;
      this.mouseY = (e.clientY - r.top) / r.height;
      this.mouseMoved = true;
      if (this.locked) {
        this.mouseDX += e.movementX || 0;
        this.mouseDY += e.movementY || 0;
        if (e.movementX || e.movementY) this.padActive = false;
      }
    });
    addEventListener('wheel', (e) => {
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
      this.wheel += clamp((e.deltaY * unit) / 100, -3, 3);
      if (this.locked) e.preventDefault();
    }, { passive: false });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) this.onUnlock && this.onUnlock();
    });

    addEventListener('gamepadconnected', (e) => {
      this.padIndex = e.gamepad.index;
      this.padName = e.gamepad.id || 'controller';
      this.padKind = classifyPad(this.padName);
      this.padSeen = true;
      this.onPadConnected && this.onPadConnected(this.padName, this.padKind);
    });
    addEventListener('gamepaddisconnected', (e) => {
      if (e.gamepad.index === this.padIndex) { this.padIndex = -1; this.pad = null; this._releasePad(); }
    });
  }

  // ------------------------------------------------------------- gamepad

  /** Poll the pad and fold it into the logical action sets. Call once per frame. */
  update(dt) {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let gp = this.padIndex >= 0 ? pads[this.padIndex] : null;
    if (!gp) {
      for (const p of pads) {
        if (p && p.connected) {
          gp = p; this.padIndex = p.index;
          if (!this.padName) { this.padName = p.id || 'controller'; this.padKind = classifyPad(this.padName); }
          this.padSeen = true;
          break;
        }
      }
    }
    this.pad = gp || null;
    if (!gp) {
      this.padMoveX = this.padMoveY = this.padLookX = this.padLookY = 0; this.padFire = 0;
      // A pad that vanished mid-hold must let go of what it was holding, or
      // losing power with the trigger down leaves `fire` stuck on forever.
      this._releasePad();
      return;
    }

    const ax = gp.axes || [];
    const bt = gp.buttons || [];
    const val = (i) => (bt[i] ? (typeof bt[i].value === 'number' ? bt[i].value : (bt[i].pressed ? 1 : 0)) : 0);
    const held = (i) => (bt[i] ? (bt[i].pressed || val(i) > TRIGGER_ON) : false);

    this.padMoveX = curve(ax[0] || 0, STICK_DEAD);
    this.padMoveY = curve(ax[1] || 0, STICK_DEAD);
    this.padLookX = curve(ax[2] || 0, STICK_DEAD);
    this.padLookY = curve(ax[3] || 0, STICK_DEAD);
    this.padFire = val(7);
    this.padFine = val(6);

    // Any meaningful pad input takes over the on-screen prompts.
    const busy = Math.abs(this.padMoveX) + Math.abs(this.padMoveY) +
                 Math.abs(this.padLookX) + Math.abs(this.padLookY) > 0.02;
    let anyButton = false;

    const nextDown = new Set();
    for (const i in PAD_BUTTONS) {
      if (held(+i)) { nextDown.add(PAD_BUTTONS[i]); anyButton = true; }
    }
    // Menu actions come from the same buttons, plus the left stick as a d-pad.
    // They land in their own edge set, not in the gameplay ones.
    if (this._menuRepeat === undefined) this._menuRepeat = 0;
    this._menuRepeat -= dt;
    const stickMenu = [];
    if (this.padMoveY < -0.55) stickMenu.push('up');
    if (this.padMoveY > 0.55) stickMenu.push('down');
    if (this.padMoveX < -0.55) stickMenu.push('left');
    if (this.padMoveX > 0.55) stickMenu.push('right');
    const nextMenu = new Set();
    for (const i in PAD_MENU) if (held(+i)) { nextMenu.add(PAD_MENU[i]); anyButton = true; }
    for (const a of nextMenu) if (!this.padMenuDown.has(a)) this.menuEdge.add(a);
    this.padMenuDown = nextMenu;
    if (stickMenu.length) {
      if (this._menuRepeat <= 0) {
        for (const a of stickMenu) { this.menuEdge.add(a); this.padActive = true; }
        this._menuRepeat = this._menuHeld ? 0.16 : 0.42;
        this._menuHeld = true;
      }
    } else { this._menuHeld = false; this._menuRepeat = 0; }

    for (const a of nextDown) {
      if (!this.padDown.has(a)) { this.pressed.add(a); }
      this.down.add(a);
    }
    for (const a of this.padDown) {
      if (!nextDown.has(a)) {
        this.released.add(a);
        // Don't clear an action the keyboard or mouse is also holding.
        if (!this._keyHolds(a)) this.down.delete(a);
      }
    }
    this.padDown = nextDown;
    if (busy || anyButton) { this.padActive = true; this.padSeen = true; }

    // Fine-aim trigger halves look speed for the fuse game.
    this.lookScale = 1 - this.padFine * 0.62;
  }

  _keyHolds(action) {
    for (const code in KEY_ALIASES) {
      if (KEY_ALIASES[code] === action && this.rawDown.has(code)) return true;
    }
    if (action === 'fire' && (this.mouseButtons & 1)) return true;
    if (action === 'altfire' && (this.mouseButtons & 4)) return true;
    return false;
  }

  /** Short rumble. Silently does nothing on pads or browsers without it. */
  rumble(strong = 0.5, weak = 0.3, ms = 120) {
    const gp = this.pad;
    if (!gp) return;
    const act = gp.vibrationActuator || (gp.hapticActuators && gp.hapticActuators[0]);
    if (!act || !act.playEffect) return;
    const now = performance.now();
    if (now < this._rumbleUntil - 30) return;   // don't stack into a buzz
    this._rumbleUntil = now + ms;
    try {
      act.playEffect('dual-rumble', {
        startDelay: 0, duration: Math.min(600, ms),
        strongMagnitude: clamp(strong, 0, 1), weakMagnitude: clamp(weak, 0, 1),
      });
    } catch { /* older actuator API, or no permission */ }
  }

  requestLock() {
    if (this.locked) return;
    const p = this.canvas.requestPointerLock({ unadjustedMovement: true });
    if (p && p.catch) p.catch(() => { try { this.canvas.requestPointerLock(); } catch { /* ignore */ } });
  }

  releaseLock() { if (document.pointerLockElement) document.exitPointerLock(); }

  isDown(a) { return this.down.has(a); }
  justPressed(a) { return this.pressed.has(a); }
  /**
   * A menu-context edge: the keyboard's own actions plus the pad's menu-only
   * aliases. Front-end screens read this; gameplay reads justPressed and so
   * never sees the d-pad or B/Circle wearing their menu hats.
   */
  menuJustPressed(a) { return this.pressed.has(a) || this.menuEdge.has(a); }
  /** Swallow an edge so two consumers cannot both act on one press. */
  consume(a) { this.pressed.delete(a); this.menuEdge.delete(a); }

  /** Drop everything the pad was holding, without stealing the keyboard's. */
  _releasePad() {
    for (const a of this.padDown) {
      this.released.add(a);
      if (!this._keyHolds(a)) this.down.delete(a);
    }
    this.padDown.clear();
    this.padMenuDown.clear();
    this._menuHeld = false; this._menuRepeat = 0;
    this.lookScale = 1;
    this.padFine = 0;
  }
  justReleased(a) { return this.released.has(a); }
  rawJustPressed(code) { return this.rawPressed.has(code); }
  anyPressed() {
    return this.rawPressed.size > 0 || this.mousePressed !== 0 ||
           this.pressed.size > 0 || this.menuEdge.size > 0;
  }

  /** Movement axes, -1..1, combining WASD, arrows and the left stick. */
  axes() {
    let fwd = 0, str = 0, turn = 0;
    if (this.down.has('up')) fwd += 1;
    if (this.down.has('down')) fwd -= 1;
    if (this.down.has('strafeRight')) str += 1;
    if (this.down.has('strafeLeft')) str -= 1;
    // Q/E and the left/right arrows both alias to these. Reading the raw codes
    // meant the advertised arrow scheme had working forward/back and dead turns.
    if (this.down.has('left')) turn -= 1;
    if (this.down.has('right')) turn += 1;
    str += this.padMoveX;
    fwd -= this.padMoveY;
    const run = this.down.has('run') || Math.hypot(this.padMoveX, this.padMoveY) > 0.86;
    return {
      fwd: clamp(fwd, -1, 1),
      strafe: clamp(str, -1, 1),
      turn: clamp(turn, -1, 1),
      run,
    };
  }

  /** True when the fire control is held, including the analog trigger. */
  firing() { return this.down.has('fire') || this.padFire > TRIGGER_ON; }

  /** Consume this frame's edge-triggered state. Call once at the end of each update. */
  endFrame() {
    this.pressed.clear();
    this.menuEdge.clear();
    this.released.clear();
    this.rawPressed.clear();
    this.mousePressed = 0;
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
  }
}

function classifyPad(id) {
  const s = (id || '').toLowerCase();
  if (/dualsense|dualshock|playstation|sony|054c/.test(s)) return 'playstation';
  if (/xbox|xinput|045e/.test(s)) return 'xbox';
  return 'generic';
}

/** Button glyphs per family, for on-screen prompts. */
export const PAD_GLYPHS = {
  xbox: { a: 'A', b: 'B', x: 'X', y: 'Y', lb: 'LB', rb: 'RB', lt: 'LT', rt: 'RT', start: 'MENU', back: 'VIEW' },
  playstation: { a: '✕', b: '○', x: '□', y: '△', lb: 'L1', rb: 'R1', lt: 'L2', rt: 'R2', start: 'OPTIONS', back: 'SHARE' },
  generic: { a: 'A', b: 'B', x: 'X', y: 'Y', lb: 'L1', rb: 'R1', lt: 'L2', rt: 'R2', start: 'START', back: 'SELECT' },
};
