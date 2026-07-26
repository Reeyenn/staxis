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

// ─── The hands ──────────────────────────────────────────────────────────────

/** Mirrors finding_actions.state (migration 0363). */
export type CardActionState =
  | 'proposed'
  | 'superseded'
  | 'executed'
  | 'declined_changed'
  | 'undone'
  | 'failed';

/**
 * The fix attached to a card, as /api/findings hands it over.
 *
 * EVERY SENTENCE ARRIVES IN BOTH LANGUAGES, ALREADY DERIVED. The route renders
 * them from the FROZEN params through the catalog entry, so what the button
 * says and what the button does come from one source. The client is given no
 * way to compose its own description of the plan — that is how "what runs is
 * what was shown" survives contact with a UI.
 */
export interface CardAction {
  id: string;
  kind: string;
  state: CardActionState;
  /** "Create a work order for a full inspection of Room 214?" */
  offerEn: string;
  offerEs: string;
  /** The button. "Create the work order". */
  labelEn: string;
  labelEs: string;
  /** After it ran. Null until then. */
  receiptEn: string | null;
  receiptEs: string | null;
  /** What moved, when the action declined because the facts changed. */
  changed: {
    field: string;
    was: unknown;
    now: unknown;
    subject?: string | null;
  } | null;
  /** Set when the write itself failed. */
  failureReason: string | null;
}

/**
 * True when this card should show a one-tap approve.
 *
 * THREE CONDITIONS, AND THE DISPOSITION IS THE ONE THAT MATTERS.
 *
 * The disposition here is the EFFECTIVE one — the judge's verdict when it has
 * reached one, the detector's default otherwise. So this is also where the
 * judge's reach over the hands ends and is defined: it may re-sort a card down
 * to a recommendation or an FYI, and doing so takes the BUTTON away with it,
 * because a card that says it needs no decision must not carry one. What the
 * judge can never do in the other direction is make a button appear — the
 * action row only exists if the runner wrote one, the runner writes one only
 * for a proposal, and the judge's output contract has no field through which an
 * action could be named at all (judge.ts ITEM_KEYS).
 *
 * A superseded offer is history — a later run replaced it — and rendering its
 * button would run a plan that is no longer the one on the card.
 */
export function offersApproval(
  f: Pick<QueueFinding, 'disposition' | 'action'>,
): boolean {
  return f.disposition === 'propose' && f.action?.state === 'proposed';
}

/**
 * True when the action ran and can still be taken back.
 *
 * Deliberately NOT gated on the disposition. Once something has actually
 * happened at the hotel, the manager's ability to reverse it cannot depend on
 * how a later judging pass decided to sort the card it came from.
 */
export function offersUndo(f: Pick<QueueFinding, 'action'>): boolean {
  return f.action?.state === 'executed';
}

/**
 * Why Staxis declined, in the manager's language.
 *
 * The database writes an English `why` alongside the numbers (0363). That
 * sentence is the record; THIS is the rendering, and it is keyed on the
 * structured `field` rather than on the English text so a Spanish speaker gets
 * Spanish rather than a translation of a string that might change. An
 * unrecognised field falls back to a shape that is still true and still names
 * both numbers — an honest generic beats a blank.
 */
