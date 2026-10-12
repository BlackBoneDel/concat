// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Container sniffing and a minimal ISO-BMFF (MP4/MOV) demuxer.
 *
 * The demuxer reads the sample tables of an MP4 so `decoder.ts` can feed
 * `VideoDecoder`/`AudioDecoder` — the WebCodecs-first path. Scope is the
 * common shooting formats: H.264 (`avc1`/`avc3`), HEVC (`hvc1`/`hev1`) and
 * AAC (`mp4a`) in MP4/MOV; anything else routes to the media-element path.
 *
 * Box layout follows ISO/IEC 14496-12; `avcC`/`hvcC` records are passed to
 * WebCodecs as `description` exactly as stored.
 */

/** What the sniffing found. */
export type ContainerKind =
  | 'mp4'
  | 'mov'
  | 'webm'
  | 'wav'
  | 'mp3'
  | 'ogg'
  | 'flac'
  | 'png'
  | 'jpeg'
  | 'webp'
  | 'gif'
  | 'unknown';

/** One coded sample: a chunk of the elementary stream. */
export interface DemuxSample {
  /** Decoding timestamp in seconds from the start of the track. */
  dts: number;
  /** Presentation timestamp in seconds (dts + composition offset). */
  cts: number;
  /** Sample duration in seconds. */
  duration: number;
  /** Byte length in the file. */
  size: number;
  /** Absolute byte offset in the file. */
  offset: number;
  /** True for a sync sample (keyframe). */
  key: boolean;
}

/** A demuxed track. */
export interface DemuxTrack {
  kind: 'video' | 'audio';
  /** WebCodecs codec string, e.g. `avc1.42c01e` or `mp4a.40.2`. */
  codec: string;
  /** The configuration record (`avcC`, `hvcC`, or the DecoderSpecificInfo). */
  description: Uint8Array | null;
  /** Media timescale (ticks per second). */
  timescale: number;
  /** Track length in seconds. */
  duration: number;
  /** Picture size for video tracks. */
  width: number;
  height: number;
  /** Audio format for audio tracks. */
  sampleRate: number;
  channels: number;
  /** Every sample, in decoding order. */
  samples: DemuxSample[];
  /** The track id from `tkhd`. */
  trackId: number;
}

const textDecoder = new TextDecoder('ascii');

/** Reads the container kind from the file's magic bytes. */
export async function detectContainer(file: Blob): Promise<ContainerKind> {
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const ascii = (from: number, to: number) => textDecoder.decode(head.subarray(from, to));
  if (head.length >= 12 && ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    return brand === 'qt  ' ? 'mov' : 'mp4';
  }
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'webm';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'wav';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  if (ascii(0, 3) === 'ID3' || (head[0] === 0xff && (head[1]! & 0xe0) === 0xe0)) return 'mp3';
  if (ascii(0, 4) === 'OggS') return 'ogg';
  if (ascii(0, 4) === 'fLaC') return 'flac';
  if (head[0] === 0x89 && ascii(1, 4) === 'PNG') return 'png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  if (ascii(0, 4) === 'GIF8') return 'gif';
  return 'unknown';
}

/** A parsed ISO-BMFF file: its tracks and their sample tables. */
export class MP4Demuxer {
  readonly tracks: DemuxTrack[] = [];
  private readonly buffer: ArrayBuffer;

  private constructor(buffer: ArrayBuffer) {
    this.buffer = buffer;
  }

  /**
   * Parses an MP4/MOV file.
   * @param buffer the whole file.
   * @returns the demuxer, or `null` when the file has no usable tracks.
   */
  static open(buffer: ArrayBuffer): MP4Demuxer | null {
    const demuxer = new MP4Demuxer(buffer);
    try {
      demuxer.parse();
    } catch {
      return null;
    }
    return demuxer.tracks.length > 0 ? demuxer : null;
  }

