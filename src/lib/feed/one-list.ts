// ═══════════════════════════════════════════════════════════════════════════
// The one list — what order everything that needs a person goes in.
//
// The Staxis tab shows AI findings, to-dos somebody was handed, due reminders,
// complaints, work orders, rooms waiting on an inspection, preventive work, and
// decisions waiting on a manager. NOT in lanes, NOT under tags, NOT behind
// filters: one list, and the thing at the top is the thing to do next.
//
// ─── the house rule ────────────────────────────────────────────────────────
//   dollars first, then severity, with OVERDUE climbing.
//
// Read literally, in that order:
//
//   1. Anything carrying real money outranks anything that does not, biggest
//      first. This is the existing findings rule and it is unchanged — a
//      manager who has learned that the top card is the expensive one must not
//      have that quietly stop being true because to-dos arrived on the screen.
//
//   2. Everything with no money attached is ordered by how bad it is, and being
//      OVERDUE lifts a row one whole step up that ladder. A normal to-do that
//      has gone past its date sits with the high-priority work; an already-high
//      one that goes overdue sits with the urgent. That is what "climbing"
//      means here: not a separate overdue lane at the top (that IS a lane, and
//      there are no lanes), but a real promotion within the one ordering.
//
//   3. Ties go to whoever has been waiting longest. Same reason the findings
//      queue does it: the day something turned up is a fact about the hotel,
//      and a card that has been sitting there for three days should not sink
//      under one that arrived this morning wearing a louder label.
//
// ─── why this merges pre-sorted lists instead of sorting one big array ─────
// `rankFindings` is a load-bearing, separately-tested ordering with its own
// history (arrival order deliberately replaced a severity tiebreak). Sorting
// findings and work items together through one new comparator would silently
// re-derive it, and a difference would show up as cards moving on a manager's
// screen with no commit that says so. So each kind keeps its own ranking, and
// this module only decides the INTERLEAVING. Finding-vs-finding order is
// therefore identical to before by construction, not by care.
//
// Pure: no React, no fetch, no clock of its own. Every input is passed in.
// ═══════════════════════════════════════════════════════════════════════════

import { rankFindings, sortValueCents, type QueueFinding } from '@/components/concourse/finding-cards';
import type { LogEntryDTO } from '@/lib/comms/types';
import type { KnowledgeEventDTO } from '@/lib/knowledge/types';
import type { WorklistItem } from '@/lib/worklist/types';

/** One row of the list. The kinds render differently; they rank together. */
export type ListRow =
  | { kind: 'finding'; key: string; finding: QueueFinding }
  | { kind: 'item'; key: string; item: WorklistItem }
  | { kind: 'event'; key: string; event: KnowledgeEventDTO }
  | { kind: 'log'; key: string; entry: LogEntryDTO };

/** 3 = drop-everything, 0 = whenever. */
export type SeverityRank = 0 | 1 | 2 | 3;

const FINDING_SEVERITY: Record<string, SeverityRank> = {
  critical: 3,
  attention: 2,
  info: 1,
};

const ITEM_SEVERITY: Record<string, SeverityRank> = {
  urgent: 3,
  high: 2,
  normal: 1,
  low: 0,
};

/**
 * Everything the ordering needs to know about a row, and nothing else. Deriving
 * this first is what lets one comparator rank a $400 finding against a to-do
 * that went overdue on Tuesday without either type leaking into the rule.
 */
export interface RowStanding {
  /** Real stored money in cents, or null. NEVER estimated — see WorklistItem.amountCents. */
  pricedCents: number | null;
  severity: SeverityRank;
  overdue: boolean;
  /** When this started waiting, in ms. Oldest first. Unknown sorts last in its tie group. */
  waitingSinceMs: number;
  /** A shift note is not work. It sits under everything that is. */
  informational: boolean;
}

function parseMs(iso: string | null | undefined): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

