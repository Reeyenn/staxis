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
// SHARED artifact contract — promote and the feed-sample reader MUST agree on
// both the artifact filename (sanitizeFeedKey) and what counts as a PROVEN
// sample (sampleIndicatesSuccess: ok !== false), or Make-live could disable a
// feed the "Captured" panel shows as previewed (feed-sample-key.ts).
import { sanitizeFeedKey, sampleIndicatesSuccess } from '@/lib/pms/feed-sample-key';

export interface PromotedMap {
  id: string;
  pms_family: string;
  version: number;
  status: string;
  promoted_to_active_at: string | null;
}

export type PromoteMapResult =
  | {
      ok: true;
      map: PromotedMap;
      revivedSessions: number;
      /**
       * Action keys that were gated OFF at Make-live because they had no proven
       * preview capture (empty when no gating ran, or every feed was proven).
       * Written into pms_knowledge_files.disabled_feeds on the SAME activate.
       */
      disabledFeeds: string[];
      /**
       * True when gating ran and EVERY mapped feed was disabled (no feed had a
       * preview). The map still promotes — feeds can be lit up one-by-one via
       * Re-read later — but the caller may want to toast this loudly.
       */
      allFeedsDisabled: boolean;
    }
  | { ok: false; status: number; code: ApiErrorCodeValue; message: string };

export async function promoteMap(args: {
  id: string;
  expectedVersion: number;
  expectedStatus: string;
  /** Allow promoting a 'quarantined' draft (Learning Board Save only). */
  allowQuarantined?: boolean;
  /** For the audit log line only. */
  promotedBy?: string | null;
  /**
   * Per-feed collection gate (feature/coverage-gated-feeds). When present AND
   * the target is a 'draft', we look up the property's preview artifacts and
   * DISABLE every mapped feed that has no `live/{propertyId}/{feed}.sample.json`
   * — the founder's rule: only feeds proven readable go live; the rest stay off
   * until a later successful Re-read re-enables them. Only draft promotions are
   * gated: a deprecated-rollback re-lights a map that was ALREADY vetted live,
   * so its disabled_feeds column is left exactly as-is.
   */
  gateByPropertyCaptures?: { propertyId: string };
}): Promise<PromoteMapResult> {
  const { id, expectedVersion, expectedStatus, allowQuarantined } = args;
  const PROMOTABLE = new Set(
    allowQuarantined ? ['draft', 'deprecated', 'quarantined'] : ['draft', 'deprecated'],
  );

  // ── 1. Pre-check the target BEFORE mutating anything. ──────────────────
  // `knowledge` is only needed to derive the gated feed set below; it's cheap
  // to over-select here vs. a second round-trip after the status is confirmed.
  const { data: target, error: readErr } = await supabaseAdmin
    .from('pms_knowledge_files')
    .select('id, pms_family, version, status, signature, knowledge')
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

  // ── 1b. Per-feed collection gate (feature/coverage-gated-feeds). ───────
  // Only when the caller asked to gate AND we're promoting a DRAFT (a
  // rollback re-lights an already-vetted map — leave its column untouched).
  // We derive the map's mapped feeds from knowledge.actions and list the
  // property's preview artifacts ONCE; feeds WITHOUT a proven sample get
  // disabled. `gatedFeeds === null` is the sentinel for "gating did not run" —
  // it means the activate update must NOT touch disabled_feeds at all.
  let gatedFeeds: string[] | null = null;
  if (args.gateByPropertyCaptures?.propertyId && target.status === 'draft') {
    gatedFeeds = await computeDisabledFeeds(
      target.knowledge,
      args.gateByPropertyCaptures.propertyId,
      family,
      id,
    );
  }

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
  // When gating ran, disabled_feeds is written in the SAME update that flips
  // status → active, so the row can never be live for a beat with a stale gate.
  // When it did NOT run (no propertyId / rollback), the column is omitted from
  // the patch and stays exactly as it was.
  const activatePatch: Record<string, unknown> = { status: 'active', promoted_to_active_at: nowIso };
  if (gatedFeeds !== null) activatePatch.disabled_feeds = gatedFeeds;
  const { data: promoted, error: promoteErr } = await supabaseAdmin
    .from('pms_knowledge_files')
    .update(activatePatch)
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

  const disabledFeeds = gatedFeeds ?? [];
  return {
    ok: true,
    map: promoted as PromotedMap,
    revivedSessions: (revived ?? []).length,
    disabledFeeds,
    // "Every mapped feed disabled" only makes sense when gating actually ran and
    // the map had feeds to gate — otherwise it's just an empty (un-gated) map.
    allFeedsDisabled: gatedFeeds !== null && gatedFeeds.length > 0 && gatedFeeds.length === feedKeysOf(target.knowledge).length,
  };
}

/**
 * feedKeysOf — the action keys a knowledge envelope maps (Object.keys of
 * knowledge.actions). Empty for a legacy/empty/garbage envelope. Kept tiny and
 * defensive so a malformed draft can never throw during promote.
 */
