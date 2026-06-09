/**
 * Tests for the 2026-06-09 2FA wiring + model-upgrade safety rails.
 *
 * 1. `$auth_code` substitution in executeVisionAction('type'):
 *    - With an active authCode, the REAL digits hit the page while the
 *      conversation-facing output and the recorded step only ever see
 *      the placeholder / a mask. (Same secrecy contract as $username /
 *      $password — a one-time code must never enter the Claude
 *      conversation, the live admin broadcast, or the saved playbook.)
 *    - Without an active authCode (no 2FA in flight), the literal
 *      string is typed — substitution must not be spoofable by the
 *      model outside an MFA window.
 *    - A model echoing the raw digits back still gets masked+recorded
 *      as the placeholder (defensive echo check).
 *
 * 2. computeCostMicros pricing fail-safe:
 *    - Known models bill at their real rates (opus-4-8 = $5/$25 — the
 *      table previously priced opus 3x high and that skewed every cap).
 *    - UNKNOWN models bill at the most-expensive known rates instead of
 *      $0 — $0 would blind every cost cap after a model rename.
 */

import './_bootstrap-env.js';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { executeVisionAction, type VisionAction } from '../browser-tool-vision.js';
import { computeCostMicros } from '../usage-pricing.js';
import type { PMSCredentials } from '../types.js';

const CREDS: PMSCredentials = {
  loginUrl: 'https://pms.example.com/login',
  username: 'frontdesk@hotel.com',
  password: 'hunter2-real',
};

/** Minimal Page fake: just what the 'type' path touches. */
function fakePage(typed: string[]): Page {
  return {
    viewportSize: () => ({ width: 1280, height: 800 }),
    evaluate: async () => undefined,
    keyboard: {
      type: async (text: string) => { typed.push(text); },
    },
  } as unknown as Page;
}

const typeAction = (text: string): VisionAction =>
  ({ action: 'type', text }) as unknown as VisionAction;

describe('$auth_code substitution (2FA secrecy contract)', () => {
  test('substitutes the real code at the page, masks everywhere else', async () => {
    const typed: string[] = [];
    const res = await executeVisionAction(fakePage(typed), typeAction('$auth_code'), CREDS, 'login', {
      authCode: '482913',
    });

    assert.deepEqual(typed, ['482913'], 'the page must receive the real digits');
    assert.equal(res.isError ?? false, false);
    assert.ok(!res.output.includes('482913'), `output must not leak the code: ${res.output}`);
    assert.ok(res.output.includes('<verification code>'), `output masks the code: ${res.output}`);
    assert.deepEqual(res.recordedStep, { kind: 'type_text', value: '$auth_code' });
  });

  test('without an active code, the literal placeholder is typed (not spoofable)', async () => {
    const typed: string[] = [];
    const res = await executeVisionAction(fakePage(typed), typeAction('$auth_code'), CREDS, 'login');

    assert.deepEqual(typed, ['$auth_code'], 'no substitution outside an MFA window');
    assert.deepEqual(res.recordedStep, { kind: 'type_text', value: '$auth_code' });
  });

  test('model echoing the raw digits still records the placeholder', async () => {
    const typed: string[] = [];
    const res = await executeVisionAction(fakePage(typed), typeAction('482913'), CREDS, 'login', {
      authCode: '482913',
    });

    assert.deepEqual(typed, ['482913']);
    assert.ok(!res.output.includes('482913'), `echoed code must be masked: ${res.output}`);
    assert.deepEqual(res.recordedStep, { kind: 'type_text', value: '$auth_code' });
  });

  test('username/password placeholders still work alongside authCode', async () => {
    const typed: string[] = [];
    const res = await executeVisionAction(fakePage(typed), typeAction('$password'), CREDS, 'login', {
      authCode: '482913',
    });

    assert.deepEqual(typed, ['hunter2-real']);
    assert.ok(!res.output.includes('hunter2-real'));
    assert.deepEqual(res.recordedStep, { kind: 'type_text', value: '$password' });
  });
});

describe('computeCostMicros pricing fail-safe', () => {
  const usage = {
    input_tokens: 1_000_000,
    output_tokens: 100_000,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };

  test('opus-4-8 bills at $5/$25 per MTok', () => {
    // 1M input * $5 + 0.1M output * $25 = $7.50 = 7_500_000 micros
    assert.equal(computeCostMicros(usage, 'claude-opus-4-8'), 7_500_000);
  });

  test('sonnet-4-6 bills at $3/$15 per MTok', () => {
    // 1M * $3 + 0.1M * $15 = $4.50
    assert.equal(computeCostMicros(usage, 'claude-sonnet-4-6'), 4_500_000);
  });

  test('UNKNOWN model bills at the most expensive known rates, never $0', () => {
    const cost = computeCostMicros(usage, 'claude-omega-9');
    // fable-5 rates: 1M * $10 + 0.1M * $50 = $15
    assert.equal(cost, 15_000_000);
    assert.ok(cost > 0, 'a $0 fallback would blind every cost cap');
  });
});
