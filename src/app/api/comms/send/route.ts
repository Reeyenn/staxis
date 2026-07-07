/**
 * POST /api/comms/send
 * Body: { pid, conversationId, body?, msgType?, attachmentPath?, attachmentKind?,
 *         voiceDurationMs?, handoffShift?, handoffOutstanding? }
 * Posts a message to a conversation the caller can access. Announcements go
 * through /api/comms/announce instead (managers only). Authenticated. NO SMS.
 */
import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { validateUuid, validateString } from '@/lib/api-validate';
import { checkAndIncrementRateLimit, rateLimitedResponse, hashToRateLimitKey } from '@/lib/api-ratelimit';
import { commsContext } from '@/lib/comms/route-helpers';
import { requireSectionEnabled } from '@/lib/sections/server';
import { getConversation, canAccessConversation, postMessage, getMessageScope } from '@/lib/comms/core';
import type { MessageType } from '@/lib/comms/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body {
  pid?: string;
  conversationId?: string;
  body?: string;
  msgType?: MessageType;
  attachmentPath?: string;
  attachmentKind?: 'photo' | 'voice';
  voiceDurationMs?: number;
  handoffShift?: string;
  handoffOutstanding?: string;
  /** When set, this message is a threaded reply to that top-level message. */
  parentMessageId?: string;
}

const ALLOWED_TYPES = new Set<MessageType>(['text', 'handoff', 'photo', 'voice']);

export async function POST(req: NextRequest): Promise<Response> {
  let body: Body;
  try { body = (await req.json()) as Body; } catch { body = {}; }

  const ctx = await commsContext(req, body.pid ?? null);
  if (!ctx.ok) return ctx.response;

  // Section gate (add-on, on top of the comms tenant guard above): if
  // Communications is turned off for this hotel, block sending messages.
  const sectionGate = await requireSectionEnabled(req, ctx.pid, 'communications');
  if (!sectionGate.ok) return sectionGate.response;

  const convV = validateUuid(body.conversationId, 'conversationId');
  if (convV.error) {
    return err(convV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
  }

  const msgType: MessageType = body.msgType && ALLOWED_TYPES.has(body.msgType) ? body.msgType : 'text';
  const text = (body.body ?? '').trim();
  const hasAttachment = !!body.attachmentPath;
  if (!text && !hasAttachment) {
    return err('message is empty', { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
  }
  if (text.length > 4000) {
    return err('message too long (max 4000 chars)', { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
  }
  // Attachment path, if present, must be inside this property's namespace.
  if (body.attachmentPath && !body.attachmentPath.startsWith(`${ctx.pid}/comms/`)) {
    return err('invalid attachment path', { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
  }

  const rl = await checkAndIncrementRateLimit('comms-send', hashToRateLimitKey(`${ctx.pid}:${ctx.userId}`));
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  const convo = await getConversation(ctx.pid, convV.value!);
  if (!convo) {
    return err('Not found', { requestId: ctx.requestId, status: 404, code: ApiErrorCode.NotFound, headers: ctx.headers });
  }
  // Announcements are broadcast-only — posting goes through /api/comms/announce.
  if (convo.kind === 'announcement') {
    return err('use /api/comms/announce for announcements', { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
  }
  const allowed = await canAccessConversation(ctx.pid, ctx.staffId, convo, { isManager: ctx.isManager, dept: ctx.dept });
  if (!allowed) {
    return err('Forbidden', { requestId: ctx.requestId, status: 403, code: ApiErrorCode.Forbidden, headers: ctx.headers });
  }

  const handoffShift = msgType === 'handoff' && body.handoffShift
    ? validateString(body.handoffShift, { max: 20, label: 'handoffShift' }).value ?? null
    : null;

  // Threaded reply: the parent must be a real message in THIS conversation.
  let parentMessageId: string | null = null;
  if (body.parentMessageId) {
    const pv = validateUuid(body.parentMessageId, 'parentMessageId');
    if (pv.error) {
      return err(pv.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
    }
    const scope = await getMessageScope(ctx.pid, pv.value!);
    if (!scope || scope.conversationId !== convo.id) {
      return err('parent message not found', { requestId: ctx.requestId, status: 404, code: ApiErrorCode.NotFound, headers: ctx.headers });
    }
    parentMessageId = pv.value!;
  }

  const msg = await postMessage(ctx.pid, convo.id, {
    senderStaffId: ctx.staffId,
    senderKind: 'staff',
    body: text,
    sourceLang: ctx.lang,
    msgType,
    attachmentPath: body.attachmentPath ?? null,
    attachmentKind: body.attachmentKind ?? null,
    voiceDurationMs: typeof body.voiceDurationMs === 'number' ? body.voiceDurationMs : null,
    handoffShift,
    handoffOutstanding: msgType === 'handoff' ? (body.handoffOutstanding ?? null) : null,
    parentMessageId,
  });

  return ok({ id: msg.id, createdAt: msg.createdAt }, { requestId: ctx.requestId, status: 201, headers: ctx.headers });
}
