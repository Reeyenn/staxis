import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluatePortfolioAnswer,
  PORTFOLIO_GOLDEN_QUESTIONS,
} from '@/lib/agent/evals/portfolio';
import type { PortfolioEvidencePackageV1 } from '@/lib/agent/portfolio-intelligence/evidence';
import { metricDefinition } from '@/lib/agent/portfolio-intelligence/metrics';
import {
  PORTFOLIO_EVIDENCE_VERSION,
  PORTFOLIO_QUERY_PLAN_VERSION,
} from '@/lib/agent/portfolio-intelligence/versions';

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

function evidence(reported = 17, selected = 20): PortfolioEvidencePackageV1 {
  const selectedPropertyIds = Array.from({ length: selected }, (_, index) => uuid(index + 1));
  const comparisonFact = (
    propertyId: string,
    propertyName: string,
    classification: 'above' | 'below',
    numerator: number,
  ): PortfolioEvidencePackageV1['facts'][number] => ({
    propertyId,
    propertyName,
    timezone: 'America/Chicago',
    businessDate: '2026-07-27',
    metricId: 'rooms_booked_otb',
    metricVersion: 'rooms-booked-otb.v1',
    numerator,
    denominator: 20,
    normalizedValue: (numerator / 20) * 100,
    unit: 'rooms',
    freshness: 'fresh',
    quality: 'included',
    exclusionCode: null,
    exclusionReason: null,
    comparisonExclusionCode: null,
    comparisonExclusionReason: null,
    source: {
      sourceTable: 'pms_booking_pace',
      sourceRecordId: uuid(700 + numerator),
      ingestRunId: uuid(800 + numerator),
      sourceKind: 'cua',
      sourceCapturedAt: '2026-07-27T11:55:00.000Z',
      parserName: 'pace',
      parserVersion: '2',
      knowledgeFileId: null,
      reportFileId: null,
    },
    baseline: {
      version: 'same-weekday-lead0-median-mad.v1',
      n: 6,
      median: 10,
      mad: 1,
      lower: 8,
      upper: 12,
      classification,
      windowStart: '2026-06-15',
      windowEnd: '2026-07-20',
    },
  });
  return {
    version: PORTFOLIO_EVIDENCE_VERSION,
    scopeReceiptId: uuid(500),
    scopeHash: 'scope-hash',
    organizationId: uuid(600),
    organizationName: 'Acme Hotels',
    resolvedAt: '2026-07-27T12:00:00.000Z',
    authorizedPropertyIds: selectedPropertyIds,
    selectedPropertyIds,
    plan: {
      version: PORTFOLIO_QUERY_PLAN_VERSION,
      intent: 'metric_comparison',
      selector: { kind: 'all_authorized' },
      metricIds: ['rooms_booked_otb'],
      window: { kind: 'hotel_business_today' },
      groupBy: 'property',
      comparison: 'own_same_weekday_normal',
      detailLimit: 20,
      defaultedScope: false,
    },
    metrics: [metricDefinition('rooms_booked_otb')],
    facts: reported > 0 ? [
      comparisonFact(uuid(1), 'Comfort Suites', 'above', 18),
      comparisonFact(uuid(2), 'Airport Lodge', 'below', 6),
    ] : [],
    aggregates: reported > 0 ? [{
      claimKind: 'aggregate',
      metricId: 'rooms_booked_otb',
      numerator: 170,
      denominator: 340,
      normalizedValue: 50,
      normalizedUnit: 'percent',
      includedPropertyIds: selectedPropertyIds.slice(0, reported),
      denominatorPropertyIds: selectedPropertyIds.slice(0, reported),
    }] : [],
    metricCoverage: [{
      metricId: 'rooms_booked_otb',
      reported,
      excluded: selected - reported,
      excludedHotels: selectedPropertyIds.slice(reported).map((propertyId, index) => ({
        propertyId,
        propertyName: `Hotel ${reported + index + 1}`,
        code: 'source_unavailable',
        reason: 'PMS measure unavailable',
      })),
    }],
    coverage: {
      authorized: selected,
      selected,
      reported,
      excluded: selected - reported,
      excludedHotels: selectedPropertyIds.slice(reported).map((propertyId, index) => ({
        propertyId,
        propertyName: `Hotel ${reported + index + 1}`,
        code: 'source_unavailable',
        reason: 'PMS measure unavailable',
      })),
    },
    generatedAt: '2026-07-27T12:00:00.000Z',
    durationMs: 250,
    partial: reported < selected,
  };
}

