// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Shared timeline types: tools, viewport, preview provider. */

import type { DocumentClip } from '../../model/document.ts';

/** The timeline tools (V C B N Y U P + the H hand for panning). */
export type ToolId = 'select' | 'blade' | 'ripple' | 'roll' | 'slip' | 'slide' | 'pen' | 'hand';

/** Track heights in pixels (shared by the layout, the headers and the drop ghost). */
export const TRACK_HEIGHT_COLLAPSED = 24;
export const TRACK_HEIGHT_AUDIO = 72;
export const TRACK_HEIGHT_VIDEO = 96;

/** Anything the timeline can draw (never `ImageData`: it cannot scale). */
export type DrawableImage = ImageBitmap | HTMLCanvasElement | HTMLImageElement;

/** The clip previewer the timeline asks for thumbnails. */
export interface ClipPreviewer {
  /**
   * A frame of one clip, for its thumbnail.
   * @param sourceTimeSeconds where in the source to grab the frame.
   * @param clip the clip (transitions/opacity are ignored for thumbs).
   * @returns a drawable frame, or `null` when it cannot decode yet.
   */
  frameAt(sourceTimeSeconds: number, clip: DocumentClip): Promise<DrawableImage | null>;
}

/** Where the timeline is looking. */
export interface TimelineViewport {
  /** Zoom in pixels per second (10–500). */
  pixelsPerSecond: number;
  /** Seconds at the left edge of the visible area. */
  scrollTime: number;
  /** Vertical scroll in pixels (tracks area). */
  scrollTop: number;
  /** Visible width in pixels. */
  width: number;
  /** Visible height in pixels (tracks area). */
  height: number;
}

/** The size of one track in the content area. */
export interface TrackLayout {
  trackId: string;
  /** Y offset from the top of the tracks area (excludes the ruler). */
  y: number;
  height: number;
  /** Whether the track is drawn flat (collapsed). */
  collapsed: boolean;
  /** Fase 5: px at the bottom of the track for expanded keyframe lanes (included in `height`). */
  keyframeLane?: number;
}

/** Visual-only state of a drag in progress (document untouched). */
export interface ClipDragPreview {
  /** Where each dragged clip is painted while the gesture runs. */
  offsets: Map<string, { deltaTime: number; toTrackId: string | null }>;
  /** Trimmed faces while a trim gesture runs. */
  trims?: Map<string, { start: number; duration: number }>;
  /** A marker being dragged. */
  markerId?: string;
  /** The marker's ghost time while it drags. */
  markerTime?: number;
}

/** Helpers shared by renderers: colors pulled from CSS variables. */
export interface ThemeColors {
  background: string;
  trackLane: string;
  trackLaneAlt: string;
  clipVideo: string;
  clipAudio: string;
  clipImage: string;
  clipSelected: string;
  clipMissing: string;
  clipDisabled: string;
  text: string;
  textDim: string;
  accent: string;
  playhead: string;
  marker: string;
  transition: string;
  gridLine: string;
  rulerBackground: string;
  border: string;
}

const FALLBACK_COLORS: ThemeColors = {
  background: '#141417',
  trackLane: '#1c1c20',
  trackLaneAlt: '#202024',
  clipVideo: '#2e63c8',
  clipAudio: '#2e8f5c',
  clipImage: '#8f5cc8',
  clipSelected: '#4c8dff',
  clipMissing: '#c84040',
  clipDisabled: '#55555c',
  text: '#e8e8ea',
  textDim: '#8c8c94',
  accent: '#4c8dff',
  playhead: '#ff4d4d',
  marker: '#4c8dff',
  transition: '#c8a04c',
  gridLine: '#2a2a30',
  rulerBackground: '#101014',
  border: '#2c2c32',
};

/**
 * Reads the current theme's timeline colors from CSS variables.
 * @param root an element inside the themed tree (usually the timeline root).
 * @returns the resolved colors (fallback values when variables are missing).
 */
export function readThemeColors(root: HTMLElement): ThemeColors {
  const style = getComputedStyle(root);
  const pick = (name: string, fallback: string): string => {
    const value = style.getPropertyValue(name).trim();
    return value === '' ? fallback : value;
  };
  return {
    background: pick('--bg-secondary', FALLBACK_COLORS.background),
    trackLane: pick('--bg-primary', FALLBACK_COLORS.trackLane),
    trackLaneAlt: pick('--bg-tertiary', FALLBACK_COLORS.trackLaneAlt),
    clipVideo: pick('--accent-primary', FALLBACK_COLORS.clipVideo),
    clipAudio: pick('--success', FALLBACK_COLORS.clipAudio),
    clipImage: pick('--warning', FALLBACK_COLORS.clipImage),
    clipSelected: pick('--accent-hover', FALLBACK_COLORS.clipSelected),
    clipMissing: pick('--error', FALLBACK_COLORS.clipMissing),
    clipDisabled: pick('--border', FALLBACK_COLORS.clipDisabled),
    text: pick('--text-primary', FALLBACK_COLORS.text),
    textDim: pick('--text-tertiary', FALLBACK_COLORS.textDim),
    accent: pick('--accent-primary', FALLBACK_COLORS.accent),
    playhead: pick('--error', FALLBACK_COLORS.playhead),
    marker: pick('--accent-primary', FALLBACK_COLORS.marker),
    transition: pick('--warning', FALLBACK_COLORS.transition),
    gridLine: pick('--border', FALLBACK_COLORS.gridLine),
    rulerBackground: pick('--bg-primary', FALLBACK_COLORS.rulerBackground),
    border: pick('--border', FALLBACK_COLORS.border),
  };
}
