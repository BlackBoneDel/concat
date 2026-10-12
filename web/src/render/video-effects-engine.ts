// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Fase 5 video effect stack renderer: runs a clip's ordered effects
 * (`media/effects/effects-stack.ts`) over its cropped picture.
 *
 * Backends, picked once and kept:
 * 1. **WebGL2** — one full-screen pass per effect (blur = two passes),
 *    ping-ponging between two framebuffer textures, the last pass straight
 *    to the output canvas (`concat-effects/src/shader.rs` does the same on wgpu).
 * 2. **Canvas 2D** — blur through `ctx.filter = blur()` where supported,
 *    otherwise the CPU Gaussian over a downscaled copy (big radii stay
 *    interactive); every other effect on `ImageData` with the CPU functions
 *    of `media/effects/video-effects.ts`.
 *
 * The compositor reaches the engine through {@link getVideoEffectsHook}; with
 * no hook installed Fase 4 rendering is unchanged.
 */

import { effectIsNeutral, type VideoEffectInstance } from '../media/effects/effects-stack.ts';
import {
  EFFECT_FRAGMENT_SHADERS,
  EFFECT_VERTEX_SHADER,
  applyVideoEffectCpu,
  noiseFrame,
  pixelateRows,
  type PixelImage,
  type VideoEffectPass,
} from '../media/effects/video-effects.ts';
import type { RenderImage } from './types.ts';

// The hook registry lives in its own tiny module so the compositor does not
// pull the engine (shaders + CPU kernels) into the main bundle; re-exported
// here for existing importers.
export { getVideoEffectsHook, setVideoEffectsHook, type SourceRect, type VideoEffectsHook } from './video-effects-hook.ts';
import type { SourceRect } from './video-effects-hook.ts';

/** A drawable, readable canvas. */
export type EffectSurface = OffscreenCanvas | HTMLCanvasElement;

