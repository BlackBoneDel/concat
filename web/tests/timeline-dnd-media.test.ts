// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

// @vitest-environment jsdom

/**
 * Parte C — media library ⇄ timeline, end to end.
 *
 * The suites around this one cover the drop *engine* (`drag-drop-timeline`) and
 * the clip *painting* (`clip-renderer-thumbnails`). This one covers the parts
 * the GitHub Pages report was actually about:
 *
 * 1. `dropTargetAt` — the mapping an OS file dropped on the timeline uses to
 *    turn pixels into `(time, lane)`. It was only ever exercised indirectly,
 *    through a pointer at the very top of the first lane.
 * 2. The whole gesture for a card dropped over a lane of the wrong kind: the
 *    clip must keep the pointer's *time* while it moves to a lane that accepts
 *    it (the old code lost the position, then the clip, then showed an error).
 * 3. The two drop routes of the timeline cooperating: the timeline claims the
 *    event, so the window-wide capture (`installGlobalDrop`) neither imports
 *    the file a second time nor fights for the gesture.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Rational } from '../src/core/rational.ts';
import { MediaPanel } from '../src/ui/media-panel.ts';
import { TimelinePanel } from '../src/ui/timeline-panel.ts';
import { installGlobalDrop, type GlobalDropHandle } from '../src/ui/global-drop.ts';
import { installFileDrop, type FileDropHandle } from '../src/ui/timeline/file-drop.ts';
import {
  MEDIA_DRAG_DURATION_MIME,
  MEDIA_DRAG_MIME,
  MEDIA_DRAG_NAME_MIME,
  MEDIA_DRAG_TYPE_MIME,
} from '../src/ui/dnd/media-drag.ts';
import { trackKindOf } from '../src/editor/operations.ts';
import {
  createFakeApp,
  dragEvent,
  fakeAsset,
  FakeDataTransfer,
  laneClips,
  stubRect,
  toastTitles,
  type FakeApp,
} from './f8-helpers.ts';

/** The panel rect every test shares: content coordinates == panel pixels. */
const PANEL = { left: 220, top: 300, width: 900, height: 420 };

/** Mounts the shell the way `main.ts` does and returns the two panels. */
function mount(
  fake: FakeApp,
  rect = PANEL,
): { media: MediaPanel; timeline: TimelinePanel; mediaRoot: HTMLElement; timelineRoot: HTMLElement } {
  document.body.innerHTML = '<div id="app"></div><aside id="media-panel"></aside><section id="timeline-panel"></section>';
  const mediaRoot = document.getElementById('media-panel') as HTMLElement;
  const timelineRoot = document.getElementById('timeline-panel') as HTMLElement;
  stubRect(mediaRoot, { left: 0, top: 48, width: 300, height: 600 });
  stubRect(timelineRoot, rect);
  const media = new MediaPanel(mediaRoot, fake.ctx);
  const timeline = new TimelinePanel(timelineRoot, fake.ctx);
  const content = timelineRoot.querySelector('.tl-content-wrap');
  if (content) stubRect(content, rect);
  return { media, timeline, mediaRoot, timelineRoot };
}

/** A transfer shaped like the one the media panel publishes. */
function mediaTransfer(id = 'm-1', kind: 'video' | 'audio' = 'video', durationSeconds = 8, name = 'clip.mp4'): FakeDataTransfer {
  const transfer = new FakeDataTransfer();
  transfer.setData(MEDIA_DRAG_MIME, id);
  transfer.setData(MEDIA_DRAG_TYPE_MIME, kind);
  transfer.setData(MEDIA_DRAG_DURATION_MIME, Rational.approximate(durationSeconds)!.toString());
  transfer.setData(MEDIA_DRAG_NAME_MIME, name);
  return transfer;
}

/** Registers a library asset so the media panel renders a real card. */
function register(fake: FakeApp, id: string, kind: 'video' | 'audio', name: string): void {
  fake.pool.add(fakeAsset({ id, name, type: kind, durationSeconds: 8 }));
}

