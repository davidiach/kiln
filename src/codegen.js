// Code generation: annotated AST -> WebAssembly binary (+ a WAT listing).
//
// Every instruction is written twice: as bytes into the module, and as text
// into a human-readable WAT listing that mirrors the binary 1:1. Only
// functions reachable from main/frame/exports are emitted; everything else
// (including unused prelude functions) is stripped.

import { ByteWriter, OPS, SECTION, I32, F64, VOID_BLOCK, valType, valTypeName, f64Text } from './wasm.js';
import { IMPORTS } from './builtins.js';

const textEncoder = new TextEncoder();
const align = (n, a) => Math.ceil(n / a) * a;
const elemSize = (t) => (t === 'float' ? 8 : 4);

export function generate(checker, sources) {
  return new Generator(checker, sources).run();
}

class Generator {
  constructor(ck, sources) {
    this.ck = ck;
    this.sources = Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, v.split('\n')]));
    this.traps = [];
    this.strings = new Map();
    this.segments = [];
    this.types = [];
    this.typeKeys = new Map();
  }

  run() {
    const ck = this.ck;

    // ---- reachability (dead code elimination)
    const roots = ck.funcs.filter((f) => f === ck.main || f === ck.frame || f.exported);
    const live = new Set();
    const stack = [...roots];
    while (stack.length) {
      const f = stack.pop();
      if (live.has(f)) continue;
      live.add(f);
      for (const c of f.calls) stack.push(c);
    }
    this.funcs = ck.funcs.filter((f) => live.has(f));
    const usedImports = new Set();
    const usedGlobals = new Set();
    const usedArrays = new Set();
    for (const f of this.funcs) {
      f.imports.forEach((i) => usedImports.add(i));
      f.globals.forEach((g) => usedGlobals.add(g));
      f.arrays.forEach((a) => usedArrays.add(a));
    }

    // ---- index spaces
    this.imports = Object.keys(IMPORTS)
      .filter((n) => usedImports.has(n))
      .map((name, index) => ({ name, index, ...IMPORTS[name] }));
    this.importByName = new Map(this.imports.map((i) => [i.name, i]));
    this.funcs.forEach((f, i) => (f.index = this.imports.length + i));
    this.globals = ck.globals.filter((g) => usedGlobals.has(g));
    this.globals.forEach((g, i) => (g.index = i));

    // ---- linear memory layout: arrays first (prelude's `screen` lands at 0), then strings
    this.arrays = ck.arrays.filter((a) => usedArrays.has(a));
    let addr = 0;
    for (const a of this.arrays) {
      a.addr = align(addr, 8);
      addr = a.addr + a.size * elemSize(a.elem);
      if (a.init && a.init.length) {
        const w = new ByteWriter();
        for (const v of a.init) {
          if (a.elem === 'float') w.f64(v);
          else {
            const x = typeof v === 'boolean' ? +v : v;
            w.u8(x).u8(x >> 8).u8(x >> 16).u8(x >> 24);
          }
        }
        this.segments.push({ addr: a.addr, bytes: w.bytes, label: a.name });
      }
    }
    this.dataEnd = addr;
    const screen = this.arrays.find((a) => a.name === 'screen' && a.origin === 'prelude');

    // String-typed globals need their literal interned before codegen.
    for (const g of this.globals) if (g.type === 'str') g.addr = this.intern(g.value);

    // ---- function bodies
    const bodies = this.funcs.map((f) => {
      const fg = new FnGen(this, f);
      fg.generate();
      return fg;
    });

    const memBytes = Math.max(this.dataEnd, 1);
    const pages = Math.max(1, Math.ceil(memBytes / 65536));

    // ---- exports
    const exports = [{ name: 'memory', kind: 2, index: 0 }];
    for (const f of this.funcs) {
      if (f === ck.main || f === ck.frame || f.exported) exports.push({ name: f.name, kind: 0, index: f.index, fn: f });
    }
    const extraGlobals = [];
    if (screen) {
      extraGlobals.push({ name: '__screen', type: 'int', mutable: false, value: screen.addr });
      exports.push({ name: '__screen', kind: 3, index: this.globals.length });
    }
    const allGlobals = [...this.globals.map((g) => ({ name: g.name, type: g.type, mutable: true, value: g.type === 'str' ? g.addr : g.value })), ...extraGlobals];

    // ---- assemble the binary
    const sigOf = (params, ret) => this.typeIndex(params, ret);
    this.imports.forEach((im) => (im.type = sigOf(im.params, im.ret)));
    this.funcs.forEach((f) => (f.typeIdx = sigOf(f.params.map((p) => p.type), f.ret)));

    const sections = [];
    const mod = new ByteWriter();
    mod.raw([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    sections.push({ name: 'header', start: 0, end: 8 });
    const section = (id, name, build) => {
      const body = new ByteWriter();
      build(body);
      const start = mod.length;
      mod.u8(id).sized(body);
      sections.push({ name, start, end: mod.length });
    };

    section(SECTION.type, 'type', (w) =>
      w.vec(this.types, (t) => {
        w.u8(0x60);
        w.vec(t.params, (p) => w.u8(valType(p)));
        w.vec(t.ret === 'void' ? [] : [t.ret], (r) => w.u8(valType(r)));
      }),
    );
    if (this.imports.length) {
      section(SECTION.import, 'import', (w) =>
        w.vec(this.imports, (im) => {
          w.name('env').name(im.name).u8(0x00).u32(im.type);
        }),
      );
    }
    section(SECTION.function, 'function', (w) => w.vec(this.funcs, (f) => w.u32(f.typeIdx)));
    section(SECTION.memory, 'memory', (w) => w.vec([pages], (p) => w.u8(0x00).u32(p)));
    if (allGlobals.length) {
      section(SECTION.global, 'global', (w) =>
        w.vec(allGlobals, (g) => {
          w.u8(valType(g.type)).u8(g.mutable ? 1 : 0);
          if (g.type === 'float') w.u8(0x44).f64(g.value);
          else w.u8(0x41).s32(typeof g.value === 'boolean' ? +g.value : g.value);
          w.u8(0x0b);
        }),
      );
    }
    section(SECTION.export, 'export', (w) =>
      w.vec(exports, (e) => {
        w.name(e.name).u8(e.kind).u32(e.index);
      }),
    );
    section(SECTION.code, 'code', (w) =>
      w.vec(bodies, (fg) => {
        const body = new ByteWriter();
        const groups = fg.localGroups();
        body.vec(groups, ([count, t]) => body.u32(count).u8(valType(t)));
        body.raw(fg.code.bytes);
        body.u8(0x0b);
        w.sized(body);
      }),
    );
    if (this.segments.length) {
      section(SECTION.data, 'data', (w) =>
        w.vec(this.segments, (s) => {
          w.u8(0x00).u8(0x41).s32(s.addr).u8(0x0b);
          w.u32(s.bytes.length).raw(s.bytes);
        }),
      );
    }
    // "name" custom section, so stack traces and devtools show Kiln names.
    {
      const start = mod.length;
      const body = new ByteWriter();
      body.name('name');
      const fnNames = new ByteWriter();
      const named = [...this.imports.map((i) => [i.index, i.name]), ...this.funcs.map((f) => [f.index, f.name])];
      fnNames.vec(named, ([i, n]) => fnNames.u32(i).name(n));
      body.u8(1).sized(fnNames);
      const localNames = new ByteWriter();
      localNames.vec(bodies, (fg) => {
        localNames.u32(fg.sym.index);
        localNames.vec(fg.localNames, (n, i) => localNames.u32(i).name(n));
      });
      body.u8(2).sized(localNames);
      mod.u8(SECTION.custom).sized(body);
      sections.push({ name: 'custom "name"', start, end: mod.length });
    }

    const binary = mod.toUint8Array();
    const wat = this.wat(bodies, exports, allGlobals, pages);
    const allFuncs = ck.funcs.length;
    return {
      binary,
      wat,
      sections,
      traps: this.traps,
      hasScreen: !!screen,
      stats: {
        bytes: binary.length,
        functions: this.funcs.length,
        stripped: allFuncs - this.funcs.length,
        imports: this.imports.map((i) => i.name),
        memoryPages: pages,
        dataBytes: this.dataEnd,
      },
    };
  }

  typeIndex(params, ret) {
    const key = params.map(valType).join(',') + '->' + (ret === 'void' ? '' : valType(ret));
    let idx = this.typeKeys.get(key);
    if (idx === undefined) {
      idx = this.types.length;
      this.types.push({ params, ret, key });
      this.typeKeys.set(key, idx);
    }
    return idx;
  }

  /** Strings live in linear memory as [len: i32][utf-8 bytes]. */
  intern(s) {
    let addr = this.strings.get(s);
    if (addr !== undefined) return addr;
    const bytes = textEncoder.encode(s);
    addr = align(this.dataEnd, 4);
    const w = new ByteWriter();
    const n = bytes.length;
    w.u8(n).u8(n >> 8).u8(n >> 16).u8(n >> 24).raw(bytes);
    this.segments.push({ addr, bytes: w.bytes, label: JSON.stringify(s) });
    this.dataEnd = addr + w.length;
    this.strings.set(s, addr);
    return addr;
  }

  trapSite(info) {
    this.traps.push(info);
    return this.traps.length - 1;
  }

  wat(bodies, exports, globals, pages) {
    const out = ['(module'];
    const vt = (t) => valTypeName(valType(t));
    const sig = (params, ret, names) =>
      params.map((p, i) => ` (param${names ? ' $' + names[i] : ''} ${vt(p)})`).join('') + (ret === 'void' ? '' : ` (result ${vt(ret)})`);
    for (const im of this.imports) out.push(`  (import "env" "${im.name}" (func $${im.name}${sig(im.params, im.ret)}))`);
    out.push(`  (memory (export "memory") ${pages})`);
    for (const g of globals) {
      const init = g.type === 'float' ? `f64.const ${f64Text(g.value)}` : `i32.const ${typeof g.value === 'boolean' ? +g.value : g.value}`;
      const ty = g.mutable ? `(mut ${vt(g.type)})` : vt(g.type);
      const ex = g.name === '__screen' ? ` (export "__screen")` : '';
      out.push(`  (global $${g.name}${ex} ${ty} (${init}))`);
    }
    for (const fg of bodies) {
      const f = fg.sym;
      const ex = exports.find((e) => e.fn === f);
      const exText = ex ? ` (export "${f.name}")` : '';
      out.push('');
      out.push(`  (func $${f.name}${exText}${sig(f.params.map((p) => p.type), f.ret, fg.localNames)}`);
      const locals = fg.localTypes.slice(f.params.length);
      if (locals.length) {
        const decl = locals.map((t, i) => `(local $${fg.localNames[f.params.length + i]} ${vt(t)})`);
        for (let i = 0; i < decl.length; i += 4) out.push('    ' + decl.slice(i, i + 4).join(' '));
      }
      out.push(...fg.lines);
      out.push('  )');
    }
    if (this.segments.length) out.push('');
    for (const s of this.segments) {
      let str = '';
      for (const b of s.bytes) {
        str += b >= 0x20 && b < 0x7f && b !== 0x22 && b !== 0x5c ? String.fromCharCode(b) : '\\' + b.toString(16).padStart(2, '0');
      }
      const shown = str.length > 120 ? str.slice(0, 120) + '...' : str;
      out.push(`  (data (i32.const ${s.addr}) "${shown}")  ;; ${s.label}`);
    }
    out.push(')');
    return out.join('\n');
  }
}

class FnGen {
  constructor(gen, sym) {
    this.gen = gen;
    this.sym = sym;
    this.code = new ByteWriter();
    this.lines = [];
    this.depth = 0;
    this.labels = [];
    this.loops = [];
    this.localTypes = sym.locals.map((l) => (l.type === 'float' ? 'float' : 'int'));
    this.localNames = uniqueNames(sym.locals.map((l) => l.name));
    this.free = { i32: [], f64: [] };
    this.src = gen.sources[sym.origin] ?? [];
    this.lastLine = -1;
  }

  generate() {
    const body = this.sym.decl.body.body;
    for (const s of body) this.stmt(s);
    const last = body[body.length - 1];
    if (this.sym.ret !== 'void' && !(last && last.kind === 'Return')) {
      // Every path returned already (the checker verified it), but wasm's
      // validator wants the fallthrough to be provably dead.
      this.emit('unreachable');
    }
  }

  localGroups() {
    const groups = [];
    for (const t of this.localTypes.slice(this.sym.params.length)) {
      const last = groups[groups.length - 1];
      if (last && last[1] === t) last[0]++;
      else groups.push([1, t]);
    }
    return groups;
  }

  // ------------------------------------------------------------- emission

  emit(name, ...args) {
    const def = OPS[name];
    if (!def) throw new Error(`unknown opcode ${name}`);
    if (name === 'end' || name === 'else') this.depth--;
    let text = name;
    for (const part of def) {
      if (typeof part === 'number') {
        this.code.u8(part);
        continue;
      }
      switch (part) {
        case 'block': {
          const bt = args[0];
          this.code.u8(bt);
          if (bt !== VOID_BLOCK) text += ` (result ${valTypeName(bt)})`;
          break;
        }
        case 'label':
          this.code.u32(args[0]);
          text += ` ${args[0]}`;
          if (args[1]) text += `  ;; ${args[1]}`;
          break;
        case 'func':
          this.code.u32(args[0].index);
          text += ` $${args[0].name}`;
          break;
        case 'local':
          this.code.u32(args[0]);
          text += ` $${this.localNames[args[0]]}`;
          break;
        case 'global':
          this.code.u32(args[0].index);
          text += ` $${args[0].name}`;
          break;
        case 'mem': {
          const [alignLog2, offset] = args;
          this.code.u32(alignLog2).u32(offset);
          if (offset) text += ` offset=${offset}`;
          break;
        }
        case 'i32':
          this.code.s32(args[0]);
          text += ` ${args[0] | 0}`;
          break;
        case 'f64':
          this.code.f64(args[0]);
          text += ` ${f64Text(args[0])}`;
          break;
      }
    }
    this.lines.push('    ' + '  '.repeat(this.depth) + text);
    if (name === 'block' || name === 'loop' || name === 'if' || name === 'else') this.depth++;
  }

  comment(text) {
    this.lines.push('    ' + '  '.repeat(this.depth) + ';; ' + text);
  }

  lineComment(span) {
    if (!span || span.line === this.lastLine) return;
    this.lastLine = span.line;
    const text = (this.src[span.line - 1] ?? '').trim();
    if (text) this.comment(`${span.line}: ${text}`);
  }

  open(op, blockType, label = null) {
    this.emit(op, blockType);
    this.labels.push(label);
  }
  close() {
    this.emit('end');
    this.labels.pop();
  }
  depthOf(label) {
    return this.labels.length - 1 - this.labels.lastIndexOf(label);
  }
  br(label, note) {
    this.emit('br', this.depthOf(label), note);
  }
  brIf(label, note) {
    this.emit('br_if', this.depthOf(label), note);
  }

  temp(type) {
    const kind = type === 'float' ? 'f64' : 'i32';
    if (this.free[kind].length) return this.free[kind].pop();
    const idx = this.localTypes.length;
    this.localTypes.push(type === 'float' ? 'float' : 'int');
    this.localNames.push(`t.${idx}`);
    return idx;
  }
  release(...idxs) {
    for (const idx of idxs) this.free[this.localTypes[idx] === 'float' ? 'f64' : 'i32'].push(idx);
  }

  callImport(name) {
    this.emit('call', this.gen.importByName.get(name));
  }

  trap(info, valueLocal) {
    const site = this.gen.trapSite({ ...info, origin: this.sym.origin, fn: this.sym.name });
    this.emit('i32.const', site);
    if (valueLocal === undefined) this.emit('i32.const', 0);
    else this.emit('local.get', valueLocal);
    this.callImport('__trap');
    this.emit('unreachable');
  }

  // ----------------------------------------------------------- statements

  block(b) {
    for (const s of b.body) this.stmt(s);
  }

  stmt(s) {
    if (s.kind !== 'Block') this.lineComment(s.span);
    switch (s.kind) {
      case 'Let':
        if (s.init) this.expr(s.init);
        else this.zero(s.sym.type);
        this.emit('local.set', s.sym.index);
        return;
      case 'Assign':
        return this.assign(s);
      case 'If': {
        const c = s.cond.constValue;
        if (c === true) return this.block(s.then);
        if (c === false) {
          if (s.else) s.else.kind === 'If' ? this.stmt(s.else) : this.block(s.else);
          return;
        }
        this.expr(s.cond);
        this.open('if', VOID_BLOCK);
        this.block(s.then);
        if (s.else) {
          this.emit('else');
          if (s.else.kind === 'If') this.stmt(s.else);
          else this.block(s.else);
        }
        this.close();
        return;
      }
      case 'While': {
        const brk = {};
        const cont = {};
        this.open('block', VOID_BLOCK, brk);
        this.open('loop', VOID_BLOCK, cont);
        if (s.cond.constValue !== true) {
          this.expr(s.cond);
          this.emit('i32.eqz');
          this.brIf(brk, 'exit loop');
        }
        this.loops.push({ brk, cont });
        this.block(s.body);
        this.loops.pop();
        this.br(cont, 'repeat');
        this.close();
        this.close();
        return;
      }
      case 'For': {
        const i = s.sym.index;
        const endConst = s.end.constValue;
        this.expr(s.start);
        this.emit('local.set', i);
        if (endConst === undefined) {
          this.expr(s.end);
          this.emit('local.set', s.endLocal.index);
        }
        const brk = {};
        const top = {};
        const cont = {};
        this.open('block', VOID_BLOCK, brk);
        this.open('loop', VOID_BLOCK, top);
        this.emit('local.get', i);
        if (endConst === undefined) this.emit('local.get', s.endLocal.index);
        else this.emit('i32.const', endConst);
        this.emit(s.inclusive ? 'i32.gt_s' : 'i32.ge_s');
        this.brIf(brk, 'exit loop');
        this.open('block', VOID_BLOCK, cont);
        this.loops.push({ brk, cont });
        this.block(s.body);
        this.loops.pop();
        this.close();
        this.emit('local.get', i);
        this.emit('i32.const', 1);
        this.emit('i32.add');
        this.emit('local.set', i);
        this.br(top, 'repeat');
        this.close();
        this.close();
        return;
      }
      case 'Break':
        this.br(this.loops[this.loops.length - 1].brk, 'break');
        return;
      case 'Continue':
        this.br(this.loops[this.loops.length - 1].cont, 'continue');
        return;
      case 'Return':
        if (s.value) this.expr(s.value);
        this.emit('return');
        return;
      case 'ExprStmt':
        if (s.expr.constValue !== undefined) return; // no side effects
        this.expr(s.expr);
        if (s.expr.type !== 'void') this.emit('drop');
        return;
      case 'Block':
        this.block(s);
        return;
    }
    throw new Error(`codegen: unknown statement ${s.kind}`);
  }

  assign(s) {
    const t = s.target;
    const type = s.targetType;
    if (t.kind === 'Ident') {
      const sym = t.sym;
      if (s.op !== '=') this.loadVar(sym);
      this.expr(s.value);
      if (s.op !== '=') this.binop(s.op, type, s);
      if (sym.kind === 'local') this.emit('local.set', sym.index);
      else this.emit('global.set', sym);
      return;
    }
    // array element
    const arr = t.sym;
    this.arrayOffset(t);
    if (s.op !== '=') {
      const off = this.temp('int');
      this.emit('local.tee', off);
      this.emit('local.get', off);
      this.release(off);
      this.arrayLoad(arr);
      this.expr(s.value);
      this.binop(s.op, type, s);
    } else {
      this.expr(s.value);
    }
    if (arr.elem === 'float') this.emit('f64.store', 3, arr.addr);
    else this.emit('i32.store', 2, arr.addr);
  }

  loadVar(sym) {
    if (sym.kind === 'local') this.emit('local.get', sym.index);
    else this.emit('global.get', sym);
  }

  zero(type) {
    if (type === 'float') this.emit('f64.const', 0);
    else this.emit('i32.const', 0);
  }

  constant(type, v) {
    if (type === 'float') this.emit('f64.const', v);
    else if (type === 'str') this.emit('i32.const', this.gen.intern(v));
    else this.emit('i32.const', typeof v === 'boolean' ? +v : v);
  }

  /** Leaves the byte offset (index << log2(size)) on the stack, after a bounds check. */
  arrayOffset(e) {
    const arr = e.sym;
    const shift = arr.elem === 'float' ? 3 : 2;
    const c = e.index.constValue;
    if (c !== undefined && c >= 0 && c < arr.size) {
      this.emit('i32.const', c << shift);
      return;
    }
    const idx = this.temp('int');
    this.expr(e.index);
    this.emit('local.tee', idx);
    this.emit('i32.const', arr.size);
    this.emit('i32.ge_u');
    this.open('if', VOID_BLOCK);
    this.trap({ kind: 'index', name: arr.name, size: arr.size, line: e.span.line, col: e.span.col }, idx);
    this.close();
    this.emit('local.get', idx);
    this.emit('i32.const', shift);
    this.emit('i32.shl');
    this.release(idx);
  }

  arrayLoad(arr) {
    if (arr.elem === 'float') this.emit('f64.load', 3, arr.addr);
    else this.emit('i32.load', 2, arr.addr);
  }

  // ---------------------------------------------------------- expressions

  expr(e) {
    if (e.constValue !== undefined && e.type !== 'void') return this.constant(e.type, e.constValue);
    switch (e.kind) {
      case 'Ident':
        return this.loadVar(e.sym);
      case 'Unary':
        if (e.op === '-') {
          if (e.type === 'float') {
            this.expr(e.operand);
            this.emit('f64.neg');
          } else {
            this.emit('i32.const', 0);
            this.expr(e.operand);
            this.emit('i32.sub');
          }
        } else if (e.op === '!') {
          this.expr(e.operand);
          this.emit('i32.eqz');
        } else {
          this.expr(e.operand);
          this.emit('i32.const', -1);
          this.emit('i32.xor');
        }
        return;
      case 'Binary':
        if (e.op === '&&') {
          this.expr(e.left);
          this.open('if', I32);
          this.expr(e.right);
          this.emit('else');
          this.emit('i32.const', 0);
          this.close();
          return;
        }
        if (e.op === '||') {
          this.expr(e.left);
          this.open('if', I32);
          this.emit('i32.const', 1);
          this.emit('else');
          this.expr(e.right);
          this.close();
          return;
        }
        this.expr(e.left);
        this.expr(e.right);
        this.binop(e.op, e.left.type, e);
        return;
      case 'Cast':
        this.expr(e.expr);
        this.convert(e.expr.type, e.type);
        return;
      case 'Ternary':
        this.expr(e.cond);
        this.open('if', valType(e.type));
        this.expr(e.then);
        this.emit('else');
        this.expr(e.else);
        this.close();
        return;
      case 'Call':
        return this.call(e);
      case 'Index':
        if (e.indexKind === 'array') {
          this.arrayOffset(e);
          this.arrayLoad(e.sym);
        } else {
          const s = this.temp('int');
          const i = this.temp('int');
          this.expr(e.target);
          this.emit('local.set', s);
          this.expr(e.index);
          this.emit('local.tee', i);
          this.emit('local.get', s);
          this.emit('i32.load', 2, 0);
          this.emit('i32.ge_u');
          this.open('if', VOID_BLOCK);
          this.trap({ kind: 'strindex', line: e.span.line, col: e.span.col }, i);
          this.close();
          this.emit('local.get', s);
          this.emit('local.get', i);
          this.emit('i32.add');
          this.emit('i32.load8_u', 0, 4);
          this.release(s, i);
        }
        return;
    }
    throw new Error(`codegen: unknown expression ${e.kind}`);
  }

  binop(op, type, node) {
    if (type === 'float') {
      if (op === '%') {
        const a = this.temp('float');
        const b = this.temp('float');
        this.emit('local.set', b);
        this.emit('local.set', a);
        this.emit('local.get', a);
        this.emit('local.get', a);
        this.emit('local.get', b);
        this.emit('f64.div');
        this.emit('f64.trunc');
        this.emit('local.get', b);
        this.emit('f64.mul');
        this.emit('f64.sub');
        this.release(a, b);
        return;
      }
      const F = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '==': 'eq', '!=': 'ne', '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge' };
      this.emit('f64.' + F[op]);
      return;
    }
    if ((op === '/' || op === '%') && node.checkZero) {
      const d = this.temp('int');
      this.emit('local.tee', d);
      this.emit('i32.eqz');
      this.open('if', VOID_BLOCK);
      this.trap({ kind: 'divzero', line: node.span.line, col: node.span.col });
      this.close();
      this.emit('local.get', d);
      this.release(d);
    }
    const I = {
      '+': 'add', '-': 'sub', '*': 'mul', '/': 'div_s', '%': 'rem_s', '&': 'and', '|': 'or', '^': 'xor',
      '<<': 'shl', '>>': 'shr_s', '>>>': 'shr_u', '==': 'eq', '!=': 'ne', '<': 'lt_s', '<=': 'le_s', '>': 'gt_s', '>=': 'ge_s',
      '&&': 'and', '||': 'or',
    };
    this.emit('i32.' + I[op]);
  }

  convert(from, to) {
    if (from === to) return;
    if (to === 'float') this.emit('f64.convert_i32_s');
    else if (to === 'int') {
      if (from === 'float') this.emit('i32.trunc_sat_f64_s');
    } else if (to === 'bool') {
      if (from === 'float') {
        this.emit('f64.const', 0);
        this.emit('f64.ne');
      } else {
        this.emit('i32.const', 0);
        this.emit('i32.ne');
      }
    }
  }

  /** Stack: [a, b] -> [min(a,b)] or [max(a,b)] for ints, using select. */
  intMinMax(isMin) {
    const a = this.temp('int');
    const b = this.temp('int');
    this.emit('local.set', b);
    this.emit('local.set', a);
    this.emit('local.get', a);
    this.emit('local.get', b);
    this.emit('local.get', a);
    this.emit('local.get', b);
    this.emit(isMin ? 'i32.lt_s' : 'i32.gt_s');
    this.emit('select');
    this.release(a, b);
  }

  call(e) {
    if (e.sym) {
      for (const a of e.args) this.expr(a);
      this.emit('call', e.sym);
      return;
    }
    switch (e.builtin) {
      case 'print':
        for (const a of e.args) {
          this.expr(a);
          this.callImport(`__print_${a.type[0]}`);
        }
        this.callImport('__print_end');
        return;
      case 'select':
        this.expr(e.args[1]);
        this.expr(e.args[2]);
        this.expr(e.args[0]);
        this.emit('select');
        return;
      case 'len':
        this.expr(e.args[0]);
        this.emit('i32.load', 2, 0);
        return;
      case 'import':
        for (const a of e.args) this.expr(a);
        this.callImport(e.callee);
        return;
      case 'intrinsic':
        return this.intrinsic(e);
    }
    throw new Error(`codegen: unknown call ${e.callee}`);
  }

  intrinsic(e) {
    const name = e.callee;
    const isInt = e.overload[1] === 'int';
    const [a, b, c] = e.args;
    const unary = { sqrt: 'f64.sqrt', floor: 'f64.floor', ceil: 'f64.ceil', trunc: 'f64.trunc', round: 'f64.nearest' };
    if (name in unary) {
      this.expr(a);
      this.emit(unary[name]);
      return;
    }
    if (name === 'abs') {
      this.expr(a);
      if (!isInt) {
        this.emit('f64.abs');
        return;
      }
      // (x ^ (x >> 31)) - (x >> 31)
      const x = this.temp('int');
      const m = this.temp('int');
      this.emit('local.tee', x);
      this.emit('i32.const', 31);
      this.emit('i32.shr_s');
      this.emit('local.tee', m);
      this.emit('local.get', x);
      this.emit('i32.xor');
      this.emit('local.get', m);
      this.emit('i32.sub');
      this.release(x, m);
      return;
    }
    if (name === 'min' || name === 'max') {
      this.expr(a);
      this.expr(b);
      if (isInt) this.intMinMax(name === 'min');
      else this.emit(name === 'min' ? 'f64.min' : 'f64.max');
      return;
    }
    if (name === 'clamp') {
      this.expr(a);
      this.expr(b);
      if (isInt) this.intMinMax(false);
      else this.emit('f64.max');
      this.expr(c);
      if (isInt) this.intMinMax(true);
      else this.emit('f64.min');
      return;
    }
    throw new Error(`codegen: unknown intrinsic ${name}`);
  }
}

function uniqueNames(names) {
  const seen = new Map();
  return names.map((n) => {
    const count = seen.get(n) ?? 0;
    seen.set(n, count + 1);
    return count ? `${n}_${count + 1}` : n;
  });
}
