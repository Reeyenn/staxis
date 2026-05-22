#!/usr/bin/env python3
"""
Dump the FastAPI OpenAPI schema to stdout (or a file).

Phase E2E (2026-05-22).

Used as the source of truth for the cross-service contract test at
src/lib/__tests__/ml-contract.test.ts. Run when the ML service's
request/response shape changes; commit the regenerated openapi.json
so the TypeScript wrapper validators are forced to match.

Usage:
    cd ml-service
    python scripts/dump_openapi.py > openapi.json

Or via JSON for diff'ing:
    python scripts/dump_openapi.py --pretty | diff - openapi.json
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# Add the ml-service root to sys.path so `from src.main import app` works
# regardless of where this script is invoked from.
HERE = Path(__file__).resolve().parent
ML_SERVICE_ROOT = HERE.parent
sys.path.insert(0, str(ML_SERVICE_ROOT))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--pretty",
        action="store_true",
        help="Indent JSON output (default: stable single-line per top-level key).",
    )
    args = parser.parse_args()

    try:
        from src.main import app  # type: ignore[import-not-found]
    except Exception as e:  # noqa: BLE001
        print(f"ERROR importing FastAPI app: {e}", file=sys.stderr)
        print(
            "Hint: cd into ml-service/ and ensure dependencies are installed "
            "(pip install -r requirements.txt).",
            file=sys.stderr,
        )
        return 1

    schema = app.openapi()
    # Sort keys deterministically so the snapshot diff is stable across
    # Python interpreter runs. FastAPI's dict ordering already comes from
    # the route definition order, but Pydantic v2 may shuffle properties;
    # sort to lock the output.
    if args.pretty:
        out = json.dumps(schema, indent=2, sort_keys=True)
    else:
        out = json.dumps(schema, sort_keys=True)
    print(out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
