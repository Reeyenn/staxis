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

const JOB_TIMEOUT_MS = parseInt(process.env.JOB_TIMEOUT_MS ?? '240000', 10);

export async function runJob(jobId: string, workerId: string): Promise<void> {
  const startedAt = Date.now();
  let timedOut = false;

  // Hard timeout — if the job is still running after JOB_TIMEOUT_MS we
  // mark it failed and let the next iteration of pollLoop pick up new
  // work. Without this a single bad PMS could brick the worker.
  const timeout = setTimeout(() => {
    timedOut = true;
    void markFailed(jobId, 'Job exceeded time limit', { kind: 'timeout', limitMs: JOB_TIMEOUT_MS });
  }, JOB_TIMEOUT_MS);

  try {
    const job = await loadJob(jobId);
    if (!job) {
      log.error('job vanished after claim — race?', { jobId });
      return;
    }

    const creds = await loadCredentials(job.property_id);
    if (!creds) {
      await markFailed(jobId, 'No PMS credentials found for this property', {
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
    let recipe = await loadActiveRecipe(job.pms_type);
    let recipeIdForJob: string | null = recipe?.id ?? null;
    let isFreshlyMapped = false;

    if (!recipe) {
      await updateProgress(jobId, 'mapping', 'Learning your PMS for the first time…', 15);
      log.info('no active recipe — running CUA mapper', {
        jobId,
        pmsType: job.pms_type,
        propertyId: job.property_id,
      });

      const mapResult = await mapPMS({
        pmsType: job.pms_type,
        credentials,
        onProgress: (step, pct) => updateProgress(jobId, 'mapping', step, pct).catch(() => {}),
      });

      if (timedOut) return;
      if (!mapResult.ok) {
        await markFailed(jobId, mapResult.userMessage, {
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
        await markFailed(jobId, 'Could not save the learned recipe — please retry.', {
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
    await updateProgress(jobId, 'extracting', 'Pulling rooms, staff, and 90 days of history…', 60);
    if (timedOut) return;

    const extracted = await runRecipeExtraction({
      recipe: recipe.recipe,
      credentials,
      onProgress: (step, pct) => updateProgress(jobId, 'extracting', step, pct).catch(() => {}),
    });

    if (timedOut) return;
    if (!extracted.ok) {
      await markFailed(jobId, extracted.userMessage, {
        kind: 'extraction_failed',
        ...extracted.detail,
      });
      return;
    }

    // ─── Phase 3: persist to Supabase ─────────────────────────────────────
    await updateProgress(jobId, 'extracting', 'Setting up your dashboard…', 90);
    const saveResult = await saveExtractedData({
      propertyId: job.property_id,
      data: extracted.data,
    });
    if (!saveResult.ok) {
      await markFailed(jobId, 'Could not save the data we pulled. Please contact support.', {
        kind: 'save_data_failed',
        dbError: saveResult.error,
      });
      return;
    }

    // ─── Phase 4: promote recipe if newly mapped ─────────────────────────
    if (isFreshlyMapped && recipeIdForJob) {
      const { error: promoteErr } = await supabase
        .from('pms_recipes')
        .update({ status: 'active' })
        .eq('id', recipeIdForJob);
      if (promoteErr) {
        // Non-fatal: extraction worked, the next onboarding for this PMS
        // type just won't reuse the recipe. Log and move on.
        log.warn('failed to promote recipe to active — non-fatal', {
          jobId,
          recipeId: recipeIdForJob,
          err: promoteErr.message,
        });
      } else {
        // Demote any older active recipes for this pms_type.
        await supabase
          .from('pms_recipes')
          .update({ status: 'deprecated' })
          .eq('pms_type', job.pms_type)
          .eq('status', 'active')
          .neq('id', recipeIdForJob);
      }
    }

    // ─── Done ────────────────────────────────────────────────────────────
    await markComplete(jobId, recipeIdForJob, {
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
    await markFailed(jobId, 'Unexpected error. Please try again — if it persists, contact support.', {
      kind: 'unhandled',
      message: e.message,
    });
  } finally {
    clearTimeout(timeout);
  }
}

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
  const { data, error } = await supabase
    .from('scraper_credentials')
    .select('*')
    .eq('property_id', propertyId)
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
  return {
    id: data.id as string,
    version: data.version as number,
    recipe: data.recipe as Recipe,
  };
}

async function saveDraftRecipe(args: {
  pmsType: string;
  recipe: Recipe;
  learnedByPropertyId: string;
  notes?: string;
}): Promise<{ id: string; version: number } | { error: string }> {
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

  if (error || !data) return { error: error?.message ?? 'unknown insert error' };
  return { id: data.id as string, version: data.version as number };
}

async function updateProgress(
  jobId: string,
  status: 'running' | 'mapping' | 'extracting',
  step: string,
  progress_pct: number,
): Promise<void> {
  await supabase
    .from('onboarding_jobs')
    .update({ status, step, progress_pct })
    .eq('id', jobId);
}

async function markComplete(
  jobId: string,
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
    .eq('id', jobId);
}

async function markFailed(
  jobId: string,
  userMessage: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await supabase
    .from('onboarding_jobs')
    .update({
      status: 'failed',
      step: 'Failed',
      error: userMessage,
      error_detail: detail,
      completed_at: new Date().toISOString(),
    })
    .eq('id', jobId);
}
