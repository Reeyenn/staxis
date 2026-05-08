---
name: deploying-cua
description: Use when redeploying the Fly.io CUA worker (`staxis-cua`), updating its env/secrets, or debugging stuck onboarding jobs. Trigger phrases include "redeploy CUA", "deploy cua-service", "Fly deploy", "staxis-cua", "onboarding worker", "stuck onboarding job", or any change that touches `cua-service/`.
---

# Deploying the Fly CUA worker

The CUA service polls `onboarding_jobs` and processes them — for an unmapped PMS it runs Claude vision (~$1-3) to learn the layout, then extracts cheaply. Hosted on Fly.io as `staxis-cua`.

## Routine redeploy (after code change in `cua-service/`)

```bash
cd cua-service && flyctl deploy --app staxis-cua --remote-only
```

- Takes 4-7 min (rolling deploy — at least one machine stays alive while updates roll through, so jobs in flight aren't dropped).
- Verify: `flyctl logs --app staxis-cua` should show `"msg":"CUA worker started"` within ~30 seconds.

## Rotating Fly secrets

```bash
flyctl secrets set ANTHROPIC_API_KEY="sk-ant-..." --app staxis-cua
flyctl secrets set SUPABASE_SERVICE_ROLE_KEY="eyJ..." --app staxis-cua
flyctl secrets set CRON_SECRET="..." --app staxis-cua
```

Each `secrets set` triggers a rolling restart automatically. Don't bundle multiple secret changes unless you want them all to land at the same time.

For full-platform rotation (when a key is compromised across Vercel + Railway + Fly), see `RUNBOOKS.md` → Supabase service_role key rotation.

## Scaling

```bash
flyctl scale count 3 --app staxis-cua          # three workers in iad
flyctl scale count 3 --region iad,ord --app staxis-cua  # multi-region
```

Each machine handles one job at a time. The claim is atomic (`UPDATE ... WHERE status='queued'`) so two workers can't double-process the same row.

## Debugging a stuck onboarding job

```bash
# 1. Find the job
psql "$DATABASE_URL" -c "
  select id, property_id, pms_type, status, step, progress_pct, error
    from onboarding_jobs
   where status in ('running','mapping','extracting')
   order by created_at desc;
"

# 2. Tail worker logs
flyctl logs --app staxis-cua | grep <job_id>

# 3. Force the job back to queued so a different worker picks it up
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

- Mapping run (new PMS): $1-3, ~20-30 Claude calls
- Extraction only (known PMS): $0, no Claude calls

At 300 hotels with the top 5-7 PMSes covered, expect $200-500/month total Claude spend. Set a `Monthly spend limit` in the Anthropic Console as a safety cap.

## First-time deployment (only relevant if recreating from scratch)

```bash
cd cua-service
flyctl apps create staxis-cua
flyctl secrets set \
  ANTHROPIC_API_KEY="sk-ant-..." \
  NEXT_PUBLIC_SUPABASE_URL="https://xxx.supabase.co" \
  SUPABASE_SERVICE_ROLE_KEY="eyJ..." \
  CRON_SECRET="$(openssl rand -hex 32)"
flyctl deploy
```

## Common gotchas

- **Local dev uses `tsx watch`** — file changes auto-restart. `cd cua-service && npm install && npx playwright install chromium && npm run dev`.
- **CUA service has its own `cua-service/src/types.ts`** — when adding a new `RecipeStep` kind to `src/lib/pms/recipe.ts`, mirror it in `types.ts` AND `recipe-runner.ts` here, or new step types will silently no-op when running. See the `pms-abstraction` skill for the full multi-file dance.
- **Don't replace the rolling-deploy with single-machine deploy** — drops in-flight jobs.
