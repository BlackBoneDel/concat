// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

// @vitest-environment jsdom
/**
 * Fase 7 — QA de casos límite:
 *  1. micro-clip de 1 fotograma con un crossfade de 1 s;
 *  2. split en el borde exacto (time = 0 / time = duración);
 *  3. exportación con resolución 0×0 o 0 fps (división por cero).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Rational } from '../src/core/rational.ts';
import {
  AddTransitionOperation,
  EditError,
  SetTransitionPropertyOperation,
  SplitClipOperation,
  TrimClipOperation,
  transitionLimit,
} from '../src/editor/operations.ts';
import { ExportController, type ExportEnvironment } from '../src/export/export-controller.ts';
import { frameDelayCentiseconds, GifEncoder } from '../src/export/gif-exporter.ts';
import { FrameClock } from '../src/export/frame-clock.ts';
import { defaultExportConfig, ExportError, validateExportConfig, type ExportConfig, type ExportProgress } from '../src/export/types.ts';
import { VideoEncoderPool } from '../src/export/video-encoder-pool.ts';
import { MIN_CLIP_DURATION } from '../src/model/wire.ts';
import { renderFrame } from '../src/render/index.ts';
import type { EditSession } from '../src/session/edit-session.ts';
import { EditorClip } from '../src/session/editor-clip.ts';
import { clipById, clipsOf, makeSession, r } from './f3-helpers.ts';
import { FakeMedia, FakeSurface, FakeVideoEncoder } from './f6-helpers.ts';
import { DeletableFramePool, RecordingTarget } from './f7-helpers.ts';

/** The engine clip compiled from document clip `docId`. */
function engineClip(session: EditSession, docId: string): EditorClip {
  for (const trackId of session.engine.trackIds()) {
    for (const id of session.engine.track(trackId)?.clips() ?? []) {
      const clip = session.engine.clip(id);
      if (clip instanceof EditorClip && clip.docId === docId) return clip;
    }
  }
  throw new Error(`no engine clip ${docId}`);
}

