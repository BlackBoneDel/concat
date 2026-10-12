// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Shared fixtures for the Fase-3 test suites. */

import { Rational } from '../src/core/rational.ts';
import type { DocumentClip, MediaItem, ProjectDocument } from '../src/model/document.ts';
import { blankClip } from '../src/model/document.ts';
import { EditSession, type EditSessionOptions } from '../src/session/edit-session.ts';

/** A full, valid bin item. */
export function makeMedia(id = 'm1', duration = 4, kind: MediaItem['kind'] = 'video'): MediaItem {
  return {
    id,
    path: `media/${id}`,
    name: `${id}.mp4`,
    duration,
    kind,
    width: kind === 'audio' ? null : 640,
    height: kind === 'audio' ? null : 360,
    frameRate: 30,
    frameRateFraction: '30/1',
    videoCodec: kind === 'audio' ? null : 'h264',
    audioCodec: 'aac',
    hasAudio: true,
    audioTracks: [],
    slot: false,
    origin: null,
    colorRange: null,
    colorSpace: 'sdr',
    extra: {},
  };
}

/** A session with `count` video bins and `clips` clips already placed. */
export function makeSession(
  clips: { trackId?: string; start?: number; duration?: number; kind?: DocumentClip['kind'] }[] = [],
  options: EditSessionOptions = {},
): EditSession {
  const session = new EditSession(options);
  session.addMediaItem(makeMedia('m1'));
  session.addMediaItem(makeMedia('m2', 2));
  session.addMediaItem(makeMedia('mA', 3, 'audio'));
  for (const [index, spec] of clips.entries()) {
    const clip = blankClip(
      `c${index + 1}`,
      spec.trackId ?? 'T1',
      spec.kind ?? 'video',
      `clip${index + 1}`,
      spec.start ?? 0,
      spec.duration ?? 1,
    );
    clip.mediaId = spec.kind === 'audio' ? 'mA' : 'm1';
    session.document.timelines[0]!.clips.push(clip);
  }
  // Fixture edits happen outside the history: re-base so ops see them.
  session.history.rebase(session.document);
  return session;
}

/** Deep snapshot of a document for equality checks (order-insensitive). */
export function snap(doc: ProjectDocument): string {
  const canonical = JSON.parse(JSON.stringify(doc)) as ProjectDocument;
  for (const timeline of canonical.timelines) {
    timeline.clips.sort((a, b) =>
      a.trackId === b.trackId
        ? a.start - b.start || a.id.localeCompare(b.id)
        : a.trackId.localeCompare(b.trackId),
    );
    timeline.tracks.sort((a, b) => a.id.localeCompare(b.id));
  }
  return JSON.stringify(canonical);
}

/** The active timeline's clips. */
export function clipsOf(session: EditSession): DocumentClip[] {
  return session.document.timelines[0]!.clips;
}

/** Finds a clip by id. */
export function clipById(session: EditSession, id: string): DocumentClip {
  const clip = clipsOf(session).find((candidate) => candidate.id === id);
  if (!clip) throw new Error(`no clip ${id}`);
  return clip;
}

/** Rational seconds helper. */
export function r(seconds: number): Rational {
  return Rational.approximate(seconds) ?? Rational.ZERO;
}
