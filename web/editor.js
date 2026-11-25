// A small code editor: a transparent <textarea> on top of a highlighted
// <pre>, with line numbers, auto-indent and error underlines.

import { highlightKiln } from './highlight.js';

export function createEditor(root, { onChange, onRun }) {
  root.classList.add('editor');
  root.innerHTML = `
    <div class="gutter" aria-hidden="true"><div class="gutter-inner"></div></div>
    <div class="code">
      <pre class="hl" aria-hidden="true"><code></code></pre>
      <textarea spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off" wrap="off" aria-label="Kiln source code"></textarea>
    </div>`;
  const ta = root.querySelector('textarea');
  const pre = root.querySelector('pre');
  const code = pre.querySelector('code');
  const gutter = root.querySelector('.gutter-inner');
  let marks = [];
  let errorLines = new Set();
  let lineCount = 0;

  function render() {
    code.innerHTML = highlightKiln(ta.value, marks) + '\n';
    const n = ta.value.split('\n').length;
    if (n !== lineCount || errorLines.size || gutter.querySelector('.bad')) {
      lineCount = n;
      let html = '';
      for (let i = 1; i <= n; i++) html += `<div${errorLines.has(i) ? ' class="bad"' : ''}>${i}</div>`;
      gutter.innerHTML = html;
    }
    sync();
  }

  function sync() {
    pre.scrollTop = ta.scrollTop;
    pre.scrollLeft = ta.scrollLeft;
    gutter.style.transform = `translateY(${-ta.scrollTop}px)`;
  }

  function insert(text) {
    // execCommand keeps the browser's undo stack intact; fall back if unsupported.
    if (!document.execCommand?.('insertText', false, text)) {
      ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
      ta.dispatchEvent(new Event('input'));
    }
  }

  function lineStartOf(pos) {
    return ta.value.lastIndexOf('\n', pos - 1) + 1;
  }

  function selectLines() {
    const s = lineStartOf(ta.selectionStart);
    let e = ta.value.indexOf('\n', ta.selectionEnd - (ta.selectionEnd > ta.selectionStart && ta.value[ta.selectionEnd - 1] === '\n' ? 1 : 0));
    if (e < 0) e = ta.value.length;
    ta.setSelectionRange(s, e);
    return ta.value.slice(s, e).split('\n');
  }

  function replaceLines(lines) {
    const s = ta.selectionStart;
    insert(lines.join('\n'));
    ta.setSelectionRange(s, s + lines.join('\n').length);
  }

  ta.addEventListener('input', () => {
    render();
    onChange?.(ta.value);
  });
  ta.addEventListener('scroll', sync);

  ta.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key === 'Enter') {
      e.preventDefault();
      onRun?.();
      return;
    }
    if (mod && e.key === '/') {
      e.preventDefault();
      const lines = selectLines();
      const allCommented = lines.every((l) => !l.trim() || /^\s*\/\//.test(l));
      replaceLines(lines.map((l) => (!l.trim() ? l : allCommented ? l.replace(/^(\s*)\/\/ ?/, '$1') : l.replace(/^(\s*)/, '$1// '))));
      return;
    }
    if (e.key === 'Tab' && !mod && !e.altKey) {
      e.preventDefault();
      const multi = ta.value.slice(ta.selectionStart, ta.selectionEnd).includes('\n');
      if (e.shiftKey || multi) {
        const lines = selectLines();
        replaceLines(lines.map((l) => (e.shiftKey ? l.replace(/^ {1,2}/, '') : '  ' + l)));
      } else {
        insert('  ');
      }
      return;
    }
    if (e.key === 'Enter' && !mod && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      const before = ta.value.slice(lineStartOf(ta.selectionStart), ta.selectionStart);
      let indent = /^\s*/.exec(before)[0];
      if (/[{(\[]\s*$/.test(before)) indent += '  ';
      insert('\n' + indent);
      return;
    }
    if (e.key === '}' && !mod) {
      const s = lineStartOf(ta.selectionStart);
      const before = ta.value.slice(s, ta.selectionStart);
      if (before.length >= 2 && /^\s+$/.test(before) && ta.selectionStart === ta.selectionEnd) {
        e.preventDefault();
        ta.setSelectionRange(ta.selectionStart - 2, ta.selectionStart);
        insert('}');
      }
    }
  });

  return {
    get value() {
      return ta.value;
    },
    setValue(v) {
      ta.value = v;
      ta.scrollTop = 0;
      marks = [];
      errorLines = new Set();
      render();
    },
    /** errors: [{ start, end, line }] */
    setErrors(errors) {
      marks = errors.map((e) => [e.start, Math.max(e.end, e.start + 1)]);
      errorLines = new Set(errors.map((e) => e.line));
      render();
    },
    goTo(line, col = 1) {
      const lines = ta.value.split('\n');
      let pos = 0;
      for (let i = 0; i < line - 1 && i < lines.length; i++) pos += lines[i].length + 1;
      pos += col - 1;
      ta.focus();
      ta.setSelectionRange(pos, pos);
      const lh = parseFloat(getComputedStyle(ta).lineHeight) || 20;
      ta.scrollTop = Math.max(0, (line - 4) * lh);
      sync();
    },
    focus() {
      ta.focus();
    },
  };
}
