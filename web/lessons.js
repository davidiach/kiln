// The guided tour: short lessons, each with a starter program, one small
// task, a solution, and a check that watches what the running program
// *does* (its output, pixels, sounds), so any working answer counts.
//
// Checks are pure functions of a context snapshot, so they run the same in
// the playground and in the headless tests:
//   source     the editor's text
//   output     lines printed since the program (re)started
//   screen     pixel helpers over the current frame (see makeScreen)
//   input      { mouseX, mouseY, mouseDown }
//   elapsed    seconds since the program (re)started
//   sounds     sound events since the program (re)started
//   maxSounds  the most sound events produced in a single frame
//   tabsSeen   inspector tabs opened during this lesson
//   memo       scratch space that persists between checks of one run

export function makeScreen(rgba, width = 320, height = 240) {
  const at = (x, y) => {
    const i = (y * width + x) * 4;
    return { r: rgba[i], g: rgba[i + 1], b: rgba[i + 2] };
  };
  const count = (pred, x0 = 0, y0 = 0, x1 = width, y1 = height, step = 1) => {
    let n = 0;
    for (let y = Math.max(0, y0); y < Math.min(height, y1); y += step) {
      for (let x = Math.max(0, x0); x < Math.min(width, x1); x += step) if (pred(at(x, y))) n++;
    }
    return n;
  };
  const centroid = (pred, step = 2) => {
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        if (pred(at(x, y))) {
          sx += x;
          sy += y;
          n++;
        }
      }
    }
    return n ? { x: sx / n, y: sy / n, n } : null;
  };
  return { at, count, centroid, width, height };
}

const isRed = ({ r, g, b }) => r > 150 && g < 100 && b < 100;
const isLit = ({ r, g, b }) => r + g + b > 200;
const isWhite = ({ r, g, b }) => r > 200 && g > 200 && b > 200;
const isOrange = ({ r, g, b }) => r > 200 && g > 110 && g < 210 && b < 130;

