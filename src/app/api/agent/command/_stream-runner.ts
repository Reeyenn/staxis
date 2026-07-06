// ─── Shared agent-stream runner ────────────────────────────────────────────
//
// The event→persistence→SSE loop that BOTH /api/agent/command (a fresh user
// turn) and /api/agent/command/resolve-action (resuming after an approval
// decision) run. Extracting it keeps the two routes in lock-step: assistant
// turns and tool results persist in the exact order Anthropic needs on replay,
// dangling tool_use blocks get synthetic results, and the cost reservation is
// finalized against real spend.
//
// The caller owns the ReadableStream controller and the streamAgent iterator;
// this module owns what to DO with each event. The approval gate adds one new
// event — `tool_call_pending_approval` — which the caller handles via the
// `onPendingApproval` callback (persisting a pending row + emitting the card).

import { log } from '@/lib/log';
import type { AgentEvent, UsageReport } from '@/lib/agent/llm';
import {
  recordAssistantTurn,
  recordToolResult,
  recordSyntheticAbortToolResult,
} from '@/lib/agent/memory';
import { handleToolCallFinished } from './_tool-result-handler';

export interface StreamRunnerContext {
  conversationId: string;
  requestId: string;
  promptVersion: string;
  /** Emit an SSE event to the client (already JSON-serializes + frames). */
  send: (obj: unknown) => void;
}

export interface StreamRunnerResult {
  finalUsage: UsageReport | null;
  lastDoneText: string;
  /** tool_call ids proposed this turn whose result never landed (for cleanup). */
  pendingToolCallIds: Set<string>;
  /** True when the turn ended by proposing approval cards (no `done`). The
   *  caller must NOT emit a synthetic `done` — the browser is waiting on the
   *  card decision, not a completed reply. */
  endedWithPendingApproval: boolean;
  /** The most recent assistant_turn usage. When the turn ends by proposing
   *  cards there is no `done`/finalUsage — but the model DID spend tokens
   *  producing the proposal, so the caller finalizes the cost reservation
   *  against this instead of cancelling and losing the spend. */
  lastTurnUsage: UsageReport | null;
}

/**
 * Callback invoked for each `tool_call_pending_approval` event. Persists the
 * pending row(s) and emits the card SSE event. Returns nothing — the runner
 * just registers the tool_call id as "resolved elsewhere" (not a dangling
 * tool_use to synthesize an abort result for, since resume will feed its
 * result).
 */
export type PendingApprovalHandler = (ev: Extract<AgentEvent, { type: 'tool_call_pending_approval' }>) => Promise<void>;

/**
 * Drive a streamAgent iterator: forward client-facing events, persist assistant
 * turns + tool results in Anthropic-replay order, and collect the final usage.
 *
 * Mirrors the original inline loop in route.ts (Codex fixes #2/#3/#4). The one
 * addition is the approval branch.
 */
