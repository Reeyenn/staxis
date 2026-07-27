/**
 * What a Shared-knowledge approval card shows BEFORE anyone clicks anything.
 *
 * The queue's only reader is the founder, and he is not an engineer. The first
 * version of this card printed a 211-character claim, the migration it was
 * written in, which base-prompt version it had been re-pointed to, and a named
 * constant from the codebase — on the card's face, for a yes/no decision about
 * one hotel's data reaching hotels that never supplied it. It took about three
 * minutes to decode. A queue that expensive is a queue nobody works, and an
 * unworked privacy queue is the same outcome as no privacy review at all.
 *
 * So these hold the FACE of a card, which is the part that has to survive
 * future edits:
 *   · what is on it — headline, the drawn tier journey, reach, one status line
 *   · what is NOT on it — the full claim, the provenance paragraph, the long
 *     blocking reasons; all still present, all folded into Details
 *   · that "locked" and "your call" can never be shown over the wrong button
 *
 * The gate itself (`blockedReasons.length > 0` disabling Approve) is unchanged
 * by the redesign and is covered in promotion-queue.test.ts. Nothing here
 * decides anything; it is all wording and layout.
 *
 * HOW IT RUNS. `npm test` runs under `--conditions=react-server`, where
 * react-dom/server will not load, so the house pattern applies: PromotionSummary
 * is hook-free, it is called as a plain function, and the element tree it
 * returns is walked. Same approach as mission-control-ai-staff-roster.test.ts.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';

import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import Module from 'node:module';
import type React from 'react';

import {
  plainLockReason,
  promotionJourney,
  promotionOriginLabel,
  shortClaim,
  unmetPreconditions,
  type PromotionRow,
} from '@/lib/promotion-queue';

// ── Why the React shim ──────────────────────────────────────────────────────
// React 19's react-server build exports no createContext, and this surface's
// import chain reaches the browser Supabase client at module load. Nothing here
// mounts a hooks-using component — only the hook-free PromotionSummary is
// called — so a stub context is enough to get the module loaded. Installed on
// the LIVE `react` module object (not an esbuild namespace copy), hence
// createRequire; same shim, same reasons, as concourse-queue-honesty.test.ts.
const nodeRequire = Module.createRequire(`${process.cwd()}/package.json`);

type QueueModule = typeof import('@/app/admin/_components/studio/surfaces/PromotionQueue');
type PromotionView = QueueModule['PromotionSummary'] extends (p: { p: infer V; live?: boolean }) => unknown
  ? V
  : never;

let queue: QueueModule;
let R: typeof import('react');

before(async () => {
  const react = nodeRequire('react') as Record<string, unknown>;
  if (typeof react.createContext !== 'function') {
    react.createContext = (defaultValue: unknown) => ({
      Provider: () => null,
      Consumer: () => null,
      _currentValue: defaultValue,
    });
  }
  R = react as unknown as typeof import('react');
  queue = await import('@/app/admin/_components/studio/surfaces/PromotionQueue');
});

// ─── Tree walking ───────────────────────────────────────────────────────────

type AnyProps = Record<string, unknown> & { children?: React.ReactNode };

/** The card's own child pieces (TierJourney, StatusLine, Pill, Dot) are plain
 *  hook-free functions, so the walk runs them rather than stopping at the
 *  element — a walk that stopped would see an empty card and pass everything
 *  below by default. */
function isComponent(type: unknown): type is (p: AnyProps) => React.ReactNode {
  return typeof type === 'function';
}

/** Exactly what a reader sees: text children only, in order, no props. Used for
 *  the "this is NOT on the card" checks, where a string prop leaking in would
 *  quietly turn a real absence into a false pass. */
function visibleText(node: React.ReactNode, out: string[] = []): string[] {
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((child) => visibleText(child, out));
    return out;
  }
  if (R.isValidElement<AnyProps>(node)) {
    if (isComponent(node.type)) visibleText(node.type(node.props), out);
    else visibleText(node.props.children, out);
  }
  return out;
}

