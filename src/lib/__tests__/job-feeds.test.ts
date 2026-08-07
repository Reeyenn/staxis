/**
 * THE JOB THAT IS GREEN EVERY DAY AND HAS NOTHING TO READ.
 *
 * ─── WHAT WAS FOUND, 2026-08-07 ────────────────────────────────────────────
 *
 * In production: `plan_snapshots` held ZERO rows, and `daily_logs` had not
 * gained one since 2026-07-18. The only writer of either is
 * `/api/cron/seal-daily`, whose catalog row is `staged` with `schedule: null`:
 * it is in no `vercel.json` entry and no workflow, so nothing has run it.
 *
 * Meanwhile `ml-predict-inventory` ran every day at 11:00 UTC and
 * `ml-train-inventory` every Sunday, and BOTH read "On time" in Mission
 * Control the whole time, because a heartbeat proves that a route finished,
 * never that it had anything to work with. `ml-cron.yml`'s own header
 * justified switching those two on with the sentence "the seal-daily cron
 * projects tomorrow's occupancy into plan_snapshots".
 *
 * There is no seal-daily cron.
 *
 * ─── WHAT THIS FILE IS FOR ─────────────────────────────────────────────────
 *
 * Not to schedule anything. Whether seal-daily goes back on a timer is a
 * decision with real consequences (its projection is gated on fresh PMS
 * evidence, and the robot that produced that evidence is retired), and it
 * belongs to the founder, not to a test.
 *
 * What this refuses is the SHAPE: an active job whose producer is parked, with
 * nothing anywhere saying so. Every future pair like it fails here at PR time,
 * and the one pair that exists today is named below with the evidence, so it
 * cannot quietly become normal.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { JOB_CATALOG, type JobCatalogEntry } from '@/lib/automation/job-catalog';

const byId = new Map<string, JobCatalogEntry>(JOB_CATALOG.map((job) => [job.id, job]));

/** Every (job, feed) pair where the job runs on a timer and its producer does not. */
function unfedActiveJobs(): Array<{ jobId: string; producerId: string; tables: readonly string[] }> {
  const out: Array<{ jobId: string; producerId: string; tables: readonly string[] }> = [];
  for (const job of JOB_CATALOG) {
    if (job.lifecycle !== 'active') continue;
    for (const feed of job.fedBy ?? []) {
      const producer = byId.get(feed.producerId);
      if (!producer || producer.lifecycle !== 'active') {
        out.push({ jobId: job.id, producerId: feed.producerId, tables: feed.tables });
      }
    }
  }
  return out;
}

/**
 * The one pair that is broken today, with the reason it is not being fixed
 * here.
 *
 * THIS SET MAY ONLY EVER SHRINK. The second test below fails if an entry stops
 * being true, so it cannot rot into a forever-pass the way a plain allowlist
 * does, and adding a new entry is a deliberate act somebody has to explain.
 */
const KNOWN_UNFED: ReadonlyArray<{ jobId: string; producerId: string; why: string }> = [
  {
    jobId: 'ml-predict-inventory',
    producerId: 'seal-daily',
    why: 'plan_snapshots has been empty since the seal was parked. Putting seal-daily '
      + 'back on a timer is the founder\'s call: its projection is gated on fresh PMS '
      + 'evidence and the robot that produced it is retired, so scheduling it without '
      + 'settling that would add a job that also does nothing.',
  },
  {
    jobId: 'ml-train-inventory',
    producerId: 'seal-daily',
    why: 'daily_logs is the weekly fit\'s label source and stopped gaining rows on '
      + '2026-07-18. Same decision as above; the two move together.',
  },
];

describe('a scheduled job has something to read', () => {
  test('every catalogued feed names a producer that exists', () => {
    for (const job of JOB_CATALOG) {
      for (const feed of job.fedBy ?? []) {
        assert.ok(
          byId.has(feed.producerId),
          `${job.id} says it is fed by "${feed.producerId}", which is not a catalog id`,
        );
        assert.ok(feed.tables.length > 0, `${job.id}'s feed from ${feed.producerId} names no table`);
      }
    }
  });

  test('no active job depends on a producer nobody runs', () => {
    const known = new Set(KNOWN_UNFED.map((k) => `${k.jobId}<-${k.producerId}`));
    const surprises = unfedActiveJobs().filter((u) => !known.has(`${u.jobId}<-${u.producerId}`));

    assert.deepEqual(
      surprises.map((s) => `${s.jobId} reads ${s.tables.join(', ')}, written only by ${s.producerId}, which is not scheduled`),
      [],
      'A job runs on a timer and the job that fills the table it reads does not. '
      + 'Nothing reports this: the heartbeat proves the route finished, not that it '
      + 'had data, so the row stays "On time" indefinitely. Either schedule the '
      + 'producer, or park the consumer, or record the pair in KNOWN_UNFED with the '
      + 'reason somebody decided to leave it.',
    );
  });

  test('nothing sits in the known list after it has been fixed', () => {
    // The anti-rot half. A stale exemption is worse than none: it is a place a
    // real regression can hide behind a comment about a problem that is over.
    const stillBroken = new Set(unfedActiveJobs().map((u) => `${u.jobId}<-${u.producerId}`));
    for (const entry of KNOWN_UNFED) {
      assert.ok(
        stillBroken.has(`${entry.jobId}<-${entry.producerId}`),
        `${entry.jobId} is no longer waiting on ${entry.producerId}. Delete that entry `
        + 'from KNOWN_UNFED so the check goes back to protecting it.',
      );
    }
  });

  test(
    'the inventory prediction pipeline has a producer running',
    {
      todo: 'OPEN, and it is a founder decision. /api/cron/seal-daily is the only '
        + 'writer of plan_snapshots and daily_logs and it is on no schedule, so the '
        + 'daily inventory prediction and the weekly retrain have been running on an '
        + 'empty table and a frozen one while reading "On time". Decide whether the '
        + 'seal goes back on a timer or whether the two ML jobs come off theirs.',
    },
    () => {
      const seal = byId.get('seal-daily');
      assert.equal(
        seal?.lifecycle,
        'active',
        'seal-daily is not scheduled, so plan_snapshots and daily_logs gain no rows',
      );
    },
  );
});
