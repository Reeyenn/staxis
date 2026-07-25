#!/usr/bin/env node
// audit-eval-regressions — THE RATCHET, part 1.
//
// Rule: a `fix(` commit that touches the agent, the PMS/data layer, or the
// report-ingestion surface must ALSO touch a test, the eval bank, or a golden
// fixture — in the SAME commit. A bug you fixed without a test is a bug that
// can ship again, and at this repo's velocity it will.
//
// Escape hatch: put `[no-eval: <reason>]` in the commit body. Usage is COUNTED
// and printed on every run, and more than MAX_EXEMPTIONS in the audited range
// fails the build. An escape hatch nobody counts is just a disabled rule.
//
// ─── Why the range derivation is the fiddly part ─────────────────────────
// The obvious `git log origin/main..HEAD` silently passes on this repo's
// PRIMARY flow. Pushing straight to main is the documented workflow
// (CLAUDE.md), and on a push event HEAD == origin/main, so the range is empty
// and the gate reports success having checked nothing. `actions/checkout@v4`
// also defaults to a depth-1 clone, so even the right range has no history to
// walk. Both were verified before this script was written.
//
// So: derive the range from the GitHub event (before..after on push,
// merge-base on PR), and when it cannot be resolved, FAIL — never skip. The
// one exception is a local run with no base ref at all (fresh clone, no
// remote), which warns and passes because CI is the enforcement point.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const WATCHED_PREFIXES = [
  'src/lib/agent/',
  'src/lib/pms/',
  'src/app/api/agent/',
  'src/app/api/pms-inbox/',
  'cua-service/src/',
];

const TEST_PREFIXES = [
  'src/lib/agent/evals/',
  'src/lib/__tests__/',
  'tests/fixtures/',
  'cua-service/test/',
  'cua-service/src/__tests__/',
];

// Above this many `[no-eval:]` commits in one audited range, the gate fails.
// The point is that skipping is visible and bounded, not free.
const MAX_EXEMPTIONS = 5;

const IN_CI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
const ZERO_SHA = '0000000000000000000000000000000000000000';

function git(args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    if (allowFail) return null;
    throw err;
  }
}

function commitExists(sha) {
  if (!sha || sha === ZERO_SHA) return false;
  return git(['cat-file', '-e', `${sha}^{commit}`], { allowFail: true }) !== null;
}

function fail(lines) {
  console.error('✗ audit-eval-regressions:');
  for (const l of lines) console.error(`    ${l}`);
  process.exit(1);
}

