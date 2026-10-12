// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The playhead indicator: the red line that rides the timeline and mirrors
 * the preview player's time. Position updates are transform-only.
 */

/** The playhead line of one timeline. */
export class Playhead {
  private readonly el: HTMLDivElement;
  private lastSeconds = -1;

  /**
   * @param host the element the line lives in (timeline view canvas wrap).
   */
  constructor(host: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'tl-playhead-line';
    this.el.setAttribute('role', 'slider');
    this.el.setAttribute('aria-label', 'Posición del playhead');
    this.el.setAttribute('aria-valuemin', '0');
    host.appendChild(this.el);
  }

  /**
   * Moves the line.
   * @param x content pixels from the left edge.
   * @param seconds the time (for the aria value).
   */
  setPosition(x: number, seconds: number): void {
    if (Math.abs(seconds - this.lastSeconds) < 1e-6) return;
    this.lastSeconds = seconds;
    this.el.style.transform = `translateX(${Math.round(x)}px)`;
    this.el.setAttribute('aria-valuenow', seconds.toFixed(2));
  }

  /** Hides the line (scrolled out). */
  hide(): void {
    this.el.style.display = 'none';
  }

  /** Shows the line. */
  show(): void {
    this.el.style.display = '';
  }

  /** Removes the element (unmount). */
  dispose(): void {
    this.el.remove();
  }
}
