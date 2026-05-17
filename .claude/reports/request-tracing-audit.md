# Request Tracing Audit

**Branch:** `audit/request-tracing`
**Date:** 2026-05-17
**Scope:** End-to-end data-flow tracing for the 3 highest-value user-facing flows in Staxis / HotelOps AI.
**Method:** Read-only static analysis. No tests executed, no infra touched. Findings are evidence-cited; "suggested probes" are wishlist, not implemented.

This audit complements `AUDIT_GAP_ANALYSIS.md` and `FAILSAFES.md` at repo root. Those cover feature coverage and existing guardrails. This one goes deeper on **data integrity** — type coercions, default values masking real errors, optimistic updates, cache reads, partial commits, and silent failures that don't surface to Sentry or to the user.

---

## Methodology & severity rubric

Each flow gets five subsections:

1. **End-to-end trace** — numbered steps with `file:line` evidence.
2. **Data shape transformations** — type coercions, default values, casts the next consumer assumes are safe.
3. **External dependencies** — every third-party call in the path with timeout/retry/idempotency posture.
4. **Risk register** — every step ranked by severity and visibility.
5. **Cross-cutting hazards** — multi-step failure modes (RLS, edge runtime, cache invalidation).

**Severity rubric:**

| Severity | Meaning |
|---|---|
| **P0** | Wrong data persisted, auth bypass, money or billing wrong, silent data loss for a paying hotel. |
| **P1** | User sees stale/wrong UI, async job stalls without surfacing, retries that double-write, missing audit trail, fail-open on safety check. |
| **P2** | Degraded UX, slow path, recoverable edge case, error-message quality. |

**Visibility:**

| Tag | Meaning |
|---|---|
| **silent** | No log line, no Sentry event, no error toast, no DB error column. The kind that bites in prod for weeks. |
| **loud** | Surfaces to Sentry, console.error, or user toast — easy to spot in monitoring. |

Sort order in each register: P0 silent → P0 loud → P1 silent → P1 loud → P2.

---

## Flow 1: Sign-In + 2FA Authentication

The platform's only entry point. Username + password → Supabase password auth → device-trust check → either go-straight-in OR email OTP → device trust optionally set → redirect to `/property-selector`.

### Trace

