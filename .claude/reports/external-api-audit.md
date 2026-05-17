# External API Call Audit

**Branch:** `audit/external-api-calls`
**Generated:** 2026-05-17
**Scope:** Every call that leaves the Next.js, CUA-worker (Fly), or ML-service (Fly) processes. SDK calls, raw `fetch()`, GraphQL, queue/pubsub, and outbound webhooks. Test files excluded. Same-origin frontend `fetch('/api/...')` calls noted briefly at the end but not in the main table — they don't leave the deployed origin.

**Verification method:** Every row was confirmed by reading the file at the cited line in the current `main`-based tree. Earlier exploration agents referenced some now-removed code (e.g. OpenAI Whisper/TTS — that surface was ripped out by commit eb47c8c and replaced with ElevenLabs); only verified call sites appear below.

---

## Audit table

Legend for the **Flags** column:
- ❌ **no-timeout** — request can hang indefinitely (fetch default has no timeout; SDK default is generous)
- ⚠️ **no-retry** — single attempt; one transient blip = total failure
- 🚨 **silent-failure** — failure is swallowed without surfacing to user, logs, or Sentry
- ✅ **hardened** — explicit timeout AND defined failure path AND logged
- ⚙️ **diagnostic** — admin/operator-only call; user impact bounded

### 1. Anthropic (LLM + vision + walkthrough + CUA mapper)

| # | Purpose | File:line | Timeout | Retry | Failure behavior | Logged? | Hot path? | Response validated? | Flags |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Main agent chat (streaming) | [llm.ts:736](src/lib/agent/llm.ts:736) via [agent/command](src/app/api/agent/command/) | 50s (client) | 1 retry (client) — worst case ~100s wall clock | try/catch in route; SSE error event; cost reservation cleanup in finally | Sentry `captureException` with error classification | **Yes** — every chat turn | Tool use parsing + max 8 iterations + 5 tools/iter guardrails | ✅ |
| 2 | Main agent sync variant (tests/evals) | [llm.ts:527](src/lib/agent/llm.ts:527) | 50s | 1 retry | Same as streaming variant | Same | No (tests only) | Same | ✅ |
| 3 | Vision OCR / photo count | [vision-extract.ts:178](src/lib/vision-extract.ts:178) via [scan-invoice](src/app/api/inventory/scan-invoice/) | 30s (client) | **SDK default = 2** (no explicit `maxRetries`) — worst case ~90s | throws `VisionImageInvalidError`/`VisionTruncatedError`/`VisionSchemaError`; route handler maps to 400/422/503 | Sentry `captureException` | **Yes** — every invoice scan + photo count | Magic-byte image validation pre-call; stop_reason truncation guard; JSON schema check | ⚠️ retry-on-default |
| 4 | Walkthrough step (Sonnet, 1 call per click) | [walkthrough/step/route.ts:400](src/app/api/walkthrough/step/route.ts:400) — client at [:98](src/app/api/walkthrough/step/route.ts:98) | **none** (`new Anthropic({ apiKey })`) | **SDK default = 2** (no explicit `maxRetries`) | try/catch → 502 "AI service unavailable"; cost reservation released | `log.error` | **Yes** — every walkthrough step | Forced `emit_step` tool_use response parsed and validated | 🚨 ❌ no-timeout, retry-on-default |
| 5 | CUA login mapper | [mapper.ts:386](cua-service/src/mapper.ts:386) — client at [anthropic-client.ts:36](cua-service/src/anthropic-client.ts:36) | 120s (client) | 1 retry (client) | try/catch in mapper loop; error_detail blob persisted to `onboarding_jobs` (credentials scrubbed); per-turn deadline + cost-cap checks abort early | Job row + Sentry on hard failure | No — background CUA worker | Usage tokens extracted, content parsed as JSON | ✅ |
| 6 | CUA action mapper | [mapper.ts:596](cua-service/src/mapper.ts:596) | 120s (same client) | 1 retry (same client) | Same as login mapper | Same | No — background | Same | ✅ |

### 2. ElevenLabs (voice)

| # | Purpose | File:line | Timeout | Retry | Failure behavior | Logged? | Hot path? | Response validated? | Flags |
|---|---|---|---|---|---|---|---|---|---|
| 7 | Mint signed Conversational AI WebSocket URL | [voice-session/route.ts:132](src/app/api/agent/voice-session/route.ts:132) | **none** | None | try/catch → 502 "voice service unreachable" | `log.error` with status + body snippet | **Yes** — every voice session start | Checks `payload.signed_url` exists | 🚨 ❌ no-timeout |
| 8 | Walkthrough TTS (Jessica, eleven_turbo_v2_5) | [agent/speak/route.ts:142](src/app/api/agent/speak/route.ts:142) | **none** server-side; `signal: req.signal` (client-driven only) | None | try/catch → 502; AbortError → 499; non-OK → captureException + 502 | `log.warn` with upstream status + body snippet + Sentry | **Yes** — every walkthrough narration | Checks `ttsResponse.body` exists; route streams bytes through | ❌ no-server-timeout (client can abort) |

