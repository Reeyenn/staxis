import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { PortfolioEvidencePackageV1 } from '@/lib/agent/portfolio-intelligence/evidence';
import {
  MAX_PORTFOLIO_PRESENTATION_CLAIMS,
  PORTFOLIO_PRESENTATION_PLAN_VERSION,
  buildPortfolioFindingPresentationProjection,
  buildPortfolioPresentationClaimCatalog,
  displayedPortfolioFindingClaimIds,
  formatPortfolioPresentationPlanContract,
  portfolioFindingNumberReceiptPayloads,
  renderPortfolioAnswer,
  renderPortfolioFindingSection,
  validatePortfolioPresentationPlan,
} from '@/lib/agent/portfolio-intelligence/presentation';
import {
  PORTFOLIO_FINDING_MAX_PROMPT_CHARS,
  buildPortfolioFindingProjection,
  buildPortfolioFindingProjectionReceipt,
  consumePortfolioFindings,
  formatPortfolioFindingProjectionForPrompt,
  portfolioFindingPresentationClaimId,
  type PortfolioFindingConsumerPackageV1,
  type PortfolioFindingProjectionV1,
} from '@/lib/agent/portfolio-intelligence/pattern-contract';
import { validatePortfolioAnswerNumbers } from '@/lib/agent/portfolio-intelligence/answer-guard';
import {
  BOOKED_ROOMS_NORMAL_VERSION,
  BOOKED_ROOMS_OTB_METRIC_VERSION,
  PORTFOLIO_EVIDENCE_VERSION,
  PORTFOLIO_QUERY_PLAN_VERSION,
} from '@/lib/agent/portfolio-intelligence/versions';

const ORG = '10000000-0000-4000-8000-000000000001';
const ACCOUNT = '10000000-0000-4000-8000-000000000002';
const AUTHORIZATION_HASH = '8'.repeat(64);
const HOTEL_A = '20000000-0000-4000-8000-000000000001';
const HOTEL_B = '20000000-0000-4000-8000-000000000002';
const RUN_ID = '30000000-0000-4000-8000-000000000001';
const RUN_FINGERPRINT = '4'.repeat(64);
const SNAPSHOT_FINGERPRINT = '5'.repeat(64);
const FINDING_QUERY_ID = 'booked-rooms-presentation';
const FINDING_QUERY_VERSION = 'booked-rooms-presentation.v1';

function evidence(scopeHash = 'a'.repeat(64)): PortfolioEvidencePackageV1 {
  const fact = (
    propertyId: string,
    propertyName: string,
    rooms: number,
    classification: 'above' | 'below',
  ) => ({
    propertyId,
    propertyName,
    timezone: 'America/Chicago',
    businessDate: '2026-07-27',
    metricId: 'rooms_booked_otb',
    metricVersion: BOOKED_ROOMS_OTB_METRIC_VERSION,
    numerator: rooms,
    denominator: 120,
    normalizedValue: rooms / 1.2,
    unit: 'rooms',
    freshness: 'fresh' as const,
    quality: 'included' as const,
    exclusionCode: null,
    exclusionReason: null,
    comparisonExclusionCode: null,
    comparisonExclusionReason: null,
    source: {
      sourceTable: 'pms_booking_pace',
      sourceRecordId: `${propertyId}:2026-07-27`,
      ingestRunId: '30000000-0000-4000-8000-000000000001',
      sourceKind: 'cua',
      sourceCapturedAt: '2026-07-27T13:00:00.000Z',
      sourceBusinessAsOfDate: '2026-07-27',
      sourceObservedAt: '2026-07-27T12:55:00.000Z',
      parserName: 'pace',
      parserVersion: 'v7',
      knowledgeFileId: null,
      reportFileId: null,
      queryVersion: 'portfolio-booked-room-points.v1',
    },
    baseline: {
      version: BOOKED_ROOMS_NORMAL_VERSION,
      n: 6,
      median: classification === 'above' ? 70 : 80,
      mad: 5,
      lower: classification === 'above' ? 60 : 70,
      upper: classification === 'above' ? 80 : 90,
      classification,
      windowStart: '2026-06-01',
      windowEnd: '2026-07-20',
    },
  });
  return {
    version: PORTFOLIO_EVIDENCE_VERSION,
    scopeReceiptId: '40000000-0000-4000-8000-000000000001',
    scopeHash,
    organizationId: ORG,
    organizationName: 'Gulf Coast Hotels',
    resolvedAt: '2026-07-27T13:00:00.000Z',
    authorizedPropertyIds: [HOTEL_A, HOTEL_B],
    selectedPropertyIds: [HOTEL_A, HOTEL_B],
    plan: {
      version: PORTFOLIO_QUERY_PLAN_VERSION,
      intent: 'metric_comparison',
      selector: { kind: 'all_authorized' },
      metricIds: ['rooms_booked_otb'],
      window: { kind: 'hotel_business_today' },
      groupBy: 'property',
      comparison: 'own_same_weekday_normal',
      detailLimit: 2,
      defaultedScope: false,
    },
    metrics: [{
      id: 'rooms_booked_otb',
      version: BOOKED_ROOMS_OTB_METRIC_VERSION,
      label: 'Rooms booked on the books',
      definition: 'Latest trusted rooms on the books for each hotel-local business date.',
      numerator: 'rooms_otb',
      denominator: 'rooms_available',
      unit: 'rooms',
      normalizedUnit: 'percent',
      aggregation: 'sum',
      window: 'hotel-local business today',
      source: {
        table: 'pms_booking_pace',
        grain: 'property_id + as_of_date + stay_date',
        requiredReceipt: 'pms_ingest_runs',
      },
      missingPolicy: 'exclude_with_reason',
      maxFreshnessMs: 21_600_000,
      currency: 'not_applicable',
    }],
    facts: [
      fact(HOTEL_A, 'Comfort Suites', 100, 'above'),
      fact(HOTEL_B, 'Hotel X', 50, 'below'),
    ],
    aggregates: [{
      claimKind: 'aggregate',
      metricId: 'rooms_booked_otb',
      numerator: 150,
      denominator: 240,
      normalizedValue: 62.5,
      normalizedUnit: 'percent',
      includedPropertyIds: [HOTEL_A, HOTEL_B],
      denominatorPropertyIds: [HOTEL_A, HOTEL_B],
    }],
    metricCoverage: [{ metricId: 'rooms_booked_otb', reported: 2, excluded: 0, excludedHotels: [] }],
    coverage: {
      authorized: 2,
      selected: 2,
      reported: 2,
      excluded: 0,
      excludedHotels: [],
    },
    generatedAt: '2026-07-27T13:00:01.000Z',
    durationMs: 14,
    partial: false,
  };
}

