import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Session } from 'node:inspector';
import { compile, withSourceMapURL, sourceMapDataURL, PRELUDE } from '../src/compiler.js';
import { instantiate } from '../src/runtime.js';

// An independent decoder for source map mappings (base64 VLQ), so the
// tests don't trust the compiler's encoder.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function decode(mappings) {
  const out = [];
  const state = [0, 0, 0, 0];
  for (const seg of mappings.split(',')) {
    const fields = [];
    let value = 0;
    let shift = 0;
    for (const ch of seg) {
      const d = B64.indexOf(ch);
      value += (d & 31) << shift;
      if (d & 32) shift += 5;
      else {
        fields.push(value & 1 ? -(value >>> 1) : value >>> 1);
        value = 0;
        shift = 0;
      }
    }
    fields.forEach((f, i) => (state[i] += f));
    // A one-field segment maps its offset to nothing.
    if (fields.length === 1) out.push({ offset: state[0], unmapped: true });
    else out.push({ offset: state[0], source: state[1], line: state[2] + 1, col: state[3] + 1 });
  }
  return out;
}

/** The mappings for one source line of the user's program, by byte offset. */
const forLine = (maps, line) => maps.filter((m) => m.source === 0 && m.line === line);

test('the source map is version 3 and carries both sources', () => {
  const src = 'fn main() {\n  print(1);\n}\n';
  const r = compile(src, { filename: 'hi.kiln' });
  assert.equal(r.sourceMap.version, 3);
  assert.deepEqual(r.sourceMap.sources, ['hi.kiln', 'prelude.kiln']);
  assert.deepEqual(r.sourceMap.sourcesContent, [src, PRELUDE]);
  assert.equal(compile(src).sourceMap.sources[0], 'program.kiln');
});

test('each statement maps to the bytes it compiled to', () => {
  const src = [
    'fn main() {',
    '  let a = 5;', // 2: i32.const 5
    '  print(a * 7);', // 3: i32.const 7 (reading a became line 2's local.tee)
    '  for i in 0..3 {', // 4: i32.const 0 (the start)
    '    print(i);', // 5: local.get i
    '  }',
    '}',
  ].join('\n');
  const r = compile(src);
  const maps = decode(r.sourceMap.mappings);
  const code = r.sections.find((s) => s.name === 'code');
  for (let i = 1; i < maps.length; i++) assert.ok(maps[i].offset > maps[i - 1].offset, 'offsets increase');
  for (const m of maps) assert.ok(m.offset >= code.start && m.offset < code.end, 'every mapping points into the code section');
  const at = (line) => r.binary.subarray(forLine(maps, line)[0].offset);
  assert.deepEqual([...at(2).subarray(0, 2)], [0x41, 5], 'line 2 starts with i32.const 5');
  assert.deepEqual([...at(3).subarray(0, 2)], [0x41, 7], 'line 3 starts with i32.const 7');
  assert.equal(r.binary[forLine(maps, 3)[0].offset - 2], 0x22, 'just before it, line 2 ends with local.tee');
  assert.deepEqual([...at(4).subarray(0, 2)], [0x41, 0], 'line 4 starts with i32.const 0');
  assert.equal(at(5)[0], 0x20, 'line 5 starts with local.get');
});

test('a loop maps its own bookkeeping back to the loop, not to the last statement in its body', () => {
  const src = 'fn main() {\n  for i in 0..3 {\n    print(i);\n  }\n  print(9);\n}\n';
  const maps = decode(compile(src).sourceMap.mappings).filter((m) => m.source === 0);
  // 2 (loop setup and test), 3 (body), back to 2 (i += 1 and repeat), then 5
  assert.deepEqual(maps.map((m) => m.line).filter((l, i, a) => l !== a[i - 1]), [2, 3, 2, 5]);
});

