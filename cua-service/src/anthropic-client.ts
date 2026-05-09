/**
 * Anthropic SDK wrapper for the CUA worker.
 *
 * One reason this is a wrapper and not a direct import everywhere:
 *   - We want to centralize the model + tool versioning so updating
 *     Claude version is a one-line change.
 *   - Fail loudly if ANTHROPIC_API_KEY is missing.
 *   - Add structured logging on every Claude call so we can see token
 *     burn per job.
 */

import Anthropic from '@anthropic-ai/sdk';
import { log } from './log.js';

const API_KEY = process.env.ANTHROPIC_API_KEY;

if (!API_KEY) {
  throw new Error(
    'Missing ANTHROPIC_API_KEY. Get one at https://console.anthropic.com/settings/keys ' +
    'and set it: fly secrets set ANTHROPIC_API_KEY=sk-ant-...'
  );
}

// Explicit timeout + retry config. SDK defaults are 10-min per-request
// and 2 retries — way too generous. A single 529 (overloaded) on a CUA
// call could lock the worker for 30+ minutes (10min × 2 retries × stage).
// Job-level timeout (JOB_TIMEOUT_MS=4min) sets a flag but doesn't actually
// abort the in-flight HTTP request, so a hung Anthropic call would
// survive past the job timeout.
//
// 120s per attempt × 3 attempts (1 initial + 2 retries) = up to 360s,
// just over the 240s job budget — but the per-attempt cap is what
// matters for liveness. CUA round-trips with a screenshot + thinking
// can reach 60-90s on slow PMS pages; 120s gives that headroom while
// still aborting truly hung requests. (Pass-3 fix — H11.)
export const anthropic = new Anthropic({
  apiKey: API_KEY,
  timeout: 120_000,
  maxRetries: 2,
});

/**
 * Model + computer-use tool version we standardize on. Bump these together
 * when Anthropic ships a new computer-use spec — they evolve in lockstep.
 *
 * Why Opus and not Sonnet:
 *   We initially shipped on Sonnet for cost reasons. In canary testing
 *   2026-05-08, Sonnet repeatedly couldn't complete Choice Advantage
 *   mapping within 60 agent steps — it lost track of where it was on
 *   complex multi-page logins. Opus is significantly better at the
 *   long-horizon reasoning that PMS exploration requires (Anthropic's
 *   own docs explicitly recommend Opus for non-trivial computer-use).
 *
 * Cost trade:
 *   Opus is ~5x more expensive per token than Sonnet, but mapping is a
 *   ONE-TIME cost per PMS family — once OPERA's recipe is saved, every
 *   future OPERA hotel onboards for free. Top 10 PMSes cover ~95% of
 *   the industry, so total spend on mapping across the entire
 *   addressable market is on the order of $50-100, not per-hotel.
 *   Recipe replay (steady-state pulls) uses zero Anthropic.
 */
export const CLAUDE_MODEL = 'claude-opus-4-7';

/**
 * Computer-use tool definition. Display dimensions match the Playwright
 * viewport we configure in recipe-runner.ts — same numbers in both places
 * or click coordinates won't line up.
 *
 * Type note: at SDK v0.95 the computer-use tool shape isn't fully
 * incorporated into the public ToolUnion type, so we cast at the call
 * site (in mapper.ts). Keep the literal shape Anthropic documents — the
 * Messages API at the wire level accepts this just fine even if the
 * SDK's local types don't.
 */
export const COMPUTER_TOOL = {
  // The beta endpoint accepts computer_20250124. The SDK types include
  // computer_20251124 too, but the live API hasn't shipped it yet —
  // sending it returns 400 with "tag not in allowed list". Keep on
  // 20250124 until the API enumerates 20251124.
  type: 'computer_20250124' as const,
  name: 'computer' as const,
  display_width_px: 1280,
  display_height_px: 800,
  display_number: 1,
};

/**
 * Beta header required for computer-use tool calls. Pass via the
 * `betas` field on anthropic.beta.messages.create. Anthropic gates
 * computer-use behind this beta even though the tool itself is GA-stable
 * for our use case.
 */
export const COMPUTER_USE_BETA = 'computer-use-2025-01-24' as const;

/**
 * System message we prepend to all CUA mapping runs. The per-task prompt
 * (log in / find arrivals page / find staff list / etc.) goes in the
 * first user message.
 *
 * The PMS-specific guidance below is what separates a mapper that
 * gets stuck after 60 actions from one that completes in 30. Most
 * hotel PMSes share the same structural patterns; baking those into
 * the prompt gives Claude the right priors instead of asking it to
 * rediscover them per-hotel.
 */
export const MAPPING_SYSTEM_PROMPT =
  `You are a careful, methodical operator exploring a hotel property ` +
  `management system (PMS). Your job is to navigate the PMS UI and report ` +
  `back, in structured JSON, the URLs and selectors needed to extract data ` +
  `for arrivals, departures, room status, and staff lists.\n\n` +

  `STRATEGY (apply in this order):\n` +
  `1. After login, take ONE screenshot to orient yourself. Identify the ` +
  `top-level navigation menu (header tabs, sidebar links, or a hamburger). ` +
  `Most PMSes group reports under a "Reports", "Reservations", or "Front Desk" ` +
  `menu. Staff/users live under "Staff", "Users", "Setup", or "Admin".\n` +
  `2. If you see a multi-step login flow (credentials page → property picker ` +
  `→ dashboard), expect ~5-15 clicks to reach the dashboard. Don't get stuck ` +
  `re-clicking the login button — if a page loads slowly, wait 2 seconds ` +
  `and re-screenshot rather than clicking again.\n` +
  `3. To find a specific page (e.g., "rooms list"), click the most likely ` +
  `menu item, screenshot, and check. Don't explore breadth-first — go ` +
  `directly to the most likely candidate, and only back-track if wrong.\n` +
  `4. Once on the right page, take ONE screenshot and emit the requested ` +
  `JSON immediately. Do not explore further.\n\n` +

  `RULES:\n` +
  `1. Never enter or modify guest data. You are read-only.\n` +
  `2. If you encounter a 2FA prompt, popup, cookie banner, "what's new" ` +
  `dialog, "session active" warning, or any modal, dismiss it (Close / X / ` +
  `Continue / OK) and continue. Don't read its content — just dismiss.\n` +
  `3. If you reach the requested page, take a final screenshot and reply ` +
  `with the JSON report only — no commentary.\n` +
  `4. If after 20 actions you still don't see the page, reply with ` +
  `{"error": "<short reason>"} and stop. Don't keep trying past 20.\n` +
  `5. Never click links that leave the PMS domain (e.g., "Help", "Documentation", ` +
  `external integrations).\n` +
  `6. Avoid keyboard shortcuts. Click instead — keystrokes like Ctrl+F often ` +
  `don't work in Playwright the same way they do in a real browser.\n` +
  `7. Coordinate clicks should aim at the visible CENTER of the target, not ` +
  `the edge — Playwright's click is precise so off-edge clicks miss.`;
