// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

// @vitest-environment jsdom

/** The FFmpeg.wasm fallback: argv, ffprobe/log parsing, the worker handlers over a fake core. */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FFmpegFallback,
  FFmpegUnavailableError,
  buildTranscodeArgs,
  channelsOfLayout,
  parseFFmpegLog,
  parseFFprobeJson,
  vendoredCoreUrls,
} from '../src/media/ffmpeg/ffmpeg-fallback.ts';
import {
  createFFmpegHandlers,
  isFFmpegCore,
  readExecRequest,
  type FFmpegCore,
  type FFmpegFS,
} from '../src/media/ffmpeg/ffmpeg-worker.ts';
import { WorkerClient } from '../src/workers/worker-client.ts';
import { linkedWorker } from './f4-helpers.ts';

/** ffprobe JSON of a 4K HEVC HDR MKV with 5.1 audio (real ffprobe 6 field names). */
export const PROBE_FIXTURE = {
  streams: [
    {
      index: 0, codec_name: 'hevc', codec_type: 'video', width: 3840, height: 2160, pix_fmt: 'yuv420p10le',
      color_range: 'tv', color_space: 'bt2020nc', color_transfer: 'smpte2084', color_primaries: 'bt2020',
      field_order: 'progressive', r_frame_rate: '24000/1001', avg_frame_rate: '24000/1001', bits_per_raw_sample: '10',
      display_aspect_ratio: '16:9', bit_rate: '40000000',
    },
    { index: 1, codec_name: 'eac3', codec_type: 'audio', sample_rate: '48000', channels: 6, channel_layout: '5.1(side)', bit_rate: '640000' },
    { index: 2, codec_name: 'subrip', codec_type: 'subtitle' },
    { index: 3, codec_type: 'data' },
  ],
  format: { format_name: 'matroska,webm', duration: '125.500000', size: '650000000', bit_rate: '41434262', tags: { title: 'Demo', creation_time: '2024-05-01T10:00:00.000000Z', ENCODER: 'Lavf60' } },
};

const LOG_FIXTURE = [
  "Input #0, avi, from '/input/input':",
  '  Metadata:',
  '    software        : Lavf58.29.100',
  '  Duration: 00:01:05.50, start: 0.000000, bitrate: 1521 kb/s',
  '  Stream #0:0: Video: mpeg4 (Simple Profile) (XVID / 0x44495658), yuv420p(tv, bt709, progressive), 720x480 [SAR 8:9 DAR 4:3], 1393 kb/s, 29.97 fps, 29.97 tbr, 29.97 tbn',
  '  Stream #0:1(eng): Audio: mp3 (U[0][0][0] / 0x0055), 44100 Hz, stereo, fltp, 128 kb/s',
  '  Stream #0:2: Subtitle: subrip',
];

