// Type checker and semantic analysis.
//
// Resolves names, infers and checks types, folds constants, lays the groundwork
// for dead-code elimination (each function records what it calls and touches),
// and reports friendly errors. The output is the same AST, annotated:
//   expr.type        'int' | 'float' | 'bool' | 'str' | 'void' | 'error'
//   expr.constValue  compile-time value, when known
//   expr.sym         resolved symbol for identifiers, calls and indexing

import { CompileError, suggest } from './errors.js';
import { INTRINSICS, IMPORTS, SPECIAL, FOLDABLE, nearest, isBuiltinName, signatureText } from './builtins.js';

const SCALARS = ['int', 'float', 'bool', 'str'];
const ARITH = new Set(['+', '-', '*', '/', '%']);
const COMPARE = new Set(['<', '<=', '>', '>=']);
const EQUALITY = new Set(['==', '!=']);
const BITWISE = new Set(['&', '|', '^']);
const SHIFT = new Set(['<<', '>>', '>>>']);
const MAX_MEMORY = 64 * 1024 * 1024;

export function check(units) {
  const c = new Checker();
  c.run(units);
  return c;
}

/** Saturating float -> int conversion (matches i32.trunc_sat_f64_s). */
export function satTrunc(v) {
  if (Number.isNaN(v)) return 0;
  if (v >= 2147483647) return 2147483647;
  if (v <= -2147483648) return -2147483648;
  return Math.trunc(v) | 0;
}

class Checker {
  constructor() {
    this.errors = [];
    this.top = new Map();
    this.funcs = [];
    this.globals = [];
    this.arrays = [];
    this.consts = [];
    this.fn = null;
    this.scopes = [];
    this.loops = 0;
    this.origin = 'user';
    this.main = null;
    this.frame = null;
  }

  err(msg, span, hint) {
    const e = new CompileError(msg, span, hint);
    e.origin = this.origin;
    this.errors.push(e);
  }

  run(units) {
    for (const { ast, origin } of units) {
      this.origin = origin;
      for (const item of ast.items) this.declare(item, origin);
    }
    for (const sym of this.top.values()) {
      this.origin = sym.origin;
      if (sym.kind === 'const') this.resolveConst(sym);
      else if (sym.kind === 'global') this.resolveGlobal(sym);
      else if (sym.kind === 'array') this.resolveArray(sym);
    }
    for (const fn of this.funcs) this.checkFn(fn);
    this.origin = 'user';
    this.checkEntryPoints();
  }

  // ------------------------------------------------------------ declarations

  declare(item, origin) {
    const name = item.name;
    const span = item.nameSpan ?? item.span;
    if (isBuiltinName(name)) {
      this.err(`'${name}' is a built-in function and can't be redefined`, span, 'pick a different name');
      return;
    }
    const existing = this.top.get(name);
    if (existing) {
      if (existing.origin === 'prelude' && origin === 'user') {
        this.err(`'${name}' is already defined by the standard prelude`, span, 'pick a different name');
      } else {
        this.err(`'${name}' is defined more than once`, span);
      }
      return;
    }
    let sym;
    if (item.kind === 'Fn') {
      sym = {
        kind: 'func', name, decl: item, origin, exported: item.exported,
        calls: new Set(), imports: new Set(), globals: new Set(), arrays: new Set(),
        locals: [], params: [], ret: 'void',
      };
      const seen = new Set();
      for (const p of item.params) {
        if (seen.has(p.name)) this.err(`parameter '${p.name}' is declared twice`, p.span);
        seen.add(p.name);
        sym.params.push({ name: p.name, type: this.scalarType(p.type) });
      }
      sym.ret = item.ret ? this.scalarType(item.ret) : 'void';
      this.funcs.push(sym);
    } else if (item.kind === 'Const' || (item.kind === 'Global' && !item.mutable && !isArrayDecl(item))) {
      // Top-level `let` is a named constant.
      sym = { kind: 'const', name, decl: item, origin, state: 'pending', type: 'error', value: undefined, untyped: false };
      this.consts.push(sym);
    } else if (isArrayDecl(item)) {
      sym = { kind: 'array', name, decl: item, origin, mutable: item.mutable, elem: 'error', size: 0, init: null };
      this.arrays.push(sym);
    } else {
      sym = { kind: 'global', name, decl: item, origin, type: 'error', value: undefined };
      this.globals.push(sym);
    }
    this.top.set(name, sym);
  }

