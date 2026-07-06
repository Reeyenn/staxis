/**
 * promoteMap — shared "make this knowledge-file the family's single ACTIVE map"
 * primitive, used by BOTH the Manage-maps route (/api/admin/live-mapper/promote)
 * and the Learning Board's Save & Finish (/api/admin/mapper/save-map).
 *
 * Behavior is identical to the original inline logic in the promote route
 * (extracted verbatim) so the two paths can never drift:
 *   - stale-UI guard (echo expectedVersion+expectedStatus, refuse if changed),
 *   - demote the family's current active → deprecated FIRST (partial unique
 *     index pms_knowledge_files_one_active_per_family guarantees ≤1 active),
 *   - activate the target guarded on the exact status,
 *   - NEVER-ZERO-ACTIVE rollback: if the activate matches 0 rows, restore the
 *     previous active so the family is never stranded at zero,
 *   - best-effort revive of property_sessions stuck at paused_no_knowledge_file.
 * Touches ONLY status + promotion timestamps — the `knowledge` jsonb + HMAC
 * signature are never modified (we can't re-sign; RECIPE_SIGNING_KEY is Fly-only).
 *
 * `allowQuarantined` (Learning Board Save only): a quarantined draft is below
 * the partial-promotion bar (near-empty), so the Manage-maps route refuses it.
 * Save & Finish honors "just do what they click" on this greenfield — the board
 * shows the founder exactly what was found beside the button, so activating a
 * sparse map is their explicit, informed choice (the never-zero rollback still
 * protects against a failed promote).
 */

import { supabaseAdmin } from '@/lib/supabase-admin';
import { ApiErrorCode, type ApiErrorCodeValue } from '@/lib/api-response';
import { log } from '@/lib/log';
import { env } from '@/lib/env';

export interface PromotedMap {
  id: string;
  pms_family: string;
  version: number;
  status: string;
  promoted_to_active_at: string | null;
}

export type PromoteMapResult =
  | { ok: true; map: PromotedMap; revivedSessions: number }
  | { ok: false; status: number; code: ApiErrorCodeValue; message: string };

