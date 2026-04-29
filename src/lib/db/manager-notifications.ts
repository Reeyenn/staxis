// ═══════════════════════════════════════════════════════════════════════════
// Manager Notifications — Mario / Maria's bell-icon inbox. Things like
// "new flagged cleaning event needs review" or "scraper down".
// ═══════════════════════════════════════════════════════════════════════════

import type { ManagerNotification } from '@/types';
import { supabase, logErr, subscribeTable } from './_common';
import { fromManagerNotificationRow } from '../db-mappers';

export function subscribeToManagerNotifications(
  _uid: string, pid: string,
  callback: (notifications: ManagerNotification[]) => void,
): () => void {
  return subscribeTable<ManagerNotification>(
    `manager_notifications:${pid}`, 'manager_notifications', `property_id=eq.${pid}`,
    async () => {
      const { data, error } = await supabase
        .from('manager_notifications').select('*')
        .eq('property_id', pid)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data ?? []).map(fromManagerNotificationRow);
    },
    callback,
  );
}

export async function markNotificationRead(_uid: string, _pid: string, nid: string): Promise<void> {
  const { error } = await supabase.from('manager_notifications').update({ read: true }).eq('id', nid);
  if (error) { logErr('markNotificationRead', error); throw error; }
}

export async function markAllNotificationsRead(_uid: string, pid: string): Promise<void> {
  const { error } = await supabase
    .from('manager_notifications').update({ read: true })
    .eq('property_id', pid).eq('read', false);
  if (error) { logErr('markAllNotificationsRead', error); throw error; }
}
