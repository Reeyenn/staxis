/**
 * POST /api/admin/mapper/coverage/edit-feed
 *   body: { pmsFamily, propertyId, targetKey, mode: 'edit' | 'add' }
 *
 * feature/cua-coverage-editor — re-point (edit) or add ONE feed via the SAME
 * founder point-and-click takeover the Learning Board uses. It enqueues a
 * single-target mapper run and PRE-OPENS a takeover so the robot pauses for the
 * founder the moment it reaches that feed (instead of racing the autonomous
 * agent — Codex/Claude review P0). The founder then drives the browser to the
 * right page and presses Finish; the worker re-extracts that feed's columns,
 * re-signs a new recipe version, and (on a complete result) auto-promotes it.
 *
 * Scoping (fixes the "add hunts the whole catalogue" cost/wrong-feed risk):
 *   - seed_actions = the active recipe's actions MINUS targetKey (preserves
 *     every other feed),
 *   - only_targets = [targetKey] so the mapper learns EXACTLY this feed.
 *
 * Only actions-shaped (mapper-produced) active maps are editable; a legacy
 * knowledge.feeds map must be re-learned once first (the UI gates this).
 * Drill-down feeds have no takeover gate and are rejected.
 *
 * Auth: requireAdmin. supabaseAdmin (service-role).
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import {
  parseKnowledgeCoverage,
  LEARNABLE_ACTION_KEYS,
  DRILLDOWN_ACTION_KEYS,
  ACTION_FEED_CONTRACTS,
} from '@/lib/pms/recipe-coverage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface KnowledgeRow {
  id: string;
  version: number;
  knowledge: {
    actions?: Record<string, unknown>;
    valueTranslations?: unknown;
    dateFormat?: unknown;
  };
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const admin = await requireAdmin(req);
  if (!admin.ok) return err('Unauthorized', { requestId, status: 401, code: 'unauthorized' });

  let body: { pmsFamily?: unknown; propertyId?: unknown; targetKey?: unknown; mode?: unknown };
  try { body = await req.json(); } catch {
    return err('Invalid JSON', { requestId, status: 400, code: 'bad_request' });
  }
  if (typeof body.propertyId !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.propertyId)) {
    return err('propertyId must be a uuid', { requestId, status: 400, code: 'bad_request' });
  }
  if (typeof body.targetKey !== 'string' || !body.targetKey) {
    return err('targetKey required', { requestId, status: 400, code: 'bad_request' });
  }
  const mode = body.mode === 'add' ? 'add' : 'edit';
  const targetKey = body.targetKey;

  // The feed must be mapper-learnable and not a drill-down feed (no takeover gate).
  if (!LEARNABLE_ACTION_KEYS.has(targetKey)) {
    return err(`"${targetKey}" isn't a feed the robot can learn by takeover.`, { requestId, status: 400, code: 'bad_request' });
  }
  if (DRILLDOWN_ACTION_KEYS.has(targetKey)) {
    return err(`"${targetKey}" is a drill-down feed and can't be re-pointed by takeover yet.`, { requestId, status: 400, code: 'bad_request' });
  }

  // SECURITY (Codex review): derive pms_family from THIS property's session —
  // never trust the client's pmsFamily. propertyId drives the logged-in CUA
  // session/credentials, so a mismatched family/property could learn one PMS
  // using another property's session, or edit the wrong family's map.
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

  // Load the active knowledge file for the family.
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
    return err(`no active map for ${pmsFamily} — there's nothing to edit yet.`, { requestId, status: 404, code: 'not_found' });
  }

  const parsed = parseKnowledgeCoverage(activeRow.knowledge);
  if (!parsed.editable) {
    return err('This map predates per-feed editing. Re-learn this PMS once to enable editing individual feeds.', {
      requestId, status: 409, code: 'conflict',
    });
  }

  const allActions = (activeRow.knowledge?.actions ?? {}) as Record<string, unknown>;
  const isPresent = targetKey in allActions;
  if (mode === 'edit' && !isPresent) {
    return err(`"${targetKey}" isn't in this map — use Add instead.`, { requestId, status: 409, code: 'conflict' });
  }
  if (mode === 'add' && isPresent) {
    return err(`"${targetKey}" is already in this map — use Edit to re-point it.`, { requestId, status: 409, code: 'conflict' });
  }

  // seed_actions = every OTHER feed (so they survive untouched); only_targets
  // scopes the run to exactly this feed.
  const seedActions: Record<string, unknown> = { ...allActions };
  delete seedActions[targetKey];

  // Time-salted idempotency key so the founder can re-edit the same feed more
  // than once a day (repair-feed's date-stamped key would 23505 the 2nd try).
  // Client disables the button while in-flight to absorb double-clicks.
  const idempotencyKey = `mapper.coverage_edit:${pmsFamily}:${targetKey}:${Date.now()}`;

  const { data: inserted, error: insErr } = await supabaseAdmin
    .from('workflow_jobs')
    .insert({
      property_id: body.propertyId,
      kind: 'mapper.learn_pms_family',
      idempotency_key: idempotencyKey,
      max_attempts: 1,
      triggered_by: `admin:${admin.accountId}:coverage-${mode}`,
      payload: {
        pms_family: pmsFamily,
        property_id: body.propertyId,
        // Single feed → tight cap; the founder drives via takeover so spend is small.
        cost_cap_micros: 4_000_000,
        seed_actions: seedActions,
        // Single-target allowlist — learn EXACTLY this feed (no catalogue hunt).
        only_targets: [targetKey],
        // Start-paused / assist-first: the WORKER pre-opens the takeover for this
        // feed once the run starts, so its finally→close() always cleans it up
        // (a never-claimed job never leaves a phantom takeover). See
        // mapping-driver runMappingJob.
        assist_first: true,
        // Carry the other feeds' learned vocabulary/date order forward.
        seed_value_translations: activeRow.knowledge?.valueTranslations,
        seed_date_format: activeRow.knowledge?.dateFormat,
        // Audit + board labelling.
        repair_target_key: targetKey,
        repaired_from_version: activeRow.version,
        coverage_edit_mode: mode,
      },
    })
    .select('id')
    .single<{ id: string }>();

  if (insErr || !inserted) {
    return err(`could not start the edit run: ${insErr?.message ?? 'unknown'}`, { requestId, status: 500, code: 'db_error' });
  }

  return ok({
    jobId: inserted.id,
    mode,
    targetKey,
    label: ACTION_FEED_CONTRACTS[targetKey]?.label ?? targetKey,
    boardUrl: `/admin/properties/mapper/${inserted.id}`,
    note: 'Run started. On the board, drive the robot to the page that shows this feed, then press Finish.',
  }, { requestId });
}
