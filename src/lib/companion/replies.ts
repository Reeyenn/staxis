// ═══════════════════════════════════════════════════════════════════════════
// What a person may say back, and what each answer MEANS.
//
// ─── THE BUG THIS FILE EXISTS TO END ───────────────────────────────────────
//
// A `CompanionCandidate` used to carry {topic, text, sensitivity, covers,
// destination}. That is a LOSSY PROJECTION of a surface that already knew the
// right answers: a preventive card knows the honest replies are "it is done",
// "somebody's been called" and "put it on the board" (DETECTOR_CLOSURE_SETS in
// finding-cards.ts), and a proposal with an attached action knows the reply is
// "raise the ticket" (the frozen plan in findings/actions/catalog).
//
// All of that was thrown away, and `offerQuestion(destination)` then INVENTED a
// question that fitted the routing hint rather than the statement. The result
// shipped: a fire-panel statement under "Want me to take you to Staxis?" with
// [Yes] [No thanks]. Yes to what?
//
// So: the code that builds the sentence builds the replies, in the same place,
// from the same facts. A model may later phrase the question and reorder the
// replies (see the judged question in copy.ts). It may never choose, invent, or
// label one.
//
// ─── THE REGISTRY IS CLOSED, AND THAT IS THE SECURITY BOUNDARY ─────────────
//
// Seven intents, each with a handler that already exists and already has its
// own gate. NOTHING here invents a capability:
//
//   record   POST /api/findings          the closure verdicts a card already
//                                        offers. Manager-gated at the route.
//   act      POST /api/findings/actions  the FROZEN plan, re-verified inside
//                                        the transaction that would do the
//                                        work. Manager-gated at the route.
//   walk     router.push of a pages.ts CONSTANT. Never a string from anywhere.
//   show     draw the trace in place. Reads nothing, writes nothing.
//   seed     hand one sentence to the ONE chat brain, exactly as a person could
//            have typed it. Any mutation it proposes still gets the approval
//            card it would have got the first time. Charter clause 1 holds.
//   quiet    the manners ledger. Drops a topic, permanently, first time asked.
//   close    nothing happens and nothing is said back.
//
// Charter clause 1 is untouched: no reply here performs a consequential write
// without the machinery that already asks. `act` is the one that writes, and it
// goes through the verify-at-tap path that was built for exactly that tap.
//
// ─── WHY THE LABELS LIVE HERE AND NOT IN copy.ts ───────────────────────────
//
// They are user-facing strings, so copy.ts's rule ("no companion sentence is
// built anywhere but here") would put them there. They are not sentences,
// though: a label is one half of a structure whose other half is an intent, and
// splitting the pair across two files is how a label ends up describing an
// intent it no longer has. So this is the SECOND copy-producing module for the
// companion, and companion-charter.test.ts walks these builders exactly as it
// walks copy.ts's. The dash rule, the English rule and the "never says AI" rule
// all reach them.
// ═══════════════════════════════════════════════════════════════════════════

import type { AppRole } from '@/lib/roles';
import type { ClosureVerdict } from '@/components/concourse/finding-cards';
import type { CompanionPageKey } from './pages';

// ─── The closed intent registry ─────────────────────────────────────────────

/**
 * The verdicts a `record` reply may carry, as a runtime list.
 *
 * A LIST rather than a re-import of the card's type, because the stored offer
 * payload has to re-check one of these coming back off jsonb and the parser
 * that does it lives in a module that must stay free of the whole finding-cards
 * surface. `CompanionVerdictsMatchTheCard` below is the compile-time proof that
 * the list and the card's own `ClosureVerdict` are the same five strings in
 * both directions, so a verdict added to one and not the other is a type error
 * rather than a button that posts something POST /api/findings will refuse.
 */
export const COMPANION_RECORD_VERDICTS = [
  'resolved', 'known_problem', 'muted', 'pm_done', 'pm_called',
] as const;

export type CompanionRecordVerdict = typeof COMPANION_RECORD_VERDICTS[number];

/** `true` only while the list above and `ClosureVerdict` agree exactly. */
export type CompanionVerdictsMatchTheCard =
  ClosureVerdict extends CompanionRecordVerdict
    ? CompanionRecordVerdict extends ClosureVerdict ? true : never
    : never;

