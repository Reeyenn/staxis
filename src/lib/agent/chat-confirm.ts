// ─── The chat's confirm step ─────────────────────────────────────────────────
//
// WHAT THIS IS
// The machinery that lets the chat DO things — set up a maintenance schedule,
// approve a fix, write a company rule — without ever writing on the model's own
// say-so. Every DO tool in the chat is TWO calls:
//
//   1. PROPOSE. The tool validates and normalises what the model heard, writes
//      NOTHING, and returns a structured read-back plus a token:
//        "Water heaters, every 180 days, last done 15 March 2026 — right?"
//   2. CONFIRM. The tool is called again with that token, and only then writes,
//      using the parameters FROZEN at step 1 — never the ones the model sends
//      the second time.
//
// ═══ WHY A `confirmed: true` ARGUMENT WOULD NOT BE A CONFIRMATION ═══
// The obvious design is an argument the model sets once the user has agreed.
// It is worthless: the model writes every argument, so `confirmed: true` is the
// model confirming itself, and the one thing this layer exists to guarantee —
// that a human said yes — is exactly the thing it cannot express. Any check
// derived from the model's own output has the same hole.
//
// So the gate is a fact the model CANNOT produce: a message from the human,
// recorded by the route, after the read-back was recorded by the route.
//
//   • The token is minted server-side (a v4 UUID) and reaches the model only by
//     coming back out of a tool result the ROUTE persisted. A token the model
//     invents matches no row and confirms nothing.
//   • The frozen parameters are read back OUT of that persisted row, so what
//     runs is what the human was shown, whatever the model sends at step 2.
//   • A confirmation is only accepted when the conversation holds MORE messages
//     from the human than it did when the read-back was written. The route
//     records the user's message before the model runs, so that count only goes
//     up when a person types something: a model that proposes and confirms
//     inside one turn — even across iterations of the same turn — sees the same
//     count and is refused.
//
// COUNTING RATHER THAN COMPARING TIMESTAMPS, and this is not a detail. The
// obvious gate is "a user row whose created_at is later than the proposal's".
// It is one clock tick away from wrong: `now()` resolves to milliseconds on some
// engines, two rows written in the same millisecond compare EQUAL, and the
// choice is then between a gate that refuses a real confirmation and a `>=` that
// lets a self-confirmation through — because the same turn's user row precedes
// the proposal by microseconds. A count has no ties. Rows are only ever
// appended, so it is monotonic, and it is exact.
//
// ═══ WHY THE TRANSCRIPT IS THE STORE (AND THERE IS NO NEW TABLE) ═══
// `agent_messages` already holds every tool result, is already written by the
// route rather than by the model, is already scoped to one hotel by a trigger
// (INV-28, migration 0336), and is already the thing a manager can be shown
// afterwards. A `chat_pending_confirmations` table would have been a second
// copy of it with its own TTL, its own sweeper and its own way to disagree with
// the conversation the human actually had.
//
// It is deliberately NOT `agent_pending_actions` either, even though that table
// holds proposed tool calls: the chat route SWEEPS every pending row of a
// conversation to `expired` the moment the user sends another message
// (`sweepConversationPending`) — which is precisely the message this layer
// treats as the confirmation. The two mechanisms are opposites and must not
// share a store.
//
// RELATIONSHIP TO THE APPROVAL CARD
// The card gate (mutates → pending row → "Do it") is the other half of the same
// idea and is untouched. A tool declaring `confirmInChat` opts out of it
// because it runs this instead; see `partitionGatedCalls` in llm.ts.

import 'server-only';
import { randomUUID } from 'node:crypto';

import type { ToolHandlerContext } from './tools';
import { log } from '@/lib/log';

/** What kind of thing is waiting on a yes. A token only confirms its own kind:
 *  a token minted for a maintenance schedule cannot approve a work order. */
export type ChatConfirmKind =
  | 'preventive_task'
  | 'equipment'
  | 'company_rule'
  | 'finding_decision'
  | 'hotel_question';

/** How long a read-back stays answerable. A "yes" the next morning is still a
 *  yes to the same sentence; a "yes" next week is answering something the
 *  hotel has moved on from. */
export const CONFIRM_TTL_HOURS = 24;

/** How much of the conversation is scanned for the proposal. Comfortably more
 *  than any live conversation: the summarizer archives long ones, and a token
 *  older than this window is older than its TTL several times over. */
const TRANSCRIPT_SCAN_LIMIT = 400;

/**
 * The ceiling on the message count. A conversation past it SATURATES, so both
 * counts read the same number and every confirmation is refused — the safe
 * direction, and unreachable in practice: the chat caps a message at 4,000
 * characters and archives long conversations, so two thousand of them is a
 * conversation nobody has had.
 */
const USER_MESSAGE_COUNT_LIMIT = 2000;

const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The bilingual sentence the human is asked to agree with. Both languages are
 *  built by the tool, from structured values, so a Spanish read-back is Spanish
 *  by construction rather than by a translation at render time. */
