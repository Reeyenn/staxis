# Staxis ML Service

Production-grade Python FastAPI service for housekeeping demand/supply prediction and optimal headcount recommendation via Monte Carlo simulation.

## Architecture

Three-layer hierarchical ML system:

1. **Layer 1 (Demand)**: Total workload prediction (Bayesian conjugate or XGBoost-quantile)
2. **Layer 2 (Supply)**: Per-(room × housekeeper) cleaning-time prediction
3. **Layer 3 (Optimizer)**: Joint Monte Carlo simulation → recommended headcount + assignment plan

All layers run in parallel training pipelines, serialize models to Supabase Storage, and support shadow-mode monitoring + auto-rollback.

## Quick Start (Local)

```bash
# 1. Install dependencies
pip install -r requirements.txt

# 2. Create .env file
cat > .env << 'EOF'
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGc...
ML_SERVICE_SECRET=your-bearer-token-secret
LOG_LEVEL=INFO
EOF

# 3. Run service
uvicorn src.main:app --reload --port 8000

# 4. Test health
curl http://localhost:8000/health

# 5. Train demand model (requires Bearer token)
curl -X POST http://localhost:8000/train/demand \
  -H "Authorization: Bearer your-bearer-token-secret" \
  -H "Content-Type: application/json" \
  -d '{"property_id": "your-property-uuid"}'
```

## Deployment on Railway

### Step 1: Create ML Service in Railway Dashboard

1. Open Railway dashboard: https://railway.app
2. In your Staxis project, click **"+ New Service"**
3. Choose **"GitHub Repo"** and select the Staxis mirror repo
4. Name it: `ml-service`
5. Set the **Root Directory** to `ml-service`
6. Click **"Deploy"**

### Step 2: Configure Environment Variables

In the ML Service settings:
1. Click **"Variables"** tab
2. Add these environment variables:
   - `SUPABASE_URL` = (copy from scraper service or Supabase dashboard)
   - `SUPABASE_SERVICE_ROLE_KEY` = (copy from Supabase → Project Settings → API Keys → Service Role)
   - `ML_SERVICE_SECRET` = (generate a strong random string, e.g., `openssl rand -hex 32`)
   - `LOG_LEVEL` = `INFO`

### Step 3: Verify Deployment

1. In Railway dashboard, watch the ML Service logs:
   - Should see `Uvicorn running on 0.0.0.0:8000`
2. Railway automatically assigns a public URL (e.g., `https://ml-service-production-xxxx.railway.app`)
3. Test health endpoint:
   ```
   curl https://ml-service-production-xxxx.railway.app/health
   ```
   Should return `{"status":"ok"}`

### Step 4: Configure the Scraper to Call This Service

In the scraper container, add:
```
ML_SERVICE_URL=https://ml-service-production-xxxx.railway.app
ML_SERVICE_SECRET=your-bearer-token-secret  (must match above)
```

The scraper will now trigger ML training/inference at the right times.

### Step 5: Manual Testing (Post-Deployment)

To manually trigger training:

```bash
PROPERTY_UUID="your-property-id-here"
TOKEN="your-bearer-token-secret"
ML_URL="https://ml-service-production-xxxx.railway.app"

# Train demand
curl -X POST ${ML_URL}/train/demand \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"property_id\": \"${PROPERTY_UUID}\"}"

# Predict demand for tomorrow
curl -X POST ${ML_URL}/predict/demand \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"property_id\": \"${PROPERTY_UUID}\"}"
```

## Key Features

### Bayesian Cold-Start (Phase-0)

Without any training data, the demand model returns predictions from a **Bayesian posterior** seeded with hospitality-industry priors:
- Checkouts: 30 min/room
- Stayovers (day 1): 15 min/room
- Stayovers (day 2+): 20 min/room
- Vacant-dirty: 30 min/room

The posterior predictive distribution gives full quantiles (p10, p25, p50, p75, p90, p95) even with N=0 rows.

As data accumulates (N >= 200), training gates unlock. At N >= 500 with passing validation metrics, the system transitions to XGBoost-quantile via a feature-flagged code path.

### Quantile Regression

**Demand (Layer 1)**: p10, p25, p50, p75, p90, p95
**Supply (Layer 2)**: p25, p50, p75, p90

Enables the optimizer to target a configurable completion probability (default p95).

### Activation Gates

