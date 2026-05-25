-- Plan v8 Phase B production-hardening — Codex + self-review pass.
--
-- Fixes 4 production-readiness gaps surfaced by the post-Phase-B
-- adversarial review.
--
--   P0 — Migration 0213 created a storage RLS policy
--        `mapping_screenshots_anon_deny ON storage.objects FOR ALL TO anon
--         USING (bucket_id != 'mapping-screenshots')`
--        Postgres RLS treats USING=true as ALLOW — so this policy GRANTS
--        anon access to every bucket EXCEPT mapping-screenshots, the
--        opposite of the intent. Drop it. The bucket's private=false
--        flag + default-deny RLS already enforces the protection.
--
--   P1 — accounts(last_seen_at) WHERE role='admin' partial index.
--        cua-service/src/human-assist.ts isAnyAdminOnline() runs this
--        query on every help-request. At 300 hotels mapping concurrently,
--        unindexed scans become a bottleneck.
--
--   P1 — Sweep cron for mapping_help_requests with expires_at < now().
--        Migration 0212 added expires_at + an index but nothing reads it.
--        Storage objects + DB rows accumulate forever otherwise. We add
--        a SECURITY DEFINER helper the /api/cron sweep can call —
--        cleanup of storage objects happens app-side via the cron route
--        (since SQL can't easily delete storage objects).
--
--   P2 — admin DELETE policy on mapping_help_requests so admin UI can
--        clean up bad rows manually.

BEGIN;

-- ─── P0: drop the broken anon-deny policy on storage.objects ─────────────

DROP POLICY IF EXISTS mapping_screenshots_anon_deny ON storage.objects;

-- Storage.objects' default behavior with RLS enabled + no permissive
-- policy for anon = deny. The `mapping_screenshots_admin_select` policy
-- only allows admin SELECT; nothing else is granted. Verified safe.

-- ─── PRE-P1: accounts.last_seen_at column was missing! ────────────────────

-- Chunk 2 shipped the heartbeat endpoint /api/admin/heartbeat that
-- UPDATEs accounts.last_seen_at + isAnyAdminOnline() reads it back, but
-- the column was never added. PostgREST update would have silently
-- 400'd. Add the column NOW, before adding the partial index that
-- depends on it.
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;

COMMENT ON COLUMN accounts.last_seen_at IS
  'Plan v8 — last time a frontend admin tab pinged /api/admin/heartbeat. '
  'Read by cua-service human-assist.ts isAnyAdminOnline() to gate '
  'whether the mapper asks for help (admin online) or falls through to '
  'mark-unavailable (no admin online). NULL = never pinged.';

-- ─── P1: accounts(last_seen_at) WHERE role='admin' partial index ─────────

-- isAnyAdminOnline() filters: role='admin' AND last_seen_at >= cutoff.
-- The partial index covers exactly that. Tiny — at most one row per
-- admin user; for Reeyen it's literally 1 row.
CREATE INDEX IF NOT EXISTS accounts_admin_last_seen_idx
  ON accounts (last_seen_at DESC)
  WHERE role = 'admin';

-- ─── P1: SECURITY DEFINER helper for the sweep cron ──────────────────────

-- Returns the storage paths of all pending help-requests past expires_at
-- AND marks them 'expired' in one go. Cron route then deletes the objects
-- and rows. SECURITY DEFINER so the cron's service_role can call it
-- regardless of RLS posture changes.
CREATE OR REPLACE FUNCTION expire_stale_help_requests()
RETURNS TABLE(id uuid, screenshot_storage_path text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE mapping_help_requests
     SET status = 'expired',
         answered_at = COALESCE(answered_at, now())
   WHERE status = 'pending'
     AND expires_at < now()
  RETURNING mapping_help_requests.id,
            mapping_help_requests.screenshot_storage_path;
END;
$$;

REVOKE ALL ON FUNCTION expire_stale_help_requests() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION expire_stale_help_requests() TO service_role;

COMMENT ON FUNCTION expire_stale_help_requests IS
  'Plan v8 sweep helper — called by /api/cron/expire-help-requests every '
  'few minutes. Atomically flips pending → expired for rows past their TTL '
  'and returns the storage paths so the cron can delete the orphaned '
  'screenshot objects in mapping-screenshots bucket.';

-- ─── P2: admin DELETE policy on mapping_help_requests ────────────────────

-- For ops cleanup of misconfigured rows. Uses the same is_admin_user
-- SECURITY DEFINER helper added in 0213.
CREATE POLICY mhr_admin_delete ON mapping_help_requests
  FOR DELETE TO authenticated
  USING (is_admin_user(auth.uid()));

COMMIT;
