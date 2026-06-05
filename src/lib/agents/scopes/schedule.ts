// ─── Scope: schedule ────────────────────────────────────────────────────────
// Service-role read of the day's cleaning workload (cleaning_tasks for the
// resolved business_date). Do NOT reuse the anon db/schedule-assignments
// helper — it's RLS-scoped and would return [] from a cron context.

import { registerScope } from './registry';
import { supabaseAdmin } from '@/lib/supabase-admin';
import type { AgentScopeContext } from '@/lib/agents/types';

registerScope({
  key: 'schedule',
  label: { en: "Today's cleaning workload", es: 'Carga de limpieza del día' },
  async read(ctx: AgentScopeContext) {
    const { data, error } = await supabaseAdmin
      .from('cleaning_tasks')
      .select('id, status, assignee_id, priority')
      .eq('property_id', ctx.propertyId)
      .eq('business_date', ctx.asOfDate);
    if (error) throw new Error(`schedule scope: ${error.message}`);
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    const byStatus: Record<string, number> = {};
    let unassigned = 0;
    for (const t of rows) {
      const st = String(t.status ?? 'unknown');
      byStatus[st] = (byStatus[st] ?? 0) + 1;
      if (t.assignee_id === null || t.assignee_id === undefined) unassigned += 1;
    }
    return { date: ctx.asOfDate, totalTasks: rows.length, byStatus, unassigned };
  },
});
