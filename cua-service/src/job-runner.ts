/**
 * Job runner — orchestrates one onboarding_jobs row from claim → complete.
 *
 * High-level flow:
 *   1. Load the job + its scraper_credentials row.
 *   2. Look up an active recipe for the pms_type.
 *      - If found: skip mapping, jump to extraction.
 *      - If not: run the mapper (Claude vision + Playwright) to learn one,
 *        save it as a draft recipe, then jump to extraction.
 *   3. Run extraction: replay the recipe to pull rooms, staff, history,
 *      arrivals, departures.
 *   4. Save extracted data to Supabase (rooms, staff tables).
 *   5. If the recipe was newly mapped and the extraction succeeded,
 *      promote the recipe from 'draft' to 'active'.
 *   6. Update job to 'complete' with result summary.
 *
 * Failure modes are handled with structured updates to onboarding_jobs.
 * The /settings/pms UI polls and renders the current step + error.
 */

import { supabase } from './supabase.js';
import { log } from './log.js';
import type { OnboardingJob, ScraperCredentialsRow, Recipe, PMSCredentials } from './types.js';
import { mapPMS } from './mapper.js';
import { runRecipeExtraction } from './recipe-runner.js';
import { saveExtractedData } from './data-loader.js';

// 15 minutes total per onboarding job. A full first-time mapping run
// is login (up to 5 min) + getRoomStatus + getArrivals + getDepartures
// + getStaffRoster (each up to ~3 min in practice with the new
// data-specific prompts, capped per-phase by MAPPING_WALLCLOCK_BUDGET_MS
// in mapper.ts). 15 min comfortably fits all of that with slack for
// recipe save + initial extraction. Override via env if needed.
const JOB_TIMEOUT_MS = parseInt(process.env.JOB_TIMEOUT_MS ?? '900000', 10);

