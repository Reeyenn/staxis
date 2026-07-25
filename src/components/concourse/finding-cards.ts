// ═══════════════════════════════════════════════════════════════════════════
// The rules a findings card obeys, with no React and no network in the way.
//
// Ordering, the daily cap, the price range, the "we checked" line and the
// choice between judged phrasing and the detector's own sentence are all
// DECISIONS, and decisions are what a manager notices when they are wrong: a
// $40 card above a $4,000 one, a price that reads like a promise, or a line
// that says "everything looked normal" on a night nothing ran.
//
// So they live here, as pure functions over plain data, and the component
// below them only renders what these return. That is also what makes them
// testable — the suite calls these directly rather than asserting against JSX.
//
// WHAT THIS FILE MAY NOT DO
//   • Invent a number. Every figure rendered comes from the stored finding.
//   • Turn a range into a point estimate. `$200–400` never becomes `$300`;
//     the midpoint exists ONLY as a sort key and is never shown.
//   • Claim freshness. If the last run is old, the line says how old. If there
//     has never been a run, there is no line at all.
// ═══════════════════════════════════════════════════════════════════════════

import type {
  FindingDisposition,
  FindingSeverity,
  FindingStatus,
} from '@/lib/findings/types';

export type Lang = 'en' | 'es';

// ─── The wire shape ─────────────────────────────────────────────────────────

export interface CardPrice {
  lowCents: number;
  highCents: number;
  currency: string;
  /** "based on your last 3 plumber invoices" — never blank in practice. */
  basis: string;
}

export interface CardEvidence {
  queryId: string;
  params: Record<string, unknown>;
  values: Record<string, unknown>;
  /** "4 hvac work orders in the last 30 days". */
  basis: string;
}

/**
 * One finding, as /api/findings hands it to the screen.
 *
 * `phrasedEn` / `phrasedEs` are the AI judge's wording (a sibling workstream's
 * migration). They are OPTIONAL on purpose: on a deploy where the judge has
 * not landed they are simply absent and every card falls back to `summary`,
 * the detector's own deterministic sentence. A card must never be blank
 * because a later phase has not shipped.
 */
export interface QueueFinding {
  id: string;
  detectorId: string;
  dedupeKey: string;
  summary: string;
  phrasedEn?: string | null;
  phrasedEs?: string | null;
  severity: FindingSeverity;
  disposition: FindingDisposition;
  status: FindingStatus;
  magnitude: number;
  price: CardPrice | null;
  evidence: CardEvidence;
  asOf: string | null;
  weakestInputAgeDays: number | null;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrenceCount: number;
}

/** The liveness artifact: proof the watcher ran, and what it saw. */
export interface QueueRun {
  runAt: string;
  detectorsChecked: number;
  detectorsSkipped: number;
  detectorsFailed: number;
}

// ─── The daily cap ──────────────────────────────────────────────────────────

/**
 * How many cards get the manager's full attention on one screen. Everything
 * past this is still THERE — one tap behind "show all" — but a screen with
 * nineteen equally-loud cards is a screen nobody reads, and a system whose
 * output nobody reads is worse than no system.
 *
 * Five is a shift-handover's worth. It is a UI constant, not a detection one:
 * the runner's own per-detector cap (DetectorDeclaration.maxPerRun) governs
 * what gets WRITTEN, and is a separate, larger number on purpose.
 */
export const DAILY_CARD_CAP = 5;

// ─── Which findings become cards at all ─────────────────────────────────────

/**
 * `ask` findings are QUESTIONS, and Staxis already has exactly one place it
 * asks a manager a question: the drip-question card. Rendering them here would
 * be a second question UI with different rules (that one asks at most once per
 * session and never nags; a card sits until dealt with). `drop` is the judge
 * saying "not worth surfacing" — kept in the ledger so the decision is
 * auditable, never shown.
 *
 * Wiring `ask` findings INTO the drip-question pipeline is Phase 3's job.
 */
export function isCardRenderable(f: Pick<QueueFinding, 'disposition'>): boolean {
  return f.disposition !== 'ask' && f.disposition !== 'drop';
}

/** True when the card should render without action buttons beyond "got it". */
export function isQuiet(f: Pick<QueueFinding, 'disposition'>): boolean {
  return f.disposition === 'fyi';
}

/** True when "Fixed" is a thing a manager could plausibly have done. */
export function offersResolve(f: Pick<QueueFinding, 'disposition'>): boolean {
  return f.disposition === 'propose' || f.disposition === 'recommend';
}

// ─── Ordering ───────────────────────────────────────────────────────────────

const SEVERITY_RANK: Record<FindingSeverity, number> = {
  critical: 0,
  attention: 1,
  info: 2,
};

/**
 * The sort key for a priced finding: the middle of its range, in cents.
 *
 * NEVER RENDERED. A manager who saw "$300" where the system knows "$200–400"
 * would be reading a confidence we do not have, and the day they catch one
 * invented number is the day they stop believing the honest ones.
 */
