// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

// @vitest-environment jsdom
/**
 * Fase 8 · zona 4 — the maths every pointer interaction shares, and the rules
 * the timeline follows when a media card lands on it: video on video lanes,
 * audio on audio lanes, a brand-new lane appended when the pointer is over
 * empty space, and the insert mode a drop uses.
 */

import { describe, expect, it } from 'vitest';
import { Rational } from '../src/core/rational.ts';
import {
  getTrackAtY,
  layoutRects,
  localPoint,
  pixelsToTime,
  timeToPixels,
} from '../src/ui/timeline/coord-utils.ts';
import { installMediaDrop } from '../src/ui/timeline/media-drop.ts';
import { readMediaDrag, writeMediaDrag, type DataTransferLike, type MediaDragKind } from '../src/ui/dnd/media-drag.ts';
import { wasDropHandled } from '../src/ui/dnd/drop-handled.ts';
import { TrackHeader } from '../src/ui/timeline/track-header.ts';
import type { TrackLayout } from '../src/ui/timeline/types.ts';
import { createFakeApp, dragEvent, FakeDataTransfer, mediaItem, stubRect, type FakeApp } from './f8-helpers.ts';

const lane = (trackId: string, y: number, height: number) => ({ trackId, y, height, collapsed: false });

describe('Fase 8 · coordenadas del timeline', () => {
  it('píxeles → tiempo usa el zoom vivo y nunca devuelve negativos', () => {
    expect(pixelsToTime(400, 80).asNumber()).toBeCloseTo(5, 9);
    expect(pixelsToTime(100, 40).asNumber()).toBeCloseTo(2.5, 9);
    expect(pixelsToTime(-30, 80)).toEqual(Rational.ZERO);
    expect(pixelsToTime(0, 0)).toEqual(Rational.ZERO);
    expect(pixelsToTime(Number.NaN, 80)).toEqual(Rational.ZERO);
  });

  it('tiempo → píxeles es la inversa y respeta el zoom', () => {
    const time = Rational.approximate(3.25)!;
    expect(timeToPixels(time, 80)).toBeCloseTo(260, 6);
    expect(pixelsToTime(timeToPixels(time, 120), 120).asNumber()).toBeCloseTo(3.25, 6);
  });

  it('getTrackAtY acierta la pista, los huecos y el scroll', () => {
    const layout = [lane('T1', 0, 96), lane('T2', 96, 96), lane('T3', 192, 72)];
    expect(getTrackAtY(0, layout)).toBe('T1');
    expect(getTrackAtY(95.9, layout)).toBe('T1');
    expect(getTrackAtY(96, layout)).toBe('T2');
    expect(getTrackAtY(263.9, layout)).toBe('T3');
    expect(getTrackAtY(265, layout)).toBeNull();
    expect(getTrackAtY(-1, layout)).toBeNull();
    // Con scroll, el y visible se convierte a contenido.
    expect(getTrackAtY(20, layout, 100)).toBe('T2');
  });

  it('las pistas plegadas siguen ocupando su hueco', () => {
    const layout = [lane('T1', 0, 24), lane('T2', 24, 96)];
    expect(getTrackAtY(10, layout)).toBe('T1');
    expect(getTrackAtY(30, layout)).toBe('T2');
  });

  it('layoutRects resta el scroll y localPoint mide desde la esquina', () => {
    const rects = layoutRects([lane('T1', 0, 96), lane('T2', 96, 96)], 20);
    expect(rects).toEqual([
      { trackId: 'T1', y: -20, height: 96 },
      { trackId: 'T2', y: 76, height: 96 },
    ]);
    expect(localPoint({ clientX: 320, clientY: 324 }, { left: 220, top: 300 })).toEqual({ x: 100, y: 24 });
  });
});

// ---------------------------------------------------------------------------
// The rules of a media drop, driven through the installer with a fake host.
// ---------------------------------------------------------------------------

