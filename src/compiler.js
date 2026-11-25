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

export { formatError, CompileError, PRELUDE, WIDTH, HEIGHT, lex };

let preludeTokens = null;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * options.inline (default true): expand calls to small single-expression
 * functions, methods and operators at the call site.
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
