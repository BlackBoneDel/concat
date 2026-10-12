// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Window-wide capture of OS file drags (import bulletproofing).
 *
 * Dropping a video anywhere on the editor used to do nothing at all — or,
 * worse, made the browser navigate to the raw file and lose the session.
 * Browsers only honour a drop when `dragover`/`dragenter` were prevented
 * *before* the drop, and each element that wants to accept files has to
 * prevent them itself; anything the panels do not cover (the header, the
 * preview, the gaps between panels, the `body` itself) falls through to the
 * browser's default navigation.
 *
 * {@link installGlobalDrop} closes every one of those holes: it listens on
 * `window` **and** `document`, always prevents the browser default for drag
 * events, shows a "suelta para importar" overlay on `<html>` while an OS
 * drag is over the page, and forwards the files of the first drop it sees
 * to `onFiles`. Drops already consumed by a panel (`installFileDrop` and
 * friends mark them, see `markDropHandled`) are left alone, so the files
 * are never imported twice.
 */

import {
  dragHasFiles,
  droppedFiles,
  isDropHandled,
  markDropHandled,
  type DragEventLike,
  type FileDropHandle,
} from './timeline/file-drop.ts';

/** Something with window-style listeners (the window itself, in the app). */
export interface GlobalDragTarget {
  addEventListener(type: string, listener: (event: DragEventLike) => void): void;
  removeEventListener(type: string, listener: (event: DragEventLike) => void): void;
}

/** The `classList` slice the overlay toggle needs. */
export interface DragClassRoot {
  classList: { add(name: string): void; remove(name: string): void };
}

/** Options of {@link installGlobalDrop}. */
export interface GlobalDropOptions {
  /** Called with the files of a drop no panel consumed. */
  onFiles(files: File[], event: DragEventLike): void;
  /** Where to listen (default: `window` and `document`). Injected in tests. */
  targets?: GlobalDragTarget[];
  /** Overlay class toggled on the root element (default `window-drag-over`). */
  dragClass?: string;
  /** Element that wears the overlay class (default `<html>`); `null` disables it. */
  classRoot?: DragClassRoot | null;
  /** Cap on the files forwarded in one drop (default 500). */
  maxFiles?: number;
}

/** The overlay class shown while an OS file drag hovers the page. */
export const GLOBAL_DRAG_CLASS = 'window-drag-over';

/** The default targets of the capture. */
function defaultTargets(): GlobalDragTarget[] {
  const targets: GlobalDragTarget[] = [];
  if (typeof window !== 'undefined') targets.push(window as unknown as GlobalDragTarget);
  if (typeof document !== 'undefined') targets.push(document as unknown as GlobalDragTarget);
  return targets;
}

/** The default overlay root. */
function defaultClassRoot(): DragClassRoot | null {
  return typeof document !== 'undefined' ? document.documentElement : null;
}

/**
 * Captures OS file drops anywhere in the window.
 *
 * @param options what to do with the files and where to listen.
 * @returns a handle whose `dispose()` removes every listener.
 */
export function installGlobalDrop(options: GlobalDropOptions): FileDropHandle {
  const targets = options.targets ?? defaultTargets();
  const dragClass = options.dragClass ?? GLOBAL_DRAG_CLASS;
  const classRoot = options.classRoot === undefined ? defaultClassRoot() : options.classRoot;
  const maxFiles = options.maxFiles ?? 500;
  let depth = 0;

  const showOverlay = (): void => {
    if (depth === 0) classRoot?.classList.add(dragClass);
    depth += 1;
  };
  const hideOverlay = (): void => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) classRoot?.classList.remove(dragClass);
  };
  const clearOverlay = (): void => {
    depth = 0;
    classRoot?.classList.remove(dragClass);
  };

  const onDragEnter = (event: DragEventLike): void => {
    // Without preventDefault the browser refuses the drop (and navigates).
    event.preventDefault();
    if (dragHasFiles(event)) showOverlay();
  };
  const onDragOver = (event: DragEventLike): void => {
    event.preventDefault();
    if (!dragHasFiles(event)) return;
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    if (depth === 0) showOverlay();
  };
  const onDragLeave = (event: DragEventLike): void => {
    event.preventDefault();
    if (dragHasFiles(event)) hideOverlay();
  };
  const onDrop = (event: DragEventLike): void => {
    event.preventDefault();
    clearOverlay();
    const files = droppedFiles(event);
    if (!dragHasFiles(event) && files.length === 0) return;
    if (isDropHandled(event)) return;
    // Own the drop: the second target (window after document) must not
    // forward the same files again.
    markDropHandled(event);
    const accepted = files.slice(0, maxFiles);
    console.info('[GlobalDrop] Archivos detectados:', accepted.length, files.length > maxFiles ? `(de ${files.length})` : '');
    if (accepted.length === 0) return;
    options.onFiles(accepted, event);
  };

  const listeners: [string, (event: DragEventLike) => void][] = [
    ['dragenter', onDragEnter],
    ['dragover', onDragOver],
    ['dragleave', onDragLeave],
    ['drop', onDrop],
  ];
  for (const target of targets) {
    for (const [type, listener] of listeners) target.addEventListener(type, listener);
  }
  // A drag abandoned over another window never fires `drop`: hide the
  // overlay when the page loses the drag.
  if (typeof window !== 'undefined' && targets.includes(window as unknown as GlobalDragTarget)) {
    window.addEventListener('blur', clearOverlay);
  }

  return {
    dispose(): void {
      for (const target of targets) {
        for (const [type, listener] of listeners) target.removeEventListener(type, listener);
      }
      if (typeof window !== 'undefined' && targets.includes(window as unknown as GlobalDragTarget)) {
        window.removeEventListener('blur', clearOverlay);
      }
      clearOverlay();
    },
  };
}
