// Value types.
//
// Scalars are the strings 'int' | 'float' | 'bool' | 'str'. A struct type is
// its declaration symbol: { kind: 'struct', name, fields: [{ name, type }] }.
//
// SIMD vectors are the strings 'f32x4' | 'i32x4' | 'boolx4': four lanes in
// one 128-bit wasm value (v128). A vector is a single leaf, like a scalar.
// Lanes of an f32x4 are 32-bit floats; reading one gives a (64-bit) float.
// A boolx4 is the mask a vector comparison produces: each lane is all ones
// (true) or all zeros (false).
//
// Structs are flattened: a value of struct type is just its scalar "leaves" in
// field order. A Vec3 local is three wasm locals, a Vec3 parameter is three
// wasm parameters, and a function returning a Vec3 returns three values.

export const isStruct = (t) => typeof t === 'object' && t !== null && t.kind === 'struct';

export const VECTORS = ['f32x4', 'i32x4', 'boolx4'];
export const isVector = (t) => t === 'f32x4' || t === 'i32x4' || t === 'boolx4';
export const LANES = 4;
export const LANE_NAMES = ['x', 'y', 'z', 'w'];

/** The scalar type of one lane: f32x4 -> float, i32x4 -> int, boolx4 -> bool. */
export const laneType = (v) => (v === 'f32x4' ? 'float' : v === 'i32x4' ? 'int' : 'bool');

/** The vector whose lanes are `t`: float -> f32x4, int -> i32x4, bool -> boolx4. */
export const vectorOf = (t) => (t === 'float' ? 'f32x4' : t === 'int' ? 'i32x4' : t === 'bool' ? 'boolx4' : null);

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
 * 'int', 'f32x4' or 'i32x4'. Null for mixed structs (component-wise math
 * isn't defined for them).
 */
export function numericKind(t) {
  if (!isStruct(t)) return null;
  const ls = t.leafTypes;
  for (const k of ['float', 'int', 'f32x4', 'i32x4']) if (ls.every((l) => l === k)) return k;
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
