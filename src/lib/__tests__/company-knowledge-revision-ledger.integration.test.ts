/**
 * 0406 company knowledge history, against the real migration chain.
 *
 * The fixture seeds a real company + fact immediately before 0406. That makes
 * genesis and DB-first compatibility real rollout tests, not a reconstruction
 * of what the migration approximately does.
 */

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';

import { applyMigrationsToPgliteWithHook } from '../../../tests/fixtures/pglite-migrate';
import {
  ACCOUNT_ANA,
  ACCOUNT_BO,
  ACCOUNT_FIONA,
  ACCOUNT_GIL,
  ORG_A,
  ORG_B,
  seedTwoCompanies,
} from '../../../tests/fixtures/pglite-two-company-seed';

const LEGACY_FACT = 'c4040000-0000-4000-8000-000000000001';
const INTAKE_FACT_TOPIC = 'ledger_intake_fact';
const CREATED_AT = '2026-07-01T10:15:00.000Z';
const UPDATED_AT = '2026-07-02T11:16:00.000Z';

let pg: PGlite;
let receiptA = '';
let intakeFactId = '';
let legacyUpdatedAtBeforeMigration = '';

function jsonObject(value: unknown): Record<string, unknown> {
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
  return parsed as Record<string, unknown>;
}

async function scalar<T>(sql: string, params: unknown[] = []): Promise<T> {
  const result = await pg.query(sql, params) as { rows: Array<Record<string, unknown>> };
  return Object.values(result.rows[0] ?? {})[0] as T;
}

async function mintReceipt(accountId: string, organizationId: string): Promise<string> {
  const raw = await scalar<unknown>(
    `select public.staxis_resolve_authorization_scope(
       $1::uuid, $2::uuid, 'all_authorized', null, null::jsonb, 120
     ) as result`,
    [accountId, organizationId],
  );
  const result = jsonObject(raw);
  assert.equal(result.ok, true, `receipt refused: ${JSON.stringify(result)}`);
  return String(jsonObject(result.receipt).id);
}

interface MutationInput {
  actorAccountId?: string;
  receiptId?: string;
  organizationId?: string;
  action: 'intake' | 'upsert_confirmed' | 'confirm' | 'edit' | 'remove' | 'merge';
  factId?: string | null;
  expectedRevision?: number | null;
  relatedFactId?: string | null;
  relatedExpectedRevision?: number | null;
  topic?: string | null;
  content?: string | null;
  category?: string | null;
  source?: string | null;
  policyKey?: string | null;
  policyValue?: string | null;
  authorityActionKind?: string | null;
  authorityThresholdCents?: number | null;
  authorityThresholdInclusive?: boolean | null;
  authorityApproverRole?: string | null;
  requestId?: string | null;
}

async function mutate(input: MutationInput): Promise<Record<string, unknown>> {
  const raw = await scalar<unknown>(
    `select public.staxis_apply_company_knowledge_mutation_v1(
       p_actor_account_id => $1::uuid,
       p_scope_receipt_id => $2::uuid,
       p_organization_id => $3::uuid,
       p_action => $4::text,
       p_fact_id => $5::uuid,
       p_expected_revision => $6::bigint,
       p_related_fact_id => $7::uuid,
       p_related_expected_revision => $8::bigint,
       p_topic => $9::text,
       p_content => $10::text,
       p_category => $11::text,
       p_source => $12::text,
       p_created_by_name => 'Ledger Tester',
       p_created_by_role => 'owner',
       p_policy_key => $13::text,
       p_policy_value => $14::text,
       p_authority_action_kind => $15::text,
       p_authority_threshold_cents => $16::bigint,
       p_authority_threshold_inclusive => $17::boolean,
       p_authority_approver_role => $18::text,
       p_request_id => $19::text,
       p_cap => 150
     ) as result`,
    [
      input.actorAccountId ?? ACCOUNT_ANA,
      input.receiptId ?? receiptA,
      input.organizationId ?? ORG_A,
      input.action,
      input.factId ?? null,
      input.expectedRevision ?? null,
      input.relatedFactId ?? null,
      input.relatedExpectedRevision ?? null,
      input.topic ?? null,
      input.content ?? null,
      input.category ?? null,
      input.source ?? null,
      input.policyKey ?? null,
      input.policyValue ?? null,
      input.authorityActionKind ?? null,
      input.authorityThresholdCents ?? null,
      input.authorityThresholdInclusive ?? null,
      input.authorityApproverRole ?? null,
      input.requestId ?? `ledger-${input.action}`,
    ],
  );
  return jsonObject(raw);
}

