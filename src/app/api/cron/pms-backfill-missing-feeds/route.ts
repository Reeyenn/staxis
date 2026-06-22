/**
 * POST/GET /api/cron/pms-backfill-missing-feeds (feat/cua-partial-promotion)
 *
 * Daily retry of feeds the robot has NOT learned yet. An admin-promoted
 * partial recipe goes live with `feedGaps` in the active knowledge envelope;
 * the CUA's zero-row self-repair never fires for those gaps (a never-learned
 * feed produces no zero-row streak, and an incomplete_columns feed extracts
 * rows that only die later in validateRows). This cron is the missing-feed
 * retry path: for each PMS family whose ACTIVE knowledge file has gaps,
 * enqueue ONE seeded mapper job. The mapper re-hunts everything not in the
 * seed. Outcomes (founder-gated, 2026-06-11): a COMPLETE result (all
 * required + ≥3 BC) auto-promotes; an improved-but-still-partial result
 * PARKS as a gap-annotated draft (park_partial) for the admin's Promote
 * click — nothing incomplete ever activates itself. The promote-time
 * superset + gap-shrink guards in cua-service/src/mapping-driver.ts keep
 * stale-seeded or no-progress results out of the admin's queue.
 *
 * Spend bounds (defense in depth):
 *  - flat per-job cost cap ($12 — the mapper hunts ALL unlearned catalogue
 *    targets, not just the gap set; there is no per-target allowlist input)
 *  - org-wide daily mapping cap re-checked at job RUN time (mapping-driver)
 *  - 20h family-level dedup vs ANY in-flight/recent mapper job
 *  - DRAFT-AWAITING-REVIEW gate: if a draft newer than the active exists,
 *    the family is skipped entirely — without this, park-not-promote would
 *    re-find the same feeds and stack a new $12 parked draft every day
 *    until the admin acts. Promoting (or discarding) the draft resumes
 *    the daily retries.
 *  - circuit breaker: 5 consecutive no-progress backfills since the active
 *    was promoted → stop until any promotion re-arms it
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
import { presenceFeedGaps, type FeedGaps } from '@/lib/pms/feed-status';

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
  promoted_to_active_at: string | null;
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

/** A backfill job "made progress" if it completed the recipe (auto_promote)
 *  OR parked an improved partial draft for the admin (park_partial — the
 *  gap-shrink guard guarantees park_partial backfills genuinely found
 *  something new). Failure statuses, plain park_draft (no progress /
 *  stale seed), and quarantine count toward the breaker — a job that keeps
 *  dying must not retry daily forever any more than one that keeps finding
 *  nothing. */
function madeProgress(job: JobRow): boolean {
  const decision = job.result?.promotion_decision;
  return decision === 'auto_promote' || decision === 'park_partial';
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
      .select('id, pms_family, version, promoted_to_active_at, knowledge')
      .eq('status', 'active')
      .is('deleted_at', null);
    if (kfErr) throw kfErr;

    for (const kf of (actives ?? []) as ActiveKfRow[]) {
      const family = kf.pms_family;
      // Review pass (Codex #10 / senior #7): a legacy partial active (no
      // envelope feedGaps — e.g. a manually-promoted pre-feature draft)
      // still classifies its missing required feeds 'learning' app-side,
      // so it must get the same daily retry. Presence-only fallback.
      const gaps = kf.knowledge?.feedGaps ?? presenceFeedGaps(kf.knowledge?.actions);
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

  // 1.5. Draft-awaiting-review gate (founder-gated park_partial): if a draft
  //      NEWER than the active is already parked, the admin has something to
  //      review — spending $12/day re-finding the same feeds and stacking
  //      parked drafts on top of it would be pure waste. Promote (or
  //      discard) the draft to resume daily retries. Any newer draft blocks
  //      (incl. self-repair regression parks): under manual-approval-first,
  //      pausing auto-spend while a human review is pending is the point.
  const { data: pendingDraft, error: draftErr } = await supabaseAdmin
    .from('pms_knowledge_files')
    .select('version')
    .eq('pms_family', family)
    .eq('status', 'draft')
    .is('deleted_at', null)
    .gt('version', kf.version)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (draftErr) throw draftErr;
  if (pendingDraft) {
    return {
      action: 'skipped',
      detail: `draft v${pendingDraft.version} is awaiting admin review (active is v${kf.version}) — promote or discard it in Manage maps to resume auto-retries`,
    };
  }

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

  // 3. Circuit breaker — N consecutive no-progress backfills SINCE THE
  //    CURRENT ACTIVE WAS PROMOTED → paused. Bounding the lookback to the
  //    active's promotion timestamp is the re-arm mechanism (senior review
  //    P1: an unbounded last-5 query latched forever — no repair, regenerate,
  //    or manual promote could ever reset it, because none of those carry
  //    the backfill flag). Now ANY promotion (admin repair-feed success,
  //    regenerate, manual promote, a backfill that found something) starts
  //    a fresh 5-attempt budget; a family that stays latched is one where
  //    nothing has improved despite 5 paid hunts — exactly when to stop
  //    spending until a human acts.
  let breakerQuery = supabaseAdmin
    .from('workflow_jobs')
    .select('status, result')
    .eq('kind', 'mapper.learn_pms_family')
    .filter('payload->>pms_family', 'eq', family)
    .filter('payload->>backfill_missing_feeds', 'eq', 'true')
    .order('created_at', { ascending: false })
    .limit(BREAKER_LOOKBACK);
  if (kf.promoted_to_active_at) {
    breakerQuery = breakerQuery.gt('created_at', kf.promoted_to_active_at);
  }
  const { data: lastJobs, error: lastErr } = await breakerQuery;
  if (lastErr) throw lastErr;
  const jobs = (lastJobs ?? []) as JobRow[];
  if (jobs.length >= BREAKER_LOOKBACK && jobs.every((j) => !madeProgress(j))) {
    return {
      action: 'breaker_paused',
      detail: `last ${BREAKER_LOOKBACK} backfills since active v${kf.version} made no progress — any promotion (repair-feed, regenerate, manual) re-arms`,
    };
  }

  // 4. Seed = active actions MINUS incomplete_columns-gapped targets. The
  //    mapper SKIPS every seeded key, so a present-but-dead feed must be
  //    dropped from the seed or it can never be re-learned (mirrors
  //    session-driver's `delete seedActions[key]`). Result handling lives
  //    in the gate: complete → auto_promote (live), improved-partial →
  //    park_partial (draft for the admin — step 1.5 above then pauses
  //    further spend), nothing new → park_draft (counts toward breaker).
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
