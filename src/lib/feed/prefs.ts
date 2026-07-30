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
}

export const DEFAULT_FEED_PREFS: FeedPrefs = { logbookInList: false };

export async function readFeedPrefs(accountId: string, propertyId: string): Promise<FeedPrefs> {
  const { data, error } = await supabaseAdmin
    .from('staxis_user_prefs')
    .select('logbook_in_list')
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
  return { logbookInList: (data as { logbook_in_list?: boolean }).logbook_in_list === true };
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
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'account_id,property_id' },
    );
  if (error) throw new Error(error.message);
  return merged;
}
