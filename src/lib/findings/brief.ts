// ═══════════════════════════════════════════════════════════════════════════
// The morning brief — six to eight lines, once a day, on the hotel's clock.
//
// WHAT IT IS
// One pinned card above everything else in the Staxis tab: what happened
// overnight, the two or three things most worth a manager's attention, anything
// that cleared on its own, and the liveness line that proves the watcher ran.
//
// WHY THIS FILE HAS NO DATABASE IN IT
// Every decision the brief makes is a way it could lie to a manager:
//
//   • say "quiet night, all normal" while six problems sit below it
//   • say anything at all about a hotel that has never been checked
//   • rank a $180 card above a $2,100 one
//   • claim "overnight" about a check that happened four days ago
//   • run to eleven lines, which is the same as running to zero
//
// So the whole of it lives here as pure functions over plain data, and the
// server half (brief-server.ts) only gathers rows and hands them in. That is
// also what makes these testable: the suite calls buildBrief() with real-shaped
// findings and asserts the sentences, with no Postgres and no model anywhere.
//
// THE MODEL IS NOT LOAD-BEARING
// buildBrief() is complete and correct with zero model calls — every sentence
// it produces is a template filled from stored numbers. The optional phrasing
// pass (brief-server.ts) may only rewrite the WORDING of lines this file
// already wrote, and prose-guard.ts throws the rewrite away whole if it
// contains a number this file did not put there. Losing the model costs
// smoothness, never a fact and never a line.
// ═══════════════════════════════════════════════════════════════════════════

import {
  cardPhrasing,
  distinctDetectors,
  formatPriceRange,
  livenessLine,
  rankFindings,
  sortValueCents,
  type QueueFinding,
  type QueueRun,
} from '@/components/concourse/finding-cards';

// ─── Shape ──────────────────────────────────────────────────────────────────

/**
 * Six to eight lines. The cap is the product, not a safety valve: a manager
 * reads a six-line brief in ten seconds and an eleven-line one never. Anything
 * that does not fit is already a card below the brief — nothing is lost by
 * leaving it out, and everything is lost by making the brief skippable.
 */
export const MAX_BRIEF_LINES = 8;

/** How many cards get quoted by name. Two or three; the rest are cards. */
export const MAX_BRIEF_HIGHLIGHTS = 3;

export interface BriefLine {
  en: string;
  es: string;
  /**
   * Set on the lines that quote a specific card, so tapping the line can jump
   * to that card (the `?focus=` seam). Absent on the framing sentences.
   */
  findingId?: string;
}

export interface MorningBrief {
  propertyId: string;
  /** The hotel's own calendar day this brief belongs to (YYYY-MM-DD). */
  localDate: string;
  generatedAt: string;
  /** 'quiet' is the one-line night. 'report' is everything else. */
  kind: 'quiet' | 'report';
  lines: BriefLine[];
  /** Which cards the brief named, in the order it named them. */
  focusIds: string[];
  /** Whether the wording is this file's templates or the phrasing pass's. */
  source: 'template' | 'model';
}

export interface BriefInput {
  propertyId: string;
  localDate: string;
  /** The last findings run, or null when this hotel has never been checked. */
  run: QueueRun | null;
  /** Live cards (open + updated, card-renderable) as the queue would show them. */
  cards: readonly QueueFinding[];
  /** Findings the runner retired inside the window — the ones that went away. */
  cleared: readonly QueueFinding[];
  /** Start of the overnight window. See briefWindowStart. */
  windowStart: Date;
  now: Date;
}

// ─── Timezone ───────────────────────────────────────────────────────────────

/**
 * The instant a hotel's local calendar day begins, as a real UTC Date.
 *
 * Two passes, not one: the offset used to convert must be the offset IN EFFECT
 * at the answer, not at the guess. On a spring-forward morning those differ by
 * an hour, and a one-pass version puts the day boundary inside the previous day
 * — which would put a 12:30am finding in yesterday's brief.
 */