function readGithubEvent() {
  const p = process.env.GITHUB_EVENT_PATH;
  if (!p || !existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Resolve the commit range to audit.
 * Returns { from, to, label } or { skip, reason } (local-only) — or exits.
 */
function resolveRange() {
  const eventName = process.env.GITHUB_EVENT_NAME;
  const event = readGithubEvent();

  if (IN_CI && eventName === 'push' && event) {
    const before = event.before;
    const after = event.after ?? git(['rev-parse', 'HEAD']);
    if (before && before !== ZERO_SHA) {
      if (!commitExists(before) || !commitExists(after)) {
        fail([
          `push range ${String(before).slice(0, 8)}..${String(after).slice(0, 8)} is not present in this clone.`,
          'The checkout is too shallow to audit the pushed commits.',
          'Fix: actions/checkout@v4 with `fetch-depth: 0` (or a depth that covers the push).',
        ]);
      }
      return { from: before, to: after, label: `push ${before.slice(0, 8)}..${after.slice(0, 8)}` };
    }
    // Branch creation (before = 0000…): audit the tip commit only. Auditing a
    // whole new branch's history against main would flag old commits.
    if (!commitExists(after)) {
      fail([`push head ${String(after).slice(0, 8)} is missing from this clone (shallow checkout).`]);
    }
    return { from: `${after}^`, to: after, label: `new branch tip ${String(after).slice(0, 8)}`, single: true };
  }

  if (IN_CI && eventName === 'pull_request' && event?.pull_request) {
    const base = event.pull_request.base?.sha;
    const head = event.pull_request.head?.sha ?? git(['rev-parse', 'HEAD']);
    if (!commitExists(base) || !commitExists(head)) {
      fail([
        `PR range ${String(base).slice(0, 8)}..${String(head).slice(0, 8)} is not present in this clone.`,
        'Fix: actions/checkout@v4 with `fetch-depth: 0`.',
      ]);
    }
    const mergeBase = git(['merge-base', base, head], { allowFail: true }) ?? base;
    return { from: mergeBase, to: head, label: `PR ${mergeBase.slice(0, 8)}..${head.slice(0, 8)}` };
  }

  if (IN_CI) {
    fail([
      `running in CI with GITHUB_EVENT_NAME='${eventName ?? '(unset)'}' and no usable event payload.`,
      'The audited commit range could not be derived, so this gate would check NOTHING.',
      'Refusing to pass vacuously — wire the event through or run this outside CI.',
    ]);
  }

  // Local run: audit whatever is ahead of the trunk.
  for (const base of ['origin/main', 'main']) {
    if (git(['rev-parse', '--verify', '--quiet', base], { allowFail: true })) {
      const mergeBase = git(['merge-base', base, 'HEAD'], { allowFail: true });
      if (mergeBase) return { from: mergeBase, to: 'HEAD', label: `local ${base}..HEAD` };
    }
  }
  return { skip: true, reason: 'no origin/main or main ref in this clone (local run)' };
}

function commitsIn(range) {
  const spec = range.single ? [range.to, '-1'] : [`${range.from}..${range.to}`];
  const out = git(['log', '--format=%H', ...spec], { allowFail: true });
  if (out === null) {
    fail([`git log ${range.label} failed — the range is unresolvable in this clone.`]);
  }
  return out ? out.split('\n').filter(Boolean) : [];
}

function subjectOf(sha) {
  return git(['log', '-1', '--format=%s', sha]);
}
function bodyOf(sha) {
  return git(['log', '-1', '--format=%b', sha]);
}
function filesOf(sha) {
  const out = git(['show', '--name-only', '--format=', sha], { allowFail: true }) ?? '';
  return out.split('\n').map(s => s.trim()).filter(Boolean);
}

const range = resolveRange();
if (range.skip) {
  console.log(`⚠ audit-eval-regressions: skipped — ${range.reason}. CI enforces this gate.`);
  process.exit(0);
}

const commits = commitsIn(range);
const violations = [];
const exemptions = [];

for (const sha of commits) {
  const subject = subjectOf(sha);
  if (!/^fix\(/.test(subject)) continue;
  const files = filesOf(sha);
  const touchedWatched = files.filter(f => WATCHED_PREFIXES.some(p => f.startsWith(p)));
  if (touchedWatched.length === 0) continue;
  const touchedTest = files.some(f => TEST_PREFIXES.some(p => f.startsWith(p)) || /\.test\.ts$/.test(f));
  const exemption = bodyOf(sha).match(/\[no-eval:\s*([^\]]+)\]/i);
  if (touchedTest) continue;
  if (exemption) {
    exemptions.push({ sha: sha.slice(0, 8), subject, reason: exemption[1].trim() });
    continue;
  }
  violations.push({ sha: sha.slice(0, 8), subject, files: touchedWatched });
}

if (exemptions.length > 0) {
  console.log(`⚠ audit-eval-regressions: ${exemptions.length} [no-eval:] exemption(s) in ${range.label}:`);
  for (const e of exemptions) console.log(`    ${e.sha} ${e.subject}  — ${e.reason}`);
}

if (exemptions.length > MAX_EXEMPTIONS) {
  fail([
    `${exemptions.length} [no-eval:] exemptions in ${range.label} (ceiling ${MAX_EXEMPTIONS}).`,
    'The escape hatch is being used as the normal path. Add the missing cases',
    'rather than raising the ceiling.',
  ]);
}

if (violations.length > 0) {
  console.error(`✗ audit-eval-regressions: ${violations.length} fix commit(s) in ${range.label} landed with no test:`);
  for (const v of violations) {
    console.error(`    ${v.sha} ${v.subject}`);
    for (const f of v.files.slice(0, 6)) console.error(`        ${f}`);
  }
  console.error('');
  console.error('A fix to the agent / PMS / ingestion code must also touch one of:');
  for (const p of TEST_PREFIXES) console.error(`    ${p}`);
  console.error('');
  console.error('Every bug that shipped once can ship again. The case you add now is the');
  console.error('only thing that stops it. If a test genuinely cannot express the fix, put');
  console.error('`[no-eval: <reason>]` in the commit body — it is counted, not free.');
  process.exit(1);
}

console.log(
  `✓ audit-eval-regressions: ${commits.length} commit(s) audited in ${range.label}; ` +
  `every agent/PMS fix carries a test${exemptions.length ? ` (${exemptions.length} exemption(s))` : ''}.`,
);
