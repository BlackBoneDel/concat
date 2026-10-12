// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Draws audio waveforms inside audio clips. Peaks load once per media and
 * resolution from the `waveforms` cache; until they arrive the clip face
 * is drawn empty and a redraw is requested on arrival.
 */

import { getBestWaveform, type WaveformData } from '../../media/waveform-generator.ts';
import type { DocumentClip } from '../../model/document.ts';
import type { ThemeColors } from './types.ts';

/** The per-view waveform painter. */
export class WaveformRenderer {
  private readonly cache = new Map<string, WaveformData>();
  private readonly pending = new Set<string>();
  private updateHook: (() => void) | null = null;

  /**
   * Registers the redraw callback used when peaks finish loading.
   * @param hook the redraw function.
   */
  onUpdate(hook: () => void): void {
    this.updateHook = hook;
  }

  /**
   * Peaks of one media at the current zoom, `null` while loading.
   * @param mediaId the media.
   * @param pixelsPerSecond the zoom.
   * @returns the cached peaks, or `null`.
   */
  get(mediaId: string, pixelsPerSecond: number): WaveformData | null {
    const found = this.cache.get(mediaId) ?? null;
    if (!found && mediaId !== '' && !this.pending.has(mediaId)) {
      this.pending.add(mediaId);
      void getBestWaveform(mediaId, pixelsPerSecond).then((data) => {
        this.pending.delete(mediaId);
        if (data) this.cache.set(mediaId, data);
        this.updateHook?.();
      });
    }
    return found;
  }

  /**
   * Forgets one media (after reimport or delete).
   * @param mediaId the media.
   */
  invalidate(mediaId: string): void {
    this.cache.delete(mediaId);
  }

  /** Drops everything (unmount). */
  clear(): void {
    this.cache.clear();
    this.pending.clear();
    this.updateHook = null;
  }

  /**
   * Paints the peaks of a clip face.
   * @param ctx the content canvas context.
   * @param clip the clip.
   * @param x face left.
   * @param y face top.
   * @param width face width.
   * @param height face height.
   * @param colors the theme.
   * @param pixelsPerSecond the zoom.
   */
  draw(
    ctx: CanvasRenderingContext2D,
    clip: DocumentClip,
    x: number,
    y: number,
    width: number,
    height: number,
    colors: ThemeColors,
    pixelsPerSecond: number,
  ): void {
    if (clip.mediaId === '') return;
    const peaks = this.get(clip.mediaId, pixelsPerSecond);
    if (!peaks || peaks.data.length === 0) return;
    const midY = y + height / 2;
    const half = height / 2 - 6;
    // Sample window: which part of the media this clip shows.
    const samplesPerSecond = peaks.duration > 0 ? peaks.data.length / 2 / peaks.duration : 0;
    const fromSample = clip.sourceStart * samplesPerSecond;
    const toSample = (clip.sourceStart + clip.duration * clip.speed) * samplesPerSecond;
    const step = Math.max(1, Math.floor((toSample - fromSample) / Math.max(1, width)));
    ctx.strokeStyle = colors.textDim;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let px = 0; px < width; px += 1) {
      const sampleIndex = Math.floor(fromSample + (px / width) * (toSample - fromSample));
      const safeIndex = Math.min(Math.max(0, sampleIndex), peaks.data.length / 2 - 1);
      const min = peaks.data[safeIndex * 2] ?? 0;
      const max = peaks.data[safeIndex * 2 + 1] ?? 0;
      const top = midY - max * half;
      const bottom = midY - min * half;
      ctx.moveTo(x + px + 0.5, top);
      ctx.lineTo(x + px + 0.5, bottom);
    }
    ctx.stroke();
    void step;
  }
}
