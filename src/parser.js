// Parser: tokens -> AST.
//
// Recursive descent for statements and declarations, precedence climbing for
// binary operators. Every node carries `span` for error reporting.

import { CompileError } from './errors.js';

// Binding power of binary operators (higher binds tighter). Bitwise operators
// bind tighter than comparisons, as in Rust, so `x & 1 == 1` means `(x & 1) == 1`.
const BINARY_PREC = {
  '||': 1,
  '&&': 2,
  '==': 3, '!=': 3,
  '<': 4, '<=': 4, '>': 4, '>=': 4,
  '|': 5,
  '^': 6,
  '&': 7,
  '<<': 8, '>>': 8, '>>>': 8,
  '+': 9, '-': 9,
  '*': 10, '/': 10, '%': 10,
};

const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '>>>=']);

const join = (a, b) => ({ start: a.start, end: b.end, line: a.line, col: a.col });

export function parse(tokens) {
  return new Parser(tokens).program();
}

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.p = 0;
  }

  peek(offset = 0) {
    return this.tokens[Math.min(this.p + offset, this.tokens.length - 1)];
  }
  prev() {
    return this.tokens[this.p - 1];
  }
  next() {
    const t = this.tokens[this.p];
    if (t.kind !== 'eof') this.p++;
    return t;
  }
  is(text) {
    const t = this.peek();
    return (t.kind === 'punct' || t.kind === 'keyword') && t.text === text;
  }
  eat(text) {
    if (this.is(text)) {
      this.next();
      return true;
    }
    return false;
  }
  describe(t) {
    if (t.kind === 'eof') return 'end of file';
    return `'${t.text}'`;
  }
  error(msg, tok = this.peek(), hint) {
    return new CompileError(msg, { start: tok.start, end: tok.end, line: tok.line, col: tok.col }, hint);
  }
  expect(text, context) {
    if (this.is(text)) return this.next();
    const t = this.peek();
    // A missing ';' is best reported right after the previous token.
    if ((text === ';' || text === ')') && this.p > 0) {
      const pt = this.prev();
      const at = { start: pt.end, end: pt.end + 1, line: pt.line, col: pt.col + (pt.end - pt.start) };
      throw new CompileError(`expected '${text}'${context ? ' ' + context : ''}, found ${this.describe(t)}`, at);
    }
    throw this.error(`expected '${text}'${context ? ' ' + context : ''}, found ${this.describe(t)}`, t);
  }
  ident(what = 'a name') {
    const t = this.peek();
    if (t.kind === 'ident') return this.next();
    if (t.kind === 'keyword') throw this.error(`'${t.text}' is a reserved keyword and can't be used as ${what}`, t);
    throw this.error(`expected ${what}, found ${this.describe(t)}`, t);
  }

  // ---------------------------------------------------------------- items

  program() {
    const items = [];
    while (this.peek().kind !== 'eof') items.push(this.item());
    return { kind: 'Program', items };
  }

  item() {
    const t = this.peek();
    if (this.is('export')) {
      this.next();
      if (!this.is('fn')) throw this.error("only functions can be exported: expected 'fn' after 'export'");
      return this.fn(true, t);
    }
    if (this.is('fn')) return this.fn(false, t);
    if (this.is('let') || this.is('var')) return this.global();
    if (this.is('const')) return this.constDecl();
    if (this.is('struct')) return this.structDecl();
    if (this.is('impl')) return this.implBlock();
    throw this.error(`expected a function, 'struct', 'impl', 'let', 'var' or 'const' at top level, found ${this.describe(t)}`, t);
  }

  /** impl Name { fn method(self, ...) { } ... } */
  implBlock() {
    const kw = this.expect('impl');
    const nameTok = this.ident('a struct name');
    const open = this.expect('{', `after 'impl ${nameTok.text}'`);
    const methods = [];
    while (!this.is('}')) {
      if (this.peek().kind === 'eof') throw this.error("unclosed impl block: expected '}'", open);
      if (this.is('export')) throw this.error("methods can't be exported; export a plain function that calls the method instead");
      if (!this.is('fn')) throw this.error(`only methods ('fn ...') can go inside an impl block, found ${this.describe(this.peek())}`);
      methods.push(this.fn(false, this.peek(), true));
    }
    this.next();
    return { kind: 'Impl', target: nameTok.text, targetSpan: nameTok, methods, span: kw };
  }

  structDecl() {
    this.expect('struct');
    const nameTok = this.ident('a struct name');
    const open = this.peek();
    if (this.is('(')) throw this.error(`struct fields go in braces: struct ${nameTok.text} { x: float, y: float }`);
    this.expect('{', `after 'struct ${nameTok.text}'`);
    const fields = [];
    while (!this.is('}')) {
      const fTok = this.ident('a field name');
      this.expect(':', `after field '${fTok.text}' (fields need a type, like '${fTok.text}: float')`);
      const type = this.type();
      fields.push({ name: fTok.text, type, span: fTok });
      if (this.is(';')) throw this.error("separate struct fields with ',' rather than ';'");
      if (!this.eat(',')) break;
    }
    if (this.peek().kind === 'eof') throw this.error("unclosed struct: expected '}'", open);
    this.expect('}', 'to close the struct');
    return { kind: 'Struct', name: nameTok.text, nameSpan: nameTok, fields, span: nameTok };
  }

  fn(exported, startTok, isMethod = false) {
    this.expect('fn');
    const nameTok = this.ident(isMethod ? 'a method name' : 'a function name');
    this.expect('(', 'after function name');
    const params = [];
    // A method's first parameter may be `self` (a copy of the value it's
    // called on) or `var self` (it may change that value).
    let self = null;
    let selfSpan = null;
    if (isMethod) {
      const t0 = this.peek();
      const t1 = this.peek(1);
      if (t0.kind === 'ident' && t0.text === 'self' && !(t1.kind === 'punct' && t1.text === ':')) {
        self = 'value';
        selfSpan = this.next();
      } else if (t0.kind === 'keyword' && t0.text === 'var' && t1.kind === 'ident' && t1.text === 'self') {
        this.next();
        self = 'var';
        selfSpan = this.next();
      }
      if (self && !this.is(')')) this.expect(',', "after 'self'");
    }
    while (!this.is(')')) {
      const t = this.peek();
      if (t.kind === 'ident' && t.text === 'self') {
        throw this.error(isMethod ? "'self' must be the first parameter" : "'self' can only be used in methods, inside an impl block");
      }
      const pTok = this.ident('a parameter name');
      this.expect(':', `after parameter '${pTok.text}' (parameters need a type, like '${pTok.text}: int')`);
      const type = this.type();
      params.push({ name: pTok.text, type, span: pTok });
      if (!this.eat(',')) break;
    }
    this.expect(')', 'to close the parameter list');
    let ret = null;
    if (this.eat('->')) ret = this.type();
    if (!this.is('{')) throw this.error(`expected '{' to start the body of '${nameTok.text}', found ${this.describe(this.peek())}`);
    const body = this.block();
    return {
      kind: 'Fn',
      name: nameTok.text,
      nameSpan: nameTok,
      params,
      ret,
      body,
      exported,
      self,
      selfSpan,
      span: join(startTok, nameTok),
      endSpan: this.prev(),
    };
  }

  global() {
    const kw = this.next();
    const mutable = kw.text === 'var';
    const nameTok = this.ident('a variable name');
    let type = null;
    let init = null;
    if (this.eat(':')) type = this.type();
    if (this.eat('=')) init = this.expr();
    this.expect(';', 'after declaration');
    return { kind: 'Global', mutable, name: nameTok.text, type, init, span: nameTok };
  }

  constDecl() {
    this.expect('const');
    const nameTok = this.ident('a constant name');
    let type = null;
    if (this.eat(':')) type = this.type();
    if (!this.is('=')) throw this.error(`constant '${nameTok.text}' needs a value: const ${nameTok.text} = ...;`);
    this.next();
    const init = this.expr();
    this.expect(';', 'after constant');
    return { kind: 'Const', name: nameTok.text, type, init, span: nameTok };
  }

  type() {
    const t = this.peek();
    if (this.eat('[')) {
      const elem = this.type();
      this.expect(';', "in array type (arrays are written like [int; 16])");
      const size = this.expr();
      const end = this.expect(']', 'to close the array type');
      return { kind: 'ArrayType', elem, size, span: join(t, end) };
    }
    const nameTok = this.ident('a type');
    return { kind: 'TypeName', name: nameTok.text, span: nameTok };
  }

  // ----------------------------------------------------------- statements

  block() {
    const open = this.expect('{');
    const body = [];
    while (!this.is('}')) {
      if (this.peek().kind === 'eof') throw this.error("unclosed block: expected '}'", open);
      body.push(this.statement());
    }
    const close = this.next();
    return { kind: 'Block', body, span: open, endSpan: close };
  }

  statement() {
    const t = this.peek();
    if (this.is('let') || this.is('var')) return this.letStmt();
    if (this.is('if')) return this.ifStmt();
    if (this.is('while')) {
      this.next();
      const cond = this.condition('while');
      const body = this.block();
      return { kind: 'While', cond, body, span: t };
    }
    if (this.is('for')) return this.forStmt();
    if (this.is('break') || this.is('continue')) {
      this.next();
      this.expect(';', `after '${t.text}'`);
      return { kind: t.text === 'break' ? 'Break' : 'Continue', span: t };
    }
    if (this.is('return')) {
      this.next();
      let value = null;
      if (!this.is(';') && !this.is('}')) value = this.expr();
      this.expect(';', 'after return');
      return { kind: 'Return', value, span: t };
    }
    if (this.is('{')) return this.block();
    if (this.is('fn')) throw this.error('functions must be declared at top level, not inside other functions');
    if (this.is('const')) throw this.error("'const' declarations must be at top level; use 'let' inside functions");
    if (this.is('struct')) throw this.error('structs must be declared at top level');
    if (this.is('impl')) throw this.error('impl blocks must be at top level');

    const expr = this.expr();
    const opTok = this.peek();
    if (opTok.kind === 'punct' && ASSIGN_OPS.has(opTok.text)) {
      this.next();
      if (expr.kind !== 'Ident' && expr.kind !== 'Index' && expr.kind !== 'Field') {
        throw new CompileError("can't assign to this expression", expr.span, 'only variables, fields and array elements can be assigned');
      }
      const value = this.expr();
      this.expect(';', 'after assignment');
      return { kind: 'Assign', target: expr, op: opTok.text === '=' ? '=' : opTok.text.slice(0, -1), value, span: opTok };
    }
    if (opTok.kind === 'punct' && (opTok.text === '++' || opTok.text === '--')) {
      throw this.error(`'${opTok.text}' isn't supported; write '+= 1' instead`);
    }
    this.expect(';', 'after expression');
    return { kind: 'ExprStmt', expr, span: expr.span };
  }

  condition(what) {
    const cond = this.expr();
    if (this.is('=')) throw this.error(`expected '{' after ${what} condition, found '='`, this.peek(), "use '==' to compare values");
    if (!this.is('{')) throw this.error(`expected '{' after ${what} condition, found ${this.describe(this.peek())}`);
    return cond;
  }

  letStmt() {
    const kw = this.next();
    const mutable = kw.text === 'var';
    const nameTok = this.ident('a variable name');
    let type = null;
    let init = null;
    if (this.eat(':')) type = this.type();
    if (this.eat('=')) init = this.expr();
    this.expect(';', 'after variable declaration');
    return { kind: 'Let', mutable, name: nameTok.text, type, init, span: nameTok };
  }

  ifStmt() {
    const t = this.next();
    const cond = this.condition('if');
    const then = this.block();
    let otherwise = null;
    if (this.eat('else')) {
      if (this.is('if')) otherwise = this.ifStmt();
      else if (this.is('{')) otherwise = this.block();
      else throw this.error(`expected '{' or 'if' after 'else', found ${this.describe(this.peek())}`);
    }
    return { kind: 'If', cond, then, else: otherwise, span: t };
  }

  forStmt() {
    const t = this.next();
    const nameTok = this.ident('a loop variable');
    this.expect('in', "in for loop (for loops look like 'for i in 0..10 { }')");
    const start = this.expr();
    let inclusive = false;
    if (this.eat('..=')) inclusive = true;
    else this.expect('..', "in for loop range (ranges look like 'a..b' or 'a..=b')");
    const end = this.expr();
    if (!this.is('{')) throw this.error(`expected '{' after for loop range, found ${this.describe(this.peek())}`);
    const body = this.block();
    return { kind: 'For', name: nameTok.text, nameSpan: nameTok, start, end, inclusive, body, span: t };
  }

  // ---------------------------------------------------------- expressions

  expr() {
    const cond = this.binary(1);
    if (this.is('?')) {
      const q = this.next();
      const then = this.expr();
      this.expect(':', "in conditional expression (cond ? a : b)");
      const otherwise = this.expr();
      return { kind: 'Ternary', cond, then, else: otherwise, span: join(cond.span, otherwise.span), opSpan: q };
    }
    return cond;
  }

  binary(minPrec) {
    let left = this.cast();
    for (;;) {
      const t = this.peek();
      const prec = t.kind === 'punct' ? BINARY_PREC[t.text] : undefined;
      if (prec === undefined || prec < minPrec) return left;
      this.next();
      const right = this.binary(prec + 1);
      left = { kind: 'Binary', op: t.text, left, right, span: join(left.span, right.span), opSpan: t };
    }
  }

  cast() {
    let e = this.unary();
    while (this.is('as')) {
      this.next();
      const type = this.type();
      e = { kind: 'Cast', expr: e, to: type, span: join(e.span, type.span) };
    }
    return e;
  }

  unary() {
    const t = this.peek();
    if (t.kind === 'punct' && (t.text === '-' || t.text === '!' || t.text === '~')) {
      this.next();
      const operand = this.unary();
      return { kind: 'Unary', op: t.text, operand, span: join(t, operand.span) };
    }
    return this.postfix();
  }

  postfix() {
    let e = this.primary();
    for (;;) {
      if (this.is('(') && e.kind === 'Field') {
        // value.method(args) or Type.method(args)
        this.next();
        const args = [];
        while (!this.is(')')) {
          args.push(this.expr());
          if (!this.eat(',')) break;
        }
        const close = this.expect(')', 'to close the argument list');
        e = { kind: 'MethodCall', receiver: e.target, name: e.name, nameSpan: e.nameSpan, args, span: join(e.span, close) };
      } else if (this.is('(')) {
        if (e.kind !== 'Ident') throw this.error('only named functions can be called');
        this.next();
        const args = [];
        while (!this.is(')')) {
          args.push(this.expr());
          if (!this.eat(',')) break;
        }
        const close = this.expect(')', 'to close the argument list');
        e = { kind: 'Call', callee: e.name, calleeSpan: e.span, args, span: join(e.span, close) };
      } else if (this.is('[')) {
        this.next();
        const index = this.expr();
        const close = this.expect(']', 'to close the index');
        e = { kind: 'Index', target: e, index, span: join(e.span, close) };
      } else if (this.is('.')) {
        this.next();
        const nameTok = this.ident('a field name');
        e = { kind: 'Field', target: e, name: nameTok.text, nameSpan: nameTok, span: join(e.span, nameTok) };
      } else {
        return e;
      }
    }
  }

  primary() {
    const t = this.peek();
    switch (t.kind) {
      case 'int':
        this.next();
        return { kind: 'Int', value: t.value, raw: t.raw, span: t };
      case 'float':
        this.next();
        return { kind: 'Float', value: t.value, span: t };
      case 'string':
        this.next();
        return { kind: 'Str', value: t.value, span: t };
      case 'ident':
        this.next();
        return { kind: 'Ident', name: t.text, span: t };
      case 'keyword':
        if (t.text === 'true' || t.text === 'false') {
          this.next();
          return { kind: 'Bool', value: t.text === 'true', span: t };
        }
        if (t.text === 'if') {
          throw this.error("'if' is a statement in Kiln; for a conditional value use 'cond ? a : b'");
        }
        break;
      case 'punct':
        if (t.text === '(') {
          this.next();
          const e = this.expr();
          this.expect(')', 'to close the parenthesis');
          return e;
        }
        if (t.text === '[') {
          this.next();
          const elements = [];
          while (!this.is(']')) {
            elements.push(this.expr());
            if (!this.eat(',')) break;
          }
          const close = this.expect(']', 'to close the array literal');
          return { kind: 'ArrayLit', elements, span: join(t, close) };
        }
        break;
    }
    throw this.error(`expected an expression, found ${this.describe(t)}`);
  }
}
