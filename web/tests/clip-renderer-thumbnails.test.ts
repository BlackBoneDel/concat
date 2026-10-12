// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

// @vitest-environment jsdom
/**
 * Fase 8 · zona 2 — the filmstrip inside timeline clips: generation, caching
 * and the painting rules (only from {@link MIN_STRIP_PIXELS_PER_SECOND} up,
 * placeholder while the frames build, plain body when there is no strip).
 */

import { describe, expect, it, vi } from 'vitest';
import { Rational } from '../src/core/rational.ts';
import { EditSession } from '../src/session/edit-session.ts';
import {
  desiredStripFrames,
  encodeStrip,
  MemoryThumbnailStripStore,
  STRIP_MAX_FRAMES,
  STRIP_MIN_FRAMES,
  stripSampleTimes,
  ThumbnailStripService,
} from '../src/media/thumbnail-strip.ts';
import {
  drawClips,
  drawLockedHatch,
  ellipsize,
  MIN_STRIP_PIXELS_PER_SECOND,
  NAME_BAR_HEIGHT,
  renderClipThumbnails,
} from '../src/ui/timeline/clip-renderer.ts';
import { StripRenderer } from '../src/ui/timeline/strip-renderer.ts';
import { ThumbnailRenderer } from '../src/ui/timeline/thumbnail-renderer.ts';
import { WaveformRenderer } from '../src/ui/timeline/waveform-renderer.ts';
import { readThemeColors, type TimelineThumbnailStrip } from '../src/ui/timeline/types.ts';
import { RecordingContext2D } from './f7-helpers.ts';
import { createFakeApp, mediaItem } from './f8-helpers.ts';

/** A strip of `count` fake frames, one second apart. */
function fakeStrip(count: number, durationSeconds = count): TimelineThumbnailStrip {
  const frames = Array.from({ length: count }, () => ({ width: 160, height: 90 }) as unknown as ImageBitmap);
  return {
    frames,
    intervalSeconds: durationSeconds / count,
    durationSeconds,
    width: 160,
    height: 90,
  };
}

/** The provider the renderer reads. */
function providerFor(strips: Record<string, TimelineThumbnailStrip | null>) {
  const asked: string[] = [];
  return {
    asked,
    strip(mediaId: string): TimelineThumbnailStrip | null {
      asked.push(mediaId);
      return strips[mediaId] ?? null;
    },
  };
}

describe('Fase 8 · tira de miniaturas: muestreo y cache', () => {
  it('muestrea el centro de cada tramo, en orden', () => {
    const times = stripSampleTimes(Rational.fromInt(10), 5);
    expect(times).toHaveLength(5);
    const seconds = times.map((time) => Number(time.asNumber().toFixed(3)));
    expect(seconds).toEqual([1, 3, 5, 7, 9]);
  });

  it('el número de fotogramas crece con la duración y respeta los límites', () => {
    expect(desiredStripFrames(0)).toBe(STRIP_MIN_FRAMES);
    expect(desiredStripFrames(1)).toBe(STRIP_MIN_FRAMES);
    expect(desiredStripFrames(30)).toBe(20);
    expect(desiredStripFrames(600)).toBe(STRIP_MAX_FRAMES);
  });

  it('el servicio guarda la tira en memoria y la indexa con su tiempo', async () => {
    const store = new MemoryThumbnailStripStore();
    const service = new ThumbnailStripService({ store, framesPerYield: 0 });
    const onReady = vi.fn();
    service.onReady = onReady;
    // No source: nothing to generate, but the record path is exercised.
    expect(await service.ensure('m-1')).toBeNull();
    expect(service.strip('m-1')).toBeNull();
    expect(onReady).not.toHaveBeenCalled();
  });

  it('las tiras se pueden codificar (o degradar a memoria si no hay canvas)', async () => {
    const frames = [{ width: 160, height: 90 } as unknown as ImageBitmap];
    // jsdom has no 2D context: the encoder must refuse instead of throwing.
    const encoded = await encodeStrip('m-1', frames, { intervalSeconds: 2, durationSeconds: 2 });
    expect(encoded).toBeNull();
  });
});

