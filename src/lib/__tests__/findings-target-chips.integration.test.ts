/**
 * PROOF that the chip on room 214's work order asks a question only about room
 * 214, at only this hotel, and can never be talked into answering for a tab.
 *
 * WHY THIS RUNS AGAINST A REAL POSTGRES
 * `findings` is deny-all to anon AND authenticated (migration 0360). There is no
 * RLS policy standing behind this route: the property_id filter applied inside
 * src/lib/findings/store.ts IS the tenant wall. A stubbed client would prove the
 * route SENT a scoped query; only a database can prove the query returns hotel
 * A's rows and refuses hotel B's.
 *
 * Both hotels carry a finding about a room with the SAME number, and every
 * hotel-B row is poisoned with `ZZLEAKB` — so a forgotten filter has something
 * to match and something to leak.
 *
 * The account gate runs for real too: loadManagerCaller against the migrated
 * `accounts` table, which is where this app's most expensive recurring bug lives
 * (a lookup naming a column that does not exist errors, reads at the call site
 * as "no such account", and turns the feature off for everyone with a green
 * build).
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
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { NextRequest } from 'next/server';
import type { PGlite } from '@electric-sql/pglite';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { GET } from '@/app/api/findings/for-target/route';
import { chipFor } from '@/components/concourse/target-chip';

import { applyMigrationsToPglite, seedCanonicalTestAuthority } from '../../../tests/fixtures/pglite-migrate';
import {
  createPglitePostgrest,
  loadCatalog,
  type Catalog,
  type PglitePostgrest,
} from '../../../tests/fixtures/postgrest-pglite';
import { seedTwoHotels, LEAK_MARKER, PID_A, PID_B } from '../../../tests/fixtures/pglite-two-hotel-seed';

// ─── Identities ─────────────────────────────────────────────────────────────

const GM_A_UID = 'aaaaaaaa-0000-4000-8000-0000000000e1';
const GM_B_UID = 'bbbbbbbb-0000-4000-8000-0000000000e1';
const HOUSEKEEPER_UID = 'cccccccc-0000-4000-8000-0000000000e1';
const STRANGER_UID = 'dddddddd-0000-4000-8000-0000000000e1';

const ITEM_A = 'a1b2c3d4-0000-4000-8000-0000000000a1';
const ITEM_B = 'a1b2c3d4-0000-4000-8000-0000000000a2';

let currentUser: string | null = GM_A_UID;

let pg: PGlite;
let catalog: Catalog;
let shim: PglitePostgrest;

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);
const originalGetUser = supabaseAdmin.auth.getUser.bind(supabaseAdmin.auth);

// ─── Helpers ────────────────────────────────────────────────────────────────

function req(qs: string, opts: { auth?: boolean } = {}): NextRequest {
  return new NextRequest(`https://staxis.test/api/findings/for-target${qs}`, {
    method: 'GET',
    headers: opts.auth === false ? {} : { authorization: 'Bearer chip-route-test-token' },
  });
}

interface Body {
  ok: boolean;
  error?: string;
  data?: { kind: string; value: string; findingIds: string[] };
}

async function lookup(
  propertyId: string,
  kind: string,
  value: string,
): Promise<{ status: number; body: Body }> {
  const res = await GET(req(
    `?propertyId=${propertyId}&kind=${encodeURIComponent(kind)}&value=${encodeURIComponent(value)}`,
  ));
  return { status: res.status, body: (await res.json()) as Body };
}

async function ids(propertyId: string, kind: string, value: string): Promise<string[]> {
  const { status, body } = await lookup(propertyId, kind, value);
  assert.equal(status, 200, `lookup failed: ${body.error}`);
  return body.data!.findingIds;
}

/** Insert a finding straight into Postgres, bypassing the app entirely. */
async function insertFinding(opts: {
  propertyId: string;
  dedupeKey: string;
  summary: string;
  evidence: Record<string, unknown>;
  detectorId?: string;
  severity?: string;
  disposition?: string;
  judgedDisposition?: string | null;
  status?: string;
}): Promise<string> {
  const r = await pg.query<{ id: string }>(
    `insert into public.findings
       (property_id, detector_id, dedupe_key, summary, severity, disposition, judged_disposition,
        status, receipt_query_id, evidence, magnitude)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'probe_receipt',$9::jsonb,1)
     returning id`,
    [
      opts.propertyId,
      opts.detectorId ?? 'probe_det',
      opts.dedupeKey,
      opts.summary,
      opts.severity ?? 'attention',
      opts.disposition ?? 'recommend',
      opts.judgedDisposition ?? null,
      opts.status ?? 'open',
      JSON.stringify(opts.evidence),
    ],
  );
  return r.rows[0].id;
}

