#!/usr/bin/env node
/**
 * Extract the AudioWorklet source code blobs that the @elevenlabs/client
 * SDK normally inlines + loads via Blob URL, and write them as static
 * files under public/elevenlabs/. The browser then loads them as plain
 * same-origin scripts, which sidesteps CSP rules around blob: and
 * data: AudioWorklet sources.
 *
 * Without self-hosting, the SDK fails with:
 *   "Failed to load the audioConcatProcessor worklet module. Make sure
 *    the browser supports AudioWorklets. If you are using a strict CSP,
 *    you may need to self-host the worklet files."
 *
 * Re-run this whenever @elevenlabs/client bumps (post-install would be
 * cleanest; for now it's a manual script + the output is gitignored
 * NOTE: actually we COMMIT the output so Vercel builds don't have to run
 * Node-side codegen — the public/elevenlabs/ files are tracked).
 *
 * The SDK ships each worklet's source as a literal `\`...\`` template
 * passed to `createWorkletModuleLoader(name, sourceCode)`. We grep the
 * IIFE bundle, find each call, balance backticks, and emit one .js per
 * worklet.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SDK_BUNDLE = join(ROOT, 'node_modules/@elevenlabs/client/dist/lib.iife.js');
const OUT_DIR = join(ROOT, 'public/elevenlabs');

const WORKLETS = ['rawAudioProcessor', 'audioConcatProcessor', 'scribeAudioProcessor'];

function extractSource(bundle, name) {
  // Find: createWorkletModuleLoader("NAME", `
  const needle = `createWorkletModuleLoader("${name}", \``;
  const start = bundle.indexOf(needle);
  if (start === -1) throw new Error(`could not find loader for ${name}`);
  const sourceStart = start + needle.length;

  // Scan forward respecting escaped backticks. Template literals can
  // contain \\` but those are rare in worklet code; we walk char-by-char
  // and stop at the first unescaped backtick.
  let i = sourceStart;
  while (i < bundle.length) {
    const c = bundle[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') break;
    i++;
  }
  if (i >= bundle.length) throw new Error(`unterminated template for ${name}`);
  return bundle.slice(sourceStart, i);
}

function main() {
  const bundle = readFileSync(SDK_BUNDLE, 'utf8');
  mkdirSync(OUT_DIR, { recursive: true });

  for (const name of WORKLETS) {
    const source = extractSource(bundle, name);
    const out = join(OUT_DIR, `${name}.js`);
    writeFileSync(out, source);
    console.log(`  ${name}: ${source.length} bytes → ${out.replace(ROOT + '/', '')}`);
  }
}

main();
