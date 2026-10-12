// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The expandable keyframe sub-lane under a clip (toggled with its "⏷"
 * button): a centre line, the interpolation curve of one property sampled
 * through `core/animate.ts` (the same {@link KeyTrack} the compositor uses,
 * so the drawing is the motion), and one ◆ per key.
 *
 * Also hosts the tiny keyframe-selection store shared by the timeline (which
 * selects ◆) and the inspector's Bézier editor (which edits its curve).
 */

import { Ease, Key, KeyTrack } from '../../core/animate.ts';
import type { CubicBezier } from '../../editor/keyframe-operations.ts';
import { clipConstant, type DocumentClip } from '../../model/document.ts';
import { KeyEase, type KeyProperty } from '../../model/wire.ts';
import { keyframeId } from '../../editor/operations.ts';
import {
  drawKeyframeNode,
  hitKeyframe,
  KEYFRAME_LANE_HEIGHT,
  keyframeNodes,
  laneYToPercent,
  segmentAt,
  valueToLaneY,
  type KeyframeNode,
  type LaneRect,
} from './keyframe-node.ts';
import type { ThemeColors, TimelineViewport, TrackLayout } from './types.ts';

/** Properties a lane can show, in menu order. */
export const LANE_PROPERTIES: readonly KeyProperty[] = Object.freeze(['opacity', 'scale', 'offsetX', 'offsetY', 'rotation', 'volume']);

/** Short lane labels. */
export const LANE_LABELS: Readonly<Record<KeyProperty, string>> = Object.freeze({
  opacity: 'Opacidad',
  scale: 'Escala',
  offsetX: 'Posición X',
  offsetY: 'Posición Y',
  rotation: 'Rotación',
  volume: 'Volumen',
});

/**
 * The properties that make sense for a clip kind.
 * @param clip the clip.
 * @returns the lane choices.
 */
export function lanePropertiesFor(clip: DocumentClip): KeyProperty[] {
  if (clip.kind === 'audio') return ['volume'];
  if (clip.kind === 'video') return [...LANE_PROPERTIES];
  return LANE_PROPERTIES.filter((property) => property !== 'volume');
}

/**
 * The property a lane opens on: the first one that has keys.
 * @param clip the clip.
 * @returns the property.
 */
export function defaultLaneProperty(clip: DocumentClip): KeyProperty {
  const choices = lanePropertiesFor(clip);
  return choices.find((property) => clip.keys.some((key) => key.property === property)) ?? choices[0] ?? 'opacity';
}

/**
 * The next property in the lane's cycle.
 * @param clip the clip.
 * @param current the shown property.
 * @returns the following choice.
 */
export function nextLaneProperty(clip: DocumentClip, current: KeyProperty): KeyProperty {
  const choices = lanePropertiesFor(clip);
  const index = choices.indexOf(current);
  return choices[(index + 1) % choices.length] ?? current;
}

/** Selected keyframe (inspector ↔ timeline). */
export interface KeyframeRef {
  clipId: string;
  property: KeyProperty;
  keyframeId: string;
}

/** A minimal observable for the selected keyframe. */
export class KeyframeSelectionStore {
  private current: KeyframeRef | null = null;
  private readonly listeners = new Set<(ref: KeyframeRef | null) => void>();

  /** The selected keyframe, if any. */
  get(): KeyframeRef | null {
    return this.current;
  }

  /**
   * Selects (or clears) a keyframe.
   * @param ref the keyframe, or `null`.
   */
  set(ref: KeyframeRef | null): void {
    const same =
      ref === this.current ||
      (ref !== null && this.current !== null && ref.clipId === this.current.clipId && ref.property === this.current.property && ref.keyframeId === this.current.keyframeId);
    if (same) return;
    this.current = ref ? { ...ref } : null;
    for (const listener of this.listeners) listener(this.current);
  }

