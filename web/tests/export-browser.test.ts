// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Fase 6: the WebCodecs / OffscreenCanvas wrappers against stubbed globals. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserAudioEncoder, browserAudioSupport } from '../src/export/audio-encoder-pool.ts';
import { browserOfflineContext } from '../src/export/audio-exporter.ts';
import { offscreenSurface } from '../src/export/offline-renderer.ts';
import { ExportError, type EncodedPacket } from '../src/export/types.ts';
import { browserVideoEncoder, browserVideoSupport } from '../src/export/video-encoder-pool.ts';

interface Init {
  output(chunk: FakeChunk, metadata?: { decoderConfig?: { description?: Uint8Array } }): void;
  error(error: Error): void;
}

class FakeChunk {
  constructor(
    readonly byteLength: number,
    readonly timestamp: number,
    readonly type: 'key' | 'delta',
    readonly duration: number | null = 10,
  ) {}
  copyTo(target: Uint8Array): void {
    target.fill(7);
  }
}

class FakeCodec {
  static supported = true;
  static instances: FakeCodec[] = [];
  state = 'configured';
  encodeQueueSize = 0;
  encoded: unknown[] = [];
  listeners: (() => void)[] = [];
  constructor(readonly init: Init) {
    FakeCodec.instances.push(this);
  }
  static async isConfigSupported(): Promise<{ supported: boolean }> {
    if (!FakeCodec.supported) throw new Error('rechazado');
    return { supported: true };
  }
  configure(): void {}
  encode(item: unknown): void {
    this.encoded.push(item);
    this.init.output(new FakeChunk(3, 5, 'key'), { decoderConfig: { description: new Uint8Array([1, 2]) } });
    this.init.output(new FakeChunk(2, 6, 'delta', null));
  }
  async flush(): Promise<void> {}
  close(): void {
    this.state = 'closed';
  }
  addEventListener(_type: string, listener: () => void): void {
    this.listeners.push(listener);
  }
}

class FakeVideoFrame {
  closed = false;
  constructor(
    readonly source: unknown = null,
    readonly init: { timestamp: number; duration?: number } = { timestamp: 0 },
  ) {}
  get timestamp(): number {
    return this.init.timestamp;
  }
  get duration(): number | null {
    return this.init.duration ?? null;
  }
  close(): void {
    this.closed = true;
  }
}

class FakeAudioData {
  static closed = 0;
  constructor(readonly init: unknown) {}
  close(): void {
    FakeAudioData.closed += 1;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeCodec.instances = [];
  FakeCodec.supported = true;
});

