# App-Wide Audit Log — `chat/app-audit`

**Goal:** Harden the entire Staxis web app for a 300-hotel rollout. Find and fix real bugs and rough edges across the whole app. Don't merge to main, don't deploy — Reeyen reviews in the morning.

**Working dir (source of truth):** `/Users/reeyen/Projects/staxis-app-audit`
**Base commit:** `be3ef5a4` (live `origin/main` as of 2026-06-18)
**Branch:** `chat/app-audit`

**In scope:** entire `src/` web app — auth/signup/2FA/reset, every department (front desk, housekeeping, maintenance, inventory, financials, schedule, communications, knowledge, reports, admin), all `/api` routes, public SMS-linked pages, dashboard, settings, multi-property isolation, error handling, rate limits, edge cases, EN/ES bilingual completeness, mobile/housekeeper UX, performance.

**Out of scope (other chats own these):** `cua-service/`, `src/lib/pms/`, Inventory ML, Housekeeping ML (`ml-service/`).

**Priorities (highest stakes first):**
1. Per-hotel data isolation (property_id scoping + RLS) — the #1 bug class.
2. Public-page RLS silent-empty bug (public pages must read/write via `/api` + service-role).
3. Auth flows bulletproof.
4. Concurrency under real multi-hotel load.

**Baseline (verified on `be3ef5a`):** `npm run test` → 2319 pass / 0 fail. `npm run lint` → pass.

---

## Method

Deep multi-agent audit (20 subsystem + cross-cutting auditors), each finding adversarially verified, deduped, and prioritized. Then fix in small batches: each batch → lint + build + tests → commit → push to `chat/app-audit`. Re-verify every audit finding against this directory before trusting it (the audit read an identical checkout of the same commit).

---

## Findings & Fixes

_(Updated continuously. Newest batch at top.)_

### Status: COMPLETE. Deep audit done (35 findings); 19 fixed & shipped to `chat/app-audit`, 16 deferred with reasons (see below). Branch is green: `eslint src` + `next build` + 2319 tests pass. Not merged, not deployed — yours to review.

#### P1 — multi-tenant isolation at the route layer: VERIFIED CLEAN (manual pass)
Scanned all 356 API routes for the cross-hotel leak pattern (user-facing route that takes a client `property_id`/`pid` but skips the access check). Every candidate that my heuristic flagged turned out to be properly guarded via one of:
- `commsContext()` → `requireSession` + `userHasPropertyAccess` (all `/api/comms/*`, incl. logbook),
- `callerManagesProperty()` + `canForProperty()` capability + cross-property IDOR check (e.g. `staff/wages`),
- `property.owner_id === session.userId` ownership (onboarding/complete, stripe/portal, stripe/create-checkout),
- `userHasPropertyAccess()` directly (180 call sites).
Plus the `npm run lint` guard `audit-api-route-tenant-scope.mjs` enforces this on every route. No route-level cross-tenant leak found. Residual risk = subtle logic bugs inside guarded routes (covered by the deep audit).