function roomEvidence(room: string): Record<string, unknown> {
  return {
    queryId: 'probe_receipt',
    params: { room_number: room },
    values: {},
    basis: `about room ${room}`,
    target: { kind: 'room', value: room },
  };
}

function itemEvidence(itemId: string): Record<string, unknown> {
  return {
    queryId: 'probe_receipt',
    params: { item_id: itemId },
    values: {},
    basis: 'about an item',
    target: { kind: 'inventory_item', value: itemId },
  };
}

describe('/api/findings/for-target — the chip’s one question', () => {
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
        ? { data: { user: { id: currentUser, email: `${currentUser}@chips.test` } }, error: null }
        : { data: { user: null }, error: { message: 'invalid token', status: 401, name: 'AuthApiError' } }) as unknown as typeof supabaseAdmin.auth.getUser;

    for (const [uid, email] of [
      [GM_A_UID, 'gm.a@chips.test'],
      [GM_B_UID, 'gm.b@chips.test'],
      [HOUSEKEEPER_UID, 'hk.a@chips.test'],
      [STRANGER_UID, 'nobody@chips.test'],
    ] as const) {
      await pg.query('insert into auth.users (id, email) values ($1,$2) on conflict do nothing', [uid, email]);
    }
    await pg.query(
      `insert into public.accounts (username, display_name, role, data_user_id, password_hash)
       values ('chips.gm.a','Maria (GM)','general_manager',$1,'x'),
              ('chips.gm.b','Bea (GM)','general_manager',$2,'x'),
              ('chips.hk.a','Ana','housekeeping',$3,'x')`,
      [GM_A_UID, GM_B_UID, HOUSEKEEPER_UID],
    );
    await seedCanonicalTestAuthority(pg, { username: 'chips.gm.a', propertyIds: [PID_A] });
    await seedCanonicalTestAuthority(pg, { username: 'chips.gm.b', propertyIds: [PID_B] });
    await seedCanonicalTestAuthority(pg, { username: 'chips.hk.a', propertyIds: [PID_A] });
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
    await pg.query('delete from public.findings');
  });

  // ── The door ──────────────────────────────────────────────────────────────

  describe('the door', () => {
    test('no session is 401, not "no pattern here"', async () => {
      currentUser = null;
      const res = await GET(req(`?propertyId=${PID_A}&kind=room&value=214`, { auth: false }));
      assert.equal(res.status, 401);
    });

    test('a valid session with no account row is refused, not served', async () => {
      currentUser = STRANGER_UID;
      assert.equal((await lookup(PID_A, 'room', '214')).status, 403);
    });

    test('a housekeeper is refused — findings are a manager screen', async () => {
      currentUser = HOUSEKEEPER_UID;
      assert.equal((await lookup(PID_A, 'room', '214')).status, 403);
    });

    test("hotel A's manager asking about hotel B is 403, and the body carries nothing of B's", async () => {
      await insertFinding({
        propertyId: PID_B, dedupeKey: 'probe:b', summary: `B ${LEAK_MARKER}`, evidence: roomEvidence('214'),
      });
      const { status, body } = await lookup(PID_B, 'room', '214');
      assert.equal(status, 403);
      assert.ok(!JSON.stringify(body).includes(LEAK_MARKER), 'a 403 body leaked hotel B content');
    });

    test('a malformed property id is 400, never a fall-through to everything', async () => {
      assert.equal((await GET(req('?propertyId=not-a-uuid&kind=room&value=214'))).status, 400);
      assert.equal((await GET(req('?kind=room&value=214'))).status, 400);
    });

    test('an unknown kind is 400 rather than a silent empty answer', async () => {
      // `equipment` used to be in this list and is now a real kind (0368). The
      // set is "things no screen in Staxis shows on their own", so it shrinks
      // whenever one of them grows a detail view — which is exactly the event
      // that should make somebody edit this line on purpose.
      for (const kind of ['staff', 'vendor', 'ROOM', '']) {
        const res = await GET(req(`?propertyId=${PID_A}&kind=${encodeURIComponent(kind)}&value=214`));
        assert.equal(res.status, 400, `kind "${kind}" was accepted`);
      }
    });
  });

  // ── The founder's rule, enforced at the wire ──────────────────────────────

  describe('on the thing, not the tab', () => {
    test('a request with no thing in it is REFUSED, not answered emptily', async () => {
      // The decision was "on the thing, not the tab". If this endpoint merely
      // returned nothing without a specific thing, a strip at the top of the
      // Maintenance tab would be one relaxed validator away. It is a 400: there
      // is no shape of question here that a tab could ask.
      await insertFinding({
        propertyId: PID_A, dedupeKey: 'probe:a', summary: 'A', evidence: roomEvidence('214'),
      });
      for (const qs of [
        `?propertyId=${PID_A}&kind=room`,
        `?propertyId=${PID_A}&kind=room&value=`,
        `?propertyId=${PID_A}&kind=room&value=%20%20`,
      ]) {
        const res = await GET(req(qs));
        assert.equal(res.status, 400, `"${qs}" was answered instead of refused`);
        const body = (await res.json()) as Body;
        assert.equal(body.data, undefined, `"${qs}" returned data`);
      }
    });

    test('a wildcard-shaped value matches a room called that, which is nothing', async () => {
      await insertFinding({
        propertyId: PID_A, dedupeKey: 'probe:a', summary: 'A', evidence: roomEvidence('214'),
      });
      // The lookup is an equality on an identity, never a pattern — so the
      // usual "%"/"*" probes are just room names no hotel has.
      for (const value of ['%', '*', '%25', '214%', '*14']) {
        assert.deepEqual(await ids(PID_A, 'room', value), [], value);
      }
    });

    test('the chip is a link and a sentence — the route sends no card content', async () => {
      await insertFinding({
        propertyId: PID_A,
        dedupeKey: 'probe:a',
        summary: 'Room 214 has had 4 hvac work orders in 30 days',
        evidence: roomEvidence('214'),
      });
      const { body } = await lookup(PID_A, 'room', '214');
      // No summary, no price, no severity, no status. A chip that carried those
      // would be a second card to keep in sync with the queue's.
      assert.deepEqual(Object.keys(body.data!).sort(), ['findingIds', 'kind', 'value']);
      assert.ok(!JSON.stringify(body).includes('hvac'), 'card content travelled with the signpost');
    });
  });

  // ── Matching ──────────────────────────────────────────────────────────────

  describe('the chip lands on the right thing', () => {
    test('214 gets the chip and 215 does not', async () => {
      const id = await insertFinding({
        propertyId: PID_A, dedupeKey: 'probe:214', summary: 'about 214', evidence: roomEvidence('214'),
      });
      await insertFinding({
        propertyId: PID_A, dedupeKey: 'probe:216', summary: 'about 216', evidence: roomEvidence('216'),
      });

      assert.deepEqual(await ids(PID_A, 'room', '214'), [id]);
      assert.deepEqual(await ids(PID_A, 'room', '215'), []);
      // Whitespace on either side of the wire is not a different room.
      assert.deepEqual(await ids(PID_A, 'room', ' 214 '), [id]);
    });

    test('an item-level pattern lands on that item and no other', async () => {
      const id = await insertFinding({
        propertyId: PID_A, dedupeKey: 'probe:item', summary: 'soap', evidence: itemEvidence(ITEM_A),
      });
      assert.deepEqual(await ids(PID_A, 'inventory_item', ITEM_A), [id]);
      assert.deepEqual(await ids(PID_A, 'inventory_item', ITEM_B), []);
      // A room number is not an item id.
      assert.deepEqual(await ids(PID_A, 'room', ITEM_A), []);
    });

    test('legacy rows — the ones on Test Hotel right now — still find their room', async () => {
      // The `[QA seed]` shape: no structured target, a `room` param.
      const id = await insertFinding({
        propertyId: PID_A,
        dedupeKey: 'qa_seed:room_214_hvac',
        summary: '[QA seed] room 214 hvac',
        detectorId: 'qa_seed',
        evidence: {
          queryId: 'qa_seed', values: {}, basis: 'seed',
          params: { room: '214', qa_seed: '[QA seed]', category: 'hvac', window_days: 30 },
        },
      });
      assert.deepEqual(await ids(PID_A, 'room', '214'), [id]);
      assert.deepEqual(await ids(PID_A, 'room', '215'), []);
    });

    test('only open and updated findings put a chip on a room', async () => {
      for (const status of ['open', 'updated'] as const) {
        await pg.query('delete from public.findings');
        await insertFinding({
          propertyId: PID_A, dedupeKey: `probe:${status}`, summary: status,
          evidence: roomEvidence('214'), status,
        });
        assert.equal((await ids(PID_A, 'room', '214')).length, 1, status);
      }
      for (const status of ['known_problem', 'muted', 'resolved', 'expired'] as const) {
        await pg.query('delete from public.findings');
        await insertFinding({
          propertyId: PID_A, dedupeKey: `probe:${status}`, summary: status,
          evidence: roomEvidence('214'), status,
        });
        assert.deepEqual(await ids(PID_A, 'room', '214'), [], status);
      }
    });

    test('a question or a dropped finding gets no chip — there is no card to open', async () => {
      await insertFinding({
        propertyId: PID_A, dedupeKey: 'probe:ask', summary: 'q',
        evidence: roomEvidence('214'), disposition: 'ask',
      });
      await insertFinding({
        propertyId: PID_A, dedupeKey: 'probe:drop', summary: 'd',
        evidence: roomEvidence('214'), disposition: 'drop',
      });
      // The judge's verdict governs where it has one — reading the detector's
      // default would signpost a card that is really a drip question.
      await insertFinding({
        propertyId: PID_A, dedupeKey: 'probe:judged_ask', summary: 'j',
        evidence: roomEvidence('214'), disposition: 'recommend', judgedDisposition: 'ask',
      });
      const shown = await insertFinding({
        propertyId: PID_A, dedupeKey: 'probe:shown', summary: 's',
        evidence: roomEvidence('214'), disposition: 'recommend',
      });
      assert.deepEqual(await ids(PID_A, 'room', '214'), [shown]);
    });

    test('the link the chip draws carries that finding’s id', async () => {
      const id = await insertFinding({
        propertyId: PID_A, dedupeKey: 'probe:link', summary: 'x', evidence: roomEvidence('214'),
      });
      const chip = chipFor(await ids(PID_A, 'room', '214'), 'en')!;
      assert.equal(chip.href, `/feed?focus=${id}`);
      assert.equal(chip.text, 'Staxis sees a pattern here →');
      // And a room with nothing wrong renders nothing at all.
      assert.equal(chipFor(await ids(PID_A, 'room', '215'), 'en'), null);
    });
  });

  // ── Tenant isolation ──────────────────────────────────────────────────────

  describe('one hotel’s room 214 is not another’s', () => {
    beforeEach(async () => {
      await insertFinding({
        propertyId: PID_A, dedupeKey: 'probe:shared', summary: 'HOTEL A version',
        evidence: roomEvidence('214'),
      });
      await insertFinding({
        propertyId: PID_B, dedupeKey: 'probe:shared', summary: `HOTEL B version ${LEAK_MARKER}`,
        evidence: roomEvidence('214'),
      });
      await insertFinding({
        propertyId: PID_B, dedupeKey: 'probe:b_item', summary: `B item ${LEAK_MARKER}`,
        evidence: itemEvidence(ITEM_A),
      });
    });

    test("hotel A's room 214 chip carries exactly one id, and it is hotel A's", async () => {
      const { body } = await lookup(PID_A, 'room', '214');
      const text = JSON.stringify(body);
      assert.ok(!text.includes(LEAK_MARKER), 'hotel B content leaked into hotel A');
      assert.ok(!text.includes('bbbbbbbb-'), "a hotel B uuid leaked into hotel A's chip");
      assert.equal(body.data!.findingIds.length, 1);

      const aId = await pg.query<{ id: string }>(
        `select id from public.findings where property_id = $1 and dedupe_key = 'probe:shared'`,
        [PID_A],
      );
      assert.deepEqual(body.data!.findingIds, [aId.rows[0].id]);
    });

    test('an item id shared across hotels answers only for the hotel that asked', async () => {
      assert.deepEqual(await ids(PID_A, 'inventory_item', ITEM_A), []);
      currentUser = GM_B_UID;
      assert.equal((await ids(PID_B, 'inventory_item', ITEM_A)).length, 1);
    });

    test("hotel B's own manager still gets hotel B's chip", async () => {
      // The isolation must be a WALL, not a broken read that shows nobody
      // anything — a test that only asserts absence passes on a dead feature.
      currentUser = GM_B_UID;
      const { status, body } = await lookup(PID_B, 'room', '214');
      assert.equal(status, 200);
      assert.equal(body.data!.findingIds.length, 1);
    });
  });
});

