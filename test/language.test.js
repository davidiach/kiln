import { test } from 'node:test';
import assert from 'node:assert/strict';
import { out, run } from './helpers.js';

test('arithmetic and precedence', async () => {
  assert.equal(await out('print(1 + 2 * 3, (1 + 2) * 3, 10 - 4 - 3, 2 * 3 % 4);'), '7 9 3 2');
  assert.equal(await out('print(7 / 2, -7 / 2, 7 % 3, -7 % 3);'), '3 -3 1 -1');
  assert.equal(await out('print(1 << 4, -16 >> 2, -16 >>> 28, 6 & 3, 6 | 3, 6 ^ 3, ~5);'), '16 -4 15 2 7 5 -6');
  assert.equal(await out('let x = 3; print(x & 1 == 1, x & 4 == 0, 1 + 2 < 4 && 2 < 3);'), 'true true true');
});

test('integer overflow wraps', async () => {
  assert.equal(await out('var x = 2147483647; x += 1; print(x);'), '-2147483648');
  assert.equal(await out('print(0xFFFFFFFF, 0x7fff_ffff);'), '-1 2147483647');
  assert.equal(await out('let a = 65536; print(a * a);'), '0');
});

test('floats', async () => {
  assert.equal(await out('print(1.5 + 2.25, 1.0 / 4.0, 3.0);'), '3.75 0.25 3.0');
  assert.equal(await out('let x = 2.5; print(x * 2, 1 + x, x / 2);'), '5.0 3.5 1.25');
  assert.equal(await out('let x = 7.5; print(x % 2.0, -x % 2.0);'), '1.5 -1.5');
  assert.equal(await out('print(sqrt(16.0), floor(-1.5), ceil(1.2), trunc(-1.7), round(2.5), round(3.5));'), '4.0 -2.0 2.0 -1.0 2.0 4.0');
  assert.equal(await out('let z = 0.0; print(1.0 / z, -1.0 / z, z / z);'), 'inf -inf nan');
});

test('casts', async () => {
  assert.equal(await out('let f = 3.9; print(f as int, -f as int, 7 as float, true as int);'), '3 -3 7.0 1');
  assert.equal(await out('let big = 1e20; let z = 0.0; print(big as int, -big as int, (z / z) as int);'), '2147483647 -2147483648 0');
  assert.equal(await out('print(5 as bool, 0 as bool, 0.5 as bool);'), 'true false true');
});

test('int literals adapt to float context', async () => {
  assert.equal(await out('let x: float = 3; print(x, max(x, 10), x * 2 + 1);'), '3.0 10.0 7.0');
  assert.equal(await out('print(SIZE * 0.5);', 'const SIZE = 10;'), '5.0');
});

test('booleans and short-circuit evaluation', async () => {
  const src = `
    var calls = 0;
    fn yes() -> bool { calls += 1; return true; }
    fn main() {
      print(false && yes(), true || yes(), calls);
      print(true && yes(), false || yes(), calls);
      print(!true, true != false, true ^ true);
    }`;
  assert.deepEqual(await run(src), ['false true 0', 'true true 2', 'false true false']);
});

test('ternary and select', async () => {
  assert.equal(await out('let x = 5; print(x > 3 ? 1 : 2, x < 3 ? 1.5 : 2.5, select(x == 5, 10, 20));'), '1 2.5 10');
  assert.equal(await out('let x = -4; print(x < 0 ? -x : x);'), '4');
});

test('loops: while, for, break, continue', async () => {
  assert.equal(await out('var s = 0; for i in 0..10 { s += i; } print(s);'), '45');
  assert.equal(await out('var s = 0; for i in 1..=10 { s += i; } print(s);'), '55');
  assert.equal(await out('var s = 0; for i in 5..0 { s += 1; } print(s);'), '0');
  assert.equal(await out('var s = 0; for i in 0..100 { if i % 2 == 0 { continue; } if i > 10 { break; } s += i; } print(s);'), '25');
  assert.equal(await out('var n = 27; var steps = 0; while n != 1 { n = n % 2 == 0 ? n / 2 : 3 * n + 1; steps += 1; } print(steps);'), '111');
  assert.equal(await out('var i = 0; while true { i += 1; if i == 7 { break; } } print(i);'), '7');
  assert.equal(await out('var c = 0; for i in 0..3 { for j in 0..3 { if j == 1 { break; } c += 1; } } print(c);'), '3');
  // The loop bound is evaluated once.
  assert.equal(await out('var n = 3; var c = 0; for i in 0..n { n += 1; c += 1; } print(c);'), '3');
});

test('recursion and functions', async () => {
  const src = `
    fn fib(n: int) -> int { return n < 2 ? n : fib(n - 1) + fib(n - 2); }
    fn gcd(a: int, b: int) -> int { if b == 0 { return a; } return gcd(b, a % b); }
    fn hyp(a: float, b: float) -> float { return sqrt(a * a + b * b); }
    fn main() { print(fib(25), gcd(1071, 462), hyp(3, 4)); }`;
  assert.deepEqual(await run(src), ['75025 21 5.0']);
});

test('scoping and shadowing', async () => {
  assert.equal(await out('let x = 1; { let x = 2; print(x); } print(x);'), '2\n1');
  assert.equal(await out('let x = 1; let x = x + 10; print(x);'), '11');
  assert.equal(await out('for i in 0..2 { var acc: int; acc += 5; print(acc); }'), '5\n5');
});

