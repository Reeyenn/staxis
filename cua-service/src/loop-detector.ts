/**
 * Action-loop detector for the CUA mapper.
 *
 * Aborts when the agent keeps doing the same thing on the same page —
 * the canonical "stuck in a loop" pattern. Tracks a sliding window of
 * (action, page) fingerprints; trips when one tuple appears MORE THAN
 * maxRepeats times within the last windowSize turns.
 *
 * Pattern adapted from Browser Use's `ActionLoopDetector`. Defaults
 * (window=8, maxRepeats=3) deliberately let legitimate "click 3 rows in
 * a row to select multiple" stretches through without false-positive
 * trips — only the FOURTH identical (action, page) record trips the
 * gate.
 *
 * Pure module — no env reads, no DB, no network. Tested in isolation.
 */

import type { Page } from 'playwright';

export interface LoopDetectorOpts {
  /** Number of most-recent records the detector remembers. Default 8. */
  windowSize?: number;
  /** A tuple may appear up to this many times; the (max+1)th trips. Default 3. */
  maxRepeats?: number;
}

interface Entry {
  action: string;
  page: string;
}

export interface LoopDetectorResult {
  stuck: boolean;
  reason?: string;
}

export class ActionLoopDetector {
  private readonly windowSize: number;
  private readonly maxRepeats: number;
  private readonly history: Entry[] = [];

  constructor(opts: LoopDetectorOpts = {}) {
    this.windowSize = Math.max(1, opts.windowSize ?? 8);
    this.maxRepeats = Math.max(1, opts.maxRepeats ?? 3);
  }

  /**
   * Record a new (action, page) tuple and report whether the agent
   * looks stuck. The check is "same tuple appears more than maxRepeats
   * times in the current window" — so with default maxRepeats=3, the
   * detector trips on the FOURTH identical record.
   */
  record(actionFingerprint: string, pageFingerprint: string): LoopDetectorResult {
    this.history.push({ action: actionFingerprint, page: pageFingerprint });
    while (this.history.length > this.windowSize) {
      this.history.shift();
    }

    let count = 0;
    for (const entry of this.history) {
      if (entry.action === actionFingerprint && entry.page === pageFingerprint) {
        count++;
      }
    }

    if (count > this.maxRepeats) {
      return {
        stuck: true,
        reason: `repeated "${actionFingerprint}" on the same page ${count} times in last ${this.history.length} turns (max ${this.maxRepeats})`,
      };
    }
    return { stuck: false };
  }

}

/**
 * Stable fingerprint of an Anthropic tool_use input. Two identical
 * (semantically) actions produce the same string; different actions
 * produce different strings.
 *
 * Vision (computer_20251124) and DOM (browser) action shapes both flow
 * through this — they share most field names (`action`, `coordinate`,
 * `text`, `ref`).
 *
 * Unknown/extra fields are ignored so a future schema addition doesn't
 * silently break loop detection. The string is opaque — callers should
 * not parse it.
 */
export function actionFingerprint(input: unknown): string {
  if (input === null || input === undefined || typeof input !== 'object') {
    return `unknown:${String(input).slice(0, 32)}`;
  }
  const a = input as Record<string, unknown>;
  const action = String(a.action ?? 'unknown');

  // Click family — vision uses pixel coords, DOM may use ref.
  if (
    action === 'left_click' ||
    action === 'right_click' ||
    action === 'middle_click' ||
    action === 'double_click' ||
    action === 'triple_click' ||
    action === 'mouse_move' ||
    action === 'left_mouse_down' ||
    action === 'left_mouse_up'
  ) {
    if (typeof a.ref === 'string') return `${action}:${a.ref}`;
    if (Array.isArray(a.coordinate)) return `${action}:${a.coordinate.join(',')}`;
    return `${action}:no-target`;
  }

  if (action === 'left_click_drag') {
    const start = Array.isArray(a.start_coordinate) ? a.start_coordinate.join(',') : '';
    const end = Array.isArray(a.coordinate) ? a.coordinate.join(',') : '';
    return `${action}:${start}->${end}`;
  }

  if (action === 'read_page' || action === 'find' || action === 'get_page_text') {
    return `${action}:${String(a.text ?? '')}`;
  }

  if (action === 'scroll') {
    return `${action}:${String(a.scroll_direction ?? '')}:${String(a.scroll_amount ?? '')}`;
  }

  if (action === 'scroll_to' || action === 'hover') {
    return `${action}:${String(a.ref ?? '')}`;
  }

  if (action === 'navigate') {
    return `${action}:${String(a.text ?? a.url ?? '')}`;
  }

  if (action === 'type' || action === 'key') {
    return `${action}:${String(a.text ?? '')}`;
  }

  if (action === 'hold_key') {
    return `${action}:${String(a.text ?? '')}:${String(a.duration ?? '')}`;
  }

  if (action === 'form_input') {
    return `${action}:${String(a.ref ?? '')}:${String(a.value ?? '')}`;
  }

  if (action === 'wait') {
    return `${action}:${String(a.duration ?? '')}`;
  }

  if (action === 'screenshot' || action === 'cursor_position') {
    return action;
  }

  return action;
}

/**
 * Quick page fingerprint — a deterministic string from URL + title +
 * the first 500 chars of visible body text. Stable across React
 * re-renders that don't change content; varies across actual
 * navigations / dialog opens / submenu expansions.
 *
 * Fail-safe behavior: if the page eval errors (page closing or
 * navigating mid-flight), we fall back to URL-only. That way two
 * consecutive errored fingerprints on the same URL still compare
 * equal (so a loop on a broken page CAN still trip the detector),
 * but they don't trip a false-positive against a real fingerprint
 * computed before the error.
 */
export async function pageFingerprint(page: Page): Promise<string> {
  let url = 'unknown';
  try {
    url = page.url();
  } catch {
    // Page may be closed — return a constant "unknown" so repeated
    // failures still compare equal (allowing legitimate loop trips).
    return 'closed-page';
  }

  try {
    const data = await page.evaluate(() => ({
      title: typeof document !== 'undefined' ? document.title : '',
      bodyText: typeof document !== 'undefined' && document.body
        ? (document.body.innerText ?? '').slice(0, 500)
        : '',
    }));
    return `${url}::${data.title}::${hashString(data.bodyText)}`;
  } catch {
    // Mid-navigation evaluate failure — fall back to URL-only.
    return `${url}::eval-failed`;
  }
}

/**
 * FNV-1a 32-bit hash. Deterministic, no crypto dependency. Identity-
 * only — never use for security.
 */
function hashString(s: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}
