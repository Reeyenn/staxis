/**
 * Regression test for /api/cron/webhook-dedup-purge column fix
 * (audit-02 D-01).
 *
 * Background: the original ship passed `.select('1')` — '1' isn't a
 * real column on any of the three target tables, so PostgREST returned
 * an error and the count metric was always -1 (logged as "delete
 * failed"). The fix uses each table's PK column:
 *   processed_twilio_webhooks → message_sid
 *   processed_sentry_webhooks → event_id
 *   stripe_processed_events   → event_id
 *
 * This test reads the route source and pins those column mappings so
 * future edits can't regress to the broken `.select('1')` shape.
 * A live integration test would require a seeded Supabase instance;
 * source-text inspection is the lighter regression gate that prevents
 * the specific bug class from reappearing.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROUTE_SRC = readFileSync(
  resolve(__dirname, '../../app/api/cron/webhook-dedup-purge/route.ts'),
  'utf8',
);

// Strip block + line comments so regex assertions only see active code.
// The route's own comment narrates the old broken `.select('1')` call —
// a naive match would false-positive on the explanatory text.
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const ROUTE_CODE = stripComments(ROUTE_SRC);

describe('webhook-dedup-purge column mapping', () => {
  test('does not select the literal "1" column (regression of audit-02 ship bug)', () => {
    assert.doesNotMatch(ROUTE_CODE, /\.select\(\s*['"]1['"]\s*\)/);
  });

  test('processed_twilio_webhooks → message_sid', () => {
    assert.match(
      ROUTE_SRC,
      /purge\(\s*['"]processed_twilio_webhooks['"]\s*,\s*['"]message_sid['"]/,
    );
  });

  test('processed_sentry_webhooks → event_id', () => {
    assert.match(
      ROUTE_SRC,
      /purge\(\s*['"]processed_sentry_webhooks['"]\s*,\s*['"]event_id['"]/,
    );
  });

  test('stripe_processed_events → event_id', () => {
    assert.match(
      ROUTE_SRC,
      /purge\(\s*['"]stripe_processed_events['"]\s*,\s*['"]event_id['"]/,
    );
  });

  test('purge helper accepts (table, countColumn) and forwards countColumn', () => {
    assert.match(
      ROUTE_SRC,
      /function purge\(\s*table:\s*string\s*,\s*countColumn:\s*string/,
    );
    assert.match(ROUTE_SRC, /\.select\(\s*countColumn\s*\)/);
  });

  test('cron is auth-gated by requireCronSecret', () => {
    assert.match(ROUTE_SRC, /requireCronSecret/);
  });
});
