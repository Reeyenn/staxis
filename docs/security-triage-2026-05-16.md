# Staxis Security Triage Report — 2026-05-16

Produced from the 7-surface security review per `/Users/reeyen/.claude/plans/can-you-and-codex-synthetic-lynx.md`. Codex adversarial pass + 7 Claude general-purpose subagents (one per surface) + parent synthesis.

## Summary

- **Total findings**: 25 (P0: 0 new, P1: 1 new, P2: 11, P3: 13)
- **Already-closed in this branch (PR 35 commits)**: 3 P0/P1 (Codex pre-discovery — Pattern A voice identity, Pattern B recipe SSRF, Pattern C cron-secret PII)
- **Highest-severity surfaces (new findings)**: Surface 6 (Billing/public — 1 P1), Surface 5 (Infra — 5 P2/P3), Surface 3 (LLM — 2 P2)
- **Patterns invoked**: A (1), B (1), C (3), D (1), E (closed), F (5), G (4); plus 10 defense-in-depth single instances

## Pattern-level fixes (each closes multiple findings)

### Pattern G — unified capability token primitive
- **Instances closed by this fix**:
  - F-G-1: Onboard wizard join codes use `Math.random()` + ~20 bits effective entropy + no rate limit on PATCH/GET (Surface 6, **P1**)
  - F-G-2: Join-code entropy ~40 bits even after CSPRNG (Surface 1, P3)
  - F-G-3: `shift_confirmations.token` deterministic `${shiftDate}_${staffId}` (Surface 6, P3 — latent only)
  - F-G-4: Picovoice access key returned plaintext (Surface 7, P3)
- **Root-cause change**: introduce `src/lib/capability-token.ts` with `mintCapability({ scope, ttlMs, maxUses, entropyBits })` returning `{ rawToken, dbRow }`. All four token systems route through it. Forbid `Math.random()` in any path that mints a security token (lint rule + grep CI test).
- **PR plan**: New helper module + replace `generateJoinCode` body to use `crypto.randomBytes` (12+ chars output) + add IP-keyed rate limit to `/api/onboard/wizard` PATCH+GET matching the 10/hr on `use-join-code` + rename `shift_confirmations.token` → `upsert_key` or add length attestation comment + tighten the Picovoice route (P3 hardening to follow when Picovoice account exits pending).
- **Severity** (highest among bundled): P1

### Pattern F — unified cost/abuse caps
- **Instances closed**:
  - F-F-1: Vision invoice scan has no dollar cap, only hourly count (Surface 3, P2)
  - F-F-2: `/api/inventory/photo-count` same shape (Surface 3, P2)
  - F-F-3: CUA mapper cost cap is per-job only — no per-property/day ceiling (Surface 3 + Surface 5, P2)
  - F-F-4: `toggle_dnd` accepts unbounded `note` length (Surface 3, P3)
  - F-F-5: ElevenLabs voice TTS/STT minute cost only checked pre-flight, not mid-session (Surface 7, P3)
- **Root-cause change**: one `withCostCap({ scope, ceilingMicros, window })` decorator that wraps every external paid call. Surfaces opt out only by explicit `withCostCap({ scope: 'none' })` (visible in code review). Centralizes the spend table writes so `agent_costs` becomes the single source of truth across chat/walkthrough/vision/voice/CUA.
- **PR plan**: New `src/lib/with-cost-cap.ts` primitive + replace ad-hoc cost-cap code in chat (`/api/agent/command`), walkthrough, vision scan, CUA mapper, voice-brain. Add per-property + per-day caps to CUA. Add `clampString({ max })` helper for tool note fields.
- **Severity**: P2

### Pattern C — separate concerns for shared bearer secrets
- **Instances closed by Codex pre-discovery PR 3 (already landed on this branch)**:
  - F-C-0: `/api/admin/diagnose` cron-secret PII leak (P1, **closed**)
  - F-C-0: + 4 other `/api/admin/*` routes class audit (closed, CI-guarded)
