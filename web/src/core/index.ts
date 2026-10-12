// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The engine model — the web port of the `concat-core` crate. Everything the
 * edit *is* lives here; everything the edit *looks like* is a later phase.
 */

export { Rational } from './rational.ts';
export { FrameRate, TimeRange } from './time.ts';
export { Arena, Id } from './arena.ts';
export { Animation, Ease, Key, KeyTrack, bezierYAtX, type BaseTransform } from './animate.ts';
export { SpeedCurve } from './retime.ts';
export {
  Blend,
  Clip,
  MediaRef,
  Project,
  Timeline,
  Track,
  TrackKind,
  Transform,
  type ClipId,
  type TrackId,
} from './timeline.ts';
