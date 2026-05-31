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
import { env } from '@/lib/env';
import type { AppRole } from '@/lib/roles';

/** Compact name for the dynamic-variable key we pass through ElevenLabs. */
export const VOICE_SESSION_DYNVAR_KEY = 'staxis_voice_session_id';

/**
 * Voice agent operating modes. Persisted on the session row at mint-time so a
 * client cannot escalate mid-session. The webhook reads the mode out of
 * agent_voice_sessions (NOT dynamic_variables) and uses it to pick the system
 * prompt + filter the tool catalog.
 *
 *   'general'           — full voice catalog scoped by role (default).
 *   'housekeeper_issue' — locked to createMaintenanceWorkOrder + a specialized
 *                         prompt. Used by the mic button on the housekeeper
 *                         room card.
 *   'compliance'        — engineering-compliance logging tools (log_reading,
 *                         log_pm_check, get_compliance_status). Feature #19;
 *                         kept off the general voice catalog so the secure
 *                         empty-default posture is preserved.
 */
export type VoiceMode = 'general' | 'housekeeper_issue' | 'compliance';

export interface VoiceSessionMintArgs {
  accountId: string;
  userId: string;
  propertyId: string;
  role: AppRole;
  staffId: string | null;
  conversationId: string;
  /** Operating mode (default 'general'). Persisted on the row so the webhook
   *  reads it from the DB on every turn, not from dynamic_variables. */
  mode?: VoiceMode;
  /** UI-supplied room hint (e.g. the room card the mic was tapped from).
   *  Tools default to this value when the user doesn't restate the room. */
  currentRoomNumber?: string | null;
}

export interface VoiceSessionMintResult {
  id: string;
  expiresAt: string;
}

export interface ResolvedVoiceSession {
  /** The session id itself — the row's primary key. Plumbed back into
   *  ToolContext so per-tool idempotency keys (e.g. one maintenance ticket
   *  per session) can use it as a stable, server-canonical fingerprint.
   *  Codex 2026-05-25 (MAJOR — close double-insert window). */
  voiceSessionId: string;
  accountId: string;
  userId: string;
  propertyId: string;
  role: AppRole;
  staffId: string | null;
  conversationId: string;
  mode: VoiceMode;
  currentRoomNumber: string | null;
}

export type ResolveError =
  | 'not_found'
  | 'expired'
  | 'idle_expired'
  | 'binding_mismatch'
  | 'account_missing'
  | 'access_revoked';

/**
 * Plan v2 M-1: voice-session connection binding + idle expiry.
 *
 * `IDLE_EXPIRY_MS` rejects turns that arrive more than this long after the
 * last accepted turn. Real voice conversations turn within seconds; a
 * long gap is either a replayed nonce or an abandoned session that
 * shouldn't accept new traffic. 5 minutes is comfortable above any
 * natural pause + ElevenLabs first-byte timeout (~30s).
 *
 * Lowering this is a security gain (smaller replay window). Override via
 * env `STAXIS_VOICE_SESSION_IDLE_MS` for tests.
 */
const IDLE_EXPIRY_MS = env.STAXIS_VOICE_SESSION_IDLE_MS ?? 5 * 60_000;

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
      mode: args.mode ?? 'general',
      current_room_number: args.currentRoomNumber ?? null,
      // Plan v2.1 CR-2 — stamp last_turn_at at mint so the idle clock
      // starts immediately. Before this, a freshly-minted but unused
      // session stayed valid for the full 30-min expires_at TTL — the
      // user-facing "5 min replay window" claim only held *after* the
      // first webhook turn. With this stamp, the idle expiry in
      // resolveVoiceSession fires ~5 min after mint regardless of
      // whether the user ever speaks.
      last_turn_at: new Date().toISOString(),
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
 * Plan v2 M-1: connection binding + idle expiry are layered on top:
 *   - If `expectedElevenLabsConversationId` is provided AND the row already
 *     has `elevenlabs_conversation_id` set, the two must match.
 *   - If the row's `last_turn_at` is older than IDLE_EXPIRY_MS, the
 *     session is rejected as `idle_expired` — abandoned nonces don't get
 *     to wake up later.
 *
 * Returns:
 *   { ok: true, ... }    — valid session, use the resolved context
 *   { ok: false, reason } — reject the webhook turn with 401
 */
export async function resolveVoiceSession(
  id: string,
  expectedElevenLabsConversationId?: string | null,
): Promise<
  | { ok: true; ctx: ResolvedVoiceSession; needsConnectionBinding: boolean }
  | { ok: false; reason: ResolveError }
