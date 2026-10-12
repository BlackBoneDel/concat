// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The header bar: brand, menus, project identity, save state, undo/redo,
 * theme toggle and the settings/shortcuts modals. Menus are modal pickers —
 * keyboard reachable, no hover-only chrome.
 */

import { DEFAULT_SHORTCUTS } from './shortcuts.ts';
import { THEMES, type ThemeName } from './theme-manager.ts';
import { Modal } from './modal.ts';
import type { AppContext } from './app-context.ts';
import markUrl from '../assets/concat-mark.png';

/** Human-readable byte count for the project list. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The 48px top bar of the shell. */
export class HeaderBar {
  private readonly root: HTMLElement;
  private readonly ctx: AppContext;
  private readonly saveState: HTMLElement;
  private readonly projectName: HTMLElement;

  /**
   * @param root the header element.
   * @param ctx the app services.
   */
  constructor(root: HTMLElement, ctx: AppContext) {
    this.root = root;
    this.ctx = ctx;

    // Brand.
    const brand = document.createElement('div');
    brand.className = 'header-brand';
    const mark = document.createElement('img');
    mark.className = 'header-mark';
    mark.src = markUrl;
    mark.alt = 'Concat';
    brand.appendChild(mark);
    const name = document.createElement('span');
    name.className = 'header-title';
    name.textContent = 'Concat';
    brand.appendChild(name);
    this.root.appendChild(brand);

    // Menus.
    const menus = document.createElement('nav');
    menus.className = 'header-menus';
    menus.appendChild(this.menuButton('Archivo', () => this.openFileMenu()));
    menus.appendChild(this.menuButton('Edición', () => this.openEditMenu()));
    menus.appendChild(this.menuButton('Ajustes', () => this.openSettingsModal()));
    menus.appendChild(this.menuButton('Atajos', () => this.openShortcutsModal()));
    this.root.appendChild(menus);

    // Project identity.
    const identity = document.createElement('div');
    identity.className = 'header-identity';
    this.projectName = document.createElement('span');
    this.projectName.className = 'header-project';
    this.projectName.textContent = this.ctx.session.name;
    identity.appendChild(this.projectName);
    this.saveState = document.createElement('span');
    this.saveState.className = 'header-save-state';
    this.saveState.textContent = 'Guardado';
    identity.appendChild(this.saveState);
    this.root.appendChild(identity);

    // Actions.
    const actions = document.createElement('div');
    actions.className = 'header-actions';
    const undo = this.actionButton('↶', 'Deshacer (Ctrl+Z)', () => this.undo());
    const redo = this.actionButton('↷', 'Rehacer (Ctrl+Shift+Z)', () => this.redo());
    actions.appendChild(undo);
    actions.appendChild(redo);
    actions.appendChild(this.actionButton('💾', 'Guardar (Ctrl+S)', () => void this.ctx.saveProject()));
    actions.appendChild(
      this.actionButton('◐', 'Cambiar tema', () => {
        const order: ThemeName[] = ['dark', 'light', 'cyberpunk'];
        const next = order[(order.indexOf(this.ctx.theme.theme) + 1) % order.length] ?? 'dark';
        this.ctx.theme.apply(next, (theme) => {
          this.ctx.settings.theme = theme;
          this.ctx.saveSettings();
        });
      }),
    );
    this.root.appendChild(actions);

    document.addEventListener('project-changed', () => this.sync());
    this.sync();
  }

  /** Reflects name and dirty state. */
  sync(): void {
    this.projectName.textContent = this.ctx.session.name;
    this.saveState.textContent = this.ctx.session.dirty ? 'Cambios sin guardar' : 'Guardado';
    this.saveState.classList.toggle('dirty', this.ctx.session.dirty);
    this.projectName.title = 'Proyecto — pulsa para renombrar';
  }

  /** Marks a completed save with a toast and the "Guardado" state. */
  markSaved(): void {
    this.sync();
    this.ctx.notifications.success('Guardado', 'Proyecto guardado localmente.');
  }

  // -- internals -----------------------------------------------------------

