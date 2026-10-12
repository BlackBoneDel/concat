// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Audio effects model, offline chain, worker orchestration and the mixer hook. */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AUDIO_EFFECTS,
  defaultAudioEffects,
  isNeutralAudio,
  parseAudioEffects,
  renderAudioEffects,
} from '../src/media/audio/audio-effects.ts';
import { AudioProcessor, PlainAudioBuffer, deinterleave, isFxContext } from '../src/media/audio/audio-processor.ts';
import { createAudioBuffer } from '../src/media/audio/audio-buffer.ts';
import { createPitchHandlers, readChannels } from '../src/media/audio/pitch-worker.ts';
import { DEFAULT_EQ_BANDS } from '../src/media/audio/equalizer.ts';
import { AudioMixer, setDefaultAudioFxResolver, type AudioGraphContext, type GainLike, type ParamLike, type SourceLike } from '../src/player/audio-mixer.ts';
import { WorkerClient } from '../src/workers/worker-client.ts';
import { bufferOf, linkedWorker, rms, tone, zeroCrossingFrequency } from './f4-helpers.ts';

describe('audio buffers', () => {
  it('validates plain buffers and deinterleaves', () => {
    expect(() => new PlainAudioBuffer([], 48000)).toThrow();
    expect(() => new PlainAudioBuffer([new Float32Array(2)], 0)).toThrow();
    expect(() => new PlainAudioBuffer([new Float32Array(2), new Float32Array(3)], 48000)).toThrow(/longitud/);
    const b = new PlainAudioBuffer([new Float32Array(48000)], 48000);
    expect(b.duration).toBe(1);
    expect(() => b.getChannelData(1)).toThrow(/fuera de rango/);
    expect(deinterleave(Float32Array.of(1, 2, 3, 4), 2).map((c) => Array.from(c))).toEqual([[1, 3], [2, 4]]);
    expect(createAudioBuffer([new Float32Array(0)], 48000).length).toBe(1);
  });
});

describe('audio effects model', () => {
  it('parses and clamps JSON, falling back to defaults', () => {
    expect(parseAudioEffects(null)).toEqual(DEFAULT_AUDIO_EFFECTS);
    const parsed = parseAudioEffects({
      eq: [{ type: 'peaking', frequency: 1000, gain: 3, q: 1 }],
      compressor: { ratio: 50 },
      limiter: { ceiling: -2 },
      gate: { threshold: -45 },
      normalize: { mode: 'loudness', target: -14, gainDb: 3.5 },
      channelMode: 'mono',
      preservePitch: true,
      semitones: 40,
      fadeInCurve: 'sCurve',
      fadeOutCurve: 'nope',
    });
    expect(parsed.eq).toHaveLength(1);
    expect(parsed.compressor?.ratio).toBe(20);
    expect(parsed.limiter?.ceiling).toBe(-2);
    expect(parsed.gate?.threshold).toBe(-45);
    expect(parsed.normalize).toEqual({ mode: 'loudness', target: -14, truePeakCeiling: -1, gainDb: 3.5 });
    expect(parsed.channelMode).toBe('mono');
    expect(parsed.preservePitch).toBe(true);
    expect(parsed.semitones).toBe(24);
    expect(parsed.fadeInCurve).toBe('sCurve');
    expect(parsed.fadeOutCurve).toBe('linear');
    expect(parseAudioEffects({ normalize: { mode: 'peak' } }).normalize).toEqual({ mode: 'peak', target: -1, truePeakCeiling: -1, gainDb: null });
  });

  it('knows when effects are neutral', () => {
    expect(isNeutralAudio(defaultAudioEffects())).toBe(true);
    expect(isNeutralAudio({ ...defaultAudioEffects(), eq: DEFAULT_EQ_BANDS.slice(1) })).toBe(true);
    expect(isNeutralAudio({ ...defaultAudioEffects(), channelMode: 'swap' })).toBe(false);
  });

  it('renders the chain offline in order', () => {
    const input = bufferOf([tone(1000, 1, 48000, 0.9), tone(1000, 1, 48000, 0.1)]);
    const out = renderAudioEffects(input, {
      ...defaultAudioEffects(),
      channelMode: 'left',
      normalize: { mode: 'peak', target: -6, gainDb: null },
      limiter: { ceiling: -10, lookahead: 2, release: 50 },
    });
    expect(Math.max(...out.getChannelData(1))).toBeLessThanOrEqual(10 ** (-10 / 20) + 1e-6);
    expect(rms(out.getChannelData(0))).toBeCloseTo(rms(out.getChannelData(1)), 6);
    const fixed = renderAudioEffects(bufferOf([Float32Array.of(0.5)]), { ...defaultAudioEffects(), normalize: { mode: 'loudness', target: -23, gainDb: 6.0206 } });
    expect(fixed.getChannelData(0)[0]).toBeCloseTo(1, 3);
    const everything = renderAudioEffects(bufferOf([tone(440, 0.5)]), {
      ...defaultAudioEffects(),
      semitones: 12,
      gate: { threshold: -60, attack: 1, hold: 10, release: 50, range: -80 },
      eq: [...DEFAULT_EQ_BANDS],
      compressor: { threshold: -20, ratio: 2, knee: 0, attack: 0.01, release: 0.1, makeupGain: 0 },
    });
    expect(everything.numberOfChannels).toBe(1);
    expect(Math.abs(zeroCrossingFrequency(everything.getChannelData(0), 48000) - 880)).toBeLessThan(15);
  });
});

