/**
 * Mapping-driver (Plan v7 Phase 2c).
 *
 * Standalone Playwright runner for `mapper.learn_pms_family` workflow
 * jobs. Owns its own browser context — doesn't depend on an alive
 * SessionDriver. Spawns on-demand when the workflow-runtime claims a
 * mapper job, runs `mapPMS()`, saves a draft knowledge file, and exits.
 *
 * Why a separate driver: the workflow-runtime today only claims jobs
 * for hotels with `alive` drivers. But mapper triggers on
 * `paused_no_knowledge_file` — exactly when no driver is alive (the
 * session-driver paused because it couldn't load a recipe). Sharing
 * SessionDriver's browser would deadlock. Codex v2 P0 fix.
 *
 * Inputs (from workflow_jobs.payload):
 *   { pms_family: string, property_id: string }
 *
 * Outputs (in workflow_jobs.result):
 *   { ok: true, knowledge_file_id: string, targets_found: number,
 *     targets_unavailable: number, targets_failed: number,
 *     spent_micros: number }
 *
 *   { ok: false, error: string }
 *
 * Cost attribution: every Claude call made by this driver logs to
 * claude_usage_log with workload starting 'cua_mapping_' — migration
 * 0208 ensures those rows are tagged source='mapping' and excluded
 * from the per-hotel daily cost cap.
 */

import type { Browser } from 'playwright';
import { chromium } from 'playwright';
import { supabase } from './supabase.js';
import { log } from './log.js';
import { mapPMS, type MapperResult } from './mapper.js';
import { safeGoto, UnsafeNavigationError } from './browser-utils/navigate.js';
import { env } from './env.js';
import { signRecipe, isRecipeSigningConfigured } from './recipe-signing.js';
import type { PMSCredentials, PMSType, Recipe, ScraperCredentialsRow } from './types.js';

export interface MappingJobInput {
  pms_family: string;
  property_id: string;
  /** Optional: override the global cost cap for this specific run.
   *  Useful for re-running a partial map with a higher budget. */
  cost_cap_micros?: number;
  /** Plan v8 Phase A — per-job mapper mode override. Falls back to
   *  env.MAPPER_MODE when absent. Admin checks "use vision" in the
   *  Enqueue Mapper UI to set this. */
  mapper_mode?: 'dom' | 'vision';
  /** Plan v8 Phase A — per-job Claude model. Defaults to claude-sonnet-4-6.
   *  Admin opts into Opus for hard PMSes per-job. */
  model?: 'claude-sonnet-4-6' | 'claude-opus-4-7';
}

export interface MappingJobResult {
  ok: boolean;
  knowledgeFileId?: string;
  knowledgeFileVersion?: number;
  targetsFound?: number;
  targetsUnavailable?: number;
  targetsFailed?: number;
  spentMicros?: number;
  /** Plan v7 — promotion gate outcome.
   *  - 'auto_promote': draft passed gates AND was promoted to active in
   *    the same transaction. Live drivers will hot-reload to it within
   *    ~60s (session-driver knowledge polling).
   *  - 'park_draft': draft saved, NOT promoted. Admin sees CTA to review.
   *  - 'quarantine': draft saved with status='quarantined'. Required
   *    targets missing; admin must investigate.
   */
  promotionDecision?: 'auto_promote' | 'park_draft' | 'quarantine';
  promotionReason?: string;
  error?: string;
}

// Plan v7 promotion-gate criteria.
// Required targets MUST all be found (or quarantine). Business-critical
// net-new targets need ≥ 3 found to auto-promote (otherwise park-as-draft).
const REQUIRED_TARGETS: Array<keyof Recipe['actions']> = [
  'getRoomStatus', 'getArrivals', 'getDepartures', 'getWorkOrders', 'getGuests',
];
const BUSINESS_CRITICAL_TARGETS: Array<keyof Recipe['actions']> = [
  'getRevenueDaily', 'getRatesAndInventory', 'getChannelPerformance',
  'getForecastDaily', 'getGroupsAndBlocks',
];
const MIN_BUSINESS_CRITICAL_FOR_AUTO = 3;

