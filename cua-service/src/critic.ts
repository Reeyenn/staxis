/**
 * Pre/post screenshot critic for the CUA mapper.
 *
 * Pattern: Multimodal Auto-Validation for Self-Refinement in Web Agents
 * (arXiv 2410.00689, +5% absolute on WebVoyager). After every click in
 * vision mode, ask a cheap Sonnet 4.6 call to compare the pre- and
 * post-action screenshots and judge whether the click achieved its
 * intended outcome. Failure verdicts are NOT aborting — they inject a
 * "Critic note: ..." line into the tool_result text so the agent can
 * reconsider before its next action.
 *
 * Design choices:
 *   - Vision mode only. DOM mode already has `read_page` for grounding —
 *     the agent sees the new DOM tree directly.
 *   - Click verbs only. Scrolls, screenshots, and waits don't have a
 *     meaningful "intended outcome" worth grading.
 *   - Fail-open. Any error in the critic itself (network, parse, mock-
 *     model misbehavior) is logged and returns 'unclear' — the mapping
 *     run keeps going. We never want the critic to itself be the reason
 *     a healthy run dies.
 *   - Cost-attributed. Spend is logged via `logClaudeUsage` with
 *     workload='cua_critic' and the calling job's id, so the per-job
 *     cost cap in mapper.ts sees it through `getJobCostMicros`.
 *
 * Behind an env flag (CUA_CRITIC_ENABLED) so we can disable in a panic.
 * Default true.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { Page } from 'playwright';
import { anthropic } from './anthropic-client.js';
import { captureHardenedScreenshot } from './screenshot-privacy.js';
import { log } from './log.js';
// Importing env for its side effect: schema validation at module load
// (so a deployment misconfig fails fast). The runtime enabled-check
// below reads process.env directly so test runs can mutate the flag
// between cases.
import { env } from './env.js';

const CRITIC_MODEL = 'claude-sonnet-4-6';
const CRITIC_MAX_OUTPUT_TOKENS = 400;

const CRITIC_SYSTEM_PROMPT =
  `You are a strict critic for a web-browsing agent. Compare two ` +
  `screenshots — BEFORE and AFTER an action — and judge whether the ` +
  `action achieved its intended outcome.\n\n` +
  `Respond in EXACTLY this format, on TWO lines, no preamble, no ` +
  `markdown, no code fences:\n` +
  `VERDICT: <success|unclear|failure>\n` +
  `REASON: <one short sentence>\n\n` +
  `Guidance:\n` +
  `- success: the post-screenshot CLEARLY shows the intended outcome ` +
  `(navigation completed, menu opened, modal dismissed, input focused).\n` +
  `- unclear: the page changed somewhat but the change is ambiguous, or ` +
  `you cannot confirm the intended outcome from the screenshots alone.\n` +
  `- failure: nothing visible changed, the action clearly missed its ` +
  `target, or a different (often wrong) thing happened (e.g. an error ` +
  `modal popped instead of the expected navigation).`;

export interface CriticArgs {
  /** Base64-encoded PNG taken BEFORE the action ran. */
  pre: string;
  /** Base64-encoded PNG taken AFTER the action ran. */
  post: string;
  /** Plain-English description of the action (e.g. "left_click at 520,340"). */
  actionDescription: string;
  /** Plain-English description of what the click was supposed to achieve. */
  intendedOutcome: string;
  /** Forwarded to logClaudeUsage so per-job cost cap sees this spend. */
  jobId?: string | null;
  /** Forwarded to logClaudeUsage for Money-tab attribution. */
  propertyId?: string | null;
  /**
   * Job-level abort signal. When the parent job is timing out, the critic
   * call gets cancelled too — without this the critic could keep spending
   * up to its per-request timeout (120s) after the rest of the run has
   * already given up.
   */
  signal?: AbortSignal;
}

export interface CriticResult {
  verdict: 'success' | 'unclear' | 'failure';
  reason: string;
}

/**
 * Minimal subset of the Anthropic SDK that the critic uses. Lets tests
 * inject a fake without depending on the real SDK's constructor.
 */
export interface AnthropicLike {
  messages: {
    create: (
      params: Anthropic.Messages.MessageCreateParamsNonStreaming,
      opts?: { signal?: AbortSignal },
    ) => Promise<Anthropic.Messages.Message>;
  };
}

/**
 * Compare pre/post screenshots and judge whether the action achieved
 * `intendedOutcome`. Returns 'success' / 'unclear' / 'failure'.
 *
 * Fails open: any thrown error (network, malformed response, mock
 * misbehavior) maps to verdict='unclear', never throws upward.
 *
 * Disabled via `env.CUA_CRITIC_ENABLED='false'` — returns
 * verdict='success' with reason='critic_disabled'. The 'success' rather
 * than 'unclear' is intentional: when disabled, the critic must be
 * BEHAVIORALLY invisible (caller treats success as no-op).
 *
 * Optional second arg lets tests inject a fake Anthropic client.
 */
