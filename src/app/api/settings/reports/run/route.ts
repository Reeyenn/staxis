/**
 * GET /api/settings/reports/run
 *
 * Runs a catalog report for a property + date window and returns the table
 * (columns + rows + stats + notes), plus an optional one-line AI summary.
 *
 * Auth: manager/owner/admin + property access (gateReportsAccess, via
 * resolveRunContext). Rate-limited on the RAW property id — never a hashed
 * pid:user composite (the api_limits.property_id FK trap, see
 * feedback_ratelimit_raw_pid_fk). reports-run is billing-impacting because it
 * can call Claude for the summary.
 */

import type { NextRequest } from 'next/server';
import { err, ok } from '@/lib/api-response';
import { checkAndIncrementRateLimit } from '@/lib/api-ratelimit';
import { generateReportSummary } from '@/lib/reports/catalog/ai-summary';
import { resolveRunContext } from '@/lib/reports/catalog/route-helpers';
import { getOrMintRequestId, log } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  try {
    const resolved = await resolveRunContext(req, requestId);
    if (!resolved.ok) return resolved.response;
    const { def, ctx, propertyId, lang } = resolved;

    // Per-property cap. RAW pid (real properties.id) — required because
    // reports-run is in BILLING_IMPACTING_ENDPOINTS (Claude summary).
    const rl = await checkAndIncrementRateLimit('reports-run', propertyId);
    if (!rl.allowed) {
      return err('Too many report runs. Try again shortly.', {
        requestId,
        status: 429,
        code: 'rate_limited',
        headers: { 'Retry-After': String(rl.retryAfterSec) },
      });
    }

    const result = await def.run(ctx);

    const wantSummary = req.nextUrl.searchParams.get('summary') === '1';
    const aiSummary = wantSummary ? await generateReportSummary(def, result, lang) : null;

    return ok(
      {
        key: def.key,
        title: def.title,
        description: def.description,
        category: def.category,
        columns: result.columns,
        rows: result.rows,
        stats: result.stats ?? [],
        notes: result.notes ?? null,
        aiSummary,
      },
      { requestId },
    );
  } catch (e) {
    log.error('reports run failed', { requestId, error: e instanceof Error ? e.message : String(e) });
    return err('Failed to run report.', { requestId, status: 500, code: 'internal_error' });
  }
}
