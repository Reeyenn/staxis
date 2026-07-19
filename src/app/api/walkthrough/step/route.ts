// ─── POST /api/walkthrough/step ───────────────────────────────────────────
// One step of the Clicky-style walkthrough loop. The browser overlay calls
// this each time it needs to know what to do next. We:
//
//   1. Auth + property access check (same pattern as /api/agent/command)
//   2. Atomic cost reservation via the canonical agent layer (caps user +
//      property + global serialized under an advisory lock — INV-17).
//   3. Ask Claude Sonnet what the next action is, via a forced tool_use
//      so we get back structured JSON. Forwards req.signal so Stop on the
//      client actually cancels the SDK call.
//   4. Finalize the reservation to actual spend (or cancel on failure)
//      in a finally block — no fire-and-forget.
//
// History — RC1 root-cause hardening (post-Codex review, 2026-05-14):
//   The earlier version of this route reimplemented cap math inline.
//   That decision spawned 10 different findings (free-tier cap drift,
//   missing global cap, fire-and-forget cost insert, etc.). Routing
//   through reserveCostBudget/finalize/cancel with a smaller
//   per-step estimate fixes them all in one place.

import type { NextRequest } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { getOrMintRequestId, log } from '@/lib/log';
import { escapeTrustMarkerContent, modelTierForModelId, PRICING, type ModelTier } from '@/lib/agent/llm';
import {
  AiFeatureDisabledError,
  executeAiPlan,
  estimateAiCostUsd,
  resolveAiExecutionPlan,
  scaleAiReservationUsd,
  type AiExecutionPlan,
} from '@/lib/ai/runtime';
import { applyLegacyModelOverrideToPlan } from '@/lib/ai/legacy-model-overrides';
import { normalizeAnthropicUsage } from '@/lib/ai/usage';
import {
  ANTHROPIC_WALKTHROUGH_TIMEOUT_MS,
  ANTHROPIC_MAX_RETRIES,
} from '@/lib/external-service-config';
import {
  reserveCostBudget,
  finalizeCostReservation,
  cancelCostReservation,
} from '@/lib/agent/cost-controls';
import { buildHotelSnapshot, formatSnapshotForPrompt } from '@/lib/agent/context';
import type { SnapshotElement } from '@/components/walkthrough/snapshotDom';
import type { AppRole } from '@/lib/roles';
import { env } from '@/lib/env';
import {
  buildSystemPrompt,
  checkRunOwnership,
  validateAction,
  type StepAction,
} from '@/lib/walkthrough-step';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// ─── Wire types ──────────────────────────────────────────────────────────

interface HistoryEntry {
  narration: string;
  targetName?: string;
  /** Cross-snapshot stable fingerprint = url|rawName|parentSection. Used
   * by the repetition guard below. (RC3 — replaces the old targetElementId
   * which was per-snapshot and didn't survive page navigation.) */
  targetFingerprint?: string;
  deviated?: boolean;
  deviatedTo?: string;
}

interface StepRequestBody {
  /** Walkthrough run id from POST /api/walkthrough/start. Required for
   * server-side step-cap enforcement and concurrent-run dedup (RC2). */
  runId: string;
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

// ─── Constants ───────────────────────────────────────────────────────────

const MAX_TASK_CHARS = 200;
const MAX_HISTORY_ENTRIES = 16;
const MAX_OUTPUT_TOKENS = 512;
const MAX_ELEMENTS_TO_CLAUDE = 60;
const WALKTHROUGH_ROUTE_AI_DEADLINE_MS = 25_000;
const WALKTHROUGH_FALLBACK_RESERVE_MS = 8_000;

// Walkthrough is Sonnet, one call per step. Worst case input ~4K tokens,
// output ~500 tokens.
// Sonnet pricing: $3/M input, $15/M output.
// 4000/1M * $3 + 500/1M * $15 = $0.012 + $0.0075 = $0.0195. Round to $0.03
// for ceiling. We don't pre-reserve, but track this so the cost-recording
// row matches expectations.
// Per-call cap headroom — bail early if a step would push the user past
// today's cap.
const PER_STEP_ESTIMATE_USD = 0.03;

// ─── Anthropic client ────────────────────────────────────────────────────

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (_client) return _client;
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  // Per src/lib/external-service-config.ts: explicit timeout < route's
  // maxDuration (30s), maxRetries=1 so a hiccup doesn't blow past the
  // function ceiling. Pre-2026-05-17 this was `new Anthropic({ apiKey })`
  // — no timeout, SDK default 2 retries — which the audit flagged as the
  // highest-blast-radius finding (every onboarding user hung 60s on a
  // bad Anthropic regional incident).
  _client = new Anthropic({
    apiKey,
    timeout: ANTHROPIC_WALKTHROUGH_TIMEOUT_MS,
    maxRetries: ANTHROPIC_MAX_RETRIES,
  });
  return _client;
}

