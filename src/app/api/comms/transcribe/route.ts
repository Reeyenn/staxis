/**
 * POST /api/comms/transcribe  — Body: { pid, path }
 * Transcribe an already-uploaded voice attachment to text (OpenAI Whisper).
 * The client uploads the clip via /photo-presign (kind=voice), then calls this
 * to get the transcript, then sends a voice message with body=transcript.
 * Transcription ONLY — no calls, NO SMS. RATE LIMIT: RAW pid.
 */
import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { validateString } from '@/lib/api-validate';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';
import { commsContext } from '@/lib/comms/route-helpers';
import { transcribeAudioBuffer } from '@/lib/comms/assistant';
import { assertAudioBudget } from '@/lib/agent/cost-controls';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 45;

const BUCKET = 'housekeeping-issue-photos';

export async function POST(req: NextRequest): Promise<Response> {
  const deadlineAt = Date.now() + 37_000;
  let body: { pid?: string; path?: string };
  try { body = await req.json(); } catch { body = {}; }

  const ctx = await commsContext(req, body.pid ?? null);
  if (!ctx.ok) return ctx.response;

  const pV = validateString(body.path, { max: 300, label: 'path' });
  if (pV.error) return err(pV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
  // The clip must live inside THIS property's comms namespace.
  if (!pV.value!.startsWith(`${ctx.pid}/comms/`)) {
    return err('invalid path', { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
  }

  const rl = await checkAndIncrementRateLimit('comms-transcribe', ctx.pid);
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);
  const budget = await assertAudioBudget({ userId: ctx.accountId, propertyId: ctx.pid });
  if (!budget.ok) {
    return err(budget.message, {
      requestId: ctx.requestId,
      status: 429,
      code: budget.reason,
      headers: ctx.headers,
    });
  }

  const { data: blob, error: dlErr } = await supabaseAdmin.storage.from(BUCKET).download(pV.value!);
  if (dlErr || !blob) {
    return err('Not found', { requestId: ctx.requestId, status: 404, code: ApiErrorCode.NotFound, headers: ctx.headers });
  }
  const buf = Buffer.from(await blob.arrayBuffer());
  const text = await transcribeAudioBuffer(buf, blob.type || 'audio/webm', 'voice.webm', {
    deadlineAt,
    abortSignal: req.signal,
    // The AI runtime records the spend itself (agent_costs, kind=audio).
    ledger: {
      userId: ctx.accountId,
      propertyId: ctx.pid,
      kind: 'audio',
      requestId: ctx.requestId,
      feature: 'communications.voice_transcription',
    },
  });
  return ok({ text: text ?? '' }, { requestId: ctx.requestId, headers: ctx.headers });
}
