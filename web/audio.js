// Plays Kiln sound events through Web Audio.
//
// Programs run in a Web Worker, which can't use Web Audio, so they describe
// sounds as events (see src/sound.js) that arrive with each frame's result.
// This maps the program's clock onto the audio clock with a little latency,
// so notes land exactly where the program scheduled them even when frames
// jitter.

import { WAVES, WAVE_GAIN, MASTER_GAIN, FADE_FLOOR, MAX_VOICES, envelopeTimes } from '../src/sound.js';

const LATENCY = 0.06;

export class AudioEngine {
  constructor({ muted = false, onChange } = {}) {
    this.ctx = null;
    this.master = null;
    this.bus = null;
    this.noise = null;
    this.offset = null;
    this.voices = 0;
    this.played = 0;
    this.muted = muted;
    this.wanted = false; // a program tried to make sound before audio was allowed
    this.onChange = onChange;
  }

  /** 'on', 'muted' or 'locked' (the browser hasn't let us start audio yet). */
  get state() {
    if (!this.ctx || this.ctx.state !== 'running') return 'locked';
    return this.muted ? 'muted' : 'on';
  }

  /** Browsers only start audio from a user gesture: call this from click/key handlers. */
  unlock() {
    try {
      if (!this.ctx) {
        const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
        if (!AC) return;
        const ctx = new AC();
        this.ctx = ctx;
        this.master = ctx.createGain();
        this.master.gain.value = this.muted ? 0 : MASTER_GAIN;
        // A gentle compressor keeps busy patterns from clipping.
        const limiter = ctx.createDynamicsCompressor();
        limiter.threshold.value = -12;
        limiter.knee.value = 12;
        limiter.ratio.value = 6;
        this.master.connect(limiter).connect(ctx.destination);
        // Two seconds of white noise, looped for WAVE_NOISE.
        this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
        const data = this.noise.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
        ctx.onstatechange = () => this.onChange?.();
      }
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    } catch {
      // No audio here; programs still run silently.
    }
    this.onChange?.();
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.master) this.master.gain.setTargetAtTime(muted ? 0 : MASTER_GAIN, this.ctx.currentTime, 0.015);
    this.onChange?.();
  }

  /** Silence the previous run, including sounds it scheduled for later. */
  reset() {
    this.offset = null;
    this.wanted = false;
    if (this.bus) {
      const old = this.bus;
      old.gain.setTargetAtTime(0, this.ctx.currentTime, 0.01);
      setTimeout(() => old.disconnect(), 150);
      this.bus = null;
    }
  }

  /** Schedule events the program produced while its clock read `now`. */
  play(events, now) {
    if (!events.length) return;
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') {
      if (!this.wanted) {
        this.wanted = true;
        this.onChange?.();
      }
      return;
    }
    if (!this.bus) {
      this.bus = ctx.createGain();
      this.bus.connect(this.master);
    }
    // Keep a fixed distance between program time and audio time; if the
    // program fell behind (a slow frame, a background tab), start again from now.
    if (this.offset === null || now + this.offset < ctx.currentTime) this.offset = ctx.currentTime + LATENCY - now;
    for (const ev of events) {
      if (this.voices >= MAX_VOICES) break;
      this.voice(ev, Math.max(ev.at + this.offset, ctx.currentTime));
    }
  }

  voice(ev, start) {
    const ctx = this.ctx;
    const end = start + ev.dur;
    const { attack, hold } = envelopeTimes(ev.dur);
    const peak = ev.vol * WAVE_GAIN[ev.wave];

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(peak, start + attack);
    env.gain.setValueAtTime(peak, start + hold);
    env.gain.exponentialRampToValueAtTime(peak * FADE_FLOOR, end);
    env.connect(this.bus);

    let src;
    let pitch;
    if (WAVES[ev.wave] === 'noise') {
      src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.Q.value = 0.5;
      src.connect(filter).connect(env);
      pitch = filter.frequency;
      src.start(start, Math.random() * 1.9);
    } else {
      src = ctx.createOscillator();
      src.type = WAVES[ev.wave];
      src.connect(env);
      pitch = src.frequency;
      src.start(start);
    }
    pitch.setValueAtTime(ev.freq, start);
    if (ev.to !== ev.freq) pitch.exponentialRampToValueAtTime(ev.to, end);
    src.stop(end + 0.02);
    this.voices++;
    this.played++;
    src.onended = () => {
      this.voices--;
      env.disconnect();
    };
  }
}
