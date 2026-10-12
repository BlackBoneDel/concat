// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Scanner worker: folder walks (File System Access handles) and SHA-256. */

import { createScannerHandlers } from '../media/relink/scanner-handlers.ts';
import { serveWorker } from './worker-client.ts';

serveWorker(self, createScannerHandlers());
