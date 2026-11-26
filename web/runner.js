// Drives a running program: owns the worker, the frame loop, the canvas,
// input forwarding, and a watchdog that kills programs that hang.

import { createHost } from './host.js';
import { withSourceMapURL, sourceMapDataURL } from '../src/compiler.js';

const KEYMAP = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, ' ': 32, Enter: 13, Escape: 27, Shift: 16 };
const START_LIMIT_MS = 10000;
const FRAME_LIMIT_MS = 3000;

export class Runner {
  constructor({ canvas, width, height, workerSource, audio, onPrint, onError, onState }) {
    this.audio = audio;
    this.canvas = canvas;
    this.width = width;
    this.height = height;
    this.ctx = canvas.getContext('2d');
    this.image = this.ctx.createImageData(width, height);
    this.workerSource = workerSource;
    this.onPrint = onPrint;
    this.onError = onError;
    this.onState = onState;
    // `clicked` and `tapped` latch presses until a frame has seen them, so a
    // click or key tap shorter than one frame still reaches the program.
    this.input = { mouseX: width / 2, mouseY: height / 2, mouseDown: false, clicked: false, keys: new Set(), tapped: new Set() };
    this.t0 = performance.now();
    this.worker = null;
    this.useWorker = !!workerSource && typeof Worker !== 'undefined';
    this.state = 'idle';
    this.frames = 0;
    this.fpsSince = performance.now();
    this.clear();
    this.bindInput();
    requestAnimationFrame((now) => this.loop(now));
    setInterval(() => this.watchdog(), 250);
  }

