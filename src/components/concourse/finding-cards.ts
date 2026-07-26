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

import {
  hasDomainClosure,
  type FindingDisposition,
  type FindingSeverity,
  type FindingStatus,
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

// ─── Sign-off: the company's rulebook standing on the button ────────────────

/**
 * The signature a company rule demands before this card's fix may run.
 *
 * Present on a card ONLY when a rule actually reaches it (see
 * src/lib/company/signoff.ts). Absent is the normal case, and is also the answer
 * for an independent hotel, a company with an empty rulebook, and a plan with no
 * dollar figure for a money rule to be about. Absent NEVER means "approved".
 */
export interface CardSignOff {
  /** 'owner' | 'vp' | 'finance' | 'general_manager' — whose signature. */
  approverRole: string;
  /** Names of the people who hold it here. May be empty; the card still locks. */
  approverNames: string[];
  /** The boundary the rule was written at, in cents. For the "why" line. */
  thresholdCents: number;
  /** True when the person looking at this card may sign it themselves. */
  callerMayApprove: boolean;
}

/**
 * THE LOCK. True when this card's fix is waiting on somebody else's signature.
 *
 * The card is still rendered in full — problem, numbers, receipt, plan — because
 * the founder's ruling is LOCKED, NOT HIDDEN: a GM who cannot see what the
 * company decided about their hotel learns that Staxis withholds things, which
 * costs more than the button was worth.
 */
export function isSignOffLocked(f: Pick<QueueFinding, 'signOff'>): boolean {
  return !!f.signOff && !f.signOff.callerMayApprove;
}

/**
 * The approver, ready to drop into each language's sentence.
 *
 * The Spanish side carries its OWN preposition, and that is not tidiness — it
 * is the contraction. "la aprobación de " + "el VP" produces "de el VP", which
 * Spanish writes "del VP". Building the contraction at the join site means
 * getting it right for four roles across two genders every time somebody edits
 * the sentence; carrying it here means the fragment is correct by construction.
 * `describeAuthorityRule` in rulebook-policy.ts hit the same trap and sidesteps
 * it the same way.
 */
const APPROVER_WORD: Record<string, Bi> = {
  owner: { en: 'owner', es: 'de la propiedad' },
  vp: { en: 'VP', es: 'del VP' },
  finance: { en: 'finance', es: 'de finanzas' },
  general_manager: { en: 'GM', es: 'del gerente' },
};

/**
 * What the locked button says instead. "Needs VP sign-off — sent to Maria."
 *
 * Keyed on the structured role rather than on any English the server produced,
 * so a Spanish speaker reads Spanish rather than a translation of a string that
 * might change. With no named approver it stops after the role — a company that
 * wrote a rule and has nobody holding the job still locks the card, and naming
 * nobody is more honest than naming the wrong person.
 */
export function signOffNotice(signOff: CardSignOff, lang: Lang): string {
  const role = pick(APPROVER_WORD[signOff.approverRole] ?? APPROVER_WORD.vp, lang);
  const names = signOff.approverNames.filter((n) => n && n.trim().length > 0);
  if (lang === 'es') {
    const head = `Necesita la aprobación ${role}`;
    return names.length > 0 ? `${head} — enviado a ${listNames(names, 'es')}` : head;
  }
  const head = `Needs ${role} sign-off`;
  return names.length > 0 ? `${head} — sent to ${listNames(names, 'en')}` : head;
}

/** "Maria", "Maria and Ana", "Maria, Ana and Bo". */
function listNames(names: readonly string[], lang: Lang): string {
  const and = lang === 'es' ? 'y' : 'and';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} ${and} ${names[names.length - 1]}`;
}

/**
 * True when this card should show a one-tap approve.
 *
 * FOUR CONDITIONS, AND THE DISPOSITION IS THE ONE THAT MATTERS.
 *
 * The fourth is the company rulebook: a plan whose cost clears a threshold the
 * company wrote a signature rule for shows no button to anyone who does not
 * hold that signature. This is a RENDERING of the rule and not the enforcement
 * of it — /api/findings/actions resolves the same requirement again before it
 * calls the database, so a stale browser cannot tap through a lock.
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
  f: Pick<QueueFinding, 'disposition' | 'action' | 'signOff'>,
): boolean {
  if (isSignOffLocked(f)) return false;
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
    // The preventive pair. Deliberately no dates in either sentence: `was` and
    // `now` here are raw timestamps, and rendering one would put a UTC instant
    // in front of a manager who thinks in local days. WHAT happened is the
    // useful part, and it is the part we can state exactly.
    case 'preventive_last_done':
      return es
        ? `Staxis no lo hizo: alguien ya marcó "${subject}" como hecho. No hace falta una orden de trabajo.`
        : `Staxis did not do it: somebody has already marked "${subject}" done. No work order is needed.`;
    case 'preventive_task':
      return es
        ? `Staxis no lo hizo: "${subject}" ya no está en el calendario de mantenimiento de este hotel.`
        : `Staxis did not do it: "${subject}" is no longer on this hotel's upkeep schedule.`;
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
  /**
   * The signature a company rule demands before `action` may run. Absent on
   * every card at an independent hotel, at a company with no rulebook, and on
   * every plan no money rule reaches — which is most of them. Absent is never
   * "approved"; see src/lib/company/signoff.ts.
   */
  signOff?: CardSignOff | null;
  /**
   * Which hotel this card is about, when the screen is showing more than one.
   * Null on a company-scope card (a cross-hotel comparison belongs to no single
   * hotel) and absent entirely on the hotel's own queue, where every card is
   * about the hotel the manager is already standing in.
   */
  hotel?: { propertyId: string; name: string } | null;
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
export function isCardRenderable(
  f: Pick<QueueFinding, 'disposition'> & { detectorId?: string },
): boolean {
  // A card that is the only place a stored fact can be updated stays a card,
  // whatever the judge decided. See DETECTORS_WITH_DOMAIN_CLOSURE for the
  // incident that motivated this — the drip-question surface cannot render
  // "Yes, it got done", so routing a preventive follow-up there produces a
  // question whose answer goes nowhere.
  if (hasDomainClosure(f.detectorId)) return true;
  return f.disposition !== 'ask' && f.disposition !== 'drop';
}

// ─── Ordering ───────────────────────────────────────────────────────────────

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
 * When Staxis first saw this finding, as milliseconds — the queue's arrival
 * clock. A timestamp we cannot read sorts LAST among its tie group rather than
 * jumping to the front: "we don't know when this showed up" is not a claim to
 * having waited longest than everything else on the screen.
 */
function arrivalMs(f: Pick<QueueFinding, 'firstSeenAt'>): number {
  const t = new Date(f.firstSeenAt).getTime();
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

/**
 * Biggest dollars first, and then FIRST COME, FIRST SERVED. Because plenty of
 * real findings have no price the hotel's own numbers can support:
 *
 *   1. anything with a price outranks anything without one
 *   2. among priced findings, the larger range midpoint first
 *   3. everything still tied — equal money, or no money at all — goes in
 *      ARRIVAL ORDER: oldest `firstSeenAt` on top. This deliberately replaces
 *      a severity tiebreak. Severity is a label Staxis chose; the day it first
 *      turned up is a fact about the hotel, and a card that has been sitting
 *      there for three days should not sink under one that arrived this
 *      morning wearing a louder chip. First found, first shown.
 *   4. then magnitude, then dedupe key — so the order is STABLE for the cards
 *      that landed in the same instant. A list that reshuffles between two
 *      identical loads teaches a manager that position means nothing, which
 *      defeats the whole point of ranking.
 */
export function rankFindings<T extends QueueFinding>(findings: readonly T[]): T[] {
  return [...findings].sort((a, b) => {
    const av = sortValueCents(a);
    const bv = sortValueCents(b);
    if (av !== null && bv === null) return -1;
    if (av === null && bv !== null) return 1;
    if (av !== null && bv !== null && av !== bv) return bv - av;

    // Subtraction would give NaN for two undateable cards (∞ − ∞).
    const aSeen = arrivalMs(a);
    const bSeen = arrivalMs(b);
    if (aSeen !== bSeen) return aSeen < bSeen ? -1 : 1;

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

/**
 * The one label the nav badge is counting. Reserved for `propose`.
 *
 * The badge on the Staxis pill counts findings whose EFFECTIVE disposition is
 * `propose` — "3 decisions waiting" (api/findings/badge). So the eyebrow that
 * says "NEEDS A DECISION" has to mean the same thing, or the manager taps a
 * badge of 3 and counts five cards claiming to want a decision. A severity is
 * how loud something is; a disposition is whether Staxis is actually asking
 * for an answer, and only the second one is a decision.
 */
const DECISION_LABEL: Bi = { en: 'NEEDS A DECISION', es: 'REQUIERE UNA DECISIÓN' };

const SEVERITY_LABEL: Record<FindingSeverity, Bi> = {
  // Loud, but there is nothing to answer: it is news, not a question.
  critical: { en: 'URGENT', es: 'URGENTE' },
  attention: { en: 'WORTH A LOOK', es: 'VALE LA PENA REVISARLO' },
  info: { en: 'FOR YOUR INFORMATION', es: 'PARA TU INFORMACIÓN' },
};

/**
 * The eyebrow above a card: what kind of thing this is, in one line.
 *
 * `disposition` here is already the EFFECTIVE one — /api/findings resolves the
 * judge's verdict over the detector's default before the card ever reaches a
 * screen — so a finding the judge demoted to `recommend` loses the decision
 * wording along with the button, and both for the same reason.
 */
export function cardEyebrowLabel(
  f: Pick<QueueFinding, 'severity' | 'disposition'>,
  lang: Lang,
): string {
  return pick(f.disposition === 'propose' ? DECISION_LABEL : SEVERITY_LABEL[f.severity], lang);
}

// ─── Closure: how a manager puts a card down ────────────────────────────────
//
// WHY THIS IS A TABLE AND NOT THREE `if`s IN THE COMPONENT
//
// A card with no way to close it is not a quiet card, it is a card that lies
// twice. It lingers on the screen after the manager has already dealt with the
// thing, and — worse — the self-demotion counters (demotion.ts) read that
// absence of taps as "this hotel ignores this check". A manager who called the
// ice-machine guy and a manager who scrolled past are recorded identically.
//
// So every renderable disposition names its closure set HERE, once, and the
// component renders whatever this returns. That is what makes "propose and fyi
// did not change" a thing a test can prove rather than a thing a diff review
// hopes.
//
// THE ONE RULE THAT IS NOT NEGOTIABLE
// "Seen" (`known_problem`) silences the FEED. It must never touch the outcome.
// The manager saying "I know, stop showing me" is not the manager saying the
// problem is over, and the two verdicts stay different in the database as well
// as on the screen: `resolved` stamps resolved_at, `known_problem` records the
// magnitude the silence was armed at and leaves the outcome alone (store.ts
// setFindingStatus). Nothing here may map a "Seen" tap onto `resolved`.

/**
 * `pm_done` and `pm_called` are the preventive-maintenance pair, and they are
 * verdicts rather than actions for a precise reason: the physical work — the
 * flush, the filter swap — is the one thing no software can do. Staxis cannot
 * offer to perform it, so there is no frozen plan and no re-verification; there
 * is only a manager telling it what happened out in the building.
 *
 * They differ from the other three in having a SIDE EFFECT beyond the card:
 * `pm_done` moves the schedule's last-done date, which restarts its clock, and
 * `pm_called` sets the resting flag that the detector reads. Both then close the
 * card, because a card whose underlying state has changed and which stayed on
 * screen would be the same lie as one that never closed at all. Where that
 * happens is POST /api/findings — see the route header for why the schedule id
 * is resolved from the finding rather than named by the browser.
 */
export type ClosureVerdict =
  | 'resolved'
  | 'known_problem'
  | 'muted'
  | 'pm_done'
  | 'pm_called';

/** The second tap, for the verdict that cannot be taken back. */
export interface ClosureConfirm {
  prompt: string;
  yes: string;
}

export interface ClosureButton {
  /** What POST /api/findings is told. */
  verdict: ClosureVerdict;
  label: string;
  /** The title attribute — what the button actually costs. Null when obvious. */
  hint: string | null;
  tone: 'primary' | 'plain' | 'danger';
  /** Non-null when the verdict must be confirmed before it is sent. */
  confirm: ClosureConfirm | null;
}

interface ClosureSpec {
  verdict: ClosureVerdict;
  tone: ClosureButton['tone'];
  label: Bi;
  hint: Bi | null;
  confirm: { prompt: Bi; yes: Bi } | null;
}

/**
 * Quiet, permanently, EXCEPT escalation. Arming the silencer at 4 work orders
 * is consent to 4, not to 9 — the same sentence under "Known problem" on a
 * proposal and under "Seen" on a recommendation, because it is the same verdict.
 */
const KNOWN_HINT: Bi = {
  en: 'Staxis stops bringing this up — unless it gets meaningfully worse.',
  es: 'Staxis deja de mencionarlo, salvo que empeore de forma clara.',
};

/**
 * The honest half of "Handled it": it closes the card, it does not promise the
 * problem is gone forever. A recurrence opens a genuinely NEW card, because the
 * handling apparently did not take, and that is information rather than a
 * relapse of the same nag.
 */
const HANDLED_HINT: Bi = {
  en: 'Staxis closes this out. If it happens again it comes back as a new card.',
  es: 'Staxis lo da por cerrado. Si vuelve a pasar, volverá como una tarjeta nueva.',
};

/**
 * What "Done" costs on a dated job: the clock restarts from today, so the next
 * card is one full cadence away. Said out loud because it is the one verdict
 * here that changes a stored date rather than just closing a card.
 */
const PM_DONE_HINT: Bi = {
  en: 'Staxis marks it done today and starts counting to the next one.',
  es: 'Staxis lo marca como hecho hoy y empieza a contar hasta el próximo.',
};

/**
 * The honest description of the rest. It names the week, because a manager who
 * expects silence forever and gets a card in seven days will read it as a nag —
 * and a manager who knows it is coming reads the same card as the reminder they
 * asked for. Same sentence, opposite feeling, and the difference is entirely
 * whether we said so.
 */
const PM_CALLED_HINT: Bi = {
  en: 'Staxis goes quiet for a week, then asks once whether it happened.',
  es: 'Staxis se calla una semana y luego pregunta una vez si se hizo.',
};

/** Unconditional, so it asks first. The one verdict with no escape hatch. */
const STOP_WATCHING: Bi = {
  en: 'Staxis will stop watching this — sure?',
  es: 'Staxis dejará de vigilar esto. ¿Seguro?',
};

/**
 * WHAT EACH KIND OF CARD OFFERS.
 *
 * `propose` and `fyi` are exactly what they were before recommendations grew
 * closure — a proposal's one-tap fix is rendered separately (offersApproval),
 * and these are the ways to put the card down afterwards.
 *
 * `recommend` is the new one: "worth doing" work Staxis cannot do itself, which
 * until now had no way to end. Three outcomes, and they are genuinely three —
 * I did it, I know and I do not want to hear it again, I am not doing it — with
 * a different row state behind each.
 *
 * `ask` and `drop` never render as cards at all (isCardRenderable), so their
 * empty sets are unreachable rather than a design.
 */
const CLOSURE_SETS: Record<FindingDisposition, readonly ClosureSpec[]> = {
  propose: [
    { verdict: 'known_problem', tone: 'primary', label: { en: 'Known problem', es: 'Ya lo sé' }, hint: KNOWN_HINT, confirm: null },
    { verdict: 'resolved', tone: 'plain', label: { en: 'Fixed', es: 'Resuelto' }, hint: null, confirm: null },
    {
      verdict: 'muted',
      tone: 'danger',
      label: { en: 'Mute', es: 'Silenciar' },
      hint: null,
      confirm: { prompt: STOP_WATCHING, yes: { en: 'Yes, mute it', es: 'Sí, silenciar' } },
    },
  ],
  recommend: [
    { verdict: 'resolved', tone: 'primary', label: { en: 'Handled it', es: 'Ya me encargué' }, hint: HANDLED_HINT, confirm: null },
    { verdict: 'known_problem', tone: 'plain', label: { en: 'Seen', es: 'Visto' }, hint: KNOWN_HINT, confirm: null },
    {
      verdict: 'muted',
      tone: 'danger',
      label: { en: 'Not doing this', es: 'No lo voy a hacer' },
      hint: null,
      // The prompt is the same sentence Mute has always asked. The yes button
      // is not: "Yes, mute it" after tapping "Not doing this" reads like a
      // different button than the one the manager pressed.
      confirm: { prompt: STOP_WATCHING, yes: { en: 'Yes, stop watching', es: 'Sí, deja de vigilarlo' } },
    },
  ],
  // Information, not a task. One quiet way to put it away, and nothing that
  // looks like it wants a decision.
  fyi: [
    { verdict: 'known_problem', tone: 'plain', label: { en: 'Got it', es: 'Entendido' }, hint: KNOWN_HINT, confirm: null },
  ],
  ask: [],
  drop: [],
};

// ─── Closure, when the card is about a job in the building ──────────────────
//
// WHY ONE DETECTOR GETS ITS OWN SET, AND WHY THAT IS NOT A SLIPPERY SLOPE
//
// The three verdicts above are the right ones for a card about a PATTERN: I
// dealt with it, I know already, stop watching. A preventive card is not about a
// pattern — it is about a specific physical job with a date on it — and the
// honest answers to "the water heater flush is due" are different in kind:
//
//   Done                     the flush happened. Restart the clock. This is a
//                            FACT ABOUT THE BUILDING, not a verdict about a
//                            card, which is why it writes to the schedule and
//                            not just to the finding.
//   Somebody's been called   arranged, not finished. Go quiet, then ask again.
//                            There is no existing verdict that means this: it is
//                            neither "handled" (nothing has happened yet) nor
//                            "known problem" (they do not want it to go quiet
//                            forever — they want to be reminded).
//
// "Known problem" is deliberately ABSENT from both sets. On a dated job it would
// mean "yes, I know it is overdue, stop mentioning it", which is the one thing
// this feature exists to refuse: the entire promise the hotel bought is that
// Staxis remembers upkeep after everyone else has stopped. Muting is still
// there, because a manager who genuinely does not want a schedule watched should
// be able to say so — but it asks first, and it is the loud version.
//
// This table is keyed on DETECTOR ID, and it should stay a table with one entry
// for a long time. A detector needs an entry here only when its card is about a
// different KIND of thing, not when somebody wants nicer words.
const DETECTOR_CLOSURE_SETS: Readonly<Record<string, Readonly<Partial<Record<FindingDisposition, readonly ClosureSpec[]>>>>> = {
  preventive_due: {
    // The due card: Staxis is offering to raise the ticket (that button is
    // rendered separately, by offersApproval), and these are what a manager
    // says instead when the answer is about the building rather than the board.
    propose: [
      { verdict: 'pm_done', tone: 'primary', label: { en: 'Done', es: 'Hecho' }, hint: PM_DONE_HINT, confirm: null },
      { verdict: 'pm_called', tone: 'plain', label: { en: "Somebody's been called", es: 'Ya llamamos a alguien' }, hint: PM_CALLED_HINT, confirm: null },
      {
        verdict: 'muted',
        tone: 'danger',
        label: { en: 'Stop tracking this', es: 'Dejar de seguir esto' },
        hint: null,
        confirm: { prompt: STOP_WATCHING, yes: { en: 'Yes, stop watching', es: 'Sí, deja de vigilarlo' } },
      },
    ],
    // The follow-up card, a week after somebody was called. Same two facts, and
    // "still waiting" re-arms another quiet week rather than nagging daily.
    recommend: [
      { verdict: 'pm_done', tone: 'primary', label: { en: 'Yes, it got done', es: 'Sí, ya se hizo' }, hint: PM_DONE_HINT, confirm: null },
      { verdict: 'pm_called', tone: 'plain', label: { en: 'Still waiting', es: 'Todavía esperando' }, hint: PM_CALLED_HINT, confirm: null },
      {
        verdict: 'muted',
        tone: 'danger',
        label: { en: 'Stop tracking this', es: 'Dejar de seguir esto' },
        hint: null,
        confirm: { prompt: STOP_WATCHING, yes: { en: 'Yes, stop watching', es: 'Sí, deja de vigilarlo' } },
      },
    ],
  },
};

/**
 * The closure buttons this card offers, in render order, in one language.
 *
 * `detectorId` is optional so every existing caller keeps working unchanged and
 * gets exactly the buttons it got before. A detector with no entry in the table
 * above falls through to the per-disposition set, which is the whole point:
 * adding a detector must not require touching this file.
 */
export function closureButtons(
  f: Pick<QueueFinding, 'disposition'> & { detectorId?: string },
  lang: Lang,
): ClosureButton[] {
  const override = f.detectorId ? DETECTOR_CLOSURE_SETS[f.detectorId]?.[f.disposition] : undefined;
  return (override ?? CLOSURE_SETS[f.disposition] ?? []).map((spec) => ({
    verdict: spec.verdict,
    label: pick(spec.label, lang),
    hint: spec.hint ? pick(spec.hint, lang) : null,
    tone: spec.tone,
    confirm: spec.confirm
      ? { prompt: pick(spec.confirm.prompt, lang), yes: pick(spec.confirm.yes, lang) }
      : null,
  }));
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
  // "Checked 1 things last night" is the sentence that tells a manager nobody
  // read this screen before they did. A hotel on its first night, or one where
  // every check but one is skipping for want of data, hits it immediately.
  const one = checked === 1;
  return {
    kind: 'fresh',
    text:
      lang === 'es'
        ? `Se ${one ? 'revisó' : 'revisaron'} ${checked} ${one ? 'cosa' : 'cosas'} anoche — ${normal} se ${normal === 1 ? 've normal' : 'ven normales'}.`
        : `Checked ${checked} ${one ? 'thing' : 'things'} last night — ${normal} look normal.`,
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
