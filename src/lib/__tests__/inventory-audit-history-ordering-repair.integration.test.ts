import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';
import { applyMigrationsToPgliteWithHook } from '../../../tests/fixtures/pglite-migrate';

const USER = 'a1000000-0000-4000-8000-000000000001';
const PROPERTY = 'a2000000-0000-4000-8000-000000000001';
const OTHER_PROPERTY = 'a2000000-0000-4000-8000-000000000002';

const COUNT_ITEM = 'a3000000-0000-4000-8000-000000000001';
const DELIVERY_ITEM = 'a3000000-0000-4000-8000-000000000002';
const ARCHIVE_ITEM = 'a3000000-0000-4000-8000-000000000003';
const SECOND_COUNT_ITEM = 'a3000000-0000-4000-8000-000000000004';
const CORRECT_ITEM = 'a3000000-0000-4000-8000-000000000005';
const OTHER_ITEM = 'a3000000-0000-4000-8000-000000000006';

const COUNT = 'a4000000-0000-4000-8000-000000000001';
const SECOND_COUNT = 'a4000000-0000-4000-8000-000000000002';
const CORRECT_COUNT = 'a4000000-0000-4000-8000-000000000003';
const OTHER_COUNT = 'a4000000-0000-4000-8000-000000000004';
const POST_REPAIR_COUNT = 'a4000000-0000-4000-8000-000000000005';

const COUNT_REQUEST = 'a5000000-0000-4000-8000-000000000001';
const SECOND_COUNT_REQUEST = 'a5000000-0000-4000-8000-000000000002';
const CORRECT_COUNT_REQUEST = 'a5000000-0000-4000-8000-000000000003';
const OTHER_COUNT_REQUEST = 'a5000000-0000-4000-8000-000000000004';
const POST_REPAIR_COUNT_REQUEST = 'a5000000-0000-4000-8000-000000000005';
const DELIVERY = 'a6000000-0000-4000-8000-000000000001';

const TIED_AT = '2026-06-01T10:00:00Z';
const CORRECT_AT = '2026-06-02T10:00:00Z';

type AuditRow = {
  id: string;
  action: string;
  sequence: string;
  details: Record<string, unknown>;
};

let pg: PGlite;
let applied: string[] = [];
let freshTieRows: AuditRow[] = [];
let badTieRows: AuditRow[] = [];
let correctGroupBeforeRepair: AuditRow[] = [];
let otherGroupBeforeRepair: AuditRow[] = [];
let sequenceSlotsBeforeRepair: string[] = [];
let maxSequenceBeforeRepair = '0';
let sequenceLastValueBeforeRepair = '0';
let eventCountBeforeRepair = 0;

async function rows(
  client: PGlite,
  sql: string,
  params: unknown[] = [],
): Promise<Array<Record<string, unknown>>> {
  const result = await client.query(sql, params) as { rows: Array<Record<string, unknown>> };
  return result.rows;
}

async function scalar<T>(client: PGlite, sql: string, params: unknown[] = []): Promise<T> {
  return Object.values((await rows(client, sql, params))[0] ?? {})[0] as T;
}

async function auditRowsAt(client: PGlite, propertyId: string, occurredAt: string): Promise<AuditRow[]> {
  return rows(
    client,
    `select e.id,e.action,e.sequence::text as sequence,e.details
     from public.inventory_audit_events e
     where e.property_id=$1 and e.occurred_at=$2::timestamptz
     order by e.sequence`,
    [propertyId, occurredAt],
  ) as Promise<AuditRow[]>;
}

function inferredBaseline(row: AuditRow): boolean {
  return row.action === 'item.created'
    && row.details.baseline === true
    && row.details.inferredOccurredAt === true;
}

