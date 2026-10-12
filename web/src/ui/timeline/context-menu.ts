// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * ARIA context menu: keyboard navigable (arrows, Enter, Escape), closed
 * on outside click, restored focus on dismissal. Items can be disabled or
 * act as submenus-free one-shots.
 */

/** One menu entry. */
export interface MenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
  shortcut?: string;
}

/** A context menu on screen. */
export class ContextMenu {
  private readonly el: HTMLDivElement;
  private readonly abort = new AbortController();
  private readonly previouslyFocused: HTMLElement | null;
  private closed = false;

  /**
   * @param x screen x.
   * @param y screen y.
   * @param items the entries.
   */
  constructor(x: number, y: number, items: MenuItem[]) {
    this.previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.el = document.createElement('div');
    this.el.className = 'tl-context-menu';
    this.el.setAttribute('role', 'menu');
    this.el.setAttribute('aria-label', 'Menú contextual');
    const buttons: HTMLButtonElement[] = [];
    for (const item of items) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `tl-menu-item${item.danger ? ' danger' : ''}`;
      button.setAttribute('role', 'menuitem');
      button.disabled = item.disabled === true;
      const label = document.createElement('span');
      label.textContent = item.label;
      button.appendChild(label);
      if (item.shortcut) {
        const shortcut = document.createElement('kbd');
        shortcut.textContent = item.shortcut;
        button.appendChild(shortcut);
      }
      button.addEventListener('click', () => {
        item.onSelect();
        this.close();
      });
      buttons.push(button);
      this.el.appendChild(button);
    }
    document.body.appendChild(this.el);
    // Keep the menu on screen.
    const rect = this.el.getBoundingClientRect();
    this.el.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
    this.el.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;
    const signal = this.abort.signal;
    window.addEventListener('pointerdown', this.onOutside, { signal, capture: true });
    window.addEventListener('keydown', this.onKeyDown, { signal });
    buttons[0]?.focus();
  }

  /** Keyboard navigation. */
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const buttons = [...this.el.querySelectorAll<HTMLButtonElement>('.tl-menu-item')];
    const index = buttons.findIndex((button) => button === document.activeElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.close();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      buttons[(index + 1) % buttons.length]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      buttons[(index - 1 + buttons.length) % buttons.length]?.focus();
    }
  };

  /** Closes on outside pointerdown. */
  private readonly onOutside = (event: Event): void => {
    if (event.target instanceof Node && !this.el.contains(event.target)) this.close();
  };

  /** Dismisses the menu and restores focus. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    this.el.remove();
    this.previouslyFocused?.focus();
  }
}
