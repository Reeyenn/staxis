#!/usr/bin/env node
/* eslint-disable no-console */

// ═══════════════════════════════════════════════════════════════════════════
// seed-supabase.js
//
// One-shot seeder for a fresh Supabase Postgres DB. Idempotent — safe to
// re-run; it will NOT duplicate rows. Re-running with --reset first deletes
// the existing admin + property + staff + config so you get a clean slate.
//
// What it creates:
//   1. Auth user + accounts row for the admin login (Reeyen)
//   2. Comfort Suites Beaumont property (TXA32) owned by that admin
//   3. Full staff roster (variable HKs + fixed staff, split correctly per
//      Jayesh's 2026-03-26 guidance)
//   4. Sensible laundry config defaults (towels/sheets/comforters)
//   5. Initial public areas — lobby + floor hallways + stairwells
//   6. Prints the property ID + admin account ID so you can paste them into
//      .env.local (HOTELOPS_USER_ID / HOTELOPS_PROPERTY_ID, used by scraper)
//
// Prereqs (edit .env.local first — the app assumes these anyway):
//   NEXT_PUBLIC_SUPABASE_URL=https://<proj>.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY=eyJ...  (service_role, NOT anon)
//
// Usage:
//   node scripts/seed-supabase.js          # create everything (idempotent)
//   node scripts/seed-supabase.js --reset  # delete admin+property first
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// Tiny inline .env.local loader — avoids a dotenv dep so this script runs
// straight out of `npm install` without extras. Recognizes KEY=value and
// KEY="value with spaces / newlines escaped as \n".
(function loadEnvLocal() {
  const envPath = path.resolve(__dirname, '..', '.env.local');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1).replace(/\\n/g, '\n');
    }
    if (!(key in process.env)) process.env[key] = val;
  }
})();

const RESET = process.argv.includes('--reset');

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPA_URL || !SUPA_KEY) {
  console.error(
    '\n✗ Missing NEXT_PUBLIC_SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY in .env.local.\n' +
    '  Go to Supabase Dashboard → Project Settings → API, copy both values, and re-run.\n'
  );
  process.exit(1);
}

const supa = createClient(SUPA_URL, SUPA_KEY, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
});

// ── Seed constants ────────────────────────────────────────────────────────
// Admin password comes from env so it never lives in git.
// Set STAXIS_ADMIN_PASSWORD in .env.local before running `npm run seed`.
const ADMIN_PASSWORD = process.env.STAXIS_ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  console.error(
    '\n✗ STAXIS_ADMIN_PASSWORD is required in .env.local.\n' +
    '  Add a line like: STAXIS_ADMIN_PASSWORD=your-secret-password\n' +
    '  This is the password for the admin login (username: reeyen).\n',
  );
  process.exit(1);
}
const ADMIN = {
  username: 'reeyen',
  password: ADMIN_PASSWORD,
  displayName: 'Reeyen Patel',
  email: 'reeyen@staxis.local',
};

const PROPERTY = {
  name: 'Comfort Suites Beaumont',
  total_rooms: 74,
  avg_occupancy: 0.7362,            // from Hotel Statistics Report 12/24/25–3/24/26
  hourly_wage: 10.50,               // ~$10–11/hr per Jayesh
  checkout_minutes: 30,
  stayover_minutes: 20,
  stayover_day1_minutes: 15,
  stayover_day2_minutes: 20,
  prep_minutes_per_activity: 5,
  shift_minutes: 480,
  total_staff_on_roster: 17,
  weekly_budget: 4200,
  morning_briefing_time: '07:30',
  evening_forecast_time: '16:00',
  pms_type: 'choiceADVANTAGE',
  pms_url: 'https://www.choiceadvantage.com/choicehotels/HousekeepingCenter_start.init#',
  pms_connected: true,
};

// Per [C] Comfort Suites — Staff Roster & Roles.md (Jayesh 2026-03-26).
// Variable HKs — scheduling model uses these. MARIA POSAS is included for
// the overtime-workaround reason documented in that file.
const VARIABLE_HKS = [
  { name: 'ASTRI RAVANALES',  isSenior: false },
  { name: 'BRENDA SANDOVAL',  isSenior: false },
  { name: 'ERIKA RIVERA',     isSenior: false },
  { name: 'JULIA JACINTO',    isSenior: false },
  { name: 'LUCIA FLORES',     isSenior: false },
  { name: 'MAITE BULUX',      isSenior: false },
  { name: 'MARISOL PEREZ',    isSenior: false },
  { name: 'MATA HERIBERTO',   isSenior: false },
  { name: 'YOSELEIN BULUX',   isSenior: false },
  { name: 'MARIA POSAS',      isSenior: false },
];

