/**
 * Shared Sentry PII scrubber. Used as `beforeSend` for both the client
 * and server SDK configs.
 *
 * 2026-05-12 (Codex audit): Sentry's sendDefaultPii=false sanitises the
 * SDK's automatic capture (IPs, cookies, request headers) but does NOT
 * touch custom message text, exception values, tags, contexts, or
 * breadcrumb data. Hotel-ops errors routinely include staff phone
 * numbers, names, PMS payload fragments, and auth tokens. This scrubber
 * runs over the whole event before ingestion and replaces those.
 *
 * Conservative posture: redact whenever a value MIGHT be PII rather
 * than only when we're sure. False positives are noise; false negatives
 * are compliance issues.
 */

// Pull the ErrorEvent / EventHint types via the same entry point the
// rest of the codebase uses for the SDK; @sentry/nextjs re-exports them.
// beforeSend is typed against ErrorEvent specifically (a subtype of
// Event whose `type` is undefined — transaction events go to
// beforeSendTransaction).
import type { ErrorEvent, EventHint } from '@sentry/nextjs';
import type { TransactionEvent } from '@sentry/core';

// 2026-05-12 (Codex audit follow-up): tightened PHONE_RX to reduce
// false-positive redaction of legitimate 10-digit IDs (order numbers,
// reference codes, etc.) that match an unformatted 3-3-4 pattern. Now
// requires EITHER an explicit "+1" prefix (E.164) OR at least one
// separator inside the digit groups. Trade-off: a bare "4155551234"
// no longer redacts, but the app's own logs always format phones with
// dashes (UI) or +1 prefix (Twilio).
const PHONE_RX = /(?:\+1\d{10}|\+1[\s.-]?\d{3}[\s.-]?\d{3}[\s.-]?\d{4}|\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4})/g;
const EMAIL_RX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const BEARER_RX = /(Authorization:\s*Bearer\s+)\S+/gi;
const COOKIE_RX = /(Cookie:\s*)[^\n]+/gi;
const JWT_RX = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
// Service-role-shaped JWT (200+ char third segment). Runs BEFORE JWT_RX so
// the longer-form marker wins on service-role keys. Codex BLOCKER #2:
// without this, a service-role key in a stack frame's local-vars payload
// would mask down to the shorter `<jwt>` marker that downstream tools
// don't treat as a high-severity leak.
const LONG_JWT_RX = /eyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{200,}/g;
// Anthropic API keys (sk-ant-api03-... 95+ chars). Caught by value-regex
// because the key shape is distinctive enough to avoid false positives.
// OpenAI keys (sk-..., sk-proj-..., sk-svcacct-...) are NOT regex-matched
// here — the prefix is too generic and collides with library names — see
// PII_KEYS additions below for the field-name-based handling.
const ANTHROPIC_KEY_RX = /sk-ant-api\d{2}-[A-Za-z0-9_-]{80,}/g;
// Base64-encoded image data URIs (PNG, JPEG, etc). Always huge, never
// useful diagnostically — drop the whole match.
const BASE64_IMAGE_RX = /data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+/g;
const SUPABASE_KEY_RX = /sb-[a-z0-9-]+-auth-token/gi;
const TWILIO_SID_RX = /\b(AC|SM|MM)[a-f0-9]{32}\b/gi;
// QR handoff capabilities live in a URL fragment so they never reach the
// server, but browser telemetry can still observe location.href. Match both
// literal and percent-encoded fragment forms as defense in depth; the normal
// flow clears the fragment in an uninstrumented static bootstrap page first.
const PHONE_PAIRING_FRAGMENT_RX = /([#&]pair=)[^&#\s"']+/gi;
const PHONE_PAIRING_FRAGMENT_ENCODED_RX = /(%23pair%3d)[^&#\s"']+/gi;
// Organization invitations use a 256-bit hex capability in the URL path.
// Match both literal and percent-encoded slashes because request URLs,
// transaction names, and breadcrumb data can arrive in either form.
const COMPANY_INVITE_PATH_RX = /((?:\/|%2f)company-invite(?:\/|%2f))[0-9a-f]{64}/gi;

// Keys we should scrub in tags / contexts / extras / frame-vars even if
// their VALUE doesn't match a regex (e.g. raw staff name as the value
// of "staffName", or an OpenAI key inside `api_key` field).
//
// `vars` catches Sentry's frame-local payload key as defense layer 2 —
// when `includeLocalVariables: true` (we set it false on the Node side
// but the browser SDK has its own defaults), the stack frame's vars
// object lands here as a top-level Record<string, unknown>.
const PII_KEYS = new Set([
  'phone', 'phone_number', 'phoneNumber', 'phone164',
  'email', 'from', 'fromnumber', 'fromheader', 'to', 'toPhone',
  'username', 'password', 'token', 'access_token', 'accessToken',
  'authorization', 'cookie',
  'staffname', 'staff_name', 'guestname', 'guest_name',
  // 2026-05-22 monitoring/logging/secrets hardening additions:
  'apikey', 'api_key', 'openai_key', 'anthropic_key', 'resend_key', 'elevenlabs_key',
  'vars', 'user',
]);

export function scrubString(s: string): string {
  let out = s;
  // Order matters: ANTHROPIC_KEY before JWT (Anthropic keys aren't JWTs
  // but the prefix is distinctive); LONG_JWT before JWT (service-role
  // marker wins); BASE64_IMAGE before everything (replaces a long chunk).
  out = out.replace(ANTHROPIC_KEY_RX, '<anthropic-key>');
  out = out.replace(BASE64_IMAGE_RX, '<base64-image>');
  out = out.replace(LONG_JWT_RX, '<long-jwt>');
  out = out.replace(JWT_RX, '<jwt>');
  out = out.replace(BEARER_RX, '$1<redacted>');
  out = out.replace(COOKIE_RX, '$1<redacted>');
  out = out.replace(SUPABASE_KEY_RX, '<supabase-key>');
  out = out.replace(TWILIO_SID_RX, '<twilio-sid>');
  out = out.replace(PHONE_PAIRING_FRAGMENT_RX, '$1<phone-pairing-token>');
  out = out.replace(PHONE_PAIRING_FRAGMENT_ENCODED_RX, '$1<phone-pairing-token>');
  out = out.replace(COMPANY_INVITE_PATH_RX, '$1<company-invite-token>');
  out = out.replace(PHONE_RX, '<phone>');
  out = out.replace(EMAIL_RX, '<email>');
  return out;
}

function scrubValue(key: string, v: unknown): unknown {
  if (PII_KEYS.has(key.toLowerCase())) return '<redacted>';
  if (typeof v === 'string') return scrubString(v);
  if (Array.isArray(v)) return v.map((x, i) => scrubValue(`${key}[${i}]`, x));
  if (v && typeof v === 'object') return scrubRecord(v as Record<string, unknown>);
  return v;
}

function scrubRecord(rec: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    out[k] = scrubValue(k, v);
  }
  return out;
}

export function scrubSentryEvent(event: ErrorEvent, _hint?: EventHint): ErrorEvent | null {
  // Top-level message
  if (event.message) event.message = scrubString(event.message);

  // Exception values + stack-frame locals (Codex BLOCKER #2).
  //
  // The default Sentry SDK captures local variable values into
  // event.exception.values[i].stacktrace.frames[j].vars when frame-local
  // capture is enabled. Those values regularly carry full request bodies,
  // Supabase rows, service-role JWTs, and AI prompts. The previous
  // implementation only scrubbed ex.value — frame vars sailed through.
  if (event.exception?.values) {
    for (const ex of event.exception.values) {
      if (ex.value) ex.value = scrubString(ex.value);
      // ex.stacktrace?.frames is typed StackFrame[] in @sentry/types; each
      // frame has an optional `vars` Record<string, unknown>. Walk it
      // recursively through scrubRecord so PII_KEYS drops the field
      // wholesale and scrubString catches credential-shaped values.
      const frames = ex.stacktrace?.frames;
      if (Array.isArray(frames)) {
        for (const fr of frames) {
          if (fr && typeof fr === 'object' && 'vars' in fr) {
            const vars = (fr as { vars?: unknown }).vars;
            if (vars && typeof vars === 'object' && !Array.isArray(vars)) {
              (fr as { vars: Record<string, unknown> }).vars = scrubRecord(
                vars as Record<string, unknown>,
              );
            }
          }
          // pre_context / post_context / context_line are source-code
          // strings. Lower risk, but scrub conservatively — interpolated
          // values can land in them.
          for (const k of ['pre_context', 'post_context'] as const) {
            const arr = (fr as Record<string, unknown>)[k];
            if (Array.isArray(arr)) {
              (fr as Record<string, unknown>)[k] = arr.map((s) =>
                typeof s === 'string' ? scrubString(s) : s,
              );
            }
          }
          const ctx = (fr as Record<string, unknown>).context_line;
          if (typeof ctx === 'string') {
            (fr as Record<string, unknown>).context_line = scrubString(ctx);
          }
        }
      }
    }
  }

  // Request body / query / headers / cookies
  if (event.request) {
    if (typeof event.request.url === 'string') {
      event.request.url = scrubString(event.request.url);
    }
    if (event.request.data && typeof event.request.data === 'string') {
      event.request.data = scrubString(event.request.data);
    } else if (event.request.data && typeof event.request.data === 'object') {
      event.request.data = scrubRecord(event.request.data as Record<string, unknown>);
    }
    if (event.request.query_string && typeof event.request.query_string === 'string') {
      event.request.query_string = scrubString(event.request.query_string);
    }
    if (event.request.headers) {
      // Drop sensitive headers wholesale (BEARER_RX/COOKIE_RX both require
      // the "Header:" prefix in the value, but the SDK has split it off
      // by the time we reach here). Fall back to scrubString for
      // everything else so a stray phone in User-Agent still gets caught.
      const SENSITIVE_HEADER_LC = new Set([
        'authorization', 'cookie', 'set-cookie',
        'x-supabase-auth', 'x-amz-security-token',
      ]);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(event.request.headers)) {
        if (SENSITIVE_HEADER_LC.has(k.toLowerCase())) {
          headers[k] = '<redacted>';
        } else {
          headers[k] = typeof v === 'string' ? scrubString(v) : (v as string);
        }
      }
      event.request.headers = headers;
    }
    // Cookies — drop wholesale. Sentry's request.cookies surface ends up
    // populated by some middleware/integrations even with sendDefaultPii
    // false; safer to redact than rely on the upstream gate.
    const cookies = (event.request as { cookies?: unknown }).cookies;
    if (cookies && typeof cookies === 'object' && !Array.isArray(cookies)) {
      const redacted: Record<string, string> = {};
      for (const k of Object.keys(cookies as Record<string, unknown>)) redacted[k] = '<redacted>';
      (event.request as { cookies?: unknown }).cookies = redacted;
    } else if (typeof cookies === 'string') {
      (event.request as { cookies?: unknown }).cookies = '<redacted>';
    }
  }

  // Tags / extras / contexts (recurse, not one-level — codex SHOULD-FIX:
  // contexts is the common spot for nested ad-hoc context blobs).
  if (event.tags) {
    const tags: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(event.tags)) tags[k] = scrubValue(k, v);
    event.tags = tags as typeof event.tags;
  }
  if (event.extra) event.extra = scrubRecord(event.extra as Record<string, unknown>);
  if (event.contexts) {
    const contexts: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(event.contexts)) {
      contexts[k] =
        v && typeof v === 'object' && !Array.isArray(v)
          ? scrubRecord(v as Record<string, unknown>)
          : scrubValue(k, v);
    }
    event.contexts = contexts as typeof event.contexts;
  }

  // User — strip the high-PII fields, keep `id` for triage. Sentry
  // doesn't auto-populate these under sendDefaultPii=false, but a
  // dev could have manually called Sentry.setUser({email: ...}).
  if (event.user) {
    const u = event.user as Record<string, unknown>;
    for (const k of ['username', 'email', 'ip_address'] as const) {
      if (k in u) u[k] = '<redacted>';
    }
  }

  // Breadcrumbs
  if (event.breadcrumbs) {
    for (const b of event.breadcrumbs) {
      if (b.message) b.message = scrubString(b.message);
      if (b.data) b.data = scrubRecord(b.data as Record<string, unknown>);
    }
  }

  return event;
}

/** Transaction events bypass beforeSend, so scrub their URL/name/span data. */
export function scrubSentryTransaction(event: TransactionEvent): TransactionEvent | null {
  const scrubbed = scrubSentryEvent(event as unknown as ErrorEvent) as unknown as TransactionEvent | null;
  if (!scrubbed) return null;
  if (typeof scrubbed.transaction === 'string') {
    scrubbed.transaction = scrubString(scrubbed.transaction);
  }
  if (Array.isArray(scrubbed.spans)) {
    for (const span of scrubbed.spans) {
      if (typeof span.description === 'string') {
        span.description = scrubString(span.description);
      }
      if (span.data && typeof span.data === 'object') {
        span.data = scrubRecord(span.data as Record<string, unknown>) as typeof span.data;
      }
    }
  }
  return scrubbed;
}