/** The rendered face of a card, whitespace-normalised. */
function faceOf(tree: React.ReactNode): string {
  return visibleText(tree).join('').replace(/\s+/g, ' ').trim();
}

/** Every string prop in the tree — where aria-label and the like live. */
function propStrings(node: React.ReactNode, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    node.forEach((child) => propStrings(child, out));
    return out;
  }
  if (R.isValidElement<AnyProps>(node)) {
    for (const [key, value] of Object.entries(node.props)) {
      if (key !== 'children' && typeof value === 'string') out.push(value);
    }
    if (isComponent(node.type)) propStrings(node.type(node.props), out);
    else propStrings(node.props.children, out);
  }
  return out;
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** The live pending item, verbatim — a 211-character compound sentence and a
 *  574-character paragraph of migration and version archaeology. This is the
 *  card the founder was actually looking at. */
const LONG_CLAIM =
  "When shared PMS notes disagree with this hotel's own Knowledge hub or a remembered fact " +
  "about this hotel, the hotel's own information wins — and the copilot says the two " +
  'disagree instead of silently picking one.';

const BACKGROUND =
  'Authored in migration 0338 and left switched off. Re-pointed 2026-07-26 from base ' +
  '2026.07.24-v10 to 2026.07.26-v12: the original target was built on the 2026.06.03-v7 ' +
  'base text, so approving it would have reverted the live base prompt.';

function promotionRow(over: Partial<PromotionRow> = {}): PromotionRow {
  return {
    id: 'p1', topic: 'base_prompt_pms_context_clause', claim: LONG_CLAIM,
    evidence_summary: BACKGROUND, proposed_content: 'PMS CONTEXT\n…', final_content: null,
    source_tier: null, target_tier: 'global', pms_family: null,
    origin: 'authored', source_kind: 'migration', source_ref: '0338',
    source_property_ids: [], supporting_hotel_count: 0, observation_count: 0,
    evidence_window_start: null, evidence_window_end: null,
    holdout_validated: false, is_aggregate: false,
    preconditions: [], target_table: 'agent_prompts', target_row_id: 'a1',
    previous_target_row_id: null, status: 'pending',
    decided_at: null, decided_by_account_id: null, decision_note: null,
    approved_at: null, expires_at: null, reconfirmed_at: null, reconfirm_count: 0,
    retracted_at: null, applied_property_ids: [],
    created_at: '2026-07-01T00:00:00.000Z', updated_at: '2026-07-01T00:00:00.000Z',
    ...over,
  };
}

const HOTELS = ['Comfort Suites Beaumont', 'Test Hotel', 'Sleep Inn', 'Quality Inn', 'Econo Lodge']
  .map((name, i) => ({ id: `h${i}`, name }));

/**
 * What the endpoint hands one card. The display fields are computed with the
 * SAME functions the route uses, so this stays a test of the real pipeline
 * rather than of hand-written strings.
 */
function view(row: PromotionRow, facts = { activeFamilyRowCount: 2 }): PromotionView {
  const head = shortClaim(row.claim);
  return {
    id: row.id,
    topic: row.topic,
    claim: row.claim,
    evidenceSummary: row.evidence_summary,
    proposedContent: row.proposed_content,
    liveContent: row.final_content,
    status: row.status,
    origin: row.origin,
    headline: head.text,
    headlineTruncated: head.truncated,
    originLabel: promotionOriginLabel(row),
    journey: promotionJourney(row),
    lockReason: plainLockReason(row, facts),
    audience: 'Every hotel',
    cameFrom: 'Written by hand during a build (0338)',
    evidence: 'Written by hand',
    supportingHotels: row.supporting_hotel_count,
    observations: row.observation_count,
    isAggregate: row.is_aggregate,
    barReason: '',
    blockedReasons: unmetPreconditions(row, facts),
    expired: false,
    daysLeft: null,
    reconfirmCount: row.reconfirm_count,
    approvedAt: row.approved_at,
    decidedAt: row.decided_at,
    decisionNote: row.decision_note,
    blastRadius: { count: HOTELS.length, hotels: HOTELS },
    changesBehaviour: row.target_table === 'agent_prompts',
    createdAt: row.created_at,
  } as PromotionView;
}

