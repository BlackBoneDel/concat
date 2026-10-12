// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

// @vitest-environment jsdom

/** Proxy orchestration, the MP4 muxer, the WebCodecs pipeline and the worker RPC. */

import { describe, expect, it } from 'vitest';
import { Rational } from '../src/core/rational.ts';
import { FrameRate } from '../src/core/time.ts';
import type { MediaInfo } from '../src/media/decoder.ts';
import { MP4Demuxer } from '../src/media/demuxer.ts';
import {
  DEFAULT_PROXY_CONFIG,
  LOW_PROXY_CONFIG,
  ProxyGenerator,
  codecFamily,
  type ProxyRunner,
} from '../src/media/proxy/proxy-generator.ts';
import { ProxyQueue } from '../src/media/proxy/proxy-queue.ts';
import { ProxyStore } from '../src/media/proxy/proxy-store.ts';
import {
  UNSUPPORTED_ENCODER,
  computeProxySize,
  encoderCodecString,
  muxMp4,
  runProxyJob,
  type EncodedChunkLike,
  type FrameLike,
  type MuxSample,
  type ProxyEnv,
} from '../src/media/proxy/proxy-worker.ts';
import { MemoryKeyValue } from '../src/storage/idb.ts';
import { MemoryProxyFiles, ProxyRecordStore } from '../src/storage/proxy-store.ts';
import { WorkerClient, serveWorker, type WorkerLike, type WorkerScopeLike } from '../src/workers/worker-client.ts';

function info(partial: Partial<MediaInfo>): MediaInfo {
  return {
    id: 'm', type: 'video', duration: Rational.fromInt(60), width: 1280, height: 720, fps: FrameRate.THIRTY,
    videoCodec: 'avc1.42E01F', audioCodec: '', audioSampleRate: 0, audioChannels: 0, fileSize: 10_000_000,
    container: 'mp4', ...partial,
  };
}

function makeGenerator(runner: ProxyRunner, transcoder?: ConstructorParameters<typeof ProxyGenerator>[2]) {
  const store = new ProxyStore(new ProxyRecordStore(new MemoryKeyValue()), new MemoryProxyFiles(), { hash: async (blob) => `h${blob.size}` });
  const queue = new ProxyQueue();
  return { store, queue, generator: new ProxyGenerator(store, queue, { runner, ...transcoder }) };
}

const okResult = (size = 64) => ({ blob: new Blob([new Uint8Array(size)], { type: 'video/mp4' }), width: 1280, height: 720, duration: 5, codec: 'avc1.42E01F' });

