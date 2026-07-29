/**
 * The maintenance lens — which of Staxis's checks are about the BUILDING, and
 * what happened to each one over time.
 *
 * This exists for one screen: the "patterns Staxis has spotted" popup on the
 * Maintenance tab. A manager standing in front of the work-order board wants
 * the repeat problems in THEIR domain, not the queue's whole-hotel mix of
 * linen counts and slow cleans.
 *
 * ─── WHY A HAND-KEPT LIST AND NOT A FIELD ON THE DETECTOR ──────────────────
 * A detector has no domain. `DetectorDeclaration` (../types.ts) carries id,
 * inputs, severity, escalation — nothing that says "this one is maintenance".
 * Adding such a field would mean every detector author picking a taxonomy that
 * exists for a single popup, and the registry validator growing a clause to
 * police it.
 *
 * So the classification lives here, as data, next to a test that walks
 * `allDetectors()` and fails if ANY registered detector is missing from these
 * three sets. That is the important half: a new detector cannot be quietly
 * omitted from this screen, because the suite goes red until somebody decides
 * which side it is on. An allowlist nobody is forced to update is how a screen
 * silently stops showing half the truth.
 *
 * ─── WHY TWO DETECTORS ARE CONDITIONAL ─────────────────────────────────────
 * `operational_pattern` and `expected_activity_stopped` each cover several
 * subjects with one detector. Including them wholesale would put "nobody has
 * counted inventory in 11 days" on the maintenance popup; excluding them
 * wholesale would drop "the same room keeps generating complaints", which is
 * exactly what a maintenance manager opened this for. Both write the subject
 * into their own evidence, so the row itself can be asked.
 *
 * ─── MONEY ─────────────────────────────────────────────────────────────────
 * Nothing here computes, sums, or estimates a dollar figure. The standing
 * cards carry their own stored ranges through the ordinary card projection;
 * the history lines below carry no money at all. A number on this screen that
 * did not come out of the row it describes would be a number Staxis made up.
 */

import type { Finding, FindingStatus } from './types';

// ─── Classification ─────────────────────────────────────────────────────────

/** Checks that are ALWAYS about the building. */
export const MAINTENANCE_DETECTORS: readonly string[] = Object.freeze([
  'preventive_due',
  'repeat_equipment_work_orders',
  'repeat_room_work_orders',
  'work_order_rate_baseline',
]);

/**
 * Checks that are about the building only for SOME of their rows, and the
 * question to ask each row.
 *
 * The predicates read the same evidence keys the detectors write:
 *   operational_pattern       evidence.values.category   (operational-patterns.ts)
 *   expected_activity_stopped evidence.params.stream     (expected-activity.ts)
 *
 * A row whose evidence is missing or shaped unexpectedly answers NO. A popup
 * that showed an inventory-counting gap under a maintenance heading would be
 * mislabelling the hotel's own data, which is worse than showing one fewer
 * card.
 */
export const CONDITIONAL_MAINTENANCE_DETECTORS: Readonly<
  Record<string, (f: Finding) => boolean>
> = Object.freeze({
  operational_pattern: (f) => f.evidence?.values?.category === 'maintenance',
  expected_activity_stopped: (f) => f.evidence?.params?.stream === 'work_order_flow',
});

/**
 * Checks deliberately NOT on this screen, listed so the completeness test can
 * tell "decided against" apart from "nobody looked at it".
 */
export const NON_MAINTENANCE_DETECTORS: readonly string[] = Object.freeze([
  'cleaning_plan_health',
  'inventory_usage_baseline',
  'room_needs_attention',
  'supply_spend_baseline',
]);

/**
 * The detector ids worth reading from the database for this screen — the
 * always-maintenance ones plus the conditional ones, whose rows are then
 * sifted individually by `isMaintenanceFinding`.
 */
export const MAINTENANCE_LENS_DETECTOR_IDS: readonly string[] = Object.freeze([
  ...MAINTENANCE_DETECTORS,
  ...Object.keys(CONDITIONAL_MAINTENANCE_DETECTORS),
].sort());

/** Is this particular finding about the building? */
export function isMaintenanceFinding(f: Finding): boolean {
  if (MAINTENANCE_DETECTORS.includes(f.detectorId)) return true;
  const ask = CONDITIONAL_MAINTENANCE_DETECTORS[f.detectorId];
  return ask ? ask(f) : false;
}

// ─── The paper trail ────────────────────────────────────────────────────────

/**
 * What became of one sighting.
 *
 * `seen` is NOT `handled`, here as everywhere else in this engine: a manager
 * telling the feed to be quiet about something is not the same as the thing
 * being fixed, and the store never writes `resolved_at` for it. Rendering the
 * two the same way would let this screen tell an owner a problem was dealt
 * with on the strength of somebody dismissing a card.
 */
