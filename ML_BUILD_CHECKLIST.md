# ML Build — Post-Deploy Checklist

Built tonight (2026-04-30). The whole ML system is committed, pushed, and Vercel-deployed. **Three setup steps remain that require your hands** — none of them more than 5 minutes.

Once these are done, the system will start working automatically: it'll attempt training every Sunday morning, inference every morning at 5:30 AM CT, and the `/admin/ml` dashboard will populate as data flows in.

## What's already done

- ✅ Migrations 0021 + 0022 written to `supabase/migrations/` (NOT YET APPLIED — see step 1)
- ✅ Python ML service in `ml-service/` (NOT YET DEPLOYED — see step 2)
- ✅ Vercel cron route handlers at `/api/cron/ml-train-demand`, `/api/cron/ml-train-supply`, `/api/cron/ml-run-inference`
- ✅ GitHub Actions workflow `.github/workflows/ml-cron.yml` (auto-runs the crons on schedule)
- ✅ `/admin/ml` dashboard wired up, owner-gated to your account
- ✅ Schedule tab integration: recommended-headcount pill, override modal, end-of-shift attendance checkboxes (rendered only when ML predictions are flowing AND `ml_feature_flags.predictions_enabled=true`)
- ✅ Override ingestion endpoint at `/api/ml/override`
- ✅ Event-write feature capture (Start tap snapshots occupancy, Done tap derives 10 ML features)
- ✅ All TypeScript clean, all new tests passing (122 of the 123, the 1 failure is pre-existing `sms-jobs.test.ts` unrelated to this work)

## Step 1 — Apply migrations 0021 + 0022 to Supabase (2 min)

The two SQL files exist in `supabase/migrations/` but Supabase doesn't auto-apply them. You apply them via the dashboard.

