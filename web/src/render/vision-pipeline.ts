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

/**
 * Fase 5: which part of the vision effects to run. The compositor splits the
 * F4 pass around the effect stack — `key` (chroma/luma/spill/feather) before
 * it, `grade` (colour grading + LUT) after it; `all` is the Fase 4 pass.
 */
export type VisionStage = 'all' | 'key' | 'grade';

/**
 * Restricts effects to one stage.
 * @param effects the clip's effects.
 * @param stage the stage to keep.
 * @returns a copy with the other stage's sections cleared.
 */
export function effectsForStage(effects: ClipEffects, stage: VisionStage): ClipEffects {
  if (stage === 'key') return { ...effects, colorGrading: null, lut: null, splitView: false };
  if (stage === 'grade') return { ...effects, chromaKey: null, lumaKey: null, spill: null, feather: null };
  return effects;
}

/** What the compositor calls. */
export interface VisionHook {
  /**
   * @param clip the clip being drawn.
   * @param source its decoded frame.
   * @param width the source's pixel width (as the compositor crops it).
   * @param height the source's pixel height.
   * @param stage Fase 5: run only the key or the grade part (default: all).
   * @returns a processed picture of the same size, or `null` for the source as-is.
   */
  process(clip: Clip, source: RenderImage, width: number, height: number, stage?: VisionStage): RenderImage | null;
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
  process(clip: Clip, source: RenderImage, width: number, height: number, stage: VisionStage = 'all'): RenderImage | null {
    if (!this.enabled) return null;
    let effects: ClipEffects | null;
    try {
      effects = this.resolveEffects(clip);
    } catch (error) {
      this.report(error);
      return null;
    }
    return effects ? this.applyEffects(source, effectsForStage(effects, stage), width, height) : null;
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
