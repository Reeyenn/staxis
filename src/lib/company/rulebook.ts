import 'server-only';

// ─── The company rulebook — server-only data access ────────────────────────
//
// The company's own knowledge: "all our hotels use Ecolab", "orders over $500
// need VP sign-off". One level up from the per-hotel Knows screen, and the same
// life-cycle — open box → extract → confirm / edit / remove.
//
// READS are service-role only and retain an exact organization filter.
// PRODUCTION WRITES go through 0404's receipt-bound CAS RPC, which freshly
// reasserts organization-wide editor authority in the same transaction as the
// mutation. Actorless legacy helpers remain only for DB-first rollout/fixtures;
// 0404 journals them and its one-way finalizer revokes that path.
//
// WALL B: no function here takes a property id or resolves a company itself.
// Callers hand in an organizationId they got from `companyForProperty` or from
// the caller's own hats, both of which are in src/lib/company/access.ts. There
// is exactly one place that turns a hotel into a company, and it is not here.

import { supabaseAdmin } from '@/lib/supabase-admin';
import { propertiesOfOrganization } from '@/lib/company/access';
import { resolveAuthorizationScope } from '@/lib/authorization/server';
import {
  coerceCompanyCategory,
  readAuthority,
  readAuthorityRule,
  readPolicyValue,
  type CompanyCategory,
  type ComparablePolicyKey,
  type HotelSettingSnapshot,
} from '@/lib/company/rulebook-policy';
import { clearAuthorityRuleForFact, freezeAuthorityRule } from '@/lib/company/authority';

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** company_knowledge.content's column CHECK. */
export const COMPANY_FACT_MAX_CONTENT = 500;
/** company_knowledge.topic's column CHECK. */
export const COMPANY_FACT_MAX_TOPIC = 80;

export type CompanyFactSource = 'explicit_user' | 'inferred' | 'correction';
export type CompanyFactReviewState = 'unreviewed' | 'confirmed';

export interface CompanyFact {
  id: string;
  organizationId: string;
  topic: string;
  content: string;
  category: CompanyCategory;
  source: CompanyFactSource;
  reviewState: CompanyFactReviewState;
  /** Set only on a CONFIRMED fact that pins a comparable setting. */
  policyKey: string | null;
  policyValue: string | null;
  createdByName: string | null;
  updatedAt: string;
  /** DB-owned CAS token. Null only while a new app is reading a pre-0404 DB. */
  currentRevision?: number | null;
}

interface RawFact {
  id: string;
  organization_id: string;
  topic: string;
  content: string;
  category: string | null;
  source: string | null;
  review_state: string | null;
  policy_key: string | null;
  policy_value: string | null;
  created_by_name: string | null;
  updated_at: string;
  current_revision?: number | string | null;
}

// One string literal on purpose: supabase-js infers the row type from it, and
// splitting it across a `+` collapses that inference to GenericStringError[].
const SELECT_COLS =
  'id, organization_id, topic, content, category, source, review_state, policy_key, policy_value, created_by_name, updated_at';
const SELECT_COLS_WITH_REVISION = `${SELECT_COLS}, current_revision`;

function mapFact(row: RawFact): CompanyFact {
  return {
    id: row.id,
    organizationId: row.organization_id,
    topic: row.topic,
    content: row.content,
    category: coerceCompanyCategory(row.category),
    source: (row.source === 'inferred' || row.source === 'correction')
      ? row.source
      : 'explicit_user',
    // Anything but the explicit marker reads as established, matching the DB
    // default — a row that somehow carries NULL is never mistaken for pending.
    reviewState: row.review_state === 'unreviewed' ? 'unreviewed' : 'confirmed',
    policyKey: row.policy_key,
    policyValue: row.policy_value,
    createdByName: row.created_by_name,
    updatedAt: row.updated_at,
    currentRevision: safeInteger(row.current_revision),
  };
}

function isMissingRevisionColumn(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return error.code === '42703'
    || error.code === 'PGRST204'
    || /current_revision/i.test(error.message ?? '');
}

