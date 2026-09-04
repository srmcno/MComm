// post.js - takes the software framebuffer to the GPU and finishes the image.
//
// The raycaster gives us an honest, chunky, 1993-shaped picture. This stage is
// what makes it look like 1993 remembered rather than 1993 endured: two-level
// bloom, chromatic aberration, barrel warp, scanlines, vignette, grain, and the
// screen-wide flash/damage tints the game drives.
//
// Falls back to a plain 2D blit if WebGL2 isn't available, so the game always runs.

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG_BRIGHT = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uTex;
uniform float uThreshold, uKnee;
void main() {
  vec3 c = texture(uTex, vUv).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  // Soft knee so bloom eases in instead of popping at the threshold.
  float s = clamp((l - uThreshold + uKnee) / (2.0 * uKnee), 0.0, 1.0);
  float w = max(s * s * uKnee, max(l - uThreshold, 0.0)) / max(l, 1e-4);
  o = vec4(c * w, 1.0);
}`;

const FRAG_BLUR = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uTex;
uniform vec2 uDir;      // texel-sized step
void main() {
  // 9-tap gaussian, linear-sampling weights.
  vec3 c = texture(uTex, vUv).rgb * 0.227027;
  c += texture(uTex, vUv + uDir * 1.3846).rgb * 0.316216;
  c += texture(uTex, vUv - uDir * 1.3846).rgb * 0.316216;
  c += texture(uTex, vUv + uDir * 3.2308).rgb * 0.070270;
  c += texture(uTex, vUv - uDir * 3.2308).rgb * 0.070270;
  o = vec4(c, 1.0);
}`;

const FRAG_COMPOSITE = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uScene, uBloomA, uBloomB;
uniform vec2  uRes;
uniform float uTime;
uniform float uBloom;        // bloom strength
uniform float uAberration;   // chromatic aberration in pixels at the edge
uniform float uBarrel;       // lens distortion
uniform float uScan;         // scanline depth
uniform float uGrain;
uniform float uVignette;
uniform float uFlash;        // full-screen additive flash
uniform vec3  uFlashCol;
uniform float uDamage;       // red edge pulse when hurt
uniform float uSat;
uniform float uWarp;         // heat shimmer / shockwave amount
uniform vec2  uWarpCentre;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

void main() {
  vec2 uv = vUv;
  vec2 c = uv - 0.5;
  float r2 = dot(c, c);

  // Barrel distortion, then a radial shockwave ripple on top of it.
  uv = 0.5 + c * (1.0 + uBarrel * r2);
  if (uWarp > 0.001) {
    vec2 d = uv - uWarpCentre;
    float dl = length(d) + 1e-5;
    float ring = sin(dl * 42.0 - uTime * 9.0) * exp(-dl * 5.0);
    uv += (d / dl) * ring * uWarp * 0.035;
  }

  if (uv.x < -0.02 || uv.x > 1.02 || uv.y < -0.02 || uv.y > 1.02) {
    o = vec4(0.0, 0.0, 0.0, 1.0); return;
  }
  uv = clamp(uv, 0.0, 1.0);

  // Chromatic aberration grows toward the edges, like a cheap lens.
  vec2 ca = c * (uAberration / uRes.x) * (0.35 + r2 * 2.4);
  vec3 col;
  col.r = texture(uScene, clamp(uv + ca, 0.0, 1.0)).r;
  col.g = texture(uScene, uv).g;
  col.b = texture(uScene, clamp(uv - ca, 0.0, 1.0)).b;

  vec3 bloom = texture(uBloomA, uv).rgb * 0.62 + texture(uBloomB, uv).rgb * 0.98;
  col += bloom * uBloom;

  // Filmic-ish tone curve. Keeps the highlights of an airburst from going flat white.
  col = (col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14);

  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(lum), col, uSat);

  // Aperture-grille scanlines, softened so they don't alias into moire.
  float sl = sin(uv.y * uRes.y * 3.14159);
  col *= 1.0 - uScan * 0.5 * (0.5 + 0.5 * sl * sl);
  float slot = 0.5 + 0.5 * cos(uv.x * uRes.x * 3.14159 * 0.5);
  col *= 1.0 - uScan * 0.16 * slot;

  col *= 1.0 - uVignette * smoothstep(0.18, 0.92, r2 * 2.0);

  if (uDamage > 0.001) {
    float edge = smoothstep(0.06, 0.75, r2 * 2.2);
    col = mix(col, vec3(0.72, 0.03, 0.05), edge * uDamage);
  }

  col += uFlashCol * uFlash;

  float g = hash(uv * uRes + fract(uTime) * 137.0) - 0.5;
  col += g * uGrain;

  o = vec4(col, 1.0);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error('shader: ' + gl.getShaderInfoLog(s) + '\n' + src);
  }
  return s;
}

