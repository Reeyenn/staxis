import {
  buildAnswerReceipt,
  checkAnswerNumbers,
} from '@/lib/agent/number-guard';
import {
  formatEvidenceForPrompt,
  type PortfolioEvidencePackageV1,
} from '@/lib/agent/portfolio-intelligence/evidence';

export const PORTFOLIO_GOLDEN_QUESTIONS = [
  {
    id: 'all-hotels-booked-vs-normal',
    question: 'How many rooms are booked today across all my hotels, and which hotels are above or below normal?',
    expectedGrain: 'all_authorized',
    expectedMetric: 'rooms_booked_otb',
  },
  {
    id: 'named-hotel-booked',
    question: 'How many rooms are booked today at Comfort Suites?',
    expectedGrain: 'hotel',
    expectedMetric: 'rooms_booked_otb',
  },
  {
    id: 'named-hotel-current-summary',
    question: 'What is happening at Hotel X today?',
    expectedGrain: 'hotel',
    expectedMetric: 'current_summary',
  },
  {
    id: 'portfolio-summary',
    question: 'How are my hotels doing?',
    expectedGrain: 'all_authorized',
    expectedMetric: 'current_summary',
  },
  {
    id: 'housekeeping-comparison',
    question: 'Compare housekeeping performance across all my hotels.',
    expectedGrain: 'all_authorized',
    expectedMetric: 'housekeeping',
  },
] as const;

export type PortfolioEvalDimension =
  | 'factuality'
  | 'scope_disclosure'
  | 'source_fidelity'
  | 'coverage_disclosure'
  | 'comparison_fidelity'
  | 'abstention'
  | 'small_cohort_privacy'
  | 'bounded_cost';

export interface PortfolioAnswerEvalInput {
  question: string;
  answer: string;
  evidence: PortfolioEvidencePackageV1;
  activeScopeLabel: string;
  modelCalls: number;
  costUsd: number;
  maxCostUsd: number;
}

export interface PortfolioAnswerEvalResult {
  passed: boolean;
  dimensions: Record<PortfolioEvalDimension, { passed: boolean; detail: string }>;
}

function folded(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US');
}

function containsAny(value: string, needles: readonly string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}

/** Deterministic grading for model-produced portfolio prose. This does not
 * judge style; it gates the behaviors that can leak or mislead: novel numbers,
 * hidden scope, missing source/coverage, invented values under partial data,
 * small-cohort inference, and unbounded model use. */
