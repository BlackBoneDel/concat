// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Primary colour correction in linear light — the CPU reference (and
 * Canvas 2D fallback) of the grading shader in `vision-processor.ts`.
 *
 * Port of the scene-linear library of `src/crates/concat-effects/src/shader.rs`:
 * a multiply (exposure, white balance) happens in light, a judgement of the
 * eye (contrast, tonal ranges) in log, where a stop is the same distance at
 * every level.
 *
 * Pipeline per pixel:
 *   sRGB → linear → white balance (Bradford/von Kries, kelvin + tint) →
 *   exposure (×2^stops) → contrast about 18 % grey →
 *   tonal ranges in ACEScct log (blacks/shadows/highlights/whites) →
 *   saturation + vibrance about BT.709 luminance → hue rotation about the
 *   grey axis → gamma (display) → sRGB.
 */

import { linearToSrgb, saturate, SRGB_TO_LINEAR_8, LUMA_709 } from './color-space.ts';

/** The twelve grading controls. */
export interface ColorGradingParams {
  /** Stops, −5…5. */
  exposure: number;
  /** Kelvin, 2000…12000 (6500 = as shot). */
  temperature: number;
  /** −100 (green) … 100 (magenta). */
  tint: number;
  /** 0 (flat) … 2, 1 = as shot. */
  contrast: number;
  /** −1…1. */
  highlights: number;
  /** −1…1. */
  shadows: number;
  /** −1…1. */
  whites: number;
  /** −1…1. */
  blacks: number;
  /** 0 (grey) … 2, 1 = as shot. */
  saturation: number;
  /** −1…1: saturation weighted towards muted colours. */
  vibrance: number;
  /** Degrees, −180…180. */
  hue: number;
  /** 0.2…5, 1 = as shot (display gamma). */
  gamma: number;
}

/** As shot. */
export const NEUTRAL_GRADING: Readonly<ColorGradingParams> = Object.freeze({
  exposure: 0, temperature: 6500, tint: 0, contrast: 1, highlights: 0, shadows: 0,
  whites: 0, blacks: 0, saturation: 1, vibrance: 0, hue: 0, gamma: 1,
});

/** Ranges, in field order (also used by the inspector sliders). */
export const GRADING_RANGES: Readonly<Record<keyof ColorGradingParams, readonly [number, number, number]>> = Object.freeze({
  exposure: [-5, 5, 0.05],
  temperature: [2000, 12000, 50],
  tint: [-100, 100, 1],
  contrast: [0, 2, 0.01],
  highlights: [-1, 1, 0.01],
  shadows: [-1, 1, 0.01],
  whites: [-1, 1, 0.01],
  blacks: [-1, 1, 0.01],
  saturation: [0, 2, 0.01],
  vibrance: [-1, 1, 0.01],
  hue: [-180, 180, 1],
  gamma: [0.2, 5, 0.01],
});

/** Spanish labels. */
export const GRADING_LABELS: Readonly<Record<keyof ColorGradingParams, string>> = Object.freeze({
  exposure: 'Exposición', temperature: 'Temperatura', tint: 'Matiz (tinte)', contrast: 'Contraste',
  highlights: 'Altas luces', shadows: 'Sombras', whites: 'Blancos', blacks: 'Negros',
  saturation: 'Saturación', vibrance: 'Intensidad', hue: 'Tono', gamma: 'Gamma',
});

/**
 * Clamps every control into range (non-finite → neutral).
 * @param p candidate.
 * @returns valid parameters.
 */
export function sanitizeGrading(p: Partial<Record<keyof ColorGradingParams, unknown>>): ColorGradingParams {
  const out: ColorGradingParams = { ...NEUTRAL_GRADING };
  for (const key of Object.keys(NEUTRAL_GRADING) as (keyof ColorGradingParams)[]) {
    const [min, max] = GRADING_RANGES[key];
    const v = Number(p[key] ?? NEUTRAL_GRADING[key]);
    out[key] = Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : NEUTRAL_GRADING[key];
  }
  return out;
}

/** True when the grade changes nothing. */
export function isNeutralGrading(p: ColorGradingParams): boolean {
  return (Object.keys(NEUTRAL_GRADING) as (keyof ColorGradingParams)[]).every((key) => Math.abs(p[key] - NEUTRAL_GRADING[key]) < 1e-9);
}

// -- white balance (shader.rs: planckian / white_cones / white_balance) ------

type Vec3 = [number, number, number];
type Mat3 = [Vec3, Vec3, Vec3]; // columns, as WGSL/GLSL

const BRADFORD: Mat3 = [[0.8951, -0.7502, 0.0389], [0.2664, 1.7135, -0.0685], [-0.1614, 0.0367, 1.0296]];
const CONES: Mat3 = [[0.4227252927, 0.0556997770, 0.0213826437], [0.4913453244, 0.9615340509, 0.0876418678], [0.0273579445, 0.0231838105, 0.9805081326]];
const FROM_CONES: Mat3 = [[2.5380445168, -0.1460040576, -0.0422985104], [-1.2932769979, 1.1166483055, -0.0716072203], [-0.0402368843, -0.0223290262, 1.0227526883]];

