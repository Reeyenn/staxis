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

## Firebase service account key rotation

### Symptom
- GitHub Actions "Scraper Health Check" emails with workflow failure
- Doctor endpoint `firebase_admin_auth` check returns `fail`
- `firebase-admin.ts` throws `Firebase Admin auth failed on Vercel: 16 UNAUTHENTICATED`
- Scraper crash-loops on Railway with `Firebase auth failed at startup`

### Diagnosis
```bash
# 1. Which platform is broken?
curl -H "Authorization: Bearer $CRON_SECRET" \
  https://hotelops-ai.vercel.app/api/admin/doctor | python3 -m json.tool

# Look at firebase_admin_auth check. If it's "fail", Vercel's key is bad.
# If Vercel is fine but scraper-health shows heartbeat_dead, Railway's is bad.

# 2. Which key is currently active in GCP?
# Browse: https://console.cloud.google.com/iam-admin/serviceaccounts/details/101644913363325978984/keys?project=hotelops-ai
# Make a note of which keys exist and which are active.
```

### Fix
Full playbook lives in `Second Brain/05 Personal/[C] Recovery Codes & Credentials.md` → "How to rotate this key in the future". Short version:

1. Firebase Console → Project Settings → Service Accounts → Generate new private key → download JSON
2. Extract `private_key` from the JSON (keep literal `\n` escape sequences)
3. **Update Railway** → `hotelops-scraper` → Variables → `FIREBASE_PRIVATE_KEY`. Auto-redeploys.
4. **Update Vercel** → `staxis` → Settings → Environment Variables → `FIREBASE_ADMIN_PRIVATE_KEY`. Click Redeploy.
5. Verify BOTH platforms work (see Verify below) before deleting the old key ID from GCP IAM.

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
- **`firebase-admin.ts`** fails loudly at module load if env vars are missing, and `verifyFirebaseAuth()` throws a specific error if the key is stale.
- **`scraper.js`** does a preflight Firestore read at startup and `process.exit(1)` if it fails, so Railway crash-loops visibly instead of silently running with bad credentials.
- **Daily drift check workflow** runs every morning at 8am Central and compares Vercel auth vs Railway scraper health. Catches cross-platform rotation drift within 24h.
- **Post-deploy smoke test** runs after every push to main and calls the doctor endpoint. Catches a botched Vercel env var change within 3 minutes.

---

## Scraper dead (Railway)

### Symptom
- SMS: "Staxis scraper DOWN — no heartbeat for X min. Check Railway deployment."
- `scraper-health` endpoint returns `condition: heartbeat_dead`
- Doctor `firestore_heartbeat` check returns `fail` with "stale"
- Maria reports PMS numbers are stuck on the dashboard

### Diagnosis
```bash
# 1. Confirm the staleness duration:
curl -H "Authorization: Bearer $CRON_SECRET" \
  https://hotelops-ai.vercel.app/api/admin/doctor | python3 -m json.tool | grep -A2 heartbeat

# 2. Railway → hotelops-scraper → Deployments → click latest → Logs.
#    Look for:
#      - "Firebase auth failed at startup" → bad FIREBASE_PRIVATE_KEY, see Firebase rotation runbook
#      - "CA login failed" → bad CA_PASSWORD, rotate on Railway
#      - crash loop with memory errors → Railway resource issue
#      - no recent logs at all → service was manually stopped / deploy stuck
```

### Fix

**If Firebase auth startup error:** follow Firebase key rotation runbook above.

**If CA login failed:** Twilio/CA pw change. Update `CA_PASSWORD` on Railway → auto-redeploy.

**If service stopped/crashed with no actionable error:**
1. Railway → hotelops-scraper → Deployments
2. Click latest deployment → "Redeploy" button
3. Watch logs for `Firebase auth verified ✓` to confirm startup

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
- Pages that need Firebase Admin throw on first request
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
- If doctor returns 503 with a specific red check: follow the runbook for that check (firebase auth / env vars / etc).
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
- Firebase key rotation → see section above
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
# 4. Is Firebase up? https://status.firebase.google.com/
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

## Meta: how to add a new failure mode to this doc

Every time something breaks and takes more than 30 min to fix, come back and add a section here with Symptom / Diagnosis / Fix / Verify / Prevention. This file only pays for itself if we update it.

The Prevention section is the most important — every new runbook entry should also add (or link to) a failsafe that automatically catches this failure type the next time.
