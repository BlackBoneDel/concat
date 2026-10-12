// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Exact rational time — a faithful port of `concat-core/src/time.rs`.
 *
 * Video editing is frame-accurate arithmetic on rates that are not
 * representable in binary floating point. 29.97 fps is really 30000/1001, and
 * an f64 accumulator drifts: after an hour of adding 1/29.97 you are visibly
 * off. So every timestamp in Concat is a {@link Rational} number of
 * **seconds**, and conversions to `number` happen only at the edges — display,
 * and arguments handed to decoders.
 *
 * The Rust original stores `i64` terms and computes in `i128`. JavaScript
 * numbers are f64, so this port uses `bigint` for the same exactness. The
 * `i64` representability contract of the Rust type is kept: values outside
 * `i64` range are refused, so a web project can still cross into the Rust/WASM
 * engine without changing meaning.
 */

const I64_MAX = (1n << 63n) - 1n;
const I64_MIN = -(1n << 63n);

/** Greatest common divisor of two integers, ignoring sign. */
function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

/** Floor division (Rust `div_euclid` for a positive divisor). */
function divFloor(num: bigint, den: bigint): bigint {
  const q = num / den;
  const wrongWay = num % den !== 0n && num < 0n !== den < 0n;
  return wrongWay ? q - 1n : q;
}

/**
 * An exact rational number, always stored in lowest terms with a positive
 * denominator. Used throughout Concat to mean *seconds* unless a comment says
 * otherwise.
 */
export class Rational {
  readonly num: bigint;
  /** Always positive. */
  readonly den: bigint;

  private constructor(num: bigint, den: bigint) {
    this.num = num;
    this.den = den;
    Object.freeze(this);
  }

  /** Zero seconds. */
  static readonly ZERO: Rational = new Rational(0n, 1n);
  /** One second. */
  static readonly ONE: Rational = new Rational(1n, 1n);

  /**
   * Builds `num / den` in lowest terms.
   * Throws when the denominator is zero or the reduced terms do not fit in
   * `i64` — the same contract as Rust `Rational::new`, which panics.
   */
  static new(num: bigint | number, den: bigint | number): Rational {
    const n = typeof num === 'bigint' ? num : BigInt(Math.trunc(num));
    const d = typeof den === 'bigint' ? den : BigInt(Math.trunc(den));
    if (d === 0n) throw new Error('Rational denominator must not be zero');
    const checked = Rational.checkedNew(n, d);
    if (!checked) throw new Error('rational overflowed i64');
    return checked;
  }

  /** Builds a whole number of seconds. */
  static fromInt(value: bigint | number): Rational {
    const v = typeof value === 'bigint' ? value : BigInt(Math.trunc(value));
    return Rational.new(v, 1n);
  }

  /**
   * Parses FFmpeg's `"num/den"` fraction syntax, also accepting a bare integer
   * or decimal. Returns `null` on anything else, including `"0/0"`, which
   * FFmpeg emits for streams with no meaningful frame rate. Port of
   * `Rational::parse`.
   */
  static parse(text: string): Rational | null {
    const trimmed = text.trim();
    const slash = trimmed.indexOf('/');
    if (slash >= 0) {
      const numText = trimmed.slice(0, slash).trim();
      const denText = trimmed.slice(slash + 1).trim();
      if (!/^[+-]?\d+$/.test(numText) || !/^[+-]?\d+$/.test(denText)) return null;
      const den = BigInt(denText);
      if (den === 0n) return null;
      return Rational.checkedNew(BigInt(numText), den);
    }
    const dot = trimmed.indexOf('.');
    if (dot >= 0) {
      const sign = trimmed.startsWith('-') ? -1n : 1n;
      const wholeText = trimmed.slice(0, dot).trim();
      const digits = trimmed.slice(dot + 1).trim();
      if (!/^[+-]?\d+$/.test(wholeText)) return null;
      if (digits.length === 0 || !/^\d+$/.test(digits)) return null;
      let den = 1n;
      for (let i = 0; i < digits.length; i += 1) den *= 10n;
      const whole = BigInt(wholeText);
      const frac = BigInt(digits);
      return Rational.checkedNew(whole * den + sign * frac, den);
    }
    if (!/^[+-]?\d+$/.test(trimmed)) return null;
    return Rational.checkedNew(BigInt(trimmed), 1n);
  }