async function selectCompanyFacts(
  organizationId: string,
  options: { confirmedOnly: boolean; limit: number },
): Promise<CompanyFact[]> {
  const query = (columns: string) => {
    let built = supabaseAdmin
      .from('company_knowledge')
      .select(columns)
      .eq('organization_id', organizationId)
      .eq('is_active', true);
    if (options.confirmedOnly) built = built.eq('review_state', 'confirmed');
    return options.confirmedOnly
      ? built.order('category', { ascending: true }).order('topic', { ascending: true }).limit(options.limit)
      : built.order('updated_at', { ascending: false }).limit(options.limit);
  };

  const current = await query(SELECT_COLS_WITH_REVISION);
  if (!current.error && current.data) return (current.data as unknown as RawFact[]).map(mapFact);
  // App-first rolling deploy: reads remain available against a pre-0404 DB,
  // but the null token makes every new mutation fail closed until 0404 lands.
  if (!isMissingRevisionColumn(current.error)) return [];
  const legacy = await query(SELECT_COLS);
  if (legacy.error || !legacy.data) return [];
  return (legacy.data as unknown as RawFact[]).map(mapFact);
}

/** Lower_snake_case slug, capped. Mirrors the hotel intake slugifier. */
export function slugifyCompanyTopic(raw: string): string {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, COMPANY_FACT_MAX_TOPIC);
}

/** Every live fact in the book — the rulebook screen's list. */
export async function listCompanyFacts(organizationId: string, limit = 200): Promise<CompanyFact[]> {
  if (!UUID_RX.test(organizationId ?? '')) return [];
  return selectCompanyFacts(organizationId, { confirmedOnly: false, limit });
}

/**
 * The facts that reach the copilot: live AND confirmed.
 *
 * The `review_state` filter is the whole guarantee behind the open box. A fact
 * pulled out of a pasted email must not act as company policy at twenty hotels
 * before a human has approved it. The badge on the card is the label; THIS is
 * the enforcement. Do not remove it to "give the model more context".
 *
 * Ordered by (category, topic) rather than by time: this text lands in the
 * CACHED half of the system prompt, so the byte order has to depend only on the
 * content, not on which fact was edited most recently.
 */
export async function getConfirmedCompanyFacts(organizationId: string): Promise<CompanyFact[]> {
  if (!UUID_RX.test(organizationId ?? '')) return [];
  return selectCompanyFacts(organizationId, { confirmedOnly: true, limit: 200 });
}

export interface StoreCompanyFactInput {
  organizationId: string;
  topic: string;
  content: string;
  category?: CompanyCategory;
  source?: CompanyFactSource;
  createdByAccountId?: string | null;
  createdByName?: string | null;
  createdByRole?: string | null;
  requestId?: string | null;
}

export type StoreCompanyFactAction = 'inserted' | 'updated' | 'skipped' | 'company_full';

export type CompanyKnowledgeMutationReason =
  | 'invalid_request'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'upgrade_required'
  | 'store_unavailable';

interface CompanyKnowledgeMutationResult {
  ok: boolean;
  action?: string;
  factId?: string | null;
  relatedFactId?: string | null;
  currentRevision?: number | null;
  relatedCurrentRevision?: number | null;
  actualRevision?: number | null;
  reason?: CompanyKnowledgeMutationReason;
  error?: string;
}

interface CompanyKnowledgeMutationInput {
  actorAccountId: string;
  organizationId: string;
  /** Already freshly resolved by a preparation read; SQL reasserts it. */
  scopeReceiptId?: string;
  action: 'intake' | 'upsert_confirmed' | 'confirm' | 'edit' | 'remove' | 'merge';
  factId?: string | null;
  expectedRevision?: number | null;
  relatedFactId?: string | null;
  relatedExpectedRevision?: number | null;
  topic?: string | null;
  content?: string | null;
  category?: CompanyCategory | null;
  source?: CompanyFactSource | null;
  createdByName?: string | null;
  createdByRole?: string | null;
  policyKey?: string | null;
  policyValue?: string | null;
  authority?: ReturnType<typeof structuredReadingFor>['authority'] | null;
  requestId?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeInteger(value: unknown): number | null {
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof parsed === 'number' && Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  return null;
}

function rpcUnavailable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return error.code === 'PGRST202'
    || error.code === 'PGRST204'
    || error.code === '42883'
    || /staxis_apply_company_knowledge_mutation_v1|schema cache/i.test(error.message ?? '');
}

