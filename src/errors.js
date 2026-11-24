// Compile errors carry a source span so the CLI and the playground can point at
// the exact characters that caused them.

export class CompileError extends Error {
  /**
   * @param {string} message
   * @param {{line:number,col:number,start:number,end:number}} span
   * @param {string} [hint]
   */
  constructor(message, span, hint) {
    super(message);
    this.name = 'CompileError';
    this.span = span;
    this.hint = hint;
  }
}

/** Render an error rustc-style, with the offending line and a caret underline. */
export function formatError(err, source, file = 'input.kiln') {
  if (!err.span) return `error: ${err.message}`;
  const { line, col, start, end } = err.span;
  const text = source.split('\n')[line - 1] ?? '';
  const width = Math.max(1, Math.min(end - start, text.length - col + 1));
  const gutter = String(line).length;
  const pad = ' '.repeat(gutter);
  let out = `error: ${err.message}\n${pad}--> ${file}:${line}:${col}\n${pad} |\n`;
  out += `${line} | ${text}\n${pad} | ${' '.repeat(col - 1)}${'^'.repeat(width)}`;
  if (err.hint) out += `\n${pad} = help: ${err.hint}`;
  return out;
}

/** Levenshtein distance, used for "did you mean ...?" suggestions. */
export function editDistance(a, b) {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

export function suggest(name, candidates) {
  let best = null;
  let bestDist = Infinity;
  for (const c of candidates) {
    if (c.startsWith('__')) continue;
    // Prefer candidates that start with the same letter when distances tie.
    let d = editDistance(name, c) + (c[0] === name[0] ? 0 : 0.5);
    // "string" -> "str", "printf" -> "print": a prefix match is a strong hint.
    const shorter = Math.min(name.length, c.length);
    if (shorter >= 3 && (c.startsWith(name) || name.startsWith(c))) d = Math.min(d, 1);
    if (d < bestDist) {
      best = c;
      bestDist = d;
    }
  }
  const limit = name.length <= 3 ? 1 : name.length <= 6 ? 2 : 3;
  return bestDist <= limit ? best : null;
}
