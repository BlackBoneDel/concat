// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Blend modes — the canvas spelling of the engine's `Blend`
 * (`concat-core/src/timeline.rs`).
 *
 * The engine's six modes are the document's whole vocabulary; the canvas
 * extras are here for the day the effect catalogue reaches for them. The
 * maths the Rust doc quotes (premultiplied source `s`, ground `d`) is what
 * the canvas `globalCompositeOperation` values already do.
 */

import type { Blend } from '../core/timeline.ts';
import type { RenderContext2D } from './types.ts';

/** Every composite operation the canvas offers. */
export type CanvasBlend = GlobalCompositeOperation;

/** The engine's six modes, in menu order. */
export const BLEND_MODES: readonly Blend[] = [
  'normal',
  'multiply',
  'screen',
  'add',
  'lighten',
  'darken',
];

/**
 * The canvas composite operation for an engine blend mode.
 * Port of `Blend::name` → `GlobalCompositeOperation`.
 */
export const BLEND_TO_OPERATION: Readonly<Record<Blend, CanvasBlend>> = {
  // Source over: the layer covers what is beneath by its alpha.
  normal: 'source-over',
  // Darkens: the ground times the layer.
  multiply: 'multiply',
  // Lightens: the inverse of multiplying the inverses.
  screen: 'screen',
  // The sum, clipped: canvas spells it `lighter`.
  add: 'lighter',
  // The brighter of the two, per channel.
  lighten: 'lighten',
  // The darker of the two, per channel.
  darken: 'darken',
};

/**
 * Sets the composite operation and alpha a layer draws with.
 * @param ctx the drawing surface.
 * @param blend how the layer meets what is beneath it.
 * @param opacity blend strength in `0..1`; values outside are clamped.
 */
export function applyBlend(ctx: RenderContext2D, blend: Blend, opacity: number): void {
  ctx.globalCompositeOperation = BLEND_TO_OPERATION[blend] ?? 'source-over';
  ctx.globalAlpha = Math.min(1, Math.max(0, opacity));
}

/**
 * Restores the ordinary drawing state: source-over at full alpha.
 * @param ctx the drawing surface.
 */
export function resetBlend(ctx: RenderContext2D): void {
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
}
