// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The theme manager: dark, light and cyberpunk palettes as CSS custom
 * properties on `:root`. Palette values live here (one source) and the
 * stylesheet only ever references the variables, so a theme change is one
 * attribute write plus a persisted setting.
 */

/** The themes the app ships. */
export type ThemeName = 'dark' | 'light' | 'cyberpunk';

/** The CSS variable set of a theme. */
export interface ThemePalette {
  name: ThemeName;
  label: string;
  colors: Record<string, string>;
}

/** Every palette, in menu order. */
export const THEMES: readonly ThemePalette[] = [
  {
    name: 'dark',
    label: 'Dark',
    colors: {
      '--bg': '#14161b',
      '--bg-panel': '#1c1f26',
      '--bg-elevated': '#242832',
      '--bg-input': '#2a2f3a',
      '--text': '#e8eaf0',
      '--text-muted': '#9aa3b2',
      '--border': '#333a47',
      '--accent': '#4f8cff',
      '--accent-strong': '#2f6fe0',
      '--accent-text': '#ffffff',
      '--danger': '#e5484d',
      '--success': '#46a758',
      '--warning': '#f5a623',
      '--track-video': '#2b3550',
      '--track-audio': '#23423a',
      '--clip-video': '#3d5a9e',
      '--clip-audio': '#2e7d63',
      '--clip-text': '#8d6ccf',
      '--clip-shape': '#c78a3d',
      '--clip-selected': '#6ea8ff',
      '--playhead': '#ff5c5c',
      '--shadow': 'rgba(0, 0, 0, 0.45)',
      // Fase 8: clip faces, filmstrip chrome and the HUD palette.
      '--clip-video-bg': '#2b4a7a',
      '--clip-video-border': '#4b72b8',
      '--clip-audio-bg': '#2d5a3d',
      '--clip-audio-border': '#4a8f68',
      '--clip-image-bg': '#5a3d7a',
      '--clip-image-border': '#8f6ec8',
      '--clip-selected-border': '#ffeb3b',
      '--timeline-ruler-bg': '#1c1c1c',
      '--playhead-line': '#ff3838',
      '--accent-export': '#c4f000',
      '--accent-play': '#4caf50',
      '--accent-snap-on': '#00ff00',
      '--panel-bg': '#232323',
      '--panel-bg-elevated': '#2a2a2a',
      '--panel-hover': '#333333',
      '--text-secondary': '#b0b0b0',
      '--text-muted-strong': '#777777',
    },
  },
  {
    name: 'light',
    label: 'Light',
    colors: {
      '--bg': '#f4f5f8',
      '--bg-panel': '#ffffff',
      '--bg-elevated': '#eef0f5',
      '--bg-input': '#ffffff',
      '--text': '#1d2330',
      '--text-muted': '#667085',
      '--border': '#d7dce6',
      '--accent': '#2f6fe0',
      '--accent-strong': '#245bbd',
      '--accent-text': '#ffffff',
      '--danger': '#d13438',
      '--success': '#2e8540',
      '--warning': '#b86e00',
      '--track-video': '#e4e9f5',
      '--track-audio': '#e0f0e9',
      '--clip-video': '#9db8ea',
      '--clip-audio': '#8fcbb4',
      '--clip-text': '#c3aee8',
      '--clip-shape': '#e8c28e',
      '--clip-selected': '#2f6fe0',
      '--playhead': '#d64545',
      '--shadow': 'rgba(30, 40, 60, 0.18)',
      // Fase 8: clip faces, filmstrip chrome and the HUD palette.
      '--clip-video-bg': '#b9cdec',
      '--clip-video-border': '#4b72b8',
      '--clip-audio-bg': '#b6dfc6',
      '--clip-audio-border': '#4a8f68',
      '--clip-image-bg': '#d6c6ec',
      '--clip-image-border': '#8f6ec8',
      '--clip-selected-border': '#b8860b',
      '--timeline-ruler-bg': '#eceef3',
      '--playhead-line': '#d64545',
      '--accent-export': '#2f6fe0',
      '--accent-play': '#2e8540',
      '--accent-snap-on': '#12805c',
      '--panel-bg': '#ffffff',
      '--panel-bg-elevated': '#eef0f5',
      '--panel-hover': '#e6e9f0',
      '--text-secondary': '#4a5568',
      '--text-muted-strong': '#75808f',
    },
  },
  {
    name: 'cyberpunk',
    label: 'Cyberpunk',
    colors: {
      '--bg': '#0a0410',
      '--bg-panel': '#140a24',
      '--bg-elevated': '#1d1033',
      '--bg-input': '#241542',
      '--text': '#f2e9ff',
      '--text-muted': '#a98fd0',
      '--border': '#3c2263',
      '--accent': '#00f0ff',
      '--accent-strong': '#00c4d6',
      '--accent-text': '#051018',
      '--danger': '#ff3d71',
      '--success': '#4dffb8',
      '--warning': '#ffd166',
      '--track-video': '#251245',
      '--track-audio': '#0f3d3d',
      '--clip-video': '#5b2ea6',
      '--clip-audio': '#12857a',
      '--clip-text': '#b14dff',
      '--clip-shape': '#c96a2e',
      '--clip-selected': '#00f0ff',
      '--playhead': '#ff2e88',
      '--shadow': 'rgba(255, 46, 136, 0.25)',
      // Fase 8: clip faces, filmstrip chrome and the HUD palette.
      '--clip-video-bg': '#33207a',
      '--clip-video-border': '#7a5cff',
      '--clip-audio-bg': '#0f4a45',
      '--clip-audio-border': '#00f0ff',
      '--clip-image-bg': '#4a1070',
      '--clip-image-border': '#b14dff',
      '--clip-selected-border': '#00f0ff',
      '--timeline-ruler-bg': '#0a0410',
      '--playhead-line': '#ff2e88',
      '--accent-export': '#00f0ff',
      '--accent-play': '#4dffb8',
      '--accent-snap-on': '#c4f000',
      '--panel-bg': '#140a24',
      '--panel-bg-elevated': '#1d1033',
      '--panel-hover': '#241542',
      '--text-secondary': '#c9b6e8',
      '--text-muted-strong': '#9179bd',
    },
  },
];

/** Theme switching over the document element. */
export class ThemeManager {
  private current: ThemeName = 'dark';
  private readonly root: HTMLElement;

  /**
   * @param root the element the CSS variables land on (`document.documentElement`).
   */
  constructor(root: HTMLElement) {
    this.root = root;
  }

  /** The active theme. */
  get theme(): ThemeName {
    return this.current;
  }

  /**
   * Applies a theme and remembers it through the settings hook.
   * @param name the theme to apply.
   * @param onChange optional persistence hook.
   */
  apply(name: ThemeName, onChange?: (theme: ThemeName) => void): void {
    const palette = THEMES.find((theme) => theme.name === name) ?? THEMES[0]!;
    this.current = palette.name;
    for (const [variable, value] of Object.entries(palette.colors)) {
      this.root.style.setProperty(variable, value);
    }
    this.root.dataset['theme'] = palette.name;
    onChange?.(palette.name);
  }

  /** The palette currently applied. */
  get palette(): ThemePalette {
    return THEMES.find((theme) => theme.name === this.current) ?? THEMES[0]!;
  }
}
