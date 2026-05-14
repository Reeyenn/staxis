// ─── POST /api/walkthrough/step ───────────────────────────────────────────
// One step of the Clicky-style walkthrough loop. The browser overlay calls
// this each time it needs to know what to do next. We:
//
//   1. Auth + property access check (same pattern as /api/agent/command)
//   2. Cost-cap pre-check (unified daily caps; sum ALL kind='request' rows
//      so chatbot + walkthrough share one budget)
//   3. Ask Claude Haiku what the next action is, via a forced tool_use
//      so we get back structured JSON
//   4. Post-record the actual spend to agent_costs (kind='request')
//
// Why NOT the reservation pattern from cost-controls.ts: that pattern is
// optimized for sonnet-tier multi-iteration chat turns ($1.50 worst-case
// reservation per call). Walkthrough steps are Haiku, single-iteration,
// ~$0.005 actual. Reserving $1.50 × 6 steps would torch the $10 daily
// cap on the first walkthrough. Trade-off: a tiny non-atomic window
// where two concurrent steps from the same user could both pass the
// cap check before either writes their cost row. Maximum over-spend
// per user per concurrent burst ≈ a few cents — acceptable.

import type { NextRequest } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { getOrMintRequestId, log } from '@/lib/log';
import { MODELS, PRICING } from '@/lib/agent/llm';
import { COST_LIMITS } from '@/lib/agent/cost-controls';
import type { SnapshotElement } from '@/components/walkthrough/snapshotDom';
import type { AppRole } from '@/lib/roles';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// ─── Wire types ──────────────────────────────────────────────────────────

interface HistoryEntry {
  narration: string;
  targetName?: string;
  deviated?: boolean;
  deviatedTo?: string;
}

interface StepRequestBody {
  task: string;
  propertyId: string;
  history?: HistoryEntry[];
  snapshot: {
    url: string;
    pageTitle: string;
    viewport: { width: number; height: number };
    elements: SnapshotElement[];
  };
}

type StepAction =
  | { type: 'click'; elementId: string; narration: string }
  | { type: 'done'; narration: string }
  | { type: 'cannot_help'; narration: string };

// ─── Constants ───────────────────────────────────────────────────────────

const MAX_TASK_CHARS = 200;
const MAX_HISTORY_ENTRIES = 16;
const MAX_OUTPUT_TOKENS = 512;
const MAX_ELEMENTS_TO_CLAUDE = 60;

// Walkthrough is Haiku, one call per step. Worst case input ~4K tokens,
// output ~500 tokens.
// Haiku pricing: $1/M input, $5/M output.
// 4000/1M * $1 + 500/1M * $5 = $0.004 + $0.0025 = $0.0065. Round to $0.01
// for ceiling. We don't pre-reserve, but track this so the cost-recording
// row matches expectations.
// Per-call cap headroom — bail early if a step would push the user past
// today's cap.
const PER_STEP_ESTIMATE_USD = 0.01;

// ─── Cost-cap pre-check ──────────────────────────────────────────────────

interface DayStart {
  iso: string;
}
function dayStart(): DayStart {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return { iso: d.toISOString() };
}

async function userSpendToday(userId: string): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from('agent_costs')
    .select('cost_usd')
    .eq('user_id', userId)
    .eq('kind', 'request')
    .gte('created_at', dayStart().iso);
  if (error) {
    log.error('[walkthrough/step] userSpendToday failed', { userId, error });
    return 0;
  }
  let total = 0;
  for (const r of data ?? []) total += Number((r as { cost_usd: number }).cost_usd) || 0;
  return total;
}

async function propertySpendToday(propertyId: string): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from('agent_costs')
    .select('cost_usd')
    .eq('property_id', propertyId)
    .eq('kind', 'request')
    .gte('created_at', dayStart().iso);
  if (error) {
    log.error('[walkthrough/step] propertySpendToday failed', { propertyId, error });
    return 0;
  }
  let total = 0;
  for (const r of data ?? []) total += Number((r as { cost_usd: number }).cost_usd) || 0;
  return total;
}

// ─── Anthropic client ────────────────────────────────────────────────────

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  _client = new Anthropic({ apiKey });
  return _client;
}

// ─── System prompt ───────────────────────────────────────────────────────

