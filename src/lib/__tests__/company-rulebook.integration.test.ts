/**
 * THE COMPANY RULEBOOK, against a real Postgres holding TWO COMPANIES.
 *
 * A management company's rules reach every hotel it operates and NO hotel it
 * does not. That sentence is the whole feature, and it is only provable against
 * real SQL and the real prompt assembler — a fake client can show that a query
 * carried an organization filter, not that the filter keeps the other company's
 * rulebook out of a prompt.
 *
 * What each block below would catch:
 *
 *   REACH        Gulf Coast's book renders in Beaumont's AND Lufkin's system
 *                prompt, never in Piney Woods' Tyler, never in the companyless
 *                Waco Inn. Delete the organization filter in rulebook.ts and
 *                this fails.
 *   PRECEDENCE   the company tier sits ABOVE the family tier and BELOW the
 *                hotel's own identity, proven on a genuinely conflicting fact
 *                (the book says housekeeping starts at 8; Beaumont is set up
 *                for 7). Assembly order IS the conflict rule, so reordering the
 *                tiers silently changes which fact wins — and nothing else
 *                would notice.
 *   READ-ONLY    a GM sees the book and the route refuses every write they try.
 *   FROZEN RULES an authority rule exists ONLY after a human confirms, and
 *                `authorityRuleFor` picks the right one — including the case
 *                where two rules apply and routing to the weaker approver would
 *                skip the owner entirely.
 *   SETTINGS     the access choices gate what they claim, and gms_see_rulebook
 *                is locked on by the DATABASE.
 *   FLAGS        the contradiction line fires on a real settings conflict and
 *                is silent on absence.
 *   DELETE       removal is permanent: gone from the list, gone from the
 *                prompt, and its authority rule stops applying.
 *
 * PGlite runs as the table owner, exactly as the service-role key bypasses RLS
 * in production. The boundary under test is the app's organization_id filter,
 * which is the real guarantee for company_knowledge (RLS is deny-all).
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder';
// Device-trust is a separate boundary with its own suite. Honored only outside
// production — this is what lets the tests drive the REAL route handlers.
process.env.DISABLE_SERVER_2FA_ENFORCEMENT = 'true';

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { NextRequest } from 'next/server';
import type { PGlite } from '@electric-sql/pglite';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { buildSystemPrompt } from '@/lib/agent/prompts';
import type { HotelSnapshot } from '@/lib/agent/context';
import { clearHotelIdentityCache } from '@/lib/agent/hotel-identity';
import { clearCompanyRulebookCache } from '@/lib/agent/company-tier';
import {
  confirmCompanyFact,
  editCompanyFact,
  getConfirmedCompanyFacts,
  listCompanyFacts,
  mergeCompanyFact,
  removeCompanyFact,
  storeCompanyFact,
} from '@/lib/company/rulebook';
import { findNearDuplicate } from '@/lib/company/rulebook-policy';
import { authorityRuleFor, listAuthorityRules } from '@/lib/company/authority';
import {
  companyAccessSetting,
  rulebookStandingFor,
  saveCompanyAccessSettings,
} from '@/lib/company/rulebook-access';
import { accountsCoveringProperty } from '@/lib/company/access';
import { GET as rulebookGet, POST as rulebookPost } from '@/app/api/company/rulebook/route';
import { GET as teamGet } from '@/app/api/auth/team/route';

import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';
import { createPglitePostgrest, loadCatalog, type PglitePostgrest } from '../../../tests/fixtures/postgrest-pglite';
import {
  ACCOUNT_ANA,
  ACCOUNT_BO,
  ACCOUNT_FIONA,
  ACCOUNT_GIL,
  ACCOUNT_MARIA,
  ACCOUNT_WANDA,
  ORG_A,
  ORG_B,
  PID_A1,
  PID_A2,
  PID_B1,
  PID_L1,
  UID_ANA,
  UID_GIL,
  UID_MARIA,
  UID_WANDA,
  seedTwoCompanies,
} from '../../../tests/fixtures/pglite-two-company-seed';

let pg: PGlite;
let shim: PglitePostgrest;

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);
const originalGetUser = supabaseAdmin.auth.getUser.bind(supabaseAdmin.auth);
const originalListUsers = supabaseAdmin.auth.admin.listUsers.bind(supabaseAdmin.auth.admin);

let signedInAs: string | null = null;

const ACTOR = { accountId: null, name: 'Ana', role: 'owner' };

const HK_SETUP = (shiftStartTime: string) => ({
  version: 1,
  completedAt: '2026-07-01T00:00:00.000Z',
  level: 1,
  recommendedLevel: 1,
  statusEntry: 'housekeeper_radio',
  checkoutMinutes: 30,
  stayoverMinutes: 20,
  shiftStartTime,
  boardBuiltBy: 'gm',
  inspection: 'every_room',
  sideDuties: [],
  boardPhotoPath: null,
});

function authorizedRequest(url: string, init?: { method?: string; body?: unknown }): NextRequest {
  return new NextRequest(url, {
    method: init?.method ?? 'GET',
    headers: {
      authorization: 'Bearer company-rulebook-test-token',
      'content-type': 'application/json',
      'x-real-ip': '203.0.113.11',
    },
    ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

async function rulebookFor(authUserId: string, propertyId: string) {
  signedInAs = authUserId;
  const response = await rulebookGet(
    authorizedRequest(`https://staxis.test/api/company/rulebook?propertyId=${propertyId}`),
  );
  const parsed = await response.json().catch(() => ({})) as { data?: Record<string, unknown> };
  return { status: response.status, data: parsed.data ?? null };
}

async function rulebookWrite(authUserId: string, body: Record<string, unknown>) {
  signedInAs = authUserId;
  const response = await rulebookPost(
    authorizedRequest('https://staxis.test/api/company/rulebook', { method: 'POST', body }),
  );
  const parsed = await response.json().catch(() => ({})) as { error?: string };
  return { status: response.status, error: parsed.error ?? null };
}

function snapshot(propertyId: string, name: string): HotelSnapshot {
  const now = new Date();
  return {
    today: now.toISOString().slice(0, 10),
    property: { id: propertyId, name, timezone: 'America/Chicago' },
    rooms: {
      total: 60, dirty: 4, in_progress: 0, clean: 10, dnd: 0, issuesFlagged: 0,
      helpRequested: 0, checkouts: 5, stayovers: 9, inHouse: 30, outOfOrder: 0,
      seedingGap: 0,
    },
    staff: { activeToday: 3, assignedHousekeepers: 2 },
    pmsDataSource: 'snapshot_capture',
    pmsDataCapturedAt: new Date(now.getTime() - 5 * 60_000).toISOString(),
  };
}

/** Real prompt assembly for one hotel. Caches cleared so each call re-derives. */
async function stableBlockFor(propertyId: string, name: string): Promise<string> {
  clearCompanyRulebookCache();
  clearHotelIdentityCache();
  const { stable } = await buildSystemPrompt(
    'general_manager', snapshot(propertyId, name), `conv-${propertyId}`,
  );
  return stable;
}

