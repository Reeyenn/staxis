"""Bayesian regression with conjugate Gaussian-Inverse-Gamma prior (Phase-0 model).

The headline differentiator: works correctly from N=0 training rows.
Uses closed-form posterior predictive distribution (t-distribution)
with no MCMC, no external probabilistic programming libraries.
"""
import pickle
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd
from scipy import special, stats

from src.layers.base import BaseModel
from src.layers.static_baseline import (
    CHECKOUT_MINUTES,
    STAYOVER_DAY1_MINUTES,
    STAYOVER_DAY2PLUS_MINUTES,
    VACANT_DIRTY_MINUTES,
)


class BayesianRegression(BaseModel):
    """Conjugate Gaussian-Inverse-Gamma Bayesian linear regression.

    Posterior predictive is a t-distribution with explicit closed-form quantiles.
    Enables cold-start (N=0) by returning quantiles from prior.
    """

    def __init__(self, prior_strength: float = 1.0) -> None:
        """Initialize Bayesian regression.

        Args:
            prior_strength: Precision of informative prior (higher = stronger prior)
        """
        self.prior_strength = prior_strength
        self.feature_names: Optional[List[str]] = None

        # Posterior parameters (initialized with weak informative prior)
        self.mu_0 = None  # Prior mean on coefficients
        self.sigma_0 = None  # Prior covariance
        self.alpha = 1.0  # Inverse-Gamma shape
        self.beta = 1.0  # Inverse-Gamma rate

        # Posterior
        self.mu_n = None
        self.sigma_n = None
        self.alpha_n = None
        self.beta_n = None
        self.n_samples = 0

    def _initialize_prior(self, X: pd.DataFrame) -> None:
        """Initialize informative prior from hospitality rules.

        Args:
            X: Feature matrix
        """
        n_features = X.shape[1]

        # Prior mean: strong prior on intercept (60 min base load),
        # zeros on other coefficients
        self.mu_0 = np.zeros(n_features)
        self.mu_0[0] = 60.0  # Intercept prior

        # Prior covariance: strong shrinkage (diagonal)
        # Intercept gets looser prior, others tighter
        self.sigma_0 = np.eye(n_features) * (1.0 / self.prior_strength)
        self.sigma_0[0, 0] *= 10.0  # Looser on intercept

        # Inverse-Gamma prior on noise variance
        # alpha=2, beta=1 gives E[sigma^2] = beta/(alpha-1) = 1
        self.alpha = 2.0
        self.beta = 1.0

    def fit(
        self,
        X: pd.DataFrame,
        y: pd.Series,
        sample_weight: Optional[np.ndarray] = None,
    ) -> None:
        """Fit Bayesian model (update posterior).

        Args:
            X: Feature matrix (n_samples, n_features)
            y: Target vector (n_samples,)
            sample_weight: Optional sample weights
        """
        # Ensure bias term
        if X.shape[1] == 0 or not (X.iloc[:, 0] == 1).all():
            X = pd.concat([pd.Series(np.ones(len(X)), name="intercept"), X], axis=1)

        if self.mu_0 is None:
            self._initialize_prior(X)

        self.feature_names = X.columns.tolist() if hasattr(X, "columns") else None

        X_array = X.values if isinstance(X, pd.DataFrame) else X
        y_array = y.values if isinstance(y, pd.Series) else y

        n, d = X_array.shape
        self.n_samples = n

        # Conjugate Gaussian-Inverse-Gamma update
        # Prior precision
        Lambda_0 = np.linalg.inv(self.sigma_0)

        # Data precision (assume equal weight unless provided)
        weights = sample_weight if sample_weight is not None else np.ones(n)
        W = np.diag(weights)

        # Posterior precision = prior precision + data precision
        Lambda_n = Lambda_0 + X_array.T @ W @ X_array

        # Posterior covariance
        self.sigma_n = np.linalg.inv(Lambda_n)

        # Posterior mean
        weighted_y = X_array.T @ W @ y_array
        self.mu_n = self.sigma_n @ (Lambda_0 @ self.mu_0 + weighted_y)

        # Posterior shape (nu / 2 in scipy parameterization)
        self.alpha_n = self.alpha + n / 2.0

        # Posterior rate
        residuals = y_array - X_array @ self.mu_n
        prior_diff = self.mu_n - self.mu_0
        ss_data = residuals.T @ W @ residuals
        ss_prior = prior_diff.T @ Lambda_0 @ prior_diff
        self.beta_n = self.beta + 0.5 * (ss_data + ss_prior)

    def predict_quantile(
        self,
        X: pd.DataFrame,
        quantiles: List[float],
    ) -> Dict[float, np.ndarray]:
        """Predict quantiles of posterior predictive distribution.

        Uses t-distribution (Student-t) as posterior predictive.
        Args:
            X: Feature matrix
            quantiles: Quantiles to predict (e.g., [0.1, 0.5, 0.9])

        Returns:
            Dictionary mapping quantile -> predictions
        """
        # Ensure bias term
        if X.shape[1] == 0 or not (X.iloc[:, 0] == 1).all():
            X = pd.concat([pd.Series(np.ones(len(X)), name="intercept"), X], axis=1)

        X_array = X.values if isinstance(X, pd.DataFrame) else X

        # Two distinct cases when shapes don't agree:
        #   (a) mu_n is None  → no posterior has been fit yet. Silently
        #       re-initializing the prior to match X loses NOTHING (there's no
        #       learned posterior to throw away). This keeps cold-start callers
        #       working when they pass features the prior wasn't sized for.
        #   (b) mu_n is set   → a real posterior exists. Re-initializing the
        #       prior here would silently discard learning. Refuse, raise.
        if self.mu_n is None:
            # Cold start: (re)initialize prior to match X's shape.
            if self.mu_0 is None or self.mu_0.shape[0] != X_array.shape[1]:
                self._initialize_prior(X)
        else:
            if self.mu_n.shape[0] != X_array.shape[1]:
                raise ValueError(
                    f"BayesianRegression feature shape mismatch: "
                    f"posterior has {self.mu_n.shape[0]} coefficients "
                    f"(feature_names={self.feature_names}) but X has "
                    f"{X_array.shape[1]} features. Refusing to silently "
                    f"revert to prior — retrain or align features."
                )

        if self.mu_n is None:
            # Use prior (cold-start)
            mu = self.mu_0
            sigma = self.sigma_0
            nu = 2 * self.alpha
            scale_sq = self.beta / self.alpha
        else:
            # Use posterior
            mu = self.mu_n
            sigma = self.sigma_n
            nu = 2 * self.alpha_n
            scale_sq = self.beta_n / self.alpha_n

        # Posterior predictive mean (point estimates)
        pred_means = X_array @ mu

        # Posterior predictive variance for each observation
        pred_var = np.array(
            [scale_sq * (1 + X_array[i] @ sigma @ X_array[i]) for i in range(len(X_array))]
        )
        pred_std = np.sqrt(pred_var)

        # Compute quantiles via t-distribution
        result = {}
        for q in quantiles:
            # t-quantile: mu + std * t.ppf(q, df=nu)
            t_quantile = stats.t.ppf(q, df=nu)
            pred_q = pred_means + pred_std * t_quantile
            result[q] = np.maximum(pred_q, 0)  # Clip to non-negative

        return result

    def save(self, path: str) -> None:
        """Save model to pickle file.

        Args:
            path: File path
        """
        state = {
            "mu_0": self.mu_0,
            "sigma_0": self.sigma_0,
            "alpha": self.alpha,
            "beta": self.beta,
            "mu_n": self.mu_n,
            "sigma_n": self.sigma_n,
            "alpha_n": self.alpha_n,
            "beta_n": self.beta_n,
            "n_samples": self.n_samples,
            "feature_names": self.feature_names,
            "prior_strength": self.prior_strength,
        }
        with open(path, "wb") as f:
            pickle.dump(state, f)

    def load(self, path: str) -> None:
        """Load model from pickle file.

        Args:
            path: File path
        """
        with open(path, "rb") as f:
            state = pickle.load(f)
        self.mu_0 = state["mu_0"]
        self.sigma_0 = state["sigma_0"]
        self.alpha = state["alpha"]
        self.beta = state["beta"]
        self.mu_n = state["mu_n"]
        self.sigma_n = state["sigma_n"]
        self.alpha_n = state["alpha_n"]
        self.beta_n = state["beta_n"]
        self.n_samples = state["n_samples"]
        self.feature_names = state["feature_names"]
        self.prior_strength = state["prior_strength"]

    def get_config(self) -> Dict[str, Any]:
        """Get configuration.

        Returns:
            Configuration dict
        """
        return {
            "algorithm": "bayesian",
            "prior_strength": self.prior_strength,
            "n_samples": self.n_samples,
            "mu_0_intercept": float(self.mu_0[0]) if self.mu_0 is not None else 60.0,
        }
