/**
 * Learning Board derivation tests (feature/cua-assist-board).
 *
 * deriveFeedRows turns workflow_jobs.result state + the LIVE pending
 * help-request row into the per-feed rows the admin board renders. The
 * board is the founder's only window into a learning run, so the
 * invariants here are product promises, not implementation details:
 *
 *   1. FOUND FEEDS ARE NEVER FLAGGED. A feed the robot already learned
 *      stays ✅ no matter what — including a stale pending help request
 *      for that same feed (worker-restart leftover). The founder must
 *      never be asked to help with something the robot already has.
 *   2. The red ❌ ('stuck') derives ONLY from the live pending row and
 *      only while the job is still running — it is never persisted, so
 *      it cannot outlive the request.
 *   3. Terminal runs show no immortal spinners: 'searching' coerces to
 *      "didn't finish", unreached feeds to "not learned".
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveFeedRows,
  summarizeFeedRows,
  prettifyTargetKey,
  isTerminalJobStatus,
  parseCurrentActivity,
  phaseLabel,
  isInProgressPhase,
} from '@/lib/pms/learning-board';

const CATALOG = [
  { key: 'getRoomStatus', label: 'Reading room statuses…', goal: 'Current housekeeping status of every room', optional: false },
  { key: 'getArrivals', label: 'Finding today’s arrivals…', goal: 'Guests arriving today', optional: false },
  { key: 'getDepartures', label: 'Finding today’s departures…', goal: 'Guests leaving today', optional: false },
  { key: 'getRevenueDaily', label: 'Finding the revenue report…', goal: 'Daily room revenue', optional: true },
];

function rowsByKey(rows: ReturnType<typeof deriveFeedRows>) {
  return new Map(rows.map((r) => [r.key, r]));
}

// ─── Core status mapping ────────────────────────────────────────────────────

describe('deriveFeedRows — live run statuses', () => {
  test('found / searching / queued / stuck map from board state + pending row', () => {
    const rows = rowsByKey(deriveFeedRows({
      catalog: CATALOG,
      boardTargets: {
        getRoomStatus: { status: 'found', preview: { rowCount: 42, sample: [{ room_number: '101', status: 'Clean' }], sampleKind: 'rows' } },
        getArrivals: { status: 'searching', startedAt: '2026-06-11T10:00:00Z' },
      },
      actionsSoFar: { getRoomStatus: {} },
      pendingHelpTargetKey: 'getDepartures',
      jobStatus: 'running',
    }));
    assert.equal(rows.get('getRoomStatus')?.glyph, 'found');
    assert.equal(rows.get('getRoomStatus')?.rowCount, 42);
    assert.deepEqual(rows.get('getRoomStatus')?.sample, [{ room_number: '101', status: 'Clean' }]);
    assert.equal(rows.get('getRoomStatus')?.sampleKind, 'rows');
    assert.equal(rows.get('getArrivals')?.glyph, 'searching');
    assert.equal(rows.get('getDepartures')?.glyph, 'stuck');
    assert.equal(rows.get('getRevenueDaily')?.glyph, 'queued');
  });

  test('unavailable and failed are distinct, with reason surfaced on failed', () => {
    const rows = rowsByKey(deriveFeedRows({
      catalog: CATALOG,
      boardTargets: {
        getRevenueDaily: { status: 'unavailable', reason: 'unavailable: admin marked' },
        getDepartures: { status: 'failed', reason: 'wallclock budget exceeded' },
      },
      actionsSoFar: {},
      pendingHelpTargetKey: null,
      jobStatus: 'running',
    }));
    assert.equal(rows.get('getRevenueDaily')?.glyph, 'unavailable');
    assert.equal(rows.get('getDepartures')?.glyph, 'failed');
    assert.equal(rows.get('getDepartures')?.reason, 'wallclock budget exceeded');
  });

  test('found via legacy actionsSoFar alone (no boardTargets) still reads found', () => {
    const rows = rowsByKey(deriveFeedRows({
      catalog: CATALOG,
      boardTargets: {},
      actionsSoFar: { getArrivals: { steps: [] } },
      pendingHelpTargetKey: null,
      jobStatus: 'running',
    }));
    assert.equal(rows.get('getArrivals')?.glyph, 'found');
  });

  test('carried (reclaim-seeded) found feeds stay found and are marked carried', () => {
    const rows = rowsByKey(deriveFeedRows({
      catalog: CATALOG,
      boardTargets: {
        getRoomStatus: { status: 'found', carried: true },
      },
      actionsSoFar: {},
      pendingHelpTargetKey: null,
      jobStatus: 'running',
    }));
    assert.equal(rows.get('getRoomStatus')?.glyph, 'found');
    assert.equal(rows.get('getRoomStatus')?.carried, true);
  });
});

// ─── INVARIANT 1: found is never flagged ────────────────────────────────────

describe('deriveFeedRows — found feeds can never be flagged', () => {
  test('a pending help request for a board-found feed does NOT flag it', () => {
    const rows = rowsByKey(deriveFeedRows({
      catalog: CATALOG,
      boardTargets: { getRoomStatus: { status: 'found' } },
      actionsSoFar: {},
      pendingHelpTargetKey: 'getRoomStatus', // stale row after worker restart
      jobStatus: 'running',
    }));
    assert.equal(rows.get('getRoomStatus')?.glyph, 'found');
    // …and no OTHER feed inherits the flag either.
    assert.equal([...rows.values()].filter((r) => r.glyph === 'stuck').length, 0);
  });

  test('a pending help request for an actionsSoFar-found feed does NOT flag it', () => {
    const rows = rowsByKey(deriveFeedRows({
      catalog: CATALOG,
      boardTargets: {},
      actionsSoFar: { getArrivals: {} },
      pendingHelpTargetKey: 'getArrivals',
      jobStatus: 'running',
    }));
    assert.equal(rows.get('getArrivals')?.glyph, 'found');
  });

  test('only the stuck feed shows the red flag — never its neighbors', () => {
    const rows = deriveFeedRows({
      catalog: CATALOG,
      boardTargets: { getRoomStatus: { status: 'found' }, getArrivals: { status: 'found' } },
      actionsSoFar: {},
      pendingHelpTargetKey: 'getDepartures',
      jobStatus: 'running',
    });
    const stuck = rows.filter((r) => r.glyph === 'stuck');
    assert.equal(stuck.length, 1);
    assert.equal(stuck[0]!.key, 'getDepartures');
    assert.equal(rows.filter((r) => r.glyph === 'found').length, 2);
  });
});

// ─── INVARIANT 3: terminal coercion ─────────────────────────────────────────

describe('deriveFeedRows — terminal jobs show no immortal spinners', () => {
  for (const jobStatus of ['completed', 'failed', 'cancelled']) {
    test(`${jobStatus}: searching → didnt_finish, unreached → not_reached, pending row ignored`, () => {
      const rows = rowsByKey(deriveFeedRows({
        catalog: CATALOG,
        boardTargets: {
          getRoomStatus: { status: 'found' },
          getArrivals: { status: 'searching' },
        },
        actionsSoFar: {},
        pendingHelpTargetKey: 'getDepartures', // dead request on a dead run
        jobStatus,
      }));
      assert.equal(rows.get('getRoomStatus')?.glyph, 'found');
      assert.equal(rows.get('getArrivals')?.glyph, 'didnt_finish');
      assert.equal(rows.get('getDepartures')?.glyph, 'not_reached');
      assert.equal(rows.get('getRevenueDaily')?.glyph, 'not_reached');
    });
  }

  test('isTerminalJobStatus matches the job statuses the runtime uses', () => {
    assert.equal(isTerminalJobStatus('completed'), true);
    assert.equal(isTerminalJobStatus('failed'), true);
    assert.equal(isTerminalJobStatus('cancelled'), true);
    assert.equal(isTerminalJobStatus('running'), false);
    assert.equal(isTerminalJobStatus('queued'), false);
    assert.equal(isTerminalJobStatus(null), false);
    assert.equal(isTerminalJobStatus(undefined), false);
  });
});

// ─── No-catalog fallback (jobs from before this shipped) ────────────────────

describe('deriveFeedRows — no-catalog fallback', () => {
  test('derives rows from actionsSoFar + boardTargets + pending key, prettified', () => {
    const rows = deriveFeedRows({
      catalog: undefined,
      boardTargets: { getWorkOrders: { status: 'failed', reason: 'x' } },
      actionsSoFar: { getRoomStatus: {} },
      pendingHelpTargetKey: 'getArrivals',
      jobStatus: 'running',
    });
    const byKey = rowsByKey(rows);
    assert.equal(rows.length, 3);
    assert.equal(byKey.get('getRoomStatus')?.glyph, 'found');
    assert.equal(byKey.get('getRoomStatus')?.label, 'Room status');
    assert.equal(byKey.get('getArrivals')?.glyph, 'stuck');
    assert.equal(byKey.get('getWorkOrders')?.glyph, 'failed');
  });

  test('aggregates-only result (old completed jobs) yields zero rows, no throw', () => {
    const rows = deriveFeedRows({
      catalog: undefined,
      boardTargets: undefined,
      actionsSoFar: undefined,
      pendingHelpTargetKey: null,
      jobStatus: 'completed',
    });
    assert.equal(rows.length, 0);
  });

  test('garbage shapes degrade without throwing', () => {
    const rows = deriveFeedRows({
      catalog: 'nonsense',
      boardTargets: [1, 2, 3],
      actionsSoFar: 42,
      pendingHelpTargetKey: null,
      jobStatus: 'running',
    });
    assert.equal(rows.length, 0);
    // Catalog entries with junk keys are dropped, valid ones kept.
    const rows2 = deriveFeedRows({
      catalog: [{ key: '' }, { nope: true }, { key: 'getGuests' }],
      boardTargets: { getGuests: { status: 'found' } },
      actionsSoFar: {},
      pendingHelpTargetKey: null,
      jobStatus: 'running',
    });
    assert.equal(rows2.length, 1);
    assert.equal(rows2[0]!.key, 'getGuests');
    assert.equal(rows2[0]!.label, 'Guests');
  });
});

// ─── Summary + labels ───────────────────────────────────────────────────────

describe('summarizeFeedRows / prettifyTargetKey', () => {
  test('summary counts every glyph bucket (didnt_finish counts as failed)', () => {
    const rows = deriveFeedRows({
      catalog: CATALOG,
      boardTargets: {
        getRoomStatus: { status: 'found' },
        getArrivals: { status: 'searching' },
        getRevenueDaily: { status: 'unavailable' },
      },
      actionsSoFar: {},
      pendingHelpTargetKey: 'getDepartures',
      jobStatus: 'running',
    });
    const s = summarizeFeedRows(rows);
    assert.deepEqual(s, {
      total: 4, found: 1, searching: 1, stuck: 1, unavailable: 1, failed: 0, waiting: 0,
    });
  });

  test('prettifyTargetKey humanizes mapper keys generically', () => {
    assert.equal(prettifyTargetKey('getRoomStatus'), 'Room status');
    assert.equal(prettifyTargetKey('getLostAndFound'), 'Lost and found');
    assert.equal(prettifyTargetKey('getRatesAndInventory'), 'Rates and inventory');
    assert.equal(prettifyTargetKey('getGuests'), 'Guests');
  });
});

// ─── Live phase contract (feature/cua-admin-mapper-visibility) ───────────────

describe('deriveFeedRows — per-feed phase is additive, never changes the glyph', () => {
  test('a recognized phase surfaces on the row without altering its glyph', () => {
    const rows = rowsByKey(deriveFeedRows({
      catalog: CATALOG,
      boardTargets: {
        getRoomStatus: { status: 'found', phase: 'found' },
        getArrivals: { status: 'searching', phase: 'extracting' },
      },
      actionsSoFar: {},
      pendingHelpTargetKey: null,
      jobStatus: 'running',
    }));
    assert.equal(rows.get('getArrivals')?.glyph, 'searching');
    assert.equal(rows.get('getArrivals')?.phase, 'extracting');
    assert.equal(rows.get('getRoomStatus')?.glyph, 'found');
    assert.equal(rows.get('getRoomStatus')?.phase, 'found');
  });

  test('an unknown / absent phase leaves the field off entirely', () => {
    const rows = rowsByKey(deriveFeedRows({
      catalog: CATALOG,
      boardTargets: {
        getArrivals: { status: 'searching', phase: 'bogus-phase' },
        getDepartures: { status: 'searching' },
      },
      actionsSoFar: {},
      pendingHelpTargetKey: null,
      jobStatus: 'running',
    }));
    assert.equal(rows.get('getArrivals')?.glyph, 'searching');
    assert.equal('phase' in (rows.get('getArrivals') ?? {}), false);
    assert.equal('phase' in (rows.get('getDepartures') ?? {}), false);
  });
});

describe('parseCurrentActivity', () => {
  test('parses a well-formed currentActivity and clamps pct', () => {
    const ca = parseCurrentActivity({
      currentActivity: { feedKey: 'getArrivals', phase: 'navigating', pct: 42.6, at: '2026-06-16T10:00:00Z' },
    });
    assert.deepEqual(ca, { feedKey: 'getArrivals', phase: 'navigating', pct: 43, at: '2026-06-16T10:00:00Z', totalCostMicros: null });
  });

  test('clamps pct to 0..100 and rounds', () => {
    assert.equal(parseCurrentActivity({ currentActivity: { phase: 'extracting', pct: 250 } })?.pct, 100);
    assert.equal(parseCurrentActivity({ currentActivity: { phase: 'extracting', pct: -5 } })?.pct, 0);
    assert.equal(parseCurrentActivity({ currentActivity: { phase: 'extracting', pct: 'nope' } })?.pct, null);
  });

  test('null for missing / pre-ship / garbage shapes (graceful degradation)', () => {
    assert.equal(parseCurrentActivity(undefined), null);
    assert.equal(parseCurrentActivity(null), null);
    assert.equal(parseCurrentActivity({}), null);
    assert.equal(parseCurrentActivity({ currentActivity: null }), null);
    assert.equal(parseCurrentActivity({ currentActivity: [1, 2] }), null);
    // Neither a recognized phase NOR a feed key → nothing useful → null.
    assert.equal(parseCurrentActivity({ currentActivity: { phase: 'bogus' } }), null);
  });

  test('an unrecognized phase with a feed key still yields a row (phase null)', () => {
    const ca = parseCurrentActivity({ currentActivity: { feedKey: 'getArrivals', phase: 'bogus' } });
    assert.deepEqual(ca, { feedKey: 'getArrivals', phase: null, pct: null, at: null, totalCostMicros: null });
  });

  test('carries a numeric totalCostMicros (feature/cua-mapper-cost); null when absent or garbage', () => {
    assert.equal(parseCurrentActivity({ currentActivity: { feedKey: 'getArrivals', phase: 'navigating', totalCostMicros: 1234567 } })?.totalCostMicros, 1234567);
    assert.equal(parseCurrentActivity({ currentActivity: { feedKey: 'getArrivals', phase: 'navigating' } })?.totalCostMicros, null);
    assert.equal(parseCurrentActivity({ currentActivity: { feedKey: 'getArrivals', phase: 'navigating', totalCostMicros: 'nope' } })?.totalCostMicros, null);
  });
});

describe('phaseLabel', () => {
  test('interpolates the feed noun (lower-cased) for navigating / extracting', () => {
    assert.equal(phaseLabel('navigating', 'Room status'), 'Finding the room status screen…');
    assert.equal(phaseLabel('extracting', 'Arrivals'), 'Reading the arrivals data…');
  });

  test('falls back to feed-less wording when no noun is given', () => {
    assert.equal(phaseLabel('navigating'), 'Finding the screen…');
    assert.equal(phaseLabel('extracting'), 'Reading the data…');
  });

  test('static labels for the remaining phases', () => {
    assert.equal(phaseLabel('certifying'), 'Double-checking the columns…');
    assert.equal(phaseLabel('drilling'), 'Digging into the details…');
    assert.equal(phaseLabel('rechecking'), 'Re-checking…');
    assert.equal(phaseLabel('queued'), 'Waiting in line…');
    assert.equal(phaseLabel('found'), 'Found ✓');
    assert.equal(phaseLabel('unavailable'), 'Not in this PMS');
    assert.equal(phaseLabel('failed'), "Couldn't find it");
    assert.equal(phaseLabel('cost_capped'), 'Stopped (budget)');
  });
});

describe('isInProgressPhase', () => {
  test('working phases spin; terminal-ish phases do not', () => {
    for (const p of ['queued', 'navigating', 'extracting', 'certifying', 'drilling', 'rechecking'] as const) {
      assert.equal(isInProgressPhase(p), true, p);
    }
    for (const p of ['found', 'unavailable', 'failed', 'cost_capped'] as const) {
      assert.equal(isInProgressPhase(p), false, p);
    }
    assert.equal(isInProgressPhase(null), false);
    assert.equal(isInProgressPhase(undefined), false);
  });
});