### 3. Stripe (billing)

| # | Purpose | File:line | Timeout | Retry | Failure behavior | Logged? | Hot path? | Response validated? | Flags |
|---|---|---|---|---|---|---|---|---|---|
| 9 | SDK init | [stripe.ts:38](src/lib/stripe.ts:38) | **SDK default (80s)** — no explicit `timeout` | **SDK default = 0** for idempotent reqs; auto-retry on Stripe-side 5xx | N/A — init only | N/A | N/A | `apiVersion: '2025-04-30.basil'` pinned | ⚠️ retry-on-default |
| 10 | `customers.create` | [stripe.ts:100](src/lib/stripe.ts:100) | SDK default | SDK default | try/catch → `{ok:false, error}` | Error message returned to caller | No — signup only | TypeScript types validate `customer.id` | ✅ |
| 11 | `checkout.sessions.create` | [stripe.ts:147](src/lib/stripe.ts:147) | SDK default | SDK default | Same | Same | No — checkout button | Validates `session.url` exists before returning | ✅ |
| 12 | `billingPortal.sessions.create` | [stripe.ts:186](src/lib/stripe.ts:186) | SDK default | SDK default | Same | Same | No — portal button | TypeScript types | ✅ |
| 13 | `webhooks.constructEvent` (signature verify) | [stripe.ts:206](src/lib/stripe.ts:206) | N/A (sync, crypto only) | N/A | try/catch → `{ok:false, error}` | Returns 400 on bad sig | Background (webhook handler) | Signature check IS the validation | ✅ |
| 14 | Stripe webhook handler — idempotency insert + handleEvent | [stripe/webhook/route.ts:73-126](src/app/api/stripe/webhook/route.ts:73) | 15s (maxDuration) | Stripe retries 5xx for 3 days; deletes dedupe row on handler throw so retry can succeed | Dedupe table unhealthy → 500; duplicate → 200 deduped; handler throw → delete dedupe + 500 | `console.error` on dedupe failure + handler throw | Background | Strict `.insert().select().maybeSingle()` confirms row landed | ✅ |

### 4. Twilio (SMS)

| # | Purpose | File:line | Timeout | Retry | Failure behavior | Logged? | Hot path? | Response validated? | Flags |
|---|---|---|---|---|---|---|---|---|---|
| 15 | `sendSms` — outbound SMS (shift confirms, watchdog, help, Sentry alert) | [sms.ts:40](src/lib/sms.ts:40) | **none** (raw `fetch` with no `signal`) | None at fetch level; sms-jobs queue retries with backoff [30s, 2m, 5m] then dead-letters | Throws on `!res.ok` (parses Twilio error JSON); sms-jobs caller catches | sms-jobs writes per-job error to DB; route-direct callers (sentry-webhook) `log.error` + captureException | **Yes** — every SMS send | `res.ok` check; Twilio error code surfaced | 🚨 ❌ no-timeout (mitigated by sms-jobs queue for cron path; raw-call path in sentry-webhook is not mitigated) |
| 16 | `twilio.validateRequest` — inbound webhook sig | [sms-reply/route.ts:77](src/app/api/sms-reply/route.ts:77) | N/A (sync HMAC) | N/A | Returns `false` → route 403 | Webhook event recorded to `webhook_log` regardless | Background webhook | Boolean signature match | ✅ |
| 17 | Doctor check: account active | [doctor/route.ts:813](src/app/api/admin/doctor/route.ts:813) | 10s | None | Caught → Check `fail`/`warn` | Doctor result + Sentry `captureMessage` on fail | No — diagnostic | `status` field checked for suspended/closed | ⚙️ ✅ |
| 18 | Doctor check: balance | [doctor/route.ts:873](src/app/api/admin/doctor/route.ts:873) | 10s | None | Caught → Check `warn`; warn band emits Sentry directly (bypass alert-decision) | Same + Sentry warn-band emit | No — diagnostic (5min Railway watchdog) | `balance` parsed; FAIL_BELOW=$5, WARN_BELOW=$10 (env-tunable) | ⚙️ ✅ |
| 19 | Doctor check: from-number registered + SMS-capable | [doctor/route.ts:986](src/app/api/admin/doctor/route.ts:986) | 10s | None | Caught → Check `fail`/`warn` | Same | No — diagnostic | `incoming_phone_numbers` list parsed; `capabilities.sms` checked | ⚙️ ✅ |
| 20 | Diagnose: list phone numbers | [diagnose/route.ts:39](src/app/api/admin/diagnose/route.ts:39) | **none** | None | try/catch → `{error: …}` returned to admin UI | Returned in API response only | No — admin diagnostic | JSON parsed, fields mapped | ⚙️ ❌ no-timeout |
| 21 | Diagnose: list recent messages | [diagnose/route.ts:65](src/app/api/admin/diagnose/route.ts:65) | **none** | None | Same | Same | No — admin diagnostic | Same | ⚙️ ❌ no-timeout |

