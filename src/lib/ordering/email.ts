// ═══════════════════════════════════════════════════════════════════════════
// Inventory Ordering — vendor purchase-order email.
//
// Reuses the existing Resend wrapper (src/lib/email/resend.ts) — no new
// provider. sendTransactionalEmail already validates the recipient, enforces a
// per-recipient 5/hour cap, and writes admin_audit_log. We add a stable
// idempotency key (po:<id>) so an accidental double-send dedupes at Resend.
//
// Bilingual EN/ES (the manager's app language). All vendor/item-supplied text
// is HTML-escaped before interpolation.
// ═══════════════════════════════════════════════════════════════════════════

import { sendTransactionalEmail, type SendEmailResult } from '@/lib/email/resend';
import type { Language } from '@/lib/translations';
import type { PurchaseOrder } from './types';

function esc(s: string | null | undefined): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

const COPY = {
  en: {
    subject: (po: string, hotel: string) => `Purchase Order ${po} — ${hotel}`,
    greeting: 'Hello,',
    intro: (hotel: string) => `Please find our purchase order below from ${hotel}.`,
    poLabel: 'Purchase Order',
    item: 'Item',
    qty: 'Qty',
    unit: 'Unit price',
    lineTotal: 'Line total',
    subtotal: 'Subtotal',
    notes: 'Notes',
    closing: 'Thank you,',
    footer: 'Sent via Staxis on behalf of the property above.',
  },
  es: {
    subject: (po: string, hotel: string) => `Orden de compra ${po} — ${hotel}`,
    greeting: 'Hola,',
    intro: (hotel: string) => `A continuación encontrará nuestra orden de compra de ${hotel}.`,
    poLabel: 'Orden de compra',
    item: 'Artículo',
    qty: 'Cant.',
    unit: 'Precio unit.',
    lineTotal: 'Total línea',
    subtotal: 'Subtotal',
    notes: 'Notas',
    closing: 'Gracias,',
    footer: 'Enviado a través de Staxis en nombre de la propiedad indicada.',
  },
} as const;

export function renderPurchaseOrderEmail(args: {
  po: PurchaseOrder;
  propertyName: string;
  lang?: Language;
}): { subject: string; html: string; text: string } {
  const { po, propertyName } = args;
  const t = COPY[args.lang === 'es' ? 'es' : 'en'];
  const hotel = esc(propertyName);

  const rowsHtml = po.lines
    .map(
      (l) => `
      <tr>
        <td style="padding:8px 10px;border-bottom:1px solid #eee;">${esc(l.description)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #eee;text-align:right;">${l.qtyOrdered}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #eee;text-align:right;">${money(l.unitCostCents)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #eee;text-align:right;">${money(Math.round(l.unitCostCents) * l.qtyOrdered)}</td>
      </tr>`,
    )
    .join('');

  const html = `<!doctype html><html><body style="margin:0;background:#f6f6f4;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1c1c1c;">
  <div style="max-width:600px;margin:0 auto;padding:24px;">
    <div style="background:#fff;border:1px solid #e7e7e3;border-radius:14px;padding:24px;">
      <div style="font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:#888;">${t.poLabel}</div>
      <h1 style="font-size:24px;margin:4px 0 2px;">${esc(po.poNumber)}</h1>
      <div style="font-size:13px;color:#666;margin-bottom:18px;">${esc(hotel)}${po.vendorName ? ` &rarr; ${esc(po.vendorName)}` : ''}</div>
      <p style="font-size:14px;line-height:1.5;">${t.greeting}<br/>${t.intro(hotel)}</p>
      <table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:12px;">
        <thead>
          <tr style="text-align:left;color:#888;font-size:11px;text-transform:uppercase;letter-spacing:0.06em;">
            <th style="padding:8px 10px;">${t.item}</th>
            <th style="padding:8px 10px;text-align:right;">${t.qty}</th>
            <th style="padding:8px 10px;text-align:right;">${t.unit}</th>
            <th style="padding:8px 10px;text-align:right;">${t.lineTotal}</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
        <tfoot>
          <tr>
            <td colspan="3" style="padding:12px 10px;text-align:right;font-weight:600;">${t.subtotal}</td>
            <td style="padding:12px 10px;text-align:right;font-weight:600;">${money(po.subtotalCents)}</td>
          </tr>
        </tfoot>
      </table>
      ${po.notes ? `<p style="font-size:13px;color:#555;margin-top:14px;"><b>${t.notes}:</b> ${esc(po.notes)}</p>` : ''}
      <p style="font-size:14px;margin-top:18px;">${t.closing}<br/>${esc(hotel)}</p>
    </div>
    <div style="text-align:center;font-size:11px;color:#aaa;margin-top:14px;">${t.footer}</div>
  </div>
</body></html>`;

  const textLines = po.lines.map(
    (l) => `  ${l.qtyOrdered} x ${l.description} @ ${money(l.unitCostCents)} = ${money(Math.round(l.unitCostCents) * l.qtyOrdered)}`,
  );
  const text = [
    `${t.poLabel} ${po.poNumber} — ${propertyName}`,
    po.vendorName ? `Vendor: ${po.vendorName}` : '',
    '',
    t.intro(propertyName),
    '',
    ...textLines,
    '',
    `${t.subtotal}: ${money(po.subtotalCents)}`,
    po.notes ? `${t.notes}: ${po.notes}` : '',
    '',
    `${t.closing} ${propertyName}`,
    t.footer,
  ]
    .filter((l) => l !== '')
    .join('\n');

  return { subject: t.subject(po.poNumber, propertyName), html, text };
}

export async function sendPurchaseOrderEmail(args: {
  po: PurchaseOrder;
  toEmail: string;
  propertyName: string;
  lang?: Language;
  actorUserId?: string;
  actorEmail?: string | null;
}): Promise<SendEmailResult> {
  const { subject, html, text } = renderPurchaseOrderEmail({
    po: args.po,
    propertyName: args.propertyName,
    lang: args.lang,
  });
  return sendTransactionalEmail({
    to: args.toEmail,
    subject,
    html,
    text,
    tags: [
      { name: 'kind', value: 'purchase_order' },
      { name: 'po_number', value: args.po.poNumber },
      { name: 'property_id', value: args.po.propertyId },
    ],
    // Stable per-PO key so a double-click dedupes at Resend (24h window).
    idempotencyKey: `po:${args.po.id}`,
    auditContext: {
      actorUserId: args.actorUserId,
      actorEmail: args.actorEmail ?? undefined,
      targetType: 'purchase_order',
      targetId: args.po.id,
      hotelId: args.po.propertyId,
      metadata: { poNumber: args.po.poNumber, vendor: args.po.vendorName, subtotalCents: args.po.subtotalCents },
    },
  });
}
