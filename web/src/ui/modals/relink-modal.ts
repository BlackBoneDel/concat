// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Relink dialog: lists offline media, scans a folder for candidates,
 * pre-selects automatic matches (score > 0.8) and lets the user pick or
 * browse for the rest. Applying hands the assignments back to the app,
 * which copies the bytes into OPFS and runs one undoable relink edit.
 */

import type { FolderScanner, ScannedFile } from '../../media/relink/folder-scanner.ts';
import type { MissingMedia, RelinkAssignment, RelinkCandidate, Relinker } from '../../media/relink/relinker.ts';
import { Dialog, progressBar } from './dialog.ts';

/** Options of {@link openRelinkModal}. */
export interface RelinkModalOptions {
  missing: readonly MissingMedia[];
  relinker: Relinker;
  scanner: FolderScanner;
  /** Applies the chosen relinks. */
  apply(assignments: RelinkAssignment[]): Promise<void>;
  /** Error sink. */
  onError(error: unknown): void;
}

interface Row {
  missing: MissingMedia;
  candidates: RelinkCandidate[];
  choice: { file: File; path: string; score: number } | null;
  element: HTMLElement;
}

/**
 * Opens the dialog.
 * @param options offline media and services.
 * @returns resolves with the number of relinked items when closed.
 */
export function openRelinkModal(options: RelinkModalOptions): Promise<number> {
  const dialog = new Dialog({
    title: 'Medios sin conexión',
    description: options.missing.length === 0
      ? 'Todos los medios están disponibles.'
      : `${options.missing.length} medio(s) no se encuentran en el almacenamiento local. Busca en una carpeta o elige los archivos.`,
    className: 'relink-modal',
  });
  let relinked = 0;
  const abort = new AbortController();
  dialog.onClose(() => abort.abort());
  const bar = progressBar('Progreso de búsqueda');
  bar.element.hidden = true;
  const status = document.createElement('p');
  status.className = 'fx-note';
  status.setAttribute('aria-live', 'polite');
  const table = document.createElement('div');
  table.className = 'relink-list';
  table.setAttribute('role', 'list');
  dialog.body.append(bar.element, status, table);

  const rows: Row[] = options.missing.map((missing) => {
    const element = document.createElement('div');
    element.className = 'relink-row';
    element.setAttribute('role', 'listitem');
    return { missing, candidates: [], choice: null, element };
  });

  const renderRow = (row: Row): void => {
    row.element.replaceChildren();
    const name = document.createElement('div');
    name.className = 'relink-name';
    name.textContent = row.missing.item.name || row.missing.item.path;
    const meta = document.createElement('div');
    meta.className = 'relink-meta';
    const item = row.missing.item;
    meta.textContent = [
      item.duration ? `${item.duration.toFixed(2)} s` : '',
      item.width && item.height ? `${item.width}×${item.height}` : '',
      `${row.missing.usedBy} clip(s)`,
    ].filter(Boolean).join(' · ');
    const pick = document.createElement('select');
    pick.className = 'input';
    pick.setAttribute('aria-label', `Archivo para ${name.textContent}`);
    const none = document.createElement('option');
    none.value = '';
    none.textContent = row.candidates.length === 0 ? 'Sin candidatos' : 'No vincular';
    pick.appendChild(none);
    row.candidates.forEach((c, i) => {
      const option = document.createElement('option');
      option.value = String(i);
      option.textContent = `${c.path} — ${Math.round(c.score * 100)}%${c.hashMatch ? ' (hash idéntico)' : ''}`;
      pick.appendChild(option);
    });
    const chosenIndex = row.choice ? row.candidates.findIndex((c) => c.file === row.choice?.file) : -1;
    if (row.choice && chosenIndex < 0) {
      const manual = document.createElement('option');
      manual.value = 'manual';
      manual.textContent = `${row.choice.path} (manual)`;
      pick.appendChild(manual);
      pick.value = 'manual';
    } else {
      pick.value = chosenIndex >= 0 ? String(chosenIndex) : '';
    }
    pick.addEventListener('change', () => {
      const c = row.candidates[Number(pick.value)];
      row.choice = pick.value === '' || !c ? null : { file: c.file, path: c.path, score: c.score };
      updateApply();
    });
    const browse = document.createElement('button');
    browse.type = 'button';
    browse.className = 'btn btn-ghost btn-small';
    browse.textContent = 'Elegir…';
    browse.setAttribute('aria-label', `Elegir archivo para ${name.textContent}`);
    browse.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.addEventListener('change', () => {
        const file = input.files?.[0];
        if (!file) return;
        void options.relinker.scoreCandidate(row.missing.item, { file, path: file.name }).then((scored) => {
          row.choice = { file, path: file.name, score: scored.score };
          renderRow(row);
          updateApply();
        });
      });
      input.click();
    });
    const badge = document.createElement('span');
    badge.className = `relink-badge${row.choice && row.choice.score > options.relinker.autoThreshold ? ' auto' : ''}`;
    badge.textContent = row.choice ? (row.choice.score > options.relinker.autoThreshold ? 'Automático' : 'Manual') : 'Sin conexión';
    row.element.append(name, meta, pick, browse, badge);
  };

  const scan = async (): Promise<void> => {
    scanButton.disabled = true;
    bar.element.hidden = false;
    bar.set(0, 'Buscando archivos…');
    try {
      const files: ScannedFile[] | null = await options.scanner.pickAndScan({}, (p) => {
        status.textContent = `${p.matched} archivo(s) encontrados…`;
      });
      if (!files || abort.signal.aborted) return;
      status.textContent = `${files.length} archivo(s) encontrados. Comparando…`;
      const result = await options.relinker.match(rows.map((r) => r.missing), files, (done, total) => bar.set(done / total, `${done}/${total}`));
      if (abort.signal.aborted) return;
      for (const row of rows) {
        const auto = result.auto.find((a) => a.mediaId === row.missing.item.id);
        const manual = result.manual.find((m) => m.missing.item.id === row.missing.item.id);
        row.candidates = manual?.candidates ?? (auto ? [{ file: auto.file, path: auto.path, score: auto.score, breakdown: { name: 1, duration: 1, resolution: 1, hash: null }, hashMatch: false }] : []);
        row.choice = auto ? { file: auto.file, path: auto.path, score: auto.score } : row.choice;
        renderRow(row);
      }
      status.textContent = `${result.auto.length} coincidencia(s) automática(s), ${result.manual.length} por revisar.`;
      updateApply();
    } catch (error) {
      options.onError(error);
    } finally {
      bar.element.hidden = true;
      scanButton.disabled = false;
    }
  };

  const scanButton = dialog.addButton('Buscar en carpeta…', () => void scan());
  dialog.addButton('Cerrar', () => dialog.close());
  const applyButton = dialog.addButton('Aplicar', () => {
    const assignments = rows.flatMap((row) => (row.choice ? [{ mediaId: row.missing.item.id, file: row.choice.file, path: row.choice.path, score: row.choice.score }] : []));
    applyButton.disabled = true;
    void options.apply(assignments).then(() => {
      relinked = assignments.length;
      dialog.close();
    }).catch((error: unknown) => {
      applyButton.disabled = false;
      options.onError(error);
    });
  }, 'primary');
  const updateApply = (): void => {
    applyButton.disabled = !rows.some((row) => row.choice !== null);
  };
  rows.forEach((row) => {
    renderRow(row);
    table.appendChild(row.element);
  });
  updateApply();
  return dialog.closed.then(() => relinked);
}
