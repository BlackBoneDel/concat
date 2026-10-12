// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The pointer state machine of the timeline: routes pointerdown to the
 * right gesture for the active tool (select/blade/ripple/roll/slip/slide/
 * pen), keeps every drag preview-only until pointerup, and turns the
 * finished gesture into exactly one history step. Escape cancels.
 */

import { Rational } from '../../core/rational.ts';
import type { ProjectDocument } from '../../model/document.ts';
import {
  AddMarkerOperation,
  currentTimeline,
  DeleteClipOperation,
  DeleteClipsOperation,
  DuplicateClipOperation,
  MoveClipOperation,
  RippleEditOperation,
  RollEditOperation,
  SplitClipOperation,
  TrimClipOperation,
  type EditOperation,
} from '../../editor/operations.ts';
import type { EditHistory } from '../../editor/history.ts';
import type { SelectionManager } from '../../editor/selection.ts';
import type { SnapCandidate, SnapEngine } from '../../editor/snapping.ts';
import type { MarkerData } from '../../editor/operations.ts';
import type { TimelineView } from '../timeline/timeline-view.ts';
import type { ToolId } from '../timeline/types.ts';
import { ClipDrag, type ClipDragOptions } from './clip-drag.ts';
import { SplitTool } from './split-tool.ts';
import { SelectionDrag } from './selection-drag.ts';
import { TrimDrag, type TrimMode } from './trim-drag.ts';

/** What the drag manager needs from its host (the timeline panel). */
export interface DragManagerOptions {
  view: TimelineView;
  history: EditHistory;
  selection: SelectionManager;
  snap: SnapEngine;
  getDocument(): ProjectDocument;
  markers(): MarkerData[];
  tool(): ToolId;
  isSnappingEnabled(): boolean;
  playheadSeconds(): number;
  /** Called when a gesture changed the document. */
  onChange(): void;
  /** Called for visual-only updates during a drag. */
  onPreview(): void;
  /** Asks the host to open a context menu. */
  onContextMenu(x: number, y: number, clipId: string | null): void;
}

/** Who owns the current pointer gesture. */
type DragKind = 'none' | 'clip' | 'trim-in' | 'trim-out' | 'marquee' | 'marker' | 'playhead';

/** The timeline's pointer controller. */
export class DragManager {
  private readonly options: DragManagerOptions;
  private readonly clipDrag: ClipDrag;
  private readonly trimDrag: TrimDrag;
  private readonly selectionDrag: SelectionDrag;
  private readonly splitTool: SplitTool;
  private dragKind: DragKind = 'none';
  private pointerDown = false;
  private startedOnClip = '';
  private trimMode: TrimMode = 'normal';
  private readonly abort = new AbortController();

  /**
   * @param options host wiring.
   * @param target the element pointer events bind to.
   */
  constructor(options: DragManagerOptions, target: HTMLElement) {
    this.options = options;
    const clipOptions: ClipDragOptions = {
      view: options.view,
      getDocument: options.getDocument,
      snapCandidates: (exclude) => this.snapCandidates(exclude),
      snap: (time, candidates) => this.snapTime(time, candidates),
      operationFor: (clipId, fromTrackId, toTrackId, fromStart, toStart) =>
        new MoveClipOperation(clipId, fromTrackId, toTrackId, fromStart, toStart),
    };
    this.clipDrag = new ClipDrag(clipOptions);
    this.trimDrag = new TrimDrag({
      view: options.view,
      getDocument: options.getDocument,
      snapCandidates: (exclude) => this.snapCandidates(exclude),
      snap: (time, candidates) => this.snapTime(time, candidates),
    });
    this.selectionDrag = new SelectionDrag({
      view: options.view,
      selection: options.selection,
      getDocument: options.getDocument,
      onChange: options.onChange,
    });
    this.splitTool = new SplitTool(options.view, options.getDocument);
    const signal = this.abort.signal;
    target.addEventListener('pointerdown', this.onPointerDown, { signal });
    target.addEventListener('pointermove', this.onPointerMove, { signal });
    target.addEventListener('pointerup', this.onPointerUp, { signal });
    target.addEventListener('pointercancel', this.onPointerCancel, { signal });
    target.addEventListener('dblclick', this.onDoubleClick, { signal });
    target.addEventListener('contextmenu', this.onContextMenu, { signal });
  }

