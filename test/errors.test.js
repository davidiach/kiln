import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errors, errorsIn } from './helpers.js';
import { compile, formatError } from '../src/compiler.js';

const has = (list, re) => assert.ok(list.some((m) => re.test(m)), `expected an error matching ${re}, got:\n  ${list.join('\n  ')}`);

test('syntax errors', () => {
  has(errorsIn('let x = 1'), /expected ';' after variable declaration/);
  has(errorsIn('if x = 1 { }', 'var x = 0;'), /use '==' to compare/);
  has(errorsIn('let s = "abc;'), /unterminated string/);
  has(errorsIn("let c = 'a';"), /double quotes/);
  has(errorsIn('let x = 1 +;'), /expected an expression/);
  has(errors('fn main() { fn inner() {} }'), /top level/);
  has(errorsIn('let x = if true { 1 } else { 2 };'), /cond \? a : b/);
  has(errorsIn('let 9lives = 1;'), /invalid number literal/);
  has(errorsIn('let x = 1; x++;'), /expected an expression/);
});

test('type errors', () => {
  has(errorsIn('let a = 1; let x = a + 2.5;'), /^can't apply '\+' to int and float/);
  has(errorsIn('let a = 2; let b = 1.5; let c = a * b;'), /never converts silently/);
  has(errorsIn('let x: int = 2.5;'), /expected int, found float.*as int/);
  has(errorsIn('if 1 { }'), /condition must be a bool, found int.*x != 0/);
  has(errorsIn('let s = "a" == "b";'), /strings can't be compared/);
  has(errorsIn('let b = !5;'), /can't apply '!' to int/);
  has(errorsIn('let x = 1 / 0;'), /division by zero/);
  has(errorsIn('let t: string = "x";'), /unknown type 'string'.*did you mean 'str'/);
});

test('name errors with suggestions', () => {
  has(errorsIn('let count = 1; print(cuont);'), /unknown name 'cuont'.*did you mean 'count'/);
  has(errorsIn('pixl(1, 2, 3);'), /unknown function 'pixl'.*did you mean 'pixel'/);
  has(errorsIn('let x = sine(1.0);'), /did you mean 'sin'/);
  has(errors('fn pixel(x: int) {} fn main() {}'), /already defined by the standard prelude/);
  has(errors('fn sqrt(x: float) -> float { return x; } fn main() {}'), /built-in function/);
  has(errors('fn f() {} fn f() {} fn main() {}'), /defined more than once/);
});

test('mutability', () => {
  has(errorsIn('let x = 1; x = 2;'), /immutable variable 'x'.*var x/);
  has(errorsIn('for i in 0..3 { i = 5; }'), /loop variable/);
  has(errorsIn('X = 3;', 'const X = 1;'), /can't assign to constant 'X'/);
  has(errorsIn('T[0] = 3;', 'let T = [1, 2];'), /declared with 'let'/);
  has(errorsIn('let s = "abc"; s[0] = 65;'), /strings are immutable/);
  has(errorsIn('var x = 1; x += 0.5;'), /can't apply '\+' to int and float/);
});

test('functions and calls', () => {
  has(errors('fn f(a: int) -> int { return a; } fn main() { f(1, 2); }'), /takes 1 argument but 2 were given.*signature: f\(a: int\) -> int/);
  has(errors('fn f(a: int) -> int { if a > 0 { return 1; } } fn main() {}'), /must return an int on every path/);
  has(errors('fn f() { return 5; } fn main() {}'), /doesn't return a value/);
  has(errors('fn f() -> int { return; } fn main() {}'), /must return an int/);
  has(errors('fn f() {} fn main() { let x = f(); }'), /returns nothing/);
  has(errorsIn('break;'), /inside a loop/);
  has(errorsIn('let a = 1; let m = min(a, 2.5);'), /no version of 'min' takes \(int, float\)/);
  has(errors('fn main(x: int) {}'), /'main' must take no parameters/);
  has(errors('fn frame(t: int) {}'), /'frame' must look like/);
  has(errors('const X = 1;'), /nothing to run/);
  // These are fine: every path returns.
  assert.deepEqual(errors('fn f(a: int) -> int { if a > 0 { return 1; } else { return 2; } } fn main() {}'), []);
  assert.deepEqual(errors('fn f() -> int { while true { } } fn main() {}'), []);
});

test('arrays and constants', () => {
  has(errorsIn('let a = grid;', 'var grid: [int; 4];'), /is an array; use an element like grid\[i\]/);
  has(errorsIn('let x = [1, 2];'), /only initialize top-level arrays/);
  has(errors('var a: [int; 0]; fn main() {}'), /must be positive/);
  has(errors('var a: [int; 2] = [1, 2, 3]; fn main() {}'), /room for 2 elements but 3/);
  has(errors('var g = 1; const C = g + 1; fn main() {}'), /can't be used in a constant expression/);
  has(errors('const A = B; const B = A; fn main() {}'), /depends on itself/);
  has(errorsIn('let i = grid[1.5];', 'var grid: [int; 4];'), /index must be an int/);
});

test('formatError points at the problem', () => {
  const src = 'fn main() {\n  let x = 1 + true;\n}\n';
  const r = compile(src);
  assert.equal(r.ok, false);
  const text = formatError(r.errors[0], src, 'demo.kiln');
  assert.match(text, /--> demo\.kiln:2:13/);
  assert.match(text, /2 \|   let x = 1 \+ true;/);
  assert.match(text, /\^/);
});

test('reports several type errors at once', () => {
  const r = compile('fn main() {\n let a = 1; let c = a + 1.5;\n let b: bool = 3;\n missing();\n}');
  assert.equal(r.errors.length, 3);
  assert.deepEqual(r.errors.map((e) => e.span.line), [2, 3, 4]);
});