A model must pass THREE conditions before flipping `is_active = true`:
1. Training data: `training_row_count >= 500`
2. Validation MAE: `validation_mae < 5`
3. Beats baseline: `beats_baseline_pct >= 0.20` (at least 20% better than static rules)
4. **Consecutive passing runs**: Must see 2 consecutive training runs that pass all above gates

The 2-run stability gate prevents flipping on lucky single runs.

### Auto-Rollback

Every morning, a monitoring job computes rolling 14-day shadow MAE on the active model:
- Compare active model's prediction errors vs. static-baseline errors
- Run Wilcoxon signed-rank test (scipy.stats.wilcoxon)
- If p-value < 0.05 AND active model errors > baseline, deactivate model
- Log reason: `"auto_rollback"`

### Property-Level Advisory Lock

Training and inference serialize per-property using Postgres advisory locks:
```sql
pg_try_advisory_lock(hashtext(property_id::text || ':' || layer))
```

Prevents concurrent training runs on the same property from corrupting state. Different properties train in parallel.

### Feature Snapshots

Every prediction writes its full feature vector to `demand_predictions.features_snapshot` (jsonb).
Enables post-hoc debugging, drift detection, and re-training with exact historical context.

### Holiday Calendars

Texas school holidays and US federal holidays are hardcoded in `src/features/calendar.py`:
- 10 US federal holidays (fixed annually)
- TEA Texas school year breaks (2025-26 and 2026-27)

Easy to update yearly by editing the module-level constants.

## API Endpoints

### Health
```
GET /health
→ {status: "ok"}
```

### Training

**Demand**
```
POST /train/demand
Authorization: Bearer <ML_SERVICE_SECRET>
Content-Type: application/json

Request:
{
  "property_id": "uuid",
  "max_rows": 500  // optional, for dev
}

Response:
{
  "model_run_id": "uuid",
  "is_active": true,
  "training_mae": 2.5,
  "validation_mae": 3.1,
  "baseline_mae": 4.2,
  "beats_baseline_pct": 26.2
}
```

**Supply**
```
POST /train/supply
Authorization: Bearer <ML_SERVICE_SECRET>
Content-Type: application/json

Request:
{
  "property_id": "uuid"
}

Response:
{
  "model_run_id": "uuid",
  "is_active": true,
  "training_mae": 5.2,
  "validation_mae": 6.1
}
```

### Inference

**Demand**
```
POST /predict/demand
Authorization: Bearer <ML_SERVICE_SECRET>
Content-Type: application/json

Request:
{
  "property_id": "uuid",
  "date": "2026-05-01"  // optional, defaults to tomorrow
}

Response:
{
  "property_id": "uuid",
  "date": "2026-05-01",
  "predicted_minutes_p50": 180.5,
  "predicted_minutes_p95": 240.2,
  "predicted_headcount_p50": 1.0,
  "predicted_headcount_p95": 2.0,
  "model_version": "bayesian-v1"
}
```

**Supply**
```
POST /predict/supply
Authorization: Bearer <ML_SERVICE_SECRET>
Content-Type: application/json

Request:
{
  "property_id": "uuid",
  "date": "2026-05-01"  // optional, defaults to tomorrow
}

Response:
{
  "property_id": "uuid",
  "date": "2026-05-01",
  "predicted_rooms": [
    {
      "room_number": "101",
      "staff_id": "uuid",
      "predicted_minutes_p50": 25.3,
      "predicted_minutes_p75": 30.1
    },
    ...
  ]
}
```

**Optimizer**
```
POST /predict/optimizer
Authorization: Bearer <ML_SERVICE_SECRET>
Content-Type: application/json

Request:
{
  "property_id": "uuid",
  "date": "2026-05-01"
}

Response:
{
  "property_id": "uuid",
  "date": "2026-05-01",
  "recommended_headcount": 5,
  "achieved_completion_probability": 0.965,
  "completion_probability_curve": [
    {"headcount": 1, "p": 0.02},
    {"headcount": 5, "p": 0.965},
    {"headcount": 10, "p": 0.999}
  ],
  "sensitivity_analysis": {
    "one_hk_sick": {"recommended": 6},
    "plus_5_checkouts": {"recommended": 6}
  }
}
```

## Development

### Running Tests

```bash
pytest tests/ -v

# With coverage
pytest tests/ --cov=src --cov-report=html
```