describe('argv and parsing', () => {
  it('builds transcode arguments without ever selecting libx264', () => {
    const args = buildTranscodeArgs('/input/input', '/output/out.webm', {
      format: 'webm', videoCodec: 'libvpx', width: 1280, height: 720, fps: 30, videoBitrate: 2_000_000, audio: false, start: 2, duration: 5,
    });
    expect(args).toEqual([
      '-nostdin', '-y', '-ss', '2.000', '-i', '/input/input', '-t', '5.000', '-c:v', 'libvpx', '-vf', 'fps=30,scale=1280:720',
      '-b:v', '2000000', '-deadline', 'realtime', '-cpu-used', '8', '-pix_fmt', 'yuv420p', '-an', '-f', 'webm', '/output/out.webm',
    ]);
    expect(buildTranscodeArgs('i', 'o', { format: 'wav' })).toEqual(['-nostdin', '-y', '-i', 'i', '-vn', '-c:a', 'pcm_s16le', '-f', 'wav', 'o']);
    expect(buildTranscodeArgs('i', 'o', { format: 'mp4', videoCodec: 'copy', audioBitrate: 96000 })).toEqual([
      '-nostdin', '-y', '-i', 'i', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '96000', '-f', 'mp4', 'o',
    ]);
    expect(buildTranscodeArgs('i', 'o', { format: 'webm' }).join(' ')).not.toContain('264');
  });

  it('parses ffprobe JSON into the probe fields', () => {
    const probe = parseFFprobeJson(PROBE_FIXTURE);
    expect(probe.format).toBe('matroska,webm');
    expect(probe.duration.asNumber()).toBeCloseTo(125.5, 6);
    expect(probe.bitRate).toBe(41434262);
    expect(probe.size).toBe(650000000);
    expect(probe.metadata).toMatchObject({ title: 'Demo', ENCODER: 'Lavf60' });
    expect(probe.streams).toHaveLength(3);
    expect(probe.streams[0]).toMatchObject({
      type: 'video', codec: 'hevc', width: 3840, height: 2160, pixelFormat: 'yuv420p10le', colorSpace: 'bt2020nc',
      colorTransfer: 'smpte2084', colorPrimaries: 'bt2020', colorRange: 'tv', bitDepth: 10, fieldOrder: 'progressive',
      displayAspectRatio: '16:9', frameRateFraction: '24000/1001', bitRate: 40000000,
    });
    expect(probe.streams[0]!.fps).toBeCloseTo(23.976, 3);
    expect(probe.streams[1]).toMatchObject({ type: 'audio', codec: 'eac3', sampleRate: 48000, channels: 6, channelLayout: '5.1(side)' });
    expect(() => parseFFprobeJson(null)).toThrow();
    expect(parseFFprobeJson({}).streams).toEqual([]);
  });

  it('parses the ffmpeg -i log when ffprobe is unavailable', () => {
    const probe = parseFFmpegLog(LOG_FIXTURE);
    expect(probe.format).toBe('avi');
    expect(probe.duration.asNumber()).toBeCloseTo(65.5, 6);
    expect(probe.bitRate).toBe(1521000);
    expect(probe.metadata['software']).toBe('Lavf58.29.100');
    expect(probe.streams[0]).toMatchObject({
      type: 'video', codec: 'mpeg4', width: 720, height: 480, fps: 29.97, pixelFormat: 'yuv420p', colorRange: 'tv',
      colorSpace: 'bt709', fieldOrder: 'progressive', displayAspectRatio: '4:3', bitRate: 1393000,
    });
    expect(probe.streams[1]).toMatchObject({ type: 'audio', codec: 'mp3', sampleRate: 44100, channels: 2, channelLayout: 'stereo', bitRate: 128000 });
    expect(probe.streams[2]).toEqual({ type: 'subtitle', codec: 'subrip' });
  });

  it('counts channels of layouts', () => {
    expect(channelsOfLayout('mono')).toBe(1);
    expect(channelsOfLayout('stereo')).toBe(2);
    expect(channelsOfLayout('5.1(side)')).toBe(6);
    expect(channelsOfLayout('7.1')).toBe(8);
    expect(channelsOfLayout('3 channels')).toBe(3);
    expect(channelsOfLayout('quad')).toBe(4);
    expect(channelsOfLayout('weird')).toBe(2);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.each([
    ['./', 'https://blackbonedel.github.io/concat/', '/concat/'],
    ['./', 'https://blackbonedel.github.io/concat/index.html', '/concat/'],
    ['/concat/', 'https://blackbonedel.github.io/concat/', '/concat/'],
    ['/concat', 'https://blackbonedel.github.io/concat/', '/concat/'],
    ['/', 'https://blackbonedel.github.io/', '/'],
  ])('resolves core and wasm with base %s at %s', (base, page, expected) => {
    vi.stubEnv('BASE_URL', base);
    vi.stubGlobal('document', { baseURI: page });
    const urls = vendoredCoreUrls();
    expect(urls.coreURL).toBe(`https://blackbonedel.github.io${expected}vendor/ffmpeg/ffmpeg-core.js`);
    expect(urls.wasmURL).toBe(`https://blackbonedel.github.io${expected}vendor/ffmpeg/ffmpeg-core.wasm`);
  });

  it('resolves the vendored URLs against the document, never a CDN', () => {
    const urls = vendoredCoreUrls();
    expect(urls.coreURL).toMatch(/\/vendor\/ffmpeg\/ffmpeg-core\.js$/);
    expect(urls.wasmURL).toMatch(/\/vendor\/ffmpeg\/ffmpeg-core\.wasm$/);
    expect(new URL(urls.coreURL).host).toBe(new URL(document.baseURI).host);
  });

  it('ships the vendored core: wasm magic and an ESM default export', () => {
    const wasm = readFileSync(resolve(process.cwd(), 'src/vendor/ffmpeg/ffmpeg-core.wasm'));
    expect([...wasm.subarray(0, 4)]).toEqual([0, 0x61, 0x73, 0x6d]);
    const core = readFileSync(resolve(process.cwd(), 'src/vendor/ffmpeg/ffmpeg-core.js'), 'utf8');
    expect(core).toContain('export default createFFmpegCore');
    expect(readFileSync(resolve(process.cwd(), 'src/vendor/ffmpeg/README.md'), 'utf8')).toContain('5.1.4');
  });
});

/** A fake Emscripten core with an in-memory FS. */
function fakeCore(options: { workerfs?: boolean; ret?: number; probeJson?: boolean } = {}) {
  const files = new Map<string, Uint8Array>();
  const calls: string[][] = [];
  const mounts: string[] = [];
  let logger: (data: { type: string; message: string }) => void = () => undefined;
  let progress: (data: { progress: number; time: number }) => void = () => undefined;
  let ret = 0;
  const fs: FFmpegFS = {
    writeFile: (path, data) => files.set(path, data),
    readFile: (path) => {
      const found = files.get(path);
      if (!found) throw new Error('ENOENT');
      return found;
    },
    unlink: (path) => {
      files.delete(path);
    },
    mkdir: () => undefined,
    rmdir: () => undefined,
    mount: (_type, _opts, mountPoint) => mounts.push(mountPoint),
    unmount: (mountPoint) => mounts.push(`-${mountPoint}`),
    filesystems: options.workerfs === false ? {} : { WORKERFS: {} },
  };
  const outputOf = (args: string[]): string => args[args.length - 1]!;
  const core: FFmpegCore = {
    exec: (...args) => {
      calls.push(args);
      logger({ type: 'stderr', message: LOG_FIXTURE.join('\n') });
      for (const line of LOG_FIXTURE) logger({ type: 'stderr', message: line });
      progress({ progress: 0.5, time: 1 });
      const out = outputOf(args);
      if (out.endsWith('.pcm')) {
        files.set(out, new Uint8Array(new Float32Array([0.5, -0.5, 0.25, -0.25]).buffer));
      } else if (out.startsWith('/output/')) {
        files.set(out, new Uint8Array([1, 2, 3]));
      }
      ret = options.ret ?? 0;
      return ret;
    },
    ffprobe: (...args) => {
      calls.push(['ffprobe', ...args]);
      const at = args.indexOf('-o');
      if (options.probeJson !== false && at >= 0) files.set(args[at + 1]!, new TextEncoder().encode(JSON.stringify(PROBE_FIXTURE)));
      ret = options.probeJson === false ? 1 : 0;
      return ret;
    },
    reset: () => undefined,
    setLogger: (fn) => {
      logger = fn;
    },
    setProgress: (fn) => {
      progress = fn;
    },
    setTimeout: () => undefined,
    get ret() {
      return ret;
    },
    FS: fs,
  };
  return { core, files, calls, mounts };
}

function fallbackOver(core: FFmpegCore) {
  const link = linkedWorker(createFFmpegHandlers(async () => core));
  return new FFmpegFallback({ client: new WorkerClient(() => link.worker), urls: () => ({ coreURL: 'c.js', wasmURL: 'c.wasm' }) });
}

describe('FFmpegFallback over the worker handlers', () => {
  it('probes through ffprobe JSON with WORKERFS mounts', async () => {
    const fake = fakeCore();
    const ffmpeg = fallbackOver(fake.core);
    const probe = await ffmpeg.probe(new Blob(['x']));
    expect(probe.streams[0]!.codec).toBe('hevc');
    expect(fake.mounts).toEqual(['/input', '-/input']);
    expect(fake.calls[0]![0]).toBe('ffprobe');
    await ffmpeg.init(); // already loaded: no-op
  });

  it('falls back to log parsing and MEMFS writes when needed', async () => {
    const fake = fakeCore({ workerfs: false, probeJson: false });
    const ffmpeg = fallbackOver(fake.core);
    const probe = await ffmpeg.probe(new Blob(['x']));
    expect(probe.format).toBe('avi');
    expect(fake.mounts).toEqual([]);
    expect([...fake.files.keys()]).toEqual([]); // inputs cleaned up
  });

  it('transcodes, extracts audio and reports progress', async () => {
    const fake = fakeCore();
    const ffmpeg = fallbackOver(fake.core);
    const seen: number[] = [];
    ffmpeg.onProgress = (value) => seen.push(value);
    const out = await ffmpeg.transcode(new Blob(['x']), { format: 'webm', audio: false });
    expect(out.type).toBe('video/webm');
    expect(out.size).toBe(3);
    expect(seen).toContain(0.5);
    const audio = await ffmpeg.extractAudio(new Blob(['x']));
    expect(audio.numberOfChannels).toBe(2);
    expect(audio.sampleRate).toBe(48000);
    expect(Array.from(audio.getChannelData(0))).toEqual([0.5, 0.25]);
    const playable = await ffmpeg.conformForPreview(new Blob(['x']), { width: 3840, height: 2160 });
    expect(playable.type).toBe('video/webm');
    expect(fake.calls[fake.calls.length - 1]!.join(' ')).toContain('scale=1280:720');
  });

  it('surfaces non-zero exits with the log tail', async () => {
    const fake = fakeCore({ ret: 1 });
    const ffmpeg = fallbackOver(fake.core);
    await expect(ffmpeg.transcode(new Blob(['x']), { format: 'webm' })).rejects.toThrow(/Stream/);
  });

  it('fails gracefully when the core cannot load or workers are missing', async () => {
    const link = linkedWorker(createFFmpegHandlers(async () => {
      throw new Error('404');
    }));
    const broken = new FFmpegFallback({ client: new WorkerClient(() => link.worker), urls: () => ({ coreURL: 'c', wasmURL: 'w' }) });
    await expect(broken.init()).rejects.toBeInstanceOf(FFmpegUnavailableError);
    expect(broken.unavailable).toBe(true);
    await expect(broken.probe(new Blob(['x']))).rejects.toThrow(/vendor\/ffmpeg/);
    const none = new FFmpegFallback({ client: new WorkerClient(() => null) });
    await expect(none.init()).rejects.toThrow(/Web Workers/);
    none.terminate();
  });
});

describe('worker handler validation', () => {
  it('guards the core shape and the exec payload', async () => {
    expect(isFFmpegCore(fakeCore().core)).toBe(true);
    expect(isFFmpegCore({ exec: () => 0 })).toBe(false);
    expect(isFFmpegCore(null)).toBe(false);
    expect(() => readExecRequest(null)).toThrow();
    expect(() => readExecRequest({ args: [1] })).toThrow();
    expect(() => readExecRequest({ args: [], inputs: [{ name: '../x', data: new Blob() }] })).toThrow();
    expect(readExecRequest({ args: ['-i'], outputs: ['a', '../b', 3] })).toEqual({ args: ['-i'], inputs: [], outputs: ['a'], timeoutMs: -1, probe: false });
    const handlers = createFFmpegHandlers(async () => fakeCore().core);
    const tools = { progress: () => undefined, transfer: [] };
    expect(() => handlers['exec']!({ args: [] }, tools)).toThrow(/no está cargado/);
    await expect(Promise.resolve(handlers['load']!({ coreURL: 1 }, tools))).rejects.toThrow();
    expect(await handlers['load']!({ coreURL: 'a', wasmURL: 'b' }, tools)).toBe(true);
    expect(await handlers['load']!({ coreURL: 'a', wasmURL: 'b' }, tools)).toBe(false);
  });
});