export async function judgeStepOutcome(
  args: CriticArgs,
  deps?: { client?: AnthropicLike },
): Promise<CriticResult> {
  if (!isCriticEnabled()) {
    return { verdict: 'success', reason: 'critic_disabled' };
  }

  // Tests pass a narrow fake via `deps.client`; production uses the
  // real SDK instance from anthropic-client.ts. The real instance is a
  // structural superset of AnthropicLike (its messages.create accepts
  // streaming + non-streaming overloads); we only call the non-
  // streaming path. Branching here lets each call site use its native
  // type without an `as unknown as` cast.
  const userText =
    `Action taken: ${args.actionDescription}\n` +
    `Intended outcome: ${args.intendedOutcome}\n\n` +
    `The FIRST image is BEFORE the action. The SECOND image is AFTER. ` +
    `Did the action achieve the intended outcome?`;

  try {
    const params = {
      model: CRITIC_MODEL,
      max_tokens: CRITIC_MAX_OUTPUT_TOKENS,
      system: CRITIC_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user' as const,
          content: [
            { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: args.pre } },
            { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: args.post } },
            { type: 'text' as const, text: userText },
          ],
        },
      ],
    };
    const opts = args.signal ? { signal: args.signal } : undefined;
    const response = deps?.client
      ? await deps.client.messages.create(params, opts)
      : await anthropic.messages.create(params, opts);

    // AWAIT (not void) — Codex review high-1: the cost-cap check at the
    // top of the next mapper iteration calls getJobCostMicros which
    // reads IN_PROC_COST_BY_JOB. If we fire-and-forget, the in-process
    // total lags behind the budget check on the first critic call (the
    // dynamic import + map update have not yet completed). Awaiting
    // here costs ~5-50ms but guarantees the budget check sees fresh
    // spend. logCriticUsage swallows its own errors so this never
    // throws upward. Dynamic import keeps the supabase client out of
    // the module-load graph (supabase realtime fails on Node 20
    // without native WebSocket).
    await logCriticUsage(response.usage ?? {}, args.jobId ?? null, args.propertyId ?? null);

    const text = response.content
      .filter((c): c is Anthropic.Messages.TextBlock => c.type === 'text')
      .map((c) => c.text)
      .join('\n');

    return parseCriticVerdict(text);
  } catch (err) {
    log.warn('critic: anthropic call failed — treating as unclear', {
      err: (err as Error).message,
    });
    return { verdict: 'unclear', reason: 'critic_call_failed' };
  }
}

/**
 * Read the enable flag. env.ts validated at boot that the value is one
 * of 'true' / 'false' or unset (defaults to enabled). Going through the
 * env module satisfies the check-env-access audit (which forbids direct
 * process.env reads outside canonical env modules).
 *
 * NOTE: env values are frozen at module-load by Zod parsing. Tests that
 * need to flip the value mid-run can override via the env module's
 * test-only mutation hooks, NOT by mutating process.env directly.
 */
function isCriticEnabled(): boolean {
  return env.CUA_CRITIC_ENABLED !== 'false';
}

/**
 * Lazy cost logger — imports usage-log on first call to avoid pulling
 * supabase into the test-time module graph. Tests run with placeholder
 * env vars + Node 20 (no native WebSocket), so eager-loading supabase
 * would fail at import time. Cached after first call.
 *
 * Typed via `typeof import(...)` — a type-only reference that doesn't
 * trigger the runtime import. Avoids the `as unknown as` cast Codex
 * review flagged.
 */
type LogClaudeUsageFn = typeof import('./usage-log.js').logClaudeUsage;
let _logClaudeUsage: LogClaudeUsageFn | null = null;
async function logCriticUsage(
  usage: Anthropic.Messages.Usage | object,
  jobId: string | null,
  propertyId: string | null,
): Promise<void> {
  try {
    if (!_logClaudeUsage) {
      const mod = await import('./usage-log.js');
      _logClaudeUsage = mod.logClaudeUsage;
    }
    await _logClaudeUsage(usage, {
      workload: 'cua_critic',
      model: CRITIC_MODEL,
      propertyId,
      jobId,
    });
  } catch (err) {
    log.warn('critic: usage log import or call failed', { err: (err as Error).message });
  }
}

/**
 * Capture a privacy-hardened screenshot for the critic.
 *
 * Thin wrapper over the shared `captureHardenedScreenshot`
 * (./screenshot-privacy.ts) — the single source of truth for masking
 * credential/SSN/CC fields (every frame) as part of the capture, and
 * withholding the frame if a masked image can't be produced. Returns base64
 * PNG on success, or `null` when no usable redacted frame could be produced
 * (navigation race, screenshot error, deadline). The caller (mapper.ts)
 * already fail-opens on `null` — it skips the critic check for that one
 * action; the critic itself is never disabled by this.
 */
export async function captureScreenshotForCritic(page: Page): Promise<string | null> {
  const buf = await captureHardenedScreenshot(page);
  return buf ? buf.toString('base64') : null;
}

/**
 * Parse the model's two-line response. Tolerant of:
 *   - extra whitespace
 *   - markdown code-fence wrapping
 *   - case variations on the VERDICT word
 *   - a leading "ANSWER:" or similar preamble before the VERDICT line
 *
 * If the response is unparseable, returns 'unclear' so the caller treats
 * the unknown verdict as a soft signal rather than a confident failure.
 */
export function parseCriticVerdict(text: string): CriticResult {
  const cleaned = text.replace(/```(?:[a-z]+)?\s*/gi, '').replace(/```/g, '');

  const verdictMatch = cleaned.match(/VERDICT\s*:\s*(success|unclear|failure)/i);
  const reasonMatch = cleaned.match(/REASON\s*:\s*(.+?)(?:\n|$)/i);

  const verdict = verdictMatch?.[1]?.toLowerCase() as 'success' | 'unclear' | 'failure' | undefined;
  const reason = reasonMatch?.[1]?.trim() ?? '';

  if (verdict === 'success' || verdict === 'unclear' || verdict === 'failure') {
    return { verdict, reason: reason || 'no reason given' };
  }
  return {
    verdict: 'unclear',
    reason: `unparseable critic response: ${text.slice(0, 100).replace(/\s+/g, ' ')}`,
  };
}
