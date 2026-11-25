// Value types.
//
// Scalars are the strings 'int' | 'float' | 'bool' | 'str'. A struct type is
// its declaration symbol: { kind: 'struct', name, fields: [{ name, type }] }.
//
// SIMD vectors are the strings 'f32x4' | 'i32x4' | 'boolx4' | 'f64x2' |
// 'boolx2': lanes in one 128-bit wasm value (v128). A vector is a single
// leaf, like a scalar. Lanes of an f32x4 are 32-bit floats; reading one gives
// a (64-bit) float. boolx4 and boolx2 are the masks vector comparisons
// produce: each lane is all ones (true) or all zeros (false).
//
// Structs are flattened: a value of struct type is just its scalar "leaves" in
// field order. A Vec3 local is three wasm locals, a Vec3 parameter is three
// wasm parameters, and a function returning a Vec3 returns three values.

export const isStruct = (t) => typeof t === 'object' && t !== null && t.kind === 'struct';

// lane: the Kiln type of one lane; n: how many; shape: the wasm instruction
// family that works on it; mask: what comparing two of them gives.
const VECTOR_INFO = {
  f32x4: { lane: 'float', n: 4, shape: 'f32x4', mask: 'boolx4' },
  i32x4: { lane: 'int', n: 4, shape: 'i32x4', mask: 'boolx4' },
  boolx4: { lane: 'bool', n: 4, shape: 'i32x4', mask: 'boolx4' },
  f64x2: { lane: 'float', n: 2, shape: 'f64x2', mask: 'boolx2' },
  boolx2: { lane: 'bool', n: 2, shape: 'i64x2', mask: 'boolx2' },
};
export const VECTORS = Object.keys(VECTOR_INFO);
export const isVector = (t) => typeof t === 'string' && Object.hasOwn(VECTOR_INFO, t);
export const isMask = (t) => t === 'boolx4' || t === 'boolx2';
export const LANE_NAMES = ['x', 'y', 'z', 'w'];

/** The scalar type of one lane: f32x4 and f64x2 -> float, i32x4 -> int, masks -> bool. */
export const laneType = (v) => VECTOR_INFO[v].lane;
export const laneCount = (v) => VECTOR_INFO[v].n;
export const laneNames = (v) => LANE_NAMES.slice(0, laneCount(v));
/** The wasm lane interpretation: f32x4, i32x4, f64x2 or i64x2 (for boolx2). */
export const shapeOf = (v) => VECTOR_INFO[v].shape;
/** What a comparison of two `v`s gives: boolx4 or boolx2. */
export const maskOf = (v) => VECTOR_INFO[v].mask;

/** The vector with `n` lanes of type `t` (float with 4 lanes -> f32x4), or null. */
export const vectorOf = (t, n = 4) => VECTORS.find((v) => VECTOR_INFO[v].lane === t && VECTOR_INFO[v].n === n) ?? null;

export const scalarSize = (t) => (t === 'float' ? 8 : isVector(t) ? 16 : 4);

export function leafTypes(t) {
  if (isStruct(t)) return t.leafTypes;
  return t === 'void' ? [] : [t];
}

export function leafPaths(t) {
  return isStruct(t) ? t.leafPaths : [''];
}

export const leafCount = (t) => leafTypes(t).length;

export function sizeOf(t) {
  return isStruct(t) ? t.size : scalarSize(t);
}

export function alignOf(t) {
  return isStruct(t) ? t.align : scalarSize(t);
}

/**
 * The type every leaf of a struct shares, if it supports arithmetic: 'float',
 * 'int', 'f32x4', 'i32x4' or 'f64x2'. Null for mixed structs (component-wise math
 * isn't defined for them).
 */
export function numericKind(t) {
  if (!isStruct(t)) return null;
  const ls = t.leafTypes;
  for (const k of ['float', 'int', 'f32x4', 'i32x4', 'f64x2']) if (ls.every((l) => l === k)) return k;
  return null;
}

/** Compute leaves and the in-memory layout of a struct whose field types are resolved. */
export function layoutStruct(s) {
  s.leafTypes = [];
  s.leafPaths = [];
  s.leafOffsets = [];
  s.fieldLeaf = [];
  s.fieldOffset = [];
  let off = 0;
  let align = 4;
  for (const f of s.fields) {
    const a = alignOf(f.type);
    off = Math.ceil(off / a) * a;
    s.fieldLeaf.push(s.leafTypes.length);
    s.fieldOffset.push(off);
    if (isStruct(f.type)) {
      s.leafTypes.push(...f.type.leafTypes);
      s.leafPaths.push(...f.type.leafPaths.map((p) => `${f.name}.${p}`));
      s.leafOffsets.push(...f.type.leafOffsets.map((o) => off + o));
    } else {
      s.leafTypes.push(f.type);
      s.leafPaths.push(f.name);
      s.leafOffsets.push(off);
    }
    off += sizeOf(f.type);
    align = Math.max(align, a);
  }
  s.align = align;
  s.size = Math.ceil(off / align) * align;
}
