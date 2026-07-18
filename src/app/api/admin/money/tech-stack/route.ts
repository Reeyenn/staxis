/**
 * /api/admin/money/tech-stack
 *
 * The Money tab's tech-stack spend board (owner ask 2026-07-18: "spend for
 * my entire tech stack, automated"). Three kinds of rows, honestly labeled:
 *
 *   1. LIVE-BILLED — Anthropic is the only vendor with a real billing feed
 *      we can read: Cost Admin API dollars (never estimated — owner rule),
 *      split by workspace (Hotel AI vs the "AI employees" bucket).
 *   2. DETECTED — services the app is literally wired to, discovered from
 *      its own configuration (a Resend key present ⇒ Resend is in the
 *      stack). Adding a new integration makes its row appear by itself;
 *      removing one flags any leftover price line as "not detected". Their
 *      prices are flat plans the founder types once.
 *   3. PERSONAL — subscriptions no server can see (Claude plan, Codex, …),
 *      plain typed lines.
 *
 * Flat lines live on app_settings.ai_subscriptions (0318) as
 * { id, name, monthlyUsd, serviceKey? } — serviceKey ties a line to a
 * detected service; lines without one are the personal group.
 *
 * GET  → { connected, billing|null, learning, detected, subscriptions }
 *   billing: Anthropic cost_report month-to-date (daily UTC buckets,
 *   amounts = decimal-string CENTS, ~5 min lag); connected=false without
 *   ANTHROPIC_ADMIN_KEY — the UI says so instead of showing fake numbers.
 * POST { subscriptions: [...] } → saves the flat lines.
 *
 * Auth + envelope mirror the /api/admin/mission/* routes.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdminOrCron } from '@/lib/admin-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { env } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const ANTHROPIC_BASE = 'https://api.anthropic.com';

interface SubscriptionLine { id: string; name: string; monthlyUsd: number; serviceKey?: string }

/**
 * The stack the app can vouch for from its own configuration. `detect`
 * reads only the canonical env module — a service is "in the stack"
 * because the app holds its credentials or demonstrably runs on it.
 * Order = display order on the board.
 */
const KNOWN_SERVICES: Array<{ key: string; name: string; desc: string; detect: () => boolean }> = [
  { key: 'vercel',   name: 'Vercel',        desc: 'Hosts the website and app',                 detect: () => true },
  { key: 'supabase', name: 'Supabase',      desc: 'The database everything lives in',          detect: () => true },
  { key: 'fly',      name: 'Fly.io',        desc: 'Computers the robot & forecasts run on',    detect: () => true },
  { key: 'github',   name: 'GitHub',        desc: 'Stores the code',                           detect: () => true },
  { key: 'domain',   name: 'getstaxis.com', desc: 'The domain name (billed yearly)',           detect: () => true },
  { key: 'openai',   name: 'OpenAI',        desc: 'Voice-to-text for mic dictation',           detect: () => Boolean(env.OPENAI_API_KEY) },
  { key: 'resend',   name: 'Resend',        desc: 'Sends the app’s emails',                    detect: () => Boolean(env.RESEND_API_KEY) },
  { key: 'sentry',   name: 'Sentry',        desc: 'Catches errors (free plan)',                detect: () => Boolean(env.SENTRY_DSN) },
  { key: 'stripe',   name: 'Stripe',        desc: 'Payments (when hotels start paying)',       detect: () => Boolean(env.STRIPE_SECRET_KEY) },
];

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

  const detected = KNOWN_SERVICES.filter((s) => s.detect()).map(({ key, name, desc }) => ({ key, name, desc }));

  const adminKey = env.ANTHROPIC_ADMIN_KEY;
  let billing: Billing | null = null;
  if (adminKey) {
    try { billing = await fetchBilling(adminKey); } catch { billing = null; }
  }

  return ok({
    connected: billing !== null,
    billing,
    learning,
    detected,
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
  for (const raw of body.subscriptions as Array<{ id?: unknown; name?: unknown; monthlyUsd?: unknown; serviceKey?: unknown }>) {
    const name = typeof raw?.name === 'string' ? raw.name.trim().slice(0, 60) : '';
    const monthlyUsd = typeof raw?.monthlyUsd === 'number' && isFinite(raw.monthlyUsd)
      ? Math.max(0, Math.round(raw.monthlyUsd * 100) / 100)
      : NaN;
    if (!name || isNaN(monthlyUsd)) {
      return err('each line needs a name and a monthly dollar amount', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
    const line: SubscriptionLine = {
      id: typeof raw?.id === 'string' && raw.id ? raw.id.slice(0, 40) : `sub_${Math.random().toString(36).slice(2, 10)}`,
      name,
      monthlyUsd,
    };
    if (typeof raw?.serviceKey === 'string' && raw.serviceKey) line.serviceKey = raw.serviceKey.slice(0, 30);
    cleaned.push(line);
  }

  const { error } = await supabaseAdmin
    .from('app_settings')
    .update({ ai_subscriptions: cleaned, updated_at: new Date().toISOString() })
    .eq('id', true);
  if (error) return err(error.message, { requestId, status: 500, code: 'internal_error' });

  return ok({ subscriptions: cleaned }, { requestId });
}