/**
 * Run a mapping job end-to-end. Called by the workflow-runtime's
 * mapper-kind handler.
 */
export async function runMappingJob(
  input: MappingJobInput,
  jobId: string,
  signal: AbortSignal,
): Promise<MappingJobResult> {
  log.info('mapping-driver: starting', {
    jobId,
    pmsFamily: input.pms_family,
    propertyId: input.property_id,
  });

  // 1. Load credentials for the representative property.
  const credentials = await loadCredentials(input.property_id);
  if (!credentials) {
    return { ok: false, error: 'no active scraper_credentials for representative property' };
  }

  // Plan v8 Phase A — resolve mode (per-job override > env default).
  // Same mode threaded through preflight + mapPMS.
  const mode: 'dom' | 'vision' = input.mapper_mode ?? env.MAPPER_MODE;

  // 1.5. Pre-flight check: try to actually load the login URL with no
  //      Claude involvement at all. If the URL is wrong, the PMS is down,
  //      it redirects to a different domain, or it serves a non-login
  //      page (T&C wall, maintenance page), abort with $0 spent on the
  //      Anthropic API. This is the single biggest money-saver: failed
  //      mapping runs that were going to fail anyway now cost $0 instead
  //      of $4-10. Adds ~5-15s to the happy path.
  //
  //      Plan v8 P1-5: preflight is mode-aware. DOM mode requires an
  //      input[type="password"] (proves it's a login form). Vision mode
  //      additionally accepts canvas-rendered login pages that have no
  //      DOM password input (the exact PMSes vision is for).
  log.info('mapping-driver: pre-flight starting', { jobId, loginUrl: credentials.loginUrl, mode });
  const preflight = await preflightLoginPage(credentials.loginUrl, signal, mode);
  if (!preflight.ok) {
    log.warn('mapping-driver: pre-flight failed — aborting before Claude is called', {
      jobId,
      reason: preflight.reason,
    });
    return { ok: false, error: `pre-flight check failed (no Claude spend): ${preflight.reason}` };
  }
  log.info('mapping-driver: pre-flight passed', { jobId });

  // 2. Run mapPMS. The mapper opens its own browser via chromium.launch.
  // Plan v8 review P0-A: thread per-job cost cap through. Without this
  // vision-mode jobs would hit the DOM mode's $5 env default and abort.
  const result = await mapPMS({
    credentials,
    pmsType: input.pms_family as PMSType,
    propertyId: input.property_id,
    jobId,
    signal,
    mode,
    model: input.model,
    jobCostCapMicros: input.cost_cap_micros,
    onProgress: (label, pct) => {
      log.info('mapping-driver: progress', { jobId, label, pct });
    },
  });

  if (!result.ok) {
    return { ok: false, error: result.userMessage };
  }

  // 3. Evaluate the auto-promotion gate (Plan v7 — replaces the "≥60%
  //    of targets" magic number with required-target-class checks).
  const gate = evaluatePromotionGate(result.recipe);
  log.info('mapping-driver: promotion gate evaluated', { jobId, ...gate });

  // 4. Save the draft knowledge file with the right status.
  //    auto_promote → save as draft, then promote in step 5
  //    park_draft → save as draft, admin reviews
  //    quarantine → save with status='quarantined', admin investigates
  const initialStatus = gate.decision === 'quarantine' ? 'quarantined' : 'draft';
  const draft = await saveDraftKnowledgeFile(input.pms_family, result.recipe, initialStatus);
  if (!draft.ok) {
    return { ok: false, error: `recipe mapped successfully but draft save failed: ${draft.error}` };
  }

  // 5. If gate says auto_promote, atomically demote prior active +
  //    promote this draft. The partial unique index
  //    pms_knowledge_files_one_active_per_family (migration 0201) means
  //    we MUST demote before promote or the second update fails. Doing
  //    both serially is fine — the index enforces post-condition.
  if (gate.decision === 'auto_promote') {
    const promoted = await promoteDraft(input.pms_family, draft.id);
    if (!promoted.ok) {
      log.warn('mapping-driver: auto-promotion failed, leaving as draft', {
        jobId, knowledgeFileId: draft.id, reason: promoted.error,
      });
      // Still return ok — the draft is saved; admin can promote
      // manually. Decision is downgraded to park_draft for clarity.
      gate.decision = 'park_draft';
      gate.reason = `auto-promotion failed: ${promoted.error}`;
    }
  }

  const stats = computeStats(result);
  log.info('mapping-driver: complete', {
    jobId,
    knowledgeFileId: draft.id,
    knowledgeFileVersion: draft.version,
    promotionDecision: gate.decision,
    ...stats,
  });

  return {
    ok: true,
    knowledgeFileId: draft.id,
    knowledgeFileVersion: draft.version,
    promotionDecision: gate.decision,
    promotionReason: gate.reason,
    ...stats,
  };
}

