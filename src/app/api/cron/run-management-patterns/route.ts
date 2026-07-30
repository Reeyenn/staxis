/**
 * The management-company findings owner. DORMANT ON PURPOSE.
 *
 * One invocation runs both existing persistence paths for every management
 * company:
 *   - the legacy portfolio checks that write the live company queue; and
 *   - the v2 management-pattern evaluator, which remains shadow-only.
 *
 * The v2 runner derives its immutable weekly boundary internally, so repeat
 * calls become already_complete after the week's evaluation while buying a
 * bounded automatic retry on the next tick. There is still no request
 * parameter or code path that authorizes v2 projection to company_findings.
 *
 * DORMANT ON PURPOSE (2026-07-29, owner ruling). There is no vercel.json entry.
 * The whole AI layer stays off behind ONE master switch the founder flips when
 * the first real hotel is onboarded, which is why the hotel-level siblings
 * run-findings, findings-sweep and findings-janitor have never been scheduled
 * either. This route was briefly scheduled at '0 8 * * *'; on a fleet whose only
 * management company is the seeded demo one, that started the AI on nobody's
 * behalf. To enable, four places:
 *   1. vercel.json                        → { "path": "/api/cron/run-management-patterns", "schedule": "0 8 * * *" }
 *   2. src/lib/cron-schedule-registry.ts  → { heartbeatName: 'run-management-patterns', source: { kind: 'vercel', cronPath: '/api/cron/run-management-patterns' }, cronExpr: '0 8 * * *' }
 *   3. src/app/api/admin/doctor/route.ts  → EXPECTED_CRONS entry, cadenceHours: 24
 *   4. src/app/api/admin/mission/workers/route.ts → WORKER_META line
 * Do not flip this one on its own. docs/cron-triggers.md, "The AI master switch",
 * is the single checklist that turns all four crons on together.
 *
 * Until then it is callable by hand with the cron bearer, and the company queue
 * keeps its same-runner page-open fallback, so a live demo still produces cards.
 *
 * Query params:
 *   organizationId (optional, uuid) — run only this company, demo or not. An
 *                                    operator naming one company by id is
 *                                    intent; only the schedule's own discovery
 *                                    skips demo companies.
 *
 * Auth: CRON_SECRET bearer (shared with the rest of /api/cron/*).
 */
import { NextRequest } from 'next/server';

import { requireCronSecret } from '@/lib/api-auth';
import { err, ok, ApiErrorCode } from '@/lib/api-response';
import { isUuid } from '@/lib/api-validate';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';
import { log, getOrMintRequestId } from '@/lib/log';
import { runWithConcurrency } from '@/lib/parallel';
import { runScheduledManagementPatterns } from '@/lib/company/management-patterns/runner';
import { isDemoOnlyOrganization } from '@/lib/company/demo-portfolio';
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

/**
 * The companies this invocation will run.
 *
 * An explicit `organizationId` is an operator's deliberate act and comes back
 * untouched. DISCOVERY — the path a schedule takes — additionally drops any
 * company whose entire portfolio is demo hotels. The reasoning, and why the
 * page-open fallback is deliberately not filtered, is in
 * src/lib/company/demo-portfolio.ts.
 */
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
  // The budget is measured on the DISCOVERED fleet, before the demo filter. The
  // bound exists to cap one invocation's work, and a fleet that size is a fact
  // about the deployment whether or not part of it turns out to be demo data.
  if (ids.length > MAX_ORGANIZATIONS_PER_INVOCATION) {
    throw new Error('management pattern organization fleet exceeds the fixed invocation budget');
  }
  const verdicts = await Promise.all(ids.map(async (id) => ({
    id,
    demo: await isDemoOnlyOrganization(id),
  })));
  const scheduled = verdicts.filter((verdict) => !verdict.demo).map((verdict) => verdict.id);
  const skipped = verdicts.length - scheduled.length;
  if (skipped > 0) {
    log.info('[management-patterns] demo companies sat out the scheduled pass', {
      discovered: verdicts.length,
      scheduled: scheduled.length,
      skipped,
    });
  }
  return Object.freeze(scheduled);
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
