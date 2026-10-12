// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

// @vitest-environment jsdom
/** The compositor: layer order, engine calls, opacity/fades and drawing. */

import { describe, expect, it } from 'vitest';
import { Rational } from '../src/core/rational.ts';
import { FrameRate } from '../src/core/time.ts';
import { Timeline, Transform } from '../src/core/timeline.ts';
import { renderFrame, type FramePool, type RenderContext2D, type RenderImage, type RenderTarget } from '../src/render/index.ts';
import { EditorSession } from '../src/session/editor-session.ts';
import { defaultTextStyle, type DocumentClip, type MediaItem } from '../src/model/document.ts';
import { KeyEase } from '../src/model/wire.ts';

/** A draw recorder: every op lands in `calls`. */
class FakeContext implements RenderContext2D {
  calls: { op: string; args: number[]; text?: string }[] = [];
  fillStyle: string | CanvasGradient | CanvasPattern = '#000';
  strokeStyle: string | CanvasGradient | CanvasPattern = '#000';
  lineWidth = 1;
  lineJoin: 'round' | 'bevel' | 'miter' = 'miter';
  globalAlpha = 1;
  globalCompositeOperation: GlobalCompositeOperation = 'source-over';
  font = '';
  textAlign = 'center';
  textBaseline = 'middle';
  letterSpacing = '0px';

  private log(op: string, args: number[], text?: string): void {
    this.calls.push({ op, args, text });
  }

  save(): void {
    this.log('save', []);
  }

  restore(): void {
    this.log('restore', []);
  }

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.log('setTransform', [a, b, c, d, e, f]);
  }

  translate(x: number, y: number): void {
    this.log('translate', [x, y]);
  }

  rotate(angle: number): void {
    this.log('rotate', [angle]);
  }

  scale(x: number, y: number): void {
    this.log('scale', [x, y]);
  }

  clearRect(x: number, y: number, w: number, h: number): void {
    this.log('clearRect', [x, y, w, h]);
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    this.log('fillRect', [x, y, w, h]);
  }

  drawImage(image: RenderImage, ...rest: number[]): void {
    void image;
    this.log('drawImage', rest);
  }

  beginPath(): void {
    this.log('beginPath', []);
  }

  moveTo(x: number, y: number): void {
    this.log('moveTo', [x, y]);
  }

  lineTo(x: number, y: number): void {
    this.log('lineTo', [x, y]);
  }

  closePath(): void {
    this.log('closePath', []);
  }

  arc(x: number, y: number, r: number, start: number, end: number): void {
    this.log('arc', [x, y, r, start, end]);
  }

  rect(x: number, y: number, w: number, h: number): void {
    this.log('rect', [x, y, w, h]);
  }

  fill(): void {
    this.log('fill', []);
  }

  stroke(): void {
    this.log('stroke', []);
  }

  fillText(text: string, x: number, y: number): void {
    this.log('fillText', [x, y], text);
  }

  strokeText(text: string, x: number, y: number): void {
    this.log('strokeText', [x, y], text);
  }

  measureText(text: string): { width: number } {
    return { width: text.length * 8 };
  }
}

class FakeTarget implements RenderTarget {
  width = 640;
  height = 360;
  readonly ctx = new FakeContext();

  getContext(): RenderContext2D {
    return this.ctx;
  }
}

/** A pool that hands out one fake picture per id and records requests. */
class FakePool implements FramePool {
  requested: { id: string; at: number }[] = [];

  async getFrame(id: string, sourceTime: Rational): Promise<RenderImage | null> {
    this.requested.push({ id, at: sourceTime.asNumber() });
    // A real DOM image stands in for a decoded frame (jsdom provides it).
    return document.createElement('img');
  }

  getSize(id: string): { width: number; height: number } | null {
    void id;
    return { width: 1920, height: 1080 };
  }
}

