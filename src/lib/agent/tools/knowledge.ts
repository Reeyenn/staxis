// ─── search_knowledge ──────────────────────────────────────────────────────
// The moat: lets the bottom-right assistant answer from THIS hotel's own
// Knowledge hub (SOPs · documents · contacts · calendar) that managers publish
// in Communications → Knowledge. Read-only. ALWAYS scoped to ctx.propertyId, so
// the tool can never surface another tenant's knowledge — the search itself
// filters by property_id, and executeTool's propertyAccess check is the
// belt-and-braces behind it.
//
// v1 is keyword/ILIKE search (title + body + extracted document text + contact
// name/company + event title/notes). A full embedding / vector RAG is a future
// upgrade; the point here is that the assistant can FIND and quote the hotel's
// own knowledge instead of guessing.

import { registerTool, type ToolResult } from '../tools';
import { searchKnowledge } from '@/lib/knowledge/core';

registerTool<{ query: string }>({
  name: 'search_knowledge',
  description:
    'Search THIS hotel\'s own Knowledge hub — staff SOPs / how-to guides, uploaded documents (the text content of plain-text/markdown files plus every file\'s title), the vendor / emergency / brand / local contact directory, and the team calendar. Read-only and scoped to this property. ALWAYS call this BEFORE answering when the user asks how to do something operational ("how do I set up the breakfast bar?"), asks for a vendor or contact or their phone/email ("what\'s the plumber\'s number?"), references an SOP / policy / checklist / procedure, asks about an uploaded document, or asks about an upcoming event / training day. Returns the most relevant snippets with their source titles — quote the source title in your reply. If it returns nothing, tell the user it isn\'t documented yet (don\'t invent an answer).',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'What to look for — keywords or a short phrase (e.g. "breakfast bar setup", "plumber", "pool chemicals", "fire drill"). Keep it concise.',
      },
    },
    required: ['query'],
  },
  allowedRoles: ['admin', 'owner', 'general_manager', 'front_desk', 'housekeeping', 'maintenance'],
  mutates: false,
  handler: async ({ query }, ctx): Promise<ToolResult> => {
    try {
      if (!query || !query.trim()) {
        return { ok: false, error: 'Provide something to search for.' };
      }
      const result = await searchKnowledge(ctx.propertyId, query);
      const hits = result.articles.length + result.documents.length + result.contacts.length + result.events.length;
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
