/**
 * Phase M1.5 (2026-05-14) — onboarding invite email template + sender.
 *
 * Wraps sendTransactionalEmail with the specific HTML/text content for
 * "you've been invited to onboard <Hotel> on Staxis." Kept as a
 * separate file from the generic Resend helper so future transactional
 * email types (trial expiration warning, weekly digest, etc.) live
 * alongside this one as siblings rather than as branches inside a
 * megaswitch in resend.ts.
 */

import { sendTransactionalEmail, type SendEmailResult } from './resend';

interface OnboardingInviteParams {
  to: string;
  hotelName: string;
  signupUrl: string;
  inviteRole: 'owner' | 'general_manager';
  expiresAt: string;  // ISO string
  auditContext?: Parameters<typeof sendTransactionalEmail>[0]['auditContext'];
}

/**
 * Friendly label for the role shown in the email body.
 */
function roleLabel(role: 'owner' | 'general_manager'): string {
  return role === 'owner' ? 'hotel owner' : 'general manager';
}

/**
 * Format an ISO timestamp as "March 15" for the body of the email.
 * Intentionally short; uses the recipient's locale-friendly format.
 */
function formatExpiry(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
}

export async function sendOnboardingInvite(
  params: OnboardingInviteParams,
): Promise<SendEmailResult> {
  const { to, hotelName, signupUrl, inviteRole, expiresAt } = params;
  const role = roleLabel(inviteRole);
  const expiryStr = formatExpiry(expiresAt);

  const subject = `You're invited to set up ${hotelName} on Staxis`;

  // Plain-text fallback for clients that don't render HTML.
  const text = [
    `You've been added as the ${role} for ${hotelName} on Staxis.`,
    '',
    `Staxis is the AI-powered operations platform that runs your housekeeping,`,
    `inventory, and labor planning in the background.`,
    '',
    `To get started, click the link below. We'll walk you through the setup`,
    `(account, hotel info, services, PMS connection) in about 10 minutes.`,
    '',
    signupUrl,
    '',
    `This link expires on ${expiryStr}. If you didn't expect this invitation,`,
    `you can safely ignore it.`,
    '',
    '— The Staxis team',
  ].join('\n');

  // HTML version. Inline styles only (most email clients strip <style>
  // blocks). Single-column layout, max-width 560 for mobile readability.
  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1a1a1a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7f9;padding:40px 20px;">
    <tr>
      <td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;max-width:560px;width:100%;">
          <tr>
            <td style="padding:32px 32px 16px 32px;">
              <div style="font-size:13px;color:#888;letter-spacing:0.05em;text-transform:uppercase;margin-bottom:8px;">Staxis</div>
              <h1 style="font-size:22px;font-weight:700;margin:0 0 16px 0;line-height:1.3;">
                You're invited to set up <span style="color:#d49040;">${escapeHtml(hotelName)}</span>
              </h1>
              <p style="font-size:15px;line-height:1.5;color:#444;margin:0 0 16px 0;">
                You've been added as the <strong>${escapeHtml(role)}</strong> for ${escapeHtml(hotelName)} on Staxis — the AI-powered operations platform that runs housekeeping, inventory, and labor planning in the background.
              </p>
              <p style="font-size:15px;line-height:1.5;color:#444;margin:0 0 24px 0;">
                Click below to get started. We'll walk you through account setup, hotel details, services, and connecting your PMS in about 10 minutes.
              </p>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:0 32px 24px 32px;">
              <a href="${escapeHtml(signupUrl)}" style="display:inline-block;background:#1a1a1a;color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:8px;font-size:15px;font-weight:600;">
                Begin onboarding →
              </a>
            </td>
          </tr>
          <tr>
            <td style="padding:0 32px 16px 32px;">
              <p style="font-size:12px;line-height:1.5;color:#888;margin:0 0 8px 0;">
                Or copy this link into your browser:
              </p>
              <p style="font-size:12px;font-family:'SF Mono',Monaco,Consolas,monospace;color:#444;word-break:break-all;margin:0 0 16px 0;background:#f6f7f9;padding:8px 12px;border-radius:6px;">
                ${escapeHtml(signupUrl)}
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 32px 32px 32px;border-top:1px solid #eee;">
              <p style="font-size:12px;color:#888;line-height:1.5;margin:0;">
                This invitation expires on <strong>${escapeHtml(expiryStr)}</strong>. If you didn't expect this email, you can safely ignore it.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return sendTransactionalEmail({
    to,
    subject,
    html,
    text,
    tags: [
      { name: 'kind', value: 'onboarding_invite' },
      { name: 'invite_role', value: inviteRole },
    ],
    auditContext: {
      ...params.auditContext,
      metadata: {
        ...(params.auditContext?.metadata ?? {}),
        hotelName,
        inviteRole,
        kind: 'onboarding_invite',
      },
    },
  });
}

/**
 * Minimal HTML escaper for the email template. Avoids a dep just for
 * 5 entities. Replace with a proper escaper if the template grows.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
