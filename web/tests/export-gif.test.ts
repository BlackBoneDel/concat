// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

import { describe, expect, it } from 'vitest';
import {
  GIF_WARN_SECONDS,
  GifEncoder,
  frameDelayCentiseconds,
  frameDelayMs,
  gifDurationWarning,
  indexPixels,
  lzwEncode,
  quantize,
} from '../src/export/gif-exporter.ts';
import { PacketStore } from '../src/export/packet-store.ts';
import { ExportError } from '../src/export/types.ts';

/** Reference GIF LZW decoder (sub-blocks in, indices out). */
function lzwDecode(data: Uint8Array): number[] {
  const minCodeSize = data[0] ?? 2;
  const bytes: number[] = [];
  let o = 1;
  while (o < data.length) {
    const size = data[o++] ?? 0;
    if (size === 0) break;
    for (let i = 0; i < size; i += 1) bytes.push(data[o++] ?? 0);
  }
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let codeSize = minCodeSize + 1;
  let dict: number[][] = [];
  const reset = (): void => {
    dict = [];
    for (let i = 0; i < clear; i += 1) dict.push([i]);
    dict.push([], []);
    codeSize = minCodeSize + 1;
  };
  reset();
  const out: number[] = [];
  let bit = 0;
  let prev: number[] | null = null;
  const read = (): number => {
    let code = 0;
    for (let i = 0; i < codeSize; i += 1) {
      const byte = bytes[(bit + i) >> 3] ?? 0;
      code |= ((byte >> ((bit + i) & 7)) & 1) << i;
    }
    bit += codeSize;
    return code;
  };
  while (bit + codeSize <= bytes.length * 8) {
    const code = read();
    if (code === clear) {
      reset();
      prev = null;
      continue;
    }
    if (code === eoi) break;
    let entry: number[];
    if (prev === null) {
      entry = dict[code] ?? [];
    } else if (code < dict.length) {
      entry = dict[code] ?? [];
      if (dict.length < 4096) dict.push([...prev, entry[0] ?? 0]);
    } else {
      entry = [...prev, prev[0] ?? 0];
      if (dict.length < 4096) dict.push(entry);
    }
    out.push(...entry);
    prev = entry;
    if (dict.length === 1 << codeSize && codeSize < 12) codeSize += 1;
  }
  return out;
}

function gradient(width: number, height: number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      rgba[i] = (x * 255) / width;
      rgba[i + 1] = (y * 255) / height;
      rgba[i + 2] = ((x + y) * 7) % 256;
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

describe('gif exporter', () => {
  it('computes delays and warnings', () => {
    expect(frameDelayMs(12)).toBe(83);
    expect(frameDelayMs(25)).toBe(40);
    let sum = 0;
    for (let i = 0; i < 12; i += 1) sum += frameDelayCentiseconds(i, 12);
    expect(sum).toBe(100);
    expect(frameDelayCentiseconds(0, 100)).toBe(2);
    expect(gifDurationWarning(GIF_WARN_SECONDS)).toBeNull();
    expect(gifDurationWarning(45)).toMatch(/45 s/);
  });

  it('LZW round-trips random, uniform and long inputs (table resets)', () => {
    const cases: [Uint8Array, number][] = [
      [new Uint8Array([0, 1, 0, 1, 0, 1, 1, 1, 2, 3]), 2],
      [new Uint8Array(5000).fill(7), 8],
      [Uint8Array.from({ length: 60000 }, (_, i) => (i * 2654435761) % 251), 8],
      [Uint8Array.from({ length: 20000 }, (_, i) => (i >> 3) % 16), 4],
      [new Uint8Array(0), 2],
    ];
    for (const [indices, size] of cases) {
      const encoded = lzwEncode(indices, size);
      expect(encoded[0]).toBe(size);
      expect(encoded[encoded.length - 1]).toBe(0);
      expect(lzwDecode(encoded)).toEqual(Array.from(indices));
    }
  });

  it('quantizes to at most maxColors and maps pixels', () => {
    const rgba = gradient(64, 32);
    const palette = quantize(rgba, 16);
    expect(palette.size).toBeLessThanOrEqual(16);
    expect(palette.size).toBeGreaterThan(8);
    const plain = indexPixels(rgba, 64, 32, palette, false);
    const dithered = indexPixels(rgba, 64, 32, palette, true);
    expect(plain.length).toBe(64 * 32);
    expect(Math.max(...plain)).toBeLessThan(palette.size);
    expect(Math.max(...dithered)).toBeLessThan(palette.size);
    expect(dithered).not.toEqual(plain);
    const solid = new Uint8ClampedArray(16).fill(255);
    const two = quantize(solid, 256);
    expect(two.size).toBe(2);
    expect(Array.from(two.colors.subarray(0, 3))).toEqual([252, 252, 252]);
  });

  it('writes a valid GIF89a stream with loop, delays and trailer', async () => {
    const encoder = new GifEncoder(32, 16, { dither: true, loop: 0, maxColors: 256 }, new PacketStore(256));
    encoder.addFrame(gradient(32, 16), frameDelayCentiseconds(0, 12));
    encoder.addFrame(gradient(32, 16).map((v) => 255 - v), frameDelayCentiseconds(1, 12));
    expect(encoder.frameCount).toBe(2);
    expect(encoder.bytesWritten).toBeGreaterThan(100);
    const blob = encoder.finish();
    expect(encoder.finish()).toBe(blob);
    expect(blob.type).toBe('image/gif');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(new TextDecoder().decode(bytes.subarray(0, 6))).toBe('GIF89a');
    expect((bytes[6] ?? 0) | ((bytes[7] ?? 0) << 8)).toBe(32);
    expect((bytes[8] ?? 0) | ((bytes[9] ?? 0) << 8)).toBe(16);
    expect(new TextDecoder().decode(bytes.subarray(16, 27))).toBe('NETSCAPE2.0');
    expect(bytes[bytes.length - 1]).toBe(0x3b);
    // First graphic control extension right after the header.
    expect(Array.from(bytes.subarray(32, 36))).toEqual([0x21, 0xf9, 0x04, 0x04]);
    expect(bytes[36]).toBe(8);
    // Decode the first frame and compare with a direct quantization.
    const descriptor = 40;
    expect(bytes[descriptor]).toBe(0x2c);
    const packed = bytes[descriptor + 9] ?? 0;
    const tableSize = 1 << ((packed & 7) + 1);
    const dataStart = descriptor + 10 + tableSize * 3;
    const decoded = lzwDecode(bytes.subarray(dataStart));
    expect(decoded.length).toBe(32 * 16);
  });

  it('rejects invalid sizes, short frames and late frames', () => {
    expect(() => new GifEncoder(0, 10, { dither: false, loop: 0, maxColors: 256 })).toThrow(ExportError);
    const encoder = new GifEncoder(4, 4, { dither: false, loop: 3, maxColors: 4 });
    expect(() => encoder.finish()).toThrow(/fotogramas/);
    expect(() => encoder.addFrame(new Uint8ClampedArray(8), 10)).toThrow(/incompleto/);
    encoder.addFrame(new Uint8ClampedArray(64), 10);
    encoder.finish();
    expect(() => encoder.addFrame(new Uint8ClampedArray(64), 10)).toThrow(/finalizado/);
    encoder.abort();
  });
});
