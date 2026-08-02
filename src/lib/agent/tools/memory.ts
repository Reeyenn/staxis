// ─── remember / forget ──────────────────────────────────────────────────────
// Long-term copilot memory (migration 0256). Lets the assistant durably learn a
// hotel's facts and a user's preferences across conversations, then recall them
// automatically (the server injects active memory into every turn's prompt — see
// memory-context.ts — so there is intentionally no `recall` tool in v1).
//
// Safety:
//   • hotel-scope ('hotel') writes are MANAGEMENT-ONLY (isManagerOrAbove) — a
//     low-trust author must not steer a high-trust reader's session. user-scope
//     ('me') writes are open to all (blast radius = self).
//   • content is PII-redacted before storage (redactMemoryContent).
//   • per-request write cap (the DB row-caps in staxis_store_memory are the hard
//     backstop) stops a single coerced turn from flooding memory.
import { registerTool, type ToolResult, type ToolContext } from '../tools';
import { isManagerOrAbove } from './_helpers';
import { redactMemoryContent } from '../memory-redact';
import {
  storeMemory,
  forgetMemory,
  type MemoryScope,
  type MemoryConfidence,
} from '@/lib/db/agent-memory';

const MAX_WRITES_PER_REQUEST = 5;
// Same ToolContext object instance flows through executeTool for every tool
// call in one request, so a WeakMap keyed on it counts per-request writes.
const writeCounts = new WeakMap<object, number>();

const ALL_MEMORY_ROLES = [
  'admin', 'owner', 'general_manager', 'front_desk', 'housekeeping', 'maintenance', 'staff',
] as const;

/** "hotel" → property (shared), "me" → user (private). */
function normalizeScope(scope: string): MemoryScope | null {
  if (scope === 'hotel') return 'property';
  if (scope === 'me') return 'user';
  return null;
}

/** Normalize a free-text topic into a stable slug so corrections to the same
 *  concept reuse the same row (the dedup key). */
