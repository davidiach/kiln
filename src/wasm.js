// WebAssembly binary format helpers: LEB128, sections, and the opcode table.
// Reference: https://webassembly.github.io/spec/core/binary/

export const I32 = 0x7f;
export const F64 = 0x7c;
export const V128 = 0x7b;
export const VOID_BLOCK = 0x40;

const VECTOR_TYPES = new Set(['f32x4', 'i32x4', 'boolx4', 'v128']);
export const valType = (t) => (t === 'float' ? F64 : VECTOR_TYPES.has(t) ? V128 : I32);
export const valTypeName = (vt) => (vt === F64 ? 'f64' : vt === V128 ? 'v128' : 'i32');

const textEncoder = new TextEncoder();
const f64Scratch = new DataView(new ArrayBuffer(8));

export class ByteWriter {
  constructor() {
    this.bytes = [];
  }
  get length() {
    return this.bytes.length;
  }
  u8(b) {
    this.bytes.push(b & 0xff);
    return this;
  }
  raw(arr) {
    for (let i = 0; i < arr.length; i++) this.bytes.push(arr[i]);
    return this;
  }
  /** Unsigned LEB128. */
  u32(n) {
    n >>>= 0;
    do {
      let b = n & 0x7f;
      n >>>= 7;
      if (n !== 0) b |= 0x80;
      this.bytes.push(b);
    } while (n !== 0);
    return this;
  }
  /** Signed LEB128. */
  s32(n) {
    n |= 0;
    for (;;) {
      const b = n & 0x7f;
      n >>= 7;
      if ((n === 0 && (b & 0x40) === 0) || (n === -1 && (b & 0x40) !== 0)) {
        this.bytes.push(b);
        return this;
      }
      this.bytes.push(b | 0x80);
    }
  }
  f64(x) {
    f64Scratch.setFloat64(0, x, true);
    for (let i = 0; i < 8; i++) this.bytes.push(f64Scratch.getUint8(i));
    return this;
  }
  /** A v128 constant: four f32 lanes (`float`) or four i32 lanes. */
  v128(lanes, float) {
    for (const x of lanes) {
      if (float) f64Scratch.setFloat32(0, x, true);
      else f64Scratch.setInt32(0, x, true);
      for (let i = 0; i < 4; i++) this.bytes.push(f64Scratch.getUint8(i));
    }
    return this;
  }
  name(s) {
    const enc = textEncoder.encode(s);
    this.u32(enc.length);
    return this.raw(enc);
  }
  vec(items, fn) {
    this.u32(items.length);
    items.forEach((it, i) => fn(it, i));
    return this;
  }
  /** Append `inner` prefixed by its byte length. */
  sized(inner) {
    this.u32(inner.length);
    return this.raw(inner.bytes);
  }
  toUint8Array() {
    return Uint8Array.from(this.bytes);
  }
}

export const SECTION = {
  custom: 0, type: 1, import: 2, function: 3, table: 4, memory: 5, global: 6,
  export: 7, start: 8, element: 9, code: 10, data: 11,
};

// name -> [opcode bytes..., immediate kind?]
export const OPS = {
  unreachable: [0x00],
  nop: [0x01],
  block: [0x02, 'block'],
  loop: [0x03, 'block'],
  if: [0x04, 'block'],
  else: [0x05],
  end: [0x0b],
  br: [0x0c, 'label'],
  br_if: [0x0d, 'label'],
  return: [0x0f],
  call: [0x10, 'func'],
  drop: [0x1a],
  select: [0x1b],
  'local.get': [0x20, 'local'],
  'local.set': [0x21, 'local'],
  'local.tee': [0x22, 'local'],
  'global.get': [0x23, 'global'],
  'global.set': [0x24, 'global'],
  'i32.load': [0x28, 'mem'],
  'f64.load': [0x2b, 'mem'],
  'i32.load8_u': [0x2d, 'mem'],
  'i32.store': [0x36, 'mem'],
  'f64.store': [0x39, 'mem'],
  'i32.const': [0x41, 'i32'],
  'f64.const': [0x44, 'f64'],
  'i32.eqz': [0x45],
  'i32.eq': [0x46],
  'i32.ne': [0x47],
  'i32.lt_s': [0x48],
  'i32.lt_u': [0x49],
  'i32.gt_s': [0x4a],
  'i32.gt_u': [0x4b],
  'i32.le_s': [0x4c],
  'i32.le_u': [0x4d],
  'i32.ge_s': [0x4e],
  'i32.ge_u': [0x4f],
  'f64.eq': [0x61],
  'f64.ne': [0x62],
  'f64.lt': [0x63],
  'f64.gt': [0x64],
  'f64.le': [0x65],
  'f64.ge': [0x66],
  'i32.add': [0x6a],
  'i32.sub': [0x6b],
  'i32.mul': [0x6c],
  'i32.div_s': [0x6d],
  'i32.rem_s': [0x6f],
  'i32.and': [0x71],
  'i32.or': [0x72],
  'i32.xor': [0x73],
  'i32.shl': [0x74],
  'i32.shr_s': [0x75],
  'i32.shr_u': [0x76],
  'f64.abs': [0x99],
  'f64.neg': [0x9a],
  'f64.ceil': [0x9b],
  'f64.floor': [0x9c],
  'f64.trunc': [0x9d],
  'f64.nearest': [0x9e],
  'f64.sqrt': [0x9f],
  'f64.add': [0xa0],
  'f64.sub': [0xa1],
  'f64.mul': [0xa2],
  'f64.div': [0xa3],
  'f64.min': [0xa4],
  'f64.max': [0xa5],
  'f64.convert_i32_s': [0xb7],
  'f32.demote_f64': [0xb6],
  'f64.promote_f32': [0xbb],
  'i32.trunc_sat_f64_s': [0xfc, 0x02],
};

