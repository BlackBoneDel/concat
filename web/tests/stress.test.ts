// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

// @vitest-environment jsdom
/**
 * Fase 7 — pruebas de estrés y condiciones de carrera:
 *  1. arrastrar un clip mientras se pulsa Ctrl+Z cinco veces;
 *  2. abortar una exportación a los 100 ms, diez veces seguidas;
 *  3. borrar un medio en mitad de la reproducción.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Rational } from '../src/core/rational.ts';
import { SplitClipOperation } from '../src/editor/operations.ts';
import { ExportController, type ExportEnvironment } from '../src/export/export-controller.ts';
import { defaultExportConfig, ExportError, type ExportConfig, type ExportFormat } from '../src/export/types.ts';
import { MediaPool } from '../src/media/media-pool.ts';
import { PreviewPlayer } from '../src/player/player.ts';
import { MISSING_MEDIA_COLORS, MISSING_MEDIA_LABEL } from '../src/render/compositor.ts';
import type { RenderImage } from '../src/render/index.ts';
import type { EditSession } from '../src/session/edit-session.ts';
import { DragManager } from '../src/ui/interactions/drag-manager.ts';
import { TimelineView } from '../src/ui/timeline/timeline-view.ts';
import { clipsOf, makeSession, r, snap } from './f3-helpers.ts';
import { bufferOf } from './f4-helpers.ts';
import { FakeAudioEncoder, FakeMedia, FakeOfflineContext, FakeSurface, FakeVideoEncoder } from './f6-helpers.ts';
import { RecordingTarget } from './f7-helpers.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// 1. Drag + 5 × Ctrl+Z
// ---------------------------------------------------------------------------

interface DragRig {
  session: EditSession;
  view: TimelineView;
  drag: DragManager;
  target: HTMLElement;
  counter: { edits: number };
}

function dragRig(): DragRig {
  // jsdom has no 2D canvas: the view must cope with a null context quietly.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  // Synchronous rAF: the view's render scheduling must not leak timers.
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
    callback(0);
    return 1;
  });
  const session = makeSession([{ start: 0, duration: 4 }]);
  const container = document.createElement('div');
  const overlay = document.createElement('div');
  document.body.append(container, overlay);
  let playhead = 0;
  const view = new TimelineView({
    container,
    overlay,
    preview: { frameAt: async () => null },
    getDocument: () => session.document,
    markers: () => session.markers(),
    playheadSeconds: () => playhead,
    setPlayhead: (seconds) => {
      playhead = seconds;
    },
    selection: session.selection,
  });
  view.relayout();
  const counter = { edits: 0 };
  const drag = new DragManager(
    {
      view,
      history: session.history,
      selection: session.selection,
      snap: session.snapping,
      getDocument: () => session.document,
      markers: () => session.markers(),
      tool: () => 'select',
      isSnappingEnabled: () => false,
      playheadSeconds: () => playhead,
      onChange: () => {
        counter.edits += 1;
      },
      onPreview: () => undefined,
      onContextMenu: () => undefined,
    },
    container,
  );
  return { session, view, drag, target: container, counter };
}

/** Dispatches a pointer-ish event (jsdom has no PointerEvent constructor). */
function pointer(target: HTMLElement, type: string, x: number, y: number): void {
  target.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }));
}

/** Content point over the middle of `clipId`. */
function pointOver(rig: DragRig, clipId: string): { x: number; y: number } {
  const clip = clipsOf(rig.session).find((candidate) => candidate.id === clipId);
  if (!clip) throw new Error(`no clip ${clipId}`);
  const layout = rig.view.trackLayout(clip.trackId);
  if (!layout) throw new Error(`no layout for ${clip.trackId}`);
  const x = rig.view.timeToX(clip.start + clip.duration / 2);
  const y = Math.max(layout.y + layout.height / 2, rig.view.rulerHeight + 1);
  expect(rig.view.clipAt(x, y)?.id).toBe(clipId);
  return { x, y };
}

