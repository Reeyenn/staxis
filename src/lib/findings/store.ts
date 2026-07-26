// ─── The findings ledger's database door ─────────────────────────────────────
//
// Every read and write goes through `scopedDb(propertyId)`, the same one-hotel
// accessor the AI layer uses (INV-25 … INV-30). The hotel filter is applied
// before the query builder is handed back, so nothing in this file — or in
// anything a later phase adds to it — can forget it.
//
// The one-row-per-problem guarantee is NOT in this file. It is the partial
// unique index `findings_one_active_per_problem_uq` in migration 0360. What
// this file does is handle the case where the database says "no" — a concurrent
// runner inserted the same problem a millisecond earlier — by turning the
// refused insert into the update it should have been. That is the difference
// between a guarantee and a convention.

import 'server-only';

import { scopedDb } from '@/lib/agent/scoped-db';
import { log } from '@/lib/log';
import { propertyLocalToday } from '@/lib/schedule/local-date';

import type {
  Finding,
  FindingDisposition,
  FindingDraft,
  FindingEvidence,
  FindingRunSummary,
  FindingSeverity,
  FindingStatus,
  JsonValue,
  PriceRange,
} from './types';
import { ACTIVE_STATUSES, isUsablePriceRange } from './types';
import type { ExistingFinding } from './silencer';

/** Postgres unique-violation. The shape differs slightly between the real
 *  client and the pglite test harness, so recognise both. */
function isUniqueViolation(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === '23505') return true;
  return /duplicate key value|unique constraint/i.test(error.message ?? '');
}

interface FindingRow {
  id: string;
  property_id: string;
  detector_id: string;
  dedupe_key: string;
  summary: string;
  severity: string;
  disposition: string;
  status: string;
  receipt_query_id: string;
  evidence: unknown;
  as_of: string | null;
  weakest_input_age_days: number | string | null;
  magnitude: number | string;
  price_low_cents: number | null;
  price_high_cents: number | null;
  price_currency: string;
  price_basis: string | null;
  first_seen_at: string;
  last_seen_at: string;
  occurrence_count: number;
  status_changed_at: string;
  resolved_at: string | null;
  silenced_at_magnitude: number | string | null;
  escalated_at: string | null;
  shown_count: number;
  acted_count: number;
  ignored_count: number;
  judged_disposition: string | null;
  judged_summary_en: string | null;
  judged_summary_es: string | null;
  judged_rationale: string | null;
  judged_rank: number | null;
  judged_source: string | null;
  judged_at: string | null;
  judged_model: string | null;
  judged_guard_rejected: boolean | null;
}

const SELECT_COLUMNS =
  'id, property_id, detector_id, dedupe_key, summary, severity, disposition, status, ' +
  'receipt_query_id, evidence, as_of, weakest_input_age_days, magnitude, ' +
  'price_low_cents, price_high_cents, price_currency, price_basis, ' +
  'first_seen_at, last_seen_at, occurrence_count, status_changed_at, resolved_at, ' +
  'silenced_at_magnitude, escalated_at, shown_count, acted_count, ignored_count, ' +
  // The judge's half (0361). Read alongside the detector's, never instead of
  // it — a queue view can prefer judged phrasing and still fall back to the
  // deterministic `summary` when the judge has not run or was refused.
  'judged_disposition, judged_summary_en, judged_summary_es, judged_rationale, ' +
  'judged_rank, judged_source, judged_at, judged_model, judged_guard_rejected';

function num(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(n) ? n : null;
}