// SIMD (fixed-width 128-bit vectors): prefix 0xfd, then the opcode as a u32
// LEB128, then any immediates. Only the f32x4/i32x4 subset Kiln uses.
const simd = (op, imm) => {
  const bytes = [0xfd];
  let n = op;
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    bytes.push(b);
  } while (n);
  return imm ? [...bytes, imm] : bytes;
};
Object.assign(OPS, {
  'v128.load': simd(0x00, 'mem'),
  'v128.store': simd(0x0b, 'mem'),
  'v128.const': simd(0x0c, 'v128'),
  'i32x4.splat': simd(0x11),
  'f32x4.splat': simd(0x13),
  'i32x4.extract_lane': simd(0x1b, 'lane'),
  'i32x4.replace_lane': simd(0x1c, 'lane'),
  'f32x4.extract_lane': simd(0x1f, 'lane'),
  'f32x4.replace_lane': simd(0x20, 'lane'),
  'i32x4.eq': simd(0x37),
  'i32x4.ne': simd(0x38),
  'i32x4.lt_s': simd(0x39),
  'i32x4.gt_s': simd(0x3b),
  'i32x4.le_s': simd(0x3d),
  'i32x4.ge_s': simd(0x3f),
  'f32x4.eq': simd(0x41),
  'f32x4.ne': simd(0x42),
  'f32x4.lt': simd(0x43),
  'f32x4.gt': simd(0x44),
  'f32x4.le': simd(0x45),
  'f32x4.ge': simd(0x46),
  'v128.not': simd(0x4d),
  'v128.and': simd(0x4e),
  'v128.or': simd(0x50),
  'v128.xor': simd(0x51),
  'v128.bitselect': simd(0x52),
  'v128.any_true': simd(0x53),
  'f32x4.ceil': simd(0x67),
  'f32x4.floor': simd(0x68),
  'f32x4.trunc': simd(0x69),
  'f32x4.nearest': simd(0x6a),
  'i32x4.abs': simd(0xa0),
  'i32x4.neg': simd(0xa1),
  'i32x4.all_true': simd(0xa3),
  'i32x4.shl': simd(0xab),
  'i32x4.shr_s': simd(0xac),
  'i32x4.shr_u': simd(0xad),
  'i32x4.add': simd(0xae),
  'i32x4.sub': simd(0xb1),
  'i32x4.mul': simd(0xb5),
  'i32x4.min_s': simd(0xb6),
  'i32x4.max_s': simd(0xb8),
  'f32x4.abs': simd(0xe0),
  'f32x4.neg': simd(0xe1),
  'f32x4.sqrt': simd(0xe3),
  'f32x4.add': simd(0xe4),
  'f32x4.sub': simd(0xe5),
  'f32x4.mul': simd(0xe6),
  'f32x4.div': simd(0xe7),
  'f32x4.min': simd(0xe8),
  'f32x4.max': simd(0xe9),
  'i32x4.trunc_sat_f32x4_s': simd(0xf8),
  'f32x4.convert_i32x4_s': simd(0xfa),
});

/** WAT spelling of an f64 constant. */
export function f64Text(x) {
  if (Number.isNaN(x)) return 'nan';
  if (x === Infinity) return 'inf';
  if (x === -Infinity) return '-inf';
  if (Object.is(x, -0)) return '-0';
  return String(x);
}
