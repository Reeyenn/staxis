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

### Status: audit in progress — findings to be logged below as fixes land.

---

## Deliberately left alone (needs Reeyen's call)

_(Items where fixing changes product behavior or has a tradeoff a non-technical founder should decide.)_

---

## What I'd do next

_(Running list of follow-ups beyond this session.)_