export function localDayStart(localDate: string, timezone: string | null): Date {
  const naive = Date.parse(`${localDate}T00:00:00Z`);
  if (!Number.isFinite(naive)) throw new Error(`Invalid local date: ${localDate}`);
  if (!timezone) return new Date(naive);
  try {
    let guess = naive - tzOffsetMs(new Date(naive), timezone);
    guess = naive - tzOffsetMs(new Date(guess), timezone);
    return new Date(guess);
  } catch {
    // An unknown IANA zone is a data problem, not a reason to have no brief.
    // UTC is the same fallback propertyLocalToday takes.
    return new Date(naive);
  }
}

/** How far ahead of UTC `tz` is at this instant, in ms. */
function tzOffsetMs(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(
    get('year'), get('month') - 1, get('day'),
    get('hour'), get('minute'), get('second'),
  );
  return asUtc - at.getTime();
}

/**
 * When "overnight" starts.
 *
 * Local midnight is the honest answer nine mornings in ten. The `min` with the
 * run is what saves the tenth: a check that ran at 11pm local, or a hotel whose
 * nightly check has not fired in days, would otherwise fall OUTSIDE the window
 * and the brief would report "nothing happened" about a night in which the
 * watcher did its whole job. The window always contains the check it is
 * describing.
 *
 * It does mean a stale check drags the window back with it — which is exactly
 * why a stale run also changes the framing (see `sinceLabel`): those findings
 * are reported as "since the last check", never as "overnight".
 */
export function briefWindowStart(localMidnight: Date, run: QueueRun | null): Date {
  if (!run?.runAt) return localMidnight;
  const ranAt = new Date(run.runAt);
  if (Number.isNaN(ranAt.getTime())) return localMidnight;
  return ranAt.getTime() < localMidnight.getTime() ? ranAt : localMidnight;
}

// ─── Copy ───────────────────────────────────────────────────────────────────

type Bi = { en: string; es: string };

function line(en: string, es: string, findingId?: string): BriefLine {
  return findingId ? { en, es, findingId } : { en, es };
}

/**
 * "Overnight" or "Since the last check".
 *
 * A stale run may not borrow the word "overnight". The counts are still true —
 * they are what that run found — but calling a four-day-old check "overnight"
 * is the precise lie the staleness band in livenessLine exists to prevent, and
 * the brief must not reintroduce it one line higher up the screen.
 */
function sinceLabel(fresh: boolean): Bi {
  return fresh
    ? { en: 'Overnight', es: 'Anoche' }
    : { en: 'Since the last check', es: 'Desde la última revisión' };
}

function thingsNew(n: number): Bi {
  return n === 1
    ? { en: '1 new thing', es: '1 cosa nueva' }
    : { en: `${n} new things`, es: `${n} cosas nuevas` };
}

function thingsChanged(n: number): Bi {
  return n === 1
    ? { en: '1 thing changed', es: '1 cosa cambió' }
    : { en: `${n} things changed`, es: `${n} cosas cambiaron` };
}

// ─── Assembly ───────────────────────────────────────────────────────────────

/**
 * The brief, or null.
 *
 * NULL IS A REAL ANSWER AND IT IS THE MOST IMPORTANT ONE. A hotel with no run
 * history gets no brief at all — not "quiet night", not "all normal", not an
 * empty card. Every other outcome on this screen is a claim about having
 * looked, and we have not looked. The card simply is not there.
 */
