// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

import { describe, expect, it } from 'vitest';
import { Rational } from '../src/core/rational.ts';

describe('Rational', () => {
  it('reduces to lowest terms with a positive denominator', () => {
    const r = Rational.new(6n, -8n);
    expect(r.numerator()).toBe(-3n);
    expect(r.denominator()).toBe(4n);
  });

  it('refuses a zero denominator and i64 overflow, like the Rust type', () => {
    expect(() => Rational.new(1n, 0n)).toThrow();
    expect(Rational.checkedNew(1n, 0n)).toBeNull();
    // 2^62 + 2^61 over i64 when doubled over a denominator of 1.
    expect(Rational.checkedNew((1n << 63n) + 1n, 1n)).toBeNull();
  });

  it('parses FFmpeg fractions, integers and decimals', () => {
    expect(Rational.parse('30000/1001')!.equals(Rational.new(30000n, 1001n))).toBe(true);
    expect(Rational.parse('-3')!.equals(Rational.fromInt(-3n))).toBe(true);
    expect(Rational.parse('3.5')!.equals(Rational.new(7n, 2n))).toBe(true);
    expect(Rational.parse('-0.5')!.equals(Rational.new(-1n, 2n))).toBe(true);
    expect(Rational.parse('0/0')).toBeNull();
    expect(Rational.parse('hello')).toBeNull();
  });

  it('round-trips through its display spelling', () => {
    for (const text of ['30000/1001', '5', '-2/3']) {
      expect(Rational.parse(text)!.toString()).toBe(text);
    }
  });

  it('keeps frame arithmetic exact where f64 drifts', () => {
    // The module's own doctest: 29.97 is 30000/1001, and frame 1800 is
    // exactly 60.06 seconds — not 60.059999...
    const rate = Rational.new(30000n, 1001n);
    const frameDuration = rate.recip();
    const t = Rational.fromInt(1800n).mul(frameDuration);
    expect(t.equals(Rational.new(60060n, 1000n))).toBe(true);
  });

  it('adds, subtracts, multiplies and divides exactly', () => {
    const a = Rational.new(1n, 3n);
    const b = Rational.new(1n, 6n);
    expect(a.add(b).equals(Rational.new(1n, 2n))).toBe(true);
    expect(a.sub(b).equals(Rational.new(1n, 6n))).toBe(true);
    expect(a.mul(b).equals(Rational.new(1n, 18n))).toBe(true);
    expect(a.div(b).equals(Rational.fromInt(2n))).toBe(true);
  });

  it('floors and ceils with the sign handled', () => {
    expect(Rational.new(7n, 2n).floor()).toBe(3n);
    expect(Rational.new(7n, 2n).ceil()).toBe(4n);
    expect(Rational.new(-7n, 2n).floor()).toBe(-4n);
    expect(Rational.new(-7n, 2n).ceil()).toBe(-3n);
  });

  it('approximates a UI number to a millionth and refuses the impossible', () => {
    const r = Rational.approximate(1.5);
    expect(r!.equals(Rational.new(3n, 2n))).toBe(true);
    expect(Rational.approximate(Number.NaN)).toBeNull();
    expect(Rational.approximate(Number.POSITIVE_INFINITY)).toBeNull();
    expect(Rational.approximate(2 ** 60)).toBeNull();
  });

  it('orders and clamps', () => {
    const a = Rational.new(1n, 3n);
    const b = Rational.new(1n, 2n);
    expect(a.compare(b)).toBe(-1);
    expect(b.compare(b)).toBe(0);
    expect(a.clampTo(Rational.ZERO, Rational.new(1n, 4n)).equals(Rational.new(1n, 4n))).toBe(true);
  });
});
