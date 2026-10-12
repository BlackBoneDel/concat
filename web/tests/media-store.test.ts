// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** MediaStore: OPFS-mandatory import with the in-memory fallback, usage. */

import { describe, expect, it } from 'vitest';
import { MemoryKeyValue } from '../src/storage/idb.ts';
import { MediaStore } from '../src/storage/media-store.ts';
import { Rational } from '../src/core/rational.ts';
import { FrameRate } from '../src/core/time.ts';
import type { MediaInfo } from '../src/media/decoder.ts';

function info(id: string, type: 'video' | 'audio' | 'image', sizeType: string): MediaInfo {
  void sizeType;
  return {
    id,
    type,
    duration: Rational.fromInt(3n),
    width: 1280,
    height: 720,
    fps: FrameRate.THIRTY,
    videoCodec: 'avc1.42c01e',
    audioCodec: '',
    audioSampleRate: 48000,
    audioChannels: 2,
    fileSize: 1024,
    container: 'mp4',
  };
}

function makeStore(): MediaStore {
  return new MediaStore(new MemoryKeyValue());
}

describe('MediaStore', () => {
  it('imports a file and lists it', async () => {
    const store = makeStore();
    const blob = new Blob(['fake-bytes'], { type: 'video/mp4' });
    const record = await store.importFile(blob, info('m1', 'video', 'video'), 'm1', 'clip.mp4');
    expect(record.id).toBe('m1');
    expect(record.path).toBe('media/m1');
    expect(record.name).toBe('clip.mp4');
    expect(record.type).toBe('video');
    expect(record.fileSize).toBe(10); // 'fake-bytes'

    const listed = await store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).toBe('m1');
    const got = await store.get('m1');
    expect(got?.name).toBe('clip.mp4');
  });

  it('reads the bytes back (session fallback when OPFS is absent)', async () => {
    const store = makeStore();
    const blob = new Blob(['hello-media']);
    await store.importFile(blob, info('m1', 'video', 'x'), 'm1', 'clip.mp4');
    const read = await store.readFile('m1');
    expect(read).not.toBeNull();
    expect(await read!.text()).toBe('hello-media');
    // Unknown ids read as null.
    expect(await store.readFile('ghost')).toBeNull();
  });

  it('deletes files and records', async () => {
    const store = makeStore();
    await store.importFile(new Blob(['a']), info('m1', 'video', 'x'), 'm1', 'a.mp4');
    await store.importFile(new Blob(['b']), info('m2', 'audio', 'x'), 'm2', 'b.wav');
    await store.deleteFile('m1');
    expect((await store.list()).map((record) => record.id)).toEqual(['m2']);
    expect(await store.readFile('m1')).toBeNull();
  });

  it('clears the whole library', async () => {
    const store = makeStore();
    await store.importFile(new Blob(['a']), info('m1', 'video', 'x'), 'm1', 'a.mp4');
    await store.importFile(new Blob(['b']), info('m2', 'image', 'x'), 'm2', 'b.png');
    await store.clearAll();
    expect(await store.list()).toHaveLength(0);
  });

  it('reports storage usage, with and without the project backend', async () => {
    const store = makeStore();
    await store.importFile(new Blob(['1234567890']), info('m1', 'video', 'x'), 'm1', 'a.mp4');
    await store.importFile(new Blob(['12345']), info('m2', 'video', 'x'), 'm2', 'b.mp4');

    const usage = await store.getStorageUsage();
    expect(usage.mediaCount).toBe(2);
    expect(usage.mediaBytes).toBe(15); // 10 + 5 bytes
    expect(usage.projectCount).toBe(0);

    const projects = new MemoryKeyValue();
    await projects.put('projects', 'p1', { id: 'p1' });
    const withProjects = await store.getStorageUsage(projects);
    expect(withProjects.projectCount).toBe(1);
  });

  it('reports whether OPFS is present', async () => {
    const store = makeStore();
    // Node has no OPFS — the fallback path is exactly what this exercises.
    expect(await store.hasOpfs()).toBe(false);
    // The answer is memoized.
    expect(await store.hasOpfs()).toBe(false);
  });

  it('tolerates deleting and reading missing ids', async () => {
    const store = makeStore();
    await store.deleteFile('ghost');
    expect(await store.readFile('ghost')).toBeNull();
    expect(await store.get('ghost')).toBeUndefined();
    expect(await store.list()).toHaveLength(0);
    // Double delete is a no-op.
    await store.importFile(new Blob(['x']), info('m1', 'video', 'x'), 'm1', 'x.mp4');
    await store.deleteFile('m1');
    await store.deleteFile('m1');
    expect(await store.readFile('m1')).toBeNull();
    // clearAll on an empty library is a no-op too.
    await store.clearAll();
    await store.clearAll();
    expect(await store.list()).toHaveLength(0);
  });
});
