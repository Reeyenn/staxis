/**
 * Shared request/response shapes for the QR phone handoff.
 *
 * Keep this module runtime-free: it is imported by both client components and
 * server route handlers. Secrets (raw pairing/challenge/completion tokens and
 * Supabase hashed tokens) are deliberately represented only in the response
 * that needs them; they must never be logged or persisted in browser storage.
 */

export type PhonePairingStatus =
  | 'pending'
  | 'code_sent'
  | 'verified'
  | 'completed'
  | 'expired';

export interface CreatePhonePairingResponse {
  pairingId: string;
  pairUrl: string;
  expiresAt: string;
}

export interface ClaimPhonePairingResponse {
  challengeToken: string;
  expiresAt: string;
  /**
   * Present ONLY while the global human-2FA switch (migration 0310) is off:
   * the server-issued six-digit code that stands in for the emailed one, so
   * the phone can run the verify → complete sequence without human input.
   * Never present when 2FA is on. Treat like the other tokens here — never
   * log or persist in browser storage.
   */
  bypassCode?: string;
}

export interface ResendPhonePairingResponse {
  expiresAt: string;
}

export interface VerifyPhonePairingResponse {
  hashedToken: string;
  completionToken: string;
}

export interface CompletePhonePairingResponse {
  success: true;
}

export interface PhonePairingStatusResponse {
  status: PhonePairingStatus;
  expiresAt: string;
}
