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
import type { CapabilityKey } from '@/lib/capabilities/registry';
import type { AppSection } from '@/lib/sections/registry';

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
  semanticFamily: string | null;
  activityStream: string | null;
  /** Exact canonical hotel set a company-card verdict would affect. */
  affectedPropertyIds: string[];
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
  semantic_family: string | null;
  affected_property_ids: string[];
}

const SELECT_COLUMNS =
  'id, organization_id, detector_id, dedupe_key, summary, severity, disposition, status, ' +
  'receipt_query_id, evidence, as_of, weakest_input_age_days, magnitude, ' +
  'price_low_cents, price_high_cents, price_currency, price_basis, ' +
  'first_seen_at, last_seen_at, occurrence_count, status_changed_at, resolved_at, ' +
  'silenced_at_magnitude, escalated_at, semantic_family, affected_property_ids';

const MAX_VERDICT_PROPERTIES = 250;

function canonicalUuidArray(value: unknown, max = 5000): string[] | null {
  if (!Array.isArray(value)
    || value.length > max
    || !value.every((item) => typeof item === 'string' && UUID_RX.test(item))) return null;
  const ids = (value as string[]).map((id) => id.toLowerCase());
  const sorted = [...ids].sort();
  if (new Set(ids).size !== ids.length
    || !ids.every((id, index) => id === sorted[index])) return null;
  return ids;
}

function canonicalizeUuidArray(value: unknown, max = 5000): string[] | null {
  if (!Array.isArray(value)
    || value.length > max
    || !value.every((item) => typeof item === 'string' && UUID_RX.test(item))) return null;
  const ids = (value as string[]).map((id) => id.toLowerCase());
  return new Set(ids).size === ids.length ? [...ids].sort() : null;
}

function positiveSafeInteger(value: unknown): number | null {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number'
    && Number.isSafeInteger(parsed)
    && parsed > 0
    ? parsed
    : null;
}

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
    semanticFamily: row.semantic_family,
    activityStream: activityStreamFromEvidence(row.evidence),
    affectedPropertyIds: canonicalUuidArray(row.affected_property_ids) ?? [],
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

/**
 * Legacy portfolio detectors supply the exact *affected* UUID list separately
 * from comparator/evaluated hotel ids. Always write the column, including an
 * empty array for malformed/oversized/missing scope, so an evidence refresh can
 * never leave a stale previously-actionable target set behind.
 */
