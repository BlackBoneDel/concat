// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Fase 6: renderer, audio exporter, encoder pools and the FFmpeg fallback. */

import { describe, expect, it, vi } from 'vitest';
import { Rational } from '../src/core/rational.ts';
import { AudioEncoderPool, audioCodecString } from '../src/export/audio-encoder-pool.ts';
import { AudioExporter, audioBlocks, collectAudioClips, isPcmBuffer, mixManually, type AudioClipSource } from '../src/export/audio-exporter.ts';
import { exportSession, snapshotForExport, trackAudible, visualMediaPaths } from '../src/export/export-document.ts';
import { buildFallbackArgs, encodeWav, FFmpegMuxFallback, type FFmpegExecutor } from '../src/export/ffmpeg-mux-fallback.ts';
import { OfflineRenderer, PREVIEW_MAX_WIDTH } from '../src/export/offline-renderer.ts';
import { defaultExportConfig, ExportError, type EncodedPacket, type ExportConfig } from '../src/export/types.ts';
import { h264Level, VideoEncoderPool, videoCodecCandidates, vp9Level, av1Level, copyBytes } from '../src/export/video-encoder-pool.ts';
import type { FramePool } from '../src/render/types.ts';
import { makeSession } from './f3-helpers.ts';
import { bufferOf } from './f4-helpers.ts';
import { FakeAudioEncoder, FakeMedia, FakeOfflineContext, FakeSurface, FakeVideoEncoder } from './f6-helpers.ts';

const r = (value: number): Rational => Rational.approximate(value) ?? Rational.ZERO;

function smallConfig(overrides: Partial<ExportConfig> = {}): ExportConfig {
  return { ...defaultExportConfig(), width: 64, height: 36, frameRate: { num: 10, den: 1 }, videoBitrate: 500_000, ...overrides };
}

const emptyPool: FramePool = { getFrame: async () => null, getSize: () => null };

describe('export-document', () => {
  it('snapshots without mutating and drops disabled clips', () => {
    const session = makeSession([{ start: 0, duration: 1 }, { start: 1, duration: 1 }]);
    const doc = session.document;
    doc.timelines[0]!.clips[1]!.extra['enabled'] = false;
    const snapshot = snapshotForExport(doc, { burnSubtitles: true });
    expect(snapshot.timelines[0]!.clips).toHaveLength(1);
    expect(doc.timelines[0]!.clips).toHaveLength(2);
    expect(snapshot).not.toBe(doc);
  });

  it('removes subtitle clips unless burned in', () => {
    const session = makeSession([{ start: 0, duration: 1 }, { start: 0, duration: 1, trackId: 'T2' }]);
    session.document.timelines[0]!.clips[1]!.extra['subtitle'] = { cueId: 'x' };
    expect(snapshotForExport(session.document, { burnSubtitles: false }).timelines[0]!.clips).toHaveLength(1);
    expect(snapshotForExport(session.document, { burnSubtitles: true }).timelines[0]!.clips).toHaveLength(2);
  });

  it('honours mute and solo', () => {
    const session = makeSession();
    const tracks = session.document.timelines[0]!.tracks;
    const [a, b] = tracks;
    expect(trackAudible(a!, tracks)).toBe(true);
    b!.extra['solo'] = true;
    expect(trackAudible(a!, tracks)).toBe(false);
    expect(trackAudible(b!, tracks)).toBe(true);
    b!.muted = true;
    expect(trackAudible(b!, tracks)).toBe(false);
  });

  it('lists visual media paths of visible lanes', () => {
    const session = makeSession([{ start: 0, duration: 1 }]);
    const engine = exportSession(snapshotForExport(session.document, { burnSubtitles: true }));
    expect(visualMediaPaths(engine)).toEqual(['m1']);
  });
});

