// The Kiln playground: editor + live compiler + runner + inspector tabs.

import { compile } from '../src/compiler.js';
import { createEditor } from './editor.js';
import { Runner } from './runner.js';
import { AudioEngine } from './audio.js';
import { highlightWat, escapeHtml } from './highlight.js';

const $ = (s) => document.querySelector(s);
const EXAMPLES = window.KILN_EXAMPLES ?? [];
const MAX_CONSOLE_LINES = 600;

const store = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
  del(k) {
    try {
      localStorage.removeItem(k);
    } catch {}
  },
};

let current = null; // { id, title, code }
let lastResult = null;
let lastGood = null;
let compileTimer = 0;
let activeTab = 'console';
let rendered = { wat: null, bytes: null };
let runtimeError = null;

const editor = createEditor($('#editor'), { onChange: onEdit, onRun: () => run(true) });
const audio = new AudioEngine({ muted: store.get('kiln.muted') === '1', onChange: showSound });
const runner = new Runner({
  audio,
  canvas: $('#screen'),
  width: 320,
  height: 240,
  workerSource: window.KILN_WORKER ?? null,
  onPrint: printLines,
  onError: showRuntimeError,
  onState: showState,
});

// ------------------------------------------------------------- examples

$('#example').innerHTML = EXAMPLES.map((e) => `<option value="${e.id}">${escapeHtml(e.title)}</option>`).join('');
$('#example').addEventListener('change', () => {
  const id = $('#example').value;
  loadExample(id);
  try {
    history.replaceState(null, '', '#' + id);
  } catch {}
});

function loadExample(id) {
  const ex = EXAMPLES.find((e) => e.id === id) ?? EXAMPLES[0];
  current = ex;
  $('#example').value = ex.id;
  $('#filename').textContent = `${ex.id}.kiln`;
  editor.setValue(store.get(`kiln.draft.${ex.id}`) ?? ex.code);
  updateRevert();
  run(true);
}

function loadCode(code, name) {
  current = { id: 'shared', title: name, code };
  $('#example').value = '';
  $('#filename').textContent = 'shared.kiln';
  editor.setValue(code);
  updateRevert();
  run(true);
}

function updateRevert() {
  $('#revert').hidden = !current || current.id === 'shared' || editor.value === current.code;
}

$('#revert').addEventListener('click', () => {
  store.del(`kiln.draft.${current.id}`);
  editor.setValue(current.code);
  updateRevert();
  run(true);
});

// ------------------------------------------------------------- compiling

function onEdit(value) {
  if (current && current.id !== 'shared') {
    if (value === current.code) store.del(`kiln.draft.${current.id}`);
    else store.set(`kiln.draft.${current.id}`, value);
  }
  updateRevert();
  clearTimeout(compileTimer);
  compileTimer = setTimeout(() => {
    const r = doCompile();
    if (r.ok && $('#live').checked) start(r, false);
  }, 250);
}

function doCompile() {
  const src = editor.value;
  let r;
  try {
    r = compile(src);
  } catch (e) {
    r = { ok: false, errors: [{ message: `internal compiler error: ${e.message}`, span: { line: 1, col: 1, start: 0, end: 0 } }] };
    console.error(e);
  }
  lastResult = r;
  runtimeError = null;
  if (r.ok) {
    lastGood = r;
    editor.setErrors([]);
    showProblems([]);
    const s = r.stats;
    $('#stats').textContent = `${formatBytes(s.bytes)} of wasm · ${s.functions} function${s.functions === 1 ? '' : 's'} (${s.stripped} unused stripped) · compiled in ${r.time.toFixed(1)} ms`;
    refreshTab();
  } else {
    editor.setErrors(r.errors.map((e) => ({ start: e.span.start, end: e.span.end, line: e.span.line })));
    showProblems(r.errors);
    $('#stats').textContent = `${r.errors.length} error${r.errors.length === 1 ? '' : 's'}`;
  }
  return r;
}

function run(resetTime) {
  clearTimeout(compileTimer);
  const r = doCompile();
  if (r.ok) {
    start(r, resetTime);
  } else {
    runner.stop();
    const e = r.errors[0];
    editor.goTo(e.span.line, e.span.col);
  }
}

function start(r, resetTime) {
  clearConsole();
  runner.start(r, { resetTime });
}

