"""L1↔L2 disagreement detection with adaptive threshold."""
from datetime import datetime
from typing import Optional, Tuple

import numpy as np

from src.supabase_client import get_supabase_client


async def compute_disagreement_threshold(
    property_id: str,
) -> float:
    """Compute adaptive disagreement threshold from historical data.

    Threshold = mean + 2 * stdev of past disagreements.
    Falls back to 30% when insufficient history.

    Args:
        property_id: Property UUID

    Returns:
        Disagreement threshold (as percentage, e.g., 0.25 for 25%)
    """
    client = get_supabase_client()

    # Fetch recent disagreements
    disagreements = client.fetch_many(
        "prediction_disagreement",
        filters={"property_id": property_id},
        order_by="detected_at",
        descending=True,
        limit=100,
    )

    if not disagreements or len(disagreements) < 5:
        return 0.30  # Fallback: 30%

    pcts = [float(d.get("disagreement_pct", 0)) / 100.0 for d in disagreements]
    mean_pct = np.mean(pcts)
    std_pct = np.std(pcts)

    # Threshold = mean + 2 * stdev
    threshold = mean_pct + 2 * std_pct

    # Clamp to reasonable range
    return float(np.clip(threshold, 0.05, 0.50))


async def detect_disagreement(
    property_id: str,
    layer1_total_p50: float,
    layer2_summed_p50: float,
    layer1_model_run_id: str,
    layer2_model_run_id: str,
) -> Optional[bool]:
    """Detect and log L1↔L2 disagreement if above threshold.

    Args:
        property_id: Property UUID
        layer1_total_p50: Layer 1 p50 prediction (total minutes)
        layer2_summed_p50: Sum of Layer 2 p50 predictions
        layer1_model_run_id: Layer 1 model run ID
        layer2_model_run_id: Layer 2 model run ID

    Returns:
        True if disagreement detected and logged, None if thresholds unavailable
    """
    if layer1_total_p50 == 0 or layer2_summed_p50 == 0:
        return None

    # Compute disagreement percentage
    disagreement_pct = abs(layer1_total_p50 - layer2_summed_p50) / layer1_total_p50

    # Get threshold
    threshold = await compute_disagreement_threshold(property_id)

    # Check if disagreement exceeds threshold
    if disagreement_pct > threshold:
        # Log it
        client = get_supabase_client()
        try:
            client.insert(
                "prediction_disagreement",
                {
                    "property_id": property_id,
                    "date": datetime.utcnow().date().isoformat(),
                    "layer1_total_p50": float(layer1_total_p50),
                    "layer2_summed_p50": float(layer2_summed_p50),
                    "disagreement_pct": float(disagreement_pct),
                    "threshold_used": float(threshold),
                    "layer1_model_run_id": layer1_model_run_id,
                    "layer2_model_run_id": layer2_model_run_id,
                    "detected_at": datetime.utcnow().isoformat(),
                },
            )
            return True
        except Exception:
            return False

    return False
