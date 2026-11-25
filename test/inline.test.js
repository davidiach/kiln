import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { compile } from '../src/compiler.js';
import { instantiate } from '../src/runtime.js';
import { run } from './helpers.js';

// A deterministic Math.random replacement, so two runs can be compared.
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Run a program for some frames with scripted input; return everything observable. */
async function observe(src, inline, frames = 40) {
  const r = compile(src, { inline });
  assert.ok(r.ok, r.ok ? '' : r.errors[0].message);
  const lines = [];
  const sounds = [];
  const input = { mouseX: 160, mouseY: 120, mouseDown: false, keys: new Set() };
  const inst = await instantiate(r, { print: (l) => lines.push(l), sound: (e) => sounds.push(e), input, random: seeded(7) });
  inst.main();
  const shots = [];
  for (let f = 0; f < frames; f++) {
    input.mouseX = (f * 37) % 320;
    input.mouseY = (f * 23) % 240;
    input.mouseDown = f % 10 < 4;
    input.keys = new Set(f % 15 === 0 ? [32, 37, 82] : []);
    inst.frame(f / 60);
    if (f % 13 === 0 || f === frames - 1) shots.push(Buffer.from(inst.pixels()).toString('base64'));
  }
  return { lines, sounds, shots, size: r.binary.length };
}

const dir = new URL('../examples/', import.meta.url);
for (const file of readdirSync(dir).filter((f) => f.endsWith('.kiln'))) {
  test(`inlining doesn't change what ${file} does`, async () => {
    const src = readFileSync(new URL(file, dir), 'utf8');
    const plain = await observe(src, false);
    const inlined = await observe(src, true);
    assert.deepEqual(inlined.lines, plain.lines, 'printed output');
    assert.deepEqual(inlined.sounds, plain.sounds, 'sound events');
    assert.ok(inlined.shots.length > 0);
    inlined.shots.forEach((s, i) => assert.ok(s === plain.shots[i], `screen differs at snapshot ${i}`));
  });
}

test('small functions, methods and operators are inlined; big and recursive ones are not', () => {
  const src = `
    struct C { re: float, im: float }
    impl C {
      fn *(self, o: C) -> C { return C(self.re * o.re - self.im * o.im, self.re * o.im + self.im * o.re); }
      fn abs2(self) -> float { return self.re * self.re + self.im * self.im; }
    }
    fn sq(x: float) -> float { return x * x; }
    fn fib(n: int) -> int { return n < 2 ? n : fib(n - 1) + fib(n - 2); }
    fn main() { var z = C(0.5, 0.5); z = z * z; print(z.abs2(), sq(3.0), fib(10)); }`;
  const r = compile(src);
  const main = r.wat.slice(r.wat.indexOf('(func $main'));
  assert.match(main, /;; inlined C\.op\*/);
  assert.match(main, /;; inlined C\.abs2/);
  assert.match(main, /;; inlined sq/);
  assert.match(main, /call \$fib/, 'the first call to a recursive function stays a call');
  assert.doesNotMatch(main, /call \$C\.op\*|call \$C\.abs2|call \$sq/);
  assert.doesNotMatch(compile(src, { inline: false }).wat, /;; inlined/);
});

test('arguments are still evaluated exactly once, left to right', async () => {
  const src = `
    fn twice(x: int) -> int { return x + x; }
    fn first(a: int, b: int) -> int { return a; }
    fn noisy(n: int) -> int { print("eval", n); return n; }
    fn main() { print(twice(noisy(3)), first(noisy(1), noisy(2))); }`;
  assert.deepEqual(await run(src), ['eval 3', 'eval 1', 'eval 2', '6 1']);
});

test('a trap inside inlined code still reports its own line', async () => {
  const src = 'var data: [int; 4];\nfn at(i: int) -> int { return data[i]; }\nfn main() {\n  print(at(9));\n}';
  await assert.rejects(run(src), /index 9 is out of bounds for 'data', which has 4 elements \(line 2\)/);
});
