/**
 * feat/cua-partial-promotion — pure derivation tests for the app-side
 * honesty layer. The single most load-bearing assertion: a feed that is
 * gap-listed must classify 'learning' EVEN WHEN its key is present in
 * actions (incomplete_columns feeds are present and dead) — getting that
 * wrong resurrects the fake-empty/all-dirty bug class on promoted recipes.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveFeedStatus,
  learningFeeds,
  snapshotCountsApplyTo,
  NO_PMS_FEED_STATUS,
  type FeedGaps,
  type FeedStatusSessionRow,
} from '@/lib/pms/feed-status';

const session = (over: Partial<FeedStatusSessionRow> = {}): FeedStatusSessionRow => ({
  pms_family: 'example_pms',
  status: 'alive',
  last_successful_read_at: '2026-06-11T10:00:00Z',
  ...over,
});

const ALL_ACTIONS = {
  getRoomStatus: {}, getArrivals: {}, getDepartures: {}, getWorkOrders: {},
  getGuests: {}, getRevenueDaily: {}, getRatesAndInventory: {},
};

const gaps = (over: Partial<FeedGaps> = {}): FeedGaps => ({
  computedAt: '2026-06-11T09:00:00Z',
  missingRequired: [],
  missingBusinessCritical: [],
  ...over,
});

describe('deriveFeedStatus — modes', () => {
  it('no session row → no_pms (manual hotel renders exactly as today)', () => {
    const s = deriveFeedStatus(null, null);
    assert.equal(s.mode, 'no_pms');
    assert.equal(s.isPartial, false);
    assert.equal(s.feeds.departures, 'live'); // fail-safe: no banners
  });

  it('session but no active knowledge file → onboarding, no partial flag', () => {
    const s = deriveFeedStatus(session(), null);
    assert.equal(s.mode, 'onboarding');
    assert.equal(s.isPartial, false);
  });

  it('active file with no gaps → live, all required feeds live', () => {
    const s = deriveFeedStatus(session(), { actions: ALL_ACTIONS, feedGaps: null });
    assert.equal(s.mode, 'live');
    assert.equal(s.isPartial, false);
    assert.equal(s.feeds.roomStatus, 'live');
    assert.equal(s.feeds.workOrders, 'live');
  });
});

describe('deriveFeedStatus — three states + precedence', () => {
  it('gap-listed not_found target → learning', () => {
    const actions = { ...ALL_ACTIONS } as Record<string, unknown>;
    delete actions.getDepartures;
    const s = deriveFeedStatus(session(), {
      actions,
      feedGaps: gaps({ missingRequired: [{ target: 'getDepartures', reason: 'not_found' }] }),
    });
    assert.equal(s.feeds.departures, 'learning');
    assert.equal(s.feeds.arrivals, 'live');
    assert.equal(s.isPartial, true);
    assert.deepEqual(learningFeeds(s), ['departures']);
  });

  it('PRECEDENCE: present in actions but gap-listed (incomplete_columns) → learning, not live', () => {
    const s = deriveFeedStatus(session(), {
      actions: ALL_ACTIONS, // getRoomStatus key IS present…
      feedGaps: gaps({
        missingRequired: [{ target: 'getRoomStatus', reason: 'incomplete_columns', missingColumns: ['status'] }],
      }),
    });
    assert.equal(s.feeds.roomStatus, 'learning');
    assert.equal(s.isPartial, true);
  });

  it('unlearnable target absent and not gap-listed → unavailable (never a false "retrying")', () => {
    const s = deriveFeedStatus(session(), { actions: ALL_ACTIONS, feedGaps: null });
    assert.equal(s.feeds.dashboardCounts, 'unavailable');
    // unavailable is NOT partial — nothing is being retried.
    assert.equal(s.isPartial, false);
  });

  it('dashboardCounts present in actions → live (the legacy seeded family)', () => {
    const s = deriveFeedStatus(session(), {
      actions: { ...ALL_ACTIONS, getDashboardCounts: {} },
      feedGaps: null,
    });
    assert.equal(s.feeds.dashboardCounts, 'live');
  });

  it('LEGACY fallback: active file with NO feedGaps but a required key absent → learning', () => {
    const actions = { ...ALL_ACTIONS } as Record<string, unknown>;
    delete actions.getWorkOrders;
    const s = deriveFeedStatus(session(), { actions, feedGaps: null });
    assert.equal(s.feeds.workOrders, 'learning');
    assert.equal(s.isPartial, true);
  });

  it('BC-only gaps do not amber the world: isPartial stays false', () => {
    const s = deriveFeedStatus(session(), {
      actions: ALL_ACTIONS,
      feedGaps: gaps({ missingBusinessCritical: ['getChannelPerformance', 'getForecastDaily'] }),
    });
    assert.equal(s.isPartial, false);
    assert.deepEqual(learningFeeds(s), []);
  });
});

describe('deriveFeedStatus — connection dimension', () => {
  it('never-read session → pending', () => {
    const s = deriveFeedStatus(session({ last_successful_read_at: null }), {
      actions: ALL_ACTIONS, feedGaps: null,
    });
    assert.equal(s.connection, 'pending');
  });

  it('stopped / mfa / circuit-breaker / failed_restart → paused', () => {
    for (const st of ['stopped', 'paused_mfa', 'paused_circuit_breaker', 'failed_restart']) {
      const s = deriveFeedStatus(session({ status: st }), { actions: ALL_ACTIONS, feedGaps: null });
      assert.equal(s.connection, 'paused', st);
    }
  });

  it('paused_cost_cap keeps reading deterministically → healthy', () => {
    const s = deriveFeedStatus(session({ status: 'paused_cost_cap' }), {
      actions: ALL_ACTIONS, feedGaps: null,
    });
    assert.equal(s.connection, 'healthy');
  });
});

describe('NO_PMS_FEED_STATUS — the containment value', () => {
  it('is mode no_pms, all-live, not partial (renders as today on any error)', () => {
    assert.equal(NO_PMS_FEED_STATUS.mode, 'no_pms');
    assert.equal(NO_PMS_FEED_STATUS.isPartial, false);
    for (const v of Object.values(NO_PMS_FEED_STATUS.feeds)) assert.equal(v, 'live');
  });
});

// ─── snapshotCountsApplyTo ───────────────────────────────────────────────────
//
// THE BUG: the housekeeping board pages through Yesterday / Today / Tomorrow,
// and its In House / Arrivals / Departures cells were wired straight to
// pms_in_house_snapshot — one undated row per hotel holding whatever the
// connection last saw. A manager planning tomorrow's crew read "Board ·
// tomorrow" over TODAY's arrivals, in the same strip as tomorrow's genuinely
// date-scoped Checkouts and Stayovers.

describe('snapshotCountsApplyTo — which day the snapshot may speak for', () => {
  const live = deriveFeedStatus(session(), { actions: { ...ALL_ACTIONS, getDashboardCounts: {} } });
  const TODAY = '2026-07-16';

  it('today: a live counts feed may fill the strip', () => {
    assert.equal(snapshotCountsApplyTo(live, TODAY, TODAY), true);
  });

  it('tomorrow: the undated snapshot may NOT stand in for another day', () => {
    // The exact regression. Without this the board shows today's 14 arrivals
    // under a heading that says tomorrow.
    assert.equal(snapshotCountsApplyTo(live, '2026-07-17', TODAY), false);
  });

  it('yesterday: same refusal in the other direction', () => {
    assert.equal(snapshotCountsApplyTo(live, '2026-07-15', TODAY), false);
  });

  it('a hotel that has never read anything gets nothing, even on today', () => {
    const pending = deriveFeedStatus(
      session({ last_successful_read_at: null }),
      { actions: { ...ALL_ACTIONS, getDashboardCounts: {} } },
    );
    assert.equal(pending.connection, 'pending');
    assert.equal(snapshotCountsApplyTo(pending, TODAY, TODAY), false);
  });

  it('a counts feed with no real source gets nothing, even on today', () => {
    // getDashboardCounts absent from actions → 'unavailable' (not a required
    // target), which is the state EVERY newly-learned PMS family starts in.
    const noCounts = deriveFeedStatus(session(), { actions: ALL_ACTIONS });
    assert.equal(noCounts.feeds.dashboardCounts, 'unavailable');
    assert.equal(snapshotCountsApplyTo(noCounts, TODAY, TODAY), false);
  });

  it('a manual hotel takes the per-date bridge instead, never the snapshot', () => {
    assert.equal(snapshotCountsApplyTo(NO_PMS_FEED_STATUS, TODAY, TODAY), false);
  });

  it('a status that has not loaded claims nothing', () => {
    assert.equal(snapshotCountsApplyTo(null, TODAY, TODAY), false);
    assert.equal(snapshotCountsApplyTo(undefined, TODAY, TODAY), false);
  });
});
