/**
 * Regression test for the doctor's REQUIRED_ENV_VARS list (audit-02 NEW-4).
 *
 * HEARTBEAT_SECRET gates /api/claude-heartbeat (see
 * api-auth-heartbeat-secret.test.ts for the auth helper itself).
 * If the secret is unset in production, the route returns 500 —
 * but without HEARTBEAT_SECRET in REQUIRED_ENV_VARS, the doctor
 * doesn't catch the missing var at boot; the first heartbeat POST
 * is the first signal. This test pins HEARTBEAT_SECRET to the
 * required list so future edits can't accidentally drop it.
 *
 * Source-text check (not import-time): the doctor route's
 * REQUIRED_ENV_VARS is module-private; we read the file directly
 * to assert membership without spinning the full Next runtime.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DOCTOR_SRC = readFileSync(
  resolve(__dirname, '../../app/api/admin/doctor/route.ts'),
  'utf8',
);

// Extract the REQUIRED_ENV_VARS array body so per-entry assertions
// don't false-match elsewhere in the file (e.g. checkCronSecretShape).
const REQUIRED_BODY = DOCTOR_SRC.match(
  /const REQUIRED_ENV_VARS[^=]*=\s*\[([\s\S]*?)\];/,
)?.[1] ?? '';

describe('doctor: REQUIRED_ENV_VARS', () => {
  test('list is present in source', () => {
    assert.ok(REQUIRED_BODY.length > 0, 'REQUIRED_ENV_VARS const not found');
  });

  test('includes HEARTBEAT_SECRET', () => {
    assert.match(REQUIRED_BODY, /name:\s*['"]HEARTBEAT_SECRET['"]/);
  });

  test('includes CRON_SECRET', () => {
    assert.match(REQUIRED_BODY, /name:\s*['"]CRON_SECRET['"]/);
  });

  test('includes SUPABASE_SERVICE_ROLE_KEY', () => {
    assert.match(REQUIRED_BODY, /name:\s*['"]SUPABASE_SERVICE_ROLE_KEY['"]/);
  });

  test('includes ANTHROPIC_API_KEY', () => {
    assert.match(REQUIRED_BODY, /name:\s*['"]ANTHROPIC_API_KEY['"]/);
  });

  test('includes the voice surface secrets', () => {
    assert.match(REQUIRED_BODY, /name:\s*['"]OPENAI_API_KEY['"]/);
    assert.match(REQUIRED_BODY, /name:\s*['"]ELEVENLABS_API_KEY['"]/);
    assert.match(REQUIRED_BODY, /name:\s*['"]ELEVENLABS_WEBHOOK_SECRET['"]/);
  });
});