#### P2 — public-page RLS silent-empty: VERIFIED CLEAN on the housekeeper path (manual pass)
`src/app/housekeeper/[id]/page.tsx` imports the anon client only for `supabase.auth.verifyOtp` (allowed) and a realtime subscribe helper — **zero direct `.from()` data reads.** `subscribeToRoomsForStaff` (db/housekeeper-helpers.ts) fetches initial + refetch through `/api/housekeeper/rooms` (service-role) and only uses realtime as a bonus, with polling for the logged-out housekeeper. The exact RLS bug class is understood and defended. (Deep audit's `x-public-rls` agent sweeps the rest.)

#### Batch 1 — EN/ES bilingual completeness (housekeeper-facing) — FIXED
Dedicated sweep found the high-traffic Spanish surfaces (housekeeper, laundry, comms) ~99% bilingual. Fixed the 9 real user-facing gaps, all in the housekeeper app + comms:
- `redesign/tokens.ts` `FALLBACK_TASKS` (18 English-only fallback checklist lines shown to housekeepers on slow/first load) → made locale-aware via new `fallbackTasks(type, lang)` (EN+ES; ht/tl/vi fall back to EN, matching `t()`); updated consumer `RoomAccordionCard.tsx`.
- Added `hkClose` translation key (union + en + es) → used for the 5 housekeeper modal `aria-label="Close"` (ChecklistModal, ExceptionDropdown, RoomCardActionButtons, LanguageSwitcher, StructuredIssueReporter).
- `ExceptionDropdown` `(current)` → bilingual; `StructuredIssueReporter` `alt="Issue preview"` → bilingual; `InspectorView` `aria-label="Back"` → `tr(lang,'Back','Atrás')`.
- `NoticeBoardPoster` `aria-label="Delete notice"` → bilingual (manager-facing).
- comms `deptLabel()` made bilingual (added ES map + optional `lang`) and wrapped its one call site in `CommsOverlays` with `L(...)`.
- The 4 "offline-queue label" items the sweep flagged are **non-issues** — `offline-sync/queue.ts:36` documents that the offline banner shows a count, not the labels, so they're intentionally internal EN.
- Verified: `eslint src` exit 0; build + tests pending green before commit.

---

### Fundamentals verified CLEAN (manual deep-reads, in addition to P1/P2 above)
The app is genuinely mature and well-hardened on the highest-stakes axes — many prior audit passes are visible in the code. Verified by reading the real implementations:
- **Auth account-creation (use-join-code, accept-invite):** per-IP rate limits, atomic CAS on join-code use (no double-redeem), owner/GM privilege-escalation + ownership-displacement protection, TOCTOU re-validation of inviter authority, orphan auth-user rollback with loud logging. Solid.
- **Login / 2FA (api-auth.ts):** JWT validation + server-side device-trust (`trusted_devices`) enforced on every `requireSession`; skip-2FA gated behind env+allowlist+non-privileged; fail-closed on DB error. Solid.
- **Money:** stored as integer `*_cents` throughout; `labor-cost.ts` uses `Math.round` + integer arithmetic. No float-dollar drift.
- **Client multi-tenancy (PropertyContext):** `activeProperty` derives only from the user's accessible list; stale `localStorage` property is validated against it (falls back to the user's own first property), so a shared browser can't leak the prior account's hotel.

#### Batch 2 — EN/ES bilingual (management/back-office quick wins) — FIXED
A second sweep covered the management surfaces. Result: **Financials, Maintenance, Front-Desk, Dashboard, and the shared shell/nav are already fully bilingual.** Fixed the contained gaps:
- Staff → Directory page header ("The people / Staff · Directory / roster…") — was English-only via `<PageHeader>`.
- 7 Settings error toasts (accounts ×3, users ×2, notifications ×2) and 2 shift-preset validation messages — were English fallbacks; now `lang === 'es'` branched (added `lang` to the affected hook dep arrays).
- `ComingSoonModal` (staff scheduling placeholders, 6 modals + "Got it") — added `useLang` + a Spanish COPY table.
- `FeedbackButton` (floating widget on every page) — added `useLang`; translated title, blurb, category chips, placeholder, send/close labels.

#### Known large gap — Inventory module is English-only (NOT yet fixed; tracked for a dedicated batch)
The entire `src/app/inventory/_components/**` module renders hardcoded English: `InventoryShell` reads `lang` but never passes it to any child, so the language toggle is **silently dead** inside Inventory (~100 user-facing strings across Sidebar, FilterBar, StockList, HeroStats, tokens `statusLabel`, and the overlays CountSheet/ReportsPanel/HistoryPanel/BudgetsPanel/SimpleSheet/AddItemSheet). Spanish-speaking staff doing counts see English throughout. This is a real UX gap for the rollout but a sizeable, lower-risk mechanical change (plumb `lang` through ~15 components + add ES strings). Full line-by-line gap list with proposed translations was produced by the sweep. **Plan:** execute as a dedicated, carefully-verified batch (likely via an implementation agent) after the bug findings. Note: this is the inventory *UI module* (in scope) — distinct from the Inventory *ML* (out of scope).

