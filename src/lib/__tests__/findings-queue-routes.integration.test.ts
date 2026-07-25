/**
 * PROOF that the screen a manager sees is fed by a route that cannot be talked
 * into showing — or silencing — another hotel's findings.
 *
 * WHY THIS RUNS AGAINST A REAL POSTGRES
 * `findings` and `finding_runs` are deny-all to anon AND authenticated
 * (migration 0360). There is no RLS policy standing behind these routes: the
 * property_id filter applied inside src/lib/findings/store.ts IS the tenant
 * wall. A stubbed client would prove the route SENT a scoped query; only a
 * database can prove the query returns hotel A's rows and refuses hotel B's.
 *
 * The real GET and POST handlers run unmodified. Both hotels carry findings
 * with the SAME dedupe keys and the same summaries, and every hotel-B row is
 * poisoned with `ZZLEAKB` — so a forgotten filter has something to match and
 * something to leak.
 *
 * The account gate is also exercised for real: loadManagerCaller runs against
 * the migrated `accounts` table, which is where this app's most expensive
 * recurring bug lives (a lookup naming a column that does not exist errors,
 * reads at the call site as "no such account", and turns the feature off for
 * everyone with a green build).
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder';
// Local-dev/test break-glass: skips the trusted-device half of requireSession
// so these tests exercise the ROUTE's authorization, not the 2FA plumbing
// (which has its own suites). Ignored on any production-shaped deploy.
process.env.DISABLE_SERVER_2FA_ENFORCEMENT = 'true';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { NextRequest } from 'next/server';
import type { PGlite } from '@electric-sql/pglite';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { GET, POST } from '@/app/api/findings/route';

import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';
import {
  createPglitePostgrest,
  loadCatalog,
  type Catalog,
  type PglitePostgrest,
} from '../../../tests/fixtures/postgrest-pglite';
import { seedTwoHotels, LEAK_MARKER, PID_A, PID_B } from '../../../tests/fixtures/pglite-two-hotel-seed';

// ─── Identities ─────────────────────────────────────────────────────────────

const GM_A_UID = 'aaaaaaaa-0000-4000-8000-0000000000f1';
const GM_B_UID = 'bbbbbbbb-0000-4000-8000-0000000000f1';
const HOUSEKEEPER_UID = 'cccccccc-0000-4000-8000-0000000000f1';
const STRANGER_UID = 'dddddddd-0000-4000-8000-0000000000f1';

/** Which auth user the next requireSession call resolves to. */
let currentUser: string | null = GM_A_UID;

let pg: PGlite;
let catalog: Catalog;
let shim: PglitePostgrest;

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);
const originalGetUser = supabaseAdmin.auth.getUser.bind(supabaseAdmin.auth);

// ─── Helpers ────────────────────────────────────────────────────────────────

function getReq(propertyId: string | null): NextRequest {
  const qs = propertyId === null ? '' : `?propertyId=${propertyId}`;
  return new NextRequest(`https://staxis.test/api/findings${qs}`, {
    method: 'GET',
    headers: { authorization: 'Bearer findings-route-test-token' },
  });
}

