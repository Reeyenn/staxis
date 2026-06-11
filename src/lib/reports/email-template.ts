/**
 * Render the daily + weekly housekeeping report payloads as HTML email
 * + plain-text fallback. Same conventions as the onboarding-invite
 * template:
 *   - Inline styles only (most email clients strip <style> blocks).
 *   - Single-column table layout, max-width 600 for mobile readability.
 *   - All content goes through `escapeHtml` before interpolation.
 *
 * Subjects:
 *   - Daily:  "[Property] — Daily Housekeeping — Tue Oct 22"
 *   - Weekly: "[Property] — Weekly Housekeeping — Week of Oct 16"
 *
 * Localization: bilingual via the optional `lang` arg ('en' | 'es').
 * Defaults to English. Each recipient's preferred lang lives on
 * accounts; the cron resolves it before calling render*.
 */

import type {
  DailyReportPayload,
  WeeklyReportPayload,
  Anomaly,
} from './types';

export type Lang = 'en' | 'es';

interface RenderResult {
  subject: string;
  html: string;
  text: string;
}

// ── Shared helpers ────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtMoney(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function fmtMaybe<T>(value: T | null | undefined, fmt: (v: T) => string): string {
  if (value === null || value === undefined) return '—';
  return fmt(value);
}

function fmtMinutes(mins: number | null): string {
  if (mins === null) return '—';
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = Math.round(mins - h * 60);
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function fmtPct(n: number): string {
  return `${n}%`;
}

function fmtDateLong(dateIso: string, lang: Lang): string {
  // 'Tue, Oct 22' style. en-US for English, es-ES for Spanish.
  const dt = new Date(`${dateIso}T12:00:00Z`);
  const locale = lang === 'es' ? 'es-ES' : 'en-US';
  return dt.toLocaleDateString(locale, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

// Email-safe palette — matches the existing onboarding-invite styling.
const COLORS = {
  bgPage: '#f6f7f9',
  bgCard: '#ffffff',
  bgRow: '#fafbfc',
  text: '#1a1a1a',
  textMuted: '#666',
  textSubtle: '#888',
  accent: '#d49040',
  accentInk: '#5a3a14',
  navy: '#1a1a1a',
  green: '#16a34a',
  red: '#dc2626',
  amber: '#d49040',
  border: '#eee',
};

function metricRow(label: string, value: string, opts: { tone?: 'good' | 'warn' | 'bad' } = {}): string {
  const valueColor = opts.tone === 'good'
    ? COLORS.green
    : opts.tone === 'bad'
      ? COLORS.red
      : opts.tone === 'warn'
        ? COLORS.amber
        : COLORS.text;
  return `<tr>
  <td style="padding:8px 16px;border-bottom:1px solid ${COLORS.border};font-size:14px;color:${COLORS.textMuted};">${escapeHtml(label)}</td>
  <td style="padding:8px 16px;border-bottom:1px solid ${COLORS.border};font-size:14px;color:${valueColor};text-align:right;font-weight:600;">${escapeHtml(value)}</td>
</tr>`;
}

function sectionHeader(title: string): string {
  return `<tr>
  <td colspan="2" style="padding:18px 16px 8px 16px;font-size:12px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${COLORS.textSubtle};">${escapeHtml(title)}</td>
</tr>`;
}

function anomaliesBlock(anomalies: Anomaly[], lang: Lang): string {
  if (anomalies.length === 0) return '';
  const title = lang === 'es' ? 'Anomalías' : 'Anomalies';
  const items = anomalies.map(a => `
    <tr>
      <td style="padding:6px 16px;font-size:14px;color:${COLORS.text};border-left:3px solid ${COLORS.amber};background:${COLORS.bgRow};">
        ${escapeHtml(a.message)}
      </td>
    </tr>
  `).join('');
  return `
    ${sectionHeader(title)}
    <tr><td colspan="2" style="padding:0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${items}</table>
    </td></tr>
  `;
}

function ctaButton(url: string, label: string): string {
  return `<tr>
    <td colspan="2" align="center" style="padding:24px 16px;">
      <a href="${escapeHtml(url)}" style="display:inline-block;background:${COLORS.navy};color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:8px;font-size:15px;font-weight:600;">${escapeHtml(label)} →</a>
    </td>
  </tr>`;
}

function shellHtml(args: {
  subject: string;
  propertyName: string;
  dateLine: string;
  body: string;
  footerLine: string;
  lang: Lang;
}): string {
  const { subject, propertyName, dateLine, body, footerLine } = args;
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:${COLORS.bgPage};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:${COLORS.text};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.bgPage};padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:${COLORS.bgCard};border-radius:12px;overflow:hidden;max-width:600px;width:100%;">
        <tr>
          <td style="padding:24px 16px 6px 16px;">
            <div style="font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:${COLORS.textSubtle};margin-bottom:4px;">Staxis</div>
            <h1 style="font-size:20px;font-weight:700;margin:0;line-height:1.3;color:${COLORS.text};">${escapeHtml(propertyName)}</h1>
            <p style="font-size:14px;color:${COLORS.textMuted};margin:4px 0 0;">${escapeHtml(dateLine)}</p>
          </td>
        </tr>
        ${body}
        <tr>
          <td colspan="2" style="padding:18px 16px 24px;border-top:1px solid ${COLORS.border};font-size:12px;color:${COLORS.textSubtle};line-height:1.5;">
            ${escapeHtml(footerLine)}
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ── Daily renderer ────────────────────────────────────────────────────────

export function renderDailyReport(args: {
  payload: DailyReportPayload;
  lang?: Lang;
}): RenderResult {
  const { payload } = args;
  const lang: Lang = args.lang ?? 'en';
  const dateLong = fmtDateLong(payload.reportDate, lang);

  const subject = lang === 'es'
    ? `[${payload.propertyName}] — Reporte diario de limpieza — ${dateLong}`
    : `[${payload.propertyName}] — Daily Housekeeping — ${dateLong}`;

  const dictionary = lang === 'es' ? esDict : enDict;
  const op = payload.operations;
  const ql = payload.quality;
  const lb = payload.labor;
  const is = payload.issues;
  const tm = payload.tomorrow;

  const body = `
    <tr><td colspan="2" style="padding:0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      ${sectionHeader(dictionary.operations)}
      ${metricRow(dictionary.roomsCleanedToday, `${op.roomsCleanedToday} / ${op.totalRoomsOnBoard}`)}
      ${metricRow(dictionary.outOfOrderOOS, `${op.roomsOOO} OOO · ${op.roomsOOS} OOS`)}
      ${metricRow(dictionary.occupancy, fmtPct(op.occupancyPct))}
      ${metricRow(dictionary.avgPerDeparture, fmtMinutes(op.avgMinutesPerDeparture))}
      ${metricRow(dictionary.avgPerStayover, fmtMinutes(op.avgMinutesPerStayover))}
      ${metricRow(dictionary.avgPerDeep, fmtMinutes(op.avgMinutesPerDeepClean))}
      ${metricRow(dictionary.roomsPerHk, String(op.roomsPerHousekeeper))}

      ${sectionHeader(dictionary.quality)}
      ${metricRow(dictionary.passRate, fmtPct(ql.passRatePct), { tone: ql.passRatePct >= 90 ? 'good' : ql.passRatePct >= 75 ? 'warn' : 'bad' })}
      ${metricRow(dictionary.reclearRate, fmtPct(ql.reclearRatePct), { tone: ql.reclearRatePct < 5 ? 'good' : ql.reclearRatePct < 15 ? 'warn' : 'bad' })}
      ${ql.topFailureReasons.length > 0
        ? metricRow(dictionary.topFailures, ql.topFailureReasons.map(r => `${r.reason} (${r.count})`).join(' · '))
        : metricRow(dictionary.topFailures, '—')}

      ${sectionHeader(dictionary.labor)}
      ${metricRow(dictionary.hoursWorked, `${lb.totalHoursWorked} h${lb.totalOvertimeHours > 0 ? ` (${lb.totalOvertimeHours} OT)` : ''}`)}
      ${metricRow(dictionary.laborCost, fmtMoney(lb.laborCostCents))}
      ${metricRow(dictionary.costPerOccupiedRoom, fmtMoney(lb.costPerOccupiedRoomCents))}
      ${metricRow(dictionary.budgetVsActual,
        lb.laborBudgetCents !== null
          ? `${fmtMoney(lb.laborCostCents)} of ${fmtMoney(lb.laborBudgetCents)}`
          : '—',
        lb.laborBudgetCents !== null && lb.laborCostCents > lb.laborBudgetCents ? { tone: 'bad' } : { tone: 'good' })}
      ${metricRow(dictionary.sickCallouts, String(lb.sickCalloutsToday), { tone: lb.sickCalloutsToday >= 3 ? 'bad' : lb.sickCalloutsToday > 0 ? 'warn' : 'good' })}

      ${sectionHeader(dictionary.issues)}
      ${metricRow(dictionary.maintenanceCreated, String(is.workOrdersCreatedToday))}
      ${metricRow(dictionary.urgentPending, String(is.urgentItemsStillPending), { tone: is.urgentItemsStillPending > 0 ? 'warn' : 'good' })}

      ${sectionHeader(dictionary.tomorrow)}
      ${tm.reservationFeedsLearning
        // feat/cua-partial-promotion — never mail a confident "0 arrivals"
        // while the reservation feeds are still being learned.
        ? metricRow(dictionary.arrivals, lang === 'es' ? 'sincronizando desde el PMS…' : 'still syncing from your PMS…') + '\n' +
          metricRow(dictionary.departures, lang === 'es' ? 'sincronizando desde el PMS…' : 'still syncing from your PMS…')
        : metricRow(dictionary.arrivals, String(tm.arrivals)) + '\n' +
          metricRow(dictionary.departures, String(tm.departures)) + '\n' +
          metricRow(dictionary.projectedToClean, String(tm.projectedRoomsToClean))}
      ${metricRow(dictionary.recommendedHeadcount, fmtMaybe(tm.recommendedHeadcount, (n) => String(n)))}
      ${metricRow(dictionary.recommendedCost, fmtMaybe(tm.recommendedLaborCostCents, fmtMoney))}
      ${metricRow(dictionary.roomsPendingOoo, String(tm.roomsPendingOOO))}
      ${metricRow(dictionary.roomsPendingInspection, String(tm.roomsPendingInspection))}

      ${anomaliesBlock(payload.anomalies, lang)}

      ${ctaButton(payload.dashboardUrl, dictionary.viewFullDashboard)}
    </table></td></tr>`;

  const html = shellHtml({
    subject,
    propertyName: payload.propertyName,
    dateLine: `${dictionary.dailyHeader} — ${dateLong}`,
    body,
    footerLine: dictionary.footer,
    lang,
  });

  const text = renderDailyText(payload, lang);

  return { subject, html, text };
}

// ── Weekly renderer ───────────────────────────────────────────────────────

export function renderWeeklyReport(args: {
  payload: WeeklyReportPayload;
  lang?: Lang;
}): RenderResult {
  const { payload } = args;
  const lang: Lang = args.lang ?? 'en';
  const startStr = fmtDateLong(payload.weekStartDate, lang);
  const endStr = fmtDateLong(payload.reportDate, lang);

  const dictionary = lang === 'es' ? esDict : enDict;
  const subject = lang === 'es'
    ? `[${payload.propertyName}] — Reporte semanal — Semana del ${startStr}`
    : `[${payload.propertyName}] — Weekly Housekeeping — Week of ${startStr}`;

  const op = payload.operations;
  const ql = payload.quality;
  const lb = payload.labor;
  const is = payload.issues;
  const nw = payload.nextWeek;

  const insightHtml = payload.insightText
    ? `<tr><td colspan="2" style="padding:16px;border-bottom:1px solid ${COLORS.border};background:${COLORS.bgRow};">
         <div style="font-size:12px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${COLORS.textSubtle};margin-bottom:6px;">${escapeHtml(dictionary.weekAtAGlance)}</div>
         <p style="margin:0;font-size:15px;line-height:1.5;color:${COLORS.text};">${escapeHtml(payload.insightText)}</p>
       </td></tr>`
    : '';

  const trendsHtml = payload.trends.map(t => {
    const sign = t.deltaPct > 0 ? '+' : '';
    const label = t.metric === 'rooms_cleaned' ? dictionary.roomsCleanedThisWeek
      : t.metric === 'labor_cost_cents' ? dictionary.laborCostThisWeek
      : t.metric === 'inspection_pass_rate_pct' ? dictionary.passRateThisWeek
      : dictionary.calloutsThisWeek;
    const value = t.metric === 'labor_cost_cents'
      ? fmtMoney(t.thisWeek)
      : t.metric === 'inspection_pass_rate_pct'
        ? fmtPct(t.thisWeek)
        : String(t.thisWeek);
    const tone = t.deltaPct >= 0 && (t.metric === 'rooms_cleaned' || t.metric === 'inspection_pass_rate_pct')
      ? 'good'
      : t.deltaPct >= 0 && (t.metric === 'labor_cost_cents' || t.metric === 'callouts')
        ? 'bad'
        : 'good';
    return metricRow(label, `${value}  (${sign}${t.deltaPct}%)`, { tone });
  }).join('');

  const performerRows = [
    payload.topPerformer
      ? metricRow(dictionary.topPerformer, `${payload.topPerformer.name} — ${payload.topPerformer.roomsCleaned} ${dictionary.rooms}`, { tone: 'good' })
      : '',
    payload.improvementOpportunity
      ? metricRow(dictionary.improvementOpportunity, `${payload.improvementOpportunity.name} — ${fmtPct(payload.improvementOpportunity.inspectionPassRatePct ?? 0)} ${dictionary.passRateLower}`, { tone: 'warn' })
      : '',
  ].join('');

  const body = `
    ${insightHtml}
    <tr><td colspan="2" style="padding:0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      ${sectionHeader(dictionary.weeklyTotals)}
      ${metricRow(dictionary.roomsCleanedThisWeek, String(op.roomsCleanedToday))}
      ${metricRow(dictionary.avgOccupancy, fmtPct(op.occupancyPct))}
      ${metricRow(dictionary.avgPerDeparture, fmtMinutes(op.avgMinutesPerDeparture))}
      ${metricRow(dictionary.avgPerStayover, fmtMinutes(op.avgMinutesPerStayover))}
      ${metricRow(dictionary.avgPerDeep, fmtMinutes(op.avgMinutesPerDeepClean))}

      ${sectionHeader(dictionary.qualityWeek)}
      ${metricRow(dictionary.passRate, fmtPct(ql.passRatePct), { tone: ql.passRatePct >= 90 ? 'good' : ql.passRatePct >= 75 ? 'warn' : 'bad' })}
      ${metricRow(dictionary.reclearRate, fmtPct(ql.reclearRatePct))}
      ${ql.topFailureReasons.length > 0
        ? metricRow(dictionary.topFailures, ql.topFailureReasons.map(r => `${r.reason} (${r.count})`).join(' · '))
        : metricRow(dictionary.topFailures, '—')}

      ${sectionHeader(dictionary.laborWeek)}
      ${metricRow(dictionary.hoursWorked, `${lb.totalHoursWorked} h${lb.totalOvertimeHours > 0 ? ` (${lb.totalOvertimeHours} OT)` : ''}`)}
      ${metricRow(dictionary.laborCost, fmtMoney(lb.laborCostCents))}
      ${metricRow(dictionary.costPerOccupiedRoom, fmtMoney(lb.costPerOccupiedRoomCents))}
      ${metricRow(dictionary.sickCalloutsWeek, String(lb.sickCalloutsToday))}

      ${sectionHeader(dictionary.issues)}
      ${metricRow(dictionary.maintenanceWeek, String(is.workOrdersCreatedToday))}
      ${metricRow(dictionary.urgentPending, String(is.urgentItemsStillPending))}

      ${sectionHeader(dictionary.trendsVsPriorWeek)}
      ${trendsHtml}

      ${performerRows ? sectionHeader(dictionary.team) : ''}
      ${performerRows}

      ${sectionHeader(dictionary.nextWeek)}
      ${metricRow(dictionary.arrivals, String(nw.projectedArrivals))}
      ${metricRow(dictionary.departures, String(nw.projectedDepartures))}
      ${metricRow(dictionary.projectedToClean, String(nw.projectedRoomsToClean))}
      ${metricRow(dictionary.recommendedHeadcount, fmtMaybe(nw.recommendedHeadcount, (n) => String(n)))}

      ${anomaliesBlock(payload.anomalies, lang)}

      ${ctaButton(payload.dashboardUrl, dictionary.viewFullDashboard)}
    </table></td></tr>`;

  const html = shellHtml({
    subject,
    propertyName: payload.propertyName,
    dateLine: `${dictionary.weeklyHeader} — ${startStr} – ${endStr}`,
    body,
    footerLine: dictionary.footer,
    lang,
  });

  const text = renderWeeklyText(payload, lang);
  return { subject, html, text };
}

// ── Plain-text fallback (rendered in email clients that strip HTML) ───────

function renderDailyText(p: DailyReportPayload, lang: Lang): string {
  const d = lang === 'es' ? esDict : enDict;
  const dateLong = fmtDateLong(p.reportDate, lang);
  const lines = [
    `${p.propertyName} — ${d.dailyHeader} — ${dateLong}`,
    '',
    `${d.operations}:`,
    `  ${d.roomsCleanedToday}: ${p.operations.roomsCleanedToday} / ${p.operations.totalRoomsOnBoard}`,
    `  ${d.outOfOrderOOS}: ${p.operations.roomsOOO} OOO · ${p.operations.roomsOOS} OOS`,
    `  ${d.occupancy}: ${fmtPct(p.operations.occupancyPct)}`,
    `  ${d.avgPerDeparture}: ${fmtMinutes(p.operations.avgMinutesPerDeparture)}`,
    `  ${d.avgPerStayover}: ${fmtMinutes(p.operations.avgMinutesPerStayover)}`,
    `  ${d.avgPerDeep}: ${fmtMinutes(p.operations.avgMinutesPerDeepClean)}`,
    `  ${d.roomsPerHk}: ${p.operations.roomsPerHousekeeper}`,
    '',
    `${d.quality}:`,
    `  ${d.passRate}: ${fmtPct(p.quality.passRatePct)}`,
    `  ${d.reclearRate}: ${fmtPct(p.quality.reclearRatePct)}`,
    `  ${d.topFailures}: ${p.quality.topFailureReasons.length > 0 ? p.quality.topFailureReasons.map(r => `${r.reason} (${r.count})`).join(', ') : '—'}`,
    '',
    `${d.labor}:`,
    `  ${d.hoursWorked}: ${p.labor.totalHoursWorked}h${p.labor.totalOvertimeHours > 0 ? ` (${p.labor.totalOvertimeHours} OT)` : ''}`,
    `  ${d.laborCost}: ${fmtMoney(p.labor.laborCostCents)}`,
    `  ${d.costPerOccupiedRoom}: ${fmtMoney(p.labor.costPerOccupiedRoomCents)}`,
    `  ${d.sickCallouts}: ${p.labor.sickCalloutsToday}`,
    '',
    `${d.issues}:`,
    `  ${d.maintenanceCreated}: ${p.issues.workOrdersCreatedToday}`,
    `  ${d.urgentPending}: ${p.issues.urgentItemsStillPending}`,
    '',
    `${d.tomorrow}:`,
    // feat/cua-partial-promotion — while the reservation feeds are still
    // being learned, a "0 arrivals tomorrow" line would be a confident
    // wrong claim mailed out daily. Say "still syncing" instead.
    ...(p.tomorrow.reservationFeedsLearning
      ? [
          `  ${d.arrivals}: ${lang === 'es' ? 'sincronizando desde el PMS…' : 'still syncing from your PMS…'}`,
          `  ${d.departures}: ${lang === 'es' ? 'sincronizando desde el PMS…' : 'still syncing from your PMS…'}`,
        ]
      : [
          `  ${d.arrivals}: ${p.tomorrow.arrivals}`,
          `  ${d.departures}: ${p.tomorrow.departures}`,
          `  ${d.projectedToClean}: ${p.tomorrow.projectedRoomsToClean}`,
        ]),
    `  ${d.recommendedHeadcount}: ${p.tomorrow.recommendedHeadcount ?? '—'}`,
  ];
  if (p.anomalies.length > 0) {
    lines.push('', `${d.anomalies}:`);
    for (const a of p.anomalies) lines.push(`  • ${a.message}`);
  }
  lines.push('', `${d.viewFullDashboard}: ${p.dashboardUrl}`);
  return lines.join('\n');
}

function renderWeeklyText(p: WeeklyReportPayload, lang: Lang): string {
  const d = lang === 'es' ? esDict : enDict;
  const startStr = fmtDateLong(p.weekStartDate, lang);
  const endStr = fmtDateLong(p.reportDate, lang);
  const lines = [
    `${p.propertyName} — ${d.weeklyHeader} — ${startStr} – ${endStr}`,
    '',
  ];
  if (p.insightText) {
    lines.push(`${d.weekAtAGlance}:`, p.insightText, '');
  }
  lines.push(
    `${d.weeklyTotals}:`,
    `  ${d.roomsCleanedThisWeek}: ${p.operations.roomsCleanedToday}`,
    `  ${d.avgOccupancy}: ${fmtPct(p.operations.occupancyPct)}`,
    `  ${d.avgPerDeparture}: ${fmtMinutes(p.operations.avgMinutesPerDeparture)}`,
    `  ${d.avgPerStayover}: ${fmtMinutes(p.operations.avgMinutesPerStayover)}`,
    '',
    `${d.qualityWeek}:`,
    `  ${d.passRate}: ${fmtPct(p.quality.passRatePct)}`,
    `  ${d.reclearRate}: ${fmtPct(p.quality.reclearRatePct)}`,
    '',
    `${d.laborWeek}:`,
    `  ${d.hoursWorked}: ${p.labor.totalHoursWorked}h${p.labor.totalOvertimeHours > 0 ? ` (${p.labor.totalOvertimeHours} OT)` : ''}`,
    `  ${d.laborCost}: ${fmtMoney(p.labor.laborCostCents)}`,
    '',
    `${d.trendsVsPriorWeek}:`,
  );
  for (const t of p.trends) {
    const sign = t.deltaPct > 0 ? '+' : '';
    lines.push(`  ${t.metric}: ${sign}${t.deltaPct}% vs prior week`);
  }
  if (p.topPerformer) lines.push('', `${d.topPerformer}: ${p.topPerformer.name} — ${p.topPerformer.roomsCleaned} ${d.rooms}`);
  if (p.improvementOpportunity) lines.push(`${d.improvementOpportunity}: ${p.improvementOpportunity.name} — ${fmtPct(p.improvementOpportunity.inspectionPassRatePct ?? 0)} ${d.passRateLower}`);
  lines.push('', `${d.viewFullDashboard}: ${p.dashboardUrl}`);
  return lines.join('\n');
}

// ── Dictionaries ──────────────────────────────────────────────────────────

const enDict = {
  dailyHeader: 'Daily Housekeeping Report',
  weeklyHeader: 'Weekly Housekeeping Report',
  weekAtAGlance: 'Week at a glance',
  operations: 'Operations',
  roomsCleanedToday: 'Rooms cleaned today / on board',
  outOfOrderOOS: 'OOO / OOS',
  occupancy: 'Occupancy',
  avgPerDeparture: 'Avg per departure',
  avgPerStayover: 'Avg per stayover',
  avgPerDeep: 'Avg per deep clean',
  roomsPerHk: 'Rooms per housekeeper',
  quality: 'Quality',
  qualityWeek: 'Quality (this week)',
  passRate: 'Inspection pass rate',
  reclearRate: 'Re-clean rate',
  topFailures: 'Top failure reasons',
  labor: 'Labor',
  laborWeek: 'Labor (this week)',
  hoursWorked: 'Hours worked',
  laborCost: 'Labor cost',
  costPerOccupiedRoom: 'Cost per occupied room',
  budgetVsActual: 'Budget vs actual',
  sickCallouts: 'Sick callouts today',
  sickCalloutsWeek: 'Sick callouts this week',
  issues: 'Issues',
  maintenanceCreated: 'Maintenance tickets created',
  maintenanceWeek: 'Maintenance tickets created this week',
  urgentPending: 'Urgent items still pending',
  tomorrow: "Tomorrow's outlook",
  arrivals: 'Arrivals',
  departures: 'Departures',
  projectedToClean: 'Projected rooms to clean',
  recommendedHeadcount: 'Recommended headcount',
  recommendedCost: 'Recommended labor cost',
  roomsPendingOoo: 'Rooms still OOO at EOD',
  roomsPendingInspection: 'Rooms still awaiting inspection',
  anomalies: 'Anomalies',
  viewFullDashboard: 'View full dashboard',
  footer: "You're receiving this because you're listed as a manager or owner for this property. Manage your delivery preferences in Settings → Notifications.",
  weeklyTotals: 'Weekly totals',
  avgOccupancy: 'Average occupancy',
  trendsVsPriorWeek: 'Trends vs prior week',
  team: 'Team',
  nextWeek: "Next week's outlook",
  topPerformer: 'Top performer',
  improvementOpportunity: 'Improvement opportunity',
  rooms: 'rooms',
  passRateLower: 'pass rate',
  roomsCleanedThisWeek: 'Rooms cleaned',
  laborCostThisWeek: 'Labor cost',
  passRateThisWeek: 'Inspection pass rate',
  calloutsThisWeek: 'Callouts',
};

const esDict: typeof enDict = {
  dailyHeader: 'Reporte diario de limpieza',
  weeklyHeader: 'Reporte semanal de limpieza',
  weekAtAGlance: 'La semana en breve',
  operations: 'Operaciones',
  roomsCleanedToday: 'Cuartos limpios hoy / en agenda',
  outOfOrderOOS: 'Fuera de servicio (OOO / OOS)',
  occupancy: 'Ocupación',
  avgPerDeparture: 'Promedio por salida',
  avgPerStayover: 'Promedio por estadía',
  avgPerDeep: 'Promedio por limpieza profunda',
  roomsPerHk: 'Cuartos por camarera',
  quality: 'Calidad',
  qualityWeek: 'Calidad (esta semana)',
  passRate: 'Tasa de aprobación',
  reclearRate: 'Tasa de re-limpieza',
  topFailures: 'Principales fallas',
  labor: 'Mano de obra',
  laborWeek: 'Mano de obra (esta semana)',
  hoursWorked: 'Horas trabajadas',
  laborCost: 'Costo de mano de obra',
  costPerOccupiedRoom: 'Costo por cuarto ocupado',
  budgetVsActual: 'Presupuesto vs real',
  sickCallouts: 'Ausencias por enfermedad hoy',
  sickCalloutsWeek: 'Ausencias esta semana',
  issues: 'Problemas',
  maintenanceCreated: 'Tickets de mantenimiento creados',
  maintenanceWeek: 'Tickets de mantenimiento esta semana',
  urgentPending: 'Pendientes urgentes',
  tomorrow: 'Mañana',
  arrivals: 'Llegadas',
  departures: 'Salidas',
  projectedToClean: 'Cuartos proyectados a limpiar',
  recommendedHeadcount: 'Personal recomendado',
  recommendedCost: 'Costo recomendado',
  roomsPendingOoo: 'Cuartos OOO al final del día',
  roomsPendingInspection: 'Cuartos pendientes de inspección',
  anomalies: 'Anomalías',
  viewFullDashboard: 'Ver el panel completo',
  footer: 'Recibes este correo porque estás registrado como gerente o propietario de esta propiedad. Administra tus preferencias en Configuración → Notificaciones.',
  weeklyTotals: 'Totales semanales',
  avgOccupancy: 'Ocupación promedio',
  trendsVsPriorWeek: 'Cambios vs semana anterior',
  team: 'Equipo',
  nextWeek: 'Próxima semana',
  topPerformer: 'Mejor desempeño',
  improvementOpportunity: 'Oportunidad de mejora',
  rooms: 'cuartos',
  passRateLower: 'tasa de aprobación',
  roomsCleanedThisWeek: 'Cuartos limpios',
  laborCostThisWeek: 'Costo de mano de obra',
  passRateThisWeek: 'Tasa de aprobación',
  calloutsThisWeek: 'Ausencias',
};

// ── Sender wrapper — combines render + Resend send ────────────────────────

import { sendTransactionalEmail, type SendEmailResult } from '@/lib/email/resend';
import { createHash } from 'crypto';

export async function sendDailyReportEmail(args: {
  to: string;
  payload: DailyReportPayload;
  lang?: Lang;
  /** Idempotency-key suffix. Same property/date/recipient = same key, so a
   * retried cron tick can't double-send to one inbox even if the
   * report_runs idempotency check raced. */
  idempotencyKey?: string;
}): Promise<SendEmailResult> {
  const { to, payload, idempotencyKey } = args;
  const lang = args.lang ?? 'en';
  const rendered = renderDailyReport({ payload, lang });
  const key = idempotencyKey
    ?? `daily:${createHash('sha256').update(`${to}|${payload.propertyId}|${payload.reportDate}`).digest('hex').slice(0, 24)}`;
  return sendTransactionalEmail({
    to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    idempotencyKey: key,
    tags: [
      { name: 'kind', value: 'housekeeping_daily_report' },
      { name: 'property_id', value: payload.propertyId },
      { name: 'lang', value: lang },
    ],
  });
}

export async function sendWeeklyReportEmail(args: {
  to: string;
  payload: WeeklyReportPayload;
  lang?: Lang;
  idempotencyKey?: string;
}): Promise<SendEmailResult> {
  const { to, payload, idempotencyKey } = args;
  const lang = args.lang ?? 'en';
  const rendered = renderWeeklyReport({ payload, lang });
  const key = idempotencyKey
    ?? `weekly:${createHash('sha256').update(`${to}|${payload.propertyId}|${payload.reportDate}`).digest('hex').slice(0, 24)}`;
  return sendTransactionalEmail({
    to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    idempotencyKey: key,
    tags: [
      { name: 'kind', value: 'housekeeping_weekly_report' },
      { name: 'property_id', value: payload.propertyId },
      { name: 'lang', value: lang },
    ],
  });
}