/** App-first preflight. Intake calls this before it spends provider tokens. */
export async function companyKnowledgeLedgerAvailable(): Promise<boolean> {
  try {
    const { data, error } = await supabaseAdmin.rpc('staxis_company_knowledge_ledger_capability');
    if (error || !isRecord(data)) return false;
    return data.ok === true
      && data.schemaVersion === 'company_knowledge_revision_ledger_v1'
      && (data.rolloutMode === 'compat' || data.rolloutMode === 'enforced');
  } catch {
    return false;
  }
}

async function applyCompanyKnowledgeMutation(
  input: CompanyKnowledgeMutationInput,
): Promise<CompanyKnowledgeMutationResult> {
  if (!UUID_RX.test(input.actorAccountId)
    || !UUID_RX.test(input.organizationId)) {
    return { ok: false, reason: 'invalid_request', error: 'bad actor or organization' };
  }
  let receiptId = input.scopeReceiptId;
  if (!receiptId) {
    const resolved = await resolveAuthorizationScope({
      accountId: input.actorAccountId,
      organizationId: input.organizationId,
      selector: { type: 'all_authorized' },
      ttlSeconds: 60,
    });
    if (!resolved.ok) {
      return {
        ok: false,
        reason: resolved.reason === 'store_unavailable' ? 'store_unavailable' : 'forbidden',
        error: resolved.reason,
      };
    }
    receiptId = resolved.receipt.id;
  }

  try {
    const { data, error } = await supabaseAdmin.rpc(
      'staxis_apply_company_knowledge_mutation_v1',
      {
        p_actor_account_id: input.actorAccountId,
        p_scope_receipt_id: receiptId,
        p_organization_id: input.organizationId,
        p_action: input.action,
        p_fact_id: input.factId ?? null,
        p_expected_revision: input.expectedRevision ?? null,
        p_related_fact_id: input.relatedFactId ?? null,
        p_related_expected_revision: input.relatedExpectedRevision ?? null,
        p_topic: input.topic ?? null,
        p_content: input.content ?? null,
        p_category: input.category ?? null,
        p_source: input.source ?? null,
        p_created_by_name: input.createdByName ?? null,
        p_created_by_role: input.createdByRole ?? null,
        p_policy_key: input.policyKey ?? null,
        p_policy_value: input.policyValue ?? null,
        p_authority_action_kind: input.authority?.actionKind ?? null,
        p_authority_threshold_cents: input.authority?.thresholdCents ?? null,
        p_authority_threshold_inclusive: input.authority?.thresholdInclusive ?? null,
        p_authority_approver_role: input.authority?.approverRole ?? null,
        p_request_id: input.requestId ?? null,
        p_cap: 150,
      },
    );
    if (error) {
      return {
        ok: false,
        reason: rpcUnavailable(error) ? 'upgrade_required' : 'store_unavailable',
        error: error.message,
      };
    }
    if (!isRecord(data) || typeof data.ok !== 'boolean') {
      return { ok: false, reason: 'store_unavailable', error: 'invalid mutation response' };
    }
    if (data.ok === false) {
      const reason = data.reason;
      return {
        ok: false,
        reason: reason === 'invalid_request' || reason === 'forbidden'
          || reason === 'not_found' || reason === 'conflict'
          ? reason
          : 'store_unavailable',
        factId: typeof data.factId === 'string' ? data.factId : null,
        actualRevision: safeInteger(data.actualRevision),
        error: typeof reason === 'string' ? reason : 'mutation refused',
      };
    }
    const action = typeof data.action === 'string' ? data.action : null;
    const factId = typeof data.factId === 'string' && UUID_RX.test(data.factId)
      ? data.factId
      : null;
    const currentRevision = safeInteger(data.currentRevision);
    const allowedAction = input.action === 'intake'
      ? action === 'inserted' || action === 'skipped' || action === 'company_full'
      : input.action === 'upsert_confirmed'
        ? action === 'inserted' || action === 'company_full'
        : action === input.action;
    if (!allowedAction
      || (action !== 'company_full' && (factId === null || currentRevision === null))) {
      return { ok: false, reason: 'store_unavailable', error: 'invalid mutation success response' };
    }
    const relatedFactId = typeof data.relatedFactId === 'string' && UUID_RX.test(data.relatedFactId)
      ? data.relatedFactId
      : null;
    const relatedCurrentRevision = safeInteger(data.relatedCurrentRevision);
    if (input.action === 'merge'
      && (relatedFactId === null || relatedCurrentRevision === null)) {
      return { ok: false, reason: 'store_unavailable', error: 'invalid merge success response' };
    }
    return {
      ok: true,
      action: action ?? undefined,
      factId,
      relatedFactId,
      currentRevision,
      relatedCurrentRevision,
    };
  } catch (error) {
    return {
      ok: false,
      reason: 'store_unavailable',
      error: error instanceof Error ? error.message : 'mutation failed',
    };
  }
}

