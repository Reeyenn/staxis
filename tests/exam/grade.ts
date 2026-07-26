// ─── The grader ──────────────────────────────────────────────────────────────
//
// Compares what the real runner wrote against what the day's label said must be
// there, and turns any difference into a sentence somebody can act on without
// opening a debugger:
//
//   supply_spend_baseline MISSED the planted overspend on exam-day supply-01
//     (expected magnitude 135000-135000) — twelve steady weeks then a bill more
//     than twice the biggest of them.
//
//   work_order_rate_baseline FIRED on hard-negative wo-rate-02 — invented
//     finding "weekly_work_order_rate". Nothing on this day should have
//     produced one.
//
// TWO SCORES, AND THEY ARE NOT SYMMETRIC.
// Recall failures mean Staxis went quiet about something real: expensive, and
// invisible until somebody notices the money months later. Precision failures
// mean Staxis said something that was not true: cheaper in dollars and far more
// expensive in trust, because a manager only has to be lied to twice.
//
// Deliberately no LLM anywhere in this file, and none in anything it calls.
// This grades the deterministic layer — detectors, runner, silencer, and the
// price ranges that are arithmetic on the hotel's own rows.

import type { Finding, FindingRunSummary } from '@/lib/findings/types';

import type { ExamDay, ExpectedFinding, SilentDetector } from './types';

export interface GradedFailure {
  dayId: string;
  detectorId: string;
  /** 'recall' — it went quiet about something real. 'precision' — it invented
   *  something. 'detail' — it found the right thing and described it wrongly. */
  kind: 'recall' | 'precision' | 'detail' | 'skip' | 'ledger';
  message: string;
}

export interface DayResult {
  dayId: string;
  assertions: number;
  failures: GradedFailure[];
}

export interface ExamScore {
  days: number;
  assertions: number;
  /** Planted patterns that went un-found. The expensive kind of wrong. */
  recallFailures: number;
  /** Findings nobody planted. The trust-destroying kind of wrong. */
  precisionFailures: number;
}

/** Placeholders a label may use for ids only known once the hotel exists. */
export interface Substitutions {
  businessDate: string;
  itemId(slot: number): string;
}

function fill(value: string, subs: Substitutions): string {
  return value
    .replace(/\{businessDate\}/g, subs.businessDate)
    .replace(/\{item(\d+)\}/g, (_, slot: string) => subs.itemId(Number(slot)));
}

/** What the ledger actually holds for one finding, flattened for comparison. */
export interface ObservedAction {
  dedupeKey: string;
  kind: string;
}

export interface GradeInput {
  day: ExamDay;
  /** Which pass this is — the label quoted in failures. */
  pass: 'night one' | 'night two';
  expected: readonly ExpectedFinding[];
  silent: readonly SilentDetector[];
  summary: FindingRunSummary;
  findings: readonly Finding[];
  actions: readonly ObservedAction[];
  subs: Substitutions;
  /** Total rows in `findings` for this hotel, whatever their status. */
  totalRows: number;
  maxTotalRows?: number;
}