### 5. ML service (Railway/Fly Python)

| # | Purpose | File:line | Timeout | Retry | Failure behavior | Logged? | Hot path? | Response validated? | Flags |
|---|---|---|---|---|---|---|---|---|---|
| 22 | `triggerMlTraining` — POST `/train/{layer}` | [ml-invoke.ts:80](src/lib/ml-invoke.ts:80) | 45s (configurable) | None | **Never throws** — returns `{ok, status, error?}`; cron heartbeat picks up status | `log.info`/`log.warn` with `ml_train_invoked` event | No — fire-and-forget from cron + onboarding finalize | JSON parsed with fallback `{error: 'non_json_response'}`; `status` field checked | ✅ (fire-and-forget by design) |
| 23 | Cron daily inference — POST `/predict/demand` (stage 1) | [ml-run-inference/route.ts:92](src/app/api/cron/ml-run-inference/route.ts:92) | 45s | None per call; cron re-runs daily | try/catch → `{stage, status:'error', detail}`; `property_misconfigured:*` error string emits `app_events` row + skipped status; heartbeat blocks OK write if any stage errored | `log.info`/`log.error` per stage; structured event on misconfig | No — cron @ 05:30 CT | JSON parsed; `error` field + status both checked; non-JSON falls back to `{status:'non_json_response', http}` | ✅ |
| 24 | Cron daily inference — POST `/predict/supply` (stage 2) | Same closure as #23 | 45s | None | Same | Same | No — cron stage 2 | Same | ✅ |
| 25 | Cron daily inference — POST `/predict/optimizer` (stage 3) | Same closure as #23 | 45s | None | Same | Same | No — cron stage 3 (depends on 1+2) | Same | ✅ |
| 26 | Cron `/predict/inventory-rate` | [ml-predict-inventory/route.ts:93](src/app/api/cron/ml-predict-inventory/route.ts:93) | 75s | None | try/catch with property-misconfig parsing pattern | `log.info`/`log.error` | No — cron | Same JSON-parse-with-fallback pattern | ✅ |
| 27 | Cron `/train/inventory-priors`, `/train/demand-priors`, `/train/supply-priors` (3 parallel) | [ml-aggregate-priors/route.ts:60](src/app/api/cron/ml-aggregate-priors/route.ts:60) | 75s each | None | All-or-nothing heartbeat: only writes OK when all 3 succeed | `log.info` with all 3 results | No — cron | `status`/`error` fields checked per endpoint | ✅ |
| 28 | Admin manual `/predict/inventory-rate` | [admin/ml/inventory/run-inference/route.ts:63](src/app/api/admin/ml/inventory/run-inference/route.ts:63) | 55s | None | try/catch → 500 | `log.error` | No — admin button | JSON parsed | ⚙️ ✅ |
| 29 | Admin manual `/train/inventory-rate` | Calls `triggerMlTraining` (row 22) | 45s | None | Never throws | `log.info` | No — admin button | Same as row 22 | ⚙️ ✅ |

### 6. Railway scraper (PMS)

| # | Purpose | File:line | Timeout | Retry | Failure behavior | Logged? | Hot path? | Response validated? | Flags |
|---|---|---|---|---|---|---|---|---|---|
| 30 | POST `/scrape/hk-center` — pull live room status from PMS | [refresh-from-pms/route.ts:169](src/app/api/refresh-from-pms/route.ts:169) | 25s (AbortController) | None | try/catch → 502 `Could not reach Railway scraper`; non-JSON → 502; `!ok` → 502 with scraper error | `log.error` per failure mode with request id correlation | **Yes** — Mario's "Refresh from PMS" button + cron 15-min health pulse | JSON parsed; checks `ok` boolean + `rooms[]` shape | ✅ |

### 7. Resend (email)

