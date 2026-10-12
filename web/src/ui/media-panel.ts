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
 */

import type { MediaAsset } from '../media/media-pool.ts';
import type { AppContext } from './app-context.ts';
import { formatDuration } from '../player/timecode.ts';
import { getMediaTools } from './media-tools.ts';
import { showContextMenu, showMetadataDialog } from './media-context-menu.ts';

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
      thumbWrap.textContent = '♪';
    }
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
