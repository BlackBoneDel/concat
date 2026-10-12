// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Fase 6: an ISO-BMFF (MP4) writer, written for this project — no network,
 * no vendored muxer. Layout is "faststart": `ftyp`, `moov`, then `mdat`, so
 * the file plays before it fully downloads. Encoded bytes stream into a
 * {@link PacketStore} while the export runs; `finalize` builds the sample
 * tables (stts/ctts/stss/stsc/stsz/stco|co64) and the final `Blob` from the
 * store's sealed batches without copying the media data.
 *
 * Video: `avc1` + `avcC` (from `decoderConfig.description`) or `av01` +
 * `av1C`. Audio: `mp4a` + `esds` (AAC AudioSpecificConfig) or `Opus` +
 * `dOps`. The desktop app hands this job to FFmpeg's mov muxer
 * (`src/crates/concat-export/src/lib.rs`, `-movflags +faststart`).
 */

import { ByteWriter, PacketStore } from './packet-store.ts';
import { ExportError, type AudioTrackInfo, type EncodedPacket, type MuxerAdapter, type VideoTrackInfo } from './types.ts';

/** One stored sample. */
interface Sample {
  offset: number;
  size: number;
  timestamp: number;
  duration: number;
  keyFrame: boolean;
}

/** A track's sample tables, in its media timescale. */
interface SampleTables {
  timescale: number;
  durations: number[];
  /** Composition offsets (`null` when presentation order = decode order). */
  offsets: number[] | null;
  total: number;
}

const MOVIE_TIMESCALE = 1000;
const MAX_U32 = 0xffffffff;
const IDENTITY_MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];

/** Builds a box from its type and payload parts. */
export function box(type: string, ...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const size = 8 + parts.reduce((sum, part) => sum + part.byteLength, 0);
  const writer = new ByteWriter(size);
  writer.u32(size).fourcc(type);
  for (const part of parts) writer.bytes(part);
  return writer.toBytes();
}

/** Builds a full box (version + flags header). */
export function fullBox(type: string, version: number, flags: number, ...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const header = new ByteWriter(4).u8(version).u24(flags).toBytes();
  return box(type, header, ...parts);
}

/**
 * The video media timescale: 90 kHz when every frame lands on a whole tick,
 * else the rate's numerator (24000/1001 → 24000, frames of 1001 ticks).
 * @param num frame rate numerator.
 * @param den frame rate denominator.
 * @returns ticks per second.
 */
export function videoTimescale(num: number, den: number): number {
  if (num > 0 && den > 0 && (90_000 * den) % num === 0) return 90_000;
  return Math.max(1, num);
}

/**
 * Converts packet timestamps to sample durations (and composition offsets
 * when the encoder reordered frames).
 * @param samples samples in decode order.
 * @param timescale media ticks per second.
 * @returns the tables.
 */
export function sampleTables(samples: readonly Sample[], timescale: number): SampleTables {
  const ticks = (micros: number): number => Math.round((micros * timescale) / 1_000_000);
  const pts = samples.map((sample) => ticks(sample.timestamp));
  const sorted = [...pts].sort((a, b) => a - b);
  const reordered = pts.some((value, index) => value !== sorted[index]);
  const dts = reordered ? sorted : pts;
  const durations: number[] = [];
  for (let i = 0; i < samples.length; i += 1) {
    const next = dts[i + 1];
    const own = Math.max(1, ticks(samples[i]?.duration ?? 0));
    const current = dts[i] ?? 0;
    durations.push(next !== undefined ? Math.max(0, next - current) : own);
  }
  const offsets = reordered ? pts.map((value, index) => value - (dts[index] ?? 0)) : null;
  const total = durations.reduce((sum, value) => sum + value, 0);
  return { timescale, durations, offsets, total };
}

/** Run-length pairs of a number list. */
function runs(values: readonly number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const value of values) {
    const last = out[out.length - 1];
    if (last && last[1] === value) last[0] += 1;
    else out.push([1, value]);
  }
  return out;
}

/**
 * A minimal `av1C` from the codec string (`av01.P.LLT.DD`) when the encoder
 * gave no description; the sequence header travels in-band.
 * @param codec the codec string.
 * @returns the 4-byte record.
 */
