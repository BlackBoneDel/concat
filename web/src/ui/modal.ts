// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * A modal dialog with optional confirm/cancel buttons. Used standalone and
 * by {@link Notifications.confirm}; closes on Escape, backdrop click and the
 * close button, and restores focus on dismissal.
 */

/** The buttons a modal can carry. */
export interface ModalButtons {
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel?: () => void;
  danger?: boolean;
}

/** One modal on screen. */
export class Modal {
  private readonly backdrop: HTMLDivElement;
  private readonly dialog: HTMLDivElement;
  private readonly cleanup: (() => void)[] = [];
  private closed = false;

  /**
   * @param title the heading.
   * @param content the body element.
   * @param buttons optional confirm/cancel pair.
   */
  constructor(title: string, content: HTMLElement, buttons?: ModalButtons) {
    const root = Modal.ensureRoot();
    this.backdrop = document.createElement('div');
    this.backdrop.className = 'modal-backdrop';

    this.dialog = document.createElement('div');
    this.dialog.className = 'modal';
    this.dialog.setAttribute('role', 'dialog');
    this.dialog.setAttribute('aria-modal', 'true');

    const header = document.createElement('div');
    header.className = 'modal-header';
    const heading = document.createElement('h2');
    heading.className = 'modal-title';
    heading.textContent = title;
    header.appendChild(heading);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'modal-close';
    close.setAttribute('aria-label', 'Cerrar');
    close.textContent = '×';
    close.addEventListener('click', () => {
      buttons?.onCancel?.();
      this.close();
    });
    header.appendChild(close);
    this.dialog.appendChild(header);

    const body = document.createElement('div');
    body.className = 'modal-body';
    body.appendChild(content);
    this.dialog.appendChild(body);

    if (buttons) {
      const footer = document.createElement('div');
      footer.className = 'modal-footer';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'btn btn-ghost';
      cancel.textContent = buttons.cancelLabel;
      cancel.addEventListener('click', () => {
        buttons.onCancel?.();
        this.close();
      });
      const confirm = document.createElement('button');
      confirm.type = 'button';
      confirm.className = `btn ${buttons.danger ? 'btn-danger' : 'btn-primary'}`;
      confirm.textContent = buttons.confirmLabel;
      confirm.addEventListener('click', () => {
        buttons.onConfirm();
        this.close();
      });
      footer.appendChild(cancel);
      footer.appendChild(confirm);
      this.dialog.appendChild(footer);
    }

    this.backdrop.appendChild(this.dialog);
    root.appendChild(this.backdrop);

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        buttons?.onCancel?.();
        this.close();
      }
    };
    this.backdrop.addEventListener('click', (event) => {
      if (event.target === this.backdrop) {
        buttons?.onCancel?.();
        this.close();
      }
    });
    this.dialog.addEventListener('keydown', onKey);
    this.cleanup.push(() => this.dialog.removeEventListener('keydown', onKey));
    (this.dialog.querySelector('.modal-close') as HTMLElement | null)?.focus();
  }

  /**
   * A yes/no dialog.
   * @param title the question.
   * @param message the consequence.
   * @param confirmLabel the confirming button.
   * @returns `true` when confirmed.
   */
  static confirm(title: string, message: string, confirmLabel: string): Promise<boolean> {
    return new Promise((resolve) => {
      const body = document.createElement('p');
      body.className = 'modal-message';
      body.textContent = message;
      let settled = false;
      const settle = (value: boolean): void => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      new Modal(title, body, {
        confirmLabel,
        cancelLabel: 'Cancelar',
        danger: true,
        onConfirm: () => settle(true),
        onCancel: () => settle(false),
      });
    });
  }

  /** Removes the dialog. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const fn of this.cleanup) fn();
    this.backdrop.remove();
  }

  /** The dialog element (for tests). */
  get element(): HTMLElement {
    return this.dialog;
  }

  private static ensureRoot(): HTMLElement {
    let root = document.getElementById('modal-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'modal-root';
      document.body.appendChild(root);
    }
    return root;
  }
}
