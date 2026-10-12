// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Settings persistence: merge, clamps, reset. */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  resetSettings,
  saveSettings,
  type SettingsStorage,
} from '../src/storage/settings-store.ts';

function memoryStorage(): SettingsStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

describe('settings store', () => {
  it('returns the defaults when nothing is stored', () => {
    const settings = loadSettings(memoryStorage());
    expect(settings).toEqual(DEFAULT_SETTINGS);
  });

  it('round-trips through save/load', () => {
    const storage = memoryStorage();
    const modified = {
      ...DEFAULT_SETTINGS,
      theme: 'cyberpunk' as const,
      volume: 0.3,
      panelSizes: { media: 320, inspector: 220, timeline: 400 },
    };
    saveSettings(modified, storage);
    const loaded = loadSettings(storage);
    expect(loaded.theme).toBe('cyberpunk');
    expect(loaded.volume).toBeCloseTo(0.3, 6);
    expect(loaded.panelSizes.media).toBe(320);
    expect(loaded.panelSizes.timeline).toBe(400);
  });

  it('clamps out-of-range numbers and rejects unknown values', () => {
    const storage = memoryStorage();
    storage.setItem(
      'concat-settings',
      JSON.stringify({
        theme: 'neon', // not a theme
        volume: 5, // out of 0..1
        autosaveInterval: 1, // below 5
        gridSize: 2000, // above 256
        snapToGrid: 'yes', // not a boolean
        panelSizes: { media: 9999, inspector: 'wide' },
      }),
    );
    const loaded = loadSettings(storage);
    expect(loaded.theme).toBe(DEFAULT_SETTINGS.theme);
    expect(loaded.volume).toBe(1);
    expect(loaded.autosaveInterval).toBe(5);
    expect(loaded.gridSize).toBe(256);
    expect(loaded.snapToGrid).toBe(DEFAULT_SETTINGS.snapToGrid);
    expect(loaded.panelSizes.media).toBe(600);
    expect(loaded.panelSizes.inspector).toBe(DEFAULT_SETTINGS.panelSizes.inspector);
  });

  it('survives corrupt JSON', () => {
    const storage = memoryStorage();
    storage.setItem('concat-settings', '{not json');
    expect(loadSettings(storage)).toEqual(DEFAULT_SETTINGS);
  });

  it('reset restores the defaults', () => {
    const storage = memoryStorage();
    saveSettings({ ...DEFAULT_SETTINGS, theme: 'light' }, storage);
    const restored = resetSettings(storage);
    expect(restored).toEqual(DEFAULT_SETTINGS);
    expect(storage.getItem('concat-settings')).toBeNull();
    expect(loadSettings(storage)).toEqual(DEFAULT_SETTINGS);
  });
});
