// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Applies a clip's picture effects to one frame.
 *
 * Backend choice, once per processor: **WebGL2** (`chroma-shader.ts`) on an
 * `OffscreenCanvas` (or a detached `<canvas>`), falling back to **Canvas 2D**
 * + the CPU reference functions when WebGL2 is missing, fails to compile, or
 * the context is lost. Without any canvas (Node, tests) the processor
 * reports `'none'` and the compositor draws the untouched frame.
 *
 * The output canvas is reused between calls; the compositor blits it right
 * after {@link VisionProcessor.process} returns, before the next clip.
 */

import type { RenderImage } from '../../render/types.ts';
import { type ClipEffects, hasVisualEffects } from '../clip-effects.ts';
import { applyChromaKey } from './chroma-key.ts';
import { GLVisionRenderer, type GLLike } from './chroma-shader.ts';
import { applyColorGrading, isNeutralGrading } from './color-grading.ts';
import { featherAlpha } from './edge-feather.ts';
import { applyLut } from './lut-applier.ts';
import { builtinLut, type Lut3D } from './lut-loader.ts';
import { applyLumaKey } from './luminance-key.ts';
import { suppressSpill } from './spill-suppression.ts';

/** Which implementation runs. */
export type VisionBackend = 'webgl2' | 'canvas2d' | 'none';

/**
 * The CPU pipeline over RGBA pixels (Canvas 2D fallback, tests, export
 * without WebGL). Order matches the shader: keys → despill → grade → LUT →
 * choke/feather.
 * @param pixels `ImageData.data`, modified in place.
 * @param width image width.
 * @param height image height.
 * @param effects the clip's effects.
 * @param lut the resolved LUT, if any.
 */
export function processPixels(pixels: Uint8ClampedArray, width: number, height: number, effects: ClipEffects, lut: Lut3D | null): void {
  if (effects.chromaKey?.enabled) applyChromaKey(pixels, effects.chromaKey);
  if (effects.lumaKey?.enabled) applyLumaKey(pixels, effects.lumaKey);
  if (effects.spill?.enabled) suppressSpill(pixels, effects.chromaKey?.color ?? [0, 255, 0], effects.spill);
  const split = effects.splitView ? 0.5 : null;
  if (effects.colorGrading && !isNeutralGrading(effects.colorGrading)) applyColorGrading(pixels, effects.colorGrading, split, width);
  if (effects.lut && lut && effects.lut.strength > 0) {
    if (split === null) {
      applyLut(pixels, lut, effects.lut.strength);
    } else {
      const from = Math.round(width * split);
      for (let y = 0; y < height; y += 1) {
        const row = pixels.subarray((y * width + from) * 4, (y + 1) * width * 4);
        applyLut(row, lut, effects.lut.strength);
      }
    }
  }
  if (effects.feather?.enabled) featherAlpha(pixels, width, height, effects.feather);
}

/** Canvas the processor renders into. */
type Surface = OffscreenCanvas | HTMLCanvasElement;

/** Options of {@link VisionProcessor}. */
export interface VisionProcessorOptions {
  /** Resolves a LUT id (session `.cube` files); built-ins are always known. */
  resolveLut?: (id: string) => Lut3D | undefined;
  /** Skip WebGL2 (diagnostics / forced fallback). */
  forceCanvas2d?: boolean;
  /** Canvas factory (defaults to `OffscreenCanvas`, then `<canvas>`). */
  createSurface?: (width: number, height: number) => Surface | null;
}

/** Default canvas factory. */
function defaultSurface(width: number, height: number): Surface | null {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  return null;
}

/** Per-frame effects processor with WebGL2 → Canvas 2D fallback. */
export class VisionProcessor {
  private readonly options: VisionProcessorOptions;
  private surface: Surface | null = null;
  private gl: GLVisionRenderer<TexImageSource> | null = null;
  private ctx2d: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;
  private mode: VisionBackend | null = null;
  private lastError: string | null = null;

