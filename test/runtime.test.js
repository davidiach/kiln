import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { compile } from '../src/compiler.js';
import { instantiate } from '../src/runtime.js';
import { run } from './helpers.js';

test('out-of-bounds array access is a runtime error with a line number', async () => {
  await assert.rejects(run('var a: [int; 4];\nfn main() {\n  let i = 4;\n  a[i] = 1;\n}'), /index 4 is out of bounds for 'a', which has 4 elements \(line 4\)/);
  await assert.rejects(run('var a: [int; 4];\nfn main() {\n  let i = -1;\n  print(a[i]);\n}'), /index -1 is out of bounds/);
});

test('division by zero is a runtime error with a line number', async () => {
  await assert.rejects(run('fn main() {\n  let z = 0;\n  print(10 / z);\n}'), /division by zero \(line 3\)/);
  await assert.rejects(run('fn main() {\n  var x = 10;\n  let z = 0;\n  x %= z;\n}'), /division by zero \(line 4\)/);
});

test('string index out of bounds', async () => {
  await assert.rejects(run('fn main() {\n  let s = "ab";\n  print(s[2]);\n}'), /string index 2 is out of bounds \(line 3\)/);
});

test('runaway recursion becomes a stack overflow error', async () => {
  await assert.rejects(run('fn down(n: int) -> int { return down(n + 1) + 1; }\nfn main() { print(down(0)); }'), /stack overflow in 'down'/);
});

test('framebuffer: pixels drawn by the program come out as RGBA', async () => {
  const r = compile('fn main() { clear(0x102030); pixel(1, 0, 0xFF8000); rect(10, 10, 5, 5, 0x00FF00); }');
  assert.ok(r.ok);
  assert.equal(r.hasScreen, true);
  const inst = await instantiate(r);
  inst.main();
  const px = inst.pixels();
  assert.deepEqual([...px.slice(0, 4)], [0x10, 0x20, 0x30, 255]);
  assert.deepEqual([...px.slice(4, 8)], [0xff, 0x80, 0x00, 255]);
  const at = (x, y) => [...px.slice((y * r.width + x) * 4, (y * r.width + x) * 4 + 4)];
  assert.deepEqual(at(12, 12), [0, 255, 0, 255]);
  assert.deepEqual(at(15, 15), [0x10, 0x20, 0x30, 255]);
});

test('input state is visible to the program', async () => {
  const r = compile('export fn probe() -> int { return mouse_x() * 1000 + mouse_y() * 10 + (key_down(KEY_LEFT) ? 1 : 0); }');
  const input = { mouseX: 12, mouseY: 34, mouseDown: false, keys: new Set([37]) };
  const inst = await instantiate(r, { input });
  assert.equal(inst.exports.probe(), 12341);
  input.keys.clear();
  assert.equal(inst.exports.probe(), 12340);
});

test('every example compiles, validates and runs a few frames', async () => {
  const dir = new URL('../examples/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.kiln'));
  assert.ok(files.length > 0);
  for (const f of files) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    const r = compile(src);
    assert.ok(r.ok, `${f}: ${r.ok ? '' : r.errors.map((e) => `${e.span.line}: ${e.message}`).join('; ')}`);
    assert.ok(WebAssembly.validate(r.binary), `${f} produced an invalid module`);
    const inst = await instantiate(r, { print: () => {} });
    inst.main();
    for (let i = 0; i < 3; i++) inst.frame(i / 60);
  }
});