describe('Estrés 1 — drag + 5 × Ctrl+Z', () => {
  it('el DragManager cancela el gesto si el historial muta por debajo y no aplica operaciones obsoletas', () => {
    const rig = dragRig();
    // Five history steps: c1 is cut into six pieces; the last tail only
    // exists because of them.
    const tails: string[] = [];
    for (const at of [0.5, 1, 1.5, 2, 2.5]) {
      const tailId = `tail-${at}`;
      expect(rig.session.run(new SplitClipOperation(tails.at(-1) ?? 'c1', r(at), tailId))).toBe(true);
      tails.push(tailId);
    }
    rig.view.relayout();
    const grabbed = tails.at(-1)!;
    const errors: string[] = [];
    rig.session.onError = (message) => errors.push(message);
    const { x, y } = pointOver(rig, grabbed);

    pointer(rig.target, 'pointerdown', x, y);
    expect(rig.drag.isDragging).toBe(true);
    pointer(rig.target, 'pointermove', x + 40, y);
    expect(rig.view.dragPreview()).not.toBeNull();

    // Ctrl+Z × 5 while the button is still held.
    for (let i = 0; i < 5; i += 1) rig.session.undo();
    const afterUndo = snap(rig.session.history.currentDoc);
    expect(clipsOf(rig.session).some((clip) => clip.id === grabbed)).toBe(false);

    // The pointer keeps moving and is released over the timeline.
    expect(() => pointer(rig.target, 'pointermove', x + 120, y)).not.toThrow();
    expect(() => pointer(rig.target, 'pointerup', x + 120, y)).not.toThrow();

    expect(rig.drag.externalCancelCount).toBe(1);
    expect(rig.drag.isDragging).toBe(false);
    expect(rig.view.dragPreview()).toBeNull();
    // Nothing was committed on top of the undone document…
    expect(snap(rig.session.history.currentDoc)).toBe(afterUndo);
    expect(errors).toEqual([]);
    // …and the redo stack (the five splits) survived intact.
    expect(rig.session.history.redoStack).toHaveLength(5);
    expect(rig.session.history.canUndo()).toBe(false);
    rig.drag.dispose();
    rig.view.dispose();
  });

  it('la ruta del panel (syncWithHistory tras onEdited) cancela al instante, antes de cualquier pointermove', () => {
    const rig = dragRig();
    expect(rig.session.run(new SplitClipOperation('c1', r(2), 'c2'))).toBe(true);
    rig.view.relayout();
    const { x, y } = pointOver(rig, 'c2');
    pointer(rig.target, 'pointerdown', x, y);
    pointer(rig.target, 'pointermove', x + 30, y);
    expect(rig.drag.syncWithHistory()).toBe(false); // nothing changed yet
    rig.session.undo();
    expect(rig.drag.syncWithHistory()).toBe(true);
    expect(rig.view.dragPreview()).toBeNull();
    expect(rig.drag.syncWithHistory()).toBe(false); // idempotent
    pointer(rig.target, 'pointerup', x + 30, y);
    expect(rig.session.history.redoStack).toHaveLength(1);
    rig.drag.dispose();
    rig.view.dispose();
  });

  it('un drag normal (sin mutaciones externas) sigue produciendo exactamente un paso de historial', () => {
    const rig = dragRig();
    const { x, y } = pointOver(rig, 'c1');
    pointer(rig.target, 'pointerdown', x, y);
    pointer(rig.target, 'pointermove', x + 40, y);
    pointer(rig.target, 'pointermove', x + 80, y);
    pointer(rig.target, 'pointerup', x + 80, y);
    expect(rig.drag.externalCancelCount).toBe(0);
    expect(rig.session.history.undoStack).toHaveLength(1);
    expect(clipsOf(rig.session)[0]!.start).toBeGreaterThan(0);
    rig.drag.dispose();
    rig.view.dispose();
  });

  it('cinco ciclos drag + deshacer/rehacer intercalados dejan el documento coherente', () => {
    const rig = dragRig();
    for (let round = 0; round < 5; round += 1) {
      const { x, y } = pointOver(rig, 'c1');
      pointer(rig.target, 'pointerdown', x, y);
      pointer(rig.target, 'pointermove', x + 20, y);
      if (round % 2 === 0) rig.session.undo();
      else rig.session.redo();
      pointer(rig.target, 'pointermove', x + 60, y);
      pointer(rig.target, 'pointerup', x + 60, y);
      rig.view.relayout();
    }
    const clips = clipsOf(rig.session);
    expect(clips).toHaveLength(1);
    expect(clips[0]!.start).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(clips[0]!.start)).toBe(true);
    rig.drag.dispose();
    rig.view.dispose();
  });
});

