// ─── Detector: durable operational patterns ──────────────────────────────────
//
// Ports `src/lib/agent/operational-signals.ts` into the one runner WITHOUT
// touching it. That module still aggregates the hotel's own records exactly as
// it did — same thresholds, same stable topic slugs — and its two existing
// consumers (nightly memory consolidation and the drip question) still call it
// directly and still emit exactly what they emitted before. This detector reads
// the same signals and records them in the findings ledger, which is the first
// time "room 214 has an HVAC problem" survives as a THING with a status rather
// than as a low-confidence memory row that quietly expires.
//
// The signal's `topic` is reused verbatim as the problem key. That is not a
// convenience: it is the same identity agent_memory and agent_knowledge_questions
// key on, so a manager who answers the drip question about room 214 and a
// finding about room 214 are talking about one problem across three tables.

import { templateContent, type OperationalSignal } from '@/lib/agent/operational-signals';

import { registerDetector } from '../registry';
import type { Detector, DetectorContext, DetectorParams, FindingDraft } from '../types';
import { readFeed } from '../types';

const RECEIPT = 'operational_signals_30d';

export function draftsFromSignals(signals: readonly OperationalSignal[]): FindingDraft[] {
  return signals.map((signal) => ({
    // The signal's own stable slug — identity, never the measurement. A fifth
    // work order tomorrow lands on this same row.
    key: signal.topic,
    summary: templateContent(signal),
    severity: signal.severity,
    magnitude: signal.count,
    evidence: {
      queryId: RECEIPT,
      params: {
        window_days: signal.windowDays,
        target_kind: signal.targetKind,
        target_value: signal.targetValue,
        detail: signal.detail,
      },
      values: {
        count: signal.count,
        category: signal.category,
        target_label: signal.targetLabel,
      },
      basis: signal.metric,
    },
    // No price basis exists for these yet. Saying nothing about money is the
    // honest option; a made-up range would be exactly the lie the range format
    // was chosen to avoid.
    price: null,
  }));
}

export const operationalPatternDetector: Detector<DetectorParams> = {
  declaration: {
    id: 'operational_pattern',
    description:
      'Repeated maintenance, complaints, weekend noise, inspection failures or slow cleans on the same room or floor over 30 days.',
    inputs: ['operational_signals'],
    requires: [
      {
        feed: 'operational_signals',
        minRecords: 0,
        because:
          'the hotel has logged no work orders, complaints, inspections or cleaning times to find a pattern in',
      },
    ],
    receiptQueryId: RECEIPT,
    defaultDisposition: 'fyi',
    defaultSeverity: 'attention',
    // Four known work orders is consent to four, not to nine.
    escalation: { factor: 2, minDelta: 3 },
    // The signal layer caps itself at 12; matching it keeps the two in step.
    maxPerRun: 12,
    // The window is 30 days, so a pattern that stops appearing for a week has
    // genuinely stopped — the underlying rows aged out of the window.
    staleAfterDays: 7,
    evalCases: [
      {
        name: 'a repeated maintenance signal becomes one finding keyed on the room',
        feeds: {
          operational_signals: [
            {
              topic: 'op_maint_214_hvac',
              category: 'maintenance',
              severity: 'attention',
              targetLabel: 'Room 214',
              metric: '4 hvac work orders in 30 days',
              count: 4,
              windowDays: 30,
              targetKind: 'room',
              targetValue: '214',
              detail: 'hvac',
            },
          ],
        },
        expectKeys: ['op_maint_214_hvac'],
        expectMagnitude: { op_maint_214_hvac: 4 },
      },
      {
        name: 'the same room with more work orders is the SAME problem, not a new one',
        feeds: {
          operational_signals: [
            {
              topic: 'op_maint_214_hvac',
              category: 'maintenance',
              severity: 'attention',
              targetLabel: 'Room 214',
              metric: '9 hvac work orders in 30 days',
              count: 9,
              windowDays: 30,
              targetKind: 'room',
              targetValue: '214',
              detail: 'hvac',
            },
          ],
        },
        expectKeys: ['op_maint_214_hvac'],
        expectMagnitude: { op_maint_214_hvac: 9 },
      },
      {
        name: 'no signals means no findings — and that is a real answer, not a failure',
        feeds: { operational_signals: [] },
        expectKeys: [],
      },
    ],
  },
  detect(ctx: DetectorContext): FindingDraft[] {
    return draftsFromSignals(readFeed(ctx, 'operational_signals'));
  },
};

registerDetector(operationalPatternDetector);