export type PatternOutcome =
  /** resolved — the manager said they dealt with it. */
  | 'handled'
  /** known_problem — acknowledged, silenced, NOT claimed fixed. */
  | 'seen'
  /** muted — the manager said don't show me this. */
  | 'declined'
  /** expired — the detector stopped finding it and the grace window lapsed. */
  | 'cleared'
  /** open / updated — still on the board right now. */
  | 'standing';

const OUTCOME_BY_STATUS: Readonly<Record<FindingStatus, PatternOutcome>> = Object.freeze({
  open: 'standing',
  updated: 'standing',
  resolved: 'handled',
  known_problem: 'seen',
  muted: 'declined',
  expired: 'cleared',
});

export interface PatternEpisode {
  /** When this sighting was first caught. */
  caughtAt: string;
  outcome: PatternOutcome;
  /** When it reached that outcome; null while it is still standing. */
  outcomeAt: string | null;
}

export interface PatternHistory {
  /** The engine's own identity for this problem — stable across recurrences. */
  dedupeKey: string;
  detectorId: string;
  titleEn: string;
  titleEs: string;
  /** Oldest sighting first. */
  episodes: readonly PatternEpisode[];
  /** True when a closed sighting was followed by a fresh one. */
  cameBack: boolean;
  /** True when the newest sighting is still open. */
  standingNow: boolean;
  /** Newest timestamp anywhere in the trail — the sort key. */
  lastActivityAt: string;
}

/** How the caller says what a finding is about, in both languages. */
export type PatternPhrasing = (f: Finding) => { en: string; es: string };

/**
 * What a HISTORY line is called, in Spanish.
 *
 * WHY THIS IS NOT JUST `cardPhrasing(card, 'es')`
 * A card's Spanish fallback is `spanishTemplateSentence`, which for a row the
 * judge never phrased says, in effect, "Staxis has something open here — tap
 * See the numbers for the detail". On a CARD that is correct: the button is
 * right underneath it. In this list there is no such button, and — worse —
 * every unphrased pattern gets the SAME sentence, so a Spanish-reading manager
 * sees four identical titles over four different trails and cannot tell the
 * problems apart. English never shows this because its fallback is the
 * detector's own `summary`, which names the room or the machine.
 *
 * So Spanish takes the row's own basis line before it settles for the
 * template: "4 órdenes de trabajo en la habitación 204 en los últimos 30 días"
 * is specific, is Spanish, and comes out of the very row it describes. The
 * template stays as the last resort, which keeps the older promise that
 * Spanish never silently falls back to English prose.
 */
export function spanishHistoryTitle(
  judgedEs: string | null | undefined,
  basisEs: string | null | undefined,
  templateEs: string,
): string {
  const judged = (judgedEs ?? '').trim();
  if (judged.length > 0) return judged;
  const basis = (basisEs ?? '').trim();
  if (basis.length > 0) return basis;
  return templateEs;
}

/**
 * Group a hotel's maintenance findings into one trail per problem.
 *
 * WHY `propertyId` IS AN ARGUMENT AND NOT AN ASSUMPTION
 * Grouping is by `dedupe_key`, which is only unique WITHIN a hotel — two
 * hotels with the same repeat problem carry the same key by design. If rows
 * from two hotels ever reached this function it would merge their histories
 * into one line and show hotel A a trail containing hotel B's dates. The read
 * upstream is already hotel-scoped; this is the second lock on the same door,
 * and the cross-tenant probe in the test file plants a foreign row to prove it
 * holds.
 */
export function buildPatternHistory(
  propertyId: string,
  findings: readonly Finding[],
  phrase: PatternPhrasing,
): PatternHistory[] {
  const groups = new Map<string, Finding[]>();
  for (const f of findings) {
    if (f.propertyId !== propertyId) continue;
    if (!isMaintenanceFinding(f)) continue;
    const bucket = groups.get(f.dedupeKey);
    if (bucket) bucket.push(f);
    else groups.set(f.dedupeKey, [f]);
  }

  const out: PatternHistory[] = [];
  for (const [dedupeKey, rows] of groups) {
    const ordered = [...rows].sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt));
    const episodes: PatternEpisode[] = ordered.map((f) => {
      const outcome = OUTCOME_BY_STATUS[f.status] ?? 'standing';
      return {
        caughtAt: f.firstSeenAt,
        outcome,
        // `resolved_at` is written for 'resolved' and nothing else, so the
        // status clock is the fallback for every other closed state.
        outcomeAt:
          outcome === 'standing' ? null : (f.resolvedAt ?? f.statusChangedAt),
      };
    });

    // A recurrence is a fresh row after a CLOSED one. Computed from the
    // outcomes rather than from `episodes.length > 1` so the claim stays true
    // if the ledger's one-active-row-per-problem rule ever changes.
    const cameBack = episodes.some(
      (ep, i) => i > 0 && CLOSED_OUTCOMES.has(episodes[i - 1].outcome),
    );

    const newest = ordered[ordered.length - 1];
    const stamps = ordered.flatMap((f) => [f.firstSeenAt, f.lastSeenAt, f.statusChangedAt]);
    out.push({
      dedupeKey,
      detectorId: newest.detectorId,
      titleEn: phrase(newest).en,
      titleEs: phrase(newest).es,
      episodes,
      cameBack,
      standingNow: episodes[episodes.length - 1].outcome === 'standing',
      lastActivityAt: stamps.sort().pop()!,
    });
  }

  // Most recent activity first — a manager scanning this wants what moved.
  return out.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
}

