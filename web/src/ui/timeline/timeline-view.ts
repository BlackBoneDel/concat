// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The interactive timeline core: two stacked canvases (ruler + content),
 * a virtualized track viewport, the playhead overlay and the geometry
 * helpers every interaction uses. Clips live on the canvas only — no DOM
 * per clip — so 500+ clips stay at 60fps.
 */

import type { DocumentClip, ProjectDocument } from '../../model/document.ts';
import { currentTimeline, trackKindOf, type MarkerData } from '../../editor/operations.ts';
import type { SelectionManager } from '../../editor/selection.ts';
import { drawClips } from './clip-renderer.ts';
import { drawMarkers, drawRuler, markerAtPosition, RULER_HEIGHT } from './ruler.ts';
import { ThumbnailRenderer } from './thumbnail-renderer.ts';
import { drawTransitions } from './transitions-renderer.ts';
import {
  readThemeColors,
  type ClipDragPreview,
  type ClipPreviewer,
  type ThemeColors,
  type TimelineViewport,
  type TrackLayout,
} from './types.ts';
import { WaveformRenderer } from './waveform-renderer.ts';

/** Zoom limits, pixels per second. */
export const MIN_PIXELS_PER_SECOND = 10;
export const MAX_PIXELS_PER_SECOND = 500;

/** Track heights in pixels. */
const HEIGHT_COLLAPSED = 24;
const HEIGHT_AUDIO = 72;
const HEIGHT_VIDEO = 96;

/** How much empty space is kept after the last clip (seconds). */
const TAIL_SECONDS = 20;

/** Everything the view needs to draw. */
export interface TimelineViewOptions {
  /** The scroll host of the content area. */
  container: HTMLElement;
  /** Overlay layer above the canvases (selection box, snap guides). */
  overlay: HTMLElement;
  /** Thumbnail provider for clip faces. */
  preview: ClipPreviewer;
  /** The live document. */
  getDocument(): ProjectDocument;
  /** The ruler markers. */
  markers(): MarkerData[];
  /** The playhead in seconds. */
  playheadSeconds(): number;
  /** Moves the playhead (scrubbing). */
  setPlayhead(seconds: number): void;
  /** Selection, for the highlight. */
  selection: SelectionManager;
}

/** Geometry + rendering of one timeline. */
export class TimelineView {
  private readonly container: HTMLElement;
  private readonly overlay: HTMLElement;
  private readonly rulerCanvas: HTMLCanvasElement;
  private readonly contentCanvas: HTMLCanvasElement;
  private readonly playheadEl: HTMLDivElement;
  private readonly options: TimelineViewOptions;

  private viewportState: TimelineViewport = {
    pixelsPerSecond: 80,
    scrollTime: 0,
    scrollTop: 0,
    width: 0,
    height: 0,
  };
  private layouts: TrackLayout[] = [];
  private layoutById = new Map<string, TrackLayout>();
  private totalWidth = 0;
  private totalHeight = 0;
  private framePending = false;
  private resizeObserver: ResizeObserver | null = null;
  private disposed = false;
  private colors: ThemeColors | null = null;
  /** Colors are cached until the theme flips. */
  private colorSignature = '';
  private readonly waveform: WaveformRenderer;
  private readonly thumbnails: ThumbnailRenderer;
  private dragPreviewState: ClipDragPreview | null = null;

