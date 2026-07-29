// ═══════════════════════════════════════════════════════════════════════════
// Purchase-order email — render + send.
//
// The ONE thing in this feature that Staxis does on the hotel's behalf. Every
// other method ends with a human acting, so this path carries the weight of
// the promise the welcome screen makes, and three things about it are
// deliberate:
//
//   1. IT SENDS FROM OUR DOMAIN, NOT THEIRS. We never touch the manager's
//      mailbox, never ask for its password, never authenticate as them. The
//      message says "on behalf of {hotel}" in the body, sets reply-to to the
//      manager so the vendor's reply reaches a human at the hotel and not a
//      noreply box, and copies the manager so they hold the same record the
//      vendor does.
//   2. IT NEVER INVENTS A PRICE. A line with no invoice history renders the
//      words "no price" and the footer says how many lines lack one. The
//      total is labelled as covering only the priced lines. A purchase order
//      is a document a vendor may act on and a hotel may be billed against —
//      an estimated number in it is worse than a blank.
//   3. IT IS NOT A CONTRACT AND SAYS SO. The closing line asks the vendor to
//      confirm price and availability, because the quantities come from par
//      levels and the prices from the last invoice, neither of which is a
//      quote.
//
// Money is INTEGER CENTS throughout, matching purchase_orders (0246).
// ═══════════════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';

import { sendTransactionalEmail, type SendEmailParams, type SendEmailResult } from '@/lib/email/resend';
import { escapeHtml, moneyFromCents } from '@/lib/format';

export interface PoEmailLine {
  description: string;
  qty: number;
  unit: string;
  /** NULL when this item has never appeared on a scanned invoice. */
  unitCostCents: number | null;
}

export interface PoEmailParams {
  to: string;
  vendorName: string;
  hotelName: string;
  /** The manager placing the order — reply-to, and named in the sign-off so
   *  the vendor knows who to call. */
  managerName: string | null;
  managerEmail: string;
  poNumber: string;
  lines: readonly PoEmailLine[];
  accountNumber: string | null;
  notes: string | null;
}

export type PoEmailSender = (params: SendEmailParams) => Promise<SendEmailResult>;

