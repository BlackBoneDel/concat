// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The interactive multitrack timeline panel (Fase 3). Canvas-rendered,
 * virtualized, with tools V C B N Y U, magnetic snapping, groups/links,
 * markers, transitions, waveforms, thumbnails, minimap and one-history-
 * step-per-gesture editing.
 */

import { Rational } from '../core/rational.ts';
import type { EditSession } from '../session/edit-session.ts';
import {
  AddMarkerOperation,
  DeleteClipOperation,
  DeleteClipsOperation,
  DuplicateClipOperation,
  SetTrackPropertyOperation,
  currentTimeline,
  trackKindOf,
  type EditOperation,
  type MarkerData,
} from '../editor/operations.ts';
import {
  ContextMenu,
  MAX_PIXELS_PER_SECOND,
  MIN_PIXELS_PER_SECOND,
  Minimap,
  Playhead,
  SelectionBox,
  SnapGuides,
  TimelineView,
  Toolbar,
  TrackHeader,
  buildTextClip,
  insertTextClipOperation,
  ZoomControl,
  openMarkerEditor,
  type ClipPreviewer,
  type DrawableImage,
  type ToolId,
} from './timeline/index.ts';
import {
  DragManager,
} from './interactions/drag-manager.ts';
import {
  installKeyboardShortcuts,
  type ShortcutActions,
} from './interactions/keyboard-shortcuts.ts';
import type { AppContext } from './app-context.ts';
import { REQUEST_ADD_TEXT_EVENT } from './ui-events.ts';
import { clampBezier } from '../editor/keyframe-operations.ts';
import { installMediaDrop, type MediaDropHandle } from './timeline/media-drop.ts';
import type { KeyframeRef } from './timeline/keyframe-track.ts';

/** The Fase-3 timeline panel. */
export class TimelinePanel {
  private readonly app: AppContext;
  private readonly root: HTMLElement;
  private session: EditSession | null = null;
  private view: TimelineView | null = null;
  private drag: DragManager | null = null;
  private toolbar: Toolbar | null = null;
  private zoomControl: ZoomControl | null = null;
  private minimap: Minimap | null = null;
  private selectionBox: SelectionBox | null = null;
  private snapGuides: SnapGuides | null = null;
  private playhead: Playhead | null = null;
  private headers = new Map<string, TrackHeader>();
  private shortcuts: { dispose(): void } | null = null;
  private tool: ToolId = 'select';
  private readonly trackHeadersEl!: HTMLElement;
  private readonly scrollEl!: HTMLElement;
  private readonly overlayEl!: HTMLElement;
  private readonly contentWrap!: HTMLElement;
  private readonly abort = new AbortController();
  /** Fase 8: the media-library drop target of this timeline. */
  private mediaDrop: MediaDropHandle | null = null;
  private playheadFrame = 0;
  private readonly clipListEl!: HTMLElement;

