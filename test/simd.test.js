import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile } from '../src/compiler.js';
import { formatF32, formatFloat } from '../src/runtime.js';
import { readFileSync } from 'node:fs';
import { run, out, errors } from './helpers.js';

const f32 = Math.fround;
const has = (list, re) => assert.ok(list.some((m) => re.test(m)), `expected an error matching ${re}, got:\n  ${list.join('\n  ')}`);

// ---------------------------------------------------------------------------
// Every vector operation, checked three ways: computed at run time by the
// SIMD instructions, folded at compile time by the checker, and computed here
// by an independent reference (rounding to f32 after every step for f32x4,
// plain doubles for f64x2).

const NAN = '0.0 / 0.0';
const INF = '1.0 / 0.0';
const INPUTS = {
  a: ['f32x4', [1.5, -2.25, 0.1, 3e38], ['1.5', '-2.25', '0.1', '3e38']],
  b: ['f32x4', [0.5, 4, -0.3, 2], ['0.5', '4.0', '-0.3', '2.0']],
  c: ['f32x4', [NaN, Infinity, -0, -7.75], [NAN, INF, '-0.0', '-7.75']],
  d: ['f32x4', [2.5, -2.5, 0.5, 1.5], ['2.5', '-2.5', '0.5', '1.5']],
  ia: ['i32x4', [7, -3, 2147483647, -2147483648], ['7', '-3', '2147483647', '-2147483647 - 1']],
  ib: ['i32x4', [2, 5, 1, -1], ['2', '5', '1', '-1']],
  ma: ['boolx4', [true, false, true, false], ['true', 'false', 'true', 'false']],
  mb: ['boolx4', [true, true, false, false], ['true', 'true', 'false', 'false']],
  e: ['f64x2', [0.1, -3.75], ['0.1', '-3.75']],
  f: ['f64x2', [1e300, 0.3], ['1e300', '0.3']],
  g: ['f64x2', [NaN, -0], [NAN, '-0.0']],
  h: ['f64x2', [2.5, -0.5], ['2.5', '-0.5']],
  na: ['boolx2', [true, false], ['true', 'false']],
  nb: ['boolx2', [true, true], ['true', 'true']],
};
const V = Object.fromEntries(Object.entries(INPUTS).map(([k, [type, lanes]]) => [k, { type, lanes: lanes.map((x) => (type === 'f32x4' ? f32(x) : x)) }]));

const F = (fn) => (x, y) => f32(fn(x, y));
const FOPS = {
  '+': F((x, y) => x + y), '-': F((x, y) => x - y), '*': F((x, y) => x * y), '/': F((x, y) => x / y),
  '%': (x, y) => f32(x - f32(Math.trunc(f32(x / y)) * y)),
};
const IOPS = {
  '+': (x, y) => (x + y) | 0, '-': (x, y) => (x - y) | 0, '*': Math.imul,
  '&': (x, y) => x & y, '|': (x, y) => x | y, '^': (x, y) => x ^ y,
  '<<': (x, s) => x << (s & 31), '>>': (x, s) => x >> (s & 31), '>>>': (x, s) => (x >>> (s & 31)) | 0,
};
const CMP = { '==': (x, y) => x === y, '!=': (x, y) => x !== y, '<': (x, y) => x < y, '<=': (x, y) => x <= y, '>': (x, y) => x > y, '>=': (x, y) => x >= y };
const nearest = (x) => (Math.abs(x % 1) === 0.5 ? 2 * Math.round(x / 2) : Math.round(x));
const satTrunc = (x) => (Number.isNaN(x) ? 0 : x >= 2147483647 ? 2147483647 : x <= -2147483648 ? -2147483648 : Math.trunc(x) | 0);

