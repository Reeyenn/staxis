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
