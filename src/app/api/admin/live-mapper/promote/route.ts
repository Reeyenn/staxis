/**
 * POST /api/admin/live-mapper/promote
 *   body: { id, expectedVersion, expectedStatus }
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
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { validateUuid } from '@/lib/api-validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// A quarantined map is known-bad; promoting it must be a deliberate, separate
// action (matches the worker's `.in(['draft','deprecated'])` guard).
const PROMOTABLE = new Set(['draft', 'deprecated']);

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  let body: { id?: unknown; expectedVersion?: unknown; expectedStatus?: unknown };
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
  const id = idCheck.value;

  if (typeof body.expectedVersion !== 'number' || !Number.isInteger(body.expectedVersion)) {
    return err('expectedVersion is required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  if (typeof body.expectedStatus !== 'string') {
    return err('expectedStatus is required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const expectedVersion = body.expectedVersion;
  const expectedStatus = body.expectedStatus;

  // ── 1. Pre-check the target BEFORE mutating anything. ──────────────────
  const { data: target, error: readErr } = await supabaseAdmin
    .from('pms_knowledge_files')
    .select('id, pms_family, version, status')
    .eq('id', id)
    .maybeSingle();

  if (readErr) {
    return err(`Could not read map: ${readErr.message}`, {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
  if (!target) {
    return err('Map not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }
  // Stale-UI / wrong-id guard: the row must still be exactly what the admin saw
  // and confirmed in the dialog.
  if (target.version !== expectedVersion || target.status !== expectedStatus) {
    return err('This map changed since you opened it. Refresh and try again.', {
      requestId, status: 409, code: ApiErrorCode.ValidationFailed,
    });
  }
  if (target.status === 'active') {
    return err('That map is already live.', {
      requestId, status: 409, code: ApiErrorCode.ValidationFailed,
    });
  }
  if (!PROMOTABLE.has(target.status as string)) {
    return err(
      `A ${target.status} map can't be made live directly. Only draft or retired maps can be promoted.`,
      { requestId, status: 409, code: ApiErrorCode.ValidationFailed },
    );
  }

  const family = target.pms_family as string;
  const nowIso = new Date().toISOString();

  // ── 2. Demote the family's current active → deprecated, capturing it so a
  //     failed promote can roll it back. At most one active per family
  //     (partial unique index), so maybeSingle is safe; null = none. ──────
  const { data: previousActive, error: demoteErr } = await supabaseAdmin
    .from('pms_knowledge_files')
    .update({ status: 'deprecated', deprecated_at: nowIso })
    .eq('pms_family', family)
    .eq('status', 'active')
    .select('id, promoted_to_active_at')
    .maybeSingle();

  if (demoteErr) {
    return err(`Could not deactivate the current live map: ${demoteErr.message}`, {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }

  // ── 3. Activate the target. Guarded on status so a concurrent change can't
  //     double-promote; .select() confirms a row actually flipped. ────────
  // Guard the write on the EXACT status the admin confirmed (not just "any
  // promotable status") so the freshness check is atomic with the write — if
  // the row changed at all since the pre-check read, this matches 0 rows and
  // we fall into the rollback path below.
  const { data: promoted, error: promoteErr } = await supabaseAdmin
    .from('pms_knowledge_files')
    .update({ status: 'active', promoted_to_active_at: nowIso })
    .eq('id', id)
    .eq('status', expectedStatus)
    .select('id, pms_family, version, status, promoted_to_active_at')
    .maybeSingle();

  if (promoteErr || !promoted) {
    // Promote failed after we demoted the old active (target deleted/changed
    // concurrently, or a transient DB error). Roll the previous active back so
    // the family is never left with zero live maps.
    if (previousActive) {
      const { error: rollbackErr } = await supabaseAdmin
        .from('pms_knowledge_files')
        .update({
          status: 'active',
          promoted_to_active_at: previousActive.promoted_to_active_at ?? nowIso,
          deprecated_at: null,
        })
        .eq('id', previousActive.id);
      if (rollbackErr) {
        log.error('live-mapper: promote failed AND rollback failed — family has NO live map', {
          requestId, id, family, promoteErr: promoteErr?.message ?? 'no row matched', rollbackErr: rollbackErr.message,
        });
        return err('Could not switch the live map and could not restore the previous one. Open the Live Mapper and check this brand.', {
          requestId, status: 500, code: ApiErrorCode.InternalError,
        });
      }
      log.warn('live-mapper: promote failed — restored previous live map', {
        requestId, id, family, restored: previousActive.id, reason: promoteErr?.message ?? 'target row no longer promotable',
      });
      return err('Could not switch to that map — the previous live map was kept. Refresh and try again.', {
        requestId, status: 409, code: ApiErrorCode.ValidationFailed,
      });
    }
    // No previous active existed (family had none), so nothing was stranded.
    log.error('live-mapper: promote matched no row (no previous active to restore)', {
      requestId, id, family, promoteErr: promoteErr?.message ?? null,
    });
    return err('The map changed before it could be promoted. Refresh and try again.', {
      requestId, status: 409, code: ApiErrorCode.ValidationFailed,
    });
  }

  log.info('live-mapper: promoted to active', {
    requestId, id, family, version: promoted.version,
    demoted: previousActive?.id ?? null, promotedBy: auth.email ?? auth.userId,
  });

  return ok({ map: promoted }, { requestId });
}
