# Staxis (HotelOps AI)

AI-powered operations platform for limited-service hotels. The first paying
customer is Comfort Suites Beaumont; the product handles housekeeping
scheduling, room turnover tracking, work orders, preventive maintenance,
inventory, public-area cleaning, and SMS-driven shift coordination.

Live at **https://hotelops-ai.vercel.app**.

This README is the entry point for engineers working on the codebase. For
operator-facing documentation, see the in-app help page; for incident
response, see [`RUNBOOKS.md`](./RUNBOOKS.md); for the full project history
and design rationale, see [`CLAUDE.md`](./CLAUDE.md).

---

## Stack

- **Framework:** Next.js 16 (App Router) + TypeScript (strict)
- **Database:** Supabase (Postgres + Realtime + Auth)
- **Hosting:** Vercel (web app, API routes, cron) + Railway (Playwright
  scraper that pulls room-status CSVs from Choice Advantage)
- **SMS:** Twilio
- **Tests:** node:test (scraper) + tsx --test (TypeScript suites)

The data access layer is split into 22 domain modules under
[`src/lib/db/`](./src/lib/db/) (rooms, staff, work-orders, inventory, …).
Each module owns its queries against the Supabase Postgres instance and
exposes typed read/write/subscribe helpers used by both the React UI and
the API routes.

---

## Local development

```bash
git clone https://github.com/Reeyenn/staxis
cd staxis
npm install
cp .env.local.example .env.local   # fill in Supabase + Twilio creds
npm run seed                       # creates admin user + Comfort Suites property
npm run dev                        # http://localhost:3000
```

You'll need:

- A Supabase project (free tier works) with the migrations in
  [`supabase/migrations/`](./supabase/migrations/) applied. Apply with
  `supabase db push` or by running each `.sql` file in the SQL editor.
- Twilio credentials (account SID, auth token, sending phone number) — only
  needed for end-to-end SMS flows; you can no-op `sendSms` in `src/lib/sms.ts`
  for pure UI work.

### Required environment variables

| Variable | Where used | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Browser + server | Public; safe to expose |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Browser + server | Public anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | Server only | **Never** ship to client |
| `TWILIO_ACCOUNT_SID` | Server only | |
| `TWILIO_AUTH_TOKEN` | Server only | |
| `TWILIO_PHONE_NUMBER` | Server only | E.164 format |
| `CRON_SECRET` | Server only | Bearer token for `/api/cron/*` and other admin routes |
| `SENTRY_DSN` | Server (optional) | If empty, Sentry is a no-op |

---

## Useful npm scripts

| Script | What it does |
|---|---|
| `npm run dev` | Next.js dev server |
| `npm run build` | Production build |
| `npm run lint` | Next/ESLint check |
| `npm run test` | Scraper + db-mappers unit tests (~30s) |
| `npm run test:scraper` | Scraper tests only |
| `npm run seed` | Idempotent seed: admin user, property, staff, public areas |
| `npm run seed:reset` | Drops and re-seeds (destructive) |

---

## Repo layout

```
src/
  app/                     ← Next.js App Router (pages + API routes)
    api/                   ← API route handlers (~25 routes, see audit)
      admin/doctor/        ← Multi-check health endpoint (CRON_SECRET-gated)
      cron/                ← Scheduled jobs (post-deploy, daily-drift, …)
      send-shift-confirmations/  ← The SMS critical path
      ...
  lib/
    db.ts                  ← Re-export shim (the original 1700-line monolith)
    db/                    ← 22 domain modules + _common.ts shared infra
    api-validate.ts        ← Hand-rolled zod-equivalent input validation
    api-ratelimit.ts       ← Postgres-backed per-property hourly limits
    api-auth.ts            ← requireSession / requireCronSecret helpers
    log.ts                 ← Structured logging (requestId, durationMs, …)
    supabase.ts            ← Browser client (anon key)
    supabase-admin.ts      ← Server client (service-role) — fails loudly
  types/                   ← Hand-rolled Supabase types

supabase/migrations/       ← SQL schema + RLS + functions

scraper/                   ← Railway-hosted Playwright scraper
  scraper.js               ← Pulls Choice Advantage CSV every 5 min
  vercel-watchdog.js       ← Cross-platform failsafe (pings doctor)
  __tests__/               ← Scraper unit tests

.github/workflows/         ← CI (tests, deploy smoke, drift, scraper-health)
```

