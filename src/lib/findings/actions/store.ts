// ─── The hands' database door ────────────────────────────────────────────────
//
// Every read and write goes through `scopedDb(propertyId)`, the same one-hotel
// accessor the rest of the findings layer uses. The hotel filter is applied
// before the query builder is handed back, so nothing here can forget it — and
// the two RPCs take the hotel as an argument, which the accessor asserts
// against the one it was constructed for.
//
// WHAT THIS FILE DOES *NOT* DO
// It does not verify, it does not write a work order, and it does not undo.
// All three happen inside `staxis_execute_finding_action` /
// `staxis_undo_finding_action` (migration 0363), in ONE transaction, because
// PostgREST has none and "the work order was created but the receipt write
// failed" is a half-done state nobody can reconcile. This file freezes the
// plan, calls the function, and reads the answer.
//
// THE ONE THING IT DOES DECIDE: SUPERSEDING.
// A nightly re-find can produce a DIFFERENT plan for the same problem — the
// usage rate moved, so the covering reorder point moved with it. There may only
// ever be one live offer per finding (`finding_actions_one_open_per_finding_uq`),
// because the card has one button and two rows would make that button ambiguous.
// So the older, untapped offer is marked `superseded` rather than deleted: an
// offer nobody acted on is still a record of what Staxis was willing to do that
// night, and the audit trail costs one row.

import 'server-only';

import { scopedDb } from '@/lib/agent/scoped-db';
import { log } from '@/lib/log';

import { getAction } from './registry';
import type {
  ActionParams,
  ActionReceipt,
  ChangedFacts,
  FindingAction,
  FindingActionDraft,
  FindingActionKind,
  FindingActionState,
} from './types';

// Registering the catalog is a module side effect; the store is the one place
// that needs it to have happened.
import './catalog';

interface ActionRow {
  id: string;
  property_id: string;
  finding_id: string;
  action_kind: string;
  params: unknown;
  verify: unknown;
  state: string;
  receipt: unknown;
  changed_facts: unknown;
  failure_reason: string | null;
  proposed_at: string;
  decided_at: string | null;
  undone_at: string | null;
  outcome_due_at: string | null;
}

const SELECT_COLUMNS =
  'id, property_id, finding_id, action_kind, params, verify, state, receipt, ' +
  'changed_facts, failure_reason, proposed_at, decided_at, undone_at, outcome_due_at';

/** The states in which an action is still the one the card is about. */
const LIVE_ACTION_STATES: readonly FindingActionState[] = Object.freeze([
  'proposed',
  'executed',
  'declined_changed',
  'undone',
  'failed',
]);

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function rowToAction(row: ActionRow): FindingAction {
  const receipt = asObject(row.receipt);
  const changed = asObject(row.changed_facts);
  return {
    id: row.id,
    propertyId: row.property_id,
    findingId: row.finding_id,
    kind: row.action_kind as FindingActionKind,
    params: asObject(row.params) as ActionParams,
    verify: asObject(row.verify) as ActionParams,
    state: row.state as FindingActionState,
    receipt: typeof receipt.table === 'string' ? (receipt as unknown as ActionReceipt) : null,
    changedFacts: typeof changed.field === 'string' ? (changed as unknown as ChangedFacts) : null,
    failureReason: row.failure_reason,
    proposedAt: row.proposed_at,
    decidedAt: row.decided_at,
    undoneAt: row.undone_at,
    outcomeDueAt: row.outcome_due_at,
  };
}

// ─── Proposing ───────────────────────────────────────────────────────────────

export type ProposeOutcome =
  | 'proposed'
  | 'unchanged'
  | 'rejected'
  | 'settled'
  | 'failed';

/**
 * Freeze one action against a finding.
 *
 * Returns what happened, so the run summary can count it honestly:
 *   proposed   a new offer is on the card
 *   unchanged  the identical offer was already there — the common case on the
 *              second and every subsequent night a problem persists
 *   settled    this finding's action has already been executed / declined /
 *              undone. A settled decision is not re-offered; the manager
 *              already answered.
 *   rejected   the catalog refused the plan (a malformed offer never reaches
 *              the row, so a card can never grow a button that would fail)
 *   failed     the write itself failed. Loud, and NOT fatal to the run: a
 *              finding without its action is a card that reads as a
 *              recommendation, which is exactly what it was before this layer.
 *
 * Never throws. A hands failure must not be able to fail a night whose findings
 * are correct without it.
 */
