// ─── staxis_show_pattern — "actually, show me that AC thing" ────────────────
//
// The conversational way back into an offer the companion already made. A
// pattern the companion raised is a message in the thread now, so it can be
// tapped — but the thing a person actually says out loud is "wait, show me that
// again", and that sentence should work too.
//
// ─── WHY THIS TOOL READS NOTHING ───────────────────────────────────────────
//
// It is an acknowledgement, exactly like `staxis_show_around` next door, and for
// exactly the same reason: only the browser can do this. The reveal is a
// geometric argument about the empty space on the page the person is standing
// on, drawn against rows that exist in their DOM. A server that re-detected
// patterns here would be answering a different question ("what is true at this
// hotel") from the one being asked ("show me the one you just told me about,
// on this screen").
//
// So the browser resolves it. AskStaxisBar hears this tool fire on the
// `agent:tool-call-started` window event, matches `hint` against the patterns
// useTrace already loaded for the current screen and the offers already in the
// thread, and draws it — or says the honest thing if it cannot.
//
// ─── THE GATES ARE THE TRACE'S OWN, UNCHANGED ──────────────────────────────
//
// Nothing here re-implements them, which is the point:
//   • PAGE — the browser only ever holds patterns for maintenance, inventory
//     and the Staxis list, because /api/companion/trace only returns them for
//     those three (its PAGES allowlist). A hint naming anything else matches
//     nothing and gets refused.
//   • ROLE — `allowedRoles` below, plus the trace route's own
//     chatIsMountedForRole check, which already refused to hand this browser
//     any pattern at all if the hat has no companion.
//   • SECTION — the trace route returns nothing when a hotel has Staxis off, so
//     there is nothing in the browser to show. That is why this tool carries no
//     `section` of its own: gating the catalog would be a SECOND wall in a
//     different place, and the one that matters is the one holding the data.
//   • WIDTH — useTrace refuses below TRACE_MIN_VIEWPORT_WIDTH, so a phone has
//     no patterns loaded and this refuses there too.
//
// NO DEAD BUTTON. If the browser has nothing matching, it does not fake a
// reveal and it does not silently do nothing: it says so, in the one sentence
// the rest of the feature already uses for this.

import { registerTool, type ToolResult } from '../tools';

interface ShowPatternArgs {
  hint: string;
}

/** Longest hint worth carrying. A phrase, not a paragraph. */
const HINT_MAX = 120;

registerTool<ShowPatternArgs>({
  name: 'staxis_show_pattern',
  description: [
    'Draw a pattern Staxis already raised back onto the screen the person is looking at, with the',
    'lines running to the actual rows it is about.',
    'Use when: they are asking to see something you or the companion already mentioned rather than',
    'asking a new question. "Show me that AC thing", "what was that pattern from earlier",',
    '"draw that again", "you said something about the second floor, show me", "actually yes, show me".',
    'It is for going BACK to something already offered, including one they said no to earlier:',
    'a no was permission to stop bringing it up, not an instruction to hide it when asked.',
    'Args: hint — a short phrase in the person\'s own words naming which pattern they mean, taken from',
    'what they just said or from the offer earlier in this conversation ("the AC run", "second floor",',
    '"the towels"). Pass the hint even when it is vague; the browser matches it against what is',
    'actually on the screen.',
    'Returns: an acknowledgement only. The reveal itself is drawn in the browser, because only the',
    'browser can see which screen they are on and where the rows sit on it.',
    'Refuses: an empty hint. The browser refuses too, out loud, when nothing on the current screen',
    'matches or the pattern has since been handled: it says so plainly rather than drawing an empty',
    'diagram.',
    'This SHOWS something that is already true. It changes nothing, writes nothing, and creates no',
    'ticket, so do not say you have done, fixed or logged anything. Keep your reply to one short line',
    'like "Here it is." and let the drawing speak. If they then want a ticket raised, that is the',
    'button on the card they are about to see.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      hint: {
        type: 'string',
        description:
          'A short phrase naming which pattern they want to see again, in their own words, derived '
          + 'from their message or from an earlier offer in this conversation. Example: they say '
          + '"show me that AC thing" → hint = "AC".',
      },
    },
    required: ['hint'],
  },
  // The hats the trace itself serves. Housekeeping has no companion at all (the
  // founder's standing rule), and the front desk's lens deliberately carries no
  // staxis_* tool: the maintenance board, the stockroom and the one-list are
  // not their screens. Maintenance IS on the board where the hero pattern
  // lives, so it is mounted for them and named in their lens.
  allowedRoles: ['admin', 'owner', 'general_manager', 'maintenance', 'staff'],
  handler: async ({ hint }): Promise<ToolResult> => {
    const cleanHint = (hint ?? '').trim().slice(0, HINT_MAX);
    if (!cleanHint) {
      return {
        ok: false,
        error: 'Which one do they mean? Ask them, in their own words, before calling this again.',
      };
    }
    // Acknowledgement only — the browser takes it from here. See the header.
    return { ok: true, data: { showing: true, hint: cleanHint } };
  },
});
