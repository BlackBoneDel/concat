// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

// @vitest-environment jsdom
/** Fase 7: the SVG icon system, icon buttons and the "no emoji" guard. */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  ICON_NAMES,
  icon,
  iconButton,
  iconMarkup,
  iconSlug,
  setButtonIcon,
  setPressed,
  tooltipFor,
  type IconName,
} from '../src/ui/components/icons.ts';
import { Toolbar, TOOL_BUTTONS, type ToolbarActions } from '../src/ui/timeline/toolbar.ts';

/** The glyphs the brief requires, by group. */
const REQUIRED: Record<string, IconName[]> = {
  playback: ['play', 'pause', 'skipBack', 'skipForward', 'stepBack', 'stepForward', 'loop'],
  tools: ['select', 'split', 'ripple', 'roll', 'slip', 'slide'],
  track: ['eye', 'eyeOff', 'lock', 'unlock', 'volumeOn', 'volumeMute'],
  inspector: ['keyframeEmpty', 'keyframeFilled', 'link', 'unlink', 'group', 'marker'],
  system: ['settings', 'export', 'sun', 'moon', 'menu'],
};

describe('icons — the glyph table', () => {
  it.each(Object.entries(REQUIRED))('incluye todo el grupo %s', (_group, names) => {
    for (const name of names) expect(ICON_NAMES).toContain(name);
  });

  it('cada icono usa la base exigida (24×24, stroke currentColor, sin relleno, extremos redondos)', () => {
    for (const name of ICON_NAMES) {
      const svg = icon(name);
      expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg');
      expect(svg.getAttribute('width')).toBe('18');
      expect(svg.getAttribute('height')).toBe('18');
      expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
      expect(svg.getAttribute('fill')).toBe('none');
      expect(svg.getAttribute('stroke')).toBe('currentColor');
      expect(svg.getAttribute('stroke-width')).toBe('2');
      expect(svg.getAttribute('stroke-linecap')).toBe('round');
      expect(svg.getAttribute('stroke-linejoin')).toBe('round');
      expect(svg.classList.contains('concat-icon')).toBe(true);
      expect(svg.classList.contains(`concat-icon-${iconSlug(name)}`)).toBe(true);
      expect(svg.getAttribute('aria-hidden')).toBe('true');
      expect(svg.childElementCount).toBeGreaterThan(0);
    }
  });

  it('iconMarkup produce SVG autónomo (xmlns) equivalente al elemento vivo', () => {
    const markup = iconMarkup('keyframeFilled', { size: 12, className: 'x' });
    expect(markup.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    const host = document.createElement('div');
    host.innerHTML = markup;
    const parsed = host.querySelector('svg')!;
    expect(parsed.getAttribute('width')).toBe('12');
    expect(parsed.classList.contains('concat-icon-keyframe-filled')).toBe(true);
    expect(parsed.classList.contains('x')).toBe(true);
    expect(parsed.childElementCount).toBe(icon('keyframeFilled').childElementCount);
  });

  it('con label el icono deja de estar oculto y lleva <title>', () => {
    const svg = icon('alert', { label: 'Atención', strokeWidth: 1.5 });
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toBe('Atención');
    expect(svg.querySelector('title')?.textContent).toBe('Atención');
    expect(svg.getAttribute('stroke-width')).toBe('1.5');
    expect(iconMarkup('alert', { label: 'a "b" <c>' })).toContain('aria-label="a &quot;b&quot; &lt;c>"');
  });
});

describe('icons — botones', () => {
  it('iconButton: clase, tooltip nativo "Label (K)", aria-label y aria-keyshortcuts', () => {
    const onClick = vi.fn();
    const button = iconButton({ icon: 'split', label: 'Split', shortcut: 'C', onClick });
    expect(button.classList.contains('concat-icon-btn')).toBe(true);
    expect(button.type).toBe('button');
    expect(button.title).toBe('Split (C)');
    expect(button.getAttribute('aria-label')).toBe('Split');
    expect(button.getAttribute('aria-keyshortcuts')).toBe('C');
    expect(button.querySelector('svg.concat-icon-split')).not.toBeNull();
    expect(button.textContent).toBe('');
    button.click();
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(tooltipFor('Deshacer', 'Ctrl+Z')).toBe('Deshacer (Ctrl+Z)');
    expect(iconButton({ icon: 'undo', label: 'Deshacer', shortcut: 'Ctrl+Z' }).getAttribute('aria-keyshortcuts')).toBe('Control+Z');
    expect(tooltipFor('Solo')).toBe('Solo');
  });

  it('toggles: setPressed sincroniza .active y aria-pressed; setButtonIcon cambia el glifo y conserva el texto', () => {
    const button = iconButton({ icon: 'eye', label: 'Visible', pressed: true, text: 'Pista', size: 14 });
    expect(button.classList.contains('active')).toBe(true);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    setPressed(button, false);
    expect(button.classList.contains('active')).toBe(false);
    expect(button.getAttribute('aria-pressed')).toBe('false');
    setButtonIcon(button, 'eyeOff');
    const svg = button.querySelector('svg')!;
    expect(svg.getAttribute('data-icon')).toBe('eyeOff');
    expect(svg.getAttribute('width')).toBe('14');
    expect(button.querySelectorAll('svg')).toHaveLength(1);
    expect(button.querySelector('.concat-icon-btn-text')?.textContent).toBe('Pista');
    setButtonIcon(button, 'eyeOff'); // no-op
    expect(button.querySelector('svg')).toBe(svg);
  });

  it('la barra de herramientas usa iconos SVG con tooltips y nunca texto/emoji como glifo', () => {
    const actions: ToolbarActions = {
      setTool: vi.fn(),
      toggleSnapping: vi.fn(),
      splitAtPlayhead: vi.fn(),
      deleteSelection: vi.fn(),
      duplicateSelection: vi.fn(),
      groupSelection: vi.fn(),
      linkSelection: vi.fn(),
      addMarker: vi.fn(),
      undo: vi.fn(),
      redo: vi.fn(),
      addTrack: vi.fn(),
    };
    const toolbar = new Toolbar(actions);
    for (const tool of TOOL_BUTTONS) {
      const button = toolbar.element.querySelector<HTMLButtonElement>(`.tl-tool-${tool.id}`)!;
      expect(button.title).toBe(`${tool.label} (${tool.key})`);
      expect(button.querySelector(`svg.concat-icon-${iconSlug(tool.icon)}`)).not.toBeNull();
    }
    expect(toolbar.element.querySelector<HTMLButtonElement>('.tl-tool-blade')!.title).toBe('Cuchilla (Split) (C)');
    for (const button of toolbar.element.querySelectorAll('button')) {
      expect(button.querySelector('svg.concat-icon')).not.toBeNull();
      expect(/\p{Extended_Pictographic}/u.test(button.textContent ?? '')).toBe(false);
    }
  });
});

describe('guardia anti-emoji', () => {
  /** Typographic arrows/marks that are text, not pictograms. */
  const ALLOWED = new Set(['↔', '©', '®', '™']);

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return sourceFiles(path);
      return /\.(ts|html|css)$/.test(entry) ? [path] : [];
    });
  }

  it('ningún archivo de src/ (ni index.html) contiene emojis fuera de comentarios', () => {
    const root = join(__dirname, '..');
    const files = [...sourceFiles(join(root, 'src')), join(root, 'index.html')];
    expect(files.length).toBeGreaterThan(50);
    const offenders: string[] = [];
    for (const file of files) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          const trimmed = line.trim();
          if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return;
          for (const match of line.matchAll(/[\p{Extended_Pictographic}\u{FE0F}\u{23E9}-\u{23FA}\u{25A0}-\u{25FF}]/gu)) {
            if (!ALLOWED.has(match[0])) offenders.push(`${file.slice(root.length + 1)}:${index + 1} ${match[0]}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });
});
