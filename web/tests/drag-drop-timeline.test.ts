// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

// @vitest-environment jsdom
/**
 * Fase 8 — the critical fix: dragging a card from the media library onto the
 * timeline inserts a clip.
 *
 * jsdom ships neither `DataTransfer` nor `DragEvent`, so the suite drives
 * real DOM events carrying a structural transfer (see `f8-helpers.ts`) — the
 * same shape the browser hands the panel.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Rational } from '../src/core/rational.ts';
import { MediaPanel } from '../src/ui/media-panel.ts';
import { TimelinePanel } from '../src/ui/timeline-panel.ts';
import { MEDIA_DRAG_MIME, MEDIA_DRAG_TYPE_MIME } from '../src/ui/dnd/media-drag.ts';
import { markDropHandled, wasDropHandled } from '../src/ui/dnd/drop-handled.ts';
import { installDropGuard, installFileDrop } from '../src/ui/timeline/file-drop.ts';
import {
  createFakeApp,
  dragEvent,
  fakeAsset,
  FakeDataTransfer,
  laneClips,
  mediaItem,
  stubRect,
  toastTitles,
  type FakeApp,
} from './f8-helpers.ts';

/** A structural event target (the file-drop guards take plain objects). */
function structuralTarget() {
  const listeners = new Map<string, EventListener[]>();
  return {
    listeners,
    classList: { add(): void {}, remove(): void {} },
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    addEventListener(type: string, listener: EventListener): void {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
    removeEventListener(): void {},
  };
}

/** A media drag carrying one video. */
function mediaTransfer(id = 'm-1', durationSeconds = 10, kind = 'video'): FakeDataTransfer {
  const transfer = new FakeDataTransfer();
  transfer.setData(MEDIA_DRAG_MIME, id);
  transfer.setData(MEDIA_DRAG_TYPE_MIME, kind);
  transfer.setData('application/x-concat-media-duration', Rational.approximate(durationSeconds)!.toString());
  transfer.setData('text/plain', 'video.mp4');
  transfer.setData('application/x-concat-media-name', 'video.mp4');
  return transfer;
}

/** Mounts the shell the way `main.ts` does: media panel + timeline panel. */
function mount(fake: FakeApp, rect = { left: 220, top: 300, width: 900, height: 420 }) {
  document.body.innerHTML = '<div id="app"></div><aside id="media-panel"></aside><section id="timeline-panel"></section>';
  const mediaRoot = document.getElementById('media-panel') as HTMLElement;
  const timelineRoot = document.getElementById('timeline-panel') as HTMLElement;
  stubRect(mediaRoot, { left: 0, top: 48, width: 300, height: 600 });
  stubRect(timelineRoot, rect);
  const media = new MediaPanel(mediaRoot, fake.ctx);
  const timeline = new TimelinePanel(timelineRoot, fake.ctx);
  // The view measures pointers against the scrolled content box.
  const content = timelineRoot.querySelector('.tl-content-wrap');
  if (content) stubRect(content, rect);
  return { media, timeline, mediaRoot, timelineRoot };
}

describe('Fase 8 · media card → timeline (drag & drop)', () => {
  let fake: FakeApp;

  beforeEach(() => {
    document.body.innerHTML = '';
    document.documentElement.removeAttribute('data-theme');
    fake = createFakeApp();
  });

  it('la tarjeta del panel de medios es arrastrable y publica su payload', async () => {
    const asset = fake.pool.add(fakeAsset({ id: 'm-a', name: 'uno.mp4', durationSeconds: 7 }));
    const { mediaRoot } = mount(fake);
    void asset;
    // The grid paints from the library without decoding anything.
    const card = mediaRoot.querySelector('.media-card');
    expect(card).not.toBeNull();
    expect(card!.getAttribute('draggable')).toBe('true');

    const transfer = new FakeDataTransfer();
    card!.dispatchEvent(dragEvent('dragstart', { dataTransfer: transfer }));
    expect(transfer.getData(MEDIA_DRAG_MIME)).toBe('m-a');
    expect(transfer.getData(MEDIA_DRAG_TYPE_MIME)).toBe('video');
    expect(transfer.getData('text/plain')).toBe('uno.mp4');
    expect(transfer.effectAllowed).toBe('copy');
    expect(card!.classList.contains('media-card--dragging')).toBe(true);

    card!.dispatchEvent(dragEvent('dragend', { dataTransfer: transfer }));
    expect(card!.classList.contains('media-card--dragging')).toBe(false);
  });

  it('inserta un clip al soltar sobre una pista existente', () => {
    fake.session.addMediaItem(mediaItem({ id: 'm-1', name: 'video.mp4', duration: 10 }));
    const { timelineRoot } = mount(fake);
    const before = fake.session.document.timelines[0]!.clips.length;
    const expectedTrack = fake.session.document.timelines[0]!.tracks[0]!.id;

    const transfer = mediaTransfer('m-1', 10);
    // Content rect starts at (220, 300): x = 100 → 1.25 s at 80 px/s, y = 24 → first lane.
    timelineRoot.dispatchEvent(dragEvent('dragenter', { dataTransfer: transfer, clientX: 320, clientY: 324 }));
    timelineRoot.dispatchEvent(dragEvent('dragover', { dataTransfer: transfer, clientX: 320, clientY: 324 }));
    const drop = dragEvent('drop', { dataTransfer: transfer, clientX: 320, clientY: 324 });
    timelineRoot.dispatchEvent(drop);

    const clips = fake.session.document.timelines[0]!.clips;
    expect(clips.length).toBe(before + 1);
    const clip = clips[clips.length - 1]!;
    expect(clip.mediaId).toBe('m-1');
    expect(clip.trackId).toBe(expectedTrack);
    expect(clip.start).toBeCloseTo(1.25, 6);
    expect(clip.duration).toBeCloseTo(10, 6);
    expect(clip.kind).toBe('video');
    // The event was consumed: no browser navigation, no second handler.
    expect(drop.defaultPrevented).toBe(true);
    expect(wasDropHandled(drop)).toBe(true);
    // One history step, one toast, one repaint.
    expect(fake.session.history.canUndo()).toBe(true);
    expect(toastTitles(fake.toasts)).toContain('Clip añadido al timeline');
  });

  it('crea una pista automáticamente al soltar fuera de las pistas', () => {
    fake.session.addMediaItem(mediaItem({ id: 'm-2', name: 'dos.mp4', duration: 5 }));
    const { timelineRoot } = mount(fake);
    const tracksBefore = fake.session.document.timelines[0]!.tracks.length;

    const transfer = mediaTransfer('m-2', 5);
    // y = 500 lands well below the last lane (410 px of tracks).
    timelineRoot.dispatchEvent(dragEvent('dragover', { dataTransfer: transfer, clientX: 620, clientY: 800 }));
    timelineRoot.dispatchEvent(dragEvent('drop', { dataTransfer: transfer, clientX: 620, clientY: 800 }));

    const timeline = fake.session.document.timelines[0]!;
    expect(timeline.tracks.length).toBe(tracksBefore + 1);
    const created = timeline.tracks[timeline.tracks.length - 1]!;
    expect(created.extra['kind']).toBe('video');
    const clips = laneClips(fake.session, created.id);
    expect(clips).toHaveLength(1);
    expect(clips[0]!.start).toBeCloseTo(5, 6);
  });

  it('un medio de audio crea una pista de audio', () => {
    fake.session.addMediaItem(mediaItem({ id: 'm-3', name: 'voz.mp3', kind: 'audio', duration: 4 }));
    const { timelineRoot } = mount(fake);

    const transfer = mediaTransfer('m-3', 4, 'audio');
    timelineRoot.dispatchEvent(dragEvent('dragover', { dataTransfer: transfer, clientX: 320, clientY: 800 }));
    timelineRoot.dispatchEvent(dragEvent('drop', { dataTransfer: transfer, clientX: 320, clientY: 800 }));

    const timeline = fake.session.document.timelines[0]!;
    const created = timeline.tracks[timeline.tracks.length - 1]!;
    expect(created.extra['kind']).toBe('audio');
    const clips = laneClips(fake.session, created.id);
    expect(clips).toHaveLength(1);
    expect(clips[0]!.kind).toBe('audio');
  });

  it('aplica snapping al playhead durante el dragover (guía magenta)', () => {
    fake.session.addMediaItem(mediaItem({ id: 'm-4', name: 'snap.mp4', duration: 3 }));
    const { timelineRoot } = mount(fake);
    // The playhead at 3.5 s: 3.5 * 80 = 280 px from the content's left edge.
    fake.player.seekTo(Rational.approximate(3.5)!);

    const transfer = mediaTransfer('m-4', 3);
    // Drop at x = 277 (3.4625 s): inside the 10 px snap radius of the playhead.
    timelineRoot.dispatchEvent(dragEvent('dragover', { dataTransfer: transfer, clientX: 497, clientY: 324 }));
    const guides = timelineRoot.querySelectorAll('.tl-snap-guide-drop');
    expect(guides.length).toBe(1);
    expect((guides[0] as HTMLElement).style.left).toBe('280px');

    timelineRoot.dispatchEvent(dragEvent('drop', { dataTransfer: transfer, clientX: 497, clientY: 324 }));
    const clip = fake.session.document.timelines[0]!.clips[0]!;
    expect(clip.start).toBeCloseTo(3.5, 6);
  });

  it('Shift desactiva el snapping en el drop', () => {
    fake.session.addMediaItem(mediaItem({ id: 'm-5', name: 'shift.mp4', duration: 3 }));
    const { timelineRoot } = mount(fake);
    fake.player.seekTo(Rational.approximate(3.5)!);

    const transfer = mediaTransfer('m-5', 3);
    timelineRoot.dispatchEvent(dragEvent('dragover', { dataTransfer: transfer, clientX: 497, clientY: 324, shiftKey: true }));
    expect(timelineRoot.querySelectorAll('.tl-snap-guide-drop')).toHaveLength(0);
    timelineRoot.dispatchEvent(dragEvent('drop', { dataTransfer: transfer, clientX: 497, clientY: 324, shiftKey: true }));

    const clip = fake.session.document.timelines[0]!.clips[0]!;
    expect(clip.start).toBeCloseTo(3.4625, 4);
  });

  it('Escape cancela el drag: el drop posterior no inserta nada', () => {
    fake.session.addMediaItem(mediaItem({ id: 'm-6', name: 'x.mp4', duration: 3 }));
    const { timelineRoot } = mount(fake);
    const transfer = mediaTransfer('m-6', 3);

    timelineRoot.dispatchEvent(dragEvent('dragover', { dataTransfer: transfer, clientX: 320, clientY: 324 }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    timelineRoot.dispatchEvent(dragEvent('drop', { dataTransfer: transfer, clientX: 320, clientY: 324 }));

    expect(fake.session.document.timelines[0]!.clips).toHaveLength(0);
    expect(timelineRoot.classList.contains('timeline-drop-active')).toBe(false);
  });

  it('el ghost de drop se marca como activo y se limpia al salir', () => {
    const { timelineRoot } = mount(fake);
    const transfer = mediaTransfer('m-7', 3);
    timelineRoot.dispatchEvent(dragEvent('dragenter', { dataTransfer: transfer, clientX: 320, clientY: 324 }));
    expect(timelineRoot.classList.contains('timeline-drop-active')).toBe(true);
    timelineRoot.dispatchEvent(dragEvent('dragleave', { dataTransfer: transfer }));
    expect(timelineRoot.classList.contains('timeline-drop-active')).toBe(false);
  });

  it('un drag de archivos del SO no lo consume el drop de medios', () => {
    const { timelineRoot } = mount(fake);
    const transfer = FakeDataTransfer.files(['pelicula.mp4']);
    const over = dragEvent('dragover', { dataTransfer: transfer, clientX: 320, clientY: 324 });
    timelineRoot.dispatchEvent(over);
    // The media installer ignores it; the OS file drop is a different path.
    expect(wasDropHandled(over)).toBe(false);
    expect(fake.session.document.timelines[0]!.clips).toHaveLength(0);
  });

  it('un clip que la pista rechaza informa del error (sin romper)', () => {
    // An explicit audio lane appended below the four video lanes.
    const from = fake.session.timeline.tracks.length;
    const audioTrackId = fake.session.addTrack('audio', from)!;
    const { timelineRoot } = mount(fake);
    const transfer = mediaTransfer('m-8', 4, 'video');
    // y = 400 sits inside the appended lane (4 × 96 = 384 … 456).
    timelineRoot.dispatchEvent(dragEvent('dragover', { dataTransfer: transfer, clientX: 320, clientY: 700 }));
    timelineRoot.dispatchEvent(dragEvent('drop', { dataTransfer: transfer, clientX: 320, clientY: 700 }));

    expect(laneClips(fake.session, audioTrackId)).toHaveLength(0);
    // The drop reports the failure instead of throwing out of the event.
    expect(toastTitles(fake.toasts)).toContain('No se pudo añadir el clip');
  });

  it('el drop de medios y el guard global de archivos no se pisan', () => {
    const guardTarget = structuralTarget();
    const guard = installDropGuard(guardTarget as never);
    const dropZone = structuralTarget();
    const onFiles = vi.fn();
    const fileDrop = installFileDrop(dropZone as never, { onFiles });

    // 1. A media drag is invisible to the guard: it carries no OS files.
    const mediaDrop = dragEvent('drop', { dataTransfer: mediaTransfer('m-1', 3) });
    for (const listener of guardTarget.listeners.get('drop') ?? []) listener(mediaDrop);
    expect(mediaDrop.defaultPrevented).toBe(false);
    expect(onFiles).not.toHaveBeenCalled();

    // 2. A file drop the timeline already consumed is left alone.
    const fileDropEvent = dragEvent('drop', { dataTransfer: FakeDataTransfer.files(['a.mp4']) });
    markDropHandled(fileDropEvent);
    for (const listener of guardTarget.listeners.get('drop') ?? []) listener(fileDropEvent);
    expect(fileDropEvent.defaultPrevented).toBe(false);

    // 3. A stray file drop (nobody claimed it) is blocked as before.
    const strayDrop = dragEvent('drop', { dataTransfer: FakeDataTransfer.files(['b.mp4']) });
    for (const listener of guardTarget.listeners.get('drop') ?? []) listener(strayDrop);
    expect(strayDrop.defaultPrevented).toBe(true);

    guard.dispose();
    fileDrop.dispose();
  });
});

describe('Fase 8 · drop-handled bookkeeping', () => {
  it('marca y consulta un evento ya consumido', () => {
    const event = dragEvent('drop');
    expect(wasDropHandled(event)).toBe(false);
    markDropHandled(event);
    expect(wasDropHandled(event)).toBe(true);
    expect(wasDropHandled(null)).toBe(false);
  });
});

describe('Fase 8 · insertClipFromMedia', () => {
  it('crea el clip con duración, tipo y nombre del payload', () => {
    const fake = createFakeApp();
    const trackId = fake.session.document.timelines[0]!.tracks[0]!.id;
    const clipId = fake.session.insertClipFromMedia(
      'm-9',
      trackId,
      Rational.approximate(2)!,
      'overwrite',
      { durationSeconds: 12.5, kind: 'video', name: 'nuevo.mp4' },
    );
    const clip = fake.session.document.timelines[0]!.clips.find((item) => item.id === clipId)!;
    expect(clip.mediaId).toBe('m-9');
    expect(clip.name).toBe('nuevo.mp4');
    expect(clip.duration).toBeCloseTo(12.5, 6);
    expect(clip.start).toBeCloseTo(2, 6);
    expect(clip.sourceStart).toBe(0);
  });

  it('sin la media ni duración en el payload lanza (y no deja basura)', () => {
    const fake = createFakeApp();
    const trackId = fake.session.document.timelines[0]!.tracks[0]!.id;
    expect(() => fake.session.insertClipFromMedia('fantasma', trackId, Rational.ZERO, 'overwrite')).toThrow(
      /Medio no encontrado/,
    );
    expect(fake.session.document.timelines[0]!.clips).toHaveLength(0);
  });

  it('respeta el modo insert (el resto se desplaza)', () => {
    const fake = createFakeApp();
    const trackId = fake.session.document.timelines[0]!.tracks[0]!.id;
    const first = fake.session.insertClipFromMedia('a', trackId, Rational.ZERO, 'overwrite', {
      durationSeconds: 4,
      kind: 'video',
      name: 'a',
    });
    const second = fake.session.insertClipFromMedia('b', trackId, Rational.ZERO, 'insert', {
      durationSeconds: 2,
      kind: 'video',
      name: 'b',
    });
    const clips = laneClips(fake.session, trackId);
    const moved = clips.find((clip) => clip.id === first)!;
    const inserted = clips.find((clip) => clip.id === second)!;
    expect(inserted.start).toBeCloseTo(0, 6);
    expect(moved.start).toBeCloseTo(2, 6);
  });
});