function showProblems(errors) {
  const box = $('#problems');
  if (!errors.length) {
    box.innerHTML = '';
    return;
  }
  let html = errors
    .slice(0, 20)
    .map(
      (e, i) =>
        `<button class="problem" data-i="${i}"><b>${e.span.line}:${e.span.col}</b>${escapeHtml(e.message)}${e.hint ? `<i>help: ${escapeHtml(e.hint)}</i>` : ''}</button>`,
    )
    .join('');
  if (runner.state === 'running') html += `<div class="problem note">Still running the last version that compiled.</div>`;
  box.innerHTML = html;
  box.querySelectorAll('button.problem').forEach((b) => {
    const e = errors[+b.dataset.i];
    b.addEventListener('click', () => editor.goTo(e.span.line, e.span.col));
  });
}

// ------------------------------------------------------------- running

function showState({ state, fps }) {
  const el = $('#runstate');
  el.className = 'runstate ' + state;
  const labels = {
    idle: 'idle',
    starting: 'starting',
    busy: 'running main()…',
    running: `running · ${fps ?? '–'} fps`,
    done: 'finished',
    stopped: 'stopped',
    error: 'runtime error',
  };
  el.textContent = labels[state] ?? state;
}

function clearConsole() {
  $('#tab-console').innerHTML = '';
}

function printLines(lines, dropped) {
  const box = $('#tab-console');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  const frag = document.createDocumentFragment();
  if (dropped) frag.append(line(`… ${dropped} more lines not shown`, 'sys'));
  for (const l of lines) frag.append(line(l));
  box.append(frag);
  while (box.childElementCount > MAX_CONSOLE_LINES) box.firstElementChild.remove();
  if (nearBottom) box.scrollTop = box.scrollHeight;
}

function line(text, cls) {
  const div = document.createElement('div');
  div.className = 'line' + (cls ? ' ' + cls : '');
  div.textContent = text;
  return div;
}

function showRuntimeError(err) {
  runtimeError = err;
  const div = line('', 'bad');
  div.append(`runtime error: ${err.message}`);
  if (err.line) {
    const b = document.createElement('button');
    b.textContent = `go to line ${err.line}`;
    b.addEventListener('click', () => editor.goTo(err.line));
    div.append(' ', b);
    // underline the offending line
    const src = editor.value;
    let start = 0;
    for (let i = 1; i < err.line; i++) start = src.indexOf('\n', start) + 1;
    let end = src.indexOf('\n', start);
    if (end < 0) end = src.length;
    const indent = /^\s*/.exec(src.slice(start, end))[0].length;
    editor.setErrors([{ start: start + indent, end, line: err.line }]);
  }
  $('#tab-console').append(div);
  selectTab('console');
  $('#tab-console').scrollTop = $('#tab-console').scrollHeight;
}

$('#run').addEventListener('click', () => run(true));
$('#stop').addEventListener('click', () => runner.stop());
$('#fullscreen').addEventListener('click', () => {
  $('.screen-wrap')
    .requestFullscreen?.()
    ?.then(() => $('#screen').focus())
    .catch(() => {});
});
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    run(true);
  }
});

// ------------------------------------------------------------- sound

const SPEAKER = '<path class="body" d="M2 6h2.5L8 3v10L4.5 10H2z"/>';
const WAVES_ICON = '<path class="wave" d="M10.5 6a2.5 2.5 0 0 1 0 4M12.5 4a5.3 5.3 0 0 1 0 8"/>';
const MUTED_ICON = '<path class="wave" d="M10.5 6l4 4M14.5 6l-4 4"/>';

