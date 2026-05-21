// ─── CUA action policy — Plan v2 F-AI-7 (CUA action allowlist) ────────────
//
// The mapping agent's "read-only" rule lives only in the system prompt
// today. A prompt-injecting PMS page can convince Claude to fire
// `form_input`/`type`/`click` on dangerous controls inside the
// authenticated session ("Click here to confirm setup" → mapper obeys,
// hotel data mutates). This module is the deterministic policy layer
// that decides whether a given browser-tool action is allowed in the
// current mapping phase BEFORE it touches Playwright.
//
// Phases:
//   - 'login'  — Claude is exploring the login form. Reads + form-style
//                writes are allowed, but mutating writes are restricted
//                to elements that LOOK like a login form (ARIA name/role
//                regex). Navigation off the trust anchor is blocked by
//                safeGoto; this layer also refuses navigate-to-untrusted
//                URLs by short-circuiting on text mismatch (defence in
//                depth — safeGoto would refuse too).
//   - 'action' — Claude is exploring a post-login data page. Any write
//                action is REFUSED — the agent must navigate + read +
//                select selectors, never click submit/save buttons.
//   - 'extract'— recipe-runner; no Anthropic in the loop. Not gated by
//                this module (recipe steps are already deterministic).
//
// Rollout: enforce via `CUA_POLICY_ENFORCE` env. Values:
//   - 'warn'    (default) — log refusals, allow the action anyway.
//   - 'enforce' — refuse the action; the browser-tool returns an
//                 agent-friendly error and Claude retries.
//
// We log every refusal regardless of mode so the operator can see how
// often each rule fires before flipping enforce.

import type { BrowserAction } from './browser-tool.js';
import { env } from './env.js';

// Intentionally NOT importing './log.js' here — that pulls in @sentry/node,
// which makes this module hard to unit-test in isolation. recordPolicyRefusal
// writes one JSON line to stderr; Fly's log aggregator picks that up the
// same way it picks up log.warn lines.

export type MappingPhase = 'login' | 'action';

export type PolicyMode = 'enforce' | 'warn';

export function policyMode(): PolicyMode {
  return env.CUA_POLICY_ENFORCE === 'enforce' ? 'enforce' : 'warn';
}

export interface PolicyDecision {
  allow: boolean;
  /** Set when allow=false; agent-friendly explanation that goes into the tool_result. */
  reason?: string;
  /** Always set when the action is gated; used for telemetry. */
  rule: string;
}

/**
 * Heuristic — does this element look like a login form field/button?
 * The mapper sees ref-resolved element info (text, aria-label, name,
 * type). Login pages have predictable signals: input names containing
 * `user|email|login|pass`, button text matching `sign in|log in|submit
 * |continue|next|enter`, etc.
 *
 * The check intentionally errs ALLOW for the login phase — we'd rather
 * miss a refusal on a weird PMS login form than block a legitimate one.
 * Post-login the same heuristic flips: any write action that doesn't
 * match a known-login signature is refused.
 */
function looksLikeLoginControl(hint: string): boolean {
  const h = hint.toLowerCase();

  // Deny-list — controls with these prefixes are NOT login forms even
  // if their suffix matches a login keyword (e.g. share_email,
  // forward_password, delete_account). Login forms never need typing
  // into share/forward/delete/remove/cancel/refund/export controls.
  //
  // Plan v2.1 MP-3 — dropped the dead `forgot[_-]?reset` alternation.
  // It matched no realistic PMS control name. "forgot password" is a
  // legitimate login control (handled by the positive match below);
  // "reset other accounts" is covered by `reset[_-]?other`.
  if (/(\b|_)(share|forward|reset[_-]?other|delete|remove|cancel|refund|share[_-]via|export[_-])(\b|_)/.test(h)) {
    return false;
  }

  return /(\b|_)(user|username|email|userid|login|user-id|account)(\b|_)/.test(h)
    || /(\b|_)(pass|password|passwd|pwd|secret)(\b|_)/.test(h)
    || /\b(sign[- ]?in|log[- ]?in|sign[- ]?on|submit|continue|next|enter|go|ok)\b/.test(h)
    || /\bremember[- ]me\b/.test(h)
    || /\bforgot[- ]?password\b/.test(h);
}

