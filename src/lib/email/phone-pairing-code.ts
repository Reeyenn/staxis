import { sendTransactionalEmail, type SendEmailResult } from './resend';

export interface PhonePairingCodeEmailParams {
  to: string;
  code: string;
  pairingId: string;
  generation: number;
  reservationId: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderPhonePairingCodeEmail(code: string): {
  subject: string;
  html: string;
  text: string;
} {
  const safeCode = escapeHtml(code);
  const subject = 'Your Staxis phone sign-in code';
  const text = [
    'Use this code to finish opening Staxis on your phone:',
    '',
    code,
    '',
    'This code expires in 60 seconds and can be used once.',
    'If you did not scan a Staxis QR code, ignore this email.',
  ].join('\n');
  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f5f3ee;color:#1f231c;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;background:#f5f3ee;">
      <tr><td align="center">
        <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="width:100%;max-width:520px;background:#ffffff;border-radius:16px;">
          <tr><td style="padding:32px;">
            <div style="font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#9a6a24;">Staxis</div>
            <h1 style="margin:12px 0 8px;font-size:24px;line-height:1.25;">Open Staxis on your phone</h1>
            <p style="margin:0 0 24px;color:#5c625c;font-size:15px;line-height:1.5;">Enter this one-time code on your phone:</p>
            <div style="padding:18px 12px;border-radius:12px;background:#f5f3ee;text-align:center;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:32px;font-weight:700;letter-spacing:.24em;">${safeCode}</div>
            <p style="margin:24px 0 0;color:#747a73;font-size:13px;line-height:1.5;">This code expires in 60 seconds and can be used once. If you did not scan a Staxis QR code, you can ignore this email.</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
  return { subject, html, text };
}

export function sendPhonePairingCodeEmail(
  params: PhonePairingCodeEmailParams,
): Promise<SendEmailResult> {
  const rendered = renderPhonePairingCodeEmail(params.code);
  return sendTransactionalEmail({
    to: params.to,
    ...rendered,
    // A resend creates a different Supabase OTP. Never use the wrapper's
    // default minute-bucket key here or Resend may dedupe the new code.
    idempotencyKey: `phone-pairing:${params.pairingId}:${params.generation}:${params.reservationId}`,
    redactRecipientInAudit: true,
    tags: [{ name: 'kind', value: 'phone_pairing_code' }],
    auditContext: {
      targetType: 'phone_pairing',
      targetId: params.pairingId,
      metadata: { generation: params.generation, kind: 'phone_pairing_code' },
    },
  });
}
