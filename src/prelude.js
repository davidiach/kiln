// The Kiln standard prelude. It is ordinary Kiln code compiled together with
// every program; anything a program doesn't use is stripped from the output.

import { packedFont } from './font.js';

export const WIDTH = 320;
export const HEIGHT = 240;

const font = packedFont();
const fontRows = [];
for (let i = 0; i < font.length; i += 8) fontRows.push('  ' + font.slice(i, i + 8).map((v) => '0x' + v.toString(16).padStart(4, '0')).join(', ') + ',');

export const PRELUDE = `// ---- Kiln prelude: written in Kiln ----

const WIDTH = ${WIDTH};
const HEIGHT = ${HEIGHT};
const PI = 3.141592653589793;
const TAU = 6.283185307179586;

const KEY_LEFT = 37;
const KEY_UP = 38;
const KEY_RIGHT = 39;
const KEY_DOWN = 40;
const KEY_SPACE = 32;
const KEY_ENTER = 13;

const WAVE_SQUARE = 0;
const WAVE_TRIANGLE = 1;
const WAVE_SAW = 2;
const WAVE_SINE = 3;
const WAVE_NOISE = 4;

// The framebuffer. Colors are 0xRRGGBB.
var screen: [int; WIDTH * HEIGHT];

// ---- color

fn rgb(r: int, g: int, b: int) -> int {
  return (clamp(r, 0, 255) << 16) | (clamp(g, 0, 255) << 8) | clamp(b, 0, 255);
}

// Channels as floats in 0..1.
fn rgbf(r: float, g: float, b: float) -> int {
  return rgb((r * 255.99) as int, (g * 255.99) as int, (b * 255.99) as int);
}

// Hue, saturation, value, all in 0..1 (hue wraps around).
fn hsv(h: float, s: float, v: float) -> int {
  let hh = fract(h) * 6.0;
  let i = hh as int;
  let f = hh - i as float;
  let p = v * (1.0 - s);
  let q = v * (1.0 - s * f);
  let u = v * (1.0 - s * (1.0 - f));
  if i == 0 { return rgbf(v, u, p); }
  if i == 1 { return rgbf(q, v, p); }
  if i == 2 { return rgbf(p, v, u); }
  if i == 3 { return rgbf(p, q, v); }
  if i == 4 { return rgbf(u, p, v); }
  return rgbf(v, p, q);
}

// Blend two colors; t = 0 gives a, t = 1 gives b.
fn blend(a: int, b: int, t: float) -> int {
  let r = mix(((a >> 16) & 255) as float, ((b >> 16) & 255) as float, t);
  let g = mix(((a >> 8) & 255) as float, ((b >> 8) & 255) as float, t);
  let bl = mix((a & 255) as float, (b & 255) as float, t);
  return rgb(r as int, g as int, bl as int);
}

// ---- drawing

fn pixel(x: int, y: int, color: int) {
  if x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT {
    screen[y * WIDTH + x] = color;
  }
}

fn get_pixel(x: int, y: int) -> int {
  if x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT {
    return screen[y * WIDTH + x];
  }
  return 0;
}

fn clear(color: int) {
  for i in 0..WIDTH * HEIGHT {
    screen[i] = color;
  }
}

fn rect(x: int, y: int, w: int, h: int, color: int) {
  let x0 = max(x, 0);
  let x1 = min(x + w, WIDTH);
  for yy in max(y, 0)..min(y + h, HEIGHT) {
    for xx in x0..x1 {
      screen[yy * WIDTH + xx] = color;
    }
  }
}

fn circle(cx: int, cy: int, r: int, color: int) {
  for dy in -r..=r {
    for dx in -r..=r {
      if dx * dx + dy * dy <= r * r + r {
        pixel(cx + dx, cy + dy, color);
      }
    }
  }
}

// Bresenham's line algorithm.
fn line(x0: int, y0: int, x1: int, y1: int, color: int) {
  let dx = abs(x1 - x0);
  let dy = -abs(y1 - y0);
  let sx = x0 < x1 ? 1 : -1;
  let sy = y0 < y1 ? 1 : -1;
  var err = dx + dy;
  var x = x0;
  var y = y0;
  var steps = 0;
  while steps < 4096 {
    pixel(x, y, color);
    if x == x1 && y == y1 { break; }
    let e2 = 2 * err;
    if e2 >= dy { err += dy; x += sx; }
    if e2 <= dx { err += dx; y += sy; }
    steps += 1;
  }
}

// ---- text (3x5 pixel font, 4 pixels per character)

let FONT = [
${fontRows.join('\n')}
];

fn glyph(x: int, y: int, ch: int, color: int) {
  var c = ch;
  if c >= 97 && c <= 122 { c -= 32; }
  if c < 32 || c > 95 { return; }
  let bits = FONT[c - 32];
  for row in 0..5 {
    for col in 0..3 {
      if (bits >> (14 - row * 3 - col)) & 1 == 1 {
        pixel(x + col, y + row, color);
      }
    }
  }
}

fn text(x: int, y: int, s: str, color: int) {
  for i in 0..len(s) {
    glyph(x + i * 4, y, s[i], color);
  }
}

fn text_width(s: str) -> int {
  return len(s) * 4 - 1;
}

// Text drawn with size x size blocks per font pixel.
fn text_big(x: int, y: int, s: str, size: int, color: int) {
  for i in 0..len(s) {
    var c = s[i];
    if c >= 97 && c <= 122 { c -= 32; }
    if c < 32 || c > 95 { continue; }
    let bits = FONT[c - 32];
    for row in 0..5 {
      for col in 0..3 {
        if (bits >> (14 - row * 3 - col)) & 1 == 1 {
          rect(x + (i * 4 + col) * size, y + row * size, size, size, color);
        }
      }
    }
  }
}

fn number(x: int, y: int, n: int, color: int) {
  var v = n;
  var cx = x;
  if v < 0 {
    glyph(cx, y, 45, color);
    cx += 4;
    v = -v;
  }
  var digits = 1;
  var t = v;
  while t >= 10 {
    t /= 10;
    digits += 1;
  }
  for i in 0..digits {
    glyph(cx + (digits - 1 - i) * 4, y, 48 + v % 10, color);
    v /= 10;
  }
}

// ---- sound

// Play a sound now. The pitch slides from freq to to_freq (in Hz) over its
// length; pass the same value twice for a steady tone. For WAVE_NOISE the
// "pitch" is how bright the noise is. Volume is 0..1.
fn sound(wave: int, freq: float, to_freq: float, seconds: float, volume: float) {
  __sound(now(), wave, freq, to_freq, seconds, volume);
}

// Schedule a sound at an exact time, on the same clock as frame(t) and now().
// Scheduling slightly ahead keeps music in time even when a frame runs late.
fn sound_at(time: float, wave: int, freq: float, to_freq: float, seconds: float, volume: float) {
  __sound(time, wave, freq, to_freq, seconds, volume);
}

fn beep(freq: float, seconds: float) {
  sound(WAVE_SQUARE, freq, freq, seconds, 0.3);
}

// The frequency of a MIDI note number: 60 is middle C, 69 is A (440 Hz).
fn note(n: int) -> float {
  return 440.0 * pow(2.0, (n - 69) as float / 12.0);
}

// ---- math

fn fract(x: float) -> float {
  return x - floor(x);
}

fn mix(a: float, b: float, t: float) -> float {
  return a + (b - a) * t;
}

fn smoothstep(e0: float, e1: float, x: float) -> float {
  let t = clamp((x - e0) / (e1 - e0), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

fn sign(x: float) -> float {
  return x > 0.0 ? 1.0 : (x < 0.0 ? -1.0 : 0.0);
}

// ---- deterministic randomness

fn hash(n: int) -> int {
  var x = n * 0x27d4eb2d;
  x = (x ^ (x >>> 15)) * 0x2c1b3c6d;
  x = (x ^ (x >>> 12)) * 0x297a2d39;
  return x ^ (x >>> 15);
}

fn hash2(x: int, y: int) -> int {
  return hash(x * 374761393 + y * 668265263);
}

// A float in 0..1 determined by an int.
fn hashf(n: int) -> float {
  return (hash(n) >>> 8) as float / 16777216.0;
}

// Smooth 2D value noise in 0..1.
fn noise(x: float, y: float) -> float {
  let ix = floor(x) as int;
  let iy = floor(y) as int;
  let fx = x - floor(x);
  let fy = y - floor(y);
  let ux = fx * fx * (3.0 - 2.0 * fx);
  let uy = fy * fy * (3.0 - 2.0 * fy);
  let a = (hash2(ix, iy) >>> 8) as float / 16777216.0;
  let b = (hash2(ix + 1, iy) >>> 8) as float / 16777216.0;
  let c = (hash2(ix, iy + 1) >>> 8) as float / 16777216.0;
  let d = (hash2(ix + 1, iy + 1) >>> 8) as float / 16777216.0;
  return mix(mix(a, b, ux), mix(c, d, ux), uy);
}

// Fractal noise: several octaves of noise() added together.
fn fbm(x: float, y: float, octaves: int) -> float {
  var sum = 0.0;
  var amp = 0.5;
  var px = x;
  var py = y;
  for i in 0..octaves {
    sum += amp * noise(px, py);
    px = px * 2.0 + 17.0;
    py = py * 2.0 + 31.0;
    amp *= 0.5;
  }
  return sum;
}
`;
