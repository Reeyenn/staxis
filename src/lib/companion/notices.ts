// ═══════════════════════════════════════════════════════════════════════════
// NOTICES — what happened to the work you handed over, and the work handed to
// you, said once.
//
// THIS MODULE IS PURE. No React, no fetch, no database, no clock of its own.
// Same reason as manners.ts and offers.ts: the suite runs under
// --conditions=react-server and cannot mount a component, so every rule with a
// consequence lives here and is tested here.
//
// ─── WHY THERE IS NO NOTICES TABLE ─────────────────────────────────────────
//
// A notice is not a thing that happens. It is a VIEW of something that already
// happened, and the something is a row in `comms_tasks` with a status, a
// settler and a timestamp on it. Storing a copy would give the hotel two
// records of one event that can disagree: a notice about a task somebody
// deleted, a notice that stayed unread after the task was undone, a counter
// that drifts. `assignerNotices` in src/lib/worklist/core.ts already made this
// argument for the Staxis list's own drawer and it holds here for the same
// reason.
//
// So notices are DERIVED on every read, and the only thing persisted is where
// this person's eyes got to: two ISO stamps on the companion memory blob that
// already exists (see manners.ts). Nothing can get stuck, nothing can be
// delivered twice, and nothing can outlive the thing it is about.
//
// ─── THE TWO STAMPS ANSWER DIFFERENT QUESTIONS ─────────────────────────────
//
//   noticesAnnouncedThrough   the newest notice this person has been TOLD
//                             about out loud. Stops the announcement repeating
//                             itself on every page load.
//   noticesSeenAt             when they last OPENED the list. Drives the unread
//                             count and the unread row styling.
//
// They are separate because being told and having looked are separate. A person
// who dismissed the pill without opening the list has heard it and not read it,
// and a system that conflated the two would either nag them or quietly mark
// things read they never saw.
//
// ─── SHOULDER SAFETY ───────────────────────────────────────────────────────
//
// Names and refusal reasons appear here, which the manners engine will not
// allow for an unprompted `people` candidate. That is a deliberate and narrow
// exception, and the reason is that an assignment is ALREADY addressed to this
// person: "Luis could not do 214" is a message from Luis to the person who
// asked him, and it is role-scoped by the query itself (you only ever see what
// you handed out and what you were handed). Wages, complaints and how somebody
// is performing are NOT in this file and must never be.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * What happened.
 *
 *   assigned  somebody gave this person a job
 *   done      somebody finished a job this person handed out
 *   refused   somebody could not do a job this person handed out, and said why
 */
export type NoticeKind = 'assigned' | 'done' | 'refused';

export const NOTICE_KINDS: readonly NoticeKind[] = ['assigned', 'done', 'refused'];

export interface AssignmentNotice {
  /**
   * Stable across reads. `<kind>:<taskId>` rather than a row id, because there
   * is no row: the same task settling once produces the same notice id forever,
   * which is what lets the browser key a list without a database sequence.
   */
  readonly id: string;
  readonly kind: NoticeKind;
  /** The task this is about, for navigation. */
  readonly taskId: string;
  /** ISO. When the thing that makes this a notice actually happened. */
  readonly at: string;
  /** The other person, already resolved to a display name, or null. */
  readonly personName: string | null;
  /** The task's own title, verbatim. Never re-worded. */
  readonly title: string;
  /** Verbatim, for a refusal. Null otherwise. */
  readonly reason: string | null;
  /** One plain sentence. Built here so the copy walk reaches it. */
  readonly sentence: string;
}

/** How far back a notice is still news. Matches the assigner drawer's window. */
export const NOTICE_WINDOW_DAYS = 7;

/** Most notices ever shipped to a browser or handed to the model in one read. */
export const NOTICE_LIMIT = 40;

// ─── Copy ───────────────────────────────────────────────────────────────────
//
// Every sentence a person reads is built by a function in this section, for the
// reason written at the top of copy.ts: the em dash that actually shipped
// arrived through a joiner in one file wrapping a fragment from another. The
// charter's copy walk calls these directly.

/** Somebody we can name, or the honest stand-in when we cannot. */
export function noticePerson(name: string | null | undefined): string {
  const clean = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
  return clean.length > 0 && clean.length <= 60 ? clean : 'Someone on your team';
}

/**
 * A task title, quoted, with its own trailing punctuation taken off.
 *
 * Quoted rather than woven into the sentence because a title is whatever
 * somebody typed. "Sarah gave you check the pool pump" is ambiguous the moment
 * a title starts with a verb, which is most of them.
 */
export function noticeTitle(raw: string | null | undefined): string {
  const clean = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  const trimmed = clean.replace(/[.!?,;:]+$/, '').slice(0, 120);
  return trimmed.length > 0 ? trimmed : 'a job with no name on it';
}

/** Whatever the refusal said, folded and bounded. Never paraphrased. */
export function noticeReason(raw: string | null | undefined): string | null {
  const clean = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  if (!clean) return null;
  return clean.replace(/[.!?]+$/, '').slice(0, 160);
}

