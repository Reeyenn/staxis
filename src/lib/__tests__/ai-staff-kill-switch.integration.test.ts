/**
 * PROOF, against a real Postgres, that the AI Staff page's one control does the
 * thing it says on it: switching the Morning Briefer off stops a morning brief
 * from being written, and switching it back on starts them again.
 *
 * WHY THIS RUNS AGAINST A REAL DATABASE
 * A kill switch is only worth having if the stop is real, and "real" here is
 * three database facts a stubbed client would happily fake:
 *
 *   • the switch row itself lands in `ai_employee_switches` with its
 *     provenance, and the table's own CHECK refuses a row that claims an
 *     employee is off without saying when
 *   • with that row present, the brief route returns NO brief for a hotel that
 *     demonstrably has one — same hotel, same day, same data, only the switch
 *     changed
 *   • the switch is a stop and not a hide: nothing is written to the day's
 *     idempotency cache while it is off, so switching back on produces a fresh
 *     brief rather than serving one that was quietly generated anyway
 *
 * AND THE GATE. `/api/admin/mission/ai-staff` names which of Staxis's own
 * employees is switched off. A general manager reaching it would be a leak of
 * Staxis's internal state into a customer's hands, so the refusal is tested
 * from a real non-admin account rather than asserted from the source.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder';
// Local-dev/test break-glass: skips the trusted-device half of requireSession so
// these tests exercise the routes' AUTHORIZATION, not the 2FA plumbing.
process.env.DISABLE_SERVER_2FA_ENFORCEMENT = 'true';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { NextRequest } from 'next/server';
import type { PGlite } from '@electric-sql/pglite';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { GET as briefGET } from '@/app/api/findings/brief/route';
import { GET as staffGET, POST as staffPOST } from '@/app/api/admin/mission/ai-staff/route';
import { getMorningBrief } from '@/lib/findings/brief-server';
import { getPortfolioBrief } from '@/lib/company/vp-brief-server';
import { invalidateEmployeeSwitchCache } from '@/lib/ai/employee-switches';
import { MORNING_BRIEFER_ID } from '@/lib/ai/employee-ids';

import { applyMigrationsToPglite, seedCanonicalTestAuthority } from '../../../tests/fixtures/pglite-migrate';
import {
  createPglitePostgrest,
  loadCatalog,
  type Catalog,
  type PglitePostgrest,
} from '../../../tests/fixtures/postgrest-pglite';
import { seedTwoHotels, PID_A } from '../../../tests/fixtures/pglite-two-hotel-seed';

// ─── Identities ─────────────────────────────────────────────────────────────

const ADMIN_UID = 'aaaaaaaa-0000-4000-8000-00000000ff01';
const GM_UID = 'bbbbbbbb-0000-4000-8000-00000000ff02';

let currentUser: string | null = ADMIN_UID;
let adminAccountId = '';

let pg: PGlite;
let catalog: Catalog;
let shim: PglitePostgrest;

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);
const originalGetUser = supabaseAdmin.auth.getUser.bind(supabaseAdmin.auth);

const RAN_AT = '2026-07-25T08:00:00.000Z';

// ─── Requests ───────────────────────────────────────────────────────────────

function authed(url: string, init?: RequestInit): NextRequest {
  return new NextRequest(url, {
    ...(init as object),
    headers: { authorization: 'Bearer ai-staff-test-token', 'Content-Type': 'application/json' },
  } as ConstructorParameters<typeof NextRequest>[1]);
}

interface Envelope<T> { ok: boolean; error?: string; data?: T }

/**
 * The brief through the route — the whole path a manager's screen takes.
 *
 * Hermetic by construction in the two states this file drives it in. Switched
 * OFF, the generation path returns before it reads anything, so there is no
 * model call to make. Switched ON, `exhaustBriefBudget()` below has already
 * taken the wording pass's spend hold away, so `phraseBrief` returns the
 * template text without calling a provider. Neither state reaches the network,
 * and neither weakens what is being asserted: the claim under test is that a
 * brief IS or IS NOT produced, never how prettily it was worded.
 */
async function readBriefViaRoute(): Promise<{ status: number; brief: unknown | null; stopped: boolean }> {
  const res = await briefGET(authed(`https://staxis.test/api/findings/brief?propertyId=${PID_A}`));
  const body = (await res.json()) as Envelope<{ brief: unknown | null; stopped?: boolean }>;
  return {
    status: res.status,
    brief: body.data?.brief ?? null,
    stopped: body.data?.stopped === true,
  };
}