  scalarType(node) {
    if (node.kind === 'ArrayType') {
      this.err('array types are only allowed for top-level variables', node.span, 'declare the array outside of any function');
      return 'error';
    }
    if (SCALARS.includes(node.name)) return node.name;
    const s = suggest(node.name, SCALARS);
    this.err(`unknown type '${node.name}'`, node.span, s ? `did you mean '${s}'?` : `types are: ${SCALARS.join(', ')}`);
    return 'error';
  }

  inConstContext(origin, f) {
    const save = [this.fn, this.scopes, this.loops, this.origin];
    this.fn = null;
    this.scopes = [];
    this.loops = 0;
    this.origin = origin;
    try {
      return f();
    } finally {
      [this.fn, this.scopes, this.loops, this.origin] = save;
    }
  }

  resolveConst(sym) {
    if (sym.state === 'done') return;
    if (sym.state === 'busy') {
      this.err(`constant '${sym.name}' depends on itself`, sym.decl.span);
      sym.state = 'done';
      return;
    }
    sym.state = 'busy';
    this.inConstContext(sym.origin, () => {
      const d = sym.decl;
      if (!d.init) {
        this.err(`top-level 'let ${sym.name}' needs a value`, d.span, `use 'var ${sym.name}: type;' for a mutable global that starts at zero`);
        return;
      }
      let t = this.expr(d.init);
      if (d.type) t = this.coerce(d.init, t, this.scalarType(d.type), `constant '${sym.name}'`);
      if (t === 'void') {
        this.err(`constant '${sym.name}' has no value`, d.init.span);
        t = 'error';
      }
      if (t !== 'error' && d.init.constValue === undefined) {
        this.err(`the value of '${sym.name}' must be known at compile time`, d.init.span, "use 'var' and assign it inside main() instead");
        t = 'error';
      }
      sym.type = t;
      sym.value = d.init.constValue;
      sym.untyped = !d.type && t === 'int';
    });
    sym.state = 'done';
  }

  resolveGlobal(sym) {
    this.inConstContext(sym.origin, () => {
      const d = sym.decl;
      let t = d.type ? this.scalarType(d.type) : null;
      if (d.init) {
        const it = this.expr(d.init);
        t = t ? this.coerce(d.init, it, t, `global '${sym.name}'`) : it;
        if (t !== 'error' && d.init.constValue === undefined) {
          this.err(`the initial value of global '${sym.name}' must be known at compile time`, d.init.span, 'assign it inside main() instead');
          t = 'error';
        }
        sym.value = d.init.constValue;
      } else if (!t) {
        this.err(`global '${sym.name}' needs a type or a value`, d.span, `e.g. 'var ${sym.name}: int;' or 'var ${sym.name} = 0;'`);
        t = 'error';
      } else {
        sym.value = t === 'float' ? 0 : t === 'bool' ? false : t === 'str' ? '' : 0;
      }
      if (t === 'void') t = 'error';
      sym.type = t;
    });
  }

  resolveArray(sym) {
    this.inConstContext(sym.origin, () => {
      const d = sym.decl;
      let elem = null;
      let size = null;
      if (d.type) {
        if (d.type.kind !== 'ArrayType') {
          this.err(`'${sym.name}' is initialized with an array but declared as ${d.type.name}`, d.type.span, `write the type as [${d.type.name}; N]`);
          return;
        }
        elem = this.scalarType(d.type.elem);
        if (elem === 'str') {
          this.err('arrays of strings are not supported', d.type.elem.span);
          elem = 'error';
        }
        const st = this.expr(d.type.size);
        if (st !== 'int' || d.type.size.constValue === undefined) {
          if (st !== 'error') this.err('array size must be a constant int', d.type.size.span);
          return;
        }
        size = d.type.size.constValue;
        if (size <= 0) {
          this.err(`array size must be positive, found ${size}`, d.type.size.span);
          return;
        }
      }
      let init = null;
      if (d.init) {
        if (d.init.kind !== 'ArrayLit') {
          this.err(`arrays are initialized with a list like [1, 2, 3]`, d.init.span);
          return;
        }
        const els = d.init.elements;
        if (!els.length && !d.type) {
          this.err(`can't infer the type of an empty array`, d.init.span, `write it like 'var ${sym.name}: [int; 16];'`);
          return;
        }
        const types = els.map((e) => this.expr(e));
        if (!elem) {
          elem = types.includes('float') ? 'float' : types[0];
          if (elem === 'str') {
            this.err('arrays of strings are not supported', d.init.span);
            return;
          }
        }
        init = [];
        els.forEach((e, i) => {
          const t = this.coerce(e, types[i], elem, 'array element');
          if (t !== 'error' && e.constValue === undefined) this.err('array elements must be compile-time constants', e.span);
          init.push(e.constValue ?? 0);
        });
        if (size === null) size = els.length;
        else if (els.length > size) this.err(`array '${sym.name}' has room for ${size} elements but ${els.length} were given`, d.init.span);
      }
      if (elem === 'error' || elem === null || size === null) return;
      const bytes = size * (elem === 'float' ? 8 : 4);
      if (bytes > MAX_MEMORY) {
        this.err(`array '${sym.name}' is too large (${bytes} bytes; the limit is ${MAX_MEMORY})`, d.span);
        return;
      }
      sym.elem = elem;
      sym.size = size;
      sym.init = init;
    });
  }

