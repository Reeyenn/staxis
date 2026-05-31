/**
 * Render a catalog report to an HTML + text email for the scheduled-report
 * cron, then send it via the existing Resend infra (sendTransactionalEmail).
 *
 * Pure rendering + a thin send wrapper — reuses src/lib/email/resend.ts so we
 * inherit its rate-limit, idempotency, header-injection guards, and audit log.
 */

import { sendTransactionalEmail, type SendEmailResult } from '@/lib/email/resend';
import { xmlEscape } from '@/lib/activity-log/export';
import { formatCell } from './format';
import type { ReportColumn, ReportDefinition, ReportRunResult } from './types';

const MAX_EMAIL_ROWS = 100;

function htmlEscape(s: string): string {
  // xmlEscape covers & < > " ' — same set we need for HTML text nodes.
  return xmlEscape(s);
}

export interface RenderedReportEmail {
  subject: string;
  html: string;
  text: string;
}

export function renderReportEmail(args: {
  def: ReportDefinition;
  result: ReportRunResult;
  propertyName: string;
  from: string;
  to: string;
  aiSummary?: string | null;
  lang?: 'en' | 'es';
}): RenderedReportEmail {
  const { def, result, propertyName, from, to, aiSummary } = args;
  const lang = args.lang ?? 'en';
  const title = def.title[lang];
  const subject = `${propertyName} — ${title} — ${from} → ${to}`;

  const rows = result.rows.slice(0, MAX_EMAIL_ROWS);
  const truncated = result.rows.length > MAX_EMAIL_ROWS;

  const statHtml = (result.stats ?? [])
    .map(
      (s) =>
        `<td style="padding:8px 14px;border:1px solid #E7E7E2;background:#FAFAF8;">` +
        `<div style="font:11px monospace;color:#8A8A82;text-transform:uppercase;letter-spacing:.04em;">${htmlEscape(s.label[lang])}</div>` +
        `<div style="font:18px Georgia,serif;color:#1F231C;">${htmlEscape(s.value)}</div></td>`,
    )
    .join('');

  const headHtml = result.columns
    .map(
      (c: ReportColumn) =>
        `<th style="text-align:${c.align ?? 'left'};padding:8px 10px;border-bottom:2px solid #E7E7E2;font:11px monospace;color:#8A8A82;text-transform:uppercase;letter-spacing:.04em;">${htmlEscape(c.label[lang])}</th>`,
    )
    .join('');

  const bodyHtml = rows
    .map((r) => {
      const cells = result.columns
        .map(
          (c) =>
            `<td style="text-align:${c.align ?? 'left'};padding:7px 10px;border-bottom:1px solid #F0F0EC;font:13px -apple-system,Arial,sans-serif;color:#1F231C;">${htmlEscape(formatCell(r[c.key], c.kind, lang))}</td>`,
        )
        .join('');
      return `<tr>${cells}</tr>`;
    })
    .join('');

  const summaryBlock = aiSummary
    ? `<div style="margin:0 0 16px;padding:12px 16px;background:#EEF1EA;border-left:3px solid #7C8A6B;font:14px Georgia,serif;color:#3A3F33;">${htmlEscape(aiSummary)}</div>`
    : '';

  const notesBlock = result.notes
    ? `<div style="margin:14px 0 0;font:12px -apple-system,Arial,sans-serif;color:#8A8A82;">${htmlEscape(result.notes[lang])}</div>`
    : '';

  const truncNote = truncated
    ? `<div style="margin:10px 0 0;font:12px -apple-system,Arial,sans-serif;color:#8A8A82;">${lang === 'es' ? `Mostrando las primeras ${MAX_EMAIL_ROWS} filas. Exporta el reporte completo desde Staxis.` : `Showing the first ${MAX_EMAIL_ROWS} rows. Export the full report from Staxis.`}</div>`
    : '';

  const html = `<!doctype html><html><body style="margin:0;background:#FFFFFF;padding:24px;">
<div style="max-width:640px;margin:0 auto;">
  <div style="font:11px monospace;color:#8A8A82;text-transform:uppercase;letter-spacing:.08em;">${htmlEscape(propertyName)}</div>
  <h1 style="margin:4px 0 2px;font:26px Georgia,serif;color:#1F231C;font-weight:400;">${htmlEscape(title)}</h1>
  <div style="font:12px -apple-system,Arial,sans-serif;color:#8A8A82;margin-bottom:18px;">${htmlEscape(from)} → ${htmlEscape(to)}</div>
  ${summaryBlock}
  ${statHtml ? `<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin:0 0 18px;"><tr>${statHtml}</tr></table>` : ''}
  <table cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%;"><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml || `<tr><td style="padding:14px;color:#8A8A82;font:13px Arial,sans-serif;">${lang === 'es' ? 'Sin datos en este rango.' : 'No data in this range.'}</td></tr>`}</tbody></table>
  ${truncNote}
  ${notesBlock}
  <div style="margin:22px 0 0;font:11px -apple-system,Arial,sans-serif;color:#B0B0A8;">Staxis · ${lang === 'es' ? 'Reporte automático' : 'Automated report'}</div>
</div></body></html>`;

  // Plain-text fallback.
  const textLines: string[] = [
    `${propertyName} — ${title}`,
    `${from} -> ${to}`,
    '',
  ];
  if (aiSummary) textLines.push(aiSummary, '');
  for (const s of result.stats ?? []) textLines.push(`${s.label[lang]}: ${s.value}`);
  if ((result.stats ?? []).length) textLines.push('');
  textLines.push(result.columns.map((c) => c.label[lang]).join(' | '));
  for (const r of rows) textLines.push(result.columns.map((c) => formatCell(r[c.key], c.kind, lang)).join(' | '));
  if (truncated) textLines.push(`(${result.rows.length - MAX_EMAIL_ROWS} more rows — export from Staxis)`);
  if (result.notes) textLines.push('', result.notes[lang]);

  return { subject, html, text: textLines.join('\n') };
}

export async function sendReportEmail(args: {
  to: string;
  def: ReportDefinition;
  result: ReportRunResult;
  propertyName: string;
  propertyId: string;
  from: string;
  to_date: string;
  aiSummary?: string | null;
  lang?: 'en' | 'es';
  idempotencyKey?: string;
  scheduleId?: string;
}): Promise<SendEmailResult> {
  const rendered = renderReportEmail({
    def: args.def,
    result: args.result,
    propertyName: args.propertyName,
    from: args.from,
    to: args.to_date,
    aiSummary: args.aiSummary,
    lang: args.lang,
  });
  return sendTransactionalEmail({
    to: args.to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    idempotencyKey: args.idempotencyKey,
    tags: [
      { name: 'kind', value: 'scheduled_report' },
      { name: 'report_key', value: args.def.key },
      { name: 'property_id', value: args.propertyId },
    ],
    // Attribute the outbound data send to the property + schedule so the
    // admin_audit_log carries a trail of who/what emailed this report.
    auditContext: {
      targetType: 'scheduled_report',
      targetId: args.scheduleId ?? args.def.key,
      hotelId: args.propertyId,
      metadata: { scheduleId: args.scheduleId ?? null, reportKey: args.def.key },
    },
  });
}
