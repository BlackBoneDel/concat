// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Small clip-face thumbnails. Frames come from the shared
 * {@link ClipPreviewer} (the preview pipeline) and are cached per clip
 * until the clip's media or source range changes.
 */

import type { DocumentClip } from '../../model/document.ts';
import type { ClipPreviewer, DrawableImage } from './types.ts';

/** Face thumbnail painter for one view. */
export class ThumbnailRenderer {
  private readonly images = new Map<string, { image: DrawableImage; stamp: string }>();
  private readonly pending = new Set<string>();
  private updateHook: (() => void) | null = null;

  /**
   * @param preview the frame source.
   */
  constructor(private readonly preview: ClipPreviewer) {}

  /**
   * Registers the redraw callback used when a frame arrives.
   * @param hook the redraw function.
   */
  onUpdate(hook: () => void): void {
    this.updateHook = hook;
  }

  /**
   * The cached thumbnail of a clip, queueing a fetch when missing.
   * @param clip the clip.
   * @returns the image, or `null`.
   */
  get(clip: DocumentClip): DrawableImage | null {
    const stamp = this.stamp(clip);
    const found = this.images.get(clip.id);
    if (found && found.stamp === stamp) return found.image;
    if (!this.pending.has(clip.id) && clip.mediaId !== '') {
      this.pending.add(clip.id);
      const middle = clip.sourceStart / 2 + (clip.sourceStart + clip.duration * clip.speed) / 2;
      void this.preview.frameAt(middle, clip).then((image) => {
        this.pending.delete(clip.id);
        if (image) this.images.set(clip.id, { image, stamp });
        this.updateHook?.();
      });
    }
    return found?.stamp === stamp ? (found.image ?? null) : null;
  }

  /**
   * Drops one clip's thumbnail (edit or delete).
   * @param clipId the clip.
   */
  invalidate(clipId: string): void {
    this.images.delete(clipId);
  }

  /** Drops everything (unmount). */
  clear(): void {
    this.images.clear();
    this.pending.clear();
    this.updateHook = null;
  }

  /**
   * Paints the thumbnail of a clip face.
   * @param ctx the content canvas context.
   * @param clip the clip.
   * @param x face left.
   * @param y face top.
   * @param height face height.
   */
  draw(
    ctx: CanvasRenderingContext2D,
    clip: DocumentClip,
    x: number,
    y: number,
    height: number,
  ): void {
    const image = this.get(clip);
    if (!image) return;
    const size = Math.min(48, height - 16);
    const thumbY = y + 8;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + 8, thumbY, size, (size * 9) / 16);
    ctx.clip();
    ctx.drawImage(image, x + 8, thumbY, size, (size * 9) / 16);
    ctx.restore();
  }

  /** The cache stamp of a clip (media + range). */
  private stamp(clip: DocumentClip): string {
    return `${clip.mediaId}|${clip.sourceStart}|${(clip.sourceStart + clip.duration * clip.speed)}`;
  }
}
