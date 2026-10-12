// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Container and codec sniffing by magic bytes (never by extension).
 *
 * The container comes from the first 16 KB: ISO-BMFF `ftyp` (MP4/MOV, plus
 * old QuickTime files that start with `moov`/`mdat`/`wide`/`free`), EBML
 * `1A 45 DF A3` with its DocType (`webm` vs `matroska`), `RIFF....AVI `,
 * `FLV\x01`, `OggS`. Codecs come from the same window (Matroska `CodecID`
 * strings, AVI `strh`/`strf`, FLV tag headers, Ogg identification packets)
 * and, for MP4/MOV whose `moov` sits at the end, from the last 512 KB.
 *
 * {@link FormatDetector.canHandleNatively} then decides between WebCodecs /
 * `<video>` and the FFmpeg.wasm fallback using `import/format-support.ts`.
 */

import {
  detectCapabilities,
  type CodecCapabilities,
  type ContainerName,
} from '../import/format-support.ts';

/** What the sniffing found. */
export interface FormatInfo {
  container: ContainerName;
  /** Codec family (`h264`, `hevc`, `vp9`, `av1`, `mpeg4`, `prores`, …) or `''`. */
  videoCodec: string;
  /** Codec family (`aac`, `opus`, `mp3`, `pcm`, `ac3`, …) or `''`. */
  audioCodec: string;
  /** The first bytes (up to 16). */
  magicBytes: Uint8Array;
}

/** Bytes read from the head. */
export const HEAD_BYTES = 16 * 1024;
/** Bytes read from the tail of MP4/MOV files. */
export const TAIL_BYTES = 512 * 1024;

/**
 * Exact byte→code-unit decoding (ISO-8859-1). `TextDecoder('latin1')` is
 * really windows-1252 per the WHATWG Encoding spec and remaps 0x80–0x9F.
 */
const latin1 = {
  decode(bytes: Uint8Array): string {
    let out = '';
    for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return out;
  },
};

/** MP4 sample-entry fourccs → codec family. */
const MP4_VIDEO: Record<string, string> = {
  avc1: 'h264', avc3: 'h264', hvc1: 'hevc', hev1: 'hevc', av01: 'av1', vp09: 'vp9', vp08: 'vp8',
  apch: 'prores', apcn: 'prores', apcs: 'prores', apco: 'prores', ap4h: 'prores', ap4x: 'prores',
  mp4v: 'mpeg4', jpeg: 'mjpeg', mjpa: 'mjpeg', dvh1: 'hevc',
};
const MP4_AUDIO: Record<string, string> = {
  mp4a: 'aac', Opus: 'opus', fLaC: 'flac', 'ac-3': 'ac3', 'ec-3': 'eac3', alac: 'alac', lpcm: 'pcm',
  sowt: 'pcm', twos: 'pcm', '.mp3': 'mp3',
};

/** Matroska CodecIDs → codec family. */
const MKV_VIDEO: Record<string, string> = {
  V_VP8: 'vp8', V_VP9: 'vp9', V_AV1: 'av1', 'V_MPEG4/ISO/AVC': 'h264', 'V_MPEGH/ISO/HEVC': 'hevc',
  'V_MPEG4/ISO/ASP': 'mpeg4', 'V_MS/VFW/FOURCC': 'vfw', V_THEORA: 'theora', V_PRORES: 'prores', V_MJPEG: 'mjpeg',
};
const MKV_AUDIO: Record<string, string> = {
  A_OPUS: 'opus', A_VORBIS: 'vorbis', A_AAC: 'aac', A_AC3: 'ac3', A_EAC3: 'eac3', A_FLAC: 'flac',
  A_MPEG: 'mp3', 'A_PCM/INT/LIT': 'pcm', 'A_PCM/FLOAT/IEEE': 'pcm', A_DTS: 'dts',
};

/** AVI video FourCCs → codec family. */
const AVI_VIDEO: Record<string, string> = {
  H264: 'h264', h264: 'h264', X264: 'h264', avc1: 'h264', XVID: 'mpeg4', xvid: 'mpeg4', DIVX: 'mpeg4', divx: 'mpeg4',
  DX50: 'mpeg4', FMP4: 'mpeg4', MP4V: 'mpeg4', MJPG: 'mjpeg', mjpg: 'mjpeg', DIV3: 'msmpeg4', MP42: 'msmpeg4',
  HEVC: 'hevc', H265: 'hevc', VP80: 'vp8', dvsd: 'dv', cvid: 'cinepak',
};