export function rowToFinding(row: FindingRow): Finding {
  const low = row.price_low_cents;
  const high = row.price_high_cents;
  return {
    id: row.id,
    propertyId: row.property_id,
    detectorId: row.detector_id,
    dedupeKey: row.dedupe_key,
    summary: row.summary,
    severity: row.severity as FindingSeverity,
    disposition: row.disposition as FindingDisposition,
    status: row.status as FindingStatus,
    receiptQueryId: row.receipt_query_id,
    evidence: (row.evidence ?? {}) as FindingEvidence,
    asOf: row.as_of,
    weakestInputAgeDays: num(row.weakest_input_age_days),
    magnitude: num(row.magnitude) ?? 0,
    price:
      low !== null && high !== null
        ? { lowCents: low, highCents: high, currency: row.price_currency, basis: row.price_basis ?? '' }
        : null,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    occurrenceCount: row.occurrence_count,
    statusChangedAt: row.status_changed_at,
    resolvedAt: row.resolved_at,
    silencedAtMagnitude: num(row.silenced_at_magnitude),
    escalatedAt: row.escalated_at,
    shownCount: row.shown_count,
    actedCount: row.acted_count,
    ignoredCount: row.ignored_count,
    judgedDisposition: (row.judged_disposition as FindingDisposition | null) ?? null,
    judgedSummaryEn: row.judged_summary_en ?? null,
    judgedSummaryEs: row.judged_summary_es ?? null,
    judgedRationale: row.judged_rationale ?? null,
    judgedRank: num(row.judged_rank),
    judgedSource: (row.judged_source as 'model' | 'template' | null) ?? null,
    judgedAt: row.judged_at ?? null,
    judgedModel: row.judged_model ?? null,
    judgedGuardRejected: row.judged_guard_rejected === true,
  };
}

/** The price columns, or all-null. An unusable range is dropped, never rounded
 *  into a point estimate — the schema would refuse it anyway (0360). */
function priceColumns(price: PriceRange | null | undefined): Record<string, unknown> {
  if (!isUsablePriceRange(price)) {
    return { price_low_cents: null, price_high_cents: null, price_basis: null };
  }
  return {
    price_low_cents: price.lowCents,
    price_high_cents: price.highCents,
    price_currency: price.currency,
    price_basis: price.basis.slice(0, 300),
  };
}

// ─── Reads ───────────────────────────────────────────────────────────────────

/**
 * The current ACTIVE row for each of these problems, if any. Active means it
 * occupies the one-row-per-problem slot — including the silenced states, which
 * is exactly why a muted problem cannot quietly reappear as a new card.
 */
export async function loadActiveFindings(
  propertyId: string,
  dedupeKeys: readonly string[],
): Promise<Map<string, Finding>> {
  const out = new Map<string, Finding>();
  if (dedupeKeys.length === 0) return out;

  const { data, error } = await scopedDb(propertyId)
    .from('findings')
    .select(SELECT_COLUMNS)
    .in('dedupe_key', [...dedupeKeys])
    .in('status', [...ACTIVE_STATUSES]);

  if (error) throw new Error(`findings read failed: ${error.message}`);
  for (const row of (data ?? []) as unknown as FindingRow[]) {
    out.set(row.dedupe_key, rowToFinding(row));
  }
  return out;
}

/**
 * The statuses a card is still LIVE in. `known_problem` and `muted` still hold
 * the one-row-per-problem slot, but they are silences a manager armed and
 * neither the queue nor the badge asks again. Same set `listFindings` defaults
 * to and the same set /api/findings reads, deliberately.
 */
const LIVE_STATUSES: readonly FindingStatus[] = Object.freeze(['open', 'updated']);

export interface ListFindingsOptions {
  statuses?: readonly FindingStatus[];
  detectorId?: string;
  limit?: number;
  /**
   * Only rows whose status moved at or after this instant.
   *
   * Added for the morning brief's "cleared on its own" section, which asks a
   * question no other caller asks: not "what is wrong now" but "what stopped
   * being wrong since the watcher last looked". Without the time bound that
   * read would return every finding this hotel has ever retired, and a brief
   * would announce a February expiry as this morning's good news.
   */
  statusChangedSince?: Date;
}

/**
 * The read a later phase's queue view uses: what is wrong at this hotel, worst
 * first. Silenced rows are excluded unless explicitly asked for.
 */
export async function listFindings(
  propertyId: string,
  opts: ListFindingsOptions = {},
): Promise<Finding[]> {
  // Filters before transforms — `.order()` narrows the builder and `.eq()` is
  // no longer available after it.
  const filtered = scopedDb(propertyId)
    .from('findings')
    .select(SELECT_COLUMNS)
    .in('status', [...(opts.statuses ?? ['open', 'updated'])]);
  const byDetector = opts.detectorId ? filtered.eq('detector_id', opts.detectorId) : filtered;
  const scoped = opts.statusChangedSince
    ? byDetector.gte('status_changed_at', opts.statusChangedSince.toISOString())
    : byDetector;

  const { data, error } = await scoped
    .order('last_seen_at', { ascending: false })
    .limit(Math.min(Math.max(opts.limit ?? 100, 1), 500));
  if (error) throw new Error(`findings list failed: ${error.message}`);
  return ((data ?? []) as unknown as FindingRow[]).map(rowToFinding);
}