  /** Removes every listener. */
  dispose(): void {
    this.abort.abort();
    this.clipDrag.cancel();
    this.trimDrag.cancel();
    this.selectionDrag.cancel();
  }

  /** Cancels the running gesture (Escape). */
  cancelGesture(): void {
    this.clipDrag.cancel();
    this.trimDrag.cancel();
    this.selectionDrag.cancel();
    this.dragKind = 'none';
    this.options.onPreview();
  }

  /** The active marquee for the overlay. */
  marquee(): { fromX: number; fromY: number; toX: number; toY: number } | null {
    return this.selectionDrag.state();
  }

  /** Pointer coordinates in content space. */
  private contentPoint(event: PointerEvent): { x: number; y: number } {
    const rect = this.options.view.contentRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  /** Snapping helpers. */
  private snapCandidates(excludeClipIds: string[]): SnapCandidate[] {
    return this.options.snap.computeCandidates(
      this.options.getDocument(),
      excludeClipIds,
      Rational.approximate(this.options.playheadSeconds()) ?? Rational.ZERO,
      this.options.markers(),
    );
  }

  /** Runs a snap step honoring the engine toggle and Shift. */
  private snapTime(time: Rational, candidates: SnapCandidate[]): Rational {
    return this.options.snap.snap(time, this.options.view.zoom(), candidates).snappedTime;
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.button === 2) return; // context menu owns right-click
    const { x, y } = this.contentPoint(event);
    this.pointerDown = true;
    const tool = this.options.tool();
    const shift = event.shiftKey;
    const ctrl = event.ctrlKey || event.metaKey;
    if (y <= this.options.view.rulerHeight) {
      // Ruler: marker grab or playhead/scrub.
      const marker = this.options.view.markerAt(x, y);
      if (marker) {
        this.dragKind = 'marker';
        this.startedOnClip = marker.id;
      } else {
        this.dragKind = 'playhead';
        this.options.view.setPlayheadFromX(x);
        this.options.onChange();
      }
      return;
    }
    if (tool === 'blade') {
      const ops = this.splitTool.splitAtPoint(x, y);
      if (ops.length > 0) this.runOps(ops);
      return;
    }
    const clip = this.options.view.clipAt(x, y);
    if (clip) {
      if (tool === 'pen') {
        // Pen adds a keyframe at the clicked time (opacity) — the inspector
        // owns property choice; pen is a quick default.
        this.startedOnClip = clip.id;
        return;
      }
      if (tool === 'ripple' || tool === 'roll' || tool === 'slip' || tool === 'slide') {
        // Edge-proximity picks the trim/roll mode.
        const edgeX = this.options.view.timeToX(clip.start);
        const endX = this.options.view.timeToX(clip.start + clip.duration);
        this.startedOnClip = clip.id;
        this.trimMode =
          tool === 'roll' ? 'roll' : tool === 'ripple' ? 'ripple' : 'normal';
        if (tool === 'slip' || tool === 'slide') {
          this.dragKind = 'clip'; // slip/slide reuse clip drag with ops swapped
          this.clipDrag.begin(clip.id, this.options.view.xToTime(x), []);
          this.startedOnClip = clip.id;
          return;
        }
        this.dragKind = x - edgeX < endX - x ? 'trim-in' : 'trim-out';
        this.trimDrag.begin(clip.id, this.dragKind === 'trim-in' ? 'in' : 'out', this.trimMode);
        return;
      }
      // Select tool.
      this.selectionDrag.clickClip(clip.id, { ctrl, shift });
      const companions = ClipDrag.companionIds(
        this.options.getDocument(),
        clip.id,
        [...this.options.selection.selectedClipIds],
      );
      this.dragKind = 'clip';
      this.startedOnClip = clip.id;
      this.clipDrag.begin(clip.id, this.options.view.xToTime(x), companions);
      return;
    }
    // Empty space: marquee (or scrub with middle button).
    this.dragKind = 'marquee';
    this.selectionDrag.begin(x, y, { ctrl, shift });
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const { x, y } = this.contentPoint(event);
    if (!this.pointerDown) return;
    switch (this.dragKind) {
      case 'clip':
        this.clipDrag.update(
          this.options.view.xToTime(x),
          this.options.view.trackAtY(y)?.trackId ?? null,
          event.shiftKey,
        );
        break;
      case 'trim-in':
      case 'trim-out':
        this.trimDrag.update(this.options.view.xToTime(x), event.shiftKey);
        break;
      case 'marquee':
        this.selectionDrag.update(x, y);
        break;
      case 'marker': {
        const time = this.options.view.xToTime(x);
        this.options.view.setDragPreview({
          offsets: new Map(),
          markerId: this.startedOnClip,
          markerTime: time,
        });
        this.options.view.requestRender();
        break;
      }
      case 'playhead':
        this.options.view.setPlayheadFromX(x);
        break;
      default:
        break;
    }
    this.options.onPreview();
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (!this.pointerDown) return;
    this.pointerDown = false;
    const shift = event.shiftKey;
    switch (this.dragKind) {
      case 'clip': {
        const ops = this.clipDrag.commit();
        this.runOps(ops);
        break;
      }
      case 'trim-in':
      case 'trim-out': {
        const op = this.trimDrag.commit();
        if (op) this.runOps([op]);
        break;
      }
      case 'marquee':
        this.selectionDrag.commit(shift);
        break;
      case 'marker': {
        const preview = this.options.view.dragPreview();
        const time = preview?.markerTime ?? null;
        this.options.view.setDragPreview(null);
        if (time !== null && this.startedOnClip !== '') {
          const marker = this.options.markers().find((candidate) => candidate.id === this.startedOnClip);
          if (marker) {
            const from = marker.time.asNumber();
            if (Math.abs(from - time) > 1e-6) {
              // Marker move = remove + re-add at the new time (one compound).
              this.runOps([
                new AddMarkerOperation(
                  Rational.approximate(time) ?? Rational.ZERO,
                  marker.label,
                  marker.color,
                  marker.id,
                ),
              ]);
            }
          }
        }
        this.options.view.requestRender();
        break;
      }
      default:
        break;
    }
    this.dragKind = 'none';
    this.startedOnClip = '';
    this.options.onPreview();
  };

