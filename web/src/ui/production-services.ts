// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Fase 6 services for the UI (export, shortcuts, storage manager, project
 * package, PWA install), installed once by `main.ts`. Like
 * {@link getStudioServices}, kept apart from `AppContext` so earlier panels
 * and tests compile unchanged; readers degrade gracefully when absent.
 */

/** What the Fase 6 UI calls. */
export interface ProductionServices {
  /** Opens the export dialog (no-op without clips). */
  openExport(): void;
  /** Whether the timeline has something to export. */
  canExport(): boolean;
  /** Opens the searchable shortcuts sheet. */
  openShortcuts(): void;
  /** Opens the storage manager. */
  openStorageManager(): void;
  /** Opens the project package (export/import ZIP) dialog. */
  openProjectPackage(): void;
  /** Whether the browser offered to install the app. */
  canInstall(): boolean;
  /** Shows the browser's install prompt. */
  install(): void;
}

let services: ProductionServices | null = null;

/**
 * Installs (or clears) the services.
 * @param value the services, or `null`.
 */
export function setProductionServices(value: ProductionServices | null): void {
  services = value;
}

/** The installed services, if any. */
export function getProductionServices(): ProductionServices | null {
  return services;
}
