// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** ProjectStore: save/load/list/delete through the injectable backend. */

import { describe, expect, it } from 'vitest';
import { MemoryKeyValue } from '../src/storage/idb.ts';
import { ProjectStore } from '../src/storage/project-store.ts';
import {
  createProjectDocument,
  documentSettingsVideo,
  type DocumentSettings,
} from '../src/model/document.ts';
import { activeTimeline } from '../src/model/document.ts';

const settings: DocumentSettings = {
  name: 'Mi proyecto',
  width: 1920,
  height: 1080,
  rateNum: 30,
  rateDen: 1,
};

function makeStore(): ProjectStore {
  return new ProjectStore(new MemoryKeyValue());
}

describe('ProjectStore', () => {
  it('saves and reloads a project with its name', async () => {
    const store = makeStore();
    const document = createProjectDocument(documentSettingsVideo(settings));
    const record = await store.saveProject(document, settings);
    expect(record.id).toBeTruthy();
    expect(record.name).toBe('Mi proyecto');
    expect(record.fileSize).toBeGreaterThan(0);

    const loaded = await store.loadProject(record.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe('Mi proyecto');
    // The document survives the wire round-trip with its video intact.
    expect(loaded!.document.timelines[0]!.video.width).toBe(1920);
    expect(loaded!.document.timelines[0]!.video.height).toBe(1080);
  });

  it('keeps clips and media through the round-trip', async () => {
    const store = makeStore();
    const document = createProjectDocument(documentSettingsVideo(settings));
    document.media.push({
      id: 'm1',
      path: 'media/m1',
      name: 'clip.mp4',
      duration: 4,
      kind: 'video',
      width: 1280,
      height: 720,
      frameRate: 30,
      frameRateFraction: '30/1',
      videoCodec: 'h264',
      audioCodec: null,
      hasAudio: true,
      audioTracks: [],
      slot: false,
      origin: null,
      colorRange: null,
      colorSpace: 'sdr',
      extra: {},
    });
    activeTimeline(document).clips.push({
      id: 'c1',
      trackId: activeTimeline(document).tracks[0]!.id,
      mediaId: 'm1',
      name: 'clip.mp4',
      kind: 'video',
      start: 1.5,
      duration: 3,
      sourceStart: 0.25,
      volume: 1,
      fadeIn: 0,
      fadeOut: 0,
      scale: 1,
      offsetX: 0,
      offsetY: 0,
      rotation: 0,
      stretchX: 1,
      stretchY: 1,
      opacity: 1,
      speed: 1,
      speedCurve: null,
      keys: [],
      flipH: false,
      flipV: false,
      blend: '',
      crop: null,
      cutout: null,
      preservePitch: true,
      filters: [],
      videoEffects: [],
      audioStream: null,
      muted: null,
      detachedFrom: null,
      transitionIn: null,
      enhanced: null,
      text: null,
      shape: null,
      extra: {},
    });

    const record = await store.saveProject(document, settings);
    const loaded = await store.loadProject(record.id);
    expect(loaded!.document.media).toHaveLength(1);
    expect(loaded!.document.media[0]!.name).toBe('clip.mp4');
    const clips = activeTimeline(loaded!.document).clips;
    expect(clips).toHaveLength(1);
    expect(clips[0]!.start).toBeCloseTo(1.5, 6);
    expect(clips[0]!.sourceStart).toBeCloseTo(0.25, 6);
    expect(clips[0]!.mediaId).toBe('m1');
  });

  it('overwrites by id and lists newest first', async () => {
    const store = makeStore();
    const document = createProjectDocument(documentSettingsVideo(settings));
    const record = await store.saveProject(document, settings);
    await new Promise((resolve) => setTimeout(resolve, 2));
    await store.saveProject(document, { ...settings, name: 'Renombrado' }, record.id);
    const projects = await store.listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]!.name).toBe('Renombrado');
    expect(projects[0]!.id).toBe(record.id);
  });

  it('returns null for missing or corrupt records', async () => {
    const store = makeStore();
    expect(await store.loadProject('nope')).toBeNull();

    const backend = new MemoryKeyValue();
    const broken = new ProjectStore(backend);
    await backend.put('projects', 'bad', { id: 'bad', name: 'x', document: 42, lastModified: 1, fileSize: 1 });
    expect(await broken.loadProject('bad')).toBeNull();
  });

  it('deletes and clears', async () => {
    const store = makeStore();
    const document = createProjectDocument(documentSettingsVideo(settings));
    const record = await store.saveProject(document, settings);
    await store.deleteProject(record.id);
    expect(await store.listProjects()).toHaveLength(0);
    await store.saveProject(document, settings);
    await store.clearAll();
    expect(await store.listProjects()).toHaveLength(0);
  });

  it('mints an id when omitted and keeps the given one', async () => {
    const store = makeStore();
    const document = createProjectDocument(documentSettingsVideo(settings));
    const a = await store.saveProject(document, settings);
    const b = await store.saveProject(document, settings, 'fixed-id');
    expect(a.id).not.toBe('fixed-id');
    expect(b.id).toBe('fixed-id');
  });
});
