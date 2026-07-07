// ─── agent_pending_actions persistence (migration 0300) ────────────────────
//
// The durable side of the AI-assistant approval gate. When Claude proposes a
// mutation, the chat route calls createPendingActions() to persist one row per
// proposed tool_use, then streams a card to the browser. The resolve route
// (/api/agent/command/resolve-action) reads a row, executes or denies it, and
// asks allActionsResolved() whether the whole assistant turn can now resume.
//
// All access is service-role (supabaseAdmin) — the table is deny-all RLS. Row
// ownership + scope checks live in the resolve route, not here.

import { supabaseAdmin } from '@/lib/supabase-admin';

export type PendingTier = 'quick' | 'card';
export type PendingStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'executed' | 'failed';

export interface PendingActionRow {
  id: string;
  propertyId: string;
  conversationId: string;
  accountId: string;
  turnKey: string;
  toolCallId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  tier: PendingTier;
  status: PendingStatus;
  result: unknown;
  error: string | null;
  createdAt: string;
  resolvedAt: string | null;
  expiresAt: string;
}

export interface NewPendingAction {
  toolCallId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  tier: PendingTier;
}

function mapRow(r: Record<string, unknown>): PendingActionRow {
  return {
    id: r.id as string,
    propertyId: r.property_id as string,
    conversationId: r.conversation_id as string,
    accountId: r.account_id as string,
    turnKey: r.turn_key as string,
    toolCallId: r.tool_call_id as string,
    toolName: r.tool_name as string,
    toolArgs: (r.tool_args as Record<string, unknown>) ?? {},
    tier: r.tier as PendingTier,
    status: r.status as PendingStatus,
    result: r.result ?? null,
    error: (r.error as string | null) ?? null,
    createdAt: r.created_at as string,
    resolvedAt: (r.resolved_at as string | null) ?? null,
    expiresAt: r.expires_at as string,
  };
}

/**
 * Persist one pending row per proposed mutation of a single assistant turn.
 * `turnKey` groups them (the turn's first tool_call_id) so the resume gate can
 * tell when every sibling is resolved. Returns the created rows in call order.
 *
 * Uses upsert (ON CONFLICT DO NOTHING on the (conversation_id, tool_call_id)
 * unique index) so a stream retry that re-proposes the same tool_use doesn't
 * throw — the existing pending row is left as-is and re-read.
 */
export async function createPendingActions(opts: {
  propertyId: string;
  conversationId: string;
  accountId: string;
  turnKey: string;
  actions: NewPendingAction[];
}): Promise<PendingActionRow[]> {
  if (opts.actions.length === 0) return [];
  const payload = opts.actions.map((a) => ({
    property_id: opts.propertyId,
    conversation_id: opts.conversationId,
    account_id: opts.accountId,
    turn_key: opts.turnKey,
    tool_call_id: a.toolCallId,
    tool_name: a.toolName,
    tool_args: a.toolArgs ?? {},
    tier: a.tier,
    status: 'pending' as const,
  }));
  // Select the upserted rows in the SAME round-trip. With ignoreDuplicates the
  // insert path returns the freshly-created rows directly; a separate re-read is
  // only needed when a conflict suppressed some rows (an idempotent stream
  // retry), which returns fewer rows than we asked for.
  const callIds = opts.actions.map((a) => a.toolCallId);
  const { data: upserted, error } = await supabaseAdmin
    .from('agent_pending_actions')
    .upsert(payload, { onConflict: 'conversation_id,tool_call_id', ignoreDuplicates: true })
    .select('*');
  if (error) throw new Error(`createPendingActions failed: ${error.message}`);

  const byId = new Map((upserted ?? []).map((r) => [r.tool_call_id as string, mapRow(r)]));

  // If some rows were suppressed as duplicates (retry), re-read just those so
  // the caller still gets server-truth ids/expires_at for every requested id.
  if (byId.size < callIds.length) {
    const missing = callIds.filter((id) => !byId.has(id));
    const { data, error: readErr } = await supabaseAdmin
      .from('agent_pending_actions')
      .select('*')
      .eq('conversation_id', opts.conversationId)
      .in('tool_call_id', missing);
    if (readErr) throw new Error(`createPendingActions read-back failed: ${readErr.message}`);
    for (const r of data ?? []) byId.set(r.tool_call_id as string, mapRow(r));
  }

  // Preserve the caller's order.
  return callIds.map((id) => byId.get(id)).filter((r): r is PendingActionRow => !!r);
}

/** Load a single pending row by its id. Returns null when absent. */
export async function getPendingAction(id: string): Promise<PendingActionRow | null> {
  const { data, error } = await supabaseAdmin
    .from('agent_pending_actions')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`getPendingAction failed: ${error.message}`);
  return data ? mapRow(data) : null;
}

