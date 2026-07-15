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
