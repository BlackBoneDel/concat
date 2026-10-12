// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Proxy manager: per-asset proxy state with progress, generate (default /
 * low quality), delete, generate all recommended, and free space.
 */

import type { ProxyState } from '../media-tools.ts';
import { Dialog, formatBytes, progressBar } from './dialog.ts';

/** An asset row. */
export interface ProxyAssetInfo {
  id: string;
  name: string;
  width: number;
  height: number;
  /** The auto policy recommends a proxy. */
  recommended: boolean;
}

/** Data and actions of the dialog. */
export interface ProxyModalSource {
  assets(): ProxyAssetInfo[];
  state(id: string): ProxyState;
  generate(id: string, quality: 'default' | 'low'): void;
  remove(id: string): void;
  clearAll(): Promise<void>;
  usage(): Promise<{ bytes: number; limit: number }>;
  /** Change notifications (progress ~500 ms); returns unsubscribe. */
  subscribe(listener: () => void): () => void;
}

const STATUS_LABEL: Record<ProxyState['status'], string> = {
  none: 'Sin proxy', pending: 'En cola', generating: 'Generando', ready: 'Listo', error: 'Error',
};

/**
 * Opens the manager.
 * @param source data provider.
 * @returns resolves when closed.
 */
export function openProxyModal(source: ProxyModalSource): Promise<void> {
  const dialog = new Dialog({
    title: 'Proxies',
    description: 'Copias ligeras (720p, H.264) para editar con fluidez. La exportación siempre usa el original.',
    className: 'proxy-modal',
  });
  const usage = document.createElement('p');
  usage.className = 'fx-note';
  const list = document.createElement('div');
  list.className = 'proxy-list';
  list.setAttribute('role', 'list');
  dialog.body.append(usage, list);

  const refreshUsage = (): void => {
    void source.usage().then((u) => {
      usage.textContent = `Espacio de proxies: ${formatBytes(u.bytes)} de ${formatBytes(u.limit)}`;
    }).catch(() => {
      usage.textContent = 'Espacio de proxies: no disponible';
    });
  };

  const render = (): void => {
    list.replaceChildren();
    const assets = source.assets();
    if (assets.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'panel-empty';
      empty.textContent = 'No hay vídeos en la biblioteca.';
      list.appendChild(empty);
    }
    for (const asset of assets) {
      const state = source.state(asset.id);
      const row = document.createElement('div');
      row.className = `proxy-row status-${state.status}`;
      row.setAttribute('role', 'listitem');
      const name = document.createElement('span');
      name.className = 'proxy-name';
      name.textContent = `${asset.name} (${asset.width}×${asset.height})${asset.recommended ? ' · recomendado' : ''}`;
      const label = document.createElement('span');
      label.className = 'proxy-status';
      label.textContent = state.status === 'error' && state.error ? `Error: ${state.error}` : STATUS_LABEL[state.status];
      row.append(name, label);
      if (state.status === 'generating' || state.status === 'pending') {
        const bar = progressBar(`Proxy de ${asset.name}`);
        bar.set(state.progress);
        row.appendChild(bar.element);
      }
      const make = (text: string, onClick: () => void, aria: string): HTMLButtonElement => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn btn-ghost btn-small';
        b.textContent = text;
        b.setAttribute('aria-label', aria);
        b.addEventListener('click', onClick);
        return b;
      };
      const busy = state.status === 'generating' || state.status === 'pending';
      const gen = make(state.status === 'ready' ? 'Regenerar' : 'Generar 720p', () => source.generate(asset.id, 'default'), `Generar proxy 720p de ${asset.name}`);
      const low = make('Generar 360p', () => source.generate(asset.id, 'low'), `Generar proxy 360p de ${asset.name}`);
      const del = make(busy ? 'Cancelar' : 'Borrar', () => source.remove(asset.id), `Borrar proxy de ${asset.name}`);
      gen.disabled = busy;
      low.disabled = busy;
      del.disabled = state.status === 'none';
      row.append(gen, low, del);
      list.appendChild(row);
    }
  };

  const unsubscribe = source.subscribe(() => {
    if (dialog.isOpen) render();
  });
  dialog.onClose(unsubscribe);
  dialog.addButton('Generar recomendados', () => {
    for (const asset of source.assets()) {
      if (asset.recommended && source.state(asset.id).status === 'none') source.generate(asset.id, 'default');
    }
  });
  dialog.addButton('Borrar todos', () => {
    void source.clearAll().then(() => {
      render();
      refreshUsage();
    });
  }, 'danger');
  dialog.addButton('Cerrar', () => dialog.close(), 'primary');
  render();
  refreshUsage();
  return dialog.closed;
}