/**
 * Upsert a fact by topic. Verified callers use 0404's receipt-bound CAS RPC;
 * actorless rollout/seed callers use the journaled 0365 compatibility RPC.
 *
 * 'skipped' means a CONFIRMED fact already owns that topic and the incoming
 * write was an extraction — the company already decided what that line says.
 */
export async function storeCompanyFact(
  input: StoreCompanyFactInput,
): Promise<{
  ok: boolean;
  action?: StoreCompanyFactAction;
  factId?: string | null;
  currentRevision?: number | null;
  reason?: CompanyKnowledgeMutationReason;
  error?: string;
}> {
  // Production writes always carry the verified caller. Keeping the 0365 path
  // only for actorless seed/maintenance callers is what makes DB-first rollout
  // compatible; 0404 journals it and the finalizer later revokes it.
  if (input.createdByAccountId != null) {
    if (!UUID_RX.test(input.createdByAccountId)) {
      return { ok: false, reason: 'invalid_request', error: 'bad actor' };
    }
    const reading = structuredReadingFor(input.content);
    if (reading.ambiguousAuthority) {
      return { ok: false, reason: 'invalid_request', error: 'ambiguous authority rule' };
    }
    const mutation = await applyCompanyKnowledgeMutation({
      actorAccountId: input.createdByAccountId,
      organizationId: input.organizationId,
      action: input.source === 'inferred' ? 'intake' : 'upsert_confirmed',
      topic: input.topic,
      content: input.content,
      category: input.category ?? 'standards',
      source: input.source ?? 'explicit_user',
      createdByName: input.createdByName,
      createdByRole: input.createdByRole,
      policyKey: input.source === 'inferred' ? null : reading.policy?.key ?? null,
      policyValue: input.source === 'inferred' ? null : reading.policy?.value ?? null,
      authority: input.source === 'inferred' ? null : reading.authority,
      requestId: input.requestId,
    });
    return {
      ok: mutation.ok,
      action: mutation.action as StoreCompanyFactAction | undefined,
      factId: mutation.factId,
      currentRevision: mutation.currentRevision,
      reason: mutation.reason,
      error: mutation.error,
    };
  }
  const { data, error } = await supabaseAdmin.rpc('staxis_store_company_fact', {
    p_organization_id: input.organizationId,
    p_topic: input.topic,
    p_content: input.content,
    p_category: input.category ?? 'standards',
    p_source: input.source ?? 'explicit_user',
    p_created_by_account_id: input.createdByAccountId ?? null,
    p_created_by_name: input.createdByName ?? null,
    p_created_by_role: input.createdByRole ?? null,
  });
  if (error) return { ok: false, error: error.message };
  const row = Array.isArray(data) ? data[0] : data;
  return {
    ok: true,
    action: row?.action as StoreCompanyFactAction | undefined,
    factId: (row?.fact_id as string | null) ?? null,
  };
}

export interface CompanyFactActor {
  accountId: string | null;
  name: string | null;
  role: string | null;
}

async function resolveCompanyMutationReceiptId(
  actorAccountId: string,
  organizationId: string,
): Promise<{ ok: true; receiptId: string } | { ok: false; reason: CompanyKnowledgeMutationReason }> {
  const resolved = await resolveAuthorizationScope({
    accountId: actorAccountId,
    organizationId,
    selector: { type: 'all_authorized' },
    ttlSeconds: 60,
  });
  if (!resolved.ok) {
    return {
      ok: false,
      reason: resolved.reason === 'store_unavailable' ? 'store_unavailable' : 'forbidden',
    };
  }
  return { ok: true, receiptId: resolved.receipt.id };
}

