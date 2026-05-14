-- Phase M1.5 (2026-05-14): unified onboarding wizard state.
--
-- Why this exists:
--   The new /onboard?code=XXXX wizard is multi-step (9 steps). If the
--   owner closes the tab between Step 4 (hotel details) and Step 6
--   (PMS connection), they need to resume where they left off — not
--   start over and risk duplicating writes (which RLS would catch but
--   would still confuse the UX).
--
--   Solution: persist incremental progress to a jsonb column on the
--   property. Each step's "Next" handler PATCHes the column with its
--   slice of state. On wizard mount, we GET the current state and
--   forward the user to the right step.
--
-- onboarding_state schema (typed in TS at src/lib/onboarding/state.ts
-- in commit 4):
--   {
--     step: 1..9,
--     accountCreatedAt?: ISO,
--     emailVerifiedAt?: ISO,
--     hotelDetailsAt?: ISO,
--     servicesAt?: ISO,
--     pmsCredentialsAt?: ISO,
--     pmsJobId?: uuid,
--     mappingCompletedAt?: ISO,
--     staffAt?: ISO
--   }
--
-- onboarding_completed_at is set when the owner clicks "Go to dashboard"
-- on Step 9. Used by:
--   - admin OnboardingTab to filter "still onboarding" vs "fully onboarded"
--   - the wizard itself to redirect users who try to revisit /onboard
--     after they've already finished (sends them to /dashboard instead)

ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS onboarding_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS onboarding_completed_at timestamptz;

-- Helpful index for the OnboardingTab's "in-flight onboardings" query
-- which filters WHERE onboarding_completed_at IS NULL. Partial index
-- because the vast majority of rows (post-launch) WILL have this set.
CREATE INDEX IF NOT EXISTS properties_onboarding_in_flight_idx
  ON public.properties (created_at DESC)
  WHERE onboarding_completed_at IS NULL;

INSERT INTO public.applied_migrations (version, description)
VALUES ('0120', 'Phase M1.5: properties.onboarding_state + onboarding_completed_at for unified wizard')
ON CONFLICT (version) DO NOTHING;
