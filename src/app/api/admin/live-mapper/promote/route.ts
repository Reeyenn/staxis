/**
 * POST /api/admin/live-mapper/promote
 *   body: { id, expectedVersion, expectedStatus, propertyId? }
 *
 * Admin-only. Makes a map the LIVE (active) one for its PMS family. Handles
 * both first-promotion (draft → active) and rollback (a deprecated prior
 * version → active) — they're the same operation.
 *
 * Mirrors cua-service knowledge-file.ts `promoteToActive` / mapping-driver.ts
 * `promoteDraft` so the web path and the worker path stay identical: demote the
 * family's current active → 'deprecated' FIRST, then activate the target. The
 * partial unique index `pms_knowledge_files_one_active_per_family` (migration
 * 0201) hard-guarantees there are never TWO active maps for a family.
 *
 * Never-zero-active hardening (beyond the worker): we
 *   (a) require the caller to echo the version + status they saw, and refuse if
 *       the row changed underneath them (stale UI / wrong id), and
 *   (b) capture the demoted previous-active and ROLL IT BACK if the promote
 *       fails (concurrent delete of the target, transient DB error, …), so a
 *       failed promote leaves the previous map live rather than stranding the
 *       family at zero active.
 * The only residual zero-active windows are transient and self-recovering:
 * (i) a sub-millisecond gap during a SUCCESSFUL promote (between the demote
 * commit and the promote commit), and (ii) on a FAILED promote, the gap between
 * the demote commit and the rollback commit. Both match the worker's own
 * non-atomic promote and are harmless because session-drivers cache the active
 * map on boot and re-reconcile on the next poll. A fully zero-window promote
 * would need a Postgres transaction/RPC (migration) shared with cua-service —
 * deliberately out of scope here.
 *
 * Signing preserved: touches ONLY `status` + promotion timestamps. The
 * `knowledge` jsonb and signature columns are never modified, so the row's HMAC
 * signature (computed over `knowledge` only) stays valid and the robot still
 * accepts it. We can't re-sign here — RECIPE_SIGNING_KEY is a Fly-only secret.
 */

import { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { validateUuid } from '@/lib/api-validate';
import { promoteMap } from '@/lib/pms/promote-map';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  let body: { id?: unknown; expectedVersion?: unknown; expectedStatus?: unknown; propertyId?: unknown };
  try {
    body = await req.json();
  } catch {
    return err('Invalid JSON', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const idCheck = validateUuid(body.id, 'map id');
  if (idCheck.error || !idCheck.value) {
    return err(idCheck.error ?? 'map id is required', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }
  if (typeof body.expectedVersion !== 'number' || !Number.isInteger(body.expectedVersion)) {
    return err('expectedVersion is required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  if (typeof body.expectedStatus !== 'string') {
    return err('expectedStatus is required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  // Optional per-feed collection gate (feature/coverage-gated-feeds). When the
  // Coverage page's Make-live sends the property it's viewing, only feeds with a
  // proven preview capture for THAT property go live; the rest are disabled
  // until a later Re-read turns them on. Absent (e.g. Manage-maps rollback) →
  // no gating, the map's disabled_feeds column is left as-is.
  let gateByPropertyCaptures: { propertyId: string } | undefined;
  if (body.propertyId !== undefined && body.propertyId !== null) {
    const pidCheck = validateUuid(body.propertyId, 'propertyId');
    if (pidCheck.error || !pidCheck.value) {
      return err(pidCheck.error ?? 'propertyId must be a uuid', {
        requestId, status: 400, code: ApiErrorCode.ValidationFailed,
      });
    }
    gateByPropertyCaptures = { propertyId: pidCheck.value };
  }

  // Quarantined maps stay non-promotable here (Manage maps); the deliberate
  // "promote anyway" path is the Learning Board's Save & Finish (save-map).
  const result = await promoteMap({
    id: idCheck.value,
    expectedVersion: body.expectedVersion,
    expectedStatus: body.expectedStatus,
    promotedBy: auth.email ?? auth.userId,
    gateByPropertyCaptures,
  });

  if (!result.ok) {
    return err(result.message, { requestId, status: result.status, code: result.code });
  }
  return ok({
    map: result.map,
    revivedSessions: result.revivedSessions,
    disabledFeeds: result.disabledFeeds,
    allFeedsDisabled: result.allFeedsDisabled,
  }, { requestId });
}