export async function runAgentStream(
  iter: AsyncGenerator<AgentEvent>,
  ctx: StreamRunnerContext,
  opts: {
    onPendingApproval?: PendingApprovalHandler;
    /**
     * Route-owned set of in-flight tool_call ids. Pass one so the route's
     * finally block can drain dangling tool_use rows EVEN IF runAgentStream
     * throws mid-loop (before it returns its result). Without this, a throw
     * after assistant_turn persists would strand tool_use blocks and break the
     * next replay. Defaults to a fresh internal set for callers that don't
     * need the safety net.
     */
    pendingToolCallIds?: Set<string>;
  } = {},
): Promise<StreamRunnerResult> {
  let finalUsage: UsageReport | null = null;
  let lastDoneText = '';
  let endedWithPendingApproval = false;
  let lastTurnUsage: UsageReport | null = null;
  const pendingToolCallIds = opts.pendingToolCallIds ?? new Set<string>();

  for await (const event of iter) {
    if (event.type === 'assistant_turn') {
      lastTurnUsage = event.usage;
      // Fix #2: throw on failure (recordAssistantTurn uses an atomic RPC).
      // The caller's try/catch cancels the reservation and aborts if this
      // throws — we do NOT continue into tool execution with the assistant
      // tool_use blocks not safely on disk.
      await recordAssistantTurn(
        ctx.conversationId,
        event.text,
        event.toolCalls.length ? event.toolCalls : undefined,
        {
          tokensIn: event.usage.inputTokens,
          tokensOut: event.usage.outputTokens,
          modelUsed: event.usage.model,
          modelId: event.usage.modelId,
          costUsd: event.usage.costUsd,
          promptVersion: ctx.promptVersion,
        },
      );
      for (const call of event.toolCalls) {
        pendingToolCallIds.add(call.id);
      }
    } else if (event.type === 'tool_call_finished') {
      const { shouldBreak } = await handleToolCallFinished({
        conversationId: ctx.conversationId,
        event,
        pendingToolCallIds,
        recordToolResult,
        send: ctx.send,
        onPersistenceFailure: (err) => {
          log.error('[agent/stream-runner] failed to persist tool result; aborting stream', {
            requestId: ctx.requestId, conversationId: ctx.conversationId, callId: event.call.id, err,
          });
        },
      });
      if (shouldBreak) break;
    } else if (event.type === 'tool_call_pending_approval') {
      // The mutation is NOT executed. Persist a pending row + emit the card.
      // The tool_call id is deliberately removed from pendingToolCallIds: its
      // tool_result comes from the approval decision (resume), not from a
      // synthetic abort row on stream end.
      endedWithPendingApproval = true;
      pendingToolCallIds.delete(event.call.id);
      if (opts.onPendingApproval) {
        try {
          await opts.onPendingApproval(event);
        } catch (err) {
          log.error('[agent/stream-runner] failed to persist pending approval', {
            requestId: ctx.requestId, conversationId: ctx.conversationId, callId: event.call.id, err,
          });
          ctx.send({ type: 'error', message: 'Could not stage that action for approval. Please try again.' });
        }
      }
    } else if (event.type === 'done') {
      finalUsage = event.usage;
      lastDoneText = event.finalText;
    } else if (event.type === 'error') {
      // error events may carry accumulated usage — promote so the caller
      // FINALIZES the reservation. Strip usage from the client-bound event.
      if (event.usage) finalUsage = event.usage;
      ctx.send({ type: 'error', message: event.message });
    } else {
      ctx.send(event);
    }
  }

  return { finalUsage, lastDoneText, pendingToolCallIds, endedWithPendingApproval, lastTurnUsage };
}

/**
 * Persist the final assistant text turn (if any) and emit the held `done`
 * event. Shared tail of both routes. Skipped when the turn ended by proposing
 * approval cards (there is no completed reply to persist/announce yet).
 */
export async function finishAgentStream(
  res: StreamRunnerResult,
  ctx: StreamRunnerContext,
): Promise<void> {
  if (res.endedWithPendingApproval) return;
  if (res.lastDoneText) {
    await recordAssistantTurn(
      ctx.conversationId,
      res.lastDoneText,
      undefined,
      {
        tokensIn: res.finalUsage?.inputTokens ?? 0,
        tokensOut: res.finalUsage?.outputTokens ?? 0,
        modelUsed: res.finalUsage?.model ?? 'sonnet',
        modelId: res.finalUsage?.modelId ?? null,
        costUsd: res.finalUsage?.costUsd ?? 0,
        promptVersion: ctx.promptVersion,
      },
    );
  }
  if (res.finalUsage) {
    ctx.send({ type: 'done', usage: res.finalUsage, finalText: res.lastDoneText });
  }
}

/**
 * Synthesize error tool_result rows for any tool_use that never got a result
 * before the stream ended, so the next replay stays valid. Idempotent (ON
 * CONFLICT DO NOTHING). Shared finally-block cleanup.
 */
export async function drainDanglingToolCalls(
  pendingToolCallIds: Set<string>,
  ctx: StreamRunnerContext,
): Promise<void> {
  if (pendingToolCallIds.size === 0) return;
  await Promise.allSettled(
    Array.from(pendingToolCallIds).map((toolCallId) =>
      recordSyntheticAbortToolResult(ctx.conversationId, toolCallId, {
        ok: false,
        error: 'aborted — tool result was not captured before the stream ended',
      }).catch((err) => {
        log.error('[agent/stream-runner] failed to insert synthetic abort result', {
          requestId: ctx.requestId, conversationId: ctx.conversationId, err,
        });
      }),
    ),
  );
}
