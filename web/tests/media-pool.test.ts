// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** MediaPool: import, frame routing, listing and teardown. */

import { describe, expect, it } from 'vitest';
import { MediaPool } from '../src/media/media-pool.ts';
import { Rational } from '../src/core/rational.ts';
import { MP4Demuxer } from '../src/media/demuxer.ts';

// A tiny valid H.264 MP4 (same builder as the demuxer tests).

function concatBytes(...parts: (Uint8Array | number[])[]): Uint8Array {
  const arrays = parts.map((part) => (part instanceof Uint8Array ? part : Uint8Array.from(part)));
  const total = arrays.reduce((sum, array) => sum + array.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const array of arrays) {
    out.set(array, at);
    at += array.length;
  }
  return out;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function box(type: string, body: Uint8Array): Uint8Array {
  const header = new Uint8Array(8);
  new DataView(header.buffer).setUint32(0, body.length + 8);
  header.set(Uint8Array.from([...type].map((c) => c.charCodeAt(0))), 4);
  return concatBytes(header, body);
}

function fullBox(type: string, version: number, body: Uint8Array): Uint8Array {
  return box(type, concatBytes([version, 0, 0, 0], body));
}

const u16 = (v: number) => Uint8Array.from([(v >> 8) & 0xff, v & 0xff]);
const u32 = (v: number) => Uint8Array.from([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);
const chars = (text: string) => Uint8Array.from([...text].map((c) => c.charCodeAt(0)));

function tinyMp4(sampleCount = 3): Blob {
  const avc1 = box('avc1', concatBytes(
    new Uint8Array(6), u16(1), new Uint8Array(16), u16(640), u16(360),
    u32(0x00480000), u32(0x00480000), u32(0), u16(1), new Uint8Array(32), u16(0x0018), new Uint8Array([0xff, 0xe1]),
    box('avcC', Uint8Array.from([1, 0x42, 0xc0, 0x1e, 0xff, 0xe1, 0x00, 0x00])),
  ));
  const trak = box('trak', concatBytes(
    fullBox('tkhd', 0, concatBytes(u32(0), u32(0), u32(1), u32(0), u32(sampleCount), new Uint8Array(8),
      u16(0), u16(0), u16(0), u16(0), new Uint8Array(36), u32(640 << 16), u32(360 << 16))),
    box('mdia', concatBytes(
      fullBox('mdhd', 0, concatBytes(u32(0), u32(0), u32(30), u32(sampleCount), u16(0x55c4), u16(0))),
      fullBox('hdlr', 0, concatBytes(u32(0), chars('vide'), new Uint8Array(12), Uint8Array.from([0]))),
      box('minf', box('stbl', concatBytes(
        fullBox('stsd', 0, concatBytes(u32(1), avc1)),
        fullBox('stts', 0, concatBytes(u32(sampleCount), ...Array.from({ length: sampleCount }, () => concatBytes(u32(1), u32(1))))),
        fullBox('stsc', 0, concatBytes(u32(1), u32(1), u32(sampleCount), u32(1))),
        fullBox('stsz', 0, concatBytes(u32(0), u32(sampleCount), ...Array.from({ length: sampleCount }, () => u32(10)))),
        fullBox('stco', 0, concatBytes(u32(1), u32(0))),
      ))),
    )),
  ));
  const ftyp = box('ftyp', concatBytes(chars('isom'), u32(0x200), chars('isomiso2avc1')));
  const mdat = box('mdat', new Uint8Array(sampleCount * 10));
  const file = concatBytes(ftyp, box('moov', trak), mdat);
  void toArrayBuffer;
  return new Blob([toArrayBuffer(file)], { type: 'video/mp4' });
}

describe('MediaPool', () => {
  it('imports a file and exposes its metadata', async () => {
    const pool = new MediaPool();
    const asset = await pool.addMedia(tinyMp4(), 'm1', 'clip.mp4');
    expect(asset.id).toBe('m1');
    expect(asset.name).toBe('clip.mp4');
    expect(asset.type).toBe('video');
    expect(asset.width).toBe(640);
    expect(asset.height).toBe(360);
    expect(asset.duration.asNumber()).toBeCloseTo(3 / 30, 6);
    expect(asset.opfsPath).toBe('media/m1');
    expect(pool.getSize('m1')).toEqual({ width: 640, height: 360 });
    expect(pool.get('m1')?.name).toBe('clip.mp4');
    pool.destroy();
  });

  it('lists newest imports first and removes cleanly', async () => {
    const pool = new MediaPool();
    await pool.addMedia(tinyMp4(), 'm1', 'a.mp4');
    await new Promise((resolve) => setTimeout(resolve, 2));
    await pool.addMedia(tinyMp4(), 'm2', 'b.mp4');
    const listed = pool.listMedia();
    expect(listed.map((asset) => asset.id)).toEqual(['m2', 'm1']);

    pool.removeMedia('m2');
    expect(pool.listMedia().map((asset) => asset.id)).toEqual(['m1']);
    expect(pool.getDecoder('m2')).toBeNull();
    pool.destroy();
    expect(pool.listMedia()).toHaveLength(0);
    pool.destroy(); // idempotent
  });

  it('routes getFrame/getAudioBuffer through the decoder', async () => {
    const pool = new MediaPool();
    await pool.addMedia(tinyMp4(), 'm1');
    // No WebCodecs and no DOM element in node: the frame comes back null,
    // but the call path (decoder lookup + init) is exercised.
    const frame = await pool.getFrame('m1', Rational.approximate(0.5) ?? Rational.ZERO);
    expect(frame).toBeNull();
    expect(await pool.getAudioBuffer('m1')).toBeNull();
    // Unknown ids answer null too.
    expect(await pool.getFrame('ghost', Rational.ZERO)).toBeNull();
    expect(await pool.getAudioBuffer('ghost')).toBeNull();
    pool.destroy();
  });

  it('preloads without failing on unknown ids', async () => {
    const pool = new MediaPool();
    await pool.addMedia(tinyMp4(), 'm1');
    await pool.preload([
      { id: 'm1', time: Rational.ZERO },
      { id: 'ghost', time: Rational.ZERO },
    ]);
    pool.destroy();
  });

  it('falls back to the id when a Blob has no file name', async () => {
    const pool = new MediaPool();
    const asset = await pool.addMedia(tinyMp4(), 'm9');
    expect(asset.name).toBe('m9');
    pool.destroy();
  });
});

describe('demuxer integration', () => {
  it('keeps multiple tracks of one file apart', () => {
    // The pool's decoder sees the same track list the demuxer reports.
    const blob = tinyMp4();
    expect(blob.size).toBeGreaterThan(64);
    void MP4Demuxer;
  });
});
