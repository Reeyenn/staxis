/**
 * Seed the hotel the nightly robot walks.
 *
 * ONE HOTEL, ONE MANAGER, ONE COLLEAGUE. The robot signs in as that manager
 * every night and does what a person does. Everything it creates while it is
 * there is named with the ROBOT_WALK_MARKER prefix and cleaned up before it
 * leaves, so this hotel only ever holds what this script put in it.
 *
 * ─── RUN IT ────────────────────────────────────────────────────────────────
 *
 *   ROBOT_WALK_PASSWORD='<the password you will also put in GitHub>' \
 *     npx tsx --conditions=react-server scripts/robot-walk/seed.ts
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from .env.local
 * the same way every other script here does. Prints the hotel id and the
 * manager's auth user id at the end, both of which the operator needs — see the
 * closing instructions the script itself writes out.
 *
 * ─── IDEMPOTENT ────────────────────────────────────────────────────────────
 *
 * Safe to run again, and running it again is how you rotate the password. Every
 * step is find-then-create: the hotel by name, the accounts by username, the
 * staff rows by name. It never creates a second Robot Hotel and it never
 * duplicates a person. It also never DELETES anything, so a bad run is
 * recoverable by hand rather than by restore.
 *
 * ─── WHY IT SITS UNDER A MANAGEMENT COMPANY ────────────────────────────────
 *
 * The hotel is `is_test`, and it is attached to the demo management company, so
 * the scheduled management-company pass excludes it: that exclusion is "every
 * hotel this company governs is a test hotel" (src/lib/company/demo-portfolio.ts),
 * which only holds while the company's whole portfolio is test hotels. Attaching
 * the robot's hotel to a company with a real hotel in it would silently switch
 * that company back on for nightly paid model runs.
 *
 * ─── SIGNING IN ────────────────────────────────────────────────────────────
 *
 * The manager is marked `skip_2fa`, which is necessary and NOT sufficient: the
 * bypass also needs the account's auth user id in the SKIP_2FA_USER_IDS
 * environment variable. That is an operator step, on purpose — a code path that
 * could switch off two-factor for an account on its own is a code path worth not
 * having. The script prints the id to paste.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { loadEnv } from '../load-env';
import { buildStandardTestRoomNumbers } from '../../src/lib/test-room-roster';

// ─── What the seed builds ────────────────────────────────────────────────────

export const ROBOT_HOTEL_NAME = 'Robot Hotel';
export const ROBOT_MANAGER_USERNAME = 'robot.manager';
export const ROBOT_MANAGER_DISPLAY = 'Robot Manager';
/**
 * The colleague the robot hands a to-do to. `front_desk` and not
 * `housekeeping`: the assignee list deliberately excludes housekeepers
 * (src/lib/worklist/assignable.ts), so a housekeeper here would leave the
 * robot with nobody to assign to and a step that fails every night for a
 * reason that is not a bug.
 */
export const ROBOT_COLLEAGUE_NAME = 'Robot Colleague';
export const ROBOT_COLLEAGUE_DEPARTMENT = 'front_desk';
export const ROBOT_HOTEL_ROOMS = 20;
export const ROBOT_HOTEL_TIMEZONE = 'America/Chicago';

/** Gulf Coast Hotels, the demo management company. Overridable for a rehearsal. */
export const DEFAULT_ROBOT_ORG_ID = '11110000-0000-4000-8000-0000000000a1';

// ─── The two things the seed needs from the outside world ────────────────────

/**
 * The subset of supabase-js this script uses, so the standing test can drive the
 * REAL seed against a real schema through the PGlite PostgREST shim rather than
 * against a hand-written mock of it. A query builder is genuinely dynamic, so
 * the shape is loose here and the constraints are the ones the database
 * enforces.
 */
export interface SeedOutcome { data: unknown; error: unknown }
export interface SeedChain extends PromiseLike<SeedOutcome> {
  select(columns?: string): SeedChain;
  eq(column: string, value: unknown): SeedChain;
  insert(rows: unknown): SeedChain;
  update(patch: Record<string, unknown>): SeedChain;
  maybeSingle(): Promise<SeedOutcome>;
}
export interface SeedDb {
  from(table: string): SeedChain;
  rpc(fn: string, args?: Record<string, unknown>): Promise<SeedOutcome>;
}

