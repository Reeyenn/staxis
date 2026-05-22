/**
 * Sentry integration for the scraper.
 *
 * Why this exists:
 *   The Next.js app and the CUA worker both ship errors to staxis.sentry.io.
 *   The scraper, also running on Railway, used to fail silently — a CSV pull
 *   crash showed only in Railway logs, and Reeyen wouldn't know until a
 *   scraper-health SMS fired (or the front desk noticed "no rooms").
 *   This module sends every captured error to the same Sentry project so
 *   all four services land in one inbox.
 *
 * Init: called once at startup from scraper.js (right after dotenv + env
 * validation, before createSupabase). After that, captureException in
 * the pull catch blocks fires events with property/phase tags.
 *
 * If SENTRY_DSN is missing, init silently no-ops and the capture helpers
 * become no-ops too. Local dev doesn't need Sentry, and a missing config
 * must NEVER crash the scraper.
 *
 * Patterns mirror cua-service/src/sentry.ts so a CUA-worker-aware operator
 * can read this without learning a second convention.
 */

// @sentry/node is required lazily inside initSentry() so this module is
// importable in environments where the package isn't installed (unit tests,
// pre-`npm install` smoke). The capture helpers below guard on `initialized`
// before touching the SDK, so a never-initialized module is a true no-op.
let Sentry = null;
const { env } = require('./env');

let initialized = false;

/**
 * Initialize Sentry. Returns true if SDK loaded with a real DSN, false if
 * Sentry is no-op'd (DSN absent or init threw). Idempotent — re-calling
 * after a successful init is a no-op.
 */
function initSentry() {
  if (initialized) return true;

  const dsn = env.SENTRY_DSN;
  if (!dsn) {
    // Local dev or misconfigured deploy — fail open. The capture helpers
    // below check `initialized` before calling Sentry methods, so this is
    // safe and silent.
    return false;
  }

  try {
    // Lazy-require the SDK so this module is importable even when
    // @sentry/node isn't installed (unit tests, fresh checkout pre-`npm
    // install`). A require failure here flows through the outer catch
    // and degrades to "no monitoring" — same behavior as missing DSN.
    Sentry = require('@sentry/node');
    Sentry.init({
      dsn,
      // Worker process — no spans worth tracing. Errors only.
      tracesSampleRate: 0,
      // Disable SDK's automatic PII attachers (request IP, user agent,
      // cookies). The scraper doesn't serve HTTP traffic, so there's
      // little meaningful PII the SDK would pull — but disabling
      // explicitly surfaces the posture in the Sentry settings UI.
      sendDefaultPii: false,
      // Frame-local capture is OFF — Node Sentry by default attaches
      // local variable values to stack frames, which would pull Supabase
      // service-role keys and Choice Advantage credentials into events.
      // Defense layer 1; the beforeSend scrubber below is layer 2.
      includeLocalVariables: false,
      environment: env.NODE_ENV || 'production',
      initialScope: {
        tags: {
          service: 'scraper',
          // Property and instance tags so dashboards can pivot "which
          // scraper produced this error" without parsing event bodies.
          'property.id': env.HOTELOPS_PROPERTY_ID || 'unset',
          'scraper.instance': env.SCRAPER_INSTANCE_ID || 'default',
        },
      },
      /**
       * beforeSend: drop or redact PII-bearing surfaces before ingestion.
       *
       * Two layers:
       *   1. Drop entire value when KEY matches a payload-suppression
       *      pattern (page_text, dom_tree, body, screenshot — any of
       *      which could carry guest data or HTML chunks bigger than
       *      Sentry's per-event cap).
       *   2. Redact credential-shaped strings inside any remaining value.
       *
       * Mirrors cua-service/src/sentry.ts so the two worker scrubbers
       * stay aligned.
       */
      beforeSend(event) {
        const SUPPRESSED_KEY_PATTERNS = [
          /screenshot/i,
          /^body$/i,
          /tool_?result/i,
          /page_?text/i,
          /dom_?tree/i,
          /^content$/i,
          /^vars$/i, // Sentry's frame-local payload key — defense layer 2 even though includeLocalVariables=false
        ];

        const stripQueryFromUrl = (s) => {
          try {
            const u = new URL(s);
            if (u.search) {
              u.search = '?<redacted>';
              return u.toString();
            }
            return s;
          } catch {
            return s;
          }
        };

        const redactInPlace = (obj, depth = 0) => {
          if (!obj || typeof obj !== 'object' || depth > 8) return;
          for (const [k, v] of Object.entries(obj)) {
            if (SUPPRESSED_KEY_PATTERNS.some((re) => re.test(k))) {
              obj[k] = '<redacted:suppressed_key>';
              continue;
            }
            if (typeof v === 'string') {
              if (/sk-ant-api\d{2}-[a-zA-Z0-9_-]{80,}/.test(v)) {
                obj[k] = '<redacted:anthropic_key>';
              } else if (/eyJ[a-zA-Z0-9_-]{30,}\.[a-zA-Z0-9_-]{30,}\.[a-zA-Z0-9_-]{200,}/.test(v)) {
                // Service-role-shaped JWT (200+ char third segment).
                obj[k] = '<redacted:long_jwt>';
              } else if (/eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/.test(v)) {
                // Anon-key-shaped JWT — shorter but still credentialed.
                obj[k] = '<redacted:jwt>';
              } else if (/^https?:\/\//.test(v) && v.includes('?')) {
                obj[k] = stripQueryFromUrl(v);
              }
            } else if (typeof v === 'object') {
              redactInPlace(v, depth + 1);
            }
          }
        };

        redactInPlace(event);

        // SDK's well-known location for HTTP-request bodies — drop wholesale
        // in case a future Sentry release auto-attaches one.
        if (event.request && typeof event.request === 'object') {
          event.request.data = '<redacted:body>';
        }

        return event;
      },
    });
    initialized = true;
    return true;
  } catch (err) {
    // Init failure must NOT crash the scraper. A scraper that boots
    // without monitoring is degraded; one that crash-loops is broken.
    console.warn(`[sentry] init failed (continuing without monitoring): ${err && err.message ? err.message : err}`);
    initialized = false;
    return false;
  }
}

