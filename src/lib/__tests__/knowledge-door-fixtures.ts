/**
 * SHARED FIXTURES FOR THE KNOWLEDGE-DOOR BYTE-EQUALITY PROOF.
 *
 * Not a test file (no `.test.ts` suffix, so the runner's glob skips it). It is
 * the ONE composer both halves of the proof use:
 *
 *   • `scripts/capture-knowledge-golden.ts` ran it on the pre-consolidation
 *     tree and froze its output into `fixtures/knowledge-door-golden.json`.
 *   • `agent-knowledge-door.test.ts` runs it again on every test run and
 *     asserts the bytes still match, subject by subject.
 *
 * Both halves calling the same composer is what makes the comparison mean
 * something: a difference in the output can only come from a change to the
 * production assemblers, never from the harness drifting between captures.
 *
 * Every input is pinned — the clock, the ids, the facts, the rules — because a
 * golden compared against a moving input is a test that fails on its own
 * schedule.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { Awareness } from '@/lib/agent/awareness';
import { formatAwarenessForPrompt } from '@/lib/agent/awareness';
import type { CompanyFact } from '@/lib/company/rulebook';
import type { CompanyRulebook } from '@/lib/agent/company-tier';
import {
  clearCompanyRulebookCache,
  formatCompanyRulebookForPrompt,
  seedCompanyRulebookCache,
  seedCompanyRulebookCacheForOrganization,
} from '@/lib/agent/company-tier';
import type { HotelIdentity } from '@/lib/agent/hotel-identity';
import {
  clearHotelIdentityCache,
  formatHotelIdentityForPrompt,
  seedHotelIdentityCache,
} from '@/lib/agent/hotel-identity';
import { formatStandingRulesForPrompt } from '@/lib/agent/hotel-rules-tier';
import type { HotelSnapshot } from '@/lib/agent/context';
import { buildSystemPrompt } from '@/lib/agent/prompts';
import { buildPortfolioSystemPrompt } from '@/lib/agent/portfolio/prompt';
import { buildSystemPrompt as buildWalkthroughPrompt } from '@/lib/walkthrough-step';
import {
  buildCompanyKnowledgeOverlay,
  formatKnowledgeOverlayForPrompt,
} from '@/lib/agent/portfolio-intelligence/knowledge';
import {
  clearStandingRulesCache,
  seedStandingRules,
  type StandingRule,
} from '@/lib/companion/rules';

export const OUTPUT_PATH = 'src/lib/__tests__/fixtures/knowledge-door-golden.json';

export const PID_ONE = '00000000-0000-4000-8000-0000000000d1';
export const PID_TWO = '00000000-0000-4000-8000-0000000000d2';
export const ORG_ID = '00000000-0000-4000-8000-0000000000d9';

/** Pinned. A golden measured against the wall clock ages into a false failure. */
export const NOW = new Date('2026-08-02T14:40:00.000Z');

export const FIXTURES: Record<string, Array<Record<string, unknown>>> = {
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

/**
 * Point the service-role singleton at the fixture rows.
 *
 * `resolvePrompts` then finds no `agent_prompts` row and falls back to the
 * code constants, which is what makes the base/role halves of the golden
 * deterministic without a database.
 */
export function stubSupabaseFrom(
  client: SupabaseClient,
  rows: Record<string, Array<Record<string, unknown>>>,
): () => void {
  const original = client.from.bind(client);
  // @ts-expect-error monkey-patch the singleton for a deterministic capture
  client.from = (table: string) => {
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: rows[table] ?? [], error: null }).then(resolve),
    };
    return chain;
  };
  return () => { client.from = original; };
}

