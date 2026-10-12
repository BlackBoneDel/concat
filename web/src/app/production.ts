// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Fase 6 wiring: export, shortcut sheet, storage manager, project package,
 * in/out marks and the PWA (service worker + install prompt). `main.ts`
 * supplies a {@link ProductionHost}; this module turns it into the UI's
 * {@link ProductionServices}. Every dialog — and the whole `src/export/`
 * pipeline — is loaded on demand, so none of it weighs on startup.
 */

import type { Rational } from '../core/rational.ts';
import type { ExportMediaSource } from '../export/export-controller.ts';
import type { FFmpegExecutor } from '../export/ffmpeg-mux-fallback.ts';
import type { InstallPrompt } from '../pwa/install-prompt.ts';
import type { DocumentSettings, ProjectDocument } from '../model/document.ts';
import type { OpenedPackage, PackageAssetSource } from '../storage/project-package.ts';
import type { StorageManagerSource } from '../ui/modals/storage-manager-modal.ts';
import type { ProductionServices } from '../ui/production-services.ts';

/** What the app provides. */
export interface ProductionHost {
  getDocument(): ProjectDocument;
  documentSettings(): DocumentSettings;
  projectName(): string;
  timelineSeconds(): number;
  clipCount(): number;
  /** The in/out range when at least one mark is set. */
  markedRange(): { start: Rational; end: Rational } | null;
  sequence(): { width: number; height: number; fps: number };
  media: ExportMediaSource;
  /** The FFmpeg.wasm runner (Fase 4), or `null` when unusable. */
  ffmpeg(): FFmpegExecutor | null;
  assets: PackageAssetSource;
  installPackage(opened: OpenedPackage): Promise<void>;
  storage: Omit<StorageManagerSource, 'confirm' | 'notify'>;
  install: InstallPrompt;
  notify(kind: 'success' | 'error' | 'info' | 'warning', title: string, message: string): void;
  confirm(title: string, message: string, confirmLabel: string): Promise<boolean>;
  /** Called before an export starts (pause playback, …). */
  beforeExport?(): void;
}

/**
 * Whether this browser can encode video with WebCodecs.
 * @returns `true` when `VideoEncoder` exists.
 */
export function hasWebCodecsEncoder(): boolean {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
}

/**
 * Builds the services.
 * @param host the app.
 * @returns the services (install with `setProductionServices`).
 */
export function createProductionServices(host: ProductionHost): ProductionServices {
  let exportOpen = false;
  const fail = (title: string) => (error: unknown): void => {
    console.error(title, error);
    host.notify('error', title, error instanceof Error ? error.message : String(error));
  };

  return {
    canExport: () => host.clipCount() > 0,
    openExport(): void {
      if (exportOpen) return;
      if (host.clipCount() === 0) {
        host.notify('info', 'Nada que exportar', 'Añade clips a la línea de tiempo antes de exportar.');
        return;
      }
      exportOpen = true;
      host.beforeExport?.();
      void Promise.all([import('../ui/modals/export-modal.ts'), import('../export/export-controller.ts')])
        .then(([{ openExportModal }, { ExportController }]) =>
          openExportModal({
            createController: () =>
              new ExportController({
                getDocument: () => host.getDocument(),
                media: host.media,
                getRange: () => host.markedRange(),
                getFFmpeg: () => host.ffmpeg(),
              }),
            projectName: () => host.projectName(),
            timelineSeconds: () => host.timelineSeconds(),
            markedRange: () => host.markedRange(),
            sequence: () => host.sequence(),
            webCodecs: hasWebCodecsEncoder(),
            ffmpeg: host.ffmpeg() !== null,
            notify: (kind, title, message) => host.notify(kind, title, message),
            confirm: (title, message, label) => host.confirm(title, message, label),
          }),
        )
        .catch(fail('Exportación'))
        .finally(() => {
          exportOpen = false;
        });
    },
    openShortcuts(): void {
      if (document.querySelector('.shortcuts-modal')) return;
      void import('../ui/modals/shortcuts-modal.ts')
        .then(({ openShortcutsModal }) => openShortcutsModal())
        .catch(fail('Atajos'));
    },
    openStorageManager(): void {
      void import('../ui/modals/storage-manager-modal.ts')
        .then(({ openStorageManagerModal }) =>
          openStorageManagerModal({
            ...host.storage,
            confirm: (title, message, label) => host.confirm(title, message, label),
            notify: (kind, title, message) => host.notify(kind, title, message),
          }),
        )
        .catch(fail('Almacenamiento'));
    },
    openProjectPackage(): void {
      void import('../ui/modals/project-package-modal.ts')
        .then(({ openProjectPackageModal }) =>
          openProjectPackageModal({
            getDocument: () => host.getDocument(),
            settings: () => host.documentSettings(),
            assets: host.assets,
            install: (opened) => host.installPackage(opened),
            confirm: (title, message, label) => host.confirm(title, message, label),
            notify: (kind, title, message) => host.notify(kind, title, message),
          }),
        )
        .catch(fail('Paquete de proyecto'));
    },
    canInstall: () => host.install.canInstall,
    install(): void {
      void host.install
        .prompt()
        .then((outcome) => {
          if (outcome === 'accepted') host.notify('success', 'Concat instalado', 'Ábrelo desde tu escritorio o menú de aplicaciones; funciona sin conexión.');
        })
        .catch(fail('Instalación'));
    },
  };
}
