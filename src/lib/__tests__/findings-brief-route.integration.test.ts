/**
 * PROOF, against a real Postgres, that the morning brief is built once per
 * hotel per hotel-day and cannot be talked into showing another hotel's night.
 *
 * WHY THIS RUNS AGAINST A REAL DATABASE
 * Three of the brief's promises are database behaviour, not code behaviour, and
 * a stubbed client would prove none of them:
 *
 *   • ONE GENERATION PER HOTEL-DAY rests on the atomic claim in
 *     `claim_idempotency_key` (migration 0243) plus the `idempotency_log`
 *     primary key. A fake client would happily let two callers both "win".
 *   • THE TENANT WALL is the property_id filter inside store.ts — `findings`
 *     and `finding_runs` are deny-all to anon AND authenticated (0360), so
 *     there is no RLS policy standing behind the route.
 *   • THE ACCOUNT GATE is loadManagerCaller against the migrated `accounts`
 *     table, which is where this app's most expensive recurring bug lives (a
 *     lookup naming a column that does not exist errors, reads at the call site
 *     as "no such account", and turns a feature off for everyone with a green
 *     build and a green suite).
 *
 * Both hotels are on America/Chicago, which is what makes the day-boundary
 * tests real: an implementation that keys the cache on the UTC date passes
 * every other test in this file and fails the two that matter.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder';
// Local-dev/test break-glass: skips the trusted-device half of requireSession
// so these tests exercise the ROUTE's authorization, not the 2FA plumbing.
process.env.DISABLE_SERVER_2FA_ENFORCEMENT = 'true';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { NextRequest } from 'next/server';
import type { PGlite } from '@electric-sql/pglite';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { GET } from '@/app/api/findings/brief/route';
import { getMorningBrief, briefCacheKey } from '@/lib/findings/brief-server';
import type { MorningBrief } from '@/lib/findings/brief';

import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';
import {
  createPglitePostgrest,
  loadCatalog,
  type Catalog,
  type PglitePostgrest,
} from '../../../tests/fixtures/postgrest-pglite';
import { seedTwoHotels, LEAK_MARKER, PID_A, PID_B } from '../../../tests/fixtures/pglite-two-hotel-seed';

// ─── Identities ─────────────────────────────────────────────────────────────

const GM_A_UID = 'aaaaaaaa-0000-4000-8000-0000000000b1';
const GM_B_UID = 'bbbbbbbb-0000-4000-8000-0000000000b1';
const HOUSEKEEPER_UID = 'cccccccc-0000-4000-8000-0000000000b1';
const STRANGER_UID = 'dddddddd-0000-4000-8000-0000000000b1';

let currentUser: string | null = GM_A_UID;

let pg: PGlite;
let catalog: Catalog;
let shim: PglitePostgrest;

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);
const originalGetUser = supabaseAdmin.auth.getUser.bind(supabaseAdmin.auth);

// ─── Clocks ─────────────────────────────────────────────────────────────────
//
// Chicago is UTC-5 in July. These three instants are the whole point of the
// day-boundary tests:
//
//   AFTERNOON  2026-07-25 15:00 local — UTC date 07-25, local date 07-25
//   LATE_NIGHT 2026-07-25 22:00 local — UTC date 07-26, local date 07-25  ←
//   NEXT_DAY   2026-07-26 01:00 local — UTC date 07-26, local date 07-26
//
// AFTERNOON and LATE_NIGHT are the SAME hotel day and must share one brief,
// even though they fall on different UTC dates.

const AFTERNOON = new Date('2026-07-25T20:00:00.000Z');
const LATE_NIGHT = new Date('2026-07-26T03:00:00.000Z');
const NEXT_DAY = new Date('2026-07-26T06:00:00.000Z');
const RAN_AT = '2026-07-25T08:00:00.000Z';

/** Route tests use the real clock, so content fixtures must stay inside the
 * liveness window instead of silently expiring as the calendar advances. */
const hoursAgo = (hours: number): string =>
  new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

