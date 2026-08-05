// ─── What you asked people to do, and what came back ───────────────────────
//
// ONE read-only tool over the SAME query the companion's notices list reads
// (src/lib/companion/notices-server.ts). That sharing is the point rather than
// an economy: before this, "what does Marcus still owe me" had an answer on one
// surface (the assigned-by-me drawer) and no answer at all in the chat, and the
// obvious fix — a second query written for the model — would have produced two
// answers to one question that could quietly disagree. A person told one thing
// by the list and another by the conversation has no way to know which is
// wrong, and the product's whole claim is that it is the one that is right.
//
// ─── SCOPE IS THE SECURITY BOUNDARY, AND IT IS IN THE QUERY ────────────────
//
// `loadAssignmentNotices` filters on `property_id` AND on the caller's own
// `staff.id`, on the server, in the query. There is no argument here that names
// a person, a department or a hotel, and there deliberately never will be: the
// moment this tool could be pointed at somebody else it would be a way to read
// the hotel's whole task board through a chat window, which is a different
// feature with a different gate.
//
// So the only thing the model can vary is the WINDOW and the SHAPE of the
// answer, and both of those are bounded here.
//
// ─── WHY IT DOES NOT OFFER TO REASSIGN ─────────────────────────────────────
//
// Because there is no reassign tool in the catalog. `create_todo` exists and is
// the honest follow-up for "remind him tomorrow"; changing an existing task's
// assignee has no wire, and the charter's honesty clause is exactly about not
// offering one. The description says so in as many words, so the model reaches
// for create_todo rather than inventing a capability and then failing at it.

import { registerTool, type ToolResult, type ToolHandlerContext } from '../tools';
import { loadAssignmentNotices } from '@/lib/companion/notices-server';
import {
  NOTICE_LIMIT,
  NOTICE_WINDOW_DAYS,
  type AssignmentNotice,
} from '@/lib/companion/notices';
import { gatherAssignedByMe } from '@/lib/worklist/core';

/**
 * Every hat that has a chat at all.
 *
 * Housekeeping is absent, and it is absent by the same rule everywhere else:
 * that hat has no chat mounted (see lenses.ts and companion/mount.ts), so this
 * tool is never in its catalog. It is left off the list as well so the two
 * gates agree rather than one relying on the other.
 *
 * Everyone else is included, including the floor hats, because "what was I
 * asked to do this week" is a fair question from anybody who can be asked to do
 * anything, and the query only ever answers it about themselves.
 */
const ASSIGNMENT_ROLES = [
  'admin', 'owner', 'general_manager', 'front_desk', 'maintenance', 'staff',
] as const;

/** How far back the model may look. Bounded so one turn cannot pull a year. */
const MAX_WINDOW_DAYS = 30;

