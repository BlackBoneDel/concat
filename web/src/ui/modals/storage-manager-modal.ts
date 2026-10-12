// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Fase 6: the storage manager. Shows the browser quota
 * (`navigator.storage.estimate`), what each local store holds (OPFS media,
 * proxies, fonts; IndexedDB waveforms and projects) and lets the user free
 * space. Regenerable caches (proxies, waveforms) ask once; anything that
 * loses data (orphaned originals, everything) asks twice.
 */

import { Dialog, formatBytes, progressBar } from './dialog.ts';

/** One line of the breakdown. */
export interface StorageCategory {
  id: 'media' | 'proxies' | 'fonts' | 'waveforms' | 'projects';
  label: string;
  bytes: number;
  count: number;
}

/** Data and actions of the dialog. */
export interface StorageManagerSource {
  estimate(): Promise<{ usage: number; quota: number } | null>;
  breakdown(): Promise<StorageCategory[]>;
  persisted(): Promise<boolean>;
  requestPersist(): Promise<boolean>;
  clearProxies(): Promise<void>;
  clearWaveforms(): Promise<void>;
  /** Removes stored originals no project references; resolves to the files removed. */
  clearOrphans(): Promise<number>;
  /** Wipes every local store (projects, media, caches, settings). */
  clearAll(): Promise<void>;
  confirm(title: string, message: string, confirmLabel: string): Promise<boolean>;
  notify(kind: 'success' | 'error' | 'info' | 'warning', title: string, message: string): void;
}

/**
 * Asks once, or twice for data-losing actions.
 * @param source the confirm provider.
 * @param title first question.
 * @param message first message.
 * @param label confirm label.
 * @param second the second question, for a double confirmation.
 * @returns whether every confirmation was accepted.
 */
export async function confirmSteps(
  source: Pick<StorageManagerSource, 'confirm'>,
  title: string,
  message: string,
  label: string,
  second?: { title: string; message: string; label: string },
): Promise<boolean> {
  if (!(await source.confirm(title, message, label))) return false;
  if (!second) return true;
  return source.confirm(second.title, second.message, second.label);
}

/**
 * Opens the manager.
 * @param source data and actions.
 * @returns the dialog.
 */
