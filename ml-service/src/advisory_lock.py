"""Postgres advisory lock helpers for per-property concurrency control."""
import hashlib
import zlib
from contextlib import contextmanager
from typing import Generator

import psycopg2
from psycopg2 import sql


def hash_property_layer(property_id: str, layer: str) -> int:
    """Hash property_id + layer into a *deterministic* advisory lock ID.

    Critical: Python's built-in hash() is randomized per process
    (PYTHONHASHSEED), which means two ML service workers computing the lock
    id for the same (property, layer) pair would get DIFFERENT integers —
    so they'd lock on different rows and never actually serialize. We use
    a stable hash (CRC32 of an MD5 digest) so every process agrees.

    Args:
        property_id: Property UUID
        layer: Layer name (demand, supply, optimizer)

    Returns:
        Deterministic 31-bit positive lock ID
    """
    combined = f"{property_id}:{layer}".encode("utf-8")
    # MD5 → 128-bit digest → CRC32 → 32-bit unsigned → mask to 31 bits positive.
    digest = hashlib.md5(combined).digest()
    return zlib.crc32(digest) & 0x7FFFFFFF


@contextmanager
def advisory_lock(
    conn: psycopg2.extensions.connection,
    property_id: str,
    layer: str,
    blocking: bool = True,
) -> Generator[bool, None, None]:
    """Context manager for property-level advisory lock.

    Args:
        conn: Postgres connection
        property_id: Property UUID
        layer: Layer name
        blocking: If True, wait for lock; if False, fail immediately

    Yields:
        True if lock acquired, False if not (when blocking=False)

    Raises:
        psycopg2.DatabaseError: If lock operation fails
    """
    lock_id = hash_property_layer(property_id, layer)

    with conn.cursor() as cur:
        if blocking:
            # pg_advisory_lock blocks until acquired
            cur.execute("SELECT pg_advisory_lock(%s)", (lock_id,))
            yield True
            # Release on exit
            cur.execute("SELECT pg_advisory_unlock(%s)", (lock_id,))
        else:
            # pg_try_advisory_lock returns immediately
            cur.execute("SELECT pg_try_advisory_lock(%s)", (lock_id,))
            acquired = cur.fetchone()[0]
            yield acquired
            # Release if we acquired it
            if acquired:
                cur.execute("SELECT pg_advisory_unlock(%s)", (lock_id,))

    conn.commit()