function showSound() {
  const b = $('#sound');
  const state = audio.state;
  const icon = state === 'on' ? WAVES_ICON : MUTED_ICON;
  const label = state === 'on' ? 'Sound on' : state === 'muted' ? 'Sound off' : 'Enable sound';
  b.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${SPEAKER}${icon}</svg>${label}`;
  b.dataset.state = state;
  b.dataset.wanted = String(state === 'locked' && audio.wanted);
  b.setAttribute('aria-pressed', String(state === 'on'));
  b.title = state === 'locked' ? 'Browsers only play sound after you interact with the page' : state === 'on' ? 'Mute' : 'Unmute';
}

// Any click or key press on the page counts as permission to play sound.
// Remember whether audio was still locked when the gesture began, so the
// first click on the sound button enables sound instead of muting it.
let lockedAtGesture = true;
for (const type of ['pointerdown', 'keydown']) {
  window.addEventListener(
    type,
    () => {
      lockedAtGesture = audio.state === 'locked';
      audio.unlock();
    },
    { capture: true },
  );
}
$('#sound').addEventListener('click', () => {
  audio.setMuted(lockedAtGesture ? false : !audio.muted);
  store.set('kiln.muted', audio.muted ? '1' : '0');
});
showSound();
window.__kiln = { audio, runner };

// ------------------------------------------------------------- tabs

document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.tab)));

function selectTab(name) {
  activeTab = name;
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.querySelectorAll('.tab').forEach((t) => (t.hidden = t.id !== `tab-${name}`));
  refreshTab();
}

function refreshTab() {
  if (!lastGood) return;
  if (activeTab === 'wat' && rendered.wat !== lastGood) {
    rendered.wat = lastGood;
    $('#tab-wat pre').innerHTML = highlightWat(lastGood.wat);
  }
  if (activeTab === 'bytes' && rendered.bytes !== lastGood) {
    rendered.bytes = lastGood;
    renderBytes(lastGood);
  }
}

function renderBytes(r) {
  const bytes = r.binary;
  const owner = new Int16Array(bytes.length);
  r.sections.forEach((s, i) => owner.fill(i, s.start, s.end));
  $('#tab-bytes .legend').innerHTML = r.sections
    .map((s, i) => `<button data-off="${s.start}"><i class="sec${i % 11}"></i>${escapeHtml(s.name)} <small>${s.end - s.start} B</small></button>`)
    .join('');
  const hex = (b) => b.toString(16).padStart(2, '0');
  const rows = [];
  for (let off = 0; off < bytes.length; off += 16) {
    let cells = '';
    let ascii = '';
    let open = -1;
    for (let i = off; i < off + 16; i++) {
      if (i >= bytes.length) {
        cells += '   ';
        continue;
      }
      if (owner[i] !== open) {
        if (open >= 0) cells += '</span>';
        open = owner[i];
        cells += `<span class="sec${open % 11}">`;
      }
      cells += hex(bytes[i]) + ' ';
      const b = bytes[i];
      ascii += b >= 0x20 && b < 0x7f ? escapeHtml(String.fromCharCode(b)) : '·';
    }
    if (open >= 0) cells += '</span>';
    rows.push(`<span class="off">${off.toString(16).padStart(6, '0')}</span>  ${cells} <span class="asc">${ascii}</span>`);
  }
  const pre = $('#tab-bytes .hex');
  pre.innerHTML = rows.join('\n');
  $('#tab-bytes .legend').querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => {
      const row = Math.floor(+b.dataset.off / 16);
      const lh = parseFloat(getComputedStyle(pre).lineHeight) || 19;
      $('#tab-bytes').scrollTop = pre.offsetTop + row * lh - 8;
    }),
  );
}

function formatBytes(n) {
  return n < 1024 ? `${n} bytes` : `${(n / 1024).toFixed(1)} KB`;
}

// ------------------------------------------------------------- sharing

let inFrame = true;
try {
  inFrame = window.self !== window.top;
} catch {}
if (inFrame) $('#share').hidden = true;

$('#share').addEventListener('click', async () => {
  const data = await encode(editor.value);
  const url = location.href.split('#')[0] + '#s=' + data;
  try {
    history.replaceState(null, '', url);
  } catch {}
  const btn = $('#share');
  try {
    await navigator.clipboard.writeText(url);
    btn.textContent = 'Link copied';
  } catch {
    btn.textContent = 'Link in address bar';
  }
  setTimeout(() => (btn.textContent = 'Share'), 1800);
});

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function encode(text) {
  const raw = new TextEncoder().encode(text);
  if (typeof CompressionStream === 'undefined') return 'p' + b64url(raw);
  const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return 'z' + b64url(new Uint8Array(await new Response(stream).arrayBuffer()));
}

async function decode(data) {
  const bytes = unb64url(data.slice(1));
  if (data[0] === 'p') return new TextDecoder().decode(bytes);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new TextDecoder().decode(await new Response(stream).arrayBuffer());
}

// ------------------------------------------------------------- boot

async function route() {
  const h = decodeURIComponent(location.hash.slice(1));
  if (h.startsWith('s=')) {
    try {
      loadCode(await decode(h.slice(2)), 'Shared program');
      return;
    } catch {
      /* fall through to the default example */
    }
  }
  if (current && current.id === h) return;
  loadExample(EXAMPLES.some((e) => e.id === h) ? h : 'hello');
}

window.addEventListener('hashchange', route);
route();