const view = new DataView(new ArrayBuffer(4));
const bitsOf = (x) => (view.setFloat32(0, x), view.getInt32(0));
const floatOf = (n) => (view.setInt32(0, n), view.getFloat32(0));
const map = (fn, ...vs) => [0, 1, 2, 3].map((i) => fn(...vs.map((v) => (Array.isArray(v) ? v[i] : v))));
const map2 = (fn, ...vs) => [0, 1].map((i) => fn(...vs.map((v) => (Array.isArray(v) ? v[i] : v))));
const DOPS = { '+': (x, y) => x + y, '-': (x, y) => x - y, '*': (x, y) => x * y, '/': (x, y) => x / y, '%': (x, y) => x - Math.trunc(x / y) * y };
const L = (k) => V[k].lanes;
const fv = (lanes) => `f32x4(${lanes.map(formatF32).join(', ')})`;
const iv = (lanes) => `i32x4(${lanes.join(', ')})`;
const bv = (lanes) => `boolx4(${lanes.join(', ')})`;
const dv = (lanes) => `f64x2(${lanes.map(formatFloat).join(', ')})`;
const b2 = (lanes) => `boolx2(${lanes.join(', ')})`;

// [expression with {x} placeholders, expected output]
const CASES = [
  ...['+', '-', '*', '/', '%'].flatMap((op) => [
    [`{a} ${op} {b}`, fv(map(FOPS[op], L('a'), L('b')))],
    [`{c} ${op} {a}`, fv(map(FOPS[op], L('c'), L('a')))],
    [`{b} ${op} 2.5`, fv(map(FOPS[op], L('b'), 2.5))],
    [`-1.0 ${op} {a}`, fv(map(FOPS[op], -1, L('a')))],
  ]),
  ...['==', '!=', '<', '<=', '>', '>='].flatMap((op) => [
    [`{a} ${op} {b}`, bv(map(CMP[op], L('a'), L('b')))],
    [`{c} ${op} {c}`, bv(map(CMP[op], L('c'), L('c')))],
    [`{ia} ${op} {ib}`, bv(map(CMP[op], L('ia'), L('ib')))],
    [`{ia} ${op} 2`, bv(map(CMP[op], L('ia'), 2))],
  ]),
  ...['+', '-', '*', '&', '|', '^'].flatMap((op) => [
    [`{ia} ${op} {ib}`, iv(map(IOPS[op], L('ia'), L('ib')))],
    [`3 ${op} {ia}`, iv(map(IOPS[op], 3, L('ia')))],
  ]),
  ...['<<', '>>', '>>>'].flatMap((op) => [3, 28, 33].map((n) => [`{ia} ${op} ${n}`, iv(map((x) => IOPS[op](x, n), L('ia')))])),
  ['-{a}', fv(map((x) => -x, L('a')))],
  ['-{ia}', iv(map((x) => -x | 0, L('ia')))],
  ['~{ia}', iv(map((x) => ~x, L('ia')))],
  ['!{ma}', bv(map((x) => !x, L('ma')))],
  ...['&', '|', '^'].map((op) => [`{ma} ${op} {mb}`, bv(map((x, y) => (op === '&' ? x && y : op === '|' ? x || y : x !== y), L('ma'), L('mb')))]),
  ['{ma} == {mb}', bv(map(CMP['=='], L('ma'), L('mb')))],
  ['{ma} != {mb}', bv(map(CMP['!='], L('ma'), L('mb')))],
  ['{ma} & true', bv(L('ma'))],
  ...['sqrt', 'floor', 'ceil', 'trunc', 'round', 'abs'].flatMap((fn) => {
    const ref = { sqrt: (x) => f32(Math.sqrt(x)), floor: Math.floor, ceil: Math.ceil, trunc: Math.trunc, round: nearest, abs: Math.abs }[fn];
    return ['a', 'b', 'c', 'd'].map((k) => [`${fn}({${k}})`, fv(map(ref, L(k)))]);
  }),
  ['min({a}, {b})', fv(map(Math.min, L('a'), L('b')))],
  ['max({a}, {c})', fv(map(Math.max, L('a'), L('c')))],
  ['min({a}, 1)', fv(map(Math.min, L('a'), 1))],
  ['clamp({a}, -1.0, 1.0)', fv(map((x) => Math.min(Math.max(x, -1), 1), L('a')))],
  ['clamp({b}, {d}, f32x4(1.0))', fv(map((x, lo) => Math.min(Math.max(x, lo), 1), L('b'), L('d')))],
  ['abs({ia})', iv(map((x) => Math.abs(x) | 0, L('ia')))],
  ['min({ia}, {ib})', iv(map(Math.min, L('ia'), L('ib')))],
  ['max({ia}, 0)', iv(map(Math.max, L('ia'), 0))],
  ['clamp({ia}, -5, 5)', iv(map((x) => Math.min(Math.max(x, -5), 5), L('ia')))],
  ['{a} as i32x4', iv(map(satTrunc, L('a')))],
  ['{c} as i32x4', iv(map(satTrunc, L('c')))],
  ['{ia} as f32x4', fv(map(f32, L('ia')))],
  ['{ma} as i32x4', iv(map((x) => +x, L('ma')))],
  ['{ma} as f32x4', fv(map((x) => +x, L('ma')))],
  ['{c} as boolx4', bv(map((x) => x !== 0, L('c')))],
  ['{ia} as boolx4', bv(map((x) => x !== 0, L('ia')))],
  ['any({ma})', 'true'],
  ['all({ma})', 'false'],
  ['all({ma} | !{ma})', 'true'],
  ['any({ma} & !{ma})', 'false'],
  ['select({ma}, {a}, {b})', fv(map((m, x, y) => (m ? x : y), L('ma'), L('a'), L('b')))],
  ['select({ma}, {ia}, 0)', iv(map((m, x) => (m ? x : 0), L('ma'), L('ia')))],
  ['select({a} < {b}, 1, -1.5)', fv(map((x, y) => (x < y ? 1 : -1.5), L('a'), L('b')))],
  ['select({ma}, {mb}, false)', bv(map((m, x) => m && x, L('ma'), L('mb')))],
  // a lane reads as a (64-bit) float holding the f32 value exactly
  ['{a}.x', formatFloat(L('a')[0])],
  ['{a}.w', formatFloat(L('a')[3])],
  ['{ia}.w', String(L('ia')[3])],
  ['{mb}.z', 'false'],
  ['({a} + {b}).z', formatFloat(FOPS['+'](L('a')[2], L('b')[2]))],
  ['f32x4(0.1, 1, -2.5, 1e-40)', fv([0.1, 1, -2.5, 1e-40].map(f32))],
  ['to_bits({a})', iv(map(bitsOf, L('a')))],
  ['to_bits({d})', iv(map(bitsOf, L('d')))],
  ['from_bits({ia})', fv(map(floatOf, L('ia')))], // includes a NaN pattern and -0.0
  ['from_bits({ib} << 23)', fv(map((x) => floatOf(x << 23), L('ib')))],
  ['to_bits(from_bits({ib}))', iv(L('ib'))],
  // f64x2: two doubles, no rounding to f32
  ...['+', '-', '*', '/', '%'].flatMap((op) => [
    [`{e} ${op} {f}`, dv(map2(DOPS[op], L('e'), L('f')))],
    [`{g} ${op} {e}`, dv(map2(DOPS[op], L('g'), L('e')))],
    [`{f} ${op} 2.5`, dv(map2(DOPS[op], L('f'), 2.5))],
    [`-1 ${op} {e}`, dv(map2(DOPS[op], -1, L('e')))],
  ]),
  ...['==', '!=', '<', '<=', '>', '>='].flatMap((op) => [
    [`{e} ${op} {f}`, b2(map2(CMP[op], L('e'), L('f')))],
    [`{g} ${op} {g}`, b2(map2(CMP[op], L('g'), L('g')))],
    [`{h} ${op} 0.0`, b2(map2(CMP[op], L('h'), 0))],
  ]),
  ['-{e}', dv(map2((x) => -x, L('e')))],
  ...['sqrt', 'floor', 'ceil', 'trunc', 'round', 'abs'].flatMap((fn) => {
    const ref = { sqrt: Math.sqrt, floor: Math.floor, ceil: Math.ceil, trunc: Math.trunc, round: nearest, abs: Math.abs }[fn];
    return ['e', 'f', 'g', 'h'].map((k) => [`${fn}({${k}})`, dv(map2(ref, L(k)))]);
  }),
  ['min({e}, {f})', dv(map2(Math.min, L('e'), L('f')))],
  ['max({e}, {g})', dv(map2(Math.max, L('e'), L('g')))],
  ['min({f}, 1)', dv(map2(Math.min, L('f'), 1))],
  ['clamp({e}, -1.0, 1.0)', dv(map2((x) => Math.min(Math.max(x, -1), 1), L('e')))],
  ['clamp({f}, {e}, f64x2(0.2))', dv(map2((x, lo) => Math.min(Math.max(x, lo), 0.2), L('f'), L('e')))],
  ['{na} as f64x2', dv(map2((x) => +x, L('na')))],
  ['{g} as boolx2', b2(map2((x) => x !== 0, L('g')))],
  ['{e} as boolx2', b2(map2((x) => x !== 0, L('e')))],
  ...['&', '|', '^'].map((op) => [`{na} ${op} {nb}`, b2(map2((x, y) => (op === '&' ? x && y : op === '|' ? x || y : x !== y), L('na'), L('nb')))]),
  ['!{na}', b2(map2((x) => !x, L('na')))],
  ['{na} == {nb}', b2(map2(CMP['=='], L('na'), L('nb')))],
  ['{na} != {nb}', b2(map2(CMP['!='], L('na'), L('nb')))],
  ['{nb} & false', b2([false, false])],
  ['any({na})', 'true'],
  ['all({na})', 'false'],
  ['all({nb})', 'true'],
  ['any({na} & !{na})', 'false'],
  ['select({na}, {e}, {f})', dv(map2((m, x, y) => (m ? x : y), L('na'), L('e'), L('f')))],
  ['select({e} < {f}, 1, -1)', dv(map2((x, y) => (x < y ? 1 : -1), L('e'), L('f')))],
  ['select({na}, {nb}, false)', b2(map2((m, x) => m && x, L('na'), L('nb')))],
  ['{e}.x', formatFloat(L('e')[0])],
  ['{f}.y', formatFloat(L('f')[1])],
  ['{na}.y', 'false'],
  ['({e} * {f}).x', formatFloat(L('e')[0] * L('f')[0])],
  ['f64x2(0.1, 1e-310)', dv([0.1, 1e-310])],
  ['f64x2(7)', dv([7, 7])],
  ['i32x4(9)', iv([9, 9, 9, 9])],
];

