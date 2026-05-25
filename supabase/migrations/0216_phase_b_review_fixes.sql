-- Plan v8 Phase B review — Codex adversarial pass folded.
--
-- Four P1 findings, all addressed here:
--
--   #2  mapping_help_requests RLS subquery against accounts fails because
--       accounts has self-only RLS — admin querying ANOTHER admin's row
--       gets nothing back, EXISTS returns false, policy denies. Replace
--       with a SECURITY DEFINER helper function that bypasses accounts'
--       self-only filter for the role check.
--
--   #3  mapping_help_requests not in supabase_realtime publication and
--       missing REPLICA IDENTITY FULL. UPDATE events would never propagate
--       via realtime → cua-service worker waits the full 90s timeout on
--       every help request and silently falls through to mark-unavailable.
--
--   #10 mapping-screenshots Supabase Storage bucket doesn't exist. Help-
--       request screenshot upload fails → help request itself fails →
--       admin sees nothing. Create the bucket + admin-only RLS policy.
--
-- P1 #5 (signRecipe enforce-mode re-throw) is a code-only fix; see
-- cua-service/src/mapping-driver.ts saveDraftKnowledgeFile.

BEGIN;

-- ─── Fix 1: SECURITY DEFINER helper for the admin role check ─────────────

-- The function bypasses RLS because it's SECURITY DEFINER. The owner is
-- postgres (the role that ran the migration), which has RLS bypass.
-- Callers see a simple boolean — no info leak.
CREATE OR REPLACE FUNCTION is_admin_user(uid uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM accounts WHERE id = uid AND role = 'admin'
  );
$$;

-- Lock down execute — only authenticated users (admin policies will call
-- it). service_role bypasses RLS anyway.
REVOKE ALL ON FUNCTION is_admin_user(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION is_admin_user(uuid) TO authenticated;

COMMENT ON FUNCTION is_admin_user IS
  'Plan v8 Phase B fix — SECURITY DEFINER helper that checks if a user '
  'is admin without triggering the self-only RLS on accounts. Used by '
  'mapping_help_requests RLS policies (and anywhere else that needs a '
  'cross-row admin check from a regular authenticated session).';

-- Rebuild the mapping_help_requests policies to use the helper.
DROP POLICY IF EXISTS mhr_admin_select ON mapping_help_requests;
DROP POLICY IF EXISTS mhr_admin_update ON mapping_help_requests;

-- Post-2B MFA gate AND-ed in alongside the admin check. See migration 0161.
CREATE POLICY mhr_admin_select ON mapping_help_requests
  FOR SELECT TO authenticated
  USING (is_admin_user(auth.uid()) AND public.mfa_verified_or_grace());

CREATE POLICY mhr_admin_update ON mapping_help_requests
  FOR UPDATE TO authenticated
  USING (is_admin_user(auth.uid()) AND public.mfa_verified_or_grace())
  WITH CHECK (is_admin_user(auth.uid()) AND public.mfa_verified_or_grace());

-- ─── Fix 2: realtime publication + REPLICA IDENTITY FULL ─────────────────

-- Without these the postgres_changes UPDATE events for mapping_help_requests
-- never propagate to Supabase realtime subscribers (cua-service worker +
-- admin UI). The pattern is established elsewhere in the schema — see
-- migration 0006 for the same idiom on other realtime-needed tables.

ALTER TABLE mapping_help_requests REPLICA IDENTITY FULL;

-- Add to the realtime publication. The publication is created by Supabase
-- at project init; this just adds our table to it.
DO $$
BEGIN
  -- Skip silently if the publication doesn't exist (some non-Supabase
  -- environments).
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE mapping_help_requests;
  END IF;
EXCEPTION
  -- Already in publication — fine.
  WHEN duplicate_object THEN NULL;
END $$;

-- ─── Fix 3: mapping-screenshots Storage bucket ───────────────────────────

-- The bucket holds short-lived screenshots taken at the moment the mapper
-- asks for help. Admin UI fetches via signed URL (1h expiry — set client-
-- side). Auto-purge sweep happens via /api/cron/expire-help-requests
-- (migration 0217 / route in src/app/api/cron/expire-help-requests/).
-- @storage: service-role-only — uploads come from cua-service (Fly) via
-- service-role; admin reads via signed URLs minted server-side in
-- /api/admin/mapper/live. No per-property scoping because these objects
-- are tied to a workflow_job, not to a property in a way users could own.
INSERT INTO storage.buckets (id, name, public)
VALUES ('mapping-screenshots', 'mapping-screenshots', false)
ON CONFLICT (id) DO NOTHING;

-- Storage RLS — admin only for SELECT (signed URLs work fine even with
-- restrictive RLS because the signed URL bypasses RLS).
-- service_role uploads via cua-service — bypasses RLS by default.
-- Storage policies live in storage.objects:
DROP POLICY IF EXISTS mapping_screenshots_admin_select ON storage.objects;
DROP POLICY IF EXISTS mapping_screenshots_anon_deny ON storage.objects;

CREATE POLICY mapping_screenshots_admin_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'mapping-screenshots'
    AND is_admin_user(auth.uid())
    AND public.mfa_verified_or_grace()
  );

CREATE POLICY mapping_screenshots_anon_deny ON storage.objects
  FOR ALL TO anon
  USING (bucket_id != 'mapping-screenshots')
  WITH CHECK (bucket_id != 'mapping-screenshots');

insert into public.applied_migrations (version, description)
values (
  '0216',
  'Phase B review fixes: mapping_help_requests RLS subquery rewrite, mapping-screenshots storage bucket + deny-all policies, is_admin_user() helper. Renumbered from 0213 post-merge after collision with 0213_callout_events.'
)
on conflict (version) do nothing;

COMMIT;
