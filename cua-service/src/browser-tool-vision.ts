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
 * Privacy hardening: every screenshot goes through
 * `captureHardenedScreenshot` (./screenshot-privacy.ts), which uses
 * Playwright's native masking to black out `input[type="password"]`,
 * `[data-sensitive]`, `.ssn`, `.credit-card` in EVERY frame as part of the
 * capture itself (so there is no unmasked window), retries-after-settle on a
 * navigation race, and WITHHOLDS the frame entirely if it can't produce a
 * masked image — so passwords + credential PII never reach the Anthropic
 * conversation history, the realtime broadcast channel, or the help-request DB
 * row. Guest names/emails in ordinary table text are intentionally NOT masked
 * (the agent must read tables to learn columns) — see screenshot-privacy.ts.
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
import { applySetOfMark, clearSetOfMark, applyHeaderMark, clearHeaderMark, type BadgeInfo, type HeaderMarkInfo } from './set-of-mark.js';
import { captureHardenedScreenshot } from './screenshot-privacy.js';

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
// feature/cua-semantic-columns — header marks captured on the last screenshot
// (column-mapping phase only). Kept for parity with the clickable badge store;
// lets a future "click header H<n>" action resolve a header coordinate.
const headerMarkStore = new WeakMap<Page, Map<number, HeaderMarkInfo>>();

// ─── Viewport-drift guard ────────────────────────────────────────────────
//
// Every click coordinate the model picks is grounded in a screenshot taken
// at the DECLARED display size (VISION_TOOL_PARAM.display_{width,height}_px,
// 1280×800 — kept in sync with mapper.ts's VIEWPORT). If the real Playwright
// viewport ever differs from that declared size, the model is targeting one
// coordinate space while the page lives in another and EVERY click lands in
// the wrong place. We assert the two agree exactly once per page (first
// action), so a drift surfaces loudly at startup instead of as a baffling
// run of mis-clicks.
//
// WeakSet so the "already checked" flag is freed when the page is GC'd; a
// fresh page (new mapping run) re-asserts.
const viewportAssertedPages = new WeakSet<Page>();

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

/**
 * Stale-badge guard (robustness fix): a Set-of-Mark badge's coordinate is
 * captured at screenshot time. By the time the agent's `left_click {#N}`
 * arrives, the page may have scrolled, re-laid-out, or popped a dialog —
 * so the stored (x, y) can now sit over a DIFFERENT element, producing a
 * silent wrong-element click.
 *
 * Just before clicking a resolved badge, re-run elementsFromPoint at the
 * stored coordinate and confirm the topmost non-badge element still has
 * the badge's recorded role + accessible name. Returns:
 *   - `true`  → element under the coord still matches; safe to click.
 *   - `false` → drifted; caller returns isError so the model re-screenshots.
 *
 * Best-effort on the EVALUATE itself (cross-origin / mid-navigation): if
 * the lookup throws we return `true` (don't block a click on an infra
 * hiccup — the worst case degrades to the pre-fix behavior, which is the
 * coordinate click we'd have made anyway). A clean "no element / no role /
 * no name" result is a genuine MISMATCH and returns `false`.
 */
