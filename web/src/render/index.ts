// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** The render module: compositor, transforms, blends and text. */
export { renderFrame, type RenderOptions } from './compositor.ts';
export {
  applyPoint,
  applyTransform,
  composeMatrices,
  fitRect,
  inverseTransform,
  inverseTransformPoint,
  invertMatrix,
  transformMatrix,
  type FittedRect,
  type Mat2D,
} from './transform.ts';
export {
  BLEND_MODES,
  BLEND_TO_OPERATION,
  applyBlend,
  resetBlend,
  type CanvasBlend,
} from './blend.ts';
export { renderTextClip } from './text-renderer.ts';
export {
  VisionPipeline,
  getVisionHook,
  setVisionHook,
  type VisionHook,
  type VisionPipelineOptions,
} from './vision-pipeline.ts';
export type {
  FramePool,
  Point,
  RenderContext2D,
  RenderImage,
  RenderTarget,
} from './types.ts';
