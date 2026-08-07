/**
 * THE AI'S SAFETY RULES MUST GOVERN EVERY PIPELINE, NOT ONE OF THEM.
 *
 * Staxis calls a foundation model from three places: the hotel chat, the
 * guided walkthrough, and the portfolio chat. Until 2026-08-01 the data-age
 * rule and the number-honesty rule were defined inside the hotel chat's own
 * assembler, and the walkthrough — which renders a live occupancy figure to a
 * manager while driving them around their app — had neither of them. Nothing
 * was visibly broken. A prompt missing a section still answers.
 *
 * ─── WHAT THIS FILE IS FOR, AND WHY IT IS WRITTEN THIS WAY ─────────────────
 *
 * The tests below are DATA-DRIVEN over `CODE_OWNED_RULE_TIERS`. That is the
 * whole design and not a stylistic choice: a test that names "data freshness"
 * and "number honesty" would pass forever while a THIRD rule added tomorrow
 * reached one pipeline and not the others — which is exactly the failure that
 * already happened once. Iterating the registry means the assertion grows by
 * itself, and a rule added to `rule-tiers.ts` is automatically required in all
 * three assemblers with no edit here.
 *
 * The bar for the last describe block: "would this fail if somebody built a
 * FOURTH pipeline and skipped the rulebook?" It would — the inventory pins the
 * set of functions that produce a system prompt, so a new one is a red test and
 * a deliberate decision rather than a silent omission.
 *
 * Run via: npx tsx --test src/lib/__tests__/agent-shared-rule-tiers.test.ts
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder';

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { supabaseAdmin } from '@/lib/supabase-admin';
import type { HotelSnapshot } from '@/lib/agent/context';
import { clearHotelIdentityCache } from '@/lib/agent/hotel-identity';
import { clearCompanyRulebookCache } from '@/lib/agent/company-tier';
import { buildSystemPrompt } from '@/lib/agent/prompts';
import { buildPortfolioSystemPrompt } from '@/lib/agent/portfolio/prompt';
import { buildSystemPrompt as buildWalkthroughPrompt } from '@/lib/walkthrough-step';
import {
  CODE_OWNED_RULE_TIERS,
  exactHotelScope,
} from '@/lib/agent/rule-tiers';
import { HOTEL_RULES_HEADER, HOTEL_RULES_VERSION } from '@/lib/agent/hotel-rules-tier';
import { clearStandingRulesCache, seedStandingRules, type StandingRule } from '@/lib/companion/rules';
import type { SystemPromptBlocks } from '@/lib/agent/prompts';

const PID_ONE = '00000000-0000-0000-0000-0000000000e1';
const PID_TWO = '00000000-0000-0000-0000-0000000000e2';
const ORG_ID = '00000000-0000-0000-0000-0000000000e9';
const NOW = new Date();

const THE_RULE = 'Always check with me before promising a late checkout.';

function standingRule(propertyId: string): StandingRule {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    propertyId,
    ruleText: THE_RULE,
    createdByAccountId: null,
    createdByName: 'Maria',
    createdByRole: 'general_manager',
    createdAt: '2026-07-30T12:00:00.000Z',
  };
}

function hotelSnapshot(): HotelSnapshot {
  return {
    today: NOW.toISOString().slice(0, 10),
    property: {
      id: PID_ONE,
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
    pmsDataCapturedAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(),
  };
}

const FIXTURE_ROWS: Record<string, Array<Record<string, unknown>>> = {
  properties: [{
    id: PID_ONE,
    name: 'Comfort Suites',
    timezone: 'America/Chicago',
    total_rooms: 88,
    property_kind: 'limited_service',
    brand: 'Choice',
    business_date_cutoff_hour: 0,
  }],
  staff: [
    { property_id: PID_ONE, department: 'housekeeping', language: 'es', can_inspect: false, is_active: true },
  ],
};

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);

const IDENTITY_ONE_HOTEL = {
  organizationId: ORG_ID,
  organizationName: 'Gulf Coast Hotels',
  hotels: [{ id: PID_ONE, name: 'Comfort Suites', totalRooms: 88, timezone: 'America/Chicago' }],
  omittedHotelCount: 0,
  authorizedHotelCount: 1,
  scopeLabel: 'Comfort Suites',
};

const IDENTITY_TWO_HOTELS = {
  ...IDENTITY_ONE_HOTEL,
  hotels: [
    { id: PID_ONE, name: 'Comfort Suites', totalRooms: 88, timezone: 'America/Chicago' },
    { id: PID_TWO, name: 'Lufkin Inn', totalRooms: 45, timezone: 'America/Chicago' },
  ],
  authorizedHotelCount: 2,
  scopeLabel: 'Gulf Coast Hotels',
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
  // Seeded rather than discovered: the `from` stub cannot serve the real query,
  // so a live derivation would fail softly and render nothing — and every
  // assertion about the standing-rules tier would then be passing for the
  // boring reason that no rule existed anywhere.
  seedStandingRules(PID_ONE, [standingRule(PID_ONE)]);
  seedStandingRules(PID_TWO, [standingRule(PID_TWO)]);
});

after(() => {
  supabaseAdmin.from = originalFrom;
  clearHotelIdentityCache();
  clearCompanyRulebookCache();
  clearStandingRulesCache();
});

// ─── The three pipelines, each built the way its route builds it ────────────

function hotelChatPrompt(): Promise<SystemPromptBlocks> {
  return buildSystemPrompt({
    role: 'general_manager',
    snapshot: hotelSnapshot(),
    conversationId: 'conv-shared-tiers',
    now: NOW,
  });
}

function walkthroughPrompt(): Promise<SystemPromptBlocks> {
  return buildWalkthroughPrompt({
    role: 'general_manager',
    task: 'help me add a housekeeper',
    propertyId: PID_ONE,
    hotelContext: '<staxis-snapshot trust="system">Rooms: 88 total</staxis-snapshot>',
  });
}

function portfolioPrompt(identity = IDENTITY_ONE_HOTEL): Promise<SystemPromptBlocks> {
  return buildPortfolioSystemPrompt({
    identity,
    companyRole: 'regional_manager',
    conversationId: 'conv-portfolio-shared-tiers',
    companyKnowledgeMode: 'external_overlay',
    now: NOW,
  });
}

const PIPELINES: Array<{ name: string; build: () => Promise<SystemPromptBlocks> }> = [
  { name: 'hotel chat', build: hotelChatPrompt },
  { name: 'walkthrough', build: walkthroughPrompt },
  { name: 'portfolio chat', build: () => portfolioPrompt() },
];

describe('every code-owned rule reaches every pipeline', () => {
  // Guard for everything below: if the registry were empty, every "the rule is
  // present" assertion would pass by vacuity and this file would be decoration.
  test('the registry is not empty', () => {
    assert.ok(CODE_OWNED_RULE_TIERS.length > 0, 'no shared rule tiers to police');
  });

  for (const tier of CODE_OWNED_RULE_TIERS) {
    for (const pipeline of PIPELINES) {
      test(`${pipeline.name} carries the "${tier.id}" rule verbatim`, async () => {
        const built = await pipeline.build();
        assert.ok(
          built.stable.includes(tier.text),
          `${pipeline.name} is missing the ${tier.id} rule. Every pipeline composes `
          + 'CODE_OWNED_RULE_TIERS; if you added a tier, it must be rendered by iteration, not by name.',
        );
      });

      test(`${pipeline.name} stamps the "${tier.id}" version`, async () => {
        const built = await pipeline.build();
        assert.ok(
          built.stableStamp.includes(tier.version),
          `${pipeline.name} rendered the ${tier.id} rule without stamping ${tier.version}. `
          + '"Which rules did this turn run under" must be answerable from the stamp alone.',
        );
      });
    }
  }

  test('the rules are in the CACHED half, never the per-turn half', async () => {
    // They are constant per deploy. In the dynamic block they would be re-sent
    // uncached on every turn of every conversation, forever, and nothing about
    // the answers would look wrong.
    for (const pipeline of PIPELINES) {
      const built = await pipeline.build();
      for (const tier of CODE_OWNED_RULE_TIERS) {
        assert.equal(
          built.dynamic.includes(tier.text), false,
          `${pipeline.name} put the ${tier.id} rule in the uncached block`,
        );
      }
    }
  });
});

describe("the hotel's standing rules follow hotel scope", () => {
  test('the hotel chat carries them', async () => {
    const built = await hotelChatPrompt();
    assert.match(built.stable, new RegExp(HOTEL_RULES_HEADER));
    assert.ok(built.stable.includes(THE_RULE));
    assert.ok(built.stableStamp.includes(HOTEL_RULES_VERSION));
  });

  test('the walkthrough carries them — it did not before', async () => {
    // The walkthrough drives a manager around their own hotel. "Always check
    // with me before promising a late checkout" is exactly the kind of rule it
    // needs, and it had no access to any of them.
    const built = await walkthroughPrompt();
    assert.match(built.stable, new RegExp(HOTEL_RULES_HEADER));
    assert.ok(built.stable.includes(THE_RULE));
    assert.ok(built.stableStamp.includes(HOTEL_RULES_VERSION));
  });

  test('a one-hotel portfolio turn carries them', async () => {
    const built = await portfolioPrompt(IDENTITY_ONE_HOTEL);
    assert.ok(built.stable.includes(THE_RULE));
    assert.ok(built.stableStamp.includes(HOTEL_RULES_VERSION));
  });

  test('a MULTI-hotel portfolio turn carries none of them', async () => {
    // The load-bearing one. A standing rule belongs to exactly one hotel, so on
    // a turn spanning several there is no hotel whose house rules are the right
    // ones to state. Rendering the first hotel's would put its manager's
    // instructions in front of a question about the others — the same leak the
    // company tier is gated against, from the other direction.
    const built = await portfolioPrompt(IDENTITY_TWO_HOTELS);
    assert.equal(built.stable.includes(THE_RULE), false,
      "one hotel's standing rules leaked into a multi-hotel portfolio turn");
    assert.equal(built.stable.includes(HOTEL_RULES_HEADER), false);
    assert.equal(built.stableStamp.includes(HOTEL_RULES_VERSION), false,
      'the stamp claims a standing-rules tier that was not rendered');
  });

  test('the scope resolver is what decides, and it decides by exact count', () => {
    assert.equal(exactHotelScope([PID_ONE]), PID_ONE);
    assert.equal(exactHotelScope([]), null);
    assert.equal(exactHotelScope([PID_ONE, PID_TWO]), null);
  });
});

// ─── The fourth-pipeline pin ────────────────────────────────────────────────

describe('no pipeline can be added without the rulebook', () => {
  // A source scan, deliberately. "Somebody wrote a fourth assembler" is not a
  // condition any running code can observe — the new one would simply never be
  // called by these tests. Pinning the SET of system-prompt producers is the
  // only way to make its arrival visible, and it is the narrow no-runtime
  // invariant the house rule on source-string tests carves out.
  //
  // To add a producer: compose CODE_OWNED_RULE_TIERS in it, add it to PIPELINES
  // above so every rule is asserted against it too, and then list it here.
  const KNOWN_PRODUCERS = [
    'src/lib/agent/prompts.ts',                          // hotel chat
    'src/lib/agent/portfolio/prompt.ts',                 // portfolio chat
    'src/lib/agent/portfolio-intelligence/prompt.ts',    // portfolio chat, evidence layer
    'src/lib/walkthrough-step.ts',                       // walkthrough
  ].sort();

  const PRODUCES = /\)\s*:\s*(?:Promise<)?SystemPromptBlocks/;

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '__tests__' || entry === '.next') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(full);
    }
    return out;
  }

  test('the set of system-prompt producers is exactly the known list', () => {
    const found = walk('src')
      .filter((file) => PRODUCES.test(readFileSync(file, 'utf8')))
      .sort();
    assert.deepEqual(
      found,
      KNOWN_PRODUCERS,
      'A function that builds a system prompt was added or removed. Every producer '
      + 'must compose CODE_OWNED_RULE_TIERS from src/lib/agent/rule-tiers.ts, and must '
      + 'be added to PIPELINES in this file so the shared rules are asserted against it.',
    );
  });

  test('the known producers really are the ones this file exercises', () => {
    // Keeps the two halves honest: three pipelines are built above, and the
    // fourth known producer is the portfolio evidence layer, which delegates to
    // portfolio/prompt.ts rather than assembling a stable block of its own.
    assert.equal(PIPELINES.length, 3);
    assert.equal(KNOWN_PRODUCERS.length, 4);
  });
});
