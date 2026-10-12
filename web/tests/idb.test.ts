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