  checkEntryPoints() {
    const main = this.top.get('main');
    const frame = this.top.get('frame');
    if (main && main.origin === 'user' && main.kind === 'func') {
      if (main.params.length || main.ret !== 'void') {
        this.err("'main' must take no parameters and return nothing: fn main() { ... }", main.decl.span);
      }
      this.main = main;
    }
    if (frame && frame.origin === 'user' && frame.kind === 'func') {
      const ok = frame.ret === 'void' && (frame.params.length === 0 || (frame.params.length === 1 && frame.params[0].type === 'float'));
      if (!ok) this.err("'frame' must look like: fn frame(t: float) { ... }", frame.decl.span, 't is the time in seconds since the program started');
      this.frame = frame;
    }
    const exported = this.funcs.some((f) => f.exported);
    if (!this.main && !this.frame && !exported && this.errors.length === 0) {
      this.err('nothing to run: define fn main() or fn frame(t: float)', { start: 0, end: 1, line: 1, col: 1 },
        'main() runs once at startup; frame(t) runs every animation frame');
    }
  }

  // --------------------------------------------------------------- functions

  checkFn(sym) {
    this.fn = sym;
    this.origin = sym.origin;
    this.scopes = [new Map()];
    this.loops = 0;
    sym.decl.params.forEach((p, i) => this.declareLocal(p.name, sym.params[i].type, false, false));
    this.block(sym.decl.body);
    if (sym.ret !== 'void' && sym.ret !== 'error' && !returns(sym.decl.body)) {
      this.err(`function '${sym.name}' must return a ${sym.ret} on every path`, sym.decl.endSpan,
        `add 'return <${sym.ret}>;' before the closing brace`);
    }
    this.fn = null;
  }

  declareLocal(name, type, mutable, loopVar) {
    const sym = { kind: 'local', name, type, mutable, loopVar, index: this.fn.locals.length };
    this.fn.locals.push({ name, type });
    this.scopes[this.scopes.length - 1].set(name, sym);
    return sym;
  }