function explicitAffectedPropertyColumns(evidence: FindingEvidence): Record<string, unknown> {
  const ids = canonicalizeUuidArray(
    evidence.params.affected_hotel_ids,
    MAX_VERDICT_PROPERTIES,
  );
  return { affected_property_ids: ids ?? [] };
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
    ...explicitAffectedPropertyColumns(draft.evidence),
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

// ─── Queue verdict boundary ─────────────────────────────────────────────────

export type CompanyFindingVerdict = Extract<
  FindingStatus,
  'known_problem' | 'muted' | 'resolved'
>;

/**
 * The immutable facts the route must bind into the final transactional CAS.
 * `affectedPropertyIds` comes only from the tenant-filtered ledger row; request
 * JSON never chooses which hotels an organization-level verdict may mutate.
 */
export interface CompanyFindingVerdictSnapshot {
  id: string;
  organizationId: string;
  detectorId: string;
  semanticFamily: string | null;
  status: FindingStatus;
  statusChangedAt: string;
  verdictRevision: number;
  affectedPropertyIds: string[];
  activityStream: string | null;
}

interface CompanyFindingVerdictSnapshotRow {
  id: string;
  organization_id: string;
  detector_id: string;
  semantic_family: string | null;
  status: string;
  status_changed_at: string;
  verdict_revision: number | string;
  affected_property_ids: string[];
  evidence: unknown;
}

const VERDICT_STATUSES = new Set<FindingStatus>([
  'open',
  'updated',
  'resolved',
  'known_problem',
  'muted',
  'expired',
]);

export class CompanyFindingVerdictScopeError extends Error {
  constructor(message = 'company finding action scope was invalid') {
    super(message);
    this.name = 'CompanyFindingVerdictScopeError';
  }
}

export interface CompanyFindingVerdictRequirements {
  requiredCapabilities: CapabilityKey[];
  requiredSections: AppSection[];
}

/**
 * Closed presentation/preflight mirror of 0405's commit policy. The SQL RPC is
 * still authoritative. This helper is intentionally conservative: it includes
 * both verdict-action capabilities so the UI never shows a button group where
 * one of its buttons is already known to be dead.
 */
export function companyFindingVerdictRequirements(input: {
  detectorId: string;
  semanticFamily: string | null;
  activityStream?: string | null;
}): CompanyFindingVerdictRequirements | null {
  const actionCapabilities: CapabilityKey[] = ['manage_checklists', 'manage_notifications'];
  if (input.semanticFamily === 'supply_spend_control'
      || input.detectorId === 'portfolio_supply_spend_gap') {
    return {
      requiredCapabilities: [
        ...actionCapabilities,
        'manage_inventory_orders',
        'view_financials',
      ].sort() as CapabilityKey[],
      requiredSections: ['financials', 'inventory', 'staxis'],
    };
  }
  if (input.semanticFamily === 'portfolio_activity_stopped'
      || input.detectorId === 'portfolio_activity_stopped') {
    const activitySection: AppSection | null = input.activityStream === 'inventory_counts'
      ? 'inventory'
      : input.activityStream === 'daily_log_closings'
        ? 'dashboard'
        : input.activityStream === 'work_order_flow'
          ? 'maintenance'
          : null;
    if (!activitySection) return null;
    return {
      requiredCapabilities: [...actionCapabilities, 'run_reports'].sort() as CapabilityKey[],
      requiredSections: [activitySection, 'staxis'].sort() as AppSection[],
    };
  }
  return null;
}

function activityStreamFromEvidence(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const object = value as { params?: unknown; streamId?: unknown };
  const params = object.params;
  const legacyStream = params && typeof params === 'object' && !Array.isArray(params)
    ? (params as { stream?: unknown }).stream
    : null;
  const legacy = typeof legacyStream === 'string' && legacyStream.length <= 120
    ? legacyStream
    : null;
  const pattern = typeof object.streamId === 'string' && object.streamId.length <= 120
    ? object.streamId
    : null;
  return legacy && pattern && legacy !== pattern ? null : (legacy ?? pattern);
}

/** Load one finding through its organization wall and validate its exact scope. */
export async function loadCompanyFindingVerdictSnapshot(
  organizationId: string,
  findingId: string,
): Promise<CompanyFindingVerdictSnapshot | null> {
  if (!UUID_RX.test(organizationId ?? '') || !UUID_RX.test(findingId ?? '')) return null;
  const { data, error } = await supabaseAdmin
    .from('company_findings')
    .select(
      'id, organization_id, detector_id, semantic_family, status, status_changed_at, ' +
      'verdict_revision, affected_property_ids, evidence',
    )
    .eq('organization_id', organizationId)
    .eq('id', findingId)
    .limit(1);
  if (error) throw new Error(`company finding verdict read failed: ${error.message}`);
  const row = ((data ?? []) as unknown as CompanyFindingVerdictSnapshotRow[])[0];
  if (!row) return null;
  const affectedPropertyIds = canonicalUuidArray(
    row.affected_property_ids,
    MAX_VERDICT_PROPERTIES,
  );
  const verdictRevision = positiveSafeInteger(row.verdict_revision);
  if (!affectedPropertyIds
    || affectedPropertyIds.length === 0
    || verdictRevision === null
    || !VERDICT_STATUSES.has(row.status as FindingStatus)
    || typeof row.status_changed_at !== 'string'
    || !Number.isFinite(Date.parse(row.status_changed_at))) {
    throw new CompanyFindingVerdictScopeError();
  }
  return {
    id: row.id.toLowerCase(),
    organizationId: row.organization_id.toLowerCase(),
    detectorId: row.detector_id,
    semanticFamily: row.semantic_family,
    status: row.status as FindingStatus,
    statusChangedAt: row.status_changed_at,
    verdictRevision,
    affectedPropertyIds,
    activityStream: activityStreamFromEvidence(row.evidence),
  };
}

export type CompanyFindingVerdictCommitResult =
  | { ok: true; outcome: 'applied' | 'already_applied'; status: CompanyFindingVerdict; revision: number }
  | { ok: false; reason: 'denied' | 'conflict' | 'unavailable' };

interface VerdictRpcResult {
  ok?: unknown;
  outcome?: unknown;
  status?: unknown;
  revision?: unknown;
  reason?: unknown;
}

type UntypedRpc = (
  functionName: string,
  args: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: { message?: string } | null }>;

/**
 * Commit through 0405's single-transaction authority assertion + CAS. The RPC
 * re-derives the affected-hotel capability policy; these arguments are only
 * immutable expectations, never grants.
 */
export async function commitCompanyFindingVerdict(input: {
  accountId: string;
  organizationId: string;
  authorizationReceiptId: string;
  snapshot: CompanyFindingVerdictSnapshot;
  action: CompanyFindingVerdict;
}): Promise<CompanyFindingVerdictCommitResult> {
  if (!UUID_RX.test(input.accountId)
    || !UUID_RX.test(input.organizationId)
    || !UUID_RX.test(input.authorizationReceiptId)
    || input.snapshot.organizationId !== input.organizationId
    || input.snapshot.affectedPropertyIds.length === 0
    || input.snapshot.affectedPropertyIds.length > MAX_VERDICT_PROPERTIES) {
    return { ok: false, reason: 'denied' };
  }
  const rpc = supabaseAdmin.rpc.bind(supabaseAdmin) as unknown as UntypedRpc;
  const { data, error } = await rpc('staxis_set_company_finding_verdict_cas', {
    p_authorization_receipt_id: input.authorizationReceiptId,
    p_account_id: input.accountId,
    p_organization_id: input.organizationId,
    p_finding_id: input.snapshot.id,
    p_expected_status: input.snapshot.status,
    p_expected_status_changed_at: input.snapshot.statusChangedAt,
    p_expected_verdict_revision: input.snapshot.verdictRevision,
    p_expected_affected_property_ids: input.snapshot.affectedPropertyIds,
    p_action: input.action,
  });
  if (error || data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, reason: 'unavailable' };
  }
  const raw = data as VerdictRpcResult;
  if (raw.ok === true
    && (raw.outcome === 'applied' || raw.outcome === 'already_applied')
    && (raw.status === 'known_problem' || raw.status === 'muted' || raw.status === 'resolved')) {
    const revision = positiveSafeInteger(raw.revision);
    return revision === null
      ? { ok: false, reason: 'unavailable' }
      : {
        ok: true,
        outcome: raw.outcome,
        status: raw.status,
        revision,
      };
  }
  if (raw.ok === false && (raw.reason === 'denied' || raw.reason === 'conflict')) {
    return { ok: false, reason: raw.reason };
  }
  return { ok: false, reason: 'unavailable' };
}