// ─── Helpers ────────────────────────────────────────────────────────────────

function getReq(propertyId: string | null): NextRequest {
  const qs = propertyId === null ? '' : `?propertyId=${propertyId}`;
  return new NextRequest(`https://staxis.test/api/findings/brief${qs}`, {
    method: 'GET',
    headers: { authorization: 'Bearer brief-route-test-token' },
  });
}

function noAuthReq(propertyId: string): NextRequest {
  return new NextRequest(`https://staxis.test/api/findings/brief?propertyId=${propertyId}`, {
    method: 'GET',
  });
}

interface BriefBody {
  ok: boolean;
  error?: string;
  data?: { brief: MorningBrief | null; cached: boolean };
}

async function readBrief(propertyId: string): Promise<{ status: number; body: BriefBody }> {
  const res = await GET(getReq(propertyId));
  return { status: res.status, body: (await res.json()) as BriefBody };
}

async function insertFinding(opts: {
  propertyId: string;
  dedupeKey: string;
  summary: string;
  status?: string;
  disposition?: string;
  severity?: string;
  magnitude?: number;
  priceLowCents?: number | null;
  priceHighCents?: number | null;
  firstSeenAt?: string;
  lastSeenAt?: string;
  statusChangedAt?: string;
}): Promise<string> {
  const r = await pg.query<{ id: string }>(
    `insert into public.findings
       (property_id, detector_id, dedupe_key, summary, severity, disposition, status,
        receipt_query_id, evidence, magnitude, price_low_cents, price_high_cents, price_basis,
        first_seen_at, last_seen_at, status_changed_at)
     values ($1,'brief_det',$2,$3,$4,$5,$6,'probe_receipt',
             '{"queryId":"probe_receipt","params":{},"values":{},"basis":"basis"}'::jsonb,
             $7,$8,$9,$10,$11::timestamptz,$12::timestamptz,$13::timestamptz)
     returning id`,
    [
      opts.propertyId,
      opts.dedupeKey,
      opts.summary,
      opts.severity ?? 'attention',
      opts.disposition ?? 'recommend',
      opts.status ?? 'open',
      opts.magnitude ?? 1,
      opts.priceLowCents ?? null,
      opts.priceHighCents ?? null,
      opts.priceLowCents ? 'your last 3 invoices' : null,
      opts.firstSeenAt ?? '2026-07-25T08:00:00.000Z',
      opts.lastSeenAt ?? '2026-07-25T08:00:00.000Z',
      opts.statusChangedAt ?? '2026-07-25T08:00:00.000Z',
    ],
  );
  return r.rows[0].id;
}

async function insertRun(propertyId: string, opts: { checked: number; runAt?: string } = { checked: 34 }) {
  const at = opts.runAt ?? RAN_AT;
  await pg.query(
    `insert into public.finding_runs
       (property_id, run_at, run_date, detectors_registered, detectors_checked, detectors_skipped)
     values ($1,$2::timestamptz,$3::date,$4,$4,0)`,
    [propertyId, at, at.slice(0, 10), opts.checked],
  );
}

async function clearLedger(): Promise<void> {
  await pg.query('delete from public.findings');
  await pg.query('delete from public.finding_runs');
  await pg.query("delete from public.idempotency_log where route = 'findings-brief'");
}

async function cacheRows(): Promise<Array<{ key: string; property_id: string | null }>> {
  const r = await pg.query<{ key: string; property_id: string | null }>(
    "select key, property_id from public.idempotency_log where route = 'findings-brief' order by key",
  );
  return r.rows;
}

/** getMorningBrief with the REAL cache deps and a counting stand-in for the
 *  one dependency that costs money. */
function counted() {
  let calls = 0;
  return {
    get calls() { return calls; },
    phrase: async (brief: MorningBrief) => { calls += 1; return brief; },
  };
}

// ─── Suite ──────────────────────────────────────────────────────────────────

