/**
 * POST/GET /api/cron/pms-backfill-missing-feeds (feat/cua-partial-promotion)
 *
 * Daily retry of feeds the robot has NOT learned yet. The promotion gate can
 * now go live with gaps (promote_partial → `feedGaps` in the active knowledge
 * envelope); the CUA's zero-row self-repair never fires for those gaps (a
 * never-learned feed produces no zero-row streak, and an incomplete_columns
 * feed extracts rows that only die later in validateRows). This cron is the
 * missing-feed retry path: for each PMS family whose ACTIVE knowledge file
 * has gaps, enqueue ONE seeded mapper job. The mapper re-hunts everything not
 * in the seed; the gate auto-promotes on full success or replaces the partial
 * with a strictly-better partial (promote-time superset + gap-shrink guards
 * in cua-service/src/mapping-driver.ts prevent regression and churn).
 *
 * Spend bounds (defense in depth):
 *  - flat per-job cost cap ($12 — the mapper hunts ALL unlearned catalogue
 *    targets, not just the gap set; there is no per-target allowlist input)
 *  - org-wide daily mapping cap re-checked at job RUN time (mapping-driver)
 *  - 20h family-level dedup vs ANY in-flight/recent mapper job
 *  - circuit breaker: 5 consecutive no-progress backfills → stop until an
 *    admin re-arms (regenerate map, or the repair-feed route's absent-target
 *    mode) or any gap actually shrinks
 *  - max_attempts: 1, date-stamped idempotency key
 *
 * Family-level dedup is an explicit query (workflow_jobs uniqueness is
 * (property_id, idempotency_key) — property-scoped). The deterministic
 * property pick (alive-preferred, then lowest id) makes two same-day cron
 * invocations collide on the unique key as a second line of defense.
 */

import { NextRequest } from 'next/server';
import { requireCronSecret } from '@/lib/api-auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';
import type { FeedGaps } from '@/lib/pms/feed-status';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const DEDUP_WINDOW_HOURS = 20;
const BREAKER_LOOKBACK = 5;
const BACKFILL_COST_CAP_MICROS = 12_000_000; // $12 flat — see header.

interface ActiveKfRow {
  id: string;
  pms_family: string;
  version: number;
  knowledge: {
    actions?: Record<string, unknown>;
    feedGaps?: FeedGaps;
    valueTranslations?: unknown;
    dateFormat?: unknown;
  };
}

interface JobRow {
  status: string;
  result: { promotion_decision?: string } | null;
}

function hasGaps(gaps: FeedGaps | undefined | null): gaps is FeedGaps {
  return !!gaps && (gaps.missingRequired.length > 0 || gaps.missingBusinessCritical.length > 0);
}

/** A backfill job "made progress" only if it completed AND promoted. Any
 *  failure status, park, or quarantine counts toward the breaker — a job
 *  that keeps dying (picked property paused, login broken) must not retry
 *  daily forever any more than one that keeps finding nothing. */
function madeProgress(job: JobRow): boolean {
  const decision = job.result?.promotion_decision;
  return decision === 'auto_promote' || decision === 'promote_partial';
}

export async function GET(req: NextRequest) { return run(req); }
export async function POST(req: NextRequest) { return run(req); }

