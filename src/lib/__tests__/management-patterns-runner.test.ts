import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  runScheduledManagementPatterns,
  type ManagementPatternRunnerDependencies,
} from '@/lib/company/management-patterns/runner';
import {
  ManagementPatternStore,
  ManagementPatternStoreError,
  type ManagementPatternRpcCall,
  type ManagementPatternRpcClient,
} from '@/lib/company/management-patterns/store';
import type { ManagementPatternSourceSnapshot } from '@/lib/company/management-patterns/source-snapshot';
import type { PreparedManagementPatternInputs } from '@/lib/company/management-patterns/prepare-inputs';
import type { ManagementPatternEvaluation } from '@/lib/company/management-patterns/evaluator';
import type { ManagementPatternPersistenceBundle } from '@/lib/company/management-patterns/persistence-bundle';
import {
  MANAGEMENT_PATTERN_MAX_INPUT_BATCH_BYTES,
  MANAGEMENT_PATTERN_SOURCE_QUERY_VERSION,
} from '@/lib/company/management-patterns/definitions';

const ORGANIZATION_ID = '10000000-0000-4000-8000-000000000001';
const OWNER_TOKEN = '20000000-0000-4000-8000-000000000002';
const RUN_ID_1 = '30000000-0000-4000-8000-000000000003';
const RUN_ID_2 = '40000000-0000-4000-8000-000000000004';
const NOW = new Date('2026-07-27T08:00:00.000Z');

type RpcResponse = Readonly<{
  data: unknown;
  error: Readonly<Record<string, string>> | null;
}>;

class ScriptedRpcClient implements ManagementPatternRpcClient {
  readonly calls: Array<Readonly<{ name: string; args: Record<string, unknown> }>> = [];

  constructor(private readonly responses: Record<string, RpcResponse[]>) {}

  rpc(name: string, args: Record<string, unknown>): ManagementPatternRpcCall {
    this.calls.push(Object.freeze({ name, args }));
    const response = this.responses[name]?.shift();
    if (!response) throw new Error(`unexpected RPC ${name}`);
    return Promise.resolve(response) as ManagementPatternRpcCall;
  }
}

function sourceSnapshot(evaluationAt: Date): ManagementPatternSourceSnapshot {
  return {
    schema_version: MANAGEMENT_PATTERN_SOURCE_QUERY_VERSION,
    query_id: 'management_pattern_source_snapshot',
    query_version: MANAGEMENT_PATTERN_SOURCE_QUERY_VERSION,
    organization: {
      id: ORGANIZATION_ID,
      organization_type: 'management_company',
      status: 'active',
    },
    evaluation_at: evaluationAt.toISOString(),
    source_as_of: evaluationAt.toISOString(),
    topology_as_of: evaluationAt.toISOString(),
    supply_window: { start_date: '2026-04-01', end_date: '2026-06-30' },
    activity_window: {
      start_date: '2026-04-21',
      end_date: '2026-07-27',
      history_days: 98,
    },
    property_count: 0,
    max_properties: 50,
    source_budget_exceeded: false,
    properties: [],
  };
}

