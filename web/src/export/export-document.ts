// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Fase 6: the frozen snapshot an export renders. The live document keeps
 * changing while an export runs (autosave, edits in another tab of the UI),
 * so the exporter deep-copies it once, drops what must not reach the file,
 * and derives its own engine timeline.
 *
 * Mirrors the filtering in `src/crates/concat-export/src/lib.rs::render_on`:
 * hidden clips stay out of the picture, muted ones out of the mix; a clip
 * disabled in the timeline (`extra.enabled === false`) is neither seen nor
 * heard, and subtitle clips are optional (burn-in).
 */

import { clipEnabled } from '../editor/operations.ts';
import { SUBTITLE_KEY } from '../media/subtitles/subtitle-writer.ts';
import type { DocumentTrack, ProjectDocument } from '../model/document.ts';
import { EditorSession } from '../session/editor-session.ts';

/** Options of {@link snapshotForExport}. */
export interface SnapshotOptions {
  /** Keep subtitle clips (burned into the picture). */
  burnSubtitles: boolean;
}

/**
 * Deep-copies a document and removes disabled clips (and subtitle clips
 * unless they are burned in). The input is never mutated.
 * @param document the live document.
 * @param options burn-in choice.
 * @returns an independent document.
 */
export function snapshotForExport(document: ProjectDocument, options: SnapshotOptions): ProjectDocument {
  const copy = structuredClone(document);
  for (const timeline of copy.timelines) {
    timeline.clips = timeline.clips.filter(
      (clip) => clipEnabled(clip) && (options.burnSubtitles || clip.extra[SUBTITLE_KEY] === undefined),
    );
  }
  return copy;
}

/**
 * The engine session of a snapshot (picture side of the export).
 * @param snapshot a document from {@link snapshotForExport}.
 * @returns a session whose `engine` the compositor renders.
 */
export function exportSession(snapshot: ProjectDocument): EditorSession {
  return new EditorSession({ document: snapshot });
}

/**
 * Whether a lane is heard in the mix: not muted, and — when any lane is
 * soloed (`extra.solo`) — soloed itself.
 * @param track the lane.
 * @param tracks every lane of the timeline.
 * @returns `true` when audible.
 */
export function trackAudible(track: DocumentTrack, tracks: readonly DocumentTrack[]): boolean {
  if (track.muted) return false;
  const anySolo = tracks.some((lane) => lane.extra['solo'] === true);
  return !anySolo || track.extra['solo'] === true;
}

/**
 * The media paths the picture needs (video/image clips on visible lanes).
 * @param session the export session.
 * @returns unique media paths.
 */
export function visualMediaPaths(session: EditorSession): string[] {
  const visible = new Set(session.timeline.tracks.filter((track) => track.visible).map((track) => track.id));
  const paths = new Set<string>();
  for (const clip of session.clips()) {
    if ((clip.kind === 'video' || clip.kind === 'image') && visible.has(clip.docTrackId) && clip.media.path) paths.add(clip.media.path);
  }
  return [...paths];
}