> {
  // 1. Load the session row.
  const { data: session, error: sessionErr } = await supabaseAdmin
    .from('agent_voice_sessions')
    .select('id, account_id, data_user_id, property_id, conversation_id, expires_at, elevenlabs_conversation_id, last_turn_at, mode, current_room_number')
    .eq('id', id)
    .maybeSingle();
  if (sessionErr || !session) {
    return { ok: false, reason: 'not_found' };
  }

  // 2. Check expiry.
  if (new Date(session.expires_at as string).getTime() <= Date.now()) {
    return { ok: false, reason: 'expired' };
  }

  // 2a. Idle expiry — if the previous turn was longer than IDLE_EXPIRY_MS
  // ago, refuse. A captured nonce that nobody is actively using becomes
  // useless after the first idle gap, even if the outer TTL hasn't fired.
  const lastTurnAt = session.last_turn_at as string | null;
  if (lastTurnAt && Date.now() - new Date(lastTurnAt).getTime() > IDLE_EXPIRY_MS) {
    return { ok: false, reason: 'idle_expired' };
  }

  // 2b. Connection binding — if the row already carries a bound
  // conversation id, the caller's claim must match. NULL means "not yet
  // bound" — the caller will bind it after this resolve succeeds (see
  // bindVoiceSessionToConnection). NULL expected = caller didn't supply
  // one (e.g. tests / first-turn path), which we accept and signal back
  // via `needsConnectionBinding`.
  const bound = session.elevenlabs_conversation_id as string | null;
  if (bound && expectedElevenLabsConversationId && bound !== expectedElevenLabsConversationId) {
    return { ok: false, reason: 'binding_mismatch' };
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

  // 6. Normalize the persisted mode. Pre-0214 rows have no `mode` column;
  //    treat any unexpected value (NULL, legacy text) as 'general' so the
  //    caller never has to guard against typos. The CHECK constraint on the
  //    column means a fresh insert can only be one of the union members.
  const rawMode = (session.mode as string | null) ?? 'general';
  const mode: VoiceMode = rawMode === 'housekeeper_issue' ? 'housekeeper_issue' : 'general';
  const currentRoomNumber = (session.current_room_number as string | null) ?? null;

  return {
    ok: true,
    ctx: {
      voiceSessionId: session.id as string,
      accountId: session.account_id as string,
      userId: session.data_user_id as string,
      propertyId: session.property_id as string,
      role,
      staffId,
      conversationId: session.conversation_id as string,
      mode,
      currentRoomNumber,
    },
    // Caller (voice-brain) uses this to decide whether to write the
    // binding now (true → row unbound, this is the first accepted turn)
    // or skip the write (false → row already bound, we just verified the
    // match above). Either way the caller should call markVoiceSessionTurn
    // so last_turn_at advances.
    needsConnectionBinding: bound === null,
  };
}

/**
 * Compare-and-set the ElevenLabs `conversation_id` onto an unbound voice
 * session row. Called once per session, on the FIRST webhook turn after
 * resolveVoiceSession returned `needsConnectionBinding: true`.
 *
 * The `IS NULL` predicate is the safety net: if two concurrent first-turns
 * race (cosmetically unlikely — ElevenLabs sends one webhook at a time
 * for a conversation, but defensible regardless), only the first write
 * wins. The second sees zero rows updated and treats it as a binding
 * mismatch (whoever didn't win has a different conversation_id).
 *
 * Returns true when this caller successfully claimed the row; false when
 * the row was already bound to a different conversation (race lost — the
 * caller must reject the turn). Throws on infra failures.
 */
export async function bindVoiceSessionToConnection(
  sessionId: string,
  elevenlabsConversationId: string,
): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('agent_voice_sessions')
    .update({ elevenlabs_conversation_id: elevenlabsConversationId })
    .eq('id', sessionId)
    .is('elevenlabs_conversation_id', null)
    .select('id')
    .maybeSingle();
  if (error) {
    throw new Error(`[voice-session] bindToConnection failed: ${error.message}`);
  }
  // `data` is null when zero rows matched the predicate — i.e. the row
  // is already bound to a different connection. Caller must reject.
  return data !== null;
}

/**
 * Stamp `last_turn_at = now()` on a voice-session row. Called after every
 * successfully-resolved + accepted turn so the idle-expiry clock restarts.
 * Best-effort: a write failure logs and continues; the next turn would
 * still pass the idle check unless many minutes elapse.
 */
export async function markVoiceSessionTurn(sessionId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from('agent_voice_sessions')
    .update({ last_turn_at: new Date().toISOString() })
    .eq('id', sessionId);
  if (error) {
    throw new Error(`[voice-session] markVoiceSessionTurn failed: ${error.message}`);
  }
}
