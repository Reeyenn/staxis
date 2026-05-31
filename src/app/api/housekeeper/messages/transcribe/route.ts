/**
 * POST /api/housekeeper/messages/transcribe  — Body: { pid, staffId, path }
 * Transcribe a floor-staff voice clip to text (OpenAI Whisper). Manual
 * capability check on (pid, staffId) + RAW-pid rate limit (AI-endpoint rule —
 * a hashed composite would FK-violate and fail closed). Transcription ONLY —
 * no calls, NO SMS.
 */
import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { validateUuid, validateString } from '@/lib/api-validate';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';
import { getStaffRow } from '@/lib/comms/core';
import { transcribeAudioBuffer } from '@/lib/comms/assistant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 45;
const BUCKET = 'housekeeping-issue-photos';

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const headers = { 'x-request-id': requestId };
  let body: { pid?: string; staffId?: string; path?: string };
  try { body = await req.json(); } catch { body = {}; }

  const pidV = validateUuid(body.pid, 'pid');
  if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers });
  const staffV = validateUuid(body.staffId, 'staffId');
  if (staffV.error) return err(staffV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers });
  const pathV = validateString(body.path, { max: 300, label: 'path' });
  if (pathV.error) return err(pathV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers });
  if (!pathV.value!.startsWith(`${pidV.value}/comms/`)) {
    return err('invalid path', { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers });
  }

  // Capability: staff must belong to this property.
  const staff = await getStaffRow(pidV.value!, staffV.value!);
  if (!staff) return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden, headers });

  const rl = await checkAndIncrementRateLimit('comms-transcribe', pidV.value!);
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  const { data: blob, error: dlErr } = await supabaseAdmin.storage.from(BUCKET).download(pathV.value!);
  if (dlErr || !blob) return err('Not found', { requestId, status: 404, code: ApiErrorCode.NotFound, headers });
  const buf = Buffer.from(await blob.arrayBuffer());
  const text = await transcribeAudioBuffer(buf, blob.type || 'audio/webm', 'voice.webm');
  return ok({ text: text ?? '' }, { requestId, headers });
}
