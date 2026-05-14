// ─── POST /api/agent/transcribe ──────────────────────────────────────────
// Voice surface — speech-to-text endpoint.
//
// Accepts a multipart/form-data upload containing:
//   - audio: File         (webm/opus on Chrome, wav on iOS Safari)
//   - propertyId: string  (the property the user is operating on)
//   - conversationId?: string (optional — links the recording to a conversation)
//
// Steps:
//   1. requireSession + property access check
//   2. assertAudioBudget — refuse if today's audio + text spend ≥ user cap
//   3. Upload bytes to the private `voice-recordings` Supabase bucket
//   4. Insert a voice_recordings row (transcript NULL — populated after Whisper)
//   5. Call OpenAI Whisper (whisper-1) with the file + a hotel-context prompt
//   6. Update the voice_recordings row with transcript + duration + cost
//   7. Record the cost in agent_costs (kind='audio')
//   8. Return { transcript, durationSec, audioStorageKey, language }
//
// The audio object stays in storage for 7 days so we can replay / debug
// transcription accuracy. The daily cron at /api/cron/voice-recordings-purge
// deletes expired rows + the referenced storage objects.

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { getOrMintRequestId, log } from '@/lib/log';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { captureException } from '@/lib/sentry';
import { getOpenAIClient, OPENAI_AUDIO_PRICING } from '@/lib/openai-client';
import { getVoiceContextHint } from '@/lib/agent/context';
import {
  assertAudioBudget,
  recordNonRequestCost,
} from '@/lib/agent/cost-controls';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Max upload size — Whisper accepts up to 25MB, but at our recording config
// (16kHz mono WAV, 60s cap) we're at <2MB. 5MB is the conservative cap.
const MAX_AUDIO_BYTES = 5 * 1024 * 1024;

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);

  // ── Auth ────────────────────────────────────────────────────────────────
  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;

  // ── Parse multipart body ────────────────────────────────────────────────
  let form: FormData;
  try {
    form = await req.formData();
  } catch (e) {
    return err('invalid multipart body', {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
      details: e instanceof Error ? e.message : String(e),
    });
  }

  const audio = form.get('audio');
  const propertyId = form.get('propertyId');
  const conversationIdRaw = form.get('conversationId');
  const conversationId = typeof conversationIdRaw === 'string' && conversationIdRaw.length > 0
    ? conversationIdRaw
    : null;

  if (!(audio instanceof File) || audio.size === 0) {
    return err('audio file is required', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }
  if (audio.size > MAX_AUDIO_BYTES) {
    return err(`audio exceeds ${Math.floor(MAX_AUDIO_BYTES / 1024 / 1024)}MB cap`, {
      requestId, status: 413, code: ApiErrorCode.ValidationFailed,
    });
  }
  if (typeof propertyId !== 'string' || !propertyId) {
    return err('propertyId is required', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }

  // ── Property access ────────────────────────────────────────────────────
  const hasAccess = await userHasPropertyAccess(auth.userId, propertyId);
  if (!hasAccess) {
    return err('no access to this property', {
      requestId, status: 403, code: ApiErrorCode.Forbidden,
    });
  }

  // ── Resolve accounts.id (FK target for voice_recordings + agent_costs) ─
  const { data: account } = await supabaseAdmin
    .from('accounts')
    .select('id')
    .eq('data_user_id', auth.userId)
    .maybeSingle();
  if (!account) {
    return err('account not found', {
      requestId, status: 404, code: ApiErrorCode.NotFound,
    });
  }
  const accountId = account.id as string;

  // ── Cost cap pre-check ─────────────────────────────────────────────────
  // Sums ALL kinds (text + audio + background) for this user today and
  // refuses if at the tier-specific cap. See INV-17 note in INVARIANTS.md.
  try {
    const budget = await assertAudioBudget({
      userId: accountId,
      propertyId,
    });
    if (!budget.ok) {
      return err(budget.message, {
        requestId,
        status: 429,
        code: ApiErrorCode.RateLimited,
        details: { reason: budget.reason },
      });
    }
  } catch (e) {
    captureException(e, { route: 'agent/transcribe', step: 'budget' });
    return err('audio budget check failed', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }

  // ── Upload audio to storage ────────────────────────────────────────────
  const audioBuffer = Buffer.from(await audio.arrayBuffer());
  const ext = pickExtensionForMime(audio.type) ?? 'webm';
  const recordingId = crypto.randomUUID();
  const storageKey = `${accountId}/${recordingId}.${ext}`;

  const { error: uploadErr } = await supabaseAdmin.storage
    .from('voice-recordings')
    .upload(storageKey, audioBuffer, {
      contentType: audio.type || 'audio/webm',
      upsert: false,
    });
  if (uploadErr) {
    captureException(uploadErr, { route: 'agent/transcribe', step: 'upload', storageKey });
    return err('failed to store audio', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }

  // ── Insert voice_recordings row (no transcript yet) ────────────────────
  const { data: recordingRow, error: insertErr } = await supabaseAdmin
    .from('voice_recordings')
    .insert({
      id: recordingId,
      user_id: accountId,
      property_id: propertyId,
      conversation_id: conversationId,
      storage_key: storageKey,
      duration_sec: 0,
      cost_usd: 0,
    })
    .select('id')
    .single();
  if (insertErr || !recordingRow) {
    captureException(insertErr ?? new Error('voice_recordings insert failed'), {
      route: 'agent/transcribe',
      step: 'insert',
    });
    // Try to clean up the uploaded object; best effort.
    await supabaseAdmin.storage.from('voice-recordings').remove([storageKey]).catch(() => {});
    return err('failed to record audio metadata', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }

  // ── Call OpenAI transcription ──────────────────────────────────────────
  // Was whisper-1 + verbose_json. Switched to gpt-4o-mini-transcribe for
  // latency — short-clip transcribe is 2-3× faster (1-1.5s vs 3-4s) at
  // similar cost and comparable accuracy on clean speech.
  //
  // Tradeoff: gpt-4o-mini-transcribe only supports response_format='json',
  // so we lose `language` (auto-detect) and `duration` (clip seconds) on
  // the response. Both fields are still recorded on voice_recordings:
  //   - language: left null. Whisper-prompt hints already bias toward the
  //     property's vocabulary; downstream code treats null as "unknown".
  //   - durationSec: estimated from the audio blob size + bitrate. For
  //     billing/cost-cap purposes this is within ~10% of the true value,
  //     which is well inside the cap headroom.
  let transcript = '';
  let language: string | null = null;
  let durationSec = estimateDurationSeconds(audio);
  try {
    const client = getOpenAIClient();
    const promptHint = await getVoiceContextHint(propertyId);

    const result = await client.audio.transcriptions.create({
      file: audio,
      model: 'gpt-4o-mini-transcribe',
      prompt: promptHint || undefined,
      response_format: 'json',
    });

    transcript = (result.text ?? '').trim();
  } catch (e) {
    captureException(e, { route: 'agent/transcribe', step: 'whisper', storageKey });
    log.warn('[agent/transcribe] whisper failed', {
      requestId,
      error: e instanceof Error ? e.message : String(e),
    });
    return err('transcription failed', {
      requestId, status: 502, code: ApiErrorCode.UpstreamFailure,
    });
  }

  // ── Cost record + row update ───────────────────────────────────────────
  const costUsd = (durationSec / 60) * OPENAI_AUDIO_PRICING.gpt4oMiniTranscribePerMinute;

  await supabaseAdmin
    .from('voice_recordings')
    .update({
      transcript,
      language,
      duration_sec: durationSec,
      cost_usd: costUsd,
    })
    .eq('id', recordingId);

  // Record cost ledger entry — kind='audio' so it shows separately on the
  // admin spend dashboard and counts toward assertAudioBudget on the next call.
  try {
    await recordNonRequestCost({
      userId: accountId,
      propertyId,
      conversationId,
      model: 'gpt-4o-mini-transcribe',
      modelId: 'gpt-4o-mini-transcribe',
      tokensIn: 0,
      tokensOut: 0,
      costUsd,
      kind: 'audio',
    });
  } catch (e) {
    captureException(e, { route: 'agent/transcribe', step: 'cost-ledger' });
    // Don't fail the request — the user got their transcript. Sentry alerts;
    // ops reconciles from voice_recordings.cost_usd if needed.
  }

  return ok(
    { transcript, durationSec, audioStorageKey: storageKey, language },
    { requestId },
  );
}

/**
 * Estimate a clip's duration from its blob size + MIME type. Used when the
 * transcribe model doesn't return `duration` on the response (gpt-4o-mini-
 * transcribe only supports `json`, which omits both `language` and
 * `duration`).
 *
 * Bitrate constants are conservative averages for the codecs the client
 * actually emits — MediaRecorder webm/opus at 16-24 kbps mono, recordrtc
 * WAV at 16 kHz mono 16-bit. The estimate is within ~10% of the true
 * duration in practice, which is fine for cost-ledger accounting (cost
 * caps are bounded by daily totals so a small per-clip error doesn't
 * drift). If we ever need exact duration here (e.g. for per-second
 * billing), pass `durationMs` from the client FormData instead.
 */
function estimateDurationSeconds(audio: File): number {
  const size = audio.size;
  if (!size) return 0;
  const mime = audio.type.toLowerCase();
  // Bytes per second for the codec.
  let bytesPerSec = 3000; // default: opus mono ~24 kbps
  if (mime.includes('wav')) bytesPerSec = 32000; // 16 kHz × 16-bit × mono
  else if (mime.includes('mp4') || mime.includes('mpeg')) bytesPerSec = 4000; // AAC ~32 kbps
  // Clamp to plausible range — a 0.5s minimum protects against tiny header-
  // only blobs registering as zero cost, and a 120s ceiling protects against
  // a runaway upload eating the entire daily cap on one call.
  return Math.max(0.5, Math.min(120, size / bytesPerSec));
}

function pickExtensionForMime(mime: string): string | null {
  // Map the common browser-recorder MIME types to file extensions Whisper
  // will recognize. Whisper sniffs the content too, but the extension helps
  // when the MIME is `application/octet-stream` (mobile Safari sometimes).
  const map: Record<string, string> = {
    'audio/webm': 'webm',
    'audio/webm;codecs=opus': 'webm',
    'audio/ogg': 'ogg',
    'audio/ogg;codecs=opus': 'ogg',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/mp4': 'mp4',
    'audio/mpeg': 'mp3',
  };
  return map[mime.toLowerCase()] ?? null;
}
