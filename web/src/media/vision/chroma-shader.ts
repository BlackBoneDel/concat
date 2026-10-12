// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The WebGL2 vision renderer: one "uber" fragment shader evaluates chroma
 * key (+spill), luma key, despill, the linear-light grade and the 3D LUT in
 * a single pass; two optional separable Gaussian passes feather the matte.
 *
 * Every expression mirrors its CPU reference (`chroma-key.ts`,
 * `luminance-key.ts`, `spill-suppression.ts`, `color-grading.ts`,
 * `lut-applier.ts`) so the Canvas 2D fallback renders the same picture.
 *
 * {@link GLLike} is the exact subset of `WebGL2RenderingContext` used, so a
 * real context satisfies it and tests drive the renderer with a recorder.
 * Textures, framebuffers and programs are released in {@link GLVisionRenderer.dispose}.
 */

import type { ClipEffects } from '../clip-effects.ts';
import { rgbToCbCr } from './color-space.ts';
import { dominantChannel } from './spill-suppression.ts';
import { isNeutralGrading, planGrading, TONAL_BANDS, TONAL_SCALE } from './color-grading.ts';
import { lutCoordOffset, lutCoordScale, lutToHalfRgba } from './lut-applier.ts';
import type { Lut3D } from './lut-loader.ts';

/** GLenum values used (WebGL2 spec). */
export const GL = Object.freeze({
  VERTEX_SHADER: 0x8b31,
  FRAGMENT_SHADER: 0x8b30,
  COMPILE_STATUS: 0x8b81,
  LINK_STATUS: 0x8b82,
  TEXTURE_2D: 0x0de1,
  TEXTURE_3D: 0x806f,
  TEXTURE0: 0x84c0,
  TEXTURE1: 0x84c1,
  TEXTURE_MIN_FILTER: 0x2801,
  TEXTURE_MAG_FILTER: 0x2800,
  TEXTURE_WRAP_S: 0x2802,
  TEXTURE_WRAP_T: 0x2803,
  TEXTURE_WRAP_R: 0x8072,
  LINEAR: 0x2601,
  CLAMP_TO_EDGE: 0x812f,
  RGBA: 0x1908,
  RGBA8: 0x8058,
  RGBA16F: 0x881a,
  UNSIGNED_BYTE: 0x1401,
  HALF_FLOAT: 0x140b,
  FRAMEBUFFER: 0x8d40,
  COLOR_ATTACHMENT0: 0x8ce0,
  TRIANGLES: 0x0004,
  COLOR_BUFFER_BIT: 0x4000,
  UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241,
} as const);

/** The subset of `WebGL2RenderingContext` the renderer calls. */
export interface GLLike<S> {
  createShader(type: number): WebGLShader | null;
  shaderSource(shader: WebGLShader, source: string): void;
  compileShader(shader: WebGLShader): void;
  getShaderParameter(shader: WebGLShader, pname: number): unknown;
  getShaderInfoLog(shader: WebGLShader): string | null;
  deleteShader(shader: WebGLShader | null): void;
  createProgram(): WebGLProgram | null;
  attachShader(program: WebGLProgram, shader: WebGLShader): void;
  linkProgram(program: WebGLProgram): void;
  getProgramParameter(program: WebGLProgram, pname: number): unknown;
  getProgramInfoLog(program: WebGLProgram): string | null;
  useProgram(program: WebGLProgram | null): void;
  deleteProgram(program: WebGLProgram | null): void;
  getUniformLocation(program: WebGLProgram, name: string): WebGLUniformLocation | null;
  uniform1i(location: WebGLUniformLocation | null, x: number): void;
  uniform1f(location: WebGLUniformLocation | null, x: number): void;
  uniform2f(location: WebGLUniformLocation | null, x: number, y: number): void;
  uniformMatrix3fv(location: WebGLUniformLocation | null, transpose: boolean, data: Float32Array): void;
  createVertexArray(): WebGLVertexArrayObject | null;
  bindVertexArray(vao: WebGLVertexArrayObject | null): void;
  deleteVertexArray(vao: WebGLVertexArrayObject | null): void;
  createTexture(): WebGLTexture | null;
  bindTexture(target: number, texture: WebGLTexture | null): void;
  activeTexture(texture: number): void;
  texParameteri(target: number, pname: number, param: number): void;
  pixelStorei(pname: number, param: number | boolean): void;
  texImage2D(target: number, level: number, internalformat: number, format: number, type: number, source: S): void;
  texImage2D(target: number, level: number, internalformat: number, width: number, height: number, border: number, format: number, type: number, pixels: ArrayBufferView | null): void;
  texImage3D(target: number, level: number, internalformat: number, width: number, height: number, depth: number, border: number, format: number, type: number, srcData: ArrayBufferView | null): void;
  deleteTexture(texture: WebGLTexture | null): void;
  createFramebuffer(): WebGLFramebuffer | null;
  bindFramebuffer(target: number, framebuffer: WebGLFramebuffer | null): void;
  framebufferTexture2D(target: number, attachment: number, textarget: number, texture: WebGLTexture | null, level: number): void;
  deleteFramebuffer(framebuffer: WebGLFramebuffer | null): void;
  viewport(x: number, y: number, width: number, height: number): void;
  clearColor(r: number, g: number, b: number, a: number): void;
  clear(mask: number): void;
  drawArrays(mode: number, first: number, count: number): void;
  isContextLost(): boolean;
}

