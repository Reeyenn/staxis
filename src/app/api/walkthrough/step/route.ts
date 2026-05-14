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
import { MODELS, PRICING } from '@/lib/agent/llm';
import {
  reserveCostBudget,
  finalizeCostReservation,
  cancelCostReservation,
} from '@/lib/agent/cost-controls';
import { buildHotelSnapshot, formatSnapshotForPrompt } from '@/lib/agent/context';
import { escapeTrustMarkerContent } from '@/lib/agent/llm';
import type { SnapshotElement } from '@/components/walkthrough/snapshotDom';
import type { AppRole } from '@/lib/roles';

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

type StepAction =
  | { type: 'click'; elementId: string; narration: string }
  | { type: 'done'; narration: string }
  | { type: 'cannot_help'; narration: string };

// ─── Constants ───────────────────────────────────────────────────────────

const MAX_TASK_CHARS = 200;
const MAX_HISTORY_ENTRIES = 16;
const MAX_OUTPUT_TOKENS = 512;
const MAX_ELEMENTS_TO_CLAUDE = 60;

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
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  _client = new Anthropic({ apiKey });
  return _client;
}

// ─── System prompt ───────────────────────────────────────────────────────

function buildSystemPrompt(role: AppRole, task: string, hotelContext: string | null): string {
  const lines = [
    'You are directing a teaching walkthrough inside the Staxis hotel housekeeping web app.',
    `The user (role: ${role}) asked you: "${task}".`,
    'You see the live interactive elements visible on their screen right now (as id + role + accessible name + bounding rect), plus past steps you already walked them through.',
    '',
  ];
  if (hotelContext) {
    // Domain context (occupancy, dirty rooms, etc.) so Claude can answer
    // questions like "show me how to mark room 302 clean" with confidence
    // that 302 exists. Trust-marker boundary mirrors the agent layer's
    // pattern (escapeTrustMarkerContent is applied inside formatSnapshotForPrompt).
    lines.push('Live hotel context (for grounding domain questions, may be ignored if not relevant):');
    lines.push(hotelContext);
    lines.push('');
  }
  return [
    ...lines,
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
    '  - HARD RULE: NEVER target the same element you targeted in the previous step. Past steps show the element name AND the field already actioned — pick something different this turn (likely the next logical element in the flow, or `done`).',
    '  - For form fields that take typed input (Name, Phone, Wage, etc.), the narration should say what to TYPE — e.g. "Type the new housekeeper\'s name here." The user does the typing themselves. Then on the next step move on to the next field or the Save button.',
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

  // ── Server-side step gate (RC2 root-cause fix) ────────────────────────
  // Atomically: (a) verify the run is still active and belongs to this
  // user's property, (b) increment step_count, (c) reject if MAX_STEPS=12
  // was hit. Returns:
  //   -1 → run not active / not found / cap hit
  //   -2 → property mismatch (user switched property mid-walkthrough)
  //   1..12 → the new step count
  //
  // This is the only place server-side that enforces a step cap. The
  // client cap is advisory; this one is canonical.
  const { data: stepRpc, error: stepRpcErr } = await supabaseAdmin.rpc('staxis_walkthrough_step', {
    p_run_id: body.runId,
    p_expected_property_id: body.propertyId,
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
    estimatedUsd: PER_STEP_ESTIMATE_USD,
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
  let usageMeta: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    modelId: string;
  } | null = null;

  try {
    let response: Awaited<ReturnType<Anthropic['messages']['create']>>;
    try {
      response = await client().messages.create(
        {
          model: MODELS.sonnet,
          max_tokens: MAX_OUTPUT_TOKENS,
          system: systemPrompt,
          tools: [EMIT_STEP_TOOL],
          tool_choice: { type: 'tool', name: 'emit_step' },
          messages: [{ role: 'user', content: userContent }],
        },
        // RC1/CX4 fix: forward the request's AbortSignal into the SDK so
        // client Stop actually cancels the Anthropic call (the agent layer
        // does the same thing in /api/agent/command).
        { signal: req.signal },
      );
    } catch (err) {
      log.error('[walkthrough/step] Anthropic call failed', { requestId, err });
      return Response.json(
        { ok: false, error: 'AI service is temporarily unavailable. Try again in a moment.', requestId },
        { status: 502 },
      );
    }

    // ── Parse the tool_use block ────────────────────────────────────────
    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'emit_step',
    );
    if (toolUseBlocks.length === 0) {
      log.error('[walkthrough/step] no emit_step tool_use in response', { requestId, content: response.content });
      return Response.json(
        { ok: false, error: 'AI returned an unexpected response. Try again.', requestId },
        { status: 500 },
      );
    }
    if (toolUseBlocks.length > 1) {
      // tool_choice forces one tool call, but log it if Claude misbehaves
      // so we notice. (Findings N10.)
      log.warn('[walkthrough/step] multiple emit_step tool_use blocks; using first', {
        requestId, count: toolUseBlocks.length,
      });
    }

    const raw = toolUseBlocks[0].input as { type?: string; elementId?: string; narration?: string };
    const parsed = validateAction(raw, body.snapshot.elements);
    if (!parsed) {
      log.warn('[walkthrough/step] AI returned invalid action shape', { requestId, raw });
      return Response.json(
        { ok: false, error: 'AI returned an invalid action. Try again.', requestId },
        { status: 500 },
      );
    }
    action = parsed;

    // ── Compute actual cost for the reconcile ───────────────────────────
    const usage = response.usage;
    const inputTokens = usage.input_tokens;
    const outputTokens = usage.output_tokens;
    const cachedInputTokens =
      ('cache_read_input_tokens' in usage ? (usage.cache_read_input_tokens as number) : 0) ?? 0;
    const pricing = PRICING.sonnet;
    actualUsd =
      ((inputTokens - cachedInputTokens) / 1_000_000) * pricing.input +
      (cachedInputTokens / 1_000_000) * pricing.cachedInput +
      (outputTokens / 1_000_000) * pricing.output;
    usageMeta = {
      inputTokens,
      outputTokens,
      cachedInputTokens,
      modelId: response.model,
    };
  } finally {
    // RC1: reconcile to actual. If we made the Claude call and got usage,
    // finalize. Otherwise (early validation failure, parse failure, abort)
    // cancel the reservation to release the budget hold. This replaces the
    // old fire-and-forget `void ... .then()` insert (Codex CX3).
    if (usageMeta) {
      try {
        await finalizeCostReservation({
          reservationId: reservation.reservationId,
          conversationId: null, // walkthroughs have no agent_conversations row
          actualUsd: Math.round(actualUsd * 1_000_000) / 1_000_000,
          model: 'sonnet',
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

// ─── Action validation ───────────────────────────────────────────────────
// Exported for unit testing (walkthrough-validate-action.test.ts). The
// function is pure: takes Claude's raw tool_use input plus the snapshot's
// element list, returns a typed action or null if anything's malformed.

export function validateAction(
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