export function standingOf(row: ListRow): RowStanding {
  if (row.kind === 'finding') {
    return {
      pricedCents: sortValueCents(row.finding),
      severity: FINDING_SEVERITY[row.finding.severity] ?? 1,
      // A finding has no due date to be past. Its urgency is its severity and
      // its price; inventing an overdue flag for it would promote every old
      // card forever.
      overdue: false,
      waitingSinceMs: parseMs(row.finding.firstSeenAt),
      informational: false,
    };
  }
  if (row.kind === 'item') {
    return {
      pricedCents: row.item.amountCents,
      severity: ITEM_SEVERITY[row.item.priority ?? 'normal'] ?? 1,
      overdue: row.item.overdue,
      // What it is waiting ON: its due date if it has one, otherwise the day it
      // was created. A dated thing waits from its date.
      waitingSinceMs: parseMs(row.item.dueDate ?? row.item.createdAt),
      informational: false,
    };
  }
  if (row.kind === 'event') {
    // A vendor visit is on the clock, not on the ladder: it carries no money,
    // no priority and no due date to be late for. It sits with the ordinary
    // to-dos and sorts by when it starts, so the 2pm visit lands after the
    // thing due this morning.
    return {
      pricedCents: null,
      severity: 1,
      overdue: false,
      waitingSinceMs: parseMs(`${row.event.eventDate}T12:00:00`),
      informational: false,
    };
  }
  return {
    pricedCents: null,
    severity: 0,
    overdue: false,
    waitingSinceMs: parseMs(row.entry.createdAt),
    informational: true,
  };
}

/**
 * The one step of the house rule that is not obvious from reading the sort:
 * overdue lifts a row one severity step, capped at the top. Exported because
 * "does overdue actually climb" is the question the ordering exists to answer.
 */
export function effectiveSeverity(standing: RowStanding): SeverityRank {
  if (!standing.overdue) return standing.severity;
  return Math.min(3, standing.severity + 1) as SeverityRank;
}

/**
 * Dollars first, then severity, with overdue climbing. Returns <0 when `a`
 * belongs above `b`. Ties return 0 and the merge below breaks them by keeping
 * each kind's own order, which is what makes the result stable across two
 * identical loads.
 */
export function compareStanding(a: RowStanding, b: RowStanding): number {
  // A shift note is a thing that happened, not a thing to do.
  if (a.informational !== b.informational) return a.informational ? 1 : -1;

  // 1. Money.
  if (a.pricedCents !== null && b.pricedCents === null) return -1;
  if (a.pricedCents === null && b.pricedCents !== null) return 1;
  if (a.pricedCents !== null && b.pricedCents !== null && a.pricedCents !== b.pricedCents) {
    return b.pricedCents - a.pricedCents;
  }

  // 2. Severity, with overdue promoted one step.
  const as = effectiveSeverity(a);
  const bs = effectiveSeverity(b);
  if (as !== bs) return bs - as;

  // 3. Genuinely overdue beats merely-as-severe.
  if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;

  // 4. Longest wait first. Subtraction would give NaN for two unknowns.
  if (a.waitingSinceMs !== b.waitingSinceMs) return a.waitingSinceMs < b.waitingSinceMs ? -1 : 1;

  return 0;
}

