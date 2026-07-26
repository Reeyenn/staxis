/**
 * THE EQUIPMENT LIST, END TO END, against a real Postgres holding two hotels.
 *
 * Three things are proved here, and only a database can prove any of them:
 *
 *  1. THE LIST ITSELF. Create, read, edit, delete through the real routes, with
 *     the real auth gates — including the one that matters most on a delete: an
 *     asset's work orders are UNLINKED, never deleted. `work_orders.equipment_id`
 *     is ON DELETE SET NULL (0249), and a CASCADE typed there instead would
 *     silently destroy a hotel's maintenance history the first time somebody
 *     tidied up their registry. That is not a claim a mocked client can make.
 *
 *  2. THE CHIP. A pattern about a piece of equipment has to reach that asset's
 *     own detail sheet and no other, at that hotel and no other. `findings` is
 *     deny-all to anon AND authenticated (0360), so the property filter inside
 *     the store IS the tenant wall — there is no policy behind it to catch a
 *     forgotten `.eq`.
 *
 *  3. THE SUGGESTION LOOP, which is the part with a side effect. "You've written
 *     PTAC in 9 work orders" must appear only at the bar, only when nothing on
 *     the list matches, and a "yes" must leave behind exactly ONE asset — then
 *     never ask again. A "no" must leave behind none, and also never ask again.
 *     Every one of those is a statement about rows.
 *
 * THE LEAK IT HUNTS: hotel B's tickets say the same word as hotel A's, and hotel
 * B's rows carry `ZZLEAKB`. A missing hotel filter anywhere in the suggestion
 * read would not merely leak — it would change hotel A's ANSWER.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder';
// Local-dev/test break-glass: skips the trusted-device half of requireSession so
// these tests exercise the ROUTES' authorization, not the 2FA plumbing.
process.env.DISABLE_SERVER_2FA_ENFORCEMENT = 'true';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { NextRequest } from 'next/server';
import type { PGlite } from '@electric-sql/pglite';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { GET as equipmentList, POST as equipmentCreate } from '@/app/api/maintenance/equipment/route';
import {
  GET as equipmentDetail,
  PATCH as equipmentPatch,
  DELETE as equipmentDelete,
} from '@/app/api/maintenance/equipment/[id]/route';
import { GET as patternsForTarget } from '@/app/api/findings/for-target/route';
import {
  GET as dripQuestionGet,
  POST as dripQuestionPost,
} from '@/app/api/memory/question/route';
import { MIN_WORK_ORDERS_MENTIONING } from '@/lib/equipment/suggest';

import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';
import { createPglitePostgrest, loadCatalog } from '../../../tests/fixtures/postgrest-pglite';

// ─── Two hotels, four people ────────────────────────────────────────────────

const PID_A = 'aaaaaaaa-0000-4000-8000-00000000e901';
const PID_B = 'bbbbbbbb-0000-4000-8000-00000000e901';

const GM_A_UID = 'aaaaaaaa-0000-4000-8000-00000000e911';
const GM_B_UID = 'bbbbbbbb-0000-4000-8000-00000000e911';
const HOUSEKEEPER_UID = 'cccccccc-0000-4000-8000-00000000e911';
const STRANGER_UID = 'dddddddd-0000-4000-8000-00000000e911';

/** On every free-text column of every hotel-B row. */
const LEAK = 'ZZLEAKB';

let currentUser: string | null = GM_A_UID;
let pg: PGlite;

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);
const originalGetUser = supabaseAdmin.auth.getUser.bind(supabaseAdmin.auth);

// ─── Calling the real routes ────────────────────────────────────────────────

function get(url: string, opts: { auth?: boolean } = {}): NextRequest {
  return new NextRequest(`https://staxis.test${url}`, {
    method: 'GET',
    headers: opts.auth === false ? {} : { authorization: 'Bearer equipment-test-token' },
  });
}

