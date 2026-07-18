/**
 * Regression guards for resolved-but-failed auth/API operations in onboarding.
 * `fetch` and Supabase auth calls do not throw merely because they returned a
 * non-2xx/error object, so every critical transition must inspect the result.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(
  join(process.cwd(), 'src', 'app', 'onboard', 'page.tsx'),
  'utf8',
);

describe('onboarding critical response checks', () => {
  test('checks the OTP-send error before advancing', () => {
    assert.match(source, /error:\s*otpErr[\s\S]{0,120}if\s*\(otpErr\)\s*throw/);
  });

  test('requires trust-device success and a refreshed session', () => {
    assert.match(source, /requireApiSuccess\(trustRes/);
    assert.match(source, /refreshErr\s*\|\|\s*!refreshed\.session/);
  });

  test('checks email-verification persistence before clearing recovery state', () => {
    assert.match(
      source,
      /requireApiSuccess\(verifiedRes[\s\S]{0,180}sessionStorage\.removeItem\(['"]onboard:pendingEmail/,
    );
  });

  test('requires finalization success before navigating to the dashboard', () => {
    assert.match(
      source,
      /requireApiSuccess\(finalizeRes[\s\S]{0,500}window\.location\.href\s*=\s*['"]\/dashboard/,
    );
  });
});
