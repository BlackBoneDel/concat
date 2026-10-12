// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Built-in title presets: advanced styles (`extra.advanced_text`) plus, for
 * the cinematic title, a short opacity fade so it arrives instead of popping.
 */

import { BEZIER_PRESETS } from '../editor/keyframe-operations.ts';
import type { UserPreset } from './preset-types.ts';

/** Typewriter: reveals the text over 2 s with a blinking caret. */
export const TYPEWRITER: UserPreset = {
  id: 'builtin:typewriter',
  name: 'Typewriter',
  type: 'text',
  builtin: true,
  createdAt: 0,
  data: {
    text: {
      base: { fontFamily: '"Courier New", ui-monospace, monospace', fontWeight: 600, align: 'left' },
      advanced: { typewriter: { enabled: true, duration: 2, cursor: true }, fill: '#ffffff' },
    },
  },
};

/** Cinematic Title: tracked caps in a gold gradient, soft shadow, slow fade. */
export const CINEMATIC_TITLE: UserPreset = {
  id: 'builtin:cinematic-title',
  name: 'Cinematic Title',
  type: 'text',
  builtin: true,
  createdAt: 0,
  data: {
    text: {
      base: { fontFamily: 'Georgia, "Times New Roman", serif', fontWeight: 400, tracking: 0.012, fontSize: 0.08, align: 'center' },
      advanced: {
        fill: ['#f7e7b4', '#c9a24a', '#8a6a22'],
        gradientAngle: 90,
        shadow: { enabled: true, color: 'rgba(0,0,0,0.7)', blur: 0.02, offsetX: 0, offsetY: 0.006 },
        stroke: { enabled: false },
        glow: { enabled: false },
      },
    },
    keys: [
      { property: 'opacity', seconds: 0, value: 0, ease: BEZIER_PRESETS.linear },
      { property: 'opacity', seconds: 1.2, value: 1, ease: BEZIER_PRESETS.easeInOut },
    ],
  },
};

/** Neon Glow: white core, cyan glow and a thin cyan outline. */
export const NEON_GLOW: UserPreset = {
  id: 'builtin:neon-glow',
  name: 'Neon Glow',
  type: 'text',
  builtin: true,
  createdAt: 0,
  data: {
    text: {
      base: { fontWeight: 700 },
      advanced: {
        fill: '#ffffff',
        glow: { enabled: true, color: '#00e5ff', blur: 0.035 },
        stroke: { enabled: true, color: '#00b8d4', width: 0.002 },
        shadow: { enabled: false },
      },
    },
  },
};

/** Every built-in title preset, in menu order. */
export const TEXT_PRESETS: readonly UserPreset[] = Object.freeze([TYPEWRITER, CINEMATIC_TITLE, NEON_GLOW]);
