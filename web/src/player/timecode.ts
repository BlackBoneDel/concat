// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Timecode formatting and parsing.
 *
 * `HH:MM:SS:FF` over the engine's exact time; drop-frame (`HH:MM:SS;FF`) for
 * the NTSC rates it exists for (29.97 and 59.94), where frames 0 and 1 of
 * the first second of every minute are skipped except every tenth minute —
 * the SMPTE 12M scheme that keeps timecode within a frame of wall time.
 */

import { Rational } from '../core/rational.ts';
import { FrameRate } from '../core/time.ts';

/** The nominal (integer) frame count of a rate: 30 for 29.97, 60 for 59.94. */
function nominalFps(fps: FrameRate): number {
  return Math.round(fps.fps().asNumber());
}

/** True when this rate is one drop-frame serves: 29.97 or 59.94. */
export function isDropFrameRate(fps: FrameRate): boolean {
  const rate = fps.fps();
  return (
    rate.equals(Rational.new(30000n, 1001n)) || rate.equals(Rational.new(60000n, 1001n))
  );
}

/**
 * The whole frame number at `time`.
 * @param time the instant.
 * @param fps the output rate.
 * @returns frames since zero.
 */
export function formatFrames(time: Rational, fps: FrameRate): number {
  return Number(fps.frameAt(time));
}

/**
 * Formats `HH:MM:SS:FF` (or `HH:MM:SS;FF` when drop-frame applies).
 * @param time the instant.
 * @param fps the output rate.
 * @param dropFrame whether to skip the two frames per non-tenth minute.
 * @returns the timecode string.
 */
export function formatTimecode(time: Rational, fps: FrameRate, dropFrame = false): string {
  const nominal = nominalFps(fps);
  let frameNumber = formatFrames(time, fps);
  const framesPer24Hours = nominal * 60 * 60 * 24;
  frameNumber = ((frameNumber % framesPer24Hours) + framesPer24Hours) % framesPer24Hours;

  if (dropFrame) {
    const drop = Math.round(nominal * 0.066666); // 2 at 30, 4 at 60
    const framesPer10Minutes = nominal * 60 * 10 - drop * 9;
    const framesPerMinute = nominal * 60 - drop;
    const tens = Math.floor(frameNumber / framesPer10Minutes);
    const within = frameNumber % framesPer10Minutes;
    frameNumber +=
      drop * 9 * tens +
      (within > drop ? drop * Math.floor((within - drop) / framesPerMinute) : 0);
  }

  const frames = frameNumber % nominal;
  const seconds = Math.floor(frameNumber / nominal) % 60;
  const minutes = Math.floor(frameNumber / (nominal * 60)) % 60;
  const hours = Math.floor(frameNumber / (nominal * 60 * 60));
  const separator = dropFrame ? ';' : ':';
  return (
    `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:` +
    `${String(seconds).padStart(2, '0')}${separator}${String(frames).padStart(2, '0')}`
  );
}

/**
 * Parses a timecode back to engine time. A `;` before the frames marks the
 * drop-frame spelling and undoes the skipped labels.
 * @param tc `HH:MM:SS:FF` or `HH:MM:SS;FF`.
 * @param fps the output rate the timecode counts in.
 * @returns the instant, or `null` when the text is not a timecode.
 */
export function parseTimecode(tc: string, fps: FrameRate): Rational | null {
  const match = /^(\d{1,2}):(\d{1,2}):(\d{1,2})([:;])(\d{1,2})$/.exec(tc.trim());
  if (!match) return null;
  const nominal = nominalFps(fps);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const separator = match[4] ?? ':';
  const frames = Number(match[5]);
  if (minutes >= 60 || seconds >= 60 || frames >= nominal) return null;
  let total = ((hours * 60 + minutes) * 60 + seconds) * nominal + frames;
  // Drop-frame labels skip two frames at the start of every minute except
  // every tenth — undo that to reach the true frame index.
  if (separator === ';' && isDropFrameRate(fps)) {
    const drop = Math.round(nominal * 0.066666);
    const totalMinutes = hours * 60 + minutes;
    total -= drop * (totalMinutes - Math.floor(totalMinutes / 10));
  }
  return Rational.fromInt(BigInt(total)).div(fps.fps());
}

/**
 * A human duration: `1h 5m 12s`, `2m 34s`, `12.3s`, `0.4s`.
 * @param time the length.
 * @returns the readable string.
 */
export function formatDuration(time: Rational): string {
  const total = Math.max(0, time.asNumber());
  if (total >= 3600) {
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    return `${hours}h ${minutes}m`;
  }
  if (total >= 60) {
    const minutes = Math.floor(total / 60);
    const seconds = Math.floor(total % 60);
    return `${minutes}m ${seconds}s`;
  }
  return total < 10 ? `${total.toFixed(1)}s` : `${Math.floor(total)}s`;
}
