/**
 * Passive network-response capture for the LEARN run — the foundation of the
 * "read the clean data behind the page" path.
 *
 * SHARED CONTRACT (pinned by the orchestrator so the parallel build chats can't
 * drift). Chat 2 (Capture + privacy) replaces the stub below with the real
 * Playwright listener; Chat 3 (Mapper) calls attachNetworkCapture() during the
 * per-target agent loop and reads handle.recent() to find the feed's underlying
 * data call. The stub returns an inert handle so callers are safe until Chat 2
 * lands (it simply captures nothing — the mapper then falls back to DOM scrape).
 *
 * MUST be passive (page.on('response') / requestfinished only) — NEVER
 * page.route() interception, which can alter SPA behavior and break the vision
 * agent mid-map. Bodies are PII-redacted (see response-redaction.ts) before they
 * are ever buffered, returned, logged, or sent to Claude.
 */

import type { Page } from 'playwright';

/** One data-bearing network call the page made during the learn run.
 *  `responseBody` is ALREADY PII-redacted (redactResponseBody). */
export interface CapturedCall {
  url: string;
  method: string;
  /** Request body (POST), if any — used to learn date/param templating. */
  requestBody: string | null;
  requestHeaders: Record<string, string>;
  status: number;
  contentType: string;
  /** Parsed + redacted JSON response value, or null if non-JSON / unparseable. */
  responseBody: unknown;
}

export interface NetworkCaptureHandle {
  /** Plausible data calls captured so far (JSON/CSV, non-trivial size,
   *  same-site; analytics/tracking/heartbeat noise filtered out), most-recent
   *  first. Already redacted. */
  recent(): CapturedCall[];
  /** Stop capturing and release listeners. Idempotent. */
  detach(): void;
}

/**
 * Attach passive response capture to a page for the duration of a learn run.
 * Returns a handle to read captured candidate data calls.
 *
 * STUB — Chat 2 (Capture + privacy) implements the real listener. The inert
 * default is intentional: callers (the mapper) treat "no captured calls" as
 * "no structured path found" and fall back to DOM scraping, so shipping this
 * stub never breaks production — it just yields zero structured feeds.
 */
export function attachNetworkCapture(_page: Page): NetworkCaptureHandle {
  return { recent: () => [], detach: () => {} };
}
