// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * The bridge between the `concat.json` document and the engine model.
 *
 * `EditorClip` extends `core/timeline`'s `Clip` with the fields the wire
 * document carries and the engine does not (crop, cutout, text, shape, the
 * audio gain and ramps). The four calls every renderer must agree on —
 * `source_time_at`, `transform_at`, `opacity_at`, `video_fade_factor` — stay
 * the engine's own, so nothing is re-implemented here.
 *
 * Document keys are absolute ("they replace the constant rather than ride on
 * it"): when a property is keyed, its base sits at the neutral value and the
 * keys ride through `Animation` — the exact product `transform_at` /
 * `opacity_at` / `volume_at` compute.
 */

import { Animation, Ease, Key, KeyTrack } from '../core/animate.ts';
import { Rational } from '../core/rational.ts';
import { SpeedCurve } from '../core/retime.ts';
import { Blend, Clip, MediaRef, Transform } from '../core/timeline.ts';
import {
  type ClipKind,
  type Crop,
  type Cutout,
  type DocumentClip,
  type KeyEase,
  type ShapeStyle,
  type TextStyle,
  KEY_EPSILON,
  clipIsKeyed,
} from '../model/index.ts';

/** Rational for a settled document number: the f64 seam of `approximate`. */
function seconds(value: number): Rational {
  return Rational.approximate(value) ?? Rational.ZERO;
}

/** The document's easing spelling as the engine's `Ease`. */
function engineEase(ease: KeyEase): Ease {
  const [x1, y1, x2, y2] = ease.points;
  return new Ease(x1, y1, x2, y2);
}

/** Builds a `KeyTrack` from one property's document keys (already sorted). */
function ride(keys: { at: number; value: number; ease: KeyEase }[]): KeyTrack {
  return new KeyTrack(
    // Keys closer than KEY_EPSILON are the same key; the later one wins.
    keys
      .filter((key, index) => {
        const next = keys[index + 1];
        return !next || next.at - key.at > KEY_EPSILON;
      })
      .map((key) => new Key(key.at, key.value, engineEase(key.ease))),
  );
}

/** A clip of the edit: the engine `Clip`, plus what only the document knows. */
export class EditorClip extends Clip {
  /** The document clip id ("c1", ...): how commands and the UI name it. */
  readonly docId: string;
  /** The lane's document id. */
  readonly docTrackId: string;
  /** The bin item this clip is cut from; empty for text/layer/shape. */
  readonly mediaId: string;
  /** What this clip renders as. */
  readonly kind: ClipKind;
  /** Display label. */
  readonly name: string;
  /** What is cut off each edge of the source before fitting. */
  readonly crop: Crop | null;
  /** The cutout state; prepared for Fase 5, honoured by the compositor later. */
  readonly cutout: Cutout | null;
  /** The overlay, when this is a text clip. */
  readonly text: TextStyle | null;
  /** The figure, when this is a shape clip. */
  readonly shape: ShapeStyle | null;
  /** Linear gain of the clip's audio, 1 being unity (document `volume`). */
  readonly audioVolume: number;
  /** Seconds of audio ramp-in from silence at the head. */
  readonly audioFadeIn: number;
  /** Seconds of audio ramp-out to silence at the tail. */
  readonly audioFadeOut: number;

  /**
   * Builds the engine clip from its document entry.
   * @param doc the settled `concat.json` clip.
   */
  constructor(doc: DocumentClip) {
    const keyed = {
      scale: clipIsKeyed(doc, 'scale'),
      offsetX: clipIsKeyed(doc, 'offsetX'),
      offsetY: clipIsKeyed(doc, 'offsetY'),
      rotation: clipIsKeyed(doc, 'rotation'),
      opacity: clipIsKeyed(doc, 'opacity'),
      volume: clipIsKeyed(doc, 'volume'),
    };

    // A keyed property sits at its neutral base; its keys are absolute and
    // ride through the animation — `transform_at` multiplies scale factors
    // and adds offsets, so neutral * absolute = absolute.
    const transform = new Transform(
      keyed.scale ? 1 : doc.scale,
      keyed.offsetX ? 0 : doc.offsetX,
      keyed.offsetY ? 0 : doc.offsetY,
      keyed.rotation ? 0 : doc.rotation,
      doc.stretchX,
      doc.stretchY,
    );

    const byProperty = (property: Parameters<typeof clipIsKeyed>[1]) =>
      doc.keys.filter((key) => key.property === property);

    const animation = doc.keys.length
      ? new Animation(
          ride(byProperty('scale')),
          ride(byProperty('offsetX')),
          ride(byProperty('offsetY')),
          ride(byProperty('rotation')),
          ride(byProperty('opacity')),
          ride(byProperty('volume')),
        )
      : null;

    const retime = doc.speedCurve
      ? SpeedCurve.new(doc.speedCurve.map((point) => [point.at, point.speed] as const))
      : null;

    // Picture ramps come from the transition on the cut into this clip — the
    // cross-dissolve shape of the engine model. The document's `fadeIn`/
    // `fadeOut` are *audio* ramps and live in `audioFadeIn`/`audioFadeOut`.
    // Fase 7 hook (QA): a transition can never outlast its clip (a 1-frame
    // clip trimmed under a 1 s dissolve, a hand-edited project): clamp to
    // the clip so the ramp stays a ramp and the picture still reaches 1.
    const fadeSeconds = doc.transitionIn && Number.isFinite(doc.transitionIn.duration)
      ? Math.min(Math.max(0, doc.transitionIn.duration), Math.max(0, doc.duration))
      : 0;
    const videoFadeIn = fadeSeconds > 0 ? seconds(fadeSeconds) : Rational.ZERO;

    super(
      new MediaRef(doc.mediaId),
      seconds(doc.start),
      seconds(doc.duration),
      {
        sourceStart: seconds(doc.sourceStart),
        speed: seconds(doc.speed),
        opacity: keyed.opacity ? 1 : doc.opacity,
        videoFadeIn,
        videoFadeOut: Rational.ZERO,
        transform,
        retime,
        animation,
        blend: Blend.parse(doc.blend),
        hold: false,
      },
    );

    this.docId = doc.id;
    this.docTrackId = doc.trackId;
    this.mediaId = doc.mediaId;
    this.kind = doc.kind;
    this.name = doc.name;
    this.crop = doc.crop;
    this.cutout = doc.cutout;
    this.text = doc.text;
    this.shape = doc.shape;
    this.audioVolume = doc.volume;
    this.audioFadeIn = doc.fadeIn;
    this.audioFadeOut = doc.fadeOut;
  }

  /** The clip's audio gain at a timeline instant: the constant scaled by the
   * volume ride, exactly as `Animation::volume_at` computes it. */
  gainAt(time: Rational): number {
    const base = this.animation ?? new Animation();
    return base.volumeAt(this.audioVolume, this.fractionAt(time));
  }
}
