"""Read-only evaluation utilities for the inventory ML layer.

Honesty-audit Phase 3 (2026-05-22): production realized-MAE backtesting
sourced from the `prediction_log` table (predicted vs. observed pairs
written by the post-count-process route at
src/app/api/inventory/post-count-process/route.ts:185-200).

Pure read — no writes to model_runs, inventory_rate_predictions, or any
operational table.
"""
