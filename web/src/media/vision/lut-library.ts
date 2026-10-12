// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The LUTs the editor knows: the built-in looks plus `.cube` files loaded
 * this session (kept in memory; projects store only the LUT id, like the
 * Rust editor stores a look by name in `looks.rs`).
 */

import { BUILTIN_LUTS, type Lut3D } from './lut-loader.ts';

/** Built-in + session LUTs with change notifications. */
export class LutLibrary {
  private readonly session = new Map<string, Lut3D>();
  private readonly listeners = new Set<() => void>();

  /** Every LUT, built-ins first. */
  list(): Lut3D[] {
    return [...BUILTIN_LUTS, ...this.session.values()];
  }

  /** Session LUTs only. */
  sessionLuts(): Lut3D[] {
    return [...this.session.values()];
  }

  /**
   * Looks a LUT up.
   * @param id LUT id.
   * @returns the table, or undefined.
   */
  get(id: string): Lut3D | undefined {
    return BUILTIN_LUTS.find((lut) => lut.id === id) ?? this.session.get(id);
  }

  /**
   * Adds (or replaces) a session LUT.
   * @param lut the parsed table.
   */
  add(lut: Lut3D): void {
    this.session.set(lut.id, lut);
    this.emit();
  }

  /**
   * Forgets a session LUT.
   * @param id LUT id.
   * @returns true when removed.
   */
  remove(id: string): boolean {
    const removed = this.session.delete(id);
    if (removed) this.emit();
    return removed;
  }

  /**
   * Subscribes to changes.
   * @param listener called after add/remove.
   * @returns the unsubscribe function.
   */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