// Fixed staff — excluded from scheduling math but present on the roster.
// Maria Castro is head HK; the others are non-HK roles that still need to
// appear in the staff table for SMS/shift-confirmation purposes.
const FIXED_STAFF = [
  { name: 'BRITTNEY COBBS',   department: 'front_desk',   isSenior: true,  scheduling_priority: 'excluded' },
  { name: 'MARIA CASTRO',     department: 'housekeeping', isSenior: true,  scheduling_priority: 'excluded' },
  { name: 'KATHERINE WHITE',  department: 'front_desk',   isSenior: false, scheduling_priority: 'excluded' },
  { name: 'MARY MARTINEZ',    department: 'front_desk',   isSenior: false, scheduling_priority: 'excluded' },
  { name: 'MICHELLE HUMPHREY',department: 'front_desk',   isSenior: false, scheduling_priority: 'excluded' },
  { name: 'SHANEQUA HAMILTON',department: 'front_desk',   isSenior: false, scheduling_priority: 'excluded' },
  { name: 'SYLVIA MATA',      department: 'maintenance',  isSenior: false, scheduling_priority: 'excluded' },
];

// Laundry — industry defaults calibrated to ~74 rooms. Operator can tune
// these in Settings → Laundry Config later.
const LAUNDRY_CONFIG = [
  { name: 'Towels',     units_per_checkout: 3, two_bed_multiplier: 2, stayover_factor: 0.5, room_equivs_per_load: 12, minutes_per_load: 50 },
  { name: 'Sheets',     units_per_checkout: 1, two_bed_multiplier: 2, stayover_factor: 0.0, room_equivs_per_load: 10, minutes_per_load: 60 },
  { name: 'Pillowcases',units_per_checkout: 2, two_bed_multiplier: 2, stayover_factor: 0.0, room_equivs_per_load: 40, minutes_per_load: 50 },
  { name: 'Comforters', units_per_checkout: 1, two_bed_multiplier: 2, stayover_factor: 0.0, room_equivs_per_load: 4,  minutes_per_load: 90 },
];

// Minimal starter public areas — lobby + one hall entry per floor + stairwells.
// Operator customizes these on first login.
const PUBLIC_AREAS = [
  { name: 'Lobby',              floor: '1', locations: 1, frequency_days: 1, minutes_per_clean: 20 },
  { name: 'Breakfast Area',     floor: '1', locations: 1, frequency_days: 1, minutes_per_clean: 30 },
  { name: 'Floor 1 Hallway',    floor: '1', locations: 1, frequency_days: 2, minutes_per_clean: 15 },
  { name: 'Floor 2 Hallway',    floor: '2', locations: 1, frequency_days: 2, minutes_per_clean: 15 },
  { name: 'Floor 3 Hallway',    floor: '3', locations: 1, frequency_days: 2, minutes_per_clean: 15 },
  { name: 'Floor 4 Hallway',    floor: '4', locations: 1, frequency_days: 2, minutes_per_clean: 15 },
  { name: 'Stairwells',         floor: 'all', locations: 2, frequency_days: 3, minutes_per_clean: 25 },
  { name: 'Elevators',          floor: 'all', locations: 1, frequency_days: 1, minutes_per_clean: 10 },
  { name: 'Fitness Room',       floor: '1', locations: 1, frequency_days: 1, minutes_per_clean: 15 },
  { name: 'Pool Area',          floor: '1', locations: 1, frequency_days: 1, minutes_per_clean: 20 },
];

// ── Helpers ───────────────────────────────────────────────────────────────
function log(step, msg) {
  console.log(`[${step}] ${msg}`);
}
function die(step, err) {
  console.error(`\n✗ [${step}] ${err?.message ?? err}\n`);
  process.exit(1);
}

