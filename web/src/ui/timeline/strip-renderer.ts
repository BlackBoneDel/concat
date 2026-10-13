// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The filmstrip cache of one timeline view: which media already have their
 * frames, and a redraw hook for when one lands. Reads are synchronous (the
 * canvas paint is); the provider behind it does the decoding.
 */

import type { ThumbnailStripProvider, TimelineThumbnailStrip } from './types.ts';

/** Face filmstrips for one view. */
export class StripRenderer {
  private readonly strips = new Map<string, TimelineThumbnailStrip>();
  private updateHook: (() => void) | null = null;
  /** Media the provider already said "no frames yet" for (no busy-looping). */
  private readonly requested = new Set<string>();

  /**
   * @param provider where the frames come from (the media pool), or `null`
   * when the timeline has no library (tests).
   */
  constructor(private readonly provider: ThumbnailStripProvider | null) {}

  /**
   * Registers the redraw callback used when a strip arrives.
   * @param hook the redraw function.
   */
  onUpdate(hook: () => void): void {
    this.updateHook = hook;
  }

  /**
   * The strip of a media, or `null` while it is still being generated.
   * @param mediaId the media.
   * @returns the frames plus their timing.
   */
  get(mediaId: string): TimelineThumbnailStrip | null {
    if (mediaId === '') return null;
    const known = this.strips.get(mediaId);
    if (known) return known;
    const fromProvider = this.provider?.strip(mediaId) ?? null;
    if (!fromProvider) {
      this.requested.add(mediaId);
      return null;
    }
    this.strips.set(mediaId, fromProvider);
    return fromProvider;
  }

  /**
   * Drops one media's frames so the next paint re-reads the provider.
   * @param mediaId the media.
   */
  invalidate(mediaId: string): void {
    this.strips.delete(mediaId);
    this.requested.delete(mediaId);
  }

  /** Drops everything and tells the view to repaint. */
  refresh(): void {
    this.strips.clear();
    this.requested.clear();
    this.updateHook?.();
  }

  /** Media the view asked about while they had no frames (diagnostics). */
  get pending(): readonly string[] {
    return [...this.requested];
  }

  /** Unmount. */
  clear(): void {
    this.strips.clear();
    this.requested.clear();
    this.updateHook = null;
  }
}
