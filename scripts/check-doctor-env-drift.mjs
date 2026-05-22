#!/usr/bin/env node
// CI guard — fails when an env var that src/lib/env.ts marks as STRICTLY
// REQUIRED (no .optional(), no .default()) is missing from the doctor's
// REQUIRED_ENV_VARS list in src/app/api/admin/doctor/route.ts.
//
// Why this exists:
//   Adding a strictly-required key to env.ts crashes prod boot loudly —
//   that part already works. But if the doctor's REQUIRED_ENV_VARS list
//   doesn't also know about the new key, the cron-driven health
//   alert + the doctor UI silently miss it. A future redeploy could
//   then drop the key (typo, env-promotion mistake) and the doctor
//   would still report "all required env vars present" because its
//   list didn't include the new entry. That's the failure mode this
//   gate exists to prevent.
//
// Direction: env.ts (strict) → doctor (REQUIRED_ENV_VARS). One-way.
//   - If env.ts marks X as required → doctor MUST list X.
//   - If doctor lists X but env.ts has X as .optional() → INTENTIONAL.
//     The doctor is the deploy-readiness gate; env.ts is the boot gate.
//     Production-required-but-boot-optional vars (e.g. ANTHROPIC_API_KEY)
//     live as `.optional()` in env.ts so dev/preview can boot without
//     them, but are explicitly listed in REQUIRED_ENV_VARS so the
//     doctor warns when production is missing them.
//
// SCOPE LIMITATION: this check does NOT catch the 2026-05-13
//   ANTHROPIC_API_KEY-class outage where a key is `.optional()` in
//   env.ts AND missing from doctor's REQUIRED_ENV_VARS. That class
//   requires a separate primitive (e.g., a `// PROD-REQUIRED` annotation
//   in env.ts that this script could parse). Tracked as a follow-up.
//
// PARSING ASSUMPTION (brittle): env.ts uses a FLAT `z.object({ KEY:
//   z.string()..., ... })` schema named `ServerSchema`. If env.ts ever
//   adopts `z.union`, `z.discriminatedUnion`, nested objects, or splits
//   into multiple schemas, this script needs updating. There's no clean
//   way to parse Zod without running TypeScript through ts-morph or the
//   compiler API — the marginal value didn't justify that dependency
//   for v1. If you refactor env.ts and CI starts failing here with
//   nonsense, that's the cause.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const ENV_TS_PATH = join(ROOT, 'src/lib/env.ts');
const DOCTOR_PATH = join(ROOT, 'src/app/api/admin/doctor/route.ts');

function fail(msg) {
  console.error(`❌ check-doctor-env-drift: ${msg}`);
  process.exit(1);
}

const envTs = readFileSync(ENV_TS_PATH, 'utf8');
const doctorTs = readFileSync(DOCTOR_PATH, 'utf8');

// 1. Extract the ServerSchema body — text between `ServerSchema = z.object({`
//    and the matching closing `})`. Bracket-balance count handles inline
//    `z.object({...})` nested calls correctly.
const SCHEMA_START_RE = /ServerSchema\s*=\s*z\.object\(\{/;
const startMatch = envTs.match(SCHEMA_START_RE);
if (!startMatch) {
  fail('Could not find `ServerSchema = z.object({` in src/lib/env.ts. Did the schema layout change?');
}
const startIdx = startMatch.index + startMatch[0].length;
let depth = 1;
let endIdx = startIdx;
for (let i = startIdx; i < envTs.length; i++) {
  const c = envTs[i];
  if (c === '{') depth += 1;
  else if (c === '}') {
    depth -= 1;
    if (depth === 0) { endIdx = i; break; }
  }
}
if (depth !== 0) {
  fail('Unbalanced braces inside ServerSchema body. Aborting.');
}
const schemaBody = envTs.slice(startIdx, endIdx);

// 2. For each line, look for `KEY: <zod chain>,` and classify as
//    STRICT_REQUIRED if the chain has no `.optional()` AND no `.default(`.
//    A "key" must be uppercase ASCII (env var naming convention).
//    Multi-line chains are flattened by scanning forward to the next
//    line that starts a new key (or end of body).
const lines = schemaBody.split('\n');
const KEY_RE = /^\s*([A-Z][A-Z0-9_]*)\s*:/;

const strictRequired = [];
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(KEY_RE);
  if (!m) continue;
  const key = m[1];

  // Accumulate the field's full Zod chain across lines until we hit
  // the next key or the end. The closing comma terminates a field but
  // Zod refinements can wrap onto subsequent lines.
  let chain = lines[i];
  for (let j = i + 1; j < lines.length; j++) {
    if (KEY_RE.test(lines[j])) break;
    chain += '\n' + lines[j];
  }

  const hasOptional = /\.optional\(/.test(chain);
  const hasDefault = /\.default\(/.test(chain);

  if (!hasOptional && !hasDefault) {
    strictRequired.push(key);
  }
}

if (strictRequired.length === 0) {
  fail('Parsed zero strictly-required keys from ServerSchema. The regex likely no longer matches the schema layout.');
}

// 3. Extract REQUIRED_ENV_VARS entries from doctor route. Match all
//    `name: 'KEY'` AND `altNames: [ ... ]` entries inside the array.
const REQ_ARRAY_RE = /REQUIRED_ENV_VARS\s*:[^=]*=\s*\[([\s\S]*?)\];/;
const arrMatch = doctorTs.match(REQ_ARRAY_RE);
if (!arrMatch) {
  fail('Could not find `REQUIRED_ENV_VARS: ... = [ ... ];` in doctor route. Layout changed?');
}
const arrBody = arrMatch[1];

const doctorKeys = new Set();
// Match `name: 'KEY'` or `name: "KEY"`
const NAME_RE = /name\s*:\s*['"]([A-Z][A-Z0-9_]*)['"]/g;
for (const m of arrBody.matchAll(NAME_RE)) doctorKeys.add(m[1]);
// Match `altNames: ['KEY1', 'KEY2']` — pull each alt name too
const ALT_RE = /altNames\s*:\s*\[([^\]]+)\]/g;
for (const m of arrBody.matchAll(ALT_RE)) {
  const inner = m[1];
  for (const am of inner.matchAll(/['"]([A-Z][A-Z0-9_]*)['"]/g)) {
    doctorKeys.add(am[1]);
  }
}

if (doctorKeys.size === 0) {
  fail('Parsed zero entries from REQUIRED_ENV_VARS. Regex outdated?');
}

// 4. Compare: every strictRequired key MUST be in doctorKeys.
const missing = strictRequired.filter(k => !doctorKeys.has(k));

if (missing.length > 0) {
  console.error('❌ check-doctor-env-drift: drift detected.');
  console.error('   The following env vars are STRICTLY REQUIRED in src/lib/env.ts');
  console.error('   (no .optional(), no .default()) but are NOT listed in');
  console.error('   REQUIRED_ENV_VARS in src/app/api/admin/doctor/route.ts:');
  console.error('');
  for (const k of missing) console.error(`     - ${k}`);
  console.error('');
  console.error('   Fix: add each missing key to REQUIRED_ENV_VARS so the doctor');
  console.error('   surfaces a missing-env failure instead of silently passing.');
  process.exit(1);
}

console.log(
  `✓ check-doctor-env-drift: ${strictRequired.length} strict-required env.ts keys, all present in doctor's REQUIRED_ENV_VARS.`
);
