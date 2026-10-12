// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The media panel — the left column of the CapCut-style HUD (Fase 8):
 * a tab strip (Medios, Texto, Transiciones, Efectos, Filtros, Plantillas),
 * a full-width import button, a collapsible tree with per-kind counts and the
 * three-column thumbnail grid with a duration badge.
 *
 * The library behaves exactly as before: import (button + drag & drop of OS
 * files), double-click to drop on the timeline, single click to select,
 * context menu with proxy/metadata/relink actions, and cards that are drag
 * sources for the timeline (`application/x-concat-media`).
 *
 * The catalog tabs list real project data (`TEXT_PRESETS`, `TRANSITION_KINDS`,
 * the effect catalog, the LUT library and the motion presets). Text entries
 * ask the timeline to add a title at the playhead; the rest are references
 * until their editors land, so they are shown as chips, never as dead
 * buttons that pretend to work.
 */

import { icon, iconButton } from './components/icons.ts';
import { writeMediaDrag } from './dnd/media-drag.ts';
import type { MediaAsset } from '../media/media-pool.ts';
import type { AppContext } from './app-context.ts';
import { formatDuration } from '../player/timecode.ts';
import { getMediaTools } from './media-tools.ts';
import { showContextMenu, showMetadataDialog } from './media-context-menu.ts';
import { TRANSITION_KINDS } from '../editor/operations.ts';
import { TEXT_PRESETS } from '../presets/text-presets.ts';
import { MOTION_PRESETS } from '../presets/motion-presets.ts';
import { EFFECT_FRAGMENT_SHADERS } from '../media/effects/video-effects.ts';
import { REQUEST_ADD_TEXT_EVENT } from './ui-events.ts';

/** Subtitle extensions routed to the subtitle importer on drop. */
const SUBTITLE_FILE = /\.(srt|vtt)$/i;

/** The tabs of the left column. */
const TABS: readonly { id: MediaTab; label: string; icon: Parameters<typeof icon>[0] }[] = [
  { id: 'media', label: 'Medios', icon: 'film' },
  { id: 'text', label: 'Texto', icon: 'text' },
  { id: 'transitions', label: 'Transiciones', icon: 'layers' },
  { id: 'effects', label: 'Efectos', icon: 'sparkles' },
  { id: 'filters', label: 'Filtros', icon: 'sliders' },
  { id: 'templates', label: 'Plantillas', icon: 'layoutGrid' },
];

/** The left column's tabs. */
export type MediaTab = 'media' | 'text' | 'transitions' | 'effects' | 'filters' | 'templates';

/** The kind filter of the library tree. */
type KindFilter = 'all' | 'video' | 'audio' | 'image';

/** Human labels of the catalog chips. */
const TRANSITION_LABELS: Readonly<Record<string, string>> = {
  crossfade: 'Fundido cruzado',
  dissolve: 'Disolvencia',
  'fade-black': 'Fundido a negro',
  'fade-white': 'Fundido a blanco',
  'wipe-left': 'Barrido a la izquierda',
  'wipe-right': 'Barrido a la derecha',
  'wipe-up': 'Barrido hacia arriba',
  'wipe-down': 'Barrido hacia abajo',
  'slide-left': 'Deslizar a la izquierda',
  'slide-right': 'Deslizar a la derecha',
};

/** The left panel of the shell. */
export class MediaPanel {
  private readonly root: HTMLElement;
  private readonly ctx: AppContext;
  private readonly grid: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly drop: HTMLElement;
  private readonly tabsEl: HTMLElement;
  private readonly catalog: HTMLElement;
  private readonly treeEl: HTMLElement;
  private readonly tabPanels = new Map<MediaTab, HTMLElement>();
  private readonly tabButtons = new Map<MediaTab, HTMLButtonElement>();
  private readonly treeButtons = new Map<KindFilter, HTMLButtonElement>();
  private selectedId: string | null = null;
  private tab: MediaTab = 'media';
  private filter: KindFilter = 'all';