// ---------------------------------------------------------------------------
// 2. Export aborted at 100 ms × 10
// ---------------------------------------------------------------------------

interface ExportRig {
  env: ExportEnvironment;
  media: FakeMedia;
  surfaces: FakeSurface[];
  videoEncoders: FakeVideoEncoder[];
  audioEncoders: FakeAudioEncoder[];
}

function exportRig(): ExportRig {
  // 20 s at 10 fps = 200 frames × ~2 ms: far longer than the 100 ms abort.
  const session = makeSession([{ start: 0, duration: 4 }, { start: 0, duration: 3, kind: 'audio', trackId: 'T3' }]);
  for (let i = 1; i < 5; i += 1) {
    const clip = { ...session.document.timelines[0]!.clips[0]!, id: `v${i}`, start: i * 4, keys: [], extra: {} };
    session.document.timelines[0]!.clips.push(clip);
  }
  session.history.rebase(session.document);
  const media = new FakeMedia();
  media.originals.add('m1');
  media.buffers.set('mA', bufferOf([new Float32Array(48_000 * 3).fill(0.2), new Float32Array(48_000 * 3).fill(-0.2)]));
  const surfaces: FakeSurface[] = [];
  const videoEncoders: FakeVideoEncoder[] = [];
  const audioEncoders: FakeAudioEncoder[] = [];
  const env: ExportEnvironment = {
    getDocument: () => session.document,
    media,
    getFFmpeg: () => null,
    createSurface: (w, h) => {
      const surface = new FakeSurface(w, h);
      surfaces.push(surface);
      return surface;
    },
    composite: async () => {
      await sleep(2);
    },
    createVideoEncoder: (callbacks) => {
      const encoder = new FakeVideoEncoder(callbacks);
      videoEncoders.push(encoder);
      return encoder;
    },
    isVideoConfigSupported: async () => true,
    createAudioEncoder: (callbacks) => {
      const encoder = new FakeAudioEncoder(callbacks);
      audioEncoders.push(encoder);
      return encoder;
    },
    isAudioConfigSupported: async () => true,
    createOfflineContext: (channels, length, rate) => new FakeOfflineContext(channels, length, rate, () => 0.1),
    hasWebCodecs: () => true,
    yieldToUi: async () => {},
  };
  return { env, media, surfaces, videoEncoders, audioEncoders };
}

function exportConfig(format: ExportFormat): ExportConfig {
  const base = { ...defaultExportConfig(), width: 64, height: 36, frameRate: { num: 10, den: 1 }, videoBitrate: 500_000 };
  if (format === 'webm') return { ...base, format, videoCodec: 'vp9', audioCodec: 'opus' };
  if (format === 'gif') return { ...base, format, audioCodec: 'none' };
  return base;
}

