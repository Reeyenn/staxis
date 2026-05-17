/**
 * Pull job runner — the steady-state per-property data pull. Cousin of
 * job-runner.ts (onboarding) but simpler:
 *
 *   queued → running → complete | failed
 *
 * No mapping phase — pulls always have an active recipe by definition
 * (a property whose pms_type has no active recipe shouldn't have been
 * enqueued by the cron). If somehow a pull lands without one, we fail
 * fast and the queue cron skips that property until the recipe lands.
 *
 * Lifecycle on success: ~60-90s wall clock (login + recipe replay +
 * data save + DB writes).
 *
 * Concurrency: matches job-runner.ts — one worker = one job. Fly scales
 * by adding machines. The pull_jobs queue uses FOR UPDATE SKIP LOCKED
 * so multiple workers can process distinct properties safely.
 */

import { supabase } from './supabase.js';
import { log } from './log.js';
import { runRecipeExtraction } from './recipe-runner.js';
import { savePullData } from './pull-data-saver.js';
import type { PMSCredentials, Recipe, ScraperCredentialsRow } from './types.js';
import { env } from './env.js';

// Hard timeout for a single pull. Pulls are typically 60-90s; 3 min
// gives slack for slow PMS pages but bails before the worker is wedged.
const PULL_TIMEOUT_MS = env.PULL_TIMEOUT_MS;

// pull_jobs lifecycle — only the running state owns DB writes. Once a
// job is complete or failed the runner is done; first-writer-wins on
// terminal state via the .in() guard on every write below.
const RUNNING_STATUSES = ['running'] as const;

interface PullJobRow {
  id: string;
  property_id: string;
  pms_type: string;
  recipe_id: string | null;
  scheduled_for: string;
  worker_id: string | null;
  started_at: string | null;
}

