"""Authentication middleware for ML Service."""
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
    if credentials.credentials != settings.ml_service_secret:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid API token",
        )
    return credentials.credentials
