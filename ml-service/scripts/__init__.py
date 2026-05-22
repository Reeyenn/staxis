"""Read-only operational scripts for ml-service.

Scripts in this directory MUST NOT write to production tables. They may
read freely and may write a single artifact to Supabase Storage if
explicitly whitelisted. See backtest_housekeeping.py:ReadOnlySupabaseClient
for the proxy that enforces this contract.
"""