export interface SeedAuth {
  /** Find or create the auth user for this email, set its password, return its id. */
  ensureUser(input: {
    email: string;
    password: string;
    username: string;
    displayName: string;
  }): Promise<string>;
}

export interface SeedOptions {
  password: string;
  organizationId?: string;
  adminUsername?: string;
  log?: (line: string) => void;
}

export interface SeedResult {
  propertyId: string;
  propertyCreated: boolean;
  managerAccountId: string;
  managerAuthUserId: string;
  colleagueStaffId: string;
  managerStaffId: string;
}

/**
 * The manager's current authority version, read the way the app reads it.
 *
 * NOT `select authority_version from account_authorization_state`. That table is
 * revoked from service_role, so the direct read is a 42501 in production while
 * passing in any test whose role owns the tables. `/api/auth/accounts` makes
 * this exact call for the same reason.
 */
async function readAuthorityVersion(db: SeedDb, accountId: string): Promise<number> {
  const res = await db.rpc('staxis_list_account_authorization_admin', { p_account_id: accountId });
  if (res.error) fail('read authority version', res.error);
  const raw = (res.data ?? null) as Record<string, unknown> | null;
  const version = raw?.authorityVersion;
  if (raw?.ok !== true
    || typeof version !== 'number'
    || !Number.isSafeInteger(version)
    || version <= 0) {
    fail('read authority version', `unusable answer: ${JSON.stringify(raw)}`);
  }
  return version;
}

/** What the manager can actually reach, asked of the canonical read. */
async function reachableProperties(db: SeedDb, accountId: string): Promise<string[]> {
  const res = await db.rpc('staxis_list_account_authorized_properties', { p_account_id: accountId });
  if (res.error) fail('confirm hotel access', res.error);
  const raw = (res.data ?? null) as { ok?: unknown; propertyIds?: unknown } | null;
  if (raw?.ok !== true || !Array.isArray(raw.propertyIds)) {
    fail('confirm hotel access', `unusable answer: ${JSON.stringify(raw)}`);
  }
  return (raw.propertyIds as unknown[]).filter((id): id is string => typeof id === 'string');
}

/**
 * Make this hotel, and only this hotel, the manager's whole access.
 *
 * The scope call is DECLARATIVE — the array it is given is the account's entire
 * access afterwards — so running it again with the same hotel is a no-op, which
 * is what lets the whole seed be rerun.
 *
 * It is also optimistically concurrent: it refuses a stale authority version,
 * and the version moves whenever anything about the account changes, including
 * the update this seed just made. One re-read and one retry covers a version
 * that moved between the read and the write; a second refusal is a real
 * disagreement and is reported rather than hammered.
 *
 * Finally it CONFIRMS, through the canonical read, that the hotel is reachable.
 * A refusal that returns `ok:false` in a shape nobody checked is how a seed
 * finishes cleanly and leaves an account that cannot sign in anywhere.
 */
async function grantHotelAccess(db: SeedDb, input: {
  actorAccountId: string;
  accountId: string;
  propertyId: string;
  say: (line: string) => void;
}): Promise<void> {
  const { actorAccountId, accountId, propertyId, say } = input;

  let refusal: string | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const authorityVersion = await readAuthorityVersion(db, accountId);
    const res = await db.rpc('staxis_set_account_authorization_scope', {
      p_actor_account_id: actorAccountId,
      p_account_id: accountId,
      p_property_ids: [propertyId],
      p_expected_authority_version: authorityVersion,
      p_expected_role: 'general_manager',
      p_new_role: 'general_manager',
      p_reason: 'robot walkthrough seed',
    });
    if (res.error) fail('grant hotel access', res.error);

    const scope = (res.data ?? null) as { ok?: boolean; status?: string; reason?: string } | null;
    if (scope?.ok === true) { refusal = null; break; }
    refusal = `${scope?.status ?? 'refused'}: ${scope?.reason ?? 'no reason given'}`;
    say(`access grant refused (${refusal}), re-reading the authority version`);
  }
  if (refusal) fail('grant hotel access', refusal);

  const reachable = await reachableProperties(db, accountId);
  if (!reachable.includes(propertyId)) {
    fail('confirm hotel access', `the grant reported success but the manager reaches ${JSON.stringify(reachable)}`);
  }
  say(`manager can reach the hotel (${reachable.length} hotel(s) in scope)`);
}