function feedKeysOf(knowledge: unknown): string[] {
  if (!knowledge || typeof knowledge !== 'object') return [];
  const actions = (knowledge as { actions?: unknown }).actions;
  if (!actions || typeof actions !== 'object' || Array.isArray(actions)) return [];
  return Object.keys(actions as Record<string, unknown>);
}

/**
 * computeDisabledFeeds — which of a draft's mapped feeds have NO proven preview
 * capture, and so must be gated OFF at Make-live.
 *
 * Two steps, mirroring exactly what the "Captured" panel shows:
 *   1. List the property's preview artifacts ONCE (`live/{propertyId}/` in the
 *      private mapping-screenshots bucket). A mapped key with NO
 *      `{sanitizedKey}.sample.json` at all → disabled.
 *   2. Artifact EXISTENCE is not proof — the worker writes a sample even for a
 *      partially-failed read (a "see what went wrong" preview) and stamps
 *      `ok: boolean` into it. So each candidate sample that DOES exist is
 *      downloaded (≤ ~15 tiny JSON files, in parallel) and counts as proven
 *      only per the shared rule `sampleIndicatesSuccess` (parsed.ok !== false;
 *      a legacy artifact without the flag is grandfathered as proven).
 *
 * FAIL OPEN, at both granularities: if the prefix LIST errors, we log a warning
 * and return [] — promote with disabled_feeds untouched-toward-empty; if an
 * individual DOWNLOAD/parse errors, that feed counts as proven. Collecting
 * everything for a moment beats blocking the founder's go-live on a transient
 * storage blip; the next Re-read reconciles individual feeds anyway. (An empty
 * draft with zero mapped feeds also returns [] — nothing to gate.)
 */
async function computeDisabledFeeds(
  knowledge: unknown,
  propertyId: string,
  family: string,
  mapId: string,
): Promise<string[]> {
  const feedKeys = feedKeysOf(knowledge);
  if (feedKeys.length === 0) return []; // nothing mapped → nothing to gate.

  // List the property's preview prefix once. `limit` is bumped past the default
  // 100 because a map can carry a few hundred feeds; a property realistically
  // has ~dozen sample.json files, but we ask for headroom so pagination can
  // never silently drop an artifact and disable a feed that IS proven.
  const { data: entries, error } = await supabaseAdmin.storage
    .from('mapping-screenshots')
    .list(`live/${propertyId}`, { limit: 1000 });

  if (error || !entries) {
    // FAIL OPEN — see the doc comment. Collecting everything > blocking go-live.
    log.warn('promoteMap: could not list preview artifacts — promoting WITHOUT gating (fail-open)', {
      mapId, family, propertyId, err: error?.message ?? 'no entries returned',
    });
    return [];
  }

  // Sanitized keys that HAVE a sample artifact (strip the ".sample.json"
  // suffix). Existence is only the FIRST hurdle — see step 2 below.
  const existingKeys = new Set<string>();
  for (const e of entries) {
    const name = e?.name ?? '';
    if (name.endsWith('.sample.json')) existingKeys.add(name.slice(0, -'.sample.json'.length));
  }

  // Step 2 — download ONLY the samples that exist for a mapped key and check
  // the extraction-success flag. Parallel; each file is a few KB.
  const proven = new Map<string, boolean>();
  await Promise.all(feedKeys.map(async (k) => {
    const sanitized = sanitizeFeedKey(k);
    if (!existingKeys.has(sanitized)) { proven.set(k, false); return; }
    proven.set(k, await sampleProvesFeed(propertyId, sanitized, { mapId, family }));
  }));

  const disabled = feedKeys.filter((k) => proven.get(k) !== true);
  if (disabled.length > 0) {
    log.info('promoteMap: gating feeds with no proven preview', {
      mapId, family, propertyId, disabled, proven: feedKeys.length - disabled.length,
    });
  }
  return disabled;
}

/**
 * sampleProvesFeed — download one existing sample.json and apply the shared
 * proven rule (sampleIndicatesSuccess: parsed.ok !== false, absent flag →
 * grandfathered proven). Any download/parse failure → TRUE (per-feed fail
 * open, consistent with the gate's overall fail-open stance).
 */
async function sampleProvesFeed(
  propertyId: string,
  sanitizedKey: string,
  ctx: { mapId: string; family: string },
): Promise<boolean> {
  try {
    const { data: blob, error } = await supabaseAdmin.storage
      .from('mapping-screenshots')
      .download(`live/${propertyId}/${sanitizedKey}.sample.json`);
    if (error || !blob) {
      log.warn('promoteMap: sample download failed — counting feed as proven (fail-open)', {
        ...ctx, propertyId, sanitizedKey, err: error?.message ?? 'no blob',
      });
      return true;
    }
    return sampleIndicatesSuccess(JSON.parse(await blob.text()));
  } catch {
    return true; // unparseable/transient → fail open for this feed.
  }
}
