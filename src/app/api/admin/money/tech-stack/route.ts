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
 * GET  → { connected, billing|null, learning, detected, subscriptions,
 *          auditRequestedAt }
 *   billing: Anthropic cost_report month-to-date (daily UTC buckets,
 *   amounts = decimal-string CENTS, ~5 min lag); connected=false without
 *   ANTHROPIC_ADMIN_KEY — the UI says so instead of showing fake numbers.
 * POST { subscriptions: [...] } → saves the flat lines.
 * POST { action: 'request_audit' } → stamps
 *   app_settings.subscription_audit_requested_at (0319). The web app can't
 *   read the founder's Gmail — a scheduled Claude session on his Mac
 *   watches this flag, sweeps the receipt emails, updates the board, and
 *   clears it. The button is a request, not an instant scan.
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
  /** Every real dollar since the org's first day — the "Total spent" number. */
  totalUsd: number;
  byWorkspace: WorkspaceSpend[];
  /** One row per day with any spend, since ORG_EPOCH — powers History. */
  days: Array<{ date: string; usd: number }>;
  /** Month-to-date per-model lines per workspace — the "where the number
   *  comes from" drill-down (null workspace = Hotel AI). */
  byModel: Array<{ workspaceId: string | null; label: string; usd: number }>;
  /** Prepaid credit balance is not exposed by the API — console only. */
  monthStart: string;
}

/** The org's first possible billing day (account created 2026-05-07) —
 *  the "since day one" anchor for Total spent and History. */
const ORG_EPOCH = '2026-05-01T00:00:00Z';

/** One daily bucket from /v1/organizations/cost_report. */
interface CostBucket {
  starting_at: string;
  ending_at: string;
  results: Array<{
    currency: string; amount: string; workspace_id: string | null;
    /** Present when grouping by description. */
    description?: string | null; model?: string | null;
  }>;
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

/** Paginated cost_report pull; returns all daily buckets in the range. */
async function fetchCostBuckets(
  adminKey: string, startingAt: string, endingAt: string, groupBy: string[],
): Promise<CostBucket[] | null> {
  const params = new URLSearchParams({ starting_at: startingAt, ending_at: endingAt, limit: '31' });
  for (const g of groupBy) params.append('group_by[]', g);

  const buckets: CostBucket[] = [];
  let page: string | null = null;
  for (let i = 0; i < 12; i++) {
    const url = `/v1/organizations/cost_report?${params.toString()}${page ? `&page=${encodeURIComponent(page)}` : ''}`;
    const res = await anthropicAdminGet(url, adminKey);
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: CostBucket[]; has_more?: boolean; next_page?: string | null };
    buckets.push(...(json.data ?? []));
    if (!json.has_more || !json.next_page) break;
    page = json.next_page;
  }
  return buckets;
}

