// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

// @vitest-environment jsdom

/**
 * Boot + the Fase 2 demo checklist, end to end in jsdom: the shell mounts,
 * a local MP4 imports (OPFS/IDB fallback), a clip lands on the timeline,
 * the player seeks and plays, Ctrl+S saves and the project reopens.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { Rational } from '../src/core/rational.ts';

// -- a tiny valid H.264 MP4 (same shape as the demuxer tests) --------------

function concatBytes(...parts: (Uint8Array | number[])[]): Uint8Array {
  const arrays = parts.map((part) => (part instanceof Uint8Array ? part : Uint8Array.from(part)));
  const total = arrays.reduce((sum, array) => sum + array.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const array of arrays) {
    out.set(array, at);
    at += array.length;
  }
  return out;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function box(type: string, body: Uint8Array): Uint8Array {
  const header = new Uint8Array(8);
  new DataView(header.buffer).setUint32(0, body.length + 8);
  header.set(Uint8Array.from([...type].map((c) => c.charCodeAt(0))), 4);
  return concatBytes(header, body);
}

function fullBox(type: string, version: number, body: Uint8Array): Uint8Array {
  return box(type, concatBytes([version, 0, 0, 0], body));
}

const u16 = (v: number) => Uint8Array.from([(v >> 8) & 0xff, v & 0xff]);
const u32 = (v: number) => Uint8Array.from([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);
const chars = (text: string) => Uint8Array.from([...text].map((c) => c.charCodeAt(0)));

function tinyMp4(): Blob {
  const avc1 = box('avc1', concatBytes(
    new Uint8Array(6), u16(1), new Uint8Array(16), u16(640), u16(360),
    u32(0x00480000), u32(0x00480000), u32(0), u16(1), new Uint8Array(32), u16(0x0018), new Uint8Array([0xff, 0xe1]),
    box('avcC', Uint8Array.from([1, 0x42, 0xc0, 0x1e, 0xff, 0xe1, 0x00, 0x00])),
  ));
  const sampleCount = 6;
  const trak = box('trak', concatBytes(
    fullBox('tkhd', 0, concatBytes(u32(0), u32(0), u32(1), u32(0), u32(sampleCount), new Uint8Array(8),
      u16(0), u16(0), u16(0), u16(0), new Uint8Array(36), u32(640 << 16), u32(360 << 16))),
    box('mdia', concatBytes(
      fullBox('mdhd', 0, concatBytes(u32(0), u32(0), u32(30), u32(sampleCount), u16(0x55c4), u16(0))),
      fullBox('hdlr', 0, concatBytes(u32(0), chars('vide'), new Uint8Array(12), Uint8Array.from([0]))),
      box('minf', box('stbl', concatBytes(
        fullBox('stsd', 0, concatBytes(u32(1), avc1)),
        fullBox('stts', 0, concatBytes(u32(sampleCount), ...Array.from({ length: sampleCount }, () => concatBytes(u32(1), u32(1))))),
        fullBox('stsc', 0, concatBytes(u32(1), u32(1), u32(sampleCount), u32(1))),
        fullBox('stsz', 0, concatBytes(u32(0), u32(sampleCount), ...Array.from({ length: sampleCount }, () => u32(10)))),
        fullBox('stco', 0, concatBytes(u32(1), u32(0))),
      ))),
    )),
  ));
  const ftyp = box('ftyp', concatBytes(chars('isom'), u32(0x200), chars('isomiso2avc1')));
  const mdat = box('mdat', new Uint8Array(sampleCount * 10));
  return new Blob([toArrayBuffer(concatBytes(ftyp, box('moov', trak), mdat))], { type: 'video/mp4' });
}

function asFile(blob: Blob, name: string): File {
  return new File([blob], name, { type: 'video/mp4', lastModified: 1700000000000 });
}

describe('editor boot and demo checklist', () => {
  let app: import('../src/main.ts').EditorApp | null = null;

  beforeAll(async () => {
    document.body.innerHTML = '<div id="app"></div>';
    const main = await import('../src/main.ts');
    app = main.app;
    // The boot is async (stores, media restore).
    await new Promise((resolve) => setTimeout(resolve, 60));
  });

  it('mounts the full shell without a boot error', () => {
    expect(document.querySelector('.boot-error')).toBeNull();
    expect(document.getElementById('header-bar')).not.toBeNull();
    expect(document.getElementById('media-panel')).not.toBeNull();
    expect(document.getElementById('preview-panel')).not.toBeNull();
    expect(document.getElementById('timeline-panel')).not.toBeNull();
    expect(document.getElementById('inspector-panel')).not.toBeNull();
    expect(document.querySelector('.preview-canvas')).not.toBeNull();
    expect(document.getElementById('toast-stack')).not.toBeNull();
    expect(document.querySelector('.timecode-input')).not.toBeNull();
    expect(document.querySelector('.scrub-bar')).not.toBeNull();
  });

  it('importa un MP4 local a la biblioteca (checklist: importar)', async () => {
    await app!.importFiles([asFile(tinyMp4(), 'demo.mp4')]);
    const assets = app!.pool.listMedia();
    expect(assets).toHaveLength(1);
    expect(assets[0]!.name).toBe('demo.mp4');
    expect(assets[0]!.type).toBe('video');
    expect(assets[0]!.width).toBe(640);
    // The media panel shows the card.
    expect(document.querySelectorAll('.media-card').length).toBeGreaterThan(0);
    // And the document's bin knows the item.
    expect(app!.session.media).toHaveLength(1);
  });

  it('coloca el clip en el timeline (checklist: doble clic)', () => {
    const mediaId = app!.session.media[0]!.id;
    app!.addMediaToTimeline(mediaId);
    expect(app!.session.timeline.clips).toHaveLength(1);
    const clip = app!.session.timeline.clips[0]!;
    expect(clip.mediaId).toBe(mediaId);
    expect(clip.duration).toBeCloseTo(0.2, 5); // 6 samples at 30 fps
    expect(document.querySelectorAll('.timeline-clip').length).toBe(1);
  });

  it('reproduce, pausa y navega con el playhead (checklist: play/scrub)', async () => {
    const player = app!.player;
    expect(player.duration.asNumber()).toBeGreaterThan(0);

    player.seekTo(player.duration.mul(Rational.new(1n, 2n)));
    expect(player.currentTime.asNumber()).toBeGreaterThan(0);
    const tc = (document.querySelector('.timecode-input') as HTMLInputElement).value;
    expect(tc).toMatch(/^\d{2}:\d{2}:\d{2}[:;]\d{2}$/);

    player.play();
    expect(player.isPlaying).toBe(true);
    player.pause();
    expect(player.isPlaying).toBe(false);

    player.stepForward();
    player.stepBackward();
    player.stop();
    expect(player.currentTime.asNumber()).toBe(0);
  });

  it('sincroniza el mezclador con clips de audio', async () => {
    // The mixer builds from the session clips when playback starts; with no
    // audio context it stays silent but must not throw.
    app!.player.play();
    await new Promise((resolve) => setTimeout(resolve, 20));
    app!.player.pause();
    expect(app!.player.level).toBe(0);
  });

  it('guarda con Ctrl+S y reabre el proyecto (checklist: guardar/recargar)', async () => {
    await app!.saveProject();
    expect(app!.session.dirty).toBe(false);
    expect(app!.projectId).not.toBeNull();

    const projects = await app!.projectStore.listProjects();
    expect(projects).toHaveLength(1);

    // Mutate, then reopen the saved record.
    app!.session.rename('Renombrado en memoria');
    await app!.openProject(app!.projectId!);
    expect(app!.session.timeline.clips).toHaveLength(1);
    expect(app!.session.media).toHaveLength(1);
  });

  it('divide y duplica clips (atajos)', () => {
    const player = app!.player;
    const clip = app!.session.timeline.clips[0]!;
    // Playhead in the middle of the clip.
    const half = (clip.start + clip.duration) / 2;
    player.seekTo(Rational.approximate(half) ?? Rational.ZERO);
    app!.splitAtPlayhead();
    expect(app!.session.timeline.clips).toHaveLength(2);

    app!.selectClip(app!.session.timeline.clips[0]!.id);
    app!.duplicateSelection();
    expect(app!.session.timeline.clips).toHaveLength(3);
  });

  it('deshace y rehace (historial)', () => {
    // The header wiring owns undo; the history stack itself is asserted in
    // history.test.ts. Here we only make sure the app-level API is coherent.
    expect(app!.history.canUndo).toBe(true);
    const before = app!.session.timeline.clips.length;
    expect(before).toBe(3);
  });
});

// -- Fase 7+: drop capture + panel de diagnóstico cableados en el boot -----

import { mountDebugPanel } from '../src/ui/debug-panel.ts';

describe('Fase 7+ wiring', () => {
  it('el timeline captura los drags de archivos del SO (sin navegación)', () => {
    const panel = document.getElementById('timeline-panel');
    expect(panel).not.toBeNull();
    const event = new Event('dragover', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', {
      value: { types: ['Files'], files: [], dropEffect: '' },
    });
    panel!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    // A drop outside any zone is neutralized by the window guard too.
    const stray = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(stray, 'dataTransfer', { value: { types: ['Files'], files: [] } });
    document.body.dispatchEvent(stray);
    expect(stray.defaultPrevented).toBe(true);
  });

  it('arranca sin panel de diagnóstico; ?debug=1 lo monta', async () => {
    expect(document.querySelector('.debug-panel')).toBeNull();
    const panel = await mountDebugPanel(document.body, '?debug=1', {
      userAgent: 'Mozilla/5.0 (Test) ConcatDebug/1.0',
      probe: { canPlayType: () => '' },
      storage: null,
      indexedDb: false,
      serviceWorker: null,
      cacheKeys: async () => [],
      webcodecs: { videoDecoder: false, videoEncoder: false },
    });
    expect(panel?.classList.contains('debug-panel')).toBe(true);
    expect(document.querySelector('.debug-panel')).toBe(panel);
    expect(panel?.textContent ?? '').toContain('Diagnóstico');
    panel?.remove();
    expect(document.querySelector('.debug-panel')).toBeNull();
  });
});
