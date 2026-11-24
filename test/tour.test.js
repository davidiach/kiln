import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile } from '../src/compiler.js';
import { instantiate } from '../src/runtime.js';
import { LESSONS, makeScreen } from '../web/lessons.js';

// Scripted input for lessons that need the user to do something.
const CLICKING = (f, input) => {
  input.mouseX = 200;
  input.mouseY = 120;
  input.mouseDown = f % 60 < 30;
};
const SCRIPTS = { input: CLICKING, sound: CLICKING };

/** Run `code` like the playground would and report whether the lesson's check ever passes. */
async function passes(lesson, code, { seconds = 8, tabsSeen = new Set() } = {}) {
  const r = compile(code);
  assert.ok(r.ok, `${lesson.id}: ${r.ok ? '' : r.errors.map((e) => `${e.span.line}: ${e.message}`).join('; ')}`);
  const output = [];
  const input = { mouseX: 160, mouseY: 120, mouseDown: false, keys: new Set() };
  let sounds = 0;
  let frameSounds = 0;
  let maxSounds = 0;
  const inst = await instantiate(r, {
    input,
    print: (l) => output.push(l),
    sound: () => {
      sounds++;
      frameSounds++;
    },
  });
  inst.main();
  const memo = {};
  for (let f = 0; f <= seconds * 60; f++) {
    SCRIPTS[lesson.id]?.(f, input);
    frameSounds = 0;
    inst.frame(f / 60);
    maxSounds = Math.max(maxSounds, frameSounds);
    if (f % 15 === 0) {
      const ctx = {
        source: code,
        output: [...output],
        screen: makeScreen(inst.pixels()),
        input: { ...input },
        elapsed: f / 60,
        sounds,
        maxSounds,
        tabsSeen,
        memo,
      };
      if (lesson.check(ctx)) return true;
    }
  }
  return false;
}

test('there are lessons, with unique ids and the pieces the UI needs', () => {
  assert.ok(LESSONS.length >= 8);
  assert.equal(new Set(LESSONS.map((l) => l.id)).size, LESSONS.length);
  for (const l of LESSONS) {
    for (const key of ['title', 'body', 'task', 'code']) assert.ok(l[key], `${l.id} has ${key}`);
    assert.equal(typeof l.check, 'function');
  }
});

for (const lesson of LESSONS) {
  test(`lesson "${lesson.title}": the starter runs but doesn't pass; the solution does`, async () => {
    assert.equal(await passes(lesson, lesson.code), false, 'starter code should not already pass');
    if (lesson.solution) {
      assert.equal(await passes(lesson, lesson.solution), true, 'solution should pass');
    } else {
      // Lessons without a code change are about doing something in the UI.
      assert.equal(await passes(lesson, lesson.code, { tabsSeen: new Set(['wat']) }), true);
    }
  });
}

// Other reasonable answers must pass too: the checks look at behavior, not text.
const ALTERNATIVES = {
  hello: ['fn main() {\n  print("Hi, I am Sam");\n  print("my number is", 7);\n}\n'],
  types: ['fn main() {\n  let pizzas = 3;\n  let people = 4;\n  let share = (pizzas as float) / (people as float);\n  print(share);\n}\n'],
  drawing: [
    'fn main() {\n  clear(0x87c5f5);\n  rect(0, 165, WIDTH, 75, 0x3e8e41);\n  rect(60, 125, 50, 40, 0xcc2222);\n  line(60, 125, 85, 100, 0x000000);\n}\n',
  ],
  animation: ['fn frame(t: float) {\n  clear(0);\n  circle((160.0 + 90.0 * sin(t * 2.0)) as int, (120.0 + 60.0 * cos(t * 2.0)) as int, 8, 0xffffff);\n}\n'],
  input: [
    'fn frame(t: float) {\n  clear(0x1b1b2f);\n  var c = 0xffffff;\n  if mouse_down() { c = 0xff0000; }\n  circle(mouse_x(), mouse_y(), 6, c);\n}\n',
  ],
  structs: [
    LESSONS.find((l) => l.id === 'structs').code.replace(
      '  clear(0x101820);',
      '  if pos.x > 310.0 { vel.x = -abs(vel.x); }\n  if pos.x < 10.0 { vel.x = abs(vel.x); }\n  clear(0x101820);',
    ),
  ],
};

for (const [id, variants] of Object.entries(ALTERNATIVES)) {
  test(`lesson "${id}" accepts other reasonable solutions`, async () => {
    const lesson = LESSONS.find((l) => l.id === id);
    for (const code of variants) assert.equal(await passes(lesson, code), true, code);
  });
}
