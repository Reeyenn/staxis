/**
 * Tests for cua-service/src/policy.ts.
 *
 * Plan v2 F-AI-7 (CUA action allowlist). The deterministic policy layer
 * between Claude's emitted tool_use and Playwright execution. These
 * tests pin the invariants that turn a prompt-injecting PMS page from
 * "agent does what the page says" into "agent's writes refused by
 * deterministic gate."
 *
 * Pure-function tests — no Playwright, no Anthropic, no DB.
 */

// Required env BEFORE the import (policy.ts pulls env.ts which validates).
process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder-for-tests';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { allowAction, policyMode } from '../policy.js';
import type { BrowserAction } from '../browser-tool.js';

describe('policy.allowAction — read-only actions always allowed', () => {
  const reads: BrowserAction[] = [
    { action: 'screenshot' },
    { action: 'read_page' },
    { action: 'get_page_text' },
    { action: 'find', text: 'login' },
    { action: 'wait', duration: 1 },
    { action: 'scroll', scroll_direction: 'down', scroll_amount: 3 },
    { action: 'scroll_to', ref: 'ref_1' },
    { action: 'hover', ref: 'ref_1' },
  ];
  for (const a of reads) {
    test(`${a.action} allowed in login phase`, () => {
      const d = allowAction(a, 'login', '');
      assert.equal(d.allow, true);
      assert.equal(d.rule, 'read_only');
    });
    test(`${a.action} allowed in action phase`, () => {
      const d = allowAction(a, 'action', '');
      assert.equal(d.allow, true);
      assert.equal(d.rule, 'read_only');
    });
  }
});

describe('policy.allowAction — navigate pre-check', () => {
  test('http URL allowed', () => {
    const d = allowAction({ action: 'navigate', text: 'https://app.choiceadvantage.com/login' }, 'login', '');
    assert.equal(d.allow, true);
  });
  test('javascript: scheme refused', () => {
    const d = allowAction({ action: 'navigate', text: 'javascript:alert(1)' }, 'login', '');
    assert.equal(d.allow, false);
    assert.equal(d.rule, 'navigate_scheme');
  });
  test('file: scheme refused', () => {
    const d = allowAction({ action: 'navigate', text: 'file:///etc/passwd' }, 'login', '');
    assert.equal(d.allow, false);
  });
  test('data: scheme refused', () => {
    const d = allowAction({ action: 'navigate', text: 'data:text/html,<h1>x' }, 'login', '');
    assert.equal(d.allow, false);
  });
  test('empty URL refused', () => {
    const d = allowAction({ action: 'navigate', text: '' }, 'login', '');
    assert.equal(d.allow, false);
    assert.equal(d.rule, 'navigate_empty');
  });
});

describe('policy.allowAction — login phase write rules', () => {
  test('form_input on a username field allowed (hint matches login signature)', () => {
    const d = allowAction(
      { action: 'form_input', ref: 'ref_1', value: '$username' },
      'login',
      'username input email',
    );
    assert.equal(d.allow, true);
    assert.equal(d.rule, 'login_hint_match');
  });
  test('form_input on a password field allowed', () => {
    const d = allowAction(
      { action: 'form_input', ref: 'ref_2', value: '$password' },
      'login',
      'password input pwd',
    );
    assert.equal(d.allow, true);
  });
  test('left_click on a "Sign in" button allowed', () => {
    const d = allowAction(
      { action: 'left_click', ref: 'ref_3' },
      'login',
      'Sign In button submit',
    );
    assert.equal(d.allow, true);
  });
  test('left_click on a "Continue" button allowed (welcome splash)', () => {
    const d = allowAction(
      { action: 'left_click', ref: 'ref_4' },
      'login',
      'Continue button',
    );
    assert.equal(d.allow, true);
  });
  test('form_input on a non-login field refused (hint mismatch)', () => {
    const d = allowAction(
      { action: 'form_input', ref: 'ref_5', value: '$password' },
      'login',
      'share_email input',
    );
    assert.equal(d.allow, false);
    assert.match(d.rule, /login_hint_mismatch/);
  });
  test('left_click on a "Delete reservation" button refused', () => {
    const d = allowAction(
      { action: 'left_click', ref: 'ref_6' },
      'login',
      'Delete reservation button danger',
    );
    assert.equal(d.allow, false);
  });
  test('type (no ref hint) allowed in login (matches recorded "click then type" flow)', () => {
    const d = allowAction({ action: 'type', text: '$username' }, 'login', '');
    assert.equal(d.allow, true);
    assert.equal(d.rule, 'login_no_hint');
  });
});

describe('policy.allowAction — action phase refuses all writes', () => {
  const writes: BrowserAction[] = [
    { action: 'type', text: 'hello' },
    { action: 'key', text: 'Enter' },
    { action: 'form_input', ref: 'ref_1', value: 'x' },
    { action: 'left_click', ref: 'ref_2' },
    { action: 'double_click', ref: 'ref_3' },
  ];
  for (const a of writes) {
    test(`${a.action} refused after login`, () => {
      const d = allowAction(a, 'action', 'Sign In button');
      assert.equal(d.allow, false);
      assert.match(d.rule, /_after_login$/);
    });
  }
});

describe('policy.policyMode — default warn', () => {
  test('mode is "warn" when CUA_POLICY_ENFORCE is unset', () => {
    // env.ts caches the parsed value at module load; we don't reset it
    // here. Default per the schema is 'warn'.
    assert.equal(policyMode(), 'warn');
  });
});