export type CompanionReplyIntent =
  /** Record a verdict against a finding. The card's own closure vocabulary. */
  | { readonly kind: 'record'; readonly verdict: CompanionRecordVerdict; readonly findingId: string }
  /** Run the finding's frozen plan, through the verify-at-tap path. */
  | { readonly kind: 'act'; readonly actionId: string }
  /** Navigate to a constant from the pages allowlist. */
  | { readonly kind: 'walk'; readonly page: CompanionPageKey }
  /** Draw the thing in place: a trace on the page, the notices list in the panel. */
  | { readonly kind: 'show' }
  /**
   * Hand a sentence to the one chat brain.
   *
   * An EMPTY text means "open the conversation about the statement that is on
   * screen", which is what the Something else escape does. The caller supplies
   * the statement; this carries no copy of it, because a stored second copy of a
   * sentence is a second thing that can drift from the first.
   */
  | { readonly kind: 'seed'; readonly text: string }
  /** Drop this topic in the manners ledger, permanently, first time asked. */
  | { readonly kind: 'quiet'; readonly scope: 'topic' }
  /** The card closes. Nothing is written and nothing is said back. */
  | { readonly kind: 'close' };

export type CompanionReplyIntentKind = CompanionReplyIntent['kind'];

export const COMPANION_REPLY_INTENT_KINDS: readonly CompanionReplyIntentKind[] = [
  'record', 'act', 'walk', 'show', 'seed', 'quiet', 'close',
];

export interface CompanionReply {
  /**
   * Stable, and the ONLY thing the browser ever sends back.
   *
   * Never an intent: a tap reports which button was pressed, and the server (or
   * the hook, for the surfaces that never reach a server) resolves that id
   * against the reply set it built itself. A body that named an intent would be
   * a body that chose one.
   */
  readonly id: string;
  readonly label: string;
  readonly intent: CompanionReplyIntent;
  /**
   * A second tap before it fires, with this sentence in between.
   *
   * Only ever on the verdict that cannot be taken back. The wording is the
   * card's own (STOP_WATCHING in finding-cards.ts) so a manager reads the same
   * question wherever they meet it.
   */
  readonly confirm?: string;
}

/**
 * Most replies one card may carry.
 *
 * Three, and it is a construction rule rather than a slice at the end: a fourth
 * honest answer means the question was two questions. The Something else escape
 * is NOT one of these (see `somethingElseReply`) because it is not an answer to
 * the question, it is the way out of it.
 */
export const COMPANION_REPLIES_MAX = 3;

// ─── Who may reach each handler ─────────────────────────────────────────────

/**
 * Mirrors the gate on the real handler rather than guessing, the same way
 * TEACH_FLOW_ROLES does. Offering somebody a button their own role will be
 * refused for is worse than offering them nothing: they press it once, get
 * turned down, and learn that the companion does not know what it can do.
 *
 * `record` and `act` are manager-only because POST /api/findings and
 * POST /api/findings/actions both require `loadManagerCaller` +
 * `managerManagesHotel` + `callerCanMutateHotel`.
 *
 * Housekeeping is on no list. The mount gate already refuses that hat before a
 * reply is ever built; it is left off here as well so the two gates agree
 * rather than one relying on the other.
 */
const MANAGER_ROLES: readonly AppRole[] = ['admin', 'owner', 'general_manager'];
const EVERY_MOUNTED_ROLE: readonly AppRole[] = [
  'admin', 'owner', 'general_manager', 'front_desk', 'maintenance', 'staff',
];

export const REPLY_INTENT_ROLES: Readonly<Record<CompanionReplyIntentKind, readonly AppRole[]>> =
  Object.freeze({
    record: MANAGER_ROLES,
    act: MANAGER_ROLES,
    walk: EVERY_MOUNTED_ROLE,
    show: EVERY_MOUNTED_ROLE,
    seed: EVERY_MOUNTED_ROLE,
    quiet: EVERY_MOUNTED_ROLE,
    close: EVERY_MOUNTED_ROLE,
  });

export function replyAllowedForRole(
  reply: CompanionReply,
  role: AppRole | null | undefined,
): boolean {
  if (!role) return false;
  return REPLY_INTENT_ROLES[reply.intent.kind].includes(role);
}

