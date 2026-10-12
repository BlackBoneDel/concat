// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Fase 5 audio stack: delay feedback loop, convolution reverb, chorus LFO, series chains, mixer resolver. */

import { describe, expect, it, vi } from 'vitest';
import { withAudioStack } from '../src/app/effect-resolvers.ts';
import { AddAudioEffectOperation, ToggleEffectOperation } from '../src/editor/effects-operations.ts';
import { createAudioEffect } from '../src/media/effects/effects-stack.ts';
import {
  buildAudioStackChain,
  chainInSeries,
  createChorusEffect,
  createDelayEffect,
  createReverbEffect,
  irToBuffer,
  isFxAudioContext,
  type AudioStackChain,
  type IrSource,
} from '../src/media/effects/audio-effects.ts';
import { generateImpulseResponse, type ImpulseResponse } from '../src/media/effects/reverb-ir-generator.ts';
import type { ClipSourceSpec } from '../src/player/audio-mixer.ts';
import { bufferOf, tone } from './f4-helpers.ts';
import { FakeAudioContext, FakeBuffer, FakeNode, fakeBuffer, makeF5Session } from './f5-helpers.ts';

const tinyIr: ImpulseResponse = { sampleRate: 48000, channels: [new Float32Array([0.9, 0.5]), new Float32Array([0.8, 0.4])], duration: 0.3 };

function irs(result: Promise<ImpulseResponse> = Promise.resolve(tinyIr)): IrSource & { calls: number } {
  const source = {
    calls: 0,
    get: () => {
      source.calls += 1;
      return result;
    },
  };
  return source;
}

function linked(from: FakeNode, to: FakeNode): boolean {
  return from.connections.includes(to);
}

describe('delay', () => {
  it('Delay → feedback Gain loop → wet mix, with clamped parameters', () => {
    const ctx = new FakeAudioContext();
    const unit = createDelayEffect(ctx, { time: 5000, feedback: 2, mix: 0.25 });
    const [delay] = ctx.of('delay');
    const gains = ctx.of('gain');
    const feedback = gains.find((g) => linked(delay!, g) && linked(g, delay!))!;
    expect(delay!.delayTime.value).toBe(2);
    expect(delay!.maxDelay).toBeGreaterThanOrEqual(2);
    expect(feedback.gain.value).toBe(0.95);
    const [input, output, dry, wet] = gains;
    expect(unit.input).toBe(input);
    expect(unit.output).toBe(output);
    expect(dry!.gain.value).toBe(0.75);
    expect(wet!.gain.value).toBe(0.25);
    expect(linked(input!, delay!) && linked(delay!, wet!) && linked(wet!, output!) && linked(input!, dry!)).toBe(true);
    unit.dispose();
    expect(ctx.nodes.every((node) => node.disconnected === 1)).toBe(true);
  });

  it('clamps short delays to 10 ms', () => {
    const ctx = new FakeAudioContext();
    createDelayEffect(ctx, { time: 1, feedback: -1, mix: 1 });
    expect(ctx.of('delay')[0]!.delayTime.value).toBe(0.01);
  });
});

describe('reverb', () => {
  it('loads a synthetic IR into the convolver asynchronously', async () => {
    const ctx = new FakeAudioContext();
    const source = irs();
    createReverbEffect(ctx, { roomSize: 0.5, damping: 0.4, mix: 0.3 }, source);
    const convolver = ctx.of('convolver')[0]!;
    expect(convolver.normalize).toBe(true);
    expect(convolver.buffer).toBeNull();
    await vi.waitFor(() => expect(convolver.buffer).toBeInstanceOf(FakeBuffer));
    const buffer = fakeBuffer(convolver.buffer);
    expect(Array.from(buffer.getChannelData(1))).toEqual([0.800000011920929, 0.4000000059604645]);
    expect(source.calls).toBe(1);
  });

  it('stays dry and reports when the IR fails; ignores late IRs after dispose', async () => {
    const ctx = new FakeAudioContext();
    const onError = vi.fn();
    createReverbEffect(ctx, { roomSize: 0.5, damping: 0.4, mix: 0.3 }, irs(Promise.reject(new Error('x'))), onError);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    const late = new FakeAudioContext();
    const unit = createReverbEffect(late, { roomSize: 0.5, damping: 0.4, mix: 0.3 }, irs());
    unit.dispose();
    await Promise.resolve();
    await Promise.resolve();
    expect(late.of('convolver')[0]!.buffer).toBeNull();
  });

  it('irToBuffer copies every channel (getChannelData fallback too)', () => {
    const ctx = new FakeAudioContext();
    const ir = generateImpulseResponse({ sampleRate: 8000, roomSize: 0.05, damping: 0 });
    const buffer = fakeBuffer(irToBuffer(ctx, ir));
    expect(buffer.data[0]).toEqual(ir.channels[0]);
    expect(irToBuffer(ctx, { sampleRate: 8000, channels: [], duration: 0 })).toBeNull();
    const noCopy = {
      ...ctx,
      createBuffer: () => {
        const data = [new Float32Array(2), new Float32Array(2)];
        return { getChannelData: (c: number) => data[c]! };
      },
    };
    const filled = irToBuffer({ ...noCopy, createGain: () => ctx.createGain(), createDelay: () => ctx.createDelay(), createConvolver: () => ctx.createConvolver(), createOscillator: () => ctx.createOscillator() }, tinyIr);
    expect(filled?.getChannelData?.(0)[0]).toBeCloseTo(0.9);
  });
});

