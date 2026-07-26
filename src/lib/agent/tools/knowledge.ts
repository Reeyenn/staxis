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

import { registerTool, type ToolResult } from '../tools';
import { searchKnowledge, getDocumentSection } from '@/lib/knowledge/core';

const KNOWLEDGE_ROLES = ['admin', 'owner', 'general_manager', 'front_desk', 'housekeeping', 'maintenance'] as const;

registerTool<{ query: string }>({
  name: 'search_knowledge',
  description:
    'Search THIS hotel\'s own Knowledge hub: staff SOPs and how-to guides, the full text of uploaded PDFs and Word files, the vendor / emergency / brand / local contact directory with phone, email, address and hours, and the team calendar. Hybrid semantic + keyword search — plain language in English or Spanish, or exact terms like part numbers. ' +
    'Use when: ALWAYS call this before answering anything the hotel would have written down — how to do something operational ("how do I set up the breakfast bar"), any vendor or contact or their number/address/hours ("what\'s the plumber\'s number", "nearest pharmacy and their hours"), any SOP, policy, checklist or procedure, anything in an uploaded manual or contract, and upcoming events or training days. Reach for it before answering from general knowledge, because the hotel\'s own way of doing a thing beats the industry-standard one every time. ' +
    'Args: query — what to look for, phrased the way the user asked it. ' +
    'Returns: { passages, articles, documents, contacts, events }. `passages` holds the most relevant excerpts with the document or SOP title and section they came from — quote that source in your reply so the user can check it. ' +
    'Refuses: nothing, but it is scoped to this hotel AND the asker\'s role, so a manager-only document simply will not appear for floor staff — never hint that something exists but is hidden. When everything comes back empty, say plainly that it is not documented here yet and, if they manage the team, that they can add it in Communications → Knowledge. Do not fill the gap with a plausible generic answer.',
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
  mutates: false,
  handler: async ({ query }, ctx): Promise<ToolResult> => {
    try {
      if (!query || !query.trim()) {
        return { ok: false, error: 'Provide something to search for.' };
      }
      const result = await searchKnowledge(ctx.propertyId, query, ctx.user.role, { accountId: ctx.user.accountId, dept: ctx.user.dept ?? null });
      const hits =
        result.passages.length + result.articles.length + result.documents.length +
        result.contacts.length + result.events.length;
      if (hits === 0) {
        return {
          ok: true,
          data: {
            ...result,
            message: 'Nothing in this hotel\'s Knowledge hub matched. Tell the user it isn\'t documented yet — and if they manage the team, they can add it in Communications → Knowledge.',
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
