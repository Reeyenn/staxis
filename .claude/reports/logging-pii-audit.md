# Logging & PII Audit

**Branch:** `audit/logging-pii`
**Date:** 2026-05-17
**Scope:** `src/` (Next.js app), `cua-service/src/` (CUA worker), root Sentry configs, `next.config.ts`
**Excluded:** tests (`*.test.*`, `__tests__`, `*.spec.*`), `scripts/`, `tools/`, `node_modules/`, generated `.next/`
**Method:** ripgrep across the surfaces above for `console.*`, `log.*`, `Sentry.*`, empty `catch` blocks, and tight-loop patterns; every reported `file:line` was opened and re-read before inclusion. No source files were modified.

---

## Executive Summary

| Severity | Count | Themes |
|---|---|---|
| HIGH | 3 | Two production routes log raw email/staff-name; edge Sentry init has no PII scrubber |
| MEDIUM | 5 | Stripe customer ID in warn log; 4 silent `catch {}` blocks around `error_logs` inserts |
| LOW / FYI | 5 | Acceptable by-design patterns documented so they aren't re-flagged later |
| Log floods | 3 | Per-iteration logs in `morning-resend` (×2) and an eval harness |
| Level issues | 2 | One mislevelled `console.error`; codebase-wide 82% / 15% / 3% error/warn/log skew |
| Sentry / observability gaps | 2 | Edge runtime lacks `beforeSend`; no per-route sampling |

**Top three things to fix first:**

1. **Drop the email from `accounts:POST` error log** ([src/app/api/auth/accounts/route.ts:241](src/app/api/auth/accounts/route.ts)).
2. **Drop the staff name from `morning-resend` error log** ([src/app/api/morning-resend/route.ts:244](src/app/api/morning-resend/route.ts)). The sibling route [src/app/api/send-shift-confirmations/route.ts:515](src/app/api/send-shift-confirmations/route.ts) already has the right pattern with an explanatory comment — apply it here.
3. **Add `beforeSend: scrubSentryEvent` to the edge Sentry init** ([sentry.edge.config.ts](sentry.edge.config.ts)). Server and client configs already have it; edge is the only path where raw error text can reach Sentry.

The codebase is otherwise well instrumented. `src/lib/log.ts` is a clean structured logger with requestId correlation. `src/lib/sentry-scrub.ts` redacts phones, emails, JWTs, Bearer tokens, Supabase auth keys, Twilio SIDs, and cookies before ingestion. The CUA worker (`cua-service/src/`) consistently uses its own structured logger with Sentry wired into `log.error` — only one stray `console.error` in browser-side helper code, which is sandboxed inside the headless browser anyway.

---

## HIGH severity (PII / secret leaks)

### H1 — Email logged in auth rollback error

**Location:** [src/app/api/auth/accounts/route.ts:241](src/app/api/auth/accounts/route.ts)

```ts
console.error(`[accounts:POST] AUTH ROLLBACK FAILED — orphaned auth.users row id=${authData.user.id} email=${normalizedEmail}. Insert error: ${errToString(insErr)}. Rollback error: ${rollbackError}`);
```

**What leaks:** `normalizedEmail`. The account creation flow uses synthetic emails of the form `username@<hotel>.staxis.local`, so the value is internal-looking but still 1:1 maps to user identity (username + hotel). On the GM signup path or any future real-email flow, this would be a real address.

**Risk:** PII leak to Vercel logs. Sentry capture is shielded by `scrubSentryEvent` (server config), but Vercel stdout is not — anyone with project access can read it.

**Fix:** Drop the email; the auth user UUID is enough to find the row in Supabase.

```ts
console.error(`[accounts:POST] AUTH ROLLBACK FAILED — orphaned auth.users id=${authData.user.id}. Insert error: ${errToString(insErr)}. Rollback error: ${rollbackError}`);
```

### H2 — Staff name logged in morning-resend SMS error

**Location:** [src/app/api/morning-resend/route.ts:244](src/app/api/morning-resend/route.ts)

```ts
console.error(`Morning resend SMS failed for ${hk.staff_name}:`, errToString(err));
```

**What leaks:** Staff full name, in plaintext, to Vercel logs.

