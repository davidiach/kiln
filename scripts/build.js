// Build the playground into a single self-contained HTML file: dist/index.html.
//
// Includes a deliberately tiny bundler for this repo's own ES modules: it
// resolves relative `import { a, b } from './x.js'` statements, wraps each
// module in a function scope, and wires exports through plain objects.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const at = (...p) => resolve(root, ...p);

const EXAMPLES = [
  ['hello', 'Hello, Kiln'],
  ['plasma', 'Plasma'],
  ['landscape', 'Voxel landscape'],
  ['raymarch', 'Ray marcher'],
  ['mandelbrot', 'Mandelbrot zoom (f64x2)'],
  ['julia', 'Julia set (f32x4 SIMD)'],
  ['fire', 'Fire'],
  ['life', 'Game of Life'],
  ['particles', 'Particle fountain'],
  ['sequencer', 'Step sequencer (sound)'],
  ['synth', 'Synthesizer (audio(t))'],
  ['dodge', 'Stardust (a game, with sound)'],
];

const IMPORT = /^import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"];?[ \t]*$/gm;

export function bundle(entry) {
  const ids = new Map();
  const order = [];
  const visit = (file, from) => {
    if (ids.has(file)) {
      if (ids.get(file) === null) throw new Error(`circular import: ${relative(root, from)} -> ${relative(root, file)}`);
      return;
    }
    ids.set(file, null);
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(IMPORT)) {
      if (!m[2].startsWith('.')) throw new Error(`${relative(root, file)}: only relative imports can be bundled (${m[2]})`);
      visit(resolve(dirname(file), m[2]), file);
    }
    ids.set(file, `__mod${order.length}`);
    order.push({ file, src });
  };
  visit(at(entry));

  let out = '';
  for (const { file, src } of order) {
    const exports = [];
    let code = src.replace(IMPORT, (_, names, spec) => `const {${names.replace(/\s+as\s+/g, ': ')}} = ${ids.get(resolve(dirname(file), spec))};`);
    code = code.replace(/^export\s+(async\s+function\*?|function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm, (_, kw, name) => {
      exports.push(name);
      return `${kw} ${name}`;
    });
    code = code.replace(/^export\s*\{([^}]*)\};?[ \t]*$/gm, (_, names) => {
      for (const n of names.split(',').map((s) => s.trim()).filter(Boolean)) {
        const [a, b] = n.split(/\s+as\s+/);
        exports.push(b ? `${b}: ${a}` : a);
      }
      return '';
    });
    if (/^(import|export)[\s{*]/m.test(code)) throw new Error(`${relative(root, file)}: unsupported import/export form`);
    out += `// ---- ${relative(root, file)}\nconst ${ids.get(file)} = (() => {\n${code}\nreturn { ${exports.join(', ')} };\n})();\n`;
  }
  return `(() => {\n'use strict';\n${out}})();\n`;
}

/** JSON that is safe to embed inside an inline <script>. */
const scriptJSON = (v) => JSON.stringify(v).replace(/<\//g, '<\\/').replace(/<!--/g, '<\\!--');

function checkInline(name, js) {
  if (/<\/script|<!--/i.test(js)) throw new Error(`${name} contains a sequence that would break an inline <script>`);
  return js;
}

export function build() {
  const examples = EXAMPLES.map(([id, title]) => ({ id, title, code: readFileSync(at('examples', `${id}.kiln`), 'utf8') }));
  const worker = bundle('web/worker.js');
  const app = checkInline('app bundle', bundle('web/app.js'));
  const css = readFileSync(at('web/style.css'), 'utf8');
  const data = `window.KILN_EXAMPLES = ${scriptJSON(examples)};\nwindow.KILN_WORKER = ${scriptJSON(worker)};`;
  const html = readFileSync(at('web/index.html'), 'utf8')
    .split('/*__CSS__*/').join(css)
    .split('//__DATA__').join(data)
    .split('//__APP__').join(app);
  mkdirSync(at('dist'), { recursive: true });
  writeFileSync(at('dist/index.html'), html);
  return { bytes: html.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { bytes } = build();
  console.log(`wrote dist/index.html (${(bytes / 1024).toFixed(1)} KB)`);
}
