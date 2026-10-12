// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The timeline panel: lanes, clips and the playhead.
 *
 * Every drag mutates the *document* (`DocumentClip.start`/`duration`/
 * `sourceStart`) and then `session.rebuild()` re-derives the engine — the
 * timeline is never a second source of truth. Clip moves and trims snap to
 * the grid when `snapToGrid` is on; clicking the ruler or a lane seeks.
 */

import { Rational } from '../core/rational.ts';
import type { DocumentClip, DocumentTrack } from '../model/document.ts';
import type { AppContext } from './app-context.ts';

/** Pixels per second at zoom 1. */
const BASE_PPS = 60;
/** Snap grid in seconds when enabled. */
const SNAP_SECONDS = 0.25;

/** The bottom panel of the shell. */
export class TimelinePanel {
  private readonly root: HTMLElement;
  private readonly ctx: AppContext;
  private readonly laneLayer: HTMLElement;
  private readonly clipLayer: HTMLElement;
  private readonly playhead: HTMLElement;
  private readonly ruler: HTMLElement;
  private readonly scroller: HTMLElement;
  private pixelsPerSecond = BASE_PPS;
  private drag: DragState | null = null;

  /**
   * @param root the panel element.
   * @param ctx the app services.
   */
  constructor(root: HTMLElement, ctx: AppContext) {
    this.root = root;
    this.ctx = ctx;

    const header = document.createElement('div');
    header.className = 'panel-header timeline-header';
    const title = document.createElement('h2');
    title.className = 'panel-title';
    title.textContent = 'Timeline';
    header.appendChild(title);

    const zoomOut = document.createElement('button');
    zoomOut.type = 'button';
    zoomOut.className = 'btn btn-icon btn-small';
    zoomOut.textContent = '−';
    zoomOut.title = 'Alejar (Ctrl+-)';
    zoomOut.addEventListener('click', () => this.zoomOut());
    header.appendChild(zoomOut);
    const zoomIn = document.createElement('button');
    zoomIn.type = 'button';
    zoomIn.className = 'btn btn-icon btn-small';
    zoomIn.textContent = '+';
    zoomIn.title = 'Acercar (Ctrl+=)';
    zoomIn.addEventListener('click', () => this.zoomIn());
    header.appendChild(zoomIn);
    const zoomFit = document.createElement('button');
    zoomFit.type = 'button';
    zoomFit.className = 'btn btn-icon btn-small';
    zoomFit.textContent = '⤢';
    zoomFit.title = 'Ajustar (Ctrl+0)';
    zoomFit.addEventListener('click', () => this.zoomFit());
    header.appendChild(zoomFit);

    const addTrack = document.createElement('button');
    addTrack.type = 'button';
    addTrack.className = 'btn btn-small btn-ghost';
    addTrack.textContent = '+ Pista';
    addTrack.addEventListener('click', () => this.addTrack());
    header.appendChild(addTrack);
    this.root.appendChild(header);

    this.scroller = document.createElement('div');
    this.scroller.className = 'timeline-scroll';
    this.ruler = document.createElement('div');
    this.ruler.className = 'timeline-ruler';
    this.laneLayer = document.createElement('div');
    this.laneLayer.className = 'timeline-lanes';
    this.clipLayer = document.createElement('div');
    this.clipLayer.className = 'timeline-clips';
    this.playhead = document.createElement('div');
    this.playhead.className = 'timeline-playhead';

    const body = document.createElement('div');
    body.className = 'timeline-body';
    body.appendChild(this.laneLayer);
    body.appendChild(this.clipLayer);
    body.appendChild(this.playhead);
    this.scroller.appendChild(this.ruler);
    this.scroller.appendChild(body);
    this.root.appendChild(this.scroller);

    this.wireSeek(this.ruler);
    this.wireSeek(body);
    this.wireDrag(body);
    this.refresh();

    this.ctx.player.onTimeUpdate = (time) => this.movePlayhead(time);
    document.addEventListener('timeline-changed', () => this.refresh());
    this.zoomFit();
  }