function postReq(body: Record<string, unknown>): NextRequest {
  return new NextRequest('https://staxis.test/api/findings', {
    method: 'POST',
    headers: {
      authorization: 'Bearer findings-route-test-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function noAuthReq(propertyId: string): NextRequest {
  return new NextRequest(`https://staxis.test/api/findings?propertyId=${propertyId}`, {
    method: 'GET',
  });
}

interface QueueBody {
  ok: boolean;
  error?: string;
  data?: {
    findings: Array<Record<string, unknown>>;
    run: { runAt: string; detectorsChecked: number; detectorsSkipped: number } | null;
    cap: number;
  };
}

async function readQueue(propertyId: string): Promise<{ status: number; body: QueueBody }> {
  const res = await GET(getReq(propertyId));
  return { status: res.status, body: (await res.json()) as QueueBody };
}

/** Insert a finding straight into Postgres, bypassing the app entirely. */
async function insertFinding(opts: {
  propertyId: string;
  dedupeKey: string;
  summary: string;
  detectorId?: string;
  severity?: string;
  disposition?: string;
  status?: string;
  magnitude?: number;
  priceLowCents?: number | null;
  priceHighCents?: number | null;
  priceBasis?: string | null;
  evidence?: Record<string, unknown>;
}): Promise<string> {
  const r = await pg.query<{ id: string }>(
    `insert into public.findings
       (property_id, detector_id, dedupe_key, summary, severity, disposition, status,
        receipt_query_id, evidence, magnitude,
        price_low_cents, price_high_cents, price_basis)
     values ($1,$2,$3,$4,$5,$6,$7,'probe_receipt',$8::jsonb,$9,$10,$11,$12)
     returning id`,
    [
      opts.propertyId,
      opts.detectorId ?? 'probe_det',
      opts.dedupeKey,
      opts.summary,
      opts.severity ?? 'attention',
      opts.disposition ?? 'recommend',
      opts.status ?? 'open',
      JSON.stringify(opts.evidence ?? { queryId: 'probe_receipt', params: {}, values: {}, basis: 'basis' }),
      opts.magnitude ?? 1,
      opts.priceLowCents ?? null,
      opts.priceHighCents ?? null,
      opts.priceBasis ?? null,
    ],
  );
  return r.rows[0].id;
}

async function rawFinding(id: string) {
  const r = await pg.query<{
    id: string; property_id: string; status: string; summary: string;
    silenced_at_magnitude: string | null; resolved_at: string | null;
    status_changed_by: string | null; magnitude: string;
  }>(
    `select id, property_id, status, summary, silenced_at_magnitude, resolved_at,
            status_changed_by, magnitude
       from public.findings where id = $1`,
    [id],
  );
  return r.rows[0] ?? null;
}

async function insertRun(propertyId: string, opts: {
  hoursAgo: number; checked: number; skipped?: number;
}): Promise<void> {
  const at = new Date(Date.now() - opts.hoursAgo * 3_600_000).toISOString();
  await pg.query(
    `insert into public.finding_runs
       (property_id, run_at, run_date, detectors_registered, detectors_checked, detectors_skipped)
     values ($1, $2::timestamptz, $3::date, $4, $4, $5)`,
    [propertyId, at, at.slice(0, 10), opts.checked, opts.skipped ?? 0],
  );
}

/** Wipe every findings/finding_runs row the seeder or a prior test left. */
async function clearLedger(): Promise<void> {
  await pg.query('delete from public.findings');
  await pg.query('delete from public.finding_runs');
}

describe('/api/findings — the queue read and the manager’s verdict', () => {
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
    // requireSession's token check. The ROUTE's job is what happens after a
    // valid session; who that session belongs to is what each test varies.
    // @ts-expect-error minimal auth stub
    supabaseAdmin.auth.getUser = async () =>
      currentUser
        ? { data: { user: { id: currentUser, email: `${currentUser}@findings.test` } }, error: null }
        : { data: { user: null }, error: { message: 'invalid token', status: 401, name: 'AuthApiError' } };

    // Four people: hotel A's GM, hotel B's GM, a hotel-A housekeeper (a real
    // account with a role that cannot manage), and someone with no account.
    for (const [uid, email] of [
      [GM_A_UID, 'gm.a@findings.test'],
      [GM_B_UID, 'gm.b@findings.test'],
      [HOUSEKEEPER_UID, 'hk.a@findings.test'],
      [STRANGER_UID, 'nobody@findings.test'],
    ] as const) {
      await pg.query('insert into auth.users (id, email) values ($1,$2) on conflict do nothing', [uid, email]);
    }
    await pg.query(
      `insert into public.accounts (username, display_name, role, property_access, data_user_id, password_hash)
       values ('findings.gm.a','Maria (GM)','general_manager',array[$1::uuid],$2,'x'),
              ('findings.gm.b','Bea (GM)','general_manager',array[$3::uuid],$4,'x'),
              ('findings.hk.a','Ana','housekeeping',array[$1::uuid],$5,'x')`,
      [PID_A, GM_A_UID, PID_B, GM_B_UID, HOUSEKEEPER_UID],
    );
  });

  after(async () => {
    supabaseAdmin.from = originalFrom;
    supabaseAdmin.rpc = originalRpc;
    supabaseAdmin.auth.getUser = originalGetUser;
    // The WASM backend exits the process with status 100 if it is still open
    // when the event loop drains, which turns a green run red.
    await pg?.close();
  });

  beforeEach(async () => {
    currentUser = GM_A_UID;
    await clearLedger();
  });

  // ── The door ──────────────────────────────────────────────────────────────

  describe('the door', () => {
    test('no session at all is 401, not an empty queue', async () => {
      currentUser = null;
      const res = await GET(noAuthReq(PID_A));
      assert.equal(res.status, 401);
    });

    test('an invalid token is 401 on the write path too', async () => {
      currentUser = null;
      const res = await POST(postReq({ propertyId: PID_A, findingId: PID_A, action: 'muted' }));
      assert.equal(res.status, 401);
    });

    test('a valid session with no account row is refused, not served', async () => {
      currentUser = STRANGER_UID;
      assert.equal((await readQueue(PID_A)).status, 403);
    });

    test('a housekeeper is refused — this is a manager screen', async () => {
      currentUser = HOUSEKEEPER_UID;
      assert.equal((await readQueue(PID_A)).status, 403);
    });

    test("hotel A's manager asking for hotel B is 403", async () => {
      await insertFinding({ propertyId: PID_B, dedupeKey: 'probe:b_only', summary: `B ${LEAK_MARKER}` });
      const { status, body } = await readQueue(PID_B);
      assert.equal(status, 403);
      assert.ok(!JSON.stringify(body).includes(LEAK_MARKER), 'a 403 body leaked hotel B content');
    });

    test('a malformed property id is a 400, never a fall-through to everything', async () => {
      const res = await GET(getReq('not-a-uuid'));
      assert.equal(res.status, 400);
      const missing = await GET(getReq(null));
      assert.equal(missing.status, 400);
    });

    test('the write path validates the verdict rather than passing it through', async () => {
      const id = await insertFinding({ propertyId: PID_A, dedupeKey: 'probe:v', summary: 'A' });
      // 'open' and 'expired' belong to the runner. A manager button must not be
      // able to reach into the lifecycle and reopen or expire anything.
      for (const action of ['open', 'expired', 'updated', 'nonsense', '']) {
        const res = await POST(postReq({ propertyId: PID_A, findingId: id, action }));
        assert.equal(res.status, 400, `action "${action}" was accepted`);
      }
      assert.equal((await rawFinding(id))!.status, 'open');
    });
  });

  // ── What the queue shows ──────────────────────────────────────────────────

  describe('what the queue shows', () => {
    test('open and updated findings are returned; silenced and archived ones are not', async () => {
      const wanted: string[] = [];
      for (const status of ['open', 'updated'] as const) {
        wanted.push(await insertFinding({
          propertyId: PID_A, dedupeKey: `probe:${status}`, summary: `A ${status}`, status,
        }));
      }
      for (const status of ['known_problem', 'muted', 'resolved', 'expired'] as const) {
        await insertFinding({
          propertyId: PID_A, dedupeKey: `probe:${status}`, summary: `A ${status}`, status,
        });
      }

      const { body } = await readQueue(PID_A);
      const ids = (body.data!.findings).map((f) => f.id as string).sort();
      assert.deepEqual(ids, [...wanted].sort());
    });

    test("an 'ask' finding never reaches this screen — questions belong to the drip card", async () => {
      const shown = await insertFinding({
        propertyId: PID_A, dedupeKey: 'probe:shown', summary: 'shown', disposition: 'recommend',
      });
      await insertFinding({
        propertyId: PID_A, dedupeKey: 'probe:asked', summary: 'asked', disposition: 'ask',
      });
      await insertFinding({
        propertyId: PID_A, dedupeKey: 'probe:dropped', summary: 'dropped', disposition: 'drop',
      });

      const { body } = await readQueue(PID_A);
      assert.deepEqual(body.data!.findings.map((f) => f.id), [shown]);
    });

    test('the price comes back as a RANGE with its basis, or not at all', async () => {
      await insertFinding({
        propertyId: PID_A, dedupeKey: 'probe:priced', summary: 'priced',
        priceLowCents: 20_000, priceHighCents: 40_000, priceBasis: 'your last 3 plumber invoices',
      });
      await insertFinding({ propertyId: PID_A, dedupeKey: 'probe:free', summary: 'unpriced' });

      const { body } = await readQueue(PID_A);
      const priced = body.data!.findings.find((f) => f.dedupeKey === 'probe:priced')!;
      const free = body.data!.findings.find((f) => f.dedupeKey === 'probe:free')!;
      assert.deepEqual(priced.price, {
        lowCents: 20_000, highCents: 40_000, currency: 'USD', basis: 'your last 3 plumber invoices',
      });
      assert.equal(free.price, null);
    });

    test('the receipt travels with the card — a claim arrives with its numbers', async () => {
      await insertFinding({
        propertyId: PID_A, dedupeKey: 'probe:receipt', summary: 'receipt',
        evidence: {
          queryId: 'hvac_orders_30d',
          params: { room: '214', windowDays: 30 },
          values: { orders: 4 },
          basis: '4 hvac work orders in the last 30 days',
        },
      });
      const { body } = await readQueue(PID_A);
      const f = body.data!.findings[0];
      assert.deepEqual(f.evidence, {
        queryId: 'hvac_orders_30d',
        params: { room: '214', windowDays: 30 },
        values: { orders: 4 },
        basis: '4 hvac work orders in the last 30 days',
      });
    });

    test('with no judge shipped, the card still has words — the detector’s own', async () => {
      await insertFinding({
        propertyId: PID_A, dedupeKey: 'probe:words', summary: 'Room 214: 4 hvac work orders in 30 days',
      });
      const { body } = await readQueue(PID_A);
      const f = body.data!.findings[0];
      assert.equal(f.summary, 'Room 214: 4 hvac work orders in 30 days');
      assert.equal(f.phrasedEn, null, 'phrasing must be absent, not invented');
      assert.equal(f.phrasedEs, null);
    });

    test('the run summary is this hotel’s latest, and null when it has never run', async () => {
      assert.equal((await readQueue(PID_A)).body.data!.run, null);

      await insertRun(PID_B, { hoursAgo: 1, checked: 99 });
      assert.equal((await readQueue(PID_A)).body.data!.run, null, "hotel B's run showed up as hotel A's");

      await insertRun(PID_A, { hoursAgo: 30, checked: 12, skipped: 3 });
      await insertRun(PID_A, { hoursAgo: 6, checked: 34, skipped: 2 });
      const run = (await readQueue(PID_A)).body.data!.run!;
      assert.equal(run.detectorsChecked, 34, 'the older run won');
      assert.equal(run.detectorsSkipped, 2);
    });
  });

  // ── Tenant isolation ──────────────────────────────────────────────────────

  describe('one hotel cannot see or touch another’s findings', () => {
    beforeEach(async () => {
      // The same problem, on both hotels, with the same key — an unscoped
      // query would happily match either row.
      await insertFinding({ propertyId: PID_A, dedupeKey: 'probe:shared', summary: 'HOTEL A version' });
      await insertFinding({
        propertyId: PID_B, dedupeKey: 'probe:shared', summary: `HOTEL B version ${LEAK_MARKER}`,
      });
      await insertFinding({
        propertyId: PID_B, dedupeKey: 'probe:b_private', summary: `B private ${LEAK_MARKER}`,
      });
      await insertRun(PID_B, { hoursAgo: 1, checked: 77 });
    });

    test("hotel A's queue carries nothing of hotel B's", async () => {
      const { body } = await readQueue(PID_A);
      const text = JSON.stringify(body);
      assert.ok(!text.includes(LEAK_MARKER), 'hotel B content leaked into hotel A');
      assert.ok(!text.includes('bbbbbbbb-'), "a hotel B uuid leaked into hotel A's queue");
      assert.equal(body.data!.findings.length, 1);
      assert.equal(body.data!.findings[0].summary, 'HOTEL A version');
    });

    test("hotel A cannot silence hotel B's finding even holding its id", async () => {
      const bRow = await pg.query<{ id: string }>(
        `select id from public.findings where property_id = $1 and dedupe_key = 'probe:b_private'`,
        [PID_B],
      );
      const bId = bRow.rows[0].id;

      for (const action of ['known_problem', 'muted', 'resolved'] as const) {
        const res = await POST(postReq({ propertyId: PID_A, findingId: bId, action }));
        assert.equal(res.status, 404, `${action} reached across the tenant wall`);
      }

      const after = await rawFinding(bId);
      assert.equal(after!.status, 'open', "hotel B's finding was modified by hotel A");
      assert.equal(after!.silenced_at_magnitude, null);
    });

    test("hotel B's own manager still sees hotel B's findings", async () => {
      // The isolation must be a WALL, not a broken read that shows nobody
      // anything — a test that only asserts absence passes on a dead feature.
      currentUser = GM_B_UID;
      const { status, body } = await readQueue(PID_B);
      assert.equal(status, 200);
      assert.equal(body.data!.findings.length, 2);
      assert.equal(body.data!.run!.detectorsChecked, 77);
    });
  });

  // ── The manager's verdicts ────────────────────────────────────────────────

  describe('the three verdicts land in the database', () => {
    test('"known problem" silences the card AND records the size consented to', async () => {
      const id = await insertFinding({
        propertyId: PID_A, dedupeKey: 'probe:known', summary: 'four work orders', magnitude: 4,
      });

      const res = await POST(postReq({ propertyId: PID_A, findingId: id, action: 'known_problem' }));
      assert.equal(res.status, 200);

      const row = await rawFinding(id);
      assert.equal(row!.status, 'known_problem');
      // Arming the silencer at 4 is consent to 4, not to 9. Escalation is
      // measured from here; without it a silence can never break out of itself.
      assert.equal(Number(row!.silenced_at_magnitude), 4);
      assert.ok(row!.status_changed_by, 'the verdict was not attributed to anyone');

      const { body } = await readQueue(PID_A);
      assert.equal(body.data!.findings.length, 0, 'a known problem is still on the screen');
    });

    test('"mute" is unconditional and leaves the queue', async () => {
      const id = await insertFinding({ propertyId: PID_A, dedupeKey: 'probe:mute', summary: 'noise' });
      assert.equal((await POST(postReq({ propertyId: PID_A, findingId: id, action: 'muted' }))).status, 200);
      assert.equal((await rawFinding(id))!.status, 'muted');
      assert.equal((await readQueue(PID_A)).body.data!.findings.length, 0);
    });

    test('"fixed" resolves it and stamps when', async () => {
      const id = await insertFinding({ propertyId: PID_A, dedupeKey: 'probe:fix', summary: 'leak' });
      assert.equal((await POST(postReq({ propertyId: PID_A, findingId: id, action: 'resolved' }))).status, 200);
      const row = await rawFinding(id);
      assert.equal(row!.status, 'resolved');
      assert.ok(row!.resolved_at, 'resolved without a resolved_at');
      assert.equal((await readQueue(PID_A)).body.data!.findings.length, 0);
    });

    test('a verdict on an id that does not exist is 404, not a silent success', async () => {
      const res = await POST(postReq({
        propertyId: PID_A,
        findingId: '00000000-0000-4000-8000-000000000000',
        action: 'muted',
      }));
      assert.equal(res.status, 404);
    });

    test('silencing one card does not silence the rest', async () => {
      const a = await insertFinding({ propertyId: PID_A, dedupeKey: 'probe:one', summary: 'one' });
      await insertFinding({ propertyId: PID_A, dedupeKey: 'probe:two', summary: 'two' });
      await POST(postReq({ propertyId: PID_A, findingId: a, action: 'muted' }));
      const { body } = await readQueue(PID_A);
      assert.deepEqual(body.data!.findings.map((f) => f.dedupeKey), ['probe:two']);
    });
  });
});
