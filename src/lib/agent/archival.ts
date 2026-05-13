// ─── Conversation archival ─────────────────────────────────────────────────
// Moves stale conversations (>90 days dormant) out of the hot tables into
// `_archived` tables. Keeps them queryable for restore. The cron at
// /api/cron/agent-archive-stale-conversations calls archiveStaleBatch
// daily; the admin restore endpoint calls restoreConversation.
//
// All DB-side work is atomic via the RPCs from migration 0105.
//
// Longevity L4 part A, 2026-05-13.

import { supabaseAdmin } from '@/lib/supabase-admin';

/** How long a conversation must sit untouched before it's eligible to
 *  archive. 90 days is generous — protects against a user who comes
 *  back to a long-dormant conversation. */
export const ARCHIVE_MIN_AGE_DAYS = 90;

/** Hard cap on conversations archived per cron run. Keeps each run
 *  inside Vercel's maxDuration ceiling and gives the next run a
 *  chance to drain the rest. */
export const ARCHIVE_BATCH_SIZE = 500;

export interface ArchiveBatchResult {
  scanned: number;
  archived: number;
  skipped: number;
  oldestStillEligibleAgeDays: number | null;
  errors: number;
}

/**
 * Archive a single conversation by ID. Atomic — DB-side advisory lock
 * + transactional INSERT-then-DELETE. Re-checks eligibility inside the
 * lock so a concurrent route message can't race us.
 *
 * Returns the number of messages moved, or -1 if the conversation is
 * no longer eligible (someone touched it after the cron picked it up).
 */
export async function archiveConversation(conversationId: string): Promise<number> {
  const { data, error } = await supabaseAdmin.rpc('staxis_archive_conversation', {
    p_conversation_id: conversationId,
    p_min_age_days: ARCHIVE_MIN_AGE_DAYS,
  });
  if (error) throw new Error(`staxis_archive_conversation failed: ${error.message}`);
  return Number(data ?? -1);
}

/**
 * Restore an archived conversation to the hot tables. Used by an admin
 * endpoint when a user reports a missing old conversation.
 *
 * Returns the number of messages restored, or -1 if the conversation
 * isn't in the archive (likely never archived, or restored twice).
 */
export async function restoreConversation(conversationId: string): Promise<number> {
  const { data, error } = await supabaseAdmin.rpc('staxis_restore_conversation', {
    p_conversation_id: conversationId,
  });
  if (error) throw new Error(`staxis_restore_conversation failed: ${error.message}`);
  return Number(data ?? -1);
}

/**
 * Scan for stale conversations and archive a batch. Idempotent — re-running
 * after a partial completion picks up where the prior run left off, ordered
 * by oldest-first so the longest-stale rows clear first.
 */
export async function archiveStaleBatch(): Promise<ArchiveBatchResult> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - ARCHIVE_MIN_AGE_DAYS);
  const cutoffIso = cutoff.toISOString();

  // Find candidates: stale, oldest first.
  const { data: candidates, error: scanErr } = await supabaseAdmin
    .from('agent_conversations')
    .select('id, updated_at')
    .lt('updated_at', cutoffIso)
    .order('updated_at', { ascending: true })
    .limit(ARCHIVE_BATCH_SIZE);

  if (scanErr) {
    throw new Error(`archive scan failed: ${scanErr.message}`);
  }

  const rows = candidates ?? [];
  let archived = 0;
  let skipped = 0;
  let errors = 0;

  for (const row of rows) {
    try {
      const moved = await archiveConversation(row.id as string);
      if (moved < 0) skipped += 1;
      else archived += 1;
    } catch (err) {
      errors += 1;
      console.error('[archival] failed to archive conversation', { id: row.id, err });
    }
  }

  // What's the oldest still-eligible conversation we DIDN'T touch? Helps
  // operators see the backlog drain over consecutive cron runs.
  let oldestStillEligibleAgeDays: number | null = null;
  if (rows.length === ARCHIVE_BATCH_SIZE) {
    const { data: next } = await supabaseAdmin
      .from('agent_conversations')
      .select('updated_at')
      .lt('updated_at', cutoffIso)
      .order('updated_at', { ascending: true })
      .limit(1);
    const ts = (next ?? [])[0]?.updated_at as string | undefined;
    if (ts) {
      oldestStillEligibleAgeDays = Math.floor(
        (Date.now() - new Date(ts).getTime()) / (24 * 60 * 60 * 1000),
      );
    }
  }

  return {
    scanned: rows.length,
    archived,
    skipped,
    oldestStillEligibleAgeDays,
    errors,
  };
}

export interface ArchivedConversationSummary {
  id: string;
  title: string | null;
  role: string;
  property_id: string;
  user_id: string;
  message_count: number;
  archived_at: string;
  created_at: string;
  updated_at: string;
}

/** Admin-only — list recently-archived conversations for a restore UI. */
export async function listRecentlyArchived(limit = 50): Promise<ArchivedConversationSummary[]> {
  const { data, error } = await supabaseAdmin
    .from('agent_conversations_archived')
    .select('id, title, role, property_id, user_id, message_count, archived_at, created_at, updated_at')
    .order('archived_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listRecentlyArchived failed: ${error.message}`);
  return (data ?? []) as ArchivedConversationSummary[];
}

/** Counts surfaced on /admin/agent. */
export async function archivalMetrics(): Promise<{
  archivedTotal: number;
  archivedToday: number;
}> {
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);

  const [totalRes, todayRes] = await Promise.all([
    supabaseAdmin
      .from('agent_conversations_archived')
      .select('id', { count: 'exact', head: true }),
    supabaseAdmin
      .from('agent_conversations_archived')
      .select('id', { count: 'exact', head: true })
      .gte('archived_at', dayStart.toISOString()),
  ]);

  return {
    archivedTotal: totalRes.count ?? 0,
    archivedToday: todayRes.count ?? 0,
  };
}
