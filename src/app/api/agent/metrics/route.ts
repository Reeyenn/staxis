// ─── GET /api/agent/metrics ────────────────────────────────────────────────
// Powers the /admin/agent monitoring page. Returns today's spend, recent
// conversations, error counts, p50/p95 latency, top tools called. Admin-only.

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { COST_LIMITS } from '@/lib/agent/cost-controls';
import { archivalMetrics } from '@/lib/agent/archival';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface MetricsPayload {
  caps: {
    user: number;
    property: number;
    global: number;
  };
  today: {
    totalCostUsd: number;
    requestCount: number;
    evalCostUsd: number;
    uniqueUsers: number;
    uniqueProperties: number;
    /** % of input tokens served from cache today (Codex review fix G4). */
    cacheHitRatePct: number;
  };
  recentConversations: Array<{
    id: string;
    title: string | null;
    role: string;
    promptVersion: string | null;
    updatedAt: string;
    messageCount: number;
  }>;
  topTools: Array<{ tool: string; calls: number; errors: number; incomplete: number; errorRatePct: number }>;
  /** Total tool errors today across all tools.
   *  L8B, 2026-05-13. */
  toolErrorsToday: number;
  /** Total tool_use rows today that have NO matching tool_result row.
   *  Aborts, mid-stream kills, or transient persist failures. Surfaced
   *  separately so a missing row doesn't silently count as success.
   *  Round 10 F3b, 2026-05-13. */
  toolIncompleteToday: number;
  modelUsage: Array<{ model: string; count: number; costUsd: number }>;
  /** Distinct Anthropic snapshot IDs seen today, newest first. When this
   *  list changes from one day to the next, Anthropic shipped a new
   *  snapshot of the model alias — worth re-running evals. Codex fix G9. */
  modelIdsToday: Array<{ modelId: string; count: number }>;
  pendingNudges: number;
  /** Count of agent_costs rows stuck in 'reserved' state for >5 minutes.
   *  A non-zero number means either the cron sweeper isn't running OR
   *  finalize+cancel are both failing — operator should investigate.
   *  Codex round-5 fix R2, 2026-05-13. */
  staleReservations: number;
  /** Count of reservations that the sweeper had to recover today.
   *  Non-zero means the sweeper IS running but finalize+cancel keep
   *  failing — recurring failures that staleReservations alone would
   *  hide between sweep runs. Codex round-6 fix R6, 2026-05-13. */
  sweptToday: number;
  /** Count of permanent finalize-RPC failures today (after 3 inline
   *  retries). Non-zero ⇒ Anthropic billed us but the cost ledger
   *  has no record; the audit table agent_cost_finalize_failures
   *  has the actual usage payload for reconciliation.
   *  Codex round-7 fix F1, 2026-05-13. */
  finalizeFailuresToday: number;
  /** L4 part A: archival metrics. Longevity 2026-05-13. */
  archivedTotal: number;
  archivedToday: number;
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const dayStartIso = dayStart.toISOString();

  try {
    // Costs today — only finalized rows that the sweeper did NOT touch.
    // Reservation ('reserved') rows have model='pending' and cost_usd=
    // reservation amount. Swept rows (Codex round-6 R6) are also state=
    // 'finalized' but represent recovered-from-failure events, not real
    // requests. Including either would skew today's spend + cache math.
    // Codex review fix B6 (2026-05-13) + round-6 R6 (swept_at filter).
    const { data: costs } = await supabaseAdmin
      .from('agent_costs')
      .select('cost_usd, kind, user_id, property_id, model, model_id, state, tokens_in, cached_input_tokens, swept_at')
      .eq('state', 'finalized')
      .is('swept_at', null)
      .gte('created_at', dayStartIso);

    const requestCosts = (costs ?? []).filter(c => c.kind === 'request');
    const evalCosts = (costs ?? []).filter(c => c.kind === 'eval');

    const totalCostUsd = requestCosts.reduce((acc, r) => acc + Number(r.cost_usd ?? 0), 0);
    const evalCostUsd = evalCosts.reduce((acc, r) => acc + Number(r.cost_usd ?? 0), 0);
    const uniqueUsers = new Set(requestCosts.map(r => r.user_id as string)).size;
    const uniqueProperties = new Set(requestCosts.map(r => r.property_id as string)).size;

    // Cache hit rate (Codex fix G4): cached_input_tokens / (cached + fresh
    // input). Fresh input = tokens_in (which is the FRESH input tokens not
    // already cached). Higher is better — proves the prompt cache is
    // hitting and we're not paying full input price every turn.
    const totalCached = requestCosts.reduce((acc, r) => acc + Number(r.cached_input_tokens ?? 0), 0);
    const totalFresh = requestCosts.reduce((acc, r) => acc + Number(r.tokens_in ?? 0), 0);
    const cacheHitRatePct = totalCached + totalFresh > 0
      ? Math.round((totalCached / (totalCached + totalFresh)) * 1000) / 10
      : 0;

    // Distinct Anthropic snapshot IDs seen today (Codex fix G9). When this
    // list changes day-to-day, Anthropic shipped a new model snapshot;
    // re-run evals to catch behaviour drift.
    const byModelId = new Map<string, number>();
    for (const c of requestCosts) {
      const id = (c.model_id as string) ?? '(none)';
      byModelId.set(id, (byModelId.get(id) ?? 0) + 1);
    }
    const modelIdsToday = Array.from(byModelId.entries())
      .map(([modelId, count]) => ({ modelId, count }))
      .sort((a, b) => b.count - a.count);

    // Model usage breakdown
    const byModel = new Map<string, { count: number; costUsd: number }>();
    for (const c of requestCosts) {
      const m = (c.model as string) ?? 'unknown';
      const prev = byModel.get(m) ?? { count: 0, costUsd: 0 };
      prev.count++;
      prev.costUsd += Number(c.cost_usd ?? 0);
      byModel.set(m, prev);
    }
    const modelUsage = Array.from(byModel.entries())
      .map(([model, v]) => ({ model, count: v.count, costUsd: Math.round(v.costUsd * 10000) / 10000 }))
      .sort((a, b) => b.count - a.count);

    // Recent conversations + message counts
    const { data: convoRows } = await supabaseAdmin
      .from('agent_conversations')
      .select('id, title, role, prompt_version, updated_at')
      .order('updated_at', { ascending: false })
      .limit(15);

    const convoIds = (convoRows ?? []).map(c => c.id as string);
    const messageCountsMap = new Map<string, number>();
    if (convoIds.length) {
      const { data: msgRows } = await supabaseAdmin
        .from('agent_messages')
        .select('conversation_id, tool_name')
        .in('conversation_id', convoIds);
      for (const r of msgRows ?? []) {
        const id = r.conversation_id as string;
        messageCountsMap.set(id, (messageCountsMap.get(id) ?? 0) + 1);
      }
    }

    const recentConversations = (convoRows ?? []).map(c => ({
      id: c.id as string,
      title: (c.title as string) ?? null,
      role: c.role as string,
      promptVersion: (c.prompt_version as string) ?? null,
      updatedAt: c.updated_at as string,
      messageCount: messageCountsMap.get(c.id as string) ?? 0,
    }));

    // Top tools called today (across all conversations) + per-tool
    // error rate (L8B, 2026-05-13). We fetch both the assistant
    // tool_use rows (carry tool_name) AND the tool result rows (carry
    // is_error) in one query each, then join in JS by tool_call_id +
    // conversation_id. Cheap at scale because both queries hit indexed
    // columns and the join is in-memory over ~hundreds of rows/day.
    const { data: toolMsgs } = await supabaseAdmin
      .from('agent_messages')
      .select('tool_name, tool_call_id, conversation_id')
      .not('tool_name', 'is', null)
      .gte('created_at', dayStartIso);

    const { data: toolResultRows } = await supabaseAdmin
      .from('agent_messages')
      .select('tool_call_id, conversation_id, is_error')
      .eq('role', 'tool')
      .gte('created_at', dayStartIso);

    // Build a lookup: (conversation_id, tool_call_id) → is_error.
    // F3b (Round 10): we need to distinguish three states, not two:
    //   - row present with is_error=true     → error
    //   - row present with is_error=false    → success
    //   - row MISSING                        → incomplete (abort,
    //                                          stream killed mid-tool,
    //                                          or persist failure)
    // Previously, missing rows defaulted to is_error=false and were
    // silently counted as success — masking real failures. Now we
    // surface them as a separate bucket on the admin page.
    const resultLookup = new Map<string, boolean>(); // present rows only
    for (const r of toolResultRows ?? []) {
      const key = `${r.conversation_id as string}:${r.tool_call_id as string}`;
      resultLookup.set(key, (r.is_error as boolean) === true);
    }

    interface ToolStats { calls: number; errors: number; incomplete: number }
    const toolStats = new Map<string, ToolStats>();
    let toolErrorsToday = 0;
    let toolIncompleteToday = 0;
    for (const m of toolMsgs ?? []) {
      const name = m.tool_name as string;
      const key = `${m.conversation_id as string}:${m.tool_call_id as string}`;
      const present = resultLookup.has(key);
      const isErr = present && resultLookup.get(key) === true;
      const prev = toolStats.get(name) ?? { calls: 0, errors: 0, incomplete: 0 };
      prev.calls += 1;
      if (!present) {
        prev.incomplete += 1;
        toolIncompleteToday += 1;
      } else if (isErr) {
        prev.errors += 1;
        toolErrorsToday += 1;
      }
      toolStats.set(name, prev);
    }
    const topTools = Array.from(toolStats.entries())
      .map(([tool, s]) => ({
        tool,
        calls: s.calls,
        errors: s.errors,
        incomplete: s.incomplete,
        errorRatePct: s.calls > 0 ? Math.round((s.errors / s.calls) * 1000) / 10 : 0,
      }))
      .sort((a, b) => b.calls - a.calls)
      .slice(0, 10);

    // Pending nudges (cluster-wide)
    const { count: pendingNudges } = await supabaseAdmin
      .from('agent_nudges')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending');

    // Codex round-5 fix R2 + round-6 fix R6: stuck-reservation count plus
    // swept-today count. Together they give the operator visibility into
    // BOTH "currently stuck" (between sweep runs) AND "kept getting swept
    // today" (recurring failures the staleReservations metric alone hides).
    const { data: staleData } = await supabaseAdmin.rpc('staxis_count_stale_reservations', {
      p_max_age_minutes: 5,
    });
    const staleReservations = Number(staleData ?? 0);

    const { data: sweptData } = await supabaseAdmin.rpc('staxis_count_swept_today');
    const sweptToday = Number(sweptData ?? 0);

    // Codex round-7 fix F1: count permanent finalize failures so the
    // operator sees them even when the actual spend was cancelled to
    // release the budget hold. Non-zero needs investigation.
    const { data: failData } = await supabaseAdmin.rpc('staxis_count_finalize_failures_today');
    const finalizeFailuresToday = Number(failData ?? 0);

    // L4 part A: archived conversation counts.
    const { archivedTotal, archivedToday } = await archivalMetrics();

    const payload: MetricsPayload = {
      caps: {
        user: COST_LIMITS.userDailyUsd,
        property: COST_LIMITS.propertyDailyUsd,
        global: COST_LIMITS.globalDailyUsd,
      },
      today: {
        totalCostUsd: Math.round(totalCostUsd * 10000) / 10000,
        requestCount: requestCosts.length,
        evalCostUsd: Math.round(evalCostUsd * 10000) / 10000,
        uniqueUsers,
        uniqueProperties,
        cacheHitRatePct,
      },
      recentConversations,
      topTools,
      modelUsage,
      modelIdsToday,
      pendingNudges: pendingNudges ?? 0,
      staleReservations,
      sweptToday,
      finalizeFailuresToday,
      toolErrorsToday,
      toolIncompleteToday,
      archivedTotal,
      archivedToday,
    };

    return ok(payload, { requestId });
  } catch (e) {
    log.error('[agent/metrics] failed to load metrics', { requestId, e });
    return err('failed to load metrics', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
      details: e instanceof Error ? e.message : String(e),
    });
  }
}