async function badgeStillMatchesAtPoint(
  page: Page,
  x: number,
  y: number,
  expected: { role: string; name: string },
): Promise<boolean> {
  let current: { role: string; name: string } | undefined;
  try {
    // Reuse the exact same role+name extraction the badge was recorded
    // with (applySetOfMark / extractRoleNameAtPoint share this logic), so
    // a match comparison is apples-to-apples.
    current = await extractRoleNameAtPoint(page, x, y);
  } catch (err) {
    log.warn('badgeStillMatchesAtPoint: lookup threw — allowing click', {
      message: (err as Error).message,
    });
    return true;
  }
  if (!current) {
    // Nothing identifiable under the stored coordinate now — treat as drift.
    return false;
  }
  // Names can be long visible-text blobs that get truncated differently
  // (80 vs 79+… ). Compare on a normalized prefix so a benign truncation
  // boundary difference doesn't read as drift, while a real label change
  // still does.
  const norm = (s: string) => s.replace(/[…]+$/, '').trim().slice(0, 60);
  return current.role === expected.role && norm(current.name) === norm(expected.name);
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

/**
 * Viewport-drift guard (robustness fix): read the live Playwright viewport
 * once and assert it matches the display size we DECLARE to the model
 * (VISION_TOOL_PARAM.display_{width,height}_px). A mismatch means the
 * model's coordinate space and the page's coordinate space disagree, so
 * every coordinate click lands in the wrong place — far better to fail
 * loudly here than to ship a run of silently-wrong clicks.
 *
 * Runs at most once per page (guarded by `viewportAssertedPages`). We
 * THROW on a hard mismatch so the surrounding executeVisionAction try/catch
 * converts it into an isError tool result the model sees immediately;
 * `viewportSize()` returning null (rare — only for non-emulated contexts)
 * is logged but not fatal, since then there's no declared box to compare.
 */
function assertViewportMatchesDisplay(page: Page): void {
  if (viewportAssertedPages.has(page)) return;
  viewportAssertedPages.add(page);
  const vp = page.viewportSize();
  const declaredW = VISION_TOOL_PARAM.display_width_px;
  const declaredH = VISION_TOOL_PARAM.display_height_px;
  if (!vp) {
    log.warn('viewport-drift-check: page.viewportSize() is null — skipping assert', {
      declaredW,
      declaredH,
    });
    return;
  }
  if (vp.width !== declaredW || vp.height !== declaredH) {
    log.error('viewport-drift: Playwright viewport != declared display size', {
      actualWidth: vp.width,
      actualHeight: vp.height,
      declaredWidth: declaredW,
      declaredHeight: declaredH,
    });
    throw new Error(
      `Viewport drift: Playwright viewport is ${vp.width}x${vp.height} but the ` +
        `computer tool declares ${declaredW}x${declaredH} to the model — every click ` +
        `coordinate would be off. Open the browser context with viewport ` +
        `${declaredW}x${declaredH} (see mapper.ts VIEWPORT).`,
    );
  }
}

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
  /** Per-call secrets beyond the login credentials. `authCode` powers the
   *  `$auth_code` placeholder during 2FA resolution — substituted at type
   *  time so the one-time digits never enter the Claude conversation. */
  extras?: { authCode?: string | null },
): Promise<VisionActionResult> {
  try {
    // Log every action for ops visibility. The read-only invariant is
    // enforced by the system prompt + the sandboxed Playwright context
    // (Plan v8 D.2 deleted the DOM-era policy.ts allow/deny layer; vision
    // actions don't carry element-attribute hints to gate on anyway).
    log.info('vision-action', { phase, action: action.action });

    // Viewport-drift guard: on the first action against this page, assert
    // the live Playwright viewport equals the display size we declare to
    // the model. A mismatch throws (caught below → isError result) so a
    // misconfigured context fails loudly instead of mis-landing every click.
    assertViewportMatchesDisplay(page);

    // Set-of-Mark cleanup. Badges from the previous screenshot are
    // pointer-events:none so they don't block clicks, but we still
    // remove them at the start of every non-screenshot action so the
    // page DOM doesn't slowly accumulate stale badges across an entire
    // mapping run (defense-in-depth in case a future PMS overrides our
    // pointer-events). For `screenshot` we leave the prior badges alone
    // here — the screenshot handler does a fresh clear+apply itself.
    if (action.action !== 'screenshot') {
      await clearSetOfMark(page);
      await clearHeaderMark(page);
    }

    switch (action.action) {
      case 'screenshot': {
        // Set-of-Mark visual grounding (Plan v9 F1): draw numbered badges
        // on every clickable element BEFORE the screenshot, stash the badge
        // map so the next left_click can resolve `#N`.
        //
        // Order matters:
        //   1. Clear any leftover SoM badges from a prior screenshot.
        //   2. Apply SoM — captures the badge map, paints the page.
        //   3. captureHardenedScreenshot takes the screenshot with Playwright's
        //      native mask, blacking out every credential/SSN/CC field (all
        //      frames) directly on the output image — drawn over everything,
        //      so a SoM badge overlapping a sensitive input is covered too.
        //      SoM badges (separate DOM, not sensitive) are deliberately left
        //      for the agent's next screenshot.
        //   4. If it returns null, a reliably-masked image couldn't be produced
        //      (e.g. the page was mid-navigation): withhold the frame — send NO
        //      image — and tell the agent to retry, rather than risk leaking an
        //      unredacted screenshot to Claude.
        await clearSetOfMark(page);
        await clearHeaderMark(page);
        const badges = await applySetOfMark(page);
        setOfMarkStore.set(page, badges);
        // feature/cua-semantic-columns — column-mapping aid: badge the data
        // table's column HEADERS ("H<n>") so the model maps each field to a
        // column by HEADER MEANING. Gated to the 'action' (mapping) phase —
        // never during login — and intrinsically empty on non-table pages
        // (applyHeaderMark returns {} without a qualifying data table), so
        // navigation/dashboard screenshots aren't cluttered.
        let headerMarks: Map<number, HeaderMarkInfo> = new Map();
        if (phase === 'action') {
          headerMarks = await applyHeaderMark(page);
          headerMarkStore.set(page, headerMarks);
        }
        const buf = await captureHardenedScreenshot(page);
        if (!buf) {
          return {
            output:
              'Screenshot withheld: the page was still navigating and sensitive ' +
              'fields could not be reliably masked, so no image was captured. ' +
              'Wait briefly, then take another screenshot.',
            isError: true,
          };
        }
        const headerNote =
          headerMarks.size > 0
            ? ` Column headers labeled with ${headerMarks.size} "H<n>" badge(s): map each required field to a column by its HEADER MEANING, then write that column's selector as td:nth-child(N) for its position N.`
            : '';
        return {
          output:
            (badges.size > 0
              ? `Screenshot captured. Set-of-Mark applied: ${badges.size} clickable element(s) labeled with numbered badges. ` +
                `Click a badge by sending {action: "left_click", coordinate: [x, y], text: "#N"} where N is the badge number.`
              : 'Screenshot captured. (No clickable elements detected for Set-of-Mark — click by pixel coordinate as usual.)') +
            headerNote,
          screenshotB64: buf.toString('base64'),
        };
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
        // Stale-badge guard: a badge's coordinate is from screenshot time and
        // can be stale by now (scroll / layout shift / dialog). If we resolved
        // a badge that carried a role+name, re-verify JUST-IN-TIME that the
        // element still sitting under the stored coordinate matches before we
        // click — otherwise we'd silently click whatever drifted into that
        // spot. On mismatch, bail with isError so the model re-screenshots
        // (which redraws fresh badges at fresh coordinates) instead of
        // clicking blind. Raw-coordinate clicks are the model's own live
        // visual targeting, so they don't get (or need) this guard.
        if (resolved?.roleName) {
          const stillMatches = await badgeStillMatchesAtPoint(
            page,
            x,
            y,
            resolved.roleName,
          );
          if (!stillMatches) {
            log.warn('left_click: stale Set-of-Mark badge — refusing blind click', {
              badge: action.text,
              x,
              y,
              expectedRole: resolved.roleName.role,
              expectedName: resolved.roleName.name,
            });
            return {
              output:
                `Badge ${action.text} is stale — the element at its recorded position ` +
                `(${x}, ${y}) no longer matches the "${resolved.roleName.role}" labeled ` +
                `"${resolved.roleName.name}" (the page likely scrolled, re-laid-out, or ` +
                `opened a dialog since the last screenshot). Did NOT click to avoid hitting ` +
                `the wrong element. Take a fresh screenshot and click the up-to-date badge.`,
              isError: true,
            };
          }
        }
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
        // The agent sees the placeholder ('$username' / '$password' /
        // '$auth_code') in its goal message; we expand to the real value
        // only at the moment of typing into the page. Recipe records the
        // placeholder. '$auth_code' is the one-time 2FA code fetched by the
        // mapper (mapper.ts acquireMfaCode) — it's only live while a 2FA
        // resolution is in flight; outside that window the literal string
        // is typed (and the agent is never told about it).
        const requested = action.text;
        const isUsernamePh = requested === '$username';
        const isPasswordPh = requested === '$password';
        const authCode = extras?.authCode ?? null;
        const isAuthCodePh = requested === '$auth_code' && authCode !== null;
        const value = isUsernamePh
          ? creds.username
          : isPasswordPh
            ? creds.password
            : isAuthCodePh
              ? authCode
              : requested;
        let recorded: '$username' | '$password' | '$auth_code' | string = isUsernamePh
          ? '$username'
          : isPasswordPh
            ? '$password'
            : isAuthCodePh
              ? '$auth_code'
              : requested;
        // Defensive: if agent typed literal secrets (echoed from prior
        // context), still record as placeholder.
        if (!isUsernamePh && !isPasswordPh && !isAuthCodePh) {
          if (value === creds.username) recorded = '$username';
          if (value === creds.password) recorded = '$password';
          if (authCode !== null && value === authCode) recorded = '$auth_code';
        }
        await page.keyboard.type(value);
        const masked = isPasswordPh || value === creds.password
          ? '<password>'
          : recorded === '$auth_code'
            ? '<verification code>'
            : value;
        return {
          output: `Typed ${masked}.`,
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

// Screenshot privacy redaction — painting sensitive-field overlays, GATING
// the capture on verified coverage (every frame), retry-after-settle, and
// withholding the frame on failure — now lives in ./screenshot-privacy.ts as
// `captureHardenedScreenshot`, the single source shared by the screenshot
// action, the critic, and the help-card snapshot. The old swallow-and-proceed
// `hardenScreenshotPrivacy` was removed: it let an unredacted frame through
// whenever the overlay-add lost a race with a navigation.

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