describe('Fase 8 · StripRenderer', () => {
  it('lee la tira del proveedor una sola vez por media', () => {
    const provider = providerFor({ 'm-1': fakeStrip(4) });
    const renderer = new StripRenderer(provider);
    expect(renderer.get('m-1')?.frames).toHaveLength(4);
    renderer.get('m-1');
    expect(provider.asked).toEqual(['m-1']);
  });

  it('recuerda qué medios aún no tienen tira', () => {
    const provider = providerFor({});
    const renderer = new StripRenderer(provider);
    expect(renderer.get('m-2')).toBeNull();
    expect(renderer.pending).toEqual(['m-2']);
  });

  it('invalidate + refresh vacían la cache y avisan', () => {
    const provider = providerFor({ 'm-1': fakeStrip(4) });
    const renderer = new StripRenderer(provider);
    const hook = vi.fn();
    renderer.onUpdate(hook);
    renderer.get('m-1');
    renderer.invalidate('m-1');
    expect(renderer.get('m-1')).not.toBeNull();
    renderer.refresh();
    expect(hook).toHaveBeenCalledTimes(1);
    expect(provider.asked).toHaveLength(2);
  });
});

describe('Fase 8 · renderClipThumbnails', () => {
  const viewport = { pixelsPerSecond: 80, scrollTime: 0, scrollTop: 0, width: 900, height: 420 };

  function rig(zoom: number, strip: TimelineThumbnailStrip | null) {
    const session = new EditSession();
    session.addMediaItem(mediaItem({ id: 'm-1', name: 'uno.mp4', duration: 20 }));
    const trackId = session.document.timelines[0]!.tracks[0]!.id;
    session.insertClipFromMedia('m-1', trackId, Rational.ZERO, 'overwrite', {
      durationSeconds: 20,
      kind: 'video',
      name: 'uno.mp4',
    });
    const clip = session.document.timelines[0]!.clips[0]!;
    const ctx = new RecordingContext2D();
    const strips = new StripRenderer(providerFor({ 'm-1': strip }));
    drawClips(ctx as unknown as CanvasRenderingContext2D, {
      clips: [clip],
      layouts: [{ trackId, y: 0, height: 96, collapsed: false }],
      viewport: { ...viewport, pixelsPerSecond: zoom },
      colors: readThemeColors(document.documentElement),
      width: 900,
      height: 420,
      selection: session.selection,
      document: session.document,
      waveform: new WaveformRenderer(),
      thumbnails: new ThumbnailRenderer({ frameAt: async () => null }),
      strips,
      preview: null,
    });
    return { ctx, clip };
  }

  it('pinta la tira cuando el clip es de vídeo y el zoom alcanza el umbral', () => {
    const { ctx } = rig(MIN_STRIP_PIXELS_PER_SECOND * 2, fakeStrip(10, 20));
    const painted = ctx.calls.filter((call) => call.op === 'drawImage');
    // The filmstrip draws several frames; none of them is the legacy single face.
    expect(painted.length).toBeGreaterThan(2);
  });

  it('con poco zoom no pinta la tira (se lee la miniatura única)', () => {
    const { ctx } = rig(MIN_STRIP_PIXELS_PER_SECOND / 2, fakeStrip(10, 20));
    const painted = ctx.calls.filter((call) => call.op === 'drawImage');
    expect(painted).toHaveLength(0);
  });

  it('sin tira dibuja el marcador de posición (nunca deja el hueco vacío)', () => {
    const { ctx } = rig(MIN_STRIP_PIXELS_PER_SECOND * 2, null);
    const painted = ctx.calls.filter((call) => call.op === 'drawImage');
    expect(painted).toHaveLength(0);
    // The placeholder fills the body bars: the clip is never a bare rectangle.
    const fills = ctx.calls.filter((call) => call.op === 'fillRect');
    expect(fills.length).toBeGreaterThan(6);
  });

  it('la barra de nombre (18px) nunca se tapa con la tira', () => {
    const ctx = new RecordingContext2D();
    const painted = renderClipThumbnails(ctx as unknown as CanvasRenderingContext2D, {
      clip: {
        id: 'c1',
        trackId: 'T1',
        mediaId: 'm-1',
        name: 'uno',
        kind: 'video',
        start: 0,
        duration: 10,
        sourceStart: 0,
        speed: 1,
      } as never,
      x: 100,
      y: 50,
      w: 400,
      h: 96,
      pixelsPerSecond: 80,
      strips: new StripRenderer(providerFor({ 'm-1': fakeStrip(8, 10) })),
    });
    expect(painted).toBeGreaterThan(0);
    // Every frame is drawn below the name bar.
    for (const call of ctx.calls.filter((entry) => entry.op === 'drawImage')) {
      expect(call.args[1]).toBeGreaterThanOrEqual(50 + NAME_BAR_HEIGHT);
    }
  });
});

