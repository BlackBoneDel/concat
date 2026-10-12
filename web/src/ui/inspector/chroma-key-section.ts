// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Inspector: keying — chroma key (colour + eyedropper, similarity,
 * smoothness, spill), luma key, despill and edge feather/choke.
 */

import { parseClipEffects } from '../../media/clip-effects.ts';
import { DEFAULT_CHROMA_KEY } from '../../media/vision/chroma-key.ts';
import { hexToRgb, rgbToHex } from '../../media/vision/color-space.ts';
import { DEFAULT_FEATHER } from '../../media/vision/edge-feather.ts';
import { DEFAULT_LUMA_KEY } from '../../media/vision/luminance-key.ts';
import { DEFAULT_SPILL } from '../../media/vision/spill-suppression.ts';
import type { DocumentClip } from '../../model/document.ts';
import { getMediaTools } from '../media-tools.ts';
import { editEffects, type EffectSectionHost } from './effect-host.ts';
import { actions, button, check, group, slider, subheading } from './fields.ts';

const UNIT = { min: 0, max: 1, step: 0.01 };
const pct = (v: number): string => `${Math.round(v * 100)}%`;

/**
 * Builds the keying section.
 * @param host inspector host.
 * @param clip the clip (video/image).
 * @returns the section element.
 */
export function chromaKeySection(host: EffectSectionHost, clip: DocumentClip): HTMLElement {
  const fx = parseClipEffects(clip.extra['effects']);
  const chroma = fx.chromaKey ?? { ...DEFAULT_CHROMA_KEY, enabled: false };
  const luma = fx.lumaKey ?? { ...DEFAULT_LUMA_KEY, enabled: false };
  const spill = fx.spill ?? { ...DEFAULT_SPILL, enabled: false };
  const feather = fx.feather ?? { ...DEFAULT_FEATHER, enabled: false };
  const edit = (mutate: Parameters<typeof editEffects>[2]): void => editEffects(host, clip, mutate);

  const color = document.createElement('input');
  color.type = 'color';
  color.className = 'input-color';
  color.value = rgbToHex(chroma.color);
  color.setAttribute('aria-label', 'Color clave');
  color.addEventListener('change', () => {
    const rgb = hexToRgb(color.value);
    if (rgb) edit((e) => { e.chromaKey = { ...chroma, enabled: true, color: rgb }; });
  });
  const colorRow = document.createElement('div');
  colorRow.className = 'field-row';
  const colorLabel = document.createElement('span');
  colorLabel.textContent = 'Color clave';
  const eyedropper = button('Cuentagotas', () => {
    const tools = getMediaTools();
    if (!tools) return;
    void tools.pickColor().then((rgb) => {
      if (rgb) edit((e) => { e.chromaKey = { ...chroma, enabled: true, color: rgb }; });
    }).catch((error: unknown) => tools.notify('error', 'Cuentagotas', error instanceof Error ? error.message : String(error)));
  }, 'Tomar el color del visor (Esc cancela)');
  eyedropper.disabled = getMediaTools() === null;
  colorRow.append(colorLabel, color, eyedropper);

  const presets = actions(
    button('Verde', () => edit((e) => { e.chromaKey = { ...chroma, enabled: true, color: [0, 255, 0] }; }), 'Pantalla verde'),
    button('Azul', () => edit((e) => { e.chromaKey = { ...chroma, enabled: true, color: [0, 0, 255] }; }), 'Pantalla azul'),
    button('Restablecer', () => edit((e) => {
      e.chromaKey = null;
      e.lumaKey = null;
      e.spill = null;
      e.feather = null;
    }), 'Quitar todas las claves'),
  );

  return group('Chroma key', chroma.enabled || luma.enabled, [
    check('Chroma key activo', chroma.enabled, (on) => edit((e) => { e.chromaKey = { ...chroma, enabled: on }; })),
    colorRow,
    slider('Similitud', chroma.similarity, UNIT, (v) => edit((e) => { e.chromaKey = { ...chroma, enabled: true, similarity: v }; }), pct),
    slider('Suavidad', chroma.smoothness, UNIT, (v) => edit((e) => { e.chromaKey = { ...chroma, enabled: true, smoothness: v }; }), pct),
    slider('Reducción de derrame', chroma.spill, UNIT, (v) => edit((e) => { e.chromaKey = { ...chroma, enabled: true, spill: v }; }), pct),
    presets,
    subheading('Supresión de derrame'),
    check('Activa', spill.enabled, (on) => edit((e) => { e.spill = { ...spill, enabled: on }; })),
    slider('Cantidad', spill.amount, UNIT, (v) => edit((e) => { e.spill = { ...spill, enabled: true, amount: v }; }), pct),
    check('Conservar luminancia', spill.preserveLuminance, (on) => edit((e) => { e.spill = { ...spill, preserveLuminance: on }; })),
    subheading('Luma key'),
    check('Luma key activo', luma.enabled, (on) => edit((e) => { e.lumaKey = { ...luma, enabled: on }; })),
    slider('Mínimo', luma.min, UNIT, (v) => edit((e) => { e.lumaKey = { ...luma, enabled: true, min: Math.min(v, luma.max) }; }), pct),
    slider('Máximo', luma.max, UNIT, (v) => edit((e) => { e.lumaKey = { ...luma, enabled: true, max: Math.max(v, luma.min) }; }), pct),
    slider('Suavidad luma', luma.smoothness, { min: 0, max: 0.5, step: 0.01 }, (v) => edit((e) => { e.lumaKey = { ...luma, enabled: true, smoothness: v }; }), pct),
    check('Invertir', luma.invert, (on) => edit((e) => { e.lumaKey = { ...luma, invert: on }; })),
    subheading('Bordes'),
    slider('Difuminado (px)', feather.radius, { min: 0, max: 50, step: 0.5 }, (v) => edit((e) => { e.feather = { ...feather, enabled: true, radius: v }; }), (v) => `${v}px`),
    slider('Contraer / expandir', feather.choke, { min: -1, max: 1, step: 0.01 }, (v) => edit((e) => { e.feather = { ...feather, enabled: true, choke: v }; }), pct),
  ], 'fx-chroma');
}
