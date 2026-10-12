// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Inspector: presets for the selected clip — the built-in motion/text looks
 * (Fade In, Zoom In, Slide, Bounce, Typewriter, Cinematic Title, Neon Glow…)
 * and the user's own, saved in `ConcatProjectDB.user_presets`. Applying is
 * one undoable {@link ApplyPresetOperation}; saving captures the clip's
 * current look of the chosen type.
 */

import type { EditOperation } from '../../editor/operations.ts';
import type { DocumentClip, ProjectDocument } from '../../model/document.ts';
import { ApplyPresetOperation, hasContent, presetIncompatibility, type PresetManager } from '../../presets/preset-manager.ts';
import { PRESET_TYPES, type PresetType, type UserPreset } from '../../presets/preset-types.ts';
import { actions, button, group, select, subheading } from './fields.ts';

/** What the section needs. */
export interface PresetsHost {
  getDocument(): ProjectDocument;
  run(op: EditOperation): void;
  presets: PresetManager;
  /** Reports a failure (toast). */
  onError(error: unknown): void;
}

/** Spanish labels of preset types. */
export const PRESET_TYPE_LABELS: Readonly<Record<PresetType, string>> = Object.freeze({
  video: 'Movimiento / vídeo',
  audio: 'Audio',
  text: 'Texto',
  color: 'Color',
});

/**
 * The preset types that fit a clip kind.
 * @param clip the clip.
 * @returns compatible types, in display order.
 */
export function compatibleTypes(clip: DocumentClip): PresetType[] {
  return PRESET_TYPES.filter((type) => presetIncompatibility(type, clip) === null);
}

function presetButton(host: PresetsHost, clip: DocumentClip, preset: UserPreset): HTMLElement {
  const row = document.createElement('li');
  row.className = 'preset-row';
  const apply = button(preset.name, () => host.run(new ApplyPresetOperation(clip.id, preset)), `Aplicar «${preset.name}» (${PRESET_TYPE_LABELS[preset.type]})`, 'btn btn-secondary btn-small preset-apply');
  row.appendChild(apply);
  if (!preset.builtin) {
    const remove = button('×', () => {
      host.presets.delete(preset.id).catch((error: unknown) => host.onError(error));
    }, `Borrar el preset «${preset.name}»`, 'btn btn-ghost btn-small preset-remove');
    remove.setAttribute('aria-label', `Borrar el preset «${preset.name}»`);
    row.appendChild(remove);
  }
  return row;
}

function list(label: string): HTMLUListElement {
  const ul = document.createElement('ul');
  ul.className = 'preset-list';
  ul.setAttribute('aria-label', label);
  return ul;
}

/**
 * Builds the presets section.
 * @param host inspector host.
 * @param clip the clip.
 * @returns the section, or `null` when no preset type fits the clip.
 */
export function presetsSection(host: PresetsHost, clip: DocumentClip): HTMLElement | null {
  const types = compatibleTypes(clip);
  if (types.length === 0) return null;
  const builtins = list('Presets integrados');
  for (const preset of host.presets.builtins().filter((item) => types.includes(item.type))) {
    builtins.appendChild(presetButton(host, clip, preset));
  }
  const mine = list('Mis presets');
  const empty = document.createElement('p');
  empty.className = 'fx-hint';
  empty.textContent = 'Aún no has guardado presets.';
  void host.presets
    .list()
    .then((all) => {
      const user = all.filter((preset) => !preset.builtin && types.includes(preset.type));
      empty.hidden = user.length > 0;
      for (const preset of user) mine.appendChild(presetButton(host, clip, preset));
    })
    .catch((error: unknown) => host.onError(error));

  // Save the current look.
  let type: PresetType = types[0] ?? 'video';
  const name = document.createElement('input');
  name.type = 'text';
  name.className = 'input';
  name.maxLength = 64;
  name.placeholder = 'Nombre del preset';
  name.setAttribute('aria-label', 'Nombre del nuevo preset');
  const typeRow = select<PresetType>('Guardar', type, types.map((value) => ({ value, label: PRESET_TYPE_LABELS[value] })), (value) => {
    type = value;
  });
  const save = button('Guardar preset', () => {
    try {
      const data = host.presets.capture(host.getDocument(), clip.id, type);
      if (!hasContent(data)) {
        host.onError(new Error(`El clip no tiene nada de tipo «${PRESET_TYPE_LABELS[type]}» que guardar`));
        return;
      }
      const label = name.value.trim() || `${clip.name || 'Clip'} · ${PRESET_TYPE_LABELS[type]}`;
      host.presets.save(label, type, data).then(() => {
        name.value = '';
      }).catch((error: unknown) => host.onError(error));
    } catch (error) {
      host.onError(error);
    }
  }, 'Guarda el aspecto actual del clip como preset reutilizable', 'btn btn-primary btn-small');
  name.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      save.click();
    }
  });

  return group('Presets', false, [
    subheading('Integrados'),
    builtins,
    subheading('Mis presets'),
    mine,
    empty,
    typeRow,
    name,
    actions(save),
  ], 'fx-presets');
}