/**
 * The replies this hat may actually press, capped.
 *
 * The cap is applied AFTER the role filter so a manager-only reply being
 * dropped promotes the next honest answer rather than leaving a gap.
 */
export function repliesForRole(
  replies: readonly CompanionReply[],
  role: AppRole | null | undefined,
): CompanionReply[] {
  return replies.filter((r) => replyAllowedForRole(r, role)).slice(0, COMPANION_REPLIES_MAX);
}

// ─── The vocabularies ───────────────────────────────────────────────────────
//
// One builder per KIND of thing the companion says. Each is derived from the
// source surface's own affordances, named in the comment above it, so the two
// can be checked against each other by reading rather than by running.

/**
 * Which vocabulary a candidate speaks.
 *
 * Carried on the candidate rather than re-derived at render, because the thing
 * that knows a finding is a preventive follow-up is the code that read the
 * finding, and asking the browser to work it out again from a sentence is how
 * the two answers drift.
 */
export type CompanionReplyKind =
  | 'finding_propose'
  | 'finding_propose_action'
  | 'finding_propose_preventive'
  | 'finding_recommend'
  | 'finding_recommend_preventive'
  | 'finding_fyi'
  | 'todo_slipped'
  | 'import_lopsided'
  | 'trace'
  | 'unfinished'
  | 'event_wake'
  | 'panel_ask'
  | 'notices'
  | 'welcome'
  | 'daily_hello'
  | 'teach'
  | 'arrival'
  // ─── The two the tour brought (2026-08-07) ──────────────────────────────
  //
  // Added rather than borrowed, and that is the whole justification: both
  // could have been made to LOOK right by reusing a neighbour, and both would
  // then have been a lie in the registry. `whats_new` has the same shape as
  // `trace` (show, not now) and `wandering` the same shape as `unfinished`
  // (seed, close), so reusing either would have compiled and rendered
  // correctly today. It would also have meant a card about a shipped change
  // declaring itself a pattern on the screen, which is exactly the "lossy
  // projection" this file's header is about: the next person to read
  // `offerQuestionFor` would find a trace case that has to answer for two
  // different things and would have no way to tell they had diverged.
  //
  // NEITHER INVENTS AN INTENT. Both compose the seven that already exist, and
  // both are still capped, role-filtered and escapable like every other set.
  | 'whats_new'
  | 'wandering';

export const COMPANION_REPLY_KINDS: readonly CompanionReplyKind[] = [
  'finding_propose', 'finding_propose_action', 'finding_propose_preventive', 'finding_recommend',
  'finding_recommend_preventive', 'finding_fyi', 'todo_slipped', 'import_lopsided',
  'trace', 'unfinished', 'event_wake', 'panel_ask', 'notices',
  'welcome', 'daily_hello', 'teach', 'arrival', 'whats_new', 'wandering',
];

/**
 * "Staxis will stop watching this. Sure?"
 *
 * The card's own sentence, repeated here rather than imported, because
 * finding-cards.ts holds it as a private bilingual constant inside a table this
 * module has no business reaching into. Identical wording is the requirement;
 * a shared symbol is not.
 */
const STOP_WATCHING_CONFIRM = 'Staxis will stop watching this. Sure?';

const CLOSE_NOT_NOW: CompanionReply = {
  id: 'close', label: 'Not now', intent: { kind: 'close' },
};

/**
 * The way out of a question, on every card that asks one.
 *
 * NOT part of the three. It is not a fourth answer, it is the admission that
 * the three were the wrong three, and a person who has that thought should be
 * able to say so without the companion having anticipated it.
 *
 * The seed text is empty: the caller passes the statement, so there is exactly
 * one copy of that sentence in the system and it is the one on the screen.
 */
export function somethingElseReply(): CompanionReply {
  return { id: 'else', label: 'Something else', intent: { kind: 'seed', text: '' } };
}

/**
 * A proposal whose plan is gone, or was never written.
 *
 * CLOSURE_SETS.propose, unchanged. It happens when a detector proposes
 * something the catalog has no safe action for, and when an action was already
 * executed or superseded. The card renders exactly these three; so does this.
 */