export async function runJob(jobId: string, workerId: string): Promise<void> {
  const startedAt = Date.now();
  let timedOut = false;

  // Hard timeout — if the job is still running after JOB_TIMEOUT_MS we
  // mark it failed and let the next iteration of pollLoop pick up new
  // work. Without this a single bad PMS could brick the worker.
  //
  // 2026-05-12: Codex audit flagged that the timeout previously only
  // wrote to the DB — the actual Playwright + Claude work kept running
  // (and kept billing Anthropic) until it finished naturally. We now
  // hold an AbortController and call `abort()` on timeout, threading
  // its signal into mapPMS so anthropic.beta.messages.create() calls
  // get cancelled immediately. Playwright work still finishes its
  // current page op, but the expensive runaway path is closed.
  const abortController = new AbortController();
  const timeout = setTimeout(async () => {
    timedOut = true;
    log.warn('job exceeded time limit', { jobId, limitMs: JOB_TIMEOUT_MS });
    abortController.abort('job timeout');
    await markFailed(jobId, workerId, 'Job exceeded time limit', { kind: 'timeout', limitMs: JOB_TIMEOUT_MS });
  }, JOB_TIMEOUT_MS);

  try {
    const job = await loadJob(jobId);
    if (!job) {
      log.error('job vanished after claim — race?', { jobId });
      return;
    }

    const creds = await loadCredentials(job.property_id);
    if (!creds) {
      await markFailed(jobId, workerId, 'No PMS credentials found for this property', {
        kind: 'missing_credentials',
      });
      return;
    }

    const credentials: PMSCredentials = {
      loginUrl: creds.ca_login_url,
      username: creds.ca_username,
      password: creds.ca_password,
    };

    // ─── Phase 1: ensure we have a recipe ─────────────────────────────────
    // force_remap=true (set by /api/admin/regenerate-recipe) means the
    // operator explicitly asked us to learn a fresh recipe even if an
    // active one exists. We still load the active one so the fleet
    // keeps using it during this run; we just bypass the early-return
    // and run the mapper anyway. The atomic swap at the end (via
    // staxis_swap_active_recipe) demotes-and-promotes in one transaction.
    const existingActive = await loadActiveRecipe(job.pms_type);
    let recipe = job.force_remap ? null : existingActive;
    let recipeIdForJob: string | null = recipe?.id ?? null;
    let isFreshlyMapped = false;

    if (!recipe) {
      // Distinguish the three reasons we're running the mapper so admin
      // logs and the GM-facing step text are accurate. Order matters —
      // force_remap is checked first because existingActive may be set.
      const mapperReason: 'force_remap' | 'first_time' | 'shape_invalid' =
        job.force_remap && existingActive
          ? 'force_remap'
          : !existingActive
            ? 'first_time'
            : 'shape_invalid';
      const stepText =
        mapperReason === 'force_remap'    ? 'Re-mapping (admin-requested refresh)…'
        : mapperReason === 'shape_invalid' ? 'Existing recipe corrupt — re-mapping…'
        :                                    'Learning your PMS for the first time…';
      await updateProgress(jobId, workerId, 'mapping', stepText, 15);
      log.info('running CUA mapper', {
        jobId,
        pmsType: job.pms_type,
        propertyId: job.property_id,
        reason: mapperReason,
      });

      const mapResult = await mapPMS({
        pmsType: job.pms_type,
        credentials,
        propertyId: job.property_id,
        jobId,
        signal: abortController.signal,
        onProgress: (step, pct) => updateProgress(jobId, workerId, 'mapping', step, pct).catch((err) =>
          log.warn('progress update failed', {
            jobId,
            phase: 'mapping',
            err: err instanceof Error ? err.message : String(err),
          }),
        ),
      });

      if (timedOut) return;
      if (!mapResult.ok) {
        await markFailed(jobId, workerId, mapResult.userMessage, {
          kind: 'mapping_failed',
          ...mapResult.detail,
        });
        return;
      }

      const saved = await saveDraftRecipe({
        pmsType: job.pms_type,
        recipe: mapResult.recipe,
        learnedByPropertyId: job.property_id,
        notes: `Mapped during job ${jobId}`,
      });
      if ('error' in saved) {
        await markFailed(jobId, workerId, 'Could not save the learned recipe — please retry.', {
          kind: 'save_recipe_failed',
          dbError: saved.error,
        });
        return;
      }

      recipe = { id: saved.id, version: saved.version, recipe: mapResult.recipe };
      recipeIdForJob = saved.id;
      isFreshlyMapped = true;
      log.info('mapper succeeded — draft recipe saved', {
        jobId,
        recipeId: saved.id,
        version: saved.version,
      });
    } else {
      log.info('reusing active recipe', {
        jobId,
        recipeId: recipe.id,
        version: recipe.version,
      });
    }

    // ─── Phase 2: extract data ────────────────────────────────────────────
    await updateProgress(jobId, workerId, 'extracting', 'Pulling rooms, staff, and 90 days of history…', 60);
    if (timedOut) return;

    const extracted = await runRecipeExtraction({
      recipe: recipe.recipe,
      credentials,
      onProgress: (step, pct) => updateProgress(jobId, workerId, 'extracting', step, pct).catch((err) =>
        log.warn('progress update failed', {
          jobId,
          phase: 'extracting',
          err: err instanceof Error ? err.message : String(err),
        }),
      ),
    });

    if (timedOut) return;
    if (!extracted.ok) {
      await markFailed(jobId, workerId, extracted.userMessage, {
        kind: 'extraction_failed',
        ...extracted.detail,
      });
      return;
    }

    // ─── Phase 3: persist to Supabase ─────────────────────────────────────
    await updateProgress(jobId, workerId, 'extracting', 'Setting up your dashboard…', 90);
    const saveResult = await saveExtractedData({
      propertyId: job.property_id,
      data: extracted.data,
    });
    if (!saveResult.ok) {
      await markFailed(jobId, workerId, 'Could not save the data we pulled. Please contact support.', {
        kind: 'save_data_failed',
        dbError: saveResult.error,
      });
      return;
    }

    // ─── Phase 4: promote recipe if newly mapped ─────────────────────────
    // staxis_swap_active_recipe() does the demote+promote in a single
    // plpgsql transaction. If the promote fails the demote rolls back,
    // so the previous active recipe stays active and the fleet never
    // goes recipe-less even mid-regeneration. (Pass-3 fix — H7.)
    if (isFreshlyMapped && recipeIdForJob) {
      const { error: swapErr } = await supabase.rpc('staxis_swap_active_recipe', {
        p_new_recipe_id: recipeIdForJob,
        p_pms_type: job.pms_type,
      });
      if (swapErr) {
        // Non-fatal for the current job (extraction succeeded). Other
        // properties keep using the previous active recipe (if any).
        // The next onboarding for this PMS will retry promotion.
        log.warn('failed to swap active recipe — non-fatal', {
          jobId,
          recipeId: recipeIdForJob,
          err: swapErr.message,
        });
      }
    }

    // ─── Done ────────────────────────────────────────────────────────────
    // Final timedOut guard: if the timeout fired during phase 4 (recipe
    // promotion), we don't want markComplete to overwrite the failure
    // status the timeout handler wrote.
    if (timedOut) return;
    await markComplete(jobId, workerId, recipeIdForJob, {
      rooms_count: saveResult.summary.roomsSaved,
      staff_count: saveResult.summary.staffSaved,
      history_days_pulled: saveResult.summary.historyDaysSaved,
      arrivals_today: saveResult.summary.arrivalsToday,
      departures_today: saveResult.summary.departuresToday,
      recipe_id: recipeIdForJob,
      duration_ms: Date.now() - startedAt,
    });
    log.info('job complete', { jobId, durationMs: Date.now() - startedAt });
  } catch (err) {
    const e = err as Error;
    log.error('job-runner unhandled error', { jobId, workerId, err: e.message, stack: e.stack });
    await markFailed(jobId, workerId, 'Unexpected error. Please try again — if it persists, contact support.', {
      kind: 'unhandled',
      message: e.message,
    });
  } finally {
    clearTimeout(timeout);
  }
}

