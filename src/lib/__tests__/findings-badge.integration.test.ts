/**
 * PROOF for the number on the Staxis nav pill.
 *
 * The badge makes exactly one claim — "there are N things here for you to
 * decide" — and a badge that is wrong in either direction is worse than no
 * badge: too high and a manager opens the feed to find nothing, learns the
 * number lies, and stops looking; too low and the thing that mattered never
 * announced itself at all.
 *
 * So this suite pins the claim from both ends:
 *   • WHAT COUNTS — `propose` only. A recommendation, an FYI, a question and a
 *     dropped finding all sit in the ledger next to it and none of them may
 *     move the number.
 *   • WHOSE VERDICT — the judge's when it exists, the detector's default
 *     otherwise, matching effectiveDisposition() exactly. Both directions:
 *     a judge promoting a `recommend` to `propose` counts, a judge demoting a
 *     `propose` to `fyi` does not.
 *
 * WHY THIS RUNS AGAINST A REAL POSTGRES
 * `findings` is deny-all to anon AND authenticated (migration 0360). There is
 * no RLS policy standing behind this route: the property_id filter applied
 * inside src/lib/findings/store.ts IS the tenant wall. A stubbed client would
 * only prove the route SENT a scoped query; a database proves the count is
 * hotel A's and never includes hotel B's. It also proves the two `head: true`
 * count queries compile at all — a badge that always reads zero because
 * PostgREST refused the filter would pass every assertion a fake could make.
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
import { GET } from '@/app/api/findings/badge/route';
import { POST as QUEUE_POST } from '@/app/api/findings/route';
import { staxisPillBadge } from '@/components/concourse/queue-count';

import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';
import {
  createPglitePostgrest,
  loadCatalog,
  type Catalog,
  type PglitePostgrest,
} from '../../../tests/fixtures/postgrest-pglite';
import { seedTwoHotels, PID_A, PID_B } from '../../../tests/fixtures/pglite-two-hotel-seed';

// ─── The pure half: when a badge exists at all ──────────────────────────────
//
// Deliberately separate from the route. "Zero renders nothing" is a rendering
// decision, and it is made HERE — staxisPillBadge returns null and the pill
// receives `badge: undefined`, so there is no code path in which a "0" can be
// painted. Testing it as a function is what makes it provable without a DOM.

describe('staxisPillBadge — zero is not a badge', () => {
  test('nothing waiting means no badge object at all, not a zero', () => {
    assert.equal(staxisPillBadge(0, 'en'), null);
    assert.equal(staxisPillBadge(0, 'es'), null);
  });

  test('a nonsense count is also no badge, never a rendered NaN', () => {
    assert.equal(staxisPillBadge(-1, 'en'), null);
    assert.equal(staxisPillBadge(Number.NaN, 'en'), null);
    assert.equal(staxisPillBadge(Number.POSITIVE_INFINITY, 'en'), null);
  });

  test('one or more waiting produces the number and a spoken label', () => {
    assert.deepEqual(staxisPillBadge(1, 'en'), { count: 1, label: '1 decision waiting' });
    assert.deepEqual(staxisPillBadge(4, 'en'), { count: 4, label: '4 decisions waiting' });
  });

  test('the spoken label is Spanish for a Spanish-speaking manager', () => {
    assert.deepEqual(staxisPillBadge(1, 'es'), { count: 1, label: '1 decisión pendiente' });
    assert.deepEqual(staxisPillBadge(4, 'es'), { count: 4, label: '4 decisiones pendientes' });
  });
});

// ─── Identities ─────────────────────────────────────────────────────────────

const GM_A_UID = 'aaaaaaaa-0000-4000-8000-0000000000b1';
const GM_B_UID = 'bbbbbbbb-0000-4000-8000-0000000000b1';
const HOUSEKEEPER_UID = 'cccccccc-0000-4000-8000-0000000000b1';
const STRANGER_UID = 'dddddddd-0000-4000-8000-0000000000b1';

/** Which auth user the next requireSession call resolves to. */
let currentUser: string | null = GM_A_UID;

let pg: PGlite;
let catalog: Catalog;
let shim: PglitePostgrest;

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);
const originalGetUser = supabaseAdmin.auth.getUser.bind(supabaseAdmin.auth);

// ─── Helpers ────────────────────────────────────────────────────────────────

function badgeReq(propertyId: string | null, opts: { auth?: boolean } = {}): NextRequest {
  const qs = propertyId === null ? '' : `?propertyId=${propertyId}`;
  return new NextRequest(`https://staxis.test/api/findings/badge${qs}`, {
    method: 'GET',
    headers: opts.auth === false ? {} : { authorization: 'Bearer findings-badge-test-token' },
  });
}

