// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Built-in motion presets: keyframe sets over the clip's own keyable
 * properties (`model.rs` `KeyProperty`), eased with the Bézier presets of the
 * curve editor. Times are seconds from the clip's start (or end), resolved to
 * fractions when applied, so a fade lasts 0.5 s whatever the clip's length.
 */

import { BEZIER_PRESETS } from '../editor/keyframe-operations.ts';
import type { UserPreset } from './preset-types.ts';

/** Fade In: opacity 0 → 1 over the first 0.5 s. */
export const FADE_IN: UserPreset = {
  id: 'builtin:fade-in',
  name: 'Fade In',
  type: 'video',
  builtin: true,
  createdAt: 0,
  data: {
    keys: [
      { property: 'opacity', seconds: 0, value: 0, ease: BEZIER_PRESETS.linear },
      { property: 'opacity', seconds: 0.5, value: 1, ease: BEZIER_PRESETS.easeOut },
    ],
  },
};

/** Zoom In: a slow push from 100 % to 125 % over the whole clip. */
export const ZOOM_IN: UserPreset = {
  id: 'builtin:zoom-in',
  name: 'Zoom In',
  type: 'video',
  builtin: true,
  createdAt: 0,
  data: {
    keys: [
      { property: 'scale', at: 0, value: 1, ease: BEZIER_PRESETS.linear },
      { property: 'scale', at: 1, value: 1.25, ease: BEZIER_PRESETS.easeInOut },
    ],
  },
};

/** Zoom In + Blur: the push with a soft focus that clears. */
export const ZOOM_IN_BLUR: UserPreset = {
  id: 'builtin:zoom-in-blur',
  name: 'Zoom In + Desenfoque',
  type: 'video',
  builtin: true,
  createdAt: 0,
  data: {
    keys: ZOOM_IN.data.keys,
    videoEffects: [{ type: 'blur', params: { radius: 4 } }],
  },
};

/** Slide Left: enters from the right edge, moving left, in 0.6 s. */
export const SLIDE_LEFT: UserPreset = {
  id: 'builtin:slide-left',
  name: 'Slide Left',
  type: 'video',
  builtin: true,
  createdAt: 0,
  data: {
    keys: [
      { property: 'offsetX', seconds: 0, value: 1, ease: BEZIER_PRESETS.linear },
      { property: 'offsetX', seconds: 0.6, value: 0, ease: BEZIER_PRESETS.easeOut },
    ],
  },
};

/** Slide Right: enters from the left edge, moving right, in 0.6 s. */
export const SLIDE_RIGHT: UserPreset = {
  id: 'builtin:slide-right',
  name: 'Slide Right',
  type: 'video',
  builtin: true,
  createdAt: 0,
  data: {
    keys: [
      { property: 'offsetX', seconds: 0, value: -1, ease: BEZIER_PRESETS.linear },
      { property: 'offsetX', seconds: 0.6, value: 0, ease: BEZIER_PRESETS.easeOut },
    ],
  },
};

/** Bounce: pops in with an overshoot and settles. */
export const BOUNCE: UserPreset = {
  id: 'builtin:bounce',
  name: 'Bounce',
  type: 'video',
  builtin: true,
  createdAt: 0,
  data: {
    keys: [
      { property: 'scale', seconds: 0, value: 0.6, ease: BEZIER_PRESETS.linear },
      { property: 'scale', seconds: 0.25, value: 1.12, ease: BEZIER_PRESETS.easeOut },
      { property: 'scale', seconds: 0.4, value: 0.95, ease: BEZIER_PRESETS.easeInOut },
      { property: 'scale', seconds: 0.55, value: 1, ease: BEZIER_PRESETS.easeInOut },
    ],
  },
};

/** Every built-in motion preset, in menu order. */
export const MOTION_PRESETS: readonly UserPreset[] = Object.freeze([FADE_IN, ZOOM_IN, ZOOM_IN_BLUR, SLIDE_LEFT, SLIDE_RIGHT, BOUNCE]);
