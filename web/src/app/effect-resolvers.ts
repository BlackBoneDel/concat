// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Bridges `clip.extra.effects` to the Fase 4 render/mix hooks:
 * - {@link createVisionResolver}: per-frame effects for the vision pipeline;
 * - {@link createAudioFxResolver}: per-clip audio resolution for the mixer
 *   (pre-rendered pitch/stretch variants, realtime chain, fade curves,
 *   EBU R128 normalisation gain measured once per buffer in the worker).
 *
 * Effects live in `clip.extra.effects` until Fase 5 migrates them to a
 * first-class model; parsing is cached by the raw JSON object identity so
 * the per-frame cost is one lookup.
 */

import { EFFECTS_KEY, parseClipEffects, type ClipEffects } from '../media/clip-effects.ts';
import type { AudioBufferLike } from '../media/audio/audio-buffer.ts';
import type { AudioEffects } from '../media/audio/audio-effects.ts';
import type { AudioProcessor } from '../media/audio/audio-processor.ts';
import { curveTable } from '../media/audio/fader-curves.ts';
import { normalizationGain, type LoudnessResult } from '../media/audio/normalizer.ts';
import type { DocumentClip, ProjectDocument } from '../model/document.ts';
import type { AudioFxResolution, AudioFxResolver } from '../player/audio-mixer.ts';

/** Finds a document clip by id across timelines. */
export function findDocClip(doc: ProjectDocument, clipId: string): DocumentClip | null {
  for (const timeline of doc.timelines) {
    for (const clip of timeline.clips) if (clip.id === clipId) return clip;
  }
  return null;
}

/** Parses effects with an identity cache over the raw JSON. */
export class EffectsCache {
  private readonly cache = new WeakMap<object, ClipEffects>();

  /**
   * @param clip a document clip.
   * @returns its effects, or null when it has none.
   */
  of(clip: DocumentClip): ClipEffects | null {
    const raw = clip.extra[EFFECTS_KEY];
    if (raw === undefined || raw === null || typeof raw !== 'object') return null;
    let parsed = this.cache.get(raw);
    if (!parsed) {
      parsed = parseClipEffects(raw);
      this.cache.set(raw, parsed);
    }
    return parsed;
  }
}

/**
 * The vision pipeline's resolver.
 * @param getDocument current document.
 * @param cache shared parse cache.
 * @returns `(clip) => effects | null` keyed by the clip's document id.
 */
export function createVisionResolver(getDocument: () => ProjectDocument, cache = new EffectsCache()): (clip: object) => ClipEffects | null {
  return (clip) => {
    // Engine clips built from the document (EditorClip) carry `docId`.
    const docId: unknown = 'docId' in clip ? clip.docId : undefined;
    if (typeof docId !== 'string') return null;
    const doc = findDocClip(getDocument(), docId);
    return doc ? cache.of(doc) : null;
  };
}

/** Whether a mixer buffer carries samples (AudioBuffer-like). */
function isAudioBuffer(value: unknown): value is AudioBufferLike {
  return typeof value === 'object' && value !== null && 'getChannelData' in value && 'sampleRate' in value && 'numberOfChannels' in value;
}

/** Options of {@link createAudioFxResolver}. */
export interface AudioFxResolverOptions {
  processor: AudioProcessor;
  getDocument: () => ProjectDocument;
  cache?: EffectsCache;
  /** A measurement finished (re-schedule playback to pick it up). */
  onMeasured?: () => void;
  onError?: (error: unknown) => void;
}

/**
 * The mixer's per-clip resolver.
 * @param options processor, document and callbacks.
 * @returns the resolver to install with `setDefaultAudioFxResolver`.
 */
export function createAudioFxResolver(options: AudioFxResolverOptions): AudioFxResolver {
  const cache = options.cache ?? new EffectsCache();
  const loudness = new WeakMap<object, LoudnessResult>();
  const measuring = new WeakSet<object>();

  const measured = (buffer: AudioBufferLike): LoudnessResult | null => {
    const known = loudness.get(buffer);
    if (known) return known;
    if (!measuring.has(buffer)) {
      measuring.add(buffer);
      options.processor.measureLoudness(buffer).then((result) => {
        loudness.set(buffer, result);
        options.onMeasured?.();
      }, (error: unknown) => options.onError?.(error));
    }
    return null;
  };

  return (key, spec, context): AudioFxResolution | null => {
    const clip = findDocClip(options.getDocument(), key);
    const audio = clip ? cache.of(clip)?.audio ?? null : null;
    if (!audio) return null;
    const out: AudioFxResolution = {};
    const source = spec.buffer;
    let live: AudioEffects = audio;

    if (isAudioBuffer(source)) {
      // Pitch-preserving speed and transposition are pre-rendered (PSOLA /
      // phase vocoder in the worker); the variant plays at rate 1.
      const stretch = audio.preservePitch && Math.abs(spec.rate - 1) > 1e-6;
      if (stretch || audio.semitones !== 0) {
        const variant = options.processor.variantFor(source, {
          rate: stretch ? spec.rate : 1,
          preservePitch: true,
          semitones: audio.semitones,
        });
        if (variant) {
          out.buffer = variant;
          if (stretch) {
            out.rateScale = 1 / spec.rate;
            out.offsetScale = 1 / spec.rate;
          }
        }
      }
      if (audio.normalize && audio.normalize.gainDb === null) {
        const result = measured(source);
        if (result) live = { ...audio, normalize: { ...audio.normalize, gainDb: normalizationGain(result, audio.normalize) } };
      }
    }

    out.chain = options.processor.buildRealtimeChain(context, live);
    if (spec.fadeIn > 0 && audio.fadeInCurve !== 'linear') out.fadeInCurve = curveTable(audio.fadeInCurve, spec.volume, 'in');
    if (spec.fadeOut > 0 && audio.fadeOutCurve !== 'linear') out.fadeOutCurve = curveTable(audio.fadeOutCurve, spec.volume, 'out');
    return out;
  };
}
