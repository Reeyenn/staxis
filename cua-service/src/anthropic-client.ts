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
 * Sonnet is the right fit: capable enough for novel UI navigation, much
 * cheaper than Opus at our expected volume (300 hotels × 1 mapping each
 * + occasional fallbacks).
 */
export const CLAUDE_MODEL = 'claude-sonnet-4-5';

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
  type: 'computer_20251124' as const,
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
 * Generic system message we prepend to all CUA mapping runs. The
 * per-task prompt (find arrivals page, find departures page, etc.)
 * goes in the user message.
 */
export const MAPPING_SYSTEM_PROMPT =
  `You are a careful, methodical operator exploring a hotel property ` +
  `management system (PMS). Your job is to navigate the PMS UI and report ` +
  `back, in structured JSON, the URLs and selectors needed to extract data ` +
  `for arrivals, departures, room status, and staff lists. ` +
  `\n\n` +
  `Rules:\n` +
  `1. Never enter or modify guest data. You are read-only.\n` +
  `2. If you encounter a 2FA prompt, popup, cookie banner, or "what's new" ` +
  `dialog, dismiss it and continue.\n` +
  `3. If you reach the requested page, take a final screenshot and reply ` +
  `with the JSON report only — no commentary.\n` +
  `4. If you cannot find the page after 20 actions, reply with ` +
  `{"error": "<short reason>"} and stop.\n` +
  `5. Never click links that look like they leave the PMS domain.`;
