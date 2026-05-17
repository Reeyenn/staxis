// ─── POST /api/agent/speak ───────────────────────────────────────────────
// Walkthrough narration endpoint — text-to-speech via ElevenLabs Jessica
// (same voice the conversation surface uses, so the walkthrough sounds
// like the same person). Returns MP3 bytes that the client plays inline.
//
// Body: { text: string, propertyId: string, conversationId?: string }
//
// Was OpenAI tts-1/nova until 2026-05-14; swapped to ElevenLabs Turbo v2.5
// for voice consistency with the realtime voice chat. Old conversation
// surface (Whisper+Nova) was ripped out by 8479570 — this route is now
// walkthrough-only.
//
// Cost record runs after the call succeeds; aborts still bill ElevenLabs
// for generated audio, so we record the full text-length cost regardless.

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { getOrMintRequestId, log } from '@/lib/log';
import { err, ApiErrorCode } from '@/lib/api-response';
import { captureException } from '@/lib/sentry';
import {
  assertAudioBudget,
  recordNonRequestCost,
} from '@/lib/agent/cost-controls';
import { env } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface SpeakRequestBody {
  text: string;
  propertyId: string;
  conversationId?: string;
}

// ElevenLabs accepts longer input than OpenAI's 4096-char cap, but our
// narrations are always short snippets (≤280 chars per validateAction);
// keeping the server-side guard as a defense against accidents.
const MAX_TTS_CHARS = 4096;

// ElevenLabs Turbo v2.5 pricing on Pro tier (~500k credits / $99/mo
// → $0.000198 per credit, 0.5 credits/char for Turbo models). Round up
// slightly so the ledger never under-counts.
const ELEVENLABS_TURBO_PER_THOUSAND_CHARS = 0.10; // $0.10 / 1k chars
const ELEVENLABS_MODEL_ID = 'eleven_turbo_v2_5';

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);

  // ── Auth ────────────────────────────────────────────────────────────────
  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;

  // ── Parse body ──────────────────────────────────────────────────────────
  let body: SpeakRequestBody;
  try {
    body = (await req.json()) as SpeakRequestBody;
  } catch {
    return err('invalid json', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }

  const text = (body.text ?? '').trim();
  if (!text) {
    return err('text is required', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }
  if (text.length > MAX_TTS_CHARS) {
    return err(`text exceeds ${MAX_TTS_CHARS} chars`, {
      requestId, status: 413, code: ApiErrorCode.ValidationFailed,
    });
  }
  if (!body.propertyId) {
    return err('propertyId is required', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }
  const conversationId = typeof body.conversationId === 'string' ? body.conversationId : null;

  // ── Property access ────────────────────────────────────────────────────
  const hasAccess = await userHasPropertyAccess(auth.userId, body.propertyId);
  if (!hasAccess) {
    return err('no access to this property', {
      requestId, status: 403, code: ApiErrorCode.Forbidden,
    });
  }

  // ── Resolve accountId ──────────────────────────────────────────────────
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

  // ── Cost cap pre-check (sums ALL kinds, see INV-17 note) ───────────────
  try {
    const budget = await assertAudioBudget({
      userId: accountId,
      propertyId: body.propertyId,
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
    captureException(e, { route: 'agent/speak', step: 'budget' });
    return err('audio budget check failed', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }

  // ── Env check ──────────────────────────────────────────────────────────
  const apiKey = env.ELEVENLABS_API_KEY;
  const voiceId = env.ELEVENLABS_VOICE_ID;
  if (!apiKey || !voiceId) {
    log.error('[agent/speak] ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID not configured', { requestId });
    return err('TTS not configured', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }

  // ── Call ElevenLabs ────────────────────────────────────────────────────
  // Plain fetch — the realtime voice chat uses @elevenlabs/client for the
  // WebSocket Conversational AI surface, but for a one-shot TTS the REST
  // endpoint is simpler and avoids pulling SDK weight server-side.
  let ttsResponse: Response;
  try {
    ttsResponse = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        body: JSON.stringify({
          text,
          model_id: ELEVENLABS_MODEL_ID,
        }),
        signal: req.signal,
      },
    );
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') {
      return err('client aborted', {
        requestId, status: 499, code: ApiErrorCode.UpstreamFailure,
      });
    }
    captureException(e, { route: 'agent/speak', step: 'elevenlabs-fetch' });
    log.warn('[agent/speak] ElevenLabs TTS fetch failed', {
      requestId,
      error: e instanceof Error ? e.message : String(e),
    });
    return err('TTS generation failed', {
      requestId, status: 502, code: ApiErrorCode.UpstreamFailure,
    });
  }

  if (!ttsResponse.ok) {
    const detail = await ttsResponse.text().catch(() => '');
    log.warn('[agent/speak] ElevenLabs returned non-OK', {
      requestId,
      upstreamStatus: ttsResponse.status,
      detail: detail.slice(0, 200),
    });
    captureException(new Error(`ElevenLabs ${ttsResponse.status}: ${detail.slice(0, 200)}`), {
      route: 'agent/speak', step: 'elevenlabs-response',
    });
    return err('TTS generation failed', {
      requestId, status: 502, code: ApiErrorCode.UpstreamFailure,
    });
  }

  if (!ttsResponse.body) {
    return err('TTS returned empty body', {
      requestId, status: 502, code: ApiErrorCode.UpstreamFailure,
    });
  }

  // Record the cost up-front — ElevenLabs bills for the request regardless
  // of whether the client aborts mid-stream. We use the input text length
  // (Turbo v2.5 ~= $0.10 / 1k chars on Pro tier).
  const costUsd = (text.length / 1000) * ELEVENLABS_TURBO_PER_THOUSAND_CHARS;
  recordNonRequestCost({
    userId: accountId,
    propertyId: body.propertyId,
    conversationId,
    model: 'elevenlabs',
    modelId: ELEVENLABS_MODEL_ID,
    tokensIn: 0,
    tokensOut: 0,
    costUsd,
    kind: 'audio',
  }).catch(e => {
    captureException(e, { route: 'agent/speak', step: 'cost-ledger' });
    // Don't block the stream — audio is already coming back.
  });

  // Stream MP3 bytes through. The client uses fetch.body to play.
  return new NextResponse(ttsResponse.body, {
    status: 200,
    headers: {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-store',
      'X-Request-Id': requestId,
    },
  });
}

