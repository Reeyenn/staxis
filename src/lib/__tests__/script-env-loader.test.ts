// ─── scripts/load-env ─────────────────────────────────────────────────────
// Regression cover for the bug that kept `agent_eval_baselines` empty forever:
// the eval CLIs used `dotenv/config`, which reads `.env`. This repo only ever
// has `.env.local`, so nothing loaded, and every eval script exited on its own
// "missing env" guard before running a case. The bank looked untouched and
// nobody could tell that apart from "nobody ran it".
//
// The load-order test below is the one that matters: it fails if the loader
// ever stops preferring `.env.local`.

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseEnvFile, loadEnv } from '../../../scripts/load-env';

describe('parseEnvFile', () => {
  test('reads plain KEY=value pairs', () => {
    assert.deepEqual(parseEnvFile('A=1\nB=two'), { A: '1', B: 'two' });
  });

  test('skips comments, blank lines, and lines with no "="', () => {
    const parsed = parseEnvFile('# a comment\n\n   \nJUST_A_WORD\nA=1\n');
    assert.deepEqual(parsed, { A: '1' });
  });

  test('keeps "=" that appears inside the value', () => {
    // Base64 keys and Postgres URLs both hit this — splitting on every "="
    // would silently truncate a service-role key.
    const parsed = parseEnvFile('KEY=abc=def==\nURL=postgres://u:p@h/db?x=1');
    assert.equal(parsed.KEY, 'abc=def==');
    assert.equal(parsed.URL, 'postgres://u:p@h/db?x=1');
  });

  test('strips surrounding quotes and unescapes \\n inside them', () => {
    const parsed = parseEnvFile('A="line1\\nline2"\nB=\'single\'');
    assert.equal(parsed.A, 'line1\nline2');
    assert.equal(parsed.B, 'single');
  });

  test('leaves an unquoted value literal', () => {
    assert.equal(parseEnvFile('A=no\\nescape').A, 'no\\nescape');
  });

  test('tolerates a pasted "export " prefix', () => {
    assert.deepEqual(parseEnvFile('export A=1'), { A: '1' });
  });

  test('ignores a line whose key is empty', () => {
    assert.deepEqual(parseEnvFile('=orphan\nA=1'), { A: '1' });
  });
});

describe('loadEnv', () => {
  const created: string[] = [];
  const touchedKeys = new Set<string>();

  function sandbox(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'staxis-loadenv-'));
    created.push(dir);
    // findRepoRoot walks up looking for package.json — give it one.
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    for (const [name, contents] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), contents);
    }
    return dir;
  }

  function track(...keys: string[]): void {
    for (const k of keys) touchedKeys.add(k);
  }

  afterEach(() => {
    for (const k of touchedKeys) delete process.env[k];
    touchedKeys.clear();
    for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  test('reads .env.local — the file this repo actually has', () => {
    track('LOADENV_LOCAL_ONLY');
    const dir = sandbox({ '.env.local': 'LOADENV_LOCAL_ONLY=from-local' });
    const loaded = loadEnv(dir);
    assert.equal(process.env.LOADENV_LOCAL_ONLY, 'from-local');
    assert.equal(loaded.length, 1);
  });

  test('.env.local wins over .env for the same key', () => {
    track('LOADENV_BOTH');
    const dir = sandbox({
      '.env.local': 'LOADENV_BOTH=local',
      '.env': 'LOADENV_BOTH=plain',
    });
    loadEnv(dir);
    assert.equal(process.env.LOADENV_BOTH, 'local');
  });

  test('still reads .env for keys .env.local does not define', () => {
    track('LOADENV_ONLY_IN_PLAIN');
    const dir = sandbox({ '.env.local': 'OTHER=x', '.env': 'LOADENV_ONLY_IN_PLAIN=plain' });
    track('OTHER');
    loadEnv(dir);
    assert.equal(process.env.LOADENV_ONLY_IN_PLAIN, 'plain');
  });

  test('never clobbers a variable already in process.env', () => {
    // CI secrets and `FOO=bar npm run …` must beat whatever is on disk.
    track('LOADENV_PREEXISTING');
    process.env.LOADENV_PREEXISTING = 'from-shell';
    const dir = sandbox({ '.env.local': 'LOADENV_PREEXISTING=from-file' });
    loadEnv(dir);
    assert.equal(process.env.LOADENV_PREEXISTING, 'from-shell');
  });

  test('finds the env file from a subdirectory (scripts/ run from anywhere)', () => {
    track('LOADENV_FROM_SUBDIR');
    const dir = sandbox({ '.env.local': 'LOADENV_FROM_SUBDIR=found' });
    const sub = path.join(dir, 'scripts', 'nested');
    fs.mkdirSync(sub, { recursive: true });
    loadEnv(sub);
    assert.equal(process.env.LOADENV_FROM_SUBDIR, 'found');
  });

  test('reports no files when there is nothing to load, rather than throwing', () => {
    const dir = sandbox({});
    assert.deepEqual(loadEnv(dir), []);
  });
});
