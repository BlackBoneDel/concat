// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Keyboard shortcuts, in the spec's table. Bindings are matched on
 * `event.key` + modifiers; typed inputs keep their keys (except Escape).
 * The manager is inert until {@link KeyboardShortcuts.setEnabled}.
 */

/** A binding's match key: `Ctrl+Shift+K`-style. */
export type ShortcutCombo = string;

/** What a bound action receives. */
export type ShortcutHandler = (event: KeyboardEvent) => void;

/** The names of the built-in actions — the settings modal lists them. */
export const DEFAULT_SHORTCUTS: Readonly<Record<string, ShortcutCombo>> = Object.freeze({
  play: 'Space',
  cut: 'Ctrl+K',
  delete: 'Delete',
  copy: 'Ctrl+C',
  paste: 'Ctrl+V',
  duplicate: 'Ctrl+D',
  undo: 'Ctrl+Z',
  redo: 'Ctrl+Shift+Z',
  save: 'Ctrl+S',
  import: 'Ctrl+I',
  zoomIn: 'Ctrl+=',
  zoomOut: 'Ctrl+-',
  zoomFit: 'Ctrl+0',
  nextFrame: 'ArrowRight',
  prevFrame: 'ArrowLeft',
  goStart: 'Home',
  goEnd: 'End',
});

/** A named action: its displayed combo and the normalized match key. */
interface ActionBinding {
  display: string;
  key: string;
}

/** Normalizes a combo to `ctrl+shift+key` order-insensitive form. */
function normalize(combo: ShortcutCombo): string {
  const parts = combo
    .split('+')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part !== '');
  const modifiers = new Set<string>(
    parts.filter((part) => part === 'ctrl' || part === 'shift' || part === 'alt' || part === 'meta'),
  );
  const key = parts.find((part) => !modifiers.has(part)) ?? '';
  return [...['ctrl', 'shift', 'alt', 'meta'].filter((m) => modifiers.has(m)), key].join('+');
}

/** The key of an event, in the same space as {@link normalize}. */
function eventCombo(event: KeyboardEvent): string {
  const modifiers: string[] = [];
  if (event.ctrlKey || event.metaKey) modifiers.push('ctrl');
  if (event.shiftKey) modifiers.push('shift');
  if (event.altKey) modifiers.push('alt');
  const key = event.key.toLowerCase();
  return [...modifiers, key === ' ' ? 'space' : key].join('+');
}

/** Global keyboard dispatch. */
export class KeyboardShortcuts {
  private readonly actions = new Map<string, ActionBinding>();
  private readonly actionHandlers = new Map<string, ShortcutHandler[]>();
  private readonly comboHandlers = new Map<string, ShortcutHandler[]>();
  private readonly listener: (event: KeyboardEvent) => void;
  private enabled = false;

  constructor() {
    this.listener = (event: KeyboardEvent) => this.dispatch(event);
    for (const [action, combo] of Object.entries(DEFAULT_SHORTCUTS)) {
      this.actions.set(action, { display: combo, key: normalize(combo) });
    }
  }

  /** Starts/stops listening on the window. */
  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (enabled) window.addEventListener('keydown', this.listener);
    else window.removeEventListener('keydown', this.listener);
  }

  /**
   * Binds `handler` to a raw combo.
   * @param combo `Ctrl+S`-style.
   * @param handler runs on match.
   */
  bind(combo: ShortcutCombo, handler: ShortcutHandler): void {
    const key = normalize(combo);
    const list = this.comboHandlers.get(key) ?? [];
    list.push(handler);
    this.comboHandlers.set(key, list);
  }

  /**
   * Binds a named action from {@link DEFAULT_SHORTCUTS}.
   * @param action the action name.
   * @param handler runs on match; follows rebinds.
   */
  bindAction(action: string, handler: ShortcutHandler): void {
    const list = this.actionHandlers.get(action) ?? [];
    list.push(handler);
    this.actionHandlers.set(action, list);
  }

  /**
   * Rebinds an action to a new combo (the settings modal).
   * @param action the action name.
   * @param combo the new combo.
   */
  rebind(action: string, combo: ShortcutCombo): void {
    this.actions.set(action, { display: combo, key: normalize(combo) });
  }

  /** Unbinds everything (teardown). */
  clear(): void {
    this.actions.clear();
    this.actionHandlers.clear();
    this.comboHandlers.clear();
    this.setEnabled(false);
  }

  /**
   * The displayed combo of an action.
   * @param action the action name.
   * @returns the combo text, or `''` when unknown.
   */
  comboOf(action: string): string {
    return this.actions.get(action)?.display ?? '';
  }

  /** Every action and its combo, for the shortcuts list. */
  list(): { action: string; combo: string }[] {
    return [...this.actions.entries()].map(([action, binding]) => ({
      action,
      combo: binding.display,
    }));
  }

  private dispatch(event: KeyboardEvent): void {
    if (!this.enabled) return;
    const target = event.target;
    const typing =
      target instanceof HTMLElement &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable);
    if (typing && event.key !== 'Escape') return;

    const key = eventCombo(event);
    let handled = false;
    for (const [action, binding] of this.actions) {
      if (binding.key !== key) continue;
      const handlers = this.actionHandlers.get(action);
      if (handlers && handlers.length > 0) {
        handled = true;
        for (const handler of handlers) handler(event);
      }
    }
    const comboHandlers = this.comboHandlers.get(key);
    if (comboHandlers && comboHandlers.length > 0) {
      handled = true;
      for (const handler of comboHandlers) handler(event);
    }
    if (handled) event.preventDefault();
  }
}
