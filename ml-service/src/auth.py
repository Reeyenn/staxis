"""Authentication middleware for ML Service."""
import hmac

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from src.config import Settings, get_settings

security = HTTPBearer()


async def verify_bearer_token(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    settings: Settings = Depends(get_settings),
) -> str:
    """Verify bearer token from Authorization header.

    Args:
        credentials: Bearer token from Authorization header
        settings: Application settings

    Returns:
        The token (validated)

    Raises:
        HTTPException: If token is invalid
    """
    # Codex audit pass-6 P1 — `!=` short-circuits on the first byte
    # mismatch. With careful timing measurements an attacker can
    # iteratively guess the secret one byte at a time. hmac.compare_digest
    # is constant-time. Both inputs must be strings; defensively coerce.
    expected = settings.ml_service_secret or ""
    provided = credentials.credentials or ""
    if not isinstance(expected, str) or not isinstance(provided, str) or \
       not hmac.compare_digest(provided, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid API token",
        )
    return credentials.credentials
