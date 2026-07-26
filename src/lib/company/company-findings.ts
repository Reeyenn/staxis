import 'server-only';

// ─── The company findings ledger's database door ─────────────────────────────
//
// The org-scope twin of src/lib/findings/store.ts. Every query below filters
// `organization_id`, and that filter IS the tenant boundary — `company_findings`
// is deny-all RLS (0367), so there is no policy underneath to catch a miss.
//
// WHY supabaseAdmin + AN EXPLICIT FILTER RATHER THAN A `scopedCompanyDb`
// The hotel ledger routes through `scopedDb(propertyId)` because it shares that
// accessor with the whole AI layer, where dozens of call sites needed one place
// to be right. The company side already has an established pattern — authority.ts
// and rulebook.ts both take `organizationId` as their first argument and filter
// explicitly — and it is the pattern the reviewer of a company file will expect
// to see. A second scoping abstraction used by one file would be a second place
// for the boundary to live, which is the opposite of the point.
//
// The organization id is NEVER taken from a request body. It is resolved from
// the caller's own hats, or from `companyForProperty(propertyId)` — see
// src/lib/company/vp-queue-server.ts.

import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';
import type {
  Finding,
  FindingDisposition,
  FindingDraft,
  FindingEvidence,
  FindingSeverity,
  FindingStatus,
  JsonValue,
  PriceRange,
} from '@/lib/findings/types';
import { ACTIVE_STATUSES, isUsablePriceRange } from '@/lib/findings/types';

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A company finding, in the SAME shape the hotel ledger returns.
 *
 * `propertyId` is deliberately carried as `null` rather than omitted: the card
 * renderer, the ranking function and the brief all take `QueueFinding`, and a
 * second nearly-identical type would be a second place for the two halves of
 * one screen to drift apart. Null means "this is about the company", which is a
 * real answer and the one thing the hotel side can never say.
 */
export interface CompanyFinding extends Omit<Finding, 'propertyId'> {
  propertyId: null;
  organizationId: string;
}

interface CompanyFindingRow {
  id: string;
  organization_id: string;
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
}

const SELECT_COLUMNS =
  'id, organization_id, detector_id, dedupe_key, summary, severity, disposition, status, ' +
  'receipt_query_id, evidence, as_of, weakest_input_age_days, magnitude, ' +
  'price_low_cents, price_high_cents, price_currency, price_basis, ' +
  'first_seen_at, last_seen_at, occurrence_count, status_changed_at, resolved_at, ' +
  'silenced_at_magnitude, escalated_at';

function num(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(n) ? n : null;
}

function rowToCompanyFinding(row: CompanyFindingRow): CompanyFinding {
  const low = row.price_low_cents;
  const high = row.price_high_cents;
  return {
    id: row.id,
    propertyId: null,
    organizationId: row.organization_id,
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
    // Company findings carry no demotion counters and no judge columns —
    // 0367 has neither, on purpose (see the migration header). Reported as the
    // honest zeros/nulls so `QueueFinding` projection is total.
    shownCount: 0,
    actedCount: 0,
    ignoredCount: 0,
    judgedDisposition: null,
    judgedSummaryEn: null,
    judgedSummaryEs: null,
    judgedRationale: null,
    judgedRank: null,
    judgedSource: null,
    judgedAt: null,
    judgedModel: null,
    judgedGuardRejected: false,
  };
}

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

/** The statuses a company card is still LIVE in. Same set as the hotel side. */
const LIVE_STATUSES: readonly FindingStatus[] = Object.freeze(['open', 'updated']);

export interface ListCompanyFindingsOptions {
  statuses?: readonly FindingStatus[];
  limit?: number;
}

/** What is wrong across this company right now. Silenced rows excluded unless asked for. */
export async function listCompanyFindings(
  organizationId: string,
  opts: ListCompanyFindingsOptions = {},
): Promise<CompanyFinding[]> {
  if (!UUID_RX.test(organizationId ?? '')) return [];
  const { data, error } = await supabaseAdmin
    .from('company_findings')
    .select(SELECT_COLUMNS)
    .eq('organization_id', organizationId)
    .in('status', [...(opts.statuses ?? LIVE_STATUSES)])
    .order('last_seen_at', { ascending: false })
    .limit(Math.min(Math.max(opts.limit ?? 100, 1), 500));
  if (error) throw new Error(`company findings list failed: ${error.message}`);
  return ((data ?? []) as unknown as CompanyFindingRow[]).map(rowToCompanyFinding);
}

