/**
 * TWO COMPANIES, FOUR HOTELS, AND ONE WOMAN WEARING TWO HATS.
 *
 * This is the proof machinery for the company spine. Everything the walls have
 * to be true about is present here, so a test can ask a real question of a real
 * Postgres instead of a mock:
 *
 *   Gulf Coast Hotels   (company A)  Beaumont, Lufkin
 *   Piney Woods Group   (company B)  Tyler
 *   Waco Inn                          no company at all — a pre-company-spine
 *                                     hotel with pre-company-spine accounts
 *
 * The people:
 *
 *   Ana     company A, owner            every Gulf Coast hotel
 *   Maria   company A, GM of Beaumont   + oversees the rest of Gulf Coast
 *   Frank   company A, front desk       Beaumont ONLY  (the Wall A probe)
 *   Fiona   company A, finance          every Gulf Coast hotel, money only
 *   Bo      company B, owner            Tyler
 *   Vera    company B, oversees         Tyler          (the Wall B probe)
 *   Gil     company B, GM               Tyler
 *   Wanda   Waco Inn, legacy owner      accounts.role + property_access, no hat
 *   Hank    Waco Inn, legacy housekeeper same
 *
 * TWO DELIBERATE CHOICES, both load-bearing:
 *
 * 1. Every company person has `accounts.property_access = '{}'`. Not one hotel
 *    of their access comes from the legacy array, so any test that finds them
 *    reaching a hotel has proved the hat did it — and any test that finds them
 *    reaching a hotel they should not have proved a wall is missing.
 *
 * 2. Wanda and Hank have NO membership rows of any kind. They are the
 *    zero-regression control: if the resolver ever answers differently for them
 *    than `accounts.role` / `accounts.property_access` did before the company
 *    spine existed, the spine broke the product.
 *
 * The hats are created through `staxis_set_membership_hat` rather than by
 * INSERT, because that RPC is the only writer production has — service_role
 * holds SELECT and nothing else on `organization_memberships` (migration 0325).
 * Seeding through the front door means the fixture also proves the door works.
 *
 * NOTE ON RLS: PGlite runs as the table owner, exactly as the service-role key
 * bypasses policies in production. What is under test is app-level scoping.
 */

import type { PGlite } from '@electric-sql/pglite';

// ─── Hotels ────────────────────────────────────────────────────────────────
export const PID_A1 = 'a1a1a1a1-0000-4000-8000-000000000001'; // Beaumont, company A
export const PID_A2 = 'a2a2a2a2-0000-4000-8000-000000000001'; // Lufkin,   company A
export const PID_B1 = 'b1b1b1b1-0000-4000-8000-000000000001'; // Tyler,    company B
export const PID_L1 = '1e6ac41e-0000-4000-8000-000000000001'; // Waco Inn, no company
/** Attached to company A only by the auto-coverage test — NOT seeded into it. */
export const PID_A3 = 'a3a3a3a3-0000-4000-8000-000000000001'; // Port Arthur

// ─── Companies ─────────────────────────────────────────────────────────────
export const ORG_A = 'aaaa0000-0000-4000-8000-00000000000a';
export const ORG_B = 'bbbb0000-0000-4000-8000-00000000000b';

// ─── People (accounts.id) ──────────────────────────────────────────────────
export const ACCOUNT_ADMIN = '00000000-0000-4000-8000-00000000ad01'; // Staxis, not a member
export const ACCOUNT_ANA = 'aaaa1111-0000-4000-8000-000000000001';
export const ACCOUNT_MARIA = 'aaaa1111-0000-4000-8000-000000000002';
export const ACCOUNT_FRANK = 'aaaa1111-0000-4000-8000-000000000003';
export const ACCOUNT_FIONA = 'aaaa1111-0000-4000-8000-000000000004';
export const ACCOUNT_BO = 'bbbb1111-0000-4000-8000-000000000001';
export const ACCOUNT_VERA = 'bbbb1111-0000-4000-8000-000000000002';
export const ACCOUNT_GIL = 'bbbb1111-0000-4000-8000-000000000003';
export const ACCOUNT_WANDA = '1e6ac41e-0000-4000-8000-000000000002';
export const ACCOUNT_HANK = '1e6ac41e-0000-4000-8000-000000000003';