function mulMV(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0][0] * v[0] + m[1][0] * v[1] + m[2][0] * v[2],
    m[0][1] * v[0] + m[1][1] * v[1] + m[2][1] * v[2],
    m[0][2] * v[0] + m[1][2] * v[1] + m[2][2] * v[2],
  ];
}

function mulMM(a: Mat3, b: Mat3): Mat3 {
  return [mulMV(a, b[0]), mulMV(a, b[1]), mulMV(a, b[2])];
}

/**
 * Kim et al.'s cubic fit of the Planckian locus in CIE 1960 (u, v).
 * @param kelvin colour temperature.
 * @returns `[u, v]`.
 */
export function planckian(kelvin: number): [number, number] {
  const t = Math.min(25000, Math.max(1667, kelvin));
  const k = 1000 / t;
  const x = t <= 4000 ? ((-0.2661239 * k - 0.2343589) * k + 0.8776956) * k + 0.17991 : ((-3.0258469 * k + 2.1070379) * k + 0.2226347) * k + 0.24039;
  const y = t <= 2222
    ? ((-1.1063814 * x - 1.3481102) * x + 2.18555832) * x - 0.20219683
    : t <= 4000
      ? ((-0.9549476 * x - 1.37418593) * x + 2.09137015) * x - 0.16748867
      : ((3.081758 * x - 5.8733867) * x + 3.75112997) * x - 0.37001483;
  const d = -2 * x + 12 * y + 3;
  return [(4 * x) / d, (6 * y) / d];
}

function whiteCones(kelvin: number, tint: number): Vec3 {
  const here = planckian(kelvin);
  const next = planckian(kelvin * 1.01);
  const len = Math.hypot(next[0] - here[0], next[1] - here[1]) || 1;
  const along: [number, number] = [(next[0] - here[0]) / len, (next[1] - here[1]) / len];
  const across: [number, number] = [along[1], -along[0]];
  const magenta: [number, number] = across[1] > 0 ? [-across[0], -across[1]] : across;
  const u = here[0] + magenta[0] * tint * 0.0007;
  const v = here[1] + magenta[1] * tint * 0.0007;
  const d = 2 * u - 8 * v + 4;
  const x = (3 * u) / d;
  const y = (2 * v) / d;
  return mulMV(BRADFORD, [x / y, 1, (1 - x - y) / y]);
}

/**
 * The 3×3 white-balance matrix (linear Rec.709 → linear Rec.709), luminance-preserving.
 * @param kelvin target temperature (6500 = as shot).
 * @param tint magenta (+) / green (−).
 * @returns column-major matrix as 9 numbers.
 */
export function whiteBalanceMatrix(kelvin: number, tint: number): Float32Array {
  const target = whiteCones(kelvin, tint);
  const reference = whiteCones(6500, 0);
  const gains: Vec3 = [target[0] / reference[0], target[1] / reference[1], target[2] / reference[2]];
  const scaled: Mat3 = [
    [CONES[0][0] * gains[0], CONES[0][1] * gains[1], CONES[0][2] * gains[2]],
    [CONES[1][0] * gains[0], CONES[1][1] * gains[1], CONES[1][2] * gains[2]],
    [CONES[2][0] * gains[0], CONES[2][1] * gains[1], CONES[2][2] * gains[2]],
  ];
  const adapt = mulMM(FROM_CONES, scaled);
  const white = mulMV(adapt, [1, 1, 1]);
  const norm = white[0] * LUMA_709[0] + white[1] * LUMA_709[1] + white[2] * LUMA_709[2];
  return Float32Array.from([...adapt[0], ...adapt[1], ...adapt[2]].map((v) => v / norm));
}

// -- log space (shader.rs: to_log / from_log, ACEScct S-2016-001) ------------

/** Linear → ACEScct. */
export function toLog(v: number): number {
  return v <= 0.0078125 ? v * 10.5402377416545 + 0.0729055341958355 : (Math.log2(v) + 9.72) / 17.52;
}

/** ACEScct → linear. */
export function fromLog(v: number): number {
  return v <= 0.155251141552511 ? (v - 0.0729055341958355) / 10.5402377416545 : Math.min(65504, 2 ** (v * 17.52 - 9.72));
}

/** Middle grey, 18 % of SDR white. */
export const MID_GREY = 0.18;

/** Tonal range centres/widths in ACEScct (grey 0.414, white 0.555). */
export const TONAL_BANDS = Object.freeze({
  blacks: [0.16, 0.08], shadows: [0.33, 0.08], highlights: [0.5, 0.06], whites: [0.58, 0.05],
} as const);

/** Log offset of a full ±1 tonal move (≈ 1.75 stops). */
export const TONAL_SCALE = 0.1;

/** Precomputed per-grade constants. */
export interface GradingPlan {
  params: ColorGradingParams;
  wb: Float32Array;
  gain: number;
  hueCos: number;
  hueSin: number;
  identity: boolean;
}

