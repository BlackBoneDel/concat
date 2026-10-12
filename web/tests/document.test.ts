// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_VERSION,
  blankClip,
  createProjectDocument,
  documentSettingsVideo,
  documentVersion,
  fromDocument,
  migrate,
  settle,
  toDocument,
  writeDocumentClip,
  type DocumentSettings,
  type ProjectDocument,
} from '../src/model/document.ts';
import type { Json } from '../src/model/wire.ts';

const settings: DocumentSettings = {
  name: 'Test project',
  width: 1920,
  height: 1080,
  rateNum: 30,
  rateDen: 1,
};

function withClips(project: ProjectDocument): ProjectDocument {
  const timeline = project.timelines[0]!;
  timeline.clips.push(
    { ...blankClip('c1', 'T1', 'video', 'intro', 0, 3), mediaId: 'm1' },
    { ...blankClip('c2', 'T2', 'text', 'title', 1, 2), text: null },
  );
  project.media.push({
    id: 'm1',
    path: 'a.mp4',
    name: 'a.mp4',
    duration: 10,
    kind: 'video',
    width: 1920,
    height: 1080,
    frameRate: 30,
    frameRateFraction: '30/1',
    videoCodec: 'h264',
    audioCodec: null,
    hasAudio: false,
    audioTracks: [],
    slot: false,
    origin: null,
    colorRange: null,
    colorSpace: 'sdr',
    extra: {},
  });
  return project;
}

describe('document version and migrations', () => {
  it('treats a document with no version as version 1', () => {
    expect(documentVersion({})).toBe(1);
    expect(documentVersion({ version: 0 })).toBe(0);
  });

  it('refuses a document from a later build', () => {
    expect(migrate({ version: DOCUMENT_VERSION + 1 })).toBeNull();
    expect(fromDocument({ version: DOCUMENT_VERSION + 1 })).toBeNull();
  });

  it('lifts the flat fields into the founding timeline', () => {
    const document: Json = {
      tracks: [{ id: 'T1', visible: true, muted: false }],
      clips: [writeDocumentClip({ ...blankClip('c1', 'T1', 'video', 'a', 0, 1), mediaId: 'm1' })],
      media: [{ id: 'm1', path: 'a.mp4', name: 'a.mp4', kind: 'video' }],
    };
    const project = fromDocument(document);
    expect(project).not.toBeNull();
    expect(project!.timelines).toHaveLength(1);
    expect(project!.timelines[0]!.id).toBe('TL1');
    expect(project!.timelines[0]!.clips).toHaveLength(1);
  });

  it('gives every timeline the shared frame, field by field', () => {
    const document: Json = {
      video: { width: 1280, height: 720, rateNum: 25, rateDen: 1 },
      timelines: [
        {
          id: 'TL1',
          name: 'Timeline 1',
          video: { width: 0, height: 1080, rateNum: 0, rateDen: 1 },
          tracks: [{ id: 'T1', visible: true, muted: false }],
          clips: [],
        },
      ],
    };
    const project = fromDocument(document);
    const video = project!.timelines[0]!.video;
    // Zero fields take the shared ones; the rest stay as written.
    expect(video.width).toBe(1280);
    expect(video.height).toBe(1080);
    expect(video.rateNum).toBe(25);
    expect(video.rateDen).toBe(1);
  });
});