/** Full-screen triangle; `v_uv` in GL convention (0,0 = bottom-left). */
export const VERTEX_SHADER = `#version 300 es
out vec2 v_uv;
void main() {
  vec2 p = vec2(float((gl_VertexID & 1) << 2) - 1.0, float((gl_VertexID & 2) << 1) - 1.0);
  v_uv = (p + 1.0) * 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

/** The uber shader: keys, despill, grade, LUT. */
export const EFFECT_SHADER = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_source;
uniform sampler3D u_lut;
uniform int u_flip;
uniform int u_chroma;
uniform vec2 u_keyCbCr;
uniform float u_similarity;
uniform float u_smoothness;
uniform float u_spill;
uniform int u_luma;
uniform float u_lumaMin;
uniform float u_lumaMax;
uniform float u_lumaSmooth;
uniform int u_lumaInvert;
uniform int u_despill;
uniform int u_despillChannel;
uniform float u_despillAmount;
uniform int u_despillLuma;
uniform int u_grade;
uniform mat3 u_wb;
uniform float u_gain;
uniform float u_contrast;
uniform float u_blacks;
uniform float u_shadows;
uniform float u_highlights;
uniform float u_whites;
uniform float u_saturation;
uniform float u_vibrance;
uniform float u_hueCos;
uniform float u_hueSin;
uniform float u_invGamma;
uniform int u_useLut;
uniform float u_lutStrength;
uniform float u_lutScale;
uniform float u_lutOffset;
uniform float u_split;
uniform float u_choke;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
const float MID_GREY = 0.18;

vec3 toLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c)); }
vec3 toSrgb(vec3 c) { c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c)); }
float toLog1(float v) { return v <= 0.0078125 ? v * 10.5402377416545 + 0.0729055341958355 : (log2(v) + 9.72) / 17.52; }
float fromLog1(float v) { return v <= 0.155251141552511 ? (v - 0.0729055341958355) / 10.5402377416545 : min(exp2(v * 17.52 - 9.72), 65504.0); }
vec3 toLog(vec3 c) { return vec3(toLog1(c.r), toLog1(c.g), toLog1(c.b)); }
vec3 fromLog(vec3 c) { return vec3(fromLog1(c.r), fromLog1(c.g), fromLog1(c.b)); }
float band(float y, float centre, float width) { float d = (y - centre) / width; return exp(-d * d); }
vec2 cbcr(vec3 c) {
  return vec2(-0.100644 * c.r - 0.338572 * c.g + 0.439216 * c.b + 0.501961,
              0.439216 * c.r - 0.398942 * c.g - 0.040274 * c.b + 0.501961);
}

vec3 grade(vec3 srgb) {
  vec3 c = u_wb * toLinear(srgb) * u_gain;
  if (u_contrast != 1.0) {
    vec3 pushed = MID_GREY * pow(max(c, vec3(1e-10)) / MID_GREY, vec3(u_contrast));
    c = mix(c, min(pushed, vec3(65504.0)), step(vec3(1e-30), c));
  }
  float y = toLog1(max(dot(c, LUMA), 0.0));
  float offset = ${TONAL_SCALE.toFixed(4)} * (
    u_blacks * band(y, ${TONAL_BANDS.blacks[0].toFixed(4)}, ${TONAL_BANDS.blacks[1].toFixed(4)}) +
    u_shadows * band(y, ${TONAL_BANDS.shadows[0].toFixed(4)}, ${TONAL_BANDS.shadows[1].toFixed(4)}) +
    u_highlights * band(y, ${TONAL_BANDS.highlights[0].toFixed(4)}, ${TONAL_BANDS.highlights[1].toFixed(4)}) +
    u_whites * band(y, ${TONAL_BANDS.whites[0].toFixed(4)}, ${TONAL_BANDS.whites[1].toFixed(4)}));
  if (offset != 0.0) c = fromLog(toLog(c) + offset);
  float l = dot(c, LUMA);
  float sat = u_saturation;
  if (u_vibrance != 0.0) {
    float mx = max(c.r, max(c.g, c.b));
    float mn = min(c.r, min(c.g, c.b));
    float current = mx > 1e-6 ? (mx - mn) / mx : 0.0;
    sat *= 1.0 + u_vibrance * (1.0 - current);
  }
  c = l + (c - l) * sat;
  if (u_hueSin != 0.0 || u_hueCos != 1.0) {
    float k = (1.0 - u_hueCos) / 3.0;
    float q = u_hueSin / sqrt(3.0);
    c = vec3(dot(c, vec3(u_hueCos + k, k - q, k + q)),
             dot(c, vec3(k + q, u_hueCos + k, k - q)),
             dot(c, vec3(k - q, k + q, u_hueCos + k)));
  }
  vec3 outc = clamp(toSrgb(c), 0.0, 1.0);
  return u_invGamma != 1.0 ? pow(outc, vec3(u_invGamma)) : outc;
}

void main() {
  vec2 uv = u_flip == 1 ? vec2(v_uv.x, 1.0 - v_uv.y) : v_uv;
  vec4 color = texture(u_source, uv);
  vec3 rgb = color.rgb;
  float alpha = color.a;
  if (u_chroma == 1) {
    float base = distance(cbcr(rgb), u_keyCbCr) - u_similarity;
    float a = u_smoothness > 0.0 ? pow(clamp(base / u_smoothness, 0.0, 1.0), 1.5) : (base > 0.0 ? 1.0 : 0.0);
    float s = u_spill > 0.0 ? pow(clamp(base / u_spill, 0.0, 1.0), 1.5) : 1.0;
    float desat = clamp(dot(rgb, LUMA), 0.0, 1.0);
    rgb = mix(vec3(desat), rgb, s);
    alpha *= a;
  }
  if (u_luma == 1) {
    float y = dot(rgb, LUMA);
    float a = smoothstep(u_lumaMin - u_lumaSmooth, u_lumaMin, y) * (1.0 - smoothstep(u_lumaMax, u_lumaMax + u_lumaSmooth, y));
    alpha *= u_lumaInvert == 1 ? 1.0 - a : a;
  }
  if (u_despill == 1) {
    vec3 c = rgb * 255.0;
    float d = u_despillChannel == 0 ? c.r : u_despillChannel == 1 ? c.g : c.b;
    float limit = u_despillChannel == 0 ? (c.g + c.b) * 0.5 : u_despillChannel == 1 ? (c.r + c.b) * 0.5 : (c.r + c.g) * 0.5;
    float excess = d - limit;
    if (excess > 0.0) {
      float removed = excess * u_despillAmount;
      if (u_despillChannel == 0) c.r -= removed; else if (u_despillChannel == 1) c.g -= removed; else c.b -= removed;
      if (u_despillLuma == 1) c += removed * LUMA[u_despillChannel];
    }
    rgb = clamp(c / 255.0, 0.0, 1.0);
  }
  bool graded = u_split <= 0.0 || uv.x >= u_split;
  if (graded && u_grade == 1) rgb = grade(rgb);
  if (graded && u_useLut == 1) {
    vec3 looked = texture(u_lut, clamp(rgb, 0.0, 1.0) * u_lutScale + u_lutOffset).rgb;
    rgb = mix(rgb, looked, u_lutStrength);
  }
  float c = clamp(u_choke, -0.95, 0.95);
  if (c > 0.0) alpha = clamp((alpha - c) / (1.0 - c), 0.0, 1.0);
  else if (c < 0.0) alpha = min(1.0, alpha / (1.0 + c));
  outColor = vec4(rgb, alpha);
}`;

