// ─── search_knowledge + fetch_document_section ─────────────────────────────
// The moat: lets the bottom-right assistant answer from THIS hotel's own
// Knowledge hub (SOPs · documents · contacts · calendar) that managers publish
// in Communications → Knowledge. Read-only. ALWAYS scoped to ctx.propertyId AND
// the asker's role, so the tool can never surface another tenant's knowledge —
// nor a manager-only document/SOP to floor staff.
//
// search_knowledge runs HYBRID semantic (pgvector) + keyword search over the
// embedded passages (chunks) of every uploaded PDF/Word/SOP, so the assistant
// retrieves the exact relevant excerpt — in English or Spanish — with its
// document/section ref to cite. fetch_document_section pulls more of a source
// when one excerpt isn't enough, within the tool size cap.

import { registerTool, type ToolHandlerContext, type ToolResult } from '../tools';
import { searchKnowledge, getDocumentSection } from '@/lib/knowledge/core';
import { slugifyIntakeTopic } from '../knowledge-intake';
import { storeMemory } from '@/lib/db/agent-memory';

const KNOWLEDGE_ROLES = ['admin', 'owner', 'general_manager', 'front_desk', 'housekeeping', 'maintenance'] as const;

// ─── The guest question nobody had written down ─────────────────────────────
//
// A front-desk agent asks "what's the pet fee", the hotel has never recorded
// one, and the honest answer is "I don't have that". Before this, that was the
// end of it: the guest got nothing, the desk got nothing, and next week the
// same guest question hit the same wall. The one thing that must NOT happen is
// the assistant inventing a fee, so the miss is the correct outcome — it is
// just not a correct RESTING state.
//
// So the miss is recorded, in the machinery the hotel already has:
//
//   an `agent_memory` row with `source: 'inferred'`, which the 0358 trigger
//   forces to `review_state: 'unreviewed'`.
//
// That is the SAME path the Knows open box uses for a fact extracted from a
// pasted email, and it inherits every property of it, none of which had to be
// built here:
//
//   • It NEVER reaches a model. `getActiveMemoryForTurn` and the new facts arm
//     in `searchKnowledge` both filter `review_state = 'confirmed'`, so an open
//     question cannot become an answer by sitting there.
//   • It surfaces where the GM already reviews facts — the Knows screen, in its
//     bucket, badged "Not confirmed yet", with Confirm / Edit / Remove. The
//     move the loop is built around is EDIT: the GM types the real pet fee, the
//     row is promoted to `source: 'correction'` + confirmed, and from that
//     moment the front desk gets the answer. Confirming it unedited is also
//     safe, because the sentence it stores is true either way.
//   • Removing it is PERMANENT (0357 tombstones the topic) — a GM who decides
//     this is not worth writing down is never asked again.
//   • The upsert-by-topic RPC means the tenth time someone asks is the same
//     row, not the tenth row, and the 200-fact property cap is the ceiling.
//
// Deliberately NOT a new table and NOT a new drip category: `agent_knowledge_questions`
// can only ask a yes/no question about a fact sentence Staxis already knows, and
// the whole point here is that Staxis does not know the answer. Neither shape
// fits, and both need DDL.
//
// Scoped to the front-desk lens: it is the hat whose misses are a guest standing
// at a counter. A manager who searches for something absent already owns the fix.
const GAP_TOPIC_PREFIX = 'guest_question_';

/**
 * Record that a guest question came back empty. Best-effort by construction —
 * any failure is swallowed, because a bookkeeping write must never turn an
 * honest "I don't have that" into a tool error the guest waits through.
 *
 * Exported for tests; there is one production caller, below.
 */
export async function recordGuestQuestionGap(
  ctx: ToolHandlerContext,
  query: string,
): Promise<{ recorded: boolean; topic: string | null }> {
  const slug = slugifyIntakeTopic(query).slice(0, 60);
  if (slug.length < 2) return { recorded: false, topic: null };
  const topic = `${GAP_TOPIC_PREFIX}${slug}`;
  // The question, in the shape of the answer it is waiting for. Phrased so that
  // a GM who taps Confirm without editing stores something TRUE (the hotel has
  // not written this down), and a GM who taps Edit is already looking at the
  // right box to type the real answer into.
  const content =
    `Guests ask the front desk about "${query.trim().slice(0, 160)}" and this hotel has no confirmed answer on file. ` +
    'Edit this note to fill in the real answer, and the front desk will have it.';
  try {
    const res = await storeMemory({
      propertyId: ctx.propertyId,
      scope: 'property',
      subjectAccountId: null,
      topic,
      content,
      // 'inferred' is what makes the 0358 trigger stamp review_state
      // 'unreviewed'. Review state is not a field a caller may choose, and that
      // is the guarantee this whole path rests on.
      source: 'inferred',
      confidence: 'low',
      createdByAccountId: ctx.user.accountId,
      createdByName: ctx.user.displayName,
      createdByRole: ctx.user.role,
      sourceConversationId: ctx.conversationId ?? null,
      category: 'guests',
    });
    return {
      recorded: res.ok === true && (res.action === 'inserted' || res.action === 'updated'),
      topic,
    };
  } catch {
    return { recorded: false, topic };
  }
}

