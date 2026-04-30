"""Health check endpoint."""
from typing import Dict

from fastapi import APIRouter

router = APIRouter()


@router.get("/health", tags=["health"])
async def health_check() -> Dict[str, str]:
    """Health check endpoint (no auth required).

    Returns:
        Status dictionary
    """
    return {"status": "ok"}