registerTool<{ days?: number; state?: string }>({
  name: 'staxis_assignments',
  section: 'staxis',
  pmsFreshness: 'independent',
  description:
    'Work handed between this person and their team: what somebody gave THEM, what they handed OUT that got done, and what came back refused with the reason. Reads the hotel\'s own to-do rows. '
    + 'Use when: the user asks about work they delegated or were delegated. "What does Marcus still owe me", "what got done today", "who refused tasks this week", "what did I ask people to do", "did anyone finish the boiler check", "what came back". This is also the tool behind the Notices list in the helper panel, so its answers and that list always agree. '
    + 'Args: days — how far back to look, default 7, maximum 30. state — optional filter: "outstanding" for work handed out that nobody has settled yet, "done" for finished, "refused" for came back undone with a reason, "assigned" for work given TO this person. Omit for everything. '
    + 'Returns: { window, outstanding[], settled[] } — outstanding rows carry who has it and how many whole days they have had it; settled rows carry who settled it, when, and the refusal reason word for word. Counts are computed here; quote them, never add them up yourself. '
    + 'Two honesty rules. It only ever covers THIS person: work between two colleagues neither of whom is the person you are talking to is not in the answer and must not be described as "nothing happened". And an empty result inside a 7 day window means nothing moved in that window, not that nobody has any open work. '
    + 'Refuses: nothing, but it returns an empty answer for a caller with no staff record at this hotel. '
    + 'Do NOT use for the hotel\'s whole open list (that is the Staxis list and its own tools), and note there is NO tool for handing an existing task to somebody else: if the user wants to chase or re-raise something, use create_todo to write a new one rather than promising to move the old one.',
  inputSchema: {
    type: 'object',
    properties: {
      days: {
        type: 'number',
        description: 'How many days back to look. Default 7, maximum 30.',
      },
      state: {
        type: 'string',
        enum: ['outstanding', 'done', 'refused', 'assigned'],
        description: 'Narrow the answer. Omit for everything.',
      },
    },
  },
  allowedRoles: ASSIGNMENT_ROLES,
  handler: async ({ days, state }, ctx: ToolHandlerContext): Promise<ToolResult> => {
    const staffId = ctx.staffId;
    if (!staffId) {
      // Not an error. A company user with no staff row at this hotel has
      // genuinely handed nothing out here and been handed nothing, and saying
      // so is a better answer than a refusal that reads like a permission
      // problem.
      return {
        ok: true,
        data: {
          window: null,
          outstanding: [],
          settled: [],
          note: 'This account has no staff record at this hotel, so there is nothing assigned '
            + 'to or from it here. Say that plainly rather than reporting an all clear.',
        },
      };
    }

    const windowDays = clampDays(days);
    const now = new Date();

    let notices: AssignmentNotice[] = [];
    try {
      notices = await loadAssignmentNotices({
        propertyId: ctx.propertyId,
        staffId,
        now,
        windowDays,
        limit: NOTICE_LIMIT,
      });
    } catch {
      return { ok: false, error: 'Could not read who has been asked to do what at this hotel.' };
    }

    // Still waiting on somebody. NOT part of the notices derivation, because a
    // task nobody has touched is not news — it is the absence of news, which is
    // exactly what makes it worth asking about out loud.
    let outstanding: Array<Record<string, unknown>> = [];
    if (state === undefined || state === 'outstanding') {
      try {
        const handed = await gatherAssignedByMe(ctx.propertyId, staffId, now);
        outstanding = handed
          .filter((item) => item.state === 'waiting')
          .map((item) => ({
            task: item.title,
            with: item.assigneeName ?? item.assignedDepartment ?? 'nobody in particular',
            daysWaiting: item.ageDays,
            due: item.dueDate,
          }));
      } catch {
        // One half failing degrades the answer rather than losing it, and the
        // note below says which half is missing so the model cannot report a
        // partial read as a complete one.
        return {
          ok: true,
          data: {
            window: `${windowDays} days`,
            outstanding: [],
            settled: shapeNotices(notices, state),
            note: 'The list of work still outstanding could not be read this time. Answer only '
              + 'about what has come back, and say the outstanding side is unavailable.',
          },
        };
      }
    }

    const settled = shapeNotices(notices, state);
    return {
      ok: true,
      data: {
        window: `${windowDays} days`,
        outstandingCount: outstanding.length,
        outstanding,
        settledCount: settled.length,
        settled,
        note: 'Everything here is about THIS person only: what they handed out and what was '
          + 'handed to them. It is not the hotel\'s whole task list. There is no tool for '
          + 'reassigning an existing task, so do not offer to move one; create_todo writes a '
          + 'new one if they want to chase it.',
      },
    };
  },
});

/** The notices, in the shape the model reads, filtered to what was asked for. */
function shapeNotices(
  notices: readonly AssignmentNotice[],
  state: string | undefined,
): Array<Record<string, unknown>> {
  const wanted = state === 'done' ? 'done'
    : state === 'refused' ? 'refused'
      : state === 'assigned' ? 'assigned'
        : null;
  return notices
    .filter((n) => (state === 'outstanding' ? false : wanted === null || n.kind === wanted))
    .map((n) => ({
      // The same sentence the notices list shows, so the two surfaces cannot
      // describe one event two ways.
      what: n.sentence,
      kind: n.kind,
      who: n.personName,
      task: n.title,
      when: n.at,
      // Verbatim. A paraphrased refusal is the app deciding what somebody meant
      // about their own reason for not doing something.
      reason: n.reason,
    }));
}

function clampDays(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return NOTICE_WINDOW_DAYS;
  return Math.min(Math.max(1, Math.floor(n)), MAX_WINDOW_DAYS);
}