**Risk:** PII leak. Names are sensitive especially for hourly workers whose carrier-block failures get logged here. Also a flood risk (see F1 below) — a property with 20 staff and a regional cell outage produces 20 named lines in one cron run.

**Fix:** Use `staffId` only. The sibling route already does this and explains why:

[src/app/api/send-shift-confirmations/route.ts:512-516](src/app/api/send-shift-confirmations/route.ts)
```ts
} catch (innerErr) {
  // Don't log the raw name — staff names are PII and any trailing
  // bytes in a malformed payload would reach our log aggregator.
  // The staffId is enough to identify the row in DB if needed.
  console.error(`[send-shift-confirmations] failed for staffId=${staffId}: ${errToString(innerErr)}`);
```

Adopt the same shape in `morning-resend`:

```ts
console.error(`[morning-resend] SMS send failed for staffId=${hk.id}: ${errToString(err)}`);
```

### H3 — Edge Sentry init has no PII scrubber

**Location:** [sentry.edge.config.ts:14-20](sentry.edge.config.ts)

```ts
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',
  tracesSampleRate: 0.1,
  sendDefaultPii: false,
  debug: false,
});
```

**What's missing:** `beforeSend: scrubSentryEvent`.

**Risk:** `sendDefaultPii: false` only suppresses the SDK's *automatic* capture (IPs, cookies, headers). Any custom error message, exception value, tag, context, or breadcrumb passes through unredacted. If an edge route ever throws an error string containing a phone number, email, JWT, or Twilio SID, it ships raw. The companion `src/lib/sentry-scrub.ts` was added explicitly to cover this gap and is wired into server ([sentry.server.config.ts:55](sentry.server.config.ts)) and client ([sentry.client.config.ts](sentry.client.config.ts)) configs — edge was missed.

Although no route currently sets `runtime = 'edge'`, the config is loaded by `src/instrumentation.ts` whenever Next decides to spin up an edge runtime (middleware, route handlers marked `edge`, etc.). The next person who adds an edge route will silently lose scrubbing.

**Fix:** Mirror the server config.

```ts
import * as Sentry from '@sentry/nextjs';
import { scrubSentryEvent } from '@/lib/sentry-scrub';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',
  tracesSampleRate: 0.1,
  sendDefaultPii: false,
  debug: false,
  beforeSend: scrubSentryEvent,
});
```

---

## MEDIUM severity

### M1 — Stripe customer ID logged in webhook warn

**Location:** [src/app/api/stripe/webhook/route.ts:170](src/app/api/stripe/webhook/route.ts)

```ts
console.warn(`[stripe/webhook] update by customer ${customerId} failed: ${error.message}`);
```

**What leaks:** Stripe customer ID (`cus_…`). Not strictly PII, but a stable identifier that joins logs to Stripe Dashboard, which has the email, name, last-4, billing address, and full transaction history.

**Risk:** Correlation. Anyone with log access who can also see the Stripe Dashboard can pivot from a log line to a real person.

**Fix:** Either drop the ID entirely (this is a webhook — Stripe will retry, and the dedupe row points at the event) or last-4 redact: `customerId.slice(0, 4) + '…' + customerId.slice(-4)`.

### M2-M5 — Silent `catch {}` swallowing `error_logs` insert failures

Same anti-pattern in four routes. The handler catches its top-level error, writes a row to `error_logs` for offline debugging, and wraps that write in an empty catch:

```ts
} catch (caughtErr) {
  console.error('<route> error:', caughtErr);
  try {
    await supabaseAdmin.from('error_logs').insert({ ... });
  } catch {}                              // <-- the silent catch
  return err('Internal server error', ...);
}
```

The outer error is logged, so we won't lose the request. But if `error_logs` itself is unreachable (RLS, schema drift, connection pool exhaustion), we have no signal of that — the row vanishes, the doctor's "writes to `error_logs` succeed" probe is the only thing that would catch it.

| ID | Location |
|---|---|
| M2 | [src/app/api/send-shift-confirmations/route.ts:575](src/app/api/send-shift-confirmations/route.ts) |
| M3 | [src/app/api/sync-room-assignments/route.ts:242](src/app/api/sync-room-assignments/route.ts) |
| M4 | [src/app/api/ml/override/route.ts:219](src/app/api/ml/override/route.ts) |
| M5 | [src/app/api/sms-reply/route.ts:405](src/app/api/sms-reply/route.ts) (catches around `logHit` rather than `error_logs`, but identical risk) |

