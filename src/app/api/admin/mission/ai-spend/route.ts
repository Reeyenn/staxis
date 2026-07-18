/**
 * /api/admin/mission/ai-spend
 *
 * The AI-spend screen behind Mission Control's "AI spend today" light.
 * Two forms of spend, kept strictly separate (owner ask 2026-07-18):
 *
 *   1. Hotel AI — what Staxis burns serving hotels. The REAL dollars come
 *      from Anthropic's Cost Admin API (never estimated — owner rule),
 *      grouped by workspace: the default workspace is the hotel product
 *      today; the "AI employees" workspace exists for future employee keys
 *      so their spend lands in its own bucket from day one.
 *   2. Running Staxis — the AI the founder pays for personally (Claude
 *      plan, Codex, …). Flat monthly subscriptions, stored on
 *      app_settings.ai_subscriptions (0318), edited via POST here.
 *
 * GET  → { connected, billing|null, learning, subscriptions }
 *   - connected=false when ANTHROPIC_ADMIN_KEY isn't configured (or the
 *     billing fetch failed) — the UI still renders our own meters and
 *     shows a "billing feed not connected" note instead of fake numbers.
 *   - billing: today / this month in USD, per-workspace month totals.
 *     Anthropic reports amounts as decimal strings in CENTS, daily
 *     buckets (UTC), fresh within ~5 minutes.
 *   - learning: month-to-date map-learning (mapper.*) cost from
 *     workflow_jobs — our own measured meter, shown as a breakdown line.
 *   - Per-robot today + Copilot today are NOT here: the surface already
 *     has both live (cua-sessions + agent metrics feeds).
 *
 * POST { subscriptions: [{ name, monthlyUsd }] } → saves the list.
 *
 * Auth + envelope mirror the other /api/admin/mission/* routes.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdminOrCron } from '@/lib/admin-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const ANTHROPIC_BASE = 'https://api.anthropic.com';

interface SubscriptionLine { id: string; name: string; monthlyUsd: number }

interface WorkspaceSpend {
  /** null = the default workspace (the hotel product's key lives there). */
  workspaceId: string | null;
  name: string;
  monthUsd: number;
  todayUsd: number;
}

interface Billing {
  todayUsd: number;
  monthUsd: number;
  byWorkspace: WorkspaceSpend[];
  /** Prepaid credit balance is not exposed by the API — console only. */
  monthStart: string;
}

/** One daily bucket from /v1/organizations/cost_report. */
interface CostBucket {
  starting_at: string;
  ending_at: string;
  results: Array<{ currency: string; amount: string; workspace_id: string | null }>;
}

async function anthropicAdminGet(path: string, adminKey: string): Promise<Response> {
  return fetch(`${ANTHROPIC_BASE}${path}`, {
    headers: {
      'x-api-key': adminKey,
      'anthropic-version': '2023-06-01',
      'User-Agent': 'Staxis-MissionControl/1.0 (https://getstaxis.com)',
    },
    // Billing data is ~5 min fresh; no need to bust caches aggressively.
    cache: 'no-store',
  });
}

/**
 * Pull month-to-date daily cost buckets grouped by workspace and fold them
 * into today/month totals. Amounts arrive as decimal strings in cents.
 */