  /**
   * @param root the panel root (`#timeline-panel`).
   * @param app the service bag.
   */
  constructor(root: HTMLElement, app: AppContext) {
    this.app = app;
    this.root = root;
    this.root.textContent = '';
    this.root.className = 'timeline-panel';

    const session = app.editSession;
    if (!session) {
      const message = document.createElement('p');
      message.className = 'panel-empty';
      message.textContent = 'Sesión de edición no disponible.';
      this.root.appendChild(message);
      return;
    }
    this.session = session;

    // Layout: toolbar on top; headers + scrolling content below.
    this.trackHeadersEl = document.createElement('div');
    this.trackHeadersEl.className = 'tl-track-headers';
    this.scrollEl = document.createElement('div');
    this.scrollEl.className = 'tl-scroll';
    this.scrollEl.tabIndex = 0;
    this.scrollEl.setAttribute('role', 'application');
    this.scrollEl.setAttribute('aria-label', 'Timeline interactivo');
    this.contentWrap = document.createElement('div');
    this.contentWrap.className = 'tl-content-wrap';
    this.overlayEl = document.createElement('div');
    this.overlayEl.className = 'tl-overlay';
    this.contentWrap.appendChild(this.overlayEl);
    this.scrollEl.appendChild(this.contentWrap);

    const main = document.createElement('div');
    main.className = 'tl-main';
    main.append(this.trackHeadersEl, this.scrollEl);
    this.root.appendChild(main);

    // Accessible clip list (screen readers; also the DOM mirror of the canvas).
    this.clipListEl = document.createElement('ul');
    this.clipListEl.className = 'tl-clip-list';
    this.clipListEl.setAttribute('role', 'list');
    this.clipListEl.setAttribute('aria-label', 'Clips del timeline');
    this.root.appendChild(this.clipListEl);

    // View.
    this.view = new TimelineView({
      container: this.contentWrap,
      overlay: this.overlayEl,
      preview: this.previewer(),
      getDocument: () => session.document,
      markers: (): MarkerData[] => session.markers(),
      playheadSeconds: (): number => this.app.player.currentTime.asNumber(),
      setPlayhead: (seconds: number): void => {
        this.app.player.seekTo(Rational.approximate(seconds) ?? Rational.ZERO);
      },
      selection: session.selection,
      // Fase 8: the filmstrips the clip faces paint.
      strips: this.app.pool,
    });

    // Controls.
    const actions = this.toolbarActions();
    this.zoomControl = new ZoomControl({
      view: this.view,
      onChange: () => {
        this.syncSize();
        this.minimap?.render();
        this.saveZoomSetting();
      },
    });
    this.toolbar = new Toolbar(actions, this.zoomControl.element);
    this.root.insertBefore(this.toolbar.element, main);

    this.selectionBox = new SelectionBox(this.overlayEl);
    this.snapGuides = new SnapGuides(this.overlayEl);
    this.playhead = new Playhead(this.contentWrap);
    this.minimap = new Minimap({ view: this.view, getDocument: () => session.document });
    this.root.appendChild(this.minimap.element);

    // Interactions.
    this.drag = new DragManager(
      {
        view: this.view,
        history: session.history,
        selection: session.selection,
        snap: session.snapping,
        getDocument: () => session.document,
        markers: (): MarkerData[] => session.markers(),
        tool: () => this.tool,
        isSnappingEnabled: () => session.snapping.enabled,
        playheadSeconds: (): number => this.app.player.currentTime.asNumber(),
        onChange: () => this.onEdited(),
        onPreview: () => this.updateOverlays(),
        onContextMenu: (x, y, clipId) => this.openMenu(x, y, clipId),
        // Fase 8: the hand tool drags the viewport around.
        pan: (deltaX, deltaY) => {
          this.scrollEl.scrollLeft -= deltaX;
          this.scrollEl.scrollTop -= deltaY;
        },
      },
      this.contentWrap,
    );

    this.shortcuts = installKeyboardShortcuts(this.shortcutActions());

    // Fase 8: media cards dragged from the library land on the timeline.
    this.mediaDrop = installMediaDrop({
      target: this.root,
      contentRect: () => this.view?.contentRect() ?? this.root.getBoundingClientRect(),
      viewport: () => this.view?.viewport() ?? { pixelsPerSecond: 0, scrollTime: 0, scrollTop: 0, width: 0, height: 0 },
      layouts: () => this.view?.trackLayouts() ?? [],
      trackAtY: (y) => this.view?.trackIdAtY(y) ?? null,
      snappingEnabled: () => session.snapping.enabled,
      candidates: (exclude) =>
        session.snapping.computeCandidates(
          session.document,
          exclude,
          this.app.player.currentTime,
          session.markers(),
        ),
      snap: (time, candidates) => session.snapping.snap(time, this.view?.zoom() ?? 80, candidates),
      kindForMedia: (payload) => (payload.kind === 'audio' ? 'audio' : 'video'),
      // Fase 9: an audio card dropped over a video lane must land on an audio
      // lane (or a new one), not fail with "no se pudo insertar el clip".
      trackKind: (trackId) => {
        const track = session.timeline.tracks.find((candidate) => candidate.id === trackId);
        return track ? trackKindOf(session.document, track) : null;
      },
      trackOfKind: (kind) => {
        const track = session.timeline.tracks.find((candidate) => trackKindOf(session.document, candidate) === kind);
        return track?.id ?? null;
      },
      createTrack: (kind) => {
        // Appended below the last lane: that is where the ghost is drawn.
        const trackId = session.addTrack(kind, session.timeline.tracks.length);
        this.onEdited();
        console.info('[TimelineDrop] Pista nueva creada automáticamente:', trackId);
        return trackId;
      },
      insert: (payload, trackId, atTime, mode) => {
        const clipId = session.insertClipFromMedia(payload.mediaId, trackId, atTime, mode, {
          durationSeconds: payload.durationSeconds,
          kind: payload.kind,
          name: payload.name,
        });
        console.info('[TimelineDrop] Clip insertado:', clipId, 'en pista:', trackId, 'tiempo:', atTime.asNumber());
        this.onEdited();
        document.dispatchEvent(new CustomEvent('timeline-changed'));
      },
      onPreview: (state) => this.view?.setDropPreview(state),
      onGuide: (candidate) => {
        if (candidate && this.view) {
          this.snapGuides?.showDropGuide(candidate.time.asNumber(), (seconds) => this.view!.timeToX(seconds), candidate.label);
        } else {
          this.snapGuides?.clearDropGuide();
        }
      },
      onDrop: ({ payload }) => {
        this.app.notifications.success('Clip añadido al timeline', payload.name);
        this.app.requestAutosave();
      },
      onError: (error) => {
        console.error('[TimelineDrop] Error al insertar clip:', error);
        this.app.notifications.error('No se pudo añadir el clip', error instanceof Error ? error.message : String(error));
      },
    });

    // Scrolling: headers follow vertically; content drives the view.
    const signal = this.abort.signal;
    this.scrollEl.addEventListener(
      'scroll',
      () => {
        this.trackHeadersEl.scrollTop = this.scrollEl.scrollTop;
        this.view?.setScrollTop(this.scrollEl.scrollTop);
        this.view?.setScrollTime(this.scrollEl.scrollLeft / Math.max(1, this.view.zoom()));
      },
      { signal },
    );
    this.scrollEl.addEventListener(
      'wheel',
      (event) => {
        if (event.ctrlKey) {
          event.preventDefault();
          const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
          const zoom = this.view ? this.view.zoom() * factor : 80;
          this.view?.setZoom(
            Math.min(MAX_PIXELS_PER_SECOND, Math.max(MIN_PIXELS_PER_SECOND, zoom)),
            this.view.xToTime(event.offsetX),
          );
          this.zoomControl?.refresh();
          this.syncSize();
          this.minimap?.render();
        }
      },
      { signal },
    );

    // Keep the canvases sized and the playhead riding.
    document.addEventListener('media-strips-changed', () => this.view?.refreshStrips(), { signal });
    // Fase 8: the Text tab of the media panel asks for a title at the playhead.
    document.addEventListener(
      REQUEST_ADD_TEXT_EVENT,
      (event) => {
        const content = (event as CustomEvent<string>).detail;
        const session = this.session;
        if (!session) return;
        const timeline = currentTimeline(session.document);
        const selected = [...session.selection.selectedClipIds][0];
        const lane = selected ? timeline.clips.find((clip) => clip.id === selected)?.trackId : undefined;
        const freeLane = timeline.tracks.find((track) => trackKindOf(session.document, track) !== 'audio')?.id;
        let trackId = lane ?? freeLane;
        if (!trackId) trackId = session.addTrack('video', timeline.tracks.length) ?? undefined;
        if (!trackId) return;
        const clip = buildTextClip({
          trackId,
          startSeconds: Math.max(0, this.app.player.currentTime.asNumber()),
          content,
        });
        session.run(insertTextClipOperation(clip));
        session.selection.selectClips([clip.id], false, session.document);
        this.onEdited();
        document.dispatchEvent(new CustomEvent('timeline-changed'));
        this.app.notifications.info('Texto añadido', clip.name);
      },
      { signal },
    );
    document.addEventListener('timeline-changed', () => this.refreshAll(), { signal });
    // Fase 8: el menú Ver de la cabecera pide cambios de zoom.
    document.addEventListener('timeline-zoom-in', () => this.zoomIn(), { signal });
    document.addEventListener('timeline-zoom-out', () => this.zoomOut(), { signal });
    document.addEventListener('timeline-zoom-fit', () => this.zoomFit(), { signal });
    document.addEventListener('selection-changed', () => this.refreshAll(), { signal });
    document.addEventListener('project-changed', () => this.refreshAll(), { signal });
    document.addEventListener('session-reset', () => this.refreshAll(), { signal });

    this.refreshAll();
    this.startPlayheadLoop();
  }

