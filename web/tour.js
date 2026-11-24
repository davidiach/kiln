// The guided tour UI: a lesson card above the editor that explains one idea,
// sets a small task, and watches the running program until the task is met.

import { LESSONS, FINISHED } from './lessons.js';

const CHECK_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5"/></svg>';
const POLL_MS = 250;

/**
 * api: {
 *   open(doc)        load { id, title, code, filename } into the editor and run it
 *   getCode()        current editor text
 *   setCode(text)    replace the editor text (saved as a draft) and run it
 *   context()        snapshot of the running program for checks, or null
 *   activeTab()      the inspector tab currently shown
 *   exit()           leave the tour
 *   celebrate()      a small reward when a task is done
 *   example(id)      open an example
 * }
 */
export function createTour({ root, store, api }) {
  const saved = (k, fallback) => {
    try {
      return JSON.parse(store.get(k)) ?? fallback;
    } catch {
      return fallback;
    }
  };
  const done = new Set(saved('kiln.tour.done', []));
  let index = Math.min(saved('kiln.tour.at', 0), LESSONS.length - 1);
  let active = false;
  let finished = false;
  let collapsed = saved('kiln.tour.collapsed', false);
  let memo = {};
  let tabsSeen = new Set();
  let solutionShown = false;
  let attempt = null; // the learner's own code while the solution is shown
  let justDone = false;

  const lesson = () => LESSONS[index];
  const docFor = (i) => ({
    id: `tour-${LESSONS[i].id}`,
    title: LESSONS[i].title,
    code: LESSONS[i].code,
    filename: `lesson-${i + 1}.kiln`,
  });

  function open(i = index) {
    index = Math.max(0, Math.min(i, LESSONS.length - 1));
    active = true;
    finished = false;
    solutionShown = false;
    attempt = null;
    justDone = false;
    memo = {};
    tabsSeen = new Set([api.activeTab()]);
    store.set('kiln.tour.at', JSON.stringify(index));
    root.hidden = false;
    render();
    api.open(docFor(index));
  }

  function close() {
    active = false;
    root.hidden = true;
  }

  function finish() {
    finished = true;
    render();
  }

  function render() {
    if (finished) {
      root.className = 'lesson finished';
      root.innerHTML = `
        <div class="lesson-head">
          <span class="lesson-count">Tour complete</span>
          <h2>You did it</h2>
          <button class="lesson-x" data-act="exit" aria-label="Close the tour">✕</button>
        </div>
        <div class="lesson-body">${FINISHED}</div>
        <div class="lesson-foot">
          <button class="primary" data-act="example" data-id="raymarch">Open the ray marcher</button>
          <button data-act="example" data-id="sequencer">Play the sequencer</button>
          <button data-act="restart">Start over</button>
        </div>`;
      return;
    }
    const l = lesson();
    const isDone = done.has(l.id);
    const last = index === LESSONS.length - 1;
    root.className = `lesson${isDone ? ' done' : ''}${collapsed ? ' collapsed' : ''}${justDone ? ' fresh' : ''}`;
    const dots = LESSONS.map(
      (x, i) =>
        `<button class="dot${done.has(x.id) ? ' is-done' : ''}${i === index ? ' is-here' : ''}" data-act="go" data-i="${i}" aria-label="Lesson ${i + 1}: ${x.title}${done.has(x.id) ? ' (done)' : ''}"${i === index ? ' aria-current="step"' : ''}></button>`,
    ).join('');
    const status = isDone
      ? `<span class="lesson-status ok">${CHECK_ICON}${justDone ? 'Nice, that works!' : 'Done'}</span>`
      : `<span class="lesson-status">Waiting for your change…</span>`;
    const solution = l.solution
      ? `<button class="link" data-act="solution">${solutionShown ? 'Back to my code' : 'Show solution'}</button>`
      : '';
    root.innerHTML = `
      <div class="lesson-head">
        <span class="lesson-count">Lesson ${index + 1} of ${LESSONS.length}</span>
        <h2>${l.title}</h2>
        <button class="lesson-x" data-act="collapse" aria-expanded="${!collapsed}" aria-label="${collapsed ? 'Show' : 'Hide'} the lesson">${collapsed ? '▾' : '▴'}</button>
        <button class="lesson-x" data-act="exit" aria-label="Close the tour">✕</button>
      </div>
      <div class="lesson-main">
        <div class="lesson-body">${l.body}</div>
        <div class="lesson-task"><b>Your turn</b> ${l.task}</div>
      </div>
      <div class="lesson-foot">
        ${status}
        ${solution}
        <span class="spacer"></span>
        <button data-act="prev"${index === 0 ? ' disabled' : ''}>Back</button>
        <button data-act="next" class="${isDone ? 'primary' : ''}">${last ? 'Finish' : 'Next'}</button>
      </div>
      <nav class="lesson-dots" aria-label="Lessons">${dots}</nav>`;
  }

  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    switch (b.dataset.act) {
      case 'next':
        if (index === LESSONS.length - 1) finish();
        else open(index + 1);
        break;
      case 'prev':
        open(index - 1);
        break;
      case 'go':
        open(+b.dataset.i);
        break;
      case 'collapse':
        collapsed = !collapsed;
        store.set('kiln.tour.collapsed', JSON.stringify(collapsed));
        render();
        break;
      case 'exit':
        close();
        api.exit();
        break;
      case 'restart':
        done.clear();
        store.set('kiln.tour.done', '[]');
        open(0);
        break;
      case 'example':
        close();
        api.example(b.dataset.id);
        break;
      case 'solution':
        if (solutionShown) {
          api.setCode(attempt ?? lesson().code);
          solutionShown = false;
        } else {
          attempt = api.getCode();
          api.setCode(lesson().solution);
          solutionShown = true;
        }
        render();
        break;
    }
  });

  function poll() {
    if (!active || finished) return;
    const l = lesson();
    if (done.has(l.id)) return;
    let ctx = null;
    try {
      ctx = api.context();
    } catch {
      return;
    }
    if (!ctx) return;
    ctx.memo = memo;
    ctx.tabsSeen = tabsSeen;
    let ok = false;
    try {
      ok = !!l.check(ctx);
    } catch {
      ok = false;
    }
    if (ok) {
      done.add(l.id);
      store.set('kiln.tour.done', JSON.stringify([...done]));
      justDone = true;
      render();
      api.celebrate();
    }
  }
  setInterval(poll, POLL_MS);

  return {
    open,
    close,
    get active() {
      return active;
    },
    /** Lesson index from a hash like "tour-3" (1-based), or the saved position. */
    indexFor(hash) {
      const n = Number(/^tour-(\d+)$/.exec(hash)?.[1]);
      return Number.isInteger(n) && n >= 1 ? n - 1 : index;
    },
    hash() {
      return `tour-${index + 1}`;
    },
    noteTab(name) {
      tabsSeen.add(name);
    },
    /** The program restarted: forget observations about the previous run. */
    noteRestart() {
      memo = {};
    },
    /** The learner edited the code by hand, so the solution is no longer what's shown. */
    noteEdit() {
      if (solutionShown) {
        solutionShown = false;
        attempt = null;
        render();
      }
    },
  };
}