export function sortValueCents(f: Pick<QueueFinding, 'price'>): number | null {
  if (!f.price) return null;
  return (f.price.lowCents + f.price.highCents) / 2;
}

/**
 * Biggest dollars first. Then, because plenty of real findings have no price
 * the hotel's own numbers can support:
 *
 *   1. anything with a price outranks anything without one
 *   2. among priced findings, the larger range midpoint first
 *   3. severity breaks ties (critical before attention before info)
 *   4. then magnitude, then dedupe key — so the order is STABLE. A list that
 *      reshuffles between two identical loads teaches a manager that position
 *      means nothing, which defeats the whole point of ranking.
 */
export function rankFindings<T extends QueueFinding>(findings: readonly T[]): T[] {
  return [...findings].sort((a, b) => {
    const av = sortValueCents(a);
    const bv = sortValueCents(b);
    if (av !== null && bv === null) return -1;
    if (av === null && bv !== null) return 1;
    if (av !== null && bv !== null && av !== bv) return bv - av;

    const sev = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (sev !== 0) return sev;

    if (a.magnitude !== b.magnitude) return b.magnitude - a.magnitude;
    return a.dedupeKey < b.dedupeKey ? -1 : a.dedupeKey > b.dedupeKey ? 1 : 0;
  });
}

export interface CardSplit<T> {
  /** Rendered full-size, in order. */
  prominent: T[];
  /** Behind "show all (N)". Same order, just quieter. */
  folded: T[];
}

/** Apply the attention cap. Never drops anything — the rest is one tap away. */
export function splitByCap<T>(ranked: readonly T[], cap: number = DAILY_CARD_CAP): CardSplit<T> {
  const limit = Math.max(0, Math.floor(cap));
  return { prominent: ranked.slice(0, limit), folded: ranked.slice(limit) };
}

// ─── Money ──────────────────────────────────────────────────────────────────

/** Whole dollars when the cents are zero; two decimals when they are not. */
function dollars(cents: number): string {
  const value = cents / 100;
  return Number.isInteger(value)
    ? value.toLocaleString('en-US')
    : value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const CURRENCY_PREFIX: Record<string, string> = { USD: '$', CAD: 'CA$', MXN: 'MX$', EUR: '€' };

/**
 * "$200–400". An en dash, not a hyphen, because "$200-400" reads as a phone
 * number at a glance. Returns null when there is no usable range, and the
 * caller then says nothing about money at all — an honest blank beats a guess.
 */
export function formatPriceRange(price: CardPrice | null | undefined): string | null {
  if (!price) return null;
  const { lowCents, highCents } = price;
  if (!Number.isFinite(lowCents) || !Number.isFinite(highCents)) return null;
  if (highCents <= lowCents || lowCents < 0) return null;
  const prefix = CURRENCY_PREFIX[price.currency] ?? `${price.currency} `;
  return `${prefix}${dollars(lowCents)}–${prefix}${dollars(highCents)}`;
}

// ─── Phrasing ───────────────────────────────────────────────────────────────

/**
 * What the card actually says. The judge's wording when it exists in the
 * manager's language, otherwise the detector's own template sentence.
 *
 * The fallback is not a degraded mode — `summary` is generated by code from
 * the hotel's real numbers and is correct with no model in the loop. The judge
 * makes it read better; it is never the difference between a card and no card.
 */
export function cardPhrasing(f: QueueFinding, lang: Lang): string {
  const judged = lang === 'es' ? f.phrasedEs : f.phrasedEn;
  const text = (judged ?? '').trim();
  return text.length > 0 ? text : f.summary;
}

// ─── Copy ───────────────────────────────────────────────────────────────────

type Bi = { en: string; es: string };
const pick = (b: Bi, lang: Lang) => (lang === 'es' ? b.es : b.en);

const SEVERITY_LABEL: Record<FindingSeverity, Bi> = {
  critical: { en: 'NEEDS A DECISION', es: 'REQUIERE UNA DECISIÓN' },
  attention: { en: 'WORTH A LOOK', es: 'VALE LA PENA REVISARLO' },
  info: { en: 'FOR YOUR INFORMATION', es: 'PARA TU INFORMACIÓN' },
};

export function severityLabel(severity: FindingSeverity, lang: Lang): string {
  return pick(SEVERITY_LABEL[severity], lang);
}

/** Chip colour class from concourse-css. Rust reads as "act", sage as "calm". */
export function severityChipClass(severity: FindingSeverity): string {
  if (severity === 'critical') return 'cx-rust';
  if (severity === 'attention') return 'cx-caramel';
  return 'cx-sage';
}

/**
 * "Seen 6 times since Jul 12" — the honest version of "this keeps happening".
 * Null on a first sighting, because "seen 1 time" is noise.
 */
export function occurrenceLine(f: QueueFinding, lang: Lang, now: Date = new Date()): string | null {
  if (f.occurrenceCount <= 1) return null;
  const since = formatShortDate(f.firstSeenAt, lang, now);
  if (!since) {
    return lang === 'es'
      ? `Visto ${f.occurrenceCount} veces`
      : `Seen ${f.occurrenceCount} times`;
  }
  return lang === 'es'
    ? `Visto ${f.occurrenceCount} veces desde el ${since}`
    : `Seen ${f.occurrenceCount} times since ${since}`;
}

/** "Jul 12", or null when the timestamp is unusable. */
export function formatShortDate(iso: string | null, lang: Lang, _now: Date = new Date()): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(lang === 'es' ? 'es-US' : 'en-US', { month: 'short', day: 'numeric' });
}

