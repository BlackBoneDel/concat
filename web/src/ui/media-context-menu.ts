// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Fase 4 media-card context menu (proxy, metadata, relink, OPFS) and the
 * metadata dialog. Keyboard: opens on the ContextMenu key / Shift+F10,
 * arrows move, Escape closes and returns focus.
 */

import type { DeepMetadata } from '../media/import/metadata-extractor.ts';
import { Dialog, formatBytes } from './modals/dialog.ts';

/** One entry of the menu. */
export interface MenuItem {
  label: string;
  action: () => void;
  disabled?: boolean;
}

let openMenu: { element: HTMLElement; close: () => void } | null = null;

/**
 * Shows a context menu at a point.
 * @param x viewport x.
 * @param y viewport y.
 * @param items entries.
 * @param returnFocus element focused after closing.
 * @returns a closer.
 */
export function showContextMenu(x: number, y: number, items: readonly MenuItem[], returnFocus?: HTMLElement): () => void {
  openMenu?.close();
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.setAttribute('role', 'menu');
  const buttons: HTMLButtonElement[] = [];
  for (const item of items) {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.textContent = item.label;
    button.disabled = item.disabled ?? false;
    button.addEventListener('click', () => {
      close();
      item.action();
    });
    buttons.push(button);
    menu.appendChild(button);
  }
  document.body.appendChild(menu);
  const width = menu.offsetWidth || 200;
  const height = menu.offsetHeight || items.length * 28;
  menu.style.left = `${Math.max(0, Math.min(x, window.innerWidth - width))}px`;
  menu.style.top = `${Math.max(0, Math.min(y, window.innerHeight - height))}px`;

  const onDown = (event: MouseEvent): void => {
    if (!menu.contains(event.target as Node | null)) close();
  };
  const onKey = (event: KeyboardEvent): void => {
    const enabled = buttons.filter((b) => !b.disabled);
    const index = enabled.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      close();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      enabled[(index + delta + enabled.length) % enabled.length]?.focus();
    }
  };
  const close = (): void => {
    document.removeEventListener('mousedown', onDown, true);
    menu.removeEventListener('keydown', onKey);
    window.removeEventListener('blur', close);
    menu.remove();
    if (openMenu?.element === menu) openMenu = null;
    returnFocus?.focus();
  };
  document.addEventListener('mousedown', onDown, true);
  menu.addEventListener('keydown', onKey);
  window.addEventListener('blur', close);
  buttons.find((b) => !b.disabled)?.focus();
  openMenu = { element: menu, close };
  return close;
}

/**
 * Shows an asset's deep metadata.
 * @param name asset name.
 * @param meta the metadata (null = unavailable).
 */
export function showMetadataDialog(name: string, meta: DeepMetadata | null): Dialog {
  const dialog = new Dialog({ title: `Metadatos — ${name}`, className: 'metadata-modal' });
  if (!meta) {
    const p = document.createElement('p');
    p.className = 'fx-note';
    p.textContent = 'El archivo no está disponible en el almacenamiento local.';
    dialog.body.appendChild(p);
  } else {
    const rows: [string, string][] = [
      ['Archivo', `${meta.name} (${formatBytes(meta.size)})`],
      ['Contenedor', meta.container],
      ['Tipo MIME', meta.mimeType || '—'],
      ['Vídeo', meta.videoCodec || '—'],
      ['Audio', meta.audioCodec ? `${meta.audioCodec} · ${meta.audioSampleRate} Hz · ${meta.audioChannels} canal(es)` : '—'],
      ['Duración', meta.duration !== null ? `${meta.duration.toFixed(3)} s` : '—'],
      ['Resolución', meta.width > 0 ? `${meta.width}×${meta.height} (${meta.aspectRatio})` : '—'],
      ['Fotogramas/s', meta.fps !== null ? meta.fps.toFixed(3) : '—'],
      ['Bitrate', meta.bitrate !== null ? `${(meta.bitrate / 1e6).toFixed(2)} Mbps` : '—'],
      ['Rotación', `${meta.rotation}°`],
      ['Creado', meta.creationTime ?? '—'],
      ['Codificador', meta.encoder ?? '—'],
      ['Soporte nativo', meta.nativelySupported ? 'Sí (WebCodecs)' : meta.needsFallback ? 'No — usa FFmpeg' : 'No'],
      ['Proxy recomendado', meta.needsProxy ? 'Sí' : 'No'],
    ];
    const list = document.createElement('dl');
    list.className = 'metadata-list';
    for (const [term, value] of rows) {
      const dt = document.createElement('dt');
      dt.textContent = term;
      const dd = document.createElement('dd');
      dd.textContent = value;
      list.append(dt, dd);
    }
    dialog.body.appendChild(list);
  }
  dialog.addButton('Cerrar', () => dialog.close(), 'primary');
  return dialog;
}
