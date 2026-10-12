// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** The key/value backends: memory semantics and the IndexedDB fallback. */

import { describe, expect, it } from 'vitest';
import { MemoryKeyValue, openDatabase, openKeyValue } from '../src/storage/idb.ts';

describe('MemoryKeyValue', () => {
  it('stores, reads, counts and clears', async () => {
    const kv = new MemoryKeyValue();
    expect(await kv.get('s', 'k')).toBeUndefined();
    await kv.put('s', 'k', { value: 1 });
    expect(await kv.get('s', 'k')).toEqual({ value: 1 });
    await kv.put('s', 'k2', { value: 2 });
    expect(await kv.count('s')).toBe(2);
    const all = await kv.getAll<{ value: number }>('s');
    expect(all.map((item) => item.value).sort()).toEqual([1, 2]);
    await kv.delete('s', 'k');
    expect(await kv.count('s')).toBe(1);
    await kv.clear('s');
    expect(await kv.count('s')).toBe(0);
  });

  it('keeps stores independent', async () => {
    const kv = new MemoryKeyValue();
    await kv.put('a', 'k', 1);
    await kv.put('b', 'k', 2);
    expect(await kv.get('a', 'k')).toBe(1);
    expect(await kv.get('b', 'k')).toBe(2);
    await kv.clear('a');
    expect(await kv.get('b', 'k')).toBe(2);
  });
});

describe('openKeyValue fallback', () => {
  it('falls back to memory when IndexedDB is absent', async () => {
    // Node has no `indexedDB`.
    const kv = await openKeyValue('ConcatTestDB', ['s']);
    expect(kv).toBeInstanceOf(MemoryKeyValue);
    await kv.put('s', 'k', 42);
    expect(await kv.get('s', 'k')).toBe(42);
  });

  it('openDatabase returns null without IndexedDB', async () => {
    expect(await openDatabase('ConcatTestDB', 1, ['s'])).toBeNull();
  });
});

// -- Fase 7+: schema IndexedDB de waveforms (v3) y auto-reparación ---------

import { IndexedDbKeyValue, KEY_VALUE_VERSION } from '../src/storage/idb.ts';

/** A request double: fires its callbacks on a microtask, like the real one. */
class FakeRequest<T> {
  result: T | undefined;
  error: Error | null = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
  fire(value: T): void {
    this.result = value;
    queueMicrotask(() => this.onsuccess?.());
  }
}

class FakeObjectStore {
  constructor(private readonly data: Map<string, unknown>) {}
  get(key: string): FakeRequest<unknown> {
    const request = new FakeRequest<unknown>();
    request.fire(this.data.get(key));
    return request;
  }
  getAll(): FakeRequest<unknown[]> {
    const request = new FakeRequest<unknown[]>();
    request.fire([...this.data.values()]);
    return request;
  }
  put(value: unknown, key: string): FakeRequest<string> {
    this.data.set(key, value);
    const request = new FakeRequest<string>();
    request.fire(key);
    return request;
  }
  delete(key: string): FakeRequest<undefined> {
    this.data.delete(key);
    const request = new FakeRequest<undefined>();
    request.fire(undefined);
    return request;
  }
  count(): FakeRequest<number> {
    const request = new FakeRequest<number>();
    request.fire(this.data.size);
    return request;
  }
  clear(): FakeRequest<undefined> {
    this.data.clear();
    const request = new FakeRequest<undefined>();
    request.fire(undefined);
    return request;
  }
}

class FakeDb {
  closed = false;
  constructor(
    readonly name: string,
    public version: number,
    readonly stores: Set<string>,
    readonly data: Map<string, Map<string, unknown>>,
  ) {}
  get objectStoreNames(): { contains(name: string): boolean } {
    return { contains: (store: string) => this.stores.has(store) };
  }
  createObjectStore(store: string): void {
    this.stores.add(store);
    this.data.set(store, new Map());
  }
  transaction(store: string): { objectStore(name: string): FakeObjectStore } {
    if (this.closed || !this.stores.has(store)) {
      const error = new Error(`store not found: ${store}`);
      error.name = 'NotFoundError';
      throw error;
    }
    return { objectStore: (name: string) => new FakeObjectStore(this.data.get(name)!) };
  }
  close(): void {
    this.closed = true;
  }
}

/** A minimal in-memory IndexedDB double with upgrade semantics. */
class FakeIndexedDb {
  readonly databases = new Map<string, FakeDb>();
  readonly openAttempts: { name: string; version: number | undefined }[] = [];
  failNextOpen = false;
  open(name: string, version?: number): {
    result: FakeDb | null;
    error: Error | null;
    onupgradeneeded: (() => void) | null;
    onsuccess: (() => void) | null;
    onerror: (() => void) | null;
    onblocked: (() => void) | null;
  } {
    this.openAttempts.push({ name, version });
    const request = {
      result: null as FakeDb | null,
      error: null as Error | null,
      onupgradeneeded: null as (() => void) | null,
      onsuccess: null as (() => void) | null,
      onerror: null as (() => void) | null,
      onblocked: null as (() => void) | null,
    };
    queueMicrotask(() => {
      if (this.failNextOpen) {
        this.failNextOpen = false;
        request.error = new Error('open refused');
        request.onerror?.();
        return;
      }
      const existing = this.databases.get(name);
      const previousVersion = existing?.version ?? 0;
      const target = version ?? existing?.version ?? 1;
      const db = existing ?? new FakeDb(name, 0, new Set(), new Map());
      db.version = target;
      // A real `close()` closes the connection, not the database: reopening
      // hands out a fresh live connection over the same data.
      db.closed = false;
      this.databases.set(name, db);
      request.result = db;
      if (!existing || target > previousVersion) request.onupgradeneeded?.();
      request.onsuccess?.();
    });
    return request;
  }
}

