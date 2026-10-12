// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * SHA-256 of local files, for relink validation and proxy integrity.
 *
 * Web Crypto's `crypto.subtle.digest` is one-shot (it needs the whole buffer
 * in memory), so large files stream through an incremental FIPS 180-4
 * implementation in 64 KB chunks with progress every 500 ms; small inputs
 * (≤ 8 MB) take the native one-shot digest. Both produce identical hex —
 * the tests check it. Hashing runs in the scanner worker when workers exist
 * (see `workers/scanner-worker.ts`), inline otherwise.
 */

import { WorkerClient } from '../../workers/worker-client.ts';

/** Chunk size of the streaming path (the spec's 64 KB). */
export const HASH_CHUNK_SIZE = 64 * 1024;

/** Inputs up to this size use the native one-shot digest. */
export const NATIVE_DIGEST_LIMIT = 8 * 1024 * 1024;

/** Progress reporting interval. */
const PROGRESS_INTERVAL_MS = 500;

/** FIPS 180-4 round constants. */
const K = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** Incremental SHA-256 (FIPS 180-4 §6.2). */
export class Sha256 {
  private readonly state = new Int32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private readonly block = new Uint8Array(64);
  private readonly words = new Int32Array(64);
  private blockLength = 0;
  private totalBytes = 0;
  private finished = false;

  /**
   * Feeds bytes.
   * @param data the next chunk.
   * @returns this hasher.
   */
  update(data: Uint8Array): this {
    if (this.finished) throw new Error('Sha256 ya finalizado');
    let offset = 0;
    this.totalBytes += data.length;
    if (this.blockLength > 0) {
      const take = Math.min(64 - this.blockLength, data.length);
      this.block.set(data.subarray(0, take), this.blockLength);
      this.blockLength += take;
      offset = take;
      if (this.blockLength === 64) {
        this.compress(this.block, 0);
        this.blockLength = 0;
      }
    }
    while (offset + 64 <= data.length) {
      this.compress(data, offset);
      offset += 64;
    }
    if (offset < data.length) {
      this.block.set(data.subarray(offset), 0);
      this.blockLength = data.length - offset;
    }
    return this;
  }

  /**
   * Finishes the hash.
   * @returns the 32-byte digest.
   */
  digest(): Uint8Array {
    if (this.finished) throw new Error('Sha256 ya finalizado');
    const bitsHigh = Math.floor((this.totalBytes * 8) / 0x100000000);
    const bitsLow = (this.totalBytes * 8) >>> 0;
    this.block[this.blockLength] = 0x80;
    this.blockLength += 1;
    if (this.blockLength > 56) {
      this.block.fill(0, this.blockLength);
      this.compress(this.block, 0);
      this.blockLength = 0;
    }
    this.block.fill(0, this.blockLength);
    const view = new DataView(this.block.buffer);
    view.setUint32(56, bitsHigh);
    view.setUint32(60, bitsLow);
    this.compress(this.block, 0);
    this.finished = true;
    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < 8; i += 1) outView.setInt32(i * 4, this.state[i]!);
    return out;
  }

  /** One 512-bit block. */
  private compress(data: Uint8Array, offset: number): void {
    const w = this.words;
    for (let i = 0; i < 16; i += 1) {
      const at = offset + i * 4;
      w[i] = (data[at]! << 24) | (data[at + 1]! << 16) | (data[at + 2]! << 8) | data[at + 3]!;
    }
    for (let i = 16; i < 64; i += 1) {
      const x = w[i - 15]!;
      const y = w[i - 2]!;
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }
    const s = this.state;
    let a = s[0]!;
    let b = s[1]!;
    let c = s[2]!;
    let d = s[3]!;
    let e = s[4]!;
    let f = s[5]!;
    let g = s[6]!;
    let h = s[7]!;
    for (let i = 0; i < 64; i += 1) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i]! + w[i]!) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    s[0] = (s[0]! + a) | 0;
    s[1] = (s[1]! + b) | 0;
    s[2] = (s[2]! + c) | 0;
    s[3] = (s[3]! + d) | 0;
    s[4] = (s[4]! + e) | 0;
    s[5] = (s[5]! + f) | 0;
    s[6] = (s[6]! + g) | 0;
    s[7] = (s[7]! + h) | 0;
  }
}