  /** Tears the panel down. */
  dispose(): void {
    this.abort.abort();
    this.mediaDrop?.dispose();
    this.mediaDrop = null;
    this.drag?.dispose();
    this.drag = null;
    this.shortcuts?.dispose();
    this.shortcuts = null;
    this.toolbar?.dispose();
    this.zoomControl?.dispose();
    this.minimap?.dispose();
    this.selectionBox?.dispose();
    this.snapGuides?.dispose();
    this.playhead?.dispose();
    for (const header of this.headers.values()) header.dispose();
    this.headers.clear();
    this.view?.dispose();
    this.view = null;
    if (this.playheadFrame !== 0) cancelAnimationFrame(this.playheadFrame);
    this.playheadFrame = 0;
    this.root.textContent = '';
    document.removeEventListener('timeline-changed', () => this.refreshAll());
  }

  /** The thumbnail source: frames pulled from the stored media bytes. */
  private previewer(): ClipPreviewer {
    return {
      frameAt: async (sourceTimeSeconds, clip): Promise<DrawableImage | null> => {
        try {
          const blob = await this.app.mediaStore.readFile(clip.mediaId);
          if (!blob) return null;
          if (typeof createImageBitmap === 'function' && blob.type.startsWith('image/')) {
            return await createImageBitmap(blob);
          }
          return await grabVideoFrame(blob, sourceTimeSeconds);
        } catch (error) {
          console.warn('No se pudo generar el thumbnail', error);
          return null;
        }
      },
    };
  }