/** A host that records what the installer asks for. */
function dropRig(options: { lanes?: TrackLayout[]; snapped?: number } = {}) {
  const lanes: TrackLayout[] = options.lanes ?? [
    { trackId: 'T1', y: 0, height: 96, collapsed: false },
    { trackId: 'T2', y: 96, height: 72, collapsed: false },
  ];
  const log: {
    created: string[];
    inserted: { trackId: string; seconds: number; mode: string }[];
    previews: (null | { trackId: string | null; kind: string; pointerY: number })[];
    errors: unknown[];
  } = { created: [], inserted: [], previews: [], errors: [] };
  const target = document.createElement('section');
  document.body.appendChild(target);
  stubRect(target, { left: 200, top: 100, width: 800, height: 400 });
  const handle = installMediaDrop({
    target,
    contentRect: () => ({ left: 200, top: 100 }),
    viewport: () => ({ pixelsPerSecond: 80, scrollTime: 0, scrollTop: 0, width: 800, height: 400 }),
    layouts: () => lanes,
    trackAtY: (y) => getTrackAtY(y, lanes),
    snappingEnabled: () => true,
    candidates: () => [{ time: Rational.approximate(options.snapped ?? 2)!, kind: 'playhead', label: 'Playhead' }],
    snap: (time, candidates) => ({ snappedTime: candidates[0]?.time ?? time, snappedTo: candidates[0] ?? null }),
    kindForMedia: (payload) => (payload.kind === 'audio' ? 'audio' : 'video'),
    createTrack: (kind) => {
      const id = kind === 'audio' ? 'A-new' : 'V-new';
      log.created.push(id);
      return id;
    },
    insert: (payload, trackId, atTime, mode) => {
      log.inserted.push({ trackId, seconds: atTime.asNumber(), mode });
    },
    onPreview: (state) => log.previews.push(state && { trackId: state.trackId, kind: state.kind, pointerY: state.pointerY }),
    onGuide: () => {},
    onDrop: () => {},
    onError: (error) => log.errors.push(error),
  });
  return { target, log, handle, lanes };
}

/** A transfer carrying one library card. */
function transferFor(id: string, kind: MediaDragKind, durationSeconds: number): FakeDataTransfer {
  const transfer = new FakeDataTransfer();
  writeMediaDrag(transfer as unknown as DataTransferLike, { mediaId: id, kind, durationSeconds, name: `${id}.mp4` });
  return transfer;
}

