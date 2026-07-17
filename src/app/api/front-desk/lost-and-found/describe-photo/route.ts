/**
 * POST /api/front-desk/lost-and-found/describe-photo
 *
 * Claude Vision auto-describe for a found-item photo: returns
 * { description, category, color } the desk can accept or edit before logging.
 * Mirrors /api/inventory/photo-count: pre-flight $ budget, record actual spend
 * (even on error paths), structured error codes, never leaks model output.
 *
 * The gate → image checks → budget → error mapping → cost-ledger `finally` are
 * shared with packages/scan-label via runFrontDeskVisionRoute; this file
 * supplies only the five things that differ (gate, endpoint, extractor,
 * schema-error code, log label).
 */

import type { NextRequest } from 'next/server';
import { runFrontDeskVisionRoute, type FrontDeskVisionBody } from '@/lib/front-desk/vision-route';
import { describeFoundItemPhoto } from '@/lib/lost-and-found/describe';
import { gateFrontDeskWrite } from '@/lib/lost-and-found/api-gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: NextRequest): Promise<Response> {
  return runFrontDeskVisionRoute<FrontDeskVisionBody, Awaited<ReturnType<typeof describeFoundItemPhoto>>>(req, {
    gate: (r, endpoint) => gateFrontDeskWrite<FrontDeskVisionBody>(r, endpoint),
    endpoint: 'lost-found-describe-photo',
    extract: describeFoundItemPhoto,
    schemaErrCode: 'describe_invalid_shape',
    label: 'lost-found describe-photo',
  });
}