function program(folded) {
  const name = (k) => (folded ? k.toUpperCase() : k);
  const decl = Object.entries(INPUTS).map(([k, [type, , src]]) => `let ${name(k)} = ${type}(${src.join(', ')});`);
  const body = CASES.map(([e]) => `  print(${e.replace(/\{(\w+)\}/g, (_, k) => name(k))});`);
  return folded ? `${decl.join('\n')}\nfn main() {\n${body.join('\n')}\n}` : `fn main() {\n  ${decl.join('\n  ')}\n${body.join('\n')}\n}`;
}

test('every vector operation matches an f32 reference, at run time and when folded', async () => {
  const expected = CASES.map(([, want]) => want);
  const runtime = await run(program(false));
  const folded = await run(program(true));
  CASES.forEach(([e], i) => {
    assert.equal(runtime[i], expected[i], `run time: ${e}`);
    assert.equal(folded[i], expected[i], `folded: ${e}`);
  });
});

test('the run-time program really uses SIMD instructions, and the folded one computes nothing', () => {
  const ops = /\b(f32x4|i32x4|f64x2|i64x2)\.(add|sub|mul|div|eq|ne|lt|le|gt|ge|min|max|abs|neg|sqrt|floor|ceil|trunc|nearest|shl|shr_s|shr_u|convert_i32x4_s|trunc_sat_f32x4_s|all_true)\b|v128\.(and|or|xor|not|bitselect|any_true)/;
  const lines = (src) => compile(src).wat.split('\n').filter((l) => ops.test(l)).length;
  assert.ok(lines(program(false)) > 150);
  assert.equal(lines(program(true)), 0);
});

