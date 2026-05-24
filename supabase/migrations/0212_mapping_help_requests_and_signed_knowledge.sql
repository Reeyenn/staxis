-- Plan v8 Phase B chunk 1 — human-assisted mapper support.
--
-- Two changes in one migration:
--
-- 1. mapping_help_requests table — when the vision/DOM mapper agent gets
--    stuck on a target during a `mapper.learn_pms_family` run, it pauses
--    and posts a row here. An admin watching the Live Mapping console
--    answers via /api/admin/mapper/assist. Mapper subscribes to row UPDATE
--    via Supabase realtime, resumes when status flips to 'answered'.
--
--    Single in-flight request per job is enforced by a partial unique
--    index (mapper processes targets sequentially — invariant per plan
--    v8 F5/P2-5). expires_at gives a sweep target so abandoned rows
--    don't dangle indefinitely.
--
-- 2. Signature columns on pms_knowledge_files. Mapper output is currently
--    saved unsigned. Plan v8 P1-7: with Phase B's takeover-mode landing,
--    a compromised admin (or social-engineered owner) could inject
--    recipe steps via takeover. Signing the recipe at save time + verifying
--    at replay closes the injection vector. The signing infra already
--    exists (cua-service/src/recipe-signing.ts); this migration adds the
--    storage columns.

BEGIN;

-- ─── 1. mapping_help_requests ────────────────────────────────────────────

CREATE TABLE mapping_help_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          uuid NOT NULL REFERENCES workflow_jobs(id) ON DELETE CASCADE,
  target_key      text NOT NULL,
  -- Agent's structured question (what it tried, where it thinks the
  -- target might be). Rendered in the admin Live Mapping help card.
  question        text NOT NULL,
  what_ive_tried  jsonb,    -- array of strings: ["clicked Reports", ...]
  suggested_paths jsonb,    -- array of strings: ["could be under Audit", ...]
  -- Supabase Storage object key for the screenshot taken at the moment
  -- help was requested. NOT a base64 blob in the jsonb — keeps payload
  -- size sane + admin UI fetches via signed URL.
  screenshot_storage_path text NOT NULL,
  -- Viewport metadata at request time. Admin UI uses these to render the
  -- screenshot at native pixel-perfect size (P0-4 takeover requirement).
  scroll_x        integer NOT NULL DEFAULT 0,
  scroll_y        integer NOT NULL DEFAULT 0,
  viewport_w      integer NOT NULL DEFAULT 1280,
  viewport_h      integer NOT NULL DEFAULT 800,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- Plan v8 P1-6: expires_at gives a sweep target. Abandoned pending
  -- rows get flipped to 'expired' so the help-flood circuit-breaker
  -- (P2-4) counts them correctly.
  expires_at      timestamptz NOT NULL DEFAULT (now() + interval '15 minutes'),
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'answered', 'aborted', 'expired')),
  -- Set when admin answers via /api/admin/mapper/assist:
  --   'guidance'    → mapper continues with hint injected
  --   'unavailable' → mapper marks target unavailable, moves on
  --   'takeover'    → admin drives the browser manually
  --   'abort'       → mapper aborts the whole job
  action_type     text CHECK (action_type IN ('guidance', 'unavailable', 'takeover', 'abort')),
  response_text   text,
  -- When admin clicked on the screenshot to point at an element:
  -- {x, y, dpr, hashOfRegion} per P0-4 (stale-region detection).
  response_coordinate jsonb,
  answered_at     timestamptz,
  admin_user_id   uuid REFERENCES accounts(id) ON DELETE SET NULL
);

-- Plan v8 P2-5: sequential-help-request invariant enforced at DB level.
-- Only one in-flight (pending) help request per job. If a future change
-- adds parallel targets, the constraint fires and the engineer rethinks.
CREATE UNIQUE INDEX mapping_help_requests_one_pending_per_job
  ON mapping_help_requests(job_id)
  WHERE status = 'pending';

-- Lookup index for the admin Live Mapping UI: most recent help requests
-- per job.
CREATE INDEX mapping_help_requests_job_idx
  ON mapping_help_requests(job_id, created_at DESC);

-- Sweep index for the expires_at cron: find pending rows past their TTL.
CREATE INDEX mapping_help_requests_expires_idx
  ON mapping_help_requests(expires_at)
  WHERE status = 'pending';

-- Plan v8 P2-1: RLS — admin only.
-- Anon role cannot SELECT. Non-admin authenticated cannot SELECT.
-- Admin role can SELECT + UPDATE. service_role (cua-service worker)
-- is exempt from RLS so the worker can INSERT pending rows and the
-- expires_at sweep cron can UPDATE.
ALTER TABLE mapping_help_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY mhr_admin_select ON mapping_help_requests
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM accounts WHERE id = auth.uid() AND role = 'admin')
  );

CREATE POLICY mhr_admin_update ON mapping_help_requests
  FOR UPDATE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM accounts WHERE id = auth.uid() AND role = 'admin')
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM accounts WHERE id = auth.uid() AND role = 'admin')
  );

CREATE POLICY mhr_anon_deny_all ON mapping_help_requests
  FOR ALL TO anon
  USING (false)
  WITH CHECK (false);

-- Comment for the OpenAPI / Postgres docs introspection.
COMMENT ON TABLE mapping_help_requests IS
  'Plan v8 Phase B — live admin-assisted mapper help channel. Inserted by '
  'cua-service when a mapper agent declares unavailable after the floor; '
  'updated by /api/admin/mapper/assist. Subscribed via Supabase realtime '
  'by mapper.ts (resume on status=answered) and by the Live Mapping UI '
  '(render new pending rows).';

-- ─── 2. Signature columns on pms_knowledge_files ────────────────────────

-- Recipe-signing infra lives at cua-service/src/recipe-signing.ts. It signs
-- the canonical-JSON of the recipe with HMAC-SHA256 + a key id. Verifier
-- accepts the active key OR (during a rotation grace window) the previous
-- key. Until now we had signature columns on pms_recipes (legacy table)
-- but NOT on pms_knowledge_files (the active table). saveDraftKnowledgeFile
-- in mapping-driver.ts will populate these on insert (Phase B chunk 1).

ALTER TABLE pms_knowledge_files
  ADD COLUMN signature        bytea,
  ADD COLUMN signed_with_key_id text,
  ADD COLUMN signed_at        timestamptz;

COMMENT ON COLUMN pms_knowledge_files.signature IS
  'HMAC-SHA256 over canonical JSON of the `knowledge` column. Verified by '
  'session-driver knowledge loader before each polling cycle. NULL when '
  'the row was written before signing landed (treat as unsigned per '
  'RECIPE_SIGNING_ENFORCE env: warn or refuse).';

COMMENT ON COLUMN pms_knowledge_files.signed_with_key_id IS
  '8-hex-char fingerprint of the signing key (see recipe-signing.ts:34). '
  'Used to distinguish active vs previous key during a key rotation grace '
  'window.';

COMMIT;
