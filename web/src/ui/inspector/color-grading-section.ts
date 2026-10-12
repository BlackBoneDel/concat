// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Inspector: colour grading (12 linear-light controls), LUT choice and
 * strength, `.cube` loading and the before/after split view.
 */

import { parseClipEffects } from '../../media/clip-effects.ts';
import { GRADING_LABELS, GRADING_RANGES, NEUTRAL_GRADING, isNeutralGrading, type ColorGradingParams } from '../../media/vision/color-grading.ts';
import type { DocumentClip } from '../../model/document.ts';
import { getMediaTools } from '../media-tools.ts';
import { editEffects, type EffectSectionHost } from './effect-host.ts';
import { actions, button, check, group, select, slider, subheading } from './fields.ts';

const KEYS = Object.keys(NEUTRAL_GRADING) as (keyof ColorGradingParams)[];

/**
 * Builds the colour section.
 * @param host inspector host.
 * @param clip the clip (video/image).
 * @returns the section element.
 */
export function colorGradingSection(host: EffectSectionHost, clip: DocumentClip): HTMLElement {
  const fx = parseClipEffects(clip.extra['effects']);
  const grading = fx.colorGrading ?? { ...NEUTRAL_GRADING };
  const tools = getMediaTools();
  const edit = (mutate: Parameters<typeof editEffects>[2]): void => editEffects(host, clip, mutate);

  const sliders = KEYS.map((key) => {
    const range = GRADING_RANGES[key];
    return slider(GRADING_LABELS[key], grading[key], { min: range[0], max: range[1], step: range[2] }, (v) => edit((e) => {
      const next = { ...(e.colorGrading ?? NEUTRAL_GRADING), [key]: v };
      e.colorGrading = isNeutralGrading(next) ? null : next;
    }), (v) => (key === 'temperature' ? `${Math.round(v)} K` : key === 'hue' ? `${Math.round(v)}°` : String(Math.round(v * 100) / 100)));
  });

  const lutOptions = [{ value: '', label: 'Ninguna' }, ...(tools?.luts.list() ?? []).map((lut) => ({ value: lut.id, label: lut.title || lut.id }))];
  const currentLut = fx.lut?.id ?? '';
  if (currentLut !== '' && !lutOptions.some((o) => o.value === currentLut)) lutOptions.push({ value: currentLut, label: `${currentLut} (no cargada)` });
  const lutSelect = select('LUT', currentLut, lutOptions, (id) => edit((e) => {
    e.lut = id === '' ? null : { id, strength: e.lut?.strength ?? 1 };
  }));

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.cube';
  fileInput.hidden = true;
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file || !tools) return;
    void tools.importLut(file).then((lut) => {
      if (lut) edit((e) => { e.lut = { id: lut.id, strength: e.lut?.strength ?? 1 }; });
    });
  });

  const lutActions = actions(
    button('Explorar…', () => {
      if (!tools) return;
      void tools.browseLuts(fx.lut?.id ?? null).then((lut) => {
        if (lut) edit((e) => { e.lut = { id: lut.id, strength: e.lut?.strength ?? 1 }; });
      });
    }, 'Abrir el explorador de LUTs'),
    button('Cargar .cube…', () => fileInput.click(), 'Cargar un archivo .cube'),
    fileInput,
  );
  for (const el of lutActions.querySelectorAll('button')) el.disabled = tools === null;

  return group('Color', fx.colorGrading !== null || fx.lut !== null, [
    ...sliders,
    actions(button('Restablecer color', () => edit((e) => { e.colorGrading = null; }), 'Volver a los valores neutros')),
    subheading('LUT'),
    lutSelect,
    slider('Intensidad LUT', fx.lut?.strength ?? 1, { min: 0, max: 1, step: 0.01 }, (v) => edit((e) => {
      if (e.lut) e.lut = { ...e.lut, strength: v };
    }), (v) => `${Math.round(v * 100)}%`),
    lutActions,
    check('Vista dividida antes/después', fx.splitView, (on) => edit((e) => { e.splitView = on; })),
  ], 'fx-color');
}
