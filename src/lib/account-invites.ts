import type { SendEmailResult } from '@/lib/email/resend';

export type AccountInviteStatus = 'pending' | 'expired';

/**
 * Unaccepted invitations remain visible after expiry so a manager can tell
 * why the recipient can no longer use the link instead of seeing the row
 * silently disappear.
 */
export function accountInviteStatus(
  expiresAt: string,
  nowMs = Date.now(),
): AccountInviteStatus {
  const expiryMs = new Date(expiresAt).getTime();
  return Number.isFinite(expiryMs) && expiryMs > nowMs ? 'pending' : 'expired';
}

export type AccountInviteDelivery = {
  inviteLink: string;
  emailSent: boolean;
  deliveryStatus: 'sent' | 'link_only';
  emailError: string | null;
};

/**
 * Keep the response honest: a successfully-created invitation is still useful
 * when email is unavailable, but it must be described as a copyable-link
 * fallback rather than as a sent email.
 */
export function accountInviteDelivery(
  inviteLink: string,
  emailResult: SendEmailResult,
): AccountInviteDelivery {
  if (emailResult.ok) {
    return {
      inviteLink,
      emailSent: true,
      deliveryStatus: 'sent',
      emailError: null,
    };
  }

  return {
    inviteLink,
    emailSent: false,
    deliveryStatus: 'link_only',
    emailError: 'Email delivery failed; copy the invitation link instead.',
  };
}