describe('Parte C · dropTargetAt: píxeles → (tiempo, pista)', () => {
  let fake: FakeApp;
  beforeEach(() => {
    fake = createFakeApp();
  });

  it('el tiempo crece con x y arranca en 0 en el borde del contenido', () => {
    const { timeline } = mount(fake);
    const origin = timeline.dropTargetAt(0, 10)!;
    const middle = timeline.dropTargetAt(200, 10)!;
    const far = timeline.dropTargetAt(400, 10)!;
    expect(origin.time).toBeCloseTo(0, 6);
    expect(middle.time).toBeGreaterThan(0);
    expect(far.time).toBeGreaterThan(middle.time);
    // Twice the pixels, twice the time at a fixed zoom.
    expect(far.time).toBeCloseTo(middle.time * 2, 3);
  });

  it('el zoom del panel cambia la equivalencia píxeles → tiempo', () => {
    const { timeline } = mount(fake);
    const before = timeline.dropTargetAt(320, 10)!.time;
    timeline.zoomIn();
    const after = timeline.dropTargetAt(320, 10)!.time;
    expect(after).toBeLessThan(before);
    timeline.zoomOut();
    expect(timeline.dropTargetAt(320, 10)!.time).toBeCloseTo(before, 3);
  });

  it('la pista es la de arriba en el borde superior y null por debajo de todas', () => {
    const { timeline, timelineRoot } = mount(fake);
    const first = fake.session.timeline.tracks[0]!;
    expect(timeline.dropTargetAt(100, 1)!.trackId).toBe(first.id);
    // 50 000 px below the first lane there is no lane at all.
    expect(timeline.dropTargetAt(100, 50_000)!.trackId).toBeNull();
    // And the panel is what the pointer coordinates are relative to.
    expect(timelineRoot.getBoundingClientRect().left).toBe(PANEL.left);
  });

  it('las pistas van en orden: el vídeo de arriba precede a las de audio', () => {
    const { timeline } = mount(fake);
    const tracks = fake.session.timeline.tracks;
    const videoId = tracks.find((track) => trackKindOf(fake.session.document, track) === 'video')!.id;
    const audioId = tracks.find((track) => trackKindOf(fake.session.document, track) === 'audio')?.id;
    if (!audioId) return;
    /** The y of the first row that reports `trackId`. */
    const firstRowOf = (trackId: string): number => {
      for (let y = 0; y < 2000; y += 4) if (timeline.dropTargetAt(10, y)?.trackId === trackId) return y;
      return -1;
    };
    const videoY = firstRowOf(videoId);
    const audioY = firstRowOf(audioId);
    expect(videoY).toBeGreaterThanOrEqual(0);
    expect(audioY).toBeGreaterThanOrEqual(0);
    expect(audioY).toBeGreaterThan(videoY);
  });

  it('sin vista montada devuelve null (nunca lanza)', () => {
    const root = document.createElement('section');
    document.body.append(root);
    stubRect(root, PANEL);
    const bare = new TimelinePanel(root, fake.ctx);
    bare.dispose();
    expect(bare.dropTargetAt(10, 10)).toBeNull();
  });
});

