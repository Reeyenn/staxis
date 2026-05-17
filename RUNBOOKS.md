# Staxis / HotelOps AI — Operational Runbooks

One section per known failure mode. Each has:
- **Symptom** — what Reeyen sees first
- **Diagnosis** — commands/URLs to confirm the cause
- **Fix** — exact steps to resolve
- **Verify** — how to confirm it's fully fixed
- **Prevention** — what failsafe catches this next time

---

## Start here: the one-command diagnostic

When ANYTHING feels off, run this first:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  https://hotelops-ai.vercel.app/api/admin/doctor | python3 -m json.tool
```

The doctor endpoint tests every critical dependency in parallel and returns a report. Each failing check has a `detail` and a `fix` field that tells you exactly what's wrong and what to do. **If the doctor is green, the problem is not in Vercel/env/auth** — move on to scraper-health or application logs.

---

## Supabase service_role key rotation

(Successor to the legacy Firebase service account rotation procedure.
Firebase was removed on 2026-04-22; the old Firebase section is preserved
as a comment at the bottom of this file in case we ever need the history.)

### Symptom
- GitHub Actions "Scraper Health Check" emails with workflow failure
- Doctor endpoint `supabase_admin_auth` check returns `fail`
- `supabase-admin.ts` throws `Supabase Admin auth failed on Vercel: JWT expired / Invalid API key`
- Scraper crash-loops on Railway with `Supabase auth failed at startup`

### Diagnosis
```bash
# 1. Which platform is broken?
curl -H "Authorization: Bearer $CRON_SECRET" \
  https://hotelops-ai.vercel.app/api/admin/doctor | python3 -m json.tool

# Look at supabase_admin_auth check. If it's "fail", Vercel's key is bad.
# If Vercel is fine but scraper-health shows heartbeat_dead, Railway's is bad.

# 2. Is the current key valid?
# Browse: Supabase Dashboard → Project Settings → API → service_role
# Compare the first 8 chars of the dashboard key vs the one in Vercel/Railway env.
```

### Fix
Full playbook lives in `Second Brain/05 Personal/[C] Recovery Codes & Credentials.md`. Short version:

1. Supabase Dashboard → Project Settings → API → **Reset service_role key** (old key dies instantly; Supabase rotates atomically, no grace period — plan this for a maintenance window).
2. Copy the new key.
3. **Update Railway** → `hotelops-scraper` → Variables → `SUPABASE_SERVICE_ROLE_KEY`. Auto-redeploys.
4. **Update Vercel** → `staxis` → Settings → Environment Variables → `SUPABASE_SERVICE_ROLE_KEY`. Click Redeploy.
5. **Update Fly** → `flyctl secrets set SUPABASE_SERVICE_ROLE_KEY="<new key>" --app staxis-cua`. Triggers a rolling restart.
6. Verify ALL THREE platforms work (see Verify below).

### Verify
```bash
# Doctor should be all green:
curl -H "Authorization: Bearer $CRON_SECRET" \
  https://hotelops-ai.vercel.app/api/admin/doctor | python3 -c "import sys,json; r=json.load(sys.stdin); print('ok' if r['ok'] else 'FAIL:', [c['name'] for c in r['checks'] if c['status']=='fail'])"

# Scraper-health should return condition=ok:
curl -H "Authorization: Bearer $CRON_SECRET" \
  https://hotelops-ai.vercel.app/api/cron/scraper-health

# Manually re-run the most recent failed GitHub Actions workflow to confirm green.
```

### Prevention
- **`supabase-admin.ts`** fails loudly at module load if env vars are missing, and `verifySupabaseAdmin()` throws a specific error if the key is stale.
- **`scraper.js`** does a preflight Postgres read at startup and `process.exit(1)` if it fails, so Railway crash-loops visibly instead of silently running with bad credentials.
- **Daily drift check workflow** runs every morning at 8am Central and compares Vercel auth vs Railway scraper health. Catches cross-platform rotation drift within 24h.
- **Post-deploy smoke test** runs after every push to main and calls the doctor endpoint. Catches a botched Vercel env var change within 3 minutes.

---

## ML_SERVICE_SECRET rotation

The bearer token Vercel + GitHub Actions cron use to authenticate calls to the `staxis-ml` Fly app. Three holders (Vercel, GitHub Actions secrets, Reeyen's local `~/.config/staxis/tokens.env`); a leak from any one of those grants unscoped train/predict access to every property until rotated.

### Symptom
- Doctor `ml_service_secret_strength` check returns `fail` ("too short" or "appears to be a placeholder")
- ML cron workflow logs `401 Unauthorized` against `https://staxis-ml.fly.dev/train/*`
- ml-service Fly logs `Invalid API token` on every incoming request

### Diagnosis
```bash
# 1. Is the deployed secret short / placeholder?
curl -H "Authorization: Bearer $CRON_SECRET" \
  https://getstaxis.com/api/admin/doctor | python3 -c \
  "import sys,json; r=json.load(sys.stdin); print([c for c in r['checks'] if c['name']=='ml_service_secret_strength'])"

# 2. Do all three sides match?
# Vercel:   Project Settings → Environment Variables → ML_SERVICE_SECRET (length only)
# GHA:      repo Settings → Secrets and variables → Actions → ML_SERVICE_SECRET (length only)
# Fly:      flyctl secrets list --app staxis-ml | grep ML_SERVICE_SECRET (digest only)
```

### Fix (atomic rotation)
1. Generate a new 32-char secret: `openssl rand -hex 32`
2. Update all THREE sides BEFORE any service tries to use the new value. Ordering: Fly first (refuses old immediately on restart), then Vercel (so cron stops sending old), then GHA (so scheduled jobs use new):
   - `flyctl secrets set ML_SERVICE_SECRET="<new>" --app staxis-ml` (triggers rolling restart)
   - Vercel → `staxis` → Settings → Environment Variables → `ML_SERVICE_SECRET` → Save → Redeploy
   - GitHub → repo Settings → Secrets and variables → Actions → `ML_SERVICE_SECRET` → Update
3. Update local `~/.config/staxis/tokens.env` so future Claude sessions can curl ml-service directly.

### Verify
```bash
# Doctor's check passes:
curl -H "Authorization: Bearer $CRON_SECRET" \
  https://getstaxis.com/api/admin/doctor | python3 -c \
  "import sys,json; r=json.load(sys.stdin); print([c for c in r['checks'] if c['name']=='ml_service_secret_strength'])"

# Manually trigger an ML cron and confirm 200:
curl -H "Authorization: Bearer $CRON_SECRET" \
  https://getstaxis.com/api/cron/ml-run-inference

# Fly logs should show successful authenticated requests after the rolling restart finishes.
```

### Prevention
- **Minimum length 32 chars enforced at startup** in `ml-service/src/config.py`. A short/missing secret fails ml-service to boot — Fly health check goes red within minutes, not weeks.
- **Doctor's `ml_service_secret_strength` check** runs every cron tick and screams `fail` on `<32 chars` OR obvious-placeholder patterns (`placeholder`, `changeme`, all-zeros, etc).
- **Per-property JWT bearer (backlog)** — replace the single static bearer with a 1-hour JWT carrying a `property_id` claim, so a leaked token has a 1hr × 1-property blast radius instead of forever × all-properties. See `docs/security-triage-2026-05-16.md` Pattern C.

