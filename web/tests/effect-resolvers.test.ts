// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** clip.extra.effects → vision pipeline and mixer resolvers. */

import { describe, expect, it, vi } from 'vitest';
import { EffectsCache, createAudioFxResolver, createVisionResolver, findDocClip } from '../src/app/effect-resolvers.ts';
import { updateClipEffects } from '../src/editor/effect-operations.ts';
import { defaultAudioEffects } from '../src/media/audio/audio-effects.ts';
import { AudioProcessor } from '../src/media/audio/audio-processor.ts';
import { DEFAULT_CHROMA_KEY } from '../src/media/vision/chroma-key.ts';
import type { AudioGraphContext, ClipSourceSpec } from '../src/player/audio-mixer.ts';
import { WorkerClient } from '../src/workers/worker-client.ts';
import { bufferOf, tone } from './f4-helpers.ts';
import { makeSession } from './f3-helpers.ts';

const noContext = {} as AudioGraphContext;

function spec(partial: Partial<ClipSourceSpec> = {}): ClipSourceSpec {
  return { timelineStart: 0, sourceOffset: 0, duration: 1, buffer: bufferOf([tone(440, 0.5)]), volume: 1, fadeIn: 0, fadeOut: 0, rate: 1, ...partial };
}

describe('vision resolver', () => {
  it('resolves by docId with an identity cache', () => {
    const session = makeSession([{ start: 0, duration: 2 }]);
    const cache = new EffectsCache();
    const resolve = createVisionResolver(() => session.document, cache);
    expect(resolve({ docId: 'c1' })).toBeNull();
    expect(resolve({})).toBeNull();
    session.run(updateClipEffects(session.document, 'c1', (fx) => { fx.chromaKey = { ...DEFAULT_CHROMA_KEY }; }));
    const first = resolve({ docId: 'c1' });
    expect(first?.chromaKey?.enabled).toBe(true);
    expect(resolve({ docId: 'c1' })).toBe(first);
    expect(findDocClip(session.document, 'nope')).toBeNull();
  });
});

describe('audio fx resolver', () => {
  it('returns null without effects and builds curves, variants and loudness gain', async () => {
    const session = makeSession([{ start: 0, duration: 2, kind: 'audio' }]);
    const processor = new AudioProcessor({ client: new WorkerClient(() => null) });
    const onMeasured = vi.fn();
    const resolve = createAudioFxResolver({ processor, getDocument: () => session.document, onMeasured });
    expect(resolve('c1', spec(), noContext)).toBeNull();

    session.run(updateClipEffects(session.document, 'c1', (fx) => {
      fx.audio = { ...defaultAudioEffects(), semitones: 12, fadeInCurve: 'sCurve', normalize: { mode: 'loudness', target: -23, truePeakCeiling: -1, gainDb: null } };
    }));
    const s = spec({ fadeIn: 0.2 });
    const first = resolve('c1', s, noContext);
    expect(first?.fadeInCurve?.length).toBe(128);
    expect(first?.fadeInCurve?.[0]).toBe(0);
    expect(first?.buffer).toBeUndefined(); // variant renders in the background
    await vi.waitFor(() => expect(onMeasured).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(resolve('c1', s, noContext)?.buffer).toBeDefined());
    expect(resolve('c1', s, noContext)?.chain ?? null).toBeNull(); // plain context: no nodes
  });

  it('pre-stretches when pitch is preserved and rescales rate/offset', async () => {
    const session = makeSession([{ start: 0, duration: 2, kind: 'audio' }]);
    const processor = new AudioProcessor({ client: new WorkerClient(() => null) });
    const resolve = createAudioFxResolver({ processor, getDocument: () => session.document });
    session.run(updateClipEffects(session.document, 'c1', (fx) => { fx.audio = { ...defaultAudioEffects(), preservePitch: true }; }));
    const s = spec({ rate: 2 });
    resolve('c1', s, noContext);
    await vi.waitFor(() => expect(resolve('c1', s, noContext)?.rateScale).toBeCloseTo(0.5));
    expect(resolve('c1', s, noContext)?.offsetScale).toBeCloseTo(0.5);
  });
});
