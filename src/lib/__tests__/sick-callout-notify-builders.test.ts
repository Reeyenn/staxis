/**
 * Tests for the SMS body builders used by the notification fanout.
 *
 * Run via: npx tsx --test src/lib/__tests__/sick-callout-notify-builders.test.ts
 *
 * Pure functions — the actual sendSms calls aren't covered here (they're
 * end-to-end Twilio plumbing tested separately). The bodies are what
 * a real housekeeper / manager will see on their phone, so getting
 * them right matters more than the wire path.
 */

import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
// Import from sms-bodies (the pure-function module) rather than notify.ts —
// notify.ts pulls in @/lib/sms → @sentry/nextjs which has a module-load
// side effect that hangs the Node test runner under tsx.
import {
  buildPickupSms,
  buildRevertSms,
} from '../sick-callout/sms-bodies';

describe('buildPickupSms', () => {
  test('English with single room', () => {
    const body = buildPickupSms('Maria', ['308'], 7, 'en');
    assert.match(body, /Maria called out/);
    assert.match(body, /room.*308/i);
    assert.match(body, /total: 7/);
  });
  test('Spanish with multiple rooms', () => {
    const body = buildPickupSms('Maria', ['308', '412'], 14, 'es');
    assert.match(body, /Maria/);
    assert.match(body, /308/);
    assert.match(body, /412/);
    assert.match(body, /14/);
  });
  test('strips control characters', () => {
    const body = buildPickupSms('Eve\n<script>', ['101'], 5, 'en');
    assert.ok(!body.includes('\n'));
  });
  test('Spanish uses Spanish phrasing', () => {
    const body = buildPickupSms('Maria', ['101'], 5, 'es');
    assert.match(body, /enfermo|enferma|recogiste/i);
  });
});

describe('buildRevertSms', () => {
  test('English revert message', () => {
    const body = buildRevertSms('Maria', 'en');
    assert.match(body, /Maria/);
    assert.match(body, /reverted|back to normal/i);
  });
  test('Spanish revert message', () => {
    const body = buildRevertSms('Maria', 'es');
    assert.match(body, /Maria/);
    assert.match(body, /canceló|normalidad/i);
  });
});
