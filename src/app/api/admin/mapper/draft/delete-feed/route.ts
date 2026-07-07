/**
 * POST /api/admin/mapper/draft/delete-feed
 *   body: { jobId, feedKey }              — Learning Board path (resolves the run's draft)
 *      OR { draftId, propertyId, feedKey } — Coverage Editor path (parked-draft review)
 *
 * Per-feed DELETE on a PARKED DRAFT, BEFORE the map goes live. A founder
 * reviewing a finished run can drop a feed the robot mis-mapped (a wrong screen,
 * a junk extra feed) so it isn't carried into the live recipe — then either
 * re-run that feed or save the rest.
 *
 * feature/coverage-show-draft — the Coverage Editor ("What the robot captures")
 * also shows a PARKED DRAFT when there's no live map, and removes feeds from it.
 * That path knows the draft's id directly (not a jobId), so the route accepts
 * `draftId` (+ `propertyId`, needed to enqueue the worker job) as an alternative
 * to `jobId`. Both resolve to the same draft row and enqueue the identical
 * re-signing worker job below.
 *
 * fix/cua-draft-resign — the bug this closes: this route used to delete
 * knowledge.actions[feedKey] and re-save the draft row with a PLAIN in-place
 * jsonb UPDATE via supabaseAdmin. But a draft is NOT unsigned — it is signed at
 * learn time (HMAC over `knowledge`, keyed by the Fly-only RECIPE_SIGNING_KEY,
 * which the web can NEVER produce) and the worker verifies that seal before it
 * will honour the draft. Editing the jsonb in place silently broke the seal, so
 * promoting the edited draft made the worker REFUSE it and auto-trigger a fresh
 * ~$25 re-learn. So the delete now enqueues the SAME `mapper.edit_recipe` worker
 * job the LIVE-map edits use (draft op `draft_delete_feeds`); the worker edits
 * the draft row IN PLACE (same id, same version, re-signed) and stamps
 * result.knowledge_file_id = the draft id, so the client polls
 * GET /api/admin/mapper/live/[jobId] to completion.
 *
 * SAFETY — the route fast-fails (the worker re-validates authoritatively):
 *   1. The draft must NOT be active (409) — once live, edits go through the
 *      Coverage Editor's signed-envelope path, never here.
 *   2. The feed must NOT be a REQUIRED feed (400) — dropping room status /
 *      arrivals / departures / work orders would cripple every hotel on the
 *      family; the never-zero / required-feed guards own that decision.
 *   3. Deleting it must NOT empty the map (400) — a zero-feed draft is useless
 *      and would trip the promote guards anyway.
 *
 * Auth: requireAdmin. supabaseAdmin (pms_knowledge_files is deny-all-browser).
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { REQUIRED_ACTION_KEYS } from '@/lib/pms/recipe-coverage';
import { draftDeleteFeedsPayload } from '@/lib/pms/draft-edit-ops';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f-]{36}$/i;
const FEED_KEY = /^[A-Za-z0-9_.-]{1,80}$/;

/** The draft row + the property/family we enqueue the worker job against. Both
 *  entry paths resolve to this shape so the rest of the route is identical. */
interface ResolvedDraft {
  id: string;
  version: number;
  status: string;
  pmsFamily: string;
  propertyId: string;
  knowledge: { actions?: Record<string, unknown> };
}

type ResolveResult =
  | { ok: true; row: ResolvedDraft }
  | { ok: false; status: number; message: string };

/** Learning Board path — resolve the draft the run produced, AND carry the
 *  original job's property_id/pms_family forward for the new worker job. */
async function resolveFromJob(jobId: string): Promise<ResolveResult> {
  const { data: job, error: jobErr } = await supabaseAdmin
    .from('workflow_jobs')
    .select('id, property_id, payload, result')
    .eq('id', jobId)
    .maybeSingle();
  if (jobErr) return { ok: false, status: 500, message: `job lookup failed: ${jobErr.message}` };
  if (!job) return { ok: false, status: 404, message: 'job not found' };

  const result = (job.result ?? {}) as Record<string, unknown>;
  const knowledgeFileId = typeof result.knowledge_file_id === 'string' ? result.knowledge_file_id : null;
  if (!knowledgeFileId) {
    return { ok: false, status: 400, message: "Nothing to edit — this run didn't produce a map yet." };
  }
  if (typeof job.property_id !== 'string') {
    return { ok: false, status: 409, message: 'This run has no property — refresh and try again.' };
  }

  const { data, error: e } = await supabaseAdmin
    .from('pms_knowledge_files')
    .select('id, version, status, pms_family, knowledge')
    .eq('id', knowledgeFileId)
    .is('deleted_at', null)
    .maybeSingle();
  if (e) return { ok: false, status: 500, message: `draft lookup failed: ${e.message}` };
  if (!data) return { ok: false, status: 404, message: 'The map this run produced no longer exists.' };
  return {
    ok: true,
    row: {
      id: data.id as string,
      version: data.version as number,
      status: data.status as string,
      pmsFamily: data.pms_family as string,
      propertyId: job.property_id,
      knowledge: (data.knowledge ?? {}) as { actions?: Record<string, unknown> },
    },
  };
}

/** Coverage Editor path — resolve the draft directly by its knowledge-file id.
 *  propertyId comes from the caller (the editor is already property-scoped) and
 *  is verified to sit on the SAME family as the draft (anti-spoof: never enqueue
 *  one family's edit against another family's session/property). */
