/**
 * GET /api/cron/financials-alert-sweep
 *
 * Proactive finance alerts (cron-gated, daily). For each property with finance
 * activity + an alert phone on file:
 *   1. OVERSPEND — project each department's month-end spend (spend-to-date
 *      paced by days elapsed, occupancy-adjusted) and flag depts trending over
 *      budget.
 *   2. ANOMALY — flag departments whose spend is materially over last month.
 * New findings are texted to the property's alert phone (one combined message).
 *
 * Idempotent / no-spam: each (property, month, department, kind) finding is
 * recorded in app_events and not re-sent for DEDUP_DAYS. SMS is billing-gated on
 * the RAW pid. Honest cold start: the forecast engine only raises overspend
 * alerts once enough of the month has elapsed (confidence gate), so this won't
 * cry wolf on day 2.
 */

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireCronSecret } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { checkAndIncrementRateLimit } from '@/lib/api-ratelimit';
import { sendSms } from '@/lib/sms';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';
import {
  monthKey,
  priorMonthKey,
  monthStartISO,
  nextMonthStartISO,
  daysInMonth as daysInMonthOf,
  daysElapsedInMonth,
  type Department,
} from '@/lib/financials/shared';
import { budgetVsActual, sumExpensesByDepartment } from '@/lib/financials/db';
import { getOccupancyPacingFactor } from '@/lib/financials/revenue';
import { forecastDepartmentOverspend } from '@/lib/financials/forecast';
import { detectDepartmentSpikes } from '@/lib/financials/anomaly';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const DEDUP_DAYS = 7;
const MAX_PROPERTIES = 500;

interface Finding {
  department: Department;
  kind: 'overspend' | 'anomaly';
  message: string;
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const unauth = requireCronSecret(req);
  if (unauth) return unauth;

  const now = new Date();
  const todayISO = now.toISOString().slice(0, 10);
  const month = monthKey(now);
  const prior = priorMonthKey(month);
  const dim = daysInMonthOf(month);
  const elapsed = daysElapsedInMonth(month, now);
  const dedupSinceIso = new Date(now.getTime() - DEDUP_DAYS * 86400_000).toISOString();

  let propertiesChecked = 0;
  let alertsSent = 0;
  let skippedNoPhone = 0;
  let rateLimited = 0;
  let deduped = 0;

  try {
    // Candidate properties: any with a budget this month OR an expense in the
    // current/prior month. Deduped in JS (fleet is small).
    const pidSet = new Set<string>();
    const { data: budgetPids } = await supabaseAdmin
      .from('department_budgets')
      .select('property_id')
      .eq('month_start', monthStartISO(month))
      .limit(5000);
    for (const r of budgetPids ?? []) pidSet.add((r as { property_id: string }).property_id);
    const { data: expensePids } = await supabaseAdmin
      .from('financial_expenses')
      .select('property_id')
      .gte('expense_date', monthStartISO(prior))
      .lt('expense_date', nextMonthStartISO(month))
      .limit(50000);
    for (const r of expensePids ?? []) pidSet.add((r as { property_id: string }).property_id);

    const pids = [...pidSet].slice(0, MAX_PROPERTIES);

    for (const pid of pids) {
      propertiesChecked++;

      // Build findings for this property.
      const [vsActual, priorByDept, occFactor] = await Promise.all([
        budgetVsActual(pid, month),
        sumExpensesByDepartment(pid, prior),
        getOccupancyPacingFactor(pid, month, todayISO),
      ]);

      const findings: Finding[] = [];

      // Overspend (only depts with a budget; the engine self-gates on confidence)
      for (const b of vsActual) {
        if (b.budgetCents <= 0) continue;
        const f = forecastDepartmentOverspend(b.department, b.budgetCents, b.actualCents, elapsed, dim, occFactor);
        if (f.trendingOver) findings.push({ department: b.department, kind: 'overspend', message: f.message });
      }

      // Anomaly (current MTD vs prior full month)
      const currentByDept = Object.fromEntries(vsActual.map((b) => [b.department, b.actualCents])) as Record<
        Department,
        number
      >;
      for (const a of detectDepartmentSpikes(currentByDept, priorByDept)) {
        if (a.department) findings.push({ department: a.department, kind: 'anomaly', message: a.message });
      }

      if (findings.length === 0) continue;

      // Dedup against recent app_events (same month/department/kind).
      const { data: recent } = await supabaseAdmin
        .from('app_events')
        .select('metadata')
        .eq('property_id', pid)
        .eq('event_type', 'financials_alert')
        .gte('created_at', dedupSinceIso)
        .limit(500);
      const seen = new Set(
        (recent ?? []).map((r) => {
          const m = (r as { metadata: Record<string, unknown> | null }).metadata ?? {};
          return `${m.month}:${m.department}:${m.kind}`;
        }),
      );
      const fresh = findings.filter((f) => !seen.has(`${month}:${f.department}:${f.kind}`));
      deduped += findings.length - fresh.length;
      if (fresh.length === 0) continue;

      // Need an alert phone.
      const { data: prop } = await supabaseAdmin
        .from('properties')
        .select('alert_phone')
        .eq('id', pid)
        .maybeSingle();
      const phone = (prop?.alert_phone as string | null) ?? null;
      if (!phone) {
        skippedNoPhone++;
        continue;
      }

      // Billing-gated SMS (RAW pid → fails closed).
      const smsRl = await checkAndIncrementRateLimit('financials-sms', pid);
      if (!smsRl.allowed) {
        rateLimited++;
        continue;
      }

      const shown = fresh.slice(0, 3).map((f) => f.message);
      const more = fresh.length - shown.length;
      const body = `Staxis Financials alert: ${shown.join(' ')}${more > 0 ? ` (+${more} more)` : ''}`.slice(0, 600);

      try {
        await sendSms(phone, body);
        alertsSent++;
        // Record each fresh finding so it isn't re-sent for DEDUP_DAYS.
        await supabaseAdmin.from('app_events').insert(
          fresh.map((f) => ({
            property_id: pid,
            event_type: 'financials_alert',
            metadata: { month, department: f.department, kind: f.kind, message: f.message },
          })),
        );
      } catch (e) {
        log.warn('[cron/financials-alert-sweep] SMS failed', { requestId, pid, err: errToString(e) });
      }
    }

    log.info('[cron/financials-alert-sweep] tick', {
      requestId,
      propertiesChecked,
      alertsSent,
      skippedNoPhone,
      rateLimited,
      deduped,
    });
    await writeCronHeartbeat('financials-alert-sweep', {
      requestId,
      notes: { propertiesChecked, alertsSent, skippedNoPhone, rateLimited, deduped },
    });
    return ok({ propertiesChecked, alertsSent, skippedNoPhone, rateLimited, deduped }, { requestId });
  } catch (caughtErr) {
    log.error('[cron/financials-alert-sweep] failed', { requestId, err: errToString(caughtErr) });
    return err('financials-alert-sweep failed', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
}
