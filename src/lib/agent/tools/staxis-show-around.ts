// ─── staxis_show_around — "show me around" ──────────────────────────────────
//
// The tour is offered ONCE, on somebody's first sign-in, and a No there is a No
// forever: the manners engine never brings it up again. That is the right
// social contract and it leaves one hole, which is the person who said no in
// their first thirty seconds and wants it in week two. This tool is that door,
// and it is deliberately the SAME door a person opens by asking, rather than a
// second menu item nobody would find.
//
// ─── WHY IT READS NOTHING AND WRITES NOTHING ───────────────────────────────
//
// An acknowledgement, exactly like `staxis_point_at` and `staxis_show_pattern`
// next door, for exactly the same reason: only the browser can run a tour. The
// stops are anchored to controls in a window the server cannot see, and half of
// them wait for the person to do something. So the server's whole job is to
// agree that a tour exists for this hat, and the browser takes it from there on
// the `agent:tool-call-started` event.
//
// ─── IT CANNOT START A TOUR FOR SOMEBODY WHO HAS NONE ──────────────────────
//
// Three walls, and the first two are the ones every other companion surface
// already has:
//
//   1. THE HAT. Housekeeping has no companion at all (founder standing rule,
//      enforced in mount.ts and again by the lens, which mounts no chat for
//      that role), so this tool is never in its catalog and the browser would
//      refuse it anyway.
//   2. THE SCREEN. A turn with no page proof behind it is refused, which keeps
//      this in step with the rest of the companion's browser-side tools: an
//      eval harness and a portfolio route are not screens somebody is standing
//      on, and a tour needs one to start from.
//   3. THE STOPS. `tourStopsFor` filters by role, by the hotel's section
//      switches and by what this person's own access renders. A hat whose tour
//      comes out empty is told so in words the model can turn into a sentence,
//      rather than being handed a tour that starts and immediately ends.
//
// ─── AND THE TOUR STILL NEVER ACTS ─────────────────────────────────────────
//
// Nothing about reaching the tour from chat changes what the tour does. It
// points, it waits, and the person does every action. There is no argument
// here that could make it do otherwise, because there is no argument here.

import { registerTool, type ToolResult } from '../tools';
import { tourStopsFor } from '@/lib/companion/tour';
import { canManageTeam } from '@/lib/roles';

registerTool<Record<string, never>>({
  name: 'staxis_show_around',
  description: [
    'Start the guided tour of the app on the screen the person is looking at.',
    'Use when: they ask to be shown around, ask for a tour, say they are new here and want the',
    'basics, or ask what the app can do for them in general.',
    '"Show me around", "give me the tour", "I am new, where do I start", "what is all this".',
    'Do NOT use it for a question about ONE thing. "How do I import my spreadsheet" is',
    'staxis_point_at, not a three minute tour.',
    'Takes no arguments.',
    'Returns: an acknowledgement only. The tour itself runs in the browser, because it points at',
    'real controls in their window and waits for them to use some of them.',
    'Refuses: any turn with no screen behind it, and any person whose role and hotel leave no',
    'stops to show. When it refuses, say so plainly and offer to answer questions instead.',
    'The tour NEVER does anything to the hotel. It points and it waits; the person does every',
    'action themselves. Do not say you have set anything up. Keep your reply to one short line',
    'like "Here we go." and let the tour talk.',
  ].join(' '),
  inputSchema: { type: 'object', properties: {}, required: [] },
  // The same hats the companion itself serves. Housekeeping is absent here and
  // absent from the lens and absent from the mount gate: three refusals that
  // agree, rather than one the other two rely on.
  allowedRoles: ['admin', 'owner', 'general_manager', 'front_desk', 'maintenance', 'staff'],
  handler: async (_args, ctx): Promise<ToolResult> => {
    if (!ctx.companionPage) {
      return {
        ok: false,
        error: 'There is no screen behind this conversation, so there is nothing to walk them '
          + 'through. Offer to answer questions instead.',
      };
    }
    const stops = tourStopsFor({
      role: ctx.user.role,
      enabledSections: ctx.enabledSections,
      standing: {
        // The same resolution `staxis_point_at` uses, from the same two
        // route-bound facts. Fail closed on both: a tour that stopped at a
        // control this person's access never renders would be the companion
        // waiting for something that cannot happen.
        canManage: canManageTeam(ctx.user.role) && ctx.user.hotelMutationAllowed === true,
        seesMoney: ctx.user.capabilitySnapshot?.view_financials === true,
        enabledSections: ctx.enabledSections,
      },
    });
    if (stops.length === 0) {
      return {
        ok: false,
        error: 'There is no tour for this person: their role and this hotel leave nothing to show. '
          + 'Offer to answer questions instead.',
      };
    }
    return {
      ok: true,
      data: {
        touring: true,
        stops: stops.length,
        // What it will cover, so the model's one line can be honest about the
        // size of it without inventing a number.
        covers: stops.map((s) => s.page),
      },
    };
  },
});
