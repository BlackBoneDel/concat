// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Accessible dialog base for the Fase 4 modals: `role="dialog"`,
 * `aria-modal`, labelled/described, a Tab focus trap, Escape to close,
 * focus restored to the opener, and cleanup hooks (ObjectURLs, listeners,
 * workers) that always run on close.
 */

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

let counter = 0;

/** Options of {@link Dialog}. */
export interface DialogOptions {
  title: string;
  /** Short description read by screen readers. */
  description?: string;
  className?: string;
  /** Whether Escape / backdrop close the dialog (default true). */
  dismissible?: boolean;
}

/** One accessible dialog on screen. */
export class Dialog {
  readonly element: HTMLElement;
  readonly body: HTMLElement;
  readonly footer: HTMLElement;
  private readonly backdrop: HTMLElement;
  private readonly opener: Element | null;
  private readonly cleanups: (() => void)[] = [];
  private resolveClosed: () => void = () => undefined;
  /** Resolves once the dialog is closed. */
  readonly closed: Promise<void>;
  private isClosed = false;
  dismissible: boolean;

  /**
   * @param options title, description, class.
   */
  constructor(options: DialogOptions) {
    counter += 1;
    const id = `f4-dialog-${counter}`;
    this.opener = document.activeElement;
    this.dismissible = options.dismissible ?? true;
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });

    this.backdrop = document.createElement('div');
    this.backdrop.className = 'modal-backdrop';
    this.element = document.createElement('div');
    this.element.className = `modal f4-modal ${options.className ?? ''}`.trim();
    this.element.setAttribute('role', 'dialog');
    this.element.setAttribute('aria-modal', 'true');
    this.element.setAttribute('aria-labelledby', `${id}-title`);
    this.element.tabIndex = -1;

    const header = document.createElement('div');
    header.className = 'modal-header';
    const heading = document.createElement('h2');
    heading.className = 'modal-title';
    heading.id = `${id}-title`;
    heading.textContent = options.title;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'modal-close';
    close.setAttribute('aria-label', 'Cerrar');
    close.textContent = '×';
    close.addEventListener('click', () => this.close());
    header.append(heading, close);
    this.element.appendChild(header);

    if (options.description) {
      const description = document.createElement('p');
      description.className = 'modal-message';
      description.id = `${id}-desc`;
      description.textContent = options.description;
      this.element.setAttribute('aria-describedby', description.id);
      this.element.appendChild(description);
    }
    this.body = document.createElement('div');
    this.body.className = 'modal-body';
    this.footer = document.createElement('div');
    this.footer.className = 'modal-footer';
    this.element.append(this.body, this.footer);
    this.backdrop.appendChild(this.element);

    const root = document.getElementById('modal-root') ?? document.body;
    root.appendChild(this.backdrop);

    const onKey = (event: KeyboardEvent): void => this.onKey(event);
    this.element.addEventListener('keydown', onKey);
    this.cleanups.push(() => this.element.removeEventListener('keydown', onKey));
    this.backdrop.addEventListener('mousedown', (event) => {
      if (event.target === this.backdrop && this.dismissible) this.close();
    });
    queueMicrotask(() => {
      if (!this.isClosed) (this.focusables()[1] ?? this.focusables()[0] ?? this.element).focus();
    });
  }

  /**
   * Adds a footer button.
   * @param label text.
   * @param onClick handler.
   * @param variant style.
   * @returns the button.
   */
  addButton(label: string, onClick: () => void, variant: 'primary' | 'ghost' | 'danger' = 'ghost'): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `btn btn-${variant}`;
    button.textContent = label;
    button.addEventListener('click', onClick);
    this.footer.appendChild(button);
    return button;
  }

  /**
   * Registers cleanup run on close (revoke URLs, stop work).
   * @param fn the cleanup.
   */
  onClose(fn: () => void): void {
    if (this.isClosed) fn();
    else this.cleanups.push(fn);
  }

  /** Whether the dialog is closed. */
  get isOpen(): boolean {
    return !this.isClosed;
  }

  /** Closes the dialog and runs cleanups. */
  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    for (const fn of this.cleanups.splice(0)) {
      try {
        fn();
      } catch (error) {
        console.error(error);
      }
    }
    this.backdrop.remove();
    if (this.opener instanceof HTMLElement) this.opener.focus();
    this.resolveClosed();
  }

  /** Focusable descendants in DOM order. */
  focusables(): HTMLElement[] {
    return [...this.element.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.hidden && el.closest('[hidden]') === null);
  }

  private onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.dismissible) {
      event.preventDefault();
      event.stopPropagation();
      this.close();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = this.focusables();
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !this.element.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !this.element.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  }
}

/**
 * A determinate progress bar with ARIA.
 * @param label accessible name.
 * @returns the bar and a setter (0–1).
 */
export function progressBar(label: string): { element: HTMLElement; set(value: number, text?: string): void } {
  const wrap = document.createElement('div');
  wrap.className = 'f4-progress';
  wrap.setAttribute('role', 'progressbar');
  wrap.setAttribute('aria-label', label);
  wrap.setAttribute('aria-valuemin', '0');
  wrap.setAttribute('aria-valuemax', '100');
  const fill = document.createElement('div');
  fill.className = 'f4-progress-fill';
  wrap.appendChild(fill);
  const set = (value: number, text?: string): void => {
    const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
    fill.style.width = `${pct}%`;
    wrap.setAttribute('aria-valuenow', String(pct));
    wrap.setAttribute('aria-valuetext', text ?? `${pct}%`);
  };
  set(0);
  return { element: wrap, set };
}

/**
 * Formats bytes for humans.
 * @param bytes byte count.
 * @returns e.g. `1.2 GB`.
 */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