/** The one line a row shows. */
export function noticeSentence(input: {
  kind: NoticeKind;
  personName: string | null;
  title: string;
  reason: string | null;
}): string {
  const who = noticePerson(input.personName);
  const what = `"${noticeTitle(input.title)}"`;
  switch (input.kind) {
    case 'assigned':
      return `${who} gave you ${what}.`;
    case 'done':
      return `${who} finished ${what}.`;
    case 'refused': {
      const reason = noticeReason(input.reason);
      return reason
        ? `${who} could not do ${what}: ${reason}.`
        : `${who} could not do ${what}.`;
    }
  }
}

/** What the list says when there is genuinely nothing in it. */
export const NOTICES_EMPTY_LINE = 'Nothing new. Work you hand out and work handed to you turns up here.';

/** The list's own title. Never "notifications", never "alerts". */
export const NOTICES_TITLE = 'Notices';

/** The count beside the title, or null when everything has been read. */
export function noticesCountLabel(unread: number): string | null {
  const n = Number.isFinite(unread) ? Math.max(0, Math.floor(unread)) : 0;
  if (n === 0) return null;
  return n > 99 ? '99+' : String(n);
}

/**
 * ONE batched utterance for a whole pile of notices.
 *
 * NEVER one message per task. The whole reason this class of speech is allowed
 * past the daily cap is that it is a single sentence about everything at once;
 * a companion that said three things in a row because three tasks landed would
 * be the notification spam this product does not have.
 *
 * `today` is the HOTEL's calendar day, and it is the only thing that lets the
 * line say "today". A batch that spans yesterday and this morning says no such
 * thing, because claiming a day that is not true of every item in the count is
 * exactly the kind of small lie that teaches somebody to stop believing counts.
 */
export function announcementLine(
  notices: readonly AssignmentNotice[],
  today: string | null,
): string | null {
  if (notices.length === 0) return null;
  if (notices.length === 1) return notices[0].sentence;

  const allToday = today !== null && notices.every((n) => n.at.slice(0, 10) === today);
  const when = allToday ? ' today' : '';

  const clauses: string[] = [];
  for (const kind of NOTICE_KINDS) {
    const group = notices.filter((n) => n.kind === kind);
    if (group.length === 0) continue;
    const who = soleName(group);
    const things = group.length === 1 ? '1 thing' : `${group.length} things`;
    if (kind === 'assigned') {
      clauses.push(who ? `${who} gave you ${things}${when}.` : `You were given ${things}${when}.`);
    } else if (kind === 'done') {
      clauses.push(who
        ? `${who} finished ${things}${when}.`
        : `${things} you handed out got done${when}.`);
    } else {
      clauses.push(who
        ? `${who} could not do ${things}${when}.`
        : `${things} you handed out came back undone${when}.`);
    }
  }
  return clauses.join(' ');
}

/** The one name behind a group, or null when it is more than one person. */
function soleName(group: readonly AssignmentNotice[]): string | null {
  const names = new Set(group.map((n) => n.personName?.trim() ?? ''));
  if (names.size !== 1) return null;
  const only = [...names][0];
  return only.length > 0 ? noticePerson(only) : null;
}

// ─── The list ───────────────────────────────────────────────────────────────

/**
 * Newest first, ties broken on id.
 *
 * Ties break on id so two notices in the same millisecond do not swap places
 * between renders. A list that reorders itself while somebody is reading it
 * looks like a bug even when both orders are equally true.
 */
export function sortNotices(notices: readonly AssignmentNotice[]): AssignmentNotice[] {
  return [...notices].sort((a, b) => {
    const byTime = Date.parse(b.at) - Date.parse(a.at);
    if (Number.isFinite(byTime) && byTime !== 0) return byTime;
    return a.id.localeCompare(b.id);
  });
}

/** Is this one newer than the last time the person opened the list? */
export function noticeIsUnread(notice: AssignmentNotice, seenAt: string | null): boolean {
  if (!seenAt) return true;
  const seen = Date.parse(seenAt);
  const at = Date.parse(notice.at);
  if (!Number.isFinite(seen) || !Number.isFinite(at)) return true;
  return at > seen;
}

export function unreadNotices(
  notices: readonly AssignmentNotice[],
  seenAt: string | null,
): AssignmentNotice[] {
  return notices.filter((n) => noticeIsUnread(n, seenAt));
}

/** The newest timestamp in a batch, or null. What the two stamps advance to. */
export function newestNoticeAt(notices: readonly AssignmentNotice[]): string | null {
  let best: string | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const n of notices) {
    const ms = Date.parse(n.at);
    if (!Number.isFinite(ms)) continue;
    if (ms > bestMs) { bestMs = ms; best = n.at; }
  }
  return best;
}

export interface NoticeDay {
  /** Today / Yesterday / a weekday / a date. */
  label: string;
  items: AssignmentNotice[];
}

/**
 * Grouped by day, newest day first, newest row first inside each day.
 *
 * The day boundary is the HOTEL's, handed in as `today` (YYYY-MM-DD) rather
 * than read off the browser clock, for the same reason the daily hello uses it:
 * a night auditor at 1am and a GM at 9am are on different days by the hotel's
 * calendar and the same one by the browser's.
 */