  lookupLocal(name) {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const s = this.scopes[i].get(name);
      if (s) return s;
    }
    return null;
  }

  lookup(name) {
    return this.lookupLocal(name) ?? this.top.get(name) ?? null;
  }

  visibleNames() {
    const names = new Set(this.top.keys());
    for (const s of this.scopes) for (const k of s.keys()) names.add(k);
    return names;
  }

  // -------------------------------------------------------------- statements

  block(b) {
    this.scopes.push(new Map());
    for (const s of b.body) this.stmt(s);
    this.scopes.pop();
  }

  cond(e, what) {
    const t = this.expr(e);
    if (t !== 'bool' && t !== 'error') {
      const hint = t === 'int' ? 'compare explicitly, e.g. x != 0' : undefined;
      this.err(`${what} condition must be a bool, found ${t}`, e.span, hint);
    }
  }

  stmt(s) {
    switch (s.kind) {
      case 'Let': {
        let t;
        if (s.type) {
          t = this.scalarType(s.type);
          if (s.init) this.coerce(s.init, this.expr(s.init), t, `'${s.name}'`);
          else if (!s.mutable) this.err(`'let ${s.name}' needs a value`, s.span, `use 'var ${s.name}: ${t};' for a variable that starts at zero`);
        } else if (s.init) {
          t = this.expr(s.init);
        } else {
          this.err(`'${s.name}' needs a type or a value`, s.span, `e.g. 'var ${s.name} = 0;' or 'var ${s.name}: float;'`);
          t = 'error';
        }
        if (t === 'void') {
          this.err(`can't store the result of a function that returns nothing`, s.init.span);
          t = 'error';
        }
        s.sym = this.declareLocal(s.name, t, s.mutable, false);
        return;
      }
      case 'Assign':
        return this.assign(s);
      case 'If':
        this.cond(s.cond, 'if');
        this.block(s.then);
        if (s.else) s.else.kind === 'If' ? this.stmt(s.else) : this.block(s.else);
        return;
      case 'While':
        this.cond(s.cond, 'while');
        this.loops++;
        this.block(s.body);
        this.loops--;
        return;
      case 'For': {
        for (const e of [s.start, s.end]) {
          const t = this.expr(e);
          if (t !== 'int' && t !== 'error') this.err(`for loop bounds must be ints, found ${t}`, e.span, t === 'float' ? "convert with 'as int'" : undefined);
        }
        this.scopes.push(new Map());
        s.sym = this.declareLocal(s.name, 'int', false, true);
        s.endLocal = this.declareLocal(`${s.name}.end`, 'int', false, true);
        this.scopes[this.scopes.length - 1].delete(`${s.name}.end`);
        this.loops++;
        this.block(s.body);
        this.loops--;
        this.scopes.pop();
        return;
      }
      case 'Break':
      case 'Continue':
        if (this.loops === 0) this.err(`'${s.kind.toLowerCase()}' can only be used inside a loop`, s.span);
        return;
      case 'Return': {
        const ret = this.fn.ret;
        if (s.value) {
          const t = this.expr(s.value);
          if (ret === 'void') {
            if (t !== 'error') this.err(`'${this.fn.name}' doesn't return a value`, s.value.span, `remove the value, or declare a return type like 'fn ${this.fn.name}(...) -> ${t}'`);
          } else {
            this.coerce(s.value, t, ret, 'return value');
          }
        } else if (ret !== 'void' && ret !== 'error') {
          this.err(`'${this.fn.name}' must return a ${ret}`, s.span);
        }
        return;
      }
      case 'ExprStmt':
        this.expr(s.expr);
        return;
      case 'Block':
        this.block(s);
        return;
      default:
        throw new Error(`unknown statement ${s.kind}`);
    }
  }

  assign(s) {
    const tgt = s.target;
    let targetType = 'error';
    if (tgt.kind === 'Ident') {
      const sym = this.lookup(tgt.name);
      tgt.sym = sym;
      if (!sym) {
        this.unknownName(tgt.name, tgt.span);
      } else if (sym.kind === 'local') {
        if (sym.loopVar) this.err(`can't assign to loop variable '${sym.name}'`, tgt.span);
        else if (!sym.mutable) this.err(`can't assign twice to immutable variable '${sym.name}'`, tgt.span, `declare it with 'var ${sym.name}' to make it mutable`);
        targetType = sym.type;
      } else if (sym.kind === 'global') {
        this.fn.globals.add(sym);
        targetType = sym.type;
      } else if (sym.kind === 'const') {
        this.err(`can't assign to constant '${sym.name}'`, tgt.span, sym.decl.kind === 'Global' ? `declare it with 'var ${sym.name}' to make it mutable` : undefined);
      } else if (sym.kind === 'array') {
        this.err(`can't assign to a whole array`, tgt.span, `assign one element at a time: ${sym.name}[i] = ...`);
      } else {
        this.err(`can't assign to function '${sym.name}'`, tgt.span);
      }
      tgt.type = targetType;
    } else {
      targetType = this.expr(tgt);
      if (tgt.indexKind === 'str') {
        this.err('strings are immutable', tgt.span);
        targetType = 'error';
      } else if (tgt.indexKind === 'array' && !tgt.sym.mutable) {
        this.err(`can't modify '${tgt.sym.name}' because it was declared with 'let'`, tgt.span, `declare it with 'var ${tgt.sym.name}' to make it mutable`);
      }
    }
    s.targetType = targetType;
    const vt = this.expr(s.value);
    if (s.op === '=') {
      this.coerce(s.value, vt, targetType, `assignment to '${describeTarget(tgt)}'`);
    } else {
      const fake = { kind: 'Binary', op: s.op, left: { kind: 'Placeholder', type: targetType, span: tgt.span }, right: s.value, span: s.span, opSpan: s.span };
      const rt = this.binaryType(fake, targetType, vt);
      if (rt !== 'error' && targetType !== 'error' && rt !== targetType) {
        this.err(`'${s.op}=' would change the type of '${describeTarget(tgt)}' from ${targetType} to ${rt}`, s.span);
      }
      s.checkZero = fake.checkZero;
    }
  }

  // ------------------------------------------------------------- expressions

  expr(e) {
    const t = this.exprInner(e);
    e.type = t;
    if (t !== 'error' && t !== 'void') this.fold(e);
    return t;
  }

  unknownName(name, span) {
    const s = suggest(name, [...this.visibleNames(), ...Object.keys(INTRINSICS), ...SPECIAL, ...Object.keys(IMPORTS)]);
    this.err(`unknown name '${name}'`, span, s ? `did you mean '${s}'?` : undefined);
  }

  exprInner(e) {
    switch (e.kind) {
      case 'Int':
        return 'int';
      case 'Float':
        return 'float';
      case 'Bool':
        return 'bool';
      case 'Str':
        return 'str';
      case 'Placeholder':
        return e.type;
      case 'Ident': {
        const sym = this.lookup(e.name);
        e.sym = sym;
        if (!sym) {
          this.unknownName(e.name, e.span);
          return 'error';
        }
        switch (sym.kind) {
          case 'local':
            return sym.type;
          case 'const':
            this.resolveConst(sym);
            return sym.type;
          case 'global':
            if (this.fn) this.fn.globals.add(sym);
            else {
              this.err(`global variable '${sym.name}' can't be used in a constant expression`, e.span);
              return 'error';
            }
            return sym.type;
          case 'array':
            this.err(`'${sym.name}' is an array; use an element like ${sym.name}[i]`, e.span, `len(${sym.name}) gives its length`);
            return 'error';
          case 'func':
            this.err(`'${sym.name}' is a function; call it like ${sym.name}(...)`, e.span);
            return 'error';
        }
        return 'error';
      }
      case 'Unary': {
        const t = this.expr(e.operand);
        if (t === 'error') return t;
        if (e.op === '-' && (t === 'int' || t === 'float')) return t;
        if (e.op === '!' && t === 'bool') return t;
        if (e.op === '~' && t === 'int') return t;
        const hint = e.op === '!' && t === 'int' ? "for ints use '~' (bitwise not) or compare with '== 0'" : undefined;
        this.err(`can't apply '${e.op}' to ${t}`, e.span, hint);
        return 'error';
      }
      case 'Binary': {
        const lt = this.expr(e.left);
        const rt = this.expr(e.right);
        return this.binaryType(e, lt, rt);
      }
      case 'Cast': {
        const from = this.expr(e.expr);
        const to = this.scalarType(e.to);
        if (from === 'error' || to === 'error') return 'error';
        if (from === 'str' || to === 'str' || from === 'void') {
          this.err(`can't convert ${from} to ${to}`, e.span);
          return 'error';
        }
        return to;
      }
      case 'Ternary': {
        this.cond(e.cond, 'conditional');
        const a = this.expr(e.then);
        const b = this.expr(e.else);
        if (a === 'error' || b === 'error') return 'error';
        const t = this.unify(e.then, a, e.else, b);
        if (!t || t === 'void') {
          this.err(`both sides of '? :' must have the same type, found ${a} and ${b}`, e.span);
          return 'error';
        }
        return t;
      }
      case 'Call':
        return this.call(e);
      case 'Index': {
        const idxType = this.expr(e.index);
        if (idxType !== 'int' && idxType !== 'error') {
          this.err(`array index must be an int, found ${idxType}`, e.index.span, idxType === 'float' ? "convert with 'as int'" : undefined);
        }
        if (e.target.kind !== 'Ident') {
          this.err('only arrays and strings can be indexed', e.target.span);
          return 'error';
        }
        const sym = this.lookup(e.target.name);
        if (sym && sym.kind === 'array') {
          e.sym = sym;
          e.indexKind = 'array';
          if (this.fn) {
            this.fn.arrays.add(sym);
            this.fn.imports.add('__trap');
          } else {
            this.err('arrays can\'t be read in constant expressions', e.span);
            return 'error';
          }
          return sym.elem;
        }
        const t = this.expr(e.target);
        if (t === 'error') return t;
        if (t === 'str') {
          e.indexKind = 'str';
          if (this.fn) this.fn.imports.add('__trap');
          return 'int';
        }
        this.err(`can't index into a value of type ${t}`, e.target.span);
        return 'error';
      }
      case 'ArrayLit':
        this.err('array literals can only initialize top-level arrays', e.span, "declare it at top level: let values = [1, 2, 3];");
        return 'error';
    }
    throw new Error(`unknown expression ${e.kind}`);
  }

  binaryType(e, lt, rt) {
    const op = e.op;
    if (lt === 'error' || rt === 'error') return 'error';
    const bad = (hint) => {
      this.err(`can't apply '${op}' to ${lt} and ${rt}`, e.opSpan ?? e.span, hint);
      return 'error';
    };
    if (op === '&&' || op === '||') {
      if (lt === 'bool' && rt === 'bool') return 'bool';
      return bad(`'${op}' works on bools; compare ints explicitly, e.g. x != 0`);
    }
    if (ARITH.has(op) || COMPARE.has(op)) {
      const t = this.unify(e.left, lt, e.right, rt);
      if (t !== 'int' && t !== 'float') {
        if ((lt === 'int' && rt === 'float') || (lt === 'float' && rt === 'int')) {
          return bad(`Kiln never converts silently; write 'x as float' or 'x as int'`);
        }
        return bad();
      }
      if (t === 'int' && (op === '/' || op === '%')) {
        const d = e.right.constValue;
        if (d === 0) {
          this.err('division by zero', e.right.span);
          return 'error';
        }
        if (d === undefined) {
          e.checkZero = true;
          if (this.fn) this.fn.imports.add('__trap');
        }
      }
      return COMPARE.has(op) ? 'bool' : t;
    }
    if (EQUALITY.has(op)) {
      const t = this.unify(e.left, lt, e.right, rt);
      if (!t) return bad();
      if (t === 'str') return bad('strings can\'t be compared; compare characters with s[i] instead');
      if (t === 'void') return bad();
      return 'bool';
    }
    if (BITWISE.has(op)) {
      if (lt === 'int' && rt === 'int') return 'int';
      if (lt === 'bool' && rt === 'bool') return 'bool';
      return bad(`'${op}' works on two ints or two bools`);
    }
    if (SHIFT.has(op)) {
      if (lt === 'int' && rt === 'int') return 'int';
      return bad('shifts work on ints');
    }
    throw new Error(`unknown operator ${op}`);
  }

  // Integer literals (and untyped integer constants) adapt to float contexts:
  // `x * 2` works when x is a float. Everything else needs an explicit `as`.
  coercible(e) {
    switch (e.kind) {
      case 'Int':
        return true;
      case 'Ident':
        return e.sym?.kind === 'const' && e.sym.untyped;
      case 'Unary':
        return e.op === '-' && this.coercible(e.operand);
      case 'Binary':
        return (e.op === '+' || e.op === '-' || e.op === '*') && this.coercible(e.left) && this.coercible(e.right);
    }
    return false;
  }

  floatValue(e) {
    switch (e.kind) {
      case 'Int':
        return e.raw ?? e.value;
      case 'Ident':
        return e.sym.value;
      case 'Unary':
        return -this.floatValue(e.operand);
      case 'Binary': {
        const a = this.floatValue(e.left);
        const b = this.floatValue(e.right);
        return e.op === '+' ? a + b : e.op === '-' ? a - b : a * b;
      }
    }
    throw new Error('not coercible');
  }

  toFloat(e) {
    const v = this.floatValue(e);
    for (const k of Object.keys(e)) if (k !== 'span') delete e[k];
    Object.assign(e, { kind: 'Float', value: v, type: 'float', constValue: v });
  }

  unify(a, ta, b, tb) {
    if (ta === tb) return ta;
    if (ta === 'float' && tb === 'int' && this.coercible(b)) {
      this.toFloat(b);
      return 'float';
    }
    if (ta === 'int' && tb === 'float' && this.coercible(a)) {
      this.toFloat(a);
      return 'float';
    }
    return null;
  }

  coerce(e, t, want, ctx) {
    if (t === 'error' || want === 'error' || t === want) return want;
    if (want === 'float' && t === 'int' && this.coercible(e)) {
      this.toFloat(e);
      return want;
    }
    let hint;
    if ((t === 'int' && want === 'float') || (t === 'float' && want === 'int')) hint = `convert it with 'as ${want}'`;
    if (t === 'void') {
      this.err(`${ctx}: expected ${want}, but this expression has no value`, e.span);
    } else {
      this.err(`${ctx}: expected ${want}, found ${t}`, e.span, hint);
    }
    return want;
  }

  // ------------------------------------------------------------------ calls

  call(e) {
    const name = e.callee;
    const local = this.lookupLocal(name);
    if (local) {
      e.args.forEach((a) => this.expr(a));
      this.err(`'${name}' is a variable, not a function`, e.calleeSpan);
      return 'error';
    }
    const sym = this.top.get(name);
    if (sym) {
      if (sym.kind !== 'func') {
        e.args.forEach((a) => this.expr(a));
        this.err(`'${name}' is not a function`, e.calleeSpan);
        return 'error';
      }
      if (!this.fn) {
        this.err(`functions can't be called in constant expressions`, e.span);
        return 'error';
      }
      this.checkArgs(e, sym.params.map((p) => p.type), signatureText(name, sym.params.map((p) => `${p.name}: ${p.type}`), sym.ret));
      this.fn.calls.add(sym);
      e.sym = sym;
      return sym.ret;
    }
    if (name === 'print') return this.printCall(e);
    if (name === 'select') return this.selectCall(e);
    if (name === 'len') return this.lenCall(e);
    if (name in INTRINSICS) return this.intrinsicCall(e, INTRINSICS[name]);
    if (name in IMPORTS && !name.startsWith('__')) {
      const sig = IMPORTS[name];
      if (!this.fn && !(name in FOLDABLE)) {
        this.err(`'${name}' can't be used in a constant expression`, e.span);
        return 'error';
      }
      this.checkArgs(e, sig.params, signatureText(name, sig.params, sig.ret));
      if (this.fn) this.fn.imports.add(name);
      e.builtin = 'import';
      return sig.ret;
    }
    e.args.forEach((a) => this.expr(a));
    const s = suggest(name, [...this.top.keys(), ...Object.keys(INTRINSICS), ...SPECIAL, ...Object.keys(IMPORTS)]);
    this.err(`unknown function '${name}'`, e.calleeSpan, s ? `did you mean '${s}'?` : undefined);
    return 'error';
  }

  checkArgs(e, params, sigText) {
    const types = e.args.map((a) => this.expr(a));
    if (types.length !== params.length) {
      this.err(`'${e.callee}' takes ${params.length} argument${params.length === 1 ? '' : 's'} but ${types.length} ${types.length === 1 ? 'was' : 'were'} given`, e.span, `signature: ${sigText}`);
      return;
    }
    e.args.forEach((a, i) => this.coerce(a, types[i], params[i], `argument ${i + 1} of '${e.callee}'`));
  }

  printCall(e) {
    if (!this.fn) {
      this.err(`'print' can't be used in a constant expression`, e.span);
      return 'error';
    }
    for (const a of e.args) {
      const t = this.expr(a);
      if (t === 'void') this.err(`can't print something that has no value`, a.span);
      else if (t !== 'error') this.fn.imports.add(`__print_${t[0]}`);
    }
    this.fn.imports.add('__print_end');
    e.builtin = 'print';
    return 'void';
  }

  selectCall(e) {
    if (e.args.length !== 3) {
      e.args.forEach((a) => this.expr(a));
      this.err(`'select' takes 3 arguments (cond, a, b) but ${e.args.length} were given`, e.span);
      return 'error';
    }
    this.cond(e.args[0], 'select');
    const a = this.expr(e.args[1]);
    const b = this.expr(e.args[2]);
    if (a === 'error' || b === 'error') return 'error';
    const t = this.unify(e.args[1], a, e.args[2], b);
    if (!t || t === 'void') {
      this.err(`both values given to 'select' must have the same type, found ${a} and ${b}`, e.span);
      return 'error';
    }
    e.builtin = 'select';
    return t;
  }

  lenCall(e) {
    e.builtin = 'len';
    if (e.args.length !== 1) {
      e.args.forEach((a) => this.expr(a));
      this.err(`'len' takes 1 argument but ${e.args.length} were given`, e.span);
      return 'error';
    }
    const a = e.args[0];
    if (a.kind === 'Ident') {
      const sym = this.lookup(a.name);
      if (sym && sym.kind === 'array') {
        e.lenOf = sym;
        return 'int';
      }
    }
    const t = this.expr(a);
    if (t === 'str') return 'int';
    if (t !== 'error') this.err(`'len' works on arrays and strings, not ${t}`, a.span);
    return 'error';
  }

  intrinsicCall(e, overloads) {
    const types = e.args.map((a) => this.expr(a));
    if (types.includes('error')) return 'error';
    const n = types.length;
    let match = overloads.find(([ps]) => ps.length === n && ps.every((p, i) => p === types[i]));
    if (!match) {
      match = overloads.find(([ps]) => ps.length === n && ps.every((p, i) => p === types[i] || (p === 'float' && types[i] === 'int' && this.coercible(e.args[i]))));
      if (match) match[0].forEach((p, i) => p !== types[i] && this.toFloat(e.args[i]));
    }
    if (!match) {
      const avail = overloads.map(([ps, r]) => signatureText(e.callee, ps, r)).join(', ');
      this.err(`no version of '${e.callee}' takes (${types.join(', ')})`, e.span, `available: ${avail}`);
      return 'error';
    }
    e.builtin = 'intrinsic';
    e.overload = match;
    return match[1];
  }

  // ---------------------------------------------------------- const folding

  fold(e) {
    switch (e.kind) {
      case 'Int':
      case 'Float':
      case 'Bool':
      case 'Str':
        e.constValue = e.value;
        return;
      case 'Ident':
        if (e.sym?.kind === 'const') e.constValue = e.sym.value;
        return;
      case 'Unary': {
        const v = e.operand.constValue;
        if (v === undefined) return;
        if (e.op === '-') e.constValue = e.type === 'int' ? -v | 0 : -v;
        else if (e.op === '!') e.constValue = !v;
        else e.constValue = ~v;
        return;
      }
      case 'Binary': {
        const l = e.left.constValue;
        const r = e.right.constValue;
        if (l === undefined || r === undefined) return;
        e.constValue = evalBinary(e.op, e.left.type, l, r);
        return;
      }
      case 'Cast': {
        const v = e.expr.constValue;
        if (v === undefined) return;
        e.constValue = castValue(v, e.expr.type, e.type);
        return;
      }
      case 'Ternary': {
        const c = e.cond.constValue;
        if (c === undefined) return;
        const v = (c ? e.then : e.else).constValue;
        if (v !== undefined) e.constValue = v;
        return;
      }
      case 'Call': {
        if (e.builtin === 'len' && e.lenOf) {
          e.constValue = e.lenOf.size;
          return;
        }
        const args = e.args.map((a) => a.constValue);
        if (args.some((a) => a === undefined)) return;
        if (e.builtin === 'select') {
          e.constValue = args[0] ? args[1] : args[2];
        } else if (e.builtin === 'intrinsic') {
          const isInt = e.type === 'int';
          const name = e.callee;
          let v;
          if (name === 'abs') v = isInt ? Math.abs(args[0]) | 0 : Math.abs(args[0]);
          else if (name === 'min') v = Math.min(args[0], args[1]);
          else if (name === 'max') v = Math.max(args[0], args[1]);
          else if (name === 'clamp') v = Math.min(Math.max(args[0], args[1]), args[2]);
          else if (name === 'round') v = nearest(args[0]);
          else v = FOLDABLE[name](args[0]);
          e.constValue = v;
        } else if (e.builtin === 'import' && e.callee in FOLDABLE) {
          e.constValue = FOLDABLE[e.callee](...args);
        }
        return;
      }
    }
  }
}