  /** Rebuilds lanes, clips and the ruler from the document. */
  refresh(): void {
    this.laneLayer.replaceChildren();
    this.clipLayer.replaceChildren();
    const timeline = this.ctx.session.timeline;
    const tracks = timeline.tracks;
    const totalSeconds = Math.max(10, this.ctx.session.duration().asNumber() + 5);
    const width = totalSeconds * this.pixelsPerSecond;

    // Ruler ticks every second (every 5 labelled).
    this.ruler.replaceChildren();
    this.ruler.style.width = `${width}px`;
    for (let second = 0; second <= totalSeconds; second += 1) {
      const tick = document.createElement('div');
      tick.className = second % 5 === 0 ? 'ruler-tick major' : 'ruler-tick';
      tick.style.left = `${second * this.pixelsPerSecond}px`;
      if (second % 5 === 0) {
        const label = document.createElement('span');
        label.className = 'ruler-label';
        label.textContent = formatSeconds(second);
        tick.appendChild(label);
      }
      this.ruler.appendChild(tick);
    }

    for (const track of tracks) {
      this.laneLayer.appendChild(this.laneHeader(track));
      const lane = document.createElement('div');
      lane.className = 'timeline-lane';
      lane.style.width = `${width}px`;
      lane.dataset['trackId'] = track.id;
      this.clipLayer.appendChild(lane);
      for (const clip of timeline.clips.filter((item) => item.trackId === track.id)) {
        lane.appendChild(this.clipElement(clip, track));
      }
    }
    this.movePlayhead(this.ctx.player.currentTime);
  }

  /** Where the playhead sits on screen. */
  movePlayhead(time: Rational): void {
    this.playhead.style.left = `${time.asNumber() * this.pixelsPerSecond}px`;
  }

  // -- internals -----------------------------------------------------------

  private setZoom(pixelsPerSecond: number): void {
    this.pixelsPerSecond = Math.max(8, Math.min(400, pixelsPerSecond));
    this.refresh();
  }

  /** Zooms in one step (Ctrl+=). */
  zoomIn(): void {
    this.setZoom(this.pixelsPerSecond * 1.5);
  }

  /** Zooms out one step (Ctrl+-). */
  zoomOut(): void {
    this.setZoom(this.pixelsPerSecond / 1.5);
  }

  /** Fits the whole edit in the visible width (Ctrl+0). */
  zoomFit(): void {
    const available = this.scroller.clientWidth || 800;
    const duration = Math.max(1, this.ctx.session.duration().asNumber() + 2);
    this.setZoom(available / duration);
  }

  private addTrack(): void {
    this.ctx.history.push(this.ctx.session.document, this.ctx.session.documentSettings());
    const timeline = this.ctx.session.timeline;
    const number = timeline.tracks.length + 3;
    timeline.tracks.push({
      id: `T${number}`,
      visible: true,
      muted: false,
      extra: {},
    });
    this.ctx.session.rebuild();
    this.ctx.session.dirty = true;
    this.refresh();
    this.ctx.requestRender();
    this.ctx.requestAutosave();
  }

  /** A track header: name plus visibility, mute and solo. */
  private laneHeader(track: DocumentTrack): HTMLElement {
    const header = document.createElement('div');
    header.className = 'track-header';
    const name = document.createElement('span');
    name.className = 'track-name';
    name.textContent = track.id;
    header.appendChild(name);

    const controls = document.createElement('span');
    controls.className = 'track-controls';
    const visible = this.toggle('👁', 'Ocultar/mostrar pista', !track.visible, (on) => {
      track.visible = !on;
      this.commitChange();
    });
    controls.appendChild(visible);
    const muted = this.toggle('M', 'Silenciar pista', track.muted, (on) => {
      track.muted = on;
      this.commitChange();
    });
    controls.appendChild(muted);
    header.appendChild(controls);
    return header;
  }

