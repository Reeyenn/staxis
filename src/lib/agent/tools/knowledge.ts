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
    'Search THIS hotel\'s own Knowledge hub — staff SOPs / how-to guides, uploaded documents (the full text content of PDFs and Word files, not just titles), the vendor / emergency / brand / local contact directory (each contact may carry a phone, email, street address, and hours), and the team calendar. Hybrid semantic + keyword search: ask in plain language (English or Spanish) OR use exact terms (part numbers, names). Read-only and scoped to this property and your role. ALWAYS call this BEFORE answering when the user asks how to do something operational ("how do I set up the breakfast bar?"), asks for a vendor or contact or their phone/email/address/hours ("what\'s the plumber\'s number?", "what\'s the nearest pharmacy and their hours?", "what\'s the address of the closest hospital?"), references an SOP / policy / checklist / procedure, asks about an uploaded document/manual/contract, or asks about an upcoming event / training day. The `passages` array holds the most relevant excerpts with their source document/SOP title and section — quote the source title (and section) in your reply. If `passages` and the other arrays are empty, tell the user it isn\'t documented yet — don\'t invent an answer.',
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
    'Pull MORE of a specific Knowledge document or SOP when one excerpt from search_knowledge isn\'t enough to answer fully. Pass the `sourceType` ("document" or "article") and `sourceId` from a search_knowledge passage. Returns a larger window of that source\'s text (use `offset` to page further if `hasMore` is true). Read-only; respects your role — a manager-only source returns "not found" for floor staff. Only call this AFTER search_knowledge has pointed you at a specific source.',
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
