// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Fase 4 services for the UI (proxies, LUTs, eyedropper, relink, subtitles),
 * installed once by `main.ts`. Kept apart from `AppContext` so Fase 2/3
 * panels and tests compile unchanged; panels read it with
 * {@link getMediaTools} and degrade gracefully when it is absent.
 */

import type { ProxyStatus } from '../media/proxy/proxy-generator.ts';
import type { Lut3D } from '../media/vision/lut-loader.ts';
import type { LutLibrary } from '../media/vision/lut-library.ts';
import type { Rgb255 } from '../media/vision/color-space.ts';
import type { DeepMetadata } from '../media/import/metadata-extractor.ts';

/** Proxy state of one asset, for badges and menus. */
export interface ProxyState {
  status: ProxyStatus;
  /** 0–1 while generating. */
  progress: number;
  error: string | null;
}

/** What the F4 panels and dialogs call. */
export interface MediaTools {
  readonly luts: LutLibrary;
  /** Toast + console (errors never crash the UI). */
  notify(kind: 'info' | 'success' | 'warning' | 'error', title: string, message?: string): void;
  /** Picks a colour from the preview (EyeDropper API or click). */
  pickColor(): Promise<Rgb255 | null>;
  /** Opens the LUT browser; resolves with the chosen LUT (or null). */
  browseLuts(currentId: string | null): Promise<Lut3D | null>;
  /** Whether previews use proxies. */
  readonly proxiesEnabled: boolean;
  /** Toggles proxy playback (header button / Ctrl+Shift+P). */
  toggleProxies(): void;
  /** Proxy state of an asset. */
  proxyState(mediaId: string): ProxyState;
  /** Generates (or regenerates) a proxy. */
  generateProxy(mediaId: string, quality: 'default' | 'low'): void;
  /** Deletes an asset's proxy. */
  deleteProxy(mediaId: string): void;
  /** Opens the proxy manager dialog. */
  openProxyManager(): void;
  /** Deep metadata of an asset. */
  metadata(mediaId: string): Promise<DeepMetadata | null>;
  /** Opens the relink dialog (optionally focused on one asset). */
  openRelink(mediaId?: string): void;
  /** Bulk import from a folder. */
  importFolder(): void;
  /** Imports a subtitle file onto new lanes. */
  importSubtitles(file: File): Promise<void>;
  /** Exports subtitle clips. */
  exportSubtitles(format: 'srt' | 'vtt'): void;
  /** Loads a `.cube` file into the library. */
  importLut(file: File): Promise<Lut3D | null>;
  /** Frees OPFS space by deleting every proxy. */
  clearProxies(): Promise<void>;
  /** Asset ids whose bytes are missing from OPFS. */
  readonly offlineIds: ReadonlySet<string>;
}

let installed: MediaTools | null = null;

/**
 * Installs the services (main.ts) or clears them (tests).
 * @param tools the services, or null.
 */
export function setMediaTools(tools: MediaTools | null): void {
  installed = tools;
}

/** The installed services, if any. */
export function getMediaTools(): MediaTools | null {
  return installed;
}