describe('0406 company knowledge revision ledger', () => {
  before(async () => {
    const migrated = await applyMigrationsToPgliteWithHook(async ({ pg: hookPg, file }) => {
      if (file !== '0406_company_knowledge_revision_ledger.sql') return;
      await seedTwoCompanies(hookPg);
      await hookPg.query(
        `insert into public.company_knowledge (
           id, organization_id, topic, content, category, source,
           review_state, created_at, updated_at
         ) values (
           $1, $2, 'legacy_vendor', 'Every hotel uses Legacy Supply.',
           'vendors', 'explicit_user', 'confirmed', $3, $4
         )`,
        [LEGACY_FACT, ORG_A, CREATED_AT, UPDATED_AT],
      );
      await hookPg.query(
        `insert into public.company_authority_rules (
           organization_id, action_kind, threshold_cents,
           threshold_inclusive, approver_role, source_fact_id
           -- Seeded DURING migration application, at the 0406 boundary, where
           -- the approver CHECK still only knows the old words. 0464 converts
           -- this row to regional_manager as part of its data backfill.
         ) values ($1, 'purchase_order', 50000, false, 'vp', $2)`,
        [ORG_A, LEGACY_FACT],
      );
      legacyUpdatedAtBeforeMigration = await (async () => {
        const row = await hookPg.query<{ updated_at: string }>(
          'select updated_at::text from public.company_knowledge where id = $1',
          [LEGACY_FACT],
        );
        return row.rows[0].updated_at;
      })();
    });
    pg = migrated.pg;
    assert.ok(
      migrated.report.applied.includes('0406_company_knowledge_revision_ledger.sql'),
      JSON.stringify(migrated.report.failedAtRuntime.filter((failure) => failure.file.includes('0406'))),
    );
    receiptA = await mintReceipt(ACCOUNT_ANA, ORG_A);
  });

  after(async () => {
    await pg?.close();
  });

  test('backfills a byte-preserving genesis snapshot without rewriting the projection', async () => {
    const fact = (await pg.query<{
      content: string;
      created_at: string;
      updated_at: string;
      current_revision: string;
    }>(
      `select content, created_at::text, updated_at::text, current_revision::text
       from public.company_knowledge where id = $1`,
      [LEGACY_FACT],
    )).rows[0];
    assert.equal(fact.content, 'Every hotel uses Legacy Supply.');
    assert.equal(Date.parse(fact.created_at), Date.parse(CREATED_AT));
    assert.equal(Date.parse(fact.updated_at), Date.parse(legacyUpdatedAtBeforeMigration));
    assert.equal(fact.current_revision, '1');

    const revision = (await pg.query<{
      action: string;
      actor_kind: string;
      before_snapshot: unknown;
      after_snapshot: unknown;
    }>(
      `select action, actor_kind, before_snapshot, after_snapshot
       from public.company_knowledge_revisions
       where organization_id = $1 and fact_id = $2`,
      [ORG_A, LEGACY_FACT],
    )).rows[0];
    assert.equal(revision.action, 'genesis');
    assert.equal(revision.actor_kind, 'backfill');
    assert.equal(revision.before_snapshot, null);
    const after = jsonObject(revision.after_snapshot);
    assert.equal(after.content, 'Every hotel uses Legacy Supply.');
    assert.equal(jsonObject(after.authorityRule).thresholdCents, 50_000);
  });

  test('DB-first legacy projection and structured writes are both journaled', async () => {
    await pg.query(
      `update public.company_knowledge
       set content = 'Every hotel uses Legacy Supply Company.'
       where id = $1`,
      [LEGACY_FACT],
    );
    let revision = await scalar<string>(
      'select current_revision::text from public.company_knowledge where id = $1',
      [LEGACY_FACT],
    );
    assert.equal(revision, '2');
    assert.equal(
      await scalar<string>(
        `select action from public.company_knowledge_revisions
         where fact_id = $1 and fact_revision = 2`,
        [LEGACY_FACT],
      ),
      'edit',
    );

    await pg.query(
      `update public.company_authority_rules
       set threshold_cents = 75000, updated_at = clock_timestamp()
       where source_fact_id = $1 and is_active`,
      [LEGACY_FACT],
    );
    revision = await scalar<string>(
      'select current_revision::text from public.company_knowledge where id = $1',
      [LEGACY_FACT],
    );
    assert.equal(revision, '3');
    const structured = (await pg.query<{ action: string; after_snapshot: unknown }>(
      `select action, after_snapshot from public.company_knowledge_revisions
       where fact_id = $1 and fact_revision = 3`,
      [LEGACY_FACT],
    )).rows[0];
    assert.equal(structured.action, 'structured_reading_change');
    assert.equal(
      jsonObject(jsonObject(structured.after_snapshot).authorityRule).thresholdCents,
      75_000,
    );

    await pg.query(
      'delete from public.company_authority_rules where source_fact_id = $1 and is_active',
      [LEGACY_FACT],
    );
    revision = await scalar<string>(
      'select current_revision::text from public.company_knowledge where id = $1',
      [LEGACY_FACT],
    );
    assert.equal(revision, '4');
    const retired = await scalar<unknown>(
      `select after_snapshot->'authorityRule'
       from public.company_knowledge_revisions
       where fact_id = $1 and fact_revision = 4`,
      [LEGACY_FACT],
    );
    assert.equal(retired, null);
  });

  test('intake is unreviewed, confirm is atomic, and stale CAS writes change nothing', async () => {
    const intake = await mutate({
      action: 'intake',
      topic: INTAKE_FACT_TOPIC,
      content: 'Orders above $900 require owner approval.',
      category: 'money',
      source: 'inferred',
    });
    assert.equal(intake.ok, true);
    assert.equal(intake.action, 'inserted');
    intakeFactId = String(intake.factId);
    assert.equal(intake.currentRevision, 1);
    assert.equal(
      await scalar<string>('select review_state from public.company_knowledge where id = $1', [intakeFactId]),
      'unreviewed',
    );
    assert.equal(
      await scalar<string>(
        'select count(*)::text from public.company_authority_rules where source_fact_id = $1 and is_active',
        [intakeFactId],
      ),
      '0',
    );

    const competingIntake = await mutate({
      action: 'intake',
      topic: INTAKE_FACT_TOPIC,
      content: 'A later extraction tried to replace the unreviewed draft.',
      category: 'money',
      source: 'inferred',
    });
    assert.equal(competingIntake.ok, false);
    assert.equal(competingIntake.reason, 'conflict');
    assert.equal(competingIntake.actualRevision, 1);
    assert.equal(
      await scalar<string>('select content from public.company_knowledge where id = $1', [intakeFactId]),
      'Orders above $900 require owner approval.',
    );
    assert.equal(
      await scalar<string>(
        'select count(*)::text from public.company_knowledge_revisions where fact_id = $1',
        [intakeFactId],
      ),
      '1',
    );

    const confirmed = await mutate({
      action: 'confirm',
      factId: intakeFactId,
      expectedRevision: 1,
      content: 'Orders above $900 require owner approval.',
      category: 'money',
      source: 'explicit_user',
      authorityActionKind: 'purchase_order',
      authorityThresholdCents: 90_000,
      authorityThresholdInclusive: false,
      authorityApproverRole: 'owner',
    });
    assert.equal(confirmed.ok, true);
    assert.equal(confirmed.currentRevision, 2);
    assert.equal(
      await scalar<string>('select review_state from public.company_knowledge where id = $1', [intakeFactId]),
      'confirmed',
    );
    assert.equal(
      await scalar<string>(
        `select threshold_cents::text from public.company_authority_rules
         where source_fact_id = $1 and is_active`,
        [intakeFactId],
      ),
      '90000',
    );

    const countBefore = await scalar<string>(
      'select count(*)::text from public.company_knowledge_revisions where fact_id = $1',
      [intakeFactId],
    );
    const stale = await mutate({
      action: 'edit',
      factId: intakeFactId,
      expectedRevision: 1,
      content: 'A stale writer tried to replace this.',
      category: 'money',
      source: 'correction',
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.reason, 'conflict');
    assert.equal(stale.actualRevision, 2);
    assert.equal(
      await scalar<string>('select content from public.company_knowledge where id = $1', [intakeFactId]),
      'Orders above $900 require owner approval.',
    );
    assert.equal(
      await scalar<string>(
        'select count(*)::text from public.company_knowledge_revisions where fact_id = $1',
        [intakeFactId],
      ),
      countBefore,
    );
  });

  test('receipt organization and actor binding fail closed without ID enumeration', async () => {
    const foreign = await mutate({
      organizationId: ORG_B,
      factId: 'ffffffff-0000-4000-8000-000000000001',
      expectedRevision: 1,
      action: 'remove',
    });
    assert.deepEqual(
      { ok: foreign.ok, reason: foreign.reason },
      { ok: false, reason: 'forbidden' },
    );

    const mismatchedActor = await mutate({
      actorAccountId: ACCOUNT_GIL,
      factId: LEGACY_FACT,
      expectedRevision: 4,
      action: 'remove',
    });
    assert.deepEqual(
      { ok: mismatchedActor.ok, reason: mismatchedActor.reason },
      { ok: false, reason: 'forbidden' },
    );
    assert.equal(
      await scalar<boolean>('select is_active from public.company_knowledge where id = $1', [LEGACY_FACT]),
      true,
    );
  });

  test('the rulebook editor policy is enforced again inside the transaction', async () => {
    const financeReceipt = await mintReceipt(ACCOUNT_FIONA, ORG_A);
    const denied = await mutate({
      actorAccountId: ACCOUNT_FIONA,
      receiptId: financeReceipt,
      action: 'intake',
      topic: 'finance_denied_line',
      content: 'Finance tried to add this line.',
      category: 'money',
      source: 'inferred',
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, 'forbidden');

    await pg.query(
      `insert into public.company_access_settings (
         organization_id, setting_key, setting_value, updated_by_account_id
       ) values ($1, 'rulebook_editors', 'company_scope', $2)
       on conflict (organization_id, setting_key) do update
       set setting_value = excluded.setting_value`,
      [ORG_A, ACCOUNT_ANA],
    );
    const allowed = await mutate({
      actorAccountId: ACCOUNT_FIONA,
      receiptId: financeReceipt,
      action: 'intake',
      topic: 'finance_allowed_line',
      content: 'Finance may now add a draft line.',
      category: 'money',
      source: 'inferred',
    });
    assert.equal(allowed.ok, true);

    await pg.query(
      `update public.company_access_settings
       set setting_value = 'owner_and_vp'
       where organization_id = $1 and setting_key = 'rulebook_editors'`,
      [ORG_A],
    );
    const revoked = await mutate({
      actorAccountId: ACCOUNT_FIONA,
      receiptId: financeReceipt,
      action: 'intake',
      topic: 'finance_revoked_line',
      content: 'Finance must no longer be able to add this line.',
      category: 'money',
      source: 'inferred',
    });
    assert.equal(revoked.ok, false);
    assert.equal(revoked.reason, 'forbidden');
    assert.equal(
      await scalar<string>(
        `select count(*)::text from public.company_knowledge
         where organization_id = $1 and topic = 'finance_revoked_line'`,
        [ORG_A],
      ),
      '0',
    );
  });

  test('policy revocation and legacy writers linearize with the receipt-bound CAS', async () => {
    const settingsGuard = await scalar<string>(
      `select pg_get_functiondef(proc.oid)
       from pg_proc proc
       where proc.proname = '_staxis_company_access_setting_serialize'`,
    );
    assert.match(settingsGuard, /_staxis_lock_organization\(v_organization_id\)/i);
    assert.equal(
      await scalar<boolean>(
        `select exists (
           select 1 from pg_trigger trigger
           where trigger.tgname = 'trg_company_access_settings_knowledge_serialization'
             and not trigger.tgisinternal
         )`,
      ),
      true,
    );

    const mutationWriter = await scalar<string>(
      `select pg_get_functiondef(proc.oid)
       from pg_proc proc
       where proc.proname = 'staxis_apply_company_knowledge_mutation_v1'`,
    );
    assert.match(
      mutationWriter,
      /where fact\.organization_id = p_organization_id\s+and fact\.id = p_fact_id and fact\.is_active\s+for update/i,
    );
  });

  test('two editors racing the same revision cannot lose an update', async () => {
    const seeded = await mutate({
      action: 'upsert_confirmed',
      topic: 'concurrent_edit_probe',
      content: 'The original company policy.',
      category: 'standards',
      source: 'explicit_user',
    });
    assert.equal(seeded.ok, true);

    const [left, right] = await Promise.all([
      mutate({
        action: 'edit',
        factId: String(seeded.factId),
        expectedRevision: 1,
        content: 'The left editor policy.',
        category: 'standards',
        source: 'correction',
        requestId: 'concurrent-left',
      }),
      mutate({
        action: 'edit',
        factId: String(seeded.factId),
        expectedRevision: 1,
        content: 'The right editor policy.',
        category: 'standards',
        source: 'correction',
        requestId: 'concurrent-right',
      }),
    ]);
    const outcomes = [left, right];
    assert.equal(outcomes.filter((result) => result.ok).length, 1);
    assert.deepEqual(
      outcomes.filter((result) => !result.ok).map((result) => result.reason),
      ['conflict'],
    );
    assert.equal(
      await scalar<string>(
        'select current_revision::text from public.company_knowledge where id = $1',
        [seeded.factId],
      ),
      '2',
    );
    assert.equal(
      await scalar<string>(
        'select count(*)::text from public.company_knowledge_revisions where fact_id = $1',
        [seeded.factId],
      ),
      '2',
    );
  });

  test('merge records both sides under one operation and rolls back on stale input', async () => {
    const keep = await mutate({
      action: 'upsert_confirmed',
      topic: 'merge_keep',
      content: 'Every hotel uses Vendor One.',
      category: 'vendors',
      source: 'explicit_user',
    });
    const drop = await mutate({
      action: 'intake',
      topic: 'merge_drop',
      content: 'Every hotel uses Vendor Two.',
      category: 'vendors',
      source: 'inferred',
    });
    assert.equal(keep.ok, true);
    assert.equal(drop.ok, true);

    const stale = await mutate({
      action: 'merge',
      factId: String(keep.factId),
      expectedRevision: 1,
      relatedFactId: String(drop.factId),
      relatedExpectedRevision: 99,
    });
    assert.equal(stale.reason, 'conflict');
    assert.equal(
      await scalar<string>('select content from public.company_knowledge where id = $1', [keep.factId]),
      'Every hotel uses Vendor One.',
    );

    const merged = await mutate({
      action: 'merge',
      factId: String(keep.factId),
      expectedRevision: 1,
      relatedFactId: String(drop.factId),
      relatedExpectedRevision: 1,
    });
    assert.equal(merged.ok, true);
    assert.equal(merged.currentRevision, 2);
    assert.equal(merged.relatedCurrentRevision, 2);
    assert.equal(
      await scalar<string>('select content from public.company_knowledge where id = $1', [keep.factId]),
      'Every hotel uses Vendor Two.',
    );
    assert.equal(
      await scalar<boolean>('select is_active from public.company_knowledge where id = $1', [drop.factId]),
      false,
    );
    const pair = await pg.query<{ operation_id: string; merge_role: string }>(
      `select operation_id::text, merge_role
       from public.company_knowledge_revisions
       where action = 'merge' and fact_id in ($1, $2)
       order by merge_role`,
      [keep.factId, drop.factId],
    );
    assert.equal(pair.rows.length, 2);
    assert.equal(pair.rows[0].operation_id, pair.rows[1].operation_id);
    assert.deepEqual(pair.rows.map((row) => row.merge_role).sort(), ['drop', 'keep']);
  });

  test('constraint failure rolls projection, authority, context, and history back together', async () => {
    const before = await scalar<string>(
      `select count(*)::text from public.company_knowledge
       where organization_id = $1 and topic = 'invalid_authority'`,
      [ORG_A],
    );
    await assert.rejects(
      mutate({
        action: 'upsert_confirmed',
        topic: 'invalid_authority',
        content: 'This deliberately carries a poisoned structured rule.',
        category: 'money',
        source: 'explicit_user',
        authorityActionKind: 'sql_injection',
        authorityThresholdCents: 1,
        authorityThresholdInclusive: true,
        authorityApproverRole: 'owner',
      }),
    );
    assert.equal(
      await scalar<string>(
        `select count(*)::text from public.company_knowledge
         where organization_id = $1 and topic = 'invalid_authority'`,
        [ORG_A],
      ),
      before,
    );
    assert.equal(
      await scalar<string>(
        'select count(*)::text from public.company_knowledge_revision_context',
      ),
      '0',
    );
  });

  test('fact and structured-rule identities cannot be reassigned across tenants', async () => {
    const replacementFactId = 'ffffffff-0000-4000-8000-000000000004';

    await assert.rejects(
      pg.query(
        'update public.company_knowledge set organization_id = $1 where id = $2',
        [ORG_B, intakeFactId],
      ),
      /company knowledge identity is immutable/i,
    );
    await assert.rejects(
      pg.query(
        'update public.company_knowledge set id = $1 where id = $2',
        [replacementFactId, intakeFactId],
      ),
      /company knowledge identity is immutable/i,
    );
    await assert.rejects(
      pg.query(
        `update public.company_authority_rules
         set organization_id = $1 where source_fact_id = $2 and is_active`,
        [ORG_B, intakeFactId],
      ),
      /company authority (?:identity is immutable|organization does not match its fact)/i,
    );
    await assert.rejects(
      pg.query(
        `update public.company_authority_rules
         set source_fact_id = $1 where source_fact_id = $2 and is_active`,
        [LEGACY_FACT, intakeFactId],
      ),
      /company authority (?:identity is immutable|organization does not match its fact)/i,
    );

    assert.equal(
      await scalar<string>(
        'select organization_id::text from public.company_knowledge where id = $1',
        [intakeFactId],
      ),
      ORG_A,
    );
    assert.equal(
      await scalar<string>(
        `select organization_id::text from public.company_authority_rules
         where source_fact_id = $1 and is_active`,
        [intakeFactId],
      ),
      ORG_A,
    );

    const revisionBeforeForgery = await scalar<string>(
      'select current_revision::text from public.company_knowledge where id = $1',
      [intakeFactId],
    );
    await assert.rejects(
      pg.query(
        'update public.company_knowledge set current_revision = 999 where id = $1',
        [intakeFactId],
      ),
      /company knowledge revision token is immutable/i,
    );
    assert.equal(
      await scalar<string>(
        'select current_revision::text from public.company_knowledge where id = $1',
        [intakeFactId],
      ),
      revisionBeforeForgery,
    );

    await pg.query(
      `update public.company_authority_rules
       set updated_at = updated_at + interval '1 second'
       where source_fact_id = $1 and is_active`,
      [intakeFactId],
    );
    assert.equal(
      Number(await scalar<string>(
        'select current_revision::text from public.company_knowledge where id = $1',
        [intakeFactId],
      )),
      Number(revisionBeforeForgery) + 1,
    );
    assert.equal(
      await scalar<string>(
        `select action from public.company_knowledge_revisions
         where fact_id = $1 order by fact_revision desc limit 1`,
        [intakeFactId],
      ),
      'structured_reading_change',
    );
  });

  test('snapshot hashes and the per-company chain are internally bound', async () => {
    const revisionsBeforePoison = await scalar<string>(
      'select count(*)::text from public.company_knowledge_revisions',
    );
    await assert.rejects(
      pg.query(
        `select public._staxis_append_company_knowledge_revision(
           $1, $2, fact.current_revision + 1, gen_random_uuid(),
           'edit', null, null, snapshot.value,
           jsonb_set(
             jsonb_set(
               snapshot.value,
               '{currentRevision}',
               to_jsonb(fact.current_revision + 1)
             ),
             '{organizationId}',
             to_jsonb($3::text)
           ),
           $4, 'account', 'correction', 'poisoned-snapshot'
         )
         from public.company_knowledge fact
         cross join lateral (
           select public._staxis_company_knowledge_snapshot(fact.id) as value
         ) snapshot
         where fact.id = $2`,
        [ORG_A, intakeFactId, ORG_B, ACCOUNT_ANA],
      ),
      /invalid company knowledge revision/i,
    );
    assert.equal(
      await scalar<string>('select count(*)::text from public.company_knowledge_revisions'),
      revisionsBeforePoison,
    );

    const poison = await pg.query<{ bad: string }>(`
      select count(*)::text as bad
      from public.company_knowledge_revisions revision
      where (revision.before_snapshot is not null and revision.before_snapshot_hash <>
               encode(sha256(convert_to(revision.before_snapshot::text, 'UTF8')), 'hex'))
         or (revision.after_snapshot is not null and revision.after_snapshot_hash <>
               encode(sha256(convert_to(revision.after_snapshot::text, 'UTF8')), 'hex'))
    `);
    assert.equal(poison.rows[0].bad, '0');

    const broken = await pg.query<{ bad: string }>(`
      with ordered as (
        select organization_id, organization_revision, previous_revision_hash,
               lag(revision_hash) over (
                 partition by organization_id order by organization_revision
               ) as expected_previous
        from public.company_knowledge_revisions
      )
      select count(*)::text as bad from ordered
      where previous_revision_hash is distinct from expected_previous
    `);
    assert.equal(broken.rows[0].bad, '0');

    const discontinuousFacts = await pg.query<{ bad: string }>(`
      with ordered as (
        select organization_id, fact_id, fact_revision, before_snapshot_hash,
               lag(after_snapshot_hash) over (
                 partition by organization_id, fact_id order by fact_revision
               ) as expected_before_hash,
               row_number() over (
                 partition by organization_id, fact_id order by fact_revision
               ) as sequence_number
        from public.company_knowledge_revisions
      )
      select count(*)::text as bad from ordered
      where (sequence_number = 1 and before_snapshot_hash is not null)
         or (sequence_number > 1 and before_snapshot_hash is distinct from expected_before_hash)
    `);
    assert.equal(discontinuousFacts.rows[0].bad, '0');
  });

  test('finalization is one-way: legacy DML closes while the receipt-bound RPC survives', async () => {
    assert.equal(
      await scalar<boolean>(
        `select has_table_privilege('service_role', 'public.company_knowledge', 'DELETE')`,
      ),
      false,
    );
    await pg.exec('set role service_role');
    try {
      await assert.rejects(
        pg.query('delete from public.company_knowledge where id = $1', [LEGACY_FACT]),
        /permission denied/i,
      );
    } finally {
      await pg.exec('reset role');
    }
    assert.equal(
      await scalar<boolean>(
        `select has_table_privilege('service_role', 'public.company_knowledge', 'UPDATE')`,
      ),
      true,
    );
    const finalized = jsonObject(await scalar<unknown>(
      `select public.staxis_finalize_company_knowledge_revision_ledger(
         'company_knowledge_revision_ledger_v1'
       )`,
    ));
    assert.equal(finalized.ok, true);
    assert.equal(finalized.rolloutMode, 'enforced');
    assert.equal(
      await scalar<boolean>(
        `select has_table_privilege('service_role', 'public.company_knowledge', 'UPDATE')`,
      ),
      false,
    );
    assert.equal(
      await scalar<boolean>(
        `select has_table_privilege('service_role', 'public.company_authority_rules', 'DELETE')`,
      ),
      false,
    );
    assert.equal(
      await scalar<boolean>(
        `select has_function_privilege(
          'service_role',
          'public.staxis_store_company_fact(uuid,text,text,text,text,uuid,text,text,integer)',
          'EXECUTE'
        )`,
      ),
      false,
    );
    assert.equal(
      await scalar<boolean>(
        `select has_function_privilege(
          'service_role',
          'public.staxis_apply_company_knowledge_mutation_v1(uuid,uuid,uuid,text,uuid,bigint,uuid,bigint,text,text,text,text,text,text,text,text,text,bigint,boolean,text,text,integer)',
          'EXECUTE'
        )`,
      ),
      true,
    );
    assert.equal(
      await scalar<boolean>(
        `select has_table_privilege('authenticated', 'public.company_knowledge_revisions', 'SELECT')`,
      ),
      false,
    );
    assert.equal(
      await scalar<boolean>(
        `select has_table_privilege('service_role', 'public.company_knowledge_revisions', 'UPDATE')`,
      ),
      false,
    );

    await pg.exec('set role service_role');
    try {
      await assert.rejects(
        pg.query(`update public.company_knowledge set content = 'bypass' where id = $1`, [LEGACY_FACT]),
        /permission denied/i,
      );
      const current = Number(await scalar<string>(
        'select current_revision::text from public.company_knowledge where id = $1',
        [intakeFactId],
      ));
      const removed = await mutate({
        action: 'remove',
        factId: intakeFactId,
        expectedRevision: current,
      });
      assert.equal(removed.ok, true, JSON.stringify(removed));
    } finally {
      await pg.exec('reset role');
    }

    await assert.rejects(
      pg.query(
        `update public.company_knowledge_revisions set source = 'tampered'
         where organization_id = $1`,
        [ORG_A],
      ),
      /immutable/i,
    );
    const again = jsonObject(await scalar<unknown>(
      `select public.staxis_finalize_company_knowledge_revision_ledger(
         'company_knowledge_revision_ledger_v1'
       )`,
    ));
    assert.equal(again.alreadyFinalized, true);

    // Idempotent deploy tooling must not turn compatibility DML back on after
    // the irreversible cutover has already happened.
    await pg.exec(readFileSync(join(
      process.cwd(),
      'supabase/migrations/0406_company_knowledge_revision_ledger.sql',
    ), 'utf8'));
    assert.equal(
      await scalar<boolean>(
        `select has_table_privilege('service_role', 'public.company_knowledge', 'UPDATE')`,
      ),
      false,
    );
    assert.equal(
      await scalar<boolean>(
        `select has_function_privilege(
          'service_role',
          'public.staxis_store_company_fact(uuid,text,text,text,text,uuid,text,text,integer)',
          'EXECUTE'
        )`,
      ),
      false,
    );
  });

  test('another company owner never appears in company A revisions', async () => {
    assert.equal(
      await scalar<string>(
        `select count(*)::text from public.company_knowledge_revisions
         where organization_id = $1 and actor_account_id = $2`,
        [ORG_A, ACCOUNT_BO],
      ),
      '0',
    );
  });
});