async function resolveFromDraftId(draftId: string, propertyId: string): Promise<ResolveResult> {
  const { data, error: e } = await supabaseAdmin
    .from('pms_knowledge_files')
    .select('id, version, status, pms_family, knowledge')
    .eq('id', draftId)
    .is('deleted_at', null)
    .maybeSingle();
  if (e) return { ok: false, status: 500, message: `draft lookup failed: ${e.message}` };
  if (!data) return { ok: false, status: 404, message: 'The map no longer exists.' };

  const { data: sessionRow, error: sessErr } = await supabaseAdmin
    .from('property_sessions')
    .select('pms_family')
    .eq('property_id', propertyId)
    .maybeSingle();
  if (sessErr) return { ok: false, status: 500, message: `could not load session: ${sessErr.message}` };
  if (!sessionRow) return { ok: false, status: 404, message: 'This property has no CUA session.' };
  if ((sessionRow.pms_family as string) !== (data.pms_family as string)) {
    return { ok: false, status: 409, message: 'This map changed since you opened it — refresh and try again.' };
  }

  return {
    ok: true,
    row: {
      id: data.id as string,
      version: data.version as number,
      status: data.status as string,
      pmsFamily: data.pms_family as string,
      propertyId,
      knowledge: (data.knowledge ?? {}) as { actions?: Record<string, unknown> },
    },
  };
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const admin = await requireAdmin(req);
  if (!admin.ok) return admin.response;

  let body: { jobId?: unknown; draftId?: unknown; propertyId?: unknown; feedKey?: unknown };
  try { body = await req.json(); } catch {
    return err('Invalid JSON', { requestId, status: 400, code: 'bad_request' });
  }
  const hasJobId = typeof body.jobId === 'string' && UUID.test(body.jobId);
  const hasDraftId = typeof body.draftId === 'string' && UUID.test(body.draftId);
  if (!hasJobId && !hasDraftId) {
    return err('jobId or draftId (a uuid) is required', { requestId, status: 400, code: 'bad_request' });
  }
  // The draftId path enqueues a worker job, which needs a property_id (the
  // workflow_jobs.property_id column is NOT NULL); the editor always has it.
  const hasPropertyId = typeof body.propertyId === 'string' && UUID.test(body.propertyId);
  if (hasDraftId && !hasPropertyId) {
    return err('propertyId (a uuid) is required', { requestId, status: 400, code: 'bad_request' });
  }
  if (typeof body.feedKey !== 'string' || !FEED_KEY.test(body.feedKey)) {
    return err('feedKey is required', { requestId, status: 400, code: 'bad_request' });
  }
  const feedKey = body.feedKey;

  // Never let a delete hit a REQUIRED feed — that's guard territory. (The worker
  // re-checks; this is the fast-fail so the founder gets an instant, clear no.)
  if (REQUIRED_ACTION_KEYS.has(feedKey)) {
    return err(
      'This is a core feed the robot must always read — it can’t be removed here.',
      { requestId, status: 400, code: 'required_feed' },
    );
  }

  const draft = hasDraftId
    ? await resolveFromDraftId(body.draftId as string, body.propertyId as string)
    : await resolveFromJob(body.jobId as string);
  if (!draft.ok) return err(draft.message, { requestId, status: draft.status, code: 'bad_request' });

  // Once active, edits go through the signed Coverage Editor path — never here.
  if (draft.row.status === 'active') {
    return err(
      'This map is already live — remove feeds from the Coverage Editor instead.',
      { requestId, status: 409, code: 'already_live' },
    );
  }

  const actions = draft.row.knowledge.actions && typeof draft.row.knowledge.actions === 'object'
    && !Array.isArray(draft.row.knowledge.actions)
    ? (draft.row.knowledge.actions as Record<string, unknown>)
    : null;
  if (!actions || !(feedKey in actions)) {
    // Already gone (double-click / stale board) — idempotent success, no job.
    return ok({ removed: false, reason: 'not_present', remaining: actions ? Object.keys(actions).length : 0 }, { requestId });
  }

  // Refuse to empty the map — a zero-feed draft is useless and trips promote.
  if (Object.keys(actions).length <= 1) {
    return err(
      'This is the only feed left — removing it would leave nothing to go live.',
      { requestId, status: 400, code: 'would_empty_map' },
    );
  }

  // Enqueue the re-signing worker job (fix/cua-draft-resign). The worker deletes
  // the feed from the draft's knowledge, re-signs the SAME row (id + version
  // preserved), and stamps result.knowledge_file_id = the draft id so the client
  // polls GET /api/admin/mapper/live/[jobId]. Time-salted idempotency key so the
  // founder can drop more than one feed on the same draft in a day.
  const { data: inserted, error: insErr } = await supabaseAdmin
    .from('workflow_jobs')
    .insert({
      property_id: draft.row.propertyId,
      kind: 'mapper.edit_recipe',
      idempotency_key: `mapper.draft_feed_delete:${draft.row.pmsFamily}:${feedKey}:${Date.now()}`,
      max_attempts: 1,
      triggered_by: `admin:${admin.accountId}:draft-delete-feed`,
      payload: {
        pms_family: draft.row.pmsFamily,
        property_id: draft.row.propertyId,
        edited_from_version: draft.row.version,
        ...draftDeleteFeedsPayload({ draftId: draft.row.id, feedKeys: [feedKey] }),
      },
    })
    .select('id')
    .single<{ id: string }>();
  if (insErr || !inserted) {
    return err(`could not start the edit: ${insErr?.message ?? 'unknown'}`, { requestId, status: 500, code: 'db_error' });
  }

  return ok(
    { jobId: inserted.id, feedKey, fromVersion: draft.row.version, note: 'Removing the feed and re-saving the draft…' },
    { requestId },
  );
}