function buildSystemPrompt(role: AppRole, task: string): string {
  return [
    'You are directing a teaching walkthrough inside the Staxis hotel housekeeping web app.',
    `The user (role: ${role}) asked you: "${task}".`,
    'You see the live interactive elements visible on their screen right now (as id + role + accessible name + bounding rect), plus past steps you already walked them through.',
    '',
    'Your job each call: pick the SINGLE next action the user should do, by calling the `emit_step` tool ONCE. Three action types:',
    '  - click       — the user should click a specific button/link. You MUST set elementId to one of the ids in the elements list. Narration is 1 sentence saying what to click and why.',
    '  - done        — the task is complete. The user is at the destination they wanted. Narration is a brief closing line.',
    '  - cannot_help — the task isn\'t reachable from the current state, or doesn\'t make sense in this app. Narration is a polite 1-sentence explanation.',
    '',
    'Hard rules:',
    '  - Pick ONLY from the elements list. Do NOT invent element ids. If you can\'t find a button you need, navigate the user TOWARD where they\'ll find it (click the nearest parent menu or settings link).',
    '  - Be concise. Narration is one short sentence in the imperative voice ("Click Settings to manage your account preferences"). No greetings, no preamble, no emoji.',
    '  - Do NOT call any tool other than emit_step. Do NOT mutate data. The user does the actual click themselves; the cursor only points.',
    '  - If the user deviated on a prior step, accept it — figure out the next step from where they actually are now, don\'t restart.',
    '  - If you find yourself repeating the same step or going in circles, return cannot_help with an honest explanation.',
  ].join('\n');
}

function buildUserContent(body: StepRequestBody, role: AppRole): string {
  const elements = body.snapshot.elements.slice(0, MAX_ELEMENTS_TO_CLAUDE);
  const elementLines = elements.map(e => {
    const parts: string[] = [];
    parts.push(`${e.id} — ${e.role}`);
    if (e.name) parts.push(`name: "${e.name.replace(/"/g, "'")}"`);
    if (e.staxisId) parts.push(`staxis-id: ${e.staxisId}`);
    if (!e.inViewport) parts.push('(off-screen, will be scrolled into view)');
    return '  ' + parts.join(' · ');
  });

  const history = (body.history ?? []).slice(-MAX_HISTORY_ENTRIES);
  const historyLines = history.length
    ? history.map((h, i) => {
        const tag = h.deviated
          ? `[step ${i + 1}, user deviated → clicked "${h.deviatedTo ?? 'unknown'}"]`
          : `[step ${i + 1}, completed]`;
        return `  ${tag} ${h.narration}${h.targetName ? ` (target: ${h.targetName})` : ''}`;
      })
    : ['  (none yet — this is step 1)'];

  return [
    `Task: ${body.task}`,
    `User role: ${role}`,
    `Current page: ${body.snapshot.url} — "${body.snapshot.pageTitle}"`,
    `Viewport: ${body.snapshot.viewport.width}×${body.snapshot.viewport.height}`,
    '',
    'Past steps:',
    ...historyLines,
    '',
    `Interactive elements visible right now (${elements.length}${body.snapshot.elements.length > MAX_ELEMENTS_TO_CLAUDE ? ` of ${body.snapshot.elements.length}` : ''}):`,
    ...elementLines,
    '',
    'Now call emit_step with the next action.',
  ].join('\n');
}

// ─── The emit_step tool ──────────────────────────────────────────────────

const EMIT_STEP_TOOL = {
  name: 'emit_step',
  description: 'Emit the single next walkthrough step for the user.',
  input_schema: {
    type: 'object' as const,
    properties: {
      type: {
        type: 'string',
        enum: ['click', 'done', 'cannot_help'],
        description: 'click = ask the user to click an element; done = task complete; cannot_help = task not reachable / not sensible from here.',
      },
      elementId: {
        type: 'string',
        description: 'Required ONLY when type=click. Must be one of the ids from the elements list.',
      },
      narration: {
        type: 'string',
        description: 'One short imperative sentence describing what the user should do (or that the task is done / cannot be done).',
      },
    },
    required: ['type', 'narration'],
  },
};