/** auth.users ids, in the same order — `data_user_id` on each account. */
export const UID_ADMIN = '00000000-0000-4000-8000-00000000ad02';
export const UID_ANA = 'aaaa2222-0000-4000-8000-000000000001';
export const UID_MARIA = 'aaaa2222-0000-4000-8000-000000000002';
export const UID_FRANK = 'aaaa2222-0000-4000-8000-000000000003';
export const UID_FIONA = 'aaaa2222-0000-4000-8000-000000000004';
export const UID_BO = 'bbbb2222-0000-4000-8000-000000000001';
export const UID_VERA = 'bbbb2222-0000-4000-8000-000000000002';
export const UID_GIL = 'bbbb2222-0000-4000-8000-000000000003';
export const UID_WANDA = '1e6ac41e-0000-4000-8000-000000000004';
export const UID_HANK = '1e6ac41e-0000-4000-8000-000000000005';

export interface TwoCompanySeed {
  /** membership id of every hat created, keyed `<accountId>:<scope>:<role>`. */
  hats: Map<string, string>;
  /** Attach a hotel to a company AFTER the fact — the auto-coverage probe. */
  attachPropertyToOrganization(
    pg: PGlite,
    organizationId: string,
    propertyId: string,
    propertyName: string,
  ): Promise<void>;
}

interface PersonSpec {
  accountId: string;
  authUserId: string;
  username: string;
  displayName: string;
  /** The legacy `accounts.role` word this person's login carries. */
  legacyRole: string;
  propertyAccess: string[];
}

const PEOPLE: readonly PersonSpec[] = [
  { accountId: ACCOUNT_ANA, authUserId: UID_ANA, username: 'ana', displayName: 'Ana', legacyRole: 'owner', propertyAccess: [] },
  { accountId: ACCOUNT_MARIA, authUserId: UID_MARIA, username: 'maria', displayName: 'Maria', legacyRole: 'general_manager', propertyAccess: [] },
  { accountId: ACCOUNT_FRANK, authUserId: UID_FRANK, username: 'frank', displayName: 'Frank', legacyRole: 'front_desk', propertyAccess: [] },
  { accountId: ACCOUNT_FIONA, authUserId: UID_FIONA, username: 'fiona', displayName: 'Fiona', legacyRole: 'front_desk', propertyAccess: [] },
  { accountId: ACCOUNT_BO, authUserId: UID_BO, username: 'bo', displayName: 'Bo', legacyRole: 'owner', propertyAccess: [] },
  { accountId: ACCOUNT_VERA, authUserId: UID_VERA, username: 'vera', displayName: 'Vera', legacyRole: 'general_manager', propertyAccess: [] },
  { accountId: ACCOUNT_GIL, authUserId: UID_GIL, username: 'gil', displayName: 'Gil', legacyRole: 'general_manager', propertyAccess: [] },
  // The control group. These two are exactly what every account in the product
  // looks like today.
  { accountId: ACCOUNT_WANDA, authUserId: UID_WANDA, username: 'wanda', displayName: 'Wanda', legacyRole: 'owner', propertyAccess: [PID_L1] },
  { accountId: ACCOUNT_HANK, authUserId: UID_HANK, username: 'hank', displayName: 'Hank', legacyRole: 'housekeeping', propertyAccess: [PID_L1] },
];

const HOTELS: readonly (readonly [string, string])[] = [
  [PID_A1, 'Beaumont Suites'],
  [PID_A2, 'Lufkin Inn'],
  [PID_B1, 'Tyler Lodge'],
  [PID_L1, 'Waco Inn'],
];