  private menuButton(label: string, onClick: () => void): HTMLElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'header-menu';
    button.textContent = label;
    button.addEventListener('click', onClick);
    return button;
  }

  private actionButton(icon: string, title: string, onClick: () => void): HTMLElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-icon';
    button.textContent = icon;
    button.title = title;
    button.addEventListener('click', onClick);
    return button;
  }

  private openFileMenu(): void {
    const list = document.createElement('div');
    list.className = 'menu-list';
    list.appendChild(this.menuItem('Nuevo proyecto', 'Ctrl+N', () => void this.newProject()));
    list.appendChild(this.menuItem('Abrir proyecto…', 'Ctrl+O', () => this.openProjectModal()));
    list.appendChild(this.menuItem('Guardar', 'Ctrl+S', () => void this.ctx.saveProject()));
    list.appendChild(this.menuItem('Importar medios…', 'Ctrl+I', () => document.dispatchEvent(new CustomEvent('open-import'))));
    this.openMenu = new Modal('Archivo', list);
  }

  private openEditMenu(): void {
    const list = document.createElement('div');
    list.className = 'menu-list';
    list.appendChild(this.menuItem('Deshacer', 'Ctrl+Z', () => this.undo()));
    list.appendChild(this.menuItem('Rehacer', 'Ctrl+Shift+Z', () => this.redo()));
    list.appendChild(
      this.menuItem('Eliminar selección', 'Delete', () => {
        const id = this.ctx.selectedClipId;
        if (id) {
          this.ctx.history.push(this.ctx.session.document, this.ctx.session.documentSettings());
          this.ctx.session.removeClip(id);
          this.ctx.selectClip(null);
          this.ctx.session.dirty = true;
          this.ctx.requestRender();
          this.ctx.requestAutosave();
          document.dispatchEvent(new CustomEvent('timeline-changed'));
        }
      }),
    );
    this.openMenu = new Modal('Edición', list);
  }

  private menuItem(label: string, combo: string, onClick: () => void): HTMLElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'menu-item';
    const text = document.createElement('span');
    text.textContent = label;
    const shortcut = document.createElement('span');
    shortcut.className = 'menu-combo';
    shortcut.textContent = combo;
    button.appendChild(text);
    button.appendChild(shortcut);
    button.addEventListener('click', () => {
      this.openMenu?.close();
      this.openMenu = null;
      onClick();
    });
    return button;
  }

  /** The menu modal currently open, so items can close it. */
  private openMenu: Modal | null = null;

  private async newProject(): Promise<void> {
    const ok = await this.ctx.notifications.confirm(
      'Nuevo proyecto',
      'Se descartarán los cambios sin guardar del proyecto actual.',
      'Crear',
    );
    if (!ok) return;
    this.ctx.history.clear();
    // The main wiring owns the session instance; it swaps in a fresh
    // document when this lands.
    document.dispatchEvent(new CustomEvent('session-reset'));
    this.ctx.notifications.info('Nuevo proyecto', 'Timeline vacío listo.');
  }

  private async openProjectModal(): Promise<void> {
    const projects = await this.ctx.projectStore.listProjects();
    const list = document.createElement('div');
    list.className = 'menu-list';
    if (projects.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'modal-message';
      empty.textContent = 'No hay proyectos guardados.';
      list.appendChild(empty);
    }
    for (const project of projects) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'menu-item project-row';
      const text = document.createElement('span');
      text.textContent = project.name;
      const when = document.createElement('span');
      when.className = 'menu-combo';
      when.textContent = `${new Date(project.lastModified).toLocaleString()} · ${formatBytes(project.fileSize)}`;
      row.appendChild(text);
      row.appendChild(when);
      row.addEventListener('click', () => {
        document.querySelectorAll('.modal-backdrop').forEach((node) => node.remove());
        void this.ctx.openProject(project.id);
      });
      list.appendChild(row);
    }
    new Modal('Abrir proyecto', list);
  }

  private undo(): void {
    const restored = this.ctx.history.undo(this.ctx.session.document, this.ctx.session.documentSettings());
    if (!restored) {
      this.ctx.notifications.info('Nada que deshacer');
      return;
    }
    this.ctx.session.document = restored;
    this.ctx.session.rebuild();
    this.ctx.session.dirty = true;
    this.ctx.requestRender();
    document.dispatchEvent(new CustomEvent('timeline-changed'));
    document.dispatchEvent(new CustomEvent('selection-changed'));
  }

  private redo(): void {
    const restored = this.ctx.history.redo(this.ctx.session.document, this.ctx.session.documentSettings());
    if (!restored) {
      this.ctx.notifications.info('Nada que rehacer');
      return;
    }
    this.ctx.session.document = restored;
    this.ctx.session.rebuild();
    this.ctx.session.dirty = true;
    this.ctx.requestRender();
    document.dispatchEvent(new CustomEvent('timeline-changed'));
    document.dispatchEvent(new CustomEvent('selection-changed'));
  }

  private openSettingsModal(): void {
    const form = document.createElement('div');
    form.className = 'settings-form';

    const themeRow = this.selectRow(form, 'Tema', this.ctx.settings.theme, THEMES.map((theme) => theme.name), (value) => {
      this.ctx.theme.apply(value as ThemeName, (theme) => {
        this.ctx.settings.theme = theme;
      });
    });
    void themeRow;
    this.selectRow(form, 'Idioma', this.ctx.settings.language, ['en', 'es'], (value) => {
      this.ctx.settings.language = value as 'en' | 'es';
    });
    this.selectRow(form, 'Calidad de previsualización', this.ctx.settings.previewQuality, ['full', 'half', 'quarter'], (value) => {
      this.ctx.settings.previewQuality = value as 'full' | 'half' | 'quarter';
      document.dispatchEvent(new CustomEvent('preview-quality-changed'));
    });
    this.numberRow(form, 'Autoguardado (s)', this.ctx.settings.autosaveInterval, 5, 600, (value) => {
      this.ctx.settings.autosaveInterval = value;
    });
    this.numberRow(form, 'Duración por defecto de clip (s)', this.ctx.settings.defaultClipDuration, 0.1, 3600, (value) => {
      this.ctx.settings.defaultClipDuration = value;
    });
    this.numberRow(form, 'Transición por defecto (s)', this.ctx.settings.defaultTransitionDuration, 0, 60, (value) => {
      this.ctx.settings.defaultTransitionDuration = value;
    });
    this.numberRow(form, 'Tamaño de rejilla (px)', this.ctx.settings.gridSize, 1, 256, (value) => {
      this.ctx.settings.gridSize = value;
    });
    this.checkRow(form, 'Aceleración por hardware', this.ctx.settings.hardwareAcceleration, (value) => {
      this.ctx.settings.hardwareAcceleration = value;
    });
    this.checkRow(form, 'Mostrar notificaciones', this.ctx.settings.showTooltips, (value) => {
      this.ctx.settings.showTooltips = value;
      this.ctx.notifications.setEnabled(value);
    });
    this.checkRow(form, 'Imán a rejilla', this.ctx.settings.snapToGrid, (value) => {
      this.ctx.settings.snapToGrid = value;
    });

    new Modal('Configuración', form, {
      confirmLabel: 'Aplicar',
      cancelLabel: 'Cerrar',
      onConfirm: () => {
        this.ctx.saveSettings();
        this.ctx.notifications.success('Configuración', 'Ajustes aplicados.');
      },
    });
  }

  private openShortcutsModal(): void {
    const list = document.createElement('div');
    list.className = 'menu-list';
    for (const [action, combo] of Object.entries(DEFAULT_SHORTCUTS)) {
      const row = document.createElement('div');
      row.className = 'menu-item';
      const text = document.createElement('span');
      text.textContent = action;
      const shortcut = document.createElement('span');
      shortcut.className = 'menu-combo';
      shortcut.textContent = combo;
      row.appendChild(text);
      row.appendChild(shortcut);
      list.appendChild(row);
    }
    new Modal('Atajos de teclado', list);
  }

  // -- small form builders -------------------------------------------------

  private selectRow(
    form: HTMLElement,
    label: string,
    value: string,
    options: readonly string[],
    onChange: (value: string) => void,
  ): HTMLElement {
    const row = document.createElement('label');
    row.className = 'field-row';
    const text = document.createElement('span');
    text.className = 'field-label';
    text.textContent = label;
    const select = document.createElement('select');
    select.className = 'field-input';
    for (const optionValue of options) {
      const option = document.createElement('option');
      option.value = optionValue;
      option.textContent = optionValue;
      select.appendChild(option);
    }
    select.value = value;
    select.addEventListener('change', () => onChange(select.value));
    row.appendChild(text);
    row.appendChild(select);
    form.appendChild(row);
    return row;
  }

  private numberRow(
    form: HTMLElement,
    label: string,
    value: number,
    min: number,
    max: number,
    onChange: (value: number) => void,
  ): void {
    const row = document.createElement('label');
    row.className = 'field-row';
    const text = document.createElement('span');
    text.className = 'field-label';
    text.textContent = label;
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'field-input';
    input.min = String(min);
    input.max = String(max);
    input.step = '1';
    input.value = String(value);
    input.addEventListener('change', () => {
      if (input.reportValidity()) onChange(Number(input.value));
    });
    row.appendChild(text);
    row.appendChild(input);
    form.appendChild(row);
  }

  private checkRow(form: HTMLElement, label: string, checked: boolean, onChange: (value: boolean) => void): void {
    const row = document.createElement('label');
    row.className = 'field-row field-row-check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.addEventListener('change', () => onChange(input.checked));
    const text = document.createElement('span');
    text.className = 'field-label';
    text.textContent = label;
    row.appendChild(input);
    row.appendChild(text);
    form.appendChild(row);
  }
}
