// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Font manager: adds `.ttf`/`.otf`/`.woff`/`.woff2` files to the project.
 * Bytes go to OPFS (`/fonts/<uuid>.<ext>`) through {@link FontStore}, the
 * entry is added with an undoable {@link AddCustomFontOperation} and the
 * face is registered with `document.fonts` by {@link FontLoader}. Nothing
 * touches the network. Removing a font only drops it from the project (the
 * file stays so undo can bring it back).
 */

import { AddCustomFontOperation, projectFonts, RemoveCustomFontOperation } from '../../editor/text-operations.ts';
import type { EditOperation } from '../../editor/operations.ts';
import type { ProjectDocument } from '../../model/document.ts';
import type { CustomFont } from '../../render/advanced-text.ts';
import type { FontLoader } from '../../render/font-loader.ts';
import type { FontStore } from '../../storage/font-store.ts';
import { Dialog, formatBytes } from '../modals/dialog.ts';

/** Accepted extensions (the store re-checks the magic bytes). */
export const FONT_ACCEPT = '.ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2';

/** Sample line drawn in each font. */
export const FONT_SAMPLE = 'Aa Ññ 0123 — El veloz murciélago hindú';

/** Options of {@link openFontManager}. */
export interface FontManagerOptions {
  getDocument(): ProjectDocument;
  /** Runs an edit through history; returns whether it applied. */
  run(op: EditOperation): boolean | void;
  store: FontStore;
  loader: FontLoader;
  /** Reports a failure (toast). */
  onError(error: unknown): void;
}

/**
 * Imports font files into the project, one by one (a bad file does not stop
 * the rest).
 * @param files the picked files.
 * @param options wiring.
 * @returns the fonts that were added.
 */
export async function importFontFiles(files: readonly (Blob & { name: string })[], options: Pick<FontManagerOptions, 'run' | 'store' | 'loader' | 'onError'>): Promise<CustomFont[]> {
  const added: CustomFont[] = [];
  for (const file of files) {
    try {
      const font = await options.store.add(file);
      if (options.run(new AddCustomFontOperation(font)) === false) continue;
      added.push(font);
      const ok = await options.loader.ensure(font);
      if (!ok) options.onError(new Error(`${file.name}: el navegador no pudo cargar la fuente${options.loader.failure(font.id) ? ` (${options.loader.failure(font.id)})` : ''}`));
    } catch (error) {
      options.onError(error);
    }
  }
  return added;
}

/**
 * Opens the font manager.
 * @param options wiring.
 * @returns resolves when the dialog closes.
 */
export function openFontManager(options: FontManagerOptions): Promise<void> {
  const dialog = new Dialog({
    title: 'Fuentes del proyecto',
    description: 'Añade fuentes TrueType, OpenType o WOFF. Se guardan en este navegador y no salen de él.',
    className: 'font-manager-modal',
  });
  const list = document.createElement('ul');
  list.className = 'font-list';
  list.setAttribute('aria-label', 'Fuentes del proyecto');
  const status = document.createElement('p');
  status.className = 'fx-note';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  const render = (): void => {
    const fonts = projectFonts(options.getDocument());
    list.replaceChildren();
    if (fonts.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'fx-hint';
      empty.textContent = 'Este proyecto aún no tiene fuentes propias.';
      list.appendChild(empty);
    }
    for (const font of fonts) {
      const row = document.createElement('li');
      row.className = 'font-row';
      const sample = document.createElement('span');
      sample.className = 'font-sample';
      sample.textContent = FONT_SAMPLE;
      const loaded = options.loader.isLoaded(font.id);
      if (loaded) sample.style.fontFamily = `"${font.family}", system-ui`;
      const meta = document.createElement('span');
      meta.className = 'font-meta';
      const failure = options.loader.failure(font.id);
      meta.textContent = `${font.fileName} · ${font.format.toUpperCase()} · ${loaded ? 'cargada' : failure ? `error: ${failure}` : 'cargando…'}`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn btn-ghost btn-small';
      remove.textContent = 'Quitar';
      remove.setAttribute('aria-label', `Quitar la fuente ${font.fileName} del proyecto`);
      remove.addEventListener('click', () => {
        options.run(new RemoveCustomFontOperation(font.id));
        render();
      });
      row.append(sample, meta, remove);
      list.appendChild(row);
      if (!loaded && !failure) void options.loader.ensure(font).then(() => dialog.isOpen && render());
    }
  };

  const input = document.createElement('input');
  input.type = 'file';
  input.accept = FONT_ACCEPT;
  input.multiple = true;
  input.hidden = true;
  input.addEventListener('change', () => {
    const files = [...(input.files ?? [])];
    input.value = '';
    if (files.length === 0) return;
    const total = files.reduce((sum, file) => sum + file.size, 0);
    status.textContent = `Importando ${files.length} archivo(s) (${formatBytes(total)})…`;
    void importFontFiles(files, options).then((added) => {
      status.textContent = added.length > 0 ? `${added.length} fuente(s) añadida(s).` : 'No se añadió ninguna fuente.';
      if (dialog.isOpen) render();
    });
  });

  // Drop zone: dragging files onto the dialog imports them too.
  dialog.body.addEventListener('dragover', (event) => {
    if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
  });
  dialog.body.addEventListener('drop', (event) => {
    const files = [...(event.dataTransfer?.files ?? [])];
    if (files.length === 0) return;
    event.preventDefault();
    void importFontFiles(files, options).then(() => dialog.isOpen && render());
  });

  const unsubscribe = options.loader.onLoad(() => {
    if (dialog.isOpen) render();
  });
  dialog.onClose(unsubscribe);
  dialog.body.append(list, status, input);
  dialog.addButton('Añadir fuente…', () => input.click(), 'primary');
  dialog.addButton('Cerrar', () => dialog.close());
  render();
  return dialog.closed;
}
