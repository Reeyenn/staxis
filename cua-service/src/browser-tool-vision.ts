/**
 * Vision-based computer-use tool — Plan v8 Phase A.
 *
 * Wraps Anthropic's official `computer_20251124` beta tool to drive a
 * Playwright Chromium. Used by the mapper when MAPPER_MODE='vision'.
 *
 * Difference from the DOM-aware `browser-tool.ts`:
 *  - Agent receives SCREENSHOTS (PNG) not a DOM accessibility tree
 *  - Clicks use PIXEL COORDINATES not refs
 *  - Recipe steps record as {kind: 'click_at', x, y} / {kind: 'type_text', value}
 *    — these step kinds already exist in types.ts and replay handles them
 *    in recipe-runner.ts (lines 330-336, confirmed by plan v8 self-review F1)
 *
 * Required when calling Claude:
 *   anthropic-beta: computer-use-2025-11-24
 *
 * Models supported (per Anthropic docs, May 2026):
 *   - claude-opus-4-7
 *   - claude-opus-4-6
 *   - claude-sonnet-4-6 (our default)
 *   - claude-opus-4-5
 *
 * Privacy hardening (P1-4): before EVERY screenshot, blank out elements
 * matching `input[type="password"]`, `[data-sensitive]`, `.ssn`,
 * `.credit-card`. Keeps passwords + PII out of Anthropic conversation
 * history, the realtime broadcast channel, and the help-request DB row.
 *
 * Policy layer (P1-1 Option I): vision actions don't carry DOM hints,
 * so `policy.ts`'s element-attribute-derived `policyHint` is empty for
 * every action. Plan v8 documents this as an accepted trade-off during
 * vision mode (the F-AI-7 phase-aware write blocker is bypassed for the
 * one-time mapping run; live polling stays deterministic and unaffected).
 * Phase B/C may extend `policy.ts` to use the assistant's text-reasoning
 * as a hint when ref is absent (Option II — deferred).
 *
 * Navigation: no `navigate` action in the vision tool. The agent
 * navigates by clicking visible menu links / typing in input fields.
 * `mapping-driver.ts` pre-positions the page via `safeGoto` BEFORE the
 * agent's per-target loop starts. `page.url()` is read between turns to
 * record `{kind: 'goto', url}` steps for replay.
 */

import type { Page } from 'playwright';
import type { PMSCredentials, RecipeStep } from './types.js';
import type { MappingPhase } from './policy.js';
import { log } from './log.js';

// ─── Anthropic computer_20251124 tool param ──────────────────────────────

/**
 * Pass this in `messages.create({tools: [VISION_TOOL_PARAM, ...]})`.
 * Anthropic's SDK type doesn't yet know about computer_20251124 as a
 * literal; cast at the call site with `as unknown as Tool`.
 *
 * Display dimensions match the viewport mapping-driver opens — keep
 * these in sync with `cua-service/src/mapper.ts`'s `VIEWPORT` constant.
 */
export const VISION_TOOL_PARAM = {
  type: 'computer_20251124',
  name: 'computer',
  display_width_px: 1280,
  display_height_px: 800,
  display_number: 1,
} as const;

export const VISION_TOOL_NAME = 'computer';

// ─── Action types — what Anthropic's tool emits as `input` ────────────────

/**
 * All actions Claude can request via the computer_20251124 tool's `input`.
 * Schema source: https://docs.claude.com/en/docs/build-with-claude/computer-use
 */
export type VisionAction =
  | { action: 'screenshot' }
  | { action: 'left_click'; coordinate: [number, number]; text?: string }
  | { action: 'right_click'; coordinate: [number, number] }
  | { action: 'middle_click'; coordinate: [number, number] }
  | { action: 'double_click'; coordinate: [number, number] }
  | { action: 'triple_click'; coordinate: [number, number] }
  | { action: 'mouse_move'; coordinate: [number, number] }
  | { action: 'left_click_drag'; start_coordinate: [number, number]; coordinate: [number, number] }
  | { action: 'left_mouse_down'; coordinate: [number, number] }
  | { action: 'left_mouse_up'; coordinate: [number, number] }
  | { action: 'type'; text: string }
  | { action: 'key'; text: string }
  | { action: 'hold_key'; text: string; duration: number }
  | { action: 'scroll'; coordinate: [number, number]; scroll_direction: 'up' | 'down' | 'left' | 'right'; scroll_amount: number }
  | { action: 'wait'; duration: number }
  | { action: 'cursor_position' };

