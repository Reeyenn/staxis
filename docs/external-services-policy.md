# External Services Policy

Conventions for any call that leaves the Next.js / CUA-worker / ML-service processes.

Background: in May 2026 we audited every external call ([.claude/reports/external-api-audit.md](../.claude/reports/external-api-audit.md)) and found 8 hardening gaps across 52 call sites. The root causes were always the same — "rules not written down, so each new author reinvents the mistake." This doc IS the written-down rules.

## 1. SDK client timeouts

When you instantiate `new Anthropic({...})`, `new Stripe(...)`, or any vendor SDK in a Vercel function, pass an **explicit `timeout`** and **explicit retry count** sourced from [src/lib/external-service-config.ts](../src/lib/external-service-config.ts).

```ts
// Good
import { ANTHROPIC_REQUEST_TIMEOUT_MS, ANTHROPIC_MAX_RETRIES } from '@/lib/external-service-config';
new Anthropic({ apiKey, timeout: ANTHROPIC_REQUEST_TIMEOUT_MS, maxRetries: ANTHROPIC_MAX_RETRIES })

// Bad — SDK defaults blow past Vercel's function ceiling
new Anthropic({ apiKey })

// Bad — raw number bypasses the policy
new Anthropic({ apiKey, timeout: 50_000, maxRetries: 1 })
```

Background workers (CUA on Fly, ML service on Fly) have different ceilings and use their own constants — but they're still explicit. See [cua-service/src/anthropic-client.ts](../cua-service/src/anthropic-client.ts) for an example.

## 2. Outbound HTTP fetch

Every `fetch(url, ...)` to an external host goes through `externalFetch` from [src/lib/external-service-config.ts](../src/lib/external-service-config.ts). It enforces a timeout signal and (optionally) composes with a caller-provided `abortSignal` via `AbortSignal.any`.

```ts
// Good
import { externalFetch, EXTERNAL_FETCH_TIMEOUT_MS } from '@/lib/external-service-config';
const res = await externalFetch(url, { method: 'POST', body, timeoutMs: EXTERNAL_FETCH_TIMEOUT_MS });

// Bad — raw fetch with no signal hangs indefinitely on upstream failure
const res = await fetch(url, { method: 'POST', body });

// Bad — `signal: req.signal` alone disables the timeout safety net
const res = await fetch(url, { signal: req.signal });
```

To forward a client-disconnect signal, pass it as `abortSignal` (not `signal`):

```ts
const res = await externalFetch(url, {
  method: 'POST',
  body,
  abortSignal: req.signal,           // composes with the timeout
  timeoutMs: EXTERNAL_FETCH_TIMEOUT_MS,
});
```

## 3. Observability writes

Inserts into `error_logs`, `webhook_log`, and `app_events` go through helpers in [src/lib/event-recorder.ts](../src/lib/event-recorder.ts) — `recordErrorLog`, `recordWebhookLog`, `recordAppEvent`. They never throw, always log structured `event_insert_failed` on Supabase error, and rate-limit Sentry escalation so a sustained outage doesn't flood the issue queue.

```ts
// Good
import { recordErrorLog } from '@/lib/event-recorder';
await recordErrorLog({ source: '/api/foo', message: errToString(err), stack: err.stack });

// Bad — silent failure on Supabase outage
try { await supabaseAdmin.from('error_logs').insert({...}); } catch {}
```

`admin_audit_log` writes go through [`writeAudit`](../src/lib/audit.ts) (older but functionally equivalent — same safe pattern).

## 4. Distributed rollbacks need a reconciler

If you write a 2-step "external action → DB insert" with a rollback path, the rollback path CAN ALSO FAIL. Catching the rollback failure silently leaves orphan state.

Pattern:
1. Log the rollback failure loudly (`console.error` with a structured prefix) AND `captureException` so on-call gets paged.
2. Add a reconciler cron that scans for orphan state, deletes it (or alerts on it), and runs at a cadence shorter than the user's likely re-attempt window.

Reference implementations:
- `sweep-orphan-auth-users` ([src/app/api/cron/sweep-orphan-auth-users/route.ts](../src/app/api/cron/sweep-orphan-auth-users/route.ts)) — reconciles auth users without app rows
- `agent-sweep-reservations` — reconciles stuck cost reservations
- `process-sms-jobs` — reconciles stuck SMS jobs

Wire new crons into:
- [vercel.json](../vercel.json) (`crons[]`)
- `EXPECTED_CRONS` in [src/app/api/admin/doctor/route.ts](../src/app/api/admin/doctor/route.ts) (so the doctor monitors freshness)
- `SCHEDULE_REGISTRY` in [src/lib/cron-schedule-registry.ts](../src/lib/cron-schedule-registry.ts) (cadence drift guard)

The [`cron-coverage.test.ts`](../src/lib/__tests__/cron-coverage.test.ts) test fails the build if any of those are missing.
