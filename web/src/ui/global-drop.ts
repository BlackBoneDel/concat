// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The last line of defence of the import: a window/document-wide drop zone.
 *
 * Wherever the user lets go of an OS file — the header, the preview, an empty
 * patch of the workspace, outside a panel, on the body — the file is imported
 * into the library. The rules:
 *
 * 1. `dragenter`/`dragover`/`dragleave`/`drop` are captured on **both**
 *    `window` and `document`, `preventDefault()`ed and `stopPropagation()`ed,
 *    so the browser never navigates away to open the raw file (the old
 *    "se me fue la sesión" bug) and no ancestor sees the gesture twice.
 * 2. `dragover` sets `dataTransfer.dropEffect = 'copy'`: the cursor must say
 *    "you are importing something", not "nothing will happen".
 * 3. A drop is processed exactly once: the more specific zones (the timeline,
 *    the library grid, an image field) claim their events through
 *    {@link markDropHandled} and this installer skips them. Internal media
 *    drags (`application/x-concat-media`) never carry `Files`, so they are
 *    ignored here.
 * 4. While a file drag hovers, an overlay says what will happen.
 */

import { markDropHandled, wasDropHandled } from './dnd/drop-handled.ts';

/** The overlay's id (also its CSS hook). */
export const GLOBAL_DROP_OVERLAY_ID = 'concat-drop-overlay';

/** The overlay's copy, verbatim from the import protocol. */
export const GLOBAL_DROP_MESSAGE = 'Suelta los archivos para importar…';

/** The slice of a drag event this module needs (structural: jsdom-friendly). */
export interface GlobalDragEvent {
  dataTransfer?: { files?: ArrayLike<File> | null; types?: ArrayLike<string> | null; dropEffect?: string } | null;
  clientX?: number;
  clientY?: number;
  target?: unknown;
  relatedTarget?: unknown;
  preventDefault(): void;
  stopPropagation(): void;
}

/** Something with window-style listeners (`window`, `document`, a double). */
export interface GlobalDropTarget {
  addEventListener(type: string, listener: (event: GlobalDragEvent) => void): void;
  removeEventListener(type: string, listener: (event: GlobalDragEvent) => void): void;
}

/** Options of {@link installGlobalDrop}. */
export interface GlobalDropOptions {
  /** Every OS file the user let go of, anywhere. */
  onFiles(files: File[], point: { x: number; y: number }): void;
  /** Draw the "Suelta los archivos…" overlay (default `true`). */
  overlay?: boolean;
  /** Mounting point of the overlay (default `document.body`). */
  overlayHost?: HTMLElement | null;
  /** The two capture targets (default `window` and `document`). */
  windowTarget?: GlobalDropTarget;
  documentTarget?: GlobalDropTarget;
}

/** A disposable installer. */
export interface GlobalDropHandle {
  /** The overlay element, or `null` when the overlay is off. */
  readonly overlay: HTMLElement | null;
  dispose(): void;
}

/** Whether a drag carries OS files (never an internal clip/media drag). */
export function dragCarriesFiles(event: GlobalDragEvent): boolean {
  const transfer = event.dataTransfer;
  if (!transfer) return false;
  const files = transfer.files;
  if (files && files.length > 0) return true;
  const types = transfer.types;
  if (!types) return false;
  for (let index = 0; index < types.length; index += 1) {
    if (types[index] === 'Files') return true;
  }
  return false;
}

/** The dropped files, as a plain array (never a live `FileList`). */
export function filesOf(event: GlobalDragEvent): File[] {
  const list = event.dataTransfer?.files;
  if (!list) return [];
  const files: File[] = [];
  for (let index = 0; index < list.length; index += 1) {
    const file = list[index];
    if (file) files.push(file);
  }
  return files;
}

/**
 * Installs the window/document-wide capture.
 * @param options where the files go and where the overlay mounts.
 * @returns a handle whose `dispose()` removes every listener and the overlay.
 */
