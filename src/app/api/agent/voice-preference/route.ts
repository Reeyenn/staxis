// ─── /api/agent/voice-preference ─────────────────────────────────────────
// Voice surface — read or update the user's per-account voice preferences.
//
// GET   → returns the current state ({ voiceRepliesEnabled, wakeWordEnabled,
//         voiceOnboardedAt }). Used by the chat panel + Settings page to
//         hydrate toggle initial values.
//
// POST  → updates one or both toggles. Body: { voiceReplies?: boolean,
//         wakeWordEnabled?: boolean }. If voiceReplies is provided and
//         voice_onboarded_at is currently NULL, also stamps it to now()
//         (used to suppress the first-time modal on subsequent visits).

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireSession } from '@/lib/api-auth';
import { getOrMintRequestId } from '@/lib/log';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { captureException } from '@/lib/sentry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

interface PreferenceRow {
  id: string;
  voice_replies_enabled: boolean | null;
  wake_word_enabled: boolean | null;
  voice_onboarded_at: string | null;
}

interface PreferenceBody {
  voiceReplies?: boolean;
  wakeWordEnabled?: boolean;
}

async function loadPreferences(authUserId: string): Promise<PreferenceRow | null> {
  const { data, error } = await supabaseAdmin
    .from('accounts')
    .select('id, voice_replies_enabled, wake_word_enabled, voice_onboarded_at')
    .eq('data_user_id', authUserId)
    .maybeSingle();
  if (error) {
    captureException(error, { route: 'agent/voice-preference', step: 'load' });
    return null;
  }
  return (data as PreferenceRow | null) ?? null;
}

function shape(row: PreferenceRow) {
  return {
    voiceRepliesEnabled: row.voice_replies_enabled === true,
    wakeWordEnabled: row.wake_word_enabled === true,
    voiceOnboardedAt: row.voice_onboarded_at,
  };
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;

  const row = await loadPreferences(auth.userId);
  if (!row) {
    return err('account not found', {
      requestId, status: 404, code: ApiErrorCode.NotFound,
    });
  }
  return ok(shape(row), { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;

  let body: PreferenceBody;
  try {
    body = (await req.json()) as PreferenceBody;
  } catch {
    return err('invalid json', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }

  if (body.voiceReplies === undefined && body.wakeWordEnabled === undefined) {
    return err('nothing to update', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }

  const existing = await loadPreferences(auth.userId);
  if (!existing) {
    return err('account not found', {
      requestId, status: 404, code: ApiErrorCode.NotFound,
    });
  }

  const update: Record<string, unknown> = {};
  if (typeof body.voiceReplies === 'boolean') {
    update.voice_replies_enabled = body.voiceReplies;
  }
  if (typeof body.wakeWordEnabled === 'boolean') {
    update.wake_word_enabled = body.wakeWordEnabled;
  }
  // First time the user makes any voice choice, stamp the onboarding column
  // so the first-time modal doesn't show again.
  if (existing.voice_onboarded_at === null && body.voiceReplies !== undefined) {
    update.voice_onboarded_at = new Date().toISOString();
  }

  const { data: updated, error: updateErr } = await supabaseAdmin
    .from('accounts')
    .update(update)
    .eq('id', existing.id)
    .select('id, voice_replies_enabled, wake_word_enabled, voice_onboarded_at')
    .single();

  if (updateErr || !updated) {
    captureException(updateErr ?? new Error('preference update returned no row'), {
      route: 'agent/voice-preference', step: 'update',
    });
    return err('failed to update preferences', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }

  return ok(shape(updated as PreferenceRow), { requestId });
}