describe('/api/findings/brief — the morning brief', () => {
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
    // Minimal auth stub — the routes only read the id off the session. Cast
    // rather than @ts-expect-error: the suppression has to sit on whichever
    // line tsc happens to report, which moves whenever this block is reformatted.
    supabaseAdmin.auth.getUser = (async () =>
      currentUser
        ? { data: { user: { id: currentUser, email: `${currentUser}@brief.test` } }, error: null }
        : { data: { user: null }, error: { message: 'invalid token', status: 401, name: 'AuthApiError' } }) as unknown as typeof supabaseAdmin.auth.getUser;

    for (const [uid, email] of [
      [GM_A_UID, 'gm.a@brief.test'],
      [GM_B_UID, 'gm.b@brief.test'],
      [HOUSEKEEPER_UID, 'hk.a@brief.test'],
      [STRANGER_UID, 'nobody@brief.test'],
    ] as const) {
      await pg.query('insert into auth.users (id, email) values ($1,$2) on conflict do nothing', [uid, email]);
    }
    await pg.query(
      `insert into public.accounts (username, display_name, role, property_access, data_user_id, password_hash)
       values ('brief.gm.a','Maria (GM)','general_manager',array[$1::uuid],$2,'x'),
              ('brief.gm.b','Bea (GM)','general_manager',array[$3::uuid],$4,'x'),
              ('brief.hk.a','Ana','housekeeping',array[$1::uuid],$5,'x')`,
      [PID_A, GM_A_UID, PID_B, GM_B_UID, HOUSEKEEPER_UID],
    );
  });

  after(async () => {
    supabaseAdmin.from = originalFrom;
    supabaseAdmin.rpc = originalRpc;
    supabaseAdmin.auth.getUser = originalGetUser;
    await pg?.close();
  });

  beforeEach(async () => {
    currentUser = GM_A_UID;
    await clearLedger();
  });

  // ── The door ──────────────────────────────────────────────────────────────

  describe('the door', () => {
    test('no session is 401, not a blank brief', async () => {
      currentUser = null;
      assert.equal((await GET(noAuthReq(PID_A))).status, 401);
    });

    test('a valid session with no account row is refused', async () => {
      currentUser = STRANGER_UID;
      assert.equal((await readBrief(PID_A)).status, 403);
    });

    test('a housekeeper is refused — this is a manager screen', async () => {
      currentUser = HOUSEKEEPER_UID;
      assert.equal((await readBrief(PID_A)).status, 403);
    });

    test("hotel A's manager asking for hotel B is 403 and leaks nothing", async () => {
      await insertRun(PID_B);
      await insertFinding({ propertyId: PID_B, dedupeKey: 'brief:b', summary: `B ${LEAK_MARKER}` });
      const { status, body } = await readBrief(PID_B);
      assert.equal(status, 403);
      assert.ok(!JSON.stringify(body).includes(LEAK_MARKER));
    });

    test('a malformed property id is a 400, never a fall-through', async () => {
      assert.equal((await GET(getReq('not-a-uuid'))).status, 400);
      assert.equal((await GET(getReq(null))).status, 400);
    });
  });

  // ── The silence ───────────────────────────────────────────────────────────

  describe('a hotel nobody has checked', () => {
    test('gets no brief through the route', async () => {
      await insertFinding({ propertyId: PID_A, dedupeKey: 'brief:orphan', summary: 'Something is off.' });
      const { status, body } = await readBrief(PID_A);
      assert.equal(status, 200);
      assert.equal(body.data?.brief, null);
    });

    test('and nothing is cached for it, so its first check produces a brief the same day', async () => {
      // The mutation this guards: caching the null. A hotel checked for the
      // first time at 10am would then show nothing until tomorrow.
      const before = await getMorningBrief({ propertyId: PID_A, now: AFTERNOON, phrasing: false });
      assert.equal(before.brief, null);
      assert.deepEqual(await cacheRows(), []);

      await insertRun(PID_A);
      const after = await getMorningBrief({ propertyId: PID_A, now: AFTERNOON, phrasing: false });
      assert.ok(after.brief, 'a checked hotel gets a brief the same day');
      assert.equal(after.generated, true);
    });
  });

  // ── What it says ──────────────────────────────────────────────────────────

  describe('what it says about a real hotel', () => {
    beforeEach(async () => {
      await insertRun(PID_A, { checked: 34 });
      await insertFinding({
        propertyId: PID_A, dedupeKey: 'brief:ice', summary: 'The ice machine has had 3 service calls.',
        severity: 'critical', priceLowCents: 210_000, priceHighCents: 380_000, magnitude: 3,
        firstSeenAt: '2026-07-02T22:00:00.000Z',
      });
      await insertFinding({
        propertyId: PID_A, dedupeKey: 'brief:hvac', summary: 'Room 214 has had 4 HVAC work orders.',
        priceLowCents: 60_000, priceHighCents: 140_000, magnitude: 4,
        firstSeenAt: '2026-07-09T22:00:00.000Z',
      });
      await insertFinding({
        propertyId: PID_A, dedupeKey: 'brief:linen', summary: 'Nobody has counted linen in 9 days.',
        magnitude: 9, firstSeenAt: '2026-07-21T22:00:00.000Z',
      });
    });

    test('leads with the biggest dollars and ends with the liveness line', async () => {
      await pg.query(
        'update public.finding_runs set run_at = $2::timestamptz where property_id = $1',
        [PID_A, hoursAgo(6)],
      );
      const { body } = await readBrief(PID_A);
      const brief = body.data!.brief!;
      const en = brief.lines.map((l) => l.text);
      const quoted = brief.lines.filter((line) => line.findingId).map((line) => line.text);
      assert.ok(quoted[0].startsWith('The ice machine has had 3 service calls.'), quoted[0]);
      assert.match(quoted[0], /\$2,100–\$3,800/);
      assert.ok(quoted[1].startsWith('Room 214'), quoted[1]);
      assert.match(en[en.length - 1], /^Checked 34 things last night/);
      assert.ok(brief.lines.length <= 8);
    });

    test('an `ask` finding is a question, not a brief line', async () => {
      // It belongs to the drip-question card. Rendering it here would be a
      // second question UI with different rules.
      await insertFinding({
        propertyId: PID_A, dedupeKey: 'brief:ooo', summary: 'Room 118 has been out of service for 14 days.',
        disposition: 'ask', priceLowCents: 900_000, priceHighCents: 990_000,
      });
      const { body } = await readBrief(PID_A);
      const text = JSON.stringify(body.data!.brief!.lines);
      assert.ok(!text.includes('Room 118'), text);
    });

    test('a problem that went away on its own is reported', async () => {
      await insertFinding({
        propertyId: PID_A, dedupeKey: 'brief:gone', summary: 'The lobby printer stopped erroring.',
        status: 'expired', statusChangedAt: '2026-07-25T08:30:00.000Z',
      });
      const { brief } = await getMorningBrief({ propertyId: PID_A, now: AFTERNOON, phrasing: false });
      assert.ok(brief!.lines.some((l) => l.text.startsWith('1 thing cleared on its own:')));
    });

    test('a problem that expired LAST month is not this morning’s good news', async () => {
      // The mutation this guards: dropping the statusChangedSince bound. Every
      // finding this hotel has ever retired would be announced every morning.
      await insertFinding({
        propertyId: PID_A, dedupeKey: 'brief:ancient', summary: 'An old thing.',
        status: 'expired', statusChangedAt: '2026-06-01T08:30:00.000Z',
      });
      const { brief } = await getMorningBrief({ propertyId: PID_A, now: AFTERNOON, phrasing: false });
      assert.ok(!brief!.lines.some((l) => /cleared on its own|cleared on their own/.test(l.text)));
    });

    // Founder ruling (2026-07-26): the brief is ENGLISH-ONLY, whatever language
    // the reader has the app set to. This test used to demand the opposite — a
    // Spanish half on every line — and now pins that no such half survives the
    // whole route: assembly, cache, envelope, JSON.
    //
    // Mutation: put `es` back on BriefLine and fill it in brief.ts. The key
    // sweep below fails on every line.
    test('every line comes back as one English sentence, with no second language', async () => {
      const { body } = await readBrief(PID_A);
      const lines = body.data!.brief!.lines;
      assert.ok(lines.length > 0);
      for (const l of lines) {
        assert.ok(l.text.trim().length > 0, 'a line came back blank');
        for (const key of Object.keys(l)) {
          assert.ok(
            key === 'text' || key === 'findingId',
            `a brief line crossed the wire with an unexpected field "${key}"`,
          );
        }
      }
      // The wire shape itself, not just the parsed objects: nothing anywhere in
      // this payload is a Spanish half.
      assert.ok(!JSON.stringify(body.data!.brief).includes('"es"'));
    });
  });

  // ── One generation per hotel-day ──────────────────────────────────────────

  describe('one brief per hotel per hotel-day', () => {
    beforeEach(async () => {
      await insertRun(PID_A, { checked: 34 });
      await insertFinding({
        propertyId: PID_A, dedupeKey: 'brief:ice', summary: 'The ice machine has had 3 service calls.',
        priceLowCents: 210_000, priceHighCents: 380_000, firstSeenAt: '2026-07-02T22:00:00.000Z',
      });
    });

    test('the second load of the same day is served from cache and generates nothing', async () => {
      const spy = counted();
      const first = await getMorningBrief({ propertyId: PID_A, now: AFTERNOON, deps: { phrase: spy.phrase } });
      assert.equal(first.generated, true);
      assert.equal(first.cached, false);
      assert.equal(spy.calls, 1);

      const second = await getMorningBrief({ propertyId: PID_A, now: AFTERNOON, deps: { phrase: spy.phrase } });
      assert.equal(second.cached, true);
      assert.equal(second.generated, false);
      assert.equal(spy.calls, 1, 'the wording pass ran twice in one day');
      assert.deepEqual(second.brief!.lines, first.brief!.lines);
    });

    test('a card dealt with at 10am does not rewrite the brief a manager read at 7am', async () => {
      const first = await getMorningBrief({ propertyId: PID_A, now: AFTERNOON, phrasing: false });
      await pg.query("update public.findings set status = 'muted' where dedupe_key = 'brief:ice'");
      const later = await getMorningBrief({ propertyId: PID_A, now: AFTERNOON, phrasing: false });
      assert.deepEqual(later.brief!.lines, first.brief!.lines);
      assert.equal(later.cached, true);
    });

    test('LATE at night is still the same hotel day — one brief, not two', async () => {
      // 20:00Z and 03:00Z the next UTC day are both 2026-07-25 in Chicago. An
      // implementation keyed on the UTC date regenerates here, and a manager
      // gets a second, different "this morning" at 10pm.
      const spy = counted();
      await getMorningBrief({ propertyId: PID_A, now: AFTERNOON, deps: { phrase: spy.phrase } });
      const late = await getMorningBrief({ propertyId: PID_A, now: LATE_NIGHT, deps: { phrase: spy.phrase } });
      assert.equal(late.cached, true);
      assert.equal(spy.calls, 1);
      assert.equal(late.brief!.localDate, '2026-07-25');
      assert.deepEqual((await cacheRows()).map((r) => r.key), [briefCacheKey(PID_A, '2026-07-25')]);
    });

    test('the next hotel day gets a new brief', async () => {
      const spy = counted();
      await getMorningBrief({ propertyId: PID_A, now: AFTERNOON, deps: { phrase: spy.phrase } });
      const next = await getMorningBrief({ propertyId: PID_A, now: NEXT_DAY, deps: { phrase: spy.phrase } });
      assert.equal(next.generated, true);
      assert.equal(next.cached, false);
      assert.equal(spy.calls, 2);
      assert.equal(next.brief!.localDate, '2026-07-26');
      assert.deepEqual(
        (await cacheRows()).map((r) => r.key).sort(),
        [briefCacheKey(PID_A, '2026-07-25'), briefCacheKey(PID_A, '2026-07-26')].sort(),
      );
    });

    test('two callers racing produce one generation, and the loser still gets a correct brief', async () => {
      const spy = counted();
      const [a, b] = await Promise.all([
        getMorningBrief({ propertyId: PID_A, now: AFTERNOON, deps: { phrase: spy.phrase } }),
        getMorningBrief({ propertyId: PID_A, now: AFTERNOON, deps: { phrase: spy.phrase } }),
      ]);
      assert.equal(spy.calls, 1, 'the atomic claim let both callers generate');
      assert.equal([a, b].filter((r) => r.generated).length, 1);
      // The loser is not left empty-handed — it renders the deterministic brief.
      for (const r of [a, b]) assert.ok(r.brief && r.brief.lines.length > 0);
      assert.equal((await cacheRows()).length, 1);
    });
  });

  // ── The tenant wall ───────────────────────────────────────────────────────

  describe('two hotels', () => {
    test("hotel B's problems never reach hotel A's brief", async () => {
      await insertRun(PID_A, { checked: 34 });
      await insertRun(PID_B, { checked: 34 });
      await insertFinding({
        propertyId: PID_B, dedupeKey: 'brief:shared_key', summary: `Hotel B ${LEAK_MARKER}`,
        priceLowCents: 900_000, priceHighCents: 990_000,
      });
      await insertFinding({
        propertyId: PID_A, dedupeKey: 'brief:shared_key', summary: 'Hotel A ice machine.',
        priceLowCents: 10_000, priceHighCents: 20_000,
      });

      const { body } = await readBrief(PID_A);
      const text = JSON.stringify(body.data!.brief);
      assert.ok(!text.includes(LEAK_MARKER), text);
      assert.ok(text.includes('Hotel A ice machine.'));
    });

    test('each hotel gets its own cache row and its own brief', async () => {
      await insertRun(PID_A, { checked: 34 });
      await insertRun(PID_B, { checked: 12 });
      await insertFinding({ propertyId: PID_A, dedupeKey: 'brief:a', summary: 'Hotel A thing.' });
      await insertFinding({ propertyId: PID_B, dedupeKey: 'brief:b', summary: `Hotel B ${LEAK_MARKER}` });

      const a = await getMorningBrief({ propertyId: PID_A, now: AFTERNOON, phrasing: false });
      const b = await getMorningBrief({ propertyId: PID_B, now: AFTERNOON, phrasing: false });

      assert.equal(a.brief!.propertyId, PID_A);
      assert.equal(b.brief!.propertyId, PID_B);
      assert.ok(!JSON.stringify(a.brief).includes(LEAK_MARKER));
      assert.match(a.brief!.lines[a.brief!.lines.length - 1].text, /Checked 34 things/);
      assert.match(b.brief!.lines[b.brief!.lines.length - 1].text, /Checked 12 things/);

      const rows = await cacheRows();
      assert.equal(rows.length, 2);
      assert.deepEqual(rows.map((r) => r.property_id).sort(), [PID_A, PID_B].sort());
    });

    test('a cache row whose stored hotel does not match is refused, not rendered', async () => {
      // Belt to the key's braces. The key already contains the property id, so
      // this can only happen through corruption or a future bug — and the right
      // answer to "this row says it belongs to another hotel" is to rebuild,
      // never to render.
      await insertRun(PID_A, { checked: 34 });
      await insertFinding({ propertyId: PID_A, dedupeKey: 'brief:a', summary: 'Hotel A thing.' });
      await getMorningBrief({ propertyId: PID_A, now: AFTERNOON, phrasing: false });

      await pg.query(
        `update public.idempotency_log
            set response = jsonb_set(response, '{propertyId}', to_jsonb($2::text))
          where key = $1`,
        [briefCacheKey(PID_A, '2026-07-25'), PID_B],
      );
      const again = await getMorningBrief({ propertyId: PID_A, now: AFTERNOON, phrasing: false });
      assert.equal(again.cached, false, 'a mismatched cache row was served');
      assert.equal(again.brief!.propertyId, PID_A);
    });
  });
});