Key test categories:
- `test_features.py`: Feature engineering (day_of_week, holidays, etc.)
- `test_bayesian.py`: Bayesian model (conjugate posterior, quantiles)
- `test_xgboost.py`: XGBoost quantile regressor
- `test_monte_carlo.py`: Optimizer sampling + convergence
- `test_advisory_lock.py`: Concurrency + serialization

### Project Structure

```
ml-service/
├── Dockerfile
├── requirements.txt
├── pyproject.toml
├── README.md
└── src/
    ├── __init__.py
    ├── main.py                    # FastAPI app
    ├── config.py                  # Pydantic settings
    ├── auth.py                    # Bearer token middleware
    ├── health.py                  # /health endpoint
    ├── supabase_client.py          # Supabase service-role wrapper
    ├── storage.py                 # Model blob storage
    ├── advisory_lock.py            # Postgres advisory locks
    ├── features/
    │   ├── __init__.py
    │   ├── calendar.py            # Day-of-week, holidays
    │   ├── occupancy.py           # In-house, arrivals, departures
    │   ├── mix.py                 # Workload composition
    │   ├── lagged.py              # Lagged target features
    │   ├── pace.py                # Rolling cleaning pace
    │   ├── housekeeper.py         # Per-staff features
    │   └── room.py                # Room type, floor, DND
    ├── layers/
    │   ├── __init__.py
    │   ├── base.py                # BaseModel abstract class
    │   ├── bayesian_regression.py # Phase-0 conjugate Gaussian
    │   ├── xgboost_quantile.py    # XGBoost quantile regressor
    │   └── static_baseline.py     # Hospitality rules as model
    ├── training/
    │   ├── __init__.py
    │   ├── demand.py              # /train/demand pipeline
    │   └── supply.py              # /train/supply pipeline
    ├── inference/
    │   ├── __init__.py
    │   ├── demand.py              # /predict/demand pipeline
    │   └── supply.py              # /predict/supply pipeline
    ├── optimizer/
    │   ├── __init__.py
    │   ├── monte_carlo.py         # Headcount optimizer
    │   └── sensitivity.py         # What-if analysis
    └── monitoring/
        ├── __init__.py
        ├── shadow_mae.py          # Rolling 14-day shadow MAE
        └── disagreement.py        # L1↔L2 disagreement detection
└── tests/
    ├── __init__.py
    ├── test_features.py
    ├── test_features_calendar.py
    ├── test_bayesian.py
    ├── test_xgboost.py
    ├── test_static_baseline.py
    ├── test_monte_carlo.py
    └── test_advisory_lock.py
```

## Key Implementation Notes

### Closed-Form Bayesian Model

The demand Bayesian model uses **Gaussian-Inverse-Gamma conjugate prior** for computational efficiency:
- No MCMC, no PyMC, no Stan — pure NumPy
- Posterior predictive is a t-distribution with explicit closed-form quantiles
- Works correctly from N=0 (returns prior = static rules prediction)
- Cold-start uncertainty intervals are wide; narrow as data accumulates

### Time-Based Holdout

Training uses the most-recent 20% of data as validation holdout (time-based split prevents leakage).
Cross-validation uses 5-fold expanding-window CV on the training portion (respects temporal ordering).

### Idempotent Endpoints

- `/train/demand` called twice produces two `model_runs` rows but doesn't break state
- `/predict/demand` called twice for the same date UPSERTs the row
- Re-running inference with an older model_run_id overwrites prior predictions

### Structured Logging

All requests produce JSON logs with:
- request_id (propagated)
- timestamp
- endpoint
- status
- user_id (if available)
- error details (if applicable)

Matches existing scraper log format for unified observability.

## Troubleshooting

**Model not activating**
- Check training_row_count >= 500 via `select count(*) from cleaning_events where property_id = '...'`
- Verify `validation_mae < 5` and `beats_baseline_pct >= 0.20`
- Look for 2 consecutive passing runs in `model_runs` table

**Disagreement alerts flapping**
- Disagreement uses adaptive threshold (mean + 2*stdev of historical disagreements)
- Threshold falls back to 30% when N < 5 historical samples
- Add more data to stabilize threshold

**Advisory lock contention**
- Check PostgreSQL logs for `pg_try_advisory_lock` failures
- Indicates concurrent training attempts on same property
- Retry logic in training endpoint backs off exponentially

**Model performance degrading**
- Check auto-rollback logs for `deactivation_reason = 'auto_rollback'`
- Wilcoxon test is p < 0.05 with active > baseline
- Manually deactivate if rolling MAE degrades unexpectedly

## License

MIT