  /**
   * @param options view wiring.
   */
  constructor(options: TimelineViewOptions) {
    this.options = options;
    this.container = options.container;
    this.overlay = options.overlay;
    this.waveform = new WaveformRenderer();
    this.thumbnails = new ThumbnailRenderer(options.preview);
    this.waveform.onUpdate(() => this.requestRender());
    this.thumbnails.onUpdate(() => this.requestRender());
    this.rulerCanvas = document.createElement('canvas');
    this.rulerCanvas.className = 'tl-canvas tl-canvas-ruler';
    this.contentCanvas = document.createElement('canvas');
    this.contentCanvas.className = 'tl-canvas tl-canvas-content';
    this.playheadEl = document.createElement('div');
    this.playheadEl.className = 'tl-playhead';
    this.playheadEl.setAttribute('aria-hidden', 'true');
    this.container.append(this.rulerCanvas, this.contentCanvas, this.playheadEl);
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.relayout());
      this.resizeObserver.observe(this.container);
    }
  }

  /** Detaches listeners and observers. */
  dispose(): void {
    this.disposed = true;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.waveform.clear();
    this.thumbnails.clear();
    this.rulerCanvas.remove();
    this.contentCanvas.remove();
    this.playheadEl.remove();
  }

  /** The live viewport (do not mutate). */
  viewport(): TimelineViewport {
    return { ...this.viewportState };
  }

  /** The ruler's height in pixels. */
  get rulerHeight(): number {
    return RULER_HEIGHT;
  }

  /** Content width including the empty tail. */
  contentWidth(): number {
    return this.totalWidth;
  }

  /** Content height including every track. */
  contentHeight(): number {
    return this.totalHeight;
  }

  /** All track layouts, top to bottom. */
  trackLayouts(): TrackLayout[] {
    return this.layouts;
  }

  /**
   * The layout of one track.
   * @param trackId the track.
   * @returns its layout, or `null` when unknown.
   */
  trackLayout(trackId: string): TrackLayout | null {
    return this.layoutById.get(trackId) ?? null;
  }

  /**
   * Time → x inside the content canvas.
   * @param seconds the time.
   * @returns pixels from the left edge of the content.
   */
  timeToX(seconds: number): number {
    return (seconds - this.viewportState.scrollTime) * this.viewportState.pixelsPerSecond;
  }

  /**
   * x → time.
   * @param x pixels from the left edge of the content.
   * @returns the timeline time.
   */
  xToTime(x: number): number {
    return this.viewportState.scrollTime + x / this.viewportState.pixelsPerSecond;
  }

  /**
   * The track layout under a y coordinate (content space).
   * @param y pixels below the tracks area top.
   * @returns the layout, or `null` between/outside tracks.
   */
  trackAtY(y: number): TrackLayout | null {
    const scrolled = y + this.viewportState.scrollTop;
    for (const layout of this.layouts) {
      if (scrolled >= layout.y && scrolled < layout.y + layout.height) return layout;
    }
    return null;
  }

  /**
   * The clip under a point.
   * @param x content x.
   * @param y content y.
   * @returns the topmost clip there, or `null`.
   */
  clipAt(x: number, y: number): DocumentClip | null {
    const layout = this.trackAtY(y);
    if (!layout) return null;
    const time = this.xToTime(x);
    const timeline = currentTimeline(this.options.getDocument());
    const clips = timeline.clips.filter((clip) => clip.trackId === layout.trackId);
    for (let index = clips.length - 1; index >= 0; index -= 1) {
      const clip = clips[index]!;
      const end = clip.start + clip.duration;
      if (time >= clip.start && time < end) return clip;
    }
    return null;
  }

  /**
   * Zooms while keeping one time anchored under its pixel.
   * @param pixelsPerSecond the new zoom.
   * @param anchorSeconds the time to keep in place.
   */
  setZoom(pixelsPerSecond: number, anchorSeconds?: number): void {
    const clamped = Math.min(
      MAX_PIXELS_PER_SECOND,
      Math.max(MIN_PIXELS_PER_SECOND, pixelsPerSecond),
    );
    const anchor = anchorSeconds ?? this.xToTime(this.viewportState.width / 2);
    const anchorX = this.timeToX(anchor);
    this.viewportState.pixelsPerSecond = clamped;
    this.viewportState.scrollTime = Math.max(0, anchor - anchorX / clamped);
    this.requestRender();
  }

  /** Current zoom. */
  zoom(): number {
    return this.viewportState.pixelsPerSecond;
  }

  /**
   * Scrolls the view so a time is visible (with margin).
   * @param seconds the time.
   */
  ensureVisible(seconds: number): void {
    const margin = 40 / this.viewportState.pixelsPerSecond;
    const { scrollTime, width, pixelsPerSecond } = this.viewportState;
    const visibleEnd = scrollTime + width / pixelsPerSecond;
    if (seconds < scrollTime + margin) {
      this.viewportState.scrollTime = Math.max(0, seconds - margin);
      this.requestRender();
    } else if (seconds > visibleEnd - margin) {
      this.viewportState.scrollTime = seconds - width / pixelsPerSecond + margin;
      this.requestRender();
    }
  }

  /**
   * Applies a horizontal scroll (seconds at the left edge).
   * @param scrollTime the new left-edge time.
   */
  setScrollTime(scrollTime: number): void {
    this.viewportState.scrollTime = Math.max(0, scrollTime);
    this.requestRender();
  }

  /**
   * Applies the vertical scroll.
   * @param scrollTop pixels.
   */
  setScrollTop(scrollTop: number): void {
    this.viewportState.scrollTop = Math.max(0, scrollTop);
    this.requestRender();
  }

  /** The playhead position in content pixels. */
  playheadX(): number {
    return this.timeToX(this.options.playheadSeconds());
  }

  /** Recomputes track geometry after document/zoom/size changes. */
  relayout(): void {
    const rect = this.container.getBoundingClientRect();
    this.viewportState.width = Math.max(0, rect.width);
    this.viewportState.height = Math.max(0, rect.height);
    const timeline = currentTimeline(this.options.getDocument());
    this.layouts = [];
    this.layoutById.clear();
    const doc = this.options.getDocument();
    let y = 0;
    for (const track of timeline.tracks) {
      const collapsed = track.extra['collapsed'] === true;
      const height = collapsed
        ? HEIGHT_COLLAPSED
        : trackKindOf(doc, track) === 'audio'
          ? HEIGHT_AUDIO
          : HEIGHT_VIDEO;
      const layout: TrackLayout = { trackId: track.id, y, height, collapsed };
      this.layouts.push(layout);
      this.layoutById.set(track.id, layout);
      y += height;
    }
    this.totalHeight = y;
    const duration = timeline.clips.reduce((end, clip) => Math.max(end, clip.start + clip.duration), 0);
    this.totalWidth = Math.max(
      this.viewportState.width,
      (duration + TAIL_SECONDS) * this.viewportState.pixelsPerSecond,
    );
    this.requestRender();
  }

  /** Schedules a redraw on the next frame (throttled). */
  requestRender(): void {
    if (this.framePending || this.disposed) return;
    this.framePending = true;
    requestAnimationFrame(() => {
      this.framePending = false;
      if (!this.disposed) this.render();
    });
  }

  /** Redraws both canvases now. */
  render(): void {
    const colors = this.themeColors();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(this.viewportState.width));
    const height = Math.max(1, Math.round(this.viewportState.height));
    for (const canvas of [this.rulerCanvas, this.contentCanvas]) {
      const targetHeight = canvas === this.rulerCanvas ? RULER_HEIGHT : height;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${targetHeight}px`;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(targetHeight * dpr);
    }
    const rulerCtx = this.rulerCanvas.getContext('2d');
    const contentCtx = this.contentCanvas.getContext('2d');
    if (!rulerCtx || !contentCtx) return;
    rulerCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    contentCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const viewport = this.viewport();
    drawRuler(rulerCtx, viewport, colors, width);
    drawMarkers(rulerCtx, this.options.markers(), viewport, width);
    contentCtx.clearRect(0, 0, width, height);
    this.drawLanes(contentCtx, colors, width, height);
    const document_ = this.options.getDocument();
    const timeline = currentTimeline(document_);
    drawClips(contentCtx, {
      clips: timeline.clips,
      layouts: this.layouts,
      viewport,
      colors,
      width,
      height,
      selection: this.options.selection,
      document: document_,
      waveform: this.waveform,
      thumbnails: this.thumbnails,
      preview: this.dragPreviewState,
    });
    drawTransitions(contentCtx, {
      clips: timeline.clips,
      layouts: this.layouts,
      viewport,
      colors,
    });
    this.updatePlayhead();
  }

  /** Positions the playhead element (no canvas work). */
  updatePlayhead(): void {
    const x = this.playheadX();
    this.playheadEl.style.transform = `translateX(${Math.round(x)}px)`;
    this.playheadEl.style.display = x < -2 || x > this.viewportState.width + 2 ? 'none' : '';
  }

  /**
   * Hit-tests the ruler.
   * @param x content x.
   * @param y content y.
   * @returns the marker under the point, or `null`.
   */
  markerAt(x: number, y: number): MarkerData | null {
    return markerAtPosition(this.options.markers(), this.viewport(), x, y);
  }

  /** The content element's rect (pointer → content coordinates). */
  contentRect(): DOMRect {
    return this.container.getBoundingClientRect();
  }

  /**
   * Scrubs the playhead to a content x.
   * @param x pixels from the content's left edge.
   */
  setPlayheadFromX(x: number): void {
    const time = Math.max(0, this.xToTime(x));
    this.options.setPlayhead(time);
    this.updatePlayhead();
  }

  /**
   * Sets the visual-only drag preview (null clears it).
   * @param preview the preview state.
   */
  setDragPreview(preview: ClipDragPreview | null): void {
    this.dragPreviewState = preview;
  }

  /** The current drag preview, if any. */
  dragPreview(): ClipDragPreview | null {
    return this.dragPreviewState;
  }

  /** The overlay layer (selection box, snap guides). */
  get overlayLayer(): HTMLElement {
    return this.overlay;
  }

  /** The theme colors in effect. */
  private themeColors(): ThemeColors {
    const signature = document.documentElement.getAttribute('data-theme') ?? 'system';
    if (!this.colors || signature !== this.colorSignature) {
      this.colorSignature = signature;
      this.colors = readThemeColors(this.container);
    }
    return this.colors;
  }

  /** Fills the track lanes (alternating). */
  private drawLanes(
    ctx: CanvasRenderingContext2D,
    colors: ThemeColors,
    width: number,
    height: number,
  ): void {
    ctx.fillStyle = colors.background;
    ctx.fillRect(0, 0, width, height);
    const top = this.viewportState.scrollTop;
    this.layouts.forEach((layout, index) => {
      const y = layout.y - top;
      if (y > height || y + layout.height < 0) return;
      ctx.fillStyle = index % 2 === 0 ? colors.trackLane : colors.trackLaneAlt;
      ctx.fillRect(0, y, width, layout.height);
      ctx.strokeStyle = colors.gridLine;
      ctx.beginPath();
      ctx.moveTo(0, Math.round(y + layout.height) - 0.5);
      ctx.lineTo(width, Math.round(y + layout.height) - 0.5);
      ctx.stroke();
    });
  }
}
