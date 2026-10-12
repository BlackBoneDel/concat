// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Audio DSP worker: time stretch, pitch shift, EBU R128, offline effects. */

import { createPitchHandlers } from '../media/audio/pitch-worker.ts';
import { serveWorker } from './worker-client.ts';

serveWorker(self, createPitchHandlers());