/** Separable Gaussian on alpha (direction by uniform). */
export const FEATHER_SHADER = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_source;
uniform vec2 u_step;
uniform float u_radius;
void main() {
  vec4 centre = texture(u_source, v_uv);
  float sigma = max(u_radius / 2.0, 0.5);
  float total = 0.0;
  float acc = 0.0;
  for (int i = -50; i <= 50; i++) {
    float fi = float(i);
    if (abs(fi) > u_radius) continue;
    float w = exp(-(fi * fi) / (2.0 * sigma * sigma));
    acc += texture(u_source, v_uv + u_step * fi).a * w;
    total += w;
  }
  outColor = vec4(centre.rgb, acc / total);
}`;

/** Every uniform of {@link EFFECT_SHADER}. */
export const EFFECT_UNIFORMS = [
  'u_source', 'u_lut', 'u_flip', 'u_chroma', 'u_keyCbCr', 'u_similarity', 'u_smoothness', 'u_spill',
  'u_luma', 'u_lumaMin', 'u_lumaMax', 'u_lumaSmooth', 'u_lumaInvert',
  'u_despill', 'u_despillChannel', 'u_despillAmount', 'u_despillLuma',
  'u_grade', 'u_wb', 'u_gain', 'u_contrast', 'u_blacks', 'u_shadows', 'u_highlights', 'u_whites',
  'u_saturation', 'u_vibrance', 'u_hueCos', 'u_hueSin', 'u_invGamma',
  'u_useLut', 'u_lutStrength', 'u_lutScale', 'u_lutOffset', 'u_split', 'u_choke',
] as const;

type EffectUniform = (typeof EFFECT_UNIFORMS)[number];

/**
 * Compiles and links a program, throwing the driver log on failure.
 * @param gl the context.
 * @param vertex vertex source.
 * @param fragment fragment source.
 * @returns the program.
 */
export function buildProgram<S>(gl: GLLike<S>, vertex: string, fragment: string): WebGLProgram {
  const compile = (type: number, source: string): WebGLShader => {
    const shader = gl.createShader(type);
    if (!shader) throw new Error('No se pudo crear el shader');
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, GL.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader) ?? '';
      gl.deleteShader(shader);
      throw new Error(`Error al compilar shader: ${log}`);
    }
    return shader;
  };
  const vs = compile(GL.VERTEX_SHADER, vertex);
  const fs = compile(GL.FRAGMENT_SHADER, fragment);
  const program = gl.createProgram();
  if (!program) throw new Error('No se pudo crear el programa WebGL');
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, GL.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? '';
    gl.deleteProgram(program);
    throw new Error(`Error al enlazar programa: ${log}`);
  }
  return program;
}

/** A render-target texture + framebuffer. */
interface Target {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
  width: number;
  height: number;
}

/** The WebGL2 implementation of the vision effects. */
export class GLVisionRenderer<S> {
  private readonly gl: GLLike<S>;
  private readonly effectProgram: WebGLProgram;
  private readonly featherProgram: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject | null;
  private readonly sourceTexture: WebGLTexture | null;
  private readonly uniforms = new Map<EffectUniform, WebGLUniformLocation | null>();
  private readonly featherUniforms: { source: WebGLUniformLocation | null; step: WebGLUniformLocation | null; radius: WebGLUniformLocation | null };
  private lutTexture: WebGLTexture | null = null;
  private lutId = '';
  private targets: Target[] = [];
  private disposed = false;

  /**
   * @param gl a WebGL2 context (or test double).
   */
  constructor(gl: GLLike<S>) {
    this.gl = gl;
    this.effectProgram = buildProgram(gl, VERTEX_SHADER, EFFECT_SHADER);
    this.featherProgram = buildProgram(gl, VERTEX_SHADER, FEATHER_SHADER);
    for (const name of EFFECT_UNIFORMS) this.uniforms.set(name, gl.getUniformLocation(this.effectProgram, name));
    this.featherUniforms = {
      source: gl.getUniformLocation(this.featherProgram, 'u_source'),
      step: gl.getUniformLocation(this.featherProgram, 'u_step'),
      radius: gl.getUniformLocation(this.featherProgram, 'u_radius'),
    };
    this.vao = gl.createVertexArray();
    this.sourceTexture = this.createTexture();
  }

  /**
   * Renders `source` with `effects` into the context's canvas (w×h).
   * @param source the frame.
   * @param width output width.
   * @param height output height.
   * @param effects the clip's effects.
   * @param lut the resolved LUT (when `effects.lut` is set).
   */
  render(source: S, width: number, height: number, effects: ClipEffects, lut: Lut3D | null): void {
    if (this.disposed) throw new Error('Renderizador de visión liberado');
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.activeTexture(GL.TEXTURE0);
    gl.bindTexture(GL.TEXTURE_2D, this.sourceTexture);
    gl.pixelStorei(GL.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(GL.TEXTURE_2D, 0, GL.RGBA, GL.RGBA, GL.UNSIGNED_BYTE, source);

    const feather = effects.feather?.enabled && effects.feather.radius > 0 ? effects.feather : null;
    if (feather) this.ensureTargets(width, height);
    // Pass 1: effects (to the canvas, or to target 0 when feathering).
    gl.bindFramebuffer(GL.FRAMEBUFFER, feather ? this.targets[0]!.framebuffer : null);
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.effectProgram);
    this.setEffectUniforms(effects, lut);
    gl.drawArrays(GL.TRIANGLES, 0, 3);
    if (!feather) return;

    gl.useProgram(this.featherProgram);
    gl.uniform1i(this.featherUniforms.source, 0);
    gl.uniform1f(this.featherUniforms.radius, Math.min(50, feather.radius));
    // Pass 2: horizontal, target 0 → target 1.
    gl.bindFramebuffer(GL.FRAMEBUFFER, this.targets[1]!.framebuffer);
    gl.bindTexture(GL.TEXTURE_2D, this.targets[0]!.texture);
    gl.uniform2f(this.featherUniforms.step, 1 / width, 0);
    gl.drawArrays(GL.TRIANGLES, 0, 3);
    // Pass 3: vertical, target 1 → canvas.
    gl.bindFramebuffer(GL.FRAMEBUFFER, null);
    gl.bindTexture(GL.TEXTURE_2D, this.targets[1]!.texture);
    gl.uniform2f(this.featherUniforms.step, 0, 1 / height);
    gl.drawArrays(GL.TRIANGLES, 0, 3);
  }

  /** Frees every GL object. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    for (const target of this.targets) {
      gl.deleteFramebuffer(target.framebuffer);
      gl.deleteTexture(target.texture);
    }
    this.targets = [];
    gl.deleteTexture(this.sourceTexture);
    gl.deleteTexture(this.lutTexture);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.effectProgram);
    gl.deleteProgram(this.featherProgram);
  }

  private u(name: EffectUniform): WebGLUniformLocation | null {
    return this.uniforms.get(name) ?? null;
  }

  private setEffectUniforms(e: ClipEffects, lut: Lut3D | null): void {
    const gl = this.gl;
    gl.uniform1i(this.u('u_source'), 0);
    gl.uniform1i(this.u('u_flip'), 1);
    const chroma = e.chromaKey?.enabled ? e.chromaKey : null;
    gl.uniform1i(this.u('u_chroma'), chroma ? 1 : 0);
    if (chroma) {
      const [cb, cr] = rgbToCbCr(chroma.color[0] / 255, chroma.color[1] / 255, chroma.color[2] / 255);
      gl.uniform2f(this.u('u_keyCbCr'), cb, cr);
      gl.uniform1f(this.u('u_similarity'), chroma.similarity);
      gl.uniform1f(this.u('u_smoothness'), chroma.smoothness);
      gl.uniform1f(this.u('u_spill'), chroma.spill);
    }
    const luma = e.lumaKey?.enabled ? e.lumaKey : null;
    gl.uniform1i(this.u('u_luma'), luma ? 1 : 0);
    if (luma) {
      gl.uniform1f(this.u('u_lumaMin'), luma.min);
      gl.uniform1f(this.u('u_lumaMax'), luma.max);
      gl.uniform1f(this.u('u_lumaSmooth'), luma.smoothness);
      gl.uniform1i(this.u('u_lumaInvert'), luma.invert ? 1 : 0);
    }
    const spill = e.spill?.enabled ? e.spill : null;
    gl.uniform1i(this.u('u_despill'), spill ? 1 : 0);
    if (spill) {
      gl.uniform1i(this.u('u_despillChannel'), dominantChannel(e.chromaKey?.color ?? [0, 255, 0]));
      gl.uniform1f(this.u('u_despillAmount'), Math.min(1, spill.amount));
      gl.uniform1i(this.u('u_despillLuma'), spill.preserveLuminance ? 1 : 0);
    }
    const grading = e.colorGrading && !isNeutralGrading(e.colorGrading) ? e.colorGrading : null;
    gl.uniform1i(this.u('u_grade'), grading ? 1 : 0);
    if (grading) {
      const plan = planGrading(grading);
      gl.uniformMatrix3fv(this.u('u_wb'), false, plan.wb);
      gl.uniform1f(this.u('u_gain'), plan.gain);
      gl.uniform1f(this.u('u_contrast'), grading.contrast);
      gl.uniform1f(this.u('u_blacks'), grading.blacks);
      gl.uniform1f(this.u('u_shadows'), grading.shadows);
      gl.uniform1f(this.u('u_highlights'), grading.highlights);
      gl.uniform1f(this.u('u_whites'), grading.whites);
      gl.uniform1f(this.u('u_saturation'), grading.saturation);
      gl.uniform1f(this.u('u_vibrance'), grading.vibrance);
      gl.uniform1f(this.u('u_hueCos'), plan.hueCos);
      gl.uniform1f(this.u('u_hueSin'), plan.hueSin);
      gl.uniform1f(this.u('u_invGamma'), 1 / grading.gamma);
    }
    const useLut = Boolean(e.lut && lut && e.lut.strength > 0);
    gl.uniform1i(this.u('u_useLut'), useLut ? 1 : 0);
    if (useLut && lut && e.lut) {
      this.uploadLut(lut);
      gl.uniform1i(this.u('u_lut'), 1);
      gl.uniform1f(this.u('u_lutStrength'), e.lut.strength);
      gl.uniform1f(this.u('u_lutScale'), lutCoordScale(lut.size));
      gl.uniform1f(this.u('u_lutOffset'), lutCoordOffset(lut.size));
      gl.activeTexture(GL.TEXTURE0);
    }
    gl.uniform1f(this.u('u_split'), e.splitView ? 0.5 : 0);
    gl.uniform1f(this.u('u_choke'), e.feather?.enabled ? e.feather.choke : 0);
  }

  private uploadLut(lut: Lut3D): void {
    const gl = this.gl;
    gl.activeTexture(GL.TEXTURE1);
    if (this.lutId === lut.id && this.lutTexture) {
      gl.bindTexture(GL.TEXTURE_3D, this.lutTexture);
      return;
    }
    if (!this.lutTexture) this.lutTexture = gl.createTexture();
    gl.bindTexture(GL.TEXTURE_3D, this.lutTexture);
    for (const [pname, value] of [
      [GL.TEXTURE_MIN_FILTER, GL.LINEAR], [GL.TEXTURE_MAG_FILTER, GL.LINEAR],
      [GL.TEXTURE_WRAP_S, GL.CLAMP_TO_EDGE], [GL.TEXTURE_WRAP_T, GL.CLAMP_TO_EDGE], [GL.TEXTURE_WRAP_R, GL.CLAMP_TO_EDGE],
    ] as const) gl.texParameteri(GL.TEXTURE_3D, pname, value);
    gl.texImage3D(GL.TEXTURE_3D, 0, GL.RGBA16F, lut.size, lut.size, lut.size, 0, GL.RGBA, GL.HALF_FLOAT, lutToHalfRgba(lut));
    this.lutId = lut.id;
  }

  private createTexture(): WebGLTexture | null {
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.bindTexture(GL.TEXTURE_2D, texture);
    gl.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.LINEAR);
    gl.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_MAG_FILTER, GL.LINEAR);
    gl.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_WRAP_S, GL.CLAMP_TO_EDGE);
    gl.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_WRAP_T, GL.CLAMP_TO_EDGE);
    return texture;
  }

  private ensureTargets(width: number, height: number): void {
    if (this.targets.length === 2 && this.targets[0]!.width === width && this.targets[0]!.height === height) return;
    const gl = this.gl;
    for (const target of this.targets) {
      gl.deleteFramebuffer(target.framebuffer);
      gl.deleteTexture(target.texture);
    }
    this.targets = [];
    for (let i = 0; i < 2; i += 1) {
      const texture = this.createTexture();
      const framebuffer = gl.createFramebuffer();
      if (!texture || !framebuffer) throw new Error('No se pudo crear el framebuffer de difuminado');
      gl.texImage2D(GL.TEXTURE_2D, 0, GL.RGBA8, width, height, 0, GL.RGBA, GL.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(GL.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, texture, 0);
      this.targets.push({ texture, framebuffer, width, height });
    }
    gl.bindFramebuffer(GL.FRAMEBUFFER, null);
  }
}
