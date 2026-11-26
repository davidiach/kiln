import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { compile } from '../src/compiler.js';
import { instantiate } from '../src/runtime.js';
import { createHost, AUDIO_LEAD } from '../web/host.js';
import { errors } from './helpers.js';

const has = (list, re) => assert.ok(list.some((m) => re.test(m)), `expected an error matching ${re}, got:\n  ${list.join('\n  ')}`);

async function load(src, opts = {}) {
  const r = compile(src);
  assert.ok(r.ok, r.ok ? '' : r.errors[0].message);
  const inst = await instantiate(r, { print: () => {}, ...opts });
  inst.main();
  return inst;
}

/** Frequency from upward zero crossings. */
function pitch(samples, rate) {
  let c = 0;
  for (let i = 1; i < samples.length; i++) if (samples[i - 1] <= 0 && samples[i] > 0) c++;
  return c / (samples.length / rate);
}
const rms = (s) => Math.sqrt(s.reduce((a, v) => a + v * v, 0) / s.length);

test('audio(t) is called for every sample and its pitch comes out right', async () => {
  const inst = await load('fn audio(t: float) -> float {\n  return 0.5 * sin(TAU * 440.0 * t);\n}\n');
  assert.ok(inst.hasAudio);
  for (const rate of [44100, 48000]) {
    const s = inst.audio(0, rate, rate);
    assert.ok(Math.abs(pitch(s, rate) - 440) <= 1, `${rate}: ${pitch(s, rate)} Hz`);
    assert.ok(Math.abs(Math.max(...s) - 0.5) < 1e-3);
  }
});

test('sample_rate() tells a phase accumulator the actual rate', async () => {
  const src = `
    var phase = 0.0;
    fn audio(t: float) -> float {
      phase += 300.0 / sample_rate();
      phase -= floor(phase);
      return phase < 0.5 ? 0.5 : -0.5;
    }`;
  for (const rate of [22050, 48000]) {
    const inst = await load(src, { sampleRate: rate });
    const s = inst.audio(0, rate, rate);
    assert.ok(Math.abs(pitch(s, rate) - 300) <= 1, `${rate}: ${pitch(s, rate)} Hz`);
  }
});

test('frame() and audio() share globals: what a frame decides, the audio plays', async () => {
  const src = `
    var freq = 0.0;
    fn frame(t: float) { freq = t < 1.0 ? 200.0 : 500.0; }
    fn audio(t: float) -> float { return sin(TAU * freq * t) * 0.5; }`;
  const inst = await load(src);
  inst.frame(0.5);
  assert.ok(Math.abs(pitch(inst.audio(0.5, 48000, 48000), 48000) - 200) <= 1);
  inst.frame(1.5);
  assert.ok(Math.abs(pitch(inst.audio(1.5, 48000, 48000), 48000) - 500) <= 1);
});

test('samples are clamped to -1..1 and NaN becomes silence', async () => {
  const inst = await load('fn audio(t: float) -> float {\n  if t < 0.5 { return 1000.0 * sin(TAU * 50.0 * t); }\n  return 0.0 / 0.0;\n}\n');
  const s = inst.audio(0, 1000, 1000);
  assert.equal(Math.max(...s), 1);
  assert.equal(Math.min(...s), -1);
  assert.ok(s.subarray(500).every((v) => v === 0));
});

