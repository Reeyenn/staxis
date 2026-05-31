/**
 * GET /api/settings/reports/export
 *
 * Runs a catalog report and returns it as a downloadable CSV or Excel file.
 * Same gate + scoping as /run. Rate-limited on the RAW property id.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { err } from '@/lib/api-response';
import { checkAndIncrementRateLimit } from '@/lib/api-ratelimit';
import { validateEnum } from '@/lib/api-validate';
import { renderReportExport, type ExportFormat } from '@/lib/reports/catalog/export';
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

    const fmtV = validateEnum(req.nextUrl.searchParams.get('format') ?? 'csv', ['csv', 'xlsx'] as const, 'format');
    const format = ((fmtV.value ?? 'csv')) as ExportFormat;

    const rl = await checkAndIncrementRateLimit('reports-export', propertyId);
    if (!rl.allowed) {
      return err('Too many exports. Try again shortly.', {
        requestId,
        status: 429,
        code: 'rate_limited',
        headers: { 'Retry-After': String(rl.retryAfterSec) },
      });
    }

    const result = await def.run(ctx);
    const payload = renderReportExport(format, def.key, result.columns, result.rows, lang);

    const headers = new Headers({
      'Content-Type': payload.contentType,
      'Content-Disposition': `attachment; filename="${payload.filename}"`,
      'X-Request-Id': requestId,
      'X-Row-Count': String(result.rows.length),
    });

    let body: BodyInit;
    if (typeof payload.body === 'string') {
      body = payload.body;
    } else {
      const copy = new Uint8Array(payload.body.length);
      copy.set(payload.body);
      body = new Blob([copy], { type: payload.contentType });
    }
    return new Response(body, { status: 200, headers }) as unknown as NextResponse;
  } catch (e) {
    log.error('reports export failed', { requestId, error: e instanceof Error ? e.message : String(e) });
    return err('Failed to export report.', { requestId, status: 500, code: 'internal_error' });
  }
}
