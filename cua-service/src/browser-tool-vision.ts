/**
 * Vision-based computer-use tool — the only mapping tool as of Plan v8 D.2.
 *
 * Wraps Anthropic's official `computer_20251124` beta tool to drive a
 * Playwright Chromium browser. Agent receives SCREENSHOTS (PNG), clicks
 * by PIXEL COORDINATES, and recipe steps record as `{kind: 'click_at'}`
 * / `{kind: 'type_text'}` / `{kind: 'press_key'}` for deterministic
 * replay.
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
 * Privacy hardening (P1-4): before EVERY screenshot, paint a black
 * overlay across `input[type="password"]`, `[data-sensitive]`, `.ssn`,
 * `.credit-card`. Keeps passwords + PII out of the Anthropic conversation
 * history, the realtime broadcast channel, and the help-request DB row.
 *
 * Navigation: no `navigate` action in the vision tool. The agent navigates
 * by clicking visible menu links / typing into input fields.
 * `mapping-driver.ts` pre-positions the page via `safeGoto` BEFORE the
 * agent's per-target loop starts. `page.url()` is read between turns to
 * record `{kind: 'goto', url}` steps for replay.
 *
 * Read-only invariant is enforced by (a) the system prompt's "Read-only"
 * rule, and (b) the sandboxed Playwright browser context — no broader
 * filesystem / OS / network capability than what page.mouse + page.keyboard
 * + page.screenshot provide.
 */

import type { Page } from 'playwright';
import type { PMSCredentials, RecipeStep } from './types.js';
import { log } from './log.js';
import { applySetOfMark, clearSetOfMark, type BadgeInfo } from './set-of-mark.js';

/**
 * Mapping phase — passed through for logging. The DOM-mode-era
 * policy.ts allow/deny layer was deleted along with the DOM tool;
 * the read-only invariant is enforced by the system prompt and by
 * the fact that the vision tool only ever produces coordinate clicks
 * + keystrokes against a sandboxed Playwright browser. Phase is kept
 * as a typed argument for log breadcrumbs only.
 */
export type MappingPhase = 'login' | 'action';

// ─── Set-of-Mark badge store ─────────────────────────────────────────────
//
// Each screenshot draws numbered badges on every clickable element so the
// agent can request `left_click` with `text: "#N"` instead of guessing a
// pixel coordinate. The map from badge ID → BadgeInfo is stashed per-page
// here, so the next `left_click` action can resolve `#N` to the badge's
// center coordinate (and pick up its ARIA role+name for selector fallback).
//
// WeakMap so closing a page auto-frees the map — we never need to clean
// up stale entries across navigations on our own. The badge DOM itself is
// removed at the start of every non-screenshot action (see executeVisionAction).
const setOfMarkStore = new WeakMap<Page, Map<number, BadgeInfo>>();

/**
 * Resolve a `#N` token from the action's text payload to a badge-center
 * coordinate AND the badge's role+name (if any). Returns `null` if the
 * token doesn't match a known badge — caller falls back to the original
 * pixel coordinate.
 *
 * Exported for tests; not part of the public action surface.
 */
export function resolveBadgeReference(
  page: Page,
  badgeText: string | undefined,
): { x: number; y: number; roleName?: { role: string; name: string } } | null {
  if (!badgeText) return null;
  const match = /^#(\d+)$/.exec(badgeText.trim());
  if (!match) return null;
  const id = parseInt(match[1]!, 10);
  const badges = setOfMarkStore.get(page);
  if (!badges) return null;
  const badge = badges.get(id);
  if (!badge) return null;
  const roleName =
    badge.role && badge.name ? { role: badge.role, name: badge.name } : undefined;
  return { x: badge.x, y: badge.y, ...(roleName ? { roleName } : {}) };
}

/**
 * For an unmarked coordinate click, peek at the element under (x, y) and
 * extract its ARIA role + accessible name. This lets the replay path try
 * Playwright's `getByRole` before falling back to raw coordinates, which
 * survives PMS UI rewrites that move the element to a new pixel position.
 *
 * Best-effort: returns undefined if the element isn't reachable or
 * doesn't have a meaningful name. Don't throw — vision-mode clicks are
 * already coordinate-grounded and don't NEED roleName to succeed.
 */
