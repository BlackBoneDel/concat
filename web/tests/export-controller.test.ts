// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Fase 6: the export controller (happy path, cancel, errors, fallbacks). */

import { describe, expect, it, vi } from 'vitest';
import { Rational } from '../src/core/rational.ts';
import { ExportController, type ExportEnvironment } from '../src/export/export-controller.ts';
import type { FFmpegExecutor } from '../src/export/ffmpeg-mux-fallback.ts';
import { defaultExportConfig, ExportError, type ExportConfig, type ExportProgress } from '../src/export/types.ts';
import { makeSession } from './f3-helpers.ts';
import { bufferOf } from './f4-helpers.ts';
import { FakeAudioEncoder, FakeMedia, FakeOfflineContext, FakeSurface, FakeVideoEncoder } from './f6-helpers.ts';

const r = (value: number): Rational => Rational.approximate(value) ?? Rational.ZERO;

function config(overrides: Partial<ExportConfig> = {}): ExportConfig {
  return { ...defaultExportConfig(), width: 64, height: 36, frameRate: { num: 10, den: 1 }, videoBitrate: 500_000, ...overrides };
}

/** Top-level box types of an ISO-BMFF file. */
function boxes(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: string[] = [];
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    const size = view.getUint32(offset);
    out.push(String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)));
    if (size < 8) break;
    offset += size;
  }
  return out;
}

interface Harness {
  env: ExportEnvironment;
  media: FakeMedia;
  surfaces: FakeSurface[];
  videoEncoders: FakeVideoEncoder[];
  audioEncoders: FakeAudioEncoder[];
  composited: number[];
}

function harness(
  options: { clips?: Parameters<typeof makeSession>[0]; webCodecs?: boolean; ffmpeg?: FFmpegExecutor | null; videoSupported?: boolean; onComposite?: (index: number) => void } = {},
): Harness {
  const session = makeSession(options.clips ?? [{ start: 0, duration: 1 }, { start: 0, duration: 1, kind: 'audio', trackId: 'T3' }]);
  const media = new FakeMedia();
  media.originals.add('m1');
  media.buffers.set('mA', bufferOf([new Float32Array(48_000).fill(0.25), new Float32Array(48_000).fill(-0.25)]));
  const surfaces: FakeSurface[] = [];
  const videoEncoders: FakeVideoEncoder[] = [];
  const audioEncoders: FakeAudioEncoder[] = [];
  const composited: number[] = [];
  let clock = 0;
  const env: ExportEnvironment = {
    getDocument: () => session.document,
    media,
    getFFmpeg: () => options.ffmpeg ?? null,
    createSurface: (w, h) => {
      const surface = new FakeSurface(w, h);
      surfaces.push(surface);
      return surface;
    },
    composite: async (_timeline, time) => {
      composited.push(time.asNumber());
      options.onComposite?.(composited.length - 1);
    },
    createVideoEncoder: (callbacks) => {
      const encoder = new FakeVideoEncoder(callbacks);
      videoEncoders.push(encoder);
      return encoder;
    },
    isVideoConfigSupported: async () => options.videoSupported ?? true,
    createAudioEncoder: (callbacks) => {
      const encoder = new FakeAudioEncoder(callbacks);
      audioEncoders.push(encoder);
      return encoder;
    },
    isAudioConfigSupported: async () => true,
    createOfflineContext: (channels, length, rate) => new FakeOfflineContext(channels, length, rate, () => 0.1),
    hasWebCodecs: () => options.webCodecs ?? true,
    now: () => (clock += 50),
    yieldToUi: async () => {},
  };
  return { env, media, surfaces, videoEncoders, audioEncoders, composited };
}

class FakeExecutor implements FFmpegExecutor {
  onProgress: ((value: number) => void) | null = null;
  terminated = 0;
  inputs: string[] = [];
  async execute(_args: string[], inputs: { name: string; data: Blob }[], outputs: string[]) {
    this.inputs = inputs.map((input) => input.name);
    this.onProgress?.(1);
    return { ret: 0, logs: [], files: { [outputs[0]!]: new Uint8Array([1, 2, 3]) } };
  }
  terminate(): void {
    this.terminated += 1;
  }
}