function candidateFor(
  value: PortfolioEvidencePackageV1,
  ordered?: string[],
  findingsProjection?: PortfolioFindingProjectionV1,
): string {
  const catalog = buildPortfolioPresentationClaimCatalog(value, findingsProjection);
  return JSON.stringify({
    version: PORTFOLIO_PRESENTATION_PLAN_VERSION,
    lead: 'scope_first',
    orderedClaimIds: ordered ?? [...catalog.requiredClaimIds, ...catalog.optionalClaimIds],
  });
}

function findingEnvelope(input: {
  findingId: string;
  kind: 'fact' | 'pattern' | 'hypothesis';
  statement: string;
  runFingerprint?: string;
  evidenceFingerprint?: string;
  scopeFingerprint?: string;
  validThrough?: string | null;
}): Record<string, unknown> {
  const claim = input.kind === 'fact'
    ? {
        kind: 'fact',
        factType: 'observed',
        statement: input.statement,
        metricIds: ['rooms_booked_otb'],
      }
    : input.kind === 'pattern'
      ? {
          kind: 'pattern',
          statement: input.statement,
          patternKey: 'stable-sha256.v1:pattern-presentation',
          assertion: 'issue_present',
          direction: 'decreasing',
          support: 'supported',
        }
      : {
          kind: 'hypothesis',
          statement: input.statement,
          hypothesisKey: 'stable-sha256.v1:hypothesis-presentation',
          status: 'unverified',
          basis: 'The accepted source observed a timing correlation.',
          verificationNeeded: 'Confirm the schedule and source receipts.',
        };
  return {
    version: 'portfolio-finding.v1',
    findingId: input.findingId,
    organizationId: ORG,
    producer: {
      engineId: 'management-patterns',
      engineVersion: 'management-pattern-engine.v1',
      runId: RUN_ID,
      runFingerprint: input.runFingerprint ?? RUN_FINGERPRINT,
      producedAt: '2026-07-27T12:30:00.000Z',
    },
    lifecycle: {
      status: 'active',
      validThrough: input.validThrough === undefined
        ? '2026-08-04T12:20:00.000Z'
        : input.validThrough,
    },
    scope: {
      organizationId: ORG,
      kind: 'property_local',
      evaluatedPropertyIds: [HOTEL_A],
      affectedPropertyIds: [HOTEL_A],
      groupId: null,
      scopeFingerprint: input.scopeFingerprint ?? 'stable-sha256.v1:scope-presentation',
    },
    claim,
    evidence: {
      evidenceFingerprint: input.evidenceFingerprint ?? 'stable-sha256.v1:evidence-presentation',
      queryId: FINDING_QUERY_ID,
      queryVersion: FINDING_QUERY_VERSION,
      metricIds: ['rooms_booked_otb'],
      asOf: '2026-07-27T12:25:00.000Z',
      analysisWindowKey: 'business-date:2026-07-27',
      sourceVersions: [{ component: 'pms-booking-pace', version: 'pace.v7' }],
      coverage: { eligible: 1, evaluated: 1, affected: 1 },
    },
    privacy: { mode: 'not_a_cohort' },
  };
}

function findingsPackage(
  evidenceValue: PortfolioEvidencePackageV1,
  findings: unknown[],
  selectedPropertyIds = evidenceValue.selectedPropertyIds,
): PortfolioFindingConsumerPackageV1 {
  return consumePortfolioFindings({
    organizationId: evidenceValue.organizationId,
    scopeReceiptId: evidenceValue.scopeReceiptId,
    authorizedPropertyIds: evidenceValue.authorizedPropertyIds,
    selectedPropertyIds,
    now: '2026-07-27T13:00:00.000Z',
    findings,
  });
}

function findingsProjection(
  evidenceValue: PortfolioEvidencePackageV1,
  findings: unknown[],
): PortfolioFindingProjectionV1 {
  const packageValue = findingsPackage(evidenceValue, findings);
  return buildPortfolioFindingPresentationProjection({
    evidence: evidenceValue,
    packageValue,
    accountId: ACCOUNT,
    authorizationHash: AUTHORIZATION_HASH,
    producer: loadedProducer(packageValue, evidenceValue.scopeHash),
  });
}

