// ═══════════════════════════════════════════════════════════════════════════
// The companion's life record.
//
// Until this file existed, the companion had no memory of its own existence.
// It could tell you what the hotel looked like, what it had been told, and who
// it was talking to, and it could not answer "what have you been doing?" —
// because nothing anywhere recorded that it had done anything. A decision was
// a row in `agent_decisions` only when a human tapped a card; a thing it said
// out loud lived in the thread but nowhere the hotel's own timeline could see
// it; a belief it changed overnight left a counter and no sentence.
//
// ─── WHERE THE ROWS LIVE, AND WHY THERE IS NO NEW TABLE ────────────────────
//
// `activity_log` (migration 0228). It is already the hotel's append-only
// "everything that happened" stream: `actor_account_id` is nullable and
// documented for system actors, `event_type` is free text so a new source
// needs no schema change, `description` is a PRE-RENDERED plain-English
// sentence, `metadata` is jsonb for the forensic half, the index is
// (property_id, occurred_at), and the table is exempt from every retention
// purge. Migration 0456 adds ONE value to its `source` CHECK — 'staxis_agent'
// — and that is the entire schema cost of the feature.
//
// A second timeline would have been a second thing to secure, index,
// purge-exempt and keep in sync, for a distinction the person asking does not
// make: "what happened at my hotel today" does not separate what a person did
// from what the companion did.
//
// ─── THIS IS THE ONLY APPLICATION-CODE WRITER OF activity_log ──────────────
//
// Every other row in that table is written by a trigger, atomically with the
// insert it mirrors, which is why the table has never needed an app-side
// writer and why it must not grow a second one. An agent decision is not an
// INSERT on some other table, so a trigger cannot see it; that is the whole
// and only reason this module exists. Anything else that wants to write
// activity_log should attach a trigger, per 0228's own extensibility note.
//
// ─── FAIL-SOFT, IN THE EXACT SHAPE decisions.ts USES ───────────────────────
//
// Every function here swallows its own errors and logs. The trade is
// deliberate and stated: a journal write must NEVER break the thing it is
// journaling. We would rather lose the record of a to-do being created than
// lose the to-do. This is the same bargain the decision corpus struck, and it
// is written the same way on purpose — two fail-soft writers that looked
// different would invite somebody to "fix" one of them into a throw.
//
// ─── WHAT GOES IN, AND WHAT DELIBERATELY DOES NOT ──────────────────────────
//
// IN:  decisions            something the companion did that changed the hotel
//      belief changes       something it now believes that it did not before
//      things said          a sentence it put in front of a person unprompted
//
// OUT: mechanical work.     There is no "translated a message", no "read the
//      room list", no "assembled the prompt". A log of everything is a log of
//      nothing: the read that consumes this stream has a token budget and a
//      manager reading the timeline has an attention budget, and both are
//      spent by rows that carry no decision. If a line would not survive the
//      question "would a person care that this happened?", it is not journaled.
//
// ─── THE COPY RULES ARE ENFORCED HERE, NOT REMEMBERED ──────────────────────
//
// `description` is rendered to managers on the Activity Log page AND fed into
// the companion's own prompt, so it obeys the product's copy rules: plain
// English, no em dashes (founder ruling 2026-07-28), and never the word "AI"
// (the product does not call itself that in front of a person). The producers
// below are pure and exported so the copy tests can walk them and read their
// output rather than grepping this file for a dash. `journalText` scrubs
// anyway, because half of what flows through here is a hotel's own task title
// and a person may type whatever they like into one.
// ═══════════════════════════════════════════════════════════════════════════

import { scopedDb } from '@/lib/agent/scoped-db';

/**
 * The `source` value migration 0456 added. Filtering on it is what makes
 * "what did YOU do today" answerable, which is why the companion did not
 * simply reuse 'system' (the catch-all a trigger writes when nothing fits).
 */
export const AGENT_JOURNAL_SOURCE = 'staxis_agent';

/**
 * `activity_log.event_category` is a CHECKed domain and the companion's acts
 * are not housekeeping, maintenance, staff, messages, inventory or front desk.
 * 'system' is the honest bucket, and the `source` column is what separates the
 * companion's rows from a trigger's inside it.
 */
export const AGENT_JOURNAL_CATEGORY = 'system';

/** The name shown beside the row on the Activity Log page. */
export const AGENT_JOURNAL_ACTOR_NAME = 'Staxis';

/**
 * What kind of entry this is. Free text in the column; a closed union here so
 * a reader can filter on a value the writer actually writes.
 *
 * Three families, and they are the three things worth recording:
 *   decisions       agent_acted, agent_action_* — it did, or was told to do
 *   belief changes  agent_learned
 *   things said     agent_said, agent_briefed
 */