export interface ReadBack {
  en: string;
  es: string;
}

/** What a PROPOSE call returns. `awaitingConfirmation` is load-bearing in three
 *  places: the model reads it as "nothing has happened yet", the fake-success
 *  guard reads it as "no mutation ran this turn", and the tests read it as the
 *  proof that a proposal wrote nothing. */
export interface ChatConfirmProposal<P> {
  awaitingConfirmation: true;
  nothingWrittenYet: true;
  readBack: ReadBack;
  confirm: {
    token: string;
    kind: ChatConfirmKind;
    /** Exactly what will be written. Quoted back, never re-derived. */
    params: P;
    /** How many messages the person had sent when this was read back. The
     *  confirmation needs strictly more — see the header. */
    saidCount: number;
  };
  howToConfirm: string;
}

const HOW_TO_CONFIRM =
  'NOTHING HAS BEEN SAVED. Read the readBack sentence to the person in their own language and wait ' +
  'for their reply. If — and only if — they answer yes in a NEW message, call this tool again with ' +
  'confirmToken set to the token above and nothing else; the saved wording is used, not whatever you ' +
  'send the second time. Calling it again in this same turn will be refused, because the person has ' +
  'not spoken yet. If they say no, or change something, do not send the token — propose again.';

/**
 * Freeze a plan and hand back the read-back. Writes nothing anywhere.
 *
 * The token is only useful once this result has been persisted by the route,
 * which happens immediately after the handler returns. A caller that never
 * reaches the route (an eval harness, a background job) therefore mints a token
 * that can never be redeemed — which is the correct behaviour for a surface
 * with no human in it.
 *
 * The one read it does is the count of what the person has said so far, which
 * includes the message that prompted this proposal (the route records the user
 * turn before the model runs). That is what makes "they have not answered yet"
 * the answer to a same-turn confirmation.
 */
export async function proposeConfirmation<P>(
  ctx: ToolHandlerContext,
  kind: ChatConfirmKind,
  params: P,
  readBack: ReadBack,
): Promise<ChatConfirmProposal<P>> {
  return {
    awaitingConfirmation: true,
    nothingWrittenYet: true,
    readBack,
    confirm: {
      token: randomUUID(),
      kind,
      params,
      saidCount: await countWhatTheySaid(ctx),
    },
    howToConfirm: HOW_TO_CONFIRM,
  };
}

/**
 * How many messages the human has sent in this conversation.
 *
 * Saturates at the ceiling and, on any read failure, returns the ceiling — so a
 * proposal minted during a database hiccup can never be confirmed rather than
 * being confirmable by anyone. Refusing is always the recoverable direction:
 * the person says it again.
 */
async function countWhatTheySaid(ctx: ToolHandlerContext): Promise<number> {
  try {
    const { data, error } = await ctx.db
      .from('agent_messages')
      .select('id')
      .eq('conversation_id', conversationIdOf(ctx))
      .eq('role', 'user')
      .limit(USER_MESSAGE_COUNT_LIMIT);
    if (error) throw new Error(error.message);
    return (data ?? []).length;
  } catch (e) {
    log.warn('[chat-confirm] could not count the conversation; this proposal will not be confirmable', {
      propertyId: ctx.propertyId,
      err: e instanceof Error ? e.message : String(e),
    });
    return USER_MESSAGE_COUNT_LIMIT;
  }
}

/** The conversation this turn belongs to, or the nil uuid for a caller that has
 *  none (a background job, the eval harness) — which matches no row, so every
 *  such proposal is unconfirmable by construction. */
function conversationIdOf(ctx: ToolHandlerContext): string {
  return typeof ctx.conversationId === 'string' && UUID_RX.test(ctx.conversationId)
    ? ctx.conversationId
    : NIL_UUID;
}

/** Marker written into a CONFIRM call's own result, so a replayed token is
 *  recognisable as already spent from the transcript alone. */
export function confirmedMarker(token: string): { confirmedToken: string } {
  return { confirmedToken: token };
}

export type ChatConfirmTake<P> =
  | { ok: true; params: P }
  | { ok: false; reason: TakeFailure; error: string };

export type TakeFailure =
  | 'not_found'
  | 'not_yet_answered'
  | 'expired'
  | 'already_done'
  | 'unreadable';

