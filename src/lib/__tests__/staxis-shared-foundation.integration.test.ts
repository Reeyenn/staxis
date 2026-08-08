import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { PGlite } from '@electric-sql/pglite';

import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';
import { parseLifecycleProjectionRow } from '../staxis/lifecycle';

const PROPERTY_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const PROPERTY_B = 'bbbbbbbb-0000-4000-8000-000000000001';
const AUTH_A = 'aaaaaaaa-0000-4000-8000-000000000010';
const ACCOUNT_A = 'aaaaaaaa-0000-4000-8000-000000000011';
const DEFINITION_A = 'aaaaaaaa-0000-4000-8000-000000000020';
const ACTION_DEFINITION = 'aaaaaaaa-0000-4000-8000-000000000021';
const FINDING_OBSERVED = 'aaaaaaaa-0000-4000-8000-000000000030';
const FINDING_ACTION = 'aaaaaaaa-0000-4000-8000-000000000031';
const FINDING_UNOBSERVABLE = 'aaaaaaaa-0000-4000-8000-000000000032';
const TARGET_ID = 'aaaaaaaa-0000-4000-8000-000000000040';
const TARGET_ID_2 = 'aaaaaaaa-0000-4000-8000-000000000041';

const digest = (character: string) => character.repeat(64);
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const SOURCE_AS_OF = iso(-120_000);
const SOURCE_OBSERVED_AT = iso(-60_000);
const SOURCE_RECEIVED_AT = iso(-10_000);
const SOURCE_EFFECTIVE_AT = iso(-120_000);
const SOURCE_EXPIRES_AT = iso(3_600_000);
const ADMISSION_AS_OF = SOURCE_AS_OF;
const ADMISSION_OBSERVED_AT = SOURCE_OBSERVED_AT;
const ADMISSION_EXPIRES_AT = SOURCE_EXPIRES_AT;

type JsonObject = Record<string, unknown>;
type RpcResult = JsonObject & { recorded?: boolean; admitted?: boolean; replayed?: boolean };

