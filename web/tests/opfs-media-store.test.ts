// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** MediaStore over a fake OPFS: the write-through path, end to end. */

import { afterEach, describe, expect, it } from 'vitest';
import { MemoryKeyValue } from '../src/storage/idb.ts';
import { MediaStore } from '../src/storage/media-store.ts';
import { Rational } from '../src/core/rational.ts';
import { FrameRate } from '../src/core/time.ts';
import type { MediaInfo } from '../src/media/decoder.ts';

/** An OPFS directory/file double, installed on `navigator.storage`. */
function installFakeOpfs(): {
  files: Map<string, { blob: Blob; writes: number }>;
  removed: string[];
  restore: () => void;
} {
  const files = new Map<string, { blob: Blob; writes: number }>();
  const removed: string[] = [];

  const makeFileHandle = (id: string) => ({
    createWritable: async () => ({
      chunks: [] as BlobPart[],
      write: async (data: BlobPart) => {
        const entry = files.get(id) ?? { blob: new Blob([]), writes: 0 };
        entry.blob = new Blob([data]);
        entry.writes += 1;
        files.set(id, entry);
      },
      close: async () => undefined,
    }),
    getFile: async () => {
      const entry = files.get(id);
      if (!entry) throw new Error('not found');
      return entry.blob;
    },
  });

  const mediaDirectory = {
    getFileHandle: async (id: string) => makeFileHandle(id),
    removeEntry: async (id: string) => {
      removed.push(id);
      files.delete(id);
    },
  };

  const root = {
    getDirectoryHandle: async (name: string) => {
      if (name !== 'media') throw new Error(`no dir ${name}`);
      return mediaDirectory;
    },
  };

  const storage = { getDirectory: async () => root };
  const navigatorObject = globalThis.navigator;
  const hadStorage = 'storage' in navigatorObject;
  Object.defineProperty(navigatorObject, 'storage', { value: storage, configurable: true });
  return {
    files,
    removed,
    restore: () => {
      if (hadStorage) {
        Object.defineProperty(navigatorObject, 'storage', { value: undefined, configurable: true });
      } else {
        Reflect.deleteProperty(navigatorObject, 'storage');
      }
    },
  };
}

function info(id: string): MediaInfo {
  return {
    id,
    type: 'video',
    duration: Rational.fromInt(2n),
    width: 1920,
    height: 1080,
    fps: FrameRate.THIRTY,
    videoCodec: 'avc1.640028',
    audioCodec: '',
    audioSampleRate: 0,
    audioChannels: 0,
    fileSize: 2048,
    container: 'mp4',
  };
}

describe('MediaStore with OPFS', () => {
  afterEach(() => {
    // Nothing to restore per test — each installs its own double.
  });

  it('writes through OPFS and reports it present', async () => {
    const fake = installFakeOpfs();
    try {
      const store = new MediaStore(new MemoryKeyValue());
      expect(await store.hasOpfs()).toBe(true);
      const record = await store.importFile(new Blob(['stored-bytes']), info('m1'), 'm1', 'clip.mp4');
      expect(record.path).toBe('media/m1');
      expect(fake.files.has('m1')).toBe(true);
      expect(await fake.files.get('m1')!.blob.text()).toBe('stored-bytes');

      const read = await store.readFile('m1');
      expect(read).not.toBeNull();
      expect(await read!.text()).toBe('stored-bytes');
    } finally {
      fake.restore();
    }
  });

  it('deletes the OPFS file with the record', async () => {
    const fake = installFakeOpfs();
    try {
      const store = new MediaStore(new MemoryKeyValue());
      await store.importFile(new Blob(['x']), info('m1'), 'm1', 'x.mp4');
      await store.deleteFile('m1');
      expect(fake.removed).toContain('m1');
      expect(fake.files.has('m1')).toBe(false);
      // Reading a vanished OPFS file falls back to the session mirror (empty).
      expect(await store.readFile('m1')).toBeNull();
    } finally {
      fake.restore();
    }
  });

  it('counts usage against the OPFS-backed library', async () => {
    const fake = installFakeOpfs();
    try {
      const store = new MediaStore(new MemoryKeyValue());
      await store.importFile(new Blob(['abc']), info('m1'), 'm1', 'a.mp4');
      await store.importFile(new Blob(['defg']), info('m2'), 'm2', 'b.mp4');
      const usage = await store.getStorageUsage();
      expect(usage.mediaCount).toBe(2);
      expect(usage.mediaBytes).toBe(7); // real bytes: 'abc' + 'defg'
    } finally {
      fake.restore();
    }
  });

  it('falls back to memory when OPFS writes fail', async () => {
    const storage = {
      getDirectory: async () => {
        throw new Error('private mode');
      },
    };
    const navigatorObject = globalThis.navigator;
    Object.defineProperty(navigatorObject, 'storage', { value: storage, configurable: true });
    try {
      const store = new MediaStore(new MemoryKeyValue());
      expect(await store.hasOpfs()).toBe(false);
      const record = await store.importFile(new Blob(['bytes']), info('m1'), 'm1', 'clip.mp4');
      expect(record.id).toBe('m1');
      // The bytes live on in the session mirror.
      const read = await store.readFile('m1');
      expect(await read!.text()).toBe('bytes');
    } finally {
      Reflect.deleteProperty(navigatorObject, 'storage');
    }
  });
});

