// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors
// @vitest-environment jsdom

/**
 * The Fase 4 media services end to end, plus the integration path:
 * import → automatic proxy → preview reads the proxy → export reads the original.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaToolkit, type ToolkitHost } from '../src/app/media-toolkit.ts';
import { Rational } from '../src/core/rational.ts';
import { MediaDecoder } from '../src/media/decoder.ts';
import { MediaPool } from '../src/media/media-pool.ts';
import { ProxyGenerator } from '../src/media/proxy/proxy-generator.ts';
import { ProxyQueue } from '../src/media/proxy/proxy-queue.ts';
import { ProxyStore } from '../src/media/proxy/proxy-store.ts';
import { HashValidator } from '../src/media/relink/hash-validator.ts';
import type { MediaItem } from '../src/model/document.ts';
import type { RenderImage } from '../src/render/types.ts';
import { EditSession } from '../src/session/edit-session.ts';
import { MemoryKeyValue } from '../src/storage/idb.ts';
import { MediaStore } from '../src/storage/media-store.ts';
import { MemoryProxyFiles, ProxyRecordStore } from '../src/storage/proxy-store.ts';
import { Notifications } from '../src/ui/notifications.ts';
import { WorkerClient } from '../src/workers/worker-client.ts';
import { makeMedia } from './f3-helpers.ts';
import { tinyMp4 } from './f4-helpers.ts';

interface Rig {
  toolkit: MediaToolkit;
  host: ToolkitHost;
  session: EditSession;
  pool: MediaPool;
  toasts: HTMLElement;
  runs: number;
}

function rig(): Rig {
  const session = new EditSession();
  const pool = new MediaPool();
  const mediaStore = new MediaStore(new MemoryKeyValue());
  const toasts = document.createElement('div');
  document.body.appendChild(toasts);
  const store = new ProxyStore(new ProxyRecordStore(new MemoryKeyValue()), new MemoryProxyFiles(), { hash: async (blob) => `h${blob.size}` });
  const generator = new ProxyGenerator(store, new ProxyQueue(2), {
    runner: async (_job, onProgress) => {
      onProgress(0.5);
      return { blob: tinyMp4(1280, 720, 'proxy.mp4'), width: 1280, height: 720, duration: 0.2, codec: 'avc1.42E01E' };
    },
  });
  const state: Rig = { runs: 0 } as Rig;
  const host: ToolkitHost = {
    session,
    pool,
    mediaStore,
    notifications: new Notifications(toasts),
    previewCanvas: () => null,
    importOne: async (file: File): Promise<MediaItem> => {
      const id = `m-${file.name}`;
      const asset = await pool.addMedia(file, id, file.name);
      const info = pool.getDecoder(id)?.mediaInfo;
      if (info) await mediaStore.importFile(file, info, id, file.name);
      const item: MediaItem = { ...makeMedia(id, asset.duration.asNumber()), name: file.name, width: asset.width, height: asset.height, extra: {} };
      session.addMediaItem(item);
      await state.toolkit.fingerprint(id, file);
      if (info) state.toolkit.autoProxy(id, info);
      return item;
    },
    afterEdit: () => {
      state.runs += 1;
    },
    requestRender: () => undefined,
  };
  const toolkit = new MediaToolkit(host, { proxyStore: store, generator, hasher: new HashValidator(new WorkerClient(() => null)) });
  Object.assign(state, { toolkit, host, session, pool, toasts });
  return state;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('integration: import → proxy → preview → export', () => {
  it('previews through the proxy and exports from the original', async () => {
    const r = rig();
    await r.toolkit.init();
    const item = await r.host.importOne(tinyMp4(1920, 1080, 'cam.mp4'));
    const id = item.id;
    // Fingerprint for relinking.
    expect(item.extra['fileSize']).toBeGreaterThan(0);
    expect(String(item.extra['sha256'])).toMatch(/^[0-9a-f]{64}$/);
    // 1920×1080 → automatic proxy, attached once stored.
    await vi.waitFor(() => expect(r.pool.hasProxy(id)).toBe(true));
    expect(r.toolkit.proxyState(id).status).toBe('ready');
    expect(r.pool.getSize(id)).toEqual({ width: 1280, height: 720 });

    const reads: string[] = [];
    const frame = { width: 1, height: 1 } as RenderImage;
    vi.spyOn(MediaDecoder.prototype, 'getFrame').mockImplementation(function (this: MediaDecoder) {
      reads.push(this.id);
      return Promise.resolve(frame);
    });
    await r.pool.getFrame(id, Rational.ZERO);
    expect(reads.pop()).toBe(`${id}:proxy`);
    const originals = r.pool.originalFrames();
    await originals.getFrame(id, Rational.ZERO);
    expect(reads.pop()).toBe(id);
    expect(originals.getSize(id)).toEqual({ width: 1920, height: 1080 });

    // Toggle off (persisted): preview reads the original too.
    r.toolkit.toggleProxies();
    expect(r.toolkit.proxiesEnabled).toBe(false);
    expect(localStorage.getItem('concat.useProxies')).toBe('0');
    await r.pool.getFrame(id, Rational.ZERO);
    expect(reads.pop()).toBe(id);

    r.toolkit.deleteProxy(id);
    await vi.waitFor(() => expect(r.pool.hasProxy(id)).toBe(false));
    expect(r.toolkit.proxyState(id).status).toBe('none');
  });

  it('skips proxies for light media and clears every proxy on demand', async () => {
    const r = rig();
    await r.toolkit.init();
    const small = await r.host.importOne(tinyMp4(640, 360, 'small.mp4'));
    expect(r.toolkit.proxyState(small.id).status).toBe('none');
    r.toolkit.generateProxy(small.id, 'low');
    await vi.waitFor(() => expect(r.pool.hasProxy(small.id)).toBe(true));
    await r.toolkit.clearProxies();
    expect(r.pool.hasProxy(small.id)).toBe(false);
    expect(r.toasts.textContent).toContain('Proxies borrados');
  });
});

describe('MediaToolkit services', () => {
  it('imports SRT onto new lanes (one undoable op) and exports it back', async () => {
    const r = rig();
    const srt = '1\n00:00:01,000 --> 00:00:02,500\nHola <i>mundo</i>\n\n2\n00:00:03,000 --> 00:00:04,000\nAdiós\n';
    await r.toolkit.importSubtitles(new File([srt], 'demo.srt'));
    const texts = r.session.document.timelines[0]!.clips.filter((c) => c.kind === 'text');
    expect(texts).toHaveLength(2);
    expect(r.runs).toBe(1);
    let written = '';
    const create = vi.fn((blob: Blob) => {
      void blob.text().then((t) => { written = t; });
      return 'blob:x';
    });
    const saved = { createObjectURL: URL.createObjectURL, revokeObjectURL: URL.revokeObjectURL };
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
    try {
      r.toolkit.exportSubtitles('srt');
    } finally {
      Object.assign(URL, saved);
    }
    expect(create).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(written).toBe(srt));
    r.session.undo();
    expect(r.session.document.timelines[0]!.clips.filter((c) => c.kind === 'text')).toHaveLength(0);
  });

  it('reports empty subtitle files and nothing-to-export', async () => {
    const r = rig();
    await r.toolkit.importSubtitles(new File(['basura'], 'x.srt'));
    expect(r.toasts.textContent).toContain('Subtítulos vacíos');
    r.toolkit.exportSubtitles('vtt');
    expect(r.toasts.textContent).toContain('Nada que exportar');
  });

  it('loads .cube LUTs and reports parse errors with their line', async () => {
    const r = rig();
    const bad = await r.toolkit.importLut(new File(['LUT_3D_SIZE 2\n0 0 0\n0 0 abc\n'], 'bad.cube'));
    expect(bad).toBeNull();
    expect(r.toasts.textContent).toMatch(/LUT inválida \(línea \d+\)/);
    const rows = Array.from({ length: 8 }, (_, i) => `${i & 1} ${(i >> 1) & 1} ${(i >> 2) & 1}`).join('\n');
    const good = await r.toolkit.importLut(new File([`TITLE "Id"\nLUT_3D_SIZE 2\n${rows}\n`], 'id.cube'));
    expect(good && r.toolkit.luts.get(good.id)).toBeTruthy();
  });

  it('detects offline media and relinks it keeping the id', async () => {
    const r = rig();
    r.session.addMediaItem({ ...makeMedia('gone', 0.2), name: 'cam.mp4', path: 'cam.mp4', width: 640, height: 360, extra: {} });
    await r.toolkit.refreshOffline();
    expect([...r.toolkit.offlineIds]).toEqual(['gone']);
    expect(r.toasts.textContent).toContain('Medios sin conexión');
    const file = tinyMp4(640, 360, 'cam.mp4');
    await r.toolkit.applyRelink([{ mediaId: 'gone', file, path: 'carpeta/cam.mp4', score: 0.95 }]);
    expect(r.pool.get('gone')?.name).toBe('cam.mp4');
    expect(r.toolkit.offlineIds.size).toBe(0);
    const item = r.session.document.media.find((m) => m.id === 'gone')!;
    expect(item.path).toBe('carpeta/cam.mp4');
    expect(String(item.extra['sha256'])).toMatch(/^[0-9a-f]{64}$/);
    r.session.undo();
    expect(r.session.document.media.find((m) => m.id === 'gone')!.path).toBe('cam.mp4');
  });

  it('extracts deep metadata of a pooled asset', async () => {
    const r = rig();
    const item = await r.host.importOne(tinyMp4(640, 360, 'meta.mp4'));
    const meta = await r.toolkit.metadata(item.id);
    expect(meta).toMatchObject({ container: 'mp4', width: 640, height: 360, aspectRatio: '16:9' });
    expect(await r.toolkit.metadata('nope')).toBeNull();
  });
});