function send(url: string, method: 'POST' | 'PATCH' | 'DELETE', body?: unknown): NextRequest {
  return new NextRequest(`https://staxis.test${url}`, {
    method,
    headers: { authorization: 'Bearer equipment-test-token', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

interface Envelope<T = Record<string, unknown>> {
  ok: boolean;
  error?: string;
  data?: T;
}

async function body<T>(res: Response): Promise<Envelope<T>> {
  return (await res.json()) as Envelope<T>;
}

async function createAsset(
  pid: string,
  fields: Record<string, unknown>,
): Promise<{ status: number; id?: string; error?: string }> {
  const res = await equipmentCreate(send('/api/maintenance/equipment', 'POST', { pid, ...fields }));
  const parsed = await body<{ id: string }>(res);
  return { status: res.status, id: parsed.data?.id, error: parsed.error };
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

// ─── Rows straight into Postgres, bypassing the app ─────────────────────────

async function workOrder(opts: {
  propertyId: string;
  description: string;
  equipmentId?: string | null;
  daysAgo?: number;
  room?: string;
}): Promise<string> {
  const r = await pg.query<{ id: string }>(
    `insert into work_orders (property_id, room_number, description, severity, status,
                              equipment_id, created_at)
     values ($1,$2,$3,'medium','submitted',$4, now() - make_interval(days => $5))
     returning id`,
    [
      opts.propertyId,
      opts.room ?? '101',
      opts.description,
      opts.equipmentId ?? null,
      opts.daysAgo ?? 3,
    ],
  );
  return r.rows[0].id;
}

async function insertEquipmentFinding(propertyId: string, equipmentId: string, summary: string) {
  const r = await pg.query<{ id: string }>(
    `insert into findings
       (property_id, detector_id, dedupe_key, summary, severity, disposition, status,
        receipt_query_id, evidence, magnitude)
     values ($1,'repeat_equipment_work_orders',$2,$3,'attention','recommend','open',
             'work_orders_by_equipment_60d',$4::jsonb,4)
     returning id`,
    [
      propertyId,
      `equipment:${equipmentId}`,
      summary,
      JSON.stringify({
        queryId: 'work_orders_by_equipment_60d',
        params: { equipment_id: equipmentId },
        values: {},
        basis: 'planted',
        target: { kind: 'equipment', value: equipmentId },
      }),
    ],
  );
  return r.rows[0].id;
}

async function assetRows(propertyId: string) {
  const r = await pg.query<{
    id: string; name: string; created_from: string; created_by_name: string | null;
  }>(
    `select id, name, created_from, created_by_name from equipment
      where property_id = $1 order by name`,
    [propertyId],
  );
  return r.rows;
}

async function ledgerRows(propertyId: string) {
  const r = await pg.query<{
    topic: string; category: string; status: string;
    suggested_equipment_name: string | null; equipment_id: string | null;
  }>(
    `select topic, category, status, suggested_equipment_name, equipment_id
       from agent_knowledge_questions where property_id = $1 order by topic`,
    [propertyId],
  );
  return r.rows;
}

/** The one question this hotel would be asked right now, through the route. */
async function askedQuestion(propertyId: string) {
  const res = await dripQuestionGet(get(`/api/memory/question?propertyId=${propertyId}`));
  const parsed = await body<{ question: { topic: string; category: string; en: string; es: string } | null }>(res);
  assert.equal(res.status, 200, `question GET failed: ${parsed.error}`);
  return parsed.data!.question;
}

async function answer(propertyId: string, topic: string, verdict: 'yes' | 'no') {
  const res = await dripQuestionPost(
    send('/api/memory/question', 'POST', { propertyId, topic, answer: verdict }),
  );
  return { status: res.status, ...(await body<{ recorded: boolean }>(res)) };
}

// ─── The suite ──────────────────────────────────────────────────────────────

describe('the equipment list', () => {
  before(async () => {
    const migrated = await applyMigrationsToPglite();
    pg = migrated.pg;
    const catalog = await loadCatalog(pg);
    const shim = createPglitePostgrest(pg, catalog);
    // @ts-expect-error installing the pglite-backed client on the singleton
    supabaseAdmin.from = shim.from;
    // @ts-expect-error installing the pglite-backed client on the singleton
    supabaseAdmin.rpc = shim.rpc;
    // @ts-expect-error minimal auth stub
    supabaseAdmin.auth.getUser = async () =>
      currentUser
        ? { data: { user: { id: currentUser, email: `${currentUser}@equipment.test` } }, error: null }
        : { data: { user: null }, error: { message: 'invalid token', status: 401, name: 'AuthApiError' } };

    for (const [uid, email] of [
      [GM_A_UID, 'gm.a@equipment.test'],
      [GM_B_UID, 'gm.b@equipment.test'],
      [HOUSEKEEPER_UID, 'hk.a@equipment.test'],
      [STRANGER_UID, 'nobody@equipment.test'],
    ] as const) {
      await pg.query('insert into auth.users (id, email) values ($1,$2) on conflict do nothing', [uid, email]);
    }
    for (const [pid, name] of [[PID_A, 'Hotel A'], [PID_B, `Hotel B ${LEAK}`]] as const) {
      await pg.query(
        `insert into properties (id, name, owner_id, total_rooms, timezone)
         values ($1,$2,$3,60,'America/Chicago') on conflict (id) do nothing`,
        [pid, name, GM_A_UID],
      );
    }
    await pg.query(
      `insert into accounts (username, password_hash, display_name, role, property_access, data_user_id)
       values ('eq.gm.a','x','Maria (GM)','general_manager',array[$1::uuid],$2),
              ('eq.gm.b','x','Bea (GM)','general_manager',array[$3::uuid],$4),
              ('eq.hk.a','x','Ana','housekeeping',array[$1::uuid],$5)`,
      [PID_A, GM_A_UID, PID_B, GM_B_UID, HOUSEKEEPER_UID],
    );
  });

  after(async () => {
    supabaseAdmin.from = originalFrom;
    supabaseAdmin.rpc = originalRpc;
    supabaseAdmin.auth.getUser = originalGetUser;
    // The WASM backend exits with status 100 if it is still open when the event
    // loop drains, which turns a green run red.
    await pg?.close();
  });

  beforeEach(async () => {
    currentUser = GM_A_UID;
    await pg.query('delete from findings');
    await pg.query('delete from agent_knowledge_questions');
    await pg.query('delete from agent_memory');
    await pg.query('delete from work_orders');
    await pg.query('delete from equipment');
    await pg.query('delete from complaints');
    await pg.query('delete from capability_overrides');
  });

  // ── 1. The list ─────────────────────────────────────────────────────────

  describe('a manager describes their own equipment', () => {
    test('create, list, read, edit, and the row remembers who put it there', async () => {
      const created = await createAsset(PID_A, {
        name: 'PTAC units',
        category: 'hvac',
        location: 'Rooms 201-240',
        installDate: '2019-06-15',
        notes: 'Forty units, original to the 2019 refit.',
      });
      assert.equal(created.status, 201, created.error);

      const listed = await body<{ equipment: Array<Record<string, unknown>> }>(
        await equipmentList(get(`/api/maintenance/equipment?pid=${PID_A}`)),
      );
      assert.equal(listed.data!.equipment.length, 1);
      assert.equal(listed.data!.equipment[0].name, 'PTAC units');
      assert.equal(listed.data!.equipment[0].location, 'Rooms 201-240');

      // Provenance (0368). A typed-in asset is 'manual' and carries the name of
      // the person who typed it — the whole basis on which this list is trusted.
      const rows = await assetRows(PID_A);
      assert.equal(rows[0].created_from, 'manual');
      assert.equal(rows[0].created_by_name, 'Maria (GM)');

      const patched = await equipmentPatch(
        send('/api/maintenance/equipment', 'PATCH', { pid: PID_A, status: 'degraded' }),
        params(created.id!),
      );
      assert.equal(patched.status, 200);

      const detail = await body<{ equipment: Record<string, unknown> }>(
        await equipmentDetail(
          get(`/api/maintenance/equipment/${created.id}?pid=${PID_A}`),
          params(created.id!),
        ),
      );
      assert.equal(detail.data!.equipment.status, 'degraded');
    });

    test('validation refuses a nameless or miscategorised asset', async () => {
      assert.equal((await createAsset(PID_A, { category: 'hvac' })).status, 400);
      assert.equal((await createAsset(PID_A, { name: '', category: 'hvac' })).status, 400);
      assert.equal((await createAsset(PID_A, { name: 'Boiler', category: 'spaceship' })).status, 400);
      assert.equal(
        (await createAsset(PID_A, { name: 'Boiler', category: 'hvac', installDate: 'someday' })).status,
        400,
      );
      assert.deepEqual(await assetRows(PID_A), []);
    });

    test('deleting an asset UNLINKS its work orders and destroys none of them', async () => {
      const created = await createAsset(PID_A, { name: 'Ice machine', category: 'appliance' });
      const wo = await workOrder({
        propertyId: PID_A, description: 'Ice machine leaking', equipmentId: created.id,
      });

      const res = await equipmentDelete(
        get(`/api/maintenance/equipment/${created.id}?pid=${PID_A}`),
        params(created.id!),
      );
      assert.equal(res.status, 200);
      assert.deepEqual(await assetRows(PID_A), []);

      // The ticket survives, unlinked. A CASCADE here would have quietly
      // deleted a hotel's maintenance history the first time they tidied up.
      const after = await pg.query<{ id: string; equipment_id: string | null }>(
        'select id, equipment_id from work_orders where id = $1', [wo],
      );
      assert.equal(after.rows.length, 1, 'deleting an asset destroyed a work order');
      assert.equal(after.rows[0].equipment_id, null);
    });
  });

  describe('the door', () => {
    test('no session is 401, never an empty list', async () => {
      currentUser = null;
      const res = await equipmentList(get(`/api/maintenance/equipment?pid=${PID_A}`, { auth: false }));
      assert.equal(res.status, 401);
    });

    test('a signed-in stranger with no account row cannot read or write', async () => {
      currentUser = STRANGER_UID;
      assert.equal((await equipmentList(get(`/api/maintenance/equipment?pid=${PID_A}`))).status, 403);
      assert.equal((await createAsset(PID_A, { name: 'X', category: 'hvac' })).status, 403);
    });

    test('by default any of the hotel’s own staff may log equipment, and a hotel can switch that off', async () => {
      // THE DEFAULT IS DELIBERATE and is the equipment list's whole premise:
      // equipment exists when the hotel puts it in, and the person who knows the
      // ice machine exists is usually not the GM. `manage_equipment` is granted
      // to every hotel role by default (ROLE_DEFAULTS), and a hotel that wants
      // it narrower says so on the Access tab.
      //
      // The half worth pinning is that the switch is REAL — a capability the
      // route reads but that nothing can ever deny would be a gate in name only.
      currentUser = HOUSEKEEPER_UID;
      const byDefault = await createAsset(PID_A, { name: 'Ice machine', category: 'appliance' });
      assert.equal(byDefault.status, 201, byDefault.error);

      await pg.query(
        `insert into capability_overrides (property_id, capability, role, allowed)
         values ($1,'manage_equipment','housekeeping',false)`,
        [PID_A],
      );
      const afterOptOut = await createAsset(PID_A, { name: 'Second machine', category: 'appliance' });
      assert.equal(afterOptOut.status, 403);
      // Reading is never gated on the capability — the list is a maintenance
      // screen everyone at the hotel works from.
      assert.equal((await equipmentList(get(`/api/maintenance/equipment?pid=${PID_A}`))).status, 200);
      assert.equal((await assetRows(PID_A)).length, 1);
    });

    test('a malformed hotel id is refused rather than falling through to everything', async () => {
      assert.equal((await equipmentList(get('/api/maintenance/equipment?pid=not-a-uuid'))).status, 400);
      assert.equal((await equipmentList(get('/api/maintenance/equipment'))).status, 400);
    });
  });

  describe('one hotel cannot see or touch another hotel’s equipment', () => {
    let assetB: string;

    beforeEach(async () => {
      currentUser = GM_B_UID;
      const created = await createAsset(PID_B, { name: `PTAC units ${LEAK}`, category: 'hvac' });
      assert.equal(created.status, 201, created.error);
      assetB = created.id!;
      currentUser = GM_A_UID;
    });

    test("hotel A's manager asking for hotel B's list is refused, and the body carries nothing of B's", async () => {
      const res = await equipmentList(get(`/api/maintenance/equipment?pid=${PID_B}`));
      assert.equal(res.status, 403);
      assert.ok(!JSON.stringify(await body(res)).includes(LEAK));
    });

    test("hotel A's own list is empty, not hotel B's", async () => {
      const listed = await body<{ equipment: unknown[] }>(
        await equipmentList(get(`/api/maintenance/equipment?pid=${PID_A}`)),
      );
      assert.deepEqual(listed.data!.equipment, []);
    });

    test("naming hotel B's asset under hotel A's id is a 404, not a read", async () => {
      // The id is real; the hotel is wrong. The store scopes by BOTH, so this
      // must not resolve — and must not leak B's name in the error either.
      const res = await equipmentDetail(
        get(`/api/maintenance/equipment/${assetB}?pid=${PID_A}`),
        params(assetB),
      );
      assert.equal(res.status, 404);
      assert.ok(!JSON.stringify(await body(res)).includes(LEAK));
    });

    test("hotel A cannot edit or delete hotel B's asset by id", async () => {
      const patched = await equipmentPatch(
        send('/api/maintenance/equipment', 'PATCH', { pid: PID_A, name: 'stolen' }),
        params(assetB),
      );
      assert.equal(patched.status, 404);

      const deleted = await equipmentDelete(
        get(`/api/maintenance/equipment/${assetB}?pid=${PID_A}`),
        params(assetB),
      );
      assert.equal(deleted.status, 404);

      const survived = await pg.query<{ name: string }>(
        'select name from equipment where id = $1', [assetB],
      );
      assert.equal(survived.rows.length, 1);
      assert.ok(survived.rows[0].name.includes(LEAK), "hotel B's asset was renamed by hotel A");
    });

    test("hotel B's own manager still sees hotel B's list — the wall is not a broken read", async () => {
      currentUser = GM_B_UID;
      const listed = await body<{ equipment: unknown[] }>(
        await equipmentList(get(`/api/maintenance/equipment?pid=${PID_B}`)),
      );
      assert.equal(listed.data!.equipment.length, 1);
    });
  });

  // ── 2. Attaching work orders, and the chip that follows ─────────────────

  describe('a work order against a piece of equipment', () => {
    test("the asset's own sheet shows its repair history and counts its failures", async () => {
      const created = await createAsset(PID_A, { name: 'PTAC units', category: 'hvac' });
      await workOrder({ propertyId: PID_A, description: 'PTAC in 214 dead', equipmentId: created.id, room: '214' });
      await workOrder({ propertyId: PID_A, description: 'PTAC in 227 dead', equipmentId: created.id, room: '227' });
      // An unattached ticket at the same hotel must not be counted as this
      // asset's history.
      await workOrder({ propertyId: PID_A, description: 'Lobby door sticking', room: 'Lobby' });

      const detail = await body<{
        history: Array<{ kind: string; detail: string | null }>;
        failureCount: number;
      }>(
        await equipmentDetail(
          get(`/api/maintenance/equipment/${created.id}?pid=${PID_A}`),
          params(created.id!),
        ),
      );
      assert.equal(detail.data!.failureCount, 2);
      assert.deepEqual(detail.data!.history.map((h) => h.detail).sort(), ['214', '227']);
    });

    test('a pattern about this asset puts a chip on this asset and no other', async () => {
      const ptac = await createAsset(PID_A, { name: 'PTAC units', category: 'hvac' });
      const pump = await createAsset(PID_A, { name: 'Pool pump', category: 'pool' });
      const findingId = await insertEquipmentFinding(
        PID_A, ptac.id!, 'PTAC units (installed 2019) has had 4 work orders in the last 60 days',
      );

      const onPtac = await body<{ findingIds: string[] }>(
        await patternsForTarget(
          get(`/api/findings/for-target?propertyId=${PID_A}&kind=equipment&value=${ptac.id}`),
        ),
      );
      assert.deepEqual(onPtac.data!.findingIds, [findingId]);

      const onPump = await body<{ findingIds: string[] }>(
        await patternsForTarget(
          get(`/api/findings/for-target?propertyId=${PID_A}&kind=equipment&value=${pump.id}`),
        ),
      );
      assert.deepEqual(onPump.data!.findingIds, []);
    });

    test('the chip is a signpost — the route sends no card content', async () => {
      const ptac = await createAsset(PID_A, { name: 'PTAC units', category: 'hvac' });
      await insertEquipmentFinding(PID_A, ptac.id!, 'four work orders on the PTAC batch');
      const res = await patternsForTarget(
        get(`/api/findings/for-target?propertyId=${PID_A}&kind=equipment&value=${ptac.id}`),
      );
      const parsed = await body<Record<string, unknown>>(res);
      assert.deepEqual(Object.keys(parsed.data!).sort(), ['findingIds', 'kind', 'value']);
      assert.ok(!JSON.stringify(parsed).includes('work orders'), 'card content travelled with the signpost');
    });

    test("an equipment pattern at hotel B never reaches hotel A's sheet", async () => {
      currentUser = GM_B_UID;
      const assetB = (await createAsset(PID_B, { name: `PTAC units ${LEAK}`, category: 'hvac' })).id!;
      await insertEquipmentFinding(PID_B, assetB, `B pattern ${LEAK}`);

      currentUser = GM_A_UID;
      // Hotel A's manager naming hotel B's asset id is refused outright, and
      // the refusal carries none of B's text.
      const res = await patternsForTarget(
        get(`/api/findings/for-target?propertyId=${PID_B}&kind=equipment&value=${assetB}`),
      );
      assert.equal(res.status, 403);
      assert.ok(!JSON.stringify(await body(res)).includes(LEAK));

      // And asking under their OWN hotel finds nothing, because the finding is
      // not theirs — the property filter, not the id, is what decides.
      const own = await body<{ findingIds: string[] }>(
        await patternsForTarget(
          get(`/api/findings/for-target?propertyId=${PID_A}&kind=equipment&value=${assetB}`),
        ),
      );
      assert.deepEqual(own.data!.findingIds, []);
    });
  });

  // ── 3. The suggestion loop ──────────────────────────────────────────────

  describe('Staxis offers to track a word the hotel keeps writing', () => {
    /** N tickets at hotel A, each mentioning `term` once. */
    async function ticketsMentioning(propertyId: string, term: string, howMany: number) {
      for (let i = 0; i < howMany; i += 1) {
        await workOrder({
          propertyId,
          description: `${term} in room ${200 + i}`,
          room: String(200 + i),
          daysAgo: 2 + i,
        });
      }
    }

    test('under the bar, nothing is asked', async () => {
      await ticketsMentioning(PID_A, 'PTAC', MIN_WORK_ORDERS_MENTIONING - 1);
      assert.equal(await askedQuestion(PID_A), null);
      assert.deepEqual(await ledgerRows(PID_A), []);
    });

    test('at the bar, the question appears in both languages and records the ask', async () => {
      await ticketsMentioning(PID_A, 'PTAC', 9);
      const question = await askedQuestion(PID_A);
      assert.ok(question, 'no question was offered at nine mentions');
      assert.equal(question!.category, 'equipment');
      assert.equal(question!.topic, 'equipment:ptac');
      assert.match(question!.en, /You've written "PTAC" in 9 work orders/);
      assert.match(question!.es, /Han escrito "PTAC" en 9 órdenes de trabajo/);

      // Serving it wrote the ask down — that write is what makes an ignored
      // question stay gone for the rest of the day.
      const ledger = await ledgerRows(PID_A);
      assert.equal(ledger.length, 1);
      assert.equal(ledger[0].status, 'asked');
      assert.equal(ledger[0].suggested_equipment_name, 'PTAC');
      assert.equal(ledger[0].equipment_id, null);
    });

    test('a hotel that already tracks it is never asked to track it again', async () => {
      await ticketsMentioning(PID_A, 'PTAC', 9);
      await createAsset(PID_A, { name: 'PTAC units — rooms 201-240', category: 'hvac' });
      assert.equal(await askedQuestion(PID_A), null);
    });

    test('ONE TAP creates exactly one asset, and the question never comes back', async () => {
      await ticketsMentioning(PID_A, 'PTAC', 9);
      const question = await askedQuestion(PID_A);
      assert.ok(question);

      const said = await answer(PID_A, question!.topic, 'yes');
      assert.equal(said.status, 200, said.error);
      assert.equal(said.data!.recorded, true);

      // Exactly one asset, named as the hotel writes it, marked as having come
      // from the offer rather than from a form — and attributed to the manager
      // whose tap made it real.
      const assets = await assetRows(PID_A);
      assert.equal(assets.length, 1);
      assert.equal(assets[0].name, 'PTAC');
      assert.equal(assets[0].created_from, 'suggestion');
      assert.equal(assets[0].created_by_name, 'Maria (GM)');

      // The ledger records what the answer produced.
      const ledger = await ledgerRows(PID_A);
      assert.equal(ledger[0].status, 'answered_yes');
      assert.equal(ledger[0].equipment_id, assets[0].id);

      // And it is never offered again — twice over: the ledger says answered,
      // and the hotel now has a matching entry.
      assert.equal(await askedQuestion(PID_A), null);
      assert.equal((await assetRows(PID_A)).length, 1, 'a second asset appeared');
    });

    test('a "yes" writes an asset and NOT a remembered fact — one record, not two', async () => {
      await ticketsMentioning(PID_A, 'PTAC', 9);
      const question = await askedQuestion(PID_A);
      await answer(PID_A, question!.topic, 'yes');

      // The equipment row IS the record. A memory sentence saying the same
      // thing would be a second copy with its own way of going stale — the
      // manager deletes the asset and the copilot goes on insisting it exists.
      const memory = await pg.query(
        `select 1 from agent_memory where property_id = $1 and topic = $2`,
        [PID_A, 'equipment:ptac'],
      );
      assert.equal(memory.rows.length, 0);
    });

    test('a replayed tap does not create a second asset', async () => {
      await ticketsMentioning(PID_A, 'PTAC', 9);
      const question = await askedQuestion(PID_A);
      const first = await answer(PID_A, question!.topic, 'yes');
      const replay = await answer(PID_A, question!.topic, 'yes');

      assert.equal(first.data!.recorded, true);
      // The second tap finds the question already claimed and does nothing.
      assert.equal(replay.status, 200);
      assert.equal(replay.data!.recorded, false);
      assert.equal((await assetRows(PID_A)).length, 1);
    });

    test('"no" creates nothing, and the question is never asked again', async () => {
      await ticketsMentioning(PID_A, 'PTAC', 9);
      const question = await askedQuestion(PID_A);
      const said = await answer(PID_A, question!.topic, 'no');
      assert.equal(said.status, 200);
      assert.equal(said.data!.recorded, true);

      assert.deepEqual(await assetRows(PID_A), []);
      const ledger = await ledgerRows(PID_A);
      assert.equal(ledger[0].status, 'declined');
      assert.equal(ledger[0].equipment_id, null);

      // The decline is the promise this whole surface is judged on: the tickets
      // are all still there, and it is still never asked again.
      assert.equal(await askedQuestion(PID_A), null);
    });

    test('a housekeeper is never shown the offer, and cannot answer one', async () => {
      await ticketsMentioning(PID_A, 'PTAC', 9);
      currentUser = HOUSEKEEPER_UID;
      // A passive screen must not shout at the people it is not for: no card,
      // and no 403 either — they have done nothing wrong by opening /feed.
      assert.equal(await askedQuestion(PID_A), null);
      const said = await answer(PID_A, 'equipment:ptac', 'yes');
      assert.equal(said.status, 403);
      assert.deepEqual(await assetRows(PID_A), []);
    });

    test("hotel B's tickets never become hotel A's question", async () => {
      // Hotel B is LOUDER on purpose: a missing hotel filter would not merely
      // leak, it would change hotel A's answer from "nothing" to "BOILER".
      await ticketsMentioning(PID_B, `BOILER${LEAK}`, 12);
      await ticketsMentioning(PID_A, 'PTAC', MIN_WORK_ORDERS_MENTIONING - 1);

      assert.equal(await askedQuestion(PID_A), null);

      currentUser = GM_B_UID;
      const bQuestion = await askedQuestion(PID_B);
      assert.ok(bQuestion, "hotel B's own question went missing");
      assert.match(bQuestion!.en, /BOILER/);

      // Answering it creates an asset at hotel B and nowhere else.
      await answer(PID_B, bQuestion!.topic, 'yes');
      assert.equal((await assetRows(PID_B)).length, 1);
      assert.deepEqual(await assetRows(PID_A), []);
    });
  });
});