function fail(step: string, detail: unknown): never {
  const text = detail instanceof Error
    ? detail.message
    : typeof detail === 'string' ? detail : JSON.stringify(detail);
  throw new Error(`robot-walk seed failed at "${step}": ${text}`);
}

/**
 * Build (or confirm) everything the nightly walk needs.
 *
 * The order is load-bearing and each dependency is noted where it bites.
 */
export async function seedRobotHotel(
  db: SeedDb,
  auth: SeedAuth,
  opts: SeedOptions,
): Promise<SeedResult> {
  const say = opts.log ?? (() => {});
  const organizationId = opts.organizationId ?? DEFAULT_ROBOT_ORG_ID;
  const adminUsername = opts.adminUsername ?? 'reeyen';

  if (typeof opts.password !== 'string' || opts.password.length < 12) {
    fail('password', 'ROBOT_WALK_PASSWORD must be at least 12 characters');
  }

  // ── 1. The Staxis admin, who is the actor for every authority change ─────
  const adminRes = await db
    .from('accounts')
    .select('id, data_user_id')
    .eq('username', adminUsername)
    .eq('role', 'admin')
    .maybeSingle();
  if (adminRes.error) fail('read admin account', adminRes.error);
  const admin = adminRes.data as { id: string; data_user_id: string } | null;
  if (!admin) fail('read admin account', `no admin account with username "${adminUsername}"`);
  say(`admin actor: ${admin.id}`);

  // ── 2. The hotel ─────────────────────────────────────────────────────────
  const existingRes = await db
    .from('properties')
    .select('id')
    .eq('name', ROBOT_HOTEL_NAME)
    .maybeSingle();
  if (existingRes.error) fail('read hotel', existingRes.error);

  let propertyId = (existingRes.data as { id: string } | null)?.id ?? null;
  const propertyCreated = propertyId === null;

  if (!propertyId) {
    // The RPC builds the shell and its canonical room roster in one transaction
    // and rolls the shell back if the roster does not come out right, which a
    // plain insert plus a second write cannot promise.
    const createdRes = await db.rpc('staxis_create_test_property_with_roster', {
      p_owner_id: admin.data_user_id,
      p_name: ROBOT_HOTEL_NAME,
      p_total_rooms: ROBOT_HOTEL_ROOMS,
      p_timezone: ROBOT_HOTEL_TIMEZONE,
      p_pms_type: null,
      p_brand: null,
      p_property_kind: 'limited_service',
      p_room_numbers: buildStandardTestRoomNumbers(ROBOT_HOTEL_ROOMS),
    });
    if (createdRes.error) fail('create hotel', createdRes.error);
    const created = (Array.isArray(createdRes.data) ? createdRes.data[0] : createdRes.data) as
      { id?: string } | null;
    if (!created?.id) fail('create hotel', 'the create RPC returned no id');
    propertyId = created.id;
    say(`created hotel ${propertyId}`);
  } else {
    say(`hotel already exists: ${propertyId}`);
  }

  // Every section on, and the wizard out of the way. `enabled_sections: null`
  // is the "everything on" value the registry is built around — a partial map
  // makes the SERVER gate fail closed with a 503, which would take the robot's
  // whole walk down in a way that looks like the app is broken.
  const settleRes = await db
    .from('properties')
    .update({
      enabled_sections: null,
      is_test: true,
      onboarding_completed_at: new Date().toISOString(),
      timezone: ROBOT_HOTEL_TIMEZONE,
    })
    .eq('id', propertyId);
  if (settleRes.error) fail('settle hotel settings', settleRes.error);

  // ── 3. Attach it to the demo management company ──────────────────────────
  // BEFORE any access grant. Creating a hotel leaves it governed by a private
  // anchor organization of its own; binding a manager's access while that is
  // still the primary would bind the bridge to the wrong company, and a bridge
  // can only ever be retired, never re-pointed.
  const attachRes = await db.rpc('staxis_set_primary_property_organization', {
    p_actor_account_id: admin.id,
    p_property_id: propertyId,
    p_organization_id: organizationId,
    p_relationship_type: 'operator',
  });
  if (attachRes.error) fail('attach hotel to the management company', attachRes.error);
  say(`attached to organization ${organizationId}`);

  // ── 4. The manager ───────────────────────────────────────────────────────
  const managerEmail = `${ROBOT_MANAGER_USERNAME}@staxis.local`;
  const managerAuthUserId = await auth.ensureUser({
    email: managerEmail,
    password: opts.password,
    username: ROBOT_MANAGER_USERNAME,
    displayName: ROBOT_MANAGER_DISPLAY,
  });
  say(`manager auth user: ${managerAuthUserId}`);

  const accountRes = await db
    .from('accounts')
    .select('id, role')
    .eq('username', ROBOT_MANAGER_USERNAME)
    .maybeSingle();
  if (accountRes.error) fail('read manager account', accountRes.error);
  let managerAccountId = (accountRes.data as { id: string; role: string } | null)?.id ?? null;

  if (!managerAccountId) {
    // `property_access` is deliberately absent. Since the access cutover a
    // trigger rejects any insert that carries it, and access is granted by the
    // authorization RPC below instead.
    const insertRes = await db
      .from('accounts')
      .insert({
        username: ROBOT_MANAGER_USERNAME,
        display_name: ROBOT_MANAGER_DISPLAY,
        data_user_id: managerAuthUserId,
        role: 'general_manager',
        active: true,
        skip_2fa: true,
      })
      .select('id')
      .maybeSingle();
    if (insertRes.error) fail('create manager account', insertRes.error);
    managerAccountId = (insertRes.data as { id: string } | null)?.id ?? null;
    if (!managerAccountId) fail('create manager account', 'insert returned no id');
    say(`created manager account ${managerAccountId}`);
  } else {
    const updateRes = await db
      .from('accounts')
      .update({
        display_name: ROBOT_MANAGER_DISPLAY,
        data_user_id: managerAuthUserId,
        role: 'general_manager',
        active: true,
        skip_2fa: true,
      })
      .eq('id', managerAccountId);
    if (updateRes.error) fail('refresh manager account', updateRes.error);
    say(`manager account already exists: ${managerAccountId}`);
  }

  // ── 5. Give the manager this hotel, and only this hotel ──────────────────
  //
  // THROUGH THE GUARDED SEAM, NOT THE TABLE. `account_authorization_state` is
  // revoked from service_role (migration 0378), so the obvious
  // `select authority_version from account_authorization_state` is a 42501 in
  // production and reads perfectly fine in any test whose role owns the tables.
  // That is exactly how this seed died halfway through its first real run.
  //
  // Both halves go through the SECURITY DEFINER functions the app itself uses:
  // `staxis_list_account_authorization_admin` to read the version (the same
  // call /api/auth/accounts makes), `staxis_set_account_authorization_scope` to
  // write the scope, and `staxis_list_account_authorized_properties` to check
  // the answer afterwards.
  await grantHotelAccess(db, {
    actorAccountId: admin.id,
    accountId: managerAccountId,
    propertyId,
    say,
  });

  // ── 6. The roster: the manager, and one colleague to hand things to ──────
  const staffRes = await db
    .from('staff')
    .select('id, name')
    .eq('property_id', propertyId);
  if (staffRes.error) fail('read roster', staffRes.error);
  const existingStaff = (staffRes.data ?? []) as Array<{ id: string; name: string }>;
  const byName = new Map(existingStaff.map((s) => [s.name, s.id]));

  const wanted: Array<{ name: string; department: string }> = [
    // department 'other' is what the product uses for a manager's own roster
    // identity, and having one is what lets the robot's to-dos be assigned
    // BACK to itself and appear on its own list.
    { name: ROBOT_MANAGER_DISPLAY, department: 'other' },
    { name: ROBOT_COLLEAGUE_NAME, department: ROBOT_COLLEAGUE_DEPARTMENT },
  ];
  const missing = wanted.filter((w) => !byName.has(w.name));
  if (missing.length > 0) {
    const insertStaffRes = await db
      .from('staff')
      .insert(missing.map((m) => ({
        property_id: propertyId,
        name: m.name,
        department: m.department,
        language: 'en',
        is_active: true,
      })))
      .select('id, name');
    if (insertStaffRes.error) fail('create roster', insertStaffRes.error);
    for (const row of (insertStaffRes.data ?? []) as Array<{ id: string; name: string }>) {
      byName.set(row.name, row.id);
    }
    say(`added to the roster: ${missing.map((m) => m.name).join(', ')}`);
  } else {
    say('roster already complete');
  }

  const managerStaffId = byName.get(ROBOT_MANAGER_DISPLAY);
  const colleagueStaffId = byName.get(ROBOT_COLLEAGUE_NAME);
  if (!managerStaffId || !colleagueStaffId) fail('create roster', 'a roster row is missing after the write');

  // Link the manager's account to their roster identity, so the app resolves
  // one person rather than an account and a stranger with the same name.
  const linkRes = await db
    .from('accounts')
    .update({ staff_id: managerStaffId })
    .eq('id', managerAccountId);
  if (linkRes.error) fail('link the manager to the roster', linkRes.error);

  return {
    propertyId,
    propertyCreated,
    managerAccountId,
    managerAuthUserId,
    colleagueStaffId,
    managerStaffId,
  };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function supabaseAuthAdapter(client: SupabaseClient): SeedAuth {
  return {
    async ensureUser({ email, password, username, displayName }) {
      const listed = await client.auth.admin.listUsers({ page: 1, perPage: 1000 });
      if (listed.error) fail('list auth users', listed.error);
      const found = listed.data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
      if (found) {
        const updated = await client.auth.admin.updateUserById(found.id, { password });
        if (updated.error) fail('set the manager password', updated.error);
        return found.id;
      }
      const created = await client.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { username, displayName },
      });
      if (created.error) fail('create the manager auth user', created.error);
      if (!created.data.user) fail('create the manager auth user', 'no user returned');
      return created.data.user.id;
    },
  };
}