test('globals and constants', async () => {
  const src = `
    const N = 4 * 4;
    const HALF: float = N * 0.5;
    let GREETING = "hi";
    var counter = 100;
    var ratio: float;
    fn bump() { counter += 1; ratio += 0.5; }
    fn main() { bump(); bump(); print(N, HALF, GREETING, counter, ratio); }`;
  assert.deepEqual(await run(src), ['16 8.0 hi 102 1.0']);
});

test('arrays', async () => {
  const src = `
    var grid: [int; 10];
    var weights: [float; 3];
    let primes = [2, 3, 5, 7, 11];
    let mixed = [1, 2.5];
    var partial: [int; 4] = [9, 8];
    fn main() {
      for i in 0..len(grid) { grid[i] = i * i; }
      grid[3] += 100;
      weights[1] = 0.5;
      weights[1] *= 3;
      var s = 0;
      for i in 0..len(primes) { s += primes[i]; }
      print(grid[3], grid[9], weights[1], s, mixed[0], mixed[1], partial[1], partial[3], len(partial));
    }`;
  assert.deepEqual(await run(src), ['109 81 1.5 28 1.0 2.5 8 0 4']);
});

test('strings', async () => {
  const src = `
    fn count(s: str, ch: int) -> int {
      var n = 0;
      for i in 0..len(s) { if s[i] == ch { n += 1; } }
      return n;
    }
    fn main() {
      let s = "hello, world";
      print(len(s), s[0], count(s, 108), "tab\\tquote\\"");
      print("unicode: ☃", len("☃"));
    }`;
  assert.deepEqual(await run(src), ['12 104 3 tab\tquote"', 'unicode: ☃ 3']);
});

test('intrinsics', async () => {
  assert.equal(await out('print(abs(-5), abs(7), abs(-2.5), min(3, -4), max(3, -4), min(1.5, 2.5), max(1.5, 2.5));'), '5 7 2.5 -4 3 1.5 2.5');
  assert.equal(await out('print(clamp(15, 0, 10), clamp(-3, 0, 10), clamp(0.5, 0.0, 1.0), clamp(2.0, 0, 1));'), '10 0 0.5 1.0');
  assert.equal(await out('print(pow(2.0, 10.0), atan2(1.0, 1.0) * 4.0, exp(0.0), log(1.0));'), '1024.0 3.141592653589793 1.0 0.0');
});

test('prelude helpers', async () => {
  assert.equal(await out('print(rgb(255, 128, 0), rgb(300, -5, 16), fract(2.75), mix(0.0, 10.0, 0.25));'), `${0xff8000} ${0xff0010} 0.75 2.5`);
  assert.equal(await out('print(smoothstep(0.0, 1.0, 0.5), hash(1) == hash(1), hash(1) != hash(2));'), '0.5 true true');
  const n = await out('var lo = 1.0; var hi = 0.0; for i in 0..1000 { let v = noise(i as float * 0.37, 1.5); lo = min(lo, v); hi = max(hi, v); } print(lo >= 0.0, hi < 1.0, hi - lo > 0.5);');
  assert.equal(n, 'true true true');
});

test('constant folding produces compact code', async () => {
  const { compile } = await import('../src/compiler.js');
  const r = compile('const A = 6; fn main() { print(A * 7 + (A > 3 ? 100 : 0)); }');
  assert.ok(r.ok);
  assert.match(r.wat, /i32\.const 142/);
  assert.doesNotMatch(r.wat, /i32\.mul/);
});

test('dead code elimination strips unused functions', async () => {
  const { compile } = await import('../src/compiler.js');
  const r = compile('fn unused() { print(1); } fn main() { print(2); }');
  assert.ok(r.ok);
  assert.doesNotMatch(r.wat, /\$unused/);
  assert.doesNotMatch(r.wat, /\$pixel/);
  assert.equal(r.hasScreen, false);
});

test('exported functions', async () => {
  const { compile } = await import('../src/compiler.js');
  const { instantiate } = await import('../src/runtime.js');
  const r = compile('export fn add(a: int, b: int) -> int { return a + b; } export fn half(x: float) -> float { return x / 2; }');
  assert.ok(r.ok);
  const inst = await instantiate(r);
  assert.equal(inst.exports.add(2, 40), 42);
  assert.equal(inst.exports.half(5), 2.5);
});

// Regressions from code review on PR #1.

test('strings without a value are empty, wherever they live', async () => {
  // Locals, struct fields and array elements start zeroed; address 0 is a valid empty string.
  const src = `
    struct Named { name: str, n: int }
    var people: [Named; 3];
    fn main() {
      print("hello");
      var s: str;
      var x: Named;
      print(len(s), len(x.name), len(people[2].name), "[", s, "]");
    }`;
  assert.deepEqual(await run(src), ['hello', '0 0 0 [  ]']);
});

test('len() of an array declared later', async () => {
  const src = 'const N = len(values);\nlet values = [1, 2, 3];\nvar copy: [int; N];\nfn main() { print(N, len(values), len(copy)); }';
  assert.deepEqual(await run(src), ['3 3 3']);
});

test('a print inside a print argument prints first, as its own line', async () => {
  const src = 'fn value() -> int { print("inner"); return 7; }\nfn main() { print("outer", value(), "end"); }';
  assert.deepEqual(await run(src), ['inner', 'outer 7 end']);
});
