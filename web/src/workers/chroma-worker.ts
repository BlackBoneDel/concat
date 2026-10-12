// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** CPU vision worker: keying, spill, feather, grading and LUTs over RGBA. */

import { createVisionHandlers } from '../media/vision/vision-worker.ts';
import { serveWorker } from './worker-client.ts';

serveWorker(self, createVisionHandlers());
