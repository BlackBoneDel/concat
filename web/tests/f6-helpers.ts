// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Shared doubles for the Fase-6 export suites. */

import type { AudioEncoderCallbacks, AudioEncoderLike, PlanarBlock } from '../src/export/audio-encoder-pool.ts';
import type { OfflineContextLike, PcmBufferLike } from '../src/export/audio-exporter.ts';
import type { ExportMediaSource } from '../src/export/export-controller.ts';
import type { ExportFrameLike, ExportSurface } from '../src/export/offline-renderer.ts';
import type { VideoEncoderCallbacks, VideoEncoderLike } from '../src/export/video-encoder-pool.ts';
import type { BufferLike } from '../src/player/audio-mixer.ts';
import type { FramePool, RenderContext2D, RenderTarget } from '../src/render/types.ts';
import { FakeAudioContext, FakeBuffer } from './f5-helpers.ts';

/** An avcC record good enough for the MP4 writer. */
export const FAKE_AVCC = new Uint8Array([1, 0x64, 0, 0x28, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0, 0x28, 1, 0, 2, 0x68, 0xee]);

/** A frame double that records closing. */
export class FakeFrame implements ExportFrameLike {
  closed = false;
  constructor(readonly timestamp: number, readonly duration: number | null) {}
  close(): void {
    this.closed = true;
  }
}

/** A surface double: counts frames, pixels and disposal. */
export class FakeSurface implements ExportSurface {
  readonly target: RenderTarget;
  readonly frames: FakeFrame[] = [];
  disposed = false;
  previews = 0;
  constructor(readonly width: number, readonly height: number) {
    this.target = { width, height, getContext: (): RenderContext2D | null => null };
  }
  toFrame(timestamp: number, duration: number): FakeFrame {
    const frame = new FakeFrame(timestamp, duration);
    this.frames.push(frame);
    return frame;
  }
  readPixels(): Uint8ClampedArray {
    const data = new Uint8ClampedArray(this.width * this.height * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = (i / 4) % 256;
      data[i + 1] = 80;
      data[i + 2] = 160;
      data[i + 3] = 255;
    }
    return data;
  }
  async encodeJpeg(): Promise<Blob> {
    return new Blob([new Uint8Array([0xff, 0xd8, 1, 2, 0xff, 0xd9])], { type: 'image/jpeg' });
  }
  async preview(): Promise<ImageBitmap | null> {
    this.previews += 1;
    return null;
  }
  dispose(): void {
    this.disposed = true;
  }
}

/** A video encoder double emitting one packet per frame. */
export class FakeVideoEncoder implements VideoEncoderLike {
  encodeQueueSize = 0;
  configured: VideoEncoderConfig | null = null;
  readonly encoded: { timestamp: number; keyFrame: boolean }[] = [];
  closed = false;
  flushed = 0;
  failOn: number | null = null;
  onDequeue?: (listener: () => void) => void;
  constructor(private readonly callbacks: VideoEncoderCallbacks) {}
  configure(config: VideoEncoderConfig): void {
    this.configured = config;
  }
  encode(frame: ExportFrameLike, options: { keyFrame: boolean }): void {
    this.encoded.push({ timestamp: frame.timestamp, keyFrame: options.keyFrame });
    if (this.failOn !== null && this.encoded.length >= this.failOn) {
      this.callbacks.error(new Error('fallo del codificador'));
      return;
    }
    const data = new Uint8Array(12).fill(this.encoded.length & 0xff);
    this.callbacks.output(
      { data, timestamp: frame.timestamp, duration: frame.duration ?? 0, keyFrame: options.keyFrame },
      this.encoded.length === 1 ? FAKE_AVCC.slice() : null,
    );
  }
  async flush(): Promise<void> {
    this.flushed += 1;
  }
  close(): void {
    this.closed = true;
  }
}

/** An audio encoder double emitting one packet per block. */
export class FakeAudioEncoder implements AudioEncoderLike {
  encodeQueueSize = 0;
  readonly blocks: PlanarBlock[] = [];
  closed = false;
  constructor(private readonly callbacks: AudioEncoderCallbacks) {}
  configure(): void {}
  encodeBlock(block: PlanarBlock): void {
    this.blocks.push(block);
    this.callbacks.output(
      { data: new Uint8Array(6).fill(9), timestamp: block.timestamp, duration: Math.round((block.numberOfFrames * 1e6) / block.sampleRate), keyFrame: true },
      this.blocks.length === 1 ? new Uint8Array([0x11, 0x90]) : null,
    );
  }
  async flush(): Promise<void> {}
  close(): void {
    this.closed = true;
  }
}

/** An offline context double: renders `value(channel, index)` into each channel. */
export class FakeOfflineContext extends FakeAudioContext implements OfflineContextLike {
  constructor(
    readonly channels: number,
    readonly length: number,
    readonly rate: number,
    private readonly value: (channel: number, index: number) => number = (channel, index) => channel * 1000 + index,
  ) {
    super();
  }
  async startRendering(): Promise<PcmBufferLike> {
    const buffer = new FakeBuffer(this.channels, this.length, this.rate);
    for (let c = 0; c < this.channels; c += 1) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < this.length; i += 1) data[i] = this.value(c, i);
    }
    return { duration: buffer.duration, numberOfChannels: this.channels, sampleRate: this.rate, length: this.length, getChannelData: (c) => buffer.getChannelData(c) };
  }
}

/** A media source double. */
export class FakeMedia implements ExportMediaSource {
  forced: boolean[] = [];
  readonly originals = new Set<string>();
  readonly proxies = new Set<string>();
  readonly buffers = new Map<string, BufferLike>();
  exportFrames(): FramePool {
    return { getFrame: async () => null, getSize: () => null };
  }
  hasOriginal(id: string): boolean {
    return this.originals.has(id);
  }
  hasProxy(id: string): boolean {
    return this.proxies.has(id);
  }
  forceOriginalQuality(enabled: boolean): void {
    this.forced.push(enabled);
  }
  async getAudioBuffer(id: string): Promise<BufferLike | null> {
    return this.buffers.get(id) ?? null;
  }
}
