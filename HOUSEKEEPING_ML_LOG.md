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

## Process note
Deep-research workflow (competitor + methods) stalled on one slow web-research
agent behind a parallel barrier. It auto-notifies if it completes; not blocking
on it. Proceeding with code-grounded, validated improvements from my own deep
read + the two harnesses; will fold in competitor research when/if it lands.

## Changelog (validated changes only)

### 1. Extract pure LPT/search helpers (refactor, no behavior change) — `49bd4d94`
`_lpt_makespan`, `_lpt_completion_prob`, `_search_headcount`,
`_headcount_search_ceiling` pulled out of `optimize_headcount`. L2 + L1 rewritten
to call them; RNG draw order + capacity checks byte-preserved. Validated: harness
output identical to baseline; suite 318 passed (+16 helper tests).

### 2. Synthetic-room indivisible-job headcount for cold-start (accuracy/cold-start)
**Problem:** the per-room (L2) headcount simulation only runs for rooms that
already have a staff assignment in tomorrow's schedule — so brand-new hotels and
any pre-schedule planning moment fell to the crude **infinite-divisibility** L1
path, which assumes cleaning work can be split perfectly across people. That
under-recommends on days you can't balance.
**Fix:** when L2 is unavailable, read tomorrow's room composition from the plan
snapshot, treat each cleanable room as an **indivisible job** (relative size =
industry per-room-type minutes), scale to the calibrated L1 demand draw, and
LPT-pack. Falls back to infinite-divisibility only when there's no plan snapshot.
New `inputs_snapshot.headcount_method` ∈ {`l2_supply`,`synthetic_room`,
`l1_divisible`} for observability. Honesty contract unchanged (curve still
omitted when both layers cold-start).
**Validated (sanity harness, before→after):** typical small-room days unchanged
(indivisibility negligible), but the path correctly adds staff where balancing is
hard:
```
parttime-240shift-90rm : divisible naive 7 → synthetic 8
deepclean-fewbig-420   : divisible naive 3 → synthetic 4
coldstart-noplan-90rm  : still l1_divisible (safe fallback)
```
No absurd/sub-1 headcounts; L2/fitted paths untouched. Suite 328 passed
(+10 synthetic-room tests). One extra indexed plan_snapshots read per optimizer
run (negligible).

### 3. Composition-aware cold-start L1 demand (accuracy/cold-start) — #1 ROI
**Problem:** cold-start demand was `prior_minutes_per_room_per_day × total_rooms`
— a flat number that ignored tomorrow's room MIX. A checkout-heavy day and an
all-stayover day at the same occupancy got the SAME prediction, even though a
checkout clean takes ~2× a stayover. (Hotel Effectiveness's documented 7.4%
cost cut came purely from splitting these.)
**Fix:** `inference/demand.py` cold-start now applies the industry per-room-type
minutes (checkout/vacant 30, stayover-day1 15, stayover-day2+ 20) to tomorrow's
actual composition (already in the feature vector). Falls back to the cohort
flat estimate when the plan has no usable composition. `features_snapshot`
records the basis (`composition` | `flat_cohort`).
**Validated (synthetic backtest, holdout MAE, no per-hotel training):**
```
config            flatMAE  compCalMAE  reduction
small-30rm-365d      78.2       41.9       46%
mid-90rm-365d       247.7      151.2       39%
large-200rm-365d    584.3      380.7       35%
```
**~35-46% cold-start demand MAE reduction.** Suite 330 passed (updated 3 tests
that pinned the old flat behavior + added composition/fallback tests).
Follow-up: per-room-type cohort priors (needs priors-aggregation schema work) to
fleet-calibrate the per-type level beyond generic industry constants.