/** A session whose errors are collected instead of logged. */
function quietSession(clips: Parameters<typeof makeSession>[0]): { session: EditSession; errors: string[] } {
  const errors: string[] = [];
  const session = makeSession(clips, { onError: (message) => errors.push(message) });
  return { session, errors };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Caso límite 1 — micro-clip de 1 fotograma + crossfade de 1 s', () => {
  const frame = (session: EditSession): number => session.frameRate.frameDuration().asNumber();

  /** c1 = 0..1 s, c2 = 1 s .. 1 s + 1 frame. */
  function microClip(): { session: EditSession; errors: string[]; oneFrame: number } {
    const fixture = quietSession([{ start: 0, duration: 1 }, { start: 1, duration: 1 }]);
    const oneFrame = frame(fixture.session);
    const ok = fixture.session.run(new TrimClipOperation('c2', 'out', r(2), r(1 + oneFrame)));
    expect(ok).toBe(true);
    expect(clipById(fixture.session, 'c2').duration).toBeCloseTo(oneFrame, 5);
    return { ...fixture, oneFrame };
  }

  it('rechaza el crossfade de 1 s con un EditError claro (sin tocar el documento)', () => {
    const { session, errors, oneFrame } = microClip();
    const before = session.history.currentDoc;
    expect(() => session.history.execute(new AddTransitionOperation('c1', 'c2', 'crossfade', r(1)))).toThrow(EditError);
    expect(() => session.history.execute(new AddTransitionOperation('c1', 'c2', 'crossfade', r(1)))).toThrow(/mitad del clip más corto/);
    // Through the session (what the UI calls): a toast, never an exception.
    expect(session.run(new AddTransitionOperation('c1', 'c2', 'crossfade', r(1)))).toBe(false);
    session.setTransition('c2', 'crossfade', 1);
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(session.history.currentDoc).toBe(before);
    expect(clipById(session, 'c2').transitionIn).toBeNull();
    // The ceiling the operations enforce is the micro-clip itself.
    expect(transitionLimit(session.document, clipById(session, 'c2'))).toBeCloseTo(oneFrame, 5);
  });

  it('un crossfade válido no puede estirarse después a 1 s (SetTransitionProperty)', () => {
    const { session } = microClip();
    const half = clipById(session, 'c2').duration / 2 - 1e-6;
    expect(session.run(new AddTransitionOperation('c1', 'c2', 'crossfade', r(half)))).toBe(true);
    expect(() =>
      session.history.execute(new SetTransitionPropertyOperation('tr:c2:in', 'duration', half, 1)),
    ).toThrow(/más que el clip más corto/);
    expect(() => session.history.execute(new SetTransitionPropertyOperation('tr:c2:in', 'duration', half, Number.NaN))).toThrow(EditError);
    expect(clipById(session, 'c2').transitionIn?.duration).toBeCloseTo(half, 5);
  });

  it('un documento con la transición más larga que el clip se clampa en el render (rampa finita, llega a 1)', () => {
    const { session, oneFrame } = microClip();
    // A hand-edited / legacy project: bypasses the operations on purpose.
    const doc = session.document;
    const c2 = doc.timelines[0]!.clips.find((clip) => clip.id === 'c2')!;
    c2.transitionIn = { id: 'crossfade', duration: 1 };
    session.loadDocument(doc);
    const compiled = engineClip(session, 'c2');
    expect(compiled.video_fade_in.asNumber()).toBeCloseTo(oneFrame, 5);
    const start = compiled.start;
    const mid = start.add(Rational.approximate(oneFrame / 2) ?? Rational.ZERO);
    expect(compiled.videoFadeFactor(start)).toBe(0);
    expect(compiled.videoFadeFactor(mid)).toBeCloseTo(0.5, 3);
    // Without the clamp this would have been (frame/2)/1 ≈ 0.017.
    expect(compiled.videoFadeFactor(mid)).toBeGreaterThan(0.4);
  });

  it('el compositor dibuja todos los instantes del micro-clip sin lanzar ni producir alpha no finita', async () => {
    const { session, oneFrame } = microClip();
    const doc = session.document;
    doc.timelines[0]!.clips.find((clip) => clip.id === 'c2')!.transitionIn = { id: 'crossfade', duration: 1 };
    session.loadDocument(doc);
    const pool = new DeletableFramePool();
    for (const t of [0.999, 1, 1 + oneFrame / 4, 1 + oneFrame / 2, 1 + oneFrame * 0.99, 1 + oneFrame]) {
      const target = new RecordingTarget();
      await expect(renderFrame(session.engine, Rational.approximate(t) ?? Rational.ZERO, target, pool)).resolves.toBeUndefined();
      for (const call of target.ctx.calls) {
        expect(Number.isFinite(call.alpha)).toBe(true);
        expect(call.alpha).toBeGreaterThanOrEqual(0);
        expect(call.alpha).toBeLessThanOrEqual(1);
        for (const value of call.args) expect(Number.isFinite(value)).toBe(true);
      }
    }
    expect(pool.requested.length).toBeGreaterThan(0);
  });

  it('recortar un clip por debajo de su transición sigue siendo renderizable', async () => {
    const { session } = quietSession([{ start: 0, duration: 2 }, { start: 2, duration: 2 }]);
    expect(session.run(new AddTransitionOperation('c1', 'c2', 'crossfade', r(1)))).toBe(true);
    const oneFrame = frame(session);
    expect(session.run(new TrimClipOperation('c2', 'out', r(4), r(2 + oneFrame)))).toBe(true);
    const compiled = engineClip(session, 'c2');
    expect(compiled.video_fade_in.compare(compiled.duration)).toBeLessThanOrEqual(0);
    const target = new RecordingTarget();
    await renderFrame(session.engine, Rational.approximate(2 + oneFrame / 2) ?? Rational.ZERO, target, new DeletableFramePool());
    expect(target.ctx.calls.some((call) => call.op === 'drawImage')).toBe(true);
  });
});

