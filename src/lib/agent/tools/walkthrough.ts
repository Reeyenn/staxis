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
    'Show the user how to do something in the Staxis app by driving a cursor through the real screens and narrating each step. ' +
    'Use when: they are asking HOW to work the app, not what is true or what to change — "how do I add a housekeeper", "show me how to mark a room", "walk me through assigning rooms", "teach me to set up the PMS", "tutorial on …". Do NOT fire it for a factual question ("what\'s my occupancy", "when was 302 cleaned") — answer with a query tool. Do NOT fire it for a request to actually DO something ("mark 302 clean") — call that action tool instead; showing someone the buttons is not doing their work for them. ' +
    'Args: task — a short imperative phrase for what they want to learn, derived from their question ("add a housekeeper", "mark all rooms inspected"). ' +
    'Returns: an acknowledgement only. The walkthrough itself then runs in the user\'s browser, because only the browser can see which page they are on. ' +
    'Refuses: an empty task. Once it fires the cursor takes over the screen, so keep your reply to a single line like "Watch the cursor — I\'ll walk you through it" and do not also narrate the steps in text. It teaches the UI; it cannot change any setting or complete the task for them.',
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