| # | Purpose | File:line | Timeout | Retry | Failure behavior | Logged? | Hot path? | Response validated? | Flags |
|---|---|---|---|---|---|---|---|---|---|
| 31 | `sendTransactionalEmail` — POST `https://api.resend.com/emails` | [resend.ts:113](src/lib/email/resend.ts:113) | 15s (AbortSignal) | None | Never throws — returns `{ok:false, error}`; network errors and HTTP errors both caught | `writeAudit` to `admin_audit_log` (best-effort) on every outcome (success + every failure mode) | No — onboarding invites only; not user-blocking | Checks `payload.id` exists; non-JSON falls back to status code | ✅ |

### 8. GitHub API (admin build-status dashboard)

All GitHub calls use Next.js ISR caching (`next: { revalidate, tags }`) instead of explicit timeouts. Stale-while-revalidate degrades the dashboard but doesn't hang user requests.

| # | Purpose | File:line | Timeout | Retry | Failure behavior | Logged? | Hot path? | Response validated? | Flags |
|---|---|---|---|---|---|---|---|---|---|
| 32 | List closed (merged) PRs | [build-status/route.ts:155](src/app/api/admin/build-status/route.ts:155) | **none** (revalidate: 10s ISR) | None | `!res.ok → []`; wrapped in `.catch(() => [])` by caller | None | No — admin dashboard only | JSON array shape-checked, `merged_at` filter | ⚙️ ❌ no-timeout |
| 33 | List branches | [build-status/route.ts:196](src/app/api/admin/build-status/route.ts:196) | **none** (revalidate: 10s) | None | `!res.ok → []` | None | No — admin | JSON parsed | ⚙️ ❌ no-timeout |
| 34 | Per-branch `compare/main...{branch}` (parallel fan-out) | [build-status/route.ts:208](src/app/api/admin/build-status/route.ts:208) | **none** (revalidate: 10s) | None | Per-branch try/catch → null (skipped) | None | No — admin | `ahead_by`/`behind_by`/tip extracted | ⚙️ ❌ no-timeout |
| 35 | List recent commits on main | [build-status/route.ts:245](src/app/api/admin/build-status/route.ts:245) | **none** (revalidate: 10s) | None | `.catch(() => [])` by caller | None | No — admin | JSON array parsed | ⚙️ ❌ no-timeout |
| 36 | List open PRs | [build-status/route.ts:353](src/app/api/admin/build-status/route.ts:353) | **none** (revalidate: 30s) | None | `!res.ok → []` | None | No — admin | JSON array parsed | ⚙️ ❌ no-timeout |
| 37 | Per-commit check-runs (top 3 commits parallel) | [build-status/route.ts:395](src/app/api/admin/build-status/route.ts:395) | **none** (revalidate: 20s) | None | Per-commit try/catch → `checkStatus: null` | None | No — admin | Runs collapsed into `passed/failed/pending/neutral` | ⚙️ ❌ no-timeout |

### 9. Vercel & Fly.io (admin build-status)

| # | Purpose | File:line | Timeout | Retry | Failure behavior | Logged? | Hot path? | Response validated? | Flags |
|---|---|---|---|---|---|---|---|---|---|
| 38 | Vercel `/v6/deployments` | [build-status/route.ts:433](src/app/api/admin/build-status/route.ts:433) | **none** (revalidate: 15s) | None | try/catch → null (graceful fallback) | None | No — admin | `state` mapped to enum, `meta.githubCommitSha` extracted | ⚙️ ❌ no-timeout |
| 39 | Fly.io GraphQL `releases(first:3)` for `staxis-cua` | [build-status/route.ts:481](src/app/api/admin/build-status/route.ts:481) | **none** (revalidate: 15s) | None | try/catch → null | None | No — admin | `releases.nodes[0]` extracted; status mapped to BUILDING/ERROR/READY | ⚙️ ❌ no-timeout |

### 10. HSTS preload status (doctor)

| # | Purpose | File:line | Timeout | Retry | Failure behavior | Logged? | Hot path? | Response validated? | Flags |
|---|---|---|---|---|---|---|---|---|---|
| 40 | `hstspreload.org/api/v2/status?domain=getstaxis.com` | [doctor/route.ts:2389](src/app/api/admin/doctor/route.ts:2389) | 5s | None | Caught → Check `warn` | Doctor result | No — diagnostic (5min watchdog) | `status` field matched against `preloaded`/`pending` | ⚙️ ✅ |

### 11. Supabase (Postgres + Auth + Storage + RPC) — class summary

Supabase calls cluster into 4 surfaces with shared characteristics. ~60+ call sites across `src/`, `cua-service/src/`, and `ml-service/src/`.

