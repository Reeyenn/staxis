// ─── GET /api/agent/metrics ────────────────────────────────────────────────
// Powers the /admin/agent monitoring page. Returns today's spend, recent
// conversations, error counts, p50/p95 latency, top tools called. Admin-only.

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { COST_LIMITS } from '@/lib/agent/cost-controls';

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
  topTools: Array<{ tool: string; calls: number }>;
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

    // Top tools called today (across all conversations)
    const { data: toolMsgs } = await supabaseAdmin
      .from('agent_messages')
      .select('tool_name')
      .not('tool_name', 'is', null)
      .gte('created_at', dayStartIso);

    const toolCounts = new Map<string, number>();
    for (const m of toolMsgs ?? []) {
      const name = m.tool_name as string;
      toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
    }
    const topTools = Array.from(toolCounts.entries())
      .map(([tool, calls]) => ({ tool, calls }))
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
    };

    return ok(payload, { requestId });
  } catch (e) {
    return err('failed to load metrics', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
      details: e instanceof Error ? e.message : String(e),
    });
  }
}
