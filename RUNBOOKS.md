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
5. Verify BOTH platforms work (see Verify below).

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
1. Generate a fresh secret: `openssl rand -hex 32`
2. Vercel → Environment Variables → update `CRON_SECRET` → Redeploy
3. GitHub → repo → Settings → Secrets and variables → Actions → update `CRON_SECRET` with the SAME value
4. Re-run the latest failed workflow to confirm

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

## Meta: how to add a new failure mode to this doc

Every time something breaks and takes more than 30 min to fix, come back and add a section here with Symptom / Diagnosis / Fix / Verify / Prevention. This file only pays for itself if we update it.

The Prevention section is the most important — every new runbook entry should also add (or link to) a failsafe that automatically catches this failure type the next time.
