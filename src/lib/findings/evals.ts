// ─── Detector eval cases ─────────────────────────────────────────────────────
//
// Every declaration ships frozen cases: this context must produce exactly these
// problem keys. Running them needs no database and no clock, because a detector
// is a pure function — which is the point of making it one.
//
// These are not a substitute for the integration tests (those prove the LEDGER
// behaves: dedupe, escalation, mute, isolation). They prove the DETECTION
// behaves, and they live next to the detector so adding one is cheaper than
// not adding one.

import { allDetectors } from './registry';
import type {
  AnyDetector,
  DetectorContext,
  FeedId,
  FeedOutcome,
  FeedShapes,
  FindingDraft,
} from './types';

/** The date every eval case runs on unless it names its own. */
export const EVAL_BUSINESS_DATE = '2026-01-01';
const EVAL_NOW = new Date('2026-01-01T12:00:00.000Z');
const EVAL_PROPERTY_ID = '00000000-0000-4000-8000-000000000001';

export interface EvalCaseResult {
  detectorId: string;
  name: string;
  ok: boolean;
  expected: string[];
  actual: string[];
  /** Why it failed, when it did. */
  detail: string | null;
  /**
   * What the detector actually produced, so a caller can check the DRAFTS and
   * not only their keys.
   *
   * Added for the copy guard (findings-copy-rules.test.ts): every detector
   * already ships fixture feeds that make it fire, which makes this the one
   * place the product can read every detector's real prose without inventing a
   * second set of fixtures that would drift from these. Empty when the case
   * threw.
   */
  drafts: FindingDraft[];
}

function feedOutcome(value: FeedShapes[FeedId]): FeedOutcome {
  return {
    value,
    recordCount: Array.isArray(value) ? value.length : 1,
    asOf: EVAL_NOW,
    weakestInputAgeDays: 0,
  } as FeedOutcome;
}

export function runDetectorEvalCases(detector: AnyDetector): EvalCaseResult[] {
  return detector.declaration.evalCases.map((testCase) => {
    const feeds: Partial<Record<FeedId, FeedOutcome>> = {};
    for (const [feed, value] of Object.entries(testCase.feeds) as Array<
      [FeedId, FeedShapes[FeedId]]
    >) {
      feeds[feed] = feedOutcome(value);
    }

    const ctx: DetectorContext = {
      propertyId: EVAL_PROPERTY_ID,
      now: EVAL_NOW,
      timezone: 'America/Chicago',
      businessDate: testCase.businessDate ?? EVAL_BUSINESS_DATE,
      feeds,
    };

    const expected = [...testCase.expectKeys].sort();
    let actual: string[] = [];
    let detail: string | null = null;
    let produced: FindingDraft[] = [];
    try {
      const drafts = detector.detect(ctx, testCase.params ?? detector.declaration.params ?? {});
      produced = drafts;
      actual = drafts.map((d) => d.key).sort();

      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        detail = `expected keys ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
      } else if (testCase.expectMagnitude) {
        const byKey = new Map(drafts.map((d) => [d.key, d.magnitude]));
        for (const [key, want] of Object.entries(testCase.expectMagnitude)) {
          const got = byKey.get(key);
          if (got !== want) {
            detail = `magnitude for "${key}": expected ${want}, got ${String(got)}`;
            break;
          }
        }
      }
    } catch (e) {
      detail = `threw: ${e instanceof Error ? e.message : String(e)}`;
    }

    return {
      detectorId: detector.declaration.id,
      name: testCase.name,
      ok: detail === null,
      expected,
      actual,
      detail,
      drafts: produced,
    };
  });
}

export function runAllDetectorEvalCases(): EvalCaseResult[] {
  return allDetectors().flatMap(runDetectorEvalCases);
}
