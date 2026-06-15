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
 *   5. New knowledge file version is saved; a COMPLETE result
 *      auto-promotes, an incomplete one parks as a draft for the admin's
 *      Promote click (founder-gated, feat/cua-partial-promotion)
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
  knowledge: {
    actions?: Record<string, unknown>;
    valueTranslations?: unknown;
    dateFormat?: unknown;
  };
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  // Codebase-standard admin gate — return requireAdmin's response verbatim
  // (correct 403 for a non-admin session) instead of re-minting a flat 401.
  const admin = await requireAdmin(req);
  if (!admin.ok) return admin.response;

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
  // feat/cua-partial-promotion — a target ABSENT from the recipe is now a
  // legal repair: it's the manual re-arm for a partial promotion's missing
  // feed (and resets the backfill cron's no-progress breaker if it works).
  // Previously this 400'd ("nothing to repair"), leaving a $25-40 full
  // regenerate as the only path to chase one missing feed.
  const isAbsentTarget = !(body.targetKey in allActions);

  // Build seed_actions = all actions EXCEPT the failing one. The mapper
  // skips every seeded key, so for a present-but-broken target we drop it;
  // for an absent target the seed is simply the full current action set.
  const seedActions: Record<string, unknown> = { ...allActions };
  delete seedActions[body.targetKey];

  // Idempotency key — one ADMIN repair per (family, target) PER DAY.
  // Review pass (senior #3): the undated key + the permanent
  // (property_id, idempotency_key) unique meant a failed chase could never
  // be retried on the same property — and this route is now the manual
  // re-arm path for partial promotions. Date-stamping allows a daily retry
  // while still absorbing double-clicks; the session-driver's AUTO-repair
  // key stays undated on purpose (its no-silent-retry semantics).
  const day = new Date().toISOString().slice(0, 10);
  const idempotencyKey = `mapper.repair:${body.pmsFamily}:${body.targetKey}:${day}`;

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
        // Present target: tight cap (~$1-2, one re-learn). Absent target:
        // higher cap — the mapper has no per-target allowlist, so it hunts
        // EVERY unlearned catalogue target and cheaper-tier ones may consume
        // budget before reaching the requested feed.
        cost_cap_micros: isAbsentTarget ? 6_000_000 : 2_000_000,
        // The whole point — seed all-other-actions so mapper skips them.
        seed_actions: seedActions,
        // Preserve the family's learned value translation across the repair
        // (skipped targets aren't re-learned, so without these the new
        // version would drop the other feeds' enum vocabulary + date order —
        // same rule session-driver's auto-repair already follows).
        seed_value_translations: activeRow.knowledge?.valueTranslations,
        seed_date_format: activeRow.knowledge?.dateFormat,
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
    estimatedCostDollars: isAbsentTarget ? 4 : 1.5,
    note: isAbsentTarget
      ? `Learning a feed this recipe never had — other unlearned targets may consume budget first, so it can take a couple of runs. Watch live at /admin/properties/mapper/${inserted.id}`
      : 'Watch live at /admin/properties/mapper/' + inserted.id,
  }, { requestId });
}
