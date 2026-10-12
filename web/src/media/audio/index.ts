// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Audio DSP: buffers, effects, loudness, speed/pitch, realtime chains. */
export * from './audio-buffer.ts';
export * from './audio-effects.ts';
export { AudioProcessor, isFxContext, type AudioProcessorOptions, type FxContextLike, type RealtimeChain, type VariantSpec } from './audio-processor.ts';
export * from './biquad.ts';
export * from './channel-splitter.ts';
export * from './compressor.ts';
export * from './dynamics.ts';
export * from './equalizer.ts';
export * from './fader-curves.ts';
export * from './fft.ts';
export * from './limiter.ts';
export * from './noise-gate.ts';
export * from './normalizer.ts';
export * from './pitch-shift.ts';
export { createPitchHandlers, readChannels, type ChannelsPayload } from './pitch-worker.ts';