async function insertProperty(pg: PGlite, id: string, name: string, ownerUid: string): Promise<void> {
  await pg.query(
    `insert into properties (id, name, owner_id, total_rooms, timezone)
     values ($1, $2, $3, 60, 'America/Chicago') on conflict (id) do nothing`,
    [id, name, ownerUid],
  );
}

/**
 * Attach a hotel to a real company. The single-hotel compatibility anchor that
 * migration 0325 auto-creates for every property keeps its own relationship
 * row; the company's row is added alongside it as the primary grouping, which
 * is what production does when an independent hotel joins a management company.
 */
async function attachProperty(
  pg: PGlite,
  organizationId: string,
  propertyId: string,
): Promise<void> {
  // Exactly one OPEN primary grouping per hotel is a partial unique index, so
  // the anchor's claim is stood down before the company takes it.
  await pg.query(
    `update organization_property_relationships
        set is_primary_grouping = false
      where property_id = $1 and ends_at is null and is_primary_grouping`,
    [propertyId],
  );
  await pg.query(
    `insert into organization_property_relationships
       (organization_id, property_id, relationship_type, is_primary_grouping)
     values ($1, $2, 'operator', true)
     on conflict do nothing`,
    [organizationId, propertyId],
  );
}

/**
 * Seed both companies, the standalone hotel, and every person.
 *
 * Idempotent enough to call once per test file; it is NOT designed to be called
 * twice against the same database.
 */