/**
 * Capture an exception with optional context. Tags lifted onto the Sentry
 * scope so dashboards can pivot "find every error from property X" or
 * "every error from the dashboard pull phase".
 */
function captureException(err, context) {
  if (!initialized || !Sentry) return;
  if (!context) {
    try { Sentry.captureException(err); } catch {}
    return;
  }
  const tags = {};
  if (typeof context.propertyId === 'string' && context.propertyId.length > 0) {
    tags['property.id'] = context.propertyId.slice(0, 200);
  }
  if (typeof context.phase === 'string' && context.phase.length > 0) {
    tags['scraper.phase'] = context.phase.slice(0, 200);
  }
  try {
    Sentry.captureException(err, {
      extra: context,
      ...(Object.keys(tags).length > 0 ? { tags } : {}),
    });
  } catch {}
}

function captureMessage(msg, level = 'error', context) {
  if (!initialized || !Sentry) return;
  const tags = {};
  if (context && typeof context.propertyId === 'string') tags['property.id'] = context.propertyId.slice(0, 200);
  if (context && typeof context.phase === 'string') tags['scraper.phase'] = context.phase.slice(0, 200);
  try {
    Sentry.captureMessage(msg, {
      level,
      extra: context,
      ...(Object.keys(tags).length > 0 ? { tags } : {}),
    });
  } catch {}
}

/**
 * Flush pending events before process exit. Sentry's transport is async,
 * so events queued in the last few seconds before SIGTERM can vanish on
 * shutdown. Wraps Sentry.flush in an outer setTimeout escape hatch
 * because the SDK's own timeout argument isn't always honoured under
 * network stall.
 */
async function flushSentry(timeoutMs = 2000) {
  if (!initialized || !Sentry) return;
  await Promise.race([
    Sentry.flush(timeoutMs).catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, timeoutMs + 100)),
  ]);
}

module.exports = { initSentry, captureException, captureMessage, flushSentry };