export function buildBrief(input: BriefInput): MorningBrief | null {
  const { run } = input;
  if (!run?.runAt || Number.isNaN(new Date(run.runAt).getTime())) return null;

  const cards = rankFindings([...input.cards]);
  const fresh = livenessLine(run, 0, 'en', input.now).kind === 'fresh';

  const windowMs = input.windowStart.getTime();
  const newCards = cards.filter((f) => at(f.firstSeenAt) >= windowMs);
  const changedCards = cards.filter(
    (f) => at(f.firstSeenAt) < windowMs && f.status === 'updated' && at(f.lastSeenAt) >= windowMs,
  );
  const cleared = [...input.cleared];

  const liveness = livenessLine(run, distinctDetectors(cards), 'en', input.now);
  const livenessEs = livenessLine(run, distinctDetectors(cards), 'es', input.now);

  // ── the quiet night ──
  // One line, and it is only allowed to say "all normal" when nothing is
  // standing. Six open cards under the words "all normal" would be the single
  // most damaging sentence this screen could print, so the standing-card count
  // is part of the condition, not just the overnight deltas.
  if (
    fresh
    && newCards.length === 0
    && changedCards.length === 0
    && cleared.length === 0
    && cards.length === 0
  ) {
    const checked = Math.max(0, Math.round(run.detectorsChecked));
    return finish(input, 'quiet', [
      line(
        `Quiet night. Checked ${checked} things, all normal.`,
        `Noche tranquila. Se revisaron ${checked} cosas, todo normal.`,
      ),
    ]);
  }

  const lines: BriefLine[] = [];
  const since = sinceLabel(fresh);

  // ── what happened ──
  if (newCards.length > 0 && changedCards.length > 0) {
    const n = thingsNew(newCards.length);
    const c = thingsChanged(changedCards.length);
    lines.push(line(`${since.en}: ${n.en}, and ${c.en}.`, `${since.es}: ${n.es}, y ${c.es}.`));
  } else if (newCards.length > 0) {
    const n = thingsNew(newCards.length);
    lines.push(line(`${since.en}: ${n.en} to look at.`, `${since.es}: ${n.es} para revisar.`));
  } else if (changedCards.length > 0) {
    const c = thingsChanged(changedCards.length);
    lines.push(line(
      `${since.en}: nothing new, ${c.en}.`,
      `${since.es}: nada nuevo, ${c.es}.`,
    ));
  } else if (fresh) {
    lines.push(line('Nothing new overnight.', 'Nada nuevo anoche.'));
  }

  // ── the two or three worth the attention ──
  // Ranked by dollars (rankFindings), and the price is carried on the line so
  // the ordering is legible rather than something the manager has to trust.
  for (const card of cards.slice(0, MAX_BRIEF_HIGHLIGHTS)) {
    lines.push(highlightLine(card));
  }

  // ── what went away by itself ──
  if (cleared.length === 1) {
    const only = cleared[0];
    lines.push(line(
      `1 thing cleared on its own: ${cardPhrasing(only, 'en')}`,
      `1 cosa se resolvió sola: ${cardPhrasing(only, 'es')}`,
      only.id,
    ));
  } else if (cleared.length > 1) {
    lines.push(line(
      `${cleared.length} things cleared on their own.`,
      `${cleared.length} cosas se resolvieron solas.`,
    ));
  }

  // ── proof the watcher ran ──
  // Always last, and always the existing liveness sentence rather than a second
  // implementation of it: one place decides what we are entitled to claim about
  // having checked, and it is the same place the cards below use.
  if (liveness.text && livenessEs.text) {
    lines.push(line(liveness.text, livenessEs.text));
  }

  return finish(input, 'report', lines);
}

/** "Room 214 has had 4 HVAC work orders in the last 30 days. — $600–1,400" */
function highlightLine(card: QueueFinding): BriefLine {
  const price = formatPriceRange(card.price);
  const suffix = price ? ` — ${price}` : '';
  return line(
    `${cardPhrasing(card, 'en')}${suffix}`,
    `${cardPhrasing(card, 'es')}${suffix}`,
    card.id,
  );
}

/**
 * The hard cap, applied in ONE place so no future section can quietly extend
 * the brief past the length a manager will read. Truncation keeps the front of
 * the list because the front is ordered by what matters — and the liveness line
 * is what gets dropped last, so it is appended after this slice cannot bite it.
 */
function finish(input: BriefInput, kind: 'quiet' | 'report', lines: BriefLine[]): MorningBrief {
  const kept = lines.slice(0, MAX_BRIEF_LINES);
  return {
    propertyId: input.propertyId,
    localDate: input.localDate,
    generatedAt: input.now.toISOString(),
    kind,
    lines: kept,
    focusIds: kept.map((l) => l.findingId).filter((id): id is string => !!id),
    source: 'template',
  };
}

