/**
 * POST /api/housekeeper/messages/thread  — Body: { pid, staffId, conversationId }
 * Messages in one conversation, auto-translated into the housekeeper's saved
 * language. Opening marks it read. Capability-gated. NO SMS.
 */
import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { validateUuid } from '@/lib/api-validate';
import { gateHousekeeperRequest } from '@/lib/housekeeper-workflow/auth';
import { getConversation, canAccessConversation, getMessages, markConversationRead, getStaffRow, normalizeLang } from '@/lib/comms/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface Body { pid?: string; staffId?: string; conversationId?: string }

export async function POST(req: NextRequest): Promise<Response> {
  const gate = await gateHousekeeperRequest<Body>(req, 'comms-read');
  if (!gate.ok) return gate.response;

  const convV = validateUuid(gate.body.conversationId, 'conversationId');
  if (convV.error) return err(convV.error, { requestId: gate.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: gate.headers });

  const staff = await getStaffRow(gate.pid, gate.staffId);
  const dept = staff?.department ?? null;
  const lang = normalizeLang(staff?.language);

  const convo = await getConversation(gate.pid, convV.value!);
  if (!convo) return err('Not found', { requestId: gate.requestId, status: 404, code: ApiErrorCode.NotFound, headers: gate.headers });
  const allowed = await canAccessConversation(gate.pid, gate.staffId, convo, { isManager: false, dept });
  if (!allowed) return err('Forbidden', { requestId: gate.requestId, status: 403, code: ApiErrorCode.Forbidden, headers: gate.headers });

  const messages = await getMessages(gate.pid, convo.id, gate.staffId, lang, { withReceipts: false });
  await markConversationRead(gate.pid, convo.id, gate.staffId);

  return ok(
    { conversation: { id: convo.id, kind: convo.kind, title: convo.title }, messages },
    { requestId: gate.requestId, headers: gate.headers },
  );
}
