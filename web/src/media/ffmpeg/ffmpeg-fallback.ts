// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * FFmpeg.wasm as the decoder of last resort.
 *
 * - Strict fallback: callers only reach here after `FormatDetector` said the
 *   browser cannot decode a file natively (MKV/AVI/FLV, HEVC on Firefox, …).
 * - Lazy: the 32 MB core loads on the first call, in a dedicated worker,
 *   from the vendored `/vendor/ffmpeg/` (never a CDN).
 * - Unloaded after 2 minutes idle (the worker is terminated, freeing the
 *   wasm heap).
 *
 * Memory: the vendored single-thread build (FFmpeg 5.1.4, `@ffmpeg/core`
 * 0.12.10) declares a 32 MB initial heap that grows on demand up to its
 * compiled maximum; those numbers are fixed inside the prebuilt binary, so
 * instead of resizing it the wrapper keeps inputs out of the heap (WORKERFS
 * mounts) and unloads when idle. See `src/vendor/ffmpeg/README.md`.
 */

import { Rational } from '../../core/rational.ts';
import { WorkerClient } from '../../workers/worker-client.ts';
import { createAudioBuffer, deinterleave, type AudioBufferLike } from '../audio/audio-buffer.ts';
import type { ExecResult } from './ffmpeg-worker.ts';

/** One stream of a probe. */
export interface ProbeStream {
  type: 'video' | 'audio' | 'subtitle';
  codec: string;
  width?: number;
  height?: number;
  fps?: number;
  sampleRate?: number;
  channels?: number;
  bitRate?: number;
  pixelFormat?: string;
  colorSpace?: string;
  colorTransfer?: string;
  colorPrimaries?: string;
  colorRange?: string;
  channelLayout?: string;
  bitDepth?: number;
  fieldOrder?: string;
  displayAspectRatio?: string;
  /** `r_frame_rate` as `num/den`, when known. */
  frameRateFraction?: string;
}

/** An ffprobe-like report. */
export interface ProbeResult {
  duration: Rational;
  streams: ProbeStream[];
  format: string;
  metadata: Record<string, string>;
  /** Total bit rate (bits/s), 0 when unknown. */
  bitRate?: number;
  /** File size reported by the probe. */
  size?: number;
}

/** Options for {@link FFmpegFallback.decodeToFrames}. */
export interface DecodeOptions {
  /** Seconds into the media. */
  start?: number;
  /** Seconds to decode (to the end by default). */
  duration?: number;
  width: number;
  height: number;
  /** Output frame rate (source rate when omitted). */
  fps?: number;
}

/** Options for {@link FFmpegFallback.transcode}. */
export interface TranscodeOptions {
  format: 'webm' | 'mp4' | 'wav' | 'ogg';
  videoCodec?: 'libvpx' | 'libvpx-vp9' | 'mpeg4' | 'copy' | 'none';
  audioCodec?: 'libvorbis' | 'libopus' | 'aac' | 'pcm_s16le' | 'copy' | 'none';
  width?: number;
  height?: number;
  fps?: number;
  /** Bits per second. */
  videoBitrate?: number;
  /** Bits per second. */
  audioBitrate?: number;
  /** `false` drops audio (same as `audioCodec: 'none'`). */
  audio?: boolean;
  start?: number;
  duration?: number;
}

/** Raised when the core cannot be loaded (missing files, no wasm, …). */
export class FFmpegUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FFmpegUnavailableError';
  }
}

/** The idle time after which the core is unloaded: 2 minutes. */
export const FFMPEG_IDLE_MS = 120_000;

/** Input file name inside the worker. */
const INPUT_NAME = 'input';

/** MIME type per output format. */
const MIME: Record<TranscodeOptions['format'], string> = {
  webm: 'video/webm',
  mp4: 'video/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
};

/**
 * The vendored core URLs, resolved with Vite BASE_URL against the document so
 * the app works under any sub-path (`base: './'`).
 * @returns absolute URLs of the core script and wasm.
 */