export async function promoteMap(args: {
  id: string;
  expectedVersion: number;
  expectedStatus: string;
  /** Allow promoting a 'quarantined' draft (Learning Board Save only). */
  allowQuarantined?: boolean;
  /** For the audit log line only. */
  promotedBy?: string | null;
}): Promise<PromoteMapResult> {
  const { id, expectedVersion, expectedStatus, allowQuarantined } = args;
  const PROMOTABLE = new Set(
    allowQuarantined ? ['draft', 'deprecated', 'quarantined'] : ['draft', 'deprecated'],
  );

  // ── 1. Pre-check the target BEFORE mutating anything. ──────────────────
  const { data: target, error: readErr } = await supabaseAdmin
    .from('pms_knowledge_files')
    .select('id, pms_family, version, status, signature')
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();

  if (readErr) {
    return { ok: false, status: 500, code: ApiErrorCode.InternalError, message: `Could not read map: ${readErr.message}` };
  }
  if (!target) {
    return { ok: false, status: 404, code: ApiErrorCode.NotFound, message: 'Map not found' };
  }
  // Stale-UI / wrong-id guard.
  if (target.version !== expectedVersion || target.status !== expectedStatus) {
    return { ok: false, status: 409, code: ApiErrorCode.ValidationFailed, message: 'This map changed since you opened it. Refresh and try again.' };
  }

  // ── TAMPER-SEAL guard (fix/cua-draft-resign) ───────────────────────────
  // Every map is HMAC-signed over `knowledge` at learn time and re-signed by the
  // Fly worker on every edit (RECIPE_SIGNING_KEY is Fly-only — the web can never
  // sign). A NULL signature here means the seal is missing: in PROD, mapper
  // drafts are ALWAYS signed (enforce mode is on), so a NULL seal means an
  // out-of-band edit broke it — promoting it would push a map the CUA worker
  // will REFUSE, auto-triggering a fresh ~$25 re-learn. Refuse loudly instead.
  //
  // We only null-check: PostgREST returns bytea as a '\x…' string, and the web
  // has no key to verify the HMAC (and must not try) — a present signature is
  // taken at face value; the worker is the authority that actually verifies it.
  //
  // Escape hatch — PROMOTE_ALLOW_UNSIGNED='1' — for a dev/local environment with
  // no signing configured (so learn produces unsigned drafts). NEVER set in prod.
  const hasSignature = target.signature !== null && target.signature !== undefined;
  const allowUnsigned = env.PROMOTE_ALLOW_UNSIGNED === '1';
  if (!hasSignature && !allowUnsigned) {
    return {
      ok: false, status: 409, code: ApiErrorCode.ValidationFailed,
      message: 'This map is missing its tamper seal — open its editor and re-save it (any small edit re-seals it), then try again.',
    };
  }
  if (target.status === 'active') {
    return { ok: false, status: 409, code: ApiErrorCode.ValidationFailed, message: 'That map is already live.' };
  }
  if (!PROMOTABLE.has(target.status as string)) {
    return {
      ok: false, status: 409, code: ApiErrorCode.ValidationFailed,
      message: `A ${target.status} map can't be made live directly. Only draft or retired maps can be promoted.`,
    };
  }

  const family = target.pms_family as string;
  const nowIso = new Date().toISOString();

  // ── 2. Demote the family's current active → deprecated, capturing it so a
  //     failed promote can roll it back. ─────────────────────────────────
  const { data: previousActive, error: demoteErr } = await supabaseAdmin
    .from('pms_knowledge_files')
    .update({ status: 'deprecated', deprecated_at: nowIso })
    .eq('pms_family', family)
    .eq('status', 'active')
    .select('id, promoted_to_active_at')
    .maybeSingle();

  if (demoteErr) {
    return { ok: false, status: 500, code: ApiErrorCode.InternalError, message: `Could not deactivate the current live map: ${demoteErr.message}` };
  }

  // ── 3. Activate the target, guarded on the EXACT confirmed status. ─────
  const { data: promoted, error: promoteErr } = await supabaseAdmin
    .from('pms_knowledge_files')
    .update({ status: 'active', promoted_to_active_at: nowIso })
    .eq('id', id)
    .eq('status', expectedStatus)
    .select('id, pms_family, version, status, promoted_to_active_at')
    .maybeSingle();

  if (promoteErr || !promoted) {
    // Roll the previous active back so the family is never left with zero.
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
        log.error('promoteMap: promote failed AND rollback failed — family has NO live map', {
          id, family, promoteErr: promoteErr?.message ?? 'no row matched', rollbackErr: rollbackErr.message,
        });
        return { ok: false, status: 500, code: ApiErrorCode.InternalError, message: 'Could not switch the live map and could not restore the previous one. Open the Live Mapper and check this brand.' };
      }
      log.warn('promoteMap: promote failed — restored previous live map', {
        id, family, restored: previousActive.id, reason: promoteErr?.message ?? 'target row no longer promotable',
      });
      return { ok: false, status: 409, code: ApiErrorCode.ValidationFailed, message: 'Could not switch to that map — the previous live map was kept. Refresh and try again.' };
    }
    log.error('promoteMap: promote matched no row (no previous active to restore)', {
      id, family, promoteErr: promoteErr?.message ?? null,
    });
    return { ok: false, status: 409, code: ApiErrorCode.ValidationFailed, message: 'The map changed before it could be promoted. Refresh and try again.' };
  }

  log.info('promoteMap: promoted to active', {
    id, family, version: promoted.version, demoted: previousActive?.id ?? null, promotedBy: args.promotedBy ?? null,
  });

  // ── 4. Revive the robot: sessions parked at paused_no_knowledge_file. ──
  const { data: revived, error: reviveErr } = await supabaseAdmin
    .from('property_sessions')
    .update({ status: 'starting', paused_reason: null, paused_until: null })
    .eq('pms_family', family)
    .eq('status', 'paused_no_knowledge_file')
    .select('property_id');
  if (reviveErr) {
    log.warn('promoteMap: promoted OK but could not revive paused sessions', { family, err: reviveErr.message });
  } else if ((revived ?? []).length > 0) {
    log.info('promoteMap: revived paused_no_knowledge_file sessions', { family, count: (revived ?? []).length });
  }

  return { ok: true, map: promoted as PromotedMap, revivedSessions: (revived ?? []).length };
}