// ── Main flow ─────────────────────────────────────────────────────────────
(async () => {
  console.log('\n━━━ Staxis Supabase Seeder ━━━');
  console.log(`Target: ${SUPA_URL}`);
  console.log(`Mode:   ${RESET ? 'RESET then seed' : 'seed (idempotent)'}\n`);

  // ── Step 0 (optional): reset ────────────────────────────────────────────
  if (RESET) {
    log('reset', 'looking up existing admin by email…');
    const { data: existingUsers, error: listErr } = await supa.auth.admin.listUsers();
    if (listErr) die('reset', listErr);
    const existing = existingUsers.users.find(u => u.email === ADMIN.email);
    if (existing) {
      // The accounts row has data_user_id → auth.users.id (on delete cascade)
      // and property_access[] that, via the FK on properties.owner_id, cascades
      // to properties and everything under them. Deleting the auth user takes
      // everything with it.
      log('reset', `deleting auth user ${existing.id} (cascades to account + property + staff + ...)`);
      const { error: delErr } = await supa.auth.admin.deleteUser(existing.id);
      if (delErr) die('reset', delErr);
      log('reset', 'done');
    } else {
      log('reset', 'no existing admin — nothing to delete');
    }
  }

  // ── Step 1: admin auth user ─────────────────────────────────────────────
  log('admin', `ensuring auth user ${ADMIN.email}…`);
  let adminUserId;
  {
    const { data: list, error: listErr } = await supa.auth.admin.listUsers();
    if (listErr) die('admin', listErr);
    const found = list.users.find(u => u.email === ADMIN.email);
    if (found) {
      adminUserId = found.id;
      log('admin', `already exists (id=${adminUserId})`);
    } else {
      const { data, error } = await supa.auth.admin.createUser({
        email: ADMIN.email,
        password: ADMIN.password,
        email_confirm: true,
        user_metadata: { username: ADMIN.username, displayName: ADMIN.displayName },
      });
      if (error || !data.user) die('admin', error ?? new Error('no user returned'));
      adminUserId = data.user.id;
      log('admin', `created (id=${adminUserId})`);
    }
  }

  // ── Step 2: property ────────────────────────────────────────────────────
  log('property', 'ensuring Comfort Suites Beaumont…');
  let propertyId;
  {
    // Match on (owner_id, name) so we only touch THIS admin's property.
    const { data: existing, error: qErr } = await supa
      .from('properties')
      .select('id')
      .eq('owner_id', adminUserId)
      .eq('name', PROPERTY.name)
      .maybeSingle();
    if (qErr) die('property', qErr);

    if (existing) {
      propertyId = existing.id;
      // Keep the property config in sync with what this script asserts.
      const { error: upErr } = await supa
        .from('properties')
        .update({ ...PROPERTY, updated_at: new Date().toISOString() })
        .eq('id', propertyId);
      if (upErr) die('property', upErr);
      log('property', `already exists — config updated (id=${propertyId})`);
    } else {
      const { data, error } = await supa
        .from('properties')
        .insert({ owner_id: adminUserId, ...PROPERTY })
        .select('id')
        .single();
      if (error || !data) die('property', error ?? new Error('no row returned'));
      propertyId = data.id;
      log('property', `created (id=${propertyId})`);
    }
  }

  // ── Step 3: accounts row (admin, with property_access) ──────────────────
  log('account', 'ensuring accounts row for admin…');
  let accountId;
  {
    const { data: existing, error: qErr } = await supa
      .from('accounts')
      .select('id')
      .eq('username', ADMIN.username)
      .maybeSingle();
    if (qErr) die('account', qErr);

    if (existing) {
      accountId = existing.id;
      // Keep display_name/role/linkage fresh (RLS needs data_user_id correct).
      const { error: upErr } = await supa
        .from('accounts')
        .update({
          display_name: ADMIN.displayName,
          role: 'admin',
          data_user_id: adminUserId,
          property_access: [propertyId],
          updated_at: new Date().toISOString(),
        })
        .eq('id', accountId);
      if (upErr) die('account', upErr);
      log('account', `already exists (id=${accountId}) — refreshed`);
    } else {
      const { data, error } = await supa
        .from('accounts')
        .insert({
          username: ADMIN.username,
          display_name: ADMIN.displayName,
          role: 'admin',
          data_user_id: adminUserId,
          property_access: [propertyId],
          // password_hash left null — Supabase Auth is source of truth.
        })
        .select('id')
        .single();
      if (error || !data) die('account', error ?? new Error('no row returned'));
      accountId = data.id;
      log('account', `created (id=${accountId})`);
    }
  }

  // ── Step 4: staff roster ────────────────────────────────────────────────
  log('staff', `seeding ${VARIABLE_HKS.length} HKs + ${FIXED_STAFF.length} fixed staff…`);
  {
    // Idempotent: skip staff whose exact (property_id, name) already exists.
    const { data: existing, error: qErr } = await supa
      .from('staff')
      .select('name')
      .eq('property_id', propertyId);
    if (qErr) die('staff', qErr);
    const existingNames = new Set((existing ?? []).map(r => r.name));

    const rows = [
      ...VARIABLE_HKS.map(hk => ({
        property_id: propertyId,
        name: hk.name,
        is_senior: hk.isSenior,
        department: 'housekeeping',
        hourly_wage: 10.50,
        is_active: true,
        schedule_priority: 'normal',
        max_days_per_week: 5,
        max_weekly_hours: 40,
        language: 'es',  // majority spanish-speaking per field notes
      })),
      ...FIXED_STAFF.map(s => ({
        property_id: propertyId,
        name: s.name,
        is_senior: s.isSenior,
        department: s.department,
        hourly_wage: 12.00,
        is_active: true,
        schedule_priority: s.scheduling_priority,
        max_days_per_week: 5,
        max_weekly_hours: 40,
        language: 'en',
      })),
    ].filter(r => !existingNames.has(r.name));

    if (rows.length === 0) {
      log('staff', 'all present — nothing to insert');
    } else {
      const { error } = await supa.from('staff').insert(rows);
      if (error) die('staff', error);
      log('staff', `inserted ${rows.length} new staff rows`);
    }
  }

  // ── Step 5: laundry config ──────────────────────────────────────────────
  log('laundry', `ensuring ${LAUNDRY_CONFIG.length} laundry categories…`);
  {
    const { data: existing, error: qErr } = await supa
      .from('laundry_config')
      .select('name')
      .eq('property_id', propertyId);
    if (qErr) die('laundry', qErr);
    const existingNames = new Set((existing ?? []).map(r => r.name));
    const rows = LAUNDRY_CONFIG
      .filter(c => !existingNames.has(c.name))
      .map(c => ({ property_id: propertyId, ...c }));

    if (rows.length === 0) {
      log('laundry', 'all present');
    } else {
      const { error } = await supa.from('laundry_config').insert(rows);
      if (error) die('laundry', error);
      log('laundry', `inserted ${rows.length} categories`);
    }
  }

  // ── Step 6: public areas ────────────────────────────────────────────────
  log('areas', `ensuring ${PUBLIC_AREAS.length} public areas…`);
  {
    const { data: existing, error: qErr } = await supa
      .from('public_areas')
      .select('name')
      .eq('property_id', propertyId);
    if (qErr) die('areas', qErr);
    const existingNames = new Set((existing ?? []).map(r => r.name));
    const today = new Date().toISOString().slice(0, 10);
    const rows = PUBLIC_AREAS
      .filter(a => !existingNames.has(a.name))
      .map(a => ({ property_id: propertyId, start_date: today, ...a }));

    if (rows.length === 0) {
      log('areas', 'all present');
    } else {
      const { error } = await supa.from('public_areas').insert(rows);
      if (error) die('areas', error);
      log('areas', `inserted ${rows.length} areas`);
    }
  }

  // ── Done ────────────────────────────────────────────────────────────────
  console.log('\n━━━ Seed complete ━━━');
  console.log('  Login:           username "reeyen" / password: value of STAXIS_ADMIN_PASSWORD');
  console.log(`  Admin auth user: ${adminUserId}`);
  console.log(`  Account row:     ${accountId}`);
  console.log(`  Property:        ${propertyId}`);
  console.log('\nUpdate env files:');
  console.log(`  .env.local:       HOTELOPS_USER_ID=${adminUserId}`);
  console.log(`                    HOTELOPS_PROPERTY_ID=${propertyId}`);
  console.log(`  scraper/.env:     (same two vars, same values)\n`);
  process.exit(0);
})().catch(err => die('main', err));
