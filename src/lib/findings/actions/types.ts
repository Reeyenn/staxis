// ─── The hands: what an action IS ────────────────────────────────────────────
//
// A finding says what is wrong. An action is the fix, attached to the card, so
// that "room 214 has had four work orders in thirty days" arrives with
// "create a work order for a full inspection?" and one tap does it.
//
// THE FOUR RULES THIS FILE SHAPES
//
//   1. FROZEN AT PROPOSAL TIME. The parameters are computed by CODE when the
//      card is written, from the finding's own evidence, and stored. No model
//      is involved at proposal time and none at execution time. `params` is
//      immutable in the database (migration 0363), so "what runs is what was
//      shown" is a property, not a promise.
//
//   2. RE-VERIFIED AT THE TAP. `verify` is the finding's receipt in machine
//      form — the specific facts the offer rests on. The execute function
//      re-derives them against live rows INSIDE the transaction that would do
//      the work, and declines when they moved. Age is a proxy; changed-ness is
//      the thing.
//
//   3. EVERY KIND IS UNDOABLE. A kind whose effect cannot be reversed does not
//      belong in the catalog, and `declaration.undoDescription` is the forcing
//      function: you cannot register one without writing down how it comes back.
//
//   4. THE COPY IS DERIVED, NEVER STORED. The button text and the receipt line
//      are pure functions of the frozen params, in both languages. Freezing
//      English into the row would either make a Spanish-speaking manager read
//      English or make the two languages drift; deriving it means the sentence
//      is a rendering of the plan rather than a second copy of it.
//
// WHAT LIVES IN SQL AND WHY
// Verification, the write, the receipt and the undo are in plpgsql (0363),
// because PostgREST has no transactions and "the work order was created but the
// receipt write failed" is a half-done state nobody can reconcile. This file
// owns the PROPOSAL half — which action, with which parameters, described how —
// plus the post-condition check that reads the receipt the database handed back.

import type { FindingDraft, JsonValue } from '../types';
import type { ActionAdmissionContract } from '@/lib/staxis/foundation';

/** Every action the catalog knows. Mirrors the CHECK on finding_actions.action_kind. */
export type FindingActionKind = 'create_work_order' | 'raise_inventory_reorder_point';

/** Mirrors finding_actions.state. See 0363 for what each one means. */
export type FindingActionState =
  | 'proposed'
  | 'superseded'
  | 'executed'
  | 'declined_changed'
  | 'undone'
  | 'failed';

export type ActionParams = Readonly<Record<string, JsonValue>>;

export type Lang = 'en' | 'es';

/** A bilingual string. Every user-facing sentence in this layer is one. */
export interface Bilingual {
  en: string;
  es: string;
}

export function pickLang(value: Bilingual, lang: Lang): string {
  return lang === 'es' ? value.es : value.en;
}

/**
 * What a detector proposes doing, before it has an id or a hotel.
 *
 * Deliberately carries NO prose. The words come from the catalog entry, from
 * these params, at render time.
 */
export interface FindingActionDraft {
  kind: FindingActionKind;
  /** Exactly what will be done. Frozen; must not contain the measurement. */
  params: ActionParams;
  /** The facts that must still hold at the tap. May contain the measurement. */
  verify: ActionParams;
}

/**
 * A stored action, as the card reads it back.
 */
export interface FindingAction {
  id: string;
  propertyId: string;
  findingId: string;
  kind: FindingActionKind;
  params: ActionParams;
  verify: ActionParams;
  state: FindingActionState;
  receipt: ActionReceipt | null;
  changedFacts: ChangedFacts | null;
  failureReason: string | null;
  proposedAt: string;
  decidedAt: string | null;
  undoneAt: string | null;
  outcomeDueAt: string | null;
}

/** What the database says it actually did. Built by 0363 from the rows it
 *  touched, never from the plan — a receipt copied from the intention would
 *  agree with itself forever. */
export interface ActionReceipt {
  table: string;
  id: string;
  kind: 'created' | 'changed';
  label: string;
  where?: string | null;
  column?: string | null;
  from?: number | null;
  to?: number | null;
}

/** What moved between the proposal and the tap. Rendered instead of a receipt
 *  when the action declined. */
export interface ChangedFacts {
  field: string;
  was: JsonValue;
  now: JsonValue;
  subject?: string | null;
  why: string;
}

// ─── The catalog entry ───────────────────────────────────────────────────────

/**
 * Whether the receipt the database returned is the thing this action was
 * supposed to achieve. Runs AFTER the transaction committed, over the receipt
 * the database itself wrote.
 *
 * It cannot prevent a wrong write — the transaction is already closed — and it
 * is not pretending to. What it catches is the class of bug where the SQL
 * branch and the catalog entry drift apart: the params say "raise it to 38",
 * the receipt says "changed to 18", and without this the card would cheerfully
 * render "done". A violation is reported, never swallowed.
 */
export type PostConditionResult = { ok: true } | { ok: false; because: string };

export interface ActionDefinition<P extends ActionParams = ActionParams> {
  readonly kind: FindingActionKind;
  /** One line, product terms. Shown in logs and in the admin view of a card. */
  readonly description: string;
  /**
   * How this comes back. Required, and required to be true: an action whose
   * author cannot write this sentence is an action that should not exist.
   */
  readonly undoDescription: string;
  /** Days after execution to go back and ask whether the fix held. */
  readonly outcomeCheckDays: number;
  /** Machine-readable effect/authority/approval/receipt contract. */
  readonly actionContract?: ActionAdmissionContract;
  /**
   * Reject anything that is not a usable plan for this kind. Returns null when
   * the params are good, or the reason they are not. Applied at PROPOSAL time,
   * so a malformed plan never reaches the row — and again at read time, so a
   * row written by an older version of this file cannot render a button that
   * would fail.
   */
  validate(params: ActionParams): string | null;
  /** The button. "Create the work order". */
  label(params: P): Bilingual;
  /** The offer, in full. "Create a work order for a full inspection of Room 214." */
  offer(params: P): Bilingual;
  /** The receipt line after it ran. "Work order created for Room 214." */
  receiptLine(receipt: ActionReceipt, params: P): Bilingual;
  /** Did the database do what the plan said? */
  postCondition(receipt: ActionReceipt, params: P): PostConditionResult;
}

export type AnyActionDefinition = ActionDefinition<ActionParams>;

// ─── How a detector attaches one ─────────────────────────────────────────────

/**
 * A pure function from a finding draft to the fix for it, or null when this
 * particular draft has no fix Staxis may perform.
 *
 * PURE, and with no database handle, for the same reason a detector is: the
 * thing that gets frozen must be a function of what the card says, and nothing
 * else. A template that could query would be able to freeze a parameter the
 * manager was never shown.
 *
 * Returning null is the common case and is not a failure — most findings are
 * things only a human can act on, and those stay recommendations.
 */
export type ActionTemplate = (draft: FindingDraft) => FindingActionDraft | null;
