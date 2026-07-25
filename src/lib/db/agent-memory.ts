// ─── Agent memory — server-only data access ─────────────────────────────────
// Long-term copilot memory (migration 0256). SERVICE-ROLE ONLY: every call uses
// supabaseAdmin and is scoped by property_id. Because supabaseAdmin bypasses
// RLS, the property_id filter HERE is the real per-tenant guarantee (RLS
// deny-all is the backstop) — so never drop the .eq('property_id', …).
//
// Writes go through the advisory-locked RPCs staxis_store_memory /
// staxis_forget_memory (atomic upsert-by-topic + caps, soft-delete). This module
// is server-only and intentionally NOT re-exported from src/lib/db.ts.

import 'server-only';
import { supabaseAdmin } from '@/lib/supabase-admin';
import {
  coerceMemoryCategory,
  type MemoryCategory,
  type MemoryReviewState,
} from '@/lib/agent/memory-facets';

export type MemoryScope = 'property' | 'user';
export type MemorySource = 'explicit_user' | 'inferred' | 'correction' | 'consolidation' | 'operational';
export type MemoryConfidence = 'low' | 'normal' | 'high';
// 'skipped'           — an auto-learned write deferred to an active human fact (0260/0261).
// 'refused_forgotten' — an auto-learned write for a topic a human DELETED; refused
//                       permanently, no time window (0357). Human writes are never refused.
export type StoreMemoryAction =
  | 'inserted'
  | 'updated'
  | 'skipped'
  | 'refused_forgotten'
  | 'property_full'
  | 'user_full';

export interface MemoryRow {
  id: string;
  scope: MemoryScope;
  topic: string;
  content: string;
  source: MemorySource;
  confidence: MemoryConfidence;
  createdByRole: string | null;
  createdByName: string | null;
  subjectAccountId: string | null;
  updatedAt: string;
  /** 0358 — one of the five Knows buckets. Never null (DB trigger fills it). */
  category: MemoryCategory;
  /** 0358 — 'unreviewed' facts are awaiting a manager and never reach the model. */
  reviewState: MemoryReviewState;
  expiresAt: string | null;
}

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Kept as ONE string literal: supabase-js infers the row type from the literal,
// and splitting it across a `+` concatenation collapses that inference to
// GenericStringError[]. Long line on purpose.
const SELECT_COLS =
  'id, scope, topic, content, source, confidence, created_by_role, created_by_name, subject_account_id, updated_at, category, review_state, expires_at';

interface RawRow {
  id: string;
  scope: MemoryScope;
  topic: string;
  content: string;
  source: MemorySource;
  confidence: MemoryConfidence;
  created_by_role: string | null;
  created_by_name: string | null;
  subject_account_id: string | null;
  updated_at: string;
  category: string | null;
  review_state: string | null;
  expires_at: string | null;
}

function mapRow(r: RawRow): MemoryRow {
  return {
    id: r.id,
    scope: r.scope,
    topic: r.topic,
    content: r.content,
    source: r.source,
    confidence: r.confidence,
    createdByRole: r.created_by_role,
    createdByName: r.created_by_name,
    subjectAccountId: r.subject_account_id,
    updatedAt: r.updated_at,
    category: coerceMemoryCategory(r.category),
    // Anything but the explicit 'unreviewed' marker reads as established —
    // matching the DB default, so a pre-0358 row (or a NULL that somehow
    // survived) is never mistaken for something awaiting approval.
    reviewState: r.review_state === 'unreviewed' ? 'unreviewed' : 'confirmed',
    expiresAt: r.expires_at,
  };
}

/**
 * Active, non-expired memory for one turn: all property-scope rows for the hotel
 * PLUS this user's own user-scope rows. Capped at 200 (ranking + token-budget
 * trimming happens in memory-context.ts). subjectAccountId may be null (a user
 * with no account row) — then only property-scope memory is returned.
 *
 * 0358: rows with review_state='unreviewed' are EXCLUDED. That is the whole
 * guarantee behind the Knows screen's open box — a fact extracted from pasted
 * text or an uploaded PDF must not act as established truth before a human
 * approves it. The UI badge is a label; THIS filter is the enforcement. Do not
 * remove it to "show the model more context".
 */
