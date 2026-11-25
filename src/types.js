// Value types.
//
// Scalars are the strings 'int' | 'float' | 'bool' | 'str'. A struct type is
// its declaration symbol: { kind: 'struct', name, fields: [{ name, type }] }.
//
// Structs are flattened: a value of struct type is just its scalar "leaves" in
// field order. A Vec3 local is three wasm locals, a Vec3 parameter is three
// wasm parameters, and a function returning a Vec3 returns three values.

export const isStruct = (t) => typeof t === 'object' && t !== null && t.kind === 'struct';

export const scalarSize = (t) => (t === 'float' ? 8 : 4);

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

/** 'float' if every leaf is a float, 'int' if every leaf is an int, else null. */
export function numericKind(t) {
  if (!isStruct(t)) return null;
  const ls = t.leafTypes;
  if (ls.every((l) => l === 'float')) return 'float';
  if (ls.every((l) => l === 'int')) return 'int';
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
