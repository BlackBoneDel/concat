// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Channel routing offline and the realtime splitter/merger graph. */

import { describe, expect, it } from 'vitest';
import {
  CHANNEL_MODES,
  applyChannelMode,
  createChannelRouting,
  downmixToMono,
  isChannelMode,
  mergeChannels,
  panStereo,
  splitChannels,
  type RoutingFactory,
} from '../src/media/audio/channel-splitter.ts';
import { bufferOf } from './f4-helpers.ts';

const L = Float32Array.of(1, 1, 1);
const R = Float32Array.of(-1, 0, 0.5);

describe('offline routing', () => {
  it('splits, merges and downmixes', () => {
    const stereo = bufferOf([L, R]);
    const parts = splitChannels(stereo);
    expect(parts).toHaveLength(2);
    expect(Array.from(parts[1]!.getChannelData(0))).toEqual([-1, 0, 0.5]);
    const merged = mergeChannels([parts[0]!, bufferOf([Float32Array.of(2)])]);
    expect(merged.numberOfChannels).toBe(2);
    expect(Array.from(merged.getChannelData(1))).toEqual([2, 0, 0]);
    expect(() => mergeChannels([])).toThrow();
    expect(() => mergeChannels([bufferOf([L], 48000), bufferOf([L], 44100)])).toThrow(/muestreo/);
    expect(Array.from(downmixToMono(stereo))).toEqual([0, 0.5, 0.75]);
  });

  it('applies every channel mode', () => {
    const stereo = bufferOf([L, R]);
    const pick = (mode: (typeof CHANNEL_MODES)[number]) => {
      const out = applyChannelMode(stereo, mode);
      return [Array.from(out.getChannelData(0)), Array.from(out.getChannelData(1))];
    };
    expect(pick('stereo')).toEqual([[1, 1, 1], [-1, 0, 0.5]]);
    expect(pick('mono')).toEqual([[0, 0.5, 0.75], [0, 0.5, 0.75]]);
    expect(pick('left')).toEqual([[1, 1, 1], [1, 1, 1]]);
    expect(pick('right')).toEqual([[-1, 0, 0.5], [-1, 0, 0.5]]);
    expect(pick('swap')).toEqual([[-1, 0, 0.5], [1, 1, 1]]);
    expect(applyChannelMode(bufferOf([L]), 'swap').numberOfChannels).toBe(2);
    expect(isChannelMode('mono')).toBe(true);
    expect(isChannelMode('5.1')).toBe(false);
  });

  it('pans with the equal-power law', () => {
    const mono = bufferOf([Float32Array.of(1)]);
    const centre = panStereo(mono, 0);
    expect(centre.getChannelData(0)[0]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(centre.getChannelData(1)[0]).toBeCloseTo(Math.SQRT1_2, 6);
    const hardLeft = panStereo(mono, -1);
    expect(hardLeft.getChannelData(1)[0]).toBeCloseTo(0, 6);
    const stereo = bufferOf([Float32Array.of(1), Float32Array.of(1)]);
    const right = panStereo(stereo, 1);
    expect(right.getChannelData(0)[0]).toBeCloseTo(0, 6);
    expect(right.getChannelData(1)[0]).toBeCloseTo(2, 6);
    const left = panStereo(stereo, -0.5);
    expect(left.getChannelData(0)[0]).toBeGreaterThan(1);
  });
});

describe('realtime routing', () => {
  it('wires splitter outputs to merger inputs per mode', () => {
    const log: string[] = [];
    let n = 0;
    const node = (name: string) => {
      const label = `${name}${n++}`;
      return {
        label,
        gain: { value: 1 },
        connect: (dest: unknown, output = 0, input = 0) => {
          const target = typeof dest === 'object' && dest !== null && 'label' in dest ? String(dest.label) : '?';
          log.push(`${label}:${output}->${target}:${input}`);
          return dest;
        },
        disconnect: () => log.push(`x${label}`),
      };
    };
    const factory: RoutingFactory = {
      createChannelSplitter: () => node('s'),
      createChannelMerger: () => node('m'),
      createGain: () => node('g'),
    };
    createChannelRouting(factory, 'swap');
    expect(log).toEqual(['s0:0->m1:1', 's0:1->m1:0']);
    log.length = 0;
    const mono = createChannelRouting(factory, 'mono');
    expect(log).toEqual(['s2:0->g4:0', 's2:1->g4:0', 'g4:0->m3:0', 'g4:0->m3:1']);
    mono.dispose();
    expect(log.slice(-3)).toEqual(['xs2', 'xm3', 'xg4']);
    for (const mode of ['stereo', 'left', 'right'] as const) createChannelRouting(factory, mode);
  });
});
