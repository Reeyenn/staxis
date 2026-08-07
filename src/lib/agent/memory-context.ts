// ─── Memory retrieval + prompt injection ────────────────────────────────────
// The READ path for long-term copilot memory (migration 0256). Each turn the
// route fetches the hotel's active memory, ranks + caps it, and injects it into
// the DYNAMIC (uncached) half of the system prompt as ESCAPED reference data
// inside a <staxis-memory> trust marker. The model is told (base-prompt rule,
// migration 0257) to treat it as data, never instructions.
//
// v1 is intentionally UNCACHED — retrieval is one indexed query/turn, and a
// per-process cache would make "tell it something, then ask in a fresh chat"
// flaky on multi-instance serverless. Revisit only if latency profiling flags it.
//
// ═══ SALIENCE, AND WHY IT NEEDED A RESERVED FLOOR ═══════════════════════════
//
// Retrieval hands back up to 200 rows and the prompt takes a couple of dozen,
// so something has to choose. v1 chose by a pure source-tier sort, which put
// corrections and human-taught facts at the front by construction — the
// guarantee "the thing a manager told us always survives" was TRUE, but it was
// true as a SIDE EFFECT of a comparator, not as a rule anything asserted.
//
// That is a fragile place for the product's most important promise to live. The
// comparator's own comment said "no weighted decay in v1", which is exactly the
// change somebody makes next; the day any recency or confidence weight is added
// to the sort, a two-month-old "the boiler key is behind the front desk" starts
// losing to twenty fresh auto-learned observations, and nothing fails.
//
// So this file now does both halves explicitly:
//
//   1. `memorySalience` — a real score, so confidence and recency can break
//      ties WITHOUT being able to lift an auto-learned guess above a human
//      fact (the source weights are spaced wider than the maximum bonus).
//   2. A RESERVED FLOOR — `MEMORY_SALIENT_FLOOR` slots are packed with
//      human-authored facts BEFORE anything else competes for the budget. The
//      guarantee is now a line of code with a test on it rather than an
//      emergent property of a sort.
//
// And one real fidelity fix: the character budget used to `break` at the first
// row that did not fit, so a single long entry evicted every fact behind it.
// It now skips that row and keeps going.

import { escapeTrustMarkerContent } from './llm';
import { getActiveMemoryForTurn, type MemoryRow } from '@/lib/db/agent-memory';

/**
 * Hard caps — the context-stuffing / cost ceiling. Guaranteed because
 * retrieval is server-side and deterministic.
 *
 * Raised from 20 / 6000 to 24 / 7200 (~1800 tokens at 4 chars/token). The
 * measurement behind "modestly": a rendered entry is the row's content plus a
 * fixed ~190-character envelope, and stored content is capped at 500 characters
 * by `storeMemory`, so the block's own char budget is what binds in practice,
 * not the entry count. 7200 is +20% on a per-turn block that sits beside a
 * hotel snapshot and an awareness block inside the existing per-request cost
 * reservation headroom. The entry count moved with it so the extra characters
 * can actually be spent on more facts rather than on longer ones.
 */
export const MAX_MEMORY_ENTRIES = 24;
export const MEMORY_CHAR_BUDGET = 7200;

/**
 * How many slots are held for facts a HUMAN authored.
 *
 * Small on purpose. This is not "prefer human facts" — the ranking already
 * does that — it is a floor under the number that survive when the ranking
 * changes, when one enormous entry eats the budget, or when a hotel has
 * hundreds of auto-learned rows. Eight is roughly a hotel's worth of standing
 * instructions; past that the ordinary ranking is a better judge than a quota.
 */
export const MEMORY_SALIENT_FLOOR = 8;

/**
 * Sources a PERSON is behind. These are the rows the floor protects.
 *
 * `correction` is somebody telling us we got it wrong, which is the highest
 * value signal in the whole store; `explicit_user` is somebody telling us
 * something on purpose. Everything else is Staxis's own inference and is
 * allowed to lose.
 */
const HUMAN_AUTHORED_SOURCES: ReadonlySet<string> = new Set(['correction', 'explicit_user']);

export function isHumanAuthoredMemory(row: MemoryRow): boolean {
  return HUMAN_AUTHORED_SOURCES.has(row.source);
}

// Lower = surfaced first. Corrections and explicit facts beat inferred/derived.
const SOURCE_RANK: Record<string, number> = {
  correction: 0,
  explicit_user: 1,
  consolidation: 2,
  operational: 2, // auto-learned from operations — ranks with consolidation, below human facts
  inferred: 3,
};

/**
 * Base salience per source. Spaced in HUNDREDS while every bonus below is
 * capped in the low tens, which is the whole safety property: no amount of
 * freshness or confidence can promote a guess above something a person said.
 */
const SOURCE_SALIENCE: Record<string, number> = {
  correction: 500,
  explicit_user: 400,
  consolidation: 200,
  operational: 200,
  inferred: 100,
};

const CONFIDENCE_BONUS: Record<string, number> = { high: 8, medium: 4, low: 0 };

/** Recency is worth at most this much, so it only ever breaks ties. */
const MAX_RECENCY_BONUS = 12;
/** Full recency bonus today, none after this many days. */
const RECENCY_HALFLIFE_DAYS = 30;

/**
 * How much this row deserves a slot.
 *
 * Deterministic given (source, confidence, updatedAt, now). Exported because
 * the guarantee this file makes is only worth as much as the test that can
 * call this directly and prove a fresh guess never outscores a stale fact.
 */
