/**
 * Set-of-Mark visual grounding for vision-mode mapping.
 *
 * Overlays numbered badges on clickable elements before each screenshot so
 * the agent can reference targets by ID (`#7`) rather than guessing pixel
 * coordinates from the rendered image. After applying SoM, the agent's
 * `left_click` action may pass `text: "#7"` to invoke the badge map and
 * the runtime resolves to the badge's center coordinate.
 *
 * Reference: "Set-of-Mark Prompting Unleashes Extraordinary Visual
 * Grounding in GPT-4V" — arXiv 2310.11441. Same scaffolding used in
 * UGround, Aria-UI, and other SOTA browser agents.
 *
 * Design notes (Plan v9):
 * - Badges are absolutely positioned <div> nodes with `pointer-events: none`
 *   so they NEVER block a click reaching the underlying element even if
 *   they leak past `clearSetOfMark` (defense-in-depth — the caller is
 *   responsible for clearing, but we still want the page interactive if
 *   cleanup races a navigation).
 * - A very high z-index keeps badges above PMS chrome. Credential fields are
 *   redacted separately at capture time by screenshot-privacy.ts's Playwright
 *   mask (painted over the final image), so a badge overlapping a sensitive
 *   input is still covered — privacy wins regardless of badge z-index.
 * - `data-staxis-som-badge` attribute scopes our DOM mutations — we never
 *   touch unrelated elements during clear.
 * - We use `document.elementsFromPoint(cx, cy)` to filter elements that
 *   are actually visible (not covered by a modal / sticky header / etc.).
 *   This catches the common case where Choice Advantage's "session active"
 *   modal covers half the menu — only badge what the user could click.
 * - Badge color is high-contrast pink + white text. We deliberately
 *   chose a color that's unlikely to clash with PMS UI chrome (most use
 *   blue/gray/green corporate palettes). z-index 2147483646 sits above page
 *   chrome; the screenshot mask redacts credentials over the top of it.
 */

import type { Page } from 'playwright';
import { log } from './log.js';
import { SENSITIVE_FIELD_SELECTOR } from './screenshot-privacy.js';

/** Per-badge metadata stashed on the page-keyed WeakMap. */
export interface BadgeInfo {
  /** Center X of the underlying element (where a click should land). */
  x: number;
  /** Center Y of the underlying element. */
  y: number;
  /** Short text description — text content or aria-label, truncated to 80 chars. */
  description: string;
  /** ARIA role if any (button, link, textbox, etc.). Lets recipe steps
   *  fall back to Playwright's getByRole when CSS selectors break. */
  role?: string;
  /** Accessible name (label, aria-label, or visible text). */
  name?: string;
}

/** Selector unioned over things a human might consider "clickable". */
const CLICKABLE_SELECTOR = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="tab"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="option"]',
  '[onclick]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Adversarial review P1 — exclude privacy-sensitive inputs from SoM marking.
 *
 * Uses the SHARED `SENSITIVE_FIELD_SELECTOR` (./screenshot-privacy.ts) — the
 * exact list `captureHardenedScreenshot` masks (blacks out) in screenshots —
 * so the marking-exclusion list and the screenshot-redaction list can't drift.
 *
 * Why exclude them at the MARKING layer rather than just the visual layer:
 * even though the screenshot blacks out the field, the badge entry in
 * BadgeInfo still points at the input's center coordinate. An agent (or a
 * future prompt-
 * injection) requesting `left_click {text: "#N"}` for that badge would
 * focus the password field — at which point a `type` action could write
 * into it. Cleanest fix: never enroll the field in the badge map at all.
 */

/** Cap on badge count — past this point the screenshot turns into a
 *  numbered confetti pile and the agent struggles to read individual IDs.
 *  Most PMS pages have 30-80 clickables; 100 leaves headroom. */
const MAX_BADGES = 100;