export const LESSONS = [
  {
    id: 'hello',
    title: 'Hello, Kiln',
    body: `<p>Welcome! Kiln is a small language that compiles to WebAssembly right here in your browser, every time you type.</p>
<p>A program starts in <code>fn main()</code>, and <code>print</code> writes a line to the console on the right.</p>`,
    task: `Add a second <code>print</code> that prints your favorite number, like <code>print(42);</code>. Every statement ends with a semicolon.`,
    code: `fn main() {
  print("Hello, Kiln!");
}
`,
    solution: `fn main() {
  print("Hello, Kiln!");
  print(42);
}
`,
    check: (c) => c.output.length >= 2 && c.output.some((l) => /\d/.test(l)),
  },
  {
    id: 'types',
    title: 'Numbers and types',
    body: `<p><code>let</code> gives a value a name. Kiln has <code>int</code> for whole numbers and <code>float</code> for numbers with a fraction, and it never mixes them behind your back.</p>
<p>That's why this program claims everyone gets 0 pizza: dividing one int by another gives an int, and the fraction is dropped.</p>`,
    task: `Convert both numbers with <code>as float</code>, like <code>pizzas as float</code>, so the share comes out as 0.75.`,
    code: `fn main() {
  let pizzas = 3;
  let people = 4;
  let share = pizzas / people;
  print("each person gets", share, "pizza");
}
`,
    solution: `fn main() {
  let pizzas = 3;
  let people = 4;
  let share = pizzas as float / people as float;
  print("each person gets", share, "pizza");
}
`,
    check: (c) => c.output.some((l) => l.includes('0.75')),
  },
  {
    id: 'drawing',
    title: 'Drawing',
    body: `<p>The screen is 320 × 240 pixels. (0, 0) is the top-left corner and y grows downward. Colors are hex numbers <code>0xRRGGBB</code>, so <code>0xff0000</code> is red.</p>
<p>You have <code>rect(x, y, width, height, color)</code>, <code>circle(x, y, radius, color)</code>, <code>line</code>, <code>pixel</code> and <code>text(x, y, "HI", color)</code>.</p>`,
    task: `Add a red house standing on the grass, somewhere in the middle. One <code>rect</code> is enough; a door is a bonus.`,
    code: `fn main() {
  clear(0x87c5f5);                      // sky
  rect(0, 165, WIDTH, 75, 0x3e8e41);    // grass
  circle(270, 45, 22, 0xffd43b);        // sun
  text(10, 10, "MY FIRST PICTURE", 0x1b3a5c);
}
`,
    solution: `fn main() {
  clear(0x87c5f5);                      // sky
  rect(0, 165, WIDTH, 75, 0x3e8e41);    // grass
  circle(270, 45, 22, 0xffd43b);        // sun
  text(10, 10, "MY FIRST PICTURE", 0x1b3a5c);
  rect(110, 105, 80, 60, 0xff0000);     // house
  rect(140, 130, 20, 35, 0x6b3e1f);     // door
}
`,
    check: (c) => c.screen.count(isRed, 40, 60, 280, 168, 2) >= 20,
  },
  {
    id: 'loops',
    title: 'Loops',
    body: `<p><code>for x in 0..WIDTH</code> runs its body once for each x from 0 up to WIDTH − 1. Put one loop inside another and you visit every pixel on the screen.</p>
<p><code>rgb(r, g, b)</code> builds a color from three numbers between 0 and 255.</p>`,
    task: `Red rises from left to right. Make green rise from top to bottom too: pass <code>y * 255 / HEIGHT</code> as the second argument to <code>rgb</code>.`,
    code: `fn main() {
  for x in 0..WIDTH {
    let red = x * 255 / WIDTH;
    for y in 0..HEIGHT {
      pixel(x, y, rgb(red, 0, 0));
    }
  }
}
`,
    solution: `fn main() {
  for x in 0..WIDTH {
    let red = x * 255 / WIDTH;
    for y in 0..HEIGHT {
      pixel(x, y, rgb(red, y * 255 / HEIGHT, 0));
    }
  }
}
`,
    check: (c) => c.screen.at(10, 230).g - c.screen.at(10, 8).g > 120,
  },
  {
    id: 'animation',
    title: 'Animation',
    body: `<p>A function named <code>frame</code> runs about 60 times a second, and <code>t</code> is the time in seconds. Redraw everything each frame and things move.</p>
<p><code>sin(t)</code> swings smoothly between −1 and 1, which is just right for back-and-forth motion.</p>`,
    task: `Make the ball go round in a circle: work out a <code>y</code> from <code>cos(t)</code>, the same way <code>x</code> uses <code>sin(t)</code>, and draw the ball there.`,
    code: `fn frame(t: float) {
  clear(0x000000);
  let x = 160.0 + sin(t) * 100.0;
  circle(x as int, 120, 12, 0x4dabf7);
}
`,
    solution: `fn frame(t: float) {
  clear(0x000000);
  let x = 160.0 + sin(t) * 100.0;
  let y = 120.0 + cos(t) * 80.0;
  circle(x as int, y as int, 12, 0x4dabf7);
}
`,
    check: (c) => {
      const p = c.screen.centroid(isLit, 3);
      if (!p) return false;
      const m = c.memo;
      m.x0 = Math.min(m.x0 ?? p.x, p.x);
      m.x1 = Math.max(m.x1 ?? p.x, p.x);
      m.y0 = Math.min(m.y0 ?? p.y, p.y);
      m.y1 = Math.max(m.y1 ?? p.y, p.y);
      return m.x1 - m.x0 > 50 && m.y1 - m.y0 > 50;
    },
  },
  {
    id: 'input',
    title: 'Mouse and keyboard',
    body: `<p><code>mouse_x()</code> and <code>mouse_y()</code> tell you where the pointer is on the screen, and <code>mouse_down()</code> whether the button is held. For keys there's <code>key_down(KEY_SPACE)</code>, <code>KEY_LEFT</code> and friends.</p>
<p><code>cond ? a : b</code> gives <code>a</code> when the condition is true and <code>b</code> otherwise.</p>`,
    task: `Make the crosshair red while the mouse button is held down. Then press and hold on the screen to try it.`,
    code: `fn frame(t: float) {
  clear(0x1b1b2f);
  let mx = mouse_x();
  let my = mouse_y();
  let color = 0xffffff;
  line(mx - 10, my, mx + 10, my, color);
  line(mx, my - 10, mx, my + 10, color);
}
`,
    solution: `fn frame(t: float) {
  clear(0x1b1b2f);
  let mx = mouse_x();
  let my = mouse_y();
  let color = mouse_down() ? 0xff3030 : 0xffffff;
  line(mx - 10, my, mx + 10, my, color);
  line(mx, my - 10, mx, my + 10, color);
}
`,
    check: (c) => {
      if (!c.input.mouseDown) return false;
      const { mouseX: x, mouseY: y } = c.input;
      return c.screen.count(isRed, x - 12, y - 12, x + 13, y + 13) >= 4;
    },
  },
  {
    id: 'functions',
    title: 'Functions',
    body: `<p>A function names a piece of work. Every parameter has a type, and <code>-&gt; float</code> says what comes back. The compiler checks every call, so a wrong argument is caught before anything runs.</p>`,
    task: `Write <code>fn hypotenuse(a: float, b: float) -&gt; float</code> that returns <code>sqrt(a * a + b * b)</code>, then print <code>hypotenuse(3.0, 4.0)</code>. It should say 5.0.`,
    code: `fn area(w: float, h: float) -> float {
  return w * h;
}

fn main() {
  print("a 3 by 4 rectangle has area", area(3.0, 4.0));
}
`,
    solution: `fn area(w: float, h: float) -> float {
  return w * h;
}

fn hypotenuse(a: float, b: float) -> float {
  return sqrt(a * a + b * b);
}

fn main() {
  print("a 3 by 4 rectangle has area", area(3.0, 4.0));
  print("and its diagonal is", hypotenuse(3.0, 4.0));
}
`,
    check: (c) => /fn\s+hypotenuse\s*\(/.test(c.source) && c.output.some((l) => /(^|\s)5\.0(\s|$)/.test(l)),
  },
  {
    id: 'arrays',
    title: 'Arrays',
    body: `<p>An array holds many values of one type. Arrays are declared outside functions with a fixed size, like <code>var xs: [float; 100];</code>, and you use one element at a time: <code>xs[i]</code>.</p>
<p>Here <code>main</code> scatters the snowflakes once, and <code>frame</code> moves every one of them each frame.</p>`,
    task: `Make it a blizzard: change <code>N</code> to 1000. For extra credit, give every flake its own speed with a third array.`,
    code: `const N = 100;
var flake_x: [float; N];
var flake_y: [float; N];

fn main() {
  for i in 0..N {
    flake_x[i] = rand() * WIDTH as float;
    flake_y[i] = rand() * HEIGHT as float;
  }
}

fn frame(t: float) {
  clear(0x0b1026);
  for i in 0..N {
    flake_y[i] += 0.5;
    if flake_y[i] > HEIGHT as float { flake_y[i] = 0.0; }
    pixel(flake_x[i] as int, flake_y[i] as int, 0xffffff);
  }
}
`,
    solution: `const N = 1000;
var flake_x: [float; N];
var flake_y: [float; N];
var speed: [float; N];

fn main() {
  for i in 0..N {
    flake_x[i] = rand() * WIDTH as float;
    flake_y[i] = rand() * HEIGHT as float;
    speed[i] = 0.3 + rand() * 1.2;
  }
}

fn frame(t: float) {
  clear(0x0b1026);
  for i in 0..N {
    flake_y[i] += speed[i];
    if flake_y[i] > HEIGHT as float { flake_y[i] = 0.0; }
    pixel(flake_x[i] as int, flake_y[i] as int, 0xffffff);
  }
}
`,
    check: (c) => c.screen.count(isWhite) > 400,
  },
  {
    id: 'structs',
    title: 'Structs',
    body: `<p>A <code>struct</code> bundles values into a new type of your own. <code>Vec2(160.0, 40.0)</code> makes one, <code>pos.x</code> reads a field, and when every field is a float, <code>+</code>, <code>-</code> and <code>*</code> work on all of them at once.</p>
<p>Structs can have methods too: <code>impl Vec2 { fn length(self) -&gt; float { ... } }</code> lets you write <code>v.length()</code>. The Reference tab has more.</p>
<p>This ball has gravity, and it bounces off the floor…</p>`,
    task: `…but it escapes through the right side. Make it bounce off the left and right walls too, by flipping <code>vel.x</code>. Then watch it for a few seconds.`,
    code: `struct Vec2 { x: float, y: float }

const GRAVITY = Vec2(0.0, 300.0);
var pos = Vec2(160.0, 40.0);
var vel = Vec2(90.0, 0.0);
var last = 0.0;

fn frame(t: float) {
  let dt = min(t - last, 0.05);
  last = t;
  vel += GRAVITY * dt;
  pos += vel * dt;
  if pos.y > 230.0 {
    pos.y = 230.0;
    vel.y = -vel.y * 0.9;
  }
  clear(0x101820);
  circle(pos.x as int, pos.y as int, 10, 0xffa94d);
}
`,
    solution: `struct Vec2 { x: float, y: float }

const GRAVITY = Vec2(0.0, 300.0);
var pos = Vec2(160.0, 40.0);
var vel = Vec2(90.0, 0.0);
var last = 0.0;

fn frame(t: float) {
  let dt = min(t - last, 0.05);
  last = t;
  vel += GRAVITY * dt;
  pos += vel * dt;
  if pos.y > 230.0 {
    pos.y = 230.0;
    vel.y = -vel.y * 0.9;
  }
  if pos.x < 10.0 || pos.x > 310.0 {
    pos.x = clamp(pos.x, 10.0, 310.0);
    vel.x = -vel.x;
  }
  clear(0x101820);
  circle(pos.x as int, pos.y as int, 10, 0xffa94d);
}
`,
    check: (c) => c.elapsed > 6 && c.screen.count(isOrange, 0, 0, 320, 240, 2) >= 15,
  },
  {
    id: 'sound',
    title: 'Sound',
    body: `<p><code>sound(wave, from_hz, to_hz, seconds, volume)</code> plays a sound whose pitch slides from the first frequency to the second. <code>note(60)</code> gives middle C in Hz, and each step up is a semitone.</p>
<p>Browsers only allow sound after you click the page, so click the screen to begin.</p>`,
    task: `Play a second sound on each click so it becomes a chord: try <code>note(n + 7)</code> with <code>WAVE_SQUARE</code> and a smaller volume.`,
    code: `var was_down = false;

fn frame(t: float) {
  let down = mouse_down();
  if down && !was_down {
    // the further right you click, the higher the note
    let n = 48 + mouse_x() / 10;
    sound(WAVE_TRIANGLE, note(n), note(n), 0.5, 0.5);
  }
  was_down = down;
  clear(0x141414);
  text(110, 115, "CLICK TO PLAY", 0xffffff);
}
`,
    solution: `var was_down = false;

fn frame(t: float) {
  let down = mouse_down();
  if down && !was_down {
    // the further right you click, the higher the note
    let n = 48 + mouse_x() / 10;
    sound(WAVE_TRIANGLE, note(n), note(n), 0.5, 0.5);
    sound(WAVE_SQUARE, note(n + 7), note(n + 7), 0.4, 0.15);
  }
  was_down = down;
  clear(0x141414);
  text(110, 115, "CLICK TO PLAY", 0xffffff);
}
`,
    check: (c) => c.maxSounds >= 2,
  },
  {
    id: 'wasm',
    title: 'Under the hood',
    body: `<p>Everything you wrote was compiled to real WebAssembly, in this page, as you typed. The <b>WebAssembly</b> tab shows the instructions your code became, with your source lines as comments. <b>Bytes</b> shows the binary itself, colored by section.</p>`,
    task: `Open the WebAssembly tab and find <code>(func $frame</code>. Each <code>f64.add</code> or <code>local.get</code> under it is one instruction your browser runs.`,
    code: `fn frame(t: float) {
  for y in 0..HEIGHT {
    for x in 0..WIDTH {
      let v = sin(x as float * 0.05 + t) + cos(y as float * 0.05 + t);
      pixel(x, y, hsv(v * 0.2 + t * 0.1, 0.7, 0.9));
    }
  }
}
`,
    solution: null,
    check: (c) => c.tabsSeen.has('wat'),
  },
];

export const FINISHED = `<p>That's the whole tour. You can now draw, animate, take input, organize code with functions, arrays and structs, and make sound.</p>
<p>Next, open the examples in the menu: the ray marcher and the voxel landscape show what this little language can do, the step sequencer is fun to play with, and Stardust is a complete game. Everything you change is saved in this browser.</p>`;