// Statuses where a worker still "owns" a job and may write to it.
// Once a job is in 'complete' or 'failed', no further writes should
// land — first-writer-wins enforced via .in() guards on every helper.
const RUNNING_STATUSES = ['running', 'mapping', 'extracting'] as const;

// ─── Supabase helpers ──────────────────────────────────────────────────────

async function loadJob(jobId: string): Promise<OnboardingJob | null> {
  const { data, error } = await supabase
    .from('onboarding_jobs')
    .select('*')
    .eq('id', jobId)
    .maybeSingle();
  if (error || !data) return null;
  return data as OnboardingJob;
}

async function loadCredentials(propertyId: string): Promise<ScraperCredentialsRow | null> {
  // Filter on is_active too — a property whose credentials have been
  // disabled shouldn't run mapping (we'd waste tokens probing a PMS
  // the GM has explicitly opted out of).
  const { data, error } = await supabase
    .from('scraper_credentials')
    .select('*')
    .eq('property_id', propertyId)
    .eq('is_active', true)
    .maybeSingle();
  if (error || !data) return null;
  return data as ScraperCredentialsRow;
}

async function loadActiveRecipe(
  pmsType: string,
): Promise<{ id: string; version: number; recipe: Recipe } | null> {
  const { data } = await supabase
    .from('pms_recipes')
    .select('id, version, recipe')
    .eq('pms_type', pmsType)
    .eq('status', 'active')
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;

  // Validate the recipe shape before handing it to the runner. JSONB
  // can drift over time (manual edits, future schema changes, partial
  // writes from a crashed mapper) — bad data here means a runtime
  // type error deep in Playwright. Catch it at the boundary instead.
  const recipe = data.recipe as Recipe | null;
  if (!recipe || typeof recipe !== 'object'
      || (recipe as { schema?: unknown }).schema !== 1
      || !(recipe as Recipe).login
      || !(recipe as Recipe).actions
      || !Array.isArray((recipe as Recipe).login.steps)
      || !Array.isArray((recipe as Recipe).login.successSelectors)) {
    log.error('active recipe failed shape validation', {
      pmsType, recipeId: data.id, version: data.version,
    });
    return null;
  }

  return {
    id: data.id as string,
    version: data.version as number,
    recipe,
  };
}

