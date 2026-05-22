/**
 * Tests for scraper-staleness helper (Phase E2E, 2026-05-22).
 *
 * The helper drives both the watchdog cron (scraper-health/route.ts) AND
 * the new System Status admin panel. Drift between thresholds = the alerts
 * Reeyen gets via SMS would no longer match what the panel shows him.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DASHBOARD_STALE_MIN,
  HEARTBEAT_DEAD_MIN,
  classifyScraperHeartbeat,
  minutesAgo,
  parseScraperDate,
} from '../scraper-staleness';

const ONE_MIN_MS = 60_000;

describe('parseScraperDate', () => {
  it('parses ISO strings', () => {
    const d = parseScraperDate('2026-05-22T18:30:00Z');
    assert.ok(d instanceof Date);
    assert.equal(d?.toISOString(), '2026-05-22T18:30:00.000Z');
  });
  it('accepts Date instances', () => {
    const input = new Date('2026-05-22T18:30:00Z');
    const out = parseScraperDate(input);
    assert.equal(out?.getTime(), input.getTime());
  });
  it('returns null for null/undefined/garbage', () => {
    assert.equal(parseScraperDate(null), null);
    assert.equal(parseScraperDate(undefined), null);
    assert.equal(parseScraperDate('not-a-date'), null);
    assert.equal(parseScraperDate({}), null);
    assert.equal(parseScraperDate(12345), null);
  });
});

describe('minutesAgo', () => {
  it('computes minute delta', () => {
    const now = Date.now();
    const past = new Date(now - 5 * ONE_MIN_MS);
    assert.equal(minutesAgo(past, now), 5);
  });
  it('returns null when date is null', () => {
    assert.equal(minutesAgo(null, Date.now()), null);
  });
});

describe('classifyScraperHeartbeat', () => {
  const nowMs = Date.parse('2026-05-22T20:00:00Z');

  it('reports red when no heartbeat row exists', () => {
    const r = classifyScraperHeartbeat({ heartbeatAt: null, pulledAt: null, nowMs });
    assert.equal(r.status, 'red');
    assert.match(r.message, /never reported/);
    assert.equal(r.heartbeatMinutesAgo, null);
  });

  it(`reports red when heartbeat is older than ${HEARTBEAT_DEAD_MIN} min`, () => {
    const heartbeatAt = new Date(nowMs - (HEARTBEAT_DEAD_MIN + 5) * ONE_MIN_MS).toISOString();
    const pulledAt = new Date(nowMs - 10 * ONE_MIN_MS).toISOString();
    const r = classifyScraperHeartbeat({ heartbeatAt, pulledAt, nowMs });
    assert.equal(r.status, 'red');
    assert.match(r.message, /heartbeat .* min stale/);
    assert.equal(r.heartbeatMinutesAgo, HEARTBEAT_DEAD_MIN + 5);
  });

  it(`reports yellow when heartbeat fresh but pull is older than ${DASHBOARD_STALE_MIN} min`, () => {
    const heartbeatAt = new Date(nowMs - 2 * ONE_MIN_MS).toISOString();
    const pulledAt = new Date(nowMs - (DASHBOARD_STALE_MIN + 10) * ONE_MIN_MS).toISOString();
    const r = classifyScraperHeartbeat({ heartbeatAt, pulledAt, nowMs });
    assert.equal(r.status, 'yellow');
    assert.match(r.message, /pull is .* min stale/);
    assert.equal(r.pulledMinutesAgo, DASHBOARD_STALE_MIN + 10);
  });

  it('reports green when both heartbeat and pull are fresh', () => {
    const heartbeatAt = new Date(nowMs - 2 * ONE_MIN_MS).toISOString();
    const pulledAt = new Date(nowMs - 10 * ONE_MIN_MS).toISOString();
    const r = classifyScraperHeartbeat({ heartbeatAt, pulledAt, nowMs });
    assert.equal(r.status, 'green');
    assert.match(r.message, /Last pull 10 min ago/);
  });

  it('reports green when heartbeat fresh and pulledAt is missing (no pulls yet)', () => {
    const heartbeatAt = new Date(nowMs - 1 * ONE_MIN_MS).toISOString();
    const r = classifyScraperHeartbeat({ heartbeatAt, pulledAt: null, nowMs });
    assert.equal(r.status, 'green');
    assert.match(r.message, /Heartbeat fresh/);
    assert.equal(r.pulledMinutesAgo, null);
  });

  it('boundary: heartbeat exactly at the dead threshold counts as alive (>, not >=)', () => {
    // Watchdog uses strict > comparison, so HEARTBEAT_DEAD_MIN exactly = still green.
    const heartbeatAt = new Date(nowMs - HEARTBEAT_DEAD_MIN * ONE_MIN_MS).toISOString();
    const pulledAt = new Date(nowMs - 5 * ONE_MIN_MS).toISOString();
    const r = classifyScraperHeartbeat({ heartbeatAt, pulledAt, nowMs });
    assert.equal(r.status, 'green');
  });
});
