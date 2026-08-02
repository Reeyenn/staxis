/**
 * The stable system block must stay byte-identical turn to turn.
 *
 * Anthropic caches the prompt prefix up to the cache_control breakpoint, which
 * llm.ts puts on the STABLE block only. The data-age RULE is constant per
 * deploy and belongs there; the as-of VALUE changes every turn and belongs in
 * the dynamic snapshot block.
 *
 * The plausible bug: someone appends the as-of line to `stableParts` to "make
 * sure the model sees it". Nothing visible breaks — the copilot still answers
 * correctly — but every single turn misses the prompt cache, silently
 * multiplying the input-token bill for as long as it goes unnoticed. That is
 * exactly the kind of regression a human reviewer does not catch by reading a
 * diff, so it is pinned here.
 *
 * Also pinned: the deleted "refresh the page" lie must not come back in
 * either block, and the version label must record which freshness rule ran.
 *
 * 2026-07-25: the stable block gained a DERIVED section — the hotel-identity
 * briefing, assembled from the hotel's own setup rows. Derived content is a
 * fresh way to reintroduce exactly the bug above (a room count that moves, a
 * "last updated" stamp), so the stub below now serves real property rows and
 * every assertion here runs WITH the section present. Asserting on a prompt
 * whose derived section silently failed to render would prove nothing.
 *
 * 2026-07-26 (cross-hotel chat): a THIRD prompt assembler now exists —
 * `buildPortfolioSystemPrompt`, for a company-scope person asking about every
 * hotel their company operates. It is the worst version of this hazard yet: one
 * moving value in its cached block misses the cache on every turn of a
 * conversation whose prompt is proportional to the SIZE OF THE PORTFOLIO. It is
 * policed at the bottom of this file, in the same suite, so a contributor who
 * finds the cache rule here cannot miss that it applies to both surfaces.
 *
 * 2026-07-26: and a SECOND derived section — the company rulebook (0365),
 * which renders a management company's own rules into every one of its hotels'
 * prompts. It is the same hazard again and a worse one: the block is shared by
 * every hotel in the company, so a per-turn value in it multiplies the bill
 * across the whole portfolio at once. Seeded explicitly below through the cache
 * seam, so this suite policies a prompt that genuinely contains it.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { buildSystemPrompt } from '@/lib/agent/prompts';
import type { HotelSnapshot } from '@/lib/agent/context';
import { clearHotelIdentityCache } from '@/lib/agent/hotel-identity';
import {
  clearCompanyRulebookCache,
  seedCompanyRulebookCache,
  seedCompanyRulebookCacheForOrganization,
} from '@/lib/agent/company-tier';
import { buildPortfolioSystemPrompt } from '@/lib/agent/portfolio/prompt';
import type { PortfolioSnapshot } from '@/lib/agent/portfolio/snapshot';
import { supabaseAdmin } from '@/lib/supabase-admin';

const PROPERTY_ID = '00000000-0000-0000-0000-0000000000e1';

// REAL now, on purpose. `buildSystemPrompt` renders the snapshot through
// `formatSnapshotForPrompt`, which computes the age against the wall clock and
// is not given an injectable one at that call site. So a capture time has to be
// a real offset from the present: pinned to a calendar date, `agedBy(5)` stops
// meaning "five minutes ago" the moment the date rolls over, the age renders in
// days, and the assertion below stops matching. That is exactly what happened —
// the date was pinned to 2026-07-24 and the test went red at midnight.
//
// Nothing about the assertions relies on a fixed date: they check that the
// rendered clock and age appear in the DYNAMIC block and never in the stable
// one, which is true at any hour.
const NOW = new Date();

// Every buildSystemPrompt call below passes NOW explicitly. Without that, the
// fixture's capture time is pinned but its AGE is measured against the wall
// clock, so the rendered wording drifts as real time passes and the assertions
// slowly come to mean something else. This suite passed all day on 2026-07-24
// and went red overnight on unchanged code, once agedBy(5) aged past a day and
// started rendering as days rather than "5 min ago".

function agedBy(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

function snapshot(capturedAt: string): HotelSnapshot {
  return {
    today: NOW.toISOString().slice(0, 10),
    property: {
      id: PROPERTY_ID,
      name: 'Comfort Suites',
      timezone: 'America/Chicago',
    },
    rooms: {
      total: 88, dirty: 12, in_progress: 0, clean: 14, dnd: 0, issuesFlagged: 0,
      helpRequested: 0, checkouts: 9, stayovers: 21, inHouse: 62, outOfOrder: 0,
      seedingGap: 0,
    },
    staff: { activeToday: 4, assignedHousekeepers: 3 },
    pmsDataSource: 'snapshot_capture',
    pmsDataCapturedAt: capturedAt,
  };
}

// buildSystemPrompt resolves prompts from the DB with a fail-soft fallback to
// the constants, and derives the hotel-identity section from the hotel's own
// setup rows. Stub both reads so the test never depends on the network.
//
// `properties` and `staff` return real rows on purpose: with empty tables the
// identity section renders NOTHING (that is its day-zero contract), and every
// assertion below would then be checking a prompt that no longer contains the
// derived content it exists to police.
const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);

const FIXTURE_ROWS: Record<string, Array<Record<string, unknown>>> = {
  properties: [{
    id: PROPERTY_ID,
    name: 'Comfort Suites',
    timezone: 'America/Chicago',
    total_rooms: 88,
    property_kind: 'limited_service',
    brand: 'Choice',
    business_date_cutoff_hour: 0,
    housekeeping_setup: {
      version: 1,
      completedAt: '2026-07-01T00:00:00.000Z',
      level: 1,
      recommendedLevel: 1,
      statusEntry: 'housekeeper_radio',
      checkoutMinutes: 30,
      stayoverMinutes: 20,
      shiftStartTime: '08:00',
      boardBuiltBy: 'gm',
      inspection: 'every_room',
      sideDuties: ['laundry'],
      boardPhotoPath: null,
    },
  }],
  staff: [
    { property_id: PROPERTY_ID, department: 'housekeeping', language: 'es', can_inspect: false, is_active: true },
    { property_id: PROPERTY_ID, department: 'front_desk', language: 'en', can_inspect: false, is_active: true },
  ],
};

before(() => {
  // @ts-expect-error monkey-patch the singleton for the test
  supabaseAdmin.from = (table: string) => {
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: FIXTURE_ROWS[table] ?? [], error: null }).then(resolve),
    };
    return chain;
  };
  clearHotelIdentityCache();
  // The company tier is seeded rather than discovered: the `from` stub above
  // has no `.in()`, so a real derivation would fail softly and quietly render
  // nothing — and every assertion below would then be policing a prompt without
  // the section it exists to police.
  seedCompanyRulebookCache(PROPERTY_ID, {
    organizationId: '00000000-0000-0000-0000-0000000000c1',
    facts: [
      {
        id: 'f1', organizationId: '00000000-0000-0000-0000-0000000000c1',
        topic: 'chemical_vendor', content: 'All our hotels use Ecolab for chemicals.',
        category: 'vendors', source: 'explicit_user', reviewState: 'confirmed',
        policyKey: null, policyValue: null, createdByName: 'Ana',
        updatedAt: '2026-07-20T00:00:00.000Z',
      },
      {
        id: 'f2', organizationId: '00000000-0000-0000-0000-0000000000c1',
        topic: 'po_threshold', content: 'Orders over $500 need VP sign-off.',
        category: 'money', source: 'explicit_user', reviewState: 'confirmed',
        policyKey: null, policyValue: null, createdByName: 'Ana',
        updatedAt: '2026-07-21T00:00:00.000Z',
      },
    ],
  });
});
after(() => {
  supabaseAdmin.from = originalFrom;
  clearHotelIdentityCache();
  clearCompanyRulebookCache();
});

describe('prompt cache purity', () => {
  it('the derived hotel-identity section really is in the block being policed', async () => {
    // Guards every other assertion in this file: if the derivation silently
    // stopped rendering, "the stable block carries no clock" would become true
    // for the boring reason that it carries almost nothing.
    const { stable } = await buildSystemPrompt({ role: 'general_manager', snapshot: snapshot(agedBy(5)), conversationId: 'conv-1', now: NOW });
    assert.match(stable, /About this hotel/);
    assert.match(stable, /Housekeeping runs at Level 1/);
    assert.match(stable, /Roster: 2 active staff members/);
  });

  it('the derived COMPANY section really is in the block being policed too', async () => {
    const { stable } = await buildSystemPrompt({ role: 'general_manager', snapshot: snapshot(agedBy(5)), conversationId: 'conv-1', now: NOW });
    assert.match(stable, /Company rulebook/);
    assert.match(stable, /All our hotels use Ecolab for chemicals\./);
    assert.match(stable, /Orders over \$500 need VP sign-off\./);
  });

  it('never sends the company rulebook to line-role hotel prompts', async () => {
    for (const role of ['front_desk', 'maintenance'] as const) {
      const { stable, factual } = await buildSystemPrompt({ role, snapshot: snapshot(agedBy(5)), conversationId: `conv-line-${role}`, now: NOW, authorization: { seesFinancials: false, hotelMutationAllowed: role === 'front_desk' } });
      for (const block of [stable, factual]) {
        assert.equal(/Company rulebook/.test(block), false, `${role} received the company tier`);
        assert.equal(/Ecolab/.test(block), false, `${role} received company vendor knowledge`);
        assert.equal(/\$500/.test(block), false, `${role} received company money knowledge`);
      }
    }
  });

  it('the company block carries no clock, no age, no count and no "updated"', async () => {
    // The worst version of the cache bug: this block is shared by every hotel
    // the company operates, so one moving value in it misses the cache on every
    // turn of every conversation across the whole portfolio at once.
    const { stable } = await buildSystemPrompt({ role: 'general_manager', snapshot: snapshot(agedBy(5)), conversationId: 'conv-1', now: NOW });
    const block = stable.slice(
      stable.indexOf('Company rulebook'),
      stable.indexOf('</staxis-company-rulebook>'),
    );
    assert.ok(block.length > 0, 'the company section is present');
    assert.equal(/\b(min|hr|days?) ago\b/i.test(block), false);
    assert.equal(/\b(last updated|as of|edited)\b/i.test(block), false);
    // No fact count, and no timestamp from the seeded rows.
    assert.equal(/2026-07-2\d/.test(block), false);
    assert.equal(/\b2 (rules?|facts?|lines?)\b/i.test(block), false);
  });

  it('the company tier sits between the shared PMS notes and the hotel itself', async () => {
    // Assembly order IS the conflict rule (later text wins). Reordering these
    // three silently changes which fact the model believes, and nothing else in
    // the suite would notice.
    const { stable } = await buildSystemPrompt({ role: 'general_manager', snapshot: snapshot(agedBy(5)), conversationId: 'conv-1', now: NOW });
    assert.ok(stable.indexOf('How old the numbers are') < stable.indexOf('Company rulebook'));
    assert.ok(stable.indexOf('Company rulebook') < stable.indexOf('About this hotel'));
  });

  it('two snapshots 40 minutes apart produce byte-identical stable blocks', async () => {
    const a = await buildSystemPrompt({ role: 'general_manager', snapshot: snapshot(agedBy(5)), conversationId: 'conv-1', now: NOW });
    const b = await buildSystemPrompt({ role: 'general_manager', snapshot: snapshot(agedBy(45)), conversationId: 'conv-1', now: NOW });
    assert.equal(a.stable, b.stable);
    // …and the dynamic blocks genuinely differ, or the assertion above would
    // be vacuously true for a build that dropped the as-of line entirely.
    assert.notEqual(a.dynamic, b.dynamic);
  });

  it('the stable block carries the RULE but never a clock or an age', async () => {
    const { stable, dynamic } = await buildSystemPrompt({ role: 'general_manager', snapshot: snapshot(agedBy(5)), conversationId: 'conv-1', now: NOW });
    assert.match(stable, /How old the numbers are/);
    assert.match(stable, /snapshot is NOT live/);

    // The rendered per-turn values must appear only in the dynamic block.
    const captured = /PMS data as of ([^(]+) \(/.exec(dynamic)?.[1]?.trim();
    const age = /, (\d+ min ago|just now|\d+ hr[^—.]*ago)/.exec(dynamic)?.[1];
    assert.ok(captured && captured.length > 0, 'dynamic block renders a clock time');
    assert.ok(age && age.length > 0, 'dynamic block renders an age');
    assert.equal(stable.includes(captured), false, `stable block leaked the clock "${captured}"`);
    assert.equal(stable.includes(age), false, `stable block leaked the age "${age}"`);
    // "min ago" / "hr ago" wording is inherently per-turn — it has no business
    // in a constant rule regardless of the values above.
    assert.equal(/\b(min|hr|days?) ago\b/i.test(stable), false);
  });

  it('applies to every role, including one without the inventory addendum', async () => {
    const a = await buildSystemPrompt({ role: 'housekeeping', snapshot: snapshot(agedBy(5)), conversationId: 'conv-2', now: NOW });
    const b = await buildSystemPrompt({ role: 'housekeeping', snapshot: snapshot(agedBy(45)), conversationId: 'conv-2', now: NOW });
    assert.equal(a.stable, b.stable);
    assert.match(a.stable, /How old the numbers are/);
  });
});

describe('the refresh-the-page lie is gone', () => {
  it('appears in neither block', async () => {
    const { stable, dynamic } = await buildSystemPrompt({ role: 'general_manager', snapshot: snapshot(agedBy(5)), conversationId: 'conv-1', now: NOW });
    // The deleted sentence, both halves of it.
    assert.equal(/suggest they refresh the page/i.test(stable + dynamic), false);
    assert.equal(/rebuilt every turn from live data/i.test(stable + dynamic), false);
    // The dynamic snapshot block must not mention refreshing at all — the
    // only surviving mention anywhere is the stable rule FORBIDDING it.
    assert.equal(/refresh/i.test(dynamic), false);
  });

  it('the stable rule explicitly forbids it instead', async () => {
    const { stable } = await buildSystemPrompt({ role: 'owner', snapshot: snapshot(agedBy(5)), conversationId: 'conv-1', now: NOW });
    assert.match(stable, /NEVER tell the user to refresh/i);
  });
});

// ─── The portfolio surface, under the same rule ─────────────────────────────

const PORTFOLIO_ORG_ID = '00000000-0000-0000-0000-0000000000c2';
const PORTFOLIO_PID_B = '00000000-0000-0000-0000-0000000000e2';

function portfolioSnapshot(minutesOld: number): PortfolioSnapshot {
  return {
    organizationId: PORTFOLIO_ORG_ID,
    hotels: [
      {
        propertyId: PROPERTY_ID,
        name: 'Comfort Suites',
        totalRooms: 88,
        timezone: 'America/Chicago',
        openFindings: 2,
        needsDecision: 1,
        pmsCapturedAt: agedBy(minutesOld),
        pmsSource: 'snapshot_capture',
      },
      {
        propertyId: PORTFOLIO_PID_B,
        name: 'Lufkin Inn',
        totalRooms: 45,
        timezone: 'America/Chicago',
        openFindings: 0,
        needsDecision: 0,
        pmsCapturedAt: null,
        pmsSource: null,
      },
    ],
    omittedHotelCount: 0,
    failedHotelCount: 0,
  };
}

const PORTFOLIO_IDENTITY = {
  organizationId: PORTFOLIO_ORG_ID,
  organizationName: 'Gulf Coast Hotels',
  hotels: [
    { id: PROPERTY_ID, name: 'Comfort Suites', totalRooms: 88, timezone: 'America/Chicago' },
    { id: PORTFOLIO_PID_B, name: 'Lufkin Inn', totalRooms: 45, timezone: 'America/Chicago' },
  ],
  omittedHotelCount: 0,
};

describe('prompt cache purity — the portfolio surface', () => {
  before(() => {
    // Seeded at ORGANIZATION scope, which is how the portfolio assembler reads
    // the rulebook. Without it the company section renders nothing and the
    // assertions below would be policing a prompt missing its riskiest block.
    seedCompanyRulebookCacheForOrganization(PORTFOLIO_ORG_ID, {
      organizationId: PORTFOLIO_ORG_ID,
      facts: [{
        id: 'p1', organizationId: PORTFOLIO_ORG_ID,
        topic: 'chemical_vendor', content: 'All our hotels use Ecolab for chemicals.',
        category: 'vendors', source: 'explicit_user', reviewState: 'confirmed',
        policyKey: null, policyValue: null, createdByName: 'Ana',
        updatedAt: '2026-07-20T00:00:00.000Z',
      }],
    });
  });

  it('the derived portfolio sections really are in the block being policed', async () => {
    const { stable } = await buildPortfolioSystemPrompt({
      identity: PORTFOLIO_IDENTITY, companyRole: 'vp',
      snapshot: portfolioSnapshot(5), conversationId: 'conv-p', now: NOW,
    });
    assert.match(stable, /The hotels you are being asked about/);
    assert.match(stable, /Company rulebook/);
    assert.match(stable, /Comfort Suites — 88 rooms/);
  });

  it('two turns 40 minutes apart produce byte-identical stable blocks', async () => {
    const a = await buildPortfolioSystemPrompt({
      identity: PORTFOLIO_IDENTITY, companyRole: 'vp',
      snapshot: portfolioSnapshot(5), conversationId: 'conv-p', now: NOW,
    });
    const b = await buildPortfolioSystemPrompt({
      identity: PORTFOLIO_IDENTITY, companyRole: 'vp',
      snapshot: portfolioSnapshot(45), conversationId: 'conv-p', now: NOW,
    });
    assert.equal(a.stable, b.stable);
    assert.notEqual(a.dynamic, b.dynamic);
  });

  it('the cached block carries no clock, no age and no live count', async () => {
    const { stable, dynamic } = await buildPortfolioSystemPrompt({
      identity: PORTFOLIO_IDENTITY, companyRole: 'vp',
      snapshot: portfolioSnapshot(5), conversationId: 'conv-p', now: NOW,
    });
    const captured = /PMS data as of ([^(]+) \(/.exec(dynamic)?.[1]?.trim();
    assert.ok(captured && captured.length > 0, 'the dynamic block renders a clock time');
    assert.equal(stable.includes(captured), false, `stable leaked the clock "${captured}"`);
    assert.equal(/\b(min|hr|days?) ago\b/i.test(stable), false);
    assert.equal(/open item/i.test(stable), false);
  });
});

describe('version label', () => {
  it('records the freshness rule so the behaviour change is auditable', async () => {
    const gm = await buildSystemPrompt({ role: 'general_manager', snapshot: snapshot(agedBy(5)), conversationId: 'conv-1', now: NOW });
    assert.match(gm.versionLabel, /data-freshness-v1/);
    // A3 split the stamp in two: `stableStamp` is what gets PRINTED (constant
    // for the conversation), `versionLabel` is what gets PERSISTED and carries
    // the per-turn memory receipt. Printing the persisted one would break the
    // prompt cache every turn — see agent-prompt-tiers.test.ts.
    assert.ok(gm.stable.includes(`Prompt version: ${gm.stableStamp}`));
    // Every role gets the rule, so every role's label carries the version.
    const hk = await buildSystemPrompt({ role: 'housekeeping', snapshot: snapshot(agedBy(5)), conversationId: 'conv-1', now: NOW });
    assert.match(hk.versionLabel, /data-freshness-v1/);
    // The pre-existing inventory routing version is not displaced by it.
    assert.match(gm.versionLabel, /inventory-accounting-v2/);
    assert.equal(/inventory-accounting-v2/.test(hk.versionLabel), false);
  });

  it('records the company tier only when a company block was actually rendered', async () => {
    const withCompany = await buildSystemPrompt({ role: 'general_manager', snapshot: snapshot(agedBy(5)), conversationId: 'conv-1', now: NOW });
    assert.match(withCompany.stableStamp, /company-rulebook-v2/);

    // An independent hotel gets no section, so its stamp must not claim one —
    // otherwise "which rules was this turn run under" is answered with a lie.
    seedCompanyRulebookCache(PROPERTY_ID, null);
    const independent = await buildSystemPrompt({ role: 'general_manager', snapshot: snapshot(agedBy(5)), conversationId: 'conv-1', now: NOW });
    assert.equal(/company-rulebook-v2/.test(independent.stableStamp), false);
    assert.equal(/Company rulebook/.test(independent.stable), false);
  });
});