export async function proposeAction(
  propertyId: string,
  findingId: string,
  draft: FindingActionDraft,
): Promise<ProposeOutcome> {
  const definition = getAction(draft.kind);
  if (!definition) {
    log.error('[findings:actions] a detector proposed an action kind the catalog does not have', {
      propertyId,
      kind: draft.kind,
    });
    return 'rejected';
  }

  const invalid = definition.validate(draft.params);
  if (invalid) {
    log.error('[findings:actions] a proposed plan was refused before it could be frozen', {
      propertyId,
      kind: draft.kind,
      because: invalid,
    });
    return 'rejected';
  }

  try {
    const db = scopedDb(propertyId);

    const existing = await db
      .from('finding_actions')
      .select(SELECT_COLUMNS)
      .eq('finding_id', findingId)
      .in('state', [...LIVE_ACTION_STATES]);
    if (existing.error) throw new Error(existing.error.message);

    const rows = ((existing.data ?? []) as unknown as ActionRow[]).map(rowToAction);

    // A decision the manager already made is not re-offered. Without this, a
    // manager who approved a work order on Monday would be asked again on
    // Tuesday, and again on Wednesday, for as long as the underlying problem
    // took to clear — which is exactly the nagging the silencer exists to
    // prevent, wearing a button.
    if (rows.some((row) => row.state !== 'proposed')) return 'settled';

    const open = rows.find((row) => row.state === 'proposed');
    if (open && samePlan(open, draft)) return 'unchanged';

    if (open) {
      const superseded = await db
        .from('finding_actions')
        .update({ state: 'superseded' })
        .eq('id', open.id)
        .eq('state', 'proposed');
      if (superseded.error) throw new Error(superseded.error.message);
    }

    // `params_fingerprint` and `idempotency_key` are deliberately NOT supplied:
    // the database computes both from `params` on insert (0363), so a
    // fingerprint can never disagree with the plan it fingerprints.
    const inserted = await db.from('finding_actions').insert({
      finding_id: findingId,
      action_kind: draft.kind,
      params: draft.params,
      verify: draft.verify,
      state: 'proposed',
    });

    if (inserted.error) {
      // 23505: another runner froze the identical plan a millisecond earlier.
      // One offer exists, which is the outcome we wanted.
      if (/duplicate key value|unique constraint/i.test(inserted.error.message)) return 'unchanged';
      throw new Error(inserted.error.message);
    }
    return 'proposed';
  } catch (e) {
    log.error('[findings:actions] could not attach an action to a finding', {
      propertyId,
      findingId,
      kind: draft.kind,
      err: e instanceof Error ? e.message : String(e),
    });
    return 'failed';
  }
}

/** Same kind, same plan. `verify` is deliberately NOT compared — see below. */
function samePlan(existing: FindingAction, draft: FindingActionDraft): boolean {
  if (existing.kind !== draft.kind) return false;
  return stableJson(existing.params) === stableJson(draft.params);
}

/**
 * WHY `verify` IS FROZEN AT THE FIRST OFFER AND NEVER REFRESHED
 *
 * `verify` holds the facts the offer rests on — "there were 4 open work orders
 * on Room 214 when Staxis offered this". The execute function declines when the
 * live count has fallen BELOW that number, which is the honest question: has
 * the situation that made this worth doing gone away?
 *
 * Refreshing it every night would quietly re-baseline that question. A hotel
 * that closed three of the four tickets would have `verify` rewritten to 1, and
 * the offer would then execute happily against a problem that had just been
 * dealt with. The first offer's facts are the ones the manager is being asked
 * about, so they are the ones that must still hold.
 */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner) => {
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(inner as Record<string, unknown>).sort()) {
        sorted[key] = (inner as Record<string, unknown>)[key];
      }
      return sorted;
    }
    return inner;
  });
}

// ─── Reading ─────────────────────────────────────────────────────────────────

/**
 * The action attached to each of these findings, keyed by finding id.
 *
 * Only rows that are still ABOUT the card: a superseded offer is history, not
 * an offer. Never throws — a card whose action could not be read renders as the
 * plain finding it was before this layer existed, which is a degradation, not a
 * lie.
 */