// ---------------------------------------------------------------------------
// Where vectors can live

test('lanes can be read and written in locals, globals, struct fields and array elements', async () => {
  const src = `
    struct Particle { pos: f32x4, alive: boolx4, n: int }
    var g = f32x4(1.0, 2.0, 3.0, 4.0);
    var ps: [Particle; 3];
    var counts: [i32x4; 4];
    fn main() {
      var v = f32x4(0.0);
      v.y = 2.5;
      v.w += 1.0;
      g.x *= 10.0;
      ps[1].pos.z = 7.0;
      ps[1].pos += 0.5;
      ps[1].alive.y = true;
      let i = 2;
      counts[i] = i32x4(1, 2, 3, 4);
      counts[i] += 10;
      counts[i].w -= 100;
      counts[i] <<= 1;
      print(v, g);
      print(ps[1], ps[0].pos.x, ps[1].alive.y, ps[1].alive.x);
      print(counts[i], counts[0], len(counts));
    }`;
  assert.deepEqual(await run(src), [
    'f32x4(0.0, 2.5, 0.0, 1.0) f32x4(10.0, 2.0, 3.0, 4.0)',
    'Particle(f32x4(0.5, 0.5, 7.5, 0.5), boolx4(false, true, false, false), 0) 0.0 true false',
    'i32x4(22, 24, 26, -172) i32x4(0, 0, 0, 0) 4',
  ]);
});