  clear() {
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, this.width, this.height);
  }

  setState(state, extra = {}) {
    this.state = state;
    this.onState?.({ state, ...extra });
  }

  /** Start a compiled program. Live edits keep the clock running so animations don't jump. */
  start(compiled, { resetTime = true } = {}) {
    this.kill();
    this.audio?.reset();
    this.stats = { startedAt: performance.now(), sounds: 0, maxSounds: 0 };
    if (resetTime) this.t0 = performance.now();
    // The running binary carries its source map, so devtools can show and
    // step through the Kiln source; positions let runtime errors name a line.
    const binary = compiled.sourceMap ? withSourceMapURL(compiled.binary, sourceMapDataURL(compiled.sourceMap)) : compiled.binary;
    this.program = { binary, traps: compiled.traps, positions: compiled.positions, width: compiled.width, height: compiled.height };
    this.hasFrame = false;
    this.ready = false;
    this.worker = this.spawn();
    this.setState('starting');
    this.send({ type: 'start', t: this.now(), program: this.program, input: this.inputMessage() }, START_LIMIT_MS);
  }

  stop() {
    this.kill();
    this.audio?.reset();
    this.setState('stopped');
  }

  /** Wall-clock seconds since the current program was (re)started. */
  elapsed() {
    return this.stats ? (performance.now() - this.stats.startedAt) / 1000 : 0;
  }

  /** The program's clock, in seconds. */
  now() {
    return (performance.now() - this.t0) / 1000;
  }

  kill() {
    this.worker?.terminate();
    this.worker = null;
    this.busy = false;
  }

  spawn() {
    if (this.useWorker) {
      try {
        const url = URL.createObjectURL(new Blob([this.workerSource], { type: 'text/javascript' }));
        const w = new Worker(url);
        URL.revokeObjectURL(url);
        let heard = false;
        w.onmessage = (e) => {
          heard = true;
          if (w === this.worker) this.receive(e.data);
        };
        w.onerror = (e) => {
          e.preventDefault?.();
          if (w !== this.worker) return;
          if (!heard) {
            // Workers are unavailable here (e.g. a strict sandbox): run inline instead.
            this.useWorker = false;
            this.start({ ...this.program, binary: this.program.binary }, { resetTime: false });
          } else {
            this.fail({ message: e.message || 'worker crashed' });
          }
        };
        return w;
      } catch {
        this.useWorker = false;
      }
    }
    const handle = { dead: false };
    const host = createHost((msg) => queueMicrotask(() => !handle.dead && handle === this.worker && this.receive(msg)));
    handle.postMessage = (m) => host.handle(m);
    handle.terminate = () => (handle.dead = true);
    return handle;
  }

  send(msg, limit) {
    this.busy = true;
    this.sentAt = performance.now();
    this.limit = limit;
    const transfer = msg.type === 'start' && this.useWorker ? [] : undefined;
    this.worker.postMessage(msg, transfer);
  }

  receive(msg) {
    this.busy = false;
    if (msg.lines?.length || msg.dropped) this.onPrint?.(msg.lines, msg.dropped);
    if (msg.sounds?.length) {
      this.stats.sounds += msg.sounds.length;
      this.stats.maxSounds = Math.max(this.stats.maxSounds, msg.sounds.length);
      this.audio?.play(msg.sounds, msg.t);
    }
    if (msg.pixels) {
      this.image.data.set(msg.pixels);
      this.ctx.putImageData(this.image, 0, 0);
    }
    if (msg.type === 'ready') {
      this.ready = true;
      this.hasFrame = msg.hasFrame;
      if (!msg.hasScreen && !msg.hasFrame) this.clear();
      this.setState(msg.hasFrame ? 'running' : 'done');
      if (!msg.hasFrame) this.kill();
    } else if (msg.type === 'frame') {
      this.frames++;
    } else if (msg.type === 'error') {
      this.fail(msg);
    }
  }

  fail(err) {
    this.kill();
    this.audio?.reset();
    this.onError?.(err);
    this.setState('error');
  }

  watchdog() {
    if (!this.busy || !this.worker) return;
    const waited = performance.now() - this.sentAt;
    if (waited > this.limit) {
      this.fail({
        message: this.ready
          ? `frame() ran for over ${FRAME_LIMIT_MS / 1000} s and was stopped. Is there a loop that never ends?`
          : `main() ran for over ${START_LIMIT_MS / 1000} s and was stopped. Is there a loop that never ends?`,
      });
    } else if (waited > 700 && !this.ready) {
      this.setState('busy');
    }
  }

  loop(now) {
    requestAnimationFrame((n) => this.loop(n));
    if (now - this.fpsSince >= 1000) {
      this.fps = Math.round((this.frames * 1000) / (now - this.fpsSince));
      this.frames = 0;
      this.fpsSince = now;
      if (this.state === 'running') this.onState?.({ state: 'running', fps: this.fps });
    }
    if (this.worker && this.ready && this.hasFrame && !this.busy) {
      this.send({ type: 'frame', t: this.now(), input: this.inputMessage() }, FRAME_LIMIT_MS);
    }
  }

  inputMessage() {
    const i = this.input;
    const msg = { mouseX: i.mouseX, mouseY: i.mouseY, mouseDown: i.mouseDown || i.clicked, keys: [...new Set([...i.keys, ...i.tapped])] };
    i.clicked = false;
    i.tapped.clear();
    return msg;
  }

  bindInput() {
    const c = this.canvas;
    const move = (e) => {
      const r = c.getBoundingClientRect();
      this.input.mouseX = Math.floor(((e.clientX - r.left) / r.width) * this.width);
      this.input.mouseY = Math.floor(((e.clientY - r.top) / r.height) * this.height);
    };
    c.addEventListener('pointermove', move);
    c.addEventListener('pointerdown', (e) => {
      move(e);
      this.input.mouseDown = true;
      this.input.clicked = true;
      c.focus({ preventScroll: true });
      c.setPointerCapture?.(e.pointerId);
    });
    const up = () => (this.input.mouseDown = false);
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('keydown', (e) => {
      const code = KEYMAP[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase().charCodeAt(0) : null);
      if (code === null || e.ctrlKey || e.metaKey) return;
      this.input.keys.add(code);
      this.input.tapped.add(code);
      e.preventDefault();
    });
    c.addEventListener('keyup', (e) => {
      const code = KEYMAP[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase().charCodeAt(0) : null);
      if (code !== null) this.input.keys.delete(code);
    });
    c.addEventListener('blur', () => this.input.keys.clear());
  }
}