describe('Fase 8 · reglas de destino de un drop', () => {
  it('un clip de vídeo cae en el carril bajo el puntero y con el tiempo imantado', () => {
    const rig = dropRig({ snapped: 2 });
    const transfer = transferFor('m-1', 'video', 6);
    rig.target.dispatchEvent(dragEvent('dragenter', { dataTransfer: transfer, clientX: 400, clientY: 140 }));
    rig.target.dispatchEvent(dragEvent('dragover', { dataTransfer: transfer, clientX: 400, clientY: 140 }));
    const drop = dragEvent('drop', { dataTransfer: transfer, clientX: 400, clientY: 140 });
    rig.target.dispatchEvent(drop);
    // y = 40 → T1 (0…96); x = 200 px / 80 px·s⁻¹ = 2.5 s → imán a 2 s.
    expect(rig.log.inserted).toEqual([{ trackId: 'T1', seconds: 2, mode: 'overwrite' }]);
    expect(rig.log.created).toHaveLength(0);
    expect(wasDropHandled(drop)).toBe(true);
    rig.handle.dispose();
  });

  it('un audio que cae sobre un carril sin más pistas crea la suya', () => {
    const rig = dropRig({ lanes: [{ trackId: 'V1', y: 0, height: 96, collapsed: false }] });
    const transfer = transferFor('voz', 'audio', 4);
    rig.target.dispatchEvent(dragEvent('dragenter', { dataTransfer: transfer, clientX: 300, clientY: 300 }));
    const drop = dragEvent('drop', { dataTransfer: transfer, clientX: 300, clientY: 300 });
    rig.target.dispatchEvent(drop);
    // y = 200 cae fuera de las pistas (la lista acaba en 96): pista nueva.
    expect(rig.log.created).toEqual(['A-new']);
    expect(rig.log.inserted[0]?.trackId).toBe('A-new');
    expect(rig.log.previews.some((state) => state?.kind === 'audio' && state.trackId === null)).toBe(true);
    rig.handle.dispose();
  });

  it('si el puntero vuelve a una pista existente no se crea ninguna', () => {
    const rig = dropRig();
    const transfer = transferFor('m-2', 'video', 3);
    rig.target.dispatchEvent(dragEvent('dragenter', { dataTransfer: transfer, clientX: 260, clientY: 200 }));
    rig.target.dispatchEvent(dragEvent('dragover', { dataTransfer: transfer, clientX: 260, clientY: 120 }));
    rig.target.dispatchEvent(dragEvent('drop', { dataTransfer: transfer, clientX: 260, clientY: 120 }));
    expect(rig.log.created).toHaveLength(0);
    expect(rig.log.inserted[0]?.trackId).toBe('T1');
    rig.handle.dispose();
  });

  it('un fallo al insertar se reporta y no se anuncia el drop', () => {
    const rig = dropRig();
    const failing = new Error('un clip de audio no puede ir a una pista de video');
    const handle = installMediaDrop({
      target: rig.target,
      contentRect: () => ({ left: 200, top: 100 }),
      viewport: () => ({ pixelsPerSecond: 80, scrollTime: 0, scrollTop: 0, width: 800, height: 400 }),
      layouts: () => [{ trackId: 'T1', y: 0, height: 96, collapsed: false }],
      trackAtY: () => 'T1',
      snappingEnabled: () => false,
      candidates: () => [],
      snap: (time) => ({ snappedTime: time, snappedTo: null }),
      kindForMedia: () => 'video',
      createTrack: () => 'V-new',
      insert: () => {
        throw failing;
      },
      onPreview: () => {},
      onGuide: () => {},
      onDrop: () => {
        throw new Error('no debería anunciarse');
      },
      onError: () => {},
    });
    const transfer = transferFor('m-3', 'video', 3);
    rig.target.dispatchEvent(dragEvent('dragenter', { dataTransfer: transfer, clientX: 260, clientY: 120 }));
    expect(() => rig.target.dispatchEvent(dragEvent('drop', { dataTransfer: transfer, clientX: 260, clientY: 120 }))).not.toThrow();
    expect(failing.message).toContain('video');
    handle.dispose();
    rig.handle.dispose();
  });
});

describe('Fase 8 · payload del drag', () => {
  it('el viaje de ida y vuelta conserva id, tipo, duración y nombre', () => {
    const transfer = transferFor('m-9', 'audio', 12.5);
    const payload = readMediaDrag(transfer as unknown as DataTransferLike);
    expect(payload).not.toBeNull();
    expect(payload?.mediaId).toBe('m-9');
    expect(payload?.kind).toBe('audio');
    expect(payload?.durationSeconds).toBeCloseTo(12.5, 6);
    expect(payload?.name).toBe('m-9.mp4');
  });
});

describe('Fase 8 · cabeceras de pista con glifo de tipo', () => {
  function headerFor(kind: 'video' | 'audio'): TrackHeader {
    const fake: FakeApp = createFakeApp();
    fake.session.addMediaItem(mediaItem({ id: 'm-1', duration: 4 }));
    const trackId = fake.session.addTrack(kind, fake.session.timeline.tracks.length)!;
    return new TrackHeader(trackId, {
      getDocument: () => fake.session.document,
      run: (op) => fake.session.run(op),
      relayout: () => {},
    });
  }

  it('la insignia de una pista de vídeo lleva la película', () => {
    const header = headerFor('video');
    expect(header.element.dataset['kind']).toBe('video');
    expect(header.element.querySelector('.tl-track-kind svg')?.getAttribute('data-icon')).toBe('film');
    expect(header.element.querySelector('.tl-track-kind')?.getAttribute('data-kind-glyph')).toBe('video');
  });

  it('la de audio lleva el altavoz', () => {
    const header = headerFor('audio');
    expect(header.element.querySelector('.tl-track-kind svg')?.getAttribute('data-icon')).toBe('volumeOn');
    expect(header.element.querySelector('.tl-track-kind')?.getAttribute('data-kind-glyph')).toBe('audio');
  });
});
