// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Handlers of the scanner worker, importable by tests (served inline
 * through `linkedWorker`) and by `workers/scanner-worker.ts`.
 *
 * - `scan` `{ handle, options }` → `ScannedFile[]`, progress = files matched so far.
 * - `hash` `{ blob }` → hex SHA-256, progress 0..1 throttled to 500 ms.
 */

import type { WorkerHandler } from '../../workers/worker-client.ts';
import { type DirectoryHandleLike, type ResolvedScanOptions, resolveScanOptions, walkDirectory } from './folder-scanner.ts';
import { computeSHA256Inline } from './hash-validator.ts';

function isDirectoryHandle(value: unknown): value is DirectoryHandleLike {
  return typeof value === 'object' && value !== null && Reflect.get(value, 'kind') === 'directory' && typeof Reflect.get(value, 'values') === 'function';
}

function readOptions(value: unknown): ResolvedScanOptions {
  if (typeof value !== 'object' || value === null) return resolveScanOptions();
  const pick = (key: string): unknown => Reflect.get(value, key);
  const extensions = pick('extensions');
  return resolveScanOptions({
    recursive: typeof pick('recursive') === 'boolean' ? Boolean(pick('recursive')) : undefined,
    extensions: Array.isArray(extensions) ? extensions.filter((e): e is string => typeof e === 'string') : undefined,
    maxDepth: typeof pick('maxDepth') === 'number' ? Number(pick('maxDepth')) : undefined,
    skipHidden: typeof pick('skipHidden') === 'boolean' ? Boolean(pick('skipHidden')) : undefined,
  });
}

/**
 * Builds the handler table.
 * @param now clock (tests).
 * @returns handlers for `serveWorker`.
 */
export function createScannerHandlers(now: () => number = () => Date.now()): Record<string, WorkerHandler> {
  return {
    scan: async (payload, tools) => {
      const handle = typeof payload === 'object' && payload !== null ? Reflect.get(payload, 'handle') : null;
      if (!isDirectoryHandle(handle)) throw new Error('Se esperaba una carpeta');
      const options = readOptions(Reflect.get(payload as object, 'options'));
      let last = 0;
      return walkDirectory(handle, options, (progress) => {
        const t = now();
        if (t - last >= 500) {
          last = t;
          tools.progress(progress.matched);
        }
      });
    },
    hash: async (payload, tools) => {
      const blob = typeof payload === 'object' && payload !== null ? Reflect.get(payload, 'blob') : null;
      if (!(blob instanceof Blob)) throw new Error('Se esperaba un archivo');
      let last = -Infinity;
      return computeSHA256Inline(blob, (p) => {
        const t = now();
        if (t - last >= 500 || p >= 1) {
          last = t;
          tools.progress(p);
        }
      });
    },
  };
}