test('vectors pass through functions, methods and operators, and get inlined', async () => {
  const src = `
    struct C4 { re: f32x4, im: f32x4 }
    impl C4 {
      fn *(self, o: C4) -> C4 { return C4(self.re * o.re - self.im * o.im, self.re * o.im + self.im * o.re); }
      fn abs2(self) -> f32x4 { return self.re * self.re + self.im * self.im; }
    }
    fn swap(v: i32x4) -> i32x4 { return i32x4(v.w, v.z, v.y, v.x); }
    fn main() {
      let i = C4(f32x4(0.0), f32x4(1.0));
      let z = C4(f32x4(1.0, 2.0, 0.0, -1.0), f32x4(0.5));
      print(i * i);
      print((z * z + z).abs2(), z == z, z != C4(z.re, z.re), -z);
      print(swap(i32x4(1, 2, 3, 4)), z * 2.0, 3 * z);
    }`;
  assert.deepEqual(await run(src), [
    'C4(f32x4(-1.0, -1.0, -1.0, -1.0), f32x4(0.0, 0.0, 0.0, 0.0))',
    // z*z + z = (1.75 + 1.5i, 5.75 + 2.5i, -0.25 + 0.5i, -0.25 - 0.5i); -0.0 prints as 0.0, like a float
    'f32x4(5.3125, 39.3125, 0.3125, 0.3125) true true C4(f32x4(-1.0, -2.0, 0.0, 1.0), f32x4(-0.5, -0.5, -0.5, -0.5))',
    'i32x4(4, 3, 2, 1) C4(f32x4(2.0, 4.0, 0.0, -2.0), f32x4(1.0, 1.0, 1.0, 1.0)) C4(f32x4(3.0, 6.0, 0.0, -3.0), f32x4(1.5, 1.5, 1.5, 1.5))',
  ]);
  const r = compile(src);
  assert.match(r.wat, /;; inlined C4\.op\*/);
  assert.match(r.wat, /\(local \$i\.re v128\) \(local \$i\.im v128\)/);
});