test('audio(t) is an entry point: checked, exported, and enough to run on its own', () => {
  has(errors('fn audio(t: int) -> float { return 0.0; }'), /'audio' must look like: fn audio\(t: float\) -> float.*every audio sample/);
  has(errors('fn audio(t: float) { }'), /'audio' must look like/);
  assert.deepEqual(errors('fn audio(t: float) -> float { return 0.0; }'), [], 'no "nothing to run" error');
  const r = compile('fn helper(x: float) -> float { var y = x; y *= 2.0; return y; }\nfn audio(t: float) -> float { return helper(t) * 0.0; }');
  assert.match(r.wat, /\(func \$audio \(export "audio"\)/);
  assert.match(r.wat, /\(func \$helper/, 'what audio() calls is kept');
});

test('the worker host streams contiguous chunks a little ahead of the clock', async () => {
  const src = 'fn frame(t: float) { }\nfn audio(t: float) -> float { return sin(TAU * 330.0 * t) * 0.3; }';
  const msgs = [];
  const host = createHost((m) => msgs.push(m));
  const input = { mouseX: 0, mouseY: 0, mouseDown: false, keys: [] };
  await host.handle({ type: 'start', t: 2, program: compile(src), input, sampleRate: 48000 });
  for (let f = 1; f <= 30; f++) await host.handle({ type: 'frame', t: 2 + f / 60, input });
  await host.handle({ type: 'rate', rate: 44100 });
  await host.handle({ type: 'frame', t: 2 + 31 / 60, input });
  assert.equal(msgs[0].type, 'ready');
  assert.equal(msgs[0].hasAudio, true);
  const chunks = msgs.map((m) => m.audio).filter(Boolean);
  assert.equal(chunks[0].t0, 2, 'audio starts at the program clock');
  for (let i = 1; i < chunks.length; i++) {
    const prev = chunks[i - 1];
    assert.ok(Math.abs(chunks[i].t0 - (prev.t0 + prev.samples.length / prev.rate)) < 1e-9, 'each chunk continues the last');
  }
  const last = chunks[chunks.length - 1];
  assert.equal(last.rate, 44100, 'a rate message changes the rate of the next chunk');
  const ahead = last.t0 + last.samples.length / last.rate - (2 + 31 / 60);
  assert.ok(Math.abs(ahead - AUDIO_LEAD) < 1e-3, `audio is computed ${AUDIO_LEAD} s ahead (${ahead})`);
  const all = Float32Array.from(chunks.slice(0, -1).flatMap((c) => [...c.samples]));
  assert.ok(Math.abs(pitch(all, 48000) - 330) <= 2);
});

test('an error inside audio(t) stops the program and names its line', async () => {
  const src = 'var buf: [float; 8];\nvar i = 0;\nfn audio(t: float) -> float {\n  i += 1;\n  return buf[i];\n}\n';
  const msgs = [];
  const host = createHost((m) => msgs.push(m));
  await host.handle({ type: 'start', t: 0, program: compile(src), input: { keys: [] }, sampleRate: 1000 });
  const err = msgs.find((m) => m.type === 'error');
  assert.ok(err, 'an error message was posted');
  assert.match(err.message, /index 8 is out of bounds for 'buf', which has 8 elements \(line 5\)/);
  assert.equal(err.line, 5);
});

test('kiln audio mixes audio(t) into the WAV, at the playground\'s master volume', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kiln-'));
  try {
    const file = join(dir, 'tone.kiln');
    writeFileSync(file, 'fn audio(t: float) -> float {\n  return 0.5 * sin(TAU * 440.0 * t);\n}\n');
    const out = join(dir, 'tone.wav');
    const res = spawnSync(process.execPath, [new URL('../bin/kiln.js', import.meta.url).pathname, 'audio', file, '-t', '1', '-o', out], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /0 sounds \+ audio\(t\)/);
    const b = readFileSync(out);
    const n = (b.length - 44) / 2;
    const s = Float32Array.from({ length: n }, (_, i) => b.readInt16LE(44 + i * 2) / 32767);
    assert.ok(Math.abs(pitch(s, 44100) - 440) <= 1);
    assert.ok(Math.abs(Math.max(...s) - Math.tanh(0.5 * 0.4)) < 2e-3, 'master gain 0.4, then the soft clip');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the synth example plays the right notes when keys are held', async () => {
  const input = { mouseX: 10, mouseY: 200, mouseDown: false, keys: new Set() };
  const inst = await load(readFileSync(new URL('../examples/synth.kiln', import.meta.url), 'utf8'), { input, sampleRate: 48000 });
  const rate = 48000;
  let at = 0;
  const play = (seconds, keys) => {
    input.keys = new Set(keys);
    const out = [];
    for (let f = 0; f < seconds * 60; f++) {
      inst.frame(at / rate);
      out.push(...inst.audio(at / rate, rate / 60, rate));
      at += rate / 60;
    }
    return Float32Array.from(out);
  };
  assert.equal(rms(play(0.2, [])), 0, 'silent until a key is held');
  const c4 = play(1, [65]).subarray(rate * 0.2); // A plays C4
  assert.ok(Math.abs(pitch(c4, rate) - 261.6) < 2, `C4: ${pitch(c4, rate)}`);
  const c5 = play(1, [75]).subarray(rate * 0.2); // K plays C5
  assert.ok(Math.abs(pitch(c5, rate) - 523.3) < 3, `C5: ${pitch(c5, rate)}`);
  const chord = play(0.5, [65, 68, 71]);
  assert.ok(Math.max(...chord.map(Math.abs)) < 1, 'a chord stays below full scale');
  const release = play(1, []);
  assert.ok(rms(release.subarray(rate * 0.9)) < rms(release.subarray(0, rate * 0.1)) / 20, 'notes fade after release');
});