/**
 * The structured reading a fact would get if confirmed right now. Shown next to
 * the Confirm button so the person approving sees exactly what will be frozen,
 * and stored by `applyStructuredReading` when they say yes.
 */
export function structuredReadingFor(content: string) {
  const authorityRead = readAuthority(content);
  return {
    authority: authorityRead.kind === 'rule' ? authorityRead.rule : null,
    /**
     * Set ONLY when the sentence names two approvers and does not choose. The
     * panel shows both and offers Edit; nothing is frozen. See
     * `readApproverCandidates` for the live sentence that motivated this
     * ("…requires owner approval, not VP approval", stored as the VP).
     */
    ambiguousAuthority: authorityRead.kind === 'ambiguous' ? authorityRead : null,
    policy: readPolicyValue(content),
  };
}

/**
 * Confirm — "yes, that's right."
 *
 * Promotes the row to a human-authored fact (source explicit_user, confirmed),
 * which is what makes it reach every hotel's copilot, and freezes its structured
 * reading. The reading is written HERE and nowhere else: an unconfirmed fact
 * never produces an authority rule, so a pasted document cannot change who signs
 * for money without a person saying so.
 */
export async function confirmCompanyFact(
  organizationId: string,
  id: string,
  actor: CompanyFactActor,
  expectedRevision?: number | null,
  requestId?: string | null,
): Promise<{
  ok: boolean;
  confirmed: boolean;
  currentRevision?: number | null;
  reason?: CompanyKnowledgeMutationReason;
  error?: string;
}> {
  if (!UUID_RX.test(organizationId ?? '') || !UUID_RX.test(id ?? '')) {
    return { ok: false, confirmed: false, error: 'bad id' };
  }
  if (actor.accountId != null) {
    if (!Number.isSafeInteger(expectedRevision) || (expectedRevision ?? 0) < 1) {
      return {
        ok: false,
        confirmed: false,
        reason: 'invalid_request',
        error: 'expected revision required',
      };
    }
    const scope = await resolveCompanyMutationReceiptId(actor.accountId, organizationId);
    if (!scope.ok) return { ok: false, confirmed: false, reason: scope.reason, error: scope.reason };
    // Read only after current organization authority has resolved. The RPC
    // reasserts the same receipt after this preparation read and before commit.
    const existing = await readLiveFact(organizationId, id);
    if (!existing) return { ok: false, confirmed: false, reason: 'not_found', error: 'not found' };
    const reading = structuredReadingFor(existing.content);
    if (reading.ambiguousAuthority) {
      return { ok: false, confirmed: false, reason: 'invalid_request', error: 'ambiguous authority rule' };
    }
    const mutation = await applyCompanyKnowledgeMutation({
      actorAccountId: actor.accountId,
      organizationId,
      scopeReceiptId: scope.receiptId,
      action: 'confirm',
      factId: id,
      expectedRevision,
      content: existing.content,
      category: existing.category,
      source: 'explicit_user',
      createdByName: actor.name,
      createdByRole: actor.role,
      policyKey: reading.policy?.key ?? null,
      policyValue: reading.policy?.value ?? null,
      authority: reading.authority,
      requestId,
    });
    return {
      ok: mutation.ok,
      confirmed: mutation.ok,
      currentRevision: mutation.currentRevision ?? mutation.actualRevision,
      reason: mutation.reason,
      error: mutation.error,
    };
  }
  const existing = await readLiveFact(organizationId, id);
  if (!existing) return { ok: true, confirmed: false };

  const { error } = await supabaseAdmin
    .from('company_knowledge')
    .update({
      source: 'explicit_user',
      review_state: 'confirmed',
      created_by_account_id: actor.accountId,
      created_by_name: actor.name,
      created_by_role: actor.role,
    })
    .eq('organization_id', organizationId)
    .eq('id', id)
    .eq('is_active', true);
  if (error) return { ok: false, confirmed: false, error: error.message };

  await applyStructuredReading(organizationId, id, existing.content, actor.accountId ?? null);
  return { ok: true, confirmed: true };
}

