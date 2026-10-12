// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Bulk import: events, bounded concurrency, grouping, errors, cancel. */

import { describe, expect, it } from 'vitest';
import { BulkImporter, checkConcurrency, groupLabel, type BulkImportEvent, type ImportSource } from '../src/media/import/bulk-importer.ts';

interface Imported {
  name: string;
  width: number;
  height: number;
  kind: string;
}

const file = (name: string): File => new File(['x'], name);
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function collect<T>(gen: AsyncGenerator<BulkImportEvent<T>>): Promise<BulkImportEvent<T>[]> {
  const out: BulkImportEvent<T>[] = [];
  for await (const event of gen) out.push(event);
  return out;
}

describe('BulkImporter', () => {
  it('streams start → progress/complete → done and respects concurrency', async () => {
    let active = 0;
    let peak = 0;
    const importer = new BulkImporter<Imported>(async (source, _signal, progress) => {
      active += 1;
      peak = Math.max(peak, active);
      progress(0.5);
      await delay(5);
      active -= 1;
      return { name: source.file.name, width: 1920, height: 1080, kind: 'video' };
    }, { concurrency: 2 });
    const names = ['a.mp4', 'b.mp4', 'c.mp4', 'd.mp4', 'e.mp4'];
    const events = await collect(importer.run(names.map(file)));
    expect(events[0]).toEqual({ type: 'start', total: 5, concurrency: 2 });
    const last = events[events.length - 1]!;
    expect(last.type).toBe('done');
    if (last.type === 'done') {
      expect([last.completed, last.failed, last.cancelled]).toEqual([5, 0, false]);
      expect(last.groups.get('Todos')).toHaveLength(5);
    }
    expect(peak).toBe(2);
    const completes = events.filter((e) => e.type === 'complete');
    expect(completes.map((e) => (e.type === 'complete' ? e.name : '')).sort()).toEqual(names);
    const progress = events.flatMap((e) => (e.type === 'progress' ? [e.overall] : []));
    for (let i = 1; i < progress.length; i += 1) expect(progress[i]!).toBeGreaterThanOrEqual(progress[i - 1]!);
    expect(progress[progress.length - 1]).toBe(1);
    expect(importer.running).toBe(false);
  });

  it('reports failures and unsupported files without stopping', async () => {
    const importer = new BulkImporter<string>(async (source) => {
      if (source.file.name.startsWith('roto')) throw new Error('archivo dañado');
      return source.file.name;
    }, { concurrency: 1 });
    const events = await collect(importer.run([file('ok.mp4'), file('roto.mov'), file('nota.txt'), file('bien.wav')]));
    const errors = events.flatMap((e) => (e.type === 'error' ? [[e.name, e.error]] : []));
    expect(errors).toEqual([['roto.mov', 'archivo dañado'], ['nota.txt', 'Formato no compatible']]);
    const done = events[events.length - 1]!;
    expect(done.type === 'done' && [done.completed, done.failed]).toEqual([2, 2]);
    const lenient = new BulkImporter<string>(async (s) => s.file.name, { acceptUnknown: true });
    const out = await collect(lenient.run([file('nota.txt')]));
    expect(out.some((e) => e.type === 'complete')).toBe(true);
  });

  it('groups by type, resolution and folder', async () => {
    const sources: ImportSource[] = [
      { file: file('a.mp4'), path: 'Rodaje/Día1/a.mp4' },
      { file: file('b.wav'), path: 'Rodaje/Audio/b.wav' },
      { file: file('c.png'), path: 'c.png' },
    ];
    const run = async (grouping: 'byType' | 'byResolution' | 'byFolder'): Promise<string[]> => {
      const importer = new BulkImporter<Imported>(async (s) => ({
        name: s.file.name,
        width: s.file.name.endsWith('.wav') ? 0 : 1280,
        height: s.file.name.endsWith('.wav') ? 0 : 720,
        kind: s.file.name.endsWith('.wav') ? 'audio' : s.file.name.endsWith('.png') ? 'image' : 'video',
      }), { grouping, classify: (r) => ({ kind: r.kind, width: r.width, height: r.height }) });
      const events = await collect(importer.run(sources));
      const done = events[events.length - 1]!;
      return done.type === 'done' ? [...done.groups.keys()].sort() : [];
    };
    expect(await run('byType')).toEqual(['Audio', 'Imágenes', 'Vídeo']);
    expect(await run('byResolution')).toEqual(['1280×720', 'Audio']);
    expect(await run('byFolder')).toEqual(['Raíz', 'Rodaje/Audio', 'Rodaje/Día1']);
    expect(groupLabel('byResolution', { file: file('x.png') })).toBe('Sin resolución');
    expect(groupLabel('byType', { file: file('x.srt') })).toBe('Subtítulos');
  });

  it('cancels: queued files are skipped and in-flight ones see the signal', async () => {
    const aborted: string[] = [];
    let started = 0;
    const importer = new BulkImporter<string>((source, signal) => {
      started += 1;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(source.file.name), 50);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          aborted.push(source.file.name);
          reject(new DOMException('cancelado', 'AbortError'));
        });
      });
    }, { concurrency: 2 });
    const events: BulkImportEvent<string>[] = [];
    for await (const event of importer.run(['1.mp4', '2.mp4', '3.mp4', '4.mp4'].map(file))) {
      events.push(event);
      if (event.type === 'start') setTimeout(() => importer.cancel(), 5);
    }
    const done = events[events.length - 1]!;
    expect(done.type === 'done' && done.cancelled).toBe(true);
    expect(started).toBe(2);
    expect(aborted.sort()).toEqual(['1.mp4', '2.mp4']);
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('breaking out of the loop stops the batch; one run at a time; validates concurrency', async () => {
    let started = 0;
    const importer = new BulkImporter<string>(async (s) => {
      started += 1;
      await delay(5);
      return s.file.name;
    }, { concurrency: 1 });
    for await (const event of importer.run(['1.mp4', '2.mp4', '3.mp4'].map(file))) {
      if (event.type === 'complete') break;
    }
    await delay(20);
    expect(started).toBeLessThanOrEqual(2);
    expect(importer.running).toBe(false);
    const gen = importer.run([file('a.mp4')]);
    await gen.next();
    await expect(importer.run([file('b.mp4')]).next()).rejects.toThrow(/en curso/);
    await gen.return(undefined);
    expect(() => checkConcurrency(0)).toThrow(/entre 1 y 8/);
    expect(() => new BulkImporter(async () => 1, { concurrency: 9 })).toThrow(RangeError);
    const empty = await collect(new BulkImporter(async () => 1).run([]));
    expect(empty.map((e) => e.type)).toEqual(['start', 'done']);
  });
});