describe('Estrés 2 — exportación abortada a los 100 ms, diez veces', () => {
  it('ningún VideoFrame queda sin close(), todo se libera y el controlador queda reutilizable', async () => {
    const rig = exportRig();
    const controller = new ExportController(rig.env);
    const formats: ExportFormat[] = ['mp4', 'webm', 'gif'];
    const outcomes: string[] = [];
    for (let run = 0; run < 10; run += 1) {
      const format = formats[run % formats.length]!;
      const timer = setTimeout(() => controller.cancel(), 100);
      const outcome = await controller.start(exportConfig(format)).then(
        () => 'completed',
        (error: unknown) => (error instanceof ExportError ? error.code : 'other'),
      );
      clearTimeout(timer);
      outcomes.push(outcome);
      expect(controller.running).toBe(false);
    }
    expect(outcomes).toEqual(Array.from({ length: 10 }, () => 'ABORTED'));
    // Frames: every one handed out by every surface was closed.
    const frames = rig.surfaces.flatMap((surface) => surface.frames);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.filter((frame) => !frame.closed)).toHaveLength(0);
    // Surfaces disposed, encoders closed.
    expect(rig.surfaces.length).toBeGreaterThanOrEqual(10);
    expect(rig.surfaces.every((surface) => surface.disposed)).toBe(true);
    expect(rig.videoEncoders.every((encoder) => encoder.closed)).toBe(true);
    expect(rig.audioEncoders.every((encoder) => encoder.closed)).toBe(true);
    // Originals forced and released in pairs, ending released.
    expect(rig.media.forced.length).toBe(20);
    expect(rig.media.forced.at(-1)).toBe(false);
    expect(rig.media.forced.filter(Boolean)).toHaveLength(10);
    controller.dispose();
  }, 20_000);

  it('cancelar en ráfaga (cancel() ×10 en el mismo tick) es idempotente', async () => {
    const rig = exportRig();
    const controller = new ExportController(rig.env);
    const pending = controller.start(exportConfig('mp4'));
    await sleep(30);
    for (let i = 0; i < 10; i += 1) controller.cancel();
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
    expect(rig.surfaces.flatMap((surface) => surface.frames).every((frame) => frame.closed)).toBe(true);
    controller.dispose();
    controller.dispose();
  });
});

// ---------------------------------------------------------------------------
// 3. Media deleted during PLAY
// ---------------------------------------------------------------------------

/** A media pool whose files can be deleted while the player runs. */
class VanishingMediaPool extends MediaPool {
  readonly deleted = new Set<string>();
  failures = 0;

  override async getFrame(id: string, sourceTime: Rational): Promise<RenderImage | null> {
    void sourceTime;
    if (this.deleted.has(id)) {
      this.failures += 1;
      throw new DOMException(`El archivo ${id} ya no existe en OPFS`, 'NotFoundError');
    }
    return document.createElement('img');
  }

  override getSize(id: string): { width: number; height: number } | null {
    void id;
    return { width: 1920, height: 1080 };
  }
}

