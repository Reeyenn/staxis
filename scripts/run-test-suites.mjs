#!/usr/bin/env node
// ─── Run every test suite, always, and fail if any of them failed ───────────
//
// `npm test` used to be `test:server && test:client`, and `test:server` itself
// ended in `&& npm run test:integration`. That chain hid an entire suite.
//
// What it cost: on 2026-08-06 a date-dependent unit test went red at midnight
// UTC. From that minute the `&&` short-circuited and the integration suite —
// every *.integration.test.ts, the pglite-backed ones that cover authorization
// scope, portfolio leakage and money invariants — did not run AT ALL. Nothing
// said so. The summary still ended "# fail 1", which reads like one small
// problem rather than "one small problem, and 1,503 tests you did not run."
// A second, unrelated failure sat behind it undetected until the first was
// fixed.
//
// So the rule here is: a failure in one suite must never decide whether
// another suite runs. Every suite runs, every result is reported, and the exit
// code is the OR of all of them.
//
// Suites run SEQUENTIALLY on purpose, not in parallel: they share one pglite
// test database, and overlapping runs corrupt each other's fixtures.

import { spawnSync } from 'node:child_process';

/** Every suite `npm test` is responsible for, in the order they should run. */
const SUITES = [
  { name: 'server', script: 'test:server' },
  { name: 'integration', script: 'test:integration' },
  { name: 'client', script: 'test:client' },
];

const results = [];

for (const suite of SUITES) {
  process.stdout.write(`\n─── running ${suite.name} suite (npm run ${suite.script}) ───\n`);
  const run = spawnSync('npm', ['run', suite.script], {
    stdio: 'inherit',
    // Windows needs the shell to resolve `npm`; harmless elsewhere.
    shell: process.platform === 'win32',
  });
  // A suite killed by a signal (OOM, Ctrl-C) has a null status. That is a
  // failure, not a pass — never let it read as 0.
  const code = run.status === null ? 1 : run.status;
  results.push({
    ...suite,
    code,
    signal: run.signal ?? null,
    error: run.error ? run.error.message : null,
  });
}

const failed = results.filter((result) => result.code !== 0);

process.stdout.write('\n─── suite results ───\n');
for (const result of results) {
  const detail = result.signal
    ? ` (killed by ${result.signal})`
    : result.error
      ? ` (${result.error})`
      : '';
  process.stdout.write(
    `${result.code === 0 ? 'PASS' : 'FAIL'}  ${result.name}${detail}\n`,
  );
}

if (failed.length > 0) {
  process.stdout.write(
    `\n${failed.length} of ${results.length} suites failed: `
    + `${failed.map((result) => result.name).join(', ')}\n`,
  );
  process.exit(1);
}

process.stdout.write(`\nall ${results.length} suites passed\n`);
