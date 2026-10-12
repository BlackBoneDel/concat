// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Container sniffing and the MP4 demuxer over synthetic files. */

import { describe, expect, it } from 'vitest';
import { MP4Demuxer, detectContainer } from '../src/media/demuxer.ts';

// -- a minimal ISO-BMFF builder for the tests ------------------------------

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

/** The bytes as a standalone `ArrayBuffer` (never a shared one). */
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

function u16(value: number): Uint8Array {
  return Uint8Array.from([(value >> 8) & 0xff, value & 0xff]);
}

function u32(value: number): Uint8Array {
  return Uint8Array.from([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function avc1Entry(): Uint8Array {
  const payload = concatBytes(
    new Uint8Array(6), // reserved
    u16(1), // data reference index
    new Uint8Array(16), // pre_defined + reserved + pre_defined[3]
    u16(640), // width at payload offset 24
    u16(360), // height
    u32(0x00480000), // horizresolution 72dpi
    u32(0x00480000), // vertresolution
    u32(0), // reserved
    u16(1), // frame_count
    new Uint8Array(32), // compressorname
    u16(0x0018), // depth
    new Uint8Array([0xff, 0xe1]), // pre_defined (-1)
    box('avcC', Uint8Array.from([1, 0x42, 0xc0, 0x1e, 0xff, 0xe1, 0x00, 0x00])),
  );
  return box('avc1', payload);
}

function mp4aEntry(): Uint8Array {
  const payload = concatBytes(
    new Uint8Array(6),
    u16(1), // data reference index
    new Uint8Array(8), // reserved u32[2]
    u16(2), // channelcount at payload offset 16
    u16(16), // samplesize
    u16(0), // pre_defined
    u16(0), // reserved
    u32(48000 << 16), // samplerate 16.16 at payload offset 24
    fullBox(
      'esds',
      0,
      // ES_Descriptor → DecoderConfigDescriptor → DecoderSpecificInfo.
      Uint8Array.from([
        0x03, 0x19, 0x00, 0x01, 0x00,
        0x04, 0x11, 0x40, 0x15, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x05, 0x02, 0x12, 0x10,
      ]),
    ),
  );
  return box('mp4a', payload);
}

interface TrackSpec {
  kind: 'video' | 'audio';
  timescale: number;
  samples: { size: number; delta: number }[];
  chunkOffset: number;
}

function trak(spec: TrackSpec): Uint8Array {
  const entry = spec.kind === 'video' ? avc1Entry() : mp4aEntry();
  const tkhd = fullBox(
    'tkhd',
    0,
    concatBytes(
      u32(0), // creation
      u32(0), // modification
      u32(1), // track id
      u32(0), // reserved
      u32(spec.samples.reduce((sum, sample) => sum + sample.delta, 0)), // duration (ticks)
      new Uint8Array(8), // reserved
      u16(0), // layer
      u16(0), // alternate group
      u16(0), // volume
      u16(0), // reserved
      new Uint8Array(36), // matrix
      u32((spec.kind === 'video' ? 640 : 0) << 16), // width 16.16 at end-8
      u32((spec.kind === 'video' ? 360 : 0) << 16), // height at end-4
    ),
  );
  const mdhd = fullBox(
    'mdhd',
    0,
    concatBytes(
      u32(0),
      u32(0),
      u32(spec.timescale),
      u32(spec.samples.reduce((sum, sample) => sum + sample.delta, 0)),
      u16(0x55c4), // language
      u16(0),
    ),
  );
  const hdlr = fullBox('hdlr', 0, concatBytes(u32(0), [...(spec.kind === 'video' ? 'vide' : 'soun')].map((c) => c.charCodeAt(0)), new Uint8Array(12), Uint8Array.from([0])));
  const stsd = fullBox('stsd', 0, concatBytes(u32(1), entry));
  const stts = fullBox(
    'stts',
    0,
    concatBytes(u32(spec.samples.length), ...spec.samples.map((sample) => concatBytes(u32(1), u32(sample.delta)))),
  );
  const stsc = fullBox('stsc', 0, concatBytes(u32(1), u32(1), u32(spec.samples.length), u32(1)));
  const stsz = fullBox(
    'stsz',
    0,
    concatBytes(u32(0), u32(spec.samples.length), ...spec.samples.map((sample) => u32(sample.size))),
  );
  const stco = fullBox('stco', 0, concatBytes(u32(1), u32(spec.chunkOffset)));
  const stbl = box('stbl', concatBytes(stsd, stts, stsc, stsz, stco));
  const minf = box('minf', stbl);
  const mdia = box('mdia', concatBytes(mdhd, hdlr, minf));
  return box('trak', concatBytes(tkhd, mdia));
}

function buildMp4(tracks: TrackSpec[], mdatPayload: Uint8Array): ArrayBuffer {
  const ftyp = box('ftyp', concatBytes([...'isom'].map((c) => c.charCodeAt(0)), u32(0x200), [...'isomiso2avc1'].map((c) => c.charCodeAt(0))));
  // Layout: ftyp | moov | mdat. The moov size depends on the traks, so put
  // the mdat at a fixed offset after both and fix up the chunk offset.
  const mdatHeaderSize = 8;
  const provisional = concatBytes(
    ftyp,
    box('moov', concatBytes(...tracks.map((spec) => trak({ ...spec, chunkOffset: 0 })))),
    box('mdat', mdatPayload),
  );
  const moovStart = ftyp.length;
  const moovSize = new DataView(provisional.buffer, moovStart, 4).getUint32(0);
  const mdatStart = moovStart + moovSize;
  const payloadOffset = mdatStart + mdatHeaderSize;
  return toArrayBuffer(
    concatBytes(
      ftyp,
      box('moov', concatBytes(...tracks.map((spec) => trak({ ...spec, chunkOffset: payloadOffset })))),
      box('mdat', mdatPayload),
    ),
  );
}

function blobOf(bytes: Uint8Array): Blob {
  return new Blob([toArrayBuffer(bytes)], { type: 'application/octet-stream' });
}

/** Bytes of a string literal. */
function str(text: string): number[] {
  return [...text].map((character) => character.charCodeAt(0));
}

// -- detectContainer -------------------------------------------------------

describe('detectContainer', () => {
  it('recognizes the containers by magic bytes', async () => {
    const cases: { bytes: number[]; kind: string }[] = [
      { bytes: str('\x00\x00\x00\x20ftypisom'), kind: 'mp4' },
      { bytes: str('\x00\x00\x00\x20ftypqt  '), kind: 'mov' },
      { bytes: [0x1a, 0x45, 0xdf, 0xa3, 0, 0], kind: 'webm' },
      { bytes: str('RIFF\x00\x00\x00\x00WAVE'), kind: 'wav' },
      { bytes: str('RIFF\x00\x00\x00\x00WEBP'), kind: 'webp' },
      { bytes: str('ID3\x03\x00\x00\x00'), kind: 'mp3' },
      { bytes: [0xff, 0xfb, 0x90, 0x00], kind: 'mp3' },
      { bytes: str('OggS\x00\x02'), kind: 'ogg' },
      { bytes: str('fLaC\x00\x00\x00\x22'), kind: 'flac' },
      { bytes: [0x89, ...str('PNG\r\n\x1a\n')], kind: 'png' },
      { bytes: [0xff, 0xd8, 0xff, 0xe0], kind: 'jpeg' },
      { bytes: str('GIF89a\x00\x00'), kind: 'gif' },
      { bytes: [0x00, 0x01, 0x02, 0x03], kind: 'unknown' },
    ];
    for (const { bytes, kind } of cases) {
      expect(await detectContainer(blobOf(Uint8Array.from(bytes)))).toBe(kind);
    }
  });
});

// -- MP4Demuxer ------------------------------------------------------------

describe('MP4Demuxer', () => {
  it('parses a video track: codec, size and samples', () => {
    const payload = new Uint8Array(30);
    const mp4 = buildMp4(
      [{ kind: 'video', timescale: 30, samples: [{ size: 10, delta: 1 }, { size: 10, delta: 1 }, { size: 10, delta: 1 }], chunkOffset: 0 }],
      payload,
    );
    const demuxer = MP4Demuxer.open(mp4);
    expect(demuxer).not.toBeNull();
    expect(demuxer!.tracks).toHaveLength(1);
    const track = demuxer!.tracks[0]!;
    expect(track.kind).toBe('video');
    expect(track.codec).toBe('avc1.42c01e');
    expect(track.width).toBe(640);
    expect(track.height).toBe(360);
    expect(track.timescale).toBe(30);
    expect(track.samples).toHaveLength(3);
    expect(track.samples[0]!.key).toBe(true); // no stss → every sample sync
    expect(track.samples[1]!.cts).toBeCloseTo(1 / 30, 6);
    expect(track.samples[2]!.cts).toBeCloseTo(2 / 30, 6);
    expect(track.description).not.toBeNull();
    expect(track.description![1]).toBe(0x42);
  });

  it('resolves sample offsets into the mdat', () => {
    // The chunks start at the mdat payload: two 10-byte samples back to back.
    const payload = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    const mp4 = buildMp4(
      [{ kind: 'video', timescale: 30, samples: [{ size: 10, delta: 1 }, { size: 10, delta: 1 }], chunkOffset: 0 }],
      payload,
    );
    const demuxer = MP4Demuxer.open(mp4)!;
    const track = demuxer.tracks[0]!;
    const first = demuxer.sampleBytes(track, 0);
    const second = demuxer.sampleBytes(track, 1);
    expect([...first]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect([...second]).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  });

  it('parses an AAC audio track with its config record', () => {
    const mp4 = buildMp4(
      [{ kind: 'audio', timescale: 48000, samples: [{ size: 8, delta: 1024 }, { size: 8, delta: 1024 }], chunkOffset: 0 }],
      new Uint8Array(16),
    );
    const demuxer = MP4Demuxer.open(mp4)!;
    const track = demuxer.tracks[0]!;
    expect(track.kind).toBe('audio');
    expect(track.codec).toBe('mp4a.40.2');
    expect(track.channels).toBe(2);
    expect(track.sampleRate).toBe(48000);
    expect(track.description).not.toBeNull();
    expect([...track.description!]).toEqual([0x12, 0x10]);
  });

  it('finds samples by time and keyframes before them', () => {
    const mp4 = buildMp4(
      [
        {
          kind: 'video',
          timescale: 30,
          samples: [
            { size: 5, delta: 1 },
            { size: 5, delta: 1 },
            { size: 5, delta: 1 },
            { size: 5, delta: 1 },
          ],
          chunkOffset: 0,
        },
      ],
      new Uint8Array(20),
    );
    const demuxer = MP4Demuxer.open(mp4)!;
    const track = demuxer.tracks[0]!;
    expect(MP4Demuxer.sampleAt(track, 0)).toBe(0);
    expect(MP4Demuxer.sampleAt(track, 0.05)).toBe(1); // between samples 1 and 2
    expect(MP4Demuxer.sampleAt(track, 2.5 / 30)).toBe(2);
    expect(MP4Demuxer.sampleAt(track, 999)).toBe(3); // past the end: the last
    // All samples are sync (no stss): the keyframe is the sample itself.
    expect(MP4Demuxer.keyframeBefore(track, 3)).toBe(3);
  });

  it('returns null for empty or broken files', () => {
    expect(MP4Demuxer.open(new ArrayBuffer(0))).toBeNull();
    expect(MP4Demuxer.open(toArrayBuffer(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])))).toBeNull();
    // ftyp without moov: no tracks.
    const ftypOnly = box('ftyp', concatBytes([...'isom'].map((c) => c.charCodeAt(0)), u32(0)));
    expect(MP4Demuxer.open(toArrayBuffer(ftypOnly))).toBeNull();
  });

  it('rejects a track without samples', () => {
    const mp4 = buildMp4(
      [{ kind: 'video', timescale: 30, samples: [], chunkOffset: 0 }],
      new Uint8Array(0),
    );
    expect(MP4Demuxer.open(mp4)).toBeNull();
  });
});