function faceOfCard(p: PromotionView, live = false): string {
  return faceOf(queue.PromotionSummary({ p, live }));
}

// ─── 1. ready ───────────────────────────────────────────────────────────────

describe('a card that is his to decide', () => {
  const ready = () => view(promotionRow({ preconditions: [] }));

  test('says so in two words, and says nothing is in the way', () => {
    const face = faceOfCard(ready());
    assert.match(face, /Your call/);
    assert.match(face, /Nothing is blocking it/);
    assert.equal(/Locked/.test(face), false, 'a decidable card claimed to be locked');
  });

  test('draws where the knowledge is going', () => {
    const face = faceOfCard(ready());
    assert.match(face, /Not in use yet/);
    assert.match(face, /Every hotel/);
  });

  test('states the reach once, quietly, without listing the hotels', () => {
    const face = faceOfCard(ready());
    assert.match(face, /Would reach 5 hotels/);
    for (const h of HOTELS) {
      assert.equal(face.includes(h.name), false, `${h.name} was named on the card's face`);
    }
  });

  test('one hotel is not "1 hotels"', () => {
    const p = { ...ready(), blastRadius: { count: 1, hotels: [HOTELS[0]] } };
    assert.match(faceOfCard(p), /Would reach 1 hotel(?!s)/);
  });

  test('the journey reads as a sentence for a screen reader', () => {
    const labels = propStrings(queue.PromotionSummary({ p: ready() }));
    assert.ok(
      labels.some((l) => /Moving from Not in use yet to Every hotel/.test(l)),
      'the arrow carries the meaning visually but announces nothing',
    );
  });
});

// ─── 2. locked ──────────────────────────────────────────────────────────────

describe('a card that is not his to decide yet', () => {
  const locked = () =>
    view(promotionRow({ preconditions: ['family_row_exists'] }), { activeFamilyRowCount: 0 });

  test('leads with the word Locked and one plain sentence', () => {
    const p = locked();
    assert.ok(p.blockedReasons.length > 0, 'fixture is not actually blocked');

    const face = faceOfCard(p);
    assert.match(face, /Locked/);
    assert.match(face, /no shared notes are switched on yet/i);
    assert.equal(/Your call/.test(face), false, 'a blocked card offered itself for decision');
  });

  test('the long blocking reason stays behind Details', () => {
    // The full reason names PMS-family instructions and a section that never
    // renders. True, needed for the record, and not what belongs on the face.
    const p = locked();
    const face = faceOfCard(p);
    for (const reason of p.blockedReasons) {
      assert.equal(face.includes(reason), false, `the full reason was printed on the face: ${reason}`);
    }
  });

  test('the short sentence and the disabled button always agree', () => {
    // Approve is gated on blockedReasons; the founder reads lockReason. If
    // these could ever disagree the card would say "your call" over a dead
    // button, which reads as Staxis being broken.
    for (const facts of [{ activeFamilyRowCount: 0 }, { activeFamilyRowCount: 3 }]) {
      const p = view(promotionRow({ preconditions: ['family_row_exists'] }), facts);
      const face = faceOfCard(p);
      assert.equal(p.blockedReasons.length > 0, /Locked/.test(face));
      assert.equal(p.blockedReasons.length === 0, /Your call/.test(face));
    }
  });
});

// ─── 3. worst-case stored text ──────────────────────────────────────────────

