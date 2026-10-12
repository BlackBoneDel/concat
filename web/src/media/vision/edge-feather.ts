// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Matte edge refinement: choke (erode/dilate) and feather (blur) the alpha
 * channel only. Feathering is three passes of a separable box blur, which
 * converges to a Gaussian (central limit theorem; W. Wells, "Efficient
 * synthesis of Gaussian filters by cascaded uniform filters", IEEE PAMI 1986)
 * at O(1) cost per pixel regardless of radius.
 */

/** Edge settings. */
export interface FeatherParams {
  enabled: boolean;
  /** Blur radius in pixels, 0–50. */
  radius: number;
  /** −1 (grow) … +1 (shrink) the matte before blurring. */
  choke: number;
}

/** Light feather, no choke. */
export const DEFAULT_FEATHER: Readonly<FeatherParams> = Object.freeze({ enabled: true, radius: 2, choke: 0 });

/**
 * Validates settings.
 * @param p candidate.
 * @returns valid settings.
 */
export function validateFeather(p: Partial<FeatherParams>): FeatherParams {
  const radius = Number(p.radius ?? DEFAULT_FEATHER.radius);
  const choke = Number(p.choke ?? DEFAULT_FEATHER.choke);
  if (!(radius >= 0 && radius <= 50)) throw new RangeError('El radio de difuminado debe estar entre 0 y 50 px');
  if (!(choke >= -1 && choke <= 1)) throw new RangeError('El ajuste de borde debe estar entre −1 y 1');
  return { enabled: p.enabled !== false, radius, choke };
}

/**
 * Choke transfer for one alpha (0..1).
 * @param a alpha.
 * @param choke −1…1.
 * @returns adjusted alpha.
 */
export function chokeAlpha(a: number, choke: number): number {
  const c = Math.max(-0.95, Math.min(0.95, choke));
  if (c > 0) return Math.min(1, Math.max(0, (a - c) / (1 - c)));
  if (c < 0) return Math.min(1, a / (1 + c));
  return a;
}

/** One box-blur pass over rows (stride 1) or columns (stride width). */
function boxPass(src: Float32Array, dst: Float32Array, lines: number, length: number, step: number, lineStep: number, radius: number): void {
  const size = 2 * radius + 1;
  for (let line = 0; line < lines; line += 1) {
    const base = line * lineStep;
    let acc = 0;
    // Clamp-to-edge window initialisation.
    for (let k = -radius; k <= radius; k += 1) acc += src[base + Math.min(length - 1, Math.max(0, k)) * step]!;
    for (let i = 0; i < length; i += 1) {
      dst[base + i * step] = acc / size;
      const out = Math.max(0, i - radius);
      const into = Math.min(length - 1, i + radius + 1);
      acc += src[base + into * step]! - src[base + out * step]!;
    }
  }
}

/**
 * Blurs a single-channel plane in place (3 box passes each way).
 * @param plane values, row-major.
 * @param width columns.
 * @param height rows.
 * @param radius blur radius in pixels.
 */
export function blurPlane(plane: Float32Array, width: number, height: number, radius: number): void {
  // Three box passes of radius r ≈ Gaussian σ = r·√(2/3)…; split the radius.
  const r = Math.max(1, Math.round(radius / Math.sqrt(3)));
  const tmp = new Float32Array(plane.length);
  for (let pass = 0; pass < 3; pass += 1) {
    boxPass(plane, tmp, height, width, 1, width, r);
    boxPass(tmp, plane, width, height, width, 1, r);
  }
}

/**
 * Chokes and feathers the alpha of RGBA pixels in place.
 * @param pixels `ImageData.data`.
 * @param width image width.
 * @param height image height.
 * @param params settings.
 */
export function featherAlpha(pixels: Uint8ClampedArray, width: number, height: number, params: FeatherParams): void {
  if (!params.enabled || (params.radius <= 0 && params.choke === 0)) return;
  const plane = new Float32Array(width * height);
  for (let i = 0; i < plane.length; i += 1) plane[i] = chokeAlpha(pixels[i * 4 + 3]! / 255, params.choke);
  if (params.radius > 0) blurPlane(plane, width, height, params.radius);
  for (let i = 0; i < plane.length; i += 1) pixels[i * 4 + 3] = plane[i]! * 255;
}
