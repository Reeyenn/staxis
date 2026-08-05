import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import type { PGlite } from '@electric-sql/pglite';

import {
  buildPortfolioFindingProjection,
  buildPortfolioFindingNotMountedReceipt,
  buildPortfolioFindingProjectionReceipt,
  consumePortfolioFindings,
  validatePortfolioFindingReceipt,
  type PortfolioFindingProducerMetadataV1,
  type PortfolioFindingReceiptV1,
} from '@/lib/agent/portfolio-intelligence/pattern-contract';

import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';
import {
  ACCOUNT_MARIA,
  ORG_A,
  PID_A1,
  seedTwoCompanies,
} from '../../../tests/fixtures/pglite-two-company-seed';

interface ScopeReceipt {
  id: string;
  authorizationHash: string;
  scopeHash: string;
  authorizedPropertyIds: string[];
  propertyIds: string[];
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  throw new TypeError('test finding receipt contains a non-JSON value');
}

function resignFindingReceipt(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const withoutHash = structuredClone(value);
  delete withoutHash.receiptHash;
  return { ...withoutHash, receiptHash: sha256(canonicalJson(withoutHash)) };
}

function resignMountedFindingReceipt(
  value: Record<string, unknown>,
  options: { recomputeProjection?: boolean } = {},
): Record<string, unknown> {
  const receipt = structuredClone(value);
  delete receipt.receiptHash;
  if (receipt.status !== 'not_mounted' && options.recomputeProjection !== false) {
    const counts = receipt.counts as Record<string, unknown>;
    const projectionPayload = {
      version: receipt.projectionVersion,
      status: receipt.status,
      accountId: receipt.accountId,
      organizationId: receipt.organizationId,
      scopeReceiptId: receipt.scopeReceiptId,
      authorizationHash: receipt.authorizationHash,
      scopeHash: receipt.scopeHash,
      consumedAt: receipt.consumedAt,
      producer: receipt.producer,
      source: receipt.source,
      acceptedClaimIds: receipt.acceptedClaimIds,
      projectedClaimIds: receipt.projectedClaimIds,
      itemOmittedClaimIds: receipt.itemOmittedClaimIds,
      characterOmittedClaimIds: receipt.characterOmittedClaimIds,
      counts: {
        input: counts.input,
        accepted: counts.accepted,
        projected: counts.projected,
        rejected: counts.rejected,
        smallCohortSuppressed: counts.smallCohortSuppressed,
      },
      coverage: receipt.coverage,
      truncation: receipt.truncation,
      outage: receipt.outage,
      rejectionSummary: receipt.rejectionSummary,
      rejectionSummaryOmittedCount: receipt.rejectionSummaryOmittedCount,
      exclusionSummary: receipt.projectionExclusionSummary,
      exclusionSummaryOmittedCount: receipt.projectionExclusionSummaryOmittedCount,
      prompt: receipt.prompt,
    };
    receipt.projectionHash = sha256(canonicalJson(projectionPayload));
  }
  return { ...receipt, receiptHash: sha256(canonicalJson(receipt)) };
}