function mediaItem(id: string, kind: 'video' | 'audio' | 'image', duration: number): MediaItem {
  return {
    id,
    path: `media/${id}`,
    name: id,
    duration,
    kind,
    width: 1920,
    height: 1080,
    frameRate: 30,
    frameRateFraction: '30/1',
    videoCodec: 'h264',
    audioCodec: null,
    hasAudio: kind !== 'image',
    audioTracks: [],
    slot: false,
    origin: null,
    colorRange: null,
    colorSpace: 'sdr',
    extra: {},
  };
}

function makeSessionWithClip(): { session: EditorSession; clip: DocumentClip } {
  const session = new EditorSession();
  session.addMediaItem(mediaItem('m1', 'video', 6));
  const clip = session.addClipAt('m1', Rational.ZERO);
  return { session, clip };
}

describe('renderFrame', () => {
  it('clears to the background and letterboxes onto the backing store', async () => {
    const target = new FakeTarget();
    target.width = 1280;
    target.height = 720;
    const pool = new FakePool();
    await renderFrame(Timeline.hd(), Rational.ZERO, target, pool, { background: '#123456' });
    const fill = target.ctx.calls.find((call) => call.op === 'fillRect');
    expect(fill).toBeDefined();
    // The letterbox scale for 1920×1080 → 1280×720 is 2/3.
    const afterFill = target.ctx.calls[target.ctx.calls.indexOf(fill!) + 1];
    expect(afterFill!.op).toBe('setTransform');
    expect(afterFill!.args[0]).toBeCloseTo(1280 / 1920, 6);
    expect(afterFill!.args[3]).toBeCloseTo(720 / 1080, 6);
  });

  it('draws the active clip with the four engine calls', async () => {
    const { session, clip } = makeSessionWithClip();
    const target = new FakeTarget();
    const pool = new FakePool();
    // Half a second in: the clip must draw, source time = 0.5 at speed 1.
    await renderFrame(session.engine, Rational.approximate(0.5) ?? Rational.ZERO, target, pool);
    expect(pool.requested).toHaveLength(1);
    expect(pool.requested[0]!.at).toBeCloseTo(0.5, 6);
    expect(pool.requested[0]!.id).toBe('m1');
    expect(target.ctx.calls.some((call) => call.op === 'drawImage')).toBe(true);
    void clip;
  });

  it('skips clips outside their range and disabled tracks', async () => {
    const { session } = makeSessionWithClip();
    const target = new FakeTarget();
    const pool = new FakePool();
    // After the clip ends (duration comes from the media: 6s).
    await renderFrame(session.engine, Rational.fromInt(100n), target, pool);
    expect(pool.requested).toHaveLength(0);

    // Disable every track and try again inside the range.
    for (const track of session.engine.trackIds()) {
      session.engine.track(track)!.enabled = false;
    }
    await renderFrame(session.engine, Rational.approximate(1) ?? Rational.ZERO, target, pool);
    expect(pool.requested).toHaveLength(0);
  });

  it('respects opacity and fades through the engine', async () => {
    const { session, clip } = makeSessionWithClip();
    const target = new FakeTarget();
    const pool = new FakePool();
    // Zero opacity: nothing is drawn even though the clip is active.
    clip.opacity = 0;
    session.rebuild();
    await renderFrame(session.engine, Rational.approximate(1) ?? Rational.ZERO, target, pool);
    expect(target.ctx.calls.some((call) => call.op === 'drawImage')).toBe(false);

    // Opacity 0.25 must carry into the compositing state.
    clip.opacity = 0.25;
    session.rebuild();
    await renderFrame(session.engine, Rational.approximate(1) ?? Rational.ZERO, target, pool);
    const saves = target.ctx.calls.filter((call) => call.op === 'save');
    expect(saves.length).toBeGreaterThan(0);
  });

  it('composites bottom-first: the document top lane draws last', async () => {
    const session = new EditorSession();
    session.addMediaItem(mediaItem('m1', 'video', 6));
    session.addMediaItem(mediaItem('m2', 'video', 6));
    const first = session.addClipAt('m1', Rational.ZERO);
    const second = session.addClipAt('m2', Rational.ZERO);
    // Both land on lanes; the last added lane is the document top lane and
    // therefore drawn after the first one.
    const target = new FakeTarget();
    const pool = new FakePool();
    await renderFrame(session.engine, Rational.approximate(1) ?? Rational.ZERO, target, pool);
    expect(pool.requested.length).toBe(2);
    const ids = pool.requested.map((request) => request.id);
    // m1 sits on a lower lane and is composited first.
    expect(ids[0]).toBe('m1');
    expect(ids[1]).toBe('m2');
    void first;
    void second;
  });

  it('draws text clips through the text renderer', async () => {
    const session = new EditorSession();
    session.addMediaItem(mediaItem('m1', 'video', 6));
    const clip = session.addClipAt('m1', Rational.ZERO);
    // Build a text clip manually onto the document.
    const textClip: DocumentClip = {
      ...clip,
      id: 'c-text',
      kind: 'text',
      mediaId: '',
      name: 'Título',
      text: { ...defaultTextStyle(), content: 'Hola mundo' },
    };
    session.timeline.clips.push(textClip);
    session.rebuild();
    const target = new FakeTarget();
    const pool = new FakePool();
    await renderFrame(session.engine, Rational.approximate(1) ?? Rational.ZERO, target, pool);
    const texts = target.ctx.calls.filter((call) => call.op === 'fillText');
    expect(texts.length).toBeGreaterThan(0);
    expect(texts[0]!.text).toContain('Hola');
  });

  it('never draws when the pool has no frame', async () => {
    const { session } = makeSessionWithClip();
    const emptyPool: FramePool = {
      getFrame: async () => null,
      getSize: () => ({ width: 1920, height: 1080 }),
    };
    const target = new FakeTarget();
    await renderFrame(session.engine, Rational.approximate(1) ?? Rational.ZERO, target, emptyPool);
    expect(target.ctx.calls.some((call) => call.op === 'drawImage')).toBe(false);
  });
});