/** Work items on their own, in house order. Exported for the drawer-free tests. */
export function rankWorkItems(items: readonly WorklistItem[]): WorklistItem[] {
  return [...items].sort((a, b) => {
    const c = compareStanding(
      standingOf({ kind: 'item', key: a.id, item: a }),
      standingOf({ kind: 'item', key: b.id, item: b }),
    );
    // Stable on a true tie, so the list does not reshuffle between two
    // identical loads. Position has to mean something for ranking to be worth
    // anything at all.
    return c !== 0 ? c : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
}

export interface OneListInput {
  findings: readonly QueueFinding[];
  items: readonly WorklistItem[];
  /** Empty unless this person switched "Include log book in Staxis" on. */
  logEntries?: readonly LogEntryDTO[];
  /**
   * The hotel's own dated things on the day being shown. Absent on every
   * caller that is not the day timeline, so their rows are byte-for-byte what
   * they were.
   */
  events?: readonly KnowledgeEventDTO[];
  /**
   * How many FINDINGS render full-size before the rest fold behind "show all".
   * The cap is a findings cap and stays one: it exists to stop the AI filling a
   * screen, and a person's own to-dos are not the AI's noise. Work items are
   * never folded.
   */
  findingCap: number;
}

export interface OneList {
  /** In order. Render top to bottom. */
  rows: ListRow[];
  /** Findings past the cap, in their own order, for the existing fold. */
  foldedFindings: QueueFinding[];
}

/**
 * Merge findings, work items and (optionally) log entries into one ordered
 * list.
 *
 * Implemented as a k-way merge over already-ranked inputs rather than one sort,
 * so each kind's internal order is preserved exactly. On a tie the finding goes
 * first: it is the one with a number attached to it more often than not, and
 * the queue's whole promise is that the expensive thing is at the top.
 */
export function buildOneList(input: OneListInput): OneList {
  const rankedFindings = rankFindings([...input.findings]);
  const cap = Math.max(0, Math.floor(input.findingCap));
  const prominent = rankedFindings.slice(0, cap);
  const foldedFindings = rankedFindings.slice(cap);

  const findingRows: ListRow[] = prominent.map((f) => ({ kind: 'finding', key: `finding:${f.id}`, finding: f }));
  const itemRows: ListRow[] = rankWorkItems(input.items).map((i) => ({ kind: 'item', key: `item:${i.id}`, item: i }));
  const logRows: ListRow[] = [...(input.logEntries ?? [])]
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    .map((e) => ({ kind: 'log', key: `log:${e.id}`, entry: e }));
  const eventRows: ListRow[] = [...(input.events ?? [])]
    .sort((a, b) => (a.eventDate < b.eventDate ? -1 : a.eventDate > b.eventDate ? 1 : (a.id < b.id ? -1 : 1)))
    .map((e) => ({ kind: 'event', key: `event:${e.id}`, event: e }));

  const lanes = [findingRows, itemRows, eventRows, logRows];
  const cursors = [0, 0, 0, 0];
  const rows: ListRow[] = [];
  const total = findingRows.length + itemRows.length + eventRows.length + logRows.length;

  for (let n = 0; n < total; n++) {
    let bestLane = -1;
    let bestStanding: RowStanding | null = null;
    for (let lane = 0; lane < lanes.length; lane++) {
      const row = lanes[lane][cursors[lane]];
      if (!row) continue;
      const standing = standingOf(row);
      if (bestStanding === null || compareStanding(standing, bestStanding) < 0) {
        bestLane = lane;
        bestStanding = standing;
      }
    }
    if (bestLane < 0) break;
    rows.push(lanes[bestLane][cursors[bestLane]]);
    cursors[bestLane] += 1;
  }

  return { rows, foldedFindings };
}

// ═══════════════════════════════════════════════════════════════════════════
// The timeline split — "right now at the top, the day unwinds underneath"
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The one list, cut in two for the spine.
 *
 * The 2026-08-01 design put the CLOCK back on this screen: the top of the page
 * is what is still owed today, and everything that has already happened unwinds
 * downwards under an "Earlier today" rule, ending with the morning brief.
 *
 * ─── why this is a second pass and not a change to buildOneList ────────────
 * `buildOneList`'s ordering is load-bearing and separately tested (dollars
 * first, then severity, with overdue climbing). Re-deriving it with a clock
 * term folded in would move cards on a manager's screen for reasons no commit
 * explains. So the ranking is untouched: this only PARTITIONS the ranked rows,
 * and each side keeps the exact relative order it already had.
 *
 * The cut itself is a fact about the row kind rather than a timestamp
 * comparison, which is what makes it honest:
 *
 *   owed  — work items and hotel events. Open work is by definition still
 *           owed; /api/worklist does not return settled rows.
 *   past  — findings and log entries. A finding is Staxis reporting something
 *           it noticed at a moment that has already gone by, and a shift note
 *           is a record of something that happened.
 *
 * A day with nothing on either side still renders correctly: the divider is
 * only drawn when BOTH sides have rows, so an all-findings morning does not
 * grow an "Earlier today" heading with nothing above it.
 */
export interface TimelineSplit {
  /** Still owed. Renders first, at the top of the spine. */
  owed: ListRow[];
  /** Already happened. Renders under the divider. */
  past: ListRow[];
  /** True only when both sides have rows, i.e. the divider earns its space. */
  showDivider: boolean;
}

export function partitionTimeline(rows: readonly ListRow[]): TimelineSplit {
  const owed: ListRow[] = [];
  const past: ListRow[] = [];
  for (const row of rows) {
    if (row.kind === 'item' || row.kind === 'event') owed.push(row);
    else past.push(row);
  }
  return { owed, past, showDivider: owed.length > 0 && past.length > 0 };
}