export async function loadActionsForFindings(
  propertyId: string,
  findingIds: readonly string[],
): Promise<Map<string, FindingAction>> {
  const out = new Map<string, FindingAction>();
  if (findingIds.length === 0) return out;

  try {
    const { data, error } = await scopedDb(propertyId)
      .from('finding_actions')
      .select(SELECT_COLUMNS)
      .in('finding_id', [...findingIds])
      .in('state', [...LIVE_ACTION_STATES])
      .limit(500);
    if (error) throw new Error(error.message);

    for (const row of (data ?? []) as unknown as ActionRow[]) {
      const action = rowToAction(row);
      const current = out.get(action.findingId);
      // A finding can carry at most one live offer plus at most one settled
      // one (the offer was executed, and a later run did not re-offer). Prefer
      // the settled row: "here is what happened" outranks "here is what could".
      if (!current || (current.state === 'proposed' && action.state !== 'proposed')) {
        out.set(action.findingId, action);
      }
    }
  } catch (e) {
    log.warn('[findings:actions] action read failed; cards render without their buttons', {
      propertyId,
      err: e instanceof Error ? e.message : String(e),
    });
  }
  return out;
}

/** One action, scoped to this hotel. Null when it belongs to another one. */
export async function loadAction(
  propertyId: string,
  actionId: string,
): Promise<FindingAction | null> {
  const { data, error } = await scopedDb(propertyId)
    .from('finding_actions')
    .select(SELECT_COLUMNS)
    .eq('id', actionId)
    .limit(1);
  if (error) throw new Error(`finding_actions read failed: ${error.message}`);
  const rows = (data ?? []) as unknown as ActionRow[];
  return rows[0] ? rowToAction(rows[0]) : null;
}

// ─── Executing and undoing ───────────────────────────────────────────────────

export interface ActionCallResult {
  ok: boolean;
  /** 'executed' | 'already_executed' | 'declined_changed' | 'failed' |
   *  'not_found' | 'tampered' | 'undone' | 'already_undone' |
   *  'undo_refused_touched' | 'not_undoable' | 'already_<state>' */
  code: string;
  receipt?: ActionReceipt | null;
  changed?: ChangedFacts | null;
  why?: string | null;
  error?: string | null;
}

function envelopeOf(data: unknown): ActionCallResult {
  const raw = asObject(data);
  const receipt = asObject(raw.receipt);
  const changed = asObject(raw.changed);
  return {
    ok: raw.ok === true,
    code: typeof raw.code === 'string' ? raw.code : 'unknown',
    receipt: typeof receipt.table === 'string' ? (receipt as unknown as ActionReceipt) : null,
    changed: typeof changed.field === 'string' ? (changed as unknown as ChangedFacts) : null,
    why: typeof raw.why === 'string' ? raw.why : null,
    error: typeof raw.error === 'string' ? raw.error : null,
  };
}

/**
 * Run the frozen plan. One transaction, in the database.
 *
 * The post-condition check afterwards reads the receipt the DATABASE wrote and
 * asks whether it is what the plan said. It cannot prevent a wrong write — the
 * transaction has already committed — and does not pretend to. What it catches
 * is the SQL branch and the catalog entry drifting apart, which would otherwise
 * show up as a card confidently reporting the wrong thing.
 */
export async function executeAction(
  propertyId: string,
  actionId: string,
  accountId: string | null,
): Promise<ActionCallResult> {
  const { data, error } = await scopedDb(propertyId).rpc('staxis_execute_finding_action', {
    p_action_id: actionId,
    p_property_id: propertyId,
    p_account_id: accountId,
  });
  if (error) throw new Error(`finding action execute failed: ${error.message}`);

  const result = envelopeOf(data);
  if (result.ok && result.receipt) {
    const action = await loadAction(propertyId, actionId).catch(() => null);
    const definition = action ? getAction(action.kind) : null;
    if (action && definition) {
      const post = definition.postCondition(result.receipt, action.params);
      if (!post.ok) {
        // Loud, and NOT turned into a failure for the manager: the work really
        // was done. What is wrong is our description of it, and a silent
        // mismatch here is how a card starts reporting fiction.
        log.error('[findings:actions] post-condition violated — the receipt is not the plan', {
          propertyId,
          actionId,
          kind: action.kind,
          because: post.because,
        });
      }
    }
  }
  return result;
}

/** Reverse it. Refuses, with a reason, when a human has been at the result. */
export async function undoAction(
  propertyId: string,
  actionId: string,
  accountId: string | null,
): Promise<ActionCallResult> {
  const { data, error } = await scopedDb(propertyId).rpc('staxis_undo_finding_action', {
    p_action_id: actionId,
    p_property_id: propertyId,
    p_account_id: accountId,
  });
  if (error) throw new Error(`finding action undo failed: ${error.message}`);
  return envelopeOf(data);
}
