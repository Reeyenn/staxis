/**
 * POST /api/admin/mapper/coverage/delete-feed
 *   body: { pmsFamily, propertyId, targetKey }
 *
 * feature/cua-coverage-editor — remove ONE feed from a family's active recipe.
 *
 * A recipe change must be re-signed (RECIPE_SIGNING_KEY is Fly-only), so this
 * can't be an app-side jsonb edit. It enqueues a non-browser `mapper.edit_recipe`
 * worker job; the worker loads the LIVE active map, drops the feed, re-signs a
 * new draft version, and promotes it under the never-zero-active, base-guarded
 * primitive (cua-service/src/recipe-edit.ts). The UI polls
 * GET /api/admin/mapper/live/[jobId] for completion.
 *
 * Guards here are fast-fail UX checks; the worker re-validates authoritatively
 * against the live active map:
 *   - the map must be actions-shaped (editable),
 *   - the feed must be present,
 *   - REQUIRED feeds (room status / arrivals / departures / work orders) can't
 *     be removed — they're core feeds the app depends on (re-point with Edit),
 *   - the last remaining feed can't be removed (never empty the recipe).
 *
 * Auth: requireAdmin. supabaseAdmin (service-role).
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { parseKnowledgeCoverage, REQUIRED_ACTION_KEYS } from '@/lib/pms/recipe-coverage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface KnowledgeRow {
  id: string;
  version: number;
  knowledge: { actions?: Record<string, unknown> };
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const admin = await requireAdmin(req);
  if (!admin.ok) return err('Unauthorized', { requestId, status: 401, code: 'unauthorized' });

  let body: { pmsFamily?: unknown; propertyId?: unknown; targetKey?: unknown };
  try { body = await req.json(); } catch {
    return err('Invalid JSON', { requestId, status: 400, code: 'bad_request' });
  }
  if (typeof body.propertyId !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.propertyId)) {
    return err('propertyId must be a uuid', { requestId, status: 400, code: 'bad_request' });
  }
  if (typeof body.targetKey !== 'string' || !body.targetKey) {
    return err('targetKey required', { requestId, status: 400, code: 'bad_request' });
  }
  const targetKey = body.targetKey;

  if (REQUIRED_ACTION_KEYS.has(targetKey)) {
    return err('Room status, arrivals, departures and work orders are core feeds the app depends on — they can’t be removed. Re-point one with Edit instead.', {
      requestId, status: 409, code: 'conflict',
    });
  }

  // SECURITY (Codex review): derive pms_family from THIS property's session —
  // never trust the client's pmsFamily (a mismatched family/property could
  // delete a feed from the wrong family's map).
  const { data: sessionRow, error: sessErr } = await supabaseAdmin
    .from('property_sessions')
    .select('pms_family')
    .eq('property_id', body.propertyId)
    .maybeSingle();
  if (sessErr) return err(`could not load session: ${sessErr.message}`, { requestId, status: 500, code: 'db_error' });
  if (!sessionRow) return err('This property has no CUA session.', { requestId, status: 404, code: 'not_found' });
  const pmsFamily = sessionRow.pms_family as string;
  if (typeof body.pmsFamily === 'string' && body.pmsFamily && body.pmsFamily !== pmsFamily) {
    return err('This map changed since you opened it — refresh and try again.', { requestId, status: 409, code: 'conflict' });
  }

  const { data: activeRow, error: loadErr } = await supabaseAdmin
    .from('pms_knowledge_files')
    .select('id, version, knowledge')
    .eq('pms_family', pmsFamily)
    .eq('status', 'active')
    .maybeSingle<KnowledgeRow>();
  if (loadErr) {
    return err(`could not load active map: ${loadErr.message}`, { requestId, status: 500, code: 'db_error' });
  }
  if (!activeRow) {
    return err(`no active map for ${pmsFamily} — there's nothing to delete.`, { requestId, status: 404, code: 'not_found' });
  }

  const parsed = parseKnowledgeCoverage(activeRow.knowledge);
  if (!parsed.editable) {
    return err('This map predates per-feed editing. Re-learn this PMS once to enable editing individual feeds.', {
      requestId, status: 409, code: 'conflict',
    });
  }

  const actions = (activeRow.knowledge?.actions ?? {}) as Record<string, unknown>;
  if (!(targetKey in actions)) {
    return err(`"${targetKey}" isn't in this map.`, { requestId, status: 409, code: 'conflict' });
  }
  if (Object.keys(actions).length <= 1) {
    return err('This is the only feed left — removing it would leave the map empty. Take the whole map offline in Manage maps instead.', {
      requestId, status: 409, code: 'conflict',
    });
  }

  const idempotencyKey = `mapper.coverage_delete:${pmsFamily}:${targetKey}:${Date.now()}`;

  const { data: inserted, error: insErr } = await supabaseAdmin
    .from('workflow_jobs')
    .insert({
      property_id: body.propertyId,
      kind: 'mapper.edit_recipe',
      idempotency_key: idempotencyKey,
      max_attempts: 1,
      triggered_by: `admin:${admin.accountId}:coverage-delete`,
      payload: {
        pms_family: pmsFamily,
        property_id: body.propertyId,
        edit_op: 'delete_feeds',
        delete_target_keys: [targetKey],
        deleted_from_version: activeRow.version,
      },
    })
    .select('id')
    .single<{ id: string }>();

  if (insErr || !inserted) {
    return err(`could not start the delete: ${insErr?.message ?? 'unknown'}`, { requestId, status: 500, code: 'db_error' });
  }

  return ok({
    jobId: inserted.id,
    targetKey,
    fromVersion: activeRow.version,
    note: 'Removing the feed and re-publishing the map…',
  }, { requestId });
}
