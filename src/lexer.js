// Lexer: source text -> array of tokens.
//
// Token kinds: 'int' | 'float' | 'string' | 'ident' | 'keyword' | 'punct' | 'eof'
// Every token records its span (start/end offsets, 1-based line and column).

import { CompileError } from './errors.js';

export const KEYWORDS = new Set([
  'fn', 'let', 'var', 'const', 'if', 'else', 'while', 'for', 'in',
  'break', 'continue', 'return', 'true', 'false', 'as', 'export', 'struct',
]);

// Longest first, so that '>>>=' wins over '>>>' wins over '>>' wins over '>'.
const PUNCT = [
  '>>>=', '>>>', '<<=', '>>=', '..=',
  '..', '->', '&&', '||', '==', '!=', '<=', '>=', '<<', '>>',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=',
  '+', '-', '*', '/', '%', '&', '|', '^', '~', '!', '<', '>', '=',
  '(', ')', '{', '}', '[', ']', ',', ':', ';', '?', '.',
];

const isDigit = (c) => c >= '0' && c <= '9';
const isHex = (c) => isDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
const isIdentStart = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
const isIdent = (c) => isIdentStart(c) || isDigit(c);

const ESCAPES = { n: '\n', t: '\t', r: '\r', '0': '\0', '\\': '\\', '"': '"', "'": "'" };

export function lex(src) {
  const tokens = [];
  const n = src.length;
  let i = 0;
  let line = 1;
  let lineStart = 0;

  let tokStart = 0;
  let tokLine = 1;
  let tokCol = 1;
  const span = () => ({ start: tokStart, end: i, line: tokLine, col: tokCol });
  const fail = (msg, hint) => {
    throw new CompileError(msg, span(), hint);
  };
  const push = (kind, text, value) => tokens.push({ kind, text, value, ...span() });

  for (;;) {
    // Skip whitespace and comments.
    while (i < n) {
      const c = src[i];
      if (c === '\n') {
        i++;
        line++;
        lineStart = i;
      } else if (c === ' ' || c === '\t' || c === '\r') {
        i++;
      } else if (c === '/' && src[i + 1] === '/') {
        while (i < n && src[i] !== '\n') i++;
      } else if (c === '/' && src[i + 1] === '*') {
        tokStart = i;
        tokLine = line;
        tokCol = i - lineStart + 1;
        i += 2;
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
          if (src[i] === '\n') {
            line++;
            lineStart = i + 1;
          }
          i++;
        }
        if (i >= n) fail('unterminated block comment');
        i += 2;
      } else {
        break;
      }
    }

    tokStart = i;
    tokLine = line;
    tokCol = i - lineStart + 1;

    if (i >= n) {
      push('eof', '', null);
      return tokens;
    }

    const c = src[i];

    if (isDigit(c)) {
      let isFloat = false;
      let digits;
      if (c === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
        i += 2;
        const s = i;
        while (i < n && (isHex(src[i]) || src[i] === '_')) i++;
        digits = '0x' + src.slice(s, i).replaceAll('_', '');
        if (digits === '0x') fail('expected hex digits after 0x');
      } else if (c === '0' && (src[i + 1] === 'b' || src[i + 1] === 'B')) {
        i += 2;
        const s = i;
        while (i < n && (src[i] === '0' || src[i] === '1' || src[i] === '_')) i++;
        digits = '0b' + src.slice(s, i).replaceAll('_', '');
        if (digits === '0b') fail('expected binary digits after 0b');
      } else {
        while (i < n && (isDigit(src[i]) || src[i] === '_')) i++;
        // "1.5" is a float, but "0..10" is a range: only take '.' if a digit follows.
        if (src[i] === '.' && isDigit(src[i + 1] ?? '')) {
          isFloat = true;
          i++;
          while (i < n && (isDigit(src[i]) || src[i] === '_')) i++;
        }
        if (src[i] === 'e' || src[i] === 'E') {
          const save = i;
          i++;
          if (src[i] === '+' || src[i] === '-') i++;
          if (isDigit(src[i] ?? '')) {
            isFloat = true;
            while (i < n && isDigit(src[i])) i++;
          } else {
            i = save;
          }
        }
        digits = src.slice(tokStart, i).replaceAll('_', '');
      }
      if (i < n && isIdent(src[i])) {
        while (i < n && isIdent(src[i])) i++;
        fail(`invalid number literal '${src.slice(tokStart, i)}'`);
      }
      const text = src.slice(tokStart, i);
      if (isFloat) {
        push('float', text, Number(digits));
      } else {
        const raw = Number(digits);
        if (raw > 0xffffffff) fail(`integer literal '${text}' does not fit in 32 bits`);
        // Literals up to 0xFFFFFFFF are allowed and wrap to signed i32.
        tokens.push({ kind: 'int', text, value: raw | 0, raw, ...span() });
      }
      continue;
    }

    if (isIdentStart(c)) {
      while (i < n && isIdent(src[i])) i++;
      const text = src.slice(tokStart, i);
      push(KEYWORDS.has(text) ? 'keyword' : 'ident', text, text);
      continue;
    }

    if (c === '"') {
      i++;
      let value = '';
      for (;;) {
        if (i >= n || src[i] === '\n') fail('unterminated string literal', 'strings must end with " on the same line');
        const ch = src[i];
        if (ch === '"') {
          i++;
          break;
        }
        if (ch === '\\') {
          const esc = src[i + 1];
          if (!(esc in ESCAPES)) {
            i += 2;
            fail(`unknown escape sequence '\\${esc ?? ''}'`, 'supported escapes: \\n \\t \\r \\0 \\\\ \\"');
          }
          value += ESCAPES[esc];
          i += 2;
        } else {
          value += ch;
          i++;
        }
      }
      push('string', src.slice(tokStart, i), value);
      continue;
    }

    let matched = null;
    for (const p of PUNCT) {
      if (src.startsWith(p, i)) {
        matched = p;
        break;
      }
    }
    if (matched) {
      i += matched.length;
      push('punct', matched, matched);
      continue;
    }

    i++;
    if (c === "'") fail("unexpected character '''", 'string literals use double quotes: "like this"');
    fail(`unexpected character '${c}'`);
  }
}