export function groupNoticesByDay(
  notices: readonly AssignmentNotice[],
  today: string,
): NoticeDay[] {
  const out: NoticeDay[] = [];
  for (const notice of sortNotices(notices)) {
    const label = dayLabelFor(notice.at, today);
    const tail = out[out.length - 1];
    if (tail && tail.label === label) tail.items.push(notice);
    else out.push({ label, items: [notice] });
  }
  return out;
}

/** Which day heading a notice sits under, relative to the hotel's today. */
export function dayLabelFor(iso: string, today: string): string {
  const day = iso.slice(0, 10);
  if (day === today) return 'Today';
  const yesterday = shiftDay(today, -1);
  if (day === yesterday) return 'Yesterday';
  const parsed = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return 'Earlier';
  const diff = daysBetween(day, today);
  if (diff !== null && diff > 0 && diff < 7) {
    return parsed.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
  }
  return parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** The clock time on a row. Rendered in the reader's own locale. */
export function noticeTimeLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function shiftDay(day: string, delta: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number | null {
  const a = Date.parse(`${from}T12:00:00Z`);
  const b = Date.parse(`${to}T12:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

// ═══════════════════════════════════════════════════════════════════════════
// A FOURTH MOUTH
// ═══════════════════════════════════════════════════════════════════════════
//
// manners.ts documents three: the unprompted offer, the teach line, and the
// panel ask. This is the fourth, and it is deliberately here rather than in
// that file, because it is the one class of speech the founder exempted from
// the frequency dial and mixing it into the engine that owns that dial would
// put the exemption one boolean away from everything else.
//
// ─── WHAT IT IS EXEMPT FROM, AND WHAT IT IS NOT ────────────────────────────
//
// EXEMPT: the once-a-day hello, and the daily speech budget. Somebody who has
// already been greeted and already been told one thing must still be told that
// three jobs landed on them, because that is not the companion volunteering an
// opinion — it is the app delivering a message a colleague addressed to them.
// Founder's explicit ruling.
//
// NOT EXEMPT: anything else. Asleep is still silent. Quiet-for-now is still
// quiet. Never while somebody is typing. Never twice for the same batch. Never
// on a housekeeper screen (that gate is upstream in mount.ts and the bootstrap
// route, which ships no notices to a hat with no chat). And it is still ONE
// utterance, which is the whole of `announcementLine` above.

export type NoticeAnnouncementRefusal =
  | 'ai_asleep'
  | 'quiet_this_session'
  | 'user_is_busy'
  | 'nothing_new'
  | 'already_announced';

export type NoticeAnnouncementDecision =
  | { announce: false; refusal: NoticeAnnouncementRefusal }
  | {
      announce: true;
      /** The one batched sentence. */
      line: string;
      /** How many notices it covers, for the count on the mark. */
      count: number;
      /** The newest `at` in the batch. Stamped so this batch is spent. */
      through: string;
    };

export interface NoticeAnnouncementInput {
  /** Already derived, already scoped to this person. Any read order. */
  notices: readonly AssignmentNotice[];
  /** The newest notice already said out loud, from the companion memory. */
  announcedThrough: string | null;
  /** The hotel's own calendar day, YYYY-MM-DD, or null when unknown. */
  today: string | null;
  userIsBusy: boolean;
  quietThisSession: boolean;
  aiAwake: boolean;
}

export function decideNoticeAnnouncement(
  input: NoticeAnnouncementInput,
): NoticeAnnouncementDecision {
  if (!input.aiAwake) return { announce: false, refusal: 'ai_asleep' };
  if (input.quietThisSession) return { announce: false, refusal: 'quiet_this_session' };
  if (input.userIsBusy) return { announce: false, refusal: 'user_is_busy' };
  if (input.notices.length === 0) return { announce: false, refusal: 'nothing_new' };

  const fresh = unannounced(input.notices, input.announcedThrough);
  if (fresh.length === 0) {
    // Told already. Not "nothing happened" — the distinction matters, because
    // the list still has rows in it and the mark still carries its count.
    return { announce: false, refusal: 'already_announced' };
  }

  const line = announcementLine(sortNotices(fresh), input.today);
  const through = newestNoticeAt(fresh);
  if (!line || !through) return { announce: false, refusal: 'nothing_new' };
  return { announce: true, line, count: fresh.length, through };
}

/**
 * The notices this person has not been told about out loud yet.
 *
 * A missing stamp means nothing has ever been announced, and everything in the
 * window counts. That is the same choice `assignerNotices` makes for its own
 * first run, and for the same reason: the first thing that comes back is what
 * teaches somebody the list is there.
 */
export function unannounced(
  notices: readonly AssignmentNotice[],
  announcedThrough: string | null,
): AssignmentNotice[] {
  if (!announcedThrough) return [...notices];
  const cut = Date.parse(announcedThrough);
  if (!Number.isFinite(cut)) return [...notices];
  return notices.filter((n) => {
    const at = Date.parse(n.at);
    return !Number.isFinite(at) || at > cut;
  });
}
