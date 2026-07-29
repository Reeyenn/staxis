// Bilingual (EN + ES) strings for the Inventory AI report overlay. Co-located
// with the overlay (same pattern as inv-i18n.ts / the overlay ss/cs string
// blocks) rather than added to the global translations.ts so parallel features
// don't collide.

import type { Lang } from '../inv-i18n';

export function aiStrings(lang: Lang) {
  return {
    en: {
      // ── Header / chrome ──
      eyebrow: 'Inventory AI',
      title: 'What the AI has learned',
      subtitle:
        'The inventory page stays fully manual. You count and reorder yourself. Behind the scenes the AI keeps learning how fast each item moves. This is its report card.',
      // ── Summary stats ──
      itemsTracked: 'Items tracked',
      graduated: 'Models graduated',
      accuracy: 'Overall accuracy',
      lastPredicted: 'Last predicted',
      pctOff: (n: string) => `${n}% off`,
      accuracyPending: 'Filling in',
      of: 'of',
      // ── Freshness / warnings ──
      staleWarning:
        'The AI hasn’t made a fresh prediction in over a day. Its numbers below may be out of date. Nothing on the inventory page depends on them.',
      noJobsWarning:
        'The AI hasn’t produced any data yet. It starts learning as soon as counts come in.',
      lastPredictedAt: (when: string) => `Last predicted ${when}`,
      never: 'never',
      // ── Empty state ──
      emptyTitle: 'The AI hasn’t made any predictions yet',
      emptyBody:
        'It starts learning as counts come in. Keep counting inventory the normal way. After a few counts per item, the AI will begin predicting daily usage and show its work here.',
      // ── Per-item list ──
      listHeading: 'Item by item',
      predictedUsage: 'Predicted usage',
      predictedStock: 'Predicted on hand',
      perDay: '/day',
      lastCount: 'Last real count',
      predictionWas: 'AI predicted',
      wasOff: (n: string) => `${n}% off`,
      spotOn: 'spot on',
      noComparisonYet: 'no test yet',
      noPredictionYet: 'No prediction yet',
      countProgress: (a: number, b: number) => `${a} of ${b} counts`,
      windowsProgress: (a: number, b: number) => `${a} of ${b} clean data windows`,
      pairsProgress: (a: number, b: number) => `${a} of ${b} graded predictions`,
      // Ultra-short "why it's stuck" — one per trainer reason code, ≤5 words.
      gradReason: (code: string): string =>
        ({
          insufficient_training_windows: 'needs more count history',
          insufficient_prospective_pairs: 'needs more tests',
          prospective_span_too_short: 'tests too close together',
          prospective_wape_too_high: 'still off, keeps learning',
          prospective_actuals_all_zero: 'barely moves, stays manual',
          does_not_beat_baseline: 'not beating the average yet',
        })[code] ?? '',
      // ── Status chips ──
      chipGraduated: 'Trusted',
      chipLearning: 'Learning',
      chipNotEnough: 'Not enough data',
      // ── Loading / error ──
      loading: 'Loading…',
      loadError: 'Couldn’t load the AI report. Try again in a moment.',
      // ── Tracker hero: the one question, "how far to trusted?" ──
      heroCaption: 'of the way to trusted predictions',
      heroGoal: 'GOAL',
      heroGoalPct: '90%',
      heroGoalSub: 'predictions you can trust, about 90% accurate',
      heroEst: 'measured by real data collected, not by days. Typical pace: about 3 months of steady counting.',
      perDayShort: '/day',
      gradeOff: (n: string) => `${n}% off`,
      gradeSpotOn: 'spot on',
      // ── Visual guide ──
      guideButton: 'How it works',
      guideEyebrow: 'In one look',
      guideTitle: 'How it learns',
      g1Title: 'It watches two things',
      g1Counts: 'your counts',
      g1Occupancy: 'occupancy %',
      g1Learns: 'inventory usage per guest',
      g2Title: 'Every count is a test',
      g2Count: 'count',
      g2Compare: 'compare',
      g2Grade: 'grade',
      g2Badge: 'enough passed tests → Trusted',
      g3Title: 'Accuracy grows',
      g3Start: 'day one · 0%',
      g3Band: '85–90%',
      g3Mark: '~3 months',
      g3M0: 'first count',
      g3M0b: 'industry guesses',
      g3M1: 'week 1–2',
      g3M1b: 'learning your hotel',
      g3M2: 'week 3',
      g3M2b: 'real predictions',
      g3M3: 'month 1–2',
      g3M3b: 'passing tests',
      g3M4: 'month 2–3',
      g3M4b: 'Trusted · 85–90%',
      g4Title: 'What if it’s wrong?',
      g4Manual: 'it can’t order anything',
      g4Caught: 'every miss gets caught',
      g4Badge: 'no badge until proven',
      g4Kicker: 'a wrong prediction only costs the badge, never your inventory',
    },

  }['en'];
}

export type AiStrings = ReturnType<typeof aiStrings>;