function jsonValue<T>(value: unknown): T {
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

async function resolveScope(pg: PGlite): Promise<ScopeReceipt> {
  const result = await pg.query<{ result: unknown }>(
    `select public.staxis_resolve_authorization_scope(
       $1::uuid, $2::uuid, 'all_authorized', null::uuid, null::jsonb, 300
     ) as result`,
    [ACCOUNT_MARIA, ORG_A],
  );
  const payload = jsonValue<{ ok: boolean; reason?: string; receipt?: ScopeReceipt }>(
    result.rows[0]?.result,
  );
  assert.equal(payload.ok, true, payload.reason);
  assert.ok(payload.receipt);
  return payload.receipt;
}

describe('0399 exact portfolio model request artifacts', () => {
  let pg: PGlite;
  let receipt: ScopeReceipt;
  let findingVersions: PortfolioFindingReceiptV1;
  let notMountedFindingVersions: PortfolioFindingReceiptV1;
  let nullableFindingVersions: PortfolioFindingReceiptV1[];
  let runBearingFindingVersions: PortfolioFindingReceiptV1;
  let precedenceFindingVersions: PortfolioFindingReceiptV1[];
  let additionalZeroFindingVersions: PortfolioFindingReceiptV1[];
  let runReasonFindingVersions: PortfolioFindingReceiptV1;
  let loadedFindingVersions: PortfolioFindingReceiptV1;
  let loadedFindingClaimId: string;
  let zeroClaimLoadedFindingVersions: PortfolioFindingReceiptV1;

  const question = 'How are all my hotels doing?';
  const presentationPlan = {
    version: 'portfolio-presentation-plan.v1',
    lead: 'scope_first',
    orderedClaimIds: [],
  };
  const modelCandidate = JSON.stringify(presentationPlan);
  const renderedAnswer = 'Scope: 2 authorized hotels. Both hotels reported canonical booked-room facts.';
  const promptVersion = 'portfolio-synthesis.test.v1';
  const promptHash = sha256('exact composed prompt fixture');
  const rendererVersion = 'portfolio-deterministic-renderer.v1';
  const queryPlan = {
    version: 'portfolio-query-plan.v1',
    intent: 'portfolio_summary',
    selector: { type: 'all_authorized' },
  };
  const evidence = {
    version: 'portfolio-evidence.v1',
    organizationId: ORG_A,
    selectedPropertyIds: [PID_A1],
  };
  const pricing = {
    inputUsdPerMillionTokens: 3,
    outputUsdPerMillionTokens: 15,
    cachedInputUsdPerMillionTokens: 0.3,
    cacheCreation5mInputUsdPerMillionTokens: 3.75,
    cacheCreation1hInputUsdPerMillionTokens: 6,
    source: 'test',
    asOf: 'test',
  };
  const configuredExecution = {
    featureKey: 'agent.portfolio_chat',
    source: 'database',
    versionId: 'config-17',
    version: 17,
    primary: { provider: 'anthropic', modelId: 'claude-primary-alias', pricing },
    fallback: { provider: 'anthropic', modelId: 'claude-fallback-alias', pricing },
  };
  const appliedParameters = {
    provider: 'anthropic',
    requestedModelId: 'claude-fallback-alias',
    responseModelId: 'claude-fallback-snapshot-20260720',
    max_tokens: 8192,
    tools: null,
  };
  const providerRequest = {
    version: 'portfolio-model-request.v1',
    runtime: 'messages.create',
    attempts: [
      {
        ordinal: 0,
        provider: 'anthropic',
        requestedModelId: 'claude-primary-alias',
        request: {
          model: 'claude-primary-alias',
          max_tokens: 8192,
          system: [{ type: 'text', text: 'stable prompt', cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: question }],
        },
        outcome: 'rejected',
        response: {
          id: 'msg_primary_200',
          type: 'message',
          role: 'assistant',
          model: 'claude-primary-snapshot-20260727',
          content: [{ type: 'text', text: 'schema-invalid but billable' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: {
            input_tokens: 11,
            output_tokens: 2,
            cache_read_input_tokens: 3,
            cache_creation_input_tokens: 5,
            cache_creation: {
              ephemeral_5m_input_tokens: 2,
              ephemeral_1h_input_tokens: 3,
            },
          },
        },
        responseModelId: 'claude-primary-snapshot-20260727',
        billableUsage: {
          inputTokens: 19,
          uncachedInputTokens: 11,
          outputTokens: 2,
          cachedInputTokens: 3,
          cacheCreationInputTokens: 5,
          cacheCreation5mInputTokens: 2,
          cacheCreation1hInputTokens: 3,
        },
        failureName: 'SyntaxError',
      },
      {
        ordinal: 1,
        provider: 'anthropic',
        requestedModelId: 'claude-fallback-alias',
        request: {
          model: 'claude-fallback-alias',
          max_tokens: 8192,
          system: [{ type: 'text', text: 'stable prompt', cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: question }],
        },
        outcome: 'succeeded',
        response: {
          id: 'msg_fallback_200',
          type: 'message',
          role: 'assistant',
          model: 'claude-fallback-snapshot-20260720',
          content: [{ type: 'text', text: modelCandidate }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: {
            input_tokens: 17,
            output_tokens: 4,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_creation: null,
          },
        },
        responseModelId: 'claude-fallback-snapshot-20260720',
        billableUsage: {
          inputTokens: 17,
          uncachedInputTokens: 17,
          outputTokens: 4,
          cachedInputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheCreation5mInputTokens: 0,
          cacheCreation1hInputTokens: 0,
        },
        failureName: null,
      },
    ],
  };

  before(async () => {
  const migrated = await applyMigrationsToPglite();
    pg = migrated.pg;
    const failure = migrated.report.failedAtRuntime.find(
      (entry) => entry.file === '0399_portfolio_model_request_artifacts.sql',
    );
    assert.equal(failure, undefined, failure?.error);
    assert.ok(migrated.report.applied.includes('0399_portfolio_model_request_artifacts.sql'));
    const artifactFailure = migrated.report.failedAtRuntime.find(
      (entry) => entry.file === '0405_deterministic_portfolio_knowledge_artifacts.sql',
    );
    assert.equal(artifactFailure, undefined, artifactFailure?.error);
    assert.ok(migrated.report.applied.includes(
      '0405_deterministic_portfolio_knowledge_artifacts.sql',
    ));
    await seedTwoCompanies(pg);
    receipt = await resolveScope(pg);
    notMountedFindingVersions = buildPortfolioFindingNotMountedReceipt({
      organizationId: ORG_A,
      scopeReceiptId: receipt.id,
      scopeHash: receipt.scopeHash,
    });
    const packageValue = consumePortfolioFindings({
      organizationId: ORG_A,
      scopeReceiptId: receipt.id,
      authorizedPropertyIds: receipt.authorizedPropertyIds,
      selectedPropertyIds: receipt.propertyIds,
      now: '2026-07-28T12:00:00.000Z',
      findings: [],
    });
    const producer: PortfolioFindingProducerMetadataV1 = {
      loadVersion: 'management-pattern-portfolio-load.v1',
      loadedAt: '2026-07-28T12:00:00.000Z',
      accountId: ACCOUNT_MARIA,
      organizationId: ORG_A,
      scopeReceiptId: receipt.id,
      selectedPropertyIds: [...receipt.propertyIds],
      authorizationHash: receipt.authorizationHash,
      scopeHash: receipt.scopeHash,
      projectionMode: null,
      status: 'no_finalized_run',
      contractVersion: 'portfolio-finding.v1',
      run: null,
      sourceAvailableCandidateCount: 0,
      omittedByLimitCount: 0,
      selectionWasTruncated: false,
      coverage: {
        authorizedPropertyCount: receipt.authorizedPropertyIds.length,
        selectedPropertyCount: receipt.propertyIds.length,
        evaluatedPropertyCount: 0,
        affectedPropertyCount: 0,
        sourceCandidateCount: 0,
        findingCount: 0,
      },
      truncation: { occurred: false, limit: 40, omittedCount: 0 },
      outage: { occurred: false, stage: null, reason: null },
      exclusions: [{ code: 'no_finalized_run', count: 1 }],
      rejectedCandidates: [],
      fingerprint: '3'.repeat(64),
    };
    findingVersions = buildPortfolioFindingProjectionReceipt({
      projection: buildPortfolioFindingProjection({
        packageValue,
        accountId: ACCOUNT_MARIA,
        authorizationHash: receipt.authorizationHash,
        scopeHash: receipt.scopeHash,
        maxProjectedItems: 40,
        status: 'no_finalized_run',
        producer,
      }),
      displayedClaimIds: [],
    });

    const nullableStates = [
      {
        status: 'unavailable' as const,
        outage: {
          occurred: true as const,
          stage: 'authorization_before_read' as const,
          reason: 'authorization_unavailable',
        },
        exclusion: { code: 'authorization_unavailable', count: 1 },
      },
      {
        status: 'scope_changed' as const,
        outage: { occurred: false as const, stage: null, reason: null },
        exclusion: { code: 'revoked_or_changed', count: 1 },
      },
    ];
    nullableFindingVersions = nullableStates.map((state, index) => {
      const nullableProducer: PortfolioFindingProducerMetadataV1 = {
        ...structuredClone(producer),
        organizationId: null,
        authorizationHash: null,
        scopeHash: null,
        status: state.status,
        outage: state.outage,
        exclusions: [state.exclusion],
        coverage: {
          ...producer.coverage,
          authorizedPropertyCount: null,
        },
        fingerprint: String(4 + index).repeat(64),
      };
      return buildPortfolioFindingProjectionReceipt({
        projection: buildPortfolioFindingProjection({
          packageValue,
          accountId: ACCOUNT_MARIA,
          authorizationHash: receipt.authorizationHash,
          scopeHash: receipt.scopeHash,
          maxProjectedItems: 40,
          status: state.status,
          producer: nullableProducer,
        }),
        displayedClaimIds: [],
      });
    });

    const runBearingProducer: PortfolioFindingProducerMetadataV1 = {
      ...structuredClone(producer),
      projectionMode: 'active',
      status: 'no_applicable_findings',
      run: {
        runId: null,
        runFingerprint: null,
        portfolioSnapshotFingerprint: null,
        projectionMode: 'active',
        engineVersion: 'management-pattern-engine.v1',
        evidenceSchemaVersion: 1,
        cohortPolicyVersion: 'cohort-policy.v1',
        normalizationPolicyVersion: 'normalization-policy.v1',
        dedupePolicyVersion: 'dedupe-policy.v1',
        scopePolicyVersion: 'scope-policy.v1',
        sourceQueryId: 'portfolio-findings-query',
        sourceQueryVersion: 'portfolio-findings-query.v1',
        evaluationAt: '2026-07-28T11:30:00.000Z',
        sourceAsOf: '2026-07-28T11:45:00.000Z',
        windowStart: '2026-07-27T00:00:00.000Z',
        windowEnd: '2026-07-28T11:45:00.000Z',
        completedAt: '2026-07-28T11:50:00.000Z',
        validThrough: '2026-08-05T11:30:00.000Z',
        terminalStatus: 'succeeded',
        coverage: {
          selectedPropertyCount: receipt.propertyIds.length,
          snapshotPropertyCount: receipt.propertyIds.length,
          includedPropertyCount: receipt.propertyIds.length,
          excludedPropertyCount: 0,
          missingFromRunCount: 0,
          exclusionReasons: [],
          exclusionReasonCodeCount: 0,
          exclusionReasonsTruncated: false,
        },
      },
      exclusions: [{ code: 'no_applicable_findings', count: 1 }],
      fingerprint: '6'.repeat(64),
    };
    runBearingFindingVersions = buildPortfolioFindingProjectionReceipt({
      projection: buildPortfolioFindingProjection({
        packageValue,
        accountId: ACCOUNT_MARIA,
        authorizationHash: receipt.authorizationHash,
        scopeHash: receipt.scopeHash,
        maxProjectedItems: 40,
        status: 'no_applicable_findings',
        producer: runBearingProducer,
      }),
      displayedClaimIds: [],
    });

    const shadowAbstainedProducer: PortfolioFindingProducerMetadataV1 = {
      ...structuredClone(runBearingProducer),
      projectionMode: 'shadow',
      status: 'shadow_only',
      run: {
        ...structuredClone(runBearingProducer.run!),
        projectionMode: 'shadow',
        terminalStatus: 'abstained',
      },
      exclusions: [{ code: 'shadow_only', count: 1 }],
      fingerprint: 'b'.repeat(64),
    };
    const staleAbstainedProducer: PortfolioFindingProducerMetadataV1 = {
      ...structuredClone(runBearingProducer),
      status: 'stale',
      run: {
        ...structuredClone(runBearingProducer.run!),
        evaluationAt: '2026-07-20T11:59:00.000Z',
        validThrough: '2026-07-28T11:59:00.000Z',
        terminalStatus: 'abstained',
      },
      exclusions: [{ code: 'stale', count: 1 }],
      fingerprint: 'c'.repeat(64),
    };
    precedenceFindingVersions = [
      { status: 'shadow_only' as const, producer: shadowAbstainedProducer },
      { status: 'stale' as const, producer: staleAbstainedProducer },
    ].map(({ status, producer: precedenceProducer }) => (
      buildPortfolioFindingProjectionReceipt({
        projection: buildPortfolioFindingProjection({
          packageValue,
          accountId: ACCOUNT_MARIA,
          authorizationHash: receipt.authorizationHash,
          scopeHash: receipt.scopeHash,
          maxProjectedItems: 40,
          status,
          producer: precedenceProducer,
        }),
        displayedClaimIds: [],
      })
    ));

    const additionalZeroProducers: Array<{
      status: 'abstained' | 'incomplete_scope' | 'scope_too_large' | 'scope_changed' | 'unavailable';
      producer: PortfolioFindingProducerMetadataV1;
    }> = [
      {
        status: 'abstained',
        producer: {
          ...structuredClone(runBearingProducer),
          status: 'abstained',
          run: {
            ...structuredClone(runBearingProducer.run!),
            terminalStatus: 'abstained',
          },
          exclusions: [{ code: 'abstained', count: 1 }],
          fingerprint: 'd'.repeat(64),
        },
      },
      {
        status: 'incomplete_scope',
        producer: {
          ...structuredClone(runBearingProducer),
          status: 'incomplete_scope',
          run: {
            ...structuredClone(runBearingProducer.run!),
            coverage: {
              ...structuredClone(runBearingProducer.run!.coverage),
              snapshotPropertyCount: receipt.propertyIds.length - 1,
              includedPropertyCount: receipt.propertyIds.length - 1,
              missingFromRunCount: 1,
            },
          },
          exclusions: [
            { code: 'incomplete_scope', count: 1 },
            { code: 'property_missing_from_run', count: 1 },
          ],
          fingerprint: 'e'.repeat(64),
        },
      },
      {
        status: 'scope_too_large',
        producer: {
          ...structuredClone(producer),
          status: 'scope_too_large',
          exclusions: [{ code: 'consumer_scope_limit_exceeded', count: 1 }],
          fingerprint: 'f'.repeat(64),
        },
      },
      {
        status: 'scope_changed',
        producer: {
          ...structuredClone(producer),
          status: 'scope_changed',
          exclusions: [{ code: 'selected_scope_mismatch', count: 1 }],
          fingerprint: '1'.repeat(64),
        },
      },
      {
        status: 'unavailable',
        producer: {
          ...structuredClone(producer),
          status: 'unavailable',
          outage: {
            occurred: true,
            stage: 'source_read',
            reason: 'source_unavailable',
          },
          exclusions: [{ code: 'source_unavailable', count: 1 }],
          fingerprint: '2'.repeat(64),
        },
      },
    ];
    additionalZeroFindingVersions = additionalZeroProducers.map((item) => (
      buildPortfolioFindingProjectionReceipt({
        projection: buildPortfolioFindingProjection({
          packageValue,
          accountId: ACCOUNT_MARIA,
          authorizationHash: receipt.authorizationHash,
          scopeHash: receipt.scopeHash,
          maxProjectedItems: 40,
          status: item.status,
          producer: item.producer,
        }),
        displayedClaimIds: [],
      })
    ));

    const runExclusionReasons = Array.from({ length: 50 }, (_, index) => ({
      code: `diagnostic_reason_${String(index).padStart(2, '0')}`,
      count: 1,
    }));
    const runReasonProducer: PortfolioFindingProducerMetadataV1 = {
      ...structuredClone(runBearingProducer),
      run: {
        ...structuredClone(runBearingProducer.run!),
        coverage: {
          ...structuredClone(runBearingProducer.run!.coverage),
          exclusionReasons: runExclusionReasons,
          exclusionReasonCodeCount: 251,
          exclusionReasonsTruncated: true,
        },
      },
      exclusions: [
        { code: 'no_applicable_findings', count: 1 },
        ...runExclusionReasons.map((reason) => ({
          code: `run/${reason.code}`,
          count: reason.count,
        })),
        { code: 'run/exclusion_reason_budget', count: 201 },
      ].sort((left, right) => left.code.localeCompare(right.code)),
      fingerprint: '0'.repeat(64),
    };
    runReasonFindingVersions = buildPortfolioFindingProjectionReceipt({
      projection: buildPortfolioFindingProjection({
        packageValue,
        accountId: ACCOUNT_MARIA,
        authorizationHash: receipt.authorizationHash,
        scopeHash: receipt.scopeHash,
        maxProjectedItems: 40,
        status: 'no_applicable_findings',
        producer: runReasonProducer,
      }),
      displayedClaimIds: [],
    });

    const runId = '44444444-4444-4444-8444-444444444444';
    const runFingerprint = '7'.repeat(64);
    const loadedPackage = consumePortfolioFindings({
      organizationId: ORG_A,
      scopeReceiptId: receipt.id,
      authorizedPropertyIds: receipt.authorizedPropertyIds,
      selectedPropertyIds: receipt.propertyIds,
      now: '2026-07-28T12:00:00.000Z',
      findings: [{
        version: 'portfolio-finding.v1',
        findingId: 'dddddddd-0000-4000-8000-000000000001',
        organizationId: ORG_A,
        producer: {
          engineId: 'management-patterns',
          engineVersion: 'management-pattern-engine.v1',
          runId,
          runFingerprint,
          producedAt: '2026-07-28T11:50:00.000Z',
        },
        lifecycle: { status: 'active', validThrough: '2026-08-05T11:30:00.000Z' },
        scope: {
          organizationId: ORG_A,
          kind: 'property_local',
          evaluatedPropertyIds: [PID_A1],
          affectedPropertyIds: [PID_A1],
          groupId: null,
          scopeFingerprint: 'stable-sha256.v1:scope-model-artifact',
        },
        claim: {
          kind: 'fact',
          factType: 'observed',
          statement: 'Hotel A recorded 12 booked rooms.',
          metricIds: ['booked_rooms'],
        },
        evidence: {
          evidenceFingerprint: 'stable-sha256.v1:evidence-model-artifact',
          queryId: 'portfolio-findings-query',
          queryVersion: 'portfolio-findings-query.v1',
          metricIds: ['booked_rooms'],
          asOf: '2026-07-28T11:45:00.000Z',
          analysisWindowKey: 'business-date:2026-07-28',
          sourceVersions: [{ component: 'pms-room-status', version: 'pms-room-status.v1' }],
          coverage: { eligible: 1, evaluated: 1, affected: 1 },
        },
        privacy: { mode: 'not_a_cohort' },
      }],
    });
    const loadedProducer: PortfolioFindingProducerMetadataV1 = {
      ...structuredClone(producer),
      projectionMode: 'active',
      status: 'loaded',
      run: {
        runId,
        runFingerprint,
        portfolioSnapshotFingerprint: '8'.repeat(64),
        projectionMode: 'active',
        engineVersion: 'management-pattern-engine.v1',
        evidenceSchemaVersion: 1,
        cohortPolicyVersion: 'cohort-policy.v1',
        normalizationPolicyVersion: 'normalization-policy.v1',
        dedupePolicyVersion: 'dedupe-policy.v1',
        scopePolicyVersion: 'scope-policy.v1',
        sourceQueryId: 'portfolio-findings-query',
        sourceQueryVersion: 'portfolio-findings-query.v1',
        evaluationAt: '2026-07-28T11:30:00.000Z',
        sourceAsOf: '2026-07-28T11:45:00.000Z',
        windowStart: '2026-07-27T00:00:00.000Z',
        windowEnd: '2026-07-28T11:45:00.000Z',
        completedAt: '2026-07-28T11:50:00.000Z',
        validThrough: '2026-08-05T11:30:00.000Z',
        terminalStatus: 'succeeded',
        coverage: {
          selectedPropertyCount: receipt.propertyIds.length,
          snapshotPropertyCount: receipt.propertyIds.length,
          includedPropertyCount: receipt.propertyIds.length,
          excludedPropertyCount: 0,
          missingFromRunCount: 0,
          exclusionReasons: [],
          exclusionReasonCodeCount: 0,
          exclusionReasonsTruncated: false,
        },
      },
      sourceAvailableCandidateCount: 1,
      coverage: {
        authorizedPropertyCount: receipt.authorizedPropertyIds.length,
        selectedPropertyCount: receipt.propertyIds.length,
        evaluatedPropertyCount: 1,
        affectedPropertyCount: 1,
        sourceCandidateCount: 1,
        findingCount: 1,
      },
      exclusions: [],
      fingerprint: '9'.repeat(64),
    };
    const loadedProjection = buildPortfolioFindingProjection({
      packageValue: loadedPackage,
      accountId: ACCOUNT_MARIA,
      authorizationHash: receipt.authorizationHash,
      scopeHash: receipt.scopeHash,
      maxProjectedItems: 40,
      status: 'loaded',
      producer: loadedProducer,
    });
    assert.equal(loadedProjection.projectedClaimIds.length, 1);
    loadedFindingClaimId = loadedProjection.projectedClaimIds[0]!;
    loadedFindingVersions = buildPortfolioFindingProjectionReceipt({
      projection: loadedProjection,
      displayedClaimIds: [loadedFindingClaimId],
    });

    const zeroClaimLoadedProducer: PortfolioFindingProducerMetadataV1 = {
      ...structuredClone(loadedProducer),
      coverage: {
        ...loadedProducer.coverage,
        evaluatedPropertyCount: 0,
        affectedPropertyCount: 0,
        findingCount: 0,
      },
      rejectedCandidates: [{
        candidateId: 'eeeeeeee-0000-4000-8000-000000000001',
        code: 'unsafe_statement',
      }],
      exclusions: [{ code: 'candidate/unsafe_statement', count: 1 }],
      fingerprint: 'a'.repeat(64),
    };
    zeroClaimLoadedFindingVersions = buildPortfolioFindingProjectionReceipt({
      projection: buildPortfolioFindingProjection({
        packageValue,
        accountId: ACCOUNT_MARIA,
        authorizationHash: receipt.authorizationHash,
        scopeHash: receipt.scopeHash,
        maxProjectedItems: 40,
        status: 'loaded',
        producer: zeroClaimLoadedProducer,
      }),
      displayedClaimIds: [],
    });
  });

  after(async () => {
    await pg?.close().catch(() => undefined);
  });

  test('service-only immutable artifact binds exact attempts, question, plan, and rendered answer', async () => {
    const privileges = await pg.query<{
      authenticated_select: boolean;
      authenticated_insert: boolean;
      anon_select: boolean;
      service_select: boolean;
      service_insert: boolean;
      service_update: boolean;
      service_delete: boolean;
      rls_enabled: boolean;
    }>(
      `select
         has_table_privilege('authenticated', 'public.portfolio_model_request_artifacts', 'select')
           as authenticated_select,
         has_table_privilege('authenticated', 'public.portfolio_model_request_artifacts', 'insert')
           as authenticated_insert,
         has_table_privilege('anon', 'public.portfolio_model_request_artifacts', 'select')
           as anon_select,
         has_table_privilege('service_role', 'public.portfolio_model_request_artifacts', 'select')
           as service_select,
         has_table_privilege('service_role', 'public.portfolio_model_request_artifacts', 'insert')
           as service_insert,
         has_table_privilege('service_role', 'public.portfolio_model_request_artifacts', 'update')
           as service_update,
         has_table_privilege('service_role', 'public.portfolio_model_request_artifacts', 'delete')
           as service_delete,
         relrowsecurity as rls_enabled
       from pg_class
       where oid = 'public.portfolio_model_request_artifacts'::regclass`,
    );
    assert.deepEqual(privileges.rows[0], {
      authenticated_select: false,
      authenticated_insert: false,
      anon_select: false,
      service_select: true,
      service_insert: true,
      service_update: false,
      service_delete: false,
      rls_enabled: true,
    });

    const mountedReceipt = findingVersions as Exclude<
      PortfolioFindingReceiptV1,
      { status: 'not_mounted' }
    >;
    const producerValidation = await pg.query<{ ok: boolean }>(
      `select public._staxis_portfolio_finding_producer_ok(
         $1::jsonb, $2, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8, $9
       ) as ok`,
      [
        JSON.stringify(mountedReceipt.producer), mountedReceipt.status,
        ACCOUNT_MARIA, ORG_A, receipt.id, receipt.authorizationHash,
        receipt.scopeHash, receipt.authorizedPropertyIds.length, receipt.propertyIds.length,
      ],
    );
    assert.equal(producerValidation.rows[0].ok, true, 'compact producer SQL mirror');

    const signedHashes = await pg.query<{
      receipt_hash: string;
      computed_receipt_hash: string;
      projection_hash: string;
      computed_projection_hash: string;
      canonical_receipt: string;
    }>(
      `with receipt as (select $1::jsonb as value), projection as (
         select jsonb_build_object(
           'version', value->'projectionVersion',
           'status', value->'status',
           'accountId', value->'accountId',
           'organizationId', value->'organizationId',
           'scopeReceiptId', value->'scopeReceiptId',
           'authorizationHash', value->'authorizationHash',
           'scopeHash', value->'scopeHash',
           'consumedAt', value->'consumedAt',
           'producer', value->'producer',
           'source', value->'source',
           'acceptedClaimIds', value->'acceptedClaimIds',
           'projectedClaimIds', value->'projectedClaimIds',
           'itemOmittedClaimIds', value->'itemOmittedClaimIds',
           'characterOmittedClaimIds', value->'characterOmittedClaimIds',
           'counts', jsonb_build_object(
             'input', value->'counts'->'input',
             'accepted', value->'counts'->'accepted',
             'projected', value->'counts'->'projected',
             'rejected', value->'counts'->'rejected',
             'smallCohortSuppressed', value->'counts'->'smallCohortSuppressed'
           ),
           'coverage', value->'coverage',
           'truncation', value->'truncation',
           'outage', value->'outage',
           'rejectionSummary', value->'rejectionSummary',
           'rejectionSummaryOmittedCount', value->'rejectionSummaryOmittedCount',
           'exclusionSummary', value->'projectionExclusionSummary',
           'exclusionSummaryOmittedCount',
             value->'projectionExclusionSummaryOmittedCount',
           'prompt', value->'prompt'
         ) as value from receipt
       )
       select receipt.value->>'receiptHash' as receipt_hash,
              encode(public.digest(convert_to(
                public._staxis_jsonb_canonical_text(receipt.value - 'receiptHash'),
                'UTF8'
              ), 'sha256'), 'hex') as computed_receipt_hash,
              receipt.value->>'projectionHash' as projection_hash,
              encode(public.digest(convert_to(
                public._staxis_jsonb_canonical_text(projection.value), 'UTF8'
              ), 'sha256'), 'hex') as computed_projection_hash,
              public._staxis_jsonb_canonical_text(receipt.value - 'receiptHash')
                as canonical_receipt
         from receipt cross join projection`,
      [JSON.stringify(findingVersions)],
    );
    const unsignedFinding = structuredClone(
      findingVersions as unknown as Record<string, unknown>,
    );
    delete unsignedFinding.receiptHash;
    assert.equal(
      signedHashes.rows[0].canonical_receipt,
      canonicalJson(unsignedFinding),
      'SQL and TypeScript canonical receipt bytes must agree',
    );
    assert.equal(
      signedHashes.rows[0].computed_receipt_hash,
      signedHashes.rows[0].receipt_hash,
      'SQL and TypeScript receipt canonicalization must agree',
    );
    assert.equal(
      signedHashes.rows[0].computed_projection_hash,
      signedHashes.rows[0].projection_hash,
      'SQL and TypeScript projection canonicalization must agree',
    );

    const mountedValidation = await pg.query<{ ok: boolean }>(
      `select public._staxis_portfolio_finding_receipt_ok(
         $1::jsonb, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8
       ) as ok`,
      [
        JSON.stringify(findingVersions), ACCOUNT_MARIA, ORG_A, receipt.id,
        receipt.authorizationHash, receipt.scopeHash,
        receipt.authorizedPropertyIds.length, receipt.propertyIds.length,
      ],
    );
    assert.equal(
      mountedValidation.rows[0].ok,
      true,
      'the real current TypeScript mounted receipt must pass the SQL mirror',
    );

    const providerRequestText = JSON.stringify(providerRequest);
    const artifact = await pg.query<{ id: string }>(
      `insert into public.portfolio_model_request_artifacts (
         property_id, organization_id, account_id, scope_receipt_id,
         authorization_hash, scope_hash, artifact_version, normalized_question,
         question_hash, prompt_version, prompt_hash, provider_request,
         provider_request_hash, configured_execution, applied_parameters,
         actual_model_id, actual_model_tier, model_candidate_text,
         model_candidate_hash, presentation_plan, presentation_plan_version,
         renderer_version, rendered_answer_text, rendered_answer_hash,
         authorized_property_ids, selected_property_ids, finding_versions
       ) values (
         $1, $2, $3, $4, $5, $6, 'portfolio-model-request.v1', $7,
         $8, $9, $10, $11::jsonb, $12, $13::jsonb, $14::jsonb,
         'claude-fallback-snapshot-20260720', 'sonnet', $15, $16,
         $17::jsonb, 'portfolio-presentation-plan.v1', $18, $19, $20,
         $21::uuid[], $22::uuid[], $23::jsonb
       ) returning id`,
      [
        PID_A1, ORG_A, ACCOUNT_MARIA, receipt.id,
        receipt.authorizationHash, receipt.scopeHash, question, sha256(question),
        promptVersion, promptHash, providerRequestText, sha256(providerRequestText),
        JSON.stringify(configuredExecution), JSON.stringify(appliedParameters),
        modelCandidate, sha256(modelCandidate), JSON.stringify(presentationPlan),
        rendererVersion, renderedAnswer, sha256(renderedAnswer),
        receipt.authorizedPropertyIds, receipt.propertyIds, JSON.stringify(findingVersions),
      ],
    );
    const artifactId = artifact.rows[0].id;

    const storedArtifact = await pg.query<{
      provider_request: unknown;
      normalized_question: string;
      configured_execution: unknown;
      applied_parameters: unknown;
      model_candidate_text: string;
      presentation_plan: unknown;
      rendered_answer_text: string;
      finding_versions: unknown;
    }>(
      `select provider_request, normalized_question, configured_execution,
              applied_parameters, model_candidate_text, presentation_plan,
              rendered_answer_text, finding_versions
         from public.portfolio_model_request_artifacts where id = $1`,
      [artifactId],
    );
    assert.deepEqual(jsonValue(storedArtifact.rows[0].provider_request), providerRequest);
    assert.equal(storedArtifact.rows[0].normalized_question, question);
    assert.deepEqual(jsonValue(storedArtifact.rows[0].configured_execution), configuredExecution);
    assert.deepEqual(jsonValue(storedArtifact.rows[0].applied_parameters), appliedParameters);
    assert.equal(storedArtifact.rows[0].model_candidate_text, modelCandidate);
    assert.deepEqual(jsonValue(storedArtifact.rows[0].presentation_plan), presentationPlan);
    assert.equal(storedArtifact.rows[0].rendered_answer_text, renderedAnswer);
    assert.deepEqual(jsonValue(storedArtifact.rows[0].finding_versions), findingVersions);

    const artifactCloneColumns = [
      'id', 'property_id', 'organization_id', 'account_id', 'conversation_id',
      'scope_receipt_id', 'authorization_hash', 'scope_hash', 'artifact_version',
      'normalized_question', 'question_hash', 'prompt_version', 'prompt_hash',
      'provider_request', 'provider_request_hash', 'configured_execution',
      'applied_parameters', 'actual_model_id', 'actual_model_tier',
      'model_candidate_text', 'model_candidate_hash', 'presentation_plan',
      'presentation_plan_version', 'renderer_version', 'rendered_answer_text',
      'rendered_answer_hash', 'authorized_property_ids', 'selected_property_ids',
      'finding_versions',
    ] as const;
    const cloneArtifact = (
      overrides: Partial<Record<(typeof artifactCloneColumns)[number], string>>,
      parameters: unknown[] = [],
    ) => pg.query(
      `insert into public.portfolio_model_request_artifacts (${artifactCloneColumns.join(', ')})
       select ${artifactCloneColumns.map((column) => (
         column === 'id' ? 'gen_random_uuid()' : (overrides[column] ?? column)
       )).join(', ')}
         from public.portfolio_model_request_artifacts where id = $1`,
      [artifactId, ...parameters],
    );
    const findingReceiptIsValid = async (value: unknown): Promise<boolean> => {
      const result = await pg.query<{ ok: boolean }>(
        `select public._staxis_portfolio_finding_receipt_ok(
           $1::jsonb, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8
         ) as ok`,
        [
          JSON.stringify(value), ACCOUNT_MARIA, ORG_A, receipt.id,
          receipt.authorizationHash, receipt.scopeHash,
          receipt.authorizedPropertyIds.length, receipt.propertyIds.length,
        ],
      );
      return result.rows[0]?.ok ?? false;
    };
    const mounted = findingVersions as unknown as Record<string, unknown>;

    const loadedSqlValidation = await pg.query<{
      receipt_ok: boolean;
      matching_plan: boolean;
      empty_plan: boolean;
    }>(
      `select public._staxis_portfolio_finding_receipt_ok(
         $1::jsonb, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8
       ) as receipt_ok,
       public._staxis_portfolio_finding_plan_matches(
         $1::jsonb, $9::jsonb
       ) as matching_plan,
       public._staxis_portfolio_finding_plan_matches(
         $1::jsonb, $10::jsonb
       ) as empty_plan`,
      [
        JSON.stringify(loadedFindingVersions), ACCOUNT_MARIA, ORG_A, receipt.id,
        receipt.authorizationHash, receipt.scopeHash,
        receipt.authorizedPropertyIds.length, receipt.propertyIds.length,
        JSON.stringify({
          version: 'portfolio-presentation-plan.v1',
          lead: 'scope_first',
          orderedClaimIds: [loadedFindingClaimId],
        }),
        JSON.stringify({
          version: 'portfolio-presentation-plan.v1',
          lead: 'scope_first',
          orderedClaimIds: [],
        }),
      ],
    );
    assert.deepEqual(loadedSqlValidation.rows[0], {
      receipt_ok: true,
      matching_plan: true,
      empty_plan: false,
    });
    await assert.rejects(
      cloneArtifact(
        { finding_versions: '$2::jsonb' },
        [JSON.stringify(loadedFindingVersions)],
      ),
      /invalid or cross-scope finding receipt/i,
      'displayed finding claims must be selected by the persisted model plan',
    );
    await cloneArtifact(
      { finding_versions: '$2::jsonb' },
      [JSON.stringify(zeroClaimLoadedFindingVersions)],
    );

    const zeroSourceLoaded = structuredClone(
      zeroClaimLoadedFindingVersions as unknown as Record<string, unknown>,
    );
    const zeroSourceProducer = zeroSourceLoaded.producer as Record<string, unknown>;
    zeroSourceProducer.sourceAvailableCandidateCount = 0;
    (zeroSourceProducer.coverage as Record<string, unknown>).sourceCandidateCount = 0;
    zeroSourceProducer.rejectedCandidateSummary = [];
    zeroSourceProducer.rejectedCandidateSummaryOmittedCount = 0;
    zeroSourceLoaded.source = {
      availableCandidateCount: 0,
      loadedFindingCount: 0,
      producerRejectedCandidateCount: 0,
      limitOmittedCount: 0,
      loaderOmittedCount: 0,
      loaderOmissionSummary: [],
      loaderOmissionSummaryOmittedCount: 0,
    };
    await assert.rejects(
      cloneArtifact(
        { finding_versions: '$2::jsonb' },
        [JSON.stringify(resignMountedFindingReceipt(zeroSourceLoaded))],
      ),
      /invalid or cross-scope finding receipt/i,
      'loaded zero-claim state still requires a real source candidate partition',
    );

    const wrongValidityWindow = structuredClone(
      zeroClaimLoadedFindingVersions as unknown as Record<string, unknown>,
    );
    const wrongValidityWindowProducer = wrongValidityWindow.producer as Record<
      string,
      unknown
    >;
    const wrongValidityWindowRun = wrongValidityWindowProducer.run as Record<
      string,
      unknown
    >;
    wrongValidityWindowRun.validThrough = '2026-08-05T10:30:00.000Z';
    await assert.rejects(
      cloneArtifact(
        { finding_versions: '$2::jsonb' },
        [JSON.stringify(resignMountedFindingReceipt(wrongValidityWindow))],
      ),
      /invalid or cross-scope finding receipt/i,
      'producer evaluation-to-validity window must remain exactly 192 hours',
    );

    const loadedMissingProperty = structuredClone(
      zeroClaimLoadedFindingVersions as unknown as Record<string, unknown>,
    );
    const loadedRunCoverage = ((((loadedMissingProperty.producer as Record<string, unknown>)
      .run) as Record<string, unknown>).coverage) as Record<string, unknown>;
    loadedRunCoverage.snapshotPropertyCount = receipt.propertyIds.length - 1;
    loadedRunCoverage.includedPropertyCount = receipt.propertyIds.length - 1;
    loadedRunCoverage.missingFromRunCount = 1;
    await assert.rejects(
      cloneArtifact(
        { finding_versions: '$2::jsonb' },
        [JSON.stringify(resignMountedFindingReceipt(loadedMissingProperty))],
      ),
      /invalid or cross-scope finding receipt/i,
      'loaded status cannot conceal a property missing from the producer run',
    );

    const noApplicableMissingProperty = structuredClone(
      runBearingFindingVersions as unknown as Record<string, unknown>,
    );
    const noApplicableMissingProducer = noApplicableMissingProperty.producer as Record<
      string,
      unknown
    >;
    const noApplicableMissingCoverage = (
      (noApplicableMissingProducer.run as Record<string, unknown>).coverage
    ) as Record<string, unknown>;
    noApplicableMissingCoverage.snapshotPropertyCount = receipt.propertyIds.length - 1;
    noApplicableMissingCoverage.includedPropertyCount = receipt.propertyIds.length - 1;
    noApplicableMissingCoverage.missingFromRunCount = 1;
    noApplicableMissingProducer.exclusionSummary = [
      { code: 'no_applicable_findings', count: 1 },
      { code: 'property_missing_from_run', count: 1 },
    ];
    const signedNoApplicableMissingProperty = resignMountedFindingReceipt(
      noApplicableMissingProperty,
    );
    assert.equal(await findingReceiptIsValid(signedNoApplicableMissingProperty), false);
    await assert.rejects(
      cloneArtifact(
        { finding_versions: '$2::jsonb' },
        [JSON.stringify(signedNoApplicableMissingProperty)],
      ),
      /invalid or cross-scope finding receipt/i,
      'no-applicable status cannot conceal a property missing from the run',
    );

    const loadedWithOnlyLimitOmissions = structuredClone(
      zeroClaimLoadedFindingVersions as unknown as Record<string, unknown>,
    );
    const onlyLimitProducer = loadedWithOnlyLimitOmissions.producer as Record<
      string,
      unknown
    >;
    onlyLimitProducer.rejectedCandidateSummary = [];
    onlyLimitProducer.rejectedCandidateSummaryOmittedCount = 0;
    onlyLimitProducer.omittedByLimitCount = 1;
    onlyLimitProducer.exclusionSummary = [{ code: 'finding_limit', count: 1 }];
    (onlyLimitProducer.coverage as Record<string, unknown>).sourceCandidateCount = 1;
    (onlyLimitProducer.truncation as Record<string, unknown>).occurred = true;
    (onlyLimitProducer.truncation as Record<string, unknown>).omittedCount = 1;
    loadedWithOnlyLimitOmissions.source = {
      availableCandidateCount: 1,
      loadedFindingCount: 0,
      producerRejectedCandidateCount: 0,
      limitOmittedCount: 1,
      loaderOmittedCount: 1,
      loaderOmissionSummary: [{ code: 'source_limit', count: 1 }],
      loaderOmissionSummaryOmittedCount: 0,
    };
    const signedLoadedWithOnlyLimitOmissions = resignMountedFindingReceipt(
      loadedWithOnlyLimitOmissions,
    );
    assert.equal(await findingReceiptIsValid(signedLoadedWithOnlyLimitOmissions), false);
    await assert.rejects(
      cloneArtifact(
        { finding_versions: '$2::jsonb' },
        [JSON.stringify(signedLoadedWithOnlyLimitOmissions)],
      ),
      /invalid or cross-scope finding receipt/i,
      'loaded status requires a retained or producer-rejected candidate on the page',
    );

    const runCoveragePoisons: Array<{
      name: string;
      mutate: (coverage: Record<string, unknown>) => void;
    }> = [
      {
        name: 'run exclusion reason rows must fill the exact bounded 50-code page',
        mutate(coverage) {
          (coverage.exclusionReasons as unknown[]).pop();
        },
      },
      {
        name: 'run exclusion truncation is derived from a code count above 50',
        mutate(coverage) {
          coverage.exclusionReasonsTruncated = false;
        },
      },
      {
        name: 'each run exclusion reason is bounded by the selected-property ceiling',
        mutate(coverage) {
          const reasons = coverage.exclusionReasons as Array<Record<string, unknown>>;
          reasons[0]!.count = 251;
        },
      },
      {
        name: 'run exclusion reason codes are unique within the bounded page',
        mutate(coverage) {
          const reasons = coverage.exclusionReasons as Array<Record<string, unknown>>;
          reasons[1]!.code = reasons[0]!.code;
        },
      },
    ];
    for (const poison of runCoveragePoisons) {
      const poisoned = structuredClone(
        runReasonFindingVersions as unknown as Record<string, unknown>,
      );
      const poisonedCoverage = (
        ((poisoned.producer as Record<string, unknown>).run as Record<string, unknown>)
          .coverage
      ) as Record<string, unknown>;
      poison.mutate(poisonedCoverage);
      const signedPoisonedCoverage = resignMountedFindingReceipt(poisoned);
      assert.equal(await findingReceiptIsValid(signedPoisonedCoverage), false, poison.name);
      await assert.rejects(
        cloneArtifact(
          { finding_versions: '$2::jsonb' },
          [JSON.stringify(signedPoisonedCoverage)],
        ),
        /invalid or cross-scope finding receipt/i,
        poison.name,
      );
    }

    const incorrectCompactExclusionTotal = structuredClone(
      runReasonFindingVersions as unknown as Record<string, unknown>,
    );
    const incorrectCompactProducer = incorrectCompactExclusionTotal.producer as Record<
      string,
      unknown
    >;
    incorrectCompactProducer.exclusionSummaryOmittedCount =
      Number(incorrectCompactProducer.exclusionSummaryOmittedCount) + 1;
    const signedIncorrectCompactExclusionTotal = resignMountedFindingReceipt(
      incorrectCompactExclusionTotal,
    );
    assert.equal(await findingReceiptIsValid(signedIncorrectCompactExclusionTotal), false);
    await assert.rejects(
      cloneArtifact(
        { finding_versions: '$2::jsonb' },
        [JSON.stringify(signedIncorrectCompactExclusionTotal)],
      ),
      /invalid or cross-scope finding receipt/i,
      'compact exclusion summary and omitted totals must exactly reconcile producer provenance',
    );

    const producerCoverageBelowAccepted = structuredClone(
      loadedFindingVersions as unknown as Record<string, unknown>,
    );
    const belowAcceptedCoverage = (
      (producerCoverageBelowAccepted.producer as Record<string, unknown>).coverage
    ) as Record<string, unknown>;
    belowAcceptedCoverage.evaluatedPropertyCount = 0;
    belowAcceptedCoverage.affectedPropertyCount = 0;
    const signedProducerCoverageBelowAccepted = resignMountedFindingReceipt(
      producerCoverageBelowAccepted,
    );
    assert.equal(await findingReceiptIsValid(signedProducerCoverageBelowAccepted), false);
    await assert.rejects(
      cloneArtifact(
        { finding_versions: '$2::jsonb' },
        [JSON.stringify(signedProducerCoverageBelowAccepted)],
      ),
      /invalid or cross-scope finding receipt/i,
      'producer property coverage cannot be smaller than accepted finding unions',
    );

    const producerCoverageBroaderWithoutConsumerRejection = structuredClone(
      loadedFindingVersions as unknown as Record<string, unknown>,
    );
    const broaderProducerCoverage = (
      (producerCoverageBroaderWithoutConsumerRejection.producer as Record<string, unknown>)
        .coverage
    ) as Record<string, unknown>;
    broaderProducerCoverage.evaluatedPropertyCount = receipt.propertyIds.length;
    const signedBroaderProducerCoverage = resignMountedFindingReceipt(
      producerCoverageBroaderWithoutConsumerRejection,
    );
    assert.equal(await findingReceiptIsValid(signedBroaderProducerCoverage), false);
    await assert.rejects(
      cloneArtifact(
        { finding_versions: '$2::jsonb' },
        [JSON.stringify(signedBroaderProducerCoverage)],
      ),
      /invalid or cross-scope finding receipt/i,
      'zero consumer rejects requires exact accepted/producer property coverage',
    );

    const nonLoadedWithoutExclusion = structuredClone(
      runBearingFindingVersions as unknown as Record<string, unknown>,
    );
    (nonLoadedWithoutExclusion.producer as Record<string, unknown>).exclusionSummary = [];
    await assert.rejects(
      cloneArtifact(
        { finding_versions: '$2::jsonb' },
        [JSON.stringify(resignMountedFindingReceipt(nonLoadedWithoutExclusion))],
      ),
      /invalid or cross-scope finding receipt/i,
      'non-loaded producer states require bounded exclusion provenance',
    );

    for (const nullableReceipt of nullableFindingVersions) {
      await cloneArtifact(
        { finding_versions: '$2::jsonb' },
        [JSON.stringify(nullableReceipt)],
      );
    }
    for (const precedenceReceipt of precedenceFindingVersions) {
      await cloneArtifact(
        { finding_versions: '$2::jsonb' },
        [JSON.stringify(precedenceReceipt)],
      );
    }
    for (const zeroReceipt of additionalZeroFindingVersions) {
      await cloneArtifact(
        { finding_versions: '$2::jsonb' },
        [JSON.stringify(zeroReceipt)],
      );
    }
    await cloneArtifact(
      { finding_versions: '$2::jsonb' },
      [JSON.stringify(runReasonFindingVersions)],
    );

    const unavailableWithWrongReason = structuredClone(
      additionalZeroFindingVersions[4] as unknown as Record<string, unknown>,
    );
    const unavailableWrongProducer = unavailableWithWrongReason.producer as Record<
      string,
      unknown
    >;
    const unavailableWrongSummary = unavailableWrongProducer.exclusionSummary as Array<
      Record<string, unknown>
    >;
    unavailableWrongSummary[0]!.code = 'different_unavailable_reason';
    const signedUnavailableWithWrongReason = resignMountedFindingReceipt(
      unavailableWithWrongReason,
    );
    assert.equal(await findingReceiptIsValid(signedUnavailableWithWrongReason), false);
    await assert.rejects(
      cloneArtifact(
        { finding_versions: '$2::jsonb' },
        [JSON.stringify(signedUnavailableWithWrongReason)],
      ),
      /invalid or cross-scope finding receipt/i,
      'unavailable compact exclusion must equal the exact outage reason',
    );

    const presentAuthorizationBeforeRead = structuredClone(
      additionalZeroFindingVersions[4] as unknown as Record<string, unknown>,
    );
    const presentPreReadProducer = presentAuthorizationBeforeRead.producer as Record<
      string,
      unknown
    >;
    const presentPreReadOutage = presentPreReadProducer.outage as Record<string, unknown>;
    presentPreReadOutage.stage = 'authorization_before_read';
    presentPreReadOutage.reason = 'authorization_unavailable';
    const presentPreReadSummary = presentPreReadProducer.exclusionSummary as Array<
      Record<string, unknown>
    >;
    presentPreReadSummary[0]!.code = 'authorization_unavailable';
    (presentAuthorizationBeforeRead.outage as Record<string, unknown>).code =
      'authorization_before_read';
    const signedPresentAuthorizationBeforeRead = resignMountedFindingReceipt(
      presentAuthorizationBeforeRead,
    );
    assert.equal(await findingReceiptIsValid(signedPresentAuthorizationBeforeRead), false);
    await assert.rejects(
      cloneArtifact(
        { finding_versions: '$2::jsonb' },
        [JSON.stringify(signedPresentAuthorizationBeforeRead)],
      ),
      /invalid or cross-scope finding receipt/i,
      'authorization-before-read outage is reserved for exact nullable provenance',
    );

    const nonUnavailableOutage = structuredClone(
      runBearingFindingVersions as unknown as Record<string, unknown>,
    );
    const nonUnavailableProducer = nonUnavailableOutage.producer as Record<string, unknown>;
    nonUnavailableProducer.outage = {
      occurred: true,
      stage: 'source_read',
      reason: 'source_unavailable',
    };
    nonUnavailableOutage.outage = { status: 'partial', code: 'source_read' };
    const signedNonUnavailableOutage = resignMountedFindingReceipt(nonUnavailableOutage);
    assert.equal(await findingReceiptIsValid(signedNonUnavailableOutage), false);
    await assert.rejects(
      cloneArtifact(
        { finding_versions: '$2::jsonb' },
        [JSON.stringify(signedNonUnavailableOutage)],
      ),
      /invalid or cross-scope finding receipt/i,
      'only unavailable producer status can carry outage provenance',
    );

    const loadedWithAbstainedTerminal = structuredClone(
      zeroClaimLoadedFindingVersions as unknown as Record<string, unknown>,
    );
    const loadedWithAbstainedRun = (
      (loadedWithAbstainedTerminal.producer as Record<string, unknown>).run
    ) as Record<string, unknown>;
    loadedWithAbstainedRun.terminalStatus = 'abstained';
    await assert.rejects(
      cloneArtifact(
        { finding_versions: '$2::jsonb' },
        [JSON.stringify(resignMountedFindingReceipt(loadedWithAbstainedTerminal))],
      ),
      /invalid or cross-scope finding receipt/i,
      'loaded status requires a succeeded terminal run',
    );

    const noApplicableWithAbstainedTerminal = structuredClone(
      runBearingFindingVersions as unknown as Record<string, unknown>,
    );
    const noApplicableWithAbstainedRun = (
      (noApplicableWithAbstainedTerminal.producer as Record<string, unknown>).run
    ) as Record<string, unknown>;
    noApplicableWithAbstainedRun.terminalStatus = 'abstained';
    await assert.rejects(
      cloneArtifact(
        { finding_versions: '$2::jsonb' },
        [JSON.stringify(resignMountedFindingReceipt(noApplicableWithAbstainedTerminal))],
      ),
      /invalid or cross-scope finding receipt/i,
      'no-applicable status requires a succeeded terminal run',
    );

    const nullRunBearing = structuredClone(
      runBearingFindingVersions as unknown as Record<string, unknown>,
    );
    const nullRunBearingProducer = nullRunBearing.producer as Record<string, unknown>;
    nullRunBearingProducer.organizationId = null;
    nullRunBearingProducer.authorizationHash = null;
    nullRunBearingProducer.scopeHash = null;
    (nullRunBearingProducer.coverage as Record<string, unknown>).authorizedPropertyCount = null;
    await assert.rejects(
      cloneArtifact(
        { finding_versions: '$2::jsonb' },
        [JSON.stringify(resignMountedFindingReceipt(nullRunBearing))],
      ),
      /invalid or cross-scope finding receipt/i,
      'run-bearing producer scope provenance cannot be null',
    );

    const partialNullBinding = structuredClone(
      runBearingFindingVersions as unknown as Record<string, unknown>,
    );
    (partialNullBinding.producer as Record<string, unknown>).organizationId = null;
    await assert.rejects(
      cloneArtifact(
        { finding_versions: '$2::jsonb' },
        [JSON.stringify(resignMountedFindingReceipt(partialNullBinding))],
      ),
      /invalid or cross-scope finding receipt/i,
      'partial producer binding nullability must fail closed',
    );

    const missingAuthorityExclusion = structuredClone(
      nullableFindingVersions[0] as unknown as Record<string, unknown>,
    );
    (missingAuthorityExclusion.producer as Record<string, unknown>).exclusionSummary = [];
    await assert.rejects(
      cloneArtifact(
        { finding_versions: '$2::jsonb' },
        [JSON.stringify(resignMountedFindingReceipt(missingAuthorityExclusion))],
      ),
      /invalid or cross-scope finding receipt/i,
      'nullable pre-read provenance requires one bounded authority exclusion',
    );

    const forgedPreReadAuthorizationCount = structuredClone(
      nullableFindingVersions[0] as unknown as Record<string, unknown>,
    );
    (((forgedPreReadAuthorizationCount.producer as Record<string, unknown>)
      .coverage) as Record<string, unknown>).authorizedPropertyCount =
        receipt.authorizedPropertyIds.length;
    await assert.rejects(
      cloneArtifact(
        { finding_versions: '$2::jsonb' },
        [JSON.stringify(resignMountedFindingReceipt(forgedPreReadAuthorizationCount))],
      ),
      /invalid or cross-scope finding receipt/i,
      'pre-read nullable provenance cannot assert an authorized-property count',
    );

    const findingPoisons = [
      {
        name: 'closed receipt rejects an embedded raw authorized-property set',
        value: resignFindingReceipt({
          ...mounted,
          authorizedPropertyIds: receipt.authorizedPropertyIds,
        }),
      },
      {
        name: 'receipt organization is bound to the model artifact',
        value: resignFindingReceipt({ ...mounted, organizationId: 'bbbb0000-0000-4000-8000-000000000002' }),
      },
      {
        name: 'receipt scope id is bound to the model artifact',
        value: resignFindingReceipt({ ...mounted, scopeReceiptId: 'aef00000-0000-4000-8000-000000000099' }),
      },
      {
        name: 'receipt scope hash is bound to the model artifact',
        value: resignFindingReceipt({ ...mounted, scopeHash: 'f'.repeat(64) }),
      },
      {
        name: 'receipt hash cannot be caller-forged',
        value: { ...mounted, receiptHash: '0'.repeat(64) },
      },
    ];
    for (const poison of findingPoisons) {
      await assert.rejects(
        cloneArtifact({ finding_versions: '$2::jsonb' }, [JSON.stringify(poison.value)]),
        /invalid or cross-scope finding receipt/i,
        poison.name,
      );
    }

    const falseCoverage = structuredClone(mounted);
    (falseCoverage.coverage as Record<string, unknown>).authorizedPropertyCount =
      receipt.authorizedPropertyIds.length + 1;
    ((falseCoverage.producer as Record<string, unknown>).coverage as Record<string, unknown>)
      .authorizedPropertyCount = receipt.authorizedPropertyIds.length + 1;
    const signedFalseCoverage = resignMountedFindingReceipt(falseCoverage);
    validatePortfolioFindingReceipt(signedFalseCoverage);
    await assert.rejects(
      cloneArtifact(
        { finding_versions: '$2::jsonb' },
        [JSON.stringify(signedFalseCoverage)],
      ),
      /invalid or cross-scope finding receipt/i,
      'a self-consistent but false live authorization count must be rejected',
    );

    const falseSource = structuredClone(mounted);
    (falseSource.source as Record<string, unknown>).availableCandidateCount = 1;
    await assert.rejects(
      cloneArtifact(
        { finding_versions: '$2::jsonb' },
        [JSON.stringify(resignMountedFindingReceipt(falseSource))],
      ),
      /invalid or cross-scope finding receipt/i,
      're-signed false source counts must be rejected',
    );

    const overLimitBound = structuredClone(mounted);
    ((overLimitBound.producer as Record<string, unknown>).truncation as Record<string, unknown>)
      .limit = 41;
    await assert.rejects(
      cloneArtifact(
        { finding_versions: '$2::jsonb' },
        [JSON.stringify(resignMountedFindingReceipt(overLimitBound))],
      ),
      /invalid or cross-scope finding receipt/i,
      'producer projection limit 41 exceeds the frozen prompt-item bound',
    );

    const impossibleLimitPartition = structuredClone(
      loadedFindingVersions as unknown as Record<string, unknown>,
    );
    const impossibleProducer = impossibleLimitPartition.producer as Record<string, unknown>;
    impossibleProducer.sourceAvailableCandidateCount = 2;
    (impossibleProducer.coverage as Record<string, unknown>).sourceCandidateCount = 2;
    (impossibleProducer.truncation as Record<string, unknown>).limit = 1;
    impossibleProducer.rejectedCandidateSummary = [
      { code: 'unsafe_statement', count: 1 },
    ];
    impossibleProducer.rejectedCandidateSummaryOmittedCount = 0;
    impossibleLimitPartition.source = {
      availableCandidateCount: 2,
      loadedFindingCount: 1,
      producerRejectedCandidateCount: 1,
      limitOmittedCount: 0,
      loaderOmittedCount: 1,
      loaderOmissionSummary: [{ code: 'unsafe_statement', count: 1 }],
      loaderOmissionSummaryOmittedCount: 0,
    };
    await assert.rejects(
      cloneArtifact(
        { finding_versions: '$2::jsonb' },
        [JSON.stringify(resignMountedFindingReceipt(impossibleLimitPartition))],
      ),
      /invalid or cross-scope finding receipt/i,
      'accepted plus producer-rejected findings cannot exceed the declared limit',
    );

    const wrongProjectionSignature = structuredClone(mounted);
    wrongProjectionSignature.projectionHash = '0'.repeat(64);
    await assert.rejects(
      cloneArtifact(
        { finding_versions: '$2::jsonb' },
        [JSON.stringify(resignMountedFindingReceipt(
          wrongProjectionSignature,
          { recomputeProjection: false },
        ))],
      ),
      /invalid or cross-scope finding receipt/i,
      'a receipt signature cannot bless a false projection signature',
    );

    const transplantedAccount = structuredClone(mounted);
    transplantedAccount.accountId = 'dddd0000-0000-4000-8000-000000000004';
    (transplantedAccount.producer as Record<string, unknown>).accountId =
      transplantedAccount.accountId;
    const signedTransplant = resignMountedFindingReceipt(transplantedAccount);
    validatePortfolioFindingReceipt(signedTransplant);
    await assert.rejects(
      cloneArtifact(
        { finding_versions: '$2::jsonb' },
        [JSON.stringify(signedTransplant)],
      ),
      /invalid or cross-scope finding receipt/i,
      'a valid producer receipt cannot be transplanted to another account',
    );

    const producerExtraKey = structuredClone(mounted);
    (producerExtraKey.producer as Record<string, unknown>).selectedPropertyIds =
      receipt.propertyIds;
    await assert.rejects(
      cloneArtifact(
        { finding_versions: '$2::jsonb' },
        [JSON.stringify(resignMountedFindingReceipt(producerExtraKey))],
      ),
      /invalid or cross-scope finding receipt/i,
      'compact producer provenance remains a closed DTO',
    );
    const producerMissingKey = structuredClone(mounted);
    delete (producerMissingKey.producer as Record<string, unknown>).scopeHash;
    await assert.rejects(
      cloneArtifact(
        { finding_versions: '$2::jsonb' },
        [JSON.stringify(resignMountedFindingReceipt(producerMissingKey))],
      ),
      /invalid or cross-scope finding receipt/i,
      'missing producer scope provenance must fail closed',
    );
    await assert.rejects(
      cloneArtifact({ authorized_property_ids: 'array[$2::uuid]' }, [PID_A1]),
      /scope arrays do not match the live receipt/i,
      'artifact authorization arrays must match the live receipt exactly',
    );

    const queryReceipt = await pg.query<{ id: string }>(
      `insert into public.portfolio_query_receipts (
         property_id, organization_id, account_id, scope_receipt_id,
         authorization_hash, scope_hash, question_hash, query_plan_version,
         evidence_version, prompt_version, prompt_hash, model_id, model_tier,
         authorized_property_ids, selected_property_ids, metric_versions,
         source_versions, plan, evidence, answer_hash, status, duration_ms,
         knowledge_versions, finding_versions, request_artifact_id,
         model_candidate_hash, presentation_plan_version, renderer_version
       ) values (
         $1, $2, $3, $4, $5, $6, $7, 'portfolio-query-plan.v1',
         'portfolio-evidence.v1', $8, $9, 'claude-fallback-snapshot-20260720',
         'sonnet', $10::uuid[], $11::uuid[], '{}'::jsonb, '[]'::jsonb,
         $12::jsonb, $13::jsonb, $14, 'completed', 8, '{}'::jsonb,
         $15::jsonb, $16, $17, 'portfolio-presentation-plan.v1', $18
       ) returning id`,
      [
        PID_A1, ORG_A, ACCOUNT_MARIA, receipt.id,
        receipt.authorizationHash, receipt.scopeHash, sha256(question),
        promptVersion, promptHash, receipt.authorizedPropertyIds, receipt.propertyIds,
        JSON.stringify(queryPlan), JSON.stringify(evidence), sha256(renderedAnswer),
        JSON.stringify(findingVersions), artifactId, sha256(modelCandidate), rendererVersion,
      ],
    );
    const binding = await pg.query<{
      request_artifact_id: string;
      question_hash: string;
      model_candidate_hash: string;
      presentation_plan_version: string;
      renderer_version: string;
      answer_hash: string;
    }>(
      `select request_artifact_id, question_hash, model_candidate_hash,
              presentation_plan_version, renderer_version, answer_hash
         from public.portfolio_query_receipts where id = $1`,
      [queryReceipt.rows[0].id],
    );
    assert.deepEqual(binding.rows[0], {
      request_artifact_id: artifactId,
      question_hash: sha256(question),
      model_candidate_hash: sha256(modelCandidate),
      presentation_plan_version: 'portfolio-presentation-plan.v1',
      renderer_version: rendererVersion,
      answer_hash: sha256(renderedAnswer),
    });

    const cloneColumns = [
      'id', 'property_id', 'organization_id', 'account_id', 'conversation_id',
      'scope_receipt_id', 'authorization_hash', 'scope_hash', 'question_hash',
      'query_plan_version', 'evidence_version', 'prompt_version', 'prompt_hash',
      'model_id', 'model_tier', 'authorized_property_ids', 'selected_property_ids',
      'metric_versions', 'source_versions', 'knowledge_versions', 'finding_versions',
      'plan', 'evidence', 'answer_hash', 'status', 'duration_ms', 'generated_at',
      'request_artifact_id', 'model_candidate_hash', 'presentation_plan_version',
      'renderer_version', 'receipt_kind', 'knowledge_artifact_id',
      'finding_binding_status',
    ] as const;
    const cloneReceipt = (
      overrides: Partial<Record<(typeof cloneColumns)[number], string>>,
      parameters: unknown[] = [],
    ) => pg.query(
      `insert into public.portfolio_query_receipts (${cloneColumns.join(', ')})
       select ${cloneColumns.map((column) => (
         column === 'id' ? 'gen_random_uuid()' : (overrides[column] ?? column)
       )).join(', ')}
         from public.portfolio_query_receipts where id = $1`,
      [queryReceipt.rows[0].id, ...parameters],
    );
    await assert.rejects(
      cloneReceipt(
        { finding_versions: '$2::jsonb' },
        [JSON.stringify(runBearingFindingVersions)],
      ),
      /does not match receipt/i,
      'a different valid mounted projection cannot replace the artifact-bound receipt',
    );

    const oldWriterArtifactColumns = artifactCloneColumns.filter((column) => ![
      'authorized_property_ids', 'selected_property_ids',
    ].includes(column));
    const compatArtifact = await pg.query<{ id: string }>(
      `insert into public.portfolio_model_request_artifacts (${oldWriterArtifactColumns.join(', ')})
       select ${oldWriterArtifactColumns.map((column) => (
         column === 'id'
           ? 'gen_random_uuid()'
           : (column === 'finding_versions' ? '$2::jsonb' : column)
       )).join(', ')}
         from public.portfolio_model_request_artifacts where id = $1
       returning id`,
      [artifactId, JSON.stringify(notMountedFindingVersions)],
    );
    const compatArtifactRow = await pg.query<{
      authorized_property_ids: string[];
      selected_property_ids: string[];
      finding_versions: unknown;
    }>(
      `select authorized_property_ids, selected_property_ids, finding_versions
         from public.portfolio_model_request_artifacts where id = $1`,
      [compatArtifact.rows[0].id],
    );
    assert.deepEqual(
      compatArtifactRow.rows[0].authorized_property_ids,
      receipt.authorizedPropertyIds,
    );
    assert.deepEqual(compatArtifactRow.rows[0].selected_property_ids, receipt.propertyIds);
    assert.deepEqual(
      jsonValue(compatArtifactRow.rows[0].finding_versions),
      notMountedFindingVersions,
      'DB-first compatibility preserves the exact supplied signed receipt',
    );
    await cloneReceipt({
      request_artifact_id: '$2::uuid',
      finding_versions: `'{}'::jsonb`,
    }, [compatArtifact.rows[0].id]);
    const compatReceiptRow = await pg.query<{ finding_versions: unknown }>(
      'select finding_versions from public.portfolio_query_receipts where request_artifact_id = $1',
      [compatArtifact.rows[0].id],
    );
    assert.deepEqual(
      jsonValue(compatReceiptRow.rows[0].finding_versions),
      notMountedFindingVersions,
    );

    const missingAllNewColumns = artifactCloneColumns.filter((column) => ![
      'authorized_property_ids', 'selected_property_ids', 'finding_versions',
    ].includes(column));
    await assert.rejects(
      pg.query(
        `insert into public.portfolio_model_request_artifacts (${missingAllNewColumns.join(', ')})
         select ${missingAllNewColumns.map((column) => (
           column === 'id' ? 'gen_random_uuid()' : column
         )).join(', ')}
           from public.portfolio_model_request_artifacts where id = $1`,
        [artifactId],
      ),
      /requires a finding receipt/i,
      'missing finding provenance is never synthesized during rollout',
    );
    await assert.rejects(
      cloneArtifact({ finding_versions: 'null' }),
      /requires a finding receipt/i,
      'new arrays plus a missing finding receipt must fail closed',
    );
    await assert.rejects(
      cloneArtifact({ selected_property_ids: 'null' }),
      /scope arrays are incomplete/i,
      'one-null rollout scope arrays must fail closed',
    );
    for (const nullableBindingField of [
      'prompt_hash',
      'model_id',
      'model_tier',
      'model_candidate_hash',
      'renderer_version',
      'answer_hash',
    ] as const) {
      await assert.rejects(
        cloneReceipt({ [nullableBindingField]: 'null' }),
        /portfolio request artifact does not match receipt/i,
        `NULL ${nullableBindingField} must not detach a model receipt`,
      );
    }

    await assert.rejects(
      pg.query(
        `insert into public.portfolio_query_receipts (
           property_id, organization_id, account_id, scope_receipt_id,
           authorization_hash, scope_hash, question_hash, query_plan_version,
           evidence_version, prompt_version, prompt_hash, model_id, model_tier,
           authorized_property_ids, selected_property_ids, metric_versions,
           source_versions, plan, evidence, answer_hash, status, duration_ms,
           knowledge_versions, finding_versions, request_artifact_id,
           model_candidate_hash, presentation_plan_version, renderer_version
         ) values (
           $1, $2, $3, $4, $5, $6, $7, 'portfolio-query-plan.v1',
           'portfolio-evidence.v1', $8, $9, 'claude-fallback-snapshot-20260720',
           'sonnet', $10::uuid[], $11::uuid[], '{}'::jsonb, '[]'::jsonb,
           $12::jsonb, $13::jsonb, $14, 'completed', 8, '{}'::jsonb,
           $15::jsonb, null, $16, 'portfolio-presentation-plan.v1', $17
         )`,
        [
          PID_A1, ORG_A, ACCOUNT_MARIA, receipt.id,
          receipt.authorizationHash, receipt.scopeHash, sha256(question),
          promptVersion, promptHash, receipt.authorizedPropertyIds, receipt.propertyIds,
          JSON.stringify(queryPlan), JSON.stringify(evidence), sha256(renderedAnswer),
          JSON.stringify(findingVersions), sha256(modelCandidate), rendererVersion,
        ],
      ),
      /requires? (?:an immutable|exactly one model request) artifact/,
    );

    await assert.rejects(
      pg.query(
        `insert into public.portfolio_query_receipts (
           property_id, organization_id, account_id, scope_receipt_id,
           authorization_hash, scope_hash, question_hash, query_plan_version,
           evidence_version, prompt_version, prompt_hash, model_id, model_tier,
           authorized_property_ids, selected_property_ids, metric_versions,
           source_versions, plan, evidence, answer_hash, status, duration_ms,
           knowledge_versions, finding_versions, request_artifact_id,
           model_candidate_hash, presentation_plan_version, renderer_version
         ) values (
           $1, $2, $3, $4, $5, $6, $7, 'portfolio-query-plan.v1',
           'portfolio-evidence.v1', $8, $9, 'claude-fallback-snapshot-20260720',
           'sonnet', $10::uuid[], $11::uuid[], '{}'::jsonb, '[]'::jsonb,
           $12::jsonb, $13::jsonb, $14, 'completed', 8, '{}'::jsonb,
           $15::jsonb, $16, $17, 'portfolio-presentation-plan.v1', $18
         )`,
        [
          PID_A1, ORG_A, ACCOUNT_MARIA, receipt.id,
          receipt.authorizationHash, receipt.scopeHash, sha256('tampered question'),
          promptVersion, promptHash, receipt.authorizedPropertyIds, receipt.propertyIds,
          JSON.stringify(queryPlan), JSON.stringify(evidence), sha256(renderedAnswer),
          JSON.stringify(findingVersions), artifactId, sha256(modelCandidate), rendererVersion,
        ],
      ),
      /does not match receipt/,
    );

    await assert.rejects(
      pg.query(
        `update public.portfolio_model_request_artifacts
            set rendered_answer_text = 'tampered after insert'
          where id = $1`,
        [artifactId],
      ),
      /immutable/,
    );
  });

  test('artifact insert rejects contradictory usage and a candidate not present in the successful snapshot', async () => {
    const poisoned = structuredClone(providerRequest);
    poisoned.attempts[0].billableUsage.inputTokens = 18;
    const poisonedText = JSON.stringify(poisoned);
    await assert.rejects(
      pg.query(
        `insert into public.portfolio_model_request_artifacts (
           property_id, organization_id, account_id, scope_receipt_id,
           authorization_hash, scope_hash, artifact_version, normalized_question,
           question_hash, prompt_version, prompt_hash, provider_request,
           provider_request_hash, configured_execution, applied_parameters,
           actual_model_id, actual_model_tier, model_candidate_text,
           model_candidate_hash, presentation_plan, presentation_plan_version,
           renderer_version, rendered_answer_text, rendered_answer_hash,
           authorized_property_ids, selected_property_ids, finding_versions
         ) values (
           $1, $2, $3, $4, $5, $6, 'portfolio-model-request.v1', $7,
           $8, $9, $10, $11::jsonb, $12, '{}'::jsonb, '{}'::jsonb,
           'claude-fallback-snapshot-20260720', 'sonnet', $13, $14,
           $15::jsonb, 'portfolio-presentation-plan.v1', $16, $17, $18,
           $19::uuid[], $20::uuid[], $21::jsonb
         )`,
        [
          PID_A1, ORG_A, ACCOUNT_MARIA, receipt.id,
          receipt.authorizationHash, receipt.scopeHash, question, sha256(question),
          promptVersion, promptHash, poisonedText, sha256(poisonedText),
          modelCandidate, sha256(modelCandidate), JSON.stringify(presentationPlan),
          rendererVersion, renderedAnswer, sha256(renderedAnswer),
          receipt.authorizedPropertyIds, receipt.propertyIds, JSON.stringify(findingVersions),
        ],
      ),
      /billable usage does not match provider response/,
    );

    const wrongCandidate = JSON.stringify({ ...presentationPlan, lead: 'exceptions_first' });
    const validProviderText = JSON.stringify(providerRequest);
    await assert.rejects(
      pg.query(
        `insert into public.portfolio_model_request_artifacts (
           property_id, organization_id, account_id, scope_receipt_id,
           authorization_hash, scope_hash, artifact_version, normalized_question,
           question_hash, prompt_version, prompt_hash, provider_request,
           provider_request_hash, configured_execution, applied_parameters,
           actual_model_id, actual_model_tier, model_candidate_text,
           model_candidate_hash, presentation_plan, presentation_plan_version,
           renderer_version, rendered_answer_text, rendered_answer_hash,
           authorized_property_ids, selected_property_ids, finding_versions
         ) values (
           $1, $2, $3, $4, $5, $6, 'portfolio-model-request.v1', $7,
           $8, $9, $10, $11::jsonb, $12, '{}'::jsonb, '{}'::jsonb,
           'claude-fallback-snapshot-20260720', 'sonnet', $13, $14,
           $15::jsonb, 'portfolio-presentation-plan.v1', $16, $17, $18,
           $19::uuid[], $20::uuid[], $21::jsonb
         )`,
        [
          PID_A1, ORG_A, ACCOUNT_MARIA, receipt.id,
          receipt.authorizationHash, receipt.scopeHash, question, sha256(question),
          promptVersion, promptHash, validProviderText, sha256(validProviderText),
          wrongCandidate, sha256(wrongCandidate), JSON.stringify(presentationPlan),
          rendererVersion, renderedAnswer, sha256(renderedAnswer),
          receipt.authorizedPropertyIds, receipt.propertyIds, JSON.stringify(findingVersions),
        ],
      ),
      /do not reproduce the selected candidate/,
    );
  });
});