export function vendoredCoreUrls(): { coreURL: string; wasmURL: string } {
  const base =
    typeof document !== 'undefined' && document.baseURI
      ? document.baseURI
      : typeof location !== 'undefined'
        ? location.href
        : 'http://localhost/';
  const baseUrl = import.meta.env.BASE_URL.endsWith('/')
    ? import.meta.env.BASE_URL
    : `${import.meta.env.BASE_URL}/`;
  // BASE_URL can be './': resolving it against the origin would discard
  // the GitHub Pages subpath. Absolute bases such as '/concat/' work too.
  const appBase = new URL(baseUrl, base);
  return {
    coreURL: new URL('vendor/ffmpeg/ffmpeg-core.js', appBase).href,
    wasmURL: new URL('vendor/ffmpeg/ffmpeg-core.wasm', appBase).href,
  };
}

/**
 * The ffmpeg arguments of a transcode.
 * @param input input path inside the worker.
 * @param output output path inside the worker.
 * @param options the target.
 * @returns argv (without the leading `ffmpeg`).
 */
export function buildTranscodeArgs(input: string, output: string, options: TranscodeOptions): string[] {
  const args: string[] = ['-nostdin', '-y'];
  if (options.start !== undefined && options.start > 0) args.push('-ss', options.start.toFixed(3));
  args.push('-i', input);
  if (options.duration !== undefined && options.duration > 0) args.push('-t', options.duration.toFixed(3));
  const videoCodec = options.videoCodec ?? (options.format === 'wav' || options.format === 'ogg' ? 'none' : 'libvpx');
  if (videoCodec === 'none') {
    args.push('-vn');
  } else {
    args.push('-c:v', videoCodec);
    if (videoCodec !== 'copy') {
      const filters: string[] = [];
      if (options.fps !== undefined && options.fps > 0) filters.push(`fps=${options.fps}`);
      if (options.width !== undefined && options.height !== undefined && options.width > 0 && options.height > 0) {
        filters.push(`scale=${Math.round(options.width)}:${Math.round(options.height)}`);
      }
      if (filters.length > 0) args.push('-vf', filters.join(','));
      if (options.videoBitrate !== undefined) args.push('-b:v', String(Math.round(options.videoBitrate)));
      if (videoCodec === 'libvpx' || videoCodec === 'libvpx-vp9') args.push('-deadline', 'realtime', '-cpu-used', '8');
      args.push('-pix_fmt', 'yuv420p');
    }
  }
  const audioCodec =
    options.audio === false
      ? 'none'
      : options.audioCodec ?? (options.format === 'wav' ? 'pcm_s16le' : options.format === 'mp4' ? 'aac' : 'libvorbis');
  if (audioCodec === 'none') {
    args.push('-an');
  } else {
    args.push('-c:a', audioCodec);
    if (audioCodec !== 'copy' && audioCodec !== 'pcm_s16le' && options.audioBitrate !== undefined) {
      args.push('-b:a', String(Math.round(options.audioBitrate)));
    }
  }
  args.push('-f', options.format, output);
  return args;
}

/** `"30000/1001"` → 29.97; `"0/0"` → undefined. */
function parseFraction(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const [num, den] = value.split('/').map(Number);
  if (num === undefined || !Number.isFinite(num)) return undefined;
  if (den === undefined) return num;
  return den > 0 ? num / den : undefined;
}

/** A number from an ffprobe string/number field. */
function parseNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

/** A string field. */
function parseString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Tags object → string record. */
function parseTags(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof value !== 'object' || value === null) return out;
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' || typeof item === 'number') out[key] = String(item);
  }
  return out;
}

/**
 * Parses `ffprobe -print_format json -show_format -show_streams` output.
 * @param json the parsed JSON.
 * @returns the probe.
 */