test('var self methods update lanes of the receiver; ternaries and masks choose whole vectors or lanes', async () => {
  const src = `
    struct Body { pos: f32x4, vel: f32x4 }
    impl Body {
      fn step(var self, dt: float) { self.pos += self.vel * dt; self.pos.w = 1.0; }
      fn speed2(self) -> float { let v = self.vel * self.vel; return v.x + v.y + v.z; }
    }
    var bodies: [Body; 2];
    fn pick(flag: bool, a: f32x4, b: f32x4) -> f32x4 { return flag ? a : b; }
    fn main() {
      bodies[1] = Body(f32x4(0.0), f32x4(1.0, 2.0, 2.0, 0.0));
      bodies[1].step(0.5);
      bodies[1].step(0.5);
      print(bodies[1].pos, bodies[1].speed2());
      print(pick(true, f32x4(1.0), f32x4(2.0)), pick(false, f32x4(1.0), f32x4(2.0)));
      var m = boolx4(false);
      m.z = true;
      print(m, select(m, i32x4(7), i32x4(-7)), all(!m | m));
    }`;
  assert.deepEqual(await run(src), [
    'f32x4(1.0, 2.0, 2.0, 1.0) 9.0',
    'f32x4(1.0, 1.0, 1.0, 1.0) f32x4(2.0, 2.0, 2.0, 2.0)',
    'boolx4(false, false, true, false) i32x4(-7, -7, 7, -7) true',
  ]);
});

test('top-level constants, globals and arrays of vectors are initialized at compile time', async () => {
  const src = `
    let LANES = f32x4(0.0, 1.0, 2.0, 3.0);
    let STEP = LANES * 0.25 + 1.0;
    var mask = LANES > 1.5;
    let table = [i32x4(1, 2, 3, 4), i32x4(-1)];
    struct Box { lo: f32x4, hi: f32x4 }
    var box = Box(f32x4(-1.0), f32x4(1.0));
    fn main() { print(STEP, mask, table[0] + table[1], box, STEP.w); }`;
  assert.deepEqual(await run(src), ['f32x4(1.0, 1.25, 1.5, 1.75) boolx4(false, false, true, true) i32x4(0, 1, 2, 3) Box(f32x4(-1.0, -1.0, -1.0, -1.0), f32x4(1.0, 1.0, 1.0, 1.0)) 1.75']);
  const wat = compile(src).wat;
  assert.match(wat, /\(global \$mask \(mut v128\) \(v128\.const i32x4 0 0 -1 -1\)\)/);
  assert.match(wat, /\(global \$box\.lo \(mut v128\) \(v128\.const f32x4 -1 -1 -1 -1\)\)/);
});

test('f64x2 structs, lanes and masks work like their four-lane cousins, in double precision', async () => {
  const src = `
    struct C2 { re: f64x2, im: f64x2 }
    impl C2 {
      fn *(self, o: C2) -> C2 { return C2(self.re * o.re - self.im * o.im, self.re * o.im + self.im * o.re); }
      fn abs2(self) -> f64x2 { return self.re * self.re + self.im * self.im; }
    }
    var cs: [C2; 2];
    var tiny = f64x2(1e-9, 1e-12);
    fn main() {
      let z = C2(f64x2(1.0, 0.5), f64x2(2.0, -1.0));
      cs[1] = z * z + z;
      cs[1].im.y = 3.0;
      print(cs[1], cs[1].abs2(), z == z, -z);
      // 1 + 1e-9 survives in f64; in f32 it would round to 1
      let w = f64x2(1.0) + tiny;
      print(w.x - 1.0 > 0.0, (f32x4(1.0) + 0.000000001).x - 1.0 > 0.0);
      var count = f64x2(0.0);
      for i in 0..5 { count += (f64x2(1.0, 3.0) > i as float) as f64x2; }
      print(count);
    }`;
  assert.deepEqual(await run(src), [
    'C2(f64x2(-2.0, -0.25), f64x2(6.0, 3.0)) f64x2(40.0, 9.0625) true C2(f64x2(-1.0, -0.5), f64x2(-2.0, 1.0))',
    'true false',
    'f64x2(1.0, 3.0)',
  ]);
});

