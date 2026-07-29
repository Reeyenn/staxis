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
  CLAIM_HEADLINE_MAX,
  PLAIN_TIER,
  PLAIN_TIER_UNUSED,
  PROMOTION_TTL_DAYS,
  TIER_BAR,
  countNeedingAttention,
  daysUntilExpiry,
  describeEvidence,
  expiryFrom,
  isExpired,
  isMissingRelationError,
  meetsEvidenceBar,
  plainLockReason,
  promotionJourney,
  promotionOriginLabel,
  shortClaim,
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

// ─── The card, at a glance ──────────────────────────────────────────────────
//
// The queue's only reader is the founder, and he is not an engineer. A card he
// needs three minutes to decode is a card he does not work, and an unworked
// queue is the same outcome as no privacy review at all. These hold the shape
// of a ten-second card.

/** The live pending item, verbatim: a 211-character compound sentence. The
 *  worst-case stored text this has to survive is not hypothetical. */
const LONG_CLAIM =
  "When shared PMS notes disagree with this hotel's own Knowledge hub or a remembered fact " +
  'about this hotel, the hotel\'s own information wins — and the copilot says the two ' +
  'disagree instead of silently picking one.';

describe('a card says where knowledge lives and where it is going', () => {
  test('the journey is drawn in words, never in the stored codes', () => {
    assert.deepEqual(promotionJourney(row({ source_tier: 'hotel', target_tier: 'global' })), {
      from: 'This hotel only',
      to: 'Every hotel',
    });
    assert.deepEqual(promotionJourney(row({ source_tier: 'hotel', target_tier: 'family' })), {
      from: 'This hotel only',
      to: 'Hotels on the same system',
    });
    assert.deepEqual(promotionJourney(row({ source_tier: 'family', target_tier: 'global' })), {
      from: 'Hotels on the same system',
      to: 'Every hotel',
    });
  });

  test('an authored item came from nowhere, and says so rather than inventing a home', () => {
    // source_tier is null for everything hand-written — the live pending item
    // included. Rendering that as a blank chip reads as a missing value.
    const j = promotionJourney(row({ source_tier: null, target_tier: 'global' }));
    assert.equal(j.from, PLAIN_TIER_UNUSED);
    assert.equal(j.to, 'Every hotel');
  });

  test('every label is a phrase, not a code', () => {
    const labels = [...Object.values(PLAIN_TIER), PLAIN_TIER_UNUSED];
    for (const label of labels) {
      assert.ok(label.includes(' '), `"${label}" is a bare code, not something to read`);
      assert.equal(label, label[0].toUpperCase() + label.slice(1));
    }
  });

  test('who wrote it is stated without making the reader open anything', () => {
    assert.equal(promotionOriginLabel(row({ origin: 'authored' })), 'Written by hand');
    assert.equal(promotionOriginLabel(row({ origin: 'learned' })), 'Learned from hotels');
  });
});

describe('the headline fits on the card whatever was stored', () => {
  test('a short claim is left exactly as written', () => {
    const short = 'Exp Dep means departures.';
    assert.deepEqual(shortClaim(short), { text: short, truncated: false });
  });

  test("the real 211-character claim is cut down and marked as cut", () => {
    const { text, truncated } = shortClaim(LONG_CLAIM);
    assert.equal(truncated, true);
    assert.ok(text.length <= CLAIM_HEADLINE_MAX, `headline ran to ${text.length} characters`);
    assert.match(text, /…$/);
    // The opening survives intact — a cut that mangles the first words costs
    // more than it saves.
    assert.ok(LONG_CLAIM.startsWith(text.slice(0, 60)));
  });

  test('the cut lands on a boundary, never mid-word', () => {
    const body = shortClaim(LONG_CLAIM).text.replace(/…$/, '');
    assert.ok(LONG_CLAIM.startsWith(body), 'the headline is not a clean prefix of the claim');
    // Whatever the claim continues with has to be punctuation or a space —
    // anything else means a word was sliced in half.
    const next = LONG_CLAIM.charAt(body.length);
    assert.match(next, /[\s.,;:—–]/, `cut mid-word, just before "${next}"`);
  });

  test('a claim with no spaces at all still fits', () => {
    // Nothing stops a machine-authored claim arriving as one unbroken run.
    // Falling back to the hard cap is what keeps the card from overflowing.
    const { text, truncated } = shortClaim('x'.repeat(400));
    assert.equal(truncated, true);
    assert.ok(text.length <= CLAIM_HEADLINE_MAX + 1, `headline ran to ${text.length} characters`);
  });

  test('whitespace and line breaks never become blank lines in the headline', () => {
    const { text } = shortClaim('  Two   words\n\nspread   out.  ');
    assert.equal(text, 'Two words spread out.');
  });
});

