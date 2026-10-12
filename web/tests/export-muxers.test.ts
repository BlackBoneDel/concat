// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

import { describe, expect, it } from 'vitest';
import {
  Mp4MuxerAdapter,
  aacAudioSpecificConfig,
  av1ConfigFromCodec,
  box,
  sampleTables,
  topLevelBoxes,
  videoTimescale,
} from '../src/export/mp4-muxer-adapter.ts';
import { EBML_IDS, WebmMuxerAdapter, ebmlHeader, opusHead, vint } from '../src/export/webm-muxer-adapter.ts';
import { ByteWriter, PacketStore } from '../src/export/packet-store.ts';
import { ExportError, type AudioTrackInfo, type EncodedPacket, type VideoTrackInfo } from '../src/export/types.ts';

const AVCC = new Uint8Array([1, 0x64, 0, 0x28, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0, 0x28, 1, 0, 2, 0x68, 0xee]);

function videoInfo(codec = 'avc1.640028', description: Uint8Array<ArrayBuffer> | null = AVCC.slice()): VideoTrackInfo {
  return { codec, width: 320, height: 180, frameRate: { num: 30, den: 1 }, description };
}

function packet(index: number, size: number, keyFrame: boolean, fill = index, fps = 30): EncodedPacket {
  return {
    data: new Uint8Array(size).fill(fill & 0xff),
    timestamp: Math.round((index * 1e6) / fps),
    duration: Math.round(1e6 / fps),
    keyFrame,
  };
}

function audioPacket(index: number): EncodedPacket {
  return { data: new Uint8Array(10).fill(200), timestamp: Math.round((index * 1024 * 1e6) / 48000), duration: 21333, keyFrame: true };
}

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

/** Finds a box by path inside an MP4. */
function findBox(bytes: Uint8Array, path: string[], start = 0, end = bytes.byteLength): Uint8Array | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = start;
  while (offset + 8 <= end) {
    const size = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (type === path[0]) {
      if (path.length === 1) return bytes.subarray(offset, offset + size);
      const headerExtra = type === 'stsd' ? 8 : 0;
      return findBox(bytes, path.slice(1), offset + 8 + headerExtra, offset + size);
    }
    if (size < 8) break;
    offset += size;
  }
  return null;
}

