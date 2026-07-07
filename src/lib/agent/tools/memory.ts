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
//   • voiceModes:['general'] keeps these out of the single-purpose
//     housekeeper_issue voice mode.

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
    'Save a durable fact so you recall it in future conversations (it is automatically loaded into your context every turn). Use this ONLY for stable, reusable knowledge — NOT transient state, one-off requests, or anything that changes daily. ' +
    'scope="hotel" is a fact about THIS property that every staff member benefits from (e.g. "room 305\'s AC fails often", "the breakfast area is called the bistro", "deep-clean the suites every Sunday") — only managers/owners may save these. ' +
    'scope="me" is a personal preference for the CURRENT user (e.g. "prefers replies in Spanish", "wants terse answers"). ' +
    'To CORRECT something you already saved, call remember again with the SAME topic. Never store guest personal data (names tied to contact info, phone numbers, emails, card or ID numbers).',
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
  surfaces: ['chat', 'voice'],
  voiceModes: ['general'],
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
    'Stop remembering a previously-saved memory, identified by its topic. Use when the user asks you to forget something or says a saved note is no longer true with no replacement. To UPDATE a fact instead, use remember with the same topic. Forgetting a hotel-wide ("hotel") memory requires a manager/owner.',
  inputSchema: {
    type: 'object',
    properties: {
      scope: { type: 'string', enum: ['hotel', 'me'], description: 'Which memory to forget — "hotel" (shared) or "me" (personal).' },
      topic: { type: 'string', description: 'The topic slug of the memory to forget (the topic shown on a saved note, e.g. "room_305_ac").' },
    },
    required: ['scope', 'topic'],
  },
  allowedRoles: ALL_MEMORY_ROLES,
  surfaces: ['chat', 'voice'],
  voiceModes: ['general'],
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