async function run(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const authFail = requireCronSecret(req);
  if (authFail) return authFail;

  const results: Array<{ family: string; action: string; detail?: string }> = [];
  let enqueued = 0;

  try {
    const { data: actives, error: kfErr } = await supabaseAdmin
      .from('pms_knowledge_files')
      .select('id, pms_family, version, knowledge')
      .eq('status', 'active');
    if (kfErr) throw kfErr;

    for (const kf of (actives ?? []) as ActiveKfRow[]) {
      const family = kf.pms_family;
      const gaps = kf.knowledge?.feedGaps;
      if (!hasGaps(gaps)) continue; // clean family — nothing to backfill

      try {
        const outcome = await backfillFamily(kf, gaps);
        results.push({ family, ...outcome });
        if (outcome.action === 'enqueued') enqueued++;
      } catch (e) {
        log.warn('[pms-backfill] family failed — continuing', {
          requestId, family, msg: errToString(e),
        });
        results.push({ family, action: 'error', detail: errToString(e) });
      }
    }

    await writeCronHeartbeat('pms-backfill-missing-feeds', {
      requestId,
      notes: { enqueued, families: results.length },
    });
    return ok({ enqueued, results }, { requestId });
  } catch (e) {
    log.error('[pms-backfill] sweep failed', { requestId, msg: errToString(e) });
    return err('Internal server error', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}

async function backfillFamily(
  kf: ActiveKfRow,
  gaps: FeedGaps,
): Promise<{ action: string; detail?: string }> {
  const family = kf.pms_family;

  // 1. A live-ish property to run the mapper against (it needs credentials +
  //    a login). Deterministic pick: alive first, then lowest property_id —
  //    so concurrent invocations choose the SAME property and collide on the
  //    (property_id, idempotency_key) unique instead of double-enqueueing.
  const { data: sessions, error: sessErr } = await supabaseAdmin
    .from('property_sessions')
    .select('property_id, status')
    .eq('pms_family', family)
    .neq('status', 'stopped')
    .order('property_id', { ascending: true });
  if (sessErr) throw sessErr;
  const pick = (sessions ?? []).find((s) => s.status === 'alive') ?? (sessions ?? [])[0];
  if (!pick) return { action: 'skipped', detail: 'no non-stopped property on this family' };

  // 2. Family-level dedup: any mapper job (backfill, self-repair, admin
  //    regenerate, fresh learn) queued/running or created in the window →
  //    stand down today.
  const windowStart = new Date(Date.now() - DEDUP_WINDOW_HOURS * 3_600_000).toISOString();
  const { data: recent, error: recentErr } = await supabaseAdmin
    .from('workflow_jobs')
    .select('id, status, created_at')
    .eq('kind', 'mapper.learn_pms_family')
    .filter('payload->>pms_family', 'eq', family)
    .or(`status.in.(queued,running),created_at.gt.${windowStart}`)
    .limit(1);
  if (recentErr) throw recentErr;
  if ((recent ?? []).length > 0) {
    return { action: 'skipped', detail: 'mapper job in-flight or ran within the dedup window' };
  }

  // 3. Circuit breaker — last N backfills all made no progress → paused.
  const { data: lastJobs, error: lastErr } = await supabaseAdmin
    .from('workflow_jobs')
    .select('status, result')
    .eq('kind', 'mapper.learn_pms_family')
    .filter('payload->>pms_family', 'eq', family)
    .filter('payload->>backfill_missing_feeds', 'eq', 'true')
    .order('created_at', { ascending: false })
    .limit(BREAKER_LOOKBACK);
  if (lastErr) throw lastErr;
  const jobs = (lastJobs ?? []) as JobRow[];
  if (jobs.length >= BREAKER_LOOKBACK && jobs.every((j) => !madeProgress(j))) {
    return {
      action: 'breaker_paused',
      detail: `last ${BREAKER_LOOKBACK} backfills made no progress — re-arm via admin regenerate or repair-feed`,
    };
  }

  // 4. Seed = active actions MINUS incomplete_columns-gapped targets. The
  //    mapper SKIPS every seeded key, so a present-but-dead feed must be
  //    dropped from the seed or it can never be re-learned (mirrors
  //    session-driver's `delete seedActions[key]`).
  const seedActions: Record<string, unknown> = { ...(kf.knowledge.actions ?? {}) };
  for (const gap of gaps.missingRequired) {
    if (gap.reason === 'incomplete_columns') delete seedActions[gap.target];
  }

  const today = new Date().toISOString().slice(0, 10); // UTC date stamp
  const idempotencyKey = `mapper.backfill:${family}:${today}`;

  const { error: insErr } = await supabaseAdmin.from('workflow_jobs').insert({
    property_id: pick.property_id,
    kind: 'mapper.learn_pms_family',
    idempotency_key: idempotencyKey,
    max_attempts: 1,
    triggered_by: 'cron:pms-backfill-missing-feeds',
    payload: {
      pms_family: family,
      property_id: pick.property_id,
      cost_cap_micros: BACKFILL_COST_CAP_MICROS,
      seed_actions: seedActions,
      // Preserve the family's learned value translation across the backfill
      // (skipped targets aren't re-learned — same rule as self-repair).
      seed_value_translations: kf.knowledge.valueTranslations,
      seed_date_format: kf.knowledge.dateFormat,
      backfill_missing_feeds: true,
      gaps_at_enqueue: gaps,
      backfilled_from_version: kf.version,
    },
  });
  if (insErr) {
    if (insErr.code === '23505') {
      return { action: 'skipped', detail: 'already enqueued today (idempotency)' };
    }
    throw insErr;
  }

  log.info('[pms-backfill] enqueued', {
    family,
    propertyId: pick.property_id,
    fromVersion: kf.version,
    missingRequired: gaps.missingRequired.map((g) => g.target),
    missingBusinessCritical: gaps.missingBusinessCritical,
  });
  return { action: 'enqueued' };
}
