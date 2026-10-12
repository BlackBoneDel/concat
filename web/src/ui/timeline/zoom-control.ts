// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Zoom controls: a 10–500 px/s slider plus fit/percent buttons. The
 * timeline zooms around the playhead so editing stays where you look.
 */

import {
  MAX_PIXELS_PER_SECOND,
  MIN_PIXELS_PER_SECOND,
  type TimelineView,
} from './timeline-view.ts';
import { iconButton, type IconName } from '../components/icons.ts';

/** What the zoom control needs from its host. */
export interface ZoomControlOptions {
  view: TimelineView;
  /** Called after any zoom change (minimap refresh). */
  onChange(): void;
}

/** The zoom slider row. */
export class ZoomControl {
  readonly element: HTMLElement;
  private readonly slider: HTMLInputElement;
  private readonly label: HTMLElement;
  private readonly options: ZoomControlOptions;
  private readonly abort = new AbortController();

  /**
   * @param options host wiring.
   */
  constructor(options: ZoomControlOptions) {
    this.options = options;
    this.element = document.createElement('div');
    this.element.className = 'tl-zoom-control';
    this.element.setAttribute('role', 'group');
    this.element.setAttribute('aria-label', 'Zoom del timeline');

    // Fase 7 hook: SVG glyphs instead of text symbols.
    const out = this.button('zoomOut', 'Alejar', 'Ctrl+-');
    const fit = this.button('fit', 'Ajustar al proyecto', 'Ctrl+0');
    const inn = this.button('zoomIn', 'Acercar', 'Ctrl+=');
    this.slider = document.createElement('input');
    this.slider.type = 'range';
    this.slider.min = String(MIN_PIXELS_PER_SECOND);
    this.slider.max = String(MAX_PIXELS_PER_SECOND);
    this.slider.value = String(options.view.zoom());
    this.slider.setAttribute('aria-label', 'Nivel de zoom (píxeles por segundo)');
    this.label = document.createElement('span');
    this.label.className = 'tl-zoom-label';
    const signal = this.abort.signal;
    out.addEventListener('click', () => this.step(1 / 1.5), { signal });
    inn.addEventListener('click', () => this.step(1.5), { signal });
    fit.addEventListener('click', () => this.zoomFit(), { signal });
    this.slider.addEventListener('input', () => this.apply(Number(this.slider.value)), { signal });
    this.element.append(out, this.slider, inn, this.label, fit);
    this.refresh();
  }

  /** Makes a small icon button. */
  private button(glyph: IconName, label: string, shortcut: string): HTMLButtonElement {
    return iconButton({ icon: glyph, label, shortcut, className: 'tl-zoom-btn is-sm', size: 16 });
  }

  /** Zooms by a factor around the playhead. */
  private step(factor: number): void {
    this.apply(this.options.view.zoom() * factor);
  }

  /** Applies a zoom value. */
  private apply(pixelsPerSecond: number): void {
    const view = this.options.view;
    const anchor = view.xToTime(view.contentRect().width / 2);
    view.setZoom(pixelsPerSecond, anchor);
    this.refresh();
    this.options.onChange();
  }

  /** Zooms the whole edit into view. */
  zoomFit(): void {
    const view = this.options.view;
    const docWidth = Math.max(1, view.contentWidth() / view.zoom() * view.zoom());
    void docWidth;
    const secondsVisible = Math.max(1, view.contentRect().width / view.zoom());
    const totalSeconds = view.contentWidth() / view.zoom();
    const fit = (view.contentRect().width / Math.max(totalSeconds, secondsVisible)) * view.zoom();
    view.setZoom(fit, totalSeconds / 2);
    this.refresh();
    this.options.onChange();
  }

  /** Syncs the slider and label with the view. */
  refresh(): void {
    const zoom = Math.round(this.options.view.zoom());
    this.slider.value = String(zoom);
    this.label.textContent = `${zoom} px/s`;
  }

  /** Removes listeners and the element. */
  dispose(): void {
    this.abort.abort();
    this.element.remove();
  }
}
