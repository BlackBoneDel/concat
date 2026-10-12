// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Fase 6: toasts with an action button ("Recargar", "Abrir", …) on top of
 * the Fase 1 {@link Notifications} stack, which this only decorates.
 */

import type { Notifications, NotificationOptions } from './notifications.ts';

/** Options of {@link actionToast}. */
export interface ActionToastOptions extends NotificationOptions {
  actionLabel: string;
  onAction(): void;
}

/**
 * Shows a toast with one action; clicking it runs the action and dismisses.
 * @param notifications the stack.
 * @param options content, action and duration (0 = sticky).
 * @returns the toast element.
 */
export function actionToast(notifications: Notifications, options: ActionToastOptions): HTMLElement {
  const toast = notifications.show({ type: options.type, title: options.title, message: options.message, duration: options.duration ?? 0 });
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-small btn-primary toast-action';
  button.textContent = options.actionLabel;
  button.addEventListener('click', () => {
    toast.remove();
    options.onAction();
  });
  (toast.querySelector('.toast-body') ?? toast).appendChild(button);
  return toast;
}
