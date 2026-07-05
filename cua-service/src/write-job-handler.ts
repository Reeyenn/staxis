/**
 * Write-job handler (Phase 3.2) — the worker side of PMS write-back.
 * Registered for workflow kind 'pms.write'. For each job it:
 *   0. honours the global kill switch
 *   1. checks the per-property gate (pms_writeback_enabled + action enabled)
 *   2. resolves the PMS family
 *   3. loads the ACTIVE signed write recipe and FAIL-CLOSED verifies it
 *   4. re-checks most-recent-wins (skip if a newer real change superseded us)
 *   5. drives the write under the exclusive browser mutex + verifies it landed
 *   6. records the confirmed value (source='workflow') + an echo stamp
 *
 * Deterministic Playwright only — NO Claude. Fail-closed throughout.
 */
import type { WorkflowContext } from './workflow-runtime.js';
import { supabase } from './supabase.js';
import { log } from './log.js';
import { env } from './env.js';
import { runExclusive } from './single-flight.js';
import { executeWriteRecipe } from './write-runner.js';
import { verifyRecipe } from './recipe-signing.js';
import { decodeBytea } from './knowledge-file.js';
import { rehostFeedUrl, resolveAllowedHost } from './session-driver.js';
import type { Recipe, WriteActionRecipe } from './types.js';

const WRITE_MUTEX_TIMEOUT_MS = 120_000;

/** Origin (scheme://host[:port]) of a URL, or null if unparseable. */
function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

interface HandlerResult {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
  /** TRANSIENT non-counting deferral — see the session pre-flight gate and
   *  workflow-runtime's markDeferred. NOT a failure: the runtime re-queues
   *  without burning an attempt so the write drains once the session resumes. */
  defer?: boolean;
}

/**
 * Session statuses that are a TRANSIENT pause with a live browser that WILL
 * come back (cost cap clears at midnight, MFA on operator action, `starting`
 * settles within seconds). A pms.write claimed during one of these must DEFER
 * (non-counting re-queue), not terminal-fail on its single attempt — otherwise
 * every write made while a hotel is paused is permanently dropped. Any OTHER
 * non-'alive' status (e.g. stopped / failed_restart) is NOT a transient pause;
 * it fails as before rather than deferring forever.
 */
const DEFERRABLE_SESSION_STATUSES = new Set<string>([
  'paused_cost_cap',
  'paused_mfa',
  'starting',
]);