export function openStorageManagerModal(source: StorageManagerSource): Dialog {
  const dialog = new Dialog({
    title: 'Almacenamiento local',
    description: 'Todo se guarda en este navegador (OPFS e IndexedDB). Nada se sube a ningún servidor.',
    className: 'storage-modal',
  });
  const quota = progressBar('Espacio usado');
  const quotaText = document.createElement('p');
  quotaText.className = 'fx-note';
  const persistLine = document.createElement('p');
  persistLine.className = 'fx-note';
  const table = document.createElement('table');
  table.className = 'storage-table';
  const caption = document.createElement('caption');
  caption.className = 'sr-only';
  caption.textContent = 'Uso por categoría';
  const body = document.createElement('tbody');
  table.append(caption, body);
  const status = document.createElement('p');
  status.className = 'sr-only';
  status.setAttribute('aria-live', 'polite');
  const actions = document.createElement('div');
  actions.className = 'storage-actions';
  dialog.body.append(quota.element, quotaText, persistLine, table, actions, status);

  let busy = false;
  const buttons: HTMLButtonElement[] = [];
  const action = (label: string, variant: 'ghost' | 'danger', run: () => Promise<void>): void => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `btn btn-${variant}`;
    button.textContent = label;
    button.addEventListener('click', () => {
      if (busy) return;
      busy = true;
      for (const b of buttons) b.disabled = true;
      void run()
        .catch((error: unknown) => source.notify('error', 'Almacenamiento', error instanceof Error ? error.message : String(error)))
        .finally(() => {
          busy = false;
          for (const b of buttons) b.disabled = false;
          void refresh();
        });
    });
    buttons.push(button);
    actions.appendChild(button);
  };

  const refresh = async (): Promise<void> => {
    const [estimate, categories, persisted] = await Promise.all([
      source.estimate().catch(() => null),
      source.breakdown().catch(() => []),
      source.persisted().catch(() => false),
    ]);
    if (!dialog.isOpen) return;
    if (estimate && estimate.quota > 0) {
      quota.set(estimate.usage / estimate.quota, `${formatBytes(estimate.usage)} de ${formatBytes(estimate.quota)}`);
      quotaText.textContent = `${formatBytes(estimate.usage)} usados de ${formatBytes(estimate.quota)} disponibles (${Math.round((estimate.usage / estimate.quota) * 100)} %).`;
    } else {
      quota.set(0, 'No disponible');
      quotaText.textContent = 'El navegador no informa de la cuota.';
    }
    persistLine.textContent = persisted
      ? 'Almacenamiento persistente: el navegador no borrará estos datos por falta de espacio.'
      : 'Almacenamiento no persistente: el navegador podría liberar estos datos si se queda sin espacio.';
    body.replaceChildren();
    for (const category of categories) {
      const tr = document.createElement('tr');
      const name = document.createElement('th');
      name.scope = 'row';
      name.textContent = category.label;
      const count = document.createElement('td');
      count.textContent = `${category.count} ${category.count === 1 ? 'elemento' : 'elementos'}`;
      const size = document.createElement('td');
      size.textContent = formatBytes(category.bytes);
      tr.append(name, count, size);
      body.appendChild(tr);
    }
    status.textContent = estimate ? `Uso actualizado: ${formatBytes(estimate.usage)}` : 'Uso actualizado';
  };

  action('Hacer persistente', 'ghost', async () => {
    const ok = await source.requestPersist();
    source.notify(ok ? 'success' : 'info', 'Almacenamiento', ok ? 'El navegador conservará los datos.' : 'El navegador no concedió el almacenamiento persistente.');
  });
  action('Borrar proxies', 'ghost', async () => {
    if (!(await confirmSteps(source, '¿Borrar los proxies?', 'Se pueden volver a generar; la exportación siempre usa los originales.', 'Borrar proxies'))) return;
    await source.clearProxies();
    source.notify('success', 'Proxies borrados', 'Espacio liberado.');
  });
  action('Borrar formas de onda', 'ghost', async () => {
    if (!(await confirmSteps(source, '¿Borrar las formas de onda?', 'Se regenerarán al volver a importar o abrir los medios.', 'Borrar'))) return;
    await source.clearWaveforms();
    source.notify('success', 'Formas de onda borradas', 'Espacio liberado.');
  });
  action('Borrar medios huérfanos', 'danger', async () => {
    const ok = await confirmSteps(
      source,
      '¿Borrar medios huérfanos?',
      'Se eliminarán los originales que no usa ningún proyecto guardado ni el proyecto abierto.',
      'Continuar',
      { title: 'Confirmación final', message: 'Los archivos borrados no se pueden recuperar. ¿Borrar definitivamente?', label: 'Borrar definitivamente' },
    );
    if (!ok) return;
    const removed = await source.clearOrphans();
    source.notify('success', 'Medios huérfanos', removed === 0 ? 'No había medios huérfanos.' : `${removed} archivos eliminados.`);
  });
  action('Borrar todo', 'danger', async () => {
    const ok = await confirmSteps(
      source,
      '¿Borrar TODOS los datos locales?',
      'Se eliminarán proyectos, medios, proxies, fuentes, presets y ajustes de este navegador.',
      'Continuar',
      { title: 'Esta acción es irreversible', message: 'Exporta antes un paquete de proyecto si quieres conservar algo. ¿Borrar todo definitivamente?', label: 'Borrar todo' },
    );
    if (!ok) return;
    await source.clearAll();
    source.notify('success', 'Datos borrados', 'El almacenamiento local está vacío.');
  });
  dialog.addButton('Cerrar', () => dialog.close(), 'primary');
  void refresh();
  return dialog;
}
