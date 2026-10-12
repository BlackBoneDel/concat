// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Reverb impulse-response synthesis off the main thread (Fase 5). */

import { createReverbHandlers } from '../media/effects/reverb-ir-generator.ts';
import { serveWorker } from './worker-client.ts';

serveWorker(self, createReverbHandlers());