function isArrayDecl(item) {
  return item.kind === 'Global' && (item.type?.kind === 'ArrayType' || item.init?.kind === 'ArrayLit');
}

function describeTarget(t) {
  return t.kind === 'Ident' ? t.name : `${t.target.name}[...]`;
}

export function evalBinary(op, t, l, r) {
  if (t === 'int') {
    switch (op) {
      case '+': return (l + r) | 0;
      case '-': return (l - r) | 0;
      case '*': return Math.imul(l, r);
      case '/': return (l / r) | 0;
      case '%': return (l % r) | 0;
      case '&': return l & r;
      case '|': return l | r;
      case '^': return l ^ r;
      case '<<': return l << (r & 31);
      case '>>': return l >> (r & 31);
      case '>>>': return (l >>> (r & 31)) | 0;
    }
  } else if (t === 'float') {
    switch (op) {
      case '+': return l + r;
      case '-': return l - r;
      case '*': return l * r;
      case '/': return l / r;
      case '%': return l - r * Math.trunc(l / r);
    }
  } else if (t === 'bool') {
    switch (op) {
      case '&&': case '&': return l && r;
      case '||': case '|': return l || r;
      case '^': return l !== r;
    }
  }
  switch (op) {
    case '==': return l === r;
    case '!=': return l !== r;
    case '<': return l < r;
    case '<=': return l <= r;
    case '>': return l > r;
    case '>=': return l >= r;
  }
  throw new Error(`cannot fold ${op} on ${t}`);
}

export function castValue(v, from, to) {
  if (from === to) return v;
  if (to === 'float') return from === 'bool' ? (v ? 1 : 0) : v;
  if (to === 'int') return from === 'bool' ? (v ? 1 : 0) : satTrunc(v);
  if (to === 'bool') return v !== 0;
  throw new Error(`bad cast ${from} -> ${to}`);
}

/** Does control never fall off the end of this statement? */
export function returns(s) {
  switch (s.kind) {
    case 'Return':
      return true;
    case 'Block':
      return s.body.some(returns);
    case 'If':
      return !!s.else && returns(s.then) && returns(s.else);
    case 'While':
      return s.cond.constValue === true && !hasBreak(s.body);
  }
  return false;
}

function hasBreak(s) {
  switch (s.kind) {
    case 'Break':
      return true;
    case 'Block':
      return s.body.some(hasBreak);
    case 'If':
      return hasBreak(s.then) || (!!s.else && hasBreak(s.else));
  }
  return false; // breaks inside nested loops belong to those loops
}