/** Put a fact in a company's book and confirm it, as the company's owner would. */
async function writeConfirmedFact(
  organizationId: string,
  topic: string,
  content: string,
  category: 'standards' | 'money' | 'vendors' | 'people' | 'guests' = 'standards',
): Promise<string> {
  const stored = await storeCompanyFact({
    organizationId, topic, content, category, source: 'explicit_user',
  });
  assert.ok(stored.ok && stored.factId, `seed: ${topic} was refused`);
  const confirmed = await confirmCompanyFact(organizationId, stored.factId, ACTOR);
  assert.equal(confirmed.confirmed, true, `seed: ${topic} would not confirm`);
  return stored.factId;
}

before(async () => {
  const migrated = await applyMigrationsToPglite();
  pg = migrated.pg;
  const catalog = await loadCatalog(pg);
  shim = createPglitePostgrest(pg, catalog);
  // @ts-expect-error installing the pglite-backed client on the singleton
  supabaseAdmin.from = shim.from;
  // @ts-expect-error installing the pglite-backed client on the singleton
  supabaseAdmin.rpc = shim.rpc;
  // @ts-expect-error the tests only need the id/email the session gate reads
  supabaseAdmin.auth.getUser = async () => (
    signedInAs
      ? { data: { user: { id: signedInAs, email: 'someone@example.test' } }, error: null }
      : { data: { user: null }, error: { message: 'no session', status: 401, name: 'AuthApiError' } }
  );
  // @ts-expect-error the team route only needs an empty page here
  supabaseAdmin.auth.admin.listUsers = async () => ({ data: { users: [] }, error: null });

  await seedTwoCompanies(pg);

  // Beaumont is set up for a 07:00 housekeeping start. The company book will
  // say 08:00 — a genuine, structured disagreement, which is what makes both
  // the precedence test and the contradiction test mean something.
  await pg.query(
    `update properties set housekeeping_setup = $2::jsonb, checkout_minutes = 30
      where id = $1`,
    [PID_A1, JSON.stringify(HK_SETUP('07:00'))],
  );
  await pg.query(
    `update properties set housekeeping_setup = $2::jsonb, checkout_minutes = 30
      where id = $1`,
    [PID_A2, JSON.stringify(HK_SETUP('08:00'))],
  );
});