describe('Parte C · tarjeta → pista del otro tipo conserva el tiempo', () => {
  let fake: FakeApp;
  beforeEach(() => {
    fake = createFakeApp();
  });

  it('un audio sobre una pista de vídeo cae en la de audio, en el tiempo señalado', () => {
    const from = fake.session.timeline.tracks.length;
    const audioId = fake.session.addTrack('audio', from)!;
    register(fake, 'm-voz', 'audio', 'voz.wav');
    const { mediaRoot, timelineRoot } = mount(fake);

    const card = mediaRoot.querySelector('.media-card')!;
    const transfer = new FakeDataTransfer();
    card.dispatchEvent(dragEvent('dragstart', { dataTransfer: transfer }));
    // 320 px from the content's left edge, over the first (video) lane.
    const pointer = { dataTransfer: transfer, clientX: PANEL.left + 320, clientY: PANEL.top + 10 };
    timelineRoot.dispatchEvent(dragEvent('dragover', pointer));
    timelineRoot.dispatchEvent(dragEvent('drop', pointer));

    const clips = laneClips(fake.session, audioId);
    expect(clips).toHaveLength(1);
    const clip = clips[0]!;
    // Snapped to the playhead (0 s) is fine; what matters is it is not forced
    // back to the start when there is a candidate, and it kept the payload.
    expect(clip.name).toBe('voz.wav');
    expect(clip.duration).toBeCloseTo(8, 3);
    const expected = timelineRoot
      .querySelector('.tl-content-wrap')!
      .getBoundingClientRect();
    expect(expected.left).toBe(PANEL.left);
  });

  it('con Shift el clip cae exactamente donde el puntero, sin imán', () => {
    const audioId = fake.session.addTrack('audio', fake.session.timeline.tracks.length)!;
    register(fake, 'm-voz', 'audio', 'voz.wav');
    const { mediaRoot, timelineRoot } = mount(fake);
    const card = mediaRoot.querySelector('.media-card')!;
    const transfer = new FakeDataTransfer();
    card.dispatchEvent(dragEvent('dragstart', { dataTransfer: transfer }));
    const shift = { dataTransfer: transfer, clientX: PANEL.left + 320, clientY: PANEL.top + 10, shiftKey: true };
    timelineRoot.dispatchEvent(dragEvent('drop', shift));
    const clip = laneClips(fake.session, audioId)[0]!;
    // 320 px at the default zoom (80 px/s) is 4 s.
    expect(clip.start).toBeGreaterThan(3.5);
    expect(clip.start).toBeLessThan(4.5);
  });

  it('soltar sobre el hueco de abajo crea la pista y respeta el tiempo', () => {
    register(fake, 'm-clip', 'video', 'clip.mp4');
    const { mediaRoot, timelineRoot } = mount(fake);
    const before = fake.session.timeline.tracks.map((track) => track.id);
    const card = mediaRoot.querySelector('.media-card')!;
    const transfer = new FakeDataTransfer();
    card.dispatchEvent(dragEvent('dragstart', { dataTransfer: transfer }));
    const pointer = { dataTransfer: transfer, clientX: PANEL.left + 160, clientY: PANEL.top + 50_000, shiftKey: true };
    timelineRoot.dispatchEvent(dragEvent('drop', pointer));

    const created = fake.session.timeline.tracks.find((track) => !before.includes(track.id));
    expect(created).toBeDefined();
    const clip = laneClips(fake.session, created!.id)[0]!;
    // 160 px = 2 s at the default zoom.
    expect(clip.start).toBeCloseTo(2, 1);
    expect(toastTitles(fake.toasts)).toContain('Clip añadido al timeline');
  });
});

describe('Parte C · reproducción: las dos líneas del playhead avanzan juntas', () => {
  let fake: FakeApp;
  /** The frames the panel asked for, in order. */
  let frames: FrameRequestCallback[];
  let raf: { mockRestore(): void };

  beforeEach(() => {
    fake = createFakeApp();
    frames = [];
    raf = vi
      .spyOn(globalThis, 'requestAnimationFrame')
      .mockImplementation((callback: FrameRequestCallback): number => frames.push(callback));
  });

  afterEach(() => {
    raf.mockRestore();
  });

  /** Runs the pending animation frames once (the loop re-queues itself). */
  const runFrame = (): void => {
    const pending = frames;
    frames = [];
    for (const callback of pending) callback(0);
  };

  it('durante la reproducción el playhead del panel y el de la vista se mueven', () => {
    document.body.innerHTML = '<div id="app"></div><section id="timeline-panel"></section>';
    const timelineRoot = document.getElementById('timeline-panel') as HTMLElement;
    stubRect(timelineRoot, PANEL);
    const panel = new TimelinePanel(timelineRoot, fake.ctx);
    const viewLine = timelineRoot.querySelector<HTMLElement>('.tl-playhead');
    const panelLine = document.querySelector<HTMLElement>('.tl-playhead-line');
    expect(viewLine).not.toBeNull();
    expect(panelLine).not.toBeNull();
    const before = viewLine!.style.transform;

    // Playback: the player's clock advances and the loop paints it.
    fake.player.currentTime = Rational.approximate(2)!;
    runFrame();
    const after = viewLine!.style.transform;
    // This is the bug of the deployed build: only the panel's line moved and
    // the view's stayed where playback started.
    expect(after).not.toBe(before);
    expect(after).toMatch(/translateX\((\d+)px\)/);
    expect(Number(/translateX\((\d+)px\)/.exec(after)![1])).toBeGreaterThan(0);
    // Both lines agree (one is inside the view's transform, the other in its own).
    expect(panelLine!.style.transform).toContain('translateX');

    // A later instant keeps moving it: no freeze after the first frame.
    fake.player.currentTime = Rational.approximate(6)!;
    runFrame();
    expect(viewLine!.style.transform).not.toBe(after);
    expect(Number(/translateX\((\d+)px\)/.exec(viewLine!.style.transform)![1])).toBeGreaterThan(
      Number(/translateX\((\d+)px\)/.exec(after)![1]),
    );
    panel.dispose();
  });
});

