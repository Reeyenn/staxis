/**
 * PROOF, against a real Postgres, that the one tap does exactly what the card
 * said — or honestly declines — and can always be taken back.
 *
 * WHY NONE OF THIS CAN BE A UNIT TEST
 * Every guarantee here is a database guarantee, and asserting it against a fake
 * would prove only that this code INTENDS to keep it:
 *
 *   • "what runs is what was shown"   — an immutability trigger
 *                                       (staxis_finding_actions_frozen, 0363)
 *   • "re-verified inside the txn"    — one plpgsql function that reads live
 *                                       rows and writes in the same transaction
 *   • "a double tap is one action"    — a UNIQUE index plus a FOR UPDATE row
 *                                       lock and a state guard
 *   • "failed means nothing partial"  — a plpgsql exception block, which is a
 *                                       subtransaction: the write rolls back,
 *                                       the failure record does not
 *
 * So the real migrations are applied to PGlite, the PostgREST shim compiles the
 * real query builder into real SQL, and the real store + the real API route run
 * unmodified against two seeded hotels — hotel B's rows deliberately reachable,
 * every hotel-B uuid starting `bbbbbbbb-`.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder';
process.env.DISABLE_SERVER_2FA_ENFORCEMENT = 'true';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { NextRequest } from 'next/server';
import type { PGlite } from '@electric-sql/pglite';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { POST as ACTIONS_POST } from '@/app/api/findings/actions/route';
import { GET as QUEUE_GET } from '@/app/api/findings/route';
import { proposeAction, loadActionsForFindings } from '@/lib/findings/actions/store';
import { registerDetector } from '@/lib/findings/registry';
import { runFindingsForProperty } from '@/lib/findings/runner';
import { setFindingStatus } from '@/lib/findings/store';
import type { Detector, DetectorParams, FindingDraft } from '@/lib/findings/types';
import { createWorkOrderParams } from '@/lib/findings/actions/catalog/create-work-order';
import { raiseReorderPointParams } from '@/lib/findings/actions/catalog/raise-reorder-point';
import { persistJudgments } from '@/lib/findings/judge';

import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';
import {
  createPglitePostgrest,
  loadCatalog,
  type Catalog,
  type PglitePostgrest,
} from '../../../tests/fixtures/postgrest-pglite';
import { seedTwoHotels, PID_A, PID_B } from '../../../tests/fixtures/pglite-two-hotel-seed';

// ─── Identities ─────────────────────────────────────────────────────────────

const GM_A_UID = 'aaaaaaaa-0000-4000-8000-0000000000e1';
const GM_B_UID = 'bbbbbbbb-0000-4000-8000-0000000000e1';
let currentUser: string | null = GM_A_UID;
let accountA = '';

let pg: PGlite;
let catalog: Catalog;
let shim: PglitePostgrest;

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);
const originalGetUser = supabaseAdmin.auth.getUser.bind(supabaseAdmin.auth);

const ITEM_A = 'aaaaaaaa-0000-4000-8000-00000000a001';
const ITEM_B = 'bbbbbbbb-0000-4000-8000-00000000a001';

// ─── Helpers ────────────────────────────────────────────────────────────────

function actionReq(body: Record<string, unknown>): NextRequest {
  return new NextRequest('https://staxis.test/api/findings/actions', {
    method: 'POST',
    headers: {
      authorization: 'Bearer hands-route-test-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

interface ActionBody {
  ok: boolean;
  error?: string;
  data?: {
    state: string;
    code: string;
    receipt: { table: string; id: string; to?: number } | null;
    changed: { field: string; was: unknown; now: unknown } | null;
  };
}

async function tap(
  propertyId: string,
  actionId: string,
  intent: 'execute' | 'undo' = 'execute',
): Promise<{ status: number; body: ActionBody }> {
  const res = await ACTIONS_POST(actionReq({ propertyId, actionId, intent }));
  return { status: res.status, body: (await res.json()) as ActionBody };
}

/** A finding straight into Postgres, bypassing the runner. */
async function insertFinding(propertyId: string, key: string, magnitude = 4): Promise<string> {
  const r = await pg.query<{ id: string }>(
    `insert into public.findings
       (property_id, detector_id, dedupe_key, summary, severity, disposition, status,
        receipt_query_id, evidence, magnitude)
     values ($1,'repeat_room_work_orders',$2,'a place that keeps breaking','attention',
             'propose','open','probe_receipt','{}'::jsonb,$3)
     returning id`,
    [propertyId, key, magnitude],
  );
  return r.rows[0].id;
}

async function insertWorkOrder(
  propertyId: string,
  location: string,
  status = 'submitted',
): Promise<string> {
  const r = await pg.query<{ id: string }>(
    `insert into public.work_orders (property_id, room_number, description, severity, status)
     values ($1,$2,'a fault','medium',$3) returning id`,
    [propertyId, location, status],
  );
  return r.rows[0].id;
}

async function actionRow(id: string) {
  const r = await pg.query<Record<string, unknown>>(
    'select * from public.finding_actions where id = $1',
    [id],
  );
  return r.rows[0] ?? null;
}

