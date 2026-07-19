import { createHash } from 'node:crypto';

import { escapeHtml } from '@/lib/format';
import { sendTransactionalEmail, type SendEmailResult } from '@/lib/email/resend';

export interface OrganizationAccessInviteParams {
  to: string;
  organizationName: string;
  accessProfile: string;
  scopeLabel: string;
  inviteUrl: string;
  expiresAt: string;
  auditContext?: Parameters<typeof sendTransactionalEmail>[0]['auditContext'];
}

function humanize(value: string): string {
  return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formattedExpiry(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
  });
}

export async function sendOrganizationAccessInvite(
  params: OrganizationAccessInviteParams,
): Promise<SendEmailResult> {
  const profile = humanize(params.accessProfile);
  const expiry = formattedExpiry(params.expiresAt);
  const subject = `You're invited to ${params.organizationName} on Staxis`;
  const text = [
    `You've been invited to ${params.organizationName} on Staxis.`,
    '',
    `Access profile: ${profile}`,
    `Scope: ${params.scopeLabel}`,
    '',
    'Open this secure, email-specific invitation:',
    params.inviteUrl,
    '',
    `This single-use link expires on ${expiry}. If you did not expect it, you can ignore this email.`,
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
          <div style="font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#b46d20;margin-bottom:10px">Staxis · Company access</div>
          <h1 style="font-size:23px;line-height:1.3;margin:0 0 14px">You're invited to ${escapeHtml(params.organizationName)}</h1>
          <p style="font-size:15px;line-height:1.6;color:#4f5c6f;margin:0 0 20px">An authorized manager invited you with the following access:</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border-radius:10px;margin-bottom:24px">
            <tr><td style="padding:14px 16px;font-size:13px;color:#667085">Profile</td><td align="right" style="padding:14px 16px;font-size:13px;font-weight:700">${escapeHtml(profile)}</td></tr>
            <tr><td style="padding:0 16px 14px;font-size:13px;color:#667085">Scope</td><td align="right" style="padding:0 16px 14px;font-size:13px;font-weight:700">${escapeHtml(params.scopeLabel)}</td></tr>
          </table>
          <div style="text-align:center;margin-bottom:24px"><a href="${escapeHtml(params.inviteUrl)}" style="display:inline-block;padding:13px 24px;border-radius:8px;background:#182235;color:#fff;text-decoration:none;font-size:14px;font-weight:700">Review invitation</a></div>
          <p style="font-size:12px;line-height:1.55;color:#7a8494;margin:0 0 8px">Or copy this link:</p>
          <p style="font-size:12px;line-height:1.5;word-break:break-all;background:#f8fafc;padding:10px;border-radius:7px;margin:0">${escapeHtml(params.inviteUrl)}</p>
          <p style="font-size:12px;line-height:1.55;color:#7a8494;margin:20px 0 0">This email-specific, single-use invitation expires on <strong>${escapeHtml(expiry)}</strong>.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
  const idempotencyKey = `org-invite:${createHash('sha256')
    .update(`${params.to.trim().toLowerCase()}|${params.inviteUrl}`)
    .digest('hex').slice(0, 20)}`;

  return sendTransactionalEmail({
    to: params.to,
    subject,
    html,
    text,
    idempotencyKey,
    tags: [
      { name: 'kind', value: 'organization_access_invite' },
      { name: 'access_profile', value: params.accessProfile },
    ],
    auditContext: {
      ...params.auditContext,
      metadata: {
        ...(params.auditContext?.metadata ?? {}),
        organizationName: params.organizationName,
        accessProfile: params.accessProfile,
        scopeLabel: params.scopeLabel,
        kind: 'organization_access_invite',
      },
    },
  });
}