describe('chorus', () => {
  it('sweeps a short delay with a started sine LFO', () => {
    const ctx = new FakeAudioContext();
    const unit = createChorusEffect(ctx, { rate: 50, depth: 3, delay: 18, mix: 0.5 });
    const lfo = ctx.of('oscillator')[0]!;
    const delay = ctx.of('delay')[0]!;
    expect(lfo.type).toBe('sine');
    expect(lfo.frequency.value).toBe(8);
    expect(lfo.started).toBe(true);
    const lfoGain = ctx.of('gain').find((g) => g.connections.includes(delay.delayTime))!;
    expect(lfoGain.gain.value).toBeCloseTo(0.003);
    expect(delay.delayTime.value).toBeCloseTo(0.018);
    unit.dispose();
    expect(lfo.stopped).toBe(true);
  });

  it('keeps the swept delay positive', () => {
    const ctx = new FakeAudioContext();
    createChorusEffect(ctx, { rate: 1, depth: 10, delay: 5, mix: 0.5 });
    expect(ctx.of('delay')[0]!.delayTime.value).toBeCloseTo(0.011);
  });
});

describe('stack chains', () => {
  it('builds active effects in series and skips bypassed/neutral ones', () => {
    const ctx = new FakeAudioContext();
    const stack = [
      createAudioEffect('delay'),
      { ...createAudioEffect('chorus'), enabled: false },
      createAudioEffect('reverb', { mix: 0 }),
      createAudioEffect('chorus'),
    ];
    const chain = buildAudioStackChain(ctx, stack, irs())!;
    expect(ctx.of('delay')).toHaveLength(2); // delay + one chorus
    expect(ctx.of('convolver')).toHaveLength(0);
    const destination = new FakeNode('dest');
    chain.connect(destination);
    expect(ctx.nodes.some((n) => n.connections.includes(destination))).toBe(true);
    chain.dispose();
    expect(buildAudioStackChain(ctx, [{ ...createAudioEffect('delay'), enabled: false }], irs())).toBeNull();
  });

  it('chainInSeries wires Fase 4 → Fase 5', () => {
    const order: string[] = [];
    const make = (name: string): AudioStackChain => ({
      input: name,
      connect: (dest) => order.push(`${name}→${String(dest)}`),
      dispose: () => order.push(`dispose ${name}`),
    });
    const both = chainInSeries(make('a'), make('b'))!;
    expect(order).toEqual(['a→b']);
    both.connect('track');
    both.dispose();
    expect(order).toEqual(['a→b', 'b→track', 'dispose a', 'dispose b']);
    expect(both.input).toBe('a');
    const single = make('x');
    expect(chainInSeries(null, single)).toBe(single);
    expect(chainInSeries(single, null)).toBe(single);
  });

  it('isFxAudioContext checks every factory', () => {
    expect(isFxAudioContext(new FakeAudioContext())).toBe(true);
    expect(isFxAudioContext({ createGain: () => null })).toBe(false);
    expect(isFxAudioContext(null)).toBe(false);
  });
});

describe('withAudioStack resolver', () => {
  const spec: ClipSourceSpec = { timelineStart: 0, sourceOffset: 0, duration: 1, buffer: bufferOf([tone(440, 0.1)]), volume: 1, fadeIn: 0, fadeOut: 0, rate: 1 };

  it('adds the clip stack after the base chain and follows edits', () => {
    const session = makeF5Session();
    const ctx = new FakeAudioContext();
    const resolve = withAudioStack(null, { getDocument: () => session.document, irs: irs() });
    expect(resolve('c2', spec, ctx)).toBeNull();
    session.run(new AddAudioEffectOperation('c2', 'reverb', {}, { effectId: 'r' }));
    const resolved = resolve('c2', spec, ctx);
    expect(resolved?.chain).toBeTruthy();
    expect(ctx.of('convolver')).toHaveLength(1);
    session.run(new ToggleEffectOperation('c2', 'r', false));
    expect(resolve('c2', spec, ctx)).toBeNull();
  });

  it('keeps base results and composes chains', () => {
    const session = makeF5Session();
    session.run(new AddAudioEffectOperation('c2', 'delay'));
    const disposed: string[] = [];
    const base = vi.fn(() => ({ rateScale: 0.5, chain: { input: 'f4', connect: () => undefined, dispose: () => disposed.push('f4') } }));
    const resolve = withAudioStack(base, { getDocument: () => session.document, irs: irs() });
    const ctx = new FakeAudioContext();
    const resolved = resolve('c2', spec, ctx)!;
    expect(resolved.rateScale).toBe(0.5);
    expect(resolved.chain!.input).toBe('f4');
    resolved.chain!.dispose();
    expect(disposed).toEqual(['f4']);
    // A context without the factories: base result untouched.
    const plain = { currentTime: 0, destination: null as unknown, createGain: () => ctx.createGain(), createAnalyser: () => ctx.createAnalyser(), createBufferSource: () => ctx.createBufferSource() };
    expect(resolve('c2', spec, plain)?.chain?.input).toBe('f4');
  });
});