test('inlined code maps to the line of the function it came from', () => {
  const src = 'fn sq(x: int) -> int {\n  return x * x;\n}\nfn main() {\n  let v = 7;\n  print(sq(v));\n}\n';
  const r = compile(src);
  assert.doesNotMatch(r.wat, /\(func \$sq/, 'sq is inlined everywhere');
  const lines = decode(r.sourceMap.mappings).filter((m) => m.source === 0).map((m) => m.line);
  // let v (5), sq's body (2: v is passed in place, so nothing on line 6 runs
  // first), then back to line 6 to print the result
  assert.deepEqual(lines, [5, 2, 6]);
});

test('prelude code maps to prelude.kiln', () => {
  const r = compile('fn main() { pixel(1, 2, 0xff0000); }');
  const maps = decode(r.sourceMap.mappings);
  const prelude = maps.filter((m) => m.source === 1);
  assert.ok(prelude.length > 0);
  const line = PRELUDE.split('\n')[prelude[0].line - 1];
  assert.match(line, /x >= 0 && x < WIDTH/, 'the first prelude mapping is the body of pixel()');
});

test('V8 reads the sourceMappingURL section, the way devtools find the map', async () => {
  const r = compile('fn main() { print(1); }');
  const session = new Session();
  session.connect();
  const urls = [];
  session.on('Debugger.scriptParsed', ({ params }) => {
    if (params.scriptLanguage === 'WebAssembly') urls.push(params.sourceMapURL);
  });
  await new Promise((resolve) => session.post('Debugger.enable', resolve));
  try {
    await WebAssembly.compile(withSourceMapURL(r.binary, 'demo.wasm.map'));
    const data = sourceMapDataURL(r.sourceMap);
    await WebAssembly.compile(withSourceMapURL(r.binary, data));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(urls.includes('demo.wasm.map'), `saw ${JSON.stringify(urls)}`);
    const embedded = urls.find((u) => u.startsWith('data:application/json;base64,'));
    assert.ok(embedded, 'the data: URL came through too');
    const json = new TextDecoder().decode(Uint8Array.from(atob(embedded.split(',')[1]), (c) => c.charCodeAt(0)));
    assert.deepEqual(JSON.parse(json), r.sourceMap);
  } finally {
    session.disconnect();
  }
});

test('appending the section leaves every code offset where the map says it is', () => {
  const r = compile('fn main() {\n  let a = 5;\n  print(a);\n}\n');
  const withMap = withSourceMapURL(r.binary, 'x.map');
  assert.deepEqual([...withMap.subarray(0, r.binary.length)], [...r.binary]);
  assert.ok(WebAssembly.validate(withMap));
});

test('a stack overflow names the line of the call that recursed', async () => {
  const src = 'fn down(n: int) -> int {\n  if n < 0 { return 0; }\n  return down(n + 1) + 1;\n}\nfn main() {\n  print(down(0));\n}\n';
  const inst = await instantiate(compile(src), { print: () => {} });
  assert.throws(() => inst.main(), (e) => {
    assert.match(e.message, /stack overflow in 'down' \(line 3\)/);
    assert.equal(e.line, 3, 'the editor can mark the line');
    return true;
  });
});

// Regression from review on PR #9: an overflow is reported at a function's
// entry, which used to borrow the last line of whatever function came before.
test('mutual recursion names the call that recursed, never a line of an unrelated function', async () => {
  const src = [
    'fn a(n: int) -> int {',
    '  return b(n + 1) + 1;', // 2
    '}',
    'export fn other() {',
    '  print(42);', // 5: the function just before b
    '}',
    'fn b(n: int) -> int {',
    '  if n < 0 { return 0; }',
    '  return a(n + 1) + 2;', // 9
    '}',
    'fn main() {',
    '  print(a(0));',
    '}',
  ].join('\n');
  for (const inline of [true, false]) {
    const inst = await instantiate(compile(src, { inline }), { print: () => {} });
    assert.throws(() => inst.main(), (e) => {
      // a's call to b (line 2) or b's call to a (line 9), named after the right function
      assert.match(e.message, /stack overflow in '(a' \(line 2|b' \(line 9)\)/, `inline: ${inline}: ${e.message}`);
      assert.notEqual(e.line, 5);
      return true;
    });
  }
});

test('every function in the module starts unmapped', () => {
  const r = compile('fn f(x: int) -> int {\n  print(x);\n  return x;\n}\nfn main() {\n  print(f(1) + f(2));\n}\n', { inline: false });
  const maps = decode(r.sourceMap.mappings);
  const functions = (r.wat.match(/^ {2}\(func /gm) || []).length;
  assert.equal(maps.filter((m) => m.unmapped).length, functions);
  assert.ok(maps[0].unmapped, 'the first function starts unmapped too');
});

test('kiln build writes the map next to the binary and points the binary at it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kiln-'));
  try {
    const file = new URL('../examples/hello.kiln', import.meta.url).pathname;
    const out = join(dir, 'hello.wasm');
    const res = spawnSync(process.execPath, [new URL('../bin/kiln.js', import.meta.url).pathname, 'build', file, '-o', out], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    const map = JSON.parse(readFileSync(`${out}.map`, 'utf8'));
    assert.equal(map.sources[0], 'hello.kiln');
    const mod = new WebAssembly.Module(readFileSync(out));
    const [section] = WebAssembly.Module.customSections(mod, 'sourceMappingURL');
    assert.equal(new TextDecoder().decode(new Uint8Array(section).subarray(1)), 'hello.wasm.map');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