/** WAVEFORMATEX tags → codec family. */
const WAVE_TAGS: Record<number, string> = { 0x1: 'pcm', 0x3: 'pcm', 0x55: 'mp3', 0x50: 'mp2', 0xff: 'aac', 0x2000: 'ac3', 0x2001: 'dts', 0x161: 'wma' };

/** FLV codec ids. */
const FLV_VIDEO: Record<number, string> = { 2: 'h263', 3: 'screen', 4: 'vp6', 5: 'vp6', 7: 'h264', 12: 'hevc' };
const FLV_AUDIO: Record<number, string> = { 0: 'pcm', 2: 'mp3', 3: 'pcm', 10: 'aac', 11: 'speex', 14: 'mp3' };

/**
 * Reads the container from magic bytes.
 * @param head the first bytes of the file.
 * @returns the container.
 */
export function sniffContainer(head: Uint8Array): ContainerName {
  const ascii = (from: number, to: number): string => latin1.decode(head.subarray(from, to));
  if (head.length >= 12 && ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    return brand === 'qt  ' ? 'mov' : 'mp4';
  }
  if (head.length >= 8 && ['moov', 'mdat', 'wide', 'free', 'skip', 'pnot'].includes(ascii(4, 8))) return 'mov';
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    return ebmlDocType(head) === 'webm' ? 'webm' : 'mkv';
  }
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'AVI ') return 'avi';
  if (ascii(0, 3) === 'FLV' && head[3] === 0x01) return 'flv';
  if (ascii(0, 4) === 'OggS') return 'ogg';
  return 'unknown';
}

/** The EBML DocType string (element 0x4282), or `''`. */
export function ebmlDocType(head: Uint8Array): string {
  for (let i = 4; i + 3 < Math.min(head.length, 256); i += 1) {
    if (head[i] === 0x42 && head[i + 1] === 0x82) {
      const sizeByte = head[i + 2]!;
      // One-byte VINT (0x8X) is what every muxer writes for DocType.
      if ((sizeByte & 0x80) === 0) continue;
      const size = sizeByte & 0x7f;
      return latin1.decode(head.subarray(i + 3, i + 3 + size)).replace(/\0+$/, '');
    }
  }
  return '';
}

/** First key of `table` whose ASCII appears in `text`, by earliest position. */
function firstMatch(text: string, table: Record<string, string>): string {
  let best = '';
  let bestAt = Number.POSITIVE_INFINITY;
  for (const [needle, family] of Object.entries(table)) {
    const at = text.indexOf(needle);
    if (at >= 0 && at < bestAt) {
      bestAt = at;
      best = family;
    }
  }
  return best;
}

/** MP4/MOV codecs: sample entries inside `stsd`. */
function mp4Codecs(bytes: Uint8Array): { video: string; audio: string } {
  const text = latin1.decode(bytes);
  let video = '';
  let audio = '';
  let from = 0;
  for (;;) {
    const at = text.indexOf('stsd', from);
    if (at < 0) break;
    // stsd: size(4) 'stsd' version/flags(4) count(4) → entry size(4) + fourcc(4)
    const fourcc = text.slice(at + 16, at + 20);
    if (!video && MP4_VIDEO[fourcc]) video = MP4_VIDEO[fourcc]!;
    if (!audio && MP4_AUDIO[fourcc]) audio = MP4_AUDIO[fourcc]!;
    from = at + 4;
  }
  return { video, audio };
}

/** Matroska/WebM codecs: CodecID strings. */
function mkvCodecs(bytes: Uint8Array): { video: string; audio: string } {
  const text = latin1.decode(bytes);
  // Longest IDs first so 'V_MPEG4/ISO/AVC' wins over a prefix.
  return { video: firstMatch(text, MKV_VIDEO), audio: firstMatch(text, MKV_AUDIO) };
}