export async function getActiveMemoryForTurn(
  propertyId: string,
  subjectAccountId: string | null,
): Promise<MemoryRow[]> {
  if (!UUID_RX.test(propertyId)) return [];
  const nowIso = new Date().toISOString();

  // Separate query per scope, each with its own limit, so a large set of
  // property facts can never crowd out this user's personal prefs (Codex P1-B).
  // (nowIso is server-generated; subjectAccountId is UUID-validated — no filter
  // injection.) The .eq('property_id') is the per-tenant guarantee on every one.
  const base = () =>
    supabaseAdmin
      .from('agent_memory')
      .select(SELECT_COLS)
      .eq('property_id', propertyId)
      .eq('is_active', true)
      .eq('review_state', 'confirmed')
      .or(`expires_at.is.null,expires_at.gt.${nowIso}`);

  const queries = [base().eq('scope', 'property').limit(150)];
  if (subjectAccountId && UUID_RX.test(subjectAccountId)) {
    queries.push(base().eq('scope', 'user').eq('subject_account_id', subjectAccountId).limit(50));
  }

  const results = await Promise.all(queries);
  const out: MemoryRow[] = [];
  for (const { data, error } of results) {
    if (!error && data) out.push(...(data as RawRow[]).map(mapRow));
  }
  return out;
}

export interface StoreMemoryInput {
  propertyId: string;
  scope: MemoryScope;
  subjectAccountId: string | null;
  topic: string;
  content: string;
  source?: MemorySource;
  confidence?: MemoryConfidence;
  createdByAccountId?: string | null;
  createdByName?: string | null;
  createdByRole?: string | null;
  sourceConversationId?: string | null;
  expiresAt?: string | null;
  /**
   * 0358 — the Knows bucket. Optional, and applied in a second property-scoped
   * UPDATE after the RPC returns the row id: deliberately NOT a new RPC
   * parameter, because widening staxis_store_memory's signature would mean
   * dropping and recreating a function every other write path calls. Omit it
   * and the DB trigger classifies the row, exactly as before this migration.
   *
   * There is intentionally NO reviewState here. Review state is not something
   * a caller gets to choose: the 0358 trigger derives it from `source`
   * ('inferred' ⇒ always unreviewed), so the guarantee holds even for a write
   * path that has never heard of this field.
   */
  category?: MemoryCategory;
}

/**
 * Store (upsert-by-topic) a memory via the atomic RPC. Returns the action the
 * DB took: 'inserted' | 'updated' on success, or 'property_full' | 'user_full'
 * when the active-row cap is hit (caller surfaces a friendly message).
 */
export async function storeMemory(
  input: StoreMemoryInput,
): Promise<{ ok: boolean; action?: StoreMemoryAction; memoryId?: string | null; error?: string }> {
  const { data, error } = await supabaseAdmin.rpc('staxis_store_memory', {
    p_property_id: input.propertyId,
    p_scope: input.scope,
    p_subject_account_id: input.subjectAccountId,
    p_topic: input.topic,
    p_content: input.content,
    p_source: input.source ?? 'explicit_user',
    p_confidence: input.confidence ?? 'normal',
    p_created_by_account_id: input.createdByAccountId ?? null,
    p_created_by_name: input.createdByName ?? null,
    p_created_by_role: input.createdByRole ?? null,
    p_source_conversation_id: input.sourceConversationId ?? null,
    p_expires_at: input.expiresAt ?? null,
  });
  if (error) return { ok: false, error: error.message };
  // Table-returning RPC → array of one row { memory_id, action }.
  const row = Array.isArray(data) ? data[0] : data;
  const action = row?.action as StoreMemoryAction | undefined;
  const memoryId = (row?.memory_id as string | null) ?? null;

  // Apply the caller's chosen bucket. Scoped by property_id AND id — the id
  // came from our own RPC call, but the tenant filter is the guarantee here
  // (agent_memory is deny-all RLS; supabaseAdmin bypasses it), so it is never
  // dropped. A failure here is cosmetic: the row keeps the bucket the DB
  // trigger picked, so we log-and-continue rather than fail the whole write.
  if (memoryId && input.category !== undefined && (action === 'inserted' || action === 'updated')) {
    await supabaseAdmin
      .from('agent_memory')
      .update({ category: input.category })
      .eq('property_id', input.propertyId)
      .eq('id', memoryId);
  }

  return { ok: true, action, memoryId };
}

/**
 * Soft-delete the active memory row for (scope, subject, topic). Returns how
 * many rows were deactivated (0 = nothing matched).
 */
