import { test } from 'node:test';
import assert from 'node:assert/strict';
import { out, run, errors } from './helpers.js';
import { compile } from '../src/compiler.js';
import { instantiate } from '../src/runtime.js';

const V2 = 'struct Vec2 { x: float, y: float }';
const V3 = 'struct Vec3 { x: float, y: float, z: float }';
const has = (list, re) => assert.ok(list.some((m) => re.test(m)), `expected an error matching ${re}, got:\n  ${list.join('\n  ')}`);

test('construct, read fields, print', async () => {
  assert.equal(await out('let v = Vec2(3.0, 4.0); print(v, v.x + v.y);', V2), 'Vec2(3.0, 4.0) 7.0');
  assert.equal(await out('let v = Vec2(1, 2); print(v);', V2), 'Vec2(1.0, 2.0)'); // int literals adapt
  assert.equal(
    await out('let p = Player("ada", 3, true, Vec2(0.5, 1.5)); print(p, p.name, p.pos.y);', `${V2} struct Player { name: str, lives: int, alive: bool, pos: Vec2 }`),
    'Player(ada, 3, true, Vec2(0.5, 1.5)) ada 1.5',
  );
});

test('structs are values: assignment copies', async () => {
  assert.equal(await out('var a = Vec2(1.0, 2.0); var b = a; b.x = 9.0; print(a.x, b.x);', V2), '1.0 9.0');
  assert.equal(await out('var a = Vec2(1.0, 2.0); a = Vec2(a.y, a.x); print(a);', V2), 'Vec2(2.0, 1.0)');
  assert.equal(await out('var a: Vec2; print(a); a.y = 3.0; print(a);', V2), 'Vec2(0.0, 0.0)\nVec2(0.0, 3.0)');
});