export function declinedExplanation(action: CardAction, lang: Lang): string {
  const es = lang === 'es';
  const subject = action.changed?.subject ?? '';
  const was = String(action.changed?.was ?? '');
  const now = String(action.changed?.now ?? '');

  switch (action.changed?.field) {
    case 'open_work_orders':
      return es
        ? `Staxis no lo hizo: ${subject} tenía ${was} órdenes de trabajo abiertas cuando lo propuso y ahora tiene ${now}. Alguien ya se está ocupando.`
        : `Staxis did not do it: ${subject} had ${was} open work orders when this was offered and now has ${now}. Somebody is already on it.`;
    case 'reorder_at':
      return es
        ? `Staxis no lo hizo: el punto de pedido de ${subject} era ${was} cuando lo propuso y ahora es ${now}. Alguien ya lo cambió.`
        : `Staxis did not do it: the reorder point for ${subject} was ${was} when this was offered and is now ${now}. Somebody has already changed it.`;
    case 'item':
      return es
        ? `Staxis no lo hizo: ${subject} ya no está en la lista de inventario de este hotel.`
        : `Staxis did not do it: ${subject} is no longer on this hotel's inventory list.`;
    default:
      return es
        ? `Staxis no lo hizo: los datos cambiaron desde que lo propuso (era ${was}, ahora ${now}).`
        : `Staxis did not do it: the facts changed since it was offered (was ${was}, now ${now}).`;
  }
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
  /**
   * The fix, when Staxis has one it may perform. Absent on every card that is
   * only a recommendation, which is most of them — and absent, deliberately, on
   * a deploy where the hands have not shipped, so a card renders exactly as it
   * did before rather than blank.
   */
  action?: CardAction | null;
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
 * WHICH VERDICT GOVERNS: the judge's, when it has one.
 *
 * The detector's `disposition` is a default chosen before anything looked at
 * this hotel's particular situation. The judge's is a decision made with the
 * finding's numbers, its data age and the hotel's own knowledge in front of it,
 * and `ask` / `drop` are verdicts ONLY the judge ever reaches.
 *
 * Reading the detector's value here was a real bug: a finding the judge sorted
 * as `ask` still carried its detector default of `recommend`, so it rendered as
 * a card AND became a drip question — the exact duplication the split exists to
 * prevent. Falling back to the detector's value when the judge has not run
 * keeps every card renderable with no model in the loop.
 */
export function effectiveDisposition(f: {
  disposition: FindingDisposition;
  judgedDisposition?: FindingDisposition | null;
}): FindingDisposition {
  return f.judgedDisposition ?? f.disposition;
}

/**
 * `ask` findings are QUESTIONS, and Staxis already has exactly one place it
 * asks a manager a question: the drip-question card. Rendering them here would
 * be a second question UI with different rules (that one asks at most once per
 * session and never nags; a card sits until dealt with). `drop` is the judge
 * saying "not worth surfacing" — kept in the ledger so the decision is
 * auditable, never shown.
 *
 * The route feeds this the EFFECTIVE disposition (above), and the adapter that
 * turns an `ask` finding into a drip question is src/lib/findings/ask-drip.ts.
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

// ─── Deep links: ?focus=<findingId> ─────────────────────────────────────────

/**
 * The finding id in a query string, or null.
 *
 * Shape-checked, not validated against anything: whatever comes back is looked
 * up in the cards THIS hotel already loaded, so a wrong or hostile value
 * matches nothing and the screen behaves as if no link had been followed. The
 * shape check exists to keep junk out of a className and a DOM attribute, not
 * as an authorization step — there is no authorization to do here, because
 * naming an id grants nothing.
 */
export function parseFocusParam(search: string): string | null {
  let raw: string | null = null;
  try {
    raw = new URLSearchParams(search).get('focus');
  } catch {
    return null;
  }
  if (!raw) return null;
  return /^[0-9a-fA-F-]{16,64}$/.test(raw) ? raw : null;
}

export interface FocusView<T> {
  /** What to render, in order. */
  visible: T[];
  /** What is behind the fold — empty when the fold is open. */
  folded: T[];
  /** True when the linked card was below the cap and the fold had to open. */
  focusIsFolded: boolean;
  /** Whether to draw the "show all" control at all. */
  showFoldToggle: boolean;
}

/**
 * The card list, with a deep link honoured.
 *
 * THE RULE THAT MATTERS: a `?focus=` link whose card sits below the attention
 * cap OPENS the fold. A link that lands on a card hidden behind "show all"
 * appears to do nothing — the manager taps a link from another screen, the page
 * changes, and the thing they were sent to look at is not on it. That is worse
 * than not offering the link, so the fold is not optional here.
 *
 * A focus id that matches nothing (stale link, another hotel's finding, junk in
 * the URL) changes nothing at all: same cards, same fold, same order.
 */
export function focusedSplit<T extends { id: string }>(
  ranked: readonly T[],
  cap: number,
  focusId: string | null | undefined,
  showAll: boolean,
): FocusView<T> {
  const { prominent, folded } = splitByCap(ranked, cap);
  const focusIsFolded = !!focusId && folded.some((f) => f.id === focusId);
  const open = showAll || focusIsFolded;
  return {
    visible: open ? [...ranked] : prominent,
    folded: open ? [] : folded,
    focusIsFolded,
    // Once the fold has been forced open for a link, the toggle would offer to
    // re-hide the very card the manager was sent to see.
    showFoldToggle: folded.length > 0 && !focusIsFolded,
  };
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