/**
 * Edit — the company rewrites the line.
 *
 * An edited fact is a CORRECTION: a human has now authored it, so it gets the
 * same promotion as Confirm, and its structured reading is re-derived from the
 * NEW words. A rule frozen from the old sentence is retired in the same call —
 * leaving it in force would mean the book says one thing and the gate does
 * another.
 */
export async function editCompanyFact(
  organizationId: string,
  id: string,
  patch: { content: string; category?: CompanyCategory },
  actor: CompanyFactActor,
  expectedRevision?: number | null,
  requestId?: string | null,
): Promise<{
  ok: boolean;
  updated: boolean;
  currentRevision?: number | null;
  reason?: CompanyKnowledgeMutationReason;
  error?: string;
}> {
  if (!UUID_RX.test(organizationId ?? '') || !UUID_RX.test(id ?? '')) {
    return { ok: false, updated: false, error: 'bad id' };
  }
  const content = patch.content.trim();
  if (!content || content.length > COMPANY_FACT_MAX_CONTENT) {
    return { ok: false, updated: false, error: 'bad content' };
  }
  if (actor.accountId != null) {
    if (!Number.isSafeInteger(expectedRevision) || (expectedRevision ?? 0) < 1) {
      return {
        ok: false,
        updated: false,
        reason: 'invalid_request',
        error: 'expected revision required',
      };
    }
    const reading = structuredReadingFor(content);
    if (reading.ambiguousAuthority) {
      return { ok: false, updated: false, reason: 'invalid_request', error: 'ambiguous authority rule' };
    }
    const mutation = await applyCompanyKnowledgeMutation({
      actorAccountId: actor.accountId,
      organizationId,
      action: 'edit',
      factId: id,
      expectedRevision,
      content,
      category: patch.category ?? null,
      source: 'correction',
      createdByName: actor.name,
      createdByRole: actor.role,
      policyKey: reading.policy?.key ?? null,
      policyValue: reading.policy?.value ?? null,
      authority: reading.authority,
      requestId,
    });
    return {
      ok: mutation.ok,
      updated: mutation.ok,
      currentRevision: mutation.currentRevision ?? mutation.actualRevision,
      reason: mutation.reason,
      error: mutation.error,
    };
  }
  const { data, error } = await supabaseAdmin
    .from('company_knowledge')
    .update({
      content,
      ...(patch.category ? { category: patch.category } : {}),
      source: 'correction',
      review_state: 'confirmed',
      created_by_account_id: actor.accountId,
      created_by_name: actor.name,
      created_by_role: actor.role,
    })
    .eq('organization_id', organizationId)
    .eq('id', id)
    .eq('is_active', true)
    .select('id');
  if (error) return { ok: false, updated: false, error: error.message };
  if ((data ?? []).length === 0) return { ok: true, updated: false };

  await applyStructuredReading(organizationId, id, content, actor.accountId ?? null);
  return { ok: true, updated: true };
}

/**
 * Remove — permanent, and the copy on the screen says so.
 *
 * The row is retained (is_active=false) for the audit trail but leaves every
 * read, leaves the prompt, and takes its authority rule with it. Nothing in
 * this product writes a company fact automatically, so there is no consolidator
 * that could quietly bring it back; a later re-statement of the same subject
 * starts a fresh UNCONFIRMED row (the live-topic unique index is partial on
 * is_active), which is the honest behaviour — it comes back only if a human
 * approves it again.
 */