describe('ExportController — happy paths', () => {
  it('exports an MP4 through WebCodecs with ordered phases and progress', async () => {
    const h = harness();
    const controller = new ExportController(h.env);
    const reports: ExportProgress[] = [];
    const off = controller.onProgress((progress) => reports.push(progress));
    const result = await controller.start(config());
    off();

    expect(result.encoder).toBe('webcodecs');
    expect(result.frames).toBe(10);
    expect(result.duration).toBe(1);
    expect(result.mimeType).toBe('video/mp4');
    expect(result.fileName).toBe('concat-export.mp4');
    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    expect(boxes(bytes)).toEqual(['ftyp', 'moov', 'mdat']);

    const phases = [...new Set(reports.map((p) => p.phase))];
    expect(phases).toEqual(['preparing', 'rendering', 'encoding-audio', 'muxing', 'finalizing', 'done']);
    const ratios = reports.map((p) => p.ratio);
    expect(ratios.every((value, index) => index === 0 || value >= ratios[index - 1]!)).toBe(true);
    const rendering = reports.filter((p) => p.phase === 'rendering');
    expect(rendering).toHaveLength(10);
    expect(rendering.at(-1)!.etaSeconds).toBe(0);
    expect(rendering[0]!.etaSeconds).toBeGreaterThan(0);
    expect(reports.at(-1)!.ratio).toBe(1);

    expect(h.composited).toHaveLength(10);
    expect(h.videoEncoders[0]!.encoded.map((e) => e.timestamp)).toEqual([0, 100_000, 200_000, 300_000, 400_000, 500_000, 600_000, 700_000, 800_000, 900_000]);
    expect(h.videoEncoders[0]!.encoded[0]!.keyFrame).toBe(true);
    expect(h.videoEncoders[0]!.closed).toBe(true);
    expect(h.audioEncoders[0]!.blocks.length).toBeGreaterThan(40);
    expect(h.audioEncoders[0]!.closed).toBe(true);
    expect(h.surfaces[0]!.disposed).toBe(true);
    expect(h.surfaces[0]!.frames.every((f) => f.closed)).toBe(true);
    expect(h.media.forced).toEqual([true, false]);
    expect(controller.running).toBe(false);
    expect(controller.phase).toBe('done');
  });

  it('exports WebM with Opus and honours the session range', async () => {
    const h = harness();
    h.env.getRange = () => ({ start: r(0.5), end: r(1) });
    const result = await new ExportController(h.env).start(config({ format: 'webm', videoCodec: 'vp9', audioCodec: 'opus' }));
    expect(result.frames).toBe(5);
    expect(result.mimeType).toBe('video/webm');
    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    expect([...bytes.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
    expect(h.composited[0]).toBeCloseTo(0.5);
    expect(h.videoEncoders[0]!.encoded[0]!.timestamp).toBe(0);
  });

  it('exports without audio', async () => {
    const h = harness();
    const result = await new ExportController(h.env).start(config({ audioCodec: 'none' }));
    expect(h.audioEncoders).toHaveLength(0);
    expect(result.frames).toBe(10);
  });

  it('exports a GIF and warns for long clips', async () => {
    const h = harness({ clips: [{ start: 0, duration: 31 }] });
    const result = await new ExportController(h.env).start(
      config({ format: 'gif', audioCodec: 'none', width: 32, height: 16, frameRate: { num: 1, den: 1 }, gif: { dither: false, loop: 0, maxColors: 16 } }),
    );
    expect(result.encoder).toBe('gif');
    expect(result.frames).toBe(31);
    const head = new Uint8Array(await result.blob.slice(0, 6).arrayBuffer());
    expect(String.fromCharCode(...head)).toBe('GIF89a');
    expect(result.warnings.some((w) => w.includes('30'))).toBe(true);
  });

  it('falls back to FFmpeg without WebCodecs', async () => {
    const executor = new FakeExecutor();
    const h = harness({ webCodecs: false, ffmpeg: executor });
    const result = await new ExportController(h.env).start(config());
    expect(result.encoder).toBe('ffmpeg');
    expect(result.blob.size).toBe(3);
    expect(executor.inputs).toEqual(['frames.mjpeg', 'audio.wav']);
    expect(result.warnings[0]).toContain('WebCodecs');
  });

  it('falls back to FFmpeg when WebCodecs rejects the config', async () => {
    const executor = new FakeExecutor();
    const h = harness({ videoSupported: false, ffmpeg: executor });
    const result = await new ExportController(h.env).start(config({ audioCodec: 'none' }));
    expect(result.encoder).toBe('ffmpeg');
    expect(executor.inputs).toEqual(['frames.mjpeg']);
    expect(result.warnings.some((w) => w.includes('FFmpeg'))).toBe(true);
  });
});

describe('ExportController — cancel and errors', () => {
  it('cancels mid-render and cleans everything up', async () => {
    let controller: ExportController | null = null;
    const h = harness({ onComposite: (index) => index === 3 && controller?.cancel() });
    controller = new ExportController(h.env);
    const phases: string[] = [];
    controller.onProgress((p) => phases.push(p.phase));
    await expect(controller.start(config())).rejects.toMatchObject({ code: 'ABORTED' });
    expect(controller.phase).toBe('cancelled');
    expect(phases.at(-1)).toBe('cancelled');
    expect(h.videoEncoders[0]!.closed).toBe(true);
    expect(h.surfaces[0]!.disposed).toBe(true);
    expect(h.surfaces[0]!.frames.every((f) => f.closed)).toBe(true);
    expect(h.media.forced).toEqual([true, false]);
    expect(controller.running).toBe(false);
    // The controller is reusable after a cancel.
    const again = await controller.start(config({ audioCodec: 'none' }));
    expect(again.frames).toBe(10);
  });

  it('cancels the FFmpeg fallback and terminates the worker', async () => {
    let controller: ExportController | null = null;
    const executor = new FakeExecutor();
    const h = harness({ webCodecs: false, ffmpeg: executor, onComposite: (index) => index === 2 && controller?.cancel() });
    controller = new ExportController(h.env);
    await expect(controller.start(config())).rejects.toMatchObject({ code: 'ABORTED' });
    expect(executor.terminated).toBe(1);
  });

  it('reports encoder failures as errors', async () => {
    const h = harness();
    h.env.createVideoEncoder = (callbacks) => {
      const encoder = new FakeVideoEncoder(callbacks);
      encoder.failOn = 2;
      h.videoEncoders.push(encoder);
      return encoder;
    };
    const controller = new ExportController(h.env);
    const error = await controller.start(config()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExportError);
    expect(controller.phase).toBe('error');
    expect(h.videoEncoders[0]!.closed).toBe(true);
    expect(h.media.forced).toEqual([true, false]);
  });

  it('rejects empty timelines, bad ranges, invalid configs and missing originals', async () => {
    await expect(new ExportController(harness({ clips: [] }).env).start(config())).rejects.toMatchObject({ code: 'NO_MEDIA' });
    await expect(new ExportController(harness().env).start(config({ range: { start: r(1), end: r(0.5) } }))).rejects.toMatchObject({ code: 'INVALID_RANGE' });
    await expect(new ExportController(harness().env).start(config({ width: 0 }))).rejects.toMatchObject({ code: 'INVALID_RANGE' });
    const missing = harness();
    missing.media.originals.clear();
    missing.media.proxies.add('m1');
    await expect(new ExportController(missing.env).start(config())).rejects.toMatchObject({ code: 'NO_MEDIA' });
    const proxied = await new ExportController(missing.env).start(config({ allowProxyFallback: true, audioCodec: 'none' }));
    expect(proxied.frames).toBe(10);
  });

  it('fails clearly without any encoder', async () => {
    const h = harness({ webCodecs: false, ffmpeg: null });
    await expect(new ExportController(h.env).start(config())).rejects.toMatchObject({ code: 'ENCODER_UNSUPPORTED', message: expect.stringContaining('GIF') });
    const unsupported = harness({ videoSupported: false });
    await expect(new ExportController(unsupported.env).start(config())).rejects.toMatchObject({ code: 'ENCODER_UNSUPPORTED' });
  });

  it('is single-flight and closes on dispose', async () => {
    const h = harness();
    const controller = new ExportController(h.env);
    const first = controller.start(config({ audioCodec: 'none' }));
    await expect(controller.start(config())).rejects.toBeInstanceOf(ExportError);
    await first;
    const listener = (): void => {
      throw new Error('listener roto');
    };
    controller.onProgress(listener);
    controller.dispose();
    controller.dispose();
    await expect(controller.start(config())).rejects.toBeInstanceOf(ExportError);
  });

  it('survives throwing listeners', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = harness();
    const controller = new ExportController(h.env);
    controller.onProgress(() => {
      throw new Error('boom');
    });
    const result = await controller.start(config({ audioCodec: 'none' }));
    expect(result.frames).toBe(10);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
