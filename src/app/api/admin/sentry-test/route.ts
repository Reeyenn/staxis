/**
 * GET /api/admin/sentry-test
 *
 * On-demand verification that the Sentry pipeline is working end-to-end.
 * Calls log.error with a synthetic Error; that path runs through src/lib/log.ts
 * → src/lib/sentry.ts → @sentry/nextjs and ships to staxis.sentry.io.
 *
 * Returns 200 to the caller — we are NOT actually broken. The SOLE purpose
 * is to confirm errors flow into Sentry. Run this after any change that
 * touches sentry.{server,edge,client}.config.ts, instrumentation.ts, or
 * SENTRY_DSN.
 *
 * Auth: CRON_SECRET. Same model as every other admin endpoint. Without it
 * we'd be giving any random visitor a way to fire test errors at our
 * Sentry quota.
 *
 * Verification flow:
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *        https://getstaxis.com/api/admin/sentry-test
 *   # → { "ok": true, "fired": "synthetic-...", "requestId": "..." }
 *
 *   Open https://staxis.sentry.io/issues/?project=4511304385888256
 *   The issue "[sentry-test] synthetic event" appears within ~30s.
 *
 * If the issue does NOT appear, something in the Sentry pipeline is broken:
 *   - SENTRY_DSN env var not set in Vercel
 *   - @sentry/nextjs not installed or wrong version
 *   - sentry.{server,edge,client}.config.ts not loaded
 *   - Network egress blocked (very unusual on Vercel)
 *   - Sentry quota / rate limit hit (check the Sentry billing page)
 */

import { NextRequest } from 'next/server';
import { requireCronSecret } from '@/lib/api-auth';
import { log, getOrMintRequestId } from '@/lib/log';
import { ok } from '@/lib/api-response';
import { recordAppEvent } from '@/lib/event-recorder';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const unauth = requireCronSecret(req);
  if (unauth) return unauth;

  const marker = `synthetic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const syntheticErr = new Error(`[sentry-test] synthetic event ${marker}`);
  // Tag it so it's filterable in Sentry's UI ("Search: tag:test_marker:..."
  // narrows to only the test events you care about).
  log.error('[sentry-test] synthetic event', {
    requestId,
    route: '/api/admin/sentry-test',
    err: syntheticErr,
    test_marker: marker,
  });

  // 2026-05-22 monitoring/logging/secrets hardening — record a probe
  // event so the doctor's sentry_ingest_probe_recent check can flag
  // "no successful probe in the last 7 days". Best-effort; if the
  // insert fails, the test still returned the marker to the caller
  // who can verify Sentry by hand.
  await recordAppEvent({
    property_id: null,
    user_id: null,
    user_role: null,
    event_type: 'sentry_ingest_probe_fired',
    metadata: { marker, requestId },
  }).catch(() => {});

  // Standard ApiResponse envelope. The sentry-test.yml workflow reads
  // `data.fired` to print the marker for searching in Sentry.
  return ok({
    fired: marker,
    note:
      'A synthetic Error was logged. Check staxis.sentry.io within ~30s for an issue matching this marker.',
  }, { requestId });
}