/**
 * How many "do this now" cards are waiting at this hotel — the number on the
 * Staxis nav pill, and nothing else.
 *
 * WHY THIS IS A COUNT AND NOT `listFindings().filter(...).length`
 * The badge is read on every shell mount and every time the tab comes back to
 * the front. Fetching up to 200 rows with their evidence blobs to end up
 * showing a single integer would be the most-run query in the app doing the
 * most work in the app. `head: true` means Postgres returns the count and no
 * rows at all.
 *
 * WHY TWO QUERIES AND NOT ONE `.or()`
 * The rule is `judged_disposition ?? disposition = 'propose'`, which as one
 * PostgREST filter needs `or(judged.eq.propose, and(judged.is.null,
 * disposition.eq.propose))` — a nested `and` inside an `or`. Two flat counts
 * express the same rule, each one index-friendly (0361 indexes
 * property_id, judged_disposition), and they partition cleanly: a row either
 * has a judged verdict or it does not, so nothing is counted twice and nothing
 * is missed.
 *
 * WHAT DOES NOT COUNT, on purpose: `recommend`, `fyi`, `ask` and `drop`
 * findings; anything the manager has already silenced or resolved
 * (known_problem / muted / resolved / expired all leave the open+updated set);
 * and any detector this hotel has demoted, because demotion rewrites the
 * disposition on the row itself.
 */
export async function countProposeFindings(propertyId: string): Promise<number> {
  const db = scopedDb(propertyId);
  const live = [...LIVE_STATUSES];

  // The judge reached a verdict on this hotel's actual numbers — it wins.
  const judged = await db
    .from('findings')
    .select('id', { count: 'exact', head: true })
    .in('status', live)
    .eq('judged_disposition', 'propose');
  if (judged.error) throw new Error(`findings badge count failed: ${judged.error.message}`);

  // No verdict yet (the judge has not run, or was refused): the detector's own
  // default stands, exactly as effectiveDisposition() resolves it.
  const unjudged = await db
    .from('findings')
    .select('id', { count: 'exact', head: true })
    .in('status', live)
    .is('judged_disposition', null)
    .eq('disposition', 'propose');
  if (unjudged.error) throw new Error(`findings badge count failed: ${unjudged.error.message}`);

  return (judged.count ?? 0) + (unjudged.count ?? 0);
}

/**
 * The hotel's IANA timezone, or null.
 *
 * Read through `scopedDb` like everything else here, so the one-hotel filter is
 * applied before the query builder is handed back. The morning brief is keyed
 * on the hotel's own calendar day, which makes this read part of the cache key
 * — a wrong answer here does not corrupt data, it just builds the brief on the
 * wrong clock, so it degrades to UTC rather than throwing.
 */
export async function propertyTimezone(propertyId: string): Promise<string | null> {
  const { data, error } = await scopedDb(propertyId)
    .from('properties')
    .select('timezone')
    .maybeSingle();
  if (error) {
    log.warn('[findings] timezone read failed; falling back to UTC', {
      propertyId,
      err: error.message,
    });
    return null;
  }
  return (data as { timezone?: string | null } | null)?.timezone ?? null;
}

/** The most recent run summary for a hotel — "we checked, and here is when". */
export async function latestRun(propertyId: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await scopedDb(propertyId)
    .from('finding_runs')
    .select('*')
    .order('run_at', { ascending: false })
    .limit(1);
  if (error) throw new Error(`finding_runs read failed: ${error.message}`);
  const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
  return rows[0] ?? null;
}

/** The slice of the last run the queue screen renders. */
export interface LatestRunFacts {
  runAt: string;
  detectorsChecked: number;
  detectorsSkipped: number;
  detectorsFailed: number;
}

/**
 * `latestRun` in the shape the screen needs, or null when this hotel has never
 * been checked. Deliberately returns null rather than a zeroed object: "we ran
 * and checked 0 things" and "we have never run here" are different claims, and
 * the second one must not be renderable as the first.
 */