async function extractRoleNameAtPoint(
  page: Page,
  x: number,
  y: number,
): Promise<{ role: string; name: string } | undefined> {
  try {
    // NOTE: page.evaluate body is inline-only — see set-of-mark.ts for the
    // `__name is not defined` esbuild gotcha we worked around there.
    const result = await page.evaluate(
      ({ cx, cy }) => {
        const stack = document.elementsFromPoint(cx, cy);
        let el: Element | null = null;
        for (const e of stack) {
          if (!(e as HTMLElement).dataset.staxisSomBadge) {
            el = e;
            break;
          }
        }
        if (!el) return null;

        // Walk up to find a sensible click target (button, link, [role], etc.).
        let target: Element | null = el;
        for (let i = 0; i < 6 && target; i++) {
          const tag = target.tagName.toLowerCase();
          const isTarget =
            tag === 'a' ||
            tag === 'button' ||
            tag === 'input' ||
            tag === 'select' ||
            tag === 'textarea' ||
            target.hasAttribute('role') ||
            target.hasAttribute('onclick') ||
            (target.getAttribute('tabindex') !== null &&
              target.getAttribute('tabindex') !== '-1');
          if (isTarget) break;
          target = target.parentElement;
        }
        if (!target) target = el;

        // Role: explicit attr or tag-derived.
        let role: string | null = target.getAttribute('role');
        if (!role) {
          const tag = target.tagName.toLowerCase();
          if (tag === 'a' && target.hasAttribute('href')) role = 'link';
          else if (tag === 'button') role = 'button';
          else if (tag === 'input') {
            const type = (target as HTMLInputElement).type || 'text';
            if (type === 'checkbox') role = 'checkbox';
            else if (type === 'radio') role = 'radio';
            else if (type === 'submit' || type === 'button') role = 'button';
            else role = 'textbox';
          } else if (tag === 'select') role = 'combobox';
          else if (tag === 'textarea') role = 'textbox';
        }
        if (!role) return null;

        // Name: aria-label > text > placeholder > title.
        let name: string | null = null;
        const aria = target.getAttribute('aria-label');
        if (aria && aria.trim()) name = aria.trim();
        if (!name) {
          const t = (target.textContent || '').replace(/\s+/g, ' ').trim();
          if (t) name = t.slice(0, 80);
        }
        if (!name) {
          const ph = target.getAttribute('placeholder');
          if (ph && ph.trim()) name = ph.trim();
        }
        if (!name) {
          const tt = target.getAttribute('title');
          if (tt && tt.trim()) name = tt.trim();
        }
        if (!name) return null;
        return { role, name };
      },
      { cx: x, cy: y },
    );
    return result ? { role: result.role, name: result.name } : undefined;
  } catch (err) {
    log.warn('extractRoleNameAtPoint: evaluate failed', {
      message: (err as Error).message,
    });
    return undefined;
  }
}

// ─── Anthropic computer_20251124 tool param ──────────────────────────────

/**
 * Pass this in `messages.create({tools: [VISION_TOOL_PARAM, ...]})`.
 * Anthropic's SDK type doesn't yet know about computer_20251124 as a
 * literal; cast at the call site with `as unknown as Tool`.
 *
 * Display dimensions match the viewport mapping-driver opens — keep
 * these in sync with `cua-service/src/mapper.ts`'s `VIEWPORT` constant.
 *
 * enable_zoom: true (Anthropic best-practices for computer/browser use,
 * https://claude.com/blog/best-practices-for-computer-and-browser-use-
 * with-claude) — lets the model crop and re-inspect a tight region of
 * the screenshot at higher effective resolution before committing to a
 * click. Useful on dense PMS UIs where small buttons / dropdown arrows
 * are easy to mis-target at the base 1280×800 resolution. Supported on
 * Claude 4.6 + 4.7 — both models we use in vision mode.
 */