function proposeNoAction(findingId: string): CompanionReply[] {
  return [
    {
      id: 'record:known_problem',
      label: 'Known problem',
      intent: { kind: 'record', verdict: 'known_problem', findingId },
    },
    {
      id: 'record:resolved',
      label: 'Fixed',
      intent: { kind: 'record', verdict: 'resolved', findingId },
    },
    {
      id: 'record:muted',
      label: 'Mute',
      intent: { kind: 'record', verdict: 'muted', findingId },
      confirm: STOP_WATCHING_CONFIRM,
    },
  ];
}

/**
 * A proposal that came with a frozen plan.
 *
 * From `offersApproval` (finding-cards.ts): disposition `propose` with an
 * action in state `proposed`. The card's own primary is the action; the two
 * behind it are the propose closure set, minus Mute, which is the loud one and
 * does not belong on a one-line offer in the corner of a screen.
 */
function proposeWithAction(findingId: string, actionId: string): CompanionReply[] {
  return [
    { id: 'act', label: 'Raise the ticket', intent: { kind: 'act', actionId } },
    {
      id: 'record:known_problem',
      label: 'Known problem',
      intent: { kind: 'record', verdict: 'known_problem', findingId },
    },
    CLOSE_NOT_NOW,
  ];
}

/**
 * The preventive DUE card. DETECTOR_CLOSURE_SETS.preventive_due.propose.
 *
 * "Known problem" is deliberately absent, exactly as it is on the card: on a
 * dated job it would mean "yes, I know it is overdue, stop mentioning it",
 * which is the one thing the upkeep promise refuses.
 */
function preventiveDue(findingId: string, actionId: string | null): CompanionReply[] {
  return [
    {
      id: 'record:pm_done',
      label: 'It is done',
      intent: { kind: 'record', verdict: 'pm_done', findingId },
    },
    {
      id: 'record:pm_called',
      label: "Somebody's been called",
      intent: { kind: 'record', verdict: 'pm_called', findingId },
    },
    actionId
      ? { id: 'act', label: 'Put it on the board', intent: { kind: 'act', actionId } }
      : CLOSE_NOT_NOW,
  ];
}

/** CLOSURE_SETS.recommend, in the same order the card renders it. */
function recommend(findingId: string): CompanionReply[] {
  return [
    {
      id: 'record:resolved',
      label: 'Handled it',
      intent: { kind: 'record', verdict: 'resolved', findingId },
    },
    {
      id: 'record:known_problem',
      label: 'Seen',
      intent: { kind: 'record', verdict: 'known_problem', findingId },
    },
    {
      id: 'record:muted',
      label: 'Not doing this',
      intent: { kind: 'record', verdict: 'muted', findingId },
      confirm: STOP_WATCHING_CONFIRM,
    },
  ];
}

/** DETECTOR_CLOSURE_SETS.preventive_due.recommend — the week-later follow-up. */
function preventiveFollowUp(findingId: string): CompanionReply[] {
  return [
    {
      id: 'record:pm_done',
      label: 'Yes, it got done',
      intent: { kind: 'record', verdict: 'pm_done', findingId },
    },
    {
      id: 'record:pm_called',
      label: 'Still waiting',
      intent: { kind: 'record', verdict: 'pm_called', findingId },
    },
    {
      id: 'record:muted',
      label: 'Stop tracking this',
      intent: { kind: 'record', verdict: 'muted', findingId },
      confirm: STOP_WATCHING_CONFIRM,
    },
  ];
}

/** CLOSURE_SETS.fyi — one quiet way to put it away, plus somewhere to look. */
function fyi(findingId: string): CompanionReply[] {
  return [
    {
      id: 'record:known_problem',
      label: 'Got it',
      intent: { kind: 'record', verdict: 'known_problem', findingId },
    },
    { id: 'walk:staxis', label: 'Show me', intent: { kind: 'walk', page: 'staxis' } },
  ];
}

/**
 * Work that slipped. The rows are already on the one list, three buttons each.
 *
 * There is no verdict to record here and nothing for the companion to do: the
 * statement asks nothing, so the only honest replies are "take me to them" and
 * "leave it".
 */
