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
// Persistence callers pass an explicit organization id, but request routes must
// first bind that id to the caller's live authorization scope. Human verdicts
// go only through the atomic RPC below, which rechecks the locked finding's
// organization and exact affected hotels inside the transaction.

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
  /** Trusted typed lineage used by the company verdict authorization boundary. */
  affectedPropertyIds: string[];
  /** Closed management-pattern family; null on deterministic legacy rows. */
  semanticFamily: string | null;
  /** Monotonic CAS token for a human verdict on this company row. */
  verdictRevision: number;
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
  affected_property_ids: string[];
  semantic_family: string | null;
  verdict_revision: number | string;
}

const SELECT_COLUMNS =
  'id, organization_id, detector_id, dedupe_key, summary, severity, disposition, status, ' +
  'receipt_query_id, evidence, as_of, weakest_input_age_days, magnitude, ' +
  'price_low_cents, price_high_cents, price_currency, price_basis, ' +
  'first_seen_at, last_seen_at, occurrence_count, status_changed_at, resolved_at, ' +
  'silenced_at_magnitude, escalated_at, affected_property_ids, semantic_family, verdict_revision';

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
    affectedPropertyIds: Array.isArray(row.affected_property_ids)
      ? row.affected_property_ids
      : [],
    semanticFamily: typeof row.semantic_family === 'string' ? row.semantic_family : null,
    verdictRevision: num(row.verdict_revision) ?? 0,
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
  /** Exact, canonical hotel targets computed by the deterministic detector. */
  affectedPropertyIds: readonly string[];
  draft: FindingDraft;
  receiptQueryId: string;
  disposition: FindingDisposition;
  now: Date;
}

export type CompanyPersistOutcome = 'opened' | 'updated' | 'suppressed' | 'escalated';

function canonicalAffectedPropertyIds(propertyIds: readonly string[]): string[] {
  if (propertyIds.length === 0
    || propertyIds.length > 250
    || !propertyIds.every((id) => UUID_RX.test(id))) {
    throw new Error('company finding affected-property lineage was absent or malformed');
  }
  const canonical = [...new Set(propertyIds.map((id) => id.toLowerCase()))].sort();
  if (canonical.length !== propertyIds.length
    || canonical.some((id, index) => id !== propertyIds[index])) {
    throw new Error('company finding affected-property lineage was not canonical');
  }
  return canonical;
}

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
    affected_property_ids: canonicalAffectedPropertyIds(args.affectedPropertyIds),
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
    return touchSilencedCompanyFinding(args, row.id);
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
  const { data, error } = await supabaseAdmin
    .from('company_findings')
    .update({
      ...draftColumns(args),
      disposition: args.disposition,
      status,
      last_seen_at: args.now.toISOString(),
      occurrence_count: occurrence,
    })
    .eq('organization_id', args.organizationId)
    .eq('id', findingId)
    .in('status', ['open', 'updated'])
    .select('id');
  if (error) throw new Error(`company findings update failed: ${error.message}`);
  if (((data ?? []) as unknown[]).length !== 1) {
    throw new Error('company findings update refused a non-live row');
  }
  return 'updated';
}

/**
 * A silenced portfolio problem was found again. Evidence may move while its
 * exact affected-hotel lineage is unchanged, without disturbing the human
 * verdict. 0405 enforces the complementary invariant in the database: when
 * `affected_property_ids` changes, this same atomic UPDATE is converted into
 * an `updated` rearm and advances the CAS epoch. That keeps new evidence from
 * inheriting consent that was given for a different set of hotels.
 *
 * `status` and `disposition` are deliberately absent from this patch. The
 * database owns the lineage transition; otherwise a process could update the
 * evidence first and crash before making the old silence visible again.
 */
