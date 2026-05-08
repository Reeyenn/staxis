---
name: ml-service
description: Use when working on the Python ML service (`ml-service/`) — training models, predictions, the Bayesian cold-start, XGBoost-quantile activation, the Monte Carlo headcount optimizer, or shadow-mode monitoring/auto-rollback. Trigger phrases include "ML model", "demand prediction", "supply prediction", "headcount optimizer", "training row", "validation MAE", "Bayesian prior", "XGBoost quantile", "shadow mode", "auto-rollback", or any task in `ml-service/src/`.
---

# ML service

Python FastAPI service hosted on Railway. Predicts housekeeping workload and recommends optimal headcount via Monte Carlo simulation.

## Three-layer architecture

1. **Layer 1 — Demand:** total workload prediction (Bayesian conjugate or XGBoost-quantile). Inputs: occupancy, mix of checkouts/stayovers/vacant, day-of-week, holidays.
2. **Layer 2 — Supply:** per-(room × housekeeper) cleaning time prediction.
3. **Layer 3 — Optimizer:** joint Monte Carlo simulation → recommended headcount + assignment plan, with sensitivity analysis (one HK sick, +5 checkouts, etc.).

## Bayesian cold-start (Phase-0)

Without any training data, the demand model returns predictions from a **Bayesian posterior** seeded with hospitality-industry priors:
- Checkouts: 30 min/room
- Stayovers (day 1): 15 min/room
- Stayovers (day 2+): 20 min/room
- Vacant-dirty: 30 min/room

Closed-form Gaussian-Inverse-Gamma conjugate — pure NumPy, no MCMC. Posterior predictive is a t-distribution with explicit closed-form quantiles. Works correctly from N=0 (returns prior = static rules prediction).

## Activation gates (model going live)

A model must pass **all four** gates before flipping `is_active = true`:

1. `training_row_count >= 500`
2. `validation_mae < 5`
3. `beats_baseline_pct >= 0.20` (≥20% better than static rules)
4. **2 consecutive passing runs** — single-run lucky training is filtered out

Then the system transitions from Bayesian → XGBoost-quantile via a feature-flagged code path.

## Auto-rollback

Every morning, a monitoring job computes rolling 14-day shadow MAE on the active model:
- Compare active model's prediction errors vs. static-baseline errors.
- Run Wilcoxon signed-rank test (`scipy.stats.wilcoxon`).
- If p-value < 0.05 AND active model errors > baseline → deactivate model. Log reason: `"auto_rollback"`.

## API endpoints

All require `Authorization: Bearer ${ML_SERVICE_SECRET}`.

| Endpoint | Purpose |
|---|---|
| `GET /health` | Liveness check — returns `{status: "ok"}` |
| `POST /train/demand` | Train Layer 1. Body: `{"property_id": "..."}` |
| `POST /train/supply` | Train Layer 2. Body: `{"property_id": "..."}` |
| `POST /predict/demand` | Predict Layer 1. Body: `{"property_id": "...", "date": "YYYY-MM-DD"}` |
| `POST /predict/supply` | Predict Layer 2. Body same shape. |
| `POST /predict/optimizer` | Recommended headcount + sensitivity. Body same shape. |

## Local dev

```bash
cd ml-service
pip install -r requirements.txt

cat > .env << 'EOF'
SUPABASE_URL=https://xjoyasymmdejpmnzbjqu.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGc...
ML_SERVICE_SECRET=<random>
LOG_LEVEL=INFO
EOF

uvicorn src.main:app --reload --port 8000
curl http://localhost:8000/health
```

## Deployment

Railway service `ml-service`. Root directory: `ml-service`. Required env vars:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ML_SERVICE_SECRET` (must match what the scraper / cron uses to call this service)
- `LOG_LEVEL=INFO`

Auto-redeploys on push to main when files under `ml-service/` change.

## Running tests

```bash
cd ml-service
pytest tests/ -v
pytest tests/ --cov=src --cov-report=html  # with coverage
```

Key test categories:
- `test_features.py` — feature engineering (day_of_week, holidays)
- `test_bayesian.py` — conjugate posterior, quantiles
- `test_xgboost.py` — XGBoost quantile regressor
- `test_monte_carlo.py` — optimizer sampling + convergence
- `test_advisory_lock.py` — concurrency + serialization

## Property-level advisory lock

Training and inference serialize per-property using Postgres advisory locks:
```sql
pg_try_advisory_lock(hashtext(property_id::text || ':' || layer))
```

Prevents concurrent training runs on the same property from corrupting state. Different properties train in parallel.

## Holiday calendars

Texas school holidays + US federal holidays are hardcoded in `src/features/calendar.py`. Update yearly by editing the module-level constants.

## Common gotchas

- **Model not activating?** Check `training_row_count >= 500` via `select count(*) from cleaning_events where property_id = '...';`. Then `validation_mae` and `beats_baseline_pct` from `model_runs`. Then look for **2 consecutive** passing runs.
- **Disagreement alerts flapping?** Adaptive threshold uses `mean + 2*stdev` of historical disagreements; falls back to 30% when N<5. Add more data to stabilize.
- **Advisory lock contention?** PG logs show `pg_try_advisory_lock` failures — concurrent training attempts on same property. Training endpoint backs off exponentially; usually self-resolves.
- **Performance degrading after a while?** Check `model_runs` for `deactivation_reason = 'auto_rollback'`. Wilcoxon p < 0.05 with active > baseline triggers it.

## Triggering training/inference manually

```bash
PROPERTY_UUID="<uuid>"
TOKEN="<ML_SERVICE_SECRET>"
ML_URL="https://ml-service-production-xxxx.railway.app"

curl -X POST ${ML_URL}/train/demand \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"property_id\": \"${PROPERTY_UUID}\"}"

curl -X POST ${ML_URL}/predict/demand \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"property_id\": \"${PROPERTY_UUID}\"}"
```

## Feature snapshots

Every prediction writes its full feature vector to `demand_predictions.features_snapshot` (jsonb). Enables post-hoc debugging, drift detection, and re-training with exact historical context. **Don't drop this column** — it's how we diagnose "why did the model predict X on day Y."
