// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Deep metadata for the media panel's "Metadatos" view and import policy.
 *
 * Combines: file facts, magic-byte sniffing (`FormatDetector`), the
 * decoder probe (duration, size, rate, codecs) and an ISO-BMFF walk of the
 * `moov` box for what probes skip — creation time (`mvhd`, seconds since
 * 1904, ISO/IEC 14496-12 §8.2.2), display rotation (`tkhd` matrix §8.3.2)
 * and the encoder tag (`udta`/`ilst` `©too`).
 */

import { MediaDecoder, type MediaInfo } from '../decoder.ts';
import { FormatDetector, type FormatInfo } from '../ffmpeg/format-detector.ts';
import { AUTO_PROXY_BITRATE, HEAVY_CODECS, codecFamily } from '../proxy/proxy-generator.ts';
import { extensionOf, kindByExtension, type ContainerName } from './format-support.ts';

/** Everything known about a file. */
export interface DeepMetadata {
  name: string;
  size: number;
  mimeType: string;
  extension: string;
  lastModified: number | null;
  kind: ReturnType<typeof kindByExtension>;
  container: ContainerName;
  videoCodec: string;
  audioCodec: string;
  duration: number | null;
  width: number;
  height: number;
  /** Reduced ratio (`16:9`), or '' without a picture. */
  aspectRatio: string;
  fps: number | null;
  /** Overall bits per second (size / duration). */
  bitrate: number | null;
  audioSampleRate: number;
  audioChannels: number;
  /** ISO-8601 from `mvhd`, or null. */
  creationTime: string | null;
  /** Display rotation in degrees (0/90/180/270). */
  rotation: number;
  encoder: string | null;
  nativelySupported: boolean;
  needsFallback: boolean;
  needsProxy: boolean;
}

/** What the ISO-BMFF walk found. */
export interface Mp4Atoms {
  creationTime: string | null;
  durationSeconds: number | null;
  rotation: number;
  encoder: string | null;
}

/** Seconds between 1904-01-01 and 1970-01-01. */
const MAC_EPOCH_OFFSET = 2_082_844_800;
/** Largest `moov` read into memory. */
const MAX_MOOV = 64 * 1024 * 1024;
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'udta', 'ilst', 'meta', 'minf', 'stbl']);

interface Box {
  type: string;
  start: number;
  end: number;
  /** Payload offset. */
  body: number;
}

function boxType(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
}

/** Children of a box range. */
function children(bytes: Uint8Array, from: number, to: number): Box[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    let size = view.getUint32(at);
    let header = 8;
    if (size === 1 && at + 16 <= to) {
      size = Number(view.getBigUint64(at + 8));
      header = 16;
    } else if (size === 0) {
      size = to - at;
    }
    if (size < header || at + size > to) break;
    out.push({ type: boxType(bytes, at + 4), start: at, end: at + size, body: at + header });
    at += size;
  }
  return out;
}

function find(bytes: Uint8Array, from: number, to: number, path: string[]): Box | null {
  let range: Box | null = null;
  let start = from;
  let end = to;
  for (const type of path) {
    const box = children(bytes, start, end).find((b) => b.type === type);
    if (!box) return null;
    range = box;
    start = box.body;
    end = box.end;
    // ISO `meta` is a FullBox (version/flags before its `hdlr`); QuickTime's is not.
    if (type === 'meta' && start + 12 <= end && boxType(bytes, start + 4) !== 'hdlr' && boxType(bytes, start + 8) === 'hdlr') start += 4;
  }
  return range ? { ...range, body: start } : null;
}

function allOf(bytes: Uint8Array, from: number, to: number, type: string): Box[] {
  return children(bytes, from, to).filter((b) => b.type === type);
}

/**
 * Walks a `moov` box payload (or a whole small file).
 * @param bytes bytes containing a `moov` box at top level.
 * @returns what was found.
 */
export function parseMp4Atoms(bytes: Uint8Array): Mp4Atoms {
  const result: Mp4Atoms = { creationTime: null, durationSeconds: null, rotation: 0, encoder: null };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const moov = find(bytes, 0, bytes.length, ['moov']);
  if (!moov) return result;
  const mvhd = find(bytes, moov.body, moov.end, ['mvhd']);
  if (mvhd && mvhd.body + 32 <= mvhd.end) {
    const version = bytes[mvhd.body]!;
    const p = mvhd.body + 4;
    const created = version === 1 ? Number(view.getBigUint64(p)) : view.getUint32(p);
    const timescale = version === 1 ? view.getUint32(p + 16) : view.getUint32(p + 8);
    const duration = version === 1 ? Number(view.getBigUint64(p + 20)) : view.getUint32(p + 12);
    if (created > 0) {
      const unix = (created - MAC_EPOCH_OFFSET) * 1000;
      if (Number.isFinite(unix) && unix > 0) result.creationTime = new Date(unix).toISOString();
    }
    if (timescale > 0) result.durationSeconds = duration / timescale;
  }
  for (const trak of allOf(bytes, moov.body, moov.end, 'trak')) {
    const tkhd = find(bytes, trak.body, trak.end, ['tkhd']);
    if (!tkhd) continue;
    const version = bytes[tkhd.body]!;
    const matrix = tkhd.body + (version === 1 ? 36 : 24) + 16;
    if (matrix + 44 > tkhd.end) continue;
    const width = view.getUint32(matrix + 36) / 65536;
    if (width === 0) continue; // audio track
    const a = view.getInt32(matrix) / 65536;
    const b = view.getInt32(matrix + 4) / 65536;
    const degrees = Math.round((Math.atan2(b, a) * 180) / Math.PI);
    result.rotation = ((degrees % 360) + 360) % 360;
    break;
  }
  const tool = find(bytes, moov.body, moov.end, ['udta', 'meta', 'ilst', '\u00a9too'])
    ?? find(bytes, moov.body, moov.end, ['udta', '\u00a9too']);
  if (tool) {
    const data = find(bytes, tool.body, tool.end, ['data']);
    const raw = data ? bytes.subarray(data.body + 8, data.end) : bytes.subarray(tool.body + 4, tool.end); // QuickTime: size(2)+lang(2)
    const text = new TextDecoder().decode(raw).replace(/\0+$/, '').trim();
    if (text !== '') result.encoder = text;
  }
  return result;
}

