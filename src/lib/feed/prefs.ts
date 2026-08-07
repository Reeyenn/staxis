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
   * When this person last looked at their Staxis list, or null.
   *
   * Anything that arrived after this is marked new on its row and counted on
   * the tab. The same derived-not-stored shape as assignedSeenAt one field up,
   * and for the same reasons: one timestamp cannot get stuck, cannot be
   * delivered twice and cannot outlive the thing it is about. There is no
   * notification table and nothing to mark read.
   *
   * NULL means never looked, and that is deliberately not "everything is new
   * forever": the count is floored at a recent window, so somebody opening the
   * list for the first time is told about this week rather than about the
   * hotel's entire history. See countNewOnList.
   */
  listSeenAt: string | null;
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
  listSeenAt: null,
  companionMemory: null,
};

/**
 * Read, plus whether the read actually worked.
 *
 * `degraded` is the distinction the write path was missing. A failed read and a
 * genuinely-unset preference both produced DEFAULT_FEED_PREFS, so a merge on
 * top of a degraded read looked exactly like a merge on top of real values —
 * and wrote the defaults back over whatever was really in the row.
 *
 * EXPORTED, and callers that DERIVE their patch from what they read must use
 * this one rather than `readFeedPrefs`. The guard inside `writeFeedPrefs` can
 * only protect the halves of the row a caller did not mention; it cannot
 * protect a value the caller computed from a read that had already failed. See
 * the companion route, which reads a memory blob, applies a reducer to it, and
 * writes the answer back: on a degraded read that answer is a reduction of
 * nothing, and writing it erases the welcome stamp, every decline, both notices
 * cursors and the daily speech counter in one statement.
 */
export async function readFeedPrefsChecked(
  accountId: string,
  propertyId: string,
): Promise<{ prefs: FeedPrefs; degraded: boolean }> {
  const { data, error } = await supabaseAdmin
    .from('staxis_user_prefs')
    .select('logbook_in_list, assigned_seen_at, list_seen_at, companion_memory')
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
    list_seen_at?: string | null;
    companion_memory?: unknown;
  };
  return {
    prefs: {
      logbookInList: row.logbook_in_list === true,
      assignedSeenAt: row.assigned_seen_at ?? null,
      listSeenAt: row.list_seen_at ?? null,
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
  // Same degraded guard, and it matters just as much here: writing a default
  // null over a real cursor would re-flag every row on somebody's list as new.
  if (!degraded || next.listSeenAt !== undefined) row.list_seen_at = merged.listSeenAt;
  // The companion writes only its own key, and only ever the whole blob it just
  // derived from the value it read in the same request.
  //
  // AND THIS GUARD DOES NOT COVER THAT CALLER. Read the condition: the
  // companion route always sets `companionMemory`, so the right-hand side is
  // always true and the write always happens. That is correct here and it has
  // to be — the caller's blob is the only version of the memory that exists by
  // this point — which is exactly why the caller is the one that must refuse to
  // reduce a degraded read in the first place. It reads through
  // `readFeedPrefsChecked` and returns before it ever reaches this function.
  // What this line still protects is the OTHER half: a caller who never
  // mentioned the memory does not get the default written over it.
  if (!degraded || next.companionMemory !== undefined) row.companion_memory = merged.companionMemory ?? {};

  const { error } = await supabaseAdmin
    .from('staxis_user_prefs')
    .upsert(row, { onConflict: 'account_id,property_id' });
  if (error) throw new Error(error.message);
  return merged;
}
