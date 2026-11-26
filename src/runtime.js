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

/** A float that came from an f32 lane: the shortest decimal that reads back as the same f32. */
export function formatF32(v) {
  if (!Number.isFinite(v)) return formatFloat(v);
  for (let p = 1; p < 10; p++) {
    const d = Number(v.toPrecision(p));
    if (Math.fround(d) === v) return formatFloat(d);
  }
  return formatFloat(v);
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

/**
 * The Kiln position of a byte offset in the module, from the compiler's
 * position table ([offset, origin, line, col, function], sorted by offset;
 * for inlined code, the function is the one it was inlined from), or null
 * where nothing maps (origin null: a function's start, before its first
 * instruction).
 */
export function positionAt(positions, offset) {
  let lo = 0;
  let hi = positions.length - 1;
  let found = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (positions[mid][0] <= offset) {
      found = positions[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found && found[1] !== null ? { origin: found[1], line: found[2], col: found[3], fn: found[4] } : null;
}

/** The wasm frames of an engine error's stack, innermost first: { fn, offset }. */
function wasmFrames(e) {
  return [...String(e?.stack ?? '').matchAll(/at (\S+) \(wasm:\/\/[^)]*:0x([0-9a-f]+)\)/g)].map((m) => ({ fn: m[1], offset: parseInt(m[2], 16) }));
}

/**
 * Translate engine errors (stack overflow, wasm traps) into friendlier
 * messages. With the compiler's `positions`, the error also gets the line of
 * the innermost frame in the user's program. A stack overflow is reported at
 * a function's entry, which maps to nothing, so its line is the call that
 * recursed, one frame out (also for mutual recursion).
 */
export function explainError(e, positions = null) {
  if (e instanceof KilnRuntimeError) return e;
  const msg = String(e?.message ?? e);
  const overflow = e instanceof RangeError && /call stack/i.test(msg);
  const frames = wasmFrames(e);
  const at = positions && frames.map((f) => ({ ...f, pos: positionAt(positions, f.offset) })).find((f) => f.pos?.origin === 'user');
  const fn = at?.pos.fn ?? at?.fn ?? frames[0]?.fn; // the Kiln function, even if it was inlined
  const where = `${fn ? ` in '${fn}'` : ''}${at ? ` (line ${at.pos.line})` : ''}`;
  const site = at ? { origin: 'user', line: at.pos.line, col: at.pos.col } : undefined;
  if (overflow) return new KilnRuntimeError(`stack overflow${where}: is there a recursion that never stops?`, site);
  if (/integer overflow/i.test(msg)) return new KilnRuntimeError(`integer overflow in division${where}`, site);
  if (/unreachable/i.test(msg)) return new KilnRuntimeError(`reached unreachable code${where}`, site);
  if (/divide by zero/i.test(msg)) return new KilnRuntimeError(`division by zero${where}`, site);
  return new KilnRuntimeError(`${msg}${where}`, site);
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
    __print_f32: (v) => parts.push(formatF32(v)),
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
    this.positions = compiled.positions ?? null;
    this.hasMain = typeof this.exports.main === 'function';
    this.hasFrame = typeof this.exports.frame === 'function';
    this.hasScreen = this.exports.__screen !== undefined;
  }

  guard(f) {
    try {
      return f();
    } catch (e) {
      throw explainError(e, this.positions);
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
