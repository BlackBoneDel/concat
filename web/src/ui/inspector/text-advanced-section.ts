// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Inspector: advanced titling of a text clip — font (built-in families or
 * the project's own .ttf/.woff2), weight/alignment, solid or gradient fill,
 * stroke, drop shadow, background plate, glow and the typewriter reveal.
 * Everything is stored in `clip.extra.advanced_text` through
 * {@link UpdateTextStylesOperation} (one undo step per change).
 */

import { projectFonts, UpdateTextStylesOperation, type TextStylesChange } from '../../editor/text-operations.ts';
import type { EditOperation } from '../../editor/operations.ts';
import type { DocumentClip, ProjectDocument } from '../../model/document.ts';
import type { TextAlign } from '../../model/wire.ts';
import { ADVANCED_TEXT_KEY, defaultAdvancedText, parseAdvancedText, type AdvancedTextStyle } from '../../render/advanced-text.ts';
import { actions, button, check, group, select, slider, subheading } from './fields.ts';

/** What the section needs. */
export interface TextAdvancedHost {
  getDocument(): ProjectDocument;
  run(op: EditOperation): void;
  /** Opens the font manager (.ttf/.woff2 → OPFS). */
  openFontManager(): void;
}

/** Built-in families (always available, no network). */
export const SYSTEM_FONT_FAMILIES: readonly { value: string; label: string }[] = Object.freeze([
  { value: '"Cabinet Grotesk"', label: 'Cabinet Grotesk (por defecto)' },
  { value: 'system-ui, sans-serif', label: 'Sistema' },
  { value: 'Georgia, "Times New Roman", serif', label: 'Serif' },
  { value: '"Courier New", ui-monospace, monospace', label: 'Monoespaciada' },
  { value: 'Impact, "Arial Black", sans-serif', label: 'Impact' },
  { value: '"Trebuchet MS", Verdana, sans-serif', label: 'Humanista' },
]);

/**
 * Any CSS colour → `#rrggbb` for `<input type=color>` (alpha dropped).
 * @param color hex, rgb()/rgba() or anything else.
 * @param fallback used when the colour cannot be read.
 * @returns a 7-character hex colour.
 */
export function toHexColor(color: string, fallback = '#000000'): string {
  const value = color.trim().toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])?$/.exec(value);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  const long = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(value);
  if (long) return `#${long[1]}`;
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(value);
  if (rgb) {
    const hex = [rgb[1], rgb[2], rgb[3]].map((part) => Math.min(255, Math.max(0, Math.round(Number(part)))).toString(16).padStart(2, '0'));
    return `#${hex.join('')}`;
  }
  return fallback;
}

/**
 * Keeps the alpha of an `rgba()` colour when a hex colour is picked.
 * @param hex the picked `#rrggbb`.
 * @param previous the colour it replaces.
 * @returns `rgba(r,g,b,a)` when the previous colour had alpha < 1, else `hex`.
 */
export function withAlphaOf(hex: string, previous: string): string {
  const alpha = /^rgba\([^)]*?,\s*([\d.]+)\s*\)$/i.exec(previous.trim());
  const a = alpha ? Number(alpha[1]) : 1;
  if (!(a < 1)) return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}

function colorRow(label: string, value: string, commit: (color: string) => void): HTMLElement {
  const row = document.createElement('label');
  row.className = 'field-row';
  const title = document.createElement('span');
  title.textContent = label;
  const input = document.createElement('input');
  input.type = 'color';
  input.className = 'input-color';
  input.value = toHexColor(value);
  input.setAttribute('aria-label', label);
  input.addEventListener('change', () => commit(withAlphaOf(input.value, value)));
  row.append(title, input);
  return row;
}

const pct = (v: number): string => `${Math.round(v * 1000) / 10} %`;

/**
 * Builds the advanced titling section (text clips only).
 * @param host inspector host.
 * @param clip the clip.
 * @returns the section, or `null` for non-text clips.
 */
