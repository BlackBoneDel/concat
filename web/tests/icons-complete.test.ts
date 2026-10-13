// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

// @vitest-environment jsdom
/**
 * Fase 8 · zona 3 — the HUD's SVG icon set. The CapCut-style shell needs the
 * pointer, the hand, the text tool, the film strip, the effect sparkles, the
 * filter sliders, the layers, the template grid, the folder and the panel
 * toggle; every one of them must obey the same invariants as the Fase 7 set
 * (24×24 grid, 2 px round stroke in `currentColor`, no emoji, no text glyphs)
 * so the bar looks the same in the three themes.
 */

import { describe, expect, it } from 'vitest';
import {
  createIconElement,
  icon,
  iconButton,
  iconMarkup,
  iconSlug,
  ICON_NAMES,
  type IconName,
} from '../src/ui/components/icons.ts';

/** Every glyph the Fase 8 HUD relies on. */
const HUD_ICONS: readonly IconName[] = [
  // tools and transport
  'play',
  'pause',
  'select',
  'hand',
  'split',
  'magnet',
  'text',
  'cursor',
  'trash',
  'plus',
  'undo',
  'redo',
  'zoomIn',
  'zoomOut',
  'fit',
  'volumeMute',
  // library and panels
  'film',
  'music',
  'layers',
  'sparkles',
  'sliders',
  'layoutGrid',
  'folder',
  'panelLeft',
  'settings',
  'export',
];

describe('Fase 8 · el set de iconos del HUD', () => {
  it('incluye todos los glifos del HUD', () => {
    for (const name of HUD_ICONS) expect(ICON_NAMES).toContain(name);
  });

  it('cada glifo cumple las invariantes de la retícula (24×24, trazo redondo)', () => {
    for (const name of ICON_NAMES) {
      const svg = icon(name, { size: 16 });
      expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
      expect(svg.getAttribute('fill')).toBe('none');
      expect(svg.getAttribute('stroke')).toBe('currentColor');
      expect(svg.getAttribute('stroke-width')).toBe('2');
      expect(svg.getAttribute('stroke-linecap')).toBe('round');
      expect(svg.getAttribute('stroke-linejoin')).toBe('round');
      expect(svg.getAttribute('focusable')).toBe('false');
      expect(svg.getAttribute('aria-hidden')).toBe('true');
      expect(svg.childElementCount).toBeGreaterThan(0);
      expect(svg.classList.contains('concat-icon')).toBe(true);
      expect(svg.classList.contains(`concat-icon-${iconSlug(name)}`)).toBe(true);
    }
  });

  it('un icono con etiqueta se anuncia (role=img) y deja de ser decorativo', () => {
    const svg = icon('magnet', { label: 'Snapping' });
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toBe('Snapping');
    expect(svg.getAttribute('aria-hidden')).toBeNull();
    expect(svg.querySelector('title')?.textContent).toBe('Snapping');
  });

  it('createIconElement es el atajo de tamaño del HUD', () => {
    const svg = createIconElement('text', 22);
    expect(svg.getAttribute('width')).toBe('22');
    expect(svg.getAttribute('height')).toBe('22');
    expect(svg.getAttribute('data-icon')).toBe('text');
    expect(createIconElement('cursor').getAttribute('width')).toBe('18');
  });

  it('el markup es equivalente y no lleva emoji', () => {
    const markup = iconMarkup('panelLeft', { label: 'Paneles' });
    expect(markup.startsWith('<svg')).toBe(true);
    expect(markup).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(markup).toContain('aria-label="Paneles"');
    expect(/\p{Extended_Pictographic}/u.test(markup)).toBe(false);
    for (const name of ICON_NAMES) {
      const single = iconMarkup(name);
      expect(single).toContain(`data-icon="${name}"`);
      expect(single.endsWith('</svg>')).toBe(true);
    }
  });

  it('los botones del HUD usan el glifo, no texto ni emoji', () => {
    const button = iconButton({ icon: 'hand', label: 'Mano', shortcut: 'H' });
    expect(button.title).toBe('Mano (H)');
    expect(button.getAttribute('aria-keyshortcuts')).toBe('H');
    expect(button.querySelector('svg.concat-icon-hand')).not.toBeNull();
    expect(/\p{Extended_Pictographic}/u.test(button.textContent ?? '')).toBe(false);
  });
});
