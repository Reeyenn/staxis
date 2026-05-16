// ─── Voice session — server-resolved identity ────────────────────────────
//
// Codex adversarial review 2026-05-16 (P0): the voice path used to
// reconstruct ToolContext entirely from `customLlmExtraBody.dynamic_variables`,
// which the browser SDK can replace before the WS handshake. Result: any
// authenticated user could mint a voice session for their own property, then
// substitute another property's UUID and the webhook would accept it.
//
// Root-cause fix (Pattern A — identity must not cross a trust boundary
// without re-validation):
//
//   1. `mintVoiceSession()` writes an agent_voice_sessions row with the
//      auth-verified account/property/role and returns ONLY the row id.
//   2. The id is the only thing that flows out through ElevenLabs.
//   3. `resolveVoiceSession()` loads the row by id, re-reads the role and
//      property_access FROM accounts (not from the snapshot — snapshots are
//      audit-only), and re-runs the property-access check. Mid-session
//      revocation propagates immediately.
//
// The webhook MUST call `resolveVoiceSession()` on every turn and use its
// return value for ToolContext — never the raw dynamic_variables payload.

import { supabaseAdmin } from '@/lib/supabase-admin';
import { userHasPropertyAccess } from '@/lib/api-auth';
import type { AppRole } from '@/lib/roles';

/** Compact name for the dynamic-variable key we pass through ElevenLabs. */
export const VOICE_SESSION_DYNVAR_KEY = 'staxis_voice_session_id';

export interface VoiceSessionMintArgs {
  accountId: string;
  userId: string;
  propertyId: string;
  role: AppRole;
  staffId: string | null;
  conversationId: string;
}

export interface VoiceSessionMintResult {
  id: string;
  expiresAt: string;
}

export interface ResolvedVoiceSession {
  accountId: string;
  userId: string;
  propertyId: string;
  role: AppRole;
  staffId: string | null;
  conversationId: string;
}

export type ResolveError =
  | 'not_found'
  | 'expired'
  | 'account_missing'
  | 'access_revoked';

/**
 * Mint a server-side voice-session row. Caller is responsible for verifying
 * `userHasPropertyAccess(userId, propertyId)` BEFORE calling this — we don't
 * re-verify here because the call site (`/api/agent/voice-session`) has
 * already done it and we don't want a redundant DB round-trip on the hot path.
 *
 * Returns the row id (the nonce that flows through ElevenLabs) and the
 * expiry timestamp.
 */
export async function mintVoiceSession(args: VoiceSessionMintArgs): Promise<VoiceSessionMintResult> {
  const { data, error } = await supabaseAdmin
    .from('agent_voice_sessions')
    .insert({
      account_id: args.accountId,
      data_user_id: args.userId,
      property_id: args.propertyId,
      conversation_id: args.conversationId,
      role_snapshot: args.role,
      staff_id_snapshot: args.staffId,
    })
    .select('id, expires_at')
    .single();
  if (error || !data) {
    throw new Error(`[voice-session] insert failed: ${error?.message ?? 'no row returned'}`);
  }
  return { id: data.id as string, expiresAt: data.expires_at as string };
}

/**
 * Resolve a voice-session id back to the canonical identity. Re-loads the
 * caller's CURRENT role + property_access from the accounts table rather
 * than trusting the snapshot — so a property removed from `accounts.property_access`
 * mid-session blocks the next webhook turn.
 *
 * Returns:
 *   { ok: true, ... }    — valid session, use the resolved context
 *   { ok: false, reason } — reject the webhook turn with 401
 */
export async function resolveVoiceSession(
  id: string,
): Promise<
  | { ok: true; ctx: ResolvedVoiceSession }
  | { ok: false; reason: ResolveError }
> {
  // 1. Load the session row.
  const { data: session, error: sessionErr } = await supabaseAdmin
    .from('agent_voice_sessions')
    .select('id, account_id, data_user_id, property_id, conversation_id, expires_at')
    .eq('id', id)
    .maybeSingle();
  if (sessionErr || !session) {
    return { ok: false, reason: 'not_found' };
  }

  // 2. Check expiry.
  if (new Date(session.expires_at as string).getTime() <= Date.now()) {
    return { ok: false, reason: 'expired' };
  }

  // 3. Re-load the CURRENT role from accounts (not the snapshot). This is
  //    the key fix — the snapshot was for audit; authorization comes from
  //    the current row so revocation propagates immediately.
  const { data: account } = await supabaseAdmin
    .from('accounts')
    .select('id, role, data_user_id')
    .eq('id', session.account_id as string)
    .maybeSingle();
  if (!account || (account.data_user_id as string) !== (session.data_user_id as string)) {
    return { ok: false, reason: 'account_missing' };
  }
  const role = ((account.role as string) ?? 'staff') as AppRole;

  // 4. Re-run property-access check against the current accounts row. If
  //    the user lost access to this property between mint-time and now,
  //    the webhook must reject.
  const stillHasAccess = await userHasPropertyAccess(session.data_user_id as string, session.property_id as string);
  if (!stillHasAccess) {
    return { ok: false, reason: 'access_revoked' };
  }

  // 5. Re-resolve staffId for floor roles. If the staff row was unlinked
  //    or the user was moved off this property, staffId comes back null
  //    (which the tool layer handles — listMyRooms returns a polite error).
  let staffId: string | null = null;
  if (role === 'housekeeping' || role === 'maintenance') {
    const { data: staffRow } = await supabaseAdmin
      .from('staff')
      .select('id')
      .eq('auth_user_id', session.data_user_id as string)
      .eq('property_id', session.property_id as string)
      .maybeSingle();
    staffId = (staffRow?.id as string) ?? null;
  }

  return {
    ok: true,
    ctx: {
      accountId: session.account_id as string,
      userId: session.data_user_id as string,
      propertyId: session.property_id as string,
      role,
      staffId,
      conversationId: session.conversation_id as string,
    },
  };
}
