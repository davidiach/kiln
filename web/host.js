// Runs a compiled Kiln program and reports back through `post`.
// Used inside a Web Worker, or directly on the main thread as a fallback.

import { instantiate, explainError } from '../src/runtime.js';
import { MAX_SOUNDS_PER_FRAME } from '../src/sound.js';

const MAX_LINES = 400;

// A program's audio(t) is computed in this worker, a little ahead of the
// program clock, and sent with each frame for the page to schedule.
export const AUDIO_LEAD = 0.12; // seconds computed ahead of the frame's time
const MAX_AUDIO_CHUNK = 0.25; // seconds in one message, at most

export function createHost(post) {
  let inst = null;
  let lines = [];
  let dropped = 0;
  let sounds = [];
  const sound = (ev) => {
    if (sounds.length < MAX_SOUNDS_PER_FRAME) sounds.push(ev);
  };
  const input = { mouseX: 160, mouseY: 120, mouseDown: false, keys: new Set() };
  let audioRate = 48000;
  let audioEnd = 0; // program time up to which audio has been computed

  /** The next chunk of the program's audio: up to AUDIO_LEAD ahead of `t`. */
  const audioChunk = (t) => {
    if (!inst || !inst.hasAudio) return null;
    if (audioEnd < t) audioEnd = t; // frames fell behind: skip ahead rather than play stale audio
    const n = Math.min(Math.round((t + AUDIO_LEAD - audioEnd) * audioRate), Math.round(MAX_AUDIO_CHUNK * audioRate));
    if (n <= 0) return null;
    const t0 = audioEnd;
    const samples = inst.audio(t0, n, audioRate);
    audioEnd = t0 + n / audioRate;
    return { t0, rate: audioRate, samples };
  };

  const print = (line) => {
    lines.push(line);
    if (lines.length > MAX_LINES) {
      lines.shift();
      dropped++;
    }
  };
  const flush = () => {
    const out = { lines, dropped, sounds };
    lines = [];
    dropped = 0;
    sounds = [];
    return out;
  };
  const setInput = (i) => {
    if (!i) return;
    input.mouseX = i.mouseX;
    input.mouseY = i.mouseY;
    input.mouseDown = i.mouseDown;
    input.keys = new Set(i.keys);
  };
  const pixels = () => {
    if (!inst || !inst.hasScreen) return null;
    return inst.pixels(new Uint8ClampedArray(inst.width * inst.height * 4));
  };
  const fail = (e) => {
    const err = explainError(e);
    post({ type: 'error', message: err.message, line: err.line, ...flush() });
    inst = null;
  };

  return {
    async handle(msg) {
      if (msg.type === 'start') {
        try {
          setInput(msg.input);
          if (msg.sampleRate) audioRate = msg.sampleRate;
          audioEnd = msg.t;
          inst = await instantiate(msg.program, { print, input, sound, startTime: msg.t, sampleRate: audioRate });
          inst.main();
          const px = pixels();
          const audio = audioChunk(msg.t);
          const transfer = [px?.buffer, audio?.samples.buffer].filter(Boolean);
          post({ type: 'ready', t: msg.t, hasFrame: inst.hasFrame, hasAudio: inst.hasAudio, hasScreen: inst.hasScreen, pixels: px, audio, ...flush() }, transfer);
        } catch (e) {
          fail(e);
        }
      } else if (msg.type === 'frame' && inst) {
        try {
          setInput(msg.input);
          inst.frame(msg.t);
          const px = pixels();
          const audio = audioChunk(msg.t);
          const transfer = [px?.buffer, audio?.samples.buffer].filter(Boolean);
          post({ type: 'frame', t: msg.t, pixels: px, audio, ...flush() }, transfer);
        } catch (e) {
          fail(e);
        }
      } else if (msg.type === 'rate') {
        audioRate = msg.rate; // the audio device's rate, known once sound is enabled
      }
    },
  };
}