/**
 * Lowercase hex of bytes.
 * @param bytes the digest.
 * @returns hex string.
 */
export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/**
 * Streams a blob through {@link Sha256} in 64 KB chunks.
 * @param blob the file.
 * @param onProgress progress 0..1, at most every 500 ms (and once at 1).
 * @returns hex digest.
 */
export async function sha256Stream(blob: Blob, onProgress?: (progress: number) => void): Promise<string> {
  const hasher = new Sha256();
  let lastReport = 0;
  for (let offset = 0; offset < blob.size; offset += HASH_CHUNK_SIZE) {
    const chunk = new Uint8Array(await blob.slice(offset, offset + HASH_CHUNK_SIZE).arrayBuffer());
    hasher.update(chunk);
    const now = Date.now();
    if (onProgress && now - lastReport >= PROGRESS_INTERVAL_MS) {
      lastReport = now;
      onProgress(Math.min(1, (offset + chunk.length) / Math.max(1, blob.size)));
    }
  }
  onProgress?.(1);
  return toHex(hasher.digest());
}

/**
 * One-shot native digest through Web Crypto (falls back to the streaming
 * implementation when `crypto.subtle` is missing, e.g. insecure contexts).
 * @param blob the input.
 * @returns hex digest.
 */
export async function sha256Native(blob: Blob): Promise<string> {
  const subtle = typeof crypto !== 'undefined' ? crypto.subtle : undefined;
  if (!subtle) return sha256Stream(blob);
  const digest = await subtle.digest('SHA-256', await blob.arrayBuffer());
  return toHex(new Uint8Array(digest));
}

/**
 * The hash the worker and the inline path both run.
 * @param blob the input.
 * @param onProgress progress 0..1.
 * @returns hex digest.
 */
export async function computeSHA256Inline(blob: Blob, onProgress?: (progress: number) => void): Promise<string> {
  if (blob.size <= NATIVE_DIGEST_LIMIT) {
    const hex = await sha256Native(blob);
    onProgress?.(1);
    return hex;
  }
  return sha256Stream(blob, onProgress);
}

/** Validates files against expected SHA-256 digests. */
export class HashValidator {
  private readonly client: WorkerClient;

  /**
   * @param client the worker client; defaults to the scanner worker.
   */
  constructor(client?: WorkerClient) {
    this.client =
      client ??
      new WorkerClient(() =>
        typeof Worker === 'undefined'
          ? null
          : new Worker(new URL('../../workers/scanner-worker.ts', import.meta.url), { type: 'module' }),
      );
  }

  /**
   * SHA-256 of a file, off the main thread when possible.
   * @param file the input.
   * @param onProgress progress 0..1 every ~500 ms.
   * @returns lowercase hex digest.
   */
  async computeSHA256(file: File | Blob, onProgress?: (p: number) => void): Promise<string> {
    if (this.client.available) {
      try {
        return await this.client.request<string>('hash', { blob: file }, [], onProgress);
      } catch {
        // A dead worker falls through to the inline path.
      }
    }
    return computeSHA256Inline(file, onProgress);
  }

  /**
   * Whether a file matches an expected digest (case-insensitive).
   * @param expected hex digest.
   * @param file the candidate.
   * @returns `true` on a match.
   */
  async validateMatch(expected: string, file: File | Blob): Promise<boolean> {
    if (!/^[0-9a-f]{64}$/i.test(expected)) return false;
    const actual = await this.computeSHA256(file);
    return actual === expected.toLowerCase();
  }

  /** Stops the worker. */
  dispose(): void {
    this.client.terminate('HashValidator cerrado');
  }
}
