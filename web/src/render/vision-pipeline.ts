// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Fase 4 hook between frame decode and blend: picture effects per clip.
 *
 * The compositor asks {@link getVisionHook} for a hook after it fetched a
 * clip's frame and *before* blend/transform, so keys and grades composite
 * like the original picture would (alpha from a chroma key blends through
 * the clip's blend mode and opacity). With no hook installed the compositor
 * behaves exactly as in Fase 2.
 *
 * {@link VisionPipeline} is the hook `main.ts` installs: it resolves a clip's
 * {@link ClipEffects} (from `clip.extra.effects`) and runs the
 * {@link VisionProcessor} (WebGL2 → Canvas 2D). Errors never break a frame:
 * they are reported once per message and the untouched picture is drawn.
 */

import type { Clip } from '../core/timeline.ts';
import { type ClipEffects, hasVisualEffects } from '../media/clip-effects.ts';
import { VisionProcessor, type VisionProcessorOptions } from '../media/vision/vision-processor.ts';
import type { RenderImage } from './types.ts';

/** What the compositor calls. */
export interface VisionHook {
  /**
   * @param clip the clip being drawn.
   * @param source its decoded frame.
   * @param width the source's pixel width (as the compositor crops it).
   * @param height the source's pixel height.
   * @returns a processed picture of the same size, or `null` for the source as-is.
   */
  process(clip: Clip, source: RenderImage, width: number, height: number): RenderImage | null;
}

let installed: VisionHook | null = null;

/**
 * Installs (or clears) the process-wide vision hook.
 * @param hook the hook, or `null`.
 */
export function setVisionHook(hook: VisionHook | null): void {
  installed = hook;
}

/** The installed hook, if any. */
export function getVisionHook(): VisionHook | null {
  return installed;
}

/** Options of {@link VisionPipeline}. */
export interface VisionPipelineOptions extends VisionProcessorOptions {
  /** Processor override (tests). */
  processor?: VisionProcessor;
  /** Error sink (toast + console in the app). */
  onError?: (error: Error) => void;
}

/** The effects pipeline the app installs as the vision hook. */
export class VisionPipeline implements VisionHook {
  private readonly resolveEffects: (clip: Clip) => ClipEffects | null;
  private readonly processor: VisionProcessor;
  private readonly onError: ((error: Error) => void) | null;
  private readonly reported = new Set<string>();
  /** Preview toggle: when false every frame passes through untouched. */
  enabled = true;

  /**
   * @param resolveEffects reads a clip's effects (null = none).
   * @param options processor/LUT options and the error sink.
   */
  constructor(resolveEffects: (clip: Clip) => ClipEffects | null, options: VisionPipelineOptions = {}) {
    this.resolveEffects = resolveEffects;
    this.processor = options.processor ?? new VisionProcessor(options);
    this.onError = options.onError ?? null;
  }

  /** The processor's backend (`webgl2`, `canvas2d`, `none`, or null before use). */
  get backend(): string | null {
    return this.processor.backend;
  }

  /** {@inheritDoc VisionHook.process} */
  process(clip: Clip, source: RenderImage, width: number, height: number): RenderImage | null {
    if (!this.enabled) return null;
    let effects: ClipEffects | null;
    try {
      effects = this.resolveEffects(clip);
    } catch (error) {
      this.report(error);
      return null;
    }
    return effects ? this.applyEffects(source, effects, width, height) : null;
  }

  /**
   * Applies effects to a picture directly (export, thumbnails).
   * @param source the picture.
   * @param effects the effects.
   * @param width output width.
   * @param height output height.
   * @returns the processed picture or `null` (nothing to do / failed).
   */
  applyEffects(source: RenderImage, effects: ClipEffects, width: number, height: number): RenderImage | null {
    if (!hasVisualEffects(effects)) return null;
    try {
      return this.processor.process(source, width, height, effects);
    } catch (error) {
      this.report(error);
      return null;
    }
  }

  /** Frees GPU resources. */
  dispose(): void {
    this.processor.dispose();
  }

  private report(error: unknown): void {
    const err = error instanceof Error ? error : new Error(String(error));
    if (this.reported.has(err.message)) return;
    this.reported.add(err.message);
    this.onError?.(err);
  }
}
