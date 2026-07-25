/**
 * The two doctor signals that tell you the quality ratchet is turning.
 *
 * Both exist because of a specific silence: agent_eval_baselines had ZERO rows
 * in production, meaning the live eval bank had either never run or had been
 * failing its baseline write behind a console.warn — and nothing anywhere said
 * so. "Nobody ran it" must not look like "everything is fine".
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  evalBankFreshnessVerdict,
  evalBankIncidentVerdict,
  EVAL_BANK_STALE_DAYS,
} from '@/lib/agent/eval-bank-health';

const NOW = new Date('2026-07-24T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

describe('eval bank freshness', () => {
  test('an empty baseline table warns and says the bank has never recorded a run', () => {
    const v = evalBankFreshnessVerdict(null, NOW);
    assert.equal(v.status, 'warn');
    assert.match(v.detail, /EMPTY/);
    assert.match(v.fix ?? '', /agent:evals/);
  });

  test('a recent run is ok', () => {
    const v = evalBankFreshnessVerdict(daysAgo(3), NOW);
    assert.equal(v.status, 'ok');
    assert.match(v.detail, /3 day/);
  });

  test('a run exactly at the threshold is still ok', () => {
    assert.equal(evalBankFreshnessVerdict(daysAgo(EVAL_BANK_STALE_DAYS), NOW).status, 'ok');
  });

  test('a run past the threshold warns', () => {
    const v = evalBankFreshnessVerdict(daysAgo(EVAL_BANK_STALE_DAYS + 1), NOW);
    assert.equal(v.status, 'warn');
    assert.match(v.detail, new RegExp(String(EVAL_BANK_STALE_DAYS + 1)));
  });

  test('staleness never escalates to fail — the live bank is manual by design', () => {
    assert.notEqual(evalBankFreshnessVerdict(daysAgo(900), NOW).status, 'fail');
  });

  test('an unparseable timestamp warns rather than reporting a bogus age', () => {
    const v = evalBankFreshnessVerdict('not-a-date', NOW);
    assert.equal(v.status, 'warn');
    assert.match(v.detail, /unparseable/);
  });
});

describe('incident → eval-case coverage', () => {
  test('no uncovered reports is ok', () => {
    assert.equal(evalBankIncidentVerdict([]).status, 'ok');
  });

  test('a resolved ai_wrong report with no eval case FAILS the doctor', () => {
    const v = evalBankIncidentVerdict(['9f2c1a44-0000-4000-8000-000000000001']);
    assert.equal(v.status, 'fail', 'closing an AI-wrong report with nothing learned must fail');
    assert.match(v.detail, /9f2c1a44/);
    assert.match(v.fix ?? '', /test-bank\.ts/);
  });

  test('the detail names every uncovered report so the fix is actionable', () => {
    const ids = [
      'aaaaaaaa-0000-4000-8000-000000000001',
      'bbbbbbbb-0000-4000-8000-000000000002',
    ];
    const v = evalBankIncidentVerdict(ids);
    assert.match(v.detail, /aaaaaaaa/);
    assert.match(v.detail, /bbbbbbbb/);
    assert.match(v.detail, /^2 resolved/);
  });
});
