import 'server-only';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { digestPhonePairingOtp, hashPhonePairingToken } from '@/lib/phone-pairing';
import { sendPhonePairingCodeEmail } from '@/lib/email/phone-pairing-code';
import { log } from '@/lib/log';

export interface PhonePairingSendReservation {
  pairingId: string;
  accountId: string;
  authUserId: string;
  challengeExpiresAt: string;
  sendCount: number;
  sendReservationId: string | null;
  newlyClaimed: boolean;
}

interface ReservationRpcRow {
  pairing_id?: unknown;
  account_id?: unknown;
  auth_user_id?: unknown;
  challenge_expires_at?: unknown;
  send_count?: unknown;
  send_reservation_id?: unknown;
  newly_claimed?: unknown;
}

export function parsePhonePairingReservation(data: unknown): PhonePairingSendReservation | null {
  const first = Array.isArray(data) ? data[0] : data;
  if (!first || typeof first !== 'object') return null;
  const row = first as ReservationRpcRow;
  if (
    typeof row.pairing_id !== 'string' ||
    typeof row.account_id !== 'string' ||
    typeof row.auth_user_id !== 'string' ||
    typeof row.challenge_expires_at !== 'string' ||
    typeof row.send_count !== 'number' ||
    (row.send_reservation_id !== null && typeof row.send_reservation_id !== 'string') ||
    (row.newly_claimed !== undefined && typeof row.newly_claimed !== 'boolean')
  ) {
    return null;
  }
  return {
    pairingId: row.pairing_id,
    accountId: row.account_id,
    authUserId: row.auth_user_id,
    challengeExpiresAt: row.challenge_expires_at,
    sendCount: row.send_count,
    sendReservationId: row.send_reservation_id ?? null,
    // Resend reservations predate this claim-only disposition field and do
    // not return it. Missing therefore means "not a newly won QR claim".
    newlyClaimed: row.newly_claimed === true,
  };
}

async function registeredEmailForAuthUser(authUserId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin.auth.admin.getUserById(authUserId);
  if (error || !data.user?.email) return null;
  const email = data.user.email.trim().toLowerCase();
  // Synthetic login addresses cannot receive the ownership proof required by
  // this flow. Keep the caller-facing failure generic.
  if (email.endsWith('@staxis.local') || email.endsWith('@staxis.invalid')) return null;
  return email;
}

export type IssuePhonePairingCodeResult =
  | { ok: true; emailSent: true; expiresAt: string }
  | { ok: false; emailSent: false };

async function cancelPhonePairingSend(
  reservation: PhonePairingSendReservation,
  rawChallengeToken: string,
): Promise<void> {
  if (!reservation.sendReservationId) return;
  try {
    const { error } = await supabaseAdmin.rpc('staxis_cancel_phone_pairing_send', {
      p_pairing_id: reservation.pairingId,
      p_challenge_token_hash: hashPhonePairingToken(rawChallengeToken),
      p_send_count: reservation.sendCount,
      p_send_reservation_id: reservation.sendReservationId,
    });
    if (error) {
      log.warn('[phone-pairing] send compensation failed', {
        pairingId: reservation.pairingId,
        generation: reservation.sendCount,
        code: error.code,
      });
    }
  } catch {
    // A crashed/stuck reservation is automatically replaceable after 30s.
    log.warn('[phone-pairing] send compensation threw', {
      pairingId: reservation.pairingId,
      generation: reservation.sendCount,
    });
  }
}

