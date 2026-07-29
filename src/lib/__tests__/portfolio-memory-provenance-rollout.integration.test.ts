import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyMigrationsToPgliteWithHook } from '../../../tests/fixtures/pglite-migrate';

const OWNER = '83000000-0000-4000-8000-000000000001';
const PROPERTY = '83000000-0000-4000-8000-000000000002';
const ACQUIRING_ORG = '83000000-0000-4000-8000-000000000003';
const LEGACY_MEMORY = '83000000-0000-4000-8000-000000000004';
const CURRENT_MEMORY = '83000000-0000-4000-8000-000000000005';

test('0385 does not relabel unprovable pre-migration hotel memory as the acquiring company', async () => {
  let seeded = false;
  const migrated = await applyMigrationsToPgliteWithHook(async ({ pg, file, report }) => {
    if (file !== '0385_agent_memory_organization_provenance.sql') return;
    assert.ok(report.applied.includes('0384_admin_hotel_relationship_lifecycle.sql'));

    await pg.query(
      `insert into auth.users(id,email) values ($1,'memory-rollout@example.test')`,
      [OWNER],
    );
    await pg.query(
      `insert into public.properties(id,owner_id,name,total_rooms,timezone)
       values ($1,$2,'Transferred memory hotel',40,'America/Chicago')`,
      [PROPERTY, OWNER],
    );
    await pg.query(
      `insert into public.organizations(id,name,organization_type,status)
       values ($1,'Acquiring Company','management_company','active')`,
      [ACQUIRING_ORG],
    );

    // A newly inserted property is reconciled to an independent single-hotel
    // anchor by 0325. Model an acquisition before 0385: close that anchor and
    // make the acquiring company the current primary operator.
    await pg.query(
      `update public.organization_property_relationships
          set is_primary_grouping=false, ends_at=clock_timestamp()
        where property_id=$1 and is_primary_grouping and ends_at is null`,
      [PROPERTY],
    );
    await pg.query(
      `insert into public.organization_property_relationships
         (organization_id,property_id,relationship_type,is_primary_grouping)
       values ($1,$2,'operator',true)`,
      [ACQUIRING_ORG, PROPERTY],
    );
    await pg.query(
      `insert into public.agent_memory
         (id,property_id,scope,topic,content,source,confidence,
          category,review_state,is_active)
       values ($1,$2,'property','legacy_vendor','Use FormerCo vendor ZZOLD',
               'explicit_user','normal','vendors','confirmed',true)`,
      [LEGACY_MEMORY, PROPERTY],
    );
    seeded = true;
  });

  try {
    assert.equal(seeded, true);
    const failure = migrated.report.failedAtRuntime.find(
      (entry) => entry.file === '0385_agent_memory_organization_provenance.sql',
    );
    assert.equal(failure, undefined, failure?.error);
    assert.ok(migrated.report.applied.includes('0385_agent_memory_organization_provenance.sql'));

    const legacy = await migrated.pg.query<{ authoring_organization_id: string | null }>(
      `select authoring_organization_id::text
         from public.agent_memory where id=$1`,
      [LEGACY_MEMORY],
    );
    assert.equal(legacy.rows[0]?.authoring_organization_id, null);

    const hidden = await migrated.pg.query<{ count: string }>(
      `select count(*)::text
         from public.staxis_portfolio_property_knowledge(
           $1, array[$2]::uuid[], clock_timestamp(), 1001
         )`,
      [ACQUIRING_ORG, PROPERTY],
    );
    assert.equal(hidden.rows[0]?.count, '0');

    await migrated.pg.query(
      `insert into public.agent_memory
         (id,property_id,scope,topic,content,source,confidence,
          category,review_state,is_active)
       values ($1,$2,'property','current_vendor','Use AcquiringCo vendor',
               'explicit_user','normal','vendors','confirmed',true)`,
      [CURRENT_MEMORY, PROPERTY],
    );
    const current = await migrated.pg.query<{
      id: string;
      authoring_organization_id: string | null;
    }>(
      `select id::text,authoring_organization_id::text
         from public.staxis_portfolio_property_knowledge(
           $1, array[$2]::uuid[], clock_timestamp(), 1001
         )`,
      [ACQUIRING_ORG, PROPERTY],
    );
    assert.deepEqual(current.rows, [{
      id: CURRENT_MEMORY,
      authoring_organization_id: ACQUIRING_ORG,
    }]);
  } finally {
    await migrated.pg.close();
  }
});
