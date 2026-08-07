// ─── Agent decision corpus (migration 0350) ────────────────────────────────
//
// One row per AI decision, holding the thing nothing else holds: WHAT THE
// HOTEL LOOKED LIKE when the decision was made. `buildHotelSnapshot()` output
// is stringified into the system prompt every turn and then thrown away, so
// "what was the AI actually looking at when it said that?" is currently
// unanswerable — and unanswerable forever, since the state is gone.
//
// The write is FAIL-SOFT by design: a corpus write must never break a hotel's
// chat. Every function here swallows its errors and logs. The trade is
// deliberate and stated: we would rather lose a corpus row than a conversation.
//
// PII: the snapshot is redacted through the same masker the memory layer uses
// before it is stored. The snapshot carries operational counts today, but its
// shape can change under a future feature (a myRooms array already carries
// room numbers), and a long-lived table is the wrong place to discover that.

import { scopedDb } from '@/lib/agent/scoped-db';
import { createHash } from 'node:crypto';
import { redactMemoryContent } from './memory-redact';
import { propertyLocalToday } from '@/lib/schedule/local-date';
import type { HotelSnapshot } from './context';
import type { AgentSurface } from './tools';

export type DecisionActorKind =
  | 'ai_proposed'
  | 'human_approved'
  | 'human_denied'
  | 'human_edited'
  | 'ai_autonomous'
  | 'human_direct';

/**
 * The surfaces migration 0350's CHECK actually admits.
 *
 * `AgentSurface` and this list are NOT the same set and must not be assumed to
 * be: the type grew 'portfolio' in July and 'messages' in August 2026, and the
 * column's CHECK has never been widened for either. An insert carrying one of
 * those is bounced by Postgres, and every writer in this module is fail-soft,
 * so the row would vanish with a warning nobody reads.
 *
 * The failure that actually matters is the OTHER one. The obvious way to make a
 * new surface's rows land is to pass the nearest allowed value, and for the
 * "@Staxis" thread assistant that value is 'chat' — which puts a wrong answer
 * in the one table whose entire job is answering "what was the AI looking at,
 * and where". A corpus that quietly mislabels where an act happened is worse
 * than a corpus that is missing it, because the missing row is visible as a gap
 * and the wrong row is not visible at all.
 *
 * So: an unrepresentable surface SKIPS the write and says so once. Widening the
 * CHECK is a migration, and until somebody makes that decision on purpose this
 * module refuses to guess on their behalf.
 */
export const DECISION_CORPUS_SURFACES = ['chat', 'voice', 'walkthrough', 'cron', 'api'] as const;
export type DecisionCorpusSurface = (typeof DECISION_CORPUS_SURFACES)[number];

/** The surface as the corpus column can store it, or null when it cannot. */
export function decisionCorpusSurfaceOf(
  surface: AgentSurface | 'cron' | 'api',
): DecisionCorpusSurface | null {
  return (DECISION_CORPUS_SURFACES as readonly string[]).includes(surface)
    ? surface as DecisionCorpusSurface
    : null;
}

export interface RecordProposalInput {
  propertyId: string;
  /** Used for DINV-2's business date. */
  snapshot: HotelSnapshot;
  surface: AgentSurface | 'cron' | 'api';
  actorKind: DecisionActorKind;
  actorAccountId: string | null;
  actorRole: string | null;
  conversationId: string | null;
  pendingActionId: string | null;
  toolName: string;
  proposedArgs: Record<string, unknown>;
  modelId?: string | null;
  promptVersion?: string | null;
}

export interface RecordResolutionInput {
  /** The hotel this decision belongs to. Present so the update runs through
   *  the scoped accessor like every other AI-layer query: the row is found by
   *  a unique pendingActionId, but scoping it means a mishandled id can never
   *  reach across tenants. The resolve route has already checked this matches
   *  the pending action before calling. */
  propertyId: string;
  pendingActionId: string;
  actorKind: DecisionActorKind;
  actorAccountId: string | null;
  executedArgs: Record<string, unknown> | null;
  decisionMs: number | null;
  result?: unknown;
  error?: string | null;
}