export function gradeDay(input: GradeInput): DayResult {
  const { day, pass, summary, findings, actions, subs } = input;
  const failures: GradedFailure[] = [];
  let assertions = 0;

  const where = pass === 'night one' ? `exam-day ${day.id}` : `exam-day ${day.id} (${pass})`;
  const fail = (detectorId: string, kind: GradedFailure['kind'], message: string) =>
    failures.push({ dayId: day.id, detectorId, kind, message });

  // A detector that threw is neither a recall nor a precision failure — it is a
  // detector that did not run, and every verdict below it is meaningless.
  for (const error of summary.errors) {
    fail(error.detectorId, 'skip', `${error.detectorId} THREW on ${where}: ${error.error}`);
  }

  const byKey = new Map<string, Finding>();
  for (const finding of findings) byKey.set(finding.dedupeKey, finding);
  const matched = new Set<string>();

  // ── recall: everything the label says must be here ──────────────────────
  for (const want of input.expected) {
    const dedupeKey = `${want.detectorId}:${fill(want.key, subs)}`;
    const found = byKey.get(dedupeKey);
    assertions += 1;
    if (!found) {
      const skipped = summary.skipped.find((s) => s.detectorId === want.detectorId);
      fail(
        want.detectorId,
        'recall',
        `${want.detectorId} MISSED "${fill(want.key, subs)}" on ${where} ` +
          `(expected magnitude ${want.magnitude[0]}-${want.magnitude[1]}) — ${want.why}` +
          (skipped ? ` [the runner SKIPPED it: ${skipped.because}]` : ''),
      );
      continue;
    }
    matched.add(dedupeKey);
    assertions += gradeDetail(found, want, subs, actions, where, fail);
  }

  // ── precision: nothing else may be here ─────────────────────────────────
  for (const finding of findings) {
    assertions += 1;
    if (matched.has(finding.dedupeKey)) continue;
    fail(
      finding.detectorId,
      'precision',
      `${finding.detectorId} FIRED on ${where} — invented finding "${finding.dedupeKey}" ` +
        `(magnitude ${finding.magnitude}): "${finding.summary}". ` +
        `Nothing on this day should have produced it. Day: ${day.why}`,
    );
  }

  // ── silence is only meaningful when the detector actually RAN ───────────
  for (const quiet of input.silent) {
    assertions += 1;
    const skipped = summary.skipped.find((s) => s.detectorId === quiet.detectorId);
    if (skipped) {
      fail(
        quiet.detectorId,
        'skip',
        `${quiet.detectorId} was SKIPPED on ${where} ("${skipped.because}") when the label ` +
          `says it should have run and stayed quiet — ${quiet.why}. A skipped detector proves ` +
          'nothing about precision: it never looked.',
      );
    }
    const dormant = summary.dormant.find((d) => d.detectorId === quiet.detectorId);
    if (dormant) {
      fail(
        quiet.detectorId,
        'skip',
        `${quiet.detectorId} was DORMANT on ${where}; the exam runs with demotion off, so this ` +
          'means the runner is resting checks it was told not to.',
      );
    }
  }

  // ── the runner's own honesty about what it could not check ──────────────
  for (const want of day.skipped ?? []) {
    assertions += 1;
    const skipped = summary.skipped.find((s) => s.detectorId === want.detectorId);
    if (!skipped) {
      fail(
        want.detectorId,
        'skip',
        `${want.detectorId} was NOT reported as skipped on ${where}. ${want.why} ` +
          'Silence and "no data" must never look the same in the run summary.',
      );
      continue;
    }
    if (!want.becauseMatches.test(skipped.because)) {
      fail(
        want.detectorId,
        'skip',
        `${want.detectorId} skipped on ${where} for the wrong reason: "${skipped.because}" ` +
          `does not match ${want.becauseMatches}.`,
      );
    }
  }

  // ── the ledger: one row per problem, however many nights ────────────────
  if (input.maxTotalRows !== undefined) {
    assertions += 1;
    if (input.totalRows > input.maxTotalRows) {
      fail(
        day.detector,
        'ledger',
        `${where} left ${input.totalRows} rows in the ledger; the same problem must occupy ` +
          `at most ${input.maxTotalRows}. A dedupe key that carries the measurement looks ` +
          'exactly like this.',
      );
    }
  }

  return { dayId: day.id, assertions, failures };
}