describe('AudioProcessor', () => {
  it('runs loudness, variants and renders through the worker', async () => {
    const link = linkedWorker(createPitchHandlers());
    const processor = new AudioProcessor({ client: new WorkerClient(() => link.worker) });
    const loud = await processor.measureLoudness(bufferOf([tone(1000, 5, 48000, 10 ** (-23 / 20)), tone(1000, 5, 48000, 10 ** (-23 / 20))]));
    expect(Math.abs(loud.integrated - -23)).toBeLessThan(0.1);
    const source = bufferOf([tone(440, 1)]);
    let ready = 0;
    processor.onVariantReady = () => {
      ready += 1;
    };
    const spec = { rate: 2, preservePitch: true, semitones: 0 };
    expect(processor.variantFor(source, spec)).toBeNull();
    const variant = await processor.requestVariant(source, spec);
    expect(variant.length).toBe(24000);
    expect(processor.variantFor(source, spec)).toBe(variant);
    expect(await processor.requestVariant(source, spec)).toBe(variant);
    expect(ready).toBe(1);
    const rendered = await processor.renderEffects(source, { ...defaultAudioEffects(), channelMode: 'mono' });
    expect(rendered.numberOfChannels).toBe(2);
    processor.terminate();
    expect(link.terminated()).toBe(1);
  });

  it('falls back inline without workers', async () => {
    const processor = new AudioProcessor({ client: new WorkerClient(() => null) });
    const source = bufferOf([tone(440, 0.5)]);
    expect((await processor.renderVariant(source, { rate: 1, preservePitch: false, semitones: 0 })).length).toBe(24000);
    expect((await processor.renderVariant(source, { rate: 0.5, preservePitch: false, semitones: 0 })).length).toBe(48000);
    expect((await processor.measureLoudness(source)).samplePeak).toBeCloseTo(-6.02, 1);
    expect((await processor.renderEffects(source, defaultAudioEffects())).length).toBe(24000);
    await expect(processor.requestVariant(source, { rate: 9, preservePitch: true, semitones: 0 })).rejects.toThrow(/0.25–4/);
  });

  it('validates worker payloads', () => {
    expect(() => readChannels(null)).toThrow();
    expect(() => readChannels({ channels: [[1]], sampleRate: 48000 })).toThrow(/Float32Array/);
    expect(() => readChannels({ channels: [new Float32Array(1)], sampleRate: -1 })).toThrow(/sampleRate/);
    const tools = { progress: () => undefined, transfer: [] as Transferable[] };
    const out = createPitchHandlers()['stretch']!({ channels: [tone(440, 0.1)], sampleRate: 48000, rate: 1, semitones: 0 }, tools);
    expect(Array.isArray(out)).toBe(true);
    expect(tools.transfer).toHaveLength(1);
  });
});

/** A recording Web Audio double. */
function fakeContext() {
  const log: string[] = [];
  let n = 0;
  const param = (): ParamLike & { curves: Float32Array[] } => {
    const curves: Float32Array[] = [];
    return {
      value: 1,
      curves,
      setValueAtTime: () => undefined,
      linearRampToValueAtTime: () => undefined,
      setValueCurveAtTime: (values: Float32Array) => void curves.push(values),
    };
  };
  const node = (kind: string) => {
    const label = `${kind}${n++}`;
    return {
      label,
      connect: (dest: unknown) => {
        log.push(`${label}->${typeof dest === 'object' && dest !== null && 'label' in dest ? String(dest.label) : 'dest'}`);
        return dest;
      },
      disconnect: () => log.push(`x${label}`),
    };
  };
  const gains: (GainLike & { gain: ReturnType<typeof param> })[] = [];
  const sources: (SourceLike & { started: number[] })[] = [];
  const context = {
    currentTime: 0,
    sampleRate: 48000,
    destination: { label: 'out' },
    createGain: () => {
      const g = { ...node('g'), gain: param() };
      gains.push(g);
      return g;
    },
    createAnalyser: () => ({ ...node('a'), fftSize: 1024, getFloatTimeDomainData: () => undefined }),
    createBufferSource: () => {
      const s = {
        ...node('s'),
        buffer: null,
        playbackRate: param(),
        started: [] as number[],
        start(when = 0, offset = 0) {
          this.started.push(when, offset);
        },
        stop: () => undefined,
      };
      sources.push(s);
      return s;
    },
    createBiquadFilter: () => ({ ...node('eq'), type: 'peaking' as BiquadFilterType, frequency: { value: 0 }, Q: { value: 0 }, gain: { value: 0 } }),
    createDynamicsCompressor: () => ({ ...node('comp'), threshold: { value: 0 }, knee: { value: 0 }, ratio: { value: 0 }, attack: { value: 0 }, release: { value: 0 } }),
    createWaveShaper: () => ({ ...node('ws'), curve: null as Float32Array | null, oversample: 'none' as OverSampleType }),
    createChannelSplitter: () => node('split'),
    createChannelMerger: () => node('merge'),
  };
  return { context, log, gains, sources };
}