function program(gl, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, 'aPos');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    u[info.name] = gl.getUniformLocation(p, info.name);
  }
  return { p, u };
}

class Target {
  constructor(gl, w, h) {
    this.gl = gl; this.w = w; this.h = h;
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
  }
  dispose() { this.gl.deleteTexture(this.tex); this.gl.deleteFramebuffer(this.fbo); }
}

export class Post {
  constructor(canvas) {
    this.canvas = canvas;
    this.enabled = true;
    this.settings = {
      bloom: 0.85, aberration: 2.6, barrel: 0.055, scan: 0.30,
      grain: 0.035, vignette: 0.62, sat: 1.06,
    };
    this.flash = 0; this.flashCol = [1, 0.95, 0.85];
    this.damage = 0; this.warp = 0; this.warpCentre = [0.5, 0.5];
    // Probe on a throwaway canvas first. A canvas keeps the first context type
    // it is given for life, so binding the real one to webgl2 and only THEN
    // discovering a missing capability is fatal: getContext('2d') afterwards
    // returns null and the 2D fallback has nothing to draw into.
    if (Post.webgl2Viable()) {
      try { this._initGL(); } catch (e) { console.warn('WebGL post unavailable:', e.message); this.gl = null; }
    }
    if (!this.gl) this._init2D();
  }