// ─── The founder's rule, as a structural invariant ──────────────────────────

describe('the chip appears on things and nowhere else', () => {
  /**
   * A NO-RUNTIME INVARIANT, asserted on source on purpose.
   *
   * "No strip at the top of any section tab, no second inbox" is a rule about
   * where a component is MOUNTED, and the app's tab-level trees cannot be stood
   * up in this suite (the runner resolves React under the react-server
   * condition, where react-dom/client refuses to load — so no board can be
   * rendered to check what is not in it).
   *
   * What CAN be checked exactly is the set of places that mount it. Each entry
   * below is a view that is already about ONE thing, and each appears once. A
   * board, a list, a tab header or a second chip in the same file fails this,
   * which turns "we decided against a tab strip" into something a future change
   * has to argue with rather than something it can quietly forget.
   */
  const ALLOWED = new Map<string, number>([
    // Maintenance → a work order's detail modal. One room's broken thing.
    ['src/app/maintenance/_components/WorkOrdersTab.tsx', 1],
    // Inventory → one item's own edit sheet.
    ['src/app/inventory/_components/overlays/AddItemSheet.tsx', 1],
    // Maintenance → Preventive → one upkeep schedule's own detail modal. The
    // chip is inside `TaskModal`, NOT on the three-band board that file also
    // renders: the board is a list, and a chip per card would be the tab strip
    // by another name. That distinction is the reason this map counts per file
    // rather than merely checking membership.
    ['src/app/maintenance/_components/PreventiveTab.tsx', 1],
    // Maintenance → Equipment registry → one asset's own detail sheet. Inside
    // `EquipmentDetailModal`, NOT on the registry grid that same file renders:
    // the grid is a list, and a chip per tile would be the tab strip wearing a
    // different name.
    ['src/app/maintenance/_components/EquipmentRegistry.tsx', 1],
  ]);

  test('only the per-thing views mount a PatternChip, once each', () => {
    const root = path.resolve(__dirname, '../../..');
    const listed = chipMountsByFile(root);

    for (const [file, expected] of ALLOWED) {
      const found = listed.get(file) ?? 0;
      assert.equal(
        found, expected,
        `${file} mounts <PatternChip> ${found} time(s); the per-thing rule expects ${expected}`,
      );
    }
    const extra = [...listed.keys()].filter((f) => !ALLOWED.has(f));
    assert.deepEqual(
      extra, [],
      'a new surface mounts <PatternChip>. The founder\'s rule is ON THE THING, NOT THE TAB: '
      + 'if this surface is about one room or one item, add it to ALLOWED above; if it is a '
      + 'board, a list or a tab, it must not have a chip.',
    );
  });
});

/** Count `<PatternChip` mounts per file across src/, excluding the component itself. */
function chipMountsByFile(root: string): Map<string, number> {
  let out = '';
  try {
    out = execFileSync(
      'grep',
      ['-rn', '--include=*.tsx', '--include=*.ts', '-F', '<PatternChip', 'src'],
      { cwd: root, encoding: 'utf8' },
    );
  } catch (e) {
    // grep exits 1 on no matches. Every other failure is a real problem.
    const status = (e as { status?: number }).status;
    if (status !== 1) throw e;
  }
  const counts = new Map<string, number>();
  for (const line of out.split('\n')) {
    const file = line.split(':')[0];
    if (!file) continue;
    // The component's own definition file is where it is DECLARED, not mounted.
    if (file === 'src/components/concourse/PatternChip.tsx') continue;
    // Tests talk ABOUT the chip; they do not put one on a screen.
    if (file.includes('__tests__')) continue;
    counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  return counts;
}