export async function forgetMemory(
  propertyId: string,
  scope: MemoryScope,
  subjectAccountId: string | null,
  topic: string,
): Promise<{ ok: boolean; deactivated: number; error?: string }> {
  const { data, error } = await supabaseAdmin.rpc('staxis_forget_memory', {
    p_property_id: propertyId,
    p_scope: scope,
    p_subject_account_id: subjectAccountId,
    p_topic: topic,
  });
  if (error) return { ok: false, deactivated: 0, error: error.message };
  return { ok: true, deactivated: typeof data === 'number' ? data : 0 };
}

/**
 * List memory for the manager-facing "what Staxis knows" UI (Move #3). Active
 * rows by default; includeInactive surfaces the audit trail.
 */
export async function listMemory(
  propertyId: string,
  opts: { scope?: MemoryScope; includeInactive?: boolean; limit?: number; offset?: number } = {},
): Promise<MemoryRow[]> {
  if (!UUID_RX.test(propertyId)) return [];
  let q = supabaseAdmin
    .from('agent_memory')
    .select(SELECT_COLS)
    .eq('property_id', propertyId)
    .order('updated_at', { ascending: false });

  if (!opts.includeInactive) q = q.eq('is_active', true);
  if (opts.scope) q = q.eq('scope', opts.scope);
  q = q.range(opts.offset ?? 0, (opts.offset ?? 0) + (opts.limit ?? 100) - 1);

  const { data, error } = await q;
  if (error || !data) return [];
  return (data as RawRow[]).map(mapRow);
}

export interface ConsolidationRecap {
  recap: string | null;
  ranAt: string;
  learnedCount: number;
  updatedCount: number;
  operationalRecap: string | null;
  operationalLearnedCount: number;
  operationalUpdatedCount: number;
}

/** Most recent nightly consolidation run for a property (dashboard recap header). */
export async function getLatestConsolidation(propertyId: string): Promise<ConsolidationRecap | null> {
  if (!UUID_RX.test(propertyId)) return null;
  const { data, error } = await supabaseAdmin
    .from('agent_memory_consolidations')
    .select('recap, ran_at, learned_count, updated_count, operational_recap, operational_learned_count, operational_updated_count')
    .eq('property_id', propertyId)
    .order('ran_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return {
    recap: (data.recap as string | null) ?? null,
    ranAt: data.ran_at as string,
    learnedCount: (data.learned_count as number) ?? 0,
    updatedCount: (data.updated_count as number) ?? 0,
    operationalRecap: (data.operational_recap as string | null) ?? null,
    operationalLearnedCount: (data.operational_learned_count as number) ?? 0,
    operationalUpdatedCount: (data.operational_updated_count as number) ?? 0,
  };
}

/** Active auto-learned (consolidation) facts for the dashboard "What Staxis learned" card. */
export async function listLearnedMemory(propertyId: string, limit = 20): Promise<MemoryRow[]> {
  if (!UUID_RX.test(propertyId)) return [];
  const { data, error } = await supabaseAdmin
    .from('agent_memory')
    .select(SELECT_COLS)
    .eq('property_id', propertyId)
    .eq('is_active', true)
    .eq('scope', 'property')
    .in('source', ['consolidation', 'operational'])
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (error || !data) return [];
  return (data as RawRow[]).map(mapRow);
}

/**
 * Soft-delete an AUTO-LEARNED memory by id, scoped to the property (the
 * dashboard "What Staxis learned/noticed" Remove). Restricted to auto-learned
 * sources (consolidation + operational) so a manager can't accidentally delete
 * an explicitly-set fact via this surface (Codex P1-C). Returns how many rows
 * were removed (0 = no match).
 */
export async function deactivateMemoryById(
  propertyId: string,
  id: string,
): Promise<{ ok: boolean; removed: number; error?: string }> {
  if (!UUID_RX.test(propertyId) || !UUID_RX.test(id)) return { ok: false, removed: 0, error: 'bad id' };
  const { data, error } = await supabaseAdmin
    .from('agent_memory')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('property_id', propertyId)
    .eq('id', id)
    .eq('is_active', true)
    .in('source', ['consolidation', 'operational'])
    .select('id');
  if (error) return { ok: false, removed: 0, error: error.message };
  return { ok: true, removed: (data ?? []).length };
}

// ─── The Knows screen's three actions ───────────────────────────────────────
// Every one is scoped by property_id AND id, and only ever touches an ACTIVE
// row. property_id is the per-tenant guarantee (RLS is deny-all and
// supabaseAdmin bypasses it) — never drop it, and never look a row up by id
// alone "because ids are unguessable".

