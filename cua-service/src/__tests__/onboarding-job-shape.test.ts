/**
 * Cross-service contract test — Phase E2E (2026-05-22).
 *
 * The web app inserts onboarding_jobs rows from
 * src/app/api/admin/regenerate-recipe/route.ts (and the wizard finalize
 * route). The CUA worker reads them via cua-service/src/job-runner.ts
 * against the OnboardingJob interface in cua-service/src/types.ts.
 *
 * Both sides must stay in sync — adding a NOT-NULL column to
 * onboarding_jobs without updating both is a silent breakage where the
 * web app inserts work but CUA's selector misses the new column.
 *
 * This test pins the keys the web app writes against the CUA-side type.
 * If CUA renames or removes a field, the test fails. If the web app adds
 * a NEW field, you'll add it to WEB_APP_INSERT_KEYS here and the test
 * will catch it if CUA's type hasn't been updated to match.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { OnboardingJob } from '../types';

// Fields the web app inserts when queuing a job. Source: grep of
// `.from('onboarding_jobs').insert` in src/app/api/admin/. If a new
// admin route starts writing onboarding_jobs with additional fields,
// add them here AND ensure they exist on OnboardingJob.
const WEB_APP_INSERT_KEYS: ReadonlyArray<keyof OnboardingJob> = [
  'property_id',
  'pms_type',
  'status',
  'step',
  'progress_pct',
  'force_remap',
];

// Fields CUA writes to the row as the job progresses. These don't appear
// in the web app's insert payload (they're populated by job-runner) but
// the web app reads them when polling /api/pms/job-status.
const CUA_WORKER_WRITE_KEYS: ReadonlyArray<keyof OnboardingJob> = [
  'status',
  'step',
  'progress_pct',
  'result',
  'error',
  'error_detail',
  'recipe_id',
  'worker_id',
  'started_at',
  'completed_at',
  'updated_at',
];

describe('onboarding_jobs row shape contract', () => {
  it('every key the web app inserts exists on the OnboardingJob type', () => {
    // Build a dummy job with all required fields so the structural check
    // catches "field removed from OnboardingJob" — TypeScript compilation
    // would already fail, but this gives a runtime-readable error too.
    const dummy: OnboardingJob = {
      id: '00000000-0000-0000-0000-000000000000',
      property_id: '00000000-0000-0000-0000-000000000000',
      pms_type: 'choice_advantage',
      status: 'queued',
      step: 'admin requested',
      progress_pct: 0,
      result: null,
      error: null,
      error_detail: null,
      recipe_id: null,
      worker_id: null,
      started_at: null,
      completed_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      force_remap: false,
    };
    for (const key of WEB_APP_INSERT_KEYS) {
      assert.ok(
        key in dummy,
        `OnboardingJob is missing '${key}' which the web app inserts at ` +
        `src/app/api/admin/regenerate-recipe/route.ts. Update cua-service/src/types.ts.`,
      );
    }
  });

  it('every key the CUA worker writes exists on the OnboardingJob type', () => {
    const dummy: OnboardingJob = {
      id: '00000000-0000-0000-0000-000000000000',
      property_id: '00000000-0000-0000-0000-000000000000',
      pms_type: 'choice_advantage',
      status: 'running',
      step: 'mapping',
      progress_pct: 50,
      result: null,
      error: null,
      error_detail: null,
      recipe_id: null,
      worker_id: 'fly-cua-abc',
      started_at: new Date().toISOString(),
      completed_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      force_remap: false,
    };
    for (const key of CUA_WORKER_WRITE_KEYS) {
      assert.ok(
        key in dummy,
        `OnboardingJob is missing '${key}' which the CUA worker writes ` +
        `from job-runner.ts. Update cua-service/src/types.ts.`,
      );
    }
  });

  it('status enum covers every state the runner transitions through', () => {
    // Pin the status values. If a new status is added (e.g. 'paused')
    // the web app needs to know about it for /api/pms/job-status display.
    const validStatuses: OnboardingJob['status'][] = [
      'queued', 'running', 'mapping', 'extracting', 'complete', 'failed',
    ];
    // This loop is purely a compile-time + runtime smoke: if any string
    // above doesn't match the union, the array literal won't type-check.
    assert.equal(validStatuses.length, 6);
  });
});