describe('realtime chain + mixer hook (Fase 4)', () => {
  it('builds a node chain only when needed', () => {
    const { context, log } = fakeContext();
    const processor = new AudioProcessor({ client: new WorkerClient(() => null) });
    expect(isFxContext(context)).toBe(true);
    expect(isFxContext({ createGain: () => 0 })).toBe(false);
    expect(processor.buildRealtimeChain(context, defaultAudioEffects())).toBeNull();
    expect(processor.buildRealtimeChain({}, { ...defaultAudioEffects(), channelMode: 'mono' })).toBeNull();
    const chain = processor.buildRealtimeChain(context, {
      ...defaultAudioEffects(),
      channelMode: 'swap',
      gate: { threshold: -50, attack: 1, hold: 10, release: 50, range: -80 }, // no worklet → skipped
      eq: [{ type: 'peaking', frequency: 1000, gain: 3, q: 1, enabled: true }],
      compressor: { threshold: -20, ratio: 4, knee: 0, attack: 0.01, release: 0.1, makeupGain: 2 },
      normalize: { mode: 'loudness', target: -14, gainDb: 4 },
      limiter: { ceiling: -1, lookahead: 5, release: 100 },
    });
    expect(chain).not.toBeNull();
    chain!.connect({ label: 'track' });
    for (const edge of ['g0->split1', 'merge2->eq3', 'eq3->comp4', 'comp4->g5', 'g5->g6', 'g6->comp7', 'comp7->ws8', 'ws8->track']) expect(log).toContain(edge);
    chain!.dispose();
    expect(log.filter((l) => l.startsWith('x')).length).toBeGreaterThanOrEqual(8);
  });

  it('swaps buffers, rescales time, splices chains and curves fades', () => {
    const { context, log, gains, sources } = fakeContext();
    const graph: AudioGraphContext = context;
    const mixer = new AudioMixer(graph);
    expect(mixer.audioContext).toBe(graph);
    const original = { duration: 10 };
    const stretched = { duration: 5 };
    const disposed: string[] = [];
    mixer.setAudioFxResolver((key) =>
      key === 'clip'
        ? {
            buffer: stretched,
            rateScale: 0.5,
            offsetScale: 0.5,
            chain: { input: { label: 'fx' }, connect: (dest) => log.push(`fx->${typeof dest === 'object' && dest !== null && 'label' in dest ? String(dest.label) : '?'}`), dispose: () => disposed.push(key) },
            fadeInCurve: Float32Array.of(0, 1),
            fadeOutCurve: Float32Array.of(1, 0),
          }
        : null,
    );
    mixer.addClipSource('t1', 'clip', { timelineStart: 0, sourceOffset: 2, duration: 4, buffer: original, volume: 0.5, fadeIn: 1, fadeOut: 1, rate: 2 });
    mixer.startAll(1);
    const source = sources[0]!;
    expect(source.buffer).toBe(stretched);
    expect(source.playbackRate.value).toBe(1);
    expect(source.started).toEqual([0, 2]); // 2·0.5 + 1·(2·0.5)
    expect(log.some((l) => /^fx->g\d+$/.test(l))).toBe(true); // chain → track gain
    const clipGain = gains[gains.length - 1]!;
    expect(clipGain.gain.curves.map((c) => Array.from(c))).toEqual([[0.5, 0]]); // fade-in skipped mid-fade, fade-out curved
    mixer.stopAll();
    expect(disposed).toEqual(['clip']);
    mixer.setAudioFxResolver(null);
  });

  it('uses the process-wide resolver and survives resolver errors', () => {
    const { context, sources } = fakeContext();
    const mixer = new AudioMixer(context);
    setDefaultAudioFxResolver(() => {
      throw new Error('boom');
    });
    try {
      mixer.addClipSource('t', 'k', { timelineStart: 0, sourceOffset: 0, duration: 1, buffer: { duration: 1 }, volume: 1, fadeIn: 0, fadeOut: 0, rate: 1 });
      mixer.startAll(0);
      expect(sources).toHaveLength(1);
    } finally {
      setDefaultAudioFxResolver(null);
    }
  });
});
