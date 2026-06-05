// ─── Scope: staff ───────────────────────────────────────────────────────────
// Service-role read of the staff roster (who's on, by department, working today).

import { registerScope } from './registry';
import { supabaseAdmin } from '@/lib/supabase-admin';
import type { AgentScopeContext } from '@/lib/agents/types';

const STAFF_LIST_CAP = 300;

registerScope({
  key: 'staff',
  label: { en: 'Staff roster', es: 'Personal' },
  async read(ctx: AgentScopeContext) {
    const { data, error } = await supabaseAdmin
      .from('staff')
      .select('id, name, department, is_active, scheduled_today, is_senior')
      .eq('property_id', ctx.propertyId);
    if (error) throw new Error(`staff scope: ${error.message}`);
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    const active = rows.filter((s) => s.is_active !== false);
    const byDepartment: Record<string, number> = {};
    let workingToday = 0;
    const staff: Array<{ id: string; name: string; department: string | null; scheduledToday: boolean; isSenior: boolean }> = [];
    for (const s of active) {
      const dept = (s.department as string | null) ?? 'other';
      byDepartment[dept] = (byDepartment[dept] ?? 0) + 1;
      if (s.scheduled_today === true) workingToday += 1;
      if (staff.length < STAFF_LIST_CAP) {
        staff.push({
          id: String(s.id),
          name: String(s.name ?? ''),
          department: (s.department as string | null) ?? null,
          scheduledToday: s.scheduled_today === true,
          isSenior: s.is_senior === true,
        });
      }
    }
    return { total: active.length, workingToday, byDepartment, staff };
  },
});
