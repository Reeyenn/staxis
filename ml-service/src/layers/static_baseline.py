"""Static hospitality rules as a baseline model."""
from typing import Any, Dict, List

import numpy as np
import pandas as pd

from src.layers.base import BaseModel

# Hospitality industry priors (minutes per room)
CHECKOUT_MINUTES = 30
STAYOVER_DAY1_MINUTES = 15
STAYOVER_DAY2PLUS_MINUTES = 20
VACANT_DIRTY_MINUTES = 30


class StaticBaseline(BaseModel):
    """Static hospitality rules wrapped as a model.

    Used to compute baseline MAE for activation gating.
    This is NOT a trainable model — it applies fixed rules
    based on room state composition.
    """

    def __init__(self) -> None:
        """Initialize static baseline (no parameters)."""
        self.fitted = False

    def fit(
        self,
        X: pd.DataFrame,
        y: pd.Series,
        sample_weight: np.ndarray | None = None,
    ) -> None:
        """Mark as fitted (no actual training).

        Args:
            X: Feature matrix (ignored)
            y: Target vector (ignored)
            sample_weight: Sample weights (ignored)
        """
        self.fitted = True

    def predict_quantile(
        self,
        X: pd.DataFrame,
        quantiles: List[float],
    ) -> Dict[float, np.ndarray]:
        """Predict using static rules (all quantiles return same value).

        The static baseline has no notion of uncertainty — we return
        point predictions for all requested quantiles.

        Args:
            X: Feature matrix (must have checkout/stayover composition)
            quantiles: Quantiles to predict

        Returns:
            Dictionary mapping quantile -> predictions
        """
        predictions = self._predict_points(X)
        return {q: predictions for q in quantiles}

    def _predict_points(self, X: pd.DataFrame) -> np.ndarray:
        """Compute static rule predictions for rows.

        Args:
            X: Feature matrix with required columns:
               - total_checkouts
               - stayover_day_1_count
               - stayover_day_2plus_count
               (optional: vacant_dirty_count)

        Returns:
            Array of predicted total minutes
        """
        predictions = []

        for _, row in X.iterrows():
            checkouts = row.get("total_checkouts", 0) or 0
            day1_stays = row.get("stayover_day_1_count", 0) or 0
            day2plus_stays = row.get("stayover_day_2plus_count", 0) or 0
            vacant = row.get("vacant_dirty_count", 0) or 0

            total_minutes = (
                checkouts * CHECKOUT_MINUTES
                + day1_stays * STAYOVER_DAY1_MINUTES
                + day2plus_stays * STAYOVER_DAY2PLUS_MINUTES
                + vacant * VACANT_DIRTY_MINUTES
            )
            predictions.append(total_minutes)

        return np.array(predictions)

    def save(self, path: str) -> None:
        """Save baseline (no-op).

        Args:
            path: Ignored
        """
        pass

    def load(self, path: str) -> None:
        """Load baseline (no-op).

        Args:
            path: Ignored
        """
        self.fitted = True

    def get_config(self) -> Dict[str, Any]:
        """Get configuration.

        Returns:
            Configuration dict
        """
        return {
            "algorithm": "static_baseline",
            "checkout_minutes": CHECKOUT_MINUTES,
            "stayover_day1_minutes": STAYOVER_DAY1_MINUTES,
            "stayover_day2plus_minutes": STAYOVER_DAY2PLUS_MINUTES,
            "vacant_dirty_minutes": VACANT_DIRTY_MINUTES,
        }