describe('Estrés 3 — medio borrado durante PLAY', () => {
  function playRig(): { session: EditSession; pool: VanishingMediaPool; target: RecordingTarget; player: PreviewPlayer; ticks: number[]; errors: { mediaId: string | null; error: unknown }[] } {
    const session = makeSession([{ start: 0, duration: 4 }, { start: 0, duration: 4, trackId: 'T2' }]);
    // The second lane plays another file, which stays healthy.
    session.document.timelines[0]!.clips[1]!.mediaId = 'm2';
    session.document.timelines[0]!.clips[1]!.duration = 2;
    session.loadDocument(session.document);
    const pool = new VanishingMediaPool();
    const target = new RecordingTarget();
    const player = new PreviewPlayer({ canvas: target, session, mediaPool: pool, audioContext: null });
    const ticks: number[] = [];
    const errors: { mediaId: string | null; error: unknown }[] = [];
    player.onTimeUpdate = (time) => ticks.push(time.asNumber());
    player.onRenderError = (error, mediaId) => errors.push({ mediaId, error });
    return { session, pool, target, player, ticks, errors };
  }

  it('el error se atrapa, se pinta «Media Missing» en rojo y el bucle rAF sigue vivo', async () => {
    const { pool, target, player, ticks, errors } = playRig();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      player.play();
      await sleep(60);
      expect(player.isPlaying).toBe(true);
      const ticksBefore = ticks.length;
      expect(ticksBefore).toBeGreaterThan(0);

      // The user deletes m1 from the bin / OPFS mid-playback.
      pool.deleted.add('m1');
      target.ctx.calls = [];
      await sleep(120);

      // The loop kept ticking and the clock kept advancing.
      expect(player.isPlaying).toBe(true);
      expect(ticks.length).toBeGreaterThan(ticksBefore + 2);
      expect(ticks.at(-1)!).toBeGreaterThan(ticks[ticksBefore - 1]!);
      expect(pool.failures).toBeGreaterThan(1);
      // One report for the missing file, no matter how many frames failed.
      expect(errors.filter((entry) => entry.mediaId === 'm1')).toHaveLength(1);
      expect(errors.some((entry) => entry.mediaId === null)).toBe(false);
      // The red card, with its caption, replaced the clip…
      const card = target.ctx.calls.filter((call) => call.op === 'fillRect' && call.fill === MISSING_MEDIA_COLORS.fill);
      expect(card.length).toBeGreaterThan(0);
      expect(target.ctx.calls.some((call) => call.op === 'fillText' && call.text === MISSING_MEDIA_LABEL)).toBe(true);
      // …while the healthy clip on the other lane still drew.
      expect(target.ctx.calls.some((call) => call.op === 'drawImage')).toBe(true);
      expect(unhandled).toEqual([]);
    } finally {
      player.destroy();
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('volver a vincular (clearMediaErrors + archivo restaurado) recupera la imagen y vuelve a avisar si falla otra vez', async () => {
    const { pool, target, player, errors } = playRig();
    pool.deleted.add('m1');
    await player.renderOnce();
    expect(errors).toHaveLength(1);
    pool.deleted.clear();
    player.clearMediaErrors();
    target.ctx.calls = [];
    await player.renderOnce();
    expect(target.ctx.calls.some((call) => call.op === 'fillText' && call.text === MISSING_MEDIA_LABEL)).toBe(false);
    pool.deleted.add('m1');
    await player.renderOnce();
    expect(errors).toHaveLength(2);
    player.destroy();
  });

  it('un fallo total del composite pinta un fotograma de error sin romper la cadena de renders', async () => {
    const { session, target, player, errors } = playRig();
    const engine = session.engine;
    vi.spyOn(engine, 'tracks').mockImplementation(() => {
      throw new Error('motor corrupto');
    });
    await expect(player.renderOnce()).resolves.toBeUndefined();
    expect(errors.at(-1)?.mediaId).toBeNull();
    expect(target.ctx.calls.some((call) => call.op === 'fillText' && call.text === 'Error de previsualización')).toBe(true);
    vi.restoreAllMocks();
    target.ctx.calls = [];
    await expect(player.renderOnce()).resolves.toBeUndefined();
    expect(target.ctx.calls.some((call) => call.op === 'drawImage')).toBe(true);
    player.destroy();
  });

  it('los renders nunca se solapan: 20 peticiones con decodificación lenta = como mucho 2 composites seguidos', async () => {
    const { pool, player } = playRig();
    let active = 0;
    let peak = 0;
    let started = 0;
    const original = pool.getFrame.bind(pool);
    vi.spyOn(pool, 'getFrame').mockImplementation(async (id, time) => {
      active += 1;
      started += 1;
      peak = Math.max(peak, active);
      await sleep(5);
      active -= 1;
      return original(id, time);
    });
    const requests = Array.from({ length: 20 }, () => player.renderOnce());
    await Promise.all(requests);
    // Two layers per composite are fetched sequentially; never two composites at once.
    expect(peak).toBe(1);
    expect(started).toBeLessThanOrEqual(4);
    player.destroy();
  });

  it('la seek posterior al borrado tampoco deja promesas sin manejar', async () => {
    const { pool, player, errors } = playRig();
    pool.deleted.add('m1');
    pool.deleted.add('m2');
    // Seeks coalesce: the queued render paints the *last* position (1 s,
    // where both lanes are on screen).
    for (const t of [3, 0.5, 1.5, 1]) player.seekTo(Rational.approximate(t) ?? Rational.ZERO);
    await player.renderOnce();
    expect(new Set(errors.map((entry) => entry.mediaId))).toEqual(new Set(['m1', 'm2']));
    player.destroy();
  });
});