/**
 * Two pulls from the Cost Admin API (amounts = decimal-string cents):
 *   A. Daily buckets since ORG_EPOCH grouped by workspace → today / month /
 *      TOTAL spent + the per-day History rows.
 *   B. Month-to-date grouped by workspace+description → per-model lines,
 *      the "where does this number actually come from" drill-down.
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

  const [historyBuckets, detailBuckets] = await Promise.all([
    fetchCostBuckets(adminKey, ORG_EPOCH, tomorrow.toISOString(), ['workspace_id']),
    fetchCostBuckets(adminKey, monthStart.toISOString(), tomorrow.toISOString(), ['workspace_id', 'description']),
  ]);
  if (!historyBuckets) return null;

  const byWs = new Map<string | null, { monthUsd: number; todayUsd: number }>();
  const byDay = new Map<string, number>();
  let todayUsd = 0;
  let monthUsd = 0;
  let totalUsd = 0;
  for (const bucket of historyBuckets) {
    const t = new Date(bucket.starting_at).getTime();
    const isToday = t >= todayStart.getTime();
    const inMonth = t >= monthStart.getTime();
    const dayKey = bucket.starting_at.slice(0, 10);
    for (const r of bucket.results ?? []) {
      const usd = (parseFloat(r.amount) || 0) / 100; // cents → dollars
      totalUsd += usd;
      if (usd > 0) byDay.set(dayKey, (byDay.get(dayKey) ?? 0) + usd);
      if (inMonth) {
        monthUsd += usd;
        if (isToday) todayUsd += usd;
        const entry = byWs.get(r.workspace_id) ?? { monthUsd: 0, todayUsd: 0 };
        entry.monthUsd += usd;
        if (isToday) entry.todayUsd += usd;
        byWs.set(r.workspace_id, entry);
      }
    }
  }

  // Per-model MTD lines. "Description" rows parse out a model where the
  // charge is token usage; other charges (web search, code execution) keep
  // their plain description as the label.
  const modelAgg = new Map<string, { workspaceId: string | null; label: string; usd: number }>();
  for (const bucket of detailBuckets ?? []) {
    for (const r of bucket.results ?? []) {
      const usd = (parseFloat(r.amount) || 0) / 100;
      if (usd === 0) continue;
      const label = (r.model || r.description || 'Other usage').trim();
      const key = `${r.workspace_id ?? 'default'}::${label}`;
      const entry = modelAgg.get(key) ?? { workspaceId: r.workspace_id ?? null, label, usd: 0 };
      entry.usd += usd;
      modelAgg.set(key, entry);
    }
  }

  // Every known workspace shows up even at $0 — the owner wants the
  // "AI employees" bucket visible before it ever spends a cent.
  for (const [id] of wsNames) if (!byWs.has(id)) byWs.set(id, { monthUsd: 0, todayUsd: 0 });
  if (!byWs.has(null)) byWs.set(null, { monthUsd: 0, todayUsd: 0 });

  const round = (n: number) => Math.round(n * 100) / 100;
  const byWorkspace: WorkspaceSpend[] = [...byWs.entries()]
    .map(([workspaceId, v]) => ({
      workspaceId,
      name: workspaceId === null ? 'Hotel AI' : (wsNames.get(workspaceId) ?? workspaceId),
      monthUsd: round(v.monthUsd),
      todayUsd: round(v.todayUsd),
    }))
    .sort((a, b) => b.monthUsd - a.monthUsd);

  return {
    todayUsd: round(todayUsd),
    monthUsd: round(monthUsd),
    totalUsd: round(totalUsd),
    byWorkspace,
    days: [...byDay.entries()].map(([date, usd]) => ({ date, usd: round(usd) })).sort((a, b) => b.date.localeCompare(a.date)),
    byModel: [...modelAgg.values()].map((m) => ({ ...m, usd: round(m.usd) })).sort((a, b) => b.usd - a.usd),
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
  // record their real per-call Claude cost in claude_cost_micros) + the
  // receipt-backed payment history (0320) behind Total paid + History.
  const [learnQ, settingsQ, paymentsQ] = await Promise.all([
    supabaseAdmin
      .from('workflow_jobs')
      .select('claude_cost_micros')
      .like('kind', 'mapper.%')
      .gte('created_at', monthStartIso),
    supabaseAdmin
      .from('app_settings')
      .select('ai_subscriptions, subscription_audit_requested_at')
      .eq('id', true)
      .maybeSingle(),
    supabaseAdmin
      .from('payment_history')
      .select('paid_on, vendor, description, amount_cents')
      .order('paid_on', { ascending: false })
      .limit(500),
  ]);
  if (learnQ.error) return err(learnQ.error.message, { requestId, status: 500, code: 'internal_error' });

  const learningRows = (learnQ.data ?? []) as Array<{ claude_cost_micros: number | null }>;
  const learning = {
    monthUsd: Math.round(learningRows.reduce((s, r) => s + (r.claude_cost_micros ?? 0), 0) / 10_000) / 100,
    runs: learningRows.length,
  };

  const subscriptions = ((settingsQ.data?.ai_subscriptions ?? []) as SubscriptionLine[])
    .filter((s) => s && typeof s.name === 'string' && typeof s.monthlyUsd === 'number');

  // Real charges from receipts (0320) — what actually left the card.
  const paymentRows = (paymentsQ.data ?? []) as Array<{ paid_on: string; vendor: string; description: string | null; amount_cents: number }>;
  const payments = paymentRows.map((p) => ({
    date: p.paid_on,
    vendor: p.vendor,
    description: p.description,
    amountUsd: Math.round(p.amount_cents) / 100,
  }));
  const paymentsTotalUsd = Math.round(paymentRows.reduce((s, p) => s + p.amount_cents, 0)) / 100;

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
    payments,
    paymentsTotalUsd,
    auditRequestedAt: settingsQ.data?.subscription_audit_requested_at ?? null,
  }, { requestId });
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const auth = await requireAdminOrCron(req);
  if (!auth.ok) return err('Admin sign-in required.', { requestId, status: 401, code: 'unauthorized' });

  let body: { subscriptions?: unknown; action?: unknown };
  try { body = (await req.json()) as { subscriptions?: unknown; action?: unknown }; } catch { body = {}; }

  // "Check my subscriptions" button — stamp the request flag for the
  // scheduled audit session (it clears the flag after sweeping).
  if (body.action === 'request_audit') {
    const requestedAt = new Date().toISOString();
    const { error } = await supabaseAdmin
      .from('app_settings')
      .update({ subscription_audit_requested_at: requestedAt })
      .eq('id', true);
    if (error) return err(error.message, { requestId, status: 500, code: 'internal_error' });
    return ok({ auditRequestedAt: requestedAt }, { requestId });
  }

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
