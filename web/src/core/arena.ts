// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Generational arenas — a faithful port of `concat-core/src/arena.rs`.
 *
 * Editor data is a graph — clips reference media, effects reference clips — and
 * Concat models that with handles into an arena rather than with pointers.
 *
 * {@link Id} is small, comparable and hashable, so it goes into undo records
 * and across threads without ceremony, and the generation counter turns a
 * stale handle into `undefined` instead of a use-after-free.
 */

/** A handle to a value in an {@link Arena}. The type parameter is a marker
 * only — it stops you from indexing a track arena with a clip handle. */
export class Id<T> {
  /** The slot this handle points at. Useful for stable display ordering; it is
   * not a unique identity on its own, because slots are reused. */
  readonly index: number;
  readonly generation: number;
  /** Phantom brand: never set at runtime. */
  private readonly brand?: (value: T) => T;

  constructor(index: number, generation: number) {
    this.index = index;
    this.generation = generation;
    Object.freeze(this);
  }

  equals(other: Id<T>): boolean {
    return this.index === other.index && this.generation === other.generation;
  }

  toString(): string {
    return `#${this.index}:${this.generation}`;
  }
}

type Slot<T> =
  | { occupied: true; value: T; generation: number }
  | { occupied: false; generation: number };

/** A slab of `T` addressed by {@link Id}, where removed slots are reused
 * without letting old handles alias the new occupant. */
export class Arena<T> {
  private readonly slots: Slot<T>[] = [];
  private readonly free: number[] = [];
  private live = 0;

  /** An empty arena. `capacity` is accepted for API parity with Rust
   * `Arena::with_capacity`; JavaScript arrays grow on demand. */
  constructor(_capacity = 0) {
    // Slots are pushed lazily; `insert` keeps `slots`, `free` and `live` in step.
  }

  /** Stores `value` and returns a handle to it. */
  insert(value: T): Id<T> {
    const reuse = this.free.pop();
    if (reuse !== undefined) {
      const slot = this.slots[reuse];
      if (!slot || slot.occupied) {
        throw new Error('free list pointed at an occupied slot');
      }
      this.slots[reuse] = { occupied: true, value, generation: slot.generation };
      this.live += 1;
      return new Id<T>(reuse, slot.generation);
    }
    const index = this.slots.length;
    this.slots.push({ occupied: true, value, generation: 0 });
    this.live += 1;
    return new Id<T>(index, 0);
  }

  /** The value behind `id`, or `undefined` if it has been removed. The value
   * is live and mutable — JavaScript callers mutate in place, the way
   * `Arena::get_mut` hands out `&mut T` in Rust. */
  get(id: Id<T>): T | undefined {
    const slot = this.slots[id.index];
    if (!slot || !slot.occupied || slot.generation !== id.generation) return undefined;
    return slot.value;
  }

  /** Alias of {@link Arena.get}, named for the Rust API. */
  getMut(id: Id<T>): T | undefined {
    return this.get(id);
  }

  /** True if `id` still refers to a live value. */
  contains(id: Id<T>): boolean {
    return this.get(id) !== undefined;
  }

  /** Removes and returns the value behind `id`, invalidating every handle to
   * it. Returns `undefined` if it was already gone. */
  remove(id: Id<T>): T | undefined {
    const slot = this.slots[id.index];
    if (!slot || !slot.occupied || slot.generation !== id.generation) return undefined;
    this.slots[id.index] = { occupied: false, generation: (id.generation + 1) >>> 0 };
    this.free.push(id.index);
    this.live -= 1;
    return slot.value;
  }

  /** How many live values the arena holds. */
  len(): number {
    return this.live;
  }

  /** True if the arena holds no live values. */
  isEmpty(): boolean {
    return this.live === 0;
  }

  /** Iterates over live values in slot order, paired with their handles. */
  *iter(): IterableIterator<[Id<T>, T]> {
    for (let index = 0; index < this.slots.length; index += 1) {
      const slot = this.slots[index];
      if (slot && slot.occupied) {
        yield [new Id<T>(index, slot.generation), slot.value];
      }
    }
  }
}