---

## Failsafes — the load-bearing infrastructure

Reeyen has invested heavily in fail-loud / fail-fast infrastructure because
silent failures cost real money (Twilio credits, missed shift confirmations).
These are documented in detail in [`CLAUDE.md`](./CLAUDE.md) under
"Failsafes — Do Not Remove These". Short list:

1. **`/api/admin/doctor`** — single endpoint that tests every critical
   dependency in parallel. Called by post-deploy smoke test, daily drift
   check, and the Railway-hosted Vercel watchdog.
2. **`supabase-admin.ts`** throws at module load if env vars are missing.
3. **The scraper** does a preflight DB read at startup and exits 1 if it
   fails. Railway crash-loops visibly.
4. **GitHub Actions workflows** in `.github/workflows/`:
   - `tests.yml` — every push and PR
   - `post-deploy-smoke-test.yml` — every push to main
   - `daily-drift-check.yml` — once per day
   - `scraper-health-cron.yml` — every 15 min
   - `scraper-weekly-digest-cron.yml` — Saturdays
5. **Railway watchdog** (`scraper/vercel-watchdog.js`) — pings doctor
   endpoint every 5 min, SMS alerts on 3 consecutive failures.
6. **`RUNBOOKS.md`** — symptom → diagnosis → fix per failure type.

Do **not** delete or weaken any of these without understanding what they
protect against. Every one of them exists because of a specific past
incident.

---

## Deploy

`main` branch auto-deploys to Vercel. The scraper auto-deploys to Railway
from the same repo when files under `scraper/` change.

For the Vercel-side env var rotation playbook, see
[`Second Brain/05 Personal/[C] Recovery Codes & Credentials.md`](../Second%20Brain/05%20Personal/) (Reeyen's vault — not in this repo).

---

## Where things live for new engineers

- **"Where do API routes live?"** → `src/app/api/<route-name>/route.ts`
- **"How does data flow?"** → UI calls `fetch('/api/...')` or
  `subscribeToX()` from `src/lib/db/`. API routes use `supabaseAdmin`
  (service-role); UI uses `supabase` (anon, RLS-restricted).
- **"How is auth enforced?"** → `requireSession(req)` for user routes;
  `requireCronSecret(req)` for cron / admin routes. RLS on every table.
- **"Where do I add a new SMS-firing endpoint?"** → Add the endpoint name
  to the `RateLimitEndpoint` type + `HOURLY_CAPS` map in
  `src/lib/api-ratelimit.ts`, then `await checkAndIncrementRateLimit(...)`
  at the top of the route. Mirror the pattern from
  `send-shift-confirmations`.
- **"How do I add a new table?"** → Write a migration in
  `supabase/migrations/000N_*.sql` with the table, RLS policy, and
  indexes. Add a domain module under `src/lib/db/<table>.ts` exporting
  read/write/subscribe helpers. Update `src/lib/db.ts` to re-export.
- **"I'm changing the AI agent layer."** → Read
  [`src/lib/agent/INVARIANTS.md`](./src/lib/agent/INVARIANTS.md)
  first. Every invariant the agent layer depends on is listed there,
  with the DB constraint that enforces it. New features add new
  invariants AND new constraints. This rule is what stopped the
  11-round bug-fix loop (Round 12, 2026-05-13).

---

## License

Proprietary. © Reeyen Patel. All rights reserved.