const CLOSED_OUTCOMES: ReadonlySet<PatternOutcome> = new Set<PatternOutcome>([
  'handled',
  'seen',
  'declined',
  'cleared',
]);

// ─── Saying it in plain language ────────────────────────────────────────────

export type LensLang = 'en' | 'es';

/**
 * One line of history, e.g.
 *   "Caught Jul 12. Marked handled Jul 14. Came back Jul 26. Still open."
 *   "Detectado 12 jul. Marcado como resuelto 14 jul. Volvió 26 jul. Sigue abierto."
 *
 * SHORT SENTENCES, FULL STOPS, NO EM DASHES. A founder ruling that binds every
 * user-facing string in this feature: an em dash (or an arrow, which this line
 * used first) makes a manager parse punctuation before they can read dates.
 * Each beat is its own plain sentence so the eye can drop down the list. The
 * standing test for this is in maintenance-patterns.test.ts, and it asks the
 * string PRODUCERS rather than grepping the source, so a beat added later is
 * checked automatically.
 *
 * `timeZone` is passed by the caller so the dates read as the hotel's days
 * rather than the server's. Tests pin it to UTC. Neither locale's short month
 * carries a trailing period ("Jul 12", "12 jul"), so joining on ". " cannot
 * produce a double stop.
 */
export function historyLine(
  pattern: PatternHistory,
  lang: LensLang,
  opts: { timeZone?: string } = {},
): string {
  const at = (iso: string | null) => (iso ? formatDay(iso, lang, opts.timeZone) : '');
  const beats: string[] = [];

  pattern.episodes.forEach((ep, i) => {
    beats.push(
      i === 0
        ? (lang === 'es' ? `Detectado ${at(ep.caughtAt)}` : `Caught ${at(ep.caughtAt)}`)
        : (lang === 'es' ? `Volvió ${at(ep.caughtAt)}` : `Came back ${at(ep.caughtAt)}`),
    );
    beats.push(outcomeBeat(ep, lang, opts.timeZone));
  });

  return `${beats.join('. ')}.`;
}

function outcomeBeat(ep: PatternEpisode, lang: LensLang, timeZone?: string): string {
  const on = ep.outcomeAt ? formatDay(ep.outcomeAt, lang, timeZone) : '';
  if (lang === 'es') {
    switch (ep.outcome) {
      case 'handled':  return `Marcado como resuelto ${on}`;
      case 'seen':     return `Marcado como problema conocido ${on}`;
      case 'declined': return `Oculto ${on}`;
      case 'cleared':  return `Se resolvió solo ${on}`;
      case 'standing': return 'Sigue abierto';
    }
  }
  switch (ep.outcome) {
    case 'handled':  return `Marked handled ${on}`;
    // Never "handled": a manager silencing a card has not fixed anything.
    case 'seen':     return `Marked a known problem ${on}`;
    case 'declined': return `Hidden ${on}`;
    case 'cleared':  return `Cleared on its own ${on}`;
    case 'standing': return 'Still open';
  }
}

/** "Jul 12" / "12 jul". Invalid input renders nothing rather than "Invalid Date". */
function formatDay(iso: string, lang: LensLang, timeZone?: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return new Intl.DateTimeFormat(lang === 'es' ? 'es-US' : 'en-US', {
    month: 'short',
    day: 'numeric',
    ...(timeZone ? { timeZone } : {}),
  }).format(at);
}

/**
 * "Caught 3 times" — shown only when there is more than one sighting, because
 * "caught 1 time" beside a line that already says when is noise.
 */
export function timesCaughtLabel(pattern: PatternHistory, lang: LensLang): string | null {
  const n = pattern.episodes.length;
  if (n < 2) return null;
  return lang === 'es' ? `Detectado ${n} veces` : `Caught ${n} times`;
}
