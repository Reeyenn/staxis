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
// We bundle the user's identity + property + role + staffId into
// ElevenLabs `dynamic_variables`. ElevenLabs forwards those to our
// `/api/agent/voice-brain` webhook on every turn, so the brain can
// reconstruct the same `ToolContext` text mode uses without a separate
// session lookup.
//
// Also creates an `agent_conversations` row up front. The conversation_id
// flows through dynamic_variables → brain webhook → memory writes, so
// voice turns land in the same conversation history as text turns and
// the user can scroll through both surfaces interleaved.

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { getOrMintRequestId, log } from '@/lib/log';
import { createConversation } from '@/lib/agent/memory';
import { assertAudioBudget } from '@/lib/agent/cost-controls';
import { PROMPT_VERSION } from '@/lib/agent/prompts';
import type { AppRole } from '@/lib/roles';
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

  const apiKey = process.env.ELEVENLABS_API_KEY;
  const agentId = process.env.ELEVENLABS_AGENT_ID;
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
      // These are forwarded by ElevenLabs to /api/agent/voice-brain on
      // every webhook call. The brain reconstructs ToolContext from them.
      // Values are constrained to string|number|boolean per the SDK
      // signature; we encode the optional staffId as the empty string
      // (instead of null) so the brain can treat it uniformly.
      dynamicVariables: {
        staxis_account_id: accountId,
        staxis_user_id: auth.userId,
        staxis_property_id: body.propertyId,
        staxis_role: role,
        staxis_staff_id: staffId ?? '',
        staxis_conversation_id: conversationId,
        staxis_request_id: requestId,
      },
    },
    requestId,
  });
}