describe('browser wrappers', () => {
  it('fail clearly without WebCodecs', async () => {
    expect(() => browserVideoEncoder({ output: () => {}, error: () => {} })).toThrow(ExportError);
    expect(() => browserAudioEncoder({ output: () => {}, error: () => {} })).toThrow(ExportError);
    expect(await browserVideoSupport({ codec: 'avc1.640028', width: 2, height: 2 })).toBe(false);
    expect(await browserAudioSupport({ codec: 'opus', sampleRate: 48_000, numberOfChannels: 2 })).toBe(false);
    expect(() => offscreenSurface(4, 4)).toThrow(ExportError);
    expect(browserOfflineContext(2, 10, 48_000)).toBeNull();
  });

  it('wrap VideoEncoder', async () => {
    vi.stubGlobal('VideoEncoder', FakeCodec);
    vi.stubGlobal('VideoFrame', FakeVideoFrame);
    const packets: [EncodedPacket, Uint8Array | null][] = [];
    const errors: Error[] = [];
    const encoder = browserVideoEncoder({ output: (p, d) => packets.push([p, d]), error: (e) => errors.push(e) });
    encoder.configure({ codec: 'avc1.640028', width: 2, height: 2 });
    const dequeued: number[] = [];
    encoder.onDequeue?.(() => dequeued.push(1));
    encoder.encode(new FakeVideoFrame(null, { timestamp: 5, duration: 10 }), { keyFrame: true });
    expect(() => encoder.encode({ timestamp: 0, duration: 0, close: () => {} }, { keyFrame: false })).toThrow(ExportError);
    expect(packets[0]![0]).toEqual({ data: new Uint8Array([7, 7, 7]), timestamp: 5, duration: 10, keyFrame: true });
    expect(packets[0]![1]).toEqual(new Uint8Array([1, 2]));
    expect(packets[1]![0].keyFrame).toBe(false);
    expect(packets[1]![0].duration).toBe(0);
    expect(packets[1]![1]).toBeNull();
    expect(encoder.encodeQueueSize).toBe(0);
    await encoder.flush();
    const codec = FakeCodec.instances[0]!;
    codec.listeners[0]!();
    expect(dequeued).toEqual([1]);
    codec.init.error(new Error('x'));
    expect(errors).toHaveLength(1);
    encoder.close();
    encoder.close();
    expect(codec.state).toBe('closed');
    expect(await browserVideoSupport({ codec: 'avc1.640028', width: 2, height: 2 })).toBe(true);
    FakeCodec.supported = false;
    expect(await browserVideoSupport({ codec: 'avc1.640028', width: 2, height: 2 })).toBe(false);
  });

  it('wrap AudioEncoder and close AudioData', async () => {
    vi.stubGlobal('AudioEncoder', FakeCodec);
    vi.stubGlobal('AudioData', FakeAudioData);
    const packets: EncodedPacket[] = [];
    const errors: Error[] = [];
    const encoder = browserAudioEncoder({ output: (p) => packets.push(p), error: (e) => errors.push(e) });
    encoder.configure({ codec: 'opus', sampleRate: 48_000, numberOfChannels: 1 });
    const before = FakeAudioData.closed;
    encoder.encodeBlock({ format: 'f32-planar', sampleRate: 48_000, numberOfFrames: 1, numberOfChannels: 1, timestamp: 0, data: new Float32Array(1) });
    expect(FakeAudioData.closed).toBe(before + 1);
    expect(packets).toHaveLength(2);
    expect(encoder.encodeQueueSize).toBe(0);
    await encoder.flush();
    FakeCodec.instances[0]!.init.error(new Error('y'));
    expect(errors).toHaveLength(1);
    encoder.close();
    expect(FakeCodec.instances[0]!.state).toBe('closed');
    expect(await browserAudioSupport({ codec: 'opus', sampleRate: 48_000, numberOfChannels: 1 })).toBe(true);
    FakeCodec.supported = false;
    expect(await browserAudioSupport({ codec: 'opus', sampleRate: 48_000, numberOfChannels: 1 })).toBe(false);
  });

  it('wrap OffscreenCanvas', async () => {
    const context = { getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }) };
    class FakeOffscreen {
      constructor(
        public width: number,
        public height: number,
      ) {}
      getContext(): typeof context {
        return context;
      }
      async convertToBlob(options: { type: string }): Promise<Blob> {
        return new Blob([new Uint8Array(1)], { type: options.type });
      }
    }
    vi.stubGlobal('OffscreenCanvas', FakeOffscreen);
    vi.stubGlobal('VideoFrame', FakeVideoFrame);
    const sizes: [number, number][] = [];
    vi.stubGlobal('createImageBitmap', async (_source: unknown, options: { resizeWidth: number; resizeHeight: number }) => {
      sizes.push([options.resizeWidth, options.resizeHeight]);
      return null;
    });
    const surface = offscreenSurface(960, 540);
    expect(surface.readPixels().length).toBe(960 * 540 * 4);
    expect((await surface.encodeJpeg(0.9)).type).toBe('image/jpeg');
    const frame = surface.toFrame(100, 50);
    expect(frame.timestamp).toBe(100);
    await surface.preview(480);
    expect(sizes).toEqual([[480, 270]]);
    surface.dispose();
    expect(surface.target.width).toBe(1);
  });
});