interface BadgeBody {
  ok: boolean;
  error?: string;
  data?: { count: number };
}

async function readBadge(propertyId: string): Promise<{ status: number; body: BadgeBody }> {
  const res = await GET(badgeReq(propertyId));
  return { status: res.status, body: (await res.json()) as BadgeBody };
}

/** The number the pill would actually paint — the route and the render rule
 *  together, which is the thing a manager sees. */
async function paintedBadge(propertyId: string): Promise<number | null> {
  const { body } = await readBadge(propertyId);
  assert.ok(body.ok, `badge read failed: ${body.error ?? 'unknown'}`);
  return staxisPillBadge(body.data!.count, 'en')?.count ?? null;
}

/** Insert a finding straight into Postgres, bypassing the app entirely. */
async function insertFinding(opts: {
  propertyId: string;
  dedupeKey: string;
  disposition?: string;
  judgedDisposition?: string | null;
  status?: string;
  detectorId?: string;
}): Promise<string> {
  const r = await pg.query<{ id: string }>(
    `insert into public.findings
       (property_id, detector_id, dedupe_key, summary, severity, disposition,
        judged_disposition, status, receipt_query_id, evidence, magnitude)
     values ($1,$2,$3,'probe','attention',$4,$5,$6,'probe_receipt',$7::jsonb,1)
     returning id`,
    [
      opts.propertyId,
      opts.detectorId ?? 'probe_det',
      opts.dedupeKey,
      opts.disposition ?? 'propose',
      opts.judgedDisposition ?? null,
      opts.status ?? 'open',
      JSON.stringify({ queryId: 'probe_receipt', params: {}, values: {}, basis: 'basis' }),
    ],
  );
  return r.rows[0].id;
}

async function clearLedger(): Promise<void> {
  await pg.query('delete from public.findings');
  await pg.query('delete from public.finding_runs');
}