export function parseFFprobeJson(json: unknown): ProbeResult {
  if (typeof json !== 'object' || json === null) throw new Error('Salida de ffprobe inválida');
  const rawStreams: unknown = Reflect.get(json, 'streams');
  const rawFormat: unknown = Reflect.get(json, 'format');
  const streams: ProbeStream[] = [];
  if (Array.isArray(rawStreams)) {
    for (const raw of rawStreams) {
      if (typeof raw !== 'object' || raw === null) continue;
      const type: unknown = Reflect.get(raw, 'codec_type');
      if (type !== 'video' && type !== 'audio' && type !== 'subtitle') continue;
      const stream: ProbeStream = { type, codec: parseString(Reflect.get(raw, 'codec_name')) ?? '' };
      const set = <K extends keyof ProbeStream>(key: K, value: ProbeStream[K] | undefined): void => {
        if (value !== undefined) stream[key] = value;
      };
      set('width', parseNumber(Reflect.get(raw, 'width')));
      set('height', parseNumber(Reflect.get(raw, 'height')));
      const rate = parseString(Reflect.get(raw, 'r_frame_rate')) ?? parseString(Reflect.get(raw, 'avg_frame_rate'));
      if (type === 'video') {
        set('fps', parseFraction(rate));
        set('frameRateFraction', rate && rate !== '0/0' ? rate : undefined);
      }
      set('sampleRate', parseNumber(Reflect.get(raw, 'sample_rate')));
      set('channels', parseNumber(Reflect.get(raw, 'channels')));
      set('bitRate', parseNumber(Reflect.get(raw, 'bit_rate')));
      set('pixelFormat', parseString(Reflect.get(raw, 'pix_fmt')));
      set('colorSpace', parseString(Reflect.get(raw, 'color_space')));
      set('colorTransfer', parseString(Reflect.get(raw, 'color_transfer')));
      set('colorPrimaries', parseString(Reflect.get(raw, 'color_primaries')));
      set('colorRange', parseString(Reflect.get(raw, 'color_range')));
      set('channelLayout', parseString(Reflect.get(raw, 'channel_layout')));
      set(
        'bitDepth',
        parseNumber(Reflect.get(raw, 'bits_per_raw_sample')) ?? parseNumber(Reflect.get(raw, 'bits_per_sample')),
      );
      set('fieldOrder', parseString(Reflect.get(raw, 'field_order')));
      set('displayAspectRatio', parseString(Reflect.get(raw, 'display_aspect_ratio')));
      streams.push(stream);
    }
  }
  const format = typeof rawFormat === 'object' && rawFormat !== null ? rawFormat : {};
  const duration = parseNumber(Reflect.get(format, 'duration')) ?? 0;
  const result: ProbeResult = {
    duration: Rational.approximate(duration) ?? Rational.ZERO,
    streams,
    format: parseString(Reflect.get(format, 'format_name')) ?? 'unknown',
    metadata: parseTags(Reflect.get(format, 'tags')),
  };
  const bitRate = parseNumber(Reflect.get(format, 'bit_rate'));
  if (bitRate !== undefined) result.bitRate = bitRate;
  const size = parseNumber(Reflect.get(format, 'size'));
  if (size !== undefined) result.size = size;
  return result;
}

/** `HH:MM:SS.ss` → seconds. */
function parseClock(value: string): number {
  const parts = value.split(':').map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return 0;
  return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
}

/**
 * Parses the stream summary `ffmpeg -i` prints (when `ffprobe` is absent).
 * @param lines the log.
 * @returns the probe.
 */
