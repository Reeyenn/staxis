/**
 * Regression test for the `storage_buckets_private` doctor check
 * (audit-02 F-04). The check iterates a hardcoded allow-list of
 * buckets that must be private and warns/fails when any is missing
 * or public. This test asserts the allow-list still contains the
 * known PII-holding buckets — a future code edit that drops one
 * silently would regress the alarm.
 *
 * Why static-text check: the check function is defined inline in
 * src/app/api/admin/doctor/route.ts (not exported), and the
 * function depends on supabaseAdmin.storage which requires a live
 * connection. Source-text inspection is a lighter regression gate
 * that proves the allow-list stays correct without spinning up
 * Supabase mocks. Pair with the doctor's own runtime warn on
 * missing buckets (post-deploy-smoke-test).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DOCTOR_SRC = readFileSync(
  resolve(__dirname, '../../app/api/admin/doctor/route.ts'),
  'utf8',
);

describe('doctor: storage_buckets_private', () => {
  test('PRIVATE_BUCKETS includes voice-recordings', () => {
    assert.match(DOCTOR_SRC, /['"]voice-recordings['"]/);
  });

  test('PRIVATE_BUCKETS includes invoices', () => {
    assert.match(DOCTOR_SRC, /['"]invoices['"]/);
  });

  test('PRIVATE_BUCKETS includes inventory-counts', () => {
    assert.match(DOCTOR_SRC, /['"]inventory-counts['"]/);
  });

  test('PRIVATE_BUCKETS includes maintenance-photos', () => {
    assert.match(DOCTOR_SRC, /['"]maintenance-photos['"]/);
  });

  test('check is registered in the runtime registry', () => {
    assert.match(DOCTOR_SRC, /['"]storage_buckets_private['"]\s*,\s*checkStorageBucketsPrivate/);
  });

  test('check function exists and calls getBucket', () => {
    assert.match(DOCTOR_SRC, /function checkStorageBucketsPrivate/);
    assert.match(DOCTOR_SRC, /storage\.getBucket\(/);
  });

  test('check fails on public bucket (not just warns)', () => {
    // The fix path must return status:'fail' when bucket.public===true,
    // otherwise a Studio toggle could go unnoticed in post-deploy smoke.
    // Match the relevant slice of the check body.
    const checkBody = DOCTOR_SRC.match(
      /function checkStorageBucketsPrivate[\s\S]*?\n\}\n/,
    );
    assert.ok(checkBody, 'checkStorageBucketsPrivate function body not found');
    assert.match(checkBody![0], /public === true|public\s*===\s*true/);
    assert.match(checkBody![0], /status:\s*['"]fail['"]/);
  });
});