export interface VisionActionResult {
  /** Plain-text output for the agent's tool_result content. */
  output: string;
  /** Optional base64 PNG to surface back to the agent as an image block. */
  screenshotB64?: string;
  /** Recipe step recorded so deterministic Playwright replay can do the same. */
  recordedStep?: RecipeStep;
  /** True if this action failed; sets `is_error: true` on the tool_result. */
  isError?: boolean;
}

// ─── Executor ────────────────────────────────────────────────────────────

export async function executeVisionAction(
  page: Page,
  action: VisionAction,
  creds: PMSCredentials,
  phase: MappingPhase = 'login',
): Promise<VisionActionResult> {
  try {
    // Plan v8 review P1-A — VISION MODE BYPASSES policy.ts entirely.
    //
    // Why: policy.ts derives its decision from element attributes (text,
    // aria-label, role, type) accessed via DOM ref. Vision actions carry
    // pixel coordinates, no DOM hint. policy.ts's default for a missing
    // hint in the 'action' phase is REFUSE for every click — which would
    // silently abort every vision-mode navigation under
    // CUA_POLICY_ENFORCE=enforce. We confirmed in Codex review.
    //
    // Trade-off: the F-AI-7 phase-aware write-blocker is bypassed during
    // the one-time mapping run. Mapping uses read-only PMS browsing; live
    // polling runs deterministic recipes (no Claude in the loop), so this
    // exposure is bounded to the mapping window per PMS family. Plan v8
    // Option II (extend policy.ts with text-reasoning hints) is deferred.
    //
    // We log every vision action for ops visibility.
    log.info('vision-action', { phase, action: action.action });

    switch (action.action) {
      case 'screenshot': {
        // Plan v8 P0-B: add visual-only black overlays over sensitive
        // elements, screenshot, ALWAYS remove overlays in finally so the
        // page doesn't carry them forward (would block future clicks).
        await hardenScreenshotPrivacy(page);
        try {
          const buf = await page.screenshot({ fullPage: false });
          return {
            output: 'Screenshot captured.',
            screenshotB64: buf.toString('base64'),
          };
        } finally {
          await clearScreenshotPrivacyOverlays(page);
        }
      }

      case 'left_click': {
        const [x, y] = action.coordinate;
        await page.mouse.click(x, y);
        return {
          output: `Left-clicked at (${x}, ${y}).`,
          recordedStep: { kind: 'click_at', x, y },
        };
      }

      case 'right_click': {
        const [x, y] = action.coordinate;
        await page.mouse.click(x, y, { button: 'right' });
        return {
          output: `Right-clicked at (${x}, ${y}). (Not recorded — replay uses left click only.)`,
        };
      }

      case 'middle_click': {
        const [x, y] = action.coordinate;
        await page.mouse.click(x, y, { button: 'middle' });
        return {
          output: `Middle-clicked at (${x}, ${y}). (Not recorded — replay uses left click only.)`,
        };
      }

      case 'double_click': {
        const [x, y] = action.coordinate;
        await page.mouse.dblclick(x, y);
        return {
          output: `Double-clicked at (${x}, ${y}).`,
          recordedStep: { kind: 'click_at', x, y },  // dblclick records as single in v1; tighten later if needed
        };
      }

      case 'triple_click': {
        const [x, y] = action.coordinate;
        await page.mouse.click(x, y, { clickCount: 3 });
        return {
          output: `Triple-clicked at (${x}, ${y}).`,
          recordedStep: { kind: 'click_at', x, y },
        };
      }

      case 'mouse_move': {
        const [x, y] = action.coordinate;
        await page.mouse.move(x, y);
        return { output: `Moved cursor to (${x}, ${y}).` };
      }

      case 'left_click_drag': {
        const [sx, sy] = action.start_coordinate;
        const [ex, ey] = action.coordinate;
        await page.mouse.move(sx, sy);
        await page.mouse.down();
        await page.mouse.move(ex, ey, { steps: 8 });
        await page.mouse.up();
        return {
          output: `Dragged from (${sx}, ${sy}) to (${ex}, ${ey}). (Not recorded for replay.)`,
        };
      }

      case 'left_mouse_down': {
        const [x, y] = action.coordinate;
        await page.mouse.move(x, y);
        await page.mouse.down();
        return { output: `Mouse down at (${x}, ${y}).` };
      }

      case 'left_mouse_up': {
        const [x, y] = action.coordinate;
        await page.mouse.move(x, y);
        await page.mouse.up();
        return { output: `Mouse up at (${x}, ${y}).` };
      }

      case 'type': {
        // Credential substitution — same pattern as browser-tool.ts:386-415.
        // The agent sees the placeholder ('$username' / '$password') in
        // its system prompt's login goal; we expand to real creds only at
        // the moment of typing into the page. Recipe records placeholder.
        const requested = action.text;
        const isUsernamePh = requested === '$username';
        const isPasswordPh = requested === '$password';
        const value = isUsernamePh
          ? creds.username
          : isPasswordPh
            ? creds.password
            : requested;
        let recorded: '$username' | '$password' | string = isUsernamePh
          ? '$username'
          : isPasswordPh
            ? '$password'
            : requested;
        // Defensive: if agent typed literal creds (echoed from prior context),
        // still record as placeholder.
        if (!isUsernamePh && !isPasswordPh) {
          if (value === creds.username) recorded = '$username';
          if (value === creds.password) recorded = '$password';
        }
        await page.keyboard.type(value);
        return {
          output: `Typed ${isPasswordPh || value === creds.password ? '<password>' : value}.`,
          recordedStep: { kind: 'type_text', value: recorded },
        };
      }

      case 'key': {
        const normalized = normalizeKey(action.text);
        try {
          await page.keyboard.press(normalized);
          return {
            output: `Pressed ${normalized}.`,
            recordedStep: { kind: 'press_key', key: normalized },
          };
        } catch (err) {
          return {
            output: `Key "${action.text}" was rejected: ${(err as Error).message}.`,
            isError: true,
          };
        }
      }

      case 'hold_key': {
        // Anthropic's hold_key holds a key for `duration` seconds.
        // Playwright doesn't have a direct equivalent; do it via mouseDown-style:
        // press the key down, wait, release. For multi-key chords use `key`.
        const normalized = normalizeKey(action.text);
        try {
          await page.keyboard.down(normalized);
          await page.waitForTimeout(Math.max(0, Math.min(action.duration, 10)) * 1000);
          await page.keyboard.up(normalized);
          return {
            output: `Held ${normalized} for ${action.duration}s.`,
          };
        } catch (err) {
          return {
            output: `hold_key "${action.text}" failed: ${(err as Error).message}.`,
            isError: true,
          };
        }
      }

      case 'scroll': {
        const [x, y] = action.coordinate;
        const dir = action.scroll_direction;
        const amt = action.scroll_amount || 3;
        // Anthropic's scroll_amount is in "clicks". A typical mouse wheel
        // click = ~120 deltaY units. Multiply for Playwright.
        const delta = amt * 120;
        const [dx, dy] =
          dir === 'down'  ? [0,  delta] :
          dir === 'up'    ? [0, -delta] :
          dir === 'right' ? [ delta, 0] :
                            [-delta, 0];
        await page.mouse.move(x, y);
        await page.mouse.wheel(dx, dy);
        return { output: `Scrolled ${dir} by ${amt} clicks at (${x}, ${y}).` };
      }

      case 'wait': {
        // Clamp to 30s — agents that wait longer are usually stuck.
        const dur = Math.max(0, Math.min(action.duration, 30));
        await page.waitForTimeout(dur * 1000);
        return { output: `Waited ${dur}s.` };
      }

      case 'cursor_position': {
        // Playwright doesn't expose cursor position directly. Return a
        // sensible default and document — agents rarely need this and we
        // can stub it.
        return { output: 'Cursor position: (0, 0). (Not tracked in headless mode.)' };
      }

      default: {
        const exhaustive: never = action;
        return {
          output: `Unknown vision action: ${JSON.stringify(exhaustive)}`,
          isError: true,
        };
      }
    }
  } catch (err) {
    log.warn('executeVisionAction: caught error', {
      action: action.action,
      message: (err as Error).message,
    });
    return {
      output: `Action ${action.action} threw: ${(err as Error).message}`,
      isError: true,
    };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Privacy hardening (P1-4): blank password inputs + tagged sensitive
 * elements BEFORE every screenshot. Keeps creds + PII out of Anthropic /
 * realtime / DB.
 *
 * Best-effort: if page.evaluate throws (e.g. cross-origin iframe), we
 * proceed with the unmodified screenshot — the system prompt's untrusted-
 * content boundary still applies. Logged as a warning so we notice if a
 * PMS has a structural reason this fails consistently.
 */
/**
 * Plan v8 review P0-B fix: VISUAL-ONLY masking. Earlier version mutated
 * `input.value = '••••••'`, which corrupted the real password if a
 * screenshot fired between type + submit (login would fail with the
 * masked string). Now we only paint the field opaque — the underlying
 * value is untouched.
 *
 * Strategy: position:relative + an absolute black overlay that exactly
 * covers each sensitive element. Overlays are removed by a cleanup pass
 * the caller MUST invoke after page.screenshot returns. We use a
 * data-attribute marker to find and remove them without affecting
 * unrelated DOM.
 */
async function hardenScreenshotPrivacy(page: Page): Promise<void> {
  try {
    await page.evaluate(() => {
      const SELECTOR = 'input[type="password"], [data-sensitive], .ssn, .credit-card';
      document.querySelectorAll(SELECTOR).forEach((el) => {
        const h = el as HTMLElement;
        const rect = h.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        const overlay = document.createElement('div');
        overlay.dataset.staxisPrivacyOverlay = '1';
        overlay.style.position = 'fixed';
        overlay.style.left = `${rect.left}px`;
        overlay.style.top = `${rect.top}px`;
        overlay.style.width = `${rect.width}px`;
        overlay.style.height = `${rect.height}px`;
        overlay.style.background = '#000';
        overlay.style.zIndex = '2147483647';
        overlay.style.pointerEvents = 'none';
        document.body.appendChild(overlay);
      });
    });
  } catch (err) {
    log.warn('hardenScreenshotPrivacy: overlay-add evaluate failed', {
      message: (err as Error).message,
    });
  }
}

/**
 * Companion to hardenScreenshotPrivacy: remove the overlays we added
 * just before the screenshot. Always call in a try/finally around the
 * screenshot to ensure no stale overlays linger if screenshot throws.
 */
async function clearScreenshotPrivacyOverlays(page: Page): Promise<void> {
  try {
    await page.evaluate(() => {
      document.querySelectorAll('[data-staxis-privacy-overlay]').forEach((el) => el.remove());
    });
  } catch (err) {
    log.warn('clearScreenshotPrivacyOverlays: evaluate failed', {
      message: (err as Error).message,
    });
  }
}

/**
 * Normalize a key-name to Playwright's expected format. Mirrors the
 * existing helper in browser-tool.ts so vision-mode behavior matches
 * DOM-mode behavior. Kept inline to avoid cross-file coupling.
 */
function normalizeKey(input: string): string {
  // Strip whitespace, normalize separators, capitalize first letter of
  // each token (Playwright keys are "Control+A", "Enter", "Escape").
  const tokens = input.trim().replace(/\s+/g, '').split(/[+\-]/);
  const capitalized = tokens.map(t => {
    const lower = t.toLowerCase();
    // Common aliases.
    if (lower === 'ctrl' || lower === 'control') return 'Control';
    if (lower === 'cmd' || lower === 'command' || lower === 'meta') return 'Meta';
    if (lower === 'opt' || lower === 'option' || lower === 'alt') return 'Alt';
    if (lower === 'esc') return 'Escape';
    if (lower === 'return') return 'Enter';
    if (lower.length === 1) return lower;  // single letters stay lowercase
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  });
  return capitalized.join('+');
}

// Plan v8 review P1-A: mapToPolicyAction + BrowserActionAlias were used
// to bridge vision actions through policy.ts. Vision mode now bypasses
// policy.ts entirely (see executeVisionAction comment) so this helper
// is no longer called and was deleted.
