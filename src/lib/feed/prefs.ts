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
  /**
   * What the companion remembers about this person at this hotel.
   *
   * Lives here rather than in its own store because 0410 said the next
   * per-person thing should be a column on this table, and because it is read
   * on the same key at the same moment as the rest of this row. Kept as the raw
   * jsonb value: this module has no business knowing the shape, and the one
   * place that does is parseCompanionMemory() in src/lib/companion/manners.ts.
   * Nothing that comes out of here is trusted until it has been through that.
   */
  companionMemory: unknown;
}

export const DEFAULT_FEED_PREFS: FeedPrefs = {
  logbookInList: false,
  assignedSeenAt: null,
  companionMemory: null,
};

/**
 * Read, plus whether the read actually worked.
 *
 * `degraded` is the distinction the write path was missing. A failed read and a
 * genuinely-unset preference both produced DEFAULT_FEED_PREFS, so a merge on
 * top of a degraded read looked exactly like a merge on top of real values —
 * and wrote the defaults back over whatever was really in the row.
 */
async function readFeedPrefsChecked(
  accountId: string,
  propertyId: string,
): Promise<{ prefs: FeedPrefs; degraded: boolean }> {
  const { data, error } = await supabaseAdmin
    .from('staxis_user_prefs')
    .select('logbook_in_list, assigned_seen_at, companion_memory')
    .eq('account_id', accountId)
    .eq('property_id', propertyId)
    .maybeSingle();
  if (error) {
    // Degrade to the default rather than failing the whole list read. A
    // preference is the least important thing on the screen; the work is not.
    log.warn('[feed-prefs] read failed', { propertyId, err: error.message });
    return { prefs: DEFAULT_FEED_PREFS, degraded: true };
  }
  if (!data) return { prefs: DEFAULT_FEED_PREFS, degraded: false };
  const row = data as {
    logbook_in_list?: boolean;
    assigned_seen_at?: string | null;
    companion_memory?: unknown;
  };
  return {
    prefs: {
      logbookInList: row.logbook_in_list === true,
      assignedSeenAt: row.assigned_seen_at ?? null,
      companionMemory: row.companion_memory ?? null,
    },
    degraded: false,
  };
}

export async function readFeedPrefs(accountId: string, propertyId: string): Promise<FeedPrefs> {
  return (await readFeedPrefsChecked(accountId, propertyId)).prefs;
}

export async function writeFeedPrefs(
  accountId: string,
  propertyId: string,
  next: Partial<FeedPrefs>,
): Promise<FeedPrefs> {
  const { prefs: current, degraded } = await readFeedPrefsChecked(accountId, propertyId);
  const merged: FeedPrefs = { ...current, ...next };

  // ── never write back a value we only guessed ─────────────────────────────
  // The patches are genuinely partial: turning the log book on says nothing
  // about the drawer, and marking the drawer seen says nothing about the log
  // book. On a healthy read the merge fills the untouched half with its real
  // value. On a FAILED read it filled it with the default, and the upsert then
  // wrote that default over the truth — switching somebody's log book off, or
  // re-flagging every assignment they had already seen, with a 200 and no sign
  // anything was lost. When the read degraded, write only what the caller
  // actually asked for and leave the rest of the row alone.
  const row: Record<string, unknown> = {
    account_id: accountId,
    property_id: propertyId,
    updated_at: new Date().toISOString(),
  };
  if (!degraded || next.logbookInList !== undefined) row.logbook_in_list = merged.logbookInList;
  if (!degraded || next.assignedSeenAt !== undefined) row.assigned_seen_at = merged.assignedSeenAt;
  // The companion writes only its own key, and only ever the whole blob it just
  // derived from the value it read in the same request. The degraded guard
  // matters most here: a failed read followed by an unguarded write would erase
  // a welcome stamp, and the visible symptom of that is the companion
  // introducing itself to somebody for the second time.
  if (!degraded || next.companionMemory !== undefined) row.companion_memory = merged.companionMemory ?? {};

  const { error } = await supabaseAdmin
    .from('staxis_user_prefs')
    .upsert(row, { onConflict: 'account_id,property_id' });
  if (error) throw new Error(error.message);
  return merged;
}