export async function writeJobHandler(ctx: WorkflowContext): Promise<HandlerResult> {
  // 0. Global kill switch — halts ALL writes regardless of per-property flags.
  if (env.CUA_WRITES_KILL_SWITCH === 'true') {
    log.warn('write-job-handler: refused — global kill switch on', { propertyId: ctx.propertyId });
    return { ok: false, error: 'writes_killed' };
  }

  // 0a. Session pre-flight gate. A cost-cap-paused / MFA-paused / starting
  //     hotel has no usable logged-in browser YET, so driving a real PMS write
  //     would fail on an expired session. Bail BEFORE any browser action.
  //     For a TRANSIENT pause (DEFERRABLE_SESSION_STATUSES) return defer:true —
  //     the runtime re-queues WITHOUT consuming an attempt (markDeferred), so
  //     the write drains once the session resumes (cost cap clears at midnight,
  //     MFA on /admin/mfa-resume). pms.write is max_attempts=1, so the old
  //     "transient error + rely on retry budget" contract silently dropped
  //     every write made during a pause; defer:true is the real fix. Any other
  //     non-'alive' status (stopped / failed_restart) is not a self-resolving
  //     pause and fails normally.
  const { data: sess, error: sessErr } = await supabase
    .from('property_sessions')
    .select('status')
    .eq('property_id', ctx.propertyId)
    .maybeSingle();
  if (sessErr) return { ok: false, error: `session_read_failed: ${sessErr.message}` };
  const sessionStatus = typeof sess?.status === 'string' ? sess.status : 'unknown';
  if (sessionStatus !== 'alive') {
    if (DEFERRABLE_SESSION_STATUSES.has(sessionStatus)) {
      log.warn('write-job-handler: deferring — session paused (non-counting re-queue)', {
        propertyId: ctx.propertyId, sessionStatus,
      });
      return { ok: false, defer: true, error: `session_paused:${sessionStatus}` };
    }
    log.warn('write-job-handler: session not alive and not a transient pause — failing', {
      propertyId: ctx.propertyId, sessionStatus,
    });
    return { ok: false, error: `session_not_alive:${sessionStatus}` };
  }

  const payload = ctx.payload as Record<string, unknown>;
  const actionKey = typeof payload.action_key === 'string' ? payload.action_key : '';
  const roomNumber = typeof payload.room_number === 'string' ? payload.room_number : '';
  const originLogId = typeof payload.origin_log_id === 'string' ? payload.origin_log_id : '';
  if (!actionKey || !roomNumber || !originLogId) {
    return { ok: false, error: 'bad_payload' };
  }

  // 1. Per-property gate.
  const { data: prop, error: propErr } = await supabase
    .from('properties')
    .select('pms_writeback_enabled, pms_writeback_actions')
    .eq('id', ctx.propertyId)
    .maybeSingle();
  if (propErr) return { ok: false, error: `property_read_failed: ${propErr.message}` };
  const actions = (prop?.pms_writeback_actions as string[] | null) ?? [];
  if (!prop?.pms_writeback_enabled || !actions.includes(actionKey)) {
    return { ok: false, error: 'writeback_disabled' };
  }

  // 2. PMS family (keyed the same as the session driver / scraper_credentials).
  const { data: cred } = await supabase
    .from('scraper_credentials')
    .select('pms_type')
    .eq('property_id', ctx.propertyId)
    .maybeSingle();
  const pmsFamily = typeof cred?.pms_type === 'string' ? cred.pms_type : null;
  if (!pmsFamily) return { ok: false, error: 'no_pms_family' };

  // 2a. THIS property's per-hotel login URL (scraper_credentials_decrypted,
  //     the same source the session driver logs in at). Family-shared write
  //     recipes bake ONE learn-time pageUrl; for a per-subdomain cloud PMS
  //     that URL points at the MAPPER hotel's tenant, so replaying it verbatim
  //     could write into the WRONG hotel's PMS. We re-host recipe.pageUrl onto
  //     this hotel's origin below (step 6). NULL for a single-host PMS like
  //     Choice Advantage (no per-hotel URL) → re-host is a no-op there.
  const { data: credUrl } = await supabase
    .from('scraper_credentials_decrypted')
    .select('ca_login_url')
    .eq('property_id', ctx.propertyId)
    .eq('is_active', true)
    .maybeSingle();
  const perHotelLoginUrl = typeof credUrl?.ca_login_url === 'string' ? credUrl.ca_login_url : null;

  // 3. Load the active write recipe + FAIL-CLOSED signature verify. Writes are
  //    higher-risk than reads, so refuse an unsigned/unverified recipe
  //    UNCONDITIONALLY, regardless of RECIPE_SIGNING_ENFORCE (Codex P0-2).
  const { data: rec } = await supabase
    .from('pms_writeback_recipes')
    .select('recipe, signature, signed_with_key_id, version, verified_against')
    .eq('pms_family', pmsFamily)
    .eq('action_key', actionKey)
    .eq('status', 'active')
    .maybeSingle();
  if (!rec) return { ok: false, error: 'no_active_write_recipe' };
  const recipe = rec.recipe as WriteActionRecipe;

  // 3-pre. Param-contract assert. The job-side write payload only plumbs these
  //   four keys into the recipe replay (see step 5: target_status/room_number/
  //   action_key/origin_log_id). A recipe authored referencing any OTHER param
  //   name ($payload.foo) would resolve to undefined and fail closed mid-replay
  //   on an occupied room. Reject it up front, BEFORE any browser action.
  const PLUMBED_PARAMS = ['target_status', 'room_number', 'action_key', 'origin_log_id'];
  const requiredParams = Array.isArray(recipe.requiredParams) ? recipe.requiredParams : [];
  const unplumbed = requiredParams.find((p) => !PLUMBED_PARAMS.includes(p));
  if (unplumbed) {
    log.error('write-job-handler: recipe requires an unplumbed param — refusing (fail closed)', {
      propertyId: ctx.propertyId, pmsFamily, actionKey, unplumbed,
    });
    return { ok: false, error: `recipe_param_unplumbed:${unplumbed}` };
  }

  // The provenance/routing columns the safety gates key on. In v1 the HMAC
  //   covered ONLY the recipe body, so a service-role attacker could flip
  //   verified_against ('mock'→'practice_room') or transplant a signed recipe
  //   onto another action_key row WITHOUT breaking the signature. v2 folds these
  //   three columns into the signed payload, so any such tamper now fails
  //   verification. The WRITE path REQUIRES v2 (below); the READ path keeps the
  //   v1 fallback for legacy knowledge-file signatures.
  const verifiedAgainst =
    typeof rec.verified_against === 'string' ? rec.verified_against : 'mock';

  const verify = verifyRecipe(
    recipe as unknown as Recipe,
    decodeBytea(rec.signature),
    typeof rec.signed_with_key_id === 'string' ? rec.signed_with_key_id : null,
    { actionKey, pmsFamily, verifiedAgainst },
  );
  if (!verify.ok) {
    log.error('write-job-handler: write recipe failed signature verification — refusing (fail closed)', {
      propertyId: ctx.propertyId, pmsFamily, actionKey, reason: verify.reason,
    });
    return { ok: false, error: `write_recipe_unverified:${verify.reason}` };
  }
  // WRITE path REQUIRES a v2 (metadata-bound) signature. A v1 signature covers
  // only the recipe body, leaving verified_against/action_key/pms_family
  // tamperable — refuse it here rather than re-open that gap for writes. (The
  // seed/resign script signs write recipes v2; a legacy v1 write row must be
  // re-signed before it can drive a live write.)
  if (verify.version !== 2) {
    log.error('write-job-handler: write recipe signature is v1 (metadata-unbound) — refusing (fail closed)', {
      propertyId: ctx.propertyId, pmsFamily, actionKey, version: verify.version,
    });
    return { ok: false, error: 'write_recipe_v1_signature_rejected' };
  }

  // 3a. Provenance gate. A recipe validated only against the MOCK PMS
  //     (verified_against='mock', the column default) or one learned 'path_only'
  //     would replay byte-for-byte against the LIVE PMS — wrong-room risk. A
  //     live write REQUIRES a recipe that was verified against a real practice
  //     room. The ONLY escape hatch is an explicit test/loopback signal on the
  //     job payload (allow_loopback), which the real enqueue path never sets, so
  //     production writes are gated unconditionally. verified_against is now
  //     cryptographically bound (v2), so a DB flip of the column fails the
  //     verification above before reaching this gate.
  // Two DISTINCT test/rehearsal signals, neither set by the real enqueue path:
  //   - dry_run: rehearse the recipe but DON'T commit (no Save click). Truly
  //     dry (forwarded to the executor below), so it never mutates the PMS and
  //     may waive the practice-room provenance requirement.
  //   - allow_loopback: run against a mock/loopback PMS host (bypasses the
  //     SSRF host guard). Test harness only.
  // The old code lumped dry_run into `allowLoopback`, which WAIVED provenance
  // but then hard-coded dryRun:false at execution — so `dry_run:true` disabled
  // the safety gate AND performed a real, unrehearsed write against the live
  // hotel PMS. Split them and forward each to its real effect.
  const isDryRun = payload.dry_run === true;
  const isLoopback = payload.allow_loopback === true;
  const waiveProvenance = isDryRun || isLoopback;
  if (verifiedAgainst !== 'practice_room' && !waiveProvenance) {
    log.error('write-job-handler: write recipe has insufficient provenance — refusing (fail closed)', {
      propertyId: ctx.propertyId, pmsFamily, actionKey, verifiedAgainst,
    });
    return { ok: false, error: `write_recipe_insufficient_provenance:${verifiedAgainst}` };
  }

  // 3b. valueMap completeness. Every internal status statusToLogValue can emit
  //     must be translatable to a PMS on-screen string before we touch the
  //     browser — either an explicit valueMap entry or a paramEnums value the
  //     write-runner passes through unmapped. Otherwise an occupied-room push
  //     would crash mid-replay; fail closed here instead.
  const REQUIRED_STATUS_VALUES = [
    'occupied_clean', 'occupied_dirty', 'vacant_clean', 'vacant_dirty', 'inspected',
  ];
  const valueMap: Record<string, string> = recipe.valueMap ?? {};
  const paramEnums: Record<string, string[]> = recipe.paramEnums ?? {};
  const enumValues = new Set<string>(Object.values(paramEnums).flat());
  const missingValues = REQUIRED_STATUS_VALUES.filter(
    (s) => !(s in valueMap) && !enumValues.has(s),
  );
  if (missingValues.length > 0) {
    log.error('write-job-handler: write recipe valueMap incomplete — refusing (fail closed)', {
      propertyId: ctx.propertyId, pmsFamily, actionKey, missing: missingValues,
    });
    return { ok: false, error: `recipe_valuemap_incomplete:${missingValues.join(',')}` };
  }

  // 4. Most-recent-wins. Only push if our origin row is still the newest REAL
  //    change for the room. A newer 'manual' or 'cua' row means something
  //    superseded us → cancel (this is success, not failure — the newer change
  //    has its own job). Our own 'workflow' confirmation rows are ignored
  //    (Codex P1-5).
  const { data: latest } = await supabase
    .from('pms_room_status_log')
    .select('id')
    .eq('property_id', ctx.propertyId)
    .eq('room_number', roomNumber)
    .neq('source', 'workflow')
    .order('changed_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latest && latest.id !== originLogId) {
    log.info('write-job-handler: superseded by a newer change — skipping', {
      propertyId: ctx.propertyId, roomNumber, originLogId, latestId: latest.id,
    });
    return { ok: true, result: { skipped: 'superseded' } };
  }

  // 5. Build the (internal-valued) write payload from the job payload.
  const writePayload: Record<string, string> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (typeof v === 'string') writePayload[k] = v;
  }
  const targetStatus = writePayload.target_status;
  if (!targetStatus) return { ok: false, error: 'bad_payload_no_target_status' };

  // 5a. Re-host recipe.pageUrl onto THIS property's tenant origin (wrong-hotel
  //     guard). A family-shared write recipe carries ONE learn-time pageUrl
  //     recorded on the MAPPER hotel's tenant. For a per-subdomain cloud PMS
  //     (OPERA Cloud, Cloudbeds, Mews, RoomKey) every hotel on the family would
  //     otherwise replay that same URL and drive the write into the MAPPER
  //     hotel's PMS — corrupting the wrong hotel. rehostFeedUrl swaps the
  //     recorded origin for this hotel's login-URL origin (the exact logic the
  //     READ path uses for feed URLs); it is a no-op when there is no per-hotel
  //     URL (single-host PMSes) or the origins already match.
  //
  //     FAIL-CLOSED CAVEAT — single-host multi-tenant PMSes (Choice Advantage):
  //     tenancy there is by SESSION/login (the ?ihc= code on the login URL),
  //     not by host, so recipe.pageUrl has no per-hotel origin to re-host to and
  //     the landed-origin guard below can't distinguish hotel A from hotel B on
  //     the shared host. Today that's safe because CA logs in per-property with
  //     a per-hotel robot account, so the shared page shows only THIS hotel's
  //     rooms. But before enabling write-back for a SECOND hotel on any
  //     single-host family, a per-property page-verification marker (assert a
  //     hotel-identifying element/text on the landed page belongs to
  //     ctx.propertyId) must be added — the origin guard alone is not sufficient
  //     there. See `concerns`.
  const { data: kf } = await supabase
    .from('pms_knowledge_files')
    .select('knowledge')
    .eq('pms_family', pmsFamily)
    .eq('status', 'active')
    .is('deleted_at', null)
    .maybeSingle();
  const familyStartUrl =
    typeof (kf?.knowledge as { login?: { startUrl?: string } } | null)?.login?.startUrl === 'string'
      ? (kf!.knowledge as { login: { startUrl: string } }).login.startUrl
      : '';
  const rehostedPageUrl = rehostFeedUrl(recipe.pageUrl, familyStartUrl, perHotelLoginUrl);

  // 6. Drive the write under the EXCLUSIVE browser mutex (serializes against
  //    the 30s reader on the one Page). The workflow-runtime has already
  //    acquired the driver's browser lock (pausing new reads); runExclusive
  //    additionally waits out any read already in flight.
  const page = ctx.page;
  if (!page) return { ok: false, error: 'no_page' };
  // allowedHost + expectedOrigin are derived from the RE-HOSTED url so both
  // safeGoto's navigation pin AND the landed-origin fail-closed check anchor to
  // THIS property's tenant, never the learn-time (mapper) host.
  const allowedHost = resolveAllowedHost(rehostedPageUrl);
  if (!allowedHost) return { ok: false, error: 'bad_recipe_page_url' };
  const expectedOrigin = safeOrigin(rehostedPageUrl);
  if (!expectedOrigin) return { ok: false, error: 'bad_recipe_page_url' };
  // Replay against the re-hosted URL, not the recorded one.
  const perPropertyRecipe: WriteActionRecipe = { ...recipe, pageUrl: rehostedPageUrl };

  const result = await runExclusive(ctx.propertyId, WRITE_MUTEX_TIMEOUT_MS, (signal) =>
    executeWriteRecipe(page, perPropertyRecipe, writePayload, {
      dryRun: isDryRun,
      allowLoopback: isLoopback,
      allowedHost,
      expectedOrigin,
      signal,
    }),
  );

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  // 7. Record the confirmed value as a 'workflow'-source row + stamp the echo
  //    so the reader's next poll doesn't log this same value as a fresh 'cua'
  //    change. Both best-effort: a failure here is an audit gap, not a reason
  //    to fail an already-applied PMS write.
  const nowIso = new Date().toISOString();
  const { error: confErr } = await supabase.from('pms_room_status_log').insert({
    property_id: ctx.propertyId,
    room_number: roomNumber,
    status: targetStatus,
    source: 'workflow',
    changed_at: nowIso,
  });
  if (confErr) {
    log.error('write-job-handler: confirmation row insert failed (PMS write applied OK)', {
      propertyId: ctx.propertyId, roomNumber, msg: confErr.message,
    });
  }
  const { error: echoErr } = await supabase.from('pms_sync_echo').upsert(
    { property_id: ctx.propertyId, room_number: roomNumber, pushed_value: targetStatus, pushed_at: nowIso },
    { onConflict: 'property_id,room_number' },
  );
  if (echoErr) {
    log.warn('write-job-handler: echo stamp failed', { propertyId: ctx.propertyId, roomNumber, msg: echoErr.message });
  }

  return { ok: true, result: { verifiedVia: result.verifiedVia, room_number: roomNumber, target_status: targetStatus } };
}
