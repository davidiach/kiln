// Host runtime: provides the imports a compiled Kiln module needs, turns traps
// into readable errors, and converts the framebuffer to RGBA pixels.
// Works the same in browsers, Web Workers and Node.

import { sanitizeSound } from './sound.js';

export class KilnRuntimeError extends Error {
  constructor(message, site) {
    super(message);
    this.name = 'KilnRuntimeError';
    this.line = site?.origin === 'user' ? site.line : undefined;
    this.col = site?.origin === 'user' ? site.col : undefined;
  }
}

export function formatFloat(v) {
  if (Number.isNaN(v)) return 'nan';
  if (v === Infinity) return 'inf';
  if (v === -Infinity) return '-inf';
  if (Number.isInteger(v) && Math.abs(v) < 1e21) return v.toFixed(1);
  return String(v);
}

function trapMessage(site, value) {
  const where = site.origin === 'user' ? ` (line ${site.line})` : ` (in prelude function '${site.fn}')`;
  switch (site.kind) {
    case 'index':
      return `index ${value} is out of bounds for '${site.name}', which has ${site.size} elements${where}`;
    case 'strindex':
      return `string index ${value} is out of bounds${where}`;
    case 'divzero':
      return `division by zero${where}`;
  }
  return `trap${where}`;
}

/** Translate engine errors (stack overflow, wasm traps) into friendlier messages. */
export function explainError(e) {
  if (e instanceof KilnRuntimeError) return e;
  const msg = String(e?.message ?? e);
  const fn = /at (\w+) \(wasm:/.exec(e?.stack ?? '')?.[1];
  const inFn = fn ? ` in '${fn}'` : '';
  if (e instanceof RangeError && /call stack/i.test(msg)) {
    return new KilnRuntimeError(`stack overflow${inFn}: is there a recursion that never stops?`);
  }
  if (/integer overflow/i.test(msg)) return new KilnRuntimeError(`integer overflow in division${inFn}`);
  if (/unreachable/i.test(msg)) return new KilnRuntimeError(`reached unreachable code${inFn}`);
  if (/divide by zero/i.test(msg)) return new KilnRuntimeError(`division by zero${inFn}`);
  return new KilnRuntimeError(`${msg}${inFn}`);
}

const decoder = new TextDecoder();

/**
 * Instantiate a compile() result.
 * @param {object} compiled  { binary, traps, hasScreen, width, height }
 * @param {object} opts      {
 *   print(line),                          console output
 *   input: { mouseX, mouseY, mouseDown, keys: Set },
 *   sound(event),                         sound events (see sound.js); ignored if absent
 *   startTime,                            program clock when main() runs (default 0)
 *   random,                               replacement for Math.random
 * }
 */
export async function instantiate(compiled, opts = {}) {
  const print = opts.print ?? ((line) => console.log(line));
  const input = opts.input ?? { mouseX: compiled.width / 2, mouseY: compiled.height / 2, mouseDown: false, keys: new Set() };
  const clock = { now: opts.startTime ?? 0 };
  const onSound = opts.sound ?? null;
  let memory = null;
  let parts = [];

  const readStr = (ptr) => {
    const view = new DataView(memory.buffer);
    const n = view.getInt32(ptr, true);
    return decoder.decode(new Uint8Array(memory.buffer, ptr + 4, n));
  };

  const env = {
    sin: Math.sin,
    cos: Math.cos,
    tan: Math.tan,
    asin: Math.asin,
    acos: Math.acos,
    atan: Math.atan,
    exp: Math.exp,
    log: Math.log,
    atan2: Math.atan2,
    pow: Math.pow,
    rand: opts.random ?? Math.random,
    mouse_x: () => input.mouseX | 0,
    mouse_y: () => input.mouseY | 0,
    mouse_down: () => (input.mouseDown ? 1 : 0),
    key_down: (k) => (input.keys.has(k) ? 1 : 0),
    now: () => clock.now,
    __sound: (at, wave, freq, to, dur, vol) => {
      if (!onSound) return;
      // Sounds can't start in the past: late ones play right away.
      const ev = sanitizeSound(Math.max(at, clock.now), wave, freq, to, dur, vol);
      if (ev) onSound(ev);
    },
    __print_i: (v) => parts.push(String(v)),
    __print_f: (v) => parts.push(formatFloat(v)),
    __print_b: (v) => parts.push(v ? 'true' : 'false'),
    __print_s: (p) => parts.push(readStr(p)),
    __print_end: () => {
      const line = parts.join('');
      parts = [];
      print(line);
    },
    __trap: (site, value) => {
      const info = compiled.traps[site];
      throw new KilnRuntimeError(trapMessage(info, value), info);
    },
  };

  const { instance } = await WebAssembly.instantiate(compiled.binary, { env });
  memory = instance.exports.memory;
  return new KilnInstance(instance, compiled, input, clock);
}

export class KilnInstance {
  constructor(instance, compiled, input, clock) {
    this.clock = clock;
    this.exports = instance.exports;
    this.compiled = compiled;
    this.input = input;
    this.width = compiled.width;
    this.height = compiled.height;
    this.hasMain = typeof this.exports.main === 'function';
    this.hasFrame = typeof this.exports.frame === 'function';
    this.hasScreen = this.exports.__screen !== undefined;
  }

  guard(f) {
    try {
      return f();
    } catch (e) {
      throw explainError(e);
    }
  }

  main() {
    if (this.hasMain) this.guard(() => this.exports.main());
  }

  frame(t) {
    this.clock.now = t;
    if (this.hasFrame) this.guard(() => this.exports.frame(t));
  }

  /** Copy the 0xRRGGBB framebuffer into an RGBA byte array (e.g. ImageData.data). */
  pixels(out = new Uint8ClampedArray(this.width * this.height * 4)) {
    if (!this.hasScreen) return out;
    const n = this.width * this.height;
    const src = new Uint32Array(this.exports.memory.buffer, this.exports.__screen.value, n);
    const dst = new Uint32Array(out.buffer, out.byteOffset, n);
    for (let i = 0; i < n; i++) {
      const c = src[i];
      dst[i] = 0xff000000 | ((c & 0xff) << 16) | (c & 0xff00) | ((c >>> 16) & 0xff);
    }
    return out;
  }
}