  /**
   * Subscribes to changes.
   * @param listener callback.
   * @returns unsubscribe.
   */
  subscribe(listener: (ref: KeyframeRef | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** The app-wide keyframe selection. */
export const keyframeSelection = new KeyframeSelectionStore();

/** Visual-only state of a keyframe gesture. */
export interface KeyframeGesturePreview {
  clipId: string;
  property: KeyProperty;
  keyframeId: string;
  /** Ghost position of a dragged node. */
  at?: number;
  value?: number;
  /** Ghost curve of a bent segment (applies to `keyframeId`'s approach). */
  curve?: CubicBezier;
  /** The time snapped to the playhead (draws a guide). */
  snapped?: boolean;
}

/** What the lane renderer needs. */
export interface KeyframeLaneState {
  expanded: ReadonlySet<string>;
  property(clip: DocumentClip): KeyProperty;
  selected: KeyframeRef | null;
  preview: KeyframeGesturePreview | null;
}

/**
 * The lane rectangle of a clip on its track.
 * @param clipX clip face x.
 * @param clipW clip face width.
 * @param layout the track layout (with its lane band).
 * @param viewport the view.
 * @returns the lane, in content-canvas pixels.
 */
export function laneRectFor(clipX: number, clipW: number, layout: TrackLayout, viewport: TimelineViewport): LaneRect {
  const lane = layout.keyframeLane ?? KEYFRAME_LANE_HEIGHT;
  return { x: clipX, y: layout.y - viewport.scrollTop + layout.height - lane, w: Math.max(1, clipW), h: lane - 2 };
}

/**
 * A clip with a gesture's ghost applied (the lane draws what will commit).
 * @param clip the document clip.
 * @param preview the running gesture.
 * @returns the clip to draw.
 */
export function withPreview(clip: DocumentClip, preview: KeyframeGesturePreview | null): DocumentClip {
  if (!preview || preview.clipId !== clip.id) return clip;
  const keys = clip.keys.map((key) => {
    const id = keyframeId(key.property, key.at);
    if (key.property !== preview.property || id !== preview.keyframeId) return key;
    return {
      ...key,
      at: preview.at ?? key.at,
      value: preview.value ?? key.value,
      ease: preview.curve ? new KeyEase(preview.curve) : key.ease,
    };
  });
  return { ...clip, keys };
}

/**
 * Samples the interpolated value across the lane with the engine's solver.
 * @param clip the clip.
 * @param property the property.
 * @param lane the lane.
 * @param step pixel step.
 * @returns `[x, y]` points.
 */
export function sampleLaneCurve(clip: DocumentClip, property: KeyProperty, lane: LaneRect, step = 2): [number, number][] {
  const keys = clip.keys
    .filter((key) => key.property === property)
    .map((key) => new Key(key.at, key.value, new Ease(key.ease.points[0] ?? 0, key.ease.points[1] ?? 0, key.ease.points[2] ?? 1, key.ease.points[3] ?? 1)));
  const track = new KeyTrack(keys);
  const rest = clipConstant(clip, property);
  const points: [number, number][] = [];
  const count = Math.max(1, Math.ceil(lane.w / step));
  for (let i = 0; i <= count; i += 1) {
    const x = lane.x + Math.min(lane.w, i * step);
    const value = track.valueAt((x - lane.x) / lane.w, rest);
    points.push([x, valueToLaneY(property, value, lane)]);
  }
  return points;
}

/** Everything {@link drawKeyframeLanes} needs. */
export interface DrawLanesContext {
  clips: readonly DocumentClip[];
  layouts: readonly TrackLayout[];
  viewport: TimelineViewport;
  colors: ThemeColors;
  width: number;
  height: number;
  state: KeyframeLaneState;
  /** Playhead x (snap guide). */
  playheadX: number;
}

/**
 * Paints every visible expanded lane.
 * @param ctx the content canvas.
 * @param context draw state.
 */
export function drawKeyframeLanes(ctx: CanvasRenderingContext2D, context: DrawLanesContext): void {
  const { viewport, colors, width, height, state } = context;
  const layoutById = new Map(context.layouts.map((layout) => [layout.trackId, layout]));
  for (const original of context.clips) {
    if (!state.expanded.has(original.id)) continue;
    const layout = layoutById.get(original.trackId);
    if (!layout?.keyframeLane) continue;
    const x = (original.start - viewport.scrollTime) * viewport.pixelsPerSecond;
    const w = original.duration * viewport.pixelsPerSecond;
    if (x > width || x + w < 0) continue;
    const lane = laneRectFor(x, w, layout, viewport);
    if (lane.y > height || lane.y + lane.h < 0) continue;
    const clip = withPreview(original, state.preview);
    const property = state.property(original);
    ctx.save();
    ctx.beginPath();
    ctx.rect(lane.x, lane.y, lane.w, lane.h);
    ctx.clip();
    ctx.fillStyle = colors.rulerBackground;
    ctx.fillRect(lane.x, lane.y, lane.w, lane.h);
    // Centre line (50 % of the property's range).
    ctx.strokeStyle = colors.gridLine;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(lane.x, Math.round(lane.y + lane.h / 2) + 0.5);
    ctx.lineTo(lane.x + lane.w, Math.round(lane.y + lane.h / 2) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);
    // Interpolation curve.
    const points = sampleLaneCurve(clip, property, lane);
    ctx.strokeStyle = colors.accent;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    points.forEach(([px, py], index) => (index === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py)));
    ctx.stroke();
    ctx.lineWidth = 1;
    // Nodes.
    for (const node of keyframeNodes(clip, property, lane)) {
      const selected =
        state.selected !== null &&
        state.selected.clipId === clip.id &&
        state.selected.property === property &&
        (state.selected.keyframeId === node.id || (state.preview?.keyframeId === state.selected.keyframeId && state.preview.at !== undefined && Math.abs(state.preview.at - node.at) < 1e-9));
      drawKeyframeNode(ctx, node.x, node.y, { fill: selected ? colors.accent : colors.text, stroke: colors.background, selected });
    }
    // Snap guide.
    if (state.preview?.clipId === clip.id && state.preview.snapped) {
      ctx.strokeStyle = colors.playhead;
      ctx.beginPath();
      ctx.moveTo(Math.round(context.playheadX) + 0.5, lane.y);
      ctx.lineTo(Math.round(context.playheadX) + 0.5, lane.y + lane.h);
      ctx.stroke();
    }
    // Property label (click cycles).
    ctx.font = '600 10px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    const label = `${LANE_LABELS[property]} ▸`;
    const labelW = ctx.measureText(label).width + 8;
    ctx.fillStyle = colors.background;
    ctx.globalAlpha = 0.8;
    ctx.fillRect(lane.x + 2, lane.y + 2, labelW, 14);
    ctx.globalAlpha = 1;
    ctx.fillStyle = colors.textDim;
    ctx.fillText(label, lane.x + 6, lane.y + 4);
    ctx.restore();
  }
}

/** The width of the clickable property label (matches the painted label). */
export const LANE_LABEL_HIT = { w: 92, h: 16 } as const;

/** A pointer hit inside an expanded lane. */
export interface LaneHit {
  clip: DocumentClip;
  property: KeyProperty;
  lane: LaneRect;
  node: KeyframeNode | null;
  segment: { from: KeyframeNode; to: KeyframeNode } | null;
  onLabel: boolean;
  /** The 0–100 % under the pointer. */
  percent: number;
  /** The clip fraction under the pointer. */
  at: number;
}

/**
 * Hit-tests the expanded lanes.
 * @param clips the timeline clips.
 * @param layouts track layouts.
 * @param viewport the view.
 * @param state lane state.
 * @param x content x.
 * @param y content y.
 * @returns what is under the pointer, or `null` outside every lane.
 */
export function hitKeyframeLane(
  clips: readonly DocumentClip[],
  layouts: readonly TrackLayout[],
  viewport: TimelineViewport,
  state: Pick<KeyframeLaneState, 'expanded' | 'property'>,
  x: number,
  y: number,
): LaneHit | null {
  const layoutById = new Map(layouts.map((layout) => [layout.trackId, layout]));
  for (const clip of clips) {
    if (!state.expanded.has(clip.id)) continue;
    const layout = layoutById.get(clip.trackId);
    if (!layout?.keyframeLane) continue;
    const clipX = (clip.start - viewport.scrollTime) * viewport.pixelsPerSecond;
    const lane = laneRectFor(clipX, clip.duration * viewport.pixelsPerSecond, layout, viewport);
    if (x < lane.x - 6 || x > lane.x + lane.w + 6 || y < lane.y || y > lane.y + lane.h) continue;
    const property = state.property(clip);
    const nodes = keyframeNodes(clip, property, lane);
    const node = hitKeyframe(nodes, x, y);
    const onLabel = !node && x >= lane.x + 2 && x <= lane.x + 2 + LANE_LABEL_HIT.w && y <= lane.y + 2 + LANE_LABEL_HIT.h;
    return {
      clip,
      property,
      lane,
      node,
      segment: node || onLabel ? null : segmentAt(nodes, x),
      onLabel,
      percent: laneYToPercent(y, lane),
      at: Math.min(1, Math.max(0, (x - lane.x) / lane.w)),
    };
  }
  return null;
}