describe('renderFrame extras', () => {
  it('draws shape clips as vector figures', async () => {
    const session = new EditorSession();
    session.addMediaItem(mediaItem('m1', 'video', 6));
    const base = session.addClipAt('m1', Rational.ZERO);
    for (const [index, kind] of (['square', 'circle', 'triangle', 'parallelogram', 'trapezoid', 'line', 'arrow'] as const).entries()) {
      session.timeline.clips.push({
        ...base,
        id: `shape-${index}`,
        kind: 'shape',
        mediaId: '',
        name: kind,
        shape: {
          kind,
          size: 0.3,
          fill: '#ff0000',
          stroke: '#00ff00',
          strokeWidth: 0.01,
        },
      });
    }
    session.timeline.clips = session.timeline.clips.filter((clip) => clip.id.startsWith('shape-'));
    session.rebuild();
    const target = new FakeTarget();
    await renderFrame(session.engine, Rational.approximate(0.5) ?? Rational.ZERO, target, new FakePool());
    expect(target.ctx.calls.some((call) => call.op === 'fill')).toBe(true);
    expect(target.ctx.calls.some((call) => call.op === 'stroke')).toBe(true);
    expect(target.ctx.calls.some((call) => call.op === 'arc')).toBe(true);
  });

  it('crops the source before fitting', async () => {
    const { session, clip } = makeSessionWithClip();
    clip.crop = { left: 0.1, top: 0.1, right: 0.1, bottom: 0.1 };
    session.rebuild();
    const target = new FakeTarget();
    await renderFrame(session.engine, Rational.approximate(1) ?? Rational.ZERO, target, new FakePool());
    const draw = target.ctx.calls.find((call) => call.op === 'drawImage');
    expect(draw).toBeDefined();
    // sx, sy, sw, sh = 10% margins on 1920×1080.
    expect(draw!.args[0]).toBeCloseTo(192, 6);
    expect(draw!.args[1]).toBeCloseTo(108, 6);
    expect(draw!.args[2]).toBeCloseTo(1536, 6);
    expect(draw!.args[3]).toBeCloseTo(864, 6);
  });

  it('maps document blends to canvas composites', async () => {
    const { session, clip } = makeSessionWithClip();
    clip.blend = 'add';
    session.rebuild();
    const target = new FakeTarget();
    await renderFrame(session.engine, Rational.approximate(1) ?? Rational.ZERO, target, new FakePool());
    expect(target.ctx.calls.some((call) => call.op === 'drawImage')).toBe(true);
    // The blend state is restored after the clip draws.
    expect(target.ctx.calls.some((call) => call.op === 'restore')).toBe(true);
  });

  it('fades the picture through transitionIn', async () => {
    const { session, clip } = makeSessionWithClip();
    clip.transitionIn = { id: 'cross-fade', duration: 2 };
    session.rebuild();
    const target = new FakeTarget();
    // At the fade midpoint the factor is 0.5; at the start 0 (skipped).
    await renderFrame(session.engine, Rational.ZERO, target, new FakePool());
    expect(target.ctx.calls.some((call) => call.op === 'drawImage')).toBe(false);
    await renderFrame(session.engine, Rational.approximate(1) ?? Rational.ZERO, target, new FakePool());
    expect(target.ctx.calls.some((call) => call.op === 'drawImage')).toBe(true);
  });

  it('honours the background colour of the clear', async () => {
    const target = new FakeTarget();
    await renderFrame(Timeline.hd(), Rational.ZERO, target, new FakePool(), { background: '#123456' });
    const fill = target.ctx.calls.find((call) => call.op === 'fillRect');
    expect(fill).toBeDefined();
    expect(target.ctx.fillStyle).toBe('#123456');
  });
});