  /**
   * @param options LUT resolver, fallback switches.
   */
  constructor(options: VisionProcessorOptions = {}) {
    this.options = options;
  }

  /** The active backend (`null` until the first frame). */
  get backend(): VisionBackend | null {
    return this.mode;
  }

  /** The last GPU error that forced the fallback, if any. */
  get error(): string | null {
    return this.lastError;
  }

  /**
   * Resolves a LUT reference.
   * @param id built-in or session id.
   * @returns the table, or null.
   */
  lutFor(id: string): Lut3D | null {
    return builtinLut(id) ?? this.options.resolveLut?.(id) ?? null;
  }

  /**
   * Renders a frame with effects.
   * @param source the decoded frame.
   * @param width output width (source pixels).
   * @param height output height.
   * @param effects the clip's effects.
   * @returns the processed picture (reused canvas), or `null` to draw the source as-is.
   */
  process(source: RenderImage, width: number, height: number, effects: ClipEffects): RenderImage | null {
    if (!hasVisualEffects(effects) || width < 1 || height < 1) return null;
    const w = Math.round(width);
    const h = Math.round(height);
    if (!this.ensureSurface(w, h)) return null;
    const surface = this.surface!;
    const lut = effects.lut ? this.lutFor(effects.lut.id) : null;
    if (this.mode === 'webgl2' && this.gl) {
      try {
        this.gl.render(source, w, h, effects, lut);
        return surface;
      } catch (error) {
        this.fallBack(error);
        if (!this.ensureSurface(w, h)) return null;
      }
    }
    const ctx = this.ctx2d;
    if (!ctx) return null;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(source, 0, 0, w, h);
    const image = ctx.getImageData(0, 0, w, h);
    processPixels(image.data, w, h, effects, lut);
    ctx.putImageData(image, 0, 0);
    return this.surface;
  }

  /** Frees the GL objects and the canvas. */
  dispose(): void {
    this.gl?.dispose();
    this.gl = null;
    this.ctx2d = null;
    this.surface = null;
    this.mode = null;
  }

  private ensureSurface(width: number, height: number): boolean {
    if (this.mode === 'none') return false;
    if (!this.surface) {
      const surface = (this.options.createSurface ?? defaultSurface)(width, height);
      if (!surface) {
        this.mode = 'none';
        return false;
      }
      this.surface = surface;
      if (!this.options.forceCanvas2d) this.tryWebGl(surface);
      if (!this.gl) this.useCanvas2d(surface);
    }
    const surface = this.surface;
    if (surface.width !== width) surface.width = width;
    if (surface.height !== height) surface.height = height;
    return this.ready();
  }

  /** Whether a backend is usable (separate method: no stale narrowing). */
  private ready(): boolean {
    return this.mode !== null && this.mode !== 'none';
  }

  private tryWebGl(surface: Surface): void {
    try {
      const gl = surface.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true, alpha: true });
      if (gl && isWebGl2(gl)) {
        this.gl = new GLVisionRenderer<TexImageSource>(gl);
        this.mode = 'webgl2';
      }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.gl = null;
    }
  }

  private useCanvas2d(surface: Surface): void {
    const ctx = surface.getContext('2d', { willReadFrequently: true });
    if (ctx && 'getImageData' in ctx) {
      this.ctx2d = ctx;
      this.mode = 'canvas2d';
    } else {
      this.mode = 'none';
    }
  }

  /** GPU failure: drop WebGL for good, on a fresh canvas (a canvas keeps its first context type). */
  private fallBack(error: unknown): void {
    this.lastError = error instanceof Error ? error.message : String(error);
    this.gl?.dispose();
    this.gl = null;
    this.surface = null;
    this.mode = null;
    this.options.forceCanvas2d = true;
  }
}

/** Narrows a context to WebGL2 (also matches the structural {@link GLLike}). */
function isWebGl2(ctx: unknown): ctx is GLLike<TexImageSource> {
  return typeof WebGL2RenderingContext !== 'undefined' && ctx instanceof WebGL2RenderingContext;
}
