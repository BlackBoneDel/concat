// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * User settings in `localStorage` — small, synchronous, and restored in one
 * `loadSettings` pass at boot. The spec's `UserSettings` plus the few knobs
 * the shell keeps (panel sizes, volume) — everything the settings modal
 * edits.
 */

/** Everything the settings modal can change. */
export interface UserSettings {
  theme: 'dark' | 'light' | 'cyberpunk';
  language: 'en' | 'es';
  previewQuality: 'full' | 'half' | 'quarter';
  autosaveInterval: number;
  hardwareAcceleration: boolean;
  showTooltips: boolean;
  snapToGrid: boolean;
  gridSize: number;
  defaultClipDuration: number;
  defaultTransitionDuration: number;
  defaultEasing: string;
  volume: number;
  /** Panel sizes, in pixels. */
  panelSizes: {
    media: number;
    inspector: number;
    timeline: number;
  };
}

/** The factory defaults. */
export const DEFAULT_SETTINGS: Readonly<UserSettings> = Object.freeze({
  theme: 'dark',
  language: 'en',
  previewQuality: 'half',
  autosaveInterval: 30,
  hardwareAcceleration: true,
  showTooltips: true,
  snapToGrid: true,
  gridSize: 8,
  defaultClipDuration: 4,
  defaultTransitionDuration: 0.6,
  defaultEasing: 'inOutCubic',
  volume: 0.8,
  panelSizes: { media: 250, inspector: 280, timeline: 250 },
});

const STORAGE_KEY = 'concat-settings';

/** The storage backing settings (the DOM one, or memory in tests). */
export interface SettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Reads the settings, merging saved values over the defaults. */
export function loadSettings(storage: SettingsStorage = defaultStorage()): UserSettings {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS, panelSizes: { ...DEFAULT_SETTINGS.panelSizes } };
    const parsed: unknown = JSON.parse(raw);
    return mergeSettings(parsed);
  } catch {
    return { ...DEFAULT_SETTINGS, panelSizes: { ...DEFAULT_SETTINGS.panelSizes } };
  }
}

/**
 * Saves the settings as JSON.
 * @param settings the current settings.
 * @param storage where to write.
 */
export function saveSettings(
  settings: UserSettings,
  storage: SettingsStorage = defaultStorage(),
): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

/**
 * Restores the factory defaults.
 * @param storage where to clear.
 * @returns the defaults, ready to apply.
 */
export function resetSettings(storage: SettingsStorage = defaultStorage()): UserSettings {
  storage.removeItem(STORAGE_KEY);
  return { ...DEFAULT_SETTINGS, panelSizes: { ...DEFAULT_SETTINGS.panelSizes } };
}

/** Merges unknown stored data over the defaults, field by field. */
function mergeSettings(parsed: unknown): UserSettings {
  const defaults = { ...DEFAULT_SETTINGS, panelSizes: { ...DEFAULT_SETTINGS.panelSizes } };
  if (typeof parsed !== 'object' || parsed === null) return defaults;
  const record = parsed as Record<string, unknown>;
  const merged: UserSettings = {
    theme: pick(record['theme'], ['dark', 'light', 'cyberpunk'], defaults.theme),
    language: pick(record['language'], ['en', 'es'], defaults.language),
    previewQuality: pick(record['previewQuality'], ['full', 'half', 'quarter'], defaults.previewQuality),
    autosaveInterval: clampNumber(record['autosaveInterval'], 5, 600, defaults.autosaveInterval),
    hardwareAcceleration: pickBoolean(record['hardwareAcceleration'], defaults.hardwareAcceleration),
    showTooltips: pickBoolean(record['showTooltips'], defaults.showTooltips),
    snapToGrid: pickBoolean(record['snapToGrid'], defaults.snapToGrid),
    gridSize: clampNumber(record['gridSize'], 1, 256, defaults.gridSize),
    defaultClipDuration: clampNumber(record['defaultClipDuration'], 0.1, 3600, defaults.defaultClipDuration),
    defaultTransitionDuration: clampNumber(
      record['defaultTransitionDuration'],
      0,
      60,
      defaults.defaultTransitionDuration,
    ),
    defaultEasing:
      typeof record['defaultEasing'] === 'string' && record['defaultEasing'] !== ''
        ? record['defaultEasing']
        : defaults.defaultEasing,
    volume: clampNumber(record['volume'], 0, 1, defaults.volume),
    panelSizes: { ...defaults.panelSizes },
  };
  const sizes = record['panelSizes'];
  if (typeof sizes === 'object' && sizes !== null) {
    const sizeRecord = sizes as Record<string, unknown>;
    merged.panelSizes = {
      media: clampNumber(sizeRecord['media'], 150, 600, defaults.panelSizes.media),
      inspector: clampNumber(sizeRecord['inspector'], 180, 600, defaults.panelSizes.inspector),
      timeline: clampNumber(sizeRecord['timeline'], 120, 800, defaults.panelSizes.timeline),
    };
  }
  return merged;
}

/** A value that must be one of `options`. */
function pick<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return typeof value === 'string' && (options as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** A boolean, defaulting when the stored value is not one. */
function pickBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** A finite number clamped to `[min, max]`. */
function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

/** The browser storage, or an in-memory stand-in in tests. */
function defaultStorage(): SettingsStorage {
  if (typeof localStorage !== 'undefined') return localStorage;
  const memory = new Map<string, string>();
  return {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => void memory.set(key, value),
    removeItem: (key) => void memory.delete(key),
  };
}
