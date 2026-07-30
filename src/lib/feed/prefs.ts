// ═══════════════════════════════════════════════════════════════════════════
// One person's choices about their Staxis list.
//
// Backing table: staxis_user_prefs (migration 0410), service-role only. Keyed
// (account, hotel), so the same person can want their log book merged in at one
// hotel and not at another — a VP covering twelve hotels genuinely does.
//
// A MISSING ROW IS NOT AN ERROR. It is the default, and the default is off: the
// log book is a place you go, and a hotel that has never opened the switch
// should not find its shift notes interleaved with its money.
// ═══════════════════════════════════════════════════════════════════════════

import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';

export interface FeedPrefs {
  /** "Include log book in Staxis". */
  logbookInList: boolean;
  /**
   * When this person last opened their Assigned-by-me drawer, or null.
   *
   * Anything they handed out that got settled AFTER this is news, and shows as
   * a one-line notice on their list. NULL means never opened, and that is the
   * right default: the first task that comes back is what teaches somebody the
   * drawer is there.
   */
  assignedSeenAt: string | null;
}

export const DEFAULT_FEED_PREFS: FeedPrefs = { logbookInList: false, assignedSeenAt: null };

export async function readFeedPrefs(accountId: string, propertyId: string): Promise<FeedPrefs> {
  const { data, error } = await supabaseAdmin
    .from('staxis_user_prefs')
    .select('logbook_in_list, assigned_seen_at')
    .eq('account_id', accountId)
    .eq('property_id', propertyId)
    .maybeSingle();
  if (error) {
    // Degrade to the default rather than failing the whole list read. A
    // preference is the least important thing on the screen; the work is not.
    log.warn('[feed-prefs] read failed', { propertyId, err: error.message });
    return DEFAULT_FEED_PREFS;
  }
  if (!data) return DEFAULT_FEED_PREFS;
  const row = data as { logbook_in_list?: boolean; assigned_seen_at?: string | null };
  return {
    logbookInList: row.logbook_in_list === true,
    assignedSeenAt: row.assigned_seen_at ?? null,
  };
}

export async function writeFeedPrefs(
  accountId: string,
  propertyId: string,
  next: Partial<FeedPrefs>,
): Promise<FeedPrefs> {
  const current = await readFeedPrefs(accountId, propertyId);
  const merged: FeedPrefs = { ...current, ...next };
  const { error } = await supabaseAdmin
    .from('staxis_user_prefs')
    .upsert(
      {
        account_id: accountId,
        property_id: propertyId,
        logbook_in_list: merged.logbookInList,
        assigned_seen_at: merged.assignedSeenAt,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'account_id,property_id' },
    );
  if (error) throw new Error(error.message);
  return merged;
}
