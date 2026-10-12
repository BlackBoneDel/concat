// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** The marquee rectangle drawn while the user drags a selection box. */

/** Paints the selection marquee in the overlay layer. */
export class SelectionBox {
  private readonly el: HTMLDivElement;

  /**
   * @param overlay the overlay element of the timeline view.
   */
  constructor(overlay: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'tl-selection-box';
    this.el.setAttribute('aria-hidden', 'true');
    this.el.style.display = 'none';
    overlay.appendChild(this.el);
  }

  /**
   * Shows the marquee.
   * @param fromX start x.
   * @param fromY start y.
   * @param toX end x.
   * @param toY end y.
   */
  show(fromX: number, fromY: number, toX: number, toY: number): void {
    const left = Math.min(fromX, toX);
    const top = Math.min(fromY, toY);
    this.el.style.display = '';
    this.el.style.left = `${Math.round(left)}px`;
    this.el.style.top = `${Math.round(top)}px`;
    this.el.style.width = `${Math.round(Math.abs(toX - fromX))}px`;
    this.el.style.height = `${Math.round(Math.abs(toY - fromY))}px`;
  }

  /** Hides the marquee. */
  hide(): void {
    this.el.style.display = 'none';
  }

  /** Removes the element (unmount). */
  dispose(): void {
    this.el.remove();
  }
}
