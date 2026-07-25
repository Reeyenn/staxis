/**
 * The knowledge promotion queue (migration 0353) — the rules that decide
 * whether something one hotel taught us may be shared with hotels that never
 * gave us the information.
 *
 * These are the parts that must hold WITHOUT a database, because they are
 * enforced in three places at once — the DB CHECKs, staxis_propose_promotion,
 * and the API route — and the whole point of `src/lib/promotion-queue.ts` is
 * that all three read the same rule. If the bar drifts, a hotel's private
 * operating detail becomes advice at another hotel and nobody notices.
 *
 * Behaviour is exercised through the exported functions; the one source-text
 * assertion is the RLS posture of the migration, which has no runtime to test.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  AGGREGATE_MIN_GROUP_SIZE,
  PROMOTION_TTL_DAYS,
  TIER_BAR,
  countNeedingAttention,
  daysUntilExpiry,
  describeEvidence,
  expiryFrom,
  isExpired,
  isMissingRelationError,
  meetsEvidenceBar,
  tierLabel,
  unmetPreconditions,
  type EvidenceClaim,
  type PromotionRow,
} from '@/lib/promotion-queue';

const DAY = 86_400_000;

function claim(over: Partial<EvidenceClaim> = {}): EvidenceClaim {
  return {
    target_tier: 'family',
    origin: 'learned',
    supporting_hotel_count: 2,
    holdout_validated: false,
    is_aggregate: false,
    ...over,
  };
}

function row(over: Partial<PromotionRow> = {}): PromotionRow {
  return {
    id: 'p1',
    topic: 'exp_dep_column_means_departures',
    claim: 'The "Exp Dep" column means departures.',
    evidence_summary: null,
    proposed_content: 'Exp Dep = expected departures.',
    final_content: null,
    source_tier: 'hotel',
    target_tier: 'family',
    pms_family: 'choice_advantage',
    origin: 'learned',
    source_kind: 'extraction',
    source_ref: null,
    source_property_ids: [],
    supporting_hotel_count: 2,
    observation_count: 0,
    evidence_window_start: null,
    evidence_window_end: null,
    holdout_validated: false,
    is_aggregate: false,
    preconditions: [],
    target_table: null,
    target_row_id: null,
    previous_target_row_id: null,
    status: 'pending',
    decided_at: null,
    decided_by_account_id: null,
    decision_note: null,
    approved_at: null,
    expires_at: null,
    reconfirmed_at: null,
    reconfirm_count: 0,
    retracted_at: null,
    applied_property_ids: [],
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...over,
  };
}

describe('the bar rises with the tier', () => {
  test('one hotel is never enough to teach every hotel on a PMS', () => {
    assert.equal(meetsEvidenceBar(claim({ supporting_hotel_count: 1 })).ok, false);
    assert.equal(meetsEvidenceBar(claim({ supporting_hotel_count: 2 })).ok, true);
  });

  test('the global tier needs more hotels than the family tier', () => {
    assert.ok(TIER_BAR.global.minSupportingHotels > TIER_BAR.family.minSupportingHotels);
    const twoHotels = claim({ target_tier: 'global', supporting_hotel_count: 2, holdout_validated: true });
    assert.equal(meetsEvidenceBar(twoHotels).ok, false);
  });

  test('a global claim must survive a hotel that supplied none of the evidence', () => {
    const noHoldout = claim({ target_tier: 'global', supporting_hotel_count: 9, holdout_validated: false });
    const result = meetsEvidenceBar(noHoldout);
    assert.equal(result.ok, false);
    assert.match(result.reason, /contributed none/i);

    assert.equal(meetsEvidenceBar({ ...noHoldout, holdout_validated: true }).ok, true);
  });

  test('a hand-written item is exempt from the hotel count — nothing was borrowed', () => {
    const authored = claim({ origin: 'authored', target_tier: 'global', supporting_hotel_count: 0, holdout_validated: false });
    assert.equal(meetsEvidenceBar(authored).ok, true);
  });

  test('a refusal always says why, in words a non-engineer can act on', () => {
    const r = meetsEvidenceBar(claim({ supporting_hotel_count: 0 }));
    assert.equal(r.ok, false);
    assert.ok(r.reason.length > 0);
    assert.equal(/\b(tier|RLS|constraint|null)\b/i.test(r.reason), false, `jargon leaked: ${r.reason}`);
  });
});

describe('cross-hotel comparisons refuse rather than answer weakly', () => {
  test('an aggregate claim needs the minimum group size even when hand-written', () => {
    const authoredAggregate = claim({
      origin: 'authored',
      is_aggregate: true,
      supporting_hotel_count: AGGREGATE_MIN_GROUP_SIZE - 1,
    });
    const r = meetsEvidenceBar(authoredAggregate);
    assert.equal(r.ok, false, 'an authored aggregate claim slipped past the minimum group size');
    assert.match(r.reason, /not enough hotels/i);
  });

  test('at one hotel, no comparison can ever qualify', () => {
    // The whole fleet backs it and it is still refused — the intended outcome
    // while Staxis has a single hotel.
    assert.equal(meetsEvidenceBar(claim({ is_aggregate: true, supporting_hotel_count: 1 })).ok, false);
  });

  test('the group size is met only at the threshold, not below it', () => {
    const atThreshold = claim({
      target_tier: 'global',
      is_aggregate: true,
      supporting_hotel_count: AGGREGATE_MIN_GROUP_SIZE,
      holdout_validated: true,
    });
    assert.equal(meetsEvidenceBar(atThreshold).ok, true);
    assert.equal(
      meetsEvidenceBar({ ...atThreshold, supporting_hotel_count: AGGREGATE_MIN_GROUP_SIZE - 1 }).ok,
      false,
    );
  });
});

describe('shared knowledge expires unless re-confirmed', () => {
  const now = new Date('2026-08-01T12:00:00.000Z');

  test('approval sets a re-confirm date 75 days out', () => {
    const expires = Date.parse(expiryFrom(now));
    assert.equal(Math.round((expires - now.getTime()) / DAY), PROMOTION_TTL_DAYS);
  });

  test('a live item past its date is flagged, not silently kept', () => {
    const overdue = row({ status: 'approved', expires_at: new Date(now.getTime() - DAY).toISOString() });
    assert.equal(isExpired(overdue, now), true);
    assert.equal(daysUntilExpiry(overdue, now), -1);
  });

  test('a pending item has no expiry clock', () => {
    assert.equal(isExpired(row({ status: 'pending', expires_at: null }), now), false);
    assert.equal(daysUntilExpiry(row({ status: 'pending' }), now), null);
  });

  test('the badge counts decisions waiting AND live items that aged out', () => {
    const rows = [
      row({ status: 'pending' }),
      row({ status: 'approved', expires_at: new Date(now.getTime() - DAY).toISOString() }),
      row({ status: 'approved', expires_at: new Date(now.getTime() + 30 * DAY).toISOString() }),
    ];
    assert.equal(countNeedingAttention(rows, now), 2);
  });

  test('nothing outstanding counts as zero', () => {
    assert.equal(
      countNeedingAttention([row({ status: 'approved', expires_at: new Date(now.getTime() + DAY).toISOString() })], now),
      0,
    );
  });
});

describe('requirements block approval instead of being ignored', () => {
  test('a clause about PMS guidance stays blocked until PMS guidance exists', () => {
    const item = row({ preconditions: ['family_row_exists'] });
    assert.equal(unmetPreconditions(item, { activeFamilyRowCount: 0 }).length, 1);
    assert.equal(unmetPreconditions(item, { activeFamilyRowCount: 1 }).length, 0);
  });

  test('an unknown requirement fails closed', () => {
    // A gate nothing evaluates must not read as "satisfied" — that would let a
    // behaviour change through on a requirement nobody ever checked.
    const item = row({ preconditions: ['some_future_gate'] });
    const blocked = unmetPreconditions(item, { activeFamilyRowCount: 5 });
    assert.equal(blocked.length, 1);
    assert.match(blocked[0], /stays blocked/i);
  });

  test('no requirements means nothing blocks it', () => {
    assert.deepEqual(unmetPreconditions(row({ preconditions: [] }), { activeFamilyRowCount: 0 }), []);
    assert.deepEqual(unmetPreconditions(row({ preconditions: null }), { activeFamilyRowCount: 0 }), []);
  });
});

describe('the card explains itself', () => {
  test('the audience is named in plain English', () => {
    assert.equal(tierLabel('global', null), 'Every hotel');
    assert.equal(tierLabel('family', 'choice_advantage'), 'Every hotel on choice advantage');
  });

  test('evidence names the hotels, the observations and the window', () => {
    const text = describeEvidence(row({
      supporting_hotel_count: 4,
      observation_count: 37,
      evidence_window_start: '2026-06-01T00:00:00.000Z',
      evidence_window_end: '2026-07-01T00:00:00.000Z',
      holdout_validated: true,
    }));
    assert.match(text, /4 hotels/);
    assert.match(text, /37 observations/);
    assert.match(text, /over 30 days/);
    assert.match(text, /gave no evidence/);
  });

  test('a hand-written item says so rather than claiming zero hotels back it', () => {
    const text = describeEvidence(row({ origin: 'authored', supporting_hotel_count: 0 }));
    assert.match(text, /Written by hand/);
    assert.equal(/0 hotels/.test(text), false);
  });
});

describe('a missing table degrades instead of breaking the admin header', () => {
  test('PostgREST and Postgres "no such table" signals are both recognised', () => {
    assert.equal(isMissingRelationError({ code: '42P01', message: 'relation "public.knowledge_promotions" does not exist' }), true);
    assert.equal(isMissingRelationError({ code: 'PGRST205', message: "Could not find the table 'public.knowledge_promotions'" }), true);
  });

  test('a real failure is NOT swallowed as "not set up yet"', () => {
    assert.equal(isMissingRelationError({ code: '57014', message: 'canceling statement due to statement timeout' }), false);
    assert.equal(isMissingRelationError(null), false);
  });
});

describe('the queue is invisible to hotels', () => {
  const sql = readFileSync(
    join(process.cwd(), 'supabase', 'migrations', '0353_knowledge_promotion_queue.sql'),
    'utf8',
  );

  // No runtime to exercise: this is a grant/policy posture, so the migration
  // text is the only place it can be asserted.
  test('the table grants nothing to a browser client', () => {
    assert.match(sql, /revoke all on public\.knowledge_promotions from public, anon, authenticated/);
    assert.match(sql, /grant select, insert, update, delete on public\.knowledge_promotions to service_role/);
    assert.match(sql, /create policy knowledge_promotions_deny_all[\s\S]*?using \(false\) with check \(false\)/);
    assert.equal(
      /grant[^;]*on public\.knowledge_promotions to[^;]*\b(anon|authenticated)\b/.test(sql),
      false,
      'the promotion queue granted access to a browser role — hotels must never see it',
    );
  });

  test('the propose function is service-role only', () => {
    assert.match(sql, /revoke execute on function public\.staxis_propose_promotion[\s\S]*?from public, anon, authenticated/);
  });
});
