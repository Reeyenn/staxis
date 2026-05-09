/**
 * Anthropic SDK wrapper for the CUA worker.
 *
 * Centralizes the Claude model + tool versioning so updates are a one-line
 * change. We standardize on a single model for both mapping and any future
 * Claude calls — bumping is a single export update.
 *
 * IMPORTANT: this worker no longer uses Anthropic's `computer` (pixel-click)
 * beta tool. We migrated to the DOM-aware `browser` custom tool defined in
 * src/browser-tool.ts (modeled on anthropic-quickstarts/browser-use-demo).
 * Because `browser` is a custom tool — not an Anthropic-defined beta tool —
 * any model with tool-use support works. We pick Sonnet 4.6: cheaper than
 * Opus, faster, and previously blocked because it doesn't support
 * computer-use beta. With browser tool, that limitation is gone.
 */

import Anthropic from '@anthropic-ai/sdk';
import { BROWSER_TOOL_PARAM } from './browser-tool.js';

const API_KEY = process.env.ANTHROPIC_API_KEY;

if (!API_KEY) {
  throw new Error(
    'Missing ANTHROPIC_API_KEY. Get one at https://console.anthropic.com/settings/keys ' +
    'and set it: fly secrets set ANTHROPIC_API_KEY=sk-ant-...'
  );
}

// Per-attempt timeout. CUA round-trips with screenshots can reach 60-90s
// on slow PMS pages; 120s gives that headroom while still aborting hung
// requests. Combined with maxRetries=2 = up to ~360s of retry budget.
export const anthropic = new Anthropic({
  apiKey: API_KEY,
  timeout: 120_000,
  maxRetries: 2,
});

/**
 * Sonnet 4.6 — the default for the browser-tool mapper.
 *
 * Why Sonnet 4.6 (not Opus 4.7 / not Sonnet 4.5):
 *   - Browser tool is a CUSTOM tool, not Anthropic-defined. There is no
 *     model gating like there was for computer-use beta.
 *   - Sonnet 4.6 is materially cheaper than Opus 4.7 (~3-5x), and
 *     navigating a PMS doesn't require Opus-level reasoning — the agent
 *     mostly does "read DOM tree → find link → click → repeat" loops.
 *   - Sonnet 4.5 was a workaround when computer-use beta only worked on
 *     that model. We're past that constraint now.
 *
 * If a future PMS turns out to need stronger reasoning, swap this to
 * `claude-opus-4-7` and re-test.
 */
export const CLAUDE_MODEL = 'claude-sonnet-4-6';

/**
 * Browser tool definition that the mapper passes to messages.create.
 * Re-exported here so callers don't import from two places.
 */
export const BROWSER_TOOL = BROWSER_TOOL_PARAM;

/**
 * System prompt for browser-tool mapping runs. Replaces the older pixel-
 * click MAPPING_SYSTEM_PROMPT.
 *
 * The shift in guidance vs. the old prompt:
 *   - We tell the agent to call `read_page` after every navigation so it
 *     gets ref_N for each interactive element.
 *   - We tell it to PREFER refs over coordinates.
 *   - We tell it to use `get_page_text` instead of OCR'ing screenshots.
 *   - We keep the PMS-specific structural priors (Reports menu, property
 *     pickers, etc.) since those still hold regardless of click mechanism.
 */
export const MAPPING_SYSTEM_PROMPT =
  `You are a careful, methodical operator exploring a hotel property ` +
  `management system (PMS). Your job is to navigate the PMS UI and report ` +
  `back, in structured JSON, the URLs and selectors needed to extract data ` +
  `for arrivals, departures, room status, and staff lists.\n\n` +

  `TOOL USAGE — IMPORTANT:\n` +
  `1. After EVERY navigation or click that changes the page, call ` +
  `\`read_page\` (with text="interactive" filter) to get fresh element refs ` +
  `(ref_1, ref_2, …). Don't try to click coordinates from a screenshot — ` +
  `use refs.\n` +
  `2. Use \`form_input\` with a ref to set input values directly. This is ` +
  `more reliable than click + type.\n` +
  `3. Use \`get_page_text\` to read article-style content. Don't try to ` +
  `read text from screenshots.\n` +
  `4. Only fall back to coordinate-based clicks when no ref works.\n` +
  `5. After login: take ONE screenshot to orient yourself, then read_page ` +
  `to find the navigation menu.\n\n` +

  `PMS STRUCTURAL PRIORS:\n` +
  `1. Reports — most data lives under "Reports", "Reservations", or "Front ` +
  `Desk" menus. Staff/users live under "Staff", "Users", "Setup", or ` +
  `"Admin".\n` +
  `2. Login flows — single-page form, two-step (username → password), or ` +
  `with a property picker. Expect 5-15 actions to reach the dashboard. ` +
  `Choice Advantage specifically lands on a "Welcome" splash; click ` +
  `"Continue" / "Enter PMS" / the property name to reach the dashboard.\n` +
  `3. Modals — dismiss any cookie banner, "what's new" dialog, "session ` +
  `active" warning, or 2FA prompt by clicking Close / X / Continue / OK. ` +
  `Don't read modal content; just dismiss.\n` +
  `4. To find a specific page (e.g. "arrivals"), click the most likely menu ` +
  `item, read_page, check. Don't explore breadth-first.\n\n` +

  `RULES:\n` +
  `1. Read-only. Never enter, edit, or delete guest data.\n` +
  `2. Never click links that leave the PMS domain (Help, external integrations).\n` +
  `3. If after 25 actions you still haven't reached the requested page, ` +
  `reply with {"error": "<short reason>"} and stop. Don't keep trying.\n` +
  `4. When you reach a target page, take ONE screenshot, then emit the ` +
  `requested JSON immediately. Don't keep exploring.`;
