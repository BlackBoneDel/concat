// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Proxy persistence: OPFS/IDB records, checksums, LRU eviction, cleanup. */

import { describe, expect, it } from 'vitest';
import { Rational } from '../src/core/rational.ts';
import { ProxyQuotaError, ProxyStore } from '../src/media/proxy/proxy-store.ts';
import { MemoryKeyValue } from '../src/storage/idb.ts';
import {
  MemoryProxyFiles,
  OpfsProxyFiles,
  PROXY_STORE_NAME,
  ProxyRecordStore,
  isProxyRecord,
} from '../src/storage/proxy-store.ts';

function makeStore(limitBytes = 1000) {
  let clock = 1000;
  const files = new MemoryProxyFiles();
  const kv = new MemoryKeyValue();
  const store = new ProxyStore(new ProxyRecordStore(kv), files, {
    limitBytes,
    now: () => {
      clock += 1;
      return clock;
    },
  });
  return { store, files, kv };
}

const info = { width: 1280, height: 720, duration: Rational.fromInt(10), container: 'mp4' as const };

function blobOf(size: number, fill = 1): Blob {
  return new Blob([new Uint8Array(size).fill(fill)]);
}

describe('ProxyStore', () => {
  it('saves with checksum, path under proxies/ and reloads with validation', async () => {
    const { store, files } = makeStore();
    const meta = await store.save('m1', blobOf(100), info);
    expect(meta.opfsPath).toMatch(/^proxies\/px-m1-.*\.mp4$/);
    expect(meta.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(meta.resolution).toEqual({ width: 1280, height: 720 });
    expect(meta.duration.asNumber()).toBe(10);
    expect(files.size).toBe(1);
    const loaded = await store.load('m1');
    expect(loaded?.size).toBe(100);
    expect((await store.get('m1'))?.lastAccess).toBeGreaterThan(meta.lastAccess);
  });

  it('deletes a corrupt proxy whose checksum no longer matches', async () => {
    const { store, files } = makeStore();
    const meta = await store.save('m1', blobOf(50), info);
    await files.write(meta.opfsPath, blobOf(50, 9));
    expect(await store.load('m1')).toBeNull();
    expect(await store.get('m1')).toBeNull();
  });

  it('drops the record when the file vanished', async () => {
    const { store, files } = makeStore();
    const meta = await store.save('m1', blobOf(10), info);
    await files.delete(meta.opfsPath);
    expect(await store.load('m1', false)).toBeNull();
    expect(await store.list()).toHaveLength(0);
  });

  it('evicts least-recently-used proxies to fit the budget', async () => {
    const { store } = makeStore(250);
    await store.save('a', blobOf(100), info);
    await store.save('b', blobOf(100), info);
    await store.load('a'); // a becomes most recent
    await store.save('c', blobOf(100), info);
    const ids = (await store.list()).map((meta) => meta.mediaId).sort();
    expect(ids).toEqual(['a', 'c']);
    expect(await store.usage()).toBe(200);
  });

  it('rejects a proxy larger than the whole budget', async () => {
    const { store } = makeStore(10);
    await expect(store.save('m', blobOf(11), info)).rejects.toBeInstanceOf(ProxyQuotaError);
  });

  it('setLimit evicts down and validates', async () => {
    const { store } = makeStore(1000);
    await store.save('a', blobOf(300), info);
    await store.save('b', blobOf(300), info);
    expect(await store.setLimit(400)).toEqual(['a']);
    await expect(store.setLimit(0)).rejects.toThrow(RangeError);
    expect(store.limit).toBe(400);
  });

  it('cleanup removes proxies of media that no longer exist; clear wipes all', async () => {
    const { store, files } = makeStore();
    await store.save('keep', blobOf(10), info);
    await store.save('gone', blobOf(10), info);
    expect(await store.cleanup(['keep'])).toEqual(['gone']);
    expect(await store.delete('gone')).toBe(false);
    expect(await store.clear()).toBe(1);
    expect(files.size).toBe(0);
  });

  it('replaces the previous proxy of the same media', async () => {
    const { store, files } = makeStore();
    await store.save('m', blobOf(10), info);
    await store.save('m', blobOf(20), { ...info, container: 'webm' });
    expect(files.size).toBe(1);
    expect((await store.get('m'))?.container).toBe('webm');
  });
});

describe('storage/proxy-store', () => {
  it('validates stored records structurally', async () => {
    const kv = new MemoryKeyValue();
    await kv.put(PROXY_STORE_NAME, 'junk', { mediaId: 'x' });
    const records = new ProxyRecordStore(kv);
    expect(await records.get('junk')).toBeUndefined();
    expect(await records.list()).toEqual([]);
    expect(isProxyRecord(null)).toBe(false);
    expect(
      isProxyRecord({
        mediaId: 'm', proxyId: 'p', opfsPath: 'proxies/p.mp4', checksum: 'c', width: 1, height: 1,
        durationSeconds: 1, fileSize: 1, generatedAt: 1, lastAccess: 1, container: 'mp4',
      }),
    ).toBe(true);
  });

  it('OPFS backend degrades to memory without navigator.storage', async () => {
    const files = new OpfsProxyFiles();
    expect(await files.hasOpfs()).toBe(false);
    await files.write('proxies/a.mp4', new Blob(['x']));
    expect((await files.read('proxies/a.mp4'))?.size).toBe(1);
    await files.delete('proxies/a.mp4');
    expect(await files.read('proxies/a.mp4')).toBeNull();
  });
});
