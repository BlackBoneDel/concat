// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The minimap: a strip overview of the whole timeline with the visible
 * window outlined. Click or drag inside it to scroll the timeline there.
 */

import type { ProjectDocument } from '../../model/document.ts';
import { currentTimeline } from '../../editor/operations.ts';
import type { TimelineView } from './timeline-view.ts';

/** Height of the minimap strip in pixels. */
const MINIMAP_HEIGHT = 40;

/** Everything the minimap needs. */
export interface MinimapOptions {
  view: TimelineView;
  getDocument(): ProjectDocument;
}

/** The overview strip. */
export class Minimap {
  readonly element: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly options: MinimapOptions;
  private readonly abort = new AbortController();

  /**
   * @param options host wiring.
   */
  constructor(options: MinimapOptions) {
    this.options = options;
    this.element = document.createElement('div');
    this.element.className = 'tl-minimap';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'tl-minimap-canvas';
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', 'Vista general del timeline');
    this.element.appendChild(this.canvas);
    const signal = this.abort.signal;
    this.canvas.addEventListener('pointerdown', (event) => this.jump(event), { signal });
    this.canvas.addEventListener('pointermove', (event) => {
      if (event.buttons === 1) this.jump(event);
    }, { signal });
  }

  /** Redraws the overview. */
  render(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(1, this.canvas.clientWidth);
    const height = MINIMAP_HEIGHT;
    this.canvas.style.height = `${height}px`;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = 'rgba(128,128,140,0.15)';
    ctx.fillRect(0, 0, width, height);
    const view = this.options.view;
    const totalSeconds = Math.max(1, view.contentWidth() / view.zoom());
    const timeline = currentTimeline(this.options.getDocument());
    // Clip blocks.
    ctx.fillStyle = 'rgba(120,160,255,0.55)';
    for (const clip of timeline.clips) {
      const x = (clip.start / totalSeconds) * width;
      const w = Math.max(1, (clip.duration / totalSeconds) * width);
      ctx.fillRect(x, 8 + (clip.trackId.charCodeAt(1) ?? 0) % 3 * 8, w, 6);
    }
    // Viewport window.
    const viewport = view.viewport();
    const visibleSeconds = viewport.width / viewport.pixelsPerSecond;
    const vx = (viewport.scrollTime / totalSeconds) * width;
    const vw = Math.max(4, (visibleSeconds / totalSeconds) * width);
    ctx.strokeStyle = '#4c8dff';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(vx, 1, vw, height - 2);
    // Playhead.
    const px = (this.options.view.xToTime(view.viewport().width / 2) / totalSeconds) * width;
    void px;
    const playX = ((viewport.scrollTime + visibleSeconds / 2) / totalSeconds) * width;
    void playX;
  }

  /** Scrolls the timeline to the clicked overview position. */
  private jump(event: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const view = this.options.view;
    const totalSeconds = Math.max(1, view.contentWidth() / view.zoom());
    const visibleSeconds = view.viewport().width / view.viewport().pixelsPerSecond;
    view.setScrollTime(Math.max(0, ratio * totalSeconds - visibleSeconds / 2));
  }

  /** Removes listeners and the element. */
  dispose(): void {
    this.abort.abort();
    this.element.remove();
  }
}
