// A 3x5 pixel font for ASCII 32..95. Each glyph is packed into 15 bits,
// row-major, most significant bit = top-left pixel.

const GLYPHS = {
  ' ': ['...', '...', '...', '...', '...'],
  '!': ['.X.', '.X.', '.X.', '...', '.X.'],
  '"': ['X.X', 'X.X', '...', '...', '...'],
  '#': ['X.X', 'XXX', 'X.X', 'XXX', 'X.X'],
  $: ['.XX', 'XX.', '.X.', '.XX', 'XX.'],
  '%': ['X.X', '..X', '.X.', 'X..', 'X.X'],
  '&': ['.X.', 'X.X', '.X.', 'X.X', '.XX'],
  "'": ['.X.', '.X.', '...', '...', '...'],
  '(': ['..X', '.X.', '.X.', '.X.', '..X'],
  ')': ['X..', '.X.', '.X.', '.X.', 'X..'],
  '*': ['...', 'X.X', '.X.', 'X.X', '...'],
  '+': ['...', '.X.', 'XXX', '.X.', '...'],
  ',': ['...', '...', '...', '.X.', 'X..'],
  '-': ['...', '...', 'XXX', '...', '...'],
  '.': ['...', '...', '...', '...', '.X.'],
  '/': ['..X', '..X', '.X.', 'X..', 'X..'],
  0: ['XXX', 'X.X', 'X.X', 'X.X', 'XXX'],
  1: ['.X.', 'XX.', '.X.', '.X.', 'XXX'],
  2: ['XXX', '..X', 'XXX', 'X..', 'XXX'],
  3: ['XXX', '..X', '.XX', '..X', 'XXX'],
  4: ['X.X', 'X.X', 'XXX', '..X', '..X'],
  5: ['XXX', 'X..', 'XXX', '..X', 'XXX'],
  6: ['XXX', 'X..', 'XXX', 'X.X', 'XXX'],
  7: ['XXX', '..X', '..X', '.X.', '.X.'],
  8: ['XXX', 'X.X', 'XXX', 'X.X', 'XXX'],
  9: ['XXX', 'X.X', 'XXX', '..X', 'XXX'],
  ':': ['...', '.X.', '...', '.X.', '...'],
  ';': ['...', '.X.', '...', '.X.', 'X..'],
  '<': ['..X', '.X.', 'X..', '.X.', '..X'],
  '=': ['...', 'XXX', '...', 'XXX', '...'],
  '>': ['X..', '.X.', '..X', '.X.', 'X..'],
  '?': ['XXX', '..X', '.X.', '...', '.X.'],
  '@': ['.X.', 'X.X', 'X.X', 'X..', '.XX'],
  A: ['.X.', 'X.X', 'XXX', 'X.X', 'X.X'],
  B: ['XX.', 'X.X', 'XX.', 'X.X', 'XX.'],
  C: ['.XX', 'X..', 'X..', 'X..', '.XX'],
  D: ['XX.', 'X.X', 'X.X', 'X.X', 'XX.'],
  E: ['XXX', 'X..', 'XX.', 'X..', 'XXX'],
  F: ['XXX', 'X..', 'XX.', 'X..', 'X..'],
  G: ['.XX', 'X..', 'X.X', 'X.X', '.XX'],
  H: ['X.X', 'X.X', 'XXX', 'X.X', 'X.X'],
  I: ['XXX', '.X.', '.X.', '.X.', 'XXX'],
  J: ['..X', '..X', '..X', 'X.X', '.X.'],
  K: ['X.X', 'X.X', 'XX.', 'X.X', 'X.X'],
  L: ['X..', 'X..', 'X..', 'X..', 'XXX'],
  M: ['X.X', 'XXX', 'XXX', 'X.X', 'X.X'],
  N: ['XX.', 'X.X', 'X.X', 'X.X', 'X.X'],
  O: ['.X.', 'X.X', 'X.X', 'X.X', '.X.'],
  P: ['XX.', 'X.X', 'XX.', 'X..', 'X..'],
  Q: ['.X.', 'X.X', 'X.X', 'XX.', '.XX'],
  R: ['XX.', 'X.X', 'XX.', 'X.X', 'X.X'],
  S: ['.XX', 'X..', '.X.', '..X', 'XX.'],
  T: ['XXX', '.X.', '.X.', '.X.', '.X.'],
  U: ['X.X', 'X.X', 'X.X', 'X.X', 'XXX'],
  V: ['X.X', 'X.X', 'X.X', 'X.X', '.X.'],
  W: ['X.X', 'X.X', 'XXX', 'XXX', 'X.X'],
  X: ['X.X', 'X.X', '.X.', 'X.X', 'X.X'],
  Y: ['X.X', 'X.X', '.X.', '.X.', '.X.'],
  Z: ['XXX', '..X', '.X.', 'X..', 'XXX'],
  '[': ['XX.', 'X..', 'X..', 'X..', 'XX.'],
  '\\': ['X..', 'X..', '.X.', '..X', '..X'],
  ']': ['.XX', '..X', '..X', '..X', '.XX'],
  '^': ['.X.', 'X.X', '...', '...', '...'],
  _: ['...', '...', '...', '...', 'XXX'],
};

export function packedFont() {
  const out = [];
  for (let code = 32; code <= 95; code++) {
    const rows = GLYPHS[String.fromCharCode(code)];
    if (!rows) throw new Error(`missing glyph for ${String.fromCharCode(code)}`);
    let bits = 0;
    rows.forEach((row, r) => {
      for (let c = 0; c < 3; c++) if (row[c] === 'X') bits |= 1 << (14 - (r * 3 + c));
    });
    out.push(bits);
  }
  return out;
}
