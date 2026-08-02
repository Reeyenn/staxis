// ─── Lost & Found tool ─────────────────────────────────────────────────────
// log_found_item — found-item logging for chat.
// "Found a pair of glasses in 214" → a row in the L&F register.
//
// Writes via the shared store (supabaseAdmin); role + property access are
// already enforced by executeTool before the handler runs.

import { registerTool, type ToolResult, type ToolHandlerContext } from '../tools';
import { findRoomByNumber } from './_helpers';
import { createItem, fetchRegister } from '@/lib/lost-and-found/store';
import { LAF_CATEGORIES } from '@/lib/lost-and-found/types';

registerTool<{ itemDescription: string; roomOrLocation?: string; category?: string }>({
  name: 'log_found_item',
  description:
    'Record an item somebody FOUND, into the Lost & Found register. ' +
    'Use when: staff report finding property a guest left behind — "found a pair of glasses in 214", "someone left a charger in the lobby", "encontré una chaqueta negra en la 305". To look for something already handed in, use search_lost_found instead — a guest asking about their lost wallet is a search, not a new entry. ' +
    'Args: itemDescription — what it is, capped at 500 characters; include colour and brand when known, since that is what makes it findable later. roomOrLocation — where it turned up, either a room number or an area like "lobby" or "pool deck". category — the item category when it is obvious. ' +
    'Returns: the item id, what was logged, the resolved location and who logged it. A proposal until the user approves. ' +
    'Refuses: an empty description. Note the location handling: a room number that matches this hotel is stored as that room, and anything else is kept as free text rather than dropped. Logging an item does not contact the guest, start a return, or set a disposal date — it puts it in the register, nothing more.',
  inputSchema: {
    type: 'object',
    properties: {
      itemDescription: {
        type: 'string',
        description: 'What was found, e.g. "black North Face jacket" or "pair of reading glasses".',
      },
      roomOrLocation: {
        type: 'string',
        description:
          'Where it was found — a room number ("214") or an area ("lobby", "pool deck", "breakfast room").',
      },
      category: {
        type: 'string',
        enum: [...LAF_CATEGORIES],
        description: 'Item category, if obvious from the description.',
      },
    },
    required: ['itemDescription'],
  },
  allowedRoles: ['admin', 'owner', 'general_manager', 'front_desk', 'housekeeping', 'maintenance'],
  surfaces: ['chat'],
  mutates: true,
  approval: 'quick',
  handler: async ({ itemDescription, roomOrLocation, category }, ctx): Promise<ToolResult> => {
    const desc = String(itemDescription ?? '').trim().slice(0, 500);
    if (!desc) return { ok: false, error: 'I need a short description of the item to log it.' };

    // Resolve a room number to a real room when possible; otherwise treat the
    // hint as a free-text location.
    let roomNumber: string | null = null;
    let location: string | null = null;
    const loc = roomOrLocation ? String(roomOrLocation).trim().slice(0, 200) : '';
    if (loc) {
      if (/^[A-Za-z0-9-]{1,10}$/.test(loc)) {
        const room = await findRoomByNumber(ctx.db, loc);
        if (room) {
          roomNumber = room.number;
          location = `Room ${room.number}`;
        } else {
          location = loc; // a real-looking number we couldn't match — keep as text
        }
      } else {
        location = loc;
      }
    }

    const cat =
      category && (LAF_CATEGORIES as readonly string[]).includes(category) ? category : null;

    if (ctx.dryRun) {
      return {
        ok: true,
        data: { dryRun: true, itemDescription: desc, roomNumber, location, category: cat },
      };
    }

    const res = await createItem(ctx.propertyId, {
      type: 'found',
      itemDescription: desc,
      category: cat,
      roomNumber,
      location,
      foundBy: ctx.user.displayName,
      foundByStaffId: ctx.staffId,
      source: 'staff',
      createdByAccountId: ctx.user.accountId,
    });
    if (!res.ok) return { ok: false, error: 'Could not log the found item. Please try again.' };

    return {
      ok: true,
      data: {
        itemId: res.id,
        itemDescription: desc,
        location: location ?? 'unspecified location',
        category: cat,
        loggedBy: ctx.user.displayName,
      },
    };
  },
});