/** The active row for each of these problems, if any. Includes silenced rows —
 *  that is what stops a muted portfolio problem reappearing as a fresh card. */
export async function loadActiveCompanyFindings(
  organizationId: string,
  dedupeKeys: readonly string[],
): Promise<Map<string, CompanyFinding>> {
  const out = new Map<string, CompanyFinding>();
  if (!UUID_RX.test(organizationId ?? '') || dedupeKeys.length === 0) return out;
  const { data, error } = await supabaseAdmin
    .from('company_findings')
    .select(SELECT_COLUMNS)
    .eq('organization_id', organizationId)
    .in('dedupe_key', [...dedupeKeys])
    .in('status', [...ACTIVE_STATUSES]);
  if (error) throw new Error(`company findings read failed: ${error.message}`);
  for (const row of (data ?? []) as unknown as CompanyFindingRow[]) {
    out.set(row.dedupe_key, rowToCompanyFinding(row));
  }
  return out;
}

// ─── Writes ──────────────────────────────────────────────────────────────────

export interface PersistCompanyArgs {
  organizationId: string;
  detectorId: string;
  dedupeKey: string;
  draft: FindingDraft;
  receiptQueryId: string;
  disposition: FindingDisposition;
  now: Date;
}

export type CompanyPersistOutcome = 'opened' | 'updated' | 'suppressed' | 'escalated';

function draftColumns(args: PersistCompanyArgs): Record<string, unknown> {
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

function isUniqueViolation(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === '23505') return true;
  return /duplicate key value|unique constraint/i.test(error.message ?? '');
}

/**
 * Insert a brand-new company finding. On a unique violation — two VPs loading
 * the portfolio queue in the same second — fall back to refreshing the row that
 * now exists, so a race produces one correct card rather than one card and one
 * swallowed error.
 */
