/**
 * Tests for the recursive log-redaction net in cua-service/src/log.ts.
 *
 * The redaction net is a defense-in-depth safety layer: callers are
 * already supposed to avoid putting credentials/secrets into log context.
 * The net catches accidental slips. These tests pin the invariants so a
 * future change to the scrubber can't quietly weaken any of them.
 *
 * Pure-function tests — no DB, no network. The log module reads
 * NODE_ENV/etc. from `env`, so the test sets env vars before import.
 */

// Required env BEFORE the import — env.ts parses at module load.
process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? 'placeholder-service-role-key-min-20-chars';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? 'sk-ant-placeholder-for-tests';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { __test__ } from '../log.js';

const { scrubString, scrubContext, capLine } = __test__;

describe('scrubString — value patterns', () => {
  test('redacts a full-length Anthropic API key', () => {
    const leaked = 'failed with key sk-ant-api03-abcDEF12345678_xyz0987-_QWERTYUIOP-abcdef-aaaaa-bbbb';
    const out = scrubString(leaked);
    assert.ok(out.includes('<redacted:anthropic_key>'), `expected redaction marker, got: ${out}`);
    assert.ok(!out.includes('sk-ant-api03-abcDEF'), 'raw key prefix must not survive');
  });

  test('redacts a JWT-shaped Bearer header', () => {
    const leaked = 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9FYR3WjEqx5pE';
    const out = scrubString(leaked);
    // Either bearer or jwt pattern should fire (the bearer pattern wins
    // because it matches first); both are acceptable redactions.
    assert.ok(/<redacted:(bearer|jwt)>/.test(out), `expected redaction marker, got: ${out}`);
    assert.ok(!out.includes('eyJhbGciOiJIUzI1NiJ9'), 'JWT body must not survive');
  });

  test('preserves a benign string with no patterns', () => {
    const safe = 'cua_posture: enforce/enforce/true workerId=fly-iad-abc123';
    assert.equal(scrubString(safe), safe);
  });

  test('preserves short job-id-looking strings (no false positive on UUIDs)', () => {
    const safe = 'jobId=018f3c4d-1234-7abc-9def-0123456789ab status=running';
    assert.equal(scrubString(safe), safe);
  });
});

describe('scrubContext — key-name deny-list', () => {
  test('redacts top-level password/token/authorization/cookie/secret', () => {
    const out = scrubContext({
      jobId: 'j1',
      password: 'p4ss',
      token: 'abc',
      authorization: 'Bearer x',
      cookie: 'sid=xyz',
      secret: 's',
    });
    assert.equal((out as Record<string, unknown>).jobId, 'j1', 'benign key survives');
    assert.equal((out as Record<string, unknown>).password, '<redacted:key>');
    assert.equal((out as Record<string, unknown>).token, '<redacted:key>');
    assert.equal((out as Record<string, unknown>).authorization, '<redacted:key>');
    assert.equal((out as Record<string, unknown>).cookie, '<redacted:key>');
    assert.equal((out as Record<string, unknown>).secret, '<redacted:key>');
  });

  test('redacts nested password (depth ≥ 1)', () => {
    const out = scrubContext({
      jobId: 'j1',
      err: { name: 'AuthError', message: 'bad creds', context: { password: 'p4ss' } },
    });
    const err = (out as Record<string, unknown>).err as Record<string, unknown>;
    const nested = err.context as Record<string, unknown>;
    assert.equal(nested.password, '<redacted:key>');
    assert.equal(err.message, 'bad creds');
  });

  test('redacts ca_password / ca_username (legacy scraper schema names)', () => {
    const out = scrubContext({ ca_username: 'admin', ca_password: 'p4ss' });
    assert.equal((out as Record<string, unknown>).ca_username, '<redacted:key>');
    assert.equal((out as Record<string, unknown>).ca_password, '<redacted:key>');
  });

  test('does NOT redact plain `username` (benign telemetry preserved)', () => {
    const out = scrubContext({ username: 'staxis-admin' });
    assert.equal((out as Record<string, unknown>).username, 'staxis-admin');
  });

  test('handles a real Error object — message + stack scrubbed', () => {
    const err = new Error('login with sk-ant-api03-abcDEF12345678_xyz0987-_QWERTYUIOP-aaaaa-bbbb failed');
    const out = scrubContext({ err });
    const scrubbedErr = (out as Record<string, unknown>).err as Record<string, unknown>;
    assert.equal(scrubbedErr.name, 'Error');
    assert.ok(typeof scrubbedErr.message === 'string');
    assert.ok((scrubbedErr.message as string).includes('<redacted:anthropic_key>'));
    assert.ok(!(scrubbedErr.message as string).includes('sk-ant-api03-abcDEF'));
  });

  test('depth limit prevents stack-overflow on cycles', () => {
    interface Cyclic { self?: Cyclic; jobId?: string }
    const cyclic: Cyclic = { jobId: 'j1' };
    cyclic.self = cyclic;
    const out = scrubContext(cyclic as unknown as Record<string, unknown>);
    assert.equal((out as Record<string, unknown>).jobId, 'j1');
    // self either gets cycle-marked or depth-cut — both are acceptable.
    const selfOut = (out as Record<string, unknown>).self;
    assert.ok(
      selfOut === '<redacted:cycle>' || (typeof selfOut === 'object' && selfOut !== null),
      'cycle handled without throwing',
    );
  });

  test('drops functions / symbols from logged context', () => {
    const out = scrubContext({ jobId: 'j1', fn: () => 'no', sym: Symbol('x') } as unknown as Record<string, unknown>);
    assert.equal((out as Record<string, unknown>).jobId, 'j1');
    assert.equal((out as Record<string, unknown>).fn, undefined);
    assert.equal((out as Record<string, unknown>).sym, undefined);
  });
});

describe('capLine — 16 KiB truncation', () => {
  test('passes through a small line unchanged', () => {
    const line = JSON.stringify({ jobId: 'j1', step: 'running' });
    assert.equal(capLine(line), line);
  });

  test('truncates a line larger than 16 KiB and marks it', () => {
    const huge = 'x'.repeat(20 * 1024);
    const out = capLine(huge);
    assert.ok(Buffer.byteLength(out, 'utf8') <= 16 * 1024, 'output stays within cap');
    assert.ok(out.endsWith('<redacted:line_truncated>'), 'marker appended');
  });
});
