// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Folder scanning: FS Access walks (worker + inline) and the input fallback. */

import { describe, expect, it } from 'vitest';
import {
  FolderScanner,
  filterFileList,
  isHiddenName,
  resolveScanOptions,
  walkDirectory,
  type DirectoryHandleLike,
  type FileHandleLike,
} from '../src/media/relink/folder-scanner.ts';
import { createScannerHandlers } from '../src/media/relink/scanner-handlers.ts';
import { WorkerClient } from '../src/workers/worker-client.ts';
import { linkedWorker } from './f4-helpers.ts';

type Tree = { [name: string]: Tree | string };

function fileHandle(name: string, body: string): FileHandleLike {
  return { kind: 'file', name, getFile: async () => new File([body], name) };
}

function dirHandle(name: string, tree: Tree): DirectoryHandleLike {
  return {
    kind: 'directory',
    name,
    async *values() {
      for (const [child, value] of Object.entries(tree)) {
        yield typeof value === 'string' ? fileHandle(child, value) : dirHandle(child, value);
      }
    },
  };
}

const TREE = dirHandle('Proyecto', {
  'a.mp4': 'a',
  'notas.txt': 'x',
  '.oculto.mp4': 'h',
  'Thumbs.db': 't',
  Audio: { 'voz.WAV': 'v', Extra: { 'deep.mov': 'd', Deeper: { 'z.mkv': 'z' } } },
  '.git': { 'obj.mp4': 'g' },
});

describe('walkDirectory', () => {
  it('walks recursively with extension and hidden filters', async () => {
    const progress: number[] = [];
    const files = await walkDirectory(TREE, resolveScanOptions(), (p) => progress.push(p.matched));
    expect(files.map((f) => f.path)).toEqual([
      'Proyecto/a.mp4',
      'Proyecto/Audio/Extra/deep.mov',
      'Proyecto/Audio/Extra/Deeper/z.mkv',
      'Proyecto/Audio/voz.WAV',
    ].sort((a, b) => a.localeCompare(b)));
    expect(progress[progress.length - 1]).toBe(4);
  });

  it('honours recursive, maxDepth, extensions and skipHidden', async () => {
    const flat = await walkDirectory(TREE, resolveScanOptions({ recursive: false }));
    expect(flat.map((f) => f.file.name)).toEqual(['a.mp4']);
    const shallow = await walkDirectory(TREE, resolveScanOptions({ maxDepth: 1 }));
    expect(shallow.map((f) => f.file.name).sort()).toEqual(['a.mp4', 'voz.WAV']);
    const onlyMov = await walkDirectory(TREE, resolveScanOptions({ extensions: ['.MOV'] }));
    expect(onlyMov.map((f) => f.file.name)).toEqual(['deep.mov']);
    const all = await walkDirectory(TREE, resolveScanOptions({ skipHidden: false, extensions: [] }));
    expect(all.map((f) => f.file.name)).toEqual(expect.arrayContaining(['.oculto.mp4', 'obj.mp4', 'notas.txt', 'Thumbs.db']));
    expect(() => resolveScanOptions({ maxDepth: -1 })).toThrow(/profundidad/);
    expect(isHiddenName('desktop.ini')).toBe(true);
    expect(isHiddenName('clip.mp4')).toBe(false);
  });

  it('can be cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(walkDirectory(TREE, resolveScanOptions(), undefined, controller.signal)).rejects.toThrow(/cancelado/);
  });
});

describe('filterFileList (webkitdirectory fallback)', () => {
  it('applies the same rules to relative paths', () => {
    const make = (path: string): File => {
      const file = new File(['x'], path.split('/').pop()!);
      Object.defineProperty(file, 'webkitRelativePath', { value: path });
      return file;
    };
    const files = [make('P/a.mp4'), make('P/sub/b.mov'), make('P/.cache/c.mp4'), make('P/sub/deeper/d.mp4'), make('P/x.txt')];
    expect(filterFileList(files).map((f) => f.path)).toEqual(['P/a.mp4', 'P/sub/b.mov', 'P/sub/deeper/d.mp4']);
    expect(filterFileList(files, { recursive: false }).map((f) => f.path)).toEqual(['P/a.mp4']);
    expect(filterFileList(files, { maxDepth: 1 }).map((f) => f.path)).toEqual(['P/a.mp4', 'P/sub/b.mov']);
    expect(filterFileList([new File(['x'], 'suelto.mp4')]).map((f) => f.path)).toEqual(['suelto.mp4']);
  });
});

describe('FolderScanner', () => {
  it('scans in the scanner worker', async () => {
    const { worker } = linkedWorker(createScannerHandlers());
    const scanner = new FolderScanner(new WorkerClient(() => worker));
    const files = await scanner.scan(TREE, { extensions: ['mp4'] });
    expect(files.map((f) => f.path)).toEqual(['Proyecto/a.mp4']);
    expect(await files[0]!.file.text()).toBe('a');
    scanner.dispose();
  });

  it('scans inline without workers, and rejects non-folders in the worker', async () => {
    const scanner = new FolderScanner(new WorkerClient(() => null));
    const visited: (number | undefined)[] = [];
    const files = await scanner.scan(TREE, {}, (p) => visited.push(p.visited));
    expect(files).toHaveLength(4);
    expect(visited[visited.length - 1]).toBeGreaterThan(4);
    const { worker } = linkedWorker(createScannerHandlers());
    const client = new WorkerClient(() => worker);
    await expect(client.request('scan', { handle: { kind: 'file' } })).rejects.toThrow(/carpeta/);
    client.terminate();
    expect(FolderScanner.supportsDirectoryPicker).toBe(false);
    expect(await scanner.pickAndScan()).toBeNull();
  });
});
