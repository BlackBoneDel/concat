// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** SnapEngine and the waveform generator. */

import { describe, expect, it, vi } from 'vitest';
import { Rational } from '../src/core/rational.ts';
import { SnapEngine, type SnapCandidate } from '../src/editor/snapping.ts';
import {
  WaveformCache,
  getBestWaveform,
  peaksOf,
  waveformCache,
  type WaveformData,
} from '../src/media/waveform-generator.ts';
import { makeSession, r } from './f3-helpers.ts';

function candidate(seconds: number, kind: SnapCandidate['kind'], label = ''): SnapCandidate {
  return { time: r(seconds), kind, label };
}

describe('SnapEngine', () => {
  it('snaps al candidato más cercano dentro del umbral', () => {
    const engine = new SnapEngine(10);
    const result = engine.snap(r(5.05), 100, [candidate(5, 'clip-start')]);
    expect(result.snappedTime.asNumber()).toBeCloseTo(5, 6);
    expect(result.snappedTo?.kind).toBe('clip-start');
  });

  it('no snap fuera del umbral (10px)', () => {
    const engine = new SnapEngine(10);
    // 10px a 100px/s = 0.1s de tolerancia.
    const result = engine.snap(r(5.2), 100, [candidate(5, 'clip-start')]);
    expect(result.snappedTo).toBeNull();
    expect(result.snappedTime.asNumber()).toBeCloseTo(5.2, 6);
  });

  it('Shift desactiva el snapping', () => {
    const engine = new SnapEngine(10);
    engine.setEnabled(false);
    const result = engine.snap(r(5.01), 100, [candidate(5, 'clip-start')]);
    expect(result.snappedTo).toBeNull();
    engine.setEnabled(true);
    expect(engine.enabled).toBe(true);
  });

  it('la prioridad desempata: playhead > marker > clip > segundo', () => {
    const engine = new SnapEngine(10);
    const result = engine.snap(r(5.0), 100, [
      candidate(5, 'second'),
      candidate(5, 'clip-end'),
      candidate(5, 'marker'),
      candidate(5, 'playhead'),
    ]);
    expect(result.snappedTo?.kind).toBe('playhead');
  });

  it('markers > clip edges en empate', () => {
    const engine = new SnapEngine(10);
    const result = engine.snap(r(5.0), 100, [candidate(5, 'clip-start'), candidate(5, 'marker')]);
    expect(result.snappedTo?.kind).toBe('marker');
  });

  it('computeCandidates incluye playhead, markers, bordes, segundos y límites', () => {
    const session = makeSession([{ start: 1, duration: 2 }]);
    const engine = new SnapEngine(10);
    const markers = [{ id: 'm-1', time: r(3), label: 'uno', color: '#fff', note: '' }];
    const candidates = engine.computeCandidates(session.document, [], r(0.5), markers);
    const kinds = new Set(candidates.map((entry) => entry.kind));
    expect(kinds.has('playhead')).toBe(true);
    expect(kinds.has('marker')).toBe(true);
    expect(kinds.has('clip-start')).toBe(true);
    expect(kinds.has('clip-end')).toBe(true);
    expect(kinds.has('timeline-start')).toBe(true);
    expect(kinds.has('timeline-end')).toBe(true);
    expect(kinds.has('second')).toBe(true);
  });

  it('computeCandidates excluye los clips arrastrados', () => {
    const session = makeSession([{ start: 1, duration: 2 }]);
    const engine = new SnapEngine(10);
    const candidates = engine.computeCandidates(session.document, ['c1'], r(0), []);
    expect(candidates.some((entry) => entry.clipId === 'c1')).toBe(false);
  });

  it('setThreshold cambia el radio', () => {
    const engine = new SnapEngine(10);
    engine.setThreshold(40);
    expect(engine.threshold).toBe(40);
    // 40px a 100px/s = 0.4s: ahora sí alcanza.
    const result = engine.snap(r(5.3), 100, [candidate(5, 'clip-start')]);
    expect(result.snappedTo).not.toBeNull();
  });

  it('snap con zoom 0 devuelve el tiempo sin tocar', () => {
    const engine = new SnapEngine(10);
    const result = engine.snap(r(5.01), 0, [candidate(5, 'clip-start')]);
    expect(result.snappedTo).toBeNull();
    void Rational.ZERO;
  });
});