function buildUserContent(body: StepRequestBody, role: AppRole): string {
  const elements = body.snapshot.elements.slice(0, MAX_ELEMENTS_TO_CLAUDE);
  const elementLines = elements.map(e => {
    const parts: string[] = [];
    parts.push(`${e.id} — ${e.role}`);
    if (e.name) parts.push(`name: "${escapeTrustMarkerContent(e.name).replace(/"/g, "'")}"`);
    if (e.staxisId) parts.push(`staxis-id: ${e.staxisId}`);
    if (!e.inViewport) parts.push('(off-screen, will be scrolled into view)');
    return '  ' + parts.join(' · ');
  });

  const history = (body.history ?? []).slice(-MAX_HISTORY_ENTRIES);
  // RC6 N24: history fields are untrusted client input. Trim + escape each
  // string so a crafted `narration` or `deviatedTo` can't bury HTML/markup
  // that breaks the prompt structure. (escapeTrustMarkerContent escapes
  // <, >, & — the only characters that can syntactically interfere with
  // any trust-marker wrapping we layer above.)
  const cleanHistoryField = (s: string | undefined, cap: number): string =>
    escapeTrustMarkerContent((s ?? '').toString().slice(0, cap));
  const historyLines = history.length
    ? history.map((h, i) => {
        const tag = h.deviated
          ? `[step ${i + 1}, user deviated → clicked "${cleanHistoryField(h.deviatedTo, 120)}"]`
          : `[step ${i + 1}, user clicked target]`;
        const targetTag = h.targetName
          ? ` (you targeted "${cleanHistoryField(h.targetName, 160)}")`
          : '';
        return `  ${tag} ${cleanHistoryField(h.narration, 280)}${targetTag}`;
      })
    : ['  (none yet — this is step 1)'];

  // RC3: cross-snapshot stable repetition guard.
  // The previous incarnation compared synthetic elementIds, which are
  // per-snapshot and DIFFERENT after a navigation. So "click Settings" on
  // /dashboard and "click Settings" on /housekeeping looked unrelated to
  // the guard even though they're the same logical action. The fingerprint
  // is url|rawName|parentSection — same logical button = same fingerprint
  // regardless of which snapshot it appears in.
  //
  // Compute the fingerprint for every element in the CURRENT snapshot, then
  // see if any of them match a prior step's fingerprint. If yes, name it
  // explicitly in the prompt so Claude knows that element is already done.
  const currentFingerprints = new Map<string, string>();
  for (const e of body.snapshot.elements) {
    const fp = `${body.snapshot.url}|${e.rawName}|${e.parentSection ?? ''}`;
    currentFingerprints.set(e.id, fp);
  }
  const priorFingerprints = new Set(
    history.filter(h => !h.deviated && h.targetFingerprint).map(h => h.targetFingerprint as string),
  );
  const matchingCurrent = body.snapshot.elements
    .filter(e => priorFingerprints.has(`${body.snapshot.url}|${e.rawName}|${e.parentSection ?? ''}`))
    .map(e => `${e.id} ("${e.rawName}")`)
    .slice(0, 5);
  const repetitionGuard = matchingCurrent.length
    ? `\nIMPORTANT: the following elements MATCH something you've already had the user click in a past step — picking any of them again is a loop bug. Pick a DIFFERENT element or return done/cannot_help.\n  Already-actioned: ${matchingCurrent.join(', ')}`
    : '';
  void currentFingerprints; // reserved for future per-step debug logging

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
    repetitionGuard,
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
  // One absolute budget starts with the route, not with each provider attempt.
  // This leaves time under maxDuration for reservation reconciliation.
  const routeAiDeadlineAt = Date.now() + WALKTHROUGH_ROUTE_AI_DEADLINE_MS;

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
  if (!body.runId) {
    return Response.json({ ok: false, error: 'runId is required (call POST /api/walkthrough/start first)', requestId }, { status: 400 });
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

  // ── Load account (role only; tier handled by reserveCostBudget) ───────
  const { data: account, error: accountErr } = await supabaseAdmin
    .from('accounts')
    .select('id, role')
    .eq('data_user_id', auth.userId)
    .maybeSingle();
  if (accountErr || !account) {
    return Response.json({ ok: false, error: 'account not found', requestId }, { status: 404 });
  }
  const accountId = account.id as string;
  const role = (account.role as AppRole) ?? 'staff';

  // ── Run-owner check (2026-05-22 audit, Codex finding [HIGH]) ──────────
  // staxis_walkthrough_step verifies (run_id, property_id) but NOT
  // (user_id). Without this check, any authenticated user with access to
  // the same property who learns another user's runId can advance that
  // run, consume its 12-step cap, and pull the narration to their own
  // screen. walkthrough_runs.user_id is set on insert and immutable
  // (migration 0118), so a single read-before-RPC closes the gap with
  // no TOCTOU concern. The deeper fix is to enforce in the RPC itself —
  // tracked as a follow-up migration.
  const { data: runRow, error: runErr } = await supabaseAdmin
    .from('walkthrough_runs')
    .select('user_id')
    .eq('id', body.runId)
    .maybeSingle();
  if (runErr) {
    log.error('[walkthrough/step] run lookup failed', { requestId, runId: body.runId, err: runErr });
    return Response.json({ ok: false, error: 'failed to advance walkthrough', requestId }, { status: 500 });
  }
  const ownership = checkRunOwnership(runRow, accountId);
  if (!ownership.ok) {
    if (ownership.status === 403) {
      log.warn('[walkthrough/step] run_user_mismatch', { requestId, runId: body.runId, accountId });
    }
    return Response.json(
      { ok: false, code: ownership.code, error: ownership.message, requestId },
      { status: ownership.status },
    );
  }

  // Resolve before consuming a walkthrough step or reserving money. Disabled
  // features fail cleanly; expensive configured fallbacks expand the atomic
  // hold while the current Sonnet default remains exactly $0.03. Keep the
  // existing MODEL_OVERRIDE emergency rollback until an admin explicitly
  // activates a saved configuration.
  let walkthroughPlan: AiExecutionPlan;
  let perStepEstimateUsd: number;
  try {
    const resolved = await resolveAiExecutionPlan(
      'walkthrough.step_generation',
      'anthropic',
      { requirePricing: true },
    );
    walkthroughPlan = applyLegacyModelOverrideToPlan(resolved, 'sonnet');
    perStepEstimateUsd = scaleAiReservationUsd(
      [walkthroughPlan.primary, walkthroughPlan.fallback].filter(
        (model): model is NonNullable<typeof model> => model !== null,
      ),
      {
        usd: PER_STEP_ESTIMATE_USD,
        inputUsdPerMillionTokens: PRICING.sonnet.input,
        outputUsdPerMillionTokens: PRICING.sonnet.output,
      },
    );
  } catch (error) {
    // Never surface internal error strings to the walkthrough client; the two
    // states it can act on are "turned off by admin" vs "temporarily down".
    const disabled = error instanceof AiFeatureDisabledError;
    return Response.json({
      ok: false,
      error: disabled
        ? 'Guided walkthroughs are currently turned off.'
        : 'Guided walkthroughs are temporarily unavailable.',
      code: disabled ? 'feature_disabled' : 'ai_unavailable',
      requestId,
    }, { status: 503 });
  }

  // ── Server-side step gate (RC2 root-cause fix) ────────────────────────
  // Atomically: (a) verify the run is still active and belongs to this
  // user's property + user, (b) increment step_count, (c) reject if
  // MAX_STEPS=12 was hit. Returns:
  //   -1 → run not active / not found / cap hit
  //   -2 → property mismatch (user switched property mid-walkthrough)
  //   -3 → user_id mismatch (2026-05-22 audit — defense in depth; the
  //         route-layer ownership check normally catches this earlier)
  //   1..12 → the new step count
  //
  // This is the only place server-side that enforces a step cap. The
  // client cap is advisory; this one is canonical.
  const { data: stepRpc, error: stepRpcErr } = await supabaseAdmin.rpc('staxis_walkthrough_step', {
    p_run_id: body.runId,
    p_expected_property_id: body.propertyId,
    p_expected_user_id: accountId,
  });
  if (stepRpcErr) {
    log.error('[walkthrough/step] step RPC failed', { requestId, runId: body.runId, err: stepRpcErr });
    return Response.json({ ok: false, error: 'failed to advance walkthrough', requestId }, { status: 500 });
  }
  const stepCount = (stepRpc as number) ?? -1;
  if (stepCount === -2) {
    return Response.json(
      {
        ok: false,
        code: 'property_mismatch',
        error: 'You switched properties — restart the walkthrough on the new one.',
        requestId,
      },
      { status: 400 },
    );
  }
  if (stepCount === -3) {
    // The route-layer check at checkRunOwnership above should have caught
    // this. Reaching the RPC's -3 branch means a logic bug let a foreign
    // owner through. Log loudly; return the same 403 shape so behavior
    // is consistent with the route-layer rejection.
    log.error('[walkthrough/step] rpc_user_mismatch — route-layer check missed', {
      requestId, runId: body.runId, accountId,
    });
    return Response.json(
      { ok: false, code: 'forbidden', error: 'this is not your walkthrough', requestId },
      { status: 403 },
    );
  }
  if (stepCount < 0) {
    // Not active, not found, or cap hit. Mark the run as 'capped' (the RPC
    // is idempotent if the run was already in a terminal state).
    try {
      await supabaseAdmin.rpc('staxis_walkthrough_end', {
        p_run_id: body.runId, p_status: 'capped',
      });
    } catch {
      /* best-effort; the run may already be terminal */
    }
    return Response.json(
      {
        ok: false,
        code: 'step_cap',
        error: "I got a bit lost after several steps — try rephrasing your question and I'll start over.",
        requestId,
      },
      { status: 429 },
    );
  }

  // ── Atomic cost reservation (RC1 root-cause fix) ──────────────────────
  // Routes through the canonical agent-layer reservation system:
  //   - serializes user + property + global caps under a Postgres advisory
  //     lock (no more racing concurrent steps)
  //   - reads the per-tier user cap from `accounts.ai_cost_tier` (no more
  //     hardcoded $10 that drifts from the canonical $5 free tier)
  //   - inserts a 'reserved' agent_costs row that subsequent cap-check
  //     sums can see (kind='request', state='reserved')
  //
  // We pass a smaller estimate ($0.03) than the chatbot's worst-case
  // (~$1.50) since walkthrough steps are single-iteration Sonnet calls.
  // Reconcile-to-actual in the finally block below.
  const reservation = await reserveCostBudget({
    userId: accountId,
    propertyId: body.propertyId,
    estimatedUsd: perStepEstimateUsd,
  });
  if (!reservation.ok) {
    log.warn('[walkthrough/step] cap_hit', { requestId, reason: reservation.reason, accountId });
    return Response.json(
      { ok: false, code: reservation.reason, error: reservation.message, requestId },
      { status: 429 },
    );
  }

  // ── Build the per-turn context ────────────────────────────────────────
  // Hotel snapshot (RC6 N21): same buildHotelSnapshot helper the chatbot
  // uses. 30-second in-process cache so per-step DB cost is amortized
  // across the walkthrough. Skip staffId lookup for walkthroughs — the
  // myRooms detail is housekeeper-specific and not relevant for teaching
  // navigation. Property name + room counts is the useful general context.
  let hotelContextStr: string | null = null;
  try {
    const snap = await buildHotelSnapshot(body.propertyId, role, null);
    hotelContextStr = formatSnapshotForPrompt(snap);
  } catch (err) {
    // Non-fatal — Claude can still walk the user through navigation
    // without domain context.
    log.warn('[walkthrough/step] hotel snapshot failed; continuing without', { requestId, err });
  }

  // ── Call Claude (Sonnet for multi-step reasoning) ─────────────────────
  // History — RC1: Haiku looped on multi-step cases; Sonnet plans
  // coherently across steps and recognizes "this element was already
  // actioned" from the history. Per-step cost ~$0.02 vs Haiku's $0.005.
  const systemPrompt = buildSystemPrompt(role, body.task.trim(), hotelContextStr);
  const userContent = buildUserContent(body, role);

  let action: StepAction | null = null;
  let actualUsd = 0;
  const usageState: { current: {
    inputTokens: number;
    uncachedInputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    cacheCreationInputTokens: number;
    cacheCreation5mInputTokens: number;
    cacheCreation1hInputTokens: number;
    modelId: string;
    model: ModelTier;
  } | null } = { current: null };

  try {
    try {
      const configured = await executeAiPlan(
        walkthroughPlan,
        async (model, context) => {
          const response = await client().messages.create(
            {
              model: model.modelId,
              max_tokens: MAX_OUTPUT_TOKENS,
              system: systemPrompt,
              tools: [EMIT_STEP_TOOL],
              tool_choice: { type: 'tool', name: 'emit_step' },
              messages: [{ role: 'user', content: userContent }],
            },
            { signal: context.signal },
          );

          const usage = normalizeAnthropicUsage(response.usage);
          actualUsd += estimateAiCostUsd(model.pricing!, {
            uncachedInputTokens: usage.uncachedInputTokens,
            outputTokens: usage.outputTokens,
            cacheReadInputTokens: usage.cachedInputTokens,
            cacheCreationInputTokens: usage.cacheCreationInputTokens,
            cacheCreation5mInputTokens: usage.cacheCreation5mInputTokens,
            cacheCreation1hInputTokens: usage.cacheCreation1hInputTokens,
          });
          usageState.current = {
            inputTokens: (usageState.current?.inputTokens ?? 0) + usage.inputTokens,
            uncachedInputTokens: (usageState.current?.uncachedInputTokens ?? 0) + usage.uncachedInputTokens,
            outputTokens: (usageState.current?.outputTokens ?? 0) + usage.outputTokens,
            cachedInputTokens: (usageState.current?.cachedInputTokens ?? 0) + usage.cachedInputTokens,
            cacheCreationInputTokens: (usageState.current?.cacheCreationInputTokens ?? 0) + usage.cacheCreationInputTokens,
            cacheCreation5mInputTokens: (usageState.current?.cacheCreation5mInputTokens ?? 0) + usage.cacheCreation5mInputTokens,
            cacheCreation1hInputTokens: (usageState.current?.cacheCreation1hInputTokens ?? 0) + usage.cacheCreation1hInputTokens,
            modelId: response.model,
            model: modelTierForModelId(model.modelId, 'sonnet'),
          };

          // Tool/schema validation belongs to the attempt. A malformed 200
          // response is eligible for the configured fallback and its spend is
          // still retained above.
          const toolUseBlocks = response.content.filter(
            (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'emit_step',
          );
          if (toolUseBlocks.length === 0) {
            throw new Error('AI returned no emit_step tool call');
          }
          if (toolUseBlocks.length > 1) {
            log.warn('[walkthrough/step] multiple emit_step tool_use blocks; using first', {
              requestId, count: toolUseBlocks.length,
            });
          }
          const raw = toolUseBlocks[0].input as { type?: string; elementId?: string; narration?: string };
          const parsed = validateAction(raw, body.snapshot.elements);
          if (!parsed) throw new Error('AI returned an invalid walkthrough action');
          return parsed;
        },
        {
          deadlineAt: routeAiDeadlineAt,
          fallbackReserveMs: WALKTHROUGH_FALLBACK_RESERVE_MS,
          abortSignal: req.signal,
        },
      );
      action = configured.value;
    } catch (err) {
      log.error('[walkthrough/step] Anthropic call failed', { requestId, err });
      return Response.json(
        { ok: false, error: 'AI service is temporarily unavailable. Try again in a moment.', requestId },
        { status: 502 },
      );
    }

  } finally {
    // RC1: reconcile to actual. If we made the Claude call and got usage,
    // finalize. Otherwise (early validation failure, parse failure, abort)
    // cancel the reservation to release the budget hold. This replaces the
    // old fire-and-forget `void ... .then()` insert (Codex CX3).
    const usageMeta = usageState.current;
    if (usageMeta) {
      try {
        await finalizeCostReservation({
          reservationId: reservation.reservationId,
          conversationId: null, // walkthroughs have no agent_conversations row
          actualUsd: Math.round(actualUsd * 1_000_000) / 1_000_000,
          model: usageMeta.model,
          modelId: usageMeta.modelId,
          tokensIn: usageMeta.inputTokens,
          tokensOut: usageMeta.outputTokens,
          cachedInputTokens: usageMeta.cachedInputTokens,
          userId: accountId,
          propertyId: body.propertyId,
        });
      } catch (finalizeErr) {
        log.error('[walkthrough/step] finalize failed; attempting cancel', {
          requestId, reservationId: reservation.reservationId, finalizeErr,
        });
        await cancelCostReservation(reservation.reservationId).catch(cancelErr =>
          log.error('[walkthrough/step] cancel also failed; reservation stranded', {
            requestId, reservationId: reservation.reservationId, cancelErr,
          }),
        );
      }
    } else {
      await cancelCostReservation(reservation.reservationId);
    }
  }

  if (!action) {
    // Defensive — finally already returned a non-2xx response if we got here,
    // but TypeScript can't see that the early-returns above prevent this.
    return Response.json(
      { ok: false, error: 'walkthrough step failed', requestId },
      { status: 500 },
    );
  }
  return Response.json({ ok: true, action, requestId });
}