// ─── Route ───────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);

  // ── Auth ──────────────────────────────────────────────────────────────
  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;

  // ── Parse + validate body ─────────────────────────────────────────────
  let body: StepRequestBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: 'invalid json', requestId }, { status: 400 });
  }
  if (!body.task?.trim()) {
    return Response.json({ ok: false, error: 'task is required', requestId }, { status: 400 });
  }
  if (!body.propertyId) {
    return Response.json({ ok: false, error: 'propertyId is required', requestId }, { status: 400 });
  }
  if (!body.snapshot || !Array.isArray(body.snapshot.elements)) {
    return Response.json({ ok: false, error: 'snapshot is required', requestId }, { status: 400 });
  }
  if (body.task.length > MAX_TASK_CHARS) {
    return Response.json({ ok: false, error: `task exceeds ${MAX_TASK_CHARS} chars`, requestId }, { status: 413 });
  }

  const hasAccess = await userHasPropertyAccess(auth.userId, body.propertyId);
  if (!hasAccess) {
    return Response.json({ ok: false, error: 'no access to this property', requestId }, { status: 403 });
  }

  // ── Load account ──────────────────────────────────────────────────────
  const { data: account, error: accountErr } = await supabaseAdmin
    .from('accounts')
    .select('id, role, ai_cost_tier')
    .eq('data_user_id', auth.userId)
    .maybeSingle();
  if (accountErr || !account) {
    return Response.json({ ok: false, error: 'account not found', requestId }, { status: 404 });
  }
  const accountId = account.id as string;
  const role = (account.role as AppRole) ?? 'staff';
  const tier = (account.ai_cost_tier as 'free' | 'pro' | 'enterprise' | null) ?? 'free';
  const userDailyCap = ({ free: 10, pro: 50, enterprise: 200 } as const)[tier] ?? 10;

  // ── Cost-cap pre-check ────────────────────────────────────────────────
  // Sums kind='request' to match staxis_reserve_agent_spend behavior (INV-17).
  // Unified across all features: walkthrough + chatbot + voice all write
  // kind='request' rows so the user's $10/day budget is shared.
  const [userSpend, propSpend] = await Promise.all([
    userSpendToday(accountId),
    propertySpendToday(body.propertyId),
  ]);

  if (userSpend + PER_STEP_ESTIMATE_USD > userDailyCap) {
    return Response.json(
      {
        ok: false,
        code: 'user_cap',
        error: `You've hit today's AI usage cap ($${userDailyCap}). Try again tomorrow, or ask an admin to upgrade your tier.`,
        requestId,
      },
      { status: 429 },
    );
  }
  if (propSpend + PER_STEP_ESTIMATE_USD > COST_LIMITS.propertyDailyUsd) {
    return Response.json(
      {
        ok: false,
        code: 'property_cap',
        error: `This property has hit today's AI usage cap ($${COST_LIMITS.propertyDailyUsd}). Ask the owner to raise the limit or wait until tomorrow.`,
        requestId,
      },
      { status: 429 },
    );
  }

  // ── Call Claude ───────────────────────────────────────────────────────
  const systemPrompt = buildSystemPrompt(role, body.task.trim());
  const userContent = buildUserContent(body, role);

  let response: Awaited<ReturnType<Anthropic['messages']['create']>>;
  try {
    response = await client().messages.create({
      model: MODELS.haiku,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: systemPrompt,
      tools: [EMIT_STEP_TOOL],
      tool_choice: { type: 'tool', name: 'emit_step' },
      messages: [{ role: 'user', content: userContent }],
    });
  } catch (err) {
    log.error('[walkthrough/step] Anthropic call failed', { requestId, err });
    return Response.json(
      { ok: false, error: 'AI service is temporarily unavailable. Try again in a moment.', requestId },
      { status: 502 },
    );
  }

  // ── Parse the tool_use block ──────────────────────────────────────────
  const toolBlock = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'emit_step',
  );
  if (!toolBlock) {
    log.error('[walkthrough/step] no emit_step tool_use in response', { requestId, content: response.content });
    return Response.json(
      { ok: false, error: 'AI returned an unexpected response. Try again.', requestId },
      { status: 500 },
    );
  }

  const raw = toolBlock.input as { type?: string; elementId?: string; narration?: string };
  const action = validateAction(raw, body.snapshot.elements);
  if (!action) {
    log.warn('[walkthrough/step] AI returned invalid action shape', { requestId, raw });
    return Response.json(
      { ok: false, error: 'AI returned an invalid action. Try again.', requestId },
      { status: 500 },
    );
  }

  // ── Record actual cost (kind='request', state='finalized') ───────────
  const usage = response.usage;
  const inputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;
  const cachedInputTokens =
    ('cache_read_input_tokens' in usage ? (usage.cache_read_input_tokens as number) : 0) ?? 0;
  const haiku = PRICING.haiku;
  const costUsd =
    ((inputTokens - cachedInputTokens) / 1_000_000) * haiku.input +
    (cachedInputTokens / 1_000_000) * haiku.cachedInput +
    (outputTokens / 1_000_000) * haiku.output;

  // Best-effort insert. If this fails we still return the action — losing
  // the cost row is bad but blocking the user mid-walkthrough is worse.
  void supabaseAdmin
    .from('agent_costs')
    .insert({
      user_id: accountId,
      property_id: body.propertyId,
      conversation_id: null,
      model: 'haiku',
      model_id: response.model,
      tokens_in: inputTokens,
      tokens_out: outputTokens,
      cached_input_tokens: cachedInputTokens,
      cost_usd: Math.round(costUsd * 1_000_000) / 1_000_000,
      kind: 'request',
    })
    .then(({ error }) => {
      if (error) log.error('[walkthrough/step] cost insert failed', { requestId, error });
    });

  return Response.json({ ok: true, action, requestId });
}

// ─── Action validation ───────────────────────────────────────────────────

function validateAction(
  raw: { type?: string; elementId?: string; narration?: string },
  elements: SnapshotElement[],
): StepAction | null {
  if (!raw || typeof raw !== 'object') return null;
  const type = raw.type;
  const narration = (raw.narration ?? '').toString().trim().slice(0, 280);
  if (!narration) return null;

  if (type === 'done' || type === 'cannot_help') {
    return { type, narration };
  }
  if (type === 'click') {
    const elementId = (raw.elementId ?? '').toString();
    if (!elementId) return null;
    if (!elements.some(e => e.id === elementId)) return null;
    return { type: 'click', elementId, narration };
  }
  return null;
}
