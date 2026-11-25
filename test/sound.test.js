import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile } from '../src/compiler.js';
import { instantiate } from '../src/runtime.js';
import { renderSounds, encodeWav } from '../src/synth.js';
import { errors } from './helpers.js';

const RATE = 44100;

async function soundsOf(src, { frames = 0, startTime = 0 } = {}) {
  const r = compile(src);
  if (!r.ok) throw new Error(r.errors.map((e) => e.message).join('\n'));
  const events = [];
  const inst = await instantiate(r, { print: () => {}, sound: (e) => events.push(e), startTime });
  inst.main();
  for (let i = 0; i < frames; i++) inst.frame(startTime + i / 60);
  return events;
}

/** Average frequency of a signal in [from, to) seconds, from rising zero crossings. */
function pitch(samples, from, to) {
  let crossings = 0;
  let prev = 0;
  for (let i = Math.round(from * RATE); i < Math.round(to * RATE); i++) {
    const v = samples[i];
    if (prev < 0 && v > 0) crossings++;
    if (v !== 0) prev = v;
  }
  return crossings / (to - from);
}

const rms = (samples, from, to) => {
  let sum = 0;
  const a = Math.round(from * RATE);
  const b = Math.round(to * RATE);
  for (let i = a; i < b; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / (b - a));
};

const tone = (wave, freq, to = freq, dur = 1, at = 0) => ({ at, wave, freq, to, dur, vol: 0.8 });

test('sound(), sound_at() and beep() produce events on the program clock', async () => {
  const ev = await soundsOf(`
    fn main() {
      beep(440.0, 0.2);
      sound_at(now() + 0.5, WAVE_NOISE, 3000.0, 60.0, 0.6, 0.9);
    }
    fn frame(t: float) {
      if t >= 1.0 && t < 1.01 { sound(WAVE_SAW, note(48), note(60), 0.25, 0.5); }
    }`, { frames: 90, startTime: 0.25 });
  assert.equal(ev.length, 2 + 1);
  assert.deepEqual(ev[0], { at: 0.25, wave: 0, freq: 440, to: 440, dur: 0.2, vol: 0.3 });
  assert.deepEqual(ev[1], { at: 0.75, wave: 4, freq: 3000, to: 60, dur: 0.6, vol: 0.9 });
  assert.equal(ev[2].wave, 2);
  assert.ok(Math.abs(ev[2].at - (0.25 + 45 / 60)) < 1e-9);
  assert.ok(Math.abs(ev[2].freq - 130.8128) < 1e-3);
});

test('events are clamped to sane ranges, and late ones play now', async () => {
  const ev = await soundsOf(`
    fn main() {
      sound(99, 1.0, 99999.0, 60.0, 7.0);
      sound_at(-3.0, WAVE_SINE, 440.0, 440.0, 0.1, 0.5);
      sound(WAVE_SINE, 440.0, 440.0, 0.1, 0.0);
    }`, { startTime: 2 });
  assert.deepEqual(ev, [
    { at: 2, wave: 4, freq: 20, to: 20000, dur: 10, vol: 1 },
    { at: 2, wave: 3, freq: 440, to: 440, dur: 0.1, vol: 0.5 },
  ]);
});

test('note() follows equal temperament', async () => {
  const r = compile('export fn f(n: int) -> float { return note(n); }');
  const inst = await instantiate(r);
  assert.equal(inst.exports.f(69), 440);
  assert.equal(inst.exports.f(81), 880);
  assert.ok(Math.abs(inst.exports.f(60) - 261.6256) < 1e-4);
});

test('programs without sound import nothing sound-related', () => {
  const quiet = compile('fn main() { print(1); }');
  assert.ok(!quiet.stats.imports.includes('__sound'));
  const loud = compile('fn main() { beep(440.0, 0.1); }');
  assert.deepEqual(loud.stats.imports, ['now', '__sound']);
});

test('the internal __sound import is not callable from programs', () => {
  const errs = errors('fn main() { __sound(0.0, 0, 440.0, 440.0, 1.0, 1.0); }');
  assert.match(errs.join('\n'), /unknown function '__sound'/);
});

test('synth: tonal waves play at the requested pitch', () => {
  for (const wave of [0, 1, 2, 3]) {
    const s = renderSounds([tone(wave, 440)], 1);
    const f = pitch(s, 0.01, 0.3);
    assert.ok(Math.abs(f - 440) < 8, `wave ${wave}: measured ${f} Hz`);
  }
});

test('synth: pitch slides exponentially from freq to to_freq', () => {
  const s = renderSounds([tone(3, 200, 800, 1)], 1);
  const start = pitch(s, 0.0, 0.1);
  const middle = pitch(s, 0.45, 0.55);
  assert.ok(start > 190 && start < 260, `start ${start}`);
  assert.ok(Math.abs(middle - 400) < 25, `middle ${middle}`); // the geometric mean of 200 and 800
});

test('synth: sound_at timing and the envelope', () => {
  const s = renderSounds([tone(3, 440, 440, 0.5, 0.25)], 1);
  assert.equal(rms(s, 0, 0.24), 0, 'silent before it starts');
  assert.ok(rms(s, 0.26, 0.35) > 0.1, 'loud just after it starts');
  assert.ok(rms(s, 0.7, 0.74) < 0.002, 'faded out by the end');
  assert.equal(rms(s, 0.76, 1), 0, 'silent afterwards');
});

test('synth: noise brightness follows the cutoff', () => {
  const dark = renderSounds([tone(4, 200)], 0.5);
  const bright = renderSounds([tone(4, 8000)], 0.5);
  assert.ok(rms(dark, 0, 0.1) > 0.01 && rms(bright, 0, 0.1) > 0.01, 'both are audible');
  assert.ok(pitch(bright, 0, 0.1) > 4 * pitch(dark, 0, 0.1), 'bright noise changes sign far more often');
});

test('synth: loud mixes are soft-clipped, never past full scale', () => {
  const many = Array.from({ length: 20 }, () => ({ ...tone(0, 110), vol: 1 }));
  const s = renderSounds(many, 0.2);
  assert.ok(Math.max(...s.map(Math.abs)) < 1);
});

test('encodeWav writes a valid 16-bit mono PCM header', () => {
  const wav = encodeWav(new Float32Array([0, 0.5, -1, 1]), RATE);
  const v = new DataView(wav.buffer);
  const tag = (o) => String.fromCharCode(...wav.slice(o, o + 4));
  assert.equal(tag(0), 'RIFF');
  assert.equal(tag(8), 'WAVE');
  assert.equal(v.getUint16(22, true), 1);
  assert.equal(v.getUint32(24, true), RATE);
  assert.equal(v.getUint32(40, true), 8);
  assert.deepEqual([0, 1, 2, 3].map((i) => v.getInt16(44 + i * 2, true)), [0, 16384, -32767, 32767]);
});

test('kiln audio renders a program to a WAV file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kiln-'));
  const src = join(dir, 'chime.kiln');
  writeFileSync(src, 'fn main() { for i in 0..3 { sound_at(i as float * 0.1, WAVE_TRIANGLE, note(72 + i * 4), note(72 + i * 4), 0.2, 0.5); } }');
  const out = join(dir, 'chime.wav');
  const log = execFileSync(process.execPath, [new URL('../bin/kiln.js', import.meta.url).pathname, 'audio', src, '-t', '0.5', '-o', out], { encoding: 'utf8' });
  assert.match(log, /3 sounds/);
  const wav = readFileSync(out);
  assert.equal(wav.length, 44 + Math.ceil(0.5 * RATE) * 2);
});
