/**
 * POST /api/housekeeper/messages/presign
 * Body: { pid, staffId, conversationId, kind, filename }
 * Signed-upload URL for a photo/voice attachment in a floor conversation
 * (private bucket). Capability-gated. NO SMS.
 */
import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { validateUuid, validateString, validateEnum } from '@/lib/api-validate';
import { gateHousekeeperRequest } from '@/lib/housekeeper-workflow/auth';
import { getConversation, canAccessConversation, presignAttachment, getStaffRow } from '@/lib/comms/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body { pid?: string; staffId?: string; conversationId?: string; kind?: string; filename?: string }

export async function POST(req: NextRequest): Promise<Response> {
  const gate = await gateHousekeeperRequest<Body>(req, 'comms-photo-presign');
  if (!gate.ok) return gate.response;
  const b = gate.body;

  const convV = validateUuid(b.conversationId, 'conversationId');
  if (convV.error) return err(convV.error, { requestId: gate.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: gate.headers });
  const kindV = validateEnum(b.kind, ['photo', 'voice'] as const, 'kind');
  if (kindV.error) return err(kindV.error, { requestId: gate.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: gate.headers });
  const fnameV = validateString(b.filename, { max: 200, label: 'filename' });
  if (fnameV.error) return err(fnameV.error, { requestId: gate.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: gate.headers });

  const convo = await getConversation(gate.pid, convV.value!);
  if (!convo) return err('Not found', { requestId: gate.requestId, status: 404, code: ApiErrorCode.NotFound, headers: gate.headers });
  const staff = await getStaffRow(gate.pid, gate.staffId);
  const allowed = await canAccessConversation(gate.pid, gate.staffId, convo, { isManager: false, dept: staff?.department ?? null });
  if (!allowed) return err('Forbidden', { requestId: gate.requestId, status: 403, code: ApiErrorCode.Forbidden, headers: gate.headers });

  const res = await presignAttachment(gate.pid, convo.id, kindV.value as 'photo' | 'voice', fnameV.value!);
  if (!res) return err('Internal server error', { requestId: gate.requestId, status: 500, code: ApiErrorCode.InternalError, headers: gate.headers });
  return ok(res, { requestId: gate.requestId, headers: gate.headers });
}