/** AVI codecs: `strh` fccHandler for video, `strf` WAVEFORMATEX tag for audio. */
function aviCodecs(bytes: Uint8Array): { video: string; audio: string } {
  const text = latin1.decode(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let video = '';
  let audio = '';
  let from = 0;
  for (;;) {
    const at = text.indexOf('strh', from);
    if (at < 0 || at + 16 > bytes.length) break;
    const type = text.slice(at + 8, at + 12);
    if (type === 'vids' && !video) {
      const handler = text.slice(at + 12, at + 16);
      video = AVI_VIDEO[handler] ?? '';
      // The BITMAPINFOHEADER compression is authoritative when the handler is blank.
      const strf = text.indexOf('strf', at);
      if (strf >= 0 && strf + 28 <= bytes.length) {
        const compression = text.slice(strf + 24, strf + 28);
        if (AVI_VIDEO[compression]) video = AVI_VIDEO[compression]!;
      }
      if (!video) video = handler.trim().toLowerCase();
    } else if (type === 'auds' && !audio) {
      const strf = text.indexOf('strf', at);
      if (strf >= 0 && strf + 10 <= bytes.length) {
        const tag = view.getUint16(strf + 8, true);
        audio = WAVE_TAGS[tag] ?? `0x${tag.toString(16)}`;
      }
    }
    from = at + 4;
  }
  return { video, audio };
}

/** FLV codecs: first audio/video tag headers. */
function flvCodecs(bytes: Uint8Array): { video: string; audio: string } {
  if (bytes.length < 13) return { video: '', audio: '' };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = view.getUint32(5) + 4; // header size + PreviousTagSize0
  let video = '';
  let audio = '';
  while (offset + 12 <= bytes.length && (!video || !audio)) {
    const tagType = bytes[offset]!;
    const dataSize = (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    const first = bytes[offset + 11];
    if (first !== undefined) {
      if (tagType === 9 && !video) video = FLV_VIDEO[first & 0x0f] ?? '';
      if (tagType === 8 && !audio) audio = FLV_AUDIO[first >> 4] ?? '';
    }
    offset += 11 + dataSize + 4;
  }
  return { video, audio };
}

/** Ogg codecs: identification packets. */
function oggCodecs(bytes: Uint8Array): { video: string; audio: string } {
  const text = latin1.decode(bytes);
  return {
    video: text.includes('\x80theora') ? 'theora' : text.includes('\x80daala') ? 'daala' : '',
    audio: text.includes('OpusHead') ? 'opus' : text.includes('\x01vorbis') ? 'vorbis' : text.includes('\x7fFLAC') ? 'flac' : '',
  };
}

/**
 * Sniffs codecs inside a known container.
 * @param container the container.
 * @param bytes head (and tail) bytes.
 * @returns codec families.
 */
export function sniffCodecs(container: ContainerName, bytes: Uint8Array): { video: string; audio: string } {
  switch (container) {
    case 'mp4':
    case 'mov':
      return mp4Codecs(bytes);
    case 'webm':
    case 'mkv':
      return mkvCodecs(bytes);
    case 'avi':
      return aviCodecs(bytes);
    case 'flv':
      return flvCodecs(bytes);
    case 'ogg':
      return oggCodecs(bytes);
    default:
      return { video: '', audio: '' };
  }
}

/** Decides between native decoding and the FFmpeg fallback. */
export class FormatDetector {
  private readonly capabilities: CodecCapabilities;

  /**
   * @param capabilities what this browser decodes (detected by default).
   */
  constructor(capabilities?: CodecCapabilities) {
    this.capabilities = capabilities ?? detectCapabilities();
  }

  /**
   * Detects container and codecs of a file from its bytes.
   * @param file the file.
   * @returns the format.
   */
  async detect(file: File | Blob): Promise<FormatInfo> {
    const head = new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer());
    const container = sniffContainer(head);
    let codecs = sniffCodecs(container, head);
    if ((container === 'mp4' || container === 'mov') && (!codecs.video || !codecs.audio) && file.size > HEAD_BYTES) {
      const tail = new Uint8Array(await file.slice(Math.max(HEAD_BYTES, file.size - TAIL_BYTES)).arrayBuffer());
      const fromTail = sniffCodecs(container, tail);
      codecs = { video: codecs.video || fromTail.video, audio: codecs.audio || fromTail.audio };
    }
    return { container, videoCodec: codecs.video, audioCodec: codecs.audio, magicBytes: head.slice(0, 16) };
  }

  /**
   * `true` when the browser decodes the container and every codec in it.
   * @param format the detected format.
   * @returns whether WebCodecs / `<video>` can take it.
   */
  canHandleNatively(format: FormatInfo): boolean {
    if (format.container === 'unknown') return false;
    if (!this.capabilities.containers.has(format.container)) return false;
    if (format.videoCodec !== '' && !this.capabilities.video.has(format.videoCodec)) return false;
    if (format.audioCodec !== '' && !this.capabilities.audio.has(format.audioCodec)) return false;
    return true;
  }

  /**
   * `true` when the FFmpeg fallback must decode this file.
   * @param format the detected format.
   * @returns the inverse of {@link canHandleNatively}.
   */
  needsFallback(format: FormatInfo): boolean {
    return !this.canHandleNatively(format);
  }

  /** The capabilities in use. */
  get caps(): CodecCapabilities {
    return this.capabilities;
  }
}