/**
 * Precomputes the constants of a grade.
 * @param params the grade.
 * @returns the plan.
 */
export function planGrading(params: ColorGradingParams): GradingPlan {
  const rad = (params.hue * Math.PI) / 180;
  return {
    params,
    wb: whiteBalanceMatrix(params.temperature, params.tint),
    gain: 2 ** params.exposure,
    hueCos: Math.cos(rad),
    hueSin: Math.sin(rad),
    identity: isNeutralGrading(params),
  };
}

function band(y: number, [centre, width]: readonly [number, number]): number {
  const d = (y - centre) / width;
  return Math.exp(-d * d);
}

/**
 * Grades one linear-light colour.
 * @param rgb linear RGB (mutated and returned).
 * @param plan the precomputed grade.
 * @returns the graded linear RGB.
 */
export function gradeLinear(rgb: Vec3, plan: GradingPlan): Vec3 {
  const p = plan.params;
  const m = plan.wb;
  let r = (m[0]! * rgb[0] + m[3]! * rgb[1] + m[6]! * rgb[2]) * plan.gain;
  let g = (m[1]! * rgb[0] + m[4]! * rgb[1] + m[7]! * rgb[2]) * plan.gain;
  let b = (m[2]! * rgb[0] + m[5]! * rgb[1] + m[8]! * rgb[2]) * plan.gain;
  if (p.contrast !== 1) {
    // shader.rs `contrast`: grey stays, light never goes below black.
    if (r > 0) r = Math.min(65504, MID_GREY * (Math.max(r, 1e-10) / MID_GREY) ** p.contrast);
    if (g > 0) g = Math.min(65504, MID_GREY * (Math.max(g, 1e-10) / MID_GREY) ** p.contrast);
    if (b > 0) b = Math.min(65504, MID_GREY * (Math.max(b, 1e-10) / MID_GREY) ** p.contrast);
  }
  if (p.blacks !== 0 || p.shadows !== 0 || p.highlights !== 0 || p.whites !== 0) {
    const y = toLog(Math.max(0, r * LUMA_709[0] + g * LUMA_709[1] + b * LUMA_709[2]));
    const offset = TONAL_SCALE * (
      p.blacks * band(y, TONAL_BANDS.blacks) + p.shadows * band(y, TONAL_BANDS.shadows) +
      p.highlights * band(y, TONAL_BANDS.highlights) + p.whites * band(y, TONAL_BANDS.whites)
    );
    r = fromLog(toLog(r) + offset);
    g = fromLog(toLog(g) + offset);
    b = fromLog(toLog(b) + offset);
  }
  const luma = r * LUMA_709[0] + g * LUMA_709[1] + b * LUMA_709[2];
  let sat = p.saturation;
  if (p.vibrance !== 0) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const current = max > 1e-6 ? (max - min) / max : 0;
    sat *= 1 + p.vibrance * (1 - current);
  }
  if (sat !== 1) {
    r = luma + (r - luma) * sat;
    g = luma + (g - luma) * sat;
    b = luma + (b - luma) * sat;
  }
  if (p.hue !== 0) {
    // Rotation about the grey axis (Rodrigues, axis (1,1,1)/√3).
    const c = plan.hueCos;
    const s = plan.hueSin;
    const k = (1 - c) / 3;
    const q = s / Math.sqrt(3);
    const nr = r * (c + k) + g * (k - q) + b * (k + q);
    const ng = r * (k + q) + g * (c + k) + b * (k - q);
    const nb = r * (k - q) + g * (k + q) + b * (c + k);
    r = nr;
    g = ng;
    b = nb;
  }
  rgb[0] = r;
  rgb[1] = g;
  rgb[2] = b;
  return rgb;
}

/**
 * Grades RGBA pixels (sRGB, 8-bit) in place.
 * @param pixels `ImageData.data`.
 * @param params the grade.
 * @param split when set, only pixels with x ≥ split·width are graded (before/after view).
 * @param width image width (needed for split).
 */
export function applyColorGrading(pixels: Uint8ClampedArray, params: ColorGradingParams, split: number | null = null, width = 0): void {
  const plan = planGrading(params);
  if (plan.identity) return;
  const invGamma = 1 / params.gamma;
  const splitX = split !== null && width > 0 ? Math.round(split * width) : 0;
  const rgb: Vec3 = [0, 0, 0];
  for (let i = 0, px = 0; i < pixels.length; i += 4, px += 1) {
    if (splitX > 0 && px % width < splitX) continue;
    rgb[0] = SRGB_TO_LINEAR_8[pixels[i]!]!;
    rgb[1] = SRGB_TO_LINEAR_8[pixels[i + 1]!]!;
    rgb[2] = SRGB_TO_LINEAR_8[pixels[i + 2]!]!;
    gradeLinear(rgb, plan);
    for (let c = 0; c < 3; c += 1) {
      let v = saturate(linearToSrgb(rgb[c]!));
      if (invGamma !== 1) v = v ** invGamma;
      pixels[i + c] = v * 255;
    }
  }
}
