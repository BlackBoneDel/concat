// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Placement mathematics for the compositor.
 *
 * The drawing semantics mirror `concat-core/src/timeline.rs`'s `Transform`:
 * `scale` is a multiplier over the aspect-fitted picture, the offsets are
 * fractions of the output frame, `stretch_*` pull the picture off its aspect,
 * and rotation is clockwise about the picture's centre — so one transform
 * means one picture at any output resolution.
 */

import { Transform } from '../core/timeline.ts';
import { wrapRotation } from '../model/wire.ts';
import type { Point, RenderContext2D } from './types.ts';

/** A 2D affine matrix in canvas order: `[a, b, c, d, e, f]`. */
export type Mat2D = [number, number, number, number, number, number];

/** The rectangle an aspect-fitted picture takes in the output frame. */
export interface FittedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The aspect-fit of a `sourceW × sourceH` picture into a `frameW × frameH`
 * frame, centred.
 * @param sourceWidth intrinsic width of the picture.
 * @param sourceHeight intrinsic height of the picture.
 * @param frameWidth output frame width.
 * @param frameHeight output frame height.
 * @returns the fitted rectangle in frame pixels.
 */
export function fitRect(
  sourceWidth: number,
  sourceHeight: number,
  frameWidth: number,
  frameHeight: number,
): FittedRect {
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    return { x: 0, y: 0, w: frameWidth, h: frameHeight };
  }
  const scale = Math.min(frameWidth / sourceWidth, frameHeight / sourceHeight);
  const w = sourceWidth * scale;
  const h = sourceHeight * scale;
  return { x: (frameWidth - w) / 2, y: (frameHeight - h) / 2, w, h };
}

/**
 * The exact affine of a model transform over a fitted picture.
 * @param transform the clip's placement.
 * @param frameWidth output frame width.
 * @param frameHeight output frame height.
 * @param sourceWidth intrinsic width of the picture.
 * @param sourceHeight intrinsic height of the picture.
 * @returns the matrix mapping picture pixels to frame pixels.
 */
export function transformMatrix(
  transform: Transform,
  frameWidth: number,
  frameHeight: number,
  sourceWidth: number,
  sourceHeight: number,
): Mat2D {
  const fitted = fitRect(sourceWidth, sourceHeight, frameWidth, frameHeight);
  const angle = (wrapRotation(transform.rotation) * Math.PI) / 180;
  const sx = transform.scale * transform.stretch_x;
  const sy = transform.scale * transform.stretch_y;

  // translate(centre + offset) · rotate · scale · translate(-centre)
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const tx = frameWidth / 2 + transform.offset_x * frameWidth;
  const ty = frameHeight / 2 + transform.offset_y * frameHeight;
  // Point p is first centred on the fitted rect, scaled/rotated, re-centred.
  const a = cos * sx;
  const b = sin * sx;
  const c = -sin * sy;
  const d = cos * sy;
  const e = tx - (a * (fitted.x + fitted.w / 2) + c * (fitted.y + fitted.h / 2));
  const f = ty - (b * (fitted.x + fitted.w / 2) + d * (fitted.y + fitted.h / 2));
  return [a, b, c, d, e, f];
}

/**
 * Sets the context transform so drawing the fitted picture places it per the
 * model transform. After this call draw the source into `fitRect(...)` of the
 * frame — or use {@link drawFitted}, which does both.
 * @param ctx the drawing surface.
 * @param transform the clip's placement.
 * @param sourceWidth intrinsic width of the picture.
 * @param sourceHeight intrinsic height of the picture.
 * @param frameWidth output frame width.
 * @param frameHeight output frame height.
 */
export function applyTransform(
  ctx: RenderContext2D,
  transform: Transform,
  sourceWidth: number,
  sourceHeight: number,
  frameWidth: number,
  frameHeight: number,
): void {
  const [a, b, c, d, e, f] = transformMatrix(
    transform,
    frameWidth,
    frameHeight,
    sourceWidth,
    sourceHeight,
  );
  ctx.save();
  ctx.setTransform(a, b, c, d, e, f);
}

/**
 * The product of two affines: applying `outer ∘ inner` is applying `inner`
 * first. Composes nested placements.
 * @param outer the matrix applied second.
 * @param inner the matrix applied first.
 * @returns their product.
 */
export function composeMatrices(outer: Mat2D, inner: Mat2D): Mat2D {
  const [a1, b1, c1, d1, e1, f1] = outer;
  const [a2, b2, c2, d2, e2, f2] = inner;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

/**
 * Inverts an affine matrix, or returns `null` when it is degenerate.
 * @param m the matrix to invert.
 * @returns the inverse matrix.
 */
export function invertMatrix(m: Mat2D): Mat2D | null {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (det === 0 || !Number.isFinite(det)) return null;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/**
 * Maps a frame-space point through an affine.
 * @param m the matrix.
 * @param x frame x.
 * @param y frame y.
 * @returns the transformed point.
 */
export function applyPoint(m: Mat2D, x: number, y: number): Point {
  const [a, b, c, d, e, f] = m;
  return { x: a * x + c * y + e, y: b * x + d * y + f };
}

/**
 * The inverse placement as a model `Transform` — for hit-testing in Fase 3.
 * Exact whenever `stretch_x === stretch_y` (the ordinary case); with a
 * non-uniform stretch the inverse is not in the transform family and this
 * returns the uniform approximation — use {@link inverseTransformPoint} for
 * an exact point mapping there.
 * @param transform the placement to invert.
 * @returns the inverted placement.
 */
export function inverseTransform(transform: Transform): Transform {
  const s = transform.scale;
  const angle = wrapRotation(transform.rotation);
  const rad = (angle * Math.PI) / 180;
  // For M = T·R·S (uniform s): M⁻¹ = T(-R(-θ)·o / s) · R(-θ) · S(1/s).
  const ox = transform.offset_x;
  const oy = transform.offset_y;
  const cos = Math.cos(-rad);
  const sin = Math.sin(-rad);
  const invX = -(cos * ox - sin * oy) / s;
  const invY = -(sin * ox + cos * oy) / s;
  return new Transform(1 / s, invX, invY, -angle, 1, 1);
}

/**
 * Maps a frame-space point into the source picture's pixel space — the exact
 * hit-test primitive for Fase 3's canvas overlays.
 * @param transform the clip's placement.
 * @param frameWidth output frame width.
 * @param frameHeight output frame height.
 * @param sourceWidth intrinsic width of the picture.
 * @param sourceHeight intrinsic height of the picture.
 * @param x frame x.
 * @param y frame y.
 * @returns the point in picture pixels, or `null` for a degenerate transform.
 */
export function inverseTransformPoint(
  transform: Transform,
  frameWidth: number,
  frameHeight: number,
  sourceWidth: number,
  sourceHeight: number,
  x: number,
  y: number,
): Point | null {
  const inverse = invertMatrix(
    transformMatrix(transform, frameWidth, frameHeight, sourceWidth, sourceHeight),
  );
  return inverse ? applyPoint(inverse, x, y) : null;
}
