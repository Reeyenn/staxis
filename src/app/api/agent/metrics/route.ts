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
  pendingNudges: number;
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const dayStartIso = dayStart.toISOString();

  try {
    // Costs today
    const { data: costs } = await supabaseAdmin
      .from('agent_costs')
      .select('cost_usd, kind, user_id, property_id, model')
      .gte('created_at', dayStartIso);

    const requestCosts = (costs ?? []).filter(c => c.kind === 'request');
    const evalCosts = (costs ?? []).filter(c => c.kind === 'eval');

    const totalCostUsd = requestCosts.reduce((acc, r) => acc + Number(r.cost_usd ?? 0), 0);
    const evalCostUsd = evalCosts.reduce((acc, r) => acc + Number(r.cost_usd ?? 0), 0);
    const uniqueUsers = new Set(requestCosts.map(r => r.user_id as string)).size;
    const uniqueProperties = new Set(requestCosts.map(r => r.property_id as string)).size;

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
      },
      recentConversations,
      topTools,
      modelUsage,
      pendingNudges: pendingNudges ?? 0,
    };

    return ok(payload, { requestId });
  } catch (e) {
    return err('failed to load metrics', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
      details: e instanceof Error ? e.message : String(e),
    });
  }
}