export function textAdvancedSection(host: TextAdvancedHost, clip: DocumentClip): HTMLElement | null {
  if (clip.kind !== 'text' || !clip.text) return null;
  const base = clip.text;
  const stored = parseAdvancedText(clip.extra[ADVANCED_TEXT_KEY]);
  const adv: AdvancedTextStyle = stored ?? defaultAdvancedText();
  const run = (change: TextStylesChange): void => host.run(new UpdateTextStylesOperation(clip.id, change));
  const fonts = projectFonts(host.getDocument());

  // Font: built-in families + the project's fonts (by id).
  const fontOptions = [
    ...SYSTEM_FONT_FAMILIES.map((family) => ({ value: `sys:${family.value}`, label: family.label })),
    ...fonts.map((font) => ({ value: `font:${font.id}`, label: `${font.fileName} (propia)` })),
  ];
  const currentFont = adv.fontId && fonts.some((font) => font.id === adv.fontId) ? `font:${adv.fontId}` : `sys:${base.fontFamily}`;
  if (!fontOptions.some((option) => option.value === currentFont)) fontOptions.unshift({ value: currentFont, label: base.fontFamily });
  const fontRow = select('Fuente', currentFont, fontOptions, (value) => {
    if (value.startsWith('font:')) run({ advanced: { fontId: value.slice(5) } });
    else run({ base: { fontFamily: value.slice(4) }, advanced: { fontId: null } });
  });

  const fill = adv.fill;
  const gradient = Array.isArray(fill);
  const stops = gradient ? fill : [fill, fill];
  const fillRows: HTMLElement[] = gradient
    ? [
        ...stops.map((stop, index) =>
          colorRow(`Color ${index + 1}`, stop, (color) => {
            const next = [...stops];
            next[index] = color;
            run({ advanced: { fill: next } });
          }),
        ),
        slider('Ángulo', adv.gradientAngle, { min: 0, max: 360, step: 5 }, (v) => run({ advanced: { gradientAngle: v } }), (v) => `${v}°`),
        actions(
          button('+ Parada', () => run({ advanced: { fill: [...stops, stops[stops.length - 1] ?? '#ffffff'] } }), 'Añadir un color al degradado'),
          ...(stops.length > 2 ? [button('− Parada', () => run({ advanced: { fill: stops.slice(0, -1) } }), 'Quitar el último color')] : []),
        ),
      ]
    : [colorRow('Color', fill, (color) => run({ advanced: { fill: color }, base: { color } }))];

  const children: HTMLElement[] = [
    fontRow,
    actions(button('Gestionar fuentes…', () => host.openFontManager(), 'Añadir fuentes .ttf/.otf/.woff/.woff2 (se guardan en este navegador)')),
    slider('Grosor', base.fontWeight, { min: 100, max: 900, step: 100 }, (v) => run({ base: { fontWeight: v } }), (v) => String(v)),
    select<TextAlign>('Alineación', base.align, [
      { value: 'left', label: 'Izquierda' },
      { value: 'center', label: 'Centro' },
      { value: 'right', label: 'Derecha' },
    ], (align) => run({ base: { align } })),
    slider('Espaciado', base.tracking, { min: -0.02, max: 0.1, step: 0.002 }, (v) => run({ base: { tracking: v } }), pct),

    subheading('Relleno'),
    check('Degradado', gradient, (on) => run({ advanced: { fill: on ? [stops[0] ?? '#ffffff', '#4c8dff'] : stops[0] ?? '#ffffff' } })),
    ...fillRows,

    subheading('Borde'),
    check('Borde', adv.stroke.enabled, (on) => run({ advanced: { stroke: { enabled: on } } })),
    colorRow('Color del borde', adv.stroke.color, (color) => run({ advanced: { stroke: { color, enabled: true } } })),
    slider('Ancho del borde', adv.stroke.width, { min: 0, max: 0.03, step: 0.0005 }, (v) => run({ advanced: { stroke: { width: v, enabled: v > 0 } } }), pct),

    subheading('Sombra'),
    check('Sombra', adv.shadow.enabled, (on) => run({ advanced: { shadow: { enabled: on } } })),
    colorRow('Color de sombra', adv.shadow.color, (color) => run({ advanced: { shadow: { color, enabled: true } } })),
    slider('Desenfoque', adv.shadow.blur, { min: 0, max: 0.08, step: 0.001 }, (v) => run({ advanced: { shadow: { blur: v } } }), pct),
    slider('Desplazamiento X', adv.shadow.offsetX, { min: -0.05, max: 0.05, step: 0.001 }, (v) => run({ advanced: { shadow: { offsetX: v } } }), pct),
    slider('Desplazamiento Y', adv.shadow.offsetY, { min: -0.05, max: 0.05, step: 0.001 }, (v) => run({ advanced: { shadow: { offsetY: v } } }), pct),

    subheading('Fondo'),
    check('Caja de fondo', adv.background.enabled, (on) => run({ advanced: { background: { enabled: on } } })),
    colorRow('Color de fondo', adv.background.color, (color) => run({ advanced: { background: { color, enabled: true } } })),
    slider('Opacidad del fondo', adv.background.opacity, { min: 0, max: 1, step: 0.05 }, (v) => run({ advanced: { background: { opacity: v } } }), (v) => `${Math.round(v * 100)} %`),
    slider('Margen horizontal', adv.background.paddingX, { min: 0, max: 0.15, step: 0.002 }, (v) => run({ advanced: { background: { paddingX: v } } }), pct),
    slider('Margen vertical', adv.background.paddingY, { min: 0, max: 0.15, step: 0.002 }, (v) => run({ advanced: { background: { paddingY: v } } }), pct),
    slider('Radio de esquinas', adv.background.radius, { min: 0, max: 0.1, step: 0.002 }, (v) => run({ advanced: { background: { radius: v } } }), pct),

    subheading('Brillo'),
    check('Brillo (glow)', adv.glow.enabled, (on) => run({ advanced: { glow: { enabled: on } } })),
    colorRow('Color del brillo', adv.glow.color, (color) => run({ advanced: { glow: { color, enabled: true } } })),
    slider('Intensidad', adv.glow.blur, { min: 0, max: 0.1, step: 0.002 }, (v) => run({ advanced: { glow: { blur: v } } }), pct),

    subheading('Máquina de escribir'),
    check('Revelar letra a letra', adv.typewriter.enabled, (on) => run({ advanced: { typewriter: { enabled: on } } })),
    slider('Duración', adv.typewriter.duration, { min: 0.2, max: 20, step: 0.1 }, (v) => run({ advanced: { typewriter: { duration: v } } }), (v) => `${Math.round(v * 10) / 10} s`),
    check('Cursor parpadeante', adv.typewriter.cursor, (on) => run({ advanced: { typewriter: { cursor: on } } })),
  ];
  if (stored) {
    children.push(actions(button('Quitar estilo avanzado', () => run({ advanced: null }), 'Volver al estilo básico del título')));
  }
  return group('Titulación avanzada', stored !== null, children, 'fx-text-advanced');
}