export async function removeCompanyFact(
  organizationId: string,
  id: string,
  actor?: CompanyFactActor,
  expectedRevision?: number | null,
  requestId?: string | null,
): Promise<{
  ok: boolean;
  removed: boolean;
  currentRevision?: number | null;
  reason?: CompanyKnowledgeMutationReason;
  error?: string;
}> {
  if (!UUID_RX.test(organizationId ?? '') || !UUID_RX.test(id ?? '')) {
    return { ok: false, removed: false, error: 'bad id' };
  }
  if (actor?.accountId != null) {
    if (!Number.isSafeInteger(expectedRevision) || (expectedRevision ?? 0) < 1) {
      return {
        ok: false,
        removed: false,
        reason: 'invalid_request',
        error: 'expected revision required',
      };
    }
    const mutation = await applyCompanyKnowledgeMutation({
      actorAccountId: actor.accountId,
      organizationId,
      action: 'remove',
      factId: id,
      expectedRevision,
      createdByName: actor.name,
      createdByRole: actor.role,
      requestId,
    });
    return {
      ok: mutation.ok,
      removed: mutation.ok,
      currentRevision: mutation.currentRevision ?? mutation.actualRevision,
      reason: mutation.reason,
      error: mutation.error,
    };
  }
  const { data, error } = await supabaseAdmin
    .from('company_knowledge')
    .update({ is_active: false })
    .eq('organization_id', organizationId)
    .eq('id', id)
    .eq('is_active', true)
    .select('id');
  if (error) return { ok: false, removed: false, error: error.message };
  const removed = (data ?? []).length > 0;
  if (removed) await clearAuthorityRuleForFact(organizationId, id);
  return { ok: true, removed };
}

/**
 * "That's the same rule — update the line I already have."
 *
 * Takes the WORDS off the restatement, writes them onto the confirmed line the
 * company already approved, and retires the duplicate. Two writes, in the order
 * that fails safe: the edit first (which re-derives the structured reading from
 * the new words, so an approval rule frozen from the old sentence cannot outlive
 * it), then the removal. If the removal fails, the company is left with one
 * correct confirmed line and one unreviewed draft — the state they were already
 * in — rather than with the draft gone and the rule un-updated.
 *
 * `keepId` is always the CONFIRMED fact. The confirmed line owns the topic slug
 * every hotel's copilot has been reading, and re-pointing that at a freshly
 * extracted row would change the key under it for no gain.
 */
export async function mergeCompanyFact(
  organizationId: string,
  keepId: string,
  dropId: string,
  actor: CompanyFactActor,
  expectedRevision?: number | null,
  dropExpectedRevision?: number | null,
  requestId?: string | null,
): Promise<{
  ok: boolean;
  merged: boolean;
  currentRevision?: number | null;
  relatedCurrentRevision?: number | null;
  reason?: CompanyKnowledgeMutationReason;
  error?: string;
}> {
  if (!UUID_RX.test(keepId ?? '') || !UUID_RX.test(dropId ?? '') || keepId === dropId) {
    return { ok: false, merged: false, error: 'bad id' };
  }
  if (actor.accountId != null) {
    if (!Number.isSafeInteger(expectedRevision) || (expectedRevision ?? 0) < 1
      || !Number.isSafeInteger(dropExpectedRevision) || (dropExpectedRevision ?? 0) < 1) {
      return {
        ok: false,
        merged: false,
        reason: 'invalid_request',
        error: 'both expected revisions are required',
      };
    }
    const scope = await resolveCompanyMutationReceiptId(actor.accountId, organizationId);
    if (!scope.ok) return { ok: false, merged: false, reason: scope.reason, error: scope.reason };
    const drop = await readLiveFact(organizationId, dropId);
    if (!drop) return { ok: false, merged: false, reason: 'not_found', error: 'not found' };
    const reading = structuredReadingFor(drop.content);
    if (reading.ambiguousAuthority) {
      return { ok: false, merged: false, reason: 'invalid_request', error: 'ambiguous authority rule' };
    }
    const mutation = await applyCompanyKnowledgeMutation({
      actorAccountId: actor.accountId,
      organizationId,
      scopeReceiptId: scope.receiptId,
      action: 'merge',
      factId: keepId,
      expectedRevision,
      relatedFactId: dropId,
      relatedExpectedRevision: dropExpectedRevision,
      source: 'correction',
      createdByName: actor.name,
      createdByRole: actor.role,
      policyKey: reading.policy?.key ?? null,
      policyValue: reading.policy?.value ?? null,
      authority: reading.authority,
      requestId,
    });
    return {
      ok: mutation.ok,
      merged: mutation.ok,
      currentRevision: mutation.currentRevision ?? mutation.actualRevision,
      relatedCurrentRevision: mutation.relatedCurrentRevision,
      reason: mutation.reason,
      error: mutation.error,
    };
  }
  const [keep, drop] = await Promise.all([
    readLiveFact(organizationId, keepId),
    readLiveFact(organizationId, dropId),
  ]);
  if (!keep || !drop) return { ok: true, merged: false };
  // The one this collapses INTO must be the established line. Refusing rather
  // than swapping the arguments: a caller confused about which is which is a
  // caller whose intent we cannot infer.
  if (keep.reviewState !== 'confirmed') return { ok: false, merged: false, error: 'keep is not confirmed' };

  const edited = await editCompanyFact(
    organizationId,
    keepId,
    { content: drop.content, category: drop.category },
    actor,
  );
  if (!edited.ok) return { ok: false, merged: false, error: edited.error };
  if (!edited.updated) return { ok: true, merged: false };

  const removed = await removeCompanyFact(organizationId, dropId);
  if (!removed.ok) return { ok: false, merged: false, error: removed.error };
  return { ok: true, merged: true };
}

