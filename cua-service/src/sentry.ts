/**
 * Sentry integration for the CUA worker.
 *
 * Why this exists:
 *   The Next.js app already has @sentry/nextjs wired up — every
 *   log.error() in src/lib/log.ts calls captureException, errors flow
 *   to staxis.sentry.io automatically. The CUA worker on Fly is a
 *   separate process, separate codebase, separate node_modules. Errors
 *   that happen there (a Playwright crash, a Claude API timeout, a bad
 *   recipe) used to surface only in `flyctl logs` — easy to miss until
 *   a customer complains. This module sends them to the same Sentry
 *   project so all errors land in one inbox.
 *
 * Init: called once at startup from src/index.ts. After that, log.error
 * automatically captures the exception (see ./log.ts).
 *
 * If SENTRY_DSN is missing, init silently no-ops — local dev doesn't
 * need Sentry, and we don't want missing config to crash the worker.
 */

import * as Sentry from '@sentry/node';
import { env } from './env.js';

let initialized = false;

export function initSentry(): boolean {
  if (initialized) return true;

  const dsn = env.SENTRY_DSN;
  if (!dsn) {
    // Local dev or misconfigured deploy — fail open. The log.ts integration
    // checks `initialized` before calling Sentry methods, so this is safe.
    return false;
  }

  Sentry.init({
    dsn,
    // tracesSampleRate=0 — we don't need tracing on a worker, just errors.
    // Keeping the dependency lightweight.
    tracesSampleRate: 0,
    // Plan v2 F-AI-9 — explicitly disable Sentry's default PII attachers
    // (IP address, user agent, cookie headers). The CUA worker doesn't
    // serve HTTP traffic anyway, so there's no meaningful PII the SDK
    // would pull — but turning it off explicitly makes the posture
    // surface in the Sentry settings UI rather than depending on a
    // default that might change in a future SDK release.
    sendDefaultPii: false,
    // environment lets us filter prod/dev errors in the Sentry UI.
    environment: env.NODE_ENV,
    // Tag every event with the worker_id so we can pivot on which Fly
    // machine produced the error (handy for "is one machine bad, or
    // is it a global bug?").
    initialScope: {
      tags: {
        service: 'cua-worker',
        fly_app: env.FLY_APP_NAME,
        fly_region: env.FLY_REGION ?? 'unk',
        fly_machine: env.FLY_MACHINE_ID ?? 'unk',
      },
    },
    // Defense-in-depth: redact credential-shaped strings before sending.
    // The mapper already substitutes creds with $username/$password
    // placeholders in recipes, so this filter is a backstop for cases
    // where a credential leaks into a stack trace or log message.
    //
    // We REDACT (replace with `<redacted>`) rather than DROP the event,
    // because the previous "drop on match" version was too aggressive —
    // any error involving a JWT-shaped string (every Supabase access
    // token starts with "eyJ") would silently disappear, hiding real
    // bugs.
    beforeSend(event) {
      // Plan v2 F-AI-9 — extended beforeSend. The original redactor was
      // regex-only on credential-shaped strings. Now we also:
      //   - drop the entire value when the KEY name says it carries
      //     screenshot bytes, tool-result content, or page text
      //     (these are large PII-bearing payloads that should never
      //     reach Sentry).
      //   - strip query strings from URLs (auth tokens sometimes ride
      //     query parameters; ?token=… should never appear in Sentry).
      //   - keep the original regex-based credential redactor as a
      //     last line of defense for stack-frame strings.
      const SUPPRESSED_KEY_PATTERNS = [
        /screenshot/i,                  // screenshotB64, screenshot_data, etc.
        /^body$/i,                      // raw HTTP body
        /tool_?result/i,                // any tool_result.* content blob
        /page_?text/i,                  // get_page_text returns
        /dom_?tree/i,                   // read_page output
        /^content$/i,                   // sentry default name for body content
      ];
      const stripQueryFromUrl = (s: string): string => {
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
      const redactInPlace = (obj: unknown, depth = 0): void => {
        if (!obj || typeof obj !== 'object' || depth > 8) return;
        for (const [k, v] of Object.entries(obj)) {
          // Drop the entire value when the key looks like a PII payload.
          if (SUPPRESSED_KEY_PATTERNS.some((re) => re.test(k))) {
            (obj as Record<string, unknown>)[k] = '<redacted:suppressed_key>';
            continue;
          }
          if (typeof v === 'string') {
            // Anthropic API key shape: sk-ant-api03-… (95+ chars).
            // We only redact the long-form key; shorter sk-ant- mentions
            // (e.g., the prefix in a doc) are fine.
            if (/sk-ant-api\d{2}-[a-zA-Z0-9_-]{80,}/.test(v)) {
              (obj as Record<string, unknown>)[k] = '<redacted:anthropic_key>';
            }
            // Supabase service-role key: JWT with role:'service_role' —
            // we can't easily check the payload, so use length as a
            // proxy. Service role keys are 200+ chars; access tokens are
            // ~150-200; we redact only the longest ones to err on the
            // side of preserving real errors.
            else if (/eyJ[a-zA-Z0-9_-]{30,}\.[a-zA-Z0-9_-]{30,}\.[a-zA-Z0-9_-]{200,}/.test(v)) {
              (obj as Record<string, unknown>)[k] = '<redacted:long_jwt>';
            }
            // URLs: strip query string. ?token=… sometimes rides
            // there and should never reach Sentry.
            else if (/^https?:\/\//.test(v) && v.includes('?')) {
              (obj as Record<string, unknown>)[k] = stripQueryFromUrl(v);
            }
          } else if (typeof v === 'object') {
            redactInPlace(v, depth + 1);
          }
        }
      };
      redactInPlace(event);
      // request.body is the SDK's well-known location for HTTP-request
      // bodies; drop it entirely on the off chance the SDK auto-attaches
      // one in a future release.
      if (event.request && typeof event.request === 'object') {
        (event.request as Record<string, unknown>).data = '<redacted:body>';
      }
      return event;
    },
  });

  initialized = true;
  return true;
}

// Sentry tag values cap at 200 chars and reject newline-bearing strings
// at the ingest layer. Clamp here so a long hotel name or a stack-like
// string in a `job_id` field doesn't silently disappear from the
// dashboard. Mirrors cleanTagValue in src/lib/sentry.ts — including the
// codepoint-aware truncation (Array.from splits on codepoint
// boundaries so a "🏨 Resort" hotel name doesn't get cut mid-surrogate-
// pair and produce invalid UTF-16).
const TAG_VALUE_MAX = 200;
function cleanTagValue(raw: string): string | null {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return null;
  if (collapsed.length <= TAG_VALUE_MAX) return collapsed;
  const codepoints = Array.from(collapsed);
  if (codepoints.length <= TAG_VALUE_MAX) return collapsed;
  return codepoints.slice(0, TAG_VALUE_MAX - 1).join('') + '…';
}

/**
 * Lift property identifiers out of free-form context onto Sentry tags
 * (filterable in the dashboard) rather than just extras (unfilterable).
 * The CUA worker is property-scoped by nature — every job runs against
 * one hotel — so any error worth Sentry-ing is something we'll later
 * want to slice "by which hotel did this happen to."
 *
 * Mirrors src/lib/sentry.ts in the main Next.js app so dashboards work
 * the same way regardless of which service raised the error.
 */
function buildPropertyTags(context?: Record<string, unknown>): Record<string, string> {
  if (!context) return {};
  const tags: Record<string, string> = {};
  const set = (key: string, raw: unknown): void => {
    if (typeof raw !== 'string' || raw.length === 0) return;
    const cleaned = cleanTagValue(raw);
    if (cleaned) tags[key] = cleaned;
  };
  set('property.id', context.pid ?? context.property_id ?? context.propertyId);
  set('property.name', context.property_name ?? context.propertyName);
  // CUA-specific: most errors are scoped to a job_id (one PMS-mapping run).
  // Surfacing it as a tag means "find every error from job X" is one click.
  set('cua.job_id', context.job_id ?? context.jobId);
  return tags;
}

export function captureException(err: unknown, context?: Record<string, unknown>): void {
  if (!initialized) return;
  if (!context) {
    Sentry.captureException(err);
    return;
  }
  const tags = buildPropertyTags(context);
  Sentry.captureException(err, {
    extra: context,
    ...(Object.keys(tags).length > 0 ? { tags } : {}),
  });
}

export function captureMessage(msg: string, level: 'info' | 'warning' | 'error' = 'error', context?: Record<string, unknown>): void {
  if (!initialized) return;
  const tags = buildPropertyTags(context);
  Sentry.captureMessage(msg, {
    level,
    extra: context,
    ...(Object.keys(tags).length > 0 ? { tags } : {}),
  });
}

/**
 * Wrap a job body in a Sentry scope tagged with job/property/worker IDs.
 * Any captureException fired by helpers DEEP inside the callback inherits
 * the tags automatically — no need to thread context through every layer.
 *
 * Why this exists (added 2026-05-22 hardening pass): captureException's
 * `extra`+`tags` glue only fires when a caller remembers to pass `ctx`.
 * Playwright crashes, dangling promise rejections, and uncaughtExceptions
 * thrown from inside the worker's job body never had a ctx to attach,
 * so they landed in Sentry without `cua.job_id` / `property.id` tags —
 * undebuggable in the dashboard. Setting the scope at job-start fixes
 * that without weakening the explicit `captureException(err, ctx)`
 * pattern (explicit tags still win for keys they set, scope tags fill in
 * the rest).
 *
 * v10 of @sentry/node uses AsyncLocalStorage under the hood, so the
 * scope propagates correctly through awaits inside fn. Concurrency=1
 * per worker, so cross-job leakage isn't a concern either way.
 */
export interface JobScopeContext {
  jobId?: string;
  propertyId?: string;
  propertyName?: string;
  pmsType?: string;
  workerId?: string;
}

export async function withJobScope<T>(
  ctx: JobScopeContext,
  fn: () => Promise<T>,
): Promise<T> {
  if (!initialized) return fn();
  return Sentry.withScope(async (scope) => {
    const tags = buildPropertyTags({
      job_id: ctx.jobId,
      property_id: ctx.propertyId,
      property_name: ctx.propertyName,
    });
    for (const [k, v] of Object.entries(tags)) scope.setTag(k, v);
    if (ctx.pmsType) {
      const cleaned = cleanTagValue(ctx.pmsType);
      if (cleaned) scope.setTag('pms.type', cleaned);
    }
    if (ctx.workerId) {
      const cleaned = cleanTagValue(ctx.workerId);
      if (cleaned) scope.setTag('worker.id', cleaned);
    }
    return await fn();
  });
}

/**
 * Flush pending events before process exit. Sentry's transport is async
 * so unsent events can vanish on crash. Call this from the SIGTERM
 * handler with a short timeout so deploys don't hang on a bad network.
 *
 * Hard timeout via Promise.race — Sentry.flush's own timeout argument
 * isn't always honoured (network stalls can pin the event loop), so we
 * wrap it in our own setTimeout escape hatch. Returns either way.
 */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!initialized) return;
  await Promise.race([
    Sentry.flush(timeoutMs).catch(() => {}),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs + 100)),
  ]);
}
