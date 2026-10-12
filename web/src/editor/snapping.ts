// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Magnetic snapping. Candidates come from the playhead, markers, clip
 * edges, whole seconds and the timeline bounds; the engine picks the
 * nearest one inside a pixel threshold and reports what it snapped to so
 * the UI can draw its guide.
 */

import { Rational } from '../core/rational.ts';
import type { ProjectDocument } from '../model/document.ts';
import { currentTimeline, type MarkerData } from './operations.ts';

/** Something a drag can snap to. */
export interface SnapCandidate {
  time: Rational;
  kind: 'playhead' | 'clip-start' | 'clip-end' | 'marker' | 'timeline-start' | 'timeline-end' | 'second';
  label: string;
  trackId?: string;
  clipId?: string;
}

/** What {@link SnapEngine.snap} decided. */
export interface SnapResult {
  snappedTime: Rational;
  snappedTo: SnapCandidate | null;
}

/** Priority of kinds when two candidates tie (lower wins). */
const KIND_PRIORITY: Record<SnapCandidate['kind'], number> = {
  playhead: 0,
  marker: 1,
  'clip-start': 2,
  'clip-end': 2,
  second: 3,
  'timeline-start': 4,
  'timeline-end': 4,
};

/** The snap engine of one timeline. */
export class SnapEngine {
  private active = true;
  private thresholdPixels: number;

  /**
   * @param thresholdPixels how close a drag must come to snap (10 by default).
   */
  constructor(thresholdPixels = 10) {
    this.thresholdPixels = Math.max(1, thresholdPixels);
  }

  /** Turns snapping on/off (S key, toolbar). */
  setEnabled(enabled: boolean): void {
    this.active = enabled;
  }

  /** True when snapping is on. */
  get enabled(): boolean {
    return this.active;
  }

  /**
   * Sets the snap radius.
   * @param pixels threshold in screen pixels.
   */
  setThreshold(pixels: number): void {
    this.thresholdPixels = Math.max(1, pixels);
  }

  /** The snap radius in screen pixels. */
  get threshold(): number {
    return this.thresholdPixels;
  }

  /**
   * Builds the candidate list of the current document.
   * @param doc the document.
   * @param excludeClipIds clips being dragged (their edges are not targets).
   * @param playhead the current playhead time.
   * @param markers the ruler markers.
   * @returns candidates, nearest-ready (times as Rationals).
   */
  computeCandidates(
    doc: ProjectDocument,
    excludeClipIds: string[],
    playhead: Rational,
    markers: MarkerData[],
  ): SnapCandidate[] {
    const timeline = currentTimeline(doc);
    const out: SnapCandidate[] = [
      { time: playhead, kind: 'playhead', label: 'Playhead' },
      { time: Rational.ZERO, kind: 'timeline-start', label: 'Inicio' },
    ];
    const duration = timeline.clips.reduce((end, clip) => Math.max(end, clip.start + clip.duration), 0);
    out.push({
      time: Rational.approximate(duration) ?? Rational.ZERO,
      kind: 'timeline-end',
      label: 'Fin del timeline',
    });
    for (const marker of markers) {
      out.push({ time: marker.time, kind: 'marker', label: `Marker: ${marker.label}` });
    }
    for (const clip of timeline.clips) {
      if (excludeClipIds.includes(clip.id)) continue;
      const name = clip.name === '' ? clip.id : clip.name;
      out.push({
        time: Rational.approximate(clip.start) ?? Rational.ZERO,
        kind: 'clip-start',
        label: `Inicio: ${name}`,
        trackId: clip.trackId,
        clipId: clip.id,
      });
      out.push({
        time: Rational.approximate(clip.start + clip.duration) ?? Rational.ZERO,
        kind: 'clip-end',
        label: `Final: ${name}`,
        trackId: clip.trackId,
        clipId: clip.id,
      });
    }
    // Whole seconds up to the end of the edit (a quiet grid).
    const whole = Math.ceil(duration);
    for (let second = 1; second <= whole; second += 1) {
      out.push({
        time: Rational.fromInt(BigInt(second)),
        kind: 'second',
        label: `${second}s`,
      });
    }
    return out;
  }

  /**
   * Snaps `time` to the nearest candidate within the threshold.
   * @param time the dragged value.
   * @param pixelsPerSecond current zoom, to convert the pixel threshold.
   * @param candidates the candidate list.
   * @returns the snapped time and the target it snapped to.
   */
  snap(time: Rational, pixelsPerSecond: number, candidates: SnapCandidate[]): SnapResult {
    if (!this.active || pixelsPerSecond <= 0) {
      return { snappedTime: time, snappedTo: null };
    }
    const thresholdSeconds = this.thresholdPixels / pixelsPerSecond;
    const seconds = time.asNumber();
    let best: SnapCandidate | null = null;
    let bestDistance = Infinity;
    for (const candidate of candidates) {
      const distance = Math.abs(candidate.time.asNumber() - seconds);
      if (distance > thresholdSeconds) continue;
      const better =
        best === null ||
        distance < bestDistance - 1e-9 ||
        (Math.abs(distance - bestDistance) <= 1e-9 &&
          KIND_PRIORITY[candidate.kind] < KIND_PRIORITY[best.kind]);
      if (better) {
        best = candidate;
        bestDistance = distance;
      }
    }
    return best
      ? { snappedTime: best.time, snappedTo: best }
      : { snappedTime: time, snappedTo: null };
  }
}