// -- Fase 7+: fallback OPFS en Safari 17 (sin createWritable) --------------

/**
 * A Safari 17 OPFS double: the root and the handles exist, `getFile` works,
 * but `createWritable` is worker-only and simply absent on the main thread.
 */
function installSafari17Opfs(options: { createWritableThrows?: boolean } = {}): {
  writes: number;
  restore: () => void;
} {
  let writes = 0;
  const makeFileHandle = (id: string) => {
    const handle: Record<string, unknown> = {
      getFile: async () => {
        throw new Error(`never written: ${id}`);
      },
    };
    if (options.createWritableThrows) {
      handle.createWritable = async () => {
        throw new Error('QuotaExceededError');
      };
    }
    // Without the option the handle has NO createWritable at all (Safari 17).
    return handle;
  };
  const mediaDirectory = {
    getFileHandle: async (id: string) => makeFileHandle(id),
    removeEntry: async () => {
      writes += 1;
    },
  };
  const root = { getDirectoryHandle: async (name: string) => (name === 'media' ? mediaDirectory : null) };
  const storage = { getDirectory: async () => root };
  const navigatorObject = globalThis.navigator;
  Object.defineProperty(navigatorObject, 'storage', { value: storage, configurable: true });
  return {
    get writes() {
      return writes;
    },
    restore: () => Reflect.deleteProperty(navigatorObject, 'storage'),
  };
}

describe('MediaStore on Safari 17 (OPFS without createWritable)', () => {
  it('imports through the session mirror instead of throwing a TypeError', async () => {
    const safari = installSafari17Opfs();
    try {
      const store = new MediaStore(new MemoryKeyValue());
      const record = await store.importFile(new Blob(['safari-bytes']), info('s1'), 's1', 'obs.webm');
      expect(record.id).toBe('s1');
      expect(record.path).toBe('media/s1');
      const read = await store.readFile('s1');
      expect(read).not.toBeNull();
      expect(await read!.text()).toBe('safari-bytes');
    } finally {
      safari.restore();
    }
  });

  it('reports the degraded mode through hasOpfs after the failed write', async () => {
    const safari = installSafari17Opfs();
    try {
      const store = new MediaStore(new MemoryKeyValue());
      expect(await store.hasOpfs()).toBe(true); // the root does exist…
      await store.importFile(new Blob(['x']), info('s1'), 's1', 'x.mp4');
      expect(await store.hasOpfs()).toBe(false); // …but writes do not: the UI warns
    } finally {
      safari.restore();
    }
  });

  it('a throwing createWritable (quota) also degrades to memory', async () => {
    const safari = installSafari17Opfs({ createWritableThrows: true });
    try {
      const store = new MediaStore(new MemoryKeyValue());
      const record = await store.importFile(new Blob(['quota-bytes']), info('q1'), 'q1', 'q.mp4');
      expect(record.id).toBe('q1');
      expect(await (await store.readFile('q1'))!.text()).toBe('quota-bytes');
    } finally {
      safari.restore();
    }
  });

  it('keeps serving later imports from the mirror once degraded', async () => {
    const safari = installSafari17Opfs();
    try {
      const store = new MediaStore(new MemoryKeyValue());
      await store.importFile(new Blob(['one']), info('d1'), 'd1', 'one.mp4');
      await store.importFile(new Blob(['two']), info('d2'), 'd2', 'two.mp4');
      expect(await (await store.readFile('d1'))!.text()).toBe('one');
      expect(await (await store.readFile('d2'))!.text()).toBe('two');
      expect((await store.list()).map((record) => record.id).sort()).toEqual(['d1', 'd2']);
    } finally {
      safari.restore();
    }
  });

  it('deleteFile clears the mirrored bytes with the record', async () => {
    const safari = installSafari17Opfs();
    try {
      const store = new MediaStore(new MemoryKeyValue());
      await store.importFile(new Blob(['gone']), info('g1'), 'g1', 'g.mp4');
      await store.deleteFile('g1');
      expect(await store.readFile('g1')).toBeNull();
      expect(await store.get('g1')).toBeUndefined();
    } finally {
      safari.restore();
    }
  });

  it('storage usage counts the mirrored assets', async () => {
    const safari = installSafari17Opfs();
    try {
      const store = new MediaStore(new MemoryKeyValue());
      await store.importFile(new Blob(['abc']), info('u1'), 'u1', 'a.mp4');
      await store.importFile(new Blob(['de']), info('u2'), 'u2', 'b.mp4');
      const usage = await store.getStorageUsage();
      expect(usage.mediaCount).toBe(2);
      expect(usage.mediaBytes).toBe(5);
    } finally {
      safari.restore();
    }
  });
});
