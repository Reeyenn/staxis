/**
 * Pure-helper tests for fix/cua-two-oracle (build #3 audit URL guard + build #4
 * cost-envelope gate). These cover the two decision functions in isolation:
 *   - normalizeUrlForAudit: which URL differences are SPURIOUS (so the audit
 *     stays verified and the detail-drill can run) vs SEMANTIC (a different feed
 *     — must NOT be treated as the same page).
 *   - structurallySoundForDiscovery: the gate for early discovery AND the cost-
 *     envelope widening. A LOST feed (no committable table) returns false, so it
 *     keeps the base per-target cost cap (the 2026-06-11 revert invariant).
 */

import './ws-polyfill.js';
import './_bootstrap-env.js';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeUrlForAudit,
  structurallySoundForDiscovery,
  type PageAudit,
} from '../mapper.js';

describe('normalizeUrlForAudit — spurious vs semantic URL differences', () => {
  const base = 'https://pms.example.com/frontdesk/departures';

  test('hash, trailing slash, and inert cache-buster/session params are stripped', () => {
    assert.equal(normalizeUrlForAudit(`${base}#section`), normalizeUrlForAudit(base));
    assert.equal(normalizeUrlForAudit(`${base}/`), normalizeUrlForAudit(base));
    assert.equal(normalizeUrlForAudit(`${base}?_=1718000000`), normalizeUrlForAudit(base));
    assert.equal(normalizeUrlForAudit(`${base}?jsessionid=ABC123`), normalizeUrlForAudit(base));
    assert.equal(normalizeUrlForAudit(`${base}?nocache=1&csrf=xyz`), normalizeUrlForAudit(base));
    assert.equal(normalizeUrlForAudit(`${base}?ts=1718000000`), normalizeUrlForAudit(base));
  });

  test('a weak generic param is inert ONLY when cache-buster-shaped (≥6-digit epoch / float)', () => {
    // t=1718000000 (epoch) → inert (stripped). t=2 (a tab selector) and
    // t=arrivals (a word) are SEMANTIC and MUST be kept — arrivals vs departures
    // are often distinguished by exactly such a small param.
    assert.equal(normalizeUrlForAudit(`${base}?t=1718000000`), normalizeUrlForAudit(base));
    assert.notEqual(normalizeUrlForAudit(`${base}?t=2`), normalizeUrlForAudit(base));
    assert.notEqual(normalizeUrlForAudit(`${base}?t=arrivals`), normalizeUrlForAudit(base));
    // ...and two pages differing only by a numeric tab selector are NOT the same.
    assert.notEqual(normalizeUrlForAudit(`${base}?v=1`), normalizeUrlForAudit(`${base}?v=2`));
  });

  test('SEMANTIC params are KEPT — arrivals and departures are NOT the same page', () => {
    const arr = 'https://pms.example.com/reservations?type=arrival';
    const dep = 'https://pms.example.com/reservations?type=departure';
    assert.notEqual(normalizeUrlForAudit(arr), normalizeUrlForAudit(dep));
  });

  test('param ORDER does not matter; a real param difference does', () => {
    assert.equal(
      normalizeUrlForAudit(`${base}?type=departure&view=list`),
      normalizeUrlForAudit(`${base}?view=list&type=departure`),
    );
    assert.notEqual(
      normalizeUrlForAudit(`${base}?type=departure`),
      normalizeUrlForAudit(`${base}?type=departure&floor=2`),
    );
  });

  test('a different PATH is never the same page', () => {
    assert.notEqual(
      normalizeUrlForAudit('https://pms.example.com/arrivals'),
      normalizeUrlForAudit('https://pms.example.com/departures'),
    );
  });
});

function mkAudit(over: Partial<PageAudit> = {}): PageAudit {
  return {
    verified: true,
    pageUrl: 'https://pms.example.com/departures',
    probeRows: [
      { pms_reservation_id: 'R1', room_number: '301' },
      { pms_reservation_id: 'R2', room_number: '302' },
      { pms_reservation_id: 'R3', room_number: '303' },
      { pms_reservation_id: 'R4', room_number: '304' },
      { pms_reservation_id: 'R5', room_number: '305' },
    ],
    totalMatched: 5,
    outstanding: new Map([['departure_date', 'dead']]),
    problems: [],
    ...over,
  };
}

describe('structurallySoundForDiscovery — early-discovery + cost-envelope gate', () => {
  test('a verified audit with a readable key + ≥MIN distinct rows is sound', () => {
    assert.equal(structurallySoundForDiscovery(mkAudit(), 'getDepartures'), true);
  });

  test('an UNVERIFIED (structural-only) audit is never sound — a LOST feed keeps the base cap', () => {
    assert.equal(
      structurallySoundForDiscovery(mkAudit({ verified: false, probeRows: [], totalMatched: 0 }), 'getDepartures'),
      false,
    );
  });

  test('the key column itself being blind/outstanding is not sound', () => {
    assert.equal(
      structurallySoundForDiscovery(mkAudit({ outstanding: new Map([['pms_reservation_id', 'dead']]) }), 'getDepartures'),
      false,
    );
  });

  test('too few matched rows is not sound', () => {
    assert.equal(structurallySoundForDiscovery(mkAudit({ totalMatched: 3 }), 'getDepartures'), false);
  });

  test('non-distinct key values (e.g. row numbers) are not sound', () => {
    const rows = [1, 2, 3, 4, 5].map(() => ({ pms_reservation_id: 'SAME', room_number: '1' }));
    assert.equal(structurallySoundForDiscovery(mkAudit({ probeRows: rows }), 'getDepartures'), false);
  });

  test('a non-core target (no key column) is not sound', () => {
    assert.equal(structurallySoundForDiscovery(mkAudit(), 'getGuestBalances'), false);
  });
});