1. Open [Supabase SQL Editor](https://supabase.com/dashboard/project/xjoyasymmdejpmnzbjqu/sql/new) (already in your bookmarks).
2. Open `supabase/migrations/0021_ml_infrastructure.sql` in your editor.
3. Copy the entire file contents → paste into the Supabase SQL editor → click **Run** (or Cmd+Enter).
4. Wait for "Success. No rows returned." (~5 seconds).
5. Repeat for `supabase/migrations/0022_cleaning_minutes_view.sql`.

Verify by running this query in the SQL editor:

```sql
select count(*) as ml_tables
from information_schema.tables
where table_schema = 'public'
  and table_name in (
    'demand_predictions','supply_predictions','optimizer_results',
    'model_runs','prediction_log','prediction_disagreement',
    'prediction_overrides','attendance_marks','ml_feature_flags',
    'cleaning_minutes_per_day_view'
  );
```

Expected: `10` (or close — `cleaning_minutes_per_day_view` is a view, may show or not depending on Supabase metadata behavior; check via `information_schema.views` if that one's missing).

If anything errors, the migration file is idempotent — fix the error and re-run the whole file.

## Step 2 — Deploy the Python ML service to Railway (3 min)

The Python service lives at `ml-service/` in the repo. Railway needs to know to spin up a new service for it (separate from the existing scraper service).

1. Open [Railway dashboard](https://railway.app) → log in.
2. Open the **HotelOps AI** project (or whatever you named it — same project that has the scraper).
3. Click **+ New Service** → **GitHub Repo** → select `Reeyenn/staxis`.
4. Settings:
   - **Service name**: `hotelops-ml`
   - **Root directory**: `ml-service` (CRITICAL — without this Railway tries to run the Next.js app)
   - **Build**: auto-detect (Railway sees the Dockerfile and uses it)
   - **Branch**: main
5. Add three environment variables in the new service:
   - `SUPABASE_URL` = `https://xjoyasymmdejpmnzbjqu.supabase.co`
   - `SUPABASE_SERVICE_ROLE_KEY` = (copy from your existing scraper service's env vars)
   - `ML_SERVICE_SECRET` = generate a fresh random string. Use `openssl rand -hex 32` in your terminal, or any password manager. Save it somewhere — you'll use it in step 3.
6. Click **Deploy**. First build takes ~3 minutes (Docker image, pip install xgboost which is biggish).
7. After deploy succeeds, copy the service's public URL (looks like `https://hotelops-ml-production.up.railway.app`). You'll use it in step 3.
8. Verify: `curl https://<that-url>/health` → expect `{"status": "ok", "supabase_reachable": true, ...}`.

## Step 3 — Tell Vercel where the Python service lives (1 min)

Two new env vars on Vercel:

1. Open [Vercel dashboard](https://vercel.com) → **staxis** project → **Settings** → **Environment Variables**.
2. Add:
   - `ML_SERVICE_URL` = the Railway URL from step 2 (e.g. `https://hotelops-ml-production.up.railway.app`)
   - `ML_SERVICE_SECRET` = the secret from step 2 (the openssl-generated one)
3. Both for **Production**, **Preview**, **Development**.
4. Click **Save**, then go to **Deployments** → trigger a redeploy of the latest main commit (or just push any commit, even an empty one with `git commit --allow-empty -m "trigger redeploy"`).

## Step 4 (optional but recommended) — Manually trigger the first cron runs

The crons will fire on schedule (next inference: 5:30 AM CT tomorrow), but you can sanity-check them now:

1. Open [GitHub Actions for staxis](https://github.com/Reeyenn/staxis/actions).
2. Click **ML cron** workflow → **Run workflow** dropdown → leave on `main` → **Run workflow**.
3. Pick which job in the workflow file you want; the workflow_dispatch path triggers all three concurrently.
4. Or skip the UI and call directly:
   ```bash
   curl -H "Authorization: Bearer $CRON_SECRET" \
     https://hotelops-ai.vercel.app/api/cron/ml-train-demand
   ```
5. With ~zero cleaning_events history, you'll see `status: "insufficient_data"` for the training calls — that's correct, it just writes a `model_runs` row with `is_active=false, notes='insufficient_data'`.
6. The inference call WILL still produce a prediction, because the Bayesian Phase-0 model returns informative output from the prior even with zero training data. That's the whole point of the v3 architecture.

## What happens automatically from this point

- Every time Maria taps Start/Done on a room → cleaning_events row gets written WITH the 10 ML feature columns populated. Data starts accumulating.
- Every time Maria taps the end-of-shift attendance checkboxes → `attendance_marks` row gets written. The model learns who actually showed up.
- Every Sunday 3:00 AM CT → demand model retrains (will say "insufficient_data" until ~30+ days of usage).
- Every Sunday 3:30 AM CT → supply model retrains (will say "insufficient_data" until ~500 cleaning_events have accumulated).
- Every morning 5:30 AM CT → inference fires for tomorrow. Predictions land in `demand_predictions`, `supply_predictions`, `optimizer_results`. Schedule tab will show the recommended headcount pill once predictions exist.
- When predictions and actuals diverge → entries land in `prediction_log` and `prediction_disagreement` automatically. Auto-rollback fires if the active model degrades.

## When the first real predictions show up

Realistically:

- **Day 1 (today)**: nothing visible to Maria. The system is logging features for every event but no predictions are being driven.
- **~Week 2**: ~50+ cleaning_events accumulated. Bayesian Phase-0 starts producing decent predictions seeded from the static-rules prior. Recommended-headcount pill starts appearing.
- **~Week 4-6**: ~500+ cleaning_events. Activation gates met. XGBoost-quantile models start activating. Predictions get visibly tighter.
- **~Month 3**: Layer 3 optimizer fully calibrated. Recommended headcount confidence intervals are tight enough that Maria starts trusting them as her primary signal.

## /admin/ml cockpit

Visit https://hotelops-ai.vercel.app/admin/ml after step 3.

You see:
- Big number — total cleaning_events collected (currently 0)
- Adoption per housekeeper — % of assigned rooms each HK is actually tapping Start/Done on
- Layer status panels for Demand / Supply / Optimizer
- Shadow MAE chart (will populate as data lands)
- Pipeline health dashboard
- Manual triggers (Train Now, Run Inference Now, etc.)

Your dad's J login does NOT see this page — the nav tab is hidden, and direct navigation returns "Page not found."

## What to monitor for the first week

- **Adoption rate** on the cockpit's "Adoption per HK" panel. Goal: >80% by week 4. If it's <40% by week 2, the issue is housekeeper buy-in, not the ML system.
- **Pipeline health**: every morning at 5:30 AM CT, check that the inference cron ran (last_inference timestamp should be recent).
- **Recommended-headcount pill** on the Schedule tab. Goal: starts appearing by week 2.

## Files added in this build

For future reference / code review:
- `supabase/migrations/0021_ml_infrastructure.sql` (484 lines, 9 tables + 4 views + 12 RLS policies)
- `supabase/migrations/0022_cleaning_minutes_view.sql` (training-target view)
- `ml-service/` (47 Python files, 38 unit tests, full Bayesian + XGBoost-quantile + Monte Carlo)
- `src/app/admin/ml/` (1 page + 9 components, owner-gated cockpit)
- `src/app/api/ml/override/route.ts` (override ingestion endpoint)
- `src/app/api/cron/ml-{train-demand,train-supply,run-inference}/route.ts` (cron handlers)
- `src/lib/db/ml.ts` (12 reader functions for the cockpit)
- `src/lib/db/attendance.ts` (markAttendance + getAttendanceForDate)
- `src/lib/feature-derivation.ts` (10-feature snapshot builder)
- `src/lib/ml-schedule-helpers.ts` (Schedule tab fetchers)
- `src/app/housekeeping/_components/{RecommendedHeadcountPill,OverrideHeadcountModal,AttendanceMarker,MLSupplyBadge}.tsx`
- `.github/workflows/ml-cron.yml`

Plus modifications to:
- `src/lib/db/cleaning-events.ts` (insertCleaningEvent accepts feature snapshot)
- `src/app/api/housekeeper/room-action/route.ts` (Start/Done feature capture)
- `src/lib/calculations.ts` (autoAssign uses supply predictions when available)
- `src/components/layout/Header.tsx` (ML nav tab, owner-only)

That's the build. Three steps from here to a live, self-improving ML system.

---

## Phase 3.6: Honesty surface (2026-05-22)

The May 2026 inventory ML audit added explicit-source labelling and a true gate ratio everywhere the UI reads from. The model itself didn't change — predictions and graduation logic are identical. What changed is what the UI exposes about its own confidence.

### What shipped

- **`/api/inventory/ai-status` (and `getInventoryAiStatus` mirror in `ml-inventory-cockpit.ts`):**
  - Renamed `currentMaeRatio` → `overfitRatio` (val_mae/train_mae — fit-tightness, not the activation gate).
  - New `currentMaeRatioVsMean` (val_mae/mean_observed_rate — the **real** activation gate ratio).
  - New `lastInferenceStale` (true past 26h — one missed daily cron + 2h grace; flips before doctor's 48h heartbeat threshold).
  - New `predictionsLast7Days` (cron-outage signal even when lastInferenceAt looks fresh).
  - Kept `currentMaeRatio` as a deprecated alias for one release.

- **`/api/admin/ml/inventory/cockpit-data`:** new `xgboostBlockedCount` in `AggregateStats`. Filtered to LATEST run per (property, item) so stale historical XGBoost experiments don't permanently mark items "blocked". Admin-only — NOT surfaced in GM ai-status.

- **`ml-service/src/training/inventory_rate.py`:** persists `mean_observed_rate` in `model_runs.hyperparameters` (single bit-for-bit value already computed by the trainer; no DDL, accepted by RPC `staxis_install_inventory_model_run` as JSONB pass-through).

- **`ml-service/src/training/_gates.py`** (new): pure helper `should_force_deactivate(...)` extracted from the inlined safety gates. Returns `(force, reason)` mirroring the three gates (no-validation-set / max-MAE / XGBoost-blocked). Behavior preserved bit-for-bit; tested in `tests/test_inventory_gate_helpers.py`.

- **`ml-service/src/eval/inventory_backtest.py`** (new): read-only realized-MAE backtest sourced from `prediction_log` (predicted-vs-actual pairs written by `post-count-process`). Single batched `client.client.table('model_runs').select(...).in_('id', run_ids).execute()` join — explicitly NOT a per-run-id loop. Endpoint `POST /eval/inventory-backtest`, bearer-only, admin-via-curl (no TS proxy). See RUNBOOKS "How to invoke the inventory-backtest endpoint".

- **Inventory UI (`src/app/inventory/_components/`):**
  - New `BurnSource = 'ml' | 'rule-occupancy' | 'fallback-60d' | 'no-data'` type. `DisplayItem.burnSource` and `ReorderRec.burnSource` REQUIRED — TypeScript flushes out any constructor that drops it.
  - `selectBurnRate(...)` pure helper in `lib/inventory-predictions.ts` encapsulates the classification logic.
  - `ItemRow.tsx`: `daysLeft` renders as em-dash for `fallback-60d` and `no-data` (par/60 is a fixed function of par, not a prediction).
  - `ReorderPanel.tsx`: pre-check only on `urgency==='now' && burnSource ∈ {ml, rule-occupancy}`. Onboarding banner when ALL recs are fallback (new-hotel signal).
  - `SimpleSheet.tsx`, `CountSheet.tsx`: "% off" card reads `currentMaeRatioVsMean` (the real gate ratio) instead of the misnamed `currentMaeRatio`. Shows "Populating…" during the ~7-day post-Phase-2 backfill window.

### Tests added

- `ml-service/tests/test_inventory_gate_helpers.py` (14 cases — gate priority, near-zero floor, is_currently_active short-circuit)
- `ml-service/tests/test_inventory_cold_start_no_autofill.py` (5 cases — RPC payload shape, is_active/auto_fill_enabled contract)
- `ml-service/tests/test_inventory_backtest.py` (11 cases — including anti-N+1 single-`.in_()`-call invariant, read-only invariant)
- `src/lib/__tests__/inventory-predictions.test.ts` (7 cases — fetchMlPredictedRates failure paths)
- `src/lib/__tests__/inventory-ai-status.test.ts` (13 cases — 26h staleness, gate ratio vs overfit, divide-by-zero)
- `src/lib/__tests__/inventory-burn-source.test.ts` (14 cases — all four sources, priority order, NaN/0/null handling)

### What did NOT change

- Bayesian regression, XGBoost-quantile, static baseline layers (`ml-service/src/layers/`). Shared with demand+supply; out of scope.
- Demand/supply training + inference. Out of scope.
- Activation gates, graduation thresholds, cohort prior strengths, max-MAE threshold (1.0×). Same values; the logic was just extracted to a helper.
- The `XGBOOST_INFERENCE_READY = False` flag — flipping it would activate broken XGBoost in housekeeping ML. Stays False; cliff is documented in RUNBOOKS.
- Any Supabase migrations / RLS policies. No DDL needed (mean_observed_rate goes into existing JSONB column).
