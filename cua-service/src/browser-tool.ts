/**
 * Browser tool — DOM-aware Claude tool for navigating PMSes.
 *
 * Replaces the older pixel-coordinate `computer` tool with the action set
 * from Anthropic's `anthropic-quickstarts/browser-use-demo`. Key differences:
 *
 *   - Claude works against DOM element refs (ref_1, ref_2, …) emitted by
 *     `read_page`, NOT pixel coordinates. This survives layout / resize /
 *     PMS UI variants.
 *   - `read_page` returns the page's accessibility tree with refs.
 *   - `find` searches for elements by text/intent.
 *   - `form_input` sets input values directly (no click + type dance).
 *   - `get_page_text` extracts the visible text without OCR'ing a screenshot.
 *
 * The 4 .js files in browser-utils/ are copied verbatim from the upstream
 * demo (Apache-2.0). They install a `window.__claudeElementMap` weak-ref
 * map keyed by ref_N so each script can resolve a Claude-supplied ref to
 * a live DOM node.
 *
 * IMPORTANT — recipe-stable selectors:
 *   When Claude clicks ref_5, the executor:
 *     1. Resolves the ref via element.js → element info (id/class/text/coords).
 *     2. Generates a stable CSS selector for that element (id > data-testid >
 *        text > position) — refs are session-bound and cannot be replayed.
 *     3. Clicks via Playwright using the selector.
 *     4. Records { kind: 'click', selector } for the recipe-runner.
 *
 *   The mapper output is therefore a selector-based recipe replayable
 *   forever, even though the agent reasoned in refs.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import type { RecipeStep, PMSCredentials } from './types.js';
import { log } from './log.js';

// ─── Tool definition (Claude-facing) ─────────────────────────────────────

export const BROWSER_TOOL_NAME = 'browser' as const;

export const BROWSER_TOOL_DESCRIPTION =
  `A browser automation tool for web interaction. Use this tool to navigate websites, ` +
  `interact with elements, and extract content.\n\n` +
  `Key actions:\n` +
  `- navigate: Go to a URL (automatically includes a screenshot)\n` +
  `- screenshot: Take a visual screenshot\n` +
  `- read_page: Get DOM structure with element references (ref_1, ref_2, …)\n` +
  `- get_page_text: Extract all text content (use this instead of reading screenshots)\n` +
  `- left_click: Click — pass {ref: "ref_N"} from read_page (preferred) or {coordinate: [x,y]}\n` +
  `- type: Enter text at the current cursor (after clicking an input)\n` +
  `- key: Press a key combination (e.g. "Enter", "Tab", "ctrl+a")\n` +
  `- scroll: Scroll the page in a direction\n` +
  `- scroll_to: Scroll an element (by ref) into view\n` +
  `- form_input: Set the value of a form input directly — pass {ref, value}\n` +
  `- find: Search for elements by text/intent (returns matching refs)\n` +
  `- wait: Wait N seconds for a slow page`;
// 2026-05-12: `execute_js` was removed. A hostile PMS page could prompt-
// inject the agent to run exfiltration JavaScript inside the authenticated
// PMS session (read DOM, call fetch() to attacker-controlled endpoints).
// Codex audit flagged this as a high-severity sandbox escape. Use
// `find`, `read_page`, and `get_page_text` for any DOM exploration.

export const BROWSER_TOOL_INPUT_SCHEMA = {
  type: 'object',
  required: ['action'],
  properties: {
    action: {
      type: 'string',
      enum: [
        'navigate',
        'screenshot',
        'left_click',
        'double_click',
        'hover',
        'scroll',
        'scroll_to',
        'type',
        'key',
        'read_page',
        'find',
        'get_page_text',
        'wait',
        'form_input',
      ],
      description:
        'The action to perform. After navigate, always call read_page to get ' +
        'fresh element refs before clicking. Prefer ref over coordinate.',
    },
    text: {
      type: 'string',
      description:
        'Required for: navigate (URL), type (text), key (key combo), find (search query). ' +
        'Optional for read_page ("interactive" filter) or click (modifier keys held during click).',
    },
    ref: {
      type: 'string',
      description:
        'Element reference (e.g. ref_3) from read_page or find. Required for scroll_to ' +
        'and form_input. Optional alternative to coordinate for click and hover.',
    },
    coordinate: {
      type: 'array',
      items: { type: 'integer' },
      description:
        '[x, y] in viewport pixels. Used when ref is not available. Falls back to ' +
        'page.mouse for clicks.',
    },
    scroll_direction: {
      type: 'string',
      enum: ['up', 'down', 'left', 'right'],
    },
    scroll_amount: {
      type: 'integer',
      description: 'Number of scroll units (mouse-wheel-clicks).',
    },
    duration: {
      type: 'number',
      description: 'Seconds. Used by wait. Range: 0–100.',
    },
    value: {
      type: ['string', 'number', 'boolean'],
      description: 'Value for form_input. String for most inputs; boolean for checkboxes; number for numeric inputs.',
    },
  },
} as const;

export const BROWSER_TOOL_PARAM = {
  name: BROWSER_TOOL_NAME,
  description: BROWSER_TOOL_DESCRIPTION,
  input_schema: BROWSER_TOOL_INPUT_SCHEMA,
};

// ─── JS utility scripts (loaded once at module init) ─────────────────────

// __dirname is the CommonJS magic global for the directory of the current
// compiled file (dist/browser-tool.js at runtime). Our build script copies
// src/browser-utils → dist/browser-utils so this resolves at runtime.
const SCRIPTS_DIR = join(__dirname, 'browser-utils');

const DOM_SCRIPT = readFileSync(join(SCRIPTS_DIR, 'dom.js'), 'utf-8');
const ELEMENT_SCRIPT = readFileSync(join(SCRIPTS_DIR, 'element.js'), 'utf-8');
const FORM_INPUT_SCRIPT = readFileSync(join(SCRIPTS_DIR, 'form-input.js'), 'utf-8');
const TEXT_SCRIPT = readFileSync(join(SCRIPTS_DIR, 'text.js'), 'utf-8');

// ─── Action types ────────────────────────────────────────────────────────

export type BrowserAction =
  | { action: 'navigate'; text: string }
  | { action: 'screenshot' }
  | { action: 'left_click'; ref?: string; coordinate?: [number, number]; text?: string }
  | { action: 'double_click'; ref?: string; coordinate?: [number, number] }
  | { action: 'hover'; ref?: string; coordinate?: [number, number] }
  | { action: 'scroll'; coordinate?: [number, number]; scroll_direction?: 'up' | 'down' | 'left' | 'right'; scroll_amount?: number }
  | { action: 'scroll_to'; ref: string }
  | { action: 'type'; text: string }
  | { action: 'key'; text: string }
  | { action: 'read_page'; text?: string }
  | { action: 'find'; text: string }
  | { action: 'get_page_text' }
  | { action: 'wait'; duration?: number }
  | { action: 'form_input'; ref: string; value: string | number | boolean };

export interface BrowserActionResult {
  /** Text to send back as the tool_result body. */
  output: string;
  /** Optional screenshot to send alongside (base64 PNG). */
  screenshotB64?: string;
  /** Step to record in the recipe — if any. */
  recordedStep?: RecipeStep;
  /** True when the action errored; output contains the message. */
  isError?: boolean;
}

