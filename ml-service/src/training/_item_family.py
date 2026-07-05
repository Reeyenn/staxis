"""Route an inventory item to a usage MODEL FAMILY.

Two families (2026-07-05 reduced-exposure rebuild):

  • "exposure"  — guest-consumable items whose usage scales with guest
    exposure (checkouts + κ·stayovers). Amenities, linens, breakfast/F&B,
    paper goods. Modeled by window_consumption = s·(ΣCO + κ·ΣSO).

  • "occupancy" — public-area / staff items whose usage is (largely)
    occupancy-INDEPENDENT: light bulbs, batteries, cleaning chemicals,
    office/lobby supplies, HVAC filters. These don't fit the exposure
    physics — a lobby light burns the same whether the hotel is full or
    half-empty — so they keep the LEGACY affine occupancy model
    daily_rate = a + b·(occupancy − baseline).

ROUTING RULES (first match wins; documented so the split is auditable):

  1. Category 'maintenance' → occupancy. The inventory.category CHECK is
     ('housekeeping','maintenance','breakfast'); maintenance items (bulbs,
     batteries, filters, hardware) are the archetypal occupancy-independent
     supplies. 'breakfast' → exposure (F&B scales with guests in-house).
     'housekeeping' is ambiguous (both amenities AND cleaning chemicals live
     there), so it falls through to the name/canonical checks below.

  2. Canonical name in OCCUPANCY_CANONICALS → occupancy. From the 20-bucket
     item_canonical_name_view, 'all-purpose cleaner' and 'garbage bag' are the
     public-area/cleaning supplies. Everything else canonical (shampoo, towels,
     sheets, coffee pods, …) is guest-consumable → exposure.

  3. Name-keyword fallback (for items that don't resolve to a canonical bucket,
     i.e. canonical == 'unknown'): if the raw name matches an occupancy keyword
     (bulb, battery, cleaner, chemical, filter, bleach, detergent, office,
     lobby, …) → occupancy. Otherwise → exposure (the safe default: the
     exposure model degrades gracefully to "usage ∝ guests" which is right for
     the large majority of a hotel's SKUs).

This module has NO ML/Supabase deps so the routing is trivially unit-testable.
"""
from typing import Any, Dict


# Canonical buckets (from item_canonical_name_view, migration 0062) that are
# public-area / cleaning supplies rather than guest-consumables.
OCCUPANCY_CANONICALS = frozenset({
    "all-purpose cleaner",
    "garbage bag",
})

# Substrings that mark an item (whose canonical name is 'unknown') as
# occupancy-independent. Lower-cased substring match on the raw item name.
OCCUPANCY_NAME_KEYWORDS = (
    "bulb", "light", "lamp",
    "battery", "batteries",
    "cleaner", "cleaning", "chemical", "bleach", "detergent", "disinfectant",
    "sanitizer", "solution",
    "filter", "hvac", "air filter",
    "office", "lobby", "front desk", "paper clip", "pen", "printer", "toner",
    "trash bag", "garbage bag", "liner",
)


def route_item_family(item: Dict[str, Any], canonical_name: str) -> str:
    """Return 'exposure' or 'occupancy' for one inventory item.

    Args:
      item: the inventory row dict (reads 'category' and 'name').
      canonical_name: the resolved item_canonical_name (e.g. 'shampoo',
        'all-purpose cleaner', or 'unknown').

    Returns:
      'occupancy' for public-area/staff items, else 'exposure'.
    """
    category = str(item.get("category") or "").strip().lower()

    # Rule 1 — category.
    if category == "maintenance":
        return "occupancy"
    if category == "breakfast":
        return "exposure"

    # Rule 2 — canonical bucket.
    cn = str(canonical_name or "").strip().lower()
    if cn in OCCUPANCY_CANONICALS:
        return "occupancy"
    if cn != "unknown" and cn != "":
        # A recognized guest-consumable canonical (shampoo, towel, sheet, …).
        return "exposure"

    # Rule 3 — name-keyword fallback for unknown-canonical items.
    name = str(item.get("name") or "").strip().lower()
    if any(kw in name for kw in OCCUPANCY_NAME_KEYWORDS):
        return "occupancy"

    # Safe default: exposure.
    return "exposure"


def resolve_kappa(item: Dict[str, Any], default_kappa: float) -> float:
    """κ = usage_per_stayover / usage_per_checkout for an exposure item.

    κ scales a stayover room's consumption relative to a checkout room's. It is
    FIXED per item from the item's configured usage fields — never learned —
    because at N=10-30 windows a free 2-coefficient (checkout, stayover) split
    is not identifiable (checkout/stayover mix barely varies → collinearity).

    Falls back to `default_kappa` (INVENTORY_DEFAULT_KAPPA) when either field is
    missing, non-numeric, or ≤ 0. Guard clamps to a sane [0, 5] range so a
    fat-fingered config (e.g. usage_per_checkout = 0.001) can't blow κ up.

    Returns the κ actually used (persisted in hyperparameters by the caller).
    """
    try:
        per_co = float(item.get("usage_per_checkout"))
        per_so = float(item.get("usage_per_stayover"))
    except (TypeError, ValueError):
        return default_kappa
    if per_co <= 0.0 or per_so < 0.0:
        return default_kappa
    kappa = per_so / per_co
    # Clamp: a stayover shouldn't use >5× a checkout; negative already excluded.
    if kappa < 0.0:
        return default_kappa
    return min(kappa, 5.0)
