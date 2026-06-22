/**
 * GET /api/admin/mapper/feed-detail?jobId=<uuid>&feedKey=<key>
 *
 * Per-feed REVIEW on the LIVE Mapping Board. Surfaces the LEARNED COLUMNS the
 * mapper recorded for one feed (field → selector) so a founder, before going
 * live, can confirm the robot is reading the right fields off the page — the
 * read-only twin of the source-screenshot the sibling feed-capture route shows.
 *
 * Resolves the draft from the job (resolveDraftForJob — STRICT, same id Save &
 * Finish / Discard use, so the review and the action can never refer to a
 * different run's map), reads knowledge.actions[feedKey], and runs
 * columnsFromAction(action) for the column map. Also echoes a small
 * rowCount/sample when the job's live boardTargets carry one for the feed (the
 * same source the board's per-feed expand already paints).
 *
 * GRACEFUL BY DESIGN — mirrors feed-capture EXACTLY: any miss (job/draft not
 * found, feed absent, junk row) degrades to ok with an empty column map, never
 * a 500. The review panel then shows a calm "no columns learned" empty state.
 *
 * Auth: requireAdmin. supabaseAdmin (pms_knowledge_files is deny-all-browser).
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { resolveDraftForJob } from '@/lib/pms/job-draft';
import { columnsFromAction } from '@/lib/pms/recipe-coverage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f-]{36}$/i;
// Mapper target keys ("getRoomStatus") + legacy feed names — bounded so a junk
// query param can't fan out. Mirrors feed-capture's FEED_KEY.
const FEED_KEY = /^[A-Za-z0-9_.-]{1,80}$/;

/** The empty review payload — every miss collapses to this (never a 500). */
function emptyDetail(): { columns: Record<string, string>; columnCount: number; rowCount: number | null; sample: Array<Record<string, unknown>> } {
  return { columns: {}, columnCount: 0, rowCount: null, sample: [] };
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const admin = await requireAdmin(req);
  if (!admin.ok) return admin.response;

  const sp = req.nextUrl.searchParams;
  const jobId = sp.get('jobId') ?? '';
  const feedKey = sp.get('feedKey') ?? '';

  // Bad params still degrade to the empty state (the board expand calls this
  // opportunistically) rather than erroring the whole feed row.
  if (!UUID.test(jobId) || !FEED_KEY.test(feedKey)) {
    return ok(emptyDetail(), { requestId });
  }

  try {
    const draft = await resolveDraftForJob(jobId);
    if (!draft.ok) return ok(emptyDetail(), { requestId });

    // Read the draft FRESH (resolveDraftForJob doesn't select knowledge).
    const { data, error } = await supabaseAdmin
      .from('pms_knowledge_files')
      .select('knowledge')
      .eq('id', draft.row.id)
      .maybeSingle();
    if (error || !data) return ok(emptyDetail(), { requestId });

    const knowledge = (data.knowledge ?? {}) as { actions?: Record<string, unknown> };
    const actions = knowledge.actions && typeof knowledge.actions === 'object' && !Array.isArray(knowledge.actions)
      ? knowledge.actions
      : null;
    if (!actions || !(feedKey in actions)) return ok(emptyDetail(), { requestId });

    const columns = columnsFromAction(actions[feedKey]);

    // rowCount/sample, if the live run already carries one for this feed in
    // workflow_jobs.result.boardTargets (same source the board expand reads).
    let rowCount: number | null = null;
    let sample: Array<Record<string, unknown>> = [];
    try {
      const { data: jobRow } = await supabaseAdmin
        .from('workflow_jobs')
        .select('result')
        .eq('id', jobId)
        .maybeSingle();
      const result = (jobRow?.result ?? {}) as { boardTargets?: unknown };
      const boardTargets = Array.isArray(result.boardTargets) ? result.boardTargets : [];
      const target = boardTargets.find(
        (t): t is Record<string, unknown> =>
          !!t && typeof t === 'object' && (t as Record<string, unknown>).key === feedKey,
      );
      if (target) {
        const rc = target.rowCount;
        if (typeof rc === 'number') rowCount = rc;
        if (Array.isArray(target.sample)) {
          sample = (target.sample as Array<Record<string, unknown>>).slice(0, 3);
        }
      }
    } catch {
      rowCount = null;
      sample = [];
    }

    return ok(
      { columns, columnCount: Object.keys(columns).length, rowCount, sample },
      { requestId },
    );
  } catch {
    // ANY failure (table missing, jsonb shape, transient db) → empty state.
    return ok(emptyDetail(), { requestId });
  }
}