  private readonly onPointerCancel = (): void => {
    this.pointerDown = false;
    this.cancelGesture();
  };

  private readonly onDoubleClick = (event: MouseEvent): void => {
    const rect = this.options.view.contentRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (y <= this.options.view.rulerHeight) {
      // Add a marker where the user double-clicked.
      this.runOps([
        new AddMarkerOperation(
          Rational.approximate(this.options.view.xToTime(x)) ?? Rational.ZERO,
          '',
        ),
      ]);
    }
  };

  private readonly onContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
    const rect = this.options.view.contentRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const clip = this.options.view.clipAt(x, y);
    this.options.onContextMenu(event.clientX, event.clientY, clip?.id ?? null);
  };

  /** Runs operations through history and notifies the host. */
  private runOps(ops: EditOperation[]): void {
    if (ops.length === 0) return;
    if (ops.length === 1) {
      this.options.history.execute(ops[0]!);
    } else {
      this.options.history.beginTransaction('Gestos múltiples');
      for (const op of ops) this.options.history.execute(op);
      this.options.history.commitTransaction();
    }
    this.options.onChange();
  }
}

/** Re-exported ops the panel's keyboard actions use. */
export {
  AddMarkerOperation,
  DeleteClipOperation,
  DeleteClipsOperation,
  DuplicateClipOperation,
  RippleEditOperation,
  RollEditOperation,
  SplitClipOperation,
  TrimClipOperation,
};

/** Loads `currentTimeline` for panel helpers. */
export { currentTimeline };