async function openActionId(findingId: string): Promise<string> {
  const r = await pg.query<{ id: string }>(
    `select id from public.finding_actions where finding_id = $1 and state = 'proposed'`,
    [findingId],
  );
  assert.ok(r.rows[0], 'expected a proposed action');
  return r.rows[0].id;
}

async function workOrderCount(propertyId: string, location: string): Promise<number> {
  const r = await pg.query<{ n: number }>(
    `select count(*)::int n from public.work_orders where property_id=$1 and room_number=$2`,
    [propertyId, location],
  );
  return r.rows[0]?.n ?? 0;
}

/** Set up a location with N open work orders and a frozen offer against it. */
async function offerWorkOrder(
  propertyId: string,
  location: string,
  openCount: number,
  key = `location:${location}`,
): Promise<{ findingId: string; actionId: string }> {
  const findingId = await insertFinding(propertyId, key, openCount);
  for (let i = 0; i < openCount; i += 1) await insertWorkOrder(propertyId, location);
  const outcome = await proposeAction(propertyId, findingId, {
    kind: 'create_work_order',
    params: createWorkOrderParams(location),
    verify: { location, window_days: 30, open_work_orders: openCount },
  });
  assert.equal(outcome, 'proposed');
  return { findingId, actionId: await openActionId(findingId) };
}

async function offerReorder(
  propertyId: string,
  itemId: string,
  from = 20,
): Promise<{ findingId: string; actionId: string; plan: Record<string, unknown> }> {
  const findingId = await insertFinding(propertyId, `item_usage:${itemId}`, 30);
  const plan = raiseReorderPointParams({
    itemId,
    itemName: 'Bath towels',
    unit: 'each',
    currentReorderAt: from,
    leadDays: 3,
    ratePerDay: 12.4,
  })!;
  const outcome = await proposeAction(propertyId, findingId, {
    kind: 'raise_inventory_reorder_point',
    params: plan,
    verify: { item_id: itemId, item_name: 'Bath towels', reorder_at: from },
  });
  assert.equal(outcome, 'proposed');
  return { findingId, actionId: await openActionId(findingId), plan };
}

async function reorderAt(itemId: string): Promise<number | null> {
  const r = await pg.query<{ reorder_at: string | null }>(
    'select reorder_at from public.inventory where id = $1',
    [itemId],
  );
  const raw = r.rows[0]?.reorder_at ?? null;
  return raw === null ? null : Number(raw);
}

// ─── the probe detector ─────────────────────────────────────────────────────
// A real declaration with a real action template; what it FINDS is whatever the
// current test put in `probeDrafts`. Driving the runner through it is the only
// way to prove that attaching a frozen action is something the RUNNER does from
// the declaration, rather than something a detector remembered to do.

let probeDrafts: FindingDraft[] = [];

function probeDraft(stillOpen: number): FindingDraft {
  return {
    key: 'location:Room 214',
    summary: `Room 214 has had 4 work orders — ${stillOpen} still open.`,
    severity: 'attention',
    disposition: stillOpen > 0 ? 'propose' : 'recommend',
    magnitude: 4,
    evidence: {
      queryId: 'probe_receipt',
      params: { location: 'Room 214', window_days: 30 },
      values: { work_orders: 4, still_open: stillOpen },
      basis: '4 work orders',
    },
    price: null,
  };
}

const probe: Detector<DetectorParams> = {
  declaration: {
    id: 'probe_hands',
    description: 'probe detector for the hands integration test',
    inputs: ['operational_signals'],
    requires: [{ feed: 'operational_signals', minRecords: 0, because: 'no operational records' }],
    receiptQueryId: 'probe_receipt',
    defaultDisposition: 'propose',
    defaultSeverity: 'attention',
    escalation: { factor: 2, minDelta: 3 },
    maxPerRun: 5,
    staleAfterDays: 7,
    actionTemplate: (draft) => {
      const stillOpen = draft.evidence.values.still_open;
      if (typeof stillOpen !== 'number' || stillOpen < 1) return null;
      return {
        kind: 'create_work_order',
        params: createWorkOrderParams('Room 214'),
        verify: { location: 'Room 214', window_days: 30, open_work_orders: stillOpen },
      };
    },
    evalCases: [{ name: 'noop', feeds: { operational_signals: [] }, expectKeys: [] }],
  },
  detect: () => probeDrafts,
};

/**
 * A second probe whose template ALWAYS returns a plan, whatever the draft says.
 *
 * It exists to isolate the RUNNER's gates from the template's own judgement.
 * With `probe_hands` the two are entangled — its template declines on a
 * recommendation by itself — so a test using it would pass even if the runner
 * stopped checking anything, which is precisely the bug worth catching.
 */
let eagerDrafts: FindingDraft[] = [];

const eagerProbe: Detector<DetectorParams> = {
  declaration: {
    id: 'probe_hands_eager',
    description: 'probe detector whose action template never declines',
    inputs: ['operational_signals'],
    requires: [{ feed: 'operational_signals', minRecords: 0, because: 'no operational records' }],
    receiptQueryId: 'probe_receipt',
    defaultDisposition: 'propose',
    defaultSeverity: 'attention',
    escalation: { factor: 4, minDelta: 100 },
    maxPerRun: 5,
    staleAfterDays: 7,
    actionTemplate: () => ({
      kind: 'create_work_order',
      params: createWorkOrderParams('Room 214'),
      verify: { location: 'Room 214', window_days: 30, open_work_orders: 1 },
    }),
    evalCases: [{ name: 'noop', feeds: { operational_signals: [] }, expectKeys: [] }],
  },
  detect: () => eagerDrafts,
};

