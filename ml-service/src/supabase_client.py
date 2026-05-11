"""Supabase client wrapper for ML Service."""
import json
from typing import Any, Dict, List, Optional

from supabase import Client, create_client

from src.config import Settings, get_settings


class SupabaseServiceClient:
    """Service-role authenticated Supabase client (bypasses RLS)."""

    _instance: Optional["SupabaseServiceClient"] = None
    _client: Optional[Client] = None

    def __new__(cls) -> "SupabaseServiceClient":
        """Singleton pattern."""
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __init__(self) -> None:
        """Initialize client (once per singleton)."""
        if self._client is None:
            settings = get_settings()
            self._client = create_client(
                settings.supabase_url,
                settings.supabase_service_role_key,
            )

    @property
    def client(self) -> Client:
        """Get the underlying Supabase client."""
        return self._client

    def fetch_one(
        self,
        table: str,
        filters: Optional[Dict[str, Any]] = None,
    ) -> Optional[Dict[str, Any]]:
        """Fetch a single row.

        Args:
            table: Table name
            filters: Dictionary of column_name -> value

        Returns:
            First matching row or None
        """
        query = self._client.table(table).select("*")
        if filters:
            for key, value in filters.items():
                query = query.eq(key, value)
        response = query.limit(1).execute()
        return response.data[0] if response.data else None

    def fetch_many(
        self,
        table: str,
        filters: Optional[Dict[str, Any]] = None,
        order_by: Optional[str] = None,
        descending: bool = False,
        limit: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        """Fetch multiple rows.

        Args:
            table: Table name
            filters: Dictionary of column_name -> value
            order_by: Column name to order by
            descending: If True, order descending
            limit: Maximum rows to return

        Returns:
            List of matching rows
        """
        query = self._client.table(table).select("*")
        if filters:
            for key, value in filters.items():
                query = query.eq(key, value)
        if order_by:
            # postgrest-py's .order() takes `desc=`, NOT `descending=`.
            # The wrapper was forwarding the wrong keyword and every
            # fetch_many() call with order_by was raising
            # "BaseSelectRequestBuilder.order() got an unexpected keyword
            # argument 'descending'". This silently broke inventory
            # training, supply training, every per-property model-run
            # lookup. Discovered during Tier 2 triple-check.
            query = query.order(order_by, desc=descending)
        if limit:
            query = query.limit(limit)
        response = query.execute()
        return response.data if response.data else []

    def insert(
        self,
        table: str,
        data: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Insert a single row.

        Args:
            table: Table name
            data: Row data

        Returns:
            Inserted row
        """
        response = self._client.table(table).insert(data).execute()
        return response.data[0] if response.data else {}

    def upsert(
        self,
        table: str,
        data: Dict[str, Any],
        on_conflict: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Upsert a row.

        Args:
            table: Table name
            data: Row data
            on_conflict: Conflict resolution column(s)

        Returns:
            Upserted row
        """
        response = self._client.table(table).upsert(
            data,
            ignore_duplicates=False,
        ).execute()
        return response.data[0] if response.data else {}

    def update(
        self,
        table: str,
        data: Dict[str, Any],
        filters: Dict[str, Any],
    ) -> List[Dict[str, Any]]:
        """Update rows matching filters.

        Args:
            table: Table name
            data: Update data
            filters: Dictionary of column_name -> value

        Returns:
            Updated rows
        """
        query = self._client.table(table).update(data)
        for key, value in filters.items():
            query = query.eq(key, value)
        response = query.execute()
        return response.data if response.data else []

    def execute_sql(self, sql: str) -> List[Dict[str, Any]]:
        """Execute raw SQL through the `public.exec_sql(text)` Postgres
        function (migration 0071) and return the rows as a list of dicts.

        Used by paths that need cross-table JOINs the PostgREST builder
        can't easily express — demand training, demand-inference plan
        lookup, supply training. Service-role only on the EXECUTE grant.

        Previously this called `self._client.postgrest.request("GET",
        "/rpc/exec_sql", ...)` which (a) used a SDK method
        (`postgrest.request`) that newer supabase-py versions removed and
        (b) called a function that didn't exist in the DB. Both bugs were
        silently breaking every demand-training call. Discovered in the
        Tier 2 triple-check.
        """
        response = self._client.rpc("exec_sql", {"sql": sql}).execute()
        return response.data if response.data else []


def get_supabase_client() -> SupabaseServiceClient:
    """Get singleton Supabase client.

    Returns:
        Service-role authenticated client
    """
    return SupabaseServiceClient()