  /**
   * Compile the whole pipeline against a 2x2 scratch canvas. Returns false for
   * anything that would make _initGL throw, so the real canvas is never bound
   * to a context we cannot use.
   */
  static webgl2Viable() {
    let gl = null;
    try {
      const probe = document.createElement('canvas');
      probe.width = 2; probe.height = 2;
      gl = probe.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false });
      if (!gl) return false;
      if (!gl.getExtension('EXT_color_buffer_half_float') && !gl.getExtension('EXT_color_buffer_float')) return false;
      program(gl, FRAG_BRIGHT);
      program(gl, FRAG_BLUR);
      program(gl, FRAG_COMPOSITE);
      return true;
    } catch (e) {
      console.warn('WebGL post probe failed:', e && e.message);
      return false;
    } finally {
      if (gl) { const lose = gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext(); }
    }
  }

  _initGL() {
    const gl = this.canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: false, powerPreference: 'high-performance',
      preserveDrawingBuffer: false, desynchronized: true,
    });
    if (!gl) throw new Error('no webgl2');
    this.gl = gl;
    this.hasFloat = !!gl.getExtension('EXT_color_buffer_half_float') || !!gl.getExtension('EXT_color_buffer_float');
    if (!this.hasFloat) throw new Error('no float render targets');

    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.progBright = program(gl, FRAG_BRIGHT);
    this.progBlur = program(gl, FRAG_BLUR);
    this.progComp = program(gl, FRAG_COMPOSITE);

    this.sceneTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.sceneTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this._texW = 0; this._texH = 0;
    this.targets = null;
  }

  _init2D() {
    this.ctx2d = this.canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!this.ctx2d) {
      // Nothing left to draw with. Better a black screen than a crash on frame 1.
      console.warn('2D fallback unavailable: canvas already holds another context');
      this.enabled = false;
      return;
    }
    this.ctx2d.imageSmoothingEnabled = false;
    this._img = null;
  }

  _ensureTargets(w, h) {
    const gl = this.gl;
    if (this.targets && this.targets.w === w && this.targets.h === h) return;
    if (this.targets) for (const t of this.targets.list) t.dispose();
    const hw = Math.max(1, w >> 1), hh = Math.max(1, h >> 1);
    const qw = Math.max(1, w >> 2), qh = Math.max(1, h >> 2);
    const a = new Target(gl, hw, hh), b = new Target(gl, hw, hh);
    const cq = new Target(gl, qw, qh), d = new Target(gl, qw, qh);
    this.targets = { w, h, a, b, c: cq, d, list: [a, b, cq, d] };
  }

  _pass(prog, target, setup) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    const w = target ? target.w : this.canvas.width;
    const h = target ? target.h : this.canvas.height;
    gl.viewport(0, 0, w, h);
    gl.useProgram(prog.p);
    setup(prog.u);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** @param {Uint32Array} frame  internal-resolution framebuffer */
  present(frame, w, h, time) {
    if (this.gl) this._presentGL(frame, w, h, time);
    else this._present2D(frame, w, h);
  }

  _presentGL(frame, w, h, time) {
    const gl = this.gl;
    const bytes = new Uint8Array(frame.buffer, frame.byteOffset, w * h * 4);
    gl.bindTexture(gl.TEXTURE_2D, this.sceneTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    // The software framebuffer is top-down; GL textures are bottom-up. Flip once
    // here so every downstream pass shares one orientation.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    if (this._texW !== w || this._texH !== h) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
      this._texW = w; this._texH = h;
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    }

    if (!this.enabled) {
      this._pass(this.progComp, null, (u) => {
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.sceneTex);
        gl.uniform1i(u.uScene, 0);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.sceneTex);
        gl.uniform1i(u.uBloomA, 1); gl.uniform1i(u.uBloomB, 1);
        gl.uniform2f(u.uRes, this.canvas.width, this.canvas.height);
        gl.uniform1f(u.uTime, time);
        gl.uniform1f(u.uBloom, 0); gl.uniform1f(u.uAberration, 0);
        gl.uniform1f(u.uBarrel, 0); gl.uniform1f(u.uScan, 0);
        gl.uniform1f(u.uGrain, 0); gl.uniform1f(u.uVignette, 0.2);
        gl.uniform1f(u.uFlash, this.flash);
        gl.uniform3fv(u.uFlashCol, this.flashCol);
        gl.uniform1f(u.uDamage, this.damage); gl.uniform1f(u.uSat, 1);
        gl.uniform1f(u.uWarp, 0);
      gl.uniform2f(u.uWarpCentre, this.warpCentre[0], 1 - this.warpCentre[1]);
      });
      return;
    }

    this._ensureTargets(w, h);
    const T = this.targets;
    const S = this.settings;

    this._pass(this.progBright, T.a, (u) => {
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.sceneTex);
      gl.uniform1i(u.uTex, 0);
      gl.uniform1f(u.uThreshold, 0.62);
      gl.uniform1f(u.uKnee, 0.35);
    });
    const blur = (src, dst, dx, dy) => this._pass(this.progBlur, dst, (u) => {
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform1i(u.uTex, 0);
      gl.uniform2f(u.uDir, dx / dst.w, dy / dst.h);
    });
    blur(T.a, T.b, 1, 0); blur(T.b, T.a, 0, 1);
    // Second, wider level for the big soft halo around airbursts.
    blur(T.a, T.c, 1, 0); blur(T.c, T.d, 0, 1);
    blur(T.d, T.c, 1.8, 0); blur(T.c, T.d, 0, 1.8);

    this._pass(this.progComp, null, (u) => {
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.sceneTex);
      gl.uniform1i(u.uScene, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, T.a.tex);
      gl.uniform1i(u.uBloomA, 1);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, T.d.tex);
      gl.uniform1i(u.uBloomB, 2);
      gl.uniform2f(u.uRes, this.canvas.width, this.canvas.height);
      gl.uniform1f(u.uTime, time);
      gl.uniform1f(u.uBloom, S.bloom);
      gl.uniform1f(u.uAberration, S.aberration);
      gl.uniform1f(u.uBarrel, S.barrel);
      gl.uniform1f(u.uScan, S.scan);
      gl.uniform1f(u.uGrain, S.grain);
      gl.uniform1f(u.uVignette, S.vignette);
      gl.uniform1f(u.uSat, S.sat);
      gl.uniform1f(u.uFlash, this.flash);
      gl.uniform3fv(u.uFlashCol, this.flashCol);
      gl.uniform1f(u.uDamage, this.damage);
      gl.uniform1f(u.uWarp, this.warp);
      gl.uniform2f(u.uWarpCentre, this.warpCentre[0], 1 - this.warpCentre[1]);
    });
  }

  _present2D(frame, w, h) {
    const ctx = this.ctx2d;
    if (!ctx) return;
    if (!this._img || this._img.width !== w || this._img.height !== h) {
      this._img = new ImageData(new Uint8ClampedArray(frame.buffer.slice(0)), w, h);
      this._scratch = document.createElement('canvas');
      this._scratch.width = w; this._scratch.height = h;
      this._sctx = this._scratch.getContext('2d');
    }
    new Uint8ClampedArray(this._img.data.buffer).set(new Uint8Array(frame.buffer, frame.byteOffset, w * h * 4));
    this._sctx.putImageData(this._img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this._scratch, 0, 0, this.canvas.width, this.canvas.height);
    if (this.flash > 0.002) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = `rgba(${(this.flashCol[0] * 255) | 0},${(this.flashCol[1] * 255) | 0},${(this.flashCol[2] * 255) | 0},${Math.min(1, this.flash)})`;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.globalCompositeOperation = 'source-over';
    }
    if (this.damage > 0.002) {
      ctx.fillStyle = `rgba(180,10,14,${Math.min(0.75, this.damage * 0.6)})`;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }
}