export function parseFFmpegLog(lines: readonly string[]): ProbeResult {
  const streams: ProbeStream[] = [];
  let duration = 0;
  let format = 'unknown';
  let bitRate: number | undefined;
  const metadata: Record<string, string> = {};
  let inMetadata = false;
  for (const raw of lines) {
    const line = raw.trim();
    const input = /^Input #0, ([^ ]+?),? from/.exec(line);
    if (input) format = input[1]!.replace(/,$/, '');
    const dur = /Duration: (\d+:\d+:[\d.]+)(?:.*bitrate: (\d+) kb\/s)?/.exec(line);
    if (dur) {
      duration = parseClock(dur[1]!);
      if (dur[2]) bitRate = Number(dur[2]) * 1000;
      inMetadata = false;
    }
    if (line === 'Metadata:') {
      inMetadata = streams.length === 0;
      continue;
    }
    const tag = /^([A-Za-z_][\w-]*)\s*:\s(.*)$/.exec(line);
    if (inMetadata && tag && !line.startsWith('Stream') && !line.startsWith('Duration')) {
      metadata[tag[1]!] = tag[2]!;
      continue;
    }
    const stream = /Stream #\d+:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?: (Video|Audio|Subtitle): (.*)$/.exec(line);
    if (!stream) continue;
    inMetadata = false;
    const kind = stream[1]!.toLowerCase();
    const body = stream[2]!;
    const codec = body.split(/[ ,(]/)[0] ?? '';
    if (kind === 'video') {
      const entry: ProbeStream = { type: 'video', codec };
      const size = /, (\d{2,5})x(\d{2,5})/.exec(body);
      if (size) {
        entry.width = Number(size[1]);
        entry.height = Number(size[2]);
      }
      const fps = /, ([\d.]+) fps/.exec(body);
      if (fps) entry.fps = Number(fps[1]);
      const pix = /, ([a-z0-9_]+)\(([^)]*)\)/.exec(body) ?? /, (yuv[a-z0-9_]+|rgb[a-z0-9_]+|gbr[a-z0-9_]+|nv12|p010le)/.exec(body);
      if (pix) {
        entry.pixelFormat = pix[1]!;
        const details = (pix[2] ?? '').split(/[,/]/).map((part) => part.trim());
        if (details.includes('tv')) entry.colorRange = 'tv';
        if (details.includes('pc')) entry.colorRange = 'pc';
        const space = details.find((part) => /^(bt709|bt2020nc|bt2020c|bt470bg|smpte170m|rgb)$/.test(part));
        if (space) entry.colorSpace = space;
        const transfer = details.find((part) => /^(smpte2084|arib-std-b67|bt709|iec61966-2-1)$/.test(part));
        if (transfer) entry.colorTransfer = transfer;
        if (details.includes('progressive')) entry.fieldOrder = 'progressive';
        if (details.some((part) => /^(tt|bb|tb|bt)$/.test(part))) entry.fieldOrder = 'interlaced';
      }
      const dar = /DAR (\d+:\d+)/.exec(body);
      if (dar) entry.displayAspectRatio = dar[1]!;
      const kbps = /, (\d+) kb\/s/.exec(body);
      if (kbps) entry.bitRate = Number(kbps[1]) * 1000;
      streams.push(entry);
    } else if (kind === 'audio') {
      const entry: ProbeStream = { type: 'audio', codec };
      const rate = /, (\d+) Hz/.exec(body);
      if (rate) entry.sampleRate = Number(rate[1]);
      const layout = /Hz, ([^,]+)/.exec(body);
      if (layout) {
        entry.channelLayout = layout[1]!.trim();
        entry.channels = channelsOfLayout(entry.channelLayout);
      }
      const kbps = /, (\d+) kb\/s/.exec(body);
      if (kbps) entry.bitRate = Number(kbps[1]) * 1000;
      streams.push(entry);
    } else {
      streams.push({ type: 'subtitle', codec });
    }
  }
  const result: ProbeResult = { duration: Rational.approximate(duration) ?? Rational.ZERO, streams, format, metadata };
  if (bitRate !== undefined) result.bitRate = bitRate;
  return result;
}

/**
 * Channel count of an FFmpeg layout name.
 * @param layout `mono`, `stereo`, `5.1(side)`, `7.1`, `3 channels`…
 * @returns the count (2 when unknown).
 */
export function channelsOfLayout(layout: string): number {
  const value = layout.toLowerCase();
  if (value.startsWith('mono')) return 1;
  if (value.startsWith('stereo') || value.startsWith('downmix')) return 2;
  const explicit = /^(\d+) channels/.exec(value);
  if (explicit) return Number(explicit[1]);
  const surround = /^(\d+)\.(\d+)/.exec(value);
  if (surround) return Number(surround[1]) + Number(surround[2]);
  if (value.startsWith('quad')) return 4;
  return 2;
}

/** The FFmpeg.wasm fallback decoder/transcoder. */
export class FFmpegFallback {
  private readonly client: WorkerClient;
  private readonly urls: () => { coreURL: string; wasmURL: string };
  private loading: Promise<void> | null = null;
  private failed: FFmpegUnavailableError | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  /** Progress of the running command, 0..1. */
  onProgress: ((value: number) => void) | null = null;

