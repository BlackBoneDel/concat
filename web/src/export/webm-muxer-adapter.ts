// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Fase 6: a WebM (Matroska subset) writer, written for this project. Packets
 * stream into a {@link PacketStore}; `finalize` interleaves video and audio
 * by timestamp into Clusters of SimpleBlocks (a new Cluster at every video
 * keyframe, and before the 16-bit relative timecode would overflow), then
 * writes SeekHead, Info (with Duration), Tracks and Cues around them. Block
 * payloads are `Blob` slices of the store, so nothing is copied.
 *
 * Codecs: VP9 (`V_VP9`), AV1 (`V_AV1` + av1C) and Opus (`A_OPUS` +
 * OpusHead). The desktop app writes WebM through FFmpeg's matroska muxer
 * (`src/crates/concat-export/src/lib.rs`).
 */

import { av1ConfigFromCodec } from './mp4-muxer-adapter.ts';
import { ByteWriter, PacketStore, type PacketRef } from './packet-store.ts';
import { ExportError, type AudioTrackInfo, type EncodedPacket, type MuxerAdapter, type VideoTrackInfo } from './types.ts';

/** Matroska element ids used here. */
export const EBML_IDS = Object.freeze({
  EBML: 0x1a45dfa3,
  EBMLVersion: 0x4286,
  EBMLReadVersion: 0x42f7,
  EBMLMaxIDLength: 0x42f2,
  EBMLMaxSizeLength: 0x42f3,
  DocType: 0x4282,
  DocTypeVersion: 0x4287,
  DocTypeReadVersion: 0x4285,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,
  Info: 0x1549a966,
  TimestampScale: 0x2ad7b1,
  MuxingApp: 0x4d80,
  WritingApp: 0x5741,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackUID: 0x73c5,
  TrackType: 0x83,
  FlagLacing: 0x9c,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  CodecDelay: 0x56aa,
  SeekPreRoll: 0x56bb,
  DefaultDuration: 0x23e383,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Audio: 0xe1,
  SamplingFrequency: 0xb5,
  Channels: 0x9f,
  Cluster: 0x1f43b675,
  Timestamp: 0xe7,
  SimpleBlock: 0xa3,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  CueClusterPosition: 0xf1,
});

/** Bytes of an element id (ids carry their own length marker). */
function idBytes(id: number): number[] {
  if (id >= 0x1000000) return [(id >>> 24) & 0xff, (id >>> 16) & 0xff, (id >>> 8) & 0xff, id & 0xff];
  if (id >= 0x10000) return [(id >>> 16) & 0xff, (id >>> 8) & 0xff, id & 0xff];
  if (id >= 0x100) return [(id >>> 8) & 0xff, id & 0xff];
  return [id & 0xff];
}

/**
 * EBML variable-size integer.
 * @param value the size.
 * @param width fixed byte width (1–8), or minimal when omitted.
 * @returns the encoded bytes.
 */
export function vint(value: number, width?: number): Uint8Array<ArrayBuffer> {
  let length = width ?? 1;
  if (width === undefined) {
    while (length < 8 && value >= 2 ** (7 * length) - 1) length += 1;
  }
  const out = new Uint8Array(length);
  let rest = BigInt(value);
  for (let i = length - 1; i >= 0; i -= 1) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  out[0] = (out[0] ?? 0) | (0x80 >> (length - 1));
  return out;
}