/**
 * Stable content hash of the snapshot. Present from day one so a later
 * content-addressed dedup table is a mechanical migration rather than a
 * re-derivation of history. Do NOT build that table now — a snapshot is 2-4 KB
 * against a 42 MB database.
 */
export function snapshotHash(snapshot: unknown): string {
  return createHash('sha256').update(JSON.stringify(snapshot ?? null)).digest('hex').slice(0, 32);
}

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Keys whose values are identifiers, not prose. */
const IDENTIFIER_KEY_RX = /(^id$|_id$|Id$|hash$|timezone$)/;

/**
 * Mask contact PII anywhere in the snapshot before it becomes long-lived data.
 *
 * Walks the structure rather than mangling the JSON string. The string approach
 * is what you reach for first and it is wrong: `redactMemoryContent`'s
 * card-number pattern (13-19 digit runs) matches the digits inside a UUID, so
 * every property id in every stored snapshot would come back as "[number]".
 * A test caught that; keep the walk.
 */
export function redactSnapshot<T>(snapshot: T): T {
  const walk = (value: unknown, key: string | null): unknown => {
    if (typeof value === 'string') {
      if (key && IDENTIFIER_KEY_RX.test(key)) return value;
      if (UUID_RX.test(value)) return value;
      return redactMemoryContent(value).content;
    }
    if (Array.isArray(value)) return value.map(v => walk(v, key));
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = walk(v, k);
      }
      return out;
    }
    return value;
  };
  return walk(snapshot, null) as T;
}

function businessDateOf(snapshot: HotelSnapshot): string {
  // DINV-2: the hotel's LOCAL business date. The snapshot already computed it
  // from properties.timezone; fall back to recomputing rather than to UTC.
  return snapshot.today || propertyLocalToday(new Date(), snapshot.property?.timezone ?? null);
}

/**
 * Record a decision at PROPOSAL time. Returns the new decision id, or null when
 * the write failed (never throws — see the module header).
 */
export async function recordDecisionProposal(
  input: RecordProposalInput,
): Promise<string | null> {
  const surface = decisionCorpusSurfaceOf(input.surface);
  if (!surface) {
    console.warn('[agent/decisions] proposal not recorded: the corpus cannot store the '
      + `"${input.surface}" surface yet, and labelling it as another one would be a wrong answer`);
    return null;
  }
  try {
    const snapshot = redactSnapshot(input.snapshot);
    const { data, error } = await scopedDb(input.propertyId)
      .from('agent_decisions')
      .insert({
        property_id: input.propertyId,
        business_date: businessDateOf(input.snapshot),
        surface,
        actor_kind: input.actorKind,
        actor_account_id: input.actorAccountId,
        actor_role: input.actorRole,
        conversation_id: input.conversationId,
        pending_action_id: input.pendingActionId,
        tool_name: input.toolName,
        proposed_args: input.proposedArgs ?? {},
        state_snapshot: snapshot,
        state_snapshot_hash: snapshotHash(snapshot),
        model_id: input.modelId ?? null,
        prompt_version: input.promptVersion ?? null,
      })
      .select('id')
      .single();
    if (error) {
      console.warn('[agent/decisions] proposal write failed', error.message);
      return null;
    }
    return (data?.id as string) ?? null;
  } catch (err) {
    console.warn('[agent/decisions] proposal write threw', err);
    return null;
  }
}

export interface RecordAutonomousInput extends Omit<RecordProposalInput, 'actorKind' | 'pendingActionId'> {
  /** What the tool actually returned. Stored so "why did you say that" has the
   *  same answer for an autonomous act as it does for an approved one. */
  result?: unknown;
  error?: string | null;
}