- **Net-new instances surfacing in Phase A**:
  - F-C-1: `ML_SERVICE_SECRET` is single static bearer with no rotation procedure or per-property scoping (Surface 5, P2)
  - F-C-2: `ELEVENLABS_WEBHOOK_SECRET` is shared workspace bearer (Surface 7, P2 — 2-step exploit requires both bearer AND a live voice nonce)
- **Root-cause change**: per-purpose JWT-style tokens with `property_id` claim + 1-hour TTL, signed by the master secret. Reduces blast radius from "all properties forever" to "one property for one hour."
- **PR plan**: introduce `src/lib/scoped-bearer.ts` minting helpers; switch ml-service auth to verify property+expiry claims; switch ElevenLabs webhook to ElevenLabs's signed-payload mode (HMAC over body + timestamp + nonce, ElevenLabs supports this). Add IP allow-list on the ElevenLabs webhook as defense-in-depth.
- **Severity**: P2

### Pattern A — server-resolved identity at trust boundaries
- **Instances closed by Codex pre-discovery PR 1 (already landed)**:
  - F-A-0: Voice agent identity forgery via `dynamic_variables` (P0, **closed**)
- **Net-new instances**:
  - F-A-1: `/api/sms-reply` ambiguous-phone resolution picks newest-updated staff row regardless of tenant (Surface 6, P3 — wrong-tenant magic-link delivered)
  - F-A-2: CUA `$username` substitution doesn't validate target field type — credential could be typed into a non-credential input (Surface 3, P3)
  - F-A-3: dynamic_variables fallback chain in voice-brain is broad and silent (Surface 7, P3 — defense-in-depth only)
- **Root-cause posture**: code-review rule — every cross-boundary entry point reads identity ONLY from server state, never from input. Currently captured implicitly; codify as an INVARIANTS.md entry.
- **PR plan**: small adjacent fixes per finding; no shared primitive needed.
- **Severity**: P3

### Pattern B — single safe entry point for dangerous operations
- **Instances closed by Codex pre-discovery PR 2 (already landed)**:
  - F-B-0: Recipe runner SSRF — closed by `safeGoto` + CI grep guard (P1)
- **Net-new instances**:
  - F-B-1: ml-service f-string SQL across 8 sites; UUID-validated upstream but fragile pattern (Surface 5, P2)
  - F-B-2: Sentry init duplicated across 3 config files; edge variant missing `scrubSentryEvent` (Surface 4, P3 — latent since no edge routes today)
  - F-B-3: `safeGoto` doesn't re-validate URL after redirect chain (Surface 5, P3)
- **PR plan**: ml-service — `SupabaseServiceClient.execute_sql_params(sql, params)` + replace 8 sites + lint rule. Sentry — extract `makeSentryInit({ runtime })` helper. safeGoto — post-nav `page.url()` re-check.
- **Severity**: P2

### Pattern D — scoped admin client wrapper (defense-in-depth)
- **Net-new instances**:
  - F-D-1: `/api/admin/audit-log` doesn't UUID-validate `propertyId` before `.or()` interpolation (Surface 2, P3)
  - F-D-2: `/api/admin/diagnose` webhook_log not pid-filtered post-PR-3 (Surface 6, P3 — admin-gated only so contained)
  - F-D-3: `maintenance-photos` storage bucket lacks per-property RLS (Surface 2, P2 — auth-only)
- **Root-cause change**: build `scopedAdminClient(ctx)` wrapper that auto-applies the user's `property_access` filter and rejects non-UUID property fields at the boundary. Long-term refactor; not blocking.
- **Severity**: P2 (maintenance-photos) + P3 (others)

## Single-instance findings (no pattern partners)

### P2

