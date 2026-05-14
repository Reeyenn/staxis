/**
 * Tool-result persistence handler — extracted from route.ts so the
 * critical-path abort logic (Round 12 T12.8) is unit-testable.
 *
 * Behavior, encoded as 3 invariants:
 *
 *   1. If recordToolResult SUCCEEDS:
 *      - pendingToolCallIds is cleared for this call.id
 *      - the original tool_call_finished event is forwarded to the
 *        client via send()
 *      - return { shouldBreak: false } so the route's for-await loop
 *        continues
 *
 *   2. If recordToolResult FAILS (Supabase outage etc):
 *      - pendingToolCallIds keeps this id (so the route's finally
 *        block's synthetic-abort path will insert a fallback row
 *        via recordSyntheticAbortToolResult)
 *      - the tool_call_finished event is NOT forwarded to the client
 *      - an error event IS sent to the client
 *      - return { shouldBreak: true } so the route's for-await loop
 *        breaks → finally handles cleanup
 *
 *   3. The function never throws (so the route's higher catch block
 *      isn't accidentally triggered by a routine persistence failure
 *      that the finally block already handles).
 */

export interface ToolCallFinishedEvent {
  type: 'tool_call_finished';
  call: { id: string };
  result: unknown;
  isError?: boolean;
}

export interface AgentErrorEvent {
  type: 'error';
  message: string;
}

export interface ToolResultHandlerArgs {
  conversationId: string;
  event: ToolCallFinishedEvent;
  pendingToolCallIds: Set<string>;
  recordToolResult: (
    conversationId: string,
    callId: string,
    result: unknown,
    isError: boolean | undefined,
  ) => Promise<unknown>;
  send: (event: ToolCallFinishedEvent | AgentErrorEvent) => void;
  onPersistenceFailure: (err: unknown) => void;
}

export async function handleToolCallFinished(args: ToolResultHandlerArgs): Promise<{ shouldBreak: boolean }> {
  try {
    await args.recordToolResult(args.conversationId, args.event.call.id, args.event.result, args.event.isError);
    args.pendingToolCallIds.delete(args.event.call.id);
    args.send(args.event);
    return { shouldBreak: false };
  } catch (err) {
    args.onPersistenceFailure(err);
    args.send({
      type: 'error',
      message: 'A tool result could not be saved. Your conversation is preserved; please retry.',
    });
    return { shouldBreak: true };
  }
}