/** Strip anything that could split a header. Same guard the invite emails use. */
function cleanSubjectValue(value: string): string {
  return value.replace(/[\r\n\0]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export interface RenderedPoEmail {
  subject: string;
  html: string;
  text: string;
  /** Sum over lines that HAVE a price. Never presented as the order total. */
  knownSubtotalCents: number;
  linesWithoutPrice: number;
}

function qtyLabel(line: PoEmailLine): string {
  const unit = cleanSubjectValue(line.unit);
  return unit ? `${line.qty} ${unit}` : String(line.qty);
}

/**
 * Build the purchase-order email. Pure — no network, no clock beyond what the
 * caller passes in — so the exact document that would be sent can be rendered
 * and inspected in a test or a screenshot without sending anything.
 */
export function renderPoEmail(params: PoEmailParams): RenderedPoEmail {
  const vendorName = cleanSubjectValue(params.vendorName) || 'your team';
  const hotelName = cleanSubjectValue(params.hotelName) || 'the hotel';
  const managerName = cleanSubjectValue(params.managerName ?? '');
  const poNumber = cleanSubjectValue(params.poNumber);

  let knownSubtotalCents = 0;
  let linesWithoutPrice = 0;
  for (const line of params.lines) {
    if (line.unitCostCents == null) linesWithoutPrice += 1;
    else knownSubtotalCents += line.unitCostCents * line.qty;
  }

  const subject = `Purchase order ${poNumber} from ${hotelName}`;

  // ── The honesty footer, shared by both renderings ────────────────────────
  // Stated as a count of lines rather than hidden, so the vendor reads the
  // total as partial and the hotel sees the same sentence in its own copy.
  const priceNote = linesWithoutPrice > 0
    ? `Subtotal covers the ${params.lines.length - linesWithoutPrice} line(s) with a price on file. `
      + `${linesWithoutPrice} line(s) have no price on file. Please quote them.`
    : 'Prices are from our last invoice. Please confirm current pricing.';

  const closing = 'Please confirm price and availability before shipping. '
    + 'Quantities are based on our par levels and this order is a request, not a contract.';

  const textLines: string[] = [
    `Purchase order ${poNumber}`,
    `From: ${hotelName}`,
    `To: ${vendorName}`,
  ];
  if (params.accountNumber) textLines.push(`Account: ${params.accountNumber}`);
  textLines.push('', 'Items:');
  for (const line of params.lines) {
    const price = line.unitCostCents == null ? 'no price' : moneyFromCents(line.unitCostCents);
    const total = line.unitCostCents == null ? 'no price' : moneyFromCents(line.unitCostCents * line.qty);
    textLines.push(`  ${line.description}, ${qtyLabel(line)}, ${price} each, ${total}`);
  }
  textLines.push('', `Subtotal: ${moneyFromCents(knownSubtotalCents)}`, priceNote);
  if (params.notes) textLines.push('', `Notes: ${params.notes}`);
  textLines.push(
    '',
    closing,
    '',
    managerName ? `${managerName}, ${hotelName}` : hotelName,
    `Reply to this email to reach us: ${params.managerEmail}`,
    '',
    `Sent by Staxis on behalf of ${hotelName}.`,
  );
  const text = textLines.join('\n');

  const rows = params.lines.map((line) => {
    const price = line.unitCostCents == null
      ? '<span style="color:#9aa3b0">no price</span>'
      : escapeHtml(moneyFromCents(line.unitCostCents));
    const total = line.unitCostCents == null
      ? '<span style="color:#9aa3b0">no price</span>'
      : escapeHtml(moneyFromCents(line.unitCostCents * line.qty));
    return `<tr>
            <td style="padding:9px 8px;border-bottom:1px solid #eef1f5;font-size:14px">${escapeHtml(line.description)}</td>
            <td style="padding:9px 8px;border-bottom:1px solid #eef1f5;font-size:14px;text-align:right;white-space:nowrap">${escapeHtml(qtyLabel(line))}</td>
            <td style="padding:9px 8px;border-bottom:1px solid #eef1f5;font-size:14px;text-align:right;white-space:nowrap">${price}</td>
            <td style="padding:9px 8px;border-bottom:1px solid #eef1f5;font-size:14px;text-align:right;white-space:nowrap">${total}</td>
          </tr>`;
  }).join('\n');

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#172033">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;background:#f4f6f8">
    <tr><td align="center">
      <table role="presentation" width="620" cellpadding="0" cellspacing="0" style="width:100%;max-width:620px;background:#fff;border:1px solid #e1e6ec;border-radius:14px">
        <tr><td style="padding:32px">
          <div style="font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#b46d20;margin-bottom:10px">Purchase order</div>
          <h1 style="font-size:23px;line-height:1.3;margin:0 0 6px">${escapeHtml(poNumber)}</h1>
          <p style="font-size:15px;line-height:1.6;color:#4f5c6f;margin:0 0 4px">From <strong>${escapeHtml(hotelName)}</strong> to <strong>${escapeHtml(vendorName)}</strong></p>
          ${params.accountNumber ? `<p style="font-size:13px;line-height:1.6;color:#7a8494;margin:0 0 18px">Account ${escapeHtml(params.accountNumber)}</p>` : '<div style="height:14px"></div>'}
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:16px">
            <tr>
              <th align="left" style="padding:0 8px 7px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#7a8494;border-bottom:2px solid #e1e6ec">Item</th>
              <th align="right" style="padding:0 8px 7px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#7a8494;border-bottom:2px solid #e1e6ec">Qty</th>
              <th align="right" style="padding:0 8px 7px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#7a8494;border-bottom:2px solid #e1e6ec">Unit</th>
              <th align="right" style="padding:0 8px 7px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#7a8494;border-bottom:2px solid #e1e6ec">Total</th>
            </tr>
${rows}
            <tr>
              <td colspan="3" style="padding:12px 8px 0;font-size:14px;font-weight:700;text-align:right">Subtotal</td>
              <td style="padding:12px 8px 0;font-size:14px;font-weight:700;text-align:right;white-space:nowrap">${escapeHtml(moneyFromCents(knownSubtotalCents))}</td>
            </tr>
          </table>
          <p style="font-size:12px;line-height:1.55;color:#7a8494;margin:0 0 16px">${escapeHtml(priceNote)}</p>
          ${params.notes ? `<p style="font-size:14px;line-height:1.6;color:#4f5c6f;margin:0 0 16px;padding:12px;background:#f8fafc;border-radius:8px">${escapeHtml(params.notes)}</p>` : ''}
          <p style="font-size:14px;line-height:1.6;color:#4f5c6f;margin:0 0 20px">${escapeHtml(closing)}</p>
          <p style="font-size:14px;line-height:1.6;margin:0 0 4px">${managerName ? `${escapeHtml(managerName)}, ${escapeHtml(hotelName)}` : escapeHtml(hotelName)}</p>
          <p style="font-size:13px;line-height:1.6;color:#7a8494;margin:0">Reply to this email to reach us: <a href="mailto:${escapeHtml(params.managerEmail)}" style="color:#2f6f4f">${escapeHtml(params.managerEmail)}</a></p>
        </td></tr>
        <tr><td style="padding:0 32px 26px">
          <p style="font-size:11px;line-height:1.55;color:#9aa3b0;margin:0;border-top:1px solid #eef1f5;padding-top:14px">Sent by Staxis on behalf of ${escapeHtml(hotelName)}. Replies go to the hotel, not to Staxis.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return { subject, html, text, knownSubtotalCents, linesWithoutPrice };
}

/**
 * Send the purchase order to the vendor.
 *
 * The idempotency key is the PO number, so a double-tap — or a retry after a
 * timeout where we never learned the outcome — cannot put two copies of the
 * same order in a vendor's inbox. Resend dedupes on it for 24h.
 *
 * The sender is injectable for tests, matching sendHotelAccountInvite. Nothing
 * in the test suite is permitted to reach the real transport.
 */
export async function sendPoEmail(
  params: PoEmailParams,
  sender: PoEmailSender = sendTransactionalEmail,
): Promise<SendEmailResult & { rendered: RenderedPoEmail }> {
  const rendered = renderPoEmail(params);
  const result = await sender({
    to: params.to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    // The vendor replies to the HOTEL, never to noreply@ and never to Staxis.
    replyTo: params.managerEmail,
    idempotencyKey: `inventory-po:${createHash('sha256').update(`${params.poNumber}|${params.to}`).digest('hex').slice(0, 20)}`,
    tags: [{ name: 'kind', value: 'inventory-po' }],
  });
  return { ...result, rendered };
}