/** The brief at the library entry, with the wording pass off. This is where the
 *  switch is checked, and where every future caller will hit it. */
async function readBrief(): Promise<{ status: number; brief: unknown | null; stopped: boolean }> {
  const r = await getMorningBrief({ propertyId: PID_A, phrasing: false });
  return { status: 200, brief: r.brief, stopped: r.stopped === true };
}

/** Book more finalised spend against the hotel's findings budget than the
 *  wording pass's share of it, so the next reservation is refused and the brief
 *  ships as templates. The product's own escape hatch, used on purpose. */
async function exhaustBriefBudget(): Promise<void> {
  await pg.query(
    `insert into public.findings_ai_spend (property_id, feature, state, cost_usd)
     values ($1,'findings.judge','finalized',999)`,
    [PID_A],
  );
}

interface StaffEmployee {
  id: string;
  hired: boolean;
  status: string;
  switchedOff: boolean;
  runs: Array<{ key: string; kind: string; label: { en: string; es: string } }>;
  surfaces: Array<{ en: string; es: string }>;
  spend: { known: boolean; usd: number | null } | null;
  name: { en: string; es: string };
  job: { en: string; es: string };
}

async function readRoster(): Promise<{ status: number; body: Envelope<{ employees: StaffEmployee[] }> }> {
  const res = await staffGET(authed('https://staxis.test/api/admin/mission/ai-staff'));
  return { status: res.status, body: (await res.json()) as Envelope<{ employees: StaffEmployee[] }> };
}

async function flip(employeeId: string, switchedOff: boolean, note?: string) {
  const res = await staffPOST(authed('https://staxis.test/api/admin/mission/ai-staff', {
    method: 'POST',
    body: JSON.stringify({ employeeId, switchedOff, ...(note ? { note } : {}) }),
  }));
  const body = (await res.json()) as Envelope<{ employee: { switchedOff: boolean; status: string } }>;
  // Every instance caches the switches for 15s; the founder pressing the button
  // is the one caller who must see his own change immediately, and in-process
  // that is this call.
  invalidateEmployeeSwitchCache();
  return { status: res.status, body };
}

async function switchRows() {
  const r = await pg.query<{
    employee_id: string; switched_off: boolean; switched_off_at: string | null; switched_off_by: string | null; note: string | null;
  }>('select employee_id, switched_off, switched_off_at, switched_off_by, note from public.ai_employee_switches order by employee_id');
  return r.rows;
}

async function briefCacheRows() {
  const r = await pg.query<{ key: string }>(
    "select key from public.idempotency_log where route = 'findings-brief'",
  );
  return r.rows;
}

// ─── Suite ──────────────────────────────────────────────────────────────────

