#!/usr/bin/env node
// audit-anthropic-tool-loops — one tripwire, two rules, both about the same
// mistake: hand-rolling another Anthropic tool loop instead of using the
// shared core in src/lib/agent/loop-core.ts.
//
// WHY
// This app had THREE copies of the same ~200-line loop. `runAgent` and
// `streamAgent` in src/lib/agent/llm.ts were kept in parity by hand across
// ~12 rounds of adversarial review; `runStaxisAssistant` in
// src/lib/comms/assistant.ts was written separately and received almost none
// of that hardening — it was still feeding RAW, unescaped document text back
// to the model in July 2026, months after the main agent had been wrapping it.
// Nobody noticed because nothing failed. A fourth copy would repeat that
// exactly, and the failure mode is silent by construction.
//
// RULE 1 — no new hand-rolled loops.
//   A file is a "tool loop" when it BOTH talks to the Anthropic SDK
//   (`messages.create` / `messages.stream`) AND builds `tool_result` blocks to
//   feed back. One-shot structured-output calls (a `tools:` schema with
//   `tool_choice` forcing a single call, never fed back) are NOT loops and are
//   not flagged — they have no iteration to get wrong.
//
// RULE 2 — every loop wraps its tool output.
//   Any file that builds `tool_result` blocks must produce their content via
//   `wrapToolResultForModel` (truncate → escape <>& → trust marker). Raw tool
//   output is the prompt-injection hole this exists to close.
//
// Both allowlists may only ever SHRINK. Adding an entry is a visible edit in
// review, which is the whole point.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const SRC = join(REPO, 'src');

/** Every file allowed to drive an Anthropic tool loop by hand. */
const KNOWN_TOOL_LOOPS = new Set([
  // runAgent + streamAgent. Two entry points, one core, same file.
  'src/lib/agent/llm.ts',
  // The @Staxis thread assistant. Still hand-rolls its iteration (its five
  // tools live outside the agent registry and it has no approval gate), but
  // its tool results now go through the canonical wrap. Folding it into
  // streamAgent is scoped follow-up work — see the note on runStaxisAssistant.
  'src/lib/comms/assistant.ts',
]);

/**
 * Files that emit `tool_result` blocks WITHOUT wrapToolResultForModel, for a
 * reason that survives review. Keep this list at zero if you possibly can.
 *
 *   src/lib/agent/llm.ts — toClaudeMessages synthesizes an "aborted before
 *   completion" placeholder for a dangling tool_use, and the fan-out cap
 *   synthesizes a refusal. Both are OUR OWN text, not tool output, so wrapping
 *   them in an untrusted marker would be a lie. Every real tool result in that
 *   file does go through the wrap.
 */
const RAW_TOOL_RESULT_ALLOWED = new Set([
  'src/lib/agent/llm.ts',
  /**
   * src/lib/ai/openai-messages.ts — the OpenAI wire adapter. It never CREATES
   * tool-result content; it reads `tool_result` blocks that llm.ts already
   * produced through wrapToolResultForModel and re-shapes them into OpenAI's
   * `role: "tool"` messages. Wrapping again here would escape the escapes and
   * corrupt the payload. Rule 2's coverage is unaffected: whatever call site
   * BUILDS the block is still scanned, and still has to wrap.
   */
  'src/lib/ai/openai-messages.ts',
]);

const SDK_CALL_RX = /\bmessages\s*\.\s*(?:create|stream)\s*\(/;
const TOOL_RESULT_RX = /['"]tool_result['"]/;
const WRAP_HELPER_RX = /\bwrapToolResultForModel\s*\(/;

const SKIP_DIRS = new Set(['node_modules', '.next', '__tests__', 'evals']);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(p);
  }
  return out;
}

const files = walk(SRC);
const newLoops = [];
const rawResults = [];
const seenLoops = new Set();

for (const f of files) {
  const rel = relative(REPO, f).split(sep).join('/');
  const src = readFileSync(f, 'utf8');

  const buildsToolResults = TOOL_RESULT_RX.test(src);
  const callsSdk = SDK_CALL_RX.test(src);

  if (buildsToolResults && callsSdk) {
    if (KNOWN_TOOL_LOOPS.has(rel)) seenLoops.add(rel);
    else newLoops.push(rel);
  }

  if (buildsToolResults && !WRAP_HELPER_RX.test(src) && !RAW_TOOL_RESULT_ALLOWED.has(rel)) {
    rawResults.push(rel);
  }
}

if (newLoops.length > 0) {
  console.error(`✗ audit-anthropic-tool-loops: ${newLoops.length} new hand-rolled Anthropic tool loop(s):`);
  for (const v of newLoops) console.error(`    ${v}`);
  console.error('');
  console.error('A tool loop is a file that calls messages.create/stream AND feeds tool_result blocks back.');
  console.error('There were three copies of this loop and the third one silently missed almost every');
  console.error('security and billing fix the other two got. Drive the iteration through');
  console.error('src/lib/agent/loop-core.ts (or call streamAgent/runAgent) instead of writing a fourth.');
  console.error('If a separate loop is genuinely unavoidable, add it to KNOWN_TOOL_LOOPS here and say why.');
  process.exit(1);
}

if (rawResults.length > 0) {
  console.error(`✗ audit-anthropic-tool-loops: ${rawResults.length} file(s) build tool_result blocks without the trust-marker wrap:`);
  for (const v of rawResults) console.error(`    ${v}`);
  console.error('');
  console.error('Tool output is UNTRUSTED — search_knowledge alone returns the text of documents staff');
  console.error('uploaded. Pass it through wrapToolResultForModel() from @/lib/agent/loop-core so the');
  console.error('payload is truncated, <>& escaped (it cannot forge the closing tag), and marked as data.');
  process.exit(1);
}

const stale = [...KNOWN_TOOL_LOOPS].filter((f) => !seenLoops.has(f));
if (stale.length > 0) {
  console.error(`✗ audit-anthropic-tool-loops: ${stale.length} stale KNOWN_TOOL_LOOPS entry/entries:`);
  for (const v of stale) console.error(`    ${v}`);
  console.error('');
  console.error('These files no longer look like tool loops. Delete them from KNOWN_TOOL_LOOPS so the');
  console.error('list keeps meaning "every loop we have" rather than "every loop we once had".');
  process.exit(1);
}

console.log(
  `✓ audit-anthropic-tool-loops: scanned ${files.length} file(s); ` +
  `${seenLoops.size} known tool loop(s), no new hand-rolled ones, every tool_result trust-wrapped.`,
);
