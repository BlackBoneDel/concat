// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Fase 5 services for the UI (presets, font manager, live keyframe-curve
 * preview), installed once by `main.ts`. Like {@link getMediaTools}, kept
 * apart from `AppContext` so earlier panels and tests compile unchanged;
 * readers degrade gracefully when it is absent.
 */

import type { PresetManager } from '../presets/preset-manager.ts';
import type { KeyframeRef } from './timeline/keyframe-track.ts';

/** What the F5 inspector sections call. */
export interface StudioServices {
  /** User + built-in presets. */
  readonly presets: PresetManager | null;
  /** Opens the font manager dialog. */
  openFontManager(): void;
  /** Ghost curve on the timeline lane while a Bézier handle drags (`null` clears it). */
  previewKeyframeCurve(clipId: string, ref: KeyframeRef, curve: readonly number[] | null): void;
  /** Toast + console. */
  reportError(title: string, error: unknown): void;
}

let services: StudioServices | null = null;

/**
 * Installs (or clears) the services.
 * @param value the services, or `null`.
 */
export function setStudioServices(value: StudioServices | null): void {
  services = value;
}

/** The installed services, if any. */
export function getStudioServices(): StudioServices | null {
  return services;
}