/**
 * Walks the page, finds every visible clickable element, draws a small
 * numbered circle at the top-left of each one, and returns a map from
 * badge number → click target metadata.
 *
 * Best-effort: if `page.evaluate` throws (cross-origin iframe, page being
 * navigated, etc.) we return an empty map and log. The caller is expected
 * to fall back to pixel-coordinate clicking, which works just as well —
 * SoM is a reliability enhancement, not a hard dependency.
 */
export async function applySetOfMark(page: Page): Promise<Map<number, BadgeInfo>> {
  try {
    // NOTE: this function body runs inside the page — no closure references
    // to outer scope, no TypeScript syntax that requires runtime helpers
    // (e.g. esbuild's __name). We deliberately use only function expressions
    // and inline logic to avoid the `ReferenceError: __name is not defined`
    // failure that named arrow-function helpers cause inside page.evaluate.
    const raw = await page.evaluate(
      ({ selector, excludeSelector, maxBadges }) => {
        const elements = Array.from(document.querySelectorAll(selector));
        // Build a set of privacy-sensitive elements once; we skip these
        // during badge enrollment so a focused-then-typed-into password
        // field can't be triggered by a #N click.
        const privacyExclude = new Set<Element>(
          Array.from(document.querySelectorAll(excludeSelector)),
        );
        const out: Array<{
          id: number;
          x: number;
          y: number;
          description: string;
          role: string | null;
          name: string | null;
        }> = [];

        const seenCoords = new Set<string>();
        let nextId = 1;

        for (const el of elements) {
          if (out.length >= maxBadges) break;
          if (privacyExclude.has(el)) continue;
          // Also skip if any privacy-sensitive ancestor wraps this element.
          let walked: Element | null = el.parentElement;
          let isInsidePrivacy = false;
          for (let i = 0; i < 5 && walked; i++) {
            if (privacyExclude.has(walked)) {
              isInsidePrivacy = true;
              break;
            }
            walked = walked.parentElement;
          }
          if (isInsidePrivacy) continue;

          // ── Visibility + reachability check (inline) ────────────────────
          const rect = el.getBoundingClientRect();
          if (rect.width < 4 || rect.height < 4) continue;
          if (rect.bottom < 0 || rect.right < 0) continue;
          if (rect.top > window.innerHeight) continue;
          if (rect.left > window.innerWidth) continue;
          const style = window.getComputedStyle(el);
          if (style.visibility === 'hidden') continue;
          if (style.display === 'none') continue;
          if (parseFloat(style.opacity || '1') < 0.1) continue;
          const cx = Math.round(rect.left + rect.width / 2);
          const cy = Math.round(rect.top + rect.height / 2);
          if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) continue;
          const stack = document.elementsFromPoint(cx, cy);
          if (stack.length === 0) continue;
          let reachable = false;
          for (const e of stack) {
            if ((e as HTMLElement).dataset.staxisSomBadge) continue;
            if (e === el || el.contains(e) || e.contains(el)) {
              reachable = true;
            }
            break;
          }
          if (!reachable) continue;

          // ── Dedup by coord ──────────────────────────────────────────────
          const key = cx + ',' + cy;
          if (seenCoords.has(key)) continue;
          seenCoords.add(key);

          // ── Role inference (inline) ─────────────────────────────────────
          let role: string | null = el.getAttribute('role');
          if (!role) {
            const tag = el.tagName.toLowerCase();
            if (tag === 'a' && el.hasAttribute('href')) role = 'link';
            else if (tag === 'button') role = 'button';
            else if (tag === 'input') {
              const type = (el as HTMLInputElement).type || 'text';
              if (type === 'checkbox') role = 'checkbox';
              else if (type === 'radio') role = 'radio';
              else if (type === 'submit' || type === 'button') role = 'button';
              else role = 'textbox';
            } else if (tag === 'select') role = 'combobox';
            else if (tag === 'textarea') role = 'textbox';
          }

          // ── Accessible name (inline) ────────────────────────────────────
          let name: string | null = null;
          const aria = el.getAttribute('aria-label');
          if (aria && aria.trim()) {
            name = aria.trim();
          } else {
            const labelledBy = el.getAttribute('aria-labelledby');
            if (labelledBy) {
              const labelEl = document.getElementById(labelledBy);
              if (labelEl && labelEl.textContent && labelEl.textContent.trim()) {
                name = labelEl.textContent.trim();
              }
            }
            if (!name) {
              const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
              if (text) name = text;
            }
            if (!name) {
              const placeholder = el.getAttribute('placeholder');
              if (placeholder && placeholder.trim()) name = placeholder.trim();
            }
            if (!name) {
              const title = el.getAttribute('title');
              if (title && title.trim()) name = title.trim();
            }
            if (!name && el.id) {
              const lbl = document.querySelector<HTMLLabelElement>(
                'label[for="' + (window.CSS && window.CSS.escape ? window.CSS.escape(el.id) : el.id) + '"]'
              );
              if (lbl && lbl.textContent && lbl.textContent.trim()) {
                name = lbl.textContent.trim();
              }
            }
          }

          // Description: truncate the accessible name to 80 chars, else tag.
          const descRaw = name || el.tagName.toLowerCase();
          const description = descRaw.length > 80 ? descRaw.slice(0, 79) + '…' : descRaw;

          const id = nextId++;

          // ── Draw the badge ──────────────────────────────────────────────
          const badgeLeft = Math.max(0, Math.min(window.innerWidth - 22, rect.left));
          const badgeTop = Math.max(0, Math.min(window.innerHeight - 22, rect.top));
          const badge = document.createElement('div');
          badge.dataset.staxisSomBadge = String(id);
          badge.textContent = String(id);
          badge.style.position = 'fixed';
          badge.style.left = badgeLeft + 'px';
          badge.style.top = badgeTop + 'px';
          badge.style.minWidth = '20px';
          badge.style.height = '20px';
          badge.style.padding = '0 5px';
          badge.style.borderRadius = '10px';
          badge.style.background = '#FF1F8F';
          badge.style.color = '#FFFFFF';
          badge.style.fontFamily = 'system-ui, sans-serif';
          badge.style.fontSize = '12px';
          badge.style.fontWeight = '700';
          badge.style.lineHeight = '20px';
          badge.style.textAlign = 'center';
          badge.style.border = '1px solid #FFFFFF';
          badge.style.boxShadow = '0 1px 2px rgba(0,0,0,0.4)';
          badge.style.zIndex = '2147483646';  // above PMS chrome; screenshot mask redacts over it
          badge.style.pointerEvents = 'none';  // never block clicks reaching the underlying element
          badge.style.userSelect = 'none';
          document.body.appendChild(badge);

          out.push({ id, x: cx, y: cy, description, role, name });
        }

        return out;
      },
      {
        selector: CLICKABLE_SELECTOR,
        excludeSelector: SENSITIVE_FIELD_SELECTOR,
        maxBadges: MAX_BADGES,
      },
    );

    const map = new Map<number, BadgeInfo>();
    for (const b of raw) {
      map.set(b.id, {
        x: b.x,
        y: b.y,
        description: b.description,
        ...(b.role ? { role: b.role } : {}),
        ...(b.name ? { name: b.name } : {}),
      });
    }
    return map;
  } catch (err) {
    log.warn('applySetOfMark: evaluate failed', {
      message: (err as Error).message,
    });
    return new Map();
  }
}