**Fix (all four):**

```ts
} catch (logErr) {
  console.error('[<route>] error_logs insert failed:', errToString(logErr));
}
```

A one-liner that turns a silent dropout into a one-time noisy line per outage — exactly what you'd want when triaging a DB incident.

---

## LOW / FYI (acceptable by design, documented so the next pass doesn't re-flag them)

- **Property + staff IDs co-logged with errors** in `src/app/api/notify-backup/route.ts`, `src/app/api/help-request/route.ts`, and `src/app/api/send-shift-confirmations/route.ts`. UUIDs alone don't identify a person; phone numbers in these routes pass through `redactPhone()` before logging.
- **`src/lib/audit.ts`** — `writeAudit` swallows insert failures with a `console.warn`. Intentional: audit logging is best-effort and must never fail the calling request.
- **Client-side `} catch { /* ignore */ }`** in `src/app/inventory/_components/overlays/CountSheet.tsx`, `src/app/inventory/_components/overlays/SimpleSheet.tsx`, `src/app/housekeeper/[id]/page.tsx`. All wrap non-critical client work (localStorage cleanup, optional DOM operations).
- **`src/app/api/sms-reply/route.ts:78`** — `catch { return false }` around `twilio.validateRequest`. Fail-closed signature validation; rejecting on exception is the correct behavior. Mild debuggability gap (a config-missing exception is indistinguishable from a tampered signature), but not security-relevant.
- **`cua-service/src/browser-utils/text.js:63`** — a `console.error` inside browser-side helper code. Runs in the headless Chromium DOM context, not the Node worker, so it can't reach Sentry by definition. Captured by Anthropic's computer-use tool output, which is logged through the structured logger upstream.

---

## Silently swallowed errors

The four `} catch {}` blocks listed in M2-M5 are the only silently-swallowed errors in API routes that warrant action. Every other API handler I read either logs explicitly via `console.error` / `log.error`, returns through the shared `err()` helper (which includes the `requestId` and feeds Sentry via `log.error`), or has a comment explaining why the silence is intentional.

Spot-checked surfaces: Stripe webhook routes, all `/api/auth/**` handlers, all `/api/twilio/**` handlers, `/api/onboarding/**` and `/api/jobs/**` endpoints, `/api/scheduler/**`, `/api/ml/**`. No additional silent catches found.

---

## Critical paths

The user's brief listed payments, auth, data writes, and external API calls as paths that would be undebuggable if they failed silently in prod. Here is the status of each.

### Payments (Stripe)

| Route | Logging status |
|---|---|
| [src/app/api/stripe/webhook/route.ts](src/app/api/stripe/webhook/route.ts) | Logs at every branch. M1 above flags one over-logged ID; M2 flags a silent fallback. |
| [src/app/api/stripe/checkout/route.ts](src/app/api/stripe/checkout/route.ts) | Logs on error and on success. |
| [src/app/api/stripe/portal/route.ts](src/app/api/stripe/portal/route.ts) | Logs on error. |

Stripe surface is well covered. No undebuggable paths.

### Auth

All `/api/auth/**` routes log on the error branch and pass through the `err()` helper for response shaping. H1 above is the one PII issue; nothing else in this surface is silent.

### Data writes

`error_logs` inserts (M2-M5) are the only silent writes. Every other production `.insert()` / `.update()` / `.upsert()` / `.rpc()` either:

- is checked with `if (error)` and surfaces through `console.error` + the `err()` helper, or
- is a best-effort write explicitly marked with a comment (the `audit.ts` and `phone_lookup` patterns).

### External APIs

Outbound calls to Twilio, Resend, ElevenLabs, Anthropic, OpenAI, Picovoice all log on failure. The CUA worker logs every recipe step via `log.info` / `log.warn` / `log.error` with `jobId`, `propertyId`, `step` context — see [cua-service/src/log.ts](cua-service/src/log.ts).

### Webhooks (inbound)

