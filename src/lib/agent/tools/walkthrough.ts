// ─── walk_user_through tool ──────────────────────────────────────────────
// The agent's hand-off to the client-side Clicky walkthrough overlay.
//
// Server-side this tool is a thin acknowledgement — it returns
// `{ started: true, task }` and the brain's natural-language reply is
// something like "Watch the cursor — I'll show you how." The actual
// per-step LLM loop (DOM snapshot → next action → animate) runs in the
// browser at /api/walkthrough/step because only the browser can see
// the current page state. The overlay (mounted in AppLayout) subscribes
// to the `agent:tool-call-started` window event and takes over when
// name === 'walk_user_through'.
//
// Routing — the description below tells Claude WHEN to fire this vs
// answer with text or call an action tool. Bake the phrase hints in so
// the model routes correctly without us hand-tuning the system prompt.

import { registerTool, type ToolResult } from '../tools';

interface WalkUserThroughArgs {
  task: string;
}

registerTool<WalkUserThroughArgs>({
  name: 'walk_user_through',
  description:
    'Demonstrate how to do a task in the Staxis web app by animating a cursor through the UI and narrating each step. ' +
    'FIRE this tool when the user asks HOW to do something in the app — phrases like ' +
    '"how do I add a housekeeper", "show me how to mark a room", "walk me through assigning rooms", ' +
    '"teach me how to set up the PMS", "guide me through inspections", "tutorial on …", "demo …". ' +
    'DO NOT fire for factual questions ("what\'s my occupancy", "when did room 302 get cleaned") — answer with text or a query tool instead. ' +
    'DO NOT fire for action requests ("mark room 302 clean", "assign room 410 to Carlos") — call the action tool directly. ' +
    'The task arg should be a short imperative phrase describing what the user wants to learn (e.g. "add a housekeeper", "mark all rooms inspected"). ' +
    'After this tool fires, the cursor takes over the page — your final reply to the user should be a one-liner like "Watch the cursor — I\'ll walk you through it."',
  inputSchema: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description:
          'A short imperative phrase describing what the user wants to be walked through, derived from their question. ' +
          'Example: user asks "how do I add a new housekeeper to my hotel?" → task = "add a housekeeper".',
      },
    },
    required: ['task'],
  },
  // All signed-in roles can use walkthroughs. The browser-side step loop
  // still scopes Claude's tool catalog by role (the snapshotDom utility
  // only surfaces elements the user can actually interact with).
  allowedRoles: ['admin', 'owner', 'general_manager', 'front_desk', 'housekeeping', 'maintenance'],
  handler: async ({ task }): Promise<ToolResult> => {
    const cleanTask = (task ?? '').trim().slice(0, 200);
    if (!cleanTask) {
      return {
        ok: false,
        error: 'A non-empty task description is required. Ask the user what they want help with.',
      };
    }
    // Acknowledgement only. The client overlay does the real work — it
    // sees this tool firing via the agent:tool-call-started window event
    // and starts its own loop against /api/walkthrough/step.
    return {
      ok: true,
      data: {
        started: true,
        task: cleanTask,
      },
    };
  },
});