describe('0469 Staxis shared foundation — SQL custody invariants', { concurrency: false }, () => {
  let pg: PGlite;
  let sourceFactId: string;
  let actionContract: JsonObject;

  async function sql<T extends JsonObject>(text: string, params: unknown[] = []): Promise<T[]> {
    const result = await pg.query<T>(text, params);
    return result.rows;
  }

  function parseSqlProjection(row: JsonObject) {
    // PGlite exposes timestamptz columns as Date objects; PostgREST transports
    // the same row as JSON ISO strings, which is the parser's API boundary.
    return parseLifecycleProjectionRow(JSON.parse(JSON.stringify(row)));
  }

  async function sourceFact(options: {
    externalReceiptId: string;
    sourceHash: string;
    entityId?: string;
    effectiveAt?: string;
    asOf?: string;
    observedAt?: string;
    receivedAt?: string;
    completeness?: 'complete' | 'partial' | 'unknown';
    completenessReason?: string | null;
    propertyId?: string;
    definitionId?: string;
    value?: JsonObject;
  }): Promise<RpcResult> {
    const completeness = options.completeness ?? 'complete';
    const result = await sql<{ value: RpcResult }>(
      `select public.staxis_record_source_fact($1, $2::jsonb) as value`,
      [
        options.propertyId ?? PROPERTY_A,
        JSON.stringify({
          propertyId: options.propertyId ?? PROPERTY_A,
          sourceDefinitionId: options.definitionId ?? DEFINITION_A,
          receipt: {
            receiptId: options.externalReceiptId,
            sourceReference: 'fixture-receipt',
            sourceHash: options.sourceHash,
            asOf: options.asOf ?? SOURCE_AS_OF,
            observedAt: options.observedAt ?? SOURCE_OBSERVED_AT,
            receivedAt: options.receivedAt ?? SOURCE_RECEIVED_AT,
            completeness,
            completenessReason: options.completenessReason ?? (completeness === 'complete' ? null : 'fixture is partial'),
          },
          fact: {
            entityKind: 'room',
            entityId: options.entityId ?? TARGET_ID,
            entityLabel: 'Fixture room',
            effectiveAt: options.effectiveAt ?? SOURCE_EFFECTIVE_AT,
            expiresAt: SOURCE_EXPIRES_AT,
            completeness,
            completenessReason: options.completenessReason ?? (completeness === 'complete' ? null : 'fixture is partial'),
            value: options.value ?? { occupied: false },
            supersedesId: null,
          },
        }),
      ],
    );
    return result[0].value;
  }

  function evidence(queryId: string): JsonObject {
    return { queryId, params: { fixture: true }, values: { count: 1 }, basis: 'fixture evidence can be rerun' };
  }

  function minimumData(): JsonObject {
    return { met: true, required: ['room'], provided: ['room'], missing: [] };
  }

  function owner() : JsonObject {
    return { kind: 'app', label: 'Staxis', role: 'system' };
  }

  async function admitFinding(
    findingId: string,
    queryId: string,
    lifecycle: JsonObject,
    detectorId = 'fixture_detector',
    proofOverrides: JsonObject = {},
  ): Promise<RpcResult> {
    const result = await sql<{ value: RpcResult }>(
      `select public.staxis_admit_lifecycle_bundle($1, $2::jsonb) as value`,
      [PROPERTY_A, JSON.stringify({
        propertyId: PROPERTY_A,
        findingId,
        contractVersion: 'staxis-source-fact.v1',
        detectorId,
        receiptQueryId: queryId,
        evidence: evidence(queryId),
        minimumData: minimumData(),
        minimumDataMet: true,
        asOf: ADMISSION_AS_OF,
        observedAt: ADMISSION_OBSERVED_AT,
        expiresAt: ADMISSION_EXPIRES_AT,
        completeness: 'complete',
        completenessReason: null,
        freshness: 'fresh',
        freshnessMaxAgeSeconds: 86_400,
        sourceFactIds: [sourceFactId],
        ...proofOverrides,
        lifecycle,
      })],
    );
    return result[0].value;
  }

  async function append(event: JsonObject): Promise<RpcResult> {
    const result = await sql<{ value: RpcResult }>(
      `select public.staxis_append_lifecycle_event($1, $2::jsonb) as value`,
      [PROPERTY_A, JSON.stringify(event)],
    );
    return result[0].value;
  }

  async function lifecycleIdFor(findingId: string): Promise<string> {
    const rows = await sql<{ id: string }>(
      `select id from public.staxis_lifecycle_records where property_id = $1 and finding_id = $2`,
      [PROPERTY_A, findingId],
    );
    assert.equal(rows.length, 1);
    return rows[0].id;
  }

  async function approveAndExecute(lifecycleId: string, proposalId: string, targetId: string): Promise<{ executionEventId: string; approvalEventId: string; frozenInputHash: string }> {
    const approvalIdempotency = `${lifecycleId}:approve`;
    const approval = await append({
      lifecycleId,
      eventKind: 'state_transition',
      fromState: 'proposed',
      toState: 'approved',
      actorAccountId: ACCOUNT_A,
      actorSnapshot: { id: ACCOUNT_A, authority: 'admin', role: 'admin' },
      ownerSnapshot: owner(),
      domainReference: {},
      approvalProof: { decision: 'approved', policyId: 'fixture-policy', mode: 'explicit_card', tier: 'card' },
      idempotencyKey: approvalIdempotency,
    });
    assert.equal(approval.recorded, true, JSON.stringify(approval));
    const approvalEventId = String(approval.eventId);
    const frozenRows = await sql<{ frozen_input_hash: string; action_idempotency_key: string }>(
      `select frozen_input_hash, action_idempotency_key from public.staxis_lifecycle_records where id = $1`,
      [lifecycleId],
    );
    const frozenInputHash = frozenRows[0].frozen_input_hash;
    const executionReceipt = {
      contractVersion: 'staxis-action.v1',
      internalOnly: true,
      physicalCompletionClaim: 'never',
      propertyId: PROPERTY_A,
      idempotencyKey: frozenRows[0].action_idempotency_key,
      proposalId,
      approvalId: approvalEventId,
      targetId,
      targetKind: 'room',
      executedBy: ACCOUNT_A,
      actionId: null,
      effect: actionContract.effect,
      frozenInputHash,
      inputVerification: { state: 'matched', verifiedAt: iso(0) },
      executedAt: iso(0),
      receipt: { result: 'applied', recordedAt: iso(0) },
    };
    const crossPropertyExecution = await append({
      lifecycleId,
      eventKind: 'state_transition',
      fromState: 'approved',
      toState: 'executed',
      actorAccountId: ACCOUNT_A,
      actorSnapshot: { id: ACCOUNT_A, authority: 'admin', role: 'admin' },
      ownerSnapshot: owner(),
      domainReference: { kind: 'room', id: targetId, label: 'Fixture room', href: null },
      executionReceipt: { ...executionReceipt, propertyId: PROPERTY_B },
      idempotencyKey: `${lifecycleId}:execute-cross-property`,
    });
    assert.equal(crossPropertyExecution.recorded, false);
    const execution = await append({
      lifecycleId,
      eventKind: 'state_transition',
      fromState: 'approved',
      toState: 'executed',
      actorAccountId: ACCOUNT_A,
      actorSnapshot: { id: ACCOUNT_A, authority: 'admin', role: 'admin' },
      ownerSnapshot: owner(),
      domainReference: { kind: 'room', id: targetId, label: 'Fixture room', href: null },
      executionReceipt,
      idempotencyKey: `${lifecycleId}:execute`,
    });
    assert.equal(execution.recorded, true, JSON.stringify(execution));
    return { executionEventId: String(execution.eventId), approvalEventId, frozenInputHash };
  }

  before(async () => {
    const fixture = await applyMigrationsToPglite();
    pg = fixture.pg;
    // 0469 is deliberately retry-safe: re-running the exact production SQL
    // after a partially applied deployment must not duplicate constraints,
    // triggers, indexes, functions, or migration bookkeeping.
    const migrationSql = readFileSync(join(process.cwd(), 'supabase/migrations/0469_staxis_shared_foundation.sql'), 'utf8');
    await pg.exec(migrationSql);
    const migrationRows = await sql<{ version: string }>(
      `select version from public.applied_migrations where version = '0469'`,
    );
    assert.equal(migrationRows.length, 1);
    await sql(`insert into auth.users (id, email) values ($1, 'foundation-fixture@example.test') on conflict (id) do nothing`, [AUTH_A]);
    await sql(`insert into public.properties (id, owner_id, name, total_rooms, avg_occupancy, hourly_wage, checkout_minutes, stayover_minutes, prep_minutes_per_activity, shift_minutes, total_staff_on_roster) values ($1, $2, 'Foundation Fixture', 1, 0, 15, 30, 20, 5, 480, 1) on conflict (id) do nothing`, [PROPERTY_A, AUTH_A]);
    await sql(`insert into public.properties (id, owner_id, name, total_rooms, avg_occupancy, hourly_wage, checkout_minutes, stayover_minutes, prep_minutes_per_activity, shift_minutes, total_staff_on_roster) values ($1, $2, 'Foundation Other Fixture', 1, 0, 15, 30, 20, 5, 480, 1) on conflict (id) do nothing`, [PROPERTY_B, AUTH_A]);
    await sql(`insert into public.accounts (id, username, password_hash, display_name, role, data_user_id) values ($1, 'foundation-fixture', 'x', 'Foundation Fixture Admin', 'admin', $2) on conflict (id) do nothing`, [ACCOUNT_A, AUTH_A]);
    await sql(`insert into public.account_authorization_state (account_id, authority_mode, cutover_at) values ($1, 'normalized', clock_timestamp()) on conflict (account_id) do update set authority_mode = 'normalized', cutover_at = coalesce(account_authorization_state.cutover_at, excluded.cutover_at)`, [ACCOUNT_A]);
    await sql(`
      insert into public.staxis_source_definitions (
        id, property_id, source_class, producer_key, category, entity_kind, claim_scope,
        ownership_claim, owner_kind, owner_label, owner_role, authority_level, precedence_rank,
        freshness_required, freshness_max_age_seconds, completeness_required, reviewed_at
      ) values ($1, $2, 'app_owned', 'fixture', 'room-status', 'room', 'fixture.room.status',
        '{"scope":"fixture.room.status","owner":"app"}'::jsonb, 'app', 'Staxis', 'system', 10, 1,
        true, 86400, 'complete', clock_timestamp()) on conflict (id) do nothing
    `, [DEFINITION_A, PROPERTY_A]);

    actionContract = {
      contractVersion: 'staxis-action.v1',
      effect: { domain: 'hotel', operation: 'annotate', targetKind: 'room', boundary: 'in_app_only', statement: 'Annotate a room record', limit: 'One room record' },
      authority: { propertyScoped: true, roles: ['admin'], capability: null, surfaces: ['admin'] },
      approval: { mode: 'explicit_card', tier: 'card', policyId: 'fixture-policy' },
      frozenInput: { immutable: true, fields: ['propertyId', 'findingId', 'params', 'verify'], fingerprint: 'server_sha256', staleInput: 'decline' },
      idempotency: { scope: 'property_action_and_input', keyFields: ['proposalId'], retry: 'same_proposal' },
      receipt: { contractVersion: 'staxis-action.v1', requiredFields: ['result', 'recordedAt'], internalOnly: true, physicalCompletionClaim: 'never' },
      outcome: { observability: 'observable', verificationState: 'pending', verificationWindowDays: 7, basisRequired: true },
    };
    await sql(`
      insert into public.staxis_action_definitions (id, property_id, category, action_kind, action_contract, reviewed_at)
      values ($1, $2, 'fixture', 'room_annotation', $3::jsonb, clock_timestamp()) on conflict (id) do nothing
    `, [ACTION_DEFINITION, PROPERTY_A, JSON.stringify(actionContract)]);
    await sql(`
      insert into public.findings (id, property_id, detector_id, dedupe_key, summary, severity, receipt_query_id, evidence)
      values
        ($1, $4, 'fixture_detector', 'fixture-observed', 'Observed fixture finding', 'attention', 'fixture-query-observed', $5::jsonb),
        ($2, $4, 'fixture_detector', 'fixture-action', 'Action fixture finding', 'attention', 'fixture-query-action', $6::jsonb),
        ($3, $4, 'fixture_detector', 'fixture-unobservable', 'Unobservable fixture finding', 'attention', 'fixture-query-unobservable', $7::jsonb)
      on conflict (id) do nothing
    `, [FINDING_OBSERVED, FINDING_ACTION, FINDING_UNOBSERVABLE, PROPERTY_A, JSON.stringify(evidence('fixture-query-observed')), JSON.stringify(evidence('fixture-query-action')), JSON.stringify(evidence('fixture-query-unobservable'))]);
    const source = await sourceFact({ externalReceiptId: 'fixture-receipt-1', sourceHash: digest('a') });
    assert.equal(source.recorded, true);
    assert.equal(source.admitted, true);
    sourceFactId = String(source.factId);
  });

  after(async () => {
    await pg.close();
  });

  test('records source receipt/fact atomically and rejects replay collisions and cross-property links', async () => {
    const replay = await sourceFact({ externalReceiptId: 'fixture-receipt-1', sourceHash: digest('a') });
    assert.equal(replay.recorded, true);
    assert.equal(replay.replayed, true);
    const collision = await sourceFact({ externalReceiptId: 'fixture-receipt-1', sourceHash: digest('a'), value: { occupied: true } });
    assert.equal(collision.recorded, false);
    const crossProperty = await sourceFact({ externalReceiptId: 'fixture-cross-property', sourceHash: digest('c'), propertyId: PROPERTY_B });
    assert.equal(crossProperty.recorded, false);
    const mismatchedProperty = await sql<{ value: RpcResult }>(
      `select public.staxis_record_source_fact($1, $2::jsonb) as value`,
      [PROPERTY_A, JSON.stringify({ propertyId: PROPERTY_B, sourceDefinitionId: DEFINITION_A })],
    );
    assert.equal(mismatchedProperty[0].value.recorded, false);
  });

  test('requires an explicit null capability and the exact generic frozen-input field set', async () => {
    const cloneContract = (): JsonObject => JSON.parse(JSON.stringify(actionContract)) as JsonObject;
    const missingCapability = cloneContract();
    delete (missingCapability.authority as JsonObject).capability;
    const extraFrozenField = cloneContract();
    (extraFrozenField.frozenInput as JsonObject).fields = ['propertyId', 'findingId', 'params', 'verify', 'entityId'];
    const missingFrozenField = cloneContract();
    (missingFrozenField.frozenInput as JsonObject).fields = ['propertyId', 'findingId', 'params'];
    const mismatchedApprovalTier = cloneContract();
    (mismatchedApprovalTier.approval as JsonObject).tier = 'quick';
    const duplicateIdempotencyFields = cloneContract();
    (duplicateIdempotencyFields.idempotency as JsonObject).keyFields = ['proposalId', 'proposalId'];
    const duplicateReceiptFields = cloneContract();
    (duplicateReceiptFields.receipt as JsonObject).requiredFields = ['result', 'result'];
    const oversizeEffect = cloneContract();
    (oversizeEffect.effect as JsonObject).statement = 'x'.repeat(1_001);
    const valid = await sql<{ valid: boolean }>(
      `select public.staxis_action_contract_is_valid($1::jsonb) as valid`,
      [JSON.stringify(actionContract)],
    );
    const missingCapabilityResult = await sql<{ valid: boolean }>(
      `select public.staxis_action_contract_is_valid($1::jsonb) as valid`,
      [JSON.stringify(missingCapability)],
    );
    const extraFrozenFieldResult = await sql<{ valid: boolean }>(
      `select public.staxis_action_contract_is_valid($1::jsonb) as valid`,
      [JSON.stringify(extraFrozenField)],
    );
    const missingFrozenFieldResult = await sql<{ valid: boolean }>(
      `select public.staxis_action_contract_is_valid($1::jsonb) as valid`,
      [JSON.stringify(missingFrozenField)],
    );
    const mismatchedApprovalTierResult = await sql<{ valid: boolean }>(
      `select public.staxis_action_contract_is_valid($1::jsonb) as valid`,
      [JSON.stringify(mismatchedApprovalTier)],
    );
    const duplicateIdempotencyFieldsResult = await sql<{ valid: boolean }>(
      `select public.staxis_action_contract_is_valid($1::jsonb) as valid`,
      [JSON.stringify(duplicateIdempotencyFields)],
    );
    const duplicateReceiptFieldsResult = await sql<{ valid: boolean }>(
      `select public.staxis_action_contract_is_valid($1::jsonb) as valid`,
      [JSON.stringify(duplicateReceiptFields)],
    );
    const oversizeEffectResult = await sql<{ valid: boolean }>(
      `select public.staxis_action_contract_is_valid($1::jsonb) as valid`,
      [JSON.stringify(oversizeEffect)],
    );
    assert.equal(valid[0].valid, true);
    assert.equal(missingCapabilityResult[0].valid, false);
    assert.equal(extraFrozenFieldResult[0].valid, false);
    assert.equal(missingFrozenFieldResult[0].valid, false);
    assert.equal(mismatchedApprovalTierResult[0].valid, false);
    assert.equal(duplicateIdempotencyFieldsResult[0].valid, false);
    assert.equal(duplicateReceiptFieldsResult[0].valid, false);
    assert.equal(oversizeEffectResult[0].valid, false);
  });

  test('fails closed for malformed minimum-data/evidence and incomplete or stale source facts', async () => {
    await assert.rejects(() => admitFinding(FINDING_OBSERVED, 'fixture-query-observed', {
      entityKind: 'room', entityId: TARGET_ID, title: 'Bad proof', ownerKind: 'app', ownerLabel: 'Staxis', ownerRole: 'system', lifecycleIdempotencyKey: 'bad-proof',
    }));
    const partial = await sourceFact({ externalReceiptId: 'fixture-partial', sourceHash: digest('d'), completeness: 'partial' });
    assert.equal(partial.recorded, true);
    const previousFactId = sourceFactId;
    sourceFactId = String(partial.factId);
    await assert.rejects(() => admitFinding(FINDING_OBSERVED, 'fixture-query-observed', {
      entityKind: 'room', entityId: TARGET_ID, title: 'Partial proof', ownerKind: 'app', ownerLabel: 'Staxis', ownerRole: 'system', lifecycleIdempotencyKey: 'partial-proof', approvalRequired: false,
    }));
    const stale = await sourceFact({ externalReceiptId: 'fixture-stale', sourceHash: digest('e'), asOf: iso(-172_800_000), observedAt: iso(-172_740_000), receivedAt: iso(-172_700_000) });
    assert.equal(stale.recorded, true);
    sourceFactId = String(stale.factId);
    await assert.rejects(() => admitFinding(FINDING_OBSERVED, 'fixture-query-observed', {
      entityKind: 'room', entityId: TARGET_ID, title: 'Stale proof', ownerKind: 'app', ownerLabel: 'Staxis', ownerRole: 'system', lifecycleIdempotencyKey: 'stale-proof', approvalRequired: false,
    }));
    sourceFactId = previousFactId;
    await assert.rejects(() => admitFinding(FINDING_UNOBSERVABLE, 'fixture-query-unobservable', {
      entityKind: 'room', entityId: TARGET_ID_2, title: 'Malformed owner seed', ownerKind: 'bogus', ownerLabel: null, ownerRole: null, lifecycleIdempotencyKey: 'malformed-owner-seed', approvalRequired: false,
    }));
    await assert.rejects(() => admitFinding(FINDING_UNOBSERVABLE, 'fixture-query-unobservable', {
      entityKind: 'room', entityId: TARGET_ID_2, title: 'Duplicate source proof', ownerKind: 'app', ownerLabel: 'Staxis', ownerRole: 'system', lifecycleIdempotencyKey: 'duplicate-source-proof', approvalRequired: false,
    }, 'fixture_detector', { sourceFactIds: [sourceFactId, sourceFactId] }));
    await assert.rejects(() => admitFinding(FINDING_UNOBSERVABLE, 'fixture-query-unobservable', {
      entityKind: 'room', entityId: TARGET_ID_2, title: 'Wrong clock proof', ownerKind: 'app', ownerLabel: 'Staxis', ownerRole: 'system', lifecycleIdempotencyKey: 'wrong-clock-proof', approvalRequired: false,
    }, 'fixture_detector', { asOf: iso(-60_000) }));
    await assert.rejects(() => admitFinding(FINDING_UNOBSERVABLE, 'fixture-query-unobservable', {
      entityKind: 'room', entityId: TARGET_ID_2, title: 'Overlong proof', ownerKind: 'app', ownerLabel: 'Staxis', ownerRole: 'system', lifecycleIdempotencyKey: 'overlong-proof', approvalRequired: false,
    }, 'fixture_detector', { expiresAt: iso(172_800_000) }));
  });

  test('keeps an observation action-free and atomically seeds a generic proposal', async () => {
    const observed = await admitFinding(FINDING_OBSERVED, 'fixture-query-observed', {
      entityKind: 'room', entityId: TARGET_ID, entityLabel: 'Fixture room', title: 'Observed fixture', summary: 'No action has been proposed.', approvalRequired: false,
      ownerKind: 'app', ownerLabel: 'Staxis', ownerRole: 'system', lifecycleIdempotencyKey: 'fixture-observed',
    });
    assert.equal(observed.admitted, true);
    const observedLifecycle = await lifecycleIdFor(FINDING_OBSERVED);
    const observedProjection = await sql<JsonObject>(`select * from public.staxis_lifecycle_projection_v1 where projection_id = $1`, [observedLifecycle]);
    assert.equal(observedProjection[0].state, 'observed');
    assert.equal(observedProjection[0].action, null);
    assert.ok(parseSqlProjection(observedProjection[0]), 'observed SQL projection must satisfy the lifecycle parser');
    await assert.rejects(() => admitFinding(FINDING_OBSERVED, 'fixture-query-observed', {
      entityKind: 'room', entityId: TARGET_ID, entityLabel: 'Fixture room', title: 'Observed fixture', summary: 'No action has been proposed.', approvalRequired: true,
      ownerKind: 'app', ownerLabel: 'Staxis', ownerRole: 'system', lifecycleIdempotencyKey: 'fixture-observed',
    }));

    const proposalId = 'aaaaaaaa-0000-4000-8000-000000000050';
    const proposed = await admitFinding(FINDING_ACTION, 'fixture-query-action', {
      entityKind: 'room', entityId: TARGET_ID, entityLabel: 'Fixture room', title: 'Proposed fixture', summary: 'A generic action proposal.',
      proposalId, actionKind: 'room_annotation', actionDefinitionId: ACTION_DEFINITION, actionContract,
      frozenInput: { propertyId: PROPERTY_A, findingId: FINDING_ACTION, params: { note: 'fixture' }, verify: { targetId: TARGET_ID } },
      actionIdempotencyKey: 'fixture-action-1', lifecycleIdempotencyKey: 'fixture-action-lifecycle', approvalRequired: true,
      ownerKind: 'app', ownerLabel: 'Staxis', ownerRole: 'system',
    });
    assert.equal(proposed.admitted, true);
    assert.equal(proposed.proposalId, proposalId);
    assert.deepEqual(proposed.sourceFactIds, [sourceFactId]);
    const lifecycleId = await lifecycleIdFor(FINDING_ACTION);
    const record = await sql<JsonObject>(`select state, prior_states, frozen_input, frozen_input_hash from public.staxis_lifecycle_records where id = $1`, [lifecycleId]);
    assert.equal(record[0].state, 'proposed');
    assert.deepEqual(record[0].prior_states, ['observed']);
    assert.ok(record[0].frozen_input_hash);
    assert.deepEqual(record[0].frozen_input, { propertyId: PROPERTY_A, findingId: FINDING_ACTION, params: { note: 'fixture' }, verify: { targetId: TARGET_ID } });
    const projection = await sql<JsonObject>(`select * from public.staxis_lifecycle_projection_v1 where projection_id = $1`, [lifecycleId]);
    const action = projection[0].action as JsonObject;
    const sources = projection[0].sources as JsonObject[];
    assert.equal(projection[0].state, 'proposed');
    assert.equal(action.id, proposalId);
    assert.equal((action.frozenInput as JsonObject).hash, record[0].frozen_input_hash);
    assert.equal(Object.prototype.hasOwnProperty.call(action.frozenInput as JsonObject, 'params'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(sources[0], 'value'), false);
    assert.equal((action.outcome as JsonObject).state, 'pending');
    assert.ok(parseSqlProjection(projection[0]), 'proposed SQL projection must satisfy the lifecycle parser');
    const replay = await admitFinding(FINDING_ACTION, 'fixture-query-action', {
      entityKind: 'room', entityId: TARGET_ID, entityLabel: 'Fixture room', title: 'Proposed fixture', summary: 'A generic action proposal.',
      proposalId, actionKind: 'room_annotation', actionDefinitionId: ACTION_DEFINITION, actionContract,
      frozenInput: { propertyId: PROPERTY_A, findingId: FINDING_ACTION, params: { note: 'fixture' }, verify: { targetId: TARGET_ID } },
      actionIdempotencyKey: 'fixture-action-1', lifecycleIdempotencyKey: 'fixture-action-lifecycle', approvalRequired: true,
      ownerKind: 'app', ownerLabel: 'Staxis', ownerRole: 'system',
    });
    assert.equal(replay.replayed, true);
    await assert.rejects(() => admitFinding(FINDING_ACTION, 'fixture-query-action', {
      entityKind: 'room', entityId: TARGET_ID, entityLabel: 'Fixture room', title: 'Proposed fixture', summary: 'A generic action proposal.',
      proposalId, actionKind: 'room_annotation', actionDefinitionId: ACTION_DEFINITION, actionContract,
      frozenInput: { propertyId: PROPERTY_A, findingId: FINDING_ACTION, params: { note: 'fixture' }, verify: { targetId: TARGET_ID } },
      actionIdempotencyKey: 'fixture-action-1', lifecycleIdempotencyKey: 'fixture-action-lifecycle', approvalRequired: true,
      ownerKind: 'app', ownerLabel: 'Staxis', ownerRole: 'system',
    }, 'changed_detector'));
  });

  test('serializes approval/execution proof, rejects out-of-order events, and verifies an outcome source fact', async () => {
    const lifecycleId = await lifecycleIdFor(FINDING_ACTION);
    const proposalId = 'aaaaaaaa-0000-4000-8000-000000000050';
    const missingIdempotency = await append({ lifecycleId, eventKind: 'state_transition', fromState: 'proposed', toState: 'approved', actorAccountId: ACCOUNT_A, actorSnapshot: { id: ACCOUNT_A, authority: 'admin', role: 'admin' }, ownerSnapshot: owner(), domainReference: {}, approvalProof: { decision: 'approved', policyId: 'fixture-policy', mode: 'explicit_card', tier: 'card' } });
    assert.equal(missingIdempotency.recorded, false);
    const missingFromState = await append({ lifecycleId, eventKind: 'state_transition', toState: 'approved', actorAccountId: ACCOUNT_A, actorSnapshot: { id: ACCOUNT_A, authority: 'admin', role: 'admin' }, ownerSnapshot: owner(), domainReference: {}, approvalProof: { decision: 'approved', policyId: 'fixture-policy', mode: 'explicit_card', tier: 'card' }, idempotencyKey: `${lifecycleId}:missing-from` });
    assert.equal(missingFromState.recorded, false);
    const malformedOwner = await append({ lifecycleId, eventKind: 'state_transition', fromState: 'proposed', toState: 'approved', actorAccountId: ACCOUNT_A, actorSnapshot: { id: ACCOUNT_A, authority: 'admin', role: 'admin' }, ownerSnapshot: { kind: 'bogus', label: null, role: null }, domainReference: {}, approvalProof: { decision: 'approved', policyId: 'fixture-policy', mode: 'explicit_card', tier: 'card' }, idempotencyKey: `${lifecycleId}:malformed-owner` });
    assert.equal(malformedOwner.recorded, false);
    const outOfOrder = await append({ lifecycleId, eventKind: 'state_transition', fromState: 'proposed', toState: 'executed', actorAccountId: ACCOUNT_A, actorSnapshot: { id: ACCOUNT_A, authority: 'admin' }, ownerSnapshot: owner(), domainReference: { kind: 'room', id: TARGET_ID, href: null }, idempotencyKey: `${lifecycleId}:bad-execute` });
    assert.equal(outOfOrder.recorded, false);
    const chain = await approveAndExecute(lifecycleId, proposalId, TARGET_ID);
    const executedProjection = await sql<JsonObject>(`select * from public.staxis_lifecycle_projection_v1 where projection_id = $1`, [lifecycleId]);
    assert.equal((executedProjection[0].outcome as JsonObject).state, 'pending');
    assert.ok(parseSqlProjection(executedProjection[0]), 'executed SQL projection must satisfy the lifecycle parser');
    const outcomeSource = await sourceFact({ externalReceiptId: 'fixture-outcome', sourceHash: digest('f'), entityId: TARGET_ID, effectiveAt: iso(1_000), asOf: iso(0), observedAt: iso(100), receivedAt: iso(200) });
    assert.equal(outcomeSource.recorded, true);
    const outcome = await append({ lifecycleId, eventKind: 'state_transition', fromState: 'executed', toState: 'outcome_verified', actorAccountId: ACCOUNT_A, actorSnapshot: { id: ACCOUNT_A, authority: 'admin', role: 'admin' }, ownerSnapshot: owner(), domainReference: { kind: 'room', id: TARGET_ID, label: null, href: null }, outcomeBasis: 'Durable fixture fact confirms the in-app result.', outcomeSourceFactId: outcomeSource.factId, idempotencyKey: `${lifecycleId}:outcome` });
    assert.equal(outcome.recorded, true);
    const replay = await append({ lifecycleId, eventKind: 'state_transition', fromState: 'executed', toState: 'outcome_verified', actorAccountId: ACCOUNT_A, actorSnapshot: { id: ACCOUNT_A, authority: 'admin', role: 'admin' }, ownerSnapshot: owner(), domainReference: { kind: 'room', id: TARGET_ID, label: null, href: null }, outcomeBasis: 'Durable fixture fact confirms the in-app result.', outcomeSourceFactId: outcomeSource.factId, idempotencyKey: `${lifecycleId}:outcome` });
    assert.equal(replay.replayed, true);
    const projection = await sql<JsonObject>(`select * from public.staxis_lifecycle_projection_v1 where projection_id = $1`, [lifecycleId]);
    assert.equal(projection[0].state, 'outcome_verified');
    assert.equal((projection[0].outcome as JsonObject).sourceFactId, outcomeSource.factId);
    assert.equal((projection[0].action as JsonObject).outcome && ((projection[0].action as JsonObject).outcome as JsonObject).state, 'verified');
    assert.ok(parseSqlProjection(projection[0]), 'verified SQL projection must satisfy the lifecycle parser');
    assert.ok(chain.executionEventId);
  });

  test('does not allow an unverifiable terminal to claim source-fact verification', async () => {
    const proposalId = 'aaaaaaaa-0000-4000-8000-000000000051';
    const admitted = await admitFinding(FINDING_UNOBSERVABLE, 'fixture-query-unobservable', {
      entityKind: 'room', entityId: TARGET_ID_2, entityLabel: 'Fixture room 2', title: 'Unobservable fixture', summary: 'A second proposal for terminal-state coverage.',
      proposalId, actionKind: 'room_annotation', actionDefinitionId: ACTION_DEFINITION, actionContract,
      frozenInput: { propertyId: PROPERTY_A, findingId: FINDING_UNOBSERVABLE, params: { note: 'fixture 2' }, verify: { targetId: TARGET_ID_2 } },
      actionIdempotencyKey: 'fixture-action-2', lifecycleIdempotencyKey: 'fixture-unobservable', approvalRequired: true,
      ownerKind: 'app', ownerLabel: 'Staxis', ownerRole: 'system',
    });
    assert.equal(admitted.admitted, true);
    const lifecycleId = await lifecycleIdFor(FINDING_UNOBSERVABLE);
    await approveAndExecute(lifecycleId, proposalId, TARGET_ID_2);
    const invalid = await append({ lifecycleId, eventKind: 'state_transition', fromState: 'executed', toState: 'unverifiable', actorAccountId: ACCOUNT_A, actorSnapshot: { id: ACCOUNT_A, authority: 'admin', role: 'admin' }, ownerSnapshot: owner(), domainReference: { kind: 'room', id: TARGET_ID_2, label: null, href: null }, outcomeBasis: 'No durable observation exists.', outcomeSourceFactId: sourceFactId, idempotencyKey: `${lifecycleId}:unverifiable` });
    assert.equal(invalid.recorded, false);
    const valid = await append({ lifecycleId, eventKind: 'state_transition', fromState: 'executed', toState: 'unverifiable', actorAccountId: ACCOUNT_A, actorSnapshot: { id: ACCOUNT_A, authority: 'admin', role: 'admin' }, ownerSnapshot: owner(), domainReference: { kind: 'room', id: TARGET_ID_2, label: null, href: null }, outcomeBasis: 'No durable observation exists.', idempotencyKey: `${lifecycleId}:unverifiable-valid` });
    assert.equal(valid.recorded, true);
    const projection = await sql<JsonObject>(`select * from public.staxis_lifecycle_projection_v1 where projection_id = $1`, [lifecycleId]);
    assert.ok(parseSqlProjection(projection[0]), 'unverifiable SQL projection must satisfy the lifecycle parser');
  });
});
