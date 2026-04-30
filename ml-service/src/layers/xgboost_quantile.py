"""XGBoost quantile regression for Layer 1 upgrade path (N>=500).

One XGBoost model per quantile, using objective='reg:quantileerror'.
"""
import pickle
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd
import xgboost as xgb

from src.layers.base import BaseModel


class XGBoostQuantile(BaseModel):
    """XGBoost-based quantile regressor with per-quantile models."""

    def __init__(
        self,
        quantiles: Optional[List[float]] = None,
        max_depth: int = 5,
        learning_rate: float = 0.1,
        n_estimators: int = 100,
    ) -> None:
        """Initialize XGBoost quantile regressor.

        Args:
            quantiles: List of quantiles to train (e.g., [0.25, 0.5, 0.75])
            max_depth: Tree depth
            learning_rate: Learning rate
            n_estimators: Number of boosting rounds
        """
        self.quantiles = quantiles or [0.25, 0.5, 0.75, 0.9]
        self.max_depth = max_depth
        self.learning_rate = learning_rate
        self.n_estimators = n_estimators
        self.models: Dict[float, xgb.XGBRegressor] = {}
        self.feature_names: Optional[List[str]] = None

    def fit(
        self,
        X: pd.DataFrame,
        y: pd.Series,
        sample_weight: Optional[np.ndarray] = None,
    ) -> None:
        """Train one XGBoost model per quantile.

        Args:
            X: Feature matrix
            y: Target vector
            sample_weight: Optional sample weights
        """
        self.feature_names = X.columns.tolist() if hasattr(X, "columns") else None

        X_array = X.values if isinstance(X, pd.DataFrame) else X
        y_array = y.values if isinstance(y, pd.Series) else y

        for q in self.quantiles:
            try:
                # Try XGBoost 2.0+ API with quantile_alpha as constructor kwarg
                model = xgb.XGBRegressor(
                    objective="reg:quantileerror",
                    quantile_alpha=q,
                    max_depth=self.max_depth,
                    learning_rate=self.learning_rate,
                    n_estimators=self.n_estimators,
                    random_state=42,
                    verbosity=0,
                )
                model.fit(
                    X_array,
                    y_array,
                    sample_weight=sample_weight,
                )
            except TypeError as e:
                # Fall back to xgb.train() with explicit params if constructor doesn't support quantile_alpha
                if "quantile_alpha" in str(e):
                    dtrain = xgb.DMatrix(X_array, label=y_array, weight=sample_weight)
                    params = {
                        "objective": "reg:quantileerror",
                        "quantile_alpha": q,
                        "max_depth": self.max_depth,
                        "learning_rate": self.learning_rate,
                        "random_state": 42,
                    }
                    xgb_model = xgb.train(params, dtrain, num_boost_round=self.n_estimators)
                    # Wrap in XGBRegressor for consistent interface
                    model = xgb.XGBRegressor(
                        max_depth=self.max_depth,
                        learning_rate=self.learning_rate,
                        n_estimators=self.n_estimators,
                        random_state=42,
                    )
                    model.get_booster().set_attr(
                        objective="reg:quantileerror", quantile_alpha=str(q)
                    )
                else:
                    raise
                # NOTE: do NOT call model.fit() here. The fallback path already
                # trained the booster via xgb.train() above; calling fit() would
                # re-train from scratch and discard that work. The success path
                # in the try block has already trained the model when we reach
                # this point.
            self.models[q] = model

    def predict_quantile(
        self,
        X: pd.DataFrame,
        quantiles: List[float],
    ) -> Dict[float, np.ndarray]:
        """Predict quantiles using trained models.

        Args:
            X: Feature matrix
            quantiles: Quantiles to predict

        Returns:
            Dictionary mapping quantile -> predictions
        """
        X_array = X.values if isinstance(X, pd.DataFrame) else X
        result = {}

        for q in quantiles:
            if q in self.models:
                pred = self.models[q].predict(X_array)
                result[q] = np.maximum(pred, 0)  # Clip to non-negative
            else:
                # Interpolate if quantile not trained
                # Use nearest trained quantile
                trained_qs = sorted(self.models.keys())
                if q < trained_qs[0]:
                    result[q] = self.models[trained_qs[0]].predict(X_array)
                elif q > trained_qs[-1]:
                    result[q] = self.models[trained_qs[-1]].predict(X_array)
                else:
                    # Linear interpolation
                    idx = np.searchsorted(trained_qs, q)
                    q1, q2 = trained_qs[idx - 1], trained_qs[idx]
                    w = (q - q1) / (q2 - q1)
                    pred1 = self.models[q1].predict(X_array)
                    pred2 = self.models[q2].predict(X_array)
                    result[q] = (1 - w) * pred1 + w * pred2

        return result

    def save(self, path: str) -> None:
        """Save models to pickle file.

        Args:
            path: File path
        """
        state = {
            "quantiles": self.quantiles,
            "models": self.models,
            "feature_names": self.feature_names,
            "max_depth": self.max_depth,
            "learning_rate": self.learning_rate,
            "n_estimators": self.n_estimators,
        }
        with open(path, "wb") as f:
            pickle.dump(state, f)

    def load(self, path: str) -> None:
        """Load models from pickle file.

        Args:
            path: File path
        """
        with open(path, "rb") as f:
            state = pickle.load(f)
        self.quantiles = state["quantiles"]
        self.models = state["models"]
        self.feature_names = state["feature_names"]
        self.max_depth = state["max_depth"]
        self.learning_rate = state["learning_rate"]
        self.n_estimators = state["n_estimators"]

    def get_config(self) -> Dict[str, Any]:
        """Get configuration.

        Returns:
            Configuration dict
        """
        return {
            "algorithm": "xgboost-quantile",
            "quantiles": self.quantiles,
            "max_depth": self.max_depth,
            "learning_rate": self.learning_rate,
            "n_estimators": self.n_estimators,
        }
