/**
 * POST /api/housekeeper/messages/send
 * Body: { pid, staffId, conversationId, body?, msgType?, attachmentPath?, attachmentKind?, voiceDurationMs? }
 * Floor staff send a text / voice / photo message into a conversation they
 * belong to. They cannot post announcements (broadcast is manager-only).
 * Capability-gated. NO SMS.
 */
import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { validateUuid } from '@/lib/api-validate';
import { gateHousekeeperRequest } from '@/lib/housekeeper-workflow/auth';
import { getConversation, canAccessConversation, postMessage, getStaffRow, normalizeLang } from '@/lib/comms/core';
import { requirePropertySectionEnabled } from '@/lib/sections/server';
import { parseCommsAttachmentPath } from '@/lib/comms/attachments';
import type { MessageType } from '@/lib/comms/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body {
  pid?: string; staffId?: string; conversationId?: string; body?: string;
  msgType?: MessageType; attachmentPath?: string; attachmentKind?: 'photo' | 'voice'; voiceDurationMs?: number;
}
const ALLOWED = new Set<MessageType>(['text', 'photo', 'voice']);

export async function POST(req: NextRequest): Promise<Response> {
  const gate = await gateHousekeeperRequest<Body>(req, 'comms-send');
  if (!gate.ok) return gate.response;
  const sectionGate = await requirePropertySectionEnabled(gate.pid, 'communications', gate);
  if (!sectionGate.ok) return sectionGate.response;
  const b = gate.body;

  const convV = validateUuid(b.conversationId, 'conversationId');
  if (convV.error) return err(convV.error, { requestId: gate.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: gate.headers });

  const text = (b.body ?? '').trim();
  if (!text && !b.attachmentPath) return err('message is empty', { requestId: gate.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: gate.headers });
  if (text.length > 4000) return err('message too long', { requestId: gate.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: gate.headers });
  let validatedAttachmentKind: 'photo' | 'voice' | null = null;
  if (b.attachmentPath) {
    const attachment = parseCommsAttachmentPath(gate.pid, b.attachmentPath);
    if (!attachment) {
      return err('invalid attachment path', { requestId: gate.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: gate.headers });
    }
    if (attachment.conversationId !== convV.value) {
      return err('attachment belongs to a different conversation', { requestId: gate.requestId, status: 403, code: ApiErrorCode.Forbidden, headers: gate.headers });
    }
    if (b.attachmentKind && b.attachmentKind !== attachment.kind) {
      return err('attachment kind does not match its file type', { requestId: gate.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: gate.headers });
    }
    validatedAttachmentKind = attachment.kind;
  }

  const convo = await getConversation(gate.pid, convV.value!);
  if (!convo) return err('Not found', { requestId: gate.requestId, status: 404, code: ApiErrorCode.NotFound, headers: gate.headers });
  if (convo.kind === 'announcement') return err('floor staff cannot post announcements', { requestId: gate.requestId, status: 403, code: ApiErrorCode.Forbidden, headers: gate.headers });

  const staff = await getStaffRow(gate.pid, gate.staffId);
  const allowed = await canAccessConversation(gate.pid, gate.staffId, convo, { isManager: false, dept: staff?.department ?? null });
  if (!allowed) return err('Forbidden', { requestId: gate.requestId, status: 403, code: ApiErrorCode.Forbidden, headers: gate.headers });

  const msgType: MessageType = b.msgType && ALLOWED.has(b.msgType) ? b.msgType : 'text';
  const msg = await postMessage(gate.pid, convo.id, {
    senderStaffId: gate.staffId,
    senderKind: 'staff',
    body: text,
    sourceLang: normalizeLang(staff?.language),
    msgType,
    attachmentPath: b.attachmentPath ?? null,
    attachmentKind: validatedAttachmentKind,
    voiceDurationMs: typeof b.voiceDurationMs === 'number' ? b.voiceDurationMs : null,
  });
  return ok({ id: msg.id, createdAt: msg.createdAt }, { requestId: gate.requestId, status: 201, headers: gate.headers });
}