async function readLiveFact(organizationId: string, id: string): Promise<CompanyFact | null> {
  const current = await supabaseAdmin
    .from('company_knowledge')
    .select(SELECT_COLS_WITH_REVISION)
    .eq('organization_id', organizationId)
    .eq('id', id)
    .eq('is_active', true)
    .maybeSingle();
  if (!current.error && current.data) return mapFact(current.data as RawFact);
  if (!isMissingRevisionColumn(current.error)) return null;
  const legacy = await supabaseAdmin
    .from('company_knowledge')
    .select(SELECT_COLS)
    .eq('organization_id', organizationId)
    .eq('id', id)
    .eq('is_active', true)
    .maybeSingle();
  if (legacy.error || !legacy.data) return null;
  return mapFact(legacy.data as RawFact);
}

/**
 * Freeze (or retire) the structured reading of a fact that a human just
 * approved. Both halves are re-derived from the current words every time, so a
 * sentence that STOPS being an approval requirement stops being a gate.
 */
async function applyStructuredReading(
  organizationId: string,
  factId: string,
  content: string,
  actorAccountId: string | null,
): Promise<void> {
  const { authority, policy } = structuredReadingFor(content);

  if (authority) {
    await freezeAuthorityRule(organizationId, factId, authority, actorAccountId);
  } else {
    await clearAuthorityRuleForFact(organizationId, factId);
  }

  await supabaseAdmin
    .from('company_knowledge')
    .update({
      policy_key: policy?.key ?? null,
      policy_value: policy?.value ?? null,
    })
    .eq('organization_id', organizationId)
    .eq('id', factId)
    .eq('is_active', true);
}

// ─── The comparable half of a contradiction ────────────────────────────────

interface RawProperty {
  id: string;
  name: string | null;
  checkout_minutes: number | null;
  stayover_minutes: number | null;
  housekeeping_setup: unknown;
}

/**
 * Read each of the company's hotels' configured values for the comparable
 * settings. A hotel that has not configured something contributes NOTHING for
 * that key — absence is never a contradiction.
 */
export async function companyHotelSettings(organizationId: string): Promise<HotelSettingSnapshot[]> {
  const propertyIds = await propertiesOfOrganization(organizationId);
  if (propertyIds.length === 0) return [];

  const { data, error } = await supabaseAdmin
    .from('properties')
    .select('id, name, checkout_minutes, stayover_minutes, housekeeping_setup')
    .in('id', propertyIds);
  if (error || !Array.isArray(data)) return [];

  return (data as RawProperty[]).map((row) => {
    const values: Partial<Record<ComparablePolicyKey, string>> = {};

    const setup = row.housekeeping_setup;
    if (setup && typeof setup === 'object' && !Array.isArray(setup)) {
      const start = (setup as Record<string, unknown>).shiftStartTime;
      if (typeof start === 'string' && /^\d{2}:\d{2}$/.test(start)) {
        values.housekeeping_start_time = start;
      }
    }
    if (typeof row.checkout_minutes === 'number' && row.checkout_minutes > 0) {
      values.checkout_clean_minutes = String(row.checkout_minutes);
    }
    if (typeof row.stayover_minutes === 'number' && row.stayover_minutes > 0) {
      values.stayover_clean_minutes = String(row.stayover_minutes);
    }

    return {
      propertyId: row.id,
      propertyName: row.name ?? 'This hotel',
      values,
    };
  }).sort((a, b) => a.propertyName.localeCompare(b.propertyName));
}