async function saveDraftRecipe(args: {
  pmsType: string;
  recipe: Recipe;
  learnedByPropertyId: string;
  notes?: string;
}): Promise<{ id: string; version: number } | { error: string }> {
  // Codex audit pass-6 P1 — the previous read-then-insert pattern raced
  // when two concurrent jobs for the same PMS both saw version=N and
  // both tried to insert version=N+1; the (pms_type, version, status)
  // unique constraint would reject one of them. Now we retry on
  // conflict, refetching the latest version each pass so we converge
  // even under contention. Bounded retries — three concurrent mappings
  // for the same PMS type is already pathological; failing after that
  // surfaces real trouble.
  const MAX_ATTEMPTS = 5;
  let lastError: string | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const { data: latest } = await supabase
      .from('pms_recipes')
      .select('version')
      .eq('pms_type', args.pmsType)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle();
    const nextVersion = ((latest?.version as number) ?? 0) + 1;

    const { data, error } = await supabase
      .from('pms_recipes')
      .insert({
        pms_type: args.pmsType,
        version: nextVersion,
        recipe: args.recipe,
        status: 'draft',
        learned_by_property_id: args.learnedByPropertyId,
        notes: args.notes ?? null,
      })
      .select('id, version')
      .single();

    if (data && !error) {
      if (attempt > 0) {
        log.info('saveDraftRecipe converged after retry', {
          pmsType: args.pmsType,
          attempts: attempt + 1,
          version: data.version,
        });
      }
      return { id: data.id as string, version: data.version as number };
    }

    lastError = error?.message ?? 'unknown insert error';
    // Postgres unique-violation is code 23505. Supabase surfaces it as
    // a string in error.code. Retry only on that — anything else is a
    // real failure (RLS, schema, network).
    const isUniqueViolation =
      (error as { code?: string } | null)?.code === '23505' ||
      /duplicate key|unique constraint/i.test(lastError);
    if (!isUniqueViolation) {
      return { error: lastError };
    }
    log.warn('saveDraftRecipe lost version race, retrying', {
      pmsType: args.pmsType,
      attemptedVersion: nextVersion,
      attempt: attempt + 1,
    });
  }
  return { error: `saveDraftRecipe gave up after ${MAX_ATTEMPTS} version-race retries: ${lastError}` };
}

// Every job-row write below is guarded by:
//   .eq('worker_id', workerId)           // we still own this job
//   .in('status', RUNNING_STATUSES)      // it hasn't already terminated
// If either fails (the reaper re-queued us, another worker re-claimed,
// or a parallel call already wrote 'complete'/'failed'), the UPDATE
// matches 0 rows and silently no-ops. That's the desired behavior:
// first writer to a terminal state wins, late writes are dropped.

async function updateProgress(
  jobId: string,
  workerId: string,
  status: 'running' | 'mapping' | 'extracting',
  step: string,
  progress_pct: number,
): Promise<void> {
  await supabase
    .from('onboarding_jobs')
    .update({ status, step, progress_pct })
    .eq('id', jobId)
    .eq('worker_id', workerId)
    .in('status', RUNNING_STATUSES);
}

async function markComplete(
  jobId: string,
  workerId: string,
  recipeId: string | null,
  result: Record<string, unknown>,
): Promise<void> {
  await supabase
    .from('onboarding_jobs')
    .update({
      status: 'complete',
      step: 'Done',
      progress_pct: 100,
      result,
      recipe_id: recipeId,
      completed_at: new Date().toISOString(),
    })
    .eq('id', jobId)
    .eq('worker_id', workerId)
    .in('status', RUNNING_STATUSES);
}

async function markFailed(
  jobId: string,
  workerId: string,
  userMessage: string,
  detail: Record<string, unknown>,
): Promise<void> {
  // 2026-05-12 (Codex audit): previously this dropped the Supabase
  // update error on the floor. If the terminal write itself failed
  // (RLS regression, schema drift, network hiccup), the job row would
  // stay in 'running' / 'mapping' / 'extracting' with no persisted
  // diagnostic — invisible to ops. Now we log so Sentry catches it.
  const { error } = await supabase
    .from('onboarding_jobs')
    .update({
      status: 'failed',
      step: 'Failed',
      error: userMessage,
      error_detail: detail,
      completed_at: new Date().toISOString(),
    })
    .eq('id', jobId)
    .eq('worker_id', workerId)
    .in('status', RUNNING_STATUSES);
  if (error) {
    log.error('markFailed: db write failed (job may stay stuck)', {
      jobId, workerId, dbError: error.message, originalError: userMessage,
    });
  }
}