/**
 * Remove every SoM badge from the page. Safe to call when no badges are
 * present — selector simply matches nothing.
 *
 * Always call this BEFORE any subsequent action (click, type, scroll)
 * even though badges set `pointer-events: none`. Defense-in-depth: a
 * future style override or a PMS that resets pointer-events might leak
 * the no-click guarantee, and we'd rather have an empty page than an
 * unclickable one.
 */
export async function clearSetOfMark(page: Page): Promise<void> {
  try {
    await page.evaluate(() => {
      document
        .querySelectorAll('[data-staxis-som-badge]')
        .forEach((el) => el.remove());
    });
  } catch (err) {
    log.warn('clearSetOfMark: evaluate failed', {
      message: (err as Error).message,
    });
  }
}

// ─── feature/cua-semantic-columns — HEADER Set-of-Mark ───────────────────────
//
// The clickable Set-of-Mark above grounds NAVIGATION. This second mark grounds
// COLUMN MAPPING: on a data-table page it badges each column HEADER with an
// "H<n>" tag so the mapper can map a required field to a column by its HEADER
// MEANING (then write `td:nth-child(N)` for that column's position) instead of
// eyeballing a pixel nth-child. Header anchoring is what lets the runtime
// re-find a column if the PMS later reorders/renames columns. Distinct data
// attribute + a blue, square badge (vs the clickable pink circle) and a lower
// z-index keep the two mark layers visually and structurally separate.

