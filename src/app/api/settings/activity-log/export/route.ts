/**
 * GET /api/settings/activity-log/export?format=csv|xlsx|pdf&…
 *
 * Streams the filtered activity log as a downloadable file. Same
 * filters as the list endpoint. Caps the result at EXPORT_MAX_ROWS so
 * a deeply zoomed-out filter can't OOM the lambda; truncated exports
 * include a trailing notice in the file.
 *
 * Auth: requireSession via verifyTeamManager — admin / owner / GM only.
 * Rate limit: settings-activity-log-export (30/hr per pid:userId) so a
 *             curious user re-clicking "Export" doesn't hammer the
 *             timeline query.
 */

import type { NextRequest, NextResponse } from 'next/server';
import { err } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { checkAndIncrementRateLimit, hashToRateLimitKey } from '@/lib/api-ratelimit';
import { queryActivityLog } from '@/lib/activity-log/query';
import {
  EXPORT_MAX_ROWS,
  renderCsv,
  renderPdf,
  renderXlsx,
  type ExportFormat,
} from '@/lib/activity-log/export';
import { gateActivityLogAccess, parseActivityFilters } from '@/lib/activity-log/route-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

function parseFormat(s: string | null): ExportFormat {
  switch ((s ?? 'csv').toLowerCase()) {
    case 'xlsx':
    case 'xls':
    case 'excel':
      return 'xlsx';
    case 'pdf':
      return 'pdf';
    default:
      return 'csv';
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = getOrMintRequestId(req);
  try {
    const parsed = parseActivityFilters(req.nextUrl.searchParams);
    if (!parsed.ok) {
      return err(parsed.error, { requestId, status: 400, code: 'validation_failed' });
    }
    const filters = { ...parsed.filters, page: 1 };
    const format = parseFormat(req.nextUrl.searchParams.get('format'));

    const gate = await gateActivityLogAccess(req, filters.propertyId);
    if (!gate.ok) {
      return err(gate.error, { requestId, status: gate.status, code: gate.code });
    }

    // Rate limit keyed on (propertyId, userId). hashToRateLimitKey
    // composes them safely into the UUID-shape api_limits expects.
    const rlKey = hashToRateLimitKey(`${filters.propertyId}:${gate.caller.authUserId}`);
    const rl = await checkAndIncrementRateLimit('settings-activity-log-export', rlKey);
    if (!rl.allowed) {
      return err('Export rate limit reached. Try again later.', {
        requestId,
        status: 429,
        code: 'rate_limited',
        headers: { 'Retry-After': String(rl.retryAfterSec) },
      });
    }

    const result = await queryActivityLog(filters, { maxRows: EXPORT_MAX_ROWS });
    const truncated = result.total > result.rows.length;
    const payload = format === 'pdf'
      ? renderPdf(result.rows, truncated)
      : format === 'xlsx'
        ? renderXlsx(result.rows, truncated)
        : renderCsv(result.rows, truncated);

    const headers = new Headers({
      'Content-Type': payload.contentType,
      'Content-Disposition': `attachment; filename="${payload.filename}"`,
      'X-Request-Id': requestId,
      'X-Total-Rows': String(result.total),
      'X-Returned-Rows': String(result.rows.length),
    });
    // Convert binary payloads into a plain ArrayBuffer-backed Uint8Array
    // so the BodyInit type is happy. The pattern (`new Uint8Array(n)` +
    // `.set(buf)`) gives us an ArrayBuffer-backed view that matches
    // BlobPart's ArrayBufferView<ArrayBuffer>.
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
    log.error('activity-log export failed', { requestId, error: errToString(e) });
    return err('Failed to export activity log.', { requestId, status: 500, code: 'internal_error' });
  }
}