function gradeDetail(
  found: Finding,
  want: ExpectedFinding,
  subs: Substitutions,
  actions: readonly ObservedAction[],
  where: string,
  fail: (detectorId: string, kind: GradedFailure['kind'], message: string) => void,
): number {
  let assertions = 0;
  const id = want.detectorId;
  const say = (message: string) => fail(id, 'detail', `${id} on ${where}: ${message}`);

  assertions += 1;
  if (found.magnitude < want.magnitude[0] || found.magnitude > want.magnitude[1]) {
    say(
      `magnitude ${found.magnitude} is outside the labelled ${want.magnitude[0]}-` +
        `${want.magnitude[1]}. ${want.why}`,
    );
  }

  if (want.disposition) {
    assertions += 1;
    if (found.disposition !== want.disposition) {
      say(`disposition "${found.disposition}", labelled "${want.disposition}"`);
    }
  }

  if (want.severity) {
    assertions += 1;
    if (found.severity !== want.severity) {
      say(`severity "${found.severity}", labelled "${want.severity}"`);
    }
  }

  if (want.target !== undefined) {
    assertions += 1;
    const target = found.evidence.target ?? null;
    if (want.target === null) {
      if (target) {
        say(
          `carries a target ${JSON.stringify(target)} but this finding is about the HOTEL — a ` +
            'chip would attach it to a thing it is not about',
        );
      }
    } else if (!target) {
      say(`carries no target; a screen cannot look this up. Labelled ${JSON.stringify(want.target)}`);
    } else {
      const wanted = { kind: want.target.kind, value: fill(want.target.value, subs) };
      if (target.kind !== wanted.kind || String(target.value) !== wanted.value) {
        say(`target ${JSON.stringify(target)}, labelled ${JSON.stringify(wanted)}`);
      }
    }
  }

  if (want.price !== undefined) {
    assertions += 1;
    if (want.price === 'none') {
      if (found.price) {
        say(
          `quotes ${found.price.lowCents}-${found.price.highCents} cents when this hotel's own ` +
            'rows cannot support a range. An invented number is the one thing the range format ' +
            'exists to prevent',
        );
      }
    } else if (!found.price) {
      say(
        'carries no dollar figure, but the label says its own rows support one ' +
          `(${want.price.lowCents[0]}-${want.price.highCents[1]} cents)`,
      );
    } else {
      const { lowCents, highCents, basisMatches } = want.price;
      if (found.price.lowCents < lowCents[0] || found.price.lowCents > lowCents[1]) {
        say(`price low ${found.price.lowCents}c outside labelled ${lowCents[0]}-${lowCents[1]}c`);
      }
      if (found.price.highCents < highCents[0] || found.price.highCents > highCents[1]) {
        say(`price high ${found.price.highCents}c outside labelled ${highCents[0]}-${highCents[1]}c`);
      }
      if (!basisMatches.test(found.price.basis)) {
        say(
          `price basis "${found.price.basis}" does not match ${basisMatches} — the basis is what ` +
            'a manager checks the number against, so a drifting basis is a drifting claim',
        );
      }
    }
  }

  if (want.priceBasisMatches) {
    assertions += 1;
    const note = String(found.evidence.values.price_basis ?? '');
    if (!want.priceBasisMatches.test(note)) {
      say(`price_basis "${note}" does not match ${want.priceBasisMatches}`);
    }
  }

  if (want.summaryMatches) {
    assertions += 1;
    if (!want.summaryMatches.test(found.summary)) {
      say(`summary "${found.summary}" does not match ${want.summaryMatches}`);
    }
  }

  const wantAction = want.action;
  if (wantAction !== undefined) {
    assertions += 1;
    const offered = actions.filter((a) => a.dedupeKey === found.dedupeKey);
    if (wantAction === 'none') {
      if (offered.length > 0) {
        say(
          `offered "${offered[0].kind}" on a card the label says has no fix. A button on a card ` +
            'nobody can act on is worse than no button',
        );
      }
    } else if (offered.length === 0) {
      say(`offered no fix; the label says it should offer "${wantAction.kind}"`);
    } else if (!offered.some((a) => a.kind === wantAction.kind)) {
      say(`offered "${offered.map((a) => a.kind).join(', ')}", labelled "${wantAction.kind}"`);
    }
  }

  return assertions;
}

/**
 * The one line a green run prints. `planted` is how many labelled patterns the
 * corpus asked for; `written` is how many findings the runner actually left in
 * the ledger — so precision is measured against what a manager would have been
 * shown, not against an abstract denominator.
 */
export function summaryLine(
  score: ExamScore,
  counts: { planted: number; written: number },
): string {
  const pct = (found: number, total: number) => (total === 0 ? 100 : (found / total) * 100);
  const recallFound = counts.planted - score.recallFailures;
  const precisionRight = counts.written - score.precisionFailures;
  return (
    `[detector-exam] ${score.days} hotel-days, ${score.assertions} assertions, ` +
    `recall ${pct(recallFound, counts.planted).toFixed(0)}% ` +
    `(${recallFound}/${counts.planted} planted patterns found), ` +
    `precision ${pct(precisionRight, counts.written).toFixed(0)}% ` +
    `(${score.precisionFailures} invented findings in ${counts.written} cards)`
  );
}
