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

// -- Fase 7+: regresiones del import de vídeo (NaN / duración OBS) ---------

import { clampSeekTime, finiteDuration, revealDuration, type DurationProbeElement } from '../src/media/decoder.ts';

/** A media element double whose duration can be flipped mid-seek. */
class FakeMediaElement implements DurationProbeElement {
  duration: number;
  /** When set, assigning `currentTime` updates the duration and fires. */
  revealOnSeek: number | null = null;
  private time = 0;
  private readonly listeners = new Map<string, (() => void)[]>();
  constructor(duration: number) {
    this.duration = duration;
  }
  get currentTime(): number {
    return this.time;
  }
  set currentTime(value: number) {
    // Real engines throw on a non-finite assignment — so does the double.
    if (!Number.isFinite(value) || value < 0) throw new Error('currentTime = NaN throws in every engine');
    this.time = value;
    if (this.revealOnSeek !== null) {
      this.duration = this.revealOnSeek;
      this.revealOnSeek = null;
      for (const listener of this.listeners.get('durationchange') ?? []) listener();
    }
  }
  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((l) => l !== listener));
  }
}

describe('clampSeekTime (regresión: currentTime = NaN)', () => {
  it('maps NaN and negative times to 0 instead of poisoning currentTime', () => {
    expect(clampSeekTime(Number.NaN, 10)).toBe(0);
    expect(clampSeekTime(-3, 10)).toBe(0);
  });

  it('passes the time through when the duration is NaN (WebM sin cabecera)', () => {
    expect(clampSeekTime(2.5, Number.NaN)).toBe(2.5);
  });

  it('passes the time through when the duration is Infinity (ficheros OBS)', () => {
    expect(clampSeekTime(7.25, Infinity)).toBe(7.25);
  });

  it('clamps to just before the end for a finite duration', () => {
    expect(clampSeekTime(10, 4)).toBeCloseTo(3.999, 6);
    expect(clampSeekTime(1, 4)).toBe(1);
  });

  it('never returns NaN across pathological combinations', () => {
    const times = [Number.NaN, -1, 0, 0.5, 1e9, Infinity, -Infinity];
    const durations = [Number.NaN, -5, 0, 0.0005, 12.34, Infinity];
    for (const time of times) {
      for (const duration of durations) {
        const clamped = clampSeekTime(time, duration);
        expect(Number.isFinite(clamped)).toBe(true);
        expect(clamped).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('finiteDuration', () => {
  it('treats Infinity, NaN and non-positive durations as unknown (0)', () => {
    expect(finiteDuration(Infinity)).toBe(0);
    expect(finiteDuration(Number.NaN)).toBe(0);
    expect(finiteDuration(-2)).toBe(0);
    expect(finiteDuration(0)).toBe(0);
    expect(finiteDuration(12.5)).toBe(12.5);
  });
});

describe('revealDuration (regresión: duración cero en ficheros OBS)', () => {
  it('returns a known finite duration without seeking', async () => {
    const element = new FakeMediaElement(8);
    expect(await revealDuration(element)).toBe(8);
    expect(element.currentTime).toBe(0);
  });

  it('reveals an Infinity duration through the seek-to-the-end trick', async () => {
    const element = new FakeMediaElement(Infinity);
    element.revealOnSeek = 42.5; // the element announces the real duration
    expect(await revealDuration(element)).toBe(42.5);
    expect(element.currentTime).toBe(0); // rewound after the discovery
  });

  it('resolves 0 when the duration never appears (timeout)', async () => {
    const element = new FakeMediaElement(Number.NaN);
    expect(await revealDuration(element, 5)).toBe(0);
  });
});