/**
 * Atomically claim a pending row for resolution: flip pending → the given
 * intermediate status ('approved' | 'denied') only if it is still 'pending'.
 * Returns the updated row, or null when it was already resolved / not pending
 * (single-use guard against a double-tap or a race between two tabs).
 */
export async function claimPendingAction(
  id: string,
  to: 'approved' | 'denied',
): Promise<PendingActionRow | null> {
  const { data, error } = await supabaseAdmin
    .from('agent_pending_actions')
    .update({ status: to, resolved_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'pending')
    .select('*')
    .maybeSingle();
  if (error) throw new Error(`claimPendingAction failed: ${error.message}`);
  return data ? mapRow(data) : null;
}

/**
 * Record a terminal outcome for a claimed action:
 *   - 'executed' / 'failed' — the tool ran (or errored) after approval.
 *   - 'denied' — the user declined. A first-class terminal status so denials
 *     stay queryable (allActionsResolved treats it as terminal; the DB CHECK
 *     allows it) rather than being masked as a generic 'failed'.
 */
export async function finalizePendingAction(opts: {
  id: string;
  status: 'executed' | 'failed' | 'denied';
  result?: unknown;
  error?: string | null;
}): Promise<void> {
  const { error } = await supabaseAdmin
    .from('agent_pending_actions')
    .update({
      status: opts.status,
      result: opts.result === undefined ? null : opts.result,
      error: opts.error ?? null,
      resolved_at: new Date().toISOString(),
    })
    .eq('id', opts.id);
  if (error) throw new Error(`finalizePendingAction failed: ${error.message}`);
}

/**
 * Lazily expire a pending row whose TTL has passed. Returns true when it flipped
 * a still-pending row to 'expired' (i.e. the caller should treat it as expired).
 * Single-flight via the status guard so a concurrent resolve can't also claim it.
 */
export async function expireIfStale(row: PendingActionRow): Promise<boolean> {
  if (row.status !== 'pending') return false;
  if (new Date(row.expiresAt).getTime() > Date.now()) return false;
  const { data, error } = await supabaseAdmin
    .from('agent_pending_actions')
    .update({ status: 'expired', resolved_at: new Date().toISOString() })
    .eq('id', row.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();
  if (error) throw new Error(`expireIfStale failed: ${error.message}`);
  return !!data;
}

/**
 * Sweep every UNRESOLVED (still 'pending') action of a conversation to
 * 'expired' in one UPDATE, returning the rows that were flipped. Called at the
 * start of a NEW user turn: if the user sends a fresh message while cards are
 * still up, those proposals are superseded — the hotel state they were built
 * against has moved on. Flipping them to a terminal status stops an orphaned
 * card from being approved later, and the caller persists a synthetic
 * tool_result per tool_call_id so the abandoned assistant turn's tool_use blocks
 * don't dangle on replay.
 *
 * Only 'pending' rows are swept — an 'approved' row is mid-resolution (its
 * resolve request owns it) and must not be yanked out from under that flow.
 */
export async function sweepConversationPending(conversationId: string): Promise<PendingActionRow[]> {
  const { data, error } = await supabaseAdmin
    .from('agent_pending_actions')
    .update({ status: 'expired', resolved_at: new Date().toISOString() })
    .eq('conversation_id', conversationId)
    .eq('status', 'pending')
    .select('*');
  if (error) throw new Error(`sweepConversationPending failed: ${error.message}`);
  return (data ?? []).map(mapRow);
}

/**
 * Still-pending, non-expired rows for a conversation — used to REHYDRATE cards
 * on a page reload / conversation switch. The lazy TTL means a row can be
 * past-expiry but still status='pending' in the DB; we filter those out in JS so
 * a reload never surfaces a card the resolve route would immediately 409.
 */
export async function getLivePendingActions(conversationId: string): Promise<PendingActionRow[]> {
  const { data, error } = await supabaseAdmin
    .from('agent_pending_actions')
    .select('*')
    .eq('conversation_id', conversationId)
    .eq('status', 'pending')
    .order('created_at', { ascending: true });
  if (error) throw new Error(`getLivePendingActions failed: ${error.message}`);
  const now = Date.now();
  return (data ?? [])
    .map(mapRow)
    .filter((r) => new Date(r.expiresAt).getTime() > now);
}

/**
 * Reap rows STUCK in the intermediate 'approved' state past a grace period.
 *
 * A voice confirm claims a row pending → 'approved' and then runs the held tool;
 * if the function is killed between the claim and the finalize (Vercel
 * maxDuration, crash), the row is left 'approved' — neither 'pending' (so it's
 * invisible to getLivePendingActions and to the expires_at partial index, which
 * only covers status='pending') nor terminal (so it never expires). It would
 * linger forever. This flips any such row whose claim is older than
 * `graceMs` to 'failed' so it becomes terminal. Scoped to one conversation and
 * called best-effort at the start of a voice turn. Returns the reaped rows.
 */
export async function reapStaleApprovedActions(
  conversationId: string,
  graceMs = 2 * 60_000,
): Promise<PendingActionRow[]> {
  const cutoff = new Date(Date.now() - graceMs).toISOString();
  const { data, error } = await supabaseAdmin
    .from('agent_pending_actions')
    .update({
      status: 'failed',
      error: 'abandoned mid-confirmation (claimed but never finalized)',
      resolved_at: new Date().toISOString(),
    })
    .eq('conversation_id', conversationId)
    .eq('status', 'approved')
    .lt('resolved_at', cutoff)
    .select('*');
  if (error) throw new Error(`reapStaleApprovedActions failed: ${error.message}`);
  return (data ?? []).map(mapRow);
}

/** All pending-action rows for one assistant turn (grouped by turn_key). */
export async function getTurnActions(conversationId: string, turnKey: string): Promise<PendingActionRow[]> {
  const { data, error } = await supabaseAdmin
    .from('agent_pending_actions')
    .select('*')
    .eq('conversation_id', conversationId)
    .eq('turn_key', turnKey)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`getTurnActions failed: ${error.message}`);
  return (data ?? []).map(mapRow);
}

/**
 * Has every action in this assistant turn reached a terminal state? Resume is
 * only safe when NONE remain 'pending' or 'approved' (approved means claimed but
 * not yet executed — its tool_result isn't ready). Terminal = executed | failed
 * | denied | expired.
 */
export function allActionsResolved(rows: PendingActionRow[]): boolean {
  return rows.length > 0 && rows.every(
    (r) => r.status === 'executed' || r.status === 'failed' || r.status === 'denied' || r.status === 'expired',
  );
}

/**
 * Atomically claim the right to resume the model for a turn. Stamps every row
 * of the turn (WHERE resume_claimed_at IS NULL) in ONE UPDATE and returns the
 * claimed rows. Under Postgres row locks only ONE concurrent caller sees rows
 * back; every other caller gets []. The winner streams the follow-up; the
 * losers back off. This is the single-flight guard that stops two cards
 * approved at the same instant from double-resuming or dead-locking the turn.
 *
 * Returns the full row set (all siblings) when this caller won the claim, or
 * null when another resolver already claimed it (or nothing matched).
 */
export async function claimTurnResume(
  conversationId: string,
  turnKey: string,
): Promise<PendingActionRow[] | null> {
  const { data, error } = await supabaseAdmin
    .from('agent_pending_actions')
    .update({ resume_claimed_at: new Date().toISOString() })
    .eq('conversation_id', conversationId)
    .eq('turn_key', turnKey)
    .is('resume_claimed_at', null)
    .select('*');
  if (error) throw new Error(`claimTurnResume failed: ${error.message}`);
  const rows = (data ?? []).map(mapRow);
  return rows.length > 0 ? rows : null;
}

/**
 * Best-effort release of a resume claim: clear resume_claimed_at back to NULL
 * for every row of the turn. Called when the resume stream throws AFTER a
 * successful claimTurnResume — without this nothing ever un-stamps the claim and
 * the turn is permanently stuck (every later resolve sees the claim taken and
 * backs off). Idempotent; safe to call even when no rows are stamped.
 */
export async function releaseTurnResume(
  conversationId: string,
  turnKey: string,
): Promise<void> {
  const { error } = await supabaseAdmin
    .from('agent_pending_actions')
    .update({ resume_claimed_at: null })
    .eq('conversation_id', conversationId)
    .eq('turn_key', turnKey);
  if (error) throw new Error(`releaseTurnResume failed: ${error.message}`);
}

/**
 * Siblings that reached a terminal state WITHOUT the resolve route writing a
 * tool_result — specifically 'expired' rows (they flip to expired on the lazy
 * sweep with no result persisted, unlike executed/failed/denied which the route
 * always follows with a recordToolResult). The resume path must synthesize a
 * tool_result for each of these BEFORE resuming, or the replayed assistant turn
 * carries a dangling tool_use and Anthropic rejects it. Returns the expired
 * rows so the caller can persist a synthetic "expired" result per tool_call_id.
 */
export function expiredWithoutResult(rows: PendingActionRow[]): PendingActionRow[] {
  return rows.filter((r) => r.status === 'expired');
}