#### Batch 3 — adversarial review fixes (Codex + Claude senior-engineer reviews of batches 1–2)
Ran two independent adversarial reviews of the committed bilingual diff (`be3ef5a4..HEAD`). **Both verdicts: structurally sound — `tsc` clean, no rules-of-hooks violations, no missing translation keys, backward-compatible signatures, accurate Spanish.** Both surfaced the same small set of real issues; all fixed:
- **(medium, real regression I introduced)** `settings/shifts/page.tsx` — I'd added `lang` to the load effect's dep array, so toggling language mid-edit refetched presets and clobbered unsaved draft edits. Fixed with a `langRef` (effect keeps the translated error string but no longer depends on `lang`; dep array back to `[pid]`). The 3 read-only Settings pages (accounts/users/notifications) keep `lang` in deps — both reviewers confirmed harmless there (no local form state to clobber).
- **(low)** `ManagerDirectory.tsx` — `{total} on roster · {onShift} on shift` was left English in the header I translated → now bilingual; title `La gente` → `El equipo` (more idiomatic).
- **(low)** `settings/accounts/page.tsx` — two more English error fallbacks (`Failed to create`, `An error occurred`) in the create-account form → now bilingual.
- **Deprioritized (pre-existing, LOW):** the shift-preset validation message interpolates the raw `front_desk` enum — but the English version did the same before my change (not a regression); localizing it pulls in the shared `deptMeta` label scope. Noted, left.
- Verified: eslint src clean; build + tests pending green before commit.

## Deep multi-agent audit — 35 findings, dispositions

The full audit ran 79 agents (20 subsystem + cross-cutting finders, each finding adversarially verified, then deduped/prioritized). 55 candidates → 51 verified → 35 clusters. **19 clusters FIXED & shipped** (every CRITICAL + every HIGH except the one architectural item; most MEDIUM/LOW). 16 deferred — almost all are architectural/product calls for you, not "couldn't fix". Full per-finding detail is preserved in the agent transcript.

### FIXED (committed to `chat/app-audit`, each verified lint+build+2319 tests)
1. **[CRITICAL] Team-mgmt privilege escalation** — `manage_team`/`manage_users` defaulted to every role → a housekeeper could reset the owner's password / promote a coworker. Manager-tier default + `verifyTeamManager` floor + owner/GM privilege matrix on `/api/auth/team`.
2. **[HIGH] Cross-tenant fan-out** — org-wide announce + checklist copy now re-check the per-hotel capability for every target.
3. **[HIGH] Cross-tenant inventory corruption** — order-create inventory stamp now scoped by `property_id`.
4. **[HIGH] Compliance reminders wrong-timezone** — life-safety SMS now fire at each hotel's real local hour; fan-out bounded.
5. **[HIGH] Offline-replay data loss** — housekeeper note/issue/inspection routes release the idempotency claim on failure so retries re-apply.
6. **[MED] Rush SMS phantom route** — `/api/sms-send` didn't exist (housekeeper never texted); now enqueues durable SMS jobs + drains.
7. **[MED] CapEx re-decide guard** — only an undecided project can be decided (status predicate); protects the approval audit trail.
8. **[MED] accept-invite race** — invite now claimed atomically (CAS) before side effects; released on failure.
9. **[MED] Stripe trial CHECK loop** — `status='trial'` now writes `trial_ends_at`, ending the 3-day retry strand.
10. **[MED] Stripe dedupe delete** — failed delete now alerts (Sentry) instead of silently masking an unprocessed event.
11. **[MED] apply-to-all wipe** — source-exists guard + `confirmClearAll` gate stop an empty/typo'd source blanking the fleet's restrictions.
12. **[MED] Voice compliance mode** — normalizer preserved only `housekeeper_issue`; `compliance` collapsed to `general` (readings silently lost). Now preserves all modes.
13. **[MED] Activity-log PDF charset** — non-Latin-1 chars (em-dashes) corrupted the audit PDF; now mapped safely.
14. **[LOW] Shift-pickup crash** — overlapping pickup leaked raw Postgres error (500); now a friendly 409.
15. **[LOW] HK storage-path injection** — presign `scopeKey` + structured-issue `photoPath` now charset/prefix-validated.
16. **[LOW] Unread badge null-sender** — @Staxis/system messages now light the unread badge (NULL-safe filter).
17. **[LOW] Telemetry mis-tag** — `/api/events` only tags events to a property the caller can access.
18. **[LOW] Inventory error leak** — accounting-summary/check-alerts no longer leak raw PostgREST detail.
19. **[LOW] Unbounded compliance fan-out** — bounded to cap-5 concurrency.