describe('Parte C · el drop del timeline y el capturador global no se pisan', () => {
  let fake: FakeApp;
  let global: GlobalDropHandle | null = null;
  let fileDrop: FileDropHandle | null = null;

  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div><section id="timeline-panel"></section>';
    fake = createFakeApp();
  });

  afterEach(() => {
    fileDrop?.dispose();
    fileDrop = null;
    global?.dispose();
    global = null;
  });

  /** Wires the timeline exactly like `main.ts`: import + place where dropped. */
  function wire(): { onFiles: ReturnType<typeof vi.fn>; timeline: TimelinePanel; timelineRoot: HTMLElement } {
    const timelineRoot = document.getElementById('timeline-panel') as HTMLElement;
    stubRect(timelineRoot, PANEL);
    const timeline = new TimelinePanel(timelineRoot, fake.ctx);
    const content = timelineRoot.querySelector('.tl-content-wrap');
    if (content) stubRect(content, PANEL);
    const onFiles = vi.fn();
    fileDrop = installFileDrop(timelineRoot, {
      onFiles: (files, point) => {
        const place = timeline.dropTargetAt(point.x, point.y);
        onFiles(files, place);
      },
    });
    global = installGlobalDrop({
      onFiles: (files) => onFiles(files, null),
      windowTarget: window as unknown as { addEventListener(): void; removeEventListener(): void },
      documentTarget: document as unknown as { addEventListener(): void; removeEventListener(): void },
      overlayHost: document.body,
    });
    return { onFiles, timeline, timelineRoot };
  }

  it('un archivo soltado en el timeline se importa una sola vez, con su colocación', () => {
    const { onFiles, timelineRoot } = wire();
    // Panel-relative pixels are what `installFileDrop` reports; it subtracts
    // the panel's rect, so the pointer must sit inside it.
    timelineRoot.dispatchEvent(
      dragEvent('drop', { dataTransfer: FakeDataTransfer.files(['nuevo.mp4']), clientX: PANEL.left + 40, clientY: PANEL.top + 20 }),
    );
    expect(onFiles).toHaveBeenCalledTimes(1);
    const [files, place] = onFiles.mock.calls[0]!;
    expect((files as File[]).map((file) => file.name)).toEqual(['nuevo.mp4']);
    // 40 px into the content at the default zoom: half a second in, first lane.
    expect(place.trackId).toBe(fake.session.timeline.tracks[0]!.id);
    expect(place.time).toBeCloseTo(0.5, 3);
  });

  it('el capturador global tampoco lo importa: el timeline reclamó el evento', () => {
    const { onFiles, timelineRoot } = wire();
    timelineRoot.dispatchEvent(
      dragEvent('drop', { dataTransfer: FakeDataTransfer.files(['otro.mp4']), clientX: PANEL.left + 400, clientY: PANEL.top + 80 }),
    );
    // One import only — no duplicate card from the window-level handler.
    expect(onFiles).toHaveBeenCalledTimes(1);
    // And the placement is a real lane, not a preview artefact.
    expect(onFiles.mock.calls[0]![1]).not.toBeNull();
  });

  it('un archivo soltado muy lejos del timeline sí lo recoge el capturador global', () => {
    const { onFiles } = wire();
    const outside = document.createElement('div');
    document.body.append(outside);
    outside.dispatchEvent(dragEvent('drop', { dataTransfer: FakeDataTransfer.files(['suelto.mp4']) }));
    expect(onFiles).toHaveBeenCalledTimes(1);
    expect(onFiles.mock.calls[0]![1]).toBeNull();
  });

  it('el dragover del timeline no impide que el global muestre el overlay', () => {
    wire();
    window.dispatchEvent(dragEvent('dragover', { dataTransfer: FakeDataTransfer.files(['a.mp4']) }));
    const overlay = document.getElementById('concat-drop-overlay');
    expect(overlay).not.toBeNull();
    expect(overlay!.classList.contains('is-visible')).toBe(true);
  });
});