function slipped(): CompanionReply[] {
  return [
    { id: 'walk:staxis', label: 'Show me', intent: { kind: 'walk', page: 'staxis' } },
    CLOSE_NOT_NOW,
  ];
}

/** Lopsided import history. The fix is a screen, and it is worth never asking again. */
function lopsided(): CompanionReply[] {
  return [
    { id: 'walk:inventory', label: 'Add the occupancy', intent: { kind: 'walk', page: 'inventory' } },
    CLOSE_NOT_NOW,
    { id: 'quiet', label: 'Do not ask again', intent: { kind: 'quiet', scope: 'topic' } },
  ];
}

/** A pattern on the screen underneath. It draws in place; it does not walk. */
function trace(): CompanionReply[] {
  return [
    { id: 'show', label: 'Show me', intent: { kind: 'show' } },
    CLOSE_NOT_NOW,
  ];
}

/**
 * The panel ask: a pattern about a named person, in the one venue it may be
 * said. It gets its own "stop watching" because the subject is the reason
 * somebody would want it gone for good rather than gone for today.
 */
function panelAsk(): CompanionReply[] {
  return [
    { id: 'show', label: 'Show me what you found', intent: { kind: 'show' } },
    CLOSE_NOT_NOW,
    { id: 'quiet', label: 'Stop watching this', intent: { kind: 'quiet', scope: 'topic' } },
  ];
}

/**
 * A question the companion asked and never heard back on.
 *
 * A yes hands the SAME sentence back to the chat, which proposes the action and
 * puts the same approval card up again. This reopens a question; it does not
 * answer one.
 */
function unfinished(summary: string): CompanionReply[] {
  return [
    { id: 'seed', label: 'Yes, do it', intent: { kind: 'seed', text: summary } },
    { id: 'close', label: 'No, drop it', intent: { kind: 'close' } },
  ];
}

/**
 * Where an event-wake note actually leads.
 *
 * Derived from the topic the sweep itself wrote (`wake:<event_category>`), NOT
 * hardcoded to the one list. A manager told about a work order that just opened
 * wants the maintenance board; sending them to a list of everything and letting
 * them find it is the routing hint standing in for an answer again.
 *
 * An unmapped category lands on the one list, which is the honest default: it
 * is the screen that shows everything from everywhere.
 */
const PAGE_FOR_EVENT_CATEGORY: Readonly<Record<string, CompanionPageKey>> = Object.freeze({
  maintenance: 'maintenance',
  inventory: 'inventory',
  staff: 'people',
  front_desk: 'dashboard',
  housekeeping: 'staxis',
  system: 'staxis',
});

export function wakeDestination(topic: string): CompanionPageKey {
  const category = topic.startsWith('wake:') ? topic.slice('wake:'.length) : '';
  return PAGE_FOR_EVENT_CATEGORY[category] ?? 'staxis';
}

function eventWake(topic: string): CompanionReply[] {
  return [
    { id: 'walk', label: 'Show me', intent: { kind: 'walk', page: wakeDestination(topic) } },
    CLOSE_NOT_NOW,
  ];
}

/**
 * The batched notices line.
 *
 * "Show me" opens the list inside the panel, which is a `show` and not a walk:
 * the list is right there. `refused` is the one notice kind that leaves a job
 * undone, so that batch gains the one thing a manager would actually want to
 * do about it, as a sentence handed to the chat rather than an act performed.
 */
function notices(input: { hasRefusal: boolean }): CompanionReply[] {
  const base: CompanionReply[] = [
    { id: 'show', label: 'Show me', intent: { kind: 'show' } },
    CLOSE_NOT_NOW,
  ];
  if (!input.hasRefusal) return base;
  return [
    ...base,
    {
      id: 'seed',
      label: 'Reassign it',
      intent: { kind: 'seed', text: 'Somebody turned down a job I handed out. Who else could take it?' },
    },
  ];
}

/** Day one. A yes is the tour, which walks to the first screen of it. */
function welcome(firstTourPage: CompanionPageKey | null): CompanionReply[] {
  return [
    firstTourPage
      ? { id: 'walk', label: 'Yes', intent: { kind: 'walk', page: firstTourPage } }
      : { id: 'show', label: 'Yes', intent: { kind: 'show' } },
    { id: 'close', label: 'No thanks', intent: { kind: 'close' } },
  ];
}

