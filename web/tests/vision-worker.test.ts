// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** CPU vision over the worker RPC (and inline without Worker). */

import { describe, expect, it } from 'vitest';
import { emptyClipEffects } from '../src/media/clip-effects.ts';
import { DEFAULT_CHROMA_KEY } from '../src/media/vision/chroma-key.ts';
import { builtinLut, BUILTIN_LUTS } from '../src/media/vision/lut-loader.ts';
import { processPixels } from '../src/media/vision/vision-processor.ts';
import { VisionWorkerClient, createVisionHandlers } from '../src/media/vision/vision-worker.ts';
import { WorkerClient } from '../src/workers/worker-client.ts';
import { linkedWorker, solid } from './f4-helpers.ts';

describe('vision worker', () => {
  it('keys green through the worker exactly like the CPU path', async () => {
    const effects = { ...emptyClipEffects(), chromaKey: { ...DEFAULT_CHROMA_KEY } };
    const expected = new Uint8ClampedArray(solid(4, 4, [0, 255, 0, 255]));
    processPixels(expected, 4, 4, effects, null);
    const { worker } = linkedWorker(createVisionHandlers());
    const client = new VisionWorkerClient(new WorkerClient(() => worker));
    const out = await client.process(new Uint8ClampedArray(solid(4, 4, [0, 255, 0, 255])), 4, 4, effects);
    expect([...out]).toEqual([...expected]);
    expect(out[3]).toBeLessThan(10); // keyed out
  });

  it('applies LUTs inline when no Worker exists and validates input', async () => {
    const lut = BUILTIN_LUTS[0]!;
    const effects = { ...emptyClipEffects(), lut: { id: lut.id, strength: 1 } };
    const client = new VisionWorkerClient(new WorkerClient(() => null));
    const expected = new Uint8ClampedArray(solid(2, 2, [120, 80, 40, 255]));
    processPixels(expected, 2, 2, effects, builtinLut(lut.id) ?? null);
    const out = await client.process(new Uint8ClampedArray(solid(2, 2, [120, 80, 40, 255])), 2, 2, effects, lut);
    expect([...out]).toEqual([...expected]);
    const handlers = createVisionHandlers();
    const tools = { progress: () => undefined, transfer: [] };
    expect(() => handlers['process']!({ pixels: new Uint8ClampedArray(3), width: 1, height: 1 }, tools)).toThrow(RangeError);
    expect(() => handlers['process']!({ pixels: new Uint8ClampedArray(4), width: 1, height: 1, lut: { size: 2, data: new Float32Array(3) } }, tools)).toThrow(RangeError);
  });
});
