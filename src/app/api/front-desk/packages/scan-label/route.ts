/**
 * POST /api/front-desk/packages/scan-label
 *
 * Claude Vision reads a parcel's shipping label and returns
 * { guestName, roomNumber, carrier, trackingNumber } so the desk can pre-fill
 * the log form (the clerk confirms/edits before saving — nothing is stored
 * here). Mirrors lost-and-found/describe-photo: pre-flight $ budget, record
 * actual spend on every path, structured error codes, never leaks model output.
 *
 * The gate → image checks → budget → error mapping → cost-ledger `finally` are
 * shared with lost-and-found/describe-photo via runFrontDeskVisionRoute; this
 * file supplies only the five things that differ (gate, endpoint, extractor,
 * schema-error code, log label).
 */

import type { NextRequest } from 'next/server';
import { runFrontDeskVisionRoute, type FrontDeskVisionBody } from '@/lib/front-desk/vision-route';
import { scanShippingLabel } from '@/lib/packages/scan-label';
import { gatePackagesWrite } from '@/lib/packages/api-gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: NextRequest): Promise<Response> {
  return runFrontDeskVisionRoute<FrontDeskVisionBody, Awaited<ReturnType<typeof scanShippingLabel>>>(req, {
    gate: (r, endpoint) => gatePackagesWrite<FrontDeskVisionBody>(r, endpoint),
    endpoint: 'packages-scan-label',
    extract: scanShippingLabel,
    schemaErrCode: 'scan_invalid_shape',
    label: 'packages scan-label',
  });
}