describe('ProxyGenerator', () => {
  it('auto-detects heavy media: ≥1080p, >8 Mbps, HEVC/AV1/ProRes', () => {
    const { generator } = makeGenerator(async () => okResult());
    expect(generator.shouldGenerateProxy(info({ width: 1920, height: 1080 }))).toBe(true);
    expect(generator.shouldGenerateProxy(info({ width: 3840, height: 2160 }))).toBe(true);
    expect(generator.shouldGenerateProxy(info({ fileSize: 50_000_000 }))).toBe(false);
    expect(generator.shouldGenerateProxy(info({ fileSize: 100_000_000 }))).toBe(true); // 13.3 Mbps
    expect(generator.shouldGenerateProxy(info({ videoCodec: 'hvc1.1.6.L93.B0' }))).toBe(true);
    expect(generator.shouldGenerateProxy(info({ videoCodec: 'av01.0.08M.08' }))).toBe(true);
    expect(generator.shouldGenerateProxy(info({ videoCodec: 'apch' }))).toBe(true);
    expect(generator.shouldGenerateProxy(info({ type: 'audio', width: 4000, height: 4000 }))).toBe(false);
    expect(codecFamily('vp09.00.31.08')).toBe('vp9');
    expect(codecFamily('avc1.64001f')).toBe('h264');
    expect(codecFamily('ProRes 422')).toBe('prores');
    expect(codecFamily('vp8')).toBe('vp8');
  });

  it('generates, stores and reports progress/completion with max 2 parallel jobs', async () => {
    let running = 0;
    let peak = 0;
    const runner: ProxyRunner = async (_job, onProgress) => {
      running += 1;
      peak = Math.max(peak, running);
      onProgress(0.5);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return okResult();
    };
    const { generator, store } = makeGenerator(runner);
    const progress: number[] = [];
    const completed: string[] = [];
    generator.onProgress = (_id, value) => progress.push(value);
    generator.onComplete = (id) => completed.push(id);
    const jobs = ['a', 'b', 'c', 'd'].map((mediaId) =>
      generator.generate({ mediaId, sourceFile: new Blob(['x']), config: DEFAULT_PROXY_CONFIG, priority: 'normal' }),
    );
    expect(generator.statusOf('c')).toBe('pending');
    const metas = await Promise.all(jobs);
    expect(peak).toBe(2);
    expect(metas.map((meta) => meta.mediaId)).toEqual(['a', 'b', 'c', 'd']);
    expect(completed.sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(progress).toContain(0.5);
    expect(generator.statusOf('a')).toBe('ready');
    expect(await generator.getProxyPath('a')).toMatch(/^proxies\//);
    expect((await store.list())).toHaveLength(4);
  });

  it('retries a failing job once, then marks it as error and keeps going', async () => {
    let calls = 0;
    const { generator } = makeGenerator(async () => {
      calls += 1;
      throw new Error('boom');
    });
    const errors: string[] = [];
    generator.onError = (id, error) => errors.push(`${id}:${error.message}`);
    await expect(
      generator.generate({ mediaId: 'x', sourceFile: new Blob(['x']), config: LOW_PROXY_CONFIG, priority: 'low' }),
    ).rejects.toThrow('boom');
    expect(calls).toBe(2);
    expect(errors).toEqual(['x:boom']);
    expect(generator.statusOf('x')).toBe('error');
    expect(generator.errorOf('x')).toBe('boom');
  });

  it('falls back to the FFmpeg transcoder when WebCodecs cannot encode', async () => {
    const calls: string[] = [];
    const { generator, store } = makeGenerator(
      async () => {
        throw new Error(UNSUPPORTED_ENCODER);
      },
      {
        transcoder: {
          transcode: async (_input, output) => {
            calls.push(`${output.format}:${output.videoCodec}:${output.width}x${output.height}`);
            return new Blob([new Uint8Array(8)], { type: 'video/webm' });
          },
        },
        probeSize: async () => ({ width: 3840, height: 2160, duration: 3 }),
      },
    );
    const meta = await generator.generate({ mediaId: 'k', sourceFile: new Blob(['x']), config: DEFAULT_PROXY_CONFIG, priority: 'high' });
    expect(calls).toEqual(['webm:libvpx:1280x720']);
    expect(meta.container).toBe('webm');
    expect((await store.get('k'))?.opfsPath.endsWith('.webm')).toBe(true);
  });

  it('fails clearly without WebCodecs nor FFmpeg', async () => {
    const { generator } = makeGenerator(async () => {
      throw new Error('WebCodecs no disponible');
    });
    await expect(
      generator.generate({ mediaId: 'k', sourceFile: new Blob(['x']), config: DEFAULT_PROXY_CONFIG, priority: 'normal' }),
    ).rejects.toThrow(/no puede generar/);
  });

  it('cancels waiting and running jobs; regenerates with high priority', async () => {
    let release: () => void = () => undefined;
    let cancelledFlag = false;
    const runner: ProxyRunner = (_job, _progress, register) =>
      new Promise((resolve) => {
        register(() => {
          cancelledFlag = true;
        });
        release = () => resolve(okResult());
      });
    const { generator, queue } = makeGenerator(runner);
    queue.setMaxConcurrent(1);
    const first = generator.generate({ mediaId: 'r', sourceFile: new Blob(['x']), config: DEFAULT_PROXY_CONFIG, priority: 'normal' });
    const second = generator.generate({ mediaId: 'w', sourceFile: new Blob(['x']), config: DEFAULT_PROXY_CONFIG, priority: 'normal' });
    await generator.cancel('w');
    await expect(second).rejects.toThrow(/cancelada/);
    await generator.cancel('r');
    expect(cancelledFlag).toBe(true);
    await expect(first).rejects.toThrow(/cancelada/);
    release();
    expect(generator.statusOf('r')).toBe('none');
    await expect(generator.regenerate('nope')).rejects.toThrow();
    generator.registerSource('z', new Blob(['z']));
    const regenerated = generator.regenerate('z');
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    expect((await regenerated).mediaId).toBe('z');
    generator.markNone('z');
    expect(generator.statusOf('z')).toBe('none');
    generator.markReady('z');
    expect(generator.statusOf('z')).toBe('ready');
  });

  it('validates configs', () => {
    const { generator } = makeGenerator(async () => okResult());
    expect(() =>
      generator.generate({ mediaId: 'v', sourceFile: new Blob(['x']), config: { ...DEFAULT_PROXY_CONFIG, fps: 0 }, priority: 'normal' }),
    ).toThrow(RangeError);
    expect(() =>
      generator.generate({ mediaId: 'v', sourceFile: new Blob(['x']), config: { ...DEFAULT_PROXY_CONFIG, bitrate: 1 }, priority: 'normal' }),
    ).toThrow(RangeError);
    expect(() =>
      generator.generate({ mediaId: 'v', sourceFile: new Blob(['x']), config: { ...DEFAULT_PROXY_CONFIG, resolution: { width: 2, height: 2 } }, priority: 'normal' }),
    ).toThrow(RangeError);
  });
});

describe('proxy sizing and codec strings', () => {
  it('preserves aspect exactly (to even pixels) and never upscales', () => {
    expect(computeProxySize(3840, 2160, { width: 1280, height: 720 })).toEqual({ width: 1280, height: 720 });
    expect(computeProxySize(1080, 1920, { width: 1280, height: 720 })).toEqual({ width: 406, height: 720 });
    expect(computeProxySize(4096, 2160, { width: 640, height: 360 })).toEqual({ width: 640, height: 338 });
    expect(computeProxySize(640, 360, { width: 1280, height: 720 })).toEqual({ width: 640, height: 360 });
    expect(computeProxySize(0, 0, { width: 1281, height: 721 })).toEqual({ width: 1282, height: 722 });
  });

  it('picks profile/level by size', () => {
    expect(encoderCodecString(DEFAULT_PROXY_CONFIG, 1280, 720)).toBe('avc1.42E01F');
    expect(encoderCodecString(LOW_PROXY_CONFIG, 640, 360)).toBe('avc1.42E01E');
    expect(encoderCodecString(DEFAULT_PROXY_CONFIG, 1920, 1080)).toBe('avc1.42E028');
    expect(encoderCodecString({ ...DEFAULT_PROXY_CONFIG, codec: 'vp9' }, 1280, 720)).toBe('vp09.00.31.08');
    expect(encoderCodecString({ ...DEFAULT_PROXY_CONFIG, codec: 'av1' }, 1280, 720)).toBe('av01.0.04M.08');
  });
});

/** Ten 1/30 s samples with a key every 5. */
function samples(count = 10): MuxSample[] {
  return Array.from({ length: count }, (_, index) => ({
    data: new Uint8Array([index, index + 1, index + 2]),
    timestamp: Math.round((index * 1e6) / 30),
    duration: Math.round(1e6 / 30),
    key: index % 5 === 0,
  }));
}

const AVCC = Uint8Array.of(1, 0x42, 0xe0, 0x1f, 0xff, 0xe0, 0x00);

describe('muxMp4', () => {
  it('writes an MP4 the Concat demuxer reads back exactly', () => {
    const bytes = muxMp4({ codec: 'avc1.42E01F', description: AVCC, width: 1280, height: 720, samples: samples() });
    const copy = new ArrayBuffer(bytes.length);
    new Uint8Array(copy).set(bytes);
    const demuxer = MP4Demuxer.open(copy);
    expect(demuxer).not.toBeNull();
    const track = demuxer!.tracks[0]!;
    expect(track.kind).toBe('video');
    expect(track.codec).toBe('avc1.42e01f');
    expect(track.width).toBe(1280);
    expect(track.height).toBe(720);
    expect(track.samples).toHaveLength(10);
    expect(track.samples.filter((sample) => sample.key)).toHaveLength(2);
    expect(Array.from(demuxer!.sampleBytes(track, 3))).toEqual([3, 4, 5]);
    expect(track.duration).toBeCloseTo(10 / 30, 3);
  });

  it('writes vp09 / av01 sample entries and ctts for reordered frames', () => {
    const reordered = samples(3);
    [reordered[1], reordered[2]] = [reordered[2]!, reordered[1]!];
    const vp9 = muxMp4({ codec: 'vp09.00.31.08', description: null, width: 640, height: 360, samples: reordered });
    const text = new TextDecoder('latin1').decode(vp9);
    expect(text).toContain('vp09');
    expect(text).toContain('vpcC');
    expect(text).toContain('ctts');
    const av1 = new TextDecoder('latin1').decode(muxMp4({ codec: 'av01.0.04M.08', description: null, width: 640, height: 360, samples: samples(2) }));
    expect(av1).toContain('av1C');
    expect(() => muxMp4({ codec: 'avc1.42E01F', description: null, width: 2, height: 2, samples: [] })).toThrow();
    expect(() => muxMp4({ codec: 'theora', description: null, width: 2, height: 2, samples: samples(1) })).toThrow();
  });
});

/** A fake WebCodecs platform: decoders emit one frame per chunk. */
function fakeEnv(options: { supported?: boolean } = {}) {
  const closed = { frames: 0, decoders: 0, encoders: 0 };
  const draws: number[] = [];
  const frame = (timestamp: number): FrameLike => ({
    timestamp, displayWidth: 1920, displayHeight: 1080,
    close: () => {
      closed.frames += 1;
    },
  });
  let clock = 0;
  const env: ProxyEnv = {
    createDecoder: (output) => ({
      decodeQueueSize: 0,
      configure: () => undefined,
      decode: (chunk) => output(frame(chunk.timestamp)),
      flush: async () => undefined,
      close: () => {
        closed.decoders += 1;
      },
    }),
    createEncoder: (output) => ({
      encodeQueueSize: 0,
      configure: () => undefined,
      encode: (input, opts) => {
        const chunk: EncodedChunkLike = {
          type: opts.keyFrame ? 'key' : 'delta', timestamp: input.timestamp, duration: null, byteLength: 4,
          copyTo: (destination) => destination.set([1, 2, 3, 4]),
        };
        output(chunk, AVCC);
      },
      flush: async () => undefined,
      close: () => {
        closed.encoders += 1;
      },
    }),
    isEncoderSupported: async () => options.supported ?? true,
    createScaler: (width) => ({
      context: { drawImage: () => draws.push(width) },
      snapshot: (timestamp) => frame(timestamp),
    }),
    now: () => {
      clock += 600;
      return clock;
    },
  };
  return { env, closed, draws };
}

function sourceMp4(count = 20, fps = 60): Blob {
  const list = Array.from({ length: count }, (_, index) => ({
    data: new Uint8Array([index]), timestamp: Math.round((index * 1e6) / fps), duration: Math.round(1e6 / fps), key: index % 10 === 0,
  }));
  const bytes = muxMp4({ codec: 'avc1.64001F', description: Uint8Array.of(1, 0x64, 0, 0x1f, 0xff, 0xe0, 0), width: 1920, height: 1080, samples: list });
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return new Blob([copy.buffer]);
}

describe('runProxyJob', () => {
  it('decodes, scales, drops to the target fps, encodes, muxes and closes everything', async () => {
    const { env, closed, draws } = fakeEnv();
    const progress: number[] = [];
    const result = await runProxyJob(sourceMp4(20, 60), DEFAULT_PROXY_CONFIG, env, (value) => progress.push(value));
    expect(result.width).toBe(1280);
    expect(result.height).toBe(720);
    expect(result.codec).toBe('avc1.42E01F');
    expect(draws.length).toBe(10); // 60 fps → 30 fps
    expect(closed.decoders).toBe(1);
    expect(closed.encoders).toBe(1);
    expect(closed.frames).toBe(30); // 20 decoded + 10 scaled
    expect(progress[progress.length - 1]).toBe(1);
    const copy = await result.blob.arrayBuffer();
    const proxy = MP4Demuxer.open(copy)!;
    expect(proxy.tracks[0]!.samples).toHaveLength(10);
    expect(proxy.tracks[0]!.width).toBe(1280);
  });

  it('rejects unsupported sources/encoders and honours cancel, still closing codecs', async () => {
    const { env, closed } = fakeEnv({ supported: false });
    await expect(runProxyJob(new Blob(['not an mp4']), DEFAULT_PROXY_CONFIG, env)).rejects.toThrow('unsupported-source');
    await expect(runProxyJob(sourceMp4(), DEFAULT_PROXY_CONFIG, env)).rejects.toThrow('unsupported-encoder');
    const ok = fakeEnv();
    await expect(runProxyJob(sourceMp4(), DEFAULT_PROXY_CONFIG, ok.env, undefined, () => true)).rejects.toThrow(/cancelada/);
    expect(ok.closed.decoders).toBe(1);
    expect(ok.closed.encoders).toBe(1);
    expect(closed.decoders).toBe(0);
  });
});

/** An in-process worker pair: the client's worker talks to a served scope. */
function linkedWorker(handlers: Parameters<typeof serveWorker>[1]) {
  let terminated = 0;
  const worker: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage: (message) => {
      queueMicrotask(() => scope.onmessage?.(new MessageEvent('message', { data: message })));
    },
    terminate: () => {
      terminated += 1;
    },
  };
  const scope: WorkerScopeLike = {
    onmessage: null,
    postMessage: (message) => {
      queueMicrotask(() => worker.onmessage?.(new MessageEvent('message', { data: message })));
    },
  };
  serveWorker(scope, handlers);
  return { worker, terminated: () => terminated };
}

describe('WorkerClient / serveWorker', () => {
  it('round-trips requests with progress, errors and unknown types', async () => {
    const link = linkedWorker({
      double: (payload, tools) => {
        tools.progress(0.5);
        return typeof payload === 'number' ? payload * 2 : 0;
      },
      fail: () => {
        throw new Error('nope');
      },
    });
    const client = new WorkerClient(() => link.worker, 10);
    expect(client.available).toBe(true);
    const seen: number[] = [];
    expect(await client.request<number>('double', 21, [], (value) => seen.push(value))).toBe(42);
    expect(seen).toEqual([0.5]);
    await expect(client.request('fail', null)).rejects.toThrow('nope');
    await expect(client.request('missing', null)).rejects.toThrow(/desconocida/);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(link.terminated()).toBe(1); // idle termination
    expect(client.alive).toBe(false);
  });

  it('reports unavailability and rejects pending work on terminate/error', async () => {
    const none = new WorkerClient(() => null);
    expect(none.available).toBe(false);
    await expect(none.request('x', null)).rejects.toThrow(/no disponibles/);
    const silent: WorkerLike = { onmessage: null, onerror: null, postMessage: () => undefined, terminate: () => undefined };
    const client = new WorkerClient(() => silent);
    const pending = client.request('x', null);
    client.terminate('bye');
    await expect(pending).rejects.toThrow('bye');
    const again = client.request('x', null);
    silent.onerror?.(new ErrorEvent('error', { message: 'crash' }));
    await expect(again).rejects.toThrow('crash');
  });
});