test('a mask counts iterations per lane: the 4-wide escape-time loop', async () => {
  // Four points of the Mandelbrot set at once, against a scalar f32 reference.
  const src = `
    fn main() {
      let cr = f32x4(-0.75, 0.3, -1.25, 0.0);
      let ci = f32x4(0.1, 0.5, 0.0, 1.0);
      var zr = f32x4(0.0);
      var zi = f32x4(0.0);
      var n = i32x4(0);
      for i in 0..200 {
        let inside = zr * zr + zi * zi < 4.0;
        if !any(inside) { break; }
        n += inside as i32x4;
        let t = zr * zr - zi * zi + cr;
        zi = select(inside, 2.0 * zr * zi + ci, zi);
        zr = select(inside, t, zr);
      }
      print(n);
    }`;
  const ref = (cr, ci) => {
    let zr = 0;
    let zi = 0;
    let n = 0;
    for (let i = 0; i < 200; i++) {
      if (!(f32(f32(zr * zr) + f32(zi * zi)) < 4)) break;
      n++;
      const t = f32(f32(f32(zr * zr) - f32(zi * zi)) + cr);
      zi = f32(f32(f32(2 * zr) * zi) + ci);
      zr = t;
    }
    return n;
  };
  const want = [[-0.75, 0.1], [0.3, 0.5], [-1.25, 0], [0, 1]].map(([r, i]) => ref(f32(r), f32(i)));
  assert.deepEqual(await run(src), [`i32x4(${want.join(', ')})`]);
});

test('vector code is identical with and without inlining', async () => {
  const src = `
    struct C4 { re: f32x4, im: f32x4 }
    impl C4 { fn *(self, o: C4) -> C4 { return C4(self.re * o.re - self.im * o.im, self.re * o.im + self.im * o.re); } }
    fn sq(v: f32x4) -> f32x4 { return v * v; }
    fn main() { let z = C4(f32x4(0.5, 1.5, -2.0, 3.0), f32x4(0.25)); print(z * z, sq(z.re), sq(f32x4(3.0)).y); }`;
  const go = async (inline) => {
    const r = compile(src, { inline });
    const { instantiate } = await import('../src/runtime.js');
    const lines = [];
    (await instantiate(r, { print: (l) => lines.push(l) })).main();
    return lines;
  };
  assert.deepEqual(await go(true), await go(false));
});

test('to_bits and from_bits reinterpret the same 128 bits, so they compile to nothing', () => {
  const src = `
    fn f(v: f32x4) -> i32x4 { return to_bits(v); }
    fn g(v: i32x4) -> f32x4 { return from_bits(v); }
    fn main() { print(f(f32x4(1.0)), g(i32x4(0))); }`;
  const r = compile(src, { inline: false });
  for (const [fn, name, V] of [['f', 'to_bits', 'i32x4'], ['g', 'from_bits', 'f32x4']]) {
    const start = r.wat.indexOf(`(func $${fn} `);
    const body = r.wat.slice(start, r.wat.indexOf('\n  )', start));
    const lines = body.split('\n').slice(1).map((l) => l.trim()).filter((l) => !l.startsWith(';; 2:') && !l.startsWith(';; 3:'));
    assert.deepEqual(lines, ['local.get $v', `;; ${name}: the same 128 bits, now read as ${V}`, 'return']);
  }
});

test("the julia example's bit-cast log2 is accurate to about 2e-5", async () => {
  // log2v reads the exponent out of the float's bits and uses a short series for the rest.
  const ex = readFileSync(new URL('../examples/julia.kiln', import.meta.url), 'utf8');
  const start = ex.indexOf('fn log2v');
  const log2v = ex.slice(start, ex.indexOf('\n}\n', start) + 3);
  const src = `${log2v}
    fn main() {
      var worst = 0.0;
      var x = 0.000001;
      while x < 1000000000000.0 {
        let v = f32x4(x, x * 1.17, x * 1.41, x * 1.73);
        let got = log2v(v);
        worst = max(worst, abs(got.x - log(v.x) / log(2.0)));
        worst = max(worst, abs(got.y - log(v.y) / log(2.0)));
        worst = max(worst, abs(got.z - log(v.z) / log(2.0)));
        worst = max(worst, abs(got.w - log(v.w) / log(2.0)));
        x *= 1.093;
      }
      print(worst < 0.00003, worst > 0.0);
    }`;
  assert.deepEqual(await run(src), ['true true']);
});

