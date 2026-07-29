process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AuthorizationScopeReceipt } from '@/lib/authorization';
import {
  loadAndConsumePortfolioFindings,
} from '@/lib/agent/portfolio-intelligence/finding-mount';
import {
  buildPortfolioFindingProjection,
  buildPortfolioFindingProjectionReceipt,
  formatPortfolioFindingProjectionForPrompt,
} from '@/lib/agent/portfolio-intelligence/pattern-contract';
import type {
  ManagementPatternPortfolioFindingV1,
  ManagementPatternPortfolioLoadReceipt,
} from '@/lib/company/management-patterns/portfolio-findings';
import { stableFingerprint } from '@/lib/company/management-patterns/canonical';

const ACCOUNT_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const ORGANIZATION_ID = 'bbbbbbbb-0000-4000-8000-000000000001';
const RECEIPT_ID = 'cccccccc-0000-4000-8000-000000000001';
const SELECTED_PROPERTY_ID = 'dddddddd-0000-4000-8000-000000000001';
const AUTHORIZED_BUT_UNSELECTED_PROPERTY_ID = 'dddddddd-0000-4000-8000-000000000002';
const RUN_ID = 'eeeeeeee-0000-4000-8000-000000000001';
const ACCEPTED_FINDING_ID = 'ffffffff-0000-4000-8000-000000000001';
const OUT_OF_SCOPE_FINDING_ID = 'ffffffff-0000-4000-8000-000000000002';
const NOW = new Date('2026-07-29T12:00:00.000Z');
const COMPLETED_AT = '2026-07-28T01:00:00.000Z';
const SOURCE_AS_OF = '2026-07-28T00:00:00.000Z';
const VALID_THROUGH = '2026-08-05T00:00:00.000Z';

function receipt(): AuthorizationScopeReceipt {
  return {
    id: RECEIPT_ID,
    accountId: ACCOUNT_ID,
    organizationId: ORGANIZATION_ID,
    organizationName: 'Mount Test Company',
    authorityMode: 'normalized',
    selectorType: 'property_subset',
    requestedPortfolioId: null,
    requestedPropertyIds: [SELECTED_PROPERTY_ID],
    authorizedPropertyIds: [
      SELECTED_PROPERTY_ID,
      AUTHORIZED_BUT_UNSELECTED_PROPERTY_ID,
    ],
    propertyIds: [SELECTED_PROPERTY_ID],
    authorizedPropertyCount: 2,
    selectedPropertyCount: 1,
    portfolioCatalog: [],
    accountAuthorizationVersion: 7,
    organizationAccessEpoch: 11,
    resolverVersion: 'authorization-scope.v1',
    authorizationHash: 'a'.repeat(64),
    scopeHash: 'b'.repeat(64),
    provenance: {
      entitlements: [],
      governingRelationshipTypes: ['operator', 'owner'],
      selectionWasTruncated: false,
    },
    resolvedAt: '2026-07-29T11:59:00.000Z',
    expiresAt: '2026-07-29T12:05:00.000Z',
  };
}

function finding(input: {
  findingId: string;
  propertyId: string;
  statement: string;
}): ManagementPatternPortfolioFindingV1 {
  return {
    version: 'portfolio-finding.v1',
    findingId: input.findingId,
    organizationId: ORGANIZATION_ID,
    producer: {
      engineId: 'management-patterns',
      engineVersion: 'management-pattern-engine.v2',
      runId: RUN_ID,
      runFingerprint: 'c'.repeat(64),
      producedAt: COMPLETED_AT,
    },
    lifecycle: {
      status: 'active',
      validThrough: VALID_THROUGH,
    },
    scope: {
      organizationId: ORGANIZATION_ID,
      kind: 'property_local',
      evaluatedPropertyIds: [input.propertyId],
      affectedPropertyIds: [input.propertyId],
      groupId: null,
      scopeFingerprint: `scope-${input.findingId}`,
    },
    claim: {
      kind: 'pattern',
      statement: input.statement,
      patternKey: `pattern-${input.findingId}`,
      assertion: 'issue_present',
      direction: 'high',
      support: 'supported',
    },
    evidence: {
      evidenceFingerprint: `evidence-${input.findingId}`,
      queryId: 'management-pattern-source-snapshot',
      queryVersion: 'management-pattern-source-snapshot.v2',
      metricIds: ['work_orders_open'],
      asOf: SOURCE_AS_OF,
      analysisWindowKey: 'rolling-7d',
      sourceVersions: [{
        component: 'management-pattern-engine',
        version: 'management-pattern-engine.v2',
      }],
      coverage: { eligible: 1, evaluated: 1, affected: 1 },
    },
    privacy: {
      mode: 'named_authorized_properties',
      propertyCount: 1,
    },
  };
}

