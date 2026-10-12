// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Fase 5 components: VU-meter maths and taps, font import into the project. */

import { describe, expect, it } from 'vitest';
import { projectFonts } from '../src/editor/text-operations.ts';
import type { EditOperation } from '../src/editor/operations.ts';
import { FontLoader, type FontFaceLike, type FontLoaderEnv } from '../src/render/font-loader.ts';
import { FontStore, MemoryFontFiles } from '../src/storage/font-store.ts';
import {
  CLIP_HOLD_MS,
  ChannelMeter,
  PEAK_HOLD_MS,
  StereoTap,
  VU_MIN_DB,
  blockPeak,
  dbToFraction,
  isMeterContext,
  toDbfs,
} from '../src/ui/components/vu-meter-stereo.ts';
import { importFontFiles } from '../src/ui/components/font-manager-modal.ts';
import { FakeAudioContext, FakeNode, makeF5Session } from './f5-helpers.ts';

describe('VU meter maths', () => {
  it('converts amplitude to dBFS with a −60 dB floor', () => {
    expect(toDbfs(1)).toBeCloseTo(0);
    expect(toDbfs(0.5)).toBeCloseTo(-6.0206, 3);
    expect(toDbfs(0)).toBe(VU_MIN_DB);
    expect(toDbfs(Number.NaN)).toBe(VU_MIN_DB);
    expect(toDbfs(1e-9)).toBe(VU_MIN_DB);
    expect(toDbfs(2)).toBeGreaterThan(0);
  });

  it('maps dB to bar fill and finds block peaks', () => {
    expect(dbToFraction(VU_MIN_DB)).toBe(0);
    expect(dbToFraction(0)).toBe(1);
    expect(dbToFraction(-30)).toBeCloseTo(0.5);
    expect(dbToFraction(6)).toBe(1);
    expect(blockPeak([0.1, -0.7, 0.3])).toBeCloseTo(0.7);
    expect(blockPeak([])).toBe(0);
  });
});

describe('ChannelMeter ballistics', () => {
  it('attacks instantly and releases linearly', () => {
    const meter = new ChannelMeter();
    expect(meter.feed(0.5, 0).level).toBeCloseTo(-6.02, 1);
    const after = meter.feed(0, 500);
    expect(after.level).toBeCloseTo(-6.02 - 12, 1);
    expect(meter.process(new Float32Array([0, 0.9, -0.2]), 510).level).toBeCloseTo(toDbfs(0.9));
  });

  it('holds the peak for 1.5 s, then lets it fall', () => {
    const meter = new ChannelMeter();
    meter.feed(0.5, 0);
    expect(meter.feed(0.01, PEAK_HOLD_MS - 100).peak).toBeCloseTo(-6.02, 1);
    const falling = meter.feed(0.01, PEAK_HOLD_MS + 500);
    expect(falling.peak).toBeLessThan(-6.03);
    expect(falling.peak).toBeGreaterThanOrEqual(falling.level);
  });

  it('latches the clip LED for 2 s after a 0 dBFS sample, and resets on demand', () => {
    const meter = new ChannelMeter();
    expect(meter.feed(0.99, 0).clipping).toBe(false);
    expect(meter.feed(1, 100).clipping).toBe(true);
    expect(meter.feed(0.1, 100 + CLIP_HOLD_MS - 1).clipping).toBe(true);
    expect(meter.feed(0.1, 100 + CLIP_HOLD_MS + 1).clipping).toBe(false);
    meter.feed(1.2, 5000);
    meter.resetClip();
    expect(meter.reading(5001).clipping).toBe(false);
  });
});

describe('StereoTap', () => {
  it('splits the master into L/R analysers and reads both', () => {
    const context = new FakeAudioContext();
    expect(isMeterContext(context)).toBe(true);
    expect(isMeterContext({ createAnalyser: () => null })).toBe(false);
    expect(isMeterContext(null)).toBe(false);
    const master = new FakeNode('gain');
    const tap = new StereoTap(master, context, 256);
    const [splitter] = context.of('splitter');
    const [left, right] = context.of('analyser');
    expect(master.connections).toContain(splitter);
    expect(splitter!.connections).toEqual([[left, 0], [right, 1]]);
    expect(left!.fftSize).toBe(256);
    left!.samples = new Float32Array([0.25, -0.5]);
    right!.samples = new Float32Array([1]);
    const [l, r] = tap.read();
    expect(blockPeak(l)).toBeCloseTo(0.5);
    expect(blockPeak(r)).toBe(1);
    tap.dispose();
    expect(splitter!.disconnected).toBe(1);
    expect(left!.disconnected).toBe(1);
  });
});

/** A FontFace double: loads unless the family contains "bad". */
function fakeFontEnv(): FontLoaderEnv & { added: FontFaceLike[] } {
  const added: FontFaceLike[] = [];
  return {
    added,
    createFace: (family) => {
      const face: FontFaceLike = {
        family,
        load: () => (family.includes('bad') ? Promise.reject(new Error('corrupt')) : Promise.resolve(face)),
      };
      return face;
    },
    fonts: { add: (face) => added.push(face), delete: () => true },
  };
}

const TTF_MAGIC = new Uint8Array([0x00, 0x01, 0x00, 0x00, 1, 2, 3, 4]);

describe('importFontFiles', () => {
  it('stores fonts, adds them to the project (undoable) and registers the faces', async () => {
    const session = makeF5Session();
    let n = 0;
    const store = new FontStore(new MemoryFontFiles(), () => `font${(n += 1)}`);
    const env = fakeFontEnv();
    const loader = new FontLoader(store, env);
    const errors: unknown[] = [];
    const added = await importFontFiles(
      [new File([TTF_MAGIC], 'Mi Fuente.ttf'), new File(['not a font'], 'nota.ttf'), new File([TTF_MAGIC], 'bad.ttf')],
      { run: (op: EditOperation) => session.run(op), store, loader, onError: (error) => errors.push(error) },
    );
    expect(added.map((font) => font.fileName)).toEqual(['Mi Fuente.ttf', 'bad.ttf']);
    expect(projectFonts(session.document).map((font) => font.id)).toEqual(['font1', 'font2']);
    expect(projectFonts(session.document)[0]!.path).toBe('/fonts/font1.ttf');
    expect(loader.isLoaded('font1')).toBe(true);
    expect(env.added).toHaveLength(1);
    // One bad file (magic bytes) + one face the browser rejected.
    expect(errors).toHaveLength(2);
    session.undo();
    expect(projectFonts(session.document).map((font) => font.id)).toEqual(['font1']);
  });

  it('skips the font when the edit is rejected', async () => {
    const store = new FontStore(new MemoryFontFiles(), () => 'x');
    const loader = new FontLoader(store, fakeFontEnv());
    const added = await importFontFiles([new File([TTF_MAGIC], 'a.ttf')], { run: () => false, store, loader, onError: () => undefined });
    expect(added).toEqual([]);
    expect(loader.isLoaded('x')).toBe(false);
  });
});