// ---------------------------------------------------------------------------
// Errors

test('vector errors explain what SIMD can and cannot do', () => {
  const e = (body, pre = '') => errors(`${pre}\nfn main() {\n${body}\n}`);
  has(e('let v = f32x4(1.0, 2.0);'), /'f32x4' takes 1 value \(for all four lanes\) or 4 values \(one per lane\), but 2 were given/);
  has(e('let v = f32x4(1.0); print(v.q);'), /f32x4 has no lane 'q'.*x, y, z and w/);
  has(e('let v = f32x4(1.0); print(v[0]);'), /can't index into an f32x4.*v\.x/);
  has(e('let v = i32x4(1); print(v / 2);'), /can't apply '\/' to i32x4 and int.*can't divide integer lanes/);
  has(e('let v = i32x4(1); let w = f32x4(1.0); print(v + w);'), /same kind of vector; convert with 'as i32x4'/);
  has(e('let v = f32x4(1.0); let n = 2; print(v * n);'), /combined with another f32x4 or with a float \(which fills all four lanes\), not an int/);
  has(e('let v = f32x4(1.0); if v < 2.0 { }'), /if condition must be a bool, found boolx4.*any\(mask\) or all\(mask\)/);
  has(e('let v = f32x4(1.0); let w = v < 2.0 ? v : v;'), /condition must be a bool, found boolx4.*select\(mask, a, b\)/);
  has(e('let m = f32x4(1.0) < 2.0; let k = m && m;'), /use '&' to combine masks lane by lane/);
  has(e('let v = i32x4(1); print(v << i32x4(2));'), /shifted by the same amount/);
  has(e('let v = f32x4(1.0); print(v & v);'), /'&' works on i32x4 and on masks/);
  has(e('let v = f32x4(1.0); print(v as float);'), /can't convert f32x4 to float.*read one lane with v\.x/);
  has(e('let x = 1.0; print(x as f32x4);'), /can't convert float to f32x4.*f32x4\(x\)/);
  has(e('let v = f32x4(1.0); print(select(true, v, v));'), /needs a mask to choose lane by lane/);
  has(e('print(any(true));'), /no version of 'any' takes \(bool\)/);
  has(e('print(to_bits(1.0));'), /no version of 'to_bits' takes \(float\).*to_bits\(f32x4\) -> i32x4/);
  has(e('let v = f64x2(1.0, 2.0, 3.0);'), /'f64x2' takes 1 value \(for all two lanes\) or 2 values \(one per lane\), but 3 were given/);
  has(e('let v = f64x2(1.0); print(v.z);'), /f64x2 has no lane 'z'.*its lanes are x and y/);
  has(e('let v = f64x2(1.0); print(v as f32x4);'), /can't convert f64x2 to f32x4.*f64x2 has 2 lanes and f32x4 has 4/);
  has(e('let v = f64x2(1.0); let w = f32x4(1.0); print(v + w);'), /same kind of vector/);
  has(e('let v = f64x2(1.0); print(select(f32x4(1.0) > 0.0, v, v));'), /a boolx4 mask chooses between values with 4 lanes, not f64x2/);
  has(e('let v = f64x2(1.0); print(v & v);'), /'&' works on i32x4 and on masks/);
  has(e('let v = f64x2(1.0); if v > 0.0 { }'), /if condition must be a bool, found boolx2.*any\(mask\) or all\(mask\)/);
  has(e('let v = f64x2(1.0); print(select(v > 0.0, true, 2));'), /must be the same vector type.*boolx2 mask chooses between f64x2 values or floats/);
  has(e('let v = f32x4(1.0); v.x = 2.0;'), /can't modify 'v.x' because 'v' is immutable/);
  has(e('', 'export fn f(v: f32x4) -> float { return v.x; }'), /exported function 'f' can't take or return SIMD vectors/);
  has(e('', 'struct f32x4 { a: int }'), /'f32x4' is a built-in type/);
  has(e('', 'struct P { v: i32x4 }\nfn d(p: P) -> P { return p / p; }'), /can't divide integer lanes/);
});
