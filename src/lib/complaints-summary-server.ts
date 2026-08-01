import 'server-only';

import { supabaseAdmin } from '@/lib/supabase-admin';
import type { ComplaintDashboardSummary } from '@/lib/complaints-summary';
import {
  COMPLAINT_OVERDUE_HOURS,
  COMPLAINT_OVERDUE_HOURS_HIGH,
} from '@/lib/complaints-shared';

type CountResult = {
  count: number | null;
  error: { message: string } | null;
};

function requiredCount(result: CountResult, label: string): number {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.count ?? 0;
}

/**
 * Count-only query layer. No complaint row — and therefore no guest name,
 * contact, description, room number, or recovery notes — crosses the API.
 */
export async function loadComplaintDashboardSummary(
  propertyId: string,
  now = new Date(),
): Promise<Extract<ComplaintDashboardSummary, { visible: true }>> {
  const highCutoff = new Date(
    now.getTime() - COMPLAINT_OVERDUE_HOURS_HIGH * 3_600_000,
  ).toISOString();
  const standardCutoff = new Date(
    now.getTime() - COMPLAINT_OVERDUE_HOURS * 3_600_000,
  ).toISOString();
  const nowIso = now.toISOString();

  const [openResult, highOverdueResult, standardOverdueResult, callbacksDueResult] = await Promise.all([
    supabaseAdmin
      .from('complaints')
      .select('id', { count: 'exact', head: true })
      .eq('property_id', propertyId)
      .in('status', ['open', 'in_progress']),
    supabaseAdmin
      .from('complaints')
      .select('id', { count: 'exact', head: true })
      .eq('property_id', propertyId)
      .in('status', ['open', 'in_progress'])
      .eq('severity', 'high')
      .lt('created_at', highCutoff),
    supabaseAdmin
      .from('complaints')
      .select('id', { count: 'exact', head: true })
      .eq('property_id', propertyId)
      .in('status', ['open', 'in_progress'])
      .neq('severity', 'high')
      .lt('created_at', standardCutoff),
    supabaseAdmin
      .from('complaints')
      .select('id', { count: 'exact', head: true })
      .eq('property_id', propertyId)
      .eq('callback_done', false)
      .not('callback_at', 'is', null)
      .lte('callback_at', nowIso),
  ]);

  const highOverdue = requiredCount(highOverdueResult, 'high-severity overdue complaints');
  const standardOverdue = requiredCount(standardOverdueResult, 'standard overdue complaints');

  return {
    visible: true,
    open: requiredCount(openResult, 'open complaints'),
    overdue: highOverdue + standardOverdue,
    callbacksDue: requiredCount(callbacksDueResult, 'due complaint callbacks'),
  };
}