async function fetchBilling(adminKey: string): Promise<Billing | null> {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const tomorrow = new Date(todayStart.getTime() + 86_400_000);

  // Workspace names (one small page is plenty at this fleet size).
  const wsNames = new Map<string, string>();
  try {
    const wsRes = await anthropicAdminGet('/v1/organizations/workspaces?limit=100', adminKey);
    if (wsRes.ok) {
      const wsJson = (await wsRes.json()) as { data?: Array<{ id: string; name: string }> };
      for (const w of wsJson.data ?? []) wsNames.set(w.id, w.name);
    }
  } catch { /* names are cosmetic — fall back to ids */ }

  const params = new URLSearchParams({
    starting_at: monthStart.toISOString(),
    ending_at: tomorrow.toISOString(),
    limit: '31',
  });
  params.append('group_by[]', 'workspace_id');

  const buckets: CostBucket[] = [];
  let page: string | null = null;
  for (let i = 0; i < 5; i++) {
    const url = `/v1/organizations/cost_report?${params.toString()}${page ? `&page=${encodeURIComponent(page)}` : ''}`;
    const res = await anthropicAdminGet(url, adminKey);
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: CostBucket[]; has_more?: boolean; next_page?: string | null };
    buckets.push(...(json.data ?? []));
    if (!json.has_more || !json.next_page) break;
    page = json.next_page;
  }

  const byWs = new Map<string | null, { monthUsd: number; todayUsd: number }>();
  let todayUsd = 0;
  let monthUsd = 0;
  for (const bucket of buckets) {
    const isToday = new Date(bucket.starting_at).getTime() >= todayStart.getTime();
    for (const r of bucket.results ?? []) {
      const usd = (parseFloat(r.amount) || 0) / 100; // cents → dollars
      monthUsd += usd;
      if (isToday) todayUsd += usd;
      const entry = byWs.get(r.workspace_id) ?? { monthUsd: 0, todayUsd: 0 };
      entry.monthUsd += usd;
      if (isToday) entry.todayUsd += usd;
      byWs.set(r.workspace_id, entry);
    }
  }

  // Every known workspace shows up even at $0 — the owner wants the
  // "AI employees" bucket visible before it ever spends a cent.
  for (const [id] of wsNames) if (!byWs.has(id)) byWs.set(id, { monthUsd: 0, todayUsd: 0 });
  if (!byWs.has(null)) byWs.set(null, { monthUsd: 0, todayUsd: 0 });

  const byWorkspace: WorkspaceSpend[] = [...byWs.entries()]
    .map(([workspaceId, v]) => ({
      workspaceId,
      name: workspaceId === null ? 'Hotel AI' : (wsNames.get(workspaceId) ?? workspaceId),
      monthUsd: Math.round(v.monthUsd * 100) / 100,
      todayUsd: Math.round(v.todayUsd * 100) / 100,
    }))
    .sort((a, b) => b.monthUsd - a.monthUsd);

  return {
    todayUsd: Math.round(todayUsd * 100) / 100,
    monthUsd: Math.round(monthUsd * 100) / 100,
    byWorkspace,
    monthStart: monthStart.toISOString(),
  };
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const auth = await requireAdminOrCron(req);
  if (!auth.ok) return err('Admin sign-in required.', { requestId, status: 401, code: 'unauthorized' });

  const now = new Date();
  const monthStartIso = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

  // Our own measured meter: map-learning runs this month (mapper.* jobs
  // record their real per-call Claude cost in claude_cost_micros).
  const [learnQ, settingsQ] = await Promise.all([
    supabaseAdmin
      .from('workflow_jobs')
      .select('claude_cost_micros')
      .like('kind', 'mapper.%')
      .gte('created_at', monthStartIso),
    supabaseAdmin
      .from('app_settings')
      .select('ai_subscriptions')
      .eq('id', true)
      .maybeSingle(),
  ]);
  if (learnQ.error) return err(learnQ.error.message, { requestId, status: 500, code: 'internal_error' });

  const learningRows = (learnQ.data ?? []) as Array<{ claude_cost_micros: number | null }>;
  const learning = {
    monthUsd: Math.round(learningRows.reduce((s, r) => s + (r.claude_cost_micros ?? 0), 0) / 10_000) / 100,
    runs: learningRows.length,
  };

  const subscriptions = ((settingsQ.data?.ai_subscriptions ?? []) as SubscriptionLine[])
    .filter((s) => s && typeof s.name === 'string' && typeof s.monthlyUsd === 'number');

  const adminKey = process.env.ANTHROPIC_ADMIN_KEY;
  let billing: Billing | null = null;
  if (adminKey) {
    try { billing = await fetchBilling(adminKey); } catch { billing = null; }
  }

  return ok({
    connected: billing !== null,
    billing,
    learning,
    subscriptions,
  }, { requestId });
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const auth = await requireAdminOrCron(req);
  if (!auth.ok) return err('Admin sign-in required.', { requestId, status: 401, code: 'unauthorized' });

  let body: { subscriptions?: unknown };
  try { body = (await req.json()) as { subscriptions?: unknown }; } catch { body = {}; }

  if (!Array.isArray(body.subscriptions)) {
    return err('subscriptions must be a list', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  if (body.subscriptions.length > 20) {
    return err('too many subscription lines (max 20)', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const cleaned: SubscriptionLine[] = [];
  for (const raw of body.subscriptions as Array<{ id?: unknown; name?: unknown; monthlyUsd?: unknown }>) {
    const name = typeof raw?.name === 'string' ? raw.name.trim().slice(0, 60) : '';
    const monthlyUsd = typeof raw?.monthlyUsd === 'number' && isFinite(raw.monthlyUsd)
      ? Math.max(0, Math.round(raw.monthlyUsd * 100) / 100)
      : NaN;
    if (!name || isNaN(monthlyUsd)) {
      return err('each line needs a name and a monthly dollar amount', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
    cleaned.push({
      id: typeof raw?.id === 'string' && raw.id ? raw.id.slice(0, 40) : `sub_${Math.random().toString(36).slice(2, 10)}`,
      name,
      monthlyUsd,
    });
  }

  const { error } = await supabaseAdmin
    .from('app_settings')
    .update({ ai_subscriptions: cleaned, updated_at: new Date().toISOString() })
    .eq('id', true);
  if (error) return err(error.message, { requestId, status: 500, code: 'internal_error' });

  return ok({ subscriptions: cleaned }, { requestId });
}
