// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Bulk import: many files, bounded concurrency, streamed as events.
 *
 * `run()` is an async generator so the UI consumes progress with a plain
 * `for await` loop (and a `break` cancels the rest). Each file goes through
 * the injected `importOne` (in the app: probe → OPFS copy → bin entry →
 * proxy policy); failures become `error` events and never stop the batch.
 *
 * Events: `start` → (`progress` | `complete` | `error`)* → `done`.
 */

import { kindByExtension } from './format-support.ts';

/** How finished imports are grouped (bin folders). */
export type ImportGrouping = 'none' | 'byType' | 'byResolution' | 'byFolder';

/** A file to import, with its folder path when it came from a scan. */
export interface ImportSource {
  file: File;
  /** `/`-separated path including the file name (optional). */
  path?: string;
}

/** What the grouping needs to know about an imported item. */
export interface ImportClassification {
  kind?: string;
  width?: number;
  height?: number;
}

/** Options of {@link BulkImporter}. */
export interface BulkImportOptions<T> {
  /** Parallel imports, 1–8 (default 3). */
  concurrency?: number;
  grouping?: ImportGrouping;
  /** Reads kind/resolution off a result (for `byType`/`byResolution`). */
  classify?: (result: T) => ImportClassification;
  /** Try files with unknown extensions too (default false: reported as errors). */
  acceptUnknown?: boolean;
}

/** Streamed events. */
export type BulkImportEvent<T> =
  | { type: 'start'; total: number; concurrency: number }
  | { type: 'progress'; index: number; name: string; fileProgress: number; completed: number; total: number; overall: number }
  | { type: 'complete'; index: number; name: string; result: T; group: string }
  | { type: 'error'; index: number; name: string; error: string }
  | { type: 'done'; completed: number; failed: number; cancelled: boolean; groups: Map<string, T[]> };

/** One file's import. */
export type ImportOne<T> = (source: ImportSource, signal: AbortSignal, onProgress: (fraction: number) => void) => Promise<T>;

const TYPE_LABELS: Readonly<Record<string, string>> = {
  video: 'Vídeo', audio: 'Audio', image: 'Imágenes', subtitle: 'Subtítulos', lut: 'LUTs', other: 'Otros',
};

/**
 * The group label of an imported item.
 * @param grouping the rule.
 * @param source where it came from.
 * @param info its classification.
 * @returns the label.
 */
export function groupLabel(grouping: ImportGrouping, source: ImportSource, info: ImportClassification = {}): string {
  switch (grouping) {
    case 'none':
      return 'Todos';
    case 'byType':
      return TYPE_LABELS[info.kind ?? kindByExtension(source.file.name)] ?? 'Otros';
    case 'byResolution':
      return info.width && info.height ? `${info.width}×${info.height}` : (info.kind ?? kindByExtension(source.file.name)) === 'audio' ? 'Audio' : 'Sin resolución';
    case 'byFolder': {
      const path = source.path ?? source.file.webkitRelativePath ?? '';
      const slash = path.lastIndexOf('/');
      return slash > 0 ? path.slice(0, slash) : 'Raíz';
    }
  }
}

/**
 * Validates a concurrency value.
 * @param value requested parallelism.
 * @returns the value.
 * @throws RangeError outside 1–8.
 */
export function checkConcurrency(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 8) throw new RangeError('La concurrencia debe ser un entero entre 1 y 8');
  return value;
}

/** Imports many files with bounded concurrency. */
export class BulkImporter<T> {
  private readonly importOne: ImportOne<T>;
  private readonly concurrency: number;
  private readonly grouping: ImportGrouping;
  private readonly classify: ((result: T) => ImportClassification) | null;
  private readonly acceptUnknown: boolean;
  private controller: AbortController | null = null;

  /**
   * @param importOne imports one file.
   * @param options concurrency, grouping, classification.
   */
  constructor(importOne: ImportOne<T>, options: BulkImportOptions<T> = {}) {
    this.importOne = importOne;
    this.concurrency = checkConcurrency(options.concurrency ?? 3);
    this.grouping = options.grouping ?? 'none';
    this.classify = options.classify ?? null;
    this.acceptUnknown = options.acceptUnknown ?? false;
  }

  /** Whether a run is in progress. */
  get running(): boolean {
    return this.controller !== null;
  }

  /** Cancels the current run: queued files are skipped, in-flight ones aborted. */
  cancel(): void {
    this.controller?.abort();
  }

  /**
   * Runs an import.
   * @param input files or sources.
   * @yields start/progress/complete/error/done events.
   */
  async *run(input: Iterable<File | ImportSource>): AsyncGenerator<BulkImportEvent<T>, void, undefined> {
    if (this.controller) throw new Error('Ya hay una importación en curso');
    const sources = Array.from(input, (item) => (item instanceof File ? { file: item } : item));
    const controller = new AbortController();
    this.controller = controller;
    const total = sources.length;
    const queue: BulkImportEvent<T>[] = [];
    let wake: (() => void) | null = null;
    const emit = (event: BulkImportEvent<T>): void => {
      queue.push(event);
      wake?.();
      wake = null;
    };
    const partial = new Float64Array(total);
    let completed = 0;
    let failed = 0;
    let next = 0;
    const groups = new Map<string, T[]>();
    const overall = (): number => (total === 0 ? 1 : partial.reduce((s, v) => s + v, 0) / total);

    const lane = async (): Promise<void> => {
      while (!controller.signal.aborted && next < total) {
        const index = next;
        next += 1;
        const source = sources[index]!;
        const name = source.file.name;
        if (!this.acceptUnknown && kindByExtension(name) === 'other') {
          failed += 1;
          partial[index] = 1;
          emit({ type: 'error', index, name, error: 'Formato no compatible' });
          continue;
        }
        const report = (fraction: number): void => {
          const clamped = Math.min(1, Math.max(0, fraction));
          if (controller.signal.aborted || clamped <= partial[index]!) return;
          partial[index] = clamped;
          emit({ type: 'progress', index, name, fileProgress: clamped, completed, total, overall: overall() });
        };
        report(0.0001);
        try {
          const result = await this.importOne(source, controller.signal, report);
          if (controller.signal.aborted) break;
          completed += 1;
          partial[index] = 1;
          const group = groupLabel(this.grouping, source, this.classify?.(result));
          const list = groups.get(group) ?? [];
          list.push(result);
          groups.set(group, list);
          emit({ type: 'progress', index, name, fileProgress: 1, completed, total, overall: overall() });
          emit({ type: 'complete', index, name, result, group });
        } catch (error) {
          if (controller.signal.aborted) break;
          failed += 1;
          partial[index] = 1;
          emit({ type: 'error', index, name, error: error instanceof Error ? error.message : String(error) });
        }
      }
    };

    let finished = false;
    const lanes = Promise.all(Array.from({ length: Math.min(this.concurrency, Math.max(1, total)) }, () => lane())).then(() => {
      finished = true;
      wake?.();
      wake = null;
    });

    try {
      yield { type: 'start', total, concurrency: this.concurrency };
      while (true) {
        while (queue.length > 0) yield queue.shift()!;
        if (finished) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
          if (queue.length > 0 || finished) resolve();
        });
      }
      await lanes;
      while (queue.length > 0) yield queue.shift()!;
      yield { type: 'done', completed, failed, cancelled: controller.signal.aborted, groups };
    } finally {
      // A consumer `break` lands here too: stop the remaining work.
      if (!finished) controller.abort();
      this.controller = null;
    }
  }
}
