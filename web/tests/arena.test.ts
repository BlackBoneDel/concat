// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

import { describe, expect, it } from 'vitest';
import { Arena, Id } from '../src/core/arena.ts';

describe('Arena', () => {
  it('stores values and hands out working handles', () => {
    const arena = new Arena<string>();
    const id = arena.insert('clip');
    expect(arena.get(id)).toBe('clip');
    expect(arena.len()).toBe(1);
  });

  it('turns a stale handle into nothing instead of a use-after-free', () => {
    const arena = new Arena<string>();
    const id = arena.insert('clip');
    arena.remove(id);
    expect(arena.get(id)).toBeUndefined();
    // The module's own doctest: the stale handle is simply empty.
    expect(arena.len()).toBe(0);

    // Slot reuse does not resurrect the old handle.
    const reused = arena.insert('other');
    expect(reused.index).toBe(id.index);
    expect(reused.generation).not.toBe(id.generation);
    expect(arena.get(id)).toBeUndefined();
    expect(arena.get(reused)).toBe('other');
  });

  it('iterates live values in slot order with their handles', () => {
    const arena = new Arena<number>();
    const a = arena.insert(1);
    arena.insert(2);
    const c = arena.insert(3);
    arena.remove(c);
    const seen = [...arena.iter()].map(([id, value]) => [id.index, value]);
    expect(seen).toEqual([
      [a.index, 1],
      [a.index + 1, 2],
    ]);
  });

  it('compares handles by slot and generation', () => {
    const arena = new Arena<string>();
    const id = arena.insert('x');
    expect(id.equals(new Id<string>(id.index, id.generation))).toBe(true);
    expect(id.equals(new Id<string>(id.index, id.generation + 1))).toBe(false);
  });
});