export function av1ConfigFromCodec(codec: string): Uint8Array<ArrayBuffer> {
  const [, profileText = '0', levelTier = '04M', depthText = '08'] = codec.split('.');
  const profile = Number.parseInt(profileText, 10) & 0x7;
  const level = Number.parseInt(levelTier, 10) & 0x1f;
  const tier = levelTier.endsWith('H') ? 1 : 0;
  const highBitdepth = Number.parseInt(depthText, 10) > 8 ? 1 : 0;
  const writer = new ByteWriter(4);
  writer.u8(0x81);
  writer.u8((profile << 5) | level);
  // tier, high_bitdepth, twelve_bit=0, monochrome=0, subsampling_x=1, subsampling_y=1, chroma_sample_position=0.
  writer.u8((tier << 7) | (highBitdepth << 6) | 0x0c);
  writer.u8(0);
  return writer.toBytes();
}

/**
 * An AAC-LC AudioSpecificConfig for a rate and channel count.
 * @param sampleRate Hz.
 * @param channels channel count.
 * @returns the 2-byte config.
 */
export function aacAudioSpecificConfig(sampleRate: number, channels: number): Uint8Array<ArrayBuffer> {
  const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  const index = Math.max(0, rates.indexOf(sampleRate));
  const value = (2 << 11) | (index << 7) | ((channels & 0xf) << 3);
  return new ByteWriter(2).u16(value).toBytes();
}

/** An MPEG-4 descriptor with a 4-byte expandable size. */
function descriptor(tag: number, ...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const size = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const writer = new ByteWriter(size + 5);
  writer.u8(tag).u8(0x80 | ((size >>> 21) & 0x7f)).u8(0x80 | ((size >>> 14) & 0x7f)).u8(0x80 | ((size >>> 7) & 0x7f)).u8(size & 0x7f);
  for (const part of parts) writer.bytes(part);
  return writer.toBytes();
}

/** The streaming MP4 writer. */
export class Mp4MuxerAdapter implements MuxerAdapter {
  private video: VideoTrackInfo;
  private audio: AudioTrackInfo | null;
  private readonly store: PacketStore;
  private readonly videoSamples: Sample[] = [];
  private readonly audioSamples: Sample[] = [];
  private readonly creationTime: number;
  private readonly audioBitrate: number;
  private finished: Blob | null = null;
  private aborted = false;

  /**
   * @param options track descriptions, an optional store and metadata.
   */
  constructor(options: { video: VideoTrackInfo; audio: AudioTrackInfo | null; store?: PacketStore; creationTime?: Date; audioBitrate?: number }) {
    this.video = options.video;
    this.audio = options.audio;
    this.store = options.store ?? new PacketStore();
    // Seconds since 1904-01-01 (the QuickTime epoch).
    this.creationTime = Math.floor((options.creationTime ?? new Date()).getTime() / 1000) + 2_082_844_800;
    this.audioBitrate = options.audioBitrate ?? 0;
  }

  /** Bytes accepted so far. */
  get bytesWritten(): number {
    return this.store.size;
  }

  /** Samples accepted per track. */
  get sampleCounts(): { video: number; audio: number } {
    return { video: this.videoSamples.length, audio: this.audioSamples.length };
  }

  setVideoTrack(info: VideoTrackInfo): void {
    this.video = info;
  }

  setAudioTrack(info: AudioTrackInfo | null): void {
    this.audio = info;
  }

  addVideoPacket(packet: EncodedPacket): void {
    this.add(this.videoSamples, packet);
  }

  addAudioPacket(packet: EncodedPacket): void {
    if (!this.audio) throw new ExportError('MUX_FAILED', 'Paquete de audio sin pista de audio.');
    this.add(this.audioSamples, packet);
  }

