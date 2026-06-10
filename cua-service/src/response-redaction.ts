/**
 * PII redaction for captured network response bodies.
 *
 * SHARED CONTRACT (pinned by the orchestrator). Captured JSON bodies are the
 * rawest guest PII in the system (names, emails, phones, card numbers, auth
 * tokens) — far more than screenshots. They MUST be redacted at least as
 * strictly as screenshot-privacy.ts before they are buffered, returned by
 * network-capture, logged, persisted, or sent to Claude during the identify
 * step.
 *
 * Chat 2 (Capture + privacy) implements the real recursive redaction. The stub
 * is a pass-through ONLY so the contract compiles — it is NOT safe for
 * production and Chat 2 MUST replace it before any real capture ships.
 */

/**
 * Return a deep copy of `body` with guest PII + secrets masked. Field SHAPE and
 * key names are preserved (the identify/verify step needs them) — only VALUES
 * of sensitive fields are masked, so row counts / dates / non-PII fields still
 * reconcile against the DOM oracle.
 *
 * STUB — Chat 2 implements. Do not ship the pass-through.
 */
export function redactResponseBody(body: unknown): unknown {
  return body;
}