/**
 * Finds and reads the `moov` box of a file without loading the media data.
 * @param file the file.
 * @returns the atoms (empty when not ISO-BMFF).
 */
export async function readMp4Atoms(file: Blob): Promise<Mp4Atoms> {
  const empty: Mp4Atoms = { creationTime: null, durationSeconds: null, rotation: 0, encoder: null };
  let at = 0;
  for (let guard = 0; guard < 1024 && at + 8 <= file.size; guard += 1) {
    const head = new Uint8Array(await file.slice(at, at + 16).arrayBuffer());
    const view = new DataView(head.buffer);
    let size = view.getUint32(0);
    if (size === 1 && head.length >= 16) size = Number(view.getBigUint64(8));
    else if (size === 0) size = file.size - at;
    if (size < 8) return empty;
    if (boxType(head, 4) === 'moov') {
      if (size > MAX_MOOV) return empty;
      return parseMp4Atoms(new Uint8Array(await file.slice(at, at + size).arrayBuffer()));
    }
    at += size;
  }
  return empty;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/**
 * Reduced aspect ratio.
 * @param width pixels.
 * @param height pixels.
 * @returns e.g. `16:9`, or '' without a picture.
 */
export function aspectRatio(width: number, height: number): string {
  if (width <= 0 || height <= 0) return '';
  const w = Math.round(width);
  const h = Math.round(height);
  const d = gcd(w, h);
  return `${w / d}:${h / d}`;
}

/**
 * The proxy policy (same rule as `ProxyGenerator.shouldGenerateProxy`).
 * @param meta size, duration, codec.
 * @returns true when a proxy is advisable.
 */
export function needsProxy(meta: Pick<DeepMetadata, 'kind' | 'width' | 'height' | 'duration' | 'size' | 'videoCodec'>): boolean {
  if (meta.kind !== 'video') return false;
  if (meta.width * meta.height >= 1920 * 1080) return true;
  if (meta.duration && meta.duration > 0 && (meta.size * 8) / meta.duration > AUTO_PROXY_BITRATE) return true;
  return HEAVY_CODECS.includes(codecFamily(meta.videoCodec));
}

/** Options of {@link MetadataExtractor}. */
export interface MetadataExtractorOptions {
  detector?: FormatDetector;
  /** Decoder probe (defaults to a throwaway {@link MediaDecoder}). */
  probe?: (file: File) => Promise<MediaInfo | null>;
}

async function decoderProbe(file: File): Promise<MediaInfo | null> {
  const decoder = new MediaDecoder(file, 'metadata-probe');
  try {
    return await decoder.init();
  } catch {
    return null;
  } finally {
    decoder.close();
  }
}

/** Extracts {@link DeepMetadata}. */
export class MetadataExtractor {
  private readonly detector: FormatDetector;
  private readonly probe: (file: File) => Promise<MediaInfo | null>;

  /**
   * @param options detector and probe overrides.
   */
  constructor(options: MetadataExtractorOptions = {}) {
    this.detector = options.detector ?? new FormatDetector();
    this.probe = options.probe ?? decoderProbe;
  }

  /**
   * Everything about one file.
   * @param file the file.
   * @param info an existing probe (skips decoding).
   * @returns the metadata.
   */
  async extract(file: File, info?: MediaInfo | null): Promise<DeepMetadata> {
    const kind = kindByExtension(file.name);
    let format: FormatInfo | null = null;
    try {
      format = await this.detector.detect(file);
    } catch {
      format = null;
    }
    const probed = info !== undefined ? info : kind === 'video' || kind === 'audio' || kind === 'image' ? await this.probe(file).catch(() => null) : null;
    const atoms = format && (format.container === 'mp4' || format.container === 'mov') ? await readMp4Atoms(file) : null;
    const duration = probed ? probed.duration.asNumber() || atoms?.durationSeconds || null : atoms?.durationSeconds ?? null;
    const width = probed?.width ?? 0;
    const height = probed?.height ?? 0;
    const meta: DeepMetadata = {
      name: file.name,
      size: file.size,
      mimeType: file.type,
      extension: extensionOf(file.name),
      lastModified: Number.isFinite(file.lastModified) && file.lastModified > 0 ? file.lastModified : null,
      kind: probed ? probed.type : kind,
      container: format?.container ?? 'unknown',
      videoCodec: probed?.videoCodec || format?.videoCodec || '',
      audioCodec: probed?.audioCodec || format?.audioCodec || '',
      duration,
      width,
      height,
      aspectRatio: aspectRatio(width, height),
      fps: probed && probed.type === 'video' ? probed.fps.fps().asNumber() : null,
      bitrate: duration && duration > 0 ? Math.round((file.size * 8) / duration) : null,
      audioSampleRate: probed?.audioSampleRate ?? 0,
      audioChannels: probed?.audioChannels ?? 0,
      creationTime: atoms?.creationTime ?? null,
      rotation: atoms?.rotation ?? 0,
      encoder: atoms?.encoder ?? null,
      nativelySupported: format ? this.detector.canHandleNatively(format) : false,
      needsFallback: format ? this.detector.needsFallback(format) : false,
      needsProxy: false,
    };
    meta.needsProxy = needsProxy(meta);
    return meta;
  }
}
