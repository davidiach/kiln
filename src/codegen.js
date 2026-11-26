// Code generation: annotated AST -> WebAssembly binary (+ a WAT listing).
//
// Every instruction is written twice: as bytes into the module, and as text
// into a human-readable WAT listing that mirrors the binary 1:1. Only
// functions reachable from main/frame/exports are emitted; everything else
// (including unused prelude functions) is stripped.
//
// Structs are flattened into their scalar leaves (see types.js). A struct
// value on the wasm stack is just its leaves in order, struct locals and
// globals are runs of scalar locals/globals, functions take and return them
// as multiple values, and arrays of structs are laid out in linear memory.

import { ByteWriter, OPS, SECTION, I32, F64, VOID_BLOCK, valType, valTypeName, f64Text } from './wasm.js';
import { IMPORTS } from './builtins.js';
import { isStruct, leafTypes, numericKind, sizeOf, alignOf, isVector, isMask, laneType, laneCount, shapeOf } from './types.js';
import { printImport, laneValue } from './checker.js';

const textEncoder = new TextEncoder();

/**
 * Can evaluating this expression change a caller's variable? Only a
 * `var self` method call can (it stores its receiver back).
 */
function mayMutate(e) {
  if (!e || typeof e !== 'object') return false;
  if (e.mayMutate !== undefined) return e.mayMutate;
  let m = e.kind === 'MethodCall' && e.method?.selfMode === 'var';
  for (const k of ['left', 'right', 'operand', 'expr', 'cond', 'then', 'else', 'target', 'index', 'receiver']) m ||= mayMutate(e[k]);
  if (e.args) for (const a of e.args) m ||= mayMutate(a);
  e.mayMutate = m;
  return m;
}
const align = (n, a) => Math.ceil(n / a) * a;

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64 VLQ, as source map mappings use: sign in the lowest bit, 5 bits per digit. */
function vlq(n) {
  let v = n < 0 ? (-n << 1) | 1 : n << 1;
  let out = '';
  do {
    let digit = v & 31;
    v >>>= 5;
    if (v) digit |= 32;
    out += BASE64[digit];
  } while (v);
  return out;
}

const CHILDREN = ['left', 'right', 'operand', 'expr', 'cond', 'then', 'else', 'target', 'index', 'receiver', 'init', 'value', 'start', 'end', 'body', 'args'];

/** The local variables a statement or expression mentions (reads or writes), anywhere inside it. */
function localsIn(node, out = new Set()) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const n of node) localsIn(n, out);
    return out;
  }
  if (node.kind === 'Ident' && node.sym?.kind === 'local') out.add(node.sym);
  for (const k of CHILDREN) localsIn(node[k], out);
  return out;
}

/** What kind of wasm local holds a leaf: 'float' (f64), 'v128' or 'int' (i32). */
const localKind = (t) => (t === 'float' ? 'float' : isVector(t) || t === 'v128' ? 'v128' : 'int');
const TEMP_POOL = { float: 'f64', v128: 'v128', int: 'i32' };
const SHIFTS = new Set(['<<', '>>', '>>>']);

/** A vector constant's lanes as the bits wasm stores: bool lanes are -1 or 0. */
const vectorBits = (V, lanes) => (isMask(V) ? lanes.map((b) => (b ? -1 : 0)) : lanes);

/** How a vector's lanes are written in a v128.const: 'f32', 'i32', 'f64' or 'i64'. */
const laneKind = (V) => shapeOf(V).slice(0, 3);

function v128Text(V, lanes) {
  const bits = vectorBits(V, lanes);
  const shape = shapeOf(V);
  return `${shape} ${(shape[0] === 'f' ? bits.map(f64Text) : bits).join(' ')}`;
}

/** `x` in every lane of a `V`. */
const lanesOf = (V, x) => Array.from({ length: laneCount(V) }, () => x);

/**
 * What a function leaves on the stack when it returns: its return value's
 * leaves and, for a `var self` method, the updated receiver's leaves, which
 * the caller stores back where the receiver came from.
 */
const resultsOf = (f) => [...leafTypes(f.ret), ...(f.selfMode === 'var' ? leafTypes(f.owner) : [])];

export function generate(checker, sources, options = {}) {
  return new Generator(checker, sources, options).run();
}

const INLINE_MAX_NODES = 48;
const INLINE_MAX_DEPTH = 4;
// Expression nodes one function may take in through inlining, so that nested
// calls (f calls g twice, g calls h twice, ...) can't blow up its size.
const INLINE_BUDGET = 1000;

/** Size of an expression tree, for the inliner's budget. */
function exprSize(e) {
  if (!e || typeof e !== 'object') return 0;
  let n = 1;
  for (const k of ['left', 'right', 'operand', 'expr', 'cond', 'then', 'else', 'target', 'index', 'receiver']) n += exprSize(e[k]);
  if (e.args) for (const a of e.args) n += exprSize(a);
  return n;
}