  /**
   * @param options worker client and URL overrides (tests inject doubles).
   */
  constructor(options: { client?: WorkerClient; urls?: () => { coreURL: string; wasmURL: string } } = {}) {
    this.client =
      options.client ??
      new WorkerClient(
        () =>
          typeof Worker === 'undefined'
            ? null
            : new Worker(new URL('../../workers/ffmpeg-worker.ts', import.meta.url), { type: 'module' }),
        FFMPEG_IDLE_MS,
      );
    this.urls = options.urls ?? vendoredCoreUrls;
  }

  /** `true` once {@link init} failed (callers show a clear message). */
  get unavailable(): boolean {
    return this.failed !== null;
  }

  /**
   * Loads the core (once; again after an idle unload).
   * @throws FFmpegUnavailableError when it cannot load.
   */
  async init(): Promise<void> {
    if (this.failed) throw this.failed;
    if (this.loading && this.client.alive) return this.loading;
    if (!this.client.available) {
      this.failed = new FFmpegUnavailableError('FFmpeg necesita Web Workers, que este navegador no ofrece.');
      throw this.failed;
    }
    const { coreURL, wasmURL } = this.urls();
    this.loading = this.client.request<boolean>('load', { coreURL, wasmURL }).then(
      () => undefined,
      (error: unknown) => {
        this.loading = null;
        this.failed = new FFmpegUnavailableError(
          `No se pudo cargar FFmpeg.wasm desde /vendor/ffmpeg/: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw this.failed;
      },
    );
    return this.loading;
  }

  /**
   * ffprobe-like analysis (falls back to parsing `ffmpeg -i` output).
   * @param file the media.
   * @returns the probe.
   */
  async probe(file: File | Blob): Promise<ProbeResult> {
    const probe = await this.run(
      ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', '-o', '/output/probe.json', `/input/${INPUT_NAME}`],
      file,
      ['probe.json'],
      true,
    );
    const json = probe.files['probe.json'];
    if (probe.ret === 0 && json && json.length > 0) {
      return parseFFprobeJson(JSON.parse(new TextDecoder().decode(json)));
    }
    const fallback = await this.run(['-hide_banner', '-i', `/input/${INPUT_NAME}`], file, [], false);
    const parsed = parseFFmpegLog(fallback.logs);
    if (parsed.streams.length === 0) throw new Error('FFmpeg no reconoce el archivo');
    return parsed;
  }

  /**
   * Decodes frames as RGBA `VideoFrame`s (caller closes each one).
   * @param file the media.
   * @param options range and output size.
   * @yields frames in presentation order.
   */
  async *decodeToFrames(file: File | Blob, options: DecodeOptions): AsyncGenerator<VideoFrame> {
    if (typeof VideoFrame === 'undefined') throw new Error('VideoFrame no disponible en este navegador');
    const width = Math.max(2, Math.round(options.width));
    const height = Math.max(2, Math.round(options.height));
    const filters = [`scale=${width}:${height}`];
    if (options.fps) filters.unshift(`fps=${options.fps}`);
    const args = ['-nostdin', '-y'];
    if (options.start && options.start > 0) args.push('-ss', options.start.toFixed(3));
    args.push('-i', `/input/${INPUT_NAME}`);
    if (options.duration && options.duration > 0) args.push('-t', options.duration.toFixed(3));
    args.push('-an', '-vf', filters.join(','), '-pix_fmt', 'rgba', '-f', 'rawvideo', '/output/frames.raw');
    const result = await this.run(args, file, ['frames.raw'], false);
    const raw = result.files['frames.raw'];
    if (result.ret !== 0 || !raw) throw new Error(lastLines(result.logs) || 'FFmpeg no pudo decodificar');
    const frameBytes = width * height * 4;
    const fps = options.fps ?? 30;
    for (let index = 0; (index + 1) * frameBytes <= raw.length; index += 1) {
      const slice = raw.subarray(index * frameBytes, (index + 1) * frameBytes);
      yield new VideoFrame(slice, {
        format: 'RGBA',
        codedWidth: width,
        codedHeight: height,
        timestamp: Math.round(((options.start ?? 0) + index / fps) * 1e6),
        duration: Math.round(1e6 / fps),
      });
    }
  }

  /**
   * Extracts the audio as 48 kHz stereo float.
   * @param file the media.
   * @returns the decoded buffer.
   */
  async extractAudio(file: File | Blob): Promise<AudioBufferLike> {
    const result = await this.run(
      ['-nostdin', '-y', '-i', `/input/${INPUT_NAME}`, '-vn', '-ac', '2', '-ar', '48000', '-f', 'f32le', '/output/audio.pcm'],
      file,
      ['audio.pcm'],
      false,
    );
    const pcm = result.files['audio.pcm'];
    if (result.ret !== 0 || !pcm) throw new Error(lastLines(result.logs) || 'El archivo no tiene audio');
    const aligned = new Float32Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 4));
    return createAudioBuffer(deinterleave(aligned, 2), 48000);
  }

  /**
   * Transcodes a file.
   * @param input the media.
   * @param output the target.
   * @returns the transcoded file.
   */
  async transcode(input: Blob, output: TranscodeOptions): Promise<Blob> {
    const name = `out.${output.format}`;
    const result = await this.run(buildTranscodeArgs(`/input/${INPUT_NAME}`, `/output/${name}`, output), input, [name], false);
    const bytes = result.files[name];
    if (result.ret !== 0 || !bytes) throw new Error(lastLines(result.logs) || 'La transcodificación falló');
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    return new Blob([copy.buffer], { type: MIME[output.format] });
  }

  /**
   * A browser-playable version (VP8/Vorbis WebM, ≤ 1280×720) for preview of
   * files the browser cannot decode.
   * @param input the media.
   * @param size the source size (for aspect), when known.
   * @returns the playable file.
   */
  async conformForPreview(input: Blob, size?: { width: number; height: number }): Promise<Blob> {
    const scale = size && size.width > 0 && size.height > 0 ? Math.min(1, 1280 / size.width, 720 / size.height) : 1;
    const target = size && size.width > 0 ? { width: Math.round((size.width * scale) / 2) * 2, height: Math.round((size.height * scale) / 2) * 2 } : {};
    return this.transcode(input, { format: 'webm', videoCodec: 'libvpx', audioCodec: 'libvorbis', videoBitrate: 2_500_000, audioBitrate: 128_000, ...target });
  }

  /**
   * Fase 6 hook: runs an arbitrary command with several named inputs
   * (mounted under `/input/`) and collects named outputs from `/output/` —
   * the export fallback muxes rendered frames and the mix this way.
   * Serialized with every other command.
   * @param args ffmpeg argv (without the leading `ffmpeg`).
   * @param inputs files to mount, by name.
   * @param outputs output file names to read back.
   * @returns exit code, log and outputs.
   */
  execute(args: string[], inputs: { name: string; data: Blob }[], outputs: string[]): Promise<ExecResult> {
    const task = async (): Promise<ExecResult> => {
      await this.init();
      return this.client.request<ExecResult>('exec', { args, inputs, outputs, timeoutMs: -1, probe: false }, [], (value) => this.onProgress?.(value));
    };
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Unloads the core now. */
  terminate(): void {
    this.client.terminate('FFmpeg descargado');
    this.loading = null;
  }

  /** Runs one command, serialized (the core is single-threaded). */
  private run(args: string[], input: Blob, outputs: string[], probe: boolean): Promise<ExecResult> {
    const task = async (): Promise<ExecResult> => {
      await this.init();
      return this.client.request<ExecResult>(
        'exec',
        { args, inputs: [{ name: INPUT_NAME, data: input }], outputs, timeoutMs: -1, probe },
        [],
        (value) => this.onProgress?.(value),
      );
    };
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

/** The tail of a log, for error messages. */
function lastLines(logs: readonly string[], count = 3): string {
  return logs.filter((line) => line.trim() !== '').slice(-count).join(' · ');
}