function loadedProducer(packageValue: PortfolioFindingConsumerPackageV1, scopeHash: string) {
  const selectedCount = packageValue.selectedPropertyIds.length;
  const findingCount = packageValue.findings.length + packageValue.rejected.length;
  const evaluatedPropertyCount = new Set(packageValue.findings.flatMap(
    (finding) => finding.scope.evaluatedPropertyIds,
  )).size;
  const affectedPropertyCount = new Set(packageValue.findings.flatMap(
    (finding) => finding.scope.affectedPropertyIds,
  )).size;
  return {
    loadVersion: 'management-pattern-portfolio-load.v1' as const,
    loadedAt: '2026-07-27T12:35:00.000Z',
    accountId: ACCOUNT,
    organizationId: packageValue.organizationId,
    scopeReceiptId: packageValue.scopeReceiptId,
    selectedPropertyIds: [...packageValue.selectedPropertyIds],
    authorizationHash: AUTHORIZATION_HASH,
    scopeHash,
    projectionMode: 'active' as const,
    status: 'loaded' as const,
    contractVersion: 'portfolio-finding.v1' as const,
    run: {
      runId: RUN_ID,
      runFingerprint: RUN_FINGERPRINT,
      portfolioSnapshotFingerprint: SNAPSHOT_FINGERPRINT,
      projectionMode: 'active' as const,
      engineVersion: 'management-pattern-engine.v1',
      evidenceSchemaVersion: 1,
      cohortPolicyVersion: 'cohort-policy.v1',
      normalizationPolicyVersion: 'normalization-policy.v1',
      dedupePolicyVersion: 'dedupe-policy.v1',
      scopePolicyVersion: 'scope-policy.v1',
      sourceQueryId: FINDING_QUERY_ID,
      sourceQueryVersion: FINDING_QUERY_VERSION,
      evaluationAt: '2026-07-27T12:20:00.000Z',
      sourceAsOf: '2026-07-27T12:25:00.000Z',
      windowStart: '2026-07-01T00:00:00.000Z',
      windowEnd: '2026-07-27T12:25:00.000Z',
      completedAt: '2026-07-27T12:30:00.000Z',
      validThrough: '2026-08-04T12:20:00.000Z',
      terminalStatus: 'succeeded' as const,
      coverage: {
        selectedPropertyCount: selectedCount,
        snapshotPropertyCount: selectedCount,
        includedPropertyCount: selectedCount,
        excludedPropertyCount: 0,
        missingFromRunCount: 0,
        exclusionReasons: [],
        exclusionReasonCodeCount: 0,
        exclusionReasonsTruncated: false,
      },
    },
    sourceAvailableCandidateCount: findingCount,
    omittedByLimitCount: 0,
    selectionWasTruncated: false as const,
    coverage: {
      authorizedPropertyCount: packageValue.authorizedPropertyIds.length,
      selectedPropertyCount: selectedCount,
      evaluatedPropertyCount,
      affectedPropertyCount,
      sourceCandidateCount: findingCount,
      findingCount,
    },
    truncation: { occurred: false, limit: 40, omittedCount: 0 },
    outage: { occurred: false, stage: null, reason: null },
    exclusions: [],
    rejectedCandidates: [],
    fingerprint: '6'.repeat(64),
  };
}

describe('portfolio deterministic presentation boundary', () => {
  test('binds each number and classification to its evidence hotel even when detail IDs are reversed', () => {
    const packageValue = evidence();
    const catalog = buildPortfolioPresentationClaimCatalog(packageValue);
    const reversedDetails = [...catalog.optionalClaimIds].reverse();
    const verdict = validatePortfolioPresentationPlan({
      candidate: candidateFor(packageValue, [...catalog.requiredClaimIds, ...reversedDetails]),
      evidence: packageValue,
    });
    assert.equal(verdict.ok, true);
    if (!verdict.ok) return;
    const answer = renderPortfolioAnswer({
      evidence: packageValue,
      plan: verdict.plan,
      selectorLabel: 'All authorized hotels',
    });
    assert.match(answer, /Comfort Suites[^\n]*100 rooms[^\n]*above/);
    assert.match(answer, /Hotel X[^\n]*50 rooms[^\n]*below/);
    assert.doesNotMatch(answer, /Comfort Suites[^\n]*50 rooms/);
    assert.doesNotMatch(answer, /Hotel X[^\n]*100 rooms/);
  });

  test('rejects invented, duplicate and cross-scope claim IDs', () => {
    const packageValue = evidence();
    const catalog = buildPortfolioPresentationClaimCatalog(packageValue);
    const invented = validatePortfolioPresentationPlan({
      candidate: candidateFor(packageValue, [...catalog.requiredClaimIds, 'pc_ffffffffffffffffffffffff']),
      evidence: packageValue,
    });
    assert.equal(invented.ok, false);
    assert.equal(!invented.ok && invented.reason, 'unknown_claim');

    const duplicate = validatePortfolioPresentationPlan({
      candidate: candidateFor(packageValue, [
        ...catalog.requiredClaimIds,
        catalog.requiredClaimIds[0],
      ]),
      evidence: packageValue,
    });
    assert.equal(duplicate.ok, false);
    assert.equal(!duplicate.ok && duplicate.reason, 'duplicate_claim');

    const otherCatalog = buildPortfolioPresentationClaimCatalog(evidence('b'.repeat(64)));
    const crossScope = validatePortfolioPresentationPlan({
      candidate: candidateFor(packageValue, [
        ...catalog.requiredClaimIds,
        otherCatalog.optionalClaimIds[0],
      ]),
      evidence: packageValue,
    });
    assert.equal(crossScope.ok, false);
    assert.equal(!crossScope.ok && crossScope.reason, 'unknown_claim');
  });

  test('withholds a plan that omits coverage or tries to supply factual fields', () => {
    const packageValue = evidence();
    const catalog = buildPortfolioPresentationClaimCatalog(packageValue);
    const coverageId = catalog.claims.find((claim) => claim.kind === 'coverage')?.id;
    assert.ok(coverageId);
    const omission = validatePortfolioPresentationPlan({
      candidate: candidateFor(
        packageValue,
        catalog.requiredClaimIds.filter((id) => id !== coverageId),
      ),
      evidence: packageValue,
    });
    assert.equal(omission.ok, false);
    assert.equal(!omission.ok && omission.reason, 'missing_required_claim');

    const factualInjection = validatePortfolioPresentationPlan({
      candidate: JSON.stringify({
        version: PORTFOLIO_PRESENTATION_PLAN_VERSION,
        lead: 'scope_first',
        orderedClaimIds: catalog.requiredClaimIds,
        hotel: 'Comfort Suites',
        value: 50,
        classification: 'below',
      }),
      evidence: packageValue,
    });
    assert.equal(factualInjection.ok, false);
    assert.equal(!factualInjection.ok && factualInjection.reason, 'invalid_shape');
  });
});

