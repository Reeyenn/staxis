/**
 * POST /api/admin/mapper/repair-feed
 *
 * Plan v8 self-repair — manual trigger. Admin spots a feed returning
 * 0 rows that historically had data, clicks "Repair this feed" in the
 * Onboarding tab → this endpoint fires a tiny single-target re-learn
 * for just that broken selector (~$2 vs $25 full re-map).
 *
 * Request body:
 *   {
 *     pmsFamily: 'choice_advantage' | ...
 *     propertyId: uuid
 *     targetKey: keyof Recipe['actions']   // e.g. 'getRoomStatus'
 *   }
 *
 * What this does:
 *   1. Loads the currently-active knowledge file for the PMS family
 *   2. Builds payload.seed_actions = knowledge.actions MINUS targetKey
 *   3. INSERTs a mapper.learn_pms_family workflow_jobs row with:
 *        - cost_cap_micros = $2 (single target, tighter budget)
 *        - seed_actions = pre-populated all-other-targets
 *   4. cua-service's workflow-runtime picks it up, runs mapping-driver
 *      which calls mapPMS with seedActions populated, so only the
 *      target needing repair gets re-learned
 *   5. New knowledge file version is saved + auto-promoted
 *
 * Auth: requireAdmin.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';

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
  if (!admin.ok) {
    return err('Unauthorized', { requestId, status: 401, code: 'unauthorized' });
  }

  let body: { pmsFamily?: unknown; propertyId?: unknown; targetKey?: unknown };
  try { body = await req.json(); } catch {
    return err('Invalid JSON', { requestId, status: 400, code: 'bad_request' });
  }
  if (typeof body.pmsFamily !== 'string' || !body.pmsFamily) {
    return err('pmsFamily required', { requestId, status: 400, code: 'bad_request' });
  }
  if (typeof body.propertyId !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.propertyId)) {
    return err('propertyId must be a uuid', { requestId, status: 400, code: 'bad_request' });
  }
  if (typeof body.targetKey !== 'string' || !body.targetKey) {
    return err('targetKey required', { requestId, status: 400, code: 'bad_request' });
  }

  // Load current active knowledge file to extract its actions.
  const { data: activeRow, error: loadErr } = await supabaseAdmin
    .from('pms_knowledge_files')
    .select('id, version, knowledge')
    .eq('pms_family', body.pmsFamily)
    .eq('status', 'active')
    .maybeSingle<KnowledgeRow>();
  if (loadErr) {
    return err(`could not load active recipe: ${loadErr.message}`, {
      requestId, status: 500, code: 'db_error',
    });
  }
  if (!activeRow) {
    return err(
      `no active knowledge file for ${body.pmsFamily} — repair only works on existing recipes`,
      { requestId, status: 404, code: 'not_found' },
    );
  }

  const allActions = (activeRow.knowledge?.actions ?? {}) as Record<string, unknown>;
  if (!(body.targetKey in allActions)) {
    return err(
      `targetKey ${body.targetKey} not present in active recipe — nothing to repair`,
      { requestId, status: 400, code: 'bad_request' },
    );
  }

  // Build seed_actions = all actions EXCEPT the failing one. The mapper
  // will skip the 12 we've seeded and re-learn only the dropped one.
  const seedActions: Record<string, unknown> = { ...allActions };
  delete seedActions[body.targetKey];

  // Idempotency key — one repair job in-flight per (family, target).
  // If admin clicks "Repair" twice in a row before the first finishes,
  // the second INSERT returns 23505 + we report "already running."
  const idempotencyKey = `mapper.repair:${body.pmsFamily}:${body.targetKey}`;

  const { data: inserted, error: insErr } = await supabaseAdmin
    .from('workflow_jobs')
    .insert({
      property_id: body.propertyId,
      kind: 'mapper.learn_pms_family',
      idempotency_key: idempotencyKey,
      // max_attempts=1 (Plan v8 final review B1 — failed repair requires
      // admin re-trigger, no silent auto-replay burning money).
      max_attempts: 1,
      triggered_by: `admin:${admin.accountId}:repair-feed`,
      payload: {
        pms_family: body.pmsFamily,
        property_id: body.propertyId,
        // Tight cap — one target, ~$1-2 in vision.
        cost_cap_micros: 2_000_000,
        // The whole point — seed all-other-actions so mapper skips them.
        seed_actions: seedActions,
        // For audit + the admin UI to render "Repairing X"
        repair_target_key: body.targetKey,
        repaired_from_version: activeRow.version,
      },
    })
    .select('id')
    .single<{ id: string }>();

  if (insErr?.code === '23505') {
    return ok({
      enqueued: false,
      reason: `repair already in-flight for ${body.pmsFamily}/${body.targetKey}`,
    }, { requestId });
  }
  if (insErr || !inserted) {
    return err(`enqueue failed: ${insErr?.message ?? 'unknown'}`, {
      requestId, status: 500, code: 'db_error',
    });
  }

  return ok({
    enqueued: true,
    jobId: inserted.id,
    droppedTarget: body.targetKey,
    fromVersion: activeRow.version,
    estimatedCostDollars: 1.5,
    note: 'Watch live at /admin/properties/mapper/' + inserted.id,
  }, { requestId });
}