### 4. Robustness: sanity envelope + quantile-crossing repair (robustness)
**Problem:** a corrupt PMS scrape (a 600-min "room", a 0-min room, or crossed
quantiles where p50 > p90) silently corrupts the Monte Carlo makespan
distribution → absurd headcount. Research (Optii/UniFocus/JIEM) recommends
clamping per-room times to the labor-standard envelope.
**Fix:** `optimizer/monte_carlo.py` now clamps each room's p25/p50/p90 to
[5, 120] min and sorts them (repairs crossing) before sampling; the L1 demand
path enforces non-negative + p95≥p50. Only fires on out-of-range/garbage inputs;
in-range predictions are byte-identical (harness unchanged). Suite 330 passed
(+4 sanitizer tests).

### 5. Composition-aware cold-start L2 supply (accuracy/cold-start)
**Problem:** cold-start per-room (supply) predictions gave EVERY room the same
flat cohort `prior_minutes_per_event`, ignoring that a checkout takes ~2× a
stayover — even though the supply path already computes each room's type.
**Fix:** `inference/supply.py` cold-start now distributes the cohort per-event
level across rooms by type (checkout/vacant longer, stayover shorter), using the
industry per-type minutes as the shape and **day-normalizing so the per-room
average still equals the cohort mu** (total preserved exactly — zero level drift).
Improves the optimizer's L2 path realism for cold-start hotels with a schedule,
and the per-room display. Suite 334 passed (updated 1 test to verify
checkout>stayover + total preservation).

## Competitor & methods research (Optii, Hotel Effectiveness/Actabl, UniFocus, Flexkeeping/Knowcross/ALICE, M5/OR literature)
Full extract saved during the run. Convergent, actionable lessons:

1. **Status mix IS the demand (highest ROI).** Checkout/departure clean ≈ 2×
   stayover. A 60%-occupancy heavy-checkout day needs FAR more labor than a
   90%-occupancy all-stayover day. Hotel Effectiveness's documented 7.4%
   housekeeping cost cut came *purely* from splitting stayover vs checkout.
   → Our cold-start L1 demand uses flat `prior_per_room × total_rooms` and
   ignores composition. **Fix first.**
2. **Cold-start prior = industry per-type minutes, tiered by service level.**
   Select-service (Comfort Suites): checkout ~25-30 min, stayover ~12-18,
   suite 45-90; ~16-20 rooms/8h shift; HPOR ~0.45-0.74. Our constants
   (30/15/20/30) are in range. Seed the Bayesian prior on these (it currently
   uses a flat 60-min intercept + zero coefficients).
3. **Sanity rails / fixed-plus-variable floor.** Staffing = fixed floor +
   variable(driver). Clamp/flag implausible outputs: per-room 5-90 min,
   rooms/shift ~8-22, HPOR ~0.4-1.2. Cheap robustness + honesty guard.
4. **Quantile-crossing repair** — sort/clip p10≤…≤p95 before the optimizer;
   crossed quantiles corrupt the Monte Carlo.
5. **Probabilistic p95 completion is our real edge** over a head housekeeper's
   single gut number ("will all rooms be ready by checkout?"). Keep it; frame
   product around it. (Newsvendor: p95 ≈ understaffing penalized ~19× overstaffing.)
6. **Quota endogeneity** in supply training: observed per-room time drops
   ~0.5 min per extra room assigned (workers self-pace). Training on raw times
   risks learning "pile on rooms = faster" → under-staffing. Neutralize later.
7. **Pooled cohort model is the cold-start engine** (M5: pooled beats thin
   per-hotel). Shrink to cohort, sharpen with own data, smooth handoff
   (James-Stein). Our cohort priors already do this; tier by service level.
8. Don't over-invest in per-attendant skill features (~0% of clean-time variance).
9. Credits = predicted minutes; report HPOR/MPOR/CPOR alongside headcount so a
   GM can audit in their own units. (UX/reporting — later.)
10. Calibrated intervals via conformal (CQR) — future accuracy lever.

## Planned next (this branch)
- [DONE] Composition-aware cold-start L1 demand — see changelog #3.
- [DONE] Sanity envelope + quantile-crossing repair — see changelog #4.
- (Future, needs schema work) Per-room-type cohort priors so cold-start level is
  fleet-calibrated per clean-type, not just generic industry constants.

## Left alone (deliberately)
_(tbd)_

## Needs Reeyen's decision
_(tbd)_