describe('accepted Finding presentation seam', () => {
  test('renders only selected accepted facts, patterns and visibly unverified hypotheses', () => {
    const evidenceValue = evidence();
    const fact = findingEnvelope({
      findingId: 'dddddddd-0000-4000-8000-000000000101',
      kind: 'fact',
      statement: 'The accepted source recorded 17 rooms.',
    });
    const pattern = findingEnvelope({
      findingId: 'dddddddd-0000-4000-8000-000000000102',
      kind: 'pattern',
      statement: 'The accepted source supports a recurring weekday decline.',
    });
    const hypothesis = findingEnvelope({
      findingId: 'dddddddd-0000-4000-8000-000000000103',
      kind: 'hypothesis',
      statement: 'A schedule mismatch may explain 17 delayed rooms.',
    });
    const rejected = {
      ...findingEnvelope({
        findingId: 'dddddddd-0000-4000-8000-000000000104',
        kind: 'fact',
        statement: 'REJECTED_SECRET says 9999 rooms.',
      }),
      claim: { kind: 'recommendation', statement: 'REJECTED_SECRET says 9999 rooms.' },
    };
    const consumer = findingsPackage(evidenceValue, [hypothesis, rejected, pattern, fact]);
    assert.equal(consumer.findings.length, 3);
    assert.equal(consumer.rejected.length, 1);
    const projection = buildPortfolioFindingPresentationProjection({
      evidence: evidenceValue,
      packageValue: consumer,
      accountId: ACCOUNT,
      authorizationHash: AUTHORIZATION_HASH,
      producer: loadedProducer(consumer, evidenceValue.scopeHash),
    });
    const catalog = buildPortfolioPresentationClaimCatalog(evidenceValue, projection);
    const findingIds = catalog.claims
      .filter((claim) => claim.kind === 'finding')
      .map((claim) => claim.id);
    assert.deepEqual([...findingIds].sort(), [...projection.projectedClaimIds].sort());
    const ordered = [...catalog.requiredClaimIds, ...findingIds.reverse()];
    const verdict = validatePortfolioPresentationPlan({
      candidate: candidateFor(evidenceValue, ordered, projection),
      evidence: evidenceValue,
      findingsProjection: projection,
    });
    assert.equal(verdict.ok, true);
    if (!verdict.ok) return;
    const answer = renderPortfolioAnswer({
      evidence: evidenceValue,
      findingsProjection: projection,
      plan: verdict.plan,
      selectorLabel: 'All authorized hotels',
    });
    assert.match(answer, /Accepted finding, observed fact/);
    assert.match(answer, /Accepted finding, supported pattern/);
    assert.match(answer, /UNVERIFIED HYPOTHESIS/);
    assert.match(answer, /accepted source recorded 17 rooms\./i);
    assert.doesNotMatch(answer, /rooms\.\./);
    assert.doesNotMatch(answer, /REJECTED_SECRET|9999|recommendation/i);
    // Founder ruling, 2026-07-28: no em dashes in user-facing copy. This IS
    // user-facing copy — the route streams this exact string to the browser as
    // the chat answer; the model only orders claim ids. Asserted on the rendered
    // output rather than the source because these sentences are assembled from
    // joiners in two files, and a dash can arrive from either one.
    assert.doesNotMatch(
      answer,
      /—/,
      'a portfolio chat answer must contain no em dash; use a period, comma, or colon',
    );

    const displayed = displayedPortfolioFindingClaimIds(catalog, verdict.plan);
    const receipt = buildPortfolioFindingProjectionReceipt({
      projection,
      displayedClaimIds: displayed,
    });
    assert.deepEqual(receipt.displayedClaimIds, [...findingIds].sort());
    assert.deepEqual(receipt.projectedClaimIds, projection.projectedClaimIds);

    const payloads = portfolioFindingNumberReceiptPayloads({
      evidence: evidenceValue,
      findingsProjection: projection,
      plan: verdict.plan,
    });
    assert.equal(payloads.some((value) => value.includes('17')), true);
    const systemPrompt = {
      stable: 'Instructions contain 9999 only as an example.',
      dynamic: 'Rejected reference data also says 9999.',
      factual: '',
      versionLabel: 'finding-number-test',
      stableStamp: 'finding-number-test',
    };
    assert.equal(validatePortfolioAnswerNumbers({
      answer: 'The selected accepted finding reports 17 rooms.',
      systemPrompt,
      selectedFindings: { evidence: evidenceValue, projection, plan: verdict.plan },
    }).ok, true);
    const rejectedNumber = validatePortfolioAnswerNumbers({
      answer: 'The selected accepted finding reports 9999 rooms.',
      systemPrompt,
      selectedFindings: { evidence: evidenceValue, projection, plan: verdict.plan },
    });
    assert.equal(rejectedNumber.ok, false);
    assert.deepEqual(rejectedNumber.violations.map((item) => item.token), ['9999']);
  });

  test('licenses numbers only from plan-selected findings, not merely projected findings', () => {
    const evidenceValue = evidence();
    const projection = findingsProjection(evidenceValue, [
      findingEnvelope({
        findingId: 'dddddddd-0000-4000-8000-000000000111',
        kind: 'fact',
        statement: 'The selected finding reports 17 rooms.',
      }),
      findingEnvelope({
        findingId: 'dddddddd-0000-4000-8000-000000000112',
        kind: 'fact',
        statement: 'The unselected finding reports 4242 rooms.',
      }),
    ]);
    const catalog = buildPortfolioPresentationClaimCatalog(evidenceValue, projection);
    const selectedFinding = catalog.claims.find((claim) => (
      claim.kind === 'finding' && claim.finding?.claim.statement.includes('17 rooms')
    ));
    assert.ok(selectedFinding);
    const verdict = validatePortfolioPresentationPlan({
      candidate: candidateFor(
        evidenceValue,
        [...catalog.requiredClaimIds, selectedFinding.id],
        projection,
      ),
      evidence: evidenceValue,
      findingsProjection: projection,
    });
    assert.equal(verdict.ok, true);
    if (!verdict.ok) return;
    const systemPrompt = {
      stable: '',
      dynamic: formatPortfolioFindingProjectionForPrompt(projection),
      factual: '',
      versionLabel: 'selected-finding-number-test',
      stableStamp: 'selected-finding-number-test',
    };
    assert.equal(validatePortfolioAnswerNumbers({
      answer: 'The selected finding reports 17 rooms.',
      systemPrompt,
      selectedFindings: { evidence: evidenceValue, projection, plan: verdict.plan },
    }).ok, true);
    const unselected = validatePortfolioAnswerNumbers({
      answer: 'The unselected finding reports 4242 rooms.',
      systemPrompt,
      selectedFindings: { evidence: evidenceValue, projection, plan: verdict.plan },
    });
    assert.equal(unselected.ok, false);
    assert.deepEqual(unselected.violations.map((item) => item.token), ['4242']);
  });

  test('anonymous cohorts stay count-only and hostile labels cannot create Markdown links', () => {
    const base = evidence();
    const propertyIds = [
      HOTEL_A,
      HOTEL_B,
      '20000000-0000-4000-8000-000000000003',
      '20000000-0000-4000-8000-000000000004',
      '20000000-0000-4000-8000-000000000005',
    ];
    const facts = propertyIds.map((propertyId, index) => ({
      ...base.facts[index % base.facts.length]!,
      propertyId,
      propertyName: index === 0
        ? '![Secret Hotel](https://evil.example/image)'
        : `Anonymous Hotel ${index + 1}`,
      numerator: 20 + index,
      source: base.facts[0]!.source ? {
        ...base.facts[0]!.source,
        sourceRecordId: `${propertyId}:2026-07-27`,
      } : null,
    }));
    const evidenceValue: PortfolioEvidencePackageV1 = {
      ...base,
      organizationName: '# [Hostile Company](https://evil.example/company)',
      authorizedPropertyIds: propertyIds,
      selectedPropertyIds: propertyIds,
      facts,
      aggregates: [{
        ...base.aggregates[0]!,
        numerator: facts.reduce((sum, fact) => sum + fact.numerator, 0),
        denominator: facts.reduce((sum, fact) => sum + (fact.denominator ?? 0), 0),
        includedPropertyIds: propertyIds,
        denominatorPropertyIds: propertyIds,
      }],
      metricCoverage: [{
        metricId: 'rooms_booked_otb',
        reported: propertyIds.length,
        excluded: 0,
        excludedHotels: [],
      }],
      coverage: {
        authorized: propertyIds.length,
        selected: propertyIds.length,
        reported: propertyIds.length,
        excluded: 0,
        excludedHotels: [],
      },
    };
    const anonymous = findingEnvelope({
      findingId: 'dddddddd-0000-4000-8000-000000000119',
      kind: 'pattern',
      statement: 'Review [this finding](https://evil.example/finding) now!',
    });
    anonymous.scope = {
      ...(anonymous.scope as Record<string, unknown>),
      kind: 'peer_cohort',
      evaluatedPropertyIds: propertyIds,
      affectedPropertyIds: [HOTEL_A],
    };
    anonymous.evidence = {
      ...(anonymous.evidence as Record<string, unknown>),
      coverage: { eligible: propertyIds.length, evaluated: propertyIds.length, affected: 1 },
    };
    anonymous.privacy = {
      mode: 'anonymous_cohort',
      cohortSize: propertyIds.length,
      minimumCohortSize: 5,
      smallCohortSuppressed: false,
      suppressionReason: null,
    };

    const projection = findingsProjection(evidenceValue, [anonymous]);
    const catalog = buildPortfolioPresentationClaimCatalog(evidenceValue, projection);
    const verdict = validatePortfolioPresentationPlan({
      candidate: candidateFor(evidenceValue, undefined, projection),
      evidence: evidenceValue,
      findingsProjection: projection,
    });
    assert.equal(verdict.ok, true);
    if (!verdict.ok) return;
    const findingText = renderPortfolioFindingSection({
      evidence: evidenceValue,
      findingsProjection: projection,
      plan: verdict.plan,
    }).lines.join('\n');
    assert.match(findingText, /1 authorized hotels \(names withheld by anonymous cohort policy\)/);
    assert.doesNotMatch(findingText, /Secret Hotel|Anonymous Hotel/);

    const answer = renderPortfolioAnswer({
      evidence: evidenceValue,
      findingsProjection: projection,
      plan: verdict.plan,
      selectorLabel: '[All hotels](https://evil.example/scope)',
    });
    assert.doesNotMatch(answer, /!\[|\]\(/, 'untrusted data created live Markdown');
    assert.ok(Buffer.byteLength(findingText, 'utf8') <= 12_000);
    assert.deepEqual(
      renderPortfolioFindingSection({
        evidence: evidenceValue,
        findingsProjection: projection,
        plan: verdict.plan,
      }).displayedClaimIds,
      [...catalog.optionalClaimIds].filter((id) => projection.projectedClaimIds.includes(id)).sort(),
    );
  });

  test('adds one terminal mark without doubling period, question or exclamation punctuation', () => {
    const evidenceValue = evidence();
    const hypothesis = findingEnvelope({
      findingId: 'dddddddd-0000-4000-8000-000000000124',
      kind: 'hypothesis',
      statement: 'Hypothesis already ends with a period.',
    });
    (hypothesis.claim as Record<string, unknown>).basis = 'Could this basis be correct?';
    (hypothesis.claim as Record<string, unknown>).verificationNeeded = 'Verify it now!';
    const projection = findingsProjection(evidenceValue, [
      findingEnvelope({
        findingId: 'dddddddd-0000-4000-8000-000000000121',
        kind: 'fact',
        statement: 'A finding without punctuation',
      }),
      findingEnvelope({
        findingId: 'dddddddd-0000-4000-8000-000000000122',
        kind: 'pattern',
        statement: 'Does this pattern persist?',
      }),
      findingEnvelope({
        findingId: 'dddddddd-0000-4000-8000-000000000123',
        kind: 'fact',
        statement: 'This finding is urgent!',
      }),
      hypothesis,
    ]);
    const catalog = buildPortfolioPresentationClaimCatalog(evidenceValue, projection);
    const verdict = validatePortfolioPresentationPlan({
      candidate: candidateFor(evidenceValue, undefined, projection),
      evidence: evidenceValue,
      findingsProjection: projection,
    });
    assert.equal(verdict.ok, true);
    if (!verdict.ok) return;
    const answer = renderPortfolioAnswer({
      evidence: evidenceValue,
      findingsProjection: projection,
      plan: verdict.plan,
      selectorLabel: 'All authorized hotels',
    });
    assert.match(answer, /A finding without punctuation\./);
    assert.match(answer, /Does this pattern persist\?/);
    assert.match(answer, /This finding is urgent!/);
    assert.match(answer, /Hypothesis already ends with a period\./);
    assert.match(answer, /Basis: Could this basis be correct\? Verification needed: Verify it now!/);
    assert.doesNotMatch(answer, /(?:\.\.|\?\.|!\.)/);
  });

  test('content, scope and every rendered provenance revision change the opaque claim ID', () => {
    const evidenceValue = evidence();
    const base = findingEnvelope({
      findingId: 'dddddddd-0000-4000-8000-000000000201',
      kind: 'fact',
      statement: 'A stable accepted statement.',
    });
    const accepted = findingsPackage(evidenceValue, [base]).findings[0];
    const baseId = portfolioFindingPresentationClaimId(evidenceValue.scopeHash, accepted);
    const mutations: Array<(value: Record<string, any>) => void> = [
      (value) => { value.claim.statement = 'A changed accepted statement.'; },
      (value) => { value.producer.engineVersion = 'management-pattern-engine.v2'; },
      (value) => { value.producer.producedAt = '2026-07-27T12:31:00.000Z'; },
      (value) => { value.lifecycle.validThrough = '2026-07-29T13:00:00.000Z'; },
      (value) => { value.scope.scopeFingerprint = 'stable-sha256.v1:scope-revised'; },
      (value) => { value.evidence.queryVersion = 'booked-rooms-presentation.v2'; },
      (value) => { value.evidence.asOf = '2026-07-27T12:26:00.000Z'; },
      (value) => { value.evidence.sourceVersions[0].version = 'pace.v8'; },
      (value) => { value.privacy = { mode: 'named_authorized_properties', propertyCount: 1 }; },
    ];
    const revisedIds = mutations.map((mutate) => {
      const revised = structuredClone(base) as Record<string, any>;
      mutate(revised);
      const finding = findingsPackage(evidenceValue, [revised]).findings[0];
      return portfolioFindingPresentationClaimId(evidenceValue.scopeHash, finding);
    });
    assert.equal(new Set([baseId, ...revisedIds]).size, revisedIds.length + 1);
    assert.notEqual(
      portfolioFindingPresentationClaimId('b'.repeat(64), accepted),
      baseId,
    );

    const reordered = Object.fromEntries(Object.entries(base).reverse());
    const reorderedAccepted = findingsPackage(evidenceValue, [reordered]).findings[0];
    assert.equal(
      portfolioFindingPresentationClaimId(evidenceValue.scopeHash, reorderedAccepted),
      baseId,
    );
  });

  test('one projection bounds 40 long findings for prompt, plan, catalog and receipt', () => {
    const evidenceValue = evidence();
    const inputs = Array.from({ length: 40 }, (_, index) => findingEnvelope({
      findingId: `dddddddd-0000-4000-8000-${String(index + 300).padStart(12, '0')}`,
      kind: 'fact',
      statement: `Finding ${index} `.padEnd(495, 'x').slice(0, 495),
    }));
    const forward = findingsProjection(evidenceValue, inputs);
    const backward = findingsProjection(evidenceValue, [...inputs].reverse());
    assert.deepEqual(backward, forward, 'producer input order must not change the projection');
    assert.ok(forward.projectedClaimIds.length < 40);
    assert.ok(forward.truncation.itemLimitOmittedCount > 0);
    assert.equal(
      forward.truncation.itemLimitOmittedCount
        + forward.truncation.characterLimitOmittedCount,
      40 - forward.projectedClaimIds.length,
    );

    const prompt = formatPortfolioFindingProjectionForPrompt(forward);
    const contract = formatPortfolioPresentationPlanContract(evidenceValue, forward);
    const catalog = buildPortfolioPresentationClaimCatalog(evidenceValue, forward);
    assert.ok(prompt.length <= PORTFOLIO_FINDING_MAX_PROMPT_CHARS);
    assert.ok(contract.length <= PORTFOLIO_FINDING_MAX_PROMPT_CHARS);
    assert.ok(catalog.claims.length <= MAX_PORTFOLIO_PRESENTATION_CLAIMS);
    const catalogFindingIds = catalog.claims
      .filter((claim) => claim.kind === 'finding')
      .map((claim) => claim.id);
    assert.deepEqual(catalogFindingIds, forward.projectedClaimIds);
    for (const id of forward.projectedClaimIds) {
      assert.ok(prompt.includes(id), `prompt omitted projected ${id}`);
      assert.ok(contract.includes(id), `plan contract omitted projected ${id}`);
    }
    for (const id of [
      ...forward.characterOmittedClaimIds,
      ...forward.itemOmittedClaimIds,
    ]) {
      assert.equal(prompt.includes(id), false);
      assert.equal(contract.includes(id), false);
    }

    const verdict = validatePortfolioPresentationPlan({
      candidate: candidateFor(evidenceValue, undefined, forward),
      evidence: evidenceValue,
      findingsProjection: forward,
    });
    assert.equal(verdict.ok, true);
    if (!verdict.ok) return;
    const displayed = displayedPortfolioFindingClaimIds(catalog, verdict.plan);
    const receipt = buildPortfolioFindingProjectionReceipt({
      projection: forward,
      displayedClaimIds: displayed,
    });
    assert.deepEqual([...receipt.projectedClaimIds].sort(), [...catalogFindingIds].sort());
    assert.deepEqual(receipt.displayedClaimIds, [...catalogFindingIds].sort());
  });

  test('budgets the final UTF-8 plan contract before freezing the shared finding subset', () => {
    const base = evidence();
    const propertyIds = Array.from({ length: 25 }, (_, index) => (
      `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
    ));
    const templateFact = base.facts[0];
    const facts = propertyIds.map((propertyId, index) => ({
      ...templateFact,
      propertyId,
      propertyName: `${'é'.repeat(140)}${'A'.repeat(360)} ${index}`,
      numerator: 100 + index,
      source: templateFact.source ? {
        ...templateFact.source,
        sourceRecordId: `${propertyId}:2026-07-27`,
      } : null,
    }));
    const evidenceValue: PortfolioEvidencePackageV1 = {
      ...base,
      authorizedPropertyIds: propertyIds,
      selectedPropertyIds: propertyIds,
      plan: { ...base.plan, detailLimit: 25 },
      facts,
      aggregates: [{
        ...base.aggregates[0],
        numerator: facts.reduce((sum, fact) => sum + fact.numerator, 0),
        denominator: 25 * 120,
        includedPropertyIds: propertyIds,
        denominatorPropertyIds: propertyIds,
      }],
      metricCoverage: [{
        metricId: 'rooms_booked_otb',
        reported: 25,
        excluded: 0,
        excludedHotels: [],
      }],
      coverage: {
        authorized: 25,
        selected: 25,
        reported: 25,
        excluded: 0,
        excludedHotels: [],
      },
    };
    const inputs = Array.from({ length: 10 }, (_, index) => findingEnvelope({
      findingId: `dddddddd-0000-4000-8000-${String(index + 800).padStart(12, '0')}`,
      kind: 'fact',
      statement: `Short accepted finding ${index}.`,
    }));
    const packageValue = findingsPackage(evidenceValue, inputs);
    const producer = loadedProducer(packageValue, evidenceValue.scopeHash);
    const promptOnlyProjection = buildPortfolioFindingProjection({
      packageValue,
      accountId: ACCOUNT,
      authorizationHash: AUTHORIZATION_HASH,
      scopeHash: evidenceValue.scopeHash,
      maxProjectedItems: 10,
      producer,
    });
    assert.equal(promptOnlyProjection.projectedClaimIds.length, 10);
    assert.throws(
      () => formatPortfolioPresentationPlanContract(evidenceValue, promptOnlyProjection),
      /12k byte budget/,
    );

    const projection = buildPortfolioFindingPresentationProjection({
      evidence: evidenceValue,
      packageValue,
      accountId: ACCOUNT,
      authorizationHash: AUTHORIZATION_HASH,
      producer,
    });
    const prompt = formatPortfolioFindingProjectionForPrompt(projection);
    const contract = formatPortfolioPresentationPlanContract(evidenceValue, projection);
    const catalog = buildPortfolioPresentationClaimCatalog(evidenceValue, projection);
    const catalogFindingIds = catalog.claims
      .filter((claim) => claim.kind === 'finding')
      .map((claim) => claim.id);
    assert.ok(projection.projectedClaimIds.length < 10);
    assert.ok(Buffer.byteLength(prompt, 'utf8') <= PORTFOLIO_FINDING_MAX_PROMPT_CHARS);
    assert.ok(Buffer.byteLength(contract, 'utf8') <= PORTFOLIO_FINDING_MAX_PROMPT_CHARS);
    assert.deepEqual(catalogFindingIds, projection.projectedClaimIds);
    for (const id of projection.projectedClaimIds) {
      assert.equal(prompt.includes(id), true);
      assert.equal(contract.includes(id), true);
    }
    const verdict = validatePortfolioPresentationPlan({
      candidate: candidateFor(evidenceValue, undefined, projection),
      evidence: evidenceValue,
      findingsProjection: projection,
    });
    assert.equal(verdict.ok, true);
    if (!verdict.ok) return;
    const receipt = buildPortfolioFindingProjectionReceipt({
      projection,
      displayedClaimIds: displayedPortfolioFindingClaimIds(catalog, verdict.plan),
    });
    assert.deepEqual(receipt.projectedClaimIds, projection.projectedClaimIds);
  });

  test('records an explicit presentation item budget and rejects nonaccepted IDs/prose', () => {
    const evidenceValue = evidence();
    const inputs = Array.from({ length: 40 }, (_, index) => findingEnvelope({
      findingId: `dddddddd-0000-4000-8000-${String(index + 500).padStart(12, '0')}`,
      kind: 'fact',
      statement: `F${index}.`,
    }));
    const packageValue = findingsPackage(evidenceValue, inputs);
    const projection = buildPortfolioFindingProjection({
      packageValue,
      accountId: ACCOUNT,
      authorizationHash: AUTHORIZATION_HASH,
      scopeHash: evidenceValue.scopeHash,
      maxProjectedItems: 35,
      producer: loadedProducer(packageValue, evidenceValue.scopeHash),
    });
    assert.equal(projection.truncation.itemLimitOmittedCount, 5);
    const catalog = buildPortfolioPresentationClaimCatalog(evidenceValue, projection);
    const unknown = validatePortfolioPresentationPlan({
      candidate: JSON.stringify({
        version: PORTFOLIO_PRESENTATION_PLAN_VERSION,
        lead: 'scope_first',
        orderedClaimIds: [...catalog.requiredClaimIds, 'pc_ffffffffffffffffffffffff'],
      }),
      evidence: evidenceValue,
      findingsProjection: projection,
    });
    assert.equal(unknown.ok, false);
    assert.equal(!unknown.ok && unknown.reason, 'unknown_claim');
    const authored = validatePortfolioPresentationPlan({
      candidate: JSON.stringify({
        version: PORTFOLIO_PRESENTATION_PLAN_VERSION,
        lead: 'scope_first',
        orderedClaimIds: catalog.requiredClaimIds,
        findingText: 'MODEL_AUTHORED_FINDING',
      }),
      evidence: evidenceValue,
      findingsProjection: projection,
    });
    assert.equal(authored.ok, false);
    assert.equal(!authored.ok && authored.reason, 'invalid_shape');
  });

  test('enforces both 12 KiB contracts in UTF-8 bytes for multibyte findings', () => {
    const evidenceValue = evidence();
    const inputs = Array.from({ length: 40 }, (_, index) => findingEnvelope({
      findingId: `dddddddd-0000-4000-8000-${String(index + 700).padStart(12, '0')}`,
      kind: 'fact',
      statement: `Finding ${index} ${'🔥'.repeat(220)}`,
    }));
    const projection = findingsProjection(evidenceValue, inputs);
    const prompt = formatPortfolioFindingProjectionForPrompt(projection);
    const contract = formatPortfolioPresentationPlanContract(evidenceValue, projection);
    assert.ok(Buffer.byteLength(prompt, 'utf8') <= PORTFOLIO_FINDING_MAX_PROMPT_CHARS);
    assert.ok(Buffer.byteLength(contract, 'utf8') <= PORTFOLIO_FINDING_MAX_PROMPT_CHARS);
    assert.equal(projection.prompt.byteCount, Buffer.byteLength(prompt, 'utf8'));
    assert.ok(projection.truncation.characterLimitOmittedCount > 0);
    for (const id of projection.projectedClaimIds) {
      assert.ok(prompt.includes(id));
      assert.ok(contract.includes(id));
    }
  });
});
