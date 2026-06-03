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
import type { Recipe, WriteActionRecipe } from './types.js';

const WRITE_MUTEX_TIMEOUT_MS = 120_000;

interface HandlerResult {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
}

export async function writeJobHandler(ctx: WorkflowContext): Promise<HandlerResult> {
  // 0. Global kill switch — halts ALL writes regardless of per-property flags.
  if (env.CUA_WRITES_KILL_SWITCH === 'true') {
    log.warn('write-job-handler: refused — global kill switch on', { propertyId: ctx.propertyId });
    return { ok: false, error: 'writes_killed' };
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
  const verify = verifyRecipe(
    recipe as unknown as Recipe,
    decodeBytea(rec.signature),
    typeof rec.signed_with_key_id === 'string' ? rec.signed_with_key_id : null,
  );
  if (!verify.ok) {
    log.error('write-job-handler: write recipe failed signature verification — refusing (fail closed)', {
      propertyId: ctx.propertyId, pmsFamily, actionKey, reason: verify.reason,
    });
    return { ok: false, error: `write_recipe_unverified:${verify.reason}` };
  }

  // 3a. Provenance gate. A recipe validated only against the MOCK PMS
  //     (verified_against='mock', the column default) or one learned 'path_only'
  //     would replay byte-for-byte against the LIVE PMS — wrong-room risk. A
  //     live write REQUIRES a recipe that was verified against a real practice
  //     room. The ONLY escape hatch is an explicit test/loopback signal on the
  //     job payload (allow_loopback), which the real enqueue path never sets, so
  //     production writes are gated unconditionally.
  const verifiedAgainst =
    typeof rec.verified_against === 'string' ? rec.verified_against : 'mock';
  const allowLoopback = payload.allow_loopback === true || payload.dry_run === true;
  if (verifiedAgainst !== 'practice_room' && !allowLoopback) {
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

  // 6. Drive the write under the EXCLUSIVE browser mutex (serializes against
  //    the 30s reader on the one Page). The workflow-runtime has already
  //    acquired the driver's browser lock (pausing new reads); runExclusive
  //    additionally waits out any read already in flight.
  const page = ctx.page;
  if (!page) return { ok: false, error: 'no_page' };
  let allowedHost: string;
  try {
    allowedHost = new URL(recipe.pageUrl).host;
  } catch {
    return { ok: false, error: 'bad_recipe_page_url' };
  }

  const result = await runExclusive(ctx.propertyId, WRITE_MUTEX_TIMEOUT_MS, (signal) =>
    executeWriteRecipe(page, recipe, writePayload, { dryRun: false, allowedHost, signal }),
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