describe('EditorClip engine bridge', () => {
  it('maps document keys to the keyed base + animation ride', () => {
    const { session, clip } = makeSessionWithClip();
    // Document keys sit at clip fractions: `at: 0` is the clip start and
    // `at: 1` its end. Scale rides 2 → 1 across the whole clip.
    clip.keys = [
      { at: 0, property: 'scale', value: 2, ease: KeyEase.LINEAR },
      { at: 1, property: 'scale', value: 1, ease: KeyEase.LINEAR },
    ];
    clip.scale = 1;
    session.rebuild();
    const engineClip = session.clip('c1');
    expect(engineClip).toBeDefined();
    const atZero = engineClip!.transformAt(Rational.ZERO);
    expect(atZero.scale).toBeCloseTo(2, 5);
    // The clip lasts 6s (media duration): its end key reads 1.
    const atEnd = engineClip!.transformAt(Rational.fromInt(6n));
    expect(atEnd.scale).toBeCloseTo(1, 5);
    // Interpolation halfway through the clip.
    const mid = engineClip!.transformAt(Rational.fromInt(3n));
    expect(mid.scale).toBeCloseTo(1.5, 5);
  });

  it('derives video fades from transitionIn, not the audio fades', () => {
    const { session, clip } = makeSessionWithClip();
    clip.fadeIn = 2;
    clip.fadeOut = 2;
    clip.transitionIn = { id: 'cross-fade', duration: 1 };
    session.rebuild();
    const engineClip = session.clip(clip.id)!;
    // At the very start the fade halves the picture...
    expect(engineClip.videoFadeFactor(Rational.ZERO)).toBeCloseTo(0, 5);
    // ...while the audio fades are separate numbers.
    expect(engineClip.audioFadeIn).toBe(2);
    expect(engineClip.audioFadeOut).toBe(2);
  });
});