class Generator {
  constructor(ck, sources, options = {}) {
    this.ck = ck;
    this.inline = options.inline !== false;
    this.sources = Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, v.split('\n')]));
    this.sourceText = sources;
    this.fileNames = { user: options.filename ?? 'program.kiln', prelude: 'prelude.kiln' };
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
    let globalLeaves = 0;
    for (const g of this.globals) {
      g.index = globalLeaves;
      globalLeaves += leafTypes(g.type).length;
    }

    // ---- linear memory layout
    // Bytes 0..7 stay zero: read as a string, address 0 is [len = 0], so every
    // zero-initialized str (a local without a value, a field of a fresh
    // struct, an element of a fresh array) is a valid empty string.
    // Arrays come next, then string literals.
    this.arrays = ck.arrays.filter((a) => usedArrays.has(a));
    this.strings.set('', 0);
    let addr = 8;
    const inits = [];
    for (const a of this.arrays) {
      a.addr = align(addr, Math.max(8, alignOf(a.elem)));
      addr = a.addr + a.size * sizeOf(a.elem);
      if (a.init && a.init.length) inits.push(a);
    }
    this.dataEnd = addr;
    for (const a of inits) this.segments.push({ addr: a.addr, bytes: this.encodeArray(a), label: a.name });
    const screen = this.arrays.find((a) => a.name === 'screen' && a.origin === 'prelude');

    // ---- function bodies
    // Inlining can leave a reachable function with no calls left (every call
    // to a small operator, say, was expanded in place). Such functions are
    // dropped and the bodies generated again, so the module only holds what
    // it calls. Imports, globals and arrays stay as they are: the inlined
    // copies still use them.
    const before = {
      traps: this.traps.length,
      segments: this.segments.length,
      dataEnd: this.dataEnd,
      strings: new Map(this.strings),
      types: this.types.length,
      typeKeys: new Map(this.typeKeys),
    };
    let bodies = this.generateBodies();
    const called = new Set();
    const pending = [...roots];
    while (pending.length) {
      const f = pending.pop();
      if (called.has(f)) continue;
      called.add(f);
      for (const c of bodies[this.funcs.indexOf(f)].called) pending.push(c);
    }
    if (called.size < this.funcs.length) {
      this.funcs = this.funcs.filter((f) => called.has(f));
      this.funcs.forEach((f, i) => (f.index = this.imports.length + i));
      this.traps.length = before.traps;
      this.segments.length = before.segments;
      this.dataEnd = before.dataEnd;
      this.strings = before.strings;
      this.types.length = before.types;
      this.typeKeys = before.typeKeys;
      bodies = this.generateBodies();
    }

    // ---- globals: one wasm global per scalar leaf
    const allGlobals = [];
    for (const g of this.globals) {
      const ls = leafTypes(g.type);
      ls.forEach((t, i) => {
        allGlobals.push({
          name: isStruct(g.type) ? `${g.name}.${g.type.leafPaths[i]}` : g.name,
          type: t,
          mutable: true,
          value: this.leafValue(t, isStruct(g.type) ? g.value[i] : g.value),
        });
      });
    }

    const exports = [{ name: 'memory', kind: 2, index: 0 }];
    for (const f of this.funcs) {
      if (f === ck.main || f === ck.frame || f.exported) exports.push({ name: f.name, kind: 0, index: f.index, fn: f });
    }
    if (screen) {
      exports.push({ name: '__screen', kind: 3, index: allGlobals.length });
      allGlobals.push({ name: '__screen', type: 'int', mutable: false, value: screen.addr });
    }

    const memBytes = Math.max(this.dataEnd, 1);
    const pages = Math.max(1, Math.ceil(memBytes / 65536));

    // ---- assemble the binary
    this.imports.forEach((im) => (im.type = this.typeIndex(im.params, im.ret === 'void' ? [] : [im.ret])));
    this.funcs.forEach((f) => (f.typeIdx = this.typeIndex(f.params.flatMap((p) => leafTypes(p.type)), resultsOf(f))));

    const sections = [];
    const mod = new ByteWriter();
    mod.raw([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    sections.push({ name: 'header', start: 0, end: 8 });
    const section = (id, name, build) => {
      const body = new ByteWriter();
      build(body);
      const start = mod.length;
      mod.u8(id).sized(body);
      sections.push({ name, start, end: mod.length, contentStart: mod.length - body.length });
    };

    section(SECTION.type, 'type', (w) =>
      w.vec(this.types, (t) => {
        w.u8(0x60);
        w.vec(t.params, (p) => w.u8(valType(p)));
        w.vec(t.results, (r) => w.u8(valType(r)));
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
          else if (isVector(g.type)) w.raw(OPS['v128.const'].slice(0, -1)).v128(g.value, laneKind(g.type));
          else w.u8(0x41).s32(g.value);
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
        fg.codeStart = w.length - fg.code.length - 1; // within the section's contents
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
    const codeAt = sections.find((x) => x.name === 'code').contentStart;
    const positions = bodies.flatMap((fg) => fg.pos.map(([off, sp]) => [codeAt + fg.codeStart + off, sp.origin, sp.line, sp.col]));
    const wat = this.wat(bodies, exports, allGlobals, pages);
    return {
      binary,
      wat,
      sections,
      positions,
      sourceMap: this.sourceMap(positions),
      traps: this.traps,
      hasScreen: !!screen,
      stats: {
        bytes: binary.length,
        functions: this.funcs.length,
        stripped: ck.funcs.length - this.funcs.length,
        imports: this.imports.map((i) => i.name),
        memoryPages: pages,
        dataBytes: this.dataEnd,
      },
    };
  }

  generateBodies() {
    return this.funcs.map((f) => {
      const fg = new FnGen(this, f);
      fg.generate();
      return fg;
    });
  }

  /**
   * A version 3 source map. For WebAssembly, the "column" is the byte offset
   * of an instruction in the module, and every mapping is on line 1.
   */
  sourceMap(positions) {
    const origins = ['user', 'prelude'];
    let segs = '';
    let prev = [0, 0, 0, 0];
    for (const [offset, origin, line, col] of positions) {
      const cur = [offset, origins.indexOf(origin), line - 1, col - 1];
      if (segs) segs += ',';
      segs += cur.map((v, i) => vlq(v - prev[i])).join('');
      prev = cur;
    }
    return {
      version: 3,
      sources: origins.map((o) => this.fileNames[o]),
      sourcesContent: origins.map((o) => this.sourceText[o]),
      names: [],
      mappings: segs,
    };
  }

  typeIndex(params, results) {
    const key = params.map(valType).join(',') + '->' + results.map(valType).join(',');
    let idx = this.typeKeys.get(key);
    if (idx === undefined) {
      idx = this.types.length;
      this.types.push({ params, results, key });
      this.typeKeys.set(key, idx);
    }
    return idx;
  }

  /** The i32/f64 a scalar constant becomes. */
  leafValue(type, v) {
    if (type === 'float') return v;
    if (isVector(type)) return vectorBits(type, v);
    if (type === 'str') return this.intern(v);
    return typeof v === 'boolean' ? +v : v;
  }

  encodeArray(a) {
    const size = sizeOf(a.elem);
    const bytes = new Uint8Array(a.init.length * size);
    const view = new DataView(bytes.buffer);
    const types = leafTypes(a.elem);
    const offsets = isStruct(a.elem) ? a.elem.leafOffsets : [0];
    a.init.forEach((v, i) => {
      const vals = isStruct(a.elem) ? v : [v];
      types.forEach((t, j) => {
        const off = i * size + offsets[j];
        const x = this.leafValue(t, vals[j]);
        if (t === 'float') view.setFloat64(off, x, true);
        else if (isVector(t)) new ByteWriter().v128(x, laneKind(t)).bytes.forEach((b, k) => view.setUint8(off + k, b));
        else view.setInt32(off, x, true);
      });
    });
    return [...bytes];
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
    const results = (ts) => (ts.length ? ` (result ${ts.map(vt).join(' ')})` : '');
    for (const im of this.imports) {
      const params = im.params.map((p) => ` (param ${vt(p)})`).join('');
      out.push(`  (import "env" "${im.name}" (func $${im.name}${params}${results(im.ret === 'void' ? [] : [im.ret])}))`);
    }
    out.push(`  (memory (export "memory") ${pages})`);
    for (const g of globals) {
      const init = g.type === 'float' ? `f64.const ${f64Text(g.value)}` : isVector(g.type) ? `v128.const ${v128Text(g.type, g.value)}` : `i32.const ${g.value}`;
      const ty = g.mutable ? `(mut ${vt(g.type)})` : vt(g.type);
      const ex = g.name === '__screen' ? ` (export "__screen")` : '';
      out.push(`  (global $${g.name}${ex} ${ty} (${init}))`);
    }
    for (const fg of bodies) {
      const f = fg.sym;
      const ex = exports.find((e) => e.fn === f);
      const exText = ex ? ` (export "${f.name}")` : '';
      const np = f.paramLeafCount;
      const params = fg.localTypes.slice(0, np).map((t, i) => ` (param $${fg.localNames[i]} ${vt(t)})`).join('');
      out.push('');
      out.push(`  (func $${f.name}${exText}${params}${results(resultsOf(f))}`);
      const locals = fg.localTypes.slice(np);
      if (locals.length) {
        const decl = locals.map((t, i) => `(local $${fg.localNames[np + i]} ${vt(t)})`);
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
    // Wasm locals. Parameters come first, in the checker's order. Every other
    // local is handed out by temp() from a free list per wasm type: a
    // variable gets its slots at its `let` and gives them back after the last
    // statement that mentions it (see statements()), so variables whose
    // lifetimes don't overlap, and temporaries, share slots. slotNames records
    // every variable a slot has held.
    const np = sym.paramLeafCount;
    this.localTypes = sym.locals.slice(0, np).map((l) => localKind(l.type));
    this.slotNames = sym.locals.slice(0, np).map((l) => [l.name]);
    this.localNames = null; // final names, once the body is generated
    this.slots = new Map(); // local variable symbol -> its wasm locals
    for (const p of sym.paramSyms) this.slots.set(p, leafTypes(p.type).map((_, i) => p.index + i));
    this.declared = []; // variables in scope, innermost last
    this.free = { i32: [], f64: [], v128: [] };
    this.src = gen.sources[sym.origin] ?? [];
    this.lastLine = -1;
    // While a call is being inlined: the callee's parameter symbols mapped to
    // the caller's locals holding the argument values, and the callees.
    this.inlineMap = null;
    this.inlineStack = [];
    this.called = new Set(); // functions this body actually calls
    this.inlinedNodes = 0;
    // For the source map: [offset in this.code, position] whenever the
    // position changes. `span` is the statement being compiled (or, inside
    // an inlined call, the inlined function's return statement).
    this.pos = [];
    this.span = null;
  }

  generate() {
    const body = this.sym.decl.body.body;
    this.statements(body);
    const last = body[body.length - 1];
    if (this.sym.selfMode === 'var' && this.sym.ret === 'void') {
      this.pushSelf(); // falling off the end returns the updated receiver
    } else if (this.sym.ret !== 'void' && !(last && last.kind === 'Return')) {
      // Every path returned already (the checker verified it), but wasm's
      // validator wants the fallthrough to be provably dead.
      this.emit('unreachable');
    }
    this.nameLocals();
  }

  /**
   * Name each wasm local after the variables it held: `x`, or `x|y` when y
   * reused x's slot once x was done; `t.N` for one only temporaries used.
   * The listing was written with placeholders; fill them in.
   */
  nameLocals() {
    const names = this.slotNames.map((ns, i) => (ns.length ? [...new Set(ns)].join('|') : `t.${i}`));
    this.localNames = uniqueNames(names);
    this.lines = this.lines.map((l) => l.replace(/\u0001(\d+)\u0001/g, (_, i) => this.localNames[i]));
  }

  /** A `var self` method hands its (possibly changed) self back to the caller. */
  pushSelf() {
    const n = leafTypes(this.sym.owner).length;
    for (let i = 0; i < n; i++) this.emit('local.get', i); // self is always the first parameter
  }

  localGroups() {
    const groups = [];
    for (const t of this.localTypes.slice(this.sym.paramLeafCount)) {
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
    // Peephole: `local.set x; local.get x` is exactly `local.tee x`.
    const prev = this.prev;
    if (name === 'local.get' && prev && prev.name === 'local.set' && prev.arg === args[0]) {
      this.code.bytes[prev.pos] = OPS['local.tee'][0];
      this.lines[prev.line] = this.lines[prev.line].replace('local.set', 'local.tee');
      this.prev = null;
      return;
    }
    if (this.span && this.span !== this.pos[this.pos.length - 1]?.[1]) this.pos.push([this.code.length, this.span]);
    this.prev = { name, arg: args[0], pos: this.code.length, line: this.lines.length };
    if (name === 'call' && !this.gen.imports.includes(args[0])) {
      // Calls are only ever emitted to functions that are in the module.
      if (!this.gen.funcs.includes(args[0])) throw new Error(`codegen: call to dropped function ${args[0].name}`);
      this.called.add(args[0]);
    }
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
          if (typeof bt === 'object') {
            // multi-value block: refers to a function type with no params
            this.code.s32(bt.typeIndex);
            text += ` (result ${bt.results.map((r) => valTypeName(valType(r))).join(' ')})`;
          } else {
            this.code.u8(bt);
            if (bt !== VOID_BLOCK) text += ` (result ${valTypeName(bt)})`;
          }
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
          text += ` $\u0001${args[0]}\u0001`; // named in nameLocals()
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
        case 'lane':
          this.code.u8(args[0]);
          text += ` ${args[0]}`;
          break;
        case 'v128': {
          const [V, lanes] = args;
          this.code.v128(vectorBits(V, lanes), laneKind(V));
          text += ` ${v128Text(V, lanes)}`;
          break;
        }
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

  /** Block type for a value of `type`: none, one value, or several (multi-value). */
  blockType(type) {
    const ls = leafTypes(type);
    if (ls.length === 0) return VOID_BLOCK;
    if (ls.length === 1) return valType(ls[0]);
    return { typeIndex: this.gen.typeIndex([], ls), results: ls };
  }

  temp(type) {
    const kind = localKind(type);
    const pool = this.free[TEMP_POOL[kind]];
    if (pool.length) return pool.pop();
    const idx = this.localTypes.length;
    this.localTypes.push(kind);
    this.slotNames.push([]);
    return idx;
  }

  /** Give a variable its wasm locals (one per leaf), reusing free ones. */
  declare(sym) {
    const names = isStruct(sym.type) ? sym.type.leafPaths.map((p) => `${sym.name}.${p}`) : [sym.name];
    const idx = leafTypes(sym.type).map((t, i) => {
      const slot = this.temp(t);
      this.slotNames[slot].push(names[i]);
      return slot;
    });
    this.slots.set(sym, idx);
    this.declared.push(sym);
    return idx;
  }

  /** End a scope: variables declared since `mark` give their locals back. */
  endScope(mark) {
    while (this.declared.length > mark) this.release(...this.slots.get(this.declared.pop()));
  }
  release(...idxs) {
    for (const idx of idxs) this.free[TEMP_POOL[this.localTypes[idx]]].push(idx);
  }

  /** Pop a value of `type` off the stack into fresh temps (one per leaf). */
  spill(type) {
    const temps = leafTypes(type).map((t) => this.temp(t));
    for (let i = temps.length - 1; i >= 0; i--) this.emit('local.set', temps[i]);
    return { locals: temps, temps };
  }

  /** The wasm locals holding a local variable's leaves (remapped inside an inlined call). */
  localIndices(sym) {
    const idx = this.inlineMap?.get(sym) ?? this.slots.get(sym);
    if (!idx) throw new Error(`codegen: no wasm local for '${sym.name}'`);
    return idx;
  }

  /**
   * Make the leaves of `e` available in locals. A local variable is used in
   * place, unless one of the `later` expressions (evaluated after `e`) could
   * change it, in which case its current value is copied first.
   */
  materialize(e, later = []) {
    if (e.constValue === undefined && e.kind === 'Ident' && e.sym.kind === 'local' && !later.some(mayMutate)) {
      return { locals: this.localIndices(e.sym), temps: [] };
    }
    this.expr(e);
    return this.spill(e.type);
  }

  callImport(name) {
    this.emit('call', this.gen.importByName.get(name));
  }

  trap(info, valueLocal) {
    const owner = this.inlineStack[this.inlineStack.length - 1] ?? this.sym;
    const site = this.gen.trapSite({ ...info, origin: owner.origin, fn: owner.name });
    this.emit('i32.const', site);
    if (valueLocal === undefined) this.emit('i32.const', 0);
    else this.emit('local.get', valueLocal);
    this.callImport('__trap');
    this.emit('unreachable');
  }

  load(type, offset) {
    if (type === 'float') this.emit('f64.load', 3, offset);
    else if (isVector(type)) this.emit('v128.load', 4, offset);
    else this.emit('i32.load', 2, offset);
  }

  store(type, offset) {
    if (type === 'float') this.emit('f64.store', 3, offset);
    else if (isVector(type)) this.emit('v128.store', 4, offset);
    else this.emit('i32.store', 2, offset);
  }

  // ----------------------------------------------------------------- lanes

  /** Push scalar `e` into all four lanes; a constant becomes one v128.const. */
  pushSplat(e, V) {
    if (e.constValue !== undefined) {
      this.emit('v128.const', V, lanesOf(V, laneValue(V, e.constValue)));
      return;
    }
    this.expr(e);
    this.splat(V);
  }

  /**
   * Stack: [Kiln scalar] -> [the value one lane of V holds]. A float becomes
   * an f32 for f32x4; a bool (1 or 0) becomes all ones or all zeros.
   */
  toLane(V) {
    if (V === 'f32x4') this.emit('f32.demote_f64');
    if (isMask(V)) {
      this.emit('i32.const', -1);
      this.emit('i32.mul');
      if (V === 'boolx2') this.emit('i64.extend_i32_s');
    }
  }

  /** Stack: [scalar] -> [vector with the scalar in every lane]. */
  splat(V) {
    this.toLane(V);
    this.emit(`${shapeOf(V)}.splat`);
  }

  /** Stack: [vector] -> [lane as a Kiln scalar]. */
  extractLane(V, lane) {
    this.emit(`${shapeOf(V)}.extract_lane`, lane);
    if (V === 'f32x4') this.emit('f64.promote_f32');
    if (V === 'boolx2') this.emit('i32.wrap_i64');
    if (isMask(V)) {
      this.emit('i32.const', 1); // all ones -> 1
      this.emit('i32.and');
    }
  }

  /** Stack: [vector, scalar] -> [vector with that lane replaced]. */
  replaceLane(V, lane) {
    this.toLane(V);
    this.emit(`${shapeOf(V)}.replace_lane`, lane);
  }

  /** Lane-wise operator on two vectors on the stack (a shift takes an int count instead). */
  vecop(op, V, node) {
    const shape = shapeOf(V);
    if (laneType(V) === 'float') {
      if (op === '%') {
        // like float %: a - trunc(a / b) * b
        const a = this.temp('v128');
        const b = this.temp('v128');
        this.emit('local.set', b);
        this.emit('local.tee', a);
        this.emit('local.get', a);
        this.emit('local.get', b);
        this.emit(`${shape}.div`);
        this.emit(`${shape}.trunc`);
        this.emit('local.get', b);
        this.emit(`${shape}.mul`);
        this.emit(`${shape}.sub`);
        this.release(a, b);
        return;
      }
      const F = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '==': 'eq', '!=': 'ne', '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge' };
      this.emit(`${shape}.${F[op]}`);
      return;
    }
    const BITS = { '&': 'v128.and', '|': 'v128.or', '^': 'v128.xor' };
    if (op in BITS) {
      this.emit(BITS[op]);
      return;
    }
    if (V === 'boolx2') {
      // masks only compare for (in)equality; i64x2 has eq and ne
      this.emit(op === '==' ? 'i64x2.eq' : 'i64x2.ne');
      return;
    }
    const I = {
      '+': 'add', '-': 'sub', '*': 'mul', '<<': 'shl', '>>': 'shr_s', '>>>': 'shr_u',
      '==': 'eq', '!=': 'ne', '<': 'lt_s', '<=': 'le_s', '>': 'gt_s', '>=': 'ge_s',
    };
    if (!(op in I)) throw new Error(`codegen: no ${op} for ${V} (line ${node?.span?.line})`);
    this.emit('i32x4.' + I[op]);
  }

  globalLeaf(sym, i) {
    return { index: sym.index + i, name: isStruct(sym.type) ? `${sym.name}.${sym.type.leafPaths[i]}` : sym.name };
  }

  // ---------------------------------------------------------------- places
  //
  // A place is somewhere a value lives: a run of locals, a run of globals, or
  // a spot in linear memory (base address in a temp + a static offset).
  // Field access on a place just narrows it, without loading anything else.

  place(e) {
    switch (e.kind) {
      case 'Ident': {
        const s = e.sym;
        if (s.kind === 'local') return { kind: 'local', idx: this.localIndices(s), type: e.type, temps: [] };
        if (s.kind === 'global') return { kind: 'global', sym: s, leaf: 0, type: e.type, temps: [] };
        return null;
      }
      case 'Field': {
        const p = this.place(e.target);
        if (!p) return null;
        if (e.lane !== undefined) return { kind: 'lane', base: p, lane: e.lane, vec: e.target.type, type: e.type, temps: p.temps };
        const S = e.target.type;
        const i = e.fieldIndex;
        const type = S.fields[i].type;
        if (p.kind === 'local') return { ...p, idx: p.idx.slice(S.fieldLeaf[i], S.fieldLeaf[i] + leafTypes(type).length), type };
        if (p.kind === 'global') return { ...p, leaf: p.leaf + S.fieldLeaf[i], type };
        return { ...p, offset: p.offset + S.fieldOffset[i], type };
      }
      case 'Index': {
        if (e.indexKind !== 'array') return null;
        const arr = e.sym;
        const c = e.index.constValue;
        if (c !== undefined && c >= 0 && c < arr.size) {
          return { kind: 'mem', dyn: null, offset: arr.addr + c * sizeOf(arr.elem), type: arr.elem, temps: [] };
        }
        const t = this.temp('int');
        this.arrayOffset(e);
        this.emit('local.set', t);
        return { kind: 'mem', dyn: t, offset: arr.addr, type: arr.elem, temps: [t] };
      }
    }
    return null;
  }

  leafOffset(p, i) {
    return p.offset + (isStruct(p.type) ? p.type.leafOffsets[i] : 0);
  }

  memBase(p) {
    if (p.dyn === null) this.emit('i32.const', 0);
    else this.emit('local.get', p.dyn);
  }

  loadPlace(p) {
    if (p.kind === 'lane') {
      this.loadPlace(p.base);
      this.extractLane(p.vec, p.lane);
      return;
    }
    leafTypes(p.type).forEach((t, i) => {
      if (p.kind === 'local') this.emit('local.get', p.idx[i]);
      else if (p.kind === 'global') this.emit('global.get', this.globalLeaf(p.sym, p.leaf + i));
      else {
        this.memBase(p);
        this.load(t, this.leafOffset(p, i));
      }
    });
  }

  /** Store the value on top of the stack into the place. */
  storePlace(p) {
    if (p.kind === 'lane') {
      // read the whole vector, replace one lane, write it back
      const v = this.temp(p.type);
      this.emit('local.set', v);
      this.loadPlace(p.base);
      this.emit('local.get', v);
      this.replaceLane(p.vec, p.lane);
      this.storePlace(p.base);
      this.release(v);
      return;
    }
    const ls = leafTypes(p.type);
    if (p.kind === 'local') {
      for (let i = ls.length - 1; i >= 0; i--) this.emit('local.set', p.idx[i]);
    } else if (p.kind === 'global') {
      for (let i = ls.length - 1; i >= 0; i--) this.emit('global.set', this.globalLeaf(p.sym, p.leaf + i));
    } else {
      const v = this.spill(p.type);
      ls.forEach((t, i) => {
        this.memBase(p);
        this.emit('local.get', v.locals[i]);
        this.store(t, this.leafOffset(p, i));
      });
      this.release(...v.temps);
    }
  }

  // ----------------------------------------------------------- statements

  block(b) {
    this.statements(b.body);
  }

  /**
   * Generate a block's statements. A variable declared here gives its locals
   * back right after the last statement that mentions it, not only when the
   * block ends. That is safe with loops: a variable used inside a loop is
   * mentioned by the loop statement as a whole, and one declared inside a
   * loop body is declared again on every iteration.
   */
  statements(list) {
    const mark = this.declared.length;
    const lastUse = new Map();
    list.forEach((s, j) => {
      for (const sym of localsIn(s)) lastUse.set(sym, j);
    });
    list.forEach((s, j) => {
      this.stmt(s);
      for (let k = this.declared.length - 1; k >= mark; k--) {
        const sym = this.declared[k];
        if ((lastUse.get(sym) ?? -1) <= j) {
          this.release(...this.slots.get(sym));
          this.declared.splice(k, 1);
        }
      }
    });
    this.endScope(mark);
  }

  stmt(s) {
    // Instructions belong to the innermost statement; after a nested one,
    // the rest of this statement's code (a loop's increment) is this one's.
    const outer = this.span;
    if (s.kind !== 'Block') this.span = { origin: this.sym.origin, line: s.span.line, col: s.span.col };
    try {
      this.stmtCode(s);
    } finally {
      this.span = outer;
    }
  }

  stmtCode(s) {
    if (s.kind !== 'Block') this.lineComment(s.span);
    switch (s.kind) {
      case 'Let': {
        const type = s.sym.type;
        if (s.init) this.expr(s.init);
        else leafTypes(type).forEach((t) => this.zero(t));
        // Declared after the initializer, so it can reuse that expression's temporaries.
        const idx = this.declare(s.sym);
        for (let i = idx.length - 1; i >= 0; i--) this.emit('local.set', idx[i]);
        return;
      }
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
        const mark = this.declared.length;
        const endConst = s.end.constValue;
        this.expr(s.start);
        const [i] = this.declare(s.sym);
        this.emit('local.set', i);
        let end;
        if (endConst === undefined) {
          this.expr(s.end);
          [end] = this.declare(s.endLocal); // a constant end needs no local
          this.emit('local.set', end);
        }
        const brk = {};
        const top = {};
        const cont = {};
        this.open('block', VOID_BLOCK, brk);
        this.open('loop', VOID_BLOCK, top);
        this.emit('local.get', i);
        if (endConst === undefined) this.emit('local.get', end);
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
        this.endScope(mark);
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
        if (this.sym.selfMode === 'var') this.pushSelf();
        this.emit('return');
        return;
      case 'ExprStmt':
        if (s.expr.constValue !== undefined) return; // no side effects
        this.expr(s.expr);
        for (let i = 0; i < leafTypes(s.expr.type).length; i++) this.emit('drop');
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
    const compound = s.op !== '=';

    // Fast path: scalar element of a scalar array. The address goes on the
    // stack first, so no temps are needed for a plain store.
    if (t.kind === 'Index' && t.indexKind === 'array' && !isStruct(type)) {
      const arr = t.sym;
      this.arrayOffset(t);
      if (compound) {
        const off = this.temp('int');
        this.emit('local.tee', off);
        this.emit('local.get', off);
        this.release(off);
        this.load(arr.elem, arr.addr);
        this.expr(s.value);
        // A user operator can take a scalar and a struct and return a scalar.
        if (s.opMethod) this.emit('call', s.opMethod.sym);
        else this.binopStack(s.op, type, s.value.type, s);
      } else {
        this.expr(s.value);
      }
      this.store(arr.elem, arr.addr);
      return;
    }

    // Everything else: variables, fields, struct elements.
    const p = this.place(t);
    if (compound) {
      this.loadPlace(p);
      this.expr(s.value);
      if (s.opMethod) this.emit('call', s.opMethod.sym);
      else this.binopStack(s.op, type, s.value.type, s);
    } else {
      this.expr(s.value);
    }
    this.storePlace(p);
    this.release(...p.temps);
  }

  zero(type) {
    if (type === 'float') this.emit('f64.const', 0);
    else if (isVector(type)) this.emit('v128.const', type, lanesOf(type, 0));
    else this.emit('i32.const', 0);
  }

  constant(type, v) {
    if (isStruct(type)) {
      type.leafTypes.forEach((t, i) => this.constant(t, v[i]));
      return;
    }
    if (type === 'float') this.emit('f64.const', v);
    else if (isVector(type)) this.emit('v128.const', type, v);
    else this.emit('i32.const', this.gen.leafValue(type, v));
  }

  /** Leaves the byte offset (index * element size) on the stack, after a bounds check. */
  arrayOffset(e) {
    const arr = e.sym;
    const size = sizeOf(arr.elem);
    const c = e.index.constValue;
    if (c !== undefined && c >= 0 && c < arr.size) {
      this.emit('i32.const', c * size);
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
    if ((size & (size - 1)) === 0) {
      this.emit('i32.const', Math.log2(size));
      this.emit('i32.shl');
    } else {
      this.emit('i32.const', size);
      this.emit('i32.mul');
    }
    this.release(idx);
  }

  // ---------------------------------------------------------- expressions

  expr(e) {
    if (e.constValue !== undefined && e.type !== 'void') return this.constant(e.type, e.constValue);
    switch (e.kind) {
      case 'Ident':
      case 'Field': {
        const p = this.place(e);
        if (p) {
          this.loadPlace(p);
          this.release(...p.temps);
          return;
        }
        if (e.lane !== undefined) {
          // lane of a temporary vector, e.g. (a + b).x
          this.expr(e.target);
          this.extractLane(e.target.type, e.lane);
          return;
        }
        // Field of a temporary (e.g. f().x): evaluate it all, keep the part we need.
        const v = this.materialize(e.target);
        const S = e.target.type;
        const start = S.fieldLeaf[e.fieldIndex];
        leafTypes(e.type).forEach((_, i) => this.emit('local.get', v.locals[start + i]));
        this.release(...v.temps);
        return;
      }
      case 'Unary':
        if (e.opMethod) {
          this.callExprs(e.opMethod.sym, [e.operand]);
          return;
        }
        if (isStruct(e.type)) {
          const v = this.materialize(e.operand);
          for (const [i, t] of e.type.leafTypes.entries()) this.negate(t, () => this.emit('local.get', v.locals[i]));
          this.release(...v.temps);
        } else if (isVector(e.type) && e.op !== '-') {
          this.expr(e.operand);
          this.emit('v128.not'); // '!' on a mask, '~' on an i32x4
        } else if (e.op === '-') {
          this.negate(e.type, () => this.expr(e.operand));
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
        if (e.opMethod) return this.userOperator(e);
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
        if (isStruct(e.left.type) || isStruct(e.right.type)) {
          const A = this.materialize(e.left, [e.right]);
          const B = this.materialize(e.right);
          if (e.op === '==' || e.op === '!=') this.structEquals(e.op, e.left.type, A, B);
          else this.componentwise(e.op, e.left.type, e.right.type, A, B, e);
          this.release(...A.temps, ...B.temps);
          return;
        }
        if (isVector(e.left.type) || isVector(e.right.type)) {
          const V = isVector(e.left.type) ? e.left.type : e.right.type;
          for (const side of ['left', 'right']) {
            if (e.splatSide === side) this.pushSplat(e[side], V);
            else this.expr(e[side]);
          }
          this.vecop(e.op, V, e);
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
        this.open('if', this.blockType(e.type));
        this.expr(e.then);
        this.emit('else');
        this.expr(e.else);
        this.close();
        return;
      case 'Call':
        return this.call(e);
      case 'MethodCall':
        return this.methodCall(e);
      case 'Index':
        if (e.indexKind === 'array') {
          if (isStruct(e.type)) {
            const p = this.place(e);
            this.loadPlace(p);
            this.release(...p.temps);
          } else {
            this.arrayOffset(e);
            this.load(e.sym.elem, e.sym.addr);
          }
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

  /** Can a call to `sym` be expanded in place? Small `return <expr>;` bodies only. */
  inlineable(sym) {
    if (!this.gen.inline || sym.selfMode === 'var' || !sym.paramSyms) return false;
    if (this.inlineStack.includes(sym) || this.inlineStack.length >= INLINE_MAX_DEPTH) return false;
    const body = sym.decl.body.body;
    if (body.length !== 1 || body[0].kind !== 'Return' || !body[0].value) return false;
    if (sym.inlineSize === undefined) sym.inlineSize = exprSize(body[0].value);
    return sym.inlineSize <= INLINE_MAX_NODES && this.inlinedNodes + sym.inlineSize <= INLINE_BUDGET;
  }

  /**
   * Call `sym` with arguments already held in locals (one materialize() result
   * per parameter): inline its body if possible, otherwise push and call.
   */
  callWith(sym, args) {
    if (this.inlineable(sym)) {
      const map = new Map();
      sym.paramSyms.forEach((p, i) => map.set(p, args[i].locals));
      const saved = this.inlineMap;
      this.inlineMap = map;
      this.inlineStack.push(sym);
      this.inlinedNodes += sym.inlineSize;
      this.comment(`inlined ${sym.name}`);
      // Inlined code keeps its own position, so a debugger steps into it.
      const ret = sym.decl.body.body[0];
      const outer = this.span;
      this.span = { origin: sym.origin, line: ret.span.line, col: ret.span.col };
      this.expr(ret.value);
      this.span = outer;
      this.inlineStack.pop();
      this.inlineMap = saved;
    } else {
      for (const a of args) for (const l of a.locals) this.emit('local.get', l);
      this.emit('call', sym);
    }
    for (const a of args) this.release(...a.temps);
  }

  /** Evaluate argument expressions left to right and call `sym`, inlining when worthwhile. */
  callExprs(sym, exprs) {
    if (!this.inlineable(sym)) {
      for (const a of exprs) this.expr(a);
      this.emit('call', sym);
      return;
    }
    this.callWith(sym, exprs.map((a, i) => this.materialize(a, exprs.slice(i + 1))));
  }

  /** A call to an operator defined in an impl, possibly derived (swapped and/or negated). */
  userOperator(e) {
    const { sym, swap, negate } = e.opMethod;
    if (!swap) {
      this.callExprs(sym, [e.left, e.right]);
    } else {
      // Evaluate left to right, then pass the operands the other way round.
      const A = this.materialize(e.left, [e.right]);
      const B = this.materialize(e.right);
      this.callWith(sym, [B, A]);
    }
    if (negate) this.emit('i32.eqz');
  }

  negate(type, push) {
    if (type === 'float') {
      push();
      this.emit('f64.neg');
    } else if (isVector(type)) {
      push();
      this.emit(`${shapeOf(type)}.neg`);
    } else {
      this.emit('i32.const', 0);
      push();
      this.emit('i32.sub');
    }
  }

  /** Component-wise arithmetic; A and B hold the operands' leaves (one leaf if scalar). */
  componentwise(op, lt, rt, A, B, node) {
    const S = isStruct(lt) ? lt : rt;
    const kind = numericKind(S);
    let splatted = null;
    if (isVector(kind) && !isStruct(lt) !== !isStruct(rt)) {
      // a lane scalar next to a struct of vectors: fill a vector with it once
      const [st, X] = isStruct(lt) ? [rt, B] : [lt, A];
      if (st !== kind) {
        splatted = this.temp(kind);
        this.emit('local.get', X.locals[0]);
        this.splat(kind);
        this.emit('local.set', splatted);
      }
    }
    for (let i = 0; i < S.leafTypes.length; i++) {
      this.emit('local.get', isStruct(lt) ? A.locals[i] : splatted ?? A.locals[0]);
      this.emit('local.get', isStruct(rt) ? B.locals[i] : splatted ?? B.locals[0]);
      if (isVector(kind)) this.vecop(op, kind, node);
      else this.binop(op, kind, node);
    }
    if (splatted !== null) this.release(splatted);
  }

  structEquals(op, S, A, B) {
    S.leafTypes.forEach((t, i) => {
      this.emit('local.get', A.locals[i]);
      this.emit('local.get', B.locals[i]);
      if (isVector(t)) {
        this.emit(`${shapeOf(t)}.eq`);
        this.emit(laneCount(t) === 2 ? 'i64x2.all_true' : 'i32x4.all_true');
      } else {
        this.emit(t === 'float' ? 'f64.eq' : 'i32.eq');
      }
      if (i > 0) this.emit('i32.and');
    });
    if (op === '!=') this.emit('i32.eqz');
  }

  /** Binary operator on two values already on the stack (used by compound assignment). */
  binopStack(op, lt, rt, node) {
    if (isVector(lt)) {
      if (!isVector(rt) && !SHIFTS.has(op)) this.splat(lt);
      return this.vecop(op, lt, node);
    }
    if (!isStruct(lt) && !isStruct(rt)) return this.binop(op, lt, node);
    const B = this.spill(rt);
    const A = this.spill(lt);
    this.componentwise(op, lt, rt, A, B, node);
    this.release(...A.temps, ...B.temps);
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
    if (isVector(to)) {
      if (isMask(to)) {
        // nonzero lanes are true
        this.emit('v128.const', from, lanesOf(from, 0));
        this.emit(`${shapeOf(from)}.ne`);
      } else if (to === 'f64x2') {
        // from boolx2: all ones & the bits of 1.0 is 1.0, all zeros gives 0.0
        this.emit('v128.const', 'f64x2', [1, 1]);
        this.emit('v128.and');
      } else {
        if (from === 'boolx4') this.emit('i32x4.neg'); // all ones -> 1
        if (to === 'f32x4') this.emit('f32x4.convert_i32x4_s');
        else if (from === 'f32x4') this.emit('i32x4.trunc_sat_f32x4_s');
      }
      return;
    }
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
    if (e.vecCtor) {
      const V = e.vecCtor;
      this.pushSplat(e.args[0], V);
      for (let i = 1; i < e.args.length; i++) {
        this.expr(e.args[i]);
        this.replaceLane(V, i);
      }
      return;
    }
    if (e.ctor) {
      // A struct value *is* its fields' leaves, in order: construction is free.
      for (const a of e.args) this.expr(a);
      return;
    }
    if (e.sym) {
      this.callExprs(e.sym, e.args);
      return;
    }
    switch (e.builtin) {
      case 'print': {
        // Evaluate every argument before printing anything: an argument may
        // call a function that prints, and the host builds one line at a time.
        const vals = e.args.map((a, i) => (a.constValue !== undefined && !isStruct(a.type) && !isVector(a.type) ? null : this.materialize(a, e.args.slice(i + 1))));
        e.args.forEach((a, i) => {
          if (i) this.printText(' ');
          if (vals[i]) this.printLeaves(a.type, vals[i].locals);
          else {
            this.expr(a);
            this.callImport(printImport(a.type));
          }
        });
        this.callImport('__print_end');
        for (const v of vals) if (v) this.release(...v.temps);
        return;
      }
      case 'select': {
        if (e.vecSelect) {
          // Lane by lane: (a & mask) | (b & ~mask). The mask is evaluated first.
          const m = this.materialize(e.args[0], e.args.slice(1));
          e.args.slice(1).forEach((a, i) => {
            if (e.splatArgs[i]) this.pushSplat(a, e.vecSelect);
            else this.expr(a);
          });
          this.emit('local.get', m.locals[0]);
          this.emit('v128.bitselect');
          this.release(...m.temps);
          return;
        }
        this.expr(e.args[1]);
        this.expr(e.args[2]);
        this.expr(e.args[0]);
        this.emit('select');
        return;
      }
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

  methodCall(e) {
    const m = e.method;
    if (e.isStatic) {
      this.callExprs(m, e.args);
      return;
    }
    if (m.selfMode !== 'var') {
      this.callExprs(m, [e.receiver, ...e.args]);
      return;
    }
    // var self: copy the receiver in, call, and store the updated copy back.
    // The method returns [result..., self...]; storing pops self and leaves
    // the result on the stack.
    const p = this.place(e.receiver);
    this.loadPlace(p);
    for (const a of e.args) this.expr(a);
    this.emit('call', m);
    this.storePlace(p);
    this.release(...p.temps);
  }

  printText(s) {
    this.emit('i32.const', this.gen.intern(s));
    this.callImport('__print_s');
  }

  printLeaves(type, locals) {
    if (isStruct(type)) {
      this.printStruct(type, locals, 0);
    } else if (isVector(type)) {
      this.printVector(type, locals[0]);
    } else {
      this.emit('local.get', locals[0]);
      this.callImport(`__print_${type[0]}`);
    }
  }

  /** Prints like the constructor call that would make it: Vec3(1.0, 2.0, 3.0) */
  printStruct(S, locals, start) {
    this.printText(`${S.name}(`);
    let k = start;
    S.fields.forEach((f, i) => {
      if (i) this.printText(', ');
      if (isStruct(f.type)) {
        this.printStruct(f.type, locals, k);
        k += f.type.leafTypes.length;
      } else if (isVector(f.type)) {
        this.printVector(f.type, locals[k++]);
      } else {
        this.emit('local.get', locals[k++]);
        this.callImport(`__print_${f.type[0]}`);
      }
    });
    this.printText(')');
  }

  /** Prints like the constructor: f32x4(1.0, 2.5, 3.0, 4.0) */
  printVector(V, local) {
    this.printText(`${V}(`);
    for (let i = 0; i < laneCount(V); i++) {
      if (i) this.printText(', ');
      this.emit('local.get', local);
      this.extractLane(V, i);
      this.callImport(printImport(V));
    }
    this.printText(')');
  }

  /** Lane-wise intrinsics; a scalar argument fills every lane. */
  vectorIntrinsic(e) {
    const name = e.callee;
    const [params, V] = e.overload;
    if (name === 'any' || name === 'all') {
      this.expr(e.args[0]);
      if (name === 'any') this.emit('v128.any_true');
      else this.emit(params[0] === 'boolx2' ? 'i64x2.all_true' : 'i32x4.all_true');
      return;
    }
    if (name === 'to_bits' || name === 'from_bits') {
      // A v128 is just 128 bits: reading them as the other lane type is free.
      this.expr(e.args[0]);
      this.comment(`${name}: the same 128 bits, now read as ${V}`);
      return;
    }
    const shape = shapeOf(V);
    const isInt = V === 'i32x4';
    const arg = (i) => {
      if (!isVector(params[i])) this.pushSplat(e.args[i], V);
      else this.expr(e.args[i]);
    };
    const unary = { sqrt: 'sqrt', floor: 'floor', ceil: 'ceil', trunc: 'trunc', round: 'nearest' };
    const min = isInt ? 'i32x4.min_s' : `${shape}.min`;
    const max = isInt ? 'i32x4.max_s' : `${shape}.max`;
    arg(0);
    if (name in unary) this.emit(`${shape}.${unary[name]}`);
    else if (name === 'abs') this.emit(`${shape}.abs`);
    else if (name === 'min' || name === 'max') {
      arg(1);
      this.emit(name === 'min' ? min : max);
    } else if (name === 'clamp') {
      arg(1);
      this.emit(max);
      arg(2);
      this.emit(min);
    } else throw new Error(`codegen: unknown vector intrinsic ${name}`);
  }

  intrinsic(e) {
    const name = e.callee;
    if (isVector(e.overload[0][0])) return this.vectorIntrinsic(e);
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
