// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Fase 6: export / import a portable project package (ZIP with the project,
 * its media, fonts and LUTs, checksummed). Built and read entirely in the
 * browser (`storage/project-package.ts`).
 */

import { buildProjectPackage, PACKAGE_EXTENSION, readProjectPackage, type OpenedPackage, type PackageAssetSource } from '../../storage/project-package.ts';
import type { DocumentSettings, ProjectDocument } from '../../model/document.ts';
import { Dialog, formatBytes, progressBar } from './dialog.ts';
import { downloadBlob } from '../download.ts';

/** What the dialog needs from the app. */
export interface ProjectPackageHost {
  getDocument(): ProjectDocument;
  settings(): DocumentSettings;
  assets: PackageAssetSource;
  /** Installs an opened package (media into OPFS, fonts, LUTs, then the document). */
  install(opened: OpenedPackage): Promise<void>;
  confirm(title: string, message: string, confirmLabel: string): Promise<boolean>;
  notify(kind: 'success' | 'error' | 'info' | 'warning', title: string, message: string): void;
}

/**
 * A safe download name for a package.
 * @param projectName the project name.
 * @returns e.g. `Mi proyecto.concatpkg.zip`.
 */
export function packageFileName(projectName: string): string {
  const base = projectName.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'proyecto';
  return `${base.slice(0, 100)}${PACKAGE_EXTENSION}`;
}

/**
 * Opens the dialog.
 * @param host app services.
 * @returns the dialog.
 */
export function openProjectPackageModal(host: ProjectPackageHost): Dialog {
  const dialog = new Dialog({
    title: 'Paquete de proyecto',
    description: 'Un único archivo .zip con el proyecto, sus medios, fuentes y LUTs, para moverlo a otro equipo o hacer copia de seguridad.',
    className: 'package-modal',
  });
  const includeMedia = document.createElement('label');
  includeMedia.className = 'field-row field-row-check';
  const includeInput = document.createElement('input');
  includeInput.type = 'checkbox';
  includeInput.checked = true;
  includeMedia.append(includeInput, Object.assign(document.createElement('span'), { textContent: 'Incluir los medios originales' }));
  const bar = progressBar('Progreso del paquete');
  bar.element.hidden = true;
  const status = document.createElement('p');
  status.className = 'fx-note';
  status.setAttribute('aria-live', 'polite');
  dialog.body.append(includeMedia, bar.element, status);

  let abort: AbortController | null = null;
  dialog.onClose(() => abort?.abort());
  const buttons: HTMLButtonElement[] = [];
  const setBusy = (busy: boolean): void => {
    for (const button of buttons) button.disabled = busy;
    includeInput.disabled = busy;
    bar.element.hidden = !busy;
  };

  const exportPackage = async (): Promise<void> => {
    abort = new AbortController();
    setBusy(true);
    try {
      const settings = host.settings();
      const built = await buildProjectPackage(host.getDocument(), settings, host.assets, {
        includeMedia: includeInput.checked,
        signal: abort.signal,
        onProgress: (ratio, label) => {
          bar.set(ratio, `${Math.round(ratio * 100)} %`);
          status.textContent = `Empaquetando ${label}…`;
        },
      });
      if (!dialog.isOpen) return;
      downloadBlob(built.blob, packageFileName(settings.name));
      status.textContent = `Paquete listo: ${formatBytes(built.blob.size)}, ${built.manifest.entries.length} archivos.`;
      if (built.missing.length > 0) {
        host.notify('warning', 'Paquete incompleto', `No se encontraron: ${built.missing.slice(0, 5).join(', ')}${built.missing.length > 5 ? '…' : ''}`);
      } else {
        host.notify('success', 'Paquete exportado', packageFileName(settings.name));
      }
    } catch (error) {
      if (dialog.isOpen) {
        status.textContent = '';
        host.notify('error', 'No se pudo crear el paquete', error instanceof Error ? error.message : String(error));
      }
    } finally {
      abort = null;
      if (dialog.isOpen) setBusy(false);
    }
  };

  const importPackage = async (file: File): Promise<void> => {
    abort = new AbortController();
    setBusy(true);
    status.textContent = 'Verificando el paquete…';
    try {
      const opened = await readProjectPackage(file, { signal: abort.signal });
      if (!dialog.isOpen) return;
      const problems = opened.problems.length > 0 ? `\n\nAvisos: ${opened.problems.slice(0, 4).join('; ')}` : '';
      const ok = await host.confirm(
        `¿Abrir «${opened.name}»?`,
        `Se importarán ${opened.media.size} medios, ${opened.fonts.size} fuentes y ${opened.luts.size} LUTs, y el proyecto actual se cerrará (guárdalo antes si tiene cambios).${problems}`,
        'Abrir paquete',
      );
      if (!ok) {
        status.textContent = '';
        return;
      }
      status.textContent = 'Importando medios…';
      await host.install(opened);
      host.notify(opened.problems.length > 0 ? 'warning' : 'success', 'Paquete abierto', opened.problems.length > 0 ? `${opened.name} — con ${opened.problems.length} avisos de integridad.` : opened.name);
      dialog.close();
    } catch (error) {
      if (dialog.isOpen) {
        status.textContent = '';
        host.notify('error', 'No se pudo abrir el paquete', error instanceof Error ? error.message : String(error));
      }
    } finally {
      abort = null;
      if (dialog.isOpen) setBusy(false);
    }
  };

  buttons.push(
    dialog.addButton('Importar paquete…', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.zip,application/zip';
      input.addEventListener('change', () => {
        const file = input.files?.[0];
        if (file) void importPackage(file);
      });
      input.click();
    }),
    dialog.addButton('Exportar paquete', () => void exportPackage(), 'primary'),
  );
  dialog.addButton('Cerrar', () => dialog.close());
  return dialog;
}
