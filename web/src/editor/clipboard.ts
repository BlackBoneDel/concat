// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Copy / cut / paste of clips. Paste keeps the copied structure (links and
 * groups survive) but mints fresh ids everywhere, so pasting twice never
 * collides. Clips whose media vanished paste as disabled placeholders.
 */

import { Rational } from '../core/rational.ts';
import type { ProjectDocument, DocumentClip } from '../model/document.ts';
import {
  DeleteClipsOperation,
  EditError,
  InsertClipOperation,
  cloneClip,
  currentTimeline,
  newId,
  type DeleteMode,
  type EditOperation,
  type InsertMode,
} from './operations.ts';

/** What the clipboard holds: deep copies with their relative offsets. */
interface ClipboardEntry {
  clip: DocumentClip;
  /** Offset from the earliest copied clip's start. */
  offset: number;
  /** Offset from the first copied lane's index. */
  trackOffset: number;
}

/** The editor clipboard (one copy at a time, like every NLE). */
export class ClipboardManager {
  private entries: ClipboardEntry[] = [];
  private originTrackId = '';

  /**
   * Deep-copies the clips.
   * @param clipIds the clips to copy.
   * @param doc the document they live in.
   */
  copy(clipIds: string[], doc: ProjectDocument): void {
    const timeline = currentTimeline(doc);
    const clips = timeline.clips.filter((clip) => clipIds.includes(clip.id));
    if (clips.length === 0) return;
    const minStart = Math.min(...clips.map((clip) => clip.start));
    const trackIds = [...new Set(clips.map((clip) => clip.trackId))];
    this.originTrackId = trackIds[0] ?? '';
    const trackIndex = (id: string): number => timeline.tracks.findIndex((track) => track.id === id);
    const minTrack = Math.min(...trackIds.map(trackIndex));
    this.entries = clips.map((clip) => ({
      clip: cloneClip(clip),
      offset: clip.start - minStart,
      trackOffset: trackIndex(clip.trackId) - minTrack,
    }));
  }

  /**
   * Copies and returns the delete op that removes the originals.
   * @param clipIds the clips to cut.
   * @param doc the document.
   * @param mode how the gap closes (lift by default).
   * @returns the deletion to execute.
   */
  cut(clipIds: string[], doc: ProjectDocument, mode: DeleteMode = 'lift'): EditOperation {
    this.copy(clipIds, doc);
    return new DeleteClipsOperation(clipIds, mode);
  }

  /**
   * Pastes the clipboard at `atTime` on `targetTrackId`.
   * @param atTime where the earliest clip lands.
   * @param targetTrackId the lane for the first clip.
   * @param doc the document.
   * @param mode insert (push) or overwrite (trim what is underneath).
   * @returns the operation that performs the paste.
   * @throws EditError when the clipboard is empty.
   */
  paste(
    atTime: Rational,
    targetTrackId: string,
    doc: ProjectDocument,
    mode: InsertMode = 'overwrite',
  ): EditOperation {
    if (this.entries.length === 0) throw new EditError('El portapapeles está vacío');
    const timeline = currentTimeline(doc);
    const targetIndex = timeline.tracks.findIndex((track) => track.id === targetTrackId);
    if (targetIndex < 0) throw new EditError(`No existe la pista ${targetTrackId}`);

    const base = this.entries.reduce((earliest, entry) => Math.min(earliest, entry.offset), Infinity);
    const mediaIds = new Set(doc.media.map((item) => item.id));
    // Old group/link ids map to fresh ones so the pasted set keeps structure.
    const groupMap = new Map<string, string>();
    const linkMap = new Map<string, string>();
    const operations: EditOperation[] = [];
    for (const entry of this.entries) {
      const copy = cloneClip(entry.clip);
      copy.id = newId('c-');
      copy.extra = { ...copy.extra };
      const oldGroup = entry.clip.extra['groupId'];
      if (typeof oldGroup === 'string' && oldGroup !== '') {
        let fresh = groupMap.get(oldGroup);
        if (!fresh) {
          fresh = newId('g-');
          groupMap.set(oldGroup, fresh);
        }
        copy.extra['groupId'] = fresh;
      } else {
        delete copy.extra['groupId'];
      }
      const oldLink = entry.clip.extra['linkId'];
      if (typeof oldLink === 'string' && oldLink !== '') {
        let fresh = linkMap.get(oldLink);
        if (!fresh) {
          fresh = newId('l-');
          linkMap.set(oldLink, fresh);
        }
        copy.extra['linkId'] = fresh;
      } else {
        delete copy.extra['linkId'];
      }
      const track = timeline.tracks[targetIndex + entry.trackOffset] ?? timeline.tracks[targetIndex]!;
      copy.trackId = track.id;
      copy.start = atTime.asNumber() + (entry.offset - base);
      if (copy.mediaId !== '' && !mediaIds.has(copy.mediaId)) {
        copy.extra['enabled'] = false;
        copy.extra['missing'] = true;
      }
      operations.push(new InsertClipOperation(copy, copy.trackId, Rational.approximate(copy.start) ?? Rational.ZERO, mode));
    }
    // Pastes of one clip are one op; sets paste as one compound.
    return operations.length === 1 ? operations[0]! : new PasteCompoundOperation(operations);
  }

  /** True when something is copied. */
  get hasContent(): boolean {
    return this.entries.length > 0;
  }

  /** How many clips are copied. */
  get clipboardSize(): number {
    return this.entries.length;
  }

  /** Empties the clipboard. */
  clear(): void {
    this.entries = [];
    this.originTrackId = '';
  }
}

/** A multi-clip paste: runs every insert as one step. */
class PasteCompoundOperation implements EditOperation {
  readonly name = 'Paste';
  readonly timestamp = Date.now();
  private readonly operations: EditOperation[];

  constructor(operations: EditOperation[]) {
    this.operations = [...operations];
  }

  apply(doc: ProjectDocument): ProjectDocument {
    let next = doc;
    for (const operation of this.operations) next = operation.apply(next);
    return next;
  }

  inverse(doc: ProjectDocument): EditOperation {
    const inverses: EditOperation[] = [];
    let state = doc;
    for (const operation of this.operations) {
      inverses.unshift(operation.inverse(state));
      state = operation.apply(state);
    }
    return new PasteCompoundOperation(inverses);
  }

  describe(): string {
    return `Pegar ${this.operations.length} clips`;
  }
}