export async function latestRunFacts(propertyId: string): Promise<LatestRunFacts | null> {
  const row = await latestRun(propertyId);
  if (!row) return null;
  const runAt = typeof row.run_at === 'string' ? row.run_at : null;
  if (!runAt) return null;
  return {
    runAt,
    detectorsChecked: num(row.detectors_checked as number | string | null) ?? 0,
    detectorsSkipped: num(row.detectors_skipped as number | string | null) ?? 0,
    detectorsFailed: num(row.detectors_failed as number | string | null) ?? 0,
  };
}

// ─── The judge's phrasing, read forward-compatibly ───────────────────────────

/**
 * Column names the AI judge may write its wording into. A sibling workstream
 * owns that migration; this file must work both before and after it lands.
 *
 * WHY A CANDIDATE LIST AND `select('*')` INSTEAD OF NAMING THE COLUMNS
 * Asking PostgREST for a column that does not exist makes the whole query
 * error. Every read path in this app that has done that turned into a silently
 * dead feature — three times in six weeks, most recently `accounts.name`. So
 * this read asks for everything the row has and picks whichever of these
 * exists. Before the judge ships, none exist, `judgedPhrasing` returns an empty
 * map, and every card falls back to the detector's own sentence — which is the
 * behaviour the screen is designed around anyway.
 */
const JUDGED_EN_COLUMNS = ['judged_summary_en', 'phrased_en', 'judged_en', 'summary_en'] as const;
const JUDGED_ES_COLUMNS = ['judged_summary_es', 'phrased_es', 'judged_es', 'summary_es'] as const;

export interface JudgedPhrasing {
  en: string | null;
  es: string | null;
}