function at(iso: string | null | undefined): number {
  if (!iso) return 0;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

// ─── What the phrasing pass is allowed to see, and to change ────────────────

/**
 * The numbers the brief actually rests on, as a flat payload.
 *
 * This is what the prose guard checks the rewritten sentences against. It is
 * built from the SAME values the template lines were built from — the run
 * counts, each quoted card's price and magnitude — so "every number in the
 * prose came from here" is enforceable rather than aspirational. A model that
 * writes "$1,900" for a $2,100–3,800 range has authored a number, and the whole
 * rewrite is discarded.
 */
export function briefFacts(brief: MorningBrief, input: BriefInput): Record<string, unknown> {
  const run = input.run;
  const cards = rankFindings([...input.cards]);
  return {
    detectorsChecked: run ? Math.max(0, Math.round(run.detectorsChecked)) : 0,
    detectorsSkipped: run ? Math.max(0, Math.round(run.detectorsSkipped)) : 0,
    lineCount: brief.lines.length,
    clearedCount: input.cleared.length,
    cards: cards.slice(0, MAX_BRIEF_HIGHLIGHTS).map((card) => ({
      magnitude: card.magnitude,
      occurrences: card.occurrenceCount,
      valueCents: sortValueCents(card),
      lowCents: card.price?.lowCents ?? null,
      highCents: card.price?.highCents ?? null,
      lowDollars: card.price ? card.price.lowCents / 100 : null,
      highDollars: card.price ? card.price.highCents / 100 : null,
    })),
  };
}

/** Both languages of the template, joined — the text the guard's receipt is
 *  harvested from, so anything the template already said is backed. */
export function briefTemplateText(brief: MorningBrief): string {
  return brief.lines.map((l) => `${l.en} ${l.es}`).join(' ');
}

// ─── The phrasing pass's contract ───────────────────────────────────────────

export interface PhrasedLine {
  en: string;
  es: string;
}

/**
 * Parse a phrasing reply, or refuse it whole.
 *
 * SAME LENGTH, SAME ORDER. The pass is allowed to smooth wording; it is not
 * allowed to add a line, drop one, or reorder them — every line is anchored to
 * a card id on this side, and a reordered reply would attach the ice machine's
 * sentence to the breakfast card's link. A reply that does not line up exactly
 * is not partially useful, so it is refused entirely and the template stands.
 */
export function parseBriefPhrasing(text: string, expected: number): PhrasedLine[] {
  const json = extractJson(text);
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new BriefPhrasingError('reply was not a JSON object');
  }
  const raw = (json as { lines?: unknown }).lines;
  if (!Array.isArray(raw)) throw new BriefPhrasingError('reply had no lines array');
  if (raw.length !== expected) {
    throw new BriefPhrasingError(`reply had ${raw.length} lines, expected ${expected}`);
  }
  if (raw.length > MAX_BRIEF_LINES) throw new BriefPhrasingError('reply was over the line cap');

  return raw.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new BriefPhrasingError(`line ${index} was not an object`);
    }
    const keys = Object.keys(item as Record<string, unknown>);
    // An extra key is a model doing something it was not asked to do. There is
    // no field here it could add that we would want.
    if (keys.some((k) => k !== 'en' && k !== 'es')) {
      throw new BriefPhrasingError(`line ${index} carried an unexpected key`);
    }
    const en = (item as { en?: unknown }).en;
    const es = (item as { es?: unknown }).es;
    if (typeof en !== 'string' || typeof es !== 'string') {
      throw new BriefPhrasingError(`line ${index} was missing en or es`);
    }
    if (en.trim().length === 0 || es.trim().length === 0) {
      throw new BriefPhrasingError(`line ${index} was blank in one language`);
    }
    return { en: en.trim(), es: es.trim() };
  });
}

export class BriefPhrasingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BriefPhrasingError';
  }
}

/** Tolerate a model that wraps its JSON in prose or a fence. */
function extractJson(text: string): unknown {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const body = fenced ? fenced[1].trim() : trimmed;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Put accepted phrasing back on the brief. The card anchors are this side's,
 * never the model's — so a rewritten line still jumps to the card the template
 * chose, and phrasing cannot silently relink anything.
 */
export function applyBriefPhrasing(brief: MorningBrief, phrased: readonly PhrasedLine[]): MorningBrief {
  if (phrased.length !== brief.lines.length) return brief;
  return {
    ...brief,
    source: 'model',
    lines: brief.lines.map((original, index) => {
      const next = phrased[index];
      return original.findingId
        ? { en: next.en, es: next.es, findingId: original.findingId }
        : { en: next.en, es: next.es };
    }),
  };
}