`stripe/webhook`, `sms-reply` (Twilio), and the Supabase webhook endpoints all log every branch and persist failures to `error_logs`. M5 covers the one weak link.

### Files in critical paths with intentionally zero `console.*`

These came up in grep but the absence is correct, not a gap:

- **[src/app/api/admin/doctor/route.ts](src/app/api/admin/doctor/route.ts)** — returns structured JSON; every check is a row in the response. Logging would be redundant.
- **[src/app/api/admin/scraper-instances/route.ts](src/app/api/admin/scraper-instances/route.ts)** — fleet topology endpoint, pure read.
- Most `/api/admin/**` diagnostic routes — same pattern: structured JSON response is the log.

---

## Log floods

### F1 — `morning-resend` per-housekeeper SMS-failure logging

**Location:** [src/app/api/morning-resend/route.ts:244](src/app/api/morning-resend/route.ts)

```ts
try {
  await sendSms(phone164, msg);
} catch (err) {
  console.error(`Morning resend SMS failed for ${hk.staff_name}:`, errToString(err));
}
```

This runs inside a `Promise.allSettled` over confirmed housekeepers. Worst case: a regional carrier outage at a 30-staff property emits 30 error lines in one cron run. Multiplied across the fleet during a wide outage, this can put thousands of lines on the same incident in Sentry's inbox.

(This is also H2 above for the PII angle. The fix covers both.)

**Fix:** Collect failures into an array and emit one summary log:

```ts
const failures: string[] = [];
// ... inside the loop:
} catch (err) {
  failures.push(hk.id);
}
// ... after Promise.allSettled:
if (failures.length > 0) {
  console.error(`[morning-resend] SMS send failed for ${failures.length} staff: ${failures.join(',')}`);
}
```

### F2 — `morning-resend` per-rejection logging

**Location:** [src/app/api/morning-resend/route.ts:252-254](src/app/api/morning-resend/route.ts)

```ts
for (const r of results) {
  if (r.status === 'rejected') console.error('[morning-resend] HK rejection:', r.reason);
}
```

Same shape, same fix: aggregate then emit one summary.

### F3 — eval runner per-failure logging

**Location:** [src/lib/agent/evals/summarizer/runner.ts:168](src/lib/agent/evals/summarizer/runner.ts)

```ts
if (!pass) {
  for (const f of failures) console.log(`   · ${f}`);
}
```

Eval harness, not production — risk is low. Flagged for consistency. The harness is run manually and the output is meant to be human-readable, so this might be the right call; mentioning it here so the next reviewer knows it was considered.

---

## Log level inconsistencies

### L1 — `console.error` on a graceful fallback

**Location:** [src/app/api/send-shift-confirmations/route.ts:392](src/app/api/send-shift-confirmations/route.ts)

```ts
console.error('[send-shift-confirmations] magic-link mint failed, falling back to tokenless URL:', errToString(linkErr));
```

This is a degraded-UX fallback (SMS still sends, just without a deep-link token). The surrounding comment confirms the intent: "degraded UX (polling, no realtime) is strictly better than no SMS at all." Logging it as `error` pages on-call for something the user never notices.

**Fix:** Downgrade to `console.warn`.

### L2 — Codebase-wide error/warn skew

Counts across `src/` (production code only, tests excluded):

| Level | Calls | Share |
|---|---|---|
| `console.error` | 186 | 82.3% |
| `console.warn` | 34 | 15.0% |
| `console.log` | 6 | 2.7% |

The cause is documented in the codebase itself, at [src/lib/api-ratelimit.ts:187-195](src/lib/api-ratelimit.ts):

```ts
// ── Fail-open visibility (May 2026 audit pass-3) ──────────────
// Production safety default: a Postgres hiccup must NOT block all
// SMS sends. But the old code was a console.warn — invisible in
// Vercel's log noise, completely undetected at fleet scale.
// Promoted to log.error so it lands in Sentry + the doctor's
// logging surface, with the endpoint + property tagged so
// dashboards can chart "how many fail-opens did the SMS pipeline
// eat today, on which routes".
```

Operators have learned that `warn` is invisible, so authors promote everything to `error`. This is sustainable in the short term but means real outages compete with degraded-but-fine events for on-call attention.