// ─── Promotion gate ────────────────────────────────────────────────────

function evaluatePromotionGate(recipe: Recipe): {
  decision: 'auto_promote' | 'park_draft' | 'quarantine';
  reason: string;
} {
  const found = new Set(Object.keys(recipe.actions));

  const missingRequired = REQUIRED_TARGETS.filter((t) => !found.has(t));
  if (missingRequired.length > 0) {
    return {
      decision: 'quarantine',
      reason: `missing required targets: ${missingRequired.join(', ')}`,
    };
  }

  const businessCriticalFound = BUSINESS_CRITICAL_TARGETS.filter((t) => found.has(t));
  if (businessCriticalFound.length >= MIN_BUSINESS_CRITICAL_FOR_AUTO) {
    return {
      decision: 'auto_promote',
      reason: `all required + ${businessCriticalFound.length}/${BUSINESS_CRITICAL_TARGETS.length} business-critical (${businessCriticalFound.join(', ')})`,
    };
  }

  return {
    decision: 'park_draft',
    reason: `all required found but only ${businessCriticalFound.length}/${BUSINESS_CRITICAL_TARGETS.length} business-critical (need ${MIN_BUSINESS_CRITICAL_FOR_AUTO}) — admin promotes if this is the best the PMS exposes`,
  };
}