export async function touchSilencedCompanyFinding(
  args: PersistCompanyArgs,
  findingId: string,
): Promise<CompanyPersistOutcome> {
  const occurrence = await nextOccurrence(args.organizationId, findingId);
  const { data, error } = await supabaseAdmin
    .from('company_findings')
    .update({
      ...draftColumns(args),
      last_seen_at: args.now.toISOString(),
      occurrence_count: occurrence,
    })
    .eq('organization_id', args.organizationId)
    .eq('id', findingId)
    .in('status', ['known_problem', 'muted'])
    .select('id, status');
  if (error) throw new Error(`company findings silenced-refresh failed: ${error.message}`);
  const rows = (data ?? []) as unknown as Array<{ id: string; status: string }>;
  if (rows.length !== 1) {
    throw new Error('company findings silenced-refresh refused a non-silenced row');
  }
  if (rows[0]!.status === 'updated') return 'updated';
  if (rows[0]!.status !== 'known_problem' && rows[0]!.status !== 'muted') {
    throw new Error('company findings silenced-refresh returned an invalid lifecycle state');
  }
  return 'suppressed';
}

/** The problem outgrew the silence the VP armed. Same row, live again, recorded. */
export async function escalateCompanyFinding(
  args: PersistCompanyArgs,
  findingId: string,
): Promise<CompanyPersistOutcome> {
  const iso = args.now.toISOString();
  const occurrence = await nextOccurrence(args.organizationId, findingId);
  const { data, error } = await supabaseAdmin
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
    .eq('id', findingId)
    .eq('status', 'known_problem')
    .select('id');
  if (error) throw new Error(`company findings escalate failed: ${error.message}`);
  if (((data ?? []) as unknown[]).length !== 1) {
    throw new Error('company findings escalation refused a non-known row');
  }
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

export type AuthorizedCompanyFindingVerdictResult =
  | {
    ok: true;
    status: Extract<FindingStatus, 'known_problem' | 'muted' | 'resolved'>;
    verdictRevision: number;
    alreadyApplied: boolean;
  }
  | { ok: false };

/**
 * The sole release-safe company verdict door.  The database function owns the
 * finding lock and every commit-time authorization check; this wrapper only
 * validates its deliberately closed result shape.  RPC/store errors throw so
 * an HTTP caller can distinguish an unavailable boundary from an ordinary,
 * non-enumerating denial.
 */
export async function setCompanyFindingStatusAuthorized(input: {
  organizationId: string;
  findingId: string;
  status: Extract<FindingStatus, 'known_problem' | 'muted' | 'resolved'>;
  accountId: string;
  receiptId: string;
  expectedVerdictRevision: number;
}): Promise<AuthorizedCompanyFindingVerdictResult> {
  const { data, error } = await supabaseAdmin.rpc(
    'staxis_set_company_finding_status_authorized',
    {
      p_organization_id: input.organizationId,
      p_finding_id: input.findingId,
      p_action: input.status,
      p_account_id: input.accountId,
      p_aggregate_receipt_id: input.receiptId,
      p_expected_verdict_revision: input.expectedVerdictRevision,
    },
  );
  if (error) {
    throw new Error(`authorized company finding status change failed: ${error.message}`);
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('authorized company finding status change returned a malformed result');
  }
  const result = data as Record<string, unknown>;
  if (result.ok === false && Object.keys(result).length === 1) return { ok: false };
  if (result.ok === true
    && Object.keys(result).length === 4
    && (result.status === 'known_problem'
      || result.status === 'muted'
      || result.status === 'resolved')
    && typeof result.verdictRevision === 'number'
    && Number.isSafeInteger(result.verdictRevision)
    && typeof result.alreadyApplied === 'boolean'
    && (result.verdictRevision === input.expectedVerdictRevision + 1
      || (result.alreadyApplied === true
        && result.verdictRevision === input.expectedVerdictRevision))) {
    return {
      ok: true,
      status: result.status,
      verdictRevision: result.verdictRevision,
      alreadyApplied: result.alreadyApplied,
    };
  }
  throw new Error('authorized company finding status change returned an invalid result');
}
