// ═══════════════════════════════════════════════════════════════════════════
// Complaints — client/realtime READ layer (anon client + RLS, like work_orders).
//
// Writes do NOT go through here: they go through /api/complaints/* (server,
// supabaseAdmin) so the AI classify / auto-route / SMS pipeline can run and so
// the agent + voice paths share one code path. This module is read-only +
// realtime for the authed manager UI (Front Desk > Complaints tab, Dashboard
// tile). Refetch-on-change per _common.ts (never diff-merge on the client).
// ═══════════════════════════════════════════════════════════════════════════

import { supabase, logErr, subscribeTable } from './_common';
import { type Complaint, fromComplaintRow } from '../complaints-shared';

export function subscribeToComplaints(
  _uid: string, pid: string,
  callback: (complaints: Complaint[]) => void,
): () => void {
  return subscribeTable<Complaint>(
    `complaints:${pid}`, 'complaints', `property_id=eq.${pid}`,
    async () => {
      const { data, error } = await supabase
        .from('complaints').select('*')
        .eq('property_id', pid)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data ?? []).map((r) => fromComplaintRow(r as Record<string, unknown>));
    },
    callback,
  );
}

/** One-shot fetch (used where a subscription is overkill). */
export async function fetchComplaints(pid: string): Promise<Complaint[]> {
  try {
    const { data, error } = await supabase
      .from('complaints').select('*')
      .eq('property_id', pid)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data ?? []).map((r) => fromComplaintRow(r as Record<string, unknown>));
  } catch (err) {
    logErr('fetchComplaints', err);
    return [];
  }
}