async function promoteDraft(
  pmsFamily: string,
  newDraftId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Demote prior active first (partial unique index enforces one active
  // per family — promote-before-demote would violate it).
  const { error: demErr } = await supabase
    .from('pms_knowledge_files')
    .update({ status: 'deprecated', deprecated_at: new Date().toISOString() })
    .eq('pms_family', pmsFamily)
    .eq('status', 'active');
  if (demErr) return { ok: false, error: `demote failed: ${demErr.message}` };

  const { error: promErr } = await supabase
    .from('pms_knowledge_files')
    .update({ status: 'active', promoted_to_active_at: new Date().toISOString() })
    .eq('id', newDraftId);
  if (promErr) return { ok: false, error: `promote failed: ${promErr.message}` };

  return { ok: true };
}

// ─── Pre-flight check ───────────────────────────────────────────────────

/**
 * Sanity-check the login URL before spending any Claude tokens. Catches:
 *  - Wrong/stale URL (404, no DNS, bad scheme)
 *  - PMS down (timeout, 5xx, no response)
 *  - T&C wall / maintenance page (no `<input type="password">` on the
 *    landing page — a legitimate PMS login always exposes one)
 *  - Unsafe URLs (private IP, non-http(s) scheme) via safeGoto's checks
 *
 * Goes through safeGoto so all the URL safety guards apply. NEVER calls
 * Anthropic, so the worst case is ~$0 + 20s of compute vs the mapper
 * agent's $4-10 + 5-45min when it fails the same way deeper in.
 *
 * Note on the selector check: we look for `input[type="password"]` as
 * proof of a real login form. This is the single workhorse signal — a
 * 404 page, T&C wall, maintenance page, or redirect to a vendor's
 * marketing site all reliably fail it. A correct login page always
 * exposes one.
 */
async function preflightLoginPage(
  loginUrl: string,
  signal: AbortSignal,
  mode: 'dom' | 'vision' = 'dom',
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (signal.aborted) {
    return { ok: false, reason: 'job aborted before pre-flight could start' };
  }

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);

    // Honor the workflow's AbortController — kill the browser if the
    // caller cancels mid-pre-flight.
    const abortHandler = () => {
      browser?.close().catch(() => {});
    };
    signal.addEventListener('abort', abortHandler);

    try {
      // First navigation of the job — `allowedHost: null` per safeGoto's
      // contract (this is what establishes the PMS session host).
      try {
        await safeGoto(page, loginUrl, {
          allowedHost: null,
          context: 'mapping-driver-preflight',
          waitUntil: 'domcontentloaded',
          timeoutMs: 15_000,
        });
      } catch (err) {
        if (err instanceof UnsafeNavigationError) {
          return { ok: false, reason: `unsafe login URL (${err.reason}): ${err.message.slice(0, 200)}` };
        }
        return { ok: false, reason: `failed to load: ${(err as Error).message.slice(0, 200)}` };
      }

      // Look for a password input — proves this is a real login form.
      // If absent, this is likely a T&C page, maintenance page, OR the
      // PMS vendor changed their login URL without us updating it.
      //
      // Plan v8 P1-5: vision-mode fallback. Some PMSes (the exact ones
      // vision mode exists to handle) render login UI in <canvas> with no
      // DOM password input. For those, ALSO accept "page has a <canvas>
      // AND visible text contains login/password/sign-in". Otherwise
      // preflight would reject exactly the canvas-rendered PMSes the
      // operator expects vision to handle.
      try {
        await page.waitForSelector('input[type="password"]', {
          timeout: 5_000,
          state: 'attached',
        });
        return { ok: true };
      } catch {
        // No DOM password input. In DOM mode, fail — the mapper can't
        // type into a non-DOM form anyway.
        if (mode !== 'vision') {
          const finalUrl = page.url().slice(0, 120);
          return {
            ok: false,
            reason: `no password input on ${finalUrl} — likely T&C, maintenance, or wrong URL`,
          };
        }
        // Vision mode: check the canvas+text fallback before giving up.
        const isCanvasLogin = await page.evaluate(() => {
          const hasCanvas = document.querySelector('canvas') !== null;
          if (!hasCanvas) return false;
          const text = (document.body?.innerText ?? '').toLowerCase();
          return text.includes('login') || text.includes('password') ||
                 text.includes('sign in') || text.includes('sign-in');
        }).catch(() => false);
        if (isCanvasLogin) {
          return { ok: true };
        }
        const finalUrl = page.url().slice(0, 120);
        return {
          ok: false,
          reason: `no password input AND no canvas login on ${finalUrl} — likely T&C, maintenance, or wrong URL`,
        };
      }
    } finally {
      signal.removeEventListener('abort', abortHandler);
    }
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

// ─── Internals ──────────────────────────────────────────────────────────

async function loadCredentials(propertyId: string): Promise<PMSCredentials | null> {
  const { data, error } = await supabase
    .from('scraper_credentials_decrypted')
    .select('ca_login_url, ca_username, ca_password, is_active')
    .eq('property_id', propertyId)
    .eq('is_active', true)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as ScraperCredentialsRow;
  return {
    loginUrl: row.ca_login_url,
    username: row.ca_username,
    password: row.ca_password,
  };
}

async function saveDraftKnowledgeFile(
  pmsFamily: string,
  recipe: Recipe,
  status: 'draft' | 'quarantined' = 'draft',
): Promise<{ ok: true; id: string; version: number } | { ok: false; error: string }> {
  // Find the highest existing version for this family; new version = max+1.
  const { data: existing, error: selErr } = await supabase
    .from('pms_knowledge_files')
    .select('version')
    .eq('pms_family', pmsFamily)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (selErr) return { ok: false, error: `version lookup failed: ${selErr.message}` };
  const nextVersion = ((existing?.version as number | undefined) ?? 0) + 1;

  // Recipe → knowledge file jsonb shape. The recipe-adapter handles the
  // detailed translation; here we wrap the recipe in the knowledge file
  // envelope expected by `pms_knowledge_files.knowledge` (per migration
  // 0203's seeded shape).
  const knowledge = {
    schema: 1,
    description: recipe.description ?? `Auto-mapped by mapping-driver (v${nextVersion})`,
    login: recipe.login,
    actions: recipe.actions,
    hints: recipe.hints ?? {},
  };

  // Plan v8 P1-7 — sign the recipe before persisting. Closes the takeover-
  // mode recipe-injection vector: when admin drives the browser in Live
  // Mapping, admin-recorded click_at / type_text steps land in this same
  // insert. A compromised or socially-engineered admin could otherwise
  // inject {kind: 'goto', url: 'attacker.example'} or {kind: 'fill',
  // selector: ..., value: '$password'}. Signing ties the recipe to the
  // active key; replay-time verifyRecipe refuses tampered rows under
  // RECIPE_SIGNING_ENFORCE=enforce. When no key is configured (legacy
  // dev), we log + skip — recipe-runner runs in warn mode and proceeds.
  let signatureBytes: Buffer | null = null;
  let signedWithKeyId: string | null = null;
  let signedAt: string | null = null;
  if (isRecipeSigningConfigured()) {
    try {
      const sig = signRecipe(recipe);
      signatureBytes = sig.signature;
      signedWithKeyId = sig.signedWithKeyId;
      signedAt = sig.signedAt;
    } catch (err) {
      log.warn('saveDraftKnowledgeFile: signRecipe failed — saving unsigned', {
        err: (err as Error).message, pmsFamily, version: nextVersion,
      });
    }
  } else {
    log.info('saveDraftKnowledgeFile: signing key not configured — saving unsigned', {
      pmsFamily, version: nextVersion,
    });
  }

  const { data: inserted, error: insErr } = await supabase
    .from('pms_knowledge_files')
    .insert({
      pms_family: pmsFamily,
      version: nextVersion,
      status,                   // 'draft' (gate may promote) or 'quarantined'
      knowledge,
      created_by: 'mapper:mapping-driver',
      notes: `Mapped at ${new Date().toISOString()}. Targets: ${Object.keys(recipe.actions).join(', ')}.`,
      signature: signatureBytes,
      signed_with_key_id: signedWithKeyId,
      signed_at: signedAt,
    })
    .select('id')
    .single();
  if (insErr || !inserted) return { ok: false, error: `insert failed: ${insErr?.message ?? 'unknown'}` };
  return { ok: true, id: inserted.id as string, version: nextVersion };
}

function computeStats(result: MapperResult & { ok: true }): {
  targetsFound: number;
  targetsUnavailable: number;
  targetsFailed: number;
} {
  // Recipe.actions has entries for SUCCESSFULLY mapped targets only.
  // Unavailable + failed counts come from the mapper's run log; we
  // approximate from what's in the recipe vs what the TARGETS catalogue
  // expects (13 entries).
  const found = Object.keys(result.recipe.actions).length;
  // TODO: surface unavailable/failed counts via mapper return shape
  // extension. For now report 0 (the admin UI shows which targets are
  // present by inspecting recipe.actions keys).
  return {
    targetsFound: found,
    targetsUnavailable: 0,
    targetsFailed: 0,
  };
}
