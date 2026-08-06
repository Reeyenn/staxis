// ─── staxis_point_at — "how do I get my spreadsheet in?" ────────────────────
//
// The conversational half of the discovery pointer. Somebody asks where a
// thing is; the companion answers in one line AND draws the same arrow the
// discovery pointer draws, at the same control, in the same ink. Telling a
// non-technical manager "it is the ghost button between the view switch and
// Add item" is a description of a screen they are already looking at, which is
// the least useful sentence in the product.
//
// ─── WHY THIS TOOL READS NOTHING ───────────────────────────────────────────
//
// It is an acknowledgement, exactly like `staxis_show_pattern` and
// `walk_user_through` next door, and for exactly the same reason: only the
// browser can do this. Where a control SITS is a fact about the window the
// person has open, and a server that tried to answer it would be answering a
// different question. So the browser takes it from here: AskStaxisBar hears
// this tool fire on the `agent:tool-call-started` window event and mounts the
// pointer popup over the real control.
//
// ─── POINTING AT NOTHING IS IMPOSSIBLE ─────────────────────────────────────
//
// Three independent walls, and none of them is a prompt instruction:
//
//   1. THE MODEL NEVER SEES A SELECTOR. The argument is a key from
//      src/lib/companion/anchors.ts, and an unknown key resolves to null here
//      and is refused in words the model can recover from. There is deliberately
//      no branch that accepts an arbitrary string and turns it into a query.
//   2. THE PAGE MUST MATCH. `ctx.companionPage` is resolved at the route
//      boundary from the client pathname through `pageForPath`, an allowlist of
//      eight constant paths. An anchor belonging to another screen is refused,
//      so the companion cannot draw on a page it cannot see. No page proof at
//      all (the portfolio route, the approval-resolve route, the eval harness)
//      is also a refusal: fail closed, not "probably fine".
//   3. THE NODE MUST EXIST. Even past both of those, the browser refuses to
//      draw at a control that is missing or measures as zero, which is what
//      every control inside a hidden branch measures as. A phone that hides the
//      desktop rail gets a sentence and no arrow, which is honest.
//
// ─── WHAT IT SAYS IS NOT WHAT THE MODEL WROTE ──────────────────────────────
//
// The popup's sentence is the anchor's own `does` line, deterministic, walked
// by the copy-rule tests like every other companion sentence. The model writes
// the CHAT reply and nothing else. A pointer whose words a model composed on
// the spot would be the one companion surface nobody had approved, and it
// would sit outside the em-dash and English-only guards by construction.

import { registerTool, type ToolResult } from '../tools';
import { anchorFor, anchorsOnPage } from '@/lib/companion/anchors';

interface PointAtArgs {
  anchor: string;
}

registerTool<PointAtArgs>({
  name: 'staxis_point_at',
  description: [
    'Draw an arrow on the screen the person is looking at, from a short note to the actual control,',
    'and light that control up.',
    'Use when: they are asking where something is or how to do something that is a BUTTON on the',
    'screen in front of them. "How do I import my spreadsheet", "where do I put a delivery invoice",',
    "\"how do I add a to-do\", \"where's the thing that reads receipts\", \"I can't find it\".",
    'Args: anchor — one of the control keys listed in the awareness block for the screen they are on.',
    'Only those keys work. Do not invent one, do not pass a description, and do not pass a key from a',
    'different screen: both are refused.',
    'Returns: an acknowledgement only. The arrow itself is drawn in the browser, because only the',
    'browser can see where the control sits in their window.',
    'Refuses: a key that is not a real control, a key belonging to a screen they are not on, and any',
    'turn with no screen behind it. When it refuses, tell them in words where to look instead. Do not',
    'call it again with a guess.',
    'This SHOWS something that is already on their screen. It changes nothing, writes nothing and',
    'presses nothing, so do not say you have done, imported, ordered or logged anything. Keep your',
    'reply to one short line like "It is this one." and let the arrow do the rest.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      anchor: {
        type: 'string',
        description:
          'The key of the control to point at, copied exactly from the list of controls named for '
          + 'the current screen in the awareness block. Example: they ask "how do I bring my '
          + 'spreadsheet in" on Inventory → anchor = "inventory-import".',
      },
    },
    required: ['anchor'],
  },
  // The hats the companion itself serves. Housekeeping has no companion at all
  // (the founder's standing rule), and the front desk lens carries no staxis_*
  // tool, so the two anchors on the stockroom screen and the one on the
  // one-list are named only to the hats those screens belong to.
  allowedRoles: ['admin', 'owner', 'general_manager', 'maintenance', 'staff'],
  handler: async ({ anchor }, ctx): Promise<ToolResult> => {
    const target = anchorFor(typeof anchor === 'string' ? anchor.trim() : null);
    if (!target) {
      return {
        ok: false,
        error: 'That is not a control I can point at. Tell them where to look in your own words instead.',
      };
    }
    // No screen proof, or the wrong screen. Either way the honest answer is
    // the same, and it is one the model can turn into a sentence.
    if (!ctx.companionPage || ctx.companionPage !== target.page) {
      return {
        ok: false,
        error: 'That control is not on the screen they are looking at, so there is nothing to draw on. '
          + 'Say which screen it is on instead, and offer to take them there.',
      };
    }
    return {
      ok: true,
      data: {
        pointing: true,
        anchor: target.key,
        page: target.page,
        label: target.label,
        does: target.does,
        // What else was available here, so a model that guessed wrong once has
        // the real list rather than another guess.
        alsoOnThisScreen: anchorsOnPage(ctx.companionPage)
          .filter((a) => a.key !== target.key)
          .map((a) => a.key),
      },
    };
  },
});