export type AgentJournalEventType =
  /** A tool that changed something ran without a card in front of it. */
  | 'agent_acted'
  /** It asked first, and a person said yes. */
  | 'agent_action_approved'
  /** It asked first, a person changed the details, and then said yes. */
  | 'agent_action_edited'
  /** It asked first, and a person said no. */
  | 'agent_action_declined'
  /** It asked first, nobody answered, and the question timed out. */
  | 'agent_action_expired'
  /** It went over the day and what it remembers changed. */
  | 'agent_learned'
  /** It said something to a person before they said anything. */
  | 'agent_said'
  /** It wrote the morning brief. */
  | 'agent_briefed';

/** Every event type, for readers that want the whole stream by name. */
export const AGENT_JOURNAL_EVENT_TYPES: readonly AgentJournalEventType[] = [
  'agent_acted',
  'agent_action_approved',
  'agent_action_edited',
  'agent_action_declined',
  'agent_action_expired',
  'agent_learned',
  'agent_said',
  'agent_briefed',
];

/** Longest sentence a journal row may carry. Bounded because it is read into
 *  a prompt with a token budget and rendered into a list on a page. */
export const JOURNAL_DESCRIPTION_MAX = 300;

/**
 * Normalize a sentence on its way into the record.
 *
 * Collapses whitespace, replaces em and en dashes with a comma (the founder's
 * ruling, applied to text this module does not author: a task title typed by a
 * person can contain anything), tidies the punctuation that substitution can
 * leave behind, and caps the length.
 *
 * The dash scrub is BELT AND BRACES, not the primary control. The producers
 * below write dash-free copy and a test walks them to prove it; this exists for
 * the interpolated halves that no test can own.
 */
export function journalText(raw: string): string {
  return raw
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .replace(/,\s*,/g, ',')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/,\s*\./g, '.')
    .trim()
    .slice(0, JOURNAL_DESCRIPTION_MAX);
}

// ═══════════════════════════════════════════════════════════════════════════
// The sentences
// ═══════════════════════════════════════════════════════════════════════════
//
// PURE, and exported for that reason. Every line the companion writes about
// itself is produced by one of these, so the copy rules can be tested by
// calling them and reading the answer instead of grepping source for a dash.
//
// Written in the third person with "Staxis" as the subject, to match the
// sentences the 0228 triggers already produce ("Maria started cleaning room
// 305"). The same rows are read back into the companion's own prompt, where
// the block header says whose acts they are, so nothing is lost by not writing
// them as "I".

/** Something it did that changed the hotel, with no card in front of it. */
export function journalActedLine(input: { summary: string; ok: boolean }): string {
  return journalText(
    input.ok
      ? `Staxis did this: ${input.summary}.`
      : `Staxis tried this and it did not go through: ${input.summary}.`,
  );
}

/** The four ways an approval card can end. */
export function journalResolutionLine(input: {
  summary: string;
  outcome: 'approved' | 'edited' | 'declined' | 'failed';
}): string {
  const s = input.summary;
  switch (input.outcome) {
    case 'approved':
      return journalText(`Staxis asked first, got a yes, and did it: ${s}.`);
    case 'edited':
      return journalText(`Staxis asked first, the details were changed, and then it did it: ${s}.`);
    case 'declined':
      return journalText(`Staxis asked first and was told no, so nothing changed: ${s}.`);
    case 'failed':
      return journalText(`Staxis asked first, got a yes, and it did not go through: ${s}.`);
  }
}

/**
 * A question that timed out unanswered.
 *
 * "Never heard back" and not "was ignored". Silence is not a verdict, and the
 * whole point of recording this is that the companion may gently ask once more
 * later, which it has no business doing if it decided the person meant no.
 */
export function journalExpiredLine(input: { summary: string }): string {
  return journalText(
    `Staxis asked about this and never heard back, so nothing changed: ${input.summary}.`,
  );
}

/** Its beliefs about the hotel changed. Only written when they actually did. */
export function journalLearnedLine(input: {
  learned: number;
  updated: number;
  recap: string | null;
}): string {
  const parts: string[] = [];
  if (input.learned > 0) {
    parts.push(`learned ${input.learned} new thing${input.learned === 1 ? '' : 's'}`);
  }
  if (input.updated > 0) {
    parts.push(`refreshed ${input.updated} thing${input.updated === 1 ? '' : 's'} it already knew`);
  }
  // The zero case is never written by a call site (a run that changed nothing
  // is not a belief change), but the function must still produce a true
  // sentence when somebody calls it with one.
  const what = parts.length > 0 ? parts.join(' and ') : 'updated what it remembers';
  const recap = input.recap ? ` ${journalText(input.recap)}` : '';
  return journalText(`Staxis went over the day and ${what}.${recap}`);
}

/**
 * Something it said to a person before they said anything.
 *
 * The sentence is quoted verbatim rather than summarized, because the point of
 * the record is that a person can go back and read what was actually said to
 * them. Naming the person is optional and absent rather than guessed.
 */