export function memorySalience(row: MemoryRow, now: Date = new Date()): number {
  const base = SOURCE_SALIENCE[row.source] ?? 50;
  const confidence = CONFIDENCE_BONUS[row.confidence] ?? 0;
  const updated = Date.parse(row.updatedAt);
  let recency = 0;
  if (Number.isFinite(updated)) {
    const ageDays = Math.max(0, (now.getTime() - updated) / 86_400_000);
    recency = Math.max(0, MAX_RECENCY_BONUS * (1 - ageDays / RECENCY_HALFLIFE_DAYS));
  }
  // Personal preferences edge out hotel-wide facts of equal standing, which is
  // the same tie-break the original comparator made and for the same reason:
  // "how I like it" is about the person in the conversation.
  const scope = row.scope === 'user' ? 1 : 0;
  return base + confidence + recency + scope;
}

/**
 * Deterministic ordering, stable across turns.
 *
 * Salience first, then the original tie-breaks so two rows that score the same
 * (which is common: same source, same confidence, same day) land in exactly
 * the order they always did. `SOURCE_RANK` is kept as the first tie-break
 * rather than deleted so a source added to one table and not the other still
 * sorts sensibly instead of jumping to the front.
 */
function rankMemory(rows: MemoryRow[], now: Date = new Date()): MemoryRow[] {
  return [...rows].sort((a, b) => {
    const sal = memorySalience(b, now) - memorySalience(a, now);
    if (Math.abs(sal) > 1e-9) return sal;
    const sr = (SOURCE_RANK[a.source] ?? 9) - (SOURCE_RANK[b.source] ?? 9);
    if (sr !== 0) return sr;
    if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1; // newer first
    if (a.scope !== b.scope) return a.scope === 'user' ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
}

/** Escape a value destined for a double-quoted XML attribute: HTML-escape
 *  <,>,& (shared with content) then neutralize the quote that would break out. */
function attrEscape(s: string): string {
  return escapeTrustMarkerContent(s).replace(/"/g, '&quot;');
}

/** One rendered entry. Pure, so the packer can measure a row before taking it. */
function renderMemoryLine(r: MemoryRow): string {
  const scopeLabel = r.scope === 'user' ? 'you' : 'hotel';
  // Provenance: auto-learned (consolidation) facts are labelled distinctly so
  // the model weights them as Staxis's own inference, below a manager's word.
  const by = r.source === 'consolidation'
    ? 'Staxis-auto'
    : r.source === 'operational'
      ? 'Staxis-observed'
      : r.createdByRole ? `role:${r.createdByRole}` : 'unknown';
  return (
    `<staxis-memory trust="system-derived-from-untrusted" scope="${scopeLabel}" topic="${attrEscape(r.topic)}" `
    + `by="${attrEscape(by)}" confidence="${attrEscape(r.confidence)}">`
    + `${escapeTrustMarkerContent(r.content)}</staxis-memory>`
  );
}

/**
 * Choose which rows make the cut, in the order they will be printed.
 *
 * Two passes over one budget:
 *   1. the highest-salience HUMAN-AUTHORED rows, up to MEMORY_SALIENT_FLOOR
 *   2. everything else, in rank order
 *
 * Then the winners are re-sorted into rank order for printing, so the prompt
 * still reads best-first regardless of which pass claimed a row.
 *
 * A row that does not fit the remaining characters is SKIPPED, not a stop
 * signal. The old loop broke on the first oversized entry, which meant one
 * 500-character fact could evict every shorter one behind it.
 */
export function selectMemoryForPrompt(rows: MemoryRow[], now: Date = new Date()): MemoryRow[] {
  const ranked = rankMemory(rows, now);
  const taken = new Set<string>();
  let chars = 0;

  const tryTake = (row: MemoryRow): void => {
    if (taken.has(row.id)) return;
    if (taken.size >= MAX_MEMORY_ENTRIES) return;
    const length = renderMemoryLine(row).length;
    // The first row always goes in, however long: an empty block would say
    // nothing at all about a hotel that has facts, which is worse than a block
    // that is one entry over budget.
    if (taken.size > 0 && chars + length > MEMORY_CHAR_BUDGET) return;
    taken.add(row.id);
    chars += length;
  };

  for (const row of ranked.filter(isHumanAuthoredMemory).slice(0, MEMORY_SALIENT_FLOOR)) {
    tryTake(row);
  }
  for (const row of ranked) tryTake(row);

  return ranked.filter((row) => taken.has(row.id));
}

/**
 * Format active memory rows into the injectable prompt block. Returns '' when
 * there is nothing to inject, so the prompt is byte-identical to today on an
 * empty hotel (the additive-only guarantee). Content is escaped with the same
 * helper that protects <tool-result>/<staxis-summary>, so a stored
 * '</staxis-memory>…' or imperative text can't break the marker or pose as an
 * instruction.
 */
export function formatMemoryForPrompt(rows: MemoryRow[], now: Date = new Date()): string {
  if (!rows.length) return '';
  const lines = selectMemoryForPrompt(rows, now).map(renderMemoryLine);
  if (!lines.length) return '';
  return [
    '─── What Staxis remembers about this hotel ───',
    '<staxis-memory-block trust="system-derived-from-untrusted">',
    ...lines,
    '</staxis-memory-block>',
  ].join('\n');
}

/**
 * Fetch + format this turn's memory for (property, account). Non-fatal: any
 * failure returns '' so a memory hiccup never breaks a conversation.
 */
export async function retrieveMemoryForTurn(
  propertyId: string,
  subjectAccountId: string | null,
): Promise<string> {
  try {
    const rows = await getActiveMemoryForTurn(propertyId, subjectAccountId);
    return formatMemoryForPrompt(rows);
  } catch {
    return '';
  }
}