/**
 * Decide whether the given action is allowed in the current mapping
 * phase. Callers ALSO pass an optional `hint` string built from the
 * resolved-ref's element info — text/role/aria-label/name concatenated.
 * The browser-tool currently exposes that info to logs and to the
 * model's tool_result; this module reuses the same string for the
 * allowlist check.
 *
 * For actions that don't carry a ref (raw coordinate clicks, plain
 * `type` after a previous click), the hint will be empty. In that case
 * we err on the side of refusal in the 'action' phase (no way to know
 * what's being clicked) and allow in 'login' (typing a credential
 * placeholder into the focused field is the recorded flow).
 */
export function allowAction(
  action: BrowserAction,
  phase: MappingPhase,
  hint: string,
): PolicyDecision {
  // Read-only actions are always safe.
  switch (action.action) {
    case 'screenshot':
    case 'read_page':
    case 'get_page_text':
    case 'find':
    case 'wait':
    case 'scroll':
    case 'scroll_to':
    case 'hover':
      return { allow: true, rule: 'read_only' };
  }

  // Navigate: safeGoto enforces the registrable-domain check. We add a
  // second-layer defence here: when text is provided, reject obviously-
  // suspicious schemes BEFORE the SDK even formats the request.
  if (action.action === 'navigate') {
    const url = (action.text ?? '').trim();
    if (!url) return { allow: false, rule: 'navigate_empty', reason: 'navigate requires a URL.' };
    if (/^(javascript|data|file|about|chrome):/i.test(url)) {
      return {
        allow: false,
        rule: 'navigate_scheme',
        reason: `Refused navigate to non-http(s) scheme: ${url.slice(0, 80)}.`,
      };
    }
    return { allow: true, rule: 'navigate_pre_check' };
  }

  // Write actions: type / form_input / left_click / double_click / key.
  // Phase 'action' refuses any of these — the agent shouldn't be
  // mutating anything post-login (no submits, no save buttons).
  const isWrite =
    action.action === 'type' ||
    action.action === 'key' ||
    action.action === 'form_input' ||
    action.action === 'left_click' ||
    action.action === 'double_click';

  if (!isWrite) {
    // Unknown action — let the underlying executor reject it. We don't
    // mint a refusal here because the agent benefits from the
    // executor's specific error.
    return { allow: true, rule: 'unknown_action_passthrough' };
  }

  if (phase === 'action') {
    return {
      allow: false,
      rule: `${action.action}_after_login`,
      reason:
        `Mapping is read-only after login. Refused ${action.action} — use ` +
        '`read_page`, `find`, or `get_page_text` to explore, then return ' +
        'the recipe JSON when ready.',
    };
  }

  // phase === 'login': allow writes only when the hint matches a login
  // signature. Empty hint (no ref) → allow (`type` after a click is the
  // standard flow). Non-empty hint that doesn't match → refuse.
  if (phase === 'login') {
    if (!hint) return { allow: true, rule: 'login_no_hint' };
    if (looksLikeLoginControl(hint)) {
      return { allow: true, rule: 'login_hint_match' };
    }
    return {
      allow: false,
      rule: `${action.action}_login_hint_mismatch`,
      reason:
        `${action.action} refused — the element doesn't look like a login form ` +
        `field/button (hint="${hint.slice(0, 80)}"). Use \`form_input\` on the ` +
        'username/password fields, then click the submit button.',
    };
  }

  return { allow: true, rule: 'default_allow' };
}

/**
 * Record a refusal — used by browser-tool when policy refuses an action.
 * Separated so the same log shape fires in both 'warn' (we log but
 * proceed) and 'enforce' (we log and return an error) modes.
 */
export function recordPolicyRefusal(args: {
  action: string;
  phase: MappingPhase;
  rule: string;
  reason: string;
  mode: PolicyMode;
}): void {
  // One-line JSON to stderr; Fly's log aggregator handles the rest.
  // Same shape the log.warn helper would produce.
  process.stderr.write(JSON.stringify({
    level: 'warn',
    evt: 'cua_action_policy_refusal',
    ...args,
    t: new Date().toISOString(),
  }) + '\n');
}