/**
 * Record an act the model performed with NO approval card in front of it.
 *
 * `ai_autonomous` has been a member of DecisionActorKind since 0350 and no code
 * path had ever written it, so the corpus held every proposal a human was asked
 * about and nothing the companion simply did. That gap is exactly the acts
 * nobody watched happen — the confirm-in-chat tools, whose gate is a human
 * sentence rather than a card, and every mutation on a surface that runs with
 * the approval gate off.
 *
 * The row is written COMPLETE: proposal and execution are the same moment, so
 * `executed_args` mirrors `proposed_args` (the DB's args_diff trigger therefore
 * computes an empty diff, which is the truth: nobody corrected anything) and
 * `decision_ms` is deliberately null rather than zero, because no human took
 * any time to decide.
 *
 * Fail-soft, like everything else in this module.
 */
export async function recordAutonomousDecision(
  input: RecordAutonomousInput,
): Promise<void> {
  const surface = decisionCorpusSurfaceOf(input.surface);
  if (!surface) {
    console.warn('[agent/decisions] autonomous act not recorded: the corpus cannot store the '
      + `"${input.surface}" surface yet, and labelling it as another one would be a wrong answer`);
    return;
  }
  try {
    const snapshot = redactSnapshot(input.snapshot);
    const { error } = await scopedDb(input.propertyId)
      .from('agent_decisions')
      .insert({
        property_id: input.propertyId,
        business_date: businessDateOf(input.snapshot),
        surface,
        actor_kind: 'ai_autonomous' satisfies DecisionActorKind,
        actor_account_id: input.actorAccountId,
        actor_role: input.actorRole,
        conversation_id: input.conversationId,
        pending_action_id: null,
        tool_name: input.toolName,
        proposed_args: input.proposedArgs ?? {},
        executed_args: input.proposedArgs ?? {},
        decision_ms: null,
        state_snapshot: snapshot,
        state_snapshot_hash: snapshotHash(snapshot),
        model_id: input.modelId ?? null,
        prompt_version: input.promptVersion ?? null,
        result: input.result === undefined ? null : (input.result as never),
        error: input.error ?? null,
      });
    if (error) console.warn('[agent/decisions] autonomous write failed', error.message);
  } catch (err) {
    console.warn('[agent/decisions] autonomous write threw', err);
  }
}

/**
 * Fill in what the human decided and what actually ran. `args_diff` — the
 * correction signal — is computed by a DB trigger, not here, so a future call
 * site cannot forget it.
 */
export async function recordDecisionResolution(
  input: RecordResolutionInput,
): Promise<void> {
  try {
    const { error } = await scopedDb(input.propertyId)
      .from('agent_decisions')
      .update({
        actor_kind: input.actorKind,
        actor_account_id: input.actorAccountId,
        executed_args: input.executedArgs,
        decision_ms: input.decisionMs,
        result: input.result === undefined ? null : (input.result as never),
        error: input.error ?? null,
      })
      .eq('pending_action_id', input.pendingActionId);
    if (error) console.warn('[agent/decisions] resolution write failed', error.message);
  } catch (err) {
    console.warn('[agent/decisions] resolution write threw', err);
  }
}

/**
 * Classify the human's verdict. `human_edited` is the interesting one: it is
 * the case where the AI was nearly right, and the diff is the correction.
 */
export function actorKindForDecision(
  decision: 'approve' | 'deny',
  proposedArgs: Record<string, unknown>,
  executedArgs: Record<string, unknown>,
): DecisionActorKind {
  if (decision === 'deny') return 'human_denied';
  const keys = new Set([...Object.keys(proposedArgs ?? {}), ...Object.keys(executedArgs ?? {})]);
  for (const k of keys) {
    if (JSON.stringify(proposedArgs?.[k]) !== JSON.stringify(executedArgs?.[k])) {
      return 'human_edited';
    }
  }
  return 'human_approved';
}
