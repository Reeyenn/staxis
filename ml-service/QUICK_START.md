# Quick Start — Staxis ML Service

## Local Development

```bash
# 1. Install dependencies
pip install -r requirements.txt

# 2. Create .env
cat > .env << 'DOTENV'
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGc...
ML_SERVICE_SECRET=your-test-secret
LOG_LEVEL=INFO
DOTENV

# 3. Run tests
pytest tests/ -v

# 4. Start server
uvicorn src.main:app --reload --port 8000

# 5. Test health
curl http://localhost:8000/health

# 6. Train a model (requires valid property UUID in DB)
curl -X POST http://localhost:8000/train/demand \
  -H "Authorization: Bearer your-test-secret" \
  -H "Content-Type: application/json" \
  -d '{"property_id": "550e8400-e29b-41d4-a716-446655440000"}'
```

## Docker

```bash
# Build
docker build -t staxis-ml:latest .

# Run (requires .env file in pwd)
docker run -p 8000:8000 --env-file .env staxis-ml:latest

# Test
curl http://localhost:8000/health
```

## Production (Railway)

1. Push to main: `git push origin main`
2. Railway auto-deploys (watches ml-service/* changes)
3. Set env vars in Railway dashboard:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `ML_SERVICE_SECRET`
   - `LOG_LEVEL=INFO`
4. View logs: `railway logs`

## Key Endpoints

### Health (No Auth)
```
GET /health
→ {status: "ok"}
```

### Train (Auth Required)
```
POST /train/demand
-H "Authorization: Bearer <ML_SERVICE_SECRET>"
-H "Content-Type: application/json"
-d '{"property_id": "uuid", "max_rows": 500}'

→ {
  "model_run_id": "uuid",
  "is_active": true/false,
  "training_mae": 2.5,
  "validation_mae": 3.1,
  "baseline_mae": 4.2,
  "beats_baseline_pct": 26.2
}
```

### Predict (Auth Required)
```
POST /predict/demand
-H "Authorization: Bearer <ML_SERVICE_SECRET>"
-H "Content-Type: application/json"
-d '{"property_id": "uuid", "date": "2026-05-01"}'

→ {
  "property_id": "uuid",
  "date": "2026-05-01",
  "predicted_minutes_p50": 180.5,
  "predicted_minutes_p95": 240.2,
  "predicted_headcount_p50": 1.0,
  "predicted_headcount_p95": 2.0,
  "model_version": "bayesian-v1"
}
```

## Troubleshooting

### Tests Failing
```
# Run with verbose output
pytest tests/ -vv --tb=short

# Run specific test file
pytest tests/test_bayesian.py -v
```

### Training Not Activating
```sql
-- Check data volume
select count(*) from cleaning_events where property_id = '...';

-- Check model_runs history
select * from model_runs where property_id = '...' order by trained_at desc;
```

### Disagreement Alerts
```sql
-- Check disagreement history
select * from prediction_disagreement where property_id = '...' order by detected_at desc;

-- View current threshold
select mean_disagree, threshold_used from ... -- run compute_disagreement_threshold
```

## Architecture Diagram

```
                    REQUEST
                       |
                   /health? (no auth)
                   /
        AUTH CHECK (Bearer token)
       /      |       |
    train  predict  optimize
     / \      / \      |
   D   S    D   S     MC
   |   |    |   |     |
  (1) (2)  (1) (2)   (3)
   |   |    |   |     |
  BAY  BN   BN  BN   SIM
  XGB  XGB  XGB XGB   |
   |   |    |   |   P(complete)
   |   |    |   |     |
  SAVE SAVE LOG LOG  OPTS
   |   |    |   |     |
  SUPABASE-CLOUD ← STORAGE
   |      |      |
MODELS  PREDS  LOGS
```

Legend:
- D = Demand (Layer 1)
- S = Supply (Layer 2)
- BAY = Bayesian (Phase-0)
- XGB = XGBoost
- BN = Bayesian or XGB (conditional on N)
- SIM = Monte Carlo simulation
- OPTS = Optimizer results
- MC = Monte Carlo

## File Structure

```
ml-service/
├── Dockerfile              ← Production image
├── requirements.txt        ← Python deps
├── pyproject.toml         ← Build config
├── README.md              ← Full docs
├── QUICK_START.md         ← This file
├── src/
│   ├── main.py            ← FastAPI app
│   ├── config.py          ← Settings
│   ├── auth.py            ← Bearer token
│   ├── health.py          ← /health
│   ├── advisory_lock.py   ← Concurrency
│   ├── supabase_client.py ← DB
│   ├── storage.py         ← Blob storage
│   ├── features/          ← Feature engineering
│   ├── layers/            ← Models (Bayesian, XGB, baseline)
│   ├── training/          ← Training pipelines
│   ├── inference/         ← Prediction pipelines
│   ├── optimizer/         ← Headcount recommendation
│   └── monitoring/        ← Auto-rollback + disagreement
└── tests/                 ← Unit tests (38 passing)
```

## Key Concepts

### Bayesian Cold-Start (Phase-0)
Works from day 1 with zero training data. Posterior predictive is a t-distribution with closed-form quantiles. No MCMC.

### Quantile Regression
p10, p25, p50, p75, p90, p95 for demand. Enables probabilistic recommendations.

### Activation Gates
Model must pass:
1. N >= 500 rows
2. val_mae < 5 min
3. beats_baseline >= 20%
4. 2 consecutive passing runs (stability)

### Auto-Rollback
14-day rolling shadow MAE + Wilcoxon test. Deactivates if active model statistically worse than baseline.

### Disagreement Detection
L1 vs L2 mismatch detection with adaptive threshold (mean + 2*stdev).

### Property-Level Locking
Postgres advisory locks serialize training per property (different properties in parallel).

## Debugging

### Enable verbose logging
```python
# In config.py, set LOG_LEVEL = "DEBUG"
```

### Inspect feature snapshots
```sql
select features_snapshot from demand_predictions 
where property_id = '...' 
order by predicted_at desc 
limit 1;
```

### Check model status
```sql
select 
  layer, 
  model_version, 
  is_active, 
  validation_mae, 
  beats_baseline_pct
from model_runs 
where property_id = '...' 
order by trained_at desc 
limit 5;
```

## Next Steps

1. Git commit + push
2. Railway auto-deploys
3. Test health endpoint
4. Run /train/demand with valid property UUID
5. Check model_runs table for activation
6. Run /predict/demand to generate forecast
7. Integrate with Schedule tab (P5)