  /**
   * @param root the panel element.
   * @param ctx the app services.
   */
  constructor(root: HTMLElement, ctx: AppContext) {
    this.root = root;
    this.ctx = ctx;

    const header = document.createElement('div');
    header.className = 'panel-header panel-header-media';
    const title = document.createElement('h2');
    title.className = 'panel-title';
    title.textContent = 'Medios';
    header.appendChild(title);
    const actions = document.createElement('div');
    actions.className = 'panel-header-actions';
    // Fase 8: the imports live in the icon row; the button below is the CTA.
    actions.append(
      iconButton({ icon: 'folder', label: 'Importar una carpeta completa', size: 16, className: 'media-header-btn media-header-folder', onClick: () => getMediaTools()?.importFolder() }),
      iconButton({ icon: 'text', label: 'Importar subtítulos (.srt / .vtt)', size: 16, className: 'media-header-btn media-header-subtitles', onClick: () => this.openSubtitlePicker() }),
    );
    header.appendChild(actions);
    this.root.appendChild(header);

    // Tabs.
    this.tabsEl = document.createElement('div');
    this.tabsEl.className = 'panel-tabs';
    this.tabsEl.setAttribute('role', 'tablist');
    this.tabsEl.setAttribute('aria-label', 'Biblioteca');
    for (const tab of TABS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'panel-tab';
      button.dataset['tab'] = tab.id;
      button.setAttribute('role', 'tab');
      button.title = tab.label;
      button.append(icon(tab.icon, { size: 14 }));
      const label = document.createElement('span');
      label.className = 'panel-tab-label';
      label.textContent = tab.label;
      button.appendChild(label);
      button.addEventListener('click', () => this.setTab(tab.id));
      this.tabButtons.set(tab.id, button);
      this.tabsEl.appendChild(button);
    }
    this.root.appendChild(this.tabsEl);

    const body = document.createElement('div');
    body.className = 'panel-body';
    this.root.appendChild(body);

    // Media tab: import CTA, tree, grid.
    const mediaPanel = document.createElement('div');
    mediaPanel.className = 'media-tab-panel media-tab-panel-media';
    this.tabPanels.set('media', mediaPanel);

    const importRow = document.createElement('div');
    importRow.className = 'media-import-row';
    const importButton = document.createElement('button');
    importButton.type = 'button';
    importButton.className = 'btn btn-primary media-import-btn';
    importButton.title = 'Importar archivos (Ctrl+I)';
    importButton.append(icon('plus', { size: 16 }));
    const importLabel = document.createElement('span');
    importLabel.textContent = 'Importar';
    importButton.appendChild(importLabel);
    importButton.addEventListener('click', () => this.openPicker());
    importRow.appendChild(importButton);
    mediaPanel.appendChild(importRow);

    this.treeEl = document.createElement('div');
    this.treeEl.className = 'media-tree';
    this.treeEl.setAttribute('role', 'group');
    this.treeEl.setAttribute('aria-label', 'Filtrar la biblioteca');
    const filters: readonly { id: KindFilter; label: string; glyph: 'film' | 'music' | 'layers' }[] = [
      { id: 'all', label: 'Todos los medios', glyph: 'film' },
      { id: 'video', label: 'Vídeo', glyph: 'film' },
      { id: 'audio', label: 'Audio', glyph: 'music' },
      { id: 'image', label: 'Imágenes', glyph: 'layers' },
    ];
    for (const entry of filters) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'media-tree-item';
      button.dataset['filter'] = entry.id;
      button.addEventListener('click', () => this.setFilter(entry.id));
      button.append(icon(entry.glyph, { size: 14 }));
      const label = document.createElement('span');
      label.className = 'media-tree-label';
      label.textContent = entry.label;
      const count = document.createElement('span');
      count.className = 'media-count';
      count.textContent = '0';
      button.append(label, count);
      this.treeButtons.set(entry.id, button);
      this.treeEl.appendChild(button);
    }
    mediaPanel.appendChild(this.treeEl);

