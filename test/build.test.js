import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build, bundle } from '../scripts/build.js';

test('the playground builds into one self-contained HTML file', () => {
  build();
  const html = readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 2);
  for (const s of scripts) new Function(s); // throws on a syntax error
  assert.match(html, /window\.KILN_EXAMPLES = \[/);
  assert.doesNotMatch(html, /<script[^>]+src=/, 'no external scripts');
});

test('the bundled compiler works outside of ES modules', () => {
  const code = bundle('src/compiler.js');
  // The entry module is bundled last; make the bundle return its exports.
  const entry = [...code.matchAll(/const (__mod\d+) = /g)].pop()[1];
  const factory = new Function(code.replace(/^\(\(\) => \{/, 'return (() => {').replace(/\}\)\(\);\n$/, `return ${entry};\n})();\n`));
  const { compile } = factory();
  const r = compile('fn main() { print(1 + 2); }');
  assert.equal(r.ok, true);
  assert.ok(WebAssembly.validate(r.binary));
});