test('functions take and return structs (multi-value)', async () => {
  const src = `${V3}
    fn cross(a: Vec3, b: Vec3) -> Vec3 {
      return Vec3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
    }
    fn dot(a: Vec3, b: Vec3) -> float { return a.x * b.x + a.y * b.y + a.z * b.z; }
    fn normalize(v: Vec3) -> Vec3 { return v / sqrt(dot(v, v)); }
    fn main() {
      let x = Vec3(1.0, 0.0, 0.0);
      let y = Vec3(0.0, 1.0, 0.0);
      print(cross(x, y), cross(x, y).z, dot(normalize(Vec3(3.0, 0.0, 4.0)), Vec3(0.0, 0.0, 1.0)));
    }`;
  assert.deepEqual(await run(src), ['Vec3(0.0, 0.0, 1.0) 1.0 0.8']);
  const r = compile(src, { inline: false });
  assert.match(r.wat, /\(func \$cross \(param \$a\.x f64\).*\(result f64 f64 f64\)/);
});

test('component-wise arithmetic and comparison', async () => {
  assert.equal(await out('let a = Vec2(1.0, 2.0); let b = Vec2(10.0, 20.0); print(a + b, b - a, a * b, b / a);', V2), 'Vec2(11.0, 22.0) Vec2(9.0, 18.0) Vec2(10.0, 40.0) Vec2(10.0, 10.0)');
  assert.equal(await out('let a = Vec2(1.0, 2.0); print(a * 3, 2 * a, a / 2.0, 1.0 - a, -a);', V2), 'Vec2(3.0, 6.0) Vec2(2.0, 4.0) Vec2(0.5, 1.0) Vec2(0.0, -1.0) Vec2(-1.0, -2.0)');
  assert.equal(await out('var a = Vec2(1.0, 2.0); a += Vec2(1.0, 1.0); a *= 10; a.y -= 5.0; print(a);', V2), 'Vec2(20.0, 25.0)');
  assert.equal(await out('let p = P(7, -9); print(p / 2, p % 4, p * p);', 'struct P { a: int, b: int }'), 'P(3, -4) P(3, -1) P(49, 81)');
  assert.equal(await out('let a = Vec2(1.0, 2.0); print(a == Vec2(1.0, 2.0), a != Vec2(1.0, 2.0), a == a * 2);', V2), 'true false false');
  assert.equal(await out('let a = T(1, true); print(a == T(1, true), a == T(1, false));', 'struct T { n: int, b: bool }'), 'true false');
});

test('ternaries pick between structs', async () => {
  assert.equal(await out('let k = 3; let v = k > 2 ? Vec2(1.0, 2.0) : Vec2(3.0, 4.0); print(v, (k < 2 ? v : -v).y);', V2), 'Vec2(1.0, 2.0) -2.0');
});

test('fields of temporaries', async () => {
  assert.equal(await out('print(make(5.0).y, (Vec2(1.0, 2.0) * 3.0).x);', `${V2} fn make(k: float) -> Vec2 { return Vec2(k, k * 2.0); }`), '10.0 3.0');
});

test('struct globals, constants and folding', async () => {
  const src = `${V2}
    const UP = Vec2(0.0, 1.0);
    const DOUBLE = UP * 2 + Vec2(1, 0);
    let HALF_Y = DOUBLE.y / 2.0;
    var pos = Vec2(5.0, 5.0);
    var vel: Vec2;
    fn step() { vel += UP; pos += vel; }
    fn main() { step(); step(); print(pos, vel, DOUBLE, HALF_Y); }`;
  assert.deepEqual(await run(src), ['Vec2(5.0, 8.0) Vec2(0.0, 2.0) Vec2(1.0, 2.0) 1.0']);
  const r = compile(`${V2} const C = Vec2(1.0, 2.0) * 3.0; fn main() { print(C.y); }`);
  assert.match(r.wat, /f64\.const 6/);
  assert.doesNotMatch(r.wat, /f64\.mul/);
});

test('arrays of structs live in linear memory', async () => {
  const src = `${V2}
    struct Ball { pos: Vec2, vel: Vec2, color: int, live: bool }
    var balls: [Ball; 4];
    let corners = [Vec2(0.0, 0.0), Vec2(1.0, 0.0), Vec2(1.0, 1.0)];
    fn main() {
      for i in 0..len(balls) {
        balls[i] = Ball(corners[i % 3], Vec2(i as float, -i as float), 0xff0000 + i, i % 2 == 0);
      }
      balls[3].pos.x += 10.0;
      balls[2].vel = balls[2].vel * 4.0;
      var live = 0;
      for i in 0..4 { if balls[i].live { live += 1; } }
      print(balls[3], live, len(corners), corners[2].y);
      print(balls[2].vel);
    }`;
  assert.deepEqual(await run(src), ['Ball(Vec2(10.0, 0.0), Vec2(3.0, -3.0), 16711683, false) 2 3 1.0', 'Vec2(8.0, -8.0)']);
});

test('struct element index is still bounds-checked', async () => {
  await assert.rejects(run(`${V2}\nvar ps: [Vec2; 3];\nfn main() {\n  let i = 3;\n  ps[i].x = 1.0;\n}`), /index 3 is out of bounds for 'ps', which has 3 elements \(line 5\)/);
});

test('integer struct division checks every component for zero', async () => {
  await assert.rejects(run('struct P { a: int, b: int }\nfn main() {\n  let z = P(1, 0);\n  print(P(4, 4) / z);\n}'), /division by zero \(line 4\)/);
});

test('reading a field of a local is a single local.get', () => {
  const r = compile(`${V3} fn f(v: Vec3) -> float { return v.z; } fn main() { print(f(Vec3(1.0, 2.0, 3.0))); }`, { inline: false });
  const body = r.wat.slice(r.wat.indexOf('(func $f'), r.wat.indexOf('(func $main'));
  assert.match(body, /^\(func \$f/);
  assert.match(body, /local\.get \$v\.z\n\s+return/);
  assert.doesNotMatch(body, /\$t\./, 'no temporaries');
});

test('declaration order does not matter', async () => {
  assert.equal(await out('let s = Seg(Pt(1, 2), Pt(3, 4)); print(s.b.y);', 'struct Seg { a: Pt, b: Pt } struct Pt { x: int, y: int }'), '4');
});

test('exported functions return structs to JavaScript as arrays', async () => {
  const r = compile(`${V2} export fn mid(a: Vec2, b: Vec2) -> Vec2 { return (a + b) * 0.5; }`);
  const inst = await instantiate(r);
  assert.deepEqual(inst.exports.mid(0, 0, 4, 2), [2, 1]);
});

test('struct errors', () => {
  has(errors(`${V2} fn main() { let v = Vec2(1.0, 2.0); print(v.z); }`), /struct 'Vec2' has no field 'z'.*its fields are: x, y/);
  has(errors(`${V2} fn main() { let v = Vec2(1.0, 2.0); print(v.yy); }`), /did you mean 'y'/);
  has(errors(`${V2} fn main() { let v = Vec2(1.0, 2.0); v.x = 3.0; }`), /can't modify 'v\.x' because 'v' is immutable.*var v/);
  has(errors(`${V2} const C = Vec2(1.0, 2.0); fn main() { C.x = 3.0; }`), /'C' is a constant/);
  has(errors(`${V2} let PTS = [Vec2(1.0, 2.0)]; fn main() { PTS[0].x = 3.0; }`), /declared with 'let'/);
  has(errors(`${V2} fn f() -> Vec2 { return Vec2(1.0, 2.0); } fn main() { f().x = 1.0; }`), /field of a temporary/);
  has(errors(`${V2} fn main() { let v = Vec2(1.0); }`), /'Vec2' takes 2 arguments but 1 was given.*Vec2\(x: float, y: float\)/);
  has(errors(`${V2} fn main() { let v = Vec2(1.0, true); }`), /argument 2 of 'Vec2': expected float, found bool/);
  has(errors(`${V2} fn main() { let v = Vec2; }`), /'Vec2' is a struct type; create a value like Vec2\(x, y\)/);
  has(errors('struct A { b: B } struct B { a: A } fn main() {}'), /contains itself/);
  has(errors('struct Box { items: [int; 4] } fn main() {}'), /struct fields can't be arrays/);
  has(errors('struct E { } fn main() {}'), /needs at least one field/);
  has(errors('struct D { x: int, x: int } fn main() {}'), /field 'x' is declared twice/);
  has(errors(`${V2} fn main() { let v = Vec2(1.0, 2.0) + 1.0; let p: Pnt = v; }`), /unknown type 'Pnt'/);
  has(errors(`${V2} ${V3} fn main() { let a = Vec2(1.0, 2.0) + Vec3(1.0, 2.0, 3.0); }`), /can't apply '\+' to Vec2 and Vec3/);
  has(errors('struct M { a: int, b: float } fn main() { let m = M(1, 2.0) * 2; }'), /all floats or all ints/);
  has(errors(`${V2} fn main() { let a = 2; let v = Vec2(1.0, 2.0) * a; }`), /a Vec2 can be combined with a float, not an int/);
  has(errors(`${V2} fn main() { let v = Vec2(1.0, 2.0); let b = v < v; }`), /can't apply '<' to Vec2 and Vec2.*fn <\(self, o: Vec2\) -> bool/);
  has(errors(`${V2} fn main() { let v = select(true, Vec2(1.0, 2.0), Vec2(0.0, 0.0)); }`), /cond \? a : b/);
  has(errors(`${V2} fn main() { let v = Vec2(1.0, 2.0) as int; }`), /can't convert Vec2 to int/);
  has(errors(`${V2} fn main() { let v = Vec2(1.0, 2.0); var x = 1.0; x += v; }`), /would change the type/);
  has(errors(`fn main() { let n = 5; print(n.x); }`), /int values don't have fields/);
  has(errors(`fn main() { struct S { a: int } }`), /declared at top level/);
});
