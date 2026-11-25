import { test } from 'node:test';
import assert from 'node:assert/strict';
import { out, run, errors } from './helpers.js';
import { compile } from '../src/compiler.js';

const COMPLEX = `
struct Complex { re: float, im: float }
impl Complex {
  fn *(self, o: Complex) -> Complex {
    return Complex(self.re * o.re - self.im * o.im, self.re * o.im + self.im * o.re);
  }
  fn *(self, k: float) -> Complex { return Complex(self.re * k, self.im * k); }
  fn *(k: float, z: Complex) -> Complex { return Complex(z.re * k, z.im * k); }
  fn -(self) -> Complex { return Complex(-self.re, -self.im); }
  fn abs2(self) -> float { return self.re * self.re + self.im * self.im; }
}`;

const has = (list, re) => assert.ok(list.some((m) => re.test(m)), `expected an error matching ${re}, got:\n  ${list.join('\n  ')}`);

test('user operators replace component-wise math where defined', async () => {
  // i * i = -1 (component-wise multiplication would have given (0, 1))
  assert.equal(await out('let i = Complex(0.0, 1.0); print(i * i, Complex(1.0, 2.0) * Complex(3.0, 4.0));', COMPLEX), 'Complex(-1.0, 0.0) Complex(-5.0, 10.0)');
});

test('anything not defined falls back to the built-in rules', async () => {
  assert.equal(await out('let a = Complex(1.0, 2.0); print(a + a, a - a, a == Complex(1.0, 2.0), a / 2.0);', COMPLEX), 'Complex(2.0, 4.0) Complex(0.0, 0.0) true Complex(0.5, 1.0)');
});

test('operators overload by operand type, with the scalar on either side', async () => {
  assert.equal(await out('let z = Complex(1.0, 2.0); print(z * 3.0, 3.0 * z, z * 2, 2 * z);', COMPLEX), 'Complex(3.0, 6.0) Complex(3.0, 6.0) Complex(2.0, 4.0) Complex(2.0, 4.0)');
});

test('unary minus and compound assignment use the operators too', async () => {
  assert.equal(await out('var z = Complex(1.0, 1.0); print(-z); z *= z; print(z); z *= 0.5; print(z);', COMPLEX), 'Complex(-1.0, -1.0)\nComplex(0.0, 2.0)\nComplex(0.0, 1.0)');
});

test('the Mandelbrot step reads like the math: z = z * z + c', async () => {
  const src = `${COMPLEX}
    fn escapes(c: Complex) -> int {
      var z = Complex(0.0, 0.0);
      for i in 0..50 {
        z = z * z + c;
        if z.abs2() > 4.0 { return i; }
      }
      return -1;
    }
    fn main() { print(escapes(Complex(0.0, 0.0)), escapes(Complex(1.0, 1.0)), escapes(Complex(-0.75, 0.2))); }`;
  assert.deepEqual(await run(src), ['-1 1 15']); // matches a plain JavaScript reference implementation
});

test('== can be defined, and != is derived from it', async () => {
  const src = `
    struct Ratio { n: int, d: int }
    impl Ratio { fn ==(self, o: Ratio) -> bool { return self.n * o.d == o.n * self.d; } }
    fn main() { let a = Ratio(1, 2); print(a == Ratio(2, 4), a != Ratio(2, 4), a == Ratio(1, 3), a != Ratio(1, 3)); }`;
  assert.deepEqual(await run(src), ['true false false true']);
});

test('< gives > <= >= too, evaluating operands left to right', async () => {
  const src = `
    struct Card { rank: int }
    impl Card { fn <(self, o: Card) -> bool { return self.rank < o.rank; } }
    fn card(r: int) -> Card { print("card", r); return Card(r); }
    fn main() {
      let a = Card(2);
      let b = Card(9);
      print(a < b, a > b, a <= b, a >= b, b <= b, b >= b);
      print(card(1) > card(2));
    }`;
  assert.deepEqual(await run(src), ['true false true false true true', 'card 1', 'card 2', 'false']);
});

test('an operator defined directly wins over a derived one', async () => {
  const src = `
    struct T { v: int }
    impl T {
      fn <(self, o: T) -> bool { return self.v < o.v; }
      fn >(self, o: T) -> bool { print("custom >"); return self.v > o.v; }
    }
    fn main() { print(T(3) > T(1)); }`;
  assert.deepEqual(await run(src), ['custom >', 'true']);
});

test('operators on structs that have no built-in arithmetic', async () => {
  const src = `
    struct Money { cents: int, currency: str }
    impl Money {
      fn +(self, o: Money) -> Money { return Money(self.cents + o.cents, self.currency); }
      fn <(self, o: Money) -> bool { return self.cents < o.cents; }
    }
    fn main() { var m = Money(150, "EUR"); m += Money(275, "EUR"); print(m, m > Money(400, "EUR")); }`;
  assert.deepEqual(await run(src), ['Money(425, EUR) true']);
});

test('operators compile to functions named Type.op<symbol>', () => {
  const r = compile(`${COMPLEX} fn main() { let z = Complex(1.0, 2.0); print(z * z, z * 2.0); }`, { inline: false });
  assert.ok(r.ok);
  assert.match(r.wat, /\(func \$Complex\.op\* \(param \$self\.re f64\) \(param \$self\.im f64\) \(param \$o\.re f64\) \(param \$o\.im f64\) \(result f64 f64\)/);
  assert.match(r.wat, /\(func \$Complex\.op\*_2 /);
  assert.doesNotMatch(r.wat, /\$Complex\.op\*_3/, 'the unused float * Complex overload is stripped');
});

test('operator errors', () => {
  const e = (impl, main = '') => errors(`struct C { re: float, im: float }\nimpl C {\n${impl}\n}\nfn main() { ${main} }`);
  has(e('fn +(var self, o: C) -> C { return o; }'), /operators can't take 'var self'/);
  has(e('fn *(self) -> C { return self; }'), /'\*' needs two operands/);
  has(e('fn ==(self, o: C) -> int { return 1; }'), /'==' must return bool/);
  has(e('fn +(a: float, b: float) -> float { return a; }'), /must take a C on one side/);
  has(e('fn +(self, o: C) -> C { return o; }\nfn +(self, p: C) -> C { return p; }'), /C already defines \+\(C, C\)/);
  has(e('fn +(self, o: C, p: C) -> C { return o; }'), /takes one or two operands, not 3/);
  has(e('fn +(self, o: C) { }'), /'\+' must return a value/);
  has(errors('fn +(a: int, b: int) -> int { return a; }\nfn main() {}'), /operators can only be defined for a struct, inside its impl block/);
  has(e('fn *(self, o: C) -> C { return o; }', '') .concat(errors('struct C { re: float, im: float }\nimpl C { fn *(self, o: C) -> C { return o; } }\nconst K = C(1.0, 0.0) * C(0.0, 1.0);\nfn main() { print(K); }')), /can't be used in constant expressions/);
  has(errors('struct P { a: int, b: str }\nfn main() { let p = P(1, "x"); let q = p + p; }'), /define it: impl P \{ fn \+\(self, o: P\) -> P/);
});