function fixtures(evaluationAt: Date): Readonly<{
  snapshot: ManagementPatternSourceSnapshot;
  prepared: PreparedManagementPatternInputs;
  evaluation: ManagementPatternEvaluation;
  bundle: ManagementPatternPersistenceBundle;
}> {
  const snapshot = sourceSnapshot(evaluationAt);
  const prepared = {
    snapshot,
    properties: [],
    includedProperties: [],
    excludedProperties: [],
    fingerprint: 'b'.repeat(64),
  } as unknown as PreparedManagementPatternInputs;
  const evaluation = {
    schemaVersion: 'management-pattern-evaluator.v1',
    organizationId: ORGANIZATION_ID,
    evaluatedAt: evaluationAt.toISOString(),
    inputFingerprint: prepared.fingerprint,
    outcomes: [],
    manifestations: [],
    consolidation: {},
    candidates: [],
    budgetSuppressions: [],
    rootEvaluations: [{
      schemaVersion: 'management-pattern-evaluator.v1',
      semanticFamily: 'management_pattern_input_gate',
      rootKey: 'input-root',
      rootSubjectKey: 'portfolio_input_contract',
      checkIds: ['management_pattern_input_gate'],
      checkVersions: ['management-pattern-evaluator.v1'],
      conclusion: 'abstained',
      primaryOutcomeKey: 'input-gate',
      supportingOutcomeKeys: ['input-gate'],
      affectedPropertyIds: [],
      evaluatedPropertyIds: [],
      unavailablePropertyIds: [],
      reasonCodes: ['no_eligible_properties'],
      candidateFingerprints: [],
      fingerprint: 'c'.repeat(64),
    }],
    reasonCodes: ['no_eligible_properties'],
    fingerprint: 'd'.repeat(64),
  } as unknown as ManagementPatternEvaluation;
  const emptyResults = Object.freeze({
    cohorts: [],
    cohort_members: [],
    check_outcomes: [],
    check_observations: [],
    candidates: [],
    candidate_outcomes: [],
    candidate_properties: [],
    candidate_local_instances: [],
    run_roots: [],
    reconciliations: [],
    reconciliation_outcomes: [],
  });
  const bundle = {
    input: Object.freeze({ runProperties: [], metricObservations: [], metricSourceFacts: [] }),
    results: emptyResults,
    counts: Object.freeze({
      properties: 0,
      includedProperties: 0,
      excludedProperties: 0,
      cohorts: 0,
      cohortMembers: 0,
      observations: 0,
      sourceFacts: 0,
      observationLinks: 0,
      checks: 0,
      outcomes: 0,
      candidates: 0,
      abstentions: 0,
      qualityFailures: 0,
    }),
    fingerprint: 'e'.repeat(64),
  } satisfies ManagementPatternPersistenceBundle;
  return Object.freeze({ snapshot, prepared, evaluation, bundle });
}

function responseRows(runId = RUN_ID_1): Record<string, RpcResponse[]> {
  return {
    claim_management_pattern_run: [{
      data: [{
        outcome: 'claimed',
        run_id: runId,
        fencing_token: 1,
        lease_expires_at: '2026-07-27T08:01:30.000Z',
      }],
      error: null,
    }],
    append_management_pattern_input_batch: [{
      data: [{
        run_properties_inserted: 0,
        metric_observations_inserted: 0,
        metric_source_facts_inserted: 0,
      }],
      error: null,
    }],
    append_management_pattern_result_batch: [{
      data: [{
        outcome: 'applied',
        batch_hash: 'a'.repeat(64),
        row_counts: Object.fromEntries([
          'cohorts', 'cohort_members', 'check_outcomes', 'check_observations',
          'candidates', 'candidate_outcomes', 'candidate_properties',
          'candidate_local_instances', 'run_roots', 'reconciliations',
          'reconciliation_outcomes',
        ].map((key) => [key, 0])),
      }],
      error: null,
    }],
    finalize_management_pattern_run: [{
      data: [{ outcome: 'finalized', run_id: runId }],
      error: null,
    }],
  };
}

function dependencies(
  client: ScriptedRpcClient,
  fixture = fixtures(NOW),
): ManagementPatternRunnerDependencies {
  return {
    loadSource: async ({ evaluationAt }) => {
      assert.equal(evaluationAt.toISOString(), NOW.toISOString());
      return fixture.snapshot;
    },
    prepare: () => fixture.prepared,
    evaluate: () => fixture.evaluation,
    buildBundle: () => fixture.bundle,
    createStore: (signal) => new ManagementPatternStore(client, signal),
    ownerToken: () => OWNER_TOKEN,
  };
}

