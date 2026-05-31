/**
 * Shared param-parse + gate + context resolution for the run/export routes.
 * Both need the same: validate reportKey + propertyId + date window + lang,
 * verify manager access to the property, look up the definition, and resolve
 * the property timezone. Returns a ready ReportContext or a NextResponse to
 * return directly.
 */

import type { NextRequest } from 'next/server';
import type { NextResponse } from 'next/server';
import { err } from '@/lib/api-response';
import { validateDateStr, validateEnum, validateString, validateUuid } from '@/lib/api-validate';
import { getReportDefinition } from '@/lib/reports/catalog';
import type { ReportContext, ReportDefinition } from './types';
import { dateAddDays, getPropertyMeta } from './helpers';
import { gateReportsAccess } from './gate';

const MAX_RANGE_DAYS = 366;

export type Resolved =
  | { ok: true; def: ReportDefinition; ctx: ReportContext; propertyId: string; accountId: string; lang: 'en' | 'es' }
  | { ok: false; response: NextResponse };

export async function resolveRunContext(req: NextRequest, requestId: string): Promise<Resolved> {
  const sp = req.nextUrl.searchParams;

  const keyV = validateString(sp.get('reportKey'), { label: 'reportKey', max: 100 });
  if (keyV.error) return { ok: false, response: err(keyV.error ?? 'invalid reportKey', { requestId, status: 400, code: 'validation_failed' }) };

  const pidV = validateUuid(sp.get('propertyId'), 'propertyId');
  if (pidV.error) return { ok: false, response: err(pidV.error ?? 'invalid propertyId', { requestId, status: 400, code: 'validation_failed' }) };
  const propertyId = pidV.value!;

  const fromV = validateDateStr(sp.get('from'), { label: 'from' });
  if (fromV.error) return { ok: false, response: err(fromV.error ?? 'invalid from', { requestId, status: 400, code: 'validation_failed' }) };
  const toV = validateDateStr(sp.get('to'), { label: 'to' });
  if (toV.error) return { ok: false, response: err(toV.error ?? 'invalid to', { requestId, status: 400, code: 'validation_failed' }) };
  const from = fromV.value!;
  const to = toV.value!;
  if (from > to) {
    return { ok: false, response: err('from must be on or before to', { requestId, status: 400, code: 'validation_failed' }) };
  }
  // Cap the window so a runaway range can't OOM the lambda.
  if (dateAddDays(from, MAX_RANGE_DAYS) < to) {
    return { ok: false, response: err(`Date range too large (max ${MAX_RANGE_DAYS} days).`, { requestId, status: 400, code: 'range_too_large' }) };
  }

  const langV = validateEnum(sp.get('lang') ?? 'en', ['en', 'es'] as const, 'lang');
  const lang = ((langV.value ?? 'en')) as 'en' | 'es';

  const def = getReportDefinition(keyV.value!);
  if (!def) {
    return { ok: false, response: err('Unknown report.', { requestId, status: 404, code: 'unknown_report' }) };
  }

  const gate = await gateReportsAccess(req, propertyId);
  if (!gate.ok) {
    return { ok: false, response: err(gate.error, { requestId, status: gate.status, code: gate.code }) };
  }

  const meta = await getPropertyMeta(propertyId);
  const ctx: ReportContext = { propertyId, from, to, timezone: meta.timezone };
  return { ok: true, def, ctx, propertyId, accountId: gate.caller.accountId, lang };
}
