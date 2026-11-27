#!/usr/bin/env node
// The Kiln command-line tool.

import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { compile, formatError, withSourceMapURL } from '../src/compiler.js';
import { instantiate } from '../src/runtime.js';
import { encodePNG } from '../src/png.js';
import { renderSounds, encodeWav } from '../src/synth.js';

const USAGE = `kiln: a tiny language that compiles to WebAssembly

usage:
  kiln run <file.kiln> [--frames N]      compile and run main() (and N frames)
  kiln check <file.kiln>                 type-check only
  kiln build <file.kiln> [-o out.wasm]   write the WebAssembly binary and its source map (out.wasm.map)
  kiln wat <file.kiln>                   print the generated WebAssembly text
  kiln render <file.kiln> [-t secs] [-o out.png] [--scale N]
                                         run headless and save the screen as PNG
  kiln audio <file.kiln> [-t secs] [-o out.wav]
                                         run headless and record the sound as WAV
`;

function arg(args, flag, fallback) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}

function load(file) {
  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch {
    console.error(`kiln: can't read '${file}'`);
    process.exit(2);
  }
  const result = compile(source, { filename: basename(file) });
  if (!result.ok) {
    for (const e of result.errors) console.error(formatError(e, source, file) + '\n');
    console.error(`kiln: ${result.errors.length} error${result.errors.length === 1 ? '' : 's'}`);
    process.exit(1);
  }
  return result;
}

async function main(argv) {
  const [cmd, file, ...rest] = argv;
  if (!cmd || cmd === '-h' || cmd === '--help' || !file) {
    process.stdout.write(USAGE);
    process.exit(cmd ? 0 : 2);
  }
  const result = load(file);
  const stem = basename(file).replace(/\.kiln$/, '');
  try {
    switch (cmd) {
      case 'check':
        console.log(`ok: ${result.stats.bytes} bytes of wasm, ${result.stats.functions} functions (${result.time.toFixed(1)} ms)`);
        break;
      case 'build': {
        const out = arg(rest, '-o', `${stem}.wasm`);
        // The map sits next to the binary, which refers to it by name.
        writeFileSync(`${out}.map`, JSON.stringify(result.sourceMap));
        writeFileSync(out, withSourceMapURL(result.binary, `${basename(out)}.map`));
        console.log(`wrote ${out} (${result.binary.length} bytes) and ${out}.map`);
        break;
      }
      case 'wat':
        console.log(result.wat);
        break;
      case 'run': {
        const inst = await instantiate(result);
        inst.main();
        const frames = Number(arg(rest, '--frames', 0));
        for (let i = 0; i < frames; i++) inst.frame(i / 60);
        break;
      }
      case 'render': {
        const secs = Number(arg(rest, '-t', 2));
        const scale = Number(arg(rest, '--scale', 2));
        const out = arg(rest, '-o', `${stem}.png`);
        const inst = await instantiate(result, { print: () => {}, random: seeded(1234) });
        inst.main();
        const frames = Math.round(secs * 60);
        for (let i = 0; i <= frames; i++) inst.frame(i / 60);
        writeFileSync(out, encodePNG(inst.pixels(), inst.width, inst.height, scale));
        console.log(`wrote ${out} (t = ${secs}s)`);
        break;
      }
      case 'audio': {
        const secs = Number(arg(rest, '-t', 4));
        const out = arg(rest, '-o', `${stem}.wav`);
        const events = [];
        const rate = 44100;
        const inst = await instantiate(result, { print: () => {}, random: seeded(1234), sound: (e) => events.push(e), sampleRate: rate });
        inst.main();
        // audio(t) runs between frames, as in the playground, so it sees what frame() changed
        const stream = inst.hasAudio ? new Float32Array(Math.ceil(secs * rate)) : null;
        let done = 0;
        const frames = Math.round(secs * 60);
        for (let i = 0; i <= frames; i++) {
          inst.frame(i / 60);
          if (stream) {
            const end = Math.min(stream.length, Math.round(((i + 1) / 60) * rate));
            if (end > done) stream.set(inst.audio(done / rate, end - done, rate), done);
            done = Math.max(done, end);
          }
        }
        writeFileSync(out, encodeWav(renderSounds(events, secs, rate, 1, stream), rate));
        const what = [`${events.length} sound${events.length === 1 ? '' : 's'}`, ...(stream ? ['audio(t)'] : [])].join(' + ');
        console.log(`wrote ${out} (${secs}s, ${what})`);
        break;
      }
      default:
        console.error(`kiln: unknown command '${cmd}'\n`);
        process.stdout.write(USAGE);
        process.exit(2);
    }
  } catch (e) {
    console.error(`runtime error: ${e.message}`);
    process.exit(1);
  }
}

// Deterministic rand() for reproducible renders.
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

main(process.argv.slice(2));
