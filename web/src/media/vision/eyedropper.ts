// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Key-colour eyedropper over the preview canvas.
 *
 * Prefers the browser's native `EyeDropper` (Chromium) — it samples any
 * pixel on screen — and otherwise arms a one-shot click on the preview
 * canvas that averages a small square via {@link pickColorFromCanvas}.
 * Escape cancels; listeners are always removed.
 */

import { pickColorFromCanvas, type PixelReader } from './chroma-key.ts';
import { hexToRgb, type Rgb255 } from './color-space.ts';

/** The native API, when present (`window.EyeDropper`). */
interface NativeEyeDropper {
  open(): Promise<{ sRGBHex: string }>;
}

/** Reads the native constructor without casts. */
function nativeEyeDropper(): (new () => NativeEyeDropper) | null {
  if (typeof window === 'undefined') return null;
  const ctor: unknown = Reflect.get(window, 'EyeDropper');
  return typeof ctor === 'function' ? (ctor as new () => NativeEyeDropper) : null;
}

/** The slice of a canvas element the eyedropper needs. */
export interface EyedropperCanvas {
  readonly width: number;
  readonly height: number;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
  addEventListener(type: 'click', listener: (event: MouseEvent) => void): void;
  removeEventListener(type: 'click', listener: (event: MouseEvent) => void): void;
  style: { cursor: string };
}

/** One-shot colour picker. */
export class Eyedropper {
  private cancelActive: (() => void) | null = null;

  /**
   * Picks a colour.
   * @param canvas the preview canvas (fallback path).
   * @param reader a 2D reader over that canvas.
   * @param options `useNative` (default true), sample `radius`.
   * @returns the colour, or `null` when cancelled.
   */
  async pick(canvas: EyedropperCanvas, reader: PixelReader, options: { useNative?: boolean; radius?: number } = {}): Promise<Rgb255 | null> {
    this.cancel();
    const Native = options.useNative === false ? null : nativeEyeDropper();
    if (Native) {
      try {
        const result = await new Native().open();
        return hexToRgb(result.sRGBHex);
      } catch {
        return null; // user pressed Escape
      }
    }
    return new Promise<Rgb255 | null>((resolve) => {
      const previousCursor = canvas.style.cursor;
      const cleanup = (): void => {
        canvas.removeEventListener('click', onClick);
        if (typeof document !== 'undefined') document.removeEventListener('keydown', onKey, true);
        canvas.style.cursor = previousCursor;
        this.cancelActive = null;
      };
      const onClick = (event: MouseEvent): void => {
        const rect = canvas.getBoundingClientRect();
        const x = ((event.clientX - rect.left) / Math.max(1, rect.width)) * canvas.width;
        const y = ((event.clientY - rect.top) / Math.max(1, rect.height)) * canvas.height;
        cleanup();
        resolve(pickColorFromCanvas(reader, x, y, options.radius ?? 2));
      };
      const onKey = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') {
          cleanup();
          resolve(null);
        }
      };
      this.cancelActive = () => {
        cleanup();
        resolve(null);
      };
      canvas.style.cursor = 'crosshair';
      canvas.addEventListener('click', onClick);
      if (typeof document !== 'undefined') document.addEventListener('keydown', onKey, true);
    });
  }

  /** Cancels a pending pick. */
  cancel(): void {
    this.cancelActive?.();
  }

  /** Whether a pick is armed. */
  get active(): boolean {
    return this.cancelActive !== null;
  }
}