registerTool<{ query: string }>({
  name: 'search_knowledge',
  description:
    'Search everything THIS hotel has written down about itself: the confirmed facts on its Knows screen (wifi password, breakfast hours, pet fee, parking, checkout time), its staff SOPs and how-to guides, the full text of uploaded PDFs and Word files, the vendor / emergency / brand / local contact directory with phone, email, address and hours, and the team calendar. Hybrid semantic + keyword search — plain language in English or Spanish, or exact terms like part numbers. ' +
    'Use when: ALWAYS call this before answering anything the hotel would have written down — a GUEST\'S question at the front desk ("what\'s the wifi password", "cuándo es el desayuno", "do you take pets"), how to do something operational, any vendor or contact or their number/address/hours, any SOP, policy, checklist or procedure, anything in an uploaded manual or contract, and upcoming events or training days. Reach for it before answering from general knowledge, because the hotel\'s own way of doing a thing beats the industry-standard one every time. ' +
    'Args: query — what to look for, phrased the way the user asked it. ' +
    'Returns: { facts, passages, articles, documents, contacts, events }. `facts` are things this hotel has CONFIRMED about itself — read them first and quote them as they are written, because they are the shortest and most reliable answer to a guest\'s question. `passages` holds the most relevant document excerpts with the SOP or document title and section they came from — quote that source so the user can check it. ' +
    'Refuses: nothing, but it is scoped to this hotel AND the asker\'s role, so a manager-only document simply will not appear for floor staff — never hint that something exists but is hidden. Facts a manager has not confirmed yet are never returned, so absence here means "not confirmed", not "not true". When everything comes back empty, say plainly that it is not written down here yet and stop — do not offer the typical or industry-standard answer as a substitute, and never present a guess about a price, a time or a policy to someone who is about to repeat it to a guest.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'What to look for — a natural-language question or keywords (e.g. "how do we handle a guest complaint about noise", "pool chemical part number", "fire drill procedure"). Ask it the way the user asked.',
      },
    },
    required: ['query'],
  },
  allowedRoles: KNOWLEDGE_ROLES,
  // Also offered in a staff thread: this is the tool the old private @Staxis
  // catalog reached the same core with, under its own duplicate description.
  surfaces: ['chat', 'messages'],
  mutates: false,
  handler: async ({ query }, ctx): Promise<ToolResult> => {
    try {
      if (!query || !query.trim()) {
        return { ok: false, error: 'Provide something to search for.' };
      }
      const result = await searchKnowledge(ctx.propertyId, query, ctx.user.role, { accountId: ctx.user.accountId, dept: ctx.user.dept ?? null });
      const hits =
        result.facts.length + result.passages.length + result.articles.length +
        result.documents.length + result.contacts.length + result.events.length;
      if (hits === 0) {
        // The front desk's misses are a guest standing at a counter, so they go
        // on the record for the GM to fill in. See recordGuestQuestionGap above
        // for why this is an unreviewed Knows row and not a new mechanism.
        const gap = ctx.user.role === 'front_desk'
          ? await recordGuestQuestionGap(ctx, query)
          : { recorded: false, topic: null };
        return {
          ok: true,
          data: {
            ...result,
            message: gap.recorded
              ? 'Nothing this hotel has written down matches. Tell the user plainly that you don\'t have that one and they should ask their manager — do NOT offer the typical or industry-standard answer instead. Staxis has put the question on the manager\'s Knows screen so it can be answered next time; mention that in at most a half-sentence, and only if it fits naturally.'
              : 'Nothing this hotel has written down matches. Tell the user it isn\'t recorded yet — and if they manage the team, they can add it on the Knows screen or in Communications → Knowledge. Do not fill the gap with a plausible generic answer.',
          },
        };
      }
      return { ok: true, data: result };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Knowledge search failed.' };
    }
  },
});

registerTool<{ sourceType: 'document' | 'article'; sourceId: string; offset?: number }>({
  name: 'fetch_document_section',
  description:
    'Read MORE of one Knowledge document or SOP when a search_knowledge excerpt was not enough to answer fully. ' +
    'Use when: you have a passage that is clearly the right source but is cut off mid-procedure, or the user asks what comes next in a checklist. Only ever AFTER search_knowledge has pointed you at a specific source — this tool cannot find anything on its own. ' +
    'Args: sourceType — "document" (an uploaded file) or "article" (an SOP). sourceId — the sourceId from a search_knowledge passage, never invented. offset — character offset to start from, default 0; page on by the previous window length while hasMore is true. ' +
    'Returns: a larger window of that source\'s text plus hasMore, telling you whether more remains. ' +
    'Refuses: an unrecognised sourceType or a missing sourceId, and it returns a plain "not found" for any source the asker\'s role may not read — a manager-only document is indistinguishable from a nonexistent one, which is deliberate, so do not speculate that something is being withheld.',
  inputSchema: {
    type: 'object',
    properties: {
      sourceType: { type: 'string', enum: ['document', 'article'], description: 'Which kind of source: "document" (uploaded file) or "article" (SOP).' },
      sourceId: { type: 'string', description: 'The sourceId from a search_knowledge passage.' },
      offset: { type: 'number', description: 'Character offset to start from (default 0). Page with the previous window length when hasMore is true.' },
    },
    required: ['sourceType', 'sourceId'],
  },
  allowedRoles: KNOWLEDGE_ROLES,
  // Also offered in a staff thread: this is the tool the old private @Staxis
  // catalog reached the same core with, under its own duplicate description.
  surfaces: ['chat', 'messages'],
  mutates: false,
  handler: async ({ sourceType, sourceId, offset }, ctx): Promise<ToolResult> => {
    if (sourceType !== 'document' && sourceType !== 'article') {
      return { ok: false, error: 'sourceType must be "document" or "article".' };
    }
    if (!sourceId || typeof sourceId !== 'string') {
      return { ok: false, error: 'Provide the sourceId from a search_knowledge result.' };
    }
    try {
      const res = await getDocumentSection(ctx.propertyId, { role: ctx.user.role, dept: ctx.user.dept ?? null }, {
        sourceType, sourceId, offset: typeof offset === 'number' ? offset : 0,
      });
      if ('error' in res) return { ok: false, error: res.error };
      return { ok: true, data: res };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Could not fetch the document section.' };
    }
  },
});