  /**
   * Writes the indexes and returns the file.
   * @returns the MP4 `Blob`.
   * @throws ExportError `MUX_FAILED` without video samples or codec config.
   */
  finalize(): Blob {
    if (this.finished) return this.finished;
    if (this.aborted) throw new ExportError('ABORTED');
    if (this.videoSamples.length === 0) throw new ExportError('MUX_FAILED', 'No hay fotogramas codificados que empaquetar.');
    const media = this.store.finish();
    const mediaSize = media.size;
    const large = mediaSize + 8 > MAX_U32;
    const co64 = mediaSize + 64 * 1024 * 1024 > MAX_U32;
    const ftyp = this.ftyp();
    const mdatHeader = large
      ? new ByteWriter(16).u32(1).fourcc('mdat').u64(mediaSize + 16).toBytes()
      : new ByteWriter(8).u32(mediaSize + 8).fourcc('mdat').toBytes();
    const measured = this.moov(0, co64);
    const base = ftyp.byteLength + measured.byteLength + mdatHeader.byteLength;
    const moov = this.moov(base, co64);
    if (moov.byteLength !== measured.byteLength) throw new ExportError('MUX_FAILED', 'Tamaño de moov inestable.');
    this.finished = new Blob([ftyp, moov, mdatHeader, media], { type: 'video/mp4' });
    return this.finished;
  }

  abort(): void {
    this.aborted = true;
    this.store.clear();
    this.videoSamples.length = 0;
    this.audioSamples.length = 0;
  }

  private add(samples: Sample[], packet: EncodedPacket): void {
    if (this.aborted) throw new ExportError('ABORTED');
    if (this.finished) throw new ExportError('MUX_FAILED', 'El MP4 ya está finalizado.');
    const ref = this.store.append(packet.data);
    samples.push({ offset: ref.offset, size: ref.size, timestamp: packet.timestamp, duration: packet.duration, keyFrame: packet.keyFrame });
  }

  private ftyp(): Uint8Array<ArrayBuffer> {
    const brands = ['isom', 'iso2', this.video.codec.startsWith('av01') ? 'av01' : 'avc1', 'mp41'];
    const writer = new ByteWriter(32).fourcc('isom').u32(0x200);
    for (const brand of brands) writer.fourcc(brand);
    return box('ftyp', writer.toBytes());
  }

  private moov(base: number, co64: boolean): Uint8Array<ArrayBuffer> {
    const videoTables = sampleTables(this.videoSamples, videoTimescale(this.video.frameRate.num, this.video.frameRate.den));
    const tracks: Uint8Array[] = [this.trak(1, 'video', videoTables, this.videoSamples, base, co64)];
    let longest = videoTables.total / videoTables.timescale;
    if (this.audio && this.audioSamples.length > 0) {
      const audioTables = sampleTables(this.audioSamples, this.audio.sampleRate);
      tracks.push(this.trak(2, 'audio', audioTables, this.audioSamples, base, co64));
      longest = Math.max(longest, audioTables.total / audioTables.timescale);
    }
    return box('moov', this.mvhd(Math.round(longest * MOVIE_TIMESCALE), tracks.length + 1), ...tracks);
  }

  private mvhd(duration: number, nextTrack: number): Uint8Array<ArrayBuffer> {
    const v1 = duration > MAX_U32;
    const writer = new ByteWriter(112);
    if (v1) writer.u64(this.creationTime).u64(this.creationTime).u32(MOVIE_TIMESCALE).u64(duration);
    else writer.u32(this.creationTime).u32(this.creationTime).u32(MOVIE_TIMESCALE).u32(duration);
    writer.u32(0x00010000).u16(0x0100).zeros(10);
    for (const value of IDENTITY_MATRIX) writer.u32(value);
    writer.zeros(24).u32(nextTrack);
    return fullBox('mvhd', v1 ? 1 : 0, 0, writer.toBytes());
  }

  private trak(id: number, kind: 'video' | 'audio', tables: SampleTables, samples: readonly Sample[], base: number, co64: boolean): Uint8Array<ArrayBuffer> {
    const movieDuration = Math.round((tables.total / tables.timescale) * MOVIE_TIMESCALE);
    return box('trak', this.tkhd(id, kind, movieDuration), box('mdia', this.mdhd(tables), this.hdlr(kind), this.minf(kind, tables, samples, base, co64)));
  }

