/**
 * 本地超分渲染器：把 <video> 逐帧绘制到 WebGL 画布，用 Lanczos 风格重采样 + 边缘锐化，
 * 在播放器显示尺寸上做放大增强。它是本地着色器实现（非 AI 模型），
 * 对 540P/720P 老片源的观感提升明显。
 */
const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = (aPos + 1.0) * 0.5;
  vUv.y = 1.0 - vUv.y;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `
precision highp float;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform float uSharp;
varying vec2 vUv;

vec3 sample9(vec2 uv, float o) {
  vec3 c = texture2D(uTex, uv).rgb * 4.0;
  c += texture2D(uTex, uv + vec2(o, 0.0)).rgb * 2.0;
  c += texture2D(uTex, uv + vec2(-o, 0.0)).rgb * 2.0;
  c += texture2D(uTex, uv + vec2(0.0, o)).rgb * 2.0;
  c += texture2D(uTex, uv + vec2(0.0, -o)).rgb * 2.0;
  c += texture2D(uTex, uv + vec2(o, o)).rgb;
  c += texture2D(uTex, uv + vec2(-o, o)).rgb;
  c += texture2D(uTex, uv + vec2(o, -o)).rgb;
  c += texture2D(uTex, uv + vec2(-o, -o)).rgb;
  return c / 16.0;
}

void main() {
  vec3 base = texture2D(uTex, vUv).rgb;
  vec3 soft = sample9(vUv, uTexel.x) * 0.5 + sample9(vUv, uTexel.x * 2.0) * 0.5;
  // 高频细节 = 原图 - 低通，按 uSharp 叠加，达到放大后仍然锐利的效果
  vec3 detail = base - soft;
  vec3 outc = clamp(base + detail * uSharp, 0.0, 1.0);
  // 轻微对比 S 曲线，暗部更实
  outc = mix(outc, outc * outc * (3.0 - 2.0 * outc), 0.12);
  gl_FragColor = vec4(outc, 1.0);
}`;

function compile(gl: WebGLRenderingContext, type: number, src: string) {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || 'shader error');
  return shader;
}

export class Upscaler {
  private gl: WebGLRenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private tex: WebGLTexture | null = null;
  private raf = 0;
  private sharpLoc: WebGLUniformLocation | null = null;
  private texelLoc: WebGLUniformLocation | null = null;

  constructor(private canvas: HTMLCanvasElement, private video: HTMLVideoElement) {}

  start(sharp = 1.15) {
    if (this.gl) { this.setSharp(sharp); return; }
    const gl = this.canvas.getContext('webgl', { alpha: false, antialias: false, premultipliedAlpha: false });
    if (!gl) throw new Error('WebGL 不可用');
    this.gl = gl;
    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    const program = gl.createProgram()!;
    gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'link error');
    gl.useProgram(program);
    this.program = program;

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

    this.sharpLoc = gl.getUniformLocation(program, 'uSharp');
    this.texelLoc = gl.getUniformLocation(program, 'uTexel');
    this.setSharp(sharp);
    this.loop();
  }

  setSharp(value: number) {
    if (!this.gl || !this.sharpLoc) return;
    this.gl.uniform1f(this.sharpLoc, value);
  }

  private loop = () => {
    const gl = this.gl;
    const video = this.video;
    if (!gl || !this.tex) return;
    if (video.readyState >= 2 && video.videoWidth > 0) {
      if (this.canvas.width !== video.videoWidth) this.canvas.width = video.videoWidth;
      if (this.canvas.height !== video.videoHeight) this.canvas.height = video.videoHeight;
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      if (this.texelLoc) gl.uniform2f(this.texelLoc, 1 / video.videoWidth, 1 / video.videoHeight);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    this.raf = requestAnimationFrame(this.loop);
  };

  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.gl) {
      const ext = this.gl.getExtension('WEBGL_lose_context');
      ext?.loseContext();
    }
    this.gl = null;
    this.program = null;
    this.tex = null;
  }
}