1. User lands on [src/app/signin/page.tsx](src/app/signin/page.tsx) (`SignInPage`). `useAuth()` hydrates from the localStorage-backed Supabase session via [AuthProvider's getSession() effect](src/contexts/AuthContext.tsx:95).
2. The auto-redirect effect at [src/app/signin/page.tsx:62-64](src/app/signin/page.tsx:62) sends a returning signed-in user straight to `/property-selector`, **but only if `signing === false`** — this guard exists because a fix on 2026-05-10 prevented a "flash dashboard then bounce back" race.
3. User submits the form. [src/app/signin/page.tsx:73-137](src/app/signin/page.tsx:73) runs `handleSubmit`:
   - L86: normalizes email → if no `@`, synthesizes `${trimmed}@staxis.local` (lets the bare-username investor account "test" sign in).
   - L87: calls `signIn(normalizedEmail, password)` from `AuthContext`, which delegates to [supabase.auth.signInWithPassword()](src/contexts/AuthContext.tsx:11).
4. On success, [src/app/signin/page.tsx:95-96](src/app/signin/page.tsx:95) calls `supabase.auth.getSession()` to extract `access_token` and POSTs it to `/api/auth/check-trust` ([src/app/signin/page.tsx:101-105](src/app/signin/page.tsx:101)).
5. **Server: trust check.** [src/app/api/auth/check-trust/route.ts:28-103](src/app/api/auth/check-trust/route.ts:28):
   - L28-35: Validates bearer JWT via `supabaseAdmin.auth.getUser(token)`.
   - L37-44: Looks up `accounts` row by `data_user_id`.
   - L48-50: **Shared-investor bypass** — if `accounts.skip_2fa` is true, returns `trusted=true` unconditionally (no cookie set/rolled).
   - L53-56: Reads the `staxis_device` HTTP-only cookie via [src/lib/trusted-device.ts:45-48](src/lib/trusted-device.ts:45).
   - L58-70: SHA-256 hashes the cookie, looks up `trusted_devices` keyed on `(account_id, token_hash)`.
   - L67-69: **On DB error, fail-closed** → `trusted=false` (correct security posture, but silent).
   - L72-74: Explicit expiry check on `expires_at`.
   - L77-80: Bumps `last_seen_at` — **the update result is never inspected** (silent failure).
   - L88-101: Re-issues the cookie with a fresh `maxAge` so an active user rolls forward indefinitely.
6. Client branches on `body.data?.trusted`:
   - **Trusted path:** [src/app/signin/page.tsx:115-119](src/app/signin/page.tsx:115) drops `signing` guard, useEffect at L62 fires `router.replace('/property-selector')`. Done.
   - **Untrusted path:** [src/app/signin/page.tsx:122](src/app/signin/page.tsx:122) calls `supabase.auth.signOut()` (drops the password-issued session), then [L123-126](src/app/signin/page.tsx:123) calls `signInWithOtp({ email, shouldCreateUser: false })`, then [L132](src/app/signin/page.tsx:132) `router.replace('/signin/verify?email=…')`.
7. On `/signin/verify` ([src/app/signin/verify/page.tsx](src/app/signin/verify/page.tsx)):
   - L29: Reads `email` from URL search params.
   - L34: `postSignup=1` query param auto-trusts the device and hides the "Trust this device" checkbox (signup just proved email ownership).
   - L46-56: `supabase.auth.verifyOtp({ email, token, type: 'email' })` → fresh session.
   - L64-75: If "trust this device" was checked, POST `/api/auth/trust-device` with bearer. **The fetch failure is caught and swallowed** (non-fatal warning only).
8. **Server: trust-device.** [src/app/api/auth/trust-device/route.ts:28-86](src/app/api/auth/trust-device/route.ts:28):
   - L31-38: Bearer → getUser → accounts row lookup.
   - L49-51: Generates a 32-byte random token, SHA-256 hashes it, computes expiry (TRUST_DURATION_DB_MS = 10 years).
   - L52-55: Captures user-agent + first X-Forwarded-For IP.
   - L57-63: **INSERT** (not UPSERT) into `trusted_devices`.
   - L66-69: On insert error, returns 500 — but this is the only loud failure mode.
   - L76-84: Sets the `staxis_device` httpOnly cookie via `trustCookieOptions()`.
9. User lands on `/property-selector`.

### Data shape transformations

| Step | Coercion / Default | Risk |
|---|---|---|
| signin:86 | `trimmed.includes('@') ? trimmed : '${trimmed}@staxis.local'` | A leading `+` or unusual whitespace passes through `trim().toLowerCase()` unchecked. Two users `foo@bar.com` and `Foo@bar.com` map to same synthetic key — Supabase canonicalizes anyway. |
| signin:107 | `body.data?.trusted` typed via `as { data?: { trusted?: boolean } }` | Server response shape is **not validated at runtime**. A future server change to `{trusted: 'yes'}` would coerce via `!!` to true silently. |
| check-trust:65 | `data.language === 'es' \|\| data.language === 'en' ? data.language : null` (similar pattern across handlers) | Unknown enums quietly collapse to null. |
| trust-device:53-55 | `req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? req.headers.get('x-real-ip') ?? null` | The first comma-separated value can be spoofed by any upstream that doesn't strip headers. IP is informational only, but logged. |
| trusted-device:36-38 | `randomBytes(32).toString('hex')` | 256 bits of entropy — strong. |
| api-auth:74-90 | Unverified base64-decode of JWT payload for diagnostic logging only | Used after validation has already failed — no security boundary, but a malformed payload could log garbage values. |
| AuthContext:65-72 | `(data.role ?? 'staff') as AppUser['role']`, `propertyAccess: role === 'admin' ? ['*'] : (data.property_access ?? [])` | If `role` is anything other than 'admin', the user falls back to `propertyAccess = []` — a corrupted role string ("Admin" with capital A) silently downgrades the user to no access. |

### External dependencies

| Service | Where | Timeout | Retry | Idempotency | Failure surface |
|---|---|---|---|---|---|
| **Supabase Auth** (`signInWithPassword`, `signInWithOtp`, `verifyOtp`, `getUser`) | signin, verify, check-trust, trust-device, api-auth | SDK default (~30s) | None client-side | Idempotent reads; OTP send is not idempotent | Errors surface as `error.message` on client, classified via [classifySessionFailure](src/lib/api-auth.ts:103) server-side. `auth_unavailable` (5xx) is the only "transient" category. |
| **Resend** (delivers Supabase OTP email via custom SMTP) | Implicit in `signInWithOtp` | Resend SLA | Supabase retries on its side | Supabase dedups by `(email, token)` window | If Resend rejects, `signInWithOtp` returns an error — surfaced to the user as a friendly toast. If Resend silently accepts but doesn't deliver, **user sees no error** and waits indefinitely. |
| **Vercel Edge / Cloudflare** (cookie domain + edge cache) | Cookie setting from `/api/auth/trust-device` | n/a | n/a | n/a | A misconfigured cookie domain (e.g., apex vs subdomain mismatch) leaves the cookie unreadable by `check-trust`, forcing OTP every login. Reproduces silently. |
| **Browser localStorage** (Supabase session storage, key `staxis-auth`) | All sessions | n/a | n/a | n/a | Private-mode browsing or localStorage quota blocks persistence — user must sign in every page load. Caught at [supabase.ts:23-89](src/lib/supabase.ts:23). |

### Risk register

| # | Risk | Severity | Visibility | Evidence | Suggested probe |
|---|---|---|---|---|---|
| 1 | `trust-device` INSERTs a new row every time, never UPSERTs. A user who rotates devices, clears cookies, or uses incognito periodically accumulates rows in `trusted_devices` per account — unbounded growth. | P1 | silent | [trust-device/route.ts:57-63](src/app/api/auth/trust-device/route.ts:57) | Periodic SQL: `select account_id, count(*) from trusted_devices group by 1 order by 2 desc limit 20` — flag accounts > 50. |
| 2 | `check-trust` updates `last_seen_at` without awaiting or checking the result. A DB failure here means the trust window stops rolling forward; user gets prompted for OTP earlier than expected. No log line. | P1 | silent | [check-trust/route.ts:77-80](src/app/api/auth/check-trust/route.ts:77) | Add `.then(({ error }) => { if (error) log.warn(...) })`. |
| 3 | OTP email delivery via Resend has no app-side delivery confirmation. If Resend accepts the message but doesn't deliver (deliverability issue, blocklist, hard bounce), the user sees nothing — the OTP screen just sits there. | P1 | silent | [signin/page.tsx:123-131](src/app/signin/page.tsx:123) | Pull a Resend webhook into a new `email_events` table; surface a "resend code" button after 60s with no inbox activity. |
| 4 | `body.data?.trusted` is parsed via a TypeScript cast with no runtime validation. A future server change to the response envelope shape would silently flip every user into "untrusted" or, worse, "always trusted." | P1 | silent | [signin/page.tsx:107-108](src/app/signin/page.tsx:107) | Zod-style runtime guard, or a shared `ApiResponse<T>` parser. |
| 5 | `postSignup=1` URL param auto-trusts the device with no IP/UA fingerprint check. Anyone who can intercept the post-signup redirect URL (browser extension, malicious local proxy) gets a permanent trusted-device cookie on the attacker's machine. | P1 | silent | [signin/verify/page.tsx:34, 155](src/app/signin/verify/page.tsx:34) | At minimum, require the trust-device call to verify the session was created within the last 60s. |
| 6 | `trustCookieOptions()` sets `sameSite: 'strict'`. Strict can break sign-in redirects from external links (email "click to sign in" lands on the wrong-cookie state). Mitigation: post-sign-in is same-origin so this rarely surfaces. | P2 | loud | [trusted-device.ts:55](src/lib/trusted-device.ts:55) | Verify magic-link click from a Gmail tab still finds the cookie. |
| 7 | `signin/page.tsx` re-render race fixed 2026-05-10 — the `signing` flag guards the auto-redirect. Relies on React batching: if `signIn` synchronously triggers `onAuthStateChange` BEFORE `setSigning(false)`, the redirect fires too early. Currently fine, but a future Supabase SDK change could re-introduce. | P2 | silent | [signin/page.tsx:62-64](src/app/signin/page.tsx:62) | Cypress test: type creds, intercept the check-trust response, assert no `/property-selector` navigation before verify. |
| 8 | The `accounts` lookup in `loadAppUser` goes through the **browser anon client** ([AuthContext.tsx:52-57](src/contexts/AuthContext.tsx:52)). If the RLS policy for `accounts` self-read is ever tightened, every authenticated user gets the "orphaned auth user → sign out" path silently. Self-inflicted lockout. | P1 | loud | [AuthContext.tsx:104-108](src/contexts/AuthContext.tsx:104) | Verify the `accounts` RLS policy includes a `select` rule for `data_user_id = auth.uid()`. |
| 9 | The synthetic `${username}@staxis.local` collision space depends on uniqueness of the `username` column in `accounts`. If the unique constraint were ever dropped (or two rows seeded outside the signup flow), two users could collide. | P1 | silent | [AuthContext.tsx:11](src/contexts/AuthContext.tsx:11) | Confirm `accounts.username` unique constraint in `0001_initial_schema.sql`. |
| 10 | `check-trust` returns `trusted=false` on a DB error (fail-closed) but the client treats that as "fall through to OTP" with no telemetry. A persistent DB hiccup looks like "everyone needs OTP today" — Sentry sees nothing because the route returned 200. | P2 | silent | [check-trust/route.ts:67-69](src/app/api/auth/check-trust/route.ts:67) | Count OTP sends vs trusted-pass: a sudden ratio shift is the canary. |

### Cross-cutting hazards

- **Session/cookie state straddles 3 surfaces** (Supabase localStorage `staxis-auth`, `staxis_device` cookie, `trusted_devices` row). All three can drift independently: a user who clears cookies but keeps localStorage will get the OTP-on-every-login experience without any log line telling ops "trust state was reset client-side."
- **Edge vs Node runtime**: both `check-trust` and `trust-device` explicitly set `runtime = 'nodejs'` because `supabaseAdmin` (service-role key) MUST NOT ship to the edge. A future careless edit could relax this and leak the service-role key into the edge bundle.
- **Cookie domain on `getstaxis.com`** vs Vercel preview deploys: previews on `*.vercel.app` won't share the trust cookie with prod. By design, but means QA on a preview always tests the OTP path, never the trusted path.

---

## Flow 2: Property Setup + PMS Onboarding (CUA pipeline)

After auth, every hotel must connect its PMS. The Test Connection button saves credentials; Save & Onboard queues a Fly worker that logs into the PMS, runs vision-based recipe learning if none exists, extracts rooms+staff, and writes them into the property's tables.

### Trace

1. User navigates to `/settings/pms` ([src/app/settings/pms/page.tsx](src/app/settings/pms/page.tsx)). Form is prefilled from `activeProperty.pmsType` + `pmsUrl` (Firestore-legacy `db.ts` source).
2. **Test Connection** click ([src/app/settings/pms/page.tsx:73-120](src/app/settings/pms/page.tsx:73)):
   - L74-79: Client-side validation — refuses if any field empty.
   - L90-100: POST `/api/pms/save-credentials` with `{ propertyId, pmsType, loginUrl, username, password }` via `fetchWithAuth`.
3. **Server: save-credentials** ([src/app/api/pms/save-credentials/route.ts:40-192](src/app/api/pms/save-credentials/route.ts:40)):
   - L44-45: `requireSession()` ([api-auth.ts:214-283](src/lib/api-auth.ts:214)) verifies bearer JWT.
   - L48-51: `req.json().catch(() => null)` — malformed body → 400.
   - L53-76: UUID + enum + string validators ([api-validate.ts](src/lib/api-validate.ts)).
   - L85-118: **SSRF blocklist** — refuses localhost, RFC1918 private, link-local, ULA, AWS metadata. Comment notes DNS rebinding is **not** blocked.
   - L125-140: Ownership check — `properties.owner_id === session.userId`, with explicit `!property.owner_id` null guard.
   - L146-153: `checkAndIncrementRateLimit('pms-save-credentials', pid)` — cap 30/hr per property.
   - L159-171: **`.upsert()` into `scraper_credentials` writing `ca_username` and `ca_password` columns** with `onConflict: 'property_id'`. ⚠️ See risk #1 below.
   - L183-189: Separately UPDATEs `properties.pms_type` and `properties.pms_url`. **Not in a transaction with the upsert.**
4. Client renders "Credentials saved" green badge ([settings/pms:109-113](src/app/settings/pms/page.tsx:109)).
5. **Save & Onboard** click ([src/app/settings/pms/page.tsx:126-179](src/app/settings/pms/page.tsx:126)):
   - L128-134: Guard requires `testStatus === 'success'` (i.e. the previous step actually ran).
   - L141-144: Calls `updateProperty(user.uid, activePropertyId, { pmsType, pmsUrl })` via legacy `db.ts`. **This is a SECOND write of pms_type/pmsUrl** — first one was inside save-credentials. The two writes target different ORMs.
   - L145: `await refreshProperty()` re-pulls from Firestore-legacy.
   - L148-152: POST `/api/pms/onboard` with `{ propertyId }`.
6. **Server: onboard** ([src/app/api/pms/onboard/route.ts:34-140](src/app/api/pms/onboard/route.ts:34)):
   - L38-39: requireSession.
   - L52-66: Ownership check (same shape as save-credentials).
   - L72-83: Confirm `scraper_credentials.is_active` — fail early with "Save credentials first" if not.
   - L92-99: Rate limit `pms-onboard` 5/hr per property (Claude-token budget guardrail).
   - L105-117: **Throttle**: if a job with status in (queued, running, mapping, extracting) exists for this pid, return its jobId with `alreadyRunning: true`. Idempotent retry.
   - L120-137: INSERT `onboarding_jobs` row with status='queued', step='Waiting for a worker…', progress_pct=0.
7. Client receives `{ jobId, alreadyRunning }`, sets state, polling effect ([settings/pms:182-217](src/app/settings/pms/page.tsx:182)) starts firing every 3s.
8. **Fly worker** (out of repo scope but described in [cua-service/](cua-service)) polls `onboarding_jobs` every ~5s. On pick-up it:
   - Reads encrypted creds from `scraper_credentials_decrypted` view (per [supabase/migrations/0069_encrypt_scraper_credentials.sql:131-149](supabase/migrations/0069_encrypt_scraper_credentials.sql:131)).
   - Logs into the PMS vendor site (Choice Advantage, OPERA, etc.).
   - If no active `pms_recipes` row for this `pms_type`, runs Claude vision to map screens → draft recipe.
   - Replays recipe → extracts rooms, staff, schedule history.
   - Writes everything into `rooms`, `staff`, etc.
   - Promotes recipe to active.
   - Updates `onboarding_jobs.status='complete'` with result `{ rooms_count, staff_count, ... }`.
9. **Server: job-status** ([src/app/api/pms/job-status/route.ts:22-76](src/app/api/pms/job-status/route.ts:22)):
   - Each poll: requireSession → validate UUID → `SELECT id, status, step, progress_pct, result, error, recipe_id, ...` (note `error_detail` deliberately excluded — leak-prevention).
   - Capability check: `properties.owner_id === session.userId`.
   - Returns the row camelCased.
10. Client renders progress bar + step label. On `status in ('complete', 'failed')`, polling stops via `cancelled` flag in the cleanup ([settings/pms:213-216](src/app/settings/pms/page.tsx:213)) and `refreshProperty()` re-pulls Firestore.

### Data shape transformations

| Step | Coercion / Default | Risk |
|---|---|---|
| settings/pms:482-486 | `(r.rooms_count as number) ?? 0` and `(r.staff_count as number) ?? 0` after `as Record<string, unknown>` cast | A schema rename (`rooms_count` → `room_count`) makes the summary silently show "We found 0 rooms" with no error. |
| settings/pms:294 | `ts?.toDate ? ts.toDate() : new Date(ts)` — Firestore-Timestamp duck-typing on `lastSyncedAt` | Mismatched data source returns Invalid Date; UI checks `isNaN` and hides the timestamp silently. |
| settings/pms:193-199 | `setJobStatus({ status: json.data.status, step: json.data.step, progressPct: json.data.progressPct, error: json.data.error, result: json.data.result })` | All fields unvalidated; a server change to `progress_pct` (snake_case) instead of `progressPct` would make the progress bar permanently 0. |
| save-credentials:159-171 | Writing **plaintext** `ca_username` / `ca_password` directly — no `encrypt_pms_credential(...)` wrapping | **See risk #1.** |
| save-credentials:86 | `new URL(urlV.value!)` will throw on malformed input — handled by the surrounding `try`. | OK. |
| save-credentials:138 | `(property.owner_id as string) !== session.userId` after explicit null check — correct. | OK. |

### External dependencies

| Service | Where | Timeout | Retry | Idempotency | Failure surface |
|---|---|---|---|---|---|
| **Supabase Admin** (service-role) | All routes | SDK default | None | Inherent (UPSERT) | Errors surface via `error.message`. `verifySupabaseAdmin()` ([supabase-admin.ts:62-103](src/lib/supabase-admin.ts:62)) does a preflight read to catch stale keys. |
| **Supabase Vault + pgcrypto** | Encryption helpers `encrypt_pms_credential` / `decrypt_pms_credential` | Postgres query time | None | Deterministic | If `pms_credentials_key` is missing from `vault.secrets`, the helper RAISES — but **only callers go through these helpers**. The save-credentials route doesn't call them (risk #1). |
| **Fly.io worker `staxis-cua`** | Consumes `onboarding_jobs` via polling, runs vision + extraction | ~5s pickup; full job 30s-3min | Worker-side; if container dies, `started_at` stays stale and no other worker picks up | Job's terminal state (complete/failed) — but if worker hangs, the job stays in `running`/`mapping` forever. | Polling client sees no progress; UI shows spinner indefinitely. |
| **Anthropic API** (vision for CUA mapping) | Inside Fly worker, not Next.js | Worker-side | Worker-side | Per-call only | Quota or rate-limit error → worker should mark job 'failed'. If worker just crashes, job hangs (above). |
| **PMS vendor site** (Choice Advantage, OPERA, Cloudbeds, etc.) | Inside Fly worker | Vendor-side | Vendor-side | n/a | Login change, CAPTCHA, MFA → recipe fails → job 'failed'. |
| **Vercel post-response runtime** | Not used here (10s `maxDuration` cap on each route) | 10s | n/a | n/a | A slow Supabase query > 10s would 504 the request. None observed in the trace, but the rate limit RPC + auth call + property lookup + upsert is 4 round-trips. |

### Risk register

| # | Risk | Severity | Visibility | Evidence | Suggested probe |
|---|---|---|---|---|---|
| 1 | **PMS credentials write path is broken or plaintext.** Migration [0069](supabase/migrations/0069_encrypt_scraper_credentials.sql) drops `ca_username` and `ca_password` columns and replaces them with encrypted equivalents + a `scraper_credentials_decrypted` view. The save-credentials route ([line 159-171](src/app/api/pms/save-credentials/route.ts:159)) still writes to the dropped column names without calling `encrypt_pms_credential()`. **Two possibilities, both bad:** (a) migration 0069 isn't applied to prod (memory: migrations are MANUAL per [project_migration_application_manual.md]) → credentials sit in plaintext, contradicting the UI's "encrypted and stored securely in Supabase" promise; (b) migration 0069 IS applied → every Test Connection call has been failing since 0069 landed. No third option. | **P0** | silent | [save-credentials/route.ts:159-171](src/app/api/pms/save-credentials/route.ts:159) vs [0069 migration:127-128](supabase/migrations/0069_encrypt_scraper_credentials.sql:127) | Run `SELECT column_name FROM information_schema.columns WHERE table_name='scraper_credentials'` on prod. If `ca_username` exists → credentials are plaintext. If not → confirm Test Connection has been failing. Either way, this is the highest-priority fix in the audit. |
| 2 | save-credentials + onboard are **NOT atomic**. `scraper_credentials` upsert ([L159](src/app/api/pms/save-credentials/route.ts:159)) and `properties` update ([L183](src/app/api/pms/save-credentials/route.ts:183)) are two separate writes. If the second one fails (transient Supabase error, network blip), the user sees "saved" but `properties.pms_type` lags. Onboard then runs against stale property metadata. | P0 | silent | [save-credentials/route.ts:155-189](src/app/api/pms/save-credentials/route.ts:155) | Wrap both writes in a Postgres function (`security definer`) called via RPC. |
| 3 | **Dual-write of `pms_type` / `pms_url`**: the Save & Onboard handler calls `updateProperty()` (Firestore-legacy `db.ts`) AT [settings/pms:141](src/app/settings/pms/page.tsx:141), and save-credentials already wrote the same fields to Supabase ([save-credentials:183-189](src/app/api/pms/save-credentials/route.ts:183)). The two stores drift if one write fails. UI reads from Firestore-legacy via `activeProperty`, so a Supabase-only success shows stale data. | P0 | silent | [settings/pms:141-145](src/app/settings/pms/page.tsx:141) | Read out both sources for the same property; alert on mismatch. Long-term: kill the dual write — pick one store. |
| 4 | Polling has no max-attempt cap and no exponential backoff ([settings/pms:182-217](src/app/settings/pms/page.tsx:182)). A dead Fly worker means the user stares at "Working…" indefinitely with no error. The `setTimeout` loop only stops on `complete` / `failed` or page unmount. | P1 | silent | [settings/pms:209](src/app/settings/pms/page.tsx:209) | After 5 min of `queued`/`mapping` with no progress_pct change, surface "this is taking longer than expected — the worker may be down." |
| 5 | Polling result shape (`json.data.status`, `.step`, `.progressPct`, etc.) is consumed via raw property access with no runtime validation. A server-side rename (e.g. snake_case slip) makes the UI silently freeze at 0%. | P1 | silent | [settings/pms:192-199](src/app/settings/pms/page.tsx:192) | Add a Zod parser or contract test. |
| 6 | `rate-limit RPC fail-open` at [api-ratelimit.ts:200-205](src/lib/api-ratelimit.ts:200): if the staxis_api_limit_hit RPC errors, the request is allowed through. **Onboard burns $1-3 of Claude tokens per attempt.** A DB hiccup during peak signup hour uncaps the burn. The log line is `log.error('[ratelimit] rpc failed — FAILING OPEN', …)` — visible in Sentry, but the request still goes through. | P1 | loud | [api-ratelimit.ts:200-205](src/lib/api-ratelimit.ts:200) | Doctor check on the api_limits table writability; alert before peak hours. |
| 7 | **SSRF blocklist doesn't cover DNS rebinding** ([save-credentials:80-83 comment](src/app/api/pms/save-credentials/route.ts:80)). A malicious actor with control of a DNS record could pass `evil.com` (resolves public at write-time, then later resolves to 169.254.169.254 metadata at scraper fetch-time). The worker would happily hit the AWS metadata endpoint and could leak IAM creds. | P1 | silent | [save-credentials/route.ts:97-113](src/app/api/pms/save-credentials/route.ts:97) | Worker-side: re-resolve hostname before connecting AND validate the resolved IP is public. Or use a fetch helper that pins the IP from the initial DNS lookup. |
| 8 | `error_detail` is deliberately excluded from job-status responses ([job-status/route.ts:34-37](src/app/api/pms/job-status/route.ts:34)) — good security posture. **But** `error` IS returned, and the worker writes vendor-specific failure messages there ("Login form selector `#user` not found"). That's mid-grade leak. | P2 | silent | [job-status/route.ts:38-49](src/app/api/pms/job-status/route.ts:38) | Audit `onboarding_jobs.error` rows for selector strings / URLs before returning. |
| 9 | "Test Connection" button UX-name is misleading — [the code comment says so](src/app/api/pms/save-credentials/route.ts:8). It doesn't actually test the login; it just saves credentials. A user who sees "Connected successfully" then queues an onboard expects the password is verified — it isn't. | P2 | silent | [settings/pms:69-72 comment](src/app/settings/pms/page.tsx:69) | Rename button to "Save Credentials" and surface real connection result only after the onboard run. |
| 10 | `(r.rooms_count as number) ?? 0` ([settings/pms:482-486](src/app/settings/pms/page.tsx:482)) — schema drift makes the celebrate-screen say "We found 0 rooms" with no other indication anything went wrong. | P1 | silent | [settings/pms:478-489](src/app/settings/pms/page.tsx:478) | Treat 0 rooms as failure for the success card: show "We connected but found 0 rooms — check your PMS view." |
| 11 | Polling network errors are silently swallowed and the next poll fires anyway ([settings/pms:206-208](src/app/settings/pms/page.tsx:206)). If the user's wifi goes down mid-onboarding, they'll never know — the UI shows the last known state forever. | P2 | silent | [settings/pms:206-208](src/app/settings/pms/page.tsx:206) | Track consecutive poll failures; show offline banner after 3. |

### Cross-cutting hazards

- **`refreshProperty()` race**: the UI calls `await updateProperty()` (Firestore-legacy write) → `await refreshProperty()` immediately. If Firestore-legacy is eventually consistent (it is), the refresh may read pre-write state. Onboard then kicks off against stale UI state.
- **Encryption ambiguity** (risk #1) is the single most important finding in this audit. Until verified, every other PMS-flow finding is downstream of "we don't actually know how PMS credentials are stored in prod."
- **No worker watchdog visible from the Next.js side**: the doctor surfaces it elsewhere, but the user-facing UI has no concept of "the Fly worker is down" — it just keeps polling.

---

## Flow 3: Shift Confirmation + Housekeeping Room Actions

Daily ops. Manager assigns rooms in Schedule tab → Send → SMS goes out with a magic-linked URL → housekeepers tap rooms Done/Issue/Reset on their phone (no Staxis login) → service-role bypass routes write `rooms` + `cleaning_events` + ML features → Performance tab reads them back.

### Trace

**Producer side (manager):**

1. Manager loads `/housekeeping` → Schedule tab ([src/app/housekeeping/_components/ScheduleTab.tsx](src/app/housekeeping/_components/ScheduleTab.tsx)). Assigns staff to rooms. Clicks Send.
2. Client POSTs `/api/send-shift-confirmations` with `{ pid, shiftDate, baseUrl, staff: [...] }` and an `Idempotency-Key` header.
3. **Server: send-shift-confirmations** ([src/app/api/send-shift-confirmations/route.ts:107-578](src/app/api/send-shift-confirmations/route.ts:107)):
   - L111-112: requireSession.
   - L119-122: `checkIdempotency()` ([idempotency.ts:61-116](src/lib/idempotency.ts:61)) — Stripe-style header dedup. Cached hit short-circuits.
   - L124-177: Strict body validation — UUIDs, names, phones, languages, room/area arrays bounded by [LIMITS](src/lib/api-validate.ts:16). Each name passes through `sanitizeForSms` (strips control chars).
   - L178: `safeBaseUrl(b.baseUrl)` — clamps to a whitelist of known origins.
   - L180-182: `userHasPropertyAccess(session.userId, pid)` ([api-auth.ts:404-418](src/lib/api-auth.ts:404)) — checks `accounts.role === 'admin'` OR `accounts.property_access` contains pid.
   - L186-188: Rate limit `send-shift-confirmations` 10/hr per property.
   - L194-203: **Failsafe** — refuse to send with zero work unless `allowEmpty: true`.
   - L206-214: Parallel fetch property + plan_snapshot.
   - L231-282: **Seed rooms** — upsert new room rows, preserve existing, key on `(property_id, date, number)`.
   - L286-318: **Update rooms with changed assignments** (parallel `.update()` calls, **NOT in a transaction**).
   - L303-314: **Clear rooms that lost their assignment** in this Send.
   - L325-348: Upsert `schedule_assignments` (last-write-wins).
   - L362-521: Per-staff parallel map:
     - L368-371: `toE164` (US-only — accepts 10-digit, 11-digit-starting-with-1, or `+`-prefix). Non-US → 'skipped/invalid_phone'.
     - L388-394: `buildHousekeeperLink` ([staff-auth.ts:178-211](src/lib/staff-auth.ts:178)) mints a Supabase magic-link via `generateLink({type:'magiclink'})`. **On error, falls back to a tokenless URL** (degraded UX, polling instead of realtime).
     - L399: Deterministic token `${shiftDate}_${staffId}`.
     - L406-415: Read existing `shift_confirmations`; preserve `'confirmed'` status if already replied YES.
     - L428-446: UPSERT shift_confirmations row.
     - L451-457: **Fire-and-forget** UPDATE of `staff.phone_lookup` — no await, errors only console.warn.
     - L467-469: SMS body assembled (per-language template).
     - L483-511: `enqueueSms()` ([sms-jobs.ts:90-131](src/lib/sms-jobs.ts:90)) writes to `sms_jobs` queue. Unique `(property_id, idempotency_key)` constraint dedups.
     - L501-510: On enqueue failure, mark `shift_confirmations.sms_error`.
   - L533-545: Build success envelope, persist via `recordIdempotency()`.
   - L555-563: **`after()` drains the SMS queue inline** — `processSmsJobs(50)` runs post-response, capped at Vercel's 60s function limit. GitHub Actions cron picks up overflow within 5 min.
4. **SMS worker** ([sms-jobs.ts:167-311](src/lib/sms-jobs.ts:167)):
   - L171-178: Atomic claim via `staxis_claim_sms_jobs` RPC (`for update skip locked`).
   - L206-211: Per-job — call `sendSms` ([sms.ts:27-53](src/lib/sms.ts:27)) → Twilio REST.
   - L212-246: On send error: classify Twilio code → 'dead' (terminal) or 'queued' (retry with 30/120/300s backoff).
   - L251-296: **On send success, post-send DB update**. If THAT write fails, mark row 'dead' (not 'queued') to prevent duplicate Twilio send on next sweep.
   - L300-307: `applyMetadataCallback` updates `shift_confirmations.sms_sent` based on terminal state.
5. SMS arrives on housekeeper phone with link `https://getstaxis.com/housekeeper/{staffId}?pid={pid}&token={hashed_token}`.

**Consumer side (housekeeper):**

6. Housekeeper taps link. Page loads at [src/app/housekeeper/[id]/page.tsx](src/app/housekeeper/[id]/page.tsx).
   - L214-250: Magic-link consume via `supabase.auth.verifyOtp({token_hash, type:'magiclink'})`. **Non-fatal**: failure falls through to anon mode + polling. URL token stripped after consume.
   - L256-277: Load language pref via `getStaffSelfPublic(pid, staffId)` → `/api/housekeeper/me` ([src/app/api/housekeeper/me/route.ts](src/app/api/housekeeper/me/route.ts)). Service-role bypass since the page is unauthenticated.
   - L279-339: Subscribe to rooms via `subscribeToRoomsForStaff` (realtime if authed via magic-link; polling otherwise via [/api/housekeeper/rooms](src/app/api/housekeeper/rooms/route.ts)). Date selection prefers today, else nearest future shift, else most recent past.
7. Housekeeper taps Done on a room ([src/app/housekeeper/[id]/page.tsx:471-510](src/app/housekeeper/[id]/page.tsx:471)):
   - L353-364: Re-entrancy guard via `inFlightRoomIds` Set.
   - L476: `completedAt = new Date()` — **client-supplied tap time**.
   - L486-498: Builds `cleaningContext` with `roomNumber`, `roomType`, `stayoverDayBucket`, `staffName`, `date`, `startedAt` (server-overridden), `completedAt`, and `shiftStartedAt` from localStorage.
   - L499: `callRoomActionApi(room, 'finish', ctx)` → POST `/api/housekeeper/room-action`.
8. **Server: room-action** ([src/app/api/housekeeper/room-action/route.ts:157-562](src/app/api/housekeeper/room-action/route.ts:157)):
   - L163: getOrMintRequestId for traceability (echoed as `x-request-id` response header).
   - L169-186: Body parse + manual null-checks + action enum check.
   - L192-204: Staff capability check — `staff.property_id === pid`.
   - L215-237: Room capability check — `room.property_id === pid` AND (`room.assigned_to IS NULL` OR `=== staffId`).
   - L266-431: 'finish' branch:
     - L275: `completedAt = cleaningContext?.completedAt ?? now` — **client tap time wins**.
     - L291-307: Dedupe lookup — within 90s of an existing non-discarded event for the same (pid, staffId, roomNumber, date), set `isDuplicate=true`.
     - L313-323: `deriveStartedAt` ([room-action:113-148](src/app/api/housekeeper/room-action/route.ts:113)) reconstructs canonical started_at from prior `cleaning_events` + shift anchor.
     - L329-342: UPDATE `rooms.status='clean'`, `completed_at`, `started_at`.
     - L348-389: `deriveCleaningEventFeatures()` for ML feature snapshot. **Failures are non-fatal**: features default to null, counter incremented via `incrementMLFailureCounter`, insert proceeds with NULLs.
     - L417-422: UPSERT `cleaning_events` with `ignoreDuplicates: true` on `(property_id, date, room_number, started_at, completed_at)`.
     - L423-428: `cleaningEventInserted = !ceErr` — does NOT distinguish "inserted" from "ignored duplicate" from "schema error."
   - L444-490: 'reset' branch — clears room progress + sets latest cleaning_event status='discarded' flag_reason='reset_by_user'.
   - L498-552: 'dnd_on' / 'dnd_off' / 'help' / 'issue' branches — direct UPDATEs.
9. Client refetches `/api/housekeeper/rooms` after a successful action ([page.tsx:447-453](src/app/housekeeper/[id]/page.tsx:447)) so the card flips immediately without waiting for the next 4s poll tick.

**Inbound SMS path (housekeeper replies ESPAÑOL/ENGLISH):**

10. Twilio webhook posts to `/api/sms-reply` ([src/app/api/sms-reply/route.ts](src/app/api/sms-reply/route.ts)):
    - L184-198: Form-encoded parse (JSON path is dev-only).
    - L220-253: **Twilio signature verification** via `twilio.validateRequest`. Fail-closed on missing AUTH_TOKEN when SID is set.
    - L255-262: `logHit('received', ...)` with PII-redacted phones.
    - L269-310: Normalize `From` → E.164 + variants → look up `staff.phone_lookup`. Multi-match tiebreaks on `updated_at`.
    - L318-335: Find newest open `shift_confirmations` row for that staff.
    - L370-389: ESPAÑOL/ENGLISH → mirror `language` to both `staff` AND `shift_confirmations`, resend the link in the new language.
    - Always returns empty TwiML `<Response/>` so Twilio doesn't auto-reply.

### Data shape transformations

| Step | Coercion / Default | Risk |
|---|---|---|
| send-shift:84-90 | `toE164` — accepts 10-digit (+1 prefix), 11-digit-starting-with-1, or already-`+`-prefixed; everything else returns null | Non-US numbers silently rejected as `invalid_phone`. International rollout would need this. |
| send-shift:78-82 | `deriveRoomType` defaults to 'checkout' on unknown — comment: "err on the heavier side" | Bias toward false-positive workload — acceptable. |
| send-shift:219 | `(planRes.data?.rooms as PlanRoom[] \| null) ?? null` | If `rooms` is the wrong shape (object vs array), the find at L79 throws — caught by outer try → 500. Loud, but the type cast is the only "validation." |
| room-action:275 | `completedAt = cleaningContext?.completedAt ?? now` | **Client time wins** — no sanity check that it's within e.g. ±30 min of server now. |
| room-action:401 | `Number(durationMin.toFixed(2))` | Two-decimal rounding. Fine. |
| room-action:417-422 | `ignoreDuplicates: true` on UPSERT | Cannot distinguish "first write" from "dupe ignore." `cleaningEventInserted = !ceErr` is true in both cases. |
| housekeeper page:298-309 | Date bucket selection — prefer today, else future, else past | Timezone of `today` comes from `useTodayStr` (Central time). A housekeeper in a different TZ might see "yesterday's rooms" as today. |
| housekeeper page:486-498 | `cleaningContext` only built when `isCleanable = room.type === 'checkout' \|\| room.type === 'stayover'` | Vacant rooms send `ctx = undefined`. Server then takes the "no cleaning_events row" branch — **no audit trail for vacant rooms** even though `rooms.status` gets set to 'clean'. ML feature pipeline misses these. |
| sms-reply:280-285 | Variants array: `[phone164, fromNumber, tenDigit, '1${tenDigit}']` | If `staff.phone_lookup` was ever written in a different normalization (e.g. `(281) 666-9887`), the lookup misses → inbound text falls into "no_staff_match" silently. |
| sms-reply:393 | `(conf.language as 'en' \| 'es') ?? 'en'` | Unknown language falls back to English. |

### External dependencies

| Service | Where | Timeout | Retry | Idempotency | Failure surface |
|---|---|---|---|---|---|
| **Supabase service-role** | All routes via `supabaseAdmin` | SDK default | None | UPSERT semantics + unique constraints | Errors return 500 with redacted bodies (room-action explicitly strips raw DB errors for the public link). |
| **Twilio REST API** | `sendSms` ([sms.ts:27-53](src/lib/sms.ts:27)) | fetch default ~30s | Per-job 30/120/300s backoff, max 3 attempts | Twilio side dedup is per-account-not-per-message; the `sms_jobs` table handles producer-side dedup via `(property_id, idempotency_key)` unique | Terminal codes (21211, 30003, etc.) marked 'dead' immediately. Other codes retry. After 3 attempts → 'dead'. |
| **Twilio inbound webhook** | `/api/sms-reply` | Twilio retries on 5xx | n/a | n/a (we always 200 with empty TwiML) | Signature verification fail → 403 (Twilio will retry, which is desirable for signing-key drift). |
| **Vercel `after()`** | `processSmsJobs(50)` inline drain after the route returns | 60s on Hobby plan | n/a | n/a | If 60s cap is hit mid-drain, remaining jobs picked up by GitHub Actions cron within 5 min. |
| **GitHub Actions cron** | `.github/workflows/sms-jobs-cron.yml` (referenced at send-shift:553) | Cron interval 5 min | Worker-side | n/a | If the cron itself is broken (workflow disabled), SMS queue fills up indefinitely. Doctor likely catches this — verify. |
| **Resend** (any transactional emails out of this flow) | Not in shift path — only auth OTP and admin invites | n/a | Resend side | n/a | Not on the critical path here. |
| **localStorage** (`staxis:shift_start:{pid}:{staffId}:{date}`) | Housekeeper page anchors shift start | n/a | n/a | n/a | Private mode = no anchor. Server falls through to synthetic fallback in `deriveStartedAtPure`. |

### Risk register

| # | Risk | Severity | Visibility | Evidence | Suggested probe |
|---|---|---|---|---|---|
| 1 | **`send-shift-confirmations` is NOT atomic.** Three write phases — (a) rooms seed/update/clear, (b) schedule_assignments upsert, (c) per-staff shift_confirmations upsert × N — share no transaction. A failure mid-flight leaves rooms reassigned but no SMS queued, OR SMS sent but assignment cleared. The outer try-catch only knows about the first throw. | P0 | silent | [send-shift-confirmations/route.ts:231-349, 362-521](src/app/api/send-shift-confirmations/route.ts:231) | Wrap the rooms + schedule_assignments writes in a single Postgres function. Per-staff is harder (Twilio side-effect) — at minimum, track partial-failure state in the response. |
| 2 | **Client-supplied `completedAt` is written as the canonical Done time.** [room-action:275](src/app/api/housekeeper/room-action/route.ts:275) takes `cleaningContext?.completedAt ?? now`. A housekeeper's clock skew or tampered request writes that timestamp directly into `rooms.completed_at` and `cleaning_events.completed_at`. This drives Performance metrics and ML training labels. | P0 | silent | [room-action/route.ts:275](src/app/api/housekeeper/room-action/route.ts:275) | Sanity-check: clamp to `[now - 1h, now + 5min]`. Out-of-band → ignore the supplied value, use server-now, increment a counter. |
| 3 | **Room marked clean WITHOUT a cleaning_events row** when `cleaningContext` is missing or `roomType` isn't checkout/stayover. The `rooms` row flips to 'clean' silently, but no audit row is written, no ML features captured. Performance tab and supply ML both miss the event. Affects vacant rooms by design, but a buggy client could send any `finish` without context and bypass the audit. | P1 | silent | [room-action/route.ts:348](src/app/api/housekeeper/room-action/route.ts:348) | If `action === 'finish'` AND `cleaningContext` missing AND room.type is checkout/stayover → reject 400 instead of soft-succeeding. |
| 4 | **`staff.phone_lookup` update is fire-and-forget.** [send-shift:451-457](src/app/api/send-shift-confirmations/route.ts:451) calls `.update().then()` without await. A failure here means inbound SMS routing in `/api/sms-reply` won't find this staff for ESPAÑOL/ENGLISH switches. Symptom: HK replies ESPAÑOL, nothing happens, silent. | P1 | silent | [send-shift-confirmations/route.ts:451-457](src/app/api/send-shift-confirmations/route.ts:451) | Await it, or move to a separate idempotent upsert step. |
| 5 | **Rate limit fails open on RPC error.** Same finding as Flow 2 risk #6 — applies to all SMS-firing endpoints including `send-shift-confirmations` and `help-request`. Twilio bill becomes uncapped during a Postgres hiccup. | P1 | loud | [api-ratelimit.ts:200-205](src/lib/api-ratelimit.ts:200) | Same: doctor probe + alert. |
| 6 | **SMS post-send DB update failure marks job 'dead' even though Twilio sent.** [sms-jobs:275-296](src/lib/sms-jobs.ts:275) — if Twilio succeeds but the row update fails (DB hiccup right at that ms), the code marks the row 'dead' to prevent the watchdog sweep from triggering a duplicate Twilio send. Manager UI shows red badge for a message the housekeeper actually received. Loud in logs ('POST_SEND_DB_FAILURE'), invisible to the manager. | P1 | silent (to user) | [sms-jobs.ts:275-296](src/lib/sms-jobs.ts:275) | Surface 'POST_SEND_DB_FAILURE' as a distinct status in the manager UI ("sent but couldn't update — confirm with HK manually"). |
| 7 | **`cleaningEventInserted = !ceErr`** ([room-action:423](src/app/api/housekeeper/room-action/route.ts:423)) returns true for both fresh inserts AND silent dupe-ignores. The client can't tell which happened. Combined with the 90s dedupe lookup, this means a stuck client repeatedly tapping Done over the same room logs N "successful" inserts in the response but creates only 1 row in DB. | P2 | silent | [room-action/route.ts:417-423](src/app/api/housekeeper/room-action/route.ts:417) | Use `select().single()` after upsert and compare timestamps to distinguish fresh from dupe. |
| 8 | **Feature derivation null-fallback writes NULL ML feature columns** ([room-action:357-389](src/app/api/housekeeper/room-action/route.ts:357)). Counter increments via `incrementMLFailureCounter` (doctor can surface), but the cleaning_events row lands with NULL features. Supply ML retrains on NULL-padded rows → silent quality regression. | P1 | loud (counter) | [room-action/route.ts:357-389](src/app/api/housekeeper/room-action/route.ts:357) | ML training pipeline already has `excludeRowsWithNullFeatures()` per memory? Verify; if not, add it. |
| 9 | **Public-link unauth path trusts URL params.** The page is publicly linkable by design. The capability model is "anyone with (pid, staffId) can act on rooms where `assigned_to IS NULL OR = staffId`." Staff UUIDs are listable via [/api/staff-list]. Mitigation works because room.assigned_to scoping is enforced ([room-action:226-237](src/app/api/housekeeper/room-action/route.ts:226)). Bears watching: if anyone removes the `room.assigned_to` check (e.g. for a manager "claim any room" feature), staff-UUID-enumeration becomes a room-mutation vector. | P1 | n/a | [room-action/route.ts:188-237](src/app/api/housekeeper/room-action/route.ts:188) | Add a test that explicitly proves staffA cannot mutate a room assigned to staffB. |
| 10 | **`buildHousekeeperLink` fallback to tokenless URL** ([send-shift:391-394](src/app/api/send-shift-confirmations/route.ts:391)). On magic-link mint failure, the SMS still goes out — but the HK page falls back to anon polling. UX degraded; only `console.error` logs the fallback. Not in Sentry. | P2 | silent | [send-shift-confirmations/route.ts:391-394](src/app/api/send-shift-confirmations/route.ts:391) | Bump to `log.error` (Sentry-tagged). |
| 11 | **Realtime stops if magic-link consume fails on housekeeper page.** [page.tsx:225-227](src/app/housekeeper/[id]/page.tsx:225) only `console.warn`s on verifyOtp failure. The fallback (polling via service-role) works, but a manager testing in their own browser would have a degraded experience compared to a fresh HK opening the same link. | P2 | silent | [page.tsx:213-250](src/app/housekeeper/[id]/page.tsx:213) | Surface the realtime-on-or-off state in the UI footer for debug. |
| 12 | **`processSmsJobs(50)` inline drain caps at 50 jobs per request.** For a 60-person crew Send, the route enqueues 60, drains 50 inline, leaves 10 for the 5-min cron tick. Last 10 housekeepers wait up to 5 min for their text. | P2 | silent | [send-shift-confirmations/route.ts:555-563](src/app/api/send-shift-confirmations/route.ts:555) | Bump to 200 (still well under the 60s Vercel cap for current Twilio latency). |
| 13 | **`schedule_assignments` upsert uses last-write-wins** ([send-shift:338-348](src/app/api/send-shift-confirmations/route.ts:338)) keyed on `(property_id, date)`. Two managers clicking Send within seconds clobber each other's assignment maps with no warning. Mitigation: rate limit caps fire-rate at 10/hr per property. | P2 | silent | [send-shift-confirmations/route.ts:338-348](src/app/api/send-shift-confirmations/route.ts:338) | Add `updated_by` + last-modified check; surface a conflict UI ("someone else just saved"). |
| 14 | **`sms-reply` accepts JSON in non-production** ([sms-reply:222-228](src/app/api/sms-reply/route.ts:222)) — by design (dev testing), but means a leaked staging URL could be hit unsigned. Mitigated by `NODE_ENV` check, but staging deploys with `NODE_ENV=production` still pass. | P2 | loud | [sms-reply/route.ts:222-228](src/app/api/sms-reply/route.ts:222) | Restrict to a specific staging-only env var instead of inverse `NODE_ENV`. |
| 15 | **Stuck-job sweep (`resetStuckSmsJobs` every 5 min)** has a narrow race where a Twilio send completes between "row updated to 'sending'" and the sweep's 5-min cutoff. Mitigated by the post-send 'dead' fallback (risk #6), so the window is small but non-zero. | P2 | silent | [sms-jobs.ts:361-369](src/lib/sms-jobs.ts:361) | Verify the sweep cutoff (300s) is longer than the realistic Twilio worst-case turnaround. |
| 16 | **Inbound phone lookup brittleness** — [sms-reply:280-285](src/app/api/sms-reply/route.ts:280) tries 4 variants. If staff.phone_lookup was written with a different normalization (e.g. parentheses), none match. Lands in 'no_staff_match' log line with no user-visible feedback. | P1 | loud (log only) | [sms-reply/route.ts:280-310](src/app/api/sms-reply/route.ts:280) | Backfill: re-normalize `staff.phone_lookup` once via the canonical `toE164`. |

### Cross-cutting hazards

- **RLS bypass is the architectural choice** for unauthenticated housekeeper actions. The capability model (URL = token + room.assigned_to scoping) is explicit and well-documented in route comments. Any future change to allow "manager picks up an HK's room" needs to maintain or replace the scoping check, or the staff-UUID enumeration vector opens.
- **Realtime vs polling drift**: housekeepers with magic-link sessions get realtime room updates; without, they get 4s polling. The page is identical otherwise, but a manager observing realtime in one tab and a HK on polling in another can see a 4s lag during the most important moment (room flips to clean). Not a data-integrity issue, but a "did it save?" UX cliff.
- **Idempotency-Key vs `sms_jobs` idempotency key**: two layers, both correct. The route-level cache returns the same response envelope on retry; the queue-level dedup prevents duplicate Twilio sends. A manager hitting Retry from a slow connection gets exactly-once SMS. Confirmed in trace.
- **PII handling**: `redactPhone` is applied to webhook_log inserts. Staff names are sanitized for SMS but logged raw at the error path ([send-shift:516](src/app/api/send-shift-confirmations/route.ts:516) — comment notes the staffId is enough). `error_logs` table catches outer errors with stack traces; these are admin-readable, not anonymized.
- **Timezone**: `useTodayStr` is Central-time. A housekeeper in Mountain or Eastern timezone sees a possibly-shifted "today" near midnight. Affects which date bucket the page chooses. Not data corruption, but a confusing UX edge case.

---

## Appendix A: Top 10 P0/P1 risks across all flows — read this first

The shortest path to the highest-impact fixes. Each item links into the flow section above.

| Rank | Flow | Risk | Why first | Where |
|---|---|---|---|---|
| **1** | PMS | **Credentials write path is broken or plaintext.** Either migration 0069 isn't applied (creds in cleartext) OR the route has been failing since 0069 (Test Connection never works). Can be answered with one SQL query on prod. | The UI literally promises "encrypted and stored securely" while the code writes to dropped columns. Worst-case is a plaintext-creds audit finding for paying customers. | Flow 2 risk #1 — [save-credentials/route.ts:159-171](src/app/api/pms/save-credentials/route.ts:159) |
| **2** | Shift | **Client-supplied `completedAt` written as canonical** — feeds Performance, ML training labels, payroll-adjacent metrics. Tap-time tampering or device clock skew becomes "fact." | Drives ML supply model that gates the whole product's value proposition. Hard to detect after the fact. | Flow 3 risk #2 — [room-action/route.ts:275](src/app/api/housekeeper/room-action/route.ts:275) |
| **3** | Shift | **`send-shift-confirmations` not atomic** across rooms / schedule_assignments / per-staff phases. Partial commit leaves Maria's UI saying "12 sent" while DB shows 5 rooms reassigned, 0 confirmations. | Highest-volume daily action. A retry can double-write some phases and skip others. | Flow 3 risk #1 — [send-shift-confirmations/route.ts:231-349, 362-521](src/app/api/send-shift-confirmations/route.ts:231) |
| **4** | PMS | **Dual-write of pms_type/pms_url** to Firestore-legacy AND Supabase, no transaction, no reconciliation. UI reads Firestore-legacy. | Onboarding can succeed in one store and fail in the other; subsequent flows operate on stale property metadata. | Flow 2 risk #3 — [settings/pms:141-145](src/app/settings/pms/page.tsx:141) |
| **5** | Shift | **Room marked clean WITHOUT cleaning_events row** when cleaningContext is missing. Performance + ML lose the data silently. | Room-status looks right; downstream tabs and ML training silently regress. | Flow 3 risk #3 — [room-action/route.ts:348](src/app/api/housekeeper/room-action/route.ts:348) |
| **6** | Shift | **SMS post-send DB update can mark row 'dead' even after successful Twilio send.** UI shows red badge for a text the HK received. | Reverse-failure UX — manager assumes the HK didn't get the message and re-sends, doubling the noise. | Flow 3 risk #6 — [sms-jobs.ts:275-296](src/lib/sms-jobs.ts:275) |
| **7** | All | **Rate limit fails open on RPC error.** Onboard ($1-3 Claude/run), SMS sends, photo-counting all uncapped during a Postgres hiccup. | Direct dollars-to-spend exposure. Loud in logs (Sentry tag), but request still goes through. | Flow 2 risk #6 — [api-ratelimit.ts:200-205](src/lib/api-ratelimit.ts:200) |
| **8** | Shift | **`staff.phone_lookup` update fire-and-forget.** Inbound SMS routing breaks silently if write fails. HK replies ESPAÑOL, nothing happens. | Subtle multi-step failure — manager never sees a signal that the inbound SMS path is broken for that staff. | Flow 3 risk #4 — [send-shift-confirmations/route.ts:451-457](src/app/api/send-shift-confirmations/route.ts:451) |
| **9** | PMS | **Onboarding polling has no timeout.** A dead Fly worker leaves the UI spinning indefinitely. | Customer experience cliff for the very first interaction after sign-in. | Flow 2 risk #4 — [settings/pms:182-217](src/app/settings/pms/page.tsx:182) |
| **10** | Auth | **`trust-device` INSERTs, never UPSERTs.** Unbounded row growth per account over time. | Latent — won't bite for months, but eventually the query at check-trust returns hundreds of rows and the lookup index degrades. | Flow 1 risk #1 — [trust-device/route.ts:57-63](src/app/api/auth/trust-device/route.ts:57) |

---

## Appendix B: Files referenced (deduplicated index)

For quick navigation. Bracketed numbers are the risk-register items that cite the file.

**Flow 1 — Auth / 2FA:**
- [src/app/signin/page.tsx](src/app/signin/page.tsx) [4, 7, 10]
- [src/app/signin/verify/page.tsx](src/app/signin/verify/page.tsx) [5]
- [src/app/api/auth/login/route.ts](src/app/api/auth/login/route.ts) (deprecated 410 stub)
- [src/app/api/auth/check-trust/route.ts](src/app/api/auth/check-trust/route.ts) [2, 10]
- [src/app/api/auth/trust-device/route.ts](src/app/api/auth/trust-device/route.ts) [1]
- [src/lib/trusted-device.ts](src/lib/trusted-device.ts) [6]
- [src/contexts/AuthContext.tsx](src/contexts/AuthContext.tsx) [8, 9]
- [src/lib/supabase.ts](src/lib/supabase.ts)
- [src/lib/api-auth.ts](src/lib/api-auth.ts)

**Flow 2 — PMS Onboarding:**
- [src/app/settings/pms/page.tsx](src/app/settings/pms/page.tsx) [3, 4, 5, 10, 11]
- [src/app/api/pms/save-credentials/route.ts](src/app/api/pms/save-credentials/route.ts) [1, 2, 7]
- [src/app/api/pms/onboard/route.ts](src/app/api/pms/onboard/route.ts)
- [src/app/api/pms/job-status/route.ts](src/app/api/pms/job-status/route.ts) [8]
- [src/lib/api-ratelimit.ts](src/lib/api-ratelimit.ts) [6]
- [supabase/migrations/0069_encrypt_scraper_credentials.sql](supabase/migrations/0069_encrypt_scraper_credentials.sql) [1]

**Flow 3 — Shift Confirmation + Housekeeping:**
- [src/app/housekeeping/_components/ScheduleTab.tsx](src/app/housekeeping/_components/ScheduleTab.tsx)
- [src/app/housekeeper/[id]/page.tsx](src/app/housekeeper/[id]/page.tsx) [11]
- [src/app/api/send-shift-confirmations/route.ts](src/app/api/send-shift-confirmations/route.ts) [1, 4, 10, 12, 13]
- [src/app/api/housekeeper/room-action/route.ts](src/app/api/housekeeper/room-action/route.ts) [2, 3, 7, 8, 9]
- [src/app/api/housekeeper/me/route.ts](src/app/api/housekeeper/me/route.ts)
- [src/app/api/housekeeper/rooms/route.ts](src/app/api/housekeeper/rooms/route.ts)
- [src/app/api/sms-reply/route.ts](src/app/api/sms-reply/route.ts) [14, 16]
- [src/lib/sms.ts](src/lib/sms.ts)
- [src/lib/sms-jobs.ts](src/lib/sms-jobs.ts) [6, 15]
- [src/lib/staff-auth.ts](src/lib/staff-auth.ts) [10]

**Shared infra:**
- [src/lib/supabase-admin.ts](src/lib/supabase-admin.ts)
- [src/lib/api-validate.ts](src/lib/api-validate.ts)
- [src/lib/idempotency.ts](src/lib/idempotency.ts)

---

*End of audit. Generated from static analysis on `audit/request-tracing` branch off `claude/sharp-gates-aa9723`. No source files modified; only this report.*
