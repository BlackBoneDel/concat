// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Keyframe nodes (◆) of the timeline's keyframe lane: geometry (value ↔ lane
 * y, clip fraction ↔ x), hit-testing and painting. Pure Canvas 2D — no DOM
 * per key — so expanded lanes cost nothing when scrolled away.
 */

import { clampBezier, valueToPercent, type CubicBezier } from '../../editor/keyframe-operations.ts';
import { keyframeId } from '../../editor/operations.ts';
import type { DocumentClip } from '../../model/document.ts';
import type { KeyProperty } from '../../model/wire.ts';

/** Height of the keyframe sub-lane under an expanded clip (px). */
export const KEYFRAME_LANE_HEIGHT = 64;
/** Vertical padding inside the lane so 0 %/100 % nodes stay clickable. */
export const LANE_PADDING = 9;
/** Half-diagonal of a node diamond (px). */
export const NODE_RADIUS = 5;

/** The lane rectangle of one clip, in content-canvas pixels. */
export interface LaneRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One drawable keyframe. */
export interface KeyframeNode {
  /** Stable id ({@link keyframeId}). */
  id: string;
  property: KeyProperty;
  /** Clip fraction `0..1`. */
  at: number;
  /** Absolute value. */
  value: number;
  /** Curve approaching this key. */
  ease: CubicBezier;
  x: number;
  y: number;
}

/**
 * Lane y of a value (100 % at the top).
 * @param property the keyed property (its range sets the scale).
 * @param value an absolute value.
 * @param lane the lane.
 * @returns pixels.
 */
export function valueToLaneY(property: KeyProperty, value: number, lane: LaneRect): number {
  const usable = Math.max(1, lane.h - LANE_PADDING * 2);
  return lane.y + LANE_PADDING + usable * (1 - valueToPercent(property, value) / 100);
}

/**
 * Lane y → 0–100 %.
 * @param y pixels.
 * @param lane the lane.
 * @returns the percentage, clamped.
 */
export function laneYToPercent(y: number, lane: LaneRect): number {
  const usable = Math.max(1, lane.h - LANE_PADDING * 2);
  return Math.min(100, Math.max(0, (1 - (y - lane.y - LANE_PADDING) / usable) * 100));
}

/**
 * Lane x of a clip fraction.
 * @param at fraction `0..1`.
 * @param lane the lane.
 * @returns pixels.
 */
export function atToLaneX(at: number, lane: LaneRect): number {
  return lane.x + at * lane.w;
}

/**
 * The nodes of one property of a clip, sorted by time.
 * @param clip the clip.
 * @param property the lane's property.
 * @param lane the lane.
 * @returns the nodes.
 */
export function keyframeNodes(clip: DocumentClip, property: KeyProperty, lane: LaneRect): KeyframeNode[] {
  return clip.keys
    .filter((key) => key.property === property)
    .sort((a, b) => a.at - b.at)
    .map((key) => ({
      id: keyframeId(property, key.at),
      property,
      at: key.at,
      value: key.value,
      ease: clampBezier(key.ease.points),
      x: atToLaneX(key.at, lane),
      y: valueToLaneY(property, key.value, lane),
    }));
}

/**
 * The node under a point (closest within `radius`).
 * @param nodes candidate nodes.
 * @param x pointer x.
 * @param y pointer y.
 * @param radius hit radius in px.
 * @returns the node, or `null`.
 */
export function hitKeyframe(nodes: readonly KeyframeNode[], x: number, y: number, radius = NODE_RADIUS + 3): KeyframeNode | null {
  let best: KeyframeNode | null = null;
  let bestDistance = Infinity;
  for (const node of nodes) {
    // Diamond hit area: |dx| + |dy| ≤ r (Manhattan distance).
    const distance = Math.abs(node.x - x) + Math.abs(node.y - y);
    if (distance <= radius * 1.4 && distance < bestDistance) {
      best = node;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * The segment (pair of neighbouring nodes) whose span contains x.
 * @param nodes sorted nodes.
 * @param x pointer x.
 * @returns the two nodes, or `null` outside every segment.
 */
export function segmentAt(nodes: readonly KeyframeNode[], x: number): { from: KeyframeNode; to: KeyframeNode } | null {
  for (let i = 0; i + 1 < nodes.length; i += 1) {
    const from = nodes[i]!;
    const to = nodes[i + 1]!;
    if (x > from.x + NODE_RADIUS && x < to.x - NODE_RADIUS) return { from, to };
  }
  return null;
}

/** Paint options of one node. */
export interface NodePaint {
  fill: string;
  stroke: string;
  selected: boolean;
}

/**
 * Paints a ◆.
 * @param ctx the canvas.
 * @param x centre x.
 * @param y centre y.
 * @param paint colours and state.
 */
export function drawKeyframeNode(ctx: CanvasRenderingContext2D, x: number, y: number, paint: NodePaint): void {
  const r = paint.selected ? NODE_RADIUS + 1.5 : NODE_RADIUS;
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r, y);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r, y);
  ctx.closePath();
  ctx.fillStyle = paint.fill;
  ctx.fill();
  ctx.lineWidth = paint.selected ? 2 : 1;
  ctx.strokeStyle = paint.stroke;
  ctx.stroke();
  ctx.lineWidth = 1;
}
