// boot-shell.js - the part of NUKEHAUS that has to work when nothing else does.
//
// Loaded as its own classic <script> before the game, in both the dev page and
// the single-file build, and written in plain ES5 on purpose: if the game
// script fails to parse or throws during boot on some browser, this is what
// still runs, and it is the only way a player can tell us what happened.
//
// It owns three things:
//   - the full-screen boot failure sign, with a diagnostics block the player
//     can copy, a Safe Mode button and a reload button;
//   - a small corner notice for stray runtime errors once the game is up,
//     because a running game must not be covered by a sign saying it never
//     booted;
//   - a watchdog that turns a silent stall (no error, just a loading screen
//     forever) into a message naming the stage it reached.
(function () {
  'use strict';

  var shown = false;
  var glitches = 0;
  var glitchTimer = 0;
  var started = Date.now();

  function booted() { return !!(window.NUKEHAUS && window.NUKEHAUS.booted); }

  function text(err) {
    if (!err) return 'Unknown error';
    if (typeof err === 'string') return err;
    return err.stack || err.message || String(err);
  }

  function gpuInfo() {
    try {
      var c = document.createElement('canvas');
      var gl = c.getContext('webgl2');
      var kind = 'webgl2';
      if (!gl) { gl = c.getContext('webgl'); kind = 'webgl1 only'; }
      if (!gl) return 'no WebGL';
      var ext = gl.getExtension('WEBGL_debug_renderer_info');
      var r = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      var f = gl.getExtension('EXT_color_buffer_float') ? ' +float' : '';
      var h = gl.getExtension('EXT_color_buffer_half_float') ? ' +half' : '';
      var lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
      return kind + ' / ' + r + f + h;
    } catch (e) {
      return 'probe threw: ' + (e && e.message);
    }
  }

  function padInfo() {
    try {
      var list = navigator.getGamepads ? navigator.getGamepads() : [];
      var out = [];
      for (var i = 0; i < list.length; i++) {
        var p = list[i];
        if (p && p.connected) out.push((p.id || 'pad') + ' [' + (p.mapping || 'no mapping') + ']');
      }
      return out.length ? out.join('; ') : 'none';
    } catch (e) { return 'unreadable'; }
  }

  function diag() {
    var stage = window.NUKEHAUS_BOOT;
    var render = window.NUKEHAUS_RENDER;
    return [
      'browser  : ' + navigator.userAgent,
      'screen   : ' + window.innerWidth + 'x' + window.innerHeight + ' @' + (window.devicePixelRatio || 1) + 'x',
      'visible  : ' + (document.visibilityState || '?'),
      'stage    : ' + (stage ? stage.stage + ' (' + stage.at + 'ms)' : 'before boot'),
      'render   : ' + (render ? render.mode + (render.why ? ' (' + render.why + ')' : '') + (render.safe ? ' [safe mode]' : '') : 'not chosen yet'),
      'gpu      : ' + gpuInfo(),
      'pads     : ' + padInfo(),
      'uptime   : ' + ((Date.now() - started) / 1000).toFixed(1) + 's',
      'page     : ' + location.href,
    ].join('\n');
  }

  function button(label, onClick) {
    var b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'margin:18px 12px 0 0;padding:10px 18px;font:inherit;letter-spacing:.2em;' +
      'color:#0a0208;background:#ffcf5c;border:0;cursor:pointer;';
    b.addEventListener('click', onClick);
    return b;
  }

  function fatal(err) {
    console.error(err);
    var el = document.getElementById('fatal');
    var body = document.getElementById('fatal-body');
    if (!el || !body) return;
    var report = text(err) + '\n\n--- details (please send these) ---\n' + diag();
    body.textContent = report;
    if (!shown) {
      shown = true;
      var row = document.createElement('div');
      var safe = /[?&]safe\b/.test(location.search);
      if (!safe) {
        row.appendChild(button('TRY SAFE MODE', function () {
          location.search = (location.search ? location.search + '&' : '?') + 'safe';
        }));
      }
      row.appendChild(button('RELOAD', function () { location.reload(); }));
      row.appendChild(button('COPY DETAILS', function () {
        var done = function () { this.textContent = 'COPIED'; }.bind(this);
        var current = body.textContent;
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(current).then(done, function () { selectBody(); });
          } else selectBody();
        } catch (e) { selectBody(); }
      }));
      el.appendChild(row);
      var note = document.createElement('div');
      note.style.cssText = 'margin-top:14px;color:#9a8a7c;';
      note.textContent = safe
        ? 'Already in Safe Mode. The details above are what is needed to fix this.'
        : 'Safe Mode runs the game without GPU effects, audio or controller support.';
      el.appendChild(note);
    }
    el.style.display = 'block';
  }

  function selectBody() {
    var body = document.getElementById('fatal-body');
    if (!body || !window.getSelection) return;
    var r = document.createRange();
    r.selectNodeContents(body);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }

  function glitch(err) {
    console.error(err);
    var el = document.getElementById('glitch');
    if (!el) return;
    el.textContent = 'HAIRLINE FRACTURE (' + (++glitches) + ') - ' + String(text(err)).split('\n')[0];
    el.style.display = 'block';
    clearTimeout(glitchTimer);
    glitchTimer = setTimeout(function () { el.style.display = 'none'; }, 6000);
  }

  function report(err) { (booted() ? glitch : fatal)(err); }

  window.addEventListener('error', function (e) {
    // A failed <script> load or a syntax error arrives here with no e.error.
    report(e.error || (e.message ? e.message + (e.filename ? ' (' + e.filename + ':' + e.lineno + ')' : '') : e));
  });
  window.addEventListener('unhandledrejection', function (e) { report(e.reason); });

  // Slowest plausible load is ~20s in a throttled background tab.
  setTimeout(function () {
    if (booted() || shown) return;
    var at = window.NUKEHAUS_BOOT;
    fatal('Loading stalled' + (at ? ' at "' + at.stage + '" (' + at.at + 'ms in).' : ' before the first stage.') +
      '\nIf this tab was in the background, bring it to the front and reload.');
  }, 45000);

  window.__NUKEHAUS_FATAL__ = fatal;
  window.NUKEHAUS_SHELL = { fatal: fatal, report: report, diag: diag };
  window.NUKEHAUS_DIAG = function () { var d = diag(); console.log(d); return d; };
})();