  /** Runs one operation through the session (toast on error). */
  private run(op: EditOperation): void {
    this.session?.run(op);
    this.onEdited();
  }

  /** Public refresh (app events). */
  refresh(): void {
    this.refreshAll();
  }

  /**
   * Fase 9: what a point of this panel means — the time under the pointer and
   * the lane there. Used for OS files dropped on the timeline: they are
   * imported and then placed where the user let go.
   * @param x pixels from the panel's left edge (as `installFileDrop` reports).
   * @param y pixels from the panel's top edge.
   * @returns the placement, or `null` when the view is not up.
   */
  dropTargetAt(x: number, y: number): { time: number; trackId: string | null } | null {
    const view = this.view;
    if (!view) return null;
    const content = view.contentRect();
    const panel = this.root.getBoundingClientRect();
    const contentX = panel.left + x - content.left;
    const contentY = panel.top + y - content.top;
    return {
      time: Math.max(0, view.xToTime(contentX)),
      trackId: view.trackIdAtY(contentY),
    };
  }

  /** Zooms in (menu/shortcut). */
  /**
   * Fase 5: ghost curve of a keyframe segment while the inspector's Bézier
   * handle drags (visual only; the edit commits on release).
   * @param clipId the clip.
   * @param ref the keyframe whose approach curve is previewed.
   * @param curve the curve, or `null` to clear the ghost.
   */
  previewKeyframeCurve(clipId: string, ref: KeyframeRef, curve: readonly number[] | null): void {
    if (!this.view) return;
    if (!curve) {
      this.view.setKeyframePreview(null);
      return;
    }
    if (!this.view.isExpanded(clipId)) this.view.toggleKeyframeLane(clipId, true);
    this.view.setKeyframePreview({ clipId, property: ref.property, keyframeId: ref.keyframeId, curve: clampBezier(curve) });
  }

  zoomIn(): void {
    this.view?.setZoom((this.view?.zoom() ?? 80) * 1.25);
    this.zoomControl?.refresh();
    this.syncSize();
  }

