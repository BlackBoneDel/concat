// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Inspector: audio effects — 5-band EQ, compressor, limiter, noise gate,
 * EBU R128 normalisation, channel routing, pitch and fade curves.
 */

import { parseClipEffects } from '../../media/clip-effects.ts';
import { defaultAudioEffects, type AudioEffects } from '../../media/audio/audio-effects.ts';
import { CHANNEL_MODES, CHANNEL_MODE_LABELS, type ChannelMode } from '../../media/audio/channel-splitter.ts';
import { DEFAULT_COMPRESSOR } from '../../media/audio/compressor.ts';
import { DEFAULT_EQ_BANDS, EQ_LIMITS } from '../../media/audio/equalizer.ts';
import { FADE_CURVES, FADE_CURVE_LABELS, type FadeCurve } from '../../media/audio/fader-curves.ts';
import { DEFAULT_LIMITER } from '../../media/audio/limiter.ts';
import { DEFAULT_NOISE_GATE } from '../../media/audio/noise-gate.ts';
import type { DocumentClip } from '../../model/document.ts';
import { editEffects, type EffectSectionHost } from './effect-host.ts';
import { actions, button, check, group, number, select, slider, subheading } from './fields.ts';

const BAND_NAMES = ['Paso alto', 'Graves', 'Medios', 'Presencia', 'Brillo'];
const db = (v: number): string => `${v > 0 ? '+' : ''}${Math.round(v * 10) / 10} dB`;

/**
 * Builds the audio effects section.
 * @param host inspector host.
 * @param clip the clip (audio/video).
 * @returns the section element.
 */
export function audioFxSection(host: EffectSectionHost, clip: DocumentClip): HTMLElement {
  const audio = parseClipEffects(clip.extra['effects']).audio ?? defaultAudioEffects();
  const editAudio = (mutate: (a: AudioEffects) => void): void => editEffects(host, clip, (e) => {
    const next = e.audio ? { ...e.audio } : defaultAudioEffects();
    mutate(next);
    e.audio = next;
  });
  const bands = audio.eq ?? DEFAULT_EQ_BANDS.map((band) => ({ ...band }));
  const eqRows = bands.flatMap((band, index) => {
    const label = BAND_NAMES[index] ?? `Banda ${index + 1}`;
    const rows: HTMLElement[] = [
      number(`${label} (Hz)`, band.frequency, { min: EQ_LIMITS.minFrequency, max: EQ_LIMITS.maxFrequency, step: 1 }, (v) => editAudio((a) => {
        const list = (a.eq ?? bands).map((b) => ({ ...b }));
        list[index] = { ...list[index]!, frequency: v };
        a.eq = list;
      })),
    ];
    if (band.type !== 'highpass' && band.type !== 'lowpass') {
      rows.push(slider(`${label} ganancia`, band.gain, { min: EQ_LIMITS.minGain, max: EQ_LIMITS.maxGain, step: 0.5 }, (v) => editAudio((a) => {
        const list = (a.eq ?? bands).map((b) => ({ ...b }));
        list[index] = { ...list[index]!, gain: v };
        a.eq = list;
      }), db));
    }
    return rows;
  });
  const comp = audio.compressor ?? { ...DEFAULT_COMPRESSOR };
  const lim = audio.limiter ?? { ...DEFAULT_LIMITER };
  const gate = audio.gate ?? { ...DEFAULT_NOISE_GATE };

  return group('Efectos de audio', audio.eq !== null || audio.compressor !== null || audio.normalize !== null, [
    subheading('Ecualizador'),
    check('EQ activo', audio.eq !== null, (on) => editAudio((a) => { a.eq = on ? bands.map((b) => ({ ...b })) : null; })),
    ...eqRows,
    subheading('Dinámica'),
    check('Compresor', audio.compressor !== null, (on) => editAudio((a) => { a.compressor = on ? comp : null; })),
    slider('Umbral', comp.threshold, { min: -60, max: 0, step: 1 }, (v) => editAudio((a) => { a.compressor = { ...comp, threshold: v }; }), db),
    slider('Ratio', comp.ratio, { min: 1, max: 20, step: 0.5 }, (v) => editAudio((a) => { a.compressor = { ...comp, ratio: v }; }), (v) => `${v}:1`),
    slider('Ganancia de compensación', comp.makeupGain, { min: 0, max: 24, step: 0.5 }, (v) => editAudio((a) => { a.compressor = { ...comp, makeupGain: v }; }), db),
    check('Limitador', audio.limiter !== null, (on) => editAudio((a) => { a.limiter = on ? lim : null; })),
    slider('Techo', lim.ceiling, { min: -12, max: 0, step: 0.1 }, (v) => editAudio((a) => { a.limiter = { ...lim, ceiling: v }; }), db),
    check('Puerta de ruido', audio.gate !== null, (on) => editAudio((a) => { a.gate = on ? gate : null; })),
    slider('Umbral de puerta', gate.threshold, { min: -90, max: 0, step: 1 }, (v) => editAudio((a) => { a.gate = { ...gate, threshold: v }; }), db),
    subheading('Sonoridad'),
    check('Normalizar (EBU R128)', audio.normalize !== null, (on) => editAudio((a) => {
      a.normalize = on ? { mode: 'loudness', target: -23, truePeakCeiling: -1, gainDb: null } : null;
    })),
    slider('Objetivo', audio.normalize?.target ?? -23, { min: -40, max: -6, step: 0.5 }, (v) => editAudio((a) => {
      a.normalize = { mode: 'loudness', target: v, truePeakCeiling: a.normalize?.truePeakCeiling ?? -1, gainDb: null };
    }), (v) => `${v} LUFS`),
    subheading('Canales y tono'),
    select<ChannelMode>('Canales', audio.channelMode, CHANNEL_MODES.map((mode) => ({ value: mode, label: CHANNEL_MODE_LABELS[mode] })), (mode) => editAudio((a) => { a.channelMode = mode; })),
    slider('Tono (semitonos)', audio.semitones, { min: -12, max: 12, step: 1 }, (v) => editAudio((a) => { a.semitones = v; }), (v) => `${v > 0 ? '+' : ''}${v}`),
    check('Conservar tono al cambiar velocidad', audio.preservePitch, (on) => editAudio((a) => { a.preservePitch = on; })),
    subheading('Curvas de fundido'),
    select<FadeCurve>('Entrada', audio.fadeInCurve, FADE_CURVES.map((c) => ({ value: c, label: FADE_CURVE_LABELS[c] })), (c) => editAudio((a) => { a.fadeInCurve = c; })),
    select<FadeCurve>('Salida', audio.fadeOutCurve, FADE_CURVES.map((c) => ({ value: c, label: FADE_CURVE_LABELS[c] })), (c) => editAudio((a) => { a.fadeOutCurve = c; })),
    actions(button('Restablecer audio', () => editEffects(host, clip, (e) => { e.audio = null; }), 'Quitar los efectos de audio')),
  ], 'fx-audio');
}