  /**
   * Builds `num / den` in lowest terms, or `null` when the value cannot be
   * represented. The non-panicking path for numbers that come from a file
   * rather than from our own arithmetic — a hostile container must produce an
   * error, never a crash. Port of `Rational::checked_new`.
   */
  static checkedNew(num: bigint, den: bigint): Rational | null {
    if (den === 0n) return null;
    let n = num;
    let d = den;
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    const divisor = gcd(n, d);
    if (divisor > 1n) {
      n /= divisor;
      d /= divisor;
    }
    if (n < I64_MIN || n > I64_MAX || d < I64_MIN || d > I64_MAX) return null;
    return new Rational(n, d);
  }

  /**
   * The nearest rational with denominator 1,000,000 — the seam where a UI's
   * `number` becomes exact. Returns `null` for NaN, infinite values, and for
   * magnitudes an `i64` of microseconds cannot hold.
   *
   * This is for values *entering* the engine. Values that are already
   * `Rational` must never round-trip through here. Port of
   * `Rational::approximate`.
   */
  static approximate(value: number): Rational | null {
    if (!Number.isFinite(value)) return null;
    const scaled = Math.round(value * 1_000_000);
    if (!Number.isFinite(scaled) || Math.abs(scaled) >= 2 ** 63) return null;
    return Rational.checkedNew(BigInt(scaled), 1_000_000n);
  }

  /** The numerator, in lowest terms. */
  numerator(): bigint {
    return this.num;
  }

  /** The denominator, in lowest terms. Always positive. */
  denominator(): bigint {
    return this.den;
  }

  /** True if this is exactly zero. */
  isZero(): boolean {
    return this.num === 0n;
  }

  /** True if this is less than zero. */
  isNegative(): boolean {
    return this.num < 0n;
  }

  /**
   * The multiplicative inverse. Throws when this is zero — the same contract
   * as Rust `Rational::recip`.
   */
  recip(): Rational {
    if (this.isZero()) throw new Error('cannot take the reciprocal of zero');
    return Rational.new(this.den, this.num);
  }

  /** The largest integer less than or equal to this value. */
  floor(): bigint {
    return divFloor(this.num, this.den);
  }

  /** The smallest integer greater than or equal to this value. */
  ceil(): bigint {
    return -divFloor(-this.num, this.den);
  }

  /** Clamps to the inclusive range `[low, high]`. */
  clampTo(low: Rational, high: Rational): Rational {
    if (this.compare(low) < 0) return low;
    if (this.compare(high) > 0) return high;
    return this;
  }

  /** Total order on the rationals. */
  compare(other: Rational): -1 | 0 | 1 {
    const left = this.num * other.den;
    const right = other.num * this.den;
    return left < right ? -1 : left > right ? 1 : 0;
  }

  equals(other: Rational): boolean {
    return this.num === other.num && this.den === other.den;
  }

  add(other: Rational): Rational {
    return Rational.new(this.num * other.den + other.num * this.den, this.den * other.den);
  }

  sub(other: Rational): Rational {
    return Rational.new(this.num * other.den - other.num * this.den, this.den * other.den);
  }

  mul(other: Rational): Rational {
    return Rational.new(this.num * other.num, this.den * other.den);
  }

  div(other: Rational): Rational {
    return Rational.new(this.num * other.den, this.den * other.num);
  }

  neg(): Rational {
    return new Rational(-this.num, this.den);
  }

  /**
   * Lossy conversion, for display and for arguments handed to decoders.
   * Do not convert back. If a value round-trips through `number` it is no
   * longer exact, and that is how frame drift starts.
   */
  asNumber(): number {
    return Number(this.num) / Number(this.den);
  }

  /**
   * `"n/d"`, or just `"n"` for a whole number — the same spelling
   * {@link Rational.parse} reads back. Port of the Rust `Display` impl.
   */
  toString(): string {
    return this.den === 1n ? `${this.num}` : `${this.num}/${this.den}`;
  }
}