  /** Zooms out (menu/shortcut). */
  zoomOut(): void {
    this.view?.setZoom((this.view?.zoom() ?? 80) / 1.25);
    this.zoomControl?.refresh();
    this.syncSize();
  }

  /** Zooms to fit (menu/shortcut). */
  zoomFit(): void {
    this.zoomControl?.zoomFit();
    this.syncSize();
    this.minimap?.render();
  }

  /** Everything is up to date after an edit. */
  private onEdited(): void {
    // Fase 7 hook (QA): an undo/redo/edit while dragging cancels the drag.
    this.drag?.syncWithHistory();
    // Full refresh: the clip list (the accessible mirror of the lanes) and the
    // toolbar's undo/redo state were not rebuilt after keyboard or toolbar edits.
    this.refreshAll();
    this.app.requestRender();
    this.app.requestAutosave();
  }

  /** Rebuilds headers + geometry + paint. */
  private refreshAll(): void {
    if (!this.session || !this.view) return;
    this.view.relayout();
    this.syncSize();
    this.buildHeaders();
    this.buildClipList();
    this.view.requestRender();
    this.minimap?.render();
    this.zoomControl?.refresh();
    this.toolbar?.setTool(
      this.tool,
      this.session.snapping.enabled,
      this.session.history.canUndo(),
      this.session.history.canRedo(),
    );
    // Fase 8: the hand tool shows the grab cursor over the whole surface.
    this.scrollEl.classList.toggle('is-hand', this.tool === 'hand');
    this.scrollEl.classList.toggle('is-blade', this.tool === 'blade');
  }

  /** Mirrors the clips as an accessible DOM list. */
  private buildClipList(): void {
    if (!this.session) return;
    const timeline = currentTimeline(this.session.document);
    this.clipListEl.textContent = '';
    for (const clip of timeline.clips) {
      const item = document.createElement('li');
      item.className = 'timeline-clip';
      item.dataset['clipId'] = clip.id;
      item.textContent = clip.name === '' ? clip.id : clip.name;
      item.title = `${clip.name} (${clip.start.toFixed(2)}s +${clip.duration.toFixed(2)}s)`;
      this.clipListEl.appendChild(item);
    }
  }

  /** Sizes the content wrap to the full timeline. */
  private syncSize(): void {
    if (!this.view) return;
    this.contentWrap.style.width = `${Math.ceil(this.view.contentWidth())}px`;
    this.contentWrap.style.height = `${Math.ceil(this.view.contentHeight() + this.view.rulerHeight)}px`;
  }

  /** Rebuilds the track header column. */
  private buildHeaders(): void {
    if (!this.session || !this.view) return;
    const doc = this.session.document;
    const timeline = currentTimeline(doc);
    const seen = new Set<string>();
    for (const track of timeline.tracks) {
      seen.add(track.id);
      let header = this.headers.get(track.id);
      if (!header) {
        header = new TrackHeader(track.id, {
          getDocument: () => this.session!.document,
          run: (op) => this.run(op),
          relayout: () => {
            this.view?.relayout();
            this.syncSize();
          },
        });
        this.headers.set(track.id, header);
        this.trackHeadersEl.appendChild(header.element);
      }
      header.refresh();
      // Fase 5: open keyframe lanes make a track taller; headers follow.
      const layout = this.view.trackLayout(track.id);
      if (layout) header.element.style.height = `${layout.height}px`;
    }
    for (const [id, header] of this.headers) {
      if (!seen.has(id)) {
        header.dispose();
        this.headers.delete(id);
      }
    }
  }

