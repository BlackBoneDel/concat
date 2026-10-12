// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Fase 6: where encoded bytes wait for the container index. Packets are
 * appended to a small in-memory batch that is sealed into a `Blob` every
 * ~16 MB; browsers may page large blobs to disk, so a 900 MB export never
 * sits in the JS heap. Every append returns its absolute byte offset, which
 * is what MP4 chunk offsets and WebM cluster slices need.
 */

/** Bytes per sealed batch (16 MiB). */
export const PACKET_BATCH_BYTES = 16 * 1024 * 1024;

/** A packet's place in the store. */
export interface PacketRef {
  offset: number;
  size: number;
}

/** Append-only byte store backed by sealed `Blob` batches. */
export class PacketStore {
  private readonly batchBytes: number;
  private readonly sealed: Blob[] = [];
  private pending: Uint8Array<ArrayBuffer>[] = [];
  private pendingBytes = 0;
  private total = 0;
  private finished: Blob | null = null;

  /**
   * @param batchBytes seal threshold (tests use small values).
   */
  constructor(batchBytes = PACKET_BATCH_BYTES) {
    this.batchBytes = Math.max(1, batchBytes);
  }

  /** Bytes stored. */
  get size(): number {
    return this.total;
  }

  /** Sealed batches so far. */
  get batchCount(): number {
    return this.sealed.length;
  }

  /**
   * Appends bytes (the store keeps the array; do not reuse it).
   * @param data the bytes.
   * @returns where they landed.
   */
  append(data: Uint8Array<ArrayBuffer>): PacketRef {
    if (this.finished) throw new Error('PacketStore ya finalizado');
    const ref = { offset: this.total, size: data.byteLength };
    this.pending.push(data);
    this.pendingBytes += data.byteLength;
    this.total += data.byteLength;
    if (this.pendingBytes >= this.batchBytes) this.seal();
    return ref;
  }

  /**
   * Seals the last batch and returns every byte as one `Blob`.
   * @returns the concatenation (cached).
   */
  finish(): Blob {
    if (!this.finished) {
      this.seal();
      this.finished = new Blob(this.sealed);
    }
    return this.finished;
  }

  /**
   * A slice of the store (after {@link finish}).
   * @param ref an append result.
   * @returns the bytes as a lazy `Blob` slice.
   */
  slice(ref: PacketRef): Blob {
    return this.finish().slice(ref.offset, ref.offset + ref.size);
  }

  /** Drops everything. */
  clear(): void {
    this.sealed.length = 0;
    this.pending = [];
    this.pendingBytes = 0;
    this.total = 0;
    this.finished = null;
  }

  private seal(): void {
    if (this.pending.length === 0) return;
    this.sealed.push(new Blob(this.pending));
    this.pending = [];
    this.pendingBytes = 0;
  }
}

/** Growable big-endian byte writer for container headers. */
export class ByteWriter {
  private buffer: Uint8Array<ArrayBuffer>;
  private view: DataView;
  private length = 0;

  /**
   * @param capacity initial capacity.
   */
  constructor(capacity = 256) {
    this.buffer = new Uint8Array(Math.max(16, capacity));
    this.view = new DataView(this.buffer.buffer);
  }

  /** Bytes written. */
  get position(): number {
    return this.length;
  }

  u8(value: number): this {
    this.ensure(1);
    this.view.setUint8(this.length, value & 0xff);
    this.length += 1;
    return this;
  }

  u16(value: number): this {
    this.ensure(2);
    this.view.setUint16(this.length, value & 0xffff);
    this.length += 2;
    return this;
  }

  i16(value: number): this {
    this.ensure(2);
    this.view.setInt16(this.length, value);
    this.length += 2;
    return this;
  }

  u24(value: number): this {
    return this.u8(value >>> 16).u16(value & 0xffff);
  }

  u32(value: number): this {
    this.ensure(4);
    this.view.setUint32(this.length, value >>> 0);
    this.length += 4;
    return this;
  }

  i32(value: number): this {
    this.ensure(4);
    this.view.setInt32(this.length, value | 0);
    this.length += 4;
    return this;
  }

  u64(value: number): this {
    this.ensure(8);
    this.view.setBigUint64(this.length, BigInt(Math.max(0, Math.floor(value))));
    this.length += 8;
    return this;
  }

  f64(value: number): this {
    this.ensure(8);
    this.view.setFloat64(this.length, value);
    this.length += 8;
    return this;
  }

  u16le(value: number): this {
    this.ensure(2);
    this.view.setUint16(this.length, value & 0xffff, true);
    this.length += 2;
    return this;
  }

  u32le(value: number): this {
    this.ensure(4);
    this.view.setUint32(this.length, value >>> 0, true);
    this.length += 4;
    return this;
  }

  /** Four ASCII characters. */
  fourcc(text: string): this {
    for (let i = 0; i < 4; i += 1) this.u8(text.charCodeAt(i) || 0x20);
    return this;
  }

  /** ASCII text (no terminator). */
  ascii(text: string): this {
    for (let i = 0; i < text.length; i += 1) this.u8(text.charCodeAt(i) & 0x7f);
    return this;
  }

  bytes(data: Uint8Array): this {
    this.ensure(data.byteLength);
    this.buffer.set(data, this.length);
    this.length += data.byteLength;
    return this;
  }

  zeros(count: number): this {
    this.ensure(count);
    this.buffer.fill(0, this.length, this.length + count);
    this.length += count;
    return this;
  }

  /** Overwrites a u32 at `offset` (box sizes). */
  patchU32(offset: number, value: number): this {
    this.view.setUint32(offset, value >>> 0);
    return this;
  }

  /** The written bytes (a copy sized exactly). */
  toBytes(): Uint8Array<ArrayBuffer> {
    return this.buffer.slice(0, this.length);
  }

  private ensure(extra: number): void {
    if (this.length + extra <= this.buffer.length) return;
    let capacity = this.buffer.length * 2;
    while (capacity < this.length + extra) capacity *= 2;
    const next = new Uint8Array(capacity);
    next.set(this.buffer.subarray(0, this.length));
    this.buffer = next;
    this.view = new DataView(next.buffer);
  }
}