/** Minimal big-endian unsigned bytes (at least one). */
function uintBytes(value: number, width?: number): Uint8Array<ArrayBuffer> {
  let length = width ?? 1;
  if (width === undefined) while (length < 8 && value >= 2 ** (8 * length)) length += 1;
  const out = new Uint8Array(length);
  let rest = BigInt(Math.max(0, Math.floor(value)));
  for (let i = length - 1; i >= 0; i -= 1) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

/** An element with binary payload parts. */
export function element(id: number, ...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const size = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const writer = new ByteWriter(size + 12);
  for (const byte of idBytes(id)) writer.u8(byte);
  writer.bytes(vint(size));
  for (const part of parts) writer.bytes(part);
  return writer.toBytes();
}

/** An unsigned-integer element (optionally fixed width). */
export function uintElement(id: number, value: number, width?: number): Uint8Array<ArrayBuffer> {
  return element(id, uintBytes(value, width));
}

/** A float64 element. */
function floatElement(id: number, value: number): Uint8Array<ArrayBuffer> {
  return element(id, new ByteWriter(8).f64(value).toBytes());
}

/** A string element. */
function stringElement(id: number, value: string): Uint8Array<ArrayBuffer> {
  return element(id, new ByteWriter(value.length + 1).ascii(value).toBytes());
}

/**
 * An `OpusHead` (RFC 7845) for the CodecPrivate.
 * @param channels channel count.
 * @param sampleRate input rate.
 * @param preSkip samples to drop at the start.
 * @returns the 19-byte header.
 */
export function opusHead(channels: number, sampleRate: number, preSkip = 312): Uint8Array<ArrayBuffer> {
  return new ByteWriter(19).ascii('OpusHead').u8(1).u8(channels).u16le(preSkip).u32le(sampleRate).u16le(0).u8(0).toBytes();
}

/** One stored packet. */
interface StoredPacket {
  track: 1 | 2;
  ref: PacketRef;
  timestamp: number;
  duration: number;
  keyFrame: boolean;
}

/** The streaming WebM writer. */
export class WebmMuxerAdapter implements MuxerAdapter {
  private video: VideoTrackInfo;
  private audio: AudioTrackInfo | null;
  private readonly store: PacketStore;
  private readonly videoPackets: StoredPacket[] = [];
  private readonly audioPackets: StoredPacket[] = [];
  private finished: Blob | null = null;
  private aborted = false;

  /**
   * @param options track descriptions and an optional store.
   */
  constructor(options: { video: VideoTrackInfo; audio: AudioTrackInfo | null; store?: PacketStore }) {
    this.video = options.video;
    this.audio = options.audio;
    this.store = options.store ?? new PacketStore();
  }

  get bytesWritten(): number {
    return this.store.size;
  }

  setVideoTrack(info: VideoTrackInfo): void {
    this.video = info;
  }

  setAudioTrack(info: AudioTrackInfo | null): void {
    this.audio = info;
  }

  addVideoPacket(packet: EncodedPacket): void {
    this.add(this.videoPackets, 1, packet);
  }

  addAudioPacket(packet: EncodedPacket): void {
    if (!this.audio) throw new ExportError('MUX_FAILED', 'Paquete de audio sin pista de audio.');
    this.add(this.audioPackets, 2, packet);
  }

  /**
   * Interleaves, clusters and indexes.
   * @returns the WebM `Blob`.
   */
  finalize(): Blob {
    if (this.finished) return this.finished;
    if (this.aborted) throw new ExportError('ABORTED');
    if (this.videoPackets.length === 0) throw new ExportError('MUX_FAILED', 'No hay fotogramas codificados que empaquetar.');
    const media = this.store.finish();
    const ordered = interleave(this.videoPackets, this.audioPackets);
    const endMs = ordered.reduce((max, packet) => Math.max(max, (packet.timestamp + packet.duration) / 1000), 0);

    const info = element(
      EBML_IDS.Info,
      uintElement(EBML_IDS.TimestampScale, 1_000_000),
      stringElement(EBML_IDS.MuxingApp, 'Concat Web'),
      stringElement(EBML_IDS.WritingApp, 'Concat Web'),
      floatElement(EBML_IDS.Duration, endMs),
    );
    const tracks = this.tracks();
    const seekHeadSize = this.seekHead(0, 0, 0).byteLength;

    // Clusters: header bytes + per-block header + payload slice.
    const parts: BlobPart[] = [];
    const cues: { time: number; position: number }[] = [];
    let position = seekHeadSize + info.byteLength + tracks.byteLength;
    let index = 0;
    while (index < ordered.length) {
      const first = ordered[index];
      if (!first) break;
      const clusterMs = Math.round(first.timestamp / 1000);
      const blocks: { header: Uint8Array<ArrayBuffer>; packet: StoredPacket }[] = [];
      let payload = 0;
      while (index < ordered.length) {
        const packet = ordered[index];
        if (!packet) break;
        const relative = Math.round(packet.timestamp / 1000) - clusterMs;
        const startsGop = packet.track === 1 && packet.keyFrame && blocks.length > 0;
        if (startsGop || relative > 32_767 || relative < -32_768) break;
        const blockHeader = new ByteWriter(4).u8(0x80 | packet.track).i16(relative).u8(packet.keyFrame ? 0x80 : 0).toBytes();
        const blockSize = blockHeader.byteLength + packet.ref.size;
        const header = new ByteWriter(12);
        for (const byte of idBytes(EBML_IDS.SimpleBlock)) header.u8(byte);
        header.bytes(vint(blockSize)).bytes(blockHeader);
        const bytes = header.toBytes();
        blocks.push({ header: bytes, packet });
        payload += bytes.byteLength + packet.ref.size;
        index += 1;
      }
      const timestamp = uintElement(EBML_IDS.Timestamp, clusterMs);
      const clusterBody = timestamp.byteLength + payload;
      const clusterHeader = new ByteWriter(16);
      for (const byte of idBytes(EBML_IDS.Cluster)) clusterHeader.u8(byte);
      clusterHeader.bytes(vint(clusterBody, 8));
      const headerBytes = clusterHeader.toBytes();
      if (blocks[0]?.packet.track === 1 && blocks[0].packet.keyFrame) cues.push({ time: clusterMs, position });
      parts.push(headerBytes, timestamp);
      for (const block of blocks) {
        parts.push(block.header, media.slice(block.packet.ref.offset, block.packet.ref.offset + block.packet.ref.size));
      }
      position += headerBytes.byteLength + clusterBody;
    }
    const cuesPosition = position;
    const cuesElement = element(
      EBML_IDS.Cues,
      ...cues.map((cue) =>
        element(
          EBML_IDS.CuePoint,
          uintElement(EBML_IDS.CueTime, cue.time),
          element(EBML_IDS.CueTrackPositions, uintElement(EBML_IDS.CueTrack, 1), uintElement(EBML_IDS.CueClusterPosition, cue.position)),
        ),
      ),
    );
    const seekHead = this.seekHead(seekHeadSize, seekHeadSize + info.byteLength, cuesPosition);
    const segmentSize = cuesPosition + cuesElement.byteLength;
    const segmentHeader = new ByteWriter(12);
    for (const byte of idBytes(EBML_IDS.Segment)) segmentHeader.u8(byte);
    segmentHeader.bytes(vint(segmentSize, 8));
    this.finished = new Blob([ebmlHeader(), segmentHeader.toBytes(), seekHead, info, tracks, ...parts, cuesElement], { type: 'video/webm' });
    return this.finished;
  }

  abort(): void {
    this.aborted = true;
    this.store.clear();
    this.videoPackets.length = 0;
    this.audioPackets.length = 0;
  }

  private add(list: StoredPacket[], track: 1 | 2, packet: EncodedPacket): void {
    if (this.aborted) throw new ExportError('ABORTED');
    if (this.finished) throw new ExportError('MUX_FAILED', 'El WebM ya está finalizado.');
    const ref = this.store.append(packet.data);
    list.push({ track, ref, timestamp: packet.timestamp, duration: packet.duration, keyFrame: track === 2 ? true : packet.keyFrame });
  }

  /** SeekHead with fixed-width positions (so its size never changes). */
  private seekHead(infoPosition: number, tracksPosition: number, cuesPosition: number): Uint8Array<ArrayBuffer> {
    const seek = (id: number, at: number): Uint8Array<ArrayBuffer> =>
      element(EBML_IDS.Seek, element(EBML_IDS.SeekID, new Uint8Array(idBytes(id))), uintElement(EBML_IDS.SeekPosition, at, 8));
    return element(EBML_IDS.SeekHead, seek(EBML_IDS.Info, infoPosition), seek(EBML_IDS.Tracks, tracksPosition), seek(EBML_IDS.Cues, cuesPosition));
  }

  private tracks(): Uint8Array<ArrayBuffer> {
    const { codec, width, height, frameRate, description } = this.video;
    let codecId: string;
    const videoExtra: Uint8Array[] = [];
    if (codec.startsWith('vp09')) codecId = 'V_VP9';
    else if (codec.startsWith('vp8')) codecId = 'V_VP8';
    else if (codec.startsWith('av01')) {
      codecId = 'V_AV1';
      videoExtra.push(element(EBML_IDS.CodecPrivate, description && description.byteLength > 0 ? description : av1ConfigFromCodec(codec)));
    } else throw new ExportError('MUX_FAILED', `WebM no admite el códec ${codec}.`);
    const entries: Uint8Array[] = [
      element(
        EBML_IDS.TrackEntry,
        uintElement(EBML_IDS.TrackNumber, 1),
        uintElement(EBML_IDS.TrackUID, 1),
        uintElement(EBML_IDS.TrackType, 1),
        uintElement(EBML_IDS.FlagLacing, 0),
        stringElement(EBML_IDS.CodecID, codecId),
        ...videoExtra,
        uintElement(EBML_IDS.DefaultDuration, Math.round((1e9 * frameRate.den) / frameRate.num)),
        element(EBML_IDS.Video, uintElement(EBML_IDS.PixelWidth, width), uintElement(EBML_IDS.PixelHeight, height)),
      ),
    ];
    const audio = this.audio;
    if (audio && this.audioPackets.length > 0) {
      if (audio.codec !== 'opus') throw new ExportError('MUX_FAILED', `WebM no admite el códec de audio ${audio.codec}.`);
      const head = isOpusHead(audio.description) && audio.description ? audio.description : opusHead(audio.channels, audio.sampleRate);
      const preSkip = (head[10] ?? 0) | ((head[11] ?? 0) << 8);
      entries.push(
        element(
          EBML_IDS.TrackEntry,
          uintElement(EBML_IDS.TrackNumber, 2),
          uintElement(EBML_IDS.TrackUID, 2),
          uintElement(EBML_IDS.TrackType, 2),
          uintElement(EBML_IDS.FlagLacing, 0),
          stringElement(EBML_IDS.CodecID, 'A_OPUS'),
          element(EBML_IDS.CodecPrivate, head),
          uintElement(EBML_IDS.CodecDelay, Math.round((preSkip * 1e9) / 48_000)),
          uintElement(EBML_IDS.SeekPreRoll, 80_000_000),
          element(EBML_IDS.Audio, floatElement(EBML_IDS.SamplingFrequency, audio.sampleRate), uintElement(EBML_IDS.Channels, audio.channels)),
        ),
      );
    }
    return element(EBML_IDS.Tracks, ...entries);
  }
}

/** Whether bytes start with the `OpusHead` magic. */
function isOpusHead(bytes: Uint8Array | null): boolean {
  if (!bytes || bytes.byteLength < 19) return false;
  return String.fromCharCode(...bytes.subarray(0, 8)) === 'OpusHead';
}

/** The EBML header of a WebM file. */
export function ebmlHeader(): Uint8Array<ArrayBuffer> {
  return element(
    EBML_IDS.EBML,
    uintElement(EBML_IDS.EBMLVersion, 1),
    uintElement(EBML_IDS.EBMLReadVersion, 1),
    uintElement(EBML_IDS.EBMLMaxIDLength, 4),
    uintElement(EBML_IDS.EBMLMaxSizeLength, 8),
    stringElement(EBML_IDS.DocType, 'webm'),
    uintElement(EBML_IDS.DocTypeVersion, 4),
    uintElement(EBML_IDS.DocTypeReadVersion, 2),
  );
}

/**
 * Merges video and audio packets by timestamp; on ties the video packet
 * goes first, so a keyframe always opens its own cluster.
 * @param video video packets in decode order.
 * @param audio audio packets in order.
 * @returns the merged list.
 */
function interleave(video: readonly StoredPacket[], audio: readonly StoredPacket[]): StoredPacket[] {
  const out: StoredPacket[] = [];
  let a = 0;
  for (const packet of video) {
    while (a < audio.length && (audio[a]?.timestamp ?? Infinity) < packet.timestamp) {
      const next = audio[a];
      if (next) out.push(next);
      a += 1;
    }
    out.push(packet);
  }
  while (a < audio.length) {
    const next = audio[a];
    if (next) out.push(next);
    a += 1;
  }
  return out;
}
