# HotelOps AI — Choice Advantage Scraper

Playwright script that logs into Choice Advantage every 15 minutes and writes
live room status data to Supabase Postgres. Deployed to Railway.

## Setup

```bash
cd scraper
npm install
npx playwright install chromium
cp .env.example .env
# Fill in .env with real values
```

## Environment Variables

| Variable | Value |
|---|---|
| `CA_USERNAME` | `bcobbs.txa32` |
| `CA_PASSWORD` | (get from hotel) |
| `NEXT_PUBLIC_SUPABASE_URL` | Project URL from Supabase → Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role key from Supabase (server-only — do not expose to browsers) |
| `HOTELOPS_USER_ID` | `data_user_id` (auth.users.id UUID) of the hotel owner account |
| `HOTELOPS_PROPERTY_ID` | `properties.id` UUID for Comfort Suites |
| `CRON_SECRET` | Cross-platform watchdog secret — must match Vercel + GitHub Actions |

## Getting Supabase Credentials

1. Supabase Dashboard → your project → Project Settings → API
2. Copy **Project URL** into `NEXT_PUBLIC_SUPABASE_URL`
3. Copy **service_role** key into `SUPABASE_SERVICE_ROLE_KEY`
   (never ship this to the browser — it bypasses Row Level Security)

## Getting HOTELOPS_USER_ID and PROPERTY_ID

1. Log into HotelOps AI as the hotel owner
2. Supabase Dashboard → Table Editor:
   - `accounts` → find your row → copy `data_user_id` into `HOTELOPS_USER_ID`
   - `properties` → find the Comfort Suites row → copy `id` into `HOTELOPS_PROPERTY_ID`

## Run locally

```bash
node scraper.js
# or with headed browser for debugging:
HEADED=true node scraper.js
```

## Deploy to Railway

1. Create a new Railway project
2. Point to this `/scraper` directory (or push as a separate repo)
3. Add all env variables in Railway dashboard
4. Railway uses `railway.toml` for build/start commands automatically

## What it writes to Supabase

Table: `rooms`

Each row looks like:

```json
{
  "property_id": "uuid",
  "date": "2026-04-22",
  "number": "101",
  "type": "checkout",
  "status": "dirty",
  "priority": "standard",
  "assigned_to": null,
  "assigned_name": null,
  "is_dnd": false,
  "_ca_room_type": "SNQQ",
  "_ca_room_status": "Vacant",
  "_ca_service": "Check Out",
  "_last_synced_at": "2026-04-22T15:00:00Z"
}
```

Unique constraint: `(property_id, date, number)` — the scraper uses an upsert
on this key, so re-running the same scrape is idempotent.

## Error handling

- Session expires → auto re-login
- 0 rooms scraped → logs warning, does not crash
- Any error → logged, process continues to next interval
- Outside 6am–10pm → skips silently

## Failsafes (cross-platform)

- **Preflight:** scraper reads `scraper_status` on boot — if Supabase is
  unreachable or the service_role key is wrong, the process exits 1 and
  Railway crash-loops visibly.
- **Vercel watchdog:** every 5 min the scraper pings
  `hotelops-ai.vercel.app/api/admin/doctor` with `Authorization: Bearer
  $CRON_SECRET`. Three consecutive failures (or an `auth_mismatch` on the
  first hit) trigger SMS alerts. Gracefully no-ops if `CRON_SECRET` is
  missing. Wrapped in its own try/catch so watchdog bugs can never crash
  the main scraper loop.
