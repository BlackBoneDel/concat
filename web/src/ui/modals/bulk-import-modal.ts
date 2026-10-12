// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Bulk import dialog: pick a folder (FS Access or `webkitdirectory`),
 * choose concurrency / grouping / scan rules, then watch the import with a
 * progress bar, a live log and a cancel button.
 */

import { BulkImporter, type BulkImportEvent, type ImportGrouping, type ImportOne } from '../../media/import/bulk-importer.ts';
import type { FolderScanner, ScannedFile } from '../../media/relink/folder-scanner.ts';
import { Dialog, progressBar } from './dialog.ts';

/** Options of {@link openBulkImportModal}. */
export interface BulkImportModalOptions<T> {
  scanner: FolderScanner;
  importOne: ImportOne<T>;
  classify?: (result: T) => { kind?: string; width?: number; height?: number };
  /** Called once with the final groups. */
  onDone(groups: Map<string, T[]>, summary: { completed: number; failed: number; cancelled: boolean }): void;
}

const GROUPINGS: { value: ImportGrouping; label: string }[] = [
  { value: 'none', label: 'Sin agrupar' },
  { value: 'byType', label: 'Por tipo' },
  { value: 'byResolution', label: 'Por resolución' },
  { value: 'byFolder', label: 'Por carpeta' },
];

function labelled(text: string, input: HTMLElement): HTMLElement {
  const row = document.createElement('label');
  row.className = 'field-row';
  const span = document.createElement('span');
  span.textContent = text;
  row.append(span, input);
  return row;
}

/**
 * Opens the dialog.
 * @param options scanner, per-file import and completion callback.
 * @returns resolves when closed.
 */
export function openBulkImportModal<T>(options: BulkImportModalOptions<T>): Promise<void> {
  const dialog = new Dialog({ title: 'Importar carpeta', description: 'Importa todos los medios de una carpeta a la vez.', className: 'bulk-import-modal' });
  let files: ScannedFile[] = [];
  let importer: BulkImporter<T> | null = null;
  dialog.onClose(() => importer?.cancel());

  const concurrency = document.createElement('input');
  concurrency.type = 'number';
  concurrency.className = 'input';
  concurrency.min = '1';
  concurrency.max = '8';
  concurrency.value = '3';
  const grouping = document.createElement('select');
  grouping.className = 'input';
  for (const g of GROUPINGS) {
    const option = document.createElement('option');
    option.value = g.value;
    option.textContent = g.label;
    grouping.appendChild(option);
  }
  const recursive = document.createElement('input');
  recursive.type = 'checkbox';
  recursive.checked = true;
  const depth = document.createElement('input');
  depth.type = 'number';
  depth.className = 'input';
  depth.min = '0';
  depth.max = '64';
  depth.value = '8';
  const hidden = document.createElement('input');
  hidden.type = 'checkbox';
  hidden.checked = true;
  const form = document.createElement('div');
  form.className = 'bulk-form';
  form.append(
    labelled('Importaciones simultáneas (1–8)', concurrency),
    labelled('Agrupar', grouping),
    labelled('Incluir subcarpetas', recursive),
    labelled('Profundidad máxima', depth),
    labelled('Omitir ocultos', hidden),
  );
  const summary = document.createElement('p');
  summary.className = 'fx-note';
  summary.setAttribute('aria-live', 'polite');
  summary.textContent = 'Ninguna carpeta elegida.';
  const bar = progressBar('Progreso de importación');
  bar.element.hidden = true;
  const log = document.createElement('ul');
  log.className = 'bulk-log';
  log.setAttribute('aria-live', 'polite');
  dialog.body.append(form, summary, bar.element, log);

  const pick = dialog.addButton('Elegir carpeta…', () => {
    void options.scanner.pickAndScan({
      recursive: recursive.checked,
      maxDepth: Math.min(64, Math.max(0, Math.round(Number(depth.value) || 0))),
      skipHidden: hidden.checked,
    }, (p) => {
      summary.textContent = `Buscando… ${p.matched} archivo(s)`;
    }).then((found) => {
      if (!found) return;
      files = found;
      summary.textContent = `${files.length} archivo(s) listos para importar.`;
      start.disabled = files.length === 0;
    }).catch((error: unknown) => {
      summary.textContent = `Error al leer la carpeta: ${error instanceof Error ? error.message : String(error)}`;
    });
  });
  const cancel = dialog.addButton('Cancelar', () => {
    if (importer?.running) importer.cancel();
    else dialog.close();
  });
  const start = dialog.addButton('Importar', () => void run(), 'primary');
  start.disabled = true;

  const logLine = (text: string, kind: 'ok' | 'error'): void => {
    const li = document.createElement('li');
    li.className = `bulk-log-${kind}`;
    li.textContent = text;
    log.prepend(li);
    while (log.children.length > 200) log.lastElementChild?.remove();
  };

  const run = async (): Promise<void> => {
    const value = Math.round(Number(concurrency.value));
    if (!Number.isInteger(value) || value < 1 || value > 8) {
      summary.textContent = 'La concurrencia debe estar entre 1 y 8.';
      concurrency.focus();
      return;
    }
    const groupingValue = GROUPINGS.find((g) => g.value === grouping.value)?.value ?? 'none';
    importer = new BulkImporter(options.importOne, { concurrency: value, grouping: groupingValue, classify: options.classify });
    start.disabled = true;
    pick.disabled = true;
    form.querySelectorAll('input, select').forEach((el) => el.setAttribute('disabled', ''));
    bar.element.hidden = false;
    cancel.textContent = 'Detener';
    let last: BulkImportEvent<T> | null = null;
    for await (const event of importer.run(files.map((f) => ({ file: f.file, path: f.path })))) {
      last = event;
      if (event.type === 'progress') bar.set(event.overall, `${event.completed}/${event.total}`);
      else if (event.type === 'complete') logLine(`✓ ${event.name} → ${event.group}`, 'ok');
      else if (event.type === 'error') logLine(`✗ ${event.name}: ${event.error}`, 'error');
    }
    if (last?.type === 'done') {
      summary.textContent = `${last.completed} importado(s), ${last.failed} con error${last.cancelled ? ' (cancelado)' : ''}.`;
      options.onDone(last.groups, { completed: last.completed, failed: last.failed, cancelled: last.cancelled });
    }
    cancel.textContent = 'Cerrar';
    importer = null;
  };
  return dialog.closed;
}