- **F-S-1: No rate-limits on `check-trust`, `trust-device`, `accounts`, `team` endpoints** (Surface 1) — cost-burn vector for authenticated users. Fix: wrap auth-adjacent routes in a per-IP rate limit helper.
- **F-S-2: OTP brute-force only relies on Supabase project-wide cap** (Surface 1) — per-target gap. Fix: server-side `/api/auth/verify-otp` proxy with per-email + per-IP cap.
- **F-S-3: Scraper PMS credentials live in Node memory plaintext for entire process lifetime** (Surface 5) — defense-in-depth. Fix: re-decrypt on each `relogin()` + zero `ACTIVE_CREDS.password` after use.
- **F-S-4: No timestamp/replay validation on github + sentry webhooks** (Surface 5) — replay requires leaked payload; low-impact (writes duplicate row / re-sends SMS to Reeyen). Fix: dedupe via `X-GitHub-Delivery` + reject `sentry-hook-timestamp` > 300s old.
- **F-S-5: Manual migration risk** (Surface 5) — `applied_migrations` check works but is the only safety net. Fix: wrap `scripts/apply-migration.ts` in transaction + add Vercel build-step pre-check.
- **F-S-6: Voice turns are never persisted to `agent_messages`** (Surface 7) — no forensic trail. Today voice has no tools so impact is "lost transcripts." Becomes P1 the moment a voice tool ships.

### P3

- **Cookie `secure` flag uses NODE_ENV instead of unified env helper** (Surface 1) — fragile pattern; not exploitable today.
- **Onboard wizard PATCH steps 1-3 only gated by join-code** (Surface 1) — folded into Pattern G PR (the P1 above covers this).
- **`send_help_sms` is dead-letter no-op** (Surface 3) — no SMS consumer reads its `agent_nudges` payload. Recommended: delete the tool from the registry; update prompts to route through `request_help`. Prevents future devs from quietly turning P3 into P1 by wiring the dispatcher.
- **`send_help_sms` writes `recipient_phone` to agent_nudges.payload** (Surface 3) — PII in jsonb; closed by deletion above.
- **Email PII written to Vercel function logs on rare double-failure path** (Surface 4 — `/api/auth/accounts:241`) — switch to `log.error` + redact.
- **Picovoice access key returned plaintext to authenticated clients** (Surface 7) — bounded by Picovoice's domain restrictions; revisit when account exits pending review.
- **CSP `img-src 'self' data: https:` broad** (Surface 5) — tighten to explicit CDN allow-list.
- **GH Actions workflows not all `environment: production` scoped** (Surface 5) — best-practice gap.
- **`toggle_dnd` no note length cap** (Surface 3) — folded into Pattern F's `clampString` helper.

## Disputed / wontfix

- **Codex initial review's framing that voice "has zero callable tools"** — was technically true at the registry level but the route bypassed the surface filter. Closed by PR 1 (surface required at type level).
- **Single subagent's claim that scraper memory cred lifetime is exploitable** — Railway IAM gates the process; treat as defense-in-depth P2 hardening, not active vulnerability.

## Confirmed-clean (surfaces / patterns where we looked and found nothing)

