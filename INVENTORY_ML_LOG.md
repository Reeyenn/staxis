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

(entries appended as work lands)