/** The 2D context slice the Canvas 2D backend uses. */
export interface Effects2DContext {
  drawImage(image: RenderImage | EffectSurface, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void;
  getImageData(x: number, y: number, w: number, h: number): PixelImage;
  putImageData(image: PixelImage, x: number, y: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  filter?: string;
  imageSmoothingEnabled: boolean;
}

/** Engine options. */
export interface VideoEffectsEngineOptions {
  /** Canvas factory (defaults to `OffscreenCanvas`, then `<canvas>`). */
  createSurface?: (width: number, height: number) => EffectSurface | null;
  /** Skip WebGL2. */
  forceCanvas2d?: boolean;
  /** 2D context getter (tests inject a double). */
  context2d?: (surface: EffectSurface) => Effects2DContext | null;
}

/** The backend in use. */
export type EffectsBackend = 'webgl2' | 'canvas2d' | 'none';

function defaultSurface(width: number, height: number): EffectSurface | null {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  return null;
}

function default2d(surface: EffectSurface): Effects2DContext | null {
  const ctx = surface.getContext('2d', { willReadFrequently: true });
  return ctx && 'getImageData' in ctx ? ctx : null;
}

/** Expands a stack into GPU/CPU passes (skipping bypassed and neutral effects). */
export function activePasses(stack: readonly VideoEffectInstance[]): VideoEffectPass[] {
  return stack.filter((fx) => fx.enabled && !effectIsNeutral(fx)).map((fx) => ({ type: fx.type, params: fx.params }));
}

/** Largest blur radius the CPU path runs at full resolution. */
const CPU_BLUR_FULL_RES_RADIUS = 6;

/** Renders effect stacks (one engine per app; surfaces are reused). */
export class VideoEffectsEngine {
  private readonly options: VideoEffectsEngineOptions;
  private work: EffectSurface | null = null;
  private workCtx: Effects2DContext | null = null;
  private scratch: EffectSurface | null = null;
  private scratchCtx: Effects2DContext | null = null;
  private glSurface: EffectSurface | null = null;
  private gl: GLEffects | null = null;
  private mode: EffectsBackend | null = null;
  private filterSupported: boolean | null = null;
  private lastError: string | null = null;

  /** @param options factories and switches. */
  constructor(options: VideoEffectsEngineOptions = {}) {
    this.options = { ...options };
  }

  /** The active backend (`null` before the first frame). */
  get backend(): EffectsBackend | null {
    return this.mode;
  }

  /** The error that forced the Canvas 2D fallback, if any. */
  get error(): string | null {
    return this.lastError;
  }

  /**
   * Renders a stack over a crop of `source`.
   * @param source the picture.
   * @param rect the crop (source pixels).
   * @param stack the effects in order.
   * @param time clip-local seconds.
   * @returns the processed picture (a reused canvas) or `null`.
   */
  apply(source: RenderImage, rect: SourceRect, stack: readonly VideoEffectInstance[], time: number): RenderImage | null {
    const passes = activePasses(stack);
    const w = Math.max(1, Math.round(rect.sw));
    const h = Math.max(1, Math.round(rect.sh));
    if (passes.length === 0) return null;
    if (!this.ensureWork(w, h)) return null;
    const ctx = this.workCtx!;
    const work = this.work!;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(source, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, w, h);

    if (this.mode === null) this.pickBackend(w, h);
    if (this.mode === 'webgl2' && this.gl && this.glSurface) {
      try {
        this.glSurface.width = w;
        this.glSurface.height = h;
        this.gl.render(work, w, h, passes, time);
        return this.glSurface;
      } catch (error) {
        this.fallBack(error);
      }
    }
    if (this.mode === 'none') return null;
    this.renderCanvas2d(passes, w, h, time);
    return work;
  }

  /** Frees GPU resources and surfaces. */
  dispose(): void {
    this.gl?.dispose();
    this.gl = null;
    this.glSurface = null;
    this.work = null;
    this.workCtx = null;
    this.scratch = null;
    this.scratchCtx = null;
    this.mode = null;
  }

  private surface(width: number, height: number): EffectSurface | null {
    return (this.options.createSurface ?? defaultSurface)(width, height);
  }

  private ensureWork(w: number, h: number): boolean {
    if (!this.work) {
      this.work = this.surface(w, h);
      this.workCtx = this.work ? (this.options.context2d ?? default2d)(this.work) : null;
      if (!this.work || !this.workCtx) {
        this.mode = 'none';
        return false;
      }
    }
    if (this.work.width !== w) this.work.width = w;
    if (this.work.height !== h) this.work.height = h;
    return true;
  }

  private pickBackend(w: number, h: number): void {
    if (!this.options.forceCanvas2d) {
      try {
        const surface = this.surface(w, h);
        const gl = surface?.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true, alpha: true });
        if (surface && gl && typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext) {
          this.gl = new GLEffects(gl);
          this.glSurface = surface;
          this.mode = 'webgl2';
          return;
        }
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
      }
    }
    this.mode = this.workCtx ? 'canvas2d' : 'none';
  }

  private fallBack(error: unknown): void {
    this.lastError = error instanceof Error ? error.message : String(error);
    this.gl?.dispose();
    this.gl = null;
    this.glSurface = null;
    this.options.forceCanvas2d = true;
    this.mode = this.workCtx ? 'canvas2d' : 'none';
  }

  private canFilter(ctx: Effects2DContext): boolean {
    if (this.filterSupported === null) {
      // Safari exposes no `filter`; some engines accept the property and ignore it.
      try {
        ctx.filter = 'blur(1px)';
        this.filterSupported = ctx.filter === 'blur(1px)';
        ctx.filter = 'none';
      } catch {
        this.filterSupported = false;
      }
    }
    return this.filterSupported;
  }

  private ensureScratch(w: number, h: number): Effects2DContext | null {
    if (!this.scratch) {
      this.scratch = this.surface(w, h);
      this.scratchCtx = this.scratch ? (this.options.context2d ?? default2d)(this.scratch) : null;
    }
    if (!this.scratch || !this.scratchCtx) return null;
    this.scratch.width = w;
    this.scratch.height = h;
    return this.scratchCtx;
  }

  /** Canvas 2D: blur via filter or downscaled CPU; the rest on ImageData. */
  private renderCanvas2d(passes: readonly VideoEffectPass[], w: number, h: number, time: number): void {
    const ctx = this.workCtx!;
    const work = this.work!;
    let pixels: PixelImage | null = null;
    const flush = (): void => {
      if (pixels) {
        ctx.putImageData(toImageData(pixels), 0, 0);
        pixels = null;
      }
    };
    for (const pass of passes) {
      if (pass.type === 'blur') {
        flush();
        this.blur2d(ctx, work, w, h, pass.params['radius'] ?? 0);
        continue;
      }
      pixels ??= ctx.getImageData(0, 0, w, h);
      applyVideoEffectCpu(pixels, pass, time);
    }
    flush();
  }