function companyFact(id: string, topic: string, content: string): CompanyFact {
  return {
    id,
    organizationId: ORG_ID,
    topic,
    content,
    category: 'standards',
    source: 'explicit_user',
    reviewState: 'confirmed',
    policyKey: null,
    policyValue: null,
    createdByName: 'Dana',
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
}

export const RULEBOOK: CompanyRulebook = {
  organizationId: ORG_ID,
  facts: [
    companyFact('00000000-0000-4000-8000-0000000000c1', 'chemicals', 'All our hotels use Ecolab chemicals.'),
    companyFact('00000000-0000-4000-8000-0000000000c2', 'approvals', 'Orders over $500 need VP sign-off.'),
  ],
};

export const THE_RULE = 'Always check with me before promising a late checkout.';

export function standingRule(propertyId: string): StandingRule {
  return {
    id: '00000000-0000-4000-8000-0000000000a1',
    propertyId,
    ruleText: THE_RULE,
    createdByAccountId: null,
    createdByName: 'Maria',
    createdByRole: 'general_manager',
    createdAt: '2026-07-30T12:00:00.000Z',
  };
}

export const IDENTITY: HotelIdentity = {
  propertyId: PID_ONE,
  name: 'Comfort Suites',
  timezone: 'America/Chicago',
  kind: 'limited_service',
  brand: 'Choice',
  totalRooms: 88,
  businessDayCutoffHour: 0,
  rooms: {
    detailed: 6,
    types: [{ label: 'King', count: 3 }, { label: 'Double Queen', count: 2 }, { label: 'King Suite', count: 1 }],
    floors: [{ label: '1', count: 3 }, { label: '2', count: 3 }],
    accessible: 1,
    suites: 1,
    connecting: 1,
    petFriendly: 1,
    smoking: 0,
    componentSuites: 1,
  },
  housekeeping: null,
  cleaningChecklists: ['Departure clean', 'Stayover refresh'],
  inspectionChecklists: [],
  shiftPresets: [],
  scheduleTemplates: [],
  team: { total: 4, byDepartment: [{ label: 'housekeeping', count: 3 }, { label: 'front desk', count: 1 }], spanishSpeakers: 2, inspectors: 1 },
};

export const AWARENESS: Awareness = {
  clock: 'Sunday 9:40 AM, hotel time',
  screen: 'the Staxis tab',
  didToday: 'marked 3 rooms clean',
  onYourPlate: '1 approval',
};

export function hotelSnapshot(): HotelSnapshot {
  return {
    today: '2026-08-02',
    property: { id: PID_ONE, name: 'Comfort Suites', timezone: 'America/Chicago' },
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

const OVERLAY_INPUT = {
  organizationId: ORG_ID,
  selectedPropertyIds: [PID_ONE],
  asOf: NOW.toISOString(),
  companyFacts: RULEBOOK.facts.map((fact) => ({
    id: fact.id,
    organizationId: ORG_ID,
    knowledgeKey: fact.topic,
    topic: fact.topic,
    content: fact.content,
    category: 'standards' as const,
    source: 'explicit_user' as const,
    reviewState: 'confirmed' as const,
    isActive: true,
    effectiveFrom: null,
    expiresAt: null,
    updatedAt: fact.updatedAt,
    policyKey: null,
    policyValue: null,
    createdByName: fact.createdByName,
  })),
  propertyFacts: [],
};

/** One rendered prompt, flattened to the five strings the contract carries. */
export interface GoldenSubject {
  stable: string;
  dynamic: string;
  factual: string;
  versionLabel: string;
  stableStamp: string;
}

export type GoldenSubjects = Record<string, GoldenSubject | string | null>;

/**
 * Render every subject the consolidation can touch.
 *
 * Seeded rather than derived: the `from` stub cannot serve the real identity,
 * rulebook or standing-rule queries, so a live derivation would fail softly and
 * render nothing — and every byte-equality assertion would then be passing for
 * the boring reason that all three blocks were absent.
 */
export function seedKnowledgeFixtures(): void {
  clearHotelIdentityCache();
  clearCompanyRulebookCache();
  clearStandingRulesCache();
  seedHotelIdentityCache(PID_ONE, IDENTITY);
  seedCompanyRulebookCache(PID_ONE, RULEBOOK);
  seedCompanyRulebookCacheForOrganization(ORG_ID, RULEBOOK);
  seedStandingRules(PID_ONE, [standingRule(PID_ONE)]);
  seedStandingRules(PID_TWO, [standingRule(PID_TWO)]);
}

export function clearKnowledgeFixtures(): void {
  clearHotelIdentityCache();
  clearCompanyRulebookCache();
  clearStandingRulesCache();
}

export async function buildGoldenSubjects(): Promise<GoldenSubjects> {
  seedKnowledgeFixtures();

  const subjects: GoldenSubjects = {};

  subjects['hotel-chat.general_manager'] = await buildSystemPrompt({
    role: 'general_manager',
    snapshot: hotelSnapshot(),
    conversationId: 'conv-knowledge-door',
    memoryBlock: '',
    awarenessBlock: formatAwarenessForPrompt(AWARENESS),
    now: NOW,
  });

  // The purity invariant, captured as bytes: a line role must never be handed
  // the company rulebook.
  subjects['hotel-chat.housekeeping'] = await buildSystemPrompt({
    role: 'housekeeping',
    snapshot: hotelSnapshot(),
    conversationId: 'conv-knowledge-door-hk',
    now: NOW,
  });

  subjects['walkthrough'] = await buildWalkthroughPrompt({
    role: 'general_manager',
    task: 'help me add a housekeeper',
    propertyId: PID_ONE,
    hotelContext: '<staxis-snapshot trust="system">Rooms: 88 total</staxis-snapshot>',
  });

  subjects['portfolio.one-hotel.legacy-rulebook'] = await buildPortfolioSystemPrompt({
    identity: IDENTITY_ONE_HOTEL,
    companyRole: 'vp',
    conversationId: 'conv-knowledge-door-p1',
    companyKnowledgeMode: 'legacy_rulebook',
    now: NOW,
  });

  subjects['portfolio.two-hotels.legacy-rulebook'] = await buildPortfolioSystemPrompt({
    identity: IDENTITY_TWO_HOTELS,
    companyRole: 'vp',
    conversationId: 'conv-knowledge-door-p2',
    companyKnowledgeMode: 'legacy_rulebook',
    now: NOW,
  });

  subjects['portfolio.one-hotel.external-overlay'] = await buildPortfolioSystemPrompt({
    identity: IDENTITY_ONE_HOTEL,
    companyRole: 'vp',
    conversationId: 'conv-knowledge-door-p3',
    companyKnowledgeMode: 'external_overlay',
    now: NOW,
  });

  subjects['block.company-rulebook'] = formatCompanyRulebookForPrompt(RULEBOOK);
  subjects['block.hotel-standing-rules'] = formatStandingRulesForPrompt([standingRule(PID_ONE)]);
  subjects['block.hotel-identity'] = formatHotelIdentityForPrompt(IDENTITY);
  subjects['block.awareness'] = formatAwarenessForPrompt(AWARENESS);
  subjects['block.portfolio-knowledge-overlay'] =
    formatKnowledgeOverlayForPrompt(buildCompanyKnowledgeOverlay(OVERLAY_INPUT));

  clearKnowledgeFixtures();
  return subjects;
}
