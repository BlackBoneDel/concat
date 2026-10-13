// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Snap guides: thin vertical lines over the timeline marking the
 * candidates the current gesture snapped to. Pure overlay DOM.
 */

import type { SnapCandidate } from '../../editor/snapping.ts';
import { Rational } from '../../core/rational.ts';

/** Paints snap guides in the overlay layer. */
export class SnapGuides {
  private readonly layer: HTMLDivElement;
  private lines: HTMLDivElement[] = [];

  /**
   * @param overlay the overlay element of the timeline view.
   */
  constructor(overlay: HTMLElement) {
    this.layer = document.createElement('div');
    this.layer.className = 'tl-snap-guides';
    this.layer.setAttribute('aria-hidden', 'true');
    overlay.appendChild(this.layer);
  }

  /**
   * Shows guides for the given candidates.
   * @param candidates the targets to mark.
   * @param timeToX time → content pixels.
   */
  show(candidates: SnapCandidate[], timeToX: (seconds: number) => number): void {
    this.layer.textContent = '';
    this.lines.length = 0;
    for (const candidate of candidates) {
      const line = document.createElement('div');
      line.className = `tl-snap-guide tl-snap-guide-${candidate.kind}`;
      line.style.left = `${Math.round(timeToX(candidate.time.asNumber()))}px`;
      line.title = candidate.label;
      this.layer.appendChild(line);
      this.lines.push(line);
    }
  }

  /** Hides every guide. */
  clear(): void {
    this.layer.textContent = '';
    this.lines.length = 0;
  }

  /**
   * Shows a single guide at a time — the magenta line a media drop leaves at
   * the instant it snapped to (the ghost's exact position).
   * @param seconds the guide's time.
   * @param timeToX time → content pixels.
   * @param label tooltip text.
   */
  showDropGuide(seconds: number, timeToX: (seconds: number) => number, label = 'Snap'): void {
    this.show([{ time: Rational.approximate(seconds) ?? Rational.ZERO, kind: 'playhead', label }], timeToX);
    for (const line of this.lines) line.classList.add('tl-snap-guide-drop');
  }

  /** Hides the drop guide only. */
  clearDropGuide(): void {
    for (const line of this.lines) {
      if (line.classList.contains('tl-snap-guide-drop')) line.remove();
    }
    this.lines = this.lines.filter((line) => line.isConnected);
  }

  /** Removes the layer (unmount). */
  dispose(): void {
    this.clear();
    this.layer.remove();
  }
}
