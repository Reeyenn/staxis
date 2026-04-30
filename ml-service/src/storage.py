"""Model blob storage management via Supabase Storage."""
import io
import json
from typing import Any, Optional

from supabase import Client

MODELS_BUCKET = "ml-models"


class StorageManager:
    """Manages model artifact storage in Supabase Storage."""

    def __init__(self, client: Client) -> None:
        """Initialize storage manager.

        Args:
            client: Supabase client
        """
        self.client = client

    def ensure_bucket_exists(self) -> None:
        """Ensure ml-models bucket exists (idempotent).

        Creates the bucket if it doesn't exist. Uses service-role key
        which has full permissions.
        """
        try:
            self.client.storage.get_bucket(MODELS_BUCKET)
        except Exception:
            # Bucket doesn't exist, try to create it
            try:
                self.client.storage.create_bucket(
                    MODELS_BUCKET,
                    options={"public": False},
                )
            except Exception:
                # Bucket may already exist from another request
                pass

    def save_model(
        self,
        path: str,
        model_data: bytes,
    ) -> str:
        """Save model artifact to Storage.

        Args:
            path: Storage path (e.g., "property-uuid/demand/model-v1.pkl")
            model_data: Model bytes

        Returns:
            Full path in storage
        """
        self.ensure_bucket_exists()

        # Upload file
        self.client.storage.from_(MODELS_BUCKET).upload(
            path,
            model_data,
        )
        return f"{MODELS_BUCKET}/{path}"

    def load_model(self, path: str) -> Optional[bytes]:
        """Load model artifact from Storage.

        Args:
            path: Storage path (without bucket prefix)

        Returns:
            Model bytes or None if not found
        """
        try:
            response = self.client.storage.from_(MODELS_BUCKET).download(path)
            return response
        except Exception:
            return None

    def save_json(
        self,
        path: str,
        data: Any,
    ) -> str:
        """Save JSON metadata to Storage.

        Args:
            path: Storage path
            data: JSON-serializable data

        Returns:
            Full path in storage
        """
        json_bytes = json.dumps(data).encode("utf-8")
        return self.save_model(path, json_bytes)

    def load_json(self, path: str) -> Optional[Any]:
        """Load JSON metadata from Storage.

        Args:
            path: Storage path

        Returns:
            Parsed JSON or None if not found
        """
        data = self.load_model(path)
        if data:
            return json.loads(data.decode("utf-8"))
        return None

    def delete_model(self, path: str) -> bool:
        """Delete model artifact from Storage.

        Args:
            path: Storage path

        Returns:
            True if successful
        """
        try:
            self.client.storage.from_(MODELS_BUCKET).remove([path])
            return True
        except Exception:
            return False