describe('management-pattern shadow runner', () => {
  test('seals one atomic shadow run with zero AI budget and no projection call', async () => {
    const client = new ScriptedRpcClient(responseRows());
    const result = await runScheduledManagementPatterns(
      { organizationId: ORGANIZATION_ID, now: NOW },
      dependencies(client),
    );

    assert.equal(result.outcome, 'completed');
    assert.equal(result.terminalStatus, 'abstained');
    assert.equal(result.projectionMode, 'shadow');
    assert.equal(result.dbQueryCount, 5); // source + four persistence boundaries
    assert.deepEqual(
      client.calls.map((call) => call.name),
      [
        'claim_management_pattern_run',
        'append_management_pattern_input_batch',
        'append_management_pattern_result_batch',
        'finalize_management_pattern_run',
      ],
    );
    const claim = client.calls[0].args;
    assert.equal(claim.p_organization_id, ORGANIZATION_ID);
    assert.equal(claim.p_projection_mode, 'shadow');
    assert.equal(claim.p_model_call_budget, 0);
    assert.equal(claim.p_token_budget, 0);
    assert.equal(claim.p_cost_budget_microusd, 0);
    assert.equal(claim.p_triggered_by, 'scheduled');
    const finalize = client.calls.at(-1)?.args;
    assert.equal(finalize?.p_terminal_status, 'abstained');
    assert.equal(finalize?.p_db_query_count, 6); // reserves one ambiguous finalize retry
  });

  test('revisions supersede a conflicting immutable run instead of mixing inputs', async () => {
    const responses = responseRows(RUN_ID_2);
    responses.claim_management_pattern_run.unshift({
      data: [{
        outcome: 'input_conflict',
        run_id: RUN_ID_1,
        fencing_token: 1,
        lease_expires_at: '2026-07-27T08:01:30.000Z',
      }],
      error: null,
    });
    const client = new ScriptedRpcClient(responses);
    const result = await runScheduledManagementPatterns(
      { organizationId: ORGANIZATION_ID, now: NOW },
      dependencies(client),
    );

    assert.equal(result.runId, RUN_ID_2);
    const claims = client.calls.filter((call) => call.name === 'claim_management_pattern_run');
    assert.equal(claims.length, 2);
    assert.notEqual(claims[0].args.p_run_key, claims[1].args.p_run_key);
    assert.equal(claims[1].args.p_supersedes_run_id, RUN_ID_1);
    assert.match(String(claims[1].args.p_run_key), /revision-[0-9a-f]{64}$/);
  });

  test('retries an ambiguous input write with the exact same fenced payload', async () => {
    const responses = responseRows();
    responses.append_management_pattern_input_batch.unshift({
      data: null,
      error: { message: 'connection reset after request send' },
    });
    const client = new ScriptedRpcClient(responses);
    const result = await runScheduledManagementPatterns(
      { organizationId: ORGANIZATION_ID, now: NOW },
      dependencies(client),
    );

    assert.equal(result.outcome, 'completed');
    const writes = client.calls.filter((call) => (
      call.name === 'append_management_pattern_input_batch'
    ));
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[0].args, writes[1].args);
    assert.equal(result.dbQueryCount, 6);
  });

  test('accepts an already-applied receipt after an ambiguous result write', async () => {
    const responses = responseRows();
    const applied = responses.append_management_pattern_result_batch[0];
    responses.append_management_pattern_result_batch = [
      { data: null, error: { message: 'network timeout after send' } },
      {
        data: [{
          ...(applied.data as Array<Record<string, unknown>>)[0],
          outcome: 'already_applied',
        }],
        error: null,
      },
    ];
    const client = new ScriptedRpcClient(responses);
    const result = await runScheduledManagementPatterns(
      { organizationId: ORGANIZATION_ID, now: NOW },
      dependencies(client),
    );

    assert.equal(result.outcome, 'completed');
    const writes = client.calls.filter((call) => (
      call.name === 'append_management_pattern_result_batch'
    ));
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[0].args, writes[1].args);
    assert.equal(
      client.calls.filter((call) => call.name === 'finalize_management_pattern_run').length,
      1,
    );
  });

  test('retries a lost finalize response and accepts the terminal receipt', async () => {
    const responses = responseRows();
    responses.finalize_management_pattern_run = [
      { data: null, error: { message: 'socket closed after commit' } },
      {
        data: [{ outcome: 'already_finalized', run_id: RUN_ID_1 }],
        error: null,
      },
    ];
    const client = new ScriptedRpcClient(responses);
    const result = await runScheduledManagementPatterns(
      { organizationId: ORGANIZATION_ID, now: NOW },
      dependencies(client),
    );

    assert.equal(result.outcome, 'completed');
    assert.equal(result.dbQueryCount, 6);
    const finalizes = client.calls.filter((call) => (
      call.name === 'finalize_management_pattern_run'
    ));
    assert.equal(finalizes.length, 2);
    assert.deepEqual(finalizes[0].args, finalizes[1].args);
    assert.equal(finalizes[0].args.p_db_query_count, 6);
  });

  for (const terminalClaim of ['already_complete', 'busy'] as const) {
    test(`${terminalClaim} returns without any evidence write`, async () => {
      const responses = responseRows();
      responses.claim_management_pattern_run[0] = {
        data: [{
          outcome: terminalClaim,
          run_id: RUN_ID_1,
          fencing_token: 1,
          lease_expires_at: '2026-07-27T08:01:30.000Z',
        }],
        error: null,
      };
      const client = new ScriptedRpcClient(responses);
      const result = await runScheduledManagementPatterns(
        { organizationId: ORGANIZATION_ID, now: NOW },
        dependencies(client),
      );

      assert.equal(result.outcome, terminalClaim);
      assert.deepEqual(client.calls.map((call) => call.name), [
        'claim_management_pattern_run',
      ]);
      assert.equal(result.projectionMode, 'shadow');
    });
  }

  test('does not finalize when an atomic result commit remains ambiguous', async () => {
    const responses = responseRows();
    responses.append_management_pattern_result_batch = [
      { data: null, error: { message: 'network timeout' } },
      { data: null, error: { message: 'network timeout' } },
    ];
    const client = new ScriptedRpcClient(responses);
    await assert.rejects(
      () => runScheduledManagementPatterns(
        { organizationId: ORGANIZATION_ID, now: NOW },
        dependencies(client),
      ),
      (error: unknown) => (
        error instanceof ManagementPatternStoreError
        && error.ambiguousCommit
      ),
    );
    assert.equal(
      client.calls.some((call) => call.name === 'finalize_management_pattern_run'),
      false,
    );
  });

  test('bounds immutable conflict revisions and never writes an unclaimed run', async () => {
    const conflict = (runId: string): RpcResponse => ({
      data: [{
        outcome: 'input_conflict',
        run_id: runId,
        fencing_token: 1,
        lease_expires_at: '2026-07-27T08:01:30.000Z',
      }],
      error: null,
    });
    const responses = responseRows();
    responses.claim_management_pattern_run = [
      conflict(RUN_ID_1),
      conflict(RUN_ID_2),
      conflict('50000000-0000-4000-8000-000000000005'),
    ];
    const client = new ScriptedRpcClient(responses);
    await assert.rejects(
      () => runScheduledManagementPatterns(
        { organizationId: ORGANIZATION_ID, now: NOW },
        dependencies(client),
      ),
      /exhausted bounded revision claims/,
    );
    assert.equal(
      client.calls.filter((call) => call.name === 'claim_management_pattern_run').length,
      3,
    );
    assert.equal(
      client.calls.some((call) => call.name.startsWith('append_management_pattern_')),
      false,
    );
  });

  test('seals a known rolled-back input error as failed with sanitized detail', async () => {
    const responses = responseRows();
    responses.append_management_pattern_input_batch = [{
      data: null,
      error: { code: '23514', message: 'known check violation' },
    }];
    const client = new ScriptedRpcClient(responses);
    await assert.rejects(
      () => runScheduledManagementPatterns(
        { organizationId: ORGANIZATION_ID, now: NOW },
        dependencies(client),
      ),
      ManagementPatternStoreError,
    );
    const finalize = client.calls.find((call) => call.name === 'finalize_management_pattern_run');
    assert.ok(finalize);
    assert.equal(finalize.args.p_terminal_status, 'failed');
    assert.equal(finalize.args.p_property_count, 0);
    assert.deepEqual(finalize.args.p_error_detail, {
      code: 'management_pattern_run_failed',
      stage: 'claimed',
      error_kind: 'database_boundary',
      database_code: '23514',
      ambiguous_commit: false,
    });
  });

  test('retains committed source-fact counts when the result transaction fails', async () => {
    const base = fixtures(NOW);
    const metricSourceFacts = Object.freeze([
      Object.freeze({ observation_id: RUN_ID_1, fact_key: '2026-06-01' }),
      Object.freeze({ observation_id: RUN_ID_1, fact_key: '2026-06-02' }),
    ]);
    const fixture = Object.freeze({
      ...base,
      bundle: Object.freeze({
        ...base.bundle,
        input: Object.freeze({ ...base.bundle.input, metricSourceFacts }),
        counts: Object.freeze({ ...base.bundle.counts, sourceFacts: metricSourceFacts.length }),
      }),
    });
    const responses = responseRows();
    responses.append_management_pattern_input_batch[0] = {
      data: [{
        run_properties_inserted: 0,
        metric_observations_inserted: 0,
        metric_source_facts_inserted: metricSourceFacts.length,
      }],
      error: null,
    };
    responses.append_management_pattern_result_batch = [{
      data: null,
      error: { code: '23514', message: 'known result check violation' },
    }];
    const client = new ScriptedRpcClient(responses);

    await assert.rejects(
      () => runScheduledManagementPatterns(
        { organizationId: ORGANIZATION_ID, now: NOW },
        dependencies(client, fixture),
      ),
      ManagementPatternStoreError,
    );

    const finalize = client.calls.find((call) => call.name === 'finalize_management_pattern_run');
    assert.ok(finalize);
    assert.equal(finalize.args.p_terminal_status, 'failed');
    assert.equal(finalize.args.p_observation_count, 0);
    assert.equal(finalize.args.p_source_fact_count, metricSourceFacts.length);
    const performance = finalize.args.p_performance_summary as Record<string, unknown>;
    assert.equal(performance.input_batch_max_bytes, MANAGEMENT_PATTERN_MAX_INPUT_BATCH_BYTES);
    assert.ok(Number(performance.input_batch_bytes) > 0);
  });

  test('treats a partial atomic-input receipt as ambiguous and never writes results', async () => {
    const base = fixtures(NOW);
    const metricSourceFacts = Object.freeze([
      Object.freeze({ observation_id: RUN_ID_1, fact_key: '2026-06-01' }),
      Object.freeze({ observation_id: RUN_ID_1, fact_key: '2026-06-02' }),
    ]);
    const fixture = Object.freeze({
      ...base,
      bundle: Object.freeze({
        ...base.bundle,
        input: Object.freeze({ ...base.bundle.input, metricSourceFacts }),
        counts: Object.freeze({ ...base.bundle.counts, sourceFacts: metricSourceFacts.length }),
      }),
    });
    const responses = responseRows();
    responses.append_management_pattern_input_batch[0] = {
      data: [{
        run_properties_inserted: 0,
        metric_observations_inserted: 0,
        metric_source_facts_inserted: 1,
      }],
      error: null,
    };
    const client = new ScriptedRpcClient(responses);

    await assert.rejects(
      () => runScheduledManagementPatterns(
        { organizationId: ORGANIZATION_ID, now: NOW },
        dependencies(client, fixture),
      ),
      (error: unknown) => (
        error instanceof ManagementPatternStoreError
        && error.ambiguousCommit
        && error.code === 'receipt_mismatch'
      ),
    );
    assert.equal(
      client.calls.some((call) => call.name === 'append_management_pattern_result_batch'),
      false,
    );
    assert.equal(
      client.calls.some((call) => call.name === 'finalize_management_pattern_run'),
      false,
    );
  });

  test('rejects an oversized exact-source input before claiming a run', async () => {
    const base = fixtures(NOW);
    const metricSourceFacts = Object.freeze([Object.freeze({
      fact_payload: Object.freeze({
        padding: 'x'.repeat(MANAGEMENT_PATTERN_MAX_INPUT_BATCH_BYTES),
      }),
    })]);
    const fixture = Object.freeze({
      ...base,
      bundle: Object.freeze({
        ...base.bundle,
        input: Object.freeze({ ...base.bundle.input, metricSourceFacts }),
        counts: Object.freeze({ ...base.bundle.counts, sourceFacts: 1 }),
      }),
    });
    const client = new ScriptedRpcClient(responseRows());

    await assert.rejects(
      () => runScheduledManagementPatterns(
        { organizationId: ORGANIZATION_ID, now: NOW },
        dependencies(client, fixture),
      ),
      new RegExp(`input batch exceeds ${MANAGEMENT_PATTERN_MAX_INPUT_BATCH_BYTES} bytes`),
    );
    assert.equal(client.calls.length, 0);
  });
});
