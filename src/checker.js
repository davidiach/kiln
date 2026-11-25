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
import {
  isStruct, leafTypes, leafCount, numericKind, layoutStruct, sizeOf,
  isVector, isMask, laneType, laneCount, laneNames, maskOf, vectorOf, VECTORS,
} from './types.js';

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
    this.structs = [];
    this.impls = [];
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
    for (const s of this.structs) {
      this.origin = s.origin;
      this.resolveStruct(s);
    }
    for (const { item, origin } of this.impls) {
      this.origin = origin;
      this.declareImpl(item, origin);
    }
    for (const f of this.funcs) {
      this.origin = f.origin;
      this.resolveSignature(f);
    }
    for (const S of this.structs) {
      this.origin = S.origin;
      this.checkOperators(S);
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
    if (item.kind === 'Impl') {
      this.impls.push({ item, origin }); // handled once all structs are known
      return;
    }
    const name = item.name;
    const span = item.nameSpan ?? item.span;
    if (isVector(name)) {
      this.err(`'${name}' is a built-in type and can't be redefined`, span, 'pick a different name');
      return;
    }
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
        locals: [], params: [], ret: 'void', paramLeafCount: 0,
      };
      this.funcs.push(sym);
    } else if (item.kind === 'Struct') {
      sym = {
        kind: 'struct', name, decl: item, origin, fields: [], state: 'pending', methods: new Map(), operators: [],
        toString() {
          return this.name;
        },
      };
      this.structs.push(sym);
    } else if (item.kind === 'Const' || (item.kind === 'Global' && !item.mutable && !isArrayDecl(item))) {
      // Top-level `let` is a named constant.
      sym = { kind: 'const', name, decl: item, origin, state: 'pending', type: 'error', value: undefined, untyped: false };
      this.consts.push(sym);
    } else if (isArrayDecl(item)) {
      sym = { kind: 'array', name, decl: item, origin, mutable: item.mutable, elem: 'error', size: 0, init: null, state: 'pending' };
      this.arrays.push(sym);
    } else {
      sym = { kind: 'global', name, decl: item, origin, type: 'error', value: undefined };
      this.globals.push(sym);
    }
    this.top.set(name, sym);
  }

  /** Resolve a type annotation to a scalar type name or a struct symbol. */
  valueType(node, inStruct = false) {
    if (node.kind === 'ArrayType') {
      if (inStruct) this.err("struct fields can't be arrays", node.span, 'use an array of structs instead: var items: [Item; 16];');
      else this.err('array types are only allowed for top-level variables', node.span, 'declare the array outside of any function');
      return 'error';
    }
    if (SCALARS.includes(node.name) || isVector(node.name)) return node.name;
    const sym = this.top.get(node.name);
    if (sym && sym.kind === 'struct') return this.resolveStruct(sym) ? sym : 'error';
    const names = [...SCALARS, ...VECTORS, ...this.structs.map((s) => s.name)];
    const s = suggest(node.name, names);
    this.err(`unknown type '${node.name}'`, node.span, s ? `did you mean '${s}'?` : `types are: ${names.join(', ')}`);
    return 'error';
  }

  resolveStruct(s) {
    if (s.state === 'done') return true;
    if (s.state === 'busy') {
      this.err(`struct '${s.name}' contains itself`, s.decl.nameSpan, "a struct can't contain itself, directly or through another struct");
      return false;
    }
    s.state = 'busy';
    const save = this.origin;
    this.origin = s.origin;
    const seen = new Set();
    if (!s.decl.fields.length) this.err(`struct '${s.name}' needs at least one field`, s.decl.nameSpan);
    for (const f of s.decl.fields) {
      if (seen.has(f.name)) this.err(`field '${f.name}' is declared twice`, f.span);
      seen.add(f.name);
      s.fields.push({ name: f.name, type: this.valueType(f.type, true) });
    }
    layoutStruct(s);
    s.state = 'done';
    this.origin = save;
    return true;
  }

  /** Methods are functions named like 'Vec3.length', registered on their struct. */
  declareImpl(item, origin) {
    const S = this.top.get(item.target);
    if (!S || S.kind !== 'struct') {
      if (SCALARS.includes(item.target)) {
        this.err(`methods can only be added to structs, not to ${item.target}`, item.targetSpan);
      } else {
        const s = suggest(item.target, this.structs.map((x) => x.name));
        this.err(`unknown struct '${item.target}'`, item.targetSpan, s ? `did you mean '${s}'?` : undefined);
      }
      return;
    }
    for (const m of item.methods) {
      if (m.isOperator) {
        this.declareOperator(S, m, origin);
        continue;
      }
      if (S.methods.has(m.name)) {
        this.err(`${S.name} already has a method named '${m.name}'`, m.nameSpan);
        continue;
      }
      if (S.decl.fields.some((f) => f.name === m.name)) {
        this.err(`${S.name} has a field named '${m.name}', so a method can't use that name too`, m.nameSpan);
        continue;
      }
      const sym = {
        kind: 'func', name: `${S.name}.${m.name}`, methodName: m.name, owner: S, selfMode: m.self,
        decl: m, origin, exported: false,
        calls: new Set(), imports: new Set(), globals: new Set(), arrays: new Set(),
        locals: [], params: [], ret: 'void', paramLeafCount: 0,
      };
      S.methods.set(m.name, sym);
      this.funcs.push(sym);
    }
  }

  /** fn +(self, o: T) -> T and friends. A struct may define one operator for several operand types. */
  declareOperator(S, m, origin) {
    if (m.self === 'var') this.err(`operators can't take 'var self'; return a new value instead`, m.selfSpan);
    const n = S.operators.filter((o) => o.op === m.name).length;
    const sym = {
      kind: 'func', name: `${S.name}.op${m.name}${n ? `_${n + 1}` : ''}`, op: m.name, isOperator: true,
      owner: S, selfMode: m.self ? 'value' : null, decl: m, origin, exported: false,
      calls: new Set(), imports: new Set(), globals: new Set(), arrays: new Set(),
      locals: [], params: [], ret: 'void', paramLeafCount: 0,
    };
    S.operators.push(sym);
    this.funcs.push(sym);
  }

  checkOperators(S) {
    const seen = new Set();
    for (const o of S.operators) {
      const types = o.params.map((p) => p.type);
      const span = o.decl.nameSpan;
      o.operandTypes = types;
      o.unary = types.length === 1;
      if (types.includes('error') || o.ret === 'error') {
        o.bad = true;
        continue;
      }
      if (types.length === 1) {
        if (o.op !== '-') {
          this.err(`'${o.op}' needs two operands`, span, `write it like fn ${o.op}(self, other: ${S.name}) -> ...`);
          o.bad = true;
        } else if (types[0] !== S) {
          this.err(`unary '-' must take self`, span, `fn -(self) -> ${S.name}`);
          o.bad = true;
        }
      } else if (types.length === 2) {
        if (types[0] !== S && types[1] !== S) {
          this.err(`an operator in impl ${S.name} must take ${article(S.name)} on one side`, span);
          o.bad = true;
        }
      } else {
        this.err(`'${o.op}' takes one or two operands, not ${types.length}`, span);
        o.bad = true;
      }
      if ((COMPARE.has(o.op) || EQUALITY.has(o.op)) && o.ret !== 'bool') {
        this.err(`'${o.op}' must return bool`, span);
        o.bad = true;
      } else if (o.ret === 'void') {
        this.err(`'${o.op}' must return a value`, span);
        o.bad = true;
      }
      const key = `${o.op}(${types.join(', ')})`;
      if (!o.bad && seen.has(key)) {
        this.err(`${S.name} already defines ${key}`, span);
        o.bad = true;
      }
      seen.add(key);
    }
  }

  /**
   * Find a user-defined operator for e.op with these operand types. Derived
   * forms: != is !(==), > is < swapped, <= is !(< swapped), >= is !(<).
   */
  userOperator(e, lt, rt) {
    const cands = [...(isStruct(lt) ? lt.operators : []), ...(isStruct(rt) && rt !== lt ? rt.operators : [])].filter((o) => !o.bad && !o.unary);
    if (!cands.length) return null;
    const fits = (node, t, want) => t === want || (want === 'float' && t === 'int' && this.coercible(node));
    const find = (op, swap) => {
      const [a, at, b, bt] = swap ? [e.right, rt, e.left, lt] : [e.left, lt, e.right, rt];
      const ms = cands.filter((o) => o.op === op);
      const exact = ms.find((o) => o.operandTypes[0] === at && o.operandTypes[1] === bt);
      if (exact) return exact;
      const loose = ms.find((o) => fits(a, at, o.operandTypes[0]) && fits(b, bt, o.operandTypes[1]));
      if (loose) {
        if (loose.operandTypes[0] !== at) this.toFloat(a);
        if (loose.operandTypes[1] !== bt) this.toFloat(b);
      }
      return loose ?? null;
    };
    const op = e.op;
    let sym = find(op, false);
    if (sym) return { sym, swap: false, negate: false };
    if (op === '!=' && (sym = find('==', false))) return { sym, swap: false, negate: true };
    if (op === '>' && (sym = find('<', true))) return { sym, swap: true, negate: false };
    if (op === '<=' && (sym = find('<', true))) return { sym, swap: true, negate: true };
    if (op === '>=' && (sym = find('<', false))) return { sym, swap: false, negate: true };
    return null;
  }

  resolveSignature(f) {
    if (f.selfMode) f.params.push({ name: 'self', type: f.owner });
    const seen = new Set();
    for (const p of f.decl.params) {
      if (seen.has(p.name)) this.err(`parameter '${p.name}' is declared twice`, p.span);
      seen.add(p.name);
      f.params.push({ name: p.name, type: this.valueType(p.type) });
    }
    f.ret = f.decl.ret ? this.valueType(f.decl.ret) : 'void';
    if (f.exported && [...f.params.map((p) => p.type), f.ret].some((t) => leafTypes(t === 'error' ? 'void' : t).some(isVector))) {
      this.err(`exported function '${f.name}' can't take or return SIMD vectors`, f.decl.nameSpan ?? f.decl.span,
        "JavaScript has no v128 values; pass the lanes as separate floats or ints instead");
    }
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
      if (d.type) t = this.coerce(d.init, t, this.valueType(d.type), `constant '${sym.name}'`);
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
      let t = d.type ? this.valueType(d.type) : null;
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
        sym.value = zeroValue(t);
      }
      if (t === 'void') t = 'error';
      sym.type = t;
    });
  }

  /** Resolve an array's type and size (on demand, so declaration order doesn't matter). */
  resolveArray(sym) {
    if (sym.state === 'done') return sym.elem !== 'error';
    if (sym.state === 'busy') {
      this.err(`the size of array '${sym.name}' depends on itself`, sym.decl.span);
      return false;
    }
    sym.state = 'busy';
    this.resolveArrayNow(sym);
    sym.state = 'done';
    return sym.elem !== 'error';
  }

  resolveArrayNow(sym) {
    this.inConstContext(sym.origin, () => {
      const d = sym.decl;
      let elem = null;
      let size = null;
      if (d.type) {
        if (d.type.kind !== 'ArrayType') {
          this.err(`'${sym.name}' is initialized with an array but declared as ${d.type.name}`, d.type.span, `write the type as [${d.type.name}; N]`);
          return;
        }
        elem = this.valueType(d.type.elem);
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
          elem = types.includes('float') && !types.some(isStruct) ? 'float' : types[0];
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
      const bytes = size * sizeOf(elem);
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
    let first = 0;
    sym.paramSyms = [];
    if (sym.selfMode) {
      const self = this.declareLocal('self', sym.owner, sym.selfMode === 'var', false);
      self.isSelf = true;
      sym.paramSyms.push(self);
      first = 1;
    }
    sym.decl.params.forEach((p, i) => sym.paramSyms.push(this.declareLocal(p.name, sym.params[first + i].type, false, false)));
    sym.paramLeafCount = sym.locals.length;
    this.block(sym.decl.body);
    if (sym.ret !== 'void' && sym.ret !== 'error' && !returns(sym.decl.body)) {
      this.err(`function '${sym.name}' must return ${article(sym.ret)} on every path`, sym.decl.endSpan,
        `add 'return <${sym.ret}>;' before the closing brace`);
    }
    this.fn = null;
  }

  declareLocal(name, type, mutable, loopVar) {
    const sym = { kind: 'local', name, type, mutable, loopVar, index: this.fn.locals.length };
    // A struct local occupies one wasm local per leaf: v.x, v.y, v.z ...
    if (isStruct(type)) type.leafTypes.forEach((t, i) => this.fn.locals.push({ name: `${name}.${type.leafPaths[i]}`, type: t }));
    else this.fn.locals.push({ name, type });
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
      let hint = t === 'int' ? 'compare explicitly, e.g. x != 0' : undefined;
      if (isMask(t)) {
        hint = what === 'conditional'
          ? 'a vector comparison gives one bool per lane; choose lane by lane with select(mask, a, b)'
          : 'a vector comparison gives one bool per lane; test them with any(mask) or all(mask)';
      }
      this.err(`${what} condition must be a bool, found ${t}`, e.span, hint);
    }
  }

  stmt(s) {
    switch (s.kind) {
      case 'Let': {
        let t;
        if (s.type) {
          t = this.valueType(s.type);
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
          this.err(`'${this.fn.name}' must return ${article(ret)}`, s.span);
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
      if (targetType !== 'error' && !this.assignable(tgt)) targetType = 'error';
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
      s.opMethod = fake.opMethod;
      s.splatSide = fake.splatSide;
    }
  }

  /** Can this element/field chain be assigned to? Reports why not. */
  /**
   * Can this place be changed? Reports why not. `verb` customizes the message
   * for method calls ("call 'grow' on").
   */
  assignable(tgt, verb) {
    let root = tgt;
    while (root.kind === 'Field') root = root.target;
    const what = describeTarget(tgt);
    const act = `${verb ?? 'modify'} '${what}'`;
    if (root.kind === 'Index') {
      if (root.indexKind === 'str') {
        this.err('strings are immutable', tgt.span);
        return false;
      }
      if (root.indexKind === 'array' && !root.sym.mutable) {
        this.err(`can't ${act} because '${root.sym.name}' was declared with 'let'`, tgt.span, `declare it with 'var ${root.sym.name}' to make it mutable`);
        return false;
      }
      return true;
    }
    if (root.kind === 'Ident' && root.sym) {
      const sym = root.sym;
      if (sym.kind === 'global') return true;
      if (sym.kind === 'local' && sym.mutable && !sym.loopVar) return true;
      if (sym.kind === 'local' && sym.isSelf) {
        this.err(`can't ${act} because 'self' is a copy here`, tgt.span, "declare the method with 'var self' to let it change the value it's called on");
      } else if (sym.kind === 'local') {
        this.err(`can't ${act} because '${sym.name}' is immutable`, tgt.span, `declare it with 'var ${sym.name}' to make it mutable`);
      } else {
        this.err(`can't ${act} because '${sym.name}' is a constant`, tgt.span);
      }
      return false;
    }
    if (verb) {
      this.err(`can't ${verb} a temporary value`, tgt.span, 'this method changes the value it is called on (var self), so it needs a variable');
    } else {
      this.err(`can't assign to a field of a temporary value`, tgt.span, 'store it in a variable first');
    }
    return false;
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
          case 'struct':
            this.err(`'${sym.name}' is a struct type; create a value like ${sym.name}(${sym.fields.map((f) => f.name).join(', ')})`, e.span);
            return 'error';
        }
        return 'error';
      }
      case 'Unary': {
        const t = this.expr(e.operand);
        if (t === 'error') return t;
        if (isVector(t)) {
          if ((e.op === '-' && !isMask(t)) || (e.op === '!' && isMask(t)) || (e.op === '~' && t === 'i32x4')) return t;
          const hint = e.op === '!' ? "'!' flips the lanes of a mask (boolx4 or boolx2)" : e.op === '~' ? "'~' works on i32x4" : undefined;
          this.err(`can't apply '${e.op}' to ${t}`, e.span, hint);
          return 'error';
        }
        if (e.op === '-' && isStruct(t)) {
          const neg = t.operators.find((o) => o.op === '-' && o.unary && !o.bad);
          if (neg) {
            if (!this.fn) {
              this.err(`operators defined in an impl can't be used in constant expressions`, e.span);
              return 'error';
            }
            this.fn.calls.add(neg);
            e.opMethod = { sym: neg };
            return neg.ret;
          }
        }
        if (e.op === '-' && (t === 'int' || t === 'float' || numericKind(t))) return t;
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
        const to = this.valueType(e.to);
        if (from === 'error' || to === 'error') return 'error';
        if (isVector(from) || isVector(to)) {
          if (isVector(from) && isVector(to) && laneCount(from) === laneCount(to)) return to;
          let hint;
          if (isVector(to) && from === laneType(to)) hint = `put it in all ${inWords(laneCount(to))} lanes with ${to}(x), or build one from ${inWords(laneCount(to))} values`;
          else if (isVector(from) && to === laneType(from)) hint = `read one lane with ${laneNames(from).map((n) => `v.${n}`).join(', ')}`;
          else if (isVector(from) && isVector(to)) hint = `${from} has ${laneCount(from)} lanes and ${to} has ${laneCount(to)}; read the lanes and build ${article(to)} from them`;
          this.err(`can't convert ${from} to ${to}`, e.span, hint);
          return 'error';
        }
        if (from === 'str' || to === 'str' || from === 'void' || isStruct(from) || isStruct(to)) {
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
      case 'MethodCall':
        return this.methodCall(e);
      case 'Field': {
        const t = this.expr(e.target);
        if (t === 'error') return t;
        if (isVector(t)) {
          const names = laneNames(t);
          const lane = names.indexOf(e.name);
          if (lane < 0) {
            this.err(`${t} has no lane '${e.name}'`, e.nameSpan, `its lanes are ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
            return 'error';
          }
          e.lane = lane;
          return laneType(t);
        }
        if (!isStruct(t)) {
          this.err(`${t} values don't have fields`, e.nameSpan);
          return 'error';
        }
        const i = t.fields.findIndex((f) => f.name === e.name);
        if (i < 0) {
          const names = t.fields.map((f) => f.name);
          const s = suggest(e.name, names);
          this.err(`struct '${t.name}' has no field '${e.name}'`, e.nameSpan, s ? `did you mean '${s}'?` : `its fields are: ${names.join(', ')}`);
          return 'error';
        }
        e.fieldIndex = i;
        return t.fields[i].type;
      }
      case 'Index': {
        const idxType = this.expr(e.index);
        if (idxType !== 'int' && idxType !== 'error') {
          this.err(`array index must be an int, found ${idxType}`, e.index.span, idxType === 'float' ? "convert with 'as int'" : undefined);
        }
        const sym = e.target.kind === 'Ident' ? this.lookup(e.target.name) : null;
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
        if (isVector(t)) {
          this.err(`can't index into ${article(t)}`, e.target.span, `read a lane with ${laneNames(t).map((n) => `v.${n}`).join(', ')}`);
          return 'error';
        }
        if (t === 'str') {
          e.indexKind = 'str';
          if (this.fn) this.fn.imports.add('__trap');
          return 'int';
        }
        this.err(isStruct(t) ? `can't index into ${article(t)}; use a field like value.${t.fields[0]?.name}` : `can't index into a value of type ${t}`, e.target.span);
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
    if (isStruct(lt) || isStruct(rt)) {
      const u = this.userOperator(e, lt, rt);
      if (u) {
        if (!this.fn) {
          this.err(`operators defined in an impl can't be used in constant expressions`, e.opSpan ?? e.span);
          return 'error';
        }
        this.fn.calls.add(u.sym);
        e.opMethod = u;
        return u.negate || u.swap ? 'bool' : u.sym.ret;
      }
      return this.structBinary(e, lt, rt, bad);
    }
    if (isVector(lt) || isVector(rt)) return this.vectorBinary(e, lt, rt, bad);
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

  // Vectors work lane by lane, with another vector of the same type or with a
  // scalar of the lane type, which fills all four lanes (e.splatSide).
  vectorBinary(e, lt, rt, bad) {
    const op = e.op;
    const V = isVector(lt) ? lt : rt;
    const lane = laneType(V);
    if (SHIFT.has(op)) {
      if (lt !== 'i32x4') return bad(V === 'i32x4' ? undefined : 'shifts work on i32x4');
      if (rt !== 'int') return bad(isVector(rt) ? 'every lane is shifted by the same amount, so the right side must be an int' : undefined);
      return V;
    }
    for (const [side, t] of [['left', lt], ['right', rt]]) {
      if (t === V) continue;
      if (isVector(t)) return bad(`both sides must be the same kind of vector; convert with 'as ${V}'`);
      if (t !== lane) {
        if (lane === 'float' && t === 'int' && this.coercible(e[side])) this.toFloat(e[side]);
        else return bad(`${article(V)} can be combined with another ${V} or with ${article(lane)} (which fills all ${inWords(laneCount(V))} lanes), not ${article(t)}`);
      }
      e.splatSide = side;
    }
    if (op === '&&' || op === '||') return bad(isMask(V) ? `use '${op[0]}' to combine masks lane by lane` : undefined);
    if (ARITH.has(op)) {
      if (isMask(V)) return bad();
      if (V === 'i32x4' && (op === '/' || op === '%')) {
        return bad("WebAssembly SIMD can't divide integer lanes; convert with 'as f32x4' first, or divide one lane at a time");
      }
      return V;
    }
    if (COMPARE.has(op)) return isMask(V) ? bad() : maskOf(V);
    if (EQUALITY.has(op)) return maskOf(V);
    if (BITWISE.has(op)) return lane === 'float' ? bad(`'${op}' works on i32x4 and on masks`) : V;
    throw new Error(`unknown operator ${op}`);
  }

  // Structs whose leaves are all floats (or all ints) get component-wise
  // arithmetic, with another value of the same struct or with a scalar.
  structBinary(e, lt, rt, bad) {
    const op = e.op;
    if (EQUALITY.has(op)) return lt === rt ? 'bool' : bad();
    const S0 = isStruct(lt) ? lt : rt;
    if (!ARITH.has(op)) return bad(COMPARE.has(op) ? `define it: impl ${S0} { fn <(self, o: ${S0}) -> bool { ... } } gives < > <= >=` : `'${op}' doesn't work on structs`);
    const S = isStruct(lt) ? lt : rt;
    const kind = numericKind(S);
    if (!kind) return bad(`built-in arithmetic only covers structs whose fields are all floats or all ints; define it: impl ${S} { fn ${op}(self, o: ${S}) -> ${S} { ... } }`);
    if (isStruct(lt) && isStruct(rt)) {
      if (lt !== rt) return bad();
    } else {
      const [scalar, st] = isStruct(lt) ? [e.right, rt] : [e.left, lt];
      const lane = isVector(kind) ? laneType(kind) : null;
      if (st !== kind) {
        if ((kind === 'float' || lane === 'float') && st === 'int' && this.coercible(scalar)) this.toFloat(scalar);
        else if (st !== lane) return bad(`${article(S)} can be combined with ${article(kind)}${lane ? ` or ${article(lane)}` : ''}, not ${article(st)}`);
      }
    }
    if (kind === 'i32x4' && (op === '/' || op === '%')) {
      return bad("WebAssembly SIMD can't divide integer lanes; convert the fields with 'as f32x4' first");
    }
    if (kind === 'int' && (op === '/' || op === '%')) {
      e.checkZero = true;
      if (this.fn) this.fn.imports.add('__trap');
    }
    e.structOp = true;
    return S;
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
    if (isVector(name)) return this.vectorCtor(e, name);
    const sym = this.top.get(name);
    if (sym && sym.kind === 'struct') {
      this.checkArgs(e, sym.fields.map((f) => f.type), signatureText(name, sym.fields.map((f) => `${f.name}: ${f.type}`), name));
      e.ctor = sym;
      return sym;
    }
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
    // "__" imports are internal: only the prelude may call them directly.
    if (name in IMPORTS && (!name.startsWith('__') || this.origin === 'prelude')) {
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
    const owner = this.structs.find((st) => st.methods.has(name));
    if (owner) {
      this.err(`unknown function '${name}'`, e.calleeSpan, `'${name}' is a method of ${owner.name}; call it on a value: value.${name}(...)`);
      return 'error';
    }
    const s = suggest(name, [...this.top.keys(), ...Object.keys(INTRINSICS), ...SPECIAL, ...Object.keys(IMPORTS)]);
    this.err(`unknown function '${name}'`, e.calleeSpan, s ? `did you mean '${s}'?` : undefined);
    return 'error';
  }

  /** f32x4(a, b, c, d) builds a vector from its lanes; f32x4(a) puts a in all of them. */
  vectorCtor(e, V) {
    const lane = laneType(V);
    const types = e.args.map((a) => this.expr(a));
    const n = e.args.length;
    const count = laneCount(V);
    if (n !== 1 && n !== count) {
      const ex = { f32x4: '1.0, 2.0, 3.0, 4.0', i32x4: '1, 2, 3, 4', boolx4: 'true, false, true, false', f64x2: '1.0, 2.0', boolx2: 'true, false' }[V];
      this.err(`'${V}' takes 1 value (for all ${inWords(count)} lanes) or ${count} values (one per lane), but ${n} ${n === 1 ? 'was' : 'were'} given`, e.span, `e.g. ${V}(${ex})`);
      return 'error';
    }
    e.args.forEach((a, i) => this.coerce(a, types[i], lane, n === 1 ? `the value of '${V}'` : `lane ${laneNames(V)[i]} of '${V}'`));
    e.vecCtor = V;
    return V;
  }

  methodSignature(m) {
    const params = m.params.map((p) => (p.name === 'self' ? (m.selfMode === 'var' ? 'var self' : 'self') : `${p.name}: ${p.type}`));
    return signatureText(m.name, params, m.ret);
  }

  noMethod(S, e) {
    if (S.fields.some((f) => f.name === e.name)) {
      this.err(`'${e.name}' is a field of ${S.name}, not a method`, e.nameSpan, `read it without parentheses: value.${e.name}`);
      return;
    }
    const names = [...S.methods.keys()];
    const s = suggest(e.name, names);
    const hint = s ? `did you mean '${s}'?` : names.length ? `its methods are: ${names.join(', ')}` : `add one: impl ${S.name} { fn ${e.name}(self) { ... } }`;
    this.err(`${S.name} has no method '${e.name}'`, e.nameSpan, hint);
  }

  /** value.method(args), or Type.method(args) for a method without self. */
  methodCall(e) {
    const r = e.receiver;
    const bail = () => {
      e.args.forEach((a) => this.expr(a));
      return 'error';
    };
    if (r.kind === 'Ident' && !this.lookupLocal(r.name)) {
      const S = this.top.get(r.name);
      if (S && S.kind === 'struct') {
        e.callee = `${S.name}.${e.name}`;
        const m = S.methods.get(e.name);
        if (!m) {
          this.noMethod(S, e);
          return bail();
        }
        if (m.selfMode) {
          this.err(`'${e.callee}' works on a value; call it like value.${e.name}(...)`, e.nameSpan);
          return bail();
        }
        if (!this.fn) {
          this.err(`methods can't be called in constant expressions`, e.span);
          return bail();
        }
        this.checkArgs(e, m.params.map((p) => p.type), this.methodSignature(m));
        this.fn.calls.add(m);
        e.method = m;
        e.isStatic = true;
        return m.ret;
      }
    }
    const t = this.expr(r);
    if (t === 'error') return bail();
    if (!isStruct(t)) {
      this.err(`${t} values don't have methods`, e.nameSpan);
      return bail();
    }
    e.callee = `${t.name}.${e.name}`;
    const m = t.methods.get(e.name);
    if (!m) {
      this.noMethod(t, e);
      return bail();
    }
    if (!m.selfMode) {
      this.err(`'${e.callee}' doesn't take self; call it as ${e.callee}(...)`, e.nameSpan);
      return bail();
    }
    if (!this.fn) {
      this.err(`methods can't be called in constant expressions`, e.span);
      return bail();
    }
    if (m.selfMode === 'var' && !this.assignable(r, `call '${e.name}' on`)) return bail();
    this.checkArgs(e, m.params.slice(1).map((p) => p.type), this.methodSignature(m));
    this.fn.calls.add(m);
    e.method = m;
    return m.ret;
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
      else if (t !== 'error') {
        for (const lt of leafTypes(t)) this.fn.imports.add(printImport(lt));
        if (isStruct(t) || isVector(t)) this.fn.imports.add('__print_s');
      }
    }
    if (e.args.length > 1) this.fn.imports.add('__print_s');
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
    const ct = this.expr(e.args[0]);
    if (isMask(ct)) return this.vectorSelect(e, ct);
    if (ct !== 'bool' && ct !== 'error') {
      this.err(`select condition must be a bool (or a mask), found ${ct}`, e.args[0].span);
    }
    const a = this.expr(e.args[1]);
    const b = this.expr(e.args[2]);
    if (a === 'error' || b === 'error') return 'error';
    if (isVector(a) || isVector(b)) {
      this.err(`'select' with vectors needs a mask to choose lane by lane, found ${ct}`, e.args[0].span, 'compare vectors to get one, e.g. select(v < 0.0, -v, v)');
      return 'error';
    }
    const t = this.unify(e.args[1], a, e.args[2], b);
    if (!t || t === 'void') {
      this.err(`both values given to 'select' must have the same type, found ${a} and ${b}`, e.span);
      return 'error';
    }
    if (isStruct(t)) {
      this.err(`'select' works on single values, not structs`, e.span, 'use cond ? a : b instead');
      return 'error';
    }
    e.builtin = 'select';
    return t;
  }

  /** select(mask, a, b): lane i comes from a where mask lane i is true, else from b. */
  vectorSelect(e, mask) {
    const [, A, B] = e.args;
    const a = this.expr(A);
    const b = this.expr(B);
    if (a === 'error' || b === 'error') return 'error';
    let V = isVector(a) ? a : isVector(b) ? b : null;
    if (!V) {
      const t = this.unify(A, a, B, b);
      V = t ? vectorOf(t, laneCount(mask)) : null;
      // There's no two-lane int vector, but int literals adapt to floats.
      if (!V && t === 'int' && mask === 'boolx2' && this.coercible(A) && this.coercible(B)) {
        this.toFloat(A);
        this.toFloat(B);
        V = 'f64x2';
      }
    }
    if (V && laneCount(V) !== laneCount(mask)) {
      this.err(`a ${mask} mask chooses between values with ${laneCount(mask)} lanes, not ${V}`, e.span);
      return 'error';
    }
    e.splatArgs = [false, false];
    for (const [i, node] of [[0, A], [1, B]]) {
      const t = node.type; // unify() may have turned an int literal into a float
      if (V && t === V) continue;
      if (V && t === laneType(V)) {
        e.splatArgs[i] = true;
        continue;
      }
      if (V && laneType(V) === 'float' && t === 'int' && this.coercible(node)) {
        this.toFloat(node);
        e.splatArgs[i] = true;
        continue;
      }
      const hint = mask === 'boolx2' ? 'a boolx2 mask chooses between f64x2 values or floats' : undefined;
      this.err(`both values given to 'select' must be the same vector type (or one of its lanes), found ${a} and ${b}`, e.span, hint);
      return 'error';
    }
    e.builtin = 'select';
    e.vecSelect = V;
    return V;
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
        if (!this.resolveArray(sym)) return 'error';
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
      case 'Field': {
        const v = e.target.constValue;
        if (v !== undefined && e.lane !== undefined) {
          e.constValue = v[e.lane];
          return;
        }
        if (v === undefined || e.fieldIndex === undefined) return;
        const start = e.target.type.fieldLeaf[e.fieldIndex];
        e.constValue = isStruct(e.type) ? v.slice(start, start + leafCount(e.type)) : v[start];
        return;
      }
      case 'Unary': {
        const v = e.operand.constValue;
        if (v === undefined || e.opMethod) return;
        if (isStruct(e.type)) e.constValue = v.map((x) => negateValue(numericKind(e.type), x));
        else if (isVector(e.type)) e.constValue = e.op === '-' ? negateValue(e.type, v) : v.map((x) => (e.op === '!' ? !x : ~x));
        else if (e.op === '-') e.constValue = negateValue(e.type, v);
        else if (e.op === '!') e.constValue = !v;
        else e.constValue = ~v;
        return;
      }
      case 'Binary': {
        const l = e.left.constValue;
        const r = e.right.constValue;
        if (l === undefined || r === undefined || e.opMethod) return;
        if (isStruct(e.left.type) || isStruct(e.right.type)) {
          if (EQUALITY.has(e.op)) {
            const same = l.every((x, i) => (Array.isArray(x) ? x.every((y, j) => y === r[i][j]) : x === r[i]));
            e.constValue = e.op === '==' ? same : !same;
            return;
          }
          const kind = numericKind(e.type);
          const L = (i) => (isStruct(e.left.type) ? l[i] : l);
          const R = (i) => (isStruct(e.right.type) ? r[i] : r);
          const n = e.type.leafTypes.length;
          if (kind === 'int' && (e.op === '/' || e.op === '%')) {
            for (let i = 0; i < n; i++) if (R(i) === 0) return; // leave it to the runtime check
          }
          e.constValue = Array.from({ length: n }, (_, i) => (isVector(kind) ? evalVector(e.op, kind, L(i), R(i)) : evalBinary(e.op, kind, L(i), R(i))));
          return;
        }
        if (isVector(e.left.type) || isVector(e.right.type)) {
          const V = isVector(e.left.type) ? e.left.type : e.right.type;
          e.constValue = evalVector(e.op, V, l, r);
          return;
        }
        e.constValue = evalBinary(e.op, e.left.type, l, r);
        return;
      }
      case 'Cast': {
        const v = e.expr.constValue;
        if (v === undefined) return;
        if (isVector(e.type)) {
          e.constValue = v.map((x) => laneValue(e.type, castValue(x, laneType(e.expr.type), laneType(e.type))));
          return;
        }
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
        if (e.ctor) {
          const vals = e.args.map((a) => a.constValue);
          if (vals.some((v) => v === undefined)) return;
          e.constValue = vals.flatMap((v, i) => (isStruct(e.ctor.fields[i].type) ? v : [v]));
          return;
        }
        if (e.builtin === 'len' && e.lenOf) {
          e.constValue = e.lenOf.size;
          return;
        }
        const args = e.args.map((a) => a.constValue);
        if (args.some((a) => a === undefined)) return;
        if (e.vecCtor) {
          e.constValue = (args.length === 1 ? lanesOf(e.vecCtor, args[0]) : args).map((x) => laneValue(e.vecCtor, x));
          return;
        }
        if (e.vecSelect) {
          const pick = (k, i) => (Array.isArray(args[k]) ? args[k][i] : laneValue(e.vecSelect, args[k]));
          e.constValue = args[0].map((m, i) => (m ? pick(1, i) : pick(2, i)));
          return;
        }
        if (e.builtin === 'intrinsic' && isVector(e.overload[0][0])) {
          e.constValue = foldVectorIntrinsic(e.callee, e.overload, args);
          return;
        }
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

/** The host function that prints one leaf (for a vector: one lane). */
export function printImport(t) {
  if (t === 'f32x4') return '__print_f32';
  if (isVector(t)) return `__print_${laneType(t)[0]}`;
  return `__print_${t[0]}`;
}

function article(t) {
  return `${/^([aeiou]|f\d)/i.test(String(t)) ? 'an' : 'a'} ${t}`; // "an f32x4" is read "an eff..."
}

function zeroValue(t) {
  if (isStruct(t)) return t.leafTypes.map(zeroValue);
  if (isVector(t)) return lanesOf(t, zeroValue(laneType(t)));
  return t === 'bool' ? false : t === 'str' ? '' : 0;
}

const inWords = (n) => ({ 2: 'two', 4: 'four' })[n];

/** `x` in every lane of a `V`. */
const lanesOf = (V, x) => Array.from({ length: laneCount(V) }, () => x);

/** Normalize a lane value the way the vector stores it (f32 rounding for f32x4). */
export function laneValue(V, x) {
  if (V === 'f32x4') return Math.fround(x);
  if (V === 'i32x4') return x | 0;
  if (V === 'f64x2') return +x;
  return !!x;
}

function negateValue(t, v) {
  if (t === 'int') return -v | 0;
  if (t === 'float') return -v;
  return v.map((x) => laneValue(t, -x));
}

/** One f32 operation, rounded like the hardware does it. */
function f32op(op, a, b) {
  if (op === '%') {
    // f32x4 has no remainder: a - trunc(a / b) * b, each step rounded to f32
    const q = Math.trunc(Math.fround(a / b));
    return Math.fround(a - Math.fround(q * b));
  }
  return Math.fround(evalBinary(op, 'float', a, b));
}

/** Fold a binary operator on vectors; a scalar operand fills all four lanes. */
export function evalVector(op, V, l, r) {
  const lane = laneType(V);
  const L = (i) => (Array.isArray(l) ? l[i] : laneValue(V, l));
  const R = (i) => (Array.isArray(r) ? r[i] : SHIFT.has(op) ? r : laneValue(V, r));
  return lanesOf(V, 0).map((_, i) => {
    if (COMPARE.has(op) || EQUALITY.has(op)) return evalBinary(op, lane, L(i), R(i));
    if (V === 'f32x4') return f32op(op, L(i), R(i));
    return laneValue(V, evalBinary(op, lane, L(i), R(i)));
  });
}

const bitsView = new DataView(new ArrayBuffer(4));

/** Fold a lane-wise intrinsic. Returns undefined to leave it to run time. */
function foldVectorIntrinsic(name, overload, args) {
  if (name === 'any') return args[0].some(Boolean);
  if (name === 'all') return args[0].every(Boolean);
  if (name === 'to_bits' || name === 'from_bits') {
    const out = args[0].map((x) => {
      if (name === 'to_bits') {
        bitsView.setFloat32(0, x);
        return bitsView.getInt32(0);
      }
      bitsView.setInt32(0, x);
      return bitsView.getFloat32(0);
    });
    // WebAssembly doesn't fix the sign and payload of a NaN (and JavaScript
    // numbers don't keep them), so lanes that are NaN are left to run time.
    return (name === 'to_bits' ? args[0] : out).some(Number.isNaN) ? undefined : out;
  }
  const V = overload[1];
  const lanes = args.map((a) => (Array.isArray(a) ? a : lanesOf(V, laneValue(V, a))));
  const [a, b, c] = lanes;
  return lanesOf(V, 0).map((_, i) => {
    let v;
    if (name === 'abs') v = Math.abs(a[i]);
    else if (name === 'min') v = Math.min(a[i], b[i]);
    else if (name === 'max') v = Math.max(a[i], b[i]);
    else if (name === 'clamp') v = Math.min(Math.max(a[i], b[i]), c[i]);
    else if (name === 'round') v = nearest(a[i]);
    else v = FOLDABLE[name](a[i]);
    return laneValue(V, v);
  });
}

function isArrayDecl(item) {
  return item.kind === 'Global' && (item.type?.kind === 'ArrayType' || item.init?.kind === 'ArrayLit');
}

function describeTarget(t) {
  if (t.kind === 'Ident') return t.name;
  if (t.kind === 'Field') return `${describeTarget(t.target)}.${t.name}`;
  if (t.kind === 'Index') return `${describeTarget(t.target)}[...]`;
  return '(value)';
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
