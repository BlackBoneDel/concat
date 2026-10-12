// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Fase 6: installable PWA (service worker + install prompt). */

export { registerServiceWorker, type ContainerLike, type RegisterOptions, type RegisterResult, type RegistrationLike, type WorkerLike } from './sw-register.ts';
export { InstallPrompt, type DeferredPrompt, type PromptTarget } from './install-prompt.ts';
