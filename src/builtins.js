// Built-in functions known to the compiler.
//
// INTRINSICS compile to inline WebAssembly instructions.
// IMPORTS are provided by the host (browser or Node) at instantiation time.
// SPECIAL builtins have custom type rules (variadic print, generic select, len).

const F = 'float';
const I = 'int';
const B = 'bool';
const S = 'str';

export const INTRINSICS = {
  sqrt: [[[F], F]],
  floor: [[[F], F]],
  ceil: [[[F], F]],
  trunc: [[[F], F]],
  round: [[[F], F]],
  abs: [[[F], F], [[I], I]],
  min: [[[F, F], F], [[I, I], I]],
  max: [[[F, F], F], [[I, I], I]],
  clamp: [[[F, F, F], F], [[I, I, I], I]],
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
  __print_i: { params: [I], ret: 'void' },
  __print_f: { params: [F], ret: 'void' },
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
