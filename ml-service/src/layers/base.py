"""Abstract base model class for all ML layers."""
from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd


class BaseModel(ABC):
    """Abstract base class for ML models.

    All layer models (demand, supply) inherit from this to ensure
    consistent interface for training, prediction, and serialization.
    """

    @abstractmethod
    def fit(
        self,
        X: pd.DataFrame,
        y: pd.Series,
        sample_weight: Optional[np.ndarray] = None,
    ) -> None:
        """Fit model on training data.

        Args:
            X: Feature matrix
            y: Target vector
            sample_weight: Optional sample weights
        """
        pass

    @abstractmethod
    def predict_quantile(
        self,
        X: pd.DataFrame,
        quantiles: List[float],
    ) -> Dict[float, np.ndarray]:
        """Predict quantiles for new data.

        Args:
            X: Feature matrix
            quantiles: List of quantiles to predict (e.g., [0.1, 0.5, 0.9])

        Returns:
            Dictionary mapping quantile -> prediction array
        """
        pass

    def predict(self, X: pd.DataFrame) -> np.ndarray:
        """Predict median (p50) for new data.

        Args:
            X: Feature matrix

        Returns:
            Median predictions
        """
        return self.predict_quantile(X, [0.5])[0.5]

    @abstractmethod
    def save(self, path: str) -> None:
        """Save model to disk.

        Args:
            path: File path to save model
        """
        pass

    @abstractmethod
    def load(self, path: str) -> None:
        """Load model from disk.

        Args:
            path: File path to load model from
        """
        pass

    @abstractmethod
    def get_config(self) -> Dict[str, Any]:
        """Get model configuration for logging.

        Returns:
            Configuration dictionary
        """
        pass