| Surface | Pattern | Timeout | Retry | Failure behavior | Logged? | Validation | Notable sites |
|---|---|---|---|---|---|---|---|
| PostgREST (`.from().select/insert/update/delete`) | `const { data, error } = await call` | SDK default (no explicit) | SDK auth retries on 401 (token refresh); no retries on PostgREST errors | Caller checks `error` and either returns 500 or proceeds with `data` | Varies — some routes `captureException`, some `log.error`, some fire-and-forget (see Findings #3) | RLS enforced server-side; data shape via TypeScript types | See notable sites below |
| Auth admin (`.auth.admin.createUser/deleteUser/listUsers/generateLink/updateUserById/getUserById`) | Same `{data, error}` shape | SDK default | SDK auth retries | Caller checks; usually rollback path exists | Inconsistent — some `console.error`, some `.catch(() => {})` (see #4) | Email/password validated client-side | `auth/accounts/route.ts:191,235`, `auth/use-join-code/route.ts:185,207`, `auth/invites/route.ts:111`, `auth/accept-invite/route.ts:102,122`, `auth/team/route.ts:68,173`, `staff-auth.ts:82,110,185` |
| Storage (`.storage.from(bucket).upload/remove/download`) | Same `{data, error}` shape | SDK default | SDK retries | Caller checks; cleanup paths exist for upload-then-insert flows | `captureException` on critical paths | Content-type validated pre-upload | ML model artifacts (Python side) |
| RPC (`.rpc('proc_name', args)`) | Same `{data, error}` shape | SDK default | SDK retries | Caller checks; idempotency built into procs | `log.info`/`log.error` per call | Stored-procedure-level guards (e.g. `staxis_claim_sms_jobs` uses `FOR UPDATE SKIP LOCKED`) | `staxis_claim_sms_jobs`, `staxis_claim_next_job` (CUA), `staxis_walkthrough_step/end`, `staxis_sweep_stale_reservations`, etc. |

**Notable Supabase sites worth calling out individually:**

| # | Site | Why it stands out |
|---|---|---|
| 41 | Stripe webhook idempotency insert — [stripe/webhook/route.ts:73](src/app/api/stripe/webhook/route.ts:73) | Uses `.insert().select().maybeSingle()` strict pattern — refuses to process if dedupe table is unhealthy (returns 500 so Stripe retries). Strongest guarantee in the codebase. |
| 42 | CUA worker job claim — `supabase.rpc('staxis_claim_next_job')` in [cua-service/src/index.ts](cua-service/src/index.ts) | Server-side `FOR UPDATE SKIP LOCKED` atomic claim. Multi-worker safe. |
| 43 | `staxis_claim_sms_jobs` RPC — [sms-jobs.ts:172](src/lib/sms-jobs.ts:172) | Batch claim with watchdog reset of stuck jobs after 300s; dead-letter after max attempts. |
| 44 | Service-role preflight — [supabase-admin.ts:62-103](src/lib/supabase-admin.ts:62) | `verifySupabaseAdmin()` runs once per warm container; throws actionable error if key is stale. Catches the "rotated key, forgot Vercel" failure mode early. |
| 45 | Auth admin createUser → deleteUser rollback — [auth/accounts/route.ts:191,235](src/app/api/auth/accounts/route.ts:191), [auth/use-join-code/route.ts:185,207](src/app/api/auth/use-join-code/route.ts:185), [auth/accept-invite/route.ts:102,122](src/app/api/auth/accept-invite/route.ts:102) | Three places create an auth row, then insert app-side rows; if app-side insert fails, they delete the auth user. **The rollback uses `.catch(() => {})`** — silent on failure, see Findings #4. |
| 46 | Fire-and-forget `error_logs` / `webhook_log` / `app_events` inserts | See Findings #3. |

### 12. Sentry

| # | Purpose | File:line | Timeout | Retry | Failure behavior | Logged? | Hot path? | Response validated? | Flags |
|---|---|---|---|---|---|---|---|---|---|
| 47 | `captureException` (wrapped to lift property-id tags) | [sentry.ts:146-156](src/lib/sentry.ts:146) | SDK default (fire-and-forget) | Sentry SDK handles | Never throws — Sentry API is safe | N/A — Sentry IS the logger | Both hot and cold paths | Tags trimmed to 200 chars | ✅ |
| 48 | `captureMessage` | [sentry.ts:163-173](src/lib/sentry.ts:163) | SDK default | Sentry handles | Same | N/A | Diagnostic/audit | Message trimmed | ✅ |

### 13. Inbound webhooks we receive (called by external services)

These don't "leave the process" outbound, but a few make outbound calls in handlers worth flagging.

| # | Webhook | Outbound action it triggers | Hardening |
|---|---|---|---|
| 49 | `/api/stripe/webhook` | Supabase idempotency insert + handleEvent (Supabase reads/writes for property subscription_status) | ✅ strict dedupe, 15s maxDuration, signature verified |
| 50 | `/api/sms-reply` (Twilio inbound) | `sendSms()` for reply (rows 15) — no-timeout flag inherited | 🚨 inherits row 15 flag |
| 51 | `/api/sentry-webhook` | `sendSms()` to MANAGER_PHONE on alertable events — no-timeout flag inherited | 🚨 inherits row 15 flag; signature verified |
| 52 | `/api/github-webhook` | Inserts to `github_events` (Supabase) + `revalidateTag('github-data')` | ✅ signature verified, fast write |

---

## Findings / Risks — ordered by blast radius

### 🚨 1. BLAST = CRITICAL — Walkthrough Anthropic call has no timeout, defaults to 2 retries

**Where:** [src/app/api/walkthrough/step/route.ts:98](src/app/api/walkthrough/step/route.ts:98) — `_client = new Anthropic({ apiKey })`

The constructor passes no `timeout` and no `maxRetries`. The Anthropic SDK defaults are: no per-request timeout (effectively unbounded), `maxRetries: 2` with exponential backoff. A hung Anthropic request:
- Cannot be aborted by the route handler
- Is retried twice by the SDK with backoff (~2s, ~4s, plus jitter)
- Sits until Vercel's `maxDuration` (60s by default; this route doesn't override) kills the function

**Why CRITICAL blast:** the walkthrough is the onboarding path used by every new user the first time they touch the product. There's no fallback narration. When Anthropic has a regional incident, every walkthrough step hangs for 60s and then 502s — onboarding is unusable, and the failure mode is invisible to backend logs until the function timeout.

**Compare:** [llm.ts:245](src/lib/agent/llm.ts:245) (main agent) uses `{ apiKey, timeout: 50_000, maxRetries: 1 }` — a deliberate budget of ~100s worst case. The walkthrough config diverges from that pattern with no comment explaining why.

### 🚨 2. BLAST = HIGH — Twilio `sendSms` has no fetch timeout

**Where:** [src/lib/sms.ts:40](src/lib/sms.ts:40) — `await fetch(url, { method, headers, body })` with no `signal`.

`fetch()` has no default timeout in Node. If Twilio's API hangs, the call waits indefinitely.

**Mitigation that exists:**
- `sms-jobs` queue retries with backoff and dead-letters after max attempts — but only for the cron-driven path (`process-sms-jobs`).
- The watchdog cron has its own time budget.

**Mitigation that does NOT exist:**
- The `sentry-webhook → sendSms(MANAGER_PHONE, ...)` path at [sentry-webhook/route.ts:152](src/app/api/sentry-webhook/route.ts:152) calls `sendSms` directly. A hung Twilio API call here hangs the webhook handler indefinitely. Sentry will retry on its end, but each retry is parked waiting for Twilio.
- The inbound SMS reply path at `/api/sms-reply` also calls `sendSms` directly for replies.

**Why HIGH blast:** any failure mode that hangs Twilio (DNS, regional outage, account-level rate limit on the carrier side) cascades into every SMS-sending route, including the alerting path that's supposed to *tell* us about outages.

### ⚠️ 3. BLAST = HIGH — Silent fire-and-forget inserts to `error_logs` / `webhook_log` / `app_events`

Multiple routes write observability rows without checking the `error` field or capturing failures. Examples (not exhaustive — pattern is widespread):

- `error_logs` insertions during error-handling — if Supabase itself is the failure mode, the error log is also lost.
- `webhook_log` inserts from `sms-reply` and similar inbound handlers — record of inbound traffic disappears silently.
- `app_events` from ML cron when property is misconfigured — emitted via `emitPropertyMisconfiguredEvent` which (presumably) wraps an insert.

**Why HIGH blast:** these are the rows we look at *when something is wrong*. A Supabase outage silently corrupts our incident-response telemetry exactly when we need it. The Stripe webhook idempotency insert is the only route that treats this class of insert as load-bearing (it 500s when dedupe is unhealthy).

**Suggested follow-up:** an audit pass specifically on `error_logs` / `webhook_log` / `app_events` writes — they should all either `captureException` on insert failure or use a structured `console.error` line that Vercel's log drain can pick up.

### ⚠️ 4. BLAST = HIGH — Auth admin rollback silently swallows delete failures

**Where:**
- [auth/use-join-code/route.ts:207](src/app/api/auth/use-join-code/route.ts:207) — `await supabaseAdmin.auth.admin.deleteUser(authData.user.id).catch(() => {})`
- [auth/accept-invite/route.ts:122](src/app/api/auth/accept-invite/route.ts:122) — same pattern

These are the rollback paths when "create auth user → insert app row" fails partway. The rollback delete uses `.catch(() => {})`, so a failed rollback leaves an orphan auth user with no app-side account. The next signup attempt with the same email fails because the auth user already exists — and there's no log to point at the cause.

**Why HIGH blast:** quietly breaks specific user signups until manual cleanup, hard to diagnose without DB inspection. Limited blast in terms of *number* of users (only those hit by the partial failure) but each one is a stuck signup.

### ⚠️ 5. BLAST = MEDIUM — Vision Anthropic uses SDK-default retries (2)

**Where:** [vision-extract.ts:36](src/lib/vision-extract.ts:36) — `new Anthropic({ apiKey, timeout: 30_000 })` with no `maxRetries`.

30s timeout is fine, but the SDK retries twice on transient errors with exponential backoff. Worst case: ~30s × (1 + 2 backoff attempts that each wait their full timeout) ≈ 90s. Invoice scanning is a foreground operation — the user is staring at a spinner. 90s of spinner > a clean 30s timeout + retry message.

Compare to the main agent ([llm.ts:248](src/lib/agent/llm.ts:248)) which explicitly sets `maxRetries: 1` with the comment "maxRetries=2 would let us burn 150s, well over [the 60s Vercel ceiling]". The vision route has the same Vercel ceiling but doesn't apply the same logic.

### ⚠️ 6. BLAST = MEDIUM — ElevenLabs voice-session and speak have no server-side timeout

**Where:**
- [voice-session/route.ts:132](src/app/api/agent/voice-session/route.ts:132) — raw `fetch` with no `signal`
- [speak/route.ts:142](src/app/api/agent/speak/route.ts:142) — `signal: req.signal` (only aborts if the *client* disconnects)

ElevenLabs going slow → voice session mint hangs → user can't start a voice session. `speak` is less critical because the client can abort by closing the connection, but a server-side cap would be cleaner. The signed-URL fetch in particular has no fallback; if it hangs, voice is unusable.

### ⚠️ 7. BLAST = MEDIUM — Stripe SDK has no explicit timeout configured

**Where:** [stripe.ts:38](src/lib/stripe.ts:38) — `new Stripe(SECRET_KEY, { apiVersion, typescript, appInfo })` with no `timeout`.

The Stripe SDK default is 80 seconds. For `checkout.sessions.create` on the signup hot path, 80s of spinner is a bad UX. Stripe rarely has incidents — but when they do, the failure mode is "all checkouts hang 80s then 500."

### ⚠️ 8. BLAST = LOW — GitHub/Vercel/Fly admin fetches have no timeout

**Where:** All 8 fetches in [admin/build-status/route.ts](src/app/api/admin/build-status/route.ts) (rows 32–39).

Mitigated by Next.js ISR (`revalidate: 10s/15s/20s/30s`) — first request to a cold cache will block on the upstream, but subsequent requests serve stale-while-revalidating. Admin-only, so user-facing impact is bounded to the admin dashboard rendering slowly.

### ℹ️ Notable strengths (worth keeping)

- **Stripe webhook idempotency** — strict `insert().select().maybeSingle()` pattern with refusal-to-process on dedupe-table unhealth. This is the gold standard.
- **SMS dead-letter queue** — `sms-jobs.ts` retries with `[30s, 2m, 5m]` backoff and dead-letters after max attempts. The watchdog (300s stuck-job reset) is a nice belt-and-suspenders.
- **CUA worker safety** — 120s timeout + 1 retry + per-turn deadline check + cost cap + credential-scrubbed error_detail blob. The mapper.ts comment ("maxRetries was 2, but with backoff the SDK can spend up to ~360s on a single call") shows the team has thought about this trade-off.
- **Main agent cost-reservation cleanup** — `finally` block releases the reservation even when Anthropic throws. Worst-case attempt budget is explicitly documented in code comments.
- **Vision image validation** — magic-byte checks reject spoofed file types *before* the Anthropic call (saves cost on garbage uploads).
- **Resend `writeAudit` on every outcome** — both success and every failure mode write to `admin_audit_log`. Highest-quality observability of any external integration in the codebase.
- **`triggerMlTraining` never throws** — explicit design choice for fire-and-forget callers (onboarding finalize, cron). Failure surfaces via return value, not exception.
- **Doctor + watchdog 5-minute Twilio balance check** — added after a real "balance hit $4.51 silently" incident on 2026-05-14. Warn band emits to Sentry independently of alert-decision logic.

---

## Blast-radius ranking — one-liner per call site

Ordered from highest blast (every user request affected when service is down) to lowest (admin diagnostics).

1. **Supabase PostgREST** (rows 41–46 + class) — entire app reads/writes through this; outage = total outage. Hardening today: SDK auth retries on token refresh, preflight check on cold start.
2. **Anthropic main agent** (rows 1–2) — every chat turn. Hardening: 50s × maxRetries:1, cost reservation cleanup, classified Sentry. ✅
3. **Anthropic walkthrough** (row 4) — every walkthrough step for every new user during onboarding. **No timeout, retries-on-default.** 🚨 see Finding #1.
4. **Anthropic vision** (row 3) — every invoice scan + photo count. 30s timeout but retries-on-default. ⚠️ see Finding #5.
5. **Twilio `sendSms`** (row 15) — every shift confirmation, watchdog SOS, help request, Sentry alert. **No timeout.** Mitigated by sms-jobs queue for cron path only. 🚨 see Finding #2.
6. **ElevenLabs voice-session + TTS** (rows 7–8) — every voice chat start + walkthrough narration. **No server-side timeout.** ⚠️ see Finding #6.
7. **Railway scraper** (row 30) — Mario's "Refresh from PMS" + 15-min health pulse. 25s timeout + full failure path. ✅
8. **Stripe checkout / customer / portal** (rows 9–13) — signup + billing flows; not on every-request hot path but blocking when invoked. Mitigated by Stripe's own reliability. ⚠️ see Finding #7.
9. **Stripe webhook → Supabase** (row 14) — billing state replication. Strict idempotency, 3-day Stripe retry buffer. ✅
10. **ML service inference cron** (rows 23–25) — tomorrow's demand/supply/optimizer predictions. Daily cron with property-misconfig event emission; 45s timeout, no retry, but cron re-runs daily. ✅
11. **ML service inventory predict cron** (row 26) — daily inventory rate prediction. 75s, similar pattern. ✅
12. **ML service training fire-and-forget** (row 22) — onboarding finalize + cron training; never throws by design. ✅
13. **ML service priors aggregator** (row 27) — 3 parallel priors trains, all-or-nothing heartbeat. ✅
14. **Resend email** (row 31) — onboarding invites only; not user-blocking (link is also copyable in modal). 15s + writeAudit on every outcome. ✅
15. **CUA worker Anthropic** (rows 5–6) — background PMS mapping jobs only. 120s + cost cap + deadline check. ✅
16. **Sentry capture** (rows 47–48) — fire-and-forget observability; SDK handles delivery. ✅
17. **Twilio inbound signature validation** (row 16) — sync HMAC; sub-millisecond. ✅
18. **Stripe webhook signature verification** (row 13) — sync crypto. ✅
19. **GitHub/Vercel/Fly admin dashboards** (rows 32–39) — admin-only, ISR-cached. ⚠️ see Finding #8.
20. **Twilio doctor / diagnose** (rows 17–21) — admin diagnostic only; 10s timeout on doctor route, **no timeout on diagnose route**.
21. **HSTS preload status** (row 40) — 5s timeout, doctor diagnostic only. ✅

---

## Out of scope: same-origin `fetch('/api/...')` calls

A handful of frontend helpers do `fetch('/api/...')` without timeouts:
- `src/lib/db/housekeeper-helpers.ts` — `/api/housekeeper/rooms`, `/api/housekeeper/me`, `/api/housekeeper/save-language`
- Various page-level fetches in `app/laundry`, `app/housekeeper`, `app/signin`, `app/onboard`

These don't leave the deployed origin and are not part of this audit. Worth a separate pass for client-side hardening (offline UX, slow-3G timeouts, AbortController on unmount).

---

## Methodology notes

- Every row cited above was verified by reading the file at the cited line in the `audit/external-api-calls` branch on 2026-05-17.
- The Anthropic SDK defaults referenced (`maxRetries: 2`, no per-request timeout) are taken from the `@anthropic-ai/sdk` ^0.96.0 documentation as installed in this repo's `package.json`.
- The Stripe SDK default of 80-second timeout is from `stripe` ^22.1.1 docs.
- Supabase calls were summarized at class level by agreement — a per-call enumeration would yield 60+ rows with near-identical timeout/retry characteristics. Notable sites that diverge from the class pattern (idempotency insert, RPC claims, auth admin rollbacks) are listed individually.
- "Hot path" = invoked on a per-request user code path during normal operation. "Background" = cron, queue worker, or webhook handler.
- Test files and same-origin frontend `fetch` were excluded by design.
