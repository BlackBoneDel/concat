// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Toast notifications and confirmation dialogs. Toasts stack top-right,
 * auto-dismiss on a level timer, and stay polite (the settings modal has a
 * switch for them). The confirmation dialog is the shared destructive-action
 * guard — used for every "this cannot be undone".
 */

import { Modal } from './modal.ts';

/** Notification severity. */
export type NotificationType = 'info' | 'success' | 'warning' | 'error';

/** One toast's worth of content. */
export interface NotificationOptions {
  type?: NotificationType;
  title: string;
  message?: string;
  duration?: number;
}

const AUTO_DISMISS_MS = 4000;

/** The toast stack. */
export class Notifications {
  private readonly container: HTMLElement;
  private enabled = true;

  /**
   * @param container the stack element (`#toast-stack`).
   */
  constructor(container: HTMLElement) {
    this.container = container;
  }

  /** The settings modal's "Show tooltips" switch silences auto messages. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * Shows a toast. `error` toasts stay until dismissed.
   * @param options the content.
   * @returns the toast element, for tests and manual dismissal.
   */
  show(options: NotificationOptions): HTMLElement {
    const type = options.type ?? 'info';
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.setAttribute('role', 'status');

    const body = document.createElement('div');
    body.className = 'toast-body';
    const title = document.createElement('strong');
    title.className = 'toast-title';
    title.textContent = options.title;
    body.appendChild(title);
    if (options.message) {
      const message = document.createElement('div');
      message.className = 'toast-message';
      message.textContent = options.message;
      body.appendChild(message);
    }
    toast.appendChild(body);

    const close = document.createElement('button');
    close.className = 'toast-close';
    close.type = 'button';
    close.setAttribute('aria-label', 'Cerrar notificación');
    close.textContent = '×';
    close.addEventListener('click', () => toast.remove());
    toast.appendChild(close);

    this.container.appendChild(toast);
    const duration = options.duration ?? (type === 'error' ? 0 : AUTO_DISMISS_MS);
    if (duration > 0 && this.enabled) {
      globalThis.setTimeout(() => toast.remove(), duration);
    }
    return toast;
  }

  /** Convenience: `info`. */
  info(title: string, message?: string): void {
    this.show({ type: 'info', title, message });
  }

  /** Convenience: `success`. */
  success(title: string, message?: string): void {
    this.show({ type: 'success', title, message });
  }

  /** Convenience: `warning`. */
  warning(title: string, message?: string): void {
    this.show({ type: 'warning', title, message });
  }

  /** Convenience: `error` (sticky). */
  error(title: string, message?: string): void {
    this.show({ type: 'error', title, message, duration: 0 });
  }

  /**
   * Asks for confirmation before a destructive action.
   * @param title the question.
   * @param message the consequence.
   * @param confirmLabel the confirming button ("Eliminar").
   * @returns `true` when confirmed.
   */
  confirm(title: string, message: string, confirmLabel = 'Eliminar'): Promise<boolean> {
    return Modal.confirm(title, message, confirmLabel);
  }
}
