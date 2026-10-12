// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Fase 6: local file downloads (export results, project packages). */

/** Delay before a download URL is revoked. */
export const DOWNLOAD_REVOKE_MS = 60_000;

/**
 * Starts a download of a blob; the URL is revoked {@link DOWNLOAD_REVOKE_MS} later.
 * @param blob the file.
 * @param fileName suggested name.
 * @param schedule timer (tests inject one).
 * @returns the temporary URL.
 */
export function downloadBlob(blob: Blob, fileName: string, schedule: (fn: () => void, ms: number) => void = (fn, ms) => void setTimeout(fn, ms)): string {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  schedule(() => URL.revokeObjectURL(url), DOWNLOAD_REVOKE_MS);
  return url;
}