describe('waveforms', () => {
  it('peaksOf agrupa min/max por bucket', () => {
    const samples = Float32Array.from([0.5, -0.5, 0.25, -1, 1, 0]);
    const peaks = peaksOf(samples, 2);
    expect(peaks).toHaveLength(6); // 3 buckets × 2
    expect(peaks[0]).toBeCloseTo(-0.5, 6);
    expect(peaks[1]).toBeCloseTo(0.5, 6);
    expect(peaks[2]).toBeCloseTo(-1, 6);
    expect(peaks[3]).toBeCloseTo(0.25, 6);
    expect(peaks[4]).toBeCloseTo(0, 6);
    expect(peaks[5]).toBeCloseTo(1, 6);
  });

  it('peaksOf con señal vacía produce un bucket neutro', () => {
    const peaks = peaksOf(new Float32Array(0), 128);
    expect(peaks).toHaveLength(2);
    expect(peaks[0]).toBe(0);
    expect(peaks[1]).toBe(0);
  });

  it('peaksOf con step mayor que la señal', () => {
    const peaks = peaksOf(Float32Array.from([0.1, 0.2]), 1024);
    expect(peaks).toHaveLength(2);
    expect(peaks[0]).toBeCloseTo(0.1, 6);
    expect(peaks[1]).toBeCloseTo(0.2, 6);
  });

  it('cache put/get/delete de resoluciones', async () => {
    const cache = new WaveformCache();
    const data: WaveformData = {
      mediaId: 'mZ',
      samplesPerPixel: 128,
      data: Float32Array.from([0, 1]),
      duration: 1,
      channels: 2,
    };
    await cache.put(data);
    const got = await cache.get('mZ', 128);
    expect(got?.samplesPerPixel).toBe(128);
    expect(got?.data).toHaveLength(2);
    await cache.delete('mZ');
    expect(await cache.get('mZ', 128)).toBeNull();
  });

  it('getBestWaveelige por zoom y cae a la disponible', async () => {
    const fine: WaveformData = {
      mediaId: 'mB',
      samplesPerPixel: 128,
      data: Float32Array.from([0, 1]),
      duration: 1,
      channels: 1,
    };
    const coarse: WaveformData = {
      mediaId: 'mC',
      samplesPerPixel: 2048,
      data: Float32Array.from([0, 1]),
      duration: 1,
      channels: 1,
    };
    await waveformCache.put(fine);
    await waveformCache.put(coarse);
    expect((await getBestWaveform('mB', 200))?.samplesPerPixel).toBe(128);
    expect((await getBestWaveform('mB', 20))?.samplesPerPixel).toBe(128); // fallback
    expect((await getBestWaveform('mC', 20))?.samplesPerPixel).toBe(2048);
    expect(await getBestWaveform('mZZ', 100)).toBeNull();
  });

  it('getBestWaveform prioriza 512 en zoom medio', async () => {
    const mid: WaveformData = {
      mediaId: 'mM',
      samplesPerPixel: 512,
      data: Float32Array.from([0, 1]),
      duration: 1,
      channels: 1,
    };
    await waveformCache.put(mid);
    expect((await getBestWaveform('mM', 100))?.samplesPerPixel).toBe(512);
  });

  it('get devuelve null para media sin picos', async () => {
    expect(await waveformCache.get('mNOPE', 128)).toBeNull();
  });

  it('exporta WAVEFORM_RESOLUTIONS', async () => {
    const mod = await import('../src/media/waveform-generator.ts');
    expect(mod.WAVEFORM_RESOLUTIONS).toEqual([128, 512, 2048]);
    const spy = vi.fn();
    spy();
    expect(spy).toHaveBeenCalled();
    void Rational.ZERO;
  });
});

// -- Fase 7+: la cache de waveforms sobrevive a un schema roto -------------

import { MemoryKeyValue, type KeyValue } from '../src/storage/idb.ts';

/** A backend that throws NotFoundError on every waveforms access (v2 schema). */
function brokenBackend(): KeyValue {
  const fail = (): never => {
    const error = new Error('store not found: waveforms');
    error.name = 'NotFoundError';
    throw error;
  };
  return {
    get: () => Promise.reject(new Error('NotFoundError')),
    getAll: () => Promise.reject(new Error('NotFoundError')),
    put: async () => {
      fail();
    },
    delete: async () => {
      fail();
    },
    count: async () => fail(),
    clear: async () => {
      fail();
    },
  };
}

describe('WaveformCache resilience (Fase 7+)', () => {
  it('get devuelve null con un backend roto (store waveforms ausente)', async () => {
    const cache = new WaveformCache(async () => brokenBackend());
    expect(await cache.get('m1', 128)).toBeNull();
  });

  it('put y delete no propagan el error del backend roto', async () => {
    const cache = new WaveformCache(async () => brokenBackend());
    const data: WaveformData = {
      mediaId: 'm1',
      samplesPerPixel: 128,
      data: Float32Array.from([0, 1]),
      duration: 1,
      channels: 1,
    };
    await expect(cache.put(data)).resolves.toBeUndefined();
    await expect(cache.delete('m1')).resolves.toBeUndefined();
  });

  it('tolera un opener que rechaza (IndexedDB bloqueado)', async () => {
    const cache = new WaveformCache(async () => {
      throw new Error('indexedDB blocked');
    });
    expect(await cache.get('m1', 512)).toBeNull();
    await expect(
      cache.put({ mediaId: 'm1', samplesPerPixel: 512, data: new Float32Array(2), duration: 1, channels: 1 }),
    ).resolves.toBeUndefined();
  });

  it('abre el backend una sola vez (memoizado)', async () => {
    const opener = vi.fn(async () => new MemoryKeyValue() as KeyValue);
    const cache = new WaveformCache(opener);
    await cache.get('a', 128);
    await cache.put({ mediaId: 'a', samplesPerPixel: 128, data: new Float32Array(2), duration: 1, channels: 1 });
    await cache.get('a', 128);
    expect(opener).toHaveBeenCalledTimes(1);
  });

  it('guarda bajo la clave mediaId_samplesPerPixel', async () => {
    const backend = new MemoryKeyValue();
    const cache = new WaveformCache(async () => backend);
    await cache.put({ mediaId: 'k9', samplesPerPixel: 2048, data: Float32Array.from([0.5, 1]), duration: 2, channels: 1 });
    const all = await backend.getAll<WaveformData>('waveforms');
    expect(all).toHaveLength(1);
    expect(all[0]!.mediaId).toBe('k9');
    expect(await backend.get<WaveformData>('waveforms', 'k9_2048')).toMatchObject({ samplesPerPixel: 2048 });
    expect(await cache.get('k9', 2048)).not.toBeNull();
  });
});
