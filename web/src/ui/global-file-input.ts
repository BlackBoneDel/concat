// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * One permanent `<input type="file">` in `document.body` — the single entry
 * point for every "import" affordance (the Import button, Archivo → Importar
 * medios, Ctrl+I and the subtitle pickers).
 *
 * Why a permanent node instead of a fresh `document.createElement('input')`
 * per click (what the panel used to do):
 *
 * - A detached input is only kept alive by the closure of `openPicker()`. Once
 *   the user is staring at the OS file dialog nothing references it, so a GC
 *   between the click and the selection can collect the element and the
 *   `change` event never fires — the reported "el botón Import no hace nada".
 * - Safari/iOS refuse to open the picker for an input that is not in the
 *   document, so the same gesture silently did nothing there.
 * - Re-using one node means `input.value` has to be cleared after every
 *   `change`, otherwise picking *the same file twice* fires no event at all
 *   (the value did not change). {@link installGlobalFileInput} does that.
 */

/** The id of the persistent input, as documented in the import protocol. */
export const GLOBAL_FILE_INPUT_ID = 'concat-global-file-input';

/**
 * What the picker accepts: media first, then the explicit extensions, because
 * some systems report an empty `type` for `.mov`/`.mkv` and the `accept`
 * filter would then hide the file the user is looking at. Subtitle and LUT
 * extensions ride along so "Importar" is a single door.
 */
export const GLOBAL_FILE_ACCEPT = [
  'video/*',
  'audio/*',
  'image/*',
  '.mp4',
  '.webm',
  '.mov',
  '.m4v',
  '.mkv',
  '.avi',
  '.mp3',
  '.wav',
  '.ogg',
  '.oga',
  '.m4a',
  '.aac',
  '.flac',
  '.opus',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.srt',
  '.vtt',
  '.cube',
].join(',');

/** Options of {@link installGlobalFileInput}. */
export interface GlobalFileInputOptions {
  /** Called with the chosen files, once per `change` that carries any. */
  onFiles(files: File[]): void;
  /** The document to mount into (injectable for tests). */
  doc?: Document;
  /** Kept for API symmetry with the other installers; unused today. */
  accept?: string;
}

/** A disposable installer. */
export interface GlobalFileInputHandle {
  /** The persistent input. */
  readonly input: HTMLInputElement;
  /** Clicks the input (the Import button, the menu and Ctrl+I call this). */
  open(): void;
  /** Removes the input and its listener. */
  dispose(): void;
}

/** The installed input, if any (tests and the header menu read it). */
let installed: GlobalFileInputHandle | null = null;

/** The `document.body` of wherever we are running. */
function bodyOf(doc: Document | null): HTMLElement | null {
  return doc?.body ?? (typeof document !== 'undefined' ? document.body : null);
}

/**
 * Mounts the persistent input (idempotent: a second call reuses the node and
 * swaps the `change` handler).
 * @param options where to route the files.
 * @returns a handle with `open()`.
 */
export function installGlobalFileInput(options: GlobalFileInputOptions): GlobalFileInputHandle {
  const doc = options.doc ?? (typeof document !== 'undefined' ? document : null);
  const body = bodyOf(doc);
  if (!doc || !body) {
    // No DOM (a bare unit test): a detached input is the best we can do, and
    // the caller still gets a working `open()`.
    const input = doc ? doc.createElement('input') : (null as unknown as HTMLInputElement);
    return { input, open: () => undefined, dispose: () => undefined };
  }

  installed?.dispose();

  const input = doc.createElement('input');
  input.id = GLOBAL_FILE_INPUT_ID;
  input.type = 'file';
  input.multiple = true;
  input.accept = options.accept ?? GLOBAL_FILE_ACCEPT;
  input.className = 'concat-file-input';
  input.setAttribute('aria-hidden', 'true');
  // Off-screen but in the layout: `display: none` stops some engines from
  // opening the picker for a programmatic click.
  input.style.position = 'fixed';
  input.style.left = '-9999px';
  input.style.top = '-9999px';
  input.style.opacity = '0';
  input.style.pointerEvents = 'none';

  const onChange = (): void => {
    const files = [...(input.files ?? [])];
    // Clear first: the picker must fire again for the same file.
    input.value = '';
    if (files.length === 0) return;
    console.info(`[FileInput] ${files.length} files`);
    options.onFiles(files);
  };
  input.addEventListener('change', onChange);
  body.appendChild(input);

  const handle: GlobalFileInputHandle = {
    input,
    open: () => {
      input.click();
    },
    dispose: () => {
      input.removeEventListener('change', onChange);
      input.remove();
      if (installed === handle) installed = null;
    },
  };
  installed = handle;
  return handle;
}

/**
 * The installed input, or `null` when nothing installed one (a bare unit test,
 * or a panel constructed before `main.ts` boots).
 * @returns the handle.
 */
export function globalFileInput(): GlobalFileInputHandle | null {
  return installed;
}

/**
 * Opens the system picker through the persistent input.
 * @returns `false` when no input is installed, so callers can fall back to a
 * locally created one (jsdom tests, embedded panels).
 */
export function openGlobalFileInput(): boolean {
  if (!installed) return false;
  installed.open();
  return true;
}