  private blur2d(ctx: Effects2DContext, work: EffectSurface, w: number, h: number, radius: number): void {
    const scratch = this.ensureScratch(w, h);
    if (scratch && this.canFilter(scratch)) {
      // CSS blur(σ): σ = radius / 2, same as the shader and the CPU kernel.
      scratch.clearRect(0, 0, w, h);
      scratch.filter = `blur(${radius / 2}px)`;
      scratch.drawImage(work, 0, 0, w, h, 0, 0, w, h);
      scratch.filter = 'none';
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(this.scratch!, 0, 0, w, h, 0, 0, w, h);
      return;
    }
    // CPU: blur a downscaled copy for big radii, then upscale (smoothed).
    const factor = radius > CPU_BLUR_FULL_RES_RADIUS ? radius / CPU_BLUR_FULL_RES_RADIUS : 1;
    if (factor === 1 || !scratch) {
      const image = ctx.getImageData(0, 0, w, h);
      applyVideoEffectCpu(image, { type: 'blur', params: { radius } }, 0);
      ctx.putImageData(toImageData(image), 0, 0);
      return;
    }
    const sw = Math.max(1, Math.round(w / factor));
    const sh = Math.max(1, Math.round(h / factor));
    scratch.clearRect(0, 0, w, h);
    scratch.imageSmoothingEnabled = true;
    scratch.drawImage(work, 0, 0, w, h, 0, 0, sw, sh);
    const small = scratch.getImageData(0, 0, sw, sh);
    applyVideoEffectCpu(small, { type: 'blur', params: { radius } }, 0, factor);
    scratch.putImageData(toImageData(small), 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.scratch!, 0, 0, sw, sh, 0, 0, w, h);
  }
}

/** A {@link PixelImage} as a real `ImageData` when the platform has one (test doubles take it as-is). */
function toImageData(image: PixelImage): PixelImage {
  if (typeof ImageData === 'undefined' || image instanceof ImageData) return image;
  return new ImageData(new Uint8ClampedArray(image.data), image.width, image.height);
}

/** Uniform values for one pass. */
type Uniforms = Record<string, number | readonly [number, number]>;