    this.drop = document.createElement('div');
    this.drop.className = 'media-drop';
    this.empty = document.createElement('div');
    this.empty.className = 'panel-empty';
    this.empty.textContent = 'Arrastra archivos aquí o pulsa Importar';
    this.grid = document.createElement('div');
    this.grid.className = 'media-grid';
    this.drop.append(this.empty, this.grid);
    mediaPanel.appendChild(this.drop);
    body.appendChild(mediaPanel);

    // Catalog tabs (text, transitions, effects, filters, templates).
    this.catalog = document.createElement('div');
    this.catalog.className = 'media-catalog';
    body.appendChild(this.catalog);

    this.root.addEventListener('dragover', (event) => {
      event.preventDefault();
      this.drop.classList.add('drag-over');
    });
    this.root.addEventListener('dragleave', () => this.drop.classList.remove('drag-over'));
    this.root.addEventListener('drop', (event) => {
      event.preventDefault();
      this.drop.classList.remove('drag-over');
      const files = [...(event.dataTransfer?.files ?? [])];
      const subtitles = files.filter((file) => SUBTITLE_FILE.test(file.name));
      const media = files.filter((file) => !SUBTITLE_FILE.test(file.name));
      if (media.length > 0) void this.ctx.importFiles(media);
      for (const file of subtitles) void getMediaTools()?.importSubtitles(file);
    });

