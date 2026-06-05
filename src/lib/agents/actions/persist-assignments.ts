// ─── Persist housekeeping assignment decisions ─────────────────────────────
// Owned helper that mirrors the idempotent insert path in
// src/app/api/cron/run-auto-assign/route.ts: insert one hk_assignments row per
// decision (is_active, assigned_by:'auto'), catch 23505 (a concurrent placer
// won the race) as a no-op, and cache assignee_id back onto cleaning_tasks.
// Reusing assigned_by:'auto' means no enum/migration change to the hk tables.

import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';
import type { AssignmentDecision } from '@/lib/assignment-engine';

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PersistResult {
  placed: number;
  conflicts: number;
  failures: number;
}

export async function persistAssignmentDecisions(
  propertyId: string,
  decisions: AssignmentDecision[],
): Promise<PersistResult> {
  let placed = 0;
  let conflicts = 0;
  let failures = 0;

  for (const d of decisions) {
    const { error: insErr } = await supabaseAdmin.from('hk_assignments').insert({
      property_id: propertyId,
      cleaning_task_id: d.taskId,
      housekeeper_id: d.housekeeperId,
      queue_order: d.queueOrder,
      is_active: true,
      assigned_at: new Date().toISOString(),
      assigned_by: 'auto' as const,
      assigned_by_user_id: null,
      reason: d.reason,
      score: d.score,
    });

    if (insErr) {
      const code = (insErr as { code?: string }).code ?? '';
      // 23505 = the partial unique index on (cleaning_task_id) where is_active
      // fired: another placer (a cron tick, a manager reassign) got there
      // first. Treat as a successful no-op.
      if (code === '23505') {
        conflicts += 1;
        continue;
      }
      log.warn('agents/assign_rooms: hk_assignments insert failed', {
        propertyId, taskId: d.taskId, msg: insErr.message, code,
      });
      failures += 1;
      continue;
    }
    placed += 1;

    // Cache assignee on cleaning_tasks (guarded so a concurrent manual
    // reassign isn't clobbered — same guard run-auto-assign uses). The
    // housekeeperId is interpolated into a PostgREST `.or(...)` on the
    // RLS-bypassing admin client, so assert it's a clean UUID first
    // (defense-in-depth: it's always a DB gen_random_uuid() today).
    if (!UUID_RX.test(d.housekeeperId)) {
      log.warn('agents/assign_rooms: skipping cache update for non-UUID housekeeperId', { propertyId, taskId: d.taskId });
      continue;
    }
    const { error: updErr } = await supabaseAdmin
      .from('cleaning_tasks')
      .update({ assignee_id: d.housekeeperId })
      .eq('id', d.taskId)
      .eq('property_id', propertyId)
      .or(`assignee_id.is.null,assignee_id.eq.${d.housekeeperId}`);
    if (updErr) {
      log.warn('agents/assign_rooms: failed to cache assignee_id', {
        propertyId, taskId: d.taskId, msg: updErr.message,
      });
    }
  }

  return { placed, conflicts, failures };
}