describe('settle', () => {
  it('drops clips whose track or media is gone, and clears media on titles', () => {
    const project = withClips(createProjectDocument());
    const timeline = project.timelines[0]!;
    timeline.clips.push({ ...blankClip('c3', 'GONE', 'video', 'orphan', 0, 1), mediaId: 'm1' });
    timeline.clips.push({ ...blankClip('c4', 'T1', 'video', 'lost-media', 0, 1), mediaId: 'NOPE' });
    const settled = settle(project)!;
    const ids = settled.timelines[0]!.clips.map((clip) => clip.id);
    expect(ids).toEqual(['c1', 'c2']);
    // The title has no media behind it and needs none.
    expect(settled.timelines[0]!.clips[1]!.mediaId).toBe('');
  });

  it('refuses a document with no timeline that has a lane', () => {
    const project = createProjectDocument();
    project.timelines[0]!.tracks = [];
    expect(settle(project)).toBeNull();
    expect(fromDocument({ timelines: [] })).toBeNull();
  });

  it('keeps unknown fields so a newer build round-trips', () => {
    const document: Json = {
      timelines: [
        {
          id: 'TL1',
          name: 'Timeline 1',
          tracks: [{ id: 'T1', visible: true, muted: false }],
          clips: [{ id: 'c1', trackId: 'T1', kind: 'layer', futureField: 42 }],
          futureTimelineField: 'yes',
        },
      ],
      futureTopField: { kept: true },
    };
    const project = fromDocument(document)!;
    const timeline = project.timelines[0]!;
    expect(timeline.clips[0]!.extra['futureField']).toBe(42);
    expect(timeline.extra['futureTimelineField']).toBe('yes');
    expect(project.extra['futureTopField']).toEqual({ kept: true });

    const written = toDocument(settings, project) as Record<string, Json>;
    expect(written['futureTopField']).toEqual({ kept: true });
    expect((written['timelines'] as Json[])[0]).toMatchObject({ futureTimelineField: 'yes' });
  });

  it('tidies numbers a hand-edit could not have produced', () => {
    const document: Json = {
      timelines: [
        {
          id: 'TL1',
          name: 'Timeline 1',
          tracks: [{ id: 'T1', visible: true, muted: false }],
          clips: [
            {
              id: 'c1',
              trackId: 'T1',
              kind: 'text',
              start: -5,
              duration: 0,
              opacity: 9,
              scale: 100,
              rotation: 450,
              speed: 0,
            },
          ],
        },
      ],
    };
    const project = fromDocument(document)!;
    const clip = project.timelines[0]!.clips[0]!;
    expect(clip.start).toBe(0);
    expect(clip.duration).toBeCloseTo(1 / 60, 12);
    expect(clip.opacity).toBe(1);
    expect(clip.scale).toBe(8);
    expect(clip.rotation).toBe(90); // 450 wrapped into (-180, 180]
    expect(clip.speed).toBeCloseTo(0.0625, 12);
  });

  it('falls back to video for a clip kind this build has never heard of', () => {
    const document: Json = {
      timelines: [
        {
          id: 'TL1',
          name: 'Timeline 1',
          tracks: [{ id: 'T1', visible: true, muted: false }],
          clips: [{ id: 'c1', trackId: 'T1', kind: 'hologram' }],
        },
      ],
    };
    const project = fromDocument(document)!;
    // Unknown kind → video, which needs media that exists — none, so the clip
    // is settled away rather than crashing the load.
    expect(project.timelines[0]!.clips).toHaveLength(0);
    expect(project).not.toBeNull();
  });
});

describe('round trip', () => {
  it('writes version 1 + document and reads it back unchanged', () => {
    const project = withClips(createProjectDocument(documentSettingsVideo(settings)));
    const written = toDocument(settings, project) as Record<string, Json>;
    expect(written['version']).toBe(DOCUMENT_VERSION);
    expect(written['name']).toBe('Test project');
    // The active timeline is mirrored at the top level, where every build has
    // read it.
    expect(Array.isArray(written['tracks'])).toBe(true);
    expect((written['clips'] as Json[]).length).toBe(2);

    const reopened = fromDocument(written)!;
    expect(reopened.media).toHaveLength(1);
    expect(reopened.timelines[0]!.clips.map((clip) => clip.id)).toEqual(['c1', 'c2']);
    expect(reopened.activeTimelineId).toBe('TL1');

    // And again: writing the reopened project produces the same document.
    const rewritten = toDocument(settings, reopened);
    expect(rewritten).toEqual(written);
  });

  it('an empty object opens as a fresh project, like Project::default', () => {
    const project = fromDocument({})!;
    expect(project.timelines).toHaveLength(1);
    expect(project.timelines[0]!.tracks.map((track) => track.id)).toEqual(['T1', 'T2', 'T3', 'T4']);
    expect(project.activeTimelineId).toBe('TL1');
  });

  it('a clip serialises with its defaults left out', () => {
    const clip = blankClip('c1', 'T1', 'video', 'a', 0, 1);
    const written = writeDocumentClip(clip) as Record<string, Json>;
    expect(written['stretchX']).toBeUndefined();
    expect(written['flipH']).toBeUndefined();
    expect(written['keys']).toBeUndefined();
    expect(written['preservePitch']).toBe(true);
    expect(written['start']).toBe(0);
    expect(written['duration']).toBe(1);
  });
});
