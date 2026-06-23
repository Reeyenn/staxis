/**
 * POST /api/admin/mapper/draft/delete-feed
 *   body: { jobId, feedKey }   — Learning Board path (resolves the run's draft)
 *      OR { draftId, feedKey } — Coverage Editor path (parked-draft review)
 *
 * Per-feed DELETE on the LIVE Mapping Board, BEFORE the map goes live. A founder
 * reviewing a finished run can drop a feed the robot mis-mapped (a wrong screen,
 * a junk extra feed) so it isn't carried into the live recipe — then either
 * re-run that feed or save the rest.
 *
 * feature/coverage-show-draft — the Coverage Editor ("What the robot captures")
 * now also shows a PARKED DRAFT when there's no live map, and removes feeds from
 * it. That path knows the draft's id directly (not a jobId), so the route accepts
 * `draftId` as an alternative to `jobId`. Both resolve to the same draft row and
 * run the identical plain-jsonb edit + safety checks below.
 *
 * SAFETY (the route refuses, in order):
 *   1. The draft must NOT be active (409) — once live, edits go through the
 *      Coverage Editor's signed-envelope path, never a raw jsonb write here.
 *   2. The feed must NOT be a REQUIRED feed (400) — dropping room status /
 *      arrivals / departures / work orders would cripple every hotel on the
 *      family; the never-zero / required-feed guards own that decision.
 *   3. Deleting it must NOT empty the map (400) — a zero-feed draft is useless
 *      and would trip the promote guards anyway.
 *
 * Then it deletes knowledge.actions[feedKey] and re-saves the draft row with a
 * PLAIN jsonb UPDATE. NO re-signing and NO worker run: drafts are unsigned and
 * are verified ONLY at promote time (Save & Finish → promoteMap), so editing a
 * draft's jsonb in place is safe and never touches the signed-envelope path or
 * any guard.
 *
 * Auth: requireAdmin. supabaseAdmin (pms_knowledge_files is deny-all-browser).
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { resolveDraftForJob, type ResolveDraftResult, type DraftRow } from '@/lib/pms/job-draft';
import { REQUIRED_ACTION_KEYS } from '@/lib/pms/recipe-coverage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f-]{36}$/i;
const FEED_KEY = /^[A-Za-z0-9_.-]{1,80}$/;

/** Resolve a draft row directly by its knowledge-file id (Coverage Editor path).
 *  Mirror of resolveDraftForJob's success/failure shape so the rest of the route
 *  is identical regardless of how the draft was identified. */
async function resolveDraftById(draftId: string): Promise<ResolveDraftResult> {
  const { data, error: e } = await supabaseAdmin
    .from('pms_knowledge_files')
    .select('id, version, status, pms_family')
    .eq('id', draftId)
    .is('deleted_at', null)
    .maybeSingle();
  if (e) return { ok: false, status: 500, message: `draft lookup failed: ${e.message}` };
  if (!data) return { ok: false, status: 404, message: 'The map no longer exists.' };
  return { ok: true, row: data as DraftRow };
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const admin = await requireAdmin(req);
  if (!admin.ok) return admin.response;

  let body: { jobId?: unknown; draftId?: unknown; feedKey?: unknown };
  try { body = await req.json(); } catch {
    return err('Invalid JSON', { requestId, status: 400, code: 'bad_request' });
  }
  const hasJobId = typeof body.jobId === 'string' && UUID.test(body.jobId);
  const hasDraftId = typeof body.draftId === 'string' && UUID.test(body.draftId);
  if (!hasJobId && !hasDraftId) {
    return err('jobId or draftId (a uuid) is required', { requestId, status: 400, code: 'bad_request' });
  }
  if (typeof body.feedKey !== 'string' || !FEED_KEY.test(body.feedKey)) {
    return err('feedKey is required', { requestId, status: 400, code: 'bad_request' });
  }
  const feedKey = body.feedKey;

  // Never let a raw jsonb write hit a REQUIRED feed — that's guard territory.
  if (REQUIRED_ACTION_KEYS.has(feedKey)) {
    return err(
      'This is a core feed the robot must always read — it can’t be removed here.',
      { requestId, status: 400, code: 'required_feed' },
    );
  }

  const draft = hasDraftId
    ? await resolveDraftById(body.draftId as string)
    : await resolveDraftForJob(body.jobId as string);
  if (!draft.ok) return err(draft.message, { requestId, status: draft.status, code: 'bad_request' });

  // Once active, edits go through the signed Coverage Editor path — never here.
  if (draft.row.status === 'active') {
    return err(
      'This map is already live — remove feeds from the Coverage Editor instead.',
      { requestId, status: 409, code: 'already_live' },
    );
  }

  // Read the draft's knowledge FRESH (resolveDraftForJob doesn't select it).
  const { data: row, error: loadErr } = await supabaseAdmin
    .from('pms_knowledge_files')
    .select('knowledge')
    .eq('id', draft.row.id)
    .maybeSingle();
  if (loadErr) {
    return err(`could not load the draft: ${loadErr.message}`, { requestId, status: 500, code: 'db_error' });
  }
  if (!row) {
    return err('The map this run produced no longer exists.', { requestId, status: 404, code: 'not_found' });
  }

  const knowledge = (row.knowledge ?? {}) as { actions?: Record<string, unknown> };
  const actions = knowledge.actions && typeof knowledge.actions === 'object' && !Array.isArray(knowledge.actions)
    ? { ...(knowledge.actions as Record<string, unknown>) }
    : null;
  if (!actions || !(feedKey in actions)) {
    // Already gone (double-click / stale board) — idempotent success.
    return ok({ removed: false, reason: 'not_present', remaining: actions ? Object.keys(actions).length : 0 }, { requestId });
  }

  // Refuse to empty the map — a zero-feed draft is useless and trips promote.
  if (Object.keys(actions).length <= 1) {
    return err(
      'This is the only feed left — removing it would leave nothing to go live.',
      { requestId, status: 400, code: 'would_empty_map' },
    );
  }

  delete actions[feedKey];
  const nextKnowledge = { ...knowledge, actions };

  // Plain jsonb UPDATE on a DRAFT — no re-sign, no worker. Scope to the draft
  // status too, so a concurrent promote (draft → active) can't be overwritten.
  const { data: updated, error: upErr } = await supabaseAdmin
    .from('pms_knowledge_files')
    .update({ knowledge: nextKnowledge })
    .eq('id', draft.row.id)
    .neq('status', 'active')
    .select('id')
    .maybeSingle();
  if (upErr) {
    return err(`could not save the draft: ${upErr.message}`, { requestId, status: 500, code: 'db_error' });
  }
  if (!updated) {
    // The row flipped to active between our check and the write — refuse.
    return err(
      'This map just went live — remove feeds from the Coverage Editor instead.',
      { requestId, status: 409, code: 'already_live' },
    );
  }

  return ok(
    { removed: true, feedKey, remaining: Object.keys(actions).length },
    { requestId },
  );
}