export function installGlobalDrop(options: GlobalDropOptions): GlobalDropHandle {
  const doc = typeof document !== 'undefined' ? document : null;
  const win: GlobalDropTarget | null =
    options.windowTarget ?? (typeof window !== 'undefined' ? (window as unknown as GlobalDropTarget) : null);
  const docTarget: GlobalDropTarget | null =
    options.documentTarget ?? (doc as unknown as GlobalDropTarget | null);
  /** Events this installer already consumed at the document level. */
  const mine = new WeakSet<object>();

  const overlay = options.overlay === false ? null : createOverlay(options.overlayHost ?? doc?.body ?? null);
  const show = (): void => overlay?.classList.add('is-visible');
  const hide = (): void => overlay?.classList.remove('is-visible');

  /** True when a more specific zone already owns this event. */
  const claimed = (event: GlobalDragEvent): boolean => wasDropHandled(event) || mine.has(event);

  const handlers = {
    dragenter: (event: GlobalDragEvent): void => {
      if (!dragCarriesFiles(event) || claimed(event)) return;
      event.preventDefault();
      event.stopPropagation();
      show();
    },
    dragover: (event: GlobalDragEvent): void => {
      if (!dragCarriesFiles(event) || claimed(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      show();
    },
    dragleave: (event: GlobalDragEvent): void => {
      // A `dragleave` that still has a related target is an internal move.
      if (event.relatedTarget || claimed(event)) return;
      hide();
    },
    dragend: (): void => {
      hide();
    },
    drop: (event: GlobalDragEvent): void => {
      hide();
      if (!dragCarriesFiles(event) || claimed(event)) return;
      event.preventDefault();
      event.stopPropagation();
      mine.add(event);
      markDropHandled(event);
      const files = filesOf(event);
      if (files.length === 0) return;
      console.info(`[GlobalDrop] ${files.length} files`);
      options.onFiles(files, { x: event.clientX ?? 0, y: event.clientY ?? 0 });
    },
  } as const;

  const targets = [docTarget, win].filter((target): target is GlobalDropTarget => target !== null && target !== undefined);
  for (const target of targets) {
    for (const [type, handler] of Object.entries(handlers)) {
      target.addEventListener(type, handler as (event: GlobalDragEvent) => void);
    }
  }

  return {
    overlay,
    dispose(): void {
      for (const target of targets) {
        for (const [type, handler] of Object.entries(handlers)) {
          target.removeEventListener(type, handler as (event: GlobalDragEvent) => void);
        }
      }
      overlay?.remove();
      if (overlay === installedOverlay) installedOverlay = null;
    },
  };
}

/** The overlay of the live install (tests assert it exists once). */
let installedOverlay: HTMLElement | null = null;

/** The live overlay, if one is installed. */
export function dropOverlay(): HTMLElement | null {
  if (installedOverlay?.isConnected) return installedOverlay;
  return typeof document === 'undefined' ? null : document.getElementById(GLOBAL_DROP_OVERLAY_ID);
}

/** Builds the overlay (or reuses the one already in the document). */
function createOverlay(host: HTMLElement | null): HTMLElement | null {
  if (!host) return null;
  const existing = host.querySelector<HTMLElement>(`#${GLOBAL_DROP_OVERLAY_ID}`);
  if (existing) {
    installedOverlay = existing;
    return existing;
  }
  const element = host.ownerDocument.createElement('div');
  element.id = GLOBAL_DROP_OVERLAY_ID;
  element.className = 'concat-drop-overlay';
  element.setAttribute('role', 'presentation');
  const label = host.ownerDocument.createElement('div');
  label.className = 'concat-drop-overlay-label';
  label.textContent = GLOBAL_DROP_MESSAGE;
  element.appendChild(label);
  host.appendChild(element);
  installedOverlay = element;
  return element;
}