/** One header mark: which column, by meaning and by position. */
export interface HeaderMarkInfo {
  /** The "H<markId>" badge number. */
  markId: number;
  /** Visible header text (trimmed, ≤60 chars). Empty for icon-only headers. */
  headerText: string;
  /** 1-based position among the header cell's siblings (matches `td:nth-child(N)`). */
  columnIndex: number;
  /** 'columnheader' (th / role=columnheader) or 'cell' (header-less first-row cell). */
  role: string;
  /** Center coordinate of the header cell (for an optional future header click). */
  x: number;
  y: number;
}

/** Cap on header marks — even the widest PMS report rarely exceeds ~30 columns. */
const MAX_HEADER_MARKS = 40;

/**
 * Badge the column headers of the most prominent data table on the page (the
 * widest header set wins — a layout table with 1 cell never qualifies). Returns
 * a map markId → HeaderMarkInfo. Best-effort: an empty map on any failure OR
 * when the page has no qualifying data table (so non-table pages aren't
 * cluttered). Mirrors applySetOfMark's inline-only evaluate constraints (no
 * closures, no named helpers — the esbuild `__name` gotcha).
 */
export async function applyHeaderMark(page: Page): Promise<Map<number, HeaderMarkInfo>> {
  try {
    const raw = await page.evaluate(
      ({ maxMarks }) => {
        const out: Array<{
          id: number;
          headerText: string;
          columnIndex: number;
          role: string;
          x: number;
          y: number;
        }> = [];

        // Collect candidate header-cell sets from every table/grid, inline.
        const headerSets: Element[][] = [];
        for (const t of Array.from(document.querySelectorAll('table'))) {
          let cells = Array.from(t.querySelectorAll('thead th'));
          if (cells.length === 0) {
            const firstTr = t.querySelector('tr');
            if (firstTr) cells = Array.from(firstTr.querySelectorAll(':scope > th'));
          }
          if (cells.length === 0) {
            const bodyTr = t.querySelector('tbody tr') || t.querySelector('tr');
            if (bodyTr) cells = Array.from(bodyTr.querySelectorAll(':scope > td'));
          }
          if (cells.length >= 2) headerSets.push(cells);
        }
        for (const g of Array.from(document.querySelectorAll('[role="grid"], [role="table"], [role="treegrid"]'))) {
          let cells = Array.from(g.querySelectorAll('[role="columnheader"]'));
          if (cells.length === 0) {
            const firstRow = g.querySelector('[role="row"]');
            if (firstRow) cells = Array.from(firstRow.querySelectorAll('[role="cell"], [role="gridcell"]'));
          }
          if (cells.length >= 2) headerSets.push(cells);
        }

        // The widest header set is the data feed (not a 2-cell layout table).
        let best: Element[] | null = null;
        for (const set of headerSets) {
          if (!best || set.length > best.length) best = set;
        }
        if (!best) return out;

        let nextId = 1;
        for (const c of best) {
          if (out.length >= maxMarks) break;
          const rect = c.getBoundingClientRect();
          if (rect.width < 4 || rect.height < 4) continue;
          if (rect.bottom < 0 || rect.right < 0) continue;
          if (rect.top > window.innerHeight || rect.left > window.innerWidth) continue;
          const style = window.getComputedStyle(c);
          if (style.visibility === 'hidden' || style.display === 'none') continue;

          // 1-based element position among siblings (matches nth-child), inline.
          let columnIndex = -1;
          const parent = c.parentElement;
          if (parent) {
            let i = 0;
            for (const ch of Array.from(parent.children)) { i++; if (ch === c) { columnIndex = i; break; } }
          }

          const isHeaderRole =
            c.getAttribute('role') === 'columnheader' || c.tagName.toLowerCase() === 'th';
          const role = isHeaderRole ? 'columnheader' : 'cell';
          // Visible text, then accessible name (aria-label/title) for icon headers.
          let headerText = (c.textContent || '').replace(/\s+/g, ' ').trim();
          if (headerText === '') {
            const al = c.getAttribute('aria-label');
            if (al && al.trim()) headerText = al.replace(/\s+/g, ' ').trim();
          }
          if (headerText === '') {
            const ti = c.getAttribute('title');
            if (ti && ti.trim()) headerText = ti.replace(/\s+/g, ' ').trim();
          }
          headerText = headerText.slice(0, 60);
          const cx = Math.round(rect.left + Math.min(rect.width / 2, 40));
          const cy = Math.round(rect.top + rect.height / 2);
          const id = nextId++;

          const badge = document.createElement('div');
          badge.dataset.staxisHeaderMark = String(id);
          badge.textContent = 'H' + id;
          badge.style.position = 'fixed';
          badge.style.left = Math.max(0, Math.min(window.innerWidth - 30, rect.left)) + 'px';
          badge.style.top = Math.max(0, Math.min(window.innerHeight - 18, rect.top)) + 'px';
          badge.style.minWidth = '22px';
          badge.style.height = '16px';
          badge.style.padding = '0 4px';
          badge.style.borderRadius = '3px';
          badge.style.background = '#1F6FFF';
          badge.style.color = '#FFFFFF';
          badge.style.fontFamily = 'system-ui, sans-serif';
          badge.style.fontSize = '11px';
          badge.style.fontWeight = '700';
          badge.style.lineHeight = '16px';
          badge.style.textAlign = 'center';
          badge.style.border = '1px solid #FFFFFF';
          badge.style.boxShadow = '0 1px 2px rgba(0,0,0,0.4)';
          badge.style.zIndex = '2147483645';  // just below the clickable SoM layer
          badge.style.pointerEvents = 'none';  // never block a click
          badge.style.userSelect = 'none';
          document.body.appendChild(badge);

          out.push({ id, headerText, columnIndex, role, x: cx, y: cy });
        }
        return out;
      },
      { maxMarks: MAX_HEADER_MARKS },
    );

    const map = new Map<number, HeaderMarkInfo>();
    for (const m of raw) {
      map.set(m.id, {
        markId: m.id,
        headerText: m.headerText,
        columnIndex: m.columnIndex,
        role: m.role,
        x: m.x,
        y: m.y,
      });
    }
    return map;
  } catch (err) {
    log.warn('applyHeaderMark: evaluate failed', { message: (err as Error).message });
    return new Map();
  }
}

/** Remove every header mark. Safe when none are present. */
export async function clearHeaderMark(page: Page): Promise<void> {
  try {
    await page.evaluate(() => {
      document
        .querySelectorAll('[data-staxis-header-mark]')
        .forEach((el) => el.remove());
    });
  } catch (err) {
    log.warn('clearHeaderMark: evaluate failed', {
      message: (err as Error).message,
    });
  }
}