function slugifyTopic(raw: string): string {
  return (raw || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

function coerceConfidence(c: string | undefined): MemoryConfidence {
  return c === 'low' || c === 'high' ? c : 'normal';
}

// ─── remember ───────────────────────────────────────────────────────────────
registerTool<{ scope: string; topic: string; content: string; confidence?: string }>({
  name: 'remember',
  description:
    'Save a durable fact so you still know it in future conversations — saved memories are loaded into your context automatically every turn. ' +
    'Use when: you learn something STABLE and reusable — "room 305\'s AC fails often", "the breakfast area is called the bistro", "this user prefers Spanish". Never for anything that changes daily, a one-off request, today\'s numbers, or a task; those belong in create_todo or nowhere. If in doubt, do not save it: a wrong memory is repeated to everyone, every turn, until someone notices. ' +
    'Args: scope — "hotel" for a fact the whole team benefits from (managers and owners only), or "me" for the current user\'s own preference. topic — a short stable slug naming the subject ("room_305_ac", "reply_language"); reusing the SAME topic is how you correct a fact later. content — one concise sentence, max 500 characters. confidence — low, normal (default) or high. ' +
    'Returns: what was saved, and contactInfoRemoved if any contact details were stripped. A proposal until the user approves. ' +
    'Refuses: a hotel-wide memory from anyone below manager — offer to save it as their personal note instead. Also refuses empty or over-long content, and caps how many memories one exchange can add. Never store guest personal data — names tied to contact details, phone numbers, emails, card or ID numbers — and note that contact details are redacted on the way in regardless.',
  inputSchema: {
    type: 'object',
    properties: {
      scope: { type: 'string', enum: ['hotel', 'me'], description: '"hotel" = shared property fact (managers only); "me" = the current user\'s own preference.' },
      topic: { type: 'string', description: 'Short stable slug naming the subject, reused to correct it later (e.g. "room_305_ac", "breakfast_area_name", "reply_language"). 1–80 chars.' },
      content: { type: 'string', description: 'The fact to remember — one concise sentence, max 500 characters. No guest personal data.' },
      confidence: { type: 'string', enum: ['low', 'normal', 'high'], description: 'Optional; how sure you are. Defaults to normal.' },
    },
    required: ['scope', 'topic', 'content'],
  },
  allowedRoles: ALL_MEMORY_ROLES,
  surfaces: ['chat'],
  mutates: true,
  approval: 'quick',
  handler: async ({ scope, topic, content, confidence }, ctx: ToolContext): Promise<ToolResult> => {
    const sc = normalizeScope(scope);
    if (!sc) return { ok: false, error: 'scope must be "hotel" or "me".' };

    // Hotel-scope writes are management-only (second layer behind allowedRoles).
    if (sc === 'property' && !isManagerOrAbove(ctx.user.role)) {
      return { ok: false, error: 'Only a manager or owner can save hotel-wide memories. Offer to save it as a personal note (scope "me") instead.' };
    }

    const cleanTopic = slugifyTopic(topic);
    if (!cleanTopic) return { ok: false, error: 'Give a short topic (letters/numbers) for this memory.' };
    const trimmed = (content || '').trim();
    if (!trimmed) return { ok: false, error: 'There is nothing to remember.' };
    if (trimmed.length > 500) return { ok: false, error: 'That is too long to remember — keep it under 500 characters.' };

    const used = writeCounts.get(ctx) ?? 0;
    if (used >= MAX_WRITES_PER_REQUEST) {
      return { ok: false, error: 'That is enough new memories for one go — ask me again in a moment if there is more.' };
    }

    // Eval / dry-run: run all validation + gates but never touch real memory.
    if (ctx.dryRun) {
      return { ok: true, data: { remembered: true, scope, topic: cleanTopic, dryRun: true } };
    }

    const { content: safeContent, redacted } = redactMemoryContent(trimmed);

    const res = await storeMemory({
      propertyId: ctx.propertyId,
      scope: sc,
      subjectAccountId: sc === 'user' ? ctx.user.accountId : null,
      topic: cleanTopic,
      content: safeContent,
      source: 'explicit_user',
      confidence: coerceConfidence(confidence),
      createdByAccountId: ctx.user.accountId,
      createdByName: ctx.user.displayName || null,
      createdByRole: ctx.user.role, // attribution from ctx, NEVER from args
      sourceConversationId: ctx.conversationId ?? null,
    });

    if (!res.ok) return { ok: false, error: res.error || 'Could not save that memory.' };
    if (res.action === 'property_full') return { ok: false, error: 'This hotel\'s memory is full. A manager can remove old notes before adding new ones.' };
    if (res.action === 'user_full') return { ok: false, error: 'Your personal memory is full. Remove an old note before adding new ones.' };

    writeCounts.set(ctx, used + 1);
    return {
      ok: true,
      data: {
        remembered: true,
        scope,
        topic: cleanTopic,
        content: safeContent,
        contactInfoRemoved: redacted,
        action: res.action,
      },
    };
  },
});

// ─── forget ───────────────────────────────────────────────────────────────
registerTool<{ scope: string; topic: string }>({
  name: 'forget',
  description:
    'Stop remembering a saved fact, identified by its topic. ' +
    'Use when: the user asks you to forget something, or says a saved note is simply no longer true and gives no replacement. If they are CORRECTING it, call remember with the same topic instead — that updates in place and keeps the fact useful. ' +
    'Args: scope — "hotel" (shared) or "me" (the user\'s own). topic — the topic slug shown on the saved note, e.g. "room_305_ac". ' +
    'Returns: whether anything was actually forgotten, and a plain message when no memory existed under that topic. ' +
    'Refuses: forgetting a hotel-wide memory from anyone below manager. It matches on topic only — it cannot forget "everything about room 305" or search by content — so if you do not know the exact topic, say so rather than guessing a slug and reporting a deletion that did not happen.',
  inputSchema: {
    type: 'object',
    properties: {
      scope: { type: 'string', enum: ['hotel', 'me'], description: 'Which memory to forget — "hotel" (shared) or "me" (personal).' },
      topic: { type: 'string', description: 'The topic slug of the memory to forget (the topic shown on a saved note, e.g. "room_305_ac").' },
    },
    required: ['scope', 'topic'],
  },
  allowedRoles: ALL_MEMORY_ROLES,
  surfaces: ['chat'],
  mutates: true,
  approval: 'quick',
  handler: async ({ scope, topic }, ctx: ToolContext): Promise<ToolResult> => {
    const sc = normalizeScope(scope);
    if (!sc) return { ok: false, error: 'scope must be "hotel" or "me".' };
    if (sc === 'property' && !isManagerOrAbove(ctx.user.role)) {
      return { ok: false, error: 'Only a manager or owner can remove hotel-wide memories.' };
    }
    const cleanTopic = slugifyTopic(topic);
    if (!cleanTopic) return { ok: false, error: 'Which memory? Tell me its topic.' };

    if (ctx.dryRun) return { ok: true, data: { forgotten: true, topic: cleanTopic, dryRun: true } };

    const res = await forgetMemory(
      ctx.propertyId,
      sc,
      sc === 'user' ? ctx.user.accountId : null,
      cleanTopic,
    );
    if (!res.ok) return { ok: false, error: res.error || 'Could not forget that.' };
    if (res.deactivated === 0) {
      return { ok: true, data: { forgotten: false, message: 'There was no saved memory under that topic.' } };
    }
    return { ok: true, data: { forgotten: true, topic: cleanTopic } };
  },
});
