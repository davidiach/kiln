// A small software synthesizer that renders sound events (see sound.js) to
// PCM samples, plus a WAV encoder. Used by `kiln audio` and the tests; the
// playground plays the same events through Web Audio instead.

import { WAVE_GAIN, MASTER_GAIN, envelopeAt } from './sound.js';

export function renderSounds(events, seconds, rate = 44100, seed = 1, stream = null) {
  const total = Math.ceil(seconds * rate);
  const out = new Float32Array(total);
  let state = seed >>> 0 || 1;
  const white = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) / 4294967296) * 2 - 1;
  };
  for (const ev of events) {
    const start = Math.round(ev.at * rate);
    const len = Math.round(ev.dur * rate);
    const ratio = ev.to / ev.freq;
    const gain = ev.vol * WAVE_GAIN[ev.wave] * MASTER_GAIN;
    let phase = 0;
    let lowpass = 0;
    for (let i = 0; i < len && start + i < total; i++) {
      const t = i / rate;
      const f = ev.freq * Math.pow(ratio, t / ev.dur);
      let s;
      if (ev.wave === 4) {
        // white noise through a one-pole low-pass filter at f
        lowpass += (1 - Math.exp((-2 * Math.PI * f) / rate)) * (white() - lowpass);
        s = lowpass;
      } else {
        if (ev.wave === 0) s = phase < 0.5 ? 1 : -1;
        else if (ev.wave === 1) s = 4 * Math.abs(phase - 0.5) - 1;
        else if (ev.wave === 2) s = 2 * phase - 1;
        else s = Math.sin(2 * Math.PI * phase);
        phase += f / rate;
        phase -= Math.floor(phase);
      }
      out[start + i] += s * gain * envelopeAt(t, ev.dur);
    }
  }
  // A program's audio(t) samples, at the same master volume the browser uses
  if (stream) for (let i = 0; i < total && i < stream.length; i++) out[i] += stream[i] * MASTER_GAIN;
  for (let i = 0; i < total; i++) out[i] = Math.tanh(out[i]); // soft clip
  return out;
}

/** 16-bit mono PCM WAV. */
export function encodeWav(samples, rate = 44100) {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const ascii = (offset, s) => [...s].forEach((c, i) => v.setUint8(offset + i, c.charCodeAt(0)));
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), true);
  return new Uint8Array(buf);
}
