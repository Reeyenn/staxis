# Inventory ML — improvement log (branch `chat/inventory-ml`)

Goal: make the **inventory** prediction system (per-hotel, per-item daily
consumption → days-left → reorder) accurate, robust, and production-ready for
**300 brand-new hotels**. Priorities: cold-start → accuracy → robustness →
safety. Out of scope (other chats own): CUA/PMS data plumbing, Housekeeping ML,
the broad app audit.

How accuracy is measured offline (no DB): `ml-service/scripts/inventory_offline_eval.py`
simulates hotels under a known ground-truth `usage = a + b·occupancy_pct (+noise)`,
drives the REAL trainer (`_build_training_rows` + the same Bayesian fit/split),
and reports recovered occupancy slope + validation MAE vs a constant-mean
baseline and an oracle (noise floor). Deterministic (seeded).

Test baseline: `cd ml-service && .venv/bin/python -m pytest tests/ -q` → **302 passed**
(Python 3.11; the venv MUST be 3.11+ — the code uses PEP-604 `X | None`).

---

## Research summary (what the system is + where it's wrong)

Per-(property × item) model. Training builds one row per consecutive pair of
counts: `consumption = prev + orders_received − discards − curr`, `rate =
consumption / days`; the only feature is occupancy. A conjugate Bayesian
regression is seeded from a cross-hotel **cohort prior** (so day-1 isn't blank)
and graduates to auto-fill after 3 gates. Nightly inference serves tomorrow's
rate from projected occupancy. A deep, adversarially-verified audit (10
subsystems) found 18 confirmed bugs + 5 cross-cutting interactions. The ones in
this branch's scope, ordered by impact:

- **[1] Occupancy feature is dead.** `daily_logs` has no `occupancy_pct` column
  (only a raw `occupied` count), so the trainer's occupancy is always the 50.0
  default → the model is intercept-only and cannot respond to how full the hotel
  is. Inference has the same dead read in its fallback. **Highest-impact bug.**
- **[coldstart] Cohort prior quality:** same-canonical SKUs overwrite each other
  in aggregation (dict `=` not append); priors pool hotels that turned inventory
  AI off; non-standard item names fall to a flat 0.20/room default.
- **[accuracy] Training-window contamination:** count-up windows (manager
  restocks; auto-stock-up order forces consumption≈0) and sub-day count pairs
  (floored to 0.5d → 2× rate) bias learned rates **low/erratic**.
- **[accuracy] Graduation gates:** prior-run streak divides by `training_mae`
  not `mean_observed_rate`; no time-spacing gate (rapid retrains fake 5 passes);
  `baseline_mae` compares a per-room prior against absolute units.
- **[robustness] Inference:** no finite/NaN guard before writing into NOT-NULL
  numeric columns; 0%-occupancy cohort path can emit 0.
- **[scale] Inventory crons** lack the sharding + `maxDuration=300` their
  siblings have → at 300 hotels the back of the fleet silently gets no
  predictions.
- **[glue] Days-left** shown two different ways (card vs reorder panel).

Out-of-scope but flagged for the human: the occupancy DATA must actually flow
(CUA pms_* → the table inference reads); the ML cron schedule is currently
disabled; auto-stock-up + non-atomic count-save restructure touches the live
count flow.

---

## Baseline metrics (before any change)

Offline harness, 4 scenarios, occupancy-driven ground truth:

| scenario | true_b | recovered slope | val_mae | mean-base mae | vs base |
|---|---|---|---|---|---|
| amenity-occ-driven | 0.35 | 0.063 | 3.460 | 3.460 | 0.0% |
| coffee-high-volume | 0.55 | 0.139 | 32.630 | 32.630 | −0.0% |
| towels-low-base | 0.22 | 0.097 | 10.803 | 10.803 | 0.0% |
| paper-steady | 0.10 | 0.033 | 7.531 | 7.531 | 0.0% |

`mean |slope − true_b| = 0.222`. **val_mae == constant-mean baseline → the model
adds zero value over "predict the average"** because occupancy is dead.

---

## Changelog

### [1] Dead occupancy feature → live, centered occupancy (train + serve)

**Problem:** `daily_logs` has no `occupancy_pct` column, so both the trainer
(`_avg_occupancy_in_window`) and inference (`_recent_avg_occupancy`) always
read `None` → defaulted to 50.0. The model's one feature was a constant, so it
collapsed to "predict the average" and could not respond to occupancy.

**Fix (commit pending):**
- Derive occupancy from `100·occupied/total_rooms` in the trainer
  (`_occ_pct_from_log` + `_avg_occupancy_in_window`, total_rooms threaded
  through `_build_training_rows`) and in inference (`_recent_avg_occupancy`,
  property total_rooms fetched on the fallback path).
- **Center** the occupancy feature on a shared `INVENTORY_OCC_BASELINE_PCT=60`
  (new constant in `config.py`) in both training (`X['occupancy_pct'] -= 60`)
  and serving (`_predict_bayesian_quantiles` builds `[1, occ-60]`). Raw 0-100
  occupancy is never near 0, so intercept↔slope were collinear and the slope
  was unidentifiable; centering decouples them and makes the per-room cohort
  prior seed the intercept correctly ("rate at typical occupancy").
- Aligned the cold-start cohort serve path from a hard-coded `occ/50` to
  `occ/baseline` so cold-start and fitted predictions share one occupancy
  reference.
- Half-open occupancy window `(t_prev, t_curr]` to match the consumption window
  (stops a boundary date being double-counted).

**Measured (offline harness, 4 occupancy-driven scenarios, clean data):**

| metric | before | after |
|---|---|---|
| mean val_MAE | 2.823 (== constant-mean baseline) | **1.547** |
| improvement vs "predict the average" | ~0% | **~45%** |
| mean \|recovered slope − true_b\| | 0.222 (dead) | **0.005** |
| oracle (noise floor) | — | 1.412 |

The model now tracks occupancy near-optimally on clean data. Real-data gains
are gated on (a) the count-window contamination fix (next) and (b) occupancy
DATA actually flowing — see "needs human" below.

**Tests:** +10 regression tests (`test_inventory_occupancy_feature.py`); full
suite 312 passed (was 302).

> ⚠️ **Needs human / out of scope:** the occupancy numbers only help once
> occupancy DATA reaches the tables inference reads. `plan_snapshots` (primary)
> was written by the now-removed scraper; CUA writes `pms_*`. Until that bridge
> exists, inference uses the `daily_logs.occupied` fallback (now correct) or the
> 50% neutral default. Wiring CUA→occupancy is another chat's lane.

### [5] Training-window hygiene — stop contaminated windows poisoning the fit

**Problem:** the trainer built one row per consecutive count pair, **floored
sub-day gaps to 0.5 day** (a 30-second recount → 2× rate) and **clamped
negative consumption to a fake 0-rate row**. Worse, when a manager restocks
outside the app, CountSheet auto-logs a "stock-up" order equal to the surprise
rise, forcing that window's consumption to exactly 0. The model was being fed a
flood of fake 0-rate rows → every learned rate biased LOW → reorders fire late →
**stockouts** (the worst outcome for a hotel). The synthesis called this the
single biggest fleet-wide low-bias driver.

**Fix (commit pending):**
- Skip count pairs `< 1.0 day` apart (matches `inventory_observed_rate_v`,
  migration 0096) instead of the 0.5-day floor.
- Train only on windows with **observed consumption > 0**; drop the two
  contamination classes (unexplained increase `raw < 0`; auto-stock-up /
  surprise-rise `raw == 0`). Dropping rare genuine-zero windows nudges rates
  slightly HIGH — the safe direction (reorder early, never run out).
- Mirrored both rules in the cohort-prior SQL (`inventory_priors.py`) so new
  hotels don't inherit contaminated priors.

**Measured (offline harness, CONTAMINATED data = 70% unlogged restocks + auto
stock-up). MAE is distance to the TRUE underlying rate:**

| scenario | legacy MAE→truth | fixed MAE→truth | legacy slope | fixed slope (true_b) |
|---|---|---|---|---|
| amenity | 5.79 | **0.11** | 0.04 | 0.34 (0.35) |
| coffee | 13.98 | **0.45** | −0.20 (wrong sign) | 0.58 (0.55) |
| towels | 3.08 | **0.30** | 0.08 | 0.21 (0.22) |

~95% MAE reduction on contaminated data; the legacy model even learned the
**wrong sign** for coffee. Clean-data scenarios unchanged (all-positive
windows). **Tests:** +6 (`test_inventory_window_hygiene.py`); suite 318 passed.

> ⚠️ **Follow-up migration (NOT applied):** the realized-rate view
> `inventory_observed_rate_v` (0096) still clamps these windows to 0, so the
> backtest/`prediction_log` would score against contaminated actuals. A
> CREATE-OR-REPLACE migration to match (drop `raw <= 0` windows) is staged in
> `supabase/migrations/` but left for manual apply + review (no DB writes
> autonomously).

### [3] Cohort-prior quality — every same-canonical SKU counts; AI-off excluded

**Problem (cold-start, the #1 priority):** the prior every new hotel inherits
was being corrupted two ways.
1. **Dict overwrite:** the canonical map is coarse (~20 buckets), so one hotel
   commonly has several SKUs collapse to one canonical (e.g. "Bath Towel" +
   "Pool Towel" → "towel"). The aggregator keyed by `property|canonical` with
   `=`, so only the LAST item's rate survived — silently dropping the rest and
   under-representing high-volume hotels in the network prior.
2. **AI-off contamination:** a hotel that turned inventory AI OFF still fed its
   rates into the cohort/global priors, even though the cron skips it.

**Fix (commit pending):**
- `per_property_item_rates.setdefault(key, []).append(...)` — every SKU's
  per-room rate is a legitimate cohort data point.
- Added `coalesce(p.inventory_ai_mode,'on') <> 'off'` to the contributor SQL.

**Tests:** +3 (`test_inventory_priors_aggregate.py`) — verifies two same-canonical
SKUs (0.2, 0.4) now median to 0.3 (was 0.4, last-wins), plus SQL filter
assertions. Suite 318 → **321 passed**.

### [6] Graduation-gate correctness (baseline units, streak denom, spacing)

Three fixes to the gates that decide when a model is trusted enough to auto-fill
counts (so a bad model can't reach staff, and a good one isn't blocked):

- **[8] baseline units:** the "beats the simple baseline by X%" metric compared a
  per-room prior (~0.4) against an absolute-units target (~24), so every item
  "beat baseline" by ~98% regardless of quality. Scaled the baseline by
  `total_rooms` so the comparison is apples-to-apples.
- **[9] streak denominator:** the consecutive-passes gate judged prior runs by
  `validation_mae / training_mae` — a meaningless ratio (training_mae is a
  different quantity). Now uses each prior's persisted `mean_observed_rate` (the
  real activation-gate denominator), falling back to the current mean for older
  rows.
- **[2] time-spacing distinctness:** ported the demand/supply gate so 5 rapid
  retrains on identical data (manual dispatch, onboarding, dev) can't fake "5
  weekly windows of stability" and graduate a model prematurely. Off by default
  in the pure fn; enabled by the trainer with the 24h `min_hours_between_passing_runs`.

**Tests:** +5 (in `test_inventory_streak_behavior.py`) distinguishing the
mean-vs-train_mae denominator and the rapid-retrain vs distinct-weekly cases.
Suite 321 → **326 passed**. All changes only TIGHTEN graduation (drop false
passes / fix a vanity metric) — safe direction, and shadow-mode still gates any
promotion to a live hotel.

### [7] Robustness — never write NaN/inf/negative predictions

A degenerate posterior (near-singular covariance, corrupt serialized params)
can yield NaN quantiles, and `max(nan, 0)` returns nan in Python — so the
existing non-negative clip did NOT catch them. Writing one into the NOT NULL
numeric prediction columns would fail the insert or poison every downstream
days-left/reorder calc. Added `_is_finite_nonneg` and a guard that skips + logs
a non-finite prediction (`predicted=False`), plus a defensive clamp on
`predicted_current_stock`. **Tests:** +3 (`test_inventory_inference_robustness.py`);
suite 326 → **329 passed**.