export async function seedTwoCompanies(pg: PGlite): Promise<TwoCompanySeed> {
  // ── Logins ───────────────────────────────────────────────────────────────
  await pg.query(
    `insert into auth.users (id, email) values ($1, 'staxis-admin@example.test')
     on conflict (id) do nothing`,
    [UID_ADMIN],
  );
  for (const person of PEOPLE) {
    await pg.query(
      `insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`,
      [person.authUserId, `${person.username}@example.test`],
    );
  }

  // ── Hotels ───────────────────────────────────────────────────────────────
  for (const [id, name] of HOTELS) {
    await insertProperty(pg, id, name, UID_ADMIN);
  }

  // ── The Staxis administrator who bootstraps both companies ───────────────
  // Deliberately NOT a member of either. Migration 0325 refuses to let a Staxis
  // admin hold a customer membership; they are only ever the actor.
  await pg.query(
    `insert into accounts (id, username, password_hash, display_name, role, property_access, data_user_id)
     values ($1, 'staxis', 'x', 'Staxis Admin', 'admin', '{}', $2)
     on conflict (id) do nothing`,
    [ACCOUNT_ADMIN, UID_ADMIN],
  );

  // ── People ───────────────────────────────────────────────────────────────
  for (const person of PEOPLE) {
    await pg.query(
      `insert into accounts (id, username, password_hash, display_name, role, property_access, data_user_id)
       values ($1, $2, 'x', $3, $4, $5, $6) on conflict (id) do nothing`,
      [
        person.accountId,
        person.username,
        person.displayName,
        person.legacyRole,
        `{${person.propertyAccess.join(',')}}`,
        person.authUserId,
      ],
    );
  }

  // ── Companies ────────────────────────────────────────────────────────────
  await pg.query(
    `insert into organizations (id, name, organization_type, status)
     values ($1, 'Gulf Coast Hotels', 'management_company', 'active'),
            ($2, 'Piney Woods Group', 'management_company', 'active')
     on conflict (id) do nothing`,
    [ORG_A, ORG_B],
  );

  await attachProperty(pg, ORG_A, PID_A1);
  await attachProperty(pg, ORG_A, PID_A2);
  await attachProperty(pg, ORG_B, PID_B1);
  // Waco Inn is attached to nothing. That absence is the point.

  // ── Hats, through the only door production has ───────────────────────────
  const hats = new Map<string, string>();
  const wear = async (
    organizationId: string,
    accountId: string,
    scope: 'company' | 'property',
    role: string,
    propertyIds: string[] | null,
    jobTitle: string | null,
  ) => {
    const result = await pg.query<{ staxis_set_membership_hat: string }>(
      `select public.staxis_set_membership_hat($1, $2, $3, $4, $5, $6, $7) as staxis_set_membership_hat`,
      [
        ACCOUNT_ADMIN,
        organizationId,
        accountId,
        scope,
        role,
        propertyIds === null ? null : JSON.stringify(propertyIds),
        jobTitle,
      ],
    );
    const membershipId = result.rows[0]?.staxis_set_membership_hat;
    if (!membershipId) throw new Error(`seed: hat ${role}@${scope} was refused for ${accountId}`);
    hats.set(`${accountId}:${scope}:${role}`, membershipId);
  };

  await wear(ORG_A, ACCOUNT_ANA, 'company', 'owner', null, 'Owner');
  // Maria's two hats. The GM hat names her job at Beaumont; the company hat is
  // what "and she oversees the others" means.
  await wear(ORG_A, ACCOUNT_MARIA, 'property', 'general_manager', [PID_A1], 'General Manager');
  await wear(ORG_A, ACCOUNT_MARIA, 'company', 'vp', null, 'VP of Operations');
  await wear(ORG_A, ACCOUNT_FRANK, 'property', 'front_desk', [PID_A1], 'Front Desk');
  await wear(ORG_A, ACCOUNT_FIONA, 'company', 'finance', null, 'Controller');

  await wear(ORG_B, ACCOUNT_BO, 'company', 'owner', null, 'Owner');
  await wear(ORG_B, ACCOUNT_VERA, 'company', 'vp', null, 'VP of Operations');
  await wear(ORG_B, ACCOUNT_GIL, 'property', 'general_manager', [PID_B1], 'General Manager');

  return {
    hats,
    async attachPropertyToOrganization(target, organizationId, propertyId, propertyName) {
      await insertProperty(target, propertyId, propertyName, UID_ADMIN);
      await attachProperty(target, organizationId, propertyId);
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// CROSS-HOTEL CHAT: the operating data, planted so a leak is LOUD
// ═══════════════════════════════════════════════════════════════════════════
//
// The portfolio surface answers with numbers, so proving it does not leak means
// proving company B's NUMBERS never appear in company A's answer. A quiet
// fixture cannot do that: if both companies looked similar, a tool that
// accidentally summed all three hotels would produce a plausible total and every
// assertion would pass.
//
// So company B is deliberately enormous. Tyler alone carries more work orders,
// more supply spend and more open findings than both Gulf Coast hotels put
// together, by an order of magnitude. Any cross-company sum, ranking or average
// is therefore dominated by it, and the LEAK_MARKER on every one of its
// free-text columns makes the leak visible in the tool's own output rather than
// only in a total somebody has to recompute by hand.
//
// The same trick the per-hotel suite uses (`pglite-two-hotel-seed.ts`), applied
// one level up: there, hotel B's rows share LOOKUP VALUES with hotel A's so an
// unfiltered `.eq('room_number','101')` matches the wrong hotel. Here, hotel B's
// rows share nothing but their shape — because a portfolio tool does not look
// anything up by name, it aggregates a SET of hotels, and the way that goes
// wrong is the set being wrong.

/** Any of these appearing in company A's answer is a leak. */
export const PORTFOLIO_LEAK_MARKER = 'ZZLEAKB';

/** Every seeded number, so assertions quote the fixture rather than a literal. */
export const PORTFOLIO_FACTS = {
  beaumont: { workOrders: 2, supplySpendDollars: 200, openFindings: 1 },
  lufkin: { workOrders: 5, supplySpendDollars: 700, openFindings: 3 },
  /** Company B. Bigger than both of company A's hotels put together, 10x over. */
  tyler: { workOrders: 99, supplySpendDollars: 99_999, openFindings: 40 },
} as const;

const DAY_MS = 86_400_000;

async function seedWorkOrders(
  pg: PGlite,
  propertyId: string,
  count: number,
  label: string,
  repairCostEach: number,
): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await pg.query(
      `insert into work_orders
         (property_id, room_number, description, severity, status, repair_cost, created_at)
       values ($1, $2, $3, 'MAJOR', $4, $5, $6)`,
      [
        propertyId,
        `${100 + i}`,
        `${label} ticket ${i + 1}`,
        i % 3 === 0 ? 'resolved' : 'submitted',
        repairCostEach,
        new Date(Date.now() - (i + 1) * DAY_MS).toISOString(),
      ],
    );
  }
}

async function seedSupplySpend(
  pg: PGlite,
  propertyId: string,
  totalDollars: number,
  label: string,
): Promise<void> {
  const itemId = (await pg.query<{ id: string }>(
    `insert into inventory (property_id, name, category, current_stock, par_level, unit)
     values ($1, $2, 'housekeeping', $3, 100, 'units') returning id`,
    [propertyId, `${label} towels`, label.includes(PORTFOLIO_LEAK_MARKER) ? 5 : 90],
  )).rows[0].id;

  // Two deliveries, so "deliveries" is never 1 and a per-row bug is visible.
  for (const share of [0.4, 0.6]) {
    await pg.query(
      `insert into inventory_orders
         (property_id, item_id, item_name, quantity, unit_cost, total_cost, received_at)
       values ($1, $2, $3, 10, $4, $5, $6)`,
      [
        propertyId,
        itemId,
        `${label} towels`,
        (totalDollars * share) / 10,
        totalDollars * share,
        new Date(Date.now() - 3 * DAY_MS).toISOString(),
      ],
    );
  }
}

async function seedFindings(
  pg: PGlite,
  propertyId: string,
  count: number,
  label: string,
): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await pg.query(
      `insert into findings
         (property_id, detector_id, dedupe_key, summary, severity, disposition, status,
          receipt_query_id, magnitude, price_low_cents, price_high_cents, price_basis)
       values ($1, 'seeded_probe', $2, $3, $4, $5, 'open', 'seeded_receipt', $6, $7, $8, $9)`,
      [
        propertyId,
        `seeded_probe:${label}:${i}`,
        `${label} problem ${i + 1}`,
        i === 0 ? 'critical' : 'attention',
        i % 2 === 0 ? 'propose' : 'recommend',
        i + 1,
        10_000 * (i + 1),
        20_000 * (i + 1),
        `${label} basis`,
      ],
    );
  }
}

