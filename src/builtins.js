// Built-in functions known to the compiler.
//
// INTRINSICS compile to inline WebAssembly instructions.
// IMPORTS are provided by the host (browser or Node) at instantiation time.
// SPECIAL builtins have custom type rules (variadic print, generic select, len).

const F = 'float';
const I = 'int';
const B = 'bool';
const S = 'str';
const F4 = 'f32x4';
const I4 = 'i32x4';
const B4 = 'boolx4';
const F2 = 'f64x2';
const B2 = 'boolx2';

// Each entry lists overloads: [[param types], result]. The vector versions
// work lane by lane; a scalar argument next to vectors fills all four lanes.
export const INTRINSICS = {
  sqrt: [[[F], F], [[F4], F4], [[F2], F2]],
  floor: [[[F], F], [[F4], F4], [[F2], F2]],
  ceil: [[[F], F], [[F4], F4], [[F2], F2]],
  trunc: [[[F], F], [[F4], F4], [[F2], F2]],
  round: [[[F], F], [[F4], F4], [[F2], F2]],
  abs: [[[F], F], [[I], I], [[F4], F4], [[I4], I4], [[F2], F2]],
  min: [[[F, F], F], [[I, I], I], [[F4, F4], F4], [[F4, F], F4], [[I4, I4], I4], [[I4, I], I4], [[F2, F2], F2], [[F2, F], F2]],
  max: [[[F, F], F], [[I, I], I], [[F4, F4], F4], [[F4, F], F4], [[I4, I4], I4], [[I4, I], I4], [[F2, F2], F2], [[F2, F], F2]],
  clamp: [[[F, F, F], F], [[I, I, I], I], [[F4, F4, F4], F4], [[F4, F, F], F4], [[I4, I4, I4], I4], [[I4, I, I], I4],
    [[F2, F2, F2], F2], [[F2, F, F], F2]],
  any: [[[B4], B], [[B2], B]],
  all: [[[B4], B], [[B2], B]],
  // Reinterpret the same 128 bits: an f32x4's IEEE 754 bit patterns as ints, and back.
  to_bits: [[[F4], I4]],
  from_bits: [[[I4], F4]],
};

// Host imports. Names starting with "__" are internal and can't be called directly.
export const IMPORTS = {
  sin: { params: [F], ret: F },
  cos: { params: [F], ret: F },
  tan: { params: [F], ret: F },
  asin: { params: [F], ret: F },
  acos: { params: [F], ret: F },
  atan: { params: [F], ret: F },
  exp: { params: [F], ret: F },
  log: { params: [F], ret: F },
  atan2: { params: [F, F], ret: F },
  pow: { params: [F, F], ret: F },
  rand: { params: [], ret: F },
  mouse_x: { params: [], ret: I },
  mouse_y: { params: [], ret: I },
  mouse_down: { params: [], ret: B },
  key_down: { params: [I], ret: B },
  now: { params: [], ret: F },
  sample_rate: { params: [], ret: F },
  __print_i: { params: [I], ret: 'void' },
  __print_f: { params: [F], ret: 'void' },
  __print_f32: { params: [F], ret: 'void' },
  __print_b: { params: [B], ret: 'void' },
  __print_s: { params: [S], ret: 'void' },
  __print_end: { params: [], ret: 'void' },
  __trap: { params: [I, I], ret: 'void' },
  __sound: { params: [F, I, F, F, F, F], ret: 'void' },
};

export const SPECIAL = new Set(['print', 'select', 'len']);

// Pure builtins that may be evaluated at compile time.
export const FOLDABLE = {
  sqrt: Math.sqrt,
  floor: Math.floor,
  ceil: Math.ceil,
  trunc: Math.trunc,
  round: nearest,
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
};

/** f64.nearest semantics: round half to even. */
export function nearest(x) {
  if (!Number.isFinite(x)) return x;
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

export function isBuiltinName(name) {
  return name in INTRINSICS || (name in IMPORTS && !name.startsWith('__')) || SPECIAL.has(name);
}

export function signatureText(name, params, ret) {
  return `${name}(${params.join(', ')})${ret && ret !== 'void' ? ' -> ' + ret : ''}`;
}
