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

export type MemoryScope = 'property' | 'user';
export type MemorySource = 'explicit_user' | 'inferred' | 'correction' | 'consolidation';
export type MemoryConfidence = 'low' | 'normal' | 'high';
export type StoreMemoryAction = 'inserted' | 'updated' | 'property_full' | 'user_full';

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
}

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SELECT_COLS =
  'id, scope, topic, content, source, confidence, created_by_role, created_by_name, subject_account_id, updated_at';

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
  };
}

/**
 * Active, non-expired memory for one turn: all property-scope rows for the hotel
 * PLUS this user's own user-scope rows. Capped at 200 (ranking + token-budget
 * trimming happens in memory-context.ts). subjectAccountId may be null (a user
 * with no account row) — then only property-scope memory is returned.
 */
export async function getActiveMemoryForTurn(
  propertyId: string,
  subjectAccountId: string | null,
): Promise<MemoryRow[]> {
  if (!UUID_RX.test(propertyId)) return [];
  const nowIso = new Date().toISOString();

  let q = supabaseAdmin
    .from('agent_memory')
    .select(SELECT_COLS)
    .eq('property_id', propertyId)
    .eq('is_active', true)
    .or(`expires_at.is.null,expires_at.gt.${nowIso}`);

  if (subjectAccountId && UUID_RX.test(subjectAccountId)) {
    // property-scope (shared) OR this user's own user-scope rows.
    q = q.or(`scope.eq.property,and(scope.eq.user,subject_account_id.eq.${subjectAccountId})`);
  } else {
    q = q.eq('scope', 'property');
  }

  const { data, error } = await q.limit(200);
  if (error || !data) return [];
  return (data as RawRow[]).map(mapRow);
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
  return {
    ok: true,
    action: row?.action as StoreMemoryAction | undefined,
    memoryId: (row?.memory_id as string | null) ?? null,
  };
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
}

/** Most recent nightly consolidation run for a property (dashboard recap header). */
export async function getLatestConsolidation(propertyId: string): Promise<ConsolidationRecap | null> {
  if (!UUID_RX.test(propertyId)) return null;
  const { data, error } = await supabaseAdmin
    .from('agent_memory_consolidations')
    .select('recap, ran_at, learned_count, updated_count')
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
    .eq('source', 'consolidation')
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (error || !data) return [];
  return (data as RawRow[]).map(mapRow);
}

/** Soft-delete a memory by id, scoped to the property (the dashboard "remove"). */
export async function deactivateMemoryById(
  propertyId: string,
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!UUID_RX.test(propertyId) || !UUID_RX.test(id)) return { ok: false, error: 'bad id' };
  const { error } = await supabaseAdmin
    .from('agent_memory')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('property_id', propertyId)
    .eq('id', id)
    .eq('is_active', true);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
