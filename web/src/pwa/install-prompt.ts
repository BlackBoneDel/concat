// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Fase 6: the "install app" flow. Captures `beforeinstallprompt` (Chromium)
 * so the UI can offer installation from its own menu, and reports
 * `appinstalled`. Browsers without the event (Firefox, Safari) simply never
 * offer it — Safari installs through "Add to Dock / Home Screen".
 */

/** The deferred prompt event (not in the DOM typings). */
export interface DeferredPrompt {
  preventDefault(): void;
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/** An event target to listen on (the window, or a test double). */
export interface PromptTarget {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

function isDeferredPrompt(event: Event): event is Event & DeferredPrompt {
  return 'prompt' in event && typeof Reflect.get(event, 'prompt') === 'function' && 'userChoice' in event;
}

/** Tracks installability. */
export class InstallPrompt {
  private deferred: DeferredPrompt | null = null;
  private installedFlag = false;
  private readonly listeners = new Set<() => void>();
  private readonly target: PromptTarget | null;
  private readonly onBefore = (event: Event): void => {
    if (!isDeferredPrompt(event)) return;
    event.preventDefault();
    this.deferred = event;
    this.emit();
  };
  private readonly onInstalled = (): void => {
    this.deferred = null;
    this.installedFlag = true;
    this.emit();
  };

  /**
   * @param target where the events arrive (defaults to `window`).
   */
  constructor(target: PromptTarget | null = typeof window === 'undefined' ? null : window) {
    this.target = target;
    target?.addEventListener('beforeinstallprompt', this.onBefore);
    target?.addEventListener('appinstalled', this.onInstalled);
  }

  /** Whether the browser offered installation. */
  get canInstall(): boolean {
    return this.deferred !== null;
  }

  /** Whether the app was installed during this session. */
  get installed(): boolean {
    return this.installedFlag;
  }

  /**
   * Shows the browser prompt.
   * @returns the user's choice, or `'unavailable'`.
   */
  async prompt(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
    const deferred = this.deferred;
    if (!deferred) return 'unavailable';
    // A deferred prompt can be used once.
    this.deferred = null;
    this.emit();
    await deferred.prompt();
    const { outcome } = await deferred.userChoice;
    return outcome;
  }

  /**
   * Subscribes to availability changes.
   * @param listener called on change.
   * @returns unsubscribe.
   */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Stops listening. */
  dispose(): void {
    this.target?.removeEventListener('beforeinstallprompt', this.onBefore);
    this.target?.removeEventListener('appinstalled', this.onInstalled);
    this.listeners.clear();
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