function installFakeIndexedDb(): { fake: FakeIndexedDb; restore: () => void } {
  const fake = new FakeIndexedDb();
  const had = 'indexedDB' in globalThis;
  Object.defineProperty(globalThis, 'indexedDB', { value: fake, configurable: true });
  return {
    fake,
    restore: () => {
      if (had) Object.defineProperty(globalThis, 'indexedDB', { value: undefined, configurable: true });
      else Reflect.deleteProperty(globalThis, 'indexedDB');
    },
  };
}

describe('IndexedDB waveforms schema (Fase 7+)', () => {
  it('ships KEY_VALUE_VERSION 3 (files + waveforms)', () => {
    expect(KEY_VALUE_VERSION).toBe(3);
  });

  it('the v2 → v3 upgrade creates the missing waveforms store', async () => {
    const installed = installFakeIndexedDb();
    try {
      // A database deployed by the old build: v2, only `files`.
      const legacy = await IndexedDbKeyValue.open('ConcatMediaDB', 2, ['files']);
      expect(legacy).not.toBeNull();
      // The new build reopens at v3 with both stores.
      const upgraded = await IndexedDbKeyValue.open('ConcatMediaDB', KEY_VALUE_VERSION, ['files', 'waveforms']);
      const db = installed.fake.databases.get('ConcatMediaDB')!;
      expect(db.version).toBe(3);
      expect(db.stores.has('files')).toBe(true);
      expect(db.stores.has('waveforms')).toBe(true);
      await upgraded!.put('waveforms', 'm1_128', { data: 1 });
      expect(await upgraded!.get('waveforms', 'm1_128')).toEqual({ data: 1 });
    } finally {
      installed.restore();
    }
  });

  it('openKeyValue defaults to version 3', async () => {
    const installed = installFakeIndexedDb();
    try {
      await openKeyValue('ConcatMediaDB', ['files', 'waveforms']);
      expect(installed.fake.openAttempts.at(-1)).toEqual({ name: 'ConcatMediaDB', version: 3 });
    } finally {
      installed.restore();
    }
  });

  it('openKeyValue accepts an explicit version', async () => {
    const installed = installFakeIndexedDb();
    try {
      await openKeyValue('OtherDB', ['s'], 7);
      expect(installed.fake.openAttempts.at(-1)).toEqual({ name: 'OtherDB', version: 7 });
    } finally {
      installed.restore();
    }
  });

  it('self-heals a stale v2 connection: NotFoundError reopens one version higher', async () => {
    const installed = installFakeIndexedDb();
    try {
      // Simulate the deployed schema: the live connection only knows `files`.
      const kv = await IndexedDbKeyValue.open('ConcatMediaDB', 2, ['files']);
      await kv!.put('files', 'm1', { id: 'm1' });
      // The waveform cache asks for the missing store → heal, not crash.
      await kv!.put('waveforms', 'm1_128', { peaks: true });
      const db = installed.fake.databases.get('ConcatMediaDB')!;
      expect(db.version).toBe(3);
      expect(db.stores.has('waveforms')).toBe(true);
      expect(await kv!.get('waveforms', 'm1_128')).toEqual({ peaks: true });
    } finally {
      installed.restore();
    }
  });

  it('the heal preserves the data of the pre-existing stores', async () => {
    const installed = installFakeIndexedDb();
    try {
      const kv = await IndexedDbKeyValue.open('ConcatMediaDB', 2, ['files']);
      await kv!.put('files', 'm1', { id: 'm1', name: 'obs.webm' });
      await kv!.put('waveforms', 'm1_512', { peaks: [0, 1] });
      expect(await kv!.get('files', 'm1')).toEqual({ id: 'm1', name: 'obs.webm' });
      expect(await kv!.count('files')).toBe(1);
    } finally {
      installed.restore();
    }
  });

  it('gives up (rejects) when the healed database cannot be reopened', async () => {
    const installed = installFakeIndexedDb();
    try {
      const kv = await IndexedDbKeyValue.open('ConcatMediaDB', 2, ['files']);
      installed.fake.failNextOpen = true; // the reopen during the heal fails
      await expect(kv!.put('waveforms', 'm1_128', { peaks: true })).rejects.toThrow(/store not found|cannot reopen/);
      // The store stays broken: a second attempt rejects without looping.
      await expect(kv!.get('waveforms', 'm1_128')).rejects.toThrow(/store not found|cannot reopen/);
    } finally {
      installed.restore();
    }
  });
});