  /** Marquee + snap guides while a gesture runs. */
  private updateOverlays(): void {
    if (!this.view || !this.drag || !this.selectionBox || !this.snapGuides) return;
    const marquee = this.drag.marquee();
    if (marquee) {
      this.selectionBox.show(marquee.fromX, marquee.fromY, marquee.toX, marquee.toY);
    } else {
      this.selectionBox.hide();
    }
    // Snap guides: show the target the engine would pick right now.
    const preview = this.view.dragPreview();
    if (preview && this.session?.snapping.enabled) {
      const candidates = this.session.snapping.computeCandidates(
        this.session.document,
        [...preview.offsets.keys()],
        this.app.player.currentTime,
        this.session.markers(),
      );
      const moving = [...preview.offsets.values()];
      const first = moving[0];
      if (first) {
        const clipId = [...preview.offsets.keys()][0] ?? '';
        void clipId;
        const time = this.app.player.currentTime.asNumber() + first.deltaTime;
        const result = this.session.snapping.snap(
          Rational.approximate(time) ?? Rational.ZERO,
          this.view.zoom(),
          candidates,
        );
        if (result.snappedTo) {
          this.snapGuides.show([result.snappedTo], (seconds) => this.view!.timeToX(seconds));
        } else {
          this.snapGuides.clear();
        }
      }
    } else {
      this.snapGuides.clear();
    }
  }

  /** Opens the context menu. */
  private openMenu(x: number, y: number, clipId: string | null): void {
    if (!this.session) return;
    const items = [];
    if (clipId) {
      const selection = this.session.selection.selectedClipIds;
      const ids = selection.has(clipId) ? [...selection] : [clipId];
      items.push(
        {
          label: 'Duplicar',
          shortcut: 'Ctrl+D',
          onSelect: () => {
            this.session?.duplicateClips(ids);
            this.onEdited();
          },
        },
        {
          label: 'Eliminar',
          shortcut: 'Supr',
          danger: true,
          onSelect: () => {
            if (ids.length === 1) this.session?.run(new DeleteClipOperation(ids[0]!));
            else this.session?.run(new DeleteClipsOperation(ids));
            this.onEdited();
          },
        },
        {
          label: 'Agrupar',
          shortcut: 'Ctrl+G',
          onSelect: () => {
            this.session?.groupClips(ids);
            this.onEdited();
          },
        },
        {
          label: 'Vincular',
          shortcut: 'Ctrl+L',
          onSelect: () => {
            this.session?.linkClips(ids);
            this.onEdited();
          },
        },
        {
          label: 'Habilitar/deshabilitar',
          shortcut: 'E',
          onSelect: () => {
            for (const id of ids) this.session?.toggleClipEnabled(id);
            this.onEdited();
          },
        },
      );
    } else {
      items.push(
        {
          label: 'Añadir marker',
          shortcut: 'M',
          onSelect: () => {
            this.session?.run(
              new AddMarkerOperation(this.app.player.currentTime, ''),
            );
            this.onEdited();
          },
        },
        {
          label: 'Pegar',
          shortcut: 'Ctrl+V',
          onSelect: () => {
            const timeline = currentTimeline(this.session!.document);
            const first = timeline.tracks[0];
            if (first) {
              this.session?.pasteClips(this.app.player.currentTime.asNumber(), first.id);
              this.onEdited();
            }
          },
        },
      );
    }
    new ContextMenu(x, y, items);
  }

