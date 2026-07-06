// ─── confirm_pending_action / cancel_pending_action — voice control tools ──
//
// The spoken-confirmation half of the voice approval gate. When the voice brain
// proposes a CARD-tier mutation (log_complaint, createMaintenanceWorkOrder, …),
// the gate in llm.ts HOLDS it: it stages an agent_pending_actions row and the
// voice-brain route speaks a read-back ("Just to confirm — log a guest complaint
// for room 305: 'no hot water'. Say yes to go ahead, or tell me what to
// change."). The held action is NOT executed.
//
// On the NEXT voice turn, the user answers out loud. These two tools are the
// only way the held action resolves:
//
//   • confirm_pending_action — the user agreed. Claim the newest pending row,
//       run the held tool via executeTool, finalize the row, and return the
//       summary so the model speaks "Done — {summary}".
//   • cancel_pending_action  — the user declined (or wants something different;
//       the prompt tells the model to cancel first, then handle the new
//       request). Mark the newest pending row denied and return the summary.
//
// Safety:
//   • mutates: FALSE. These are CONTROL FLOW, not mutations — the REAL mutation
//     (the held card) already passed the gate. mutates:false guarantees the gate
//     itself can NEVER hold confirm/cancel (partitionGatedCalls only holds
//     mutations), so there is no way to get stuck needing to confirm a confirm.
//   • Every row these touch is scoped to ctx.conversationId AND re-checked
//     against ctx.propertyId + ctx.accountId before anything runs, so one
//     session can only ever confirm/cancel its own held action.
//   • surfaces: ['voice'] — chat-excluded (chat has its own tap-a-card gate).
//   • No voiceModes → available in ALL voice modes (general, housekeeper_issue,
//     compliance), because a held card can arise in any of them.

import { registerTool, executeTool, type ToolResult, type ToolContext } from '../tools';
import { ALL_ROLES } from '@/lib/roles';
import { buildActionSummary } from '../approval';
import { pickVoiceLang } from '../voice-confirm-copy';
import {
  getLivePendingActions,
  claimPendingAction,
  finalizePendingAction,
  type PendingActionRow,
} from '../pending-actions';

/** Resolve the caller's spoken language for the tool-result copy. Shares the
 *  single source of truth with the route's read-back copy (voice-confirm-copy). */
const pickLang = pickVoiceLang;

// A spoken confirmation is a one-turn affair (stage on turn N → answer on N+1).
// The confirm/cancel tools only ever act on a row created within this window,
// matching the voice-brain route's own gate so the model can't confirm a row the
// route decided was too old to surface. Well under the row's 10-min DB TTL.
const CONFIRM_WINDOW_MS = 3 * 60_000;

/**
 * Find the newest recently-created pending row this voice session may act on.
 * Scopes by conversationId (via the query) AND re-checks propertyId + accountId
 * in JS — defence in depth so a session can never resolve a row that isn't its
 * own even if two sessions somehow shared a conversationId — AND bounds by the
 * confirmation window so an abandoned older proposal can't be confirmed later.
 */
async function newestOwnedPending(ctx: ToolContext): Promise<PendingActionRow | null> {
  const convId = ctx.conversationId;
  if (!convId) return null;
  const rows = await getLivePendingActions(convId);
  // getLivePendingActions returns oldest→newest, non-expired, status='pending'.
  const now = Date.now();
  const owned = rows.filter(
    (r) =>
      r.propertyId === ctx.propertyId &&
      r.accountId === ctx.user.accountId &&
      now - new Date(r.createdAt).getTime() <= CONFIRM_WINDOW_MS,
  );
  return owned.length > 0 ? owned[owned.length - 1] : null;
}

