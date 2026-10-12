// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The one file picker of the app (import bulletproofing).
 *
 * An `<input type="file">` created on the fly and clicked without ever being
 * attached to the DOM does not reliably fire `change`: mobile Safari,
 * Firefox on Android and some desktop WebViews ignore the click or swallow
 * the selection, which is why "pulso Importar y no pasa nada" was the
 * second most common report after drag & drop. {@link installGlobalFileInput}
 * builds the input once, attaches it to `document.body` (off-screen, but
 * still a real, focusable form control) and returns it; every import entry
 * point — the panel button, the header menu, Ctrl+I — calls
 * {@link openGlobalFilePicker} so they all open the same picker.
 *
 * The value is cleared as soon as the selection is read, so picking the same
 * file twice (after an error, say) fires `change` again.
 */

/** Id of the input, so tests and the devtools console can find it. */
export const GLOBAL_FILE_INPUT_ID = 'concat-global-file-input';

/** What the picker accepts: files, plus the exact extensions older browsers need. */
export const MEDIA_FILE_ACCEPT =
  'video/*,audio/*,image/*,.mp4,.m4v,.mov,.mkv,.webm,.avi,.flv,.ogv,.ogg,.mts,.m2ts,.ts,.mxf,.3gp,.wmv,' +
  '.wav,.mp3,.m4a,.aac,.flac,.opus,.oga,.aiff,.aif,.png,.jpg,.jpeg,.webp,.gif,.bmp,.avif';

/** The off-screen style that keeps the input in the DOM without being seen. */
const HIDDEN_STYLE = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';

/** Options of {@link installGlobalFileInput}. */
export interface GlobalFileInputOptions {
  /** Receives the picked files (never empty). */
  onFiles(files: File[]): void;
  /** Element to attach to (default `document.body`); `null` skips attaching. */
  root?: HTMLElement | null;
  /** Input id override (tests). */
  id?: string;
  /** `accept` override (tests). */
  accept?: string;
}

let installed: HTMLInputElement | null = null;

/**
 * Creates (once) and attaches the global picker.
 *
 * @param options what to do with the selection.
 * @returns the input element, already in the DOM.
 */
export function installGlobalFileInput(options: GlobalFileInputOptions): HTMLInputElement {
  const id = options.id ?? GLOBAL_FILE_INPUT_ID;
  const root = options.root === undefined ? (typeof document !== 'undefined' ? document.body : null) : options.root;
  const existing = typeof document === 'undefined' ? null : document.getElementById(id);
  const input: HTMLInputElement = existing instanceof HTMLInputElement ? existing : document.createElement('input');
  input.id = id;
  input.type = 'file';
  input.multiple = true;
  input.accept = options.accept ?? MEDIA_FILE_ACCEPT;
  input.hidden = true;
  input.tabIndex = -1;
  input.setAttribute('aria-hidden', 'true');
  input.setAttribute('style', HIDDEN_STYLE);
  // `change` fires on every selection as long as the handler is the live one:
  // drop the previous handlers by re-adding on the (single) input element.
  input.onchange = () => {
    const files = Array.from(input.files ?? []);
    // Clearing the value is what lets the user pick the same file again.
    input.value = '';
    if (files.length === 0) return;
    console.info('[FileInput] Archivos seleccionados:', files.length);
    options.onFiles(files);
  };
  if (existing !== input && root) root.appendChild(input);
  installed = input;
  return input;
}

/** The attached picker, or `null` when {@link installGlobalFileInput} has not run. */
export function globalFileInput(): HTMLInputElement | null {
  return installed;
}

/**
 * Opens the global picker — the single entry point every "importar medios"
 * button should call.
 * @returns `false` when the picker is not installed (the caller then falls
 * back to its own input), `true` when the click was dispatched.
 */
export function openGlobalFilePicker(): boolean {
  const input = installed ?? (typeof document !== 'undefined' ? document.getElementById(GLOBAL_FILE_INPUT_ID) : null);
  if (!(input instanceof HTMLInputElement)) return false;
  // Re-clicking a focused input whose selection is empty is a no-op in some
  // browsers, so blur first and dispatch the click explicitly.
  input.blur();
  input.click();
  return true;
}

/** Removes the picker (tests, teardown). */
export function disposeGlobalFileInput(): void {
  installed?.remove();
  installed = null;
}