const ONLY_PROBE = {
  detectorIds: ['probe_hands'] as const,
  skipJudge: true,
  skipDemotion: true,
};

const ONLY_EAGER = {
  detectorIds: ['probe_hands_eager'] as const,
  skipJudge: true,
  skipDemotion: true,
};

// ═══════════════════════════════════════════════════════════════════════════

describe('the hands, proven against a real database', () => {
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
        ? { data: { user: { id: currentUser, email: `${currentUser}@hands.test` } }, error: null }
        : {
            data: { user: null },
            error: { message: 'invalid token', status: 401, name: 'AuthApiError' },
          };

    for (const [uid, email] of [
      [GM_A_UID, 'gm.a@hands.test'],
      [GM_B_UID, 'gm.b@hands.test'],
    ] as const) {
      await pg.query('insert into auth.users (id, email) values ($1,$2) on conflict do nothing', [
        uid,
        email,
      ]);
    }
    const inserted = await pg.query<{ id: string }>(
      `insert into public.accounts (username, display_name, role, property_access, data_user_id, password_hash)
       values ('hands.gm.a','Maria (GM)','general_manager',array[$1::uuid],$2,'x'),
              ('hands.gm.b','Bea (GM)','general_manager',array[$3::uuid],$4,'x')
       returning id`,
      [PID_A, GM_A_UID, PID_B, GM_B_UID],
    );
    accountA = inserted.rows[0].id;
    registerDetector(probe);
    registerDetector(eagerProbe);

    // One inventory item per hotel, both named the same and both with the same
    // reorder point — so a forgotten hotel filter has something to hit.
    for (const [id, pid] of [
      [ITEM_A, PID_A],
      [ITEM_B, PID_B],
    ] as const) {
      await pg.query(
        `insert into public.inventory (id, property_id, name, category, unit, current_stock, par_level, reorder_at, reorder_lead_days)
         values ($1,$2,'Bath towels','housekeeping','each',0,120,20,3)
         on conflict do nothing`,
        [id, pid],
      );
    }
  });

  after(async () => {
    supabaseAdmin.from = originalFrom;
    supabaseAdmin.rpc = originalRpc;
    supabaseAdmin.auth.getUser = originalGetUser;
    await pg?.close();
  });

  beforeEach(async () => {
    currentUser = GM_A_UID;
    probeDrafts = [];
    eagerDrafts = [];
    await pg.query('delete from public.finding_actions');
    await pg.query('delete from public.findings');
    await pg.query(`delete from public.work_orders`);
    await pg.query(`update public.inventory set reorder_at = 20 where id in ($1,$2)`, [
      ITEM_A,
      ITEM_B,
    ]);
    shim.reset();
  });

  // ── the migration actually landed ────────────────────────────────────────

  test('0363 applied — without it every test below would prove nothing', async () => {
    assert.ok(catalog.tables.has('finding_actions'), 'finding_actions missing from the schema');
    const fns = await pg.query<{ proname: string }>(
      `select proname from pg_proc where proname in
        ('staxis_execute_finding_action','staxis_undo_finding_action','staxis_finding_actions_frozen')
       order by proname`,
    );
    assert.deepEqual(
      fns.rows.map((r) => r.proname),
      ['staxis_execute_finding_action', 'staxis_finding_actions_frozen', 'staxis_undo_finding_action'],
    );
  });

  test('the browser cannot reach the table at all', async () => {
    const policies = await pg.query<{ policyname: string; qual: string | null }>(
      `select policyname, qual::text from pg_policies
        where schemaname='public' and tablename='finding_actions'`,
    );
    assert.equal(policies.rows.length, 1);
    assert.match(String(policies.rows[0].qual), /false/i, 'deny-all is the only policy');
  });

  // ═══ FROZEN AT PROPOSAL TIME ═══

  describe('what runs is what was shown', () => {
    test('the database computes the fingerprint — the app never supplies one', async () => {
      const { actionId } = await offerWorkOrder(PID_A, 'Room 214', 2);
      const row = await actionRow(actionId);
      assert.match(String(row!.params_fingerprint), /^[0-9a-f]{64}$/);
      assert.equal(
        row!.idempotency_key,
        `${String(row!.finding_id)}:${String(row!.params_fingerprint)}`,
      );
    });

    test('the frozen plan CANNOT be edited after the card was written', async () => {
      const { actionId } = await offerWorkOrder(PID_A, 'Room 214', 2);
      await assert.rejects(
        () =>
          pg.query(
            `update public.finding_actions
                set params = jsonb_set(params,'{location}','"Room 999"')
              where id = $1`,
            [actionId],
          ),
        /frozen proposal is immutable/i,
        'if the plan could be edited after rendering, the manager would tap the button they read ' +
          'and something else would happen',
      );
    });

    test('neither can the facts it will be re-checked against', async () => {
      const { actionId } = await offerWorkOrder(PID_A, 'Room 214', 2);
      await assert.rejects(
        () =>
          pg.query(
            `update public.finding_actions set verify = '{"open_work_orders":0}'::jsonb where id=$1`,
            [actionId],
          ),
        /frozen proposal is immutable/i,
      );
    });

    test('a tampered fingerprint refuses to execute even with the trigger out of the way', async () => {
      const { actionId } = await offerWorkOrder(PID_A, 'Room 214', 2);
      // Simulate the trigger having been dropped: change the plan behind its
      // back, leaving the fingerprint describing the plan the manager saw.
      await pg.query('alter table public.finding_actions disable trigger staxis_finding_actions_frozen_tg');
      await pg.query(
        `update public.finding_actions set params = jsonb_set(params,'{location}','"Room 999"') where id=$1`,
        [actionId],
      );
      await pg.query('alter table public.finding_actions enable trigger staxis_finding_actions_frozen_tg');

      const result = await tap(PID_A, actionId);
      assert.equal(result.body.data?.code, 'tampered');
      assert.equal(await workOrderCount(PID_A, 'Room 999'), 0);
      assert.equal(await workOrderCount(PID_A, 'Room 214'), 2, 'only the two originals');
    });

    test('a re-run with the same plan does not stack a second offer', async () => {
      const { findingId } = await offerWorkOrder(PID_A, 'Room 214', 2);
      const again = await proposeAction(PID_A, findingId, {
        kind: 'create_work_order',
        params: createWorkOrderParams('Room 214'),
        verify: { location: 'Room 214', window_days: 30, open_work_orders: 2 },
      });
      assert.equal(again, 'unchanged');
      const rows = await pg.query<{ n: number }>(
        `select count(*)::int n from public.finding_actions where finding_id=$1`,
        [findingId],
      );
      assert.equal(rows.rows[0].n, 1);
    });

    test('a re-run with a DIFFERENT plan supersedes the old offer rather than duplicating it', async () => {
      const { findingId, actionId } = await offerReorder(PID_A, ITEM_A, 20);
      const bigger = raiseReorderPointParams({
        itemId: ITEM_A,
        itemName: 'Bath towels',
        unit: 'each',
        currentReorderAt: 20,
        leadDays: 3,
        ratePerDay: 20,
      })!;
      assert.equal(
        await proposeAction(PID_A, findingId, {
          kind: 'raise_inventory_reorder_point',
          params: bigger,
          verify: { item_id: ITEM_A, item_name: 'Bath towels', reorder_at: 20 },
        }),
        'proposed',
      );
      assert.equal((await actionRow(actionId))!.state, 'superseded');
      const open = await pg.query<{ n: number }>(
        `select count(*)::int n from public.finding_actions where finding_id=$1 and state='proposed'`,
        [findingId],
      );
      assert.equal(open.rows[0].n, 1, 'exactly one live offer per problem — the card has one button');
    });

    test('a decision the manager already made is never re-offered', async () => {
      const { findingId, actionId } = await offerWorkOrder(PID_A, 'Room 214', 2);
      await tap(PID_A, actionId);
      assert.equal(
        await proposeAction(PID_A, findingId, {
          kind: 'create_work_order',
          params: createWorkOrderParams('Room 214'),
          verify: { location: 'Room 214', window_days: 30, open_work_orders: 2 },
        }),
        'settled',
        'asking again every night for as long as the problem lasts is nagging wearing a button',
      );
    });
  });

  // ═══ RE-VERIFIED AT THE TAP ═══

  describe('re-verification inside the transaction', () => {
    test('the facts still hold: the work order is really created', async () => {
      const { actionId } = await offerWorkOrder(PID_A, 'Room 214', 2);
      const result = await tap(PID_A, actionId);

      assert.equal(result.status, 200);
      assert.equal(result.body.data?.code, 'executed');
      assert.equal(result.body.data?.receipt?.table, 'work_orders');

      const created = await pg.query<{ description: string; source: string; status: string }>(
        `select description, source, status from public.work_orders where id = $1`,
        [String(result.body.data!.receipt!.id)],
      );
      assert.equal(created.rows.length, 1);
      assert.equal(created.rows[0].source, 'staxis_finding');
      assert.equal(created.rows[0].status, 'submitted');
      assert.match(created.rows[0].description, /Room 214/);

      const row = await actionRow(actionId);
      assert.equal(row!.state, 'executed');
      assert.equal(row!.created_object_table, 'work_orders');
      assert.equal(row!.decided_by, accountA, 'the receipt records who approved it');
      assert.ok(row!.outcome_due_at, 'an outcome check is scheduled — INV-28 shape');
    });

    // ── THE test ────────────────────────────────────────────────────────────
    test('THE DECLINE: the work orders were closed between the offer and the tap', async () => {
      const { actionId } = await offerWorkOrder(PID_A, 'Room 214', 3);

      // Between proposal and tap, the team dealt with two of the three. Age is
      // a proxy; changed-ness is the thing, and this is the change.
      await pg.query(
        `update public.work_orders set status='resolved'
          where property_id=$1 and room_number='Room 214'
            and id in (select id from public.work_orders
                        where property_id=$1 and room_number='Room 214' limit 2)`,
        [PID_A],
      );

      const result = await tap(PID_A, actionId);
      assert.equal(result.body.data?.code, 'declined_changed');
      assert.equal(result.body.data?.changed?.field, 'open_work_orders');
      assert.equal(Number(result.body.data?.changed?.was), 3);
      assert.equal(Number(result.body.data?.changed?.now), 1);

      // Nothing was created. "The AI declined and explained" instead of "the AI
      // did something wrong".
      assert.equal(await workOrderCount(PID_A, 'Room 214'), 3, 'the three originals, and no fourth');
      assert.equal((await actionRow(actionId))!.state, 'declined_changed');
    });

    test('a decline is final — the offer does not come back for a second try', async () => {
      const { actionId } = await offerWorkOrder(PID_A, 'Room 214', 3);
      await pg.query(`update public.work_orders set status='resolved' where property_id=$1`, [PID_A]);
      await tap(PID_A, actionId);
      const second = await tap(PID_A, actionId);
      assert.equal(second.body.data?.code, 'already_declined_changed');
      assert.equal(await workOrderCount(PID_A, 'Room 214'), 3);
    });

    test('a reorder point somebody already changed declines, and does not overwrite them', async () => {
      const { actionId } = await offerReorder(PID_A, ITEM_A, 20);
      // A human raised it to 45 themselves in the meantime.
      await pg.query('update public.inventory set reorder_at = 45 where id = $1', [ITEM_A]);

      const result = await tap(PID_A, actionId);
      assert.equal(result.body.data?.code, 'declined_changed');
      assert.equal(result.body.data?.changed?.field, 'reorder_at');
      assert.equal(await reorderAt(ITEM_A), 45, "the manager's own number is untouched");
    });

    test('an item that left the list declines rather than erroring', async () => {
      // Its OWN item: archiving is one-way at the database level (archived rows
      // are immutable), so reusing the shared fixture item would poison every
      // later test in this file with a state it cannot be brought back from.
      const doomed = 'aaaaaaaa-0000-4000-8000-00000000a009';
      await pg.query(
        `insert into public.inventory (id, property_id, name, category, unit, current_stock, par_level, reorder_at, reorder_lead_days)
         values ($1,$2,'Hand soap','housekeeping','each',0,60,20,3) on conflict do nothing`,
        [doomed, PID_A],
      );
      const { actionId } = await offerReorder(PID_A, doomed, 20);
      await pg.query('update public.inventory set archived_at = now() where id = $1', [doomed]);
      const result = await tap(PID_A, actionId);
      assert.equal(result.body.data?.code, 'declined_changed');
      assert.equal(result.body.data?.changed?.field, 'item');
    });

    test('more work orders than when it was offered still executes — it got worse, not better', async () => {
      const { actionId } = await offerWorkOrder(PID_A, 'Room 214', 2);
      await insertWorkOrder(PID_A, 'Room 214');
      const result = await tap(PID_A, actionId);
      assert.equal(result.body.data?.code, 'executed');
    });
  });

  // ═══ A DOUBLE TAP IS ONE ACTION ═══

  describe('a double tap is one action, and the database is what says so', () => {
    test('two taps arriving together produce exactly ONE work order', async () => {
      const { actionId } = await offerWorkOrder(PID_A, 'Room 214', 2);
      const [first, second] = await Promise.all([
        tap(PID_A, actionId),
        tap(PID_A, actionId),
      ]);

      const codes = [first.body.data?.code, second.body.data?.code].sort();
      assert.deepEqual(codes, ['already_executed', 'executed'], `got ${codes.join(', ')}`);
      assert.equal(
        await workOrderCount(PID_A, 'Room 214'),
        3,
        'the two originals plus exactly one inspection — not two',
      );
    });

    test('the replay is answered with the FIRST tap receipt, not an error', async () => {
      const { actionId } = await offerWorkOrder(PID_A, 'Room 214', 2);
      const first = await tap(PID_A, actionId);
      const second = await tap(PID_A, actionId);
      assert.equal(second.body.ok, true);
      assert.equal(second.body.data?.code, 'already_executed');
      assert.equal(second.body.data?.receipt?.id, first.body.data?.receipt?.id);
    });

    test('the idempotency key is UNIQUE — two identical proposals cannot both land', async () => {
      const { findingId, actionId } = await offerWorkOrder(PID_A, 'Room 214', 2);
      const row = await actionRow(actionId);
      await assert.rejects(
        () =>
          pg.query(
            `insert into public.finding_actions (property_id, finding_id, action_kind, params, verify)
             values ($1,$2,'create_work_order',$3::jsonb,'{}'::jsonb)`,
            [PID_A, findingId, JSON.stringify(row!.params)],
          ),
        /duplicate key value|unique constraint/i,
      );
    });
  });

  // ═══ UNDO ═══

  describe('undo', () => {
    test('undo removes the work order Staxis created, and records it', async () => {
      const { actionId } = await offerWorkOrder(PID_A, 'Room 214', 2);
      const done = await tap(PID_A, actionId);
      assert.equal(await workOrderCount(PID_A, 'Room 214'), 3);

      const undone = await tap(PID_A, actionId, 'undo');
      assert.equal(undone.body.data?.code, 'undone');
      assert.equal(
        await workOrderCount(PID_A, 'Room 214'),
        2,
        'back to the two the hotel logged itself',
      );

      const gone = await pg.query(`select 1 from public.work_orders where id=$1`, [
        String(done.body.data!.receipt!.id),
      ]);
      assert.equal(gone.rows.length, 0);

      const row = await actionRow(actionId);
      assert.equal(row!.state, 'undone');
      assert.ok(row!.undone_at);
      assert.equal(row!.undone_by, accountA);
      assert.ok(row!.receipt, 'the record of what was created survives the undo');
      assert.equal(
        row!.outcome_kind,
        'reverted',
        'a reversal IS the outcome — nothing needs to go back and ask',
      );
    });

    test('undo restores the exact previous reorder point', async () => {
      const { actionId } = await offerReorder(PID_A, ITEM_A, 20);
      await tap(PID_A, actionId);
      assert.equal(await reorderAt(ITEM_A), 38);

      const undone = await tap(PID_A, actionId, 'undo');
      assert.equal(undone.body.data?.code, 'undone');
      assert.equal(await reorderAt(ITEM_A), 20);
    });

    test('undo REFUSES once somebody has started on the work order', async () => {
      const { actionId } = await offerWorkOrder(PID_A, 'Room 214', 2);
      const done = await tap(PID_A, actionId);
      await pg.query(`update public.work_orders set status='in_progress' where id=$1`, [
        String(done.body.data!.receipt!.id),
      ]);

      const refused = await tap(PID_A, actionId, 'undo');
      assert.equal(refused.body.data?.code, 'undo_refused_touched');
      assert.equal(
        await workOrderCount(PID_A, 'Room 214'),
        3,
        'Staxis undoes its own suggestion; it does not erase somebody working',
      );
      assert.equal((await actionRow(actionId))!.state, 'executed', 'still undoable later');
    });

    test('undo REFUSES once somebody has changed the reorder point themselves', async () => {
      const { actionId } = await offerReorder(PID_A, ITEM_A, 20);
      await tap(PID_A, actionId);
      await pg.query('update public.inventory set reorder_at = 60 where id = $1', [ITEM_A]);

      const refused = await tap(PID_A, actionId, 'undo');
      assert.equal(refused.body.data?.code, 'undo_refused_touched');
      assert.equal(await reorderAt(ITEM_A), 60, 'overwriting a human edit is not an undo');
    });

    test('undoing twice is not an error and does not undo something else', async () => {
      const { actionId } = await offerWorkOrder(PID_A, 'Room 214', 2);
      await tap(PID_A, actionId);
      await tap(PID_A, actionId, 'undo');
      const again = await tap(PID_A, actionId, 'undo');
      assert.equal(again.body.ok, true);
      assert.equal(again.body.data?.code, 'already_undone');
      assert.equal(await workOrderCount(PID_A, 'Room 214'), 2);
    });

    test('an action that never ran cannot be undone', async () => {
      const { actionId } = await offerWorkOrder(PID_A, 'Room 214', 2);
      const result = await tap(PID_A, actionId, 'undo');
      assert.equal(result.body.data?.code, 'not_undoable');
      assert.equal((await actionRow(actionId))!.state, 'proposed');
    });
  });

  // ═══ FAILURE IS RECORDED, NEVER PARTIAL ═══

  describe('when the write itself fails', () => {
    test('the state is failed, the reason is kept, and NOTHING was half-written', async () => {
      const { actionId } = await offerReorder(PID_A, ITEM_A, 20);
      // `inventory_reorder_at_nonnegative` is a real CHECK on a real column.
      // Rewriting the frozen plan to a negative target makes the UPDATE inside
      // the execute transaction throw for a reason Postgres itself supplies.
      await pg.query('alter table public.finding_actions disable trigger staxis_finding_actions_frozen_tg');
      await pg.query(
        `update public.finding_actions
            set params = jsonb_set(params,'{to_reorder_at}','-5'),
                params_fingerprint = encode(sha256(convert_to(
                  jsonb_set(params,'{to_reorder_at}','-5')::text,'UTF8')),'hex')
          where id=$1`,
        [actionId],
      );
      await pg.query('alter table public.finding_actions enable trigger staxis_finding_actions_frozen_tg');
      // The CHECK is NOT VALID in production, so it only bites on new writes —
      // which is exactly the case here. Make it bite in this fixture too.
      await pg.query('alter table public.inventory validate constraint inventory_reorder_at_nonnegative');

      const result = await tap(PID_A, actionId);
      assert.equal(result.body.data?.code, 'failed');

      const row = await actionRow(actionId);
      assert.equal(row!.state, 'failed');
      assert.ok(String(row!.failure_reason).length > 0);
      assert.equal(row!.receipt, null, 'a failed action carries no receipt');
      assert.equal(
        await reorderAt(ITEM_A),
        20,
        'the subtransaction rolled the write back; the failure record did not roll back with it',
      );
    });

    test('a failed action is not silently retried by a second tap', async () => {
      const { actionId } = await offerWorkOrder(PID_A, 'Room 214', 2);
      await pg.query(
        `update public.finding_actions
            set state='failed', failure_reason='synthetic', decided_at=now()
          where id=$1`,
        [actionId],
      );
      const result = await tap(PID_A, actionId);
      assert.equal(result.body.data?.code, 'already_failed');
      assert.equal(await workOrderCount(PID_A, 'Room 214'), 2);
    });
  });

  // ═══ THE TENANT WALL ═══

  describe('one hotel cannot reach into another', () => {
    test("hotel B's manager cannot EXECUTE hotel A's action", async () => {
      const { actionId } = await offerWorkOrder(PID_A, 'Room 214', 2);
      currentUser = GM_B_UID;

      // Naming hotel A is a 403 at the manager gate…
      const asA = await tap(PID_A, actionId);
      assert.equal(asA.status, 403);

      // …and naming their OWN hotel finds no such action, because the row is
      // filtered by property_id before the function ever sees it.
      const asB = await tap(PID_B, actionId);
      assert.equal(asB.status, 404);

      assert.equal(await workOrderCount(PID_A, 'Room 214'), 2, 'nothing was created');
      assert.equal((await actionRow(actionId))!.state, 'proposed');
    });

    test("hotel B's manager cannot UNDO hotel A's executed action", async () => {
      const { actionId } = await offerWorkOrder(PID_A, 'Room 214', 2);
      await tap(PID_A, actionId);
      assert.equal(await workOrderCount(PID_A, 'Room 214'), 3);

      currentUser = GM_B_UID;
      assert.equal((await tap(PID_A, actionId, 'undo')).status, 403);
      assert.equal((await tap(PID_B, actionId, 'undo')).status, 404);

      assert.equal(await workOrderCount(PID_A, 'Room 214'), 3, 'hotel A keeps its work order');
      assert.equal((await actionRow(actionId))!.state, 'executed');
    });

    test('the SQL function itself refuses a cross-hotel pair, with no route in the way', async () => {
      const { actionId } = await offerWorkOrder(PID_A, 'Room 214', 2);
      const direct = await pg.query<{ r: { code: string } }>(
        `select public.staxis_execute_finding_action($1,$2,null) as r`,
        [actionId, PID_B],
      );
      assert.equal(direct.rows[0].r.code, 'not_found');
      assert.equal(await workOrderCount(PID_A, 'Room 214'), 2);
    });

    test("a hotel's queue never carries another hotel's action", async () => {
      await offerWorkOrder(PID_A, 'Room 214', 2);
      const bId = await insertFinding(PID_B, 'location:Room 214');
      await insertWorkOrder(PID_B, 'Room 214');
      await insertWorkOrder(PID_B, 'Room 214');
      await proposeAction(PID_B, bId, {
        kind: 'create_work_order',
        params: createWorkOrderParams('Room 214'),
        verify: { location: 'Room 214', window_days: 30, open_work_orders: 2 },
      });

      const forA = await loadActionsForFindings(PID_A, [bId]);
      assert.equal(forA.size, 0, "hotel A asked for hotel B's finding and got nothing");
    });

    test('the auth door: no session at all is 401, not a work order', async () => {
      const { actionId } = await offerWorkOrder(PID_A, 'Room 214', 2);
      currentUser = null;
      const res = await ACTIONS_POST(
        new NextRequest('https://staxis.test/api/findings/actions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ propertyId: PID_A, actionId, intent: 'execute' }),
        }),
      );
      assert.equal(res.status, 401);
      assert.equal(await workOrderCount(PID_A, 'Room 214'), 2);
    });

    test('a malformed intent is refused before anything is touched', async () => {
      const { actionId } = await offerWorkOrder(PID_A, 'Room 214', 2);
      const res = await ACTIONS_POST(
        actionReq({ propertyId: PID_A, actionId, intent: 'delete_everything' }),
      );
      assert.equal(res.status, 400);
      assert.equal(await workOrderCount(PID_A, 'Room 214'), 2);
    });
  });

  // ═══ THE RUNNER ATTACHES IT, NOT THE DETECTOR ═══

  describe('the runner decides whether a plan becomes a button', () => {
    async function runProbe() {
      return runFindingsForProperty(PID_A, { ...ONLY_PROBE, now: new Date() });
    }

    async function actionsFor(dedupeKey: string) {
      const r = await pg.query<Record<string, unknown>>(
        `select a.* from public.finding_actions a
           join public.findings f on f.id = a.finding_id
          where f.property_id = $1 and f.dedupe_key = $2`,
        [PID_A, dedupeKey],
      );
      return r.rows;
    }

    test('a proposal gets its fix frozen on the night the card is written', async () => {
      probeDrafts = [probeDraft(2)];
      const summary = await runProbe();
      assert.equal(summary.actionsProposed, 1);

      const rows = await actionsFor('probe_hands:location:Room 214');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].state, 'proposed');
      assert.equal((rows[0].params as Record<string, unknown>).location, 'Room 214');
      assert.equal((rows[0].verify as Record<string, unknown>).open_work_orders, 2);
    });

    test('a draft the detector calls a recommendation gets NO button', async () => {
      probeDrafts = [probeDraft(0)];
      const summary = await runProbe();
      assert.equal(summary.actionsProposed, 0);
      assert.deepEqual(await actionsFor('probe_hands:location:Room 214'), []);
    });

    test('the RUNNER refuses to button a recommendation, even when the template offers one', async () => {
      // The eager probe's template always returns a plan. The only thing
      // standing between a recommendation and a button is the runner's own
      // disposition gate, which is what this exercises.
      eagerDrafts = [{ ...probeDraft(2), disposition: 'recommend' }];
      const summary = await runFindingsForProperty(PID_A, { ...ONLY_EAGER, now: new Date() });
      assert.equal(summary.actionsProposed, 0);
      assert.deepEqual(
        await actionsFor('probe_hands_eager:location:Room 214'),
        [],
        'a card that says it needs no decision must not be able to grow one',
      );
    });

    test('a second night on the same problem does not stack a second offer', async () => {
      probeDrafts = [probeDraft(2)];
      await runProbe();
      await runProbe();
      assert.equal((await actionsFor('probe_hands:location:Room 214')).length, 1);
    });

    test('a problem the manager silenced is never answered with a button', async () => {
      // Silenced BEFORE any offer existed, so what is being tested is the
      // runner's suppress gate and nothing else.
      const findingId = await insertFinding(PID_A, 'probe_hands_eager:location:Room 214', 2);
      await setFindingStatus(PID_A, findingId, 'known_problem', accountA);

      eagerDrafts = [probeDraft(2)];
      const summary = await runFindingsForProperty(PID_A, { ...ONLY_EAGER, now: new Date() });

      assert.equal(summary.findingsSuppressed, 1, 'the silence held');
      assert.equal(
        summary.actionsProposed,
        0,
        'answering "stop bringing this up" with a button is the loudest possible way to ignore it',
      );
      assert.deepEqual(await actionsFor('probe_hands_eager:location:Room 214'), []);
    });
  });

  // ═══ THE JUDGE ═══

  describe('the judge cannot add, remove or alter an attached action', () => {
    test('a judging pass leaves the action row byte-identical', async () => {
      const { findingId, actionId } = await offerWorkOrder(PID_A, 'Room 214', 2);
      const before = await actionRow(actionId);

      await persistJudgments(PID_A, [
        {
          id: findingId,
          disposition: 'recommend',
          en: 'A place that keeps breaking.',
          es: 'Un sitio que sigue fallando.',
          why: 'sorted down',
          rank: 1,
          source: 'model',
          model: 'test-model',
          inputHash: 'abc',
          guardRejected: false,
        },
      ]);

      assert.deepEqual(await actionRow(actionId), before, 'the judge moved something it may not');
    });

    test('a judging pass cannot CREATE an action for a finding that has none', async () => {
      const findingId = await insertFinding(PID_A, 'location:Room 999');
      await persistJudgments(PID_A, [
        {
          id: findingId,
          disposition: 'propose',
          en: 'x',
          es: 'y',
          why: 'z',
          rank: 1,
          source: 'model',
          model: 'test-model',
          inputHash: 'abc',
          guardRejected: false,
        },
      ]);
      const rows = await pg.query<{ n: number }>(
        `select count(*)::int n from public.finding_actions where finding_id=$1`,
        [findingId],
      );
      assert.equal(rows.rows[0].n, 0, 'the judge sorted a card up and no button appeared');
    });
  });

  // ═══ THE CARD ═══

  describe('the card the manager actually receives', () => {
    test('the offer and the button label are derived from the FROZEN plan, in both languages', async () => {
      await offerWorkOrder(PID_A, 'Room 214', 2);
      const res = await QUEUE_GET(
        new NextRequest(`https://staxis.test/api/findings?propertyId=${PID_A}`, {
          method: 'GET',
          headers: { authorization: 'Bearer hands-route-test-token' },
        }),
      );
      const body = (await res.json()) as {
        data: { findings: Array<{ action: Record<string, unknown> | null }> };
      };
      const action = body.data.findings.find((f) => f.action)?.action;
      assert.ok(action, 'the card arrived without its fix');
      assert.equal(action.state, 'proposed');
      assert.match(String(action.offerEn), /Room 214/);
      assert.match(String(action.offerEs), /Room 214/);
      assert.notEqual(String(action.offerEs), String(action.offerEn));
      assert.ok(String(action.labelEn).length > 0 && String(action.labelEs).length > 0);
    });

    test('after the tap the card carries the receipt, not the offer', async () => {
      const { actionId } = await offerWorkOrder(PID_A, 'Room 214', 2);
      await tap(PID_A, actionId);

      const res = await QUEUE_GET(
        new NextRequest(`https://staxis.test/api/findings?propertyId=${PID_A}`, {
          method: 'GET',
          headers: { authorization: 'Bearer hands-route-test-token' },
        }),
      );
      const body = (await res.json()) as {
        data: { findings: Array<{ action: Record<string, unknown> | null }> };
      };
      const action = body.data.findings.find((f) => f.action)?.action;
      assert.equal(action?.state, 'executed');
      assert.match(String(action?.receiptEn), /Room 214/);
      assert.match(String(action?.receiptEs), /Room 214/);
    });
  });
});