function loaderArtifact(loadedAt: string): ManagementPatternPortfolioLoadReceipt {
  const payload = {
    version: 'management-pattern-portfolio-load.v1' as const,
    accountId: ACCOUNT_ID,
    organizationId: ORGANIZATION_ID,
    scopeReceiptId: RECEIPT_ID,
    selectedPropertyIds: [SELECTED_PROPERTY_ID],
    authorizationHash: 'a'.repeat(64),
    scopeHash: 'b'.repeat(64),
    loadedAt,
    status: 'loaded' as const,
    projectionMode: 'active' as const,
    run: {
      runId: RUN_ID,
      runFingerprint: 'c'.repeat(64),
      portfolioSnapshotFingerprint: 'd'.repeat(64),
      projectionMode: 'active' as const,
      engineVersion: 'management-pattern-engine.v2',
      evidenceSchemaVersion: 2,
      cohortPolicyVersion: 'management-metric-cohort.v2',
      normalizationPolicyVersion: 'management-normalization.v1',
      dedupePolicyVersion: 'management-pattern-dedupe.v1',
      scopePolicyVersion: 'management-scope-classifier.v1',
      sourceQueryId: 'management-pattern-source-snapshot',
      sourceQueryVersion: 'management-pattern-source-snapshot.v2',
      evaluationAt: SOURCE_AS_OF,
      sourceAsOf: SOURCE_AS_OF,
      windowStart: '2026-07-21T00:00:00.000Z',
      windowEnd: SOURCE_AS_OF,
      completedAt: COMPLETED_AT,
      validThrough: VALID_THROUGH,
      terminalStatus: 'succeeded' as const,
      coverage: {
        selectedPropertyCount: 1,
        snapshotPropertyCount: 1,
        includedPropertyCount: 1,
        excludedPropertyCount: 0,
        missingFromRunCount: 0,
        exclusionReasons: [],
        exclusionReasonCodeCount: 0,
        exclusionReasonsTruncated: false,
      },
    },
    sourceAvailableCandidateCount: 2,
    omittedByLimitCount: 0,
    selectionWasTruncated: false as const,
    coverage: {
      authorizedPropertyCount: 2,
      selectedPropertyCount: 1,
      evaluatedPropertyCount: 1,
      affectedPropertyCount: 1,
      sourceCandidateCount: 2,
      findingCount: 2,
    },
    truncation: { occurred: false, limit: 40, omittedCount: 0 },
    outage: { occurred: false, stage: null, reason: null },
    exclusions: [],
    rejectedCandidates: [],
    findings: [
      finding({
        findingId: ACCEPTED_FINDING_ID,
        propertyId: SELECTED_PROPERTY_ID,
        statement: 'The selected hotel has 17 open work orders.',
      }),
      finding({
        findingId: OUT_OF_SCOPE_FINDING_ID,
        propertyId: AUTHORIZED_BUT_UNSELECTED_PROPERTY_ID,
        statement: 'OUT_OF_SCOPE_NUMERIC_POISON reports 9999 open work orders.',
      }),
    ],
  };
  return {
    ...payload,
    fingerprint: stableFingerprint(payload, 'management-pattern-portfolio-load'),
  };
}

test('route mount keeps the full authorization universe separate and projects accepted findings only', async () => {
  let loaderSelectedPropertyIds: readonly string[] | null = null;
  let loaderMaxFindings: number | undefined;
  const mounted = await loadAndConsumePortfolioFindings({
    receipt: receipt(),
    now: NOW,
  }, {
    loadFindings: async (input) => {
      loaderSelectedPropertyIds = input.selectedPropertyIds;
      loaderMaxFindings = input.maxFindings;
      return loaderArtifact((input.asOf ?? NOW).toISOString());
    },
  });

  assert.deepEqual(loaderSelectedPropertyIds, [SELECTED_PROPERTY_ID]);
  assert.equal(loaderMaxFindings, 40);
  assert.deepEqual(mounted.packageValue.authorizedPropertyIds, [
    SELECTED_PROPERTY_ID,
    AUTHORIZED_BUT_UNSELECTED_PROPERTY_ID,
  ]);
  assert.deepEqual(mounted.packageValue.selectedPropertyIds, [SELECTED_PROPERTY_ID]);
  assert.deepEqual(mounted.packageValue.findings.map((item) => item.findingId), [
    ACCEPTED_FINDING_ID,
  ]);
  assert.equal(mounted.packageValue.rejected.length, 1);
  assert.equal(mounted.packageValue.rejected[0]?.code, 'property_scope_violation');
  assert.equal(mounted.packageValue.rejected[0]?.findingId, null);

  const projection = buildPortfolioFindingProjection({
    packageValue: mounted.packageValue,
    accountId: ACCOUNT_ID,
    authorizationHash: 'a'.repeat(64),
    scopeHash: 'b'.repeat(64),
    maxProjectedItems: 40,
    producer: mounted.producer,
  });
  assert.equal(projection.status, 'loaded');
  assert.deepEqual(projection.coverage, {
    authorizedPropertyCount: 2,
    selectedPropertyCount: 1,
    acceptedEvaluatedPropertyCount: 1,
    acceptedAffectedPropertyCount: 1,
  });
  assert.deepEqual(projection.counts, {
    input: 2,
    accepted: 1,
    projected: 1,
    rejected: 1,
    smallCohortSuppressed: 0,
  });
  assert.equal(projection.acceptedClaimIds.length, 1);
  assert.deepEqual(projection.acceptedClaimIds, projection.projectedClaimIds);

  const prompt = formatPortfolioFindingProjectionForPrompt(projection);
  assert.match(prompt, /17 open work orders/);
  assert.doesNotMatch(prompt, /9999|OUT_OF_SCOPE_NUMERIC_POISON/);

  const closedReceipt = buildPortfolioFindingProjectionReceipt({
    projection,
    displayedClaimIds: projection.projectedClaimIds,
  });
  const durableJson = JSON.stringify(closedReceipt);
  assert.deepEqual(closedReceipt.acceptedClaimIds, projection.acceptedClaimIds);
  assert.deepEqual(closedReceipt.displayedClaimIds, projection.projectedClaimIds);
  for (const forbidden of [
    SELECTED_PROPERTY_ID,
    AUTHORIZED_BUT_UNSELECTED_PROPERTY_ID,
    ACCEPTED_FINDING_ID,
    OUT_OF_SCOPE_FINDING_ID,
    '17 open work orders',
    '9999',
  ]) {
    assert.equal(durableJson.includes(forbidden), false, `durable receipt leaked ${forbidden}`);
  }
});