export const VISION_TOOL_PARAM = {
  type: 'computer_20251124',
  name: 'computer',
  display_width_px: 1280,
  display_height_px: 800,
  display_number: 1,
  enable_zoom: true,
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
    // Log every action for ops visibility. The read-only invariant is
    // enforced by the system prompt + the sandboxed Playwright context
    // (Plan v8 D.2 deleted the DOM-era policy.ts allow/deny layer; vision
    // actions don't carry element-attribute hints to gate on anyway).
    log.info('vision-action', { phase, action: action.action });

    // Set-of-Mark cleanup. Badges from the previous screenshot are
    // pointer-events:none so they don't block clicks, but we still
    // remove them at the start of every non-screenshot action so the
    // page DOM doesn't slowly accumulate stale badges across an entire
    // mapping run (defense-in-depth in case a future PMS overrides our
    // pointer-events). For `screenshot` we leave the prior badges alone
    // here — the screenshot handler does a fresh clear+apply itself.
    if (action.action !== 'screenshot') {
      await clearSetOfMark(page);
    }

    switch (action.action) {
      case 'screenshot': {
        // Set-of-Mark visual grounding (Plan v9 F1): draw numbered badges
        // on every clickable element BEFORE the privacy overlay + screenshot,
        // stash the badge map so the next left_click can resolve `#N`.
        //
        // Order matters:
        //   1. Clear any leftover SoM badges from a prior screenshot.
        //   2. Apply SoM — captures the badge map, paints the page.
        //   3. Apply privacy hardening — its overlays sit above SoM badges
        //      (z-index 2147483647 vs SoM's 2147483646) so passwords stay
        //      blanked even if a SoM badge happens to overlap a sensitive
        //      input.
        //   4. Take the screenshot.
        //   5. ALWAYS remove privacy overlays in finally. SoM badges are
        //      removed at the start of the next non-screenshot action
        //      (see top of executeVisionAction) — leaving them visible in
        //      the agent's last screenshot is the WHOLE POINT of SoM, so
        //      we deliberately do NOT clear them here.
        await clearSetOfMark(page);
        const badges = await applySetOfMark(page);
        setOfMarkStore.set(page, badges);
        await hardenScreenshotPrivacy(page);
        try {
          const buf = await page.screenshot({ fullPage: false });
          return {
            output:
              badges.size > 0
                ? `Screenshot captured. Set-of-Mark applied: ${badges.size} clickable element(s) labeled with numbered badges. ` +
                  `Click a badge by sending {action: "left_click", coordinate: [x, y], text: "#N"} where N is the badge number.`
                : 'Screenshot captured. (No clickable elements detected for Set-of-Mark — click by pixel coordinate as usual.)',
            screenshotB64: buf.toString('base64'),
          };
        } finally {
          await clearScreenshotPrivacyOverlays(page);
        }
      }

      case 'left_click': {
        // Set-of-Mark resolution (Plan v9 F1): if the agent passed
        // `text: "#N"`, resolve to the badge's center coordinate AND pick
        // up its ARIA role + accessible name so the recipe step can later
        // try Playwright's getByRole during replay (tier 1 of the
        // selector fallback chain). The Coordinate it sent is ignored
        // when the badge resolves, since visual targeting via SoM is
        // strictly more accurate than visual targeting via pixel guess.
        const resolved = resolveBadgeReference(page, action.text);
        const [rawX, rawY] = action.coordinate;
        const x = resolved?.x ?? rawX;
        const y = resolved?.y ?? rawY;
        // Capture role+name BEFORE the click — the click may navigate
        // away and the element will be gone afterward. Prefer the badge's
        // own roleName (we already extracted it during applySetOfMark);
        // fall back to a fresh elementsFromPoint lookup if the agent
        // clicked by raw coordinate.
        const roleName = resolved?.roleName ?? (await extractRoleNameAtPoint(page, x, y));
        await page.mouse.click(x, y);
        const step: RecipeStep = roleName
          ? { kind: 'click_at', x, y, roleName }
          : { kind: 'click_at', x, y };
        const tag = resolved
          ? ` (via badge ${action.text})`
          : '';
        return {
          output: `Left-clicked at (${x}, ${y})${tag}.`,
          recordedStep: step,
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
