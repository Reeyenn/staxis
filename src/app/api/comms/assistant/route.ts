/**
 * POST /api/comms/assistant  — Body: { pid, conversationId, question }
 * The @Staxis in-chat assistant. Runs the AI with hotel tools (room status,
 * create work order, log complaint) scoped to THIS property, then posts its
 * answer back into the conversation as a "Staxis" message. The user's own
 * "@Staxis ..." line is posted separately via /send.
 *
 * RATE LIMIT: RAW property UUID (AI-endpoint rule). Prompt-injection-hardened
 * (see assistant.ts). NO SMS.
 */
import { ApiErrorCode } from '@/lib/api-response';
import { validateUuid, validateString } from '@/lib/api-validate';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';
import { defineRoute } from '@/lib/api-route';
import { commsContext } from '@/lib/comms/route-helpers';
import { getConversation, canAccessConversation, getThreadForAssistant, postMessage } from '@/lib/comms/core';
import { runStaxisAssistant } from '@/lib/comms/assistant';
import type { AiUsageReport } from '@/lib/ai/usage';
import { recordAiUsageBestEffort } from '@/lib/ai/usage-ledger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 45;

export const POST = defineRoute({
  body: 'empty',
  resolve: (req, body: { pid?: string; conversationId?: string; question?: string }) => commsContext(req, body.pid ?? null),
  handler: async (ctx) => {
    const deadlineAt = Date.now() + 37_000;
    const convV = validateUuid(ctx.body.conversationId, 'conversationId');
    if (convV.error) return ctx.err(convV.error, { status: 400, code: ApiErrorCode.ValidationFailed });
    const qV = validateString(ctx.body.question, { max: 1500, label: 'question' });
    if (qV.error) return ctx.err(qV.error, { status: 400, code: ApiErrorCode.ValidationFailed });

    const convo = await getConversation(ctx.pid, convV.value!);
    if (!convo) return ctx.err('Not found', { status: 404, code: ApiErrorCode.NotFound });
    const allowed = await canAccessConversation(ctx.pid, ctx.staffId, convo, { isManager: ctx.isManager, dept: ctx.dept });
    if (!allowed) return ctx.err('Forbidden', { status: 403, code: ApiErrorCode.Forbidden });

    // RAW pid (AI endpoint).
    const rl = await checkAndIncrementRateLimit('comms-assistant', ctx.pid);
    if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

    const thread = await getThreadForAssistant(ctx.pid, convo.id, 25);
    let usage: AiUsageReport | null = null;
    const result = await runStaxisAssistant({
      pid: ctx.pid,
      question: qV.value!,
      thread,
      byName: ctx.displayName,
      requestId: ctx.requestId,
      // Caller identity — gates the Knowledge hub tools to this asker's role/dept,
      // meters embedding cost to the ledger, and sets the reply language.
      role: ctx.role,
      dept: ctx.dept,
      accountId: ctx.accountId,
      lang: ctx.lang,
      ai: {
        deadlineAt,
        abortSignal: ctx.req.signal,
        onUsage: (value) => { usage = value; },
      },
    });
    await recordAiUsageBestEffort({
      usage,
      userId: ctx.accountId,
      propertyId: ctx.pid,
      kind: 'background',
      requestId: ctx.requestId,
      feature: 'communications.staxis_assistant',
    });

    // Post the assistant's reply into the conversation (auto-translated per reader).
    const posted = await postMessage(ctx.pid, convo.id, {
      senderStaffId: null,
      senderKind: 'staxis',
      body: result.answer,
      sourceLang: 'en',
      msgType: 'text',
      meta: { actions: result.actions },
    });

    return ctx.ok({ messageId: posted.id, answer: result.answer, actions: result.actions });
  },
});