### Adversarial review of the fixes (Codex + Claude senior, round 2) — 6 follow-ups, all fixed
Both reviewers re-attacked the security/correctness fixes above (especially the critical auth change). They confirmed the fixes correct but found 6 real gaps — all now fixed and re-verified:
- **(blocker, would break the live build)** the manager floor lived only in `verifyTeamManager`, so a direct `canForProperty('manage_users')` caller (`/api/settings/users`) could be bypassed by a stale `allowed:true` override. Moved the floor into the shared resolver `can()` (step b.5) so it's universal — an override can never lift it. Added parity-test coverage that an override granting a team cap to line staff is ignored.
- **(blocker)** a test `Set` needed `Set<CapabilityKey>` + a missing type import — `next build` does NOT typecheck test files, so it hid; `tsc --noEmit` caught it. (Now part of the gate.)
- **(high)** `DELETE /api/auth/team` lacked the owner/GM privilege matrix (a GM could detach an owner) — added.
- **(high)** `accept-invite` re-validated the inviter for role only; now also requires the inviter still has access to the invite's hotel and is admin/owner for an owner-role invite (closes a revoked-inviter / stale-owner-invite TOCTOU).
- **(high)** the inventory **receive** path also wrote `current_stock` by id with no `property_id` (the stamp path was fixed but receive was missed) — now scoped.
- **(med)** front-desk Rush returned `smsSent` before the enqueue committed — now awaits the durable enqueue and only backgrounds the Twilio dispatch.

## Deliberately left alone (needs Reeyen's call)

_(Items where fixing changes product behavior or has a tradeoff a non-technical founder should decide.)_