// ─── search_lost_found ─────────────────────────────────────────────────────
// READ-only lookup over the Lost & Found register (no approval). Answers guest
// questions like "did anyone turn in a black iPhone?" or "was a wallet found
// last weekend?". Searches the UNIFIED register (the app's lost_and_found_items
// + the CUA-owned pms_lost_and_found) via the shared fetchRegister, so it sees
// everything the register page shows. Free-text + optional date range, filtered
// in JS (the register is bounded to 2000 rows per source).

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

interface SearchLostFoundArgs {
  query?: string;
  from?: string;
  to?: string;
  type?: 'found' | 'lost' | 'all';
  limit?: number;
}

registerTool<SearchLostFoundArgs>({
  name: 'search_lost_found',
  description:
    'Search the Lost & Found register for an item, by description and/or when it was logged. ' +
    'Use when: someone is looking for lost property — "did anyone turn in a black iPhone", "was a wallet found last weekend", "encontraron unos lentes". This is the tool for a guest chasing something they left; log_found_item is for recording a new find. ' +
    'Args: query — what to look for; every word must match, so "black iphone" will not return every phone. from / to — optional ISO YYYY-MM-DD bounds on when the item was logged, not when it was lost. type — "found" (default, what guests ask about), "lost", or "all". limit — max results, default 15. ' +
    'Returns: { totalMatches, returned, items[] } with each item\'s description, category, location, current status and when it was logged. totalMatches may exceed what is returned — say so rather than implying the list is complete. ' +
    'Refuses: nothing, and that is the trap — no match does NOT mean the item was never handed in. It may have been logged with different words, or not logged at all. Tell the user nothing matching was found and offer to check with the front desk; never tell a guest their property is definitely not here. Searching does not reserve, hold or return anything.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to look for — e.g. "black iPhone", "wallet", "reading glasses".' },
      from: { type: 'string', description: 'Optional earliest date (ISO YYYY-MM-DD).' },
      to: { type: 'string', description: 'Optional latest date (ISO YYYY-MM-DD).' },
      type: { type: 'string', enum: ['found', 'lost', 'all'], description: 'Filter found vs lost. Defaults to found (what guests ask about).' },
      limit: { type: 'number', description: 'Max results to return (default 15).' },
    },
  },
  allowedRoles: ['admin', 'owner', 'general_manager', 'front_desk', 'housekeeping', 'maintenance'],
  // Chat-only (default) — this read tool is scoped to the chat surface.
  handler: async ({ query, from, to, type, limit }, ctx: ToolHandlerContext): Promise<ToolResult> => {
    const q = String(query ?? '').trim().toLowerCase();
    const typeFilter = type === 'lost' ? 'lost' : type === 'all' ? 'all' : 'found';
    const max = Math.min(Math.max(1, Number.isFinite(limit) ? Number(limit) : 15), 50);

    // Parse the date bounds to epoch ms (inclusive). `to` extends to end-of-day.
    const fromMs = from && DATE_ONLY_RE.test(from) ? Date.parse(`${from}T00:00:00.000Z`) : null;
    const toMs = to && DATE_ONLY_RE.test(to) ? Date.parse(`${to}T23:59:59.999Z`) : null;

    let register;
    try {
      register = await fetchRegister(ctx.propertyId);
    } catch {
      return { ok: false, error: 'Failed to search the lost & found register.' };
    }

    const tokens = q.split(/\s+/).filter(Boolean);
    const matches = register.filter((it) => {
      if (typeFilter !== 'all' && it.type !== typeFilter) return false;
      // Date range (against createdAt — when it was logged).
      if (fromMs !== null || toMs !== null) {
        const ms = Date.parse(it.createdAt);
        if (Number.isFinite(ms)) {
          if (fromMs !== null && ms < fromMs) return false;
          if (toMs !== null && ms > toMs) return false;
        }
      }
      if (!tokens.length) return true;
      const haystack = [
        it.itemDescription, it.category, it.location, it.roomNumber, it.notes,
      ].filter(Boolean).join(' ').toLowerCase();
      // Every token must appear (AND) so "black iphone" doesn't match every phone.
      return tokens.every((t) => haystack.includes(t));
    });

    const results = matches.slice(0, max).map((it) => ({
      id: it.id,
      type: it.type,
      description: it.itemDescription,
      category: it.category,
      location: it.location ?? (it.roomNumber ? `Room ${it.roomNumber}` : null),
      status: it.status,
      loggedAt: it.createdAt,
      foundBy: it.foundBy,
    }));

    return {
      ok: true,
      data: {
        query: q || null,
        type: typeFilter,
        totalMatches: matches.length,
        returned: results.length,
        items: results,
      },
    };
  },
});
