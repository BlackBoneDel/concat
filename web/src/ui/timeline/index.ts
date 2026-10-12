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
// Fase 8: drag & drop from the media library + timeline coordinate maths.
export {
  DEFAULT_DRAG_DURATION,
  MEDIA_DRAG_DURATION_MIME,
  MEDIA_DRAG_MIME,
  MEDIA_DRAG_MIMES,
  MEDIA_DRAG_NAME_MIME,
  MEDIA_DRAG_TYPE_MIME,
  hasMediaDrag,
  parseDragDuration,
  readMediaDrag,
  writeMediaDrag,
  type DataTransferLike,
  type MediaDragEventLike,
  type MediaDragKind,
  type MediaDragPayload,
} from '../dnd/media-drag.ts';
export { markDropHandled, wasDropHandled } from '../dnd/drop-handled.ts';
export {
  buildTextClip,
  insertTextClipOperation,
  DEFAULT_TEXT_CONTENT,
  DEFAULT_TEXT_DURATION,
  type TextClipOptions,
} from './add-text.ts';
export {
  getTrackAtY,
  layoutRects,
  layoutToRect,
  localPoint,
  pixelsToTime,
  timeToPixels,
  type TrackRect,
} from './coord-utils.ts';
export {
  DROP_BORDER,
  DROP_FILL,
  drawDropPreview,
  dropPreviewRect,
  laneHeight,
  type DropPreviewRect,
  type DropPreviewState,
} from './drop-preview.ts';
export { installMediaDrop, type DropMode, type MediaDropHandle, type MediaDropOptions } from './media-drop.ts';
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
// Fase 5: keyframe lanes.
export { expandButtonRect, FACE_PADDING } from './clip-renderer.ts';
export {
  KEYFRAME_LANE_HEIGHT,
  LANE_PADDING,
  NODE_RADIUS,
  atToLaneX,
  drawKeyframeNode,
  hitKeyframe,
  keyframeNodes,
  laneYToPercent,
  segmentAt,
  valueToLaneY,
  type KeyframeNode,
  type LaneRect,
} from './keyframe-node.ts';
export {
  KeyframeSelectionStore,
  LANE_LABELS,
  LANE_PROPERTIES,
  defaultLaneProperty,
  drawKeyframeLanes,
  hitKeyframeLane,
  keyframeSelection,
  lanePropertiesFor,
  laneRectFor,
  nextLaneProperty,
  sampleLaneCurve,
  withPreview,
  type KeyframeGesturePreview,
  type KeyframeLaneState,
  type KeyframeRef,
  type LaneHit,
} from './keyframe-track.ts';
