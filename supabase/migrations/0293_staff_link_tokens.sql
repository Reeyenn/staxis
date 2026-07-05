-- 0293 — staff_link_tokens: per-staff bearer token for the public mobile surface.
--
-- SECURITY AUDIT 2026-06-26, Remaining #1 (HIGH — public staffId enumeration).
--
-- THE HOLE
-- --------
-- Every publicly-linkable mobile route (all of /api/housekeeper/*,
-- /api/laundry/*, /api/engineer/*, /api/save-fcm-token) trusted the
-- (pid, staffId) tuple from the SMS-link URL as its ONLY credential:
-- the capability check was simply "does a staff row with id=staffId and
-- property_id=pid exist and is it active?". And `GET /api/staff-list?pid=`
-- handed out live staff UUIDs to any unauthenticated caller. So anyone
-- who learned a pid (it leaks via SMS forwarding, browser history,
-- Referer headers, carrier logs) could enumerate every scheduled staff
-- member and then act as any one of them — mark rooms clean, call out
-- sick, post messages, log compliance readings.
--
-- THE FIX
-- -------
-- Bind the public routes to a per-staff BEARER TOKEN, minted at SMS-send
-- time, embedded in the link as `&tok=`, and verified server-side on
-- every public API call. The token — not the (pid, staffId) tuple — is
-- now the credential. staffId stays in the URL for back-compat parsing
-- but is no longer sufficient on its own. And /api/staff-list stops
-- returning staff.id to unauthenticated callers entirely.
--
-- TOKEN SHAPE
-- -----------
-- Random 256-bit token (crypto.randomBytes(32), hex). Only its
-- sha256 hash is stored here — same idiom as trusted_devices.token_hash
-- (see src/lib/trusted-device.ts hashDeviceToken). A leaked DB row can't
-- be turned back into a usable token; a leaked token alone can't act
-- without a matching non-expired, non-revoked row.
--
-- One ACTIVE (unexpired, unrevoked) token per staff member: buildXLink
-- reuses the existing active row on re-send instead of minting a new one,
-- so a re-sent SMS carries the same working link and old already-sent
-- links keep working until the token's TTL. Long TTL (90 days) because
-- this is the staff member's standing shift-link credential, not a
-- one-shot exchange like staff_magic_codes (that stays a separate,
-- orthogonal 15-min single-use flow for establishing the Supabase RLS
-- session — this table does NOT replace it).
--
-- Idempotent. Safe to re-run.

BEGIN;

-- @rls: service-role-only — verified + minted exclusively through supabaseAdmin
-- (src/lib/staff-link-auth.ts, src/lib/staff-auth.ts). The mobile pages never
-- touch this table directly; anon/authenticated get no policies (deny-all).
CREATE TABLE IF NOT EXISTS public.staff_link_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- sha256(rawToken) hex. The raw token lives ONLY in the SMS URL and in
  -- the staff member's browser; it is never persisted. UNIQUE so a
  -- verify is a single indexed point-lookup on the hash.
  token_hash text NOT NULL UNIQUE,

  -- Identity binding. The verifier resolves identity FROM this row:
  -- token_hash → (staff_id, property_id). The URL's staffId/pid must
  -- match these, so a token minted for staff A at property X can't be
  -- replayed against staff B or property Y.
  staff_id    uuid NOT NULL REFERENCES public.staff(id)      ON DELETE CASCADE,
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,

  -- Standing credential TTL. 90 days covers a staff member using the same
  -- shift link across many weeks; re-sends within the window reuse the row.
  expires_at timestamptz NOT NULL,

  -- Soft-revoke. Set when a manager wants to cut a leaked link (future
  -- admin action) or when the staff member is deactivated. A revoked
  -- row fails verification even if not yet expired.
  revoked_at timestamptz,

  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz
);

-- Point-lookup on the hash is the hot path (every public API call).
-- The UNIQUE constraint already indexes token_hash; this partial index
-- speeds "find the active token for this staff to reuse on re-send".
CREATE INDEX IF NOT EXISTS staff_link_tokens_active_idx
  ON public.staff_link_tokens (staff_id, property_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS staff_link_tokens_expires_idx
  ON public.staff_link_tokens (expires_at);

-- RLS: service-role only. The verifier + minter use supabaseAdmin; the
-- mobile pages never touch this table directly. Anon and authenticated
-- roles get NO policies → default-deny (mirrors staff_magic_codes 0155
-- and every other server-only table).
ALTER TABLE public.staff_link_tokens ENABLE ROW LEVEL SECURITY;

-- Idempotent re-runs: drop any pre-existing policies before (re)declaring
-- the deny-all default. We declare none on purpose.
DO $$
DECLARE pol record;
BEGIN
  FOR pol IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'staff_link_tokens'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.staff_link_tokens', pol.policyname);
  END LOOP;
END $$;

COMMENT ON TABLE public.staff_link_tokens IS
  'Security audit 2026-06-26 #1: per-staff bearer token for the public mobile surface (housekeeper/laundry/engineer). SMS link carries &tok=<raw>; only sha256(raw) is stored here. Public API routes resolve identity FROM the token and reject a raw (pid,staffId) tuple without a valid token. Service-role only. Orthogonal to staff_magic_codes (that establishes the Supabase RLS session).';

-- ─── applied_migrations bookkeeping ──────────────────────────────────────
INSERT INTO public.applied_migrations (version, description)
VALUES (
  '0293',
  'staff_link_tokens: per-staff hashed bearer token minted at SMS-send time, embedded in the mobile link as &tok=, verified server-side on every public housekeeper/laundry/engineer/save-fcm-token call. Closes the public staffId-enumeration hole — the (pid,staffId) tuple is no longer a sufficient credential and /api/staff-list stops emitting staff.id.'
)
ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