  /** Toolbar wiring. */
  private toolbarActions(): ConstructorParameters<typeof Toolbar>[0] {
    return {
      setTool: (tool) => {
        this.tool = tool;
        this.refreshAll();
      },
      toggleSnapping: () => {
        if (!this.session) return;
        this.session.snapping.setEnabled(!this.session.snapping.enabled);
        this.refreshAll();
      },
      splitAtPlayhead: () => {
        const session = this.session;
        if (!session) return;
        // Selected clips under the playhead; with no selection, every clip under it.
        const cut = session.splitClipsAt(
          this.app.player.currentTime.asNumber(),
          [...session.selection.selectedClipIds],
        );
        if (cut === 0) {
          this.app.notifications.warning('No se puede dividir aquí', 'Coloca el playhead dentro de un clip, lejos de sus bordes.');
          return;
        }
        this.app.notifications.info('Clip dividido', cut === 1 ? '1 clip cortado en el playhead.' : `${cut} clips cortados en el playhead.`);
        this.onEdited();
      },
      deleteSelection: () => {
        if (!this.session) return;
        const ids = [...this.session.selection.selectedClipIds];
        if (ids.length > 0) {
          this.session.deleteClips(ids);
          this.onEdited();
        }
      },
      duplicateSelection: () => {
        if (!this.session) return;
        this.session.duplicateClips([...this.session.selection.selectedClipIds]);
        this.onEdited();
      },
      groupSelection: () => {
        if (!this.session) return;
        this.session.groupClips([...this.session.selection.selectedClipIds]);
        this.onEdited();
      },
      linkSelection: () => {
        if (!this.session) return;
        this.session.linkClips([...this.session.selection.selectedClipIds]);
        this.onEdited();
      },
      addMarker: () => {
        if (!this.session) return;
        this.session.run(new AddMarkerOperation(this.app.player.currentTime, ''));
        this.onEdited();
      },
      undo: () => {
        this.session?.undo();
        this.onEdited();
      },
      redo: () => {
        this.session?.redo();
        this.onEdited();
      },
      addTrack: (kind) => {
        if (!this.session) return;
        this.session.addTrack(kind, this.session.timeline.tracks.length);
        this.onEdited();
      },
      // Fase 8: the Text button drops a title on the lane under the playhead.
      addText: () => this.addTextAtPlayhead(),
      zoomIn: () => this.zoomIn(),
      zoomOut: () => this.zoomOut(),
      zoomFit: () => this.zoomFit(),
    };
  }

  /**
   * Fase 8: inserts a title clip at the playhead — on the selected clip’s
   * lane, on the first video lane, or on a brand-new video lane.
   * @returns the new clip id, or `null` when there is no session.
   */
  addTextAtPlayhead(): string | null {
    const session = this.session;
    if (!session) return null;
    const timeline = currentTimeline(session.document);
    const selected = [...session.selection.selectedClipIds][0];
    const selectedTrack = selected
      ? (timeline.clips.find((clip) => clip.id === selected)?.trackId ?? undefined)
      : undefined;
    const freeLane = timeline.tracks.find((track) => trackKindOf(session.document, track) !== 'audio')?.id;
    let trackId = selectedTrack ?? freeLane;
    if (!trackId) trackId = session.addTrack('video', timeline.tracks.length) ?? undefined;
    if (!trackId) return null;
    const start = Math.max(0, this.app.player.currentTime.asNumber());
    const clip = buildTextClip({ trackId, startSeconds: start });
    session.run(insertTextClipOperation(clip));
    session.selection.selectClips([clip.id], false, session.document);
    this.onEdited();
    document.dispatchEvent(new CustomEvent('timeline-changed'));
    this.app.notifications.info('Texto añadido', clip.name);
    return clip.id;
  }

