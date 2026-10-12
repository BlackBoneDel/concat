// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The media panel: import (button + drag & drop) and the library grid.
 * Double-clicking an item drops it on the timeline at the playhead; a single
 * click selects it for the inspector's media info.
 */

import type { MediaAsset } from '../media/media-pool.ts';
import type { AppContext } from './app-context.ts';
import { formatDuration } from '../player/timecode.ts';

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
      if (files.length > 0) void this.ctx.importFiles(files);
    });

    document.addEventListener('media-library-changed', () => this.refresh());
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

    card.addEventListener('click', () => {
      this.selectedId = asset.id;
      this.refresh();
    });
    card.addEventListener('dblclick', () => this.ctx.addMediaToTimeline(asset.id));
    return card;
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
    if (this.selectedId === asset.id) this.selectedId = null;
    this.refresh();
    this.ctx.requestAutosave();
    this.ctx.notifications.info('Medio eliminado', asset.name);
  }
}