test('golden bank pins portfolio and named-property acceptance questions', () => {
  assert.ok(PORTFOLIO_GOLDEN_QUESTIONS.some((item) => item.id === 'all-hotels-booked-vs-normal'));
  assert.ok(PORTFOLIO_GOLDEN_QUESTIONS.some((item) => item.id === 'named-hotel-booked'));
  assert.ok(PORTFOLIO_GOLDEN_QUESTIONS.some((item) => item.id === 'named-hotel-current-summary'));
});

test('portfolio answer eval accepts an exact partial-data answer with scope, source and freshness', () => {
  const result = evaluatePortfolioAnswer({
    question: PORTFOLIO_GOLDEN_QUESTIONS[0].question,
    answer:
      'Active scope: All authorized hotels. 17 of 20 hotels reported; 3 were omitted because their PMS measure was unavailable. '
      + 'The fresh PMS booking-pace source, captured as of the 2026-07-27 business date, supports an aggregate of 170 rooms on the books. '
      + 'Against each hotel’s own recent same-weekday history, Comfort Suites is above normal and Airport Lodge is below normal.',
    evidence: evidence(),
    activeScopeLabel: 'All authorized hotels',
    modelCalls: 1,
    costUsd: 0.04,
    maxCostUsd: 0.10,
  });
  assert.equal(result.passed, true, JSON.stringify(result.dimensions, null, 2));
});

test('portfolio answer eval rejects an aggregate-only answer when above/below hotels were requested', () => {
  const result = evaluatePortfolioAnswer({
    question: PORTFOLIO_GOLDEN_QUESTIONS[0].question,
    answer:
      'Active scope: All authorized hotels. 17 of 20 hotels reported; 3 were omitted because their PMS measure was unavailable. '
      + 'The fresh PMS booking-pace source, captured as of the 2026-07-27 business date, supports an aggregate of 170 rooms on the books.',
    evidence: evidence(),
    activeScopeLabel: 'All authorized hotels',
    modelCalls: 1,
    costUsd: 0.04,
    maxCostUsd: 0.10,
  });
  assert.equal(result.passed, false);
  assert.equal(result.dimensions.comparison_fidelity.passed, false);
});

test('portfolio answer eval rejects fabricated numbers, hidden partial coverage, missing source and excess calls', () => {
  const result = evaluatePortfolioAnswer({
    question: PORTFOLIO_GOLDEN_QUESTIONS[0].question,
    answer: 'Everything looks good. All hotels are 99% occupied versus peers.',
    evidence: evidence(),
    activeScopeLabel: 'All authorized hotels',
    modelCalls: 2,
    costUsd: 0.25,
    maxCostUsd: 0.10,
  });
  assert.equal(result.passed, false);
  assert.equal(result.dimensions.factuality.passed, false);
  assert.equal(result.dimensions.coverage_disclosure.passed, false);
  assert.equal(result.dimensions.source_fidelity.passed, false);
  assert.equal(result.dimensions.bounded_cost.passed, false);
});

test('zero-coverage and small-cohort answers must abstain and avoid anonymous peer inference', () => {
  const result = evaluatePortfolioAnswer({
    question: 'How are my hotels doing?',
    answer: 'The portfolio total is 75 rooms and it is in the top quartile.',
    evidence: evidence(0, 3),
    activeScopeLabel: 'All authorized hotels',
    modelCalls: 1,
    costUsd: 0.01,
    maxCostUsd: 0.10,
  });
  assert.equal(result.passed, false);
  assert.equal(result.dimensions.abstention.passed, false);
  assert.equal(result.dimensions.small_cohort_privacy.passed, false);
});