describe('packet store and byte writer', () => {
  it('seals batches and keeps offsets', async () => {
    const store = new PacketStore(10);
    expect(store.append(new Uint8Array([1, 2, 3, 4, 5, 6]))).toEqual({ offset: 0, size: 6 });
    expect(store.append(new Uint8Array([7, 8, 9, 10, 11]))).toEqual({ offset: 6, size: 5 });
    expect(store.batchCount).toBe(1);
    store.append(new Uint8Array([12]));
    expect(store.size).toBe(12);
    const all = await bytesOf(store.finish());
    expect(Array.from(all)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(Array.from(await bytesOf(store.slice({ offset: 6, size: 2 })))).toEqual([7, 8]);
    expect(() => store.append(new Uint8Array(1))).toThrow(/finalizado/);
    store.clear();
    expect(store.size).toBe(0);
  });

  it('writes big-endian and little-endian values and grows', () => {
    const writer = new ByteWriter(16);
    writer.u8(1).u16(0x0203).u24(0x040506).u32(0x0708090a).i16(-1).i32(-2).u64(5).f64(1).u16le(0x0102).u32le(0x01020304).fourcc('ab').ascii('Z').zeros(2);
    writer.patchU32(0, 0xdeadbeef);
    const bytes = writer.toBytes();
    expect(bytes.byteLength).toBe(writer.position);
    expect(Array.from(bytes.subarray(0, 4))).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect(String.fromCharCode(...bytes.subarray(38, 42))).toBe('ab  ');
  });
});

describe('mp4 muxer', () => {
  it('helpers: timescale, tables, configs', () => {
    expect(videoTimescale(30, 1)).toBe(90000);
    expect(videoTimescale(30000, 1001)).toBe(90000);
    expect(videoTimescale(24000, 1001)).toBe(24000);
    const samples = [0, 1, 2].map((i) => ({ offset: 0, size: 1, timestamp: Math.round((i * 1e6) / 30), duration: 33333, keyFrame: i === 0 }));
    const tables = sampleTables(samples, 90000);
    expect(tables.durations).toEqual([3000, 3000, 3000]);
    expect(tables.offsets).toBeNull();
    const reordered = sampleTables(
      [0, 3, 1, 2].map((i) => ({ offset: 0, size: 1, timestamp: i * 1000, duration: 1000, keyFrame: false })),
      1000,
    );
    expect(reordered.offsets).toEqual([0, 2, -1, -1]);
    expect(Array.from(aacAudioSpecificConfig(48000, 2))).toEqual([0x11, 0x90]);
    expect(Array.from(aacAudioSpecificConfig(44100, 1))).toEqual([0x12, 0x08]);
    expect(Array.from(av1ConfigFromCodec('av01.0.08M.08'))).toEqual([0x81, 0x08, 0x0c, 0]);
    expect(Array.from(av1ConfigFromCodec('av01.0.13H.10'))).toEqual([0x81, 0x0d, 0xcc, 0]);
    expect(Array.from(box('free').subarray(0, 8))).toEqual([0, 0, 0, 8, 0x66, 0x72, 0x65, 0x65]);
  });

  it('writes a faststart file whose chunk offsets point at the samples', async () => {
    const audio: AudioTrackInfo = { codec: 'mp4a.40.2', sampleRate: 48000, channels: 2, description: null };
    const muxer = new Mp4MuxerAdapter({ video: videoInfo(), audio, store: new PacketStore(64), audioBitrate: 128000 });
    for (let i = 0; i < 6; i += 1) muxer.addVideoPacket(packet(i, 20 + i, i % 3 === 0, i + 1));
    for (let i = 0; i < 4; i += 1) muxer.addAudioPacket(audioPacket(i));
    expect(muxer.sampleCounts).toEqual({ video: 6, audio: 4 });
    expect(muxer.bytesWritten).toBe(20 + 21 + 22 + 23 + 24 + 25 + 40);
    const blob = muxer.finalize();
    expect(muxer.finalize()).toBe(blob);
    expect(blob.type).toBe('video/mp4');
    const bytes = await bytesOf(blob);
    expect(topLevelBoxes(bytes).map(([type]) => type)).toEqual(['ftyp', 'moov', 'mdat']);
    expect(String.fromCharCode(...bytes.subarray(8, 12))).toBe('isom');
    const stbl = ['moov', 'trak', 'mdia', 'minf', 'stbl'];
    const stco = findBox(bytes, [...stbl, 'stco']);
    expect(stco).not.toBeNull();
    const view = new DataView(stco!.buffer, stco!.byteOffset, stco!.byteLength);
    expect(view.getUint32(12)).toBe(6);
    for (let i = 0; i < 6; i += 1) {
      const offset = view.getUint32(16 + i * 4);
      expect(bytes[offset]).toBe(i + 1);
      expect(bytes[offset + 19 + i]).toBe(i + 1);
    }
    const stss = findBox(bytes, [...stbl, 'stss'])!;
    const stssView = new DataView(stss.buffer, stss.byteOffset, stss.byteLength);
    expect([stssView.getUint32(12), stssView.getUint32(16), stssView.getUint32(20)]).toEqual([2, 1, 4]);
    expect(findBox(bytes, [...stbl, 'stsd', 'avc1'])).not.toBeNull();
    const stts = findBox(bytes, [...stbl, 'stts'])!;
    const sttsView = new DataView(stts.buffer, stts.byteOffset, stts.byteLength);
    expect([sttsView.getUint32(12), sttsView.getUint32(16), sttsView.getUint32(20)]).toEqual([1, 6, 3000]);
    const text = new TextDecoder('latin1').decode(bytes);
    expect(text).toContain('mp4a');
    expect(text).toContain('esds');
    expect(text).toContain('soun');
  });

  it('supports AV1 and Opus entries and rejects bad states', async () => {
    const muxer = new Mp4MuxerAdapter({ video: videoInfo('av01.0.04M.08', null), audio: null });
    muxer.setAudioTrack({ codec: 'opus', sampleRate: 48000, channels: 2, description: opusHead(2, 48000, 120) });
    muxer.addVideoPacket(packet(0, 8, true));
    muxer.addAudioPacket(audioPacket(0));
    const text = new TextDecoder('latin1').decode(await bytesOf(muxer.finalize()));
    expect(text).toContain('av01');
    expect(text).toContain('av1C');
    expect(text).toContain('dOps');
    expect(() => muxer.addVideoPacket(packet(1, 1, false))).toThrow(ExportError);

    expect(() => new Mp4MuxerAdapter({ video: videoInfo(), audio: null }).finalize()).toThrow(/fotogramas/);
    const noAvcc = new Mp4MuxerAdapter({ video: videoInfo('avc1.42E01E', null), audio: null });
    noAvcc.addVideoPacket(packet(0, 4, true));
    expect(() => noAvcc.finalize()).toThrow(/avcC/);
    const vp9 = new Mp4MuxerAdapter({ video: videoInfo('vp09.00.10.08', null), audio: null });
    vp9.addVideoPacket(packet(0, 4, true));
    expect(() => vp9.finalize()).toThrow(/no admite/);
    const silent = new Mp4MuxerAdapter({ video: videoInfo(), audio: null });
    expect(() => silent.addAudioPacket(audioPacket(0))).toThrow(/sin pista/);
    silent.addVideoPacket(packet(0, 4, true));
    silent.abort();
    expect(() => silent.finalize()).toThrow(ExportError);
    expect(() => silent.addVideoPacket(packet(1, 4, true))).toThrow(ExportError);
  });
});

/** Minimal EBML reader for assertions. */
function readVint(bytes: Uint8Array, offset: number, keepMarker: boolean): { value: number; length: number } {
  const first = bytes[offset] ?? 0;
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length += 1;
  let value = keepMarker ? first : first & ((0x80 >> (length - 1)) - 1);
  for (let i = 1; i < length; i += 1) value = value * 256 + (bytes[offset + i] ?? 0);
  return { value, length };
}

function children(bytes: Uint8Array, start: number, end: number): { id: number; start: number; dataStart: number; end: number }[] {
  const out: { id: number; start: number; dataStart: number; end: number }[] = [];
  let offset = start;
  while (offset < end) {
    const id = readVint(bytes, offset, true);
    const size = readVint(bytes, offset + id.length, false);
    const dataStart = offset + id.length + size.length;
    out.push({ id: id.value, start: offset, dataStart, end: dataStart + size.value });
    offset = dataStart + size.value;
  }
  return out;
}

describe('webm muxer', () => {
  it('encodes vints and headers', () => {
    expect(Array.from(vint(1))).toEqual([0x81]);
    expect(Array.from(vint(127))).toEqual([0x40, 0x7f]);
    expect(Array.from(vint(5, 8))).toEqual([1, 0, 0, 0, 0, 0, 0, 5]);
    expect(new TextDecoder().decode(ebmlHeader())).toContain('webm');
    const head = opusHead(2, 48000, 312);
    expect(new TextDecoder().decode(head.subarray(0, 8))).toBe('OpusHead');
    expect((head[10] ?? 0) | ((head[11] ?? 0) << 8)).toBe(312);
  });

  it('writes clusters, interleaved blocks, cues and a seek head', async () => {
    const muxer = new WebmMuxerAdapter({ video: videoInfo('vp09.00.10.08', null), audio: { codec: 'opus', sampleRate: 48000, channels: 2, description: null }, store: new PacketStore(50) });
    for (let i = 0; i < 90; i += 1) muxer.addVideoPacket(packet(i, 12, i % 30 === 0));
    for (let i = 0; i < 140; i += 1) muxer.addAudioPacket(audioPacket(i));
    expect(muxer.bytesWritten).toBe(90 * 12 + 140 * 10);
    const blob = muxer.finalize();
    expect(blob.type).toBe('video/webm');
    const bytes = await bytesOf(blob);
    const top = children(bytes, 0, bytes.byteLength);
    expect(top.map((e) => e.id)).toEqual([EBML_IDS.EBML, EBML_IDS.Segment]);
    const segment = top[1]!;
    expect(segment.end).toBe(bytes.byteLength);
    const level1 = children(bytes, segment.dataStart, segment.end);
    const ids = level1.map((e) => e.id);
    expect(ids[0]).toBe(EBML_IDS.SeekHead);
    expect(ids[1]).toBe(EBML_IDS.Info);
    expect(ids[2]).toBe(EBML_IDS.Tracks);
    expect(ids[ids.length - 1]).toBe(EBML_IDS.Cues);
    const clusters = level1.filter((e) => e.id === EBML_IDS.Cluster);
    expect(clusters.length).toBe(3);
    let blocks = 0;
    let lastTime = -1;
    for (const cluster of clusters) {
      const inner = children(bytes, cluster.dataStart, cluster.end);
      expect(inner[0]?.id).toBe(EBML_IDS.Timestamp);
      for (const block of inner.slice(1)) {
        expect(block.id).toBe(EBML_IDS.SimpleBlock);
        blocks += 1;
      }
      const first = inner[1]!;
      expect(bytes[first.dataStart]).toBe(0x81);
      expect(bytes[first.dataStart + 3]).toBe(0x80);
      const time = inner[0]!;
      const ms = readVint(bytes, time.dataStart - 1, false) && bytes.subarray(time.dataStart, time.end).reduce((acc, b) => acc * 256 + b, 0);
      expect(ms).toBeGreaterThan(lastTime);
      lastTime = ms;
    }
    expect(blocks).toBe(230);
    const cues = level1[level1.length - 1]!;
    const cuePoints = children(bytes, cues.dataStart, cues.end);
    expect(cuePoints.length).toBe(3);
    // The first cue's cluster position resolves to the first cluster.
    const positions = children(bytes, cuePoints[0]!.dataStart, cuePoints[0]!.end);
    const trackPositions = children(bytes, positions[1]!.dataStart, positions[1]!.end);
    const clusterPos = bytes.subarray(trackPositions[1]!.dataStart, trackPositions[1]!.end).reduce((acc, b) => acc * 256 + b, 0);
    expect(segment.dataStart + clusterPos).toBe(clusters[0]!.start);
    // The seek head's Cues entry points at the Cues element.
    const seeks = children(bytes, level1[0]!.dataStart, level1[0]!.end);
    const cueSeek = children(bytes, seeks[2]!.dataStart, seeks[2]!.end);
    const seekPos = bytes.subarray(cueSeek[1]!.dataStart, cueSeek[1]!.end).reduce((acc, b) => acc * 256 + b, 0);
    expect(segment.dataStart + seekPos).toBe(cues.start);
    const text = new TextDecoder('latin1').decode(bytes);
    expect(text).toContain('V_VP9');
    expect(text).toContain('A_OPUS');
    expect(text).toContain('OpusHead');
  });

  it('handles AV1, silent files and invalid input', async () => {
    const muxer = new WebmMuxerAdapter({ video: videoInfo('av01.0.04M.08', null), audio: null });
    muxer.setVideoTrack(videoInfo('av01.0.08M.08', null));
    muxer.addVideoPacket(packet(0, 4, true));
    const text = new TextDecoder('latin1').decode(await bytesOf(muxer.finalize()));
    expect(text).toContain('V_AV1');
    expect(text).not.toContain('A_OPUS');
    const h264 = new WebmMuxerAdapter({ video: videoInfo(), audio: null });
    h264.addVideoPacket(packet(0, 4, true));
    expect(() => h264.finalize()).toThrow(/WebM no admite/);
    const aac = new WebmMuxerAdapter({ video: videoInfo('vp09.00.10.08'), audio: { codec: 'mp4a.40.2', sampleRate: 48000, channels: 2, description: null } });
    aac.addVideoPacket(packet(0, 4, true));
    aac.addAudioPacket(audioPacket(0));
    expect(() => aac.finalize()).toThrow(/audio/);
    const empty = new WebmMuxerAdapter({ video: videoInfo('vp09.00.10.08'), audio: null });
    expect(() => empty.finalize()).toThrow(/fotogramas/);
    expect(() => empty.addAudioPacket(audioPacket(0))).toThrow(/sin pista/);
    empty.abort();
    expect(() => empty.addVideoPacket(packet(0, 1, true))).toThrow(ExportError);
    expect(() => empty.finalize()).toThrow(ExportError);
  });

  it('splits clusters before the 16-bit timecode overflows', async () => {
    const muxer = new WebmMuxerAdapter({ video: videoInfo('vp09.00.10.08'), audio: null });
    for (let i = 0; i < 40; i += 1) muxer.addVideoPacket(packet(i, 2, i === 0, i, 1));
    const bytes = await bytesOf(muxer.finalize());
    const segment = children(bytes, 0, bytes.byteLength)[1]!;
    const clusters = children(bytes, segment.dataStart, segment.end).filter((e) => e.id === EBML_IDS.Cluster);
    expect(clusters.length).toBe(2);
  });
});