- **Cross-tenant data leaks via API routes** — 3 unauthenticated curl probes against `https://getstaxis.com` all rejected with 401. RLS audit across ~60 enabled tables: every policy references `auth.uid()` / `user_owns_property()` / deny-all. `staff.auth_user_id` linkage uniqueness in prod: 0 duplicates.
- **`skip_2fa` prod state** — exactly 1 row (the documented investor demo per `~/.claude/.../project_investor_demo_account.md`).
- **Secret bundle exposure** — `npm run build` + grep on `.next/static/` for `sk-ant-*`, `sk_live_*`, `sb_secret_*`, `whsec_*`, `AC[a-f0-9]{32}`, server-only env var names: zero hits.
- **Doctor endpoint deep read** (3161 lines) — every `process.env.*` access returns presence/shape/decoded-claim only, never values. Stripe + Sentry + CRON_SECRET checks all length/prefix-only.
- **Source maps in production** — `find .next/static -name "*.map"` returns 0; `curl https://getstaxis.com/_next/static/chunks/main-app.js.map` → 404.
- **`requireCronSecret`-only admin route class audit** — only `sentry-test` remains (documented exception, returns no tenant data); CI test `admin-routes-auth-gate.test.ts` enforces.
- **Stripe webhook idempotency + property scoping** — `stripe_processed_events.event_id` PRIMARY KEY enforces atomic dedupe; checkout + portal both verify `property.owner_id === session.userId`.
- **Trial expiration** — query filter excludes paid/active rows.
- **Magic-link housekeeper token single-use** — Supabase `verifyOtp` consumes server-side; reuse attempts get 401.
- **`safeGoto` regression coverage** — 44 navigate tests (scheme, private IP, single-label, multi-part-suffix, malformed, off-site) + CI grep guard against new raw `page.goto(` callsites.
- **CUA mapper system prompt boundaries intact** — read-only rule + untrusted-content boundary + never-leave-domain rule all present at `cua-service/src/anthropic-client.ts:77-129`.
- **Vision invoice scan input validation** — mediaType whitelist + magic-byte check + 5MB cap + data-URL rejection + auth-gated + rate-limited.
- **Webhook signature verification** — Stripe (SDK + timestamp tolerance + dedupe), GitHub (HMAC-SHA256 + timingSafeEqual), Sentry (HMAC-SHA256 + timingSafeEqual), Twilio sms-reply (HMAC-SHA1 via `twilio.validateRequest`, form-encoded only in prod).
- **`exec_sql` RPC** locked to service-role (migration 0071); ml-service Pydantic UUID validators enforced on every property_id input.
- **CUA cost cap layers** — per-turn, between-phase, per-phase wallclock/tokens/step-count.
- **CUA timeout aborts in-flight Anthropic calls** via `AbortController` threaded into `messages.create({ signal })`.
- **Scraper cross-tenant env-tampering** — preflight at `scraper.js:806-810` exits if env property_id ≠ DB property_id.
- **HSTS preload + headers** — `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` shipped; doctor's `hsts_preload_status` check accounts for pending state.

## Time spent

- Phase A (7 surfaces × 1 Claude subagent, in 3 parallel batches): ~50 minutes wall-clock, well within Max-plan budget
- Phase B/C (synthesis + this report): ~10 minutes

## Phase D — recommended fix sequence

Order by severity + dependency:

1. **PR 4 (Pattern G, P1)** — onboard wizard fix: `crypto.randomBytes` join codes ≥ 128 bits + IP-keyed rate limit on `/api/onboard/wizard` PATCH+GET. Closes the only new P1 from Phase A. **Start immediately.**
2. **PR 5 (Pattern F, P2)** — `withCostCap({ scope, ceiling, window })` primitive + retrofit vision, CUA, voice. Closes 5 P2/P3 findings.
3. **PR 6 (Pattern C, P2)** — scoped bearer tokens for ml-service + ElevenLabs signed-payload migration. Closes 2 P2 findings.
4. **PR 7 (Pattern D, P2)** — `scopedAdminClient(ctx)` wrapper + `maintenance-photos` storage bucket RLS. Closes 3 D-pattern findings.
5. **PR 8 (Pattern B, P2)** — ml-service `execute_sql_params` + replace 8 f-string sites. Closes 3 B-pattern findings.
6. **PR 9 (defense-in-depth bundle, P3s)** — single-instance hardening: log redaction (`/api/auth/accounts:241`), Sentry edge config, post-redirect safeGoto re-check, `sms-reply` ambiguous-phone, `toggle_dnd` length cap, dead-letter `send_help_sms` deletion.

Each PR includes the architectural change (helper / type / CI check / runtime invariant) per the no-bandaid rule in the plan, not just the instance patch.
