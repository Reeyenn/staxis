// ─── Agent event dispatcher ─────────────────────────────────────────────────
// Build + export ONLY. No call-sites are wired in this chat (collision-prone —
// they belong to the template chats). Chat 3 calls dispatchAgentEvent from the
// existing write-paths, e.g.:
//   - src/lib/complaints-create.ts (after createComplaint) → 'complaint.created'
//   - the room-issue write path                            → 'room.issue_reported'
//   - the inventory low-stock check                        → 'inventory.low_stock'
//   - the sick-callout write path                          → 'staff.callout'
//
// Contract guards baked in NOW so a call-site can't create a loop or a storm:
//   * re-entrancy — pass { suppress:true } from inside an agent-executed write
//     so an action can't recursively re-dispatch.
//   * idempotency — pass { eventId } so a double-delivered event runs once
//     (the agent_runs (agent_id,event_id) unique index dedupes).
//   * fan-out cap — at most MAX_FANOUT agents per dispatch.
//
// LATENCY NOTE for Chat 3: this awaits each agent run sequentially. Do NOT
// `await dispatchAgentEvent(...)` on a request path (it would block the write
// on up to MAX_FANOUT scope-reads + LLM calls). Fire-and-forget it — e.g.
// Next's after() or a background tick — so the originating write stays fast.

import 'server-only';
import { agentRepo } from '@/lib/db/agents';
import { runAgent } from '@/lib/agents/engine';
import { env } from '@/lib/env';
import { log } from '@/lib/log';
import type { AgentEventName } from '@/lib/agents/types';

const MAX_FANOUT = 25;

export async function dispatchAgentEvent(
  eventName: AgentEventName,
  payload: Record<string, unknown>,
  propertyId: string,
  opts?: { eventId?: string; suppress?: boolean },
): Promise<{ triggered: number; runIds: string[] }> {
  if (opts?.suppress) return { triggered: 0, runIds: [] };
  if (env.AGENTS_ENABLED === 'false') return { triggered: 0, runIds: [] };

  const agents = await agentRepo.listActiveEventAgents(propertyId, eventName);
  const capped = agents.slice(0, MAX_FANOUT);
  if (agents.length > capped.length) {
    log.warn('dispatchAgentEvent: fan-out capped', { eventName, propertyId, total: agents.length, cap: MAX_FANOUT });
  }

  const runIds: string[] = [];
  for (const a of capped) {
    try {
      const out = await runAgent(a.id, {
        mode: 'live',
        triggerSource: 'event',
        event: { name: eventName, payload, eventId: opts?.eventId },
      });
      if (out.runId) runIds.push(out.runId);
    } catch (e) {
      log.warn('dispatchAgentEvent: agent run failed', {
        agentId: a.id,
        msg: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return { triggered: runIds.length, runIds };
}
