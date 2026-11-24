// WebAssembly binary format helpers: LEB128, sections, and the opcode table.
// Reference: https://webassembly.github.io/spec/core/binary/

export const I32 = 0x7f;
export const F64 = 0x7c;
export const VOID_BLOCK = 0x40;

export const valType = (t) => (t === 'float' ? F64 : I32);
export const valTypeName = (vt) => (vt === F64 ? 'f64' : 'i32');

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
  'i32.trunc_sat_f64_s': [0xfc, 0x02],
};

/** WAT spelling of an f64 constant. */
export function f64Text(x) {
  if (Number.isNaN(x)) return 'nan';
  if (x === Infinity) return 'inf';
  if (x === -Infinity) return '-inf';
  if (Object.is(x, -0)) return '-0';
  return String(x);
}