function firstString(row: Record<string, unknown>, candidates: readonly string[]): string | null {
  for (const key of candidates) {
    const value = row[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

/**
 * The judge's wording for these findings, keyed by finding id. Empty when the
 * judge has not written any (or has not shipped). Never throws: a phrasing
 * upgrade that fails must not take the cards down with it.
 */
export async function judgedPhrasing(
  propertyId: string,
  findingIds: readonly string[],
): Promise<Map<string, JudgedPhrasing>> {
  const out = new Map<string, JudgedPhrasing>();
  if (findingIds.length === 0) return out;

  try {
    const { data, error } = await scopedDb(propertyId)
      .from('findings')
      .select('*')
      .in('id', [...findingIds]);
    if (error) {
      log.warn('[findings] judged-phrasing read failed; falling back to detector wording', {
        propertyId,
        err: error.message,
      });
      return out;
    }
    for (const row of (data ?? []) as unknown as Array<Record<string, unknown>>) {
      const id = typeof row.id === 'string' ? row.id : null;
      if (!id) continue;
      const en = firstString(row, JUDGED_EN_COLUMNS);
      const es = firstString(row, JUDGED_ES_COLUMNS);
      if (en || es) out.set(id, { en, es });
    }
  } catch (e) {
    log.warn('[findings] judged-phrasing read threw; falling back to detector wording', {
      propertyId,
      err: e instanceof Error ? e.message : String(e),
    });
  }
  return out;
}

// ─── Writes ──────────────────────────────────────────────────────────────────

export interface PersistArgs {
  propertyId: string;
  detectorId: string;
  dedupeKey: string;
  draft: FindingDraft;
  receiptQueryId: string;
  disposition: FindingDisposition;
  now: Date;
}

/** What actually happened, so the run summary can count it honestly. */
export type PersistOutcome = 'opened' | 'updated' | 'suppressed' | 'escalated';

/** The evidence half of a row. Deliberately excludes `disposition` and
 *  `status`: a silenced refresh must move the numbers without moving anything
 *  the manager decided. */
function draftColumns(args: PersistArgs): Record<string, unknown> {
  const { draft } = args;
  return {
    summary: draft.summary.slice(0, 500),
    severity: draft.severity,
    receipt_query_id: args.receiptQueryId,
    evidence: draft.evidence as unknown as JsonValue,
    as_of: draft.asOf ? draft.asOf.toISOString() : null,
    weakest_input_age_days: draft.weakestInputAgeDays ?? null,
    magnitude: draft.magnitude,
    ...priceColumns(draft.price),
  };
}

/**
 * Insert a brand-new finding. On a unique violation — another runner got there
 * first — fall back to refreshing the row that now exists, so a race produces
 * one correct card instead of one card and one swallowed error.
 */
export async function openFinding(args: PersistArgs): Promise<PersistOutcome> {
  const iso = args.now.toISOString();
  const { error } = await scopedDb(args.propertyId).from('findings').insert({
    detector_id: args.detectorId,
    dedupe_key: args.dedupeKey,
    status: 'open',
    disposition: args.disposition,
    first_seen_at: iso,
    last_seen_at: iso,
    status_changed_at: iso,
    occurrence_count: 1,
    ...draftColumns(args),
  });

  if (!error) return 'opened';
  if (!isUniqueViolation(error)) {
    throw new Error(`findings insert failed: ${error.message}`);
  }

  // Lost the race. Whatever is in the slot now is authoritative.
  const existing = await loadActiveFindings(args.propertyId, [args.dedupeKey]);
  const row = existing.get(args.dedupeKey);
  if (!row) {
    // The row was inserted and then moved out of the active set between our
    // insert and this read. Nothing sensible left to update; the next run
    // catches it.
    log.warn('[findings] insert raced and the winner vanished', {
      propertyId: args.propertyId,
      dedupeKey: args.dedupeKey,
    });
    return 'suppressed';
  }
  if (row.status === 'muted' || row.status === 'known_problem') {
    await touchSilenced(args, row.id);
    return 'suppressed';
  }
  return refreshFinding(args, row.id, 'updated');
}

/** Refresh a live card: new numbers, one more sighting, same row. */
export async function refreshFinding(
  args: PersistArgs,
  findingId: string,
  status: Extract<FindingStatus, 'open' | 'updated'>,
): Promise<PersistOutcome> {
  const iso = args.now.toISOString();
  const occurrence = await nextOccurrence(args.propertyId, findingId);
  const { data, error } = await scopedDb(args.propertyId)
    .from('findings')
    .update({
      ...draftColumns(args),
      disposition: args.disposition,
      status,
      last_seen_at: iso,
      occurrence_count: occurrence,
    })
    .eq('id', findingId)
    .select('id');
  if (error) throw new Error(`findings update failed: ${error.message}`);
  if (!data || (data as unknown[]).length === 0) {
    log.warn('[findings] refresh matched no row', { propertyId: args.propertyId, findingId });
  }
  return 'updated';
}

/**
 * A silenced problem was found again. The evidence still moves — a manager who
 * later un-silences it must see today's numbers, not the numbers from the night
 * they tapped "known problem" — but the status does not, and nothing surfaces.
 */
export async function touchSilenced(args: PersistArgs, findingId: string): Promise<PersistOutcome> {
  const occurrence = await nextOccurrence(args.propertyId, findingId);
  const { error } = await scopedDb(args.propertyId)
    .from('findings')
    .update({
      ...draftColumns(args),
      // `status` and `disposition` are deliberately absent: the silence and the
      // verdict are the manager's, not ours to refresh.
      last_seen_at: args.now.toISOString(),
      occurrence_count: occurrence,
    })
    .eq('id', findingId);
  if (error) throw new Error(`findings silenced-refresh failed: ${error.message}`);
  return 'suppressed';
}

/**
 * The problem outgrew the silence the manager armed. Same row — this is still
 * one problem — but it is live again, and the moment is recorded.
 */
export async function escalateFinding(args: PersistArgs, findingId: string): Promise<PersistOutcome> {
  const iso = args.now.toISOString();
  const occurrence = await nextOccurrence(args.propertyId, findingId);
  const { error } = await scopedDb(args.propertyId)
    .from('findings')
    .update({
      ...draftColumns(args),
      disposition: args.disposition,
      status: 'updated',
      escalated_at: iso,
      status_changed_at: iso,
      last_seen_at: iso,
      occurrence_count: occurrence,
    })
    .eq('id', findingId);
  if (error) throw new Error(`findings escalate failed: ${error.message}`);
  return 'escalated';
}

/** Read-then-write increment. Postgres has no bare `col + 1` through PostgREST,
 *  and a lost increment costs an occurrence count, not correctness. */
async function nextOccurrence(propertyId: string, findingId: string): Promise<number> {
  const { data } = await scopedDb(propertyId)
    .from('findings')
    .select('occurrence_count')
    .eq('id', findingId)
    .limit(1);
  const rows = (data ?? []) as unknown as Array<{ occurrence_count: number }>;
  return (rows[0]?.occurrence_count ?? 0) + 1;
}

/**
 * Close out live findings this detector stopped producing. The problem went
 * away; the card should not outlive it. Silenced rows are left alone — a
 * silence the manager armed is not ours to expire.
 */
export async function expireStaleFindings(
  propertyId: string,
  detectorId: string,
  staleAfterDays: number,
  now: Date,
): Promise<number> {
  const cutoff = new Date(now.getTime() - staleAfterDays * 86_400_000).toISOString();
  const { data, error } = await scopedDb(propertyId)
    .from('findings')
    .update({ status: 'expired', status_changed_at: now.toISOString() })
    .eq('detector_id', detectorId)
    .in('status', ['open', 'updated'])
    .lt('last_seen_at', cutoff)
    .select('id');
  if (error) throw new Error(`findings expiry failed: ${error.message}`);
  return ((data ?? []) as unknown[]).length;
}

// ─── Engagement: the evidence self-demotion runs on ─────────────────────────
//
// `shown_count`, `acted_count` and `ignored_count` were laid down as scaffold in
// 0360 and nothing has ever written them. These two functions are the writers,
// and between them they define what those words MEAN — which matters, because a
// detector rests on this arithmetic.
//
//   shown   one per hotel-DAY a card was actually on the manager's screen.
//           Not one per page load: a manager who refreshes eleven times has
//           looked once, and counting eleven would let one anxious morning rest
//           a detector for good. `last_shown_on` (0362) is that guard.
//   acted   Known problem, Fixed, or the receipt opened. Any of the three is a
//           manager engaging with the card, and one of them is enough to keep a
//           detector at full volume.
//   ignored a show on a card nothing has ever been done about. It is kept as
//           its own column rather than derived, so "shown a lot and read" and
//           "shown a lot and never once opened" are different rows instead of a
//           subtraction every reader has to remember to do.

/** The hotel's own calendar day. "Already shown today?" is a calendar question. */
async function propertyToday(propertyId: string, now: Date): Promise<string> {
  return propertyLocalToday(now, await propertyTimezone(propertyId));
}

/**
 * Count these findings as SHOWN, at most once per hotel-day each.
 *
 * Returns how many rows it actually moved. Never throws: telemetry that can
 * break the screen it measures is worse than no telemetry, and the only cost of
 * a lost increment is that a detector earns its rest a day later.
 */
export async function recordFindingsShown(
  propertyId: string,
  findingIds: readonly string[],
  now: Date = new Date(),
): Promise<number> {
  if (findingIds.length === 0) return 0;
  try {
    const today = await propertyToday(propertyId, now);
    const db = scopedDb(propertyId);
    const { data, error } = await db
      .from('findings')
      .select('id, shown_count, acted_count, ignored_count, last_shown_on')
      .in('id', [...findingIds])
      .limit(200);
    if (error) throw new Error(error.message);

    const rows = (data ?? []) as unknown as Array<{
      id: string;
      shown_count: number | string;
      acted_count: number | string;
      ignored_count: number | string;
      last_shown_on: string | null;
    }>;

    let moved = 0;
    for (const row of rows) {
      if ((row.last_shown_on ?? '').slice(0, 10) === today) continue;
      const acted = num(row.acted_count) ?? 0;
      const ignored = num(row.ignored_count) ?? 0;
      const { error: writeError } = await db
        .from('findings')
        .update({
          shown_count: (num(row.shown_count) ?? 0) + 1,
          // A card that has ever been engaged with is never "ignored" again,
          // however long it sits — the manager already told us it was worth
          // reading.
          ignored_count: acted > 0 ? ignored : ignored + 1,
          last_shown_on: today,
        })
        .eq('id', row.id);
      if (!writeError) moved += 1;
    }
    return moved;
  } catch (e) {
    log.warn('[findings] shown-count write failed; demotion evidence is a day thinner', {
      propertyId,
      err: e instanceof Error ? e.message : String(e),
    });
    return 0;
  }
}

/**
 * Count one finding as ACTED ON. Known problem, Fixed, or receipt opened.
 *
 * Every call counts, including a second tap on the same card: engagement is
 * evidence that a manager is reading this detector's output, and there is no
 * reason to cap how much of that evidence we will accept.
 */
export async function recordFindingActed(propertyId: string, findingId: string): Promise<boolean> {
  try {
    const db = scopedDb(propertyId);
    const { data, error } = await db
      .from('findings')
      .select('id, acted_count')
      .eq('id', findingId)
      .limit(1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as unknown as Array<{ id: string; acted_count: number | string }>;
    if (rows.length === 0) return false;

    const { error: writeError } = await db
      .from('findings')
      .update({ acted_count: (num(rows[0].acted_count) ?? 0) + 1 })
      .eq('id', findingId);
    if (writeError) throw new Error(writeError.message);
    return true;
  } catch (e) {
    log.warn('[findings] acted-count write failed; demotion evidence is thinner', {
      propertyId,
      err: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

/**
 * A manager's verdict. Moving to `known_problem` ALWAYS records the magnitude
 * they consented to — escalation is measured from there, and a silence with no
 * recorded consent point can never break out of itself (see silencer.ts).
 */
export async function setFindingStatus(
  propertyId: string,
  findingId: string,
  status: FindingStatus,
  accountId: string | null,
  now: Date = new Date(),
): Promise<Finding | null> {
  const iso = now.toISOString();
  const patch: Record<string, unknown> = {
    status,
    status_changed_at: iso,
    status_changed_by: accountId,
    resolved_at: status === 'resolved' ? iso : null,
  };

  if (status === 'known_problem') {
    const current = await scopedDb(propertyId)
      .from('findings')
      .select('magnitude')
      .eq('id', findingId)
      .limit(1);
    const rows = (current.data ?? []) as unknown as Array<{ magnitude: number | string }>;
    patch.silenced_at_magnitude = num(rows[0]?.magnitude ?? null) ?? 0;
  }

  const { data, error } = await scopedDb(propertyId)
    .from('findings')
    .update(patch)
    .eq('id', findingId)
    .select(SELECT_COLUMNS);
  if (error) throw new Error(`findings status change failed: ${error.message}`);
  const rows = (data ?? []) as unknown as FindingRow[];
  return rows[0] ? rowToFinding(rows[0]) : null;
}

/** The liveness artifact: we ran, here is what we checked and what we did. */
export async function recordRun(summary: FindingRunSummary, now: Date): Promise<void> {
  const { error } = await scopedDb(summary.propertyId).from('finding_runs').insert({
    run_at: now.toISOString(),
    run_date: summary.runDate,
    detectors_registered: summary.detectorsRegistered,
    detectors_checked: summary.detectorsChecked,
    detectors_skipped: summary.detectorsSkipped,
    detectors_failed: summary.detectorsFailed,
    // Resting, not starved (0362). "3 checks could not run for want of data"
    // and "3 checks this hotel ignores are asleep" describe different systems,
    // and folding the second into the first would make a working one look
    // broken.
    detectors_dormant: summary.detectorsDormant,
    findings_opened: summary.findingsOpened,
    findings_updated: summary.findingsUpdated,
    findings_suppressed: summary.findingsSuppressed,
    findings_escalated: summary.findingsEscalated,
    findings_expired: summary.findingsExpired,
    duration_ms: summary.durationMs,
    errors: summary.errors as unknown as JsonValue,
    // The judge's outcome belongs on the SAME row as the detector counts. Two
    // rows, or a judge row written separately, would let one land without the
    // other — and then "we checked and judged nothing" is indistinguishable
    // from "we judged and the write failed", which is the exact ambiguity
    // finding_runs exists to remove.
    judge_mode: summary.judge.mode,
    judge_findings: summary.judge.findings,
    judge_cost_usd: summary.judge.costUsd,
    judge_guard_rejections: summary.judge.guardRejections,
  });
  if (error) throw new Error(`finding_runs insert failed: ${error.message}`);
}

/** The slice the silencer needs, from a stored row. */
export function toExisting(finding: Finding): ExistingFinding {
  return {
    status: finding.status,
    magnitude: finding.magnitude,
    summary: finding.summary,
    silencedAtMagnitude: finding.silencedAtMagnitude,
  };
}
