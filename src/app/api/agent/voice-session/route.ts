// ─── POST /api/agent/voice-session ─────────────────────────────────────────
//
// Mints a short-lived ElevenLabs Conversational AI signed URL for the
// authenticated user + property. The browser opens a WebSocket to that URL
// to talk to our voice agent.
//
// Why server-mints, never the browser:
//   - Our `ELEVENLABS_API_KEY` is workspace-scoped and lets the bearer
//     create agents, list voices, generate any TTS at any cost. We never
//     ship it to the client.
//   - The signed URL is single-use, expires fast (their default ~15 min),
//     and is bound to one specific agent. Even if a user copies it out of
//     DevTools, the blast radius is one conversation.
//
// Identity (Codex 2026-05-16 P0 fix — Pattern A):
//   We write an `agent_voice_sessions` row holding the auth-verified
//   account / property / role / staffId / conversationId, then expose
//   ONLY the row id as `staxis_voice_session_id` in dynamicVariables.
//   The browser cannot forge a different identity by tampering with the
//   ElevenLabs SDK config because the webhook will look up THIS row and
//   re-load role + property from accounts on every call. The signed URL
//   is per-user; the nonce is per-session; identity is server-canonical.
//
// Also creates an `agent_conversations` row up front. The conversation_id
// is captured in the voice-session row so the webhook can attribute
// messages without trusting client input.

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { getOrMintRequestId, log } from '@/lib/log';
import { createConversation } from '@/lib/agent/memory';
import { assertAudioBudget } from '@/lib/agent/cost-controls';
import { PROMPT_VERSION } from '@/lib/agent/prompts';
import { mintVoiceSession, VOICE_SESSION_DYNVAR_KEY } from '@/lib/agent/voice-session';
import type { AppRole } from '@/lib/roles';
import { env } from '@/lib/env';
import {
  externalFetch,
  EXTERNAL_FETCH_SHORT_TIMEOUT_MS,
} from '@/lib/external-service-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RequestBody {
  propertyId: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);

  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid json', requestId }, { status: 400 });
  }
  if (!body.propertyId) {
    return NextResponse.json({ ok: false, error: 'propertyId required', requestId }, { status: 400 });
  }

  const hasAccess = await userHasPropertyAccess(auth.userId, body.propertyId);
  if (!hasAccess) {
    return NextResponse.json({ ok: false, error: 'no access to this property', requestId }, { status: 403 });
  }

  const apiKey = env.ELEVENLABS_API_KEY;
  const agentId = env.ELEVENLABS_AGENT_ID;
  if (!apiKey || !agentId) {
    log.error('[voice-session] ELEVENLABS_API_KEY or ELEVENLABS_AGENT_ID not configured', { requestId });
    return NextResponse.json({ ok: false, error: 'voice service not configured', requestId }, { status: 503 });
  }

  // Resolve account + staff context. Same shape the text /command route uses.
  const { data: account } = await supabaseAdmin
    .from('accounts')
    .select('id, username, display_name, role, data_user_id')
    .eq('data_user_id', auth.userId)
    .maybeSingle();
  if (!account) {
    return NextResponse.json({ ok: false, error: 'account not found', requestId }, { status: 404 });
  }
  const accountId = account.id as string;
  const role = ((account.role as string) ?? 'staff') as AppRole;

  // Pre-flight: refuse a NEW voice session if the user has already hit the
  // daily audio cap. Mid-session minutes meter on ElevenLabs' side; this
  // gate stops a fresh session being opened over the cap. Mirrors what the
  // legacy /transcribe route did.
  try {
    const budget = await assertAudioBudget({ userId: accountId, propertyId: body.propertyId });
    if (!budget.ok) {
      return NextResponse.json(
        { ok: false, error: budget.message, code: budget.reason, requestId },
        { status: 429 },
      );
    }
  } catch (e) {
    log.error('[voice-session] audio budget check failed', { requestId, e });
    return NextResponse.json({ ok: false, error: 'audio budget check failed', requestId }, { status: 500 });
  }

  let staffId: string | null = null;
  if (role === 'housekeeping' || role === 'maintenance') {
    const { data: staffRow } = await supabaseAdmin
      .from('staff')
      .select('id')
      .eq('auth_user_id', auth.userId)
      .eq('property_id', body.propertyId)
      .maybeSingle();
    staffId = (staffRow?.id as string) ?? null;
  }

  // Create a fresh conversation for this voice session. Each session gets
  // its own conversation row so the user can later scroll back through
  // "today's voice chat" vs "yesterday's voice chat" — same UX as text.
  let conversationId: string;
  try {
    conversationId = await createConversation({
      userAccountId: accountId,
      propertyId: body.propertyId,
      role,
      promptVersion: PROMPT_VERSION,
      title: '(voice)',
    });
  } catch (e) {
    log.error('[voice-session] failed to create conversation', { requestId, e });
    return NextResponse.json({ ok: false, error: 'failed to create conversation', requestId }, { status: 500 });
  }

  // Mint the server-side voice-session row. Codex 2026-05-16 P0 fix
  // (Pattern A): this row is the canonical identity for the duration of
  // the voice session. Its id is the ONLY thing we expose to ElevenLabs;
  // role + property are re-read from accounts on every webhook call.
  let voiceSessionId: string;
  try {
    const minted = await mintVoiceSession({
      accountId,
      userId: auth.userId,
      propertyId: body.propertyId,
      role,
      staffId,
      conversationId,
    });
    voiceSessionId = minted.id;
  } catch (e) {
    log.error('[voice-session] failed to mint voice session row', { requestId, e });
    return NextResponse.json({ ok: false, error: 'failed to mint voice session', requestId }, { status: 500 });
  }

  // Fetch a signed WebSocket URL from ElevenLabs. The URL is single-use
  // and short-lived; the browser uses it to open the conversation socket.
  // 10s timeout — signed URL mint is fast (typical <1s); if ElevenLabs is
  // hung we want to surface "voice service unavailable" rather than
  // block the user staring at a connecting spinner. (Audit finding #6.)
  let signedUrl: string;
  try {
    const r = await externalFetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`,
      { headers: { 'xi-api-key': apiKey }, timeoutMs: EXTERNAL_FETCH_SHORT_TIMEOUT_MS },
    );
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      log.error('[voice-session] ElevenLabs signed-url fetch failed', { requestId, status: r.status, body: txt.slice(0, 200) });
      return NextResponse.json({ ok: false, error: 'voice service unavailable', requestId }, { status: 502 });
    }
    const payload = await r.json() as { signed_url?: string };
    if (!payload.signed_url) {
      log.error('[voice-session] ElevenLabs response missing signed_url', { requestId });
      return NextResponse.json({ ok: false, error: 'voice service returned unexpected payload', requestId }, { status: 502 });
    }
    signedUrl = payload.signed_url;
  } catch (e) {
    log.error('[voice-session] ElevenLabs request error', { requestId, e });
    return NextResponse.json({ ok: false, error: 'voice service unreachable', requestId }, { status: 502 });
  }

  return NextResponse.json({
    ok: true,
    data: {
      signedUrl,
      agentId,
      conversationId,
      // Codex 2026-05-16 P0 fix (Pattern A): only the voice-session NONCE
      // flows through ElevenLabs. The webhook looks it up in
      // agent_voice_sessions and re-loads identity from the accounts
      // table. Any other field passed via dynamic_variables is
      // diagnostic-only and ignored for authorization. Account/property/
      // role used to live here — they don't anymore precisely because the
      // browser can swap them inside the ElevenLabs SDK before the WS
      // handshake.
      dynamicVariables: {
        [VOICE_SESSION_DYNVAR_KEY]: voiceSessionId,
        staxis_request_id: requestId,
      },
    },
    requestId,
  });
}
