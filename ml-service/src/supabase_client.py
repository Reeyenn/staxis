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
            on_conflict: Comma-separated column list matching the table's
                         unique constraint. Required when the target
                         constraint is not the primary key — otherwise
                         PostgREST falls back to PK and may insert
                         duplicates instead of updating.

        Returns:
            Upserted row
        """
        kwargs: Dict[str, Any] = {"ignore_duplicates": False}
        if on_conflict is not None:
            kwargs["on_conflict"] = on_conflict
        response = self._client.table(table).upsert(data, **kwargs).execute()
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

        SECURITY (2026-05-16 Pattern B): callers MUST interpolate
        user-derived values through `safe_uuid()` / `safe_iso_date()`
        (defined below) so the validation runs at the use site, not just
        upstream in Pydantic. The `exec_sql` RPC is service-role-only
        per migration 0071, so SQL injection is bounded by auth — but
        the f-string pattern is fragile and gets safer when every
        interpolation visibly asserts the value's shape.
        """
        response = self._client.rpc("exec_sql", {"sql": sql}).execute()
        return response.data if response.data else []


# ── SQL-value validators (Pattern B — security review 2026-05-16) ──────────
# Wrap every user-derived value at the f-string interpolation site BEFORE
# it lands in raw SQL. The upstream Pydantic validators ALREADY enforce
# these types, but the f-string pattern is fragile: a future route that
# forgets the Pydantic check would silently introduce an injection.
# Wrapping at the use site moves the check next to the danger — the call
# site documents itself as "this value MUST be a UUID/date or this throws."
#
# Cheap (microseconds) so safe to call on every query, including hot paths.

import uuid as _uuid
import re as _re

_ISO_DATE_RX = _re.compile(r"^\d{4}-\d{2}-\d{2}$")


def safe_uuid(value: str) -> str:
    """Return `value` if it's a valid UUID string, else raise ValueError.

    Use BEFORE interpolating into f-string SQL:
        query = f"... where property_id = '{safe_uuid(property_id)}'"

    Raises ValueError with a clear message so callers can surface the
    validation failure as a structured 400, not a 500.
    """
    try:
        # uuid.UUID accepts hyphenated + non-hyphenated forms; we re-stringify
        # the canonical hyphenated form so downstream comparisons are stable.
        return str(_uuid.UUID(str(value)))
    except (ValueError, AttributeError, TypeError) as exc:
        raise ValueError(f"safe_uuid: not a valid UUID: {value!r}") from exc


def safe_iso_date(value: str) -> str:
    """Return `value` if it's a YYYY-MM-DD date string, else raise ValueError.

    Stricter than `date.fromisoformat` — refuses time components and
    timezone suffixes so the interpolated string can't carry SQL
    fragments past the closing quote.
    """
    s = str(value)
    if not _ISO_DATE_RX.match(s):
        raise ValueError(f"safe_iso_date: not a YYYY-MM-DD date: {value!r}")
    return s


def get_supabase_client() -> SupabaseServiceClient:
    """Get singleton Supabase client.

    Returns:
        Service-role authenticated client
    """
    return SupabaseServiceClient()
