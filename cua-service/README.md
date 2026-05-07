# Staxis CUA Service

Computer Use Agent worker that maps and extracts data from any PMS.
Runs on Fly.io. Polls Supabase `onboarding_jobs` for queued jobs and
processes them end-to-end.

## What it does

When a hotel GM saves their PMS credentials in `/settings/pms`, the
Next.js API queues an `onboarding_jobs` row. This service:

1. Picks up the job within ~5 seconds.
2. **Maps** the PMS if no recipe exists yet (uses Claude vision to learn
   how to log in and where the rooms/staff pages are). One mapping per
   PMS family — every subsequent hotel using that PMS skips this step.
3. **Extracts** rooms, staff, history, arrivals, departures using cheap
   Playwright (no Claude tokens in this path).
4. Persists everything to Supabase. Property goes live on the dashboard.

Architecture lives in `../src/lib/pms/` (shared types) and
`../supabase/migrations/0031_pms_recipes_and_onboarding.sql` (schema).

## First-time deployment

Prerequisites: `flyctl` installed, logged in (`flyctl auth login`).

```bash
cd cua-service

# 1. Create the app (one-time)
flyctl apps create staxis-cua

# 2. Set secrets
flyctl secrets set \
  ANTHROPIC_API_KEY="sk-ant-..." \
  NEXT_PUBLIC_SUPABASE_URL="https://xxx.supabase.co" \
  SUPABASE_SERVICE_ROLE_KEY="eyJ..." \
  CRON_SECRET="$(openssl rand -hex 32)"

# 3. Deploy
flyctl deploy

# 4. Watch it come up
flyctl logs
```

You should see:
```
[<ts>] INFO  CUA worker started workerId=fly-cua-iad-<id> pollIntervalMs=5000
```

## Subsequent deploys

```bash
cd cua-service
flyctl deploy
```

A rolling deploy keeps at least one machine alive while updates roll
through, so jobs in flight aren't dropped.

## Scaling

For more concurrent onboardings, scale machine count:

```bash
flyctl scale count 3       # three workers in iad
flyctl scale count 3 --region iad,ord  # multi-region
```

Each machine handles one job at a time. The claim is atomic
(UPDATE ... WHERE status='queued') so there's no double-processing
even if two workers see the same row simultaneously.

## Local development

```bash
npm install
npx playwright install chromium

# Set env vars in .env
echo "ANTHROPIC_API_KEY=sk-ant-..." >> .env
echo "NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co" >> .env
echo "SUPABASE_SERVICE_ROLE_KEY=eyJ..." >> .env

npm run dev
```

The dev mode uses `tsx watch` so file changes restart the worker.

## Debugging a stuck job

```bash
# Find the job
psql "$DATABASE_URL" -c "
  select id, property_id, pms_type, status, step, progress_pct, error
    from onboarding_jobs
   where status in ('running','mapping','extracting')
   order by created_at desc;
"

# Tail the worker logs for that job
flyctl logs | grep <job_id>

# Force a job back to queued so a different worker picks it up
psql "$DATABASE_URL" -c "
  update onboarding_jobs
     set status='queued', worker_id=null, started_at=null
   where id='<job_id>';
"
```

## Cost monitoring

The worker prints per-job duration in its complete log:

```
{"level":"info","msg":"job complete","jobId":"...","durationMs":54000}
```

Anthropic API spend per job:
- Mapping run (new PMS): $1-3, ~20-30 Claude calls
- Extraction only (known PMS): $0, no Claude calls

At 300 hotels with the top 5-7 PMSes covered, expect $200-500/month
total Claude spend. Set a `Monthly spend limit` in the Anthropic
Console as a safety cap.
