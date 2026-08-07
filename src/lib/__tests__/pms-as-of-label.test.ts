/**
 * The as-of stamp the dashboard puts under a PMS-sourced number
 * (src/lib/pms/as-of-label.ts).
 *
 * The founder's rule: a late report keeps its last real number on screen WITH
 * a "as of 6:40 AM" stamp, because a four-hour-old occupancy figure is useful
 * and a blank square is not. The stamp is the only thing making that honest,
 * so the cases pinned here are the ones where a stamp would itself be the lie:
 *
 *   • a manual (no_pms) hotel — Staxis IS its system of record, its numbers
 *     really are live, and an age claim invents a doubt that does not exist;
 *   • a connection that has never delivered — the tile says "still syncing"
 *     and every number behind it is a fake zero;
 *   • a feed with no real source at all — there is nothing to stamp.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildAsOfLabel } from '@/lib/pms/as-of-label';
import {
  NO_PMS_FEED_STATUS,
  type FeedKey,
  type FeedState,
  type FreshnessSource,
  type PropertyFeedStatus,
} from '@/lib/pms/feed-status';

const NOW = new Date('2026-07-24T19:40:00.000Z'); // 2:40 PM America/Chicago
const TZ = 'America/Chicago';

function agedBy(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

function liveStatus(over: {
  feeds?: Partial<Record<FeedKey, FeedState>>;
  connection?: PropertyFeedStatus['connection'];
  capturedAt?: string | null;
  source?: FreshnessSource;
} = {}): PropertyFeedStatus {
  return {
    mode: 'live',
    connection: over.connection ?? 'healthy',
    feeds: {
      roomStatus: 'live',
      arrivals: 'live',
      departures: 'live',
      workOrders: 'live',
      dashboardCounts: 'live',
      ...(over.feeds ?? {}),
    },
    isPartial: false,
    freshness: {
      capturedAt: over.capturedAt === undefined ? agedBy(20) : over.capturedAt,
      source: over.source ?? 'heartbeat',
    },
  };
}

function label(status: PropertyFeedStatus | null, feeds: FeedKey[] = ['dashboardCounts'], lang: 'en' | 'es' = 'en') {
  return buildAsOfLabel({ status, feeds, timezone: TZ, lang, now: NOW });
}

describe('buildAsOfLabel — when there must be NO stamp', () => {
  it('says nothing for a hotel with no PMS connection', () => {
    // The honesty rule that runs backwards from the rest of the module: for a
    // manual hotel the app is the record, so "as of" would be a lie about
    // numbers the manager just typed in.
    assert.equal(label(NO_PMS_FEED_STATUS), null);
  });

  it('says nothing while a hotel is still onboarding', () => {
    const onboarding: PropertyFeedStatus = {
      ...NO_PMS_FEED_STATUS,
      mode: 'onboarding',
      freshness: { capturedAt: agedBy(600), source: 'session_read' },
    };
    assert.equal(label(onboarding), null);
  });

  it('says nothing when the feed has never delivered (still syncing)', () => {
    // A stale stamp over a fake zero is worse than the "connecting…" the tile
    // already shows.
    const pending = liveStatus({ connection: 'pending', capturedAt: agedBy(999) });
    assert.equal(label(pending), null);
  });

  it('says nothing when no backing feed has a real source', () => {
    assert.equal(label(liveStatus({ feeds: { dashboardCounts: 'learning' } })), null);
    assert.equal(label(liveStatus({ feeds: { dashboardCounts: 'unavailable' } })), null);
  });

  it('says nothing before the feed status has loaded', () => {
    assert.equal(label(null), null);
  });

  it('stamps as soon as ANY of the backing feeds is real', () => {
    const partial = liveStatus({ feeds: { dashboardCounts: 'unavailable', arrivals: 'stale' } });
    assert.ok(label(partial, ['dashboardCounts', 'arrivals']));
  });
});

describe('buildAsOfLabel — what the stamp says', () => {
  it('stamps a fresh number quietly, with just the time', () => {
    const l = label(liveStatus({ capturedAt: agedBy(20) }));
    assert.equal(l?.tier, 'fresh');
    assert.equal(l?.tone, 'quiet');
    assert.equal(l?.text, 'as of 2:20 PM');
  });

  it('adds the age and a caution once the report is past its cycle', () => {
    // 8 hours before 2:40 PM Chicago = 6:40 AM — the founder's own example.
    const l = label(liveStatus({ capturedAt: agedBy(480) }));
    assert.equal(l?.tier, 'very_stale');
    assert.equal(l?.tone, 'caution');
    assert.equal(l?.text, 'as of 6:40 AM · 8 hr ago');
  });

  it('cautions on a merely-late report without shouting', () => {
    const l = label(liveStatus({ capturedAt: agedBy(120) }));
    assert.equal(l?.tier, 'stale');
    assert.equal(l?.tone, 'caution');
    assert.equal(l?.text, 'as of 12:40 PM · 2 hr ago');
    assert.match(l?.detail ?? '', /older than one report cycle/);
  });

  it('never cautions on a change-only stamp — absence of change is not staleness', () => {
    const l = label(liveStatus({ capturedAt: agedBy(400), source: 'row_change' }));
    assert.equal(l?.tier, 'change_only');
    assert.equal(l?.tone, 'quiet');
    assert.match(l?.text ?? '', /^last changed /);
  });

  it('admits an unknown age instead of implying "now"', () => {
    const l = label(liveStatus({ capturedAt: null, source: 'none' }));
    assert.equal(l?.tier, 'unknown');
    assert.equal(l?.tone, 'caution');
    assert.equal(l?.text, 'update time unknown');
  });

  it('admits an unknown age when the capture time is unusable', () => {
    const l = label(liveStatus({ capturedAt: 'not-a-timestamp' }));
    assert.equal(l?.tier, 'unknown');
    assert.equal(l?.text, 'update time unknown');
  });

  it('names the timezone in the long form so the time is not ambiguous', () => {
    const l = label(liveStatus({ capturedAt: agedBy(480) }));
    assert.match(l?.detail ?? '', /America\/Chicago/);
    assert.match(l?.detail ?? '', /6:40 AM/);
  });

  it('dates the stamp when the report landed on an earlier day', () => {
    const l = label(liveStatus({ capturedAt: agedBy(20 * 60) }));
    assert.match(l?.text ?? '', /Jul 23/);
  });
});

describe('buildAsOfLabel — freshness classification stays complete in English-only UI', () => {
  it('classifies every source/age tier without inventing freshness', () => {
    const cases: Array<{
      capturedAt: string | null;
      source?: FreshnessSource;
      tier: string;
      tone: string;
    }> = [
      { capturedAt: agedBy(20), tier: 'fresh', tone: 'quiet' },
      { capturedAt: agedBy(120), tier: 'stale', tone: 'caution' },
      { capturedAt: agedBy(480), tier: 'very_stale', tone: 'caution' },
      { capturedAt: agedBy(400), source: 'row_change', tier: 'change_only', tone: 'quiet' },
      { capturedAt: null, source: 'none', tier: 'unknown', tone: 'caution' },
    ];

    for (const expected of cases) {
      const result = label(liveStatus({
        capturedAt: expected.capturedAt,
        source: expected.source,
      }));
      assert.equal(result?.tier, expected.tier);
      assert.equal(result?.tone, expected.tone);
      assert.ok((result?.text ?? '').length > 0, `${expected.tier}: missing honest freshness copy`);
    }
  });

  it('keeps the source clock visible for stale data', () => {
    const result = label(liveStatus({ capturedAt: agedBy(480) }));
    assert.match(result?.text ?? '', /6:40 AM/);
    assert.match(result?.detail ?? '', /6:40 AM/);
  });
});

// ─── THE MODULE IS THE ONLY SUPPRESSOR ──────────────────────────────────────
//
// The dashboard carried a fourth, undocumented rule of its own: hide the stamp
// whenever the ROOM-STATUS feed is learning. It fired on exactly the case that
// needs a stamp most — a hotel whose room-status feed is still being learned
// while its counts feed is hours stale showed a confident occupancy percentage
// with nothing on screen saying when it was taken. These pin the answers the
// screen must now render verbatim.

describe('a stamped number is stamped whatever OTHER feeds are doing', () => {
  it('room status learning + counts stale → the occupancy stamp still appears', () => {
    const label = buildAsOfLabel({
      status: liveStatus({ feeds: { roomStatus: 'learning', dashboardCounts: 'stale' }, capturedAt: agedBy(240) }),
      // The exact feed pair the dashboard's occupancy ring stamps.
      feeds: ['dashboardCounts', 'roomStatus'],
      timezone: TZ,
      lang: 'en',
      now: NOW,
    });
    assert.ok(label, 'a four-hour-old occupancy figure must never render unstamped');
    assert.equal(label.tier, 'stale');
    assert.equal(label.tone, 'caution');
  });

  it('room status learning + counts live → a quiet stamp, not silence', () => {
    const label = buildAsOfLabel({
      status: liveStatus({ feeds: { roomStatus: 'learning' }, capturedAt: agedBy(20) }),
      feeds: ['dashboardCounts', 'roomStatus'],
      timezone: TZ,
      lang: 'en',
      now: NOW,
    });
    assert.ok(label);
    assert.equal(label.tone, 'quiet');
  });

  it('but when NEITHER stamped feed has a real source there is still nothing to stamp', () => {
    const label = buildAsOfLabel({
      status: liveStatus({ feeds: { roomStatus: 'learning', dashboardCounts: 'unavailable' }, capturedAt: agedBy(240) }),
      feeds: ['dashboardCounts', 'roomStatus'],
      timezone: TZ,
      lang: 'en',
      now: NOW,
    });
    assert.equal(label, null);
  });
});