describe('Caso límite 2 — split en el borde exacto', () => {
  it.each([
    ['time = 0 (inicio del clip)', 0],
    ['time = duración (final del clip)', 2],
    ['dentro de una milésima del inicio', 1e-6],
    ['medio fotograma antes del final', 2 - MIN_CLIP_DURATION / 2],
  ])('%s: EditError claro y ningún clip de duración < 1 fotograma', (_label, at) => {
    const { session } = quietSession([{ start: 0, duration: 2 }]);
    const before = session.history.currentDoc;
    expect(() => session.history.execute(new SplitClipOperation('c1', r(at)))).toThrow(EditError);
    expect(session.run(new SplitClipOperation('c1', r(at)))).toBe(false);
    expect(session.history.currentDoc).toBe(before);
    expect(clipsOf(session)).toHaveLength(1);
    expect(clipsOf(session).every((clip) => clip.duration >= MIN_CLIP_DURATION)).toBe(true);
  });

  it('los mensajes distinguen "fuera del clip" de "fragmento fantasma"', () => {
    const { session } = quietSession([{ start: 2, duration: 2 }]);
    expect(() => session.history.execute(new SplitClipOperation('c1', r(2)))).toThrow(/dentro del clip/);
    expect(() => session.history.execute(new SplitClipOperation('c1', r(4)))).toThrow(/dentro del clip/);
    // time = duración en coordenadas locales cae fuera de un clip que empieza en 2 s.
    expect(() => session.history.execute(new SplitClipOperation('c1', r(2)))).toThrow(EditError);
    expect(() => session.history.execute(new SplitClipOperation('c1', r(2 + 1e-4)))).toThrow(/menos de un fotograma/);
  });

  it('EditSession.splitClip devuelve null en los bordes y no crea clips', () => {
    const { session, errors } = quietSession([{ start: 0, duration: 2 }]);
    expect(session.splitClip('c1', 0)).toBeNull();
    expect(session.splitClip('c1', 2)).toBeNull();
    expect(clipsOf(session)).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it('un split válido sigue funcionando y se deshace limpio', () => {
    const { session } = quietSession([{ start: 0, duration: 2 }]);
    const tail = session.splitClip('c1', MIN_CLIP_DURATION * 2);
    expect(tail).not.toBeNull();
    expect(clipsOf(session).map((clip) => clip.duration).sort((a, b) => a - b)[0]).toBeGreaterThanOrEqual(MIN_CLIP_DURATION - 1e-9);
    session.undo();
    expect(clipsOf(session)).toHaveLength(1);
    expect(clipById(session, 'c1').duration).toBe(2);
  });
});

describe('Caso límite 3 — exportación 0×0 / 0 fps', () => {
  function config(overrides: Partial<ExportConfig>): ExportConfig {
    return { ...defaultExportConfig(), width: 64, height: 36, frameRate: { num: 10, den: 1 }, videoBitrate: 500_000, ...overrides };
  }

  function spyEnvironment(): {
    env: ExportEnvironment;
    media: FakeMedia;
    calls: { surface: number; encoder: number; probe: number; composite: number };
  } {
    const session = makeSession([{ start: 0, duration: 1 }]);
    const media = new FakeMedia();
    media.originals.add('m1');
    const calls = { surface: 0, encoder: 0, probe: 0, composite: 0 };
    const env: ExportEnvironment = {
      getDocument: () => session.document,
      media,
      getFFmpeg: () => null,
      createSurface: (w, h) => {
        calls.surface += 1;
        return new FakeSurface(w, h);
      },
      composite: async () => {
        calls.composite += 1;
      },
      createVideoEncoder: (callbacks) => {
        calls.encoder += 1;
        return new FakeVideoEncoder(callbacks);
      },
      isVideoConfigSupported: async () => {
        calls.probe += 1;
        return true;
      },
      hasWebCodecs: () => true,
      yieldToUi: async () => {},
    };
    return { env, media, calls };
  }

  it.each<[string, Partial<ExportConfig>]>([
    ['0×0', { width: 0, height: 0 }],
    ['ancho 0', { width: 0 }],
    ['alto negativo', { height: -36 }],
    ['ancho NaN', { width: Number.NaN }],
    ['0 fps', { frameRate: { num: 0, den: 1 } }],
    ['denominador 0', { frameRate: { num: 30, den: 0 } }],
    ['fps negativo', { frameRate: { num: -30, den: 1 } }],
    ['fps fraccionario no entero', { frameRate: { num: 29.97, den: 1 } }],
    ['GIF 0 fps', { format: 'gif', frameRate: { num: 0, den: 1 } }],
  ])('%s: INVALID_RANGE antes de construir superficie o codificadores', async (_label, overrides) => {
    const { env, media, calls } = spyEnvironment();
    const controller = new ExportController(env);
    const reports: ExportProgress[] = [];
    controller.onProgress((progress) => reports.push(progress));
    const bad = config(overrides);
    expect(validateExportConfig(bad).length).toBeGreaterThan(0);
    const failure = await controller.start(bad).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ExportError);
    expect((failure as ExportError).code).toBe('INVALID_RANGE');
    expect(calls).toEqual({ surface: 0, encoder: 0, probe: 0, composite: 0 });
    // The media pool was never switched to originals.
    expect(media.forced).toEqual([]);
    expect(reports.at(-1)?.phase).toBe('error');
    expect(controller.running).toBe(false);
  });

  it('el controlador sigue usable después de una configuración inválida', async () => {
    const { env, calls } = spyEnvironment();
    const controller = new ExportController(env);
    await expect(controller.start(config({ width: 0, height: 0 }))).rejects.toBeInstanceOf(ExportError);
    const result = await controller.start(config({ audioCodec: 'none' }));
    expect(result.frames).toBe(10);
    expect(calls.encoder).toBe(1);
  });

  it('defensa en profundidad: FrameClock, VideoEncoderPool, GifEncoder y los retardos GIF', () => {
    expect(() => new FrameClock(Rational.ZERO, Rational.ONE, Rational.ZERO)).toThrow(ExportError);
    expect(() => new VideoEncoderPool(config({ width: 0, height: 0 }), { onPacket: () => undefined })).toThrow(/inválidos/);
    expect(() => new VideoEncoderPool(config({ frameRate: { num: 30, den: 0 } }), { onPacket: () => undefined })).toThrow(ExportError);
    expect(() => new GifEncoder(0, 0, defaultExportConfig().gif)).toThrow(ExportError);
    for (const fps of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const delay = frameDelayCentiseconds(3, fps);
      expect(Number.isFinite(delay)).toBe(true);
      expect(delay).toBeGreaterThanOrEqual(2);
    }
  });
});

// -- Fase 7+: panel de diagnóstico ?debug=1 --------------------------------

import {
  collectDiagnostics,
  debugEnabled,
  detectEngineName,
  mountDebugPanel,
  renderDebugPanel,
  type DebugEnvironment,
  type DebugInfo,
} from '../src/ui/debug-panel.ts';

const FIREFOX_UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0';
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const SAFARI_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';

/** An OPFS double; `writable` toggles the Safari 17 gap. */
function fakeOpfs(writable: boolean, removed: string[] = []) {
  return {
    getDirectory: async () => ({
      getDirectoryHandle: async () => ({
        getFileHandle: async () => (writable ? { createWritable: async () => undefined } : {}),
        removeEntry: async (name: string) => void removed.push(name),
      }),
    }),
  };
}

function env(overrides: Partial<DebugEnvironment> = {}): DebugEnvironment {
  return {
    userAgent: FIREFOX_UA,
    probe: { canPlayType: () => '' },
    storage: null,
    indexedDb: true,
    serviceWorker: null,
    cacheKeys: async () => ['concat-web-v8-abc', 'concat-runtime-v8-abc'],
    webcodecs: { videoDecoder: true, videoEncoder: false },
    ...overrides,
  };
}

describe('panel de diagnóstico ?debug=1', () => {
  it('debugEnabled solo activa con debug=1', () => {
    expect(debugEnabled('?debug=1')).toBe(true);
    expect(debugEnabled('?debug=0')).toBe(false);
    expect(debugEnabled('?debug')).toBe(false);
    expect(debugEnabled('')).toBe(false);
    expect(debugEnabled('?other=1')).toBe(false);
    expect(debugEnabled('?a=1&debug=1&b=2')).toBe(true);
  });

  it('detectEngineName reconoce los tres motores', () => {
    expect(detectEngineName(FIREFOX_UA)).toBe('firefox');
    expect(detectEngineName(CHROME_UA)).toBe('chromium');
    expect(detectEngineName(SAFARI_UA)).toBe('safari');
    expect(detectEngineName('some-crawler/1.0')).toBe('chromium');
  });

  it('collectDiagnostics informa motor, WebCodecs, caches y versión v10', async () => {
    const info = await collectDiagnostics(env());
    expect(info.engine).toBe('firefox');
    expect(info.videoDecoder).toBe(true);
    expect(info.videoEncoder).toBe(false);
    expect(info.indexedDb).toBe(true);
    expect(info.cacheVersion).toBe('v10');
    // The keys are whatever the platform reports — never filtered by version.
    expect(info.caches).toEqual(['concat-web-v8-abc', 'concat-runtime-v8-abc']);
    // jsdom-style probe ('' to everything) → the documented baseline matrix.
    expect(info.containers).toContain('mp4');
    expect(info.video.length).toBeGreaterThan(0);
  });

  it('detecta el hueco de Safari 17: OPFS presente, createWritable ausente', async () => {
    const info = await collectDiagnostics(env({ userAgent: SAFARI_UA, storage: fakeOpfs(false) }));
    expect(info.engine).toBe('safari');
    expect(info.opfs).toBe(true);
    expect(info.opfsWritable).toBe(false);
  });

  it('en Chromium OPFS es escribible y la sonda se limpia', async () => {
    const removed: string[] = [];
    const info = await collectDiagnostics(env({ userAgent: CHROME_UA, storage: fakeOpfs(true, removed) }));
    expect(info.opfs).toBe(true);
    expect(info.opfsWritable).toBe(true);
    expect(removed).toEqual(['.concat-probe']);
  });

  it('estima el almacenamiento y tolera fallos de estimate/getDirectory', async () => {
    const withEstimate = await collectDiagnostics(
      env({ storage: { estimate: async () => ({ usage: 5 * 1024 * 1024, quota: 1024 * 1024 * 1024 }) } }),
    );
    expect(withEstimate.estimate).toEqual({ usage: 5 * 1024 * 1024, quota: 1024 * 1024 * 1024 });
    const throwing = await collectDiagnostics(
      env({
        storage: {
          estimate: async () => {
            throw new Error('denied');
          },
          getDirectory: async () => {
            throw new Error('blocked');
          },
        },
      }),
    );
    expect(throwing.estimate).toBeNull();
    expect(throwing.opfs).toBe(false);
  });

  it('renderDebugPanel pinta las filas y el botón de cerrar', () => {
    const host = document.createElement('div');
    const info: DebugInfo = {
      userAgent: FIREFOX_UA,
      engine: 'firefox',
      videoDecoder: true,
      videoEncoder: false,
      containers: ['mp4', 'webm'],
      video: ['h264'],
      audio: ['aac'],
      opfs: true,
      opfsWritable: false,
      indexedDb: true,
      estimate: { usage: 1024, quota: 2048 },
      serviceWorker: { supported: true, controlled: true, registrations: 1 },
      cacheVersion: 'v8',
      caches: ['concat-web-v8-x'],
    };
    const panel = renderDebugPanel(host, info);
    expect(panel.classList.contains('debug-panel')).toBe(true);
    const text = panel.textContent ?? '';
    expect(text).toContain('Diagnóstico (cache v8)');
    expect(text).toContain('firefox');
    expect(text).toContain('escritura: no'); // the Safari 17 gap, visible
    expect(text).toContain('concat-web-v8-x');
    expect(panel.querySelector('dl')?.children.length).toBeGreaterThanOrEqual(20);
    (panel.querySelector('.debug-panel-close') as HTMLButtonElement).click();
    expect(host.querySelector('.debug-panel')).toBeNull();
  });

  it('mountDebugPanel solo monta con ?debug=1', async () => {
    const host = document.createElement('div');
    expect(await mountDebugPanel(host, '', env())).toBeNull();
    expect(host.querySelector('.debug-panel')).toBeNull();
    const panel = await mountDebugPanel(host, '?debug=1', env());
    expect(panel).not.toBeNull();
    expect(host.querySelector('.debug-panel')).toBe(panel);
  });
});