/**
 * Turn cross-hotel chat on or off for a company, through the same table
 * `companyAccessSetting` reads. Exposed so a test can flip the switch MID-RUN
 * and watch the door close — the gate is only proved by both answers.
 */
export async function setCrossHotelChat(
  pg: PGlite,
  organizationId: string,
  on: boolean,
): Promise<void> {
  await pg.query(
    `insert into company_access_settings (organization_id, setting_key, setting_value)
     values ($1, 'cross_hotel_ai_chat', $2)
     on conflict (organization_id, setting_key)
       do update set setting_value = excluded.setting_value`,
    [organizationId, on ? 'true' : 'false'],
  );
}

/**
 * Plant the operating data both companies are asked about, plus each company's
 * rulebook, plus company A's cross-hotel switch ON and company B's left at its
 * default (off) — which is what makes Vera the honest "company VP whose company
 * has not turned it on" probe rather than a synthetic one.
 */
export async function seedPortfolioData(pg: PGlite): Promise<void> {
  await seedWorkOrders(pg, PID_A1, PORTFOLIO_FACTS.beaumont.workOrders, 'Beaumont', 120);
  await seedWorkOrders(pg, PID_A2, PORTFOLIO_FACTS.lufkin.workOrders, 'Lufkin', 300);
  await seedWorkOrders(
    pg, PID_B1, PORTFOLIO_FACTS.tyler.workOrders, `${PORTFOLIO_LEAK_MARKER} Tyler`, 9_999,
  );

  await seedSupplySpend(pg, PID_A1, PORTFOLIO_FACTS.beaumont.supplySpendDollars, 'Beaumont');
  await seedSupplySpend(pg, PID_A2, PORTFOLIO_FACTS.lufkin.supplySpendDollars, 'Lufkin');
  await seedSupplySpend(
    pg, PID_B1, PORTFOLIO_FACTS.tyler.supplySpendDollars, `${PORTFOLIO_LEAK_MARKER} Tyler`,
  );

  await seedFindings(pg, PID_A1, PORTFOLIO_FACTS.beaumont.openFindings, 'Beaumont');
  await seedFindings(pg, PID_A2, PORTFOLIO_FACTS.lufkin.openFindings, 'Lufkin');
  await seedFindings(
    pg, PID_B1, PORTFOLIO_FACTS.tyler.openFindings, `${PORTFOLIO_LEAK_MARKER} Tyler`,
  );

  await pg.query(
    `insert into company_knowledge
       (organization_id, topic, content, category, source, review_state, is_active)
     values
       ($1, 'chemical_vendor', 'All Gulf Coast hotels use Ecolab for chemicals.', 'vendors', 'explicit_user', 'confirmed', true),
       ($1, 'draft_rule', 'Gulf Coast is thinking about a new laundry vendor.', 'vendors', 'inferred', 'unreviewed', true),
       ($2, 'piney_secret', $3, 'money', 'explicit_user', 'confirmed', true)`,
    [ORG_A, ORG_B, `${PORTFOLIO_LEAK_MARKER} Piney Woods pays $9,999 a month for laundry.`],
  );

  await setCrossHotelChat(pg, ORG_A, true);
  // Company B is deliberately left with NO row, so its answer comes from the
  // documented default. A test that seeded 'false' would prove the reader honors
  // a stored no; this proves it honors the absence of a yes, which is the state
  // every company in the product is actually in.
}