  /** Keyboard wiring. */
  private shortcutActions(): ShortcutActions {
    return {
      setTool: (tool) => {
        this.tool = tool;
        this.refreshAll();
      },
      toggleSnapping: () => this.toolbarActions().toggleSnapping(),
      togglePlayback: () => {
        if (this.app.player.isPlaying) this.app.player.pause();
        else this.app.player.play();
      },
      goHome: () => this.app.player.seekTo(Rational.ZERO),
      goEnd: () => this.app.player.seekTo(this.app.player.duration),
      stepBackward: () => this.app.player.stepBackward(),
      stepForward: () => this.app.player.stepForward(),
      splitAtPlayhead: () => this.toolbarActions().splitAtPlayhead(),
      deleteSelection: () => this.toolbarActions().deleteSelection(),
      rippleDeleteSelection: () => {
        if (!this.session) return;
        const ids = [...this.session.selection.selectedClipIds];
        if (ids.length > 0) {
          this.session.deleteClips(ids, 'ripple');
          this.onEdited();
        }
      },
      duplicateSelection: () => this.toolbarActions().duplicateSelection(),
      selectAll: () => {
        if (!this.session) return;
        this.session.selection.selectAll(this.session.document);
        this.onEdited();
      },
      selectNone: () => {
        this.session?.selection.clearSelection();
        this.onEdited();
      },
      groupSelection: () => this.toolbarActions().groupSelection(),
      ungroupSelection: () => {
        if (!this.session) return;
        this.session.ungroupClips([...this.session.selection.selectedClipIds]);
        this.onEdited();
      },
      linkSelection: () => this.toolbarActions().linkSelection(),
      unlinkSelection: () => {
        if (!this.session) return;
        this.session.unlinkClips([...this.session.selection.selectedClipIds]);
        this.onEdited();
      },
      copy: () => {
        if (!this.session) return;
        this.session.copyClips([...this.session.selection.selectedClipIds]);
      },
      cut: () => {
        if (!this.session) return;
        this.session.cutClips([...this.session.selection.selectedClipIds]);
        this.onEdited();
      },
      paste: () => {
        const timeline = this.session ? currentTimeline(this.session.document) : null;
        const first = timeline?.tracks[0];
        if (this.session && first) {
          this.session.pasteClips(this.app.player.currentTime.asNumber(), first.id);
          this.onEdited();
        }
      },
      undo: () => {
        this.session?.undo();
        this.onEdited();
      },
      redo: () => {
        this.session?.redo();
        this.onEdited();
      },
      addMarker: () => this.toolbarActions().addMarker(),
      zoomIn: () => {
        this.view?.setZoom((this.view.zoom() ?? 80) * 1.25);
        this.zoomControl?.refresh();
        this.syncSize();
      },
      zoomOut: () => {
        this.view?.setZoom((this.view.zoom() ?? 80) / 1.25);
        this.zoomControl?.refresh();
        this.syncSize();
      },
      zoomFit: () => {
        this.zoomControl?.zoomFit();
        this.syncSize();
      },
      toggleEnabled: () => {
        if (!this.session) return;
        for (const id of this.session.selection.selectedClipIds) this.session.toggleClipEnabled(id);
        this.onEdited();
      },
      saveProject: () => {
        void this.app.saveProject();
      },
    };
  }

  /** rAF loop: playhead + viewport window stay in sync with the player. */
  private startPlayheadLoop(): void {
    const tick = (): void => {
      this.playheadFrame = requestAnimationFrame(tick);
      if (!this.view || !this.playhead) return;
      const seconds = this.app.player.currentTime.asNumber();
      const x = this.view.timeToX(seconds);
      this.playhead.setPosition(x, seconds);
      // Fase 9: two elements paint the playhead — this panel's draggable line
      // and the view's own (`TimelineView.updatePlayhead`, the one drawn over
      // the clip canvas). The view's was only repositioned on edits and
      // scrubs, so during playback the timeline showed the moving line plus a
      // frozen red line where play had started: "el playhead no responde".
      this.view.updatePlayhead();
      if (x < 0 || x > this.view.viewport().width) this.playhead.hide();
      else this.playhead.show();
    };
    this.playheadFrame = requestAnimationFrame(tick);
  }

  /** Remembers the zoom in user settings. */
  private saveZoomSetting(): void {
    // Zoom is transient per open project; nothing durable to store yet.
  }

  /** Opens a marker editor (double-click on the ruler markers). */
  openMarker(marker: MarkerData): void {
    if (!this.session) return;
    openMarkerEditor(marker, (op) => {
      this.run(op);
    });
  }

  /** Duplicate for keyboard/toolbar reuse. */
  duplicateSelection(): void {
    if (!this.session) return;
    this.session.duplicateClips([...this.session.selection.selectedClipIds]);
    this.onEdited();
  }
}

/** Grabs one frame of a stored video blob at a time, for clip thumbnails. */
async function grabVideoFrame(blob: Blob, timeSeconds: number): Promise<HTMLCanvasElement | null> {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return null;
  const url = URL.createObjectURL(blob);
  try {
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    video.src = url;
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error('video load failed'));
    });
    video.currentTime = Math.max(0, Math.min(timeSeconds, Math.max(0, (video.duration || 1) - 0.05)));
    await new Promise<void>((resolve) => {
      video.onseeked = () => resolve();
      window.setTimeout(resolve, 500);
    });
    const canvas = document.createElement('canvas');
    canvas.width = 96;
    canvas.height = 54;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Loads ops used by the menu. */
export { DeleteClipOperation, DeleteClipsOperation, DuplicateClipOperation, SetTrackPropertyOperation };