export function evaluatePortfolioAnswer(
  input: PortfolioAnswerEvalInput,
): PortfolioAnswerEvalResult {
  const answer = folded(input.answer);
  const evidenceText = formatEvidenceForPrompt(input.evidence);
  const numberResult = checkAnswerNumbers(input.answer, buildAnswerReceipt({
    systemPrompt: { stable: '', dynamic: evidenceText, factual: evidenceText },
    history: [],
    newUserMessage: input.question,
    toolPayloads: [],
  }));

  const scopeCount = input.evidence.coverage.selected;
  const reportCount = input.evidence.coverage.reported;
  const selectedNames = input.evidence.facts
    .filter((fact) => input.evidence.selectedPropertyIds.includes(fact.propertyId))
    .map((fact) => folded(fact.propertyName));
  const scopeDisclosed = answer.includes(folded(input.activeScopeLabel))
    || (scopeCount === 1 && selectedNames.some((name) => answer.includes(name)))
    || (scopeCount > 1 && answer.includes(String(scopeCount))
      && containsAny(answer, ['hotel', 'property', 'portfolio', 'scope']));

  const hasFacts = input.evidence.facts.some((fact) => fact.quality !== 'excluded');
  const sourceDisclosed = !hasFacts || (
    containsAny(answer, ['pms', 'source', 'staxis', 'booking pace', 'recorded'])
    && containsAny(answer, ['fresh', 'captured', 'updated', 'as of', 'business date'])
  );

  const partial = reportCount < scopeCount;
  const coverageDisclosed = !partial || (
    answer.includes(String(reportCount))
    && answer.includes(String(scopeCount))
    && containsAny(answer, ['reported', 'coverage', 'omitted', 'excluded', 'unavailable'])
  );
  const zeroCoverage = reportCount === 0;
  const abstained = !zeroCoverage || (
    containsAny(answer, ['unavailable', 'could not', "couldn't", 'no trusted', 'cannot answer'])
    && !containsAny(answer, ['all hotels are', 'portfolio total is', 'the total is'])
  );

  const anonymousPeerClaim = containsAny(answer, [
    'peer average', 'peer benchmark', 'top quartile', 'bottom quartile', 'industry average',
  ]);
  const smallCohortSafe = input.evidence.coverage.selected >= 5 || !anonymousPeerClaim;
  const asksForNormalComparison = input.evidence.plan.comparison === 'own_same_weekday_normal';
  const comparableFacts = input.evidence.facts.filter((fact) => (
    input.evidence.selectedPropertyIds.includes(fact.propertyId)
      && fact.quality !== 'excluded'
      && fact.baseline
      && fact.baseline.classification !== 'unavailable'
  ));
  const comparisonUnavailableFacts = input.evidence.facts.filter((fact) => (
    input.evidence.selectedPropertyIds.includes(fact.propertyId)
      && fact.quality !== 'excluded'
      && (!fact.baseline || fact.baseline.classification === 'unavailable')
  ));
  const comparisonFactsDisclosed = comparableFacts.every((fact) => (
    answer.includes(folded(fact.propertyName))
      && answer.includes(fact.baseline!.classification)
  ));
  const unavailableComparisonDisclosed = comparisonUnavailableFacts.length === 0
    || containsAny(answer, ['comparison unavailable', 'normal unavailable', 'insufficient history', 'could not compare']);
  const comparisonFaithful = !asksForNormalComparison
    || (comparisonFactsDisclosed && unavailableComparisonDisclosed);
  const boundedCost = input.modelCalls === 1
    && Number.isFinite(input.costUsd)
    && input.costUsd >= 0
    && input.costUsd <= input.maxCostUsd;

  const dimensions: PortfolioAnswerEvalResult['dimensions'] = {
    factuality: {
      passed: numberResult.ok,
      detail: numberResult.ok
        ? 'Every answer number appears in the immutable evidence or user question.'
        : `Unbacked numbers: ${numberResult.violations.map((item) => item.token).join(', ')}`,
    },
    scope_disclosure: {
      passed: scopeDisclosed,
      detail: scopeDisclosed ? 'Active grain is visible.' : 'Answer hides the active portfolio/hotel grain.',
    },
    source_fidelity: {
      passed: sourceDisclosed,
      detail: sourceDisclosed ? 'Source and freshness are disclosed.' : 'Facts lack a source or freshness statement.',
    },
    coverage_disclosure: {
      passed: coverageDisclosed,
      detail: coverageDisclosed ? 'Partial coverage is explicit.' : 'Partial coverage is presented without exact reported/selected counts.',
    },
    comparison_fidelity: {
      passed: comparisonFaithful,
      detail: comparisonFaithful
        ? 'Requested own-history classifications and unavailable comparisons are explicit.'
        : 'The answer omits or changes a requested hotel-level above/below/typical classification.',
    },
    abstention: {
      passed: abstained,
      detail: abstained ? 'No-data answers abstain.' : 'A zero-coverage answer makes a factual total claim.',
    },
    small_cohort_privacy: {
      passed: smallCohortSafe,
      detail: smallCohortSafe ? 'No forbidden small-cohort benchmark claim.' : 'Anonymous peer inference was made for fewer than five hotels.',
    },
    bounded_cost: {
      passed: boundedCost,
      detail: boundedCost
        ? 'One bounded synthesis call.'
        : `Expected one call and <= $${input.maxCostUsd.toFixed(4)}; saw ${input.modelCalls} / $${input.costUsd.toFixed(4)}.`,
    },
  };
  return {
    passed: Object.values(dimensions).every((dimension) => dimension.passed),
    dimensions,
  };
}
