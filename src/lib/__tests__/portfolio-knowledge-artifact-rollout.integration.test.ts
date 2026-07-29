import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyMigrationsToPgliteWithHook } from '../../../tests/fixtures/pglite-migrate';
import {
  ACCOUNT_MARIA,
  ORG_A,
  PID_A1,
  seedTwoCompanies,
} from '../../../tests/fixtures/pglite-two-company-seed';

const LEGACY_RECEIPT = 'aef00000-0000-4000-8000-000000000001';
const LEGACY_SCOPE_RECEIPT = 'aef00000-0000-4000-8000-000000000002';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const LEGACY_FINDING_VERSIONS = {
  status: 'historical_unvalidated_projection',
  opaque: 'x'.repeat(70_000),
};

test('0403 labels pre-0397 unbound receipts without forging model provenance', async () => {
  let seeded = false;
  let findingBefore: { bytes: number; hash: string } | undefined;
  const migrated = await applyMigrationsToPgliteWithHook(async ({ pg, file, report }) => {
    if (file !== '0403_deterministic_portfolio_knowledge_artifacts.sql') return;
    assert.ok(report.applied.includes('0397_portfolio_model_request_artifacts.sql'));
    await seedTwoCompanies(pg);

    // This is the state a legitimate 0378–0396 receipt has after 0397 was
    // deployed: the new artifact columns are NULL. Disable only the post-0397
    // insertion guard to reproduce that historical row; 0403 must migrate it
    // without inventing a provider request that never happened.
    await pg.exec(
      'alter table public.portfolio_query_receipts disable trigger portfolio_query_receipts_bind_request_artifact',
    );
    await pg.query(
      `insert into public.portfolio_query_receipts (
         id, property_id, organization_id, account_id, conversation_id,
         scope_receipt_id, authorization_hash, scope_hash, question_hash,
         query_plan_version, evidence_version, prompt_version, prompt_hash,
         model_id, model_tier, request_artifact_id, model_candidate_hash,
         presentation_plan_version, renderer_version,
         authorized_property_ids, selected_property_ids, metric_versions,
         source_versions, knowledge_versions, finding_versions, plan, evidence,
         answer_hash, status, duration_ms, generated_at
       ) values (
         $1, $2, $3, $4, null, $5, $6, $7, $8,
         'portfolio-query-plan.v1', 'portfolio-evidence.v1',
         'portfolio-intelligence.v1', null,
         null, null, null, null, null, null,
         array[$2]::uuid[], array[$2]::uuid[], '{}'::jsonb,
         '[]'::jsonb, '{}'::jsonb, $9::jsonb, '{}'::jsonb, '{}'::jsonb,
         null, 'abstained', 0, clock_timestamp()
       )`,
      [
        LEGACY_RECEIPT,
        PID_A1,
        ORG_A,
        ACCOUNT_MARIA,
        LEGACY_SCOPE_RECEIPT,
        HASH_A,
        HASH_B,
        HASH_C,
        JSON.stringify(LEGACY_FINDING_VERSIONS),
      ],
    );
    const before = await pg.query<{ bytes: number; hash: string }>(
      `select octet_length(finding_versions::text) as bytes,
              encode(public.digest(
                convert_to(finding_versions::text, 'UTF8'), 'sha256'
              ), 'hex') as hash
         from public.portfolio_query_receipts where id = $1`,
      [LEGACY_RECEIPT],
    );
    findingBefore = before.rows[0];
    assert.ok(findingBefore.bytes > 65_536 && findingBefore.bytes < 262_144);
    await pg.exec(
      'alter table public.portfolio_query_receipts enable trigger portfolio_query_receipts_bind_request_artifact',
    );
    seeded = true;
  });

  try {
    const failure = migrated.report.failedAtRuntime.find(
      (entry) => entry.file === '0403_deterministic_portfolio_knowledge_artifacts.sql',
    );
    assert.equal(failure, undefined, failure?.error);
    assert.equal(seeded, true);
    assert.ok(
      migrated.report.applied.includes('0403_deterministic_portfolio_knowledge_artifacts.sql'),
    );

    const legacy = await migrated.pg.query<{
      receipt_kind: string;
      finding_binding_status: string;
      finding_bytes: number;
      finding_hash: string;
      request_artifact_id: string | null;
      knowledge_artifact_id: string | null;
    }>(
      `select receipt_kind, finding_binding_status,
              octet_length(finding_versions::text) as finding_bytes,
              encode(public.digest(
                convert_to(finding_versions::text, 'UTF8'), 'sha256'
              ), 'hex') as finding_hash,
              request_artifact_id::text, knowledge_artifact_id::text
         from public.portfolio_query_receipts where id = $1`,
      [LEGACY_RECEIPT],
    );
    assert.deepEqual(legacy.rows, [{
      receipt_kind: 'legacy_unbound',
      finding_binding_status: 'legacy_unbound',
      finding_bytes: findingBefore?.bytes,
      finding_hash: findingBefore?.hash,
      request_artifact_id: null,
      knowledge_artifact_id: null,
    }]);
    const artifacts = await migrated.pg.query<{ count: string }>(
      'select count(*)::text as count from public.portfolio_model_request_artifacts',
    );
    assert.equal(artifacts.rows[0]?.count, '0');
    const knowledgeAcl = await migrated.pg.query<{
      anon_select: boolean;
      authenticated_select: boolean;
      service_select: boolean;
      service_insert: boolean;
      service_update: boolean;
      service_delete: boolean;
    }>(
      `select
         has_table_privilege('anon', 'public.portfolio_knowledge_request_artifacts', 'select')
           as anon_select,
         has_table_privilege('authenticated', 'public.portfolio_knowledge_request_artifacts', 'select')
           as authenticated_select,
         has_table_privilege('service_role', 'public.portfolio_knowledge_request_artifacts', 'select')
           as service_select,
         has_table_privilege('service_role', 'public.portfolio_knowledge_request_artifacts', 'insert')
           as service_insert,
         has_table_privilege('service_role', 'public.portfolio_knowledge_request_artifacts', 'update')
           as service_update,
         has_table_privilege('service_role', 'public.portfolio_knowledge_request_artifacts', 'delete')
           as service_delete`,
    );
    assert.deepEqual(knowledgeAcl.rows[0], {
      anon_select: false,
      authenticated_select: false,
      service_select: true,
      service_insert: true,
      service_update: false,
      service_delete: false,
    });
    const immutableAcl = await migrated.pg.query<{
      table_name: string;
      anon_select: boolean;
      authenticated_select: boolean;
      service_select: boolean;
      service_insert: boolean;
      service_update: boolean;
      service_delete: boolean;
    }>(
      `select table_name,
              has_table_privilege('anon', 'public.' || table_name, 'select')
                as anon_select,
              has_table_privilege('authenticated', 'public.' || table_name, 'select')
                as authenticated_select,
              has_table_privilege('service_role', 'public.' || table_name, 'select')
                as service_select,
              has_table_privilege('service_role', 'public.' || table_name, 'insert')
                as service_insert,
              has_table_privilege('service_role', 'public.' || table_name, 'update')
                as service_update,
              has_table_privilege('service_role', 'public.' || table_name, 'delete')
                as service_delete
         from (values
           ('portfolio_model_request_artifacts'),
           ('portfolio_knowledge_request_artifacts'),
           ('portfolio_query_receipts'),
           ('portfolio_query_turn_commits')
         ) immutable(table_name)
        order by table_name`,
    );
    assert.deepEqual(immutableAcl.rows, [
      'portfolio_knowledge_request_artifacts',
      'portfolio_model_request_artifacts',
      'portfolio_query_receipts',
      'portfolio_query_turn_commits',
    ].map((table_name) => ({
      table_name,
      anon_select: false,
      authenticated_select: false,
      service_select: true,
      service_insert: table_name !== 'portfolio_query_turn_commits',
      service_update: false,
      service_delete: false,
    })));

    const helperAcl = await migrated.pg.query<{
      routine: string;
      anon_execute: boolean;
      authenticated_execute: boolean;
    }>(
      `select routine,
              has_function_privilege('anon', routine, 'execute') as anon_execute,
              has_function_privilege('authenticated', routine, 'execute')
                as authenticated_execute
         from (values
           ('public._staxis_jsonb_exact_keys(jsonb,text[])'),
           ('public._staxis_jsonb_canonical_text(jsonb)'),
           ('public._staxis_jsonb_bounded_integer(jsonb,numeric,numeric)'),
           ('public._staxis_jsonb_identifier_or_null(jsonb,boolean)'),
           ('public._staxis_portfolio_finding_claim_array_ok(jsonb,integer)'),
           ('public._staxis_portfolio_finding_summary_total(jsonb,integer,numeric)'),
           ('public._staxis_portfolio_finding_instant_ok(jsonb)'),
           ('public._staxis_portfolio_finding_producer_ok(jsonb,text,uuid,uuid,uuid,text,text,integer,integer)'),
           ('public._staxis_portfolio_finding_receipt_ok(jsonb,uuid,uuid,uuid,text,text,integer,integer)'),
           ('public._staxis_portfolio_finding_plan_matches(jsonb,jsonb)'),
           ('public._staxis_portfolio_knowledge_claim_scope_ok(jsonb,uuid,uuid)'),
           ('public.staxis_validate_portfolio_knowledge_artifact()'),
           ('public.staxis_validate_portfolio_model_finding_receipt()'),
           ('public.staxis_bind_portfolio_query_receipt_artifact()'),
           ('public.staxis_purge_expired_portfolio_records(timestamptz,timestamptz,integer)')
         ) helpers(routine)
        order by routine`,
    );
    assert.equal(helperAcl.rows.length, 15);
    assert.ok(helperAcl.rows.every((row) => (
      row.anon_execute === false && row.authenticated_execute === false
    )));

    const findingBound = await migrated.pg.query<{ definition: string }>(
      `select pg_get_constraintdef(oid) as definition
         from pg_constraint
        where conrelid = 'public.portfolio_query_receipts'::regclass
          and conname = 'portfolio_query_receipts_provenance_check'`,
    );
    assert.equal(findingBound.rows.length, 1);
    assert.match(
      findingBound.rows[0].definition.replace(/\s+/g, ' '),
      /finding_binding_status.*legacy_unbound.*262144.*validated.*65536/i,
    );

    // Legacy is a migration-only label. No new row may use it, and omitting
    // the kind defaults to model_metric which independently requires a real
    // immutable provider artifact.
    const newReceiptSql = `insert into public.portfolio_query_receipts (
         property_id, organization_id, account_id, conversation_id,
         scope_receipt_id, authorization_hash, scope_hash, question_hash,
         query_plan_version, evidence_version, prompt_version,
         authorized_property_ids, selected_property_ids, metric_versions,
         source_versions, knowledge_versions, finding_versions, plan, evidence,
         status, duration_ms, receipt_kind, finding_binding_status
       ) values (
         $1, $2, $3, null, $4, $5, $6, $7,
         'portfolio-query-plan.v1', 'portfolio-evidence.v1',
         'portfolio-intelligence.v1', array[$1]::uuid[], array[$1]::uuid[],
         '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, $8::jsonb,
         '{}'::jsonb, '{}'::jsonb, 'abstained', 0, $9, $10
       )`;
    await assert.rejects(
      migrated.pg.query(newReceiptSql, [
        PID_A1,
        ORG_A,
        ACCOUNT_MARIA,
        'aef00000-0000-4000-8000-000000000003',
        HASH_A,
        HASH_B,
        HASH_C,
        '{}',
        'legacy_unbound',
        'legacy_unbound',
      ]),
      /require validated finding provenance/i,
    );
    await assert.rejects(
      migrated.pg.query(newReceiptSql, [
        PID_A1,
        ORG_A,
        ACCOUNT_MARIA,
        'aef00000-0000-4000-8000-000000000004',
        HASH_A,
        HASH_B,
        HASH_C,
        '{}',
        'model_metric',
        'validated',
      ]),
      /requires exactly one model request artifact/i,
    );

    // Prove the validated branch really enforces 64 KiB independently of the
    // semantic trigger. The trigger is disabled only inside this owner-level
    // migration test; the row still has to satisfy every table constraint.
    await migrated.pg.exec(
      'alter table public.portfolio_query_receipts disable trigger portfolio_query_receipts_bind_request_artifact',
    );
    try {
      await assert.rejects(
        migrated.pg.query(newReceiptSql, [
          PID_A1,
          ORG_A,
          ACCOUNT_MARIA,
          'aef00000-0000-4000-8000-000000000005',
          HASH_A,
          HASH_B,
          HASH_C,
          JSON.stringify({ status: 'oversized', opaque: 'x'.repeat(70_000) }),
          'legacy_unbound',
          'validated',
        ]),
        /portfolio_query_receipts_provenance_check/i,
      );
    } finally {
      await migrated.pg.exec(
        'alter table public.portfolio_query_receipts enable trigger portfolio_query_receipts_bind_request_artifact',
      );
    }
  } finally {
    await migrated.pg.close();
  }
});
