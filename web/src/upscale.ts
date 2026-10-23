/**
 * 本地超分渲染。
 *
 * 把 video 逐帧画到 WebGL 画布上，按局部梯度分区处理：
 *   平坦区域（梯度低）→ 加权平滑，压掉老片源的色块和振铃
 *   边缘区域（梯度高）→ 沿边缘锐化，线条不糊
 *
 * 这是着色器实现，不是 AI 模型。它不能让 540P 变成真 1080P，
 * 但能让画面在 1080P 屏幕上看着干净、线条清楚。
 *
 * 放大倍率：标准 1.5x，强力 2x。画布尺寸跟着倍率走，
 * 浏览器再缩到播放窗口，等于做了两级重采样。
 */

const VERT = [
  'attribute vec2 aPos;',
  'varying vec2 vUv;',
  'void main() { vUv = (aPos + 1.0) * 0.5; vUv.y = 1.0 - vUv.y; gl_Position = vec4(aPos, 0.0, 1.0); }',
].join('\n');

const FRAG = [
  'precision highp float;',
  'uniform sampler2D uTex;',
  'uniform vec2 uTexel;',
  'uniform float uEdge;',
  'uniform float uFlat;',
  'varying vec2 vUv;',
  'float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }',
  'void main() {',
  '  vec3 c  = texture2D(uTex, vUv).rgb;',
  '  vec3 n  = texture2D(uTex, vUv + vec2(0.0, -uTexel.y)).rgb;',
  '  vec3 s  = texture2D(uTex, vUv + vec2(0.0,  uTexel.y)).rgb;',
  '  vec3 w  = texture2D(uTex, vUv + vec2(-uTexel.x, 0.0)).rgb;',
  '  vec3 e  = texture2D(uTex, vUv + vec2( uTexel.x, 0.0)).rgb;',
  '  vec3 nw = texture2D(uTex, vUv + vec2(-uTexel.x, -uTexel.y)).rgb;',
  '  vec3 ne = texture2D(uTex, vUv + vec2( uTexel.x, -uTexel.y)).rgb;',
  '  vec3 sw = texture2D(uTex, vUv + vec2(-uTexel.x,  uTexel.y)).rgb;',
  '  vec3 se = texture2D(uTex, vUv + vec2( uTexel.x,  uTexel.y)).rgb;',
  '  float gx = abs(luma(e) - luma(w));',
  '  float gy = abs(luma(s) - luma(n));',
  '  float grad = gx + gy;',
  '  vec3 blur = (c * 4.0 + (n + s + w + e) * 2.0 + (nw + ne + sw + se)) / 16.0;',
  '  vec3 detail = c - blur;',
  '  float edgeW = smoothstep(0.02, 0.22, grad);',
  '  vec3 flatPart = mix(c, blur, uFlat);',
  '  vec3 edgePart = clamp(c + detail * uEdge, 0.0, 1.0);',
  '  vec3 outc = mix(flatPart, edgePart, edgeW);',
  '  outc = mix(outc, outc * outc * (3.0 - 2.0 * outc), 0.10);',
  '  gl_FragColor = vec4(outc, 1.0);',
  '}',
].join('\n');

function compile(gl: WebGLRenderingContext, type: number, src: string) {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) || 'shader compile failed');
  }
  return shader;
}

export type SrLevel = 0 | 1 | 2;

const PRESET: Record<1 | 2, { scale: number; edge: number; flat: number }> = {
  1: { scale: 1.5, edge: 0.85, flat: 0.25 },
  2: { scale: 2.0, edge: 1.35, flat: 0.40 },
};

export class Upscaler {
  private gl: WebGLRenderingContext | null = null;
  private tex: WebGLTexture | null = null;
  private edgeLoc: WebGLUniformLocation | null = null;
  private flatLoc: WebGLUniformLocation | null = null;
  private texelLoc: WebGLUniformLocation | null = null;
  private raf = 0;
  private level: SrLevel = 0;

  constructor(private canvas: HTMLCanvasElement, private video: HTMLVideoElement) {}

  start(level: SrLevel) {
    this.level = level;
    if (this.gl) { this.applyPreset(); return; }

    const gl = this.canvas.getContext('webgl', { alpha: false, antialias: false, premultipliedAlpha: false });
    if (!gl) throw new Error('WebGL 不可用');
    this.gl = gl;

    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) || 'program link failed');
    }
    gl.useProgram(program);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    this.edgeLoc = gl.getUniformLocation(program, 'uEdge');
    this.flatLoc = gl.getUniformLocation(program, 'uFlat');
    this.texelLoc = gl.getUniformLocation(program, 'uTexel');
    this.applyPreset();
    this.loop();
  }

  setLevel(level: SrLevel) {
    this.level = level;
    this.applyPreset();
  }

  private applyPreset() {
    const gl = this.gl;
    if (!gl || !this.edgeLoc || !this.flatLoc) return;
    const preset = this.level === 0 ? { edge: 0, flat: 0 } : PRESET[this.level];
    gl.uniform1f(this.edgeLoc, preset.edge);
    gl.uniform1f(this.flatLoc, preset.flat);
  }

  private loop = () => {
    const gl = this.gl;
    const video = this.video;
    if (!gl || !this.tex) return;

    if (video.readyState >= 2 && video.videoWidth > 0) {
      const preset = this.level === 0 ? { scale: 1 } : PRESET[this.level];
      const w = Math.round(video.videoWidth * preset.scale);
      const h = Math.round(video.videoHeight * preset.scale);
      if (this.canvas.width !== w) this.canvas.width = w;
      if (this.canvas.height !== h) this.canvas.height = h;

      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      if (this.texelLoc) gl.uniform2f(this.texelLoc, 1 / video.videoWidth, 1 / video.videoHeight);
      gl.viewport(0, 0, w, h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    this.raf = requestAnimationFrame(this.loop);
  };

  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.gl?.getExtension('WEBGL_lose_context')?.loseContext();
    this.gl = null;
    this.tex = null;
  }
}