/**
 * The once-a-day hello.
 *
 * A statement, so it normally carries nothing. When something IS waiting it
 * gains one way to go and look at it, because a hello that names a number and
 * then offers no way to reach it is a hello that made somebody hunt.
 */
function dailyHello(input: { waiting: number }): CompanionReply[] {
  if (input.waiting <= 0) return [];
  return [{ id: 'walk:staxis', label: 'Show me', intent: { kind: 'walk', page: 'staxis' } }];
}

/** The teach line. A yes puts the example in the composer, unchanged. */
function teach(example: string): CompanionReply[] {
  return [
    { id: 'seed', label: 'Yes', intent: { kind: 'seed', text: example } },
    { id: 'close', label: 'Not now', intent: { kind: 'close' } },
  ];
}

/** The arrival line during a tour. A yes is the next stop. */
function arrival(nextPage: CompanionPageKey | null, nextLabel: string | null): CompanionReply[] {
  const out: CompanionReply[] = [];
  if (nextPage && nextLabel) {
    out.push({ id: 'walk', label: `Next: ${nextLabel}`, intent: { kind: 'walk', page: nextPage } });
  }
  out.push({ id: 'close', label: 'Close', intent: { kind: 'close' } });
  return out;
}

/**
 * "Want to see what is new?"
 *
 * A `show`, not a walk. The mini tour draws on the screen the person is
 * standing on and takes itself wherever it needs to go from there, so the
 * companion is not navigating anybody in order to then start navigating them.
 *
 * There is deliberately no "do not tell me about changes" reply. The topic is
 * dropped the moment the offer is SHOWN (see useCompanion), so this entry is
 * already once-ever and a permanent opt-out would be a promise about every
 * future change, which is not a promise one card is entitled to make.
 */
function whatsNew(): CompanionReply[] {
  return [
    { id: 'show', label: 'Show me', intent: { kind: 'show' } },
    CLOSE_NOT_NOW,
  ];
}

/**
 * "Looking for something? Ask me and I will point at it."
 *
 * The seed is a HALF sentence ("Where do I find"), which is the whole teaching
 * move: the person finishes it themselves and learns that finishing it works.
 * A complete question would answer itself and teach nothing.
 *
 * Two replies and no third. "Do not ask again" would be a button offering to
 * switch off something that, by construction, happens at most once in a
 * person's whole life here.
 */
function wandering(seed: string): CompanionReply[] {
  return [
    { id: 'seed', label: 'Yes, help me find it', intent: { kind: 'seed', text: seed } },
    CLOSE_NOT_NOW,
  ];
}

// ─── The one door ───────────────────────────────────────────────────────────

/**
 * Everything a builder might need, in one shape.
 *
 * A single entry point rather than sixteen exported builders, because the thing
 * that must be true is "a reply set came from this table" and a single door is
 * how that stays checkable. The per-kind functions above stay private for the
 * same reason.
 */
export interface ReplySetInput {
  kind: CompanionReplyKind;
  /** Required by every `record` reply. The finding this card is about. */
  findingId?: string | null;
  /** The frozen plan, when the card came with one. */
  actionId?: string | null;
  /** The manners topic, for the kinds that derive a destination from it. */
  topic?: string | null;
  /** The sentence a `seed` hands over, for the kinds that carry one. */
  seed?: string | null;
  /** Daily hello only. */
  waiting?: number;
  /** Notices only. */
  hasRefusal?: boolean;
  /** Welcome and arrival only. */
  page?: CompanionPageKey | null;
  /** Arrival only. */
  pageLabel?: string | null;
}

/**
 * The replies for one thing the companion is about to say.
 *
 * Capped by construction, never by a slice somewhere else. A kind whose facts
 * are missing degrades to the honest minimum rather than to a guess: a finding
 * reply set with no finding id would be three buttons that cannot record
 * anything, which is exactly the class of silently-dead control this whole
 * layer exists to stop shipping.
 */