describe('AI Staff — the kill switch actually stops the Morning Briefer', () => {
  before(async () => {
    const migrated = await applyMigrationsToPglite();
    pg = migrated.pg;
    catalog = await loadCatalog(pg);
    await seedTwoHotels(pg, catalog);
    shim = createPglitePostgrest(pg, catalog);
    // @ts-expect-error installing the pglite-backed client on the singleton
    supabaseAdmin.from = shim.from;
    // @ts-expect-error installing the pglite-backed client on the singleton
    supabaseAdmin.rpc = shim.rpc;
    supabaseAdmin.auth.getUser = (async () =>
      currentUser
        ? { data: { user: { id: currentUser, email: `${currentUser}@staff.test` } }, error: null }
        : { data: { user: null }, error: { message: 'invalid token', status: 401, name: 'AuthApiError' } }
    ) as unknown as typeof supabaseAdmin.auth.getUser;

    for (const [uid, email] of [[ADMIN_UID, 'reeyen@staff.test'], [GM_UID, 'gm@staff.test']] as const) {
      await pg.query('insert into auth.users (id, email) values ($1,$2) on conflict do nothing', [uid, email]);
    }
    const inserted = await pg.query<{ id: string }>(
      `insert into public.accounts (username, display_name, role, data_user_id, password_hash, active)
       values ('staff.admin','Reeyen','admin',$1,'x',true),
              ('staff.gm','Maria (GM)','general_manager',$2,'x',true)
       returning id`,
      [ADMIN_UID, GM_UID],
    );
    adminAccountId = inserted.rows[0].id;
    await seedCanonicalTestAuthority(pg, { username: 'staff.admin', propertyIds: [] });
    await seedCanonicalTestAuthority(pg, { username: 'staff.gm', propertyIds: [PID_A] });

    // One overnight run + one open finding on hotel A: enough that a brief
    // genuinely exists, so "no brief" later can only be the switch.
    await pg.query(
      `insert into public.finding_runs
         (property_id, run_at, run_date, detectors_registered, detectors_checked, detectors_skipped)
       values ($1,$2::timestamptz,$3::date,9,9,0)`,
      [PID_A, RAN_AT, RAN_AT.slice(0, 10)],
    );
    await pg.query(
      `insert into public.findings
         (property_id, detector_id, dedupe_key, summary, severity, disposition, status,
          receipt_query_id, evidence, magnitude, first_seen_at, last_seen_at, status_changed_at)
       values ($1,'kill_switch_probe','kill-switch-1','Two rooms keep coming back.',
               'attention','recommend','open','probe_receipt',
               '{"queryId":"probe_receipt","params":{},"values":{},"basis":"basis"}'::jsonb,
               2,$2::timestamptz,$2::timestamptz,$2::timestamptz)`,
      [PID_A, RAN_AT],
    );
  });

  after(async () => {
    supabaseAdmin.from = originalFrom;
    supabaseAdmin.rpc = originalRpc;
    supabaseAdmin.auth.getUser = originalGetUser;
    invalidateEmployeeSwitchCache();
    // PGlite holds the event loop open; without this the process lingers and
    // then exits non-zero, failing the file even with every assertion green.
    await pg?.close();
  });

  beforeEach(async () => {
    currentUser = ADMIN_UID;
    await pg.query('delete from public.ai_employee_switches');
    await pg.query('delete from public.findings_ai_spend');
    await pg.query('delete from public.agent_costs');
    await pg.query("delete from public.idempotency_log where route = 'findings-brief'");
    invalidateEmployeeSwitchCache();
  });

  // ── The mutation proof ───────────────────────────────────────────────────
  //
  // Three states of the same hotel on the same day, and the ONLY thing that
  // moves between them is the switch.

  test('on → a brief exists; off → no brief and nothing cached; on again → a brief exists', async () => {
    const before = await readBrief();
    assert.equal(before.status, 200);
    assert.ok(before.brief, 'the hotel has an overnight run and a finding — it should have a brief');
    assert.equal(before.stopped, false);

    // Clear the day's cache so the "off" read cannot be answered by a copy that
    // was generated while the employee was still on. Without this the test
    // would pass on an implementation that only stops NEW generation, which is
    // a weaker guarantee than "switched off means nothing comes out".
    await pg.query("delete from public.idempotency_log where route = 'findings-brief'");

    const off = await flip(MORNING_BRIEFER_ID, true, 'testing the stop');
    assert.equal(off.status, 200, off.body.error ?? '');
    assert.equal(off.body.data?.employee.switchedOff, true);
    assert.equal(off.body.data?.employee.status, 'switched_off');

    const during = await readBrief();
    assert.equal(during.status, 200, 'switching an employee off must not break the page below it');
    assert.equal(during.brief, null, 'a switched-off Morning Briefer must not write a brief');
    assert.equal(
      during.stopped, true,
      'the route must say WHY there is no brief — a null brief already means "never checked"',
    );
    assert.deepEqual(
      await briefCacheRows(), [],
      'a switched-off employee must not claim the day\'s generation slot',
    );

    const on = await flip(MORNING_BRIEFER_ID, false);
    assert.equal(on.status, 200, on.body.error ?? '');

    const after = await readBrief();
    assert.ok(after.brief, 'switching back on must produce a brief again');
    assert.equal(after.stopped, false);
  });

  test('the manager-facing route reports the stop rather than a bare empty answer', async () => {
    await flip(MORNING_BRIEFER_ID, true);
    const off = await readBriefViaRoute();
    assert.equal(off.status, 200, 'the queue below the brief must keep working');
    assert.equal(off.brief, null);
    assert.equal(off.stopped, true);

    await flip(MORNING_BRIEFER_ID, false);
    await exhaustBriefBudget();
    const on = await readBriefViaRoute();
    assert.equal(on.status, 200);
    assert.ok(on.brief, 'the route must serve a brief once the employee is back on');
    assert.equal(on.stopped, false);
  });

  // One employee, two morning summaries. The founder switching the Morning
  // Briefer off must silence the company brief a VP reads as well as the card a
  // GM reads — otherwise "switched off" would mean "off at hotels, on upstairs".
  test('the same switch silences the company morning summary a VP reads', async () => {
    const input = {
      organizationId: '00000000-0000-4000-8000-0000000000c1',
      localDate: '2026-07-25',
      hotelCount: 2,
      cards: [],
      run: { thingsChecked: 40, hotelsChecked: 2, hotelsTotal: 2, lastRunAt: RAN_AT },
      now: new Date('2026-07-25T14:00:00.000Z'),
      busyHotelIds: [],
    };

    const on = await getPortfolioBrief({
      accountId: adminAccountId,
      policyFingerprint: 'a'.repeat(24),
      input,
      noCache: true,
    });
    assert.ok(on.brief, 'a checked company should have a morning summary');
    assert.notEqual(on.stopped, true);

    await flip(MORNING_BRIEFER_ID, true);

    const off = await getPortfolioBrief({
      accountId: adminAccountId,
      policyFingerprint: 'a'.repeat(24),
      input,
      noCache: true,
    });
    assert.equal(off.brief, null, 'the company brief must stop with its author');
    assert.equal(off.stopped, true);
  });

  test('the stop row lands with its provenance, and the table refuses one without', async () => {
    await flip(MORNING_BRIEFER_ID, true, 'noisy this week');
    const rows = await switchRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].employee_id, MORNING_BRIEFER_ID);
    assert.equal(rows[0].switched_off, true);
    assert.ok(rows[0].switched_off_at, 'a stop with no timestamp is a stop nobody can account for');
    assert.equal(rows[0].switched_off_by, adminAccountId);
    assert.equal(rows[0].note, 'noisy this week');

    // The constraint, driven directly — the check is in the schema, so it holds
    // for anything that writes this table, not only for the route.
    await assert.rejects(
      pg.query(
        'insert into public.ai_employee_switches (employee_id, switched_off) values ($1, true)',
        ['some_other_employee'],
      ),
      /ai_employee_switches_off_has_provenance/,
    );
  });

  test('switching back on clears the provenance rather than leaving a stale stop', async () => {
    await flip(MORNING_BRIEFER_ID, true, 'x');
    await flip(MORNING_BRIEFER_ID, false);
    const rows = await switchRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].switched_off, false);
    assert.equal(rows[0].switched_off_at, null);
    assert.equal(rows[0].switched_off_by, null);
  });

  // ── The gate ─────────────────────────────────────────────────────────────

  test('a general manager cannot read the roster or flip a switch', async () => {
    currentUser = GM_UID;

    const roster = await readRoster();
    assert.equal(roster.status, 403, 'a hotel manager must never see which Staxis employee is off');

    const attempt = await flip(MORNING_BRIEFER_ID, true);
    assert.equal(attempt.status, 403);
    assert.deepEqual(await switchRows(), [], 'a refused flip must write nothing');
  });

  test('a signed-out caller cannot read the roster', async () => {
    currentUser = null;
    const roster = await readRoster();
    assert.ok(roster.status === 401 || roster.status === 403, `expected a refusal, got ${roster.status}`);
  });

  // ── What the founder actually sees ───────────────────────────────────────

  test('the roster is the whole org chart: the hired ones, and the rest with nothing to show', async () => {
    const { status, body } = await readRoster();
    assert.equal(status, 200, body.error ?? '');
    const employees = body.data!.employees;
    assert.ok(employees.length >= 13);

    // Pinned by name, not counted: a card on this page claims real work is
    // happening, so a new one has to be a deliberate edit here too.
    const hired = employees.filter((e) => e.hired);
    assert.deepEqual(hired.map((e) => e.id).sort(), ['morning_briefer', 'ordering_manager']);
    assert.ok(hired.some((e) => e.id === MORNING_BRIEFER_ID));

    // The Ordering Manager bundles no billed feature — its model work happens
    // inside a chat turn and is billed there — so its card must say "no
    // separate bill" rather than render a confident $0.00.
    const ordering = hired.find((e) => e.id === 'ordering_manager')!;
    assert.ok(ordering.surfaces.length > 0, 'a hired employee must name where its work shows up');
    assert.ok(
      ordering.spend === null || ordering.spend.known === false,
      'an employee with no billed feature must not report a spend figure',
    );

    const planned = employees.filter((e) => !e.hired);
    assert.ok(planned.length >= 11);
    for (const e of planned) {
      // A dimmed card has nothing it could render as a control or a number.
      assert.equal(e.status, 'not_hired', `${e.id} claimed a status`);
      assert.equal(e.runs.length, 0, `${e.id} claimed to run something`);
      assert.equal(e.surfaces.length, 0, `${e.id} claimed to write somewhere`);
      assert.equal(e.spend, null, `${e.id} claimed a spend figure`);
      assert.equal(e.switchedOff, false);
      // …and it is still bilingual.
      assert.ok(e.name.es.trim() && e.job.es.trim(), `${e.id} is missing its Spanish`);
    }
  });

  test('the Morning Briefer card says what it runs in words, in both languages', async () => {
    const { body } = await readRoster();
    const briefer = body.data!.employees.find((e) => e.id === MORNING_BRIEFER_ID)!;

    assert.ok(briefer.runs.length >= 2, 'it should list its wording pass and the nightly check');
    for (const r of briefer.runs) {
      assert.ok(r.label.en.trim(), `${r.key} has no English line`);
      assert.ok(r.label.es.trim(), `${r.key} has no Spanish line`);
      // The founder must never be shown an internal id as the sentence.
      assert.notEqual(r.label.en, r.key);
      assert.ok(!r.label.en.includes('findings.'), `${r.key} leaked an internal id into its label`);
    }
    assert.ok(briefer.surfaces.length >= 1);
    assert.ok(briefer.surfaces.every((s) => s.en.trim() && s.es.trim()));
  });

  // The figure comes from `agent_costs` — THE BOOKS, one row per call Staxis
  // actually paid for — and never from `findings_ai_spend`, which is the daily
  // CAP GATE and holds worst-case reservations. The brief writes to both, so a
  // route that summed both would report this one call twice. Fully exercised in
  // agent-costs-feature-attribution.integration.test.ts; the shape of the claim
  // is asserted here because it is what this page prints.
  test('spend is a real finalised figure or an honest absence — never an estimate', async () => {
    const { body } = await readRoster();
    const briefer = body.data!.employees.find((e) => e.id === MORNING_BRIEFER_ID)!;
    assert.ok(briefer.spend, 'a hired employee should report something about money');
    // Nothing has been spent in this fixture, so the honest figure is zero and
    // the honest claim is that it is known.
    assert.equal(briefer.spend!.known, true);
    assert.equal(briefer.spend!.usd, 0);

    // A finalised row for its feature moves the figure; a RESERVED hold must
    // not — a hold is worst-case money that was never charged. Nor may the
    // cap gate's own copy of the same call be added on top of it.
    const account = await pg.query<{ id: string }>(
      "select id from public.accounts where username = 'staff.admin'",
    );
    for (const [feature, state, usd] of [
      ['findings.brief', 'finalized', 0.25],
      ['findings.brief', 'reserved', 9.99],
      ['findings.judge', 'finalized', 5.00],
    ] as const) {
      await pg.query(
        `insert into public.agent_costs
           (user_id, property_id, model, tokens_in, tokens_out, cost_usd, kind, state, feature)
         values ($1,$2,'sonnet',10,5,$3,'background',$4,$5)`,
        [account.rows[0].id, PID_A, usd, state, feature],
      );
    }
    await pg.query(
      `insert into public.findings_ai_spend (property_id, feature, state, cost_usd)
       values ($1,'findings.brief','finalized',0.40)`,
      [PID_A],
    );

    const after = await readRoster();
    const again = after.body.data!.employees.find((e) => e.id === MORNING_BRIEFER_ID)!;
    assert.equal(
      again.spend!.usd, 0.25,
      'the figure must count only finalised booked spend for this employee\'s own features',
    );
  });

  // ── The page cannot start anything ───────────────────────────────────────

  test('an employee that is not hired cannot be switched at all', async () => {
    const res = await flip('night_auditor', true);
    assert.equal(res.status, 409);
    assert.deepEqual(await switchRows(), []);
  });

  test('an unknown employee is refused rather than written', async () => {
    const res = await flip('nobody_here', true);
    assert.equal(res.status, 404);
    assert.deepEqual(await switchRows(), []);
  });

  test('switchedOff must be a real boolean — a truthy string cannot stop anyone', async () => {
    const res = await staffPOST(authed('https://staxis.test/api/admin/mission/ai-staff', {
      method: 'POST',
      body: JSON.stringify({ employeeId: MORNING_BRIEFER_ID, switchedOff: 'false' }),
    }));
    assert.equal(res.status, 400);
    assert.deepEqual(await switchRows(), []);
  });

  test('switching an employee ON schedules nothing — the status still says waiting', async () => {
    await flip(MORNING_BRIEFER_ID, true);
    await flip(MORNING_BRIEFER_ID, false);
    const { body } = await readRoster();
    const briefer = body.data!.employees.find((e) => e.id === MORNING_BRIEFER_ID)!;
    assert.equal(
      briefer.status, 'waiting_for_master',
      'clearing a kill override must not be able to turn the machine on',
    );
  });
});
