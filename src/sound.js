// The sound model shared by the browser player (Web Audio) and the offline
// software synth (WAV export, tests). Both follow this spec, so a program
// sounds the same in the playground and in a rendered file.
//
// A sound event is { at, wave, freq, to, dur, vol }:
//   at    start time, in seconds on the program's clock (the t of frame(t))
//   wave  0 square, 1 triangle, 2 saw, 3 sine, 4 noise
//   freq  starting pitch in Hz (for noise: the low-pass cutoff)
//   to    ending pitch; the pitch slides exponentially from freq to `to`
//   dur   length in seconds
//   vol   peak volume, 0..1
//
// Envelope: a 5 ms attack, a hold until 30% of the duration, then an
// exponential fade to silence at the end.

export const WAVES = ['square', 'triangle', 'sawtooth', 'sine', 'noise'];

/** Per-wave loudness, so a square and a sine at the same volume feel similar. */
export const WAVE_GAIN = [0.4, 1.0, 0.45, 1.0, 1.4];

export const MASTER_GAIN = 0.5;
export const MAX_SOUNDS_PER_FRAME = 32;
export const FADE_FLOOR = 1e-4;

export function envelopeTimes(dur) {
  const attack = Math.min(0.005, dur * 0.25);
  const hold = Math.max(attack, dur * 0.3);
  return { attack, hold };
}

/** Envelope gain (0..1) at time `t` into a sound of length `dur`. */
export function envelopeAt(t, dur) {
  const { attack, hold } = envelopeTimes(dur);
  if (t < 0 || t >= dur) return 0;
  if (t < attack) return t / attack;
  if (t < hold) return 1;
  return Math.pow(FADE_FLOOR, (t - hold) / (dur - hold));
}

const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);

/** Validate and clamp an event coming from a program. Returns null to drop it. */
export function sanitizeSound(at, wave, freq, to, dur, vol) {
  if (![at, freq, to, dur, vol].every(Number.isFinite)) return null;
  if (vol <= 0 || dur <= 0) return null;
  return {
    at: Math.max(at, 0),
    wave: clamp(wave | 0, 0, WAVES.length - 1),
    freq: clamp(freq, 20, 20000),
    to: clamp(to, 20, 20000),
    dur: clamp(dur, 0.01, 10),
    vol: clamp(vol, 0, 1),
  };
}
