// ═══════════════════════════════════════════════════════════════════════════
// ONE QUERY, TWO CONSUMERS.
//
// The notices list in the companion panel and the `staxis_assignments` chat
// tool answer the same question about the same rows, and they answer it from
// this function. That is not tidiness: a list and an answer that disagreed
// about what happened would be worse than either on its own, because the person
// would have no way to tell which one was lying. So there is one derivation and
// two renderings of it, and the test asserts they match.
//
// ─── WHY IT LIVES BESIDE worklist/core RATHER THAN INSIDE IT ───────────────
//
// `gatherAssignedByMe` already answers "what did I hand out and where did it
// get to", and this file USES it rather than re-querying — the settled half of
// a notice is exactly that drawer's rows, filtered to the ones somebody else
// settled inside the window. What worklist has no reason to know is the other
// half: what was handed TO this person, which is not a worklist question (that
// work is already on their own list) but is very much a notice.
//
// ─── SCOPE IS THE WHOLE SECURITY STORY ─────────────────────────────────────
//
// Every read here is filtered by `property_id` AND by this person's own staff
// id, in the query, on the server. A notice is only ever about work you handed
// out or work you were handed. There is no argument that widens it, no name to
// pass, and no way to ask about somebody else's assignments — which is what
// keeps the chat tool from becoming a way to read the hotel's whole task board
// through a side door.
// ═══════════════════════════════════════════════════════════════════════════

import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';
import { gatherAssignedByMe } from '@/lib/worklist/core';
import type { AssignedByMeItem } from '@/lib/worklist/types';
import {
  NOTICE_LIMIT,
  NOTICE_WINDOW_DAYS,
  noticeSentence,
  sortNotices,
  type AssignmentNotice,
} from './notices';

export interface NoticeQuery {
  propertyId: string;
  /** The caller's own `staff.id` at this hotel. Never from a request body. */
  staffId: string;
  now?: Date;
  windowDays?: number;
  limit?: number;
}

/**
 * Every notice for one person at one hotel, newest first.
 *
 * Fails SOFT per half. A failed read of one side degrades to fewer notices,
 * never to an exception: the companion is a greeter, not a dependency, and a
 * panel that refused to open because a task query hiccuped would be a worse
 * product than one that briefly knows about less.
 */
export async function loadAssignmentNotices(q: NoticeQuery): Promise<AssignmentNotice[]> {
  const now = q.now ?? new Date();
  const windowDays = q.windowDays ?? NOTICE_WINDOW_DAYS;
  const limit = q.limit ?? NOTICE_LIMIT;
  const floor = new Date(now.getTime() - windowDays * 86_400_000).toISOString();

  const [settled, handedToMe] = await Promise.all([
    loadSettledByOthers(q.propertyId, q.staffId, now, floor),
    loadHandedToMe(q.propertyId, q.staffId, floor, limit),
  ]);

  return sortNotices([...settled, ...handedToMe]).slice(0, limit);
}

/**
 * Work this person handed out that somebody ELSE finished or refused.
 *
 * `keepForAssigner` inside `gatherAssignedByMe` has already dropped the rows
 * this person settled themselves, which is the important half: telling somebody
 * they finished their own to-do is the app narrating them back to themselves.
 */
async function loadSettledByOthers(
  propertyId: string,
  staffId: string,
  now: Date,
  floor: string,
): Promise<AssignmentNotice[]> {
  let items: AssignedByMeItem[];
  try {
    items = await gatherAssignedByMe(propertyId, staffId, now);
  } catch (e) {
    log.warn('[notices] assigned-by-me read failed; notices degrade to fewer rows', {
      pid: propertyId, err: e instanceof Error ? e.message : String(e),
    });
    return [];
  }

  const out: AssignmentNotice[] = [];
  for (const item of items) {
    if (item.state === 'waiting') continue;
    if (!item.settledAt || item.settledAt < floor) continue;
    // Belt and braces on top of keepForAssigner: a notice about yourself is
    // never news, and this is cheaper to hold here than to re-derive later.
    if (item.settledByStaffId === staffId) continue;
    const kind = item.state === 'done' ? 'done' as const : 'refused' as const;
    out.push({
      id: `${kind}:${item.taskId}`,
      kind,
      taskId: item.taskId,
      at: item.settledAt,
      personName: item.settledByName ?? item.assigneeName ?? null,
      title: item.title,
      reason: kind === 'refused' ? item.reason : null,
      sentence: noticeSentence({
        kind,
        personName: item.settledByName ?? item.assigneeName ?? null,
        title: item.title,
        reason: kind === 'refused' ? item.reason : null,
      }),
    });
  }
  return out;
}

/**
 * Work somebody handed TO this person, by name, inside the window.
 *
 * Named assignments only. A to-do left for a whole department was not handed to
 * anybody in particular, and telling four people they were each personally
 * given the same job is how a shared list turns into four arguments about who
 * was supposed to do it. It is on their Staxis list either way.
 *
 * A person assigning something to themselves gets no notice, for the same
 * reason a person finishing their own to-do gets none.
 */
async function loadHandedToMe(
  propertyId: string,
  staffId: string,
  floor: string,
  limit: number,
): Promise<AssignmentNotice[]> {
  const { data, error } = await supabaseAdmin
    .from('comms_tasks')
    .select('id, title, created_at, created_by_staff_id')
    .eq('property_id', propertyId)
    .eq('assigned_staff_id', staffId)
    .neq('created_by_staff_id', staffId)
    .not('created_by_staff_id', 'is', null)
    .gte('created_at', floor)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    log.warn('[notices] handed-to-me read failed; notices degrade to fewer rows', {
      pid: propertyId, err: error.message,
    });
    return [];
  }

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const names = await staffNames(
    propertyId,
    rows.map((r) => r.created_by_staff_id as string | null).filter((x): x is string => !!x),
  );

  return rows.map((r) => {
    const authorId = (r.created_by_staff_id as string | null) ?? null;
    const personName = authorId ? names.get(authorId) ?? null : null;
    const title = String(r.title ?? '');
    const taskId = String(r.id);
    return {
      id: `assigned:${taskId}`,
      kind: 'assigned' as const,
      taskId,
      at: String(r.created_at ?? ''),
      personName,
      title,
      reason: null,
      sentence: noticeSentence({ kind: 'assigned', personName, title, reason: null }),
    };
  }).filter((n) => n.at.length > 0);
}

/** Staff ids to display names, scoped to the hotel. Empty on any failure. */
async function staffNames(propertyId: string, ids: string[]): Promise<Map<string, string>> {
  const unique = Array.from(new Set(ids.filter(Boolean)));
  if (unique.length === 0) return new Map();
  const { data, error } = await supabaseAdmin
    .from('staff')
    .select('id, name')
    .eq('property_id', propertyId)
    .in('id', unique);
  if (error) {
    log.warn('[notices] staff name read failed; notices name nobody', {
      pid: propertyId, err: error.message,
    });
    return new Map();
  }
  return new Map(
    ((data ?? []) as Array<{ id: string; name: string | null }>)
      .filter((r) => typeof r.name === 'string' && r.name.trim().length > 0)
      .map((r) => [r.id, (r.name as string).trim()]),
  );
}