**Fix (gradual):** route non-actionable signals through `log.warn` from [src/lib/log.ts](src/lib/log.ts) (already JSON-structured, queryable, and ignored by Sentry by default — exactly the right place for "loud but expected" events). Reserve `console.error` for "user is impacted right now."

This is hygiene, not a security fix; bundle it with the next observability pass rather than now.

---

## Sentry / observability gaps

### S1 — Edge runtime missing `beforeSend`

Already covered as H3 above.

### S2 — No per-route trace sampling

`sentry.server.config.ts:28` sets a global `tracesSampleRate: 0.1`. High-QPS endpoints (`/api/events`, `/api/sms-reply`, `/api/scheduler/tick`) share this budget with low-volume admin routes. Under load, traces from the noisy endpoints crowd out the ones we'd actually want.

**Fix:** `tracesSampler` callback that drops or down-samples by route. Not urgent — current Sentry spend is modest — but worth doing before traffic grows. Pair with the existing `ignoreErrors` config which already filters transient `fetch failed` noise from `/api/admin/build-status`.

### Not a gap — CUA service

The Explore agent flagged the CUA service as bypassing its structured logger. After verification: every `.ts` file in `cua-service/src/` has zero direct `console.*` calls (verified by `grep -c "console\." cua-service/src/*.ts`). The one `console.error` in `cua-service/src/browser-utils/text.js:63` runs inside the headless browser DOM (Anthropic computer-use), not the Node worker, so it can't and shouldn't go through Sentry. The CUA logger ([cua-service/src/log.ts](cua-service/src/log.ts)) is in good shape and the existing comments explain its design choices (warn stays in Fly logs, error captures to Sentry).

---

## Recommendations (prioritized)

### Priority 1 — Security / compliance

1. **H1** — drop `normalizedEmail` from the error string in [src/app/api/auth/accounts/route.ts:241](src/app/api/auth/accounts/route.ts).
2. **H2** — replace `hk.staff_name` with `hk.id` in [src/app/api/morning-resend/route.ts:244](src/app/api/morning-resend/route.ts).
3. **H3** — add `beforeSend: scrubSentryEvent` to [sentry.edge.config.ts](sentry.edge.config.ts).
4. **M1** — drop or last-4-redact `customerId` in [src/app/api/stripe/webhook/route.ts:170](src/app/api/stripe/webhook/route.ts).

### Priority 2 — Debuggability

5. **M2-M5** — add a `console.error` inside the four silent `} catch {}` blocks so `error_logs` outages aren't invisible.
6. **F1, F2** — aggregate per-iteration failures in `morning-resend` and emit one summary line per cron run.

### Priority 3 — Hygiene (do alongside next observability pass)

7. **L1** — downgrade [src/app/api/send-shift-confirmations/route.ts:392](src/app/api/send-shift-confirmations/route.ts) to `console.warn`.
8. **L2** — define a triage rubric (impacted? → error, expected-but-fix-eventually? → warn, operational signal? → info) and migrate `console.*` calls to `src/lib/log.ts` as files are touched. Don't do a big-bang rewrite.
9. **S2** — implement `tracesSampler` once `/api/events` and `/api/sms-reply` start dominating the Sentry trace quota.
10. Consider an ESLint rule that flags `console.*` containing identifiers whose names match `/email|name|phone|customer|token|secret|key/i` to catch new H1/H2-class leaks at PR time.

---

## Notes on what was NOT found

For completeness, I went looking for these and didn't find them:

- **Plaintext passwords / hashes in logs.** None. Auth helpers route through Supabase Auth, which returns opaque error codes, not credential material.
- **Stripe PAN / CVV in logs.** None. Card data never touches our server (Stripe Checkout handles it client-side).
- **API keys in logs.** None. `process.env.*_KEY` / `*_SECRET` values are referenced for outbound calls only, never interpolated into log strings.
- **Session IDs / cookies in logs.** None. The cookie scrubber in `sentry-scrub.ts` is a belt-and-suspenders layer — no caller is currently logging them.
- **Tight loops over user-supplied data (DoS-shaped log floods).** The only loops with per-iteration logging operate over bounded sets (housekeepers at one property, eval cases at one harness run).

---

*End of audit.*