// ═══════════════════════════════════════════════════════════════════════════
// A COMPANY THE SIZE OF A REAL CUSTOMER
// ═══════════════════════════════════════════════════════════════════════════
//
// Two hotels prove the wall. They do not prove the PRODUCT, because the founder's
// stated case is a VP with seventeen to twenty of them, and every portfolio tool
// fans out one read set per hotel. At N=2 a per-hotel loop is invisible; at N=17
// it is the answer's latency, the turn's database load, and most of the tokens
// the model is billed for.
//
// So this seeds a THIRD company, `Coastal Bend Management`, with as many hotels
// as a caller asks for and deliberately UNEVEN data — every hotel a different
// size, a different number of tickets, a different spend — so that:
//
//   • a ranking has one unambiguous right answer that a test can recompute from
//     SQL rather than restate from the fixture, and
//   • an answer that silently drops hotels is visibly wrong rather than merely
//     smaller.
//
// It is a SEPARATE company on purpose. `seedPortfolioData` is untouched, so the
// leak suite's two-company arithmetic still reads 2 hotels, 7 work orders and
// $900 exactly as it did before this existed.

export const ORG_C = 'cccc0000-0000-4000-8000-00000000000c';
export const ACCOUNT_CARL = 'cccc1111-0000-4000-8000-000000000001';
export const UID_CARL = 'cccc2222-0000-4000-8000-000000000001';