    document.addEventListener('media-library-changed', () => this.refresh());
    // Fase 4: proxy progress / offline changes repaint the badges.
    document.addEventListener('media-proxy-changed', () => this.refresh());
    this.setTab('media');
    this.refresh();
  }

  /** The active tab. */
  get activeTab(): MediaTab {
    return this.tab;
  }

  /**
   * Switches the visible tab.
   * @param tab the tab to show.
   */
  setTab(tab: MediaTab): void {
    this.tab = tab;
    for (const [id, button] of this.tabButtons) {
      const active = id === tab;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', String(active));
    }
    const media = this.tabPanels.get('media');
    if (media) media.hidden = tab !== 'media';
    this.catalog.hidden = tab === 'media';
    if (tab !== 'media') this.renderCatalog(tab);
  }

  /** Re-reads the pool into the grid, tree counts and catalog. */
  refresh(): void {
    const assets = this.ctx.pool.listMedia();
    const counts: Record<KindFilter, number> = { all: assets.length, video: 0, audio: 0, image: 0 };
    for (const asset of assets) counts[asset.type] += 1;
    for (const [id, button] of this.treeButtons) {
      const count = button.querySelector('.media-count');
      if (count) count.textContent = String(counts[id]);
      button.classList.toggle('is-active', id === this.filter);
      button.setAttribute('aria-pressed', String(id === this.filter));
    }

    this.grid.replaceChildren();
    const visible = this.filter === 'all' ? assets : assets.filter((asset) => asset.type === this.filter);
    this.empty.style.display = assets.length === 0 ? '' : 'none';
    this.empty.textContent =
      assets.length === 0
        ? 'Arrastra archivos aquí o pulsa Importar'
        : 'Ningún medio de este tipo en la biblioteca';
    for (const asset of visible) this.grid.appendChild(this.card(asset));
    if (this.tab !== 'media') this.renderCatalog(this.tab);
  }

  /** Opens the file picker. */
  openPicker(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = 'video/*,audio/*,image/*';
    input.addEventListener('change', () => {
      const files = [...(input.files ?? [])];
      if (files.length > 0) void this.ctx.importFiles(files);
    });
    input.click();
  }

  /** Opens the subtitle picker (Fase 4). */
  openSubtitlePicker(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.srt,.vtt,text/vtt,application/x-subrip';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file) void getMediaTools()?.importSubtitles(file);
    });
    input.click();
  }

  /** One library card. */
  private card(asset: MediaAsset): HTMLElement {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `media-card${this.selectedId === asset.id ? ' selected' : ''}`;
    card.title = `${asset.name} — doble clic añade al timeline`;

    const thumbWrap = document.createElement('div');
    thumbWrap.className = 'media-thumb';
    if (asset.thumbnailUrl !== '') {
      const img = document.createElement('img');
      img.src = asset.thumbnailUrl;
      img.alt = '';
      thumbWrap.appendChild(img);
    } else {
      thumbWrap.classList.add('media-thumb-audio');
      // Fase 7 hook: SVG glyph for audio-only assets.
      thumbWrap.appendChild(icon(asset.type === 'image' ? 'layers' : 'music', { size: 28, className: 'media-thumb-icon' }));
    }
    // Fase 8: the duration badge rides the thumbnail, CapCut style.
    const badge = document.createElement('span');
    badge.className = 'media-duration-badge';
    badge.textContent = asset.type === 'image' ? 'Imagen' : formatDuration(asset.duration);
    badge.title = asset.type === 'image' ? 'Fotograma fijo' : `Duración: ${formatDuration(asset.duration)}`;
    thumbWrap.appendChild(badge);
    card.appendChild(thumbWrap);

    const meta = document.createElement('div');
    meta.className = 'media-meta';
    const name = document.createElement('div');
    name.className = 'media-name';
    name.textContent = asset.name;
    const detail = document.createElement('div');
    detail.className = 'media-detail';
    detail.textContent =
      asset.type === 'image'
        ? `${asset.width}×${asset.height}`
        : `${formatDuration(asset.duration)} · ${asset.width}×${asset.height}`;
    meta.appendChild(name);
    meta.appendChild(detail);
    card.appendChild(meta);

    const remove = document.createElement('span');
    remove.className = 'media-remove';
    remove.title = 'Quitar de la biblioteca';
    remove.textContent = '×';
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      void this.removeAsset(asset);
    });
    card.appendChild(remove);
    this.decorate(card, asset);

    card.addEventListener('click', () => {
      if (getMediaTools()?.offlineIds.has(asset.id)) {
        getMediaTools()?.openRelink(asset.id);
        return;
      }
      this.selectedId = asset.id;
      this.refresh();
    });
    card.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      this.openMenu(asset, event.clientX, event.clientY, card);
    });
    card.addEventListener('keydown', (event) => {
      if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
        event.preventDefault();
        const rect = card.getBoundingClientRect();
        this.openMenu(asset, rect.left + 8, rect.top + 8, card);
      }
    });
    card.addEventListener('dblclick', () => this.ctx.addMediaToTimeline(asset.id));
    this.makeDraggable(card, asset);
    return card;
  }

  /**
   * Turns a card into a drag source for the timeline (Fase 8). The payload
   * rides on the internal `application/x-concat-media*` types, so dropping it
   * on the timeline inserts a clip while an OS file drop keeps importing.
   * @param card the card element.
   * @param asset the asset it shows.
   */
  private makeDraggable(card: HTMLElement, asset: MediaAsset): void {
    card.setAttribute('draggable', 'true');
    card.draggable = true;
    card.addEventListener('dragstart', (event) => {
      const transfer = (event as DragEvent).dataTransfer;
      if (!transfer) return;
      const written = writeMediaDrag(transfer, {
        mediaId: asset.id,
        kind: asset.type,
        durationSeconds: asset.duration.asNumber(),
        name: asset.name,
      });
      if (!written) return;
      // Ghost image: a scaled copy of the card, never a browser default.
      if (typeof transfer.setDragImage === 'function') {
        const ghost = card.cloneNode(true) as HTMLElement;
        ghost.style.position = 'absolute';
        ghost.style.top = '-9999px';
        ghost.style.left = '0';
        ghost.style.opacity = '0.75';
        ghost.style.transform = 'scale(0.8)';
        ghost.style.pointerEvents = 'none';
        document.body.appendChild(ghost);
        transfer.setDragImage(ghost, 20, 20);
        setTimeout(() => ghost.remove(), 0);
      }
      card.classList.add('media-card--dragging');
      // The timeline listens on the document for the drag's end too.
      document.dispatchEvent(new CustomEvent('media-drag-start', { detail: asset.id }));
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('media-card--dragging');
      document.dispatchEvent(new CustomEvent('media-drag-end'));
    });
  }

  /** Fase 4: proxy badge, progress and offline state. */
  private decorate(card: HTMLElement, asset: MediaAsset): void {
    const tools = getMediaTools();
    if (!tools) return;
    if (tools.offlineIds.has(asset.id)) {
      card.classList.add('offline');
      card.title = `${asset.name} — sin conexión, clic para volver a vincular`;
      const label = document.createElement('div');
      label.className = 'media-offline';
      label.textContent = 'Sin conexión';
      card.querySelector('.media-meta')?.appendChild(label);
    }
    if (asset.type !== 'video') return;
    const state = tools.proxyState(asset.id);
    if (state.status === 'none') return;
    const badge = document.createElement('span');
    badge.className = `media-badge proxy-${state.status}`;
    badge.textContent = 'P';
    const labels = { pending: 'Proxy en cola', generating: `Generando proxy ${Math.round(state.progress * 100)}%`, ready: 'Proxy listo', error: `Error de proxy: ${state.error ?? ''}` } as const;
    badge.title = labels[state.status];
    badge.setAttribute('aria-label', labels[state.status]);
    card.appendChild(badge);
    if (state.status === 'generating') {
      const bar = document.createElement('div');
      bar.className = 'media-proxy-progress';
      bar.style.width = `${Math.round(state.progress * 100)}%`;
      card.querySelector('.media-thumb')?.appendChild(bar);
    }
  }

  /** Fase 4: the card context menu. */
  private openMenu(asset: MediaAsset, x: number, y: number, card: HTMLElement): void {
    const tools = getMediaTools();
    const state = tools?.proxyState(asset.id);
    const video = asset.type === 'video';
    const busy = state?.status === 'generating' || state?.status === 'pending';
    showContextMenu(x, y, [
      { label: 'Añadir al timeline', action: () => this.ctx.addMediaToTimeline(asset.id) },
      { label: state?.status === 'ready' ? 'Regenerar proxy 720p' : 'Generar proxy 720p', action: () => tools?.generateProxy(asset.id, 'default'), disabled: !tools || !video || busy },
      { label: 'Generar proxy 360p', action: () => tools?.generateProxy(asset.id, 'low'), disabled: !tools || !video || busy },
      { label: busy ? 'Cancelar proxy' : 'Borrar proxy', action: () => tools?.deleteProxy(asset.id), disabled: !tools || !state || state.status === 'none' },
      { label: 'Ver metadatos…', action: () => void tools?.metadata(asset.id).then((meta) => showMetadataDialog(asset.name, meta)), disabled: !tools },
      { label: 'Volver a vincular…', action: () => tools?.openRelink(asset.id), disabled: !tools },
      { label: 'Gestor de proxies…', action: () => tools?.openProxyManager(), disabled: !tools },
      { label: 'Eliminar del almacenamiento (OPFS)', action: () => void this.removeAsset(asset) },
    ], card);
  }

  /**
   * Fase 8: the catalog of a non-media tab — real project data, honest labels.
   * @param tab the tab to render.
   */
  private renderCatalog(tab: MediaTab): void {
    this.catalog.replaceChildren();
    if (tab === 'text') {
      this.catalogSection('Títulos', 'Se añaden al playhead en la pista seleccionada.');
      for (const preset of TEXT_PRESETS) {
        this.catalogRow(preset.name, preset.type === 'text' ? 'Título con estilo propio' : 'Animación de entrada', [{
          label: 'Añadir',
          onClick: () => document.dispatchEvent(new CustomEvent(REQUEST_ADD_TEXT_EVENT, { detail: preset.name })),
        }]);
      }
      return;
    }
    if (tab === 'transitions') {
      this.catalogSection('Transiciones', 'Se aplican entre dos clips contiguos de la misma pista.');
      this.chips(TRANSITION_KINDS.map((kind) => TRANSITION_LABELS[kind] ?? kind));
      return;
    }
    if (tab === 'effects') {
      this.catalogSection('Efectos', 'Se apilan en el inspector del clip seleccionado.');
      this.chips(Object.keys(EFFECT_FRAGMENT_SHADERS).map((name) => name.charAt(0).toUpperCase() + name.slice(1)));
      return;
    }
    if (tab === 'filters') {
      const luts = getMediaTools()?.luts.list() ?? [];
      this.catalogSection('Filtros (LUT)', 'Archivo → Importar LUT carga un .cube en la biblioteca.');
      if (luts.length === 0) this.catalogHint('Aún no hay LUT en la biblioteca del proyecto.');
      else this.chips(luts.map((lut) => lut.title));
      return;
    }
    this.catalogSection('Plantillas', 'Animaciones de entrada listas para el clip seleccionado.');
    this.chips([...MOTION_PRESETS, ...TEXT_PRESETS].map((preset) => preset.name));
  }

  /** A catalog section: title plus a one-line hint. */
  private catalogSection(title: string, hint: string): void {
    const heading = document.createElement('h3');
    heading.className = 'media-catalog-title';
    heading.textContent = title;
    const note = document.createElement('p');
    note.className = 'media-catalog-hint';
    note.textContent = hint;
    this.catalog.append(heading, note);
  }

  /** A row with one action (titles). */
  private catalogRow(name: string, detail: string, actions: readonly { label: string; onClick: () => void }[]): void {
    const row = document.createElement('div');
    row.className = 'media-catalog-row';
    const text = document.createElement('div');
    text.className = 'media-catalog-text';
    const title = document.createElement('div');
    title.className = 'media-catalog-name';
    title.textContent = name;
    const sub = document.createElement('div');
    sub.className = 'media-catalog-detail';
    sub.textContent = detail;
    text.append(title, sub);
    row.appendChild(text);
    for (const action of actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-ghost btn-small media-catalog-action';
      button.textContent = action.label;
      button.addEventListener('click', action.onClick);
      row.appendChild(button);
    }
    this.catalog.appendChild(row);
  }

  /** Read-only chips (transitions, effects, LUTs, presets). */
  private chips(labels: readonly string[]): void {
    const wrap = document.createElement('div');
    wrap.className = 'media-chips';
    for (const label of labels) {
      const chip = document.createElement('span');
      chip.className = 'media-chip';
      chip.textContent = label;
      wrap.appendChild(chip);
    }
    this.catalog.appendChild(wrap);
  }

  /** A muted hint line. */
  private catalogHint(text: string): void {
    const hint = document.createElement('p');
    hint.className = 'media-catalog-hint';
    hint.textContent = text;
    this.catalog.appendChild(hint);
  }

  /** Applies the tree filter. */
  private setFilter(filter: KindFilter): void {
    this.filter = filter;
    this.refresh();
  }

  /** Removes an asset after confirmation. */
  private async removeAsset(asset: MediaAsset): Promise<void> {
    const ok = await this.ctx.notifications.confirm(
      'Quitar medio',
      `Se eliminará "${asset.name}" de la biblioteca y del almacenamiento local.`,
    );
    if (!ok) return;
    this.ctx.pool.removeMedia(asset.id);
    void this.ctx.mediaStore.deleteFile(asset.id);
    getMediaTools()?.deleteProxy(asset.id);
    if (this.selectedId === asset.id) this.selectedId = null;
    this.refresh();
    this.ctx.requestAutosave();
    this.ctx.notifications.info('Medio eliminado', asset.name);
  }
}