interface TranscriptRow {
  role?: unknown;
  tool_result?: unknown;
  created_at?: unknown;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The `confirm` block a proposal result carries, when this row is one. */
function proposalIn(row: TranscriptRow): {
  token: string;
  kind: string;
  params: unknown;
  saidCount: number | null;
} | null {
  const confirm = asObject(asObject(row.tool_result).confirm);
  const token = typeof confirm.token === 'string' ? confirm.token : null;
  const kind = typeof confirm.kind === 'string' ? confirm.kind : null;
  if (!token || !kind) return null;
  return {
    token,
    kind,
    params: confirm.params,
    saidCount: typeof confirm.saidCount === 'number' ? confirm.saidCount : null,
  };
}

/** Tokens this process has already redeemed. Keyed on the ToolContext object,
 *  which is the SAME instance for every tool call in one request — so two
 *  confirm calls the model emits in one turn cannot both write, even before
 *  either result reaches the transcript. The cross-request guard is the
 *  transcript scan below; this one closes the window the transcript cannot. */
const spentInThisRequest = new WeakMap<object, Set<string>>();

/**
 * Redeem a token, or say precisely why not.
 *
 * Reads the conversation ONCE and answers four questions from it: does this
 * proposal exist, was it for this kind of thing, has the human spoken since,
 * and has it already been used. Everything it needs comes from rows the ROUTE
 * wrote; nothing comes from the model beyond the token itself.
 */
export async function takeConfirmation<P>(
  ctx: ToolHandlerContext,
  kind: ChatConfirmKind,
  rawToken: unknown,
  now: Date = new Date(),
): Promise<ChatConfirmTake<P>> {
  const token = typeof rawToken === 'string' ? rawToken.trim() : '';
  if (!token) {
    return {
      ok: false,
      reason: 'not_found',
      error: 'No confirmation reference. Propose it first, read it back, and only send the token after the person answers.',
    };
  }

  const already = spentInThisRequest.get(ctx);
  if (already?.has(token)) {
    return {
      ok: false,
      reason: 'already_done',
      error: 'That confirmation has already been used in this exchange. It was done once — say so; do not do it again.',
    };
  }

  // A conversation id that is not a uuid (a background caller, an eval context)
  // is asked about anyway, with the nil uuid, so this function has exactly ONE
  // shape: one scoped read, then a decision. It matches nothing and refuses.
  const conversationId = conversationIdOf(ctx);

  let rows: TranscriptRow[];
  try {
    const { data, error } = await ctx.db
      .from('agent_messages')
      .select('role, tool_result, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(TRANSCRIPT_SCAN_LIMIT);
    if (error) throw new Error(error.message);
    rows = (data ?? []) as TranscriptRow[];
  } catch (e) {
    log.warn('[chat-confirm] could not read the conversation; refusing to act', {
      propertyId: ctx.propertyId,
      err: e instanceof Error ? e.message : String(e),
    });
    return {
      ok: false,
      reason: 'unreadable',
      error: 'I could not re-read what you agreed to, so I have not done it. Say it again in a moment.',
    };
  }

  let proposal: TranscriptRow | null = null;
  let frozen: unknown = null;
  let saidWhenProposed: number | null = null;
  let spent = false;
  for (const row of rows) {
    const result = asObject(row.tool_result);
    if (result.confirmedToken === token) spent = true;
    const found = proposalIn(row);
    if (!found || found.token !== token) continue;
    // A token only ever confirms the kind it was minted for. Without this a
    // proposal for one thing could be redeemed by a tool that writes another.
    if (found.kind !== kind) continue;
    proposal = row;
    frozen = found.params;
    saidWhenProposed = found.saidCount;
  }

  if (!proposal) {
    return {
      ok: false,
      reason: 'not_found',
      error: 'I have no proposal waiting under that reference. Do not guess one — propose it again and read it back.',
    };
  }
  if (spent) {
    return {
      ok: false,
      reason: 'already_done',
      error: 'That one is already done. Tell the person it was done rather than doing it a second time.',
    };
  }

  const proposedAtMs = Date.parse(String(proposal.created_at ?? ''));
  if (!Number.isFinite(proposedAtMs)) {
    return {
      ok: false,
      reason: 'unreadable',
      error: 'I could not tell when that was proposed, so I have not acted on it. Propose it again.',
    };
  }
  if (now.getTime() - proposedAtMs > CONFIRM_TTL_HOURS * 3_600_000) {
    return {
      ok: false,
      reason: 'expired',
      error: `That was proposed more than ${CONFIRM_TTL_HOURS} hours ago. Ask again from the top rather than acting on a stale yes.`,
    };
  }

  // ═══ THE GATE ═══ the person has said something since the read-back.
  //
  // A proposal written before this field existed (or by a caller whose count
  // read failed) has no baseline, and there is no honest way to invent one — so
  // it is refused, and the person is asked again.
  if (saidWhenProposed === null) {
    return {
      ok: false,
      reason: 'not_found',
      error: 'I cannot tell whether that was actually agreed to, so I have not acted on it. Propose it again and read it back.',
    };
  }
  const answered = (await countWhatTheySaid(ctx)) > saidWhenProposed;
  if (!answered) {
    return {
      ok: false,
      reason: 'not_yet_answered',
      error: 'You have not been answered yet. Read the sentence back and wait for the person to reply — your own agreement is not theirs.',
    };
  }

  const set = already ?? new Set<string>();
  set.add(token);
  spentInThisRequest.set(ctx, set);

  return { ok: true, params: frozen as P };
}