---

## Scraper dead (Railway)

### Symptom
- SMS: "Staxis scraper DOWN — no heartbeat for X min. Check Railway deployment."
- `scraper-health` endpoint returns `condition: heartbeat_dead`
- Doctor `scraper_heartbeat` check returns `fail` with "stale"
- Maria reports PMS numbers are stuck on the dashboard

### Diagnosis
```bash
# 1. Confirm the staleness duration:
curl -H "Authorization: Bearer $CRON_SECRET" \
  https://hotelops-ai.vercel.app/api/admin/doctor | python3 -m json.tool | grep -A2 heartbeat

# 2. Railway → hotelops-scraper → Deployments → click latest → Logs.
#    Look for:
#      - "Supabase auth failed at startup" → bad SUPABASE_SERVICE_ROLE_KEY, see Supabase rotation runbook
#      - "CA login failed" → bad CA_PASSWORD, rotate on Railway
#      - crash loop with memory errors → Railway resource issue
#      - no recent logs at all → service was manually stopped / deploy stuck
```

### Fix

**If Supabase auth startup error:** follow Supabase service_role key rotation runbook above.

**If CA login failed:** Twilio/CA pw change. Update `CA_PASSWORD` on Railway → auto-redeploy.

**If service stopped/crashed with no actionable error:**
1. Railway → hotelops-scraper → Deployments
2. Click latest deployment → "Redeploy" button
3. Watch logs for `Supabase auth verified ✓` to confirm startup

**If Railway itself is down:**
- Check https://status.railway.app/
- Wait. The recovery SMS will fire automatically when the scraper comes back.

### Verify
- Railway logs show `heartbeat written` message within 5 min of deploy
- `curl .../api/cron/scraper-health` returns `{ok:true, condition:"ok"}`
- You receive a "Staxis scraper: recovered" SMS from the scraper-health cron

### Prevention
- Scraper writes heartbeat every 5 min; if it misses 4 ticks (20 min), scraper-health SMS fires.
- Scraper-health cron runs every 15 min via GitHub Actions — independent of Vercel/Railway so if ONE platform dies, the other still alerts.
- External watchdog (see `Second Brain/02 Projects/HotelOps AI/` docs) pings scraper-health from a third-party uptime monitor, catching cases where even GitHub Actions is down.

---

## Vercel deployment broken / bad env var

### Symptom
- App loads but cron routes return 500
- Doctor `env_vars` check lists missing/empty vars
- Pages that need Supabase Admin throw on first request
- Post-deploy smoke test workflow failed

### Diagnosis
```bash
# Doctor pinpoints the exact var:
curl -H "Authorization: Bearer $CRON_SECRET" \
  https://hotelops-ai.vercel.app/api/admin/doctor | python3 -m json.tool
```

### Fix
1. Vercel → `staxis` project → Settings → Environment Variables
2. Add/fix the var reported by the doctor
3. Deployments tab → latest deployment → `⋯` → Redeploy (select "Use existing Build Cache" to skip rebuild)
4. Watch for the redeploy to go "Ready"

### Verify
```bash
# Smoke test workflow re-run:
# GitHub → Actions → Post-deploy smoke test → Run workflow (on main)
# Should pass within 2–3 min.

# Or directly:
curl -H "Authorization: Bearer $CRON_SECRET" \
  https://hotelops-ai.vercel.app/api/admin/doctor
```

### Prevention
- Doctor's `env_vars` check enumerates every required var — if you add a new env var to code, add it to `REQUIRED_ENV_VARS` in `src/app/api/admin/doctor/route.ts`.
- Post-deploy smoke test runs on every push to main and fails the workflow (= email) if the doctor is red.

---

## CRON_SECRET mismatch between Vercel and GitHub Actions

### Symptom
- GitHub Actions workflow fails with `curl: The requested URL returned error: 401 Unauthorized`
- All cron endpoints (`scraper-health`, `scraper-weekly-digest`, `admin/doctor`) return 401

### Diagnosis
```bash
# Manually hit the endpoint with the shell's CRON_SECRET. If 401 with the
# same value that GitHub is using, both are stale. If 200 locally but 401
# from GH Actions, GH secret is out of sync with Vercel.
curl -i -H "Authorization: Bearer $CRON_SECRET" \
  https://hotelops-ai.vercel.app/api/admin/doctor
```

### Fix
`CRON_SECRET` must match across **four** places: Vercel, GitHub Actions, Railway, Fly. Any drift = 401s.

1. Generate a fresh secret: `openssl rand -hex 32`
2. **Vercel** → Environment Variables → update `CRON_SECRET` → Redeploy
3. **GitHub** → repo → Settings → Secrets and variables → Actions → update `CRON_SECRET` with the SAME value
4. **Railway** → `hotelops-scraper` → Variables → update `CRON_SECRET` (used by the Vercel watchdog). Auto-redeploys.
5. **Fly** → `flyctl secrets set CRON_SECRET="<value>" --app staxis-cua`. Rolling restart.
6. Re-run the latest failed workflow to confirm.

### Verify
- Post-deploy smoke test runs green
- Scraper health check workflow runs green on its next 15-min tick

### Prevention
- Doctor's `cron_secret_shape` check catches placeholder values and too-short secrets.
- `RUNBOOKS.md` section on this failure mode so future sessions know the two-places-to-update pattern.

---

## Vercel watchdog (Railway-hosted) fires an alert

### Symptom
- SMS: "Staxis Vercel watchdog: 3 consecutive fails. Last status: ..."
- OR Railway logs show `[watchdog] alert fired` lines
- OR Railway logs show `[watchdog] auth mismatch — CRON_SECRET drift between Railway and Vercel`

### What this means
The scraper (on Railway) pings `hotelops-ai.vercel.app/api/admin/doctor` every 5 min. This is a **cross-platform check** — Railway watching Vercel, completely independent of GitHub Actions. If it trips, either Vercel is genuinely broken OR the `CRON_SECRET` has drifted between Railway and Vercel.

### Diagnosis
```bash
# 1. Manually hit the doctor from outside (same as the watchdog does):
curl -i -H "Authorization: Bearer $CRON_SECRET" \
  https://hotelops-ai.vercel.app/api/admin/doctor

# - 200 with all green → false alarm, watchdog has since recovered
# - 401 → CRON_SECRET mismatch (see section below)
# - 503 with red checks → Vercel is genuinely broken, follow the relevant runbook
# - Timeout/connection refused → Vercel platform outage
```

### Fix
- If doctor returns 401: CRON_SECRET on Railway doesn't match Vercel. Update Railway's `CRON_SECRET` env var to match Vercel's current value.
- If doctor returns 503 with a specific red check: follow the runbook for that check (supabase auth / env vars / etc).
- If doctor is unreachable: Vercel platform outage, wait it out. Watchdog will auto-recover when Vercel returns.

### Verify
- Railway logs show `[watchdog] doctor ok (prevCount=0)` on the next 5-min tick
- Doctor returns 200 from the shell

### Prevention
- Watchdog uses a 3-failure threshold (15 min) before alerting to absorb transient Vercel 502s.
- `auth_mismatch` (HTTP 401) short-circuits the threshold — alerts on first occurrence because auth drift is never transient.
- Watchdog is wrapped in its own try/catch so it can never crash the main scraper loop — if watchdog code itself has a bug, the scraper keeps running and Railway logs show `[watchdog] crashed (non-fatal)`.