async function main(): Promise<void> {
  loadEnv(process.cwd());

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const password = process.env.ROBOT_WALK_PASSWORD;

  if (!url || !key) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (.env.local).');
    process.exit(1);
  }
  if (!password) {
    console.error('Missing ROBOT_WALK_PASSWORD. Set it to the same value you will store as a GitHub secret:');
    console.error("  ROBOT_WALK_PASSWORD='...' npx tsx --conditions=react-server scripts/robot-walk/seed.ts");
    process.exit(1);
  }

  const client = createClient(url, key, { auth: { persistSession: false } });
  const result = await seedRobotHotel(
    client as unknown as SeedDb,
    supabaseAuthAdapter(client),
    {
      password,
      organizationId: process.env.ROBOT_WALK_ORG_ID || undefined,
      adminUsername: process.env.STAXIS_ADMIN_USERNAME || undefined,
      log: (line) => console.log(`  ${line}`),
    },
  );

  console.log('');
  console.log('Robot Hotel is ready.');
  console.log('');
  console.log(`  hotel id ............ ${result.propertyId}`);
  console.log(`  manager sign-in ..... ${ROBOT_MANAGER_USERNAME}`);
  console.log(`  manager auth user id  ${result.managerAuthUserId}`);
  console.log('');
  console.log('Two operator steps remain:');
  console.log('');
  console.log('  1. GitHub, so the nightly walk can sign in and knows where it is going:');
  console.log(`       gh secret set ROBOT_WALK_PASSWORD`);
  console.log(`       gh variable set ROBOT_WALK_PROPERTY_ID --body '${result.propertyId}'`);
  console.log('');
  console.log('  2. Vercel, so the sign-in does not stop for a one-time code. Append the');
  console.log('     manager auth user id above to SKIP_2FA_USER_IDS (comma separated) and');
  console.log('     confirm SKIP_2FA_ENABLED is "true", then redeploy.');
  console.log('');
}

// Only when run directly, so importing this module for a test seeds nothing.
if (process.argv[1] && process.argv[1].endsWith('seed.ts')) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
