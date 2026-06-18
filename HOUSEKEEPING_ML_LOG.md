# Housekeeping ML — Overnight Improvement Log

Branch: `chat/housekeeping-ml` (off `be3ef5a4`). **Not merged, not deployed.**
Owner: autonomous run for Reeyen. Goal: make the **housekeeping** demand/supply
prediction + headcount/staffing optimizer accurate, robust, and production-ready
for onboarding **300 brand-new hotels**.

Scope IN: `ml-service/` housekeeping demand & supply prediction, the Monte Carlo
headcount optimizer, features, training, validation, and the housekeeping glue in
`src/` that consumes these predictions.
Scope OUT (other chats own these — do not touch): `cua-service/`, `src/lib/pms/`,
the Inventory ML, the broad app audit.

Priorities (highest first): **1) Cold-start**, 2) Accuracy (MAE), 3) Robustness,
4) Safety (keep shadow-mode + auto-rollback intact).

---

## How the system works today (mental model)

Three stacked layers, per hotel:
1. **Layer 1 — Demand**: predicts tomorrow's *total cleaning minutes* from the room
   mix (checkouts, stayover day-1, stayover day-2+, vacant-dirty, occupancy %, day of
   week). Bayesian conjugate (Gaussian-Inverse-Gamma) linear model with quantiles
   p10..p95. Cold-start = cohort-prior (minutes/room/day × room count).
2. **Layer 2 — Supply**: predicts per-(room × housekeeper) cleaning minutes; quantiles
   p25..p90. Cold-start = cohort-prior minutes/event.
3. **Layer 3 — Optimizer**: Monte Carlo over L1+L2 quantiles, LPT bin-packing across H
   abstract workers, picks smallest H with P(finish within shift_cap×H) ≥ target
   (default p95). This is the **recommended_headcount** that competes with the head
   housekeeper.

Supporting machinery: cohort priors aggregated nightly across the fleet
(`demand_priors`/`supply_priors`, keyed `<brand>-<region>-<size_tier>` + `global`),
honesty contract (fitted / warming-up / capacity-unavailable labels), shadow-mode
promotion (7-day soak), statistical auto-rollback (Wilcoxon + Benjamini-Hochberg FDR),
per-property Postgres advisory locks, model blobs in Supabase Storage, per-property
shard routing by UUID hash (`ML_SERVICE_URLS`).

---

## Environment notes
- Production targets **Python 3.11** (`Dockerfile: python:3.11-slim`,
  `requires-python>=3.11`). The pre-made `.venv` was Python 3.9.6 → test collection
  fails on PEP-604 `X | None` syntax. Built a correct `.venv311` for all validation.
