import { test } from 'node:test';
import assert from 'node:assert/strict';
import { out, run, errors } from './helpers.js';
import { compile } from '../src/compiler.js';

const VEC = `
struct Vec2 { x: float, y: float }
impl Vec2 {
  fn zero() -> Vec2 { return Vec2(0.0, 0.0); }
  fn dot(self, o: Vec2) -> float { return self.x * o.x + self.y * o.y; }
  fn length(self) -> float { return sqrt(self.dot(self)); }
  fn normalize(self) -> Vec2 { return self / self.length(); }
  fn scale(var self, k: float) { self *= k; }
}`;

const has = (list, re) => assert.ok(list.some((m) => re.test(m)), `expected an error matching ${re}, got:\n  ${list.join('\n  ')}`);

test('methods read like v.length() and chain', async () => {
  assert.equal(await out('let v = Vec2(3.0, 4.0); print(v.length(), v.normalize(), v.normalize().length());', VEC), '5.0 Vec2(0.6, 0.8) 1.0');
  assert.equal(await out('print(Vec2(1.0, 2.0).dot(Vec2(3.0, 4.0)), (Vec2(1.0, 0.0) * 5).length());', VEC), '11.0 5.0');
});

test('static methods are called on the type', async () => {
  assert.equal(await out('let z = Vec2.zero(); print(z, z.length());', VEC), 'Vec2(0.0, 0.0) 0.0');
});

test('self is a copy: calling a plain method never changes the receiver', async () => {
  const src = `${VEC}
    impl Vec2 { fn doubled(self) -> Vec2 { var c = self; c.x *= 2.0; return c; } }
    fn main() { let v = Vec2(1.0, 1.0); let d = v.doubled(); print(v, d); }`;
  assert.deepEqual(await run(src), ['Vec2(1.0, 1.0) Vec2(2.0, 1.0)']);
});

test('var self methods update the value they are called on, wherever it lives', async () => {
  const src = `${VEC}
    struct Body { pos: Vec2, vel: Vec2 }
    impl Body { fn step(var self, dt: float) { self.pos += self.vel * dt; } }
    var g = Vec2(1.0, 2.0);
    var bodies: [Body; 3];
    fn main() {
      var v = Vec2(1.0, 1.0);
      v.scale(3.0);                         // local
      g.scale(10.0);                        // global
      bodies[2] = Body(Vec2(0.0, 0.0), Vec2(1.0, 2.0));
      bodies[2].step(0.5);                  // array element
      bodies[2].vel.scale(2.0);             // field of an array element
      bodies[2].step(1.0);
      print(v, g, bodies[2], bodies[0]);
    }`;
  assert.deepEqual(await run(src), ['Vec2(3.0, 3.0) Vec2(10.0, 20.0) Body(Vec2(2.5, 5.0), Vec2(2.0, 4.0)) Body(Vec2(0.0, 0.0), Vec2(0.0, 0.0))']);
});

test('var self methods can return a value too, and keep changes made before an early return', async () => {
  const src = `
    struct Counter { n: int, limit: int }
    impl Counter {
      fn next(var self) -> int {
        if self.n >= self.limit { return -1; }
        self.n += 1;
        return self.n;
      }
      fn bump_twice(var self) {
        self.n += 1;
        if self.n > 100 { return; }
        self.n += 1;
      }
    }
    fn main() {
      var c = Counter(0, 2);
      print(c.next(), c.next(), c.next(), c.n);
      var d = Counter(100, 0);
      d.bump_twice();
      c.bump_twice();
      print(d.n, c.n);
    }`;
  assert.deepEqual(await run(src), ['1 2 -1 2', '101 4']);
});

test('methods call other methods through self, including var self ones', async () => {
  const src = `${VEC}
    struct Ship { pos: Vec2, heading: Vec2 }
    impl Ship {
      fn forward(var self, d: float) { var h = self.heading.normalize(); h.scale(d); self.pos += h; }
      fn dist(self) -> float { return self.pos.length(); }
    }
    fn main() { var s = Ship(Vec2.zero(), Vec2(0.0, 2.0)); s.forward(3.0); s.forward(1.0); print(s.pos, s.dist()); }`;
  assert.deepEqual(await run(src), ['Vec2(0.0, 4.0) 4.0']);
});

test('different structs can have methods with the same name', async () => {
  const src = `
    struct V2 { x: float, y: float }
    struct V3 { x: float, y: float, z: float }
    impl V2 { fn length(self) -> float { return sqrt(self.x * self.x + self.y * self.y); } }
    impl V3 { fn length(self) -> float { return sqrt(self.x * self.x + self.y * self.y + self.z * self.z); } }
    fn main() { print(V2(3.0, 4.0).length(), V3(2.0, 3.0, 6.0).length()); }`;
  assert.deepEqual(await run(src), ['5.0 7.0']);
});