/**
 * The weakest-input warning. A conclusion drawn from a nine-day-old count is a
 * question wearing an instruction's clothes, and the card should say so rather
 * than let the manager assume today's numbers.
 */
export const STALE_INPUT_DAYS = 3;

export function dataAgeNote(f: QueueFinding, lang: Lang): string | null {
  const age = f.weakestInputAgeDays;
  if (age === null || age === undefined || !Number.isFinite(age)) return null;
  if (age < STALE_INPUT_DAYS) return null;
  const days = Math.round(age);
  return lang === 'es'
    ? `Basado en datos de hace ${days} días.`
    : `Based on data that is ${days} days old.`;
}

// ─── The liveness line ──────────────────────────────────────────────────────

/** How old a run may be before the screen stops implying it is current. */
export const RUN_FRESH_HOURS = 48;

export type LivenessKind = 'fresh' | 'stale' | 'never';

export interface Liveness {
  kind: LivenessKind;
  /** What to render. Null ONLY for 'never' — silence beats a fabricated claim. */
  text: string | null;
}

/**
 * "Checked 34 things last night — 33 looked normal."
 *
 * THIS SENTENCE IS THE WHOLE POINT OF finding_runs. A watcher that finds
 * nothing and a watcher that died both produce an empty screen; only this line
 * tells them apart. Three states, and each one is honest about a different
 * thing:
 *
 *   fresh  — we ran recently. Say what we checked and how much was fine.
 *   stale  — we ran, but days ago. Say how long ago, and DO NOT recite the
 *            counts as if they described today.
 *   never  — we have never run here. Say NOTHING about checking. An empty
 *            queue on a hotel that was never scanned must not read as "clean".
 *
 * `withFindings` is the number of DISTINCT checks that turned something up, so
 * "33 looked normal" is arithmetic over real values rather than a vibe. It is
 * clamped at zero: findings can outlive the run that found them (a detector
 * that skipped tonight leaves yesterday's card standing), and a negative count
 * would be a lie in the other direction.
 */
export function livenessLine(
  run: QueueRun | null | undefined,
  withFindings: number,
  lang: Lang,
  now: Date = new Date(),
): Liveness {
  if (!run || !run.runAt) return { kind: 'never', text: null };
  const ranAt = new Date(run.runAt);
  if (Number.isNaN(ranAt.getTime())) return { kind: 'never', text: null };

  const hours = (now.getTime() - ranAt.getTime()) / 3_600_000;
  if (hours > RUN_FRESH_HOURS) {
    const days = Math.max(1, Math.round(hours / 24));
    return {
      kind: 'stale',
      text:
        lang === 'es'
          ? days === 1
            ? 'Última revisión hace 1 día. Puede que esto no esté al día.'
            : `Última revisión hace ${days} días. Puede que esto no esté al día.`
          : days === 1
            ? 'Last checked 1 day ago — this may not be up to date.'
            : `Last checked ${days} days ago — this may not be up to date.`,
    };
  }

  const checked = Math.max(0, Math.round(run.detectorsChecked));
  const normal = Math.max(0, checked - Math.max(0, Math.round(withFindings)));
  return {
    kind: 'fresh',
    text:
      lang === 'es'
        ? `Se revisaron ${checked} cosas anoche — ${normal} se ven normales.`
        : `Checked ${checked} things last night — ${normal} look normal.`,
  };
}

/** Distinct checks behind a set of findings — the `withFindings` argument. */
export function distinctDetectors(findings: readonly QueueFinding[]): number {
  return new Set(findings.map((f) => f.detectorId)).size;
}

/**
 * "3 of the checks could not run for want of data." Silence for want of data
 * is not a clean bill of health, and finding_runs counts it separately for
 * exactly this sentence.
 *
 * Suppressed once the run goes stale. The sentence is present tense — it reads
 * as "right now, three checks are blocked" — and stapling it under "last
 * checked 4 days ago" would smuggle a four-day-old fact back in as a current
 * one, which is the exact move the staleness band exists to prevent.
 */
export function skippedNote(
  run: QueueRun | null | undefined,
  lang: Lang,
  now: Date = new Date(),
): string | null {
  if (!run || run.detectorsSkipped <= 0) return null;
  if (livenessLine(run, 0, lang, now).kind !== 'fresh') return null;
  const n = run.detectorsSkipped;
  return lang === 'es'
    ? `${n} ${n === 1 ? 'revisión no pudo hacerse' : 'revisiones no pudieron hacerse'} por falta de datos.`
    : `${n} ${n === 1 ? 'check' : 'checks'} couldn't run yet — not enough history.`;
}
