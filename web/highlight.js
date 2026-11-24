// Syntax highlighting for Kiln source and WAT listings, producing HTML.

const KEYWORDS = new Set(['fn', 'let', 'var', 'const', 'if', 'else', 'while', 'for', 'in', 'break', 'continue', 'return', 'true', 'false', 'as', 'export']);
const TYPES = new Set(['int', 'float', 'bool', 'str']);

const TOKEN = /(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|("(?:[^"\\\n]|\\.)*"?)|(0[xX][0-9a-fA-F_]*|0[bB][01_]*|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)|([A-Za-z_]\w*)|(\s+)|([\s\S])/g;

export const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Split Kiln source into [start, end, className] runs. */
function kilnTokens(src) {
  const out = [];
  TOKEN.lastIndex = 0;
  let m;
  while ((m = TOKEN.exec(src))) {
    const [text, comment, string, number, ident, space] = m;
    let cls = '';
    if (comment) cls = 'c';
    else if (string) cls = 's';
    else if (number) cls = 'n';
    else if (ident) {
      if (KEYWORDS.has(ident)) cls = 'k';
      else if (TYPES.has(ident)) cls = 't';
      else if (/^[A-Z][A-Z0-9_]+$/.test(ident)) cls = 'u';
      else if (src[TOKEN.lastIndex] === '(') cls = 'f';
    } else if (space) cls = '';
    else cls = 'p';
    out.push([m.index, m.index + text.length, cls]);
  }
  return out;
}

/**
 * Highlight Kiln source. `marks` are [start, end) ranges (compile errors)
 * that get an extra "err" class for a wavy underline.
 */
export function highlightKiln(src, marks = []) {
  const bounds = new Set();
  for (const [a, b] of marks) {
    bounds.add(a);
    bounds.add(b);
  }
  const inMark = (pos) => marks.some(([a, b]) => pos >= a && pos < b);
  let html = '';
  for (const [start, end, cls] of kilnTokens(src)) {
    // split the token wherever an error range begins or ends inside it
    let cuts = [start];
    for (const b of bounds) if (b > start && b < end) cuts.push(b);
    cuts.push(end);
    cuts = [...new Set(cuts)].sort((x, y) => x - y);
    for (let i = 0; i < cuts.length - 1; i++) {
      const a = cuts[i];
      const piece = escapeHtml(src.slice(a, cuts[i + 1]));
      const classes = [cls, inMark(a) ? 'err' : ''].filter(Boolean).join(' ');
      html += classes ? `<span class="${classes}">${piece}</span>` : piece;
    }
  }
  // An error at the very end (e.g. a missing '}') still needs something to underline.
  if (marks.some(([a]) => a >= src.length)) html += '<span class="err"> </span>';
  return html;
}

const WAT_TOKEN = /(\$[\w.]+)|("(?:[^"\\]|\\.)*")|\b((?:i32|f64)\.[a-z_0-9]+|local\.\w+|global\.\w+|call|block|loop|if|else|end|br_if|br|return|drop|select|unreachable)\b|\b(module|func|param|result|local|import|export|memory|global|mut|data|type|offset)\b|(-?\b\d[\w.+-]*|\bnan\b|\binf\b)/g;

/** Highlight a WAT listing line by line. */
export function highlightWat(wat) {
  return wat
    .split('\n')
    .map((line) => {
      const i = line.indexOf(';;');
      const code = i >= 0 ? line.slice(0, i) : line;
      let html = '';
      let last = 0;
      WAT_TOKEN.lastIndex = 0;
      let m;
      while ((m = WAT_TOKEN.exec(code))) {
        html += escapeHtml(code.slice(last, m.index));
        const cls = m[1] ? 'f' : m[2] ? 's' : m[3] ? 't' : m[4] ? 'k' : 'n';
        html += `<span class="${cls}">${escapeHtml(m[0])}</span>`;
        last = m.index + m[0].length;
      }
      html += escapeHtml(code.slice(last));
      if (i >= 0) html += `<span class="c">${escapeHtml(line.slice(i))}</span>`;
      return html;
    })
    .join('\n');
}