---

## GitHub Actions workflow failing

### Symptom
- Email from GitHub: "[Reeyenn/staxis] Run failed: ..."

### Diagnosis
1. Click the email link → GitHub Actions run page
2. Expand the failing step → read the error at the bottom (usually specific)
3. The curl command prints the JSON response body — doctor/scraper-health responses are self-explaining

### Fix
Depends on what broke — usually one of:
- CRON_SECRET mismatch → see section above
- Vercel deploy broken → see section above
- Supabase service_role key rotation → see section above
- Actual scraper/dashboard issue → `scraper-health` response `condition` field tells you

### Verify
Re-run the failed workflow from the GitHub UI (`Re-run all jobs` button). It should pass.

### Prevention
- Each workflow has verbose logging with `set -x` and prints full response bodies so diagnosis is one click.
- Workflows retry transient errors (`--retry 2 --retry-delay 5`) so one-off network blips don't email you.

---

## Complete blackout — everything's down

### Symptom
- Doctor endpoint doesn't respond at all (timeout, 503, DNS failure)
- Site is unreachable
- Multiple workflows failing at once

### Diagnosis
```bash
# 1. Is Vercel up? https://www.vercel-status.com/
# 2. Is GitHub up? https://www.githubstatus.com/
# 3. Is Railway up? https://status.railway.app/
# 4. Is Supabase up? https://status.supabase.com/
# 5. Can you hit Vercel at all?
curl -I https://hotelops-ai.vercel.app/
```

### Fix
- If a platform is down, wait. All three have SLAs and self-recover.
- If platforms are up but the app isn't: Vercel → Deployments → check latest deploy status. Possibly revert by promoting an earlier Ready deployment.

### Verify
- Doctor endpoint returns 200
- Dashboard loads in the browser
- Scraper-health workflow next tick is green

### Prevention
- External watchdog (independent of GitHub/Vercel) will alert during mass outages.
- Keep a known-good Vercel deployment ID in your notes so you can one-click revert.

---

## Supabase JWT key expiration

**Symptom:** Doctor check `supabase_jwt_expiry` shows WARN (expires within 30 days) or FAIL (already expired). If already expired: every admin route starts returning 500 within minutes, the app UI shows "Failed to fetch" errors, and `supabase_admin_auth` also flips red.

**Diagnosis:**
```bash
# Decode the exp claim of either key (the middle base64url segment):
node -e 'const [,p]=process.env.KEY.split("."); console.log(new Date(JSON.parse(Buffer.from(p.replace(/-/g,"+").replace(/_/g,"/"),"base64").toString()).exp*1000).toISOString())' \
  KEY="<paste-key-here>"
```
The legacy Supabase JWT format (`eyJhbGci…`) has an `exp` claim, typically ~10 years from issuance. If you see this check in the WARN tier, schedule rotation on a calm day — not during an outage.