/** The WebGL2 backend. */
class GLEffects {
  private readonly gl: WebGL2RenderingContext;
  private readonly vertex: WebGLShader;
  private readonly quad: WebGLBuffer;
  private readonly programs = new Map<string, WebGLProgram>();
  private readonly source: WebGLTexture;
  private readonly targets: { texture: WebGLTexture; fbo: WebGLFramebuffer }[] = [];
  private size = { w: 0, h: 0 };

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.vertex = this.compile(gl.VERTEX_SHADER, EFFECT_VERTEX_SHADER);
    const quad = gl.createBuffer();
    if (!quad) throw new Error('WebGL2: sin buffer');
    this.quad = quad;
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    this.source = this.texture();
  }

  /**
   * Runs the passes.
   * @param input the cropped picture.
   * @param w width.
   * @param h height.
   * @param passes effects in order.
   * @param time clip-local seconds.
   */
  render(input: TexImageSource, w: number, h: number, passes: readonly VideoEffectPass[], time: number): void {
    const gl = this.gl;
    this.ensureTargets(w, h);
    gl.bindTexture(gl.TEXTURE_2D, this.source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, input);

    const steps: { type: keyof typeof EFFECT_FRAGMENT_SHADERS; uniforms: Uniforms }[] = [];
    for (const pass of passes) {
      const p = pass.params;
      switch (pass.type) {
        case 'blur': {
          const sigma = Math.max(0.01, (p['radius'] ?? 0) / 2);
          steps.push({ type: 'blur', uniforms: { u_texel: [1 / w, 1 / h], u_direction: [1, 0], u_sigma: sigma } });
          steps.push({ type: 'blur', uniforms: { u_texel: [1 / w, 1 / h], u_direction: [0, 1], u_sigma: sigma } });
          break;
        }
        case 'vignette':
          steps.push({ type: 'vignette', uniforms: { u_aspect: w / h, u_radius: p['radius'] ?? 0.75, u_softness: p['softness'] ?? 0.45, u_amount: p['amount'] ?? 0.8 } });
          break;
        case 'pixelate': {
          const bx = Math.max(1, Math.round(p['blocks'] ?? 64));
          steps.push({ type: 'pixelate', uniforms: { u_blocks: [bx, pixelateRows(bx, w, h)] } });
          break;
        }
        case 'noise':
          steps.push({ type: 'noise', uniforms: { u_size: [w, h], u_amount: p['amount'] ?? 0.2, u_frame: noiseFrame(time, p['speed'] ?? 24) } });
          break;
        case 'glitch':
          steps.push({
            type: 'glitch',
            uniforms: { u_amount: p['amount'] ?? 0.5, u_shift: p['rgbShift'] ?? 0.012, u_bands: Math.max(1, Math.round(p['bands'] ?? 12)), u_frame: noiseFrame(time, p['speed'] ?? 10) },
          });
          break;
        default:
          break;
      }
    }
    let input2 = this.source;
    steps.forEach((step, index) => {
      const last = index === steps.length - 1;
      const target = last ? null : this.targets[index % 2]!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
      gl.viewport(0, 0, w, h);
      const program = this.program(step.type);
      gl.useProgram(program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, input2);
      gl.uniform1i(gl.getUniformLocation(program, 'u_image'), 0);
      // Framebuffer passes are stored in texture orientation (row 0 = top).
      gl.uniform1f(gl.getUniformLocation(program, 'u_flipY'), target ? -1 : 1);
      for (const [name, value] of Object.entries(step.uniforms)) {
        const location = gl.getUniformLocation(program, name);
        if (typeof value === 'number') gl.uniform1f(location, value);
        else gl.uniform2f(location, value[0], value[1]);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
      const position = gl.getAttribLocation(program, 'a_position');
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      if (target) input2 = target.texture;
    });
    const error = gl.getError();
    if (error !== gl.NO_ERROR) throw new Error(`WebGL2 error ${error}`);
  }

  /** Deletes every GL object and releases the context. */
  dispose(): void {
    const gl = this.gl;
    for (const program of this.programs.values()) gl.deleteProgram(program);
    this.programs.clear();
    for (const target of this.targets) {
      gl.deleteFramebuffer(target.fbo);
      gl.deleteTexture(target.texture);
    }
    this.targets.length = 0;
    gl.deleteTexture(this.source);
    gl.deleteBuffer(this.quad);
    gl.deleteShader(this.vertex);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  private texture(): WebGLTexture {
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) throw new Error('WebGL2: sin textura');
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  private ensureTargets(w: number, h: number): void {
    const gl = this.gl;
    if (this.targets.length === 2 && this.size.w === w && this.size.h === h) return;
    for (const target of this.targets) {
      gl.deleteFramebuffer(target.fbo);
      gl.deleteTexture(target.texture);
    }
    this.targets.length = 0;
    for (let i = 0; i < 2; i += 1) {
      const texture = this.texture();
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const fbo = gl.createFramebuffer();
      if (!fbo) throw new Error('WebGL2: sin framebuffer');
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      this.targets.push({ texture, fbo });
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.size = { w, h };
  }

  private compile(type: number, source: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type);
    if (!shader) throw new Error('WebGL2: sin shader');
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader) ?? '';
      gl.deleteShader(shader);
      throw new Error(`Shader: ${log}`);
    }
    return shader;
  }

  private program(type: keyof typeof EFFECT_FRAGMENT_SHADERS): WebGLProgram {
    const known = this.programs.get(type);
    if (known) return known;
    const gl = this.gl;
    const fragment = this.compile(gl.FRAGMENT_SHADER, EFFECT_FRAGMENT_SHADERS[type]);
    const program = gl.createProgram();
    if (!program) throw new Error('WebGL2: sin programa');
    gl.attachShader(program, this.vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program) ?? '';
      gl.deleteProgram(program);
      throw new Error(`Programa ${type}: ${log}`);
    }
    this.programs.set(type, program);
    return program;
  }
}