describe('/api/findings/badge — the decisions count on the Staxis pill', () => {
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
    // @ts-expect-error minimal auth stub
    supabaseAdmin.auth.getUser = async () =>
      currentUser
        ? { data: { user: { id: currentUser, email: `${currentUser}@badge.test` } }, error: null }
        : { data: { user: null }, error: { message: 'invalid token', status: 401, name: 'AuthApiError' } };

    for (const [uid, email] of [
      [GM_A_UID, 'gm.a@badge.test'],
      [GM_B_UID, 'gm.b@badge.test'],
      [HOUSEKEEPER_UID, 'hk.a@badge.test'],
      [STRANGER_UID, 'nobody@badge.test'],
    ] as const) {
      await pg.query('insert into auth.users (id, email) values ($1,$2) on conflict do nothing', [uid, email]);
    }
    await pg.query(
      `insert into public.accounts (username, display_name, role, property_access, data_user_id, password_hash)
       values ('badge.gm.a','Maria (GM)','general_manager',array[$1::uuid],$2,'x'),
              ('badge.gm.b','Bea (GM)','general_manager',array[$3::uuid],$4,'x'),
              ('badge.hk.a','Ana','housekeeping',array[$1::uuid],$5,'x')`,
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
    shim.reset();
    await clearLedger();
  });

  // ── The door ──────────────────────────────────────────────────────────────

  describe('the door', () => {
    test('no session at all is 401, not a count', async () => {
      currentUser = null;
      const res = await GET(badgeReq(PID_A, { auth: false }));
      assert.equal(res.status, 401);
    });

    test('a valid session with no account row is refused, not served a zero', async () => {
      currentUser = STRANGER_UID;
      const { status, body } = await readBadge(PID_A);
      assert.equal(status, 403);
      assert.equal(body.data, undefined);
    });

    test('a housekeeper is refused — this badge is a manager screen', async () => {
      currentUser = HOUSEKEEPER_UID;
      assert.equal((await readBadge(PID_A)).status, 403);
    });

    test('a malformed or missing property id is a 400, never a fleet-wide count', async () => {
      assert.equal((await GET(badgeReq('not-a-uuid'))).status, 400);
      assert.equal((await GET(badgeReq(null))).status, 400);
    });
  });

  // ── What the number means ────────────────────────────────────────────────

  describe('what lights the badge', () => {
    test('only propose counts — recommend, fyi, ask and drop never do', async () => {
      await insertFinding({ propertyId: PID_A, dedupeKey: 'b:propose1', disposition: 'propose' });
      await insertFinding({ propertyId: PID_A, dedupeKey: 'b:propose2', disposition: 'propose' });
      for (const disposition of ['recommend', 'fyi', 'ask', 'drop'] as const) {
        await insertFinding({ propertyId: PID_A, dedupeKey: `b:${disposition}`, disposition });
      }

      assert.equal((await readBadge(PID_A)).body.data!.count, 2);
    });

    test('a hotel with only FYIs and questions shows no badge at all', async () => {
      for (const disposition of ['recommend', 'fyi', 'ask', 'drop'] as const) {
        await insertFinding({ propertyId: PID_A, dedupeKey: `b:${disposition}`, disposition });
      }

      assert.equal((await readBadge(PID_A)).body.data!.count, 0);
      assert.equal(await paintedBadge(PID_A), null);
    });

    test("the judge's verdict wins over the detector's default, both ways", async () => {
      // Detector said "just a recommendation"; the judge, looking at this
      // hotel's numbers, decided it is a decision. It counts.
      await insertFinding({
        propertyId: PID_A, dedupeKey: 'b:promoted',
        disposition: 'recommend', judgedDisposition: 'propose',
      });
      // Detector defaulted to propose; the judge demoted it to an FYI. It does
      // not count — reading the detector's column here was a real bug class.
      await insertFinding({
        propertyId: PID_A, dedupeKey: 'b:demoted',
        disposition: 'propose', judgedDisposition: 'fyi',
      });
      await insertFinding({
        propertyId: PID_A, dedupeKey: 'b:asked',
        disposition: 'propose', judgedDisposition: 'ask',
      });

      assert.equal((await readBadge(PID_A)).body.data!.count, 1);
    });

    test('a judged propose and an unjudged propose are counted once each, never twice', async () => {
      await insertFinding({
        propertyId: PID_A, dedupeKey: 'b:judged',
        disposition: 'propose', judgedDisposition: 'propose',
      });
      await insertFinding({ propertyId: PID_A, dedupeKey: 'b:plain', disposition: 'propose' });

      assert.equal((await readBadge(PID_A)).body.data!.count, 2);
    });

    test('only live cards count — silenced, resolved and expired ones do not', async () => {
      await insertFinding({ propertyId: PID_A, dedupeKey: 'b:open', status: 'open' });
      await insertFinding({ propertyId: PID_A, dedupeKey: 'b:updated', status: 'updated' });
      for (const status of ['known_problem', 'muted', 'resolved', 'expired'] as const) {
        await insertFinding({ propertyId: PID_A, dedupeKey: `b:${status}`, status });
      }

      assert.equal((await readBadge(PID_A)).body.data!.count, 2);
    });

    test('every query the count needs actually compiled', () => {
      // A filter PostgREST refuses errors the whole query, and an errored
      // count would read as "nothing waiting" — the silent-empty-state bug in
      // its badge-shaped form.
      assert.deepEqual(shim.unsupported, []);
    });
  });

  // ── One hotel ────────────────────────────────────────────────────────────

  describe('one hotel, and only one', () => {
    test("hotel B's decisions never appear in hotel A's count", async () => {
      await insertFinding({ propertyId: PID_A, dedupeKey: 'b:a1' });
      for (let i = 0; i < 5; i += 1) {
        await insertFinding({ propertyId: PID_B, dedupeKey: `b:b${i}` });
      }

      assert.equal((await readBadge(PID_A)).body.data!.count, 1);
      currentUser = GM_B_UID;
      assert.equal((await readBadge(PID_B)).body.data!.count, 5);
    });

    test("hotel A's manager asking for hotel B is 403, not hotel B's number", async () => {
      await insertFinding({ propertyId: PID_B, dedupeKey: 'b:b_only' });
      const { status, body } = await readBadge(PID_B);
      assert.equal(status, 403);
      assert.equal(body.data, undefined);
    });
  });

  // ── The number tracks reality ────────────────────────────────────────────

  describe('after the manager acts', () => {
    test('clearing a card drops the badge, and clearing the last one removes it', async () => {
      const first = await insertFinding({ propertyId: PID_A, dedupeKey: 'b:act1' });
      const second = await insertFinding({ propertyId: PID_A, dedupeKey: 'b:act2' });
      assert.equal(await paintedBadge(PID_A), 2);

      const resolve = async (findingId: string, action: string) => {
        const res = await QUEUE_POST(new NextRequest('https://staxis.test/api/findings', {
          method: 'POST',
          headers: {
            authorization: 'Bearer findings-badge-test-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ propertyId: PID_A, findingId, action }),
        }));
        assert.equal(res.status, 200);
      };

      await resolve(first, 'resolved');
      assert.equal(await paintedBadge(PID_A), 1);

      // The last one goes to "known problem" — a silence the manager armed. The
      // row is still in the ledger holding its one-problem slot; the badge must
      // not still be asking about it.
      await resolve(second, 'known_problem');
      assert.equal(await paintedBadge(PID_A), null);
    });
  });
});
