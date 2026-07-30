/**
 * Daily management-company findings owner.
 *
 * One scheduled invocation runs both existing persistence paths:
 *   - the legacy portfolio checks that write the live company queue; and
 *   - the v2 management-pattern evaluator, which remains shadow-only.
 *
 * The v2 runner derives its immutable weekly boundary internally, so daily
 * calls become already_complete after Monday's evaluation while buying a
 * bounded automatic retry on the next tick. There is still no request
 * parameter or code path that authorizes v2 projection to company_findings.
 */
import { NextRequest } from 'next/server';

import { requireCronSecret } from '@/lib/api-auth';
import { err, ok, ApiErrorCode } from '@/lib/api-response';
import { isUuid } from '@/lib/api-validate';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';
import { log, getOrMintRequestId } from '@/lib/log';
import { runWithConcurrency } from '@/lib/parallel';
import { runScheduledManagementPatterns } from '@/lib/company/management-patterns/runner';
import {
  holdPortfolioDay,
  runPortfolioChecks,
  type PortfolioRunSummary,
} from '@/lib/company/portfolio-runner';
import { supabaseAdmin } from '@/lib/supabase-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const MAX_ORGANIZATIONS_PER_INVOCATION = 32;
const ORGANIZATION_CONCURRENCY = 4;

interface OrganizationRunResult {
  organizationId: string;
  shadow: Awaited<ReturnType<typeof runScheduledManagementPatterns>> | null;
  portfolio: PortfolioRunSummary | null;
  errors: readonly string[];
}

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

async function runOrganization(organizationId: string): Promise<OrganizationRunResult> {
  const [shadowOutcome, portfolioOutcome] = await Promise.allSettled([
    runScheduledManagementPatterns({ organizationId }),
    runPortfolioChecks({ organizationId }),
  ]);
  const errors: string[] = [];
  const shadow = shadowOutcome.status === 'fulfilled' ? shadowOutcome.value : null;
  const portfolio = portfolioOutcome.status === 'fulfilled' ? portfolioOutcome.value : null;

  if (shadowOutcome.status === 'rejected') {
    errors.push(`shadow:${shadowOutcome.reason instanceof Error ? shadowOutcome.reason.name : 'UnknownError'}`);
  }
  if (portfolioOutcome.status === 'rejected') {
    errors.push(`portfolio:${portfolioOutcome.reason instanceof Error ? portfolioOutcome.reason.name : 'UnknownError'}`);
  } else if (!['completed', 'held'].includes(portfolioOutcome.value.completion)) {
    errors.push(`portfolio:${portfolioOutcome.value.completion}`);
  } else if (portfolioOutcome.value.ran) {
    await holdPortfolioDay(
      organizationId,
      portfolioOutcome.value.localDate,
      portfolioOutcome.value,
    );
  }

  return { organizationId, shadow, portfolio, errors };
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
      (id) => runOrganization(id),
      ORGANIZATION_CONCURRENCY,
    );
    const results = outcomes.flatMap((outcome) => outcome.ok ? [outcome.value] : []);
    const failed = [
      ...outcomes.flatMap((outcome) => outcome.ok ? [] : [{
        organizationId: outcome.input,
        errorKind: outcome.error instanceof Error ? outcome.error.name : 'UnknownError',
      }]),
      ...results.flatMap((result) => result.errors.map((errorKind) => ({
        organizationId: result.organizationId,
        errorKind,
      }))),
    ];
    const shadowResults = results.flatMap((result) => result.shadow ? [result.shadow] : []);
    const portfolioResults = results.flatMap((result) => result.portfolio ? [result.portfolio] : []);
    const totals = {
      organizationsRequested: ids.length,
      shadowCompleted: shadowResults.filter((item) => item.outcome === 'completed').length,
      shadowAlreadyComplete: shadowResults.filter((item) => item.outcome === 'already_complete').length,
      shadowBusy: shadowResults.filter((item) => item.outcome === 'busy').length,
      portfolioCompleted: portfolioResults.filter((item) => item.completion === 'completed').length,
      portfolioHeld: portfolioResults.filter((item) => item.completion === 'held').length,
      failed: failed.length,
      liveQueueMode: 'legacy_portfolio_checks' as const,
      managementPatternProjectionMode: 'shadow' as const,
    };
    if (failed.length > 0) {
      log.error('[management-patterns] scheduled fleet degraded', {
        requestId,
        ...totals,
        failures: failed,
      });
      return err('one or more management-company background runs failed', {
        requestId,
        status: 500,
        code: ApiErrorCode.InternalError,
        details: { totals, results, failures: failed },
      });
    }
    await writeCronHeartbeat('run-management-patterns', {
      requestId,
      notes: totals,
    });
    log.info('[management-patterns] scheduled fleet completed', { requestId, ...totals });
    return ok({ totals, results }, { requestId });
  } catch (error) {
    log.error('[management-patterns] scheduled fleet failed', { requestId, error });
    return err('management pattern scheduled run failed', {
      requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
    });
  }
}

export async function POST(request: NextRequest) {
  return GET(request);
}
