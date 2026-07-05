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

/**
 * Stable, non-reversible 32-bit hash (FNV-1a) → 8-hex. Used to fingerprint
 * TYPED text without embedding it: identical text yields an identical token
 * (loop detection intact) but the plaintext never lands in a fingerprint,
 * which flows verbatim into the logged trip `reason`. A typed value can be a
 * credential (the login flow types the password), so it must never be logged.
 */
function stableTextToken(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Snap a pixel coordinate to a coarse grid so a model clicking the SAME
 * control with a few pixels of jitter per turn produces the SAME
 * fingerprint. The model re-samples target coordinates from a fresh
 * screenshot every turn, so a genuinely-stuck re-click drifts by a handful
 * of pixels — without bucketing, the (max+1)th identical click never trips
 * and the run grinds to its per-target cost cap. 16px is comfortably below
 * any real clickable control's size, so distinct controls still land in
 * distinct buckets. Used only for the coordinate fallback (badge `text`
 * tokens, when present, are exact and take precedence).
 */
const COORD_BUCKET_PX = 16;
function quantizeCoord(coord: unknown[]): string {
  return coord
    .map((c) => (typeof c === 'number' ? Math.round(c / COORD_BUCKET_PX) : c))
    .join(',');
}

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
    // Set-of-Mark badge clicks carry `text: "#N"`; executeVisionAction
    // resolves that to the badge's stored center and IGNORES the raw
    // coordinate the model sent. So the badge token — not the pixel guess
    // — is the semantic identity of the click. Prefer it, or a re-click of
    // the same ineffective badge with a few px of model coordinate jitter
    // per turn fingerprints differently every time and never trips the
    // loop-abort (grinds to the per-target cost cap instead).
    if (typeof a.text === 'string' && a.text.trim() !== '') return `${action}:${a.text.trim()}`;
    if (Array.isArray(a.coordinate)) return `${action}:${quantizeCoord(a.coordinate)}`;
    return `${action}:no-target`;
  }

  if (action === 'left_click_drag') {
    const start = Array.isArray(a.start_coordinate) ? quantizeCoord(a.start_coordinate) : '';
    const end = Array.isArray(a.coordinate) ? quantizeCoord(a.coordinate) : '';
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
    // Hash the text, never embed it: a typed value can be a password, and this
    // fingerprint is logged verbatim in the loop trip reason. Same text → same
    // token, so loop detection is unchanged.
    return `${action}:${stableTextToken(String(a.text ?? ''))}`;
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
 * Robust to time-like / rotating content: before hashing we strip
 * clocks, dates, "last refreshed/updated ..." lines, and standalone
 * long digit runs (see `stripVolatileText`). Without this, a page with
 * a live clock or a refresh timestamp changes its body text every turn,
 * so a genuinely-STUCK feed never trips the loop-abort — it grinds to
 * its per-target cost cap + 15-min wall instead. Two turns of the SAME
 * page that differ ONLY by a clock/timestamp must produce the SAME
 * fingerprint.
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
    return `${url}::${stripVolatileText(data.title)}::${hashString(stripVolatileText(data.bodyText))}`;
  } catch {
    // Mid-navigation evaluate failure — fall back to URL-only.
    return `${url}::eval-failed`;
  }
}

/**
 * Remove time-like / rotating tokens so a live clock, a "last refreshed"
 * timestamp, or a rotating counter does not make an otherwise-identical
 * page fingerprint differently every turn. Order matters: strip the
 * longer/more-specific patterns (refresh lines, ISO datetimes) before the
 * generic digit-run catch-all. Identity-only — never load-bearing beyond
 * the loop detector.
 */
function stripVolatileText(s: string): string {
  return s
    // "last refreshed/updated: ..." (to end of that line)
    .replace(/last\s+(?:refreshed|updated|synced|modified)[^\n]*/gi, '')
    // clock times: 3:04, 03:04:05, 3:04 pm
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?\b/gi, '')
    // ISO-ish dates/datetimes: 2026-06-30, 2026-06-30T12:34:56
    .replace(/\b\d{4}-\d{2}-\d{2}(?:[t ]\d{2}:\d{2}(?::\d{2})?)?\b/gi, '')
    // slash/dot dates: 06/30/2026, 30.06.2026
    .replace(/\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b/g, '')
    // standalone LONG digit runs (rotating counters, epoch ms, etc.). 6+ digits,
    // not 4+ — so two pages that differ only by a 4-5 digit record/room id don't
    // strip to the same fingerprint and cause a false loop-abort. (Re-review LOW.)
    .replace(/\b\d{6,}\b/g, '')
    // collapse whitespace left behind so spacing changes don't leak through
    .replace(/\s+/g, ' ')
    .trim();
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