// ─── confirm_pending_action ─────────────────────────────────────────────────
registerTool<Record<string, never>>({
  name: 'confirm_pending_action',
  description:
    'Call this when the user SPOKEN-CONFIRMS an action you already read back to them for confirmation ' +
    '(they said yes / go ahead / do it / correct / sí / dale / hazlo). ' +
    'It runs the exact action that is waiting — you do NOT re-specify anything; it uses what was already staged. ' +
    'Only call this when the system prompt says an action is awaiting confirmation. After it runs, tell the user in ONE short sentence what was done.',
  inputSchema: { type: 'object', properties: {} },
  allowedRoles: ALL_ROLES,
  surfaces: ['voice'],
  mutates: false,
  handler: async (_args, ctx): Promise<ToolResult> => {
    const lang = pickLang(ctx.voiceLang);
    const row = await newestOwnedPending(ctx);
    if (!row) {
      return {
        ok: true,
        data: {
          nothing_pending: true,
          message:
            lang === 'es'
              ? 'No hay nada esperando confirmación en este momento.'
              : "There's nothing waiting for confirmation right now.",
        },
      };
    }

    const summary = buildActionSummary(row.toolName, row.toolArgs, lang);

    // Single-use claim: pending → approved only if still pending. A race (double
    // "yes", or a stale replayed turn) loses here and we report nothing pending.
    const claimed = await claimPendingAction(row.id, 'approved');
    if (!claimed) {
      return {
        ok: true,
        data: {
          nothing_pending: true,
          message:
            lang === 'es'
              ? 'Esa acción ya se resolvió.'
              : 'That action was already handled.',
        },
      };
    }

    // Execute the held tool. The gate already vetted it as a card-tier voice
    // mutation at STAGE time (surface + role + voice-mode all passed then, and
    // the tier is server-decided so the client can't downgrade it). We drop the
    // voice-MODE gate on this deliberate re-execution: the pending row doesn't
    // carry the staging mode, and if the confirming turn's session were resolved
    // in a different mode (e.g. a mode-scoped tool like createMaintenanceWorkOrder
    // was staged in housekeeper_issue mode), executeTool's mode gate would
    // wrongly refuse a legitimately-approved action. surface + role + property +
    // capability gates all STILL apply. Codex review finding (mode mismatch).
    const execCtx: ToolContext = { ...ctx, voiceMode: undefined };
    let result: ToolResult;
    try {
      result = await executeTool(row.toolName, row.toolArgs, execCtx);
    } catch (err) {
      await finalizePendingAction({
        id: row.id,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        ok: false,
        error:
          lang === 'es'
            ? `No pude completar la acción: ${summary}.`
            : `I couldn't complete that: ${summary}.`,
      };
    }

    if (!result.ok) {
      await finalizePendingAction({ id: row.id, status: 'failed', error: result.error ?? null });
      return {
        ok: false,
        // Surface the underlying tool's reason so the model can explain it.
        error:
          (result.error ? `${result.error} ` : '') +
          (lang === 'es' ? `(no se ejecutó: ${summary})` : `(not done: ${summary})`),
      };
    }

    await finalizePendingAction({ id: row.id, status: 'executed', result: result.data ?? null });
    return {
      ok: true,
      data: {
        executed: true,
        toolName: row.toolName,
        summary,
        // Deterministic done-line the model should speak verbatim (accurate by
        // construction — built from the staged args, not model free-text).
        spoken:
          lang === 'es' ? `Listo — ${summary}.` : `Done — ${summary}.`,
        result: result.data ?? null,
      },
    };
  },
});

// ─── cancel_pending_action ──────────────────────────────────────────────────
registerTool<Record<string, never>>({
  name: 'cancel_pending_action',
  description:
    'Call this when the user DECLINES an action you read back for confirmation ' +
    '(they said no / cancel / never mind / stop / no importa / déjalo), ' +
    'OR when they instead ask for something different (cancel the waiting action FIRST, then handle their new request). ' +
    'It discards the action that is waiting without running it. Only call this when the system prompt says an action is awaiting confirmation.',
  inputSchema: { type: 'object', properties: {} },
  allowedRoles: ALL_ROLES,
  surfaces: ['voice'],
  mutates: false,
  handler: async (_args, ctx): Promise<ToolResult> => {
    const lang = pickLang(ctx.voiceLang);
    const row = await newestOwnedPending(ctx);
    if (!row) {
      return {
        ok: true,
        data: {
          nothing_pending: true,
          message:
            lang === 'es'
              ? 'No hay nada que cancelar en este momento.'
              : "There's nothing to cancel right now.",
        },
      };
    }

    const summary = buildActionSummary(row.toolName, row.toolArgs, lang);
    // Claim → denied, single-use. If it was already resolved, treat as no-op.
    const claimed = await claimPendingAction(row.id, 'denied');
    if (!claimed) {
      return {
        ok: true,
        data: {
          nothing_pending: true,
          message:
            lang === 'es'
              ? 'Esa acción ya se resolvió.'
              : 'That action was already handled.',
        },
      };
    }
    // claimPendingAction already stamped status='denied' + resolved_at; denied is
    // a first-class terminal status, so no further finalize is required.
    return {
      ok: true,
      data: {
        cancelled: true,
        toolName: row.toolName,
        summary,
        spoken:
          lang === 'es' ? `De acuerdo, cancelado — ${summary}.` : `Okay, cancelled — ${summary}.`,
      },
    };
  },
});