  /**
   * The sample presenting at `time` on a track.
   * @param track the demuxed track.
   * @param time seconds from the track start.
   * @returns the sample index at or just before `time`.
   */
  static sampleAt(track: DemuxTrack, time: number): number {
    const samples = track.samples;
    let low = 0;
    let high = samples.length - 1;
    let found = 0;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (samples[mid]!.cts <= time) {
        found = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return found;
  }

  /**
   * The sync sample at or before `index` — where decoding must start.
   * @param track the demuxed track.
   * @param index the wanted sample.
   * @returns the keyframe index to decode from.
   */
  static keyframeBefore(track: DemuxTrack, index: number): number {
    for (let i = index; i >= 0; i -= 1) {
      if (track.samples[i]!.key) return i;
    }
    return 0;
  }

  /**
   * The bytes of one sample.
   * @param track the demuxed track.
   * @param index the sample index.
   * @returns the sample's payload.
   */
  sampleBytes(track: DemuxTrack, index: number): Uint8Array {
    const sample = track.samples[index]!;
    return new Uint8Array(this.buffer, sample.offset, sample.size);
  }

  // -- box walking ---------------------------------------------------------

  private parse(): void {
    const view = new DataView(this.buffer);
    let offset = 0;
    let moov: { body: number; end: number } | null = null;
    while (offset + 8 <= view.byteLength) {
      const box = this.boxAt(view, offset);
      if (!box) break;
      if (box.type === 'moov') moov = { body: box.body, end: box.end };
      offset = box.start + box.size;
    }
    if (!moov) return;
    this.parseMoov(view, moov.body, moov.end);
  }

  /** Reads one box header (64-bit sizes included). */
  private boxAt(
    view: DataView,
    offset: number,
  ): { start: number; size: number; type: string; body: number; end: number } | null {
    if (offset + 8 > view.byteLength) return null;
    let size = view.getUint32(offset);
    const type = textDecoder.decode(new Uint8Array(this.buffer, offset + 4, 4));
    let body = offset + 8;
    if (size === 1) {
      if (offset + 16 > view.byteLength) return null;
      const large = view.getBigUint64(offset + 8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      size = Number(large);
      body = offset + 16;
    } else if (size === 0) {
      size = view.byteLength - offset;
    }
    if (size < 8) return null;
    return { start: offset, size, type, body, end: Math.min(view.byteLength, offset + size) };
  }

  /** Walks the children of `[start, end)`. */
  private *children(view: DataView, start: number, end: number): Generator<{ type: string; body: number; end: number }> {
    let offset = start;
    while (offset + 8 <= end) {
      const box = this.boxAt(view, offset);
      if (!box) return;
      yield { type: box.type, body: box.body, end: Math.min(end, box.start + box.size) };
      offset = box.start + box.size;
    }
  }

  private parseMoov(view: DataView, start: number, end: number): void {
    for (const child of this.children(view, start, end)) {
      if (child.type === 'trak') this.parseTrak(view, child.body, child.end);
    }
  }

  private parseTrak(view: DataView, start: number, end: number): void {
    const track: DemuxTrack = {
      kind: 'video',
      codec: '',
      description: null,
      timescale: 0,
      duration: 0,
      width: 0,
      height: 0,
      sampleRate: 0,
      channels: 0,
      samples: [],
      trackId: 0,
    };
    let stblRange: { start: number; end: number } | null = null;
    for (const child of this.children(view, start, end)) {
      switch (child.type) {
        case 'tkhd': {
          const version = view.getUint8(child.body);
          track.trackId = view.getUint32(child.body + (version === 1 ? 20 : 12));
          if (track.kind === 'video') {
            track.width = view.getUint32(child.end - 8) >>> 16;
            track.height = view.getUint32(child.end - 4) >>> 16;
          }
          break;
        }
        case 'mdia': {
          for (const media of this.children(view, child.body, child.end)) {
            if (media.type === 'mdhd') {
              const version = view.getUint8(media.body);
              if (version === 1) {
                track.timescale = view.getUint32(media.body + 20);
                track.duration = Number(view.getBigUint64(media.body + 24)) / (track.timescale || 1);
              } else {
                track.timescale = view.getUint32(media.body + 12);
                track.duration = view.getUint32(media.body + 16) / (track.timescale || 1);
              }
            } else if (media.type === 'hdlr') {
              const handler = textDecoder.decode(new Uint8Array(this.buffer, media.body + 8, 4));
              track.kind = handler === 'soun' ? 'audio' : 'video';
            } else if (media.type === 'minf') {
              for (const minf of this.children(view, media.body, media.end)) {
                if (minf.type === 'stbl') stblRange = { start: minf.body, end: minf.end };
              }
            }
          }
          break;
        }
        default:
          break;
      }
    }
    if (!stblRange || track.timescale === 0) return;
    this.parseStbl(view, track, stblRange.start, stblRange.end);
    if (track.codec !== '' && track.samples.length > 0) this.tracks.push(track);
  }

  private parseStbl(view: DataView, track: DemuxTrack, start: number, end: number): void {
    let stts: { count: number; delta: number }[] = [];
    let ctts: { count: number; offset: number }[] | null = null;
    let cttsSigned = false;
    let stss: Set<number> | null = null;
    let stsc: { firstChunk: number; perChunk: number }[] = [];
    let sizes: number[] = [];
    let uniformSize = 0;
    let chunkOffsets: number[] = [];

    for (const box of this.children(view, start, end)) {
      const body = box.body;
      switch (box.type) {
        case 'stsd':
          this.parseStsd(view, track, body, box.end);
          break;
        case 'stts': {
          const count = view.getUint32(body + 4);
          stts = [];
          for (let i = 0; i < count; i += 1) {
            stts.push({ count: view.getUint32(body + 8 + i * 8), delta: view.getUint32(body + 12 + i * 8) });
          }
          break;
        }
        case 'ctts': {
          const version = view.getUint8(body);
          cttsSigned = version === 1;
          const count = view.getUint32(body + 4);
          ctts = [];
          for (let i = 0; i < count; i += 1) {
            const offset = cttsSigned
              ? view.getInt32(body + 12 + i * 8)
              : view.getUint32(body + 12 + i * 8);
            ctts.push({ count: view.getUint32(body + 8 + i * 8), offset });
          }
          break;
        }
        case 'stss': {
          const count = view.getUint32(body + 4);
          stss = new Set();
          for (let i = 0; i < count; i += 1) stss.add(view.getUint32(body + 8 + i * 4));
          break;
        }
        case 'stsc': {
          const count = view.getUint32(body + 4);
          stsc = [];
          for (let i = 0; i < count; i += 1) {
            stsc.push({
              firstChunk: view.getUint32(body + 8 + i * 12),
              perChunk: view.getUint32(body + 12 + i * 12),
            });
          }
          break;
        }
        case 'stsz': {
          uniformSize = view.getUint32(body + 4);
          const count = view.getUint32(body + 8);
          if (uniformSize === 0) {
            sizes = [];
            for (let i = 0; i < count; i += 1) sizes.push(view.getUint32(body + 12 + i * 4));
          } else {
            sizes = new Array<number>(count).fill(uniformSize);
          }
          break;
        }
        case 'stco': {
          const count = view.getUint32(body + 4);
          chunkOffsets = [];
          for (let i = 0; i < count; i += 1) chunkOffsets.push(view.getUint32(body + 8 + i * 4));
          break;
        }
        case 'co64': {
          const count = view.getUint32(body + 4);
          chunkOffsets = [];
          for (let i = 0; i < count; i += 1) {
            chunkOffsets.push(Number(view.getBigUint64(body + 8 + i * 8)));
          }
          break;
        }
        default:
          break;
      }
    }

    // Unpack the per-chunk mapping into per-sample offsets and timestamps.
    const timescale = track.timescale;
    let sampleIndex = 0;
    let dtsTicks = 0;
    let sttsIndex = 0;
    let sttsLeft = stts[0]?.count ?? 0;
    let cttsIndex = 0;
    let cttsLeft = ctts?.[0]?.count ?? 0;
    let cttsOffset = ctts?.[0]?.offset ?? 0;

    for (let chunk = 1; chunk <= chunkOffsets.length; chunk += 1) {
      let perChunk = stsc[stsc.length - 1]?.perChunk ?? 1;
      for (let i = 0; i < stsc.length; i += 1) {
        if (stsc[i]!.firstChunk <= chunk) perChunk = stsc[i]!.perChunk;
        else break;
      }
      let offset = chunkOffsets[chunk - 1]!;
      for (let n = 0; n < perChunk && sampleIndex < sizes.length; n += 1) {
        while (sttsLeft === 0 && sttsIndex + 1 < stts.length) {
          sttsIndex += 1;
          sttsLeft = stts[sttsIndex]!.count;
        }
        while (ctts && cttsLeft === 0 && cttsIndex + 1 < ctts.length) {
          cttsIndex += 1;
          cttsLeft = ctts[cttsIndex]!.count;
          cttsOffset = ctts[cttsIndex]!.offset;
        }
        const delta = stts[sttsIndex]?.delta ?? 0;
        const size = sizes[sampleIndex]!;
        const isKey = stss ? stss.has(sampleIndex + 1) : true;
        track.samples.push({
          dts: dtsTicks / timescale,
          cts: (dtsTicks + (ctts ? cttsOffset : 0)) / timescale,
          duration: delta / timescale,
          size,
          offset,
          key: isKey,
        });
        dtsTicks += delta;
        sttsLeft -= 1;
        if (ctts) cttsLeft -= 1;
        offset += size;
        sampleIndex += 1;
      }
    }
    if (track.duration === 0 && track.samples.length > 0) {
      const last = track.samples[track.samples.length - 1]!;
      track.duration = last.dts + last.duration;
    }
  }

  private parseStsd(view: DataView, track: DemuxTrack, body: number, end: number): void {
    const entryCount = view.getUint32(body + 4);
    if (entryCount === 0) return;
    const entry = this.boxAt(view, body + 8);
    if (!entry) return;
    const type = entry.type;
    if (type === 'avc1' || type === 'avc3' || type === 'hvc1' || type === 'hev1' || type === 'mp4a') {
      if (type === 'mp4a') {
        // AudioSampleEntry payload is 28 bytes before the child boxes.
        const channels = view.getUint16(entry.body + 16);
        const sampleRate = view.getUint32(entry.body + 24) >>> 16;
        track.channels = channels;
        track.sampleRate = sampleRate;
        track.codec = 'mp4a.40.2';
        for (const child of this.children(view, entry.body + 28, entry.end)) {
          if (child.type === 'esds') this.parseEsds(view, track, child.body, child.end);
        }
      } else {
        // VisualSampleEntry payload is 78 bytes before the child boxes.
        if (track.width === 0) {
          track.width = view.getUint16(entry.body + 24);
          track.height = view.getUint16(entry.body + 26);
        }
        for (const child of this.children(view, entry.body + 78, entry.end)) {
          if (child.type === 'avcC') {
            const record = new Uint8Array(this.buffer, child.body, child.end - child.body);
            track.description = record;
            const profile = record[1]!;
            const compat = record[2]!;
            const level = record[3]!;
            track.codec = `avc1.${hex2(profile)}${hex2(compat)}${hex2(level)}`;
          } else if (child.type === 'hvcC') {
            const record = new Uint8Array(this.buffer, child.body, child.end - child.body);
            track.description = record;
            track.codec = hevcCodecString(record);
          }
        }
      }
    }
  }

  /** Pulls the AudioSpecificConfig out of an `esds` DecoderSpecificInfo. */
  private parseEsds(view: DataView, track: DemuxTrack, body: number, end: number): void {
    // FullBox header (4) then descriptors with tag + variable-length size.
    let offset = body + 4;
    const readDescriptor = (): { tag: number; start: number; end: number } | null => {
      if (offset >= end) return null;
      const tag = view.getUint8(offset);
      let size = 0;
      let lengthBytes = 0;
      for (let i = 0; i < 4; i += 1) {
        const byte = view.getUint8(offset + 1 + i);
        size = (size << 7) | (byte & 0x7f);
        lengthBytes += 1;
        if ((byte & 0x80) === 0) break;
      }
      const start = offset + 1 + lengthBytes;
      offset = start + size;
      return { tag, start, end: Math.min(end, start + size) };
    };
    while (offset < end) {
      const descriptor = readDescriptor();
      if (!descriptor) break;
      if (descriptor.tag === 0x05) {
        track.description = new Uint8Array(
          this.buffer,
          descriptor.start,
          descriptor.end - descriptor.start,
        );
        break;
      }
      if (descriptor.tag === 0x03 || descriptor.tag === 0x04) {
        // Skip ES_ID (2) + flags (1) / objectType etc; keep walking nested
        // descriptors by rewinding into the payload.
        const skip = descriptor.tag === 0x03 ? 3 : 13;
        offset = descriptor.start + skip;
      }
    }
    if (track.sampleRate > 0 && track.codec.startsWith('mp4a')) {
      // The ASC object type when present is its first 5 bits; leave the
      // generic `mp4a.40.2` (AAC-LC) unless the record says otherwise.
      const asc = track.description;
      if (asc && asc.length > 0) {
        const objectType = (asc[0]! >> 3) & 0x1f;
        if (objectType > 0 && objectType < 31) track.codec = `mp4a.40.${objectType}`;
      }
    }
  }
}

/** Two hex digits. */
function hex2(value: number): string {
  return value.toString(16).padStart(2, '0');
}

/** The WebCodecs codec string of an `hvcC` record. */
function hevcCodecString(record: Uint8Array): string {
  if (record.length < 13) return 'hvc1.1.6.L120.90';
  const profileSpace = (record[1]! >> 6) & 0x03;
  const tier = (record[1]! >> 5) & 0x01;
  const profileIdc = record[1]! & 0x1f;
  const compatibility = record[2]! * 0x1000000 + record[3]! * 0x10000 + record[4]! * 0x100 + record[5]!;
  const constraints =
    `${hex2(record[6]!)}${hex2(record[7]!)}${hex2(record[8]!)}${hex2(record[9]!)}${hex2(record[10]!)}${hex2(record[11]!)}`
      .replace(/(\.?)0+$/, '');
  const level = record[12]!;
  const space = ['', 'A', 'B', 'C'][profileSpace] ?? '';
  return `hvc1${space}.${profileIdc}.${compatibility.toString(16).replace(/^0+/, '') || '0'}.${
    tier === 1 ? 'H' : 'L'
  }${level}${constraints === '' ? '' : `.${constraints}`}`;
}
