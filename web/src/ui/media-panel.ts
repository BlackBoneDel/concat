// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The media panel: import (button + drag & drop) and the library grid.
 * Double-clicking an item drops it on the timeline at the playhead; a single
 * click selects it for the inspector's media info.
 *
 * Fase 4: folder and subtitle import, proxy badge ("P") with progress,
 * offline state (click to relink) and a context menu with proxy, metadata,
 * relink and OPFS actions.
 *
 * Import bulletproofing: every import button opens the one global picker
 * (attached to `document.body`, see `global-file-input.ts`), the drop zone
 * stops propagation so the window-wide capture does not import the same
 * files twice, and a card exists from the first millisecond — while its
 * metadata is being probed it shows a spinner ("Procesando…"), and if the
 * probe fails it stays with its placeholder thumbnail instead of vanishing.
 */

import { icon } from './components/icons.ts';
import type { MediaAsset } from '../media/media-pool.ts';
import type { AppContext } from './app-context.ts';
import { formatDuration } from '../player/timecode.ts';
import { getMediaTools } from './media-tools.ts';
import { showContextMenu, showMetadataDialog } from './media-context-menu.ts';
import { openGlobalFilePicker } from './global-file-input.ts';
import { markDropHandled } from './timeline/file-drop.ts';

/** Subtitle extensions routed to the subtitle importer on drop. */
const SUBTITLE_FILE = /\.(srt|vtt)$/i;

/** The left panel of the shell. */
export class MediaPanel {
  private readonly root: HTMLElement;
  private readonly ctx: AppContext;
  private readonly grid: HTMLElement;
  private readonly empty: HTMLElement;
  private selectedId: string | null = null;

  /**
   * @param root the panel element.
   * @param ctx the app services.
   */
  constructor(root: HTMLElement, ctx: AppContext) {
    this.root = root;
    this.ctx = ctx;

    const header = document.createElement('div');
    header.className = 'panel-header';
    const title = document.createElement('h2');
    title.className = 'panel-title';
    title.textContent = 'Medios';
    header.appendChild(title);

    const importButton = document.createElement('button');
    importButton.type = 'button';
    importButton.className = 'btn btn-primary btn-small';
    importButton.textContent = '+ Importar';
    importButton.title = 'Importar archivos (Ctrl+I)';
    importButton.addEventListener('click', () => this.openPicker());
    header.appendChild(importButton);

    // Fase 4: folder (bulk) and subtitle import.
    const folderButton = document.createElement('button');
    folderButton.type = 'button';
    folderButton.className = 'btn btn-ghost btn-small';
    folderButton.textContent = 'Carpeta…';
    folderButton.title = 'Importar una carpeta completa';
    folderButton.addEventListener('click', () => getMediaTools()?.importFolder());
    const subtitleButton = document.createElement('button');
    subtitleButton.type = 'button';
    subtitleButton.className = 'btn btn-ghost btn-small';
    subtitleButton.textContent = 'Subtítulos…';
    subtitleButton.title = 'Importar subtítulos (.srt / .vtt)';
    subtitleButton.addEventListener('click', () => this.openSubtitlePicker());
    header.append(folderButton, subtitleButton);
    this.root.appendChild(header);

    const drop = document.createElement('div');
    drop.className = 'media-drop';
    this.grid = document.createElement('div');
    this.grid.className = 'media-grid';
    this.empty = document.createElement('div');
    this.empty.className = 'panel-empty';
    this.empty.textContent = 'Arrastra archivos aquí o pulsa Importar';
    drop.appendChild(this.empty);
    drop.appendChild(this.grid);
    this.root.appendChild(drop);

    drop.addEventListener('dragover', (event) => {
      event.preventDefault();
      drop.classList.add('drag-over');
    });
    drop.addEventListener('dragleave', () => drop.classList.remove('drag-over'));
    drop.addEventListener('drop', (event) => {
      event.preventDefault();
      // The panel owns this drop: it must not reach the window-wide capture
      // (which would import the same files a second time).
      event.stopPropagation();
      markDropHandled(event);
      drop.classList.remove('drag-over');
      const files = [...(event.dataTransfer?.files ?? [])];
      const subtitles = files.filter((file) => SUBTITLE_FILE.test(file.name));
      const media = files.filter((file) => !SUBTITLE_FILE.test(file.name));
      if (media.length > 0) void this.ctx.importFiles(media);
      for (const file of subtitles) void getMediaTools()?.importSubtitles(file);
    });

    document.addEventListener('media-library-changed', () => this.refresh());
    // Fase 4: proxy progress / offline changes repaint the badges.
    document.addEventListener('media-proxy-changed', () => this.refresh());
    this.refresh();
  }

