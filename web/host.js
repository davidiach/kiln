// Runs a compiled Kiln program and reports back through `post`.
// Used inside a Web Worker, or directly on the main thread as a fallback.

import { instantiate, explainError } from '../src/runtime.js';

const MAX_LINES = 400;

export function createHost(post) {
  let inst = null;
  let lines = [];
  let dropped = 0;
  const input = { mouseX: 160, mouseY: 120, mouseDown: false, keys: new Set() };

  const print = (line) => {
    lines.push(line);
    if (lines.length > MAX_LINES) {
      lines.shift();
      dropped++;
    }
  };
  const flush = () => {
    const out = { lines, dropped };
    lines = [];
    dropped = 0;
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
          inst = await instantiate(msg.program, { print, input });
          inst.main();
          const px = pixels();
          post({ type: 'ready', hasFrame: inst.hasFrame, hasScreen: inst.hasScreen, pixels: px, ...flush() }, px ? [px.buffer] : []);
        } catch (e) {
          fail(e);
        }
      } else if (msg.type === 'frame' && inst) {
        try {
          setInput(msg.input);
          inst.frame(msg.t);
          const px = pixels();
          post({ type: 'frame', pixels: px, ...flush() }, px ? [px.buffer] : []);
        } catch (e) {
          fail(e);
        }
      }
    },
  };
}
