// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Fase 4 hooks in the decoder (FFmpeg fallback) and the pool (proxies, relink). */

import { describe, expect, it } from 'vitest';
import { Rational } from '../src/core/rational.ts';
import { MediaDecoder, type MediaFallback } from '../src/media/decoder.ts';
import { MediaPool } from '../src/media/media-pool.ts';
import { PlainAudioBuffer } from '../src/media/audio/audio-processor.ts';

function fakeFallback(): MediaFallback & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    probe: async () => {
      calls.push('probe');
      return {
        duration: Rational.approximate(12.5) ?? Rational.ZERO,
        streams: [
          { type: 'video', codec: 'mpeg4', width: 720, height: 480, fps: 29.97 },
          { type: 'audio', codec: 'mp3', sampleRate: 44100, channels: 2 },
        ],
      };
    },
    conformForPreview: async () => {
      calls.push('conform');
      return new Blob(['webm'], { type: 'video/webm' });
    },
    extractAudio: async () => {
      calls.push('audio');
      return new PlainAudioBuffer([new Float32Array(4), new Float32Array(4)], 44100);
    },
  };
}

const aviBlob = (): Blob => new Blob([new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x41, 0x56, 0x49, 0x20])]);

describe('MediaDecoder FFmpeg fallback', () => {
  it('probes through FFmpeg when nothing native can read the file', async () => {
    const fallback = fakeFallback();
    const decoder = new MediaDecoder(aviBlob(), 'm1', { fallback });
    const info = await decoder.init();
    expect(info).toMatchObject({ type: 'video', width: 720, height: 480, videoCodec: 'mpeg4', audioCodec: 'mp3', audioChannels: 2, viaFallback: true });
    expect(info.duration.asNumber()).toBeCloseTo(12.5, 6);
    expect(info.fps.fps().asNumber()).toBeCloseTo(29.97, 2);
    // Frames: conform exactly once even across calls.
    await decoder.getFrame(Rational.ZERO);
    await decoder.getFrame(Rational.ONE);
    expect(fallback.calls.filter((call) => call === 'conform')).toHaveLength(1);
    await decoder.getAudioBuffer();
    expect(fallback.calls).toContain('audio');
    decoder.close();
    expect(await decoder.getFrame(Rational.ZERO)).toBeNull();
  });

  it('keeps an empty probe when FFmpeg fails, and never calls it without a fallback', async () => {
    const broken: MediaFallback = {
      probe: async () => {
        throw new Error('unavailable');
      },
      conformForPreview: async () => new Blob(),
      extractAudio: async () => new PlainAudioBuffer([], 48000),
    };
    const info = await new MediaDecoder(aviBlob(), 'm2', { fallback: broken }).init();
    expect(info.viaFallback).toBe(false);
    expect(info.width).toBe(0);
    const plain = await new MediaDecoder(aviBlob(), 'm3').init();
    expect(plain.viaFallback).toBe(false);
  });
});

describe('MediaPool proxies and relink', () => {
  it('reports proxy size while proxies are on and the original otherwise', async () => {
    const pool = new MediaPool({ fallback: fakeFallback() });
    const asset = await pool.addMedia(aviBlob(), 'a1', 'clip.avi');
    expect(asset).toMatchObject({ width: 720, height: 480, codec: 'mpeg4' });
    expect(pool.attachProxy('missing', new Blob(), { width: 1, height: 1 })).toBe(false);
    expect(pool.attachProxy('a1', new Blob(['p']), { width: 640, height: 426 })).toBe(true);
    expect(pool.hasProxy('a1')).toBe(true);
    expect(pool.proxiesEnabled).toBe(true);
    expect(pool.getSize('a1')).toEqual({ width: 640, height: 426 });
    pool.setUseProxies(false);
    expect(pool.getSize('a1')).toEqual({ width: 720, height: 480 });
    pool.setUseProxies(true);
    await pool.preload([{ id: 'a1', time: Rational.ZERO }]);
    expect(await pool.getOriginalFrame('nope', Rational.ZERO)).toBeNull();
    pool.detachProxy('a1');
    expect(pool.hasProxy('a1')).toBe(false);
    expect(pool.getSize('a1')).toEqual({ width: 720, height: 480 });
    pool.attachProxy('a1', new Blob(['p']), { width: 640, height: 426 });
    pool.removeMedia('a1');
    expect(pool.hasProxy('a1')).toBe(false);
  });

  it('replaces the source of an asset without changing its id', async () => {
    const pool = new MediaPool({ fallback: fakeFallback() });
    await pool.addMedia(aviBlob(), 'a2', 'old.avi');
    const file = new File([aviBlob()], 'new.avi');
    const next = await pool.replaceSource('a2', file);
    expect(next).toMatchObject({ id: 'a2', name: 'new.avi', file });
    expect(pool.get('a2')?.file).toBe(file);
    expect(await pool.replaceSource('ghost', file)).toBeNull();
    pool.destroy();
  });
});
