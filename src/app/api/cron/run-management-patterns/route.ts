/**
 * Shadow-only management-company pattern evidence runner.
 *
 * This route is deliberately not present in vercel.json. It can be invoked by
 * an authenticated operator/cron during shadow validation, but there is no
 * request parameter or code path that authorizes projection to company_findings.
 */
import { NextRequest } from 'next/server';

import { requireCronSecret } from '@/lib/api-auth';
import { err, ok, ApiErrorCode } from '@/lib/api-response';
import { isUuid } from '@/lib/api-validate';
import { log, getOrMintRequestId } from '@/lib/log';
import { runWithConcurrency } from '@/lib/parallel';
import { runScheduledManagementPatterns } from '@/lib/company/management-patterns/runner';
import { supabaseAdmin } from '@/lib/supabase-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const MAX_ORGANIZATIONS_PER_INVOCATION = 32;
const ORGANIZATION_CONCURRENCY = 4;

async function organizationIds(requestedId: string | null): Promise<readonly string[]> {
  if (requestedId) return [requestedId];
  const { data, error } = await supabaseAdmin
    .from('organizations')
    .select('id')
    .eq('status', 'active')
    .in('organization_type', ['management_company', 'ownership_group'])
    .order('id', { ascending: true })
    .limit(MAX_ORGANIZATIONS_PER_INVOCATION + 1);
  if (error) throw new Error(`management pattern organization discovery failed: ${error.message}`);
  const ids = (data ?? []).map((row) => String(row.id));
  if (ids.length > MAX_ORGANIZATIONS_PER_INVOCATION) {
    throw new Error('management pattern organization fleet exceeds the fixed invocation budget');
  }
  return Object.freeze(ids);
}

export async function GET(request: NextRequest) {
  const requestId = getOrMintRequestId(request);
  const cronGate = requireCronSecret(request);
  if (cronGate) return cronGate;

  const url = new URL(request.url);
  const organizationId = url.searchParams.get('organizationId');
  if (organizationId !== null && !isUuid(organizationId)) {
    return err('organizationId must be a UUID', {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }
  if (
    url.searchParams.has('active')
    || url.searchParams.has('projection')
    || url.searchParams.has('projectionMode')
  ) {
    return err('management pattern projection cannot be selected from this shadow endpoint', {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }

  try {
    const ids = await organizationIds(organizationId);
    const outcomes = await runWithConcurrency(
      [...ids],
      (id) => runScheduledManagementPatterns({ organizationId: id }),
      ORGANIZATION_CONCURRENCY,
    );
    const succeeded = outcomes.flatMap((outcome) => outcome.ok ? [outcome.value] : []);
    const failed = outcomes.flatMap((outcome) => outcome.ok ? [] : [{
      organizationId: outcome.input,
      errorKind: outcome.error instanceof Error ? outcome.error.name : 'UnknownError',
    }]);
    const totals = {
      organizationsRequested: ids.length,
      completed: succeeded.filter((item) => item.outcome === 'completed').length,
      alreadyComplete: succeeded.filter((item) => item.outcome === 'already_complete').length,
      busy: succeeded.filter((item) => item.outcome === 'busy').length,
      failed: failed.length,
      projectionMode: 'shadow' as const,
    };
    if (failed.length > 0) {
      log.error('[management-patterns] shadow fleet degraded', {
        requestId,
        ...totals,
        failures: failed,
      });
      return err('one or more management pattern shadow runs failed', {
        requestId,
        status: 500,
        code: ApiErrorCode.InternalError,
        details: { totals, results: succeeded, failures: failed },
      });
    }
    log.info('[management-patterns] shadow fleet completed', { requestId, ...totals });
    return ok({ totals, results: succeeded }, { requestId });
  } catch (error) {
    log.error('[management-patterns] shadow fleet failed', { requestId, error });
    return err('management pattern shadow run failed', {
      requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
    });
  }
}

export async function POST(request: NextRequest) {
  return GET(request);
}
