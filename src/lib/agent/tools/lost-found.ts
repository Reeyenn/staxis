// ─── Lost & Found tool ─────────────────────────────────────────────────────
// log_found_item — hands-free found-item logging for text + voice.
// "Hey Staxis, found a pair of glasses in 214" → a row in the L&F register.
//
// Writes via the shared store (supabaseAdmin); role + property access are
// already enforced by executeTool before the handler runs.

import { registerTool, type ToolResult } from '../tools';
import { findRoomByNumber } from './_helpers';
import { createItem } from '@/lib/lost-and-found/store';
import { LAF_CATEGORIES } from '@/lib/lost-and-found/types';

registerTool<{ itemDescription: string; roomOrLocation?: string; category?: string }>({
  name: 'log_found_item',
  description:
    'Log a FOUND item into the Lost & Found register. Use when someone reports finding lost property — e.g. "found a pair of glasses in 214", "someone left a phone charger in the lobby", "encontré una chaqueta negra en la 305". Capture WHAT was found and WHERE.',
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
  surfaces: ['chat', 'voice'],
  // Hands-free logging lives in the GENERAL "Hey Staxis" voice assistant, not
  // the narrow housekeeper_issue maintenance flow.
  voiceModes: ['general'],
  mutates: true,
  handler: async ({ itemDescription, roomOrLocation, category }, ctx): Promise<ToolResult> => {
    const desc = String(itemDescription ?? '').trim().slice(0, 500);
    if (!desc) return { ok: false, error: 'I need a short description of the item to log it.' };

    // Resolve a room number to a real room when possible; otherwise treat the
    // hint as a free-text location. Falls back to the voice session's current
    // room when the speaker doesn't restate it.
    let roomNumber: string | null = null;
    let location: string | null = null;
    const loc = roomOrLocation ? String(roomOrLocation).trim().slice(0, 200) : '';
    if (loc) {
      if (/^[A-Za-z0-9-]{1,10}$/.test(loc)) {
        const room = await findRoomByNumber(ctx.propertyId, loc);
        if (room) {
          roomNumber = room.number;
          location = `Room ${room.number}`;
        } else {
          location = loc; // a real-looking number we couldn't match — keep as text
        }
      } else {
        location = loc;
      }
    } else if (ctx.currentRoomNumber) {
      roomNumber = ctx.currentRoomNumber;
      location = `Room ${ctx.currentRoomNumber}`;
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
      source: ctx.surface === 'voice' ? 'voice' : 'staff',
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
