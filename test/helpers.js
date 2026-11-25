import { compile, formatError } from '../src/compiler.js';
import { instantiate } from '../src/runtime.js';

/** Compile `src`, run main(), and return printed lines. Throws on compile errors. */
export async function run(src, { frames = 0 } = {}) {
  const r = compile(src);
  if (!r.ok) throw new Error(r.errors.map((e) => formatError(e, src)).join('\n'));
  if (!WebAssembly.validate(r.binary)) throw new Error('generated module failed validation');
  const lines = [];
  const inst = await instantiate(r, { print: (l) => lines.push(l) });
  inst.main();
  for (let i = 0; i < frames; i++) inst.frame(i / 60);
  return lines;
}

/** Wrap statements in fn main() and return printed output joined by newlines. */
export async function out(body, prelude = '') {
  return (await run(`${prelude}\nfn main() {\n${body}\n}\n`)).join('\n');
}

/** Compile and return the list of error messages (empty if it compiled). */
export function errors(src) {
  const r = compile(src);
  return r.ok ? [] : r.errors.map((e) => e.message + (e.hint ? ` [hint: ${e.hint}]` : ''));
}

export function errorsIn(body, prelude = '') {
  return errors(`${prelude}\nfn main() {\n${body}\n}\n`);
}