  /** A small on/off button. */
  private toggle(label: string, title: string, active: boolean, onChange: (active: boolean) => void): HTMLElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `btn btn-icon btn-small${active ? ' active' : ''}`;
    button.textContent = label;
    button.title = title;
    button.addEventListener('click', () => {
      const next = !button.classList.contains('active');
      button.classList.toggle('active', next);
      onChange(next);
    });
    return button;
  }

  /** One clip block. */
  private clipElement(clip: DocumentClip, track: DocumentTrack): HTMLElement {
    const element = document.createElement('div');
    element.className = `timeline-clip clip-${clip.kind}${this.ctx.selectedClipId === clip.id ? ' selected' : ''}`;
    if (!track.visible) element.classList.add('clip-hidden');
    element.dataset['clipId'] = clip.id;
    element.style.left = `${clip.start * this.pixelsPerSecond}px`;
    element.style.width = `${Math.max(4, clip.duration * this.pixelsPerSecond)}px`;

    const label = document.createElement('span');
    label.className = 'clip-label';
    label.textContent = clip.name === '' ? clip.kind : clip.name;
    element.appendChild(label);

    const trimLeft = document.createElement('span');
    trimLeft.className = 'clip-trim trim-left';
    trimLeft.title = 'Recorta el inicio';
    element.appendChild(trimLeft);
    const trimRight = document.createElement('span');
    trimRight.className = 'clip-trim trim-right';
    trimRight.title = 'Recorta el final';
    element.appendChild(trimRight);

    element.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      this.ctx.selectClip(clip.id);
      this.refresh();
      this.beginDrag(event, clip, element);
    });
    element.addEventListener('dblclick', () => {
      this.ctx.player.seekTo(Rational.approximate(clip.start) ?? Rational.ZERO);
    });
    return element;
  }

  /** Click-empty-to-seek. */
  private wireSeek(target: HTMLElement): void {
    target.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      if (event.target instanceof HTMLElement && event.target.closest('.timeline-clip')) return;
      const rect = this.clipLayer.getBoundingClientRect();
      const x = event.clientX - rect.left;
      this.ctx.selectClip(null);
      this.refresh();
      this.ctx.player.seekTo(Rational.approximate(Math.max(0, x / this.pixelsPerSecond)) ?? Rational.ZERO);
    });
  }

  /** Clip move and trim drags. */
  private wireDrag(layer: HTMLElement): void {
    layer.addEventListener('pointermove', (event) => {
      const drag = this.drag;
      if (!drag) return;
      const deltaSeconds = (event.clientX - drag.startX) / this.pixelsPerSecond;
      const snap = (value: number): number =>
        this.ctx.settings.snapToGrid
          ? Math.round(value / SNAP_SECONDS) * SNAP_SECONDS
          : Math.round(value * 1000) / 1000;

      if (drag.mode === 'move') {
        drag.clip.start = Math.max(0, snap(drag.clipStart + deltaSeconds));
      } else if (drag.mode === 'trim-left') {
        const shift = Math.max(-drag.clipStart, snap(drag.clipStart + deltaSeconds) - drag.clipStart);
        drag.clip.start = drag.clipStart + shift;
        drag.clip.duration = Math.max(1 / 60, drag.clipDuration - shift);
        drag.clip.sourceStart = Math.max(0, drag.sourceStart + shift * drag.clip.speed);
      } else {
        drag.clip.duration = Math.max(1 / 60, snap(drag.clipDuration + deltaSeconds));
      }
      drag.element.style.left = `${drag.clip.start * this.pixelsPerSecond}px`;
      drag.element.style.width = `${Math.max(4, drag.clip.duration * this.pixelsPerSecond)}px`;
    });

    const end = (event: PointerEvent): void => {
      if (!this.drag) return;
      if (this.drag.element.hasPointerCapture(event.pointerId)) {
        this.drag.element.releasePointerCapture(event.pointerId);
      }
      this.drag = null;
      this.commitChange();
    };
    layer.addEventListener('pointerup', end);
    layer.addEventListener('pointercancel', end);
    layer.addEventListener('lostpointercapture', () => {
      this.drag = null;
    });
  }

  private beginDrag(event: PointerEvent, clip: DocumentClip, element: HTMLElement): void {
    this.ctx.history.push(this.ctx.session.document, this.ctx.session.documentSettings());
    const target = event.target;
    const mode =
      target instanceof HTMLElement && target.classList.contains('trim-left')
        ? 'trim-left'
        : target instanceof HTMLElement && target.classList.contains('trim-right')
          ? 'trim-right'
          : 'move';
    this.drag = {
      mode,
      clip,
      element,
      startX: event.clientX,
      clipStart: clip.start,
      clipDuration: clip.duration,
      sourceStart: clip.sourceStart,
    };
    element.setPointerCapture(event.pointerId);
  }

  /** One mutation landed: history, dirty, engine, preview, autosave. */
  private commitChange(): void {
    this.ctx.session.rebuild();
    this.ctx.session.dirty = true;
    this.refresh();
    this.ctx.requestRender();
    this.ctx.requestAutosave();
  }
}

/** A clip drag in flight. */
interface DragState {
  mode: 'move' | 'trim-left' | 'trim-right';
  clip: DocumentClip;
  element: HTMLElement;
  startX: number;
  clipStart: number;
  clipDuration: number;
  sourceStart: number;
}

/** `0:05` style short time for ruler labels. */
function formatSeconds(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes}:${String(rest).padStart(2, '0')}` : `${rest}s`;
}