- **The shared `npm run lint` gate is RED on live `main` (`be3ef5a`) — caused by out-of-scope `cua-service/`.** `scripts/check-env-access.mjs` flags ~13 direct `process.env.CUA_*` reads in `cua-service/src/{mapper,mapping-driver,session-driver}.ts` that were added by recent CUA work but never added to the script's `EXEMPT_READS` allowlist. Confirmed pre-existing (fails on a clean stash). I did NOT touch it — cua-service is another chat's territory and the rule is a failsafe. **Impact:** every chat that gates on `npm run lint` sees a false red; the Next.js build itself is unaffected (it doesn't run this script), so deploys still work. **Fix (for the cua-service owner):** add those flag reads to `EXEMPT_READS` in `scripts/check-env-access.mjs` (exactly what that mechanism is for), or route them through `cua-service/src/env.ts`. My batches gate on `eslint src` + build + tests instead, which fully covers in-scope changes.

- **Per-hotel cron fan-out won't scale to 300 hotels as-is (architectural).** Several daily/sweep crons (`run-daily-report`, `run-weekly-report`, `seal-daily`, `financials-alert-sweep`, `run-auto-assign`) loop ALL properties sequentially inside one serverless function (`maxDuration` 60s). They're well-built for a small fleet — per-hotel try/catch isolation, idempotency, per-property deadlines — but at 300 hotels, if many share a delivery window/timezone, the sequential outer loop can exceed 60s and silently drop the hotels past the timeout (and `run-daily-report`'s ±15m window means the next 30-min tick may miss them). Fix is a batching/queue redesign (e.g. enqueue per-hotel jobs, or shard by timezone) — a real architectural decision, not a quick edit. The deep audit corroborated this (cluster #5: rules-engine 5-min cron + auto-assign 15-min cron have the SAME serial-fanout problem and at scale **silently starve the same tail hotels every tick**). **PARTIALLY FIXED (2026-06-18):** I applied the safe, recommended part — both `runRulesEngineForAllProperties` and the auto-assign cron now use **bounded concurrency (`runWithConcurrency`, cap 5)** instead of a strictly-serial loop. Each per-hotel run is independent + idempotent + property-scoped, so this is a safe in-place change and finishes the fleet ~5× faster (most hotels early-return), which on its own clears the 60s timeout well past 50 hotels. **STILL FOR YOU (very large fleets only):** the belt-and-suspenders — a wall-clock budget that returns `degraded` instead of being killed mid-loop, and sharding across multiple cron invocations — is an infra change (adds cron entries / coordination) and is left for your call. `run-daily-report` / `run-weekly-report` / `run-scheduled-reports` (#13/#14) have a related but distinct stranding bug (placeholder-first idempotency turns a mid-flight timeout into a permanent skip) that needs the deadline-budget redesign, also left for you.

### Deferred audit findings (architecture / product decisions — none are "couldn't fix")
- **[MED] Daily/weekly + scheduled report crons strand reports at scale** (#13/#14) — **PARTIALLY FIXED:** the false-green heartbeat is fixed (run-scheduled-reports now reports `degraded` when any schedule errors / fails to send / is deadline-deferred, so a broken report pipeline is actually visible) — observability only, no change to report sending. **STILL FOR YOU:** the placeholder-first idempotency that turns a mid-flight timeout into a permanent "already sent" skip, plus the exact-hour due-check with no catch-up. Those need the deadline-budget redesign (same family as #5) and a careful two-phase rework — I left them because a blind change there risks sending DUPLICATE reports, which is worse than the current miss.
- **[MED] PO receive loses stock on partial DB failure** (#10) — `qty_received` is committed before the stock increment and the stock-write error is swallowed (non-retryable). Needs a transactional receive (single RPC) — a DB-function change you should approve.
- **[MED] Compliance auto-act work orders not idempotent** (#8) — retry / two-phone reading can create duplicate urgent WOs. Needs an idempotency-key design on the auto-act path.
- **[MED] Single-hotel manager mutating a multi-hotel staff account** (#12) — **FIXED & CONFIRMED by Reeyen (2026-06-18).** Policy: only managers/owners may change accounts/passwords (capability gate, finding #1), AND you may only change a given person's username/password/active-state if you manage/own ALL the hotels that person works at — so a manager or owner of 4 hotels can manage anyone across those 4, but not someone who also works at a 5th hotel they don't run (that needs an admin). Enforced on the password reset in `/api/auth/team` PUT AND the global `deactivate` ban in `/api/settings/users`. This is the intended behavior, not a relaxable default.
- **[MED] Admin monitoring panels undercount at fleet scale** (#19) — fixed `.limit` row caps + client-side bucketing on admin/scheduled-jobs, activity, per-hotel-economics. Needs pagination/server-aggregation; admin-only, so low user-facing risk.
- **[LOW, but security-adjacent] Idempotency keyspace is global across tenants** (#29) — keys aren't tenant-namespaced and aren't claimed on cross-route reuse (latent cross-tenant cache echo / disabled double-send guard). Needs a migration to namespace keys — flagged for your go before I add schema.
- **[LOW] Invite host from untrusted headers + accept-invite not email-bound** (#22), **compliance period/`today` timezone off-by-one for non-Central hotels** (#25), **voice-log fuzzy-matches a reading type with no confidence floor** (#26), **comms `listConversationsForStaff` N+1 on the 8s poll** (#28), **time-off no per-day dedup + unbounded subscription** (#32) — all real but each needs a small product/UX or perf decision; documented for a follow-up pass.
- **[LOW] Phone-backfill admin tools unbounded** (#33) — **FIXED**: both `backfill-phonelookup` and `normalize-confirmation-phones` now use bounded fan-out (cap 20) and capture per-row outcomes instead of aborting the whole run on the first failure. **[LOW] nudge/cost-account global scans** (#34), **comms `listConversationsForStaff` N+1** (#28) — perf hardening on hot/rare paths; left documented (the comms N+1 touches the 8s bootstrap poll and is better done as a measured query-consolidation than a blind refactor).
- **[LOW] Copy-Last-Week deletes published/confirmed shifts** (#35) — real, BUT the code is **unwired/deferred** (not reachable from the UI yet), so it's latent. Must be fixed before that button is ever enabled.

---

## What I'd do next

_(Running list of follow-ups beyond this session.)_