export function journalSaidLine(input: { text: string; personName: string | null }): string {
  const said = journalText(input.text);
  return journalText(
    input.personName
      ? `Staxis said this to ${input.personName}: ${said}`
      : `Staxis said this: ${said}`,
  );
}

/** The morning brief was produced. */
export function journalBriefedLine(input: { lines: number }): string {
  return journalText(
    input.lines === 1
      ? 'Staxis wrote the morning brief, one line long.'
      : `Staxis wrote the morning brief, ${input.lines} lines long.`,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// The write
// ═══════════════════════════════════════════════════════════════════════════

export interface AgentJournalEntry {
  propertyId: string;
  eventType: AgentJournalEventType;
  /** Already produced by one of the pure builders above. */
  description: string;
  /**
   * The PERSON in the loop, when there was one, not the companion.
   *
   * `activity_log.actor_account_id` is nullable and documented for system
   * actors, and the companion is one. It is filled in only for an entry a
   * person actually caused (they approved the card, they were spoken to), so
   * the by-actor filter on the Activity Log page keeps meaning what it says.
   */
  actorAccountId?: string | null;
  actorRole?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  targetLabel?: string | null;
  metadata?: Record<string, unknown>;
  /** Defaults to now. Passed in only where the event has its own instant. */
  occurredAt?: Date;
}

/**
 * Write one line of the companion's life record.
 *
 * NEVER THROWS, NEVER REJECTS. See the module header: the action being
 * journaled is worth more than the journal. A failure is logged and swallowed,
 * and the caller is not told, because there is nothing a caller could usefully
 * do about it that would not be worse than carrying on.
 */
export async function recordAgentJournalEntry(entry: AgentJournalEntry): Promise<void> {
  try {
    const description = journalText(entry.description);
    if (!description) return;
    const { error } = await scopedDb(entry.propertyId)
      .from('activity_log')
      .insert({
        occurred_at: (entry.occurredAt ?? new Date()).toISOString(),
        event_category: AGENT_JOURNAL_CATEGORY,
        event_type: entry.eventType,
        actor_account_id: entry.actorAccountId ?? null,
        actor_name: AGENT_JOURNAL_ACTOR_NAME,
        actor_role: entry.actorRole ?? null,
        target_type: entry.targetType ?? null,
        target_id: entry.targetId ?? null,
        target_label: entry.targetLabel ?? null,
        description,
        source: AGENT_JOURNAL_SOURCE,
        metadata: entry.metadata ?? {},
      });
    if (error) console.warn('[agent/journal] write failed', error.message);
  } catch (err) {
    console.warn('[agent/journal] write threw', err);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// The read
// ═══════════════════════════════════════════════════════════════════════════

export interface AgentJournalRow {
  occurredAt: string;
  eventType: string;
  description: string;
  metadata: Record<string, unknown>;
}

/** How many rows a single read may return. The stream is one hotel-day wide
 *  at the call sites, and a hotel that produced more than this in a day has a
 *  bug worth noticing rather than a prompt worth filling. */
export const JOURNAL_READ_CAP = 40;

/**
 * Read the companion's own rows for one hotel, newest first.
 *
 * FAILS SOFT TO AN EMPTY LIST, which the callers must treat as "nothing to
 * say" and not as "nothing happened" — see the silence rule in awareness.ts.
 * The two are the same rendering here (nothing), and that is the point.
 */
export async function readAgentJournal(
  propertyId: string,
  opts: {
    sinceIso: string;
    untilIso?: string;
    limit?: number;
    eventTypes?: readonly AgentJournalEventType[];
  },
): Promise<AgentJournalRow[]> {
  try {
    let query = scopedDb(propertyId)
      .from('activity_log')
      .select('occurred_at, event_type, description, metadata')
      .eq('source', AGENT_JOURNAL_SOURCE)
      .gte('occurred_at', opts.sinceIso)
      .order('occurred_at', { ascending: false })
      .limit(Math.min(opts.limit ?? JOURNAL_READ_CAP, JOURNAL_READ_CAP));
    if (opts.untilIso) query = query.lt('occurred_at', opts.untilIso);
    if (opts.eventTypes && opts.eventTypes.length > 0) {
      query = query.in('event_type', opts.eventTypes as string[]);
    }
    const { data, error } = await query;
    if (error) {
      console.warn('[agent/journal] read failed', error.message);
      return [];
    }
    return (data ?? []).map((raw) => {
      const row = raw as Record<string, unknown>;
      const metadata = row.metadata;
      return {
        occurredAt: typeof row.occurred_at === 'string' ? row.occurred_at : '',
        eventType: typeof row.event_type === 'string' ? row.event_type : '',
        description: typeof row.description === 'string' ? row.description : '',
        metadata: metadata && typeof metadata === 'object' && !Array.isArray(metadata)
          ? (metadata as Record<string, unknown>)
          : {},
      };
    }).filter((row) => row.occurredAt !== '' && row.description !== '');
  } catch (err) {
    console.warn('[agent/journal] read threw', err);
    return [];
  }
}
