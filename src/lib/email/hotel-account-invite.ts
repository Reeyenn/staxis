import { createHash } from 'node:crypto';

import { sendTransactionalEmail, type SendEmailParams, type SendEmailResult } from '@/lib/email/resend';
import { escapeHtml } from '@/lib/format';
import { roleLabel, type AssignableRole } from '@/lib/roles';

export interface HotelAccountInviteParams {
  to: string;
  hotelName: string;
  role: AssignableRole;
  inviteUrl: string;
  expiresAt: string;
  auditContext?: SendEmailParams['auditContext'];
}

export type HotelAccountInviteSender = (
  params: SendEmailParams,
) => Promise<SendEmailResult>;

function cleanSubjectValue(value: string): string {
  return value.replace(/[\r\n\0]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function formattedExpiry(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Deliver the email-specific hotel account invitation through the project's
 * transactional Resend path. The optional sender is dependency injection for
 * deterministic behavior tests; production always uses
 * sendTransactionalEmail.
 */
export async function sendHotelAccountInvite(
  params: HotelAccountInviteParams,
  sender: HotelAccountInviteSender = sendTransactionalEmail,
): Promise<SendEmailResult> {
  const hotelName = cleanSubjectValue(params.hotelName) || 'your hotel';
  const role = roleLabel(params.role);
  const expiry = formattedExpiry(params.expiresAt);
  const subject = `You're invited to ${hotelName} on Staxis`;
  const text = [
    `You've been invited to join ${hotelName} on Staxis.`,
    '',
    `Role: ${role}`,
    '',
    'Open this secure, single-use invitation to create your account:',
    params.inviteUrl,
    '',
    `This link expires on ${expiry}. If you did not expect it, you can ignore this email.`,
    '',
    '— The Staxis team',
  ].join('\n');
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#172033">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;background:#f4f6f8">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;background:#fff;border:1px solid #e1e6ec;border-radius:14px">
        <tr><td style="padding:32px">
          <div style="font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#b46d20;margin-bottom:10px">Staxis · Hotel team</div>
          <h1 style="font-size:23px;line-height:1.3;margin:0 0 14px">You're invited to ${escapeHtml(hotelName)}</h1>
          <p style="font-size:15px;line-height:1.6;color:#4f5c6f;margin:0 0 20px">An authorized hotel manager invited you to join as <strong>${escapeHtml(role)}</strong>.</p>
          <div style="text-align:center;margin-bottom:24px"><a href="${escapeHtml(params.inviteUrl)}" style="display:inline-block;padding:13px 24px;border-radius:8px;background:#182235;color:#fff;text-decoration:none;font-size:14px;font-weight:700">Create your account</a></div>
          <p style="font-size:12px;line-height:1.55;color:#7a8494;margin:0 0 8px">Or copy this link:</p>
          <p style="font-size:12px;line-height:1.5;word-break:break-all;background:#f8fafc;padding:10px;border-radius:7px;margin:0">${escapeHtml(params.inviteUrl)}</p>
          <p style="font-size:12px;line-height:1.55;color:#7a8494;margin:20px 0 0">This single-use invitation expires on <strong>${escapeHtml(expiry)}</strong>.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
  const idempotencyKey = `hotel-account-invite:${createHash('sha256')
    .update(`${params.to.trim().toLowerCase()}|${params.inviteUrl}`)
    .digest('hex')
    .slice(0, 20)}`;

  return sender({
    to: params.to,
    subject,
    html,
    text,
    idempotencyKey,
    tags: [
      { name: 'kind', value: 'hotel_account_invite' },
      { name: 'invite_role', value: params.role },
    ],
    auditContext: {
      ...params.auditContext,
      metadata: {
        ...(params.auditContext?.metadata ?? {}),
        hotelName,
        inviteRole: params.role,
        kind: 'hotel_account_invite',
      },
    },
  });
}