describe('OfflineRenderer', () => {
  function renderer(options: { output?: 'frames' | 'pixels' | 'jpeg'; signal?: AbortSignal; hasMedia?: (path: string) => boolean; maxInFlight?: number } = {}) {
    const session = makeSession([{ start: 0, duration: 1 }]);
    const surfaces: FakeSurface[] = [];
    const times: number[] = [];
    const instance = new OfflineRenderer(
      { document: session.document, frames: emptyPool, hasMedia: options.hasMedia ?? (() => true) },
      {
        config: smallConfig(),
        range: { start: Rational.ZERO, end: r(1) },
        signal: options.signal,
        output: options.output,
        maxInFlight: options.maxInFlight,
        createSurface: (w, h) => {
          const surface = new FakeSurface(w, h);
          surfaces.push(surface);
          return surface;
        },
        composite: async (_timeline, time) => {
          times.push(time.asNumber());
        },
      },
    );
    return { instance, surfaces, times };
  }

  it('renders every frame with µs timestamps and keyframes', async () => {
    const { instance, surfaces, times } = renderer();
    await instance.prepare();
    expect(instance.totalFrames).toBe(10);
    const timestamps: number[] = [];
    const keys: boolean[] = [];
    for await (const frame of instance.renderAll()) {
      timestamps.push(frame.timestamp);
      keys.push(frame.keyFrame);
      expect(frame.duration).toBe(100_000);
      frame.release();
      frame.release();
    }
    expect(timestamps).toEqual([0, 100_000, 200_000, 300_000, 400_000, 500_000, 600_000, 700_000, 800_000, 900_000]);
    expect(keys[0]).toBe(true);
    expect(times).toHaveLength(10);
    expect(surfaces[0]!.frames.every((frame) => frame.closed)).toBe(true);
    expect(instance.framesInFlight).toBe(0);
    instance.dispose();
    instance.dispose();
    expect(surfaces[0]!.disposed).toBe(true);
  });

  it('returns pixels or jpeg depending on output', async () => {
    const pixels = renderer({ output: 'pixels' });
    await pixels.instance.prepare();
    const frame = await pixels.instance.renderFrame(0);
    expect(frame.pixels?.length).toBe(64 * 36 * 4);
    expect(frame.frame).toBeNull();
    frame.release();
    const jpeg = renderer({ output: 'jpeg' });
    await jpeg.instance.prepare();
    const encoded = await jpeg.instance.renderFrame(3);
    expect(encoded.jpeg?.type).toBe('image/jpeg');
    expect(encoded.timestamp).toBe(300_000);
    encoded.release();
    expect(await jpeg.instance.preview()).toBeNull();
    expect(jpeg.surfaces[0]!.previews).toBe(1);
    expect(PREVIEW_MAX_WIDTH).toBe(480);
  });

  it('throws NO_MEDIA when an original is missing', async () => {
    const { instance } = renderer({ hasMedia: () => false });
    await expect(instance.prepare()).rejects.toMatchObject({ code: 'NO_MEDIA' });
  });

  it('caps frames in flight and resumes on release', async () => {
    const { instance } = renderer({ maxInFlight: 2 });
    await instance.prepare();
    const iterator = instance.renderAll();
    const first = await iterator.next();
    const second = await iterator.next();
    expect(instance.framesInFlight).toBe(2);
    let resolved = false;
    const third = iterator.next().then((value) => {
      resolved = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(resolved).toBe(false);
    if (!first.done) first.value.release();
    const value = await third;
    expect(value.done).toBe(false);
    if (!second.done) second.value.release();
    if (!value.done) value.value.release();
    instance.dispose();
    expect((await iterator.next()).done).toBe(true);
  });

  it('aborts', async () => {
    const abort = new AbortController();
    const { instance } = renderer({ signal: abort.signal });
    await instance.prepare();
    abort.abort();
    await expect(instance.renderFrame(0)).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('requires prepare', async () => {
    const { instance } = renderer();
    expect(() => instance.totalFrames).toThrow();
    await expect(instance.renderFrame(0)).rejects.toThrow();
  });
});

describe('AudioExporter', () => {
  function clipOf(buffer = bufferOf([new Float32Array(48_000).fill(0.5), new Float32Array(48_000).fill(-0.5)]), start = 0): AudioClipSource {
    return { trackId: 'T3', key: 'a1', spec: { timelineStart: start, sourceOffset: 0, duration: 1, buffer, volume: 1, fadeIn: 0, fadeOut: 0, rate: 1 } };
  }

  it('counts frames and rejects empty ranges', () => {
    const exporter = new AudioExporter();
    expect(exporter.totalFrames(Rational.ZERO, r(1.5))).toBe(72_000);
    expect(() => exporter.totalFrames(r(1), r(1))).toThrow(ExportError);
  });

  it('renders windows through the offline context, trimming the pre-roll', async () => {
    const contexts: FakeOfflineContext[] = [];
    const exporter = new AudioExporter({
      sampleRate: 1000,
      channels: 2,
      windowSeconds: 1,
      prerollSeconds: 0.5,
      createContext: (channels, length, rate) => {
        const context = new FakeOfflineContext(channels, length, rate);
        contexts.push(context);
        return context;
      },
    });
    const clip = clipOf(bufferOf([new Float32Array(3000)], 1000));
    clip.spec.duration = 3;
    const windows = [];
    for await (const window of exporter.render([clip], Rational.ZERO, r(2.5))) windows.push(window);
    expect(windows.map((w) => w.offsetFrames)).toEqual([0, 1000, 2000]);
    expect(windows.map((w) => w.planes[0]!.length)).toEqual([1000, 1000, 500]);
    // First window: no pre-roll (starts at 0). Later ones skip 500 samples.
    expect(contexts[0]!.length).toBe(1000);
    expect(windows[0]!.planes[0]![0]).toBe(0);
    expect(contexts[1]!.length).toBe(1500);
    expect(windows[1]!.planes[0]![0]).toBe(500);
    expect(windows[1]!.planes[1]![0]).toBe(1500);
    expect(contexts[0]!.of('source').length).toBe(1);
    expect(exporter.usedManualMix).toBe(false);
  });

  it('returns silence without active clips and mixes by hand without a context', async () => {
    const exporter = new AudioExporter({ sampleRate: 48_000, createContext: () => null });
    const silent = await exporter.renderWindow([clipOf(undefined, 10)], 0, 480);
    expect(silent[0]!.every((v) => v === 0)).toBe(true);
    const mixed = await exporter.renderWindow([clipOf(), clipOf()], 0, 480);
    expect(mixed[0]![100]).toBeCloseTo(1);
    expect(mixed[1]![100]).toBeCloseTo(-1);
    expect(exporter.usedManualMix).toBe(true);
  });

  it('applies fades, volume, rate and down-mix in the manual mix', () => {
    const clip = clipOf();
    clip.spec.fadeIn = 0.5;
    clip.spec.volume = 0.5;
    const planes = mixManually([clip], 0, 48_000, 48_000, 1);
    expect(planes[0]![0]).toBeCloseTo(0);
    expect(planes[0]![24_000 + 100]).toBeCloseTo(0);
    const solo = clipOf(bufferOf([new Float32Array(48_000).fill(0.4)]));
    solo.spec.fadeOut = 0.5;
    const out = mixManually([solo], 0, 48_000, 48_000, 2);
    expect(out[1]![1000]).toBeCloseTo(0.4);
    expect(out[0]![47_999]).toBeLessThan(0.01);
    expect(isPcmBuffer({ duration: 1 })).toBe(false);
  });

  it('honours abort', async () => {
    const abort = new AbortController();
    abort.abort();
    const exporter = new AudioExporter({ signal: abort.signal, createContext: () => null });
    await expect(exporter.render([], Rational.ZERO, r(1)).next()).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('splits windows into timestamped blocks', () => {
    const blocks = [...audioBlocks({ offsetFrames: 48_000, planes: [new Float32Array(2500), new Float32Array(2500)] }, 48_000)];
    expect(blocks.map((b) => b.frames)).toEqual([1024, 1024, 452]);
    expect(blocks[0]!.timestamp).toBe(1_000_000);
    expect(blocks[1]!.timestamp).toBe(1_021_333);
  });

  it('collects audible clips with buffers', async () => {
    const session = makeSession([{ start: 0, duration: 1 }, { start: 0, duration: 1, kind: 'audio', trackId: 'T3' }]);
    const engine = exportSession(snapshotForExport(session.document, { burnSubtitles: true }));
    const media = new FakeMedia();
    media.buffers.set('mA', bufferOf([new Float32Array(10)]));
    const clips = await collectAudioClips(engine, (path) => media.getAudioBuffer(path));
    expect(clips).toHaveLength(1);
    expect(clips[0]!.spec.timelineStart).toBe(0);
    expect(clips[0]!.spec.rate).toBe(1);
  });
});

describe('VideoEncoderPool', () => {
  it('builds codec candidates and levels', () => {
    expect(videoCodecCandidates('h264-baseline', 640, 360, 30)[0]).toBe('avc1.42E01E');
    expect(videoCodecCandidates('h264-baseline', 1920, 1080, 30)).not.toContain('avc1.42E01E');
    expect(videoCodecCandidates('h264-high', 1920, 1080, 30)).toContain('avc1.640028');
    expect(videoCodecCandidates('vp9', 1280, 720, 30)).toContain('vp09.00.10.08');
    expect(videoCodecCandidates('av1', 960, 540, 30)).toContain('av01.0.04M.08');
    expect(h264Level(3840, 2160, 30)).not.toBe(h264Level(1280, 720, 30));
    expect(typeof vp9Level(3840, 2160, 60)).toBe('string');
    expect(typeof av1Level(3840, 2160, 60)).toBe('string');
    expect(copyBytes(new Uint8Array([1, 2, 3]))).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('opens, encodes, flushes and closes', async () => {
    const packets: EncodedPacket[] = [];
    let encoder: FakeVideoEncoder | null = null;
    const probe = vi.fn(async (config: VideoEncoderConfig) => config.codec.startsWith('avc1'));
    const pool = new VideoEncoderPool(smallConfig({ hardwareAcceleration: 'prefer-hardware' }), {
      onPacket: (packet) => packets.push(packet),
      isConfigSupported: probe,
      createEncoder: (callbacks) => (encoder = new FakeVideoEncoder(callbacks)),
    });
    const selection = await pool.open();
    expect(selection.codec.startsWith('avc1')).toBe(true);
    expect(encoder!.configured?.latencyMode).toBe('quality');
    expect(encoder!.configured?.avc).toEqual({ format: 'avc' });
    expect(pool.selection).toBe(selection);
    await pool.encode({ timestamp: 0, duration: 100_000, close: () => {} }, true);
    await pool.encode({ timestamp: 100_000, duration: 100_000, close: () => {} }, false);
    await pool.flush();
    expect(packets).toHaveLength(2);
    expect(pool.description?.[0]).toBe(1);
    expect(pool.framesIn).toBe(2);
    pool.close();
    pool.close();
    expect(encoder!.closed).toBe(true);
  });

  it('falls back to software then fails clearly', async () => {
    const seen: string[] = [];
    const pool = new VideoEncoderPool(smallConfig({ videoCodec: 'vp9', hardwareAcceleration: 'prefer-hardware' }), {
      onPacket: () => {},
      isConfigSupported: async (config) => {
        seen.push(`${config.codec}:${config.hardwareAcceleration}`);
        return false;
      },
    });
    await expect(pool.open()).rejects.toMatchObject({ code: 'ENCODER_UNSUPPORTED' });
    expect(seen.some((s) => s.endsWith('no-preference'))).toBe(true);
  });

  it('surfaces encoder errors and aborts', async () => {
    let encoder: FakeVideoEncoder | null = null;
    const abort = new AbortController();
    const pool = new VideoEncoderPool(smallConfig(), {
      onPacket: () => {},
      isConfigSupported: async () => true,
      createEncoder: (callbacks) => {
        encoder = new FakeVideoEncoder(callbacks);
        encoder.failOn = 1;
        return encoder;
      },
      signal: abort.signal,
    });
    await pool.open();
    await pool.encode({ timestamp: 0, duration: 1, close: () => {} }, true);
    await expect(pool.encode({ timestamp: 1, duration: 1, close: () => {} }, false)).rejects.toBeInstanceOf(ExportError);
    abort.abort();
    await expect(pool.encode({ timestamp: 2, duration: 1, close: () => {} }, false)).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('waits while the queue is full', async () => {
    let encoder: FakeVideoEncoder | null = null;
    const dequeue: { listener: (() => void) | null } = { listener: null };
    const pool = new VideoEncoderPool(smallConfig(), {
      onPacket: () => {},
      maxQueue: 1,
      isConfigSupported: async () => true,
      createEncoder: (callbacks) => {
        const created = new FakeVideoEncoder(callbacks);
        created.onDequeue = (listener: () => void) => {
          dequeue.listener = listener;
        };
        encoder = created;
        return created;
      },
    });
    await pool.open();
    encoder!.encodeQueueSize = 5;
    let done = false;
    const pending = pool.encode({ timestamp: 0, duration: 1, close: () => {} }, true).then(() => (done = true));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(done).toBe(false);
    encoder!.encodeQueueSize = 0;
    dequeue.listener?.();
    await pending;
    expect(done).toBe(true);
  });

  it('requires open before encoding', async () => {
    const pool = new VideoEncoderPool(smallConfig(), { onPacket: () => {}, isConfigSupported: async () => true });
    await expect(pool.encode({ timestamp: 0, duration: 1, close: () => {} }, true)).rejects.toThrow();
  });
});

describe('AudioEncoderPool', () => {
  it('maps codec strings', () => {
    expect(audioCodecString('aac')).toBe('mp4a.40.2');
    expect(audioCodecString('opus')).toBe('opus');
  });

  it('interleaves planes into f32-planar blocks', async () => {
    let encoder: FakeAudioEncoder | null = null;
    const packets: EncodedPacket[] = [];
    const pool = new AudioEncoderPool({
      codec: 'aac',
      sampleRate: 48_000,
      channels: 2,
      bitrate: 192_000,
      onPacket: (packet) => packets.push(packet),
      isConfigSupported: async () => true,
      createEncoder: (callbacks) => (encoder = new FakeAudioEncoder(callbacks)),
    });
    expect(pool.buildConfig()).toEqual({ codec: 'mp4a.40.2', sampleRate: 48_000, numberOfChannels: 2, bitrate: 192_000 });
    await pool.open();
    await pool.encodePlanar([new Float32Array([0.1, 0.2]), new Float32Array([0.3, 0.4])], 0);
    await pool.encodePlanar([new Float32Array(0)], 10);
    await pool.flush();
    expect(encoder!.blocks).toHaveLength(1);
    expect([...encoder!.blocks[0]!.data].map((v) => Math.round(v * 10))).toEqual([1, 2, 3, 4]);
    expect(packets).toHaveLength(1);
    expect(pool.description).toEqual(new Uint8Array([0x11, 0x90]));
    pool.close();
    expect(encoder!.closed).toBe(true);
  });

  it('rejects unsupported configs and closed use', async () => {
    const pool = new AudioEncoderPool({ codec: 'opus', sampleRate: 48_000, channels: 2, bitrate: 128_000, onPacket: () => {}, isConfigSupported: async () => false });
    await expect(pool.open()).rejects.toMatchObject({ code: 'ENCODER_UNSUPPORTED' });
    await expect(pool.encodePlanar([new Float32Array(4)], 0)).rejects.toBeInstanceOf(ExportError);
    await pool.flush();
  });
});

describe('FFmpegMuxFallback', () => {
  class FakeExecutor implements FFmpegExecutor {
    onProgress: ((value: number) => void) | null = null;
    terminated = 0;
    calls: { args: string[]; inputs: { name: string; data: Blob }[]; outputs: string[] }[] = [];
    result: { ret: number; logs: string[]; files: Record<string, Uint8Array> } = { ret: 0, logs: [], files: { 'out.mp4': new Uint8Array([0, 0, 0, 8]) } };
    fail: Error | null = null;
    async execute(args: string[], inputs: { name: string; data: Blob }[], outputs: string[]) {
      this.calls.push({ args, inputs, outputs });
      this.onProgress?.(0.5);
      if (this.fail) throw this.fail;
      return this.result;
    }
    terminate(): void {
      this.terminated += 1;
    }
  }
  const jpeg = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])]);

  it('builds MP4 and WebM arguments', () => {
    const mp4 = buildFallbackArgs(smallConfig(), true);
    expect(mp4.output).toBe('out.mp4');
    expect(mp4.args).toEqual(expect.arrayContaining(['image2pipe', 'libx264', 'aac', '+faststart', '-shortest', '/output/out.mp4']));
    expect(mp4.args).not.toContain('-ac');
    expect(mp4.args[mp4.args.indexOf('-g') + 1]).toBe('20');
    const webm = buildFallbackArgs(smallConfig({ format: 'webm', videoCodec: 'vp9', audioCodec: 'opus' }), false);
    expect(webm.args).toEqual(expect.arrayContaining(['libvpx-vp9', '/output/out.webm']));
    expect(webm.args).not.toContain('libopus');
    expect(buildFallbackArgs(smallConfig({ videoCodec: 'h264-baseline' }), false).args).toContain('baseline');
    expect(() => buildFallbackArgs(smallConfig({ format: 'gif' }), false)).toThrow(ExportError);
  });

  it('encodes a 16-bit WAV', async () => {
    const wav = encodeWav([new Float32Array([1, -1]), new Float32Array([0, 0.5])], 48_000);
    const view = new DataView(await wav.arrayBuffer());
    expect(view.byteLength).toBe(44 + 8);
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(48_000);
    expect(view.getInt16(44, true)).toBe(0x7fff);
    expect(view.getInt16(46, true)).toBe(0);
    expect(view.getInt16(48, true)).toBe(-0x8000);
  });

  it('collects frames and audio, then runs FFmpeg', async () => {
    const executor = new FakeExecutor();
    const fallback = new FFmpegMuxFallback(smallConfig(), executor);
    await fallback.addFrame(jpeg);
    await fallback.addFrame(jpeg);
    fallback.addAudio([new Float32Array(10), new Float32Array(10)]);
    fallback.addAudio([new Float32Array(5)]);
    expect(fallback.framesAdded).toBe(2);
    expect(fallback.bytesWritten).toBe(8);
    const progress: number[] = [];
    const blob = await fallback.finalize((value) => progress.push(value));
    expect(blob.type).toBe('video/mp4');
    expect(blob.size).toBe(4);
    expect(progress).toEqual([0.5]);
    expect(executor.onProgress).toBeNull();
    const call = executor.calls[0]!;
    expect(call.inputs.map((input) => input.name)).toEqual(['frames.mjpeg', 'audio.wav']);
    expect(call.inputs[1]!.data.size).toBe(44 + 15 * 2 * 2);
  });

  it('reports failures and aborts', async () => {
    const empty = new FFmpegMuxFallback(smallConfig(), new FakeExecutor());
    await expect(empty.finalize()).rejects.toMatchObject({ code: 'MUX_FAILED' });

    const failing = new FakeExecutor();
    failing.result = { ret: 1, logs: ['', 'Error opening'], files: {} };
    const bad = new FFmpegMuxFallback(smallConfig({ audioCodec: 'none' }), failing);
    await bad.addFrame(jpeg);
    await expect(bad.finalize()).rejects.toMatchObject({ code: 'MUX_FAILED', message: expect.stringContaining('Error opening') });

    const missing = new FakeExecutor();
    missing.fail = new Error('sin wasm');
    const unavailable = new FFmpegMuxFallback(smallConfig(), missing);
    await unavailable.addFrame(jpeg);
    await expect(unavailable.finalize()).rejects.toMatchObject({ code: 'ENCODER_UNSUPPORTED' });

    const abort = new AbortController();
    const executor = new FakeExecutor();
    const cancelled = new FFmpegMuxFallback(smallConfig(), executor, abort.signal);
    await cancelled.addFrame(jpeg);
    abort.abort();
    expect(executor.terminated).toBe(1);
    cancelled.abort();
    expect(executor.terminated).toBe(1);
    await expect(cancelled.addFrame(jpeg)).rejects.toMatchObject({ code: 'ABORTED' });
    expect(() => cancelled.addAudio([])).toThrow(ExportError);
    await expect(cancelled.finalize()).rejects.toMatchObject({ code: 'ABORTED' });
  });
});