  /** Re-reads the pool into the grid. */
  refresh(): void {
    this.grid.replaceChildren();
    const assets = this.ctx.pool.listMedia();
    this.empty.style.display = assets.length === 0 ? '' : 'none';
    for (const asset of assets) {
      this.grid.appendChild(this.card(asset));
    }
  }

  /**
   * Opens the media picker: the global input (attached to `document.body`,
   * so `change` fires everywhere) when it is installed, and a throwaway one
   * only as a fallback for a context that never installed it.
   */
  openPicker(): void {
    if (openGlobalFilePicker()) return;
    const input = this.attachPicker();
    input.accept = 'video/*,audio/*,image/*,.mp4,.mkv,.mov,.webm,.avi,.wav,.mp3,.png,.jpg,.jpeg';
    input.addEventListener('change', () => {
      const files = [...(input.files ?? [])];
      input.remove();
      if (files.length > 0) void this.ctx.importFiles(files);
    });
    input.click();
  }

  /** Opens the subtitle picker (Fase 4). */
  openSubtitlePicker(): void {
    const input = this.attachPicker();
    input.accept = '.srt,.vtt,text/vtt,application/x-subrip';
    input.multiple = false;
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      input.remove();
      if (file) void getMediaTools()?.importSubtitles(file);
    });
    input.click();
  }

  /**
   * A file input that is really in the document: an input that was only
   * created in memory does not fire `change` in several mobile and desktop
   * browsers, which is why the import used to "do nothing" there.
   */
  private attachPicker(): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.hidden = true;
    input.setAttribute('aria-hidden', 'true');
    input.setAttribute('style', 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;');
    document.body.appendChild(input);
    // The file dialog takes the focus while it is open; when the window gets
    // it back — selection made or cancelled — the throwaway input goes away.
    const cleanup = (): void => {
      window.removeEventListener('focus', cleanup);
      input.remove();
    };
    window.addEventListener('focus', cleanup);
    return input;
  }

  /** One library card. */
  private card(asset: MediaAsset): HTMLElement {
    const card = document.createElement('button');
    card.type = 'button';
    const processing = asset.status === 'processing';
    card.className = `media-card${this.selectedId === asset.id ? ' selected' : ''}${processing ? ' processing' : ''}`;
    card.dataset['status'] = asset.status;
    card.title = processing
      ? `${asset.name} — importando…`
      : `${asset.name} — doble clic añade al timeline`;

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
      thumbWrap.appendChild(icon('music', { size: 28, className: 'media-thumb-icon' }));
    }
    // Import in flight: a spinner over the (placeholder) thumbnail, so the
    // user sees the file was taken the instant it was dropped.
    if (processing) {
      const spinner = document.createElement('div');
      spinner.className = 'media-spinner';
      spinner.setAttribute('role', 'progressbar');
      spinner.setAttribute('aria-label', `Importando ${asset.name}`);
      thumbWrap.appendChild(spinner);
    }
    card.appendChild(thumbWrap);

    const meta = document.createElement('div');
    meta.className = 'media-meta';
    const name = document.createElement('div');
    name.className = 'media-name';
    name.textContent = asset.name;
    const detail = document.createElement('div');
    detail.className = 'media-detail';
    detail.textContent = processing
      ? 'Procesando…'
      : asset.type === 'image'
        ? `${asset.width}×${asset.height}`
        : `${formatDuration(asset.duration)} · ${asset.width}×${asset.height}`;
    meta.appendChild(name);
    meta.appendChild(detail);
    if (asset.status === 'error') {
      // The card stays: the file is in the library even when nothing could be
      // read from it, and the note says why.
      const note = document.createElement('div');
      note.className = 'media-status-note';
      note.textContent = 'Metadatos provisionales';
      if (asset.statusMessage) note.title = asset.statusMessage;
      meta.appendChild(note);
    }
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
    return card;
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
