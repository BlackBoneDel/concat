// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Folder scanning for relink and bulk import.
 *
 * Uses the File System Access API (`showDirectoryPicker`, Chromium) when
 * present — the walk runs in the scanner worker (directory handles are
 * structured-cloneable) so huge trees never block the UI — and falls back
 * to `<input type="file" webkitdirectory>` everywhere else (Firefox,
 * Safari), filtering the resulting `FileList` by the same rules.
 */

import { WorkerClient } from '../../workers/worker-client.ts';
import { MEDIA_EXTENSIONS, extensionOf } from '../import/format-support.ts';

/** A file handle (subset of `FileSystemFileHandle`). */
export interface FileHandleLike {
  readonly kind: 'file';
  readonly name: string;
  getFile(): Promise<File>;
}

/** A directory handle (subset of `FileSystemDirectoryHandle`). */
export interface DirectoryHandleLike {
  readonly kind: 'directory';
  readonly name: string;
  values(): AsyncIterable<FileHandleLike | DirectoryHandleLike>;
}

/** Scan rules. */
export interface ScanOptions {
  /** Descend into sub-folders (default true). */
  recursive?: boolean;
  /** Lowercase extensions without dot (default: every media extension). */
  extensions?: readonly string[];
  /** Deepest folder level visited; the root is 0 (default 16). */
  maxDepth?: number;
  /** Skip dot-files/folders and OS clutter (default true). */
  skipHidden?: boolean;
}

/** A file found by a scan. */
export interface ScannedFile {
  file: File;
  /** Path relative to the picked folder, `/`-separated, including the root name. */
  path: string;
}

/** Progress of a scan. */
export interface ScanProgress {
  /** Entries looked at so far (inline walks only; the worker reports matches). */
  visited?: number;
  /** Files accepted so far. */
  matched: number;
}

/** Fully resolved scan rules. */
export interface ResolvedScanOptions {
  recursive: boolean;
  extensions: readonly string[];
  maxDepth: number;
  skipHidden: boolean;
}

const CLUTTER = new Set(['thumbs.db', 'desktop.ini', '$recycle.bin', 'system volume information', '__macosx']);

/**
 * Applies defaults and validates scan options.
 * @param options user options.
 * @returns resolved options.
 */
export function resolveScanOptions(options: ScanOptions = {}): ResolvedScanOptions {
  const maxDepth = options.maxDepth ?? 16;
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 64) {
    throw new RangeError('La profundidad máxima debe ser un entero entre 0 y 64');
  }
  return {
    recursive: options.recursive ?? true,
    extensions: (options.extensions ?? MEDIA_EXTENSIONS).map((ext) => ext.replace(/^\./, '').toLowerCase()),
    maxDepth,
    skipHidden: options.skipHidden ?? true,
  };
}

/**
 * Whether a name is hidden/clutter.
 * @param name file or folder name.
 * @returns true to skip.
 */
export function isHiddenName(name: string): boolean {
  return name.startsWith('.') || CLUTTER.has(name.toLowerCase());
}

/**
 * Whether a file name passes the extension filter.
 * @param name file name.
 * @param options resolved options.
 * @returns true to keep.
 */
export function acceptsFile(name: string, options: ResolvedScanOptions): boolean {
  if (options.skipHidden && isHiddenName(name)) return false;
  return options.extensions.length === 0 || options.extensions.includes(extensionOf(name));
}

/**
 * Walks a directory handle (iteratively, so deep trees cannot overflow).
 * Shared by the scanner worker and the inline path.
 * @param root the picked folder.
 * @param options resolved options.
 * @param onProgress progress sink.
 * @param signal cancellation.
 * @returns the matching files.
 */
