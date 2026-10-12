// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Fase 5 presets: built-in motion/title looks and the user's own. */
export {
  ApplyPresetOperation,
  BUILTIN_PRESETS,
  PRESETS_DB_NAME,
  PRESETS_DB_VERSION,
  PresetManager,
  RestoreClipLookOperation,
  USER_PRESETS_STORE,
  hasContent,
  presetIncompatibility,
  presetKeyAt,
  presetKeyValue,
  type PresetSession,
} from './preset-manager.ts';
export { BOUNCE, FADE_IN, MOTION_PRESETS, SLIDE_LEFT, SLIDE_RIGHT, ZOOM_IN, ZOOM_IN_BLUR } from './motion-presets.ts';
export { CINEMATIC_TITLE, NEON_GLOW, TEXT_PRESETS, TYPEWRITER } from './text-presets.ts';
export {
  PRESET_TYPES,
  parsePresetData,
  parseUserPreset,
  type PresetColor,
  type PresetData,
  type PresetEffect,
  type PresetKey,
  type PresetType,
  type UserPreset,
} from './preset-types.ts';
