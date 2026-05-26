/**
 * POST /api/internal/pms-changed?propertyId=<uuid>
 *
 * Reactive entry point. The cua-service worker calls this when a high-
 * priority PMS write lands (arrival surge, cancellation wave, VIP added,
 * status flip) so the manager sees a schedule gap alert within ~30s
 * instead of waiting for tomorrow's nightly cron.
 *
 * Body (optional): { kind?: 'arrival_surge'|'cancellation_wave'|'vip_added'|'status_flip',
 *                    date?: 'YYYY-MM-DD' }
 *   - kind defaults to 'status_flip' if absent.
 *   - date defaults to TODAY in the property's local timezone (the recent-
 *     past window is what reacts; future cancels are caught by tomorrow's
 *     nightly run + a same-call pass against (date, date+1)).
 *
 * For each of today + tomorrow (in property-local time) we recompute the
 * gap across all alertable departments. The recompute writer dedupes
 * existing open alerts; the manager UI is reactive and refetches.
 *
 * Auth: CRON_SECRET bearer.
 */

import { NextRequest } from 'next/server';
import { requireCronSecret } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { validateUuid, validateDateStr, validateEnum } from '@/lib/api-validate';
import {
  makeSupabaseReader,
  makeSupabaseWriter,
  loadPropertyConfig,
  avgPropertyWageCentsPerHour,
} from '@/lib/schedule-reactivity/persist';
import { recomputeAlerts } from '@/lib/schedule-reactivity/recompute';
import { propertyLocalDateOffset } from '@/lib/schedule/local-date';
import { ALERTABLE_DEPTS } from '@/lib/schedule-reactivity/compute-gap';
import type { TriggerKind, AlertDepartment } from '@/lib/schedule-reactivity/types';
import { sendAlertSms } from '@/lib/schedule-reactivity/notify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const VALID_TRIGGERS = [
  'arrival_surge', 'cancellation_wave', 'vip_added', 'status_flip',
  'manual_recompute', 'cron_recompute',
] as const;

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const gate = requireCronSecret(req);
  if (gate) return gate;

  const url = new URL(req.url);
  const propIdQs = url.searchParams.get('propertyId');
  const propIdBody = (await req.clone().json().catch(() => ({})) as { propertyId?: string }).propertyId;
  const propIdInput = propIdQs ?? propIdBody;
  const pidCheck = validateUuid(propIdInput, 'propertyId');
  if (pidCheck.error) {
    return err(pidCheck.error, {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }
  const propertyId = pidCheck.value!;

  let body: { kind?: string; date?: string };
  try {
    body = (await req.json()) as { kind?: string; date?: string };
  } catch {
    body = {};
  }
  let triggerKind: TriggerKind = 'status_flip';
  if (body.kind) {
    const t = validateEnum(body.kind, VALID_TRIGGERS, 'kind');
    if (t.error) {
      return err(t.error, {
        requestId, status: 400, code: ApiErrorCode.ValidationFailed,
      });
    }
    triggerKind = t.value as TriggerKind;
  }

  // Validate optional explicit date.
  let explicitDate: string | null = null;
  if (body.date) {
    const d = validateDateStr(body.date, {
      label: 'date',
      allowFutureDays: 14,
      allowPastDays: 1,
    });
    if (d.error) {
      return err(d.error, {
        requestId, status: 400, code: ApiErrorCode.ValidationFailed,
      });
    }
    explicitDate = d.value!;
  }

  // Resolve property timezone for "today/tomorrow in local" calc.
  const { data: prop, error: propErr } = await supabaseAdmin
    .from('properties')
    .select('id, name, timezone')
    .eq('id', propertyId)
    .maybeSingle();
  if (propErr || !prop) {
    return err('property not found', {
      requestId, status: 404, code: ApiErrorCode.NotFound,
    });
  }
  const tz = (prop.timezone as string | null) ?? null;

  const now = new Date();
  const today = propertyLocalDateOffset(now, tz, 0);
  const tomorrow = propertyLocalDateOffset(now, tz, 1);
  const dates = explicitDate ? [explicitDate] : [today, tomorrow];

  const reader = makeSupabaseReader();
  const writer = makeSupabaseWriter();
  const cfg = await loadPropertyConfig(propertyId);

  // Cache wage per dept — same property, multiple dates use the same wage.
  const wageByDept: Partial<Record<AlertDepartment, number | null>> = {};
  for (const dept of ALERTABLE_DEPTS) {
    wageByDept[dept] = await avgPropertyWageCentsPerHour(propertyId, dept);
  }

  const summaries: unknown[] = [];
  const redAlertsToNotify: Array<{ alertDate: string; dept: AlertDepartment; suggestion: import('@/lib/schedule-reactivity/types').Suggestion }> = [];
  for (const d of dates) {
    try {
      const summary = await recomputeAlerts(
        propertyId, d, reader, cfg, writer,
        { triggerKind, wageCentsPerHourByDept: wageByDept },
      );
      summaries.push(summary);
      for (const dept of ALERTABLE_DEPTS) {
        const s = summary.suggestionsByDept[dept];
        if (s && s.severity === 'red') {
          redAlertsToNotify.push({ alertDate: d, dept, suggestion: s });
        }
      }
    } catch (e) {
      log.warn('[pms-changed] recompute failed for one date', {
        requestId, propertyId, date: d,
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Fire SMS for red severity alerts. Fail-quiet: the alert is already in
  // the table, the banner will render; SMS is a nice-to-have escalation.
  if (redAlertsToNotify.length > 0) {
    try {
      await sendAlertSms({
        propertyId,
        propertyName: (prop.name as string) ?? 'Hotel',
        alerts: redAlertsToNotify,
      });
    } catch (e) {
      log.warn('[pms-changed] red-alert SMS notify failed', {
        requestId, propertyId,
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }

  log.info('[pms-changed] done', {
    requestId, propertyId, triggerKind,
    dates, redCount: redAlertsToNotify.length,
  });
  return ok({
    propertyId, triggerKind, dates,
    redAlerts: redAlertsToNotify.length,
    summaries,
  }, { requestId });
}