test('methods compile to functions named Type.method; var self returns the receiver', () => {
  // Without inlining, so the small methods keep their own functions.
  const r = compile(`${VEC} fn main() { var v = Vec2(1.0, 2.0); v.scale(2.0); print(v.length()); }`, { inline: false });
  assert.ok(r.ok);
  assert.match(r.wat, /\(func \$Vec2\.length \(param \$self\.x f64\) \(param \$self\.y f64\) \(result f64\)/);
  assert.match(r.wat, /\(func \$Vec2\.scale \(param \$self\.x f64\) \(param \$self\.y f64\) \(param \$k f64\) \(result f64 f64\)/);
  assert.doesNotMatch(r.wat, /\$Vec2\.zero/, 'unused methods are stripped');
});

test('impl blocks can come before the struct, and there can be several', async () => {
  const src = 'impl P { fn a(self) -> int { return self.v; } }\nstruct P { v: int }\nimpl P { fn b(self) -> int { return self.a() * 2; } }\nfn main() { print(P(21).b()); }';
  assert.deepEqual(await run(src), ['42']);
});

// Regression from review on PR #3: a var self call inside an expression must
// not change operands that were already read.
test('operands keep their values when a later operand calls a var self method', async () => {
  const src = `
    struct V { x: int }
    impl V { fn bump(var self) -> V { self.x += 1; return self; } }
    fn main() {
      var v = V(1);
      print(v + v.bump());
      var w = V(1);
      print(w == w.bump(), w != V(2));
      var p = V(1);
      print(p, p.bump());
      var q = V(1);
      q += q.bump();
      print(q);
    }`;
  assert.deepEqual(await run(src), ['V(3)', 'false false', 'V(1) V(2)', 'V(3)']);
});

test('struct locals are still used in place when nothing can change them', () => {
  const r = compile(`${VEC} fn add(a: Vec2, b: Vec2) -> Vec2 { return a + b; } fn main() { print(add(Vec2(1.0, 2.0), Vec2(3.0, 4.0))); }`, { inline: false });
  const body = r.wat.slice(r.wat.indexOf('(func $add'), r.wat.indexOf('(func $main'));
  assert.match(body, /^\(func \$add/);
  assert.doesNotMatch(body, /\$t\./, 'no copies into temporaries');
});

test('method errors', () => {
  const e = (body) => errors(`${VEC}\n${body}`);
  has(e('fn main() { let v = Vec2(1.0, 2.0); print(v.lenght()); }'), /Vec2 has no method 'lenght'.*did you mean 'length'/);
  has(e('fn main() { let v = Vec2(1.0, 2.0); print(v.x()); }'), /'x' is a field of Vec2, not a method.*without parentheses/);
  has(e('fn main() { let n = 3; print(n.abs()); }'), /int values don't have methods/);
  has(e('fn main() { let v = Vec2(1.0, 2.0); v.scale(2.0); }'), /can't call 'scale' on 'v' because 'v' is immutable.*var v/);
  has(e('fn main() { Vec2(1.0, 2.0).scale(2.0); }'), /can't call 'scale' on a temporary value/);
  has(e("const C = Vec2(1.0, 2.0);\nfn main() { C.scale(2.0); }"), /'C' is a constant/);
  has(e('impl Vec2 { fn bad(self) { self.x = 1.0; } }\nfn main() {}'), /'self' is a copy here.*var self/);
  has(e('fn main() { print(Vec2.length()); }'), /'Vec2\.length' works on a value; call it like value\.length\(\.\.\.\)/);
  has(e('fn main() { let v = Vec2(1.0, 2.0); print(v.zero()); }'), /'Vec2\.zero' doesn't take self; call it as Vec2\.zero\(\.\.\.\)/);
  has(e('fn main() { let v = Vec2(1.0, 2.0); v.dot(); }'), /'Vec2\.dot' takes 1 argument but 0 were given.*dot\(self, o: Vec2\) -> float/);
  has(e('fn main() { let v = Vec2(1.0, 2.0); print(length(v)); }'), /'length' is a method of Vec2; call it on a value: value\.length\(\.\.\.\)/);
  has(errors('impl Nope { fn a(self) {} }\nfn main() {}'), /unknown struct 'Nope'/);
  has(errors('impl int { fn a(self) {} }\nfn main() {}'), /methods can only be added to structs/);
  has(e('impl Vec2 { fn dot(self) -> float { return 0.0; } }\nfn main() {}'), /already has a method named 'dot'/);
  has(e('impl Vec2 { fn x(self) -> float { return 0.0; } }\nfn main() {}'), /has a field named 'x'/);
  has(e('impl Vec2 { fn m(a: int, self) {} }\nfn main() {}'), /'self' must be the first parameter/);
  has(errors('fn f(self) {}\nfn main() {}'), /'self' can only be used in methods/);
  has(e('impl Vec2 { export fn m(self) {} }\nfn main() {}'), /methods can't be exported/);
  has(e('fn main() { impl Vec2 { } }'), /impl blocks must be at top level/);
});