// ─── Public executor ─────────────────────────────────────────────────────

/**
 * Execute a browser tool action against a Playwright Page.
 *
 * `creds` is used to recognize when Claude types a credential — we redact
 * it from logs and substitute placeholders in recorded recipe steps so we
 * never persist secrets.
 */
export async function executeBrowserAction(
  page: Page,
  action: BrowserAction,
  creds: PMSCredentials,
): Promise<BrowserActionResult> {
  try {
    switch (action.action) {
      case 'navigate': {
        const url = normalizeUrl(action.text);
        // Domain guard — agent must stay on the PMS we're mapping. We
        // observed an agent navigating to a different PMS provider's
        // login page (beds24.com) when the in-domain navigation got
        // confusing. Hard-block off-domain navigates so the agent has
        // to recover with click/back/reload instead. (Bug fix
        // 2026-05-09 — CA canary v5.)
        const allowedHost = creds.loginUrl ? new URL(creds.loginUrl).host : null;
        if (allowedHost) {
          let targetHost: string;
          try {
            targetHost = new URL(url).host;
          } catch {
            return { output: `Refused to navigate to non-URL "${url}". Use a full URL or click a link instead.`, isError: true };
          }
          if (!hostsAreSameSite(targetHost, allowedHost)) {
            return {
              output:
                `Refused to navigate to ${targetHost}. You must stay on the ${allowedHost} domain ` +
                `(the PMS we're mapping). If you're stuck, use \`navigate\` with "back" or \`navigate\` ` +
                `to ${creds.loginUrl} to start fresh.`,
              isError: true,
            };
          }
        }
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.waitForTimeout(1500);
        const screenshot = await captureScreenshot(page);
        return {
          output: `Navigated to ${url}`,
          screenshotB64: screenshot,
          recordedStep: { kind: 'goto', url },
        };
      }

      case 'screenshot': {
        const screenshot = await captureScreenshot(page);
        return { output: 'Took screenshot', screenshotB64: screenshot };
      }

      case 'left_click':
      case 'double_click': {
        const clickCount = action.action === 'double_click' ? 2 : 1;
        if (action.ref) {
          const info = await resolveRef(page, action.ref);
          if (!info.success) {
            return { output: `Could not resolve ${action.ref}: ${info.message}`, isError: true };
          }
          const selector = info.stableSelector;
          // Replay-side will use the selector. Use Playwright's click on
          // the selector now so the click goes through layout-correctly.
          if (selector) {
            try {
              await page.click(selector, { clickCount, timeout: 5_000 });
              return {
                output: `Clicked ${action.ref} (${describeElement(info)}). Stable selector: ${selector}`,
                recordedStep: { kind: 'click', selector },
              };
            } catch {
              // Selector didn't resolve; fall back to coordinates from the
              // ref lookup. Still record as click_at since selector-based
              // replay would also fail.
            }
          }
          const [x, y] = info.coordinates;
          await page.mouse.click(x, y, { clickCount });
          return {
            output: `Clicked ${action.ref} at (${x}, ${y}) (${describeElement(info)})`,
            recordedStep: { kind: 'click_at', x, y },
          };
        }
        if (action.coordinate) {
          const [x, y] = action.coordinate;
          await page.mouse.click(x, y, { clickCount });
          return {
            output: `Clicked at (${x}, ${y})`,
            recordedStep: { kind: 'click_at', x, y },
          };
        }
        return { output: 'Click requires either ref or coordinate', isError: true };
      }

      case 'hover': {
        if (action.ref) {
          const info = await resolveRef(page, action.ref);
          if (!info.success) {
            return { output: `Could not resolve ${action.ref}: ${info.message}`, isError: true };
          }
          const [x, y] = info.coordinates;
          await page.mouse.move(x, y);
          await page.waitForTimeout(300);
          const screenshot = await captureScreenshot(page);
          return { output: `Hovered ${action.ref}`, screenshotB64: screenshot };
        }
        if (action.coordinate) {
          await page.mouse.move(action.coordinate[0], action.coordinate[1]);
          return { output: 'Hovered' };
        }
        return { output: 'Hover requires either ref or coordinate', isError: true };
      }

      case 'scroll': {
        const direction = action.scroll_direction ?? 'down';
        const amount = action.scroll_amount ?? 3;
        const dx = direction === 'left' ? -amount * 100 : direction === 'right' ? amount * 100 : 0;
        const dy = direction === 'up' ? -amount * 100 : direction === 'down' ? amount * 100 : 0;
        await page.evaluate(([x, y]) => window.scrollBy(x, y), [dx, dy]);
        await page.waitForTimeout(300);
        return { output: `Scrolled ${direction} by ${amount}` };
      }

      case 'scroll_to': {
        const info = await resolveRef(page, action.ref);
        if (!info.success) {
          return { output: `Could not resolve ${action.ref}: ${info.message}`, isError: true };
        }
        // resolveRef already calls scrollIntoView; just wait for layout.
        await page.waitForTimeout(300);
        return { output: `Scrolled ${action.ref} into view` };
      }

      case 'type': {
        const value = action.text;
        let recorded: '$username' | '$password' | string = value;
        if (value === creds.username) recorded = '$username';
        if (value === creds.password) recorded = '$password';
        await page.keyboard.type(value);
        return {
          output: `Typed ${value === creds.password ? '<password>' : value}`,
          recordedStep: { kind: 'type_text', value: recorded },
        };
      }

      case 'key': {
        const normalized = normalizeKey(action.text);
        try {
          await page.keyboard.press(normalized);
          return {
            output: `Pressed ${normalized}`,
            recordedStep: { kind: 'press_key', key: normalized },
          };
        } catch (err) {
          return {
            output: `Key "${action.text}" was rejected: ${(err as Error).message}. Try a click instead.`,
            isError: true,
          };
        }
      }

      case 'read_page': {
        const filter = action.text === 'interactive' ? 'interactive' : '';
        const tree = await page.evaluate(`
          (() => {
            ${DOM_SCRIPT}
            return window.__generateAccessibilityTree(${JSON.stringify(filter)});
          })()
        `);
        const content = extractPageContent(tree);
        return { output: content };
      }

      case 'find': {
        // Local lightweight "find" — no second Anthropic call. We grep the
        // accessibility tree text for the query and return matching refs.
        const tree = await page.evaluate(`
          (() => {
            ${DOM_SCRIPT}
            return window.__generateAccessibilityTree('');
          })()
        `);
        const content = extractPageContent(tree);
        const query = action.text.toLowerCase();
        const matches = content
          .split('\n')
          .filter((line) => line.toLowerCase().includes(query))
          .slice(0, 20);
        if (matches.length === 0) {
          return { output: `No elements matched "${action.text}"` };
        }
        return { output: `Found ${matches.length} matching lines:\n${matches.join('\n')}` };
      }

      case 'get_page_text': {
        const result = await page.evaluate(`(${TEXT_SCRIPT})()`);
        return { output: formatPageText(result) };
      }

      case 'wait': {
        const seconds = Math.max(0, Math.min(60, action.duration ?? 1));
        await page.waitForTimeout(seconds * 1000);
        return { output: `Waited ${seconds}s` };
      }

      case 'form_input': {
        const refLit = JSON.stringify(action.ref);
        const valueLit = JSON.stringify(action.value);
        const result = await page.evaluate(`(${FORM_INPUT_SCRIPT})(${refLit}, ${valueLit})`);
        const r = result as { success?: boolean; message?: string } | null;
        if (!r || !r.success) {
          return { output: `form_input failed: ${r?.message ?? 'unknown error'}`, isError: true };
        }
        // Resolve the ref again to capture a stable selector for replay.
        const info = await resolveRef(page, action.ref);
        const selector = info.success ? info.stableSelector : null;
        const value = action.value;
        let recorded: '$username' | '$password' | string =
          typeof value === 'string' ? value : String(value);
        if (typeof value === 'string') {
          if (value === creds.username) recorded = '$username';
          if (value === creds.password) recorded = '$password';
        }
        if (selector) {
          return {
            output: `Set ${action.ref} to ${value === creds.password ? '<password>' : value}. Selector: ${selector}`,
            recordedStep: { kind: 'fill', selector, value: recorded },
          };
        }
        return {
          output: `Set ${action.ref} to ${value === creds.password ? '<password>' : value} (no stable selector — replay may need a re-map)`,
        };
      }

      default: {
        const a = action as { action: string };
        return { output: `Unsupported action: ${a.action}`, isError: true };
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn('browser action failed', { action: action.action, err: message });
    return { output: `Action failed: ${message}`, isError: true };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

interface ResolvedRefSuccess {
  success: true;
  coordinates: [number, number];
  elementInfo: string;
  attributes: { type: string; role: string; ariaLabel: string; text: string };
  isVisible: boolean;
  isInteractable: boolean;
  /** Best-effort stable CSS selector synthesized from id / data-testid / text. */
  stableSelector: string | null;
}
interface ResolvedRefFailure {
  success: false;
  message: string;
  // Make optional fields type-compatible with the success path.
  coordinates: [0, 0];
  stableSelector: null;
}

async function resolveRef(page: Page, ref: string): Promise<ResolvedRefSuccess | ResolvedRefFailure> {
  const refLit = JSON.stringify(ref);
  const raw = await page.evaluate(`(${ELEMENT_SCRIPT})(${refLit})`);
  const result = raw as
    | {
        success: true;
        coordinates: [number, number];
        elementInfo: string;
        attributes: { type?: string; role?: string; ariaLabel?: string; text?: string };
        isVisible: boolean;
        isInteractable: boolean;
      }
    | { success: false; message: string };

  if (!result.success) {
    return { success: false, message: result.message, coordinates: [0, 0], stableSelector: null };
  }

  const stableSelector = await synthesizeStableSelector(page, ref);
  return {
    success: true,
    coordinates: result.coordinates,
    elementInfo: result.elementInfo,
    attributes: {
      type: result.attributes.type ?? '',
      role: result.attributes.role ?? '',
      ariaLabel: result.attributes.ariaLabel ?? '',
      text: result.attributes.text ?? '',
    },
    isVisible: result.isVisible,
    isInteractable: result.isInteractable,
    stableSelector,
  };
}

/**
 * Build a CSS selector that should still match the same element on a fresh
 * page load. Priority:
 *   1. #id (if id is non-empty and looks stable — not a generated UUID)
 *   2. [data-testid="..."]
 *   3. tag[name="..."] for inputs
 *   4. text-based locator (Playwright extension): `text="exact text"`
 *   5. null — caller falls back to coordinate replay (or refuses to record)
 *
 * We run this inside the page so we have access to the live DOM node.
 */
async function synthesizeStableSelector(page: Page, ref: string): Promise<string | null> {
  return await page.evaluate((refArg: string) => {
    const w = window as unknown as { __claudeElementMap?: Record<string, WeakRef<Element>> };
    const map = w.__claudeElementMap;
    if (!map || !map[refArg]) return null;
    const el = map[refArg].deref();
    if (!el || !document.contains(el)) return null;

    const looksGenerated = (s: string) =>
      /^[0-9]/.test(s) ||
      /[a-f0-9]{8}-[a-f0-9]{4}/.test(s) ||
      s.includes(':') ||
      s.length > 40;

    // 1. Stable id
    const id = el.getAttribute('id');
    if (id && !looksGenerated(id)) {
      return `#${CSS.escape(id)}`;
    }

    // 2. data-testid / data-test
    for (const attr of ['data-testid', 'data-test', 'data-cy', 'data-qa']) {
      const v = el.getAttribute(attr);
      if (v) return `[${attr}="${CSS.escape(v).replace(/"/g, '\\"')}"]`;
    }

    // 3. name= for inputs
    if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') {
      const name = el.getAttribute('name');
      const type = el.getAttribute('type');
      if (name) return `${el.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
      if (type) return `${el.tagName.toLowerCase()}[type="${type}"]`;
    }

    // 4. aria-label
    const aria = el.getAttribute('aria-label');
    if (aria && aria.length < 60) {
      return `[aria-label="${CSS.escape(aria).replace(/"/g, '\\"')}"]`;
    }

    // 5. Text-based locator (Playwright)
    const text = (el.textContent ?? '').trim();
    if (text && text.length < 50 && !text.includes('\n')) {
      const tag = el.tagName.toLowerCase();
      // Prefer specific tag prefix to avoid matching descendants with same text.
      if (['button', 'a', 'label'].includes(tag)) {
        return `${tag}:has-text("${text.replace(/"/g, '\\"')}")`;
      }
    }

    return null;
  }, ref);
}

function describeElement(info: ResolvedRefSuccess): string {
  const parts: string[] = [info.elementInfo];
  if (info.attributes.text) parts.push(`text="${info.attributes.text.slice(0, 40)}"`);
  return parts.join(' ');
}

function normalizeUrl(u: string): string {
  if (/^https?:\/\//i.test(u) || u.startsWith('about:') || u.startsWith('file://')) return u;
  return `https://${u}`;
}

/**
 * Same-site check for the navigate domain guard. Codex audit pass-6 P1:
 * the previous version blindly took the last two hostname labels, which
 * treats `foo.co.uk` and `bar.co.uk` as the same site — same for `co.za`,
 * `com.au`, `co.jp`, etc. For multi-part public suffixes we have to take
 * three labels instead, otherwise an attacker on the same ccTLD bucket
 * (or just a same-ccTLD vendor) would pass the guard.
 *
 * We don't ship a full Public Suffix List — that's overkill for hotel
 * PMS hosts, which are nearly all `.com`. A small allow-list of common
 * multi-part suffixes covers the realistic deployment surface; new
 * suffixes can be added here as we onboard hotels in new regions.
 */
const MULTI_PART_PUBLIC_SUFFIXES: ReadonlySet<string> = new Set([
  'co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'me.uk',
  'com.au', 'org.au', 'net.au', 'edu.au', 'gov.au',
  'co.nz', 'org.nz', 'net.nz',
  'co.za', 'org.za', 'gov.za',
  'com.br', 'net.br', 'org.br',
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp',
  'co.kr', 'or.kr', 'ne.kr',
  'com.mx', 'org.mx',
  'co.in', 'net.in',
  'com.sg', 'edu.sg',
  'com.hk', 'org.hk',
]);

function registrableDomain(host: string): string {
  const labels = host.toLowerCase().split('.').filter(Boolean);
  if (labels.length < 2) return labels.join('.');
  const lastTwo = labels.slice(-2).join('.');
  if (labels.length >= 3 && MULTI_PART_PUBLIC_SUFFIXES.has(lastTwo)) {
    return labels.slice(-3).join('.');
  }
  return lastTwo;
}

function hostsAreSameSite(a: string, b: string): boolean {
  return registrableDomain(a) === registrableDomain(b);
}

function normalizeKey(raw: string): string {
  const map: Record<string, string> = {
    ctrl: 'Control', control: 'Control', alt: 'Alt', shift: 'Shift',
    cmd: 'Meta', command: 'Meta', win: 'Meta', windows: 'Meta', meta: 'Meta', super: 'Meta',
    return: 'Enter', enter: 'Enter', esc: 'Escape', escape: 'Escape',
    tab: 'Tab', space: 'Space', backspace: 'Backspace', delete: 'Delete',
    up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  };
  return raw.split('+').map((p) => p.trim()).filter(Boolean).map((p) => {
    const lower = p.toLowerCase();
    if (map[lower]) return map[lower];
    if (p.length === 1) return p.toUpperCase();
    return p.charAt(0).toUpperCase() + p.slice(1);
  }).join('+');
}

async function captureScreenshot(page: Page): Promise<string> {
  const buf = await page.screenshot({ fullPage: false });
  return buf.toString('base64');
}

/**
 * The DOM script returns either {pageContent: string} or a tree. Extract
 * the human-readable form for the agent.
 */
function extractPageContent(tree: unknown): string {
  if (tree && typeof tree === 'object' && 'pageContent' in tree) {
    return String((tree as { pageContent: unknown }).pageContent ?? '');
  }
  return JSON.stringify(tree, null, 2);
}

function formatPageText(result: unknown): string {
  if (result && typeof result === 'object') {
    const r = result as { title?: string; url?: string; source?: string; text?: string };
    return `Title: ${r.title ?? 'N/A'}\nURL: ${r.url ?? 'N/A'}\nSource: <${r.source ?? 'unknown'}>\n---\n${r.text ?? ''}`;
  }
  return String(result);
}
