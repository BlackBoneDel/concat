// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** The timeline module: view, renderers, interactions and controls. */
export {
  TimelineView,
  MIN_PIXELS_PER_SECOND,
  MAX_PIXELS_PER_SECOND,
  type TimelineViewOptions,
} from './timeline-view.ts';
export {
  RULER_HEIGHT,
  drawRuler,
  drawMarkers,
  markerAtPosition,
  formatRulerTime,
} from './ruler.ts';
export { drawClips, roundedRect, type DrawClipsContext } from './clip-renderer.ts';
export { drawTransitions, type DrawTransitionsContext } from './transitions-renderer.ts';
export { WaveformRenderer } from './waveform-renderer.ts';
export { ThumbnailRenderer } from './thumbnail-renderer.ts';
export {
  readThemeColors,
  type ClipDragPreview,
  type ClipPreviewer,
  type DrawableImage,
  type ThemeColors,
  type TimelineViewport,
  type ToolId,
  type TrackLayout,
} from './types.ts';
export { SnapGuides } from './snap-guides.ts';
export { SelectionBox } from './selection-box.ts';
export { Playhead } from './playhead.ts';
export { TrackHeader, type TrackHeaderOptions } from './track-header.ts';
export { openMarkerEditor, MARKER_COLORS } from './markers.ts';
export { ZoomControl, type ZoomControlOptions } from './zoom-control.ts';
export { Minimap, type MinimapOptions } from './minimap.ts';
export { Toolbar, type ToolbarActions } from './toolbar.ts';
export { ContextMenu, type MenuItem } from './context-menu.ts';