export function repliesFor(input: ReplySetInput): CompanionReply[] {
  const findingId = input.findingId ?? '';
  const actionId = input.actionId ?? null;
  const built = ((): CompanionReply[] => {
    switch (input.kind) {
      case 'finding_propose':
        return findingId ? proposeNoAction(findingId) : slipped();
      case 'finding_propose_action':
        return findingId && actionId
          ? proposeWithAction(findingId, actionId)
          // A plan that vanished between the read and the render leaves a card
          // that can still be filed. Degrading to the no-action set is what the
          // screen itself does; degrading to a dead button is not.
          : findingId ? proposeNoAction(findingId) : slipped();
      case 'finding_propose_preventive':
        return findingId ? preventiveDue(findingId, actionId) : slipped();
      case 'finding_recommend':
        return findingId ? recommend(findingId) : slipped();
      case 'finding_recommend_preventive':
        return findingId ? preventiveFollowUp(findingId) : slipped();
      case 'finding_fyi':
        return findingId ? fyi(findingId) : slipped();
      case 'todo_slipped':
        return slipped();
      case 'import_lopsided':
        return lopsided();
      case 'trace':
        return trace();
      case 'panel_ask':
        return panelAsk();
      case 'unfinished':
        return unfinished((input.seed ?? '').trim());
      case 'event_wake':
        return eventWake(input.topic ?? '');
      case 'notices':
        return notices({ hasRefusal: input.hasRefusal === true });
      case 'welcome':
        return welcome(input.page ?? null);
      case 'daily_hello':
        return dailyHello({ waiting: input.waiting ?? 0 });
      case 'teach':
        return teach((input.seed ?? '').trim());
      case 'arrival':
        return arrival(input.page ?? null, input.pageLabel ?? null);
      case 'whats_new':
        return whatsNew();
      case 'wandering':
        return wandering((input.seed ?? '').trim());
    }
  })();
  return built.slice(0, COMPANION_REPLIES_MAX);
}

/** The one detector whose card is about a dated job rather than a pattern. */
export const PREVENTIVE_DETECTOR_ID = 'preventive_due';

/**
 * Which vocabulary a finding's card speaks, read off the card itself.
 *
 * The two facts that decide it are the ones the SCREEN uses: the DETECTOR (a
 * dated upkeep job has different honest answers from a pattern) and the
 * EFFECTIVE disposition, which `toQueueFinding` has already resolved through
 * the judge's verdict and the clamp. Nothing here re-decides either.
 *
 * It lives in this module rather than beside either caller because there are
 * two: the browser's candidate builder and the nightly question pass. Two
 * copies of "which questions may this card ask" would be two copies that can
 * disagree, and the way that failure shows up is a question about a preventive
 * job over a pattern card's buttons.
 *
 * `preventive_due` is named because it is the one detector with its own closure
 * set in DETECTOR_CLOSURE_SETS, and this should stay a two-line branch for the
 * same reason that stays a one-entry table: a detector earns an entry when its
 * card is about a different KIND of thing, not when somebody wants nicer words.
 */
export function findingReplyKind(
  finding: { detectorId: string; disposition: string },
  actionId: string | null,
): CompanionReplyKind {
  if (finding.detectorId === PREVENTIVE_DETECTOR_ID) {
    if (finding.disposition === 'propose') return 'finding_propose_preventive';
    if (finding.disposition === 'recommend') return 'finding_recommend_preventive';
  }
  if (finding.disposition === 'propose') {
    return actionId ? 'finding_propose_action' : 'finding_propose';
  }
  if (finding.disposition === 'fyi') return 'finding_fyi';
  return 'finding_recommend';
}

/**
 * The reply set for a topic the server cannot rebuild from a database read.
 *
 * Trace patterns and panel asks are computed in the browser from
 * /api/companion/trace, so POST /api/companion has no candidate to look them up
 * in. It still must not take the reply set off the request body (see the route
 * header), so it takes it from HERE: a pure function of the topic namespace,
 * owned by code, reachable by a test.
 *
 * Null means "this topic has no static vocabulary", and the caller stores no
 * replies rather than inventing some.
 */
export function staticRepliesForTopic(topic: string): CompanionReply[] | null {
  if (topic.startsWith('trace:')) return repliesFor({ kind: 'trace' });
  if (topic.startsWith('wake:')) return repliesFor({ kind: 'event_wake', topic });
  if (topic === 'todo:slipped') return repliesFor({ kind: 'todo_slipped' });
  return null;
}