describe('the locked sentence and the full reasons are one verdict', () => {
  const FACTS_NO_FAMILY = { activeFamilyRowCount: 0 };
  const FACTS_FAMILY = { activeFamilyRowCount: 2 };

  /** Every shape that can reach a card, blocked and clear. */
  const cases: Array<{ what: string; row: PromotionRow; facts: { activeFamilyRowCount: number } }> = [
    { what: 'the live pending item', row: row({ origin: 'authored', source_tier: null, target_tier: 'global', supporting_hotel_count: 0, preconditions: ['family_row_exists'] }), facts: FACTS_NO_FAMILY },
    { what: 'the same item once family guidance exists', row: row({ origin: 'authored', target_tier: 'global', preconditions: ['family_row_exists'] }), facts: FACTS_FAMILY },
    { what: 'too few hotels', row: row({ supporting_hotel_count: 1 }), facts: FACTS_FAMILY },
    { what: 'enough hotels', row: row({ supporting_hotel_count: 2 }), facts: FACTS_FAMILY },
    { what: 'global without a holdout', row: row({ target_tier: 'global', supporting_hotel_count: 9, holdout_validated: false }), facts: FACTS_FAMILY },
    { what: 'an aggregate below the group size', row: row({ is_aggregate: true, supporting_hotel_count: 2 }), facts: FACTS_FAMILY },
    { what: 'an unknown requirement', row: row({ preconditions: ['some_future_gate'] }), facts: FACTS_FAMILY },
  ];

  test('the short sentence is empty exactly when nothing blocks approval', () => {
    // The gate is `blockedReasons.length > 0`. If the one-liner could be empty
    // while something blocks, the card would read "your call" over a dead
    // Approve button — and the founder would think Staxis was broken.
    for (const c of cases) {
      const reallyBlocked = !meetsEvidenceBar(c.row).ok || unmetPreconditions(c.row, c.facts).length > 0;
      const saysBlocked = plainLockReason(c.row, c.facts) !== '';
      assert.equal(saysBlocked, reallyBlocked, `${c.what}: the card and the gate disagree`);
    }
  });

  test('a blocked card gets one short sentence a non-engineer can act on', () => {
    for (const c of cases) {
      const line = plainLockReason(c.row, c.facts);
      if (!line) continue;
      assert.ok(line.length <= 110, `${c.what}: "${line}" is too long for one line`);
      assert.match(line, /\.$/, `${c.what}: "${line}" is not a sentence`);
      assert.equal(line.split('. ').length, 1, `${c.what}: "${line}" is more than one sentence`);
      // The card renders "Locked — <line>"; a second em dash inside makes the
      // result unparseable at a glance.
      assert.equal(line.includes('—'), false, `${c.what}: a second dash — "${line}"`);
      assert.equal(
        /\b(tier|migration|precondition|prompt|row|null|schema|RLS|eval)\b/i.test(line),
        false,
        `${c.what}: jargon leaked — "${line}"`,
      );
    }
  });

  test('the reason names the requirement that is actually missing', () => {
    const noFamily = row({ origin: 'authored', target_tier: 'global', preconditions: ['family_row_exists'] });
    assert.match(plainLockReason(noFamily, FACTS_NO_FAMILY), /shared notes/i);

    const thin = row({ supporting_hotel_count: 1 });
    assert.match(plainLockReason(thin, FACTS_FAMILY), /only 1 hotel backs this/i);
    assert.match(plainLockReason(row({ supporting_hotel_count: 0 }), FACTS_FAMILY), /only 0 hotels back this/i);

    const aggregate = row({ is_aggregate: true, supporting_hotel_count: 2 });
    assert.match(plainLockReason(aggregate, FACTS_FAMILY), /comparing hotels needs 5 behind it/i);

    const noHoldout = row({ target_tier: 'global', supporting_hotel_count: 9 });
    assert.match(plainLockReason(noHoldout, FACTS_FAMILY), /gave none of the evidence/i);
  });

  test('the evidence bar is reported before a requirement, matching the queue', () => {
    // Both wrong at once: the founder should hear the harder one first, the
    // same order the full list is built in.
    const both = row({ supporting_hotel_count: 0, preconditions: ['family_row_exists'] });
    assert.match(plainLockReason(both, FACTS_NO_FAMILY), /backs? this/i);
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