describe('a card whose stored text is far too long', () => {
  test('the headline is the shortened claim, never the whole paragraph', () => {
    const p = view(promotionRow());
    assert.equal(p.headlineTruncated, true, 'fixture is not actually long');

    const face = faceOfCard(p);
    assert.match(face, /When shared PMS notes disagree/);
    assert.equal(face.includes(LONG_CLAIM), false, 'the full 211-character claim reached the face');
    assert.match(face, /…/);
  });

  test('the migration and version history never reach the face', () => {
    const face = faceOfCard(view(promotionRow()));
    assert.equal(face.includes(BACKGROUND), false);
    for (const jargon of ['0338', '2026.07.24-v10', 'migration', 'base prompt']) {
      assert.equal(face.includes(jargon), false, `"${jargon}" survived onto the card's face`);
    }
  });

  test('the whole face stays short enough to take in at a glance', () => {
    // The old card ran past 700 characters of prose. This is the ceiling that
    // keeps it a ten-second read.
    const face = faceOfCard(view(promotionRow()));
    assert.ok(face.length < 260, `the card's face is back up to ${face.length} characters:\n${face}`);
  });

  test('a claim with no spaces at all cannot widen the card', () => {
    const p = view(promotionRow({ claim: 'x'.repeat(400) }));
    assert.ok(p.headline.length < 130, `headline ran to ${p.headline.length} characters`);
  });
});

// ─── 4. nothing was deleted, only folded ────────────────────────────────────

describe('everything taken off the face is still on the card', () => {
  // The queue exists so a privacy decision leaves a record. A redesign that
  // quietly dropped the provenance would be a worse outcome than the card
  // nobody could read, because it would not look like a regression.
  const p = () => view(promotionRow({ preconditions: ['family_row_exists'] }), { activeFamilyRowCount: 0 });

  function detailsOf(v: PromotionView): string {
    return faceOf(queue.PromotionDetails({ p: v }));
  }

  test('the claim the headline cut short is carried in full', () => {
    assert.ok(detailsOf(p()).includes(LONG_CLAIM), 'the full claim is nowhere on the card');
  });

  test('the provenance paragraph survives verbatim', () => {
    const details = detailsOf(p());
    assert.ok(details.includes(BACKGROUND), 'the background paragraph was dropped');
    assert.match(details, /Written by hand during a build \(0338\)/);
  });

  test('the full blocking reasons survive, not just the short sentence', () => {
    const v = p();
    const details = detailsOf(v);
    for (const reason of v.blockedReasons) {
      assert.ok(details.includes(reason), `a blocking reason was dropped: ${reason}`);
    }
  });

  test('every hotel it would reach is named', () => {
    const details = detailsOf(p());
    for (const h of HOTELS) {
      assert.ok(details.includes(h.name), `${h.name} was dropped from the card`);
    }
  });

  test('a live card says who relied on it, not who it would reach', () => {
    const live = { ...view(promotionRow({ status: 'approved' })) } as PromotionView;
    const details = faceOf(queue.PromotionDetails({ p: live, live: true }));
    assert.match(details, /Who relied on this/i);
  });

  test('the wording block the caller supplies is kept', () => {
    const tree = queue.PromotionDetails({ p: p(), children: 'THE EXACT WORDING' });
    assert.match(faceOf(tree), /THE EXACT WORDING/);
  });
});

// ─── 5. already shared ──────────────────────────────────────────────────────

describe('a card for knowledge that is already out there', () => {
  const live = (over: Partial<PromotionView> = {}) =>
    ({ ...view(promotionRow({ status: 'approved' })), ...over }) as PromotionView;

  test('reports what it reaches, not what it would reach', () => {
    const face = faceOfCard(live({ daysLeft: 30 }), true);
    assert.match(face, /Reaches 5 hotels/);
    assert.equal(/Would reach/.test(face), false);
    assert.equal(/Your call/.test(face), false, 'a live card asked to be decided again');
  });

  test('an item past its date asks for a look instead of reading as fine', () => {
    const face = faceOfCard(live({ expired: true }), true);
    assert.match(face, /Needs a look/);
    assert.match(face, /still true/i);
  });

  test('a healthy item says when it is next due', () => {
    const face = faceOfCard(live({ daysLeft: 12 }), true);
    assert.match(face, /Live/);
    assert.match(face, /12 days/);
  });
});