after(async () => {
  supabaseAdmin.from = originalFrom;
  supabaseAdmin.rpc = originalRpc;
  supabaseAdmin.auth.getUser = originalGetUser;
  supabaseAdmin.auth.admin.listUsers = originalListUsers;
  clearCompanyRulebookCache();
  clearHotelIdentityCache();
  await pg?.close();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the book reaches its own company\'s hotels and nobody else\'s', () => {
  before(async () => {
    await writeConfirmedFact(ORG_A, 'chemical_vendor', 'All our hotels use Ecolab for chemicals.', 'vendors');
    await writeConfirmedFact(ORG_B, 'linen_vendor', 'Piney Woods buys linen from Standard Textile.', 'vendors');
    clearCompanyRulebookCache();
  });

  test('Gulf Coast\'s rule renders in BOTH of its hotels\' prompts', async () => {
    const beaumont = await stableBlockFor(PID_A1, 'Beaumont Suites');
    const lufkin = await stableBlockFor(PID_A2, 'Lufkin Inn');
    assert.match(beaumont, /Ecolab/, 'the company rule reaches Beaumont');
    assert.match(lufkin, /Ecolab/, 'and Lufkin, which nobody typed it into');
    assert.match(beaumont, /Company rulebook/);
  });

  test('and NEVER in the other company\'s hotel — Wall B, at the prompt', async () => {
    const tyler = await stableBlockFor(PID_B1, 'Tyler Lodge');
    assert.equal(/Ecolab/.test(tyler), false, 'company A\'s rulebook leaked into company B\'s hotel');
    // …and Tyler really does get its OWN company's book, or the assertion above
    // would pass for the boring reason that the tier never rendered at all.
    assert.match(tyler, /Standard Textile/);
  });

  test('a hotel with no company gets no company section at all', async () => {
    const waco = await stableBlockFor(PID_L1, 'Waco Inn');
    assert.equal(/Company rulebook/.test(waco), false);
    assert.equal(/Ecolab/.test(waco), false);
    assert.equal(/Standard Textile/.test(waco), false);
  });

  test('an unconfirmed line does not reach any prompt', async () => {
    const stored = await storeCompanyFact({
      organizationId: ORG_A,
      topic: 'pending_pool_rule',
      content: 'Every hotel closes the pool at 10pm sharp.',
      source: 'inferred',
    });
    assert.ok(stored.ok && stored.factId);
    const raw = await pg.query<{ review_state: string }>(
      'select review_state from company_knowledge where id = $1', [stored.factId],
    );
    assert.equal(raw.rows[0].review_state, 'unreviewed', 'the DB trigger, not the caller, decides this');

    const beaumont = await stableBlockFor(PID_A1, 'Beaumont Suites');
    assert.equal(/closes the pool at 10pm/.test(beaumont), false);

    // Clean up so later blocks start from a known book.
    await removeCompanyFact(ORG_A, stored.factId);
    clearCompanyRulebookCache();
  });

  test('the version stamp claims the tier only when a block was rendered', async () => {
    clearCompanyRulebookCache();
    clearHotelIdentityCache();
    const withCompany = await buildSystemPrompt(
      'general_manager', snapshot(PID_A1, 'Beaumont Suites'), 'conv-stamp-a',
    );
    clearCompanyRulebookCache();
    clearHotelIdentityCache();
    const without = await buildSystemPrompt(
      'general_manager', snapshot(PID_L1, 'Waco Inn'), 'conv-stamp-l',
    );
    assert.match(withCompany.stableStamp, /company-rulebook-v1/);
    assert.equal(/company-rulebook-v1/.test(without.stableStamp), false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('precedence — the hotel beats its company', () => {
  before(async () => {
    await writeConfirmedFact(
      ORG_A, 'hk_start_time', 'Housekeeping starts at 8am at every hotel.', 'standards',
    );
    clearCompanyRulebookCache();
  });

  test('the company block is assembled BEFORE the hotel\'s own identity', async () => {
    const stable = await stableBlockFor(PID_A1, 'Beaumont Suites');
    const companyAt = stable.indexOf('Company rulebook');
    const hotelAt = stable.indexOf('About this hotel');
    assert.ok(companyAt > -1, 'the company section rendered');
    assert.ok(hotelAt > -1, 'the hotel identity section rendered');
    assert.ok(
      companyAt < hotelAt,
      'assembly order IS the conflict rule — the hotel must come last, so its fact wins',
    );
  });

  test('both sides of a REAL conflict are present, with the hotel\'s answer last', async () => {
    const stable = await stableBlockFor(PID_A1, 'Beaumont Suites');
    // Company book: 8am. Beaumont's own setup: 07:00. Both in the prompt.
    assert.match(stable, /Housekeeping starts at 8am/);
    assert.match(stable, /Housekeeping starts at 07:00/);
    assert.ok(
      stable.indexOf('Housekeeping starts at 8am') < stable.indexOf('Housekeeping starts at 07:00'),
      'the hotel\'s configured time must be the LATER text',
    );
  });

  test('the company tier sits AFTER the generic rules it is allowed to beat', async () => {
    const stable = await stableBlockFor(PID_A1, 'Beaumont Suites');
    assert.ok(
      stable.indexOf('How old the numbers are') < stable.indexOf('Company rulebook'),
      'a company rule outranks the code-owned generic guidance above it',
    );
  });

  test('the hotel\'s own saved facts land in the DYNAMIC block, after everything', async () => {
    clearCompanyRulebookCache();
    clearHotelIdentityCache();
    const { stable, dynamic } = await buildSystemPrompt(
      'general_manager',
      snapshot(PID_A1, 'Beaumont Suites'),
      'conv-mem',
      undefined,
      '<staxis-memory-block trust="system-derived-from-untrusted"><staxis-memory scope="hotel" topic="hk_start" by="role:general_manager" confidence="high">Beaumont housekeeping actually starts at 6:30.</staxis-memory></staxis-memory-block>',
    );
    assert.match(stable, /Housekeeping starts at 8am/, 'the company line is in the cached half');
    assert.equal(/6:30/.test(stable), false, 'a hotel memory must never enter the cached half');
    assert.match(dynamic, /6:30/, 'and it does land in the per-turn half, which the model reads last');
  });

  test('the ceiling above the block forbids the four things a tier must not do', async () => {
    const stable = await stableBlockFor(PID_A1, 'Beaumont Suites');
    assert.match(stable, /never an instruction to you/i);
    assert.match(stable, /Never say a thing was done unless you called the tool/i);
    assert.match(stable, /another hotel's data/i);
    assert.match(stable, /This hotel beats the company book/i);
    // The envelope's tags come from code, and the content sits inside them.
    assert.match(stable, /<staxis-company-rulebook trust="untrusted">/);
    assert.match(stable, /<\/staxis-company-rulebook>/);
    assert.ok(
      stable.indexOf('<staxis-company-rulebook') < stable.indexOf('All our hotels use Ecolab'),
      'a rulebook line may only ever appear INSIDE the envelope',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the cached block stays byte-identical with the new tier in it', () => {
  test('two builds of the same hotel produce identical stable blocks', async () => {
    clearCompanyRulebookCache();
    clearHotelIdentityCache();
    const a = await buildSystemPrompt('general_manager', snapshot(PID_A1, 'Beaumont Suites'), 'conv-p');
    const b = await buildSystemPrompt('general_manager', snapshot(PID_A1, 'Beaumont Suites'), 'conv-p');
    assert.equal(a.stable, b.stable);
    assert.match(a.stable, /Company rulebook/, 'and the tier really was in the block being compared');
  });

  test('the company block carries no clock, no age and no count', async () => {
    const stable = await stableBlockFor(PID_A1, 'Beaumont Suites');
    const start = stable.indexOf('Company rulebook');
    const end = stable.indexOf('</staxis-company-rulebook>');
    const block = stable.slice(start, end);
    assert.equal(/\b(min|hr|days?) ago\b/i.test(block), false);
    assert.equal(/\b(updated|last edited|as of)\b/i.test(block), false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('a GM reads the book and cannot touch it', () => {
  test('Gil (GM of Tyler) can see Piney Woods\' book, read-only', async () => {
    const standing = await rulebookStandingFor(ACCOUNT_GIL, ORG_B);
    assert.equal(standing.canView, true, 'a GM should know the policies they are governed by');
    assert.equal(standing.canEdit, false);
    assert.equal(standing.companyRole, null);
    assert.equal(standing.viewOnlyBecauseHotelJob, true);

    const { status, data } = await rulebookFor(UID_GIL, PID_B1);
    assert.equal(status, 200);
    assert.equal((data as { canEdit: boolean }).canEdit, false);
    assert.ok(
      JSON.stringify(data).includes('Standard Textile'),
      'and the book he can see is his own company\'s',
    );
  });

  test('the route REFUSES a GM\'s writes — the label is not the enforcement', async () => {
    const facts = await listCompanyFacts(ORG_B);
    const target = facts[0];
    assert.ok(target, 'company B has a line to try to edit');

    for (const body of [
      { action: 'confirm', id: target.id },
      { action: 'edit', id: target.id, content: 'Gil rewrote the company book.' },
      { action: 'remove', id: target.id },
      { action: 'settings', settings: { cross_hotel_ai_chat: 'true' } },
    ]) {
      const res = await rulebookWrite(UID_GIL, { propertyId: PID_B1, ...body });
      assert.equal(res.status, 403, `a GM must not be able to ${String(body.action)}`);
    }

    const after = await listCompanyFacts(ORG_B);
    assert.equal(after.length, facts.length, 'nothing was removed');
    assert.equal(after[0].content, target.content, 'and nothing was reworded');
  });

  test('a GM is shown the CONFIRMED book only — a draft is not a policy', async () => {
    // Put an unapproved line in company B's book. It is not policy: it reaches
    // no copilot and Gil cannot act on it, so showing it to him would claim a
    // rule exists that does not.
    const draft = await storeCompanyFact({
      organizationId: ORG_B,
      topic: 'draft_only_rule',
      content: 'Piney Woods is thinking about closing pools at 9pm.',
      source: 'inferred',
    });
    assert.ok(draft.ok && draft.factId);

    const { data } = await rulebookFor(UID_GIL, PID_B1);
    const payload = data as {
      facts: Array<{ id: string; reviewState: string }>;
      stats: { pendingReview: number };
    };
    assert.equal(
      payload.facts.some((f) => f.id === draft.factId), false,
      'the draft must not appear in a read-only viewer\'s book',
    );
    assert.equal(payload.facts.every((f) => f.reviewState === 'confirmed'), true);
    assert.equal(payload.stats.pendingReview, 0, 'and they are not nagged about a queue they cannot work');

    // Company leadership still sees it — this is a visibility rule, not a
    // deletion, and the assertion above would pass for the wrong reason if the
    // row had simply failed to store.
    const owner = await rulebookFor(UID_ANA, PID_A1);
    assert.ok(owner.status === 200);
    assert.equal(
      (await listCompanyFacts(ORG_B)).some((f) => f.id === draft.factId), true,
    );
    await removeCompanyFact(ORG_B, draft.factId);
  });

  test('a GM cannot reach the OTHER company\'s book at all', async () => {
    const standing = await rulebookStandingFor(ACCOUNT_GIL, ORG_A);
    assert.equal(standing.canView, false, 'Wall B: a job at company B says nothing about company A');
    assert.equal(standing.organizationId, null);
  });

  test('a legacy single-hotel owner gets a 404, not an empty book', async () => {
    // Wanda's hotel belongs to no company. "There is nothing here" and "your
    // company's book is empty" are different answers.
    const { status } = await rulebookFor(UID_WANDA, PID_L1);
    assert.equal(status, 404);
    assert.deepEqual(await rulebookStandingFor(ACCOUNT_WANDA, ORG_A), {
      organizationId: null, canView: false, canEdit: false,
      companyRole: null, viewOnlyBecauseHotelJob: false,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('an authority rule exists only after a human confirms', () => {
  const SENTENCE = 'Orders over $500 need VP sign-off.';

  test('an extracted line produces NO rule, however clearly it reads', async () => {
    const stored = await storeCompanyFact({
      organizationId: ORG_A, topic: 'po_threshold', content: SENTENCE, category: 'money',
      source: 'inferred',
    });
    assert.ok(stored.ok && stored.factId);

    const rules = await listAuthorityRules(ORG_A);
    assert.deepEqual(rules, [], 'a pasted document must not change who signs for money');
    assert.equal(await authorityRuleFor(ORG_A, 'purchase_order', 60_000), null);

    // …and the row carries no structured reading either.
    const raw = await pg.query<{ policy_key: string | null }>(
      'select policy_key from company_knowledge where id = $1', [stored.factId],
    );
    assert.equal(raw.rows[0].policy_key, null);
  });

  test('confirming the SAME line freezes it into three numbers', async () => {
    const facts = await listCompanyFacts(ORG_A);
    const pending = facts.find((f) => f.topic === 'po_threshold');
    assert.ok(pending && pending.reviewState === 'unreviewed');

    const res = await confirmCompanyFact(ORG_A, pending.id, ACTOR);
    assert.equal(res.confirmed, true);

    const rules = await listAuthorityRules(ORG_A);
    assert.equal(rules.length, 1);
    assert.equal(rules[0].actionKind, 'purchase_order');
    assert.equal(rules[0].thresholdCents, 50_000);
    assert.equal(rules[0].thresholdInclusive, false);
    assert.equal(rules[0].approverRole, 'vp');
    assert.equal(rules[0].sourceFactId, pending.id);
  });

  test('the reader picks the right rule, at the right boundary', async () => {
    // "over $500": $500.00 exactly is NOT over.
    assert.equal(await authorityRuleFor(ORG_A, 'purchase_order', 50_000), null);
    assert.equal(await authorityRuleFor(ORG_A, 'purchase_order', 49_999), null);
    const applies = await authorityRuleFor(ORG_A, 'purchase_order', 50_001);
    assert.ok(applies);
    assert.equal(applies.approverRole, 'vp');
  });

  test('a different ACTION KIND is not governed by this rule', async () => {
    assert.equal(await authorityRuleFor(ORG_A, 'refund', 100_000), null);
    assert.equal(await authorityRuleFor(ORG_A, 'not_a_kind', 100_000), null);
  });

  test('when two rules apply, the bigger signature wins — routing must not skip the owner', async () => {
    await writeConfirmedFact(
      ORG_A, 'po_big_threshold', 'Orders over $5,000 need the owner to approve them.', 'money',
    );

    const small = await authorityRuleFor(ORG_A, 'purchase_order', 60_000); // $600
    assert.ok(small);
    assert.equal(small.approverRole, 'vp', 'a $600 order is the VP\'s call');

    const big = await authorityRuleFor(ORG_A, 'purchase_order', 600_000); // $6,000
    assert.ok(big);
    assert.equal(
      big.approverRole, 'owner',
      'a $6,000 order clears BOTH thresholds; answering "VP" would route around the owner',
    );
    assert.equal(big.thresholdCents, 500_000);
  });

  test('no cross-company bleed — company B is not governed by company A\'s rules', async () => {
    assert.equal(await authorityRuleFor(ORG_B, 'purchase_order', 600_000), null);
    assert.deepEqual(await listAuthorityRules(ORG_B), []);
  });

  test('editing the sentence out of being a rule retires the gate', async () => {
    const facts = await listCompanyFacts(ORG_A);
    const target = facts.find((f) => f.topic === 'po_big_threshold');
    assert.ok(target);

    const res = await rulebookWrite(UID_ANA, {
      propertyId: PID_A1,
      action: 'edit',
      id: target.id,
      content: 'Large orders are unusual for us.',
      category: 'money',
    });
    assert.equal(res.status, 200);

    const big = await authorityRuleFor(ORG_A, 'purchase_order', 600_000);
    assert.ok(big);
    assert.equal(
      big.approverRole, 'vp',
      'the owner rule is gone with the sentence it came from; the $500 rule still stands',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the access choices gate what they claim', () => {
  test('the defaults are the product before anyone opens the setup screen', async () => {
    assert.equal(await companyAccessSetting(ORG_A, 'gms_see_rulebook'), 'true');
    assert.equal(await companyAccessSetting(ORG_A, 'cross_hotel_ai_chat'), 'false');
    assert.equal(await companyAccessSetting(ORG_A, 'rulebook_editors'), 'owner_and_vp');
    assert.equal(await companyAccessSetting(ORG_A, 'setup_completed_at'), null);
  });

  test('"owner and VPs" lets Maria edit; the finance person does not', async () => {
    const maria = await rulebookStandingFor(ACCOUNT_MARIA, ORG_A);
    assert.equal(maria.companyRole, 'vp');
    assert.equal(maria.canEdit, true);

    const fiona = await rulebookStandingFor(ACCOUNT_FIONA, ORG_A);
    assert.equal(fiona.companyRole, 'finance');
    assert.equal(fiona.canView, true, 'she can read the book');
    assert.equal(fiona.canEdit, false, 'but "owner and VPs" does not include her');
  });

  test('choosing "owner only" actually takes the VP\'s pen away', async () => {
    const saved = await saveCompanyAccessSettings(
      ORG_A, { rulebook_editors: 'owner_only' }, ACCOUNT_ANA,
    );
    assert.equal(saved.ok, true);
    assert.deepEqual(saved.saved, ['rulebook_editors']);

    const maria = await rulebookStandingFor(ACCOUNT_MARIA, ORG_A);
    assert.equal(maria.canEdit, false, 'the setting is a gate, not a label');
    assert.equal(maria.canView, true, 'she still reads it');

    // …and the route agrees, which is where it actually matters.
    const refused = await rulebookWrite(UID_MARIA, {
      propertyId: PID_A1, action: 'settings', settings: { cross_hotel_ai_chat: 'true' },
    });
    assert.equal(refused.status, 403);

    const ana = await rulebookStandingFor(ACCOUNT_ANA, ORG_A);
    assert.equal(ana.canEdit, true, 'the owner always edits their own company\'s book');
  });

  test('"anyone company-wide" opens it to finance', async () => {
    await saveCompanyAccessSettings(ORG_A, { rulebook_editors: 'company_scope' }, ACCOUNT_ANA);
    const fiona = await rulebookStandingFor(ACCOUNT_FIONA, ORG_A);
    assert.equal(fiona.canEdit, true);
    // Put it back so later blocks run on the shipped default.
    await saveCompanyAccessSettings(ORG_A, { rulebook_editors: 'owner_and_vp' }, ACCOUNT_ANA);
  });

  test('cross-hotel chat is stored and read back through the one interface', async () => {
    assert.equal(await companyAccessSetting(ORG_A, 'cross_hotel_ai_chat'), 'false');
    await saveCompanyAccessSettings(ORG_A, { cross_hotel_ai_chat: 'true' }, ACCOUNT_ANA);
    assert.equal(await companyAccessSetting(ORG_A, 'cross_hotel_ai_chat'), 'true');
    await saveCompanyAccessSettings(ORG_A, { cross_hotel_ai_chat: 'false' }, ACCOUNT_ANA);
    assert.equal(await companyAccessSetting(ORG_A, 'cross_hotel_ai_chat'), 'false');
  });

  test('saving anything stamps setup as done, and locks GM visibility ON in the DB', async () => {
    const stamp = await companyAccessSetting(ORG_A, 'setup_completed_at');
    assert.ok(stamp && /^\d{4}-\d{2}-\d{2}T/.test(stamp));
    assert.equal(await companyAccessSetting(ORG_A, 'gms_see_rulebook'), 'true');

    // The CHECK is the lock. A later agent that "just sets it to false" is
    // refused by Postgres, not by a code path somebody can delete.
    await assert.rejects(
      () => pg.query(
        `update company_access_settings set setting_value = 'false'
          where organization_id = $1 and setting_key = 'gms_see_rulebook'`,
        [ORG_A],
      ),
      /company_access_settings_shape_ck/,
    );
  });

  test('an unknown choice is refused rather than stored', async () => {
    const bad = await saveCompanyAccessSettings(ORG_A, { rulebook_editors: 'everyone' }, ACCOUNT_ANA);
    assert.equal(bad.ok, false);
    assert.equal(await companyAccessSetting(ORG_A, 'rulebook_editors'), 'owner_and_vp');
  });

  test('another company\'s settings are untouched by all of that', async () => {
    assert.equal(await companyAccessSetting(ORG_B, 'rulebook_editors'), 'owner_and_vp');
    assert.equal(await companyAccessSetting(ORG_B, 'setup_completed_at'), null);
    const bo = await rulebookStandingFor(ACCOUNT_BO, ORG_B);
    assert.equal(bo.canEdit, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the settings-contradiction line', () => {
  test('fires where a hotel is really configured differently from the book', async () => {
    // The book says housekeeping starts at 8am; Beaumont is set up for 07:00.
    const { status, data } = await rulebookFor(UID_ANA, PID_A1);
    assert.equal(status, 200);
    const found = (data as { contradictions: Array<{ propertyName: string; line: { en: string } }> })
      .contradictions;
    assert.equal(found.length, 1, 'exactly the one hotel that differs');
    assert.equal(found[0].propertyName, 'Beaumont Suites');
    assert.match(found[0].line.en, /07:00/);
    assert.match(found[0].line.en, /the company book says 08:00/);
  });

  test('is silent for the hotel that agrees, and for one with nothing configured', async () => {
    // Lufkin is set up for 08:00 — it agrees, so it must not appear above.
    const { data } = await rulebookFor(UID_ANA, PID_A1);
    const found = (data as { contradictions: Array<{ propertyName: string }> }).contradictions;
    assert.equal(found.some((c) => c.propertyName === 'Lufkin Inn'), false);

    // A hotel that never configured housekeeping contributes NOTHING — absence
    // is not a contradiction, or a brand-new hotel opens to a wall of them.
    await pg.query('update properties set housekeeping_setup = null where id = $1', [PID_A2]);
    const second = await rulebookFor(UID_ANA, PID_A1);
    const stillFound = (second.data as { contradictions: Array<{ propertyName: string }> }).contradictions;
    assert.equal(stillFound.some((c) => c.propertyName === 'Lufkin Inn'), false);
    assert.equal(stillFound.length, 1, 'only Beaumont, still');
    await pg.query(
      'update properties set housekeeping_setup = $2::jsonb where id = $1',
      [PID_A2, JSON.stringify(HK_SETUP('08:00'))],
    );
  });

  test('a GM is not shown the list of ways their peers differ', async () => {
    const { data } = await rulebookFor(UID_GIL, PID_B1);
    assert.deepEqual((data as { contradictions: unknown[] }).contradictions, []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('remove is permanent', () => {
  test('a removed line leaves the list, the prompt, and takes its rule with it', async () => {
    const facts = await listCompanyFacts(ORG_A);
    const target = facts.find((f) => f.topic === 'po_threshold');
    assert.ok(target, 'the $500 rule is there to remove');
    assert.ok(await authorityRuleFor(ORG_A, 'purchase_order', 60_000), 'and it is in force');

    const res = await rulebookWrite(UID_ANA, {
      propertyId: PID_A1, action: 'remove', id: target.id,
    });
    assert.equal(res.status, 200);

    assert.equal(
      (await listCompanyFacts(ORG_A)).some((f) => f.id === target.id), false,
      'gone from the book',
    );
    assert.equal(
      (await getConfirmedCompanyFacts(ORG_A)).some((f) => f.id === target.id), false,
      'gone from what the copilot reads',
    );
    assert.equal(
      await authorityRuleFor(ORG_A, 'purchase_order', 60_000), null,
      'a line the company took out must not keep gating money',
    );

    const stable = await stableBlockFor(PID_A1, 'Beaumont Suites');
    assert.equal(/Orders over \$500/.test(stable), false, 'gone from the prompt');
  });

  test('the DATABASE retires the rule too — not just the app call that removed it', async () => {
    // The app deactivates the rule as well, which is what makes the outcome
    // visible to the caller. This proves the guarantee survives that call
    // failing: flip the fact straight in SQL, bypassing every line of app code.
    const factId = await writeConfirmedFact(
      ORG_A, 'db_retire_probe', 'Comps over $100 need GM approval.', 'money',
    );
    assert.ok(await authorityRuleFor(ORG_A, 'comp', 20_000), 'the gate is in force');

    await pg.query('update company_knowledge set is_active = false where id = $1', [factId]);

    assert.equal(
      await authorityRuleFor(ORG_A, 'comp', 20_000), null,
      'the trigger retired it without any app code running',
    );
  });

  test('the row is retained for the audit trail, deactivated', async () => {
    const rows = await pg.query<{ is_active: boolean; content: string }>(
      `select is_active, content from company_knowledge
        where organization_id = $1 and topic = 'po_threshold'`,
      [ORG_A],
    );
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].is_active, false);
  });

  test('re-stating the same subject comes back UNCONFIRMED, never silently in force', async () => {
    const again = await storeCompanyFact({
      organizationId: ORG_A,
      topic: 'po_threshold',
      content: 'Orders over $500 need VP sign-off.',
      category: 'money',
      source: 'inferred',
    });
    assert.ok(again.ok && again.factId);
    assert.equal(again.action, 'inserted', 'a tombstoned topic starts a fresh row');
    assert.notEqual(again.factId, null);

    const raw = await pg.query<{ review_state: string }>(
      'select review_state from company_knowledge where id = $1', [again.factId],
    );
    assert.equal(raw.rows[0].review_state, 'unreviewed');
    assert.equal(
      await authorityRuleFor(ORG_A, 'purchase_order', 60_000), null,
      'the deleted gate does not come back on its own',
    );

    await removeCompanyFact(ORG_A, again.factId);
    clearCompanyRulebookCache();
  });

  test('a CONFIRMED line is not quietly reworded by a re-uploaded document', async () => {
    const facts = await listCompanyFacts(ORG_A);
    const confirmed = facts.find((f) => f.topic === 'chemical_vendor');
    assert.ok(confirmed && confirmed.reviewState === 'confirmed');

    const res = await storeCompanyFact({
      organizationId: ORG_A,
      topic: 'chemical_vendor',
      content: 'All our hotels use SomeoneElse for chemicals.',
      source: 'inferred',
    });
    assert.equal(res.action, 'skipped', 'the company already decided what that line says');
    const after = await listCompanyFacts(ORG_A);
    assert.equal(
      after.find((f) => f.topic === 'chemical_vendor')?.content,
      'All our hotels use Ecolab for chemicals.',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the spine follow-up — a hotel\'s team list stops hiding company people', () => {
  test('membership coverage names exactly the people whose job reaches the hotel', async () => {
    const atBeaumont = await accountsCoveringProperty(PID_A1);
    assert.ok(atBeaumont.includes(ACCOUNT_ANA), 'the owner');
    assert.ok(atBeaumont.includes(ACCOUNT_MARIA), 'the GM who also oversees the rest');
    assert.ok(atBeaumont.includes(ACCOUNT_FIONA), 'finance, company-wide');

    const atLufkin = await accountsCoveringProperty(PID_A2);
    assert.equal(
      atLufkin.includes(ACCOUNT_MARIA), true,
      'her company hat covers Lufkin even though her GM hat does not',
    );

    // Wall A: Frank's front-desk hat names Beaumont only.
    assert.equal(atLufkin.length < atBeaumont.length, true, 'Beaumont has one more person than Lufkin');

    // Wall B and the control group.
    assert.equal((await accountsCoveringProperty(PID_B1)).includes(ACCOUNT_ANA), false);
    assert.deepEqual(await accountsCoveringProperty(PID_L1), [], 'a companyless hotel has no hats');
  });

  test('the private hotel-team route does not turn broad company reach into hotel mutation authority', async () => {
    signedInAs = UID_ANA;
    const response = await teamGet(
      authorizedRequest(`https://staxis.test/api/auth/team?hotelId=${PID_A2}`),
    );
    assert.equal(response.status, 403);
    const parsed = await response.json() as { data?: unknown; error?: string };
    assert.equal(parsed.data, undefined);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TONIGHT'S TOUR, against a real database.
// ═══════════════════════════════════════════════════════════════════════════

describe('the approver a sentence names is the approver that gates money', () => {
  // THE LIVE ROW. `company_authority_rules` on the demo company held
  // approver_role='vp' for the sentence "Any capital project over $5,000
  // requires owner approval, not VP approval." Mutation: revert the negation
  // handling in readApproverCandidates and this test stores 'vp' again — and
  // then `authorityRuleFor` hands a $6,000 renovation to the wrong signature.
  test('"requires owner approval, not VP approval" freezes as the OWNER', async () => {
    const factId = await writeConfirmedFact(
      ORG_A,
      'capital_project_approval_threshold',
      'Any capital project over $5,000 requires owner approval, not VP approval.',
      'money',
    );

    const rules = await listAuthorityRules(ORG_A);
    const capital = rules.find((r) => r.sourceFactId === factId);
    assert.ok(capital, 'the sentence must produce a rule');
    assert.equal(capital.actionKind, 'capital_project');
    assert.equal(capital.thresholdCents, 500_000);
    assert.equal(capital.approverRole, 'owner');

    // …and the routing lookup the cards actually use agrees.
    const routed = await authorityRuleFor(ORG_A, 'capital_project', 600_000);
    assert.ok(routed);
    assert.equal(routed.approverRole, 'owner');
  });

  // Mutation: store SOMETHING for an ambiguous sentence. The company would be
  // gated on a coin flip and would have no way to find out which way it landed.
  test('a sentence naming two approvers freezes NO rule at all', async () => {
    const factId = await writeConfirmedFact(
      ORG_A,
      'two_approvers',
      'Any invoice over $900 needs owner approval or VP approval.',
      'money',
    );
    const rules = await listAuthorityRules(ORG_A);
    assert.equal(
      rules.some((r) => r.sourceFactId === factId), false,
      'an unstored rule gates nothing and is safe; a guessed one gates money',
    );
    assert.equal(await authorityRuleFor(ORG_A, 'invoice', 1_000_00), null);
  });

  // Mutation: leave the old rule in force when the words change. The book would
  // say one thing and the gate would do another — which is worse than either.
  test('editing an ambiguous sentence into a clear one turns the gate on, and back off', async () => {
    const facts = await listCompanyFacts(ORG_A);
    const two = facts.find((f) => f.topic === 'two_approvers')!;

    const clarified = await editCompanyFact(
      ORG_A, two.id,
      { content: 'Any invoice over $900 needs owner approval.', category: 'money' },
      ACTOR,
    );
    assert.equal(clarified.updated, true);
    const now = await authorityRuleFor(ORG_A, 'invoice', 1_000_00);
    assert.ok(now, 'the clarified sentence must gate');
    assert.equal(now.approverRole, 'owner');

    // Back to ambiguous → the frozen rule is RETIRED, not left standing.
    const muddied = await editCompanyFact(
      ORG_A, two.id,
      { content: 'Any invoice over $900 needs owner approval or VP approval.', category: 'money' },
      ACTOR,
    );
    assert.equal(muddied.updated, true);
    assert.equal(await authorityRuleFor(ORG_A, 'invoice', 1_000_00), null);
  });
});

describe('a restated rule updates the line the book already has', () => {
  // THE LIVE PAIR: chemical_vendor (confirmed) and chemical_supplier
  // (unreviewed) were both in the book, one policy, two rows, and a VP with no
  // way to tell which one the copilot follows.
  test('the confirmed line takes the new words and the duplicate goes', async () => {
    const keepId = await writeConfirmedFact(
      ORG_A, 'chemicals_vendor_merge', 'All our hotels use Ecolab for chemicals.', 'vendors',
    );
    const draft = await storeCompanyFact({
      organizationId: ORG_A,
      topic: 'chemicals_supplier_merge',
      content: 'All Gulf Coast properties exclusively use Ecolab chemicals.',
      category: 'vendors',
      source: 'inferred',
    });
    assert.ok(draft.ok && draft.factId);

    // The screen would have offered this pairing — same check, same inputs.
    const before = await listCompanyFacts(ORG_A);
    const confirmedLines = before
      .filter((f) => f.reviewState === 'confirmed')
      .map((f) => ({ id: f.id, topic: f.topic, content: f.content }));
    const match = findNearDuplicate(
      { id: draft.factId, content: 'All Gulf Coast properties exclusively use Ecolab chemicals.' },
      confirmedLines,
    );
    assert.ok(match, 'the restatement must be spotted before it can be offered');
    assert.equal(match.existing.id, keepId);

    const merged = await mergeCompanyFact(ORG_A, keepId, draft.factId, ACTOR);
    assert.equal(merged.merged, true);

    const after = await listCompanyFacts(ORG_A);
    const kept = after.find((f) => f.id === keepId);
    assert.ok(kept, 'the established line must survive');
    assert.equal(kept.content, 'All Gulf Coast properties exclusively use Ecolab chemicals.');
    assert.equal(kept.reviewState, 'confirmed');
    assert.equal(kept.topic, 'chemicals_vendor_merge', 'the slug every copilot reads does not move');
    assert.equal(after.some((f) => f.id === draft.factId), false, 'the duplicate is gone');
  });

  // Mutation: allow the arguments in either order. Merging INTO a draft would
  // hand the company's confirmed slug to a row nobody approved.
  test('a merge INTO an unconfirmed line is refused', async () => {
    const draftA = await storeCompanyFact({
      organizationId: ORG_A, topic: 'merge_guard_a', content: 'Draft one about towels.',
      category: 'standards', source: 'inferred',
    });
    const draftB = await storeCompanyFact({
      organizationId: ORG_A, topic: 'merge_guard_b', content: 'Draft two about towels.',
      category: 'standards', source: 'inferred',
    });
    const res = await mergeCompanyFact(ORG_A, draftA.factId!, draftB.factId!, ACTOR);
    assert.equal(res.merged, false);
    assert.equal(res.ok, false);
    const facts = await listCompanyFacts(ORG_A);
    assert.ok(facts.some((f) => f.id === draftB.factId), 'nothing may be removed by a refused merge');
  });

  // WALL B, at the merge. Mutation: look the rows up by id alone "because ids
  // are unguessable" — the exact reasoning that would let one management company
  // rewrite another's rulebook.
  test('a merge cannot reach across companies', async () => {
    const mine = await writeConfirmedFact(
      ORG_A, 'wall_b_keep', 'Our towels are changed on request.', 'standards',
    );
    const theirs = await storeCompanyFact({
      organizationId: ORG_B, topic: 'wall_b_drop', content: 'Their towels are changed daily.',
      category: 'standards', source: 'inferred',
    });
    assert.ok(theirs.ok && theirs.factId);

    // Company A's owner, naming company B's row. Both directions refused.
    assert.equal((await mergeCompanyFact(ORG_A, mine, theirs.factId!, ACTOR)).merged, false);
    assert.equal((await mergeCompanyFact(ORG_B, theirs.factId!, mine, ACTOR)).merged, false);

    const aFacts = await listCompanyFacts(ORG_A);
    const bFacts = await listCompanyFacts(ORG_B);
    assert.equal(
      aFacts.find((f) => f.id === mine)?.content, 'Our towels are changed on request.',
      'company A\'s line was rewritten by a cross-company merge',
    );
    assert.ok(bFacts.some((f) => f.id === theirs.factId), 'company B\'s draft was removed from outside');
  });

  // Mutation: findNearDuplicate over the WHOLE book rather than the confirmed
  // half. Two drafts would be offered against each other and a human would be
  // asked to reconcile two things neither of which is policy yet.
  test('the offer is only ever made against a CONFIRMED line', async () => {
    const facts = await listCompanyFacts(ORG_A);
    const confirmedOnly = facts
      .filter((f) => f.reviewState === 'confirmed')
      .map((f) => ({ id: f.id, topic: f.topic, content: f.content }));
    const draftsOnly = facts.filter((f) => f.reviewState === 'unreviewed');
    for (const draft of draftsOnly) {
      const match = findNearDuplicate({ id: draft.id, content: draft.content }, confirmedOnly);
      if (match) {
        assert.equal(
          facts.find((f) => f.id === match.existing.id)?.reviewState, 'confirmed',
          'a draft was offered as the thing to update',
        );
      }
    }
  });
});