- Test runner: `ml-service/.venv311/bin/python -m pytest tests/ -q` (conftest injects
  placeholder Supabase env; lib tests don't hit a real DB).

---

## Confirmed findings (from reading the code; ml-service is byte-identical to live)

1. **XGBoost never actually activates → permanent linear-model ceiling.**
   `inference/demand.py:345-372` the `xgboost-quantile` path is a stub that always
   returns "blob download not yet implemented". `training/demand.py:376` deliberately
   blocks activation (`XGBOOST_INFERENCE_READY` false) so it never crashes — but the
   system is permanently capped at the linear Bayesian model regardless of how much
   data a hotel collects. Biggest accuracy ceiling for "beat the head housekeeper".
   (Supply layer likely similar — to confirm.)

2. **Headcount uses global shift length in one place, per-property in another.**
   `inference/demand.py:401-413` computes `predicted_headcount_*` by dividing by the
   global `settings.shift_cap_minutes` (420), while `optimizer/monte_carlo.py:189-194`
   correctly uses the per-property `properties.shift_minutes`. Any hotel not on a
   7-hour shift gets inconsistent headcount numbers between the two surfaces.

3. **Fragile "tomorrow" date in the web glue.** `src/lib/ml-schedule-helpers.ts:24`
   `getTomorrowDateStr` defaults to Central time and round-trips through
   `toISOString()`. Works on a UTC server, but a caller that forgets to pass the
   property's tz can look up the wrong day's optimizer row near midnight. (Re-confirm
   against live `src/` — app tree was 184 commits behind in the stale copy.)

(Full audit re-running against the live tree to expand + verify this list.)

---

## Baseline
- `.venv311` (Python 3.11.15) built; **302 passed** in ~20s. This is the green
  baseline every change must preserve.

## Validation harness (new, additive)
`ml-service/scripts/hk_sanity_harness.py` drives the REAL `optimize_headcount`
(and the cold-start quantile shapes) with an in-memory Supabase fake across
synthetic hotels — my before/after measurement tool. Run:
`.venv311/bin/python -m scripts.hk_sanity_harness`.

**Baseline (be3ef5a4):**
```
scenario                    p50min  p95min  hc  achP  L2 naiveHC flags
coldstart-small-30rm           600     840   3  1.00 F        2 ok
coldstart-mid-90rm            1800    2400   6  1.00 F        6 ok
coldstart-large-200rm         4000    5200  13  1.00 F       13 ok
coldstart-mid-90rm+L2         1800    2400   5  0.98 T        6 ok
fitted-mid-90rm+L2            1700    2200   5  1.00 T        6 ok
near-empty-30rm                 30      60   1  1.00 F        1 ok
coldstart-mid-480shift        1800    2400   6  1.00 F        5 ok   (uses 480, not 420 ✓)
```
Confirms: no absurd/sub-1 headcounts (robustness ok); cold-start always L1-only
(L2=False); optimizer uses per-property shift correctly. The L1 path lands at/above
the divisible naive bound (mildly conservative), not catastrophically low.

## Key architectural findings (code-grounded, live tree)
- **Headcount L2 simulation is gated on a pre-existing room→staff schedule.**
  `inference/supply.py` only predicts (room, staff) pairs already present in
  tomorrow's `schedule_assignments`. So the per-room LPT simulation only runs
  AFTER a manager assigns rooms — but headcount is decided BEFORE assigning.
  Net: cold-start (and most planning-time) hotels perpetually use the cruder
  L1-only path + "capacity-unavailable" label. This is the biggest structural
  limiter for "beat the head housekeeper" headcount at 300 new hotels.
- **XGBoost never activates** (`inference/demand.py` stub + `training/demand.py`
  `XGBOOST_INFERENCE_READY=False` block) → permanent linear-Bayesian ceiling.
- **Bayesian prior ignores room-type constants** it imports
  (`bayesian_regression.py` — flat 60-min intercept, zero coefficient means).
  Mostly matters at very low N (cohort-prior path handles true cold-start).
- **demand-inference `predicted_headcount_*` uses global 420** not per-property
  shift (`inference/demand.py`). Low impact (field barely consumed; optimizer is
  authoritative) but inconsistent.

## Synthetic demand-accuracy benchmark (new, additive)
`ml-service/scripts/hk_demand_backtest_synth.py` — generates realistic daily
room-mix + true cleaning minutes under a known process (per-type minutes + dow +
high-occupancy slowdown + spike days + lognormal noise), then measures holdout
MAE for StaticBaseline vs Bayesian. Run:
`.venv311/bin/python -m scripts.hk_demand_backtest_synth`.

**Baseline result (be3ef5a4):**
```
config              n  meanMin staticMAE bayesMAE staticR bayesR bayes>static%
small-30rm-180d   180     477      42.4    45.4   0.089  0.095     -7.1%
small-30rm-365d   365     456      41.7    41.6   0.091  0.091      0.3%
mid-90rm-180d     180    1365     124.2   127.8   0.091  0.094     -2.9%
mid-90rm-365d     365    1548     178.8   153.4   0.115  0.099     14.2%
large-200rm-365d  365    3476     435.5   382.3   0.125  0.110     12.2%
```
**Insight:** the linear Bayesian beats the static rules by only ~12–14% at best
and **never clears the 20% beats-baseline activation gate**. When cleaning time
is ~linear in room-type counts, the static rules are already near the noise
floor. So: (a) demand-MAE chasing with another *linear* model is low-ROI;
(b) the real "beat the head housekeeper" levers are cold-start QUALITY, optimizer
realism + service-level targeting, calibrated uncertainty, and actually letting
models activate (the never-activating XGBoost + the 20% gate). Caveat: real
hotels likely have more nonlinearity (groups/events/day-types) a GBM would
exploit more than this smooth synthetic shows.

## Changelog (validated changes only)

_(none yet — establishing green baseline first; committing validation infra)_

## Left alone (deliberately)
_(tbd)_

## Needs Reeyen's decision
_(tbd)_