  private tkhd(id: number, kind: 'video' | 'audio', duration: number): Uint8Array<ArrayBuffer> {
    const v1 = duration > MAX_U32;
    const writer = new ByteWriter(96);
    if (v1) writer.u64(this.creationTime).u64(this.creationTime).u32(id).u32(0).u64(duration);
    else writer.u32(this.creationTime).u32(this.creationTime).u32(id).u32(0).u32(duration);
    writer.zeros(8).i16(0).i16(kind === 'audio' ? 1 : 0).u16(kind === 'audio' ? 0x0100 : 0).u16(0);
    for (const value of IDENTITY_MATRIX) writer.u32(value);
    if (kind === 'video') writer.u32(this.video.width * 65536).u32(this.video.height * 65536);
    else writer.u32(0).u32(0);
    return fullBox('tkhd', v1 ? 1 : 0, 0x000003, writer.toBytes());
  }

  private mdhd(tables: SampleTables): Uint8Array<ArrayBuffer> {
    const v1 = tables.total > MAX_U32;
    const writer = new ByteWriter(40);
    if (v1) writer.u64(this.creationTime).u64(this.creationTime).u32(tables.timescale).u64(tables.total);
    else writer.u32(this.creationTime).u32(this.creationTime).u32(tables.timescale).u32(tables.total);
    writer.u16(0x55c4).u16(0);
    return fullBox('mdhd', v1 ? 1 : 0, 0, writer.toBytes());
  }

  private hdlr(kind: 'video' | 'audio'): Uint8Array<ArrayBuffer> {
    const name = kind === 'video' ? 'Concat Video' : 'Concat Audio';
    const writer = new ByteWriter(40).u32(0).fourcc(kind === 'video' ? 'vide' : 'soun').zeros(12).ascii(name).u8(0);
    return fullBox('hdlr', 0, 0, writer.toBytes());
  }

  private minf(kind: 'video' | 'audio', tables: SampleTables, samples: readonly Sample[], base: number, co64: boolean): Uint8Array<ArrayBuffer> {
    const header =
      kind === 'video'
        ? fullBox('vmhd', 0, 1, new ByteWriter(8).u16(0).zeros(6).toBytes())
        : fullBox('smhd', 0, 0, new ByteWriter(4).i16(0).u16(0).toBytes());
    const dinf = box('dinf', fullBox('dref', 0, 0, new ByteWriter(4).u32(1).toBytes(), fullBox('url ', 0, 1)));
    return box('minf', header, dinf, this.stbl(kind, tables, samples, base, co64));
  }

  private stbl(kind: 'video' | 'audio', tables: SampleTables, samples: readonly Sample[], base: number, co64: boolean): Uint8Array<ArrayBuffer> {
    const children: Uint8Array[] = [fullBox('stsd', 0, 0, new ByteWriter(4).u32(1).toBytes(), kind === 'video' ? this.videoEntry() : this.audioEntry())];
    const stts = runs(tables.durations);
    const sttsWriter = new ByteWriter(4 + stts.length * 8).u32(stts.length);
    for (const [count, delta] of stts) sttsWriter.u32(count).u32(delta);
    children.push(fullBox('stts', 0, 0, sttsWriter.toBytes()));
    if (tables.offsets) {
      const ctts = runs(tables.offsets);
      const writer = new ByteWriter(4 + ctts.length * 8).u32(ctts.length);
      for (const [count, offset] of ctts) writer.u32(count).i32(offset);
      children.push(fullBox('ctts', 1, 0, writer.toBytes()));
    }
    if (kind === 'video' && samples.some((sample) => !sample.keyFrame)) {
      const keys = samples.flatMap((sample, index) => (sample.keyFrame ? [index + 1] : []));
      const writer = new ByteWriter(4 + keys.length * 4).u32(keys.length);
      for (const key of keys) writer.u32(key);
      children.push(fullBox('stss', 0, 0, writer.toBytes()));
    }
    children.push(fullBox('stsc', 0, 0, new ByteWriter(16).u32(1).u32(1).u32(1).u32(1).toBytes()));
    const stsz = new ByteWriter(8 + samples.length * 4).u32(0).u32(samples.length);
    for (const sample of samples) stsz.u32(sample.size);
    children.push(fullBox('stsz', 0, 0, stsz.toBytes()));
    const chunks = new ByteWriter(4 + samples.length * (co64 ? 8 : 4)).u32(samples.length);
    for (const sample of samples) {
      if (co64) chunks.u64(base + sample.offset);
      else chunks.u32(base + sample.offset);
    }
    children.push(fullBox(co64 ? 'co64' : 'stco', 0, 0, chunks.toBytes()));
    return box('stbl', ...children);
  }

