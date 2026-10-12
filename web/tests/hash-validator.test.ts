// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** SHA-256: FIPS 180-4 vectors, streaming in 64 KB chunks, worker path. */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  HASH_CHUNK_SIZE,
  HashValidator,
  Sha256,
  computeSHA256Inline,
  sha256Native,
  sha256Stream,
  toHex,
} from '../src/media/relink/hash-validator.ts';
import { createScannerHandlers } from '../src/media/relink/scanner-handlers.ts';
import { WorkerClient } from '../src/workers/worker-client.ts';
import { linkedWorker } from './f4-helpers.ts';

const enc = (text: string): Uint8Array<ArrayBuffer> => new Uint8Array(new TextEncoder().encode(text));
const hex = (data: Uint8Array): string => toHex(new Sha256().update(data).digest());

function pseudoRandom(size: number, seed = 7): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(size);
  let x = seed;
  for (let i = 0; i < size; i += 1) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

describe('Sha256', () => {
  it('matches the FIPS 180-4 test vectors', () => {
    expect(hex(enc(''))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(hex(enc('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hex(enc('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });

  it('is independent of how the input is chunked', () => {
    const data = pseudoRandom(10_000);
    const expected = createHash('sha256').update(data).digest('hex');
    for (const step of [1, 63, 64, 65, 1000, 4096]) {
      const h = new Sha256();
      for (let i = 0; i < data.length; i += step) h.update(data.subarray(i, i + step));
      expect(toHex(h.digest())).toBe(expected);
    }
    const done = new Sha256();
    done.digest();
    expect(() => done.update(enc('x'))).toThrow(/finalizado/);
  });
});

describe('blob hashing', () => {
  it('streams, uses the native digest for small files and reports progress', async () => {
    const data = pseudoRandom(HASH_CHUNK_SIZE * 3 + 17);
    const expected = createHash('sha256').update(data).digest('hex');
    const blob = new Blob([data]);
    const progress: number[] = [];
    expect(await sha256Stream(blob, (p) => progress.push(p))).toBe(expected);
    expect(progress[progress.length - 1]).toBe(1);
    expect(await sha256Native(blob)).toBe(expected);
    expect(await computeSHA256Inline(blob)).toBe(expected);
  });
});

describe('HashValidator', () => {
  it('hashes in the scanner worker and validates matches', async () => {
    const { worker } = linkedWorker(createScannerHandlers());
    const validator = new HashValidator(new WorkerClient(() => worker));
    const file = new Blob([enc('abc')]);
    expect(await validator.computeSHA256(file)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await validator.validateMatch('BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD', file)).toBe(true);
    expect(await validator.validateMatch('0'.repeat(64), file)).toBe(false);
    expect(await validator.validateMatch('no-es-hex', file)).toBe(false);
    validator.dispose();
  });

  it('falls back inline without workers and when the worker fails', async () => {
    const inline = new HashValidator(new WorkerClient(() => null));
    expect(await inline.computeSHA256(new Blob([enc('abc')]))).toMatch(/^ba7816bf/);
    const { worker } = linkedWorker({ hash: () => { throw new Error('roto'); } });
    const broken = new HashValidator(new WorkerClient(() => worker));
    expect(await broken.computeSHA256(new Blob([enc('')]))).toMatch(/^e3b0c442/);
  });

  it('throttles worker progress to 500 ms', async () => {
    let t = 0;
    const handlers = createScannerHandlers(() => (t += 100));
    const { worker } = linkedWorker(handlers);
    const client = new WorkerClient(() => worker);
    const ticks: number[] = [];
    const data = pseudoRandom(9 * 1024 * 1024);
    await client.request('hash', { blob: new Blob([data]) }, [], (p) => ticks.push(p));
    expect(ticks.length).toBeGreaterThan(1);
    expect(ticks.length).toBeLessThan(Math.ceil(data.length / HASH_CHUNK_SIZE) / 4);
    expect(ticks[ticks.length - 1]).toBe(1);
    await expect(client.request('hash', { blob: 'x' })).rejects.toThrow(/Se esperaba un archivo/);
    client.terminate();
  });
});
