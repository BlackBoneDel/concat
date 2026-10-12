// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Fase 7+: OS file-drop capture for the timeline.
 *
 * Dropping a video onto the timeline used to do nothing — worse, a drop
 * slightly outside a panel made the browser navigate away from the app and
 * open the raw file. `installFileDrop` turns the timeline into a real drop
 * target (import on drop, hover feedback while dragging) and
 * `installDropGuard` neutralizes every other corner of the window.
 */

/** A drag event with the parts the capture uses. */
export interface DragEventLike {
  dataTransfer?: { files?: ArrayLike<File>; types?: ArrayLike<string>; dropEffect?: string } | null;
  clientX?: number;
  clientY?: number;
  preventDefault(): void;
  stopPropagation(): void;
}

/** What a drop target needs from its host (an `HTMLElement` qualifies). */
export interface DropTargetLike {
  classList: { add(name: string): void; remove(name: string): void };
  getBoundingClientRect(): { left: number; top: number };
  addEventListener(type: string, listener: (event: DragEventLike) => void): void;
  removeEventListener(type: string, listener: (event: DragEventLike) => void): void;
}

/** Options of {@link installFileDrop}. */
export interface FileDropOptions {
  /** Called with the dropped files and the point, relative to the target. */
  onFiles(files: File[], point: { x: number; y: number }): void;
  /** Class toggled while a file drag hovers (default `drag-over`). */
  activeClass?: string;
}

/** A disposable pair of installed listeners. */
export interface FileDropHandle {
  dispose(): void;
}

/** Whether a drag carries OS files (and not an internal clip drag). */
export function dragHasFiles(event: DragEventLike): boolean {
  const types = event.dataTransfer?.types;
  if (!types) return false;
  for (let i = 0; i < types.length; i += 1) {
    if (types[i] === 'Files') return true;
  }
  return false;
}

/**
 * The files of a drop, as a plain array (`DataTransfer.files` is a live
 * `FileList`, empty for internal drags).
 * @param event a (possibly synthetic) drag event.
 * @returns the dropped files (never `null`).
 */
export function droppedFiles(event: DragEventLike): File[] {
  const list = event.dataTransfer?.files;
  if (!list) return [];
  const files: File[] = [];
  for (let i = 0; i < list.length; i += 1) {
    const file = list[i];
    if (file) files.push(file);
  }
  return files;
}

/** The non-enumerable flag {@link markDropHandled} puts on a drop event. */
const HANDLED = '__concatDropHandled';

/**
 * Marks a drop as already imported by the zone that received it, so the
 * window-wide capture (which hears the same event when the zone does not
 * stop propagation) never imports the same files twice.
 * @param event the drop event a drop zone consumed.
 */
export function markDropHandled(event: DragEventLike): void {
  try {
    Object.defineProperty(event, HANDLED, { value: true, configurable: true, enumerable: false });
  } catch {
    // Frozen event objects (some WebViews): the marker is a best-effort guard.
  }
}

/** Whether {@link markDropHandled} already ran for this drop event. */
export function isDropHandled(event: DragEventLike): boolean {
  return (event as unknown as Record<string, unknown>)[HANDLED] === true;
}

/**
 * Makes `target` accept OS file drops.
 * @param target the drop zone (the timeline panel in the app).
 * @param options what to do with the files.
 * @returns a handle whose `dispose()` removes every listener.
 */
export function installFileDrop(target: DropTargetLike, options: FileDropOptions): FileDropHandle {
  const activeClass = options.activeClass ?? 'drag-over';
  let depth = 0;

  const onDragEnter = (event: DragEventLike): void => {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    depth += 1;
    target.classList.add(activeClass);
  };
  const onDragOver = (event: DragEventLike): void => {
    if (!dragHasFiles(event)) return;
    // Without preventDefault the drop is refused and the browser navigates.
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  };
  const onDragLeave = (): void => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) target.classList.remove(activeClass);
  };
  const onDrop = (event: DragEventLike): void => {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    // The window-wide capture hears this same drop when a browser ignores
    // `stopPropagation` (or the event was dispatched synthetically): the
    // marker keeps the files from being imported a second time.
    markDropHandled(event);
    depth = 0;
    target.classList.remove(activeClass);
    const files = droppedFiles(event);
    if (files.length === 0) return;
    const rect = target.getBoundingClientRect();
    options.onFiles(files, {
      x: (event.clientX ?? 0) - rect.left,
      y: (event.clientY ?? 0) - rect.top,
    });
  };

  target.addEventListener('dragenter', onDragEnter);
  target.addEventListener('dragover', onDragOver);
  target.addEventListener('dragleave', onDragLeave);
  target.addEventListener('drop', onDrop);
  return {
    dispose(): void {
      target.removeEventListener('dragenter', onDragEnter);
      target.removeEventListener('dragover', onDragOver);
      target.removeEventListener('dragleave', onDragLeave);
      target.removeEventListener('drop', onDrop);
    },
  };
}

/** Something with window-style listeners (the window itself, in the app). */
export interface DropGuardTarget {
  addEventListener(type: string, listener: (event: DragEventLike) => void): void;
  removeEventListener(type: string, listener: (event: DragEventLike) => void): void;
}

/**
 * Stops the browser's default "open the dropped file" navigation for drops
 * that land outside any drop zone.
 * @param target the window (injectable for tests).
 * @returns a handle whose `dispose()` removes the listeners.
 */
export function installDropGuard(
  target: DropGuardTarget = globalThis as unknown as DropGuardTarget,
): FileDropHandle {
  const block = (event: DragEventLike): void => {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
  };
  target.addEventListener('dragover', block);
  target.addEventListener('drop', block);
  return {
    dispose(): void {
      target.removeEventListener('dragover', block);
      target.removeEventListener('drop', block);
    },
  };
}