function idSequence(rowsToSnapshot: AuditRow[]): Array<{ id: string; sequence: string }> {
  return rowsToSnapshot
    .map(({ id, sequence }) => ({ id, sequence }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

describe('inventory audit same-timestamp ordering repair', { concurrency: false }, () => {
  before(async () => {
    const migrated = await applyMigrationsToPgliteWithHook(async ({ pg: hookPg, file }) => {
      if (file === '0326_inventory_audit_history.sql') {
        await hookPg.query(
          `insert into auth.users(id,email) values ($1,'audit-ordering@example.test')`,
          [USER],
        );
        await hookPg.query(
          `insert into public.properties(id,owner_id,name,total_rooms,timezone)
           values ($1,$3,'Ordering Hotel',20,'UTC'),($2,$3,'Other Ordering Hotel',20,'UTC')`,
          [PROPERTY, OTHER_PROPERTY, USER],
        );

        const inventoryRows = [
          { id: COUNT_ITEM, propertyId: PROPERTY, name: 'Count towels', at: TIED_AT, countedAt: TIED_AT, archivedAt: null },
          { id: DELIVERY_ITEM, propertyId: PROPERTY, name: 'Delivery soap', at: TIED_AT, countedAt: null, archivedAt: null },
          { id: ARCHIVE_ITEM, propertyId: PROPERTY, name: 'Archived coffee', at: TIED_AT, countedAt: null, archivedAt: TIED_AT },
          { id: SECOND_COUNT_ITEM, propertyId: PROPERTY, name: 'Second count linen', at: TIED_AT, countedAt: TIED_AT, archivedAt: null },
          { id: CORRECT_ITEM, propertyId: PROPERTY, name: 'Already correct item', at: CORRECT_AT, countedAt: CORRECT_AT, archivedAt: null },
          { id: OTHER_ITEM, propertyId: OTHER_PROPERTY, name: 'Other hotel item', at: TIED_AT, countedAt: TIED_AT, archivedAt: null },
        ];

        await hookPg.query('alter table public.inventory disable trigger inventory_enforce_row_integrity');
        try {
          for (const item of inventoryRows) {
            await hookPg.query(
              `insert into public.inventory(
                 id,property_id,name,category,current_stock,par_level,unit,unit_cost,
                 created_by,created_at,updated_at,last_counted_at,archived_at,archived_by
               ) values ($1,$2,$3,'housekeeping',0,20,'each',2,$4,null,$5,$6,$7,$8)`,
              [
                item.id,
                item.propertyId,
                item.name,
                USER,
                item.at,
                item.countedAt,
                item.archivedAt,
                item.archivedAt ? USER : null,
              ],
            );
          }
        } finally {
          await hookPg.query('alter table public.inventory enable trigger inventory_enforce_row_integrity');
        }

        const countRows = [
          { id: COUNT, propertyId: PROPERTY, requestId: COUNT_REQUEST, itemId: COUNT_ITEM, name: 'Count towels', at: TIED_AT },
          { id: SECOND_COUNT, propertyId: PROPERTY, requestId: SECOND_COUNT_REQUEST, itemId: SECOND_COUNT_ITEM, name: 'Second count linen', at: TIED_AT },
          { id: CORRECT_COUNT, propertyId: PROPERTY, requestId: CORRECT_COUNT_REQUEST, itemId: CORRECT_ITEM, name: 'Already correct item', at: CORRECT_AT },
          { id: OTHER_COUNT, propertyId: OTHER_PROPERTY, requestId: OTHER_COUNT_REQUEST, itemId: OTHER_ITEM, name: 'Other hotel item', at: TIED_AT },
        ];
        for (const count of countRows) {
          await hookPg.query(
            `insert into public.inventory_counts(
               id,property_id,count_session_id,item_id,item_name,counted_stock,
               estimated_stock,variance,unit_cost,counted_at,counted_by
             ) values ($1,$2,$3,$4,$5,0,0,0,2,$6,'Ordering Manager')`,
            [count.id, count.propertyId, count.requestId, count.itemId, count.name, count.at],
          );
        }
        await hookPg.query(
          `insert into public.inventory_orders(
             id,property_id,item_id,item_name,quantity,unit_cost,total_cost,
             vendor_name,received_at,notes
           ) values ($1,$2,$3,'Delivery soap',2,2,4,'Ordering Vendor',$4,'Tied receipt')`,
          [DELIVERY, PROPERTY, DELIVERY_ITEM, TIED_AT],
        );
        return;
      }

      if (file !== '0327_inventory_audit_history_ordering_repair.sql') return;

      // Observe the corrected fresh-install 0326 result before deliberately
      // recreating the already-deployed 0326 ordering bug for the 0327 test.
      freshTieRows = await auditRowsAt(hookPg, PROPERTY, TIED_AT);

      await hookPg.query(`
        create temporary table staxis_test_bad_audit_order (
          id uuid primary key,
          old_sequence bigint not null unique,
          new_sequence bigint not null unique
        )
      `);
      await hookPg.query(
        `insert into staxis_test_bad_audit_order(id,old_sequence,new_sequence)
         with bad_rank as (
           select id,sequence as old_sequence,
             row_number() over (
               order by
                 case
                   when action='item.created'
                     and details @> '{"baseline":true,"inferredOccurredAt":true}'::jsonb
                   then 1 else 0
                 end,
                 sequence
             ) as slot
           from public.inventory_audit_events
           where property_id=$1 and occurred_at=$2::timestamptz
         ), slots as (
           select sequence as new_sequence,
             row_number() over (order by sequence) as slot
           from public.inventory_audit_events
           where property_id=$1 and occurred_at=$2::timestamptz
         )
         select b.id,b.old_sequence,s.new_sequence
         from bad_rank b join slots s using (slot)
         where b.old_sequence<>s.new_sequence`,
        [PROPERTY, TIED_AT],
      );
      await hookPg.query('alter table public.inventory_audit_events disable trigger inventory_audit_events_immutable');
      await hookPg.query(
        `update public.inventory_audit_events e set sequence=-m.old_sequence
         from staxis_test_bad_audit_order m where e.id=m.id`,
      );
      await hookPg.query(
        `update public.inventory_audit_events e set sequence=m.new_sequence
         from staxis_test_bad_audit_order m where e.id=m.id`,
      );
      await hookPg.query('alter table public.inventory_audit_events enable trigger inventory_audit_events_immutable');
      await hookPg.query('drop table staxis_test_bad_audit_order');

      badTieRows = await auditRowsAt(hookPg, PROPERTY, TIED_AT);
      correctGroupBeforeRepair = await auditRowsAt(hookPg, PROPERTY, CORRECT_AT);
      otherGroupBeforeRepair = await auditRowsAt(hookPg, OTHER_PROPERTY, TIED_AT);
      sequenceSlotsBeforeRepair = (await rows(
        hookPg,
        `select e.sequence::text as sequence
         from public.inventory_audit_events e order by e.sequence`,
      )).map((row) => String(row.sequence));
      maxSequenceBeforeRepair = await scalar<string>(
        hookPg,
        `select max(sequence)::text from public.inventory_audit_events`,
      );
      sequenceLastValueBeforeRepair = await scalar<string>(
        hookPg,
        `select last_value::text from public.inventory_audit_event_sequence`,
      );
      eventCountBeforeRepair = Number(await scalar<number>(
        hookPg,
        `select count(*) from public.inventory_audit_events`,
      ));
    });

    pg = migrated.pg;
    applied = migrated.report.applied;
    assert.deepEqual(
      migrated.report.failedAtRuntime.filter((entry) => /^032[67]_/.test(entry.file)),
      [],
    );
  });

  after(async () => pg.close());

  test('0326 gives every inferred baseline a lower same-timestamp sequence on fresh install', () => {
    const firstEvidence = freshTieRows.findIndex((row) => !inferredBaseline(row));
    const lastBaseline = freshTieRows.findLastIndex(inferredBaseline);
    assert.equal(freshTieRows.filter(inferredBaseline).length, 4);
    assert.ok(firstEvidence > 0);
    assert.ok(lastBaseline < firstEvidence, JSON.stringify(freshTieRows));
    assert.deepEqual(
      freshTieRows.filter((row) => !inferredBaseline(row)).map((row) => row.action).sort(),
      ['count.saved', 'count.saved', 'delivery.received', 'item.archived'].sort(),
    );
  });

  test('0327 repairs a deployed bad stable partition including multiple baselines', async () => {
    assert.ok(applied.includes('0327_inventory_audit_history_ordering_repair.sql'));

    const firstBadBaseline = badTieRows.findIndex(inferredBaseline);
    const lastBadEvidence = badTieRows.findLastIndex((row) => !inferredBaseline(row));
    assert.ok(
      lastBadEvidence < firstBadBaseline,
      `fixture must reproduce evidence-before-baseline ascending sequence: ${JSON.stringify(badTieRows)}`,
    );

    const repaired = await auditRowsAt(pg, PROPERTY, TIED_AT);
    const firstEvidence = repaired.findIndex((row) => !inferredBaseline(row));
    const lastBaseline = repaired.findLastIndex(inferredBaseline);
    assert.equal(repaired.filter(inferredBaseline).length, 4);
    assert.ok(lastBaseline < firstEvidence, JSON.stringify(repaired));
    assert.deepEqual(
      repaired.filter((row) => !inferredBaseline(row)).map((row) => row.action),
      freshTieRows.filter((row) => !inferredBaseline(row)).map((row) => row.action),
      'repair must preserve evidence relative order',
    );
  });

  test('0327 reuses the same slots and leaves already-correct and other-property groups unchanged', async () => {
    const slotsAfter = (await rows(
      pg,
      `select e.sequence::text as sequence
       from public.inventory_audit_events e order by e.sequence`,
    )).map((row) => String(row.sequence));
    assert.deepEqual(slotsAfter, sequenceSlotsBeforeRepair);
    assert.equal(
      await scalar<string>(pg, `select max(sequence)::text from public.inventory_audit_events`),
      maxSequenceBeforeRepair,
    );
    assert.equal(
      await scalar<string>(pg, `select last_value::text from public.inventory_audit_event_sequence`),
      sequenceLastValueBeforeRepair,
    );
    assert.equal(
      Number(await scalar<number>(pg, `select count(*) from public.inventory_audit_events`)),
      eventCountBeforeRepair,
    );
    assert.deepEqual(
      idSequence(await auditRowsAt(pg, PROPERTY, CORRECT_AT)),
      idSequence(correctGroupBeforeRepair),
    );
    assert.deepEqual(
      idSequence(await auditRowsAt(pg, OTHER_PROPERTY, TIED_AT)),
      idSequence(otherGroupBeforeRepair),
    );
  });

  test('sequence cursor pages repaired history once and in descending evidence-first order', async () => {
    const expected = (await rows(
      pg,
      `select id from public.inventory_audit_events where property_id=$1 order by sequence desc`,
      [PROPERTY],
    )).map((row) => String(row.id));

    await pg.query(`select set_config('request.jwt.claim.role','service_role',false)`);
    const seen: string[] = [];
    let beforeSequence: string | null = null;
    try {
      for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
        const page: Record<string, unknown> = await scalar<Record<string, unknown>>(
          pg,
          `select public.staxis_list_inventory_audit_events($1,$2::bigint,2,false)`,
          [PROPERTY, beforeSequence],
        );
        const events = page.events as Array<{ id: string }>;
        seen.push(...events.map((event) => event.id));
        beforeSequence = typeof page.nextSequence === 'string' ? page.nextSequence : null;
        if (!beforeSequence) break;
      }
    } finally {
      await pg.query(`select set_config('request.jwt.claim.role','authenticated',false)`);
    }

    assert.deepEqual(seen, expected);
    assert.equal(new Set(seen).size, seen.length);

    const repairedDescending = (await auditRowsAt(pg, PROPERTY, TIED_AT)).reverse();
    const lastEvidence = repairedDescending.findLastIndex((row) => !inferredBaseline(row));
    const firstBaseline = repairedDescending.findIndex(inferredBaseline);
    assert.ok(lastEvidence < firstBaseline, JSON.stringify(repairedDescending));
  });

  test('immutability is restored and the next append advances above the unchanged maximum', async () => {
    assert.equal(
      await scalar<string>(
        pg,
        `select tgenabled::text from pg_trigger
         where tgrelid='public.inventory_audit_events'::regclass
           and tgname='inventory_audit_events_immutable' and not tgisinternal`,
      ),
      'O',
    );

    const eventId = await scalar<string>(
      pg,
      `select id from public.inventory_audit_events where property_id=$1 order by sequence limit 1`,
      [PROPERTY],
    );
    await assert.rejects(
      pg.query(`update public.inventory_audit_events set sequence=sequence+1000 where id=$1`, [eventId]),
      /immutable|23514/i,
    );

    await pg.query(
      `insert into public.inventory_counts(
         id,property_id,count_session_id,item_id,item_name,counted_stock,
         estimated_stock,variance,unit_cost,counted_at,counted_by
       ) values ($1,$2,$3,$4,'Already correct item',1,0,1,2,
         '2026-06-03T10:00:00Z','Ordering Manager')`,
      [POST_REPAIR_COUNT, PROPERTY, POST_REPAIR_COUNT_REQUEST, CORRECT_ITEM],
    );
    const nextSequence = await scalar<string>(
      pg,
      `select sequence::text from public.inventory_audit_events
       where action='count.saved' and entity_id=$1`,
      [POST_REPAIR_COUNT],
    );
    assert.ok(BigInt(nextSequence) > BigInt(maxSequenceBeforeRepair));
  });
});