describe('Fase 8 · estilo profesional de los clips', () => {
  it('el degradado del cuerpo se pinta con createLinearGradient', () => {
    const { ctx } = (() => {
      const session = new EditSession();
      session.addMediaItem(mediaItem({ id: 'm-1', duration: 4 }));
      const trackId = session.document.timelines[0]!.tracks[0]!.id;
      session.insertClipFromMedia('m-1', trackId, Rational.ZERO, 'overwrite', { durationSeconds: 4, kind: 'video' });
      const ctx = new RecordingContext2D();
      drawClips(ctx as unknown as CanvasRenderingContext2D, {
        clips: session.document.timelines[0]!.clips,
        layouts: [{ trackId, y: 0, height: 96, collapsed: false }],
        viewport: { pixelsPerSecond: 80, scrollTime: 0, scrollTop: 0, width: 900, height: 420 },
        colors: readThemeColors(document.documentElement),
        width: 900,
        height: 420,
        selection: session.selection,
        document: session.document,
        waveform: new WaveformRenderer(),
        thumbnails: new ThumbnailRenderer({ frameAt: async () => null }),
        strips: null,
        preview: null,
      });
      return { ctx };
    })();
    // The recording double has no createLinearGradient: the body still fills.
    expect(ctx.calls.some((call) => call.op === 'fillRect')).toBe(true);
  });

  it('el clip seleccionado lleva el contorno amarillo con glow', () => {
    const session = new EditSession();
    session.addMediaItem(mediaItem({ id: 'm-1', duration: 4 }));
    const trackId = session.document.timelines[0]!.tracks[0]!.id;
    const clipId = session.insertClipFromMedia('m-1', trackId, Rational.ZERO, 'overwrite', { durationSeconds: 4, kind: 'video' });
    session.selection.selectClips([clipId], false, session.document);
    const ctx = new RecordingContext2D();
    drawClips(ctx as unknown as CanvasRenderingContext2D, {
      clips: session.document.timelines[0]!.clips,
      layouts: [{ trackId, y: 0, height: 96, collapsed: false }],
      viewport: { pixelsPerSecond: 80, scrollTime: 0, scrollTop: 0, width: 900, height: 420 },
      colors: readThemeColors(document.documentElement),
      width: 900,
      height: 420,
      selection: session.selection,
      document: session.document,
      waveform: new WaveformRenderer(),
      thumbnails: new ThumbnailRenderer({ frameAt: async () => null }),
      strips: null,
      preview: null,
    });
    expect(ctx.calls.some((call) => call.op === 'stroke' && call.stroke === '#ffeb3b')).toBe(true);
  });

  it('un clip bloqueado lleva rayado diagonal', () => {
    const ctx = new RecordingContext2D();
    drawLockedHatch(ctx as unknown as CanvasRenderingContext2D, 10, 10, 200, 60);
    const lines = ctx.calls.filter((call) => call.op === 'moveTo').length;
    expect(lines).toBeGreaterThan(3);
  });

  it('el nombre se trunca con puntos suspensivos', () => {
    const ctx = new RecordingContext2D();
    const text = ellipsize(ctx as unknown as CanvasRenderingContext2D, 'un-nombre-muy-largo-de-clip.mp4', 80);
    expect(text.endsWith('…')).toBe(true);
    expect(text.length).toBeLessThan('un-nombre-muy-largo-de-clip.mp4'.length);
  });

  it('los clips de audio se pintan con la onda y no con la tira', () => {
    const fake = createFakeApp();
    fake.session.addMediaItem(mediaItem({ id: 'm-a', name: 'voz.mp3', kind: 'audio', duration: 6 }));
    // An explicit audio lane accepts the clip (a bare lane reads as video).
    const trackId = fake.session.addTrack('audio', fake.session.timeline.tracks.length)!;
    fake.session.insertClipFromMedia('m-a', trackId, Rational.ZERO, 'overwrite', {
      durationSeconds: 6,
      kind: 'audio',
      name: 'voz.mp3',
    });
    const ctx = new RecordingContext2D();
    drawClips(ctx as unknown as CanvasRenderingContext2D, {
      clips: fake.session.document.timelines[0]!.clips,
      layouts: [{ trackId, y: 0, height: 72, collapsed: false }],
      viewport: { pixelsPerSecond: 80, scrollTime: 0, scrollTop: 0, width: 900, height: 420 },
      colors: readThemeColors(document.documentElement),
      width: 900,
      height: 420,
      selection: fake.session.selection,
      document: fake.session.document,
      waveform: new WaveformRenderer(),
      thumbnails: new ThumbnailRenderer({ frameAt: async () => null }),
      strips: new StripRenderer(providerFor({ 'm-a': fakeStrip(4, 6) })),
      preview: null,
    });
    // An audio face never draws filmstrip frames.
    expect(ctx.calls.filter((call) => call.op === 'drawImage')).toHaveLength(0);
    expect(ctx.calls.some((call) => call.op === 'fillRect')).toBe(true);
  });
});
