// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Fase 5: the compositor's effect-stack hook registry. Kept apart from
 * `video-effects-engine.ts` so the engine (WebGL shaders, CPU kernels) can be
 * loaded lazily; with no hook installed Fase 4 rendering is unchanged.
 */

import type { Clip } from '../core/timeline.ts';
import type { VideoEffectInstance } from '../media/effects/effects-stack.ts';
import type { RenderImage } from './types.ts';

/** The cropped region of the source the stack runs on (source pixels). */
export interface SourceRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/** What the compositor calls between the key stage and the grade stage. */
export interface VideoEffectsHook {
  /**
   * The active (enabled, non-neutral) effects of a clip.
   * @param clip the engine clip.
   * @returns the effects in order, or `null` when there is nothing to do.
   */
  resolve(clip: Clip): readonly VideoEffectInstance[] | null;
  /**
   * Renders the stack.
   * @param source the (keyed) source picture.
   * @param rect the crop to process.
   * @param stack the effects.
   * @param time clip-local seconds.
   * @returns a picture of `rect.sw × rect.sh`, or `null` to draw the source as-is.
   */
  apply(source: RenderImage, rect: SourceRect, stack: readonly VideoEffectInstance[], time: number): RenderImage | null;
}

let installedHook: VideoEffectsHook | null = null;

/**
 * Installs (or clears) the process-wide effects hook.
 * @param hook the hook, or `null`.
 */
export function setVideoEffectsHook(hook: VideoEffectsHook | null): void {
  installedHook = hook;
}

/** The installed hook, if any. */
export function getVideoEffectsHook(): VideoEffectsHook | null {
  return installedHook;
}