**Fix:**
1. Supabase Dashboard → Project Settings → API → Legacy API Keys → **Reset** service_role key (and anon key if it's also nearing expiry). Old keys die instantly.
2. Vercel → Project Settings → Environment Variables → update `SUPABASE_SERVICE_ROLE_KEY` (and `NEXT_PUBLIC_SUPABASE_ANON_KEY` if rotated) → Redeploy.
3. Railway → hotelops-scraper → Variables → update `SUPABASE_SERVICE_ROLE_KEY` → auto-redeploys.
4. Wait for both deploys to finish (Vercel ~2 min, Railway ~90 sec).

**Verify:**
```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://hotelops-ai.vercel.app/api/admin/doctor | jq '.checks[] | select(.name=="supabase_jwt_expiry")'
```
Should show `status: "ok"` with fresh expiry (~10 years).

**Prevention:** The doctor's `supabase_jwt_expiry` check warns 30 days ahead. The Railway vercel-watchdog polls doctor every 5 min, so even if GitHub Actions is down, you get SMS within a day of the WARN flipping on.

---

## MANAGER_PHONE missing or malformed on one platform

**Symptom:** Scraper crashes or hits an error but you never get an SMS alert. GitHub Actions workflow for scraper-health shows green. Doctor check `alert_phone_shape` is red or skipped.

**Diagnosis:** Compare `MANAGER_PHONE` (or `OPS_ALERT_PHONE`) values:
- Vercel → Project Settings → Environment Variables.
- Railway → hotelops-scraper → Variables.
Both should be set and identical, in E.164 format (`+12816669887`, no spaces, no parens).

The `alert_phone_shape` doctor check catches malformed values on Vercel. It CANNOT check Railway directly — for that, look at Railway → Deployments → Logs and search `[watchdog] CRON_SECRET not set` (the watchdog silently no-ops if CRON_SECRET is missing, but we don't have a similar check for MANAGER_PHONE).

**Fix:**
1. On whichever platform is missing / malformed, set `MANAGER_PHONE` to Reeyen's actual cell in E.164.
2. Trigger a redeploy on that platform so the new env takes effect.

**Verify:**
Trigger a known-fail condition (easiest: `curl -X POST https://hotelops-ai.vercel.app/api/cron/scraper-health -H "Authorization: Bearer $CRON_SECRET"` while forcing a fake condition — or just wait until the next real scraper error). Confirm you get an SMS.

**Prevention:** `alert_phone_shape` doctor check validates Vercel-side at every doctor call. For Railway-side drift, the daily-drift-check workflow catches it indirectly (if Railway scraper fails and tries to alert, the SMS send errors into the scraper logs — add a Railway log-based alarm if this keeps biting).

---

## GitHub Actions cron silently disabled

**Symptom:** No workflow emails for 2+ days. Manual check of the Actions tab shows one or more workflows marked "This scheduled workflow has been disabled" or simply not running. Doctor check `scraper_health_cron` is red (lastCheckAt >25h stale).

**Common causes:**
- GitHub auto-disables scheduled workflows on public repos after 60 days of no repo activity.
- Actions tab setting changed from "Allow all actions" to a more restrictive mode.
- Actions billing lapsed (free tier exhausted for private repos).
- PAT used by any action expired (less common for our workflows — they use `secrets.CRON_SECRET` directly).

**Diagnosis:**
```bash
gh workflow list --repo Reeyenn/staxis
# Look for "disabled_manually" / "disabled_inactivity" status.
```
Or visually: Actions tab → left sidebar → each workflow should show recent runs. If a workflow's header shows "This workflow has been disabled. Enable workflow", that's the culprit.

**Fix:**
1. In the Actions tab, click the workflow → "Enable workflow" button (top-right banner).
2. Manually trigger one run to reset lastCheckAt: `gh workflow run scraper-health-cron.yml`.
3. Refresh doctor: `curl -H "Authorization: Bearer $CRON_SECRET" https://hotelops-ai.vercel.app/api/admin/doctor | jq '.checks[] | select(.name=="scraper_health_cron")'` — should flip to ok.

**Prevention:**
- Doctor's `scraper_health_cron` check fails if lastCheckAt >25h. Railway vercel-watchdog polls doctor every 5 min, so within a few minutes of the cron going silent, you get an SMS.
- Push a small commit to main every ~55 days if this repo goes quiet for a stretch — keeps the 60-day auto-disable from tripping.

---

## Railway env var drift

**Symptom:** Vercel doctor is green but Railway scraper behavior is off. Examples: scraper heartbeat is fresh (so the process is alive), but dashboard numbers never update (scraper can't log into Choice Advantage because `CA_USERNAME` / `CA_PASSWORD` drifted); or app UI shows zero rooms on Schedule tab (`HOTELOPS_PROPERTY_ID` missing → scraper writes rows with null property_id).

**Diagnosis:**
Compare env vars across platforms:
- Vercel → Project → Settings → Environment Variables.
- Railway → hotelops-scraper → Variables.

Keys that MUST match on both:
- `SUPABASE_SERVICE_ROLE_KEY`
- `CRON_SECRET`

Keys that live ONLY on Railway (scraper-side):
- `CA_USERNAME`, `CA_PASSWORD` — Choice Advantage credentials.
- `HOTELOPS_PROPERTY_ID` — the property UUID the scraper writes to.
- `TIMEZONE` — defaults to `America/Chicago` if unset (OK to rely on default).
- `MANAGER_PHONE` — alert target. Silent no-op if missing.

Keys that live ONLY on Vercel:
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` — client bundle.
- `TWILIO_*` — all of them.
- `MANAGER_PHONE` — also set here for the scraper-health / scraper-weekly-digest endpoints.

Check Railway logs for the preflight block the scraper prints at startup. If you see `FATAL: missing/invalid required env vars`, that's your answer.

**Fix:**
1. Set the missing variable on Railway.
2. Railway auto-redeploys when a variable changes — wait ~90 sec.
3. Check Railway logs: you should see `=== HotelOps AI / Staxis CSV Runner starting ===` without any `FATAL` lines after it.

**Verify:**
```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://hotelops-ai.vercel.app/api/admin/doctor | jq '.checks[] | select(.name=="supabase_heartbeat")'
```
Heartbeat should be <10 min old. Then verify numbers are flowing: check the Schedule tab in the app.

**Prevention:** The scraper now preflights `HOTELOPS_PROPERTY_ID`, `CA_USERNAME`, `CA_PASSWORD` at startup and `process.exit(1)` if any are missing or malformed — this turns silent writes-with-nulls into visible Railway crash-loops. Daily drift check catches the cross-platform Supabase key + CRON_SECRET class of drift.

---

## Supabase Realtime / platform outage

**Symptom:** App loads but dashboard data never refreshes live — Maria has to F5 to see updates. Connecting the dots: the Schedule tab's auto-updating card counts stop changing even when a housekeeper marks a room. Browser DevTools Network tab shows failed WebSocket connections to `<project>.supabase.co/realtime/v1/websocket`.

**Diagnosis:**
1. Check https://status.supabase.com/ — is Realtime listed as degraded?
2. Confirm it's not a client-side issue: have Reeyen open the app on a different network (phone hotspot).
3. The doctor's `supabase_admin_auth` check will stay green during a Realtime-only outage (REST API is a separate service), so doctor alone isn't enough here.

**Fix:** This is almost always a Supabase-platform issue, not ours. Wait for Supabase to resolve. Meanwhile, the app still works in "polling" mode — it's just not live.

**Verify:** Open DevTools → Network → WS. Reconnect attempts should succeed once Supabase recovers. Real-time counters in the app start updating again.

**Prevention:** This is the hardest class to catch proactively. Options if it starts happening repeatedly:
- Subscribe to Supabase status page email alerts.
- Consider adding client-side fallback polling (every 30s) when the WebSocket has been disconnected for >60s.
- Add a Realtime probe to doctor (open a test subscription, confirm CHANNEL_OK within 5s). Not yet implemented — the WebSocket API requires more scaffolding than the other checks.

---

## Can't log in after seed (GoTrue NULL token bug)

### Symptom
- Sign-in form at `/signin` accepts username + password, spinner runs, returns "Invalid username or password" — **even when the password is objectively correct**.
- Directly hitting `POST /auth/v1/token?grant_type=password` on the Supabase project returns `500 "Database error querying schema"`.
- `GET /auth/v1/admin/users` and `GET /auth/v1/admin/users/<uid>` both return `500 "Database error loading user"` or `"Database error finding users"`.
- Supabase Dashboard → Authentication → Users still lists the user fine (dashboard uses a different path), so it *looks* like the user exists but just has the wrong password. Misleading.
- Auth logs (Supabase Dashboard → Logs → Auth) show: `"error finding user: sql: Scan error on column index 3, name \"confirmation_token\": converting NULL to string is unsupported"`.

### Diagnosis
Check if any token columns on the user row are NULL:

```sql
select id, email,
       (confirmation_token         is null) as ct_null,
       (email_change               is null) as ec_null,
       (email_change_token_new     is null) as ecn_null,
       (email_change_token_current is null) as ecc_null,
       (recovery_token             is null) as rt_null,
       (phone_change               is null) as pc_null,
       (phone_change_token         is null) as pct_null,
       (reauthentication_token     is null) as rat_null
  from auth.users;
```

If ANY `*_null` column is `true`, you're hitting this bug.

Root cause: `supa.auth.admin.createUser(...)` (which `scripts/seed-supabase.js` uses) creates rows with NULL in these columns. GoTrue's Go code scans them into `string` (not `sql.NullString`), so every subsequent auth request 500s. The normal `auth.signUp(...)` flow defaults them to `''` and avoids this, but the admin path is what we use for seeded users.

### Fix

**Apply migration `0005_normalize_auth_tokens.sql`** (already in `supabase/migrations/`). It does two things:
1. UPDATEs all existing rows with `COALESCE(col, '')`.
2. Installs a `BEFORE INSERT OR UPDATE` trigger on `auth.users` that rewrites NULL → `''` on write, so new users created via any path (including `supa.auth.admin.createUser`) don't hit this again.

To apply to a live project via the Supabase Dashboard → SQL Editor, paste the contents of `supabase/migrations/0005_normalize_auth_tokens.sql` and run.

If the user's password was never successfully set (e.g. seed ran before you had `STAXIS_ADMIN_PASSWORD` in `.env.local`, so the password hash is bogus), reset it via SQL using pgcrypto:

```sql
update auth.users
  set encrypted_password = crypt('<new-password-here>', gen_salt('bf', 10)),
      updated_at = now()
where email = 'reeyen@staxis.local';
```

`crypt(… , gen_salt('bf', 10))` is the exact hash format GoTrue uses internally, so the resulting hash is interchangeable.

### Verify
After applying 0005:

```sql
-- No NULL token columns anywhere:
select count(*) filter (where confirmation_token is null) +
       count(*) filter (where email_change is null) +
       count(*) filter (where recovery_token is null) as total_nulls
  from auth.users;
-- Expected: 0

-- Trigger exists:
select tgname from pg_trigger
  where tgrelid = 'auth.users'::regclass
    and tgname = 'staxis_normalize_auth_tokens_trg';
-- Expected: one row.
```

Then test login end-to-end:

```javascript
// Paste in browser console on https://hotelops-ai.vercel.app (or Supabase dashboard):
await fetch('https://<proj>.supabase.co/auth/v1/token?grant_type=password', {
  method: 'POST',
  headers: { apikey: '<anon-or-service-role>', 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'reeyen@staxis.local', password: '<new-pw>' }),
}).then(r => r.json());
// Expected: object with access_token, refresh_token, user. NOT a 500.
```

And the actual UI: https://hotelops-ai.vercel.app/signin — should redirect to `/property-selector` on success.

### Prevention
- **Migration 0005 trigger** — catches any future row that would have been inserted with NULL tokens. Defense-in-depth even if Supabase patches GoTrue upstream.
- **Comment in seed-supabase.js** — points future readers at the migration so they don't re-discover this by hand.
- **This runbook** — when someone hits "can't log in" on a fresh install, they find this in 30 seconds instead of an hour.
- Not yet implemented: a doctor check that pokes `/auth/v1/token` with a known bogus password and expects a clean 400 (not 500). Would catch this bug in CI immediately. Worth adding if this class of bug bites again.

### Timeline (2026-04-23 incident)
- ~00:08 UTC — Reeyen runs seed, admin user created with NULL tokens. Login untested.
- ~05:10 UTC — Reeyen first tries to log in. Auth fails silently with "Invalid username or password" regardless of password. No email (synthetic `@staxis.local`) so magic-link reset doesn't work either.
- ~05:25 UTC — Discovered the 500s via direct admin API calls, which led to reading Auth Logs and seeing the NULL scan error.
- ~05:30 UTC — Migration 0005 written + applied. Login verified working same-session.
- Total: ~20 min diagnosis, <10 min to fix. Next time: 0 min, because this runbook exists.

---

## "Invalid username or password" even with the correct password

### Symptom
- Sign-in form at `/signin` rejects every login attempt with "Invalid username or password" — even brand-new passwords you just set via admin API.
- Direct API calls with the service_role key work fine (`/auth/v1/token` returns 200), so the user + password are valid.
- App's own `supabase.auth.signInWithPassword(...)` call from the browser console returns `{ error: "Invalid API key", status: 401 }`.

### Diagnosis
In the signed-in page's DevTools console:
```javascript
const supa = window.__supabaseBrowser;
const key = supa.supabaseKey;
console.log({ len: key.length, dots: key.split('.').length });
// Expected: len ~208 (typical Supabase anon key), dots=3.
// If len < 200 or dots !== 3, the anon key is corrupt.
```

Or decode the bundled anon key's JWT payload:
```javascript
const parts = supa.supabaseKey.split('.');
let b = parts[1].replace(/-/g, '+').replace(/_/g, '/');
while (b.length % 4) b += '=';
JSON.parse(atob(b));
// Expected: { iss: "supabase", ref: "<project-ref>", role: "anon", iat, exp }
// If base64-decode throws, the payload is truncated or corrupt.
```

### Root cause
`NEXT_PUBLIC_SUPABASE_ANON_KEY` in **Vercel** env vars was pasted incorrectly — a few characters dropped in the middle of the JWT payload. Every browser request sends the corrupt key, Supabase responds 401 "Invalid API key" before checking credentials, the app surfaces that as a generic "Invalid username or password" error.

### Fix
1. Pull the correct anon key:
   - Supabase Dashboard → Project Settings → API → Project API Keys → `anon / public`.
   - Copy the **full** key (they're ~200+ chars; scroll horizontally).
2. Vercel Dashboard → `staxis` → Settings → Environment Variables → `NEXT_PUBLIC_SUPABASE_ANON_KEY` → Edit → paste → Save.
3. Redeploy (the prompt Vercel shows after saving).
4. Re-verify with the DevTools snippet above.

### Prevention
- **Doctor check `anon_key_shape`** now parses `NEXT_PUBLIC_SUPABASE_ANON_KEY` from Vercel at every deploy and fails red if it's not a valid JWT with `role:"anon"`. Post-deploy smoke test catches this within 3 minutes of the bad deploy.
- **Next time** a "my password doesn't work" report comes in, run doctor first. If `anon_key_shape` is red, this is the issue — takes 2 minutes to fix.

---

## "No properties found" right after signing in

### Symptom
- User signs in successfully (lands on `/property-selector`, sees their username).
- Property list is empty: "No properties found / Your account doesn't have access to any properties yet."
- But there IS data — the service role sees it, SQL editor sees it, my `accounts` row exists and has the right `property_access` UUIDs.

### Diagnosis
In DevTools console on the property-selector page:
```javascript
const supa = window.__supabaseBrowser;
const { data: { session } } = await supa.auth.getSession();
console.log('token len:', session?.access_token?.length);
// Expected: ~800+ chars. If 0 or undefined, the session was lost during
// page navigation — the classic @supabase/ssr-without-middleware symptom.
```

### Root cause (historical, fixed 2026-04-23)
`src/lib/supabase.ts` was using `createBrowserClient` from `@supabase/ssr`. That function defaults to a cookie-based storage backend designed for Next.js middleware-driven SSR. Without the required middleware setup, it silently loses the access_token on client-side page navigation — `getSession()` returns a partial session (user populated, token empty) and every subsequent RLS query returns `[]`.

### Fix
Use `createClient` from `@supabase/supabase-js` directly with explicit localStorage persistence (current state of `src/lib/supabase.ts` as of commit `1c41fee`). If someone ever reverts to `createBrowserClient` without also adding Next.js auth middleware, this breaks again.

### Verify
```javascript
// After sign-in, check that localStorage has the session:
Object.keys(localStorage).filter(k => k.includes('staxis-auth') || k.includes('sb-'));
// Expected: at least one key with a long value. If empty, persistence is broken.
```

### Prevention
- **Stale error-matching in PropertyContext** used Firestore error strings (`'permission'`, `'unauthenticated'`) to trigger a retry. Those strings never match Supabase responses, so transient RLS errors weren't retried. Fixed in commit `1c41fee` to also check `PGRST301`, `PGRST116`, `42501`, `policy`, `jwt` substrings.
- Doctor doesn't currently check client-side auth persistence (it's a client-only failure mode). Possible future addition: a tiny checked-in Playwright smoke test in CI that logs in, lands on /property-selector, asserts the property list is non-empty.

---

## Choice Advantage forced a SkyTouch migration consent screen

### Symptom
- Scraper dashboard pulls all return `session_expired` even after a fresh login.
- Dashboard shows "Something unexpected happened pulling PMS data".
- Railway logs show `After settle — now at: https://www.choiceadvantage.com/choicehotels/Login.do` immediately after a successful login.
- CSV pulls fail with `Could not click Housekeeping Check-off List`.

### Diagnosis
After login, CA parks the user on `/Login.do` with three visible links:
- `Logout` (`#logoutLink`)
- `training bulletin` pointing at `skytouch.my.salesforce.com`
- `Continue` (`#migrationSubmit`)

Without clicking Continue, every protected URL (View*.init, ReportViewStart.init) bounces back to `/Login.do`. The scraper had no concept of this intermediate step, so login() returned "ok" while the page was actually still gated.

The CSV pull's selector miss is a downstream effect — the link inventory dump (`csv-link-dump.html`) shows only Logout / training bulletin / Continue, no Housekeeping link.

### Fix
- Already shipped in `ce82c6d`: login() detects `#migrationSubmit` after the post-login settle and clicks it (with the same plain → force → JS-direct escalation as clickLoginButton).
- If CA changes the migration UX again, look for the link inventory dump in `scraper/csv-link-dump.html` to see what selectors are actually on the page.

### Verify
Tail Railway logs for `CA migration consent screen detected — clicking #migrationSubmit`.

### Prevention
- New code path is gated on element presence (`#migrationSubmit` exists), not URL. When CA eventually retires the migration screen the code becomes a no-op without a redeploy.
- The `selector-helpers.js` `dumpFile` pattern is now reused everywhere — every selector miss writes a debuggable HTML inventory. If CA throws another consent screen, we'll see what links it has within minutes.

---

## Playwright "execution context was destroyed, most likely because of a navigation"

### Symptom
- Scraper logs show `page.evaluate: Execution context was destroyed, most likely because of a navigation`.
- The same error fires across login + dashboard + OOO + CSV pulls simultaneously.
- Process is alive (heartbeat fresh) but every tick fails with the same error.

### Diagnosis
CA does chained JS-based redirects after page load (e.g. `Login.init` → `Welcome.init` → `user_authenticated.jsp`). `page.goto()` with `waitUntil:'domcontentloaded'` returns once the initial DOM is loaded, BEFORE the JS redirects fire. The next `page.evaluate()` then races against an in-flight navigation, the Playwright execution context dies mid-call, and every dependent pull (login, dashboard, OOO, CSV) fails identically because they all use page.evaluate against the same shared page object.

### Fix
- All page.goto calls use `goWithSettle` (scraper/page-helpers.js) which adds `waitForLoadState('load')` + `waitForLoadState('networkidle')` so chained redirects finish before we touch the DOM.
- All page.evaluate calls use `safeEval` which retries up to 3 times on the specific "Execution context was destroyed" error, calling settlePage between attempts.
- If you see this error after the fixes are in place, check whether a new code path bypasses `goWithSettle` or `safeEval`. There should be NO raw `page.goto` or `page.evaluate` calls in the scraper — every navigation must go through goWithSettle and every evaluate must go through safeEval.

### Verify
After deploy, tail Railway logs for `Login page URL:` followed (within a few seconds) by `Filled username` — no execution-context errors in between.

### Prevention
- selector-helpers.js + page-helpers.js consolidate the navigation/evaluate patterns so future code can't easily re-introduce the bug.

---

## "Alert would have fired but MANAGER_PHONE/OPS_ALERT_PHONE is not set"

### Symptom
- Scraper or watchdog detects a real outage, but no SMS reaches your phone.
- Railway logs show `ALERT would have fired but MANAGER_PHONE/OPS_ALERT_PHONE is not set`.
- OR Vercel function logs show `[scraper-health] MANAGER_PHONE env var not set — alert would fire`.
- `/api/admin/doctor` returns `watchdog_alert_path` with status `fail` and details pointing to the missing var.

### Diagnosis
The alerting infrastructure runs on TWO platforms:
- **Vercel cron** (`/api/cron/scraper-health`) reads scraper_status, decides if the scraper is dead, sends SMS via Twilio.
- **Railway watchdog** (`scraper/vercel-watchdog.js`) pings Vercel's doctor every 5 min, sends SMS if Vercel itself is down.

Each platform sends SMS independently and reads `MANAGER_PHONE` from its OWN process.env. Setting it on Vercel only doesn't help the Railway watchdog; setting it on Railway only doesn't help the Vercel cron. When unset, the SMS path no-ops with a `console.warn` and writes `alertSuppressedReason` to scraper_status. Doctor's `watchdog_alert_path` check reads that marker and surfaces it as a hard failure — it can't read Railway's `process.env` directly but it can read shared Postgres.

### Fix
1. Set `MANAGER_PHONE=+1XXXXXXXXXX` (E.164 format) on **both** Vercel and Railway:
   - Vercel: Project Settings → Environment Variables → add → redeploy
   - Railway: hotelops-scraper → Variables → add → auto-redeploys
2. Verify via doctor:
```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://hotelops-ai.vercel.app/api/admin/doctor | jq '.checks[] | select(.name == "watchdog_alert_path")'
```
Expected: `status: ok`.

### Verify
Force an alert manually (e.g. take Vercel down for 10 min, or set `CRON_SECRET` to gibberish on Railway temporarily). You should get an SMS within 15 min.

### Prevention
- Doctor's `watchdog_alert_path` check now hard-fails when either platform's alerter says "tried, couldn't deliver".
- The post-deploy smoke-test workflow runs the doctor on every push to main and emails Reeyen if any check is failing.

---

## Env var configuration matrix

The scraper, app, and crons run on three platforms. Every env var below is required on at least one of them; some are required on multiple. Drift between platforms has caused multiple incidents (Apr 21 Firebase auth, Apr 27 silent SMS).

| Env var                       | Vercel | Railway | GitHub Actions | Notes |
|-------------------------------|:------:|:-------:|:--------------:|-------|
| `CRON_SECRET`                 | ✅     | ✅      | ✅             | All three must match. Doctor's `cron_secret_shape` checks Vercel; rotation playbook is in this doc. |
| `MANAGER_PHONE`               | ✅     | ✅      |                | E.164 format. Both platforms required — Vercel cron AND Railway watchdog need to send SMS. Doctor's `watchdog_alert_path` reads scraper_status to verify Railway has it. |
| `OPS_ALERT_PHONE`             | (alt)  | (alt)   |                | Legacy alias; either name works. |
| `NEXT_PUBLIC_SUPABASE_URL`    | ✅     | ✅      |                | Same value on both. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✅   |         |                | Browser/anon path. |
| `SUPABASE_SERVICE_ROLE_KEY`   | ✅     | ✅      |                | Same value on both. Rotation = update both, then verify via doctor. |
| `TWILIO_ACCOUNT_SID`          | ✅     | ✅      |                | Both platforms send SMS. |
| `TWILIO_AUTH_TOKEN`           | ✅     | ✅      |                | Same. |
| `TWILIO_FROM_NUMBER`          | ✅     | ✅      |                | E.164. Alt name `TWILIO_PHONE_NUMBER`. |
| `CA_USERNAME`                 |        | ✅      |                | Choice Advantage login. Railway-only. |
| `CA_PASSWORD`                 |        | ✅      |                | Same. |
| `HOTELOPS_PROPERTY_ID`        |        | ✅      |                | UUID of the property this scraper deploy belongs to. |
| `TIMEZONE`                    |        | ✅      |                | IANA zone, defaults to `America/Chicago`. |
| `TICK_MINUTES`                |        | ✅      |                | Defaults to 5. |
| `SCRAPER_INSTANCE_ID`         |        | ✅      |                | Identifies a Railway scraper service in a multi-instance fleet. Defaults to `default`. See "Spinning up a new scraper instance" below. |
| `ML_SERVICE_URL`              | ✅     |         |                | Single-shard ML service URL. Used by cron routes when `ML_SERVICE_URLS` is unset. |
| `ML_SERVICE_URLS`             | (alt)  |         |                | Comma-separated URLs of all ML shards. When set, cron routes hash property UUIDs to pick a shard. See "Spinning up a new ML training shard" below. |
| `ML_SERVICE_SECRET`           | ✅     |         |                | Bearer token Vercel sends to the ML service(s). Must match `ML_SERVICE_SECRET` on every Railway ML deploy. |

When adding a new env var:
1. Add to `REQUIRED_ENV_VARS` in `src/app/api/admin/doctor/route.ts` if it's needed on Vercel.
2. Add to scraper preflight (`scraper/scraper.js` `preflightFailures`) if it's needed on Railway.
3. Update this table.
4. Update `.env.local.example` if it's used in local dev.

---

## Spinning up a new ML training shard (Tier 3 fleet scale-out)

**When you'd run this:** the Railway ML service is OOM-killing or training crons are running past their 60s/90s Vercel timeout. At ~50 hotels the existing concurrency cap (3–5) plus per-call latency (~10s XGBoost fit) starts squeezing the budget — a second shard halves the per-shard load.

**Architecture:** properties are partitioned by UUID hash modulo N shards. `src/lib/ml-routing.ts` is the source of truth for the partition function — every cron and admin route routes through `resolveMlShardUrl(propertyId)`. Single-shard deploys (`ML_SERVICE_URL` only) behave exactly like before this scaffolding landed.

**Steps:**

1. **Deploy a second Railway ML service.** Easiest: fork the existing service, give it a distinct name (e.g. `staxis-ml-shard-1`). Copy ALL env vars from the existing one (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY if used, ML_SERVICE_SECRET — must match the value Vercel sends, CRON_SECRET, SENTRY_DSN). The two services share the same Supabase DB so they coordinate via model_runs / predictions rows — no separate state.

2. **Switch the routing env var on Vercel.** In Vercel project Settings → Environment Variables:
   - Add `ML_SERVICE_URLS` with the comma-separated URLs of all shards, primary first:
     ```
     ML_SERVICE_URLS=https://staxis-ml.up.railway.app,https://staxis-ml-shard-1.up.railway.app
     ```
   - Leave `ML_SERVICE_URL` set to the primary as a fallback (defense in depth — if `ML_SERVICE_URLS` ever gets cleared, the routing helper falls back to the single URL).
   - Redeploy Vercel (a no-op redeploy is fine — only env vars need to reload).

3. **Verify the partition is balanced.** After the next ML training cron tick:
   - In Railway logs for shard 0 and shard 1, count the per-property training entries. With UUIDs being random, expect ~50/50 split for the active fleet.
   - The `/api/admin/doctor` endpoint reports model_runs counts — confirm both shards' training runs are landing in Supabase.

4. **Roll back.** Remove `ML_SERVICE_URLS` from Vercel env (or empty its value) and redeploy. The routing helper falls back to `ML_SERVICE_URL`, and shard 0 absorbs all the traffic again. The second Railway service can be paused or deleted; data stays consistent because everything writes to the shared DB.

**Pitfalls:**
- **Don't change the partition function** (`src/lib/ml-routing.ts` `stableHashUuid`). A property's shard assignment is implicitly stable; if you alter the hash, every property reshuffles mid-cron and an in-flight training run lands on a different shard. Safe long-term (idempotent writes) but messy for one tick.
- **Cohort prior aggregator** (`/api/cron/ml-aggregate-priors`) always runs on `getPrimaryMlShardUrl()` — the first URL in `ML_SERVICE_URLS`. It reads from every property regardless of shard (the source data is in the shared DB), so any shard works; we pin to the first for capacity-planning clarity.
- **Cron timeouts**. Per-cron `maxDuration` is set in each route file (60s / 90s). Even with N shards in parallel, a single cron still has to finish within its budget — sharding helps because each shard's parallel pool covers fewer properties. If one cron still times out, raise its `maxDuration` (Vercel allows up to 300s on Pro).

---

## Spinning up a new scraper instance (Tier 3 fleet scale-out)

**When you'd run this:** the current Railway scraper is at capacity (CSV pulls running slow because too many hotels share one Playwright instance), OR you want geo-distribution (one scraper in us-east, one in us-west), OR you want a "canary" instance for testing a new PMS recipe without risking the main fleet.

**Symptom that says you need this:** `/api/admin/scraper-instances` shows `healthy: true` but `property_count` ≥ ~20 on one instance, AND `plan_snapshots.fetched_at` lags consistently > 8 min behind for some hotels.

**Architecture (TL;DR):**
- `scraper_credentials.scraper_instance` (text, default `'default'`) tags each hotel with which Railway service should poll it.
- Each Railway scraper deploy reads `SCRAPER_INSTANCE_ID` env var and filters to its own slice.
- `properties-loader.js` enforces the filter; `scraper.js` startup refuses to boot if 0 or >1 properties match.

**Steps:**

1. **Pick an instance name.** Free-form text, regex `[A-Za-z0-9._-]{1,64}`. Conventions: `alpha`, `us-east-1`, `canary`. Avoid spaces and special chars (Railway service names + log filters break on them).

2. **Reassign hotels to the new instance.** Use the admin API. Two auth modes:
   - **Script-driven (CRON_SECRET):** the canonical ops path. Works from any terminal.
     ```bash
     curl -X POST \
       -H "Authorization: Bearer $CRON_SECRET" \
       -H "Content-Type: application/json" \
       -d '{"property_id":"<uuid>","scraper_instance":"alpha"}' \
       https://getstaxis.com/api/admin/scraper-assign
     ```
   - **Browser-driven:** sign in as an admin user; the admin UI sends the Supabase session token automatically.

   Either mode lands as a `scraper.reassign` entry in `admin_audit_log` with `actor_kind` (`session` or `cron`).

3. **Create the new Railway service.** Duplicate the existing scraper service in Railway:
   - Copy ALL env vars from the existing service (CA_USERNAME, CA_PASSWORD, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TWILIO_*, CRON_SECRET, MANAGER_PHONE).
   - Set `SCRAPER_INSTANCE_ID=alpha` (your new instance name).
   - Set `HOTELOPS_PROPERTY_ID` to the UUID of the hotel you reassigned (today scraper.js still requires this to match the single-property row — Tier 1 carryover, will go away when per-tick multi-property iteration lands).
   - Set `CA_USERNAME` / `CA_PASSWORD` to that hotel's PMS creds.
   - Deploy from the same `main` branch.

4. **Verify the new instance is alive.**
   - In Railway logs, look for `Instance: alpha` near the top of boot output.
   - After 1 tick (~5 min), hit `/api/admin/scraper-instances` and confirm:
     - `instances[?(@.scraper_instance == 'alpha')].healthy === true`
     - The reassigned hotel appears under instance `alpha`, not `default`.

5. **Reverse if needed.** Reassign back to `default` via the same endpoint with `{"scraper_instance":"default"}`. The old service picks it up within 60s (cache TTL).

**Pitfalls:**
- Two instances both polling the same hotel = double-writes. Prevented at the schema level (`scraper_credentials` PK is `property_id`, so a hotel can only be tagged with one instance value). Don't ALTER that.
- "I deployed alpha but assignments didn't move" → properties-loader caches for 60s. Wait one minute, then hit `/api/admin/scraper-instances` again.
- An instance with 0 properties assigned will crash-loop at startup (intended — fail-loud over silent idle). Either assign at least one hotel to it BEFORE deploying, or tear down the service.
- **Reassignment overlap window (up to 60s):** when you move hotel X from instance `default` to instance `alpha`, both Railway services have the property in their local cache for up to 60 seconds (`CACHE_TTL_MS` in `scraper/properties-loader.js`). During that window BOTH services may run one CSV pull for X. Most write paths are idempotent upserts (`plan_snapshots` keyed by property+date, `dashboard_by_date` keyed by property+date+hour) so this is harmless. The one shared resource is the Playwright session state in `scraper_session` — two concurrent logins to Choice Advantage with the same credentials may invalidate each other's session cookies, forcing both instances to re-login on the next tick. Annoying but self-healing. If you need ZERO overlap (e.g. during a credential rotation), schedule reassignments during a 1-minute scraper maintenance pause: pause the source instance (Railway → service → suspend), wait 60s for caches to clear, reassign, resume.
- **Bad scraper_instance values are now DB-rejected** (migration 0073, May 2026). The column has a CHECK constraint enforcing `^[A-Za-z0-9._-]{1,64}$`. A manual `psql` INSERT with `"alpha shard"` (space) or a newline-bearing value will fail at write time. If a row sneaks through (e.g. you imported from a different DB), the loader will still see it and try to filter — but no Railway `SCRAPER_INSTANCE_ID` env var can contain those characters, so the hotel is effectively orphaned. Fix at the source.

---

## Fleet-CUA migration: canary + cutover procedure

Migrating Mario's per-hotel data pulls from the legacy Railway scraper to the
Fly.io CUA worker fleet. The branch `fleet-cua-everything` holds the code;
production main still runs the Railway scraper for Mario.

### Phase 1 status (what's already shipped and dormant)

- Migration `0042_pull_jobs_queue.sql` — applied to production. Adds the
  `pull_jobs` table + `staxis_claim_next_pull_job()`, `staxis_reap_stale_pull_jobs()`,
  `staxis_enqueue_property_pull()`, `staxis_purge_old_pull_jobs()` functions.
  Nothing reads or writes this table yet — adding it was safe.
- `/api/cron/enqueue-property-pulls` route — committed on `fleet-cua-everything`.
  Lists every connected property and idempotently enqueues a pull_job per one.
  Vercel deploys this when the branch is merged. Until then, the route doesn't
  exist on prod.
- `cua-service/src/pull-job-runner.ts` + `pull-data-saver.ts` — committed on
  the branch. The Fly.io CUA worker will poll pull_jobs and run them after
  the branch is deployed to Fly.
- `.github/workflows/pull-jobs-cron.yml` — `workflow_dispatch` only; no
  schedule. So merging to main does NOT start producing pulls.

### Step 1: deploy the branch's CUA service to Fly (canary mode)

`fly deploy` from `cua-service/` on the branch:

```bash
cd cua-service
fly deploy --remote-only
```

This deploys whatever the local working tree is. After deploy, the worker is
running the new code with both `claimNextJob()` (onboarding) and
`claimNextPullJob()` (pulls) — but no pull_jobs are enqueued yet, so behavior
is unchanged from operations' perspective.

### Step 2: insert a synthetic canary property

```sql
-- Run in Supabase SQL Editor (service-role).

with new_prop as (
  insert into public.properties (
    name,
    owner_id,
    pms_type,
    pms_url,
    pms_connected,
    total_rooms,
    room_inventory
  )
  values (
    'CANARY — fleet-cua test',
    (select owner_id from public.properties where name='Comfort Suites Beaumont' limit 1),
    'choice_advantage',
    'https://www.choiceadvantage.com/',
    true,
    0,
    '{}'::text[]
  )
  returning id
),
new_creds as (
  insert into public.scraper_credentials (
    property_id,
    pms_type,
    ca_login_url,
    ca_username,
    ca_password,
    is_active
  )
  select
    np.id,
    'choice_advantage',
    -- Same credentials as Mario's property — the canary just exercises
    -- the pull → save path against the real PMS without writing into
    -- Mario's rooms/staff (those tables are empty for this canary).
    (select ca_login_url from public.scraper_credentials sc
       join public.properties p on p.id = sc.property_id
      where p.name = 'Comfort Suites Beaumont' limit 1),
    (select ca_username   from public.scraper_credentials sc
       join public.properties p on p.id = sc.property_id
      where p.name = 'Comfort Suites Beaumont' limit 1),
    (select ca_password   from public.scraper_credentials sc
       join public.properties p on p.id = sc.property_id
      where p.name = 'Comfort Suites Beaumont' limit 1),
    true
  from new_prop np
  returning property_id
)
select id from new_prop;
-- Note the returned UUID for the next step.
```

### Step 3: enqueue a single pull_job for the canary

```sql
select public.staxis_enqueue_property_pull(
  '<CANARY_PROPERTY_ID>'::uuid,
  'choice_advantage'
);
```

Within ~5 seconds the Fly CUA worker should claim it (`status='running'`).
Within ~90 seconds it should reach `status='complete'` with a `result` jsonb.

### Step 4: verify the data landed

```sql
-- The pull_job result.
select id, status, result, error, error_detail, completed_at
  from public.pull_jobs
 where property_id = '<CANARY_PROPERTY_ID>'
 order by created_at desc limit 1;

-- The dashboard_by_date row that should have been written.
select * from public.dashboard_by_date
 where property_id = '<CANARY_PROPERTY_ID>'
 order by date desc limit 1;

-- The pull_metrics row.
select * from public.pull_metrics
 where property_id = '<CANARY_PROPERTY_ID>'
 order by created_at desc limit 1;
```

Expected: `result` has `in_house`, `arrivals`, `departures`, `room_status_updates`
matching Mario's actual hotel right now (since the canary uses Mario's
credentials). dashboard_by_date row exists with sensible numbers.

### Step 5: enable the cron

Once the canary passes 24 hours of every-15-min pulls without errors, edit
`.github/workflows/pull-jobs-cron.yml` and add a `schedule:` block:

```yaml
on:
  schedule:
    - cron: "*/15 * * * *"
  workflow_dispatch:
```

Push to `main`. Pulls now run for every connected property, including Mario.

### Step 6: cutover Mario from Railway to CUA

Both pipelines now write data. To verify they agree, query:

```sql
select
  (select pulled_at from public.scraper_status where key='dashboard') as railway_pulled_at,
  (select pulled_at from public.dashboard_by_date
    where property_id = (select id from public.properties where name='Comfort Suites Beaumont')
    order by date desc limit 1) as cua_pulled_at;
```

Both timestamps should be within ~15 min of each other. The numbers should
match within ±1 for clock drift.

When confident, retire the Railway scraper:
1. Stop the `hotelops-scraper` service on Railway (don't delete — keep for
   rollback).
2. Update `src/lib/db/dashboard.ts:subscribeToDashboardNumbers` to read from
   `dashboard_by_date` (today's row) instead of `scraper_status['dashboard']`.
   Push, deploy, verify the live dashboard updates.
3. Delete the canary property + scraper_credentials row.
4. Merge `fleet-cua-everything` to `main` if it isn't already.

### Rollback if canary fails

```sql
-- Pause the cron — edit pull-jobs-cron.yml to remove the schedule, push.
-- Or just disable the workflow in GitHub Actions UI.

-- Drain the pull_jobs queue so workers stop trying.
update public.pull_jobs set status='failed', error='manual rollback'
 where status in ('queued','running');

-- Delete the canary property to remove the test setup.
delete from public.properties where name = 'CANARY — fleet-cua test';
```

Mario is unaffected throughout — the Railway scraper keeps running until
Step 6 retires it.

---

## Meta: how to add a new failure mode to this doc

Every time something breaks and takes more than 30 min to fix, come back and add a section here with Symptom / Diagnosis / Fix / Verify / Prevention. This file only pays for itself if we update it.

The Prevention section is the most important — every new runbook entry should also add (or link to) a failsafe that automatically catches this failure type the next time.