/** Generate, persist, and email the OTP reserved by claim/resend. */
async function issueReservedPhonePairingCode(
  reservation: PhonePairingSendReservation,
  rawChallengeToken: string,
): Promise<IssuePhonePairingCodeResult> {
  if (!reservation.sendReservationId) return { ok: false, emailSent: false };

  const email = await registeredEmailForAuthUser(reservation.authUserId);
  if (!email) {
    await cancelPhonePairingSend(reservation, rawChallengeToken);
    return { ok: false, emailSent: false };
  }

  const { data: linkData, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
    type: 'magiclink',
    email,
  });
  const emailOtp = linkData?.properties?.email_otp;
  const hashedToken = linkData?.properties?.hashed_token;
  if (
    linkError ||
    typeof emailOtp !== 'string' ||
    !/^\d{6}$/.test(emailOtp) ||
    typeof hashedToken !== 'string' ||
    !hashedToken
  ) {
    await cancelPhonePairingSend(reservation, rawChallengeToken);
    return { ok: false, emailSent: false };
  }

  const otpDigest = digestPhonePairingOtp(rawChallengeToken, emailOtp);
  const { data: stored, error: storeError } = await supabaseAdmin.rpc(
    'staxis_store_phone_pairing_otp',
    {
      p_pairing_id: reservation.pairingId,
      p_challenge_token_hash: hashPhonePairingToken(rawChallengeToken),
      p_send_count: reservation.sendCount,
      p_send_reservation_id: reservation.sendReservationId,
      p_otp_digest: otpDigest,
      p_supabase_hashed_token: hashedToken,
    },
  );
  if (storeError || stored !== true) {
    await cancelPhonePairingSend(reservation, rawChallengeToken);
    return { ok: false, emailSent: false };
  }

  const sent = await sendPhonePairingCodeEmail({
    to: email,
    code: emailOtp,
    pairingId: reservation.pairingId,
    generation: reservation.sendCount,
    reservationId: reservation.sendReservationId,
  });
  if (!sent.ok) {
    // No recipient, code, or provider detail: operational breadcrumb without
    // PII/auth material. Claim still returns its challenge so the phone can
    // use the explicit resend path.
    log.warn('[phone-pairing] code email was not accepted', {
      pairingId: reservation.pairingId,
      generation: reservation.sendCount,
    });
    await cancelPhonePairingSend(reservation, rawChallengeToken);
    return { ok: false, emailSent: false };
  }

  const challengeHash = hashPhonePairingToken(rawChallengeToken);
  const { data: finalizedExpiry, error: finalizeError } = await supabaseAdmin.rpc(
    'staxis_finalize_phone_pairing_send',
    {
      p_pairing_id: reservation.pairingId,
      p_challenge_token_hash: challengeHash,
      p_send_count: reservation.sendCount,
      p_send_reservation_id: reservation.sendReservationId,
    },
  );
  if (!finalizeError && typeof finalizedExpiry === 'string') {
    return { ok: true, emailSent: true, expiresAt: finalizedExpiry };
  }

  // If the finalize response was lost after Postgres committed, recover by
  // recognizing the exact pending digest now active on this pairing.
  const { data: committed } = await supabaseAdmin
    .from('phone_pairings')
    .select('send_count, otp_digest, challenge_expires_at')
    .eq('id', reservation.pairingId)
    .eq('challenge_token_hash', challengeHash)
    .maybeSingle();
  if (
    committed?.send_count === reservation.sendCount &&
    committed.otp_digest === otpDigest &&
    typeof committed.challenge_expires_at === 'string'
  ) {
    return {
      ok: true,
      emailSent: true,
      expiresAt: committed.challenge_expires_at,
    };
  }

  await cancelPhonePairingSend(reservation, rawChallengeToken);
  return { ok: false, emailSent: false };
}

export async function issuePhonePairingCode(
  reservation: PhonePairingSendReservation,
  rawChallengeToken: string,
): Promise<IssuePhonePairingCodeResult> {
  try {
    return await issueReservedPhonePairingCode(reservation, rawChallengeToken);
  } catch {
    // Supabase SDK methods normally return structured errors, but a thrown
    // transport/runtime failure must still release the reservation so the
    // previous OTP and remaining send budget survive.
    await cancelPhonePairingSend(reservation, rawChallengeToken);
    log.warn('[phone-pairing] code issue threw; reservation compensated', {
      pairingId: reservation.pairingId,
      generation: reservation.sendCount,
    });
    return { ok: false, emailSent: false };
  }
}
