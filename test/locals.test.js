import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compile } from '../src/compiler.js';
import { run } from './helpers.js';

/** The `(local ...)` declarations of one function in the WAT listing. */
function localsOf(src, fn) {
  const wat = compile(src, { inline: false }).wat;
  // `(func $f` is followed by a space when it has params or results, else by a newline
  const start = [' ', '\n'].map((c) => wat.indexOf(`(func $${fn}${c}`)).find((i) => i >= 0) ?? -1;
  assert.ok(start >= 0, `no function ${fn}`);
  const body = wat.slice(start, wat.indexOf('\n  )', start));
  return [...body.matchAll(/\(local \$(\S+) (\w+)\)/g)].map((m) => `${m[1]} ${m[2]}`);
}

test('variables in sibling blocks share a wasm local, named after both', () => {
  const src = `
    fn f(flag: bool) -> float {
      if flag {
        let a = 1.5;
        return a * 2.0;
      } else {
        let b = 2.5;
        return b * 3.0;
      }
    }
    fn main() { print(f(true), f(false)); }`;
  assert.deepEqual(localsOf(src, 'f'), ['a|b f64']);
});

test('a variable gives its local back after the last statement that mentions it', () => {
  const src = `
    fn g() {
      let a = 3;
      print(a);
      let b = 4;
      print(b);
      let c = 5.0;
      print(c);
      let d = 6.0;
      print(d);
    }
    fn main() { g(); }`;
  assert.deepEqual(localsOf(src, 'g'), ['a|b i32', 'c|d f64']);
});

test('variables used inside a loop keep their local for the whole loop', async () => {
  const src = `
    fn main() {
      let k = 10;
      var s = 0;
      for i in 0..4 {
        let t = i * 2;
        s += t + k;
      }
      let after = s * 2;
      print(s, after, k);
    }`;
  assert.deepEqual(await run(src), ['52 104 10']);
});

test('a variable declared in a loop body starts fresh on every iteration, even in a reused local', async () => {
  const src = `
    fn main() {
      let first = 100;
      print(first);
      for i in 0..3 {
        var acc: int;
        acc += i + 1;
        print(acc);
      }
      for i in 0..2 {
        var v = Vec(0, 0);
        v.x += i;
        print(v);
      }
    }
    struct Vec { x: int, y: int }`;
  assert.deepEqual(await run(src), ['100', '1', '2', '3', 'Vec(0, 0)', 'Vec(1, 0)']);
});

test('shadowed variables and struct leaves keep separate locals while both are alive', async () => {
  const src = `
    struct P { x: int, y: int }
    fn main() {
      let p = P(1, 2);
      {
        let p = P(10, 20);
        print(p);
      }
      let q = P(3, 4);
      print(p, q, p.x + q.y);
    }`;
  assert.deepEqual(await run(src), ['P(10, 20)', 'P(1, 2) P(3, 4) 5']);
});

test("locals of different wasm types never share, and a loop with a constant end needs no local for it", () => {
  const src = `
    fn h() {
      let a = 1.0;
      print(a);
      let b = 2;
      print(b);
      for i in 0..10 { print(i); }
    }
    fn main() { h(); }`;
  const locals = localsOf(src, 'h');
  assert.ok(locals.includes('a f64'));
  assert.ok(locals.some((l) => l.endsWith(' i32') && l.includes('b')));
  assert.ok(!locals.some((l) => l.includes('i.end')), 'no i.end local for 0..10');
  const dynamic = localsOf('fn k(n: int) { for i in 0..n { print(i); } }\nfn main() { k(3); }', 'k');
  assert.ok(dynamic.some((l) => l.includes('i.end')), 'a loop up to n keeps its end in a local');
});

test('the largest function in the dodge example went from 39 locals to under 20', () => {
  const wat = compile(readFileSync(new URL('../examples/dodge.kiln', import.meta.url), 'utf8')).wat;
  const counts = wat.split('\n  (func ').slice(1).map((fn) => (fn.match(/\(local \$/g) || []).length);
  assert.ok(Math.max(...counts) < 20, `largest function has ${Math.max(...counts)} locals`);
});
