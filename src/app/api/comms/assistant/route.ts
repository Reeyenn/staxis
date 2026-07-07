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
import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { validateUuid, validateString } from '@/lib/api-validate';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';
import { commsContext } from '@/lib/comms/route-helpers';
import { getConversation, canAccessConversation, getThreadForAssistant, postMessage } from '@/lib/comms/core';
import { runStaxisAssistant } from '@/lib/comms/assistant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 45;

export async function POST(req: NextRequest): Promise<Response> {
  let body: { pid?: string; conversationId?: string; question?: string };
  try { body = await req.json(); } catch { body = {}; }

  const ctx = await commsContext(req, body.pid ?? null);
  if (!ctx.ok) return ctx.response;

  const convV = validateUuid(body.conversationId, 'conversationId');
  if (convV.error) return err(convV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
  const qV = validateString(body.question, { max: 1500, label: 'question' });
  if (qV.error) return err(qV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });

  const convo = await getConversation(ctx.pid, convV.value!);
  if (!convo) return err('Not found', { requestId: ctx.requestId, status: 404, code: ApiErrorCode.NotFound, headers: ctx.headers });
  const allowed = await canAccessConversation(ctx.pid, ctx.staffId, convo, { isManager: ctx.isManager, dept: ctx.dept });
  if (!allowed) return err('Forbidden', { requestId: ctx.requestId, status: 403, code: ApiErrorCode.Forbidden, headers: ctx.headers });

  // RAW pid (AI endpoint).
  const rl = await checkAndIncrementRateLimit('comms-assistant', ctx.pid);
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  const thread = await getThreadForAssistant(ctx.pid, convo.id, 25);
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

  return ok({ messageId: posted.id, answer: result.answer, actions: result.actions }, { requestId: ctx.requestId, headers: ctx.headers });
}