export async function walkDirectory(
  root: DirectoryHandleLike,
  options: ResolvedScanOptions,
  onProgress?: (progress: ScanProgress) => void,
  signal?: AbortSignal,
): Promise<ScannedFile[]> {
  const out: ScannedFile[] = [];
  const stack: { dir: DirectoryHandleLike; path: string; depth: number }[] = [{ dir: root, path: root.name, depth: 0 }];
  let visited = 0;
  while (stack.length > 0) {
    if (signal?.aborted) throw new DOMException('Escaneo cancelado', 'AbortError');
    const { dir, path, depth } = stack.pop()!;
    for await (const entry of dir.values()) {
      visited += 1;
      if (entry.kind === 'directory') {
        if (!options.recursive || depth + 1 > options.maxDepth) continue;
        if (options.skipHidden && isHiddenName(entry.name)) continue;
        stack.push({ dir: entry, path: `${path}/${entry.name}`, depth: depth + 1 });
      } else if (acceptsFile(entry.name, options)) {
        out.push({ file: await entry.getFile(), path: `${path}/${entry.name}` });
      }
      if (visited % 64 === 0) onProgress?.({ visited, matched: out.length });
    }
  }
  onProgress?.({ visited, matched: out.length });
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Filters a `webkitdirectory` file list by the same rules.
 * @param files picked files (their `webkitRelativePath` gives the tree).
 * @param options scan options.
 * @returns the matching files.
 */
export function filterFileList(files: Iterable<File>, options: ScanOptions = {}): ScannedFile[] {
  const resolved = resolveScanOptions(options);
  const out: ScannedFile[] = [];
  for (const file of files) {
    const path = file.webkitRelativePath || file.name;
    const parts = path.split('/');
    const folders = parts.slice(1, -1);
    if (!resolved.recursive && folders.length > 0) continue;
    if (folders.length > resolved.maxDepth) continue;
    if (resolved.skipHidden && folders.some(isHiddenName)) continue;
    if (!acceptsFile(file.name, resolved)) continue;
    out.push({ file, path });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Directory picker of the File System Access API, when present. */
type DirectoryPicker = (options?: { mode?: 'read' | 'readwrite'; id?: string }) => Promise<DirectoryHandleLike>;

function directoryPicker(): DirectoryPicker | null {
  if (typeof window === 'undefined') return null;
  const picker: unknown = Reflect.get(window, 'showDirectoryPicker');
  return typeof picker === 'function' ? (opts) => Reflect.apply(picker, window, [opts]) as Promise<DirectoryHandleLike> : null;
}

/** Narrowing for values coming back from the worker. */
function isScannedList(value: unknown): value is ScannedFile[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'object' && item !== null && 'file' in item && 'path' in item);
}

/** Folder scanning front-end. */
export class FolderScanner {
  private readonly client: WorkerClient;

  /**
   * @param client worker client (defaults to the scanner worker).
   */
  constructor(client?: WorkerClient) {
    this.client =
      client ??
      new WorkerClient(() =>
        typeof Worker === 'undefined'
          ? null
          : new Worker(new URL('../../workers/scanner-worker.ts', import.meta.url), { type: 'module' }),
      );
  }

  /** Whether the File System Access directory picker exists. */
  static get supportsDirectoryPicker(): boolean {
    return directoryPicker() !== null;
  }

  /**
   * Asks the user for a folder and scans it.
   * @param options scan rules.
   * @param onProgress progress sink.
   * @returns the files, or `null` when the user cancelled.
   */
  async pickAndScan(options: ScanOptions = {}, onProgress?: (progress: ScanProgress) => void): Promise<ScannedFile[] | null> {
    const picker = directoryPicker();
    if (picker) {
      let handle: DirectoryHandleLike;
      try {
        handle = await picker({ mode: 'read', id: 'concat-media' });
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return null;
        throw error;
      }
      return this.scan(handle, options, onProgress);
    }
    const files = await pickDirectoryFallback();
    return files ? filterFileList(files, options) : null;
  }

  /**
   * Scans a directory handle, in the worker when possible.
   * @param handle the folder.
   * @param options scan rules.
   * @param onProgress progress sink.
   * @param signal cancellation.
   * @returns the matching files.
   */
  async scan(handle: DirectoryHandleLike, options: ScanOptions = {}, onProgress?: (progress: ScanProgress) => void, signal?: AbortSignal): Promise<ScannedFile[]> {
    const resolved = resolveScanOptions(options);
    if (this.client.available && !signal) {
      try {
        const result = await this.client.request<unknown>('scan', { handle, options: resolved }, [], (matched) => {
          onProgress?.({ matched });
        });
        if (isScannedList(result)) return result;
      } catch {
        // Handles that cannot cross into the worker scan inline.
      }
    }
    return walkDirectory(handle, resolved, onProgress, signal);
  }

  /** Stops the worker. */
  dispose(): void {
    this.client.terminate('FolderScanner cerrado');
  }
}

/**
 * `<input webkitdirectory>` fallback (Firefox/Safari).
 * @returns the picked files, or null when cancelled.
 */
export function pickDirectoryFallback(): Promise<File[] | null> {
  if (typeof document === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.webkitdirectory = true;
    input.style.display = 'none';
    const done = (files: File[] | null): void => {
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => done(input.files ? Array.from(input.files) : null), { once: true });
    input.addEventListener('cancel', () => done(null), { once: true });
    document.body.append(input);
    input.click();
  });
}