export interface FactActor {
  accountId: string | null;
  name: string | null;
  role: string | null;
}

/**
 * CONFIRM — the manager says "yes, that's right."
 *
 * This is deliberately not a boolean flip. Confirming PROMOTES the row to a
 * human-authored fact (source 'explicit_user', confidence high) and clears its
 * expiry, which buys three behaviors from mechanisms that already exist:
 *
 *   • it stops expiring       — expires_at NULL, so the nightly sweep leaves it;
 *   • it stops being auto-overwritable — 0260/0261 make a consolidation or
 *     operational write DEFER to any active non-auto-learned row for the topic;
 *   • it starts reaching the model — the 0358 trigger only forces
 *     review_state='unreviewed' while source is still 'inferred'.
 *
 * Inventing a separate "confirmed" flag would have left all three unchanged.
 */
export async function confirmMemoryFact(
  propertyId: string,
  id: string,
  actor: FactActor,
): Promise<{ ok: boolean; confirmed: boolean; error?: string }> {
  if (!UUID_RX.test(propertyId) || !UUID_RX.test(id)) {
    return { ok: false, confirmed: false, error: 'bad id' };
  }
  const { data, error } = await supabaseAdmin
    .from('agent_memory')
    .update({
      source: 'explicit_user',
      review_state: 'confirmed',
      confidence: 'high',
      expires_at: null,
      created_by_account_id: actor.accountId,
      created_by_name: actor.name,
      created_by_role: actor.role,
      updated_at: new Date().toISOString(),
    })
    .eq('property_id', propertyId)
    .eq('id', id)
    .eq('is_active', true)
    .select('id');
  if (error) return { ok: false, confirmed: false, error: error.message };
  return { ok: true, confirmed: (data ?? []).length > 0 };
}

/**
 * EDIT — the manager rewrites the fact (and optionally re-files it).
 *
 * An edited fact is a CORRECTION: a human has now authored it, so it gets the
 * same promotion (and the same protection from auto-overwrite) as Confirm.
 * Content is capped at the 500-char column CHECK by the caller.
 */
export async function editMemoryFact(
  propertyId: string,
  id: string,
  patch: { content: string; category?: MemoryCategory },
  actor: FactActor,
): Promise<{ ok: boolean; updated: boolean; error?: string }> {
  if (!UUID_RX.test(propertyId) || !UUID_RX.test(id)) {
    return { ok: false, updated: false, error: 'bad id' };
  }
  const content = patch.content.trim();
  if (!content || content.length > 500) {
    return { ok: false, updated: false, error: 'bad content' };
  }
  const { data, error } = await supabaseAdmin
    .from('agent_memory')
    .update({
      content,
      ...(patch.category ? { category: patch.category } : {}),
      source: 'correction',
      review_state: 'confirmed',
      confidence: 'high',
      expires_at: null,
      created_by_account_id: actor.accountId,
      created_by_name: actor.name,
      created_by_role: actor.role,
      updated_at: new Date().toISOString(),
    })
    .eq('property_id', propertyId)
    .eq('id', id)
    .eq('is_active', true)
    .select('id');
  if (error) return { ok: false, updated: false, error: error.message };
  return { ok: true, updated: (data ?? []).length > 0 };
}

/**
 * REMOVE — soft-delete ANY active fact for this property.
 *
 * Deliberately wider than deactivateMemoryById above, which is restricted to
 * auto-learned sources because the DASHBOARD card it serves shows only those
 * and a stray tap there must not destroy a manager's own note. The Knows screen
 * is the opposite surface: it shows everything and its entire purpose is "tell
 * me if I'm wrong", so it must be able to remove a fact the manager themselves
 * once stated. The row is retained (is_active=false) for audit, and the
 * removed-topics list is what stops it being re-learned.
 */
export async function removeMemoryFact(
  propertyId: string,
  id: string,
): Promise<{ ok: boolean; removed: boolean; error?: string }> {
  if (!UUID_RX.test(propertyId) || !UUID_RX.test(id)) {
    return { ok: false, removed: false, error: 'bad id' };
  }
  const { data, error } = await supabaseAdmin
    .from('agent_memory')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('property_id', propertyId)
    .eq('id', id)
    .eq('is_active', true)
    .select('id');
  if (error) return { ok: false, removed: false, error: error.message };
  return { ok: true, removed: (data ?? []).length > 0 };
}
