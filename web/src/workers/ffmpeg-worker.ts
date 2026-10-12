// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Entry point of the FFmpeg worker: serves `load` and `exec` over the
 * vendored FFmpeg.wasm core (see `media/ffmpeg/ffmpeg-worker.ts`). The main
 * thread terminates this worker after 2 minutes idle, unloading the wasm.
 */

import { createFFmpegHandlers, importCore } from '../media/ffmpeg/ffmpeg-worker.ts';
import { serveWorker } from './worker-client.ts';

serveWorker(self, createFFmpegHandlers(importCore));