export async function openCompanyFinding(args: PersistCompanyArgs): Promise<CompanyPersistOutcome> {
  const iso = args.now.toISOString();
  const { error } = await supabaseAdmin.from('company_findings').insert({
    organization_id: args.organizationId,
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
    throw new Error(`company findings insert failed: ${error.message}`);
  }

  const existing = await loadActiveCompanyFindings(args.organizationId, [args.dedupeKey]);
  const row = existing.get(args.dedupeKey);
  if (!row) {
    log.warn('[company-findings] insert raced and the winner vanished', {
      organizationId: args.organizationId,
      dedupeKey: args.dedupeKey,
    });
    return 'suppressed';
  }
  if (row.status === 'muted' || row.status === 'known_problem') {
    await touchSilencedCompanyFinding(args, row.id);
    return 'suppressed';
  }
  return refreshCompanyFinding(args, row.id, 'updated');
}

/** Refresh a live card: new numbers, one more sighting, same row. */
export async function refreshCompanyFinding(
  args: PersistCompanyArgs,
  findingId: string,
  status: Extract<FindingStatus, 'open' | 'updated'>,
): Promise<CompanyPersistOutcome> {
  const occurrence = await nextOccurrence(args.organizationId, findingId);
  const { error } = await supabaseAdmin
    .from('company_findings')
    .update({
      ...draftColumns(args),
      disposition: args.disposition,
      status,
      last_seen_at: args.now.toISOString(),
      occurrence_count: occurrence,
    })
    .eq('organization_id', args.organizationId)
    .eq('id', findingId);
  if (error) throw new Error(`company findings update failed: ${error.message}`);
  return 'updated';
}

/**
 * A silenced portfolio problem was found again. The evidence moves; the silence
 * does not. `status` and `disposition` are deliberately absent from the patch —
 * they are the VP's, not ours to refresh.
 */
export async function touchSilencedCompanyFinding(
  args: PersistCompanyArgs,
  findingId: string,
): Promise<CompanyPersistOutcome> {
  const occurrence = await nextOccurrence(args.organizationId, findingId);
  const { error } = await supabaseAdmin
    .from('company_findings')
    .update({
      ...draftColumns(args),
      last_seen_at: args.now.toISOString(),
      occurrence_count: occurrence,
    })
    .eq('organization_id', args.organizationId)
    .eq('id', findingId);
  if (error) throw new Error(`company findings silenced-refresh failed: ${error.message}`);
  return 'suppressed';
}

/** The problem outgrew the silence the VP armed. Same row, live again, recorded. */
export async function escalateCompanyFinding(
  args: PersistCompanyArgs,
  findingId: string,
): Promise<CompanyPersistOutcome> {
  const iso = args.now.toISOString();
  const occurrence = await nextOccurrence(args.organizationId, findingId);
  const { error } = await supabaseAdmin
    .from('company_findings')
    .update({
      ...draftColumns(args),
      disposition: args.disposition,
      status: 'updated',
      escalated_at: iso,
      status_changed_at: iso,
      last_seen_at: iso,
      occurrence_count: occurrence,
    })
    .eq('organization_id', args.organizationId)
    .eq('id', findingId);
  if (error) throw new Error(`company findings escalate failed: ${error.message}`);
  return 'escalated';
}

async function nextOccurrence(organizationId: string, findingId: string): Promise<number> {
  const { data } = await supabaseAdmin
    .from('company_findings')
    .select('occurrence_count')
    .eq('organization_id', organizationId)
    .eq('id', findingId)
    .limit(1);
  const rows = (data ?? []) as unknown as Array<{ occurrence_count: number }>;
  return (rows[0]?.occurrence_count ?? 0) + 1;
}

/** Close out live company findings this check stopped producing. Silenced rows
 *  are left alone — a silence the VP armed is not ours to expire. */
export async function expireStaleCompanyFindings(
  organizationId: string,
  detectorId: string,
  staleAfterDays: number,
  now: Date,
): Promise<number> {
  const cutoff = new Date(now.getTime() - staleAfterDays * 86_400_000).toISOString();
  const { data, error } = await supabaseAdmin
    .from('company_findings')
    .update({ status: 'expired', status_changed_at: now.toISOString() })
    .eq('organization_id', organizationId)
    .eq('detector_id', detectorId)
    .in('status', ['open', 'updated'])
    .lt('last_seen_at', cutoff)
    .select('id');
  if (error) throw new Error(`company findings expiry failed: ${error.message}`);
  return ((data ?? []) as unknown[]).length;
}

/**
 * A VP's verdict on a company card. Moving to `known_problem` always records the
 * magnitude they consented to, so escalation is measured from there — a silence
 * with no recorded consent point can never break out of itself.
 */
export async function setCompanyFindingStatus(
  organizationId: string,
  findingId: string,
  status: FindingStatus,
  accountId: string | null,
  now: Date = new Date(),
): Promise<CompanyFinding | null> {
  if (!UUID_RX.test(organizationId ?? '') || !UUID_RX.test(findingId ?? '')) return null;
  const iso = now.toISOString();
  const patch: Record<string, unknown> = {
    status,
    status_changed_at: iso,
    status_changed_by: accountId,
    resolved_at: status === 'resolved' ? iso : null,
  };

  // Both silences record their consent point, exactly as the hotel ledger does
  // — see the note on setFindingStatus in src/lib/findings/store.ts.
  if (status === 'known_problem' || status === 'muted') {
    const current = await supabaseAdmin
      .from('company_findings')
      .select('magnitude')
      .eq('organization_id', organizationId)
      .eq('id', findingId)
      .limit(1);
    const rows = (current.data ?? []) as unknown as Array<{ magnitude: number | string }>;
    patch.silenced_at_magnitude = num(rows[0]?.magnitude ?? null) ?? 0;
  }

  const { data, error } = await supabaseAdmin
    .from('company_findings')
    .update(patch)
    .eq('organization_id', organizationId)
    .eq('id', findingId)
    .select(SELECT_COLUMNS);
  if (error) throw new Error(`company findings status change failed: ${error.message}`);
  const rows = (data ?? []) as unknown as CompanyFindingRow[];
  return rows[0] ? rowToCompanyFinding(rows[0]) : null;
}