/** Hotel `n` of the big company, 1-based. Deterministic, so a test can name one. */
export function largeCompanyPropertyId(n: number): string {
  return `c1c1c1c1-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/** What one hotel of the big company was seeded with. The test's brute force. */
export interface LargeCompanyHotelPlan {
  propertyId: string;
  name: string;
  rooms: number;
  /** Work orders created inside the last 30 days. */
  workOrders: number;
  /** Of those, the ones left un-resolved. */
  workOrdersStillOpen: number;
  repairCostEach: number;
  /** Findings at status open/updated — what "open items" counts. */
  openFindings: number;
  /** Findings at status known_problem — counted separately, never as open. */
  knownProblems: number;
  supplySpendDollars: number;
  inventoryItems: number;
  criticalItems: number;
}

/**
 * The shape of hotel `n`, decided by arithmetic rather than by a table, so the
 * fixture is the same at N=17 and N=50 and a test can plan for any size.
 *
 * The multipliers are coprime-ish with the modulus so the sequences do not fall
 * into step with each other — the hotel with the most work orders must not also
 * be the hotel with the most findings, or a ranking bug that sorts on the wrong
 * column would still name the right hotel.
 */
export function largeCompanyPlan(n: number): LargeCompanyHotelPlan {
  const workOrders = ((n * 7) % 23) + 2;
  return {
    propertyId: largeCompanyPropertyId(n),
    name: `Coastal Bend Hotel ${String(n).padStart(2, '0')}`,
    rooms: 40 + ((n * 17) % 9) * 20,
    workOrders,
    // Every third ticket is resolved (i % 3 === 0 below), matching the small
    // fixture's rhythm.
    workOrdersStillOpen: workOrders - Math.ceil(workOrders / 3),
    repairCostEach: 50 + ((n * 13) % 9) * 25,
    openFindings: ((n * 11) % 19) + 1,
    knownProblems: n % 4,
    supplySpendDollars: 250 + ((n * 37) % 17) * 90,
    inventoryItems: 8 + (n % 5),
    criticalItems: 1 + (n % 4),
  };
}

const DEFAULT_LARGE_COMPANY_SIZE = 17;

/**
 * Seed the big company, its hotels, its data, and one VP who oversees all of it.
 *
 * @param hotelCount how many hotels. Defaults to 17 — the low end of the size
 *                   the founder describes, and the number the scale suite times.
 * @returns the plan for every hotel, in hotel order.
 */
export async function seedLargeCompany(
  pg: PGlite,
  hotelCount: number = DEFAULT_LARGE_COMPANY_SIZE,
): Promise<LargeCompanyHotelPlan[]> {
  const plans = Array.from({ length: hotelCount }, (_, i) => largeCompanyPlan(i + 1));

  await pg.query(
    `insert into auth.users (id, email) values ($1, 'carl@example.test')
     on conflict (id) do nothing`,
    [UID_CARL],
  );
  await pg.query(
    `insert into accounts (id, username, password_hash, display_name, role, property_access, data_user_id)
     values ($1, 'carl', 'x', 'Carl', 'general_manager', '{}', $2)
     on conflict (id) do nothing`,
    [ACCOUNT_CARL, UID_CARL],
  );
  await pg.query(
    `insert into organizations (id, name, organization_type, status)
     values ($1, 'Coastal Bend Management', 'management_company', 'active')
     on conflict (id) do nothing`,
    [ORG_C],
  );

  for (const plan of plans) {
    await pg.query(
      `insert into properties (id, name, owner_id, total_rooms, timezone)
       values ($1, $2, $3, $4, 'America/Chicago') on conflict (id) do nothing`,
      [plan.propertyId, plan.name, UID_ADMIN, plan.rooms],
    );
    await attachProperty(pg, ORG_C, plan.propertyId);
  }

  // The hat, through the same RPC production uses. Company scope with a null
  // property list means "every hotel this company operates", which is what makes
  // adding hotel 18 a seeding detail rather than a permissions change.
  const hat = await pg.query<{ staxis_set_membership_hat: string }>(
    `select public.staxis_set_membership_hat($1, $2, $3, 'company', 'vp', null, 'VP of Operations')
       as staxis_set_membership_hat`,
    [ACCOUNT_ADMIN, ORG_C, ACCOUNT_CARL],
  );
  if (!hat.rows[0]?.staxis_set_membership_hat) {
    throw new Error('seed: the big company VP hat was refused');
  }

  for (const plan of plans) await seedLargeCompanyHotel(pg, plan);

  await pg.query(
    `insert into company_knowledge
       (organization_id, topic, content, category, source, review_state, is_active)
     values ($1, 'linen_standard', 'Every Coastal Bend hotel keeps 3 par of linen.', 'standards', 'explicit_user', 'confirmed', true)`,
    [ORG_C],
  );

  await setCrossHotelChat(pg, ORG_C, true);
  return plans;
}

/** One hotel's operating data, in four batched statements rather than ~40. */
async function seedLargeCompanyHotel(pg: PGlite, plan: LargeCompanyHotelPlan): Promise<void> {
  const { propertyId, name } = plan;

  if (plan.workOrders > 0) {
    const values: unknown[] = [];
    const tuples: string[] = [];
    for (let i = 0; i < plan.workOrders; i += 1) {
      const base = values.length;
      tuples.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`);
      values.push(
        propertyId,
        `${100 + i}`,
        `${name} ticket ${i + 1}`,
        i % 4 === 0 ? 'urgent' : 'MAJOR',
        i % 3 === 0 ? 'resolved' : 'submitted',
        plan.repairCostEach,
        // Inside 30 days, so the default window covers every seeded ticket and a
        // days=7 question genuinely narrows.
        new Date(Date.now() - ((i % 25) + 1) * DAY_MS).toISOString(),
      );
    }
    await pg.query(
      `insert into work_orders
         (property_id, room_number, description, severity, status, repair_cost, created_at)
       values ${tuples.join(',')}`,
      values,
    );
  }

  // Inventory: a mix of Good and Critical against par, so the 70/30 buckets and
  // the "worst items" list both have something real to sort.
  const itemIds: string[] = [];
  for (let i = 0; i < plan.inventoryItems; i += 1) {
    const critical = i < plan.criticalItems;
    const row = await pg.query<{ id: string }>(
      `insert into inventory (property_id, name, category, current_stock, par_level, unit)
       values ($1, $2, 'housekeeping', $3, 100, 'units') returning id`,
      [propertyId, `${name} item ${i + 1}`, critical ? 5 + i : 85 + i],
    );
    itemIds.push(row.rows[0].id);
  }

  for (const share of [0.4, 0.6]) {
    await pg.query(
      `insert into inventory_orders
         (property_id, item_id, item_name, quantity, unit_cost, total_cost, received_at)
       values ($1, $2, $3, 10, $4, $5, $6)`,
      [
        propertyId,
        itemIds[0],
        `${name} item 1`,
        (plan.supplySpendDollars * share) / 10,
        plan.supplySpendDollars * share,
        new Date(Date.now() - 3 * DAY_MS).toISOString(),
      ],
    );
  }

  const total = plan.openFindings + plan.knownProblems;
  if (total > 0) {
    const values: unknown[] = [];
    const tuples: string[] = [];
    for (let i = 0; i < total; i += 1) {
      const known = i >= plan.openFindings;
      const base = values.length;
      tuples.push(
        `($${base + 1}, 'seeded_probe', $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, `
        + `$${base + 6}, 'seeded_receipt', $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10})`,
      );
      values.push(
        propertyId,
        `seeded_probe:${propertyId}:${i}`,
        `${name} problem ${i + 1}`,
        i === 0 ? 'critical' : 'attention',
        i % 2 === 0 ? 'propose' : 'recommend',
        known ? 'known_problem' : (i % 5 === 0 ? 'updated' : 'open'),
        i + 1,
        10_000 * (i + 1),
        20_000 * (i + 1),
        `${name} basis`,
      );
    }
    await pg.query(
      `insert into findings
         (property_id, detector_id, dedupe_key, summary, severity, disposition, status,
          receipt_query_id, magnitude, price_low_cents, price_high_cents, price_basis)
       values ${tuples.join(',')}`,
      values,
    );
  }
}
