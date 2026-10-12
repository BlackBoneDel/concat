// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Fase 6: the keyboard shortcut sheet (`?`), grouped and searchable. The
 * catalog mirrors the real bindings: `ui/shortcuts.ts` (global),
 * `ui/interactions/keyboard-shortcuts.ts` (timeline tools/edits) and the
 * Fase 4/6 additions wired in `main.ts`.
 */

import { Dialog } from './dialog.ts';

/** One documented shortcut. */
export interface ShortcutEntry {
  keys: string;
  label: string;
}

/** A titled group. */
export interface ShortcutGroup {
  title: string;
  entries: ShortcutEntry[];
}

/** Every documented shortcut, by group. */
export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = Object.freeze([
  {
    title: 'Reproducción',
    entries: [
      { keys: 'Espacio', label: 'Reproducir / pausar' },
      { keys: '← / →', label: 'Fotograma anterior / siguiente' },
      { keys: 'Inicio / Fin', label: 'Ir al principio / al final' },
    ],
  },
  {
    title: 'Herramientas',
    entries: [
      { keys: 'V', label: 'Selección' },
      { keys: 'C', label: 'Cuchilla' },
      { keys: 'B', label: 'Ripple' },
      { keys: 'N', label: 'Slip' },
      { keys: 'Y', label: 'Slide' },
      { keys: 'U', label: 'Roll' },
      { keys: 'P', label: 'Pluma (keyframes)' },
      { keys: 'S', label: 'Activar / desactivar imán' },
    ],
  },
  {
    title: 'Edición',
    entries: [
      { keys: 'Ctrl+Z', label: 'Deshacer' },
      { keys: 'Ctrl+Shift+Z / Ctrl+Y', label: 'Rehacer' },
      { keys: 'Ctrl+C / Ctrl+X / Ctrl+V', label: 'Copiar / cortar / pegar' },
      { keys: 'Ctrl+D', label: 'Duplicar selección' },
      { keys: 'Ctrl+A', label: 'Seleccionar todo' },
      { keys: 'Ctrl+K', label: 'Cortar en el cabezal' },
      { keys: 'Supr', label: 'Eliminar selección' },
      { keys: 'Shift+Supr', label: 'Eliminar con ripple' },
      { keys: 'Ctrl+G / Ctrl+Shift+G', label: 'Agrupar / desagrupar' },
      { keys: 'Ctrl+L / Ctrl+Shift+L', label: 'Vincular / desvincular' },
      { keys: 'E', label: 'Activar / desactivar clip' },
      { keys: 'M', label: 'Añadir marcador' },
      { keys: 'Esc', label: 'Deseleccionar' },
    ],
  },
  {
    title: 'Vista',
    entries: [
      { keys: 'Ctrl+= / Ctrl+-', label: 'Acercar / alejar la línea de tiempo' },
      { keys: 'Ctrl+0', label: 'Ajustar a la ventana' },
      { keys: 'Ctrl+Shift+P', label: 'Previsualizar con proxies' },
      { keys: '?', label: 'Esta lista de atajos' },
    ],
  },
  {
    title: 'Archivo y exportación',
    entries: [
      { keys: 'Ctrl+S', label: 'Guardar proyecto' },
      { keys: 'Ctrl+I', label: 'Importar medios' },
      { keys: 'Ctrl+E', label: 'Exportar vídeo' },
      { keys: 'I', label: 'Marcar entrada de exportación en el cabezal' },
      { keys: 'O', label: 'Marcar salida de exportación en el cabezal' },
      { keys: 'Alt+X', label: 'Borrar entrada/salida' },
    ],
  },
]);

/**
 * Case/accent-insensitive filter.
 * @param groups the catalog.
 * @param query the search text.
 * @returns groups with matching entries (empty groups removed).
 */
export function filterShortcuts(groups: readonly ShortcutGroup[], query: string): ShortcutGroup[] {
  const fold = (text: string): string => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  const needle = fold(query.trim());
  if (needle === '') return groups.map((group) => ({ title: group.title, entries: [...group.entries] }));
  return groups
    .map((group) => ({
      title: group.title,
      entries: group.entries.filter((entry) => fold(`${entry.label} ${entry.keys} ${group.title}`).includes(needle)),
    }))
    .filter((group) => group.entries.length > 0);
}

/**
 * Opens the sheet.
 * @param groups the catalog (defaults to {@link SHORTCUT_GROUPS}).
 * @returns the dialog.
 */
export function openShortcutsModal(groups: readonly ShortcutGroup[] = SHORTCUT_GROUPS): Dialog {
  const dialog = new Dialog({ title: 'Atajos de teclado', description: 'Escribe para filtrar. Los atajos no actúan mientras escribes en un campo.', className: 'shortcuts-modal' });
  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'shortcuts-search';
  search.placeholder = 'Buscar atajo…';
  search.setAttribute('aria-label', 'Buscar atajo');
  const results = document.createElement('div');
  results.className = 'shortcuts-groups';
  const count = document.createElement('p');
  count.className = 'sr-only';
  count.setAttribute('aria-live', 'polite');
  dialog.body.append(search, count, results);

  const render = (): void => {
    const filtered = filterShortcuts(groups, search.value);
    results.replaceChildren();
    let total = 0;
    for (const group of filtered) {
      const section = document.createElement('section');
      section.className = 'shortcuts-group';
      const heading = document.createElement('h3');
      heading.textContent = group.title;
      const list = document.createElement('dl');
      for (const entry of group.entries) {
        const dt = document.createElement('dt');
        for (const [index, part] of entry.keys.split(' / ').entries()) {
          if (index > 0) dt.append(' / ');
          const kbd = document.createElement('kbd');
          kbd.textContent = part;
          dt.appendChild(kbd);
        }
        const dd = document.createElement('dd');
        dd.textContent = entry.label;
        list.append(dt, dd);
        total += 1;
      }
      section.append(heading, list);
      results.appendChild(section);
    }
    if (total === 0) {
      const empty = document.createElement('p');
      empty.className = 'panel-empty';
      empty.textContent = 'Ningún atajo coincide.';
      results.appendChild(empty);
    }
    count.textContent = `${total} atajos`;
  };
  search.addEventListener('input', render);
  render();
  dialog.addButton('Cerrar', () => dialog.close(), 'primary');
  queueMicrotask(() => search.focus());
  return dialog;
}
