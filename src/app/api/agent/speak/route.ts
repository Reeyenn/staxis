// ─── POST /api/agent/speak ───────────────────────────────────────────────
// Voice surface — text-to-speech endpoint. Returns chunked MP3 audio that
// the client plays inline through a single <audio> element.
//
// Body: { text: string, voice?: 'nova', propertyId: string, conversationId?: string }
//
// The TTS player on the client fires one POST per sentence as the agent
// streams its reply, so each call is short (~50-200 chars typically).
// We don't multiplex multiple sentences into one response — keeping each
// call atomic simplifies abort handling when the user toggles speaker off
// mid-sentence (the client just aborts the in-flight fetch and skips the
// queued ones).
//
// Cost record runs after streaming finishes; aborts still bill OpenAI for
// what they generated, so we record the full text-length cost regardless.

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { getOrMintRequestId, log } from '@/lib/log';
import { err, ApiErrorCode } from '@/lib/api-response';
import { captureException } from '@/lib/sentry';
import { getOpenAIClient, OPENAI_AUDIO_PRICING } from '@/lib/openai-client';
import {
  assertAudioBudget,
  recordNonRequestCost,
} from '@/lib/agent/cost-controls';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface SpeakRequestBody {
  text: string;
  voice?: 'nova';
  propertyId: string;
  conversationId?: string;
}

// OpenAI's TTS-1 caps input at 4096 chars per call. Sentence-by-sentence
// chunking keeps us well under, but enforce it server-side too.
const MAX_TTS_CHARS = 4096;

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

  // ── Stream TTS ─────────────────────────────────────────────────────────
  // The OpenAI SDK returns a Response-like object whose `body` is a Web
  // ReadableStream of MP3 bytes. We pipe it straight back to the client.
  let ttsResponse: Response;
  try {
    const client = getOpenAIClient();
    ttsResponse = await client.audio.speech.create({
      model: 'tts-1',
      voice: body.voice ?? 'nova',
      input: text,
      response_format: 'mp3',
    });
  } catch (e) {
    captureException(e, { route: 'agent/speak', step: 'openai' });
    log.warn('[agent/speak] openai TTS failed', {
      requestId,
      error: e instanceof Error ? e.message : String(e),
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

  // Record the cost up-front — OpenAI bills for the request regardless of
  // whether the client aborts mid-stream. We use the input text length
  // (matches OpenAI's pricing model: $0.015 / 1k input chars).
  const costUsd = (text.length / 1000) * OPENAI_AUDIO_PRICING.tts1PerThousandChars;
  recordNonRequestCost({
    userId: accountId,
    propertyId: body.propertyId,
    conversationId,
    model: 'tts-1',
    modelId: 'tts-1',
    tokensIn: 0,
    tokensOut: 0,
    costUsd,
    kind: 'audio',
  }).catch(e => {
    captureException(e, { route: 'agent/speak', step: 'cost-ledger' });
    // Don't block the stream — audio is already coming back.
  });

  // Stream MP3 bytes through. The client uses fetch.body.getReader to play.
  return new NextResponse(ttsResponse.body, {
    status: 200,
    headers: {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-store',
      'X-Request-Id': requestId,
    },
  });
}

