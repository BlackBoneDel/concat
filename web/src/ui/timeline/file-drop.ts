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

import { wasDropHandled } from '../dnd/drop-handled.ts';

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
    // A more specific zone (the timeline's media drop, an embedded widget)
    // may have claimed this event already.
    if (wasDropHandled(event)) return;
    event.preventDefault();
    event.stopPropagation();
    depth = 0;
    target.classList.remove(activeClass);
    const list = event.dataTransfer?.files;
    if (!list || list.length === 0) return;
    const files: File[] = [];
    for (let i = 0; i < list.length; i += 1) {
      const file = list[i];
      if (file) files.push(file);
    }
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
    // Handled elsewhere: never re-process (and never re-navigate) a drop the
    // timeline already consumed.
    if (wasDropHandled(event)) return;
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
