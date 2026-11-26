// Public compiler API.
//
//   const result = compile(source);
//   if (result.ok) WebAssembly.instantiate(result.binary, imports) ...
//   else result.errors.forEach(e => console.log(formatError(e, source)));

import { lex } from './lexer.js';
import { parse } from './parser.js';
import { check } from './checker.js';
import { generate } from './codegen.js';
import { CompileError, formatError } from './errors.js';
import { PRELUDE, WIDTH, HEIGHT } from './prelude.js';
import { ByteWriter } from './wasm.js';

export { formatError, CompileError, PRELUDE, WIDTH, HEIGHT, lex };

let preludeTokens = null;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * options.inline (default true): expand calls to small single-expression
 * functions, methods and operators at the call site.
 * options.filename: the program's name in the source map (default program.kiln).
 *
 * The result's `sourceMap` maps every instruction back to its Kiln line; see
 * withSourceMapURL() to point a binary at it.
 */
export function compile(source, options = {}) {
  const t0 = now();
  try {
    preludeTokens ??= lex(PRELUDE);
    const preludeAst = parse(preludeTokens);
    const ast = parse(lex(source));
    const ck = check([
      { ast: preludeAst, origin: 'prelude' },
      { ast, origin: 'user' },
    ]);
    if (ck.errors.length) {
      const internal = ck.errors.find((e) => e.origin === 'prelude');
      if (internal) throw new Error(`internal error in prelude: ${formatError(internal, PRELUDE, 'prelude.kiln')}`);
      const errors = [...ck.errors].sort((a, b) => a.span.start - b.span.start);
      return { ok: false, errors, time: now() - t0 };
    }
    const out = generate(ck, { user: source, prelude: PRELUDE }, options);
    return {
      ok: true,
      ...out,
      entry: {
        main: !!ck.main,
        frame: !!ck.frame,
      },
      width: WIDTH,
      height: HEIGHT,
      time: now() - t0,
    };
  } catch (e) {
    if (e instanceof CompileError) return { ok: false, errors: [e], time: now() - t0 };
    throw e;
  }
}

/**
 * The binary with a "sourceMappingURL" custom section appended, so browser
 * devtools can show and step through the Kiln source. The section goes at
 * the end, so the code's byte offsets (which the map refers to) don't move.
 */
export function withSourceMapURL(binary, url) {
  const content = new ByteWriter().name('sourceMappingURL').name(url);
  const section = new ByteWriter().u8(0).sized(content);
  const out = new Uint8Array(binary.length + section.length);
  out.set(binary);
  out.set(section.bytes, binary.length);
  return out;
}

/** A source map as a data: URL, so it travels inside the binary. */
export function sourceMapDataURL(map) {
  const bytes = new TextEncoder().encode(JSON.stringify(map));
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:application/json;base64,${btoa(bin)}`;
}