  private videoEntry(): Uint8Array<ArrayBuffer> {
    const { codec, width, height, description } = this.video;
    let type: string;
    let config: Uint8Array<ArrayBuffer>;
    if (codec.startsWith('avc1') || codec.startsWith('avc3')) {
      if (!description || description.byteLength === 0) {
        throw new ExportError('MUX_FAILED', 'El codificador H.264 no entregó la configuración avcC.');
      }
      type = 'avc1';
      config = box('avcC', description);
    } else if (codec.startsWith('av01')) {
      type = 'av01';
      config = box('av1C', description && description.byteLength > 0 ? description : av1ConfigFromCodec(codec));
    } else {
      throw new ExportError('MUX_FAILED', `MP4 no admite el códec ${codec} en este exportador.`);
    }
    const writer = new ByteWriter(78)
      .zeros(6)
      .u16(1)
      .u16(0)
      .u16(0)
      .zeros(12)
      .u16(width)
      .u16(height)
      .u32(0x00480000)
      .u32(0x00480000)
      .u32(0)
      .u16(1);
    const name = 'Concat';
    writer.u8(name.length).ascii(name).zeros(31 - name.length);
    writer.u16(0x0018).i16(-1);
    return box(type, writer.toBytes(), config);
  }

  private audioEntry(): Uint8Array<ArrayBuffer> {
    const audio = this.audio;
    if (!audio) throw new ExportError('MUX_FAILED', 'Falta la descripción de la pista de audio.');
    const entry = new ByteWriter(28)
      .zeros(6)
      .u16(1)
      .zeros(8)
      .u16(audio.channels)
      .u16(16)
      .u16(0)
      .u16(0)
      .u32(audio.sampleRate * 65536);
    if (audio.codec === 'opus') {
      const preSkip = audio.description && audio.description.byteLength >= 12 ? (audio.description[10] ?? 0) | ((audio.description[11] ?? 0) << 8) : 312;
      const dops = new ByteWriter(11).u8(0).u8(audio.channels).u16(preSkip).u32(audio.sampleRate).i16(0).u8(0).toBytes();
      return box('Opus', entry.toBytes(), box('dOps', dops));
    }
    const asc = audio.description && audio.description.byteLength > 0 ? audio.description : aacAudioSpecificConfig(audio.sampleRate, audio.channels);
    const decoderConfig = descriptor(
      0x04,
      new ByteWriter(13).u8(0x40).u8(0x15).u24(0).u32(this.audioBitrate).u32(this.audioBitrate).toBytes(),
      descriptor(0x05, asc),
    );
    const es = descriptor(0x03, new ByteWriter(3).u16(2).u8(0).toBytes(), decoderConfig, descriptor(0x06, new Uint8Array([0x02])));
    return box('mp4a', entry.toBytes(), fullBox('esds', 0, 0, es));
  }
}

/**
 * Reads the top-level boxes of an MP4 (tests and diagnostics).
 * @param bytes the file.
 * @returns `[type, offset, size]` triples.
 */
export function topLevelBoxes(bytes: Uint8Array): [string, number, number][] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: [string, number, number][] = [];
  let offset = 0;
  while (offset + 8 <= bytes.byteLength) {
    let size = view.getUint32(offset);
    const type = String.fromCharCode(bytes[offset + 4] ?? 32, bytes[offset + 5] ?? 32, bytes[offset + 6] ?? 32, bytes[offset + 7] ?? 32);
    if (size === 1) size = Number(view.getBigUint64(offset + 8));
    if (size < 8) break;
    out.push([type, offset, size]);
    offset += size;
  }
  return out;
}