export async function runPullJob(jobId: string, workerId: string): Promise<void> {
  const startedAt = Date.now();
  let timedOut = false;

  // Hard timeout — same pattern as onboarding job-runner.
  const timeout = setTimeout(async () => {
    timedOut = true;
    log.warn('pull job exceeded time limit', { jobId, limitMs: PULL_TIMEOUT_MS });
    await markFailed(jobId, workerId, 'Pull exceeded time limit', {
      kind: 'timeout', limitMs: PULL_TIMEOUT_MS,
    });
  }, PULL_TIMEOUT_MS);

  try {
    const job = await loadPullJob(jobId);
    if (!job) {
      log.error('pull job vanished after claim — race?', { jobId });
      return;
    }

    const creds = await loadCredentials(job.property_id);
    if (!creds) {
      await markFailed(jobId, workerId, 'No active PMS credentials for this property', {
        kind: 'missing_credentials',
      });
      return;
    }

    const credentials: PMSCredentials = {
      loginUrl: creds.ca_login_url,
      username: creds.ca_username,
      password: creds.ca_password,
    };

    // Load the recipe — either the one pinned on the job (canary path)
    // or whatever's currently active for this PMS type.
    const recipe = job.recipe_id
      ? await loadRecipeById(job.recipe_id)
      : await loadActiveRecipe(job.pms_type);

    if (!recipe) {
      await markFailed(jobId, workerId, 'No active recipe for this PMS type', {
        kind: 'no_recipe', pms_type: job.pms_type, requested_recipe_id: job.recipe_id,
      });
      return;
    }

    await updateProgress(jobId, workerId, 'extracting', 'Pulling data from PMS…', 30);
    if (timedOut) return;

    const extracted = await runRecipeExtraction({
      recipe: recipe.recipe,
      credentials,
      onProgress: (step, pct) =>
        updateProgress(jobId, workerId, 'extracting', step, pct).catch((err) =>
          log.warn('pull progress update failed', {
            jobId,
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

    await updateProgress(jobId, workerId, 'saving', 'Updating dashboard…', 80);

    const saveResult = await savePullData({
      propertyId: job.property_id,
      data: extracted.data,
      pullStartedAt: startedAt,
    });

    if (timedOut) return;
    if (!saveResult.ok) {
      await markFailed(jobId, workerId, 'Pull succeeded but saving the data failed.', {
        kind: 'save_failed',
        dbError: saveResult.error,
      });
      return;
    }

    if (timedOut) return;
    await markComplete(jobId, workerId, recipe.id, {
      in_house:             saveResult.summary.inHouse,
      arrivals:             saveResult.summary.arrivals,
      departures:           saveResult.summary.departures,
      room_status_updates:  saveResult.summary.roomStatusUpdates,
      recipe_id:            recipe.id,
      duration_ms:          Date.now() - startedAt,
    });
    log.info('pull job complete', {
      jobId,
      propertyId: job.property_id,
      durationMs: Date.now() - startedAt,
      ...saveResult.summary,
    });
  } catch (err) {
    const e = err as Error;
    log.error('pull-job-runner unhandled error', { jobId, workerId, err: e.message, stack: e.stack });
    await markFailed(jobId, workerId, 'Unexpected error during pull. We\'ll retry on the next tick.', {
      kind: 'unhandled',
      message: e.message,
    });
  } finally {
    clearTimeout(timeout);
  }
}

// ─── DB helpers ──────────────────────────────────────────────────────────────

async function loadPullJob(jobId: string): Promise<PullJobRow | null> {
  const { data, error } = await supabase
    .from('pull_jobs')
    .select('id, property_id, pms_type, recipe_id, scheduled_for, worker_id, started_at')
    .eq('id', jobId)
    .maybeSingle();
  if (error || !data) return null;
  return data as PullJobRow;
}

async function loadCredentials(propertyId: string): Promise<ScraperCredentialsRow | null> {
  const { data, error } = await supabase
    .from('scraper_credentials')
    .select('*')
    .eq('property_id', propertyId)
    .eq('is_active', true)
    .maybeSingle();
  if (error || !data) return null;
  return data as ScraperCredentialsRow;
}

async function loadRecipeById(
  recipeId: string,
): Promise<{ id: string; version: number; recipe: Recipe } | null> {
  const { data } = await supabase
    .from('pms_recipes')
    .select('id, version, recipe')
    .eq('id', recipeId)
    .maybeSingle();
  if (!data) return null;
  return validateAndUnwrap(data as { id: string; version: number; recipe: unknown });
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
  return validateAndUnwrap(data as { id: string; version: number; recipe: unknown });
}

function validateAndUnwrap(row: { id: string; version: number; recipe: unknown }):
  { id: string; version: number; recipe: Recipe } | null
{
  const recipe = row.recipe as Recipe | null;
  if (!recipe || typeof recipe !== 'object'
      || (recipe as { schema?: unknown }).schema !== 1
      || !(recipe as Recipe).login
      || !(recipe as Recipe).actions
      || !Array.isArray((recipe as Recipe).login.steps)
      || !Array.isArray((recipe as Recipe).login.successSelectors)) {
    log.error('recipe failed shape validation', { recipeId: row.id });
    return null;
  }
  return { id: row.id, version: row.version, recipe };
}

async function updateProgress(
  jobId: string,
  workerId: string,
  _phase: string, // accepted for symmetry with job-runner; stored only as `step` text
  step: string,
  progressPct: number,
): Promise<void> {
  const { error } = await supabase
    .from('pull_jobs')
    .update({ step, progress_pct: progressPct })
    .eq('id', jobId)
    .eq('worker_id', workerId)
    .in('status', RUNNING_STATUSES as unknown as string[]);
  if (error) throw error;
}

async function markComplete(
  jobId: string,
  workerId: string,
  _recipeId: string,
  result: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase
    .from('pull_jobs')
    .update({
      status: 'complete',
      step: 'done',
      progress_pct: 100,
      result,
      completed_at: new Date().toISOString(),
    })
    .eq('id', jobId)
    .eq('worker_id', workerId)
    .in('status', RUNNING_STATUSES as unknown as string[]);
  if (error) {
    log.error('failed to mark pull job complete', { jobId, err: error.message });
  }
}

async function markFailed(
  jobId: string,
  workerId: string,
  userMessage: string,
  detail: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase
    .from('pull_jobs')
    .update({
      status: 'failed',
      error: userMessage,
      error_detail: detail,
      completed_at: new Date().toISOString(),
    })
    .eq('id', jobId)
    .eq('worker_id', workerId)
    .in('status', RUNNING_STATUSES as unknown as string[]);
  if (error) {
    log.error('failed to mark pull job failed', { jobId, err: error.message });
  }
}
